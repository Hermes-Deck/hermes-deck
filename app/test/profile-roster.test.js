"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { dom } = require("./inbox-dom-helper");
const source = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
function world(load = async () => [{ name: "default" }, { name: "quiet" }, { name: "empty" }]) {
  const { h, walk } = dom();
  const H = { status: { status: "open" }, profiles: [], profileRead: null, profilesAt: 0,
    nodes: new Map([["one", { sid: "one", profile: "default", updatedAt: 1 }]]),
    requests: [], rank: new Map(), subOpen: new Set(), live: new Map() };
  const ctx = { H, h, Date, rail: { agent: null, view: "all", source: "all" },
    layout: { closed: new Set() }, deck: { bridge: { profiles: load } },
    nodeLive: n => !!n?.active, bridgeOpen: () => H.status.status === "open", agentList: () => [],
    isSubagent: n => !!n.parent, SUB_FOLD_AFTER_S: 600,
    sectionHead: (_id, name, count) => h("header", null, name, count), i18nText: key => key,
    i18nNode: key => key, mark() {}, LA: { clear() {} }, updateBridgeStatusLine() {}, renderNote() {},
    VO: { sync() {} }, hermesMode: () => false, BT: null, SB: null,
    RG: { reusable: () => false, leave() {}, mint: async profile => { ctx.created = profile; return { sid: "new" }; } },
    chatMode: () => "sessions", hermesSelect: sid => { H.sel = sid; }, els: { input: { focus() {} } },
    cleanErr: String, setFormMsg() {}, console };
  const slices = [["  function hermesGroups(", "  function hermesFoldRow("],
    ["  function agentsBlock(", "  /** Source chips"],
    ["  function newSessionRow(", "  function hermesSelect("],
    ["  function applyBridgeStatus(", "  function applyBridgeSnapshot("]];
  // Include the shared catalog reader once implemented; baseline exercises the actual old paths.
  if (source.includes("  async function refreshHermesProfiles(")) slices.push(["  async function refreshHermesProfiles(", "  function applyBridgeStatus("]);
  vm.createContext(ctx);
  for (const [start, end] of slices) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))), ctx);
  return { ctx, H, walk, async refresh() { if (ctx.refreshHermesProfiles) await ctx.refreshHermesProfiles(); },
    agents() { return ctx.agentsBlock().flatMap(walk).filter(n => n.dataset?.fk?.startsWith("agent:")); } };
}

test("catalog-only profiles appear in Agents and new-session groups without fake session nodes", async () => {
  const w = world(); await w.refresh();
  assert.deepEqual(Array.from(w.agents(), n => n.dataset.fk), ["agent:default", "agent:empty", "agent:quiet"]);
  assert.deepEqual(Array.from(w.ctx.hermesGroups(), g => g.profile), ["default", "empty", "quiet"]);
  assert.equal(w.H.nodes.size, 1);
  assert.equal(w.ctx.hermesGroups().find(g => g.profile === "empty").rows.length, 0);
  assert.ok(w.agents().every(n => w.walk(n).some(x => x.children?.includes("shell.state.inactive"))));
});

test("selecting an empty profile retains its New session action under source filters and routes that profile", async () => {
  const w = world(); await w.refresh();
  const row = w.agents().find(n => n.dataset.fk === "agent:quiet");
  assert.ok(row); row.click();
  w.ctx.rail.source = "telegram";
  const groups = w.ctx.hermesGroups(undefined, () => false);
  assert.deepEqual(Array.from(groups, g => g.profile), ["quiet"]);
  await w.ctx.newSessionRow(groups[0].profile).click();
  assert.equal(w.ctx.created, "quiet");
});

test("catalog refresh merges late profiles, throttles reads and counts only live sessions", async () => {
  let calls = 0; const w = world(async () => { calls++; return [{ name: "default" }, { name: "late" }]; });
  await w.refresh(); await w.refresh(); assert.equal(calls, 1);
  w.H.nodes.set("busy", { sid: "busy", profile: "late", active: true });
  const late = w.agents().find(n => n.dataset.fk === "agent:late");
  assert.ok(w.walk(late).some(n => n.children?.includes("shell.state.running")));
  w.H.status.status = "connecting";
  assert.ok(w.agents().every(n => w.walk(n).some(x => x.children?.includes("shell.state.offline"))));
});

test("disconnect invalidates pending catalog reads; next connection gets its own roster", async () => {
  let resolve; const w = world(() => new Promise(r => { resolve = r; }));
  const pending = w.refresh();
  w.ctx.applyBridgeStatus({ status: "connecting" });
  if (resolve) resolve([{ name: "old-host" }]);
  await pending;
  assert.deepEqual(Array.from(w.H.profiles), []);
  w.ctx.deck.bridge.profiles = async () => [{ name: "new-host" }];
  w.H.status.status = "open"; await w.refresh();
  assert.deepEqual(Array.from(w.H.profiles, p => p.name), ["new-host"]);
});

test("older hosts without profiles.list keep snapshot-derived profiles", async () => {
  const w = world(async () => { throw new Error("method not found"); });
  await w.refresh();
  assert.deepEqual(Array.from(w.agents(), n => n.dataset.fk), ["agent:default"]);
  assert.deepEqual(Array.from(w.ctx.hermesGroups(), g => g.profile), ["default"]);
});
