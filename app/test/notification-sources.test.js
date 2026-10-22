"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { normalizeSnapshot } = require("../main/bridge");

// In-memory desktop boundary: no OS UI, timers, profiles or connections.
function rig({ platform = "linux", route = () => "banner" } = {}) {
  const banners = [], sent = [], timers = new Map(); let seq = 0;
  const state = { focus: true, idle: "active" };
  const settings = { data: { activeHost: "host-a", hosts: [{ id: "host-a", name: "Alpha" }, { id: "host-b", name: "Beta" }], desktop: { notifications: true, sound: true, notificationMode: "banner" } }, publicView() { return {}; }, update() {} };
  const win = new EventEmitter();
  Object.assign(win, { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
    isFocused: () => state.focus, show() {}, focus() {}, webContents: { send: (ch, m) => sent.push({ ch, m }) } });
  const monitor = new EventEmitter(); monitor.getSystemIdleState = () => state.idle;
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; }
    show() { banners.push(this); }
    close() { this.closed = true; this.emit("close"); }
  }
  const electron = { app: Object.assign(new EventEmitter(), { getPath: () => "/fixture", getVersion: () => "0", setBadgeCount() {} }),
    ipcMain: { on() {}, handle() {} }, powerMonitor: monitor, Notification, nativeImage: {}, systemPreferences: {} };
  const base = { console, process: { platform, argv: [] }, Date,
    setTimeout: fn => { timers.set(++seq, fn); return seq; }, clearTimeout: id => timers.delete(id) };
  const load = (file, mocks = {}) => {
    const ctx = { ...base, module: { exports: {} }, require: id => id in mocks ? mocks[id] : id === "electron" ? electron : id.startsWith(".") ? require(path.join(__dirname, "../main", id)) : require(id) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../main", file), "utf8"), ctx);
    return ctx.module.exports;
  };
  const notices = load("notify.js");
  class Pet { show() {} hide() {} refresh() {} setAgent() {} event() {} }
  class DeckTray { status() {} update() {} }
  const desktop = load("desktop.js", { "./notify": notices, "./pet": { Pet, statusParts: () => [], SKINS: [] },
    "./tray": { DeckTray }, "./autostart": { state: () => false, apply: () => false },
    "./updates": { createUpdateNotice: () => ({ available() {} }) },
    "./notification-route": { notificationRoute: route, fullscreenProbe: () => null } });
  desktop.init({ win, settings, icon: null, getBridge: () => null });
  const view = (patch = {}, hostId = "host-a") => desktop.setView?.({ channel: "sessions", key: null, sid: "s1", profile: "default", visible: true, ...patch }, hostId);
  const drain = () => { while (timers.size) { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); } };
  const observe = (m, hostId = "host-a", client = null) => desktop.observe("bridge", m, { hostId, client });
  const node = (patch = {}) => ({ sid: "s1", profile: "default", source: "cli", state: "working", turnId: "turn-1", ...patch });
  const snapshot = (nodes, hostId) => observe({ t: "snapshot", snapshot: { connectionId: "c1", nodes } }, hostId);
  const complete = (patch = {}, hostId) => observe({ t: "event", type: "message.complete", sid: "s1", profile: "default", payload: { text: "Finished", turn_id: "turn-1" }, ...patch }, hostId);
  return { desktop, banners, sent, timers, state, settings, win, monitor, view, drain, observe, node, snapshot, complete };
}

test("focused Sessions still receives Telegram; visible same Telegram chat alone suppresses", () => {
  const r = rig(); r.view();
  r.desktop.observe("tg", { t: "msg", m: { key: "u1", id: 1, text: "reply" } }, { hostId: "host-a" }); r.drain();
  assert.equal(r.banners.length, 1);
  r.view({ channel: "telegram", key: "u1", sid: null, profile: null });
  r.desktop.observe("tg", { t: "msg", m: { key: "u1", id: 2, text: "read" } }, { hostId: "host-a" }); r.drain();
  assert.equal(r.banners.length, 1);
  r.view({ channel: "telegram", key: "u1", visible: false });
  r.desktop.observe("tg", { t: "msg", m: { key: "u1", id: 3, text: "settings" } }, { hostId: "host-a" }); r.drain();
  assert.equal(r.banners.length, 2);
});

test("settle and focus clearing recheck actual selection, not all conversations", () => {
  const r = rig(); r.state.focus = false;
  r.desktop.observe("tg", { t: "msg", m: { key: "u1", id: 1, text: "reply" } }, { hostId: "host-a" });
  r.view(); r.state.focus = true; r.win.emit("focus"); r.drain();
  assert.equal(r.banners.length, 1);
  r.desktop.observe("tg", { t: "msg", m: { key: "u1", id: 2, text: "reply" } }, { hostId: "host-a" });
  r.view({ channel: "telegram", key: "u1", sid: null }); r.drain();
  assert.equal(r.banners.length, 1);
});

test("bridge completion: same source suppresses, unrelated view notifies; fragments/history/replay do not", () => {
  const r = rig(); r.snapshot([r.node()]); r.view({ channel: "telegram", key: "u1" });
  for (const type of ["message.delta", "message.start"]) r.complete({ type });
  r.complete({ replay: true }); r.complete({ payload: { historical: true, text: "history" } }); r.drain();
  assert.equal(r.banners.length, 0);
  r.complete(); r.drain(); assert.equal(r.banners.length, 1);
  r.complete(); r.drain(); assert.equal(r.banners.length, 1);
  r.complete({ payload: { turn_id: "turn-2", text: "later" } }); r.drain(); assert.equal(r.banners.length, 2);
  r.view(); r.complete({ payload: { turn_id: "turn-3" } }); r.drain(); assert.equal(r.banners.length, 2);
});

test("external native sessions use terminal snapshot transitions, never initial/history/quiet-idle", () => {
  const r = rig(); r.view({ visible: false });
  r.snapshot([r.node({ state: "finished", terminalAt: 10 })]); r.drain(); assert.equal(r.banners.length, 0);
  r.snapshot([r.node({ turnId: "turn-2" })]);
  r.snapshot([r.node({ state: "idle", turnId: "turn-2" })]); r.drain(); assert.equal(r.banners.length, 0);
  r.snapshot([r.node({ turnId: "turn-3" })]);
  r.snapshot([r.node({ state: "finished", terminalAt: 12, turnId: "turn-3" })]); r.drain();
  assert.equal(r.banners.length, 1);
  r.complete({ payload: { turn_id: "turn-3" } }); r.drain(); assert.equal(r.banners.length, 1);
});

test("equal session IDs on different hosts/profiles remain separate; click keeps original source", () => {
  const r = rig(); r.view();
  r.snapshot([r.node()], "host-b"); r.complete({}, "host-b"); r.drain();
  assert.equal(r.banners.length, 1);
  r.banners[0].emit("click");
  const target = r.sent.find(x => x.m.t === "source-open")?.m;
  assert.equal(target?.hostId, "host-b"); assert.equal(target?.sid, "s1"); assert.equal(target?.profile, "default");
  r.snapshot([r.node({ profile: "other" })]); r.complete({ profile: "other" }); r.drain(); assert.equal(r.banners.length, 2);
});

test("unknown source remains unknown, disabled and lock gates suppress without replay", () => {
  const r = rig(); r.view(); r.snapshot([r.node({ source: "" })]); r.complete(); r.drain();
  assert.equal(r.banners.length, 1, "unknown source is not guessed from default mode");
  r.settings.data.desktop.notifications = false; r.complete({ payload: { turn_id: "turn-2" } }); r.drain();
  r.settings.data.desktop.notifications = true; r.state.idle = "locked";
  r.complete({ payload: { turn_id: "turn-3" } }); r.drain(); assert.equal(r.banners.length, 1);
  r.state.idle = "active"; r.complete({ payload: { turn_id: "turn-3" } }); r.drain(); assert.equal(r.banners.length, 1);
});

test("view contract rejects invalid channels, unbounded identifiers and renderer host injection", () => {
  const r = rig(); assert.equal(typeof r.desktop.setView, "function");
  for (const value of [{ channel: "other", visible: true }, { channel: "sessions", sid: "x".repeat(513), visible: true }, { channel: "sessions", hostId: "host-b", visible: true }]) {
    assert.equal(r.desktop.setView(value, "host-a"), false);
  }
  assert.equal(r.view(), true);
  assert.equal(r.desktop.setView({ channel: "invalid", visible: true }, "host-a"), false);
  r.snapshot([r.node()]); r.complete(); r.drain();
  assert.equal(r.banners.length, 1, "invalid view cannot keep suppressing a remembered selection");
});

test("relay and direct reports of an identified turn share exact dedupe, not a time bucket", () => {
  const r = rig(); r.view({ visible: false }); r.snapshot([r.node()]);
  const relay = state => r.desktop.observe("relay", { t: "evs", sessions: [{ sid: "s1", profile: "default", source: "cli", state, turnId: "turn-1" }] }, { hostId: "host-a" });
  relay("running"); r.complete(); relay("idle"); r.drain(); assert.equal(r.banners.length, 1);
  r.complete({ payload: { turn_id: "turn-2" } }); r.drain(); assert.equal(r.banners.length, 2);
});

for (const settled of [false, true]) test(`Telegram reply suppresses its known relay/direct completion (${settled ? "recent" : "pending"}), not another host or chat`, () => {
  const r = rig(); r.view();
  const context = { hostId: "host-a" };
  r.desktop.observe("tg", { t: "dialogs", group: { id: "-1001" }, bots: [], topics: [{ key: "t1", title: "Fixture topic" }] }, context);
  const session = { sid: "s1", profile: "default", platform: "telegram", chat: "-1001", thread: "1", agent: "Fixture" };
  r.desktop.observe("relay", { t: "snapshot", sessions: [{ ...session, state: "running" }] }, context);
  r.desktop.observe("tg", { t: "msg", m: { key: "t1", id: 1, fromBot: true, text: "Finished reply" } }, context);
  if (settled) r.drain();
  r.desktop.observe("relay", { t: "evs", sessions: [{ ...session, state: "idle" }] }, context);
  r.snapshot([r.node({ ...session, source: "telegram" })]);
  r.complete();
  if (!settled) {
    // Exercise the pending bucket before flushing the reply's settle timer.
    for (const [id, fn] of [...r.timers].slice(1)) { r.timers.delete(id); fn(); }
    assert.equal(r.banners.length, 0);
  }
  r.drain(); assert.equal(r.banners.length, 1);
  r.snapshot([r.node({ ...session, source: "telegram" })], "host-b");
  r.complete({}, "host-b"); r.drain();
  assert.equal(r.banners.length, 2, "same Telegram key on another host must notify");
  r.snapshot([r.node({ ...session, source: "telegram", thread: "2" })]);
  r.complete({ payload: { turn_id: "turn-2" } }); r.drain();
  assert.equal(r.banners.length, 3, "another Telegram topic must notify");
});

// Native observer snapshots identify the session/profile, not its Telegram chat.
const telegramSnapshot = (terminal, profile = "default") => normalizeSnapshot({ connection_id: "c1", nodes: [{
  session_id: "s1", profile_name: profile, source: "telegram", platform: "telegram", turn_id: "turn-1",
  state: terminal ? "finished" : "working", terminal_at: terminal ? 10 : null,
}] });
function mappedTelegram() {
  const r = rig(), context = { hostId: "host-a" };
  r.desktop.observe("tg", { t: "dialogs", group: { id: "-1001" }, bots: [], topics: [{ key: "t1", title: "Fixture" }] }, context);
  r.desktop.observe("relay", { t: "snapshot", sessions: [{ sid: "s1", profile: "default", platform: "telegram", chat: "-1001", thread: "1", state: "running" }] }, context);
  r.observe({ t: "snapshot", snapshot: telegramSnapshot(false) });
  return r;
}
for (const settled of [false, true]) test(`real normalized Telegram completion shares ${settled ? "recent" : "pending"} reply identity`, () => {
  const r = mappedTelegram(); r.view();
  r.desktop.observe("tg", { t: "msg", m: { key: "t1", id: 1, fromBot: true, text: "reply" } }, { hostId: "host-a" });
  if (settled) r.drain();
  r.observe({ t: "snapshot", snapshot: telegramSnapshot(true) }); r.drain();
  assert.equal(r.banners.length, 1);
});
test("normalized Telegram destinations support visible suppression and completion/request clicks", () => {
  const visible = mappedTelegram(); visible.view({ channel: "telegram", key: "t1" });
  visible.observe({ t: "snapshot", snapshot: telegramSnapshot(true) }); visible.drain();
  assert.equal(visible.banners.length, 0);
  for (const request of [false, true]) {
    const r = mappedTelegram(); r.view({ visible: false });
    r.observe(request ? { t: "requests", list: [{ id: "a1", rpcId: "rpc", sid: "s1", profile: "default", kind: "approval" }] }
      : { t: "snapshot", snapshot: telegramSnapshot(true) }); r.drain();
    r.banners[0].emit("click");
    const target = r.sent.find(x => x.m.t === "source-open").m;
    assert.equal(target.channel, "telegram"); assert.equal(target.key, "t1");
    assert.equal(target.profile, "default"); assert.equal(target.hostId, "host-a");
    if (request) assert.equal(target.id, "a1");
  }
});
test("missing, malformed, wrong-profile and wrong-host mappings use exact session review, not a Telegram guess", () => {
  for (const variant of ["missing", "profile", "host", "invalid", "drop", "replacement"]) {
    const r = variant === "missing" ? rig() : mappedTelegram(); r.view({ visible: false });
    const host = variant === "host" ? "host-b" : "host-a";
    const profile = variant === "profile" ? "other" : "default";
    if (variant === "drop") r.desktop.dropHost(host);
    if (variant === "replacement") r.desktop.observe("relay", { t: "snapshot", sessions: [] }, { hostId: host });
    if (variant === "invalid") r.desktop.observe("relay", { t: "evs", sessions: [{ sid: "s1", profile, platform: "telegram", chat: "-1001", thread: "1 trailing", state: "running" }] }, { hostId: host });
    r.observe({ t: "snapshot", snapshot: telegramSnapshot(false, profile) }, host);
    r.observe({ t: "snapshot", snapshot: telegramSnapshot(true, profile) }, host); r.drain();
    r.banners[0].emit("click");
    const target = r.sent.find(x => x.m.t === "source-open").m;
    assert.notEqual(target.channel, "telegram", variant); assert.equal(target.key, null);
    assert.equal(target.sid, "s1"); assert.equal(target.profile, profile); assert.equal(target.hostId, host);
  }
});

test("normalized Telegram DMs use only the owning host's relay agent mapping", () => {
  for (const sameHost of [true, false]) {
    const r = rig(); r.view({ visible: false });
    r.desktop.observe("tg", { t: "dialogs", bots: [{ key: "u101", username: "fixture_bot" }], topics: [] }, { hostId: "host-a" });
    r.desktop.observe("relay", { t: "snapshot", agents: { Fixture: { bot: "fixture_bot" } }, sessions: [
      { sid: "s1", profile: "default", platform: "telegram", agent: "Fixture", state: "running" },
    ] }, { hostId: "host-a" });
    if (!sameHost) r.desktop.observe("relay", { t: "agents", agents: { Fixture: { bot: "fixture_bot" } } }, { hostId: "host-b" });
    r.observe({ t: "snapshot", snapshot: telegramSnapshot(false) });
    r.complete(); r.drain(); r.banners[0].emit("click");
    const target = r.sent.find(x => x.m.t === "source-open").m;
    assert.equal(target.channel, sameHost ? "telegram" : null);
    assert.equal(target.key, sameHost ? "u101" : null);
  }
});

test("request lists, disconnects and replacements are host scoped", () => {
  const r = rig(); r.view({ visible: false });
  const request = { id: "same", sid: "s1", profile: "default", rpcId: "rpc", kind: "approval", command: "echo ok" };
  for (const host of ["host-a", "host-b"]) r.observe({ t: "requests", list: [request] }, host);
  assert.equal(r.banners.length, 2);
  r.observe({ t: "status", status: "offline" }, "host-a");
  assert.equal(r.banners[0].closed, true); assert.notEqual(r.banners[1].closed, true);
  r.banners[0].emit("click"); assert.equal(r.sent.length, 0);
  r.banners[1].emit("click"); assert.equal(r.sent[0].m.hostId, "host-b");
  r.observe({ t: "requests", list: [{ ...request, command: "changed" }] }, "host-b");
  r.desktop.dropHost("host-b"); r.banners[2].emit("click"); assert.equal(r.sent.length, 1);
});

test("async route rechecks view and source, and focus only withdraws notices being read", async () => {
  const { Notifier } = (() => {
    const ctx = { module: { exports: {} }, console, Date, setTimeout, clearTimeout,
      require: id => id === "electron" ? { Notification: class {} } : require(path.join(__dirname, "../main", id)) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../main/notify.js"), "utf8"), ctx); return ctx.module.exports;
  })();
  let resolve, visible = null; const pets = [];
  const n = new Notifier({ enabled: () => true, sound: () => false, active: s => s === visible, unlocked: () => true,
    route: () => new Promise(r => { resolve = r; }), onPet: e => pets.push(e) });
  n.notify("done", { source: "a" }); visible = "a"; resolve("pet"); await Promise.resolve(); assert.equal(pets.length, 0);
  n.notify("done", { source: "b" }); n.clear(); resolve("pet"); await Promise.resolve(); assert.equal(pets.length, 1);
});

test("native equal-ID approvals retain the originating client across selection, expiry and removal", async () => {
  const { BridgeClient } = require("../main/bridge");
  const r = rig({ platform: "darwin" }); r.view({ visible: false });
  // A display name alone is not an identity (including migrated duplicate names).
  for (const host of r.settings.data.hosts) host.name = "Shared name";
  const clients = [], writes = [];
  for (const host of ["host-a", "host-b"]) {
    const c = new BridgeClient({ mode: "off" }); clients.push(c);
    c.stopped = false; c.epoch = 1; c.conn = { ready: true, closed: false };
    c._sessionRef = () => ({ sid: "s1", profile: "default" });
    c.request = async (method, params) => { writes.push({ host, method, params }); return { status: "ok" }; };
    c._onServerFrame({ id: "same", method: "approval", params: { session_id: "rpc", profile: "default", command: "echo ok", cwd: "/work", execution_target: "local", command_complete: true, context_complete: true } });
    r.observe({ t: "requests", list: c.listRequests() }, host, c);
  }
  assert.equal(r.banners.length, 2); assert.equal(r.banners[0].options.actions.length, 2);
  for (const [index, host] of r.settings.data.hosts.entries()) {
    assert.ok(r.banners[index].options.body.includes(`${host.name} [${host.id}]`));
    assert.ok(r.banners[index].options.body.length <= 120);
  }
  r.settings.data.activeHost = "host-b";
  r.banners[0].emit("action", {}, 0); r.banners[0].emit("action", {}, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1); assert.equal(writes[0].host, "host-a"); assert.equal(writes[0].params.result.choice, "once");
  r.desktop.dropHost("host-b"); r.banners[1].emit("action", {}, 0);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(writes.length, 1);
});

test("bridge disconnect does not erase a still-connected relay's running baseline", () => {
  const r = rig(); r.view({ visible: false });
  r.desktop.observe("relay", { t: "snapshot", sessions: [{ sid: "s1", profile: "default", state: "running", source: "cli" }] }, { hostId: "host-a" });
  r.observe({ t: "status", status: "offline" });
  r.desktop.observe("relay", { t: "evs", sessions: [{ sid: "s1", profile: "default", state: "idle", source: "cli" }] }, { hostId: "host-a" });
  r.drain(); assert.equal(r.banners.length, 1);
});

test("an unrecognized source is not silently assigned to Sessions", () => {
  const r = rig(); r.view(); r.snapshot([r.node({ source: "future-platform" })]); r.complete(); r.drain();
  assert.equal(r.banners.length, 1);
});
