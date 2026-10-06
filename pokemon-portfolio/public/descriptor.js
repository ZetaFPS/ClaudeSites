/* Compact visual fingerprint of a card image, shared by the browser (scanned photos) and the
 * server (the catalogue index), so both sides measure images exactly the same way.
 *
 * Input: RGB(A) pixels of a card resampled to 126×176 (2 px per mm of a 63×88 mm card).
 * Output: 336 signed bytes:
 *   [0, 144)    whole-card colour layout, 6×8 grid × RGB, each channel normalised
 *   [144, 288)  artwork colour layout, 8×6 grid × RGB, each channel normalised
 *   [288, 336)  artwork edge directions, 3×2 cells × 8 orientations
 * Per-channel normalisation cancels lighting and white balance; edge directions capture shapes.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CardDescriptor = api;
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const W = 126, H = 176;
  const LEN = 336;
  const ART = { x0: 10, x1: 116, y0: 18, y1: 93 }; // artwork box in the 126×176 frame
  const LAYOUT_SCALE = 40, EDGE_SCALE = 127;

  // Average colour of each cell of a gx×gy grid over a pixel rectangle.
  function grid(px, ch, x0, y0, x1, y1, gx, gy) {
    const out = new Float32Array(gx * gy * 3);
    for (let cy = 0; cy < gy; cy++) {
      for (let cx = 0; cx < gx; cx++) {
        const ax = Math.round(x0 + (x1 - x0) * cx / gx), bx = Math.round(x0 + (x1 - x0) * (cx + 1) / gx);
        const ay = Math.round(y0 + (y1 - y0) * cy / gy), by = Math.round(y0 + (y1 - y0) * (cy + 1) / gy);
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = ay; y < by; y++) for (let x = ax; x < bx; x++) {
          const i = (y * W + x) * ch;
          r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
        }
        const k = cy * gx + cx;
        out[k] = r / n; out[gx * gy + k] = g / n; out[2 * gx * gy + k] = b / n;
      }
    }
    // Normalise each channel to zero mean / unit variance.
    const n = gx * gy;
    for (let c = 0; c < 3; c++) {
      let m = 0, v = 0;
      for (let k = 0; k < n; k++) m += out[c * n + k];
      m /= n;
      for (let k = 0; k < n; k++) v += (out[c * n + k] - m) ** 2;
      const sd = Math.sqrt(v / n) || 1;
      for (let k = 0; k < n; k++) out[c * n + k] = (out[c * n + k] - m) / sd;
    }
    return out;
  }

  function edges(px, ch) {
    const { x0, x1, y0, y1 } = ART;
    const w = x1 - x0, h = y1 - y0;
    const g = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = ((y + y0) * W + x + x0) * ch;
      g[y * w + x] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    }
    const CX = 3, CY = 2, BINS = 8;
    const hist = new Float32Array(CX * CY * BINS);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const gx = g[y * w + x + 1] - g[y * w + x - 1], gy = g[(y + 1) * w + x] - g[(y - 1) * w + x];
      const mag = Math.hypot(gx, gy);
      if (mag < 6) continue;
      const ang = (Math.atan2(gy, gx) + Math.PI) % Math.PI;
      const bin = Math.min(BINS - 1, Math.floor(ang / Math.PI * BINS));
      const cx = Math.min(CX - 1, Math.floor(x / w * CX)), cy = Math.min(CY - 1, Math.floor(y / h * CY));
      hist[(cy * CX + cx) * BINS + bin] += mag;
    }
    for (let c = 0; c < CX * CY; c++) {
      let s = 0;
      for (let b = 0; b < BINS; b++) s += hist[c * BINS + b] ** 2;
      s = Math.sqrt(s) || 1;
      for (let b = 0; b < BINS; b++) hist[c * BINS + b] /= s;
    }
    let s = 0;
    for (const v of hist) s += v * v;
    s = Math.sqrt(s) || 1;
    return hist.map((v) => v / s);
  }

  const q = (v, scale) => Math.max(-127, Math.min(127, Math.round(v * scale)));

  // px: RGB or RGBA pixels of a 126×176 card image.
  function compute(px, channels) {
    const out = new Int8Array(LEN);
    const card = grid(px, channels, 0, 0, W, H, 6, 8);
    const art = grid(px, channels, ART.x0, ART.y0, ART.x1, ART.y1, 8, 6);
    const e = edges(px, channels);
    for (let i = 0; i < 144; i++) out[i] = q(card[i], LAYOUT_SCALE);
    for (let i = 0; i < 144; i++) out[144 + i] = q(art[i], LAYOUT_SCALE);
    for (let i = 0; i < 48; i++) out[288 + i] = q(e[i], EDGE_SCALE);
    return out;
  }

  // 0…1 similarity between two descriptors (Int8Array-like, may be views into a big buffer).
  function similarity(a, ao, b, bo) {
    let card = 0, art = 0, edge = 0;
    for (let i = 0; i < 144; i++) card += a[ao + i] * b[bo + i];
    for (let i = 144; i < 288; i++) art += a[ao + i] * b[bo + i];
    for (let i = 288; i < 336; i++) edge += a[ao + i] * b[bo + i];
    card /= 144 * LAYOUT_SCALE * LAYOUT_SCALE;
    art /= 144 * LAYOUT_SCALE * LAYOUT_SCALE;
    edge /= EDGE_SCALE * EDGE_SCALE;
    return 0.4 * (art + 1) / 2 + 0.3 * (card + 1) / 2 + 0.3 * Math.max(0, edge);
  }
  // Cheap first-pass score on the whole-card layout only.
  function quick(a, ao, b, bo) {
    let s = 0;
    for (let i = 0; i < 144; i++) s += a[ao + i] * b[bo + i];
    return s;
  }

  const toBase64 = (d) => (typeof Buffer !== 'undefined' ? Buffer.from(d.buffer, d.byteOffset, d.byteLength).toString('base64') : btoa(String.fromCharCode(...new Uint8Array(d.buffer, d.byteOffset, d.byteLength))));
  function fromBase64(s) {
    if (typeof Buffer !== 'undefined') { const b = Buffer.from(s, 'base64'); return new Int8Array(b.buffer, b.byteOffset, b.length); }
    const bin = atob(s); const out = new Int8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24) >> 24;
    return out;
  }

  return { W, H, LEN, compute, similarity, quick, toBase64, fromBase64 };
}));
