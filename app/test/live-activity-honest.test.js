"use strict";
// The live row tells the truth about live reasoning (live-activity.js):
//  - a row built from the snapshot (no turn events reach this connection for the session) never says "Running X · done"
//    for a step that already finished, and never promises reasoning that will not stream here
//  - a turn whose events arrive but carry no reasoning says so after its first step instead of waiting forever
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const I18N = require("../renderer/i18n");
const LA = require("../renderer/live-activity");
if (!Object.prototype.hasOwnProperty.call(I18N.tables.en, "tview.noStream")) I18N.extend(require("../renderer/i18n-b"));
beforeEach(() => I18N.setLanguage("en"));

function element(tag, attrs, ...kids) {
  return { tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false), addEventListener() {}, isConnected: true };
}
const walk = (el) => [el, ...(el.kids || []).filter((x) => typeof x === "object").flatMap(walk)];
const textOf = (el) => (el.kids || []).map((k) => (typeof k === "string" ? k : textOf(k))).join("");
const store = () => { const m = new Map([["deck.live.thinking", "1"]]); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };

function world() {
  const clock = { t: 1_700_000_000_000 };
  const la = LA.create({ h: element, i18nText: I18N.t, ticker: () => element("span"), store: store(), now: () => clock.t });
  const row = (opts) => la.row(la.view("s", opts));
  const label = (r) => textOf(walk(r).find((n) => n.attrs.class === "la-label"));
  const note = (r) => textOf(walk(r).find((n) => n.attrs.class === "la-none") || element("p"));
  return { la, clock, row, label, note, ev: (type, p) => la.event("s", type, p) };
}

test("a snapshot step that already finished reads as thinking, not \"Running terminal · done\"", () => {
  assert.deepEqual(LA.fromNode({ state: "working", steps: ["Thinking", "terminal"] }), { phase: "tool", tool: "terminal" });
  assert.deepEqual(LA.fromNode({ state: "working", steps: ["terminal", "terminal · done"] }), { phase: "thinking", tool: "" });
  assert.deepEqual(LA.fromNode({ state: "working", steps: ["patch · failed"] }), { phase: "thinking", tool: "" });
  const w = world();
  const node = { sid: "s", turnId: "t1", state: "working", steps: ["terminal", "terminal · done"] };
  const r = w.row({ node, live: true });
  assert.equal(w.label(r), "Thinking…");
  assert.ok(!/· done/.test(JSON.stringify(r)));
});

test("a row with no turn events for this session says reasoning is not streamed here", () => {
  const w = world();
  const r = w.row({ node: { sid: "s", turnId: "t1", state: "working", steps: ["terminal"] }, live: true });
  assert.equal(w.la.view("s", { node: { sid: "s", state: "working", steps: [] }, live: true }).source, "snapshot");
  assert.match(w.note(r), /not streamed/);
  assert.doesNotMatch(w.note(r), /as it thinks/);
  I18N.setLanguage("tr");
  assert.match(w.note(w.row({ node: { sid: "s", turnId: "t1", state: "working", steps: [] }, live: true })), /canlı akmıyor/);
});

test("events without reasoning: the promise holds only until the first step, then the row says none came", () => {
  const w = world();
  w.ev("message.start");
  assert.match(w.note(w.row({ live: true })), /as it thinks/, "nothing happened yet: reasoning may still come");
  w.ev("tool.start", { tool_id: "a", name: "terminal" });
  w.ev("tool.complete", { tool_id: "a" });
  assert.match(w.note(w.row({ live: true })), /No reasoning streamed/);
  w.ev("reasoning.delta", { text: "Checking the output." });
  const r = w.row({ live: true });
  assert.equal(textOf(walk(r).find((n) => n.attrs.class === "la-think")), "Checking the output.");
  w.ev("tool.start", { tool_id: "b", name: "read_file" });
  w.ev("tool.complete", { tool_id: "b" });
  assert.equal(textOf(walk(w.row({ live: true })).find((n) => n.attrs.class === "la-think")), "Checking the output.", "the last thought stays until the next one");
});
