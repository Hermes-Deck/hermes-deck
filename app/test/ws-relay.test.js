"use strict";
// Workspace tab: the browser-location menu must tell the truth about the relay. The relay sends its device list once
// when a deck connects; a window that loaded later (or reloaded) never saw it and used to say "Relay is not connected"
// while the title bar said "relay connected". Offline: a fake relay client, no Electron, no network.
//   node --test app/test/ws-relay.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const WR = require("../renderer/ws-relay");
const { setLanguage, t } = require("../renderer/i18n");
setLanguage("en");

// ---- the pure half: which reason the menu shows --------------------------------------------------------------
test("reason(): the relay socket and the device list decide, never one alone", () => {
  const now = 1_000_000;
  const devices = { t: "devices", pins: [], routes: [] };
  assert.equal(WR.reason({ link: { status: "open", since: now }, devices, now }), null, "list in hand: fine");
  assert.equal(WR.reason({ link: { status: "closed", since: now }, devices: null, now }).code, "closed");
  assert.equal(WR.reason({ link: { status: "closed", since: now }, devices: null, now }).key, "U0336", "only a closed socket says not connected");
  assert.equal(WR.reason({ link: { status: "connecting" }, devices: null, now }).code, "connecting");
  assert.equal(WR.reason({ link: null, devices: null, now }).code, "connecting", "nothing known yet is not 'not connected'");
  assert.equal(WR.reason({ link: { status: "unconfigured" }, devices: null, now }).code, "unconfigured");
  // open but silent: waiting first, "no list" (old relay) only after WAIT_MS
  assert.equal(WR.reason({ link: { status: "open", since: now }, devices: null, now: now + 1000 }).code, "waiting");
  assert.equal(WR.reason({ link: { status: "open", since: now }, devices: null, now: now + WR.WAIT_MS + 1 }).code, "no-list");
  // an old relay's list without pins keeps its own reason
  assert.equal(WR.reason({ link: { status: "open", since: now }, devices: { t: "devices" }, now }).code, "old-relay");
  for (const k of ["U0336", "ws.relayWaiting", "ws.relayConnecting", "ws.relayNoList", "ws.relayUnconfigured"]) {
    for (const l of ["en", "tr"]) {
      setLanguage(l);
      assert.notEqual(t(k), k, `${k} has a ${l} text`);
    }
  }
  setLanguage("en");
});

test("track()/fromState(): a late or reloaded window learns the link and the devices; a closed relay forgets them", () => {
  const W = { link: null, devices: null };
  const devices = { t: "devices", pins: [], routes: [], defaults: { browser: "host" } };
  // the window loaded after the relay's one-shot messages: main hands both over
  WR.fromState(W, { relayLink: { status: "open", error: null, since: 5 }, devices });
  assert.equal(W.link.status, "open");
  assert.equal(W.devices, devices);
  assert.equal(WR.reason(W), null);
  // a live status close drops the snapshot (it described a connection that is gone)
  assert.equal(WR.track(W, { t: "status", status: "closed", error: "ECONNREFUSED" }), true);
  assert.equal(W.devices, null);
  assert.equal(WR.reason(W).code, "closed");
  // reconnect: open, no list yet -> waiting; the list arrives -> fine
  WR.track(W, { t: "status", status: "open" });
  assert.equal(WR.reason(W).code, "waiting");
  WR.track(W, devices);
  assert.equal(WR.reason(W), null);
  // state without a snapshot never clears a live one
  WR.fromState(W, { relayLink: { status: "open" }, devices: null });
  assert.equal(W.devices, devices);
  // a devices message proves the socket is open even if the status message was missed
  const V = { link: null, devices: null };
  WR.track(V, devices);
  assert.equal(V.link.status, "open");
  assert.equal(WR.track(V, { t: "snapshot" }), false);
});

// ---- the main half: main/workspace.js against a fake relay client -----------------------------------------------
function loadWorkspace() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deck-wsrelay-"));
  const handlers = new Map();
  const electron = {
    app: { getPath: () => tmp, on() {}, isPackaged: false },
    ipcMain: { handle: (c, fn) => handlers.set(c, fn), on: (c, fn) => handlers.set(c, fn) },
    safeStorage: { isEncryptionAvailable: () => false },
  };
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === "electron" ? electron : load.call(this, request, ...rest);
  };
  try {
    const key = require.resolve("../main/workspace");
    delete require.cache[key];
    return { initWorkspace: require("../main/workspace").initWorkspace, tmp };
  } finally {
    Module._load = load;
  }
}

class FakeRelay extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.open = false;
  }
  send(d) {
    if (!this.open) return false;
    this.sent.push(Buffer.isBuffer(d) ? d : typeof d === "string" ? JSON.parse(d) : d);
    return true;
  }
  setStatus(status) {
    this.open = status === "open";
    this.emit("status", { status });
  }
}
function fakePresence() {
  const p = new EventEmitter();
  Object.assign(p, { id: "a1b2c3d4e5f60708", name: "Test PC", hosting: { browser: false, desktop: false }, register() {}, state: () => ({}), attach() {}, push() {} });
  return p;
}

test("main: the devices snapshot and the relay link are in ws:state, so a late window gets them", () => {
  const { initWorkspace } = loadWorkspace();
  const sent = [];
  const ws = initWorkspace({ send: (ch, m) => sent.push([ch, m]), presence: fakePresence() });
  assert.equal(ws.state().relayLink.status, "starting");
  assert.equal(ws.state().devices, null);

  const relay = new FakeRelay();
  ws.attachRelay(relay);
  assert.equal(ws.state().relayLink.status, "connecting");
  relay.setStatus("open");
  assert.equal(ws.state().relayLink.status, "open");

  // the relay's one-shot message arrives while NO window is listening (nothing consumed `sent`)
  const devices = { t: "devices", routes: [], pins: [], defaults: { browser: "host" } };
  assert.equal(ws.onRelayMsg(devices), false, "still forwarded to the window");
  const st = ws.state();
  assert.deepEqual(st.devices, devices);
  assert.equal(WR.reason({ link: st.relayLink, devices: st.devices }), null);

  // connection lost: the snapshot goes and the true reason is "closed"
  relay.setStatus("closed");
  assert.equal(ws.state().devices, null);
  assert.equal(WR.reason({ link: ws.state().relayLink, devices: ws.state().devices }).code, "closed");
  // a new connection replaces the relay: no stale list from the old one
  ws.onRelayMsg(devices);
  ws.attachRelay(new FakeRelay());
  assert.equal(ws.state().devices, null);
  ws.attachRelay(null);
  assert.equal(ws.state().relayLink.status, "unconfigured");
});

test("main: an open relay that sent no device list is asked for it; the answer ends the asking", async (t) => {
  const { initWorkspace } = loadWorkspace();
  const ws = initWorkspace({ send() {}, presence: fakePresence() });
  const relay = new FakeRelay();
  ws.attachRelay(relay);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  relay.setStatus("open");
  const asks = () => relay.sent.filter((m) => m && m.t === "devices?").length;
  assert.equal(asks(), 0);
  t.mock.timers.tick(1500);
  assert.equal(asks(), 1, "first ask after 1.5 s");
  t.mock.timers.tick(3000);
  assert.equal(asks(), 2);
  // the list arrives: no more asks
  ws.onRelayMsg({ t: "devices", routes: [], pins: [] });
  t.mock.timers.tick(30_000);
  assert.equal(asks(), 2);

  // a reconnect starts again, and a close in between cancels the pending ask
  relay.setStatus("closed");
  relay.setStatus("open");
  relay.setStatus("closed");
  t.mock.timers.tick(30_000);
  assert.equal(asks(), 2, "a closed socket is never asked");
});
