#!/usr/bin/env node
'use strict';
// Writes placeholder icons (forest-green rounded square with a white "J") as PNGs,
// using only Node built-ins. Run: npm run icons
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets');
const GREEN = [0x1a, 0x4d, 0x3a];

// ---- PNG encoding
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- shapes in unit coordinates (0..1)
function inRoundedSquare(x, y, margin, radius) {
  const lo = margin, hi = 1 - margin;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = Math.min(Math.max(x, lo + radius), hi - radius);
  const cy = Math.min(Math.max(y, lo + radius), hi - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}
// A "J": top bar, stem, and a half-ring hook at the bottom.
function inJ(x, y) {
  if (y >= 0.24 && y <= 0.34 && x >= 0.36 && x <= 0.72) return true; // top bar
  if (x >= 0.53 && x <= 0.65 && y >= 0.24 && y <= 0.60) return true; // stem
  const cx = 0.43, cy = 0.60, d = Math.hypot(x - cx, y - cy);
  if (y >= cy && d >= 0.10 && d <= 0.22) return true;                 // hook
  if (x >= 0.21 && x <= 0.33 && y >= 0.55 && y <= cy) return true;   // hook tip
  return false;
}

/** Render with supersampling. fill(x, y) -> [r, g, b, a] or null. */
function render(size, fill, ss) {
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = fill((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
          if (c) { r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3]; }
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) { buf[i] = Math.round(r / a); buf[i + 1] = Math.round(g / a); buf[i + 2] = Math.round(b / a); }
      buf[i + 3] = Math.round(a / (ss * ss));
    }
  }
  return buf;
}

// App icon: green rounded square, white J.
const appIcon = (margin) => (x, y) => {
  if (!inRoundedSquare(x, y, margin, 0.2)) return null;
  const s = 1 - 2 * margin;
  return inJ((x - margin) / s, (y - margin) / s) ? [255, 255, 255, 255] : [...GREEN, 255];
};
// macOS template tray image: black rounded square with the J knocked out (only alpha matters).
const trayTemplate = (x, y) => {
  if (!inRoundedSquare(x, y, 0.06, 0.22)) return null;
  const s = 1 - 2 * 0.06;
  return inJ((x - 0.06) / s, (y - 0.06) / s) ? null : [0, 0, 0, 255];
};
// Windows tray: full-colour icon with almost no margin so it reads at 16 px.
const trayColour = appIcon(0.03);

const files = [
  ['icon.png', 1024, appIcon(0.09)],
  ['trayTemplate.png', 16, trayTemplate],
  ['trayTemplate@2x.png', 32, trayTemplate],
  ['tray.png', 32, trayColour],
  ['tray@2x.png', 64, trayColour],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size, fill] of files) {
  fs.writeFileSync(path.join(OUT, name), encodePng(size, render(size, fill, size >= 512 ? 2 : 6)));
  console.log(`wrote assets/${name} (${size}x${size})`);
}
