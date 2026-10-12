"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
const { EventEmitter } = require("events");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { Readable } = require("stream");
const WebSocket = require("ws");

const UPLOAD_ID_RE = /^[a-f0-9]{48}$/;
const UPLOAD_IDLE_MS = 120000; // an upload that moves no byte for this long fails (the relay drops it as well)

/** The hello's `uploads` ({v: 1, host, files, fileBytes, totalBytes}: the relay's disk spool, relay/src/uploads.js), or null. */
function helloUploads(u) {
  const n = (v) => Number.isSafeInteger(v) && v > 0;
  return u && typeof u === "object" && u.v === 1 && typeof u.host === "string" && /^[a-f0-9]{16}$/.test(u.host) && n(u.files) && n(u.fileBytes) && n(u.totalBytes)
    ? { v: 1, host: u.host, files: u.files, fileBytes: u.fileBytes, totalBytes: u.totalBytes }
    : null;
}

/** An upload failure the caller can tell apart from a Hermes error: {relayUpload: true, status, code}. */
const uploadError = (message, extra = {}) => Object.assign(new Error(message), { relayUpload: true, ...extra });

/**
 * WebSocket client for deck-relay. Reconnects with backoff; every relay push
 * ({t: hello|snapshot|evs|fleet|agents}) is re-emitted as "msg". Status changes are emitted as "status".
 */
class RelayClient extends EventEmitter {
  /** @param {{url: string, token: string}} opts url like ws://100.64.0.10:9330 */
  constructor({ url, token }) {
    super();
    this.wsUrl = `${url.replace(/\/+$/, "")}/events`;
    this.httpBase = url.replace(/^ws/i, "http").replace(/\/+$/, "");
    this.token = token;
    this.backoff = 1000;
    this.ws = null;
    this.timer = null;
    this.stopped = false;
    this.lastError = null;
    this.uploads = null; // the current connection's hello `uploads` (large attachments), else null
  }

  /** True while the WebSocket is open. */
  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  start() {
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.ws) this.ws.terminate();
  }

  /** Ask the relay for a fresh snapshot (renderer reload). */
  resync() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "resync" }));
  }

  /** Workspace tab: send a heartbeat (object) or a CDP tunnel frame (Buffer). False when not connected. */
  send(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if (Buffer.isBuffer(data)) this.ws.send(data, { binary: true });
    else this.ws.send(typeof data === "string" ? data : JSON.stringify(data));
    return true;
  }

  _connect() {
    if (this.stopped) return;
    this.emit("status", { status: "connecting" });
    const ws = new WebSocket(this.wsUrl, {
      headers: { authorization: `Bearer ${this.token}` },
      handshakeTimeout: 8000,
    });
    this.ws = ws;
    ws.on("open", () => {
      this.backoff = 1000;
      this.lastError = null;
      this.emit("status", { status: "open" });
    });
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return this.emit("frame", raw); // Workspace tab: CDP tunnel frames (cdp-tunnel.js)
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m && m.t === "hello") this.uploads = helloUploads(m.uploads);
      this.emit("msg", m);
    });
    ws.on("unexpected-response", (_req, res) => {
      this.lastError = res.statusCode === 401 ? i18nText("A0162") : `HTTP ${res.statusCode}`;
    });
    ws.on("error", (e) => {
      this.lastError = e.code || e.message;
    });
    ws.on("close", () => {
      if (this.ws === ws) this.uploads = null;
      if (this.stopped) return;
      const wait = this.backoff;
      this.emit("status", { status: "closed", error: this.lastError, retryInMs: wait });
      this.timer = setTimeout(() => this._connect(), wait);
      this.backoff = Math.min(this.backoff * 2, 30000);
    });
  }

  async get(path) {
    const r = await fetch(`${this.httpBase}${path}`, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`relay ${path}: HTTP ${r.status}`);
    return r.json();
  }

  /** The Plan tab: {sid, plan, stored} for one session (GET /session/<sid>/plan); plan null when none was published. */
  async plan(sid) {
    if (typeof sid !== "string" || !/^[\x21-\x7e]{1,512}$/.test(sid)) throw new Error("relay plan: bad session id");
    try {
      return await this.get(`/session/${encodeURIComponent(sid)}/plan`);
    } catch (e) {
      if (/HTTP 404$/.test(String(e && e.message))) return { sid, plan: null, stored: false }; // unknown, or an older relay
      throw e;
    }
  }

  /**
   * One JSON request that keeps the relay's own error text (Settings > Hermes config): resolves {status, body}; only a
   * network failure or timeout rejects. `body` undefined sends none.
   */
  async call(method, path, body, timeoutMs = 10000) {
    const r = await fetch(`${this.httpBase}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, body: data && typeof data === "object" ? data : {} };
  }

  /** POST with an empty JSON body. `timeoutMs` covers relay-side waits (quota refresh waits for the plugins). */
  async post(path, timeoutMs = 10000) {
    const r = await fetch(`${this.httpBase}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`relay ${path}: HTTP ${r.status}`);
    return r.json();
  }

  /**
   * Large attachments: streams one file into the relay's disk spool (POST /uploads, then PUT /uploads/<id>) and
   * resolves {id}. `source` is {path} (read with fs.createReadStream, never whole) or {buffer} (pasted bytes), plus
   * {name, mime, size}. onProgress(fraction) follows the bytes handed to the socket; `signal` cancels, and a failed or
   * cancelled upload is deleted on the relay. The token stays here, in main.
   */
  async upload(source, { onProgress = null, signal = null } = {}) {
    if (signal && signal.aborted) throw uploadError("canceled", { code: "canceled" });
    const created = await this.call("POST", "/uploads", { name: source.name, mime: source.mime, size: source.size }, 15000);
    const id = created.body && created.body.id;
    if (created.status !== 200 || typeof id !== "string" || !UPLOAD_ID_RE.test(id)) {
      const e = created.body && created.body.error;
      throw uploadError((e && e.message) || `HTTP ${created.status}`, { status: created.status, code: (e && e.code) || "upload_error" });
    }
    try {
      await this._put(id, source, { onProgress, signal });
    } catch (err) {
      this.deleteUpload(id).catch(() => {});
      throw err;
    }
    return { id };
  }

  /** Cancels or cleans one upload on the relay (also mid-write). */
  async deleteUpload(id) {
    if (typeof id !== "string" || !UPLOAD_ID_RE.test(id)) return false;
    const r = await this.call("DELETE", `/uploads/${id}`, undefined, 10000);
    return r.status === 200;
  }

  _put(id, { path: file, buffer, size }, { onProgress, signal }) {
    const url = new URL(`${this.httpBase}/uploads/${id}`);
    const mod = url.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      let settled = false;
      let sent = 0;
      let body = null;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener("abort", onAbort);
        if (err && body && !body.destroyed) body.destroy(); // an early answer (409, 507, cancel) stops the reading
        if (err) reject(err);
        else resolve(value);
      };
      const req = mod.request(url, { method: "PUT", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/octet-stream", "content-length": size } });
      const onAbort = () => req.destroy(uploadError("canceled", { code: "canceled" }));
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      req.setTimeout(UPLOAD_IDLE_MS, () => req.destroy(uploadError("timeout", { code: "timeout" })));
      req.on("response", (res) => {
        const parts = [];
        res.on("data", (d) => parts.length < 64 && parts.push(d));
        res.on("end", () => {
          let answer = {};
          try { answer = JSON.parse(Buffer.concat(parts).toString() || "{}"); } catch { answer = {}; }
          if (res.statusCode === 200 && answer.id === id) return finish(null, answer);
          const e = answer && answer.error && typeof answer.error === "object" ? answer.error : {};
          finish(uploadError(e.message || `HTTP ${res.statusCode}`, { status: res.statusCode, code: e.code || "upload_error" }));
        });
        res.on("error", (e) => finish(uploadError(e.message, { code: "network" })));
      });
      req.on("error", (e) => finish(e && e.relayUpload ? e : uploadError((e && e.message) || "network", { code: signal && signal.aborted ? "canceled" : "network" })));
      // a path is streamed (at most `size` bytes: a file that grew is cut, one that shrank fails on the relay's size check)
      body = buffer ? Readable.from([buffer]) : fs.createReadStream(file, { start: 0, end: Math.max(0, size - 1), highWaterMark: 1024 * 1024 });
      body.on("data", (chunk) => {
        sent += chunk.length;
        if (onProgress) onProgress(Math.min(1, sent / size));
      });
      body.on("error", (e) => req.destroy(uploadError(e.message, { code: e.code || "read" })));
      body.pipe(req); // backpressure: the file is read only as fast as the socket takes it
    });
  }
}

module.exports = { RelayClient, helloUploads };
