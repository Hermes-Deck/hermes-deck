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

test("process runner passes explicit source metadata to the actual child process", async () => {
  const env = { ...process.env, DECK_UPDATE_CHANNEL: "test", DECK_SOURCE_COMMIT: "b".repeat(40), DECK_RELEASE_TAG: "" };
  const r = await run(process.execPath, ["-e", "process.stdout.write(JSON.stringify([process.env.DECK_UPDATE_CHANNEL,process.env.DECK_SOURCE_COMMIT,process.env.DECK_RELEASE_TAG]))"], { env });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), ["test", "b".repeat(40), ""]);
});

test("source metadata validates the pinned SHA and records Test branch in a real detached checkout", () => {
  const { execFileSync } = require("node:child_process");
  const { releaseInfo } = require("../scripts/build-info");
  const repo = path.join(work, "metadata-repo");
  fs.mkdirSync(path.join(repo, "app", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(repo, "app", "main"));
  for (const file of ["scripts/build-info.js", "main/update-check.js", "main/updates.js", "package.json"]) {
    fs.copyFileSync(path.join(__dirname, "..", file), path.join(repo, "app", file));
  }
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  git("add", "app");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "metadata fixture");
  git("remote", "add", "origin", "https://github.com/Hermes-Deck/hermes-deck.git");
  const sha = git("rev-parse", "HEAD");
  git("-c", "core.hooksPath=/dev/null", "checkout", "--detach", sha);
  const env = { ...process.env, DECK_UPDATE_CHANNEL: "test", DECK_SOURCE_COMMIT: sha, DECK_RELEASE_TAG: "" };
  execFileSync(process.execPath, [path.join(repo, "app", "scripts", "build-info.js")], { env });
  const info = JSON.parse(fs.readFileSync(path.join(repo, "app", "main", "build-info.json"), "utf8"));
  assert.equal(info.commit, sha);
  assert.equal(info.branch, "test/desktop-fixes");
  assert.equal(info.channel, "test");
  assert.equal(info.releaseTag, "");
  assert.equal(info.repo, "Hermes-Deck/hermes-deck");
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
  assert.deepEqual(releaseInfo(env, "1.0.0", sha), { channel: "test", releaseTag: "", branch: "test/desktop-fixes" });
  for (const bad of [{ DECK_SOURCE_COMMIT: "short" }, { DECK_SOURCE_COMMIT: "f".repeat(40) }, { DECK_UPDATE_CHANNEL: "" }, { DECK_RELEASE_TAG: "v1.0.0-test.1" }]) {
    assert.throws(() => releaseInfo({ ...env, ...bad }, "1.0.0", sha));
  }
});

test("source native confirmation names the exact SHA/channel, cancels by default and rejects settings drift", async () => {
  const settings = new Settings();
  settings.data.updates = { channel: "test", fromSource: true, auto: false, host: false };
  const handlers = {};
  const { checker } = initUpdates({ ipc: { handle: (name, fn) => { handlers[name] = fn; } }, settings, send() {}, notify() {}, quit() { throw new Error("must not quit"); }, shot: true });
  checker.platform = "win32"; checker.arch = "x64"; checker.installSupported = true;
  const sha = "b".repeat(40), target = JSON.stringify(["test", "build", sha]);
  checker.status = { ...checker.base(), action: "build", head: sha, target };
  checker.run = async () => { throw new Error("must not run"); };
  answer = 0;
  prompts = [];
  assert.equal((await handlers["updates:install"]({}, target)).cancelled, true);
  assert.ok(prompts[0].message.includes(sha));
  assert.match(prompts[0].message, /Test/);
  assert.equal(prompts[0].defaultId, 0);
  const show = electron.dialog.showMessageBox;
  electron.dialog.showMessageBox = async () => {
    assert.equal(handlers["updates:channel"]({}, "stable").error, "updates.busy");
    settings.data.updates.fromSource = false;
    return { response: 1 };
  };
  try { assert.equal((await handlers["updates:install"]({}, target)).error, "updates.changed"); }
  finally { electron.dialog.showMessageBox = show; }
});

test("F2: automatic source Test check never notifies an older package even with action none", async () => {
  const timers = [], notices = [];
  const timeout = global.setTimeout, interval = global.setInterval;
  let checker;
  try {
    global.setTimeout = fn => { timers.push(fn); };
    global.setInterval = () => ({ unref() {} });
    ({ checker } = initUpdates({ ipc: { handle() {} }, settings: { data: { updates: { channel: "test", auto: true } } },
      send() {}, notify: (...args) => notices.push(args), quit() {} }));
  } finally { global.setTimeout = timeout; global.setInterval = interval; }
  const sha = "b".repeat(40);
  checker.info = { channel: "test", commit: sha, releaseTag: "" };
  checker.platform = "win32"; checker.arch = "x64"; checker.installSupported = false;
  checker._compare = async () => ({ head: sha, ahead_by: 0, behind_by: 0, commits: [] });
  checker._release = async () => ({ id: 1, tag_name: "v1.0.0-test.1", assets: [{ id: 2, name: "Hermes-Deck-1.0.0-Setup.exe" }, { id: 3, name: "SHA256SUMS.txt" }] });
  await timers[0]();
  assert.equal(checker.status.action, "none");
  assert.deepEqual(notices, []);
});

test("release metadata identifies Test packages without changing the product version", () => {
  const { releaseInfo } = require("../scripts/build-info");
  assert.deepEqual(releaseInfo({}, "1.0.0"), { channel: "stable", releaseTag: "" });
  assert.deepEqual(releaseInfo({ DECK_RELEASE_TAG: "v1.0.0-test.2" }, "1.0.0"), { channel: "test", releaseTag: "v1.0.0-test.2" });
  assert.throws(() => releaseInfo({ DECK_RELEASE_TAG: "v2.0.0-test.1" }, "1.0.0"));
  assert.throws(() => releaseInfo({ DECK_RELEASE_TAG: "v1.0.0-test.2", DECK_UPDATE_CHANNEL: "stable" }, "1.0.0"));
  assert.throws(() => releaseInfo({ DECK_RELEASE_TAG: "../main" }, "1.0.0"));
});
