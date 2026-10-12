"use strict";
// Upload spool for large attachments (desktop app and iOS). A client streams a file to the relay over HTTP; the relay
// writes it to <dir>/<id>.part with byte counting and backpressure (never into memory), renames it to <id>.bin when
// every byte is there and then writes <id>.json ({v, id, name, mime, size, created, expires}). The Hermes plugin on
// the same host (observer.py deck.attach_staged) moves <id>.bin into the session's attachments folder and deletes the
// entry; no path ever travels over the wire, only the 48-hex id. The relay and the plugin find the same folder through
// DECK_UPLOAD_DIR / HERMES_DECK_UPLOAD_DIR (default ~/.hermes-deck/uploads) and prove it with hostId(): the same
// machine id and the same real folder give the same 16-hex id on both sides (observer.py upload_host_id).
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
// What one message may carry through the spool. dictationBytes stays at 25 MB: dictation is read into memory.
const DEFAULTS = Object.freeze({ files: 10, fileBytes: 2 * GIB, totalBytes: 4 * GIB, dictationBytes: 25 * MIB, minFree: 10 * GIB });
// The limits of the old single-line path (base64 through the plugin's stdio): the plugin cannot take staged files.
const LEGACY = Object.freeze({ files: 10, fileBytes: 25 * MIB, totalBytes: 50 * MIB, dictationBytes: 25 * MIB });
const TTL_MS = 60 * 60 * 1000; // an unsent upload is deleted this long after it completed
const SWEEP_MS = 5 * 60 * 1000;
const IDLE_MS = 120 * 1000; // an upload that sends no byte for this long is dropped
const ID_RE = /^[a-f0-9]{48}$/;
const ENTRY_RE = /^([a-f0-9]{48})\.(part|bin|json|json\.tmp)$/;
const NAME_RE = /^[^/\\\x00-\x1f]{1,160}$/;
const MIME_RE = /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+(?:;[a-zA-Z0-9= .+-]+)?$/;
const META_MAX = 4096;

const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const opaque = () => crypto.randomBytes(24).toString("hex");

/** This machine's stable id: /etc/machine-id, then /var/lib/dbus/machine-id, then the host name. */
function machineId(read = fs.readFileSync, hostname = os.hostname) {
  for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = String(read(file, "utf8")).trim();
      if (value) return value;
    } catch {
      /* next source */
    }
  }
  return hostname();
}

/** The same-host proof shared with the plugin (observer.py / stream.py upload_host_id): 16 hex characters. */
function hostIdFrom(machine, realDir) {
  return crypto.createHash("sha256").update(`hermes-deck-uploads\0${machine}\0${realDir}`).digest("hex").slice(0, 16);
}

const positive = (value, fallback) => {
  const text = String(value ?? "").trim();
  const n = /^\d+$/.test(text) ? Number(text) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

/** Spool settings from the environment (see relay/.env.example). */
function uploadConfig(env = process.env) {
  return {
    dir: env.DECK_UPLOAD_DIR || path.join(os.homedir(), ".hermes-deck", "uploads"),
    fileBytes: positive(env.DECK_UPLOAD_MAX_FILE, DEFAULTS.fileBytes),
    totalBytes: positive(env.DECK_UPLOAD_MAX_TOTAL, DEFAULTS.totalBytes),
    minFree: positive(env.DECK_UPLOAD_MIN_FREE, DEFAULTS.minFree),
  };
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

/** A small JSON object body (upload metadata); never used for file bytes. */
async function readObject(req, maximum = 65536) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > maximum) throw fail("too_large", "Body too large", 413);
    parts.push(part);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(parts).toString());
  } catch {
    throw fail("bad_request", "Expected JSON object");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("bad_request", "Expected JSON object");
  return value;
}

/** After an early error answer: a small unread body is drained (so the answer arrives), a big one cuts the connection. */
function settleBody(req, res) {
  if (req.complete) return;
  res.setHeader("connection", "close");
  const left = Number(req.headers && req.headers["content-length"]);
  if (Number.isFinite(left) && left <= 1024 * 1024) req.resume();
  else res.on("finish", () => req.destroy());
}

/** An owner's upload state: a mobile device (mobile.js) or the desktop relay token (UploadSpool.desktop). */
const newOwner = () => ({ uploads: new Map(), inflightBytes: 0 });

class UploadSpool {
  constructor({ dir = uploadConfig().dir, fileBytes = DEFAULTS.fileBytes, totalBytes = DEFAULTS.totalBytes, minFree = DEFAULTS.minFree, ttlMs = TTL_MS, idleMs = IDLE_MS, statfs = null, machine = null, now = Date.now } = {}) {
    Object.assign(this, { dir: path.resolve(dir), fileBytes, totalBytes, minFree, ttlMs, idleMs, now });
    this.statfs = statfs || ((d) => fs.statfsSync(d));
    this.machine = machine;
    this.items = new Map(); // id -> item, every upload this process knows (any owner)
    this.inflight = new Set(); // ids a send is using: the sweep never deletes them
    this.desktop = newOwner(); // the relay token (desktop apps)
    this.timer = null;
    this.host = null;
    this.sweepers = []; // more sweeps that run with this one (downloads.js: expired download tickets)
  }

  limits() {
    return { files: DEFAULTS.files, fileBytes: this.fileBytes, totalBytes: this.totalBytes, dictationBytes: DEFAULTS.dictationBytes };
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
  }

  /** Same-host id (see hostIdFrom); creates the spool folder on first use, so both sides hash the same real path. */
  hostId() {
    if (!this.host) {
      this.ensureDir();
      this.host = hostIdFrom(this.machine || machineId(), fs.realpathSync(this.dir));
    }
    return this.host;
  }

  /** The WebSocket hello's `uploads` object (server.js), or null when the spool folder cannot be used. */
  hello() {
    try {
      const l = this.limits();
      return { v: 1, host: this.hostId(), files: l.files, fileBytes: l.fileBytes, totalBytes: l.totalBytes };
    } catch {
      return null;
    }
  }

  file(id, ext) {
    return path.join(this.dir, `${id}.${ext}`);
  }

  validate(args, maxFile) {
    if (!args || typeof args.name !== "string" || !NAME_RE.test(args.name) || !args.name.replace(/^[. ]+|[. ]+$/g, "") ||
      typeof args.mime !== "string" || !MIME_RE.test(args.mime) || args.mime.length > 120 ||
      !Number.isSafeInteger(args.size) || args.size < 1 || args.size > maxFile) throw fail("bad_request", "Invalid upload metadata");
  }

  /** Bytes an owner holds: every upload not sent yet (pending, writing, ready) plus sends in flight. */
  reserved(owner) {
    let n = owner.inflightBytes;
    for (const item of owner.uploads.values()) n += item.size;
    return n;
  }

  /** Bytes still to be written by every upload in progress (the disk guard counts them as used). */
  pendingBytes() {
    let n = 0;
    for (const item of this.items.values()) if (item.state === "pending" || item.state === "writing") n += item.size - (item.written || 0);
    return n;
  }

  /** A new upload ticket {id, ...}; throws bad_request, limit (413) or disk_full (507). */
  create(owner, args, limits = this.limits()) {
    this.validate(args, limits.fileBytes);
    this.prune(owner);
    if (owner.uploads.size >= limits.files || this.reserved(owner) + args.size > limits.totalBytes) throw fail("limit", "Upload limit", 413);
    this.ensureDir();
    let free = null;
    try {
      const s = this.statfs(this.dir);
      free = Number(s.bavail) * Number(s.bsize);
    } catch {
      free = null; // no statfs here: the write itself fails with ENOSPC and is cleaned up
    }
    if (free !== null && Number.isFinite(free) && free - this.pendingBytes() - args.size < this.minFree) {
      throw fail("disk_full", "Not enough free disk space on the relay host for this upload", 507);
    }
    const now = this.now();
    const item = { id: opaque(), name: args.name, mime: args.mime, size: args.size, created: now, expires: now + this.ttlMs, state: "pending", written: 0 };
    this.items.set(item.id, item);
    owner.uploads.set(item.id, item);
    return item;
  }

  /** One of the owner's uploads that has not expired (a running write never expires), else not_found (404). */
  get(owner, id) {
    const item = typeof id === "string" && ID_RE.test(id) ? owner.uploads.get(id) : null;
    if (!item || (item.state !== "writing" && item.expires < this.now())) throw fail("not_found", "Upload missing or expired", 404);
    return item;
  }

  /**
   * Streams the request body into <id>.part (piped with backpressure, counted, never buffered), then renames it to
   * <id>.bin and writes <id>.json. Any failure (size mismatch, cancel, client gone, disk error) deletes the upload.
   */
  async write(owner, item, req, { stillValid = null } = {}) {
    if (item.state !== "pending") throw fail("conflict", "Upload already written", 409);
    const declared = req.headers && req.headers["content-length"];
    if (declared !== undefined && Number(declared) !== item.size) {
      this.remove(owner, item.id);
      throw fail("bad_request", "Upload size mismatch");
    }
    item.state = "writing";
    item.written = 0;
    const controller = new AbortController();
    item.abort = () => controller.abort();
    const part = this.file(item.id, "part");
    if (typeof req.setTimeout === "function") req.setTimeout(this.idleMs, () => req.destroy(fail("timeout", "Upload stalled", 408)));
    try {
      const out = fs.createWriteStream(part, { flags: "wx", mode: 0o600 });
      const counter = new Transform({
        transform(chunk, _encoding, done) {
          item.written += chunk.length;
          if (item.written > item.size) return done(fail("bad_request", "Upload size mismatch"));
          done(null, chunk);
        },
      });
      await pipeline(req, counter, out, { signal: controller.signal });
      if (item.written !== item.size) throw fail("bad_request", "Upload size mismatch");
      if (owner.uploads.get(item.id) !== item || (stillValid && !stillValid())) throw fail("not_found", "Upload canceled or revoked", 404);
      fs.renameSync(part, this.file(item.id, "bin"));
      const now = this.now();
      item.completed = now;
      item.expires = now + this.ttlMs;
      this.writeMeta(item);
      item.state = "ready";
      return item;
    } catch (error) {
      const canceled = controller.signal.aborted;
      item.state = "failed";
      owner.uploads.delete(item.id);
      this.items.delete(item.id);
      this.removeFiles(item.id);
      if (canceled) throw fail("not_found", "Upload canceled", 404);
      if (error && error.code && error.status) throw error;
      throw fail("write_failed", "Upload could not be stored", 500);
    } finally {
      delete item.abort;
    }
  }

  writeMeta(item) {
    const meta = { v: 1, id: item.id, name: item.name, mime: item.mime, size: item.size, created: item.created, expires: item.expires };
    const tmp = this.file(item.id, "json.tmp");
    fs.writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600, flag: "w" });
    fs.renameSync(tmp, this.file(item.id, "json"));
  }

  readMeta(id) {
    const file = this.file(id, "json");
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > META_MAX) throw new Error("bad meta");
    const meta = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!meta || meta.v !== 1 || meta.id !== id || !Number.isSafeInteger(meta.size)) throw new Error("bad meta");
    return meta;
  }

  removeFiles(id) {
    for (const ext of ["part", "bin", "json", "json.tmp"]) {
      try {
        fs.unlinkSync(this.file(id, ext));
      } catch {
        /* not there */
      }
    }
  }

  /** Cancel: deletes the upload now, also while it is being written (the request stream is aborted). */
  remove(owner, id) {
    const item = owner.uploads.get(id);
    if (!item) return false;
    owner.uploads.delete(id);
    this.items.delete(id);
    if (item.abort) item.abort(); // write() deletes its files when the pipeline stops
    else this.removeFiles(id);
    return true;
  }

  /** The whole file of a small ready upload (dictation, the legacy base64 send path). */
  readBuffer(item, max) {
    if (item.size > max) throw fail("limit", "Upload too large for this path", 413);
    const bytes = fs.readFileSync(this.file(item.id, "bin"));
    if (bytes.length !== item.size) throw fail("changed", "Upload changed");
    return bytes;
  }

  /**
   * Moves ready uploads into a send: they leave the owner's list (a resend gets not_found) but stay reserved and are
   * never swept until release(), which also deletes whatever the plugin left in the spool.
   */
  take(owner, ids) {
    const items = ids.map((id) => this.get(owner, id));
    if (items.some((item) => item.state !== "ready")) throw fail("not_ready", "Upload incomplete");
    const reserved = items.reduce((sum, item) => sum + item.size, 0);
    owner.inflightBytes += reserved;
    for (const item of items) {
      owner.uploads.delete(item.id);
      this.inflight.add(item.id);
    }
    let released = false;
    return {
      items,
      release: () => {
        if (released) return;
        released = true;
        owner.inflightBytes -= reserved;
        for (const item of items) {
          this.inflight.delete(item.id);
          this.items.delete(item.id);
          this.removeFiles(item.id);
        }
      },
    };
  }

  /** Drops an owner's expired uploads and those the plugin already consumed (<id>.bin gone). */
  prune(owner) {
    const now = this.now();
    for (const [id, item] of owner.uploads) {
      if (item.state === "writing") continue;
      if (item.expires < now) this.remove(owner, id);
      else if (item.state === "ready" && !fs.existsSync(this.file(id, "bin"))) {
        owner.uploads.delete(id);
        this.items.delete(id);
        this.removeFiles(id);
      }
    }
  }

  /**
   * Deletes what nobody can use any more: a .part without a live writer, and .bin/.json past their expiry (from the
   * meta file, else the file's age). Entries of a send in flight are never touched.
   */
  sweep() {
    this.prune(this.desktop);
    for (const more of this.sweepers) {
      try {
        more();
      } catch {
        /* one sweep failing never stops the other */
      }
    }
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const now = this.now();
    const expired = new Set();
    for (const name of names) {
      const m = ENTRY_RE.exec(name);
      if (!m) continue;
      const [, id, ext] = m;
      if (this.inflight.has(id)) continue;
      const live = this.items.get(id);
      if (ext === "part" || ext === "json.tmp") {
        if (!live || live.state !== "writing") this.unlink(name);
        continue;
      }
      let expires = live && live.state === "ready" ? live.expires : null;
      if (expires === null) {
        try {
          expires = this.readMeta(id).expires;
        } catch {
          expires = null;
        }
      }
      if (!Number.isFinite(expires)) {
        try {
          expires = fs.lstatSync(path.join(this.dir, name)).mtimeMs + this.ttlMs;
        } catch {
          continue;
        }
      }
      if (expires < now) expired.add(id);
    }
    for (const id of expired) {
      this.items.delete(id);
      this.desktop.uploads.delete(id);
      this.removeFiles(id);
    }
  }

  unlink(name) {
    try {
      fs.unlinkSync(path.join(this.dir, name));
    } catch {
      /* gone already */
    }
  }

  /** Sweep now (relay start) and every few minutes. */
  start() {
    try {
      this.ensureDir();
    } catch (e) {
      console.warn(`deck-relay: upload folder ${this.dir} unavailable (${e.code || e.message}); large attachments are off`);
    }
    this.sweep();
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const item of this.items.values()) if (item.abort) item.abort();
  }

  /**
   * Desktop routes (relay token only; server.js refuses mobile tokens before this):
   *   POST /uploads {name, mime, size} -> {id}; PUT /uploads/<id> raw body -> {id, name, size}; DELETE /uploads/<id>.
   * True when it answered.
   */
  onHttp(req, res, url) {
    const match = /^\/uploads(?:\/([a-f0-9]{48}))?$/.exec(url.pathname);
    if (!match) return false;
    this.handle(req, res, match[1] || null).catch((error) => {
      if (res.headersSent) return res.destroy();
      settleBody(req, res);
      sendJson(res, error.status || 500, { error: { code: error.code || "upload_error", message: error.message } });
    });
    return true;
  }

  async handle(req, res, id) {
    const owner = this.desktop;
    if (!id && req.method === "POST") {
      const item = this.create(owner, await readObject(req));
      return sendJson(res, 200, { id: item.id });
    }
    if (id && req.method === "PUT") {
      const item = await this.write(owner, this.get(owner, id), req);
      return sendJson(res, 200, { id: item.id, name: item.name, size: item.size });
    }
    if (id && req.method === "DELETE") {
      req.resume();
      this.remove(owner, id);
      return sendJson(res, 200, { ok: true });
    }
    req.resume();
    throw fail("method", "Method not allowed", 405);
  }
}

module.exports = { UploadSpool, uploadConfig, machineId, hostIdFrom, newOwner, readObject, settleBody, DEFAULTS, LEGACY, TTL_MS, ID_RE };
