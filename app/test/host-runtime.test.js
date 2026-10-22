"use strict";
// Per-host runtimes (main/host-runtime.js): every saved host keeps its own relay client and direct connection alive,
// frames leave tagged with the host and the client that produced them, a plugin on another wire protocol publishes
// nothing, and a removed host's clients stop and cannot replay. Test doubles stand in for the clients.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { HostPool, HostRuntime, QUEUE_MAX } = require("../main/host-runtime");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function rig(protocol = 1) {
  const clients = [], relays = [], frames = [];
  class BridgeClient extends EventEmitter {
    constructor(cfg) { super(); this.cfg = cfg; clients.push(this); this.versionReply = Promise.resolve({ protocol }); this.stopped = 0; }
    version() { return this.versionReply; }
    start() { this.started = true; }
    stop() { this.stopped++; }
    currentSnapshot() { return { nodes: [] }; }
    listRequests() { return []; }
    setReasoning(show) { return { show }; }
  }
  class RelayClient extends EventEmitter {
    constructor(cfg) { super(); this.cfg = cfg; relays.push(this); this.stopped = 0; }
    start() { this.started = true; }
    stop() { this.stopped++; }
  }
  const pool = new HostPool({ BridgeClient, RelayClient, protocol: 1 });
  pool.on("added", (rt) => rt.on("frame", (ch, m) => frames.push({ host: rt.id, ch, m, client: ch === "bridge" ? rt.bridge : rt.relay })));
  return { pool, clients, relays, frames };
}
const HOSTS = [
  { id: "a", name: "Atlas", relay: { url: "ws://127.0.0.1:9330", token: "t".repeat(32) }, bridge: { mode: "local" } },
  { id: "b", name: "Ada", relay: { url: "", token: "" }, bridge: { mode: "ssh" } },
  { id: "c", name: "Relay only", relay: { url: "ws://127.0.0.1:9331", token: "t".repeat(32) }, bridge: { mode: "off" } },
];

test("every configured host gets its own clients; relay-only hosts open no direct connection", () => {
  const r = rig();
  assert.deepEqual(r.pool.sync(HOSTS), { added: ["a", "b", "c"], removed: [], changed: [] });
  assert.equal(r.clients.length, 2, "two direct connections");
  assert.equal(r.relays.length, 2, "two relay clients");
  assert.deepEqual(r.pool.get("c").bridgeStatus, { status: "off" });
  assert.deepEqual(r.pool.get("b").relayStatus, { status: "unconfigured" });
  assert.ok(r.clients.every((c) => c.started) && r.relays.every((c) => c.started));
  assert.deepEqual(r.pool.statuses().map((s) => s.id), ["a", "b", "c"]);
});

test("frames carry the host and the original client; an open connection publishes only after the protocol check", async () => {
  const r = rig();
  r.pool.sync(HOSTS);
  const c = r.clients[1]; // host b
  c.emit("status", { status: "open" });
  c.emit("snapshot", { connectionId: "fixture", nodes: [] });
  c.emit("event", { type: "message.complete", sid: "s1", profile: "default", payload: { turn_id: "t1" } });
  const before = r.frames.filter((f) => f.host === "b" && f.ch === "bridge");
  assert.deepEqual(before.map((f) => f.m.t), ["status"], "queued until deck.version answers");
  assert.equal(before[0].m.status, "connecting");
  await tick();
  const after = r.frames.filter((f) => f.host === "b" && f.ch === "bridge");
  assert.deepEqual(after.map((f) => f.m.t), ["status", "status", "snapshot", "event"]);
  assert.equal(after[1].m.status, "open");
  assert.ok(after.every((f) => f.client === c));
  assert.equal(r.pool.get("b").phase, "open");
  assert.ok(!r.frames.some((f) => f.host === "a" && f.ch === "bridge" && f.m.t === "event"), "nothing leaks to another host");
});

test("a late protocol read cannot resurrect an offline connection; a mismatch never publishes queued work", async () => {
  for (const mismatch of [false, true]) {
    const r = rig();
    r.pool.sync(HOSTS);
    const c = r.clients[1];
    let resolve;
    c.versionReply = new Promise((ok) => { resolve = ok; });
    c.emit("status", { status: "open" });
    c.emit("event", { type: "message.complete", sid: "same" });
    if (!mismatch) c.emit("status", { status: "offline" });
    resolve({ protocol: mismatch ? 2 : 1 });
    await tick();
    assert.equal(r.frames.filter((f) => f.host === "b" && f.m.t === "event").length, 0);
    assert.equal(r.pool.get("b").inboxRow().status, mismatch ? "protocol" : "offline");
    if (mismatch) {
      assert.equal(c.stopped, 1, "the mismatched connection is stopped");
      assert.equal(r.pool.get("b").bridgeStatus.code, "protocol");
    }
  }
});

test("the protocol-check queue is bounded and an older plugin without deck.version still passes", async () => {
  const r = rig();
  r.pool.sync(HOSTS);
  const c = r.clients[0];
  c.versionReply = Promise.resolve({ legacy: true });
  c.emit("status", { status: "open" });
  for (let i = 0; i < QUEUE_MAX + 10; i++) c.emit("event", { type: "x", n: i });
  await tick();
  const events = r.frames.filter((f) => f.host === "a" && f.m.t === "event");
  assert.equal(events.length, QUEUE_MAX, "overflow drops the oldest");
  assert.equal(events[0].m.n, 10);
  assert.equal(r.pool.get("a").phase, "open");
});

test("removing a host stops its clients and cannot replay callbacks or a queued version answer", async () => {
  const r = rig();
  r.pool.sync(HOSTS);
  const c = r.clients[1];
  let resolve;
  c.versionReply = new Promise((ok) => { resolve = ok; });
  c.emit("status", { status: "open" });
  const listeners = c.listeners("event");
  const removed = [];
  r.pool.on("removed", (rt) => removed.push(rt.id));
  assert.deepEqual(r.pool.sync(HOSTS.filter((h) => h.id !== "b")), { added: [], removed: ["b"], changed: [] });
  assert.equal(c.stopped, 1);
  assert.deepEqual(removed, ["b"]);
  assert.equal(r.pool.has("b"), false);
  resolve({ protocol: 1 });
  for (const fn of listeners) fn({ type: "message.complete" });
  await tick();
  assert.equal(r.frames.filter((f) => f.host === "b" && f.m.t === "event").length, 0);
});

test("an edited host restarts only the changed connection; an unchanged sync touches nothing", () => {
  const r = rig();
  r.pool.sync(HOSTS);
  assert.deepEqual(r.pool.sync(HOSTS), { added: [], removed: [], changed: [] });
  assert.equal(r.clients.length, 2);
  const edited = HOSTS.map((h) => (h.id === "a" ? { ...h, relay: { url: "ws://127.0.0.1:9340", token: "t".repeat(32) } } : h));
  assert.deepEqual(r.pool.sync(edited), { added: [], removed: [], changed: ["a"] });
  assert.equal(r.relays[0].stopped, 1, "the old relay client stopped");
  assert.equal(r.relays.length, 3, "a new relay client");
  assert.equal(r.clients.length, 2, "the direct connection kept its session");
  const renamed = edited.map((h) => (h.id === "a" ? { ...h, name: "Atlas 2" } : h));
  assert.deepEqual(r.pool.sync(renamed), { added: [], removed: [], changed: ["a"] });
  assert.equal(r.pool.get("a").name, "Atlas 2");
  assert.equal(r.relays.length, 3, "a rename restarts nothing");
});

test("a relay on another wire protocol stops that relay alone, with the hello still delivered", () => {
  const r = rig();
  r.pool.sync(HOSTS);
  const relay = r.relays[0];
  relay.emit("status", { status: "open" });
  relay.emit("msg", { t: "hello", v: "1.0.0", protocol: 9 });
  assert.equal(relay.stopped, 1);
  const statuses = r.frames.filter((f) => f.host === "a" && f.ch === "relay").map((f) => f.m);
  assert.equal(statuses.find((m) => m.t === "hello").protocol, 9);
  assert.equal(statuses.at(-1).code, "protocol");
  assert.equal(r.relays[1].stopped, 0, "the other host's relay is untouched");
});

test("show thinking is remembered per host and handed to the next connection", () => {
  const r = rig();
  r.pool.sync(HOSTS);
  const rt = r.pool.get("a");
  assert.deepEqual(rt.setReasoning(true), { show: true });
  rt.startBridge();
  assert.equal(r.clients.at(-1).cfg.mode, "local");
  assert.equal(rt.reasoning, true);
  assert.equal(r.pool.get("b").reasoning, false);
});

test("a runtime adopts a ready-made relay (fixture runs) and stopAll ends every client", () => {
  const r = rig();
  const rt = r.pool.ensure({ id: "", name: "", relay: { url: "", token: "" }, bridge: { mode: "off" } });
  assert.ok(rt instanceof HostRuntime);
  const fake = Object.assign(new EventEmitter(), { start() { this.started = true; }, stop() { this.stopped = true; } });
  rt.adoptRelay(fake);
  fake.emit("msg", { t: "snapshot", sessions: [] });
  assert.ok(r.frames.some((f) => f.host === "" && f.ch === "relay" && f.m.t === "snapshot"));
  r.pool.stopAll();
  assert.equal(fake.stopped, true);
  assert.equal(r.pool.list().length, 0);
});
