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
      CREATE TABLE IF NOT EXISTS push_subs(
        endpoint TEXT PRIMARY KEY, user_id INTEGER NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
        tz TEXT NOT NULL DEFAULT 'UTC', created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id);
      CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    // schedule columns (added in v3.1; ALTER only if missing)
    const cols = new Set(this.db.prepare('PRAGMA table_info(habits)').all().map(r => r.name));
    for (const c of ['remind_at', 'win_start', 'win_end']) if (!cols.has(c)) this.db.exec('ALTER TABLE habits ADD COLUMN ' + c + ' INTEGER');
  }
  async getUserByEmail(email){
    return this.db.prepare('SELECT id,pass_salt,pass_hash FROM users WHERE email=?').get(email) || null;
  }
  async kvGet(k){ const r = this.db.prepare('SELECT v FROM kv WHERE k=?').get(k); return r ? r.v : null; }
  async kvSet(k, v){ this.db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v); }
  async upsertPushSub(userId, endpoint, p256dh, auth, tz){
    this.db.prepare(`INSERT INTO push_subs(endpoint,user_id,p256dh,auth,tz,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,tz=excluded.tz`)
      .run(endpoint, userId, p256dh, auth, tz, nowIso());
  }
  async deletePushSub(endpoint){ this.db.prepare('DELETE FROM push_subs WHERE endpoint=?').run(endpoint); }
  async listPushSubs(userId){
    return userId == null
      ? this.db.prepare('SELECT endpoint,user_id,p256dh,auth,tz FROM push_subs').all()
      : this.db.prepare('SELECT endpoint,user_id,p256dh,auth,tz FROM push_subs WHERE user_id=?').all(userId);
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
    this.db.prepare(`INSERT INTO habits(user_id,id,name,type,emoji,color,created_at,ord,remind_at,win_start,win_end) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name,type=excluded.type,emoji=excluded.emoji,color=excluded.color,created_at=excluded.created_at,ord=excluded.ord,remind_at=excluded.remind_at,win_start=excluded.win_start,win_end=excluded.win_end`)
      .run(userId, c.id, c.name, c.type, c.emoji, c.color, c.createdAt, c.ord, c.remindAt, c.winStart, c.winEnd);
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
    for (const r of this.db.prepare('SELECT ' + HABIT_COLS + ' FROM habits WHERE user_id=?').all(userId)) {
      habits[r.id] = habitRowToObj(r);
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

/* ---- internal-hostname candidates (single-host docker PaaS) ----
 * Some platforms advertise a managed DB on a public host:port that their
 * own firewall blocks from inside containers, while the DB container sits
 * on a shared private docker network where its NAME resolves via docker's
 * embedded DNS. Given the database instance name (DB_INSTANCE_NAME, or the
 * platform's naming conventions), we try a few well-known name patterns on
 * the standard port — plain DNS lookups of specific names, no scanning. */
const dns = require('dns').promises;

function internalNameCandidates(instanceName){
  const n = String(instanceName || '').trim().toLowerCase();
  if (!n) return [];
  const names = [n, 'gs-' + n, 'db-' + n, n + '-db', 'gs-db-' + n, n + '-postgres', 'postgres-' + n, 'pg-' + n];
  return [...new Set(names)];
}
async function resolvable(name){
  try { const a = await dns.lookup(name, { family: 4 }); return a && a.address ? a.address : null; }
  catch (e) { return null; }
}

class PgStore {
  constructor(url){ this.url = url; this.kind = 'postgres'; }

  sslOrder(){
    const url = this.url;
    const sslEnv = String(process.env.PGSSL || '').toLowerCase();
    const forceSsl = /sslmode=(require|verify|prefer)/i.test(url) || ['1', 'true', 'require', 'yes', 'on'].includes(sslEnv);
    const noSsl = ['0', 'false', 'no', 'off', 'disable'].includes(sslEnv) || /sslmode=disable/i.test(url);
    return noSsl ? [false] : (forceSsl ? [true, false] : [false, true]);
  }
  mk(theUrl, ssl, note){
    return {
      config: ssl ? { connectionString: theUrl, ssl: { rejectUnauthorized: false } } : { connectionString: theUrl },
      label: sanitizeUrl(theUrl) + (ssl ? ' +tls' : ' no-tls') + (note ? ' (' + note + ')' : '')
    };
  }
  withHost(hostPort){
    const v = new URL(this.url);
    const m = String(hostPort).match(/^\[?([^\]:]+)\]?(?::(\d+))?$/);
    if (!m) return null;
    v.hostname = m[1]; if (m[2]) v.port = m[2];
    return v.toString();
  }

  /* Static candidates: optional DB_HOST_OVERRIDE first, then the string as
   * given, then gateway/host aliases on the same port (with/without TLS). */
  buildCandidates(){
    const url = this.url;
    const sslOrder = this.sslOrder();
    const mk = (theUrl, ssl, note) => this.mk(theUrl, ssl, note);
    if (!url) return sslOrder.map(ssl => ({ config: ssl ? { ssl: { rejectUnauthorized: false } } : {}, label: 'PG* env vars' + (ssl ? ' +tls' : ' no-tls') }));
    const out = [];
    let u = null; try { u = new URL(url); } catch (e) {}
    const override = String(process.env.DB_HOST_OVERRIDE || '').trim();
    if (u && override) { const ov = this.withHost(override); if (ov) for (const ssl of sslOrder) out.push(mk(ov, ssl, 'DB_HOST_OVERRIDE')); }
    for (const ssl of sslOrder) out.push(mk(url, ssl));
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

  async tryCandidate(Pool, cand){
    const pool = new Pool(Object.assign({}, cand.config, { max: 8, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 }));
    try {
      const probe = await pool.connect();
      try { await probe.query('SELECT 1'); } finally { probe.release(); }
      this.pool = pool;
      pool.on('error', (e) => { console.error('Postgres pool error: ' + errDetail(e)); markStorageDown(); });
      console.log('Postgres connected via ' + cand.label);
      await this.ensureSchema();
      return true;
    } catch (e) {
      console.error('Postgres candidate failed — ' + cand.label + ': ' + errDetail(e));
      await pool.end().catch(() => {});
      this.lastErr = e;
      return false;
    }
  }

  /* Internal-name candidates: resolve well-known container-name patterns for
   * the database instance via docker DNS; only names that resolve are tried. */
  async discoveryCandidates(){
    try { new URL(this.url); } catch (e) { return []; }
    const inst = String(process.env.DB_INSTANCE_NAME || '').trim();
    const names = internalNameCandidates(inst);
    if (!names.length) { console.error('Internal lookup skipped — set DB_INSTANCE_NAME=<database instance name> to try docker-network hostnames.'); return []; }
    const port = Number(process.env.DB_INTERNAL_PORT) || 5432;
    const out = [];
    for (const name of names) {
      const ip = await resolvable(name);
      if (!ip) continue;
      console.error('Internal lookup: ' + name + ' resolves to ' + ip + ' → will try on port ' + port);
      const theUrl = this.withHost(name + ':' + port);
      for (const ssl of this.sslOrder()) out.push(this.mk(theUrl, ssl, 'internal name'));
    }
    if (!out.length) console.error('Internal lookup: none of [' + names.join(', ') + '] resolve on this network.');
    return out;
  }

  async init(){
    const { Pool } = require('pg');
    this.lastErr = null;
    for (const cand of this.buildCandidates()) if (await this.tryCandidate(Pool, cand)) return;
    for (const cand of await this.discoveryCandidates()) if (await this.tryCandidate(Pool, cand)) return;
    throw this.lastErr || new Error('no postgres connection candidates');
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
        CREATE TABLE IF NOT EXISTS push_subs(
          endpoint TEXT PRIMARY KEY, user_id INTEGER NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
          tz TEXT NOT NULL DEFAULT 'UTC', created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id);
        CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
        ALTER TABLE habits ADD COLUMN IF NOT EXISTS remind_at INTEGER;
        ALTER TABLE habits ADD COLUMN IF NOT EXISTS win_start INTEGER;
        ALTER TABLE habits ADD COLUMN IF NOT EXISTS win_end INTEGER;
      `);
    } finally { c.release(); }
  }
  async q(text, params){ return (await this.pool.query(text, params)).rows; }
  async getUserByEmail(email){
    const r = await this.q('SELECT id,pass_salt,pass_hash FROM users WHERE email=$1', [email]);
    return r[0] || null;
  }
  async kvGet(k){ const r = await this.q('SELECT v FROM kv WHERE k=$1', [k]); return r[0] ? r[0].v : null; }
  async kvSet(k, v){ await this.q('INSERT INTO kv(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v', [k, v]); }
  async upsertPushSub(userId, endpoint, p256dh, auth, tz){
    await this.q(`INSERT INTO push_subs(endpoint,user_id,p256dh,auth,tz,created_at) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,tz=EXCLUDED.tz`,
      [endpoint, userId, p256dh, auth, tz, nowIso()]);
  }
  async deletePushSub(endpoint){ await this.q('DELETE FROM push_subs WHERE endpoint=$1', [endpoint]); }
  async listPushSubs(userId){
    return userId == null
      ? this.q('SELECT endpoint,user_id,p256dh,auth,tz FROM push_subs')
      : this.q('SELECT endpoint,user_id,p256dh,auth,tz FROM push_subs WHERE user_id=$1', [userId]);
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
    await this.q(PG_UPSERT_HABIT, [userId, c.id, c.name, c.type, c.emoji, c.color, c.createdAt, c.ord, c.remindAt, c.winStart, c.winEnd]);
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
    for (const r of await this.q('SELECT ' + HABIT_COLS + ' FROM habits WHERE user_id=$1', [userId])) {
      habits[r.id] = habitRowToObj(r);
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
        await run(PG_UPSERT_HABIT, [userId, cl.id, cl.name, cl.type, cl.emoji, cl.color, cl.createdAt, cl.ord, cl.remindAt, cl.winStart, cl.winEnd]);
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

/* Schedule fields: whole hours 0–23 or null. remindAt = daily reminder;
 * winStart/winEnd = the hours a GOOD habit is meant to happen (end > start). */
function cleanHour(v){
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : undefined;   // undefined = invalid
}
function cleanHabit(id, h){
  if (!RE_ID.test(id) || !h || typeof h !== 'object') return null;
  const name = String(h.name || '').trim().slice(0, 60);
  if (!name) return null;
  const type = h.type === 'bad' ? 'bad' : 'good';
  const emoji = String(h.emoji || '💪').slice(0, 8);
  let color = Number(h.color); color = Number.isInteger(color) && color >= 0 && color <= 7 ? color : 0;
  const createdAt = RE_DATE.test(String(h.createdAt || '')) ? h.createdAt : nowIso().slice(0, 10);
  let ord = Number(h.order); ord = Number.isFinite(ord) && Math.abs(ord) <= 1e6 ? Math.trunc(ord) : null;
  const remindAt = cleanHour(h.remindAt);
  let winStart = cleanHour(h.winStart), winEnd = cleanHour(h.winEnd);
  if (remindAt === undefined || winStart === undefined || winEnd === undefined) return null;   // out-of-range hour
  if (type !== 'good') { winStart = null; winEnd = null; }                                    // windows are for good habits
  if ((winStart === null) !== (winEnd === null)) return null;                                 // both or neither
  if (winStart !== null && winEnd <= winStart) return null;                                   // end must be after start
  return { id, name, type, emoji, color, createdAt, ord, remindAt, winStart, winEnd };
}
const HABIT_COLS = 'id,name,type,emoji,color,created_at,ord,remind_at,win_start,win_end';
const PG_UPSERT_HABIT = `INSERT INTO habits(user_id,id,name,type,emoji,color,created_at,ord,remind_at,win_start,win_end) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  ON CONFLICT(user_id,id) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,emoji=EXCLUDED.emoji,color=EXCLUDED.color,created_at=EXCLUDED.created_at,ord=EXCLUDED.ord,remind_at=EXCLUDED.remind_at,win_start=EXCLUDED.win_start,win_end=EXCLUDED.win_end`;
function habitRowToObj(r){
  const h = { name: r.name, type: r.type, emoji: r.emoji, color: r.color, createdAt: r.created_at };
  if (r.ord !== null && r.ord !== undefined) h.order = r.ord;
  if (r.remind_at !== null && r.remind_at !== undefined) h.remindAt = r.remind_at;
  if (r.win_start !== null && r.win_start !== undefined) h.winStart = r.win_start;
  if (r.win_end !== null && r.win_end !== undefined) h.winEnd = r.win_end;
  return h;
}

/* =========================================================================
 * Web Push reminders
 * Habit schedules are whole hours in the DEVICE's local time zone (each
 * subscription records its tz). Every 30 s the ticker checks, for each
 * subscribed device, whether its local clock is in the first five minutes
 * of an hour that has a due reminder / window start / window end, and sends
 * at most one notification per device+habit+kind per hour. Anything already
 * checked in as done today is skipped.
 * ========================================================================= */
let webpush = null;
let vapid = null;                 // { publicKey, subject }
let pushTransport = null;         // (sub, payload) => Promise — swappable for tests
const sentKeys = new Map();       // dedupe: key -> timestamp

async function initPush(){
  try { webpush = require('web-push'); } catch (e) { console.error('web-push not installed — notifications disabled'); return; }
  let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    pub = await store.kvGet('vapid_public'); priv = await store.kvGet('vapid_private');
    if (!pub || !priv) {
      const k = webpush.generateVAPIDKeys(); pub = k.publicKey; priv = k.privateKey;
      await store.kvSet('vapid_public', pub); await store.kvSet('vapid_private', priv);
      console.log('Generated VAPID keys (stored in database)');
    }
  }
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  webpush.setVapidDetails(subject, pub, priv);
  vapid = { publicKey: pub, subject };
  if (!pushTransport) pushTransport = (sub, payload) => webpush.sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 3600 });
  console.log('Web Push ready');
}
function setPushTransport(fn){ pushTransport = fn; }

function validTz(tz){ try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; } }
function localParts(date, tz){
  try {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const p = {}; for (const part of f.formatToParts(date)) if (part.type !== 'literal') p[part.type] = part.value;
    return { ymd: p.year + '-' + p.month + '-' + p.day, hour: Number(p.hour) % 24, minute: Number(p.minute) };
  } catch (e) { return null; }
}
const fmtHour = (h) => h + ':00';

function dueNotifications(habits, logs, hour, ymd){
  const out = [];
  for (const [id, h] of Object.entries(habits || {})) {
    const v = (((logs || {})[id] || {}).days || {})[ymd];
    const done = v === 'y';
    if (done) continue;   // already checked in today — nothing to nag about
    const label = (h.emoji ? h.emoji + ' ' : '') + h.name;
    if (Number.isInteger(h.remindAt) && h.remindAt === hour) {
      out.push({ habitId: id, kind: 'remind', title: label,
        body: h.type === 'bad' ? 'Daily check-in: staying clean today? Tap to log it.' : 'Daily reminder — have you done it today? Tap to check in.' });
    }
    if (h.type === 'good' && Number.isInteger(h.winStart) && Number.isInteger(h.winEnd)) {
      if (h.winStart === hour) out.push({ habitId: id, kind: 'start', title: 'Time for ' + label, body: 'Your window is open until ' + fmtHour(h.winEnd) + '. Go for it!' });
      if (h.winEnd === hour) out.push({ habitId: id, kind: 'end', title: label + ' — window ended', body: 'Did you do it? Tap to check in and move on.' });
    }
  }
  return out;
}

function pruneSent(){ const cutoff = Date.now() - 26 * 3600e3; for (const [k, t] of sentKeys) if (t < cutoff) sentKeys.delete(k); }

async function runTick(now){
  now = now || new Date();
  if (!storageReady || !pushTransport) return { sent: 0, evaluated: 0 };
  const subs = await store.listPushSubs(null);
  if (!subs.length) return { sent: 0, evaluated: 0 };
  const byUser = new Map();
  for (const s of subs) { if (!byUser.has(s.user_id)) byUser.set(s.user_id, []); byUser.get(s.user_id).push(s); }
  let sent = 0, evaluated = 0;
  for (const [userId, list] of byUser) {
    let data = null;
    for (const s of list) {
      const lp = localParts(now, s.tz || 'UTC'); if (!lp) continue;
      if (lp.minute > 4) continue;                                  // first five minutes of the hour only
      const hourKey = lp.ymd + 'T' + lp.hour;
      const evalKey = 'e:' + s.endpoint + ':' + hourKey;
      if (sentKeys.has(evalKey)) continue;                          // this device already handled this hour
      sentKeys.set(evalKey, Date.now()); evaluated++;
      if (!data) data = await store.getData(userId);
      for (const n of dueNotifications(data.habits, data.logs, lp.hour, lp.ymd)) {
        const key = 'n:' + s.endpoint + ':' + n.habitId + ':' + n.kind + ':' + hourKey;
        if (sentKeys.has(key)) continue;
        sentKeys.set(key, Date.now());
        try {
          await pushTransport(s, { title: n.title, body: n.body, tag: 'dh-' + n.habitId + '-' + n.kind, url: '/' });
          sent++;
        } catch (e) {
          const code = e && e.statusCode;
          if (code === 404 || code === 410) { await store.deletePushSub(s.endpoint).catch(() => {}); console.error('Push subscription expired — removed'); }
          else console.error('Push send failed: ' + errDetail(e));
        }
      }
    }
  }
  pruneSent();
  return { sent, evaluated };
}

/* ---- PWA assets: service worker, manifest, generated PNG icons ---- */
const SW_JS = `self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Daily Habit', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Daily Habit', {
    body: d.body || '', tag: d.tag || 'dh', icon: '/icon-192.png', badge: '/icon-192.png',
    data: { url: d.url || '/' }, renotify: true }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { if (c.navigate) c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
`;
const MANIFEST = JSON.stringify({
  name: 'Daily Habit', short_name: 'Daily Habit', description: 'Track good and bad habits with streaks, reminders and sync.',
  start_url: '/', scope: '/', display: 'standalone', background_color: '#FFF8ED', theme_color: '#F04E11',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
  ]
});

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf){ let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
const iconCache = new Map();
/* Flat accent square with a white flame (yellow core), 2x2 supersampled. No image deps. */
function makeIconPng(size){
  if (iconCache.has(size)) return iconCache.get(size);
  const zlib = require('zlib');
  const w = size, h = size;
  // teardrop flame: tapered upper body leaning right into a tip, round base; smaller yellow core
  const drop = (u, v, top, baseY, r, lean) => {
    if (v >= baseY) return (u - 0.5) ** 2 + (v - baseY) ** 2 <= r * r;
    if (v < top) return false;
    const t = (v - top) / (baseY - top);
    const hw = r * Math.pow(t, 0.55);
    const cx = 0.5 + lean * Math.pow(1 - t, 2);
    return Math.abs(u - cx) <= hw;
  };
  const shade = (u, v) => {
    if (!drop(u, v, 0.13, 0.64, 0.29, 0.10)) return [240, 78, 17];
    return drop(u, v, 0.50, 0.77, 0.13, 0.03) ? [255, 214, 102] : [255, 255, 255];
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) { const c = shade((x + dx) / w, (y + dy) / h); r += c[0]; g += c[1]; b += c[2]; }
      const i = y * (w * 4 + 1) + 1 + x * 4;
      raw[i] = r >> 2; raw[i + 1] = g >> 2; raw[i + 2] = b >> 2; raw[i + 3] = 255;
    }
  }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  iconCache.set(size, png);
  return png;
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

  if (pathname === '/api/push/vapid' && method === 'GET') {
    return vapid ? send(res, 200, { publicKey: vapid.publicKey }) : send(res, 503, { error: 'push_unavailable' });
  }

  const sess = await readSession(req);
  if (pathname === '/api/me' && method === 'GET') {
    return sess ? send(res, 200, { email: sess.email }) : send(res, 401, { error: 'no_session' });
  }
  if (!sess) return send(res, 401, { error: 'no_session' });
  const uid = sess.userId;

  if (pathname === '/api/data' && method === 'GET') return send(res, 200, await store.getData(uid));

  /* ---- push subscriptions ---- */
  if (pathname === '/api/push/subscribe' && method === 'POST') {
    if (!vapid) return send(res, 503, { error: 'push_unavailable' });
    const b = await readBody(req);
    const s = b && b.subscription;
    const endpoint = s && typeof s.endpoint === 'string' ? s.endpoint : '';
    const p256dh = s && s.keys && typeof s.keys.p256dh === 'string' ? s.keys.p256dh : '';
    const auth = s && s.keys && typeof s.keys.auth === 'string' ? s.keys.auth : '';
    if (!/^https:\/\/\S{1,1500}$/.test(endpoint) || !p256dh || !auth || p256dh.length > 300 || auth.length > 100) return send(res, 400, { error: 'bad_subscription' });
    const tz = (typeof b.tz === 'string' && b.tz.length <= 64 && validTz(b.tz)) ? b.tz : 'UTC';
    await store.upsertPushSub(uid, endpoint, p256dh, auth, tz);
    return send(res, 200, { ok: true, tz });
  }
  if (pathname === '/api/push/unsubscribe' && method === 'POST') {
    const b = await readBody(req);
    const endpoint = typeof b.endpoint === 'string' ? b.endpoint : '';
    if (!endpoint) return send(res, 400, { error: 'bad_endpoint' });
    const mine = (await store.listPushSubs(uid)).some(s => s.endpoint === endpoint);
    if (mine) await store.deletePushSub(endpoint);
    return send(res, 200, { ok: true });
  }
  if (pathname === '/api/push/status' && method === 'GET') {
    const subs = await store.listPushSubs(uid);
    return send(res, 200, { devices: subs.length, enabled: !!vapid });
  }
  if (pathname === '/api/push/test' && method === 'POST') {
    if (!vapid || !pushTransport) return send(res, 503, { error: 'push_unavailable' });
    const subs = await store.listPushSubs(uid);
    let sent = 0;
    for (const s of subs) {
      try { await pushTransport(s, { title: '🔥 Daily Habit', body: 'Notifications are working on this device.', tag: 'dh-test', url: '/' }); sent++; }
      catch (e) { const code = e && e.statusCode; if (code === 404 || code === 410) await store.deletePushSub(s.endpoint).catch(() => {}); }
    }
    return send(res, 200, { sent });
  }

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
      if (storageReady && store && store.kind === 'postgres' && isConnError(e)) markStorageDown();
      if (!res.headersSent) {
        if (isConnError(e)) return send(res, 503, { error: 'storage_unavailable' });
        send(res, e && e.code === 413 ? 413 : (e && e.code === 400 ? 400 : 500), { error: e && e.code ? e.message : 'server_error' });
      }
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const asset = (type, body, cache) => { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache || 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : body); };
  if (pathname === '/sw.js') return asset('application/javascript; charset=utf-8', SW_JS, 'no-cache');
  if (pathname === '/manifest.webmanifest') return asset('application/manifest+json; charset=utf-8', MANIFEST);
  if (pathname === '/icon-192.png') return asset('image/png', makeIconPng(192));
  if (pathname === '/icon-512.png') return asset('image/png', makeIconPng(512));
  if (pathname === '/apple-touch-icon.png') return asset('image/png', makeIconPng(180));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : page);
});

module.exports = { PgStore, SqliteStore, dockerGatewayIp, sanitizeUrl, internalNameCandidates,
  cleanHabit, dueNotifications, localParts, runTick, setPushTransport, makeIconPng, initPush,
  _test: { setStore(s){ store = s; storageReady = true; }, sentKeys } };

/* Storage lifecycle: serve immediately; bring storage up in the background
 * and retry until it connects. Guests are unaffected while storage is down —
 * the sync API answers 503 storage_unavailable until it is ready. If the
 * connection is lost later (DB moved/restarted), rediscover and reconnect. */
let bringingUp = false;
const CONN_ERR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', '57P01', '57P02', '57P03', '08000', '08003', '08006']);
function isConnError(e){
  return !!(e && (CONN_ERR_CODES.has(e.code) || /terminated|timeout|ECONNREFUSED|not connected|Connection ended/i.test(String(e.message || ''))));
}
function markStorageDown(){
  if (!storageReady && bringingUp) return;
  storageReady = false;
  console.error('Storage marked unavailable — reconnecting…');
  bringUpStorage();
}
async function bringUpStorage(){
  if (bringingUp) return;
  bringingUp = true;
  const usePg = HAS_PG_VARS;
  try {
    for (;;) {
      try {
        if (store.pool) { try { await store.pool.end(); } catch (e) {} store.pool = null; }
        await store.init();
        storageReady = true;
        console.log('Storage ready [storage: ' + store.kind + (usePg ? '' : ', ' + DATA_DIR) + ']');
        try { await initPush(); } catch (e) { console.error('Web Push init failed (notifications disabled): ' + errDetail(e)); }
        return;
      } catch (e) {
        console.error('Storage init failed (' + store.kind + '): ' + errDetail(e));
        console.error(usePg
          ? 'Sync API disabled until the database is reachable (guests unaffected). Retrying in 15s — check DATABASE_URL / DB_HOST_OVERRIDE and the discovery lines above.'
          : 'Sync API disabled until storage works (guests unaffected). Retrying in 15s — check that DATA_DIR is writable.');
        await new Promise(r => setTimeout(r, 15000));
      }
    }
  } finally { bringingUp = false; }
}

if (require.main === module) {
  store = HAS_PG_VARS ? new PgStore(DATABASE_URL) : new SqliteStore(DATA_DIR);
  server.listen(PORT, () => console.log('Daily Habit listening on port ' + PORT + ' [storage: ' + store.kind + ', initializing]'));
  bringUpStorage();
  setInterval(() => runTick().catch(e => console.error('Reminder tick failed: ' + errDetail(e))), 30000).unref();
}
