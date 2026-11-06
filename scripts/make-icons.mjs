// Generates Notefira's PNG app icons (PWA + desktop source icon) without any
// image libraries: a tiny supersampled rasteriser + PNG encoder using zlib.
// Usage: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function crc32(buf) {
  let c,
    crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i],
      [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Design in a 64-unit box: rounded square with teal gradient, white "N", small curl.
const N = [
  [20, 46],
  [20, 18],
  [24, 18],
  [40, 38],
  [40, 18],
  [44, 18],
  [44, 46],
  [40, 46],
  [24, 26],
  [24, 46],
];
function sample(u, v, pad) {
  // u,v in 0..64 design units, pad = maskable safe-zone padding
  const s = 64 / (64 - pad * 2);
  const x = (u - pad) * s,
    y = (v - pad) * s;
  const r = 15;
  const inside = x >= 0 && y >= 0 && x <= 64 && y <= 64 && (() => {
    const cx = Math.min(Math.max(x, r), 64 - r),
      cy = Math.min(Math.max(y, r), 64 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  })();
  if (pad > 0 && !inside) {
    // maskable: full-bleed background
    return [42, 159, 192, 255];
  }
  if (!inside) return [0, 0, 0, 0];
  if (inPoly(x, y, N)) return [255, 255, 255, 255];
  // curl stroke: arc near bottom right
  const d = Math.hypot(x - 44, y - 38);
  if (Math.abs(d - 8) < 1.5 && x > 44 && y > 38) return [255, 255, 255, 255];
  const t = (x + y) / 128;
  return [Math.round(95 + (42 - 95) * t), Math.round(208 + (159 - 208) * t), Math.round(232 + (192 - 232) * t), 255];
}

function render(size, pad = 0) {
  const out = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = sample(((px + (sx + 0.5) / ss) / size) * 64, ((py + (sy + 0.5) / ss) / size) * 64, pad);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      const i = (py * size + px) * 4;
      out[i] = a ? Math.round(r / a) : 0;
      out[i + 1] = a ? Math.round(g / a) : 0;
      out[i + 2] = a ? Math.round(b / a) : 0;
      out[i + 3] = Math.round(a / (ss * ss));
    }
  return png(size, size, out);
}

const write = (p, data) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  console.log("wrote", p);
};
write(join(root, "public/icons/icon-192.png"), render(192));
write(join(root, "public/icons/icon-512.png"), render(512));
write(join(root, "public/icons/maskable-512.png"), render(512, 6));
write(join(root, "src-tauri/app-icon.png"), render(1024));
