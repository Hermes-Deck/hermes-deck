"use strict";
// Activity panel (renderer/activity-view.js): pure helpers + the one-tree rendering contract.
const test = require("node:test");
const assert = require("node:assert/strict");
const i18n = require("../renderer/i18n");
const A = require("../renderer/activity-view");
test.afterEach(() => i18n.setLanguage("en"));

const h = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat(Infinity).filter((x) => x != null) });
const text = (x) => (x && typeof x === "object" ? (x.children || []).map(text).join(" ") : String(x));
const find = (node, pred, out = []) => { if (node && typeof node === "object") { if (pred(node)) out.push(node); (node.children || []).forEach((c) => find(c, pred, out)); } return out; };
const cls = (node, name) => find(node, (n) => String(n.attrs.class || "").split(" ").includes(name));
const flat = (x) => text(x).replace(/\s+/g, " ").trim();

test("status: one vocabulary derived from the relay session, waiting only from a live bridge question", () => {
  const live = { state: "running", curTool: null };
  assert.deepEqual(A.statusOf(live), { kind: "thinking" });
  assert.deepEqual(A.statusOf({ ...live, curTool: { tool: "terminal" } }), { kind: "tool", tool: "terminal" });
  assert.equal(A.statusOf({ state: "running", stale: true }).kind, "quiet");
  assert.equal(A.statusOf({ state: "failed" }).kind, "failed");
  assert.equal(A.statusOf({ state: "idle" }).kind, "idle");
  assert.equal(A.statusOf({ state: "done" }).kind, "done");
  assert.equal(A.statusOf(live, { terminalAt: null, state: "approval" }).kind, "waiting");
  assert.equal(A.statusOf({ state: "idle" }, { terminalAt: null, state: "working" }).kind, "idle", "the relay session is the single source");
  assert.equal(A.statusOf(live, { terminalAt: 5, state: "approval" }).kind, "thinking");
});

test("metrics: cache hit rate, context percent and tok/s come from real figures only", () => {
  assert.equal(A.cacheRate({ in: 1000, cw: 0, cr: 9000 }), 90);
  assert.equal(A.cacheRate({ in: 500, cw: 500, cr: 0 }), 0);
  assert.equal(A.cacheRate({ out: 40 }), null);
  assert.equal(A.ctxPercent({ ctxLen: 200000, ctxUsed: 50000 }), 25);
  assert.equal(A.ctxPercent({}, { ctxPercent: 61 }), 61);
  assert.equal(A.ctxPercent({}, { ctxMax: 1000, ctxUsed: 2000 }), 100);
  assert.equal(A.ctxPercent({}, {}), null);
  assert.equal(A.tokensPerSec({ genOut: 800, genSecs: 13 }), 62);
  assert.equal(A.tokensPerSec({ genOut: 30, genSecs: 20 }), 1.5);
  assert.equal(A.tokensPerSec({ genOut: 800 }), null);
  assert.equal(A.tokensPerSec({ genOut: 5, genSecs: 0.4 }), null);
  assert.equal(A.tokensPerSec({}), null);
});

test("reasoning level and model labels", () => {
  assert.equal(A.effortOf({}, { effort: "high" }), "high");
  assert.equal(A.effortOf({ route: { effort: "medium" } }, null), "medium");
  assert.equal(A.effortOf({ route: { effort: "<script>" } }, null), "");
  assert.equal(A.effortOf({}, null), "");
  assert.equal(A.shortModel("claude-sonnet-5-5-20260101"), "sonnet-5-5");
  assert.equal(A.shortModel("vendor/model-x"), "model-x");
  assert.equal(A.shortModel(""), "");
});

test("sibling titles lose the words they all share; unrelated titles stay whole", () => {
  const goals = ["Implement the Hermes Deck lane alpha and report back", "Implement the Hermes Deck lane beta and report back", "Implement the Hermes Deck lane gamma and report back"];
  assert.deepEqual(A.stripCommonPrefix(goals), ["alpha", "beta", "gamma"]);
  const mixed = ["Fix the login bug", "Summarise the report"];
  assert.deepEqual(A.stripCommonPrefix(mixed), mixed);
  assert.deepEqual(A.stripCommonPrefix(["only one"]), ["only one"]);
  assert.deepEqual(A.stripCommonPrefix(["", "x"]), ["", "x"]);
});

test("totals: lead + sub-agents and sub-agents only are separate sums; counts follow state", () => {
  const mk = (sid, state, tokens, cost, kids = []) => ({ sid, state, tokens, cost, children: kids });
  const all = new Map([
    ["L", mk("L", "running", { in: 100, cr: 1000, out: 10 }, 1, ["A", "B"])],
    ["A", mk("A", "running", { in: 10, cw: 5, cr: 100, out: 20 }, 0.5, ["C"])],
    ["B", mk("B", "failed", { in: 1, out: 2 }, 0)],
    ["C", mk("C", "running", { out: 7 }, 0.25)],
  ]);
  const kidsOf = (s) => (s.children || []).map((c) => all.get(c));
  const t = A.treeTotals(all.get("L"), kidsOf);
  assert.equal(t.n, 3);
  assert.equal(t.running, 2);
  assert.equal(t.failed, 1);
  assert.deepEqual({ fresh: t.subs.fresh, cr: t.subs.cr, out: t.subs.out, cost: t.subs.cost }, { fresh: 16, cr: 100, out: 29, cost: 0.75 });
  assert.deepEqual({ fresh: t.all.fresh, cr: t.all.cr, out: t.all.out, cost: t.all.cost }, { fresh: 116, cr: 1100, out: 39, cost: 1.75 });
  assert.equal(t.lead.cost, 1);
});

function view(sessions, extra = {}) {
  i18n.setLanguage("en");
  const map = new Map(sessions.map((s) => [s.sid, s]));
  const kidsOf = (s) => (s.children || []).map((c) => map.get(c)).filter(Boolean);
  global.document = { addEventListener() {} };
  global.requestAnimationFrame = () => {};
  const av = A.create({
    h, k: (n) => String(n), dur: (ms) => `${Math.round(ms / 1000)}s`, ticker: (ts, prefix = "") => `${prefix}t`, kidsOf, mark() {}, store: null,
    toolList: () => null, toggleTools() {}, sessions: () => map, nodeOf: () => null,
    titleOf: (s) => s.goal || s.lastMsg || s.sid, askEl: (s) => h("p", { class: "ask" }, s.lastMsg), openDetail() {}, isOpenTools: () => false,
    retryIndex: () => new Map(), actions: (sid) => (extra.actions ? extra.actions(sid) : []), controlBox: () => null,
  });
  return { av, map };
}

test("one tree: every agent is rendered exactly once, nested under its parent, with honest totals", () => {
  const lead = { sid: "L", state: "running", agent: "A", lastMsg: "Run it", model: "claude-sonnet-5-5", tokens: { in: 10, cr: 90, out: 5 }, children: ["K1", "K2", "K3"], cost: 1, cost_label: "API list-price equivalent", firstTs: 1, turnTs: 1 };
  const kid = (sid, state, extra = {}) => ({ sid, parent: "L", state, agent: "A", goal: `Do the lane ${sid} now`, model: "m", tokens: { in: 1, out: 1 }, children: [], firstTs: 1, ...extra });
  const { av } = view([lead, kid("K1", "running", { curTool: { tool: "terminal", since: 1 } }), kid("K2", "failed"), kid("K3", "idle")]);
  const tree = av.card(lead);
  const rows = cls(tree, "arow");
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map((r) => r.attrs.dataset.sid)).size, 4, "no agent twice");
  assert.deepEqual(rows.map((r) => flat(cls(r, "astatus")[0])), ["Thinking", "Running terminal · t", "Failed", "Idle"]);
  const group = flat(cls(tree, "agroup-head")[0]);
  assert.match(group, /3 sub-agents/);
  assert.match(group, /1 running/);
  assert.match(group, /1 failed/);
  const totals = cls(tree, "atot").map(flat);
  assert.match(totals[0], /Session total \(lead \+ 3 sub-agents\)/);
  assert.match(totals[1], /Sub-agents only/);
  assert.equal(cls(tree, "run-row").length, 0, "the legacy Running Now list is gone");
});

test("rows show model + reasoning level + API-equivalent cost; context/cache/speed live in the drawer", () => {
  const s = { sid: "S", state: "running", agent: "A", lastMsg: "Go", model: "claude-sonnet-5-5-20260101", route: { effort: "high" }, cost: 1.234, cost_label: "API list-price equivalent",
    tokens: { in: 100, cr: 900, cw: 0, out: 50 }, ctxUsed: 150000, ctxLen: 200000, genOut: 500, genSecs: 10, ntools: 3, turns: 2, children: [], firstTs: 1, turnTs: 1 };
  const { av } = view([s]);
  const closed = av.card(s);
  assert.equal(cls(closed, "ametrics").length, 0, "metrics are in the drawer, closed by default");
  assert.equal(flat(cls(closed, "amodel")[0]), "sonnet-5-5");
  assert.equal(flat(cls(closed, "achip")[0]), "high");
  assert.equal(flat(cls(closed, "acost")[0]), "≈$1.23");
  cls(closed, "arow-main")[0].attrs.onclick();
  const open = av.card(s);
  const m = cls(open, "ametric").map(flat);
  assert.ok(m.some((x) => /^Context 75%/.test(x)), m.join("|"));
  assert.ok(m.some((x) => /^Cache hit 90%/.test(x)), m.join("|"));
  assert.ok(m.some((x) => /^Speed 50 tok\/s/.test(x)), m.join("|"));
  assert.ok(cls(open, "ametric").some((x) => x.attrs.class.includes("warn")), "context >= 70% is gilt");
});

test("no timing signal: no speed metric; no reasoning level: no chip; no cost: no cost", () => {
  const s = { sid: "S", state: "idle", agent: "A", lastMsg: "Go", model: "m", tokens: { in: 1, out: 1 }, children: [], firstTs: 1 };
  const { av } = view([s]);
  cls(av.card(s), "arow-main")[0].attrs.onclick();
  const open = av.card(s);
  assert.equal(cls(open, "achip").length, 0);
  assert.equal(cls(open, "acost").length, 0);
  assert.ok(!cls(open, "ametric").some((x) => /Speed/.test(text(x))));
});

test("controls: one overflow menu per row, only applicable entries, menu roles", () => {
  const s = { sid: "S", state: "running", agent: "A", lastMsg: "Go", model: "m", tokens: {}, ntools: 2, children: [], firstTs: 1 };
  const calls = [];
  const { av } = view([s], { actions: () => [{ id: "steer", label: "Steer", run: () => calls.push("steer") }, { id: "stop", label: "Stop", danger: true, run: () => calls.push("stop") }] });
  const card = av.card(s);
  assert.equal(cls(card, "amore").length, 1);
  assert.equal(cls(card, "btn").length, 0, "no button wall");
  assert.equal(cls(card, "amenu").length, 0);
  const btn = cls(card, "amore")[0];
  assert.equal(btn.attrs["aria-haspopup"], "menu");
  assert.equal(btn.attrs["aria-expanded"], "false");
  btn.attrs.onclick({ stopPropagation() {} });
  const items = cls(av.card(s), "amenu-item");
  assert.deepEqual(items.map(flat), ["Steer", "Stop", "Show tools (2)", "Session details"]);
  assert.ok(items.every((i) => i.attrs.role === "menuitem"));
  items[0].attrs.onclick();
  assert.deepEqual(calls, ["steer"]);
});

test("running elsewhere: only sessions not already shown, sub-agents grouped under their lead", () => {
  const mk = (sid, extra) => ({ sid, state: "running", agent: "X", model: "m", tokens: {}, children: [], firstTs: 1, ...extra });
  const a = mk("A", { lastMsg: "mine", children: ["A1"] });
  const a1 = mk("A1", { parent: "A", goal: "child" });
  const b = mk("B", { lastMsg: "other", children: ["B1"] });
  const b1 = mk("B1", { parent: "B", goal: "other child" });
  const { av } = view([a, a1, b, b1]);
  const shown = av.descendants(a);
  assert.deepEqual([...shown].sort(), ["A", "A1"]);
  assert.deepEqual(cls(av.elsewhere(shown), "arow").map((r) => r.attrs.dataset.sid), ["B", "B1"]);
  assert.equal(av.elsewhere(new Set(["A", "A1", "B", "B1"])), null);
});

test("Turkish: status vocabulary and totals are translated", () => {
  const s = { sid: "S", state: "running", agent: "A", lastMsg: "Git", model: "m", tokens: { in: 1, cr: 99 }, children: ["K"], firstTs: 1 };
  const k = { sid: "K", parent: "S", state: "failed", agent: "A", goal: "g", model: "m", tokens: {}, children: [], firstTs: 1 };
  const { av } = view([s, k]);
  i18n.setLanguage("tr");
  const all = flat(av.card(s));
  assert.match(all, /Düşünüyor/);
  assert.match(all, /Başarısız/);
  assert.match(all, /Oturum toplamı \(ana \+ 1 alt-ajan\)/);
  assert.match(all, /Yalnızca alt-ajanlar/);
});

test("bridge snapshot: the reasoning level passes through only as a short plain label", () => {
  const { normalizeSnapshot } = require("../main/bridge");
  const node = (extra) => ({ session_id: "s1", state: "working", ...extra });
  const out = normalizeSnapshot({ connection_id: "c", nodes: [node({ reasoning_effort: "high" }), { ...node({ reasoning_effort: "<b>x</b>" }), session_id: "s2" }, { ...node({}), session_id: "s3" }] });
  assert.deepEqual(out.nodes.map((n) => n.effort), ["high", "", ""]);
});
