"use strict";
// Work › Sub-agents: readable elapsed/tokens, a child's own clock, and the shared metric grid built from the child's
// relay session (the figures the old Inspector showed only in an expanded activity row).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const W = require("../renderer/work-pane");
const I18N = require("../renderer/i18n");
I18N.extend(require("../renderer/i18n-d"));

function harness(bridge = {}, relay = {}, services = {}) {
  const tabs = new Map(), listeners = new Map(), timers = new Map(), panes = new Map();
  const doc = { activeElement: null, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
  const h = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, children: kids.flat(Infinity).filter(x => x != null), value: "", isConnected: true,
    replaceChildren(...cs) { this.children = cs; }, querySelector() { return null; }, focus() {} });
  const session = { sid: "session-a", profile: "default" };
  let right = { kind: "work", tab: "agents" };
  const shell = { registerWorkTab: (id, def) => tabs.set(id, def), service: n => (n === "h" ? h : services[n] || null),
    last: n => (n === "session" ? session : null), state: () => ({ session }),
    on(n, f) { listeners.set(n, f); return () => listeners.delete(n); }, setTabLive() {},
    isOpen: (kind, tab) => right.kind === kind && (!tab || right.tab === tab), right: () => right, empty: (a, b) => h("div", { class: "sh-empty" }, a, b),
    openRight(kind, tab) { right = { kind, tab }; this.refresh(); },
    refresh() { if (!tabs.has(right.tab)) return; const el = panes.get(right.tab) || h("section"); panes.set(right.tab, el); tabs.get(right.tab).render(el); } };
  const deck = { bridge: { ...bridge, onEvent: () => () => {} }, ...relay, onRelay: () => () => {} };
  const app = W.create({ shell, deck, doc, h, t: I18N.t, setTimer: f => { const id = Symbol(); timers.set(id, f); return id; }, clearTimer: id => timers.delete(id), emit() {} });
  const walk = x => (x && typeof x === "object" ? [x, ...(x.children || []).flatMap(walk)] : []);
  return { app, shell,
    async settle() { for (let n = 0; n < 12; n++) await Promise.resolve(); shell.refresh(); },
    nodes: () => walk(panes.get(right.tab)),
    text() { const t = x => (typeof x === "object" ? (x.children || []).map(t).join(" ") : String(x)); return t(panes.get(right.tab)); } };
}
const cell = (b, id) => b.nodes().find(n => n.attrs?.dataset?.metric === id);
const cellText = (b, id) => { const c = cell(b, id); return c ? c.children.filter(x => x.attrs?.class === "ametric-v").map(x => x.children.join("")).join("") : null; };

test("a child's elapsed is its own clock: measured run when finished, live from its own start while running", () => {
  const now = 10_000;
  const rows = W.relayAgents([
    { sid: "c-done", state: "done", ms: 125000, firstTs: 1000, lastTs: 9000 },
    { sid: "c-run", state: "running", firstTs: now - 42 },
    { sid: "c-stale", state: "running", stale: true, firstTs: 100, lastTs: 160 },
    { sid: "c-fail", state: "failed", firstTs: 500, lastTs: 530 },
    { sid: "c-none", state: "running" },
  ], now);
  assert.deepEqual(rows.map(r => r.elapsedS), [125, 42, 60, 30, null]);
  assert.equal(rows[0].row.sid, "c-done", "the relay row travels along for the metric grid");
  // Hermes reports elapsed as now - started for every listed child: a finished child takes the relay's measured run
  const merged = W.mergeRoster(rows, [{ id: "c-done", childSid: "c-done", status: "completed", elapsedS: 23902.2 }, { id: "c-run", childSid: "c-run", status: "running", elapsedS: 40 }]);
  assert.equal(merged.find(a => a.id === "c-done").elapsedS, 125, "finished: the relay's measured run wins over a growing figure");
  assert.equal(merged.find(a => a.id === "c-run").elapsedS, 40, "running: the live bridge figure stays");
  assert.equal(W.mergeRoster([], [{ id: "x", status: "completed", elapsedS: 12 }])[0].elapsedS, 12, "no relay figure: the bridge one is kept");
});

test("Sub-agents list reads 6h 38m and a context hint, never raw seconds", async () => {
  const child = { id: "sa-1", childSid: "child-1", goal: "Long task", status: "completed", elapsedS: 23902.2, model: "model-b", ctxPercent: 42 };
  const b = harness({ subagents: async () => ({ subagents: [child], failed: [] }) });
  await b.settle();
  const text = b.text();
  assert.match(text, /model-b · Completed · 6h 38m · ctx 42%/);
  assert.doesNotMatch(text, /23902/);
  b.app.dispose();
});

test("Sub-agent detail: the shared metric grid from the child's relay session, compact tokens with exact tooltips", async () => {
  const child = { id: "sa-1", childSid: "child-1", goal: "Index the archive", status: "running", acceptingSteer: false, elapsedS: 125, tools: [],
    tokens: { input: 1, output: 1 }, costUsd: 0.0123, costStatus: "estimated" };
  const relayRow = { sid: "child-1", parent: "session-a", state: "running", tokens: { in: 5482981, cr: 2900000000, cw: 0, out: 120000 },
    ctxLen: 200000, ctxUsed: 150000, genOut: 5000, genSecs: 100, ntools: 37 };
  const b = harness({ subagents: async () => ({ subagents: [child], failed: [] }) }, {}, { relaySession: sid => (sid === "child-1" ? relayRow : null) });
  await b.settle();
  b.app.openAgent("sa-1"); await b.settle();
  assert.equal(cellText(b, "elapsed"), "2m 05s");
  assert.equal(cellText(b, "tokens"), "2.9B");
  assert.match(cell(b, "tokens").attrs.title, /reasoning/, "the token figure still says what it counts");
  assert.match(cell(b, "tokens").attrs.title, /2,905,602,981/, "the exact figure is in the tooltip");
  assert.equal(cellText(b, "context"), "75%");
  assert.ok(cell(b, "context").children.some(x => x.attrs?.class === "ameter"), "context carries the small meter");
  assert.equal(cellText(b, "cache"), "100%");
  assert.equal(cellText(b, "speed"), "50 tok/s");
  assert.equal(cellText(b, "fresh"), "5.5M");
  assert.equal(cellText(b, "cached"), "2.9B");
  assert.equal(cellText(b, "output"), "120k");
  assert.equal(cellText(b, "calls"), "0", "the bridge's own tool list wins for calls, as before");
  assert.equal(cellText(b, "cost"), "≈$0.0123");
  assert.equal(cell(b, "tools"), undefined, "calls are counted once");
  assert.equal(b.nodes().filter(n => n.attrs?.class === "wk-stats").length, 0, "the old four-stat strip is gone");
  b.app.dispose();
});

test("Sub-agent detail shows only figures that exist: no dash walls", async () => {
  const child = { id: "sa-2", goal: "Quick look", status: "running", tools: [] };
  const b = harness({ subagents: async () => ({ subagents: [child], failed: [] }) });
  await b.settle();
  b.app.openAgent("sa-2"); await b.settle();
  const ids = b.nodes().filter(n => n.attrs?.dataset?.metric).map(n => n.attrs.dataset.metric);
  assert.deepEqual(ids, ["calls"], "unknown elapsed, tokens, context and cost are left out");
  assert.doesNotMatch(b.text(), /—/);
  b.app.dispose();
});

test("a relay-only child (not owned here) still gets its grid from the roster's copy of its session", async () => {
  const b = harness({ subagents: async () => { throw new Error("session not found or not owned by this transport"); } },
    { session: async () => ({ children: [{ sid: "child-9", sa: "sa-9", state: "done", goal: "Done job", ms: 3599600, ntools: 4,
      tokens: { in: 1000, out: 2000, cr: 9000, cw: 0 }, ctxLen: 1000, ctxUsed: 950, cost: 1.5, cost_label: "API list-price equivalent" }] }),
    messages: async () => ({ items: [] }) });
  await b.settle();
  assert.match(b.text(), /Done job/);
  assert.match(b.text(), /1h 00m · ctx 95%/);
  b.app.openAgent("sa-9"); await b.settle();
  assert.equal(cellText(b, "elapsed"), "1h 00m");
  assert.equal(cellText(b, "tokens"), "12k");
  assert.equal(cellText(b, "context"), "95%");
  assert.match(cell(b, "context").attrs.class, /bad/, "a nearly full context is marked like the activity drawer");
  assert.equal(cellText(b, "calls"), "4");
  assert.equal(cellText(b, "cost"), "≈$1.5000");
  b.app.dispose();
});
