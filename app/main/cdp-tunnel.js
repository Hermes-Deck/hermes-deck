"use strict";
// Deck end of the relay's CDP tunnel (Workspace tab, D2). Hermes runs on the relay host; the relay
// carries each of its CDP websockets over this deck's own outbound, token-authenticated relay
// connection, so this computer opens no inbound port. Only this deck's agent browsers are reachable:
// every request is checked, and sockets only ever go to 127.0.0.1:<port of an agent browser this deck
// launched>, never to Hermes Deck's own window (Electron's DevTools port is never opened).
// Nothing happens unless the user allowed agent browsers on this device (Settings > This device).
// Pure Node (no electron import). Framing must match relay/src/cdp.js.
// Each agent socket is read by an AgentTracker (cdp-view.js): which page a command acts on, and whether it
// is real use; the host passes that on to the live view, which follows the agent.
const WebSocket = require("ws");
const { AgentTracker, USER_ONLY, USER_ONLY_HTTP, BLOCKED } = require("./cdp-view");

// ---- framing (same bytes as relay/src/cdp.js) ----------------------------------------------------
const MAGIC = 0xcd;
const OP = Object.freeze({ OPEN: 1, OPENED: 2, DATA: 3, CLOSE: 4, HTTP: 5, HTTP_RES: 6 });
const HEADER = 6;

function encodeFrame(op, ch, payload) {
  const body =
    payload === undefined || payload === null
      ? Buffer.alloc(0)
      : Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  const head = Buffer.allocUnsafe(HEADER);
  head[0] = MAGIC;
  head[1] = op;
  head.writeUInt32BE(ch >>> 0, 2);
  return Buffer.concat([head, body], HEADER + body.length);
}

function decodeFrame(data) {
  const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
  if (buf.length < HEADER || buf[0] !== MAGIC || buf[1] < OP.OPEN || buf[1] > OP.HTTP_RES) return null;
  return { op: buf[1], ch: buf.readUInt32BE(2), payload: buf.subarray(HEADER) };
}

function frameJson(payload) {
  try {
    const v = JSON.parse(payload.toString("utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// ---- what the relay may ask for ------------------------------------------------------------------
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HTTP_RE = /^\/json(?:\/(?:version|list|protocol|new|activate\/[\w.-]{1,128}|close\/[\w.-]{1,128}))?(?:\?[^#\s]*)?$/;
const SOCKET_RE = /^\/devtools\/(browser|page)\/([\w.-]{1,128})$/;
// USER_ONLY / BLOCKED (cdp-view.js): while the user holds control the agent can still read the page, but
// not click, type or navigate.

// The agent browser runs on the user's own computer: agents get the browser, not the computer. No local
// files (file:// and browser-internal pages, file pickers, dragged local paths), downloads only into the
// agent's own folder, no CDP handed to web pages, no extensions, installed web apps or port bindings.
// Target.sendMessageToTarget is the legacy (non-flat) attach transport: it carries a whole CDP command
// as an opaque `message` string, so the inner method never reaches this guard and a blocked command
// (Page.navigate to file://, DOM.setFileInputFiles, ...) would ride through unchecked. It is refused;
// flattened sessions (flatten:true) are required instead, and their every command arrives here as its
// own guarded top-level frame. Browser.grantPermissions/setPermission could hand a page the camera,
// microphone or geolocation of the user's machine with no prompt, so they are refused too.
const DEVICE_ONLY = /^(?:DOM\.setFileInputFiles|Page\.handleFileChooser|Target\.(?:exposeDevToolsProtocol|setRemoteLocations|sendMessageToTarget)|Browser\.(?:grantPermissions|setPermission)|Extensions\.\w+|PWA\.\w+|Tethering\.\w+)$/;
// Attaching without flatten:true opens a hidden sub-session driven through Target.sendMessageToTarget.
const FLATTEN_ONLY = new Set(["Target.attachToTarget", "Target.setAutoAttach"]);
const URL_PARAM = { "Page.navigate": "url", "Target.createTarget": "url", "Network.loadNetworkResource": "url" };
const SAFE_SCHEMES = new Set(["http:", "https:", "about:", "data:", "blob:", "javascript:"]);
const PROTECTED = "Hermes Deck: not available in an agent browser; it runs on the user's computer and keeps the computer's files, apps and ports out of reach.";

/** A URL an agent may open on the user's computer (parsed like a browser would, so no "fi\tle:" tricks). */
function safeUrl(u) {
  if (u === "") return true;
  try {
    return SAFE_SCHEMES.has(new URL(u).protocol);
  } catch {
    return false;
  }
}

/** null when the command may go to the browser (it may adjust params), else the refusal message. */
function deviceGuard(msg, downloadDir) {
  const m = msg.method;
  const p = msg.params && typeof msg.params === "object" ? msg.params : null;
  if (DEVICE_ONLY.test(m)) return PROTECTED;
  if (FLATTEN_ONLY.has(m) && (!p || p.flatten !== true)) return `${PROTECTED} Attach sessions with flatten:true.`;
  if (URL_PARAM[m] && p && typeof p[URL_PARAM[m]] === "string" && !safeUrl(p[URL_PARAM[m]])) return `${PROTECTED} Only http(s), about:, data: and blob: URLs open here.`;
  if (m === "Input.dispatchDragEvent" && p && p.data && Array.isArray(p.data.files) && p.data.files.length) return PROTECTED;
  if ((m === "Browser.setDownloadBehavior" || m === "Page.setDownloadBehavior") && p && (p.downloadPath !== undefined || /^allow/.test(String(p.behavior)))) {
    p.downloadPath = downloadDir; // the agent's own folder, whatever path it asked for
  }
  return null;
}

/** /json/new?<url>: the same URL rule as Target.createTarget. */
function safeHttpPath(p) {
  const m = /^\/json\/new\/?\?(.*)$/.exec(p);
  if (!m) return true;
  try {
    return safeUrl(decodeURIComponent(m[1]));
  } catch {
    return false;
  }
}

/**
 * @param {object} o
 * @param {object} o.host  AgentBrowserHost-like: enabled(), ensure(slug) -> {port, wsPath}, controller(slug),
 *                         downloadDir(slug), channelOpened(slug, kind), channelClosed(slug, kind),
 *                         noteAgent(slug, method), touch(slug)
 * @param {(frame: Buffer) => boolean} o.send  writes one binary frame to the relay connection
 */
class CdpTunnel {
  constructor({ host, send }) {
    this.host = host;
    this.sendRaw = send;
    this.chans = new Map(); // ch -> {ch, slug, kind, ws, queue, open, closed}
  }

  _send(op, ch, payload) {
    try {
      return this.sendRaw(encodeFrame(op, ch, payload));
    } catch {
      return false;
    }
  }

  onFrame(data) {
    const f = decodeFrame(data);
    if (!f) return;
    if (f.op === OP.HTTP) this._http(f.ch, frameJson(f.payload) || {});
    else if (f.op === OP.OPEN) this._open(f.ch, frameJson(f.payload) || {});
    else if (f.op === OP.DATA) this._data(f.ch, f.payload);
    else if (f.op === OP.CLOSE) {
      const c = this.chans.get(f.ch);
      if (c) this._drop(c, 1000, "closed by the relay", false);
    }
  }

  /** The relay connection is gone (its channels died with it), or hosting was switched off (notify). */
  closeAll(reason, notify = false) {
    for (const c of [...this.chans.values()]) this._drop(c, 1001, reason, notify);
  }

  get size() {
    return this.chans.size;
  }

  async _http(ch, req) {
    const reply = (status, body, type = "application/json; charset=UTF-8") => this._send(OP.HTTP_RES, ch, { status, type, body });
    const slug = String(req.slug || "");
    const p = String(req.path || "");
    if (!this.host.enabled()) return reply(503, JSON.stringify({ error: "agent browsers are switched off on this device" }));
    if (!SLUG_RE.test(slug) || !HTTP_RE.test(p)) return reply(400, JSON.stringify({ error: "bad request" }));
    if (!safeHttpPath(p)) return reply(403, JSON.stringify({ error: PROTECTED }));
    if (this.host.peek?.(slug)?.transferring) return reply(409, JSON.stringify({ error: "browser transfer in progress" }));
    // while the user holds control the agent may not open, close or bring forward a tab over HTTP either
    if (this.host.controller(slug) === "user" && USER_ONLY_HTTP.test(p)) return reply(409, JSON.stringify({ error: BLOCKED }));
    let b;
    try {
      b = await this.host.ensure(slug);
    } catch (e) {
      return reply(503, JSON.stringify({ error: `the agent browser did not start: ${e.message}` }));
    }
    try {
      // the wait for a starting browser (agent-browser.js WAIT_MS) + this fetch stay inside the relay's 25 s wait
      const r = await fetch(`http://127.0.0.1:${b.port}${p}`, { method: req.method === "PUT" ? "PUT" : "GET", signal: AbortSignal.timeout(8_000) });
      reply(r.status, await r.text(), r.headers.get("content-type") || undefined);
      this.host.touch(slug);
    } catch (e) {
      reply(502, JSON.stringify({ error: String(e.message || e) }));
    }
  }

  async _open(ch, req) {
    const refuse = (reason) => this._send(OP.CLOSE, ch, { code: 1011, reason: String(reason).slice(0, 120) });
    const slug = String(req.slug || "");
    const kind = req.kind === "viewer" ? "viewer" : "agent";
    const m = SOCKET_RE.exec(String(req.path || ""));
    if (!this.host.enabled()) return refuse("agent browsers are switched off on this device");
    if (!SLUG_RE.test(slug) || !m) return refuse("bad path");
    if (this.chans.has(ch)) return refuse("channel already open");
    const c = { ch, slug, kind, ws: null, queue: [], open: false, closed: false, track: kind === "agent" ? new AgentTracker(m[1] === "page" ? m[2] : null) : null };
    this.chans.set(ch, c);
    let b;
    try {
      b = await this.host.ensure(slug);
    } catch (e) {
      this.chans.delete(ch);
      c.closed = true;
      return refuse(`the agent browser did not start: ${e.message}`);
    }
    if (c.closed) return; // the relay gave up while the browser was starting
    // any browser id means this agent's current browser: a restart since discovery must not strand it
    const target = m[1] === "browser" ? b.wsPath : `/devtools/page/${m[2]}`;
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}${target}`, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024, handshakeTimeout: 10_000 });
    c.ws = ws;
    ws.on("open", () => {
      if (c.closed) return ws.close();
      c.open = true;
      this._send(OP.OPENED, ch);
      this.host.channelOpened(slug, kind);
      for (const buf of c.queue) this._toBrowser(c, buf);
      c.queue = [];
    });
    ws.on("message", (data) => {
      const made = c.track ? c.track.reply(data) : null; // the agent opened a page: the view may follow it
      if (made) this.host.noteAgent(slug, "Target.createTarget", { use: true, ...made });
      this._send(OP.DATA, ch, data);
    });
    ws.on("close", (code, reason) => this._drop(c, code, String(reason || "") || "browser closed the socket", true));
    ws.on("error", () => {}); // "close" follows
  }

  _data(ch, payload) {
    const c = this.chans.get(ch);
    if (!c || c.closed) return;
    if (!c.open) c.queue.push(payload);
    else this._toBrowser(c, payload);
  }

  /** Everything from the relay is checked; what reaches Chrome is the re-serialized message we checked. */
  _toBrowser(c, buf) {
    let msg;
    try {
      msg = JSON.parse(buf.toString("utf8"));
    } catch {
      return; // not a CDP command: Chrome would only answer with a parse error
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string") return;
    const refuse = (message) => {
      const err = { id: msg.id, error: { code: -32000, message } };
      if (typeof msg.sessionId === "string") err.sessionId = msg.sessionId;
      this._send(OP.DATA, c.ch, JSON.stringify(err));
    };
    const no = deviceGuard(msg, this.host.downloadDir(c.slug));
    if (no) return refuse(no);
    if (c.kind === "agent") {
      if (this.host.peek?.(c.slug)?.transferring) return refuse("browser transfer in progress");
      if (this.host.controller(c.slug) === "user" && USER_ONLY.test(msg.method)) {
        this.host.noteAgent(c.slug, msg.method, { use: true, act: null, targetId: null }); // tried: still counts as use
        return refuse(BLOCKED);
      }
      this.host.noteAgent(c.slug, msg.method, c.track.command(msg));
    }
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }

  _drop(c, code, reason, notify) {
    if (c.closed) return;
    c.closed = true;
    this.chans.delete(c.ch);
    if (c.open) this.host.channelClosed(c.slug, c.kind);
    c.open = false;
    if (notify) this._send(OP.CLOSE, c.ch, { code, reason: String(reason || "").slice(0, 120) });
    if (c.ws) {
      if (c.ws.readyState === WebSocket.CONNECTING) c.ws.terminate();
      else if (c.ws.readyState === WebSocket.OPEN) c.ws.close();
    }
  }
}

module.exports = { CdpTunnel, OP, MAGIC, encodeFrame, decodeFrame, frameJson, USER_ONLY, USER_ONLY_HTTP, BLOCKED, deviceGuard, safeUrl, PROTECTED };
