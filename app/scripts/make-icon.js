"use strict";
// Draws the Hermes Deck icon (the agent coin: slate face, inscribed "H", patina context rim) in pure
// Node, no browser or fonts, and writes build/icon.png (512) and build/icon.ico (16–256).
//   node scripts/make-icon.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "build");
const C = {
  face: [0x26, 0x2a, 0x2f],
  hair: [0x3a, 0x3f, 0x45],
  track: [0x3a, 0x3f, 0x45],
  patina: [0x6f, 0xb3, 0xa6],
  marble: [0xe8, 0xe4, 0xdc],
};
const FILL = 0.72; // how much of the rim is lit (a context gauge at 72%)

/** Colour of one sample point in unit space (-1..1), or null when outside the icon. */
function sample(x, y) {
  const r = Math.hypot(x, y);
  // rim: track + lit arc, starting at 12 o'clock and running clockwise, with round ends
  if (r >= 0.86 && r <= 0.97) {
    const a = (Math.atan2(x, -y) + 2 * Math.PI) % (2 * Math.PI); // 0 at top, clockwise
    if (a <= FILL * 2 * Math.PI) return C.patina;
    return C.track;
  }
  const mid = 0.915;
  const capR = 0.055;
  for (const ang of [0, FILL * 2 * Math.PI]) {
    const cx = Math.sin(ang) * mid;
    const cy = -Math.cos(ang) * mid;
    if (Math.hypot(x - cx, y - cy) <= capR) return C.patina;
  }
  if (r > 0.78) return null;
  if (r > 0.765) return C.hair;
  // inscribed H with small flared serifs
  const ax = Math.abs(x);
  const stem = ax >= 0.2 && ax <= 0.33 && y >= -0.37 && y <= 0.37;
  const bar = ax <= 0.27 && y >= -0.05 && y <= 0.06;
  const serif = ax >= 0.14 && ax <= 0.39 && ((y >= -0.42 && y <= -0.37) || (y >= 0.37 && y <= 0.42));
  if (stem || bar || serif) return C.marble;
  return C.face;
}

function render(size, ss = 6, background = null) {
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sj = 0; sj < ss; sj++) {
        for (let si = 0; si < ss; si++) {
          const x = ((i + (si + 0.5) / ss) / size) * 2 - 1;
          const y = ((j + (sj + 0.5) / ss) / size) * 2 - 1;
          const c = sample(x, y) || background;
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const o = (j * size + i) * 4;
      if (a) {
        px[o] = Math.round(r / a);
        px[o + 1] = Math.round(g / a);
        px[o + 2] = Math.round(b / a);
        px[o + 3] = Math.round((255 * a) / (ss * ss));
      }
    }
  }
  return png(size, px, background !== null);
}

// --- minimal PNG encoder (RGBA, no filter) ---------------------------------------------------
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba, opaque = false) {
  const channels = opaque ? 3 : 4;
  const raw = Buffer.alloc(size * (size * channels + 1));
  for (let y = 0; y < size; y++) {
    if (!opaque) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
    else for (let x = 0; x < size; x++) rgba.copy(raw, y * (size * 3 + 1) + 1 + x * 3, (y * size + x) * 4, (y * size + x) * 4 + 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = opaque ? 2 : 6; // RGB or RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- ICO container with PNG entries (Windows Vista+) -------------------------------------------
function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const dir = [];
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    dir.push(e);
  }
  return Buffer.concat([head, ...dir, ...images.map((i) => i.data)]);
}

module.exports = { render };
if (require.main === module) {
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "icon.png"), render(512, 4));
const sizes = [16, 24, 32, 48, 64, 128, 256];
fs.writeFileSync(path.join(OUT, "icon.ico"), ico(sizes.map((s) => ({ size: s, data: render(s, s <= 32 ? 8 : 6) }))));
console.log(`icon: ${path.join(OUT, "icon.png")} + icon.ico (${sizes.join(", ")})`);

}
