"use strict";
// Receipt anchoring and bridge snapshot lifecycle (receipts.js), pure store and mounted.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const R = require("../renderer/receipts");
const { boot } = require("./composer-dom-helper");

const live = (extra = {}) => ({ sid: "s", state: "working", turnId: "t1", terminalAt: null, ...extra });
const idle = (extra = {}) => ({ sid: "s", state: "idle", turnId: "t1", terminalAt: 5, ...extra });

test("a turn driven elsewhere starts from the snapshot, absorbs its running import and ends once when idle", () => {
  const s = R.createStore();
  s.replace("s", [{ call: "a", tool: "terminal", ts: 10, status: "running" }], 11_000);
  assert.equal(s.turns("s")[0].imported, true);
  assert.equal(s.observe("s", live(), 12_000), true);
  const turn = s.active("s");
  assert.equal(turn.measured, false);
  assert.deepEqual(turn.calls.map(c => c.call), ["a"], "the running import joins the live turn");
  assert.equal(turn.open, false, "folded: the transcript shows the calls");
  s.replace("s", [{ call: "a", tool: "terminal", ts: 10, status: "ok", ms: 3 }, { call: "b", tool: "read", ts: 13, status: "running" }], 14_000);
  assert.deepEqual(turn.calls.map(c => c.call), ["a", "b"]);
  assert.equal(turn.end, null, "a completed import does not fold a live turn early");
  assert.equal(s.observe("s", live(), 15_000), false, "same turn: no change");
  assert.equal(s.observe("s", idle(), 16_000), true);
  assert.equal(turn.end, 16_000); assert.equal(turn.open, false);
  assert.equal(s.find("s", "b").call.status, "interrupted");
  assert.equal(s.observe("s", idle(), 17_000), false, "folds once");
  assert.equal(R.stats(turn).seconds, null, "start not observed: no duration claimed");
});

test("a newer turn id rolls an elsewhere-driven turn over", () => {
  const s = R.createStore();
  s.observe("s", live(), 1000);
  s.replace("s", [{ call: "a", tool: "x", ts: 1.5, status: "running" }], 2000);
  s.observe("s", live({ turnId: "t2" }), 3000);
  assert.equal(s.turns("s").length, 2);
  assert.equal(s.turns("s")[0].end, 3000);
  assert.equal(s.active("s").turnId, "t2");
});

test("a lagging idle snapshot right after the Deck's own send does not fold the new turn", () => {
  const s = R.createStore();
  s.event("s", "local.sent", {}, 1000);
  s.event("s", "tool.start", { tool_id: "a", name: "x" }, 1100);
  assert.equal(s.observe("s", idle(), 1200), false);
  assert.equal(s.active("s").end, null);
  s.observe("s", live({ turnId: "t9" }), 1300);
  s.observe("s", live({ turnId: "t9" }), 1400);
  assert.equal(s.active("s").measured, true, "a Deck turn keeps its measured clock");
  assert.equal(s.observe("s", idle({ turnId: "t9" }), 9000), true, "no message.complete arrived: the snapshot folds it");
  assert.equal(R.stats(s.turns("s")[0]).seconds, 8);
});

test("a dropped link ends live turns in every session and a reconnect resumes a still-running one", () => {
  const s = R.createStore();
  s.event("a", "message.start", {}, 1000); s.event("a", "tool.start", { tool_id: "x", name: "x" }, 1100);
  s.observe("a", live({ sid: "a" }), 1200);
  s.observe("b", live({ sid: "b", turnId: "tb" }), 1200);
  s.replace("b", [{ call: "y", tool: "y", ts: 1.3, status: "running" }], 1300);
  assert.equal(s.disconnect(2000), true);
  assert.equal(s.active("a"), null); assert.equal(s.active("b"), null);
  assert.equal(s.find("a", "x").call.status, "unknown");
  assert.equal(R.failed(s.find("a", "x").call), false, "a lost call is not a failure");
  assert.equal(s.observe("b", live({ sid: "b", turnId: "tb" }), 3000), true);
  assert.ok(s.active("b"), "the still-running turn is live again");
  assert.equal(s.active("b").open, false, "a reconnect does not unfold it");
  assert.equal(s.find("b", "y").call.status, "running");
  s.replace("b", [{ call: "y", tool: "y", ts: 1.3, status: "ok", ms: 4 }], 3100);
  assert.equal(s.find("b", "y").call.status, "ok");
});

test("imported history is split by user-message time and hidden without timestamps", () => {
  const env = boot();
  env.inner.replaceChildren(env.user("first", { dataset: { ts: "100" } }), env.agent("one"), env.user("second", { dataset: { ts: "200" } }), env.agent("two"));
  env.flush();
  env.bridgeEvent({ t: "event", type: "deck.tools", sid: "s", payload: { tools: [
    { call: "a", tool: "read", ts: 110, status: "ok", ms: 1 }, { call: "b", tool: "write", ts: 210, status: "error", ms: 1 }, { call: "c", tool: "grep", ts: 220, status: "ok", ms: 1 }] } });
  env.flush();
  const order = env.inner.children.map(el => el.classList.contains("receipt") ? `R${el.querySelectorAll(".receipt-call").length}` : el.textContent);
  assert.deepEqual(order, ["first", "R1", "one", "second", "R2", "two"]);
  assert.ok(!env.inner.querySelector(".receipt-summary").textContent.includes("Worked"), "no fabricated duration");
  env.inner.replaceChildren(env.user("first"), env.agent("one"));
  env.flush();
  assert.equal(env.inner.querySelectorAll(".receipt").length, 0, "no user timestamps: no guessed association");
  assert.equal(env.win.DeckReceipts.calls("s").length, 3, "the calls stay available to Run");
});

test("a live receipt stays with its own turn when a steer message follows", () => {
  const env = boot({ session: { id: "s", sid: "s", kind: "agent", channel: "telegram", profile: "default" } }); // a relay agent view: the live receipt shows
  env.fire("deck-conversation-turn", { sid: "s", type: "local.sent", payload: {}, at: env.clock });
  env.inner.append(env.user("go"));
  env.flush();
  env.fire("deck-conversation-turn", { sid: "s", type: "tool.start", payload: { tool_id: "a", name: "x" }, at: env.clock });
  env.flush();
  env.inner.append(env.user("also do this"));
  env.flush();
  const order = env.inner.children.map(el => el.classList.contains("receipt") ? "R" : el.textContent);
  assert.deepEqual(order, ["hello", "reply", "go", "R", "also do this"]);
});

test("a bridge snapshot shows a live receipt folded and a disconnect ends it without counting failures", () => {
  const env = boot({ session: { id: "s", sid: "s", kind: "agent", channel: "telegram", profile: "default" } }); // a relay agent view: the live receipt shows
  // Elsewhere-driven calls need the same timestamp anchor that stored transcript users carry.
  env.inner.querySelector(".msg.out").dataset.ts = String(env.clock / 1000 - 1);
  env.bridgeEvent({ t: "snapshot", snapshot: { nodes: [live()] } });
  env.bridgeEvent({ t: "event", type: "deck.tools", sid: "s", payload: { tools: [{ call: "a", tool: "x", ts: env.clock / 1000, status: "running" }] } });
  env.flush();
  assert.ok(env.inner.querySelector(".receipt.running"));
  assert.ok(!env.inner.querySelector(".receipt-fold").open, "a live receipt is a folded summary");
  env.bridgeEvent({ t: "status", status: "closed" });
  env.flush();
  assert.equal(env.inner.querySelector(".receipt.running"), null);
  assert.equal(env.inner.querySelector(".receipt").dataset.failed, "false");
  assert.ok(!env.inner.querySelector(".receipt-fold").open);
});

test("a Hermes chat keeps the receipt out of a running turn; after the end it sums the work up after its steps", () => {
  const env = boot();
  env.inner.replaceChildren(env.user("go"));
  env.flush();
  env.fire("deck-conversation-turn", { sid: "s", type: "local.sent", payload: {}, at: env.clock });
  env.fire("deck-conversation-turn", { sid: "s", type: "tool.start", payload: { tool_id: "a", name: "x" }, at: env.clock });
  env.inner.append(env.agent("step one", { class: "msg step work" }));
  env.flush();
  const order = () => env.inner.children.map(el => el.classList.contains("receipt") ? "R" : el.textContent);
  assert.deepEqual(order(), ["go", "step one"], "running: each call is under its thought, the live row says what runs");
  env.fire("deck-tool-reveal", { sid: "s", call: "a" });
  env.flush();
  assert.deepEqual(order(), ["go", "step one", "R"], "a call the reader clicked opens the receipt");
  assert.ok(env.inner.querySelector(".receipt-fold").open);
  env.inner.querySelector(".receipt-summary").click(); // the reader folds it again
  env.flush();
  assert.ok(!env.inner.querySelector(".receipt-fold").open);
  env.fire("deck-conversation-turn", { sid: "s", type: "tool.start", payload: { tool_id: "b", name: "y" }, at: env.clock });
  env.inner.append(env.agent("note", { class: "msg work" }), env.agent("step two", { class: "msg step work" }), env.agent("answer"));
  env.fire("deck-conversation-turn", { sid: "s", type: "message.complete", payload: {}, at: env.clock + 5000 });
  env.flush();
  assert.deepEqual(order(), ["go", "step one", "note", "step two", "R", "answer"]);
  assert.ok(!env.inner.querySelector('.receipt-call[data-call="b"]').open, "a call followed live is marked, never unfolded");
});
