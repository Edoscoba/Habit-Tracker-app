// Daily Habit — static app + optional accounts & cross-device sync.
// Storage auto-selects: Postgres when DATABASE_URL (or PG* vars) is set,
// otherwise SQLite in DATA_DIR. Postgres needs the `pg` package; SQLite
// uses Node's built-in node:sqlite (Node >= 22) and needs no packages.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATABASE_URL = (process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_URL || '').trim();
const HAS_PG_VARS = !!(DATABASE_URL || process.env.PGHOST || process.env.PGHOST_UNIX);

/* ---- diagnostics helpers (never include credentials) ---- */
function sanitizeUrl(url){
  try { const u = new URL(url); return u.protocol + '//' + (u.username ? '***@' : '') + u.host + u.pathname; }
  catch (e) { return '(unparseable url)'; }
}
function errDetail(e){
  const parts = [];
  if (e && e.code) parts.push(e.code);
  if (e && e.message) parts.push(e.message);
  if (e && Array.isArray(e.errors) && e.errors.length) parts.push('[' + e.errors.map(x => (x && (x.code || x.message)) || String(x)).join(', ') + ']');
  const s = parts.join(' ').trim();
  return s || String(e);
}
/* The container's default gateway is the host on this docker network —
 * the right target when a connection string says "localhost" (meaning
 * the host machine, not this container). */
function dockerGatewayIp(){
  try {
    const lines = fs.readFileSync('/proc/net/route', 'utf8').split('\n');
    for (const line of lines.slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length > 2 && f[1] === '00000000' && f[2] && f[2] !== '00000000') {
        return [6, 4, 2, 0].map(i => parseInt(f[2].slice(i, i + 2), 16)).join('.');
      }
    }
  } catch (e) {}
  return null;
}
const SESSION_DAYS = 120;
const MAX_HABITS = 50;
const MAX_BODY = 256 * 1024;

/* =========================================================================
 * Storage layer — two backends behind one async interface.
 * Methods: init, getUserByEmail, createUser, createSession, getSession,
 * renewSession, deleteSession, getData, countHabits, habitExists,
 * upsertHabit, deleteHabit, setDay, setNote, importData.
 * A createUser email collision throws an error with .taken === true.
 * ========================================================================= */

class SqliteStore {
  constructor(dir){ this.dir = dir; this.kind = 'sqlite'; }
  async init(){
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(this.dir, { recursive: true });
    this.db = new DatabaseSync(path.join(this.dir, 'habits.db'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        pass_salt TEXT NOT NULL, pass_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS habits(
        user_id INTEGER NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
        emoji TEXT NOT NULL DEFAULT '💪', color INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, ord INTEGER, PRIMARY KEY(user_id, id));
      CREATE TABLE IF NOT EXISTS days(
        user_id INTEGER NOT NULL, habit_id TEXT NOT NULL, date TEXT NOT NULL, val TEXT NOT NULL,
        PRIMARY KEY(user_id, habit_id, date));
      CREATE TABLE IF NOT EXISTS notes(
        user_id INTEGER NOT NULL, date TEXT NOT NULL, text TEXT NOT NULL,
        PRIMARY KEY(user_id, date));
    `);
  }
  async getUserByEmail(email){
    return this.db.prepare('SELECT id,pass_salt,pass_hash FROM users WHERE email=?').get(email) || null;
  }
  async createUser(email, salt, hash, createdAt){
    try {
      const r = this.db.prepare('INSERT INTO users(email,pass_salt,pass_hash,created_at) VALUES(?,?,?,?)').run(email, salt, hash, createdAt);
      return Number(r.lastInsertRowid);
    } catch (e) {
      if (String(e.message || '').toUpperCase().includes('UNIQUE')) throw Object.assign(new Error('email_taken'), { taken: true });
      throw e;
    }
  }
  async createSession(tokenHash, userId, createdAt, expiresAt){
    this.db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(tokenHash, userId, createdAt, expiresAt);
  }
  async getSession(tokenHash){
    return this.db.prepare('SELECT s.token_hash AS token_hash, s.expires_at AS expires_at, u.id AS uid, u.email AS email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(tokenHash) || null;
  }
  async renewSession(tokenHash, newExpires){ this.db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(newExpires, tokenHash); }
  async deleteSession(tokenHash){ this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash); }
  async countHabits(userId){ return this.db.prepare('SELECT COUNT(*) AS n FROM habits WHERE user_id=?').get(userId).n; }
  async habitExists(userId, id){ return !!this.db.prepare('SELECT 1 AS x FROM habits WHERE user_id=? AND id=?').get(userId, id); }
  async upsertHabit(userId, c){
    this.db.prepare(`INSERT INTO habits(user_id,id,name,type,emoji,color,created_at,ord) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name,type=excluded.type,emoji=excluded.emoji,color=excluded.color,created_at=excluded.created_at,ord=excluded.ord`)
      .run(userId, c.id, c.name, c.type, c.emoji, c.color, c.createdAt, c.ord);
  }
  async deleteHabit(userId, id){
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM habits WHERE user_id=? AND id=?').run(userId, id);
      this.db.prepare('DELETE FROM days WHERE user_id=? AND habit_id=?').run(userId, id);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async setDay(userId, habitId, date, val){
    if (val === '') this.db.prepare('DELETE FROM days WHERE user_id=? AND habit_id=? AND date=?').run(userId, habitId, date);
    else this.db.prepare('INSERT INTO days(user_id,habit_id,date,val) VALUES(?,?,?,?) ON CONFLICT(user_id,habit_id,date) DO UPDATE SET val=excluded.val').run(userId, habitId, date, val);
  }
  async setNote(userId, date, text){
    if (text === '') this.db.prepare('DELETE FROM notes WHERE user_id=? AND date=?').run(userId, date);
    else this.db.prepare('INSERT INTO notes(user_id,date,text) VALUES(?,?,?) ON CONFLICT(user_id,date) DO UPDATE SET text=excluded.text').run(userId, date, text);
  }
  async getData(userId){
    const habits = {}, logs = {}, notes = {};
    for (const r of this.db.prepare('SELECT id,name,type,emoji,color,created_at,ord FROM habits WHERE user_id=?').all(userId)) {
      habits[r.id] = { name: r.name, type: r.type, emoji: r.emoji, color: r.color, createdAt: r.created_at };
      if (r.ord !== null && r.ord !== undefined) habits[r.id].order = r.ord;
      logs[r.id] = { days: {} };
    }
    for (const r of this.db.prepare('SELECT habit_id,date,val FROM days WHERE user_id=?').all(userId)) {
      (logs[r.habit_id] || (logs[r.habit_id] = { days: {} })).days[r.date] = r.val;
    }
    for (const r of this.db.prepare('SELECT date,text FROM notes WHERE user_id=?').all(userId)) notes[r.date] = r.text;
    return { habits, logs, notes };
  }
  async importData(userId, payload){
    const { habits, logs, notes } = payload;
    let nH = 0, nD = 0, nN = 0;
    this.db.exec('BEGIN');
    try {
      const existing = await this.countHabits(userId);
      for (const [id, h] of Object.entries(habits)) {
        if (existing + nH >= MAX_HABITS) break;
        const c = cleanHabit(id, h); if (!c) continue;
        await this.upsertHabit(userId, c); nH++;
        const days = (logs[id] && typeof logs[id] === 'object' && logs[id].days) || {};
        for (const [date, val] of Object.entries(days)) {
          if (nD >= 40000) break;
          if (!RE_DATE.test(date) || VALS.indexOf(val) === -1 || val === '') continue;
          await this.setDay(userId, c.id, date, val); nD++;
        }
      }
      for (const [date, text] of Object.entries(notes)) {
        if (nN >= 10000) break;
        if (!RE_DATE.test(date) || typeof text !== 'string') continue;
        const t = text.trim().slice(0, 500); if (!t) continue;
        await this.setNote(userId, date, t); nN++;
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { habits: nH, days: nD, notes: nN };
  }
}

class PgStore {
  constructor(url){ this.url = url; this.kind = 'postgres'; }

  /* Build connection candidates. Managed single-host platforms often hand
   * out a "localhost" connection string that is only valid on the host —
   * from inside the app container the host is the docker gateway. Try the
   * string as given, then gateway/host aliases, each without and with TLS. */
  buildCandidates(){
    const url = this.url;
    const sslEnv = String(process.env.PGSSL || '').toLowerCase();
    const forceSsl = /sslmode=(require|verify|prefer)/i.test(url) || ['1', 'true', 'require', 'yes', 'on'].includes(sslEnv);
    const noSsl = ['0', 'false', 'no', 'off', 'disable'].includes(sslEnv) || /sslmode=disable/i.test(url);
    const sslOrder = noSsl ? [false] : (forceSsl ? [true, false] : [false, true]);
    const mk = (theUrl, ssl) => ({
      config: ssl ? { connectionString: theUrl, ssl: { rejectUnauthorized: false } } : { connectionString: theUrl },
      label: sanitizeUrl(theUrl) + (ssl ? ' +tls' : ' no-tls')
    });
    if (!url) return sslOrder.map(ssl => ({ config: ssl ? { ssl: { rejectUnauthorized: false } } : {}, label: 'PG* env vars' + (ssl ? ' +tls' : ' no-tls') }));
    const out = [];
    for (const ssl of sslOrder) out.push(mk(url, ssl));
    let u = null; try { u = new URL(url); } catch (e) {}
    const host = u ? u.hostname : '';
    // Managed DBs on single-host platforms (GuildServer) are published on
    // the HOST — often advertised via the platform's public domain or
    // localhost. A container can't reach its own host's public address
    // (NAT hairpin) but CAN reach the host's published port via the
    // container's default gateway. So for any host that isn't already an
    // internal address, also try the gateway / host.docker.internal with
    // the same port, user, password and dbname.
    if (u && String(process.env.PG_NO_HOST_FALLBACK || '') !== '1') {
      const alts = [];
      const gw = dockerGatewayIp(); if (gw) alts.push(gw);
      alts.push('host.docker.internal', '172.17.0.1');
      for (const h of [...new Set(alts)]) {
        if (h === host) continue;
        const v = new URL(url); v.hostname = h;
        for (const ssl of sslOrder) out.push(mk(v.toString(), ssl));
      }
    }
    return out;
  }

  async init(){
    const { Pool } = require('pg');
    let lastErr = null;
    for (const cand of this.buildCandidates()) {
      const pool = new Pool(Object.assign({}, cand.config, { max: 8, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 }));
      try {
        const probe = await pool.connect();
        try { await probe.query('SELECT 1'); } finally { probe.release(); }
        this.pool = pool;
        console.log('Postgres connected via ' + cand.label);
        await this.ensureSchema();
        return;
      } catch (e) {
        lastErr = e;
        console.error('Postgres candidate failed — ' + cand.label + ': ' + errDetail(e));
        await pool.end().catch(() => {});
      }
    }
    throw lastErr || new Error('no postgres connection candidates');
  }

  async ensureSchema(){
    const c = await this.pool.connect();
    try {
      await c.query(`
        CREATE TABLE IF NOT EXISTS users(
          id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL,
          pass_salt TEXT NOT NULL, pass_hash TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(
          token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE TABLE IF NOT EXISTS habits(
          user_id INTEGER NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
          emoji TEXT NOT NULL DEFAULT '💪', color INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, ord INTEGER, PRIMARY KEY(user_id, id));
        CREATE TABLE IF NOT EXISTS days(
          user_id INTEGER NOT NULL, habit_id TEXT NOT NULL, date TEXT NOT NULL, val TEXT NOT NULL,
          PRIMARY KEY(user_id, habit_id, date));
        CREATE TABLE IF NOT EXISTS notes(
          user_id INTEGER NOT NULL, date TEXT NOT NULL, text TEXT NOT NULL,
          PRIMARY KEY(user_id, date));
      `);
    } finally { c.release(); }
  }
  async q(text, params){ return (await this.pool.query(text, params)).rows; }
  async getUserByEmail(email){
    const r = await this.q('SELECT id,pass_salt,pass_hash FROM users WHERE email=$1', [email]);
    return r[0] || null;
  }
  async createUser(email, salt, hash, createdAt){
    try {
      const r = await this.q('INSERT INTO users(email,pass_salt,pass_hash,created_at) VALUES($1,$2,$3,$4) RETURNING id', [email, salt, hash, createdAt]);
      return r[0].id;
    } catch (e) {
      if (e && e.code === '23505') throw Object.assign(new Error('email_taken'), { taken: true });
      throw e;
    }
  }
  async createSession(tokenHash, userId, createdAt, expiresAt){
    await this.q('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)', [tokenHash, userId, createdAt, expiresAt]);
  }
  async getSession(tokenHash){
    const r = await this.q('SELECT s.token_hash AS token_hash, s.expires_at AS expires_at, u.id AS uid, u.email AS email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1', [tokenHash]);
    return r[0] || null;
  }
  async renewSession(tokenHash, newExpires){ await this.q('UPDATE sessions SET expires_at=$1 WHERE token_hash=$2', [newExpires, tokenHash]); }
  async deleteSession(tokenHash){ await this.q('DELETE FROM sessions WHERE token_hash=$1', [tokenHash]); }
  async countHabits(userId){ return Number((await this.q('SELECT COUNT(*) AS n FROM habits WHERE user_id=$1', [userId]))[0].n); }
  async habitExists(userId, id){ return (await this.q('SELECT 1 AS x FROM habits WHERE user_id=$1 AND id=$2', [userId, id])).length > 0; }
  async upsertHabit(userId, c){
    await this.q(`INSERT INTO habits(user_id,id,name,type,emoji,color,created_at,ord) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(user_id,id) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,emoji=EXCLUDED.emoji,color=EXCLUDED.color,created_at=EXCLUDED.created_at,ord=EXCLUDED.ord`,
      [userId, c.id, c.name, c.type, c.emoji, c.color, c.createdAt, c.ord]);
  }
  async deleteHabit(userId, id){
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM habits WHERE user_id=$1 AND id=$2', [userId, id]);
      await c.query('DELETE FROM days WHERE user_id=$1 AND habit_id=$2', [userId, id]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  async setDay(userId, habitId, date, val){
    if (val === '') await this.q('DELETE FROM days WHERE user_id=$1 AND habit_id=$2 AND date=$3', [userId, habitId, date]);
    else await this.q('INSERT INTO days(user_id,habit_id,date,val) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,habit_id,date) DO UPDATE SET val=EXCLUDED.val', [userId, habitId, date, val]);
  }
  async setNote(userId, date, text){
    if (text === '') await this.q('DELETE FROM notes WHERE user_id=$1 AND date=$2', [userId, date]);
    else await this.q('INSERT INTO notes(user_id,date,text) VALUES($1,$2,$3) ON CONFLICT(user_id,date) DO UPDATE SET text=EXCLUDED.text', [userId, date, text]);
  }
  async getData(userId){
    const habits = {}, logs = {}, notes = {};
    for (const r of await this.q('SELECT id,name,type,emoji,color,created_at,ord FROM habits WHERE user_id=$1', [userId])) {
      habits[r.id] = { name: r.name, type: r.type, emoji: r.emoji, color: r.color, createdAt: r.created_at };
      if (r.ord !== null && r.ord !== undefined) habits[r.id].order = r.ord;
      logs[r.id] = { days: {} };
    }
    for (const r of await this.q('SELECT habit_id,date,val FROM days WHERE user_id=$1', [userId])) {
      (logs[r.habit_id] || (logs[r.habit_id] = { days: {} })).days[r.date] = r.val;
    }
    for (const r of await this.q('SELECT date,text FROM notes WHERE user_id=$1', [userId])) notes[r.date] = r.text;
    return { habits, logs, notes };
  }
  async importData(userId, payload){
    const { habits, logs, notes } = payload;
    let nH = 0, nD = 0, nN = 0;
    const c = await this.pool.connect();
    const run = (text, params) => c.query(text, params);
    try {
      await c.query('BEGIN');
      const existing = Number((await run('SELECT COUNT(*) AS n FROM habits WHERE user_id=$1', [userId])).rows[0].n);
      for (const [id, h] of Object.entries(habits)) {
        if (existing + nH >= MAX_HABITS) break;
        const cl = cleanHabit(id, h); if (!cl) continue;
        await run(`INSERT INTO habits(user_id,id,name,type,emoji,color,created_at,ord) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT(user_id,id) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,emoji=EXCLUDED.emoji,color=EXCLUDED.color,created_at=EXCLUDED.created_at,ord=EXCLUDED.ord`,
          [userId, cl.id, cl.name, cl.type, cl.emoji, cl.color, cl.createdAt, cl.ord]);
        nH++;
        const days = (logs[id] && typeof logs[id] === 'object' && logs[id].days) || {};
        for (const [date, val] of Object.entries(days)) {
          if (nD >= 40000) break;
          if (!RE_DATE.test(date) || VALS.indexOf(val) === -1 || val === '') continue;
          await run('INSERT INTO days(user_id,habit_id,date,val) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,habit_id,date) DO UPDATE SET val=EXCLUDED.val', [userId, cl.id, date, val]);
          nD++;
        }
      }
      for (const [date, text] of Object.entries(notes)) {
        if (nN >= 10000) break;
        if (!RE_DATE.test(date) || typeof text !== 'string') continue;
        const t = text.trim().slice(0, 500); if (!t) continue;
        await run('INSERT INTO notes(user_id,date,text) VALUES($1,$2,$3) ON CONFLICT(user_id,date) DO UPDATE SET text=EXCLUDED.text', [userId, date, t]);
        nN++;
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    return { habits: nH, days: nD, notes: nN };
  }
}

let store;
let storageReady = false;

/* =========================================================================
 * shared helpers, validation, auth crypto — backend-independent
 * ========================================================================= */
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();

function scryptHash(password, salt){
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => err ? reject(err) : resolve(key));
  });
}
async function makePassword(password){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scryptHash(password, salt)).toString('hex');
  return { salt, hash };
}
async function checkPassword(password, salt, expectedHex){
  const got = await scryptHash(password, salt);
  const exp = Buffer.from(expectedHex, 'hex');
  return got.length === exp.length && crypto.timingSafeEqual(got, exp);
}
const RESERVED_DUMMY = { salt: 'a'.repeat(32), hash: 'b'.repeat(128) };

async function createSession(userId){
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await store.createSession(sha256(token), userId, nowIso(), expires);
  return token;
}
async function readSession(req){
  const raw = req.headers.cookie || '';
  let token = null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'dh_session') { token = v.join('='); break; }
  }
  if (!token || token.length > 200) return null;
  const row = await store.getSession(sha256(token));
  if (!row) return null;
  if (row.expires_at <= nowIso()) { await store.deleteSession(row.token_hash); return null; }
  const remainMs = new Date(row.expires_at).getTime() - Date.now();
  if (remainMs < SESSION_DAYS * 864e5 / 2) {
    await store.renewSession(row.token_hash, new Date(Date.now() + SESSION_DAYS * 864e5).toISOString());
  }
  return { userId: row.uid, email: row.email, tokenHash: row.token_hash };
}
function sessionCookie(req, token, maxAgeSec){
  const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
  return `dh_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

const rl = new Map();
function rateLimited(ip){
  const now = Date.now();
  let e = rl.get(ip);
  if (!e || now > e.reset) { e = { count: 0, reset: now + 15 * 60e3 }; rl.set(ip, e); }
  e.count++;
  if (rl.size > 10000) { for (const [k, v] of rl) if (now > v.reset) rl.delete(k); }
  return e.count > 25;
}
const ipOf = (req) => ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';

const RE_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,24}$/;
const RE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VALS = ['', 'y', 'n', 's'];

function cleanHabit(id, h){
  if (!RE_ID.test(id) || !h || typeof h !== 'object') return null;
  const name = String(h.name || '').trim().slice(0, 60);
  if (!name) return null;
  const type = h.type === 'bad' ? 'bad' : 'good';
  const emoji = String(h.emoji || '💪').slice(0, 8);
  let color = Number(h.color); color = Number.isInteger(color) && color >= 0 && color <= 7 ? color : 0;
  const createdAt = RE_DATE.test(String(h.createdAt || '')) ? h.createdAt : nowIso().slice(0, 10);
  let ord = Number(h.order); ord = Number.isFinite(ord) && Math.abs(ord) <= 1e6 ? Math.trunc(ord) : null;
  return { id, name, type, emoji, color, createdAt, ord };
}

function readBody(req){
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too_large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(Object.assign(new Error('bad_json'), { code: 400 })); }
    });
    req.on('error', () => reject(Object.assign(new Error('read_error'), { code: 400 })));
  });
}
function send(res, code, obj, extraHeaders){
  const headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extraHeaders || {});
  res.writeHead(code, headers);
  res.end(JSON.stringify(obj));
}

/* =========================================================================
 * HTTP API
 * ========================================================================= */
async function handleApi(req, res, pathname){
  if (!storageReady) return send(res, 503, { error: 'storage_unavailable' });
  const method = req.method;
  const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  if (mutating && req.headers['x-dh'] !== '1') return send(res, 403, { error: 'missing_header' });

  if (pathname === '/api/register' && method === 'POST') {
    if (rateLimited(ipOf(req))) return send(res, 429, { error: 'rate_limited' });
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!RE_EMAIL.test(email)) return send(res, 400, { error: 'bad_email' });
    if (password.length < 8 || password.length > 200) return send(res, 400, { error: 'bad_password' });
    const { salt, hash } = await makePassword(password);
    let userId;
    try { userId = await store.createUser(email, salt, hash, nowIso()); }
    catch (e) { if (e && e.taken) return send(res, 409, { error: 'email_taken' }); throw e; }
    const token = await createSession(userId);
    return send(res, 200, { email }, { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    if (rateLimited(ipOf(req))) return send(res, 429, { error: 'rate_limited' });
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    const row = await store.getUserByEmail(email);
    const okPw = row
      ? await checkPassword(password, row.pass_salt, row.pass_hash)
      : (await checkPassword(password, RESERVED_DUMMY.salt, RESERVED_DUMMY.hash), false);
    if (!row || !okPw) return send(res, 401, { error: 'bad_credentials' });
    const token = await createSession(row.id);
    return send(res, 200, { email }, { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const sess = await readSession(req);
    if (sess) await store.deleteSession(sess.tokenHash);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, 'x', 0) });
  }

  const sess = await readSession(req);
  if (pathname === '/api/me' && method === 'GET') {
    return sess ? send(res, 200, { email: sess.email }) : send(res, 401, { error: 'no_session' });
  }
  if (!sess) return send(res, 401, { error: 'no_session' });
  const uid = sess.userId;

  if (pathname === '/api/data' && method === 'GET') return send(res, 200, await store.getData(uid));

  if (pathname === '/api/import' && method === 'POST') {
    const b = await readBody(req);
    const counts = await store.importData(uid, {
      habits: (b && typeof b.habits === 'object' && b.habits) || {},
      logs: (b && typeof b.logs === 'object' && b.logs) || {},
      notes: (b && typeof b.notes === 'object' && b.notes) || {}
    });
    return send(res, 200, { imported: counts });
  }

  const habitMatch = pathname.match(/^\/api\/habits\/([A-Za-z0-9_-]{1,40})$/);
  if (habitMatch && method === 'PUT') {
    const b = await readBody(req);
    const c = cleanHabit(habitMatch[1], b);
    if (!c) return send(res, 400, { error: 'bad_habit' });
    if (!(await store.habitExists(uid, c.id)) && (await store.countHabits(uid)) >= MAX_HABITS) return send(res, 409, { error: 'habit_limit' });
    await store.upsertHabit(uid, c);
    return send(res, 200, { ok: true });
  }
  if (habitMatch && method === 'DELETE') {
    await store.deleteHabit(uid, habitMatch[1]);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/day' && method === 'PATCH') {
    const b = await readBody(req);
    const habitId = String(b.habitId || ''), date = String(b.date || ''), val = b.val;
    if (!RE_ID.test(habitId) || !RE_DATE.test(date) || VALS.indexOf(val) === -1) return send(res, 400, { error: 'bad_day' });
    await store.setDay(uid, habitId, date, val);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/note' && method === 'PATCH') {
    const b = await readBody(req);
    const date = String(b.date || '');
    if (!RE_DATE.test(date)) return send(res, 400, { error: 'bad_note' });
    const text = String(b.text == null ? '' : b.text).trim().slice(0, 500);
    await store.setNote(uid, date, text);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not_found' });
}

const page = fs.readFileSync(path.join(__dirname, 'index.html'));

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { pathname = '/'; }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((e) => {
      if (!res.headersSent) send(res, e && e.code === 413 ? 413 : (e && e.code === 400 ? 400 : 500), { error: e && e.code ? e.message : 'server_error' });
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : page);
});

module.exports = { PgStore, SqliteStore, dockerGatewayIp, sanitizeUrl };

/* Serve immediately; bring storage up in the background and retry until it
 * connects. Guests are unaffected while storage is down — the sync API
 * answers 503 storage_unavailable until it is ready. */
if (require.main === module) (async () => {
  const usePg = HAS_PG_VARS;
  store = usePg ? new PgStore(DATABASE_URL) : new SqliteStore(DATA_DIR);
  server.listen(PORT, () => console.log('Daily Habit listening on port ' + PORT + ' [storage: ' + store.kind + ', initializing]'));
  for (;;) {
    try {
      await store.init();
      storageReady = true;
      console.log('Storage ready [storage: ' + store.kind + (usePg ? '' : ', ' + DATA_DIR) + ']');
      return;
    } catch (e) {
      console.error('Storage init failed (' + store.kind + '): ' + errDetail(e));
      console.error(usePg
        ? 'Sync API disabled until the database is reachable (guests unaffected). Retrying in 15s — check DATABASE_URL and network/TLS.'
        : 'Sync API disabled until storage works (guests unaffected). Retrying in 15s — check that DATA_DIR is writable.');
      await new Promise(r => setTimeout(r, 15000));
    }
  }
})();
