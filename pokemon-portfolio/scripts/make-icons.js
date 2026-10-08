'use strict';
// Builds the home-screen / app icons in public/icons from one SVG. Run: node scripts/make-icons.js
const path = require('path');
const sharp = require('sharp');

const OUT = path.join(__dirname, '..', 'public', 'icons');
// `scale` shrinks the mark for maskable icons, whose outer ~10% may be cropped into a circle.
const svg = (scale = 1) => {
  const r = 300 * scale, w = 64 * scale, inner = 104 * scale;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${512 - r}" y1="${512 - r}" x2="${512 + r}" y2="${512 + r}"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#a78bfa"/></linearGradient>
    <radialGradient id="c" cx=".38" cy=".34" r=".7"><stop offset="0" stop-color="#22d3ee" stop-opacity=".28"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/></radialGradient>
    <radialGradient id="v" cx=".68" cy=".7" r=".6"><stop offset="0" stop-color="#a78bfa" stop-opacity=".26"/><stop offset="1" stop-color="#a78bfa" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1024" height="1024" fill="#05060b"/>
  <rect width="1024" height="1024" fill="url(#c)"/>
  <rect width="1024" height="1024" fill="url(#v)"/>
  <circle cx="512" cy="512" r="${r}" fill="none" stroke="url(#g)" stroke-width="${w}"/>
  <path d="M${512 - r} 512H${512 + r}" stroke="url(#g)" stroke-width="${w}"/>
  <circle cx="512" cy="512" r="${inner}" fill="#05060b" stroke="url(#g)" stroke-width="${w}"/>
</svg>`);
};

(async () => {
  const jobs = [
    ['apple-touch-icon.png', 180, 1],
    ['icon-192.png', 192, 1],
    ['icon-512.png', 512, 1],
    ['maskable-512.png', 512, 0.78],
  ];
  for (const [name, size, scale] of jobs) {
    await sharp(svg(scale)).resize(size, size).png().toFile(path.join(OUT, name));
    console.log('wrote', name);
  }
})();
