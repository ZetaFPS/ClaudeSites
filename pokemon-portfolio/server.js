'use strict';
// PokéFolio server — static frontend + accounts + portfolio sync + price aggregation.
// Dependencies: pg (PostgreSQL) and sharp (card fingerprints for the scanner's visual index).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createStore } = require('./lib/store');
const { createAuth, httpError } = require('./lib/auth');
const prices = require('./lib/prices');
const { createLeaderboard } = require('./lib/leaderboard');
const { createGroupsApi, sniffImage } = require('./lib/groups');
const { createVisualIndex, liteCard } = require('./lib/visualIndex');
const { createCatalog } = require('./lib/catalog');
const { createPacks } = require('./lib/packs');
const CardDescriptor = require('./public/descriptor');

const PORT = +process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const COOKIE = 'pf_session';
const MAX_BODY = 10 * 1024 * 1024;

let store, auth, leaderboard, groupsApi, visualIndex, catalog, packs; // set up in start()

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

/* ---------------- helpers ---------------- */
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(httpError(413, 'Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(httpError(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isHttps(req) {
  return req.socket.encrypted || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function sessionCookie(req, token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

const clientIp = (req) => (process.env.TRUST_PROXY ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress;

// Fixed-window rate limiter per IP.
function rateLimit(name, max, windowMs) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req) => {
    const k = clientIp(req);
    const n = (hits.get(k) || 0) + 1;
    hits.set(k, n);
    if (n > max) throw httpError(429, `Too many ${name} requests — try again shortly.`);
  };
}
const limitAuth = rateLimit('sign-in', 20, 15 * 60e3);
const limitApi = rateLimit('lookup', 240, 60e3);
const limitAvatar = rateLimit('picture upload', 20, 15 * 60e3);

// Reject cross-site writes (cookies are SameSite=Lax, this is belt-and-braces).
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try { host = new URL(origin).host; } catch { throw httpError(403, 'Bad origin.'); }
  if (host !== req.headers.host) throw httpError(403, 'Cross-site request blocked.');
}

async function requireUser(req) {
  const user = await auth.userForToken(cookies(req)[COOKIE]);
  if (!user) throw httpError(401, 'Please sign in.');
  return user;
}

/* ---------------- routes ---------------- */
async function api(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD') {
    checkOrigin(req);
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw httpError(415, 'Expected JSON.');
  }

  // --- status: is account storage permanent? ---
  if (pathname === '/api/health' && method === 'GET') {
    return send(res, 200, {
      ok: true,
      storage: store.kind === 'postgres' ? 'postgres' : 'file',
      persistent: storagePersistent(),
      hosted: isHosted(),
    });
  }

  // --- accounts ---
  if (pathname === '/api/auth/me' && method === 'GET') {
    const user = await auth.userForToken(cookies(req)[COOKIE]);
    return send(res, 200, { user: user ? auth.publicUser(user) : null });
  }
  if (pathname === '/api/auth/signup' && method === 'POST') {
    limitAuth(req);
    const user = await auth.signup(await readBody(req));
    const s = await auth.createSession(user.id);
    return send(res, 201, { user: auth.publicUser(user) }, { 'Set-Cookie': sessionCookie(req, s.token, s.maxAge) });
  }
  if (pathname === '/api/auth/login' && method === 'POST') {
    limitAuth(req);
    const user = await auth.login(await readBody(req));
    const s = await auth.createSession(user.id);
    return send(res, 200, { user: auth.publicUser(user) }, { 'Set-Cookie': sessionCookie(req, s.token, s.maxAge) });
  }
  if (pathname === '/api/auth/logout' && method === 'POST') {
    await auth.destroySession(cookies(req)[COOKIE]);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  // --- account settings ---
  if (pathname === '/api/account' && method === 'PUT') {
    const user = await requireUser(req);
    const body = await readBody(req);
    const fields = {};
    if (typeof body.showOnLeaderboard === 'boolean') fields.showOnLeaderboard = body.showOnLeaderboard;
    if (typeof body.name === 'string') {
      const name = body.name.trim().slice(0, 40);
      if (!name) throw httpError(400, 'Display name can’t be empty.');
      fields.name = name;
    }
    const updated = await store.updateUser(user.id, fields);
    leaderboard.invalidate();
    return send(res, 200, { user: auth.publicUser(updated) });
  }

  // --- profile picture ---
  // PUT { image: base64 JPEG/PNG/WebP } sets it (the app sends a 256×256 square); { image: null } removes it.
  if (pathname === '/api/account/avatar' && method === 'PUT') {
    const user = await requireUser(req);
    limitAvatar(req);
    const { image } = await readBody(req);
    let img = null;
    if (image != null) {
      if (typeof image !== 'string' || image.length > 1.4e6) throw httpError(400, 'That picture is too large (max 1 MB).');
      const data = Buffer.from(image.replace(/^data:[^,]*,/, ''), 'base64');
      const mime = sniffImage(data);
      if (!mime || mime === 'image/gif') throw httpError(400, 'Use a JPEG, PNG or WebP picture.');
      img = { mime, data };
    }
    const updated = await store.setAvatar(user.id, img);
    leaderboard.invalidate();
    return send(res, 200, { user: auth.publicUser(updated) });
  }
  const av = pathname.match(/^\/api\/avatar\/([A-Za-z0-9_-]{1,64})$/);
  if (av && method === 'GET') {
    const a = await store.getAvatar(av[1]);
    if (!a) throw httpError(404, 'No picture.');
    res.writeHead(200, {
      'Content-Type': a.mime, 'Content-Length': a.data.length,
      'Cache-Control': url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'",
    });
    return res.end(a.data);
  }

  // --- one card's details (used when opening a card from someone's profile) ---
  const cm = decodeURIComponent(pathname).match(/^\/api\/card\/([A-Za-z0-9._:-]{1,80})$/);
  if (cm && method === 'GET') {
    limitApi(req);
    return send(res, 200, { card: await prices.getCard(cm[1]) });
  }

  // --- leaderboard ---
  if (pathname === '/api/leaderboard' && method === 'GET') {
    limitApi(req);
    const user = await auth.userForToken(cookies(req)[COOKIE]);
    return send(res, 200, await leaderboard.view(user?.id));
  }

  // --- portfolio sync ---
  if (pathname === '/api/portfolio') {
    const user = await requireUser(req);
    if (method === 'GET') {
      return send(res, 200, (await store.getPortfolio(user.id)) || { items: [], history: {}, pricesUpdatedAt: 0, updatedAt: 0 });
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      if (!Array.isArray(body.items) || body.items.length > 10000) throw httpError(400, 'Invalid portfolio.');
      const history = body.history && typeof body.history === 'object' && !Array.isArray(body.history) ? body.history : {};
      const doc = { items: body.items, history, pricesUpdatedAt: +body.pricesUpdatedAt || 0, priceVersion: +body.priceVersion || 0, updatedAt: Date.now() };
      await store.putPortfolio(user.id, doc);
      leaderboard.markDirty();
      return send(res, 200, { ok: true, updatedAt: doc.updatedAt });
    }
  }

  // --- card search (Pokémon TCG API with TCGdex fallback) ---
  if (pathname === '/api/search' && method === 'GET') {
    limitApi(req);
    const p = url.searchParams;
    const parsed = {
      name: (p.get('name') || '').slice(0, 80),
      number: (p.get('number') || '').slice(0, 12) || null,
      total: (p.get('total') || '').slice(0, 4) || null,
      setCode: (p.get('setCode') || '').slice(0, 6) || null,
      lang: p.get('lang') === 'ja' ? 'ja' : null,
    };
    if (!parsed.name && !parsed.number) throw httpError(400, 'Enter a card name or number.');
    return send(res, 200, await prices.search(parsed));
  }

  // --- raw prices for many cards (portfolio refresh / search results) ---
  if (pathname === '/api/prices/raw' && method === 'POST') {
    limitApi(req);
    const { cards } = await readBody(req);
    if (!Array.isArray(cards) || cards.length > 500) throw httpError(400, 'Send up to 500 cards.');
    const list = cards.filter((c) => c && typeof c.id === 'string' && c.id.length < 64);
    await prices.primeCards([...new Set(list.map((c) => c.id))]).catch(() => {});
    const out = {};
    let i = 0;
    const worker = async () => {
      while (i < list.length) {
        const c = list[i++];
        const key = `${c.id}|${c.variant || ''}`;
        out[key] = await prices.rawPrice(c.id, c.variant || null).catch((e) => ({ price: null, error: e.message }));
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return send(res, 200, { prices: out, at: Date.now() });
  }

  // --- PSA 10 value for many cards (portfolio sort: "Highest PSA potential") ---
  if (pathname === '/api/prices/psa' && method === 'POST') {
    limitApi(req);
    const { cards } = await readBody(req);
    if (!Array.isArray(cards) || cards.length > 25) throw httpError(400, 'Send up to 25 cards.');
    const list = cards.filter((c) => c && typeof c.id === 'string' && c.id.length < 64);
    const out = {};
    let i = 0;
    // One at a time: PriceCharting refuses bursts, and a refusal would turn a real price into a rough estimate.
    await Promise.all(Array.from({ length: 1 }, async () => {
      while (i < list.length) {
        const c = list[i++];
        const key = `${c.id}|${c.variant || ''}`;
        try {
          const r = await prices.fullPrices(c.id, typeof c.variant === 'string' ? c.variant.slice(0, 40) : null);
          const psa10 = r.graded?.prices?.['PSA 10'] ?? null;
          // retry: PriceCharting couldn't be reached, so this is only a stand-in estimate.
          out[key] = { psa10, estimated: !!r.graded?.estimated?.includes('PSA 10'), raw: r.raw?.price ?? null, retry: !!r.gradedError };
        } catch (e) {
          out[key] = { psa10: null, error: e.message, retry: true };
        }
      }
    }));
    return send(res, 200, { prices: out, at: Date.now() });
  }

  // --- card index: every card, a page at a time (newest set first by default) ---
  if (pathname === '/api/card-index' && method === 'POST') {
    limitApi(req);
    const b = await readBody(req);
    const owned = Array.isArray(b.owned) ? b.owned.filter((x) => typeof x === 'string' && x.length < 80).slice(0, 20000) : [];
    return send(res, 200, catalog.query({
      sort: ['newest', 'oldest', 'name', 'rarity', 'set', 'collection'].includes(b.sort) ? b.sort : 'newest',
      lang: ['en', 'ja'].includes(b.lang) ? b.lang : 'all',
      q: typeof b.q === 'string' ? b.q.slice(0, 60) : '',
      set: typeof b.set === 'string' ? b.set.slice(0, 60) : '',
      owned, ownedOnly: b.ownedOnly === true,
      offset: Math.max(0, Math.min(1e6, +b.offset || 0)),
      limit: Math.max(6, Math.min(96, +b.limit || 24)),
    }));
  }

  // --- pack simulator (just for fun — nothing is added to collections) ---
  if (pathname === '/api/packs' && method === 'GET') {
    limitApi(req);
    const list = packs.list();
    return send(res, 200, list ? { sets: list } : { loading: true, status: catalog.status() });
  }
  const pk = pathname.match(/^\/api\/packs\/([A-Za-z0-9._-]{1,40})\/open$/);
  if (pk && method === 'POST') {
    limitApi(req);
    const pack = packs.open(pk[1]);
    if (!pack) return send(res, 200, { loading: true, status: catalog.status() });
    if (pack.error) throw httpError(404, 'That set has no booster packs.');
    return send(res, 200, pack);
  }

  // --- full price breakdown for one card (raw + graded) ---
  const m = decodeURIComponent(pathname).match(/^\/api\/prices\/([A-Za-z0-9._:-]{1,80})$/);
  if (m && method === 'GET') {
    limitApi(req);
    return send(res, 200, await prices.fullPrices(m[1], url.searchParams.get('variant')));
  }

  // --- image recognition: compare a scanned photo with every card's picture ---
  if (pathname === '/api/visual-index/status' && method === 'GET') {
    return send(res, 200, visualIndex.status());
  }
  if (pathname === '/api/visual-search' && method === 'POST') {
    limitApi(req);
    const body = await readBody(req);
    if (!Array.isArray(body.q) || !body.q.length || body.q.length > 32) throw httpError(400, 'Send 1–32 descriptors.');
    const queries = body.q.map((b64) => (typeof b64 === 'string' && b64.length < 1000 ? CardDescriptor.fromBase64(b64) : null));
    if (queries.some((d) => !d || d.length !== CardDescriptor.LEN)) throw httpError(400, 'Bad descriptor.');
    const lang = ['en', 'ja'].includes(body.lang) ? body.lang : 'any';
    const hits = visualIndex.search(queries, { lang, limit: Math.min(40, Math.max(1, +body.limit || 24)) });
    // Full card details for the best few (prices, attacks, set code…), lightweight for the rest.
    const full = new Map();
    const top = hits.slice(0, 12).map((h) => h.meta.id);
    await Promise.race([
      (async () => {
        await prices.primeCards(top).catch(() => {});
        await Promise.all(top.map(async (id) => { const c = await prices.getCard(id).catch(() => null); if (c) full.set(id, c); }));
      })(),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
    return send(res, 200, {
      index: visualIndex.status(),
      results: hits.map((h) => ({ score: Math.round(h.score * 10000) / 10000, card: full.get(h.meta.id) || liteCard(h.meta) })),
    });
  }

  // --- a card's picture, from whichever source has it ---
  const im = decodeURIComponent(pathname).match(/^\/api\/card-image\/([A-Za-z0-9._:-]{1,80})$/);
  if (im && method === 'GET') {
    return cardImage(res, im[1], url.searchParams.get('size') === 'large' ? 'large' : 'small');
  }

  // --- groups: chat, photos, card shares, group leaderboard ---
  if (await groupsApi(req, res, url)) return;

  // --- card image proxy (same-origin, so the scanner can compare pixels) ---
  if (pathname === '/api/img' && method === 'GET') {
    return proxyImage(res, url.searchParams.get('u'));
  }

  throw httpError(404, 'Not found.');
}

const IMG_HOSTS = new Set(['images.pokemontcg.io', 'assets.tcgdex.net']);
const imgCache = new Map(); // url -> { type, body }
async function proxyImage(res, raw) {
  let target;
  try { target = new URL(raw); } catch { throw httpError(400, 'Bad image URL.'); }
  if (target.protocol !== 'https:' || !IMG_HOSTS.has(target.hostname)) throw httpError(400, 'Image host not allowed.');
  sendImage(res, await fetchImage(target));
}
// Card picture with fallbacks: tries every known source for the card until one loads.
const imgWinner = new Map(); // `${id}|${size}` -> url that worked
async function cardImage(res, id, size) {
  const key = `${id}|${size}`;
  const known = imgWinner.get(key);
  if (known) {
    const hit = await fetchImage(new URL(known)).catch(() => null);
    if (hit) return sendImage(res, hit, 86400);
    imgWinner.delete(key);
  }
  for (const u of await prices.imageCandidates(id, size)) {
    let target;
    try { target = new URL(u); } catch { continue; }
    if (!IMG_HOSTS.has(target.hostname)) continue;
    const hit = await fetchImage(target).catch(() => null);
    if (hit) {
      imgWinner.set(key, target.href);
      if (imgWinner.size > 5000) imgWinner.delete(imgWinner.keys().next().value);
      return sendImage(res, hit, 86400);
    }
  }
  throw httpError(404, 'No picture found for this card.');
}
async function fetchImage(target) {
  let hit = imgCache.get(target.href);
  if (!hit) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let up;
    try {
      up = await fetch(target.href, { signal: ctrl.signal, headers: { 'User-Agent': 'PokeFolio/2.2' } });
    } finally {
      clearTimeout(timer);
    }
    const type = (up.headers.get('content-type') || '').split(';')[0];
    if (!up.ok || !/^image\/(png|jpeg|webp|gif|avif)$/.test(type)) throw httpError(502, 'Image unavailable.');
    const body = Buffer.from(await up.arrayBuffer());
    if (body.length > 4 * 1024 * 1024) throw httpError(502, 'Image too large.');
    hit = { type, body };
    imgCache.set(target.href, hit);
    if (imgCache.size > 400) imgCache.delete(imgCache.keys().next().value);
  }
  return hit;
}
function sendImage(res, hit, maxAge = 604800) {
  res.writeHead(200, {
    'Content-Type': hit.type,
    'Content-Length': hit.body.length,
    'Cache-Control': `public, max-age=${maxAge}${maxAge >= 604800 ? ', immutable' : ''}`,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(hit.body);
}

// Every script/stylesheet URL in index.html carries a version derived from the files themselves
// (`app.js?v=…`), so after an update browsers always load the new code together with the new
// page — never a cached old script with a new page. Versioned files can then be cached for good.
let indexCache = null; // { key, html }
function assetVersion() {
  const h = require('crypto').createHash('sha1');
  for (const f of fs.readdirSync(PUBLIC_DIR).sort()) {
    if (!/\.(js|css)$/.test(f)) continue;
    const st = fs.statSync(path.join(PUBLIC_DIR, f));
    h.update(`${f}:${st.size}:${st.mtimeMs}|`);
  }
  return h.digest('hex').slice(0, 10);
}
function indexHtml() {
  const st = fs.statSync(path.join(PUBLIC_DIR, 'index.html'));
  const v = assetVersion();
  const key = `${v}:${st.mtimeMs}:${st.size}`;
  if (indexCache?.key !== key) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
      .replace(/(<(?:script|link)\b[^>]*\b(?:src|href)=")([\w.-]+\.(?:js|css))(")/g, `$1$2?v=${v}$3`);
    indexCache = { key, html };
  }
  return indexCache.html;
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    const target = !err && st.isFile() ? file : path.join(PUBLIC_DIR, 'index.html'); // SPA fallback
    const ext = path.extname(target);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // Versioned asset → cache forever; anything else → always check for a newer copy.
      'Cache-Control': ext !== '.html' && url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    };
    if (ext === '.html') {
      let html;
      try { html = indexHtml(); } catch { return send(res, 500, 'Server error'); }
      res.writeHead(200, headers);
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    res.writeHead(200, { ...headers, 'Last-Modified': st.mtime.toUTCString() });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else send(res, 405, 'Method not allowed');
  } catch (e) {
    const status = e.status || 502;
    if (!e.status) console.error(`[${req.method} ${url.pathname}]`, e.message);
    if (!res.headersSent) send(res, status, { error: e.status ? e.message : 'Upstream price/card service is unavailable. Try again shortly.' });
    else res.end();
  }
});

// Running on a cloud host (where the local disk is usually wiped on each deploy)?
const isHosted = () => !!(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME
  || process.env.K_SERVICE || process.env.DYNO || process.env.VERCEL || process.env.NODE_ENV === 'production');
// Postgres is permanent. A file is only permanent on a real persistent disk (opt-in flag).
const storagePersistent = () => store.kind === 'postgres' || process.env.PERSISTENT_DISK === '1' || !isHosted();

async function start() {
  store = await createStore({ databaseUrl: process.env.DATABASE_URL, dataDir: DATA_DIR });
  auth = createAuth(store);
  leaderboard = createLeaderboard(store, prices);
  groupsApi = createGroupsApi({ store, leaderboard, prices, httpError, readBody, send, requireUser, rateLimit });
  catalog = createCatalog({ store });
  packs = createPacks({ catalog });
  visualIndex = createVisualIndex({
    store, catalog,
    langs: (process.env.VISUAL_INDEX_LANGS || 'en,ja').split(',').map((l) => l.trim()).filter((l) => l === 'en' || l === 'ja'),
  });
  await visualIndex.start();
  server.listen(PORT, () => {
    console.log(`PokéFolio running at http://localhost:${PORT}`);
    console.log(`  accounts stored in: ${store.kind}`);
    if (!storagePersistent()) {
      console.warn('\n  ⚠️  WARNING: DATABASE_URL is not set. Accounts are being saved on this server\'s disk,');
      console.warn('  ⚠️  which this host wipes on every deploy — every account will be DELETED on the next update.');
      console.warn('  ⚠️  Fix: add a DATABASE_URL environment variable (see README → "Keeping accounts").\n');
    }
    console.log(`  graded prices: ${process.env.PRICECHARTING_TOKEN ? 'PriceCharting API (token set)' : 'PriceCharting public pages (set PRICECHARTING_TOKEN to use the official API)'}`);
  });
  const shutdown = async () => { server.close(); await store.close().catch(() => {}); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((e) => {
  console.error('Failed to start:', e.message);
  process.exit(1);
});
