"use strict";
// Multi-view (several hosts live at once, split view): real main.js handlers over fake Electron, real host runtimes,
// pages and layout logic. Covered: IPC routed by the SENDER page's host, the select swap rule, split persistence
// and restore, device hosting following the primary pane only, a late reply never reaching another host's page,
// hidden pages still receiving their host's events, source-open delivered to the target host's own page.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const { EventEmitter } = require("events");
require("../renderer/i18n").setLanguage("en");

const HOSTS = [
  { id: "ha", name: "Atlas", relay: { url: "ws://127.0.0.1:9330", token: "t".repeat(32) }, bridge: { mode: "local" }, botscreen: { agents: [], deviceToken: "" } },
  { id: "hb", name: "Ada", relay: { url: "ws://127.0.0.1:9331", token: "t".repeat(32) }, bridge: { mode: "ssh", target: "ada" }, botscreen: { agents: [], deviceToken: "" } },
  { id: "hc", name: "Cato", relay: { url: "", token: "" }, bridge: { mode: "local" }, botscreen: { agents: [], deviceToken: "" } },
];

/** A settings double with the parts main.js touches (settings.js itself has its own tests). */
function fakeSettings({ activeHost = "ha", panes = { split: false, right: "", ratio: 0.5 } } = {}) {
  const data = { hosts: JSON.parse(JSON.stringify(HOSTS)), activeHost, panes: { ...panes }, relay: { url: "", token: "" }, bridge: { mode: "off" },
    chat: { modes: ["sessions"], defaultMode: "sessions" }, firstRunDone: true, telegram: {}, hiddenBots: [], readReceipts: true, language: "en", theme: "basalt",
    desktops: { host: false }, desktop: {}, botscreen: { agents: [], deviceToken: "" } };
  const saved = [];
  return {
    data, saved,
    isConfigured: () => false,
    publicView: (hostId) => ({ activeHost: hostId !== undefined && hostId !== data.activeHost && data.hosts.some((h) => h.id === hostId) ? hostId : data.activeHost, primaryHost: data.activeHost, hosts: data.hosts.map((h) => ({ id: h.id, name: h.name })) }),
    selectHost(id) { if (!data.hosts.some((h) => h.id === id)) throw new Error("hosts.unknown"); data.activeHost = id; if (data.panes.right === id) data.panes = { ...data.panes, split: false, right: "" }; saved.push(["select", id]); },
    setPanes(patch) { data.panes = { ...data.panes, ...patch }; saved.push(["panes", { ...data.panes }]); },
    update(patch) { Object.assign(data, patch); },
    removeHost(id) { data.hosts = data.hosts.filter((h) => h.id !== id); if (data.panes.right === id) data.panes = { ...data.panes, split: false, right: "" }; },
    addHost() {},
  };
}

function harness(opts = {}) {
  const main = path.join(__dirname, "..", "main", "main.js");
  const req = Module.createRequire(main);
  const handlers = new Map();
  const made = []; // every page made, in order
  const observed = [], dropped = [], notices = [];
  class FakeView {
    constructor({ webPreferences }) {
      this.prefs = webPreferences; this.bounds = null; this.visible = null; this.throttled = null; this.url = "";
      const view = this;
      this.webContents = Object.assign(new EventEmitter(), {
        sent: [], destroyed: false, focused: 0,
        send(ch, m) { this.sent.push({ ch, m }); },
        isDestroyed() { return this.destroyed; },
        loadURL(u) { view.url = u; return Promise.resolve(); },
        setWindowOpenHandler() {},
        setBackgroundThrottling(v) { view.throttled = v; },
        focus() { this.focused++; },
        close() { this.destroyed = true; this.emit("destroyed"); },
      });
      made.push(this);
    }
    setBounds(b) { this.bounds = b; }
    setVisible(v) { this.visible = v; }
    getVisible() { return this.visible; }
    setBackgroundColor(c) { this.bg = c; }
  }
  const app = new EventEmitter();
  Object.assign(app, { getPath: () => require("os").tmpdir(), requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), exit() {}, quit() {}, getVersion: () => "0.0.0" });
  const stub = new Proxy(function () {}, { get: (_t, k) => (k === "then" || typeof k === "symbol" ? undefined : stub), apply: () => stub, construct: () => stub });
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn) };
  const electron = new Proxy({ app, ipcMain, WebContentsView: FakeView }, { get: (t, k) => (k in t ? t[k] : stub) });
  const desktop = { quit() {}, cancelQuit() {}, applySettings() {}, notify: (_k, p) => notices.push(p), info: () => ({}),
    observe: (ch, m, ctx) => observed.push({ ch, m, ctx }), dropHost: (id, relay) => dropped.push([id, relay]), setView: () => true, openSettings() {} };
  const sandbox = {
    require: (name) => {
      if (name === "electron") return electron;
      if (name === "./desktop") return desktop;
      if (name === "./cua") return { killAll() {}, cancelQuit() {}, attachRelay() {}, shotBar: () => false };
      if (name === "./history") return { register() {} };
      if (!name.startsWith("./") || ["./telegram", "./ipc-guard", "./attach", "./media", "./hermes-uploads", "./host-runtime", "./host-views", "./host-layout"].includes(name)) return req(name);
      return stub;
    },
    __dirname: path.dirname(main), console: { error() {}, log() {} }, URL, Response, Buffer,
    process: { argv: [process.execPath, main], platform: process.platform, env: {}, on() {}, execPath: process.execPath },
    setTimeout: (fn) => { const t = { fn, unref() {} }; Promise.resolve().then(() => fn()); return t; }, clearTimeout() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(main, "utf8") + `
globalThis.access = {
  setSettings: (x) => { settings = x; },
  setDevice: (p, d, w) => { presence = p; desktopsHost = d; workspace = w; },
  hosts, views, syncHosts, attachPrimary, paneState, applyPanes, showHost,
  inject: (id, client) => { const rt = hosts.get(id); rt.bridge = client; rt.phase = "open"; return rt; },
};`, sandbox, { filename: main });
  const settings = fakeSettings(opts);
  sandbox.access.setSettings(settings);
  const hosting = { browser: true, desktop: false };
  const device = { calls: [], presence: { hosting, capabilities: new Set(["browser", "desktop"]), setHosting: (cap, on) => { device.calls.push(["hosting", cap, on]); hosting[cap] = on; } },
    desktops: { hostOff: () => { device.calls.push(["desktops-off"]); return Promise.resolve(); }, attachRelay: (r) => device.calls.push(["desktops-relay", !!r]), settingsChanged() {} },
    workspace: { forgetTransferConsent: () => device.calls.push(["forget-consent"]), attachRelay: (r) => device.calls.push(["workspace-relay", !!r]), onRelayMsg: () => false } };
  sandbox.access.setDevice(device.presence, device.desktops, device.workspace);
  const win = { children: [], contentView: { addChildView(v, i) { if (i === 0) win.children.unshift(v); else win.children.push(v); }, removeChildView(v) { win.children = win.children.filter((x) => x !== v); } },
    getContentBounds: () => ({ x: 0, y: 0, width: 1500, height: 900 }), on() {}, isDestroyed: () => false };
  const { views, hosts } = sandbox.access;
  views.attach(win);
  sandbox.access.syncHosts();
  sandbox.access.attachPrimary();
  views.apply(sandbox.access.paneState());
  const pageOf = (id) => views.pageOf(id);
  const eventFrom = (id, url) => ({ sender: pageOf(id).wc, senderFrame: { url: url || `deck://app/index.html?host=${id}`, parent: null } });
  const call = (id, ch, ...args) => handlers.get(ch)(eventFrom(id), ...args);
  const sentTo = (id, ch) => pageOf(id).wc.sent.filter((x) => x.ch === ch).map((x) => x.m);
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { settings, device, win, made, observed, dropped, notices, views, hosts, access: sandbox.access, desktop, call, eventFrom, pageOf, sentTo, flush, handlers };
}
const handlersOf = (h) => h.handlers;

test("start: the primary host's page is the one full page; every saved host runs; hidden hosts have no page yet", () => {
  const h = harness();
  assert.deepEqual(h.hosts.ids(), ["ha", "hb", "hc"], "a runtime per saved host, shown or not");
  assert.deepEqual(h.views.hostIds(), ["ha"]);
  assert.deepEqual(h.pageOf("ha").view.bounds, { x: 0, y: 0, width: 1500, height: 900 });
  assert.equal(h.pageOf("ha").view.visible, true);
  assert.equal(h.pageOf("ha").view.url, "deck://app/index.html?host=ha");
  assert.equal(h.pageOf("ha").view.prefs.sandbox, true);
  assert.equal(h.pageOf("ha").view.prefs.contextIsolation, true);
  assert.match(h.pageOf("ha").view.prefs.preload, /preload\.js$/);
  assert.deepEqual(h.views.layoutFor("ha"), { split: false, pane: "full", hostId: "ha", panes: [{ side: "full", hostId: "ha" }] });
  assert.deepEqual(h.device.calls.filter((c) => c[0].endsWith("-relay")).slice(-2), [["workspace-relay", true], ["desktops-relay", true]], "device hosting rides the primary's relay");
});

test("routing: every channel resolves the SENDER page's host; a mutation from page B never reaches host A", async () => {
  const h = harness();
  h.call("ha", "hosts:select", "hb"); // from the full pane: hb becomes the primary; ha stays warm, hidden
  assert.deepEqual(h.views.shownHosts(), ["hb"]);
  assert.deepEqual(h.views.hostIds(), ["hb", "ha"].sort(), "the old page is kept, not reloaded");
  assert.equal(h.pageOf("ha").view.visible, false);
  const sends = [];
  const client = (id) => ({ send: async (sid, text) => { sends.push([id, sid, text]); return { status: "queued" }; }, removeAllListeners() {}, stop() {}, currentSnapshot: () => null, listRequests: () => [] });
  h.access.inject("ha", client("ha"));
  h.access.inject("hb", client("hb"));
  await h.call("hb", "bridge:send", "s-1", "hello from the shown page", {});
  await h.call("ha", "bridge:send", "s-2", "hello from the hidden page", {});
  assert.deepEqual(sends, [["hb", "s-1", "hello from the shown page"], ["ha", "s-2", "hello from the hidden page"]]);
  assert.deepEqual(h.call("ha", "hosts:requests").map((r) => r.id), ["hb", "hc"], "the inbox's other-host rows exclude the page's own host");
  assert.deepEqual(h.call("hb", "hosts:requests").map((r) => r.id), ["ha", "hc"]);
  assert.equal(h.call("hb", "settings:get").activeHost, "hb");
  assert.equal(h.call("ha", "settings:get").activeHost, "ha", "each page sees its own host as its active one");
});

test("gate: a page whose ?host= disagrees with its sender, or a stranger, is refused; device hosting changes only from the primary pane", () => {
  const h = harness();
  h.call("ha", "hosts:set-split", true);
  assert.deepEqual(h.views.shownHosts(), ["ha", "hb"]);
  assert.equal(h.call("hb", "settings:get").activeHost, "hb");
  const lying = { sender: h.pageOf("hb").wc, senderFrame: { url: "deck://app/index.html?host=ha", parent: null } };
  assert.equal(h.views.hostOf(lying), null);
  assert.throws(() => h.call("hb", "settings:get") && handlersOf(h).get("settings:get")(lying), /host pages/);
  const stranger = { sender: { sent: [] }, senderFrame: { url: "deck://app/index.html?host=ha", parent: null } };
  assert.throws(() => handlersOf(h).get("settings:get")(stranger), /host pages/);
  // the gate main.js installed, on a device-hosting channel registered through ipc-guard like presence.js does
  const { appIpc } = require("../main/ipc-guard");
  const reg = {};
  const ipc = appIpc({ handle: (ch, fn) => (reg[ch] = fn), on: (ch, fn) => (reg[ch] = fn) });
  const calls = [];
  ipc.handle("device:set-hosting", (_e, cap, on) => calls.push([cap, on]));
  ipc.handle("device:state", () => "state");
  assert.deepEqual(reg["device:set-hosting"](h.eventFrom("ha"), "browser", true), 1);
  assert.throws(() => reg["device:set-hosting"](h.eventFrom("hb"), "browser", true), /left pane/);
  assert.equal(reg["device:state"](h.eventFrom("hb")), "state", "the other pane may still read the device's state");
  assert.deepEqual(calls, [["browser", true]]);
});

test("select: the calling pane takes the host, the panes swap when the other pane shows it, a hidden page counts as the primary pane", () => {
  const h = harness();
  h.call("ha", "hosts:set-split", true);
  assert.deepEqual(h.views.shownHosts(), ["ha", "hb"]);
  h.call("hb", "hosts:select", "hc"); // the right pane changes host; the primary is untouched
  assert.deepEqual(h.views.shownHosts(), ["ha", "hc"]);
  assert.equal(h.settings.data.activeHost, "ha");
  assert.deepEqual(h.settings.saved.filter((s) => s[0] === "select"), [], "no primary change was saved");
  h.call("hc", "hosts:select", "ha"); // the right pane asks for the left pane's host: swap
  assert.deepEqual(h.views.shownHosts(), ["hc", "ha"]);
  assert.equal(h.settings.data.activeHost, "hc", "the left pane's host is the primary");
  h.call("hb", "hosts:select", "hb"); // from the hidden page: the primary pane takes it
  assert.deepEqual(h.views.shownHosts(), ["hb", "ha"]);
  assert.equal(h.pageOf("hc").view.visible, false);
  assert.equal(h.views.hostIds().length, 3, "every opened host keeps its page");
  for (const id of ["hb", "ha", "hc"]) {
    const last = h.sentTo(id, "hosts").filter((m) => m.t === "layout").at(-1);
    assert.equal(last.hostId, id, "onLayout tells each page its OWN host, hidden pages included");
    assert.equal(last.pane, id === "hb" ? "left" : id === "ha" ? "right" : null);
    assert.deepEqual(last.panes, [{ side: "left", hostId: "hb" }, { side: "right", hostId: "ha" }]);
  }
});

test("split: on opens the next saved host beside the caller, off keeps the caller's pane; the state is persisted and restored; one host cannot split", () => {
  const h = harness();
  const layout = h.call("ha", "hosts:set-split", true);
  assert.deepEqual(layout, { split: true, pane: "left", hostId: "ha", panes: [{ side: "left", hostId: "ha" }, { side: "right", hostId: "hb" }] });
  assert.deepEqual(h.settings.saved.at(-1), ["panes", { split: true, right: "hb", ratio: 0.5 }]);
  const a = h.pageOf("ha").view.bounds, b = h.pageOf("hb").view.bounds;
  assert.equal(a.width + 6 + b.width, 1500);
  assert.equal(b.x, a.width + 6);
  assert.ok(a.width >= 360 && b.width >= 360);
  assert.equal(h.pageOf("hb").view.throttled, false, "a shown page paints freely");
  const off = h.call("hb", "hosts:set-split", false); // the right pane's page keeps the screen
  assert.deepEqual(off, { split: false, pane: "full", hostId: "hb", panes: [{ side: "full", hostId: "hb" }] });
  assert.equal(h.settings.data.activeHost, "hb");
  assert.equal(h.pageOf("ha").view.visible, false);
  assert.equal(h.pageOf("ha").view.throttled, true, "a hidden page must not keep animating");
  // restart with split saved: both pages come up
  const r = harness({ activeHost: "ha", panes: { split: true, right: "hc", ratio: 0.3 } });
  assert.deepEqual(r.views.shownHosts(), ["ha", "hc"]);
  assert.ok(r.pageOf("ha").view.bounds.width < r.pageOf("hc").view.bounds.width, "the saved ratio places the divider");
  const one = harness();
  one.settings.data.hosts = one.settings.data.hosts.slice(0, 1);
  assert.throws(() => one.call("ha", "hosts:set-split", true), /two saved hosts/);
});

test("device hosting follows the primary only: changing the right pane touches nothing, a new primary turns it off", () => {
  const h = harness();
  h.call("ha", "hosts:set-split", true);
  h.device.calls.length = 0;
  h.call("hb", "hosts:select", "hc");
  assert.deepEqual(h.device.calls, [], "the right pane's host changed: hosting untouched");
  assert.equal(h.device.presence.hosting.browser, true);
  h.call("ha", "hosts:select", "hb"); // the left pane changes: hb is the new primary
  assert.deepEqual(h.device.calls, [["hosting", "browser", false], ["desktops-off"], ["forget-consent"], ["workspace-relay", true], ["desktops-relay", true]]);
  assert.equal(h.settings.data.activeHost, "hb");
});

test("frames: a host's reply reaches its page alone, hidden or not, and the observer sees it with that host's client", async () => {
  const h = harness();
  h.call("ha", "hosts:select", "hb"); // ha is warm, hidden
  const a = h.hosts.get("ha"), b = h.hosts.get("hb");
  a.emit("frame", "bridge", { t: "event", type: "message.complete", sid: "s-late" });
  b.emit("frame", "relay", { t: "evs", sessions: [] });
  assert.deepEqual(h.sentTo("ha", "bridge").filter((m) => m.t === "event").map((m) => m.sid), ["s-late"], "the hidden page still gets its host's events");
  assert.equal(h.sentTo("hb", "bridge").some((m) => m.sid === "s-late"), false, "a late reply for A never reaches B's page");
  assert.deepEqual(h.sentTo("hb", "relay").map((m) => m.t), ["evs"]);
  assert.equal(h.sentTo("ha", "relay").some((m) => m.t === "evs"), false);
  const seen = h.observed.filter((o) => o.m.sid === "s-late");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ctx.hostId, "ha");
  assert.equal(seen[0].ctx.client, a.bridge);
  a.emit("change"); await h.flush();
  const status = h.sentTo("hb", "hosts").filter((m) => m.t === "status").at(-1);
  assert.deepEqual(status.hosts.map((x) => x.id), ["ha", "hb", "hc"], "every page hears every host's state");
  assert.ok(status.hosts.every((x) => x.relay && x.sessions));
  assert.deepEqual(h.call("hb", "hosts:status").map((x) => x.id), ["ha", "hb", "hc"]);
});

test("source-open: the notification's host comes on screen (focused when shown, else the primary pane) and its page alone gets the event once ready", async () => {
  const h = harness();
  const pages = h.views;
  let msgs = [];
  // desktop.js's path, with the real HostViews: reveal, then deliver to that host's page
  const open = (hostId) => pages.reveal(hostId, (id) => h.access.showHost(id)).then((ready) => { if (ready) pages.send(hostId, "desktop", { t: "source-open", hostId, channel: "sessions", sid: "s-9", profile: "work" }); msgs.push([hostId, ready]); });
  const p1 = open("hc"); // hidden, no page yet: the primary pane takes it
  assert.deepEqual(pages.shownHosts(), ["hc"]);
  assert.equal(h.sentTo("hc", "desktop").filter((m) => m.t === "source-open").length, 0, "nothing before the page says ready");
  h.call("hc", "ready");
  await p1;
  assert.deepEqual(h.sentTo("hc", "desktop").filter((m) => m.t === "source-open").length, 1);
  assert.equal(h.sentTo("ha", "desktop").filter((m) => m.t === "source-open").length, 0, "the old primary's page heard nothing");
  h.call("hc", "hosts:set-split", true); // hc | ha
  assert.deepEqual(pages.shownHosts(), ["hc", "ha"]);
  const before = h.pageOf("ha").wc.focused;
  h.call("ha", "ready");
  await open("ha"); // already on screen in the right pane: focused there, no pane change
  assert.deepEqual(pages.shownHosts(), ["hc", "ha"]);
  assert.ok(h.pageOf("ha").wc.focused > before, "the pane showing it took the keyboard");
  assert.deepEqual(h.sentTo("ha", "desktop").filter((m) => m.t === "source-open").length, 1);
  assert.equal(h.sentTo("hc", "desktop").filter((m) => m.t === "source-open").length, 1, "the other pane heard nothing new");
});

test("removing a host stops its runtime and destroys its page; the right pane closes when its host goes", async () => {
  const h = harness();
  h.call("ha", "hosts:set-split", true);
  const page = h.pageOf("hb");
  h.call("ha", "hosts:remove", "hb");
  assert.equal(page.wc.destroyed, true);
  assert.equal(h.views.has("hb"), false);
  assert.equal(h.hosts.has("hb"), false);
  assert.deepEqual(h.views.shownHosts(), ["ha"]);
  assert.ok(h.dropped.some((d) => d[0] === "hb"));
});

test("close: every page unloads before the window goes; a page that holds finishes with bridge:unload-done", async () => {
  const h = harness();
  h.call("ha", "hosts:set-split", true);
  const a = h.pageOf("ha"), b = h.pageOf("hb");
  let holds = 0;
  a.wc.close = (o) => { if (o && o.waitForBeforeUnload) { holds++; return; } a.wc.destroyed = true; a.wc.emit("destroyed"); }; // a holds its unload
  b.wc.close = () => { b.wc.destroyed = true; b.wc.emit("destroyed"); };
  let done = false;
  const all = h.views.closeAll().then(() => { done = true; });
  await h.flush();
  assert.equal(holds, 1);
  assert.equal(done, false, "waits for the page that holds");
  assert.equal(h.views.finishClose("ha"), true); // bridge:unload-done from that page while the window closes
  await all;
  assert.equal(done, true);
});

test("first host: the page made before any host was saved becomes that host's page (no reload mid first-run)", () => {
  const h = harness({ activeHost: "" });
  h.settings.data.hosts = [];
  h.views.apply(h.access.paneState());
  assert.deepEqual(h.views.hostIds(), [""], "the one page of a profile without hosts");
  const page = h.pageOf("");
  h.settings.addHost = () => { h.settings.data.hosts = [JSON.parse(JSON.stringify(HOSTS[0]))]; h.settings.data.activeHost = "ha"; };
  const view = handlersOf(h).get("hosts:add")(h.eventFrom(""), { name: "Atlas" });
  assert.equal(view.activeHost, "ha");
  assert.equal(h.views.pageOf("ha"), page, "the same page, now the first host's");
  assert.equal(h.views.has(""), false);
  assert.equal(page.wc.destroyed, false);
  const adopted = { sender: page.wc, senderFrame: { url: "deck://app/index.html?host=", parent: null } };
  assert.equal(h.views.hostOf(adopted), "ha", "its ?host= stays empty until the next start; it still resolves to its host");
  assert.ok(h.hosts.has("ha"));
  assert.deepEqual(h.views.shownHosts(), ["ha"]);
});
