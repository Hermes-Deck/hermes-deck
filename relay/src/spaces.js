"use strict";
// Agent spaces (docs/agent-spaces.md).
// Phase 1: one shared space, the agent host's own desktop ("host"), used by one agent at a time (space-lock.js).
// Phase 2 ("agent" mode): each agent also has its own desktop, a container on a desktop host (desktops.js): the agent
// host itself or a Deck computer reached through the space tunnel (space-tunnel.js). This module decides whether an
// action may run now, and serves the spaces to Decks: status, control level per desktop, home hosts, start/stop, and
// each desktop's cua-spacesd viewer proxied with its container token added on the machine that holds it (here for the
// agent host's desktops, on the Deck for a Deck's). No port and no token ever goes into an answer.
const fs = require("fs");
const http = require("http");
const net = require("net");
const { makeSpaceFetch, makeReady, pickHeaders, localTarget, isNotRunning, goodProfile, NOT_RUNNING } = require("./space-fetch");

const VIEW_LOSS_MS = 30_000; // full control with no Deck watching ends by itself (spec section 6)
// a Deck that shows an agent desktop from its own loopback (no view socket here) says so on its /spaces poll
// (?watching=<id>, every 3 s while shown): that desktop counts as watched for this long after the last such poll
const WATCH_POLL_MS = 15_000;
const LEVELS = ["watch", "together", "full", "release"];
// cua-spacesd paths a Deck viewer may reach: exactly what its viewer calls (docs/agent-spaces.md).
// Files, processes, tunnels, hotspot, teleport and MCP stay unreachable through the relay. Input (ComputerService)
// only above Watch.
const ALLOW = [/^viewer(\/|$)/, /^media(\/|$)/, /^cua\.env\.v1\.(Stream|Presence)Service\/[A-Za-z]+$/, /^cua\.env\.v1\.SystemService\/GetCapabilities$/];
// clipboard paths are never input: the viewer opens with clipboard=off, so nothing legitimate calls them (final review T5)
const INPUT = /^cua\.env\.v1\.ComputerService\/(?!(?:Get|Set)Clipboard$)[A-Za-z]+$/;
const VIEW_RE = /^\/spaces\/([^/]+)\/view\/(.*)$/s;
const PRINTABLE = /^[\x21-\x7e]+$/;
const MAX_VIEW_BODY = 4 * 1024 * 1024; // a viewer request (Connect/gRPC-Web unary calls are small)

const RESPONSE_DROP = /^(?:authorization|proxy-authorization|set-cookie|connection|keep-alive|transfer-encoding|te|trailer|upgrade|proxy-connection|content-length)$/;

/** Response headers for a Deck's viewer: no credentials, cookies or hop-by-hop, nothing holding the token. */
function responseHeaders(h, token = null) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    const key = String(k).toLowerCase();
    if (RESPONSE_DROP.test(key)) continue;
    if (token && [].concat(v).some((x) => String(x).includes(token))) continue;
    out[key] = v;
  }
  return out;
}

/** {id, rest} for a view URL path ("host" or an agent profile; rest "" when refused), null when not a view path. */
function viewPath(pathname, input) {
  const m = VIEW_RE.exec(pathname);
  if (!m || (m[1] !== "host" && !goodProfile(m[1]))) return null;
  let rest;
  try {
    rest = decodeURIComponent(m[2]);
  } catch {
    return { id: m[1], rest: "" };
  }
  // printable ASCII only: no space, CR, LF or other control character (a raw upgrade request line is written from it)
  if (!rest || !PRINTABLE.test(rest) || rest.includes("..") || rest.startsWith("/") || rest.includes("//") || rest.includes("\\")) return { id: m[1], rest: "" };
  return { id: m[1], rest: ALLOW.some((re) => re.test(rest)) || (input && INPUT.test(rest)) ? rest : "" };
}

/**
 * A raw WebSocket upgrade request to cua-spacesd, or null when the path (query included) holds anything outside
 * printable ASCII: a CR/LF there would let a second request, carrying the token, ride the same connection.
 */
function upgradeRequest({ path, host, token, headers = {}, upgrade = true }) {
  if (typeof path !== "string" || !path.startsWith("/") || !PRINTABLE.test(path)) return null;
  const lines = [`GET ${path} HTTP/1.1`, `Host: ${host}`, `Authorization: Bearer ${token}`];
  if (upgrade) lines.push("Connection: Upgrade", "Upgrade: websocket");
  for (const [k, v] of Object.entries(headers)) {
    if (/[\r\n\0]/.test(String(k)) || /[\r\n\0]/.test(String(v))) return null;
    lines.push(`${k}: ${v}`);
  }
  return lines.join("\r\n") + "\r\n\r\n";
}

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

function body(req, max = 4096) {
  return raw(req, max).then((b) => {
    try {
      return JSON.parse(b.toString("utf8") || "{}");
    } catch {
      throw new Error("bad json");
    }
  });
}

function raw(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const parts = [];
    req.on("data", (b) => ((n += b.length) > max ? (reject(Object.assign(new Error("body too large"), { status: 413 })), req.destroy()) : parts.push(b)));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

const ORD = (n) => (n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);

class Spaces {
  /**
   * @param {object} o
   * @param {"shared"|"agent"|"overflow"} o.mode
   * @param {import("./space-lock").SpaceLock} o.lock
   * @param {{url: string, tokenFile: string}|null} o.spacesd  cua-spacesd on loopback, or null (no viewer)
   * @param {import("./desktops").Desktops|null} [o.desktops] phase 2: each agent's own desktop, or null
   * @param {object|null} [o.local] the agent host's DesktopHost (app/main/desktop-host.js): list(), tokenOf()
   * @param {import("./space-tunnel").SpaceTunnel|null} [o.tunnel] the way to Deck-hosted desktops
   * @param {() => string[]} [o.profiles] the configured agents (one entry each in agent mode)
   */
  constructor({ mode = "shared", lock, presence = null, spacesd = null, desktops = null, audit = null, approvals = null, local = null, tunnel = null, profiles = () => [], sharedProfiles = () => [], startWaitMs = 2000, now = () => Date.now(), fetch: f = globalThis.fetch, agentName = (p) => p } = {}) {
    Object.assign(this, { mode: this.perDesktop(mode) ? mode : "shared", lock, presence, spacesd, desktops, audit, approvals, local, tunnel, profiles, sharedProfiles, startWaitMs, now, fetch: f, agentName });
    if (desktops) desktops.onSnapshot = (profile, host, notice) => audit?.record({ profile, host,
      noticeId: notice.id, tool: notice.event === "stopped" ? "desktop" : "snapshot", args: {},
      time: notice.time, event: notice.event, outcome: ["failed", "cleanup-failed"].includes(notice.event) ? "error" : "ok", duration: 0 });
    this.endSpace = () => {};
    this.online = false;
    this.viewers = new Set(); // live proxied view sockets of the shared space
    this.userSince = null;
    this.lostSince = null; // when the last view socket closed while the user held the desktop
    this.level = "watch"; // the user's control level on the shared space
    this.lastPoll = null; // the last GET /spaces from a Deck (its panel asks every 3 s while shown)
    this.ctl = new Map(); // agent desktop id (profile) -> {level, user, userSince, lostSince, viewers: Set}
    this.seen = new Map(); // agent desktop id -> until when a Deck's poll says it shows it from its own loopback
  }

  perDesktop(mode = this.mode) {
    return mode === "agent" || mode === "overflow";
  }

  _token() {
    try {
      return fs.readFileSync(this.spacesd.tokenFile, "utf8").trim();
    } catch {
      return "";
    }
  }

  _ctl(id) {
    let c = this.ctl.get(id);
    if (!c) this.ctl.set(id, (c = { level: "watch", user: false, userSince: null, lostSince: null, viewers: new Set() }));
    return c;
  }

  /** An agent desktop in use by the user (a view socket or full control) is never stopped as idle. */
  _watch(id) {
    const c = this.ctl.get(id);
    const polledView = (this.seen.get(id) || 0) > this.now();
    if (this.desktops && typeof this.desktops.watching === "function") this.desktops.watching(id, polledView || (!!c && (c.viewers.size > 0 || c.user)));
  }

  /** An agent the relay knows: configured (agents.json), in the desktop registry, or with a home host. */
  _known(id) {
    if (!goodProfile(id)) return false;
    let configured = [];
    try {
      configured = this.profiles() || [];
    } catch {}
    if (configured.includes(id) || this.ctl.has(id)) return true;
    if (this.desktops?.homes && Object.prototype.hasOwnProperty.call(this.desktops.homes, id)) return true;
    return (this.desktops?.list() || []).some((r) => r.profile === id);
  }

  _off(id) {
    if (this.desktops && typeof this.desktops.markOff === "function") this.desktops.markOff(id);
  }

  /**
   * May `profile` act now? deviceKind is the driver route: "host" (the shared space), "space:<profile>@<host>" (the
   * agent's own desktop, phase 2) or a device id. A read-only action (a capture, a window listing) only looks: it
   * takes neither the desktop nor a place in line. In per-agent mode the shared space has no lock, except for an
   * agent sent there because its own desktop is unavailable (`fallback`): those take turns as in shared mode.
   */
  gate(profile, deviceKind, { read = false, fallback = false } = {}) {
    if (typeof deviceKind === "string" && deviceKind.startsWith("space:")) {
      // an agent's own desktop: nobody else's actions wait on it; the user's full control there pauses its agent only
      const m = /^space:([^@]+)@/.exec(deviceKind);
      const c = this.ctl.get(m ? m[1] : profile);
      if (c && c.user) return { ok: false, busy: false, error: "The user is controlling your desktop." };
      return { ok: true };
    }
    if (deviceKind !== "host" || (this.mode === "agent" && !fallback) || read) return { ok: true };
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

  /**
   * A Deck asked for the spaces' state: its panel is alive. `watching`: the agent desktop it shows right now from its
   * own loopback (a desktop hosted on that Deck's computer has no view socket here): watched, like a view socket, until
   * WATCH_POLL_MS after the last such poll. Agent mode only, known agents only.
   */
  polled(watching = null) {
    this.lastPoll = this.now();
    const id = typeof watching === "string" ? watching : "";
    if (!id || !this.perDesktop() || !this.desktops || !this._known(id)) return;
    this.seen.set(id, this.now() + WATCH_POLL_MS);
    this._ctl(id).lostSince = null; // a view, as far as full control's view-loss rule goes
    this._watch(id);
  }

  sweep() {
    this.lock.sweep();
    const t = this.now();
    // full control ends 30 s after the Deck is gone: no view socket left, or (a socket can stay half-open when a
    // Deck crashes or its machine sleeps) no Deck asking for /spaces any more. Per desktop.
    const deckGone = this.lastPoll !== null && t - this.lastPoll >= VIEW_LOSS_MS;
    const viewGone = !this.viewers.size && this.lostSince !== null && t - this.lostSince >= VIEW_LOSS_MS;
    if (this.lock.state().user && (viewGone || deckGone)) {
      this.releaseUser();
      this.level = "watch";
    }
    for (const [id, until] of this.seen) {
      if (t < until) continue;
      this.seen.delete(id); // no poll has said it is shown for WATCH_POLL_MS: the view is gone from then
      const c = this.ctl.get(id);
      if (c && !c.viewers.size && c.lostSince === null) c.lostSince = until;
      this._watch(id);
    }
    for (const [id, c] of this.ctl) {
      if (!c.user) continue;
      const gone = !c.viewers.size && !this.seen.has(id) && c.lostSince !== null && t - c.lostSince >= VIEW_LOSS_MS;
      if (gone || deckGone) {
        Object.assign(c, { user: false, userSince: null, level: "watch" });
        this._watch(id);
      }
    }
  }

  /** POST /spaces/control {space = "host", level}: watch, together, full (the user holds that desktop) or release. */
  async _control(b) {
    const level = String((b && b.level) || "");
    const space = String((b && b.space) || "host");
    if (!LEVELS.includes(level)) return { ok: false, error: "bad level" };
    if (space !== "host") {
      if (!this.desktops) return { ok: false, error: "no desktop host" };
      if (!this.perDesktop()) return { ok: false, error: "not in agent mode" }; // shared mode is phase 1, strictly
      if (!goodProfile(space)) return { ok: false, error: "bad space" };
      if (!this._known(space)) return { ok: false, error: "unknown agent" }; // no unbounded control entries
      this.polled();
      const c = this._ctl(space);
      if (level === "full") {
        c.user = true;
        c.userSince = this.now();
        if (!c.viewers.size) c.lostSince = this.now(); // control without any view expires too
      } else Object.assign(c, { user: false, userSince: null });
      c.level = level === "release" ? "watch" : level;
      this._watch(space);
      return { ok: true, state: { holder: c.user ? "user" : null, user: c.user } };
    }
    this.polled(); // a control request is a sign of life too
    if (level === "full") {
      this.takeUser();
      if (!this.viewers.size) this.lostSince = this.now(); // control without any view expires too
    } else if (this.lock.state().user) this.releaseUser();
    this.level = level === "release" ? "watch" : level;
    return { ok: true, state: this.lock.state() };
  }

  /** POST /spaces/mode: shared, or agent (one desktop per agent) once a desktop registry is configured. */
  async _mode(b) {
    const m = String((b && b.mode) || "");
    if (m === "shared") return { ok: true, mode: (this.mode = "shared") };
    if (this.perDesktop(m)) return this.desktops ? { ok: true, mode: (this.mode = m) } : { ok: false, error: "no desktop host" };
    return { ok: false, error: "bad mode" };
  }

  /** POST /spaces/home {profile, host: "auto"|"agent-host"|<device id>}: validated and stored by Desktops. */
  async _home(b) {
    if (!this.desktops) return { ok: false, error: "no desktop host" };
    return this.desktops.setHome(String((b && b.profile) || ""), String((b && b.host) || ""));
  }

  /** POST /spaces/desktop {profile, action: "start"|"stop"}: the Deck's Start / Stop. A start answers within startWaitMs. */
  async _desktop(b) {
    if (!this.desktops) return { ok: false, error: "no desktop host" };
    const profile = String((b && b.profile) || "");
    if (!goodProfile(profile)) return { ok: false, error: "bad profile" };
    const action = b && b.action;
    if (action === "stop") {
      await this.desktops.stop(profile);
      return { ok: true, state: this.desktops.state(profile) };
    }
    if (action !== "start") return { ok: false, error: "bad action" };
    if (!this.perDesktop()) return { ok: false, error: "not in agent mode" };
    if (!this._known(profile)) return { ok: false, error: "unknown agent" }; // no containers or volumes for arbitrary names
    let timer = null;
    const started = Promise.resolve()
      .then(() => this.desktops.start(profile))
      .catch(() => ({ kind: "fallback", reason: "failed" }));
    const slow = new Promise((r) => (timer = setTimeout(() => r({ kind: "starting" }), this.startWaitMs)));
    try {
      const r = (await Promise.race([started, slow])) || { kind: "fallback", reason: "failed" };
      if (r.kind === "fallback") return { ok: false, error: r.reason || "failed" };
      return { ok: true, state: r.kind === "starting" ? "starting" : this.desktops.state(profile) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Shared space view sockets (phase 1). */
  viewerOpened() {
    this.viewers.add(Symbol("v"));
    this.lostSince = null;
  }

  viewerClosed() {
    const first = this.viewers.values().next().value;
    if (first) this.viewers.delete(first);
    if (!this.viewers.size) this.lostSince = this.now();
  }

  /** A view socket opened on space `id`; returns its handle for _viewerClosed. */
  _viewerOpened(id) {
    if (id === "host") return void this.viewerOpened();
    const c = this._ctl(id);
    const v = Symbol("v");
    c.viewers.add(v);
    c.lostSince = null;
    this._watch(id);
    return v;
  }

  _viewerClosed(id, v) {
    if (id === "host") return void this.viewerClosed();
    const c = this._ctl(id);
    c.viewers.delete(v);
    if (!c.viewers.size) c.lostSince = this.now();
    this._watch(id);
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
    res.on("close", () => {
      if (!res.writableFinished) up.destroy(); // the viewer left first: end the request to cua-spacesd too
    });
    req.pipe(up);
  }

  /** The row of an agent desktop the relay knows, or null. */
  _row(id) {
    if (!this.desktops || !this.perDesktop() || !goodProfile(id)) return null; // shared mode: phase 1 only
    return this.desktops.list().find((r) => r.profile === id) || null;
  }

  /** One viewer request to an agent's desktop: loopback on the agent host, the tunnel for a Deck's. */
  async _agentHttp(req, res, id, row, rest, url) {
    // the decoded rest is forwarded (the Deck's loopback route does the same, for parity); viewPath's allow-list regexes are anchored
    const path = `/${rest}${url.search}`;
    const headers = pickHeaders(req.headers, "view");
    let b;
    try {
      b = await raw(req, MAX_VIEW_BODY);
    } catch (e) {
      return send(res, e.status || 400, { ok: false, error: e.message });
    }
    if (row.host === "agent-host") {
      const tg = await localTarget(this.desktops, this.local, id);
      if (!tg) {
        this._off(id);
        return send(res, 502, { ok: false, error: NOT_RUNNING });
      }
      const h = { ...headers, host: `127.0.0.1:${tg.port}`, authorization: `Bearer ${tg.token}` };
      if (b.length || (req.method !== "GET" && req.method !== "HEAD")) h["content-length"] = String(b.length);
      const up = http.request({ host: "127.0.0.1", port: tg.port, method: req.method, path, headers: h }, (r) => {
        res.writeHead(r.statusCode || 502, { ...responseHeaders(r.headers, tg.token), ...(r.headers["content-length"] ? { "content-length": r.headers["content-length"] } : {}) });
        r.pipe(res);
      });
      up.on("error", (e) => {
        if (e && e.code === "ECONNREFUSED") this._off(id);
        if (!res.headersSent) send(res, 502, { ok: false, error: e && e.code === "ECONNREFUSED" ? NOT_RUNNING : "space offline" });
        else res.destroy();
      });
      res.on("close", () => {
        if (!res.writableFinished) up.destroy(); // the viewer left first (a held Join stream): end the desktop's request
      });
      return void up.end(b);
    }
    if (!this.tunnel) return send(res, 502, { ok: false, error: "space offline" });
    // streamed (11b): the answer reaches the viewer as the Deck sends it, so a server stream (PresenceService/Join)
    // stays open; the viewer going aborts the desktop's request on the Deck. MCP and /health stay buffered (space-fetch.js).
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
    });
    let r;
    try {
      r = await this.tunnel.stream(row.host, { profile: id, method: req.method, path, headers, body: b, signal: ac.signal });
    } catch (e) {
      if (ac.signal.aborted) return; // nobody to answer
      if (isNotRunning(e)) this._off(id);
      return send(res, (e && e.status) || 502, { ok: false, error: String((e && e.message) || "space offline").slice(0, 300) });
    }
    const len = r.headers["content-length"];
    res.writeHead(r.status, { ...responseHeaders(r.headers), ...(typeof len === "string" && /^\d{1,15}$/.test(len) ? { "content-length": len } : {}) });
    r.body.on("error", () => res.destroy()); // broke off, idle, the Deck gone: the viewer sees a cut answer, not a whole one
    r.body.pipe(res);
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
    const shared = new Set(this.mode === "overflow" ? this.sharedProfiles() : []);
    if (this.mode === "overflow" && st.holder && !st.user) shared.add(st.holder);
    const out = {
      mode: this.mode,
      spaces: [{ id: "host", kind: "shared", viewer: !!this.spacesd, online: this.online, holder: st.holder, user: st.user, queue: st.queue, level: this.level, holderName: st.holder && st.holder !== "user" ? this.agentName(st.holder) || st.holder : null }],
    };
    if (this.desktops) {
      // hosts and home hosts for Settings (shown in every mode, so phase 2 can be set up before it is switched on)
      out.hosts = (this.desktops.hosts() || []).map(({ id, name, ready, limit, running }) => ({ id, name, ready, limit, running }));
      out.homes = { ...(this.desktops.homes || {}) };
      if (this.perDesktop()) {
        const rows = new Map(this.desktops.list().filter((r) => goodProfile(r.profile)).map((r) => [r.profile, r]));
        const ids = [...rows.keys()];
        let configured = [];
        try {
          configured = this.profiles() || [];
        } catch {}
        for (const p of [...configured, ...Object.keys(out.homes), ...this.ctl.keys()]) if (goodProfile(p) && !ids.includes(p)) ids.push(p);
        for (const id of ids) {
          const r = rows.get(id);
          const host = r ? r.host : null;
          const h = host ? out.hosts.find((x) => x.id === host) : null;
          const c = this.ctl.get(id);
          out.spaces.push({
            id,
            kind: "agent",
            host,
            hostName: h ? h.name : null,
            state: r ? r.state : "off",
            usingShared: shared.has(id), // routing status; keep the own desktop's state for its controls
            online: !!(r && r.state === "ready" && h && h.ready),
            level: c ? c.level : "watch",
            user: !!(c && c.user),
            holderName: this.agentName(id) || id,
            fallback: typeof this.desktops.fallbackOf === "function" ? this.desktops.fallbackOf(id) : null, // why it is on the shared desktop
          });
        }
      }
    }
    // agents moved to a Deck device ("Work on this device"): per-profile desktop pins
    out.here = this.presence
      ? this.presence
          .pinList()
          .filter((p) => p.capability === "desktop" && p.host && p.host.kind === "device" && /^p:/.test(p.sessionKey))
          .map((p) => ({ profile: p.sessionKey.slice(2), device: p.host.id }))
      : [];
    return out;
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
  _safetyRoute(req, res, url) {
    const p = url.pathname;
    const match = /^\/spaces\/([^/]+)\/(audit(?:\/frame\/([^/]+))?|snapshots(?:\/delete)?|restore)$/.exec(p);
    const answer = /^\/spaces\/approvals\/([a-f0-9-]{36})$/.exec(p);
    if (p !== "/spaces/settings" && p !== "/spaces/approvals" && !answer && !match) return false;
    const run = async () => {
      if (!this.audit || !this.approvals || !this.desktops) return send(res, 503, { ok: false, error: "safety-unavailable" });
      const method = req.method;
      if (p === "/spaces/settings") {
        if (method === "GET") return send(res, 200, { settings: this.audit.settings() });
        if (method === "POST") return send(res, 200, { ok: true, settings: this.audit.update(await body(req)) });
      }
      if (p === "/spaces/approvals" && method === "GET") return send(res, 200, { approvals: this.approvals.list() });
      if (answer && method === "POST") {
        const b = await body(req);
        if (!b || !["once", "deny"].includes(b.choice) || Object.keys(b).some((k) => !["choice", "withoutSnapshot"].includes(k)) || (b.withoutSnapshot !== undefined && typeof b.withoutSnapshot !== "boolean"))
          return send(res, 400, { ok: false, error: "bad-request" });
        const r = await this.approvals.answer(answer[1], b);
        return send(res, r.ok ? 200 : 409, r);
      }
      if (match) {
        const [, profile, route, frame] = match;
        if (!this._known(profile)) return send(res, 404, { ok: false, error: "unknown-agent" });
        if (route === "audit" && method === "GET") {
          const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
          return send(res, 200, await this.audit.page(profile, { before: url.searchParams.get("before") || "", limit }));
        }
        if (frame && method === "GET") {
          const f = await this.audit.frame(profile, frame);
          if (!f) return send(res, 404, { ok: false, error: "frame-unavailable" });
          res.writeHead(200, { "content-type": f.mime, "cache-control": "no-store", "x-content-type-options": "nosniff" });
          return res.end(f.bytes);
        }
        if (route === "snapshots" && method === "GET") {
          const r = await this.desktops.snapshots(profile);
          return send(res, 200, { ok: true, ...r });
        }
        if (route === "restore" && method === "POST") {
          const b = await body(req);
          if (!b || Object.keys(b).length !== 1 || typeof b.id !== "string" || !/^[a-f0-9-]{36}$/.test(b.id)) return send(res, 400, { ok: false, error: "bad-request" });
          this.endSpace(profile);
          return send(res, 200, await this.desktops.restore(profile, b.id));
        }
        if (route === "snapshots/delete" && method === "POST") {
          const b = await body(req);
          if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).length) return send(res, 400, { ok: false, error: "bad-request" });
          return send(res, 200, await this.desktops.dropSnapshot(profile));
        }
      }
      send(res, 405, { ok: false, error: "bad-method" });
    };
    run().catch((e) => {
      if (!res.headersSent) send(res, /bad (?:settings|cursor|limit|json)/.test(e.message) ? 400 : 409,
        { ok: false, error: /bad (?:settings|cursor|limit|json)/.test(e.message) ? "bad-request" : "operation-failed" });
    });
    return true;
  }

  onHttp(req, res, url) {
    const p = url.pathname;
    if (this._safetyRoute(req, res, url)) return true;
    if (p === "/spaces" && req.method === "GET") return this.polled(url.searchParams.get("watching")), send(res, 200, this.list()), true;
    const post = { "/spaces/route": "_route", "/spaces/control": "_control", "/spaces/mode": "_mode", "/spaces/home": "_home", "/spaces/desktop": "_desktop" }[p];
    if (post && req.method === "POST") {
      body(req)
        .then(async (b) => send(res, 200, await this[post](b)))
        .catch((e) => send(res, 400, { ok: false, error: e.message }));
      return true;
    }
    if (p.startsWith("/spaces/")) {
      const m = VIEW_RE.exec(p);
      const id = m ? m[1] : null;
      const c = id && id !== "host" ? this.ctl.get(id) : null;
      const v = viewPath(p, id === "host" ? this.level !== "watch" : !!c && c.level !== "watch");
      if (!v || !v.rest) return send(res, 403, { ok: false, error: "not allowed" }), true;
      if (v.id === "host") {
        if (!this.spacesd) return send(res, 403, { ok: false, error: "not allowed" }), true;
        this._proxyHttp(req, res, v.rest, url);
        return true;
      }
      const row = this._row(v.id);
      if (!row) return send(res, 404, { ok: false, error: "no such desktop" }), true;
      this._agentHttp(req, res, v.id, row, v.rest, url).catch(() => {
        if (!res.headersSent) send(res, 502, { ok: false, error: "space offline" });
      });
      return true;
    }
    return false;
  }

  /** WebSocket to a space (the viewer's media socket), with the container token added on the desktop's host. */
  onUpgrade(req, socket, head, url) {
    if (!url.pathname.startsWith("/spaces/")) return false;
    // the answer, then the socket is gone: a half-open client must not keep a view (and a desktop's watch) alive
    const refuse = (status) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`, () => socket.destroy());
      const t = setTimeout(() => socket.destroy(), 1000);
      if (t.unref) t.unref();
    };
    const v = viewPath(url.pathname, false);
    if (!v || !v.rest) return refuse("403 Forbidden"), true;
    if (v.id === "host") {
      if (!this.spacesd) return refuse("403 Forbidden"), true;
      const target = new URL(this.spacesd.url);
      // the Deck's origin is not cua-spacesd's; the probe ran without it
      const kept = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/^(host|authorization|cookie|origin)$/i.test(k)));
      const head0 = upgradeRequest({ path: `/${v.rest}${url.search}`, host: target.host, token: this._token(), headers: kept, upgrade: false });
      if (!head0) return refuse("400 Bad Request"), true;
      const up = net.connect(Number(target.port), target.hostname, () => {
        up.write(head0);
        if (head && head.length) up.write(head);
        up.pipe(socket).pipe(up);
      });
      this.viewerOpened();
      socket.once("close", () => this.viewerClosed());
      up.on("error", () => socket.destroy());
      socket.on("error", () => up.destroy());
      return true;
    }
    const row = this._row(v.id);
    if (!row) return refuse("404 Not Found"), true;
    const path = `/${v.rest}${url.search}`;
    if (!PRINTABLE.test(path)) return refuse("400 Bad Request"), true;
    const headers = pickHeaders(req.headers, "ws");
    const id = v.id;
    const handle = this._viewerOpened(id); // a view socket keeps that desktop from its idle stop while open
    socket.once("close", () => this._viewerClosed(id, handle));
    socket.on("error", () => socket.destroy());
    if (row.host !== "agent-host") {
      let sock;
      try {
        if (!this.tunnel) throw new Error("no tunnel");
        sock = this.tunnel.openWs(row.host, { profile: id, path, headers: { ...headers, upgrade: "websocket", connection: "Upgrade" } });
      } catch {
        return refuse("502 Bad Gateway"), true;
      }
      sock.on("data", (d) => socket.write(d));
      sock.on("close", () => socket.destroy()); // the Deck went (removeDeck), refused, or closed it
      socket.on("data", (d) => sock.send(d));
      socket.once("close", () => sock.close("the viewer closed"));
      if (head && head.length) sock.send(head);
      return true;
    }
    localTarget(this.desktops, this.local, id).then((tg) => {
      if (socket.destroyed) return;
      if (!tg) {
        this._off(id);
        return refuse("502 Bad Gateway");
      }
      const head0 = upgradeRequest({ path, host: `127.0.0.1:${tg.port}`, token: tg.token, headers });
      if (!head0) return refuse("400 Bad Request");
      const up = net.connect(tg.port, "127.0.0.1", () => {
        up.write(head0);
        if (head && head.length) up.write(head);
        up.pipe(socket).pipe(up);
      });
      up.on("error", (e) => {
        if (e && e.code === "ECONNREFUSED") this._off(id);
        socket.destroy();
      });
      socket.on("close", () => up.destroy());
    });
    return true;
  }
}

module.exports = { Spaces, makeSpaceFetch, makeReady, pickHeaders, viewPath, upgradeRequest, NOT_RUNNING };
