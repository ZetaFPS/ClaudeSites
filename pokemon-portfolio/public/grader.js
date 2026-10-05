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
 *        surface    – creases (long straight light/dark lines, back), spots/stains in the
 *                     borders, and glare that makes the photo unreliable
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

  // Sub-pixel-ish outer edges at full resolution: scan many lines across each coarse edge.
  function refineEdges(src, box, bg, thr) {
    const W = src.width, H = src.height;
    const px = ctx2d(src).getImageData(0, 0, W, H).data;
    const at = (x, y) => { const i = (y * W + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
    const isCard = (x, y) => x >= 0 && y >= 0 && x < W && y < H && dist3(at(x, y), bg) > thr;
    const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
    const mx = Math.max(6, Math.round(bw * 0.04)), my = Math.max(6, Math.round(bh * 0.04));
    const scan = (from, to, step, fixed, horizontal) => {
      for (let v = from; step > 0 ? v <= to : v >= to; v += step) {
        const ok = horizontal ? isCard(v, fixed) && isCard(v + step, fixed) && isCard(v + 2 * step, fixed)
          : isCard(fixed, v) && isCard(fixed, v + step) && isCard(fixed, v + 2 * step);
        if (ok) return v;
      }
      return null;
    };
    const L = [], R = [], T = [], B = [];
    for (let i = 0; i < 60; i++) {
      const y = Math.round(box.y0 + bh * (0.2 + 0.6 * i / 59));
      const x = Math.round(box.x0 + bw * (0.2 + 0.6 * i / 59));
      const l = scan(Math.round(box.x0 - mx), Math.round(box.x0 + mx), 1, y, true); if (l != null) L.push(l);
      const r = scan(Math.round(box.x1 + mx), Math.round(box.x1 - mx), -1, y, true); if (r != null) R.push(r + 1);
      const t = scan(Math.round(box.y0 - my), Math.round(box.y0 + my), 1, x, false); if (t != null) T.push(t);
      const b = scan(Math.round(box.y1 + my), Math.round(box.y1 - my), -1, x, false); if (b != null) B.push(b + 1);
    }
    const pick = (arr, fallback) => (arr.length >= 15 ? median(arr) : fallback);
    return { x0: pick(L, box.x0), x1: pick(R, box.x1), y0: pick(T, box.y0), y1: pick(B, box.y1) };
  }

  function locate(photo) {
    const c1 = coarse(photo);
    if (!c1) return null;
    let src = photo, c2 = c1;
    if (Math.abs(c1.tilt) > 0.25) {
      src = rotate(photo, -c1.tilt, c1.bg);
      c2 = coarse(src) || c1;
    }
    const e = refineEdges(src, c2.box, c2.bg, c2.thr);
    const w = e.x1 - e.x0, h = e.y1 - e.y0;
    const aspect = w / h;
    const card = canvas(CW, CH);
    const x = ctx2d(card);
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, e.x0, e.y0, w, h, 0, 0, CW, CH);
    return {
      card, tilt: c1.tilt, bg: c2.bg, thr: c2.thr,
      pxPerMm: h / 88, aspect, aspectOk: Math.abs(aspect - 63 / 88) < 0.05,
    };
  }

  /* ---------------- 2. measurements on the 10 px/mm card ---------------- */
  function pixels(card) { return ctx2d(card).getImageData(0, 0, CW, CH).data; }
  const P = (px, x, y) => { const i = (y * CW + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };

  // Border width on each side (mm), scanning inward until the colour stops matching the
  // border's own colour. Returns null for a side that has no measurable border (full art).
  function borders(px) {
    const side = (name) => {
      const vals = [];
      for (let i = 0; i < 40; i++) {
        const f = 0.25 + 0.5 * i / 39;
        const coord = (m) => {
          // m = distance from this side's edge (px) → (x, y)
          if (name === 'left') return [m, Math.round(CH * f)];
          if (name === 'right') return [CW - 1 - m, Math.round(CH * f)];
          if (name === 'top') return [Math.round(CW * f), m];
          return [Math.round(CW * f), CH - 1 - m];
        };
        const ref = medColor([10, 12, 14, 16, 18].map((m) => P(px, ...coord(m))));
        const noise = Math.max(...[10, 12, 14, 16, 18].map((m) => dist3(P(px, ...coord(m)), ref)));
        const thr = Math.max(42, noise * 3);
        for (let m = 18; m < 16 * MM; m++) {
          if (dist3(P(px, ...coord(m)), ref) > thr && dist3(P(px, ...coord(m + 1)), ref) > thr && dist3(P(px, ...coord(m + 2)), ref) > thr) {
            vals.push(m);
            break;
          }
        }
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
    for (let m = 2; m <= 7; m++) { // 0.2–0.7 mm: where chipping shows
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
          if (depth < 1.5 || depth > 12) continue;
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
  function creases(px) {
    const { L, w, h } = lumHalf(px);
    const inset = Math.round(2.5 * MM / 2);
    const d = 2, t = 10;
    const pts = [];
    const ridge = new Uint8Array(w * h);
    const pairs = [[d, 0], [0, d], [d, d], [d, -d]];
    for (let y = inset; y < h - inset; y++) for (let x = inset; x < w - inset; x++) {
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
    // A crease is one continuous line; text and patterns line up only in short pieces.
    // Walk each candidate line and measure its longest run (allowing 3 px gaps).
    let best = null;
    const pairAngles = [0, 90, 45, 135];
    for (const c of cands.slice(0, 40)) {
      const seg = lineEndpoints(cos[c.k], sin[c.k], c.rho, inset, w - inset, inset, h - inset);
      if (!seg) continue;
      // The cross-line profile must run along the line's normal (angle c.deg).
      let want = 0;
      for (let q = 0; q < 4; q++) { const dA = Math.abs(((c.deg - pairAngles[q]) % 180 + 180) % 180); if (Math.min(dA, 180 - dA) <= 23) want |= 1 << q; }
      const n = Math.ceil(Math.hypot(seg[2] - seg[0], seg[3] - seg[1]));
      let run = 0, gap = 0, longest = 0, start = 0, bestFrom = 0, bestTo = 0;
      for (let i = 0; i <= n; i++) {
        const x = Math.round(seg[0] + (seg[2] - seg[0]) * i / n), y = Math.round(seg[1] + (seg[3] - seg[1]) * i / n);
        let on = false;
        for (let oy = -1; oy <= 1 && !on; oy++) for (let ox = -1; ox <= 1 && !on; ox++) on = !!(ridge[(y + oy) * w + x + ox] & want);
        if (on) { if (!run) start = i; run = i - start + 1; gap = 0; } else if (run && ++gap > 10) { run = 0; gap = 0; }
        if (run > longest) { longest = run; bestFrom = start; bestTo = i; }
      }
      const runMm = (longest * 2) / MM;
      if (!best || runMm > best.runMm) {
        const at = (i) => [seg[0] + (seg[2] - seg[0]) * i / n, seg[1] + (seg[3] - seg[1]) * i / n];
        best = { ...c, runMm, line: [...at(bestFrom), ...at(bestTo)] };
      }
    }
    if (!best || best.runMm < 15) return { found: false, strength: best ? best.runMm : 0 };
    return {
      found: true,
      strength: best.density,
      lengthMm: best.runMm,
      line: best.line.map((v) => v * 2), // back to 10 px/mm coordinates
    };
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

  function analyseSide(photo, label) {
    const loc = locate(photo);
    if (!loc) return { label, error: `Couldn’t find the card in the ${label} photo. Lay it on a plain, dark surface with some space around it.` };
    const px = pixels(loc.card);
    const border = borders(px);
    const ed = edges(px);
    const co = corners(px, loc.bg, loc.thr);
    const cr = label === 'back' ? creases(px) : { found: false };
    const sp = spots(px, border);
    const gl = glare(px);
    return { label, loc, border, edges: ed, corners: co, crease: cr, spots: sp, glare: gl };
  }

  async function grade(frontFile, backFile) {
    const front = analyseSide(toCanvas(await loadImage(frontFile)), 'front');
    const back = backFile ? analyseSide(toCanvas(await loadImage(backFile)), 'back') : null;
    const sides = [front, back].filter(Boolean);
    const errors = sides.filter((s) => s.error).map((s) => s.error);
    if (errors.length) return { ok: false, errors };

    const warnings = [];
    for (const s of sides) {
      if (!s.loc.aspectOk) warnings.push(`The ${s.label} photo looks angled (card proportions are off) — shoot straight down for accurate centering.`);
      if (s.glare > 0.015) warnings.push(`Glare on the ${s.label} — tilt the card or light away from reflections.`);
      if (s.loc.pxPerMm < 6) warnings.push(`The ${s.label} photo is low resolution — get closer so the card fills more of the frame.`);
      if (Math.abs(s.loc.tilt) > 8) warnings.push(`The ${s.label} card was rotated ${Math.abs(s.loc.tilt).toFixed(0)}°; it was straightened, but a squarer photo is more accurate.`);
    }

    // Centering
    const cen = {};
    for (const s of sides) {
      const lr = centeringRatio(s.border.left, s.border.right);
      const tb = centeringRatio(s.border.top, s.border.bottom);
      cen[s.label] = { lr, tb, worst: Math.max(worstShare(lr) ?? 0, worstShare(tb) ?? 0) || null, mm: s.border, measurable: lr != null || tb != null };
    }
    const centeringGrade = gradeCentering(cen.front?.worst ?? null, cen.back?.worst ?? null);

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
    const crease = back?.crease?.found ? back.crease : null;
    if (crease) surfaceGrade = Math.min(surfaceGrade, crease.strength > 0.8 && crease.lengthMm > 30 ? 4 : 5);

    const subs = { centering: centeringGrade, corners: cornersGrade, edges: edgesGrade, surface: surfaceGrade };
    let overall = Math.min(Math.round((centeringGrade + cornersGrade + edgesGrade + surfaceGrade) / 4), Math.floor(Math.min(...Object.values(subs))) + 1);
    overall = Math.min(overall, centeringGrade); // PSA caps a grade by its centering
    if (crease) overall = Math.min(overall, surfaceGrade + 1);
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
    if (crease) findings.push({ level: 'bad', text: `Possible crease on the back, about ${crease.lengthMm.toFixed(0)} mm long` });
    for (const p of allSpots.slice(0, 6)) findings.push({ level: p.areaMm2 > 2 ? 'bad' : 'warn', text: `Spot or stain on the ${p.side} border (~${p.areaMm2.toFixed(1)} mm²)` });
    const lit = sides.filter((s) => SIDES.some((n) => s.edges[n].shine > 0.04 || s.edges[n].uneven > 35) || Object.values(s.corners).some((c) => c.shine > 0.08) || s.glare > 0.004);
    if (lit.length) findings.push({ level: 'info', text: `Reflections / holo shine detected on the ${lit.map((s) => s.label).join(' and ')} — recognised as light, not wear, and not counted against the grade` });
    if (cen.front?.worst > 60) findings.push({ level: cen.front.worst > 70 ? 'bad' : 'warn', text: `Front is off-center (${fmtRatio(cen.front)})` });
    if (!cen.front?.measurable) findings.push({ level: 'info', text: 'Front centering couldn’t be measured (full-art or borderless card?)' });
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
    for (const p of s.spots) { x.beginPath(); x.arc(p.x, p.y, Math.max(10, Math.sqrt(p.areaMm2) * MM), 0, Math.PI * 2); x.stroke(); }
  }

  window.CardGrader = { grade, drawOverlay, fmtRatio, MM };
})();
