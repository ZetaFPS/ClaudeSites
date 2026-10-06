'use strict';
const { avatarUrl } = require('./auth');
// Leaderboard of collection values.
//
// Values are recomputed on the server from its own market prices — never from the prices a
// browser saved — so nobody can climb the board by editing their data. Only display names,
// totals and each collector's five most valuable cards are public; emails never are. Users can
// hide themselves (showOnLeaderboard = false).

const MAX_ITEMS_PER_USER = 3000;
const FRESH_MS = 15 * 60e3; // full recompute at most every 15 min…
const DIRTY_MS = 30e3; // …or 30 s after someone changed their collection

const IMAGE_HOSTS = new Set(['images.pokemontcg.io', 'assets.tcgdex.net']);
function safeImage(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && IMAGE_HOSTS.has(x.hostname) ? x.href : null; } catch { return null; }
}

function createLeaderboard(store, prices) {
  let cache = null;
  let computing = null;
  let dirty = true;
  let force = false;

  async function mapLimit(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }));
  }

  async function compute() {
    dirty = false;
    force = false;
    const rows = (await store.listPortfolios()).filter((r) => Array.isArray(r.doc?.items) && r.doc.items.length);

    // Price every distinct card once.
    const keys = new Map();
    for (const r of rows) {
      for (const it of r.doc.items.slice(0, MAX_ITEMS_PER_USER)) {
        if (typeof it?.cardId !== 'string' || it.cardId.length > 80) continue;
        const k = `${it.cardId}|${it.variant || ''}`;
        if (!keys.has(k)) keys.set(k, { id: it.cardId, variant: it.variant || null });
      }
    }
    await prices.primeCards([...new Set([...keys.values()].map((k) => k.id))]).catch(() => {});
    const priced = new Map(); // key -> number | null (no price) ; missing = lookup failed
    await mapLimit([...keys.entries()], 6, async ([k, { id, variant }]) => {
      try { priced.set(k, (await prices.rawPrice(id, variant)).price ?? null); } catch { /* upstream down */ }
    });

    const entries = rows.map((r) => {
      let value = 0, cards = 0;
      const byCard = [];
      for (const it of r.doc.items.slice(0, MAX_ITEMS_PER_USER)) {
        const qty = Math.max(1, Math.min(999, Math.floor(+it.qty) || 1));
        const k = `${it.cardId}|${it.variant || ''}`;
        // If a price lookup failed outright (service down), fall back to the saved price,
        // capped so a tampered value can't dominate.
        let unit = priced.has(k) ? priced.get(k) : Math.min(+it.rawPrice || 0, 500);
        unit = Number.isFinite(unit) ? unit : 0;
        value += unit * qty;
        cards += qty;
        byCard.push({ id: it.cardId, variant: it.variant || null, qty, price: unit });
      }
      byCard.sort((a, b) => b.price - a.price);
      return {
        id: r.userId, name: r.name, avatar: avatarUrl(r.userId, r.avatarAt), hidden: !r.showOnLeaderboard,
        value: Math.round(value * 100) / 100, cards, top: byCard.slice(0, 5),
      };
    }).sort((a, b) => b.value - a.value);

    // Card names/images for the top cards come from the server's own card data (already
    // cached by the price lookups), not from what users saved.
    await mapLimit(entries.flatMap((e) => e.top), 6, async (t) => {
      const c = await prices.getCard(t.id).catch(() => null);
      Object.assign(t, {
        name: c?.name || 'Unknown card', set: c?.set?.name || '', number: c?.number || '',
        image: safeImage(c?.images?.small), imageLarge: safeImage(c?.images?.large),
      });
    });

    const visible = entries.filter((e) => !e.hidden);
    visible.forEach((e, i) => { e.rank = i + 1; });
    cache = { computedAt: Date.now(), entries: visible, all: new Map(entries.map((e) => [e.id, e])), total: visible.length };
    return cache;
  }

  async function get() {
    const age = cache ? Date.now() - cache.computedAt : Infinity;
    if (!cache || force || age > FRESH_MS || (dirty && age > DIRTY_MS)) {
      if (!computing) computing = compute().finally(() => { computing = null; });
      if (!cache) return computing;
      // Serve the previous board while a fresh one computes, unless it's quick.
      await Promise.race([computing, new Promise((r) => setTimeout(r, 4000))]).catch(() => {});
    }
    return cache;
  }

  // Collection edits: refresh soon (throttled). Visibility/name changes: refresh right away.
  function markDirty() { dirty = true; }
  function invalidate() { force = true; }

  // Public view of the board, plus the caller's own position.
  async function view(userId, limit = 100) {
    const lb = await get();
    const mine = userId ? lb.all.get(userId) : null;
    return {
      computedAt: lb.computedAt,
      total: lb.total,
      entries: lb.entries.slice(0, limit).map(({ hidden, ...e }) => e),
      me: mine ? { id: mine.id, rank: mine.hidden ? null : mine.rank, value: mine.value, cards: mine.cards, hidden: mine.hidden } : null,
    };
  }

  // Leaderboard limited to a set of users (a group). Everyone in the group is included —
  // joining a group means sharing your collection value with its members.
  async function forUsers(members) {
    const lb = await get();
    const entries = members.map((m) => {
      const e = lb.all.get(m.userId);
      return { id: m.userId, name: m.name, avatar: avatarUrl(m.userId, m.avatarAt), value: e?.value || 0, cards: e?.cards || 0, top: e?.top || [] };
    }).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    entries.forEach((e, i) => { e.rank = i + 1; });
    return { computedAt: lb.computedAt, total: entries.length, entries };
  }

  return { view, forUsers, markDirty, invalidate };
}

module.exports = { createLeaderboard };
