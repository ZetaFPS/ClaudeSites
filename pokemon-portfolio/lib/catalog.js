'use strict';
// The card catalogue: a lightweight list of every card (name, number, set, rarity, release date,
// picture) — English from the Pokémon TCG API, Japanese from TCGdex. Used by the Index page
// (browse every card, newest set first) and by the scanner's visual index.
//
// Lists are fetched on first use, saved to the store so restarts don't refetch them, and
// refreshed once a day for new sets. Index queries are answered from memory, a page at a time.

const POKEMONTCG = 'https://api.pokemontcg.io/v2';
const TCGDEX = 'https://api.tcgdex.net/v2';
const UA = 'Mozilla/5.0 (compatible; PokeFolio/2.4)';
const DAY = 24 * 3600e3;
const LANGS = ['en', 'ja'];

async function fetchWithTimeout(url, ms = 15000, accept = '*/*') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const headers = { 'User-Agent': UA, Accept: accept };
    if (url.startsWith(POKEMONTCG) && process.env.POKEMONTCG_API_KEY) headers['X-Api-Key'] = process.env.POKEMONTCG_API_KEY;
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
    return res;
  } finally {
    clearTimeout(t);
  }
}
const getJson = async (url, ms) => (await fetchWithTimeout(url, ms, 'application/json')).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, tries = 3, wait = 3000) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries) throw e; await sleep(wait * i); }
  }
}
async function mapLimit(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

/* ---------------- fetching ---------------- */
// English: every card from the Pokémon TCG API, newest sets first.
async function englishCatalog(onProgress) {
  const out = [];
  for (let page = 1; page < 400; page++) {
    const params = new URLSearchParams({ page: String(page), pageSize: '250', orderBy: '-set.releaseDate', select: 'id,name,number,rarity,supertype,images,set' });
    const res = await retry(() => getJson(`${POKEMONTCG}/cards?${params}`, 30000));
    for (const c of res.data || []) {
      out.push({
        id: c.id, lang: 'en', name: c.name, number: c.number, rarity: c.rarity || null, supertype: c.supertype || null,
        setId: c.set?.id, setName: c.set?.name, series: c.set?.series || null, total: c.set?.printedTotal,
        released: String(c.set?.releaseDate || '').replace(/\//g, '-'), code: c.set?.ptcgoCode || null,
        img: c.images?.small || null, alt: c.images?.large || null,
      });
    }
    onProgress?.(out.length, res.totalCount || 0);
    if (!res.data?.length || page * 250 >= (res.totalCount || 0)) break;
  }
  return out;
}
// TCGdex catalogue for one language (Japanese, or English when the Pokémon TCG API is down).
async function tcgdexCatalog(lang, onProgress) {
  const prefix = lang === 'ja' ? 'tcgdexja:' : 'tcgdex:';
  const sets = await retry(() => getJson(`${TCGDEX}/${lang}/sets`, 30000));
  const list = Array.isArray(sets) ? sets : [];
  const full = [];
  let done = 0;
  await mapLimit(list, 4, async (s) => {
    const set = await retry(() => getJson(`${TCGDEX}/${lang}/sets/${encodeURIComponent(s.id)}`, 20000), 2).catch(() => null);
    if (set?.cards) full.push(set);
    onProgress?.(++done, list.length);
  });
  full.sort((a, b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')));
  const out = [];
  for (const set of full) {
    for (const c of set.cards) {
      out.push({
        id: `${prefix}${c.id}`, lang, name: c.name, number: c.localId, rarity: c.rarity || null, supertype: null,
        setId: set.id, setName: set.name, series: set.serie?.name || null, total: set.cardCount?.official,
        released: set.releaseDate || '', code: null,
        img: c.image ? `${c.image}/low.webp` : null, alt: c.image ? `${c.image}/low.png` : null,
      });
    }
  }
  return out;
}

/* ---------------- sorting ---------------- */
// Rarity, most sought-after first. The first entry contained in a card's rarity wins, so more
// specific names come before the general ones ("rare holo vmax" before "rare holo" before "rare").
const RARITY_RANK = [
  ['special illustration rare', 99], ['hyper rare', 98], ['rare secret', 96], ['secret', 96], ['rare rainbow', 95],
  ['illustration rare', 92], ['ace spec', 90], ['shiny ultra', 89], ['ultra rare', 88], ['rare ultra', 88],
  ['rare shiny gx', 87], ['rare holo vmax', 86], ['rare holo vstar', 86], ['rare holo v', 84], ['double rare', 83],
  ['rare holo gx', 82], ['rare holo ex', 82], ['rare prism star', 81], ['radiant', 80], ['amazing', 79],
  ['rare break', 78], ['rare holo lv.x', 78], ['legend', 78], ['shiny rare', 77], ['rare shiny', 77],
  ['rare holo star', 76], ['rare prime', 75], ['rare ace', 75], ['trainer gallery', 74], ['classic collection', 73],
  ['rare holo', 60], ['rare', 50], ['promo', 45], ['uncommon', 30], ['common', 10],
];
function rarityRank(r) {
  const s = String(r || '').toLowerCase();
  if (!s) return 0;
  for (const [k, v] of RARITY_RANK) if (s.includes(k)) return v;
  return 40;
}
const numKey = (n) => {
  const m = String(n || '').match(/^(\D*)(\d+)(.*)$/);
  return m ? [m[1], +m[2], m[3]] : [String(n || ''), 0, ''];
};
function byNumber(a, b) {
  const x = numKey(a.number), y = numKey(b.number);
  return x[0].localeCompare(y[0]) || x[1] - y[1] || x[2].localeCompare(y[2]);
}
const newest = (a, b) => (b.released || '').localeCompare(a.released || '') || String(a.setId).localeCompare(String(b.setId)) || byNumber(a, b);
const SORTS = {
  newest,
  oldest: (a, b) => (a.released || '').localeCompare(b.released || '') || String(a.setId).localeCompare(String(b.setId)) || byNumber(a, b),
  name: (a, b) => a.name.localeCompare(b.name) || newest(a, b),
  rarity: (a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) || newest(a, b),
  set: (a, b) => String(a.setName).localeCompare(String(b.setName)) || newest(a, b),
};

function liteCard(m) {
  return {
    id: m.id, name: m.name, number: m.number, rarity: m.rarity || undefined, supertype: m.supertype || undefined,
    lang: m.lang === 'en' ? undefined : m.lang, lite: true,
    set: { id: m.setId, name: m.setName, series: m.series || undefined, printedTotal: m.total, releaseDate: m.released, ptcgoCode: m.code || undefined },
    images: m.img ? { small: m.img, large: m.alt || undefined } : {},
  };
}

function createCatalog({ store, log = console } = {}) {
  const lists = {};    // lang -> { at, cards }
  const loading = {};  // lang -> promise
  const progress = {}; // lang -> { done, total }
  let version = 0;
  const sorted = new Map(); // `${version}:${langs}:${sort}` -> cards[]

  async function fetchList(lang) {
    const onProgress = (done, total) => { progress[lang] = { done, total }; };
    if (lang === 'ja') return tcgdexCatalog('ja', onProgress);
    try {
      return await englishCatalog(onProgress);
    } catch (e) {
      log.warn?.(`catalogue: Pokémon TCG API unavailable (${e.message}) — using TCGdex`);
      return tcgdexCatalog('en', onProgress);
    }
  }
  function refresh(lang) {
    if (loading[lang]) return loading[lang];
    loading[lang] = (async () => {
      try {
        const cards = await fetchList(lang);
        if (!cards.length) throw new Error('empty catalogue');
        lists[lang] = { at: Date.now(), cards };
        version++;
        await store.setKv?.(`catalog-${lang}`, lists[lang]).catch((e) => log.warn?.(`catalogue: couldn't save ${lang}: ${e.message}`));
        return cards;
      } finally {
        loading[lang] = null;
        progress[lang] = null;
      }
    })();
    return loading[lang];
  }
  // The list for a language: from memory, else the store, else fetched. Stale lists are used
  // while a refresh runs in the background.
  async function get(lang) {
    if (!lists[lang]) {
      const saved = await store.getKv?.(`catalog-${lang}`).catch(() => null);
      if (saved?.cards?.length && !lists[lang]) { lists[lang] = saved; version++; }
    }
    if (lists[lang]) {
      if (Date.now() - lists[lang].at > DAY) refresh(lang).catch(() => {});
      return lists[lang].cards;
    }
    return refresh(lang);
  }
  // Start loading in the background; returns the list now if it's ready, else null.
  function peek(lang) {
    if (lists[lang]) return lists[lang].cards;
    get(lang).catch((e) => log.warn?.(`catalogue: ${lang} failed: ${e.message}`));
    return null;
  }

  function status() {
    return Object.fromEntries(LANGS.map((l) => [l, {
      ready: !!lists[l], count: lists[l]?.cards.length || 0, updatedAt: lists[l]?.at || null,
      loading: !!loading[l], progress: progress[l] || null,
    }]));
  }

  // One page of the Index. owned = card ids in the user's collection.
  function query({ sort = 'newest', lang = 'all', q = '', set = '', owned = [], ownedOnly = false, offset = 0, limit = 24 } = {}) {
    const langs = lang === 'en' || lang === 'ja' ? [lang] : LANGS;
    const ready = langs.map((l) => peek(l)).filter(Boolean);
    if (!ready.length) return { loading: true, status: status(), items: [], total: 0 };
    const key = `${version}:${langs.filter((l) => lists[l]).join(',')}:${sort}`;
    let all = sorted.get(key);
    const ownedSet = new Set(owned);
    if (sort === 'collection') {
      // My collection first (newest first within each group) — depends on the user, not cached.
      all = [].concat(...ready).sort((a, b) => (ownedSet.has(b.id) - ownedSet.has(a.id)) || newest(a, b));
    } else if (!all) {
      all = [].concat(...ready).sort(SORTS[sort] || newest);
      if (sorted.size > 12) sorted.clear();
      sorted.set(key, all);
    }
    const needle = String(q || '').trim().toLowerCase();
    const num = needle.match(/^#?([a-z]{0,4}\d{1,4}[a-z]?)$/i)?.[1];
    const match = (c) => (!set || c.setId === set)
      && (!ownedOnly || ownedSet.has(c.id))
      && (!needle || c.name.toLowerCase().includes(needle) || (num && String(c.number).toLowerCase().replace(/^0+(?=\d)/, '') === num.replace(/^0+(?=\d)/, '')));
    const filtered = needle || set || ownedOnly ? all.filter(match) : all;
    const page = filtered.slice(offset, offset + limit).map(liteCard);
    const out = { loading: false, status: status(), total: filtered.length, offset, items: page };
    if (offset === 0) {
      // Sets for the filter menu, newest first.
      const sk = `sets:${version}:${langs.filter((l) => lists[l]).join(',')}`;
      if (!sorted.has(sk)) {
        const seen = new Map();
        for (const c of [].concat(...ready).sort(newest)) if (!seen.has(c.setId)) seen.set(c.setId, { id: c.setId, name: c.setName, lang: c.lang, released: c.released });
        sorted.set(sk, [...seen.values()]);
      }
      out.sets = sorted.get(sk);
    }
    return out;
  }

  // Save a list after its cards were updated in place (e.g. rarities filled in for a new set).
  async function persist(lang) {
    if (!lists[lang]) return;
    version++;
    await store.setKv?.(`catalog-${lang}`, lists[lang]).catch((e) => log.warn?.(`catalogue: couldn't save ${lang}: ${e.message}`));
  }

  return { get, peek, refresh, status, query, persist };
}

module.exports = { createCatalog, liteCard, rarityRank, _test: { englishCatalog, tcgdexCatalog, SORTS } };
