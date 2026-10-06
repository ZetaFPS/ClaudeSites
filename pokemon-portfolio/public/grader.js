/* PokéFolio pre-grader — estimates a card's condition from photos of the front and back.
 *
 * Pipeline per photo:
 *   1. Find the card against the background, measure its tilt and straighten it.
 *   2. Locate the four outer edges precisely and resample the card to a fixed
 *      630×880 canvas (exactly 10 px per mm — a Pokémon card is 63×88 mm).
 *   3. Measure:
 *        centering  – border width on each side (mm) → left/right and top/bottom ratios
 *        edges      – "whitening" (light chipping) in a thin strip along each edge
 *        corners    – whitening and shape (dings/rounding) of each corner
 *        surface    – creases (long straight light/dark lines), spots/stains in the
 *                     borders, and glare that makes the photo unreliable. When the official
 *                     image of the card is given, the front is compared with it, so creases and
 *                     marks on the artwork can be told apart from the printed design.
 *   4. Turn the measurements into 1–10 sub-grades and an overall PSA-style estimate.
 *
 * It's an estimate from photos: lighting, glare, focus and camera angle all matter, and
 * photos can't show everything a human grader sees under a loupe.
 */
(() => {
  'use strict';

  const MM = 10;
  const CW = 63 * MM, CH = 88 * MM;
  const CORNER_R = 3 * MM; // die-cut corner radius of a Pokémon card (~3 mm)

  /* ---------------- helpers ---------------- */
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });
  const lumOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const satOf = (r, g, b) => { const mx = Math.max(r, g, b); return mx ? (mx - Math.min(r, g, b)) / mx : 0; };
  const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const median = (arr) => { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1]; };
  const quantile = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  const medColor = (cols) => [0, 1, 2].map((ch) => median(cols.map((c) => c[ch])));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  async function loadImage(file) {
    if (file instanceof HTMLCanvasElement || file instanceof HTMLImageElement || (typeof ImageBitmap !== 'undefined' && file instanceof ImageBitmap)) return file;
    try { return await createImageBitmap(file); } catch {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
      } finally { URL.revokeObjectURL(url); }
    }
  }
  function toCanvas(src, maxSide = 1800) {
    const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
    const s = Math.min(1, maxSide / Math.max(w, h));
    const c = canvas(Math.round(w * s), Math.round(h * s));
    const x = ctx2d(c);
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  /* ---------------- 1. find + straighten ---------------- */
  // Coarse card mask on a small copy: background colour from the photo's border, largest
  // foreground blob, its bounding box and tilt (from second moments).
  function coarse(src) {
    const s = 320 / Math.max(src.width, src.height);
    const w = Math.max(16, Math.round(src.width * s)), h = Math.max(16, Math.round(src.height * s));
    const c = canvas(w, h);
    const x = ctx2d(c);
    x.drawImage(src, 0, 0, w, h);
    const px = x.getImageData(0, 0, w, h).data;
    const ring = [];
    for (let i = 0; i < w; i++) ring.push(i, (h - 1) * w + i, w + i, (h - 2) * w + i);
    for (let j = 0; j < h; j++) ring.push(j * w, j * w + w - 1, j * w + 1, j * w + w - 2);
    const bg = medColor(ring.map((i) => [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]]));
    const spread = quantile(ring.map((i) => dist3([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]], bg)), 0.9);
    const thr = Math.max(38, spread * 1.6);
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = dist3([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]], bg) > thr ? 1 : 0;
    const seen = new Uint8Array(w * h);
    let best = null;
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || seen[i]) continue;
      const stack = [i], pts = [];
      seen[i] = 1;
      while (stack.length) {
        const k = stack.pop();
        pts.push(k);
        const kx = k % w;
        for (const n of [k - 1, k + 1, k - w, k + w]) {
          if (n < 0 || n >= w * h || seen[n] || !mask[n]) continue;
          if ((n === k - 1 && kx === 0) || (n === k + 1 && kx === w - 1)) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
      if (!best || pts.length > best.length) best = pts;
    }
    if (!best || best.length < w * h * 0.05) return null;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, mx = 0, my = 0;
    for (const k of best) { const px_ = k % w, py = (k / w) | 0; mx += px_; my += py; if (px_ < x0) x0 = px_; if (px_ > x1) x1 = px_; if (py < y0) y0 = py; if (py > y1) y1 = py; }
    mx /= best.length; my /= best.length;
    let mu20 = 0, mu02 = 0, mu11 = 0;
    for (const k of best) { const dx = (k % w) - mx, dy = ((k / w) | 0) - my; mu20 += dx * dx; mu02 += dy * dy; mu11 += dx * dy; }
    const theta = 0.5 * Math.atan2(2 * mu11, mu20 - mu02) * 180 / Math.PI; // major axis vs +x
    let tilt = theta > 0 ? theta - 90 : theta + 90; // 0 when the long side is vertical
    if (Math.abs(tilt) > 25) tilt = 0; // landscape photo or not a card — don't spin it
    return { s, bg, thr, tilt, box: { x0: x0 / s, y0: y0 / s, x1: (x1 + 1) / s, y1: (y1 + 1) / s }, fill: best.length / ((x1 - x0 + 1) * (y1 - y0 + 1)) };
  }

  function rotate(src, deg, bg) {
    const r = deg * Math.PI / 180;
    const w = src.width, h = src.height;
    const W = Math.ceil(Math.abs(w * Math.cos(r)) + Math.abs(h * Math.sin(r)));
    const H = Math.ceil(Math.abs(w * Math.sin(r)) + Math.abs(h * Math.cos(r)));
    const c = canvas(W, H);
    const x = ctx2d(c);
    x.fillStyle = `rgb(${bg.map(Math.round).join(',')})`;
    x.fillRect(0, 0, W, H);
    x.translate(W / 2, H / 2);
    x.rotate(r);
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, -w / 2, -h / 2);
    return c;
  }

  // Outer edges at full resolution. Each side is sampled along ~70 scan lines and a straight
  // line is fitted through the hits (ignoring outliers), so a photo taken at a slight angle —
  // where the card looks like a trapezoid, not a rectangle — is measured correctly.
  function edgeLines(src, box, bg, thr) {
    const W = src.width, H = src.height;
    const px = ctx2d(src).getImageData(0, 0, W, H).data;
    const at = (x, y) => { const i = (y * W + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
    const isCard = (x, y) => x >= 0 && y >= 0 && x < W && y < H && dist3(at(x, y), bg) > thr;
    const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
    const mx = Math.max(8, Math.round(bw * 0.07)), my = Math.max(8, Math.round(bh * 0.07));
    const scan = (from, to, step, fixed, horizontal) => {
      for (let v = from; step > 0 ? v <= to : v >= to; v += step) {
        const ok = horizontal ? isCard(v, fixed) && isCard(v + step, fixed) && isCard(v + 2 * step, fixed)
          : isCard(fixed, v) && isCard(fixed, v + step) && isCard(fixed, v + 2 * step);
        if (ok) return v;
      }
      return null;
    };
    const L = [], R = [], T = [], B = [];
    for (let i = 0; i < 70; i++) {
      const y = Math.round(box.y0 + bh * (0.12 + 0.76 * i / 69));
      const x = Math.round(box.x0 + bw * (0.12 + 0.76 * i / 69));
      const l = scan(Math.round(box.x0 - mx), Math.round(box.x0 + mx), 1, y, true); if (l != null) L.push([y, l]);
      const r = scan(Math.round(box.x1 + mx), Math.round(box.x1 - mx), -1, y, true); if (r != null) R.push([y, r + 1]);
      const t = scan(Math.round(box.y0 - my), Math.round(box.y0 + my), 1, x, false); if (t != null) T.push([x, t]);
      const b = scan(Math.round(box.y1 + my), Math.round(box.y1 - my), -1, x, false); if (b != null) B.push([x, b + 1]);
    }
    // Robust straight-line fit v = a·t + b: least squares, drop outliers, refit.
    const fit = (pts, fallback) => {
      if (pts.length < 15) return { a: 0, b: fallback };
      let use = pts;
      let a = 0, b = fallback;
      for (let pass = 0; pass < 3; pass++) {
        const n = use.length, mt = use.reduce((s, q) => s + q[0], 0) / n, mv = use.reduce((s, q) => s + q[1], 0) / n;
        let num = 0, den = 0;
        for (const [t, v] of use) { num += (t - mt) * (v - mv); den += (t - mt) ** 2; }
        a = den ? num / den : 0; b = mv - a * mt;
        const res = pts.map(([t, v]) => Math.abs(v - (a * t + b)));
        const lim = Math.max(1.5, 2.5 * median(res));
        const next = pts.filter((q, k) => res[k] <= lim);
        if (next.length < 10 || next.length === use.length) break;
        use = next;
      }
      return { a, b };
    };
    return { left: fit(L, box.x0), right: fit(R, box.x1), top: fit(T, box.y0), bottom: fit(B, box.y1) };
  }

  // Corner where a vertical-ish line x = a·y + b meets a horizontal-ish line y = c·x + d.
  function cross(v, h) {
    const x = (v.a * h.b + v.b) / (1 - v.a * h.a);
    return [x, h.a * x + h.b];
  }

  // Projective transform taking the destination rectangle onto the photographed quadrilateral.
  function homography(dst, src) {
    const A = [], bv = [];
    for (let k = 0; k < 4; k++) {
      const [x, y] = dst[k], [u, v] = src[k];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); bv.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); bv.push(v);
    }
    // Gaussian elimination with partial pivoting.
    for (let c = 0; c < 8; c++) {
      let piv = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]]; [bv[c], bv[piv]] = [bv[piv], bv[c]];
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
        bv[r] -= f * bv[c];
      }
    }
    const h = bv.map((v, k) => v / A[k][k]);
    return (x, y) => { const w = h[6] * x + h[7] * y + 1; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };
  }

  // Resample the photographed card onto the flat 10 px/mm canvas (bilinear).
  function warp(src, quad) {
    const W = src.width, H = src.height;
    const sp = ctx2d(src).getImageData(0, 0, W, H).data;
    const card = canvas(CW, CH);
    const ctx = ctx2d(card);
    const out = ctx.createImageData(CW, CH);
    const d = out.data;
    const map = homography([[0, 0], [CW, 0], [0, CH], [CW, CH]], quad);
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < CW; x++) {
        const [u, v] = map(x + 0.5, y + 0.5);
        const x0 = Math.floor(u - 0.5), y0 = Math.floor(v - 0.5);
        const fx = u - 0.5 - x0, fy = v - 0.5 - y0;
        const o = (y * CW + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const g = (xx, yy) => sp[((clamp(yy, 0, H - 1) * W) + clamp(xx, 0, W - 1)) * 4 + ch];
          d[o + ch] = (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
        }
        d[o + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
    return card;
  }

  function locate(photo) {
    const c1 = coarse(photo);
    if (!c1) return null;
    let src = photo, c2 = c1;
    if (Math.abs(c1.tilt) > 0.25) {
      src = rotate(photo, -c1.tilt, c1.bg);
      c2 = coarse(src) || c1;
    }
    const e = edgeLines(src, c2.box, c2.bg, c2.thr);
    const tl = cross(e.left, e.top), tr = cross(e.right, e.top), bl = cross(e.left, e.bottom), br = cross(e.right, e.bottom);
    const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const wTop = d(tl, tr), wBot = d(bl, br), hL = d(tl, bl), hR = d(tr, br);
    const w = (wTop + wBot) / 2, h = (hL + hR) / 2;
    // Keystone: how much the photo was taken at an angle (0 = straight down).
    const keystone = Math.max(Math.abs(wTop - wBot) / w, Math.abs(hL - hR) / h);
    const sane = [tl, tr, bl, br].every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)) && w > 50 && h > 50 && keystone < 0.25;
    let card;
    if (sane) card = warp(src, [tl, tr, bl, br]);
    else { // fall back to the bounding box
      card = canvas(CW, CH);
      const x = ctx2d(card); x.imageSmoothingQuality = 'high';
      x.drawImage(src, c2.box.x0, c2.box.y0, c2.box.x1 - c2.box.x0, c2.box.y1 - c2.box.y0, 0, 0, CW, CH);
    }
    const aspect = w / h;
    return {
      card, tilt: c1.tilt, bg: c2.bg, thr: c2.thr, keystone,
      pxPerMm: h / 88, aspect, aspectOk: Math.abs(aspect - 63 / 88) < 0.06,
    };
  }

  /* ---------------- 2. measurements on the 10 px/mm card ---------------- */
  function pixels(card) { return ctx2d(card).getImageData(0, 0, CW, CH).data; }
  const P = (px, x, y) => { const i = (y * CW + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };

  // Border width on each side (mm). Along 40 lines across each side we look for where the border
  // ends: the first clear *step* in colour going inward (average colour just before vs just after),
  // judged against how much the border itself varies. A step works for subtle edges too (a silver
  // border next to a light grey frame) where a fixed colour-difference threshold would run past
  // the edge. Returns null for a side with no consistent border (full art).
  function borders(px) {
    const W5 = 5; // window (px) on each side of a candidate edge
    const side = (name) => {
      const vals = [];
      const maxM = 12 * MM;
      for (let i = 0; i < 40; i++) {
        const f = 0.25 + 0.5 * i / 39;
        const coord = (m, o) => {
          if (name === 'left') return [m, Math.round(CH * f) + o];
          if (name === 'right') return [CW - 1 - m, Math.round(CH * f) + o];
          if (name === 'top') return [Math.round(CW * f) + o, m];
          return [Math.round(CW * f) + o, CH - 1 - m];
        };
        // Colour profile going inward, averaged over 5 px across the line (less noise).
        const prof = [];
        for (let m = 0; m <= maxM + 14; m++) {
          const c = [0, 0, 0];
          for (let o = -2; o <= 2; o++) { const p = P(px, ...coord(m, o)); c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
          prof.push([c[0] / 5, c[1] / 5, c[2] / 5]);
        }
        const mean = (a, b) => { const c = [0, 0, 0]; for (let k = a; k < b; k++) for (let ch = 0; ch < 3; ch++) c[ch] += prof[k][ch]; return c.map((v) => v / (b - a)); };
        const step = (m) => dist3(mean(m - W5, m), mean(m, m + W5));
        // Noise level: the quieter steps along the profile (the border itself and other flat print).
        // Not the median — inside the card the artwork is busy, which would inflate it.
        const base = [];
        for (let m = 10; m < maxM; m += 2) base.push(step(m));
        const noise = quantile(base, 0.2);
        const thr = Math.max(12, noise * 4);
        // A real edge ends a flat border. Glare or a foil gradient is a steady slope, so the
        // colour is already changing in the border just before the "edge" — those are skipped.
        // (What comes after the edge doesn't matter: often a thin frame line, then the artwork.)
        let found = null;
        for (let m = 10; m < maxM; m++) {
          if (step(m) < thr) continue;
          // Walk to the strongest point of this step.
          let k = m;
          // (at most 3 px — photo blur — so it can't climb into a frame line right behind the edge)
          while (k + 1 < maxM && k < m + 3 && step(k + 1) >= step(k)) k++;
          const a = Math.max(2, k - 13), mid = Math.max(a + 3, k - 8), end = Math.max(mid + 2, k - 3);
          const pre = dist3(mean(a, mid), mean(mid, end));
          if (step(k) >= 2 * pre) { found = k; break; }
          m = k;
        }
        if (found != null) vals.push(found);
      }
      if (vals.length < 24) return null;
      const iqr = quantile(vals, 0.75) - quantile(vals, 0.25);
      if (iqr > 1.2 * MM) return null;
      return median(vals) / MM;
    };
    return { left: side('left'), right: side('right'), top: side('top'), bottom: side('bottom') };
  }

  /* Telling wear apart from light.
   *
   * Holo foil, glossy finishes and room lighting put bright, washed-out patches on a card —
   * which look a lot like whitening. Two things separate them:
   *   1. Depth profile. Whitening / chipping is a sharp step: bright in the outer ~1 mm and the
   *      normal border colour just inside it. A reflection fades in gradually, so the border just
   *      inside is brightened too.
   *   2. Local reference. Everything is compared with the border colour *at that spot* (a
   *      sliding median along the edge), so a broad glare or a foil gradient across a whole side
   *      doesn't make every pixel look worn.
   * Single-pixel foil glints are ignored by only counting wear that forms runs along the edge.
   */
  const SIDES = ['left', 'right', 'top', 'bottom'];
  const sideLen = (name) => (name === 'left' || name === 'right' ? CH : CW);
  // (depth from the edge in px, position along the edge in px) → (x, y)
  const at = (name, m, t) => (name === 'left' ? [m, t] : name === 'right' ? [CW - 1 - m, t] : name === 'top' ? [t, m] : [t, CH - 1 - m]);

  // Border colour at every position along a side, measured at depth [d0, d1] (px) and smoothed
  // with a sliding median over ±win px.
  function localRefs(px, name, d0, d1, win = 25) {
    const len = sideLen(name);
    const col = new Array(len);
    for (let t = 0; t < len; t++) {
      const cs = [];
      for (let m = d0; m <= d1; m += 2) cs.push(P(px, ...at(name, m, t)));
      col[t] = medColor(cs);
    }
    const refs = new Array(len);
    for (let t = 0; t < len; t++) {
      const cs = [];
      for (let u = Math.max(0, t - win); u <= Math.min(len - 1, t + win); u += 3) cs.push(col[u]);
      refs[t] = medColor(cs);
    }
    return refs;
  }

  // Brighter and (for coloured borders) paler than the border = candidate whitening.
  function brighterPaler(p, ref) {
    const dl = lumOf(...p) - lumOf(...ref);
    const sRef = satOf(...ref), sP = satOf(...p);
    if (sRef > 0.25) return dl > 30 && sP < sRef * 0.6;
    return dl > 45 && lumOf(...p) > 170; // silver/grey/white borders: only clearly brighter counts
  }
  const excess = (p, ref) => lumOf(...p) - lumOf(...ref);

  // Is the edge at position t worn (sharp bright step) or just lit (gradual)?
  // Returns { worn, shine } for this position.
  function edgeProfile(px, name, t, ref) {
    let e0 = 0, n0 = 0, hits = 0;
    for (let m = 3; m <= 8; m++) { // 0.3–0.8 mm: where chipping shows (the outer sliver can be the card's side edge)
      const p = P(px, ...at(name, m, t));
      e0 += excess(p, ref); n0++;
      if (brighterPaler(p, ref)) hits++;
    }
    e0 /= n0;
    let e1 = 0, n1 = 0;
    for (let m = 11; m <= 15; m++) { e1 += excess(P(px, ...at(name, m, t)), ref); n1++; } // 1.1–1.5 mm
    e1 /= n1;
    if (hits < 2 || e0 < 25) return { worn: false, shine: false };
    const sharp = e1 < 0.4 * e0; // drops back to the border colour almost immediately
    return { worn: sharp, shine: !sharp };
  }

  function edges(px) {
    const out = {};
    const margin = 5 * MM; // corners are graded separately
    for (const name of SIDES) {
      const refs = localRefs(px, name, 12, 22);
      const len = sideLen(name);
      const worn = [], shine = [];
      for (let t = margin; t < len - margin; t++) {
        const r = edgeProfile(px, name, t, refs[t]);
        if (r.worn) worn.push(t);
        else if (r.shine) shine.push(t);
      }
      // Real wear forms runs along the edge (≥0.4 mm); isolated hits are foil glints / noise.
      const marks = clusterMarks(worn, 4);
      const wornLen = marks.reduce((a, m) => a + (m.to - m.from + 1), 0);
      // How much the light varies along this border (reflections, holo sheen) — for the report.
      const lums = refs.slice(margin, len - margin).map((c) => lumOf(...c));
      const uneven = quantile(lums, 0.95) - quantile(lums, 0.05);
      out[name] = { whitening: wornLen / (len - 2 * margin), marks, shine: shine.length / (len - 2 * margin), uneven };
    }
    return out;
  }
  // Group consecutive positions into segments [{from, to}] at least minLen px long.
  function clusterMarks(ts, minLen = 4) {
    const segs = [];
    for (const t of ts) {
      const last = segs[segs.length - 1];
      if (last && t - last.to <= 3) last.to = t; else segs.push({ from: t, to: t });
    }
    return segs.filter((s) => s.to - s.from + 1 >= minLen);
  }

  function corners(px, bg, thr) {
    const size = Math.round(4.5 * MM);
    const R = CORNER_R;
    const out = {};
    const refAt = {}; // border colour just outside each corner zone, per side
    for (const name of SIDES) {
      const refs = localRefs(px, name, 12, 22);
      const len = sideLen(name);
      refAt[name] = { start: refs[Math.round(6 * MM)], end: refs[len - 1 - Math.round(6 * MM)] };
    }
    const spec = [['topLeft', 0, 0, refAt.left.start, refAt.top.start], ['topRight', 1, 0, refAt.right.start, refAt.top.end],
      ['bottomLeft', 0, 1, refAt.left.end, refAt.bottom.start], ['bottomRight', 1, 1, refAt.right.end, refAt.bottom.end]];
    for (const [name, sx, sy, refV, refH] of spec) {
      const ref = medColor([refV, refH]);
      let mismatch = 0, area = 0, white = 0, cand = 0, shine = 0;
      const toXY = (i, j) => [sx ? CW - 1 - i : i, sy ? CH - 1 - j : j];
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
          const [x, y] = toXY(i, j);
          // Ideal die-cut corner: inside the card unless beyond the arc.
          const inArc = i < R && j < R;
          const dArc = inArc ? R - Math.hypot(R - i, R - j) : null;
          const ideal = !(inArc && dArc < 0);
          const p = P(px, x, y);
          const isCard = dist3(p, bg) > thr;
          area++;
          if (isCard !== ideal) mismatch++;
          if (!isCard) continue;
          // Depth into the card from the nearest edge (or the arc) and the inward direction.
          let depth, ux, uy;
          if (inArc) { depth = dArc; const h = Math.hypot(R - i, R - j) || 1; ux = (R - i) / h; uy = (R - j) / h; } else if (i < j) { depth = i; ux = 1; uy = 0; } else { depth = j; ux = 0; uy = 1; }
          if (depth < 3 || depth > 13) continue; // skip the outer 0.3 mm (card side edge / anti-aliasing)
          cand++;
          if (!brighterPaler(p, ref)) continue;
          // Same sharp-step test as the edges: 1 mm further in should be back to normal.
          const [ix, iy] = toXY(Math.round(i + ux * 10), Math.round(j + uy * 10));
          const inner = P(px, ix, iy);
          if (excess(inner, ref) < 0.4 * excess(p, ref)) white++; else shine++;
        }
      }
      out[name] = { shape: mismatch / area, whitening: cand ? white / cand : 0, shine: cand ? shine / cand : 0 };
    }
    return out;
  }

  // Luminance at half resolution (5 px/mm) and a box blur.
  function lumHalf(px) {
    const w = CW / 2, h = CH / 2;
    const L = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const p = P(px, x * 2 + ox, y * 2 + oy); s += lumOf(...p); }
      L[y * w + x] = s / 4;
    }
    return { L, w, h };
  }
  function boxBlur(L, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let acc = 0, n = 0;
      for (let x = -r; x < w; x++) {
        if (x + r < w) { acc += L[y * w + x + r]; n++; }
        if (x - r - 1 >= 0) { acc -= L[y * w + x - r - 1]; n--; }
        if (x >= 0) tmp[y * w + x] = acc / n;
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0, n = 0;
      for (let y = -r; y < h; y++) {
        if (y + r < h) { acc += tmp[(y + r) * w + x]; n++; }
        if (y - r - 1 >= 0) { acc -= tmp[(y - r - 1) * w + x]; n--; }
        if (y >= 0) out[y * w + x] = acc / n;
      }
    }
    return out;
  }

  // Creases: long, straight, *thin* lines. A crease is lighter (or darker) than the paper on
  // BOTH sides of it; an edge in the printed design only changes in one direction — so we look
  // for ridges, then for many ridge pixels lined up along one straight line (Hough transform).
  // Straight lines within 4° of horizontal/vertical are ignored: card designs are full of them.
  //
  // opts.known: half-resolution mask of lines that belong to the printed design (from the official
  //             card image) — those pixels are ignored.
  // opts.logoBands: the back of an English card has the POKéMON logo and its swirl outlines near
  //             the top and bottom; their letters and strokes line up in long straight lines at all
  //             sorts of angles, so a line lying mostly (60%+) inside those bands is ignored. (A crease
  //             goes through the card, so one hidden there still shows on the front, which is
  //             checked against the official image.)
  function ridgeMap(L, w, h, inset, known) {
    const d = 2, t = 10;
    const pts = [];
    const ridge = new Uint8Array(w * h);
    const pairs = [[d, 0], [0, d], [d, d], [d, -d]];
    for (let y = inset; y < h - inset; y++) for (let x = inset; x < w - inset; x++) {
      if (known && known[y * w + x]) continue;
      const v = L[y * w + x];
      let bits = 0;
      for (let q = 0; q < 4; q++) {
        const [dx, dy] = pairs[q];
        const a = L[(y + dy) * w + x + dx], b = L[(y - dy) * w + x - dx];
        if ((v - a > t && v - b > t) || (a - v > t && b - v > t)) bits |= 1 << q;
      }
      // bit q set = brighter/darker than both neighbours along direction q (0°, 90°, 45°, -45°)
      if (bits) { pts.push(x, y); ridge[y * w + x] = bits; }
    }
    return { ridge, pts };
  }
  const LOGO_BANDS = [[0.05, 0.32], [0.68, 0.95]]; // fractions of the card's height
  function creases(px, opts = {}) {
    const { L, w, h } = lumHalf(px);
    const inset = Math.round(2.5 * MM / 2);
    const { ridge, pts } = ridgeMap(L, w, h, inset, opts.known);
    const nT = 90, diag = Math.ceil(Math.hypot(w, h));
    const acc = new Uint32Array(nT * (2 * diag + 1));
    const cos = [], sin = [];
    for (let k = 0; k < nT; k++) { const a = (k * 2) * Math.PI / 180; cos.push(Math.cos(a)); sin.push(Math.sin(a)); }
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i], y = pts[i + 1];
      for (let k = 0; k < nT; k++) acc[k * (2 * diag + 1) + Math.round(x * cos[k] + y * sin[k]) + diag]++;
    }
    const cands = [];
    for (let k = 0; k < nT; k++) {
      const deg = k * 2;
      const fromAxis = Math.min(deg % 90, 90 - (deg % 90));
      if (fromAxis < 4) continue;
      for (let r = 1; r < 2 * diag; r++) {
        // A line can straddle two rho bins; count both.
        const votes = acc[k * (2 * diag + 1) + r] + Math.max(acc[k * (2 * diag + 1) + r - 1], acc[k * (2 * diag + 1) + r + 1]);
        if (votes < 40) continue;
        const len = chord(cos[k], sin[k], r - diag, inset, w - inset, inset, h - inset);
        if (len < h * 0.18) continue;
        cands.push({ density: votes / len, len, deg, k, rho: r - diag });
      }
    }
    cands.sort((a, b) => b.density - a.density);
    // One printed shape produces many near-identical candidate lines; keep the strongest of each
    // group so they can't crowd a real crease out of the shortlist.
    const shortlist = [];
    for (const c of cands) {
      if (shortlist.length >= 40) break;
      if (!shortlist.some((o) => Math.abs(o.deg - c.deg) <= 4 && Math.abs(o.rho - c.rho) <= 8)) shortlist.push(c);
    }
    // A crease is one continuous line; text and patterns line up only in short pieces.
    // Walk each candidate line and measure its longest run (allowing 3 px gaps).
    let best = null;
    const pairAngles = [0, 90, 45, 135];
    for (const c of shortlist) {
      const seg = lineEndpoints(cos[c.k], sin[c.k], c.rho, inset, w - inset, inset, h - inset);
      if (!seg) continue;
      // The cross-line profile must run along the line's normal (angle c.deg).
      let want = 0;
      for (let q = 0; q < 4; q++) { const dA = Math.abs(((c.deg - pairAngles[q]) % 180 + 180) % 180); if (Math.min(dA, 180 - dA) <= 23) want |= 1 << q; }
      const n = Math.ceil(Math.hypot(seg[2] - seg[0], seg[3] - seg[1]));
      // Coverage = share of the run actually on the line. A real crease is one continuous line
      // (~90%); a chain of different design lines crossing a straight path is mostly gaps.
      let run = 0, gap = 0, longest = 0, start = 0, bestFrom = 0, bestTo = 0, onCount = 0, bestCov = 0, seen = 0;
      // Perpendicular offset (px) of the ridge at each step — used to check the line is straight.
      const nx = cos[c.k], ny = sin[c.k];
      const offs = new Array(n + 1).fill(null);
      for (let i = 0; i <= n; i++) {
        const fx = seg[0] + (seg[2] - seg[0]) * i / n, fy = seg[1] + (seg[3] - seg[1]) * i / n;
        const x = Math.round(fx), y = Math.round(fy);
        // Over the design's own lines we can't tell: neither on the line nor a gap.
        if (opts.known && opts.known[y * w + x]) { if (run) seen++; continue; }
        let on = false;
        for (let oy = -1; oy <= 1 && !on; oy++) for (let ox = -1; ox <= 1 && !on; ox++) on = !!(ridge[(y + oy) * w + x + ox] & want);
        for (let o = 0; o <= 2 && offs[i] == null; o++) for (const sg of o ? [-1, 1] : [1]) {
          const qx = Math.round(fx + nx * o * sg), qy = Math.round(fy + ny * o * sg);
          if (offs[i] == null && qx >= 0 && qy >= 0 && qx < w && qy < h && (ridge[qy * w + qx] & want)) offs[i] = o * sg;
        }
        if (on) { if (!run) { start = i; onCount = 0; seen = 0; } onCount++; run = i - start + 1; gap = 0; } else if (run && ++gap > 10) { run = 0; gap = 0; }
        const cov = run ? onCount / (run - seen) : 0;
        if (run > longest && cov >= 0.6) { longest = run; bestFrom = start; bestTo = i; bestCov = cov; }
      }
      let runMm = (longest * 2) / MM;
      if (opts.logoBands && longest > 0) {
        let outside = 0;
        for (let i = bestFrom; i <= bestTo; i++) {
          const fy = (seg[1] + (seg[3] - seg[1]) * i / n) / h;
          if (!LOGO_BANDS.some(([a, b]) => fy >= a && fy <= b)) outside++;
        }
        // Mostly inside the logo areas → part of the design. Otherwise the whole line counts.
        if (outside < (bestTo - bestFrom + 1) * 0.4) runMm = (outside * 2) / MM;
      }
      // Straightness: fit offset = a + b·t + c·t² over the run. A gentle arc in the card's design
      // bends measurably (its sagitta); a crease doesn't.
      if (longest > 10) {
        const pts = [];
        for (let i = bestFrom; i <= bestTo; i++) if (offs[i] != null) pts.push([(i - bestFrom) / (bestTo - bestFrom) * 2 - 1, offs[i]]);
        const sagitta = pts.length > 8 ? Math.abs(quadCoef(pts)) : 0; // px, over half the run
        if (sagitta > 0.9) runMm = 0;
      }
      // Same colours on both sides: a crease cuts *through* the printed design, so just beside it
      // the card looks the same on either side. The outline of a printed shape (e.g. the bottom
      // edge of the POKéMON logo on the back) has one colour above and another below, all along.
      let sides = 0;
      if (runMm >= 18) {
        sides = sideContrast(px, seg, n, bestFrom, bestTo, nx, ny, opts.refPx);
        if (sides > SIDE_LIMIT) runMm = 0;
      }
      if (!best || runMm > best.runMm) {
        const at = (i) => [seg[0] + (seg[2] - seg[0]) * i / n, seg[1] + (seg[3] - seg[1]) * i / n];
        best = { ...c, runMm, sides, cov: bestCov, line: [...at(bestFrom), ...at(bestTo)] };
      }
    }
    if (!best || best.runMm < 18) return { found: false, strength: best ? best.runMm : 0 };
    // Short straight lines (18–30 mm) can be part of the card's printed design; report them as
    // "check this" without affecting the grade. Long ones are treated as creases.
    // A crease is a continuous line: at least 80% of its length visible. Patchier straight lines
    // are reported as "check this" only.
    const solid = best.cov >= 0.8;
    return {
      found: best.runMm >= 30 && solid,
      faint: best.runMm < 30 || !solid,
      strength: best.density,
      lengthMm: best.runMm,
      sides: best.sides,
      line: best.line.map((v) => v * 2), // back to 10 px/mm coordinates
    };
  }
  // How different the card is on the two sides of a line (0 = same colours). Compares the average
  // colour 1.2 mm and 2 mm to either side, along the whole run (half-resolution line coordinates).
  const SIDE_LIMIT = 45;
  // With the official image (refPx), the photo-minus-reference difference is compared instead, so
  // the design's own colours cancel out.
  function sideContrast(px, seg, n, from, to, nx, ny, refPx) {
    let worst = 0;
    for (const k of [1.2 * MM, 2 * MM]) {
      let dr = 0, dg = 0, db = 0, cnt = 0;
      for (let i = from; i <= to; i += 2) {
        const fx = (seg[0] + (seg[2] - seg[0]) * i / n) * 2, fy = (seg[1] + (seg[3] - seg[1]) * i / n) * 2;
        const ax = Math.round(fx + nx * k), ay = Math.round(fy + ny * k), bx = Math.round(fx - nx * k), by = Math.round(fy - ny * k);
        if (Math.min(ax, bx) < 1 || Math.min(ay, by) < 1 || Math.max(ax, bx) > CW - 2 || Math.max(ay, by) > CH - 2) continue;
        for (const [ox, oy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const a = P(px, ax + ox, ay + oy), b = P(px, bx + ox, by + oy);
          if (refPx) {
            const ra = P(refPx, ax + ox, ay + oy), rb = P(refPx, bx + ox, by + oy);
            for (let ch = 0; ch < 3; ch++) { a[ch] -= ra[ch]; b[ch] -= rb[ch]; }
          }
          dr += a[0] - b[0]; dg += a[1] - b[1]; db += a[2] - b[2]; cnt++;
        }
      }
      if (cnt) worst = Math.max(worst, Math.hypot(dr / cnt, dg / cnt, db / cnt));
    }
    return worst;
  }

  // Least-squares fit y = a + b·x + c·x² (x in [-1, 1]); returns c.
  function quadCoef(pts) {
    let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0;
    for (const [x, y] of pts) { const x2 = x * x; S0++; S1 += x; S2 += x2; S3 += x2 * x; S4 += x2 * x2; T0 += y; T1 += x * y; T2 += x2 * y; }
    const M = [[S0, S1, S2, T0], [S1, S2, S3, T1], [S2, S3, S4, T2]];
    for (let c = 0; c < 3; c++) {
      let piv = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      if (Math.abs(M[c][c]) < 1e-9) return 0;
      for (let r = 0; r < 3; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k]; }
    }
    return M[2][3] / M[2][2];
  }

  // Length of the line x·cos + y·sin = rho inside a rectangle.
  function chord(c, s, rho, x0, x1, y0, y1) {
    const e = lineEndpoints(c, s, rho, x0, x1, y0, y1);
    return e ? Math.hypot(e[2] - e[0], e[3] - e[1]) : 0;
  }
  function lineEndpoints(c, s, rho, x0, x1, y0, y1) {
    const pts = [];
    if (Math.abs(s) > 1e-6) for (const x of [x0, x1]) { const y = (rho - x * c) / s; if (y >= y0 && y <= y1) pts.push([x, y]); }
    if (Math.abs(c) > 1e-6) for (const y of [y0, y1]) { const x = (rho - y * s) / c; if (x >= x0 && x <= x1) pts.push([x, y]); }
    if (pts.length < 2) return null;
    let a = pts[0], b = pts[1], d = 0;
    for (const p of pts) for (const q of pts) { const dd = Math.hypot(p[0] - q[0], p[1] - q[1]); if (dd > d) { d = dd; a = p; b = q; } }
    return [a[0], a[1], b[0], b[1]];
  }

  // Spots, stains and dirt inside the border band, where the colour should be even. Only marks
  // DARKER than the surrounding border count: reflections, foil sparkle and glare are always
  // brighter, so they can't be mistaken for dirt. Each pixel is compared with the border colour
  // around that spot, and the threshold adapts to how textured the border is (foil, gradients).
  function spots(px, border) {
    const found = [];
    const visited = new Uint8Array(CW * CH);
    for (const name of SIDES) {
      if (border[name] == null || border[name] <= 1.8) continue;
      const d0 = 10, d1 = Math.max(12, Math.floor((border[name] - 0.6) * MM));
      const refs = localRefs(px, name, d0, d1, 40);
      const len = sideLen(name);
      // Texture of this border band → threshold.
      const devs = [];
      for (let t = 5 * MM; t < len - 5 * MM; t += 4) for (let m = d0; m <= d1; m += 3) devs.push(dist3(P(px, ...at(name, m, t)), refs[t]));
      const mad = median(devs);
      const thr = Math.max(45, mad * 6);
      const isMark = (p, ref) => {
        const dl = lumOf(...p) - lumOf(...ref);
        return dl < -12 && dist3(p, ref) > thr; // darker (or darker + discoloured) only
      };
      const tOf = (x, y) => (name === 'left' || name === 'right' ? y : x);
      for (let t = 5 * MM; t < len - 5 * MM; t++) {
        for (let m = d0; m <= d1; m++) {
          const [x, y] = at(name, m, t);
          const k = y * CW + x;
          if (visited[k] || !isMark(P(px, x, y), refs[t])) continue;
          const stack = [k];
          visited[k] = 1;
          let n = 0, sx = 0, sy = 0;
          while (stack.length && n < 4000) {
            const q = stack.pop();
            const qx = q % CW, qy = (q / CW) | 0;
            n++; sx += qx; sy += qy;
            for (const [nx, ny] of [[qx - 1, qy], [qx + 1, qy], [qx, qy - 1], [qx, qy + 1]]) {
              if (nx < d0 || ny < d0 || nx >= CW - d0 || ny >= CH - d0) continue;
              const nk = ny * CW + nx;
              if (visited[nk]) continue;
              const nt = clamp(tOf(nx, ny), 0, len - 1);
              if (isMark(P(px, nx, ny), refs[nt])) { visited[nk] = 1; stack.push(nk); }
            }
          }
          const areaMm2 = n / (MM * MM);
          if (areaMm2 >= 0.25 && areaMm2 < 40) found.push({ x: sx / n, y: sy / n, areaMm2 });
        }
      }
    }
    return found;
  }

  // Crinkles and cracks: short, jagged creases from bending, where the ink cracks and the white
  // paper core shows. Found as thin, sharp lines that are much brighter than the print right next
  // to them on BOTH sides (within 0.3 mm) and close to colourless, like bare paper.
  //   zone(x, y) → 'border' | 'art' | null says where to look:
  //   • border: the plain border band, where any such line is damage (even a short one).
  //   • art: inside the design, only with the official image (ref): the line must be much brighter
  //     than the official image there and not one of its own printed lines.
  function cracks(px, zone, ref) {
    const L = new Float32Array(CW * CH);
    const sat = new Uint8Array(CW * CH);
    for (let i = 0; i < CW * CH; i++) {
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      L[i] = lumOf(r, g, b);
      sat[i] = Math.max(r, g, b) - Math.min(r, g, b);
    }
    const inset = 8, hw = CW / 2;
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    const mask = new Uint8Array(CW * CH); // 1 = border crack pixel, 2 = artwork crack pixel
    for (let y = inset; y < CH - inset; y++) for (let x = inset; x < CW - inset; x++) {
      const z = zone(x, y);
      if (!z) continue;
      const i = y * CW + x;
      const v = L[i];
      const T = z === 'border' ? 40 : 45;
      if (z === 'border' ? (v < 100 || sat[i] > 80) : (v < 140 || sat[i] > 55)) continue;
      if (z === 'art') {
        const h = (y >> 1) * hw + (x >> 1);
        if (!ref || ref.known[h] || v - lumOf(ref.px[i * 4], ref.px[i * 4 + 1], ref.px[i * 4 + 2]) < 45) continue;
      }
      search: for (const d of [2, 3]) for (const [dx, dy] of dirs) {
        if (v - L[i + dy * d * CW + dx * d] > T && v - L[i - dy * d * CW - dx * d] > T) { mask[i] = z === 'border' ? 1 : 2; break search; }
      }
    }
    const seen = new Uint8Array(CW * CH);
    const found = [];
    for (let i = 0; i < CW * CH; i++) {
      if (!mask[i] || seen[i]) continue;
      const stack = [i];
      seen[i] = 1;
      let n = 0, nb = 0, x0 = CW, y0 = CH, x1 = 0, y1 = 0;
      while (stack.length) {
        const q = stack.pop(), qx = q % CW, qy = (q / CW) | 0;
        n++;
        if (mask[q] === 1) nb++;
        if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
        // bridge 1 px gaps (a crack's brightness varies along it)
        for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
          const nx = qx + ox, ny = qy + oy;
          if (nx < 0 || ny < 0 || nx >= CW || ny >= CH) continue;
          const k = ny * CW + nx;
          if (mask[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
        }
      }
      const extent = Math.hypot(x1 - x0 + 1, y1 - y0 + 1);
      const inBorder = nb >= n / 2;
      // Long enough to be a crack (shorter allowed in the plain border), and thin — a line, not a patch.
      if (extent >= (inBorder ? 1.2 : 2.5) * MM && n >= 8 && n <= extent * 7) found.push({ x0, y0, x1, y1, lengthMm: extent / MM, border: inBorder });
    }
    found.sort((a, b) => b.lengthMm - a.lengthMm);
    return { marks: found.slice(0, 40), totalMm: found.reduce((a, c) => a + c.lengthMm, 0) };
  }

  function glare(px) {
    let hot = 0, n = 0;
    for (let y = 30; y < CH - 30; y += 2) for (let x = 30; x < CW - 30; x += 2) {
      const i = (y * CW + x) * 4;
      n++;
      if (px[i] > 247 && px[i + 1] > 247 && px[i + 2] > 247) hot++;
    }
    return hot / n;
  }

  /* ---------------- 3. grades ---------------- */
  const centeringRatio = (a, b) => (a == null || b == null || a + b <= 0 ? null : (100 * a) / (a + b));
  const worstShare = (r) => (r == null ? null : Math.max(r, 100 - r));
  function gradeCentering(frontWorst, backWorst) {
    const f = frontWorst == null ? 10 : frontWorst <= 55 ? 10 : frontWorst <= 60 ? 9 : frontWorst <= 65 ? 8 : frontWorst <= 70 ? 7 : frontWorst <= 80 ? 6 : frontWorst <= 85 ? 5 : frontWorst <= 90 ? 4 : 3;
    const b = backWorst == null ? 10 : backWorst <= 75 ? 10 : backWorst <= 90 ? 9 : 5;
    return Math.min(f, b);
  }
  // f = share of the edge's length showing wear (clustered, sharp-step whitening only).
  const gradeWhitening = (f) => (f < 0.01 ? 10 : f < 0.03 ? 9 : f < 0.07 ? 8 : f < 0.13 ? 7 : f < 0.2 ? 6 : f < 0.3 ? 5 : f < 0.45 ? 4 : 3);
  // c = share of a corner's rim that is whitened.
  const gradeCornerWhite = (c) => (c < 0.04 ? 10 : c < 0.08 ? 9 : c < 0.14 ? 8 : c < 0.22 ? 7 : c < 0.32 ? 6 : 5);
  const gradeShape = (m) => (m < 0.07 ? 10 : m < 0.1 ? 9 : m < 0.14 ? 8 : m < 0.2 ? 7 : m < 0.28 ? 6 : 5);
  const combine = (gs) => Math.min(Math.round(gs.reduce((a, b) => a + b, 0) / gs.length * 2) / 2, Math.min(...gs) + 1);

  /* ---------------- reference image (what the card should look like) ---------------- */
  // The official picture of the card is lined up with the straightened photo (small shifts and
  // zooms are searched), its colours are matched to the photo's lighting, and then anything that
  // is part of the printed design can be told apart from damage.
  // One small canvas reused for every trial alignment (Safari limits total canvas memory).
  let lowCanvas = null;
  function lowLum(src, w, h, tf) {
    if (!lowCanvas || lowCanvas.width !== w || lowCanvas.height !== h) lowCanvas = canvas(w, h);
    const c = lowCanvas;
    const x = ctx2d(c);
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.imageSmoothingQuality = 'high';
    if (tf) x.setTransform(tf.s, 0, 0, tf.s, (w / 2) * (1 - tf.s) + tf.dx, (h / 2) * (1 - tf.s) + tf.dy);
    x.drawImage(src, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    const out = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = lumOf(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    return out;
  }
  function ncc(a, b, w, h, m) {
    let sa = 0, sb = 0, n = 0;
    for (let y = m; y < h - m; y++) for (let x = m; x < w - m; x++) { sa += a[y * w + x]; sb += b[y * w + x]; n++; }
    const ma = sa / n, mb = sb / n;
    let ab = 0, aa = 0, bb = 0;
    for (let y = m; y < h - m; y++) for (let x = m; x < w - m; x++) {
      const p = a[y * w + x] - ma, q = b[y * w + x] - mb;
      ab += p * q; aa += p * p; bb += q * q;
    }
    return ab / Math.sqrt(aa * bb || 1);
  }
  function dilate(mask, w, h, r) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) out[yy * w + xx] = 1;
    }
    return out;
  }
  const ART_DIFF_LIMIT = 60;
  // Line the official image's *artwork* up with the photo's (the area inside the borders), first
  // coarsely, then to the pixel. Aligning the content rather than the card's outline is what lets
  // us read the centering off the alignment: how far the printed design sits from each edge.
  function alignContent(refImg, card) {
    const S = 5, lw = CW / S, lh = Math.round(CH / S);
    const photoLow = lowLum(card, lw, lh);
    let best = { score: -2 };
    for (const s of [0.98, 0.99, 1, 1.01, 1.02]) for (let dx = -8; dx <= 8; dx++) for (let dy = -8; dy <= 8; dy++) {
      const score = ncc(photoLow, lowLum(refImg, lw, lh, { s, dx, dy }), lw, lh, 12);
      if (score > best.score) best = { score, s, dx: dx * S, dy: dy * S };
    }
    // Refine at half resolution, 1 px (0.1 mm) steps.
    const hw = CW / 2, hh = CH / 2;
    const photoHalf = lowLum(card, hw, hh);
    const at = (s, dx, dy) => ncc(photoHalf, lowLum(refImg, hw, hh, { s, dx: dx / 2, dy: dy / 2 }), hw, hh, 30);
    let fine = { ...best, score: at(best.s, best.dx, best.dy) };
    for (let round = 0; round < 2; round++) {
      const c = { ...fine };
      for (let dx = c.dx - 5; dx <= c.dx + 5; dx++) for (let dy = c.dy - 5; dy <= c.dy + 5; dy++) {
        const sc = at(c.s, dx, dy);
        if (sc > fine.score) fine = { s: c.s, dx, dy, score: sc };
      }
      for (const s of [fine.s - 0.004, fine.s + 0.004]) {
        const sc = at(s, fine.dx, fine.dy);
        if (sc > fine.score) fine = { ...fine, s, score: sc };
      }
    }
    return fine;
  }
  function prepareReference(refImg, card, px) {
    const best = alignContent(refImg, card);
    if (best.score < 0.45) return { ok: false, match: best.score };
    // The official image's own borders (it may not be perfectly centred itself).
    const c0 = canvas(CW, CH);
    const x0 = ctx2d(c0);
    x0.imageSmoothingQuality = 'high';
    x0.drawImage(refImg, 0, 0, CW, CH);
    const refB = borders(x0.getImageData(0, 0, CW, CH).data);
    // Where those border lines land on the photo = the photo's border widths.
    const ox = (CW / 2) * (1 - best.s) + best.dx, oy = (CH / 2) * (1 - best.s) + best.dy;
    const mm = (v) => (v != null && v > 0.2 && v < 12 ? Math.round(v * 100) / 100 : null);
    const centering = {
      left: refB.left == null ? null : mm((best.s * refB.left * MM + ox) / MM),
      right: refB.right == null ? null : mm((CW - (best.s * (CW - refB.right * MM) + ox)) / MM),
      top: refB.top == null ? null : mm((best.s * refB.top * MM + oy) / MM),
      bottom: refB.bottom == null ? null : mm((CH - (best.s * (CH - refB.bottom * MM) + oy)) / MM),
    };
    // Full-resolution reference with that alignment.
    const c = canvas(CW, CH);
    const x = ctx2d(c);
    x.fillStyle = '#000'; x.fillRect(0, 0, CW, CH);
    x.imageSmoothingQuality = 'high';
    x.setTransform(best.s, 0, 0, best.s, ox, oy);
    x.drawImage(refImg, 0, 0, CW, CH);
    const ref = x.getImageData(0, 0, CW, CH).data;
    // Match colours: photo ≈ a·ref + b per channel (lighting and white balance).
    for (let ch = 0; ch < 3; ch++) {
      let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
      for (let y = 4 * MM; y < CH - 4 * MM; y += 3) for (let xx = 4 * MM; xx < CW - 4 * MM; xx += 3) {
        const i = (y * CW + xx) * 4 + ch, r = ref[i], p = px[i];
        sx += r; sy += p; sxx += r * r; sxy += r * p; n++;
      }
      const a = (n * sxy - sx * sy) / ((n * sxx - sx * sx) || 1), b = (sy - a * sx) / n;
      for (let i = ch; i < ref.length; i += 4) ref[i] = a * ref[i] + b;
    }
    // Is it really the same card? Different cards share the frame and text box, so compare the
    // artwork window: typical colour difference after matching the lighting.
    const diffs = [];
    for (let y = Math.round(CH * 0.12); y < CH * 0.5; y += 4) for (let xx = Math.round(CW * 0.1); xx < CW * 0.9; xx += 4) diffs.push(dist3(P(px, xx, y), P(ref, xx, y)));
    const artDiff = median(diffs);
    if (artDiff > ART_DIFF_LIMIT) return { ok: false, match: best.score, artDiff };
    const { L: Lr, w, h } = lumHalf(ref);
    const { ridge } = ridgeMap(Lr, w, h, 1, null);
    const known = dilate(ridge, w, h, 4);
    // Strong edges of the design (a slightly misaligned edge would otherwise look like a mark).
    const strong = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let xx = 1; xx < w - 1; xx++) {
      const g = Math.max(Math.abs(Lr[y * w + xx + 1] - Lr[y * w + xx - 1]), Math.abs(Lr[(y + 1) * w + xx] - Lr[(y - 1) * w + xx]));
      if (g > 20) strong[y * w + xx] = 1;
    }
    return { ok: true, match: best.score, artDiff, centering, px: ref, Lr, known, busy: dilate(strong, w, h, 4) };
  }
  // Marks on the card's surface that aren't in the official image: dark spots, stains, dents.
  // Compared after removing broad lighting differences, and only where the design is smooth.
  function surfaceMarks(px, ref) {
    const { L, w, h } = lumHalf(px);
    const D = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) D[i] = L[i] - ref.Lr[i];
    const B = boxBlur(D, w, h, 8);
    const inset = Math.round(1.5 * MM / 2);
    const isMark = (i) => D[i] - B[i] < -50 && !ref.known[i] && !ref.busy[i];
    const seen = new Uint8Array(w * h);
    const found = [];
    for (let y = inset; y < h - inset; y++) for (let x = inset; x < w - inset; x++) {
      const k = y * w + x;
      if (seen[k] || !isMark(k)) continue;
      const stack = [k];
      seen[k] = 1;
      let n = 0, sx = 0, sy = 0;
      while (stack.length && n < 3000) {
        const q = stack.pop(), qx = q % w, qy = (q / w) | 0;
        n++; sx += qx; sy += qy;
        for (const nb of [q - 1, q + 1, q - w, q + w]) {
          const nx = nb % w, ny = (nb / w) | 0;
          if (nx < inset || ny < inset || nx >= w - inset || ny >= h - inset || seen[nb] || !isMark(nb)) continue;
          seen[nb] = 1;
          stack.push(nb);
        }
      }
      const areaMm2 = (n * 4) / (MM * MM);
      if (areaMm2 >= 0.5 && areaMm2 < 40) found.push({ x: (sx / n) * 2, y: (sy / n) * 2, areaMm2, surface: true });
    }
    return found;
  }

  function analyseSide(photo, label, refImg) {
    const loc = locate(photo);
    if (!loc) return { label, error: `Couldn’t find the card in the ${label} photo. Lay it on a plain surface that contrasts with its edges (e.g. grey or wood), with some space around it.` };
    const px = pixels(loc.card);
    const ref = refImg ? prepareReference(refImg, loc.card, px) : null;
    // Centering: measured on the photo; the official image fills in a side the photo couldn't
    // measure, or corrects one that disagrees with it by more than 1 mm.
    let border = borders(px), centeringFrom = 'photo';
    if (ref?.ok && ref.centering) {
      const merged = { ...border };
      for (const k of SIDES) {
        const r = ref.centering[k];
        if (r != null && (merged[k] == null || Math.abs(merged[k] - r) > 1)) { merged[k] = r; centeringFrom = 'photo + official image'; }
      }
      border = merged;
    }
    // Does the card stand out from the background? (A dark-blue back on a dark table doesn't, and
    // then its edges — and so the centering — can be misplaced.)
    const rim = [];
    for (let i = 0; i < 30; i++) {
      const f = 0.2 + 0.6 * i / 29, m = Math.round(1.5 * MM);
      rim.push(P(px, m, Math.round(CH * f)), P(px, CW - 1 - m, Math.round(CH * f)), P(px, Math.round(CW * f), m), P(px, Math.round(CW * f), CH - 1 - m));
    }
    const lowContrast = !!loc.bg && dist3(medColor(rim), loc.bg) < 45;
    const ed = edges(px);
    const co = corners(px, loc.bg, loc.thr);
    // Creases: always checked on the back (logo bands excepted); on the front only when the
    // official image is there to separate the design's own lines from damage.
    let cr = { found: false };
    if (label === 'back') cr = creases(px, { logoBands: true });
    else if (ref?.ok) cr = creases(px, { known: ref.known, refPx: ref.px });
    // Crinkles: in the plain border band on both sides; inside the artwork of the front only when
    // the official image can tell the design's own thin bright lines apart from cracks. (The back's
    // swirl is full of thin white streaks, so its artwork isn't checked this way.)
    const zone = (x, y) => {
      if (Math.min(x, CW - 1 - x) < 3.5 * MM && Math.min(y, CH - 1 - y) < 3.5 * MM) return null; // corners: graded as corners
      const b = (k, d) => border[k] != null && d < border[k] * MM - 3;
      if (b('left', x) || b('right', CW - 1 - x) || b('top', y) || b('bottom', CH - 1 - y)) return 'border';
      return label === 'front' && ref?.ok ? 'art' : null;
    };
    const ck = cracks(px, zone, ref?.ok ? ref : null);
    const sp = spots(px, border);
    if (ref?.ok) sp.push(...surfaceMarks(px, ref).slice(0, 8));
    const gl = glare(px);
    return { label, loc, border, centeringFrom, lowContrast, edges: ed, corners: co, crease: cr, cracks: ck, spots: sp, glare: gl, reference: ref && { ok: ref.ok, match: ref.match, artDiff: ref.artDiff, centering: ref.centering || null } };
  }

  // opts.reference: the official image of the card (an <img> or bitmap), for the front.
  async function grade(frontFile, backFile, opts = {}) {
    const front = analyseSide(toCanvas(await loadImage(frontFile)), 'front', opts.reference || null);
    const back = backFile ? analyseSide(toCanvas(await loadImage(backFile)), 'back') : null;
    const sides = [front, back].filter(Boolean);
    const errors = sides.filter((s) => s.error).map((s) => s.error);
    if (errors.length) return { ok: false, errors };

    const warnings = [];
    for (const s of sides) {

      if (s.glare > 0.015) warnings.push(`Glare on the ${s.label} — tilt the card or light away from reflections.`);
      if (s.lowContrast) warnings.push(`The ${s.label} of the card blends into the background, so its edges (and centering) may be measured inaccurately — photograph it on a plain surface that contrasts with its border, e.g. grey or wood for the dark-blue back.`);
      if (s.loc.pxPerMm < 6) warnings.push(`The ${s.label} photo is low resolution — get closer so the card fills more of the frame.`);
      if (Math.abs(s.loc.tilt) > 8) warnings.push(`The ${s.label} card was rotated ${Math.abs(s.loc.tilt).toFixed(0)}°; it was straightened, but a squarer photo is more accurate.`);
    }

    // One note for angled photos (they're straightened, so this only slightly lowers confidence).
    const angled = sides.filter((s) => !s.loc.aspectOk || s.loc.keystone > 0.08).map((s) => s.label);
    if (angled.length) warnings.push(`The ${angled.join(' and ')} photo${angled.length > 1 ? 's were' : ' was'} taken at an angle — straightened automatically, but shooting straight down gives the most accurate centering.`);

    // Centering
    const cen = {};
    for (const s of sides) {
      const lr = centeringRatio(s.border.left, s.border.right);
      const tb = centeringRatio(s.border.top, s.border.bottom);
      cen[s.label] = { lr, tb, worst: Math.max(worstShare(lr) ?? 0, worstShare(tb) ?? 0) || null, mm: s.border, measurable: lr != null || tb != null };
    }
    // Not measurable (e.g. borderless full art) → left out of the grade rather than counted as 10.
    const centeringGrade = cen.front?.measurable ? gradeCentering(cen.front.worst, cen.back?.worst ?? null) : null;

    // Edges
    const sideNames = ['top', 'right', 'bottom', 'left'];
    const edgeGrades = [];
    for (const s of sides) for (const n of sideNames) edgeGrades.push(gradeWhitening(s.edges[n].whitening));
    const edgesGrade = combine(edgeGrades);

    // Corners
    const cornerGrades = [];
    for (const s of sides) for (const c of Object.values(s.corners)) cornerGrades.push(Math.min(gradeCornerWhite(c.whitening), gradeShape(c.shape)));
    const cornersGrade = combine(cornerGrades);

    // Surface
    const allSpots = sides.flatMap((s) => s.spots.map((p) => ({ ...p, side: s.label })));
    const spotArea = allSpots.reduce((a, p) => a + p.areaMm2, 0);
    let surfaceGrade = allSpots.length === 0 ? 10 : spotArea < 0.6 ? 9 : spotArea < 2 ? 8 : spotArea < 6 ? 7 : 6;
    const creaseSide = [back, front].find((s) => s?.crease?.found) || null;
    const crease = creaseSide ? creaseSide.crease : null;
    if (crease) surfaceGrade = Math.min(surfaceGrade, crease.strength > 0.8 && crease.lengthMm > 30 ? 4 : 5);
    // Crinkles / cracks: graded by their total length.
    const crackMm = sides.reduce((a, s) => a + (s.cracks?.totalMm || 0), 0);
    const crackN = sides.reduce((a, s) => a + (s.cracks?.marks.length || 0), 0);
    const crinkled = crackN >= 2 || crackMm >= 3;
    if (crinkled) surfaceGrade = Math.min(surfaceGrade, crackMm < 6 ? 6 : crackMm < 15 ? 5 : crackMm < 40 ? 4 : 3);
    else if (crackN === 1) surfaceGrade = Math.min(surfaceGrade, 8);

    const subs = { centering: centeringGrade, corners: cornersGrade, edges: edgesGrade, surface: surfaceGrade };
    const counted = Object.values(subs).filter((v) => v != null);
    let overall = Math.min(Math.round(counted.reduce((a, b) => a + b, 0) / counted.length), Math.floor(Math.min(...counted)) + 1);
    if (centeringGrade != null) overall = Math.min(overall, centeringGrade); // PSA caps a grade by its centering
    if (crease || crinkled) overall = Math.min(overall, surfaceGrade + 1);
    overall = clamp(overall, 1, 10);

    // Findings, in plain words.
    const findings = [];
    for (const s of sides) {
      for (const n of sideNames) {
        const w = s.edges[n].whitening;
        if (w >= 0.03) findings.push({ level: w >= 0.13 ? 'bad' : 'warn', text: `Edge wear (whitening) on the ${n} edge of the ${s.label} — about ${(w * 100).toFixed(0)}% of its length` });
      }
      for (const [n, c] of Object.entries(s.corners)) {
        const nice = n.replace(/([A-Z])/g, ' $1').toLowerCase();
        if (c.shape >= 0.14) findings.push({ level: c.shape >= 0.2 ? 'bad' : 'warn', text: `${nice[0].toUpperCase() + nice.slice(1)} corner (${s.label}) looks dinged or bent` });
        else if (c.whitening >= 0.08) findings.push({ level: c.whitening >= 0.22 ? 'bad' : 'warn', text: `Whitening on the ${nice} corner (${s.label})` });
      }
    }
    if (crease) findings.push({ level: 'bad', text: `Likely crease on the ${creaseSide.label}, about ${crease.lengthMm.toFixed(0)} mm long` });
    else {
      const faint = [back, front].find((s) => s?.crease?.faint);
      if (faint) findings.push({ level: 'info', text: `A faint straight line (~${faint.crease.lengthMm.toFixed(0)} mm) on the ${faint.label} could be a light crease or part of the printed design — tilt the card under a light to check. Not counted against the grade.` });
    }
    if (crackN) {
      const where = sides.filter((s) => s.cracks?.marks.length).map((s) => s.label).join(' and ');
      findings.push(crinkled
        ? { level: 'bad', text: `Creasing / crinkles on the ${where}: ${crackN} white crack line${crackN === 1 ? '' : 's'} where the paper shows through (~${Math.round(crackMm)} mm in total)` }
        : { level: 'warn', text: `A small white line on the ${where} — a light crinkle or scratch (~${crackMm.toFixed(1)} mm)` });
    }
    for (const p of allSpots.slice(0, 6)) findings.push({ level: p.areaMm2 > 2 ? 'bad' : 'warn', text: p.surface ? `Mark or stain on the ${p.side} surface that isn’t on the official card image (~${p.areaMm2.toFixed(1)} mm²)` : `Spot or stain on the ${p.side} border (~${p.areaMm2.toFixed(1)} mm²)` });
    if (front.reference?.ok) findings.push({ level: 'info', text: `Front compared with the official card image (${Math.round(front.reference.match * 100)}% match) — the card’s own artwork and printed lines are ignored, so only differences count` });
    else if (front.reference && !front.reference.ok) warnings.push('Your front photo doesn’t closely match the selected card’s official image — check you picked the right card (or reduce glare). It wasn’t used for this grade.');
    const lit = sides.filter((s) => SIDES.some((n) => s.edges[n].shine > 0.04 || s.edges[n].uneven > 35) || Object.values(s.corners).some((c) => c.shine > 0.08) || s.glare > 0.004);
    if (lit.length) findings.push({ level: 'info', text: `Reflections / holo shine detected on the ${lit.map((s) => s.label).join(' and ')} — recognised as light, not wear, and not counted against the grade` });
    if (cen.front?.worst > 60) findings.push({ level: cen.front.worst > 70 ? 'bad' : 'warn', text: `Front is off-center (${fmtRatio(cen.front)})` });
    if (!cen.front?.measurable) {
      findings.push({ level: 'warn', text: 'Front centering couldn’t be measured, so it isn’t included in the grade — select the card under “Which card is this?” to measure it against the official image, or retake the photo straight on with even light' });
    } else if (front.centeringFrom !== 'photo') {
      findings.push({ level: 'info', text: 'Front centering measured with help from the official card image' });
    }
    if (!findings.some((f) => f.level === 'bad' || f.level === 'warn')) findings.unshift({ level: 'good', text: 'No wear, creases or marks detected' });

    const confidence = warnings.length === 0 ? 'good' : warnings.length === 1 ? 'fair' : 'low';
    return {
      ok: true,
      overall,
      range: [clamp(overall - 1, 1, 10), clamp(overall + (confidence === 'good' ? 0 : 1), 1, 10)],
      subs, centering: cen, findings, warnings, confidence,
      sides: Object.fromEntries(sides.map((s) => [s.label, s])),
    };
  }

  function fmtRatio(c) {
    const r = (v) => (v == null ? '—' : `${Math.round(v)}/${100 - Math.round(v)}`);
    return `L/R ${r(c.lr)} · T/B ${r(c.tb)}`;
  }

  // Draw the straightened card with what was measured: border lines, worn edge segments,
  // corner boxes, crease line and spots.
  function drawOverlay(side, target) {
    const s = side;
    target.width = CW; target.height = CH;
    const x = target.getContext('2d');
    x.drawImage(s.loc.card, 0, 0);
    x.lineWidth = 3;
    const b = s.border;
    x.setLineDash([10, 8]);
    x.strokeStyle = 'rgba(34, 211, 238, .95)';
    if (b.left != null) { x.beginPath(); x.moveTo(b.left * MM, 0); x.lineTo(b.left * MM, CH); x.stroke(); }
    if (b.right != null) { x.beginPath(); x.moveTo(CW - b.right * MM, 0); x.lineTo(CW - b.right * MM, CH); x.stroke(); }
    if (b.top != null) { x.beginPath(); x.moveTo(0, b.top * MM); x.lineTo(CW, b.top * MM); x.stroke(); }
    if (b.bottom != null) { x.beginPath(); x.moveTo(0, CH - b.bottom * MM); x.lineTo(CW, CH - b.bottom * MM); x.stroke(); }
    x.setLineDash([]);
    x.lineWidth = 8;
    x.strokeStyle = 'rgba(255, 77, 109, .95)';
    for (const [n, e] of Object.entries(s.edges)) for (const seg of e.marks) {
      x.beginPath();
      if (n === 'left') { x.moveTo(4, seg.from); x.lineTo(4, seg.to); }
      if (n === 'right') { x.moveTo(CW - 4, seg.from); x.lineTo(CW - 4, seg.to); }
      if (n === 'top') { x.moveTo(seg.from, 4); x.lineTo(seg.to, 4); }
      if (n === 'bottom') { x.moveTo(seg.from, CH - 4); x.lineTo(seg.to, CH - 4); }
      x.stroke();
    }
    x.lineWidth = 3;
    const size = 4.5 * MM;
    for (const [n, c] of Object.entries(s.corners)) {
      const bad = c.shape >= 0.14 || c.whitening >= 0.08;
      x.strokeStyle = bad ? 'rgba(255, 77, 109, .95)' : 'rgba(52, 245, 166, .9)';
      const cx = n.endsWith('Right') ? CW - size : 0, cy = n.startsWith('bottom') ? CH - size : 0;
      x.strokeRect(cx + 1.5, cy + 1.5, size - 3, size - 3);
    }
    if (s.crease?.found && s.crease.line) {
      const [a, bb, c2, d] = s.crease.line;
      x.strokeStyle = 'rgba(251, 191, 36, .95)';
      x.lineWidth = 5;
      x.setLineDash([16, 10]);
      x.beginPath(); x.moveTo(a, bb); x.lineTo(c2, d); x.stroke();
      x.setLineDash([]);
    }
    x.strokeStyle = 'rgba(251, 191, 36, .95)';
    x.lineWidth = 3;
    for (const c of s.cracks?.marks || []) x.strokeRect(c.x0 - 6, c.y0 - 6, c.x1 - c.x0 + 12, c.y1 - c.y0 + 12);
    for (const p of s.spots) { x.beginPath(); x.arc(p.x, p.y, Math.max(10, Math.sqrt(p.areaMm2) * MM), 0, Math.PI * 2); x.stroke(); }
  }

  window.CardGrader = { grade, drawOverlay, fmtRatio, MM };
})();
