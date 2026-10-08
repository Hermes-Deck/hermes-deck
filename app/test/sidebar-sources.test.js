"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const SB = require("../renderer/sessions-browser");

const rows = () => ["tui", "tui", "telegram", "webui", "ios", "cli", "discord"].map((source, i) => ({ sid: `s-${i}`, source }));
const memory = () => {
  const values = new Map();
  return { get: (key) => values.has(key) ? values.get(key) : null, set: (key, value) => values.set(key, value) };
};

test("untouched source preferences keep top-five chips without hiding any source", () => {
  const prefs = SB.createSidebarSources({ store: memory(), rows });
  assert.deepEqual(prefs.chips(), ["tui", "telegram", "webui", "ios", "cli"]);
  for (const source of ["discord", "tui", "new-platform", ""]) assert.equal(prefs.visible(source), true);
});

test("first toggle freezes the current chips, hides unpinned sources, and persists an empty selection", () => {
  const store = memory();
  let current = rows();
  const prefs = SB.createSidebarSources({ store, rows: () => current });
  prefs.toggle("telegram");
  assert.deepEqual(prefs.chips(), ["tui", "webui", "ios", "cli"]);
  assert.equal(prefs.visible("telegram"), false);
  assert.equal(prefs.visible("discord"), false);
  assert.equal(prefs.visible(" TUI "), true);
  current = Array.from({ length: 10 }, (_, i) => ({ sid: `new-${i}`, source: "discord" }));
  assert.deepEqual(prefs.chips(), ["tui", "webui", "ios", "cli"], "new counts cannot replace chosen chips");
  for (const source of prefs.chips()) prefs.toggle(source);
  assert.deepEqual(prefs.chips(), []);
  assert.equal(prefs.visible("tui"), false);
  const reboot = SB.createSidebarSources({ store, rows });
  assert.deepEqual(reboot.chips(), [], "empty is an explicit choice, not the untouched default");
  reboot.toggle("discord");
  assert.deepEqual(reboot.chips(), ["discord"]);
  assert.equal(reboot.visible("telegram"), false);
});

test("source hiding includes descendants but never hides an approval or question or its tree context", () => {
  const store = memory();
  store.set("deck.sourcePins", '["tui"]');
  const tree = [
    { sid: "hidden", source: "telegram" },
    { sid: "child", parent: "hidden", source: "subagent" },
    { sid: "ask", parent: "child", source: "subagent", state: "approval" },
    { sid: "sibling", parent: "hidden", source: "subagent" },
    { sid: "question", source: "ios", state: "question" },
    { sid: "request", source: "webui" },
    { sid: "ordinary", source: "webui" },
    { sid: "visible", source: "tui" },
    { sid: "visible-child", parent: "visible", source: "subagent" },
  ];
  const prefs = SB.createSidebarSources({ store, rows: () => tree });
  const keep = SB.sidebarVisibility(tree, prefs, (r) => r.sid === "request");
  assert.deepEqual(tree.filter(keep).map((r) => r.sid), ["hidden", "child", "ask", "question", "request", "visible", "visible-child"]);
  assert.equal(SB.filterRows(tree).length, tree.length, "All sessions never applies sidebar hiding");
  const cycle = [{ sid: "a", parent: "b", source: "telegram" }, { sid: "b", parent: "a", source: "telegram" }];
  assert.deepEqual(cycle.filter(SB.sidebarVisibility(cycle, prefs)), []);
  cycle[0].state = "question";
  assert.equal(cycle.filter(SB.sidebarVisibility(cycle, prefs)).length, 2);
});

// Exercise app.js's real rail functions without booting Electron or connecting to a host.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const appSource = () => fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
function railWorld(nodes, pins, overrides = {}) {
  const store = memory();
  if (pins !== null) store.set("deck.sourcePins", JSON.stringify(pins));
  const sidebarSources = SB.createSidebarSources({ store, rows: () => nodes });
  const ctx = { H: { nodes: new Map(nodes.map((n) => [n.sid, n])) }, rail: { view: "all", source: "all", agent: null, ...overrides },
    sidebarSources, store, window: { DeckSessions: SB }, SH: { matchFilter: () => true }, isSubagent: (n) => !!n.parent || n.source === "subagent",
    h: (tag, attrs, ...children) => ({ tag, attrs, children }), sourceLabel: (v) => v, i18nText: (v) => v, i18nNode: (v) => v, mark() {} };
  const source = appSource();
  for (const [start, end] of [["  function railFilter(", "  function setRailView("], ["  function sourceChips(", "  function togglePin("]]) {
    vm.runInNewContext(source.slice(source.indexOf(start), source.indexOf(end)), ctx);
  }
  return ctx;
}

test("app rail applies saved source choices even in All, and needs-you wins over a selected source", () => {
  const nodes = [{ sid: "tui", source: "tui" }, { sid: "hidden", source: "telegram" }, { sid: "ask", source: "telegram", state: "question" },
    { sid: "parent", source: "ios" }, { sid: "ask-child", parent: "parent", source: "subagent", state: "approval" }];
  const ctx = railWorld(nodes, ["tui"]);
  const facts = new Map(nodes.map((n) => [n.sid, { source: n.source, profile: "default", needs: n.state ? 1 : 0 }]));
  const keep = ctx.railFilter(facts);
  assert.equal(typeof keep, "function", "source choices must narrow the unfiltered All rail");
  assert.deepEqual(nodes.filter(keep).map((n) => n.sid), ["tui", "ask", "parent", "ask-child"]);
  ctx.rail.source = "tui";
  assert.deepEqual(nodes.filter(ctx.railFilter(facts)).map((n) => n.sid), ["tui", "ask", "parent", "ask-child"]);
});

test("app source chips keep every chosen source, including absent sources and more than five", () => {
  const pins = ["tui", "telegram", "webui", "ios", "cli", "deck", "cron"];
  const ctx = railWorld([], pins, { source: "telegram" });
  const chips = ctx.sourceChips();
  assert.ok(chips, "chosen chips remain available when their source has no recent sessions");
  assert.deepEqual(Array.from(chips.children.slice(1), (b) => b.attrs.dataset.fk), pins.map((s) => `src:${s}`));
  assert.equal(ctx.rail.source, "telegram");
});

test("app Other source chip selects rows with no source", () => {
  const nodes = [{ sid: "unknown", source: "" }];
  const ctx = railWorld(nodes, ["other"], { source: "other" });
  const facts = new Map([["unknown", { source: "", profile: "default", needs: 0 }]]);
  assert.deepEqual(nodes.filter(ctx.railFilter(facts)).map((r) => r.sid), ["unknown"]);
});

test("approval and question descendants stay out of the finished-subagent fold", () => {
  const nodes = [{ sid: "parent", profile: "default", source: "ios", updatedAt: 1 },
    { sid: "ask-a", profile: "default", parent: "parent", source: "subagent", state: "approval", updatedAt: 1 },
    { sid: "ask-b", profile: "default", parent: "parent", source: "subagent", state: "question", updatedAt: 1 }];
  const ctx = railWorld(nodes, []);
  Object.assign(ctx.H, { rank: new Map(), requests: [], subOpen: new Set(), sel: null });
  ctx.nodeLive = () => false;
  ctx.SUB_FOLD_AFTER_S = 600;
  const source = appSource();
  vm.runInNewContext(source.slice(source.indexOf("  function hermesGroups("), source.indexOf("  function hermesFoldRow(")), ctx);
  const facts = new Map(nodes.map((n) => [n.sid, { source: n.source, profile: n.profile, needs: 0 }]));
  const groups = ctx.hermesGroups(10000, ctx.railFilter(facts));
  assert.deepEqual(Array.from(groups[0].rows, (r) => r.node && r.node.sid), ["parent", "ask-a", "ask-b"]);
});

test("an empty sidebar caused by source preferences reports a filter result, not no sessions", () => {
  const nodes = [{ sid: "hidden", source: "telegram" }];
  const ctx = railWorld(nodes, []);
  Object.assign(ctx, { SB: { entry: () => null }, BT: null, sessionFacts: () => new Map(), smartFilters: () => null, agentsBlock: () => [],
    hermesGroups: () => [], sectionHead: () => null, bridgeOpen: () => true, layout: { compact: false }, newSessionRow: () => null,
    els: { rail: { replaceChildren: (...children) => { ctx.rendered = children; } } } });
  const source = appSource();
  vm.runInNewContext(source.slice(source.indexOf("  function renderHermesRail("), source.indexOf("  function hermesRow(")), ctx);
  ctx.renderHermesRail();
  assert.ok(ctx.rendered.some((n) => n && n.children.includes("shell.filterEmpty")));
});
