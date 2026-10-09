"use strict";
// Gateway restarts after a plugin update (docs/updating.md). The updater queues changed profiles in
// <data>/restart-queue.json; this runs the queue: a profile restarts after two consecutive idle checks
// (gateway_state.json active_agents == 0 and no unfinished delegation log), or at once on restartNow().
// Unknown Hermes state is never restarted automatically. Busy profiles wait indefinitely.
const fs = require("fs");
const path = require("path");
const { withQueue, readQueue } = require("./queue-file");

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RECENT_MS = 15 * 60 * 1000;

const homeOf = (root, p) => (p === "default" ? root : path.join(root, "profiles", p));

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** "idle" | "busy" | "unknown" for one Hermes home. */
function idleState(home, now) {
  const st = readJson(path.join(home, "gateway_state.json"));
  if (!st || typeof st.active_agents !== "number") return "unknown";
  if (st.active_agents > 0) return "busy";
  const live = path.join(home, "cache", "delegation", "live");
  let dirs = [];
  try { dirs = fs.readdirSync(live); } catch (error) { if (error.code !== "ENOENT") return "unknown"; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(live, d)).filter((f) => /^task-.*\.log$/.test(f)); } catch (error) { if (error.code !== "ENOENT") return "unknown"; }
    for (const f of files) {
      const file = path.join(live, d, f);
      try {
        if (now - fs.statSync(file).mtimeMs > RECENT_MS) continue;
        const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
        if (!/end status=/.test(lines.at(-1) || "")) return "busy";
      } catch (error) { if (error.code !== "ENOENT") return "unknown"; }
    }
  }
  return "idle";
}

class Restarts {
  constructor({ file, hermesRoot, hermesBin = "hermes", run, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), intervalMs = 15_000, verifyMs = 60_000, notifyAfterMs = 2 * 60 * 60 * 1000, onChange = () => {} }) {
    Object.assign(this, { file, hermesRoot, hermesBin, run, now, sleep, intervalMs, verifyMs, notifyAfterMs, onChange });
    this.idle = new Map();   // profile|since -> {count, lastAt} for consecutive idle checks
    this.results = new Map(); // profile -> {state, error?, reason, since} for finished or running restarts
    this.states = new Map(); // profile -> last observed state while queued
    this.inflight = new Map(); // profile -> restart promise
    this.handled = new Set(); // profile|since whose terminal result could not be dequeued
    this.ticking = false;
    this.timer = null;
    this.queueError = null;
  }
  queue() {
    return readQueue(this.file).filter((x) => x && PROFILE_RE.test(String(x.profile)));
  }
  _dequeue(profile, since, failure = null) {
    try {
      withQueue(this.file, (q) => q.flatMap((x) => {
        if (x?.profile !== profile || x.since !== since) return [x];
        return failure ? [{ ...x, ...failure }] : [];
      }), { now: this.now });
      return true;
    } catch (error) {
      const result = this.results.get(profile);
      result.error = [result.error, `could not update the restart queue: ${error.message}`].filter(Boolean).join("; ");
      return false;
    }
  }
  rows() {
    let queue;
    try { queue = this.queue(); this.queueError = null; }
    catch (error) { this.queueError = error?.message || String(error); return []; }
    const out = [];
    const now = this.now();
    for (const x of queue) {
      if (x.pending !== true && this.handled.has(`${x.profile}|${x.since}`)) {
        out.push({ profile: x.profile, ...this.results.get(x.profile), longWait: false });
        continue;
      }
      const st = x.pending === true ? "pending" : x.failed === true ? "failed" : this.results.get(x.profile)?.state === "restarting" && this.results.get(x.profile)?.since === x.since ? "restarting" : this.states.get(x.profile) || "waiting";
      out.push({ profile: x.profile, reason: x.reason, since: x.since, state: st, ...(x.failed === true ? { error: x.error } : {}), longWait: x.failed !== true && now - Date.parse(x.since) >= this.notifyAfterMs });
    }
    for (const [profile, r] of this.results) if (!out.some((o) => o.profile === profile)) out.push({ profile, reason: r.reason, since: r.since, state: r.state, ...(r.error ? { error: r.error } : {}), longWait: false });
    return out;
  }
  _restart(entry) {
    const { profile } = entry;
    if (this.inflight.has(profile)) return this.inflight.get(profile);
    // Register the promise before callbacks or the runner can re-enter.
    const pending = Promise.resolve().then(async () => {
      const started = this.now();
      this.results.set(profile, { state: "restarting", reason: entry.reason, since: entry.since });
      this.onChange(this.rows());
      const args = profile === "default" ? ["gateway", "restart"] : ["-p", profile, "gateway", "restart"];
      let r;
      try { r = await this.run(this.hermesBin, args); }
      catch (error) { return this._finish(entry, "failed", `hermes ${args.join(" ")} failed: ${error?.message || String(error)}`); }
      if (!r || r.code !== 0) return this._finish(entry, "failed", `hermes ${args.join(" ")} failed (exit ${r ? r.code : "?"}): ${String((r && r.out) || "").trim().slice(-200)}`);
      const end = started + this.verifyMs;
      while (this.now() < end) {
        const st = readJson(path.join(homeOf(this.hermesRoot, profile), "gateway_state.json"));
        if (st && st.gateway_state === "running" && Date.parse(st.updated_at) >= started) return this._finish(entry, "restarted");
        await this.sleep(1000);
      }
      return this._finish(entry, "failed", `the gateway did not report running within ${Math.round(this.verifyMs / 1000)} s`);
    }).finally(() => { this.inflight.delete(profile); });
    this.inflight.set(profile, pending);
    return pending;
  }
  _finish(entry, state, error) {
    this.results.set(entry.profile, { state, reason: entry.reason, since: entry.since, ...(error ? { error } : {}) });
    this.idle.delete(`${entry.profile}|${entry.since}`);
    this.states.delete(entry.profile);
    if (!this._dequeue(entry.profile, entry.since, state === "failed" ? { failed: true, error, failedAt: new Date(this.now()).toISOString() } : null)) this.handled.add(`${entry.profile}|${entry.since}`);
    error = this.results.get(entry.profile).error;
    this.onChange(this.rows());
    return { ok: state === "restarted", state, ...(error ? { error } : {}) };
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      let queue;
      try { queue = this.queue(); this.queueError = null; }
      catch (error) { this.queueError = error?.message || String(error); return; }
      const keys = new Set(queue.filter((x) => x.pending !== true && x.failed !== true).map((x) => `${x.profile}|${x.since}`));
      for (const key of this.idle.keys()) if (!keys.has(key)) this.idle.delete(key);
      for (const entry of queue) {
        const key = `${entry.profile}|${entry.since}`;
        if (entry.pending === true || entry.failed === true) continue;
        if (this.inflight.has(entry.profile) || this.handled.has(key)) continue;
        const now = this.now();
        const s = idleState(homeOf(this.hermesRoot, entry.profile), now);
        this.states.set(entry.profile, s === "idle" ? "waiting" : s);
        let idle = this.idle.get(key) || { count: 0, lastAt: now };
        if (s !== "idle") idle = { count: 0, lastAt: now };
        else if (!idle.count || now - idle.lastAt >= this.intervalMs - 1000) idle = { count: idle.count + 1, lastAt: now };
        this.idle.set(key, idle);
        if (idle.count >= 2) {
          let current;
          try { current = this.queue().find((x) => x.profile === entry.profile); }
          catch (error) { this.queueError = error?.message || String(error); return; }
          if (!current || current.pending === true || current.failed === true || current.since !== entry.since) {
            this.idle.delete(key);
            this.states.delete(entry.profile);
            continue;
          }
          await this._restart(current);
        }
      }
      this.onChange(this.rows());
    } finally { this.ticking = false; }
  }
  async restartNow(profile) {
    if (!PROFILE_RE.test(String(profile))) return { ok: false, state: "failed", error: "invalid profile" };
    if (this.inflight.has(profile)) return this.inflight.get(profile);
    const entry = this.queue().find((x) => x.profile === profile);
    if (!entry) return { ok: false, state: "failed", error: "profile is not waiting for a restart" };
    if (entry.pending === true) return { ok: false, state: "waiting", error: "the plugin install for this profile has not finished" };
    if (this.handled.has(`${profile}|${entry.since}`)) {
      const { state, error } = this.results.get(profile);
      return { ok: state === "restarted", state, ...(error ? { error } : {}) };
    }
    if (entry.failed === true) {
      let cleared = false;
      withQueue(this.file, (q) => q.map((x) => {
        if (x?.profile !== profile || x.since !== entry.since || x.pending === true) return x;
        const { failed, error, failedAt, ...ready } = x;
        cleared = true;
        return ready;
      }), { now: this.now });
      if (!cleared) return { ok: false, state: "waiting", error: "the restart queue changed; try again" };
    }
    return this._restart(entry);
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

module.exports = { Restarts, idleState, homeOf };
