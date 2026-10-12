"use strict";
// Notification sounds (Settings > Desktop > Notifications): which sound each event plays, and the volume.
// Events: a new reply, a finished task, an approval or a question that waits for the user, and a finished
// sub-agent. Each event plays a built-in sound ("preset:<id>", synthesized in renderer/chime.js, no audio files),
// nothing (""), or the user's own audio file. A picked file is copied into the profile
// (<userData>/sounds/<sha256-16>.<ext>) so the original can move or vanish, and the page plays it as
// deck://app/user-sound/<name> (protocol handler in main.js), which keeps the strict CSP (media-src 'self') as it
// is. Only that one folder and names of that one shape are ever served.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const NAME_RE = /^[a-f0-9]{16}\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|webm)$/;
const EXTS = ["mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "webm"];
const MAX_BYTES = 5 * 1024 * 1024; // a notification sound is a few seconds long
const URL_PREFIX = "/user-sound/";
const EVENTS = ["reply", "done", "approval", "question", "subagent"];
// renderer/chime.js TUNES: keep the two lists the same (test/sounds.test.js checks)
const PRESETS = ["bell", "rise", "chord", "pop", "marimba", "glass", "knock", "tick", "alert"];
const DEFAULTS = Object.freeze({
  volume: 80,
  events: Object.freeze({ reply: "preset:bell", done: "preset:chord", approval: "preset:rise", question: "preset:rise", subagent: "preset:tick" }),
});
const VOLUME = { min: 0, max: 100 };

/** A built-in sound or nothing: what the settings patch may set directly (own files come only through the picker). */
const isPresetOrNone = (v) => v === "" || (typeof v === "string" && v.startsWith("preset:") && PRESETS.includes(v.slice(7)));
/** A stored event value: a built-in sound, nothing, or a stored file's name. */
const valid = (v) => isPresetOrNone(v) || (typeof v === "string" && NAME_RE.test(v));
const validVolume = (v) => Number.isInteger(v) && v >= VOLUME.min && v <= VOLUME.max;

/** Audio file signatures, so a renamed non-audio file is refused. */
function isAudio(buf, ext) {
  const b = buf.subarray(0, 12);
  if (b.length < 4) return false;
  const ascii = (from, to) => b.toString("ascii", from, to);
  if (ext === "mp3") return ascii(0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
  if (ext === "wav") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
  if (ext === "ogg" || ext === "oga" || ext === "opus") return ascii(0, 4) === "OggS";
  if (ext === "flac") return ascii(0, 4) === "fLaC";
  if (ext === "m4a") return ascii(4, 8) === "ftyp";
  if (ext === "aac") return ascii(0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) || ascii(4, 8) === "ftyp";
  if (ext === "webm") return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
  return false;
}

const dirOf = (userData) => path.join(userData, "sounds");

/**
 * Copies `file` into the profile and returns its stored name. Throws (with an i18n key as message) when it is not
 * a supported audio file or too large. The caller removes files no event uses any more (clean).
 */
function importSound(userData, file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!EXTS.includes(ext)) throw new Error("sound.badType");
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error("sound.badType");
  if (st.size > MAX_BYTES) throw new Error("sound.tooBig");
  const buf = fs.readFileSync(file);
  if (!isAudio(buf, ext)) throw new Error("sound.badType");
  const name = `${crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16)}.${ext}`;
  const dir = dirOf(userData);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buf);
  return name;
}

/** Removes every stored sound whose name is not in `keep` (a name or a list of names). */
function clean(userData, keep = []) {
  const kept = new Set([].concat(keep).filter(Boolean));
  let names = [];
  try {
    names = fs.readdirSync(dirOf(userData));
  } catch {
    return;
  }
  for (const n of names) {
    if (kept.has(n) || !NAME_RE.test(n)) continue;
    try {
      fs.unlinkSync(path.join(dirOf(userData), n));
    } catch {
      // in use or gone: the next pick tries again
    }
  }
}

/** The file behind a deck://app/user-sound/<name> request, or null for anything else. */
function fileFor(userData, pathname) {
  if (!pathname.startsWith(URL_PREFIX)) return null;
  const name = decodeURIComponent(pathname.slice(URL_PREFIX.length));
  return NAME_RE.test(name) ? path.join(dirOf(userData), name) : null;
}

/** The saved setting, cleaned: {volume: 0..100, events: {reply, done, approval, question, subagent}}. */
function normalize(s) {
  const o = s && typeof s === "object" && !Array.isArray(s) ? s : {};
  const ev = o.events && typeof o.events === "object" && !Array.isArray(o.events) ? o.events : {};
  return {
    volume: validVolume(o.volume) ? o.volume : DEFAULTS.volume,
    events: Object.fromEntries(EVENTS.map((e) => [e, valid(ev[e]) ? ev[e] : DEFAULTS.events[e]])),
  };
}

/** A settings patch is valid when it holds only a volume and/or built-in sounds (or none) for known events. */
function patchOk(p) {
  if (!p || typeof p !== "object" || Array.isArray(p) || !Object.keys(p).length) return false;
  for (const [k, v] of Object.entries(p)) {
    if (k === "volume") {
      if (!validVolume(v)) return false;
    } else if (k === "events") {
      if (!v || typeof v !== "object" || Array.isArray(v) || !Object.keys(v).length) return false;
      if (!Object.entries(v).every(([e, x]) => EVENTS.includes(e) && isPresetOrNone(x))) return false;
    } else return false;
  }
  return true;
}

/** Every stored name some event uses (what clean keeps). */
const used = (s) => [...new Set(Object.values(normalize(s).events).filter((v) => NAME_RE.test(v)))];

module.exports = { NAME_RE, EXTS, MAX_BYTES, URL_PREFIX, EVENTS, PRESETS, DEFAULTS, VOLUME, valid, isPresetOrNone, validVolume, isAudio, importSound, clean, fileFor, normalize, patchOk, used };
