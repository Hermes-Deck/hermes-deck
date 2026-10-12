"use strict";
// Real main-process IPC and lifecycle handlers, fake Electron/Telegram, no external I/O.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const { EventEmitter } = require("events");
require("../renderer/i18n").setLanguage("tr"); // Keep the existing Turkish shutdown wording assertions.

function harness() {
  const main = path.join(__dirname, "..", "main", "main.js");
  const req = Module.createRequire(main);
  const handlers = new Map();
  const exits = [];
  const notices = [];
  let cancellations = 0;
  let cuaCancellations = 0;
  const timers = new Set();
  let now = 0;
  const app = new EventEmitter();
  app.stall = true;
  app.completed = 0;
  Object.assign(app, {
    getPath: () => require("os").tmpdir(),
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}),
    exit: (code) => exits.push(code),
    quit: () => {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      app.emit("before-quit", event);
      if (!event.defaultPrevented && !app.stall) {
        app.emit("will-quit", event);
        if (!event.defaultPrevented) { app.completed++; app.emit("quit"); }
      }
    },
  });
  const stub = new Proxy(function () {}, {
    get: (_t, k) => k === "then" || typeof k === "symbol" ? undefined : stub,
    apply: () => stub,
    construct: () => stub,
  });
  const electron = new Proxy({ app, ipcMain: {
    handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn),
  } }, { get: (t, k) => k in t ? t[k] : stub });
  const sandbox = {
    require: (name) => {
      if (name === "electron") return electron;
      if (name === "./desktop") return { quit: () => app.quit(), cancelQuit() { cancellations++; }, observe() {}, applySettings() {}, notify: (_kind, payload) => notices.push(payload) };
      if (name === "./cua") return { killAll() {}, cancelQuit() { cuaCancellations++; } };
      if (name === "./history") return { register() {} };
      if (!name.startsWith("./") || ["./telegram", "./ipc-guard", "./attach", "./media", "./hermes-uploads"].includes(name)) return req(name);
      return stub;
    },
    __dirname: path.dirname(main), console: { error() {}, log() {} }, URL, Response, Buffer,
    process: { argv: [process.execPath, main], platform: process.platform, env: {}, on() {} },
    setTimeout: (fn, ms) => {
      const timer = { fn, at: now + ms, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(main, "utf8") + "\nglobalThis.access = { setTg: (x) => { wire(x); tg = x; }, setSettings: (x) => { settings = x; }, setBridge: (x) => { bridge = x; }, uploads, attachments };", sandbox, { filename: main });
  const own = { senderFrame: { url: "deck://app/index.html", parent: null } };
  return {
    app, exits, notices, cancelled: () => cancellations, cuaCancelled: () => cuaCancellations, access: sandbox.access,
    call: (ch, ...args) => handlers.get(ch)(own, ...args),
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        await this.flush();
        const next = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        timers.delete(next);
        next.fn();
      }
      now = end;
      await this.flush();
    },
    async flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); },
    quit: () => app.emit("second-instance", {}, ["deck", "--quit"]),
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function upload(h, pending) {
  h.access.setTg(Object.assign(new EventEmitter(), { sendFile: () => pending.promise }));
  h.access.attachments.get = () => ({ token: "fixture-upload", name: "fixture.txt", size: 1 });
  h.access.attachments.discard = () => true;
  return h.call("tg:send-file", "u1", "fixture-upload", {});
}

test("quit: --quit watchdog waits for an in-flight upload before forcing a stalled quit", async () => {
  const h = harness();
  const pending = deferred();
  const sending = upload(h, pending);
  h.app.on("will-quit", () => assert.equal(h.access.uploads.size, 0, "upload IPC cleanup finishes before quit"));
  assert.equal(h.access.uploads.size, 1);
  h.quit();
  await h.tick(10_000);
  assert.deepEqual(h.exits, [], "the original 10-second watchdog must not interrupt the upload");
  pending.resolve({ id: 1 });
  await sending;
  await h.flush();
  assert.equal(h.access.uploads.size, 0);
  await h.tick(10_000);
  assert.deepEqual(h.exits, [0], "a stalled quit is still forced once the write settles");
});

test("quit: every service mutation, including detached login and receipts, holds the quit barrier", async () => {
  for (const name of ["send", "sendFile", "callback", "react", "createTopic", "editTopic", "pinTopic", "deleteTopic", "logout", "login", "_sendRead"]) {
    const h = harness();
    const pending = deferred();
    const svc = new EventEmitter();
    svc[name] = function () { assert.equal(this, svc, `${name} keeps its receiver`); return pending.promise; };
    h.access.setTg(svc);
    const mutation = svc[name]();
    h.quit();
    await h.tick(10_000);
    assert.deepEqual(h.exits, [], name);
    pending.resolve();
    await mutation;
    await h.tick(10_000);
    assert.deepEqual(h.exits, [0], `${name} settles before the exit watchdog runs`);
  }
});

test("quit: a rejected mutation settles safely and still allows a normal quit", async () => {
  const h = harness();
  h.app.stall = false;
  const pending = deferred();
  const sending = upload(h, pending);
  const rejected = assert.rejects(sending, /fixture failure/);
  h.quit();
  assert.equal(h.app.completed, 0, "normal quit also waits for the write");
  pending.reject(new Error("fixture failure"));
  await rejected;
  await h.tick(0);
  assert.equal(h.app.completed, 1);
  await h.tick(60_000);
  assert.deepEqual(h.exits, [], "completed lifecycle disarms the watchdog");
});

test("quit: an unresolved write cancels after 30 seconds and does not exit later", async () => {
  const h = harness();
  const pending = deferred();
  const sending = upload(h, pending);
  h.quit();
  await h.tick(29_999);
  assert.equal(h.cancelled(), 0);
  await h.tick(1);
  assert.equal(h.cancelled(), 1);
  assert.equal(h.notices.length, 1, "the user is told to wait for the result before retrying");
  assert.deepEqual(h.exits, []);
  assert.equal(h.access.uploads.size, 1, "an unresolved upload remains tracked");
  pending.resolve({ id: 1 });
  await sending;
  await h.tick(60_000);
  assert.deepEqual(h.exits, [], "a cancelled attempt never resumes automatically");
  h.quit();
  await h.tick(10_000);
  assert.deepEqual(h.exits, [0], "a new explicit quit is allowed after the result settles");
});

test("quit: no new service write starts while the quit barrier is active", async () => {
  const h = harness();
  const pending = deferred();
  let calls = 0;
  const svc = Object.assign(new EventEmitter(), { send: () => { calls++; return pending.promise; } });
  h.access.setTg(svc);
  const first = h.call("tg:send", "u1", "fixture message");
  h.quit();
  await assert.rejects(h.call("tg:send", "u1", "another message"), /Kapanış/);
  assert.throws(() => h.call("tg:login-start", "+123456789"), /Kapanış/);
  await assert.rejects(h.call("tg:logout"), /Kapanış/);
  assert.equal(calls, 1);
  pending.resolve();
  await first;
  await h.tick(10_000);
  assert.deepEqual(h.exits, [0]);
});

test("quit: settings changes cannot disable the draining client and can retry after quit is cancelled", async () => {
  const h = harness();
  const pending = deferred();
  let updates = 0;
  let stops = 0;
  const data = { chat: { modes: ["telegram"], defaultMode: "telegram" }, firstRunDone: true,
    relay: {}, bridge: {}, telegram: {}, hiddenBots: [], readReceipts: true };
  h.access.setSettings({ data, update: (patch) => { updates++; Object.assign(data, patch); }, publicView: () => data });
  h.access.setTg(Object.assign(new EventEmitter(), { sendFile: () => pending.promise, stop: async () => { stops++; } }));
  h.access.attachments.get = () => ({ token: "fixture-upload", name: "fixture.txt", size: 1 });
  h.access.attachments.discard = () => true;
  const sending = h.call("tg:send-file", "u1", "fixture-upload", {});
  const patch = { chat: { modes: ["sessions"], defaultMode: "sessions" } };
  h.quit();
  await assert.rejects(h.call("settings:save", patch), /Kapanış/);
  assert.equal(updates, 0, "reject before settings mutation or persistence");
  assert.deepEqual(data.chat.modes, ["telegram"]);
  assert.equal(stops, 0, "keep the pending upload's client alive");
  await h.tick(30_001);
  assert.equal(h.cancelled(), 1);
  assert.deepEqual(h.exits, []);
  await h.call("settings:save", patch);
  assert.equal(updates, 1);
  assert.deepEqual(data.chat.modes, ["sessions"]);
  assert.equal(stops, 1);
  pending.resolve({ id: 1 });
  await sending;
});

test("quit: another lifecycle listener cancels and disarms the watchdog, with or without a write", async () => {
  for (const waiting of [false, true]) {
    for (const event of waiting ? ["before-quit"] : ["before-quit", "will-quit"]) {
      const h = harness();
      h.app.stall = event !== "will-quit";
      const pending = deferred();
      const sending = waiting ? upload(h, pending) : null;
      h.app.on(event, (e) => e.preventDefault());
      h.quit();
      await h.flush();
      assert.equal(h.cancelled(), 1, `${event}, waiting=${waiting}`);
      assert.equal(h.cuaCancelled(), 1, "read-only window capture is enabled again after a cancelled quit");
      if (sending) { pending.resolve(); await sending; }
      await h.tick(60_000);
      assert.deepEqual(h.exits, []);
      assert.equal(h.app.completed, 0);
    }
  }
});

test("quit: repeated --quit requests share one bounded wait and one exit watchdog", async () => {
  const h = harness();
  const pending = deferred();
  const sending = upload(h, pending);
  h.quit();
  await h.tick(5_000);
  h.quit();
  pending.resolve();
  await sending;
  await h.tick(10_000);
  assert.deepEqual(h.exits, [0]);
  await h.tick(30_000);
  assert.deepEqual(h.exits, [0]);
  assert.equal(h.notices.length, 0);
});


test("quit: an in-flight Hermes message or file message finishes before its bridge is stopped", async () => {
  for (const appshot of [false, true]) {
    const h = harness();
    const pending = deferred();
    let stops = 0;
    let discarded = 0;
    h.app.stall = false;
    h.access.setBridge({ send: () => pending.promise, stop: () => { stops++; pending.reject(new Error("bridge closed")); } });
    const staged = { token: "fixture-file", name: "fixture-window.png", size: 4, buffer: Buffer.alloc(4), appshotText: "Window text" };
    h.access.attachments.get = () => staged;
    h.access.attachments.discard = () => { discarded++; return true; };
    const sending = h.call("bridge:send", "fixture-session", "Review this window", appshot ? { files: ["fixture-file"] } : {});
    const result = sending.then((value) => ({ value }), (error) => ({ error: error.message }));
    h.quit();
    await h.flush();
    assert.equal(h.app.completed, 0, "quit waits for the user-authorized Hermes send");
    assert.equal(stops, 0, "the bridge stays connected until its terminal result arrives");
    assert.equal(h.access.uploads.size, appshot ? 1 : 0);
    pending.resolve({ status: "queued" });
    assert.deepEqual(await result, { value: { status: "queued" } });
    assert.equal(h.access.uploads.size, 0);
    assert.equal(discarded, appshot ? 1 : 0);
    await h.tick(1);
    assert.equal(h.app.completed, 1);
    assert.equal(stops, 1);
    assert.deepEqual(h.exits, []);
  }
});

test("tg:send-album: validates tokens, sends one album, discards only after success", async () => {
  const h = harness();
  const discarded = [];
  const store = { p1: { token: "p1", name: "a.jpg", size: 1, kind: "photo" }, p2: { token: "p2", name: "b.jpg", size: 1, kind: "photo" }, f1: { token: "f1", name: "r.pdf", size: 1, kind: "file" } };
  h.access.attachments.get = (t) => store[t];
  h.access.attachments.discard = (t) => discarded.push(t);
  let fail = true, albums = 0;
  h.access.setTg(Object.assign(new EventEmitter(), { sendAlbum: async (key, items, o) => { albums++; if (fail) throw new Error("FLOOD"); return items.map((it, i) => ({ key, id: i + 1 })); } }));
  await assert.rejects(h.call("tg:send-album", "u1", ["p1", "f1"], {}));
  await assert.rejects(h.call("tg:send-album", "u1", ["p1"], {}));
  await assert.rejects(h.call("tg:send-album", "u1", ["p1", "p1"], {}));
  assert.equal(albums, 0, "invalid albums never reach Telegram");
  await assert.rejects(h.call("tg:send-album", "u1", ["p1", "p2"], { caption: "x" }));
  assert.deepEqual(discarded, [], "a failed album keeps its photos staged");
  assert.equal(h.access.uploads.size, 0);
  fail = false;
  const list = await h.call("tg:send-album", "u1", ["p1", "p2"], { caption: "x" });
  assert.equal(list.length, 2);
  assert.deepEqual(discarded, ["p1", "p2"]);
});
