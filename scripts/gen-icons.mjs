/**
 * Generates the PWA icon set as real PNGs with no image dependencies.
 *
 * Mark: a rounded square in the app's teal->indigo gradient, three stacked
 * "wetland" sine bands in lighter tints, and a pale sun disc: the greenness
 * curve over water, which is what the app plots.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../public/icons');
mkdirSync(outDir, { recursive: true });

const SS = 4; // supersampling factor for anti-aliasing

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const TEAL = [15, 118, 110];
const INDIGO = [49, 46, 129];
const MINT = [153, 246, 228];
const SUN = [254, 249, 195];

/** Signed "inside" test for a rounded square in unit coords. */
function insideRoundedSquare(x, y, half, radius) {
  const dx = Math.max(Math.abs(x) - (half - radius), 0);
  const dy = Math.max(Math.abs(y) - (half - radius), 0);
  return Math.hypot(dx, dy) <= radius && Math.abs(x) <= half && Math.abs(y) <= half;
}

/** Colour of one sample in unit coords (-0.5..0.5), or null for transparent. */
function sample(x, y, { half, radius }) {
  if (!insideRoundedSquare(x, y, half, radius)) return null;

  // Diagonal gradient background.
  const t = clamp01((x + y) / (2 * half) + 0.5);
  let rgb = mix(TEAL, INDIGO, t);

  // Sun disc, upper right.
  const sunD = Math.hypot(x - 0.17, y + 0.2);
  if (sunD < 0.075) rgb = mix(rgb, SUN, 0.92);
  else if (sunD < 0.088) rgb = mix(rgb, SUN, 0.92 * (1 - (sunD - 0.075) / 0.013));

  // Three phenology bands: an asymmetric green-up / green-down curve.
  const bands = [
    { y0: 0.06, amp: 0.085, alpha: 0.95, phase: 0.0 },
    { y0: 0.185, amp: 0.065, alpha: 0.62, phase: 0.12 },
    { y0: 0.3, amp: 0.05, alpha: 0.34, phase: 0.24 },
  ];
  for (const b of bands) {
    const u = (x + 0.5 + b.phase) % 1;
    const curve = Math.exp(-Math.pow((u - 0.45) / 0.22, 2)); // seasonal hump
    const yb = b.y0 - b.amp * curve;
    const d = y - yb;
    const thickness = 0.038;
    if (d > 0 && d < thickness) rgb = mix(rgb, MINT, b.alpha);
    else if (d >= thickness && d < thickness + 0.012)
      rgb = mix(rgb, MINT, b.alpha * (1 - (d - thickness) / 0.012));
  }

  return rgb;
}

function renderRGBA(size, { padding = 0 } = {}) {
  const half = 0.5 - padding;
  const radius = half * 0.44;
  const px = new Uint8Array(size * size * 4);
  const inv = 1 / (size * SS);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const x = (i * SS + si + 0.5) * inv - 0.5;
          const y = (j * SS + sj + 0.5) * inv - 0.5;
          const c = sample(x, y, { half, radius });
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 255;
          }
        }
      }
      const n = SS * SS;
      const o = (j * size + i) * 4;
      if (a > 0) {
        const cov = a / (255 * n);
        px[o] = Math.round(r / (cov * n));
        px[o + 1] = Math.round(g / (cov * n));
        px[o + 2] = Math.round(b / (cov * n));
        px[o + 3] = Math.round(a / n);
      }
    }
  }
  return px;
}

function crc32(buf) {
  let c,
    table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const targets = [
  ['icon-192.png', 192, 0.0],
  ['icon-512.png', 512, 0.0],
  // Maskable icons must survive a circular crop: shrink into the 80% safe zone.
  ['icon-maskable-512.png', 512, 0.12],
  ['apple-touch-icon.png', 180, 0.0],
  ['favicon-32.png', 32, 0.0],
];

for (const [name, size, padding] of targets) {
  writeFileSync(resolve(outDir, name), encodePNG(size, renderRGBA(size, { padding })));
  console.log(`icons: wrote ${name} (${size}x${size})`);
}
