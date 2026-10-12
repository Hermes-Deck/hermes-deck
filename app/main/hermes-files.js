"use strict";
// Files the agent offers in a Hermes session, and their download to this computer.
//
// The agent names a file by its absolute path on the Hermes host, either as `MEDIA:/abs/path` (Hermes' own
// delivery convention) or as a backticked absolute path in a message. This module:
//   - extractFileRefs(text): the references in ONE assistant message (main parses them; the page only ever
//     receives and sends back paths main has seen, see FileOffers);
//   - FileOffers: which paths main has parsed out of which session, bounded. A download of anything else is refused
//     here, before the host's own check (the host again requires the path to stand in that session's transcript);
//   - Downloads: sequential chunk reads (or one relay HTTP stream, resumed with Range after a cut) assembled into a
//     folder, never overwriting, with progress, cancel and a size check, so a half-written file is never left under
//     the final name.
// Core Node only, no Electron: the tests drive it with a fake chunk reader.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { RISKY_EXT } = require("./media");

const MAX_REFS = 8; // chips per message
const MAX_PATH = 1024; // longer paths are text, not files
const FILE_MAX = 200 * 1024 * 1024; // the host's cap for chunk reads (observer.py FILE_SIZE_MAX); checked here too
const CHUNK = 1024 * 1024; // the host's per-call cap (FILE_CHUNK_MAX)
const STREAM_RETRIES = 3; // a relay download cut this many times in a row without a new byte fails
const MAX_ACTIVE = 2; // downloads running at once
const OFFER_SESSIONS = 64; // sessions whose offers are remembered
const OFFER_PATHS = 512; // paths remembered per session

// A path that looks like a file: absolute POSIX, at least one directory, no control characters, no placeholder
// or glob characters, no ".." segment.
function plausiblePath(p, { needExt }) {
  if (typeof p !== "string" || p.length < 3 || p.length > MAX_PATH || p[0] !== "/" || p[1] === "/") return false;
  if (/[\u0000-\u001f\u007f*?<>|"$`{}\\]/.test(p)) return false;
  const parts = p.split("/").slice(1);
  if (parts.length < 2 || parts.some((s) => s === "" || s === "." || s === "..")) return false;
  const last = parts[parts.length - 1];
  if (needExt && !/^[^/]+\.[A-Za-z0-9]{1,10}$/.test(last)) return false;
  return true;
}

// Fenced code blocks are examples, not offers (Hermes masks them the same way before it delivers MEDIA: tags).
const unfenced = (text) => String(text).replace(/```[\s\S]*?(```|$)/g, "\n");

const TRAIL = /[.,;:!?)\]}>*_'"]+$/;

/**
 * File references in one assistant message, in order, without duplicates.
 *   MEDIA:/abs/path         (also quoted, backticked or wrapped in Markdown emphasis)
 *   `/abs/dir/name.ext`     (inline code; needs a file extension so `/usr/bin` is not a download)
 * Returns [{path, name, media}] (media: the agent used MEDIA:, so the chip stays visible even when the file is
 * gone). Text from the user, tools or the system is never passed in here (see FileOffers.collect).
 */
function extractFileRefs(text) {
  const src = unfenced(typeof text === "string" ? text.slice(0, 200000) : "");
  const found = new Map();
  const add = (p, media) => {
    if (found.size >= MAX_REFS) return;
    const have = found.get(p);
    if (have) {
      have.media = have.media || media;
      return;
    }
    found.set(p, { path: p, name: path.posix.basename(p), media });
  };
  // No boundary before MEDIA: (Hermes accepts glued tags, MEDIA:/a.pngMEDIA:/b.png); a bare path stops at the next tag.
  const re = /MEDIA:[ \t]*(?:`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|((?:(?!MEDIA:)[^\s`"'])(?:(?!MEDIA:)[^\s`])*))/g;
  let m;
  while ((m = re.exec(src))) {
    let p = m[1] || m[2] || m[3];
    if (p === undefined) {
      p = m[4];
      for (let prev; prev !== p; ) {
        prev = p;
        p = p.replace(TRAIL, "");
      }
      // glued tags (MEDIA:/a.pngMEDIA:/b.png) stop at the next tag
      const glued = p.indexOf("MEDIA:");
      if (glued > 0) p = p.slice(0, glued);
    }
    if (plausiblePath(p, { needExt: false })) add(p, true);
  }
  const inline = /(?<!`)`([^`\n]{3,1024})`(?!`)/g;
  while ((m = inline.exec(src))) {
    const p = m[1].trim();
    if (plausiblePath(p, { needExt: true })) add(p, false);
  }
  return [...found.values()];
}

/**
 * Which paths main has parsed out of which session's assistant messages. The page never sees a path: it gets an
 * opaque ref (a hash of session and path, so reloading the same history yields the same ref) and sends that
 * back; only a ref main issued for that session resolves to a path.
 */
class FileOffers {
  constructor() {
    this.sessions = new Map(); // sid -> Map(ref -> path), least recently used first
  }

  static refOf(sid, p) {
    return crypto.createHash("sha1").update(`${sid}\u0000${p}`).digest("hex").slice(0, 16);
  }

  /** Parse one history message. Returns [{ref, name, media}] (no path); only assistant messages offer anything. */
  collect(sid, message) {
    if (!message || message.role !== "assistant" || typeof message.text !== "string") return [];
    const parsed = extractFileRefs(message.text);
    if (!parsed.length) return [];
    let map = this.sessions.get(sid);
    if (!map) {
      map = new Map();
    } else {
      this.sessions.delete(sid); // most recently used last
    }
    this.sessions.set(sid, map);
    while (this.sessions.size > OFFER_SESSIONS) this.sessions.delete(this.sessions.keys().next().value);
    const out = [];
    for (const r of parsed) {
      const ref = FileOffers.refOf(sid, r.path);
      map.delete(ref);
      map.set(ref, r.path);
      while (map.size > OFFER_PATHS) map.delete(map.keys().next().value);
      out.push({ ref, name: r.name, media: r.media });
    }
    return out;
  }

  /**
   * Register a path a USER message named with an `@image:` / `@file:` line (media-refs.js parsed it) and return its
   * ref. Same opaque-ref rule as collect(); the host still decides whether this session's transcript allows it.
   */
  offer(sid, p) {
    let map = this.sessions.get(sid);
    if (!map) map = new Map();
    else this.sessions.delete(sid);
    this.sessions.set(sid, map);
    while (this.sessions.size > OFFER_SESSIONS) this.sessions.delete(this.sessions.keys().next().value);
    const ref = FileOffers.refOf(sid, p);
    map.delete(ref);
    map.set(ref, p);
    while (map.size > OFFER_PATHS) map.delete(map.keys().next().value);
    return ref;
  }

  /** The host path behind a ref main issued for this session, else null. */
  pathOf(sid, ref) {
    const map = this.sessions.get(sid);
    return (map && map.get(ref)) || null;
  }

  forget(sid) {
    this.sessions.delete(sid);
  }

  clear() {
    this.sessions.clear();
  }
}

/** A name that is safe in a Windows/macOS/Linux folder (the media.js rules), keeping the extension. */
function safeFileName(name, fallback = "file") {
  let n = String(name || "")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = `_${n}`;
  if (!n) n = fallback;
  if (n.length > 120) {
    const ext = path.extname(n).slice(0, 12);
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

/**
 * Reserve a file name in `dir` that does not exist yet ("report.pdf", then "report (1).pdf", ...). The empty file is
 * created with the exclusive flag so two downloads of the same name can never pick the same one.
 */
function reserveName(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 0; i < 1000; i++) {
    const candidate = path.join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    try {
      fs.closeSync(fs.openSync(candidate, "wx", 0o600));
      return candidate;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  throw new Error("no free file name");
}

const folderError = (dir, why) => Object.assign(new Error(`download folder unusable: ${why}`), { code: "folder", dir, why });

/** Writes all of `buf` at `position` of fd without blocking the main process. */
async function writeAll(fd, buf, position) {
  let done = 0;
  while (done < buf.length) {
    const { bytesWritten } = await new Promise((resolve, reject) =>
      fs.write(fd, buf, done, buf.length - done, position + done, (err, bytesWritten) => (err ? reject(err) : resolve({ bytesWritten })))
    );
    if (!bytesWritten) throw new Error("write failed");
    done += bytesWritten;
  }
}

/**
 * Whether a broken relay stream is worth reopening from its last byte: a network cut, an idle timeout, a short body or
 * a relay that is briefly unavailable (5xx). A refusal (4xx: unknown ticket, changed file, too big), a cancel or a
 * local write error is final.
 */
function retriable(e) {
  if (!e) return false;
  if (e.code === "changed" || e.code === "canceled" || e.code === "too-big") return false;
  if (e.relayDownload && Number.isInteger(e.status)) return e.status >= 500;
  if (e.relayDownload) return e.code === "network" || e.code === "timeout";
  return e.code === "network" || e.code === "ECONNRESET" || e.code === "ERR_STREAM_PREMATURE_CLOSE" || e.code === "EPIPE" || e.code === "ETIMEDOUT" || e.message === "aborted";
}

/** A configurable setting value is usable as a folder path: absolute, no control characters, sane length. */
function validFolderSetting(dir) {
  return typeof dir === "string" && dir.length > 0 && dir.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(dir) && (path.isAbsolute(dir) || /^[A-Za-z]:[\\/]/.test(dir));
}

/**
 * The folder a download goes to. `custom` is the owner's chosen folder (settings downloads.dir): it must already
 * exist, be a directory and be writable, else this throws {code: "folder"}; it never falls back to another folder,
 * because writing somewhere the owner did not choose is worse than an error. With no custom folder the default
 * (`fallback`: the OS Downloads folder + "Hermes Deck") is used and created when missing.
 */
function resolveFolder({ custom, fallback }) {
  if (custom) {
    if (!validFolderSetting(custom)) throw folderError(custom, "not an absolute path");
    let st;
    try {
      st = fs.statSync(custom);
    } catch {
      throw folderError(custom, "missing");
    }
    if (!st.isDirectory()) throw folderError(custom, "not a folder");
    try {
      fs.accessSync(custom, fs.constants.W_OK);
    } catch {
      throw folderError(custom, "not writable");
    }
    return custom;
  }
  try {
    fs.mkdirSync(fallback, { recursive: true });
    fs.accessSync(fallback, fs.constants.W_OK);
  } catch {
    throw folderError(fallback, "not writable");
  }
  return fallback;
}

/**
 * Downloads, one object per app. A job either reads chunks through the bridge (`read(offset, length)` returns
 * {length, size, eof, bytes: Buffer} for the file being fetched; the caller binds session, profile and path) or
 * streams it over HTTP from the relay (`open(start, signal)` resolves a readable of the file's bytes from `start`:
 * a cut stream is reopened from the last byte written, `retries` times in a row without progress). `dir` is a folder
 * or a () => folder that may throw {code: "folder"} (see resolveFolder); a job with `target` (a path the owner picked
 * in a Save As dialog, which already asked about overwriting) goes exactly there instead. `max` caps one file (a job
 * may bring its own: the active limit of its path).
 */
class Downloads {
  constructor({ dir, maxActive = MAX_ACTIVE, chunk = CHUNK, max = FILE_MAX, retries = STREAM_RETRIES, retryMs = 1000 } = {}) {
    this.dir = dir; // () => folder or a string
    this.maxActive = maxActive;
    this.chunk = chunk;
    this.max = max;
    this.retries = retries;
    this.retryMs = retryMs;
    this.active = new Map(); // ticket -> {cancel}
    this.saved = new Map(); // id -> final path (bounded; Open/Show in folder name an id, never a path)
    this.seq = 0;
  }

  folder() {
    return typeof this.dir === "function" ? this.dir() : this.dir;
  }

  /** Reserve the final file: the picked target, or a free name in the folder. Folder problems become {code: "folder"}. */
  _reserve(name, target) {
    const dir = target ? path.dirname(target) : this.folder();
    try {
      if (target) {
        fs.accessSync(dir, fs.constants.W_OK);
        return { final: target, owned: false };
      }
      return { final: reserveName(dir, name), owned: true };
    } catch (e) {
      if (e && e.code === "folder") throw e;
      throw folderError(dir, (e && e.code) || "not writable");
    }
  }

  /**
   * @param {string} ticket   caller-chosen id of this download (progress and cancel)
   * @param {{name: string, size: number, read: Function, onProgress?: Function}} job
   * @returns {Promise<{status: "done", id, name, size, risky} | {status: "cancelled"}>}
   */
  async run(ticket, job) {
    if (this.active.has(ticket)) throw new Error("download already running");
    if (this.active.size >= this.maxActive) throw Object.assign(new Error("too many downloads"), { code: "busy" });
    const size = job.size;
    const max = Number.isSafeInteger(job.max) && job.max > 0 ? job.max : this.max;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("bad file size");
    if (size > max) throw Object.assign(new Error("file too big"), { code: "too-big", max });
    const state = { cancelled: false, abort: null };
    this.active.set(ticket, state);
    const name = safeFileName(job.name);
    let final = null;
    let part = null;
    let fd = null;
    let owned = true; // the final file was created (empty) by us, so a failed download removes it
    try {
      ({ final, owned } = this._reserve(name, job.target));
      part = `${final}.${process.pid}.part`;
      fd = fs.openSync(part, "w", 0o600);
      const offset = job.open ? await this._stream(state, fd, job, size) : await this._chunks(state, fd, job, size);
      if (offset === null) return this._abandon({ fd, part, final: owned ? final : null });
      fs.closeSync(fd);
      fd = null;
      if (offset !== size || fs.statSync(part).size !== size) throw Object.assign(new Error("incomplete download"), { code: "incomplete" });
      fs.renameSync(part, final); // replaces the reserved empty file (or the file the owner agreed to replace)
      const id = `d${++this.seq}`;
      this.saved.set(id, final);
      while (this.saved.size > 64) this.saved.delete(this.saved.keys().next().value);
      return { status: "done", id, name: path.basename(final), size, risky: RISKY_EXT.has(path.extname(final).slice(1).toLowerCase()) };
    } catch (e) {
      if (state.cancelled) return this._abandon({ fd, part, final: owned ? final : null });
      this._abandon({ fd, part, final: owned ? final : null });
      throw e;
    } finally {
      this.active.delete(ticket);
    }
  }

  /** Sequential chunk reads through the bridge into fd; the bytes written, or null when cancelled. */
  async _chunks(state, fd, job, size) {
    let offset = 0;
    let last = 0;
    while (offset < size || (size === 0 && offset === 0)) {
      if (state.cancelled) return null;
      const want = Math.min(this.chunk, Math.max(1, size - offset));
      const r = await job.read(offset, want);
      if (state.cancelled) return null;
      if (!r || !Buffer.isBuffer(r.bytes) || r.bytes.length !== r.length || r.length > want) throw new Error("bad chunk");
      if (r.size !== size) throw Object.assign(new Error("file changed"), { code: "changed" });
      if (r.length === 0 && !r.eof) throw new Error("empty chunk");
      fs.writeSync(fd, r.bytes, 0, r.bytes.length);
      offset += r.length;
      const now = Date.now();
      if (job.onProgress && (now - last > 120 || offset >= size)) {
        last = now;
        job.onProgress({ received: offset, size });
      }
      if (r.eof) break;
    }
    return offset;
  }

  /**
   * One HTTP stream from the relay into fd (written as it arrives: the reader waits for each write, so nothing piles
   * up in memory). A stream that breaks off is reopened from the last byte written (Range); `retries` breaks in a row
   * without a new byte fail the download. Errors that a retry cannot fix (the relay refused the request, the file
   * changed, a cancel) end it at once. Returns the bytes written, or null when cancelled.
   */
  async _stream(state, fd, job, size) {
    let offset = 0;
    let last = 0;
    let failures = 0;
    while (offset < size) {
      if (state.cancelled) return null;
      const controller = new AbortController();
      state.abort = () => controller.abort();
      const before = offset;
      try {
        const body = await job.open(offset, controller.signal);
        for await (const chunk of body) {
          if (state.cancelled) {
            if (typeof body.destroy === "function") body.destroy();
            return null;
          }
          if (offset + chunk.length > size) throw Object.assign(new Error("file changed"), { code: "changed" });
          await writeAll(fd, chunk, offset);
          offset += chunk.length;
          const now = Date.now();
          if (job.onProgress && (now - last > 120 || offset >= size)) {
            last = now;
            job.onProgress({ received: offset, size });
          }
        }
        if (offset < size) throw Object.assign(new Error("stream ended early"), { code: "network" });
      } catch (e) {
        if (state.cancelled) return null;
        if (!retriable(e)) throw e;
        failures = offset > before ? 1 : failures + 1;
        if (failures > this.retries) throw e;
        await new Promise((resolve) => setTimeout(resolve, offset > before ? 0 : this.retryMs * failures));
      } finally {
        state.abort = null;
      }
    }
    return offset;
  }

  _abandon({ fd, part, final }) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    for (const f of [part, final]) {
      if (!f) continue;
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* best effort */
      }
    }
    return { status: "cancelled" };
  }

  cancel(ticket) {
    const s = this.active.get(ticket);
    if (!s) return false;
    s.cancelled = true;
    if (s.abort) s.abort(); // a relay stream stops now, not at its next chunk
    return true;
  }

  cancelAll() {
    for (const s of this.active.values()) {
      s.cancelled = true;
      if (s.abort) s.abort();
    }
  }

  /** The path of a finished download (main only; never sent to the page). */
  pathOf(id) {
    return this.saved.get(id) || null;
  }
}

module.exports = { extractFileRefs, FileOffers, Downloads, safeFileName, reserveName, resolveFolder, validFolderSetting, plausiblePath, retriable, MAX_REFS, FILE_MAX, CHUNK, STREAM_RETRIES };
