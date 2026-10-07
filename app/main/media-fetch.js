"use strict";
// Reads one whole image from the Hermes host for an inline preview. The caller binds session, profile and path to
// `read(offset, length)` (the bridge's one bounded file method), so this module never sees more than bytes.
// The answer is an object, never an exception, for the expected failures: the page draws a neutral chip for them.
//   {ok: true, mime, bytes: Buffer}
//   {ok: false, reason: "too-big" | "not-image" | "unavailable"}
// Core Node only; the tests drive it with a fake reader.
const { sniffImage } = require("./media");

const PREVIEW_MAX = 12 * 1024 * 1024; // larger pictures stay a download chip (the lightbox shows what the preview holds)
const CHUNK = 1024 * 1024; // the host's per-call cap

async function fetchImage(read, { max = PREVIEW_MAX, chunk = CHUNK } = {}) {
  let first;
  try {
    first = await read(0, 1); // one byte: the size, after the host's own checks
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  const size = first && first.size;
  if (!Number.isSafeInteger(size) || size < 12) return { ok: false, reason: size >= 0 && size < 12 ? "not-image" : "unavailable" };
  if (size > max) return { ok: false, reason: "too-big" };
  const parts = [];
  let offset = 0;
  try {
    while (offset < size) {
      const want = Math.min(chunk, size - offset);
      const r = await read(offset, want);
      if (!r || !Buffer.isBuffer(r.bytes) || r.bytes.length !== r.length || r.length > want || r.size !== size) return { ok: false, reason: "unavailable" };
      if (r.length === 0) return { ok: false, reason: "unavailable" };
      parts.push(r.bytes);
      offset += r.length;
      if (offset === r.length && !sniffImage(r.bytes)) return { ok: false, reason: "not-image" }; // decided on the first bytes
    }
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  const bytes = Buffer.concat(parts, offset);
  const mime = sniffImage(bytes);
  return mime ? { ok: true, mime, bytes } : { ok: false, reason: "not-image" };
}

// ---------------------------------------------------------------------------------------------- audio (voice bubble)
// The inline voice-note player needs the whole clip in the page (decodeAudioData for the waveform, a blob: URL for
// playback), so it gets the same bounded, host-checked read as an image preview: {ok: true, mime, bytes} or
// {ok: false, reason: "too-big" | "not-audio" | "unavailable"}. Chromium plays ogg/opus, mp3, wav, m4a and webm itself.
const AUDIO_MAX = 25 * 1024 * 1024; // the same cap the Telegram full download uses (media.MAX_FULL)
const AUDIO_EXT = {
  m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", webm: "audio/webm",
  aac: "audio/aac", caf: "audio/x-caf", amr: "audio/amr", flac: "audio/flac", aif: "audio/aiff", aiff: "audio/aiff",
};

/** The container of an audio clip from its first bytes, or null. */
function sniffAudio(b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return null;
  const at = (i, s) => b.toString("latin1", i, i + s.length) === s;
  if (at(0, "OggS")) return "audio/ogg";
  if (at(0, "RIFF") && at(8, "WAVE")) return "audio/wav";
  if (at(4, "ftyp")) return "audio/mp4";
  if (at(0, "fLaC")) return "audio/flac";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "audio/webm";
  if (at(0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (at(0, "caff")) return "audio/x-caf";
  if (at(0, "#!AMR")) return "audio/amr";
  if (at(0, "FORM") && (at(8, "AIFF") || at(8, "AIFC"))) return "audio/aiff";
  return null;
}

/** The mime a file name suggests (the last extension), or null. */
function audioMimeForName(name) {
  const m = /[.]([A-Za-z0-9]{1,5})$/.exec(String(name || ""));
  return (m && AUDIO_EXT[m[1].toLowerCase()]) || null;
}

/** One whole audio file. `name` (the host file's name) decides a clip whose bytes carry no known signature. */
async function fetchAudio(read, { max = AUDIO_MAX, chunk = CHUNK, name = "" } = {}) {
  let first;
  try {
    first = await read(0, 1);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  const size = first && first.size;
  if (!Number.isSafeInteger(size) || size < 1) return { ok: false, reason: size === 0 ? "not-audio" : "unavailable" };
  if (size > max) return { ok: false, reason: "too-big" };
  const parts = [];
  let offset = 0;
  try {
    while (offset < size) {
      const want = Math.min(chunk, size - offset);
      const r = await read(offset, want);
      if (!r || !Buffer.isBuffer(r.bytes) || r.bytes.length !== r.length || r.length > want || r.size !== size || r.length === 0) return { ok: false, reason: "unavailable" };
      parts.push(r.bytes);
      offset += r.length;
    }
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  const bytes = Buffer.concat(parts, offset);
  const mime = sniffAudio(bytes) || audioMimeForName(name);
  return mime ? { ok: true, mime, bytes } : { ok: false, reason: "not-audio" };
}

module.exports = { fetchImage, PREVIEW_MAX, fetchAudio, sniffAudio, audioMimeForName, AUDIO_MAX, AUDIO_EXT };
