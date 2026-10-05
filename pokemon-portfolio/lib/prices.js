'use strict';
// Card data + price sources, all fetched server-side (no CORS issues, API keys stay secret).
//
//   Pokémon TCG API  – card search/details + TCGplayer market prices per printing
//   TCGdex           – free fallback for TCGplayer/Cardmarket prices when the above has none
//   PriceCharting    – raw (ungraded) fallback + graded prices (PSA 10, Grade 9 … 1, BGS/CGC/SGC 10)
//                      via the official API when PRICECHARTING_TOKEN is set, otherwise by
//                      reading the public product page.

const POKEMONTCG = 'https://api.pokemontcg.io/v2';
const TCGDEX = 'https://api.tcgdex.net/v2/en';
const PC = 'https://www.pricecharting.com';
const UA = 'Mozilla/5.0 (compatible; PokeFolio/2.0; +https://github.com/)';

const HOUR = 3600e3;

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
  } finally {
    clearTimeout(t);
  }
}
async function getJson(url, headers) {
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json', ...headers } });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res.json();
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
const numEq = (a, b) => {
  const na = String(a || '').replace(/^0+(?=\d)/, '').toLowerCase();
  const nb = String(b || '').replace(/^0+(?=\d)/, '').toLowerCase();
  return na && na === nb;
};
const money = (s) => {
  const m = String(s || '').replace(/,/g, '').match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  return m ? +m[1] : null;
};

/* ---------------- Pokémon TCG API ---------------- */
function ptcgHeaders() {
  return process.env.POKEMONTCG_API_KEY ? { 'X-Api-Key': process.env.POKEMONTCG_API_KEY } : {};
}
function searchCards({ q, pageSize = 36, orderBy = '-set.releaseDate', select = '' }) {
  const params = new URLSearchParams({ q, pageSize: String(Math.min(+pageSize || 36, 100)), orderBy });
  if (select) params.set('select', select);
  const url = `${POKEMONTCG}/cards?${params}`;
  return cached(`ptcg:${url}`, 30 * 60e3, () => getJson(url, ptcgHeaders()));
}
function getCard(id) {
  return cached(`ptcg-card:${id}`, 6 * HOUR, async () => (await getJson(`${POKEMONTCG}/cards/${encodeURIComponent(id)}`, ptcgHeaders())).data);
}

// Fetch many cards in a few requests and seed the per-card cache.
async function primeCards(ids) {
  const missing = ids.filter((id) => !(cache.get(`ptcg-card:${id}`)?.expires > Date.now()));
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    const q = '(' + chunk.map((id) => `id:"${id.replace(/"/g, '')}"`).join(' OR ') + ')';
    const res = await getJson(`${POKEMONTCG}/cards?${new URLSearchParams({ q, pageSize: '100' })}`, ptcgHeaders());
    for (const c of res.data || []) cache.set(`ptcg-card:${c.id}`, { promise: Promise.resolve(c), expires: Date.now() + 6 * HOUR });
  }
}

function tcgplayerPrice(card, variant) {
  const prices = card?.tcgplayer?.prices || {};
  const pick = (v) => prices[v] && (prices[v].market ?? prices[v].mid ?? null);
  if (variant && pick(variant) != null) return { price: pick(variant), variant };
  for (const v of ['holofoil', 'normal', '1stEditionHolofoil', 'unlimitedHolofoil', 'reverseHolofoil', '1stEditionNormal', ...Object.keys(prices)]) {
    if (pick(v) != null) return { price: pick(v), variant: v };
  }
  return null;
}

/* ---------------- TCGdex ---------------- */
async function tcgdexCard({ name, number, total, setName }) {
  if (!name || !number) return null;
  const key = `tcgdex:${slug(name)}:${number}:${total}:${slug(setName)}`;
  return cached(key, 12 * HOUR, async () => {
    const list = await getJson(`${TCGDEX}/cards?name=${encodeURIComponent('eq:' + name)}`);
    const candidates = (Array.isArray(list) ? list : []).filter((c) => numEq(c.localId, number)).slice(0, 6);
    let best = null, bestScore = -1;
    for (const brief of candidates) {
      const full = await getJson(`${TCGDEX}/cards/${encodeURIComponent(brief.id)}`).catch(() => null);
      if (!full) continue;
      let score = 0;
      if (total && +full.set?.cardCount?.official === +total) score += 3;
      const sw = new Set(words(full.set?.name));
      score += words(setName).filter((w) => sw.has(w)).length;
      if (slug(full.set?.name) === slug(setName)) score += 5;
      if (score > bestScore) { best = full; bestScore = score; }
    }
    return candidates.length === 1 || bestScore > 0 ? best : null;
  });
}
function tcgdexPrice(card, variant) {
  const tp = card?.pricing?.tcgplayer;
  if (tp && typeof tp === 'object') {
    const entries = Object.entries(tp).filter(([, v]) => v && typeof v === 'object');
    const want = normKey(variant);
    const val = (v) => v.marketPrice ?? v.market ?? v.midPrice ?? v.mid ?? null;
    const exact = entries.find(([k, v]) => normKey(k) === want && val(v) != null);
    const any = exact || entries.find(([, v]) => val(v) != null);
    if (any) return { price: +val(any[1]), source: 'TCGplayer (via TCGdex)' };
  }
  return null;
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

// Score how well a PriceCharting product (console slug + product slug) matches our card.
function scoreProduct(consoleSlug, productSlug, { name, setName, number, variant }) {
  if (!consoleSlug.startsWith('pokemon')) return -99;
  let s = 0;
  const nameSlug = slug(name);
  if (productSlug === `${nameSlug}-${slug(number)}`) s += 12;
  else if (productSlug.startsWith(nameSlug)) s += 6;
  else if (productSlug.includes(nameSlug)) s += 3;
  else return -99;
  if (number && new RegExp(`(^|-)${slug(String(number).replace(/^0+(?=\d)/, ''))}($|-)`).test(productSlug.replace(/-0+(\d)/g, '-$1'))) s += 6;
  else if (number) s -= 6;
  const cw = new Set(words(consoleSlug));
  const sw = words(setName);
  s += sw.filter((w) => cw.has(w)).length * 2;
  if (sw.length && sw.every((w) => cw.has(w))) s += 3;
  // Penalise extra console words ("base-set-2" when we want "Base").
  const swSet = new Set(sw);
  s -= [...cw].filter((w) => !swSet.has(w)).length;
  if (/japanese|chinese|korean/.test(consoleSlug)) s -= 15;
  const wantsReverse = /reverse/i.test(variant || '');
  const wants1st = /1stedition/i.test(normKey(variant));
  if (/reverse-holo/.test(productSlug) !== wantsReverse) s -= 4;
  if (/1st-edition/.test(productSlug + consoleSlug) !== wants1st) s -= 3;
  return s;
}

async function pcViaApi(info) {
  const token = process.env.PRICECHARTING_TOKEN;
  const queries = [`${info.name} ${info.setName} ${info.number}`, `${info.name} ${info.number}`];
  for (const q of queries) {
    const res = await pcLimit(() => getJson(`${PC}/api/products?t=${encodeURIComponent(token)}&q=${encodeURIComponent(q)}`));
    const products = res.products || [];
    let best = null, bestScore = 0;
    for (const p of products) {
      const sc = scoreProduct(slug(p['console-name']), slug(p['product-name']), info);
      if (sc > bestScore) { best = p; bestScore = sc; }
    }
    if (best && bestScore >= 10) {
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
  const queries = [`${info.name} ${info.setName} ${info.number}`, `${info.name} ${info.number}`];
  for (const q of queries) {
    const { url, html } = await pcFetchPage(`${PC}/search-products?type=prices&q=${encodeURIComponent(q)}`);
    let productUrl = null;
    if (/\/game\/[^/]+\/[^/?#]+/.test(new URL(url).pathname)) {
      // Search jumped straight to a product page — make sure it is the right card.
      const [, c, p] = new URL(url).pathname.match(/\/game\/([^/]+)\/([^/?#]+)/);
      if (scoreProduct(c, p, info) >= 10) {
        const parsed = parseProductPage(html);
        if (Object.keys(parsed.prices).length) return { ...parsed, url };
      }
    }
    let bestScore = 0;
    for (const m of html.matchAll(/href=["'](?:https?:\/\/www\.pricecharting\.com)?\/game\/([a-z0-9\-&%]+)\/([a-z0-9\-%]+)["']/gi)) {
      const sc = scoreProduct(decodeURIComponent(m[1]).toLowerCase(), decodeURIComponent(m[2]).toLowerCase(), info);
      if (sc > bestScore) { bestScore = sc; productUrl = `${PC}/game/${m[1]}/${m[2]}`; }
    }
    if (productUrl && bestScore >= 10) {
      const page = await pcFetchPage(productUrl);
      const parsed = parseProductPage(page.html);
      if (Object.keys(parsed.prices).length) return { ...parsed, url: page.url };
    }
  }
  return null;
}

function priceCharting(info) {
  if (!info.name) return Promise.resolve(null);
  const key = `pc:${slug(info.name)}:${slug(info.setName)}:${info.number}:${normKey(info.variant).includes('reverse') ? 'rev' : ''}${normKey(info.variant).includes('1stedition') ? '1st' : ''}`;
  return cached(key, 12 * HOUR, () => (process.env.PRICECHARTING_TOKEN ? pcViaApi(info) : pcViaPage(info)));
}

/* ---------------- Public API ---------------- */
function cardInfo(card, variant) {
  return {
    id: card.id, name: card.name, setName: card.set?.name || '', setId: card.set?.id || '',
    number: card.number, total: card.set?.printedTotal, variant,
  };
}

// Raw (ungraded) market price in USD: TCGplayer → TCGdex → PriceCharting "Ungraded".
async function rawPrice(id, variant) {
  const card = await getCard(id);
  const info = cardInfo(card, variant);
  const tp = tcgplayerPrice(card, variant);
  if (tp) return { price: tp.price, source: 'TCGplayer', variant: tp.variant, updatedAt: card.tcgplayer?.updatedAt || null };
  const dex = await tcgdexCard(info).catch(() => null);
  const dp = tcgdexPrice(dex, variant);
  if (dp) return { ...dp, updatedAt: dex.pricing?.tcgplayer?.updated || null };
  const pc = await priceCharting(info).catch(() => null);
  if (pc?.prices?.Ungraded != null) return { price: pc.prices.Ungraded, source: 'PriceCharting', updatedAt: null };
  return { price: null, source: null };
}

// Everything for the card detail view: raw price + graded ladder.
async function fullPrices(id, variant) {
  const card = await getCard(id);
  const info = cardInfo(card, variant);
  const [raw, pc] = await Promise.all([
    rawPrice(id, variant),
    priceCharting(info).catch((e) => ({ error: e.message })),
  ]);
  return {
    raw,
    graded: pc && !pc.error ? { source: 'PriceCharting', url: pc.url, title: pc.title, prices: pc.prices } : null,
    gradedError: pc?.error || null,
  };
}

module.exports = { searchCards, getCard, primeCards, rawPrice, fullPrices, _test: { scoreProduct, parseProductPage, slug, cache } };
