"use strict";
// Agent browsers on the agent host itself. presence.js routes an agent here by default ("Otomatik": the agent
// host first, DECK_BROWSER_DEFAULT=host), or when the user picked this machine in the Workspace tab. Two kinds:
//  - headless (DECK_FALLBACK_BROWSER=1): each agent gets its own headless Chrome (or Chromium/Edge) with its own
//    profile under the relay's data folder and a random debugging port. It never touches the user's own Chrome,
//    its profile or its debugging port.
//  - external (DECK_FALLBACK_BROWSER_CDP=http://127.0.0.1:<port>): ONE already running browser (for example a
//    persistent headful Chrome kept alive by its own service) is attached over its loopback debugging port and
//    shared by one agent profile (DECK_FALLBACK_BROWSER_CDP_AGENT, default: the CDP default agent). The relay
//    only attaches and detaches: it never launches, restarts, closes or kills that browser, and it refuses
//    Browser.close / Browser.crash from the agent. If the browser goes away the agent host browser shows as
//    stopped until it answers again (probed every few seconds).
// Decks watch these browsers through workspace.js (screencast over their relay connection); while a user
// holds control, the agent's clicks, typing and navigation are refused here, like on a deck.
// The launcher mirrors app/main/agent-browser.js; the two packages are deployed separately.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { EventEmitter } = require("events");
const WebSocket = require("ws");
const { Channel } = require("./cdp");
const { AgentTracker, Trail, readsBlank, USER_ONLY, USER_ONLY_HTTP, BLOCKED, legacyTransport, LEGACY_BLOCKED } = require("./cdp-view");

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// an external browser is shared and persistent: the agent may never close or crash it, whoever holds control
const EXTERNAL_NEVER = /^Browser\.(?:close|crash|crashGpuProcess)$/;
const EXTERNAL_BLOCKED = "Hermes Deck: this is the agent host's shared, persistent browser; Browser.close and Browser.crash are refused.";
const PROBE_MS = 5000;
const HTTP_RE = /^\/json(?:\/(?:version|list|protocol|new|activate\/[\w.-]{1,128}|close\/[\w.-]{1,128}))?(?:\?[^#\s]*)?$/;
const SOCKET_RE = /^\/devtools\/(browser|page)\/([\w.-]{1,128})$/;

function candidates(platform = process.platform, env = process.env) {
  if (platform === "darwin") {
    const out = [];
    for (const base of ["/Applications", path.posix.join(os.homedir(), "Applications")]) {
      out.push(`${base}/Google Chrome.app/Contents/MacOS/Google Chrome`, `${base}/Chromium.app/Contents/MacOS/Chromium`, `${base}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`);
    }
    return out;
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    return [
      ...roots.map((r) => path.win32.join(r, "Google", "Chrome", "Application", "chrome.exe")),
      ...roots.map((r) => path.win32.join(r, "Microsoft", "Edge", "Application", "msedge.exe")),
    ];
  }
  const out = [];
  for (const dir of String(env.PATH || "").split(":").filter(Boolean)) {
    for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) out.push(path.posix.join(dir, n));
  }
  return out;
}

function findBrowser(explicit = null, platform = process.platform, env = process.env) {
  const isFile = (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (explicit) return isFile(explicit) ? explicit : null;
  return candidates(platform, env).find(isFile) || null;
}

/**
 * This machine's name for the Deck's host picker ("Home server"): DECK_HOST_NAME, else macOS's computer name,
 * else the host name without ".local".
 */
function hostName(env = process.env, platform = process.platform) {
  const clean = (s) => String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 48);
  if (clean(env.DECK_HOST_NAME)) return clean(env.DECK_HOST_NAME);
  if (platform === "darwin") {
    try {
      const n = clean(execFileSync("scutil", ["--get", "ComputerName"], { timeout: 2000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
      if (n) return n;
    } catch {
      /* fall back to the host name */
    }
  }
  return clean(os.hostname().replace(/\.local$/i, "")) || "agent host";
}

/**
 * Validate the DECK_FALLBACK_BROWSER_CDP value: loopback only (http://127.0.0.1:<port>, http://localhost:<port> or
 * http://[::1]:<port>, nothing else in the URL). Returns {port} or null. The relay always connects to 127.0.0.1.
 */
function parseExternalCdp(value) {
  const v = String(value || "").trim();
  if (!v) return null;
  let u;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const loop = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  const port = Number(u.port);
  if (u.protocol !== "http:" || !loop || u.username || u.password || !(port > 0 && port < 65536) || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return null;
  return { port };
}

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

// A cold start on a busy machine (first run of a profile, a loaded CI runner) can take well over 10 s.
const LAUNCH_TIMEOUT_MS = 30_000;

/** Chrome refuses to start as root on Linux without --no-sandbox; a relay run as root (systemd) needs it. */
function rootSandboxArgs(platform = process.platform, uid = typeof process.getuid === "function" ? process.getuid() : -1) {
  return platform === "linux" && uid === 0 ? ["--no-sandbox"] : [];
}

function launchHeadless(exe, dir, timeoutMs = LAUNCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(path.join(dir, "DevToolsActivePort"), { force: true });
    const args = [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,800",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []), // never a Keychain prompt
      ...(process.platform === "linux" ? ["--password-store=basic"] : []),
      ...rootSandboxArgs(),
      "about:blank",
    ];
    const proc = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
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
    proc.once("exit", (code) => finish(new Error(`browser exited (${code}): ${tail.trim().split(/\r?\n/).pop() || "no output"}`)));
    const iv = setInterval(() => {
      const a = readActivePort(dir);
      if (a) return finish(null, { proc, ...a });
      if (Date.now() - t0 > timeoutMs) {
        proc.kill();
        finish(new Error("browser did not report its debugging port"));
      }
    }, 100);
  });
}

/** Ask a browser to exit; resolves once it has (SIGKILL after graceMs, and never waits past twice that). */
function stopProcess(proc, graceMs = 5000) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(hard);
      clearTimeout(give);
      resolve();
    };
    const hard = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, graceMs);
    const give = setTimeout(done, graceMs * 2);
    proc.once("exit", done);
    try {
      proc.kill();
    } catch {
      done();
    }
  });
}

/**
 * One agent's browser on this machine. It has the shape cdp-view.js's LiveView watches on a deck: port,
 * wsPath, controller, lastAct, and "agent-act" events from the agent's own commands. "change" carries info().
 */
class HostBrowser extends EventEmitter {
  constructor(slug) {
    super();
    this.slug = slug;
    this.status = "stopped"; // stopped | starting | running | error
    this.error = null;
    this.port = null;
    this.wsPath = null;
    this.proc = null; // the launched browser (null for an external one, which the relay never owns)
    this.external = false; // an already running browser attached over its debugging port (see the header)
    this.starting = null;
    this.open = 0; // the agent's sockets
    this.viewers = 0; // decks watching
    this.controller = "agent"; // who may click and type: "agent" | "user"
    this.lastUsed = Date.now();
    this.lastAgentAt = 0; // real use, not attach/enable bookkeeping
    this.lastAgentMethod = null;
    this.lastAct = null;
    this.trail = null;
    this.trailEntries = [];
    this._emitTimer = null;
  }

  info() {
    return {
      slug: this.slug,
      status: this.status,
      error: this.error,
      external: this.external,
      controller: this.controller,
      agentChannels: this.open,
      lastAgentAt: this.lastAgentAt,
      lastAgentMethod: this.lastAgentMethod,
      trail: this.trailEntries.slice(-8).map(({ at, kind, url, title }) => ({ at, kind, url, title })),
      wall: this.trail ? this.trail.wall : null,
    };
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

  _watchTrail() {
    if (this.trail || !this.port) return;
    const t = new Trail(`ws://127.0.0.1:${this.port}${this.wsPath}`, { entries: this.trailEntries });
    this.trail = t;
    this.trailEntries = t.entries;
    t.on("change", () => this._changed(true));
    // an external browser has no process to watch: its trail socket closing is how its exit is noticed
    const lost = () => {
      if (this.trail !== t) return;
      this.trail = null;
      if (this.external && this.status === "running") this._gone();
    };
    t.on("lost", lost);
    t.start().catch(lost);
  }

  /**
   * The browser exited. Control stays as it was: if the user held it, a relaunch is still the user's (the
   * agent must not get the browser back by closing or crashing it). The deck hands it back, or the relay
   * does when that deck disconnects (workspace.js onClose).
   */
  _gone() {
    if (this.trail) this.trail.stop();
    Object.assign(this, { trail: null, port: null, wsPath: null, proc: null, status: "stopped", lastAct: null });
    this._changed();
  }
}

class FallbackHost extends EventEmitter {
  /**
   * @param {{dir: string, browserPath?: string|null, name?: string, idleS?: number, launchTimeoutMs?: number,
   *   headless?: boolean, external?: {port: number, agent: string}|null, probeMs?: number}} opts
   *   dir: parent of the per-agent profile folders (the relay's data/agent-browsers)
   *   launchTimeoutMs: how long a starting browser may take to report its debugging port
   *   headless: launch a headless browser per agent (default true; false = only the external browser)
   *   external: attach this already running browser (loopback debugging port) for the agent `agent`
   *   probeMs: how often the external browser is checked (attach, or notice that it is gone)
   * Events: "change" (one agent's info()).
   */
  constructor({ dir, browserPath = null, name = null, idleS = 900, launchTimeoutMs = LAUNCH_TIMEOUT_MS, headless = true, external = null, probeMs = PROBE_MS }) {
    super();
    this.dir = dir;
    this.headless = headless !== false;
    this.external = external && external.port && SLUG_RE.test(String(external.agent || "")) ? { port: external.port, agent: String(external.agent) } : null;
    this.exe = this.headless ? findBrowser(browserPath) : null;
    this.name = name || hostName();
    this.idleMs = idleS * 1000;
    this.launchTimeoutMs = launchTimeoutMs;
    this.stopped = false;
    this.agents = new Map(); // slug -> HostBrowser
    this.timer = setInterval(() => this.sweep(), 60_000);
    if (this.timer.unref) this.timer.unref();
    this.probeTimer = null;
    if (this.external) {
      this.probeTimer = setInterval(() => this._probe(), probeMs);
      if (this.probeTimer.unref) this.probeTimer.unref();
    }
  }

  /** A headless browser can be launched (a Chrome/Chromium/Edge was found and headless mode is on). */
  get headlessAvailable() {
    return !!this.exe;
  }

  get available() {
    return !!this.exe || !!this.external;
  }

  /** Can this agent's browser run here? The external browser belongs to one agent; the rest need headless. */
  serves(slug) {
    return (!!this.external && slug === this.external.agent) || !!this.exe;
  }

  /** The agent profiles this host serves, or null for all of them (presence.js `agents`). */
  agentList() {
    return this.exe ? null : this.external ? [this.external.agent] : [];
  }

  _agent(slug) {
    if (!SLUG_RE.test(slug)) throw Object.assign(new Error("bad agent name"), { status: 400 });
    let a = this.agents.get(slug);
    if (!a) {
      a = new HostBrowser(slug);
      a.external = !!this.external && slug === this.external.agent;
      a.on("change", (info) => this.emit("change", info));
      this.agents.set(slug, a);
    }
    a.lastUsed = Date.now();
    return a;
  }

  /** The agent's browser if it exists (never starts one). */
  peek(slug) {
    return this.agents.get(String(slug || "")) || null;
  }

  list() {
    return [...this.agents.values()].map((a) => a.info());
  }

  /**
   * Attach the external browser: ask its debugging port for the browser websocket (/json/version) and remember it.
   * Never launches anything. Resolves the HostBrowser, or rejects when the browser does not answer.
   */
  async _attach(a) {
    const r = await fetch(`http://127.0.0.1:${this.external.port}/json/version`, { signal: AbortSignal.timeout(3000) });
    const v = r.ok ? await r.json() : null;
    const m = v && typeof v.webSocketDebuggerUrl === "string" ? /^wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+(\/devtools\/browser\/[\w-]+)$/.exec(v.webSocketDebuggerUrl) : null;
    if (!m) throw new Error("the external browser did not answer its discovery request");
    return { port: this.external.port, wsPath: m[1] };
  }

  async _ensureExternal(a) {
    if (a.status === "running" && a.port) return a;
    if (this.stopped) throw Object.assign(new Error("relay stopping"), { status: 503 });
    if (!a.starting) {
      a.status = "starting";
      a.error = null;
      a._changed();
      a.starting = this._attach(a)
        .then((r) => {
          if (this.stopped) throw Object.assign(new Error("relay stopping"), { status: 503 });
          Object.assign(a, { port: r.port, wsPath: r.wsPath, status: "running", error: null });
          a._watchTrail();
          a._changed();
          return a;
        })
        .catch((e) => {
          Object.assign(a, { status: "error", error: "the agent host's browser is not reachable" });
          a._changed();
          throw Object.assign(new Error(a.error), { status: 503 });
        })
        .finally(() => {
          a.starting = null;
        });
    }
    return a.starting;
  }

  /**
   * Keep an eye on the external browser: attach it when it answers (so the Deck can watch it before the agent
   * uses it), and let go of it when it stops answering or restarted under a new browser id. Quiet: a browser that
   * stays unreachable changes nothing and emits nothing.
   */
  async _probe() {
    if (!this.external || this.stopped) return;
    const a = this._agent(this.external.agent);
    if (a.starting) return;
    let r = null;
    try {
      r = await this._attach(a);
    } catch {
      /* unreachable */
    }
    if (this.stopped) return;
    if (a.status === "running") {
      if (!r || r.wsPath !== a.wsPath) a._gone(); // exited, or restarted: a restarted one is attached on the next probe
      return;
    }
    if (r) await this._ensureExternal(a).catch(() => {});
  }

  /** Attach the external browser now if it is up (the relay calls this once at start). */
  attachExternal() {
    return this._probe();
  }

  async ensure(slug) {
    const a = this._agent(slug);
    if (a.external) return this._ensureExternal(a);
    if (a.proc && a.proc.exitCode === null && a.port) return a;
    if (!this.exe) throw Object.assign(new Error("no Chrome, Chromium or Edge found for the fallback browser"), { status: 503 });
    if (this.stopped) throw Object.assign(new Error("relay stopping"), { status: 503 });
    if (!a.starting) {
      a.status = "starting";
      a.error = null;
      a._changed();
      a.starting = launchHeadless(this.exe, path.join(this.dir, slug), this.launchTimeoutMs)
        .then((r) => {
          if (this.stopped) {
            // stopAll() ran while this browser was starting: it must not outlive the relay
            return stopProcess(r.proc).then(() => {
              throw Object.assign(new Error("relay stopping"), { status: 503 });
            });
          }
          Object.assign(a, { port: r.port, wsPath: r.wsPath, proc: r.proc, status: "running" });
          r.proc.once("exit", () => {
            if (a.proc === r.proc) a._gone();
          });
          a._watchTrail();
          a._changed();
          return a;
        })
        .catch((e) => {
          Object.assign(a, { status: "error", error: String(e.message || e).slice(0, 200) });
          a._changed();
          throw e;
        })
        .finally(() => {
          a.starting = null;
        });
    }
    return a.starting;
  }

  async http(slug, { method, path: p }) {
    if (!HTTP_RE.test(p)) throw Object.assign(new Error("bad path"), { status: 400 });
    // while the user holds control the agent may not open, close or bring forward a tab over HTTP either
    const held = this.peek(slug);
    if (held?.transferring) throw Object.assign(new Error("browser transfer in progress"), { status: 409 });
    if (held && held.controller === "user" && USER_ONLY_HTTP.test(p)) throw Object.assign(new Error(BLOCKED), { status: 409 });
    const a = await this.ensure(slug);
    const r = await fetch(`http://127.0.0.1:${a.port}${p}`, { method: method === "PUT" ? "PUT" : "GET", signal: AbortSignal.timeout(30_000) });
    return { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
  }

  /**
   * Who may click and type in this agent's browser: the user (from a deck) or the agent. Taking control needs
   * a running browser; handing it back always works (control survives a browser exit, see _gone).
   */
  setController(slug, who) {
    const a = this.peek(slug);
    if (!a || (who === "user" && a.status !== "running")) throw Object.assign(new Error("tarayıcı çalışmıyor"), { status: 409 });
    a.controller = who === "user" ? "user" : "agent";
    a._changed();
  }

  /** One agent command (or a page it just made): see app/main/agent-browser.js noteAgent. */
  _note(a, method, hint) {
    const now = Date.now();
    a.lastUsed = now;
    if (hint && hint.use === false) return;
    if (readsBlank(hint, a.trail && a.trail.pages)) return; // the supervisor's evaluate on about:blank
    a.lastAgentAt = now;
    a.lastAgentMethod = method;
    if (hint && hint.act && typeof hint.targetId === "string") {
      a.lastAct = { targetId: hint.targetId, act: hint.act, at: now };
      a.emit("agent-act", a.lastAct);
    }
    a._changed(true);
  }

  async open(slug, p) {
    const m = SOCKET_RE.exec(p);
    if (!m) throw Object.assign(new Error("bad path"), { status: 400 });
    const a = await this.ensure(slug);
    // any browser id means this agent's current browser: a restart since discovery must not strand it
    const target = m[1] === "browser" ? a.wsPath : `/devtools/page/${m[2]}`;
    const ws = new WebSocket(`ws://127.0.0.1:${a.port}${target}`, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024, handshakeTimeout: 30_000 });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    a.open += 1;
    a._changed(true);
    const track = new AgentTracker(m[1] === "page" ? m[2] : null);
    let chan = null;
    chan = new Channel(0, {
      send: (buf) => {
        let msg;
        try {
          msg = JSON.parse(buf.toString("utf8"));
        } catch {
          return; // not a CDP command
        }
        if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string") return;
        const refuse = (message) => {
          this._note(a, msg.method, { use: true, act: null, targetId: null }); // tried: still counts as use
          const err = { id: msg.id, error: { code: -32000, message } };
          if (typeof msg.sessionId === "string") err.sessionId = msg.sessionId;
          return chan.push(Buffer.from(JSON.stringify(err)));
        };
        // the non-flat transport would carry any command past the control gate: refused always, like the deck tunnel
        if (legacyTransport(msg)) return refuse(LEGACY_BLOCKED);
        if (a.transferring) return refuse("browser transfer in progress");
        if (a.external && EXTERNAL_NEVER.test(msg.method)) return refuse(EXTERNAL_BLOCKED);
        if (a.controller === "user" && USER_ONLY.test(msg.method)) return refuse(BLOCKED);
        this._note(a, msg.method, track.command(msg));
        if (ws.readyState === 1) ws.send(buf, { binary: false });
      },
      close: () => ws.close(),
    });
    ws.on("message", (data) => {
      const made = track.reply(data);
      if (made) this._note(a, "Target.createTarget", { use: true, ...made });
      chan.push(data);
    });
    ws.on("error", () => {});
    ws.on("close", (code, reason) => chan.ended(code, String(reason || "")));
    chan.once("close", () => {
      a.open = Math.max(0, a.open - 1);
      a.lastUsed = Date.now();
      a._changed(true);
    });
    return chan;
  }

  /** Close browsers nobody has used or watched for idleS. */
  sweep(now = Date.now()) {
    for (const a of this.agents.values()) {
      if (a.proc && !a.open && !a.viewers && now - a.lastUsed > this.idleMs) a.proc.kill(); // its trail is kept
    }
  }

  /** Close every browser, including one still starting; resolves once they have all exited. */
  stopAll(graceMs = 5000) {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.probeTimer); // an external browser is only detached: it has no process of ours
    const waits = [];
    for (const a of this.agents.values()) {
      if (a.trail) a.trail.stop();
      if (a.proc) waits.push(stopProcess(a.proc, graceMs)); // its exit runs HostBrowser._gone()
      else if (a.starting) waits.push(a.starting.catch(() => {})); // its .then() stops it (this.stopped)
    }
    this.agents.clear();
    return Promise.all(waits).then(() => {});
  }
}

module.exports = { FallbackHost, HostBrowser, findBrowser, candidates, readActivePort, launchHeadless, rootSandboxArgs, stopProcess, hostName, parseExternalCdp, EXTERNAL_BLOCKED };
