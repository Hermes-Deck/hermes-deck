"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const tick = () => new Promise(resolve => setImmediate(resolve));

function rig() {
  const clients = [], observed = [], sent = [], dropped = [];
  class BridgeClient extends EventEmitter {
    constructor() { super(); clients.push(this); this.versionReply = Promise.resolve({ protocol: 1 }); }
    version() { return this.versionReply; }
    start() {}
    stop() { this.stopped = true; }
  }
  const settings = { data: { activeHost: "a", hosts: [
    { id: "a", name: "A", bridge: { mode: "local" } },
    { id: "b", name: "B", bridge: { mode: "ssh" } },
    { id: "c", name: "Relay only", bridge: { mode: "off" } },
  ] } };
  const ctx = { BridgeClient, settings, FIXTURE: false, SHOT: false,
    desktop: { observe: (ch, m, context) => observed.push({ ch, m, context }), dropHost: id => dropped.push(id) },
    send: (ch, m) => sent.push({ ch, m }), require: () => ({ PROTOCOL: 1 }) };
  const source = fs.readFileSync(process.env.NOTIFICATION_MAIN_FIXTURE || path.join(__dirname, "../main/main.js"), "utf8");
  const start = source.indexOf('const HOST_PROTOCOL =');
  const end = source.indexOf('ipc.handle("hosts:requests"', start);
  vm.createContext(ctx); vm.runInContext(source.slice(start, end), ctx); ctx.startWatchers();
  return { ...ctx, clients, observed, sent, dropped };
}

test("existing inactive-host watcher forwards completion events and snapshots with original client", async () => {
  const r = rig(); assert.equal(r.clients.length, 1, "no second pool and no relay-only fake monitor");
  const c = r.clients[0]; c.emit("status", { status: "open" });
  c.emit("snapshot", { connectionId: "fixture", nodes: [] });
  c.emit("event", { type: "message.complete", sid: "s1", profile: "default", payload: { turn_id: "t1" } });
  await tick();
  const events = r.observed.filter(x => ["snapshot", "event"].includes(x.m.t));
  assert.equal(events.length, 2); assert.equal(events[1].m.type, "message.complete");
  assert.ok(events.every(x => x.context.hostId === "b" && x.context.client === c));
});

test("late protocol read cannot resurrect offline watcher; protocol mismatch never publishes queued work", async () => {
  for (const mismatch of [false, true]) {
    const r = rig(); const c = r.clients[0]; let resolve;
    c.versionReply = new Promise(r => { resolve = r; });
    c.emit("status", { status: "open" });
    c.emit("event", { type: "message.complete", sid: "same" });
    if (!mismatch) c.emit("status", { status: "offline" });
    resolve({ protocol: mismatch ? 2 : 1 }); await tick();
    assert.equal(r.observed.filter(x => x.m.t === "event").length, 0);
    assert.equal(r.sent.at(-1).m.hosts[0].status, mismatch ? "protocol" : "offline");
  }
});

test("removing a host stops its watcher and cannot replay callbacks or a queued version response", async () => {
  const r = rig(); const c = r.clients[0]; let resolve;
  c.versionReply = new Promise(r => { resolve = r; }); c.emit("status", { status: "open" });
  const listeners = c.listeners("event");
  r.settings.data.hosts = r.settings.data.hosts.filter(h => h.id !== "b"); r.startWatchers();
  assert.equal(c.stopped, true); assert.ok(r.dropped.includes("b"));
  resolve({ protocol: 1 }); for (const fn of listeners) fn({ type: "message.complete" }); await tick();
  assert.equal(r.observed.filter(x => x.m.t === "event").length, 0);
});
