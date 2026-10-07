"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function world({ failClose = false } = {}) {
  const ctx = { module: { exports: {} } };
  const source = path.join(__dirname, "../renderer/rail-sessions.js");
  if (fs.existsSync(source)) vm.runInNewContext(fs.readFileSync(source, "utf8"), ctx);
  const calls = [], intents = new Set();
  const api = ctx.module.exports.create;
  assert.equal(typeof api, "function", "rail session lifecycle exists");
  const rg = api({ hasIntent: (sid) => intents.has(sid), forget: (sid) => calls.push(["forget", sid]), discard: async (sid) => { calls.push(["close", sid]); if (failClose) throw new Error("offline"); } });
  return { rg, calls, intents };
}

test("leaving preserves drafts, attachments, queued messages and submitted intent", async () => {
  const { rg, calls, intents } = world();
  for (const sid of ["draft", "files", "queue", "sent"]) rg.track(sid, "default");
  for (const sid of ["draft", "files", "queue"]) intents.add(sid);
  rg.submit("sent");
  for (const sid of ["draft", "files", "queue", "sent"]) {
    assert.equal(rg.reusable(sid, "default"), false);
    assert.equal(await rg.leave(sid), false);
  }
  await rg.close();
  assert.deepEqual(calls, []);
});

test("reuse is profile scoped and failed close still hides the untouched session", async () => {
  const { rg } = world({ failClose: true });
  rg.track("new", "work");
  assert.equal(rg.reusable("new", "default"), false);
  assert.equal(rg.reusable("new", "work"), true);
  await rg.leave("new");
  assert.equal(rg.reusable("new", "work"), false);
});

test("bridge refusal restores a row if a turn won the navigation race", async () => {
  const ctx = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/rail-sessions.js"), "utf8"), ctx);
  let restored = false;
  const rg = ctx.module.exports.create({ hasIntent: () => false, forget: () => () => { restored = true; }, discard: async () => ({ discarded: null }) });
  rg.track("raced", "default");
  assert.equal(await rg.leave("raced"), false);
  assert.equal(restored, true);
  assert.equal(rg.reusable("raced", "default"), false);
});

test("close waits for a pending New session RPC and releases its untouched result", async () => {
  const ctx = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/rail-sessions.js"), "utf8"), ctx);
  const calls = [];
  let resolve;
  const rg = ctx.module.exports.create({ hasIntent: () => false, forget: (sid) => calls.push(["forget", sid]),
    discard: async (sid) => calls.push(["close", sid]), create: () => new Promise((r) => { resolve = r; }) });
  const minted = rg.mint("default");
  const closing = rg.close();
  resolve({ sid: "late", profile: "default" });
  await minted; await closing;
  assert.deepEqual(calls, [["forget", "late"], ["close", "late"]]);
});

test("unload resumes the host's original reload or close action", async () => {
  const ctx = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/rail-sessions.js"), "utf8"), ctx);
  let resumed = 0, closed = 0, onUnload;
  const rg = ctx.module.exports.create({ hasIntent: () => false, forget() {}, discard: async () => ({ discarded: "empty" }), resumeUnload: () => { resumed++; } });
  rg.track("empty", "default");
  rg.bindUnload({ addEventListener: (_name, fn) => { onUnload = fn; }, close: () => { closed++; } });
  onUnload({ preventDefault() {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(resumed, 1);
  assert.equal(closed, 0, "a reload must not be replaced with window.close");
});

test("window close waits for discard without closing a draft session", async () => {
  const { rg, calls, intents } = world();
  const handlers = {};
  let closed = 0;
  rg.track("empty", "default"); rg.track("draft", "default"); intents.add("draft");
  rg.bindUnload({ addEventListener: (name, fn) => { handlers[name] = fn; }, close: () => { closed++; } });
  let prevented = false;
  const event = { preventDefault: () => { prevented = true; } };
  handlers.beforeunload(event);
  assert.equal(prevented, true);
  assert.equal(closed, 0);
  await new Promise((r) => setImmediate(r));
  assert.equal(closed, 1);
  assert.deepEqual(calls, [["forget", "empty"], ["close", "empty"]]);
  prevented = false;
  handlers.beforeunload(event);
  assert.equal(prevented, false, "second close passes without a loop");
});

test("leaving an untouched new session hides it before the close reply", async () => {
  const { rg, calls } = world();
  rg.track("new", "default");
  assert.equal(rg.reusable("new", "default"), true);
  const pending = rg.leave("new");
  assert.deepEqual(calls[0], ["forget", "new"]);
  await pending;
  assert.deepEqual(calls[1], ["close", "new"]);
  assert.equal(rg.reusable("new", "default"), false);
});
