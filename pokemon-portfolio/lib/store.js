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
  let data = { users: {}, emails: {}, sessions: {}, portfolios: {}, groups: {}, members: {}, messages: {}, images: {}, seq: 0 };
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

    // --- groups ---
    async createGroup(g) { data.groups[g.id] = { ...g }; data.members[g.id] = {}; data.messages[g.id] = []; save(); },
    async getGroup(id) { return data.groups[id] || null; },
    async getGroupByCode(code) { return Object.values(data.groups).find((g) => g.inviteCode === code) || null; },
    async updateGroup(id, fields) { if (data.groups[id]) { Object.assign(data.groups[id], fields); save(); } return data.groups[id] || null; },
    async deleteGroup(id) {
      delete data.groups[id]; delete data.members[id]; delete data.messages[id];
      for (const [k, img] of Object.entries(data.images)) if (img.groupId === id) delete data.images[k];
      save();
    },
    async addMember(groupId, userId, role, joinedAt) {
      (data.members[groupId] ||= {})[userId] ||= { role, joinedAt, lastRead: 0 };
      save();
    },
    async removeMember(groupId, userId) { if (data.members[groupId]) { delete data.members[groupId][userId]; save(); } },
    async getMember(groupId, userId) { return data.members[groupId]?.[userId] || null; },
    async listMembers(groupId) {
      return Object.entries(data.members[groupId] || {}).filter(([uid]) => data.users[uid])
        .map(([uid, m]) => ({ userId: uid, name: data.users[uid].name, role: m.role, joinedAt: m.joinedAt, lastRead: m.lastRead }));
    },
    async countUserGroups(userId) { return Object.values(data.members).filter((m) => m[userId]).length; },
    async listUserGroups(userId) {
      const out = [];
      for (const [gid, mem] of Object.entries(data.members)) {
        const me = mem[userId];
        const g = data.groups[gid];
        if (!me || !g) continue;
        const msgs = data.messages[gid] || [];
        const last = msgs[msgs.length - 1] || null;
        out.push({
          ...g, role: me.role, lastRead: me.lastRead, memberCount: Object.keys(mem).length,
          last: last && { ...last, name: data.users[last.userId]?.name || 'Someone' },
          unread: msgs.filter((m) => m.seq > me.lastRead && m.userId !== userId).length,
        });
      }
      return out;
    },
    async setLastRead(groupId, userId, seq) {
      const m = data.members[groupId]?.[userId];
      if (m && seq > m.lastRead) { m.lastRead = seq; save(); }
    },
    async addMessage(msg) {
      const full = { ...msg, seq: ++data.seq };
      (data.messages[msg.groupId] ||= []).push(full);
      save();
      return full;
    },
    async listMessages(groupId, { after = 0, before = null, limit = 50 } = {}) {
      let msgs = (data.messages[groupId] || []).filter((m) => m.seq > after && (before == null || m.seq < before));
      msgs = after ? msgs.slice(0, limit) : msgs.slice(-limit);
      return msgs.map((m) => ({ ...m, name: data.users[m.userId]?.name || 'Former member' }));
    },
    async getMessage(groupId, seq) { return (data.messages[groupId] || []).find((m) => m.seq === seq) || null; },
    async deleteMessage(groupId, seq) {
      const arr = data.messages[groupId] || [];
      const i = arr.findIndex((m) => m.seq === seq);
      if (i >= 0) {
        const [m] = arr.splice(i, 1);
        if (m.imageId) delete data.images[m.imageId];
        save();
      }
    },
    async addImage(img) { data.images[img.id] = { groupId: img.groupId, mime: img.mime, b64: img.data.toString('base64'), createdAt: img.createdAt }; save(); },
    async getImage(id) {
      const i = data.images[id];
      return i ? { id, groupId: i.groupId, mime: i.mime, data: Buffer.from(i.b64, 'base64') } : null;
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
    );
    CREATE TABLE IF NOT EXISTS groups (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invite_code TEXT NOT NULL UNIQUE,
      created_at  BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id  TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role      TEXT NOT NULL,
      joined_at BIGINT NOT NULL,
      last_read BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (group_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS group_members_user ON group_members (user_id);
    CREATE TABLE IF NOT EXISTS group_images (
      id         TEXT PRIMARY KEY,
      group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      mime       TEXT NOT NULL,
      data       BYTEA NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_messages (
      seq        BIGSERIAL PRIMARY KEY,
      group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL,
      kind       TEXT NOT NULL,
      body       TEXT,
      image_id   TEXT REFERENCES group_images(id) ON DELETE SET NULL,
      card       JSONB,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS group_messages_group_seq ON group_messages (group_id, seq);`);

  const toGroup = (r) => r && { id: r.id, name: r.name, ownerId: r.owner_id, inviteCode: r.invite_code, createdAt: +r.created_at };
  const toMessage = (r) => r && {
    seq: +r.seq, groupId: r.group_id, userId: r.user_id, kind: r.kind, body: r.body, imageId: r.image_id, card: r.card,
    createdAt: +r.created_at, name: r.name || 'Former member',
  };
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

    // --- groups ---
    async createGroup(g) {
      await q('INSERT INTO groups (id, name, owner_id, invite_code, created_at) VALUES ($1,$2,$3,$4,$5)', [g.id, g.name, g.ownerId, g.inviteCode, g.createdAt]);
    },
    async getGroup(id) { return toGroup((await q('SELECT * FROM groups WHERE id = $1', [id])).rows[0]); },
    async getGroupByCode(code) { return toGroup((await q('SELECT * FROM groups WHERE invite_code = $1', [code])).rows[0]); },
    async updateGroup(id, fields) {
      const sets = [], vals = [];
      if (fields.name != null) { vals.push(fields.name); sets.push(`name = $${vals.length}`); }
      if (fields.inviteCode != null) { vals.push(fields.inviteCode); sets.push(`invite_code = $${vals.length}`); }
      if (sets.length) { vals.push(id); await q(`UPDATE groups SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals); }
      return store.getGroup(id);
    },
    async deleteGroup(id) { await q('DELETE FROM groups WHERE id = $1', [id]); },
    async addMember(groupId, userId, role, joinedAt) {
      await q('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [groupId, userId, role, joinedAt]);
    },
    async removeMember(groupId, userId) { await q('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]); },
    async getMember(groupId, userId) {
      const r = (await q('SELECT role, joined_at, last_read FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId])).rows[0];
      return r ? { role: r.role, joinedAt: +r.joined_at, lastRead: +r.last_read } : null;
    },
    async listMembers(groupId) {
      const { rows } = await q(`SELECT m.user_id, u.name, m.role, m.joined_at, m.last_read FROM group_members m JOIN users u ON u.id = m.user_id
                                WHERE m.group_id = $1 ORDER BY m.joined_at`, [groupId]);
      return rows.map((r) => ({ userId: r.user_id, name: r.name, role: r.role, joinedAt: +r.joined_at, lastRead: +r.last_read }));
    },
    async countUserGroups(userId) { return (await q('SELECT COUNT(*)::int AS n FROM group_members WHERE user_id = $1', [userId])).rows[0].n; },
    async listUserGroups(userId) {
      const { rows } = await q(`
        SELECT g.*, m.role, m.last_read,
          (SELECT COUNT(*)::int FROM group_members WHERE group_id = g.id) AS member_count,
          (SELECT COUNT(*)::int FROM group_messages WHERE group_id = g.id AND seq > m.last_read AND user_id <> $1) AS unread,
          (SELECT row_to_json(x) FROM (
             SELECT gm.seq, gm.kind, gm.body, gm.user_id AS "userId", gm.created_at AS "createdAt", u.name
             FROM group_messages gm LEFT JOIN users u ON u.id = gm.user_id
             WHERE gm.group_id = g.id ORDER BY gm.seq DESC LIMIT 1) x) AS last
        FROM groups g JOIN group_members m ON m.group_id = g.id
        WHERE m.user_id = $1`, [userId]);
      return rows.map((r) => ({ ...toGroup(r), role: r.role, lastRead: +r.last_read, memberCount: r.member_count, unread: r.unread,
        last: r.last && { ...r.last, seq: +r.last.seq, createdAt: +r.last.createdAt, name: r.last.name || 'Former member' } }));
    },
    async setLastRead(groupId, userId, seq) {
      await q('UPDATE group_members SET last_read = GREATEST(last_read, $3) WHERE group_id = $1 AND user_id = $2', [groupId, userId, seq]);
    },
    async addMessage(msg) {
      const r = (await q(`INSERT INTO group_messages (group_id, user_id, kind, body, image_id, card, created_at)
                          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING seq`,
      [msg.groupId, msg.userId, msg.kind, msg.body ?? null, msg.imageId ?? null, msg.card ? JSON.stringify(msg.card) : null, msg.createdAt])).rows[0];
      return { ...msg, seq: +r.seq };
    },
    async listMessages(groupId, { after = 0, before = null, limit = 50 } = {}) {
      const vals = [groupId, after];
      let where = 'gm.group_id = $1 AND gm.seq > $2';
      if (before != null) { vals.push(before); where += ` AND gm.seq < $${vals.length}`; }
      vals.push(limit);
      const order = after ? 'ASC' : 'DESC';
      const { rows } = await q(`SELECT gm.*, u.name FROM group_messages gm LEFT JOIN users u ON u.id = gm.user_id
                                WHERE ${where} ORDER BY gm.seq ${order} LIMIT $${vals.length}`, vals);
      const msgs = rows.map(toMessage);
      return after ? msgs : msgs.reverse();
    },
    async getMessage(groupId, seq) {
      return toMessage((await q('SELECT gm.*, u.name FROM group_messages gm LEFT JOIN users u ON u.id = gm.user_id WHERE gm.group_id = $1 AND gm.seq = $2', [groupId, seq])).rows[0]);
    },
    async deleteMessage(groupId, seq) {
      const r = (await q('DELETE FROM group_messages WHERE group_id = $1 AND seq = $2 RETURNING image_id', [groupId, seq])).rows[0];
      if (r?.image_id) await q('DELETE FROM group_images WHERE id = $1', [r.image_id]);
    },
    async addImage(img) {
      await q('INSERT INTO group_images (id, group_id, mime, data, created_at) VALUES ($1,$2,$3,$4,$5)', [img.id, img.groupId, img.mime, img.data, img.createdAt]);
    },
    async getImage(id) {
      const r = (await q('SELECT id, group_id, mime, data FROM group_images WHERE id = $1', [id])).rows[0];
      return r ? { id: r.id, groupId: r.group_id, mime: r.mime, data: r.data } : null;
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
