'use strict';
// Booster pack simulator: builds a random pack for any English set, from the card catalogue, with
// the slot structure of that era's real booster packs and approximate pull rates. Just for fun —
// opened cards are never added to anyone's collection.

const { liteCard } = require('./catalog');

// Which pull tier a card's printed rarity belongs to.
//   C common · U uncommon · R rare · H holo rare · X "hit" (ex/GX/V, Double/Ultra Rare…)
//   I illustration-style hit (Illustration Rare, Trainer Gallery, shiny) · S secret/gold/SIR
function tierOf(rarity) {
  const r = String(rarity || '').toLowerCase();
  if (!r || r === 'common') return 'C';
  if (r === 'uncommon') return 'U';
  if (r === 'rare') return 'R';
  if (r === 'promo') return 'P';
  if (/special illustration|hyper|secret|rainbow|shiny ultra|rare shiny gx|gold/.test(r)) return 'S';
  if (/illustration rare|trainer gallery|shiny rare|rare shiny|radiant|amazing|classic collection/.test(r)) return 'I';
  if (r === 'rare holo' || r === 'rare holo star' || r === 'rare shining' || r === 'rare holo 1st edition') return 'H';
  if (/rare/.test(r) || /legend|ace spec|break|prime|prism/.test(r)) return 'X';
  return 'C';
}

// Pack formats by era (release date of the set).
//   slots: [tier weights, count, { reverse }] — weights pick a tier; missing tiers are skipped
function formatFor(released) {
  const d = String(released || '');
  if (d < '2003-06') {
    return {
      era: 'WotC', size: 11, note: '11 cards: 7 commons, 3 uncommons and 1 rare (about 1 in 3 rares is holo)',
      slots: [[{ C: 1 }, 7], [{ U: 1 }, 3], [{ R: 2, H: 1, X: 0.15 }, 1, { rare: true }]],
    };
  }
  if (d < '2007-05') {
    return {
      era: 'EX', size: 9, note: '9 cards: 5 commons, 2 uncommons, 1 reverse holo and 1 rare (holo, ex or gold star chance)',
      slots: [[{ C: 1 }, 5], [{ U: 1 }, 2], [{ C: 6, U: 3, R: 1 }, 1, { reverse: true }], [{ R: 6, H: 3, X: 1, S: 0.15 }, 1, { rare: true }]],
    };
  }
  if (d < '2023-03') {
    return {
      era: 'Modern', size: 10, note: '10 cards: 5 commons, 3 uncommons, 1 reverse holo and 1 rare or better (plus a code card)',
      slots: [[{ C: 1 }, 5], [{ U: 1 }, 3], [{ C: 6, U: 3, R: 1, I: 0.4 }, 1, { reverse: true }], [{ R: 58, H: 25, X: 14, S: 1.9 }, 1, { rare: true }]],
    };
  }
  return {
    era: 'Scarlet & Violet', size: 10, note: '10 cards: 4 commons, 3 uncommons, 2 holo slots (one can be an Illustration Rare) and 1 rare or better (plus a basic Energy and code card)',
    slots: [[{ C: 1 }, 4], [{ U: 1 }, 3], [{ C: 6, U: 3, R: 1 }, 1, { reverse: true }],
      [{ C: 5.4, U: 2.7, R: 0.9, I: 0.85, S: 0.14 }, 1, { reverse: true, hit: true }], [{ R: 72, X: 24, S: 0.6 }, 1, { rare: true }]],
  };
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function pickTier(weights, byTier) {
  const options = Object.entries(weights).filter(([t]) => byTier[t]?.length);
  const total = options.reduce((a, [, w]) => a + w, 0);
  let x = Math.random() * total;
  for (const [t, w] of options) { x -= w; if (x <= 0) return t; }
  return options.at(-1)?.[0] || null;
}

function createPacks({ catalog }) {
  let setsCache = null; // { list, byId, from }

  function sets() {
    const cards = catalog.peek('en');
    if (!cards) return null;
    if (setsCache?.from === cards) return setsCache;
    const groups = new Map();
    for (const c of cards) {
      if (!groups.has(c.setId)) groups.set(c.setId, []);
      groups.get(c.setId).push(c);
    }
    const list = [];
    const byId = new Map();
    for (const [id, cs] of groups) {
      const s0 = cs[0];
      const byTier = {};
      for (const c of cs) (byTier[tierOf(c.rarity)] ||= []).push(c);
      const promo = (byTier.P?.length || 0) / cs.length;
      // Booster sets only: no promo sets, trainer kits, McDonald's sets, or sets too small for packs.
      if (promo > 0.5 || /trainer kit|mcdonald|futsal|promo|energies|pop series/i.test(s0.setName) || (byTier.C?.length || 0) + (byTier.U?.length || 0) < 8) continue;
      // The pack art shows the set's biggest chase card.
      const chase = (byTier.S || byTier.I || byTier.X || byTier.H || byTier.R || cs).find((c) => c.img) || cs.find((c) => c.img);
      const set = {
        id, name: s0.setName, series: s0.series, released: s0.released, cards: cs.length,
        logo: `https://images.pokemontcg.io/${id}/logo.png`, art: chase?.alt || chase?.img || null,
        format: formatFor(s0.released),
      };
      list.push(set);
      byId.set(id, { set, byTier });
    }
    list.sort((a, b) => String(b.released).localeCompare(String(a.released)) || a.name.localeCompare(b.name));
    setsCache = { list, byId, from: cards };
    return setsCache;
  }

  // Cards in the order they're revealed: commons first, the rare (or hit) last.
  function open(setId) {
    const s = sets();
    if (!s) return null;
    const entry = s.byId.get(setId);
    if (!entry) return { error: 'unknown set' };
    const { set, byTier } = entry;
    const out = [];
    const used = new Set();
    for (const [weights, count, opts = {}] of set.format.slots) {
      for (let k = 0; k < count; k++) {
        const tier = pickTier(weights, byTier);
        if (!tier) continue;
        // Avoid duplicates within a pack where the pool allows it.
        let c = pick(byTier[tier]);
        for (let tries = 0; tries < 6 && used.has(c.id); tries++) c = pick(byTier[tier]);
        used.add(c.id);
        const hit = ['X', 'I', 'S'].includes(tier) || (opts.rare && tier === 'H');
        out.push({
          ...liteCard(c),
          pull: { tier, reverse: !!opts.reverse && ['C', 'U', 'R'].includes(tier), hit, rare: !!opts.rare },
        });
      }
    }
    return { set: { id: set.id, name: set.name, released: set.released, logo: set.logo, format: { era: set.format.era, size: set.format.size, note: set.format.note } }, cards: out };
  }

  return {
    list: () => { const s = sets(); return s ? s.list.map(({ format, ...x }) => ({ ...x, era: format.era, size: format.size, note: format.note })) : null; },
    open,
  };
}

module.exports = { createPacks, tierOf, formatFor };
