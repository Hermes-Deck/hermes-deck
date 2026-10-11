"use strict";
// Bot screen, agent-host side (docs/bot-screen-protocol.md). Hermes runs relay/bin/deck-cua instead of
// cua-driver; this module decides where each driver session goes and carries it there.
//   local driver socket   $DECK_HOME/driver.sock, mode 0600. deck-cua sends {t:"hello"} and gets a route, then
//                         its stdio; the deck-events plugin sends {t:"query"} for the route and grant its fence uses.
//   device channel        binary frames on each deck's own relay connection, next to the CDP tunnel:
//                           [0xD5][op u8][channel u32 BE][payload]
//                         so a desktop opens no inbound port and keeps one outbound connection.
//   HTTP (relay token)    POST /desktop/lease, POST /desktop/stop, GET /cu/<frame>
// Routing is presence.js's "desktop" capability. The agent host itself is presence's fallback for it, and only
// when DECK_DESKTOP_HOST=1. Every MCP message to a device passes the relay's own fence (mcpfence.js).
const fs = require("fs");
const net = require("net");
const path = require("path");
const { execFile } = require("child_process");
const { randomUUID } = require("node:crypto");
const { risky, preview, advance } = require("./risky-commands");
const wire = require("./driver-wire");
const { hermesPython } = require("./hermes-python");
const devtokens = require("./devtokens");
const { McpFence, checkCall, checkSpaceCall, lines, toolError, filterListing, appsAnswer, fenceGrant, int } = require("./mcpfence");
const { McpHttpBridge } = require("./space-mcp");
const { home } = require("./util");

const CAP = "desktop";
const MAGIC = 0xd5;
// HELLO, GRANT, REVOKE, STOPPED, ERR: deck -> relay. READY, OPEN, STOP: relay -> deck. DATA, CLOSE: both ways.
const OP = Object.freeze({ HELLO: 1, READY: 2, OPEN: 3, DATA: 4, ERR: 5, CLOSE: 6, STOP: 7, STOPPED: 8, GRANT: 9, REVOKE: 10 });
const HEADER = 6;
const ID_RE = /^[a-f0-9]{8,64}$/; // presence.js device ids
const EXIT_ENDED = 75; // deck-cua's exit code when the relay ends a session (stop, device gone, route moved)
const MAX_CHANNELS = 32; // per device
const HELLO_MS = 5000;
const FRAME_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
// Hermes shows the agent only the last stderr line of a failed driver probe, cut at 200 chars: keep it short.
const NO_ROUTE =
  "Bot screen: no device is available for computer_use (Desktop control off, or the computer is locked or idle) and the agent host is not allowed. Ask the user.";
// Agent spaces phase 2: the agent's own desktop. A query waits this long for it, then answers "starting" (busy):
// the plugin's busy loop asks again, and the desktop keeps starting meanwhile (desktops.js shares one start).
const DESKTOP_WAIT_MS = 2000;
const HELLO_DESKTOP_MS = 13_000; // deck-cua's hello waits this long for a starting desktop (its own ROUTE_MS is 15 s)
const STARTING = "Your desktop is starting; retry the same action now.";
const WENT_AWAY = "Your desktop went away; retry the same action now.";
// Info verbs on an agent's own desktop are answered here, without starting it. The manifest is metadata only: its
// mcp_invocation is what Hermes launches, and deck-cua points the command back at itself (bot-screen-protocol.md:29).
const INFO_VERBS = new Set(["manifest", "--help", "status", "doctor"]);
// Hermes' computer_use starts only with a manifest that meets its cua-driver runtime contract: a semantic
// binary_version >= 0.20.0 and the mcp/serve/stop flags advertised (its _manifest_contract_reason). The version is
// the cua-driver inside the pinned desktop image (docs/agent-spaces.md). The flags are only
// advertised: Hermes passes none of them in standard mode, and the space route ignores the argv after `mcp`.
const SPACE_DRIVER_VERSION = "0.34.0";
const flags = (...names) => names.map((name) => ({ name }));
const SPACE_MANIFEST = Object.freeze({
  name: "cua-spacesd",
  binary_version: SPACE_DRIVER_VERSION,
  schema_version: "1",
  mcp_invocation: { command: "deck-cua", args: ["mcp"] },
  subcommands: [
    { name: "mcp", args: flags("--socket", "--grant") },
    { name: "serve", args: flags("--socket", "--permission-mode", "--capability-manifest", "--approve-capability-manifest", "--embedded") },
    { name: "stop", args: flags("--socket") },
  ],
});
// no desktop of its own and the shared desktop not offered as a fallback (DECK_SPACES_SHARED_FALLBACK=0)
const NO_DESKTOP = Object.freeze({
  offline: "Your desktop host is offline; ask the user.",
  limit: "Every desktop host is full right now; retry later or ask the user.",
  failed: "Your desktop could not start; ask the user to check Settings > This device > Agent desktops.",
  none: "No desktop host is available; ask the user.",
});

// ---- device frames ---------------------------------------------------------------------------------
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

/** {op, ch, payload: Buffer} or null for anything that is not a driver frame (CDP tunnel frames start with 0xCD). */
function decodeFrame(data) {
  const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
  if (buf.length < HEADER || buf[0] !== MAGIC || buf[1] < OP.HELLO || buf[1] > OP.REVOKE) return null;
  return { op: buf[1], ch: buf.readUInt32BE(2), payload: buf.subarray(HEADER) };
}

function frameJson(payload) {
  try {
    const v = JSON.parse(payload.toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const clean = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n) : "");

/** The grant shape of the contract, validated and size-capped, or null. Accepts {grant: {...}} or the grant itself. */
function cleanGrant(m) {
  const g = m && typeof m === "object" && m.grant && typeof m.grant === "object" ? m.grant : m;
  if (!g || typeof g !== "object" || !g.window || typeof g.window !== "object") return null;
  const id = int(g.window.id);
  const pid = int(g.window.pid);
  if (!id || !pid) return null;
  return {
    agent: clean(g.agent, 64),
    app: clean(g.app, 128),
    window: { id, pid, title: clean(g.window.title, 256) },
    expires: Number.isFinite(g.expires) ? g.expires : null,
    idleMin: Number.isFinite(g.idleMin) ? g.idleMin : null,
    foreground: g.foreground === true,
  };
}

function parseObject(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function reply(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (b) => {
      n += b.length;
      if (n > max) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(b);
    });
    req.on("end", () => {
      const v = parseObject(Buffer.concat(chunks).toString("utf8") || "{}");
      resolve(v);
    });
    req.on("error", reject);
  });
}

const rm = (p) => {
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Bot-screen settings from the relay's environment (see .env.example). */
function driverConfig(env = process.env) {
  const deckHome = wire.expandHome(env.DECK_HOME) || home(".hermes-deck");
  const envFile = env.DECK_RELAY_ENV || path.join(__dirname, "..", ".env");
  const venvPython = home(".hermes", "hermes-agent", "venv", "bin", "python");
  const stickySec = Number(String(env.DECK_SPACES_STICKY_SEC ?? "").trim() || 120);
  return {
    deckHome,
    sockPath: env.DECK_DRIVER_SOCK || wire.defaultSockPath(deckHome),
    cuDir: path.join(deckHome, "cu"),
    tokensFile: env.DECK_DEVICE_TOKENS || path.join(path.dirname(envFile), "devices.json"),
    hermesPython: hermesPython({ configured: [["DECK_HERMES_PYTHON", wire.expandHome(env.DECK_HERMES_PYTHON)]], venv: venvPython, exists: fs.existsSync, warn: (m) => console.warn("deck-relay driver:", m) }),
    desktopHost: /^(1|true|yes|on)$/i.test(String(env.DECK_DESKTOP_HOST || "").trim()),
    stickyMs: Math.max(30, Math.min(900, Number.isFinite(stickySec) ? stickySec : 120)) * 1000,
  };
}

// In agent mode a verb other than mcp, call and the info verbs (final review I4): Hermes' manifest contract advertises
// serve and stop, so this line tells the agent what to keep instead of starting a desktop for nothing.
const AGENT_MCP_ONLY = "On an agent's own desktop only the MCP transport is available; keep computer_use.permission_mode at standard.";

class Driver {
  /**
   * @param {object} o
   * @param {import("./presence").Presence} o.presence routing ("desktop" capability) and the decks' connections
   * @param {(profile: string) => string} [o.agentName] profile -> display name (grants name the agent)
   * @param {import("./desktops").Desktops|null} [o.desktops] agent spaces phase 2: each agent's own desktop
   * @param {((host: string, profile: string) => (req: object) => Promise<object>)|null} [o.spaceFetch] HTTP to one
   *   agent desktop's cua-spacesd (direct on the agent host, the space tunnel for a Deck computer)
   * @param {boolean} [o.sharedFallback] no own desktop: fall back to the shared desktop (DECK_SPACES_SHARED_FALLBACK)
   * plus the driverConfig() fields and optional limits: cuMaxAgeMs, cuMaxBytes, pruneEveryMs, tokenCheckMs, desktopWaitMs,
   * helloDesktopMs.
   */
  constructor({ presence, spaces = null, desktops = null, spaceFetch = null, sharedFallback = true, agentName = (p) => p, log = (...a) => console.log("deck-relay driver:", ...a), spaceAudit = null, spaceApprovals = null, riskyPatterns = [], ...o }) {
    this.o = {
      desktopWaitMs: DESKTOP_WAIT_MS,
      helloDesktopMs: HELLO_DESKTOP_MS,
      stickyMs: 120_000,
      now: () => Date.now(),
      cuMaxAgeMs: 24 * 3600 * 1000,
      cuMaxBytes: 500 * 1024 * 1024,
      pruneEveryMs: 10 * 60 * 1000,
      tokenCheckMs: 15_000,
      leaseTimeoutMs: 15_000,
      leaseScript: path.join(__dirname, "..", "tools", "lease.py"),
      ...o,
    };
    this.presence = presence;
    this.spaces = spaces; // agent spaces (spaces.js): the shared desktop's lock, or null when spaces are off
    this.desktops = desktops; // agent spaces phase 2 (desktops.js): which agent desktop runs where, or null
    this.spaceFetch = spaceFetch;
    Object.assign(this, { spaceAudit, spaceApprovals, riskyPatterns });
    this.sharedFallback = sharedFallback !== false;
    this.spaceAnswered = new Map(); // route key -> when the plugin's last query answered the agent's own desktop
    this.sticky = new Map(); // overflow session key -> {route, last, read}; successful desktop choices only
    this.agentName = agentName;
    this.log = log;
    this.links = new Map(); // a deck's relay connection -> its driver link
    this.conns = new Set(); // deck-cua and plugin connections on the local socket
    this.sock = null;
    this.timers = [];
    this._ch = 0;
    // A route that moved (handoff) or whose device is gone ends the driver sessions on the old host, like the CDP
    // tunnel does for browsers. Hermes then reconnects on its next call and lands on the new route; it never
    // replays an action whose outcome it does not know.
    this._onRoute = ({ old, why }) => {
      if (!old || old.capability !== CAP || (why !== "handoff" && why !== "lost")) return;
      const reason = why === "handoff" ? "computer_use moved to another device" : "the device is no longer available";
      for (const c of [...this.conns]) if (c.route === old && c.kind && !c.done) this._end(c, EXIT_ENDED, `Bot screen: ${reason}; an action in flight may not have completed`);
    };
    presence.on("route", this._onRoute);
  }

  // ---- lifecycle ----------------------------------------------------------------------------------
  async start() {
    fs.mkdirSync(this.o.deckHome, { recursive: true, mode: 0o700 });
    await this._listen();
    this.timers.push(setInterval(() => this.prune(), this.o.pruneEveryMs));
    this.timers.push(setInterval(() => this._checkTokens(), this.o.tokenCheckMs));
    this.prune();
  }

  _listen() {
    const p = this.o.sockPath;
    const posix = process.platform !== "win32";
    if (posix) {
      try {
        if (fs.lstatSync(p).isSocket()) fs.unlinkSync(p); // left over from a previous run
      } catch {
        /* none yet */
      }
    }
    const srv = net.createServer((s) => this._onLocal(s));
    this.sock = srv;
    return new Promise((resolve, reject) => {
      srv.once("error", reject);
      const umask = posix ? process.umask(0o177) : null; // the socket is born 0600: only this user may connect
      try {
        srv.listen(p, () => {
          srv.removeListener("error", reject);
          srv.on("error", (e) => this.log("driver socket error:", e.message));
          if (posix) {
            try {
              fs.chmodSync(p, 0o600);
            } catch {
              /* best effort; the umask already applied */
            }
          }
          resolve();
        });
      } finally {
        if (umask !== null) process.umask(umask);
      }
    });
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.presence.off("route", this._onRoute);
    for (const c of [...this.conns]) {
      if (c.kind && !c.done) this._end(c, EXIT_ENDED, "Bot screen: the relay is stopping");
      else c.s.destroy();
    }
    for (const link of this.links.values()) this._endLink(link, "the relay is stopping");
    return new Promise((resolve) => {
      if (!this.sock) return resolve();
      const t = setTimeout(() => {
        for (const c of this.conns) c.s.destroy();
      }, 1000);
      this.sock.close(() => {
        clearTimeout(t);
        if (process.platform !== "win32") rm(this.o.sockPath);
        resolve();
      });
    });
  }

  /** What is connected right now (tests, diagnostics). */
  state() {
    const devices = [...this.links.values()]
      .filter((l) => l.ok)
      .map((l) => ({ device: l.device, token: l.tokenName, os: l.os, driverOk: l.driverOk, grant: l.grant ? { agent: l.grant.agent, app: l.grant.app, title: l.grant.window.title } : null, channels: l.channels.size }));
    const sessions = [...this.conns].filter((c) => c.kind === "host" || c.kind === "device" || c.kind === "space").map((c) => ({ key: c.key, verb: c.verb, device: c.device }));
    return { devices, sessions };
  }

  // ---- deck links (called from index.js deckHooks) ----------------------------------------------------
  addDeck(ws) {
    if (!this.links.has(ws)) this.links.set(ws, { ws, ok: false, device: null, grant: null, channels: new Map(), pid: null, driverOk: false });
  }

  removeDeck(ws) {
    const link = this.links.get(ws);
    if (link) {
      this.links.delete(ws);
      this._endLink(link, "the device disconnected");
    }
    this._endOrphanSpaces();
  }

  /**
   * Space sessions on a Deck computer that has no connection left end now, also when idle (a request in flight
   * already fails through the tunnel). presence.disconnect runs before removeDeck, so connOf is already null.
   */
  _endOrphanSpaces() {
    for (const c of [...this.conns]) {
      if (c.kind !== "space" || c.done || c.spaceHost === "agent-host" || this.presence.connOf(c.spaceHost)) continue;
      this._end(c, EXIT_ENDED, "Bot screen: the computer that hosts your desktop disconnected; an action in flight may not have completed");
    }
  }

  /** A binary message from a deck: true when it was a driver frame (handled), false for anything else. */
  onFrame(ws, data) {
    const f = decodeFrame(data);
    if (!f) return false;
    const link = this.links.get(ws);
    if (!link) return true;
    try {
      this._deckFrame(link, f);
    } catch (e) {
      this.log("bad driver frame:", e.message);
    }
    return true;
  }

  _send(link, op, ch, payload) {
    if (!link || !link.ws || link.ws.readyState !== 1) return false;
    link.ws.send(encodeFrame(op, ch, payload), { binary: true });
    return true;
  }

  _deckFrame(link, { op, ch, payload }) {
    if (op === OP.HELLO) return this._deckHello(link, frameJson(payload));
    if (!link.ok) return; // nothing counts before an accepted hello
    const c = ch ? link.channels.get(ch) : null;
    switch (op) {
      case OP.DATA:
        if (!c) return;
        if (c.fence) c.fence.fromDevice(payload);
        else if (c.out) c.out.push(Buffer.from(payload));
        else this._toWrapper(c, "data", payload);
        return;
      case OP.ERR:
        if (c) this._toWrapper(c, "err", payload);
        return;
      case OP.CLOSE: {
        if (!c) return;
        const m = frameJson(payload) || {};
        this._closed(c, Number.isInteger(m.code) ? m.code : 1, typeof m.error === "string" ? m.error.slice(0, 300) : "");
        return;
      }
      case OP.GRANT:
        link.grant = cleanGrant(frameJson(payload));
        return;
      case OP.REVOKE:
        link.grant = null;
        return;
      case OP.STOPPED: {
        const m = frameJson(payload) || {};
        const by = clean(m.by, 20) || "stop";
        this._endLink(link, `the user stopped the agent on this device (${by})`);
        this._endRoutes((r) => r.host.kind === "device" && r.host.id === link.device);
        return;
      }
      default:
        return;
    }
  }

  _deckHello(link, m) {
    const ready = (ok, error) => this._send(link, OP.READY, 0, ok ? { ok: true } : { ok: false, error });
    if (!m || m.v !== 1) return ready(false, "bad driver hello");
    const id = String(m.device || "").toLowerCase();
    if (!ID_RE.test(id)) return ready(false, "bad device id");
    const name = devtokens.match(this.o.tokensFile, m.token);
    if (!name) {
      this._disable(link, "its device token was not accepted");
      return ready(false, "device token not accepted: issue one on the agent host (node tools/device-token.js add <name>) and enter it in Hermes Deck");
    }
    if (link.ok && link.device !== id) this._endLink(link, "the device changed its id");
    Object.assign(link, {
      ok: true,
      device: id,
      tokenName: name,
      tokenHash: devtokens.hash(m.token),
      os: clean(m.os, 16),
      deck: clean(m.deck, 32),
      driverOk: !!(m.driver && typeof m.driver === "object" && m.driver.ok === true),
      driverVersion: clean(m.driver && m.driver.version, 32),
      desktop: m.desktop === true,
      pid: int(m.pid),
    });
    ready(true);
  }

  _checkTokens() {
    for (const link of this.links.values()) {
      if (!link.ok || devtokens.stillValid(this.o.tokensFile, link.tokenName, link.tokenHash)) continue;
      this._disable(link, "its device token was revoked");
      this._send(link, OP.READY, 0, { ok: false, error: "device token revoked on the agent host" });
    }
  }

  _disable(link, why) {
    if (link.ok) this._endLink(link, why);
    link.ok = false;
  }

  _endLink(link, why) {
    for (const c of [...link.channels.values()]) this._end(c, EXIT_ENDED, `Bot screen: ${why}; an action in flight may not have completed`);
    link.channels.clear();
    link.grant = null;
  }

  /** End the presence routes that match (so the agent is not sent straight back). */
  _endRoutes(match) {
    let routes = [];
    try {
      routes = this.presence.state().routes || [];
    } catch {
      return;
    }
    for (const r of routes) if (r.capability === CAP && match(r)) this.presence.endSession(r.sessionKey, CAP);
  }

  /** The grant on this link for a profile's agent, or null (none, expired, or handed to another agent). */
  _grantFor(link, profile) {
    const g = link && link.grant;
    if (!g) return null;
    if (Number.isFinite(g.expires) && g.expires <= Date.now()) {
      link.grant = null;
      return null;
    }
    const who = g.agent.trim().toLowerCase();
    const names = [profile, this.agentName(profile)].map((n) => String(n || "").trim().toLowerCase());
    return who && names.includes(who) ? g : null;
  }

  /** Live fence context for one session: re-read on every call, so a new grant or a revoke applies at once. */
  _ctx(link, profile, name) {
    return () => ({ grant: fenceGrant(this._grantFor(link, profile), link.pid), deckPid: link.pid, device: name });
  }

  // ---- routing ------------------------------------------------------------------------------------------
  _route(key) {
    let r = null;
    try {
      r = this.presence.routeFor(key, CAP);
    } catch (e) {
      this.log("routeFor failed:", e.message);
    }
    if (!r) return { ok: false, error: NO_ROUTE, epoch: this.presence.epoch };
    if (r.host.kind !== "device") return { ok: true, r, device: "host", epoch: r.epoch };
    const id = r.host.id;
    const name = r.host.name || id;
    const link = this.links.get(this.presence.connOf(id));
    if (!link || !link.ok || link.device !== id) {
      return { ok: false, r, epoch: r.epoch, error: `Bot screen: ${name} has no driver channel to the relay right now (Hermes Deck closed, or no device token). Ask the user.` };
    }
    if (!link.driverOk) return { ok: false, r, epoch: r.epoch, error: `Bot screen: cua-driver is not ready on ${name}; the user can check it in Hermes Deck.` };
    return { ok: true, r, device: id, name, link, epoch: r.epoch };
  }

  // ---- agent spaces phase 2: the agent's own desktop ----------------------------------------------------------
  /** An asynchronous hello or query: anything that throws there still answers the wrapper or the plugin. */
  _agentStep(c, p) {
    p.catch((e) => {
      this.log("agent desktop route failed:", e && e.message);
      c.resolving = false;
      if (!c.done) this._fail(c, NO_DESKTOP.failed);
    });
  }

  /** Per-agent mode with a desktop registry: an agent's computer_use goes to its own desktop first. */
  _agentMode() {
    return !!(this.spaces && this.spaces.perDesktop() && this.desktops && this.spaceFetch);
  }

  _pruneSticky() {
    const now = this.o.now();
    for (const [key, entry] of this.sticky) {
      if (this.spaces?.mode !== "overflow" || now - entry.last >= this.o.stickyMs) this.sticky.delete(key);
    }
  }

  _rememberDesktop(key, route, read = false) {
    if (this.spaces?.mode === "overflow") this.sticky.set(key, { route, last: this.o.now(), read });
  }

  /** Overflow agents whose unexpired sessions use shared, excluding device overrides. */
  sharedProfiles() {
    this._pruneSticky();
    if (!this.sharedFallback || !this.presence.fallback.desktop) return [];
    return [...this.sticky].filter(([key, entry]) => entry.route.kind === "shared" && !this._devicePinned(key, key.slice(2).split("/")[0]))
      .map(([key]) => key.slice(2).split("/")[0]);
  }

  _reconcileDesktop(key, before, route) {
    this._pruneSticky();
    const current = this.sticky.get(key);
    // Another query/hello may have assigned this session while resolution awaited. Reconcile in the caller,
    // with no await before gating, recording or opening; an unused desktop can stop through normal idle cleanup.
    return current && current !== before ? current.route : route;
  }

  /** Pin checks happen first. Overflow keeps a session's actual desktop until a full idle window passes. */
  async _sessionDesktop(profile, key, waitMs) {
    if (this.spaces.mode !== "overflow") return this._desktopRoute(profile, waitMs);
    this._pruneSticky();
    const entry = this.sticky.get(key);
    if (entry) entry.last = this.o.now(); // busy calls and captures are still calls in this task
    const shared = this.sharedFallback && !!this.presence.fallback.desktop;
    if (entry?.route.kind === "shared") return shared ? entry.route : { kind: "unavailable", reason: "none" };
    this.spaces.lock.sweep();
    const holder = this.spaces.lock.state().holder;
    if (!entry && shared && (!holder || holder === profile)) return { kind: "shared" };
    const d = await this._desktopRoute(profile, waitMs);
    // A remembered own desktop must not silently move to another host or to shared while its windows are in use.
    if (entry && d.kind !== "starting" && (d.kind !== "space" || d.host !== entry.route.host)) {
      return { kind: "unavailable", reason: d.reason || "offline" };
    }
    return d.kind === "fallback" && shared ? { kind: "shared", reason: d.reason } : d;
  }

  /** "Work on this device": a device pin for this agent (or this exact key) wins over its own desktop (spec 4.3). */
  _devicePinned(key, profile) {
    if (typeof this.presence.pinOf !== "function") return false;
    const pin = this.presence.pinOf(`p:${profile}`, CAP) || this.presence.pinOf(key, CAP);
    return !!pin && pin.kind === "device";
  }

  /**
   * The agent's desktop from the registry, raced against waitMs: {kind:"space", host, port?}, {kind:"fallback",
   * reason}, or {kind:"starting"} when it is not ready in time (the start goes on). A registry that throws or
   * answers nonsense counts as a desktop that could not start.
   */
  async _desktopRoute(profile, waitMs = this.o.desktopWaitMs) {
    let timer = null;
    const resolving = Promise.resolve()
      .then(() => this.desktops.resolve(profile))
      .catch((e) => {
        this.log("desktop resolve failed:", e && e.message);
        return null;
      });
    const slow = Number.isFinite(waitMs) ? new Promise((r) => (timer = setTimeout(() => r({ kind: "starting" }), waitMs))) : null;
    try {
      const d = await (slow ? Promise.race([resolving, slow]) : resolving);
      if (d && d.kind === "space" && typeof d.host === "string" && d.host) return d;
      if (d && (d.kind === "starting" || (d.kind === "fallback" && NO_DESKTOP[d.reason]))) return d;
      return { kind: "fallback", reason: "failed" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---- the local socket -----------------------------------------------------------------------------------
  _onLocal(s) {
    const c = { s, kind: null, done: false, key: "", verb: "", argv: [], profile: "default", sid: "", skey: "", device: null, route: null, link: null, ch: 0, fence: null, out: null, filter: null, opened: false };
    this.conns.add(c);
    const t = setTimeout(() => {
      if (!c.kind && !c.done && !c.resolving) this._fail(c, "no hello");
    }, HELLO_MS);
    const feed = wire.lineReader(
      (m) => this._onLocalMsg(c, m),
      () => s.destroy()
    );
    s.on("data", feed);
    s.on("error", () => {});
    s.on("close", () => {
      clearTimeout(t);
      this._gone(c);
    });
  }

  _onLocalMsg(c, m) {
    if (c.done || c.resolving) return; // nothing is read while a hello waits for the agent's desktop
    if (!c.kind) {
      if (m.t === "query") return this._query(c, m);
      if (m.t === "hello") return this._hello(c, m);
      return this._fail(c, "bad request");
    }
    if (c.kind === "space") return this._spaceMsg(c, m);
    if (c.kind !== "device") return; // a host-route wrapper only listens (for exit)
    if (m.t === "data" && typeof m.b64 === "string") {
      const buf = Buffer.from(m.b64, "base64");
      if (c.fence) c.fence.fromHermes(buf);
      else this._send(c.link, OP.DATA, c.ch, buf);
    } else if (m.t === "close") {
      // Hermes closed the driver's stdin (end of its MCP session): stop the device process; its exit code
      // comes back as CLOSE and ends the wrapper.
      if (c.link.channels.get(c.ch) === c) this._send(c.link, OP.CLOSE, c.ch, { code: 0 });
    }
  }

  _identity(m) {
    const s = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
    const profile = s(m.profile, 64);
    return { profile: wire.PROFILE_RE.test(profile) ? profile : "default", sid: s(m.sid, 200), skey: s(m.skey, 500) };
  }

  _fail(c, error, code) {
    c.done = true;
    wire.send(c.s, { t: "route", ok: false, error, ...(code ? { code } : {}) });
    c.s.end();
  }

  _hello(c, m) {
    if (m.v !== 1 || !Array.isArray(m.argv) || m.argv.length > 256 || !m.argv.every((a) => typeof a === "string" && a.length <= 1 << 20)) return this._fail(c, "bad hello");
    Object.assign(c, this._identity(m));
    c.argv = m.argv.slice();
    c.verb = c.argv[0] || "";
    c.key = wire.routeKey(c);
    if (this._agentMode() && !this._devicePinned(c.key, c.profile)) {
      if (INFO_VERBS.has(c.verb)) return this._spaceInfo(c);
      if (c.verb === "call") return this._fail(c, "Bot screen: one-shot calls are not available on an agent's own desktop; use the MCP session", 126);
      // serve, stop and anything else: refused before _helloAgent, so they never start (or wait 13 s for) a desktop
      if (c.verb !== "mcp") return this._fail(c, AGENT_MCP_ONLY, 126);
      return this._agentStep(c, this._helloAgent(c));
    }
    this._helloRoute(c);
  }

  /** manifest, --help, status, doctor in per-agent mode: written here, no desktop is started for them. */
  _spaceInfo(c) {
    c.kind = "info";
    wire.send(c.s, { t: "route", ok: true, device: `space:${c.profile}`, epoch: this.presence.epoch });
    const text =
      c.verb === "manifest"
        ? JSON.stringify(SPACE_MANIFEST)
        : c.verb === "--help"
          ? "deck-cua: computer_use for this agent runs on the agent's own desktop; Hermes reaches it with `deck-cua mcp`."
          : `deck-cua: ${c.profile} works on the agent's own desktop; it starts on the first computer_use action.`;
    this._toWrapper(c, "data", Buffer.from(text + "\n"));
    this._finish(c, 0);
  }

  /** deck-cua's hello in per-agent mode: the whole start is waited for (Hermes runs it after the plugin's query said ok). */
  async _helloAgent(c) {
    c.resolving = true;
    const before = this.sticky.get(c.key);
    const selected = await this._sessionDesktop(c.profile, c.key, this.o.helloDesktopMs);
    c.resolving = false;
    if (c.done) return; // the wrapper gave up meanwhile
    const d = this._reconcileDesktop(c.key, before, selected);
    if (this.spaces.mode === "overflow") {
      if (d.kind === "starting") return this._fail(c, STARTING, EXIT_ENDED);
      if (d.kind !== "space" && d.kind !== "shared") return this._fail(c, NO_DESKTOP[d.reason]);
      const read = this.sticky.get(c.key)?.read === true;
      const device = d.kind === "shared" ? "host" : `space:${c.profile}@${d.host}`;
      const g = this.spaces.gate(c.profile, device, { read, fallback: true });
      if (!g.ok) return this._fail(c, d.reason ? `${NO_DESKTOP[d.reason]} ${g.error}` : g.error, EXIT_ENDED);
      this._rememberDesktop(c.key, d, read);
      return d.kind === "space" ? this._openSpace(c, d) : this._helloRoute(c, d.reason);
    }
    if (d.kind === "space") return this._openSpace(c, d);
    if (d.kind === "starting") return this._fail(c, STARTING, EXIT_ENDED); // before deck-cua gives up on the relay
    if (!this.sharedFallback) return this._fail(c, NO_DESKTOP[d.reason]);
    // The plugin's query saw the agent's own desktop and took no turn on the shared one: running there now would
    // skip its lock. When that query fell back too (a read-only one takes no turn), the shared desktop is fine.
    const saidSpace = this.spaceAnswered.delete(c.key);
    if (saidSpace && this.spaces.lock.state().holder !== c.profile) {
      const rt = this._route(c.key);
      if (rt.ok && rt.device === "host") return this._fail(c, WENT_AWAY, EXIT_ENDED);
    }
    this._helloRoute(c, d.reason); // phase 1's shared desktop
  }

  /** A space route: deck-cua's stdio MCP, carried to the desktop's Streamable HTTP /mcp by the bridge. */
  _openSpace(c, d) {
    if (c.verb !== "mcp") return this._fail(c, "Bot screen: only the MCP transport reaches an agent's own desktop", 126);
    let fetch;
    try {
      fetch = this.spaceFetch(d.host, c.profile);
    } catch (e) {
      this.log("spaceFetch failed:", e.message);
      return this._fail(c, NO_DESKTOP.failed);
    }
    c.kind = "space";
    c.spaceHost = d.host;
    c.device = `space:${c.profile}@${d.host}`;
    c.bridge = new McpHttpBridge({ fetch });
    c.lines = lines(); // Hermes' bytes, cut into whole lines for the fence
    this._initSpaceSafety(c);
    wire.send(c.s, { t: "route", ok: true, device: c.device, epoch: this.presence.epoch });
  }

  _spaceMsg(c, m) {
    if (m.t === "data" && typeof m.b64 === "string") {
      this.desktops.touch(c.profile); // in use: never stopped as idle
      for (const line of c.lines.push(Buffer.from(m.b64, "base64"))) this._spaceLine(c, line);
    } else if (m.t === "close") {
      // Hermes closed its MCP session: the answers still on their way go out, then the wrapper exits 0
      Promise.resolve(c.flow).then(() => {
        this._finish(c, 0);
        c.bridge.close();
      });
    }
  }

  _initSpaceSafety(c) {
    c.session = randomUUID(); c.typing = ""; c.flow = Promise.resolve(); c.current = null; c.replyLines = lines();
    c.bridge.on("data", (b) => this._spaceReply(c, b));
    c.bridge.on("close", () => {
      if (c.current) { this._auditSpace(c, c.current, "error"); c.current = null; }
      this._end(c, EXIT_ENDED, "The connection to your desktop ended; an action in flight may not have completed.");
    });
  }

  _auditSpace(c, item, outcome, result = null) {
    try {
      Promise.resolve(this.spaceAudit?.record({ profile: c.profile, host: c.spaceHost, tool: item.name,
        args: item.args, command: item.command, outcome, duration: Date.now() - item.at, result })).catch(() => {});
    } catch {}
  }

  _spaceReply(c, chunk) {
    for (const line of c.replyLines.push(chunk)) {
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const p = c.current;
      if (p && msg.method === undefined && typeof msg.id === typeof p.id && msg.id === p.id) {
        const ok = !msg.error && !msg.result?.isError;
        if (ok) c.typing = advance(c.typing, p.name, p.args);
        this._auditSpace(c, p, ok ? "ok" : "error", msg.result);
        c.current = null;
      }
    }
    this._toWrapper(c, "data", chunk);
  }

  /** Serialize fence and approval checks too: a previous reply commits typing before the next check. */
  _spaceLine(c, line) {
    let msg; try { msg = JSON.parse(line.toString("utf8")); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    c.flow = c.flow.then(() => this._spaceCall(c, msg)).catch(() => {
      if (c.current) { this._auditSpace(c, c.current, "error"); c.current = null; }
      c.bridge.close();
    });
  }

  async _spaceCall(c, msg) {
    if (Array.isArray(msg)) {
      for (const member of msg) {
        if (!member || typeof member !== "object") continue;
        if (member.method === "tools/call")
          this._auditSpace(c, { name: member.params?.name, args: member.params?.arguments || {}, at: Date.now() }, "refused");
        if (!c.done && !c.bridge.closed && member.id !== undefined)
          this._toWrapper(c, "data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: member.id,
            error: { code: -32000, message: "batches are not supported" } }) + "\n"));
      }
      return;
    }
    const tool = msg.method === "tools/call";
    const p = msg.params && typeof msg.params === "object" ? msg.params : {};
    const item = { id: msg.id, name: p.name, args: p.arguments || {}, at: Date.now() };
    const refuse = (message, outcome = "error") => {
      this._auditSpace(c, item, outcome);
      if (!c.done && msg.id !== undefined && msg.id !== null)
        this._toWrapper(c, "data", Buffer.from(JSON.stringify(toolError(msg.id, message)) + "\n"));
    };
    if (c.done || c.bridge.closed) { if (tool) this._auditSpace(c, item, "error"); return; }
    if (tool) {
      const fenced = checkSpaceCall(item.name, item.args);
      if (!fenced.ok) return refuse(fenced.message, "fenced");
      if (msg.id === undefined || msg.id === null) return refuse("Tool calls need a request ID.");
      if (this.desktops.busy?.(c.profile)) return refuse("A desktop operation is in progress. Retry later.");
      if (item.name === "type_text" && (typeof item.args.text !== "string" || item.args.text.length > 65_536))
        return refuse("Typed text must be a string of at most 65536 characters.");
      const typed = preview(c.typing, item.name, item.args);
      if (typed && this.spaceApprovals && (this.spaceAudit?.settings().approvals ?? true) && risky(typed.command, this.riskyPatterns)) {
        const decision = this.spaceApprovals.check({ profile: c.profile, host: c.spaceHost,
          command: typed.command, text: typed.text, args: item.args });
        item.command = decision.command;
        if (!decision.ok) return refuse(decision.message, decision.outcome || "approval");
      }
      c.current = item;
    }
    c.bridge.write(Buffer.from(JSON.stringify(msg) + "\n"));
    await c.bridge.queue;
    if (c.current === item)
      this._end(c, EXIT_ENDED, "Your desktop's reply could not be matched to the action; the session ended. Retry in a new session.");
  }

  endSpace(profile) {
    for (const c of [...this.conns]) if (c.kind === "space" && c.profile === profile && !c.done)
      this._end(c, EXIT_ENDED, "The desktop is being restored. Retry after the operation finishes.");
  }

  /** Phase 1's route for a hello; `reason` when the agent's own desktop was not available (per-agent mode). */
  _helloRoute(c, reason = null) {
    const rt = this._route(c.key);
    if (!rt.ok) return this._fail(c, reason && NO_DESKTOP[reason] ? NO_DESKTOP[reason] : rt.error);
    c.route = rt.r;
    c.device = rt.device;
    if (rt.device === "host") {
      c.kind = "host";
      this._usage(c);
      return wire.send(c.s, { t: "route", ok: true, device: "host", epoch: rt.epoch });
    }
    if (!wire.DEVICE_VERBS.has(c.verb)) {
      return this._fail(c, `Bot screen: '${c.verb.slice(0, 40)}' cannot run on a device (only ${[...wire.DEVICE_VERBS].join(", ")}); keep computer_use.permission_mode at standard.`, 126);
    }
    const link = rt.link;
    const ctx = this._ctx(link, c.profile, rt.name);
    const argv = wire.deviceArgv(c.argv);
    if (c.verb === "call") {
      // the CLI transport: one tool call per process, fenced here; listings come back filtered at exit. The
      // fence's rewrite (list_windows pinned to the handed pid, list_apps asked as list_windows) goes in argv.
      const v = checkCall(argv[1], parseObject(argv[2]), ctx());
      if (!v.ok) return this._fail(c, v.message);
      if (v.args) {
        argv[1] = v.tool || argv[1];
        argv[2] = JSON.stringify(v.args);
      }
      if (v.filter) {
        c.filter = v.filter;
        c.out = [];
      }
    }
    if (link.channels.size >= MAX_CHANNELS) return this._fail(c, `Bot screen: too many driver sessions are open on ${rt.name}`);
    c.kind = "device";
    c.link = link;
    c.ch = this._ch = this._ch >= 0xfffffffe ? 1 : this._ch + 1;
    link.channels.set(c.ch, c);
    if (c.verb === "mcp") c.fence = new McpFence({ ctx, toDevice: (b) => this._send(link, OP.DATA, c.ch, b), toHermes: (b) => this._toWrapper(c, "data", b) });
    this._usage(c);
    wire.send(c.s, { t: "route", ok: true, device: rt.device, epoch: rt.epoch });
    this._send(link, OP.OPEN, c.ch, { argv, agent: this.agentName(c.profile), profile: c.profile, sid: c.sid || c.skey });
  }

  /** Presence usage accounting: an open MCP session keeps its route alive; a probe only counts as use. */
  _usage(c) {
    if (!c.route) return;
    if (c.verb === "mcp" && typeof this.presence.opened === "function") {
      this.presence.opened(c.route);
      c.opened = true;
    } else if (typeof this.presence.touch === "function") this.presence.touch(c.route);
  }

  _release(c) {
    if (!c.opened) return;
    c.opened = false;
    if (typeof this.presence.closed === "function") this.presence.closed(c.route);
  }

  /** The deck-events plugin asks where this session's computer_use goes, and what its fence needs. */
  _query(c, m) {
    const id = this._identity(m);
    const key = wire.routeKey(id);
    c.kind = "query";
    if (this._agentMode() && !this._devicePinned(key, id.profile)) return this._agentStep(c, this._queryAgent(c, m, id, key));
    this._queryRoute(c, m, id, key);
  }

  _answer(c, out) {
    c.done = true;
    wire.send(c.s, out);
    c.s.end();
  }

  /** Whether a driver session of this key is still connected (the plugin then drops Hermes' cached connection). */
  _live(c, key) {
    return [...this.conns].some((o) => o !== c && o.key === key && o.verb === "mcp" && (o.kind === "host" || o.kind === "device" || o.kind === "space") && !o.done);
  }

  /** The plugin's query in per-agent mode: the agent's own desktop, busy while it starts, else the fallback. */
  async _queryAgent(c, m, id, key) {
    const before = this.sticky.get(key);
    const selected = await this._sessionDesktop(id.profile, key);
    if (c.done) return; // the plugin gave up meanwhile
    const d = this._reconcileDesktop(key, before, selected);
    const sticky = this.sticky.get(key);
    if (sticky) sticky.read = m.read === true; // a refused write must not leave a previous capture's read bypass
    const epoch = this.presence.epoch;
    if (d.kind === "shared") return this._queryRoute(c, m, id, key, d.reason);
    if (d.kind === "unavailable" || (this.spaces.mode === "overflow" && d.kind === "fallback")) return this._answer(c, { t: "route", ok: false, busy: false, device: null, error: NO_DESKTOP[d.reason], epoch, live: false });
    if (d.kind === "starting") return this._answer(c, { t: "route", ok: false, busy: true, error: STARTING, epoch, live: false });
    if (d.kind === "space") {
      const device = `space:${id.profile}@${d.host}`;
      const g = this.spaces.gate(id.profile, device, { read: m.read === true });
      if (!g.ok) return this._answer(c, { t: "route", ok: false, busy: !!g.busy, error: g.error, epoch, live: false });
      this._spaceAnswered(key, true);
      this._rememberDesktop(key, d, m.read === true);
      return this._answer(c, { t: "route", ok: true, device, epoch, live: this._live(c, key) });
    }
    this._spaceAnswered(key, false);
    if (!this.sharedFallback) return this._answer(c, { t: "route", ok: false, busy: false, device: null, error: NO_DESKTOP[d.reason], epoch, live: false });
    this._queryRoute(c, m, id, key, d.reason); // the shared desktop, taking turns through its lock
  }

  /** Remember (or forget) that the plugin's last query for this key answered the agent's own desktop. */
  _spaceAnswered(key, yes) {
    const t = Date.now();
    for (const [k, at] of this.spaceAnswered) if (t - at > 10 * 60_000) this.spaceAnswered.delete(k); // stale
    if (yes) this.spaceAnswered.set(key, t);
    else this.spaceAnswered.delete(key);
  }

  /** Phase 1's route for a query; `reason` (why the agent's own desktop is unavailable) when it fell back. */
  _queryRoute(c, m, id, key, reason = null) {
    const overflow = this.spaces?.mode === "overflow";
    const fallback = !!reason || overflow;
    const rt = this._route(key);
    if (rt.ok && this.spaces) {
      const g = this.spaces.gate(id.profile, rt.device === "host" ? "host" : rt.device, { read: m.read === true, fallback });
      if (!g.ok) {
        c.done = true;
        wire.send(c.s, { t: "route", ok: false, busy: !!g.busy, error: overflow && reason ? `${NO_DESKTOP[reason]} ${g.error}` : g.error, epoch: Number.isInteger(rt.epoch) ? rt.epoch : null, live: false });
        return c.s.end();
      }
    }
    // whether a driver session of this key is still connected: the plugin only drops Hermes' cached driver
    // connection when there is a live one pointing at the old route
    const live = this._live(c, key);
    if (rt.ok && rt.device === "host") this._rememberDesktop(key, { kind: "shared" }, m.read === true);
    const out = { t: "route", ok: rt.ok, device: rt.ok ? rt.device : null, epoch: Number.isInteger(rt.epoch) ? rt.epoch : null, live };
    if (!rt.ok) out.error = fallback && NO_DESKTOP[reason] ? NO_DESKTOP[reason] : rt.error;
    else if (rt.device !== "host") Object.assign(out, { name: rt.name, grant: this._grantFor(rt.link, id.profile), deckPid: rt.link.pid });
    c.done = true;
    wire.send(c.s, out);
    c.s.end();
  }

  _toWrapper(c, t, buf) {
    if (!c.done) wire.send(c.s, { t, b64: Buffer.from(buf).toString("base64") });
  }

  /** The device reported that its process exited. */
  _closed(c, code, error) {
    if (c.link && c.link.channels.get(c.ch) === c) c.link.channels.delete(c.ch);
    if (c.fence) c.fence.flush();
    if (c.out) this._flushCall(c, code);
    if (error) this._toWrapper(c, "err", Buffer.from(`deck-cua: ${error}\n`));
    this._finish(c, code);
  }

  /**
   * stdout of a `call list_windows|list_apps`: one JSON document, passed on only after filtering. A list_apps ran
   * as list_windows on the handed process (checkCall); its answer is the relay's own app row (appsAnswer).
   */
  _flushCall(c, code) {
    const text = Buffer.concat(c.out).toString("utf8");
    c.out = null;
    const i = text.search(/[{[]/);
    if (code !== 0 || i < 0) return;
    try {
      const obj = JSON.parse(text.slice(i));
      const grant = this._ctx(c.link, c.profile, c.device)().grant;
      filterListing(obj, c.filter, grant);
      const out = c.filter === "list_apps" ? appsAnswer(obj, grant) : obj;
      this._toWrapper(c, "data", Buffer.from(JSON.stringify(out) + "\n"));
    } catch {
      /* unparseable: nothing goes through */
    }
  }

  _finish(c, code) {
    if (c.done) return;
    c.done = true;
    wire.send(c.s, { t: "exit", code });
    c.s.end();
    this._release(c);
  }

  /** The relay ends a session (stop, device gone, route moved): kill the device process, tell the wrapper. */
  _end(c, code, message) {
    if (c.done) return;
    if (c.kind === "device" && c.link && c.link.channels.get(c.ch) === c) {
      c.link.channels.delete(c.ch);
      this._send(c.link, OP.CLOSE, c.ch, { code });
    }
    if (message) this._toWrapper(c, "err", Buffer.from(`deck-cua: ${message}\n`));
    this._finish(c, code);
    if (c.bridge) c.bridge.close(); // nothing more goes to that desktop
  }

  /** The local socket closed (the wrapper exited, or a query finished). */
  _gone(c) {
    if (!this.conns.delete(c)) return;
    if (c.kind === "device" && c.link && c.link.channels.get(c.ch) === c) {
      c.link.channels.delete(c.ch);
      this._send(c.link, OP.CLOSE, c.ch, { code: 0 });
    }
    c.done = true;
    if (c.bridge) c.bridge.close();
    this._release(c);
  }

  // ---- stop and lease -------------------------------------------------------------------------------
  /**
   * POST /desktop/stop: device id, "host", or null for everything. Sessions on agents' own desktops end with null and
   * "host", and with the id of the Deck computer that hosts them; the desktops themselves keep running.
   */
  stopDevices(device) {
    const out = { ok: true, devices: [], wrappers: 0 };
    for (const link of this.links.values()) {
      if (!link.ok || device === "host" || (device && link.device !== device)) continue;
      this._send(link, OP.STOP, 0, { reason: "Stop (Hermes Deck)" });
      link.grant = null;
      out.devices.push(link.device);
    }
    for (const c of [...this.conns]) {
      if ((c.kind !== "host" && c.kind !== "device" && c.kind !== "space") || c.done) continue;
      const hit = c.kind === "space" ? device === null || device === "host" || c.spaceHost === device : device === null || (device === "host" ? c.kind === "host" : c.device === device);
      if (hit) {
        this._end(c, EXIT_ENDED, "Bot screen: stopped from Hermes Deck");
        out.wrappers += 1;
      }
    }
    this._endRoutes((r) => device === null || (device === "host" ? r.host.kind !== "device" : r.host.id === device));
    if (this.spaces && (device === null || device === "host")) {
      const holder = this.spaces.lock.state().holder;
      if (holder && holder !== "user") this.spaces.release(holder); // Stop frees the shared desktop at once
    }
    return out;
  }

  /** POST /desktop/lease: Hermes' own Bot Desktop lease, through relay/tools/lease.py in Hermes' Python. */
  lease(profile, hold) {
    return new Promise((resolve) => {
      if (!wire.PROFILE_RE.test(profile)) return resolve({ code: 400, body: { ok: false, error: "bad profile name" } });
      if (!this.o.hermesPython) return resolve({ code: 503, body: { ok: false, error: "Hermes' Python not found; set DECK_HERMES_PYTHON in the relay's .env" } });
      const args = [this.o.leaseScript, "--profile", profile, hold ? "--hold" : "--release"];
      execFile(this.o.hermesPython, args, { timeout: this.o.leaseTimeoutMs, maxBuffer: 64 * 1024, windowsHide: true }, (err, stdout) => {
        let out = null;
        try {
          out = JSON.parse(String(stdout || "").trim().split(/\r?\n/).pop());
        } catch {
          out = null;
        }
        if (out && typeof out === "object" && typeof out.ok === "boolean") {
          if (out.ok) return resolve({ code: 200, body: { ok: true, holder: out.holder === "human" ? "human" : null } });
          return resolve({ code: out.code === "unknown-profile" ? 404 : 400, body: { ok: false, error: String(out.error || "lease failed").slice(0, 300) } });
        }
        resolve({ code: 500, body: { ok: false, error: err ? `lease helper failed (${err.code || err.signal || "error"})` : "lease helper printed no result" } });
      });
    });
  }

  // ---- HTTP (server.js calls this after the relay token check) -------------------------------------------------
  onHttp(req, res, url) {
    const p = url.pathname;
    if (p.startsWith("/cu/")) {
      this._serveFrame(req, res, p);
      return true;
    }
    if (p !== "/desktop/lease" && p !== "/desktop/stop") return false;
    if (req.method !== "POST") {
      reply(res, 405, { ok: false, error: "method not allowed" });
      return true;
    }
    readBody(req, 4096)
      .then(async (body) => {
        if (p === "/desktop/stop") {
          const d = body.device === undefined || body.device === null ? null : String(body.device).toLowerCase();
          if (d !== null && d !== "host" && !ID_RE.test(d)) return reply(res, 400, { ok: false, error: "bad device" });
          return reply(res, 200, this.stopDevices(d));
        }
        if (typeof body.profile !== "string" || typeof body.hold !== "boolean") return reply(res, 400, { ok: false, error: "expected {profile, hold}" });
        const r = await this.lease(body.profile, body.hold);
        reply(res, r.code, r.body);
      })
      .catch((e) => {
        if (!res.headersSent) reply(res, e.status || 400, { ok: false, error: e.message });
      });
    return true;
  }

  // ---- frames: written by the deck-events plugin, served and pruned here ---------------------------------------
  _serveFrame(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, { error: "method not allowed" });
    let rel;
    try {
      rel = decodeURIComponent(pathname.slice(4));
    } catch {
      return reply(res, 400, { error: "bad path" });
    }
    const root = path.resolve(this.o.cuDir);
    const file = path.resolve(root, rel);
    const type = FRAME_TYPES[path.extname(file).toLowerCase()];
    if (!type || rel.includes("\0") || !file.startsWith(root + path.sep)) return reply(res, 404, { error: "not found" });
    fs.realpath(file, (err, real) => {
      let realRoot = root;
      try {
        realRoot = fs.realpathSync(root);
      } catch {
        /* the folder does not exist yet */
      }
      if (err || !real.startsWith(realRoot + path.sep)) return reply(res, 404, { error: "not found" });
      fs.stat(real, (e2, st) => {
        if (e2 || !st.isFile()) return reply(res, 404, { error: "not found" });
        res.writeHead(200, { "content-type": type, "content-length": st.size, "cache-control": "private, max-age=86400" });
        if (req.method === "HEAD") return res.end();
        fs.createReadStream(real)
          .on("error", () => res.destroy())
          .pipe(res);
      });
    });
  }

  /** Frames older than cuMaxAgeMs go first, then the oldest until the folder is under cuMaxBytes. */
  prune(now = Date.now()) {
    this._pruneSticky();
    const files = [];
    const dirs = [];
    const walk = (dir, depth) => {
      let ents;
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 2) {
            walk(p, depth + 1);
            dirs.push(p); // children first, so empty session folders go before their profile folder
          }
          continue;
        }
        if (!e.isFile()) continue;
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        const ext = path.extname(e.name).toLowerCase();
        if (FRAME_TYPES[ext]) files.push({ p, t: st.mtimeMs, size: st.size });
        else if (ext === ".tmp" && now - st.mtimeMs > 3600 * 1000) rm(p); // a writer that died mid-frame
      }
    };
    walk(this.o.cuDir, 0);
    let removed = 0;
    let total = 0;
    const keep = [];
    for (const f of files) {
      if (now - f.t > this.o.cuMaxAgeMs) removed += rm(f.p) ? 1 : 0;
      else {
        keep.push(f);
        total += f.size;
      }
    }
    keep.sort((a, b) => a.t - b.t);
    while (total > this.o.cuMaxBytes && keep.length) {
      const f = keep.shift();
      removed += rm(f.p) ? 1 : 0;
      total -= f.size;
    }
    for (const d of dirs) {
      try {
        if (now - fs.statSync(d).mtimeMs > 3600 * 1000 && fs.readdirSync(d).length === 0) fs.rmdirSync(d);
      } catch {
        /* in use or already gone */
      }
    }
    return { removed, total };
  }
}

module.exports = { Driver, driverConfig, OP, MAGIC, encodeFrame, decodeFrame, cleanGrant, NO_ROUTE, EXIT_ENDED, CAP };
