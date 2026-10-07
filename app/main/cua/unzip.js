"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../../renderer/i18n");
// Minimal ZIP reader for the pinned driver archive (Windows). No dependency, no shell: every entry is checked
// for path traversal ("zip slip"), size and CRC before it is written. Stored and deflated entries only; zip64,
// encrypted and multi-disk archives are refused. Unit-tested in app/test/cua-installer.test.js.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;
const MAX_TOTAL = 1024 * 1024 * 1024; // 1 GiB unpacked, far above any driver build

let table = null;
function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Central directory entries of a zip held in memory. */
function entries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(i18nText("U0202"));
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) throw new Error(i18nText("U0203"));
  const count = buf.readUInt16LE(eocd + 10);
  const size = buf.readUInt32LE(eocd + 12);
  const off = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || off === 0xffffffff || size === 0xffffffff) throw new Error(i18nText("A0133"));
  if (off + size > eocd) throw new Error(i18nText("U0204"));
  const list = [];
  let p = off;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) throw new Error(i18nText("U0205"));
    const flags = buf.readUInt16LE(p + 8);
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
    list.push({
      name,
      flags,
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      csize: buf.readUInt32LE(p + 20),
      usize: buf.readUInt32LE(p + 24),
      loc: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return list;
}

/** An entry name as a safe relative path ("a/b.exe"), "" for the root, or throws. */
function safeRel(name) {
  const n = String(name).replace(/\\/g, "/");
  if (n.startsWith("/") || /^[A-Za-z]:/.test(n)) throw new Error(i18nText("A0134", { name: name }));
  const parts = n.split("/").filter((x) => x !== "" && x !== ".");
  if (parts.some((x) => x === "..")) throw new Error(i18nText("U0206", { name: name }));
  if (parts.some((x) => /[<>:"|?*\u0000-\u001f]/.test(x) || /[. ]$/.test(x))) throw new Error(i18nText("U0207", { name: name }));
  return parts.join("/");
}

const inside = (root, p) => {
  const r = path.relative(root, p);
  return !!r && !r.startsWith("..") && !path.isAbsolute(r);
};

/**
 * Unpacks a zip (Buffer) into `dest`, which must not exist yet or be empty. Returns the written files
 * (relative, "/"-separated).
 */
function extractZip(buf, dest) {
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true });
  const written = [];
  let total = 0;
  for (const e of entries(buf)) {
    const rel = safeRel(e.name);
    if (!rel) continue;
    const out = path.join(root, ...rel.split("/"));
    if (!inside(root, out)) throw new Error(i18nText("U0208", { name: e.name }));
    if (/[\\/]$/.test(e.name)) {
      fs.mkdirSync(out, { recursive: true });
      continue;
    }
    if (e.flags & 1) throw new Error(i18nText("U0209"));
    if (e.loc + 30 > buf.length || buf.readUInt32LE(e.loc) !== LOC) throw new Error(i18nText("U0210", { name: e.name }));
    const start = e.loc + 30 + buf.readUInt16LE(e.loc + 26) + buf.readUInt16LE(e.loc + 28);
    const raw = buf.subarray(start, start + e.csize);
    if (raw.length !== e.csize) throw new Error(i18nText("U0211", { name: e.name }));
    total += e.usize;
    if (total > MAX_TOTAL) throw new Error(i18nText("U0212"));
    let data;
    if (e.method === 0) data = raw;
    else if (e.method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, e.usize) });
    else throw new Error(i18nText("U0213", { method: e.method, name: e.name }));
    if (data.length !== e.usize) throw new Error(i18nText("A0135", { name: e.name }));
    if (crc32(data) !== e.crc) throw new Error(i18nText("A0136", { name: e.name }));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data, { mode: 0o755, flag: "wx" }); // "wx": a duplicate entry never overwrites
    written.push(rel);
  }
  return written;
}

module.exports = { extractZip, entries, safeRel, crc32 };
