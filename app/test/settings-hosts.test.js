"use strict";
// Multi-host settings: migration from the single connection, per-host encrypted tokens, switching.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const repo = path.join(__dirname, "../..");
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(raw = { firstRunDone: true }, { secure = true, decryptFails = false, platform = "darwin" } = {}) {
  let saved, encryptionChecks = 0;
  const context = { module: { exports: {} }, Buffer, URL, process: { env: {} }, require(id) {
    if (id === "fs") return {
      readFileSync: () => JSON.stringify(raw), statSync: () => ({ size: 0 }),
      lstatSync: () => ({ isFile: () => true }), mkdirSync() {}, renameSync() {},
      writeFileSync: (_file, content) => { saved = JSON.parse(content); },
    };
    if (id === "os") return { homedir: () => "/fixture-home" };
    if (id === "path") return path;
    // "encryption" reverses the text, so a stored plain token is visible as a failure
    if (id === "electron") return { app: { getPath: () => "/fixture-profile" }, safeStorage: {
      isEncryptionAvailable: () => { encryptionChecks++; return secure; }, encryptString: v => Buffer.from([...v].reverse().join("")),
      decryptString: b => { if (decryptFails) throw new Error("fixture key unavailable"); return [...b.toString()].reverse().join(""); },
    } };
    if (id === "./envfile") return { loadEnvFile() {} };
    if (id === "./bridge") return { normalizeConfig: value => require("../main/bridge").normalizeConfig(value, platform) };
    return require(path.join(repo, "app/main", id));
  } };
  vm.runInNewContext(fs.readFileSync(path.join(repo, "app/main/settings.js"), "utf8"), context);
  return { settings: new context.module.exports.Settings().load(), saved: () => saved, encryptionChecks: () => encryptionChecks };
}
const enc = t => ({ enc: Buffer.from([...t].reverse().join("")).toString("base64") });
const TOKEN_A = "a".repeat(32), TOKEN_B = "b".repeat(32);

test("direct-only host validation is platform-aware and invalid adds are atomic", () => {
  for (const platform of ["darwin", "win32"]) {
    const { settings, encryptionChecks } = fixture(undefined, { platform });
    const validMode = platform === "win32" ? "wsl" : "local";
    const bridge = { mode: validMode, python: "python3", stream: "~/.hermes/hermes-deck/stream.py", target: "", distribution: "" };
    const before = JSON.stringify(settings.data);
    for (const bad of [{ ...bridge, mode: platform === "win32" ? "local" : "wsl" }, { ...bridge, mode: "ssh", target: "" }, { ...bridge, python: "" }, { ...bridge, stream: "relative.py" }]) {
      assert.throws(() => settings.addHost({ name: "Invalid", bridge: bad }));
      assert.equal(JSON.stringify(settings.data), before);
    }
    const id = settings.addHost({ name: "Direct only", bridge });
    assert.equal(settings.data.activeHost, id);
    assert.deepEqual(plain(settings.data.bridge), bridge);
    assert.equal(encryptionChecks(), 0);
  }
});

test("inactive host secrets still encrypt and warn; unreadable per-host ciphertext survives a preference save", () => {
  const hosts = [
    { id: "h1", name: "Local", relay: { url: "", token: "" }, bridge: { mode: "local" } },
    { id: "h2", name: "Remote", relay: { url: "ws://192.0.2.2:9330", token: enc(TOKEN_B) }, botscreen: { agents: [], deviceToken: enc(TOKEN_A) } },
  ];
  for (const secure of [true, false]) {
    const { settings, saved, encryptionChecks } = fixture({ firstRunDone: true, hosts, activeHost: "h1" }, { secure });
    assert.equal(settings.publicView().plainSecrets, !secure);
    settings.update({ language: "tr" });
    assert.ok(encryptionChecks() > 0, "inactive host needs storage security too");
    assert.deepEqual(saved().hosts[1].relay.token, secure ? enc(TOKEN_B) : { plain: TOKEN_B });
    assert.deepEqual(saved().hosts[1].botscreen.deviceToken, secure ? enc(TOKEN_A) : { plain: TOKEN_A });
    assert.ok(!JSON.stringify(settings.publicView()).includes(TOKEN_B));
  }
  const { settings, saved, encryptionChecks } = fixture({ firstRunDone: true, hosts, activeHost: "h1" }, { decryptFails: true });
  settings.update({ desktop: { notificationMode: "banner" } });
  assert.deepEqual(saved().hosts[1].relay.token, enc(TOKEN_B));
  assert.deepEqual(saved().hosts[1].botscreen.deviceToken, enc(TOKEN_A));
  assert.equal(encryptionChecks(), 0, "preserving sealed ciphertext needs no encryption probe");
  settings.selectHost("h2");
  assert.deepEqual(saved().relay.token, enc(TOKEN_B));
  assert.deepEqual(saved().botscreen.deviceToken, enc(TOKEN_A));
});

test("an existing single connection becomes the first host and keeps working", () => {
  const { settings } = fixture({ firstRunDone: true, relay: { url: "ws://192.0.2.10:9330", token: enc(TOKEN_A) } });
  const v = plain(settings.publicView());
  assert.deepEqual(v.hosts, [{ id: "h1", name: "Host 1", relay: { url: "ws://192.0.2.10:9330", hasToken: true }, bridge: { mode: "off" } }]);
  assert.equal(v.activeHost, "h1");
  assert.equal(settings.data.relay.token, TOKEN_A, "the legacy relay field is untouched");
});

test("a fresh install has no hosts", () => {
  assert.deepEqual(plain(fixture().settings.publicView().hosts), []);
});

test("every host token is encrypted on disk and never reaches the renderer", () => {
  const { settings, saved } = fixture({ firstRunDone: true, relay: { url: "ws://192.0.2.10:9330", token: enc(TOKEN_A) } });
  settings.addHost({ name: "Host B", relay: { url: "192.0.2.20", token: TOKEN_B } });
  const disk = JSON.stringify(saved());
  assert.ok(!disk.includes(TOKEN_A) && !disk.includes(TOKEN_B), "no plain token on disk");
  assert.ok(!JSON.stringify(settings.publicView()).includes(TOKEN_B), "no token in the renderer view");
  const again = fixture(saved()).settings;
  assert.equal(again.data.hosts.find(h => h.name === "Host B").relay.token, TOKEN_B, "it decrypts after a restart");
});

test("switching hosts swaps the live connection and keeps edits of the old one", () => {
  const { settings, saved } = fixture({ firstRunDone: true, relay: { url: "ws://192.0.2.10:9330", token: enc(TOKEN_A) } });
  const b = settings.addHost({ name: "Host B", relay: { url: "192.0.2.20", token: TOKEN_B } });
  assert.equal(settings.data.activeHost, "h1", "adding does not switch");
  settings.update({ relay: { url: "192.0.2.11" } }); // an edit to the active host
  settings.selectHost(b);
  assert.equal(settings.data.relay.url, "ws://192.0.2.20:9330");
  assert.equal(settings.data.relay.token, TOKEN_B);
  settings.selectHost("h1");
  assert.equal(settings.data.relay.url, "ws://192.0.2.11:9330", "the edit made before the switch survived");
  assert.equal(fixture(saved()).settings.data.activeHost, "h1", "the choice survives a restart");
});

test("bad host input changes nothing", () => {
  const { settings } = fixture({ firstRunDone: true, relay: { url: "ws://192.0.2.10:9330", token: enc(TOKEN_A) } });
  const before = JSON.stringify(settings.data);
  assert.throws(() => settings.addHost({ name: "Host 1", relay: { url: "192.0.2.20" } }), /hosts.badName|unique/i);
  assert.throws(() => settings.addHost({ name: "\u0007", relay: { url: "192.0.2.20" } }));
  assert.throws(() => settings.addHost({ name: "Empty" }));
  assert.throws(() => settings.selectHost("h99"));
  assert.throws(() => settings.removeHost("h1"), "the active host cannot be removed");
  assert.equal(JSON.stringify(settings.data), before);
});

test("an older Deck reading the new file still finds the active connection", () => {
  const { settings, saved } = fixture({ firstRunDone: true, relay: { url: "ws://192.0.2.10:9330", token: enc(TOKEN_A) } });
  settings.selectHost(settings.addHost({ name: "Host B", relay: { url: "192.0.2.20", token: TOKEN_B } }));
  const disk = saved();
  assert.equal(disk.relay.url, "ws://192.0.2.20:9330", "top-level relay is the active host");
  assert.ok(disk.relay.token.enc, "and its token is encrypted as before");
});
