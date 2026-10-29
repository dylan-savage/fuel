// Writes the PWA and apple-touch icons into public/icons. Run with `npm run icons`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const OUT = join(import.meta.dirname, '..', 'public', 'icons');
const BG = [0x0f, 0x17, 0x2a];
const RING = [0xa3, 0xe6, 0x35];
const TRACK = [0x33, 0x41, 0x55];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y);
      raw.set([r, g, b], row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A gauge: a 270-degree track open at the bottom, three quarters filled. Fits the maskable safe zone. */
function gauge(size) {
  const samples = 4;
  const colorAt = (x, y) => {
    const dx = x / size - 0.5;
    const dy = y / size - 0.5;
    const r = Math.hypot(dx, dy);
    if (r < 0.25 || r > 0.36) return BG;
    const clockwiseFromBottom = (Math.atan2(-dx, dy) + 2 * Math.PI) % (2 * Math.PI);
    const sweep = (clockwiseFromBottom - Math.PI / 4) / (1.5 * Math.PI);
    if (sweep < 0 || sweep > 1) return BG;
    return sweep <= 0.75 ? RING : TRACK;
  };
  return (x, y) => {
    const sum = [0, 0, 0];
    for (let i = 0; i < samples; i++) {
      for (let j = 0; j < samples; j++) {
        const c = colorAt(x + (i + 0.5) / samples, y + (j + 0.5) / samples);
        for (let k = 0; k < 3; k++) sum[k] += c[k];
      }
    }
    return sum.map((v) => Math.round(v / samples ** 2));
  };
}

mkdirSync(OUT, { recursive: true });
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  writeFileSync(join(OUT, name), png(size, gauge(size)));
}
