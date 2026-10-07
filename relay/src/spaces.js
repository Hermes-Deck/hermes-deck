"use strict";
// Agent spaces (docs/agent-spaces.md). Phase 1: one shared space, the
// agent host's own desktop ("host"), used by one agent at a time (space-lock.js). Agent actions keep the driver's
// "host" route; this module decides whether an action may run now, and serves the space to Decks: status, control
// level, and the cua-spacesd viewer proxied with its token added here (the token never leaves this machine).
const fs = require("fs");
const http = require("http");
const net = require("net");

const VIEW = "/spaces/host/view/";
const VIEW_LOSS_MS = 30_000; // full control with no Deck watching ends by itself (spec section 6)
const LEVELS = ["watch", "together", "full", "release"];
// cua-spacesd paths a Deck viewer may reach: exactly what its viewer calls (docs/agent-spaces.md).
// Files, processes, tunnels, hotspot, teleport and MCP stay unreachable through the relay. Input (ComputerService)
// only above Watch.
const ALLOW = [/^viewer(\/|$)/, /^media(\/|$)/, /^cua\.env\.v1\.(Stream|Presence)Service\/[A-Za-z]+$/, /^cua\.env\.v1\.SystemService\/GetCapabilities$/];
const INPUT = /^cua\.env\.v1\.ComputerService\/[A-Za-z]+$/;

/** The cua-spacesd path for a view URL path, "" when refused, null when not a view path. */
function viewPath(pathname, input) {
  if (!pathname.startsWith(VIEW)) return null;
  let rest;
  try {
    rest = decodeURIComponent(pathname.slice(VIEW.length));
  } catch {
    return "";
  }
  if (!rest || rest.includes("..") || rest.startsWith("/") || rest.includes("//") || rest.includes("\\")) return "";
  return ALLOW.some((re) => re.test(rest)) || (input && INPUT.test(rest)) ? rest : "";
}

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

function body(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const parts = [];
    req.on("data", (b) => ((n += b.length) > max ? (reject(new Error("body too large")), req.destroy()) : parts.push(b)));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"));
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

const ORD = (n) => (n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);

class Spaces {
  /**
   * @param {object} o
   * @param {"shared"|"agent"} o.mode
   * @param {import("./space-lock").SpaceLock} o.lock
   * @param {{url: string, tokenFile: string}|null} o.spacesd  cua-spacesd on loopback, or null (no viewer)
   */
  constructor({ mode = "shared", lock, presence = null, spacesd = null, now = () => Date.now(), fetch: f = globalThis.fetch, agentName = (p) => p } = {}) {
    Object.assign(this, { mode: mode === "agent" ? "agent" : "shared", lock, presence, spacesd, now, fetch: f, agentName });
    this.online = false;
    this.viewers = new Set(); // live proxied view sockets (Task 5)
    this.userSince = null;
    this.lostSince = null; // when the last view socket closed while the user held the desktop
    this.level = "watch"; // the user's control level on the shared space
    this.lastPoll = null; // the last GET /spaces from a Deck (its panel asks every 3 s while shown)
  }

  _token() {
    try {
      return fs.readFileSync(this.spacesd.tokenFile, "utf8").trim();
    } catch {
      return "";
    }
  }

  /**
   * May `profile` act now? deviceKind is the driver route: "host" (the shared space) or a device id. A read-only
   * action (a capture, a window listing) only looks: it takes neither the desktop nor a place in line.
   */
  gate(profile, deviceKind, { read = false } = {}) {
    if (deviceKind !== "host" || this.mode !== "shared" || read) return { ok: true };
    const r = this.lock.request(profile);
    if (r.ok) return { ok: true };
    if (r.holder === "user") return { ok: false, busy: false, error: "The user is controlling this desktop." };
    const who = this.agentName(r.holder) || r.holder;
    if (r.timeout) return { ok: false, busy: false, error: `The desktop is in use by ${who}; the wait ran out. Retry later or do something else.` };
    return { ok: false, busy: true, error: `The desktop is in use by ${who}; you are ${ORD(r.position)} in line. Retry later or do something else.` };
  }

  release(profile) {
    return this.lock.release(profile);
  }

  takeUser() {
    this.userSince = this.now();
    return this.lock.takeUser();
  }

  releaseUser() {
    this.userSince = null;
    return this.lock.releaseUser();
  }

  /** A Deck asked for the spaces' state: its panel is alive. */
  polled() {
    this.lastPoll = this.now();
  }

  sweep() {
    this.lock.sweep();
    const t = this.now();
    // full control ends 30 s after the Deck is gone: no view socket left, or (a socket can stay half-open when a
    // Deck crashes or its machine sleeps) no Deck asking for /spaces any more
    const viewGone = !this.viewers.size && this.lostSince !== null && t - this.lostSince >= VIEW_LOSS_MS;
    const deckGone = this.lastPoll !== null && t - this.lastPoll >= VIEW_LOSS_MS;
    if (this.lock.state().user && (viewGone || deckGone)) {
      this.releaseUser();
      this.level = "watch";
    }
  }

  /** POST /spaces/control: watch, together, full (the user holds the desktop) or release (back to watch). */
  async _control(b) {
    const level = String((b && b.level) || "");
    if (!LEVELS.includes(level)) return { ok: false, error: "bad level" };
    this.polled(); // a control request is a sign of life too
    if (level === "full") {
      this.takeUser();
      if (!this.viewers.size) this.lostSince = this.now(); // control without any view expires too
    } else if (this.lock.state().user) this.releaseUser();
    this.level = level === "release" ? "watch" : level;
    return { ok: true, state: this.lock.state() };
  }

  /** POST /spaces/mode. Phase 1 has the shared space only; one desktop per agent is phase 2. */
  async _mode(b) {
    const m = String((b && b.mode) || "");
    if (m === "shared") return { ok: true, mode: (this.mode = "shared") };
    if (m === "agent") return { ok: false, error: "phase 2" };
    return { ok: false, error: "bad mode" };
  }

  viewerOpened() {
    this.viewers.add(Symbol("v"));
    this.lostSince = null;
  }

  viewerClosed() {
    const first = this.viewers.values().next().value;
    if (first) this.viewers.delete(first);
    if (!this.viewers.size) this.lostSince = this.now();
  }

  _proxyHttp(req, res, rest, url) {
    const target = new URL(this.spacesd.url);
    const headers = { ...req.headers, host: target.host, authorization: `Bearer ${this._token()}` };
    delete headers.cookie;
    const up = http.request({ hostname: target.hostname, port: target.port, method: req.method, path: `/${rest}${url.search}`, headers }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => {
      if (!res.headersSent) send(res, 502, { ok: false, error: "space offline" });
      else res.destroy();
    });
    req.pipe(up);
  }

  async health() {
    if (!this.spacesd) return void (this.online = false);
    try {
      const r = await this.fetch(`${this.spacesd.url}/health`, { signal: AbortSignal.timeout(3000) });
      this.online = r.status === 204 || r.ok;
    } catch {
      this.online = false;
    }
  }

  list() {
    const st = this.lock.state();
    return {
      mode: this.mode,
      spaces: [{ id: "host", kind: "shared", viewer: !!this.spacesd, online: this.online, holder: st.holder, user: st.user, queue: st.queue, level: this.level, holderName: st.holder && st.holder !== "user" ? this.agentName(st.holder) || st.holder : null }],
      // agents moved to a Deck device ("Work on this device"): per-profile desktop pins
      here: this.presence
        ? this.presence
            .pinList()
            .filter((p) => p.capability === "desktop" && p.host && p.host.kind === "device" && /^p:/.test(p.sessionKey))
            .map((p) => ({ profile: p.sessionKey.slice(2), device: p.host.id }))
        : [],
    };
  }

  /** "Work on this device" (target "device:<id>") / "Send back to its space" (target "space"): a per-profile desktop pin. */
  async _route(b) {
    const profile = String((b && b.profile) || "");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(profile) || /^\.+$/.test(profile)) return { ok: false, code: "bad" };
    const t = String((b && b.target) || "");
    if (t === "space") return this.presence.setPin(`p:${profile}`, "desktop", null);
    const m = /^device:([a-f0-9]{8,64})$/.exec(t);
    if (!m) return { ok: false, code: "bad" };
    return this.presence.setPin(`p:${profile}`, "desktop", { kind: "device", id: m[1] });
  }

  /** The relay's HTTP hook (behind its Bearer auth). True when this module answered. */
  onHttp(req, res, url) {
    const p = url.pathname;
    if (p === "/spaces" && req.method === "GET") return this.polled(), send(res, 200, this.list()), true;
    if (p === "/spaces/route" && req.method === "POST") {
      body(req)
        .then(async (b) => send(res, 200, await this._route(b)))
        .catch((e) => send(res, 400, { ok: false, error: e.message }));
      return true;
    }
    if (p === "/spaces/control" && req.method === "POST") {
      body(req)
        .then(async (b) => send(res, 200, await this._control(b)))
        .catch((e) => send(res, 400, { ok: false, error: e.message }));
      return true;
    }
    if (p === "/spaces/mode" && req.method === "POST") {
      body(req)
        .then(async (b) => send(res, 200, await this._mode(b)))
        .catch((e) => send(res, 400, { ok: false, error: e.message }));
      return true;
    }
    if (p.startsWith("/spaces/")) {
      const rest = viewPath(p, this.level !== "watch");
      if (!rest || !this.spacesd) return send(res, 403, { ok: false, error: "not allowed" }), true;
      this._proxyHttp(req, res, rest, url);
      return true;
    }
    return false;
  }

  /** WebSocket to the space (the viewer's media socket), with the token added here. */
  onUpgrade(req, socket, head, url) {
    if (!url.pathname.startsWith("/spaces/")) return false;
    const rest = viewPath(url.pathname, false);
    if (!rest || !this.spacesd) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return true;
    }
    const target = new URL(this.spacesd.url);
    const up = net.connect(Number(target.port), target.hostname, () => {
      const lines = [`GET /${rest}${url.search} HTTP/1.1`, `Host: ${target.host}`, `Authorization: Bearer ${this._token()}`];
      // the Deck's origin is not cua-spacesd's; the probe ran without it
      for (const [k, v] of Object.entries(req.headers)) if (!/^(host|authorization|cookie|origin)$/i.test(k)) lines.push(`${k}: ${v}`);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length) up.write(head);
      up.pipe(socket).pipe(up);
    });
    this.viewerOpened();
    socket.once("close", () => this.viewerClosed());
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
    return true;
  }
}

module.exports = { Spaces };
