"use strict";
// The Hermes chat column during a turn: text -> tool -> text -> tool -> final text, mid-turn and after the
// history reload. Each assistant text segment must be on screen exactly once, in order. Regression: the
// in-flight bubble used to accumulate every text delta of the whole turn while the history already listed
// each segment as its own message, so every one-liner showed twice (alone and again concatenated).
//
// The renderer is one big script, so the functions under test are cut out of it by name and run in a vm
// against a fake DOM. DECK_APP_JS points the test at another copy of app.js (used to prove the fixture fails
// on the code before the fix).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const I18N = require("../renderer/i18n");

const SRC = fs.readFileSync(process.env.DECK_APP_JS || path.join(__dirname, "../renderer/app.js"), "utf8");

/** A top-level function of the renderer IIFE (two-space indent), or "" when this copy of app.js has none. */
function fn(name) {
  const m = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(SRC);
  if (!m) return "";
  const end = SRC.indexOf("\n  }\n", m.index);
  return SRC.slice(m.index, end + 5);
}

function element(tag, attrs, ...kids) {
  return { tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(Boolean) };
}
const walk = (el) => [el, ...(el.kids || []).filter((x) => typeof x === "object").flatMap(walk)];
const textOf = (el) => (el.kids || []).map((k) => (typeof k === "string" ? k : k && k.textContent !== undefined ? k.textContent : textOf(k))).join("");

function world() {
  const loads = [];
  const ctx = {
    i18nText: I18N.t, i18nNode: (k, v) => ({ textContent: I18N.t(k, v) }), i18nLocale: I18N.getLocale,
    Date, Math, console, requestAnimationFrame: () => 0, maybeLoadOlder() {},
    H: { sel: "s-main", live: new Map(), hist: new Map(), echo: new Map(), requests: [], nodes: new Map() },
    EM: require("../renderer/echo-match"), OB: { size: () => 0, pending: () => 0, bubbles: () => [] }, outboxEdit() {}, outboxCancel() {}, outboxSendNow() {}, outboxRedirect() {},
    LA: { event: () => false, row: () => null, think: () => "" }, TB: { el: () => null }, hermesLiveView: () => null, liveRowRefresh() {}, nodeControllable: () => false,
    S: {}, els: { msgs: {}, msgsInner: { dataset: {}, replaceChildren(...k) { this.kids = k.flat(Infinity); } } },
    BT: null, AG: null, scrollToEnd: false,
    h: element, holdRegion: () => false, bridgeOpen: () => true, hermesStatusText: () => "", hermesRequestCards: () => [],
    hermesMode: () => true, hermesLoadHistory: (sid) => loads.push(sid), mark() {}, renderNote() {},
    dayKey: () => "d", dayLabel: () => "day", hermesPoll() {},
    hermesMsgEl: (m) => element("div", { class: `msg${m.role === "user" ? " out" : ""}` }, element("div", { class: "text" }, m.text)),
  };
  vm.createContext(ctx);
  const names = ["sealLive", "applyBridgeEvent", "hermesLiveSegments", "settleEcho", "renderHermesMsgs", "hermesIsStep"];
  vm.runInContext(names.map(fn).join("\n"), ctx);
  ctx.H.hist.set("s-main", { msgs: [], loaded: true, loading: false, error: null, hasMore: false });
  const ev = (type, payload = {}) => vm.runInContext("applyBridgeEvent", ctx)({ type, sid: "s-main", payload });
  const store = (...msgs) => { // what session.messages returns after Hermes stored the segments so far
    ctx.H.hist.get("s-main").msgs = msgs.map((text, i) => ({ id: String(i + 1), role: i === 0 ? "user" : "assistant", text, ts: 1700000000 + i }));
    vm.runInContext("settleEcho", ctx)("s-main", ctx.H.hist.get("s-main").msgs);
  };
  const screen = () => {
    vm.runInContext("renderHermesMsgs", ctx)();
    return ctx.els.msgsInner.kids.flatMap((k) => walk(k).filter((n) => n.attrs && /\bmsg\b/.test(n.attrs.class || ""))).map((n) => ({
      live: /\blive\b/.test(n.attrs.class), text: n.kids.filter((c) => c.attrs && c.attrs.class === "text").map(textOf).join(""),
    }));
  };
  return { ctx, ev, store, screen, loads };
}

const ONE = "Looking at the config first.";
const TWO = "Found it, patching the file now.";
const FINAL = "Done: the setting is fixed.";
const assistantTexts = (shown) => shown.map((s) => s.text).filter((t) => t !== "Fix the setting");

test("mid-turn: one-liners between tool calls each show once, no combined in-flight bubble", () => {
  const w = world();
  w.ev("message.start");
  w.ev("message.delta", { text: ONE });
  w.ev("tool.start", { tool_id: "t1", name: "read_file" });
  w.store("Fix the setting", ONE); // Hermes stored segment 1 with the tool call
  w.ev("tool.complete", { tool_id: "t1" });
  w.ev("message.delta", { text: TWO });
  w.ev("tool.start", { tool_id: "t2", name: "patch" });
  w.store("Fix the setting", ONE, TWO);
  w.ev("tool.complete", { tool_id: "t2" });
  // turn still running: nothing may repeat the segments
  const shown = assistantTexts(w.screen());
  assert.deepEqual(shown, [ONE, TWO], "each one-liner exactly once, in order");
  assert.ok(!w.screen().some((s) => s.live && s.text.includes(ONE)), "no in-flight bubble carrying earlier segments");
});

test("mid-turn: a sealed segment the history has not returned yet is shown once, then handed over", () => {
  const w = world();
  w.ev("message.start");
  w.ev("message.delta", { text: ONE });
  w.ev("tool.start", { tool_id: "t1", name: "read_file" });
  w.ev("message.delta", { text: TWO });
  // history lags behind: only the user prompt is stored yet
  w.store("Fix the setting");
  assert.deepEqual(assistantTexts(w.screen()), [ONE, TWO]);
  w.ev("tool.start", { tool_id: "t2", name: "patch" });
  assert.deepEqual(assistantTexts(w.screen()), [ONE, TWO]);
  // history catches up: the same segments, now stored, are not drawn a second time
  w.store("Fix the setting", ONE, TWO);
  assert.deepEqual(assistantTexts(w.screen()), [ONE, TWO]);
});

test("interim commentary (text beside tool calls) is a segment of its own and is not repeated", () => {
  const w = world();
  w.ev("message.start");
  w.ev("message.interim", { text: ONE, already_streamed: false });
  w.ev("message.delta", { text: TWO });
  w.ev("message.interim", { text: TWO, already_streamed: true });
  w.store("Fix the setting");
  assert.deepEqual(assistantTexts(w.screen()), [ONE, TWO]);
  w.store("Fix the setting", ONE, TWO);
  assert.deepEqual(assistantTexts(w.screen()), [ONE, TWO]);
});

test("end of turn and reload: the final text appears once and equals the stored history", () => {
  const w = world();
  w.ev("message.start");
  w.ev("message.delta", { text: ONE });
  w.ev("tool.start", { tool_id: "t1" });
  w.ev("message.delta", { text: TWO });
  w.ev("tool.start", { tool_id: "t2" });
  w.ev("message.delta", { text: FINAL });
  w.ev("message.complete", { text: FINAL, status: "complete" });
  w.store("Fix the setting", ONE, TWO, FINAL);
  const live = w.screen();
  assert.deepEqual(assistantTexts(live), [ONE, TWO, FINAL]);
  assert.equal(w.ctx.H.live.has("s-main"), false, "the finished turn's in-flight state is dropped once stored");
  // a reload shows the same thing: history only
  const fresh = world();
  fresh.store("Fix the setting", ONE, TWO, FINAL);
  assert.deepEqual(assistantTexts(fresh.screen()), assistantTexts(live));
});

test("a final answer delivered as an interim is not shown twice", () => {
  const w = world();
  w.ev("message.start");
  w.ev("message.interim", { text: FINAL, already_streamed: false });
  w.ev("message.complete", { text: FINAL, status: "complete" });
  w.store("Fix the setting", FINAL);
  assert.deepEqual(assistantTexts(w.screen()), [FINAL]);
});

test("a segment seals on tool events and reloads the history", () => {
  const w = world();
  w.ev("message.start");
  w.ev("message.delta", { text: ONE });
  const before = w.loads.length;
  w.ev("tool.start", { tool_id: "t1" });
  assert.ok(w.loads.length > before, "history is re-read when a segment is sealed");
  assert.equal(w.ctx.H.live.get("s-main").text, "", "the streaming buffer holds only text since the last sealed segment");
});
