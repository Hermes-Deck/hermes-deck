"use strict";
// Integration probe for the real main-process settings class, using isolated in-memory disk/Electron ports.
// Reading preferences (renderer/reading.js) round-trip through the real settings class.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const repo = path.join(__dirname, "../..");
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function fixture(raw = { firstRunDone: true }) {
  let saved;
  const context = { module: { exports: {} }, Buffer, URL, process: { env: {} }, require(id) {
    if (id === "fs") return {
      readFileSync: () => JSON.stringify(raw), statSync: () => ({ size: 0 }),
      lstatSync: () => ({ isFile: () => true }), mkdirSync() {}, renameSync() {},
      writeFileSync: (_file, content) => { saved = JSON.parse(content); },
    };
    if (id === "os") return { homedir: () => "/fixture-home" };
    if (id === "path") return path;
    if (id === "electron") return { app: { getPath: () => "/fixture-profile" }, safeStorage: {
      isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
    } };
    if (id === "./envfile") return { loadEnvFile() {} };
    if (id === "./bridge") return { normalizeConfig: value => value };
    return require(path.join(repo, "app/main", id));
  } };
  vm.runInNewContext(fs.readFileSync(path.join(repo, "app/main/settings.js"), "utf8"), context);
  return { settings: new context.module.exports.Settings().load(), saved: () => saved };
}

test("main exposes default reading preferences", () => {
  assert.deepEqual(plain(fixture().settings.publicView().reading), { agentMessages: "plain", font: "newsreader", size: 17 });
});

test("main merges partial reading saves and restores them after restart", () => {
  const { settings, saved } = fixture();
  settings.update({ reading: { agentMessages: "bubble" } });
  settings.update({ reading: { font: "atkinson" } });
  settings.update({ reading: { size: 20 } });
  const expected = { agentMessages: "bubble", font: "atkinson", size: 20 };
  assert.deepEqual(plain(settings.publicView().reading), expected);
  assert.deepEqual(plain(saved().reading), expected);
  assert.deepEqual(plain(fixture(saved()).settings.publicView().reading), expected);
});

test("main rejects malformed reading patches before changing any setting", () => {
  for (const reading of [null, [], "bubble", { unknown: true }, { agentMessages: "card" }, { font: "remote" }, { size: "20" }, { size: 13 }, { size: 21 }, { size: 15.5 }]) {
    const { settings } = fixture();
    const before = plain(settings.publicView());
    assert.throws(() => settings.update({ reading, language: "tr" }));
    assert.deepEqual(plain(settings.publicView()), before);
  }
});
