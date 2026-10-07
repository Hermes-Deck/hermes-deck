"use strict";
// Live chat activity: the live "working" row (renderer/live-activity.js) and the busy-send decision (renderer/busy-send.js).
//  - event sequences -> label / thinking buffer / teardown; the row never carries message text; the buffer is bounded
//  - turns driven elsewhere follow the snapshot node; a lagging snapshot cannot bring back a turn the events ended
//  - busy-send: queue / steer / modifier / fallback with files or without control
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const I18N = require("../renderer/i18n");
const LA = require("../renderer/live-activity");
const BS = require("../renderer/busy-send");
beforeEach(() => I18N.setLanguage("en"));

function element(tag, attrs, ...kids) {
  return { tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false), addEventListener() {}, isConnected: true };
}
const walk = (el) => [el, ...(el.kids || []).filter((x) => typeof x === "object").flatMap(walk)];
const textOf = (el) => (el.kids || []).map((k) => (typeof k === "string" ? k : textOf(k))).join("");

function world({ store = null } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const toggles = [];
  const la = LA.create({ h: element, i18nText: I18N.t, ticker: (s) => element("span", { dataset: { since: String(s) } }), store, now: () => clock.t, onToggle: (o) => toggles.push(o) });
  const live = (extra = {}) => ({ sid: "s", turnId: "t1", state: "thinking", steps: ["Thinking"], ...extra });
  const label = (opts = { live: false }) => { const v = la.view("s", opts); return v ? I18N.t(v.label.key, v.label.vars) : null; };
  return { la, clock, toggles, live, label, ev: (type, p) => la.event("s", type, p) };
}

test("a Deck-driven turn: Thinking -> Running <tool> -> Thinking -> Writing -> gone on message.complete", () => {
  const w = world();
  assert.equal(w.label(), null, "no row before anything happens");
  w.ev("local.sent");
  assert.equal(w.label(), "Thinking…", "the row shows at once on send");
  w.ev("message.start");
  w.ev("thinking.delta", { text: "(◕‿◕) pondering..." });
  assert.equal(w.label(), "Thinking…");
  w.ev("tool.start", { tool_id: "a", name: "read_file" });
  assert.equal(w.label(), "Running read_file");
  w.ev("tool.complete", { tool_id: "a" });
  assert.equal(w.label(), "Thinking…");
  w.ev("tool.start", { tool_id: "b", name: "web_search" });
  assert.equal(w.label(), "Searching…", "search-like tools read as searching");
  w.ev("tool.complete", { tool_id: "b" });
  w.ev("message.delta", { text: "The answer is" });
  assert.equal(w.label(), "Writing…");
  assert.equal(w.la.event("s", "message.complete", { text: "The answer is 4." }), true);
  assert.equal(w.label(), null, "the row is gone when the turn completes");
});

test("an error event ends the row; a hard stop (end) ends it and a lagging snapshot cannot bring it back", () => {
  const w = world();
  w.ev("message.start");
  w.ev("error", { message: "boom" });
  assert.equal(w.label({ live: false }), null);
  w.ev("message.start");
  w.la.end("s");
  assert.equal(w.la.view("s", { node: w.live(), live: true }), null, "the snapshot still says thinking for the stopped turn");
  assert.ok(w.la.view("s", { node: w.live({ turnId: "t2" }), live: true }), "a newer turn shows again");
});

test("message.complete then a snapshot that still lists the same turn as live: no ghost row", () => {
  const w = world();
  w.ev("message.start");
  w.ev("message.complete", { text: "done" });
  assert.equal(w.la.view("s", { node: w.live(), live: true }), null);
  w.clock.t += 2000;
  assert.equal(w.la.view("s", { node: w.live(), live: true }), null);
  w.la.view("s", { node: w.live({ state: "idle" }), live: false });
  assert.ok(w.la.view("s", { node: w.live(), live: true }), "once seen idle, the next live snapshot is a new turn");
});

test("the row never carries message text; reasoning goes to the thinking buffer only", () => {
  const w = world();
  w.ev("message.start");
  w.ev("reasoning.delta", { text: "Let me check " });
  w.ev("reasoning.delta", { text: "the config." });
  w.ev("message.delta", { text: "SECRET-REPLY-TEXT" });
  const v = w.la.view("s", { live: true });
  assert.equal(v.think, "Let me check the config.");
  const row = w.la.row(v);
  const all = walk(row).map(textOf).join("|");
  assert.doesNotMatch(all, /SECRET-REPLY-TEXT/);
});

test("reasoning.available is the reply text, never thinking; the buffer keeps only the bounded tail", () => {
  const w = world();
  w.ev("message.start");
  assert.equal(w.ev("reasoning.available", { text: "391" }), false, "no row change for the answer preview");
  assert.equal(w.la.view("s", { live: true }).think, "");
  w.ev("reasoning.delta", { text: "Plan: read the file, then patch it." });
  w.ev("reasoning.available", { text: "A second block." });
  assert.equal(w.la.view("s", { live: true }).think, "Plan: read the file, then patch it.");
  w.ev("reasoning.delta", { text: "x".repeat(LA.MAX_THINK + 500) + "END" });
  const think = w.la.view("s", { live: true }).think;
  assert.equal(think.length, LA.MAX_THINK);
  assert.ok(think.endsWith("END"));
});

test("an empty thinking.delta (spinner cleared between API calls) changes nothing", () => {
  const w = world();
  w.ev("message.start");
  w.ev("tool.start", { name: "terminal" });
  assert.equal(w.la.event("s", "thinking.delta", { text: "" }), false);
  assert.equal(w.label({ live: true }), "Running terminal");
});

test("a turn driven elsewhere (TUI / Telegram) follows the snapshot: state and last step, waiting for approval", () => {
  const w = world();
  assert.equal(w.label({ node: w.live(), live: true }), "Thinking…");
  assert.equal(w.label({ node: w.live({ state: "working", steps: ["Thinking", "terminal"] }), live: true }), "Running terminal");
  assert.equal(w.label({ node: w.live({ state: "searching" }), live: true }), "Searching…");
  assert.equal(w.label({ node: w.live(), live: true, request: "approval" }), "Waiting for approval");
  assert.equal(w.label({ node: w.live(), live: true, request: "question" }), "Waiting for your answer");
  const v = w.la.view("s", { node: w.live({ state: "working", steps: ["Thinking", "read_file", "terminal"] }), live: true });
  assert.deepEqual(v.steps, ["read_file", "terminal"], "the disclosure falls back to the step log, never an error text");
  assert.equal(v.source, "snapshot");
  assert.equal(w.label({ node: w.live({ state: "idle" }), live: false }), null);
});

test("event state with no event for a while and an idle node is torn down (no stuck row)", () => {
  const w = world();
  w.ev("message.start");
  w.clock.t += LA.STALE_MS + 1;
  assert.equal(w.la.view("s", { node: w.live({ state: "idle" }), live: false }), null);
  assert.equal(w.la.has("s"), false);
});

test("Show thinking: remembered, reported to the caller, and the open row shows the reasoning (or the steps)", () => {
  const saved = new Map();
  const store = { get: (k) => saved.get(k) || null, set: (k, v) => saved.set(k, v) };
  const w = world({ store });
  assert.equal(w.la.isOpen(), false);
  w.ev("message.start");
  let row = w.la.row(w.la.view("s", { live: true }));
  const toggle = walk(row).find((n) => n.attrs.class === "la-toggle");
  assert.equal(textOf(toggle), "Show thinking");
  assert.equal(toggle.attrs["aria-expanded"], "false");
  toggle.attrs.onclick();
  assert.deepEqual(w.toggles, [true]);
  assert.equal(saved.get("deck.live.thinking"), "1");
  assert.equal(world({ store }).la.isOpen(), true, "a new renderer starts open");
  w.ev("tool.start", { name: "read_file" });
  row = w.la.row(w.la.view("s", { live: true }));
  assert.ok(walk(row).some((n) => n.tag === "ol" && n.attrs.class === "la-steps"), "no reasoning yet: the step log");
  w.ev("reasoning.delta", { text: "Thinking hard." });
  row = w.la.row(w.la.view("s", { live: true }));
  assert.ok(walk(row).some((n) => n.attrs.class === "la-think" && textOf(n) === "Thinking hard."));
  I18N.setLanguage("tr");
  row = w.la.row(w.la.view("s", { live: true }));
  assert.equal(textOf(walk(row).find((n) => n.attrs.class === "la-toggle")), "Düşünceyi gizle");
});

test("busy-send decide: queue default, steer setting, modifier flips once, fallbacks", () => {
  const live = { busy: true, live: true, controllable: true };
  assert.deepEqual(BS.decide({ busy: false }), { action: "send", fallback: null });
  assert.deepEqual(BS.decide({ ...live }), { action: "queue", fallback: null });
  assert.deepEqual(BS.decide({ ...live, alt: true }), { action: "steer", fallback: null });
  assert.deepEqual(BS.decide({ ...live, mode: "steer" }), { action: "steer", fallback: null });
  assert.deepEqual(BS.decide({ ...live, mode: "steer", alt: true }), { action: "queue", fallback: null });
  assert.deepEqual(BS.decide({ ...live, mode: "steer", files: true }), { action: "queue", fallback: "files" });
  assert.deepEqual(BS.decide({ ...live, mode: "steer", controllable: false }), { action: "queue", fallback: "control" });
  assert.deepEqual(BS.decide({ busy: true, live: false, mode: "steer" }), { action: "queue", fallback: null }, "idle with a queue: keep the order");
});

test("busy-send modeOf reads the setting defensively; hint names the modifier choice only when there is one", () => {
  assert.equal(BS.modeOf(null), "queue");
  assert.equal(BS.modeOf({}), "queue");
  assert.equal(BS.modeOf({ composer: { busySend: "nonsense" } }), "queue");
  assert.equal(BS.modeOf({ composer: { busySend: "steer" } }), "steer");
  assert.equal(BS.hint({ live: true, controllable: false }), null);
  assert.equal(BS.hint({ live: true, controllable: true, files: true }), null);
  const h = BS.hint({ live: true, controllable: true });
  assert.equal(I18N.t(h.key, h.vars), "Ctrl+Enter steers now");
  const m = BS.hint({ mode: "steer", live: true, controllable: true, mac: true });
  assert.equal(I18N.t(m.key, m.vars), "⌘+Enter queues instead");
});
