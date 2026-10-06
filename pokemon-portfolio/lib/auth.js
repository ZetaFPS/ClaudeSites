'use strict';
const crypto = require('crypto');

const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(pw, salt, SCRYPT.keylen, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))));

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await scrypt(password, salt)).toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const test = await scrypt(password, salt);
  const want = Buffer.from(hash, 'hex');
  return want.length === test.length && crypto.timingSafeEqual(want, test);
}

function createAuth(store) {
  // A dummy hash so failed logins for unknown emails take as long as real ones.
  const dummy = hashPassword(crypto.randomBytes(8).toString('hex'));

  function publicUser(u) {
    return { id: u.id, email: u.email, name: u.name, createdAt: u.createdAt, showOnLeaderboard: u.showOnLeaderboard !== false, avatar: avatarUrl(u.id, u.avatarAt) };
  }

  async function createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    await store.createSession(sha256(token), { userId, expires: Date.now() + SESSION_DAYS * 864e5 });
    return { token, maxAge: SESSION_DAYS * 86400 };
  }

  async function userForToken(token) {
    if (!token) return null;
    const key = sha256(token);
    const s = await store.getSession(key);
    if (!s) return null;
    if (s.expires < Date.now()) { await store.deleteSession(key); return null; }
    return store.getUser(s.userId);
  }

  async function destroySession(token) {
    if (token) await store.deleteSession(sha256(token));
  }

  async function signup({ email, password, name }) {
    email = String(email || '').trim().toLowerCase();
    name = String(name || '').trim().slice(0, 60);
    password = String(password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw httpError(400, 'Enter a valid email address.');
    if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters.');
    if (password.length > 200) throw httpError(400, 'Password is too long.');
    if (await store.getUserByEmail(email)) throw httpError(409, 'An account with that email already exists.');
    const user = { id: crypto.randomUUID(), email, name: name || email.split('@')[0], passHash: await hashPassword(password), createdAt: Date.now() };
    try {
      await store.createUser(user);
    } catch (e) {
      if (e.code === 'DUPLICATE') throw httpError(409, 'An account with that email already exists.');
      throw e;
    }
    return user;
  }

  async function login({ email, password }) {
    email = String(email || '').trim().toLowerCase();
    const user = await store.getUserByEmail(email);
    const ok = await verifyPassword(String(password || ''), user ? user.passHash : await dummy);
    if (!user || !ok) throw httpError(401, 'Incorrect email or password.');
    return user;
  }

  // Drop expired sessions once an hour.
  setInterval(() => { store.deleteExpiredSessions(Date.now()).catch(() => {}); }, 3600e3).unref();

  return { publicUser, createSession, userForToken, destroySession, signup, login };
}

// Profile picture URL; the version changes with every upload so browsers can cache it forever.
const avatarUrl = (id, at) => (at ? `/api/avatar/${encodeURIComponent(id)}?v=${at}` : null);

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { createAuth, httpError, avatarUrl };
