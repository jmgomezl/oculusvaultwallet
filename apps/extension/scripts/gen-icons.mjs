// Generates the extension icons (paper ground, banknote-green rosette rings)
// as PNGs with zero dependencies: raw RGBA → zlib deflate → hand-rolled PNG.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(OUT, { recursive: true });

const PAPER = [245, 241, 230];
const GREEN = [29, 92, 69];

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  // pixels: RGBA rows with a leading 0 filter byte per row
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  // ring geometry as fractions of the radius
  const R = size / 2;
  const bands = [
    [0.86, 0.94],  // outer ring
    [0.58, 0.66],  // middle ring
    [0.0, 0.17],   // pupil (filled)
  ];
  const petalsBand = [0.3, 0.5]; // soft engraved field between pupil and mid ring
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / R;
      let col = PAPER, a = 255;
      if (d > 1) a = 0; // transparent outside the disc
      else {
        for (const [lo, hi] of bands) if (d >= lo && d <= hi) col = GREEN;
        if (d >= petalsBand[0] && d <= petalsBand[1]) {
          // fine radial "engraving": alternate ink by angle
          const ang = Math.atan2(y - c, x - c);
          const spokes = size >= 48 ? 24 : 12;
          if (Math.floor(((ang + Math.PI) / (2 * Math.PI)) * spokes * 2) % 2 === 0) {
            col = GREEN;
          }
        }
      }
      const i = (y * size + x) * 4;
      px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = a;
    }
  }
  return px;
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `icon${size}.png`), png(size, draw(size)));
  console.log(`icon${size}.png`);
}
