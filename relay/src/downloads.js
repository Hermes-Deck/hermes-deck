"use strict";
// Large downloads (desktop app and iOS): files the agent offered in a Hermes session, streamed straight from disk.
// The Hermes plugin on this host decides whether a file may be downloaded at all (observer.py deck.file_grant runs
// exactly deck.file_read's authorization: the path must stand in an assistant message of that session, never a
// credential or Hermes state location, never a final symlink, a regular file). When it allows it, the plugin writes a
// short-lived ticket <spool>/downloads/<id>.json (0600, folder 0700) into the upload spool this relay shares with it
// (uploads.js; same machine and real folder, proven by the same hostId on both sides):
//   {v: 1, id, path, name, size, mtime_ns, dev, ino, created, expires}
// dev, ino and mtime_ns are decimal strings (they pass 2**53); created/expires are epoch milliseconds.
// GET /downloads/<id> (relay token only) reads the ticket, re-opens `path` with O_NOFOLLOW and serves it only while
// device, inode, size and mtime still equal the ticket: a file replaced or changed since the grant is refused. The
// body is piped from the file descriptor with backpressure (never buffered) and supports `Range: bytes=a-` (206), so
// an interrupted download resumes. A ticket may be reused until it expires (15 min); the upload sweep deletes expired
// ones. No path ever travels over the wire, only the 48-hex id.
const fs = require("fs");
const path = require("path");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");

const GIB = 1024 * 1024 * 1024;
const DEFAULT_MAX = 8 * GIB; // the plugin's default cap (observer.py FILE_STREAM_MAX); DECK_DOWNLOAD_MAX changes this side
const LEGACY_MAX = 200 * 1024 * 1024; // deck.file_read's cap: the chunk path through the bridge (observer.py FILE_SIZE_MAX)
const ID_RE = /^[a-f0-9]{48}$/;
const ENTRY_RE = /^([a-f0-9]{48})\.json(\.tmp)?$/;
const DEC_RE = /^\d{1,24}$/;
const TICKET_MAX = 65536; // observer.py _TICKET_FILE_MAX
const TMP_AGE_MS = 60 * 1000;
const IDLE_MS = 120 * 1000; // a client that takes no byte for this long is dropped (the file is closed)
const VALID_EVERY_MS = 1000; // how often a long stream re-checks that its caller is still allowed (mobile revocation)

const fail = (code, message, status) => Object.assign(new Error(message), { code, status });

const positive = (value, fallback) => {
  const text = String(value ?? "").trim();
  const n = /^\d+$/.test(text) ? Number(text) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

/** Download settings from the environment (see relay/.env.example). */
function downloadConfig(env = process.env) {
  return { maxBytes: positive(env.DECK_DOWNLOAD_MAX, DEFAULT_MAX) };
}

/**
 * The byte range a `Range` header asks for: {start, end} (inclusive), null when there is none or it is not a single
 * byte range (the whole file is sent, as HTTP allows), "unsatisfiable" when it starts at or past the end.
 */
function parseRange(header, size) {
  if (header === undefined || header === null) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n)) return null;
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const last = m[2] === "" ? size - 1 : Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(last)) return null;
  if (start >= size) return "unsatisfiable";
  if (last < start) return null;
  return { start, end: Math.min(last, size - 1) };
}

/** Content-Disposition for a download name: an ASCII fallback plus the exact UTF-8 name (RFC 6266 / 5987). */
function disposition(name) {
  const clean = String(name || "download").replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 255) || "download";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["%;]/g, "_");
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

class DownloadTickets {
  /** `spool`: the relay's UploadSpool (its folder and hostId); tickets live in <spool.dir>/downloads. */
  constructor({ spool, maxBytes = DEFAULT_MAX, now = Date.now, idleMs = IDLE_MS, uid = typeof process.getuid === "function" ? process.getuid() : null } = {}) {
    if (!spool || typeof spool.dir !== "string") throw new Error("DownloadTickets needs the upload spool");
    Object.assign(this, { spool, maxBytes, now, idleMs, uid });
    if (Array.isArray(spool.sweepers)) spool.sweepers.push(() => this.sweep()); // runs with the upload sweep
  }

  get dir() {
    return path.join(this.spool.dir, "downloads");
  }

  /** The hello's `downloads` object ({v, host, maxBytes}: same host id as `uploads`), or null when the spool is unusable. */
  hello() {
    try {
      return { v: 1, host: this.spool.hostId(), maxBytes: this.maxBytes };
    } catch {
      return null;
    }
  }

  /** A live ticket (see the header), else not_found (missing, expired, unreadable, not ours) or limit (over our cap). */
  read(id) {
    if (typeof id !== "string" || !ID_RE.test(id)) throw fail("not_found", "Download missing or expired", 404);
    let fd;
    try {
      const folder = fs.lstatSync(this.dir);
      if (!folder.isDirectory() || (this.uid !== null && folder.uid !== this.uid)) throw new Error("folder");
      fd = fs.openSync(path.join(this.dir, `${id}.json`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch {
      throw fail("not_found", "Download missing or expired", 404);
    }
    let ticket;
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || (this.uid !== null && st.uid !== this.uid) || st.size > TICKET_MAX) throw new Error("ticket");
      const buf = Buffer.alloc(st.size);
      const got = fs.readSync(fd, buf, 0, st.size, 0);
      ticket = JSON.parse(buf.subarray(0, got).toString("utf8"));
    } catch {
      throw fail("not_found", "Download missing or expired", 404);
    } finally {
      fs.closeSync(fd);
    }
    const t = ticket;
    if (!t || t.v !== 1 || t.id !== id || typeof t.path !== "string" || t.path[0] !== "/" || t.path.length > 4096 || /\u0000/.test(t.path) ||
      typeof t.name !== "string" || !Number.isSafeInteger(t.size) || t.size < 0 || ![t.mtime_ns, t.dev, t.ino].every((v) => typeof v === "string" && DEC_RE.test(v)) ||
      !Number.isSafeInteger(t.created) || !Number.isSafeInteger(t.expires)) throw fail("not_found", "Download missing or expired", 404);
    if (t.expires <= this.now()) throw fail("not_found", "Download missing or expired", 404);
    if (t.size > this.maxBytes) throw fail("limit", "The file is larger than this relay serves", 413);
    return t;
  }

  /** True when `st` (bigint stats) is still the file the ticket pinned. */
  static same(ticket, st) {
    return st.isFile() && st.dev.toString() === ticket.dev && st.ino.toString() === ticket.ino && st.size === BigInt(ticket.size) && st.mtimeNs.toString() === ticket.mtime_ns;
  }

  /** An fd of the ticket's file, opened without following a final link and checked against the pin; else changed (409). */
  open(ticket) {
    let fd;
    try {
      fd = fs.openSync(ticket.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK || 0));
    } catch (e) {
      if (e && e.code === "ENOENT") throw fail("changed", "The file is not there any more", 409);
      throw fail("changed", "The file cannot be opened any more", 409);
    }
    try {
      if (!DownloadTickets.same(ticket, fs.fstatSync(fd, { bigint: true }))) throw fail("changed", "The file changed since it was offered", 409);
      return fd;
    } catch (e) {
      fs.closeSync(fd);
      throw e.status ? e : fail("changed", "The file cannot be read any more", 409);
    }
  }

  /**
   * Streams one ticket's file into `res` (200, or 206 for a Range; 416 past the end). `name`/`mime` override the
   * ticket's name and application/octet-stream; `stillValid()` is asked about once a second (a revoked phone stops).
   */
  async serve(req, res, id, { name = null, mime = "application/octet-stream", stillValid = null } = {}) {
    const ticket = this.read(id);
    const fd = this.open(ticket);
    let handed = false; // once the read stream owns fd, it closes it
    try {
      const size = ticket.size;
      const range = parseRange(req.headers && req.headers.range, size);
      const headers = { "content-type": mime, "cache-control": "no-store", "accept-ranges": "bytes", "content-disposition": disposition(name || ticket.name), "x-content-type-options": "nosniff" };
      if (range === "unsatisfiable") {
        res.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "content-length": 0 });
        return res.end();
      }
      const start = range ? range.start : 0;
      const end = range ? range.end : size - 1;
      const length = size === 0 ? 0 : end - start + 1;
      res.writeHead(range ? 206 : 200, { ...headers, "content-length": length, ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) });
      if (req.method === "HEAD" || length === 0) return res.end();
      if (typeof res.setTimeout === "function") res.setTimeout(this.idleMs, () => res.destroy());
      const source = fs.createReadStream(null, { fd, start, end, highWaterMark: 1024 * 1024 });
      handed = true;
      let sent = 0;
      let checked = Date.now();
      const guard = new Transform({
        transform(chunk, _encoding, done) {
          sent += chunk.length;
          if (stillValid && Date.now() - checked >= VALID_EVERY_MS) {
            checked = Date.now();
            if (!stillValid()) return done(fail("unauthorized", "Access revoked", 401));
          }
          // the last bytes leave only while the path is still the pinned file (a file rewritten in place or replaced
          // during the stream is cut short, so the client's size check fails instead of keeping a mixed file)
          if (sent >= length) {
            let st = null;
            try {
              st = fs.lstatSync(ticket.path, { bigint: true, throwIfNoEntry: false });
            } catch {
              st = null;
            }
            if (!st || !DownloadTickets.same(ticket, st)) return done(fail("changed", "The file changed during the download", 409));
          }
          done(null, chunk);
        },
      });
      await pipeline(source, guard, res);
    } finally {
      if (!handed) fs.closeSync(fd);
    }
  }

  /** Deletes expired, unreadable or foreign-shaped tickets and stale temp files (called by the upload sweep). */
  sweep() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const now = this.now();
    for (const name of names) {
      const m = ENTRY_RE.exec(name);
      if (!m) continue;
      const file = path.join(this.dir, name);
      let expired = false;
      if (m[2]) {
        try {
          expired = now - fs.lstatSync(file).mtimeMs > TMP_AGE_MS;
        } catch {
          continue;
        }
      } else {
        try {
          this.read(m[1]);
        } catch (e) {
          expired = e.code === "not_found";
        }
      }
      if (expired) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* gone already */
        }
      }
    }
  }

  /** GET|HEAD /downloads/<id> (relay token only; server.js refuses mobile tokens before this). True when it answered. */
  onHttp(req, res, url) {
    const match = /^\/downloads\/([a-f0-9]{48})$/.exec(url.pathname);
    if (!match) return false;
    req.resume();
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: { code: "method", message: "Method not allowed" } });
      return true;
    }
    this.serve(req, res, match[1]).catch((error) => {
      if (res.headersSent) return res.destroy();
      sendJson(res, error.status || 500, { error: { code: error.code || "download_error", message: error.status ? error.message : "Download failed" } });
    });
    return true;
  }
}

module.exports = { DownloadTickets, downloadConfig, parseRange, disposition, DEFAULT_MAX, LEGACY_MAX, ID_RE };
