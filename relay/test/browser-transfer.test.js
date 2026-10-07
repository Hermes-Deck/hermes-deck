"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Presence } = require("../src/presence");
const { BrowserTransfers } = require("../src/browser-transfer");

test("heartbeat loss restores the last consented checkpoint before pinning the destination", async () => {
  let now = 1000;
  const p = new Presence({ now: () => now, browserDefault: "device", fallback: { browser: { id: "fallback", name: "Agent host" } } });
  const source = new EventEmitter();
  source.readyState = 1;
  source.sent = [];
  source.send = (s) => source.sent.push(JSON.parse(s));
  p.connect(source);
  p.heartbeat(source, { device: { id: "aaaaaaaa", name: "Source" }, hosting: { browser: true }, idleSec: 0 });
  p.routeFor("scout", "browser");
  let imported = false;
  let release;
  const wait = new Promise((resolve) => (release = resolve));
  const checkpoint = { id: "test", source: "aaaaaaaa", target: "fallback", slug: "scout", reason: "checkpoint" };
  const store = {
    boundDevice: (ws) => ws === source ? "aaaaaaaa" : null,
    identity: (id) => ({ deviceId: id, publicKey: "key", fresh: true }),
    latestCheckpoint: () => checkpoint,
    getServer: () => checkpoint,
    ackServer() {},
  };
  const transfers = new BrowserTransfers({ presence: p, bundles: store, fallback: {}, identity: {}, now: () => now,
    restore: async () => { await wait; imported = true; }, decode: async () => ({}) });
  transfers.policy(source, { autoTarget: "fallback" });
  now += 30000;
  p.sweep();
  assert.equal(p.routeFor("scout", "browser"), null, "agent cannot open a blank destination during import");
  assert.equal(imported, false);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(imported, true);
  assert.deepEqual(p.pinOf("scout", "browser"), { kind: "fallback" });
  p.heartbeat(source, { device: { id: "aaaaaaaa", name: "Source" }, hosting: { browser: true }, idleSec: 0 });
  assert.equal(p.routeFor("scout", "browser").host.kind, "fallback", "source recovery never returns the browser automatically");
  transfers.stop();
});

test("failed restore keeps the source pin and never claims transfer success", async () => {
  const p = new Presence({ browserDefault: "device", fallback: { browser: { id: "fallback", name: "Agent host" } } });
  const ws = { readyState: 1, send() {} };
  p.connect(ws);
  p.heartbeat(ws, { device: "aaaaaaaa", hosting: { browser: true }, idleSec: 0 });
  p.routeFor("scout", "browser");
  const meta = { id: "test", source: "aaaaaaaa", target: "fallback", slug: "scout", reason: "manual" };
  const bundles = { identity: () => ({ fresh: true }), getServer: () => meta, connOf: () => ws };
  const transfers = new BrowserTransfers({ presence: p, bundles, fallback: {}, identity: {},
    restore: async () => { throw new Error("restore failed"); }, decode: async () => ({}) });
  await transfers.stored(meta);
  assert.equal(p.routeFor("scout", "browser").host.id, "aaaaaaaa");
  assert.equal(transfers.pending.size, 0);
  transfers.stop();
});

test("loss without an available consented checkpoint keeps the source pinned instead of opening an empty fallback", () => {
  let now = 1000;
  const p = new Presence({ now: () => now, browserDefault: "device", fallback: { browser: { id: "fallback", name: "Agent host" } } });
  const ws = { readyState: 1, send() {} };
  p.connect(ws);
  p.heartbeat(ws, { device: "aaaaaaaa", hosting: { browser: true }, idleSec: 0 });
  p.routeFor("scout", "browser");
  const bundles = { latestCheckpoint: () => null };
  const transfers = new BrowserTransfers({ presence: p, bundles, fallback: {}, identity: {} });
  now += 30000;
  p.sweep();
  assert.equal(p.routeFor("scout", "browser"), null);
  assert.equal(p.pinOf("scout", "browser").id, "aaaaaaaa");
  transfers.stop();
});

test("apply refuses an expired or revoked bundle before exposing the target route", async () => {
  const p = new Presence({ browserDefault: "device", fallback: { browser: { id: "fallback", name: "Agent host" } } });
  const ws = { readyState: 1, send() {} };
  p.connect(ws);
  p.heartbeat(ws, { device: "aaaaaaaa", hosting: { browser: true }, idleSec: 0 });
  p.routeFor("scout", "browser");
  const meta = { id: "test", source: "aaaaaaaa", target: "fallback", slug: "scout", reason: "manual" };
  let reads = 0;
  const bundles = { identity: () => ({ fresh: true }), connOf: () => ws, getServer: () => { if (++reads > 1) throw new Error("bundle expired"); return meta; } };
  const transfers = new BrowserTransfers({ presence: p, bundles, fallback: {}, identity: {}, restore: async () => {}, decode: async () => ({}) });
  await transfers.stored(meta);
  assert.equal(p.routeFor("scout", "browser").host.id, "aaaaaaaa");
  assert.equal(transfers.pending.size, 0);
  transfers.stop();
});

test("sleep imports the consented checkpoint after the fresh-export grace period", async () => {
  const p = new Presence({ browserDefault: "device", fallback: { browser: { id: "fallback", name: "Agent host" } } });
  const ws = { readyState: 1, send() {} };
  p.connect(ws);
  p.heartbeat(ws, { device: "aaaaaaaa", hosting: { browser: true }, idleSec: 0 });
  p.routeFor("scout", "browser");
  const meta = { id: "test", source: "aaaaaaaa", target: "fallback", slug: "scout", reason: "checkpoint" };
  let imports = 0;
  const bundles = { identity: () => ({ fresh: true }), boundDevice: () => "aaaaaaaa", latestCheckpoint: () => meta,
    getServer: () => meta, ackServer() {}, connOf: () => ws };
  const transfers = new BrowserTransfers({ presence: p, bundles, fallback: {}, identity: {}, restore: async () => { imports++; }, decode: async () => ({}) });
  transfers.policy(ws, { autoTarget: "fallback" });
  p.heartbeat(ws, { device: "aaaaaaaa", hosting: { browser: true }, idleSec: 0, locked: true, asleep: true });
  assert.equal(imports, 0, "the source may still upload a fresh sleep snapshot before fallback");
  await new Promise((resolve) => setTimeout(resolve, 3100));
  assert.equal(imports, 1);
  assert.equal(p.pinOf("scout", "browser").kind, "fallback");
  transfers.stop();
});

test("moving an attached external browser's session away never kills it, and its gate is lifted", async () => {
  const p = new Presence({ fallback: { browser: { id: "fallback", name: "Agent host", agents: ["scout"] } } });
  const ws = { readyState: 1, send() {} };
  p.connect(ws);
  p.heartbeat(ws, { device: "aaaaaaaa", hosting: { browser: true }, idleSec: 0 });
  assert.equal(p.routeFor("scout", "browser").host.kind, "fallback", "agent host first by default");
  let killed = false;
  const external = { slug: "scout", status: "running", external: true, proc: null, transferring: true };
  const fallback = { peek: () => external };
  const meta = { id: "test", source: "fallback", target: "aaaaaaaa", slug: "scout", reason: "manual" };
  const bundles = { identity: () => ({ fresh: true }), get: () => meta, ack() {}, boundDevice: () => "aaaaaaaa", connOf: () => ws };
  const transfers = new BrowserTransfers({ presence: p, bundles, fallback, identity: {}, restore: async () => {}, decode: async () => ({}) });
  assert.ok(p.holdTransfer("scout", "browser"));
  transfers.pending.set("scout", { ...meta, timer: setTimeout(() => {}, 1) });
  transfers.applied(ws, "test");
  assert.equal(p.routeFor("scout", "browser").host.id, "aaaaaaaa", "the session moved to the user's own computer");
  assert.equal(external.transferring, false, "an attached browser is released, not closed");
  assert.equal(killed, false);
  transfers.stop();
});
