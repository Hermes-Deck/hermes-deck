"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const bridge = require("../main/bridge");

test("Telegram profile-only inventory never resumes a TUI copy", async () => {
  const c = Object.create(bridge.BridgeClient.prototype);
  c.nodes = new Map([["s-tg", { sid: "s-tg", profile: "lab", source: "telegram" }]]);
  const calls = [];
  c._bind = () => assert.fail("TUI copy must not be resumed");
  c.request = async (method, params) => { calls.push([method, params]); return { providers: [] }; };
  await c.modelOptions("s-tg", { profile: "lab", profileOnly: true });
  assert.deepEqual(calls, [["model.options", { profile: "lab", include_unconfigured: false, refresh: false }]]);
});

test("profile inventory preserves native bracket model ids", () => {
  const projected = bridge.projectModelOptions({ provider: "anthropic", model: "claude-opus-5-5[1m]", providers: [
    { slug: "anthropic", authenticated: true, models: ["claude-opus-5-5[1m]"] },
  ] });
  assert.equal(projected.options[0]?.id, "claude-opus-5-5[1m]");
});

test("removed private messaging mutation is not allowlisted or projected", () => {
  assert.throws(() => bridge.checkRequest("deck.gateway_session_set", { session_id: "s", model: "m", provider: "p" }));
  assert.equal(bridge.validGatewaySessionSet, undefined);
  const snap = bridge.normalizeSnapshot({ schema: "hermes-deck.v1", online: true, nodes: [{ session_id: "s", gateway_session_available: true }] });
  assert.equal("gatewaySessionAvailable" in snap.nodes[0], false);
});

test("IPC retains profileOnly only for model inventory, not mutations", async () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const src = fs.readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  const callbacks = new Map(), calls = [];
  const start = src.indexOf('ipc.handle("bridge:model-options"');
  const end = src.indexOf('ipc.handle("bridge:answer-approval"', start);
  const api = Object.fromEntries(["modelOptions", "setModel", "setEffort"].map((method) => [method, async (sid, opts) => calls.push([method, sid, opts])]));
  vm.runInNewContext(src.slice(start, end), { ipc: { handle: (name, fn) => callbacks.set(name, fn) }, needBridge: () => api,
    bSid: (x) => x, bObj: (x) => x || {}, bProfile: (x) => x?.profile });
  for (const profileOnly of [true, false, "true"]) {
    await callbacks.get("bridge:model-options")(null, "s-tg", { profile: "lab", profileOnly });
    assert.equal(calls.at(-1)[2].profileOnly, profileOnly === true);
  }
  for (const name of ["bridge:set-model", "bridge:set-effort"]) {
    await callbacks.get(name)(null, "s", { model: "m", provider: "p", effort: "high", messaging: true });
    assert.equal("messaging" in calls.at(-1)[2], false);
  }
});
