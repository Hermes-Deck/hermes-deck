"use strict";
// Single-host approval lifecycle, pinned before multi-host work changes the store.
const test = require("node:test");
const assert = require("node:assert/strict");
const I = require("../renderer/inbox");

const h = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat(Infinity).filter(x => x != null) });
const walk = node => [node, ...(node.children || []).filter(x => typeof x === "object").flatMap(walk)];
const buttons = (store, row) => walk(I.requestBody({ h, store, t: k => k, forms: new Map(), redraw() {} }, row)).filter(n => n.tag === "button");
const approval = (id, extra = {}) => ({ id, sid: "s-1", profile: "default", kind: "approval", choices: ["once", "deny"], ...extra });

test("approval buttons go inert when the connection drops and come back when it reopens", () => {
  const store = I.createStore();
  store.feedBridge({ t: "status", status: "open" });
  store.feedBridge({ t: "requests", list: [approval("req-1")] });
  const row = store.items()[0];
  assert.ok(buttons(store, row).every(b => !b.attrs.disabled));
  store.feedBridge({ t: "status", status: "connecting" });
  assert.equal(store.items().length, 0, "a dropped connection clears live requests");
  assert.ok(buttons(store, row).every(b => b.attrs.disabled), "a stale card cannot be answered");
});

test("no answer leaves while the connection is down", async () => {
  let calls = 0;
  const store = I.createStore({ bridge: { answerApproval: async () => { calls++; return { status: "ok" }; } } });
  store.feedBridge({ t: "status", status: "open" });
  store.feedBridge({ t: "requests", list: [approval("req-1")] });
  const row = store.items()[0];
  store.feedBridge({ t: "status", status: "closed" });
  assert.equal(await store.answer(row, "once"), false);
  assert.equal(calls, 0);
});

test("an answer with an unknown outcome is not sent again, even when the host lists the request again", async () => {
  let calls = 0;
  const store = I.createStore({ bridge: { answerApproval: async () => { calls++; throw new Error("timed out"); } } });
  store.feedBridge({ t: "status", status: "open" });
  store.feedBridge({ t: "requests", list: [approval("req-1")] });
  const row = store.items()[0];
  assert.equal(await store.answer(row, "once"), false);
  store.feedBridge({ t: "requests", list: [approval("req-1")] });
  assert.equal(calls, 1, "nothing retries on its own");
  assert.equal(await store.answer(row, "once"), false, "the old row is bound to the old request object");
  assert.equal(calls, 1);
});

test("a card answered on another device leaves when the host stops listing it", () => {
  const store = I.createStore();
  store.feedBridge({ t: "status", status: "open" });
  store.feedBridge({ t: "requests", list: [approval("req-1"), approval("req-2", { sid: "s-2" })] });
  assert.equal(store.items().length, 2);
  store.feedBridge({ t: "requests", list: [approval("req-2", { sid: "s-2" })] });
  assert.deepEqual(store.items().map(r => r.id), ["req-2"]);
});

test("a duplicate request id is refused instead of guessing the target", async () => {
  let calls = 0;
  const store = I.createStore({ bridge: { answerApproval: async () => { calls++; return { status: "ok" }; } } });
  store.feedBridge({ t: "status", status: "open" });
  store.feedBridge({ t: "requests", list: [approval("req-1"), approval("req-1", { profile: "work" })] });
  assert.equal(store.items().length, 2, "both cards show, keyed apart");
  assert.notEqual(store.items()[0].key, store.items()[1].key);
  assert.equal(await store.answer(store.items()[0], "once"), false);
  assert.equal(calls, 0);
});

test("only an advertised choice is sent", async () => {
  const sent = [];
  const store = I.createStore({ bridge: { answerApproval: async (id, v) => { sent.push([id, v]); return { status: "ok" }; } } });
  store.feedBridge({ t: "status", status: "open" });
  store.feedBridge({ t: "requests", list: [approval("req-1")] });
  const row = store.items()[0];
  assert.equal(await store.answer(row, "always"), false);
  assert.equal(await store.answer(row, "deny"), true);
  assert.deepEqual(sent, [["req-1", "deny"]]);
});
