"use strict";
// Per-device tokens for the bot-screen driver channel. A deck may host computer_use only after it presents
// one in its driver hello; revoking a token cuts that device's driver channels without touching its relay
// connection. Only SHA-256 hashes are stored (the tokens are 256 random bits, so a plain hash is enough), in a
// 0600 JSON file next to the relay's .env (gitignored):
//   {"v":1,"devices":{"<name>":{"hash":"<hex>","created":<unix s>}}}
// <name> is a label for people (e.g. "office-pc"); the device id the deck reports is separate.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

const hash = (token) => crypto.createHash("sha256").update(String(token), "utf8").digest("hex");

function load(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    if (d && typeof d === "object" && d.devices && typeof d.devices === "object") return d;
  } catch {
    /* missing or unreadable: no tokens */
  }
  return { v: 1, devices: {} };
}

function save(file, data) {
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    file = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(path.dirname(file), fs.readlinkSync(file));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows: modes are advisory */
  }
}

/** Issue a token for <name>; returns it (shown once, never stored). Throws on a bad or taken name. */
function add(file, name) {
  if (!NAME_RE.test(String(name || ""))) throw new Error("device name: 1-32 letters, digits, '.', '_' or '-'");
  const data = load(file);
  if (data.devices[name]) throw new Error(`${name} already has a token; revoke it first`);
  const token = crypto.randomBytes(32).toString("hex");
  data.devices[name] = { hash: hash(token), created: Math.round(Date.now() / 1000) };
  save(file, data);
  return token;
}

/** Remove <name>'s token; false when there was none. */
function revoke(file, name) {
  const data = load(file);
  if (!data.devices[name]) return false;
  delete data.devices[name];
  save(file, data);
  return true;
}

/** [{name, created}] sorted by name. */
function list(file) {
  return Object.entries(load(file).devices)
    .map(([name, d]) => ({ name, created: Number(d && d.created) || null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The name whose token this is, or null. Compares hashes in constant time. */
function match(file, token) {
  if (typeof token !== "string" || token.length < 32 || token.length > 256) return null;
  const want = Buffer.from(hash(token), "hex");
  let found = null;
  for (const [name, d] of Object.entries(load(file).devices)) {
    if (!d || typeof d.hash !== "string" || d.hash.length !== want.length * 2) continue;
    if (crypto.timingSafeEqual(Buffer.from(d.hash, "hex"), want)) found = name;
  }
  return found;
}

/** Whether <name> still holds the token with this hash (revocation check for live connections). */
function stillValid(file, name, tokenHash) {
  const d = load(file).devices[name];
  return !!d && d.hash === tokenHash;
}

module.exports = { NAME_RE, hash, load, add, revoke, list, match, stillValid };
