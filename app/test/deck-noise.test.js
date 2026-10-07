"use strict";
// Deck noise: (A) a sub-agent is never a top-level row of the Hermes rail; (B) Hermes-injected system
// notices render as one collapsed chip. The renderer is one IIFE, so the code under test is cut out of
// renderer/app.js between markers and run in a vm against a fake DOM (like hermes-live-turn.test.js).
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const I18N = require("../renderer/i18n");
beforeEach(() => I18N.setLanguage("en"));

const SRC = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
function between(from, to) {
  const a = SRC.indexOf(from);
  const b = SRC.indexOf(to, a);
  assert.ok(a !== -1 && b > a, `markers ${from} .. ${to}`);
  return SRC.slice(a, b);
}

// ---------------------------------------------------------------- fake DOM
function element(tag, attrs, ...kids) {
  return { tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(Boolean) };
}
const walk = (el) => [el, ...(el.kids || []).filter((x) => typeof x === "object").flatMap(walk)];
const textOf = (el) => (el.kids || []).map((k) => (typeof k === "string" ? k : k && k.textContent !== undefined ? k.textContent : textOf(k))).join("");
const cls = (n) => (n.attrs && n.attrs.class) || "";

// ================================================================ A. rail grouping
function railWorld(nodes, { sel = null, requests = [] } = {}) {
  const ctx = {
    H: { nodes: new Map(), rank: new Map(), sel, requests, subOpen: new Set() },
    nodeLive: (n) => !!n && n.terminalAt === null && (n.active || n.state === "thinking" || n.state === "working"),
    h: element, i18nNode: (k, v) => ({ textContent: I18N.t(k, v) }), mark() {}, Math, Date, Set, Map,
  };
  for (const n of nodes) ctx.H.nodes.set(n.sid, n);
  vm.createContext(ctx);
  vm.runInContext(between("  /** A delegated child:", "  function hermesFoldRow(") + "\n  this.hermesGroups = hermesGroups;", ctx);
  return ctx;
}
const NOW = 1_800_000_000;
const node = (sid, o = {}) => ({ sid, parent: "", profile: "default", source: "tui", state: "finished", terminalAt: NOW - 1, updatedAt: NOW - 5, active: false, steps: [], ...o });
const shape = (g) => Array.from(g.rows).map((r) => (r.fold ? `fold:${r.fold.sid}x${r.fold.count}@${r.depth}` : `${r.node.sid}@${r.depth}`));

test("A: a sub-agent whose parent is in the list nests under it", () => {
  const w = railWorld([node("child", { parent: "main", source: "subagent" }), node("main")]);
  assert.deepEqual(shape(w.hermesGroups(NOW)[0]), ["main@0", "child@1"]);
});

test("A: a sub-agent without `parent` (late hook, row without the key) is still never top-level when the host marks its source", () => {
  const w = railWorld([node("orphan", { parent: "", source: "subagent" }), node("main", { source: "telegram" })]);
  const rows = w.hermesGroups(NOW)[0].rows;
  assert.deepEqual(shape({ rows }), ["main@0", "orphan@1"]);
  assert.equal(w.hermesGroups(NOW).flatMap((g) => Array.from(g.rows)).find((r) => r.node).node.sid, "main"); // auto-select never lands on a sub-agent first
});

test("A: a sub-agent whose parent is outside the list becomes an indented orphan after the real roots", () => {
  const w = railWorld([node("kid", { parent: "gone", updatedAt: NOW - 1 }), node("main"), node("other")]);
  const g = w.hermesGroups(NOW)[0];
  assert.deepEqual(shape(g), ["main@0", "other@0", "kid@1"]);
  assert.ok(g.rows.filter((r) => r.depth === 0).every((r) => r.node.parent === ""));
});

test("A: a parent in another profile is not in this profile's list: the child is an orphan, not a root", () => {
  const w = railWorld([node("main", { profile: "alpha" }), node("kid", { parent: "main", profile: "default" })]);
  const byProfile = Object.fromEntries(w.hermesGroups(NOW).map((g) => [g.profile, shape(g)]));
  assert.deepEqual(byProfile.default, ["kid@1"]);
  assert.deepEqual(byProfile.alpha, ["main@0"]);
});

test("A: a parent cycle cannot hide or loop rows", () => {
  const w = railWorld([node("a", { parent: "b" }), node("b", { parent: "a" })]);
  assert.equal(w.hermesGroups(NOW)[0].rows.length, 2);
});

test("A: finished sub-agents idle for 10 minutes fold into one row; running, asking and selected ones stay", () => {
  const old = NOW - 3600;
  const kids = [1, 2, 3].map((i) => node(`done${i}`, { parent: "main", source: "subagent", updatedAt: old }));
  const running = node("run", { parent: "main", source: "subagent", state: "working", terminalAt: null, active: true, updatedAt: old });
  const picked = node("picked", { parent: "main", source: "subagent", updatedAt: old });
  const asking = node("asking", { parent: "main", source: "subagent", updatedAt: old });
  const w = railWorld([node("main"), ...kids, running, picked, asking], { sel: "picked", requests: [{ sid: "asking" }] });
  const g = w.hermesGroups(NOW)[0];
  assert.deepEqual(shape(g).sort(), ["asking@1", "fold:mainx3@1", "main@0", "picked@1", "run@1"].sort());
  // open: the three come back, no fold-count loss
  w.H.subOpen.add("main");
  const open = w.hermesGroups(NOW)[0];
  assert.ok(["done1", "done2", "done3"].every((s) => open.rows.some((r) => r.node && r.node.sid === s)));
  assert.equal(open.rows.find((r) => r.fold).fold.open, true);
});

test("A: a single old finished sub-agent is not folded (a fold row would be bigger than the row)", () => {
  const w = railWorld([node("main"), node("one", { parent: "main", source: "subagent", updatedAt: NOW - 3600 })]);
  assert.deepEqual(shape(w.hermesGroups(NOW)[0]), ["main@0", "one@1"]);
});

test("A: folded sub-agents are not re-listed as orphans", () => {
  const old = NOW - 3600;
  const w = railWorld([node("main"), node("a", { parent: "main", source: "subagent", updatedAt: old }), node("b", { parent: "main", source: "subagent", updatedAt: old })]);
  assert.deepEqual(shape(w.hermesGroups(NOW)[0]), ["main@0", "fold:mainx2@1"]);
});

test("A: rail strings exist in English and Turkish", () => {
  for (const lang of ["en", "tr"]) for (const k of ["deck.subsFinished", "deck.subsHide"]) assert.ok(I18N.tables[lang][k].includes("{n}"), `${lang} ${k}`);
});

// ================================================================ B. system notices
function noticeWorld() {
  const ctx = {
    i18nText: I18N.t, i18nLocale: I18N.getLocale, i18nNode: (k, v) => ({ textContent: I18N.t(k, v) }),
    h: element, hm: () => "10:00", mark() {}, AG: null, window: {}, Date, String, Set,
    HF: { chips: () => null }, // file chips of assistant messages (renderer/hermes-files.js), covered by voice-files.test.js
    MP: { strip: () => null }, // thumbnails of user-sent images (renderer/media-preview.js), covered by media-preview.test.js
    H: { noticeOpen: new Set(), hist: new Map(), nodes: new Map(), sel: null },
  };
  vm.createContext(ctx);
  const code = between("  function splitSystemNotices(", "  function renderHermesMsgs(")
    + "\n  this.splitSystemNotices = splitSystemNotices; this.hermesMsgEl = hermesMsgEl; this.noticeTitle = noticeTitle;"
    + "\n  function hermesTextEl(m, u) { return h('div', { class: 'text' }, u && u.text ? u.text : m.text); }";
  vm.runInContext(code, ctx);
  return ctx;
}
const plain = (x) => JSON.parse(JSON.stringify(x));
const DELEG = "[ASYNC DELEGATION BATCH COMPLETE — deleg_df6541ad]\n\nTask 1/2: summarize\nResult: all good";

test("B: whole-message notices are detected with a title and the full body", () => {
  const w = noticeWorld();
  const cases = [
    [DELEG, "Delegation batch complete · deleg_df6541ad"],
    ["[ASYNC DELEGATION TASK FAILED — deleg_ab12cd34, task 1/3]\nOne subagent failed", "Delegation task failed · deleg_ab12cd34"],
    ["[ASYNC DELEGATION COMPLETE — deleg_0f0f]\nok", "Delegation complete · deleg_0f0f"],
    ["[IMPORTANT: Background process proc_1 completed (exit code 0).\nOutput: x]", "Background process finished"],
    ['[IMPORTANT: Background process proc_1 matched watch pattern "ready".\nOutput: x]', "Background process matched a watch pattern"],
    ["[IMPORTANT: 3 background processes completed. Treat these results as one batch.]\n\n[IMPORTANT: Background process a completed (exit code 0).]", "3 background processes finished"],
    ["[IMPORTANT: 2 background subagent delegations completed for this session.]", "2 background delegations finished"],
    ["[OMH Degraded] components=runtime_status_read error_type=RuntimeBindingError. Runtime home binding failed.", "OMH degraded"],
  ];
  for (const [text, title] of cases) {
    const parts = w.splitSystemNotices(text);
    assert.equal(parts.length, 1, text);
    assert.equal(w.noticeTitle(parts[0].notice), title, text);
    assert.equal(parts[0].notice.body, text.trim(), "the full text is kept for the expanded view");
  }
});

test("B: Turkish chip titles", () => {
  I18N.setLanguage("tr");
  const w = noticeWorld();
  assert.equal(w.noticeTitle(w.splitSystemNotices(DELEG)[0].notice), "Görev paketi tamamlandı · deleg_df6541ad");
});

test("B: a trailing OMH line on a real user message collapses only that line", () => {
  const w = noticeWorld();
  const text = "Please check the build.\n\n[OMH Degraded] components=runtime_status_read error_type=RuntimeBindingError. Runtime home binding failed; no runtime state was read or written.";
  const parts = plain(w.splitSystemNotices(text));
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { text: "Please check the build." });
  assert.equal(parts[1].notice.kind, "omh");
  assert.match(parts[1].notice.body, /^\[OMH Degraded\] components=/);
});

test("B: the interrupted-response scaffold collapses and the owner's own text stays visible", () => {
  const w = noticeWorld();
  const text = "[Context from the interrupted assistant response]\n[This response was interrupted by a user correction.]\n\nVisible response before the interruption:\nHalf an answer\n\nActually, use the other file.";
  const parts = plain(w.splitSystemNotices(text));
  assert.equal(parts.length, 2);
  assert.equal(parts[0].notice.kind, "interrupt");
  assert.deepEqual(parts[1], { text: "Actually, use the other file." });
  assert.ok(!parts[0].notice.body.includes("Actually"));
});

test("B: real user text is never hidden", () => {
  const w = noticeWorld();
  for (const text of [
    "[x] done, thanks",
    "[TODO] fix the build",
    "Please summarize [ASYNC DELEGATION BATCH COMPLETE — deleg_1] for me", // mid-sentence mention
    "What does [OMH Degraded] mean?\nI saw it twice", // mention, not a trailing line
    "[OUT-OF-BAND USER MESSAGE — from the owner]\nstop now",
    "[IMPORTANT: remember to be brief]",
    "[Replying to: \"hello\"]\n[Ada|1000]\nhi",
    "",
    "plain",
  ]) assert.deepEqual(plain(w.splitSystemNotices(text)), [{ text }], text);
  // a header that is not the whole story: "[OMH Degraded]" heading a longer user text still collapses as a notice,
  // but only because the message opens with it (that is what Hermes injects); the body is kept in full
  const odd = w.splitSystemNotices("[OMH Degraded] components=x. extra words");
  assert.equal(odd[0].notice.body, "[OMH Degraded] components=x. extra words");
});

test("B: collapsed by default, one real button toggles the full text, live and history render alike", () => {
  const w = noticeWorld();
  const m = { id: "m1", role: "user", text: DELEG, ts: 1_700_000_000 };
  let el = w.hermesMsgEl(m);
  assert.ok(cls(el).includes("sysmsg"));
  let nodes = walk(el);
  const btn = nodes.find((n) => n.tag === "button");
  assert.equal(btn.attrs.type, "button");
  assert.equal(btn.attrs["aria-expanded"], "false");
  assert.ok(textOf(el).includes("Delegation batch complete · deleg_df6541ad"));
  assert.ok(!nodes.some((n) => n.tag === "pre"), "body hidden while collapsed");
  assert.ok(!textOf(el).includes("Result: all good"));
  btn.attrs.onclick();
  assert.ok(w.H.noticeOpen.has("m1:0"));
  el = w.hermesMsgEl(m);
  nodes = walk(el);
  assert.equal(nodes.find((n) => n.tag === "button").attrs["aria-expanded"], "true");
  assert.equal(textOf(nodes.find((n) => n.tag === "pre")), DELEG);
  // a second render of the same history row is identical (history reload / live echo settle)
  btn.attrs.onclick();
  assert.deepEqual(plain(w.hermesMsgEl(m)), plain(noticeWorld().hermesMsgEl(m)));
});

test("B: a user message with real text and a trailing OMH line keeps its bubble and adds one chip", () => {
  const w = noticeWorld();
  const el = w.hermesMsgEl({ id: "m2", role: "user", text: "Ship it.\n[OMH Degraded] components=runtime_status_read. Runtime home binding failed.", ts: 0 });
  const all = walk(el);
  assert.ok(all.some((n) => cls(n).split(" ").includes("out") && textOf(n).includes("Ship it.")), "owner text bubble");
  assert.equal(all.filter((n) => n.tag === "button").length, 1);
  assert.ok(!textOf(el).includes("Runtime home binding failed."), "notice body collapsed");
});

test("B: assistant messages are never touched", () => {
  const w = noticeWorld();
  const el = w.hermesMsgEl({ id: "a1", role: "assistant", text: DELEG, ts: 0 });
  assert.ok(!walk(el).some((n) => n.tag === "button"));
});

test("B: notice strings exist in English and Turkish with matching slots", () => {
  const keys = Object.keys(I18N.tables.en).filter((k) => k.startsWith("deck.notice."));
  assert.ok(keys.length >= 10);
  for (const k of keys) {
    assert.ok(I18N.tables.tr[k], `tr ${k}`);
    assert.deepEqual((I18N.tables.en[k].match(/\{\w+\}/g) || []).sort(), (I18N.tables.tr[k].match(/\{\w+\}/g) || []).sort(), k);
  }
});
