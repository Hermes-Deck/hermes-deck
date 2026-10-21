"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "deck-update-service-"));
let answer = 0, prompts = [], opened = [];
const electron = {
  app: { getPath: () => work, getVersion: () => "1.0.0", isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: { showMessageBox: async options => { prompts.push(options); return { response: answer }; } },
  shell: { openExternal: url => opened.push(url), showItemInFolder() {} },
};
const load = Module._load;
Module._load = function (name, ...rest) { return name === "electron" ? electron : load.call(this, name, ...rest); };
const { initUpdates, windowsInstallSupported, run } = require("../main/update-service");
const { Settings } = require("../main/settings");
Module._load = load;
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

test("real settings + IPC service: channel persists alone, check is separate, native consent pins install", async () => {
  const settings = new Settings();
  settings.data.updates.auto = false;
  settings.data.updates.host = false;
  settings.update({ language: "tr" }); // persist a synthetic profile, no live connections
  const before = JSON.parse(fs.readFileSync(settings.file, "utf8"));
  const handlers = {}, events = [];
  const { checker } = initUpdates({ ipc: { handle: (name, fn) => { handlers[name] = fn; } }, settings, send: (...args) => events.push(args), notify() {}, quit() {}, shot: true });
  let network = 0, installs = [];
  checker.fetch = async () => { network++; throw new Error("network must not be used on channel selection"); };
  assert.equal(handlers["updates:status"]().status.channel, "stable");
  assert.equal(handlers["updates:channel"]({}, "other").error, "updates.badChannel");
  assert.equal(handlers["updates:channel"]({}, "test").status.channel, "test");
  assert.equal(network, 0);
  const after = JSON.parse(fs.readFileSync(settings.file, "utf8"));
  after.updates.channel = before.updates.channel;
  assert.deepEqual(after, before, "no other setting or host changes");
  const loaded = new Settings().load();
  assert.equal(loaded.publicView().updates.channel, "test");
  assert.equal(loaded.publicView().updates.host, false);
  assert.throws(() => loaded.update({ updates: { channel: "main" } }));
  assert.equal(handlers["updates:status"]().status.unchecked, true);
  const target = "synthetic checked target";
  checker.status = { ...checker.base(), action: "release", target, release: { tag: "v1.0.0-test.2" } };
  checker.install = async token => { installs.push(token); throw new Error("updates.badSum"); };
  prompts = [];
  const refused = await handlers["updates:install"]({}, "stale");
  assert.equal(refused.error, "updates.changed");
  assert.equal(prompts.length, 0);
  answer = 0;
  assert.equal((await handlers["updates:install"]({}, target)).cancelled, true);
  assert.equal(installs.length, 0);
  assert.equal(prompts[0].defaultId, 0);
  assert.match(prompts[0].message, /v1\.0\.0-test\.2/);
  assert.match(prompts[0].message, /Test/);
  answer = 1;
  assert.equal((await handlers["updates:install"]({}, target)).error, "updates.badSum");
  assert.deepEqual(installs, [target]);
  checker.busy = "install";
  assert.equal(handlers["updates:channel"]({}, "stable").error, "updates.busy");
  checker.busy = null;
  handlers["updates:channel"]({}, "stable");
  assert.equal(handlers["updates:status"]().status.unchecked, true);
  assert.equal(settings.data.updates.host, false);
  checker.status = { release: { url: "https://github.com/example/foreign/releases/tag/v1.0.0" } };
  handlers["updates:open"]();
  assert.deepEqual(opened, []);
});

test("channel save preserves unmigrated hosts and ciphertext byte-for-byte in the stored object", () => {
  const settings = new Settings();
  const raw = { hosts: [], activeHost: "", relay: { url: "wss://example.com", token: { enc: "c3ludGhldGlj" } }, updates: { auto: false, host: false } };
  fs.writeFileSync(settings.file, JSON.stringify(raw));
  settings.load();
  assert.equal(settings.data.hosts.length, 1, "existing migration is in memory, not persisted yet");
  settings.setUpdateChannel("test");
  const saved = JSON.parse(fs.readFileSync(settings.file, "utf8"));
  assert.deepEqual(saved, { ...raw, updates: { ...raw.updates, channel: "test" } });
  assert.equal(settings.data.updates.channel, "test");
  assert.throws(() => settings.setUpdateChannel("other"));
});

test("Windows installer guard refuses portable, custom profile and isolated Test destinations", () => {
  const local = "C:\\Users\\example\\AppData\\Local", roaming = "C:\\Users\\example\\AppData\\Roaming";
  const exe = `${local}\\Programs\\hermes-deck\\Hermes Deck.exe`, data = `${roaming}\\hermes-deck`;
  assert.equal(windowsInstallSupported(exe, data, local, roaming), true);
  assert.equal(windowsInstallSupported(exe.toUpperCase(), data, local, roaming), true);
  assert.equal(windowsInstallSupported(`${local}\\Programs\\hermes-deck-test\\Hermes Deck.exe`, data, local, roaming), false);
  assert.equal(windowsInstallSupported(exe, `${roaming}\\hermes-deck-test`, local, roaming), false);
  assert.equal(windowsInstallSupported(exe, data, "", roaming), false);
});

test("detached installer launch reports an executable that cannot start", async () => {
  const r = await run(path.join(work, "missing-installer"), [], { detached: true });
  assert.notEqual(r.code, 0);
});

test("release metadata identifies Test packages without changing the product version", () => {
  const { releaseInfo } = require("../scripts/build-info");
  assert.deepEqual(releaseInfo({}, "1.0.0"), { channel: "stable", releaseTag: "" });
  assert.deepEqual(releaseInfo({ DECK_RELEASE_TAG: "v1.0.0-test.2" }, "1.0.0"), { channel: "test", releaseTag: "v1.0.0-test.2" });
  assert.throws(() => releaseInfo({ DECK_RELEASE_TAG: "v2.0.0-test.1" }, "1.0.0"));
  assert.throws(() => releaseInfo({ DECK_RELEASE_TAG: "v1.0.0-test.2", DECK_UPDATE_CHANNEL: "stable" }, "1.0.0"));
  assert.throws(() => releaseInfo({ DECK_RELEASE_TAG: "../main" }, "1.0.0"));
});
