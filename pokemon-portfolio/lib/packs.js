'use strict';
// Booster pack simulator: builds a random pack for any English set from the card catalogue, with
// the slot structure of that set's real booster packs and published (or typical) pull rates.
// Just for fun — opened cards are never added to anyone's collection.
//
// Accuracy rules:
//   • A pack always has exactly the number of cards its format says (computed from its slots).
//   • Packs are only built from real rarity data. Newly released sets sometimes arrive without
//     rarities; those are fetched card by card from TCGdex first (and saved). If they still
//     aren't available, the set can't be opened rather than producing wrong packs.
//   • Subsets that the card database lists as separate sets (Shiny Vault, Trainer Gallery,
//     Galarian Gallery, Classic Collection) are merged into their parent set's packs, in the slot
//     and at the rate they really appear.

const { liteCard } = require('./catalog');

const TCGDEX = 'https://api.tcgdex.net/v2/en';
const UA = 'Mozilla/5.0 (compatible; PokeFolio/2.5)';

/* ---------------- rarity tiers ---------------- */
//   C common · U uncommon · R rare · H holo rare · X ex/GX/V/Double/Ultra Rare…
//   I Illustration Rare / Trainer Gallery / shiny / radiant… · S Special Illustration Rare /
//   Futuristic / RGB · HR hyper / secret / rainbow / gold (incl. EX-era Gold Stars)
//   PK 30th Celebration "Pikachu Rare" · P promo · ? unknown (no rarity data)
function tierOf(rarity) {
  const r = String(rarity || '').toLowerCase().trim();
  if (!r || r === 'none') return '?';
  if (r === 'common') return 'C';
  if (r === 'uncommon') return 'U';
  if (r === 'promo' || /black star promo/.test(r)) return 'P';
  if (/pikachu/.test(r)) return 'PK';
  if (/special illustration|\brgb\b|futuristic/.test(r)) return 'S';
  if (/hyper rare|secret|rainbow|gold|holo star|black.?white rare|shiny ultra|rare shiny gx/.test(r)) return 'HR';
  if (/illustration rare|trainer gallery|galarian gallery|shiny rare|rare shiny|radiant|amazing|classic collection/.test(r)) return 'I';
  if (/^(rare holo|holo rare|rare holo star|rare shining|rare holo 1st edition|holo)$/.test(r)) return 'H';
  if (r === 'rare' || r === 'rare non-holo') return 'R';
  if (/double rare|ultra rare|rare ultra|full art|\b(ex|gx|v|vmax|vstar|lv\.?x|break|prime|legend|star)\b|ace spec|prism/.test(r)) return 'X';
  if (/rare/.test(r)) return 'X';
  return 'C';
}

/* ---------------- pack formats ---------------- */
// slots: [{ w: {tier: weight}, n: count, reverse?, foil?, rare? }] — w picks a tier from those
// present in the set. "SUB" is the set's merged subset (see SUBSETS).
const F = {
  wotc: {
    era: 'WotC', note: '11 cards: 7 commons, 3 uncommons and 1 rare (about 1 in 3 rares is holo)',
    slots: [{ w: { C: 1 }, n: 7 }, { w: { U: 1 }, n: 3 }, { w: { R: 2, H: 1, X: 0.1 }, n: 1, rare: true }],
  },
  ecard: {
    era: 'e-Card', note: '9 cards: 5 commons, 2 uncommons, 1 reverse holo (any rarity) and 1 rare (about 1 in 3 holo)',
    slots: [{ w: { C: 1 }, n: 5 }, { w: { U: 1 }, n: 2 }, { w: { C: 6, U: 3, R: 1, H: 0.3 }, n: 1, reverse: true }, { w: { R: 2, H: 1, X: 0.1 }, n: 1, rare: true }],
  },
  ex: {
    era: 'EX', note: '9 cards: 5 commons, 2 uncommons, 1 reverse holo and 1 rare (holo, ex or Gold Star chance)',
    slots: [{ w: { C: 1 }, n: 5 }, { w: { U: 1 }, n: 2 }, { w: { C: 6, U: 3, R: 1 }, n: 1, reverse: true }, { w: { R: 6, H: 3, X: 1, HR: 0.12 }, n: 1, rare: true }],
  },
  modern: {
    era: 'Diamond & Pearl – Sword & Shield', note: '10 cards: 5 commons, 3 uncommons, 1 reverse holo and 1 rare or better (plus a code card)',
    slots: [{ w: { C: 1 }, n: 5 }, { w: { U: 1 }, n: 3 }, { w: { C: 6, U: 3, R: 1, I: 0.4 }, n: 1, reverse: true }, { w: { R: 58, H: 25, X: 14, HR: 1.9 }, n: 1, rare: true }],
  },
  sv: {
    era: 'Scarlet & Violet / Mega Evolution', note: '10 cards: 4 commons, 3 uncommons, 2 holo slots (the 2nd can be an Illustration Rare or better) and 1 rare or better (plus a basic Energy and code card)',
    slots: [{ w: { C: 1 }, n: 4 }, { w: { U: 1 }, n: 3 }, { w: { C: 6, U: 3, R: 1 }, n: 1, reverse: true },
      { w: { C: 5.4, U: 2.7, R: 0.9, I: 0.85, S: 0.12 }, n: 1, reverse: true }, { w: { R: 72, X: 24, HR: 0.6 }, n: 1, rare: true }],
  },
  celebrations: {
    era: 'Celebrations', note: '4 holo cards: 3 holo rares and a 4th that can be a Classic Collection or V/VMAX card (about 1 in 3 packs)',
    slots: [{ w: { H: 1 }, n: 3, foil: true }, { w: { H: 62, SUB: 30, X: 8 }, n: 1, foil: true, rare: true }],
  },
  cel30: {
    era: '30th Celebration', special: 'cel30',
    note: '5 foil cards: 2 commons/uncommons, a 3rd common/uncommon or an Illustration Rare-or-better hit, 1 Rare Holo or Double Rare ex, and always 1 of the 30 Pikachu — at most one hit per pack (plus a foil Energy and code card)',
    slots: [{ n: 5 }],
  },
};
// Sets with their own structure, by name.
const SPECIAL = [
  [/^30th celebration/i, 'cel30'],
  [/^celebrations$/i, 'celebrations'],
];
// Subsets merged into their parent set, with the chance per pack of one replacing the reverse holo.
const SUBSETS = [
  [/^(.*?)\s*[:\-–]?\s*shiny vault$/i, { 'Hidden Fates': 1 / 3, 'Shining Fates': 1 / 3, default: 1 / 3 }],
  [/^(.*?)\s*[:\-–]?\s*galarian gallery$/i, { default: 0.375 }],
  [/^(.*?)\s*[:\-–]?\s*trainer gallery$/i, { default: 1 / 7 }],
  [/^(.*?)\s*[:\-–]?\s*classic collection$/i, { default: 0 }], // Celebrations: handled by its own format
];
function formatFor(set) {
  const special = SPECIAL.find(([re]) => re.test(set.name));
  let f = special ? F[special[1]] : null;
  if (!f) {
    const d = String(set.released || '');
    if (/e-card/i.test(set.series || '') || (d >= '2002-09' && d < '2003-06')) f = F.ecard;
    else if (d < '2003-06') f = F.wotc;
    else if (d < '2007-05') f = F.ex;
    else if (d < '2023-03') f = F.modern;
    else f = F.sv;
  }
  // A merged subset replaces the reverse holo (or the rare slot) at its real rate.
  if (set.subset && set.subset.rate > 0 && !f.special && f !== F.celebrations) {
    const slots = f.slots.map((s) => ({ ...s, w: { ...s.w } }));
    const rev = slots.find((s) => s.reverse) || slots.find((s) => s.rare);
    const mass = Object.values(rev.w).reduce((a, b) => a + b, 0);
    rev.w.SUB = mass * set.subset.rate / (1 - set.subset.rate);
    f = { ...f, slots, note: `${f.note}; ${set.subset.label} cards replace the reverse holo in about 1 in ${Math.round(1 / set.subset.rate)} packs` };
  }
  return { ...f, size: f.slots.reduce((a, s) => a + s.n, 0) };
}

/* ---------------- helpers ---------------- */
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const HIT = new Set(['X', 'I', 'S', 'HR', 'SUB']);
// Pick a tier by weight among those the set actually has.
function pickTier(weights, pools) {
  const options = Object.entries(weights).filter(([t, w]) => w > 0 && pools[t]?.length);
  const total = options.reduce((a, [, w]) => a + w, 0);
  let x = Math.random() * total;
  for (const [t, w] of options) { x -= w; if (x <= 0) return t; }
  return options.at(-1)?.[0] || null;
}
// If none of a slot's tiers exist in the set, use the nearest one that does (a pack is never short).
const FALLBACK = { C: ['C', 'U', 'R', 'H'], U: ['U', 'C', 'R', 'H'], R: ['R', 'H', 'U', 'C'], H: ['H', 'R', 'X', 'U', 'C'], X: ['X', 'H', 'R'], I: ['I', 'X', 'H'], S: ['S', 'HR', 'I', 'X'], HR: ['HR', 'S', 'X'], SUB: ['SUB', 'H', 'R'] };
function drawSlot(weights, pools, used) {
  let tier = pickTier(weights, pools);
  if (!tier) {
    const want = Object.keys(weights)[0];
    tier = (FALLBACK[want] || ['C', 'U', 'R', 'H', 'X']).find((t) => pools[t]?.length)
      || Object.keys(pools).find((t) => pools[t].length && t !== 'P' && t !== '?');
  }
  if (!tier) return null;
  let c = pick(pools[tier]);
  for (let i = 0; i < 8 && used.has(c.id); i++) c = pick(pools[tier]);
  used.add(c.id);
  return { c, tier };
}

/* ---------------- 30th Celebration ---------------- */
// Published per-pack odds; a pack has at most ONE hit (≈43% of packs are "Pikachu only").
const CEL30_HITS = [
  ['DR', (r) => /double rare/.test(r), 1 / 4, 'X'],
  ['SIR', (r) => /special illustration/.test(r), 1 / 20, 'S'],
  ['IR', (r) => /illustration rare/.test(r), 1 / 6, 'I'],
  ['CC', (r) => /classic collection/.test(r), 1 / 11, 'I'],
  ['FUR', (r) => /futuristic/.test(r), 1 / 103, 'S'],
  ['RGB', (r) => /\brgb\b|black|gold|hyper|secret/.test(r), 1 / 4000, 'S'],
];
function cel30Pools(cards) {
  const g = { PK: [], CU: [], RARE: [], hits: {} };
  for (const c of cards) {
    const r = String(c.rarity || '').toLowerCase();
    // The 30 anniversary Pikachu ("Pikachu Rare") only ever appear in the Pikachu slot.
    // "Pikachu ex" is a normal hit.
    if (/pikachu/.test(r) || (/pikachu/i.test(c.name) && !/\bex\b/i.test(c.name) && !CEL30_HITS.some(([, t]) => t(r)))) { g.PK.push(c); continue; }
    const h = CEL30_HITS.find(([, t]) => t(r));
    if (h) (g.hits[h[0]] ||= []).push(c);
    else if (r === 'common' || r === 'uncommon') g.CU.push(c);
    else if (r) g.RARE.push(c); // "Rare", "Rare Holo", "Holo Rare" …
  }
  return g;
}
function openCel30(cards) {
  const g = cel30Pools(cards);
  const roll = Math.random();
  let acc = 0, hit = null;
  for (const [key, , p] of CEL30_HITS) {
    if (!g.hits[key]?.length) continue;
    acc += p;
    if (roll < acc) { hit = key; break; }
  }
  const used = new Set();
  const draw = (...pools) => {
    const pool = pools.find((p) => p?.length);
    let c = pick(pool);
    for (let i = 0; i < 8 && used.has(c.id); i++) c = pick(pool);
    used.add(c.id);
    return c;
  };
  const tierOfHit = (k) => CEL30_HITS.find(([key]) => key === k)[3];
  const out = [];
  const add = (c, tier, extra = {}) => out.push({ c, pull: { tier, foil: true, hit: HIT.has(tier), ...extra } });
  const slot3 = hit && hit !== 'DR' ? hit : null;
  add(draw(g.CU, g.RARE), 'C');
  add(draw(g.CU, g.RARE), 'C');
  if (!slot3) add(draw(g.CU, g.RARE), 'C');
  add(draw(g.PK, g.RARE), 'H', { pikachu: true });
  if (hit === 'DR') add(draw(g.hits.DR), 'X', { rare: true });
  else add(draw(g.RARE, g.CU), 'H', { rare: true });
  if (slot3) add(draw(g.hits[slot3]), tierOfHit(slot3), { rare: true }); // the hit is revealed last
  return out;
}

/* ---------------- fetching missing rarities (TCGdex) ---------------- */
async function getJson(url, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`TCGdex responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
async function mapLimit(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
const normNum = (n) => String(n || '').toLowerCase().replace(/^0+(?=\d)/, '');

function createPacks({ catalog, log = console }) {
  let setsCache = null;
  const preparing = new Map(); // setId -> promise
  const prepError = new Map(); // setId -> message
  let dexSets = null;
  const rank = (c) => ({ S: 7, HR: 6, I: 5, X: 4, H: 3, R: 2 }[tierOf(c.rarity)] || 0);

  function build() {
    const cards = catalog.peek('en');
    if (!cards) return null;
    if (setsCache?.from === cards) return setsCache;
    const groups = new Map();
    for (const c of cards) {
      if (!groups.has(c.setId)) groups.set(c.setId, []);
      groups.get(c.setId).push(c);
    }
    // Merge subsets into their parent set.
    const byName = new Map([...groups].map(([id, cs]) => [norm(cs[0].setName), id]));
    const subsetOf = new Map(); // parentId -> { cards, rate, label }
    for (const [id, cs] of [...groups]) {
      for (const [re, rates] of SUBSETS) {
        const m = cs[0].setName.match(re);
        if (!m || !m[1]) continue;
        const parent = byName.get(norm(m[1]));
        if (!parent || parent === id || !groups.has(parent)) continue;
        const parentName = groups.get(parent)[0].setName;
        const label = cs[0].setName.slice(m[1].length).replace(/^[\s:\-–]+/, '') || 'Subset';
        subsetOf.set(parent, { cards: cs, rate: rates[parentName] ?? rates.default, label });
        groups.delete(id);
        break;
      }
    }
    const list = [];
    const byId = new Map();
    for (const [id, cs] of groups) {
      const s0 = cs[0];
      const tiers = cs.map((c) => tierOf(c.rarity));
      const promo = tiers.filter((t) => t === 'P').length / cs.length;
      const cu = tiers.filter((t) => t === 'C' || t === 'U' || t === '?').length;
      const special = SPECIAL.some(([re]) => re.test(s0.setName));
      // Booster sets only: no promo sets, trainer kits, McDonald's sets, or tiny sets.
      if (promo > 0.5 || /trainer kit|mcdonald|futsal|promo|energies|pop series/i.test(s0.setName) || (cu < 8 && !special)) continue;
      const set = { id, name: s0.setName, series: s0.series, released: s0.released, subset: subsetOf.get(id) || null };
      set.format = formatFor(set);
      const chase = [...cs].sort((a, b) => rank(b) - rank(a)).find((c) => c.img);
      Object.assign(set, { cards: cs.length, logo: `https://images.pokemontcg.io/${id}/logo.png`, art: chase?.alt || chase?.img || null });
      list.push(set);
      byId.set(id, { set, cards: cs });
    }
    list.sort((a, b) => String(b.released).localeCompare(String(a.released)) || a.name.localeCompare(b.name));
    setsCache = { list, byId, from: cards };
    return setsCache;
  }

  const allCards = (entry) => (entry.set.subset ? entry.cards.concat(entry.set.subset.cards) : entry.cards);
  const missingShare = (cards) => cards.filter((c) => tierOf(c.rarity) === '?').length / cards.length;

  // Fill in rarities for a set whose cards came without them, from TCGdex (same set, matched by
  // name, then each card by number). Saved into the catalogue.
  function prepare(entry) {
    const { set } = entry;
    const all = allCards(entry);
    if (missingShare(all) <= 0.05) return null;
    if (preparing.has(set.id)) return preparing.get(set.id);
    const p = (async () => {
      try {
        dexSets ||= await getJson(`${TCGDEX}/sets`, 20000);
        const want = norm(set.name);
        const dex = dexSets.find((s) => norm(s.name) === want) || dexSets.find((s) => norm(s.id) === norm(set.id));
        if (!dex) throw new Error('set not found on TCGdex');
        const detail = await getJson(`${TCGDEX}/sets/${encodeURIComponent(dex.id)}`, 20000);
        const rarityByNum = new Map();
        await mapLimit(detail.cards || [], 6, async (b) => {
          const full = await getJson(`${TCGDEX}/cards/${encodeURIComponent(b.id)}`).catch(() => null);
          if (full?.rarity) rarityByNum.set(normNum(b.localId), full.rarity);
        });
        let filled = 0;
        for (const c of all) {
          if (tierOf(c.rarity) !== '?') continue;
          const r = rarityByNum.get(normNum(c.number));
          if (r) { c.rarity = r; filled++; }
        }
        if (filled) await catalog.persist?.('en');
        if (missingShare(all) > 0.05) throw new Error('rarities still missing');
        prepError.delete(set.id);
      } catch (e) {
        prepError.set(set.id, e.message);
        log.warn?.(`packs: couldn't get rarities for ${set.name}: ${e.message}`);
      } finally {
        preparing.delete(set.id);
      }
    })();
    preparing.set(set.id, p);
    return p;
  }

  // Cards in the order they're revealed: commons first, the rare (or hit) last.
  function open(setId) {
    const s = build();
    if (!s) return { loading: true };
    const entry = s.byId.get(setId);
    if (!entry) return { error: 'unknown set' };
    const { set } = entry;
    if (missingShare(allCards(entry)) > 0.05) {
      if (prepError.has(set.id) && !preparing.has(set.id)) return { error: 'no-rarities' };
      prepare(entry);
      return { preparing: true };
    }
    const head = { id: set.id, name: set.name, released: set.released, logo: set.logo, format: { era: set.format.era, size: set.format.size, note: set.format.note } };
    if (set.format.special === 'cel30') return { set: head, cards: openCel30(entry.cards).map(({ c, pull }) => ({ ...liteCard(c), pull })) };
    const pools = {};
    for (const c of entry.cards) (pools[tierOf(c.rarity)] ||= []).push(c);
    if (set.subset) pools.SUB = set.subset.cards;
    const used = new Set();
    const out = [];
    for (const slot of set.format.slots) {
      for (let k = 0; k < slot.n; k++) {
        const d = drawSlot(slot.w, pools, used);
        if (!d) continue;
        const sub = d.tier === 'SUB';
        const tier = sub ? (['S', 'HR', 'X'].includes(tierOf(d.c.rarity)) ? tierOf(d.c.rarity) : 'I') : d.tier;
        out.push({
          ...liteCard(d.c),
          pull: {
            tier, reverse: !!slot.reverse && ['C', 'U', 'R', 'H'].includes(d.tier), foil: !!slot.foil,
            hit: HIT.has(tier) || (slot.rare && tier === 'H'), rare: !!slot.rare, subset: sub ? set.subset.label : undefined,
          },
        });
      }
    }
    return { set: head, cards: out };
  }

  // What a set's packs contain, plus how many cards the set has of each rarity.
  function info(setId) {
    const s = build();
    if (!s) return { loading: true };
    const entry = s.byId.get(setId);
    if (!entry) return { error: 'unknown set' };
    const all = allCards(entry);
    const rarities = {};
    for (const c of all) rarities[c.rarity || 'Unknown'] = (rarities[c.rarity || 'Unknown'] || 0) + 1;
    const needs = missingShare(all) > 0.05;
    if (needs && !(prepError.has(setId) && !preparing.has(setId))) prepare(entry);
    return {
      ready: !needs, preparing: preparing.has(setId), error: needs && prepError.has(setId) && !preparing.has(setId) ? 'no-rarities' : null,
      size: entry.set.format.size, era: entry.set.format.era, note: entry.set.format.note, rarities,
      subset: entry.set.subset ? { label: entry.set.subset.label, cards: entry.set.subset.cards.length } : null,
    };
  }

  return {
    list: () => { const s = build(); return s ? s.list.map(({ format, subset, ...x }) => ({ ...x, era: format.era, size: format.size, note: format.note })) : null; },
    open, info,
  };
}

module.exports = { createPacks, tierOf, formatFor };
