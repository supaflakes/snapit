// Génère les icônes PNG de l'application (aucune dépendance externe).
// Usage : npm run icons
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bits par canal
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Coordonnées normalisées 0..1
function inRoundedSquare(u, v) {
  const m = 0.04, r = 0.24;
  if (u < m || v < m || u > 1 - m || v > 1 - m) return false;
  const cx = Math.min(Math.max(u, m + r), 1 - m - r);
  const cy = Math.min(Math.max(v, m + r), 1 - m - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
}

function inViewfinder(u, v) {
  const i = 0.22, a = 0.2, t = 0.085;
  // Ramène tout dans le coin supérieur gauche par symétrie
  const x = u > 0.5 ? 1 - u : u;
  const y = v > 0.5 ? 1 - v : v;
  const bracket = (x >= i && x <= i + a && y >= i && y <= i + t) || (x >= i && x <= i + t && y >= i && y <= i + a);
  const dot = (u - 0.5) ** 2 + (v - 0.5) ** 2 <= 0.085 ** 2;
  return bracket || dot;
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const ss = 4;
  const top = [0x8f, 0x72, 0xff];
  const bottom = [0x5a, 0x3d, 0xe6];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (px + (sx + 0.5) / ss) / size;
          const v = (py + (sy + 0.5) / ss) / size;
          if (inRoundedSquare(u, v)) {
            bg++;
            if (inViewfinder(u, v)) fg++;
          }
        }
      }
      const n = ss * ss;
      const t = py / size;
      const base = top.map((c, k) => c + (bottom[k] - c) * t);
      const f = bg ? fg / bg : 0;
      const o = (py * size + px) * 4;
      for (let k = 0; k < 3; k++) buf[o + k] = Math.round(base[k] * (1 - f) + 255 * f);
      buf[o + 3] = Math.round((bg / n) * 255);
    }
  }
  return encodePNG(size, size, buf);
}

fs.mkdirSync(OUT, { recursive: true });
const files = {
  'tray.png': 16,
  'tray@1.5x.png': 24,
  'tray@2x.png': 32,
  'icon.png': 512,
};
for (const [name, size] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), render(size));
  console.log(`assets/${name} (${size}×${size})`);
}
// copie pour les pages (éditeur, paramètres) : la version Tauri ne sert que le dossier src/
fs.copyFileSync(path.join(OUT, 'icon.png'), path.join(__dirname, '..', 'src', 'icon.png'));
console.log('src/icon.png');
