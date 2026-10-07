"use strict";
// Relay end of the [0xD6] space tunnel (agent spaces phase 2). The relay reaches the agent desktops a Deck computer
// hosts over that Deck's own outbound, token-authenticated relay WebSocket: the Deck's machine opens no inbound
// port. The Deck end is app/main/space-tunnel.js; it alone holds each desktop's container token (cua-spacesd's) and
// adds it to every request itself. This side never sends, accepts or forwards one: `authorization` is dropped from
// what callers hand in and from what comes back.
//
// Frames: binary messages on a Deck's relay connection, [0xD6][op u8][channel u32 BE][payload]
//   CTRL 1      relay -> deck  {op: "ensure"|"stop"|"list"|"snapshot"|"snapshots"|"restore"|"dropSnapshot", profile?, id?, reason?, keep?}
//   CTRL_RES 2  deck -> relay  {ok, error?, port: null (ensure), desktops?: [{profile, running}] (list)}
//   HTTP 3      relay -> deck  {profile, method, path, headers, body: base64, stream?: true}
//   HTTP_RES 4  deck -> relay  {status, headers, body: base64}, or {status, error} when the Deck refused/failed;
//                              for stream: true, the head only, {status, headers, stream: true}, then DATA frames
//                              (<= 256 KB each) and CLOSE {done: true} at the end, CLOSE {reason} if it broke off.
//                              The relay's CLOSE on that channel (its viewer went) aborts the desktop request.
//   OPEN 5      relay -> deck  {profile, path, headers}          an HTTP upgrade (WebSocket) to that desktop
//   OPENED 6    deck -> relay  {}
//   DATA 7      both ways      raw bytes; deck -> relay starts with the desktop's HTTP answer to the upgrade. The
//                              Deck holds relay bytes until that answer is 101; any other answer: head, then CLOSE
//   CLOSE 8     both ways      {reason}
// Channel ids are allocated by the relay only. The codec below is byte-identical to app/main/space-tunnel-frames.js
// (the relay and the Deck app are deployed separately, so it is copied, as relay/src/cdp.js copies its framing;
// relay/test/space-tunnel.test.js checks the two agree).
const { EventEmitter } = require("events");
const { Readable } = require("stream");

// ---- framing (keep byte-identical with app/main/space-tunnel-frames.js) ---------------------------------
const MAGIC = 0xd6;
const OP = Object.freeze({ CTRL: 1, CTRL_RES: 2, HTTP: 3, HTTP_RES: 4, OPEN: 5, OPENED: 6, DATA: 7, CLOSE: 8 });
const HEADER = 6;
function encode(op, ch, payload) {
  const body = payload === undefined || payload === null ? Buffer.alloc(0) : Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload), "utf8");
  const head = Buffer.allocUnsafe(HEADER);
  head[0] = MAGIC;
  head[1] = op;
  head.writeUInt32BE(ch >>> 0, 2);
  return Buffer.concat([head, body]);
}
function decode(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < HEADER || buf[0] !== MAGIC || buf[1] < OP.CTRL || buf[1] > OP.CLOSE) return null;
  return { op: buf[1], ch: buf.readUInt32BE(2), payload: buf.subarray(HEADER) };
}
function json(payload) {
  try {
    const v = JSON.parse(payload.toString("utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// ---- what may go through ----------------------------------------------------------------------------------
// Hermes profiles that are also Docker-name safe (app/main/desktop-host.js PROFILE_RE, no "..").
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const goodProfile = (p) => typeof p === "string" && PROFILE_RE.test(p) && !p.includes("..");
// The relay's WS maxPayload is 64 MB: 32 MB of body is ~43 MB as base64, which leaves room for the rest.
const MAX_BODY = 32 * 1024 * 1024;
const MAX_B64 = Math.ceil(MAX_BODY / 3) * 4;
const METHOD_RE = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/;
const CTRL_OPS = new Set(["ensure", "stop", "list", "snapshot", "snapshots", "restore", "dropSnapshot"]);
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const NO_CREDENTIALS = /^(?:authorization|proxy-authorization)$/;

/** Printable ASCII starting with "/"; the path part (before "?"), raw and percent-decoded, has no "..", "//" or "\". */
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

// The Deck's own refusal texts (app/main/desktops.js LIMIT_ERROR, app/main/space-tunnel.js NOT_HOSTING; a test keeps
// them equal): the relay cannot require app/ (it runs without the Deck's source on a plain agent host).
const DECK_LIMIT_ERROR = "this computer is at its desktop limit";
const DECK_NOT_HOSTING = "not hosting agent desktops";
const fail = (message, status) => Object.assign(new Error(message), status ? { status } : {});
const GONE = "the Deck's connection is gone";
// a streamed answer's bytes waiting for a viewer that does not read: past this, the stream is dropped (the Deck
// cannot be paused, so this bounds what one viewer can make the relay hold)
const MAX_STREAM_BUFFER = 8 * 1024 * 1024;

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
 * Reaches the agent desktops Deck computers host. `presence.connOf(deviceId)` gives a Deck's relay connection
 * ({readyState, send(buf, opts)}). Frame wiring (onFrame on binary messages, removeDeck on close) is the server's.
 */
class SpaceTunnel {
  constructor({ presence, ctrlTimeoutMs = 60_000, httpTimeoutMs = 30_000, openTimeoutMs = 30_000, streamIdleMs = 60_000, maxStreamBuffer = MAX_STREAM_BUFFER }) {
    this.presence = presence;
    this.ctrlTimeoutMs = ctrlTimeoutMs; // a first start may pull nothing but still take ~20 s
    this.httpTimeoutMs = httpTimeoutMs;
    this.openTimeoutMs = openTimeoutMs; // OPEN -> OPENED; an opened socket has no timeout
    this.streamIdleMs = streamIdleMs; // a streamed answer: no frame from the Deck for this long ends it (head included)
    this.maxStreamBuffer = maxStreamBuffer;
    this.pending = new Map(); // ch -> {ws, kind, op?, resolve, reject, timer}
    this.socks = new Map(); // ch -> {ws, sock, end(reason)}
    this.streams = new Map(); // ch -> {ws, ch, resolve, reject, timer, body: Readable|null, done, signal, onAbort}
    this._id = 0;
  }

  _next() {
    do this._id = this._id >= 0xfffffffe ? 1 : this._id + 1;
    while (this.pending.has(this._id) || this.socks.has(this._id) || this.streams.has(this._id));
    return this._id;
  }

  _conn(deviceId) {
    const ws = this.presence.connOf(deviceId);
    if (!ws || ws.readyState !== 1) throw fail(`no connection to ${deviceId}`, 502);
    return ws;
  }

  _send(ws, op, ch, payload) {
    try {
      ws.send(encode(op, ch, payload), { binary: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Register the call before sending: a Deck may answer within send() (an in-memory pair does). */
  _call(ws, kind, payload, timeoutMs, extra = {}) {
    return new Promise((resolve, reject) => {
      const ch = this._next();
      const timer = setTimeout(() => {
        this.pending.delete(ch);
        reject(fail("the Deck did not answer in time", 504));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(ch, { ws, kind, resolve, reject, timer, ...extra });
      if (!this._send(ws, kind === "ctrl" ? OP.CTRL : OP.HTTP, ch, payload)) this._settle(ch, null, fail(GONE, 502));
    });
  }

  _settle(ch, value, err) {
    const p = this.pending.get(ch);
    if (!p) return;
    this.pending.delete(ch);
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(value);
  }

  /** {ok, error?} plus port:null (ensure) or desktops (list). Rejects on no connection, timeout, the Deck gone. */
  ctrl(deviceId, cmd) {
    return new Promise((resolve) => {
      const op = cmd && cmd.op;
      if (!CTRL_OPS.has(op)) throw fail("bad control op", 400);
      if (op !== "list" && !goodProfile(cmd.profile)) throw fail("bad profile", 400);
      const ws = this._conn(deviceId);
      const payload = SNAP_OPS.has(op) ? snapCommand(cmd) : op === "list" ? { op } : { op, profile: cmd.profile };
      if (op === "stop" && cmd.keep !== undefined) {
        if (!Number.isInteger(cmd.keep) || cmd.keep < 1 || cmd.keep > 100) throw fail("bad snapshot limit", 400);
        payload.keep = cmd.keep;
      }
      const timeout = op === "restore" ? 900_000 : SNAP_OPS.has(op) || op === "stop" || op === "ensure" ? 300_000 : this.ctrlTimeoutMs;
      resolve(this._call(ws, "ctrl", payload, timeout, { op }));
    });
  }

  /** One HTTP request to a desktop the Deck hosts -> {status, headers, body: Buffer}. Refusals reject. */
  http(deviceId, { profile, method = "GET", path, headers = {}, body = Buffer.alloc(0) } = {}) {
    return new Promise((resolve) => {
      if (!goodProfile(profile)) throw fail("bad profile", 400);
      if (!safePath(path)) throw fail("bad path", 400);
      const m = String(method).toUpperCase();
      if (!METHOD_RE.test(m)) throw fail("bad method", 405);
      const b = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
      if (b.length > MAX_BODY) throw fail("request body too large", 413);
      const ws = this._conn(deviceId);
      const h = cleanHeaders(headers, NO_CREDENTIALS);
      resolve(this._call(ws, "http", { profile, method: m, path, headers: h, body: b.toString("base64") }, this.httpTimeoutMs));
    });
  }

  /**
   * One HTTP request whose answer streams (a viewer's: PresenceService/Join is a server stream that a buffered answer
   * would hold until the timeout). Resolves at the answer's head with {status, headers, body}: body is a Readable of
   * the desktop's bytes that ends with the answer, or is destroyed with an error (status 502 or 504) when the answer
   * breaks off, the Deck goes, no frame comes for streamIdleMs, or more than maxStreamBuffer waits unread. Aborting
   * `signal` (the viewer went) tells the Deck to drop the request. Refusals, and no head within streamIdleMs, reject.
   * A Deck from before streams answers in one piece; that body is the whole answer. Same checks as http().
   */
  stream(deviceId, { profile, method = "GET", path, headers = {}, body = Buffer.alloc(0), signal = null } = {}) {
    return new Promise((resolve, reject) => {
      if (!goodProfile(profile)) throw fail("bad profile", 400);
      if (!safePath(path)) throw fail("bad path", 400);
      const m = String(method).toUpperCase();
      if (!METHOD_RE.test(m)) throw fail("bad method", 405);
      const b = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
      if (b.length > MAX_BODY) throw fail("request body too large", 413);
      if (signal && signal.aborted) throw fail("the viewer went", 499);
      const ws = this._conn(deviceId);
      const ch = this._next();
      const s = { ws, ch, resolve, reject, timer: null, body: null, done: false, signal, onAbort: null };
      this.streams.set(ch, s); // before sending: a Deck may answer within send()
      if (signal) {
        s.onAbort = () => this._streamEnd(s, fail("the viewer went", 499), true);
        signal.addEventListener("abort", s.onAbort, { once: true });
      }
      this._streamArm(s);
      const payload = { profile, method: m, path, headers: cleanHeaders(headers, NO_CREDENTIALS), body: b.toString("base64"), stream: true };
      if (!this._send(ws, OP.HTTP, ch, payload)) this._streamEnd(s, fail(GONE, 502), false);
    });
  }

  /** (Re)start a stream's idle clock: no frame from the Deck for streamIdleMs ends it (and tells the Deck). */
  _streamArm(s) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => this._streamEnd(s, fail(s.body ? "the desktop sent nothing for too long" : "the Deck did not answer in time", 504), true), this.streamIdleMs);
    if (s.timer.unref) s.timer.unref();
  }

  /** A stream is over: err null = the answer ended; tellDeck sends CLOSE so the Deck drops the desktop request. */
  _streamEnd(s, err, tellDeck) {
    if (s.done) return;
    s.done = true;
    clearTimeout(s.timer);
    this.streams.delete(s.ch);
    if (s.signal && s.onAbort) s.signal.removeEventListener("abort", s.onAbort);
    if (tellDeck) this._send(s.ws, OP.CLOSE, s.ch, { reason: String((err && err.message) || "closed by the relay").slice(0, 200) });
    if (!s.body) s.reject(err || fail("bad answer from the Deck", 502));
    else if (err) s.body.destroy(err);
    else s.body.push(null);
  }

  /** A frame from the Deck on a stream's channel. */
  _streamFrame(s, f) {
    if (!s.body) {
      if (f.op === OP.CLOSE) {
        const m = json(f.payload) || {};
        return this._streamEnd(s, fail(String(m.reason || "closed by the Deck").slice(0, 300), 502), false);
      }
      if (f.op !== OP.HTTP_RES) return;
      const m = json(f.payload);
      // a stream's body; error listener of our own: a broken answer must never become an uncaught error here
      const body = new Readable({ read() {} });
      body.on("error", () => {});
      if (m && m.stream === true && typeof m.error !== "string") {
        const status = Number.isInteger(m.status) && m.status >= 100 && m.status < 600 ? m.status : 502;
        s.body = body;
        this._streamArm(s);
        return s.resolve({ status, headers: cleanHeaders(m.headers, NO_CREDENTIALS), body });
      }
      const r = httpResult(m); // a refusal, or a Deck from before streams answering in one piece
      if (r instanceof Error) return this._streamEnd(s, r, false);
      s.body = body;
      body.push(r.body);
      s.resolve({ status: r.status, headers: r.headers, body });
      return this._streamEnd(s, null, false);
    }
    if (f.op === OP.DATA) {
      s.body.push(Buffer.from(f.payload));
      if (s.body.readableLength > this.maxStreamBuffer) return this._streamEnd(s, fail("the viewer is not reading", 502), true);
      return this._streamArm(s);
    }
    if (f.op === OP.CLOSE) {
      const m = json(f.payload) || {};
      if (m.done === true) return this._streamEnd(s, null, false);
      return this._streamEnd(s, fail(String(m.reason || "the desktop's answer broke off").slice(0, 300), 502), false);
    }
  }

  /**
   * An HTTP upgrade (WebSocket) to a desktop the Deck hosts, as a raw byte pipe: send() the client's bytes after
   * the upgrade request (head, frames), "data" gives the desktop's bytes, starting with its HTTP answer. Emits
   * "open" (the Deck connected), "data" (Buffer) and "close" (reason) once. OPENED must come within
   * openTimeoutMs (else CLOSE is sent and "close" emitted); an opened socket has no timeout, removeDeck closes it.
   * Throws at once on a bad profile, a bad path or no connection.
   */
  openWs(deviceId, { profile, path, headers = {} } = {}) {
    if (!goodProfile(profile)) throw fail("bad profile", 400);
    if (!safePath(path)) throw fail("bad path", 400);
    const ws = this._conn(deviceId);
    const ch = this._next();
    const sock = new EventEmitter();
    let done = false;
    let timer = null;
    const end = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.socks.delete(ch);
      process.nextTick(() => sock.emit("close", reason)); // listeners attach after openWs returns
    };
    sock.send = (buf) => {
      if (!done) this._send(ws, OP.DATA, ch, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    };
    sock.close = (reason = "closed by the relay") => {
      if (done) return;
      this._send(ws, OP.CLOSE, ch, { reason: String(reason).slice(0, 200) });
      end(reason);
    };
    // a Deck that stays connected but never answers OPEN must not leave the socket waiting forever
    timer = setTimeout(() => sock.close("the Deck did not answer in time"), this.openTimeoutMs);
    if (timer.unref) timer.unref();
    const opened = () => clearTimeout(timer);
    this.socks.set(ch, { ws, sock, end, opened });
    if (!this._send(ws, OP.OPEN, ch, { profile, path, headers: cleanHeaders(headers, NO_CREDENTIALS) })) end(GONE);
    return sock;
  }

  /** A binary message from a Deck connection: true when it was a [0xD6] frame (handled or ignored). */
  onFrame(ws, buf) {
    const f = decode(buf);
    if (!f) return false;
    const p = this.pending.get(f.ch);
    if (p) {
      if (p.ws !== ws) return true; // only the Deck the call went to may answer it
      if (p.kind === "ctrl" && f.op === OP.CTRL_RES) this._settle(f.ch, ctrlResult(p.op, json(f.payload)));
      else if (p.kind === "http" && f.op === OP.HTTP_RES) {
        const r = httpResult(json(f.payload));
        if (r instanceof Error) this._settle(f.ch, null, r);
        else this._settle(f.ch, r);
      }
      return true;
    }
    const st = this.streams.get(f.ch);
    if (st) {
      if (st.ws === ws) this._streamFrame(st, f); // only the Deck the request went to may answer it
      return true;
    }
    const s = this.socks.get(f.ch);
    if (!s || s.ws !== ws) return true;
    if (f.op === OP.OPENED) {
      s.opened();
      s.sock.emit("open");
    }
    else if (f.op === OP.DATA) s.sock.emit("data", Buffer.from(f.payload));
    else if (f.op === OP.CLOSE) {
      const m = json(f.payload) || {};
      s.end(String(m.reason || "closed by the Deck").slice(0, 200));
    }
    return true;
  }

  /** The Deck's connection closed: everything pending on it fails now, its sockets close. */
  removeDeck(ws) {
    for (const [ch, p] of [...this.pending]) if (p.ws === ws) this._settle(ch, null, fail(GONE, 502));
    for (const s of [...this.socks.values()]) if (s.ws === ws) s.end(GONE);
    for (const s of [...this.streams.values()]) if (s.ws === ws) this._streamEnd(s, fail(GONE, 502), false);
  }

  /** The adapter Desktops (relay/src/desktops.js) uses for Deck-hosted desktops. */
  get remote() {
    return {
      ...Object.fromEntries([...SNAP_OPS].map((op) => [op, (deviceId, profile, options = {}) =>
        this.ctrl(deviceId, { op, profile, keep: 10, ...options }).then((r) => {
          if (!r.ok && r.reason !== "too-large") throw new Error("snapshot operation failed");
          return r;
        })])),
      // the Deck's own limit refusal is marked (code LIMIT): Desktops falls back with "limit" and does not retry
      ensure: (deviceId, profile) => this.ctrl(deviceId, { op: "ensure", profile }).then((r) => {
        if (!r || !r.ok) throw Object.assign(new Error((r && r.error) || "start failed"), r && r.error === DECK_LIMIT_ERROR ? { code: "LIMIT" } : {});
        return { port: null };
      }),
      // a stop the Deck could not do is a failure (Desktops keeps the slot and retries); a Deck that is not hosting
      // stopped its desktops itself when it was switched off
      stop: (deviceId, profile, { keep } = {}) => this.ctrl(deviceId, { op: "stop", profile, ...(keep === undefined ? {} : { keep }) }).then((r) => {
        if (!r || (!r.ok && r.error !== DECK_NOT_HOSTING)) throw new Error((r && r.error) || "stop failed");
        return r;
      }),
      list: (deviceId) => this.ctrl(deviceId, { op: "list" }).then((r) => (r && Array.isArray(r.desktops) ? r.desktops : [])),
    };
  }
}

/** Only what the relay needs from a CTRL_RES: never ports, never tokens. */
function ctrlResult(op, m) {
  if (SNAP_OPS.has(op)) return snapResult(op, m);
  if (!m) return { ok: false, error: "bad answer from the Deck" };
  const r = { ok: m.ok === true };
  if (typeof m.error === "string") r.error = m.error.slice(0, 300);
  if (op === "ensure" && r.ok) r.port = null;
  if (op === "list" && r.ok) r.desktops = (Array.isArray(m.desktops) ? m.desktops : []).filter((d) => d && goodProfile(d.profile)).map((d) => ({ profile: d.profile, running: d.running === true }));
  return r;
}

function httpResult(m) {
  if (!m) return fail("bad answer from the Deck", 502);
  const status = Number.isInteger(m.status) && m.status >= 100 && m.status < 600 ? m.status : 502;
  if (typeof m.error === "string") {
    const msg = m.error.slice(0, 300);
    return fail(status === 403 ? `refused: ${msg}` : msg, status);
  }
  const b64 = typeof m.body === "string" ? m.body : "";
  if (b64.length > MAX_B64) return fail("response body too large", 502);
  return { status, headers: cleanHeaders(m.headers, NO_CREDENTIALS), body: Buffer.from(b64, "base64") };
}

module.exports = { SpaceTunnel, MAGIC, OP, HEADER, encode, decode, json, safePath, MAX_BODY, DECK_LIMIT_ERROR, DECK_NOT_HOSTING };
