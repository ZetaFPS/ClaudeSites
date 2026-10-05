'use strict';
const crypto = require('crypto');

const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  const want = Buffer.from(hash, 'hex');
  return want.length === test.length && crypto.timingSafeEqual(want, test);
}

// A dummy hash so failed logins for unknown emails take as long as real ones.
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

function createAuth(store) {
  const db = store.data;

  function publicUser(u) {
    return { id: u.id, email: u.email, name: u.name, createdAt: u.createdAt };
  }

  function createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.sessions[sha256(token)] = { userId, expires: Date.now() + SESSION_DAYS * 864e5 };
    store.save();
    return { token, maxAge: SESSION_DAYS * 86400 };
  }

  function userForToken(token) {
    if (!token) return null;
    const key = sha256(token);
    const s = db.sessions[key];
    if (!s) return null;
    if (s.expires < Date.now()) { delete db.sessions[key]; store.save(); return null; }
    return db.users[s.userId] || null;
  }

  function destroySession(token) {
    if (token && db.sessions[sha256(token)]) { delete db.sessions[sha256(token)]; store.save(); }
  }

  function signup({ email, password, name }) {
    email = String(email || '').trim().toLowerCase();
    name = String(name || '').trim().slice(0, 60);
    password = String(password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw httpError(400, 'Enter a valid email address.');
    if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters.');
    if (password.length > 200) throw httpError(400, 'Password is too long.');
    if (db.emails[email]) throw httpError(409, 'An account with that email already exists.');
    const id = crypto.randomUUID();
    const user = { id, email, name: name || email.split('@')[0], passHash: hashPassword(password), createdAt: Date.now() };
    db.users[id] = user;
    db.emails[email] = id;
    store.save();
    return user;
  }

  function login({ email, password }) {
    email = String(email || '').trim().toLowerCase();
    const user = db.users[db.emails[email]];
    const ok = verifyPassword(String(password || ''), user ? user.passHash : DUMMY_HASH);
    if (!user || !ok) throw httpError(401, 'Incorrect email or password.');
    return user;
  }

  // Drop expired sessions once an hour.
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [k, s] of Object.entries(db.sessions)) if (s.expires < now) { delete db.sessions[k]; changed = true; }
    if (changed) store.save();
  }, 3600e3).unref();

  return { publicUser, createSession, userForToken, destroySession, signup, login };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { createAuth, httpError };
