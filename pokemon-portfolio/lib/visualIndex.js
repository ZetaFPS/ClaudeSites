'use strict';
// Visual index: a compact picture fingerprint (public/descriptor.js) of every card in the
// English (Pokémon TCG API) and Japanese (TCGdex) catalogues. A scanned photo is compared with
// all of them by appearance, so the scanner can find a card even when it can't read any text.
//
// The index is built in the background (newest sets first), saved to the database as it goes,
// and only new cards are fetched after a restart. Searching is a brute-force scan over a packed
// Int8Array: ~40k cards × a few alignments takes a fraction of a second.
const D = require('../public/descriptor');

let sharp = null;
try {
  sharp = require('sharp');
  sharp.cache(false);
  sharp.concurrency(1);
} catch { /* index disabled without sharp */ }

const POKEMONTCG = 'https://api.pokemontcg.io/v2';
const TCGDEX = 'https://api.tcgdex.net/v2';
const UA = 'Mozilla/5.0 (compatible; PokeFolio/2.3)';
const DAY = 24 * 3600e3;

const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9぀-鿿]+/g, '-');
const normNum = (n) => String(n || '').toLowerCase().replace(/^0+(?=\d)/, '');

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

/* ---------------- catalogues ---------------- */
// English: every card from the Pokémon TCG API, newest sets first.
async function englishCatalog() {
  const out = [];
  for (let page = 1; page < 400; page++) {
    const params = new URLSearchParams({ page: String(page), pageSize: '250', orderBy: '-set.releaseDate', select: 'id,name,number,images,set' });
    const res = await retry(() => getJson(`${POKEMONTCG}/cards?${params}`, 30000));
    for (const c of res.data || []) {
      if (!c.images?.small) continue;
      out.push({
        id: c.id, lang: 'en', name: c.name, number: c.number, setId: c.set?.id, setName: c.set?.name,
        total: c.set?.printedTotal, released: c.set?.releaseDate, code: c.set?.ptcgoCode, img: c.images.small, alt: c.images.large,
      });
    }
    if (!res.data?.length || page * 250 >= (res.totalCount || 0)) break;
  }
  return out;
}
// TCGdex catalogue for one language (Japanese, or English when the Pokémon TCG API is down).
async function tcgdexCatalog(lang) {
  const prefix = lang === 'ja' ? 'tcgdexja:' : 'tcgdex:';
  const sets = await retry(() => getJson(`${TCGDEX}/${lang}/sets`, 30000));
  const full = [];
  await mapLimit(Array.isArray(sets) ? sets : [], 4, async (s) => {
    const set = await retry(() => getJson(`${TCGDEX}/${lang}/sets/${encodeURIComponent(s.id)}`, 20000), 2).catch(() => null);
    if (set?.cards) full.push(set);
  });
  full.sort((a, b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')));
  const out = [];
  for (const set of full) {
    for (const c of set.cards) {
      if (!c.image) continue;
      out.push({
        id: `${prefix}${c.id}`, lang, name: c.name, number: c.localId, setId: set.id, setName: set.name,
        total: set.cardCount?.official, released: set.releaseDate, img: `${c.image}/low.webp`, alt: `${c.image}/low.png`,
      });
    }
  }
  return out;
}

/* ---------------- fingerprints ---------------- */
async function fingerprintImage(buf) {
  const px = await sharp(buf).resize(D.W, D.H, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  return D.compute(px, 3);
}

function createVisualIndex({ store, langs = ['en', 'ja'], log = console, concurrency = 3, autoStart = true } = {}) {
  const enabled = !!sharp && process.env.VISUAL_INDEX !== 'off';
  // Packed storage: row i's descriptor is fps[i*LEN … (i+1)*LEN).
  let fps = new Int8Array(0);
  let n = 0;
  const meta = [];
  const pos = new Map();
  const counts = { en: 0, ja: 0 };
  const state = { phase: enabled ? 'starting' : 'disabled', building: false, done: 0, queued: 0, failed: 0, lastBuild: 0, error: null };

  function add(row, fp) {
    let i = pos.get(row.id);
    if (i == null) {
      if ((n + 1) * D.LEN > fps.length) {
        const bigger = new Int8Array(Math.max(D.LEN * 1024, fps.length * 2));
        bigger.set(fps);
        fps = bigger;
      }
      i = n++;
      pos.set(row.id, i);
      counts[row.lang] = (counts[row.lang] || 0) + 1;
    }
    meta[i] = row;
    fps.set(fp.length === D.LEN ? fp : fp.subarray(0, D.LEN), i * D.LEN);
  }

  async function load() {
    const rows = await store.listCardFps();
    for (const r of rows) {
      const { fp, ...m } = r;
      if (fp && fp.length === D.LEN) add(m, new Int8Array(fp.buffer, fp.byteOffset, D.LEN));
    }
    return rows.length;
  }

  // Fingerprint every catalogue card not in the index yet.
  async function build() {
    if (state.building) return;
    state.building = true;
    state.error = null;
    try {
      for (const lang of langs) {
        state.phase = `listing ${lang === 'ja' ? 'Japanese' : 'English'} cards`;
        let catalog;
        try {
          catalog = lang === 'en' ? await englishCatalog() : await tcgdexCatalog(lang);
        } catch (e) {
          if (lang !== 'en') throw e;
          log.warn?.(`visual index: Pokémon TCG API catalogue unavailable (${e.message}) — using TCGdex`);
          catalog = await tcgdexCatalog('en');
        }
        const todo = catalog.filter((c) => !pos.has(c.id));
        state.queued += todo.length;
        state.phase = `indexing ${lang === 'ja' ? 'Japanese' : 'English'} cards`;
        let pending = [];
        const flush = async () => {
          const rows = pending;
          pending = [];
          if (rows.length) await store.putCardFps(rows).catch((e) => log.warn?.(`visual index: save failed: ${e.message}`));
        };
        await mapLimit(todo, concurrency, async (c) => {
          try {
            // Picture missing? Try the card's other image before giving up.
            const { alt, ...row } = c;
            const res = await retry(() => fetchWithTimeout(c.img, 20000), 2, 1500).catch((e) => {
              if (!alt) throw e;
              row.img = alt;
              return fetchWithTimeout(alt, 20000);
            });
            const fp = await fingerprintImage(Buffer.from(await res.arrayBuffer()));
            add(row, fp);
            pending.push({ ...row, fp });
            if (pending.length >= 100) await flush();
          } catch {
            state.failed++;
          }
          state.done++;
        });
        await flush();
      }
      state.lastBuild = Date.now();
      state.phase = 'ready';
    } catch (e) {
      state.error = e.message;
      state.phase = n ? 'ready (update failed, will retry)' : 'waiting to retry';
      log.warn?.(`visual index: build failed: ${e.message}`);
      throw e;
    } finally {
      state.building = false;
    }
  }

  async function run() {
    for (;;) {
      try {
        await build();
        await sleep(DAY);
      } catch {
        await sleep(15 * 60e3);
      }
    }
  }

  async function start() {
    if (!enabled) return;
    try {
      const loaded = await load();
      log.log?.(`  visual index: ${loaded} card fingerprints loaded`);
    } catch (e) {
      log.warn?.(`visual index: could not load saved fingerprints: ${e.message}`);
    }
    state.phase = n ? 'ready' : 'starting';
    if (autoStart) setTimeout(() => { run(); }, 5000).unref?.();
  }

  // queries: Int8Array descriptors of the photo at several alignments.
  // Returns [{ meta, score }] best first, one entry per distinct card.
  function search(queries, { lang = 'any', limit = 24 } = {}) {
    if (!n || !queries.length) return [];
    const Q = queries.length;
    // Pass 1: cheap whole-card layout score, best over all alignments.
    const K = Math.min(n, 600);
    const pre = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (lang !== 'any' && meta[i].lang !== lang) { pre[i] = -Infinity; continue; }
      let best = -Infinity;
      const o = i * D.LEN;
      for (let q = 0; q < Q; q++) {
        const s = D.quick(queries[q], 0, fps, o);
        if (s > best) best = s;
      }
      pre[i] = best;
    }
    const order = Array.from({ length: n }, (_, i) => i).filter((i) => pre[i] > -Infinity);
    order.sort((a, b) => pre[b] - pre[a]);
    // Pass 2: full similarity on the shortlist.
    const scored = order.slice(0, K).map((i) => {
      let best = 0;
      for (let q = 0; q < Q; q++) best = Math.max(best, D.similarity(queries[q], 0, fps, i * D.LEN));
      return { i, score: best };
    }).sort((a, b) => b.score - a.score);
    // The same card can be listed twice (e.g. from both English sources): keep the best one.
    const seen = new Set();
    const out = [];
    for (const { i, score } of scored) {
      const m = meta[i];
      const key = `${m.lang}|${slug(m.name)}|${normNum(m.number)}|${slug(m.setName)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ meta: m, score });
      if (out.length >= limit) break;
    }
    return out;
  }

  function status() {
    return {
      enabled, size: n, english: counts.en || 0, japanese: counts.ja || 0,
      phase: state.phase, building: state.building, progress: state.queued ? state.done / state.queued : null,
      lastBuild: state.lastBuild || null, error: state.error,
    };
  }

  return { start, build, search, status, add, size: () => n, _state: state };
}

// A lightweight card object from index metadata (used until the full card loads).
function liteCard(m) {
  return {
    id: m.id, name: m.name, number: m.number, lang: m.lang === 'en' ? undefined : m.lang, lite: true,
    set: { id: m.setId, name: m.setName, printedTotal: m.total, releaseDate: m.released, ptcgoCode: m.code },
    images: { small: m.img },
  };
}

module.exports = { createVisualIndex, liteCard, fingerprintImage, _test: { englishCatalog, tcgdexCatalog } };
