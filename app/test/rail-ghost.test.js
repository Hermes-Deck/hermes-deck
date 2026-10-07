"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { BridgeClient } = require("../main/bridge");

function bridgeWorld() {
  const c = new BridgeClient({ mode: "off" });
  c.conn = { ready: true };
  c.snapshot = { nodes: [] };
  const calls = [];
  c.request = async (method, params) => {
    calls.push([method, params]);
    if (method === "session.create") return { session_id: "rpc-new", stored_session_id: "stored-new" };
    return { status: "streaming", closed: true };
  };
  return { c, calls };
}

test("discard releases an untouched new session by runtime id and tombstones both ids", async () => {
  const { c, calls } = bridgeWorld();
  const { sid } = await c.create();
  assert.deepEqual(await c.discard(sid), { discarded: sid });
  assert.deepEqual(calls.at(-1), ["session.close", { session_id: "rpc-new" }]);
  for (const map of [c.nodes, c.created, c.bindings]) assert.equal(map.has(JSON.stringify(["default", sid])), false);
  assert.equal(c.rpcToStored.has("rpc-new"), false);
  assert.equal(c.deleted.has(JSON.stringify(["default", sid])), true);
  assert.equal(c.deleted.has(JSON.stringify(["default", "rpc-new"])), true);
  assert.equal(c.currentSnapshot().nodes.some((n) => n.sid === sid), false);
});

test("discard refuses a submitted session even before its first turn completes", async () => {
  const { c, calls } = bridgeWorld();
  const { sid } = await c.create();
  await c.send(sid, "hello");
  assert.deepEqual(await c.discard(sid), { discarded: null });
  assert.equal(calls.some(([method]) => method === "session.close"), false);
  assert.equal(c.nodes.has(JSON.stringify(["default", sid])), true);
});

test("snapshot-listed untouched new sessions remain discardable and late frames stay tombstoned", async () => {
  const { c } = bridgeWorld();
  const { sid } = await c.create();
  c.timing.heartbeat = 60000;
  const conn = { ready: true, timers: {} };
  const frame = { schema: "hermes-deck.v1", nodes: [{ session_id: sid, state: "idle" }] };
  try {
    c._onSnapshot(conn, frame);
    const emitted = [];
    c.on("snapshot", (snap) => emitted.push(snap));
    assert.deepEqual(await c.discard(sid), { discarded: sid });
    assert.equal(emitted.some((snap) => snap.nodes.some((n) => n.sid === sid)), false, "discard never emits the old row again");
    c._onSnapshot(conn, frame);
    assert.equal(c.nodes.has(JSON.stringify(["default", sid])), false);
    c._onSnapshot(conn, { ...frame, nodes: [{ session_id: "rpc-new", state: "idle" }] });
    assert.equal(c.nodes.has(JSON.stringify(["default", "rpc-new"])), false);
  } finally { clearTimeout(conn.timers.heartbeat); }
});

test("a turn observed outside Deck protects a fresh session from discard", async () => {
  const { c, calls } = bridgeWorld();
  const { sid } = await c.create();
  c._onServerFrame({ method: "event", params: { type: "message.start", session_id: "rpc-new", payload: {} } });
  assert.deepEqual(await c.discard(sid), { discarded: null });
  assert.equal(calls.some(([method]) => method === "session.close"), false);
});

test("discard does not release Bot Chats, stored branches or unknown ids", async () => {
  const { c, calls } = bridgeWorld();
  c._created({ session_id: "rpc-bot", stored_session_id: "bot" }, "default", c.epoch, "Bot Chat");
  c._created({ session_id: "rpc-branch", stored_session_id: "branch" }, "default", c.epoch, "");
  for (const sid of ["bot", "branch", "unknown"]) assert.deepEqual(await c.discard(sid), { discarded: null });
  assert.equal(calls.length, 0);
});
