"use strict";
// Deck end of the [0xD6] space tunnel (agent spaces phase 2). The relay reaches the agent desktops this computer
// hosts (DesktopHost, desktop-host.js) over this Deck's own outbound, token-authenticated relay connection, so the
// machine opens no inbound port. Frames: space-tunnel-frames.js; the relay end is relay/src/space-tunnel.js.
//
// What the relay may do here, and only while the user lets this device host agent desktops (allowed(), asked on
// every CTRL, HTTP and OPEN): start, stop and list desktops (CTRL), and send HTTP requests or HTTP upgrades to one
// desktop's cua-spacesd at 127.0.0.1:<that desktop's own port> (HTTP, and OPEN: a WebSocket upgrade only; the
// relay's bytes reach the desktop only after it answered 101, so no second request can ride the socket). Nothing else on this machine is
// reachable: the port comes from DesktopHost.list(), never from the relay.
//
// The container token stays on this machine. It is added here, to each request, replacing any authorization the
// relay sent; nothing sent back carries it: no ports or tokens in CTRL answers, authorization (and any header whose
// value holds the token) stripped from HTTP answers and from the desktop's answer to an upgrade, and error texts
// scrubbed. Paths must start with "/" and hold no "..", "//" or "\" (403 otherwise), even though the relay is
// authenticated. Bodies are capped at 32 MB each way (the relay's WS maxPayload is 64 MB; base64 adds a third).
//
// Streamed answers (HTTP with `stream: true`, the relay's viewer requests: PresenceService/Join is a server stream):
// the same checks, then HTTP_RES {status, headers, stream: true} as soon as the desktop has answered, its body as DATA
// frames of at most 256 KB, and CLOSE {done: true} at its end (CLOSE {reason} when it broke off). A CLOSE from the
// relay (its viewer went) aborts the desktop request. The timeout is an idle one: no bytes for streamIdleMs.
// Pure Node (no electron import).
const http = require("http");
const net = require("net");
const { OP, encode, decode, json } = require("./space-tunnel-frames");
const { containerName } = require("./desktop-host");
const { viewRest } = require("./space-view-logic");

const NOT_HOSTING = "not hosting agent desktops";
const MAX_BODY = 32 * 1024 * 1024;
const MAX_B64 = Math.ceil(MAX_BODY / 3) * 4;
const MAX_UPGRADE_HEAD = 16 * 1024; // the desktop's answer to an upgrade request, up to the blank line
const STREAM_CHUNK = 256 * 1024; // one DATA frame of a streamed answer: far below the relay's WS maxPayload
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
// Never taken from the relay: we set host and authorization ourselves; cookies and origin are not the desktop's
// business; framing headers are ours to set (no smuggling).
const DROP_COMMON = ["host", "authorization", "proxy-authorization", "cookie", "origin", "content-length", "transfer-encoding", "expect", "te", "trailer", "keep-alive", "proxy-connection"];
const DROP_HTTP = new RegExp(`^(?:${[...DROP_COMMON, "connection", "upgrade"].join("|")})$`);
const DROP_OPEN = DROP_HTTP; // an upgrade gets our own "Connection: Upgrade" and "Upgrade: websocket"
const UPGRADED_RE = /^HTTP\/1\.1 101(?: |$)/;
const DROP_RESPONSE = /^(?:authorization|proxy-authorization|connection|keep-alive|transfer-encoding|te|trailer|upgrade|proxy-connection)$/;

const goodProfile = (p) => containerName(p) !== null;

/** Printable ASCII starting with "/"; the path part (before "?"), raw and percent-decoded, has no "..", "//" or "\". */
/** A streamed request's path passes the viewer rule (space-view-logic.js viewRest, the relay's viewPath mirrored). */
function streamPathOk(p) {
  const q = p.indexOf("?");
  let rest;
  try {
    rest = decodeURIComponent((q < 0 ? p : p.slice(0, q)).slice(1));
  } catch {
    return false;
  }
  return viewRest(rest, true) !== null;
}

function safePath(p) {
  if (typeof p !== "string" || p.length > 4096 || !/^\/[\x21-\x7e]*$/.test(p)) return false;
  const q = p.indexOf("?");
  const raw = q < 0 ? p : p.slice(0, q);
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return false;
  }
  return [raw, decoded].every((s) => s.startsWith("/") && !s.includes("..") && !s.includes("//") && !s.includes("\\"));
}

/** Lower-cased string headers; drops names matching `drop`, bad names and values with CR, LF or NUL. */
function cleanHeaders(h, drop) {
  const out = {};
  if (!h || typeof h !== "object" || Array.isArray(h)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(h)) {
    if (++n > 100) break;
    const key = String(k).toLowerCase();
    if (!HEADER_NAME_RE.test(key) || drop.test(key)) continue;
    const vals = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === "string" || typeof x === "number").map(String);
    if (!vals.length || vals.some((x) => /[\r\n\0]/.test(x) || x.length > 8192)) continue;
    out[key] = Array.isArray(v) ? vals : vals[0];
  }
  return out;
}

/** Response headers for the relay: no credentials, no hop-by-hop, nothing that holds the token. */
function responseHeaders(h, token) {
  const out = cleanHeaders(h, DROP_RESPONSE);
  for (const [k, v] of Object.entries(out)) if ([].concat(v).some((x) => x.includes(token))) delete out[k];
  return out;
}

const SNAP_OPS = new Set(["snapshot", "snapshots", "restore", "dropSnapshot"]);
const SNAP_ID = /^[a-f0-9-]{36}$/;
const REASONS = new Set(["stop", "start", "before-risky-command", "before-undo"]);
function snapCommand(m) {
  if (!SNAP_OPS.has(m.op)) throw new Error("bad control op");
  if (!goodProfile(m.profile)) throw new Error("bad profile");
  if (!Number.isInteger(m.keep) || m.keep < 1 || m.keep > 100) throw new Error("bad snapshot limit");
  const out = { op: m.op, profile: m.profile, keep: m.keep };
  if (m.op === "snapshot") { if (!REASONS.has(m.reason)) throw new Error("bad snapshot reason"); out.reason = m.reason; }
  if (m.op === "restore" || m.op === "dropSnapshot") {
    if (!(m.op === "dropSnapshot" && m.id === null) && !SNAP_ID.test(m.id)) throw new Error("bad snapshot");
    out.id = m.id;
  }
  return out;
}
function snapResult(op, m) {
  if (!m || m.ok !== true) return { ok: false, ...(m?.reason === "too-large" ? { reason: "too-large" } : {}), error: "snapshot operation failed" };
  const point = (p) => p && SNAP_ID.test(p.id) && REASONS.has(p.reason) && Number.isSafeInteger(p.time) && Number.isSafeInteger(p.size) && p.size >= 0
    ? { id: p.id, time: p.time, reason: p.reason, size: p.size, consistent: p.consistent === true } : null;
  const out = { ok: true };
  if (op === "snapshot") { out.point = point(m.point); if (!out.point) return { ok: false, error: "snapshot operation failed" }; }
  if (op === "snapshots") {
    if (!Array.isArray(m.points)) return { ok: false, error: "snapshot operation failed" };
    out.points = m.points.map(point).filter(Boolean).slice(0, 100);
    out.totalBytes = out.points.reduce((n, p) => n + p.size, 0);
    out.busy = m.busy === true; out.recovery = m.recovery === true;
    const notice = (n) => n && SNAP_ID.test(n.id) && Number.isSafeInteger(n.time) && ["created", "too-large", "unpaused", "failed", "restored", "stopped", "cleanup-failed"].includes(n.event)
      ? { id: n.id, time: n.time, event: n.event } : null;
    out.notice = notice(m.notice);
    out.notices = (Array.isArray(m.notices) ? m.notices : []).map(notice).filter(Boolean).slice(-100);
  }
  if (op === "restore") {
    if (!SNAP_ID.test(m.before)) return { ok: false, error: "snapshot operation failed" };
    out.before = m.before;
  }
  return out;
}

/**
 * @param {object} o
 * @param {object} o.host     DesktopHost-like: ensure(profile), stop(profile), list() -> [{profile, running, port}],
 *                            tokenOf(profile) -> string|null
 * @param {(buf: Buffer) => any} o.send  writes one binary frame to the relay connection
 * @param {() => boolean} o.allowed      the user lets this device host agent desktops
 */
class SpaceTunnelServer {
  constructor({ host, send, allowed = () => false, httpTimeoutMs = 25_000, streamIdleMs = 55_000 }) {
    this.host = host;
    this.sendRaw = send;
    this.allowed = allowed;
    this.httpTimeoutMs = httpTimeoutMs; // inside the relay's 30 s wait
    this.streamIdleMs = streamIdleMs; // a streamed answer with no bytes this long ends (inside the relay's 60 s)
    this.socks = new Map(); // ch -> {ch, profile, sock, queue, queued, open, closed, head, headDone, token}
    this.streams = new Map(); // ch -> {ch, req, closed, headSent}: streamed HTTP answers in flight
  }

  _send(op, ch, payload) {
    try {
      this.sendRaw(encode(op, ch, payload));
      return true;
    } catch {
      return false;
    }
  }

  _ok() {
    try {
      return this.allowed() === true;
    } catch {
      return false;
    }
  }

  /** Error text for the relay, without the token (docker output, say) or any bearer value. */
  _scrub(text, profile) {
    let s = String(text || "error").replace(/(CUA_ENV_TOKEN=|Bearer\s+)\S+/gi, "$1***");
    let token = null;
    try {
      token = goodProfile(profile) ? this.host.tokenOf(profile) : null;
    } catch {}
    if (token) s = s.split(token).join("***");
    return s.slice(0, 300);
  }

  /** The loopback port of a running desktop, from DesktopHost only. */
  async _portOf(profile) {
    const list = await this.host.list();
    const d = (Array.isArray(list) ? list : []).find((x) => x && x.profile === profile && x.running);
    return d && Number.isInteger(d.port) && d.port > 0 && d.port < 65536 ? d.port : null;
  }

  _token(profile) {
    try {
      const t = this.host.tokenOf(profile);
      return typeof t === "string" && t ? t : null;
    } catch {
      return null;
    }
  }

  /** A binary message from the relay: true when it was a [0xD6] frame. */
  onFrame(data) {
    const f = decode(data);
    if (!f) return false;
    if (f.op === OP.CTRL) this._ctrl(f.ch, json(f.payload) || {}).catch(() => {});
    else if (f.op === OP.HTTP)
      this._http(f.ch, json(f.payload) || {}).catch(() => {
        const s = this.streams.get(f.ch); // registered before the throw: end it, so streams and size stay honest
        if (s) this._endStream(s, null);
        this._send(OP.HTTP_RES, f.ch, { status: 502, error: "the Deck could not serve that" });
      });
    else if (f.op === OP.OPEN)
      this._open(f.ch, json(f.payload) || {}).catch(() => {
        const c = this.socks.get(f.ch);
        if (c) this._drop(c, "the Deck could not open that", true); // sends the CLOSE
        else this._send(OP.CLOSE, f.ch, { reason: "the Deck could not open that" });
      });
    else if (f.op === OP.DATA) this._data(f.ch, f.payload);
    else if (f.op === OP.CLOSE) {
      const c = this.socks.get(f.ch);
      if (c) this._drop(c, "closed by the relay", false);
      const s = this.streams.get(f.ch);
      if (s) this._endStream(s, null); // the relay's viewer went: abort the desktop request
    }
    return true;
  }

  /** The relay connection is gone (its channels died with it), or hosting was switched off (notify). */
  closeAll(reason, notify = false) {
    for (const c of [...this.socks.values()]) this._drop(c, reason, notify);
    for (const s of [...this.streams.values()]) this._endStream(s, notify ? { reason: String(reason || "").slice(0, 200) } : null);
  }

  get size() {
    return this.socks.size + this.streams.size;
  }

  async _ctrl(ch, m) {
    const reply = (o) => this._send(OP.CTRL_RES, ch, o);
    if (!this._ok()) return reply({ ok: false, error: NOT_HOSTING });
    const op = m.op;
    try {
      if (SNAP_OPS.has(op)) {
        const cmd = snapCommand(m);
        let result;
        if (op === "snapshot") result = await this.host.snapshot(cmd.profile, cmd.reason, { keep: cmd.keep });
        else if (op === "snapshots") result = await this.host.snapshots(cmd.profile);
        else if (op === "restore") result = await this.host.restore(cmd.profile, cmd.id, { keep: cmd.keep });
        else result = await this.host.dropSnapshot(cmd.profile, cmd.id);
        return reply(snapResult(op, { ok: true, ...result }));
      }
      if (op === "list") {
        const list = await this.host.list();
        return reply({ ok: true, desktops: (Array.isArray(list) ? list : []).filter((d) => d && goodProfile(d.profile)).map(({ profile, running }) => ({ profile, running: running === true })) });
      }
      if (op !== "ensure" && op !== "stop") return reply({ ok: false, error: "bad request" });
      if (!goodProfile(m.profile)) return reply({ ok: false, error: "bad profile" });
      if (op === "ensure") {
        await this.host.ensure(m.profile);
        return reply({ ok: true, port: null }); // the relay never needs this machine's loopback port
      }
      if (m.keep !== undefined && (!Number.isInteger(m.keep) || m.keep < 1 || m.keep > 100)) return reply({ ok: false, error: "bad snapshot limit" });
      await this.host.stop(m.profile, { keep: m.keep });
      return reply({ ok: true });
    } catch (e) {
      return reply({ ok: false, error: SNAP_OPS.has(op) ? "snapshot operation failed" : this._scrub(e && e.message, m.profile) });
    }
  }

  async _http(ch, m) {
    const streamed = m.stream === true;
    if (streamed && (this.streams.has(ch) || this.socks.has(ch))) return this._send(OP.HTTP_RES, ch, { status: 409, error: "channel already open" });
    // a streamed request is registered at once, so a CLOSE from the relay while we look the desktop up ends it
    const s = streamed ? { ch, req: null, closed: false, headSent: false } : null;
    if (s) this.streams.set(ch, s);
    const refuse = (status, error) => {
      if (s) {
        if (s.closed) return false; // the relay gave up meanwhile: nobody to answer
        this._endStream(s, null);
      }
      return this._send(OP.HTTP_RES, ch, { status, error });
    };
    if (!this._ok()) return refuse(403, NOT_HOSTING);
    const profile = m.profile;
    if (!goodProfile(profile)) return refuse(403, "bad profile");
    if (!safePath(m.path)) return refuse(403, "bad path");
    // a stream is the viewer's (PresenceService/Join and the like), never MCP, /health or anything else: the relay only
    // streams viewer paths, so a stream elsewhere is refused here too (the relay applied the level: input allowed)
    if (streamed && !streamPathOk(m.path)) return refuse(403, "bad path");
    const method = String(m.method || "GET").toUpperCase();
    if (!METHODS.has(method)) return refuse(403, "bad method");
    if (m.body != null && typeof m.body !== "string") return refuse(400, "bad body");
    const b64 = m.body || "";
    if (b64.length > MAX_B64) return refuse(413, "request body too large");
    const body = Buffer.from(b64, "base64");
    if (body.length > MAX_BODY) return refuse(413, "request body too large");
    let port;
    try {
      port = await this._portOf(profile);
    } catch (e) {
      return refuse(502, this._scrub(`could not list the desktops: ${e && e.message}`, profile));
    }
    if (!this._ok()) return refuse(403, NOT_HOSTING); // switched off while we looked
    if (!port) return refuse(502, "that agent's desktop is not running");
    const token = this._token(profile);
    if (!token) return refuse(502, "that agent's desktop has no token");

    const headers = cleanHeaders(m.headers, DROP_HTTP);
    if (body.length || (method !== "GET" && method !== "HEAD")) headers["content-length"] = String(body.length);
    headers.host = `127.0.0.1:${port}`;
    headers.authorization = `Bearer ${token}`; // ours, whatever the relay sent
    if (s) return this._streamHttp(s, { port, method, path: m.path, headers, body, token });
    await new Promise((resolve) => {
      let done = false;
      const finish = (fn) => {
        if (done) return;
        done = true;
        fn();
        resolve();
      };
      let req;
      try {
        req = http.request({ host: "127.0.0.1", port, method, path: m.path, headers, timeout: this.httpTimeoutMs }, (res) => {
          const parts = [];
          let n = 0;
          res.on("data", (d) => {
            if (done) return;
            n += d.length;
            if (n > MAX_BODY) {
              finish(() => refuse(502, "response body too large"));
              req.destroy();
            } else parts.push(d);
          });
          res.on("end", () => finish(() => this._send(OP.HTTP_RES, ch, { status: res.statusCode, headers: responseHeaders(res.headers, token), body: Buffer.concat(parts).toString("base64") })));
          res.on("error", () => finish(() => refuse(502, "the desktop's answer broke off")));
          res.on("aborted", () => finish(() => refuse(502, "the desktop's answer broke off")));
        });
      } catch {
        return finish(() => refuse(400, "bad request"));
      }
      req.on("timeout", () => {
        finish(() => refuse(504, "the desktop did not answer in time"));
        req.destroy();
      });
      req.on("error", (e) => finish(() => refuse(502, `the desktop is unreachable (${(e && e.code) || "error"})`)));
      req.end(body);
    });
  }

  /**
   * One streamed answer: the head as soon as the desktop has one, then its bytes as they come (DATA, at most
   * STREAM_CHUNK each), then CLOSE {done: true}. A failure before the head is an HTTP_RES with its status; after it,
   * CLOSE {reason}. The socket's idle timeout (no bytes either way for streamIdleMs) ends it too.
   */
  _streamHttp(s, { port, method, path, headers, body, token }) {
    if (s.closed) return; // the relay's viewer went while we looked the desktop up
    const fail = (status, error) => {
      if (s.closed) return;
      const head = s.headSent;
      this._endStream(s, head ? { reason: error } : null);
      if (!head) this._send(OP.HTTP_RES, s.ch, { status, error });
    };
    let req;
    try {
      req = http.request({ host: "127.0.0.1", port, method, path, headers, timeout: this.streamIdleMs }, (res) => {
        if (s.closed) return void res.destroy();
        s.headSent = true;
        this._send(OP.HTTP_RES, s.ch, { status: res.statusCode, headers: responseHeaders(res.headers, token), stream: true });
        res.on("data", (d) => {
          if (s.closed) return;
          for (let i = 0; i < d.length; i += STREAM_CHUNK) this._send(OP.DATA, s.ch, d.subarray(i, i + STREAM_CHUNK));
        });
        res.on("end", () => {
          s.req = null; // complete: nothing to abort (its socket may go back to the pool)
          this._endStream(s, { done: true });
        });
        res.on("error", () => fail(502, "the desktop's answer broke off"));
        res.on("close", () => {
          if (!res.complete) fail(502, "the desktop's answer broke off");
        });
      });
    } catch {
      return fail(400, "bad request");
    }
    s.req = req;
    req.on("timeout", () => fail(504, s.headSent ? "the desktop sent nothing for too long" : "the desktop did not answer in time"));
    req.on("error", (e) => fail(502, `the desktop is unreachable (${(e && e.code) || "error"})`));
    req.end(body);
  }

  /** A streamed answer is over: forget it, abort the desktop request if it still runs, CLOSE with `payload` if any. */
  _endStream(s, payload) {
    if (s.closed) return;
    s.closed = true;
    this.streams.delete(s.ch);
    if (s.req && !s.req.destroyed) s.req.destroy();
    if (payload) this._send(OP.CLOSE, s.ch, payload);
  }

  async _open(ch, m) {
    const refuse = (reason) => this._send(OP.CLOSE, ch, { reason });
    if (!this._ok()) return refuse(NOT_HOSTING);
    const profile = m.profile;
    if (!goodProfile(profile)) return refuse("bad profile");
    if (!safePath(m.path)) return refuse("bad path");
    // OPEN is a WebSocket upgrade and nothing else: never a plain request whose keep-alive connection the relay
    // could pipeline further requests on, past the path rule and our Host
    const up = m.headers && typeof m.headers === "object" ? Object.entries(m.headers).find(([k]) => String(k).toLowerCase() === "upgrade") : null;
    if (!up || typeof up[1] !== "string" || up[1].trim().toLowerCase() !== "websocket") return refuse("not a websocket upgrade");
    if (this.socks.has(ch)) return refuse("channel already open");
    const c = { ch, profile, sock: null, queue: [], queued: 0, open: false, piping: false, closed: false, head: Buffer.alloc(0), token: null };
    this.socks.set(ch, c); // the relay's DATA is queued until the desktop answers 101; CLOSE marks it closed
    let port = null;
    try {
      port = await this._portOf(profile);
    } catch {}
    if (c.closed) return; // the relay gave up meanwhile
    if (!this._ok()) return this._drop(c, NOT_HOSTING, true);
    if (!port) return this._drop(c, "that agent's desktop is not running", true);
    const token = this._token(profile);
    if (!token) return this._drop(c, "that agent's desktop has no token", true);
    c.token = token;
    const headers = cleanHeaders(m.headers, DROP_OPEN);
    const sock = net.connect(port, "127.0.0.1");
    c.sock = sock;
    sock.on("connect", () => {
      if (c.closed) return sock.destroy();
      // the raw upgrade line, as relay/src/spaces.js onUpgrade writes it; header values were checked for CR/LF
      const lines = [`GET ${m.path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, `Authorization: Bearer ${token}`, "Connection: Upgrade", "Upgrade: websocket"];
      for (const [k, v] of Object.entries(headers)) for (const x of [].concat(v)) lines.push(`${k}: ${x}`);
      sock.write(lines.join("\r\n") + "\r\n\r\n");
      c.open = true;
      this._send(OP.OPENED, ch); // the relay's bytes stay queued until the desktop has answered 101
    });
    sock.on("data", (d) => this._fromDesktop(c, d));
    sock.on("close", () => this._drop(c, "the desktop closed the connection", true));
    sock.on("error", () => {}); // "close" follows
  }

  /** desktop -> relay. The answer to the upgrade request loses any authorization line (or line holding the token). */
  _fromDesktop(c, d) {
    if (c.closed) return;
    if (c.piping) return void this._send(OP.DATA, c.ch, d);
    c.head = Buffer.concat([c.head, d]);
    const end = c.head.indexOf("\r\n\r\n");
    if (end < 0) {
      if (c.head.length > MAX_UPGRADE_HEAD) this._drop(c, "bad answer from the desktop", true);
      return;
    }
    const lines = c.head.subarray(0, end).toString("latin1").split("\r\n");
    const kept = lines.filter((l, i) => i === 0 || !(/^\s*(?:authorization|proxy-authorization)\s*:/i.test(l) || l.includes(c.token)));
    const head = Buffer.from(kept.join("\r\n") + "\r\n\r\n", "latin1");
    const rest = c.head.subarray(end + 4);
    c.head = null;
    if (!UPGRADED_RE.test(lines[0])) {
      // no upgrade: the relay gets the answer's head only; its queued bytes never reach the desktop; the socket goes
      this._send(OP.DATA, c.ch, head);
      const status = (/^HTTP\/\d\.\d (\d{3})/.exec(lines[0]) || [])[1] || "?";
      return this._drop(c, `the desktop refused the upgrade (${status})`, true, true);
    }
    c.piping = true;
    this._send(OP.DATA, c.ch, Buffer.concat([head, rest]));
    for (const b of c.queue) c.sock.write(b);
    c.queue = [];
    c.queued = 0;
  }

  /** relay -> desktop */
  _data(ch, payload) {
    const c = this.socks.get(ch);
    if (!c || c.closed) return;
    if (c.piping) return void c.sock.write(payload);
    c.queued += payload.length;
    if (c.queued > MAX_BODY) return this._drop(c, "too much data before the desktop answered", true);
    c.queue.push(Buffer.from(payload));
  }

  _drop(c, reason, notify, destroy = false) {
    if (c.closed) return;
    c.closed = true;
    c.open = false;
    c.piping = false;
    c.queue = [];
    this.socks.delete(c.ch);
    if (notify) this._send(OP.CLOSE, c.ch, { reason: String(reason || "").slice(0, 200) });
    if (c.sock && !c.sock.destroyed) {
      if (destroy) return void c.sock.destroy();
      c.sock.end();
      const t = setTimeout(() => c.sock.destroy(), 2000);
      if (t.unref) t.unref();
    }
  }
}

module.exports = { SpaceTunnelServer, safePath, cleanHeaders, snapResult, MAX_BODY, NOT_HOSTING };
