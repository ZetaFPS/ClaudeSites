'use strict';
// PokéFolio server — static frontend + accounts + portfolio sync + price aggregation.
// Zero dependencies: needs only Node.js 18+.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createStore } = require('./lib/store');
const { createAuth, httpError } = require('./lib/auth');
const prices = require('./lib/prices');

const PORT = +process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const COOKIE = 'pf_session';
const MAX_BODY = 10 * 1024 * 1024;

const store = createStore(DATA_DIR);
const auth = createAuth(store);

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

// Reject cross-site writes (cookies are SameSite=Lax, this is belt-and-braces).
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try { host = new URL(origin).host; } catch { throw httpError(403, 'Bad origin.'); }
  if (host !== req.headers.host) throw httpError(403, 'Cross-site request blocked.');
}

function requireUser(req) {
  const user = auth.userForToken(cookies(req)[COOKIE]);
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

  // --- accounts ---
  if (pathname === '/api/auth/me' && method === 'GET') {
    const user = auth.userForToken(cookies(req)[COOKIE]);
    return send(res, 200, { user: user ? auth.publicUser(user) : null });
  }
  if (pathname === '/api/auth/signup' && method === 'POST') {
    limitAuth(req);
    const user = auth.signup(await readBody(req));
    const s = auth.createSession(user.id);
    return send(res, 201, { user: auth.publicUser(user) }, { 'Set-Cookie': sessionCookie(req, s.token, s.maxAge) });
  }
  if (pathname === '/api/auth/login' && method === 'POST') {
    limitAuth(req);
    const user = auth.login(await readBody(req));
    const s = auth.createSession(user.id);
    return send(res, 200, { user: auth.publicUser(user) }, { 'Set-Cookie': sessionCookie(req, s.token, s.maxAge) });
  }
  if (pathname === '/api/auth/logout' && method === 'POST') {
    auth.destroySession(cookies(req)[COOKIE]);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  // --- portfolio sync ---
  if (pathname === '/api/portfolio') {
    const user = requireUser(req);
    if (method === 'GET') {
      return send(res, 200, store.data.portfolios[user.id] || { items: [], history: {}, pricesUpdatedAt: 0, updatedAt: 0 });
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      if (!Array.isArray(body.items) || body.items.length > 10000) throw httpError(400, 'Invalid portfolio.');
      const history = body.history && typeof body.history === 'object' && !Array.isArray(body.history) ? body.history : {};
      const doc = { items: body.items, history, pricesUpdatedAt: +body.pricesUpdatedAt || 0, priceVersion: +body.priceVersion || 0, updatedAt: Date.now() };
      store.data.portfolios[user.id] = doc;
      store.save();
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

  // --- full price breakdown for one card (raw + graded) ---
  const m = decodeURIComponent(pathname).match(/^\/api\/prices\/([A-Za-z0-9._:-]{1,80})$/);
  if (m && method === 'GET') {
    limitApi(req);
    return send(res, 200, await prices.fullPrices(m[1], url.searchParams.get('variant')));
  }

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
  res.writeHead(200, {
    'Content-Type': hit.type,
    'Content-Length': hit.body.length,
    'Cache-Control': 'public, max-age=604800, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(hit.body);
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    const target = !err && st.isFile() ? file : path.join(PUBLIC_DIR, 'index.html'); // SPA fallback
    const ext = path.extname(target);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
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

server.listen(PORT, () => {
  console.log(`PokéFolio running at http://localhost:${PORT}`);
  console.log(`  data dir: ${DATA_DIR}`);
  console.log(`  graded prices: ${process.env.PRICECHARTING_TOKEN ? 'PriceCharting API (token set)' : 'PriceCharting public pages (set PRICECHARTING_TOKEN to use the official API)'}`);
});
