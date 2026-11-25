/*
 * Generate TabYT's PNG icons without any dependencies.
 *
 * Design: a rounded red square with a white play mark. Every size is
 * rasterised from the same geometry with 4x4 supersampling so the small
 * toolbar sizes stay smooth.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src", "icons");
const SIZES = [16, 32, 48, 128];
const SAMPLES = 4;

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}
const CRC = crcTable();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/* Signed distance to a rounded rectangle centred at (0.5, 0.5). */
function roundedRectDistance(x, y, halfW, halfH, radius) {
  const qx = Math.abs(x) - halfW + radius;
  const qy = Math.abs(y) - halfH + radius;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
}

/* Signed distance to the triangular play mark. */
function triangleDistance(px, py) {
  const ax = 0.38;
  const ay = 0.275;
  const bx = 0.775;
  const by = 0.5;
  const cx = 0.38;
  const cy = 0.725;

  const e0 = edgeDistance(px, py, ax, ay, bx, by);
  const e1 = edgeDistance(px, py, bx, by, cx, cy);
  const e2 = edgeDistance(px, py, cx, cy, ax, ay);
  return Math.max(e0, e1, e2);
}

function edgeDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy) || 1;
  // Signed distance with the triangle wound clockwise: inside is negative.
  return ((px - ax) * dy - (py - ay) * dx) / length;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SAMPLES);
  const inv = 1 / (SAMPLES * SAMPLES);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = (x + (sx + 0.5) / SAMPLES) / size;
          const py = (y + (sy + 0.5) / SAMPLES) / size;

          const outer = roundedRectDistance(px - 0.5, py - 0.5, 0.47, 0.47, 0.215);
          const shapeAlpha = 1 - smoothstep(-step * 1.5, step * 1.5, outer);
          if (shapeAlpha <= 0) continue;

          // Diagonal red gradient with a soft glow in the upper left.
          const t = Math.max(0, Math.min(1, (px * 0.65 + py * 0.75)));
          let cr = 255 - t * 27;
          let cg = 45 - t * 30;
          let cb = 75 - t * 36;

          const glow = Math.max(0, 1 - Math.hypot(px - 0.24, py - 0.16) / 0.62);
          cr = Math.min(255, cr + glow * 22);
          cg = Math.min(255, cg + glow * 14);
          cb = Math.min(255, cb + glow * 12);

          const inner = roundedRectDistance(px - 0.5, py - 0.5, 0.43, 0.43, 0.19);
          const edgeShade = smoothstep(-0.012, 0.006, inner) * 0.16;
          cr *= 1 - edgeShade;
          cg *= 1 - edgeShade;
          cb *= 1 - edgeShade;

          const tri = triangleDistance(px, py);
          const playAlpha = 1 - smoothstep(-step * 1.2, step * 1.2, tri);
          if (playAlpha > 0) {
            const shade = 0.94 + 0.06 * (1 - Math.min(1, Math.max(0, (py - 0.275) / 0.45)));
            cr = cr * (1 - playAlpha) + 255 * shade * playAlpha;
            cg = cg * (1 - playAlpha) + 255 * shade * playAlpha;
            cb = cb * (1 - playAlpha) + 255 * shade * playAlpha;
          }

          r += cr * shapeAlpha;
          g += cg * shapeAlpha;
          b += cb * shapeAlpha;
          a += shapeAlpha;
        }
      }

      const index = (y * size + x) * 4;
      const alpha = a * inv;
      if (alpha <= 0.001) {
        pixels[index] = 0;
        pixels[index + 1] = 0;
        pixels[index + 2] = 0;
        pixels[index + 3] = 0;
      } else {
        pixels[index] = Math.round(r * inv);
        pixels[index + 1] = Math.round(g * inv);
        pixels[index + 2] = Math.round(b * inv);
        pixels[index + 3] = Math.round(Math.min(1, alpha) * 255);
      }
    }
  }
  return pixels;
}

mkdirSync(outDir, { recursive: true });

for (const size of SIZES) {
  const file = join(outDir, `icon${size}.png`);
  writeFileSync(file, encodePng(size, size, render(size)));
  console.log(`wrote ${file}`);
}
