"use strict";
// Reasoning display: "Show thinking" shows real reasoning.
//  - the event path with the REAL live row (live-activity.js) and Thinking block (think-block.js), fed the event order
//    a DWPC turn really produced (thinking-probe/dwpc-order.log): reasoning arrives as one burst right before
//    message.complete, so the finished message must keep it (it used to vanish with the row)
//  - reasoning.available (the reply text) never shows as thinking
//  - a stored assistant message with `think` (bridge projectHistory) renders a collapsed Thinking block with Copy
// The renderer is one IIFE: functions are cut out of app.js by name and run in a vm against a fake DOM
// (as hermes-live-turn.test.js does). DECK_APP_JS points at another copy of app.js (fail-before-fix check).
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const I18N = require("../renderer/i18n");
const LAmod = require(process.env.DECK_LA_JS || "../renderer/live-activity");
const TBmod = require("../renderer/think-block");
I18N.extend(require("../renderer/i18n-b"));
beforeEach(() => I18N.setLanguage("en"));

const SRC = fs.readFileSync(process.env.DECK_APP_JS || path.join(__dirname, "../renderer/app.js"), "utf8");
function fn(name) {
  const m = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(SRC);
  assert.ok(m, `app.js has ${name}`);
  const end = SRC.indexOf("\n  }\n", m.index);
  return SRC.slice(m.index, end + 5);
}

function element(tag, attrs, ...kids) {
  return { tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false), addEventListener() {}, isConnected: true };
}
const walk = (el) => [el, ...(el.kids || []).filter((x) => typeof x === "object").flatMap(walk)];
const textOf = (el) => (el.kids || []).map((k) => (typeof k === "string" ? k : k && k.textContent !== undefined ? k.textContent : textOf(k))).join("");
const cls = (n) => (n.attrs && n.attrs.class) || "";

function world() {
  const clock = { t: 1_700_000_000_000 };
  const copied = [];
  const LA = LAmod.create({ h: element, i18nText: I18N.t, ticker: () => element("span"), store: null, now: () => clock.t });
  if (!LA.think) LA.think = () => ""; // the code before the fix has no accessor; the assertions still show the drop
  const TB = TBmod.create({ h: element, i18nText: I18N.t, copy: (t) => { copied.push(t); return Promise.resolve(); } });
  const ctx = {
    i18nText: I18N.t, i18nNode: (k, v) => ({ textContent: I18N.t(k, v) }), i18nLocale: I18N.getLocale,
    Date, Math, console, requestAnimationFrame: () => 0, maybeLoadOlder() {},
    H: { sel: "s", live: new Map(), hist: new Map(), echo: new Map(), requests: [], nodes: new Map() },
    EM: require("../renderer/echo-match"), OB: { size: () => 0, pending: () => 0, bubbles: () => [] }, outboxEdit() {}, outboxCancel() {}, outboxSendNow() {}, outboxRedirect() {},
    LA, TB, hermesLiveView: () => LA.view("s", { live: false }), liveRowRefresh() {}, nodeControllable: () => false,
    S: {}, els: { msgs: {}, msgsInner: { dataset: {}, replaceChildren(...k) { this.kids = k.flat(Infinity); } } },
    BT: null, AG: null, scrollToEnd: false, window: {},
    h: element, holdRegion: () => false, bridgeOpen: () => true, hermesStatusText: () => "", hermesRequestCards: () => [],
    hermesMode: () => true, hermesLoadHistory() {}, mark() {}, renderNote() {}, hm: () => "10:00",
    dayKey: () => "d", dayLabel: () => "day", hermesPoll() {},
    HF: { chips: () => null }, MP: { strip: () => null },
    hermesTextEl: (m) => element("div", { class: "text" }, m.text),
  };
  vm.createContext(ctx);
  const names = ["sealLive", "applyBridgeEvent", "hermesLiveSegments", "settleEcho", "renderHermesMsgs", "splitSystemNotices", "hermesMsgEl", "hermesIsStep", "hermesCallsEl"];
  vm.runInContext(names.map(fn).join("\n"), ctx);
  ctx.H.hist.set("s", { msgs: [], loaded: true, loading: false, error: null, hasMore: false });
  const ev = (type, payload = {}) => { clock.t += 10; vm.runInContext("applyBridgeEvent", ctx)({ type, sid: "s", payload }); };
  const screen = () => {
    vm.runInContext("renderHermesMsgs", ctx)();
    return ctx.els.msgsInner.kids.flatMap(walk);
  };
  return { ctx, LA, ev, screen, copied };
}

const BURST = ["17 × ", "23 = ", "391. ", "Just need to ", "write the number.\n"];

test("a reasoning.delta burst of a Deck-driven turn fills the open row, then stays on the finished message", () => {
  const w = world();
  w.LA.setOpen(true);
  w.ev("message.start");
  w.ev("thinking.delta", { text: "(◇) sequencing agents..." });
  w.ev("thinking.delta", { text: "" });
  for (const text of BURST) w.ev("reasoning.delta", { text });
  let nodes = w.screen();
  const think = nodes.find((n) => cls(n) === "la-think");
  assert.ok(think, "the open row shows the reasoning, not 'No steps yet'");
  assert.equal(textOf(think), BURST.join(""));
  w.ev("message.delta", { text: "391" });
  w.ev("thinking.delta", { text: "" });
  w.ev("reasoning.available", { text: "391" });
  assert.equal(w.LA.view("s", { live: true }).think, BURST.join(""), "the reply preview is not thinking");
  w.ev("message.complete", { text: "391", status: "complete" }); // no `reasoning` key: the streamed text is kept
  nodes = w.screen();
  assert.equal(nodes.filter((n) => cls(n) === "la-think").length, 0, "the live row is gone");
  const block = nodes.find((n) => cls(n) === "think-block");
  assert.ok(block, "the finished message keeps a Thinking block");
  assert.equal(block.tag, "details");
  assert.ok(!block.attrs.open, "collapsed by default");
  assert.equal(textOf(walk(block).find((n) => cls(n) === "tb-text")), BURST.join("").trim());
  assert.equal(textOf(walk(block).find((n) => cls(n) === "tb-label")), "Thought");
});

test("message.complete's own `reasoning` (the full stored text) wins over the streamed tail", () => {
  const w = world();
  w.ev("message.start");
  w.ev("reasoning.delta", { text: "tail only" });
  w.ev("message.complete", { text: "391", reasoning: "the whole reasoning" });
  const block = w.screen().find((n) => cls(n) === "think-block");
  assert.equal(textOf(walk(block).find((n) => cls(n) === "tb-text")), "the whole reasoning");
});

test("a turn with no reasoning (Show thinking off, or a model that returns none) adds no block", () => {
  const w = world();
  w.ev("message.start");
  w.ev("reasoning.available", { text: "391" });
  w.ev("message.complete", { text: "391" });
  const nodes = w.screen();
  assert.equal(nodes.filter((n) => cls(n) === "think-block").length, 0);
  assert.ok(nodes.some((n) => cls(n) === "text" && textOf(n) === "391"));
});

test("a stored assistant message with reasoning renders a collapsed Thinking block with Copy; user rows never do", async () => {
  const w = world();
  const el = vm.runInContext("hermesMsgEl", w.ctx)({ id: "2", role: "assistant", text: "391", ts: 0, think: "17 × 23 = 391." });
  const block = walk(el).find((n) => cls(n) === "think-block");
  assert.ok(block && !block.attrs.open);
  assert.ok(walk(el).some((n) => cls(n) === "text" && textOf(n) === "391"), "the reply text stays");
  const copy = walk(block).find((n) => cls(n) === "tb-copy");
  copy.attrs.onclick({ preventDefault() {}, stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.copied, ["17 × 23 = 391."]);
  const only = vm.runInContext("hermesMsgEl", w.ctx)({ id: "3", role: "assistant", text: "", ts: 0, think: "thought, then a tool call" });
  assert.ok(walk(only).some((n) => cls(n) === "think-block"));
  assert.ok(!walk(only).some((n) => cls(n) === "text"), "no empty text bubble under it");
  const user = vm.runInContext("hermesMsgEl", w.ctx)({ id: "1", role: "user", text: "q", ts: 0, think: "x" });
  assert.ok(!walk(user).some((n) => cls(n) === "think-block"));
});

test("think.* strings exist in English and Turkish", () => {
  for (const lang of ["en", "tr"]) for (const k of ["think.label", "think.copy", "think.copied"]) assert.ok(I18N.tables[lang][k], `${lang} ${k}`);
});

test("an opened Thinking block stays open across transcript rebuilds (per message key)", () => {
  const TB = TBmod.create({ h: element, i18nText: I18N.t });
  const first = TB.el("thought", "s:2");
  assert.ok(!first.attrs.open);
  first.open = true;
  first.attrs.ontoggle();
  assert.equal(TB.el("thought", "s:2").attrs.open, true, "rebuilt open");
  assert.ok(!TB.el("thought", "s:3").attrs.open, "another message stays closed");
  const again = TB.el("thought", "s:2");
  again.open = false;
  again.attrs.ontoggle();
  assert.ok(!TB.el("thought", "s:2").attrs.open);
  assert.equal(TB.el("   ", "s:4"), null);
});

test("a tool call ends a step: the stored step is read at once; the row keeps its thought until the next step thinks", () => {
  const w = world();
  let loads = 0;
  w.ctx.hermesLoadHistory = () => { loads++; };
  w.LA.setOpen(true);
  w.ev("message.start");
  w.ev("reasoning.delta", { text: "Step one: look at the log." });
  w.ev("tool.generating", { name: "terminal" });
  assert.equal(w.LA.view("s", { live: true }).think, "Step one: look at the log.", "the step's reasoning stays while its call is written");
  assert.equal(loads, 0);
  w.ev("tool.start", { name: "terminal", tool_id: "c1", arguments: { command: "tail log" } });
  assert.equal(loads, 1, "Hermes stored the step before the tool runs: read it now");
  assert.equal(w.LA.view("s", { live: true }).think, "Step one: look at the log.", "no empty gap while the tool runs");
  assert.ok(!w.screen().some((n) => n.tag === "ol"), "the row never lists the turn's tool calls");
  w.ev("tool.complete", { tool_id: "c1" });
  w.ev("reasoning.delta", { text: "" });
  assert.equal(w.LA.view("s", { live: true }).think, "Step one: look at the log.");
  w.ev("reasoning.delta", { text: "Step two." });
  const row = w.screen().find((n) => cls(n) === "la-think");
  assert.equal(textOf(row), "Step two.", "the row never repeats the whole turn");
  w.ev("message.complete", { text: "Done." });
  const block = w.screen().find((n) => cls(n) === "think-block");
  assert.equal(textOf(walk(block).find((n) => cls(n) === "tb-text")), "Step two.", "the final message keeps only its own step's reasoning");
});

test("work steps read in order: each thought with the calls it made, one stamp per stretch of steps", () => {
  const w = world();
  const fired = [];
  w.ctx.document = { dispatchEvent: (e) => fired.push(e) };
  w.ctx.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o.detail; } };
  w.ctx.H.hist.get("s").msgs = [
    { id: "1", role: "user", text: "go", ts: 100 },
    { id: "2", role: "assistant", text: "", ts: 101, think: "Look first.", calls: [{ id: "c1", name: "terminal", arg: "git status" }] },
    { id: "3", role: "assistant", text: "", ts: 102, think: "Then read.", calls: [{ id: "c2", name: "read_file", arg: "a.js" }, { id: "", name: "read_file", arg: "" }] },
    { id: "4", role: "assistant", text: "Found it.", ts: 103, calls: [{ id: "c4", name: "patch", arg: "a.js" }] },
    { id: "5", role: "assistant", text: "", ts: 104, calls: [{ id: "c5", name: "terminal", arg: "npm test" }] },
    { id: "6", role: "assistant", text: "Fixed.", ts: 105 },
  ];
  w.screen();
  const msgs = w.ctx.els.msgsInner.kids.filter((n) => /^msg\b/.test(cls(n)));
  const read = (el) => el.kids.flatMap((k) => {
    if (cls(k) === "think-block") return [`T:${textOf(walk(k).find((n) => cls(n) === "tb-text"))}`];
    if (cls(k) === "tool-calls") return k.kids.map((li) => { const b = li.kids[0]; return `C:${b.tag}:${walk(b).filter((n) => /^tc-/.test(cls(n))).map(textOf).join(" ")}`; });
    if (cls(k) === "text") return [`X:${textOf(k)}`];
    if (k.tag === "time") return ["@"];
    return [];
  });
  assert.deepEqual(msgs.map((el) => [cls(el), ...read(el)]), [
    ["msg out", "X:go", "@"],
    ["msg step work", "T:Look first.", "C:button:terminal git status"],
    ["msg step step-end work", "T:Then read.", "C:button:read_file a.js", "C:span:read_file", "@"],
    ["msg work", "X:Found it.", "C:button:patch a.js", "@"],
    ["msg step step-end work", "C:button:terminal npm test", "@"],
    ["msg", "X:Fixed.", "@"],
  ]);
  const first = walk(msgs[1]).find((n) => n.tag === "button" && cls(n) === "tc");
  first.attrs.onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(fired.map((e) => [e.type, e.detail]))), [["deck-tool-reveal", { sid: "s", call: "c1", ts: 101 }]], "a call opens its row in the turn's receipt");
});

test("a history read asked for while one is on its way runs once more after it (a step stored meanwhile is not missed)", async () => {
  const start = SRC.indexOf("  async function hermesLoadHistory(");
  const code = SRC.slice(start, SRC.indexOf("\n  }\n", start) + 4);
  const st = { loaded: true, loading: false, msgs: [], older: false, sig: "" };
  const gates = [];
  let reads = 0;
  const ctx = {
    BT: null, hermesMode: () => true, bridgeOpen: () => true, hHist: () => st, H: { nodes: new Map(), sel: "s" }, mark() {},
    HW: { PAGE: 50 }, histSig: (m) => String(m.length), settleEcho: () => false, cleanErr: String,
    deck: { bridge: { history: () => { reads++; return new Promise((r) => gates.push(r)); } } },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const load = vm.runInContext("hermesLoadHistory", ctx);
  const first = load("s");
  load("s");
  load("s");
  assert.equal(reads, 1, "one read at a time");
  gates.shift()({ messages: [], offset: 50, hasMore: false });
  await first;
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 2, "the read asked for meanwhile runs once after the one on its way");
  gates.shift()({ messages: [], offset: 50, hasMore: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 2, "and only once");
});
