"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
const { EventEmitter } = require("events");
const WebSocket = require("ws");

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
      this.emit("msg", m);
    });
    ws.on("unexpected-response", (_req, res) => {
      this.lastError = res.statusCode === 401 ? i18nText("A0162") : `HTTP ${res.statusCode}`;
    });
    ws.on("error", (e) => {
      this.lastError = e.code || e.message;
    });
    ws.on("close", () => {
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
}

module.exports = { RelayClient };
