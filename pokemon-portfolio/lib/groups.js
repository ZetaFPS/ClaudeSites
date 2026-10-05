'use strict';
// Groups: named group chats with invite codes, photos, card shares and a members-only leaderboard.
//
// Access rules
//   • Every group endpoint requires a signed-in member of that group.
//   • Anyone holding the invite code can join; any member can see the code (so anyone can invite).
//   • Only the owner can rename, reset the invite code, remove members or delete the group.
//   • Members can delete their own messages; the owner can delete any message.
//   • Photos are served only to members and only after checking their bytes really are an image.
//   • Shared cards are looked up on the server, so names/prices in the chat can't be faked.
const crypto = require('crypto');

const MAX_GROUPS_PER_USER = 30;
const MAX_MEMBERS = 100;
const MAX_TEXT = 2000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

const newId = () => crypto.randomUUID();
// Invite codes: 8 characters, no look-alikes (0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newInviteCode() {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'image/gif';
  return null;
}

function createGroupsApi({ store, leaderboard, prices, httpError, readBody, send, requireUser, rateLimit }) {
  const limitWrite = rateLimit('message', 40, 60e3);

  const cleanName = (name) => {
    const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!n) throw httpError(400, 'Give the group a name.');
    return n;
  };

  async function membership(groupId, user) {
    const group = await store.getGroup(groupId);
    if (!group) throw httpError(404, 'That group doesn’t exist any more.');
    const member = await store.getMember(groupId, user.id);
    if (!member) throw httpError(403, 'You’re not a member of this group.');
    return { group, member, isOwner: member.role === 'owner' };
  }

  const publicMessage = (m) => ({
    seq: m.seq, kind: m.kind, userId: m.userId, name: m.name, createdAt: m.createdAt,
    body: m.body || '', card: m.card || null,
    image: m.imageId ? `/api/groups/${m.groupId}/images/${m.imageId}` : null,
  });

  async function groupDetails(group, user, member) {
    const members = await store.listMembers(group.id);
    return {
      id: group.id, name: group.name, createdAt: group.createdAt, inviteCode: group.inviteCode,
      ownerId: group.ownerId, myRole: member.role,
      members: members.map((m) => ({ id: m.userId, name: m.name, role: m.role, joinedAt: m.joinedAt, me: m.userId === user.id })),
    };
  }

  // Server-side snapshot of a shared card (name, set, image, current raw price).
  async function cardSnapshot(cardId, variant) {
    if (typeof cardId !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(cardId)) throw httpError(400, 'Unknown card.');
    const card = await prices.getCard(cardId).catch(() => null);
    if (!card) throw httpError(400, 'Couldn’t find that card.');
    const raw = await prices.rawPrice(cardId, typeof variant === 'string' ? variant.slice(0, 40) : null).catch(() => null);
    const img = (u) => { try { const x = new URL(u); return /^(images\.pokemontcg\.io|assets\.tcgdex\.net)$/.test(x.hostname) ? x.href : null; } catch { return null; } };
    return {
      id: card.id, name: card.name, set: card.set?.name || '', number: card.number || '',
      image: img(card.images?.small), imageLarge: img(card.images?.large),
      variant: raw?.variant || variant || null, price: raw?.price ?? null,
    };
  }

  // Returns true when the request was a groups route.
  return async function handle(req, res, url) {
    const path = url.pathname;
    if (!path.startsWith('/api/groups')) return false;
    const method = req.method;
    const user = await requireUser(req);
    const parts = path.split('/').filter(Boolean); // api, groups, :id, …
    const gid = parts[2];

    // GET /api/groups — my groups, newest activity first
    if (parts.length === 2 && method === 'GET') {
      const groups = (await store.listUserGroups(user.id)).map((g) => ({
        id: g.id, name: g.name, role: g.role, memberCount: g.memberCount, unread: g.unread,
        createdAt: g.createdAt,
        last: g.last ? { kind: g.last.kind, body: (g.last.body || '').slice(0, 120), name: g.last.name, createdAt: g.last.createdAt, mine: g.last.userId === user.id } : null,
      })).sort((a, b) => (b.last?.createdAt || b.createdAt) - (a.last?.createdAt || a.createdAt));
      send(res, 200, { groups, unread: groups.reduce((n, g) => n + g.unread, 0) });
      return true;
    }

    // POST /api/groups — create
    if (parts.length === 2 && method === 'POST') {
      limitWrite(req);
      const { name } = await readBody(req);
      if ((await store.countUserGroups(user.id)) >= MAX_GROUPS_PER_USER) throw httpError(400, `You can be in up to ${MAX_GROUPS_PER_USER} groups.`);
      const group = { id: newId(), name: cleanName(name), ownerId: user.id, inviteCode: newInviteCode(), createdAt: Date.now() };
      await store.createGroup(group);
      await store.addMember(group.id, user.id, 'owner', Date.now());
      await store.addMessage({ groupId: group.id, userId: user.id, kind: 'system', body: `${user.name} created the group`, createdAt: Date.now() });
      send(res, 201, { group: await groupDetails(group, user, { role: 'owner' }) });
      return true;
    }

    // POST /api/groups/join — join with an invite code
    if (parts.length === 3 && gid === 'join' && method === 'POST') {
      limitWrite(req);
      const code = String((await readBody(req)).code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const group = code.length === 8 ? await store.getGroupByCode(code) : null;
      if (!group) throw httpError(404, 'That invite code doesn’t match any group. Check it and try again.');
      const existing = await store.getMember(group.id, user.id);
      if (!existing) {
        if ((await store.listMembers(group.id)).length >= MAX_MEMBERS) throw httpError(400, 'That group is full.');
        if ((await store.countUserGroups(user.id)) >= MAX_GROUPS_PER_USER) throw httpError(400, `You can be in up to ${MAX_GROUPS_PER_USER} groups.`);
        await store.addMember(group.id, user.id, 'member', Date.now());
        await store.addMessage({ groupId: group.id, userId: user.id, kind: 'system', body: `${user.name} joined`, createdAt: Date.now() });
      }
      send(res, 200, { group: await groupDetails(group, user, existing || { role: 'member' }), alreadyMember: !!existing });
      return true;
    }

    if (!gid || !/^[0-9a-f-]{36}$/.test(gid)) throw httpError(404, 'Not found.');
    const { group, member, isOwner } = await membership(gid, user);
    const sub = parts[3];

    // GET /api/groups/:id
    if (!sub && method === 'GET') { send(res, 200, { group: await groupDetails(group, user, member) }); return true; }

    // PATCH /api/groups/:id — rename (owner)
    if (!sub && method === 'PATCH') {
      if (!isOwner) throw httpError(403, 'Only the group owner can rename it.');
      const name = cleanName((await readBody(req)).name);
      await store.updateGroup(gid, { name });
      await store.addMessage({ groupId: gid, userId: user.id, kind: 'system', body: `${user.name} renamed the group to “${name}”`, createdAt: Date.now() });
      send(res, 200, { group: await groupDetails({ ...group, name }, user, member) });
      return true;
    }

    // DELETE /api/groups/:id — delete (owner)
    if (!sub && method === 'DELETE') {
      if (!isOwner) throw httpError(403, 'Only the group owner can delete it.');
      await store.deleteGroup(gid);
      send(res, 200, { ok: true });
      return true;
    }

    // POST /api/groups/:id/invite — new invite code (owner); old code stops working
    if (sub === 'invite' && method === 'POST') {
      if (!isOwner) throw httpError(403, 'Only the group owner can reset the invite code.');
      const inviteCode = newInviteCode();
      await store.updateGroup(gid, { inviteCode });
      send(res, 200, { inviteCode });
      return true;
    }

    // POST /api/groups/:id/leave
    if (sub === 'leave' && method === 'POST') {
      if (isOwner) {
        const others = (await store.listMembers(gid)).filter((m) => m.userId !== user.id);
        if (others.length) throw httpError(400, 'You own this group — remove the other members or delete the group instead.');
        await store.deleteGroup(gid);
      } else {
        await store.removeMember(gid, user.id);
        await store.addMessage({ groupId: gid, userId: user.id, kind: 'system', body: `${user.name} left`, createdAt: Date.now() });
      }
      send(res, 200, { ok: true });
      return true;
    }

    // DELETE /api/groups/:id/members/:userId — remove a member (owner)
    if (sub === 'members' && parts[4] && method === 'DELETE') {
      if (!isOwner) throw httpError(403, 'Only the group owner can remove members.');
      if (parts[4] === user.id) throw httpError(400, 'You can’t remove yourself — delete the group instead.');
      const target = (await store.listMembers(gid)).find((m) => m.userId === parts[4]);
      if (!target) throw httpError(404, 'That person isn’t in this group.');
      await store.removeMember(gid, parts[4]);
      await store.addMessage({ groupId: gid, userId: user.id, kind: 'system', body: `${target.name} was removed from the group`, createdAt: Date.now() });
      send(res, 200, { ok: true });
      return true;
    }

    // GET /api/groups/:id/leaderboard
    if (sub === 'leaderboard' && method === 'GET') {
      const members = await store.listMembers(gid);
      send(res, 200, await leaderboard.forUsers(members));
      return true;
    }

    // GET /api/groups/:id/messages?after=&before=&limit=
    if (sub === 'messages' && !parts[4] && method === 'GET') {
      const after = Math.max(0, parseInt(url.searchParams.get('after'), 10) || 0);
      const beforeRaw = parseInt(url.searchParams.get('before'), 10);
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 50));
      const msgs = await store.listMessages(gid, { after, before: Number.isFinite(beforeRaw) ? beforeRaw : null, limit });
      if (msgs.length) await store.setLastRead(gid, user.id, msgs[msgs.length - 1].seq);
      send(res, 200, { messages: msgs.map(publicMessage) });
      return true;
    }

    // POST /api/groups/:id/messages — { text } | { kind: 'card', cardId, variant, text? } | { kind: 'image', image: dataURL, text? }
    if (sub === 'messages' && !parts[4] && method === 'POST') {
      limitWrite(req);
      const body = await readBody(req);
      const text = typeof body.text === 'string' ? body.text.replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT) : '';
      const msg = { groupId: gid, userId: user.id, kind: 'text', body: text, createdAt: Date.now() };
      if (body.kind === 'card') {
        msg.kind = 'card';
        msg.card = await cardSnapshot(body.cardId, body.variant);
      } else if (body.kind === 'image') {
        const m = String(body.image || '').match(/^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=]+)$/);
        if (!m) throw httpError(400, 'That photo couldn’t be read.');
        const data = Buffer.from(m[2], 'base64');
        if (data.length > MAX_IMAGE_BYTES) throw httpError(413, 'That photo is too large (3 MB max).');
        const mime = sniffImage(data);
        if (!mime) throw httpError(400, 'Only JPEG, PNG, WebP or GIF photos can be sent.');
        const imageId = newId();
        await store.addImage({ id: imageId, groupId: gid, mime, data, createdAt: Date.now() });
        msg.kind = 'image';
        msg.imageId = imageId;
      } else if (!text) {
        throw httpError(400, 'Type a message first.');
      }
      const saved = await store.addMessage(msg);
      await store.setLastRead(gid, user.id, saved.seq);
      send(res, 201, { message: publicMessage({ ...saved, name: user.name }) });
      return true;
    }

    // DELETE /api/groups/:id/messages/:seq — own message, or any message for the owner
    if (sub === 'messages' && parts[4] && method === 'DELETE') {
      const seq = parseInt(parts[4], 10);
      const m = Number.isFinite(seq) ? await store.getMessage(gid, seq) : null;
      if (!m || m.kind === 'system') throw httpError(404, 'Message not found.');
      if (m.userId !== user.id && !isOwner) throw httpError(403, 'You can only delete your own messages.');
      await store.deleteMessage(gid, seq);
      send(res, 200, { ok: true });
      return true;
    }

    // GET /api/groups/:id/images/:imageId — members only
    if (sub === 'images' && parts[4] && method === 'GET') {
      const img = await store.getImage(parts[4]);
      if (!img || img.groupId !== gid) throw httpError(404, 'Photo not found.');
      res.writeHead(200, {
        'Content-Type': img.mime,
        'Content-Length': img.data.length,
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      });
      res.end(img.data);
      return true;
    }

    throw httpError(404, 'Not found.');
  };
}

module.exports = { createGroupsApi };
