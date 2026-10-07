"use strict";
// Pieces of the bot-screen driver protocol (docs/bot-screen-protocol.md) that the relay's driver module and
// the deck-cua wrapper must agree on exactly: framing, the verb allowlist, the routing key, profile names.
const fs = require("fs");
const os = require("os");
const path = require("path");

/** Driver verbs that may travel to a device. The Deck answers any other argv[0] with close code 126. */
const DEVICE_VERBS = new Set(["mcp", "manifest", "--help", "call", "status", "doctor"]);

/** Profile names as Hermes and the relay accept them (no path separators, no leading dot). */
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// One NDJSON line. Driver stdout arrives in small chunks; a whole screenshot stays well under this.
const MAX_LINE = 64 * 1024 * 1024;

/** Local driver socket: $DECK_HOME/driver.sock. Windows has no Unix sockets in Node, so tests there get a named pipe. */
function defaultSockPath(deckHome) {
  return process.platform === "win32" ? "\\\\.\\pipe\\hermes-deck-driver" : path.join(deckHome, "driver.sock");
}

const expandHome = (p) => String(p || "").replace(/^~(?=$|[\\/])/, os.homedir());

/**
 * Profile of a HERMES_HOME path: <root>/profiles/<name> is <name>, anything else is "default".
 * The deck-events plugin applies the same rule to the same variable, so both sides compute one routing key.
 */
function profileFromHome(home) {
  if (!home) return "default";
  const p = path.resolve(expandHome(home));
  const name = path.basename(p);
  return path.basename(path.dirname(p)) === "profiles" && PROFILE_RE.test(name) ? name : "default";
}

/**
 * Routing key of a Hermes session. Hermes copies its session ContextVars into every cua-driver child's env, but
 * only HERMES_SESSION_KEY is bound on every gateway turn: HERMES_SESSION_ID stays empty on later turns of a cached
 * agent. So the gateway session key wins, then the session id (CLI runs), then the profile alone. The profile
 * scopes the first two because two bots talking to one user share a Telegram chat id.
 */
function routeKey({ profile, skey, sid } = {}) {
  const p = `p:${profile || "default"}`;
  if (skey) return `${p}/k:${skey}`;
  if (sid) return `${p}/s:${sid}`;
  return p;
}

/**
 * argv as it may run on a device. `call get_window_state` carries Hermes' screenshot_out_file, a temp path on the
 * agent host that does not exist on the device; without it the driver returns the image inline instead.
 */
function deviceArgv(argv) {
  if (argv[0] !== "call" || typeof argv[2] !== "string") return argv.slice();
  let args;
  try {
    args = JSON.parse(argv[2]);
  } catch {
    return argv.slice();
  }
  if (!args || typeof args !== "object" || Array.isArray(args) || !("screenshot_out_file" in args)) return argv.slice();
  delete args.screenshot_out_file;
  return [argv[0], argv[1], JSON.stringify(args), ...argv.slice(3)];
}

/**
 * NDJSON splitter for socket data. Returns feed(chunk); onLine gets each parsed object. A malformed or oversized
 * line calls onError once and every later chunk is ignored (the peer is broken; the caller closes it).
 */
function lineReader(onLine, onError = () => {}, maxLine = MAX_LINE) {
  let parts = [];
  let size = 0;
  let dead = false;
  const fail = (why) => {
    dead = true;
    parts = [];
    onError(new Error(why));
  };
  return (chunk) => {
    if (dead) return false;
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl < 0) break;
      parts.push(chunk.subarray(start, nl));
      const line = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      parts = [];
      size = 0;
      start = nl + 1;
      if (!line.length) continue;
      let msg;
      try {
        msg = JSON.parse(line.toString("utf8"));
      } catch {
        fail("bad JSON line");
        return false;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        fail("line is not an object");
        return false;
      }
      onLine(msg);
      if (dead) return false;
    }
    if (start < chunk.length) {
      size += chunk.length - start;
      if (size > maxLine) {
        fail("line too long");
        return false;
      }
      parts.push(chunk.subarray(start));
    }
    return true;
  };
}

/** Write one NDJSON message; false when the socket is already gone. */
function send(sock, msg) {
  if (!sock || sock.destroyed || !sock.writable) return false;
  sock.write(JSON.stringify(msg) + "\n");
  return true;
}

/** KEY=VALUE pairs of an env file (same rules as util.loadEnvFile) without touching process.env. */
function parseEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[line.slice(0, eq).trim()] = val;
  }
  return out;
}

module.exports = { DEVICE_VERBS, PROFILE_RE, MAX_LINE, defaultSockPath, expandHome, profileFromHome, routeKey, deviceArgv, lineReader, send, parseEnvFile };
