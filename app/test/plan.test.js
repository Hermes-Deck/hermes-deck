"use strict";
// The Plan tab's relay path: RelayClient.plan() reads GET /session/<sid>/plan from the real relay server (a fixture
// model, no state.db) and answers a null plan for an unknown session or an older relay without the route.
//   node --test "app/test/*.test.js"
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { RelayClient } = require("../main/relay");
const { Model } = require("../../relay/src/model");
const { createServer } = require("../../relay/src/server");

const TOKEN = "fixture-token-123456789012345";
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((r) => server.close(r));

test("RelayClient.plan: the live plan from the relay; null for an unknown session; bad ids never leave the app", async () => {
  const model = new Model({ profiles: {} });
  model.apply({ ev: "turn_start", sid: "s-1", profile: "default", ts: 1 }, true);
  model.apply({ ev: "plan", sid: "s-1", profile: "default", ts: 2, source: "omh", rev: 7, items: [{ id: "1", text: "Ship it", state: "active", depth: 0, phase: "II. Build" }] }, true);
  const { server } = createServer({ token: TOKEN, model, fleet: { data: {} }, version: "test" });
  const url = await listen(server);
  try {
    const c = new RelayClient({ url, token: TOKEN });
    const r = await c.plan("s-1");
    assert.deepEqual(r, { sid: "s-1", stored: false, plan: { source: "omh", rev: 7, ts: 2, items: [{ id: "1", text: "Ship it", state: "active", depth: 0, phase: "II. Build" }] } });
    assert.deepEqual(await c.plan("s-unknown"), { sid: "s-unknown", plan: null, stored: false });
    await assert.rejects(c.plan("a b"), /bad session id/);
    await assert.rejects(c.plan(""), /bad session id/);
  } finally {
    await close(server);
  }
});

test("RelayClient.plan: an older relay without the route answers 404 -> no plan; other failures still throw", async () => {
  let code = 404;
  const server = http.createServer((_req, res) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end("{}");
  });
  const url = await listen(server);
  try {
    const c = new RelayClient({ url, token: TOKEN });
    assert.deepEqual(await c.plan("s-1"), { sid: "s-1", plan: null, stored: false });
    code = 503;
    await assert.rejects(c.plan("s-1"), /HTTP 503/);
  } finally {
    await close(server);
  }
});
