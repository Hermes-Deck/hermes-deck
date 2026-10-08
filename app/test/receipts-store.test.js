"use strict";
// Receipt ledger bounds and honest timing (receipts.js createStore / stats).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const R = require("../renderer/receipts");

test("total retained calls per session are bounded across turns and imports", () => {
  const s = R.createStore();
  for (let turn = 0; turn < 40; turn++) {
    s.event("s", "message.start", {}, turn * 100000);
    for (let i = 0; i < 20; i++) s.event("s", "tool.start", { tool_id: `t${turn}-${i}`, name: "x" }, turn * 100000 + i);
    s.event("s", "message.complete", {}, turn * 100000 + 50000);
  }
  for (let batch = 0; batch < 5; batch++) s.replace("s", Array.from({ length: 30 }, (_, i) => ({ call: `h${batch}-${i}`, tool: "x", ts: 1 + batch, status: "ok" })), 9e9);
  const total = s.turns("s").reduce((n, t) => n + t.calls.length, 0);
  assert.ok(total <= R.MAX_CALLS, `${total} calls retained`);
  assert.ok(s.turns("s").every(t => t.calls.length > 0), "turns emptied by the bound are dropped");
  assert.ok(s.find("s", "t39-19"), "the newest calls are kept");
});

test("calls imported from before the active turn are not attached to it", () => {
  const s = R.createStore();
  s.event("s", "local.sent", {}, 100_000);
  s.event("s", "tool.start", { tool_id: "live", name: "terminal" }, 101_000);
  s.replace("s", [{ call: "old", tool: "read_file", ts: 50, status: "ok", ms: 5 }, { call: "live", tool: "terminal", ts: 101, status: "running" }], 102_000);
  const active = s.turns("s").at(-1);
  assert.deepEqual(active.calls.map(c => c.call), ["live"]);
  const old = s.find("s", "old").turn;
  assert.notEqual(old, active);
  assert.equal(old.end != null, true, "the historical group is closed");
  assert.ok(s.turns("s").indexOf(old) < s.turns("s").indexOf(active), "history sorts before the live turn");
});

test("imported history carries no measured turn duration", () => {
  const s = R.createStore();
  s.replace("s", [{ call: "a", tool: "x", ts: 10, status: "ok", ms: 2000 }, { call: "b", tool: "y", ts: 40, status: "error", ms: 1000 }], 99_000);
  const turn = s.turns("s")[0];
  assert.equal(turn.measured, false);
  const totals = R.stats(turn, 999_999);
  assert.equal(totals.seconds, null, "no fabricated Worked Ns for an imported group");
  assert.equal(totals.tools, 2); assert.equal(totals.failed, 1);
  const h = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(Boolean) });
  const I18N = require("../renderer/i18n");
  if (!Object.prototype.hasOwnProperty.call(I18N.tables.en, "conv.stop")) I18N.extend(require("../renderer/i18n-b"));
  const el = R.receipt({ h, t: I18N.t, sid: "s", turn, select() {} });
  const summary = JSON.stringify(el);
  assert.ok(summary.includes("2 tools"), summary.slice(0, 200));
  assert.ok(!/Worked \d/.test(summary));
});

test("a live turn's duration is measured from its own start and end", () => {
  const s = R.createStore();
  s.event("s", "message.start", {}, 1000);
  s.event("s", "tool.start", { tool_id: "a", name: "x" }, 2000);
  s.event("s", "message.complete", {}, 42000);
  assert.equal(s.turns("s")[0].measured, true);
  assert.equal(R.stats(s.turns("s")[0]).seconds, 41);
});

test("finishing a turn marks still-running calls as stopped without inventing a duration", () => {
  const s = R.createStore();
  s.event("s", "message.start", {}, 1000);
  s.event("s", "tool.start", { tool_id: "a", name: "x" }, 2000);
  s.event("s", "local.stopped", {}, 5000);
  const call = s.find("s", "a").call;
  assert.equal(call.status, "interrupted");
  assert.equal(call.ms, null);
});

test("sessions are bounded", () => {
  const s = R.createStore();
  for (let i = 0; i < R.MAX_SESSIONS + 10; i++) s.event(`s${i}`, "tool.start", { tool_id: "a", name: "x" }, i);
  assert.equal(s.sessions(), R.MAX_SESSIONS);
});
