"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

for (const [file, surface] of [["preload.js", "deck"], ["pet-preload.js", "pet"], ["cua/bar-preload.js", "botbar"]]) {
  test(`${surface} preload boots a validated locale and receives live language changes`, () => {
    for (const value of [undefined, "en", "tr", "invalid"]) {
      const exposed = {}, listeners = new Map();
      const electron = {
        contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
        ipcRenderer: { on: (channel, fn) => listeners.set(channel, fn), removeListener() {}, send() {}, invoke() {} },
        webUtils: {},
      };
      const filename = path.join(__dirname, "../main", file);
      vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
        require: (name) => { assert.equal(name, "electron"); return electron; },
        process: { argv: value === undefined ? [] : [`--deck-language=${value}`] },
      }, { filename });
      assert.equal(exposed.deckLanguage, value === "tr" ? "tr" : "en");
      let received;
      exposed[surface].onLanguage((language) => { received = language; });
      listeners.get("language")({}, "tr");
      assert.equal(received, "tr");
    }
  });
}

for (const [file, channel] of [["pet.js", "pet:ready"], ["cua/bar.js", "botbar:ready"]]) {
  test(`${channel} restores the current locale after a native page reload`, () => {
    const filename = path.join(__dirname, "../main", file);
    const req = Module.createRequire(filename);
    const handlers = new Map(), sent = [];
    const electron = { ipcMain: { on: (name, fn) => handlers.set(name, fn) } };
    const surface = { win: { isDestroyed: () => false, webContents: { send: (name, value) => sent.push([name, value]) } }, _send: () => sent.push(["state"]) };
    const context = { require: name => name === "electron" ? electron : req(name), __dirname: path.dirname(filename), process, module: { exports: {} }, fixture: surface };
    vm.runInNewContext(fs.readFileSync(filename, "utf8") + "\ncurrent = fixture;", context, { filename });
    const i18n = require("../renderer/i18n");
    i18n.setLanguage("tr");
    try {
      handlers.get(channel)({ sender: {} });
      assert.deepEqual(sent, [], "foreign windows receive no state");
      handlers.get(channel)({ sender: surface.win.webContents });
      assert.deepEqual(sent[0], ["language", "tr"]);
      assert.deepEqual(sent[1], ["state"]);
    } finally { i18n.setLanguage("en"); }
  });
}
