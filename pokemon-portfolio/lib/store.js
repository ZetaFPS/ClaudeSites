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

// Marketplace orderings (newest first breaks ties).
const PRODUCT_SORTS = {
  new: (a, b) => b.createdAt - a.createdAt,
  price_asc: (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || b.createdAt - a.createdAt,
  price_desc: (a, b) => (b.price ?? -1) - (a.price ?? -1) || b.createdAt - a.createdAt,
};
const PRODUCT_ORDER_SQL = {
  new: 'p.created_at DESC',
  price_asc: 'p.price ASC NULLS LAST, p.created_at DESC',
  price_desc: 'p.price DESC NULLS LAST, p.created_at DESC',
};

// Friendships are stored once per pair, whoever asked first.
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/* ---------------- JSON file ---------------- */
function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'db.json');
  let data = { users: {}, emails: {}, sessions: {}, portfolios: {}, groups: {}, members: {}, messages: {}, images: {}, avatars: {}, friends: {}, products: {}, productImages: {}, warnings: [], seq: 0 };
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
    async getUserByUsername(username) { return Object.values(data.users).find((u) => u.username === username) || null; },
    async createUser(u) {
      if (data.emails[u.email]) { const e = new Error('duplicate'); e.code = 'DUPLICATE'; throw e; }
      if (u.username && Object.values(data.users).some((x) => x.username === u.username)) { const e = new Error('duplicate username'); e.code = 'DUPLICATE_USERNAME'; throw e; }
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
      if (fields.username && Object.values(data.users).some((x) => x.id !== id && x.username === fields.username)) {
        const e = new Error('duplicate username'); e.code = 'DUPLICATE_USERNAME'; throw e;
      }
      Object.assign(u, fields);
      save();
      return u;
    },
    async listPortfolios() {
      return Object.entries(data.portfolios)
        .filter(([uid]) => data.users[uid] && !data.users[uid].bannedAt)
        .map(([uid, doc]) => ({ userId: uid, name: data.users[uid].name, username: data.users[uid].username || null, avatarAt: data.users[uid].avatarAt || null, showOnLeaderboard: data.users[uid].showOnLeaderboard !== false, doc }));
    },
    // Profile picture: null image removes it. The user's avatarAt changes with every upload.
    async setAvatar(userId, img) {
      const u = data.users[userId];
      if (!u) return null;
      if (img) { data.avatars[userId] = { mime: img.mime, b64: img.data.toString('base64') }; u.avatarAt = Date.now(); }
      else { delete data.avatars[userId]; delete u.avatarAt; }
      save();
      return u;
    },
    async getAvatar(userId) {
      const a = data.avatars[userId];
      return a ? { mime: a.mime, data: Buffer.from(a.b64, 'base64') } : null;
    },

    // --- groups ---
    async createGroup(g) { data.groups[g.id] = { ...g }; data.members[g.id] = {}; data.messages[g.id] = []; save(); },
    async getGroup(id) { return data.groups[id] || null; },
    async getGroupByCode(code) { return Object.values(data.groups).find((g) => g.inviteCode === code) || null; },
    async getGroupByDmKey(key) { return Object.values(data.groups).find((g) => g.dmKey === key) || null; },
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
        .map(([uid, m]) => ({ userId: uid, name: data.users[uid].name, avatarAt: data.users[uid].avatarAt || null, role: m.role, joinedAt: m.joinedAt, lastRead: m.lastRead }));
    },
    async countUserGroups(userId) { return Object.entries(data.members).filter(([gid, m]) => m[userId] && (data.groups[gid]?.kind || 'group') === 'group').length; },
    async setMemberRole(groupId, userId, role) { const m = data.members[groupId]?.[userId]; if (m) { m.role = role; save(); } },
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
      return msgs.map((m) => ({ ...m, name: data.users[m.userId]?.name || 'Former member', avatarAt: data.users[m.userId]?.avatarAt || null }));
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

    // --- friends: one row per pair, { requester, addressee, status: 'pending' | 'accepted' } ---
    async getFriendship(a, b) { return data.friends[pairKey(a, b)] || null; },
    async putFriendship(f) { data.friends[pairKey(f.requester, f.addressee)] = { ...f }; save(); },
    async deleteFriendship(a, b) { if (data.friends[pairKey(a, b)]) { delete data.friends[pairKey(a, b)]; save(); } },
    async listFriendships(userId) {
      return Object.values(data.friends).filter((f) => f.requester === userId || f.addressee === userId).map((f) => {
        const o = data.users[f.requester === userId ? f.addressee : f.requester];
        return o && { ...f, other: { id: o.id, name: o.name, username: o.username || null, avatarAt: o.avatarAt || null } };
      }).filter(Boolean);
    },

    // --- store products (pictures kept separately) ---
    async createProduct(p) { data.products[p.id] = { ...p }; save(); },
    async getProduct(id) { return data.products[id] ? { ...data.products[id] } : null; },
    async updateProduct(id, fields) { if (data.products[id]) { Object.assign(data.products[id], fields); save(); } return data.products[id] || null; },
    async deleteProduct(id) {
      delete data.products[id];
      for (const [k, img] of Object.entries(data.productImages)) if (img.productId === id) delete data.productImages[k];
      save();
    },
    async listProducts(userId) { return Object.values(data.products).filter((p) => p.userId === userId).sort((a, b) => b.createdAt - a.createdAt).map((p) => ({ ...p })); },
    async searchProducts({ words = [], sort = 'new', offset = 0, limit = 24, includeBanned = false } = {}) {
      const rows = Object.values(data.products).map((p) => ({ ...p, seller: data.users[p.userId] })).filter((p) => p.seller && (includeBanned || !p.seller.bannedAt)).filter((p) => {
        const hay = `${p.title} ${p.description || ''} ${p.seller.name} ${p.seller.username || ''}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      rows.sort(PRODUCT_SORTS[sort] || PRODUCT_SORTS.new);
      return {
        total: rows.length,
        items: rows.slice(offset, offset + limit).map(({ seller, ...p }) => ({ ...p, seller: { id: seller.id, name: seller.name, username: seller.username || null, avatarAt: seller.avatarAt || null, banned: !!seller.bannedAt } })),
      };
    },
    async addProductImage(img) { data.productImages[img.id] = { productId: img.productId, mime: img.mime, b64: img.data.toString('base64') }; save(); },
    async getProductImage(id) {
      const i = data.productImages[id];
      return i ? { id, productId: i.productId, mime: i.mime, data: Buffer.from(i.b64, 'base64') } : null;
    },
    async deleteProductImage(id) { if (data.productImages[id]) { delete data.productImages[id]; save(); } },

    // --- moderation ---
    async listUsers({ words = [], offset = 0, limit = 30 } = {}) {
      const rows = Object.values(data.users).filter((u) => {
        const hay = `${u.name} ${u.username || ''} ${u.email}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      }).sort((a, b) => b.createdAt - a.createdAt);
      return {
        total: rows.length,
        items: rows.slice(offset, offset + limit).map((u) => ({
          ...u, productCount: Object.values(data.products).filter((p) => p.userId === u.id).length,
          warningCount: data.warnings.filter((w) => w.userId === u.id).length,
        })),
      };
    },
    async addWarning(w) { data.warnings.push({ ...w }); save(); },
    async listWarnings(userId) { return data.warnings.filter((w) => !userId || w.userId === userId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200); },
    async countAll() {
      const users = Object.values(data.users);
      return { users: users.length, banned: users.filter((u) => u.bannedAt).length, products: Object.keys(data.products).length, warnings: data.warnings.length };
    },
    async deleteSessionsFor(userId) {
      for (const [k, v] of Object.entries(data.sessions)) if (v.userId === userId) delete data.sessions[k];
      save();
    },
    // Remove an account and everything it owns. Its old chat messages stay, shown as "Former member".
    async deleteUser(id) {
      const u = data.users[id];
      if (!u) return;
      delete data.emails[u.email];
      delete data.users[id];
      delete data.portfolios[id];
      delete data.avatars[id];
      for (const [k, v] of Object.entries(data.sessions)) if (v.userId === id) delete data.sessions[k];
      for (const [k, f] of Object.entries(data.friends)) if (f.requester === id || f.addressee === id) delete data.friends[k];
      for (const p of Object.values(data.products)) {
        if (p.userId !== id) continue;
        delete data.products[p.id];
        for (const [k, img] of Object.entries(data.productImages)) if (img.productId === p.id) delete data.productImages[k];
      }
      for (const [gid, g] of Object.entries(data.groups)) {
        if (g.ownerId === id) {
          delete data.groups[gid]; delete data.members[gid]; delete data.messages[gid];
          for (const [k, img] of Object.entries(data.images)) if (img.groupId === gid) delete data.images[k];
        } else if (data.members[gid]) delete data.members[gid][id];
      }
      data.warnings = data.warnings.filter((w) => w.userId !== id);
      save();
    },

    // --- visual card index (kept in its own append-only file: it's large and only grows) ---
    async listCardFps() {
      const out = new Map();
      try {
        for (const line of fs.readFileSync(path.join(dir, 'card-index.jsonl'), 'utf8').split('\n')) {
          if (!line) continue;
          try { const r = JSON.parse(line); r.fp = Buffer.from(r.fp, 'base64'); out.set(r.id, r); } catch { /* torn last line */ }
        }
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      return [...out.values()];
    },
    async putCardFps(rows) {
      if (!rows.length) return;
      const lines = rows.map((r) => JSON.stringify({ ...r, fp: Buffer.from(r.fp).toString('base64') })).join('\n');
      await fs.promises.appendFile(path.join(dir, 'card-index.jsonl'), `${lines}\n`);
    },

    // --- small key/value documents (e.g. the card catalogue), each in its own file ---
    async getKv(key) {
      try { return JSON.parse(await fs.promises.readFile(path.join(dir, `kv-${key.replace(/[^a-z0-9_-]/gi, '_')}.json`), 'utf8')); } catch { return null; }
    },
    async setKv(key, value) {
      const f = path.join(dir, `kv-${key.replace(/[^a-z0-9_-]/gi, '_')}.json`);
      await fs.promises.writeFile(`${f}.tmp`, JSON.stringify(value));
      await fs.promises.rename(`${f}.tmp`, f);
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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_at BIGINT;
    CREATE TABLE IF NOT EXISTS avatars (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      mime    TEXT NOT NULL,
      data    BYTEA NOT NULL
    );
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
    CREATE INDEX IF NOT EXISTS group_messages_group_seq ON group_messages (group_id, seq);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS show_collection BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users (username) WHERE username IS NOT NULL;
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'group';
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS dm_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS groups_dm_key ON groups (dm_key) WHERE dm_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS friendships (
      pair_key   TEXT PRIMARY KEY,
      requester  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      addressee  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status     TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS friendships_requester ON friendships (requester);
    CREATE INDEX IF NOT EXISTS friendships_addressee ON friendships (addressee);
    CREATE TABLE IF NOT EXISTS products (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      price       NUMERIC(12,2),
      description TEXT NOT NULL DEFAULT '',
      image_ids   JSONB NOT NULL DEFAULT '[]',
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS products_user ON products (user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS product_images (
      id         TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      mime       TEXT NOT NULL,
      data       BYTEA NOT NULL
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT;
    CREATE TABLE IF NOT EXISTS warnings (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      admin_id   TEXT,
      reason     TEXT NOT NULL,
      message    TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS warnings_user ON warnings (user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS kv (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS card_fps (
      id         TEXT PRIMARY KEY,
      meta       JSONB NOT NULL,
      fp         BYTEA NOT NULL,
      updated_at BIGINT NOT NULL
    );`);

  const toGroup = (r) => r && { id: r.id, name: r.name, ownerId: r.owner_id, inviteCode: r.invite_code, createdAt: +r.created_at, kind: r.kind || 'group', dmKey: r.dm_key || null };
  const toProduct = (r) => r && { id: r.id, userId: r.user_id, title: r.title, price: r.price != null ? +r.price : null, description: r.description, imageIds: r.image_ids || [], createdAt: +r.created_at, updatedAt: +r.updated_at };
  const toFriendship = (r) => r && { requester: r.requester, addressee: r.addressee, status: r.status, createdAt: +r.created_at };
  const toMessage = (r) => r && {
    seq: +r.seq, groupId: r.group_id, userId: r.user_id, kind: r.kind, body: r.body, imageId: r.image_id, card: r.card,
    createdAt: +r.created_at, name: r.name || 'Former member', avatarAt: r.avatar_at != null ? +r.avatar_at : null,
  };
  const toUser = (r) => r && {
    id: r.id, email: r.email, name: r.name, passHash: r.pass_hash, createdAt: +r.created_at, showOnLeaderboard: r.show_on_leaderboard !== false,
    avatarAt: r.avatar_at != null ? +r.avatar_at : null, username: r.username || null, bio: r.bio || '', showCollection: r.show_collection === true,
    bannedAt: r.banned_at != null ? +r.banned_at : null, banReason: r.ban_reason || null,
  };
  const dupe = (e) => {
    if (e.code !== '23505') return e;
    const d = new Error('duplicate');
    d.code = /username/.test(e.constraint || e.detail || '') ? 'DUPLICATE_USERNAME' : 'DUPLICATE';
    return d;
  };
  const store = {
    kind: 'postgres',
    async getUser(id) { return toUser((await q('SELECT * FROM users WHERE id = $1', [id])).rows[0]); },
    async getUserByEmail(email) { return toUser((await q('SELECT * FROM users WHERE email = $1', [email])).rows[0]); },
    async getUserByUsername(username) { return toUser((await q('SELECT * FROM users WHERE username = $1', [username])).rows[0]); },
    async createUser(u) {
      try {
        await q('INSERT INTO users (id, email, name, pass_hash, created_at, username) VALUES ($1, $2, $3, $4, $5, $6)', [u.id, u.email, u.name, u.passHash, u.createdAt, u.username || null]);
      } catch (e) {
        throw dupe(e);
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
      if (fields.username != null) { vals.push(fields.username); sets.push(`username = $${vals.length}`); }
      if (fields.bio != null) { vals.push(fields.bio); sets.push(`bio = $${vals.length}`); }
      if (fields.showCollection != null) { vals.push(!!fields.showCollection); sets.push(`show_collection = $${vals.length}`); }
      if (fields.bannedAt !== undefined) { vals.push(fields.bannedAt); sets.push(`banned_at = $${vals.length}`); }
      if (fields.banReason !== undefined) { vals.push(fields.banReason); sets.push(`ban_reason = $${vals.length}`); }
      if (sets.length) {
        vals.push(id);
        try { await q(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals); } catch (e) { throw dupe(e); }
      }
      return store.getUser(id);
    },
    async listPortfolios() {
      const { rows } = await q(`SELECT u.id, u.name, u.username, u.avatar_at, u.show_on_leaderboard, p.doc FROM users u JOIN portfolios p ON p.user_id = u.id WHERE u.banned_at IS NULL`);
      return rows.map((r) => ({ userId: r.id, name: r.name, username: r.username || null, avatarAt: r.avatar_at != null ? +r.avatar_at : null, showOnLeaderboard: r.show_on_leaderboard !== false, doc: r.doc }));
    },
    async setAvatar(userId, img) {
      if (img) {
        await q(`INSERT INTO avatars (user_id, mime, data) VALUES ($1, $2, $3)
                 ON CONFLICT (user_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data`, [userId, img.mime, img.data]);
        await q('UPDATE users SET avatar_at = $1 WHERE id = $2', [Date.now(), userId]);
      } else {
        await q('DELETE FROM avatars WHERE user_id = $1', [userId]);
        await q('UPDATE users SET avatar_at = NULL WHERE id = $1', [userId]);
      }
      return store.getUser(userId);
    },
    async getAvatar(userId) {
      const r = (await q('SELECT mime, data FROM avatars WHERE user_id = $1', [userId])).rows[0];
      return r ? { mime: r.mime, data: r.data } : null;
    },

    // --- groups ---
    async createGroup(g) {
      await q('INSERT INTO groups (id, name, owner_id, invite_code, created_at, kind, dm_key) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [g.id, g.name, g.ownerId, g.inviteCode, g.createdAt, g.kind || 'group', g.dmKey || null]);
    },
    async getGroup(id) { return toGroup((await q('SELECT * FROM groups WHERE id = $1', [id])).rows[0]); },
    async getGroupByCode(code) { return toGroup((await q('SELECT * FROM groups WHERE invite_code = $1', [code])).rows[0]); },
    async getGroupByDmKey(key) { return toGroup((await q('SELECT * FROM groups WHERE dm_key = $1', [key])).rows[0]); },
    async updateGroup(id, fields) {
      const sets = [], vals = [];
      if (fields.name != null) { vals.push(fields.name); sets.push(`name = $${vals.length}`); }
      if (fields.inviteCode != null) { vals.push(fields.inviteCode); sets.push(`invite_code = $${vals.length}`); }
      if (fields.ownerId != null) { vals.push(fields.ownerId); sets.push(`owner_id = $${vals.length}`); }
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
      const { rows } = await q(`SELECT m.user_id, u.name, u.avatar_at, m.role, m.joined_at, m.last_read FROM group_members m JOIN users u ON u.id = m.user_id
                                WHERE m.group_id = $1 ORDER BY m.joined_at`, [groupId]);
      return rows.map((r) => ({ userId: r.user_id, name: r.name, avatarAt: r.avatar_at != null ? +r.avatar_at : null, role: r.role, joinedAt: +r.joined_at, lastRead: +r.last_read }));
    },
    async countUserGroups(userId) {
      return (await q(`SELECT COUNT(*)::int AS n FROM group_members m JOIN groups g ON g.id = m.group_id WHERE m.user_id = $1 AND g.kind = 'group'`, [userId])).rows[0].n;
    },
    async setMemberRole(groupId, userId, role) { await q('UPDATE group_members SET role = $3 WHERE group_id = $1 AND user_id = $2', [groupId, userId, role]); },
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
      const { rows } = await q(`SELECT gm.*, u.name, u.avatar_at FROM group_messages gm LEFT JOIN users u ON u.id = gm.user_id
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

    // --- friends ---
    async getFriendship(a, b) { return toFriendship((await q('SELECT * FROM friendships WHERE pair_key = $1', [pairKey(a, b)])).rows[0]); },
    async putFriendship(f) {
      await q(`INSERT INTO friendships (pair_key, requester, addressee, status, created_at) VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (pair_key) DO UPDATE SET requester = EXCLUDED.requester, addressee = EXCLUDED.addressee, status = EXCLUDED.status, created_at = EXCLUDED.created_at`,
      [pairKey(f.requester, f.addressee), f.requester, f.addressee, f.status, f.createdAt]);
    },
    async deleteFriendship(a, b) { await q('DELETE FROM friendships WHERE pair_key = $1', [pairKey(a, b)]); },
    async listFriendships(userId) {
      const { rows } = await q(`SELECT f.*, u.id AS o_id, u.name AS o_name, u.username AS o_username, u.avatar_at AS o_avatar_at
                                FROM friendships f JOIN users u ON u.id = CASE WHEN f.requester = $1 THEN f.addressee ELSE f.requester END
                                WHERE f.requester = $1 OR f.addressee = $1`, [userId]);
      return rows.map((r) => ({ ...toFriendship(r), other: { id: r.o_id, name: r.o_name, username: r.o_username || null, avatarAt: r.o_avatar_at != null ? +r.o_avatar_at : null } }));
    },

    // --- store products ---
    async createProduct(p) {
      await q('INSERT INTO products (id, user_id, title, price, description, image_ids, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [p.id, p.userId, p.title, p.price, p.description, JSON.stringify(p.imageIds || []), p.createdAt, p.updatedAt]);
    },
    async getProduct(id) { return toProduct((await q('SELECT * FROM products WHERE id = $1', [id])).rows[0]); },
    async updateProduct(id, f) {
      await q('UPDATE products SET title = $2, price = $3, description = $4, image_ids = $5, updated_at = $6 WHERE id = $1',
        [id, f.title, f.price, f.description, JSON.stringify(f.imageIds || []), f.updatedAt]);
      return store.getProduct(id);
    },
    async deleteProduct(id) { await q('DELETE FROM products WHERE id = $1', [id]); },
    async listProducts(userId) { return (await q('SELECT * FROM products WHERE user_id = $1 ORDER BY created_at DESC', [userId])).rows.map(toProduct); },
    async searchProducts({ words = [], sort = 'new', offset = 0, limit = 24, includeBanned = false } = {}) {
      const vals = [];
      const where = includeBanned ? [] : ['u.banned_at IS NULL'];
      where.push(...words.map((w) => {
        vals.push(`%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        const n = `$${vals.length}`;
        return `(p.title ILIKE ${n} OR p.description ILIKE ${n} OR u.name ILIKE ${n} OR u.username ILIKE ${n})`;
      }));
      vals.push(limit, offset);
      const { rows } = await q(`SELECT p.*, u.name AS s_name, u.username AS s_username, u.avatar_at AS s_avatar_at, u.banned_at AS s_banned_at, COUNT(*) OVER () AS total
                                FROM products p JOIN users u ON u.id = p.user_id
                                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                                ORDER BY ${PRODUCT_ORDER_SQL[sort] || PRODUCT_ORDER_SQL.new}
                                LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
      let total = rows.length ? +rows[0].total : 0;
      if (!rows.length && offset) total = (await store.searchProducts({ words, sort, offset: 0, limit: 1, includeBanned })).total;
      return {
        total,
        items: rows.map((r) => ({ ...toProduct(r), seller: { id: r.user_id, name: r.s_name, username: r.s_username || null, avatarAt: r.s_avatar_at != null ? +r.s_avatar_at : null, banned: r.s_banned_at != null } })),
      };
    },
    async addProductImage(img) { await q('INSERT INTO product_images (id, product_id, mime, data) VALUES ($1,$2,$3,$4)', [img.id, img.productId, img.mime, img.data]); },
    async getProductImage(id) {
      const r = (await q('SELECT id, product_id, mime, data FROM product_images WHERE id = $1', [id])).rows[0];
      return r ? { id: r.id, productId: r.product_id, mime: r.mime, data: r.data } : null;
    },
    async deleteProductImage(id) { await q('DELETE FROM product_images WHERE id = $1', [id]); },

    // --- moderation ---
    async listUsers({ words = [], offset = 0, limit = 30 } = {}) {
      const vals = [];
      const where = words.map((w) => {
        vals.push(`%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        const n = `$${vals.length}`;
        return `(u.name ILIKE ${n} OR u.username ILIKE ${n} OR u.email ILIKE ${n})`;
      });
      vals.push(limit, offset);
      const { rows } = await q(`SELECT u.*, COUNT(*) OVER () AS total,
                                  (SELECT COUNT(*)::int FROM products p WHERE p.user_id = u.id) AS product_count,
                                  (SELECT COUNT(*)::int FROM warnings w WHERE w.user_id = u.id) AS warning_count
                                FROM users u ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                                ORDER BY u.created_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
      return { total: rows.length ? +rows[0].total : 0, items: rows.map((r) => ({ ...toUser(r), productCount: r.product_count, warningCount: r.warning_count })) };
    },
    async addWarning(w) {
      await q('INSERT INTO warnings (id, user_id, admin_id, reason, message, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [w.id, w.userId, w.adminId, w.reason, w.message, w.createdAt]);
    },
    async listWarnings(userId) {
      const { rows } = await q(`SELECT * FROM warnings ${userId ? 'WHERE user_id = $1' : ''} ORDER BY created_at DESC LIMIT 200`, userId ? [userId] : []);
      return rows.map((r) => ({ id: r.id, userId: r.user_id, adminId: r.admin_id, reason: r.reason, message: r.message, createdAt: +r.created_at }));
    },
    async countAll() {
      const r = (await q(`SELECT (SELECT COUNT(*)::int FROM users) AS users, (SELECT COUNT(*)::int FROM users WHERE banned_at IS NOT NULL) AS banned,
                                 (SELECT COUNT(*)::int FROM products) AS products, (SELECT COUNT(*)::int FROM warnings) AS warnings`)).rows[0];
      return { users: r.users, banned: r.banned, products: r.products, warnings: r.warnings };
    },
    async deleteSessionsFor(userId) { await q('DELETE FROM sessions WHERE user_id = $1', [userId]); },
    // Everything owned by the account goes with it (ON DELETE CASCADE); old chat messages stay.
    async deleteUser(id) { await q('DELETE FROM users WHERE id = $1', [id]); },

    // --- visual card index ---
    async listCardFps() {
      return (await q('SELECT id, meta, fp FROM card_fps')).rows.map((r) => ({ ...r.meta, id: r.id, fp: r.fp }));
    },
    async putCardFps(rows) {
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const params = [], values = [];
        chunk.forEach((r, k) => {
          const { id, fp, ...meta } = r;
          values.push(`($${k * 4 + 1}, $${k * 4 + 2}, $${k * 4 + 3}, $${k * 4 + 4})`);
          params.push(id, JSON.stringify(meta), Buffer.from(fp), Date.now());
        });
        await q(`INSERT INTO card_fps (id, meta, fp, updated_at) VALUES ${values.join(',')}
                 ON CONFLICT (id) DO UPDATE SET meta = EXCLUDED.meta, fp = EXCLUDED.fp, updated_at = EXCLUDED.updated_at`, params);
      }
    },

    async getKv(key) { return (await q('SELECT value FROM kv WHERE key = $1', [key])).rows[0]?.value ?? null; },
    async setKv(key, value) {
      await q(`INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, $3)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`, [key, JSON.stringify(value), Date.now()]);
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
