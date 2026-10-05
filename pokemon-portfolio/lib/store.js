'use strict';
// Storage for accounts, sessions and portfolios.
//
//   DATABASE_URL set  → PostgreSQL (recommended for any hosted deployment: data lives outside the
//                       web server, so redeploys and restarts never touch it)
//   otherwise         → a JSON file in DATA_DIR (fine for running on your own computer)
//
// Both expose the same async interface. When Postgres starts empty and a JSON file from an
// earlier version exists, its accounts and portfolios are imported automatically.
const fs = require('fs');
const path = require('path');

/* ---------------- JSON file ---------------- */
function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'db.json');
  let data = { users: {}, emails: {}, sessions: {}, portfolios: {} };
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Could not read ${file}: ${e.message}`);
  }
  let timer = null;
  const flush = () => {
    timer = null;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  };
  const save = () => { if (!timer) timer = setTimeout(flush, 250); };
  const flushNow = () => { if (timer) { clearTimeout(timer); flush(); } };
  process.on('exit', flushNow);

  return {
    kind: `file (${file})`,
    async getUser(id) { return data.users[id] || null; },
    async getUserByEmail(email) { return data.users[data.emails[email]] || null; },
    async createUser(u) {
      if (data.emails[u.email]) { const e = new Error('duplicate'); e.code = 'DUPLICATE'; throw e; }
      data.users[u.id] = u; data.emails[u.email] = u.id; save();
    },
    async createSession(hash, s) { data.sessions[hash] = s; save(); },
    async getSession(hash) { return data.sessions[hash] || null; },
    async deleteSession(hash) { if (data.sessions[hash]) { delete data.sessions[hash]; save(); } },
    async deleteExpiredSessions(now) {
      let n = 0;
      for (const [k, s] of Object.entries(data.sessions)) if (s.expires < now) { delete data.sessions[k]; n++; }
      if (n) save();
    },
    async getPortfolio(userId) { return data.portfolios[userId] || null; },
    async putPortfolio(userId, doc) { data.portfolios[userId] = doc; save(); },
    async updateUser(id, fields) {
      const u = data.users[id];
      if (!u) return null;
      Object.assign(u, fields);
      save();
      return u;
    },
    async listPortfolios() {
      return Object.entries(data.portfolios)
        .filter(([uid]) => data.users[uid])
        .map(([uid, doc]) => ({ userId: uid, name: data.users[uid].name, showOnLeaderboard: data.users[uid].showOnLeaderboard !== false, doc }));
    },
    async close() { flushNow(); },
  };
}

/* ---------------- PostgreSQL ---------------- */
async function pgStore(url, legacyDir) {
  let pg;
  try { pg = require('pg'); } catch {
    throw new Error('DATABASE_URL is set but the "pg" package is missing — run `npm install`.');
  }
  const { connectionString, ssl } = cleanDatabaseUrl(url);
  const pool = new pg.Pool({ connectionString, ssl, max: 5, connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000 });
  // Idle connections can be dropped by the database host; don't let that crash the server.
  pool.on('error', (e) => console.error('Postgres connection error:', e.message));

  // Free databases (e.g. Neon) sleep when idle and take a few seconds to wake: retry.
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (e) {
      if (attempt >= 6) throw new Error(`Could not connect to the database in DATABASE_URL: ${e.message}`);
      console.warn(`Database not reachable yet (${e.message}) — retrying (${attempt}/5)…`);
      await new Promise((r) => setTimeout(r, Math.min(8000, 1000 * 2 ** (attempt - 1))));
    }
  }
  const q = (text, params) => pool.query(text, params);

  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      email      TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      pass_hash  TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires    BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS show_on_leaderboard BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE TABLE IF NOT EXISTS portfolios (
      user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      doc        JSONB NOT NULL,
      updated_at BIGINT NOT NULL
    );`);

  const toUser = (r) => r && { id: r.id, email: r.email, name: r.name, passHash: r.pass_hash, createdAt: +r.created_at, showOnLeaderboard: r.show_on_leaderboard !== false };
  const store = {
    kind: 'postgres',
    async getUser(id) { return toUser((await q('SELECT * FROM users WHERE id = $1', [id])).rows[0]); },
    async getUserByEmail(email) { return toUser((await q('SELECT * FROM users WHERE email = $1', [email])).rows[0]); },
    async createUser(u) {
      try {
        await q('INSERT INTO users (id, email, name, pass_hash, created_at) VALUES ($1, $2, $3, $4, $5)', [u.id, u.email, u.name, u.passHash, u.createdAt]);
      } catch (e) {
        if (e.code === '23505') { const d = new Error('duplicate'); d.code = 'DUPLICATE'; throw d; }
        throw e;
      }
    },
    async createSession(hash, s) { await q('INSERT INTO sessions (token_hash, user_id, expires) VALUES ($1, $2, $3)', [hash, s.userId, s.expires]); },
    async getSession(hash) {
      const r = (await q('SELECT user_id, expires FROM sessions WHERE token_hash = $1', [hash])).rows[0];
      return r ? { userId: r.user_id, expires: +r.expires } : null;
    },
    async deleteSession(hash) { await q('DELETE FROM sessions WHERE token_hash = $1', [hash]); },
    async deleteExpiredSessions(now) { await q('DELETE FROM sessions WHERE expires < $1', [now]); },
    async getPortfolio(userId) { return (await q('SELECT doc FROM portfolios WHERE user_id = $1', [userId])).rows[0]?.doc || null; },
    async putPortfolio(userId, doc) {
      await q(`INSERT INTO portfolios (user_id, doc, updated_at) VALUES ($1, $2, $3)
               ON CONFLICT (user_id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at`,
      [userId, JSON.stringify(doc), doc.updatedAt || Date.now()]);
    },
    async updateUser(id, fields) {
      const sets = [], vals = [];
      if (fields.name != null) { vals.push(fields.name); sets.push(`name = $${vals.length}`); }
      if (fields.showOnLeaderboard != null) { vals.push(!!fields.showOnLeaderboard); sets.push(`show_on_leaderboard = $${vals.length}`); }
      if (sets.length) { vals.push(id); await q(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals); }
      return store.getUser(id);
    },
    async listPortfolios() {
      const { rows } = await q(`SELECT u.id, u.name, u.show_on_leaderboard, p.doc FROM users u JOIN portfolios p ON p.user_id = u.id`);
      return rows.map((r) => ({ userId: r.id, name: r.name, showOnLeaderboard: r.show_on_leaderboard !== false, doc: r.doc }));
    },
    async close() { await pool.end(); },
  };

  // One-time import from the JSON file used by earlier versions.
  const legacy = path.join(legacyDir, 'db.json');
  const { rows } = await q('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n === 0 && fs.existsSync(legacy)) {
    const data = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const u of Object.values(data.users || {})) {
        await client.query('INSERT INTO users (id, email, name, pass_hash, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [u.id, u.email, u.name, u.passHash, u.createdAt]);
      }
      for (const [uid, doc] of Object.entries(data.portfolios || {})) {
        if (data.users?.[uid]) await client.query('INSERT INTO portfolios (user_id, doc, updated_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [uid, JSON.stringify(doc), doc.updatedAt || Date.now()]);
      }
      await client.query('COMMIT');
      console.log(`Imported ${Object.keys(data.users || {}).length} account(s) from ${legacy} into Postgres.`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  return store;
}

// Accept the connection string however it was pasted: surrounding quotes or a leading
// `psql '…'` (Neon's dashboard shows it that way), and parameters node-postgres doesn't need.
function cleanDatabaseUrl(raw) {
  let url = String(raw).trim().replace(/^psql\s+/, '').replace(/^['"]|['"]$/g, '').trim();
  let sslmode = null;
  try {
    const u = new URL(url);
    if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('bad protocol');
    sslmode = u.searchParams.get('sslmode');
    for (const k of ['sslmode', 'channel_binding', 'sslrootcert', 'sslcert', 'sslkey']) u.searchParams.delete(k);
    url = u.toString();
  } catch {
    throw new Error('DATABASE_URL isn’t a valid connection string — it should start with postgres:// or postgresql://');
  }
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url);
  const ssl = sslmode === 'disable' || process.env.PGSSL === 'off' || (local && sslmode == null) ? false : { rejectUnauthorized: false };
  return { connectionString: url, ssl };
}

async function createStore({ databaseUrl, dataDir }) {
  return databaseUrl ? pgStore(databaseUrl, dataDir) : fileStore(dataDir);
}

module.exports = { createStore, cleanDatabaseUrl };
