"use strict";
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { readJson } = require("./util");

const STALE_S = 120;
const TRIGGER_FILE = "quota-refresh.json"; // written by refreshQuotas, polled by the deck-events plugins
const REFRESH_MIN_GAP_MS = 30_000; // forced quota refreshes are at least this far apart
const REFRESH_TIMEOUT_MS = 27_000; // how long a refresh waits for the plugins (they time a provider out at 25 s; phones give up at 30 s)

/**
 * Fleet health without reading any agent's home directory or calling an LLM:
 * - Hermes gateway/platform/cron snapshots written by the deck-events plugin (~/.hermes-deck/state)
 * - launchd liveness of jobs whose label starts with one of `launchdPrefixes` (macOS `launchctl list`)
 * - Claude/Codex usage windows via the CodexBar CLI (`codexbar usage --json`), when installed
 */
class Fleet {
  constructor({ stateDir, codexbar, launchdPrefixes = ["ai.hermes."], providers = ["claude", "codex"], onChange }) {
    this.stateDir = stateDir;
    this.launchdPrefixes = launchdPrefixes;
    this.codexbar = codexbar;
    this.providers = providers;
    this.onChange = onChange || (() => {});
    this.data = { profiles: {}, launchd: [], quotas: {} };
    this.last = "";
    this.timers = [];
    this.stateWrite = null;      // tests may replace the trigger writer
    this.lastRefreshAt = 0;      // epoch ms of the last forced refresh that started
    this.refreshing = null;      // in-flight refresh promise (shared by concurrent callers)
    this.refreshId = 0;
  }

  start() {
    const every = (ms, fn) => {
      fn();
      this.timers.push(setInterval(fn, ms));
    };
    every(10_000, () => this.readSnapshots());
    every(15_000, () => this.readLaunchd());
    every(300_000, () => this.readQuotas());
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
  }

  _changed() {
    const s = JSON.stringify(this.data);
    if (s !== this.last) {
      this.last = s;
      this.onChange(this.data);
    }
  }

  readSnapshots() {
    const profiles = {};
    let names = [];
    try {
      names = fs.readdirSync(this.stateDir).filter((n) => n.endsWith(".json") && n !== TRIGGER_FILE);
    } catch {
      /* no snapshots yet */
    }
    const now = Date.now() / 1000;
    for (const n of names) {
      const snap = readJson(path.join(this.stateDir, n), null);
      if (!snap) continue;
      snap.stale = !(now - (snap.ts || 0) < STALE_S);
      profiles[n.slice(0, -5)] = snap;
    }
    this.data.profiles = profiles;
    if (!this.codexbar || !fs.existsSync(this.codexbar)) {
      const quotas = {};
      for (const [profile, snap] of Object.entries(profiles)) {
        for (const [provider, raw] of Object.entries(snap.quotas || {})) {
          if (!this.providers.includes(provider) || !raw || typeof raw !== "object") continue;
          const q = { ...raw, provider, profile, source: "hermes-account-usage",
            stale: !!raw.stale || snap.stale || now - (raw.fetched_at || raw.checkedAt || 0) > 900 };
          snap.quotas[provider] = q;
          const previous = quotas[provider];
          if (!previous || (q.fetched_at || q.checkedAt || 0) > (previous.fetched_at || previous.checkedAt || 0)) quotas[provider] = q;
        }
      }
      this.data.quotas = quotas;
    }
    this._changed();
  }

  readLaunchd() {
    if (process.platform !== "darwin") return;
    execFile("/bin/launchctl", ["list"], { timeout: 10_000 }, (err, stdout) => {
      if (err) return;
      const rows = [];
      for (const line of stdout.split("\n")) {
        const [pid, status, label] = line.trim().split(/\s+/);
        if (!label || !this.launchdPrefixes.some((p) => label.startsWith(p))) continue;
        rows.push({ label, pid: pid === "-" ? null : Number(pid), lastExit: Number(status) });
      }
      rows.sort((a, b) => a.label.localeCompare(b.label));
      this.data.launchd = rows;
      this._changed();
    });
  }

  readQuotas() {
    if (!this.codexbar || !fs.existsSync(this.codexbar)) {
      this.readSnapshots();
      return Promise.resolve();
    }
    return Promise.all(this.providers.map((provider) => new Promise((resolve) => {
      execFile(
        this.codexbar,
        ["usage", "--provider", provider, "--source", "oauth", "--json", "--no-credits", "--web-timeout", "15"],
        { timeout: 40_000, maxBuffer: 256 * 1024 },
        (err, stdout) => {
          const q = { provider, ok: false, checkedAt: Math.round(Date.now() / 1000) };
          try {
            if (err && !stdout) throw err;
            const entry = JSON.parse(stdout)[0];
            if (!entry || entry.error || !entry.usage) throw new Error("no usage");
            q.ok = true;
            q.updatedAt = entry.usage.updatedAt;
            q.windows = ["primary", "secondary"]
              .map((k) => entry.usage[k])
              .filter((w) => w && typeof w.usedPercent === "number")
              .map((w) => ({ minutes: w.windowMinutes, used: w.usedPercent, resetsAt: w.resetsAt }));
          } catch (e) {
            // Never surface raw output (identities/auth); only a coarse reason.
            q.err = /oauth|expired|missing|not found/i.test(String(stdout || "")) ? "login-needed" : "unavailable";
          }
          this.data.quotas[provider] = q;
          this._changed();
          resolve();
        }
      );
    })));
  }

  /** Profiles whose plugin must acknowledge a refresh: live, publishing quota providers, and plugin >= 2.6 (key present). */
  _awaiting(id) {
    return Object.values(this.data.profiles).filter((snap) => snap && !snap.stale && snap.quotas && Object.keys(snap.quotas).length
      && "quota_refresh" in snap && !(snap.quota_refresh && snap.quota_refresh.id >= id));
  }

  /**
   * On-demand quota refresh. The deck-events plugin (one per profile gateway) polls `quota-refresh.json` in the shared
   * state directory every second; on a new id it fetches every provider now and acknowledges with `quota_refresh.id` in
   * its next state snapshot. Resolves when every live profile acknowledged, or after `timeoutMs`.
   * Forced refreshes are at least REFRESH_MIN_GAP_MS apart: inside the window nothing is fetched and the answer says so.
   * @returns {Promise<{refreshed: boolean, throttled: boolean, timedOut: boolean, retryAfterS: number, fleet: object}>}
   */
  refreshQuotas({ timeoutMs = REFRESH_TIMEOUT_MS, now = () => Date.now(), pollMs = 500 } = {}) {
    if (this.refreshing) return this.refreshing;
    const wait = this.lastRefreshAt + REFRESH_MIN_GAP_MS - now();
    if (wait > 0) {
      return Promise.resolve({ refreshed: false, throttled: true, timedOut: false, retryAfterS: Math.ceil(wait / 1000), fleet: this.data });
    }
    this.lastRefreshAt = now();
    const id = Math.max(now(), this.refreshId + 1);
    this.refreshId = id;
    this.refreshing = (async () => {
      try {
        if (this.codexbar && fs.existsSync(this.codexbar)) {
          await this.readQuotas();
          return { refreshed: true, throttled: false, timedOut: false, retryAfterS: 0, fleet: this.data };
        }
        this._writeTrigger(id);
        const deadline = now() + timeoutMs;
        for (;;) {
          this.readSnapshots();
          if (!this._awaiting(id).length) return { refreshed: true, throttled: false, timedOut: false, retryAfterS: 0, fleet: this.data };
          if (now() >= deadline) return { refreshed: false, throttled: false, timedOut: true, retryAfterS: 0, fleet: this.data };
          await new Promise((r) => setTimeout(r, pollMs));
        }
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  _writeTrigger(id) {
    if (this.stateWrite) return this.stateWrite(id);
    fs.mkdirSync(this.stateDir, { recursive: true });
    const file = path.join(this.stateDir, TRIGGER_FILE);
    fs.writeFileSync(file + ".tmp", JSON.stringify({ id, at: id / 1000 }));
    fs.renameSync(file + ".tmp", file);
  }
}

module.exports = { Fleet };
