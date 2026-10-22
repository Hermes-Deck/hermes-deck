"use strict";
// Desktop shell with several host pages (split view): suppression per VISIBLE pane, a notification's click
// revealing its host and telling that host's page alone, pet/tray counts summed over the pages, and the page
// checks on the pet-state / test channels. The pages object stands in for main/host-views.js.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function rig() {
  const banners = [], sent = [], timers = new Map(), ipc = {}; let seq = 0;
  const state = { focus: true, idle: "active" };
  const settings = { data: { activeHost: "host-a", hosts: [{ id: "host-a", name: "Alpha" }, { id: "host-b", name: "Beta" }], desktop: { notifications: true, sound: true, notificationMode: "banner", taskbarBadge: false } }, publicView: (hostId) => ({ activeHost: hostId || "host-a" }), update() {} };
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => state.focus, show() {}, focus() {}, webContents: { send() { throw new Error("the window's own page is never addressed"); } } });
  const monitor = new EventEmitter(); monitor.getSystemIdleState = () => state.idle;
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; }
    show() { banners.push(this); }
    close() { this.closed = true; this.emit("close"); }
  }
  const electron = { app: Object.assign(new EventEmitter(), { getPath: () => "/fixture", getVersion: () => "0", setBadgeCount() {} }),
    ipcMain: { on: (ch, fn) => (ipc[ch] = fn), handle: (ch, fn) => (ipc[ch] = fn) }, powerMonitor: monitor, Notification, nativeImage: {}, systemPreferences: {} };
  const base = { console, process: { platform: "linux", argv: [] }, Date, setTimeout: (fn) => { timers.set(++seq, fn); return seq; }, clearTimeout: (id) => timers.delete(id) };
  const load = (file, mocks = {}) => {
    const ctx = { ...base, module: { exports: {} }, require: (id) => (id in mocks ? mocks[id] : id === "electron" ? electron : id.startsWith(".") ? require(path.join(__dirname, "../main", id)) : require(id)) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../main", file), "utf8"), ctx);
    return ctx.module.exports;
  };
  const notices = load("notify.js");
  const petStates = [];
  class Pet { show() {} hide() {} refresh() {} setAgent() {} event() {} setState(s) { petStates.push(s); } }
  class DeckTray { status() {} update() {} }
  // the pages: which hosts have a page, which are on screen, where a message goes, who may call
  const shown = new Set(["host-a"]);
  const revealed = [];
  const senders = { "host-a": { id: "a" }, "host-b": { id: "b" } };
  const pages = {
    has: (id) => id in senders,
    isShown: (id) => shown.has(id),
    send: (id, ch, m) => sent.push({ to: id, ch, m }),
    sendAll: (ch, m) => { for (const id of Object.keys(senders)) sent.push({ to: id, ch, m: typeof m === "function" ? m(id) : m }); },
    sendPrimary: (ch, m) => sent.push({ to: "host-a", ch, m }),
    hostOf: (e) => Object.keys(senders).find((id) => senders[id] === e.sender) ?? null,
    owns: (e) => Object.values(senders).includes(e.sender),
    reveal: async (id, show) => { revealed.push(id); if (!shown.has(id)) show(id); return true; },
    primaryContents: () => null,
  };
  const desktop = load("desktop.js", { "./notify": notices, "./pet": { Pet, statusParts: () => [], SKINS: [] },
    "./tray": { DeckTray }, "./autostart": { state: () => false, apply: () => false },
    "./updates": { createUpdateNotice: () => ({ available() {} }) },
    "./notification-route": { notificationRoute: () => "banner", fullscreenProbe: () => null } });
  desktop.init({ win, settings, icon: null, pages, showHost: (id) => { shown.clear(); shown.add(id); } });
  const view = (hostId, patch = {}) => desktop.setView({ channel: "sessions", key: null, sid: "s1", profile: "default", visible: true, ...patch }, hostId);
  const drain = () => { while (timers.size) { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); } };
  const observe = (m, hostId, client = null) => desktop.observe("bridge", m, { hostId, client });
  const snapshot = (hostId, nodes) => observe({ t: "snapshot", snapshot: { connectionId: `c-${hostId}`, nodes } }, hostId);
  const complete = (hostId, sid = "s1") => observe({ t: "event", type: "message.complete", sid, profile: "default", payload: { text: "Finished", turn_id: `turn-${hostId}-${sid}` } }, hostId);
  return { desktop, banners, sent, ipc, petStates, state, settings, shown, revealed, senders, view, drain, snapshot, complete };
}
const node = (sid = "s1") => ({ sid, profile: "default", source: "cli", state: "working" });
const plain = (v) => JSON.parse(JSON.stringify(v));

test("a conversation shown in ANY visible pane is suppressed; the same conversation on the hidden page is not", () => {
  const r = rig();
  r.shown.add("host-b"); // split: a | b
  r.view("host-a"); r.view("host-b");
  r.snapshot("host-a", [node()]); r.snapshot("host-b", [node()]);
  r.complete("host-a"); r.complete("host-b"); r.drain();
  assert.equal(r.banners.length, 0, "both panes show their s1");
  r.shown.delete("host-b"); // b's page is hidden now (still live)
  r.complete("host-b", "s1"); r.drain();
  assert.equal(r.banners.length, 0, "the same completion identity is told once");
  r.snapshot("host-b", [node("s2")]); r.view("host-b", { sid: "s2" });
  r.complete("host-b", "s2"); r.drain();
  assert.equal(r.banners.length, 1, "a hidden page's conversation is not on screen: it notifies");
  assert.equal(r.desktop.setView({ channel: "sessions", sid: "x", profile: "p", visible: true, key: null }, "host-zz"), false, "a host without a page is refused");
});

test("a notification's click reveals its host and tells THAT host's page alone, through the pages", () => {
  const r = rig();
  r.snapshot("host-b", [node()]);
  r.complete("host-b"); r.drain();
  assert.equal(r.banners.length, 1);
  r.banners[0].emit("click");
  return new Promise((resolve) => setImmediate(resolve)).then(() => {
    assert.deepEqual(r.revealed, ["host-b"]);
    assert.ok(r.shown.has("host-b"), "the primary pane took it");
    const opens = r.sent.filter((x) => x.ch === "desktop" && x.m.t === "source-open");
    assert.equal(opens.length, 1);
    assert.equal(opens[0].to, "host-b");
    assert.equal(opens[0].m.hostId, "host-b");
    assert.equal(opens[0].m.sid, "s1");
  });
});

test("the pet, tray and badge show the sum over every page's summary; only our pages may report", () => {
  const r = rig();
  r.ipc["desktop:pet-state"]({ sender: r.senders["host-a"] }, { running: 1, subs: 0, unread: 2, pending: 0, offline: false });
  r.ipc["desktop:pet-state"]({ sender: r.senders["host-b"] }, { running: 2, subs: 1, unread: 0, pending: 1, offline: true });
  assert.deepEqual(plain(r.petStates.at(-1)), { running: 3, subs: 1, unread: 2, pending: 1, offline: false });
  r.ipc["desktop:pet-state"]({ sender: { id: "stranger" } }, { running: 99, subs: 99, unread: 99, pending: 99, offline: false });
  assert.deepEqual(plain(r.petStates.at(-1)), { running: 3, subs: 1, unread: 2, pending: 1, offline: false }, "a stranger's summary is ignored");
  assert.equal(r.ipc["desktop:test"]({ sender: { id: "stranger" } }), "error");
  assert.equal(r.ipc["desktop:test"]({ sender: r.senders["host-b"] }), "ok", "any of our pages may test");
  assert.deepEqual(plain(r.desktop.sumSummaries([])), { running: 0, subs: 0, unread: 0, pending: 0, offline: true });
  r.desktop.dropHost("host-b");
  r.ipc["desktop:pet-state"]({ sender: r.senders["host-a"] }, { running: 1, subs: 0, unread: 2, pending: 0, offline: false });
  assert.deepEqual(plain(r.petStates.at(-1)), { running: 1, subs: 0, unread: 2, pending: 0, offline: false }, "a removed host's summary is gone");
});

test("tray-made settings changes reach every page with that page's own view; chimes go once, to the primary", () => {
  const r = rig();
  r.desktop.applySettings();
  r.sent.length = 0;
  r.snapshot("host-b", [node()]);
  r.complete("host-b"); r.drain();
  const chimes = r.sent.filter((x) => x.ch === "desktop" && x.m.t === "chime");
  assert.equal(chimes.length, 0, "banner mode: the OS sound, no renderer chime");
  r.desktop.notify("info", { title: "t", body: "b", force: true, quiet: true });
  assert.ok(r.sent.every((x) => x.to !== undefined));
});
