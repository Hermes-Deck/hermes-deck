"use strict";
// Chat wallpapers (Settings > Desktop > Appearance): a picture behind the message list, one per chat mode (Telegram,
// Sessions, Bots), so each mode looks like its own place. The user picks an image;
// it is copied into the profile (<userData>/wallpapers/<sha256-16>.<ext>) so the original can move or vanish, and
// the page loads it as deck://app/user-wallpaper/<name> (protocol handler in main.js), which keeps the strict CSP
// (img-src 'self') as it is. Only that one folder and names of that one shape are ever served.
// Built-in backgrounds ship with the app (renderer/wallpapers/<id>.jpg) and are stored as "preset:<id>".
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const NAME_RE = /^[a-f0-9]{16}\.(png|jpe?g|webp|gif)$/;
const EXTS = ["png", "jpg", "jpeg", "webp", "gif"];
const MAX_BYTES = 25 * 1024 * 1024;
const URL_PREFIX = "/user-wallpaper/";
const DIM = { min: 0, max: 90, def: 55 }; // % of the theme's ground laid over the picture, so text stays readable
const MODES = ["telegram", "sessions", "bots"]; // renderer/chat-modes.js ORDER
const PRESETS = ["marble", "aegean", "basalt", "papyrus"]; // renderer/wallpapers/<id>.jpg
/** A setting value: a stored picture's name, or "preset:<id>" for a built-in one. */
const valid = (v) => typeof v === "string" && (NAME_RE.test(v) || (v.startsWith("preset:") && PRESETS.includes(v.slice(7))));

/** Image file signatures, so a renamed non-image is refused. */
function isImage(buf, ext) {
  const b = buf.subarray(0, 12);
  if (ext === "png") return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === "jpg" || ext === "jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (ext === "gif") return b.toString("ascii", 0, 6) === "GIF87a" || b.toString("ascii", 0, 6) === "GIF89a";
  if (ext === "webp") return b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP";
  return false;
}

const dirOf = (userData) => path.join(userData, "wallpapers");

/**
 * Copies `file` into the profile and returns its stored name. Throws (with an i18n key as message) when it is not
 * a supported image or too large. The caller removes pictures no mode uses any more (clean).
 */
function importImage(userData, file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!EXTS.includes(ext)) throw new Error("wall.badType");
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > MAX_BYTES) throw new Error("wall.tooBig");
  const buf = fs.readFileSync(file);
  if (!isImage(buf, ext)) throw new Error("wall.badType");
  const name = `${crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16)}.${ext === "jpeg" ? "jpg" : ext}`;
  const dir = dirOf(userData);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buf);
  return name;
}

/** Removes every stored wallpaper whose name is not in `keep` (a name or a list of names). */
function clean(userData, keep = []) {
  const kept = new Set([].concat(keep).filter(Boolean));
  let names = [];
  try {
    names = fs.readdirSync(dirOf(userData));
  } catch {
    return;
  }
  for (const n of names) {
    if (!kept.has(n) && NAME_RE.test(n)) {
      try {
        fs.unlinkSync(path.join(dirOf(userData), n));
      } catch {
        // in use or gone: the next pick tries again
      }
    }
  }
}

/** The file behind a deck://app/user-wallpaper/<name> request, or null for anything else. */
function fileFor(userData, pathname) {
  if (!pathname.startsWith(URL_PREFIX)) return null;
  const name = decodeURIComponent(pathname.slice(URL_PREFIX.length));
  return NAME_RE.test(name) ? path.join(dirOf(userData), name) : null;
}

/** One mode's setting, cleaned: {file: stored name or "", dim: 0..90}. */
function one(w) {
  const o = w && typeof w === "object" ? w : {};
  const dim = Number.isInteger(o.dim) && o.dim >= DIM.min && o.dim <= DIM.max ? o.dim : DIM.def;
  return { file: valid(o.file) ? o.file : "", dim };
}

/** The saved setting, cleaned: {telegram, sessions, bots} each {file, dim}. A single {file, dim} applies to all. */
function normalize(w) {
  const o = w && typeof w === "object" ? w : {};
  const flat = "file" in o || "dim" in o;
  return Object.fromEntries(MODES.map((m) => [m, one(flat ? o : o[m])]));
}

/** Every stored name some mode uses (what clean keeps). */
const used = (w) => MODES.map((m) => normalize(w)[m].file).filter((f) => NAME_RE.test(f)); // built-ins are never stored

module.exports = { NAME_RE, URL_PREFIX, DIM, MODES, PRESETS, MAX_BYTES, valid, isImage, importImage, clean, fileFor, normalize, used };
