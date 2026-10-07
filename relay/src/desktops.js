"use strict";
// Agent spaces phase 2 (spec 2026-10-07): which desktop host each agent's desktop runs on, starting it on demand,
// stopping it when idle, keeping each host under its limit, and saying when an agent must fall back to the shared
// desktop. The agent host's own desktops go through a DesktopHost (app/main/desktop-host.js); a Deck computer's
// through `remote` (space-tunnel.js), which the Deck answers with its own DesktopHost.
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED = new Set(["host"]); // the shared space's id in the Deck's API (spaces.js): never an agent desktop
const goodProfile = (p) => PROFILE_RE.test(String(p || "")) && !String(p).includes("..") && !RESERVED.has(String(p)); // DesktopHost refuses ".." too
const RETRIES = 2;
const MIN_IDLE_TO_YIELD_MS = 2 * 60_000; // a desktop used more recently than this is never stopped for another agent
const NET_CHECK_EVERY_MS = 60_000; // the agent host's isolation rules are re-checked at most this often
const LIST_EVERY_MS = 10_000; // a Deck host whose running count disagrees with ours is listed again at most this often
const HOST_GONE_MS = 30_000; // presence.js staleMs: a Deck host absent this long has left (index.js passes the real value)

/** The host for an agent, or why there is none. hosts: [{id, ready, limit, running}]. */
function choose({ home, hosts }) {
  const ready = hosts.filter((h) => h.ready && h.limit > 0);
  if (home && home !== "auto") {
    const h = hosts.find((x) => x.id === home);
    if (!h || !h.ready) return { fallback: "offline" };
    return h.running < h.limit ? { host: h.id } : { fallback: "limit" };
  }
  if (!ready.length) return { fallback: "none" };
  const local = ready.find((h) => h.id === "agent-host" && h.running < h.limit);
  if (local) return { host: local.id };
  const room = ready.filter((h) => h.running < h.limit).sort((a, b) => b.limit - b.running - (a.limit - a.running));
  return room.length ? { host: room[0].id } : { fallback: "limit" };
}

const pub = (v) => (v.state === "stopping" ? "off" : v.state); // "stopping" is internal

class Desktops {
  /**
   * allowed: the profiles that may have a desktop of their own (DECK_DESKTOPS_AGENTS, spec section 10), or null for
   * every agent. An agent off the list falls back with reason "none" and nothing is ever started for it.
   */
  constructor({ local = null, localLimit = 0, idleMs = 20 * 60_000, presence, remote = null, store, now = () => Date.now(), hostName = "agent host", ready = null, hostGoneMs = HOST_GONE_MS, allowed = null }) {
    Object.assign(this, { local, localLimit, idleMs, presence, remote, store, now, hostName, hostGoneMs });
    this.allow = Array.isArray(allowed) ? new Set(allowed.map(String)) : null;
    this.ready = ready || (async () => true); // health wait for a started desktop (index.js passes a real /health poll)
    this.isoFailed = false; // the agent host's isolation rules vanished and could not be repaired: it takes no desktops
    this.lastNetCheck = null; // now() of the last isolation check
    this.flight = new Map(); // profile -> the resolve in progress
    this.d = new Map(); // profile -> {host, state, since, last, watched, fails, port, pending}
    this.watchers = new Set(); // profiles with an open view: kept apart from entries, which get replaced
    this.fell = new Map(); // profile -> why its last resolve fell back (cleared once it has its desktop)
    this.known = new Map(); // Deck host id -> when it was last listed (syncHosts); a host absent from presence is forgotten
    this.absent = new Map(); // Deck host id with ready desktops -> when syncHosts first found it absent from presence
    this.syncing = null; // the syncHosts pass in progress
    const saved = (store && store.load()) || {};
    this.snapshotHosts = { ...(saved.snapshotHosts || {}) };
    this.snapshotSettings = () => ({ snapshotKeep: 10 });
    this.snapshotOps = new Map();
    this.restoreHold = new Set();
    this.restoreVersions = new Map(); // invalidate starts even if restore finishes before their await resumes
    this.onSnapshot = () => {};
    this.lastSnapshotSync = null;
    if (local) local.onSnapshot = (profile, notice) => this.onSnapshot(profile, "agent-host", notice);
    this.homes = saved.homes && typeof saved.homes === "object" ? { ...saved.homes } : {};
  }

  hosts() {
    const out = [];
    if (this.local && this.localLimit > 0) out.push({ id: "agent-host", name: this.hostName, ready: !this.isoFailed, limit: this.localLimit, running: this._running("agent-host") });
    for (const h of (this.presence.desktopHosts && this.presence.desktopHosts()) || []) out.push({ ...h, running: Math.max(h.running || 0, this._running(h.id)) });
    return out;
  }

  _running(hostId) {
    let n = 0;
    for (const v of this.d.values()) if (v.host === hostId && (v.state === "ready" || v.state === "starting" || v.state === "stopping" || v.stopFailed)) n += 1; // a stopping or un-stoppable desktop still holds its slot
    return n;
  }

  /** May this agent have a desktop of its own (the allow list; every agent when there is none)? */
  allowed(profile) {
    return this.allow === null || this.allow.has(String(profile));
  }

  home(profile) {
    return this.homes[profile] || "auto";
  }

  setHome(profile, host) {
    if (!goodProfile(profile)) return { ok: false, error: "bad profile" };
    if (host !== "auto" && host !== "agent-host" && !/^[a-f0-9]{8,64}$/.test(String(host || ""))) return { ok: false, error: "bad host" };
    if (host === "auto") delete this.homes[profile];
    else this.homes[profile] = host;
    this._savePlacement();
    return { ok: true };
  }

  _savePlacement() { if (this.store) this.store.save({ homes: this.homes, snapshotHosts: this.snapshotHosts }); }
  _rememberSnapshotHost(profile, host) { this.snapshotHosts[profile] = host; this._savePlacement(); }
  snapshotHost(profile) { return this.snapshotHosts[profile] || null; } // only confirmed ready/adopted placement
  busy(profile) { return this.snapshotOps.has(profile) || this.restoreHold.has(profile); }
  async _snapshotCall(profile, op, options = {}, forcedHost = null) {
    if (!goodProfile(profile)) return Promise.reject(new Error("bad profile"));
    const host = forcedHost || this.snapshotHost(profile);
    const keep = this.snapshotSettings().snapshotKeep;
    if (!host) return Promise.reject(new Error("no snapshot host"));
    if (host === "agent-host") {
      if (!this.local) return Promise.reject(new Error("snapshot host offline"));
      this.local.opts = { ...this.local.opts, snapshotKeep: keep };
      if (op === "snapshot") return this.local.snapshot(profile, options.reason, { keep });
      if (op === "restore") return this.local.restore(profile, options.id, { keep });
      if (op === "dropSnapshot") return this.local.dropSnapshot(profile, options.id);
      const result = await this.local.snapshots(profile);
      this._snapshotNotices(profile, host, result);
      return result;
    }
    if (!this.remote?.[op]) return Promise.reject(new Error("snapshot host offline"));
    try {
      const result = await this.remote[op](host, profile, { ...options, keep });
      if (op === "snapshots") this._snapshotNotices(profile, host, result);
      return result;
    } finally {
      // Notice collection must not delay completion of a restore or approval snapshot.
      if (op !== "snapshots") this._snapshotCall(profile, "snapshots", {}, host).catch(() => {});
    }
  }
  _snapshotNotices(profile, host, result) {
    for (const notice of result.notices || (result.notice ? [result.notice] : [])) {
      try { this.onSnapshot(profile, host, notice); } catch {}
    }
  }
  snapshot(profile, reason, host = null) { return this._snapshotCall(profile, "snapshot", { reason }, host); }
  async snapshots(profile) {
    if (!goodProfile(profile)) throw new Error("bad profile");
    const host = this.snapshotHost(profile);
    if (!host) return { points: [], totalBytes: 0, busy: false, recovery: false, host: null };
    const restoreVersion = this.restoreVersions.get(profile), restoring = this.snapshotOps.has(profile);
    const r = await this._snapshotCall(profile, "snapshots", {}, host);
    if (r.recovery) this.restoreHold.add(profile);
    else if (!r.busy && !restoring && !this.snapshotOps.has(profile) && this.restoreVersions.get(profile) === restoreVersion) this.restoreHold.delete(profile);
    return { ...r, host };
  }
  dropSnapshot(profile) {
    if (this.busy(profile)) return Promise.reject(new Error("desktop operation in progress"));
    return this._snapshotCall(profile, "dropSnapshot", { id: null });
  }
  restore(profile, id) {
    if (this.snapshotOps.has(profile)) return Promise.reject(new Error("desktop operation in progress"));
    const host = this.snapshotHost(profile);
    this.restoreVersions.set(profile, (this.restoreVersions.get(profile) || 0) + 1);
    this.restoreHold.add(profile);
    const task = Promise.resolve().then(() => this._snapshotCall(profile, "restore", { id }, host)).then((r) => {
      this.restoreHold.delete(profile);
      const v = this.d.get(profile); if (v && v.host === host) { v.state = "off"; v.stopFailed = false; }
      return r;
    }, () => {
      const v = this.d.get(profile); if (v && v.host === host) v.state = "failed";
      throw new Error("restore failed; desktop stays off and undo points are kept");
    }).finally(() => this.snapshotOps.delete(profile));
    this.snapshotOps.set(profile, task);
    return task;
  }

  state(profile) {
    const v = this.d.get(profile);
    return v ? pub(v) : "off";
  }

  touch(profile) {
    const v = this.d.get(profile);
    if (v) v.last = this.now();
  }

  /**
   * Watched (a view open, or the user in control; spaces.js decides) or not. Spec 5: idle means no agent action, no
   * viewer and no user control, so when the last one ends the idle time counts from then (last = now), not from the
   * agent's last action. Only on that change: repeated "not watched" calls leave the clock alone.
   */
  watching(profile, on) {
    const v = this.d.get(profile);
    const was = this._watched(profile, v);
    if (on) this.watchers.add(profile);
    else this.watchers.delete(profile);
    if (v) {
      v.watched = !!on;
      if (was && !on) v.last = this.now();
    }
  }

  /** Watched now: by its entry's flag or by an open view (which outlives a replaced entry). */
  _watched(profile, v) {
    return !!(v && v.watched) || this.watchers.has(profile);
  }

  async _ensureOn(hostId, profile) {
    if (hostId === "agent-host") {
      this.local.opts = { ...this.local.opts, snapshotKeep: this.snapshotSettings().snapshotKeep };
      return this.local.ensure(profile);
    }
    try { return await this.remote.ensure(hostId, profile); }
    finally { this._snapshotCall(profile, "snapshots", {}, hostId).catch(() => {}); }
  }

  async _stopOn(hostId, profile) {
    const keep = this.snapshotSettings().snapshotKeep;
    if (hostId === "agent-host") {
      this.local.opts = { ...this.local.opts, snapshotKeep: keep };
      return this.local.stop(profile);
    }
    try { return await this.remote.stop(hostId, profile, { keep }); }
    finally { this._snapshotCall(profile, "snapshots", {}, hostId).catch(() => {}); }
  }

  /** An idle desktop on hostId to stop for a new one (least recently used), or null. */
  _victim(hostId) {
    let best = null;
    const t = this.now();
    for (const [p, v] of this.d) if (v.host === hostId && v.state === "ready" && !this._watched(p, v) && t - v.last >= MIN_IDLE_TO_YIELD_MS && (!best || v.last < best[1].last)) best = [p, v];
    return best ? best[0] : null;
  }

  /** One decision per profile at a time (until its desktop is reserved): a second caller gets the first one's answer (no double start). */
  resolve(profile) {
    if (!goodProfile(profile)) return Promise.resolve({ kind: "fallback", reason: "none" });
    if (!this.allowed(profile)) return Promise.resolve({ kind: "fallback", reason: "none" }); // checked first: never started, never handed out
    if (this.busy(profile)) return Promise.resolve({ kind: "fallback", reason: "failed" });
    const f = this.flight.get(profile);
    if (f) return f;
    let res, rej;
    const p = new Promise((a, b) => ((res = a), (rej = b)));
    this.flight.set(profile, p); // registered before _resolve runs: it releases the slot itself once the desktop is reserved
    const done = () => {
      if (this.flight.get(profile) === p) this.flight.delete(profile);
    };
    this._resolve(profile).then(
      (r) => {
        done();
        if (r && r.kind === "fallback") this.fell.set(profile, r.reason);
        else this.fell.delete(profile);
        res(r);
      },
      (e) => { done(); rej(e); }
    );
    return p;
  }

  /** Why the agent's last resolve fell back ("offline", "limit", "failed", "none"), or null. */
  fallbackOf(profile) {
    if (goodProfile(profile) && !this.allowed(profile)) return "none";
    return this.fell.get(profile) || null;
  }

  /** The loopback port of the agent host's own ready desktop (never a Deck host's), or null. */
  portOf(profile) {
    const v = this.d.get(profile);
    return v && v.host === "agent-host" && v.state === "ready" && Number.isInteger(v.port) ? v.port : null;
  }

  /** Its host says this desktop is not running: it is off, and the next resolve starts it again. True when it was ready. */
  markOff(profile) {
    const v = this.d.get(profile);
    if (!v || v.state !== "ready") return false;
    v.state = "off";
    return true;
  }

  async _resolve(profile, restoreVersion = this.restoreVersions.get(profile) || 0) {
    const restoring = () => this.busy(profile) || (this.restoreVersions.get(profile) || 0) !== restoreVersion;
    if (restoring()) return { kind: "fallback", reason: "failed" };
    const cur = this.d.get(profile);
    if (cur) {
      if (cur.state === "stopping") {
        await cur.stopping; // never hand out a dying desktop; afterwards it is off (or failed with its stop unresolved)
        return this._resolve(profile, restoreVersion);
      }
      if (cur.stopFailed) return { kind: "fallback", reason: "failed" }; // it may still be running: do not start a twin over it
      if (cur.state === "ready") {
        const h = cur.host === "agent-host" ? null : this.hosts().find((x) => x.id === cur.host);
        if (cur.host !== "agent-host" && (!h || !h.ready)) cur.state = "off"; // its host went away: nothing reachable to stop
        else {
          cur.last = this.now();
          return { kind: "space", host: cur.host, port: cur.port };
        }
      } else if (cur.state === "starting") return cur.pending;
    }
    let pick = choose({ home: this.home(profile), hosts: this.hosts() });
    if (pick.fallback === "limit") {
      const home = this.home(profile);
      const hostId = home !== "auto" ? home : this.hosts().find((h) => h.ready && h.limit > 0)?.id;
      const victim = hostId ? this._victim(hostId) : null;
      if (victim) {
        await this.stop(victim);
        if (restoring()) return { kind: "fallback", reason: "failed" };
        pick = choose({ home: this.home(profile), hosts: this.hosts() });
      }
    }
    if (pick.fallback) return { kind: "fallback", reason: pick.fallback };
    const v = { host: pick.host, state: "starting", since: this.now(), last: this.now(), watched: false, fails: (cur && cur.fails) || 0, port: null, stopFailed: false };
    this.d.set(profile, v);
    this.flight.delete(profile); // reserved: later callers find the entry itself (starting -> its pending)
    // Stopped (sweep, victim, isolation guard) or replaced while starting? Then this start is dead: never restart, never
    // overwrite the new state, and only clean up the container when no newer entry for this profile owns it.
    const orphaned = () => v.state !== "starting" || this.d.get(profile) !== v;
    const blocked = async () => {
      if (this.d.get(profile) === v) {
        if (v.host !== this.snapshotHost(profile)) {
          if (v.state === "off") v.state = "failed"; // ensure may have finished after a stop
          await this.stop(profile); // another host's restore cannot clean this container; retain failed-stop retries
        } else if (v.state === "starting") v.state = "off"; // restore owns this host; never queue cleanup behind it
      }
      return { kind: "fallback", reason: "failed" };
    };
    const bail = async () => {
      if (this.d.get(profile) === v && v.state !== "stopping") { // stop() owns a stopping entry's stop: never a second one
        try {
          await this._stopOn(v.host, profile);
        } catch {}
      }
      if (restoring()) return blocked();
      return { kind: "fallback", reason: "offline" };
    };
    v.pending = (async () => {
      let limited = false; // the Deck host refused for its own limit (M2): no more attempts, fallback "limit"
      for (let i = 0; i <= RETRIES; i++) {
        if (restoring()) return blocked();
        if (orphaned()) return bail();
        try {
          const r = await this._ensureOn(v.host, profile);
          if (restoring()) return blocked();
          v.port = r && r.port ? r.port : null;
          await this.ready(v.host, profile, v.port);
          if (restoring()) return blocked();
          if (orphaned()) return bail();
          this._rememberSnapshotHost(profile, v.host);
          v.state = "ready";
          v.fails = 0;
          v.last = this.now();
          return { kind: "space", host: v.host, port: v.port };
        } catch (e) {
          if (restoring()) return blocked();
          if (orphaned()) return bail();
          if (e && e.code === "LIMIT") { // the Deck refused before starting anything: its own count of others is full
            limited = true;
            if (i === 0) {
              v.state = "off";
              return { kind: "fallback", reason: "limit" };
            }
            break; // an earlier attempt may have left a container: clean up below
          }
          v.fails += 1;
        }
      }
      try { // all attempts failed: do not leave a half-started container behind
        await this._stopOn(v.host, profile);
      } catch {
        if (restoring()) return blocked();
        if (!orphaned()) v.stopFailed = true; // a stop() that took over meanwhile owns the state: never mark it sticky
      }
      if (restoring()) return blocked();
      if (orphaned()) return { kind: "fallback", reason: "offline" };
      v.state = limited && !v.stopFailed ? "off" : "failed"; // a failed cleanup stays "failed": the sweep retries it
      return { kind: "fallback", reason: limited ? "limit" : "failed" };
    })();
    return v.pending;
  }

  async start(profile) {
    return this.resolve(profile);
  }

  /** Relay start: the agent host's desktops that are already running are taken over as ready. */
  async adopt() {
    if (!this.local) return;
    let running = [];
    try {
      running = (await this.local.list()).filter((x) => x.running);
    } catch {}
    for (const x of running) this.d.set(x.profile, { host: "agent-host", state: "ready", since: this.now(), last: this.now(), watched: false, fails: 0, port: x.port || null });
    for (const x of running) this._rememberSnapshotHost(x.profile, "agent-host");
  }

  async stop(profile) {
    const v = this.d.get(profile);
    if (!v || v.state === "off") return;
    if (v.state === "stopping") return v.stopping;
    v.state = "stopping"; // set before the await: counted as occupying its slot, never handed out as ready
    v.stopping = (async () => {
      try {
        await this._stopOn(v.host, profile);
        v.state = "off";
        v.stopFailed = false;
      } catch {
        v.state = "failed"; // the container may still run: keep it counted, retry on the next sweep
        v.stopFailed = true;
      } finally {
        v.stopping = null;
      }
    })();
    return v.stopping;
  }

  async sweep() {
    const t = this.now();
    for (const [p, v] of [...this.d]) if (v.stopFailed && v.state === "failed") await this.stop(p); // retry stops that failed
    // idle time: a Deck host's own (its heartbeat's idleMin), else ours. A Deck host that is gone now (closed, asleep,
    // heartbeat stale) is not asked: syncHosts adopts its desktops again when it is back, and the sweep reaches them then.
    const decks = new Map(((this.presence.desktopHosts && this.presence.desktopHosts()) || []).map((h) => [h.id, h]));
    for (const [p, v] of [...this.d]) {
      if (v.state !== "ready" || this._watched(p, v)) continue;
      const h = v.host === "agent-host" ? null : decks.get(v.host);
      if (v.host !== "agent-host" && !h) continue;
      const idle = h && Number.isInteger(h.idleMin) ? h.idleMin * 60_000 : this.idleMs;
      if (t - v.last >= idle) await this.stop(p);
    }
    await this._guardIsolation();
  }

  /**
   * Deck hosts' desktops the relay does not track (left over from before a relay restart, or kept running while their
   * host was asleep or out of touch): a host that appears or comes back is listed, and so is one whose heartbeat's running
   * count differs from ours (at most every LIST_EVERY_MS). Running desktops are adopted as ready with last = now, so the
   * idle sweep reaches them; a ready one the Deck no longer runs goes off. One pass at a time.
   */
  syncHosts() {
    this._dropGoneHosts();
    if (this.syncing) return this.syncing;
    const queried = new Set();
    this.syncing = this._syncHosts(queried).then(async () => {
      const now = this.now();
      if (this.lastSnapshotSync !== null && now - this.lastSnapshotSync < LIST_EVERY_MS) return;
      this.lastSnapshotSync = now;
      const online = new Set((this.presence.desktopHosts?.() || []).map((h) => h.id));
      for (const [profile, host] of Object.entries(this.snapshotHosts)) {
        if (queried.has(profile)) continue;
        if (host !== "agent-host" && !online.has(host)) continue;
        try { await this.snapshots(profile); } catch {}
      }
    }).finally(() => (this.syncing = null));
    return this.syncing;
  }

  /**
   * A Deck host absent from presence (gone, or dropped as asleep or stale) for hostGoneMs: its ready desktops go off,
   * with fallback "offline", so /spaces stops showing them as running. No stop is sent: the host is not reachable (a
   * Deck that quits stops its own containers). When it is back, _syncHosts lists it afresh and adopts what still runs.
   */
  _dropGoneHosts() {
    const present = new Set(((this.presence.desktopHosts && this.presence.desktopHosts()) || []).map((h) => h.id));
    const withReady = new Set([...this.d.values()].filter((v) => v.host !== "agent-host" && v.state === "ready").map((v) => v.host));
    for (const id of [...this.absent.keys()]) if (present.has(id) || !withReady.has(id)) this.absent.delete(id); // back, or nothing left to drop
    const t = this.now();
    for (const id of withReady) {
      if (present.has(id)) continue;
      if (!this.absent.has(id)) {
        this.absent.set(id, t);
        continue;
      }
      if (t - this.absent.get(id) < this.hostGoneMs) continue;
      this.absent.delete(id);
      for (const [p, v] of this.d) {
        if (v.host !== id || v.state !== "ready") continue;
        v.state = "off";
        this.fell.set(p, "offline");
      }
    }
  }

  async _syncHosts(queried = new Set()) {
    if (!this.remote || typeof this.remote.list !== "function") return;
    const hosts = (this.presence.desktopHosts && this.presence.desktopHosts()) || [];
    const seen = new Set(hosts.map((h) => h.id));
    for (const id of [...this.known.keys()]) if (!seen.has(id)) this.known.delete(id); // gone: listed afresh on return
    for (const h of hosts) {
      const t = this.now();
      const last = this.known.get(h.id);
      const isNew = last === undefined;
      const held = [...this.restoreHold].filter((p) => this.snapshotHost(p) === h.id);
      if (!isNew && ((!held.length && (h.running || 0) === this._running(h.id)) || t - last < LIST_EVERY_MS)) continue;
      this.known.set(h.id, t);
      for (const p of held) {
        queried.add(p);
        try { await this.snapshots(p); } catch {} // keep the hold if unreachable; query again, never replay restore
      }
      await this._listHost(h.id);
    }
  }

  async _listHost(id) {
    const before = [...this.d].filter(([, v]) => v.host === id && v.state === "ready"); // ready when the listing was asked for
    let list;
    try {
      list = await this.remote.list(id);
    } catch {
      return;
    }
    const running = new Set((Array.isArray(list) ? list : []).filter((x) => x && x.running === true && PROFILE_RE.test(String(x.profile || ""))).map((x) => x.profile));
    for (const p of running) {
      const v = this.d.get(p);
      const t = this.now();
      if (!v || ((v.state === "off" || v.state === "failed") && !v.stopFailed)) {
        this.d.set(p, { host: id, state: "ready", since: t, last: t, watched: false, fails: 0, port: null, stopFailed: false });
        this._rememberSnapshotHost(p, id);
        this.fell.delete(p); // on its own desktop again (an "offline" from _dropGoneHosts no longer holds)
      } else if (v.host !== id && (v.state === "ready" || v.state === "starting" || v.state === "stopping")) {
        try {
          await this._stopOn(id, p); // a twin: collect this host's stop notices too; the home volume stays
        } catch {}
      }
    }
    for (const [p, v] of before) if (this.d.get(p) === v && v.state === "ready" && !running.has(p)) v.state = "off";
  }

  async _netOk() {
    try {
      return (await this.local.netCheck()) === true;
    } catch {
      return false;
    }
  }

  /** Repair the agent host's isolation rules; true when a check afterwards passes. */
  async _netRepaired() {
    try {
      await this.local.netRepair();
    } catch {
      return false;
    }
    return this._netOk();
  }

  /** The agent host's desktops depend on isolation rules that can vanish (Docker restart). Check, repair once, else shut the host. */
  async _guardIsolation() {
    const l = this.local;
    if (!l || typeof l.netCheck !== "function" || typeof l.netRepair !== "function") return;
    if (this.isoFailed) { // already shut: each sweep tries to bring it back
      if (await this._netRepaired()) this.isoFailed = false;
      return;
    }
    if (!this._running("agent-host")) return;
    const t = this.now();
    if (this.lastNetCheck !== null && t - this.lastNetCheck < NET_CHECK_EVERY_MS) return;
    this.lastNetCheck = t;
    if (await this._netOk()) return;
    if (await this._netRepaired()) return;
    this.isoFailed = true;
    for (const [p, v] of [...this.d]) if (v.host === "agent-host" && (v.state === "ready" || v.state === "starting")) await this.stop(p);
  }

  list() {
    return [...this.d].map(([profile, v]) => ({ profile, host: v.host, state: pub(v), since: v.since }));
  }
}

module.exports = { Desktops, choose };
