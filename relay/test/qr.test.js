"use strict";
// The relay's own QR encoder (src/qr.js) checked with an independent decoder (jsQR, a pinned devDependency): the
// symbol is rasterised to RGBA pixels and must decode to the exact text, for short and long relay addresses and for
// every length band up to the versions a pairing link can need.
const test = require("node:test");
const assert = require("node:assert");
const jsQR = require("jsqr");
const qr = require("../src/qr");

const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
const link = (address, code = "0123456789abcdef0123456789abcdef") => `hermesdeck://pair?u=${b64url(address)}&c=${code}`;

/** Rasterises a symbol (with a 4-module quiet zone) at `scale` px per module into RGBA. */
function pixels(sym, scale = 4, border = 4) {
  const full = (sym.size + border * 2) * scale;
  const data = new Uint8ClampedArray(full * full * 4).fill(255);
  for (let y = 0; y < sym.size; y++) {
    for (let x = 0; x < sym.size; x++) {
      if (!sym.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + border) * scale + dy) * full + (x + border) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: full, height: full };
}
function decode(sym) {
  const img = pixels(sym);
  const got = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
  if (got) assert.strictEqual(got.version, sym.version, "the decoder reads the version we drew");
  return got ? got.data : null;
}

test("qr: a pairing link for a short relay address decodes to the exact link", () => {
  const text = link("https://relay.example");
  const sym = qr.encode(text);
  assert.strictEqual(sym.ecl, "M");
  assert.strictEqual(decode(sym), text);
});

test("qr: a pairing link for a 200-character relay address decodes to the exact link (error correction M)", () => {
  const address = `https://relay.example/${"a".repeat(200 - "https://relay.example/".length)}`;
  assert.strictEqual(address.length, 200);
  const text = link(address);
  const sym = qr.encode(text, { ecl: "M" });
  assert.ok(sym.version >= 10, `version ${sym.version}`);
  assert.strictEqual(decode(sym), text);
});

test("qr: every length band from 1 to 600 bytes decodes (versions 1..~20, all masks exercised)", () => {
  const versions = new Set(), masks = new Set();
  for (let len = 1; len <= 600; len += 7) {
    const text = Array.from({ length: len }, (_, i) => "abcdefghijklmnopqrstuvwxyz0123456789-_/:?&="[(i * 7 + len) % 43]).join("");
    const sym = qr.encode(text);
    versions.add(sym.version);
    masks.add(sym.mask);
    assert.strictEqual(decode(sym), text, `length ${len}, version ${sym.version}`);
  }
  assert.ok(versions.size >= 15, `versions covered: ${[...versions].join(",")}`);
  assert.ok(masks.size >= 4, `masks used: ${[...masks].join(",")}`);
});

test("qr: other error correction levels decode too, and UTF-8 text survives", () => {
  for (const ecl of ["L", "Q", "H"]) {
    const text = link("https://relay.example:8443/deck");
    assert.strictEqual(decode(qr.encode(text, { ecl })), text, ecl);
  }
  assert.strictEqual(decode(qr.encode("Bağlantı: ğüşiöç")), "Bağlantı: ğüşiöç");
});

test("qr: capacity is the standard's (version 1-M holds 14 bytes, 10-M 213, 40-M 2331) and too long throws", () => {
  assert.strictEqual(qr.byteCapacity(1, qr.ECL.M), 14);
  assert.strictEqual(qr.byteCapacity(10, qr.ECL.M), 213);
  assert.strictEqual(qr.byteCapacity(40, qr.ECL.M), 2331);
  assert.strictEqual(qr.encode("x".repeat(14)).version, 1);
  assert.strictEqual(qr.encode("x".repeat(15)).version, 2);
  assert.throws(() => qr.encode("x".repeat(2332)), /too long/);
});

test("qr: the SVG is one path on a light square with a quiet zone and carries none of the text", () => {
  const text = link("https://relay.example");
  const sym = qr.encode(text);
  const svg = qr.toSvg(sym, { label: "Pairing code" });
  const full = sym.size + 8;
  assert.match(svg, new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}"`));
  assert.match(svg, /role="img" aria-label="Pairing code"/);
  assert.strictEqual((svg.match(/<path /g) || []).length, 1);
  assert.ok(!svg.includes("hermesdeck") && !svg.includes("0123456789abcdef"));
  assert.match(qr.toSvg(sym), /aria-hidden="true"/);
  assert.ok(!qr.toSvg(sym, { label: '"><script>' }).includes("<script>"));
});
