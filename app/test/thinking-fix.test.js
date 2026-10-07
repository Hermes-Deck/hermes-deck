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
  const names = ["sealLive", "applyBridgeEvent", "hermesLiveSegments", "settleEcho", "renderHermesMsgs", "splitSystemNotices", "hermesMsgEl"];
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
  assert.equal(textOf(walk(block).find((n) => cls(n) === "tb-label")), "Thinking");
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
