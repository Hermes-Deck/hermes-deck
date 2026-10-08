"use strict";
// CDP gateway for Hermes (Workspace tab, D2). Hermes on this machine points its browser tool at
//   http://127.0.0.1:<DECK_CDP_PORT>/agent/<profile>      (browser.cdp_url or BROWSER_CDP_URL)
// and does the usual /json/version discovery there. presence.js picks the agent's host (the deck the
// user is on, or the relay host's fallback browser); every CDP websocket is then carried over that
// deck's own outbound, token-authenticated relay connection, so a desktop opens no inbound port.
//
// Tunnel frames: binary messages on a deck's relay WebSocket (keep in sync with app/main/cdp-tunnel.js)
//   [0xCD][op u8][channel u32 BE][payload]
//   OPEN 1      relay -> deck  {slug, path, kind}       open a CDP socket to that agent's browser
//   OPENED 2    deck -> relay  {}
//   DATA 3      both ways      one CDP message, UTF-8 JSON text, passed through untouched
//   CLOSE 4     both ways      {code, reason}
//   HTTP 5      relay -> deck  {slug, method, path}     discovery: /json/version, /json/list, ...
//   HTTP_RES 6  deck -> relay  {status, type, body}
// Channel ids are allocated by the relay only.
const http = require("http");
const { EventEmitter } = require("events");
const { WebSocketServer } = require("ws");

// ---- framing -------------------------------------------------------------------------------------
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

/** {op, ch, payload: Buffer} or null for anything that is not a tunnel frame. */
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

// ---- paths and discovery rewriting -----------------------------------------------------------------
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DISCOVERY_RE = /^\/json(?:\/(?:version|list|protocol|new|activate\/[\w.-]{1,128}|close\/[\w.-]{1,128}))?\/?$/;
const SOCKET_RE = /^\/devtools\/(?:browser|page)\/[\w.-]{1,128}$/;
const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
const LOCAL_WS_RE = /^wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+(\/devtools\/(?:browser|page)\/[\w.-]+)$/;
const FRONTEND_WS_RE = /([?&]wss?=)(?:127\.0\.0\.1|localhost|\[::1\]):\d+(\/devtools\/)/;

/** "/agent/<slug>/json/version" -> {slug, rest: "/json/version"}; bare paths belong to defaultSlug. */
function parseCdpPath(pathname, defaultSlug) {
  let slug = defaultSlug;
  let rest = pathname;
  const m = /^\/agent\/([^/]+)(\/.*)?$/.exec(pathname);
  if (m) {
    try {
      slug = decodeURIComponent(m[1]).toLowerCase();
    } catch {
      return null;
    }
    rest = m[2] || "/";
  }
  if (!slug || !SLUG_RE.test(slug)) return null;
  return { slug, rest };
}

/**
 * Point every websocket URL in a discovery answer at this gateway (ws://<host>/agent/<slug>/devtools/...),
 * so the client never sees, or needs, the browser's own port. Bodies that are not JSON pass through.
 */
function rewriteDiscovery(body, { host, slug }) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return body;
  }
  const prefix = `/agent/${slug}`;
  const fix = (t) => {
    if (!t || typeof t !== "object") return;
    if (typeof t.webSocketDebuggerUrl === "string") {
      const m = LOCAL_WS_RE.exec(t.webSocketDebuggerUrl);
      if (m) t.webSocketDebuggerUrl = `ws://${host}${prefix}${m[1]}`;
      else delete t.webSocketDebuggerUrl;
    }
    if (typeof t.devtoolsFrontendUrl === "string") t.devtoolsFrontendUrl = t.devtoolsFrontendUrl.replace(FRONTEND_WS_RE, `$1${host}${prefix}$2`);
  };
  if (Array.isArray(data)) data.forEach(fix);
  else fix(data);
  return JSON.stringify(data);
}

const httpError = (status, message) => Object.assign(new Error(message), { status });
const wsCode = (c) => (c === 1000 || c === 1001 || c === 1002 || c === 1003 || (c >= 1007 && c <= 1014) || (c >= 3000 && c <= 4999) ? c : 1011);

// ---- one CDP socket, whatever carries it -------------------------------------------------------------
/**
 * A CDP socket between a client (Hermes) and an agent browser, carried by a transport ({send(buf),
 * close(code, reason)}). Browser messages that arrive before the client is attached are queued.
 * Emits "close" once, from either side.
 */
class Channel extends EventEmitter {
  constructor(id, transport) {
    super();
    this.id = id;
    this.t = transport;
    this.queue = [];
    this.sink = null;
    this.done = false;
  }

  attach(onData, onClose) {
    this.sink = { onData, onClose };
    for (const b of this.queue) onData(b);
    this.queue = [];
    if (this.done && this.endedBy) onClose(this.endedBy.code, this.endedBy.reason);
  }

  /** browser -> client */
  push(buf) {
    if (this.done) return;
    if (this.sink) this.sink.onData(buf);
    else this.queue.push(buf);
  }

  /** client -> browser */
  send(buf) {
    if (!this.done) this.t.send(buf);
  }

  /** The client went away: tell the browser side. */
  close(code = 1000, reason = "") {
    if (this.done) return;
    this.done = true;
    this.t.close(code, reason);
    this.emit("close", code, reason);
  }

  /** The browser side went away: tell the client. */
  ended(code = 1000, reason = "") {
    if (this.done) return;
    this.done = true;
    this.endedBy = { code, reason };
    if (this.sink) this.sink.onClose(code, reason);
    this.emit("close", code, reason);
  }

  /** Cut both sides (the agent's browser moved, the gateway stops). */
  kill(code = 1001, reason = "") {
    if (this.done) return;
    this.done = true;
    this.endedBy = { code, reason };
    this.t.close(code, reason);
    if (this.sink) this.sink.onClose(code, reason);
    this.emit("close", code, reason);
  }
}

// ---- the tunnel over one deck's relay connection -----------------------------------------------------
class DeckLink {
  constructor(conn, gw) {
    this.conn = conn;
    this.gw = gw;
    this.pending = new Map(); // ch -> {kind, resolve, reject, timer, chan?}
    this.chans = new Map(); // ch -> Channel
    this.dead = false;
  }

  _send(op, ch, payload) {
    if (this.dead || this.conn.readyState !== 1) return false;
    this.conn.send(encodeFrame(op, ch, payload), { binary: true });
    return true;
  }

  _wait(kind, ch, extra) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(ch);
        if (kind === "open") this._send(OP.CLOSE, ch, { code: 1011, reason: "open timed out" });
        reject(httpError(504, "the agent's device did not answer in time"));
      }, this.gw.timeoutMs);
      this.pending.set(ch, { kind, resolve, reject, timer, ...extra });
    });
  }

  http(slug, { method, path }) {
    const ch = this.gw.nextId();
    const p = this._wait("http", ch);
    if (!this._send(OP.HTTP, ch, { slug, method, path })) this._settle(ch, null, httpError(502, "the agent's device is not connected"));
    return p;
  }

  open(slug, path, kind = "agent") {
    const ch = this.gw.nextId();
    const chan = new Channel(ch, {
      send: (buf) => this._send(OP.DATA, ch, buf),
      close: (code, reason) => {
        this.chans.delete(ch);
        this._send(OP.CLOSE, ch, { code, reason: String(reason || "").slice(0, 120) });
      },
    });
    const p = this._wait("open", ch, { chan });
    if (!this._send(OP.OPEN, ch, { slug, path, kind })) this._settle(ch, null, httpError(502, "the agent's device is not connected"));
    return p;
  }

  _settle(ch, value, err) {
    const p = this.pending.get(ch);
    if (!p) return;
    this.pending.delete(ch);
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(value);
  }

  onFrame({ op, ch, payload }) {
    const p = this.pending.get(ch);
    if (p) {
      if (op === OP.HTTP_RES && p.kind === "http") {
        const m = frameJson(payload) || {};
        const status = Number.isInteger(m.status) && m.status >= 100 && m.status < 600 ? m.status : 502;
        this._settle(ch, { status, type: typeof m.type === "string" ? m.type : null, body: typeof m.body === "string" ? m.body : "" });
      } else if (op === OP.OPENED && p.kind === "open") {
        this.chans.set(ch, p.chan);
        this._settle(ch, p.chan);
      } else if (op === OP.CLOSE) {
        const m = frameJson(payload) || {};
        this._settle(ch, null, httpError(502, String(m.reason || "the agent's device refused the connection").slice(0, 200)));
      }
      return;
    }
    const chan = this.chans.get(ch);
    if (!chan) return;
    if (op === OP.DATA) chan.push(payload);
    else if (op === OP.CLOSE) {
      this.chans.delete(ch);
      const m = frameJson(payload) || {};
      chan.ended(Number(m.code) || 1000, String(m.reason || ""));
    }
  }

  closeAll(code, reason) {
    this.dead = true;
    for (const ch of [...this.pending.keys()]) this._settle(ch, null, httpError(502, reason));
    for (const chan of this.chans.values()) chan.ended(code, reason);
    this.chans.clear();
  }
}

// ---- routing + the Hermes-facing endpoint -------------------------------------------------------------
/**
 * Decks register their relay connections here; presence decides where each agent's browser lives.
 * `fallback` is the relay host's own browser (browser.js) or null.
 */
class CdpGateway {
  constructor({ presence, fallback = null, timeoutMs = 25_000 }) {
    this.presence = presence;
    this.fallback = fallback;
    this.timeoutMs = timeoutMs;
    this.links = new Map(); // relay connection -> DeckLink
    this.live = new Set(); // {chan, route}
    this._id = 0;
    // a route that moved (handoff) or whose device is gone (disconnected, hosting switched off) cuts the
    // agent's sockets to the old host; the agent reconnects and lands on the new one
    presence.on("route", ({ old, why }) => {
      if (!old || (why !== "handoff" && why !== "lost")) return;
      const reason = why === "handoff" ? "the agent's browser moved to another device" : "the agent's device is no longer available";
      for (const x of [...this.live]) if (x.route === old) x.chan.kill(1012, reason);
    });
  }

  nextId() {
    this._id = this._id >= 0xfffffffe ? 1 : this._id + 1;
    return this._id;
  }

  addDeck(conn) {
    if (!this.links.has(conn)) this.links.set(conn, new DeckLink(conn, this));
  }

  removeDeck(conn) {
    const l = this.links.get(conn);
    if (!l) return;
    this.links.delete(conn);
    l.closeAll(1001, "the agent's device disconnected");
  }

  onFrame(conn, data) {
    const l = this.links.get(conn);
    const f = l && decodeFrame(data);
    if (f) l.onFrame(f);
  }

  _route(slug) {
    const r = this.presence.routeFor(slug, "browser");
    if (!r) {
      // the user pinned this agent's browser to one place (Workspace tab) and that place cannot host now
      const pin = this.presence.pinOf(slug, "browser");
      // no device name here: this text reaches the agent's context (and its model provider)
      if (pin && pin.kind === "device") throw httpError(503, "no workspace: the user pinned this agent's browser to one of their computers (Hermes Deck, Workspace tab), which is offline or has agent browsers switched off. Ask the user.");
      if (pin) throw httpError(503, "no workspace: the user pinned this agent's browser to the agent host, but no browser is set up there for this agent (relay .env DECK_FALLBACK_BROWSER / DECK_FALLBACK_BROWSER_CDP). Ask the user.");
      throw httpError(503, "no workspace: this relay has no agent host browser for this agent and no Hermes Deck allows agent browsers right now");
    }
    const t = r.host.kind === "fallback" ? this.fallback : this.links.get(this.presence.connOf(r.host.id));
    if (!t) throw httpError(502, "the agent's device is not reachable");
    return { r, t };
  }

  async http(slug, req) {
    const { r, t } = this._route(slug);
    this.presence.touch(r);
    return t.http(slug, req);
  }

  async open(slug, path) {
    const { r, t } = this._route(slug);
    this.presence.opened(r);
    let chan;
    try {
      chan = await t.open(slug, path, "agent");
    } catch (e) {
      this.presence.closed(r);
      throw e;
    }
    const x = { chan, route: r };
    this.live.add(x);
    chan.once("close", () => {
      this.live.delete(x);
      this.presence.closed(r);
    });
    chan.touch = () => this.presence.touch(r);
    return chan;
  }

  stop() {
    for (const x of [...this.live]) x.chan.kill(1001, "relay stopping");
    for (const l of this.links.values()) l.closeAll(1001, "relay stopping");
    this.links.clear();
  }
}

const STATUS = { 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" };

function deny(socket, code, msg = "") {
  const body = String(msg || STATUS[code] || "error").slice(0, 300);
  try {
    socket.end(`HTTP/1.1 ${code} ${STATUS[code] || "Error"}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  } catch {
    socket.destroy();
  }
}

const isLoopback = (addr) => addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";

/**
 * Hermes-facing CDP endpoint. Listen on 127.0.0.1 only. Requests must come from this machine with a
 * loopback Host header (no DNS rebinding) and websocket upgrades must carry no Origin (no web page),
 * like Chrome's own debugging port.
 *   GET|PUT /agent/<slug>/json[/version|/list|/new|/activate/<id>|/close/<id>|/protocol]
 *   WS      /agent/<slug>/devtools/browser/<id> | /agent/<slug>/devtools/page/<id>
 * Paths without /agent/<slug> belong to `defaultSlug`.
 */
function createCdpServer({ gateway, defaultSlug = "default" }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024, perMessageDeflate: false });
  const clients = new Set();
  const hostOf = () => `127.0.0.1:${server.address().port}`;

  const reply = (res, code, body, type = "application/json; charset=UTF-8") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  async function onHttp(req, res) {
    if (!isLoopback(req.socket.remoteAddress) || !LOOPBACK_HOST_RE.test(req.headers.host || "")) return reply(res, 403, { error: "forbidden" });
    let url;
    try {
      url = new URL(req.url, "http://cdp");
    } catch {
      return reply(res, 400, { error: "bad url" });
    }
    const p = parseCdpPath(url.pathname, defaultSlug);
    if (!p || !DISCOVERY_RE.test(p.rest)) return reply(res, 404, { error: "not found" });
    if (req.method !== "GET" && req.method !== "PUT") return reply(res, 405, { error: "method not allowed" });
    const rest = p.rest.length > 5 ? p.rest.replace(/\/$/, "") : "/json"; // "/json/version/" -> "/json/version"
    const r = await gateway.http(p.slug, { method: req.method, path: rest + url.search });
    const body = /^\/json(?:\/(?:version|list|new))?$/.test(rest) ? rewriteDiscovery(r.body, { host: hostOf(), slug: p.slug }) : r.body;
    reply(res, r.status, body, r.type || "application/json; charset=UTF-8");
  }

  const server = http.createServer((req, res) => {
    onHttp(req, res).catch((e) => {
      if (!res.headersSent) reply(res, e.status || 502, { error: String(e.message || e) });
    });
  });

  async function onUpgrade(req, socket, head) {
    if (!isLoopback(req.socket.remoteAddress) || !LOOPBACK_HOST_RE.test(req.headers.host || "") || req.headers.origin) return deny(socket, 403);
    let url;
    try {
      url = new URL(req.url, "http://cdp");
    } catch {
      return deny(socket, 400);
    }
    const p = parseCdpPath(url.pathname, defaultSlug);
    if (!p || !SOCKET_RE.test(p.rest)) return deny(socket, 404);
    let chan;
    try {
      chan = await gateway.open(p.slug, p.rest);
    } catch (e) {
      return deny(socket, e.status || 502, e.message);
    }
    if (socket.destroyed) return chan.close(1001, "client went away");
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      chan.attach(
        (buf) => {
          if (ws.readyState === 1) ws.send(buf, { binary: false });
        },
        (code, reason) => {
          try {
            ws.close(wsCode(code), String(reason || "").slice(0, 120));
          } catch {
            ws.terminate();
          }
        }
      );
      ws.on("message", (data) => {
        if (chan.touch) chan.touch();
        chan.send(data);
      });
      ws.on("close", () => {
        clients.delete(ws);
        chan.close(1000, "client closed");
      });
      ws.on("error", () => chan.close(1011, "client error"));
    });
  }

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    onUpgrade(req, socket, head).catch(() => deny(socket, 502));
  });

  const close = () =>
    new Promise((resolve) => {
      for (const ws of clients) ws.terminate();
      server.close(() => resolve());
    });
  return { server, close };
}

module.exports = {
  OP,
  MAGIC,
  encodeFrame,
  decodeFrame,
  frameJson,
  parseCdpPath,
  rewriteDiscovery,
  Channel,
  DeckLink,
  CdpGateway,
  createCdpServer,
  SLUG_RE,
  DISCOVERY_RE,
  SOCKET_RE,
};
