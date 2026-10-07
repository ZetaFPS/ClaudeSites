'use strict';
// Card data + price sources, all fetched server-side (no CORS issues, API keys stay secret).
//
//   Pokémon TCG API  – card search/details + TCGplayer market prices per printing
//   TCGdex           – backup card search when the Pokémon TCG API is slow/down, and a
//                      backup TCGplayer price source
//   PriceCharting    – last-resort raw price + graded prices (PSA 10, Grade 9 … 1, BGS/CGC/SGC 10)
//                      via the official API when PRICECHARTING_TOKEN is set, otherwise by
//                      reading the public product page.
//
// Every match between sources is strict: same card name, same collector number, same set and
// same printing (1st Edition / Reverse Holo). A wrong price is worse than no price.

const POKEMONTCG = 'https://api.pokemontcg.io/v2';
const TCGDEX_API = 'https://api.tcgdex.net/v2';
const TCGDEX = `${TCGDEX_API}/en`;
// Card ids: plain = Pokémon TCG API, `tcgdex:` = TCGdex English, `tcgdexja:` = TCGdex Japanese.
const DEX_PREFIX = { en: 'tcgdex:', ja: 'tcgdexja:' };
function parseId(id) {
  if (id.startsWith('tcgdexja:')) return { source: 'tcgdex', lang: 'ja', ref: id.slice(9) };
  if (id.startsWith('tcgdex:')) return { source: 'tcgdex', lang: 'en', ref: id.slice(7) };
  return { source: 'ptcg', lang: 'en', ref: id };
}
const PC = 'https://www.pricecharting.com';
const UA = 'Mozilla/5.0 (compatible; PokeFolio/2.1)';

const HOUR = 3600e3;
const CARD_FIELDS = [
  'id', 'name', 'supertype', 'subtypes', 'hp', 'types', 'evolvesFrom', 'abilities', 'attacks',
  'weaknesses', 'resistances', 'retreatCost', 'number', 'artist', 'rarity', 'flavorText',
  'nationalPokedexNumbers', 'regulationMark', 'rules', 'set', 'images', 'tcgplayer', 'cardmarket',
].join(',');

// Which printing a card defaults to. Unlimited before 1st Edition: most copies people own are
// unlimited, and 1st Edition prices are often 10–50× higher.
const VARIANT_ORDER = ['holofoil', 'normal', 'unlimitedHolofoil', 'unlimited', 'reverseHolofoil', '1stEditionHolofoil', '1stEditionNormal', '1stEdition'];

/* ---------------- small utilities ---------------- */
const cache = new Map();
function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = Promise.resolve().then(fn);
  cache.set(key, { promise, expires: Date.now() + ttl });
  // Failures shouldn't stick around for the full TTL.
  promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
  if (cache.size > 5000) for (const [k, v] of cache) { if (v.expires < Date.now() || cache.size > 4000) cache.delete(k); }
  return promise;
}

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: '*/*', ...(opts.headers || {}) } });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `${new URL(url).host} timed out` : `${new URL(url).host} unreachable`);
  } finally {
    clearTimeout(t);
  }
}
async function getJson(url, headers, ms) {
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json', ...headers } }, ms);
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res.json();
}

// Run fn over items with limited concurrency.
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// Polite limiter for PriceCharting: at most 2 requests in flight, spaced out.
function limiter(max, gapMs) {
  let active = 0, last = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    const wait = Math.max(0, last + gapMs - Date.now());
    if (wait) return void setTimeout(next, wait);
    const { fn, resolve, reject } = queue.shift();
    active++; last = Date.now();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const pcLimit = limiter(2, 350);

const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// Set-name words for fuzzy set matching. Plurals are folded ("Promos" → "promo") and filler dropped,
// because sites name the same set differently ("SWSH Black Star Promos" vs "Pokemon Promo").
const words = (s) => slug(s).split('-')
  .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w))
  .filter((w) => w && !['pokemon', 'set', 'and', 'the', 'tcg', 'black', 'star'].includes(w));
const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const normNum = (n) => slug(n).replace(/^0+(?=\d)/, '').replace(/([a-z])0+(?=\d)/, '$1');
const numEq = (a, b) => !!normNum(a) && normNum(a) === normNum(b);
const money = (s) => {
  const m = String(s || '').replace(/,/g, '').match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  return m ? +m[1] : null;
};
const is1st = (v) => normKey(v).includes('1stedition');
const isReverse = (v) => normKey(v).includes('reverse');

// Set names differ between sources ("Base" vs "Pokemon Base Set"); require at least half of
// our set's words to appear in theirs.
function setMatches(ourSet, theirSet, ourTotal, theirTotal) {
  if (ourTotal && theirTotal && +ourTotal === +theirTotal) return true;
  const ours = words(ourSet);
  if (!ours.length) return false;
  const theirs = new Set(words(theirSet));
  return ours.filter((w) => theirs.has(w)).length / ours.length >= 0.5;
}

/* ---------------- Pokémon TCG API ---------------- */
// The API is often slow or briefly down. After a failure, skip it for a short while so
// searches go straight to TCGdex instead of waiting on timeouts.
let ptcgDownUntil = 0;
const ptcgUp = () => Date.now() > ptcgDownUntil;
async function ptcgJson(url) {
  try {
    const headers = process.env.POKEMONTCG_API_KEY ? { 'X-Api-Key': process.env.POKEMONTCG_API_KEY } : {};
    return await getJson(url, headers, 12000);
  } catch (e) {
    if (!/responded 4\d\d/.test(e.message)) ptcgDownUntil = Date.now() + 2 * 60e3;
    throw e;
  }
}
function ptcgSearch(q) {
  const params = new URLSearchParams({ q, pageSize: '36', orderBy: '-set.releaseDate', select: CARD_FIELDS });
  return cached(`ptcg:${params}`, 30 * 60e3, async () => (await ptcgJson(`${POKEMONTCG}/cards?${params}`)).data || []);
}

// Fetch many cards in a few requests and seed the per-card cache.
async function primeCards(ids) {
  if (!ptcgUp()) return;
  const missing = ids.filter((id) => !id.startsWith('tcgdex') && !(cache.get(`card:${id}`)?.expires > Date.now()));
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    const q = '(' + chunk.map((id) => `id:"${id.replace(/"/g, '')}"`).join(' OR ') + ')';
    const res = await ptcgJson(`${POKEMONTCG}/cards?${new URLSearchParams({ q, pageSize: '100' })}`);
    for (const c of res.data || []) cache.set(`card:${c.id}`, { promise: Promise.resolve(c), expires: Date.now() + 6 * HOUR });
  }
}

/* ---------------- TCGdex ---------------- */
const camel = (k) => k.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
function tcgdexFull(id, lang = 'en') {
  return cached(`dex-full:${lang}:${id}`, 12 * HOUR, () => getJson(`${TCGDEX_API}/${lang}/cards/${encodeURIComponent(id)}`));
}
// Convert a TCGdex card into the same shape the Pokémon TCG API uses.
function fromTcgdex(c, lang = 'en') {
  const tp = c.pricing?.tcgplayer || {};
  const prices = {};
  for (const [k, v] of Object.entries(tp)) {
    if (!v || typeof v !== 'object') continue;
    prices[camel(k)] = { low: v.lowPrice ?? null, mid: v.midPrice ?? null, high: v.highPrice ?? null, market: v.marketPrice ?? null };
  }
  const cm = c.pricing?.cardmarket;
  return {
    id: `${DEX_PREFIX[lang] || DEX_PREFIX.en}${c.id}`,
    lang: lang === 'en' ? undefined : lang,
    name: c.name,
    supertype: c.category === 'Pokemon' ? 'Pokémon' : c.category,
    subtypes: [c.stage, c.suffix, c.trainerType, c.energyType].filter(Boolean),
    hp: c.hp != null ? String(c.hp) : undefined,
    types: c.types,
    evolvesFrom: c.evolveFrom,
    abilities: (c.abilities || []).map((a) => ({ name: a.name, text: a.effect, type: a.type })),
    attacks: (c.attacks || []).map((a) => ({ name: a.name, cost: a.cost || [], damage: a.damage != null ? String(a.damage) : '', text: a.effect })),
    weaknesses: (c.weaknesses || []).map((w) => ({ type: w.type, value: w.value })),
    resistances: (c.resistances || []).map((w) => ({ type: w.type, value: w.value })),
    retreatCost: c.retreat ? Array(c.retreat).fill('Colorless') : undefined,
    number: c.localId,
    artist: c.illustrator,
    rarity: c.rarity,
    flavorText: c.description,
    nationalPokedexNumbers: c.dexId,
    regulationMark: c.regulationMark,
    rules: c.effect ? [c.effect] : undefined,
    set: {
      id: c.set?.id, name: c.set?.name, releaseDate: c.set?.releaseDate,
      printedTotal: c.set?.cardCount?.official, total: c.set?.cardCount?.total,
      images: { symbol: c.set?.symbol ? `${c.set.symbol}.png` : undefined, logo: c.set?.logo ? `${c.set.logo}.png` : undefined },
    },
    images: c.image ? { small: `${c.image}/low.webp`, large: `${c.image}/high.webp` } : {},
    tcgplayer: Object.keys(prices).length ? { updatedAt: tp.updated || null, prices } : undefined,
    cardmarket: cm ? { updatedAt: cm.updated || null, prices: { trendPrice: cm.trend, averageSellPrice: cm.avg, avg30: cm.avg30, lowPrice: cm.low, reverseHoloTrend: cm['trend-holo'], reverseHoloAvg30: cm['avg30-holo'] } } : undefined,
  };
}

// Cards of one TCGdex set (Japanese set codes like "SV2a" are TCGdex set ids).
async function tcgdexSetCards(setId, lang) {
  return cached(`dex-set:${lang}:${setId}`, 12 * HOUR, async () => {
    for (const id of [...new Set([setId, setId.toUpperCase(), setId.replace(/^([a-z]+)/i, (m) => m.toUpperCase()), setId.toLowerCase()])]) {
      try {
        const set = await getJson(`${TCGDEX_API}/${lang}/sets/${encodeURIComponent(id)}`);
        if (set?.cards) return set.cards;
      } catch (e) {
        if (!/responded 404/.test(e.message)) throw e;
      }
    }
    return [];
  });
}

async function tcgdexSearch({ name, number, total, setCode, lang }) {
  if (!name && !number) return [];
  lang = lang === 'ja' ? 'ja' : 'en';
  const key = `dex-search:${lang}:${slug(name) || name || ''}:${normNum(number)}:${total || ''}:${setCode || ''}`;
  return cached(key, 30 * 60e3, async () => {
    const base = `${TCGDEX_API}/${lang}`;
    let list = [];
    if (setCode && number && lang !== 'en') list = (await tcgdexSetCards(setCode, lang).catch(() => [])).filter((c) => numEq(c.localId, number));
    if (!list.length) {
      if (name) list = await getJson(`${base}/cards?name=${encodeURIComponent(name)}`);
      else list = await getJson(`${base}/cards?localId=${encodeURIComponent('eq:' + number)}`);
      list = Array.isArray(list) ? list : [];
      if (number) list = list.filter((c) => numEq(c.localId, number));
    }
    // Newest first is a decent default when there's no number to narrow it down.
    const full = (await mapLimit(list.slice(-40).reverse(), 8, (b) => tcgdexFull(b.id, lang).catch(() => null))).filter(Boolean);
    let cards = full.map((c) => fromTcgdex(c, lang));
    if (total) {
      const exact = cards.filter((c) => +c.set.printedTotal === +total);
      if (exact.length) cards = exact;
    }
    return cards;
  });
}

// Find the TCGdex copy of a Pokémon TCG API card (same name, number and set).
async function tcgdexMatch(info) {
  if (!info.name || !info.number) return null;
  const cards = await tcgdexSearch({ name: info.name, number: info.number });
  return cards.find((c) => slug(c.name) === slug(info.name) && setMatches(info.setName, c.set.name, info.total, c.set.printedTotal)) || null;
}

/* ---------------- Cards ---------------- */
function getCard(id) {
  return cached(`card:${id}`, 6 * HOUR, async () => {
    const { source, lang, ref } = parseId(id);
    if (source === 'tcgdex') {
      const card = fromTcgdex(await tcgdexFull(ref, lang), lang);
      if (lang === 'en' && (!card.images?.small || !card.tcgplayer)) await withTcgplayer(card).catch(() => {});
      return card;
    }
    return (await ptcgJson(`${POKEMONTCG}/cards/${encodeURIComponent(id)}`)).data;
  });
}

/* ---------------- TCGplayer catalogue (via tcgcsv.com) ---------------- */
// Brand-new sets (e.g. 30th Celebration's Classic Collection) are on TCGplayer — with pictures,
// market prices and the printed card numbers — well before the card databases picture them.
// tcgcsv.com mirrors TCGplayer's public catalogue daily; Pokémon is category 3.
const TCGCSV = 'https://tcgcsv.com/tcgplayer/3';
const TP_IMG = /^https:\/\/tcgplayer-cdn\.tcgplayer\.com\/product\/(\d+)_/;
const tpGroups = () => cached('tcgcsv:groups', 12 * HOUR, async () => (await getJson(`${TCGCSV}/groups`, {}, 20000)).results || []);
const tpProducts = (g) => cached(`tcgcsv:products:${g}`, 12 * HOUR, async () => (await getJson(`${TCGCSV}/${g}/products`, {}, 20000)).results || []);
const tpPrices = (g) => cached(`tcgcsv:prices:${g}`, 6 * HOUR, async () => (await getJson(`${TCGCSV}/${g}/prices`, {}, 20000)).results || []);
const tpExt = (p, name) => (p.extendedData || []).find((e) => e.name === name)?.value || '';
// Card name as TCGplayer writes it, minus additions like " - 4/102" or " (Classic Collection)".
const tpName = (n) => slug(String(n || '').replace(/\s+-\s+[^-]*\d[^-]*$/, '').replace(/\s*\([^)]*\)\s*/g, ' '));
// The TCGplayer group (set) for our set: all of our set's words in its name, released near it.
async function tpGroupFor(set) {
  const ours = words(set?.name);
  if (!ours.length) return null;
  const day = Date.parse(String(set.releaseDate || '').replace(/\//g, '-'));
  let best = null, bestScore = -Infinity;
  for (const g of await tpGroups()) {
    const theirs = words(String(g.name || '').replace(/^[A-Z0-9&]{1,6}\d*:\s*/, ''));
    if (!ours.every((w) => theirs.includes(w))) continue;
    const gap = day && g.publishedOn ? Math.abs(Date.parse(g.publishedOn) - day) / (24 * HOUR) : 0;
    if (gap > 90) continue;
    const score = -(theirs.length - ours.length) - gap / 30;
    if (score > bestScore) { best = g; bestScore = score; }
  }
  return best;
}
// A photo of the set's sealed booster pack from TCGplayer (pack simulator). Prefers the plain
// "<Set> Booster Pack" product over boxes, bundles, blisters and art variants.
function tpBoosterImages(set) {
  return cached(`tcgcsv:booster:${slug(set.name)}`, 24 * HOUR, async () => {
    const g = await tpGroupFor({ name: set.name, releaseDate: set.released || set.releaseDate });
    if (!g) return [];
    const packs = (await tpProducts(g.groupId)).filter((p) => /\bbooster pack\b/i.test(p.name) && !tpExt(p, 'Number')
      && !/\b(case|box|bundle|display|blister|sleeved|lot|code|collection|tin|half|elite|build|battle|art set|online)\b/i.test(p.name) && TP_IMG.test(p.imageUrl || ''));
    const score = (p) => (/\[|\(/.test(p.name) ? 1 : 0); // plain names first, art variants after
    return packs.sort((a, b) => score(a) - score(b)).map((p) => {
      const id = p.imageUrl.match(TP_IMG)[1];
      return [`https://tcgplayer-cdn.tcgplayer.com/product/${id}_in_1000x1000.jpg`, p.imageUrl];
    });
  });
}

// Fill a card's missing picture and prices (and its printed number) from TCGplayer.
async function withTcgplayer(card) {
  const g = await tpGroupFor(card.set);
  if (!g) return card;
  const cards = (await tpProducts(g.groupId)).filter((p) => tpExt(p, 'Number'));
  const named = cards.filter((p) => tpName(p.name) === slug(card.name));
  const num = (p) => normNum(tpExt(p, 'Number').split('/')[0]);
  // Same number, else the only card with that name (subset numbering often differs between sites).
  const prod = named.find((p) => num(p) === normNum(card.number)) || (named.length === 1 ? named[0] : null);
  if (!prod) return card;
  card.printedNumber = tpExt(prod, 'Number');
  if (!card.images?.small && TP_IMG.test(prod.imageUrl || '')) {
    const id = prod.imageUrl.match(TP_IMG)[1];
    card.images = { small: `https://tcgplayer-cdn.tcgplayer.com/product/${id}_in_400x400.jpg`, large: `https://tcgplayer-cdn.tcgplayer.com/product/${id}_in_1000x1000.jpg`, alt: prod.imageUrl };
  }
  if (!card.tcgplayer) {
    const prices = {};
    for (const r of await tpPrices(g.groupId).catch(() => [])) {
      if (r.productId !== prod.productId || !r.subTypeName) continue;
      prices[camel(slug(r.subTypeName))] = { low: r.lowPrice ?? null, mid: r.midPrice ?? null, high: r.highPrice ?? null, market: r.marketPrice ?? null };
    }
    if (Object.keys(prices).length) card.tcgplayer = { updatedAt: null, url: prod.url || null, prices };
  }
  return card;
}

function buildQueries({ name, number, total, setCode }) {
  const clean = String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const ws = clean.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 4);
  const nameQ = ws.map((w) => `name:${w}`).join(' ');
  const phrase = clean.replace(/[^a-z0-9.'\- ]/g, ' ').replace(/\s+/g, ' ').trim();
  const nameWild = ws.length ? ws.slice(0, -1).map((w) => `name:${w}`).concat(`name:${ws.at(-1)}*`).join(' ') : '';
  const num = number && /^[a-z0-9]{1,12}$/i.test(number) ? `number:${number}` : '';
  const tot = total && /^\d{1,4}$/.test(total) ? `set.printedTotal:${total}` : '';
  const code = setCode && /^[A-Z0-9]{2,5}$/i.test(setCode) ? `set.ptcgoCode:${setCode.toUpperCase()}` : '';
  const qs = [];
  // Set code + number pins down an exact card on modern sets ("PAL EN 123/193").
  if (code && num) qs.push(nameQ ? `${nameQ} ${num} ${code}` : `${num} ${code}`);
  if (code && num && nameQ) qs.push(`${num} ${code}`);
  if (nameQ && num && tot) qs.push(`${nameQ} ${num} ${tot}`);
  if (nameQ && num) qs.push(`${nameQ} ${num}`);
  if (num && tot) qs.push(`${num} ${tot}`);
  if (nameQ) qs.push(nameQ);
  if (nameWild) qs.push(nameWild);
  if (phrase && /[.'\-]/.test(phrase)) qs.push(`name:"${phrase}"`);
  return [...new Set(qs)];
}

// Search with automatic fallback: Pokémon TCG API first, TCGdex if it fails or finds nothing.
// While the Pokémon TCG API is marked down, TCGdex goes first and the API is only tried if
// TCGdex has no match.
async function search(parsed) {
  // Japanese cards only exist on TCGdex.
  if (parsed.lang === 'ja') {
    let data = await tcgdexSearch({ ...parsed, lang: 'ja' });
    if (!data.length && parsed.name && parsed.number) data = await tcgdexSearch({ name: parsed.name, lang: 'ja' });
    return { data, source: 'tcgdex' };
  }
  const viaPtcg = async () => {
    for (const q of buildQueries(parsed)) {
      const data = await ptcgSearch(q);
      if (data.length) return data;
    }
    return [];
  };
  const viaDex = async () => {
    let data = await tcgdexSearch(parsed);
    // Number misread by the scanner? Retry on name alone.
    if (!data.length && parsed.name && parsed.number) data = await tcgdexSearch({ name: parsed.name });
    return data;
  };
  const [first, second] = ptcgUp() ? [[viaPtcg, 'pokemontcg'], [viaDex, 'tcgdex']] : [[viaDex, 'tcgdex'], [viaPtcg, 'pokemontcg']];
  let firstError = null;
  try {
    const data = await first[0]();
    if (data.length) return { data, source: first[1] };
  } catch (e) {
    firstError = e;
  }
  try {
    return { data: await second[0](), source: second[1] };
  } catch (e) {
    if (firstError) throw firstError;
    return { data: [], source: first[1] };
  }
}

/* ---------------- Raw price helpers ---------------- */
function defaultVariant(card) {
  const prices = card?.tcgplayer?.prices || {};
  const keys = Object.keys(prices).filter((k) => prices[k]?.market != null);
  return VARIANT_ORDER.find((k) => keys.includes(k)) || keys[0] || null;
}
// TCGplayer market price for exactly this printing (never a different printing's price).
function tcgplayerPrice(card, variant) {
  const v = variant || defaultVariant(card);
  const p = v && card?.tcgplayer?.prices?.[v];
  return p && p.market != null ? { price: +p.market, variant: v } : null;
}

/* ---------------- PriceCharting ---------------- */
const PC_API_FIELDS = [
  ['loose-price', 'Ungraded'], ['cib-price', 'Grade 7'], ['new-price', 'Grade 8'], ['graded-price', 'Grade 9'],
  ['box-only-price', 'Grade 9.5'], ['manual-only-price', 'PSA 10'], ['bgs-10-price', 'BGS 10'],
  ['condition-17-price', 'CGC 10'], ['condition-18-price', 'SGC 10'],
];
const PC_PAGE_IDS = [
  ['used_price', 'Ungraded'], ['complete_price', 'Grade 7'], ['new_price', 'Grade 8'], ['graded_price', 'Grade 9'],
  ['box_only_price', 'Grade 9.5'], ['manual_only_price', 'PSA 10'],
];

const PRINTING_WORDS = new Set(['1st', 'edition', 'shadowless', 'unlimited', 'reverse', 'holo', 'cosmos', 'cracked', 'ice',
  'master', 'poke', 'pokeball', 'ball', 'stamped', 'staff', 'prerelease', 'non', 'swirl', 'no', 'symbol', 'red', 'cheeks']);

const SUBSET_WORDS = new Set(['classic', 'collection', 'trainer', 'gallery', 'galarian', 'shiny', 'vault']);
// Score a PriceCharting product (console slug + product slug) against our card.
// Returns -1 unless name, number, set and printing all match.
function scoreProduct(consoleSlug, productSlug, { name, setName, number, variant, japanese = false }, { relaxed = false, anyNumber = false } = {}) {
  consoleSlug = slug(consoleSlug); productSlug = slug(productSlug);
  if (!consoleSlug.startsWith('pokemon') || /chinese|korean|german|french|italian|spanish/.test(consoleSlug)) return -1;
  // Japanese and English printings are different cards with very different prices.
  if (/japanese/.test(consoleSlug) !== !!japanese) return -1;
  const segs = productSlug.split('-');
  // anyNumber: the set's numbering may not line up between sites yet (brand-new sets), so the
  // product's number is ignored — callers then demand a near-exact set and a unique name.
  if (anyNumber) { if (/\d/.test(segs.at(-1))) segs.pop(); } else if (!number || normNum(segs.at(-1)) !== normNum(number)) return -1;
  const base = anyNumber ? segs.join('-') : segs.slice(0, -1).join('-');
  const nameSlug = slug(name);
  if (!nameSlug || (base !== nameSlug && !base.startsWith(`${nameSlug}-`))) return -1;
  const tags = base.slice(nameSlug.length);
  // Extra words may only describe the printing ("[Shadowless]", "[Reverse Holo]"); anything else
  // ("ex", "V", "GX"…) means it's a different card.
  if (tags.split('-').filter(Boolean).some((w) => !PRINTING_WORDS.has(w))) return -1;
  if (/reverse-holo/.test(tags) !== isReverse(variant)) return -1;
  if (/1st-edition/.test(tags) !== is1st(variant)) return -1;
  // Subset names ("… Classic Collection", "… Trainer Gallery") are usually listed under the main set.
  const all = words(setName);
  const ours = all.filter((w) => !SUBSET_WORDS.has(w)).length ? all.filter((w) => !SUBSET_WORDS.has(w)) : all;
  const theirs = words(consoleSlug);
  const hit = ours.filter((w) => theirs.includes(w)).length;
  if (!relaxed && (!ours.length || hit / ours.length < (anyNumber ? 0.75 : 0.5))) return -1;
  // Prefer exact set names and plain products over tagged ones ("[Shadowless]", "[Cosmos Holo]").
  return 10 + hit * 2 - (theirs.length - hit) - tags.split('-').filter(Boolean).length * 2;
}

// Pick the PriceCharting product for our card from candidates [{ console, product, ref }].
// Strict: name, number, printing AND set must match. If nothing passes, accept a match that ignores
// the set name only when exactly one product in the results has that exact name, number and
// printing — set names differ a lot between sites (promos, special sets), but a unique
// name+number is still unambiguous. Last, for brand-new sets whose card numbers don't line up
// between sites yet (info.recent): accept the only product with that exact name in a closely
// matching set.
function pickProduct(cands, info) {
  let best = null, bestScore = -1;
  for (const c of cands) {
    const sc = scoreProduct(c.console, c.product, info);
    if (sc > bestScore) { best = c; bestScore = sc; }
  }
  if (best) return best;
  const loose = new Map();
  for (const c of cands) if (scoreProduct(c.console, c.product, info, { relaxed: true }) >= 0) loose.set(`${slug(c.console)}/${slug(c.product)}`, c);
  if (loose.size === 1) return { ...[...loose.values()][0], relaxed: true };
  if (loose.size || !info.recent) return null;
  const byName = new Map();
  for (const c of cands) if (scoreProduct(c.console, c.product, info, { anyNumber: true }) >= 0) byName.set(`${slug(c.console)}/${slug(c.product)}`, c);
  return byName.size === 1 ? { ...[...byName.values()][0], relaxed: true, nameOnly: true } : null;
}

async function pcViaApi(info) {
  const token = process.env.PRICECHARTING_TOKEN;
  for (const q of pcQueries(info)) {
    const res = await pcGuarded(() => pcRetry(() => pcLimit(() => getJson(`${PC}/api/products?t=${encodeURIComponent(token)}&q=${encodeURIComponent(q)}`))));
    const best = pickProduct((res.products || []).map((p) => ({ console: p['console-name'], product: p['product-name'], ref: p.id })), info);
    if (best) {
      const p = await pcGuarded(() => pcRetry(() => pcLimit(() => getJson(`${PC}/api/product?t=${encodeURIComponent(token)}&id=${encodeURIComponent(best.ref)}`))));
      const prices = {};
      for (const [field, label] of PC_API_FIELDS) if (p[field] > 0) prices[label] = p[field] / 100;
      return {
        title: `${p['product-name']} · ${p['console-name']}`,
        url: `${PC}/game/${slug(p['console-name'])}/${slug(p['product-name'])}`,
        prices, image: /^https:\/\//.test(p['image-url'] || '') ? p['image-url'] : null,
      };
    }
  }
  return null;
}

// PriceCharting refuses or times out when it gets several requests in a row: retry those
// (with a growing pause) instead of failing — a failure falls back to a much rougher estimate.
async function pcRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const transient = /responded (429|5\d\d)|timed out|unreachable/.test(e.message);
      if (!transient || attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt * attempt));
    }
  }
}
// If PriceCharting starts refusing us (403/429 or a bot-check page), pause every PriceCharting
// request for a while — 2 minutes, doubling up to 30 — instead of hammering it, which only keeps
// the block in place. Graded prices fall back to estimates meanwhile, and the reason is logged
// and shown at /api/health.
const pcState = { blockedUntil: 0, backoff: 0, lastError: null, lastErrorAt: 0, lastOkAt: 0 };
function pcGuard() {
  if (Date.now() < pcState.blockedUntil) throw new Error(`PriceCharting paused after "${pcState.lastError}" — retrying in ${Math.ceil((pcState.blockedUntil - Date.now()) / 60e3)} min`);
}
function pcFailed(e) {
  pcState.lastError = e.message;
  pcState.lastErrorAt = Date.now();
  if (!/responded (403|429)|bot check/.test(e.message)) return;
  pcState.backoff = Math.min(30 * 60e3, pcState.backoff ? pcState.backoff * 2 : 2 * 60e3);
  pcState.blockedUntil = Date.now() + pcState.backoff;
  console.warn(`PriceCharting refused a request (${e.message}) — pausing PriceCharting lookups for ${pcState.backoff / 60e3} min`);
}
function pcOk() { pcState.backoff = 0; pcState.lastOkAt = Date.now(); }
async function pcGuarded(fn) {
  pcGuard();
  try {
    const out = await fn();
    pcOk();
    return out;
  } catch (e) {
    if (!/responded 404/.test(e.message)) pcFailed(e);
    throw e;
  }
}
const pcStatus = () => ({
  ok: Date.now() >= pcState.blockedUntil, pausedUntil: pcState.blockedUntil > Date.now() ? new Date(pcState.blockedUntil).toISOString() : null,
  lastError: pcState.lastError, lastErrorAt: pcState.lastErrorAt ? new Date(pcState.lastErrorAt).toISOString() : null,
  lastSuccessAt: pcState.lastOkAt ? new Date(pcState.lastOkAt).toISOString() : null,
});

async function pcFetchPage(url) {
  return pcGuarded(() => pcRetry(async () => {
    const res = await pcLimit(() => fetchWithTimeout(url, { headers: { Accept: 'text/html' }, redirect: 'follow' }));
    if (!res.ok) throw new Error(`PriceCharting responded ${res.status}`);
    const html = await res.text();
    if (/<title>\s*Just a moment|challenge-platform|cf-chl-/i.test(html)) throw new Error('PriceCharting responded 403 (bot check)');
    return { url: res.url || url, html };
  }));
}

function parseProductPage(html) {
  const prices = {};
  const table = html.match(/id=["']full-prices["'][\s\S]*?<\/table>/i);
  if (table) {
    for (const m of table[0].matchAll(/<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi)) {
      const label = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const price = money(m[2].replace(/<[^>]+>/g, ''));
      if (label && price != null && label.length < 40) prices[label] = price;
    }
  }
  for (const [id, label] of PC_PAGE_IDS) {
    if (prices[label] != null) continue;
    const m = html.match(new RegExp(`id=["']${id}["'][\\s\\S]{0,400}?\\$\\s*([\\d,]+\\.\\d{2})`, 'i'));
    if (m) prices[label] = +m[1].replace(/,/g, '');
  }
  const title = (html.match(/<h1[^>]*id=["']product_name["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1] || html.match(/<title>([^<]*)<\/title>/i)?.[1] || '')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return { title, prices };
}

async function pcViaPage(info) {
  for (const q of pcQueries(info)) {
    const { url, html } = await pcFetchPage(`${PC}/search-products?type=prices&q=${encodeURIComponent(q)}`);
    const direct = new URL(url).pathname.match(/\/game\/([^/]+)\/([^/?#]+)/);
    if (direct) {
      // Search jumped straight to a product page (PriceCharting does this when there's only one
      // result) — use it only if it's the right card.
      if (pickProduct([{ console: decodeURIComponent(direct[1]), product: decodeURIComponent(direct[2]) }], info)) {
        const parsed = parseProductPage(html);
        if (Object.keys(parsed.prices).length) return { ...parsed, url, image: packImageFrom(html, { ogFirst: true }) };
      }
      continue;
    }
    const cands = [...html.matchAll(/href=["'](?:https?:\/\/www\.pricecharting\.com)?\/game\/([a-z0-9\-&%]+)\/([a-z0-9\-%]+)["']/gi)]
      .map((m) => ({ console: decodeURIComponent(m[1]), product: decodeURIComponent(m[2]), ref: `${PC}/game/${m[1]}/${m[2]}` }));
    const productUrl = pickProduct(cands, info)?.ref;
    if (productUrl) {
      const page = await pcFetchPage(productUrl);
      const parsed = parseProductPage(page.html);
      if (Object.keys(parsed.prices).length) return { ...parsed, url: page.url, image: packImageFrom(page.html, { ogFirst: true }) };
    }
  }
  return null;
}

// Japanese set names are in Japanese, so they can't help the search there.
const pcQueries = (info) => (info.japanese
  ? [`${info.name} ${info.number} japanese`, `${info.name} japanese ${normNum(info.number)}`]
  : [`${info.name} ${info.setName} ${info.number}`, `${info.name} ${info.number}`]);

// Every graded result PriceCharting gives us is also saved in the database (one "kv" document),
// so when PriceCharting can't be reached — or after a restart — cards keep their last real graded
// prices (marked stale with the date) instead of dropping to estimates.
const pcSaved = { map: new Map(), store: null, dirty: false, timer: null };
const PC_SAVED_KEY = 'pricecharting-graded';
const PC_SAVED_MAX = 20000;
async function attachStore(store) {
  pcSaved.store = store;
  try {
    const doc = await store.getKv(PC_SAVED_KEY);
    for (const [k, v] of Object.entries(doc || {})) pcSaved.map.set(k, v);
  } catch (e) { console.warn(`Couldn't load saved graded prices: ${e.message}`); }
}
function savePc(key, value) {
  pcSaved.map.delete(key);
  pcSaved.map.set(key, { value, at: Date.now() });
  while (pcSaved.map.size > PC_SAVED_MAX) pcSaved.map.delete(pcSaved.map.keys().next().value);
  if (!pcSaved.store || pcSaved.timer) return;
  pcSaved.timer = setTimeout(() => {
    pcSaved.timer = null;
    pcSaved.store.setKv(PC_SAVED_KEY, Object.fromEntries(pcSaved.map)).catch((e) => console.warn(`Couldn't save graded prices: ${e.message}`));
  }, 30e3);
  pcSaved.timer.unref?.();
}

// Write any not-yet-saved graded prices now (server shutting down, e.g. for a redeploy).
async function flushSavedPrices() {
  if (!pcSaved.timer || !pcSaved.store) return;
  clearTimeout(pcSaved.timer);
  pcSaved.timer = null;
  await pcSaved.store.setKv(PC_SAVED_KEY, Object.fromEntries(pcSaved.map)).catch(() => {});
}

function priceCharting(info) {
  if (!info.name || !info.number) return Promise.resolve(null);
  const key = `pc2:${info.japanese ? 'ja:' : ''}${slug(info.name)}:${slug(info.setName)}:${normNum(info.number)}:${isReverse(info.variant) ? 'rev' : ''}${is1st(info.variant) ? '1st' : ''}`;
  return cached(key, 12 * HOUR, async () => {
    try {
      const r = await (process.env.PRICECHARTING_TOKEN ? pcViaApi(info) : pcViaPage(info));
      if (r) savePc(key, r);
      return r;
    } catch (e) {
      const saved = pcSaved.map.get(key);
      if (saved) {
        // Serve the saved prices, but try PriceCharting again in a few minutes.
        setTimeout(() => cache.delete(key), 5 * 60e3).unref?.();
        return { ...saved.value, staleSince: saved.at, staleReason: e.message };
      }
      throw e;
    }
  });
}

// Admin diagnostics: one live request to PriceCharting (ignoring any pause), reporting exactly what
// came back, so a block or a page change can be told apart.
async function pcDiagnose() {
  const tests = [
    ['Product page', `${PC}/game/pokemon-base-set/charizard-4`],
    ['Search', `${PC}/search-products?type=prices&q=${encodeURIComponent('Charizard Base Set 4')}`],
  ];
  const out = [];
  for (const [label, url] of tests) {
    const t0 = Date.now();
    try {
      const res = await fetchWithTimeout(url, { headers: { Accept: 'text/html' }, redirect: 'follow' }, 20000);
      const html = await res.text();
      const parsed = parseProductPage(html);
      out.push({
        label, url, status: res.status, ms: Date.now() - t0, finalUrl: res.url,
        title: (html.match(/<title>([^<]*)<\/title>/i)?.[1] || '').trim().slice(0, 120),
        botCheck: /<title>\s*Just a moment|challenge-platform|cf-chl-/i.test(html),
        pricesFound: Object.keys(parsed.prices).length, psa10: parsed.prices['PSA 10'] ?? null, bytes: html.length,
        server: res.headers.get('server'), cfRay: res.headers.get('cf-ray'),
      });
    } catch (e) {
      out.push({ label, url, error: e.message, ms: Date.now() - t0 });
    }
  }
  return { tokenSet: !!process.env.PRICECHARTING_TOKEN, status: pcStatus(), savedGradedPrices: pcSaved.map.size, tests: out };
}

/* ---------------- Cardmarket (EUR) + exchange rate ---------------- */
// EUR → USD from the European Central Bank reference rate (via Frankfurter, free, no key).
function eurToUsd() {
  return cached('fx:eurusd', 12 * HOUR, async () => {
    for (const url of ['https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD', 'https://api.frankfurter.app/latest?from=EUR&to=USD']) {
      try {
        const r = (await getJson(url, {}, 8000)).rates?.USD;
        if (r > 0.5 && r < 2) return { rate: r, live: true };
      } catch { /* try the next one */ }
    }
    return { rate: 1.08, live: false }; // recent typical rate if the rate service is unreachable
  });
}
// Cardmarket price for this printing in EUR. Cardmarket doesn't separate 1st Edition copies,
// so those are skipped rather than priced as unlimited.
function cardmarketEur(card, variant) {
  if (is1st(variant)) return null;
  const p = card?.cardmarket?.prices;
  if (!p) return null;
  const v = isReverse(variant) ? (p.reverseHoloTrend ?? p.reverseHoloAvg30 ?? null) : (p.trendPrice ?? p.avg30 ?? p.averageSellPrice ?? null);
  return v > 0 ? +v : null;
}
// Lowest current TCGplayer listing for exactly this printing (asking price, not a sale).
function tcgplayerListing(card, variant) {
  const v = variant || defaultVariant(card) || Object.keys(card?.tcgplayer?.prices || {})[0];
  const p = v && card?.tcgplayer?.prices?.[v];
  const price = p ? (p.low ?? p.mid ?? null) : null;
  return price > 0 ? { price: +price, variant: v } : null;
}

/* ---------------- Graded estimates ---------------- */
// Typical PSA premiums over a near-mint raw copy, by raw value (cheap cards carry a much bigger
// premium because a graded slab has a floor value of its own). Vintage (WotC era) PSA 10s are
// scarcer still. Used ONLY when there are no recent graded sales, and always labelled as estimates.
const GRADE_KEYS = ['PSA 10', 'Grade 9', 'Grade 8', 'Grade 7'];
const GRADE_FLOORS = { 'PSA 10': 22, 'Grade 9': 14, 'Grade 8': 10, 'Grade 7': 8 };
function premiums(raw, vintage) {
  const m = raw < 5 ? [6, 2.6, 1.7, 1.25] : raw < 25 ? [4.5, 2, 1.45, 1.15] : raw < 100 ? [3.5, 1.7, 1.3, 1.08] : raw < 500 ? [2.8, 1.5, 1.2, 1] : [2.4, 1.35, 1.12, 0.95];
  if (vintage) { m[0] *= 2.2; m[1] *= 1.4; m[2] *= 1.15; }
  return Object.fromEntries(GRADE_KEYS.map((k, i) => [k, m[i]]));
}
// Fill missing PSA 10/9/8/7 values. When some grades have real sales, the missing ones are scaled
// from those (so the estimate agrees with the real data); otherwise from the raw price.
function fillGradedEstimates(prices, rawPrice, vintage) {
  const out = { ...prices };
  const missing = GRADE_KEYS.filter((k) => !(out[k] > 0));
  if (!missing.length) return { prices: out, estimated: [] };
  const base0 = out.Ungraded > 0 ? out.Ungraded : rawPrice;
  if (!(base0 > 0)) return { prices: out, estimated: [] };
  const m = premiums(base0, vintage);
  // Implied raw value from each real graded sale (above the slab floor, where premiums apply).
  const implied = GRADE_KEYS.filter((k) => out[k] > GRADE_FLOORS[k] * 1.5).map((k) => out[k] / m[k]);
  const base = implied.length ? implied.sort((a, b) => a - b)[implied.length >> 1] : base0;
  const mm = premiums(base, vintage);
  for (const k of missing) out[k] = Math.round(Math.max(base * mm[k], GRADE_FLOORS[k]) * 100) / 100;
  // Keep the ladder in order (a lower grade never above a higher one).
  for (let i = 1; i < GRADE_KEYS.length; i++) {
    const hi = out[GRADE_KEYS[i - 1]], k = GRADE_KEYS[i];
    if (missing.includes(k) && out[k] > hi) out[k] = Math.round(hi * 0.9 * 100) / 100;
  }
  return { prices: out, estimated: missing, basis: implied.length ? 'graded' : 'raw' };
}

/* ---------------- Japanese cards ---------------- */
// PriceCharting lists Japanese cards under their English names ("Pikachu ex #132"), so a Japanese
// card's English name is rebuilt from its Pokédex number plus any Latin suffix (ex, V, VMAX…).
const LATIN_SUFFIX = /\s*(VMAX|VSTAR|V-UNION|V|GX|EX|ex|BREAK|LV\.X)\s*$/;
function dexEnglishName(n) {
  return cached(`dexname:${n}`, 7 * 24 * HOUR, async () => {
    const cards = await ptcgSearch(`nationalPokedexNumbers:${n} supertype:pokemon`);
    const counts = new Map();
    for (const c of cards) {
      const base = String(c.name || '').replace(LATIN_SUFFIX, '').trim();
      if (base && !/['’]s\s/.test(base)) counts.set(base, (counts.get(base) || 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] || null;
  });
}
async function englishName(card) {
  if (/^[\x20-\x7e]+$/.test(card.name || '')) return card.name;
  const dex = card.nationalPokedexNumbers?.[0];
  if (!dex) return null;
  const base = await dexEnglishName(dex).catch(() => null);
  if (!base) return null;
  const suffix = String(card.name).match(LATIN_SUFFIX)?.[1];
  return suffix ? `${base} ${suffix}` : base;
}

/* ---------------- Public API ---------------- */
function cardInfo(card, variant) {
  return {
    // A reprint subset is listed under its printed (original) numbers on PriceCharting.
    id: card.id, name: card.name, setName: card.set?.name || '', number: card.printedNumber ? card.printedNumber.split('/')[0] : card.number,
    total: card.set?.printedTotal, variant: variant || defaultVariant(card),
    // Released in the last year (or undated): its numbering may not match other sites yet.
    recent: !card.set?.releaseDate || Date.now() - Date.parse(String(card.set.releaseDate).replace(/\//g, '-')) < 365 * 24 * HOUR,
  };
}
// Lookup details for the price sources (Japanese cards are looked up by English name).
async function priceInfo(card, variant) {
  const info = cardInfo(card, variant);
  if (card.lang !== 'ja') return info;
  return { ...info, name: await englishName(card), japanese: true };
}

// Raw (ungraded, near-mint) price in USD for one printing, from the first source that has one:
//   1. TCGplayer market price (Pokémon TCG API)       — recent sales
//   2. TCGplayer market price (TCGdex)                 — recent sales
//   3. PriceCharting "Ungraded"                        — recent eBay sales
//   4. Cardmarket trend price, € converted to $        — recent European sales
//   5. TCGplayer lowest current listing                — asking price (last resort)
// Sources 4–5 are marked `approx` so the app can say so.
async function rawPrice(id, variant) {
  const card = await getCard(id);
  const info = await priceInfo(card, variant);
  const tp = tcgplayerPrice(card, info.variant);
  if (tp) return { price: tp.price, source: 'TCGplayer', variant: tp.variant, updatedAt: card.tcgplayer?.updatedAt || null };
  const dex = id.startsWith('tcgdex') ? null : await tcgdexMatch(info).catch(() => null);
  const dp = dex && tcgplayerPrice(dex, info.variant);
  if (dp) return { price: dp.price, source: 'TCGplayer', variant: dp.variant, updatedAt: dex.tcgplayer?.updatedAt || null };
  const pc = await priceCharting(info).catch(() => null);
  if (pc?.prices?.Ungraded != null) return { price: pc.prices.Ungraded, source: 'PriceCharting', variant: info.variant, updatedAt: null };
  const eur = cardmarketEur(card, info.variant) ?? cardmarketEur(dex, info.variant);
  if (eur != null) {
    const fx = await eurToUsd();
    return {
      price: Math.round(eur * fx.rate * 100) / 100, source: 'Cardmarket', approx: true, variant: info.variant,
      note: `€${eur.toFixed(2)} on Cardmarket (EU), converted at ${fx.rate.toFixed(3)}${fx.live ? '' : ' (approx. rate)'}`,
      updatedAt: card.cardmarket?.updatedAt || dex?.cardmarket?.updatedAt || null,
    };
  }
  const ls = tcgplayerListing(card, info.variant) || (dex && tcgplayerListing(dex, info.variant));
  if (ls) return { price: ls.price, source: 'TCGplayer listing', approx: true, variant: ls.variant, note: 'Lowest current listing on TCGplayer — no recent sales recorded' };
  return { price: null, source: null, variant: info.variant };
}

// Everything for the card detail view: raw price + graded ladder, with a sanity check.
async function fullPrices(id, variant) {
  const card = await getCard(id);
  const info = await priceInfo(card, variant);
  const [raw, pc] = await Promise.all([
    rawPrice(id, info.variant),
    priceCharting(info).catch((e) => ({ error: e.message })),
  ]);
  let graded = null;
  if (pc && !pc.error) {
    const warnings = [];
    const ungraded = pc.prices.Ungraded;
    if (raw.price != null && ungraded != null && raw.source !== 'PriceCharting') {
      const ratio = ungraded / raw.price;
      if (ratio > 3 || ratio < 1 / 3) warnings.push(`PriceCharting's ungraded price ($${ungraded.toFixed(2)}) is far from ${raw.source}'s ($${raw.price.toFixed(2)}) — the graded match may be a different printing.`);
    }
    if (pc.prices['PSA 10'] != null && ungraded != null && pc.prices['PSA 10'] < ungraded) {
      warnings.push('PSA 10 is listed below the ungraded price, which usually means very few graded sales.');
    }
    graded = { source: 'PriceCharting', url: pc.url, title: pc.title, prices: pc.prices, warnings, staleSince: pc.staleSince || null };
  }
  // Fill grades with no recent sales (or no PriceCharting match at all) with clearly-labelled estimates.
  const vintage = /^(199\d|200[0-2])/.test(String(card.set?.releaseDate || ''));
  const est = fillGradedEstimates(graded?.prices || {}, raw.price, vintage);
  if (est.estimated.length) {
    graded = graded
      ? { ...graded, prices: est.prices, estimated: est.estimated, estimateBasis: est.basis }
      : {
        source: 'Estimate', estimated: est.estimated, estimateBasis: est.basis, prices: est.prices, warnings: [],
        url: `${PC}/search-products?type=prices&q=${encodeURIComponent(pcQueries({ ...info, name: info.name || card.name })[0])}`,
        title: null,
      };
  }
  return { raw, graded, gradedError: pc?.error || null };
}

/* ---------------- Booster pack photos (pack simulator) ---------------- */
// The set's sealed "Booster Pack" product on PriceCharting carries a photo of the real pack.
const PC_IMG = /^https:\/\/(storage\.googleapis\.com\/images\.pricecharting\.com\/|www\.pricecharting\.com\/)/;
function packImageFrom(html, { ogFirst = false } = {}) {
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  const gcs = html.match(/https:\/\/storage\.googleapis\.com\/images\.pricecharting\.com\/[A-Za-z0-9/_.-]+\.(?:jpe?g|png|webp)/i);
  for (const u of ogFirst ? [og?.[1], gcs?.[0]] : [gcs?.[0], og?.[1]]) {
    if (!u) continue;
    const url = u.replace(/&amp;/g, '&');
    if (PC_IMG.test(url) && !/logo|favicon|default/i.test(url)) return url;
  }
  return null;
}
function boosterImage(setName) {
  return cached(`packimg:${slug(setName)}`, 7 * 24 * HOUR, async () => {
    // Direct product URLs first (PriceCharting names the set's console "Pokemon <Set>").
    const consoles = [...new Set([
      `pokemon-${slug(setName)}`,
      `pokemon-${String(setName).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9&]+/g, '-').replace(/^-+|-+$/g, '')}`,
    ])];
    for (const c of consoles) {
      try {
        const { url, html } = await pcFetchPage(`${PC}/game/${c}/booster-pack`);
        if (/\/booster-pack(?:$|[?#])/.test(new URL(url).pathname)) {
          const img = packImageFrom(html);
          if (img) return img;
        }
      } catch (e) {
        if (!/responded 404/.test(e.message)) throw e;
      }
    }
    // Otherwise search for it.
    const { url, html } = await pcFetchPage(`${PC}/search-products?type=prices&q=${encodeURIComponent(`${setName} booster pack`)}`);
    if (/\/game\/[^/]+\/booster-pack/.test(new URL(url).pathname)) return packImageFrom(html);
    const link = [...html.matchAll(/href=["'](?:https?:\/\/www\.pricecharting\.com)?\/game\/([a-z0-9\-&%]+)\/booster-pack["']/gi)]
      .map((m) => decodeURIComponent(m[1]))
      .find((c) => !/japanese|chinese|korean/.test(c) && setMatches(setName, c.replace(/^pokemon-/, '')));
    if (!link) return null;
    return packImageFrom((await pcFetchPage(`${PC}/game/${link}/booster-pack`)).html);
  });
}

/* ---------------- Card images: fallback sources ---------------- */
// Every place a card's picture might live, best first: the card's own image, the other size,
// the Pokémon TCG API's predictable URLs, and TCGdex's copy (webp, png or jpg).
async function imageCandidates(id, size = 'small') {
  const other = size === 'large' ? 'small' : 'large';
  const urls = [];
  const add = (u) => { if (typeof u === 'string' && /^https:\/\//.test(u) && !urls.includes(u)) urls.push(u); };
  const addDex = (u) => {
    const m = typeof u === 'string' && u.match(/^(https:\/\/assets\.tcgdex\.net\/.*)\/(low|high)\.(webp|png|jpg)$/);
    if (!m) return add(u);
    for (const q of size === 'large' ? ['high', 'low'] : ['low', 'high']) for (const ext of ['webp', 'png', 'jpg']) add(`${m[1]}/${q}.${ext}`);
  };
  const card = await getCard(id).catch(() => null);
  add(card?.images?.[size]);
  add(card?.images?.[other]);
  add(card?.images?.alt);
  const { source, lang, ref } = parseId(id);
  if (source === 'ptcg') {
    const cut = ref.lastIndexOf('-');
    const setId = card?.set?.id || ref.slice(0, cut), num = card?.number || ref.slice(cut + 1);
    if (/^[a-z0-9.]+$/i.test(setId) && /^[a-z0-9]+$/i.test(num)) {
      for (const hi of size === 'large' ? ['_hires', ''] : ['', '_hires']) add(`https://images.pokemontcg.io/${setId}/${num}${hi}.png`);
    }
    if (card) {
      const dex = await tcgdexMatch(cardInfo(card)).catch(() => null);
      addDex(dex?.images?.[size]);
    }
  } else {
    addDex(card?.images?.[size]);
    // An English TCGdex card may have a Pokémon TCG API twin with a working picture.
    if (lang === 'en' && card && ptcgUp()) {
      const twins = await ptcgSearch(buildQueries({ name: card.name, number: card.number })[0] || '').catch(() => []);
      const twin = twins.find((c) => numEq(c.number, card.number) && slug(c.name) === slug(card.name)
        && setMatches(card.set?.name, c.set?.name, card.set?.printedTotal, c.set?.printedTotal));
      add(twin?.images?.[size]);
      add(twin?.images?.[other]);
    }
  }
  return urls;
}
// Last resort when none of those load (brand-new sets the card databases haven't pictured yet):
// the photo on the card's PriceCharting page.
// Only for English cards from sets released in the last year (what it's for: brand-new sets), and a
// miss is remembered for 6 hours — picture requests must never crowd out price lookups.
const pcImgMiss = new Map(); // card id -> retry after
async function pcCardImage(id) {
  if ((pcImgMiss.get(id) || 0) > Date.now()) return null;
  const card = await getCard(id).catch(() => null);
  if (!card || card.lang === 'ja' || !cardInfo(card).recent) return null;
  const pc = await priceCharting(await priceInfo(card)).catch(() => null);
  const img = pc?.image && PC_IMG.test(pc.image) ? pc.image : null;
  if (!img) {
    pcImgMiss.set(id, Date.now() + 6 * HOUR);
    if (pcImgMiss.size > 5000) pcImgMiss.delete(pcImgMiss.keys().next().value);
  }
  return img;
}

module.exports = {
  search, getCard, primeCards, rawPrice, fullPrices, imageCandidates, pcCardImage, parseId, boosterImage, PC_IMG, pcStatus,
  attachStore, flushSavedPrices, pcDiagnose, tpBoosterImages,
  _test: { packImageFrom, scoreProduct, pickProduct, parseProductPage, setMatches, buildQueries, fromTcgdex, fillGradedEstimates, cardmarketEur, englishName, tcgdexSearch, cache },
};
