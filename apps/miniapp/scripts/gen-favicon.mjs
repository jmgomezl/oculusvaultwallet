// Generates the Mini App favicon from the OculusVault mark — the guilloché
// rosette (paper ground, banknote-green rings + engraved spokes + pupil).
// Emits a scalable favicon.svg plus PNG fallbacks, zero dependencies:
// raw RGBA → zlib deflate → hand-rolled PNG (same technique as the extension's
// gen-icons.mjs). Run: node scripts/gen-favicon.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
mkdirSync(OUT, { recursive: true });

const PAPER = [245, 241, 230]; // --paper  #f5f1e6
const GREEN = [29, 92, 69]; //   --green  #1d5c45

// ── PNG plumbing ────────────────────────────────────────────────────────
function crc32(buf) {
  let c,
    table = [];
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
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// A filled rounded-square paper tile with the green rosette centered on it,
// so the mark reads as an app icon in a browser tab / home screen.
function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const R = size / 2;
  const radius = size * 0.22; // rounded-corner radius of the paper tile
  const bands = [
    [0.82, 0.9], // outer ring
    [0.54, 0.62], // middle ring
    [0.0, 0.16], // pupil (filled)
  ];
  const petalsBand = [0.28, 0.47]; // engraved field between pupil and mid ring
  const inCorner = (x, y) => {
    // true when (x,y) sits in a clipped rounded corner (transparent)
    const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
    const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
    return Math.hypot(dx, dy) > radius;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (inCorner(x, y)) {
        px[i + 3] = 0;
        continue;
      }
      const d = Math.hypot(x - c, y - c) / R;
      let col = PAPER;
      if (d <= 1) for (const [lo, hi] of bands) if (d >= lo && d <= hi) col = GREEN;
      if (d >= petalsBand[0] && d <= petalsBand[1]) {
        const ang = Math.atan2(y - c, x - c);
        const spokes = size >= 48 ? 24 : 12;
        if (Math.floor(((ang + Math.PI) / (2 * Math.PI)) * spokes * 2) % 2 === 0) col = GREEN;
      }
      px[i] = col[0];
      px[i + 1] = col[1];
      px[i + 2] = col[2];
      px[i + 3] = 255;
    }
  }
  return px;
}

// ── scalable SVG (primary, modern browsers) ─────────────────────────────
function svg() {
  const S = 64;
  const c = S / 2;
  const spokes = 18;
  const rIn = 10.5,
    rOut = 15.5; // engraved-field radii
  const lines = [];
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    const x1 = (c + Math.cos(a) * rIn).toFixed(2);
    const y1 = (c + Math.sin(a) * rIn).toFixed(2);
    const x2 = (c + Math.cos(a) * rOut).toFixed(2);
    const y2 = (c + Math.sin(a) * rOut).toFixed(2);
    lines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
  }
  const paper = `rgb(${PAPER.join(",")})`;
  const green = `rgb(${GREEN.join(",")})`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" rx="14" fill="${paper}"/>
  <g fill="none" stroke="${green}" stroke-width="2.4">
    <circle cx="${c}" cy="${c}" r="27"/>
    <circle cx="${c}" cy="${c}" r="18.5"/>
  </g>
  <g stroke="${green}" stroke-width="1.6">
    ${lines.join("\n    ")}
  </g>
  <circle cx="${c}" cy="${c}" r="5.4" fill="${green}"/>
</svg>
`;
}

writeFileSync(join(OUT, "favicon.svg"), svg());
console.log("favicon.svg");
for (const [name, size] of [
  ["favicon-32.png", 32],
  ["apple-touch-icon.png", 180],
]) {
  writeFileSync(join(OUT, name), png(size, draw(size)));
  console.log(name);
}
