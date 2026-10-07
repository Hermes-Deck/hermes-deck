"use strict";
// The tray's alert coin (bot screen): a valid PNG whose rim is amphora red and whose corners stay clear.
const test = require("node:test");
const assert = require("node:assert");
const zlib = require("zlib");
const { alertPng, FACE } = require("../main/badge");

/** Minimal PNG reader for the encoder's own output (RGBA, 8 bit, filter 0). */
function decode(buf) {
  assert.deepStrictEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let p = 8;
  let w = 0;
  let hgt = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      hgt = data.readUInt32BE(4);
      assert.strictEqual(data[8], 8);
      assert.strictEqual(data[9], 6);
    } else if (type === "IDAT") idat.push(data);
    p += 12 + len;
  }
  const rows = zlib.inflateSync(Buffer.concat(idat));
  const px = (x, y) => {
    const o = y * (w * 4 + 1) + 1 + x * 4;
    assert.strictEqual(rows[y * (w * 4 + 1)], 0, "filter 0");
    return [...rows.subarray(o, o + 4)];
  };
  return { w, h: hgt, px };
}

test("badge: the alert coin at tray sizes", () => {
  for (const size of [16, 20, 24, 32]) {
    const img = decode(alertPng(size));
    assert.strictEqual(img.w, size);
    assert.strictEqual(img.h, size);
    assert.strictEqual(img.px(0, 0)[3], 0, "corners are transparent");
  }
  const img = decode(alertPng(32));
  assert.deepStrictEqual(img.px(16, 1), [0xc9, 0x6a, 0x4e, 255], "the rim is amphora");
  assert.deepStrictEqual(img.px(16, 8), [...FACE, 255], "a red-tinted face");
  assert.deepStrictEqual(img.px(16, 16).slice(0, 3), [0xe8, 0xe4, 0xdc], "the H stays marble");
});
