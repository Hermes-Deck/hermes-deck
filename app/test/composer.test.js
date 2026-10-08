"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
test("entrance tracking skips history and never replays a block on rebuild or pagination", () => {
  const tracker = C.createEntranceTracker();
  const first = tracker.assign("s", ["u1", "a1"]);
  assert.deepEqual(first.fresh, []);
  const appended = tracker.assign("s", ["u1", "a1", "a2"]);
  assert.deepEqual(appended.ids.slice(0, 2), first.ids, "aligned blocks keep their identity");
  assert.equal(appended.fresh.length, 1);
  assert.equal(appended.fresh[0], appended.ids[2]);
  assert.deepEqual(tracker.scan("s", ["u1", "a1", "a2"]), []);
  const paged = tracker.assign("s", ["old", "u1", "a1", "a2"], false);
  assert.deepEqual(paged.fresh, []);
  assert.deepEqual(paged.ids.slice(1), appended.ids, "a prepended page keeps the later ids");
  assert.deepEqual(tracker.scan("other", ["new"]), []);
  assert.deepEqual(tracker.scan("s", ["old", "u1", "a1", "a2"]), []);
});
test("relocation moves approval and queue nodes without replacing their action handlers", () => {
  let called = 0;
  const approval = { onclick() { called++; } }, queued = { onclick() { called++; } };
  const inner = { querySelectorAll(s) { return s === ".hreq" ? [approval] : [queued]; } };
  const tray = { replaceChildren(...kids) { this.kids = kids; } }, queue = { replaceChildren(...kids) { this.kids = kids; } };
  C.relocate(inner, tray, queue);
  assert.equal(tray.kids[0], approval); assert.equal(queue.kids[0], queued);
  tray.kids[0].onclick(); queue.kids[0].onclick(); assert.equal(called, 2);
});
const C = require("../renderer/composer");
test("via line distinguishes direct, Telegram, gateway and sub-agent routes", () => {
  assert.deepEqual(C.via({ channel: "hermes", profile: "lab" }), { key: "conv.direct", vars: { profile: "lab" } });
  assert.deepEqual(C.via({ channel: "telegram" }, { bot: "ExampleBot" }), { key: "conv.telegram", vars: { bot: "ExampleBot" } });
  assert.equal(C.via({ channel: "readonly" }).key, "conv.readonly");
  assert.deepEqual(C.via({ channel: "sub", id: "s" }, { title: "Review" }), { key: "conv.subagent", vars: { agent: "Review" } });
});
