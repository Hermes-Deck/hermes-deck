"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function rig(platform = "darwin") {
  const calls = [];
  const state = { focused: false, minimized: false, visible: true, destroyed: false };
  const app = Object.assign(new EventEmitter(), { getPath: () => "/fixture", getVersion: () => "0", setBadgeCount() {}, setAppUserModelId() {} });
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => state.destroyed, isMinimized: () => state.minimized,
    isVisible: () => state.visible, isFocused: () => state.focused,
    restore() { calls.push("restore"); state.minimized = false; },
    show() { calls.push("show"); state.visible = true; },
    focus() { calls.push("focus"); state.focused = true; },
    setOverlayIcon() {},
    webContents: { send() {} },
  });
  class Pet { show() {} hide() {} refresh() {} }
  class DeckTray { status() {} update() {} }
  class Notifier { clear() {} }
  const mocks = {
    electron: { app, ipcMain: { on() {}, handle() {} }, nativeImage: {}, Notification: {}, powerMonitor: new EventEmitter(), systemPreferences: {} },
    "./pet": { Pet, statusParts: () => [], SKINS: [] }, "./tray": { DeckTray }, "./notify": { Notifier },
    "./autostart": { state: () => false, apply: () => false },
    "./updates": { createUpdateNotice: () => ({}) },
    "./notification-route": { fullscreenProbe: () => null },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../main/desktop.js"), "utf8"), {
    module, console, process: { platform, argv: [] },
    require: id => id in mocks ? mocks[id] : id.startsWith(".") ? require(path.join(__dirname, "../main", id)) : require(id),
  });
  module.exports.init({ win, settings: { data: { desktop: { pet: true } } } });
  return { app, state, calls, desktop: module.exports };
}

test("macOS app-switch activation restores the main window through the shared open path", () => {
  // macOS can report the fullscreen main as focused while only the pet is on the current Space.
  for (const patch of [{}, { focused: true }, { minimized: true }, { visible: false }]) {
    const r = rig(); Object.assign(r.state, patch);
    r.app.emit("did-become-active");
    assert.deepEqual(r.calls, patch.minimized ? ["restore", "show", "focus"] : ["show", "focus"]);
  }
});

test("Dock reopen stays supported; background settings do not focus; quit/destroyed do not reopen", () => {
  const r = rig();
  r.desktop.applySettings(); assert.deepEqual(r.calls, []);
  r.app.emit("activate"); assert.deepEqual(r.calls, ["show", "focus"]);
  for (const condition of ["quit", "destroyed"]) {
    const x = rig();
    if (condition === "quit") x.app.emit("before-quit"); else x.state.destroyed = true;
    x.app.emit("did-become-active"); assert.deepEqual(x.calls, []);
  }
});

test("macOS activation handling does not change Windows or Linux", () => {
  for (const platform of ["win32", "linux"]) {
    const r = rig(platform); r.app.emit("did-become-active"); assert.deepEqual(r.calls, []);
  }
});
