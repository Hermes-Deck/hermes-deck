#!/usr/bin/env node
"use strict";
// deck-cua: the cua-driver Hermes runs when Hermes Deck's bot screen is on for a profile
// (HERMES_CUA_DRIVER_CMD=<checkout>/relay/bin/deck-cua). It asks the relay where this Hermes session's
// computer_use goes (docs/bot-screen-protocol.md), then:
//   host    runs the real local driver (DECK_CUA_DRIVER, else cua-driver on PATH) with stdio inherited
//   device  carries stdin/stdout/stderr over the relay's local driver socket to the deck on that device
//   none    prints one line for the agent (Hermes shows it the last stderr line) and exits 69
// `manifest` output gets mcp_invocation.command pointed back at this wrapper: Hermes launches whatever path the
// manifest reports, which would silently bypass routing.
//
// Exit codes: the driver's own; 69 no route; 75 relay unavailable, or the relay ended the session (stop,
// device gone, route moved); 126 verb not allowed on a device; 127 no local driver.
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const wire = require("../src/driver-wire");

const EX = Object.freeze({ NO_ROUTE: 69, UNAVAILABLE: 75, NOT_ALLOWED: 126, NO_DRIVER: 127 });
const CONNECT_MS = 5000;
const ROUTE_MS = 15_000;
const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const signo = (sig) => (os.constants.signals && os.constants.signals[sig]) || 15;

/** Settings: this process's env first, then the relay's .env next to this script. The relay token is never read. */
function settings(env, scriptDir = __dirname) {
  const file = wire.parseEnvFile(env.DECK_RELAY_ENV || path.join(scriptDir, "..", ".env"));
  const pick = (k) => env[k] || file[k] || "";
  const deckHome = wire.expandHome(pick("DECK_HOME")) || path.join(os.homedir(), ".hermes-deck");
  return { sock: pick("DECK_DRIVER_SOCK") || wire.defaultSockPath(deckHome), driver: pick("DECK_CUA_DRIVER") };
}

/** Point a driver manifest's MCP launch command at this wrapper; anything that is not a manifest passes unchanged. */
function rewriteManifest(text, self) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return text;
  }
  if (!m || typeof m !== "object" || Array.isArray(m) || !m.mcp_invocation || typeof m.mcp_invocation !== "object") return text;
  m.mcp_invocation.command = self;
  return JSON.stringify(m) + "\n";
}

function sameFile(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

function which(name, envPath, skip) {
  const exts = process.platform === "win32" ? ["", ...String(process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of String(envPath || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile() && !skip(p)) return p;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** {path} of the real local driver, or {error}. Never this wrapper (that would loop forever). */
function resolveDriver(configured, env, selves) {
  const isSelf = (p) => selves.some((s) => s && sameFile(p, s));
  const name = wire.expandHome(configured || "cua-driver");
  const p = /[\\/]/.test(name) ? path.resolve(name) : which(name, env.PATH, isSelf);
  if (!p || !fs.existsSync(p)) {
    return { error: configured ? `DECK_CUA_DRIVER (${configured}) does not exist on the agent host` : "no cua-driver on PATH for the agent-host route; set DECK_CUA_DRIVER in the relay's .env" };
  }
  if (isSelf(p)) return { error: "DECK_CUA_DRIVER points at deck-cua itself; set it to the real cua-driver" };
  return { path: p };
}

function connect(p, ms = CONNECT_MS) {
  return new Promise((resolve, reject) => {
    const s = net.connect(p);
    const t = setTimeout(() => {
      s.destroy();
      reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
    }, ms);
    s.once("connect", () => {
      clearTimeout(t);
      resolve(s);
    });
    s.once("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

/** Messages from the relay: next() for the route answer, then on(fn) for the rest. */
function inbox(sock) {
  let handler = null;
  const queue = [];
  const feed = wire.lineReader(
    (m) => (handler ? handler(m) : queue.push(m)),
    () => sock.destroy()
  );
  sock.on("data", feed);
  return {
    next(ms) {
      return new Promise((resolve) => {
        if (queue.length) return resolve(queue.shift());
        const done = (m) => {
          clearTimeout(t);
          sock.removeListener("close", onClose);
          handler = null;
          resolve(m);
        };
        const onClose = () => done(null);
        const t = setTimeout(() => done(null), ms);
        sock.once("close", onClose);
        handler = done;
      });
    },
    on(fn) {
      handler = fn;
      while (queue.length) fn(queue.shift());
    },
  };
}

/**
 * Run one driver invocation. `o`: {argv, env, self, stdin: () => Readable, stdout/stderr: {write(buf)}, spawn,
 * signals: EventEmitter, settings?}. stdin is a function on purpose: on a host route the local driver inherits
 * fd 0 and this process must never open it. Resolves with the exit code.
 */
async function run(o) {
  const s = o.settings || settings(o.env);
  const say = (m) => o.stderr.write(`deck-cua: ${String(m).replace(/\s+/g, " ")}\n`);
  let sock;
  try {
    sock = await connect(s.sock);
  } catch (e) {
    say(`the Hermes Deck relay is not running on the agent host (${e.code || e.message}), so computer_use has no route. Tell the user.`);
    return EX.UNAVAILABLE;
  }
  sock.on("error", () => {});
  const msgs = inbox(sock);
  const env = o.env;
  wire.send(sock, { t: "hello", v: 1, argv: o.argv, sid: env.HERMES_SESSION_ID || "", skey: env.HERMES_SESSION_KEY || "", profile: wire.profileFromHome(env.HERMES_HOME || "") });
  const route = await msgs.next(ROUTE_MS);
  if (!route || route.t !== "route") {
    say("the Hermes Deck relay did not answer; computer_use has no route right now");
    sock.destroy();
    return EX.UNAVAILABLE;
  }
  if (!route.ok) {
    say(route.error || "no route for computer_use");
    sock.destroy();
    return Number.isInteger(route.code) ? route.code : EX.NO_ROUTE;
  }
  return route.device === "host" ? runHost(o, s, sock, msgs, say) : runDevice(o, sock, msgs, say);
}

function runHost(o, s, sock, msgs, say) {
  const drv = resolveDriver(s.driver, o.env, [o.self, __filename, path.join(__dirname, "deck-cua")]);
  if (drv.error) {
    say(drv.error);
    sock.destroy();
    return EX.NO_DRIVER;
  }
  const env = { ...o.env };
  delete env.DECK_CUA_SELF;
  const manifest = o.argv[0] === "manifest";
  return new Promise((resolve) => {
    let child = null;
    let done = false;
    let relayCode = null;
    const out = [];
    const forward = SIGNALS.map((sig) => [
      sig,
      () => {
        if (child) child.kill(sig);
      },
    ]);
    const finish = (code) => {
      if (done) return;
      done = true;
      for (const [sig, fn] of forward) o.signals.removeListener(sig, fn);
      sock.destroy();
      resolve(code);
    };
    const stopChild = () => {
      if (!child) return;
      child.kill("SIGTERM");
      const t = setTimeout(() => child.kill("SIGKILL"), 2000);
      if (t.unref) t.unref();
    };
    try {
      child = o.spawn(drv.path, o.argv, { stdio: manifest ? ["inherit", "pipe", "inherit"] : "inherit", env, windowsHide: true });
    } catch (e) {
      say(`cannot start ${drv.path}: ${e.message}`);
      return finish(EX.NO_DRIVER);
    }
    for (const [sig, fn] of forward) o.signals.on(sig, fn);
    if (manifest && child.stdout) child.stdout.on("data", (b) => out.push(b));
    msgs.on((m) => {
      if (m.t === "err" && typeof m.b64 === "string") o.stderr.write(Buffer.from(m.b64, "base64"));
      else if (m.t === "exit") {
        relayCode = Number.isInteger(m.code) ? m.code : EX.UNAVAILABLE;
        stopChild();
      }
    });
    sock.on("close", () => {
      if (done || relayCode !== null) return;
      relayCode = EX.UNAVAILABLE; // no relay, no route: never keep driving on a stale one
      say("lost the Hermes Deck relay; stopping the local driver");
      stopChild();
    });
    child.on("error", (e) => {
      say(`cannot start ${drv.path}: ${e.message}`);
      finish(EX.NO_DRIVER);
    });
    child.on("close", (code, signal) => {
      if (manifest) {
        const text = Buffer.concat(out).toString("utf8");
        o.stdout.write(code === 0 ? rewriteManifest(text, o.self) : text);
      }
      finish(relayCode !== null ? relayCode : code !== null ? code : 128 + signo(signal));
    });
  });
}

function runDevice(o, sock, msgs, say) {
  const verb = o.argv[0] || "";
  const manifest = verb === "manifest";
  return new Promise((resolve) => {
    let done = false;
    let exited = false;
    const out = [];
    const stdin = o.stdin();
    const handlers = [];
    const finish = (code) => {
      if (done) return;
      done = true;
      for (const [sig, fn] of handlers) o.signals.removeListener(sig, fn);
      stdin.removeAllListeners("data");
      stdin.pause();
      sock.end();
      resolve(code);
    };
    msgs.on((m) => {
      if (m.t === "data" && typeof m.b64 === "string") {
        const b = Buffer.from(m.b64, "base64");
        if (manifest) out.push(b);
        else o.stdout.write(b);
      } else if (m.t === "err" && typeof m.b64 === "string") o.stderr.write(Buffer.from(m.b64, "base64"));
      else if (m.t === "exit") {
        exited = true;
        const code = Number.isInteger(m.code) ? m.code : 1;
        if (manifest) {
          const text = Buffer.concat(out).toString("utf8");
          o.stdout.write(code === 0 ? rewriteManifest(text, o.self) : text);
        }
        finish(code);
      }
    });
    sock.on("close", () => {
      if (exited) return;
      say("lost the connection to the Hermes Deck relay; the outcome of the last action is unknown");
      finish(EX.UNAVAILABLE);
    });
    stdin.on("data", (b) => wire.send(sock, { t: "data", b64: b.toString("base64") }));
    stdin.on("end", () => {
      if (verb === "mcp" && !done) wire.send(sock, { t: "close" }); // Hermes ended its MCP session
    });
    stdin.on("error", () => {});
    for (const sig of SIGNALS) {
      const fn = () => {
        wire.send(sock, { t: "close" });
        finish(128 + signo(sig));
      };
      handlers.push([sig, fn]);
      o.signals.on(sig, fn);
    }
  });
}

/** Blocking write of a whole buffer: stdio is never wrapped in a stream, so fd 0-2 keep their blocking mode. */
function writeAllSync(fd, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      if (e.code !== "EAGAIN") throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

if (require.main === module) {
  const sink = (fd) => ({
    write(b) {
      try {
        writeAllSync(fd, b);
      } catch {
        process.exit(EX.UNAVAILABLE); // Hermes went away
      }
      return true;
    },
  });
  run({
    argv: process.argv.slice(2),
    env: process.env,
    self: process.env.DECK_CUA_SELF || path.resolve(process.argv[1]),
    stdin: () => process.stdin,
    stdout: sink(1),
    stderr: sink(2),
    spawn,
    signals: process,
  }).then(
    (code) => process.exit(code),
    (e) => {
      try {
        writeAllSync(2, `deck-cua: ${e.message}\n`);
      } catch {
        /* nowhere to report */
      }
      process.exit(EX.UNAVAILABLE);
    }
  );
}

module.exports = { run, settings, rewriteManifest, resolveDriver, EX };
