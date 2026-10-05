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
const TCGDEX = 'https://api.tcgdex.net/v2/en';
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
const words = (s) => slug(s).split('-').filter((w) => w && !['pokemon', 'set', 'and', 'the', 'tcg'].includes(w));
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
  const missing = ids.filter((id) => !id.startsWith('tcgdex:') && !(cache.get(`card:${id}`)?.expires > Date.now()));
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    const q = '(' + chunk.map((id) => `id:"${id.replace(/"/g, '')}"`).join(' OR ') + ')';
    const res = await ptcgJson(`${POKEMONTCG}/cards?${new URLSearchParams({ q, pageSize: '100' })}`);
    for (const c of res.data || []) cache.set(`card:${c.id}`, { promise: Promise.resolve(c), expires: Date.now() + 6 * HOUR });
  }
}

/* ---------------- TCGdex ---------------- */
const camel = (k) => k.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
function tcgdexFull(id) {
  return cached(`dex-full:${id}`, 12 * HOUR, () => getJson(`${TCGDEX}/cards/${encodeURIComponent(id)}`));
}
// Convert a TCGdex card into the same shape the Pokémon TCG API uses.
function fromTcgdex(c) {
  const tp = c.pricing?.tcgplayer || {};
  const prices = {};
  for (const [k, v] of Object.entries(tp)) {
    if (!v || typeof v !== 'object') continue;
    prices[camel(k)] = { low: v.lowPrice ?? null, mid: v.midPrice ?? null, high: v.highPrice ?? null, market: v.marketPrice ?? null };
  }
  const cm = c.pricing?.cardmarket;
  return {
    id: `tcgdex:${c.id}`,
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
      id: c.set?.id, name: c.set?.name,
      printedTotal: c.set?.cardCount?.official, total: c.set?.cardCount?.total,
      images: { symbol: c.set?.symbol ? `${c.set.symbol}.png` : undefined, logo: c.set?.logo ? `${c.set.logo}.png` : undefined },
    },
    images: c.image ? { small: `${c.image}/low.webp`, large: `${c.image}/high.webp` } : {},
    tcgplayer: Object.keys(prices).length ? { updatedAt: tp.updated || null, prices } : undefined,
    cardmarket: cm ? { updatedAt: cm.updated || null, prices: { trendPrice: cm.trend, averageSellPrice: cm.avg, avg30: cm.avg30, lowPrice: cm.low } } : undefined,
  };
}

async function tcgdexSearch({ name, number, total }) {
  if (!name && !number) return [];
  const key = `dex-search:${slug(name)}:${normNum(number)}:${total || ''}`;
  return cached(key, 30 * 60e3, async () => {
    let list = [];
    if (name) list = await getJson(`${TCGDEX}/cards?name=${encodeURIComponent(name)}`);
    else list = await getJson(`${TCGDEX}/cards?localId=${encodeURIComponent('eq:' + number)}`);
    list = Array.isArray(list) ? list : [];
    if (number) list = list.filter((c) => numEq(c.localId, number));
    // Newest first is a decent default when there's no number to narrow it down.
    const full = (await mapLimit(list.slice(-40).reverse(), 8, (b) => tcgdexFull(b.id).catch(() => null))).filter(Boolean);
    let cards = full.map(fromTcgdex);
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
    if (id.startsWith('tcgdex:')) return fromTcgdex(await tcgdexFull(id.slice(7)));
    return (await ptcgJson(`${POKEMONTCG}/cards/${encodeURIComponent(id)}`)).data;
  });
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

// Score a PriceCharting product (console slug + product slug) against our card.
// Returns -1 unless name, number, set and printing all match.
function scoreProduct(consoleSlug, productSlug, { name, setName, number, variant }) {
  consoleSlug = slug(consoleSlug); productSlug = slug(productSlug);
  if (!consoleSlug.startsWith('pokemon') || /japanese|chinese|korean|german|french|italian|spanish/.test(consoleSlug)) return -1;
  const segs = productSlug.split('-');
  if (!number || normNum(segs.at(-1)) !== normNum(number)) return -1;
  const base = segs.slice(0, -1).join('-');
  const nameSlug = slug(name);
  if (!nameSlug || (base !== nameSlug && !base.startsWith(`${nameSlug}-`))) return -1;
  const tags = base.slice(nameSlug.length);
  // Extra words may only describe the printing ("[Shadowless]", "[Reverse Holo]"); anything else
  // ("ex", "V", "GX"…) means it's a different card.
  if (tags.split('-').filter(Boolean).some((w) => !PRINTING_WORDS.has(w))) return -1;
  if (/reverse-holo/.test(tags) !== isReverse(variant)) return -1;
  if (/1st-edition/.test(tags) !== is1st(variant)) return -1;
  const ours = words(setName);
  const theirs = words(consoleSlug);
  const hit = ours.filter((w) => theirs.includes(w)).length;
  if (!ours.length || hit / ours.length < 0.5) return -1;
  // Prefer exact set names and plain products over tagged ones ("[Shadowless]", "[Cosmos Holo]").
  return 10 + hit * 2 - (theirs.length - hit) - tags.split('-').filter(Boolean).length * 2;
}

async function pcViaApi(info) {
  const token = process.env.PRICECHARTING_TOKEN;
  for (const q of [`${info.name} ${info.setName} ${info.number}`, `${info.name} ${info.number}`]) {
    const res = await pcLimit(() => getJson(`${PC}/api/products?t=${encodeURIComponent(token)}&q=${encodeURIComponent(q)}`));
    let best = null, bestScore = -1;
    for (const p of res.products || []) {
      const sc = scoreProduct(p['console-name'], p['product-name'], info);
      if (sc > bestScore) { best = p; bestScore = sc; }
    }
    if (best) {
      const p = await pcLimit(() => getJson(`${PC}/api/product?t=${encodeURIComponent(token)}&id=${encodeURIComponent(best.id)}`));
      const prices = {};
      for (const [field, label] of PC_API_FIELDS) if (p[field] > 0) prices[label] = p[field] / 100;
      return {
        title: `${p['product-name']} · ${p['console-name']}`,
        url: `${PC}/game/${slug(p['console-name'])}/${slug(p['product-name'])}`,
        prices,
      };
    }
  }
  return null;
}

async function pcFetchPage(url) {
  const res = await pcLimit(() => fetchWithTimeout(url, { headers: { Accept: 'text/html' }, redirect: 'follow' }));
  if (!res.ok) throw new Error(`PriceCharting responded ${res.status}`);
  return { url: res.url || url, html: await res.text() };
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
  for (const q of [`${info.name} ${info.setName} ${info.number}`, `${info.name} ${info.number}`]) {
    const { url, html } = await pcFetchPage(`${PC}/search-products?type=prices&q=${encodeURIComponent(q)}`);
    const direct = new URL(url).pathname.match(/\/game\/([^/]+)\/([^/?#]+)/);
    if (direct) {
      // Search jumped straight to a product page — use it only if it's the right card.
      if (scoreProduct(decodeURIComponent(direct[1]), decodeURIComponent(direct[2]), info) >= 0) {
        const parsed = parseProductPage(html);
        if (Object.keys(parsed.prices).length) return { ...parsed, url };
      }
      continue;
    }
    let productUrl = null, bestScore = -1;
    for (const m of html.matchAll(/href=["'](?:https?:\/\/www\.pricecharting\.com)?\/game\/([a-z0-9\-&%]+)\/([a-z0-9\-%]+)["']/gi)) {
      const sc = scoreProduct(decodeURIComponent(m[1]), decodeURIComponent(m[2]), info);
      if (sc > bestScore) { bestScore = sc; productUrl = `${PC}/game/${m[1]}/${m[2]}`; }
    }
    if (productUrl) {
      const page = await pcFetchPage(productUrl);
      const parsed = parseProductPage(page.html);
      if (Object.keys(parsed.prices).length) return { ...parsed, url: page.url };
    }
  }
  return null;
}

function priceCharting(info) {
  if (!info.name || !info.number) return Promise.resolve(null);
  const key = `pc:${slug(info.name)}:${slug(info.setName)}:${normNum(info.number)}:${isReverse(info.variant) ? 'rev' : ''}${is1st(info.variant) ? '1st' : ''}`;
  return cached(key, 12 * HOUR, () => (process.env.PRICECHARTING_TOKEN ? pcViaApi(info) : pcViaPage(info)));
}

/* ---------------- Public API ---------------- */
function cardInfo(card, variant) {
  return {
    id: card.id, name: card.name, setName: card.set?.name || '', number: card.number,
    total: card.set?.printedTotal, variant: variant || defaultVariant(card),
  };
}

// Raw (ungraded, near-mint) market price in USD for one printing:
// TCGplayer market (Pokémon TCG API) → TCGplayer market (TCGdex) → PriceCharting "Ungraded".
async function rawPrice(id, variant) {
  const card = await getCard(id);
  const info = cardInfo(card, variant);
  const tp = tcgplayerPrice(card, info.variant);
  if (tp) return { price: tp.price, source: 'TCGplayer', variant: tp.variant, updatedAt: card.tcgplayer?.updatedAt || null };
  if (!id.startsWith('tcgdex:')) {
    const dex = await tcgdexMatch(info).catch(() => null);
    const dp = dex && tcgplayerPrice(dex, info.variant);
    if (dp) return { price: dp.price, source: 'TCGplayer', variant: dp.variant, updatedAt: dex.tcgplayer?.updatedAt || null };
  }
  const pc = await priceCharting(info).catch(() => null);
  if (pc?.prices?.Ungraded != null) return { price: pc.prices.Ungraded, source: 'PriceCharting', variant: info.variant, updatedAt: null };
  return { price: null, source: null, variant: info.variant };
}

// Everything for the card detail view: raw price + graded ladder, with a sanity check.
async function fullPrices(id, variant) {
  const card = await getCard(id);
  const info = cardInfo(card, variant);
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
      if (ratio > 3 || ratio < 1 / 3) warnings.push(`PriceCharting's ungraded price ($${ungraded.toFixed(2)}) is far from TCGplayer's ($${raw.price.toFixed(2)}) — the graded match may be a different printing.`);
    }
    if (pc.prices['PSA 10'] != null && ungraded != null && pc.prices['PSA 10'] < ungraded) {
      warnings.push('PSA 10 is listed below the ungraded price, which usually means very few graded sales.');
    }
    graded = { source: 'PriceCharting', url: pc.url, title: pc.title, prices: pc.prices, warnings };
  }
  return { raw, graded, gradedError: pc?.error || null };
}

module.exports = { search, getCard, primeCards, rawPrice, fullPrices, _test: { scoreProduct, parseProductPage, setMatches, buildQueries, fromTcgdex, cache } };
