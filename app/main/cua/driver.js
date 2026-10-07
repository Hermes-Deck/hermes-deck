"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../../renderer/i18n");
// Supervises the Deck's private cua-driver: one daemon in bounded mode (`serve --permission-mode bounded
// --capability-manifest … --approve-capability-manifest`) on a socket only this Deck knows, plus the short-lived
// driver processes the relay's channels ask for (`mcp`, `call`, …), which are pointed at that socket.
//   Windows: the daemon is a hidden child process in the user's session.
//   macOS:   the daemon runs as CuaDriver.app (`open -n -g -a CuaDriver.app --args serve …`), so the
//            Accessibility and Screen Recording grants stay with the app's identity, not the Deck's.
// A daemon cannot be reconfigured while it runs, so a new manifest (a new grant) means a restart. Every
// driver process gets the bounded-mode environment too (protocol.driverEnv). Spawning is injected, so
// app/test/cua-link.test.js runs all of this against a fake driver.
const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn: nodeSpawn, spawnSync, spawn } = require("child_process");
const { daemonArgs, spawnArgs, driverEnv } = require("./protocol");
const { runFile, parseVersion } = require("./installer");
const { captureOutput } = require("./capture-output");

const READY_MS = 10000; // the daemon answers `status` within this, or it failed
const POLL_MS = 250;

class Driver extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dir  userData/cua-driver (the manifest lives here)
   * @param {() => ({bin: string, app?: string, prefix?: string[]}|null)} o.locate  the installed driver
   * @param {string} [o.platform]
   * @param {typeof nodeSpawn} [o.spawn]
   * @param {typeof runFile} [o.exec]  one-shot runs (status, stop, call, --version)
   * @param {object} [o.env]  base environment
   * @param {string} [o.socket]  daemon socket / named pipe (tests); default: a fresh private name
   */
  constructor({ dir, locate, platform = process.platform, spawn = nodeSpawn, exec = runFile, env = process.env, socket = null, capture = null }) {
    super();
    Object.assign(this, { dir, locate, platform, spawnFn: spawn, exec, env });
    this.capture = capture;
    const tag = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    this.socket = socket || (platform === "win32" ? `\\\\.\\pipe\\hermes-deck-cua-${tag}` : path.join(os.tmpdir(), `hdcua-${tag}.sock`));
    this.manifestPath = path.join(dir, "session.yaml");
    this.state = "stopped"; // stopped | starting | running | error
    this.error = null;
    this.key = null; // which manifest the running daemon has
    this.daemon = null; // Windows: the daemon child
    this.children = new Set(); // channel processes
    this.queue = Promise.resolve();
  }

  _set(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit("status", { status: state, error });
  }

  /** Serializes daemon starts and stops: a restart never overlaps another. */
  _serial(op) {
    const p = this.queue.then(op, op);
    this.queue = p.catch(() => {});
    return p;
  }

  _loc() {
    const loc = this.locate();
    if (!loc || !loc.bin) throw new Error(i18nText("U0114"));
    return { prefix: [], ...loc };
  }

  _env() {
    return driverEnv(this.env, { manifest: this.manifestPath });
  }

  /** The daemon runs with this manifest ({key, text}); restarts it when the key changed or it is down. */
  ensure(manifest) {
    return this._serial(async () => {
      if (this.state === "running" && this.key === manifest.key && (await this._alive())) return;
      await this._stopDaemon();
      this.killChildren(); // they were attached to the old daemon
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.manifestPath}.tmp`;
      fs.writeFileSync(tmp, manifest.text, { mode: 0o600 });
      fs.renameSync(tmp, this.manifestPath);
      this._set("starting");
      try {
        await this._startDaemon();
        this.key = manifest.key;
        this._set("running");
      } catch (e) {
        this.key = null;
        await this._stopDaemon();
        this._set("error", e.message);
        throw e;
      }
    });
  }

  /** Stops the daemon and every channel process. */
  stop() {
    return this._serial(async () => {
      this.killChildren();
      await this._stopDaemon();
      this.key = null;
      this._set("stopped");
    });
  }

  /**
   * Synchronous teardown for Durdur and quit: kills channel processes and the daemon now, without waiting
   * for anything (works with the relay and Hermes offline).
   */
  killAll() {
    this.killChildren();
    this._killDaemonSync();
    this.key = null;
    if (this.state !== "stopped") this._set("stopped");
  }

  killChildren() {
    for (const c of this.children) killProcess(c, this.platform);
    this.children.clear();
  }

  /**
   * Unix: a daemon that was killed (SIGKILL, or `stop` racing an exit) leaves its socket file behind, and the
   * next daemon's listen() on the same path then fails with EADDRINUSE. The path is private to this Deck and
   * our daemon is down when this runs, so a leftover socket file is always stale. Never touches a non-socket.
   */
  _clearStaleSocket() {
    if (this.platform === "win32") return; // named pipes vanish with their process
    try {
      if (fs.lstatSync(this.socket).isSocket()) fs.unlinkSync(this.socket);
    } catch {
      /* no file: nothing to clear */
    }
  }

  async _startDaemon() {
    const loc = this._loc();
    this._clearStaleSocket();
    const args = daemonArgs({ socket: this.socket, manifest: this.manifestPath });
    let child = null;
    if (this.platform === "darwin") {
      if (!loc.app) throw new Error(i18nText("U0115"));
      const r = await this.exec("/usr/bin/open", ["-n", "-g", "-a", loc.app, "--args", ...args], { timeout: 15000 });
      if (r.code !== 0) throw new Error(i18nText("U0116", { v: r.stderr.trim().slice(0, 160) }));
    } else {
      child = this.spawnFn(loc.bin, [...loc.prefix, ...args], { cwd: this.dir, env: this._env(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      this.daemon = child;
      child.tail = "";
      const keep = (b) => (child.tail = (child.tail + String(b)).slice(-2000));
      if (child.stdout) child.stdout.on("data", () => {}); // drained, never shown
      if (child.stderr) child.stderr.on("data", keep);
      child.on("error", (e) => {
        keep(e.message);
        child.exited = true;
      });
      child.on("exit", (code) => {
        child.exited = true;
        if (this.daemon !== child) return;
        this.daemon = null;
        this.key = null;
        if (this.state === "running") this._set("error", i18nText("U0117", { code: code }));
      });
    }
    const t0 = Date.now();
    while (Date.now() - t0 < READY_MS) {
      if (child && child.exited) throw new Error(i18nText("U0118", { v: child.tail.trim().slice(-200) || i18nText("U0002") }));
      if (await this._alive()) return;
      await sleep(POLL_MS);
    }
    throw new Error(i18nText("U0119"));
  }

  /** `status --socket <ours>` exits 0 while our daemon answers. */
  async _alive() {
    let loc;
    try {
      loc = this._loc();
    } catch {
      return false;
    }
    if (this.platform !== "darwin" && (!this.daemon || this.daemon.exited)) return false;
    const r = await this.exec(loc.bin, [...loc.prefix, "status", "--socket", this.socket], { timeout: 4000, env: this._env() });
    return r.code === 0;
  }

  async _stopDaemon() {
    if (this.platform === "darwin") {
      let loc = null;
      try {
        loc = this._loc();
      } catch {
        /* nothing installed: nothing to stop */
      }
      if (loc) await this.exec(loc.bin, [...loc.prefix, "stop", "--socket", this.socket], { timeout: 4000 });
      this._killDaemonSync();
      return;
    }
    const d = this.daemon;
    this.daemon = null;
    if (!d || d.exited) return;
    const gone = new Promise((resolve) => d.once("exit", resolve));
    killProcess(d, this.platform, true);
    await Promise.race([gone, sleep(3000)]);
  }

  _killDaemonSync() {
    if (this.platform === "darwin") {
      // the daemon is not our child: find it by its unique socket path
      spawnSync("/usr/bin/pkill", ["-f", "--", this.socket], { timeout: 3000 });
      return;
    }
    const d = this.daemon;
    this.daemon = null;
    if (d && !d.exited) killProcess(d, this.platform, true);
  }

  /** Starts one channel's driver process. The caller wires its stdio. Throws when nothing is installed. */
  run(argv) {
    const loc = this._loc();
    const child = this.spawnFn(loc.bin, [...loc.prefix, ...spawnArgs(argv, { socket: this.socket })], {
      cwd: this.dir,
      env: this._env(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: this.platform !== "win32", // own process group, so a kill takes its helpers too
    });
    this.children.add(child);
    const forget = () => this.children.delete(child);
    child.on("exit", forget);
    child.on("error", forget);
    return this.capture ? captureOutput(child, argv, this.capture) : child;
  }

  /** A one-shot tool call through the daemon (the Deck's own `list_windows`); resolves stdout. */
  async call(tool, args = {}) {
    const r = await this._exec(["call", "--socket", this.socket, tool, JSON.stringify(args)], 10000);
    if (r.code !== 0) throw new Error(callError(r));
    return r.stdout;
  }

  /** `cua-driver --version` -> "x.y.z" (or null). */
  async version() {
    const r = await this._exec(["--version"], 10000);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 200) || i18nText("U0120", { code: r.code }));
    return parseVersion(r.stdout || r.stderr);
  }

  /** `cua-driver list-tools` ("name: description" per line), or "" when it fails. */
  async toolList() {
    const r = await this._exec(["list-tools"], 10000);
    return r.code === 0 ? r.stdout : "";
  }

  /** One info verb of a channel (manifest, --help, status, doctor), run to completion: {code, stdout, stderr}. */
  execInfo(argv) {
    return this._exec(spawnArgs(argv, { socket: this.socket }), 20000);
  }

  _exec(args, timeout) {
    const loc = this._loc();
    return this.exec(loc.bin, [...loc.prefix, ...args], { timeout, env: this._env() });
  }
}

const SCAN_MAX = 65536; // a refusal is short; never scan megabytes of output for one
const SCAN_STARTS = 64;

/** The balanced {...} that starts at `at` (string-aware), or null when it never closes. */
function balancedObject(text, at) {
  let depth = 0;
  let inString = false;
  for (let i = at; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) return text.slice(at, i + 1);
  }
  return null;
}

/** The message of a JSON refusal or error ({refusal|error: {message} | "text"}) anywhere in `text`, or "". */
function refusalIn(text) {
  const s = String(text || "").slice(0, SCAN_MAX);
  let starts = 0;
  for (let at = s.indexOf("{"); at >= 0 && starts < SCAN_STARTS; at = s.indexOf("{", at + 1), starts += 1) {
    const obj = balancedObject(s, at); // a stray "{" in text before the JSON never closes: try the next one
    if (!obj) continue;
    let v;
    try {
      v = JSON.parse(obj);
    } catch {
      continue;
    }
    const ref = v && typeof v === "object" ? v.refusal || v.error : null;
    const msg = ref && typeof ref === "object" ? ref.message : ref;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  }
  return "";
}

/**
 * Why a `call` failed, in one line. A bounded-mode refusal comes as JSON ({refusal: {code, message}, status}),
 * on stdout so far, possibly with log lines or hints around it or warnings on stderr: its message, wherever it
 * is, is what the user can read, not the JSON around it. Without one, the text as it is (stderr first).
 */
function callError({ code, stdout, stderr }) {
  const msg = refusalIn(stdout) || refusalIn(stderr);
  if (msg) return msg.slice(0, 200);
  const raw = String(stderr || "").trim() || String(stdout || "").trim();
  return raw.slice(0, 200) || i18nText("U0120", { code: code });
}

/**
 * Kills a child. Windows: TerminateProcess at once; for the daemon (tree), taskkill /T first so its helper
 * processes go too. taskkill runs in the background (it can take a second) and the daemon is terminated
 * outright 1.5 s later if it is still there: Durdur never waits on it.
 */
function killProcess(child, platform, tree = false) {
  if (!child || child.exited || Number.isInteger(child.exitCode) || child.signalCode) return;
  try {
    if (platform === "win32") {
      if (tree && child.pid && !child.treeKill) {
        child.treeKill = true;
        const tk = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        tk.on("error", () => child.kill());
        setTimeout(() => !child.exited && child.exitCode === null && child.kill(), 1500).unref();
      } else if (!tree) child.kill();
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL"); // the process group (spawned detached)
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {
    /* already gone */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { Driver, killProcess, callError };
