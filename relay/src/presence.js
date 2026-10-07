"use strict";
// Device presence and routing for every capability that runs agent work on the user's own computers:
// "browser" (Workspace tab: agent browsers) now, "desktop" (bot screen) later. One module, one heartbeat.
//
// Heartbeat. Each Hermes Deck sends one over its authenticated relay WebSocket every 10 s, and at once
// on suspend, lock, unlock and resume:
//   {t:"heartbeat", device:{id, name}, os, idleSec, locked, hosting:{browser, desktop}, driverOk}
// `hosting` holds the user's per-device switches (all off on a new install). `driverOk` says whether the
// device can actually host: a boolean for all capabilities, or {capability: boolean}; missing = fine.
// A computer that hosts agents' own desktops (agent spaces phase 2) adds desktops:{ready, limit, running, idleMin}.
//
// activeDevice(cap): the least idle device that meets all four conditions: heartbeat younger than 30 s,
// not locked, idleSec under 120, and cap's switch on (with a working driver).
//
// routeFor(sessionKey, cap): sticky per agent session. A session keeps its host until a handoff, the
// loss of that device (disconnected, silent for 30 s, switch turned off) or the end of the session (no
// use for sessionIdleS). Every change bumps `epoch`; each route carries the epoch it was made in, so a
// consumer can drop handles that belong to an older route. Without a pin ("Otomatik") the browser goes to the
// agent host's fallback browser first (relay .env: DECK_FALLBACK_BROWSER / DECK_FALLBACK_BROWSER_CDP) and to the
// active device only when the agent host cannot host; DECK_BROWSER_DEFAULT=device restores the earlier order
// (active device first, fallback second). The bot screen is always device-first. With neither a device nor a
// fallback there is no route at all (the deck shows "çalışma alanı yok").
//
// Pins (Workspace tab host picker). The user can fix where one agent's work runs: a device ("Bu
// bilgisayar") or the agent host's fallback; no pin is "Otomatik" (the rules above). A pinned session goes
// only there: a pinned device needs a fresh heartbeat and its switch on, not recent input; when the pinned
// place cannot host, there is no route (the agent is told why). Setting a pin moves a running session at
// once, like a handoff. Pins are set only by a deck the user drives (workspace.js), never over CDP, and the
// relay keeps them in its data folder (index.js).
const { EventEmitter } = require("events");

const CAPABILITIES = Object.freeze(["browser", "desktop"]);
const ID_RE = /^[a-f0-9]{8,64}$/;
const DEFAULTS = Object.freeze({
  staleMs: 30_000, // a heartbeat older than this does not count
  activeIdleS: 120, // the user touched the device within this many seconds
  sessionIdleS: 300, // a session with no open connection and no use for this long has ended
});

/** An integer clamped to [lo, hi]; anything that is not an integer counts as lo. */
const clampInt = (v, lo, hi) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/** A Deck's desktop hosting: {ready, limit, running}, plus idleMin (its own idle time, 5..240) when it sends one. */
function desktopsField(dk) {
  const out = { ready: dk.ready === true, limit: clampInt(dk.limit, 0, 16), running: clampInt(dk.running, 0, 16) };
  if (typeof dk.idleMin === "number" && Number.isFinite(dk.idleMin)) out.idleMin = Math.min(240, Math.max(5, Math.round(dk.idleMin)));
  return out;
}

/** A validated heartbeat (never trusts shapes or sizes from the wire), or null. */
function parseHeartbeat(m, now) {
  if (!m || typeof m !== "object") return null;
  const dev = typeof m.device === "string" ? { id: m.device } : m.device && typeof m.device === "object" ? m.device : null;
  const id = dev ? String(dev.id || "").toLowerCase() : "";
  if (!ID_RE.test(id)) return null;
  const idle = Number(m.idleSec);
  const hosting = {};
  for (const c of CAPABILITIES) hosting[c] = !!(m.hosting && typeof m.hosting === "object" && m.hosting[c] === true);
  let driverOk = true;
  if (typeof m.driverOk === "boolean") driverOk = m.driverOk;
  else if (m.driverOk && typeof m.driverOk === "object") {
    driverOk = {};
    for (const c of CAPABILITIES) if (typeof m.driverOk[c] === "boolean") driverOk[c] = m.driverOk[c];
  }
  // agent spaces phase 2: this computer hosts agents' own desktops (its DesktopHost: ready, how many, how many run)
  const dk = m.desktops && typeof m.desktops === "object" && !Array.isArray(m.desktops) ? m.desktops : null;
  return {
    id,
    name: String(dev.name || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64) || id.slice(0, 8),
    os: String(m.os || "").replace(/[^\w.-]/g, "").slice(0, 16),
    idleSec: m.idleSec !== null && m.idleSec !== "" && Number.isFinite(idle) && idle >= 0 ? idle : Infinity,
    locked: m.locked === true,
    asleep: m.asleep === true,
    hosting,
    driverOk,
    desktops: dk ? desktopsField(dk) : null,
    at: now,
  };
}

const driverFor = (hb, cap) => (typeof hb.driverOk === "boolean" ? hb.driverOk : hb.driverOk[cap] !== false);

/** The user lets this device host cap and it can (activity aside). */
const hostsCap = (hb, cap) => !!(hb && hb.hosting[cap] && driverFor(hb, cap));

/** The four conditions of an active device for cap. */
function qualifies(hb, cap, now, o = DEFAULTS) {
  return !!hb && now - hb.at < o.staleMs && !hb.locked && hb.idleSec < o.activeIdleS && hostsCap(hb, cap);
}

/** Least idle qualifying heartbeat (idle counted up to `now`), or null. */
function pickActive(heartbeats, cap, now, o = DEFAULTS) {
  let best = null;
  let bestIdle = Infinity;
  for (const hb of heartbeats) {
    if (!qualifies(hb, cap, now, o)) continue;
    const idle = hb.idleSec + (now - hb.at) / 1000;
    if (idle < bestIdle) {
      best = hb;
      bestIdle = idle;
    }
  }
  return best;
}

const pub = (hb) => ({ id: hb.id, name: hb.name, os: hb.os });
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/; // a pinned session key is an agent profile
const DESKTOP_KEY_RE = /^p:[A-Za-z0-9._-]{1,64}$/; // a desktop pin is per agent profile (route keys: driver-wire.js)
const pinKeyOk = (cap, k) => (cap === "desktop" ? DESKTOP_KEY_RE.test(k) : KEY_RE.test(k));
/** The pin that governs a route key: exact, or for a desktop key "p:<profile>/..." the profile's pin. */
const pinLookup = (pins, cap, sessionKey) => {
  const exact = pins.get(`${cap}\t${sessionKey}`);
  if (exact || cap !== "desktop") return exact || null;
  const m = /^(p:[A-Za-z0-9._-]{1,64})(?:\/|$)/.exec(sessionKey);
  return (m && pins.get(`desktop\t${m[1]}`)) || null;
};
/** A route's host is the pinned place. */
const samePlace = (host, pin) => (pin.kind === "fallback" ? host.kind === "fallback" : host.kind === "device" && host.id === pin.id);

/**
 * Events: "change" (anything a deck would display changed), "route" ({key, old, next, why}) whenever a
 * route is made, moved or dropped; why = "new" | "handoff" | "lost" | "ended".
 */
class Presence extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {Record<string, {id?: string, name: string}|null>} [opts.fallback] per capability, the relay
   *   host's own fallback (from .env); none by default
   * @param {() => number} [opts.now] clock in ms (tests)
   * @param {string|null} [opts.hostName] the agent host's name for decks ("Home server")
   * Also "pins" whenever a pin is set or cleared (to save them).
   */
  constructor({ fallback = {}, now = () => Date.now(), hostName = null, browserDefault = "host", desktopDefault = "device", ...opts } = {}) {
    super();
    this.o = { ...DEFAULTS, ...opts };
    this.now = now;
    this.hostName = hostName ? String(hostName).slice(0, 48) : null;
    // "Otomatik" for the browser: the agent host's browser first (default), or, as before, the user's active device
    // first (DECK_BROWSER_DEFAULT=device). Only the browser capability has this switch; the bot screen stays device-first.
    this.browserDefault = browserDefault === "device" ? "device" : "host";
    this.desktopDefault = desktopDefault === "host" ? "host" : "device"; // "host" when agent spaces are on: the agent's space
    this.fallback = {};
    for (const c of CAPABILITIES) {
      const f = fallback[c];
      // agents: the fallback hosts only these agent profiles (an external, shared browser belongs to one agent); null = all
      const agents = f && Array.isArray(f.agents) ? f.agents.map((x) => String(x)).slice(0, 64) : null;
      this.fallback[c] = f ? { id: f.id || "fallback", name: String(f.name || "fallback"), agents } : null;
    }
    this.conns = new Map(); // connection -> its latest heartbeat (null until the first)
    this.routes = new Map(); // "<cap>\t<sessionKey>" -> route
    this.pins = new Map(); // "<cap>\t<sessionKey>" -> {kind: "device", id, name} | {kind: "fallback"}
    this.transfers = new Map(); // routes remain unavailable until state has been imported and acknowledged
    this._epoch = 0;
  }

  get epoch() {
    return this._epoch;
  }

  // ---- devices -------------------------------------------------------------------------------------
  connect(conn) {
    if (!this.conns.has(conn)) this.conns.set(conn, null);
  }

  /** Apply a heartbeat from `conn`; returns the parsed heartbeat or null when it was malformed. */
  heartbeat(conn, msg) {
    const hb = parseHeartbeat(msg, this.now());
    if (!hb) return null;
    this.conns.set(conn, hb);
    this.sweep(); // a switch turned off ends that device's routes at once
    this.emit("change");
    if (hb.asleep) this.emit("sleep", hb.id);
    return hb;
  }

  disconnect(conn) {
    const had = this.conns.get(conn);
    this.conns.delete(conn);
    if (had) {
      this.sweep();
      this.emit("change");
    }
  }

  /** device id -> {hb, conn}; with two connections for one id, the fresher heartbeat wins. */
  devices() {
    const out = new Map();
    for (const [conn, hb] of this.conns) {
      if (!hb) continue;
      const cur = out.get(hb.id);
      if (!cur || cur.hb.at <= hb.at) out.set(hb.id, { hb, conn });
    }
    return out;
  }

  /** The device id behind a deck connection (its latest heartbeat), or null. */
  deviceOf(conn) {
    const hb = this.conns.get(conn);
    return hb ? hb.id : null;
  }

  /** The live connection of a device (to reach it), or null. */
  connOf(deviceId) {
    const d = this.devices().get(deviceId);
    return d ? d.conn : null;
  }

  /**
   * Deck computers that host agents' own desktops (desktops.js): fresh, awake, with a desktops heartbeat. A locked
   * screen does not count: containers keep running behind a screen lock (only sleep stops them), so agents keep working.
   */
  desktopHosts(now = this.now()) {
    const out = [];
    for (const { hb } of this.devices().values()) {
      if (now - hb.at < this.o.staleMs && !hb.asleep && hb.desktops) out.push({ id: hb.id, name: hb.name, ...hb.desktops });
    }
    return out;
  }

  // ---- choice --------------------------------------------------------------------------------------
  /** The device the user is on that may host `cap`, as {id, name, os}, or null. */
  activeDevice(cap, now = this.now()) {
    if (!CAPABILITIES.includes(cap)) return null;
    const hb = pickActive([...this.devices().values()].map((d) => d.hb), cap, now, this.o);
    return hb ? pub(hb) : null;
  }

  /**
   * The host for one agent session, made on first use and kept until handoff, device loss or the
   * session's end. Returns {sessionKey, capability, host: {kind: "device"|"fallback", id, name, os?},
   * epoch, since, lastUsed, open} or null when there is no workspace at all.
   */
  routeFor(sessionKey, cap, now = this.now()) {
    if (!CAPABILITIES.includes(cap) || !sessionKey) return null;
    const key = `${cap}\t${sessionKey}`;
    if (this.transfers.has(key)) return null;
    const pin = pinLookup(this.pins, cap, sessionKey);
    let r = this.routes.get(key);
    if (r) {
      const why = this._lost(r, now) || (pin && !samePlace(r.host, pin) ? "handoff" : null);
      if (!why) {
        r.lastUsed = now;
        return r;
      }
      this._drop(key, r, why);
    }
    // the user's choice, strictly (nothing else stands in); without a pin the default order decides
    const host = pin ? this._pinHost(pin, cap, now, sessionKey) : this._autoHost(cap, sessionKey, now);
    if (!host) return null;
    r = { sessionKey, capability: cap, host, epoch: ++this._epoch, since: now, lastUsed: now, open: 0 };
    this.routes.set(key, r);
    this.emit("route", { key, old: null, next: r, why: "new" });
    this.emit("change");
    return r;
  }

  /** The fallback host for cap if it may host this session (an external browser serves one agent only), else null. */
  _fb(cap, sessionKey) {
    const fb = this.fallback[cap];
    return fb && (!fb.agents || fb.agents.includes(sessionKey)) ? fb : null;
  }

  /**
   * "Otomatik": where an unpinned session goes. The browser prefers the agent host (DECK_BROWSER_DEFAULT=host, the
   * default) and uses the active device only when the agent host cannot host; =device keeps the earlier order.
   */
  _autoHost(cap, sessionKey, now) {
    const dev = this.activeDevice(cap, now);
    const fb = this._fb(cap, sessionKey);
    const d = dev ? { kind: "device", ...dev } : null;
    const f = fb ? { kind: "fallback", id: fb.id, name: fb.name } : null;
    const preferHost = (cap === "browser" && this.browserDefault === "host") || (cap === "desktop" && this.desktopDefault === "host");
    return preferHost ? f || d : d || f;
  }

  /** Move a session to a device on purpose (handoff). The device must be connected and allow `cap`. */
  handoff(sessionKey, cap, deviceId, now = this.now()) {
    if (!CAPABILITIES.includes(cap) || !sessionKey) return null;
    const d = this.devices().get(deviceId);
    if (!d || now - d.hb.at >= this.o.staleMs || !hostsCap(d.hb, cap)) return null;
    return this._move(`${cap}\t${sessionKey}`, sessionKey, cap, { kind: "device", ...pub(d.hb) }, now);
  }

  holdTransfer(sessionKey, cap, old = this.routes.get(`${cap}\t${sessionKey}`)) {
    const key = `${cap}\t${sessionKey}`;
    if (!old || this.transfers.has(key)) return false;
    this.transfers.set(key, old);
    this.pins.set(key, old.host.kind === "fallback" ? { kind: "fallback" } : { kind: "device", id: old.host.id, name: old.host.name });
    this.emit("pins"); // a relay restart retains the source until an import really succeeds
    this._drop(key, old, "handoff");
    return true;
  }

  finishTransfer(sessionKey, cap, target = null) {
    const key = `${cap}\t${sessionKey}`;
    const old = this.transfers.get(key);
    if (!old) return false;
    if (target && !this._pinHost(target === "fallback" ? { kind: "fallback" } : { kind: "device", id: target }, cap, this.now(), sessionKey)) return false;
    this.transfers.delete(key);
    if (target) {
      const pin = target === "fallback" ? { kind: "fallback" } : { kind: "device", id: target };
      const result = this.setPin(sessionKey, cap, pin);
      if (!result.ok) return false;
    }
    this.routeFor(sessionKey, cap);
    return true;
  }

  _move(key, sessionKey, cap, host, now) {
    const old = this.routes.get(key) || null;
    const next = { sessionKey, capability: cap, host, epoch: ++this._epoch, since: now, lastUsed: now, open: 0 };
    this.routes.set(key, next);
    this.emit("route", { key, old, next, why: "handoff" });
    this.emit("change");
    return next;
  }

  // ---- pins: the user's choice of place (Workspace tab) ----------------------------------------------------
  /** {kind: "device", id, name} | {kind: "fallback"} for a pinned session, or null ("Otomatik"). */
  pinOf(sessionKey, cap) {
    return this.pins.get(`${cap}\t${sessionKey}`) || null;
  }

  /** Where a pin can host right now, as a route host, or null. */
  _pinHost(pin, cap, now, sessionKey = null) {
    if (pin.kind === "fallback") {
      const fb = sessionKey === null ? this.fallback[cap] : this._fb(cap, sessionKey);
      return fb ? { kind: "fallback", id: fb.id, name: fb.name } : null;
    }
    const d = this.devices().get(pin.id);
    return d && !d.hb.asleep && now - d.hb.at < this.o.staleMs && hostsCap(d.hb, cap) ? { kind: "device", ...pub(d.hb) } : null;
  }

  /**
   * Pin a session (pin null = "Otomatik"; {kind: "device", id}; {kind: "fallback"}). The place must be able
   * to host now. A session running elsewhere moves there at once (handoff: new epoch, old sockets cut).
   * Returns {ok: true} or {ok: false, code: "bad" | "device" | "fallback"}.
   */
  setPin(sessionKey, cap, pin, now = this.now()) {
    if (!CAPABILITIES.includes(cap) || !pinKeyOk(cap, String(sessionKey || ""))) return { ok: false, code: "bad" };
    const key = `${cap}\t${sessionKey}`;
    let next = null;
    if (pin && pin.kind === "device") {
      const id = String(pin.id || "").toLowerCase();
      const d = this.devices().get(id);
      // why: offline (gone or silent), hosting (the user's switch for cap is off), driver (switch on, driver not ready)
      if (!d || now - d.hb.at >= this.o.staleMs) return { ok: false, code: "device", why: "offline" };
      if (!d.hb.hosting[cap]) return { ok: false, code: "device", why: "hosting" };
      if (!hostsCap(d.hb, cap)) return { ok: false, code: "device", why: "driver" };
      next = { kind: "device", id, name: d.hb.name };
    } else if (pin && pin.kind === "fallback") {
      if (!this._fb(cap, sessionKey)) return { ok: false, code: "fallback" };
      next = { kind: "fallback" };
    } else if (pin) return { ok: false, code: "bad" };
    if (next) this.pins.set(key, next);
    else this.pins.delete(key);
    this.emit("pins");
    // clearing a pin ("Otomatik") leaves a running session where it is (sticky), except a desktop route on a device:
    // "Send back to its space" ends it there. A desktop pin is per profile, so it moves every route of that profile.
    const keys = cap === "desktop" ? [...this.routes.keys()].filter((k) => k === key || k.startsWith(`${key}/`)) : [key];
    let moved = false;
    for (const k of keys) {
      const r = this.routes.get(k);
      const sk = k.split("\t")[1];
      if (next && r && !samePlace(r.host, next)) {
        this._move(k, sk, cap, this._pinHost(next, cap, now, sk), now);
        moved = true;
      } else if (!next && r && cap === "desktop" && r.host.kind === "device") {
        this._drop(k, r, "handoff"); // the next action lands in the space
        moved = true;
      }
    }
    if (!moved) this.emit("change");
    return { ok: true };
  }

  /** Pins as saved and shown: [{sessionKey, capability, host}]. */
  pinList() {
    return [...this.pins].map(([k, host]) => {
      const [capability, sessionKey] = k.split("\t");
      return { sessionKey, capability, host: { ...host } };
    });
  }

  /** Pins saved by an earlier run (validated; a device's name is kept for display while it is away). */
  loadPins(list) {
    for (const p of Array.isArray(list) ? list : []) {
      if (!p || !CAPABILITIES.includes(p.capability) || !pinKeyOk(p.capability, String(p.sessionKey || "")) || !p.host) continue;
      const key = `${p.capability}\t${p.sessionKey}`;
      if (p.host.kind === "fallback") this.pins.set(key, { kind: "fallback" });
      else if (p.host.kind === "device" && ID_RE.test(String(p.host.id || ""))) {
        this.pins.set(key, { kind: "device", id: p.host.id, name: String(p.host.name || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64) || p.host.id.slice(0, 8) });
      }
    }
  }

  /** The consumer knows the session is over (e.g. the agent closed its browser). */
  endSession(sessionKey, cap) {
    const key = `${cap}\t${sessionKey}`;
    const r = this.routes.get(key);
    if (r) this._drop(key, r, "ended");
  }

  // usage accounting: a session with an open connection never ends; an idle one ends after sessionIdleS
  opened(r) {
    r.open += 1;
    r.lastUsed = this.now();
  }

  closed(r) {
    r.open = Math.max(0, r.open - 1);
    r.lastUsed = this.now();
  }

  touch(r) {
    r.lastUsed = this.now();
  }

  /** Periodic upkeep (every second or so): drop routes whose device is gone or whose session is over. */
  sweep(now = this.now()) {
    for (const [key, r] of this.routes) {
      const why = this._lost(r, now);
      if (why) this._drop(key, r, why);
    }
  }

  _lost(r, now) {
    if (r.open === 0 && now - r.lastUsed > this.o.sessionIdleS * 1000) return "ended";
    if (r.host.kind === "fallback") return this._fb(r.capability, r.sessionKey) ? null : "lost";
    const d = this.devices().get(r.host.id);
    if (!d || now - d.hb.at >= this.o.staleMs || !hostsCap(d.hb, r.capability)) return "lost";
    return null;
  }

  _drop(key, r, why) {
    if (this.routes.get(key) !== r) return;
    this.routes.delete(key);
    this._epoch += 1;
    this.emit("route", { key, old: r, next: null, why });
    this.emit("change");
  }

  // ---- what decks see ------------------------------------------------------------------------------
  /** Snapshot pushed to decks ({t:"devices"}); nothing in it changes merely because time passes. */
  state(now = this.now()) {
    const devices = [];
    for (const { hb } of this.devices().values()) {
      devices.push({ ...pub(hb), locked: hb.locked, hosting: { ...hb.hosting }, driverOk: hb.driverOk, fresh: now - hb.at < this.o.staleMs });
    }
    devices.sort((a, b) => a.name.localeCompare(b.name));
    const active = {};
    const fallback = {};
    for (const c of CAPABILITIES) {
      const d = this.activeDevice(c, now);
      active[c] = d ? d.id : null;
      fallback[c] = this.fallback[c] ? { name: this.fallback[c].name, agents: this.fallback[c].agents ? [...this.fallback[c].agents] : null } : null;
    }
    const routes = [...this.routes.values()].map((r) => ({ sessionKey: r.sessionKey, capability: r.capability, host: r.host, epoch: r.epoch, since: Math.round(r.since / 1000) }));
    // Workspace tab host picker: the user's pins, and the agent host's name for its option ("Home server")
    // defaults: where "Otomatik" puts a browser ("host" = the agent host first), for the picker's wording
    return { t: "devices", epoch: this._epoch, devices, active, fallback, routes, pins: this.pinList(), agentHost: { name: this.hostName }, defaults: { browser: this.browserDefault, desktop: this.desktopDefault } };
  }
}

module.exports = { Presence, CAPABILITIES, DEFAULTS, parseHeartbeat, pickActive, qualifies };
