"use strict";
// relay/tools/update.js (deck-relay-update) with fake GitHub, fake commands and a fake clock on a temporary install
// root. No network, no service: `run` records commands and plays the service (restart = start what `current` points at).
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const U = require("../tools/update");

const REPO = "owner/name";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const archiveOf = (v) => Buffer.from(`SOURCE ${v}`);

/** Every file under dir: relative path -> content or "link:<target>". */
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      const rel = path.relative(dir, p);
      if (st.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) walk(p);
      else out[rel] = fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

/** An install root with releases `have` (the last is current) and shared .env / agents.json / data. */
function installRoot(have = ["0.3.5"]) {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deck-update-")), "deck");
  for (const v of have) {
    const relay = path.join(root, "releases", v, "relay");
    fs.mkdirSync(relay, { recursive: true });
    fs.writeFileSync(path.join(relay, "package.json"), JSON.stringify({ name: "deck-relay", version: v, repository: `github:${REPO}` }));
    const plugin = path.join(root, "releases", v, "hermes-plugin", "hermes-deck");
    fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(path.join(plugin, "plugin.yaml"), `version: "${v}"\n`);
  }
  fs.mkdirSync(path.join(root, "shared", "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "shared", ".env"), "DECK_RELAY_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\nDECK_RELAY_PORT=9555\n");
  fs.writeFileSync(path.join(root, "shared", "agents.json"), "{}");
  for (const v of have) for (const n of [".env", "agents.json", "data"]) fs.symlinkSync(path.join(root, "shared", n), path.join(root, "releases", v, "relay", n));
  fs.symlinkSync(path.join("releases", have.at(-1)), path.join(root, "current"));
  return root;
}

/**
 * Fake effects. `latest`: the newest release; `releases`: {version: {sums?, archive?}}; `broken`: versions whose
 * service never reports healthy; `failSelfCheck`: versions whose self-check fails.
 */
function fakes({ root = null, latest = "0.3.6", releases = {}, broken = [], failSelfCheck = [], env = {}, hermesRoot = null } = {}) {
  let clock = 1_000_000;
  const calls = [];
  const logs = [];
  const fetched = [];
  let running = root ? path.basename(fs.readlinkSync(path.join(root, "current"))) : null;
  const rel = (v) => {
    const r = releases[v] || {};
    const archive = r.archive || archiveOf(v);
    const sums = r.sums !== undefined ? r.sums : `${sha(archive)}  hermes-deck-${v}-source.tar.gz\n${"a".repeat(64)}  Hermes-Deck-${v}-Setup.exe\n`;
    return { archive, sums };
  };
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(String(body))), text: async () => String(body) });
  const assets = (v) => [{ id: `${v}-sums`, name: "SHA256SUMS.txt" }, { id: `${v}-src`, name: `hermes-deck-${v}-source.tar.gz` }, { id: `${v}-exe`, name: `Hermes-Deck-${v}-Setup.exe` }];
  const deps = {
    env: { ...env },
    fs,
    node: "node",
    platform: "linux",
    uid: 1000,
    home: hermesRoot ? path.dirname(hermesRoot) : os.tmpdir(),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    log: (s) => logs.push(String(s)),
    fetch: async (url) => {
      fetched.push(url);
      if (url.endsWith("/health")) {
        if (!running || broken.includes(running)) throw new Error("ECONNREFUSED");
        return ok({ ok: true, v: running, protocol: 1, plugins: {} });
      }
      let m = /\/repos\/owner\/name\/releases\/(latest|tags\/v([\d.]+))$/.exec(url);
      if (m) return ok({ tag_name: `v${m[2] || latest}`, assets: assets(m[2] || latest) });
      m = /\/releases\/assets\/([\d.]+)-(sums|src)$/.exec(url);
      if (m) return ok(m[2] === "sums" ? rel(m[1]).sums : rel(m[1]).archive);
      return { ok: false, status: 404, json: async () => ({}) };
    },
    run: async (cmd, args, opts = {}) => {
      calls.push([cmd, ...args].join(" ") + (opts.cwd ? ` @${opts.cwd}` : ""));
      if (cmd === "tar") {
        const archive = fs.readFileSync(args[1], "utf8");
        const v = /SOURCE ([\d.]+)/.exec(archive)[1];
        const dest = args[3];
        fs.mkdirSync(path.join(dest, "relay"), { recursive: true });
        fs.writeFileSync(path.join(dest, "relay", "package.json"), JSON.stringify({ name: "deck-relay", version: v, repository: `github:${REPO}` }));
        fs.mkdirSync(path.join(dest, "hermes-plugin", "hermes-deck"), { recursive: true });
        fs.writeFileSync(path.join(dest, "hermes-plugin", "hermes-deck", "install.py"), "# installer\n");
        fs.writeFileSync(path.join(dest, "hermes-plugin", "hermes-deck", "plugin.yaml"), `version: '${v}'\n`);
        return { code: 0, out: "" };
      }
      if (cmd === "node" && args.includes("--self-check")) {
        const v = JSON.parse(fs.readFileSync(path.join(opts.cwd, "package.json"), "utf8")).version;
        return failSelfCheck.includes(v) ? { code: 1, out: '{"ok":false,"problems":["bad config"]}' } : { code: 0, out: '{"ok":true}' };
      }
      if (cmd === "systemctl" || cmd === "launchctl") {
        running = path.basename(fs.readlinkSync(path.join(root, "current")));
        return { code: 0, out: "" };
      }
      if (args[0] && String(args[0]).endsWith("install.py") && !args.includes("--dry-run")) {
        const home = args[args.indexOf("--home") + 1];
        const release = path.dirname(path.dirname(path.dirname(args[0])));
        const version = path.basename(path.basename(release) === "current" ? fs.readlinkSync(release) : release);
        for (let i = 0; i < args.length; i++) if (args[i] === "--profile") {
          const p = args[i + 1];
          const dir = path.join(p === "default" ? home : path.join(home, "profiles", p), "hermes-deck");
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "installed.json"), JSON.stringify({ version, protocol: 1 }));
        }
      }
      return { code: 0, out: `${cmd} ok` };
    },
  };
  return { deps, calls, logs, fetched, running: () => running };
}

const readStatus = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("--status-file records each step and ends in done", async () => {
  const root = installRoot(["0.3.5"]);
  const status = path.join(root, "shared", "data", "update-status.json");
  fs.writeFileSync(status, JSON.stringify({ state: "running", step: "starting", job: { label: "x" } }));
  const f = fakes({ root });
  const seen = [];
  const write = f.deps.fs.writeFileSync;
  f.deps.fs = { ...fs, writeFileSync: (p, d, o) => { if (String(p).startsWith(status)) seen.push(JSON.parse(d).step); return write(p, d, o); } };
  assert.strictEqual(await U.main(["apply", "--root", root, "--status-file", status], f.deps), 0, f.logs.join("\n"));
  assert.deepStrictEqual([...new Set(seen)], ["download", "verify", "install", "switch", "health", "done"]);
  const s = readStatus(status);
  assert.strictEqual(s.state, "done");
  assert.strictEqual(s.version, "0.3.6");
  assert.strictEqual(s.from, "0.3.5");
  assert.deepStrictEqual(s.job, { label: "x" }, "the relay's job field is kept");
});

test("--status-file: a health failure ends in rolled-back", async () => {
  const root = installRoot(["0.3.5"]);
  const status = path.join(root, "shared", "data", "update-status.json");
  const f = fakes({ root, broken: ["0.3.6"] });
  assert.strictEqual(await U.main(["apply", "--root", root, "--status-file", status], f.deps), 1);
  const s = readStatus(status);
  assert.strictEqual(s.state, "rolled-back");
  assert.strictEqual(s.step, "health");
  assert.match(s.error, /rolled back to 0\.3\.5/);
});

test("--status-file: a checksum mismatch ends in failed at verify", async () => {
  const root = installRoot(["0.3.5"]);
  const status = path.join(root, "shared", "data", "update-status.json");
  const f = fakes({ root, releases: { "0.3.6": { sums: `${"0".repeat(64)}  hermes-deck-0.3.6-source.tar.gz\n` } } });
  assert.strictEqual(await U.main(["apply", "--root", root, "--status-file", status], f.deps), 1);
  const s = readStatus(status);
  assert.strictEqual(s.state, "failed");
  assert.strictEqual(s.step, "verify");
});

test("a plugin failure after a healthy switch keeps the new relay (plugin-failed)", async () => {
  const root = installRoot(["0.3.5"]);
  const hermes = path.join(path.dirname(root), ".hermes");
  fs.mkdirSync(path.join(hermes, "plugins", "hermes-deck"), { recursive: true });
  fs.writeFileSync(path.join(hermes, "config.yaml"), "plugins: {enabled: [hermes-deck]}\n");
  const status = path.join(root, "shared", "data", "update-status.json");
  const f = fakes({ root, hermesRoot: hermes, env: { HERMES_ROOT: hermes, DECK_HERMES_PYTHON: "/opt/py" } });
  const run = f.deps.run;
  f.deps.run = async (cmd, args, opts) => (cmd === "/opt/py" && !args.includes("--dry-run") ? { code: 1, out: "boom" } : run(cmd, args, opts));
  assert.strictEqual(await U.main(["apply", "--root", root, "--with-plugin", "--status-file", status], f.deps), 1);
  assert.strictEqual(current(root), path.join("releases", "0.3.6"), "no rollback for a plugin failure");
  const s = readStatus(status);
  assert.strictEqual(s.state, "plugin-failed");
  assert.strictEqual(s.step, "plugin");
});

test("--status-file: a failed status rename does not fail the update", async () => {
  const root = installRoot(["0.3.5"]);
  const status = path.join(root, "shared", "data", "update-status.json");
  const f = fakes({ root });
  f.deps.fs = { ...fs, renameSync: (from, to) => {
    if (String(from).startsWith(status)) throw new Error("status disk full");
    return fs.renameSync(from, to);
  } };
  const code = await U.main(["apply", "--root", root, "--status-file", status], f.deps);
  assert.ok(!fs.existsSync(path.join(root, ".update.lock")), "the update lock is released");
  assert.deepStrictEqual(f.logs.filter((s) => s.startsWith("status: could not write")), [
    `status: could not write ${status}: status disk full`,
  ], "only the first status failure is logged");
  assert.strictEqual(code, 0, f.logs.join("\n"));
  assert.strictEqual(current(root), path.join("releases", "0.3.6"));
});

test("--status-file: rejected release lookup ends in failed", async () => {
  const root = installRoot(["0.3.5"]);
  const status = path.join(root, "shared", "data", "update-status.json");
  fs.writeFileSync(status, JSON.stringify({ state: "running", step: "starting" }));
  const f = fakes({ root });
  const fetch = f.deps.fetch;
  f.deps.fetch = async (url, opts) => url.endsWith("/releases/latest") ? { ok: false, status: 404 } : fetch(url, opts);
  assert.strictEqual(await U.main(["apply", "--root", root, "--status-file", status], f.deps), 1);
  const s = readStatus(status);
  assert.strictEqual(s.state, "failed");
  assert.strictEqual(s.step, "download");
  assert.strictEqual(s.version, null);
  assert.strictEqual(s.from, "0.3.5");
  assert.match(s.error, /GitHub 404/);
  assert.ok(!fs.existsSync(path.join(root, ".update.lock")));
});

test("--status-file: older latest release ends in done", async () => {
  const root = installRoot(["0.3.7"]);
  const status = path.join(root, "shared", "data", "update-status.json");
  fs.writeFileSync(status, JSON.stringify({ state: "running", step: "starting" }));
  const f = fakes({ root });
  assert.strictEqual(await U.main(["apply", "--root", root, "--status-file", status], f.deps), 0);
  const s = readStatus(status);
  assert.strictEqual(s.state, "done");
  assert.strictEqual(s.step, "done");
  assert.strictEqual(s.version, "0.3.6");
  assert.strictEqual(s.from, "0.3.7");
  assert.strictEqual(current(root), path.join("releases", "0.3.7"));
  assert.ok(!fs.existsSync(path.join(root, ".update.lock")));
});

test("--no-downgrade preserves an install that advanced before the job ran", async () => {
  const root = installRoot(["0.3.5", "0.3.7"]);
  const status = path.join(root, "shared", "data", "update-status.json");
  const f = fakes({ root });
  assert.strictEqual(await U.main(["apply", "--root", root, "--version", "0.3.6", "--no-downgrade", "--status-file", status], f.deps), 0, f.logs.join("\n"));
  assert.strictEqual(current(root), path.join("releases", "0.3.7"));
  assert.deepStrictEqual(f.calls, [], "no extract, install or service restart");
  assert.strictEqual(readStatus(status).step, "done");
  assert.strictEqual(readStatus(status).state, "done");
  assert.strictEqual(readStatus(status).from, "0.3.7");
  assert.ok(f.logs.includes("relay 0.3.7 is newer than the requested 0.3.6; nothing to do (--no-downgrade)"));
  assert.ok(!fs.existsSync(path.join(root, ".update.lock")));
});

test("an explicit downgrade remains allowed without --no-downgrade", async () => {
  const root = installRoot(["0.3.5", "0.3.7"]);
  const f = fakes({ root });
  assert.strictEqual(await U.main(["apply", "--root", root, "--version", "0.3.6"], f.deps), 0, f.logs.join("\n"));
  assert.strictEqual(current(root), path.join("releases", "0.3.6"));
  assert.strictEqual(f.running(), "0.3.6");
  assert.deepStrictEqual(f.calls.map((c) => c.split(" ")[0]), ["tar", "npm", "node", "systemctl"]);
});

test("arguments: --status-file and --restart-queue need a value", () => {
  assert.deepStrictEqual(
    (({ statusFile, restartQueue }) => ({ statusFile, restartQueue }))(U.parseArgs(["apply", "--status-file", "/s.json", "--restart-queue", "/q.json"])),
    { statusFile: "/s.json", restartQueue: "/q.json" });
  assert.throws(() => U.parseArgs(["apply", "--status-file"]), /needs a value/);
  assert.throws(() => U.parseArgs(["apply", "--restart-queue"]), /needs a value/);
});

const current = (root) => fs.readlinkSync(path.join(root, "current"));

test("versions, repo and the source archive name", () => {
  assert.strictEqual(U.compare("0.3.10", "0.3.9"), 1);
  assert.strictEqual(U.compare("v0.3.6", "0.3.6"), 0);
  assert.strictEqual(U.compare("1.0.0-beta", "0.3.6"), null);
  assert.strictEqual(U.repoOf({}, { repository: { url: "https://github.com/owner/name.git" } }), REPO);
  assert.strictEqual(U.repoOf({}, { repository: "github:owner/name" }), REPO);
  assert.strictEqual(U.repoOf({ DECK_UPDATE_REPO: "fork/deck" }, { repository: "github:owner/name" }), "fork/deck");
  assert.throws(() => U.repoOf({ DECK_UPDATE_REPO: "not a repo" }, {}), /owner\/name/);
  assert.throws(() => U.repoOf({}, {}), /DECK_UPDATE_REPO/);
  assert.strictEqual(U.sourceName("v1.0.0"), "hermes-deck-1.0.0-source.tar.gz");
  assert.strictEqual(U.repoOf({}, require("../package.json")).split("/").length, 2, "relay/package.json names the repository");
  assert.strictEqual(U.healthUrl({ DECK_RELAY_HOST: "0.0.0.0", DECK_RELAY_PORT: "9555" }), "http://127.0.0.1:9555/health");
  assert.strictEqual(U.healthUrl({ DECK_RELAY_HOST: "fd7a::1" }), "http://[fd7a::1]:9330/health");
  assert.deepStrictEqual(U.restartCommand({ platform: "darwin", uid: 501 }, {}), ["launchctl", ["kickstart", "-k", "gui/501/com.hermes-deck.relay"]]);
  assert.deepStrictEqual(U.restartCommand({ platform: "linux" }, { DECK_RELAY_SERVICE: "my-relay" }), ["systemctl", ["--user", "restart", "my-relay"]]);
});

test("--check: newer (exit 10, writes update-check.json), same and older (exit 0)", async () => {
  const root = installRoot(["0.3.5"]);
  for (const [latest, code, status] of [["0.3.6", 10, true], ["0.3.5", 0, false], ["0.3.4", 0, false]]) {
    const f = fakes({ root, latest, env: { DECK_RELAY_ROOT: root } });
    assert.strictEqual(await U.main(["--check"], f.deps), code, f.logs.join("\n"));
    const saved = JSON.parse(fs.readFileSync(path.join(root, "shared", "data", "update-check.json"), "utf8"));
    assert.strictEqual(saved.updateAvailable, status);
    assert.strictEqual(saved.latest, latest);
    assert.ok(!f.calls.length, "check runs nothing");
  }
  assert.strictEqual(current(root), path.join("releases", "0.3.5"));
});

test("--check --auto applies only with DECK_RELAY_AUTO_UPDATE=1", async () => {
  const root = installRoot(["0.3.5"]);
  let f = fakes({ root, env: { DECK_RELAY_ROOT: root } });
  assert.strictEqual(await U.main(["--check", "--auto"], f.deps), 10);
  assert.strictEqual(current(root), path.join("releases", "0.3.5"));
  f = fakes({ root, env: { DECK_RELAY_ROOT: root, DECK_RELAY_AUTO_UPDATE: "1" } });
  assert.strictEqual(await U.main(["--check", "--auto"], f.deps), 0, f.logs.join("\n"));
  assert.strictEqual(current(root), path.join("releases", "0.3.6"));
});

test("apply: verify, extract, link shared, npm ci, self-check, switch, restart, health", async () => {
  const root = installRoot(["0.3.5"]);
  const f = fakes({ root });
  assert.strictEqual(await U.main(["apply", "--root", root], f.deps), 0, f.logs.join("\n"));
  assert.strictEqual(current(root), path.join("releases", "0.3.6"));
  assert.strictEqual(f.running(), "0.3.6");
  const relay = path.join(root, "releases", "0.3.6", "relay");
  for (const n of [".env", "agents.json", "data"]) assert.strictEqual(fs.readlinkSync(path.join(relay, n)), path.join(root, "shared", n));
  assert.deepStrictEqual(f.calls.map((c) => c.split(" ")[0]), ["tar", "npm", "node", "systemctl"]);
  assert.ok(f.calls[1].startsWith("npm ci --omit=dev") && f.calls[1].endsWith(`@${relay}`));
  assert.ok(f.calls[2].startsWith("node src/index.js --self-check") && f.calls[2].endsWith(`@${relay}`));
  assert.strictEqual(f.calls[3], "systemctl --user restart hermes-deck-relay");
  assert.ok(f.fetched.includes("http://127.0.0.1:9555/health"), "health on the configured port");
  assert.ok(!fs.readdirSync(root).some((n) => n.startsWith(".tmp-") || n === ".update.lock"), "no leftovers");
  assert.ok(!fs.readdirSync(path.join(root, "releases")).some((n) => n.startsWith(".tmp-")));
  // again: nothing to do
  const g = fakes({ root });
  assert.strictEqual(await U.main(["apply", "--root", root], g.deps), 0);
  assert.deepStrictEqual(g.calls, []);
});

test("checksum mismatch or a missing sum: nothing is switched or written", async () => {
  for (const releases of [{ "0.3.6": { sums: `${"b".repeat(64)}  hermes-deck-0.3.6-source.tar.gz\n` } }, { "0.3.6": { sums: `${"a".repeat(64)}  Hermes-Deck-0.3.6-Setup.exe\n` } }]) {
    const root = installRoot(["0.3.5"]);
    const before = tree(root);
    const f = fakes({ root, releases });
    assert.strictEqual(await U.main(["apply", "--root", root], f.deps), 1);
    assert.match(f.logs.join("\n"), /checksum mismatch|does not list/);
    assert.deepStrictEqual(tree(root), before);
    assert.deepStrictEqual(f.calls, [], "no extract, no restart");
  }
});

test("a failing self-check stops before the switch", async () => {
  const root = installRoot(["0.3.5"]);
  const f = fakes({ root, failSelfCheck: ["0.3.6"] });
  assert.strictEqual(await U.main(["apply", "--root", root], f.deps), 1);
  assert.strictEqual(current(root), path.join("releases", "0.3.5"));
  assert.ok(!f.calls.some((c) => c.startsWith("systemctl")), "the service is not touched");
});

test("health timeout: rolled back to the previous current and restarted", async () => {
  const root = installRoot(["0.3.5"]);
  const f = fakes({ root, broken: ["0.3.6"] });
  assert.strictEqual(await U.main(["apply", "--root", root], f.deps), 1);
  assert.strictEqual(current(root), path.join("releases", "0.3.5"));
  assert.strictEqual(f.running(), "0.3.5");
  assert.deepStrictEqual(f.calls.filter((c) => c.startsWith("systemctl")), ["systemctl --user restart hermes-deck-relay", "systemctl --user restart hermes-deck-relay"]);
  assert.match(f.logs.join("\n"), /rolled back to 0\.3\.5 \(healthy\)/);
  assert.ok(fs.existsSync(path.join(root, "releases", "0.3.6")), "the failed release stays for inspection until pruned");
  assert.ok(!fs.existsSync(path.join(root, ".update.lock")));
});

test("keeps the last 3 releases (current and previous always)", async () => {
  const root = installRoot(["0.3.1", "0.3.2", "0.3.3", "0.3.4", "0.3.5"]);
  fs.mkdirSync(path.join(root, "releases", ".tmp-0.3.9-1")); // a crashed run's leftover
  const f = fakes({ root });
  assert.strictEqual(await U.main(["apply", "--root", root], f.deps), 0, f.logs.join("\n"));
  assert.deepStrictEqual(fs.readdirSync(path.join(root, "releases")).sort(), ["0.3.4", "0.3.5", "0.3.6"]);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, "shared")).sort(), [".env", "agents.json", "data", "devices.json"], "shared state retained with the desktop key store");
});

test("--dry-run writes nothing and runs nothing", async () => {
  const root = installRoot(["0.3.5"]);
  const before = tree(root);
  const f = fakes({ root });
  assert.strictEqual(await U.main(["apply", "--root", root, "--dry-run", "--with-plugin"], f.deps), 0, f.logs.join("\n"));
  assert.deepStrictEqual(tree(root), before);
  assert.deepStrictEqual(f.calls, []);
  const text = f.logs.join("\n");
  for (const s of ["would download hermes-deck-0.3.6-source.tar.gz", "would npm ci --omit=dev", "would self-check", "would switch", "would restart", "Dry run"]) assert.ok(text.includes(s), s);
});

test("--with-plugin runs install.py dry, then real, for profiles with the plugin; never restarts a gateway", async () => {
  const root = installRoot(["0.3.5"]);
  const hermes = path.join(path.dirname(root), ".hermes");
  const home = (p) => (p === "default" ? hermes : path.join(hermes, "profiles", p));
  for (const [p, on] of [["default", true], ["research", true], ["plain", false]]) {
    fs.mkdirSync(path.join(home(p), "plugins", on ? "hermes-deck" : "other"), { recursive: true });
    fs.writeFileSync(path.join(home(p), "config.yaml"), on ? "plugins: {enabled: [hermes-deck]}\n" : "model: {}\n");
  }
  const f = fakes({ root, hermesRoot: hermes, env: { HERMES_ROOT: hermes, DECK_HERMES_PYTHON: "/opt/py" } });
  assert.strictEqual(await U.main(["apply", "--root", root, "--with-plugin"], f.deps), 0, f.logs.join("\n"));
  const py = f.calls.filter((c) => c.startsWith("/opt/py"));
  const installer = path.join(root, "releases", "0.3.6", "hermes-plugin", "hermes-deck", "install.py");
  assert.deepStrictEqual(py, [
    `/opt/py ${installer} --home ${hermes} --profile default --profile research --dry-run`,
    `/opt/py ${installer} --home ${hermes} --profile default --profile research`,
  ]);
  assert.ok(!f.calls.some((c) => /^hermes\b|\bgateway\b/.test(c)), "no gateway command is run");
  assert.deepStrictEqual(f.calls.filter((c) => c.startsWith("systemctl")), ["systemctl --user restart hermes-deck-relay"], "only the relay restarts");
  assert.match(f.logs.join("\n"), /hermes -p research gateway restart/, "the restart command is printed when no queue is given");
});

test("a plain checkout is refused by apply and keeps working; init converts one (dry run first)", async () => {
  const f0 = fakes();
  assert.strictEqual(await U.main(["apply"], { ...f0.deps, env: {} }), 1);
  assert.match(f0.logs.join("\n"), /plain checkout/);
  // a made-up checkout
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "deck-init-"));
  const checkout = path.join(base, "clone");
  fs.mkdirSync(path.join(checkout, "relay", "src"), { recursive: true });
  fs.mkdirSync(path.join(checkout, "relay", "node_modules", "ws"), { recursive: true });
  fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
  fs.mkdirSync(path.join(checkout, "relay", "data"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "relay", "package.json"), JSON.stringify({ version: "0.3.6" }));
  fs.writeFileSync(path.join(checkout, "relay", "src", "index.js"), "// relay\n");
  fs.writeFileSync(path.join(checkout, "relay", ".env"), "DECK_RELAY_TOKEN=x\n");
  fs.writeFileSync(path.join(checkout, "relay", "data", "checkpoint.json"), "{}");
  const root = path.join(base, "deck");
  const before = tree(base);
  const f = fakes();
  await U.init(f.deps, { root, checkout, dry: true });
  assert.deepStrictEqual(tree(base), before, "dry run: nothing written");
  assert.deepStrictEqual(f.calls, []);
  await U.init(f.deps, { root, checkout });
  assert.strictEqual(current(root), path.join("releases", "0.3.6"));
  assert.strictEqual(fs.readFileSync(path.join(root, "shared", ".env"), "utf8"), "DECK_RELAY_TOKEN=x\n");
  assert.strictEqual(fs.readFileSync(path.join(root, "shared", "data", "checkpoint.json"), "utf8"), "{}");
  const rel = path.join(root, "releases", "0.3.6");
  assert.ok(!fs.existsSync(path.join(rel, ".git")) && !fs.existsSync(path.join(rel, "relay", "node_modules")));
  assert.strictEqual(fs.readlinkSync(path.join(rel, "relay", ".env")), path.join(root, "shared", ".env"));
  assert.strictEqual(fs.readlinkSync(path.join(rel, "relay", "data")), path.join(root, "shared", "data"));
  assert.ok(fs.existsSync(path.join(checkout, "relay", ".env")) && fs.existsSync(path.join(checkout, "relay", "data", "checkpoint.json")), "the checkout keeps its own state");
  assert.deepStrictEqual(f.calls.map((c) => c.split(" ")[0]), ["npm", "node"]);
  await assert.rejects(U.init(f.deps, { root, checkout }), /already an install root/);
  await assert.rejects(U.init(f.deps, { root: path.join(checkout, "inside"), checkout }), /outside the checkout/);
  // apply finds it through DECK_RELAY_ROOT
  assert.strictEqual(U.locate({ env: { DECK_RELAY_ROOT: root }, fs }).managed, true);
  assert.strictEqual(U.locate({ env: {}, fs }, { here: path.join(root, "releases", "0.3.6", "relay") }).root, root);
  assert.strictEqual(U.locate({ env: {}, fs }, { here: path.join(root, "current", "relay") }).root, root);
});

test("arguments", () => {
  assert.deepStrictEqual(U.parseArgs(["apply", "--version", "v1.0.0", "--with-plugin", "--dry-run"]).version, "v1.0.0");
  assert.throws(() => U.parseArgs(["apply", "--version", "latest"]), /X\.Y\.Z/);
  assert.throws(() => U.parseArgs(["apply", "--bogus"]), /unknown argument/);
  assert.throws(() => U.parseArgs(["init"]), /needs a directory/);
  assert.strictEqual(U.parseArgs(["--check"]).cmd, "check");
});

function pluginHermes(root, profiles) {
  const hermes = path.join(path.dirname(root), ".hermes");
  for (const [p, installed] of profiles) {
    const home = p === "default" ? hermes : path.join(hermes, "profiles", p);
    fs.mkdirSync(path.join(home, "plugins", "hermes-deck"), { recursive: true });
    fs.writeFileSync(path.join(home, "config.yaml"), "plugins: {enabled: [hermes-deck]}\n");
    if (installed) {
      fs.mkdirSync(path.join(home, "hermes-deck"), { recursive: true });
      fs.writeFileSync(path.join(home, "hermes-deck", "installed.json"), JSON.stringify({ version: installed }));
    }
  }
  return hermes;
}

test("--restart-queue lists only profiles whose plugin version changed", async () => {
  const root = installRoot(["0.3.5"]);
  const hermes = pluginHermes(root, [["default", "0.3.5"], ["research", "0.3.6"], ["fresh", null]]);
  const queue = path.join(root, "shared", "data", "restart-queue.json");
  const f = fakes({ root, hermesRoot: hermes, env: { HERMES_ROOT: hermes, DECK_HERMES_PYTHON: "/opt/py" } });
  assert.strictEqual(await U.main(["apply", "--root", root, "--with-plugin", "--restart-queue", queue], f.deps), 0, f.logs.join("\n"));
  const q = JSON.parse(fs.readFileSync(queue, "utf8"));
  assert.deepStrictEqual(q.map((x) => x.profile).sort(), ["default", "fresh"], "research was already 0.3.6");
  assert.ok(q.every((x) => x.reason === "plugin 0.3.6" && typeof x.since === "string"));
});

test("--restart-queue keeps earlier entries and replaces a profile's older reason", async () => {
  const root = installRoot(["0.3.5"]);
  const hermes = pluginHermes(root, [["default", "0.3.5"]]);
  const queue = path.join(root, "shared", "data", "restart-queue.json");
  fs.writeFileSync(queue, JSON.stringify([{ profile: "default", reason: "plugin 0.3.5", since: "x" }, { profile: "other", reason: "plugin 0.3.5", since: "y" }]));
  const f = fakes({ root, hermesRoot: hermes, env: { HERMES_ROOT: hermes, DECK_HERMES_PYTHON: "/opt/py" } });
  assert.strictEqual(await U.main(["apply", "--root", root, "--with-plugin", "--restart-queue", queue], f.deps), 0);
  const q = JSON.parse(fs.readFileSync(queue, "utf8"));
  assert.deepStrictEqual(q.map((x) => [x.profile, x.reason]), [["other", "plugin 0.3.5"], ["default", "plugin 0.3.6"]]);
});

test("plugin subcommand: runs only the current release's installer and writes plugin status", async () => {
  const root = installRoot(["0.3.6"]);
  const hermes = pluginHermes(root, [["default", "0.3.5"]]);
  fs.mkdirSync(path.join(root, "releases", "0.3.6", "hermes-plugin", "hermes-deck"), { recursive: true });
  const status = path.join(root, "shared", "data", "update-status.json");
  const queue = path.join(root, "shared", "data", "restart-queue.json");
  const f = fakes({ root, hermesRoot: hermes, env: { HERMES_ROOT: hermes, DECK_HERMES_PYTHON: "/opt/py" } });
  assert.strictEqual(await U.main(["plugin", "--root", root, "--status-file", status, "--restart-queue", queue], f.deps), 0, f.logs.join("\n"));
  assert.ok(!f.calls.some((c) => /^(tar|npm|systemctl)\b/.test(c)), "no relay work");
  assert.strictEqual(f.calls.filter((c) => c.startsWith("/opt/py")).length, 2, "dry run, then real");
  assert.strictEqual(JSON.parse(fs.readFileSync(status, "utf8")).state, "done");
  assert.strictEqual(readStatus(path.join(hermes, "hermes-deck", "installed.json")).version, "0.3.6");
  assert.strictEqual(readStatus(queue)[0].reason, "plugin 0.3.6");
  assert.strictEqual(readStatus(queue)[0].pending, false);
});

test("plugin subcommand: dry run leaves profiles, status and queue untouched", async () => {
  const root = installRoot(["0.3.6"]);
  const hermes = pluginHermes(root, [["default", "0.3.5"]]);
  const status = path.join(root, "shared", "data", "update-status.json");
  const queue = path.join(root, "shared", "data", "restart-queue.json");
  const before = tree(path.dirname(root));
  const f = fakes({ root, hermesRoot: hermes, env: { HERMES_ROOT: hermes } });
  f.deps.fs = { ...fs, readFileSync: (file, ...args) => {
    assert.notStrictEqual(file, queue, "dry run must not read the queue");
    return fs.readFileSync(file, ...args);
  } };
  assert.strictEqual(await U.main(["plugin", "--root", root, "--dry-run", "--status-file", status, "--restart-queue", queue], f.deps), 0);
  assert.deepStrictEqual(tree(path.dirname(root)), before);
  assert.deepStrictEqual(f.calls, []);
});

test("plugin subcommand: a held lock leaves the active updater's status untouched", async () => {
  const root = installRoot(["0.3.6"]);
  const status = path.join(root, "shared", "data", "update-status.json");
  fs.writeFileSync(status, JSON.stringify({ state: "running", step: "install", job: { label: "active" } }));
  fs.writeFileSync(path.join(root, ".update.lock"), String(process.ppid));
  const before = tree(root);
  const f = fakes({ root });
  assert.strictEqual(await U.main(["plugin", "--root", root, "--status-file", status], f.deps), 1);
  assert.match(f.logs.join("\n"), /another update is running/);
  assert.deepStrictEqual(tree(root), before);
  assert.deepStrictEqual(f.calls, []);
});

test("plugin subcommand: installer failure writes plugin-failed and releases the lock", async () => {
  const root = installRoot(["0.3.6"]);
  const hermes = pluginHermes(root, [["default", "0.3.5"]]);
  const status = path.join(root, "shared", "data", "update-status.json");
  const f = fakes({ root, hermesRoot: hermes, env: { HERMES_ROOT: hermes } });
  f.deps.run = async () => ({ code: 1, out: "installer failed" });
  assert.strictEqual(await U.main(["plugin", "--root", root, "--status-file", status], f.deps), 1);
  const saved = readStatus(status);
  assert.strictEqual(saved.state, "plugin-failed");
  assert.strictEqual(saved.step, "plugin");
  assert.match(saved.error, /failed \(exit 1\)/);
  assert.strictEqual(current(root), path.join("releases", "0.3.6"));
  assert.ok(!fs.existsSync(path.join(root, ".update.lock")));
});

test("plugin queue: unreadable queue stops before any installer call and preserves its contents", async () => {
  const root = installRoot(["0.3.6"]);
  const hermes = pluginHermes(root, [["default", "0.3.5"]]);
  const queue = path.join(root, "shared", "data", "restart-queue.json");
  const status = path.join(root, "shared", "data", "update-status.json");
  const original = JSON.stringify([{ profile: "other", reason: "plugin 0.3.5", since: "earlier" }]);
  fs.writeFileSync(queue, original);
  const f = fakes({ root, env: { HERMES_ROOT: hermes } });
  f.deps.fs = { ...fs, readFileSync: (file, ...args) => {
    if (file === queue) throw Object.assign(new Error("queue read denied"), { code: "EACCES" });
    return fs.readFileSync(file, ...args);
  } };
  assert.strictEqual(await U.main(["plugin", "--root", root, "--restart-queue", queue, "--status-file", status], f.deps), 1);
  assert.deepStrictEqual(f.calls, []);
  assert.strictEqual(fs.readFileSync(queue, "utf8"), original);
  assert.strictEqual(readStatus(status).state, "plugin-failed");
});

test("plugin queue: corrupt JSON and non-array queues are moved aside before a successful update", async () => {
  for (const original of ["{broken", "{}", "null"]) {
    const root = installRoot(["0.3.6"]);
    const hermes = pluginHermes(root, [["default", "0.3.5"]]);
    const queue = path.join(root, "shared", "data", "restart-queue.json");
    fs.writeFileSync(queue, original);
    const f = fakes({ root, env: { HERMES_ROOT: hermes } });
    assert.strictEqual(await U.main(["plugin", "--root", root, "--restart-queue", queue], f.deps), 0, f.logs.join("\n"));
    const moved = `${queue}.corrupt-${f.deps.now()}`;
    assert.strictEqual(fs.readFileSync(moved, "utf8"), original);
    assert.ok(f.logs.includes(`plugin: restart queue ${queue} was unreadable; moved to ${moved}`));
    assert.strictEqual(readStatus(queue)[0].pending, false);
  }
});

test("plugin queue: pre-write failure prevents the real install", async () => {
  const root = installRoot(["0.3.6"]);
  const hermes = pluginHermes(root, [["default", "0.3.5"]]);
  const queue = path.join(root, "shared", "data", "restart-queue.json");
  fs.writeFileSync(queue, "[]");
  const f = fakes({ root, env: { HERMES_ROOT: hermes } });
  f.deps.fs = { ...fs, renameSync: (from, to) => {
    if (to === queue) throw new Error("queue rename denied");
    return fs.renameSync(from, to);
  } };
  assert.strictEqual(await U.main(["plugin", "--root", root, "--restart-queue", queue], f.deps), 1);
  assert.ok(f.calls.every((c) => c.endsWith("--dry-run")), "no real install");
  assert.strictEqual(readStatus(path.join(hermes, "hermes-deck", "installed.json")).version, "0.3.5");
  assert.strictEqual(fs.readFileSync(queue, "utf8"), "[]");
});

test("plugin queue: failed final rename leaves pending requests that a same-version retry reconciles", async () => {
  const root = installRoot(["0.3.6"]);
  const hermes = pluginHermes(root, [["default", "0.3.5"], ["research", "0.3.6"]]);
  const queue = path.join(root, "shared", "data", "restart-queue.json");
  const status = path.join(root, "shared", "data", "update-status.json");
  const other = { profile: "other", reason: "plugin 0.3.5", since: "earlier" };
  fs.writeFileSync(queue, JSON.stringify([other]));
  const f = fakes({ root, env: { HERMES_ROOT: hermes } });
  let writes = 0;
  f.deps.fs = { ...fs, renameSync: (from, to) => {
    if (to === queue && ++writes === 2) throw new Error("final queue rename denied");
    return fs.renameSync(from, to);
  } };
  const args = ["plugin", "--root", root, "--restart-queue", queue, "--status-file", status];
  assert.strictEqual(await U.main(args, f.deps), 1);
  assert.strictEqual(readStatus(status).state, "plugin-failed");
  assert.strictEqual(readStatus(path.join(hermes, "hermes-deck", "installed.json")).version, "0.3.6");
  const pending = readStatus(queue);
  assert.deepStrictEqual(pending, [other, { profile: "default", reason: "plugin 0.3.6", since: new Date(f.deps.now()).toISOString(), pending: true, target: "0.3.6" }]);
  assert.strictEqual(await U.main(args, f.deps), 0, f.logs.join("\n"));
  assert.deepStrictEqual(readStatus(queue), [other, { ...pending[1], pending: false }]);
  assert.strictEqual(readStatus(status).state, "done");
});

test("plugin queue: unchanged profiles lose only this attempt's pending requests", async () => {
  const root = installRoot(["0.3.6"]);
  const hermes = pluginHermes(root, [["default", "0.3.5"], ["research", "0.3.6"]]);
  const queue = path.join(root, "shared", "data", "restart-queue.json");
  const leftover = { profile: "research", reason: "old reason", since: "earlier", pending: true, target: "0.3.6" };
  fs.writeFileSync(queue, JSON.stringify([leftover]));
  const f = fakes({ root, env: { HERMES_ROOT: hermes } });
  f.deps.run = async (_cmd, args) => {
    if (!args.includes("--dry-run")) {
      assert.deepStrictEqual(readStatus(queue).map((x) => [x.profile, x.pending]), [["research", false], ["default", true]]);
    }
    return { code: 0, out: "no version change" };
  };
  assert.strictEqual(await U.main(["plugin", "--root", root, "--restart-queue", queue], f.deps), 0, f.logs.join("\n"));
  assert.deepStrictEqual(readStatus(queue), [{ ...leftover, pending: false, reason: "plugin 0.3.6" }]);
});

test("plugin queue: unreadable manifest skips the pre-write and queues the installed version", async () => {
  const root = installRoot(["0.3.6"]);
  const hermes = pluginHermes(root, [["default", "0.3.5"]]);
  const queue = path.join(root, "shared", "data", "restart-queue.json");
  const f = fakes({ root, env: { HERMES_ROOT: hermes } });
  let writes = 0;
  f.deps.fs = { ...fs, readFileSync: (file, ...args) => {
    if (String(file).endsWith("plugin.yaml")) throw new Error("manifest unavailable");
    return fs.readFileSync(file, ...args);
  }, renameSync: (from, to) => {
    if (to === queue) {
      writes++;
      assert.strictEqual(readStatus(path.join(hermes, "hermes-deck", "installed.json")).version, "0.3.6");
    }
    return fs.renameSync(from, to);
  } };
  assert.strictEqual(await U.main(["plugin", "--root", root, "--restart-queue", queue], f.deps), 0, f.logs.join("\n"));
  assert.strictEqual(writes, 1);
  assert.strictEqual(readStatus(queue)[0].reason, "plugin 0.3.6");
  assert.strictEqual(readStatus(queue)[0].pending, false);
});

for (const phase of ["dry-run", "install"]) {
  test(`plugin queue merges concurrent additions and removals during ${phase}`, async () => {
    const root = installRoot(["1.3.0"]);
    const hermes = pluginHermes(root, [["default", "1.2.0"]]);
    const queue = path.join(root, "shared", "data", "restart-queue.json");
    const removed = { profile: "removed", since: "old" };
    const added = { profile: "added", since: "new", pending: true };
    fs.writeFileSync(queue, JSON.stringify([removed]));
    const f = fakes({ root, env: { HERMES_ROOT: hermes } });
    const run = f.deps.run;
    f.deps.run = async (cmd, args, opts) => {
      if (args.includes("--dry-run") === (phase === "dry-run")) {
        const { withQueue } = require("../src/queue-file");
        withQueue(queue, (q) => [...q.filter((x) => x.profile !== "removed"), added]);
      }
      return run(cmd, args, opts);
    };
    assert.strictEqual(await U.main(["plugin", "--root", root, "--restart-queue", queue], f.deps), 0, f.logs.join("\n"));
    const q = readStatus(queue);
    assert.ok(!q.some((x) => x.profile === "removed"), "must not resurrect a completed restart");
    assert.deepStrictEqual(q.find((x) => x.profile === "added"), added);
    assert.strictEqual(q.find((x) => x.profile === "default").pending, false);
  });
}

for (const changed of [false, true]) {
  test(`plugin finalization preserves a replacement generation when the version ${changed ? "changes" : "does not change"}`, async () => {
    const root = installRoot(["1.3.0"]);
    const hermes = pluginHermes(root, [["default", "1.2.0"]]);
    const queue = path.join(root, "shared", "data", "restart-queue.json");
    const replacement = { profile: "default", since: "newer-generation", target: "1.4.0", pending: true };
    const f = fakes({ root, env: { HERMES_ROOT: hermes } });
    const run = f.deps.run;
    f.deps.run = async (cmd, args, opts) => {
      if (args.includes("--dry-run")) return run(cmd, args, opts);
      const { withQueue } = require("../src/queue-file");
      withQueue(queue, () => [replacement]);
      return changed ? run(cmd, args, opts) : { code: 0, out: "unchanged" };
    };
    assert.strictEqual(await U.main(["plugin", "--root", root, "--restart-queue", queue], f.deps), 0, f.logs.join("\n"));
    assert.deepStrictEqual(readStatus(queue), [replacement]);
  });
}

test("plugin reconciliation only changes this run's profiles and uses the locked current queue", async () => {
  const root = installRoot(["1.3.0"]);
  const hermes = pluginHermes(root, [["default", "1.3.0"], ["excluded", "1.4.0"]]);
  const queue = path.join(root, "shared", "data", "restart-queue.json");
  const unrelated = { profile: "excluded", since: "old", target: "1.4.0", pending: true };
  const own = { profile: "default", since: "own", target: "1.3.0", pending: true };
  fs.writeFileSync(queue, JSON.stringify([unrelated, own]));
  const f = fakes({ root, env: { HERMES_ROOT: hermes } });
  let locks = 0;
  f.deps.fs = { ...fs, openSync: (file, flags, ...args) => {
    const fd = fs.openSync(file, flags, ...args);
    if (file === `${queue}.lock` && flags === "wx") locks++;
    return fd;
  } };
  assert.strictEqual(await U.main(["plugin", "--root", root, "--restart-queue", queue, "--no-downgrade"], f.deps), 0, f.logs.join("\n"));
  assert.ok(locks >= 2, "queue mutations must acquire the shared lock");
  assert.deepStrictEqual(readStatus(queue), [unrelated, { ...own, pending: false, reason: "plugin 1.3.0" }]);
});

for (const mixed of [false, true]) {
  test(`plugin --no-downgrade excludes newer profiles (${mixed ? "mixed versions" : "all newer"})`, async () => {
    const root = installRoot(["1.3.0"]);
    const hermes = pluginHermes(root, [["research", "1.4.0"], ...(mixed ? [["default", "1.2.0"]] : [])]);
    const queue = path.join(root, "shared", "data", "restart-queue.json");
    const f = fakes({ root, env: { HERMES_ROOT: hermes } });
    assert.strictEqual(await U.main(["plugin", "--root", root, "--no-downgrade", "--restart-queue", queue], f.deps), 0, f.logs.join("\n"));
    assert.ok(f.calls.every((c) => !c.includes("--profile research")));
    assert.strictEqual(readStatus(path.join(hermes, "profiles", "research", "hermes-deck", "installed.json")).version, "1.4.0");
    assert.strictEqual(f.logs.filter((line) => /research.*1\.4\.0.*1\.3\.0/.test(line)).length, 1);
    if (mixed) {
      assert.strictEqual(readStatus(path.join(hermes, "hermes-deck", "installed.json")).version, "1.3.0");
      assert.deepStrictEqual(readStatus(queue).map((q) => q.profile), ["default"]);
    } else assert.deepStrictEqual(f.calls, [], "no installer is needed when every profile is newer");
  });
}

test("apply --no-downgrade forwards the guard to the plugin installer", async () => {
  const root = installRoot(["1.2.0"]);
  const hermes = pluginHermes(root, [["research", "1.4.0"], ["default", "1.2.0"]]);
  const f = fakes({ root, latest: "1.3.0", env: { HERMES_ROOT: hermes } });
  assert.strictEqual(await U.main(["apply", "--root", root, "--version", "1.3.0", "--no-downgrade", "--with-plugin"], f.deps), 0, f.logs.join("\n"));
  assert.ok(f.calls.every((c) => !c.includes("--profile research")));
  assert.strictEqual(readStatus(path.join(hermes, "profiles", "research", "hermes-deck", "installed.json")).version, "1.4.0");
});

test("plugin --no-downgrade refuses an unknown target before running the installer", async () => {
  const root = installRoot(["1.3.0"]);
  const hermes = pluginHermes(root, [["default", "1.4.0"]]);
  fs.writeFileSync(path.join(root, "current", "hermes-plugin", "hermes-deck", "plugin.yaml"), "name: hermes-deck\n");
  const f = fakes({ root, env: { HERMES_ROOT: hermes } });
  assert.strictEqual(await U.main(["plugin", "--root", root, "--no-downgrade"], f.deps), 1);
  assert.deepStrictEqual(f.calls, []);
  assert.strictEqual(readStatus(path.join(hermes, "hermes-deck", "installed.json")).version, "1.4.0");
});

test("a desktop key in the old release survives migration and the release switch", async () => {
  const devtokens = require("../src/devtokens");
  const root = installRoot(["1.2.0"]);
  const token = devtokens.add(path.join(root, "current", "relay", "devices.json"), "fixture-pc");
  const f = fakes({ root, latest: "1.3.0" });
  assert.strictEqual(await U.main(["apply", "--root", root, "--version", "1.3.0"], f.deps), 0, f.logs.join("\n"));
  const devices = path.join(root, "current", "relay", "devices.json");
  const shared = path.join(root, "shared", "devices.json");
  assert.strictEqual(fs.readlinkSync(devices), shared);
  assert.strictEqual(devtokens.match(devices, token), "fixture-pc");
  assert.strictEqual(devtokens.match(shared, token), "fixture-pc");
  if (process.platform !== "win32") assert.strictEqual(fs.statSync(shared).mode & 0o777, 0o600);
});

for (const existing of [false, true]) {
  test(`apply prepares shared keys before self-check and preserves ${existing ? "an existing shared store" : "legacy release keys"}`, async () => {
    const devtokens = require("../src/devtokens");
    const root = installRoot(["1.2.0"]);
    const legacy = path.join(root, "current", "relay", "devices.json");
    const shared = path.join(root, "shared", "devices.json");
    const token = devtokens.add(existing ? shared : legacy, "fixture-pc");
    if (existing) devtokens.add(legacy, "legacy-pc");
    const f = fakes({ root, latest: "1.3.0" });
    const run = f.deps.run;
    let checked = false;
    f.deps.run = async (cmd, args, opts) => {
      if (args.includes("--self-check")) {
        checked = true;
        return { code: 1, out: "stop before platform-specific release switch" };
      }
      return run(cmd, args, opts);
    };
    assert.strictEqual(await U.main(["apply", "--root", root, "--version", "1.3.0"], f.deps), 1);
    assert.strictEqual(checked, true);
    const devices = path.join(root, "releases", "1.3.0", "relay", "devices.json");
    assert.strictEqual(devtokens.match(devices, token), "fixture-pc");
    assert.strictEqual(fs.readlinkSync(devices), shared);
    assert.deepStrictEqual(devtokens.list(shared).map((d) => d.name), ["fixture-pc"]);
    if (process.platform !== "win32") assert.strictEqual(fs.statSync(shared).mode & 0o777, 0o600);
    assert.strictEqual(devtokens.match(shared, token), "fixture-pc");
    assert.strictEqual(current(root), path.join("releases", "1.2.0"));
  });
}

for (const hasKey of [false, true]) {
  test(`init shares the desktop key store (${hasKey ? "existing key" : "missing store fallback"})`, async () => {
    const devtokens = require("../src/devtokens");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-init-keys-"));
    const checkout = path.join(dir, "checkout");
    fs.mkdirSync(path.join(checkout, "relay"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "relay", "package.json"), JSON.stringify({ version: "1.3.0" }));
    const token = hasKey ? devtokens.add(path.join(checkout, "relay", "devices.json"), "fixture-pc") : null;
    const root = path.join(dir, "deck");
    const f = fakes();
    await U.init(f.deps, { root, checkout });
    const shared = path.join(root, "shared", "devices.json");
    const devices = path.join(root, "current", "relay", "devices.json");
    assert.strictEqual(fs.readlinkSync(devices), shared);
    if (hasKey) assert.strictEqual(devtokens.match(devices, token), "fixture-pc");
    else assert.deepStrictEqual(readStatus(shared), { v: 1, devices: {} });
    if (process.platform !== "win32") assert.strictEqual(fs.statSync(shared).mode & 0o777, 0o600);
  });
}

test("a GitHub token in the relay's .env reaches the API when the process has none", async () => {
  const root = installRoot(["0.3.5"]);
  fs.appendFileSync(path.join(root, "shared", ".env"), "GH_TOKEN=fixture-token-from-env-file\n");
  const f = fakes({ root });
  const seen = [];
  const fetch = f.deps.fetch;
  f.deps.fetch = async (url, opts = {}) => { if (url.includes("api.github.com")) seen.push((opts.headers || {}).authorization || null); return fetch(url, opts); };
  assert.strictEqual(await U.main(["--check", "--root", root], f.deps), 10, f.logs.join("\n"));
  assert.ok(seen.length > 0 && seen.every((h) => h === "Bearer fixture-token-from-env-file"), JSON.stringify(seen));
  const g = fakes({ root, env: { GH_TOKEN: "fixture-token-from-process" } });
  const seen2 = [];
  const fetch2 = g.deps.fetch;
  g.deps.fetch = async (url, opts = {}) => { if (url.includes("api.github.com")) seen2.push((opts.headers || {}).authorization || null); return fetch2(url, opts); };
  await U.main(["--check", "--root", root], g.deps);
  assert.ok(seen2.every((h) => h === "Bearer fixture-token-from-process"), "the process token wins");
});

test("withToken never adds a token when neither the process nor the .env has one", () => {
  const deps = { env: { PATH: "/bin" } };
  assert.strictEqual(U.withToken(deps, {}), deps);
});
