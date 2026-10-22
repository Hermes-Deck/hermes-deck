"use strict";
// One receipt per user turn (receipts.js): a session watched from here (a sub-agent, a TUI or Telegram run) gets its
// calls only from deck.tools pushes, one new call at a time. They must sum up as ONE receipt after the work stretch,
// never as a pile of "1 tools" rows under it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const R = require("../renderer/receipts");
const { boot } = require("./composer-dom-helper");

const call = (id, ts, status = "ok") => ({ call: id, tool: "terminal", args: `cmd ${id}`, ts, status, ms: status === "running" ? null : 5 });

test("deck.tools pushes of a watched session join one history group, not one group per push", () => {
  const s = R.createStore();
  const rows = [];
  for (let i = 0; i < 6; i++) {
    rows.push(call(`c${i}`, 100 + i, "running"));
    s.replace("s", rows.map(r => ({ ...r })), (101 + i) * 1000);
    rows[i] = call(`c${i}`, 100 + i);
    s.replace("s", rows.map(r => ({ ...r })), (101.5 + i) * 1000);
  }
  const groups = s.turns("s");
  assert.equal(groups.length, 1, `one history group, got ${groups.map(t => t.calls.length).join("+")}`);
  assert.deepEqual(groups[0].calls.map(c => c.call), ["c0", "c1", "c2", "c3", "c4", "c5"]);
  assert.notEqual(groups[0].end, null, "closed once no call runs");
  s.replace("s", [...rows, call("c6", 107, "running")], 108_000);
  assert.equal(s.turns("s").length, 1);
  assert.equal(s.turns("s")[0].end, null, "a new running call reopens the group (it waits again)");
});

test("a watched session's work stretch gets one receipt after it, not a pile of 1-tool receipts", () => {
  const env = boot();
  env.inner.replaceChildren(env.user("do the task", { dataset: { ts: "99" } }));
  const rows = [];
  for (let i = 0; i < 5; i++) {
    env.inner.append(env.agent(`step ${i}`, { class: "msg step work" }));
    rows.push(call(`c${i}`, 100 + i, "running"));
    env.bridgeEvent({ t: "event", type: "deck.tools", sid: "s", payload: { tools: rows.map(r => ({ ...r })) } });
    env.flush();
    rows[i] = call(`c${i}`, 100 + i);
    env.bridgeEvent({ t: "event", type: "deck.tools", sid: "s", payload: { tools: rows.map(r => ({ ...r })) } });
    env.flush();
  }
  const receipts = env.inner.querySelectorAll(".receipt");
  assert.equal(receipts.length, 1, "one receipt for the one user turn");
  assert.equal(receipts[0].querySelectorAll(".receipt-call").length, 5);
  assert.equal(receipts[0].querySelector(".receipt-summary").textContent, "5 tools");
  const order = env.inner.children.map(el => el.classList.contains("receipt") ? "R" : el.textContent);
  assert.deepEqual(order, ["do the task", "step 0", "step 1", "step 2", "step 3", "step 4", "R"]);
});

test("turns that share one user message (snapshot turns, imports, Deck turns) are summed in one receipt", () => {
  const env = boot();
  env.inner.replaceChildren(env.user("go", { dataset: { ts: "99" } }), env.agent("step", { class: "msg step work" }));
  // a history group, then two turns the snapshot saw run and end, all after the same user message
  env.bridgeEvent({ t: "event", type: "deck.tools", sid: "s", payload: { tools: [call("a", 100)] } });
  env.bridgeEvent({ t: "snapshot", snapshot: { nodes: [{ sid: "s", state: "working", turnId: "t1", terminalAt: null }] } });
  env.bridgeEvent({ t: "event", type: "deck.tools", sid: "s", payload: { tools: [call("a", 100), call("b", env.clock / 1000 + 1)] } });
  env.bridgeEvent({ t: "snapshot", snapshot: { nodes: [{ sid: "s", state: "working", turnId: "t2", terminalAt: null }] } });
  env.clock += 5000;
  env.bridgeEvent({ t: "event", type: "deck.tools", sid: "s", payload: { tools: [call("a", 100), call("b", env.clock / 1000 - 4), call("c", env.clock / 1000)] } });
  env.bridgeEvent({ t: "snapshot", snapshot: { nodes: [{ sid: "s", state: "idle", turnId: "t2", terminalAt: 1 }] } });
  env.flush();
  assert.ok(R.createStore, "store loaded");
  assert.ok(env.win.DeckReceipts.turns("s").length >= 2, "the store keeps its turns apart");
  const receipts = env.inner.querySelectorAll(".receipt");
  assert.equal(receipts.length, 1, "one receipt for the user turn");
  assert.deepEqual(receipts[0].querySelectorAll(".receipt-call").map(el => el.dataset.call), ["a", "b", "c"]);
  assert.equal(receipts[0].querySelector(".receipt-summary").textContent, "3 tools");
});

test("while a merged user turn still runs in a Hermes chat its receipt waits for the end", () => {
  const env = boot();
  env.inner.replaceChildren(env.user("go", { dataset: { ts: "99" } }), env.agent("step", { class: "msg step work" }));
  env.bridgeEvent({ t: "event", type: "deck.tools", sid: "s", payload: { tools: [call("a", 100)] } });
  env.bridgeEvent({ t: "snapshot", snapshot: { nodes: [{ sid: "s", state: "working", turnId: "t1", terminalAt: null }] } });
  env.flush();
  assert.equal(env.inner.querySelectorAll(".receipt").length, 0, "the user turn is still running");
  env.bridgeEvent({ t: "snapshot", snapshot: { nodes: [{ sid: "s", state: "idle", turnId: "t1", terminalAt: 1 }] } });
  env.flush();
  assert.equal(env.inner.querySelectorAll(".receipt").length, 1);
});

test("one tool reads \"1 tool\" in English; Turkish keeps \"araç\"", () => {
  const I18N = require("../renderer/i18n");
  if (!Object.prototype.hasOwnProperty.call(I18N.tables.en, "conv.stop")) I18N.extend(require("../renderer/i18n-b"));
  const h = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(Boolean) });
  const one = { id: "r", since: 0, end: 4000, calls: [call("a", 1)], measured: true };
  const many = { ...one, calls: [call("a", 1), call("b", 2)] };
  const label = turn => JSON.stringify(R.receipt({ h, t: I18N.t, sid: "s", turn, select() {} }));
  try {
    I18N.setLanguage("en");
    assert.ok(label(one).includes("Worked 4.0s · 1 tool\""), label(one).slice(0, 300));
    assert.ok(label(many).includes("Worked 4.0s · 2 tools"));
    assert.ok(label({ ...one, measured: false }).includes("\"1 tool\""));
    assert.ok(label({ ...one, end: null }).includes("Working · 1 tool\""));
    I18N.setLanguage("tr");
    assert.ok(label({ ...one, measured: false }).includes("\"1 araç\""));
  } finally { I18N.setLanguage("en"); }
});
