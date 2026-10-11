"use strict";
// Settings > Hermes config: Hermes' own config.yaml for each profile, and restarting the Hermes gateway or this relay.
// Desktop relay token only (server.js refuses mobile tokens on /hermes/*). The field list, defaults and the save are
// Hermes' own code, run by relay/tools/hermes-config.py with Hermes' Python (one short child process per request):
//
//   GET  /hermes/config/schema            {ok, fields: {key: {type, description, category, options?, free?}}, categoryOrder, profiles}
//   GET  /hermes/config?profile=<p>       {ok, profile, rev, values, explicit, managed, restartNeeded}
//   POST /hermes/config                   {profile, rev, set: {key: value}, unset: [key]} -> the new {rev, values, ...}
//   GET  /hermes/restart                  {gateway: job|null, relay: {startedAt, supervised}, restartNeeded}
//   POST /hermes/restart                  {target: "gateway"|"relay"} -> 202 {job} (gateway) | 202 {relay} (relay)
//
// Secret-like fields are never listed, read or written (the Python side drops them). Saves are serialized and need the
// revision the editor loaded; every save backs config.yaml up first (config.yaml.bak-deck-<timestamp>, newest 10 kept).
// The gateway restart runs `hermes gateway restart` (Hermes' own graceful drain + service manager restart) as a job the
// Deck polls. The relay restarts by exiting cleanly after its reply, only under a service manager that starts it again.
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { hermesPython } = require("./hermes-python");

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCRIPT = path.join(__dirname, "..", "tools", "hermes-config.py");
const BODY_MAX = 512 * 1024;
const SCHEMA_TTL = 60_000;
const OUTPUT_TAIL = 4000;

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readBody(req, max = BODY_MAX) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const parts = [];
    req.on("data", (b) => {
      n += b.length;
      if (n > max) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
      } else parts.push(b);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("bad json"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/** Settings from the relay's environment (see .env.example). */
function hermesConfigOptions(env = process.env) {
  const home = os.homedir();
  const venv = path.join(home, ".hermes", "hermes-agent", "venv", "bin", "python");
  const python = hermesPython({ configured: [["DECK_HERMES_PYTHON", env.DECK_HERMES_PYTHON], ["DECK_MOBILE_BRIDGE_PYTHON", env.DECK_MOBILE_BRIDGE_PYTHON]], venv, exists: fs.existsSync, warn: (m) => console.warn("deck-relay hermes config:", m) });
  return {
    enabled: !/^(0|false|no|off)$/i.test(String(env.DECK_HERMES_CONFIG ?? "").trim()),
    python,
    root: env.HERMES_ROOT || path.join(home, ".hermes"),
    agentDir: env.HERMES_AGENT_DIR || "",
    hermesBin: env.DECK_HERMES_BIN || "hermes",
    // systemd sets INVOCATION_ID, launchd XPC_SERVICE_NAME: someone starts the relay again after a clean exit
    supervised: !!(env.INVOCATION_ID || (env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== "0") || /^(1|true|yes|on)$/i.test(String(env.DECK_RELAY_SUPERVISED || ""))),
  };
}

class HermesConfig {
  /**
   * @param {object} o hermesConfigOptions() plus: quit() (relay restart: stop and exit), run (execFile-like, tests),
   *   spawnFn (spawn-like, tests), now, startedAt
   */
  constructor(o = {}) {
    this.o = { ...hermesConfigOptions({}), ...o };
    this.run = o.run || execFile;
    this.spawnFn = o.spawnFn || spawn;
    this.now = o.now || (() => Date.now());
    this.startedAt = o.startedAt || this.now();
    this.quit = o.quit || null;
    this.schemaCache = null;
    this.writes = Promise.resolve();
    this.job = null; // the last gateway restart
    this.restartNeeded = false; // a save happened since the last gateway restart this relay ran
    this.relayRestarting = false;
  }

  env() {
    const e = { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: os.homedir(), LANG: process.env.LANG || "C.UTF-8", HERMES_ROOT: this.o.root };
    if (this.o.agentDir) e.HERMES_AGENT_DIR = this.o.agentDir;
    for (const k of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "USER", "LOGNAME"]) if (process.env[k]) e[k] = process.env[k];
    return e;
  }

  /** One hermes-config.py call: its JSON answer, or {ok:false, code, error}. */
  py(args, input = null) {
    if (!this.o.python) return Promise.resolve({ ok: false, code: 503, error: "Hermes' Python not found; set DECK_HERMES_PYTHON in the relay's .env" });
    return new Promise((resolve) => {
      const child = this.run(this.o.python, ["-I", SCRIPT, ...args], { env: this.env(), timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        let r = null;
        try {
          r = JSON.parse(String(stdout || ""));
        } catch {
          r = null;
        }
        if (r && typeof r === "object") return resolve(r);
        const why = err ? (err.killed ? "timed out" : err.code === "ENOENT" ? `${this.o.python} not found` : err.message) : "no answer";
        resolve({ ok: false, code: 502, error: `hermes-config: ${why} ${String(stderr || "").trim().slice(-300)}`.trim() });
      });
      if (input !== null && child && child.stdin) child.stdin.end(JSON.stringify(input));
    });
  }

  async schema() {
    const c = this.schemaCache;
    if (c && this.now() - c.at < SCHEMA_TTL) return c.r;
    const r = await this.py(["schema"]);
    if (r.ok) this.schemaCache = { at: this.now(), r };
    return r;
  }

  async get(profile) {
    if (!PROFILE_RE.test(String(profile || ""))) return { ok: false, code: 400, error: "bad profile" };
    const r = await this.py(["get", profile]);
    return r.ok ? { ...r, restartNeeded: this.restartNeeded } : r;
  }

  /** Saves run one at a time (the Python side also checks the revision). */
  set(body) {
    const b = body && typeof body === "object" ? body : {};
    if (!PROFILE_RE.test(String(b.profile || ""))) return Promise.resolve({ ok: false, code: 400, error: "bad profile" });
    if (typeof b.rev !== "string" || !b.set || typeof b.set !== "object" || Array.isArray(b.set) || (b.unset !== undefined && !Array.isArray(b.unset))) {
      return Promise.resolve({ ok: false, code: 400, error: "expected {profile, rev, set, unset}" });
    }
    const next = this.writes.then(() => this.py(["set", b.profile], { rev: b.rev, set: b.set, unset: b.unset || [] }));
    this.writes = next.catch(() => {});
    return next.then((r) => {
      if (r.ok) this.restartNeeded = true;
      return r.ok ? { ...r, restartNeeded: true } : r;
    });
  }

  restartState() {
    return { gateway: this.job, relay: { startedAt: this.startedAt, supervised: !!this.o.supervised, restarting: this.relayRestarting }, restartNeeded: this.restartNeeded };
  }

  /** `hermes gateway restart`: Hermes drains running turns, then its service manager starts the gateway again. */
  restartGateway() {
    if (this.job && this.job.state === "running") return { code: 409, body: { ok: false, error: "a gateway restart is already running", job: this.job } };
    const job = { id: `${this.now().toString(36)}`, state: "running", startedAt: this.now(), endedAt: null, exitCode: null, output: "" };
    this.job = job;
    const tail = (s) => {
      job.output = (job.output + s).slice(-OUTPUT_TAIL);
    };
    let child;
    try {
      child = this.spawnFn(this.o.hermesBin, ["gateway", "restart"], { env: { ...this.env(), HERMES_HOME: this.o.root }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      Object.assign(job, { state: "failed", endedAt: this.now(), output: String(e.message || e) });
      return { code: 500, body: { ok: false, error: job.output, job } };
    }
    const kill = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000); // Hermes' own drain budget is a few minutes
    if (kill.unref) kill.unref();
    child.stdout?.on("data", (d) => tail(String(d)));
    child.stderr?.on("data", (d) => tail(String(d)));
    const done = (code, err) => {
      clearTimeout(kill);
      if (job.state !== "running") return;
      if (err) tail(`\n${err.code === "ENOENT" ? `${this.o.hermesBin} not found; set DECK_HERMES_BIN` : err.message}`);
      job.exitCode = typeof code === "number" ? code : null;
      job.state = code === 0 ? "done" : "failed";
      job.endedAt = this.now();
      if (code === 0) this.restartNeeded = false;
    };
    child.on("error", (e) => done(null, e));
    child.on("close", (code) => done(code));
    return { code: 202, body: { ok: true, job } };
  }

  /** The relay restarts by exiting after the reply; refused when nothing would start it again. */
  restartRelay(res) {
    if (!this.o.supervised || !this.quit) return send(res, 409, { ok: false, error: "the relay does not run under a service manager (systemd or launchd); restart it by hand" });
    this.relayRestarting = true;
    send(res, 202, { ok: true, relay: { startedAt: this.startedAt } });
    const t = setTimeout(() => this.quit(), 300);
    if (t.unref) t.unref();
  }

  /** true when it answered (paths under /hermes/); server.js has checked the relay token already. */
  onHttp(req, res, url) {
    const p = url.pathname;
    if (p !== "/hermes/config" && p !== "/hermes/config/schema" && p !== "/hermes/restart") return false;
    if (!this.o.enabled) {
      send(res, 404, { ok: false, error: "Hermes config editing is off on this relay (DECK_HERMES_CONFIG=0)" });
      return true;
    }
    const reply = (r) => send(res, r.ok ? 200 : r.code || 500, r);
    const fail = (e) => send(res, e.status || 500, { ok: false, error: e.status ? e.message : "internal error" });
    if (p === "/hermes/config/schema" && req.method === "GET") this.schema().then(reply, fail);
    else if (p === "/hermes/config" && req.method === "GET") this.get(url.searchParams.get("profile") || "default").then(reply, fail);
    else if (p === "/hermes/config" && req.method === "POST") readBody(req).then((b) => this.set(b)).then(reply, fail);
    else if (p === "/hermes/restart" && req.method === "GET") send(res, 200, { ok: true, ...this.restartState() });
    else if (p === "/hermes/restart" && req.method === "POST") {
      readBody(req, 4096).then((b) => {
        if (b.target === "gateway") {
          const r = this.restartGateway();
          return send(res, r.code, r.body);
        }
        if (b.target === "relay") return this.restartRelay(res);
        send(res, 400, { ok: false, error: "target must be gateway or relay" });
      }, fail);
    } else send(res, 405, { ok: false, error: "method not allowed" });
    return true;
  }
}

module.exports = { HermesConfig, hermesConfigOptions, SCRIPT };
