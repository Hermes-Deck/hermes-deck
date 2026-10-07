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
      return { code: 0, out: `${cmd} ok` };
    },
  };
  return { deps, calls, logs, fetched, running: () => running };
}

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
  assert.deepStrictEqual(fs.readdirSync(path.join(root, "shared")).sort(), [".env", "agents.json", "data"], "shared state untouched");
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
  assert.match(f.logs.join("\n"), /hermes -p research gateway restart/, "the restart command is printed instead");
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
