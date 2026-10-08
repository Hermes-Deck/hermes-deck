"use strict";
// What a device channel may run (docs/bot-screen-protocol.md v2: OPEN) and how the Deck runs it. Pure
// functions, unit-tested in app/test/cua-protocol.test.js. Nothing here touches Electron, the network or a
// process. The frames themselves: wire.js.

const VERBS = new Set(["mcp", "manifest", "--help", "call", "status", "doctor"]);
// Verbs that talk to the driver daemon. The Deck points them at its own private bounded daemon.
const SOCKET_VERBS = new Set(["mcp", "call", "status"]);
// Verbs that can act on the desktop: they need an active grant ("Hand to agent") for the asking agent.
const GRANT_VERBS = new Set(["mcp", "call"]);

// Flags the Deck sets itself and argv from the relay may never carry: they would point the driver at
// another runtime or widen what it may do. Matched with or without "=value".
const FORBIDDEN_FLAGS = new Set([
  "--socket",
  "--pid-file",
  "--permission-mode",
  "--capability-manifest",
  "--approve-capability-manifest",
  "--session-policy",
  "--approve-session-policy",
  "--grant",
  "--dangerously-bypass-approvals",
  "--no-permissions-gate",
  "--embedded",
  "--host-bundle-id",
  "--direct",
  "--no-overlay", // the agent cursor stays on: the user must see who acts
  "--experimental-history",
  "--claude-code-computer-use-compat",
  "--screenshot-out-file", // `call` would write a file anywhere on this computer
]);
// Defence in depth for flags newer drivers may add: anything that smells of transport, authorization or files.
const SUSPECT_FLAG = /socket|pipe|permission|manifest|bypass|grant|polic|embed|direct|endpoint|http|unrestricted|overlay|history|compat|file|dir|path/i;
// Verbs that only describe the driver. The Deck runs them itself and scrubs this computer's home folder
// (the user's name) from what goes back to the agent host.
const INFO_VERBS = new Set(["manifest", "--help", "status", "doctor"]);

const MAX_ARGS = 64;
const MAX_ARG_LEN = 8192;

/**
 * Checks an "open" frame's argv. Returns {ok: true, verb} or {ok: false, code: 126, error} (the contract's
 * answer to a verb outside the allowlist; the same answer covers a forbidden flag).
 */
function checkArgv(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.length > MAX_ARGS) return { ok: false, code: 126, error: "verb not allowed" };
  if (argv.some((a) => typeof a !== "string" || a.length > MAX_ARG_LEN || a.includes("\0"))) return { ok: false, code: 126, error: "bad argument" };
  const verb = argv[0];
  if (!VERBS.has(verb)) return { ok: false, code: 126, error: "verb not allowed" };
  for (const a of argv.slice(1)) {
    if (!a.startsWith("-")) continue;
    const name = a.split("=")[0].toLowerCase();
    if (FORBIDDEN_FLAGS.has(name) || (name.startsWith("--") && SUSPECT_FLAG.test(name))) return { ok: false, code: 126, error: "flag not allowed" };
  }
  return { ok: true, verb };
}

/** The argv the Deck actually runs: the relay's argv with the private daemon socket for verbs that use one. */
function spawnArgs(argv, { socket }) {
  const [verb, ...rest] = argv;
  if (SOCKET_VERBS.has(verb) && socket) return [verb, "--socket", socket, ...rest];
  return [verb, ...rest];
}

/** The daemon's command line: bounded mode with the Deck's reviewed manifest (docs: Set permissions). */
function daemonArgs({ socket, manifest }) {
  return ["serve", "--socket", socket, "--permission-mode", "bounded", "--capability-manifest", manifest, "--approve-capability-manifest"];
}

/**
 * Environment for every driver process the Deck starts. `cua-driver mcp` on Windows and Linux reads the
 * mode from these variables, so a process that ends up owning its own runtime is still bounded by the
 * current manifest. Inherited CUA_DRIVER_* settings are dropped (they could switch on the HTTP listener or
 * another mode), except the two policy files, which can only narrow.
 */
const KEEP_CUA_ENV = new Set(["CUA_DRIVER_POLICY_FILE", "CUA_DRIVER_MANAGED_POLICY_FILE"]);
function driverEnv(base, { manifest }) {
  const env = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (/^CUA_DRIVER_/i.test(k) && !KEEP_CUA_ENV.has(k.toUpperCase())) continue;
    if (/^ELECTRON_/i.test(k) || /^NODE_OPTIONS$/i.test(k)) continue;
    env[k] = v;
  }
  env.CUA_DRIVER_PERMISSION_MODE = "bounded";
  env.CUA_DRIVER_CAPABILITY_MANIFEST_FILE = manifest;
  env.CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED = "1";
  return env;
}

const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
/** A process exit as one integer for the "close" frame. */
function exitCode(code, signal) {
  if (Number.isInteger(code)) return code;
  if (signal && SIGNALS[signal]) return 128 + SIGNALS[signal];
  return 1;
}

/**
 * Output of an info verb as it may leave this computer: the home folder (any spelling: raw, JSON-escaped,
 * forward slashes) becomes "~", and `manifest`'s own paths become plain "cua-driver" (the agent host's
 * wrapper points mcp_invocation at itself anyway).
 */
function scrubInfo(verb, text, home) {
  let s = String(text || "");
  if (verb === "manifest") {
    try {
      const m = JSON.parse(s);
      if (m && typeof m === "object") {
        if (typeof m.binary_path === "string") m.binary_path = "cua-driver";
        if (m.mcp_invocation && typeof m.mcp_invocation === "object") m.mcp_invocation.command = "cua-driver";
        s = JSON.stringify(m) + "\n";
      }
    } catch {
      /* not JSON: scrubbed as text below */
    }
  }
  if (home && home.length > 2) {
    const forms = new Set([home, home.replace(/\\/g, "\\\\"), home.replace(/\\/g, "/")]);
    for (const f of forms) s = s.replace(new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "~");
  }
  return s;
}

/** Splits a buffer into pieces of at most `max` bytes (stdout frames stay small on the socket). */
function chunks(buf, max = 256 * 1024) {
  const out = [];
  for (let i = 0; i < buf.length; i += max) out.push(buf.subarray(i, i + max));
  return out;
}

module.exports = {
  VERBS,
  SOCKET_VERBS,
  GRANT_VERBS,
  INFO_VERBS,
  FORBIDDEN_FLAGS,
  scrubInfo,
  checkArgv,
  spawnArgs,
  daemonArgs,
  driverEnv,
  exitCode,
  chunks,
};
