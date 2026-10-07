'use strict';
// Admin panel API (/api/admin/*). Only accounts listed in ADMIN_EMAILS can use it; everyone else
// gets a 404 so the panel's existence isn't advertised.
//
//   • Warnings are saved (with which admin sent them) and delivered to the user's read-only
//     "PokéFolio Admin" conversation in Messages, signed "Admin" — never with the admin's name.
//   • Banning signs the user out everywhere, blocks sign-in, and hides their profile and listings.
//     Unbanning restores everything.
//   • Deleting an account removes it with its collection, listings, friends, avatar and the groups
//     it owns (groups with other members are handed to the longest-standing member instead).
//   • Admins can't ban or delete themselves or other admins.
const crypto = require('crypto');
const { avatarUrl, isAdmin } = require('./auth');

const REASONS = {
  listing: 'Inappropriate listing',
  scam: 'Scam or misleading listing',
  avatar: 'Inappropriate profile picture',
  name: 'Inappropriate name or username',
  bio: 'Inappropriate profile description',
  messages: 'Inappropriate messages',
  spam: 'Spam',
  other: 'Breaking the community rules',
};
const PAGE = 30;
const ID = /^[0-9a-f-]{36}$/;

function createAdminApi({ store, leaderboard, httpError, readBody, send, requireUser, groupsApi, live }) {
  const words = (q) => String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6).map((w) => w.slice(0, 60));
  const offsetOf = (url) => Math.min(100000, Math.max(0, parseInt(url.searchParams.get('offset'), 10) || 0));

  const userRow = (u) => ({
    id: u.id, name: u.name, username: u.username || null, email: u.email, avatar: avatarUrl(u.id, u.avatarAt), bio: u.bio || '',
    createdAt: u.createdAt, bannedAt: u.bannedAt || null, banReason: u.banReason || null, admin: isAdmin(u),
    productCount: u.productCount, warningCount: u.warningCount,
  });
  const productRow = (p) => ({
    id: p.id, title: p.title, price: p.price, description: p.description || '', createdAt: p.createdAt,
    images: (p.imageIds || []).map((iid) => `/api/products/${p.id}/images/${iid}`),
    seller: p.seller ? { id: p.seller.id, name: p.seller.name, username: p.seller.username, avatar: avatarUrl(p.seller.id, p.seller.avatarAt), banned: !!p.seller.banned } : undefined,
  });

  async function target(id, me, { protect = false } = {}) {
    const u = ID.test(id || '') ? await store.getUser(id) : null;
    if (!u) throw httpError(404, 'That account doesn’t exist any more.');
    if (protect && (u.id === me.id || isAdmin(u))) throw httpError(400, 'Admins can’t ban or delete themselves or other admins.');
    return u;
  }

  async function warn(admin, user, reasonKey, note, extra = '') {
    const reason = REASONS[reasonKey] ? reasonKey : 'other';
    const message = String(note || '').replace(/\r\n/g, '\n').trim().slice(0, 1500);
    await store.addWarning({ id: crypto.randomUUID(), userId: user.id, adminId: admin.id, reason, message: [extra, message].filter(Boolean).join('\n'), createdAt: Date.now() });
    const body = [`⚠️ Warning — ${REASONS[reason]}`, extra, message, 'Please follow the community rules. Repeated warnings can lead to your account being banned.']
      .filter(Boolean).join('\n\n');
    await groupsApi.adminMessage(user.id, body);
  }

  // Hand groups the user owns to another member (or let them go with the account).
  async function handOverGroups(userId) {
    for (const g of await store.listUserGroups(userId)) {
      if (g.role !== 'owner' || (g.kind || 'group') !== 'group') continue;
      const next = (await store.listMembers(g.id)).filter((m) => m.userId !== userId).sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (!next) continue;
      await store.updateGroup(g.id, { ownerId: next.userId });
      await store.setMemberRole(g.id, next.userId, 'owner');
    }
  }

  return async function handle(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // api, admin, …
    if (parts[1] !== 'admin') return false;
    const me = await requireUser(req).catch(() => null);
    if (!isAdmin(me)) throw httpError(404, 'Not found.');
    const method = req.method;
    const [, , section, id, action] = parts;

    // GET /api/admin/overview
    if (section === 'overview' && method === 'GET') {
      const [counts, recent] = await Promise.all([store.countAll(), store.listWarnings(null)]);
      const names = new Map();
      for (const w of recent.slice(0, 15)) if (!names.has(w.userId)) names.set(w.userId, await store.getUser(w.userId));
      send(res, 200, {
        counts: { ...counts, online: live.online() }, reasons: REASONS,
        recentWarnings: recent.slice(0, 15).map((w) => ({ ...w, user: names.get(w.userId) ? { id: w.userId, name: names.get(w.userId).name, username: names.get(w.userId).username } : null })),
      });
      return true;
    }

    if (section === 'users') {
      // GET /api/admin/users?q=&offset=
      if (!id && method === 'GET') {
        const offset = offsetOf(url);
        const { items, total } = await store.listUsers({ words: words(url.searchParams.get('q')), offset, limit: PAGE });
        send(res, 200, { total, offset, more: offset + items.length < total, items: items.map(userRow) });
        return true;
      }
      // GET /api/admin/users/:id
      if (id && !action && method === 'GET') {
        const u = await target(id, me);
        const [products, warnings] = await Promise.all([store.listProducts(u.id), store.listWarnings(u.id)]);
        send(res, 200, { user: userRow(u), products: products.map(productRow), warnings });
        return true;
      }
      // POST /api/admin/users/:id/warn { reason, message }
      if (action === 'warn' && method === 'POST') {
        const u = await target(id, me);
        const { reason, message } = await readBody(req);
        await warn(me, u, reason, message);
        send(res, 200, { ok: true });
        return true;
      }
      // POST /api/admin/users/:id/ban { reason } · POST /api/admin/users/:id/unban
      if ((action === 'ban' || action === 'unban') && method === 'POST') {
        const u = await target(id, me, { protect: action === 'ban' });
        if (action === 'ban') {
          const reason = String((await readBody(req)).reason || '').trim().slice(0, 200) || null;
          await store.updateUser(u.id, { bannedAt: Date.now(), banReason: reason });
          await store.deleteSessionsFor(u.id);
          live.kick(u.id, 'banned', { reason });
        } else {
          await store.updateUser(u.id, { bannedAt: null, banReason: null });
        }
        leaderboard.invalidate();
        send(res, 200, { user: userRow(await store.getUser(u.id)) });
        return true;
      }
      // POST /api/admin/users/:id/clear { avatar?: true, bio?: true } — remove offending profile content
      if (action === 'clear' && method === 'POST') {
        const u = await target(id, me);
        const body = await readBody(req);
        if (body.avatar) await store.setAvatar(u.id, null);
        if (body.bio) await store.updateUser(u.id, { bio: '' });
        leaderboard.invalidate();
        send(res, 200, { user: userRow(await store.getUser(u.id)) });
        return true;
      }
      // DELETE /api/admin/users/:id
      if (id && !action && method === 'DELETE') {
        const u = await target(id, me, { protect: true });
        await handOverGroups(u.id);
        live.kick(u.id, 'banned', { deleted: true });
        await store.deleteUser(u.id);
        leaderboard.invalidate();
        send(res, 200, { ok: true });
        return true;
      }
    }

    if (section === 'products') {
      // GET /api/admin/products?q=&offset= — every listing, including banned sellers'
      if (!id && method === 'GET') {
        const offset = offsetOf(url);
        const { items, total } = await store.searchProducts({ words: words(url.searchParams.get('q')), offset, limit: PAGE, includeBanned: true });
        send(res, 200, { total, offset, more: offset + items.length < total, items: items.map(productRow) });
        return true;
      }
      // DELETE /api/admin/products/:id { warn?: true, reason?, message? }
      if (id && method === 'DELETE') {
        const p = ID.test(id) ? await store.getProduct(id) : null;
        if (!p) throw httpError(404, 'That listing doesn’t exist any more.');
        const body = await readBody(req);
        await store.deleteProduct(p.id);
        const owner = await store.getUser(p.userId);
        if (body.warn && owner) await warn(me, owner, body.reason || 'listing', body.message, `Your listing “${p.title}” was removed.`);
        send(res, 200, { ok: true });
        return true;
      }
    }
    throw httpError(404, 'Not found.');
  };
}

module.exports = { createAdminApi, REASONS };
