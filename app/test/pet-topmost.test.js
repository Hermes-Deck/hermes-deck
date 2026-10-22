"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm"), Module = require("node:module");
const { EventEmitter } = require("node:events");

/** pet.js in a sandbox on `platform` with a fake BrowserWindow; its intervals are recorded, never run on their own. */
function loadPet(platform) {
  const filename = path.join(__dirname, "../main/pet.js"), req = Module.createRequire(filename), windows = [], timers = [];
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.top = options.alwaysOnTop; this.calls = []; windows.push(this); this.webContents = { send() {}, on() {}, setWindowOpenHandler() {} }; }
    isDestroyed() { return !!this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
    isAlwaysOnTop() { return this.top; }
    setAlwaysOnTop(on, level) { this.top = on; this.calls.push([on, level]); }
    setIgnoreMouseEvents() {}
    setVisibleOnAllWorkspaces() {}
    setBounds() {}
    showInactive() { this.shownInactive = true; }
    loadURL() { this.emit("ready-to-show"); }
  }
  const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }), getDisplayNearestPoint: () => screen.getPrimaryDisplay(), on() {} };
  const electron = { BrowserWindow: Window, screen, ipcMain: { on() {} } };
  const setInterval = (fn, ms) => timers.push({ fn, ms, on: true }) - 1;
  const clearInterval = (id) => { if (timers[id]) timers[id].on = false; };
  const context = { require: n => n === "electron" ? electron : req(n), __dirname: path.dirname(filename), process: { platform }, module: { exports: {} }, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), context);
  return { Pet: context.module.exports.Pet, windows, timers };
}

test("pet topmost follows its boolean on creation, live refresh and recreation without focus", () => {
  const { Pet, windows } = loadPet("win32");
  let options = {};
  const pet = new Pet({ options: () => options });
  pet.show();
  assert.equal(pet.win.top, true, "legacy default stays on");
  assert.equal(pet.win.options.focusable, false);
  assert.equal(pet.win.shownInactive, true);
  options = { alwaysOnTop: false }; pet.refresh();
  assert.equal(pet.win.top, false, "uncheck changes existing native window");
  pet.hide(); pet.show(); assert.equal(pet.win.top, false, "off survives native window recreation");
  options = { alwaysOnTop: true, size: 1.25 }; pet.refresh();
  assert.equal(pet.win.top, true, "size change cannot skip topmost update");
  const count = pet.win.calls.length; pet.refresh(); assert.equal(pet.win.calls.length, count, "no constant raising");
  assert.equal(windows.length, 2, "only pet windows are touched");
  pet.hide();
});

test("pet on Windows re-applies topmost every 5 s while it is on, because Windows can drop it silently", () => {
  const { Pet, timers } = loadPet("win32");
  let options = {};
  const pet = new Pet({ options: () => options });
  pet.show();
  const tick = () => timers.filter(t => t.on).forEach(t => t.fn());
  assert.deepEqual(timers.map(t => t.ms), [5000]);
  const count = pet.win.calls.length;
  tick();
  assert.deepEqual(pet.win.calls.slice(count), [[true, "screen-saver"]], "isAlwaysOnTop() may still say true");
  options = { alwaysOnTop: false }; pet.refresh();
  const off = pet.win.calls.length;
  tick();
  assert.equal(pet.win.calls.length, off, "unchecked: left alone");
  pet.hide();
  assert.equal(timers.filter(t => t.on).length, 0, "closed: the timer stops");
});

test("pet on macOS and Linux keeps no topmost timer", () => {
  for (const platform of ["darwin", "linux"]) {
    const { Pet, timers } = loadPet(platform);
    const pet = new Pet({ options: () => ({}) });
    pet.show();
    assert.equal(timers.length, 0, platform);
    pet.hide();
  }
});

test("pet preference round-trips alone without migrating hosts or re-encrypting unrelated secrets", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "deck-pet-top-"));
  const old = Module._load;
  Module._load = function(name, ...args) { return name === "electron" ? { app: { getPath: () => work }, safeStorage: { isEncryptionAvailable: () => false } } : old.call(this, name, ...args); };
  let Settings;
  try { ({ Settings } = require("../main/settings")); } finally { Module._load = old; }
  try {
    const settings = new Settings();
    const raw = { hosts: [], activeHost: "", relay: { url: "wss://example.com", token: { enc: "c3ludGhldGlj" } }, desktop: { pet: false }, updates: { auto: false, host: false, channel: "test" } };
    fs.writeFileSync(settings.file, JSON.stringify(raw)); settings.load();
    assert.equal(settings.publicView().desktop.petAlwaysOnTop, true);
    for (const on of [false, true]) {
      settings.update({ desktop: { petAlwaysOnTop: on } });
      assert.deepEqual(JSON.parse(fs.readFileSync(settings.file, "utf8")), { ...raw, desktop: { ...raw.desktop, petAlwaysOnTop: on } });
      assert.equal(new Settings().load().publicView().desktop.petAlwaysOnTop, on);
    }
    const before = fs.readFileSync(settings.file, "utf8");
    assert.throws(() => settings.update({ desktop: { petAlwaysOnTop: "false" } }));
    assert.equal(fs.readFileSync(settings.file, "utf8"), before);
    settings.update({ desktop: { pet: true, petAlwaysOnTop: false } });
    assert.deepEqual(JSON.parse(fs.readFileSync(settings.file, "utf8")).hosts, []);
    assert.equal(new Settings().load().publicView().desktop.pet, true);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});
