/* PokéFolio card vision — ranks candidate cards by how much they look like a scanned photo.
 *
 * No ML model download: each image is reduced to a compact visual fingerprint
 *   • art:   colour layout of the artwork box (per-channel normalised, so lighting /
 *            white balance differences cancel out)
 *   • card:  colour layout of the whole card (border colour, text box, frame style)
 *   • edges: gradient-orientation histogram of the artwork (shapes and outlines; very
 *            robust to lighting)
 *   • hash:  64-bit difference hash of the whole card
 * The scanned photo is fingerprinted at several small offsets/zooms so a slightly
 * mis-framed card still lines up, and the best alignment wins.
 */
(() => {
  'use strict';

  const ART = { x: 0.08, y: 0.10, w: 0.84, h: 0.43 }; // artwork box as a fraction of the card
  const ART_W = 16, ART_H = 12;
  const CARD_W = 14, CARD_H = 20;
  const HOG_W = 64, HOG_H = 48, HOG_CX = 4, HOG_CY = 3, HOG_BINS = 9;

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  // Draw a region of src into a small canvas and return its pixels.
  function sample(src, r, w, h) {
    const c = canvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  }
  // Pre-blur by downscaling in two steps (cheap anti-aliasing for big photos).
  function shrink(src, r, maxSide = 220) {
    const s = Math.min(1, maxSide / Math.max(r.w, r.h));
    if (s >= 1) return { src, r };
    const c = canvas(Math.max(1, Math.round(r.w * s)), Math.max(1, Math.round(r.h * s)));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    return { src: c, r: { x: 0, y: 0, w: c.width, h: c.height } };
  }

  // RGB layout, each channel normalised to zero mean / unit variance.
  function colorLayout(px, n) {
    const out = new Float32Array(n * 3);
    for (let ch = 0; ch < 3; ch++) {
      let sum = 0, sq = 0;
      for (let i = 0; i < n; i++) { const v = px[i * 4 + ch]; sum += v; sq += v * v; }
      const mean = sum / n;
      const sd = Math.sqrt(Math.max(sq / n - mean * mean, 1e-6)) || 1;
      for (let i = 0; i < n; i++) out[ch * n + i] = (px[i * 4 + ch] - mean) / sd;
    }
    return out;
  }
  const gray = (px, i) => 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];

  function edgeHistogram(px, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = gray(px, i);
    const hist = new Float32Array(HOG_CX * HOG_CY * HOG_BINS);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const gx = g[y * w + x + 1] - g[y * w + x - 1];
        const gy = g[(y + 1) * w + x] - g[(y - 1) * w + x];
        const mag = Math.hypot(gx, gy);
        if (mag < 4) continue;
        const ang = (Math.atan2(gy, gx) + Math.PI) % Math.PI; // unsigned orientation
        const bin = Math.min(HOG_BINS - 1, Math.floor((ang / Math.PI) * HOG_BINS));
        const cx = Math.min(HOG_CX - 1, Math.floor((x / w) * HOG_CX));
        const cy = Math.min(HOG_CY - 1, Math.floor((y / h) * HOG_CY));
        hist[(cy * HOG_CX + cx) * HOG_BINS + bin] += mag;
      }
    }
    // Normalise each cell, then the whole vector (lighting-independent).
    for (let c = 0; c < HOG_CX * HOG_CY; c++) {
      let n = 0;
      for (let b = 0; b < HOG_BINS; b++) n += hist[c * HOG_BINS + b] ** 2;
      n = Math.sqrt(n) || 1;
      for (let b = 0; b < HOG_BINS; b++) hist[c * HOG_BINS + b] /= n;
    }
    let n = 0;
    for (const v of hist) n += v * v;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < hist.length; i++) hist[i] /= n;
    return hist;
  }

  function dhash(px) { // px is 9x8
    const bits = new Uint8Array(64);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits[y * 8 + x] = gray(px, y * 9 + x) > gray(px, y * 9 + x + 1) ? 1 : 0;
    return bits;
  }

  // Fingerprint the card occupying rect r of src.
  function fingerprint(source, rect) {
    const { src, r } = shrink(source, rect || { x: 0, y: 0, w: source.width, h: source.height });
    const art = { x: r.x + ART.x * r.w, y: r.y + ART.y * r.h, w: ART.w * r.w, h: ART.h * r.h };
    return {
      art: colorLayout(sample(src, art, ART_W, ART_H), ART_W * ART_H),
      card: colorLayout(sample(src, r, CARD_W, CARD_H), CARD_W * CARD_H),
      edges: edgeHistogram(sample(src, art, HOG_W, HOG_H), HOG_W, HOG_H),
      hash: dhash(sample(src, r, 9, 8)),
    };
  }

  const corr = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s / a.length; };
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

  // 0 … 1, higher = more alike.
  function similarity(a, b) {
    const art = (corr(a.art, b.art) + 1) / 2;
    const card = (corr(a.card, b.card) + 1) / 2;
    const edges = dot(a.edges, b.edges);
    let ham = 0;
    for (let i = 0; i < 64; i++) ham += a.hash[i] !== b.hash[i];
    const hash = 1 - ham / 64;
    return 0.38 * art + 0.17 * card + 0.33 * edges + 0.12 * hash;
  }

  // Find the card in an uncropped photo: separate it from the background (estimated from the
  // photo's border) and take the bounding box of the largest foreground blob.
  function detectCard(src) {
    const W = src.width, H = src.height;
    const s = 160 / Math.max(W, H);
    const w = Math.max(8, Math.round(W * s)), h = Math.max(8, Math.round(H * s));
    const px = sample(src, { x: 0, y: 0, w: W, h: H }, w, h);
    const border = [];
    for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
    for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1);
    const med = (ch) => { const v = border.map((i) => px[i * 4 + ch]).sort((a, b) => a - b); return v[v.length >> 1]; };
    const bg = [med(0), med(1), med(2)];
    // Threshold from the border's own spread, so textured backgrounds don't count as card.
    const dists = border.map((i) => Math.hypot(px[i * 4] - bg[0], px[i * 4 + 1] - bg[1], px[i * 4 + 2] - bg[2])).sort((a, b) => a - b);
    const thr = Math.max(40, dists[Math.floor(dists.length * 0.9)] * 1.5);
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = Math.hypot(px[i * 4] - bg[0], px[i * 4 + 1] - bg[1], px[i * 4 + 2] - bg[2]) > thr ? 1 : 0;
    // Largest 4-connected component, scored by area.
    const seen = new Uint8Array(w * h);
    let best = null;
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || seen[i]) continue;
      const stack = [i];
      seen[i] = 1;
      let area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
      while (stack.length) {
        const k = stack.pop(), x = k % w, y = (k / w) | 0;
        area++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const n of [k - 1, k + 1, k - w, k + w]) {
          if (n < 0 || n >= w * h || seen[n] || !mask[n]) continue;
          if ((n === k - 1 && x === 0) || (n === k + 1 && x === w - 1)) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
      if (!best || area > best.area) best = { area, x0, y0, x1, y1 };
    }
    if (!best || best.area < w * h * 0.04) return null;
    const bw = best.x1 - best.x0 + 1, bh = best.y1 - best.y0 + 1;
    if (bw / bh < 0.45 || bw / bh > 1.1) return null; // not card-shaped
    return { x: best.x0 / s, y: best.y0 / s, w: bw / s, h: bh / s };
  }

  // Fingerprints of a scanned photo at a few alignments. `isCard` = the image is already
  // cropped to the card (camera frame); otherwise search for a card-shaped region.
  function queryFingerprints(src, { isCard = true } = {}) {
    const W = src.width, H = src.height;
    const rects = [];
    const add = (cx, cy, h) => {
      const w = h * (63 / 88);
      const r = { x: cx - w / 2, y: cy - h / 2, w, h };
      if (r.x >= -1 && r.y >= -1 && r.x + r.w <= W + 1 && r.y + r.h <= H + 1) rects.push(r);
    };
    if (isCard) {
      rects.push({ x: 0, y: 0, w: W, h: H });
      for (const z of [0.94, 0.88]) for (const dx of [-0.03, 0, 0.03]) for (const dy of [-0.03, 0, 0.03]) {
        add(W / 2 + dx * W, H / 2 + dy * H, H * z);
      }
    } else {
      // Unknown framing: look for the card first, then fall back to a grid of card-shaped windows.
      const box = detectCard(src);
      if (box) {
        rects.push(box);
        // A tilted card's bounding box is a little too big; try slightly tighter fits too.
        for (const z of [1, 0.95, 0.9]) for (const dx of [-0.02, 0, 0.02]) for (const dy of [-0.02, 0, 0.02]) {
          rects.push({ x: box.x + box.w * ((1 - z) / 2 + dx), y: box.y + box.h * ((1 - z) / 2 + dy), w: box.w * z, h: box.h * z });
        }
      }
      const maxH = Math.min(H, W * (88 / 63));
      for (const z of [1, 0.85, 0.7, 0.55]) {
        const h = maxH * z;
        const w = h * (63 / 88);
        for (const fx of [0.5, 0.3, 0.7]) for (const fy of [0.5, 0.3, 0.7]) {
          add(w / 2 + (W - w) * fx, h / 2 + (H - h) * fy, h);
        }
      }
      rects.push({ x: 0, y: 0, w: W, h: H });
    }
    return rects.map((r) => fingerprint(src, r));
  }

  function bestSimilarity(queries, fp) {
    let best = 0;
    for (const q of queries) best = Math.max(best, similarity(q, fp));
    return best;
  }

  const fpCache = new Map();
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image failed'));
      img.src = url;
    });
  }
  function candidateFingerprint(key, url) {
    if (!fpCache.has(key)) {
      const p = loadImage(url).then((img) => fingerprint(img, { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight }));
      p.catch(() => fpCache.delete(key));
      fpCache.set(key, p);
    }
    return fpCache.get(key);
  }

  // Score candidates [{ key, url }] against a photo. Returns Map key -> similarity (0…1).
  async function rank(photo, candidates, { isCard = true, concurrency = 6, onProgress } = {}) {
    const queries = queryFingerprints(photo, { isCard });
    const scores = new Map();
    let i = 0, done = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
      while (i < candidates.length) {
        const c = candidates[i++];
        try { scores.set(c.key, bestSimilarity(queries, await candidateFingerprint(c.key, c.url))); } catch { /* image unavailable */ }
        onProgress?.(++done, candidates.length);
      }
    }));
    return scores;
  }

  window.CardVision = { rank, fingerprint, similarity, queryFingerprints, detectCard };
})();
