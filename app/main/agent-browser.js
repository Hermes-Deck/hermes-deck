"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
// Agent browsers (Workspace tab, D1). Each Hermes agent gets its own headless Chrome or Edge with its own
// profile under <userData>/agent-browsers/<agent>: never the user's browser, profile or mouse. The deck
// watches it through a CDP screencast and forwards the user's clicks and keys only while the user holds
// control. Nothing launches unless the user allowed agent browsers on this device (off by default).
// The live view, the agent's trail and the CDP client live in cdp-view.js (shared with the relay).
// Pure Node (no electron import), so tools and tests can load it.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const { CdpClient, LiveView, Trail, normalizeUrl, readsBlank } = require("./cdp-view");

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const IDLE_MS = 15 * 60 * 1000; // a browser nobody used or watched for this long is closed
// The relay waits 25 s for this deck's answer to a discovery request: a caller waits at most WAIT_MS for a
// starting browser (+ an 8 s fetch) so the answer fits in it. A cold start (first run of a new profile, a
// virus scan of chrome.exe, a loaded machine) can take longer: the launch keeps going in the background for
// up to LAUNCH_MS, so the agent's retry finds the browser running instead of starting it all over again.
const WAIT_MS = 15_000;
const LAUNCH_MS = 60_000;

// ---- finding and launching a browser ---------------------------------------------------------------
function browserCandidates(platform = process.platform, env = process.env) {
  const out = [];
  if (env.HERMES_DECK_BROWSER) out.push(env.HERMES_DECK_BROWSER);
  if (platform === "win32") {
    // per-machine and per-user Chrome, then Edge (always present on Windows 11)
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) out.push(path.win32.join(r, "Google", "Chrome", "Application", "chrome.exe"));
    for (const r of roots) out.push(path.win32.join(r, "Microsoft", "Edge", "Application", "msedge.exe"));
  } else if (platform === "darwin") {
    for (const base of ["/Applications", path.posix.join(os.homedir(), "Applications")]) {
      out.push(`${base}/Google Chrome.app/Contents/MacOS/Google Chrome`, `${base}/Chromium.app/Contents/MacOS/Chromium`, `${base}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`);
    }
  } else {
    for (const dir of String(env.PATH || "").split(":").filter(Boolean)) {
      for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) out.push(path.posix.join(dir, n));
    }
  }
  return out;
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** {path, kind} of a Chromium browser that can run headless, or null. */
function findBrowser({ platform = process.platform, env = process.env, exists = isFile } = {}) {
  for (const p of browserCandidates(platform, env)) {
    if (p && exists(p)) return { path: p, kind: /edge/i.test(p) ? "Edge" : /chromium/i.test(p) ? "Chromium" : "Chrome" };
  }
  return null;
}

function launchArgs(dir) {
  return [
    "--headless=new", // never a window on the user's desktop
    "--remote-debugging-port=0",
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,800",
    // agents work in background tabs too: do not throttle them
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []), // never a Keychain prompt
    ...(process.platform === "linux" ? ["--password-store=basic"] : []),
    "about:blank",
  ];
}

/**
 * Downloads stay in the agent's own folder (<profile>/Downloads), never the user's Downloads folder:
 * Chrome's default download directory is set in the profile before it starts. Returns that folder.
 */
function preparePrefs(dir) {
  const downloads = path.join(dir, "Downloads");
  fs.mkdirSync(downloads, { recursive: true });
  const file = path.join(dir, "Default", "Preferences");
  let prefs = {};
  try {
    prefs = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    prefs = {};
  }
  prefs.download = { ...(prefs.download || {}), default_directory: downloads, prompt_for_download: false, directory_upgrade: true };
  prefs.savefile = { ...(prefs.savefile || {}), default_directory: downloads };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(prefs));
  return downloads;
}

/** {port, wsPath} from <dir>/DevToolsActivePort, or null. */
function readActivePort(dir) {
  try {
    const [port, wsPath] = fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").split(/\r?\n/);
    const p = Number(port);
    if (p > 0 && p < 65536 && /^\/devtools\/browser\/[\w-]+$/.test(wsPath || "")) return { port: p, wsPath };
  } catch {
    /* not written yet */
  }
  return null;
}

/** A browser from an earlier run that still holds this profile: reuse it rather than fight its lock. */
async function adoptRunning(dir) {
  const a = readActivePort(dir);
  if (!a) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${a.port}/json/version`, { signal: AbortSignal.timeout(1500) });
    const v = await r.json();
    if (String(v.webSocketDebuggerUrl || "").endsWith(a.wsPath)) return a; // same instance, not a stranger on a reused port
  } catch {
    /* stale file */
  }
  return null;
}

/**
 * Starts a headless browser on `dir` and resolves {proc, port, wsPath} once it wrote DevToolsActivePort.
 * `prefix`: arguments before the browser's own (tests run a stand-in script through node). `onSpawn(proc)`
 * runs at once, so a quitting deck can kill a browser that has not reported its port yet.
 */
function launchBrowser({ exe, dir, timeoutMs = LAUNCH_MS, prefix = [], onSpawn = null }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(path.join(dir, "DevToolsActivePort"), { force: true });
    const proc = spawn(exe, [...prefix, ...launchArgs(dir)], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    if (onSpawn) onSpawn(proc);
    let tail = "";
    proc.stderr.on("data", (d) => {
      tail = (tail + d).slice(-2000);
    });
    let done = false;
    const t0 = Date.now();
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearInterval(iv);
      if (err) reject(err);
      else resolve(val);
    };
    proc.once("error", (e) => finish(e));
    proc.once("exit", (code) => finish(new Error(i18nText("U0001", { code: code, v: tail.trim().split(/\r?\n/).pop() || i18nText("U0002") }))));
    const iv = setInterval(() => {
      const a = readActivePort(dir);
      if (a) return finish(null, { proc, ...a });
      if (Date.now() - t0 > timeoutMs) {
        proc.kill();
        finish(new Error(i18nText("browser.startTimedOut", { v: Math.round(timeoutMs / 1000) })));
      }
    }, 100);
  });
}

// ---- one agent's browser ----------------------------------------------------------------------------
class AgentBrowser extends EventEmitter {
  constructor(host, slug) {
    super();
    this.host = host;
    this.slug = slug;
    this.status = "stopped"; // stopped | starting | running | error
    this.error = null;
    this.port = null;
    this.wsPath = null;
    this.proc = null;
    this.launching = null; // the browser process while it starts (before it reported its port)
    this.starting = null;
    this.controller = "agent"; // who may click and type: "agent" | "user"
    this.agentChannels = 0;
    this.viewers = 0;
    this.lastAgentAt = 0; // the agent's last real use (navigation, input, reading): not attach/enable bookkeeping
    this.lastAgentMethod = null;
    this.lastAct = null; // {targetId, act, at}: the page the agent acted on last (the live view follows it)
    this.lastUsed = Date.now();
    this.trail = null; // Trail while running: where the agent went (cdp-view.js)
    this.trailEntries = []; // kept across restarts
    this._emitTimer = null;
  }

  get dir() {
    return path.join(this.host.root, this.slug);
  }

  info() {
    return {
      slug: this.slug,
      status: this.status,
      error: this.error,
      controller: this.controller,
      agentChannels: this.agentChannels,
      lastAgentAt: this.lastAgentAt,
      lastAgentMethod: this.lastAgentMethod,
      trail: this.trailEntries.slice(-8).map(({ at, kind, url, title }) => ({ at, kind, url, title })),
      wall: this.trail ? this.trail.wall : null, // an open page looks like a robot check
    };
  }

  /** A discovery-only connection that records where the agent goes, also while nobody watches. */
  _watchTrail() {
    if (this.trail || this.status !== "running") return;
    const t = new Trail(`ws://127.0.0.1:${this.port}${this.wsPath}`, { entries: this.trailEntries });
    this.trail = t;
    this.trailEntries = t.entries;
    t.on("change", () => this._changed(true));
    t.on("lost", () => {
      if (this.trail === t) this.trail = null;
    });
    t.start().catch(() => {
      if (this.trail === t) this.trail = null;
    });
  }

  _stopTrail() {
    if (!this.trail) return;
    this.trail.stop();
    this.trail = null;
  }

  _changed(soon = false) {
    if (!soon) {
      clearTimeout(this._emitTimer);
      this._emitTimer = null;
      return this.emit("change", this.info());
    }
    if (!this._emitTimer) {
      this._emitTimer = setTimeout(() => {
        this._emitTimer = null;
        this.emit("change", this.info());
      }, 1000);
    }
  }

  start() {
    if (this.status === "running") return Promise.resolve(this);
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.status = "starting";
      this.error = null;
      this._changed();
      try {
        if (this.host.closed) throw new Error(i18nText("browser.closing"));
        const old = await adoptRunning(this.dir);
        if (old) Object.assign(this, { port: old.port, wsPath: old.wsPath, proc: null });
        else {
          if (!this.host.exe) throw new Error(i18nText("U0004"));
          if (this.host.closed) throw new Error(i18nText("browser.closing")); // the quit began during adoptRunning
          preparePrefs(this.dir);
          const { path: exe, prefix = [] } = this.host.exe;
          // the child is known from the moment it spawns: a quit (killNow) during a cold start ends it too
          const r = await launchBrowser({ exe, prefix, dir: this.dir, timeoutMs: this.host.launchMs, onSpawn: (p) => (this.launching = p) }).finally(() => (this.launching = null));
          if (this.host.closed) {
            r.proc.kill(); // the deck began quitting while this browser started
            throw new Error(i18nText("browser.closing"));
          }
          Object.assign(this, { port: r.port, wsPath: r.wsPath, proc: r.proc });
          r.proc.once("exit", () => {
            if (this.proc === r.proc) this._gone();
          });
        }
        this.status = "running";
        this.lastUsed = Date.now();
        this._watchTrail();
        this._changed();
        return this;
      } catch (e) {
        this.status = "error";
        this.error = String(e.message || e).slice(0, 200);
        this._changed();
        throw e;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  /**
   * The browser exited or was stopped. Control stays as it was: if the user held it, a relaunch is still the
   * user's (the agent must not get the browser back by closing or crashing it); "Hand to agent" hands it back.
   */
  _gone() {
    this._stopTrail();
    Object.assign(this, { proc: null, port: null, wsPath: null, status: "stopped", agentChannels: 0, lastAct: null });
    this._changed();
  }

  /** Close the browser (profile kept): ask over CDP so it flushes cookies, then make sure. */
  async stop() {
    if (this.starting) await this.starting.catch(() => {});
    if (this.status !== "running") return;
    const { port, wsPath, proc } = this;
    try {
      const c = await new CdpClient(`ws://127.0.0.1:${port}${wsPath}`).connect(2000);
      await c.send("Browser.close", {}, null, 2000).catch(() => {});
      c.close();
    } catch {
      /* already gone */
    }
    if (proc && proc.exitCode === null) {
      await new Promise((r) => {
        const t = setTimeout(r, 3000);
        proc.once("exit", () => {
          clearTimeout(t);
          r();
        });
      });
      if (proc.exitCode === null) proc.kill();
    }
    this._gone();
  }

  /** App is quitting: no time for CDP. A browser still starting (no port yet) is killed too. */
  killNow() {
    for (const p of [this.proc, this.launching]) if (p && p.exitCode === null && !p.signalCode) p.kill();
  }
}

// ---- all agent browsers on this device ------------------------------------------------------------------
class AgentBrowserHost extends EventEmitter {
  /**
   * @param {{root: string, enabled?: boolean, idleMs?: number, exe?: {path: string, kind: string, prefix?: string[]}|null,
   *          launchMs?: number, waitMs?: number}} o
   *   root: parent of the per-agent profiles; exe: the browser (default: findBrowser(); tests pass a stand-in);
   *   launchMs: how long a starting browser may take; waitMs: how long ensure() waits for it (see WAIT_MS)
   */
  constructor({ root, enabled = false, idleMs = IDLE_MS, exe, launchMs = LAUNCH_MS, waitMs = WAIT_MS, readOnly = false }) {
    super();
    this.root = root;
    this.allowed = !!enabled;
    this.readOnly = !!readOnly; // a screenshot run: `allowed` shows the user's switch, nothing ever launches
    this.idleMs = idleMs;
    this.exe = exe === undefined ? findBrowser() : exe;
    this.launchMs = launchMs;
    this.waitMs = waitMs;
    this.closed = false; // killAll ran: the deck is quitting, nothing starts any more
    this.browsers = new Map();
    this.timer = setInterval(() => this.sweep(), 60_000);
    if (this.timer.unref) this.timer.unref();
  }

  /** Allowed by the user and a browser was found (never in a read-only screenshot run). */
  enabled() {
    return this.allowed && !!this.exe && !this.readOnly;
  }

  async setEnabled(on) {
    this.allowed = !!on;
    if (!this.allowed) await this.stopAll();
  }

  get(slug) {
    const s = String(slug || "").toLowerCase();
    if (!SLUG_RE.test(s)) throw new Error(i18nText("U0005"));
    let b = this.browsers.get(s);
    if (!b) {
      b = new AgentBrowser(this, s);
      b.on("change", (info) => this.emit("change", info));
      this.browsers.set(s, b);
    }
    return b;
  }

  peek(slug) {
    return this.browsers.get(String(slug || "").toLowerCase()) || null;
  }

  /** The agent's browser, started if needed: {port, wsPath}. */
  async ensure(slug) {
    if (this.readOnly) throw new Error(i18nText("browser.noShotLaunch"));
    if (!this.enabled()) throw new Error(this.exe ? i18nText("U0006") : i18nText("U0004"));
    const b = this.get(slug);
    // a cold start may outlast the relay's wait: answer in time, and let the launch finish for the next try
    let timer = null;
    const slow = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(i18nText("browser.startContinues", { v: Math.round(this.waitMs / 1000) }))), this.waitMs);
    });
    try {
      await Promise.race([b.start(), slow]);
    } finally {
      clearTimeout(timer);
    }
    if (!this.allowed) throw new Error(i18nText("U0006")); // switched off while starting
    return { port: b.port, wsPath: b.wsPath };
  }

  controller(slug) {
    const b = this.peek(slug);
    return b ? b.controller : "agent";
  }

  /** Where this agent's downloads go (inside its own profile folder). */
  downloadDir(slug) {
    return path.join(this.root, String(slug).toLowerCase(), "Downloads");
  }

  /** Taking control needs a running browser; handing it back always works (control survives an exit). */
  setController(slug, who) {
    const b = this.peek(slug);
    if (!b || (who === "user" && b.status !== "running")) throw new Error(i18nText("U0007"));
    b.controller = who === "user" ? "user" : "agent";
    b._changed();
  }

  channelOpened(slug, kind) {
    const b = this.peek(slug);
    if (!b) return;
    if (kind === "agent") b.agentChannels += 1;
    b.lastUsed = Date.now();
    b._changed(true);
  }

  channelClosed(slug, kind) {
    const b = this.peek(slug);
    if (!b) return;
    if (kind === "agent") b.agentChannels = Math.max(0, b.agentChannels - 1);
    b.lastUsed = Date.now();
    b._changed(true);
  }

  /**
   * One command from the agent (cdp-tunnel.js). `hint` is AgentTracker's reading of it, {use, act, targetId}:
   * bookkeeping (use false: attach, enable...) keeps the browser alive but is not "using" it; an act on a
   * page tells the live view where the agent works ("agent-act").
   */
  noteAgent(slug, method, hint = null) {
    const b = this.peek(slug);
    if (!b) return;
    const now = Date.now();
    b.lastUsed = now;
    if (hint && hint.use === false) return;
    if (readsBlank(hint, b.trail && b.trail.pages)) return; // the supervisor's evaluate on about:blank
    b.lastAgentAt = now;
    b.lastAgentMethod = method;
    if (hint && hint.act && typeof hint.targetId === "string") {
      b.lastAct = { targetId: hint.targetId, act: hint.act, at: now };
      b.emit("agent-act", b.lastAct);
    }
    b._changed(true);
  }

  touch(slug) {
    const b = this.peek(slug);
    if (b) b.lastUsed = Date.now();
  }

  list() {
    return [...this.browsers.values()].map((b) => b.info());
  }

  sweep(now = Date.now()) {
    for (const b of this.browsers.values()) {
      if (b.status === "running" && !b.agentChannels && !b.viewers && now - b.lastUsed > this.idleMs) b.stop();
    }
  }

  stopAll() {
    return Promise.all([...this.browsers.values()].map((b) => b.stop().catch(() => {})));
  }

  killAll() {
    this.closed = true;
    clearInterval(this.timer);
    for (const b of this.browsers.values()) b.killNow();
  }
}

module.exports = { AgentBrowserHost, AgentBrowser, LiveView, CdpClient, findBrowser, browserCandidates, launchBrowser, readActivePort, preparePrefs, normalizeUrl, SLUG_RE, WAIT_MS, LAUNCH_MS };
