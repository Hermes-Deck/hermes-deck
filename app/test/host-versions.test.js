"use strict";
// Host versions (main/host-versions.js): relay / plugin older than the app (both sources), protocol mismatch,
// one notification per drift across reconnects and restarts; the Settings lines and banner (renderer/settings-view.js);
// the direct connection's deck.version (main/bridge.js) against fake-stream.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { HostVersions, relayInfo, pluginRows, PROTOCOL, RELAY_CMD, PLUGIN_CMD } = require("../main/host-versions");
const SV = require("../renderer/settings-view");
const { BridgeClient } = require("../main/bridge");

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deck-hostver-")), "host-versions.json");
const ROOT = path.join(__dirname, "..", "..");

test("the app's protocol and update commands match compat.json and docs/updating.md", () => {
  const compat = JSON.parse(fs.readFileSync(path.join(ROOT, "compat.json"), "utf8"));
  assert.equal(PROTOCOL, compat.protocol);
  const doc = fs.readFileSync(path.join(ROOT, "docs", "updating.md"), "utf8");
  assert.ok(doc.includes(RELAY_CMD), "docs/updating.md gives the relay command");
  assert.ok(doc.includes(PLUGIN_CMD), "docs/updating.md gives the plugin command");
});

test("relay drift: older, same, newer, old relays without protocol, junk", () => {
  assert.deepEqual(relayInfo({ v: "0.3.2", protocol: 1 }, "0.3.6"), { version: "0.3.2", protocol: 1, older: true, mismatch: false });
  assert.equal(relayInfo({ v: "0.3.6", protocol: 1 }, "0.3.6").older, false);
  assert.equal(relayInfo({ v: "0.4.0", protocol: 1 }, "0.3.6").older, false, "a newer relay is the existing 'new app available' notice");
  assert.deepEqual(relayInfo({ v: "0.3.2" }, "0.3.6"), { version: "0.3.2", protocol: null, older: true, mismatch: false }, "relays before 0.3.6 send no protocol: never a mismatch");
  assert.equal(relayInfo({ v: "1.0.0", protocol: 2 }, "1.0.0").mismatch, true);
  assert.equal(relayInfo({ v: "<b>" }, "0.3.6"), null);
  assert.equal(relayInfo(null, "0.3.6"), null);
});

test("plugin drift: per profile from the relay, and the direct connection (incl. a legacy plugin)", () => {
  const rows = pluginRows({ research: "0.3.5", default: "0.3.6", plain: null, "bad name": "0.1.0", junk: "x" }, null, "0.3.6");
  assert.deepEqual(rows.map((r) => [r.profile, r.version, r.older]), [["default", "0.3.6", false], ["junk", null, false], ["plain", null, false], ["research", "0.3.5", true]]);
  const [bridge] = pluginRows(null, { legacy: true }, "0.3.6");
  assert.deepEqual([bridge.source, bridge.older, bridge.legacy, bridge.mismatch], ["bridge", true, true, false]);
  assert.equal(pluginRows(null, { version: "0.3.6", protocol: 1 }, "0.3.6")[0].older, false);
  assert.equal(pluginRows(null, { version: "0.3.6", protocol: 2 }, "0.3.6")[0].mismatch, true);
});

test("one notification per drift, across reconnects and restarts; a newer drift tells again", () => {
  const file = tmpFile();
  const told = [];
  const notify = (key, vars, section) => { told.push([key, section, vars]); return true; };
  const states = [];
  let hv = new HostVersions({ app: "0.3.6", file, notify, onChange: (s) => states.push(s) });
  const hello = { t: "hello", v: "0.3.2", protocol: 1, plugins: { default: "0.3.6", research: "0.3.5", plain: null } };
  assert.equal(hv.relayHello(hello), true, "version drift never blocks");
  assert.deepEqual(told.map(([k, s]) => [k, s]), [["hostupd.relayOlderToast", "relay"], ["hostupd.pluginOlderToast", "hermes"]]);
  assert.deepEqual(told[1][2], { profile: "research", plugin: "0.3.5", app: "0.3.6" });
  for (let i = 0; i < 3; i++) hv.relayHello(hello); // reconnects
  assert.equal(told.length, 2);
  hv = new HostVersions({ app: "0.3.6", file, notify }); // app restart
  hv.relayHello(hello);
  assert.equal(told.length, 2, "persisted");
  hv.relayHello({ ...hello, v: "0.3.4" }); // a different (still older) relay: a new drift
  assert.equal(told.length, 3);
  // a notification that was not shown (notifications off) is not marked as told
  const quiet = new HostVersions({ app: "0.3.6", file: tmpFile(), notify: () => false });
  quiet.relayHello(hello);
  assert.equal(quiet.notified.size, 0);
  // the renderer's state: drift both ways is visible, nothing blocks
  const st = states.at(-1);
  assert.equal(st.relay.older, true);
  assert.deepEqual(st.blocked, { relay: false, bridge: false });
  assert.deepEqual(st.commands, { relay: RELAY_CMD, plugin: PLUGIN_CMD });
});

test("a protocol mismatch blocks only that connection and is told once", () => {
  const told = [];
  const hv = new HostVersions({ app: "1.0.0", file: tmpFile(), notify: (k) => { told.push(k); return true; } });
  assert.equal(hv.relayHello({ v: "1.0.0", protocol: 2, plugins: {} }), false);
  assert.equal(hv.relayHello({ v: "1.0.0", protocol: 2, plugins: {} }), false);
  assert.deepEqual(told, ["hostupd.protocolRelay"]);
  assert.deepEqual(hv.state().blocked, { relay: true, bridge: false });
  assert.equal(hv.bridgeVersion({ version: "1.0.0", protocol: 1 }), true, "the direct connection is unaffected");
  assert.equal(hv.bridgeVersion({ version: "1.0.0", protocol: 3 }), false);
  assert.deepEqual(hv.state().blocked, { relay: true, bridge: true });
  hv.relayGone();
  hv.bridgeVersion(null);
  assert.deepEqual(hv.state().blocked, { relay: false, bridge: false });
});

test("a legacy plugin on the direct connection is drift, never a block", () => {
  const told = [];
  const hv = new HostVersions({ app: "0.3.6", file: tmpFile(), notify: (k, v) => { told.push([k, v.plugin]); return true; } });
  assert.equal(hv.bridgeVersion({ legacy: true }), true);
  assert.deepEqual(told, [["hostupd.bridgeOlderToast", "< 0.3.6"]]);
  hv.bridgeVersion({ legacy: true });
  assert.equal(told.length, 1);
});

test("Settings lines and the banner", () => {
  const hv = new HostVersions({ app: "0.3.6", file: tmpFile() });
  hv.relayHello({ v: "0.3.2", protocol: 1, plugins: { default: "0.3.6", research: "0.3.5", plain: null } });
  hv.bridgeVersion({ legacy: true });
  const relay = SV.hostLines(hv.state(), "relay");
  assert.deepEqual(relay.map((l) => [l.key, l.level, l.cmd]), [["hostupd.relayOlder", "warn", RELAY_CMD]]);
  assert.deepEqual(relay[0].vars, { relay: "0.3.2", app: "0.3.6" });
  const hermes = SV.hostLines(hv.state(), "hermes");
  assert.deepEqual(hermes.map((l) => [l.key, l.level]), [
    ["hostupd.pluginVersion", "ok"], ["hostupd.pluginUnknown", "info"], ["hostupd.pluginOlder", "warn"], ["hostupd.bridgeLegacy", "warn"]]);
  assert.ok(hermes.filter((l) => l.level === "warn").every((l) => l.cmd === PLUGIN_CMD));
  assert.deepEqual(SV.hostBanners(hv.state()), [], "drift alone shows no banner");
  hv.relayHello({ v: "0.3.6", protocol: 2, plugins: {} });
  assert.deepEqual(SV.hostBanners(hv.state()), ["hostupd.bannerRelay"]);
  assert.equal(SV.hostLines(hv.state(), "relay")[0].level, "block");
  assert.deepEqual(SV.hostLines(null, "relay"), []);
  // every key the view uses exists in both languages
  const i18n = require("../renderer/i18n");
  for (const key of ["hostupd.title", "hostupd.group", "hostupd.runOnHost", "hostupd.howTo", "hostupd.relayVersion", "hostupd.relayOlder", "hostupd.relayOlderToast",
    "hostupd.pluginVersion", "hostupd.pluginUnknown", "hostupd.pluginOlder", "hostupd.pluginOlderToast", "hostupd.bridgeVersion", "hostupd.bridgeOlder",
    "hostupd.bridgeLegacy", "hostupd.bridgeOlderToast", "hostupd.protocolRelay", "hostupd.protocolBridge", "hostupd.protocolRelayShort",
    "hostupd.protocolBridgeShort", "hostupd.bannerRelay", "hostupd.bannerBridge"]) {
    assert.equal(typeof i18n.tables.en[key], "string", key);
    assert.equal(typeof i18n.tables.tr[key], "string", key);
  }
});

const FAKE = path.join(__dirname, "fake-stream.js");
const CFG = { mode: "ssh", target: "hermes-test", python: "/usr/bin/python3", stream: "/home/user/.hermes/hermes-deck/stream.py" };
const FAST = { request: 1500, write: 1000, handshake: 1500, heartbeat: 1200, kill: 500, backoffMin: 40, backoffMax: 160, keepalive: 60000 };
async function versionOf(t, flags) {
  const c = new BridgeClient(CFG, { launch: { file: process.execPath, args: [FAKE, "--serve", ...flags] }, timing: FAST });
  t.after(() => c.stop());
  await new Promise((resolve) => { c.on("status", (s) => s.status === "open" && resolve()); c.start(); });
  return c.version();
}

test("deck.version over the direct connection: a 0.3.6+ plugin answers, an older one is legacy", async (t) => {
  assert.deepEqual(await versionOf(t, ["--plugin-version", "0.3.6"]), { version: "0.3.6", protocol: 1 });
  assert.deepEqual(await versionOf(t, ["--plugin-version", "0.3.6:2"]), { version: "0.3.6", protocol: 2 });
  assert.deepEqual(await versionOf(t, []), { legacy: true });
});

test("hostUpdate from the hello and from relay pushes reaches state().update; a lost relay clears it", () => {
  const states = [];
  const hv = new HostVersions({ app: "1.3.0", onChange: (s) => states.push(s) });
  const info = { remote: { enabled: true, managed: true }, status: { version: "1.3.0", step: "download", state: "running" }, restarts: [], queueError: null };
  hv.relayHello({ t: "hello", v: "1.2.0", protocol: 1, plugins: {}, hostUpdate: info });
  assert.deepEqual(hv.state().update, info);
  hv.hostUpdate({ t: "hostUpdate", ...info, status: { ...info.status, step: "done", state: "done" } });
  assert.equal(states.at(-1).update.status.state, "done");
  hv.relayHello({ t: "hello", v: "1.2.0", protocol: 1, plugins: {} });
  assert.equal(hv.state().update, null, "a relay without host updates reports none");
  hv.hostUpdate(info);
  hv.relayGone();
  assert.equal(hv.state().update, null);
});

test("a hostUpdate push refreshes the profiles' plugin versions and tells a 2-hour restart wait once", () => {
  const told = [];
  const hv = new HostVersions({ app: "1.3.0", file: tmpFile(), notify: (key, vars, section) => { told.push([key, vars.profile, section]); return true; } });
  hv.relayHello({ t: "hello", v: "1.3.0", protocol: 1, plugins: { default: "1.2.0" }, hostUpdate: { remote: { enabled: true, managed: true }, status: null, restarts: [] } });
  assert.equal(hv.state().plugins.find((p) => p.profile === "default").older, true);
  hv.hostUpdate({ remote: { enabled: true, managed: true }, status: { version: "1.3.0", step: "done", state: "done" }, restarts: [], plugins: { default: "1.3.0" } });
  assert.equal(hv.state().plugins.find((p) => p.profile === "default").older, false, "a finished plugin step shows without a new hello");
  const wait = { remote: { enabled: true, managed: true }, status: null, restarts: [{ profile: "default", state: "busy", since: "2026-10-09T01:00:00Z", longWait: true }], plugins: { default: "1.3.0" } };
  hv.hostUpdate(wait);
  hv.hostUpdate(wait);
  assert.deepEqual(told.filter(([k]) => k === "hostupd.row.longWait"), [["hostupd.row.longWait", "default", "hermes"]]);
});
