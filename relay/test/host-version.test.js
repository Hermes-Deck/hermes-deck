"use strict";
// The relay reports its host: /health and the WebSocket hello carry protocol + each profile's plugin version
// (from <home>/hermes-deck/installed.json) with `v` unchanged for old apps; mobile capabilities carry relayVersion;
// `node src/index.js --self-check` loads the configuration and exits without listening.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const WebSocket = require("ws");
const { start, selfCheck, config } = require("../src/index");
const compat = require("../src/compat");
const { MobileRelay } = require("../src/mobile");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "deck-hostver-"));

/** A Hermes root: default (plugin 0.3.6), research (plugin 0.3.5), plain (no plugin), one junk entry. */
function hermesRoot(dir) {
  const root = path.join(dir, ".hermes");
  const put = (home, version) => {
    fs.mkdirSync(path.join(home, "hermes-deck"), { recursive: true });
    fs.writeFileSync(path.join(home, "config.yaml"), "model: {}\n");
    if (version) fs.writeFileSync(path.join(home, "hermes-deck", "installed.json"), JSON.stringify({ version, protocol: 1, installedAt: "2026-10-07T00:00:00Z" }));
  };
  put(root, "0.3.6");
  put(path.join(root, "profiles", "research"), "0.3.5");
  put(path.join(root, "profiles", "plain"), null);
  fs.mkdirSync(path.join(root, "profiles", "not a profile"), { recursive: true });
  fs.mkdirSync(path.join(root, "profiles", "empty"), { recursive: true }); // no config.yaml/state.db: not a profile
  return root;
}

test("pluginVersions reads installed.json per profile; junk and bad versions are null or skipped", () => {
  const root = hermesRoot(tmpDir());
  assert.deepStrictEqual(compat.pluginVersions(root), { default: "0.3.6", plain: null, research: "0.3.5" });
  fs.writeFileSync(path.join(root, "profiles", "plain", "hermes-deck", "installed.json"), JSON.stringify({ version: "<b>" }));
  assert.strictEqual(compat.pluginVersions(root).plain, null);
  assert.deepStrictEqual(compat.pluginVersions(null), {});
  assert.deepStrictEqual(compat.pluginVersions(path.join(root, "missing")), {});
  let now = 0;
  const cached = compat.pluginCache(root, 1000, () => now);
  assert.strictEqual(cached().default, "0.3.6");
  fs.writeFileSync(path.join(root, "hermes-deck", "installed.json"), JSON.stringify({ version: "0.3.7" }));
  now = 500;
  assert.strictEqual(cached().default, "0.3.6", "cached within the ttl");
  now = 1000;
  assert.strictEqual(cached().default, "0.3.7");
});

test("updateStatus reads the updater's last check from the data dir", () => {
  const dir = tmpDir();
  assert.strictEqual(compat.updateStatus(dir), null);
  fs.writeFileSync(path.join(dir, "update-check.json"), JSON.stringify({ updateAvailable: true, latest: "v0.4.0", checkedAt: "2026-10-07T00:00:00Z" }));
  assert.deepStrictEqual(compat.updateStatus(dir), { available: true, latest: "0.4.0", checkedAt: "2026-10-07T00:00:00Z" });
  fs.writeFileSync(path.join(dir, "update-check.json"), JSON.stringify({ updateAvailable: true, latest: "junk" }));
  assert.strictEqual(compat.updateStatus(dir).available, false);
});

test("/health carries protocol but no profile names; hello carries plugins; v is unchanged", async (t) => {
  const dir = tmpDir();
  const root = hermesRoot(dir);
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, "update-check.json"), JSON.stringify({ updateAvailable: true, latest: "0.4.0", checkedAt: "2026-10-07T00:00:00Z" }));
  const cfg = {
    host: "127.0.0.1", port: 0, token: "t".repeat(32), eventsDir: path.join(dir, "events"), stateDir: path.join(dir, "state"), dataDir,
    claudeDirs: [], claudeProfile: "claude-code", claudeChatMap: null, launchdPrefixes: [], codexbar: null, agentsFile: path.join(dir, "agents.json"),
    broadcastWindowS: 300, tickMs: 100, hermesRoot: root, history: false,
  };
  const relay = await start(cfg);
  t.after(() => relay.stop());
  const health = await (await fetch(`http://127.0.0.1:${relay.port}/health`)).json();
  assert.strictEqual(health.ok, true);
  assert.strictEqual(health.v, require("../package.json").version);
  assert.strictEqual(health.protocol, compat.PROTOCOL);
  assert.strictEqual(health.plugins, undefined, "unauthenticated /health never lists profile names");
  assert.strictEqual(health.updateAvailable, true);
  assert.strictEqual(health.latest, "0.4.0");
  assert.strictEqual(Object.keys(health)[1], "v");
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/events`, { headers: { authorization: `Bearer ${cfg.token}` } });
  const hello = await new Promise((resolve, reject) => {
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      if (m.t === "hello") resolve(m);
    });
    ws.on("error", reject);
  });
  ws.terminate();
  assert.strictEqual(hello.v, health.v);
  assert.strictEqual(hello.protocol, compat.PROTOCOL);
  assert.deepStrictEqual(hello.plugins, { default: "0.3.6", plain: null, research: "0.3.5" });
  assert.strictEqual(typeof hello.now, "number");
});

test("mobile capabilities carry relayVersion and protocol", () => {
  const dir = tmpDir();
  const m = new MobileRelay({ tokensFile: path.join(dir, "mobile.json"), bridgeConfig: { mode: "off" } });
  try {
    const c = m.capabilities();
    assert.strictEqual(c.relayVersion, compat.VERSION);
    assert.strictEqual(c.protocol, compat.PROTOCOL);
    assert.strictEqual(c.v, 1);
  } finally {
    m.stop();
  }
});

test("--self-check loads a temp config, opens nothing for writing, and exits 0 without listening", () => {
  const dir = tmpDir();
  const root = hermesRoot(dir);
  const env = path.join(dir, ".env");
  fs.writeFileSync(env, `DECK_RELAY_TOKEN=${"x".repeat(32)}\nDECK_RELAY_PORT=1\nHERMES_ROOT=${root}\nDECK_AGENTS=${path.join(dir, "agents.json")}\nDECK_DATA_DIR=${path.join(dir, "data")}\n`);
  fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify({ profiles: {} }));
  const before = fs.readdirSync(dir).sort();
  const childEnv = { ...process.env, DECK_RELAY_ENV: env };
  for (const k of Object.keys(childEnv)) if (/^(DECK_|HERMES_ROOT$)/.test(k) && k !== "DECK_RELAY_ENV") delete childEnv[k];
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "src", "index.js"), "--self-check"], { env: childEnv, encoding: "utf8", timeout: 20000 });
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.version, compat.VERSION);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), before, "nothing written next to the config");
  // a bad config fails it
  assert.strictEqual(selfCheck({ ...config({}), token: "short", agentsFile: path.join(dir, "agents.json"), hermesRoot: null }).ok, false);
  fs.writeFileSync(path.join(dir, "bad.json"), "{");
  const bad = selfCheck({ ...config({ DECK_RELAY_TOKEN: "y".repeat(32) }), agentsFile: path.join(dir, "bad.json"), hermesRoot: null });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.problems[0], /bad\.json/);
});
