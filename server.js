// Daily Habit — static app + optional accounts & cross-device sync.
// Zero npm dependencies. Requires Node >= 22 (node:sqlite).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSION_DAYS = 120;
const MAX_HABITS = 50;
const MAX_BODY = 256 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'habits.db'));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  pass_salt TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS habits(
  user_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '💪',
  color INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  ord INTEGER,
  PRIMARY KEY(user_id, id)
);
CREATE TABLE IF NOT EXISTS days(
  user_id INTEGER NOT NULL,
  habit_id TEXT NOT NULL,
  date TEXT NOT NULL,
  val TEXT NOT NULL,
  PRIMARY KEY(user_id, habit_id, date)
);
CREATE TABLE IF NOT EXISTS notes(
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY(user_id, date)
);
`);

const page = fs.readFileSync(path.join(__dirname, 'index.html'));

/* ---------------- helpers ---------------- */
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

/* sessions */
function createSession(userId){
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)')
    .run(sha256(token), userId, nowIso(), expires);
  return token;
}
function readSession(req){
  const raw = req.headers.cookie || '';
  let token = null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'dh_session') { token = v.join('='); break; }
  }
  if (!token || token.length > 200) return null;
  const row = db.prepare(
    `SELECT s.token_hash, s.expires_at, u.id AS uid, u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`
  ).get(sha256(token));
  if (!row) return null;
  if (row.expires_at <= nowIso()) {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(row.token_hash);
    return null;
  }
  // sliding renewal when under half the lifetime remains
  const remainMs = new Date(row.expires_at).getTime() - Date.now();
  if (remainMs < SESSION_DAYS * 864e5 / 2) {
    db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?')
      .run(new Date(Date.now() + SESSION_DAYS * 864e5).toISOString(), row.token_hash);
  }
  return { userId: row.uid, email: row.email, tokenHash: row.token_hash };
}
function sessionCookie(req, token, maxAgeSec){
  const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
  return `dh_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

/* rate limiting (auth endpoints) */
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

/* validation */
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

/* body reading */
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

/* data shaping */
function dataFor(userId){
  const habits = {}, logs = {}, notes = {};
  for (const r of db.prepare('SELECT id,name,type,emoji,color,created_at,ord FROM habits WHERE user_id=?').all(userId)) {
    habits[r.id] = { name: r.name, type: r.type, emoji: r.emoji, color: r.color, createdAt: r.created_at };
    if (r.ord !== null && r.ord !== undefined) habits[r.id].order = r.ord;
    logs[r.id] = { days: {} };
  }
  for (const r of db.prepare('SELECT habit_id,date,val FROM days WHERE user_id=?').all(userId)) {
    (logs[r.habit_id] || (logs[r.habit_id] = { days: {} })).days[r.date] = r.val;
  }
  for (const r of db.prepare('SELECT date,text FROM notes WHERE user_id=?').all(userId)) notes[r.date] = r.text;
  return { habits, logs, notes };
}

const upsertHabit = db.prepare(`INSERT INTO habits(user_id,id,name,type,emoji,color,created_at,ord) VALUES(?,?,?,?,?,?,?,?)
  ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name,type=excluded.type,emoji=excluded.emoji,color=excluded.color,created_at=excluded.created_at,ord=excluded.ord`);
const upsertDay = db.prepare(`INSERT INTO days(user_id,habit_id,date,val) VALUES(?,?,?,?)
  ON CONFLICT(user_id,habit_id,date) DO UPDATE SET val=excluded.val`);
const deleteDay = db.prepare('DELETE FROM days WHERE user_id=? AND habit_id=? AND date=?');
const upsertNote = db.prepare(`INSERT INTO notes(user_id,date,text) VALUES(?,?,?)
  ON CONFLICT(user_id,date) DO UPDATE SET text=excluded.text`);
const deleteNote = db.prepare('DELETE FROM notes WHERE user_id=? AND date=?');
const countHabits = db.prepare('SELECT COUNT(*) AS n FROM habits WHERE user_id=?');

/* ---------------- request handling ---------------- */
async function handleApi(req, res, pathname){
  const method = req.method;
  const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  if (mutating && req.headers['x-dh'] !== '1') return send(res, 403, { error: 'missing_header' });

  /* ---- auth endpoints ---- */
  if (pathname === '/api/register' && method === 'POST') {
    if (rateLimited(ipOf(req))) return send(res, 429, { error: 'rate_limited' });
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!RE_EMAIL.test(email)) return send(res, 400, { error: 'bad_email' });
    if (password.length < 8 || password.length > 200) return send(res, 400, { error: 'bad_password' });
    const { salt, hash } = await makePassword(password);
    let userId;
    try {
      const r = db.prepare('INSERT INTO users(email,pass_salt,pass_hash,created_at) VALUES(?,?,?,?)').run(email, salt, hash, nowIso());
      userId = Number(r.lastInsertRowid);
    } catch (e) {
      return send(res, 409, { error: 'email_taken' });
    }
    const token = createSession(userId);
    return send(res, 200, { email }, { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    if (rateLimited(ipOf(req))) return send(res, 429, { error: 'rate_limited' });
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    const row = db.prepare('SELECT id,pass_salt,pass_hash FROM users WHERE email=?').get(email);
    const okPw = row
      ? await checkPassword(password, row.pass_salt, row.pass_hash)
      : (await checkPassword(password, RESERVED_DUMMY.salt, RESERVED_DUMMY.hash), false);
    if (!row || !okPw) return send(res, 401, { error: 'bad_credentials' });
    const token = createSession(row.id);
    return send(res, 200, { email }, { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const sess = readSession(req);
    if (sess) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sess.tokenHash);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, 'x', 0) });
  }

  /* ---- everything below requires a session ---- */
  const sess = readSession(req);
  if (pathname === '/api/me' && method === 'GET') {
    return sess ? send(res, 200, { email: sess.email }) : send(res, 401, { error: 'no_session' });
  }
  if (!sess) return send(res, 401, { error: 'no_session' });
  const uid = sess.userId;

  if (pathname === '/api/data' && method === 'GET') return send(res, 200, dataFor(uid));

  if (pathname === '/api/import' && method === 'POST') {
    const b = await readBody(req);
    const habits = (b && typeof b.habits === 'object' && b.habits) || {};
    const logs = (b && typeof b.logs === 'object' && b.logs) || {};
    const notes = (b && typeof b.notes === 'object' && b.notes) || {};
    let nH = 0, nD = 0, nN = 0;
    db.exec('BEGIN');
    try {
      const existing = countHabits.get(uid).n;
      for (const [id, h] of Object.entries(habits)) {
        if (existing + nH >= MAX_HABITS) break;
        const c = cleanHabit(id, h);
        if (!c) continue;
        upsertHabit.run(uid, c.id, c.name, c.type, c.emoji, c.color, c.createdAt, c.ord);
        nH++;
        const days = (logs[id] && typeof logs[id] === 'object' && logs[id].days) || {};
        for (const [date, val] of Object.entries(days)) {
          if (nD >= 40000) break;
          if (!RE_DATE.test(date) || VALS.indexOf(val) === -1) continue;
          if (val === '') continue;
          upsertDay.run(uid, c.id, date, val);
          nD++;
        }
      }
      for (const [date, text] of Object.entries(notes)) {
        if (nN >= 10000) break;
        if (!RE_DATE.test(date) || typeof text !== 'string') continue;
        const t = text.trim().slice(0, 500);
        if (!t) continue;
        upsertNote.run(uid, date, t);
        nN++;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return send(res, 200, { imported: { habits: nH, days: nD, notes: nN } });
  }

  const habitMatch = pathname.match(/^\/api\/habits\/([A-Za-z0-9_-]{1,40})$/);
  if (habitMatch && method === 'PUT') {
    const b = await readBody(req);
    const c = cleanHabit(habitMatch[1], b);
    if (!c) return send(res, 400, { error: 'bad_habit' });
    const exists = db.prepare('SELECT 1 AS x FROM habits WHERE user_id=? AND id=?').get(uid, c.id);
    if (!exists && countHabits.get(uid).n >= MAX_HABITS) return send(res, 409, { error: 'habit_limit' });
    upsertHabit.run(uid, c.id, c.name, c.type, c.emoji, c.color, c.createdAt, c.ord);
    return send(res, 200, { ok: true });
  }
  if (habitMatch && method === 'DELETE') {
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM habits WHERE user_id=? AND id=?').run(uid, habitMatch[1]);
      db.prepare('DELETE FROM days WHERE user_id=? AND habit_id=?').run(uid, habitMatch[1]);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/day' && method === 'PATCH') {
    const b = await readBody(req);
    const habitId = String(b.habitId || '');
    const date = String(b.date || '');
    const val = b.val;
    if (!RE_ID.test(habitId) || !RE_DATE.test(date) || VALS.indexOf(val) === -1) return send(res, 400, { error: 'bad_day' });
    if (val === '') deleteDay.run(uid, habitId, date);
    else upsertDay.run(uid, habitId, date, val);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/note' && method === 'PATCH') {
    const b = await readBody(req);
    const date = String(b.date || '');
    if (!RE_DATE.test(date)) return send(res, 400, { error: 'bad_note' });
    const text = String(b.text == null ? '' : b.text).trim().slice(0, 500);
    if (text === '') deleteNote.run(uid, date);
    else upsertNote.run(uid, date, text);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not_found' });
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { pathname = '/'; }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((e) => {
      if (!res.headersSent) send(res, e && e.code === 413 ? 413 : (e && e.code === 400 ? 400 : 500), { error: e && e.code ? e.message : 'server_error' });
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(req.method === 'HEAD' ? undefined : page);
});

server.listen(PORT, () => console.log('Daily Habit listening on port ' + PORT + ' (data: ' + DATA_DIR + ')'));
