// Generates the app icons in public/icons (run with `npm run icons`).
// Draws a stylised "A" (apex chevron + racing-line crossbar) with anti-aliased signed-distance
// shapes and encodes PNGs with Node's zlib, so no image tools or design files are needed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../public/icons/', import.meta.url);

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
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Distance from p to segment ab. */
function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function roundedBoxDistance(px, py, half, radius) {
  const qx = Math.abs(px) - half + radius;
  const qy = Math.abs(py) - half + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

const mix = (a, b, t) => a + (b - a) * t;
const coverage = (distance, pixel) => Math.max(0, Math.min(1, 0.5 - distance / pixel));

/**
 * @param size output size in pixels
 * @param content scale of the logo inside the icon (smaller for maskable icons)
 * @param rounded draw a rounded square with transparent corners (false = full bleed)
 */
function drawIcon(size, content, rounded) {
  const rgba = Buffer.alloc(size * size * 4);
  const pixel = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      // Background: dark navy with a soft glow.
      const glow = Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.38) * 1.6);
      let r = mix(11, 38, glow);
      let g = mix(13, 46, glow);
      let b = mix(18, 68, glow);
      let a = 1;
      if (rounded) a = coverage(roundedBoxDistance(u - 0.5, v - 0.5, 0.5, 0.2), pixel);

      // Logo coordinates, centred and scaled.
      const lx = (u - 0.5) / content + 0.5;
      const ly = (v - 0.5) / content + 0.5;
      const lp = pixel / content;
      const stroke = 0.075;
      const chevron = Math.min(
        segmentDistance(lx, ly, 0.24, 0.8, 0.5, 0.2),
        segmentDistance(lx, ly, 0.5, 0.2, 0.76, 0.8),
      );
      const white = coverage(chevron - stroke, lp);
      r = mix(r, 244, white);
      g = mix(g, 246, white);
      b = mix(b, 250, white);
      const bar = segmentDistance(lx, ly, 0.2, 0.6, 0.8, 0.6);
      const red = coverage(bar - 0.042, lp);
      r = mix(r, 255, red);
      g = mix(g, 59, red);
      b = mix(b, 47, red);

      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(OUT, { recursive: true });
const icons = [
  ['icon-192.png', 192, 0.86, true],
  ['icon-512.png', 512, 0.86, true],
  // Maskable: full bleed, logo inside the central safe zone.
  ['icon-maskable-512.png', 512, 0.62, false],
  // iOS adds its own rounded corners and needs an opaque image.
  ['apple-touch-icon.png', 180, 0.8, false],
  ['favicon-32.png', 32, 0.95, true],
];
for (const [name, size, content, rounded] of icons) {
  writeFileSync(new URL(name, OUT), drawIcon(size, content, rounded));
  console.log(`wrote public/icons/${name}`);
}
