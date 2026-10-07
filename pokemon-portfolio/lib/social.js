'use strict';
// Profiles, friends, direct messages and each collector's store.
//
// Access rules
//   • Profiles (name, @username, picture, bio, store) are public, like the leaderboard.
//   • Collection value and top cards follow the leaderboard setting; the FULL collection is shown
//     only when its owner turns on "Show my whole collection" (showCollection).
//   • Friend requests need a username (or a profile button); a request to someone who already asked
//     you just accepts theirs. Either side can cancel, decline or unfriend.
//   • Direct messages are two-person chats that only friends can start or post in; they reuse the
//     group chat (lib/groups.js) for messages, photos and card shares.
//   • Store listings are adverts only — there's no checkout. Buyers add the seller and chat.
//     Only the owner can add, edit or delete their listings; pictures are checked to be real images.
const crypto = require('crypto');
const { avatarUrl, checkUsername } = require('./auth');
const { sniffImage } = require('./groups');

const MAX_PRODUCTS = 60;
const MAX_PRODUCT_IMAGES = 6;
const MAX_PRODUCT_IMAGE_BYTES = 1.2 * 1024 * 1024; // six of these still fit in one request
const MAX_FRIENDS = 500;
const COLLECTION_PAGE = 60;

const newId = () => crypto.randomUUID();
const ID = /^[0-9a-f-]{36}$/;
const IMAGE_HOSTS = /^(images\.pokemontcg\.io|assets\.tcgdex\.net|tcgplayer-cdn\.tcgplayer\.com)$/;
const safeImage = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && IMAGE_HOSTS.test(x.hostname) ? x.href : null; } catch { return null; } };

function createSocialApi({ store, leaderboard, prices, httpError, readBody, send, requireUser, optionalUser, rateLimit }) {
  const limitWrite = rateLimit('friend/store', 60, 60e3);
  const limitUpload = rateLimit('listing upload', 30, 15 * 60e3);

  const card = (u) => u && { id: u.id, name: u.name, username: u.username || null, avatar: avatarUrl(u.id, u.avatarAt) };

  async function relation(me, otherId) {
    if (!me) return 'none';
    if (me.id === otherId) return 'self';
    const f = await store.getFriendship(me.id, otherId);
    if (!f) return 'none';
    if (f.status === 'accepted') return 'friends';
    return f.requester === me.id ? 'outgoing' : 'incoming';
  }

  const publicProduct = (p, seller) => ({
    id: p.id, title: p.title, price: p.price, description: p.description || '', createdAt: p.createdAt, updatedAt: p.updatedAt,
    images: (p.imageIds || []).map((iid) => `/api/products/${p.id}/images/${iid}`),
    seller: seller ? card(seller) : undefined,
  });

  // Cleaned listing fields from a request body.
  function listingFields(body) {
    const title = String(body.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!title) throw httpError(400, 'Give your listing a title.');
    const description = String(body.description ?? '').replace(/\r\n/g, '\n').trim().slice(0, 2000);
    const price = Math.round(Number(body.price) * 100) / 100;
    if (body.price === '' || body.price == null || !Number.isFinite(price) || price < 0 || price > 1e7) throw httpError(400, 'Enter a price (0 or more).');
    return { title, description, price };
  }
  // New pictures arrive as data URLs; existing ones by their id. Returns the new ordered id list.
  async function savePictures(productId, list, existing = []) {
    if (!Array.isArray(list) || !list.length) throw httpError(400, 'Add at least one picture.');
    if (list.length > MAX_PRODUCT_IMAGES) throw httpError(400, `Up to ${MAX_PRODUCT_IMAGES} pictures per listing.`);
    const fresh = [];
    for (const item of list) {
      if (typeof item === 'string' && existing.includes(item)) continue;
      const m = typeof item === 'string' && item.match(/^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/);
      if (!m) throw httpError(400, 'One of the pictures couldn’t be read.');
      const data = Buffer.from(m[1], 'base64');
      if (data.length > MAX_PRODUCT_IMAGE_BYTES) throw httpError(413, 'A picture is too large.');
      const mime = sniffImage(data);
      if (!mime || mime === 'image/gif') throw httpError(400, 'Use JPEG, PNG or WebP pictures.');
      fresh.push({ item, mime, data });
    }
    const ids = [];
    for (const item of list) {
      if (typeof item === 'string' && existing.includes(item)) { ids.push(item); continue; }
      const f = fresh.shift();
      const id = newId();
      await store.addProductImage({ id, productId, mime: f.mime, data: f.data });
      ids.push(id);
    }
    for (const old of existing) if (!ids.includes(old)) await store.deleteProductImage(old);
    return ids;
  }

  async function ownedProduct(id, user) {
    const p = ID.test(id || '') ? await store.getProduct(id) : null;
    if (!p) throw httpError(404, 'That listing doesn’t exist any more.');
    if (p.userId !== user.id) throw httpError(403, 'Only the seller can change this listing.');
    return p;
  }

  async function friendsView(user) {
    const rows = await store.listFriendships(user.id);
    const out = { friends: [], incoming: [], outgoing: [] };
    for (const f of rows) {
      const o = { ...card({ ...f.other, avatarAt: f.other.avatarAt }), since: f.createdAt };
      if (f.status === 'accepted') out.friends.push(o);
      else (f.requester === user.id ? out.outgoing : out.incoming).push(o);
    }
    out.friends.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  // The two-person chat between friends (created the first time either opens it).
  async function dmWith(user, otherId) {
    const f = await store.getFriendship(user.id, otherId);
    if (f?.status !== 'accepted') throw httpError(403, 'Add each other as friends to chat.');
    const key = [user.id, otherId].sort().join('|');
    let g = await store.getGroupByDmKey(key);
    if (!g) {
      g = { id: newId(), name: '', ownerId: user.id, inviteCode: `DM${crypto.randomBytes(12).toString('hex')}`, createdAt: Date.now(), kind: 'dm', dmKey: key };
      try {
        await store.createGroup(g);
        await store.addMember(g.id, user.id, 'member', Date.now());
        await store.addMember(g.id, otherId, 'member', Date.now());
      } catch (e) {
        // Both opened it at the same moment: use the one that won.
        const won = await store.getGroupByDmKey(key);
        if (!won) throw e;
        g = won;
      }
    }
    return g;
  }

  return async function handle(req, res, url) {
    const path = url.pathname;
    const method = req.method;
    const parts = path.split('/').filter(Boolean);

    /* ---------- users & profiles ---------- */
    if (parts[1] === 'users') {
      // GET /api/users/lookup?username=ash
      if (parts[2] === 'lookup' && parts.length === 3 && method === 'GET') {
        let username;
        try { username = checkUsername(url.searchParams.get('username')); } catch { throw httpError(404, 'No collector with that username.'); }
        const u = await store.getUserByUsername(username);
        if (!u) throw httpError(404, 'No collector with that username.');
        send(res, 200, { user: card(u) });
        return true;
      }
      const uid = parts[2];
      if (!ID.test(uid || '')) throw httpError(404, 'Not found.');
      const target = await store.getUser(uid);
      if (!target) throw httpError(404, 'That collector doesn’t exist any more.');
      const me = await optionalUser(req);
      const self = me?.id === uid;

      // GET /api/users/:id — profile
      if (parts.length === 3 && method === 'GET') {
        const e = await leaderboard.entryFor(uid);
        const showStats = self || target.showOnLeaderboard !== false || target.showCollection === true;
        const products = (await store.listProducts(uid)).map((p) => publicProduct(p));
        send(res, 200, {
          user: { ...card(target), bio: target.bio || '', createdAt: target.createdAt },
          relation: await relation(me, uid),
          showCollection: target.showCollection === true,
          stats: showStats && e ? { value: e.value, cards: e.cards, rank: e.hidden ? null : e.rank || null, top: e.top } : null,
          products,
        });
        return true;
      }

      // GET /api/users/:id/collection?offset=0 — the whole collection, if its owner shares it
      if (parts[3] === 'collection' && method === 'GET') {
        if (!self && target.showCollection !== true) throw httpError(403, 'This collector keeps their full collection private.');
        const all = await leaderboard.cardsFor(uid);
        const offset = Math.max(0, parseInt(url.searchParams.get('offset'), 10) || 0);
        const page = all.slice(offset, offset + COLLECTION_PAGE);
        const items = await Promise.all(page.map(async (it) => {
          const c = await prices.getCard(it.id).catch(() => null);
          return {
            id: it.id, variant: it.variant, qty: it.qty, price: it.price,
            name: c?.name || 'Unknown card', set: c?.set?.name || '', number: c?.number || '', rarity: c?.rarity || '',
            image: safeImage(c?.images?.small),
          };
        }));
        send(res, 200, { total: all.length, offset, items, more: offset + page.length < all.length });
        return true;
      }
      throw httpError(404, 'Not found.');
    }

    /* ---------- friends ---------- */
    if (parts[1] === 'friends') {
      const user = await requireUser(req);
      // GET /api/friends
      if (parts.length === 2 && method === 'GET') { send(res, 200, await friendsView(user)); return true; }
      // POST /api/friends { username } | { userId } — send a request (or accept theirs)
      if (parts.length === 2 && method === 'POST') {
        limitWrite(req);
        const body = await readBody(req);
        let other;
        if (typeof body.userId === 'string' && ID.test(body.userId)) other = await store.getUser(body.userId);
        else {
          let username;
          try { username = checkUsername(body.username); } catch { throw httpError(404, 'No collector with that username.'); }
          other = await store.getUserByUsername(username);
        }
        if (!other) throw httpError(404, 'No collector with that username.');
        if (other.id === user.id) throw httpError(400, 'That’s you!');
        const f = await store.getFriendship(user.id, other.id);
        let status;
        if (f?.status === 'accepted') status = 'friends';
        else if (f && f.requester === other.id) {
          await store.putFriendship({ ...f, status: 'accepted', createdAt: Date.now() });
          status = 'friends';
        } else if (f) status = 'outgoing';
        else {
          if ((await store.listFriendships(user.id)).length >= MAX_FRIENDS) throw httpError(400, `You can have up to ${MAX_FRIENDS} friends and requests.`);
          await store.putFriendship({ requester: user.id, addressee: other.id, status: 'pending', createdAt: Date.now() });
          status = 'outgoing';
        }
        send(res, 200, { status, user: card(other) });
        return true;
      }
      const oid = parts[2];
      if (!ID.test(oid || '')) throw httpError(404, 'Not found.');
      // POST /api/friends/:id/accept
      if (parts[3] === 'accept' && method === 'POST') {
        const f = await store.getFriendship(user.id, oid);
        if (!f || f.addressee !== user.id) throw httpError(404, 'That friend request was withdrawn.');
        if (f.status !== 'accepted') await store.putFriendship({ ...f, status: 'accepted', createdAt: Date.now() });
        send(res, 200, { status: 'friends' });
        return true;
      }
      // DELETE /api/friends/:id — unfriend, decline or cancel
      if (parts.length === 3 && method === 'DELETE') {
        await store.deleteFriendship(user.id, oid);
        send(res, 200, { status: 'none' });
        return true;
      }
      throw httpError(404, 'Not found.');
    }

    /* ---------- direct messages ---------- */
    // POST /api/dm/:userId → { groupId } (the chat itself is a group chat of two)
    if (parts[1] === 'dm' && parts.length === 3 && method === 'POST') {
      const user = await requireUser(req);
      if (!ID.test(parts[2]) || parts[2] === user.id) throw httpError(404, 'Not found.');
      const g = await dmWith(user, parts[2]);
      send(res, 200, { groupId: g.id });
      return true;
    }

    /* ---------- store ---------- */
    if (parts[1] === 'products') {
      const pid = parts[2];
      // GET /api/products/:id/images/:imageId — public
      if (parts[3] === 'images' && parts[4] && method === 'GET') {
        const img = ID.test(parts[4]) ? await store.getProductImage(parts[4]) : null;
        if (!img || img.productId !== pid) throw httpError(404, 'Picture not found.');
        res.writeHead(200, {
          'Content-Type': img.mime, 'Content-Length': img.data.length,
          'Cache-Control': 'public, max-age=31536000, immutable', // ids are never reused
          'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'",
        });
        res.end(img.data);
        return true;
      }
      // GET /api/products/:id
      if (parts.length === 3 && method === 'GET') {
        const p = ID.test(pid || '') ? await store.getProduct(pid) : null;
        if (!p) throw httpError(404, 'That listing doesn’t exist any more.');
        const seller = await store.getUser(p.userId);
        const me = await optionalUser(req);
        send(res, 200, { product: publicProduct(p, seller), relation: await relation(me, p.userId) });
        return true;
      }
      const user = await requireUser(req);
      // POST /api/products { title, price, description, images: [dataURL…] }
      if (parts.length === 2 && method === 'POST') {
        limitUpload(req);
        const body = await readBody(req);
        const fields = listingFields(body);
        if ((await store.listProducts(user.id)).length >= MAX_PRODUCTS) throw httpError(400, `You can list up to ${MAX_PRODUCTS} items.`);
        const p = { id: newId(), userId: user.id, ...fields, imageIds: [], createdAt: Date.now(), updatedAt: Date.now() };
        await store.createProduct(p);
        try {
          p.imageIds = await savePictures(p.id, body.images);
        } catch (e) {
          await store.deleteProduct(p.id);
          throw e;
        }
        await store.updateProduct(p.id, p);
        send(res, 201, { product: publicProduct(p, user) });
        return true;
      }
      // PUT /api/products/:id { title, price, description, images: [existing id | dataURL…] }
      if (parts.length === 3 && method === 'PUT') {
        limitUpload(req);
        const p = await ownedProduct(pid, user);
        const body = await readBody(req);
        const fields = listingFields(body);
        const imageIds = await savePictures(p.id, body.images, p.imageIds || []);
        const updated = await store.updateProduct(p.id, { ...p, ...fields, imageIds, updatedAt: Date.now() });
        send(res, 200, { product: publicProduct(updated, user) });
        return true;
      }
      // DELETE /api/products/:id
      if (parts.length === 3 && method === 'DELETE') {
        await ownedProduct(pid, user);
        await store.deleteProduct(pid);
        send(res, 200, { ok: true });
        return true;
      }
      throw httpError(404, 'Not found.');
    }
    return false;
  };
}

module.exports = { createSocialApi };
