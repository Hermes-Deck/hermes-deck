"use strict";
// Relay updater (relay/bin/deck-relay-update): check for a newer Hermes Deck release, install it next to the running
// one, switch to it atomically, and switch back by itself when the new relay does not come up. docs/updating.md.
//
// Layout of an install root (made by `init`, used by `apply`):
//   <root>/releases/<version>/   one extracted source release each (its relay/ is what runs); the last 3 are kept
//   <root>/current -> releases/<version>   the service runs <root>/current/relay
//   <root>/shared/                .env, agents.json, devices.json and data/ — retained across updates; each release
//                                 links its relay state files and directories into it
// A plain checkout (relay/ in a git clone) keeps working without any of this; `init` converts one, dry-run first, and
// `adopt` (or `apply --adopt`, what the app starts) converts one and points the relay's service at it in one go.
//
// Every effect goes through `deps` (fetch, run, fs, sleep, now, log) so test/update.test.js drives it all with fakes.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { withQueue } = require("../src/queue-file");
const { hermesPython } = require("../src/hermes-python");

const API = "https://api.github.com";
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const TAG_RE = /^v?(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;
const KEEP = 3;
const HEALTH_TIMEOUT_MS = 30_000;
const EXIT = { ok: 0, failed: 1, usage: 2, updateAvailable: 10 };
const SHARED = [".env", "agents.json", "devices.json", "data", "logs"]; // relative to relay/, kept in <root>/shared/ (logs: macOS launchd)
// what a release copy never takes from a checkout (init): VCS data, installed modules, the relay's own state
const SKIP = new Set([".git", "node_modules"]);
const DROP_IN = "hermes-deck-install-root.conf"; // adopt's systemd drop-in, under ~/.config/systemd/user/<unit>.service.d/

// ------------------------------------------------------------------ versions, repo, release lookup
/** [major, minor, patch] of "1.2.3" / "v1.2.3", else null (pre-releases are not offered). */
function parse(v) {
  const m = TAG_RE.exec(String(v || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 / 0 / 1; null when either side is not a plain version. */
function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

const plain = (v) => String(v).trim().replace(/^v/, "");

/** owner/name from DECK_UPDATE_REPO, else relay/package.json "repository" (string or {url}). */
function repoOf(env, pkg) {
  const fromEnv = String(env.DECK_UPDATE_REPO || "").trim();
  if (fromEnv) {
    if (!REPO_RE.test(fromEnv)) throw new Error(`DECK_UPDATE_REPO must be owner/name, not "${fromEnv}"`);
    return fromEnv;
  }
  const r = pkg && pkg.repository;
  const raw = typeof r === "string" ? r : r && typeof r.url === "string" ? r.url : "";
  const m = /^(?:github:)?([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(raw) || /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(raw);
  if (!m) throw new Error('no repository: set DECK_UPDATE_REPO=owner/name or "repository" in relay/package.json');
  return m[1];
}

/** The source archive the release workflow publishes for a version (and lists in SHA256SUMS.txt). */
const sourceName = (version) => `hermes-deck-${plain(version)}-source.tar.gz`;

/** The sha256 next to `name` in a SHA256SUMS.txt body, or "" (same format as app/main/update-check.js sumFor). */
function sumFor(text, name) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m && m[2] === name) return m[1];
  }
  return "";
}

/** GET a GitHub API path; GH_TOKEN / GITHUB_TOKEN only raise the rate limit (public repos need none). */
async function gh(deps, url, accept = "application/vnd.github+json") {
  const headers = { accept, "user-agent": "deck-relay-update", "x-github-api-version": "2022-11-28" };
  const token = deps.env.GH_TOKEN || deps.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await deps.fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url.replace(API, "")}`);
  return res;
}

/** The latest release, or the one tagged `version`: {tag, version, assets}. */
async function release(deps, repo, version = null) {
  const url = version ? `${API}/repos/${repo}/releases/tags/v${plain(version)}` : `${API}/repos/${repo}/releases/latest`;
  const rel = await (await gh(deps, url)).json();
  const tag = String((rel && rel.tag_name) || "");
  if (!parse(tag)) throw new Error(`release tag "${tag}" is not a version`);
  return { tag, version: plain(tag), assets: Array.isArray(rel.assets) ? rel.assets : [] };
}

/** Download one release asset by name (API asset URL: works for private repos with a token too). */
async function asset(deps, repo, rel, name) {
  const a = rel.assets.find((x) => x && x.name === name);
  if (!a) throw new Error(`release ${rel.tag} has no ${name}`);
  const res = await gh(deps, `${API}/repos/${repo}/releases/assets/${a.id}`, "application/octet-stream");
  return Buffer.from(await res.arrayBuffer());
}

// ------------------------------------------------------------------ check
/** KEY=VALUE lines of a .env file (same rules as src/util.js loadEnvFile), without touching process.env. */
function parseEnv(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (!line || line.startsWith("#") || eq < 1) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[line.slice(0, eq).trim()] = val;
  }
  return out;
}

const readText = (deps, file) => {
  try {
    return deps.fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
const readJsonFile = (deps, file) => {
  try {
    return JSON.parse(deps.fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const exists = (deps, p) => {
  try {
    deps.fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Where the relay runs: {root, relay, managed}. A managed install root has <root>/current -> releases/<v>; the
 * relay runs from <root>/current/relay. Otherwise `relay` is a plain checkout's relay/ (this file's parent).
 */
function locate(deps, { root = null, here = path.join(__dirname, "..") } = {}) {
  // here = .../relay: <root>/releases/<v>/relay (Node resolves the symlink) or <root>/current/relay
  const release = path.dirname(here);
  const inferred = path.basename(path.dirname(release)) === "releases" ? path.dirname(path.dirname(release)) : path.basename(release) === "current" ? path.dirname(release) : null;
  const guess = root || deps.env.DECK_RELAY_ROOT || inferred;
  if (guess && exists(deps, path.join(guess, "current"))) return { root: path.resolve(guess), relay: path.join(path.resolve(guess), "current", "relay"), managed: true };
  if (root) throw new Error(`${root} is not an install root (no ${path.join(root, "current")}); see \`deck-relay-update init\``);
  return { root: null, relay: path.resolve(here), managed: false };
}

/** The relay's own settings: its .env (DECK_RELAY_ENV, else relay/.env) over the process environment. */
function relayEnv(deps, relayDir) {
  const file = deps.env.DECK_RELAY_ENV || path.join(relayDir, ".env");
  return { ...parseEnv(readText(deps, file)), ...pick(deps.env, ["DECK_DATA_DIR", "DECK_RELAY_HOST", "DECK_RELAY_PORT", "DECK_UPDATE_REPO", "DECK_RELAY_SERVICE", "DECK_RELAY_AUTO_UPDATE", "DECK_HERMES_PYTHON", "HERMES_ROOT"]) };
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== "").map((k) => [k, o[k]]));

/**
 * GitHub access for a private update repository: GH_TOKEN / GITHUB_TOKEN from the process, else from the relay's own
 * .env (0600). A job started by the relay never carries tokens in its environment or plist, so it reads them here.
 */
function withToken(deps, env) {
  if (deps.env.GH_TOKEN || deps.env.GITHUB_TOKEN) return deps;
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  return token ? { ...deps, env: { ...deps.env, GH_TOKEN: token } } : deps;
}

/** http://<host>:<port>/health of the relay configured in `env` (a wildcard bind is asked on loopback). */
function healthUrl(env) {
  let host = env.DECK_RELAY_HOST || "127.0.0.1";
  if (host === "0.0.0.0" || host === "::") host = "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  return `http://${host}:${Number(env.DECK_RELAY_PORT || 9330)}/health`;
}

/**
 * --check: the newest release against the running relay. {status: "newer"|"same"|"older", running, latest, tag, repo}
 * Writes <data dir>/update-check.json when the data dir exists, so /health can expose updateAvailable.
 */
async function check(deps, { relayDir, write = true }) {
  const pkg = readJsonFile(deps, path.join(relayDir, "package.json")) || {};
  const running = String(pkg.version || "");
  if (!parse(running)) throw new Error(`cannot read the running version from ${path.join(relayDir, "package.json")}`);
  const env = relayEnv(deps, relayDir);
  deps = withToken(deps, env);
  const repo = repoOf({ ...deps.env, ...env }, pkg);
  const rel = await release(deps, repo);
  const c = compare(rel.version, running);
  const out = { status: c > 0 ? "newer" : c < 0 ? "older" : "same", running, latest: rel.version, tag: rel.tag, repo };
  const dataDir = env.DECK_DATA_DIR || path.join(relayDir, "data");
  if (write && exists(deps, dataDir)) {
    const file = path.join(dataDir, "update-check.json");
    deps.fs.writeFileSync(`${file}.tmp`, JSON.stringify({ updateAvailable: out.status === "newer", latest: out.latest, running, checkedAt: new Date(deps.now()).toISOString() }));
    deps.fs.renameSync(`${file}.tmp`, file);
  }
  return out;
}

// ------------------------------------------------------------------ layout: init
/** A step: printed always, run only when not a dry run. */
function stepper(deps, dry) {
  return async (text, fn) => {
    deps.log(`${dry ? "would " : ""}${text}`);
    if (!dry && fn) return fn();
    return undefined;
  };
}

/** Run a command; a non-zero exit throws with the tail of its output. */
async function must(deps, cmd, args, opts = {}) {
  const r = await deps.run(cmd, args, opts);
  if (!r || r.code !== 0) throw Object.assign(new Error(`${cmd} ${args.join(" ")} failed (exit ${r ? r.code : "?"})`), { detail: String((r && r.out) || "").slice(-1200) });
  return r;
}

/** Preserve a legacy release's desktop keys before linking the next release. */
function migrateDevices(deps, root, relayDir) {
  const target = path.join(root, "shared", "devices.json");
  if (exists(deps, target)) return;
  const source = path.join(relayDir, "devices.json");
  let regular = false;
  try { regular = deps.fs.lstatSync(source).isFile(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (regular) deps.fs.copyFileSync(source, target);
  // devtokens saves by rename, so adding a key cannot populate a dangling link's target.
  else deps.fs.writeFileSync(target, JSON.stringify({ v: 1, devices: {} }), { mode: 0o600 });
  deps.fs.chmodSync(target, 0o600);
}

/**
 * Copy a relay state file or directory, overwriting. Not state: sockets and FIFOs (a live agent browser's), *.tmp files
 * (an atomic write in progress, renamed a moment later) and entries gone by the time they are reached.
 */
function copyState(deps, from, to) {
  const keep = (p) => {
    if (p !== from && p.endsWith(".tmp")) return false;
    try {
      const st = deps.fs.lstatSync(p);
      return !st.isSocket() && !st.isFIFO();
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  };
  deps.fs.cpSync(from, to, { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true, filter: keep });
}

/** Release state files and directories -> <root>/shared/<same> (those that exist there). */
function linkShared(deps, root, relayDir) {
  for (const name of SHARED) {
    const target = path.join(root, "shared", name);
    if (!exists(deps, target)) continue;
    const link = path.join(relayDir, name);
    if (exists(deps, link)) throw new Error(`${link} is part of the release; it must come from ${target}`);
    deps.fs.symlinkSync(target, link);
  }
}

/**
 * init <root>: make an install root from the checkout this updater runs in (`checkout`, the repo root). Copies the
 * checkout (without .git and node_modules) to <root>/releases/<version>/, copies relay/.env, agents.json, devices.json, data/ and
 * logs/ to <root>/shared/ (the checkout keeps its own: it goes on working until the service is pointed elsewhere),
 * links them into the release, runs npm ci --omit=dev and the self-check, and points <root>/current at it.
 * Never touches a service: it prints the change to make (adopt makes it).
 */
async function init(deps, { root, checkout, dry = false, next = true }) {
  const step = stepper(deps, dry);
  root = path.resolve(root);
  checkout = path.resolve(checkout);
  const src = path.join(checkout, "relay");
  const pkg = readJsonFile(deps, path.join(src, "package.json"));
  if (!pkg || !parse(pkg.version)) throw new Error(`${src} is not a relay checkout (no relay/package.json version)`);
  if (exists(deps, path.join(root, "current"))) throw new Error(`${root} is already an install root (${path.join(root, "current")} exists)`);
  if (root === checkout || root.startsWith(checkout + path.sep)) throw new Error("the install root must be outside the checkout");
  const version = plain(pkg.version);
  const rel = path.join(root, "releases", version);
  if (exists(deps, rel)) throw new Error(`${rel} already exists`);
  deps.log(`init ${root} from ${checkout} (relay ${version})${dry ? " — dry run, nothing is changed" : ""}`);
  await step(`create ${path.join(root, "shared")}`, () => deps.fs.mkdirSync(path.join(root, "shared"), { recursive: true, mode: 0o700 }));
  await step("preserve desktop device keys in shared/devices.json", () => migrateDevices(deps, root, src));
  for (const name of SHARED) {
    if (name === "devices.json") continue;
    const from = path.join(src, name);
    if (!exists(deps, from)) {
      if (name === "data" || name === "logs") await step(`create ${path.join(root, "shared", name)}`, () => deps.fs.mkdirSync(path.join(root, "shared", name), { recursive: true, mode: 0o700 }));
      continue;
    }
    await step(`copy ${from} -> ${path.join(root, "shared", name)}`, () => copyState(deps, from, path.join(root, "shared", name)));
  }
  const skip = (p) => {
    const relp = path.relative(checkout, p);
    const parts = relp.split(path.sep);
    if (parts.some((x) => SKIP.has(x))) return false;
    return !(parts[0] === "relay" && parts.length === 2 && SHARED.includes(parts[1]));
  };
  await step(`copy ${checkout} -> ${rel} (without .git, node_modules and relay/${SHARED.join(", relay/")})`, () => {
    deps.fs.mkdirSync(path.join(root, "releases"), { recursive: true });
    deps.fs.cpSync(checkout, rel, { recursive: true, filter: skip, verbatimSymlinks: true });
  });
  await step(`link relay/${SHARED.join(", relay/")} of ${rel} to ${path.join(root, "shared")}`, () => linkShared(deps, root, path.join(rel, "relay")));
  await step(`npm ci --omit=dev in ${path.join(rel, "relay")}`, () => must(deps, "npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: path.join(rel, "relay") }));
  await step(`self-check ${path.join(rel, "relay")}`, () => must(deps, deps.node, ["src/index.js", "--self-check"], { cwd: path.join(rel, "relay") }));
  await step(`point ${path.join(root, "current")} at releases/${version}`, () => deps.fs.symlinkSync(path.join("releases", version), path.join(root, "current")));
  if (!next) return { root, version };
  deps.log(`Next: run the relay from ${path.join(root, "current", "relay")} (systemd: WorkingDirectory=${path.join(root, "current", "relay")}; macOS: bash ${path.join(root, "current", "relay", "install", "macos.sh")}), restart it once, then update with: deck-relay-update apply --root ${root}`);
  return { root, version };
}

// ------------------------------------------------------------------ adopt: checkout -> install root, service included
/** Where adopt puts the install root: DECK_RELAY_ROOT (process, else the relay's .env), else ~/.local/share/hermes-deck-relay. */
function defaultRoot(deps, env) {
  const named = deps.env.DECK_RELAY_ROOT || env.DECK_RELAY_ROOT;
  return path.resolve(named || path.join(deps.home, ".local", "share", "hermes-deck-relay"));
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The real path of `p`, resolving its longest existing ancestor (a log file named in a plist may not exist yet). */
function realish(deps, p) {
  let cur = path.resolve(p);
  let tail = "";
  for (;;) {
    try { return deps.fs.realpathSync(cur) + tail; } catch { /* go up */ }
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    tail = path.sep + path.basename(cur) + tail;
    cur = up;
  }
}

/**
 * Paths a service file names, mapped from the checkout's relay/ to `to`: swap(p) is the new path, or null when p is not
 * under relayDir. Compared by real path, so a service that names the checkout through a symlink (macOS /tmp, a linked
 * ~/code) still matches. installRoot(p): the install root when p is already <root>/current/relay (adopted before).
 */
function relayPaths(deps, relayDir, to) {
  const real = realish(deps, relayDir);
  const under = (p, d) => (p === d ? "" : p.startsWith(d + path.sep) ? p.slice(d.length) : null);
  return {
    swap: (p) => {
      if (typeof p !== "string" || !path.isAbsolute(p)) return null;
      for (const d of [path.resolve(relayDir), real]) {
        const rest = under(path.resolve(p), d);
        if (rest !== null) return to + rest;
      }
      const rest = under(realish(deps, p), real);
      return rest === null ? null : to + rest;
    },
    installRoot: (p) => {
      if (typeof p !== "string" || !path.isAbsolute(p)) return null;
      const m = /^(.*)\/current\/relay\/?$/.exec(path.resolve(p));
      return m && exists(deps, path.join(m[1], "current")) ? m[1] : null;
    },
  };
}
const xmlText = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Poll /health until it stops answering: the old relay has written its last checkpoint and closed its server. */
async function waitDown(deps, url, timeoutMs) {
  const end = deps.now() + timeoutMs;
  while (deps.now() < end) {
    try {
      await deps.fetch(url, typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(2000) } : {});
    } catch {
      return true;
    }
    await deps.sleep(500);
  }
  return false;
}

/** launchctl bootstrap right after a bootout can fail with "Input/output error" for a few seconds (install/macos.sh). */
async function bootstrap(deps, plist) {
  let r = null;
  for (let i = 0; i < 5; i++) {
    r = await deps.run("launchctl", ["bootstrap", `gui/${deps.uid}`, plist]);
    if (r && r.code === 0) return r;
    await deps.sleep(3000);
  }
  throw Object.assign(new Error(`launchctl bootstrap gui/${deps.uid} ${plist} failed (exit ${r ? r.code : "?"})`), { detail: String((r && r.out) || "").slice(-1200) });
}

/**
 * The service that runs the checkout's relay, and how to point it at `to` (<root>/current/relay):
 *   Linux  the systemd --user unit DECK_RELAY_SERVICE (default hermes-deck-relay); a drop-in sets WorkingDirectory,
 *          and ExecStart when that names the checkout. The unit file itself is not edited; removing the drop-in undoes it.
 *   macOS  the launchd agent ~/Library/LaunchAgents/<label>.plist (label DECK_RELAY_SERVICE, default com.hermes-deck.relay);
 *          the checkout's relay path is replaced in place, the old file is kept in memory and in <root>/.adopt/.
 * Reads only. Throws when there is no such service or it does not run this checkout: then nothing can be switched safely.
 */
async function serviceFor(deps, env, relayDir, to) {
  const paths = relayPaths(deps, relayDir, to);
  const adopted = (what, p) => {
    const root = paths.installRoot(p);
    if (root) throw new Error(`the ${what} already runs the relay from the install root ${root}; update it with ${path.join(root, "current", "relay", "bin", "deck-relay-update")} apply`);
  };
  if (deps.platform === "linux") {
    const unit = env.DECK_RELAY_SERVICE || "hermes-deck-relay";
    const r = await deps.run("systemctl", ["--user", "show", unit, "-p", "LoadState", "-p", "WorkingDirectory", "-p", "ExecStart"]);
    if (!r || r.code !== 0) throw Object.assign(new Error(`cannot read the systemd --user unit ${unit}`), { detail: String((r && r.out) || "").slice(-1200) });
    const props = {};
    for (const line of String(r.out || "").split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (props.LoadState !== "loaded") throw new Error(`no systemd --user unit ${unit} runs the relay (set DECK_RELAY_SERVICE to its name)`);
    const wd = String(props.WorkingDirectory || "").replace(/^[-!+]+/, "");
    const argv = (/argv\[\]=([^;]*)/.exec(props.ExecStart || "") || [])[1];
    const words = argv ? argv.trim().split(/\s+/) : [];
    const execNames = words.some((w) => paths.swap(w) !== null);
    if (paths.swap(wd) === null && !execNames) adopted(`systemd --user unit ${unit}`, wd);
    if (paths.swap(wd) === null && !execNames) throw new Error(`the systemd --user unit ${unit} does not run ${relayDir}; point it at ${to} yourself (docs/updating.md)`);
    const dir = path.join(deps.home, ".config", "systemd", "user", `${unit}.service.d`);
    const file = path.join(dir, DROP_IN);
    const swap = (w) => paths.swap(w) ?? w;
    const text = ["# Written by deck-relay-update adopt: run the relay from its install root (docs/updating.md).", "[Service]", `WorkingDirectory=${to}`,
      ...(execNames ? ["ExecStart=", `ExecStart=${words.map(swap).join(" ")}`] : []), ""].join("\n");
    return {
      name: `systemd --user unit ${unit}`,
      change: `drop-in ${file}: WorkingDirectory=${to}${execNames ? " and ExecStart" : ""}`,
      stop: () => must(deps, "systemctl", ["--user", "stop", unit]),
      point: () => {
        deps.fs.mkdirSync(dir, { recursive: true });
        deps.fs.writeFileSync(file, text);
      },
      start: async () => {
        await must(deps, "systemctl", ["--user", "daemon-reload"]);
        await must(deps, "systemctl", ["--user", "start", unit]);
      },
      restore: async () => {
        deps.fs.rmSync(file, { force: true });
        try { deps.fs.rmdirSync(dir); } catch { /* other drop-ins stay */ }
        await must(deps, "systemctl", ["--user", "daemon-reload"]);
        await must(deps, "systemctl", ["--user", "restart", unit]);
      },
    };
  }
  if (deps.platform === "darwin") {
    const label = env.DECK_RELAY_SERVICE || "com.hermes-deck.relay";
    const file = path.join(deps.home, "Library", "LaunchAgents", `${label}.plist`);
    const before = readText(deps, file);
    if (before === null) throw new Error(`no launchd agent ${file} runs the relay (set DECK_RELAY_SERVICE to its label)`);
    const strings = /<string>([^<]*)<\/string>/g;
    let names = false;
    const after = before.replace(strings, (all, value) => {
      const swapped = paths.swap(xmlText(value));
      if (swapped === null) return all;
      names = true;
      return `<string>${xml(swapped)}</string>`;
    });
    if (!names) {
      const wd = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(before);
      if (wd) adopted(`launchd agent ${label}`, xmlText(wd[1]));
      throw new Error(`the launchd agent ${file} does not run ${relayDir}; point it at ${to} yourself (docs/updating.md)`);
    }
    const domain = `gui/${deps.uid}`;
    const envDict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(before);
    const vars = {};
    for (const m of (envDict ? envDict[1] : "").matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) vars[xmlText(m[1])] = xmlText(m[2]);
    return {
      name: `launchd agent ${label}`,
      env: vars,
      change: `${file}: ${relayDir} -> ${to}`,
      before,
      stop: async () => {
        await deps.run("launchctl", ["bootout", `${domain}/${label}`]);
        // bootout returns while the relay still shuts down (it writes its state on SIGTERM); wait until it has exited
        for (let i = 0; i < 60; i++) {
          const r = await deps.run("launchctl", ["print", `${domain}/${label}`]);
          if (!r || r.code !== 0 || !/\bpid = \d+/.test(String(r.out || ""))) return;
          await deps.sleep(500);
        }
        throw new Error(`the launchd agent ${label} did not stop`);
      },
      point: () => deps.fs.writeFileSync(file, after),
      start: () => bootstrap(deps, file),
      restore: async () => {
        deps.fs.writeFileSync(file, before);
        await deps.run("launchctl", ["bootout", `${domain}/${label}`]);
        await bootstrap(deps, file);
      },
    };
  }
  throw new Error(`adopt switches systemd (Linux) and launchd (macOS) services, not ${deps.platform}; use init and switch the service yourself`);
}

/**
 * adopt: turn the checkout the relay runs from into an install root and move its service there, so `apply` can work.
 *   1 find the service that runs <checkout>/relay (serviceFor); refuse before changing anything when there is none
 *   2 init <root> from the checkout (copies; the checkout itself is never changed)
 *   3 stop the service, copy the relay's state again (it changed while it ran), point the service at <root>/current/relay
 *   4 start it and poll /health for the same version; on failure put the service back, restart it and remove <root>
 * Returns {root, version}.
 */
async function adopt(deps, { root = null, checkout, dry = false, healthTimeoutMs = HEALTH_TIMEOUT_MS, status = () => {} }) {
  checkout = path.resolve(checkout);
  const relayDir = path.join(checkout, "relay");
  const env = relayEnv(deps, relayDir);
  root = root ? path.resolve(root) : defaultRoot(deps, env);
  const version = plain((readJsonFile(deps, path.join(relayDir, "package.json")) || {}).version || "");
  const to = path.join(root, "current", "relay");
  const svc = await serviceFor(deps, env, relayDir, to);
  const created = !exists(deps, root);
  const step = stepper(deps, dry);
  const url = healthUrl(env);
  deps.log(`adopt ${checkout} as the install root ${root}; the ${svc.name} moves there${dry ? " — dry run, nothing is changed" : ""}`);
  const outside = stateOutside({ ...env, ...deps.env, ...(svc.env || {}) }, relayDir);
  if (outside.length) deps.log(`state kept outside the checkout stays where it is; the service keeps pointing the relay at it: ${outside.join(", ")}`);
  status({ step: "adopt", state: "running" });
  let stopped = false;
  try {
    await init(deps, { root, checkout, dry, next: false });
    if (svc.before !== undefined) await step(`keep a copy of the service file in ${path.join(root, ".adopt")}`, () => {
      deps.fs.mkdirSync(path.join(root, ".adopt"), { recursive: true, mode: 0o700 });
      deps.fs.writeFileSync(path.join(root, ".adopt", "service.plist"), svc.before, { mode: 0o600 });
    });
    await step(`stop the ${svc.name} and wait until ${url} stops answering`, async () => {
      stopped = true;
      await svc.stop();
      if (!(await waitDown(deps, url, healthTimeoutMs))) throw new Error(`the relay still answers on ${url} after its service stopped`);
    });
    await step(`copy relay/${SHARED.join(", relay/")} again to ${path.join(root, "shared")} (they changed while the relay ran)`, () => {
      for (const name of SHARED) if (exists(deps, path.join(relayDir, name))) copyState(deps, path.join(relayDir, name), path.join(root, "shared", name));
    });
    await step(`point the ${svc.name} at ${to} (${svc.change})`, () => svc.point());
    const healthy = await step(`start it; wait up to ${Math.round(healthTimeoutMs / 1000)} s for ${url} to report v ${version}`, async () => {
      await svc.start();
      return waitHealthy(deps, url, version, healthTimeoutMs);
    });
    if (!dry && !healthy) throw new Error(`the relay did not come up from ${to}`);
  } catch (e) {
    if (!dry && stopped) {
      deps.log(`adopt failed (${e.message}): moving the ${svc.name} back to ${relayDir}`);
      let back = false;
      try {
        await svc.restore();
        back = await waitHealthy(deps, url, version, healthTimeoutMs);
      } catch (r) {
        deps.log(`could not restore the service: ${r.message}`);
      }
      e.message = `${e.message}; the relay runs from ${relayDir} again${back ? "" : `, but ${url} does not report ${version}: check the service`}`;
      e.rolledBack = true;
    }
    if (!dry && created) deps.fs.rmSync(root, { recursive: true, force: true });
    status({ step: "adopt", state: e.rolledBack ? "rolled-back" : "failed", error: e.message });
    throw e;
  }
  deps.log(dry ? "Dry run: nothing was changed." : `relay ${version} runs from ${to}; the checkout ${checkout} is no longer used by the service.`);
  return { root, version };
}

/** Settings that put relay state outside relay/ (.env.example): adopt leaves that state where it is. */
const STATE_VARS = ["DECK_RELAY_ENV", "DECK_DATA_DIR", "DECK_AGENTS", "DECK_DEVICE_TOKENS"];
function stateOutside(vars, relayDir) {
  return STATE_VARS.filter((k) => {
    if (!vars[k]) return false;
    const rel = path.relative(relayDir, path.resolve(relayDir, vars[k]));
    return rel.startsWith("..") || path.isAbsolute(rel);
  }).map((k) => `${k}=${vars[k]}`);
}

/** A status or queue file inside the checkout's relay/data moves with the data to <root>/shared/data. */
function movedWithData(file, relayDir, root) {
  if (!file) return file;
  const rel = path.relative(path.join(relayDir, "data"), path.resolve(file));
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? path.join(root, "shared", "data", rel) : file;
}

// ------------------------------------------------------------------ apply
/** The release <root>/current points at ("0.3.6"), or null. */
function currentVersion(deps, root) {
  try {
    return path.basename(deps.fs.readlinkSync(path.join(root, "current")));
  } catch {
    return null;
  }
}

/** Point <root>/current at releases/<version> in one rename (a new symlink renamed over the old one). */
function switchTo(deps, root, version) {
  const tmp = path.join(root, `.current-${process.pid}-${deps.now()}`);
  deps.fs.symlinkSync(path.join("releases", version), tmp);
  deps.fs.renameSync(tmp, path.join(root, "current"));
}

/** The service restart command: systemd --user unit (Linux) or launchd label (macOS); DECK_RELAY_SERVICE names it. */
function restartCommand(deps, env) {
  if (deps.platform === "darwin") return ["launchctl", ["kickstart", "-k", `gui/${deps.uid}/${env.DECK_RELAY_SERVICE || "com.hermes-deck.relay"}`]];
  return ["systemctl", ["--user", "restart", env.DECK_RELAY_SERVICE || "hermes-deck-relay"]];
}

/** Poll /health until it reports `version` (true) or the timeout passes (false). */
async function waitHealthy(deps, url, version, timeoutMs) {
  const end = deps.now() + timeoutMs;
  while (deps.now() < end) {
    try {
      const res = await deps.fetch(url, typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(2000) } : {});
      if (res.ok) {
        const h = await res.json();
        if (h && h.ok === true && h.v === version) return true;
      }
    } catch {
      /* not up yet */
    }
    await deps.sleep(1000);
  }
  return false;
}

/** Keep the current and previous release and the newest others, KEEP in all; remove leftovers of failed runs. */
function prune(deps, root, keepAlso = []) {
  const dir = path.join(root, "releases");
  let names = [];
  try {
    names = deps.fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed = [];
  const versions = names.filter((n) => parse(n)).sort((a, b) => compare(b, a));
  const keep = new Set([currentVersion(deps, root), ...keepAlso].filter(Boolean));
  for (const v of versions) if (keep.size < KEEP) keep.add(v);
  for (const n of names) {
    if (keep.has(n) || (!parse(n) && !n.startsWith(".tmp-"))) continue;
    deps.fs.rmSync(path.join(dir, n), { recursive: true, force: true });
    removed.push(n);
  }
  return removed;
}

/** One updater at a time per install root (the timer and a person may meet). */
function lock(deps, root) {
  const file = path.join(root, ".update.lock");
  try {
    deps.fs.writeFileSync(file, String(process.pid), { flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(readText(deps, file));
    let alive = false;
    try {
      alive = pid > 0 && pid !== process.pid && (process.kill(pid, 0), true);
    } catch {
      alive = false;
    }
    if (alive) throw new Error(`another update is running (pid ${pid}, ${file})`);
    deps.fs.writeFileSync(file, String(process.pid));
  }
  return () => deps.fs.rmSync(file, { force: true });
}

/** --status-file: one JSON object rewritten atomically at every step; a `job` field written by the relay is kept. */
function statusWriter(deps, file, base) {
  if (!file) return () => {};
  let warned = false;
  return (patch) => {
    try {
      let job;
      try { job = JSON.parse(deps.fs.readFileSync(file, "utf8")).job; } catch { job = undefined; }
      const value = { ...base, ...patch, at: new Date(deps.now()).toISOString(), ...(job !== undefined ? { job } : {}) };
      deps.fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
      deps.fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      if (!warned) {
        warned = true;
        try { deps.log(`status: could not write ${file}: ${e.message}`); } catch { /* reporting must never interrupt recovery */ }
      }
    }
  };
}

/** Profiles under the Hermes root with the plugin installed (a plugins/hermes-deck folder and it named in config.yaml). */
function pluginProfiles(deps, hermesRoot) {
  const out = [];
  const has = (home) => exists(deps, path.join(home, "plugins", "hermes-deck")) && /\bhermes-deck\b/.test(readText(deps, path.join(home, "config.yaml")) || "");
  if (has(hermesRoot)) out.push("default");
  let names = [];
  try {
    names = deps.fs.readdirSync(path.join(hermesRoot, "profiles")).sort();
  } catch {
    /* no named profiles */
  }
  for (const n of names) if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n) && has(path.join(hermesRoot, "profiles", n))) out.push(n);
  return out;
}

/** The Hermes home of a profile: the root for "default", <root>/profiles/<name> otherwise. */
function profileHome(hermesRoot, profile) {
  return profile === "default" ? hermesRoot : path.join(hermesRoot, "profiles", profile);
}
function installedPluginVersion(deps, home) {
  const v = readJsonFile(deps, path.join(home, "hermes-deck", "installed.json"));
  return v && typeof v.version === "string" ? v.version.replace(/^v/, "") : null;
}

/** --with-plugin / plugin: the release's install.py, dry run first, then for real; changed profiles go to the restart queue. */
async function updatePlugin(deps, { releaseDir, env, dry, noDowngrade = false, restartQueue = null }) {
  const hermesRoot = env.HERMES_ROOT || path.join(deps.home, ".hermes");
  let profiles = pluginProfiles(deps, hermesRoot);
  if (!profiles.length) {
    deps.log(`plugin: no profile under ${hermesRoot} has hermes-deck installed; nothing to update`);
    return { profiles, changed: [] };
  }
  const before = Object.fromEntries(profiles.map((p) => [p, installedPluginVersion(deps, profileHome(hermesRoot, p))]));
  const target = /^\s*version:\s*["']?([^"'\s#]+)/m.exec(readText(deps, path.join(releaseDir, "hermes-plugin", "hermes-deck", "plugin.yaml")) || "")?.[1] || null;
  if (noDowngrade) {
    if (!parse(target)) throw new Error("cannot determine the plugin target version for --no-downgrade");
    profiles = profiles.filter((p) => {
      if (compare(before[p], target) <= 0) return true;
      deps.log(`plugin: skipping ${p}: installed ${before[p]} is newer than target ${target} (--no-downgrade)`);
      return false;
    });
    if (!profiles.length) return { profiles, changed: [] };
  }
  const venv = path.join(hermesRoot, "hermes-agent", "venv", "bin", "python");
  const python = hermesPython({ configured: [["DECK_HERMES_PYTHON", env.DECK_HERMES_PYTHON]], venv, exists: (p) => exists(deps, p), fallback: "python3", warn: (m) => deps.log(`plugin: ${m}`) });
  const installer = path.join(releaseDir, "hermes-plugin", "hermes-deck", "install.py");
  const args = [installer, "--home", hermesRoot, ...profiles.flatMap((p) => ["--profile", p])];
  const step = stepper(deps, dry);
  const generations = new Map();
  if (restartQueue && !dry) {
    const stamp = deps.now();
    const moved = `${restartQueue}.corrupt-${stamp}`;
    const hadCorrupt = exists(deps, moved);
    withQueue(restartQueue, (queue) => {
      for (const p of profiles) generations.set(p, queue.find((x) => x?.profile === p)?.since);
    }, { fs: deps.fs, now: () => stamp });
    if (!hadCorrupt && exists(deps, moved)) deps.log(`plugin: restart queue ${restartQueue} was unreadable; moved to ${moved}`);
  }
  const since = new Date(deps.now()).toISOString();
  let pending = [];
  await step(`plugin: ${python} ${[...args, "--dry-run"].join(" ")}`, async () => deps.log(String((await must(deps, python, [...args, "--dry-run"])).out || "").trim()));
  if (restartQueue && !dry && target) {
    // A previous install may have succeeded while its final queue write failed.
    pending = profiles.filter((p) => before[p] !== target);
    withQueue(restartQueue, (queue) => {
      queue = queue.map((x) => x && profiles.includes(x.profile) && x.pending === true && typeof x.target === "string" && installedPluginVersion(deps, profileHome(hermesRoot, x.profile)) === x.target
        ? { ...x, pending: false, reason: `plugin ${x.target}` } : x);
      for (const p of pending) {
        const previous = queue.find((x) => x?.profile === p);
        queue = queue.filter((x) => x?.profile !== p || x.since !== previous?.since);
        queue.push({ profile: p, reason: `plugin ${target}`, since, pending: true, target });
        generations.set(p, since);
      }
      return queue;
    }, deps);
  }
  await step(`plugin: ${python} ${args.join(" ")}`, async () => deps.log(String((await must(deps, python, args)).out || "").trim()));
  if (dry) return { profiles, changed: [] };
  const changed = profiles.filter((p) => { const now = installedPluginVersion(deps, profileHome(hermesRoot, p)); return now && now !== before[p]; });
  if (restartQueue) {
    withQueue(restartQueue, (queue) => {
      queue = queue.filter((x) => !x || !pending.includes(x.profile) || x.since !== since || changed.includes(x.profile));
      for (const p of changed) {
        const current = queue.find((x) => x?.profile === p);
        if (current ? current.since !== generations.get(p) : pending.includes(p)) continue;
        queue = queue.filter((x) => x?.profile !== p || x.since !== generations.get(p));
        queue.push({ profile: p, reason: `plugin ${installedPluginVersion(deps, profileHome(hermesRoot, p))}`, since, pending: false, ...(target ? { target } : {}) });
      }
      return queue;
    }, deps);
    if (changed.length) deps.log(`plugin: queued gateway restarts for ${changed.join(", ")} (the relay restarts them when idle)`);
  } else if (changed.length) {
    deps.log("plugin: gateways were not restarted. Restart each changed profile's gateway at a quiet moment:");
    for (const p of changed) deps.log(`  ${p === "default" ? "hermes gateway restart" : `hermes -p ${p} gateway restart`}`);
  }
  return { profiles, changed };
}

/** `deck-relay-update plugin`: the plugin step alone, from the running release (the app's "Try again"). */
// A plain checkout installs its own hermes-plugin/ (the version it runs); there is no install root to lock.
async function pluginOnly(deps, { root = null, dry = false, noDowngrade = false, statusFile = null, restartQueue = null, here = undefined }) {
  const loc = locate(deps, { root, here });
  const env = relayEnv(deps, loc.relay);
  const releaseDir = loc.managed ? path.join(loc.root, "current") : path.dirname(loc.relay);
  if (!loc.managed && !exists(deps, path.join(releaseDir, "hermes-plugin", "hermes-deck", "install.py"))) throw new Error(`the checkout ${releaseDir} has no hermes-plugin/hermes-deck/install.py`);
  const version = loc.managed ? currentVersion(deps, loc.root) : plain((readJsonFile(deps, path.join(loc.relay, "package.json")) || {}).version || "");
  const unlock = dry || !loc.managed ? () => {} : lock(deps, loc.root);
  const status = dry ? () => {} : statusWriter(deps, statusFile, { version, from: version });
  try {
    status({ step: "plugin", state: "running" });
    const r = await updatePlugin(deps, { releaseDir, env: { ...deps.env, ...env }, dry, noDowngrade, restartQueue });
    status({ step: "done", state: "done" });
    return r;
  } catch (e) {
    status({ step: "plugin", state: "plugin-failed", error: e.message });
    throw e;
  } finally {
    unlock();
  }
}

/**
 * apply: install release `version` (default: the latest) into <root>/releases/<version>/ and switch to it.
 *   1 download the source archive and SHA256SUMS.txt; the archive's sum must be listed and match (else: nothing written)
 *   2 extract to releases/.tmp-*, check its relay/package.json version, rename to releases/<version>
 *   3 link .env / agents.json / devices.json / data / logs from <root>/shared, npm ci --omit=dev, node src/index.js --self-check
 *   4 switch <root>/current atomically, restart the service, poll /health until v == <version> (30 s)
 *   5 on a failed restart or health check: switch back, restart, report the failure (exit 1)
 *   6 keep the last 3 releases; --with-plugin: the release's install.py (dry run, then real), no gateway restart
 * Returns {status: "updated"|"current"|"dry-run", from, to}.
 */
async function apply(deps, { root, version = null, noDowngrade = false, withPlugin = false, dry = false, force = false, adopt: adoptFirst = false, healthTimeoutMs = HEALTH_TIMEOUT_MS, statusFile = null, restartQueue = null, here = undefined }) {
  let loc = locate(deps, { root, here });
  if (!loc.managed && !adoptFirst) throw new Error(`the relay in ${loc.relay} is a plain checkout; update it with git, or convert it first: deck-relay-update adopt --dry-run`);
  if (!loc.managed) {
    // --adopt (the app's update): move the checkout to an install root first, then update that as usual
    const from = plain((readJsonFile(deps, path.join(loc.relay, "package.json")) || {}).version || "");
    const early = dry ? () => {} : statusWriter(deps, statusFile, { version: version || null, from });
    const made = await adopt(deps, { checkout: path.dirname(loc.relay), dry, healthTimeoutMs, status: early });
    if (dry) {
      deps.log(`then: apply${version ? ` --version ${version}` : ""} in ${made.root}`);
      return { status: "dry-run", from, to: version };
    }
    statusFile = movedWithData(statusFile, loc.relay, made.root);
    restartQueue = movedWithData(restartQueue, loc.relay, made.root);
    // The data copy took this job's launchd plist along; the relay's cleanup removes only the one the status names.
    let job;
    try { job = JSON.parse(deps.fs.readFileSync(statusFile, "utf8")).job; } catch { job = null; }
    const jobCopy = job && typeof job.plistFile === "string" ? movedWithData(job.plistFile, loc.relay, made.root) : null;
    if (jobCopy && jobCopy !== job.plistFile) deps.fs.rmSync(jobCopy, { force: true });
    loc = locate(deps, { root: made.root });
  }
  root = loc.root;
  const env = relayEnv(deps, loc.relay);
  deps = withToken(deps, env);
  const step = stepper(deps, dry);
  const pkg = readJsonFile(deps, path.join(loc.relay, "package.json")) || {};
  const unlock = dry ? () => {} : lock(deps, root);
  try {
    const from = currentVersion(deps, root);
    const base = { version: version || null, from };
    const status = dry ? () => {} : statusWriter(deps, statusFile, base);
    let repo, rel;
    try {
      repo = repoOf({ ...deps.env, ...env }, pkg);
      rel = await release(deps, repo, version);
    } catch (e) {
      status({ step: "download", state: "failed", error: e.message });
      throw e;
    }
    const to = rel.version;
    base.version = to;
    if (to === from && !force) {
      deps.log(`relay ${from} is already the ${version ? "requested" : "latest"} release (${repo})`);
      status({ step: "done", state: "done" });
      return { status: "current", from, to };
    }
    if (noDowngrade && compare(to, from) < 0) {
      deps.log(`relay ${from} is newer than the requested ${to}; nothing to do (--no-downgrade)`);
      status({ step: "done", state: "done" });
      return { status: "current", from, to };
    }
    if (!version && compare(to, from) < 0 && !force) {
      deps.log(`the latest release (${to}) is older than the running relay (${from}); pass --version to install it anyway`);
      status({ step: "done", state: "done" });
      return { status: "current", from, to };
    }
    deps.log(`update relay ${from} -> ${to} from ${repo}${dry ? " — dry run, nothing is changed" : ""}`);
    const releases = path.join(root, "releases");
    const dir = path.join(releases, to);
    const tmp = path.join(releases, `.tmp-${to}-${process.pid}`);
    const archive = path.join(root, `.tmp-${sourceName(to)}`);
    let switched = false;
    let phase = "download";
    try {
      const name = sourceName(to);
      let data = null;
      let want = null;
      status({ step: "download", state: "running" });
      await step(`download ${name} and SHA256SUMS.txt from release ${rel.tag}`, async () => {
        const sums = (await asset(deps, repo, rel, "SHA256SUMS.txt")).toString("utf8");
        want = sumFor(sums, name);
        if (!want) throw new Error(`SHA256SUMS.txt of ${rel.tag} does not list ${name}; nothing was changed`);
        data = await asset(deps, repo, rel, name);
      });
      phase = "verify";
      status({ step: "verify", state: "running" });
      await step(`verify the archive's sha256`, async () => {
        const got = crypto.createHash("sha256").update(data).digest("hex");
        if (got !== want) throw new Error(`checksum mismatch for ${name} (expected ${want}, got ${got}); nothing was changed`);
      });
      phase = "install";
      status({ step: "install", state: "running" });
      await step(`extract it to ${dir}`, async () => {
        if (exists(deps, dir)) deps.fs.rmSync(dir, { recursive: true, force: true }); // a leftover of an earlier attempt; not running
        deps.fs.rmSync(tmp, { recursive: true, force: true });
        deps.fs.mkdirSync(tmp, { recursive: true });
        deps.fs.writeFileSync(archive, data, { mode: 0o600 });
        await must(deps, "tar", ["-xzf", archive, "-C", tmp, "--strip-components=1"]);
        deps.fs.rmSync(archive, { force: true });
        const got = (readJsonFile(deps, path.join(tmp, "relay", "package.json")) || {}).version;
        if (got !== to) throw new Error(`the archive's relay/package.json says ${got || "nothing"}, not ${to}`);
        deps.fs.renameSync(tmp, dir);
      });
      await step("preserve desktop device keys in shared/devices.json", () => migrateDevices(deps, root, loc.relay));
      await step(`link relay/${SHARED.join(", relay/")} to ${path.join(root, "shared")}`, () => linkShared(deps, root, path.join(dir, "relay")));
      await step(`npm ci --omit=dev in ${path.join(dir, "relay")}`, () => must(deps, "npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: path.join(dir, "relay") }));
      await step(`self-check: node src/index.js --self-check in ${path.join(dir, "relay")}`, () => must(deps, deps.node, ["src/index.js", "--self-check"], { cwd: path.join(dir, "relay") }));
      phase = "switch";
      status({ step: "switch", state: "running" });
      await step(`switch ${path.join(root, "current")} to releases/${to}`, () => {
        switchTo(deps, root, to);
        switched = true;
      });
      phase = "health";
      status({ step: "health", state: "running" });
      const [cmd, args] = restartCommand(deps, env);
      const url = healthUrl(env);
      const healthy = await step(`restart: ${cmd} ${args.join(" ")}; wait up to ${Math.round(healthTimeoutMs / 1000)} s for ${url} to report v ${to}`, async () => {
        const r = await deps.run(cmd, args);
        if (!r || r.code !== 0) {
          deps.log(`restart failed (exit ${r ? r.code : "?"}): ${String((r && r.out) || "").trim().slice(-400)}`);
          return false;
        }
        return waitHealthy(deps, url, to, healthTimeoutMs);
      });
      if (!dry && !healthy) {
        deps.log(`relay ${to} did not come up: switching back to ${from}`);
        switchTo(deps, root, from);
        switched = false;
        const r = await deps.run(cmd, args);
        const back = r && r.code === 0 && (await waitHealthy(deps, url, from, healthTimeoutMs));
        throw Object.assign(new Error(`update to ${to} failed; rolled back to ${from}${back ? " (healthy)" : ` — but ${url} does not report ${from} either: check the service`}`), { rolledBack: true });
      }
      switched = false; // the new relay is proven healthy: nothing after this point may switch back
      await step(`keep the last ${KEEP} releases in ${releases}`, () => {
        const removed = prune(deps, root, [from]);
        if (removed.length) deps.log(`removed: ${removed.join(", ")}`);
      });
      let plugin = null;
      if (withPlugin) {
        phase = "plugin";
        status({ step: "plugin", state: "running" });
        try {
          plugin = await updatePlugin(deps, { releaseDir: dry ? path.join(root, "current") : dir, env: { ...deps.env, ...env }, dry, noDowngrade, restartQueue });
        } catch (e) {
          status({ step: "plugin", state: "plugin-failed", error: e.message });
          throw Object.assign(e, { pluginFailed: true });
        }
      }
      status({ step: "done", state: "done" });
      deps.log(dry ? "Dry run: nothing was changed." : `relay ${to} is running (was ${from}).`);
      return { status: dry ? "dry-run" : "updated", from, to, plugin };
    } catch (e) {
      if (!e.pluginFailed) status({ step: phase, state: e.rolledBack ? "rolled-back" : "failed", error: e.message });
      if (switched) {
        // something threw between the switch and the health check: never leave `current` on an unproven release
        deps.log(`switching back to ${from}`);
        switchTo(deps, root, from);
        const [cmd, args] = restartCommand(deps, env);
        await Promise.resolve(deps.run(cmd, args)).catch(() => {});
      }
      if (!dry) {
        deps.fs.rmSync(tmp, { recursive: true, force: true });
        deps.fs.rmSync(archive, { force: true });
      }
      throw e;
    }
  } finally {
    unlock();
  }
}

// ------------------------------------------------------------------ CLI
const USAGE = `deck-relay-update: update the Hermes Deck relay from GitHub releases (docs/updating.md)

  deck-relay-update --check [--auto]      is a newer release out? exit 0: up to date, 10: newer release available
                                          (--auto, for the timer: then apply it when DECK_RELAY_AUTO_UPDATE=1)
  deck-relay-update apply [--version X.Y.Z] [--no-downgrade] [--with-plugin] [--adopt] [--dry-run] [--root DIR]
                                          [--status-file FILE] [--restart-queue FILE]
                                          install a release next to the running one, switch, restart, health-check;
                                          switches back by itself when the new relay does not come up
  deck-relay-update plugin [--root DIR] [--no-downgrade] [--status-file F] [--restart-queue F] [--dry-run]   reinstall the plugin from the running release
  deck-relay-update init DIR [--dry-run]  turn this checkout into an install root at DIR (releases/, current, shared/)
  deck-relay-update adopt [DIR] [--dry-run]
                                          init DIR (default: DECK_RELAY_ROOT, else ~/.local/share/hermes-deck-relay),
                                          then point the relay's systemd/launchd service at it and health-check;
                                          puts the service back by itself when the relay does not come up there
  (apply --adopt adopts first when the relay runs from a plain checkout; the app's update does this)

Environment: DECK_UPDATE_REPO (owner/name; default: relay/package.json "repository"), DECK_RELAY_ROOT (install root),
DECK_RELAY_SERVICE (systemd --user unit, default hermes-deck-relay; launchd label on macOS, default
com.hermes-deck.relay), DECK_HERMES_PYTHON (Python for --with-plugin), GH_TOKEN / GITHUB_TOKEN (needed only for a private repository;
also read from the relay's .env).`;

/** Parse argv: {cmd, flags, dir}; throws on anything unknown. */
function parseArgs(argv) {
  const out = { cmd: null, dir: null, version: null, root: null, statusFile: null, restartQueue: null, dry: false, noDowngrade: false, withPlugin: false, auto: false, force: false, adopt: false };
  const a = [...argv];
  while (a.length) {
    const x = a.shift();
    if (x === "--check" || x === "check") out.cmd = "check";
    else if (x === "apply" || x === "init" || x === "adopt" || x === "plugin" || x === "help" || x === "--help" || x === "-h") out.cmd = x.replace(/^-+/, "") === "h" ? "help" : x.replace(/^-+/, "");
    else if (x === "--dry-run") out.dry = true;
    else if (x === "--with-plugin") out.withPlugin = true;
    else if (x === "--no-downgrade") out.noDowngrade = true;
    else if (x === "--auto") out.auto = true;
    else if (x === "--force") out.force = true;
    else if (x === "--adopt") out.adopt = true;
    else if (x === "--version" || x === "--root" || x === "--status-file" || x === "--restart-queue") {
      const v = a.shift();
      if (!v) throw new Error(`${x} needs a value`);
      if (x === "--version" && !parse(v)) throw new Error(`--version must be X.Y.Z, not "${v}"`);
      out[{ "--version": "version", "--root": "root", "--status-file": "statusFile", "--restart-queue": "restartQueue" }[x]] = v;
    } else if ((out.cmd === "init" || out.cmd === "adopt") && !out.dir && !x.startsWith("-")) out.dir = x;
    else throw new Error(`unknown argument: ${x}`);
  }
  if (out.cmd === "init" && !out.dir) throw new Error("init needs a directory: deck-relay-update init DIR [--dry-run]");
  return out;
}

/** Real effects. */
function defaultDeps() {
  const { spawn } = require("child_process");
  return {
    env: process.env,
    fetch: (url, opts) => fetch(url, opts),
    run: (cmd, args, { cwd } = {}) => new Promise((resolve) => {
      let child;
      try {
        child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        return resolve({ code: 1, out: e.message });
      }
      let out = "";
      const keep = (d) => { out = (out + d).slice(-16000); };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      child.on("error", (e) => resolve({ code: 1, out: e.message }));
      child.on("close", (code) => resolve({ code, out }));
    }),
    fs,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (s) => console.log(s),
    node: process.execPath,
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    home: os.homedir(),
  };
}

/** The CLI; returns the exit code. */
async function main(argv, deps = defaultDeps()) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    deps.log(`${e.message}\n\n${USAGE}`);
    return EXIT.usage;
  }
  if (!args.cmd || args.cmd === "help") {
    deps.log(USAGE);
    return args.cmd ? EXIT.ok : EXIT.usage;
  }
  try {
    if (args.cmd === "init") {
      await init(deps, { root: args.dir, checkout: path.join(__dirname, "..", ".."), dry: args.dry });
      return EXIT.ok;
    }
    if (args.cmd === "adopt") {
      const loc = locate(deps, {});
      if (loc.managed) throw new Error(`the relay already runs from the install root ${loc.root}`);
      await adopt(deps, { root: args.dir, checkout: path.join(__dirname, "..", ".."), dry: args.dry });
      return EXIT.ok;
    }
    if (args.cmd === "check") {
      const loc = locate(deps, { root: args.root });
      const r = await check(deps, { relayDir: loc.relay });
      deps.log(r.status === "newer" ? `relay ${r.running}: release ${r.latest} is available (${r.repo})` : r.status === "same" ? `relay ${r.running} is the latest release (${r.repo})` : `relay ${r.running} is newer than the latest release ${r.latest} (${r.repo})`);
      if (r.status !== "newer") return EXIT.ok;
      const auto = /^(1|true|yes|on)$/i.test(String(relayEnv(deps, loc.relay).DECK_RELAY_AUTO_UPDATE || ""));
      if (args.auto && auto && loc.managed) {
        await apply(deps, { root: loc.root, version: r.latest });
        return EXIT.ok;
      }
      if (args.auto && auto) deps.log("DECK_RELAY_AUTO_UPDATE=1, but this relay is a plain checkout: not applied (see deck-relay-update init)");
      return EXIT.updateAvailable;
    }
    if (args.cmd === "plugin") {
      await pluginOnly(deps, { root: args.root, dry: args.dry, noDowngrade: args.noDowngrade, statusFile: args.statusFile, restartQueue: args.restartQueue });
      return EXIT.ok;
    }
    await apply(deps, { root: args.root, version: args.version, noDowngrade: args.noDowngrade, withPlugin: args.withPlugin, dry: args.dry, force: args.force, adopt: args.adopt, statusFile: args.statusFile, restartQueue: args.restartQueue });
    return EXIT.ok;
  } catch (e) {
    deps.log(`error: ${e.message}${e.detail ? `\n${e.detail}` : ""}`);
    return EXIT.failed;
  }
}

module.exports = { withToken, main, parseArgs, check, apply, init, adopt, defaultRoot, copyState, prune, locate, repoOf, compare, sumFor, sourceName, healthUrl, restartCommand, pluginProfiles, profileHome, pluginOnly, parseEnv, statusWriter, EXIT, KEEP, USAGE };
