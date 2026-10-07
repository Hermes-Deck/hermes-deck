"use strict";
// The tray's alert icon (bot screen: an agent may act on this computer). The deck's coin drawn in pure
// Node at tray sizes, with the rim fully lit in amphora red and a red-tinted face, encoded as PNG so the
// colours never depend on a platform's bitmap channel order. Pure; unit-tested in app/test/badge.test.js.
const zlib = require("zlib");

const C = {
  face: [0x26, 0x2a, 0x2f],
  hair: [0x3a, 0x3f, 0x45],
  amphora: [0xc9, 0x6a, 0x4e],
  marble: [0xe8, 0xe4, 0xdc],
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const FACE = mix(C.face, C.amphora, 0.42);

/** Colour at a point of the unit square (-1..1), or null outside the coin (same geometry as make-icon.js). */
function sample(x, y) {
  const r = Math.hypot(x, y);
  if (r >= 0.8 && r <= 0.99) return C.amphora; // the rim, thicker than the app icon's so it reads at 16 px
  if (r > 0.8) return null;
  if (r > 0.765) return C.hair;
  const ax = Math.abs(x);
  const stem = ax >= 0.2 && ax <= 0.33 && y >= -0.37 && y <= 0.37;
  const bar = ax <= 0.27 && y >= -0.05 && y <= 0.06;
  const serif = ax >= 0.14 && ax <= 0.39 && ((y >= -0.42 && y <= -0.37) || (y >= 0.37 && y <= 0.42));
  return stem || bar || serif ? C.marble : FACE;
}

/** RGBA pixels of the alert coin, `size` px square, supersampled. */
function alertPixels(size, ss = 5) {
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sj = 0; sj < ss; sj++) {
        for (let si = 0; si < ss; si++) {
          const c = sample(((i + (si + 0.5) / ss) / size) * 2 - 1, ((j + (sj + 0.5) / ss) / size) * 2 - 1);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const o = (j * size + i) * 4;
      if (!a) continue;
      px[o] = Math.round(r / a);
      px[o + 1] = Math.round(g / a);
      px[o + 2] = Math.round(b / a);
      px[o + 3] = Math.round((255 * a) / (ss * ss));
    }
  }
  return px;
}

// --- minimal PNG encoder (RGBA, filter 0) ------------------------------------------------------------
let CRC = null;
function crc(buf) {
  if (!CRC) {
    CRC = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, sum]);
}

function png(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) px.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** PNG of the alert coin at `size` px. */
function alertPng(size) {
  return png(size, alertPixels(size));
}

module.exports = { alertPng, alertPixels, png, FACE };
