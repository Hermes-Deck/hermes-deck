"use strict";
// The Hermes rail lists recent stored sessions (session.list) next to the live snapshot, so a fresh start does not
// show only what a live process holds. Extracts the real functions from renderer/app.js and runs them in a sandbox.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
function fn(name) {
  const at = SRC.indexOf(`  function ${name}(`);
  assert.ok(at >= 0, `${name} found`);
  let depth = 0;
  for (let i = SRC.indexOf("{", at); i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(at, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function world() {
  const marks = [];
  const ctx = {
    H: { titles: new Map(), snap: [], stored: new Map(), nodes: new Map(), deleted: new Set() },
    hermesMode: () => true, hermesAutoSelect() {}, mark: (...a) => marks.push(a),
    nodeLive: (n) => !!n && n.terminalAt === null && (n.active || n.state === "thinking"),
  };
  vm.createContext(ctx);
  vm.runInContext([fn("applyBridgeSessions"), fn("hermesMergeNodes")].join("\n"), ctx);
  return { ctx, marks };
}

const row = (id, extra = {}) => ({ id, profile: "default", source: "tui", title: `t-${id}`, startedAt: 100, ...extra });

test("recent stored sessions become rail rows after a restart, in Hermes' order", () => {
  const w = world();
  vm.runInContext("applyBridgeSessions", w.ctx)([row("a"), row("b", { source: "telegram" })]);
  assert.deepEqual([...w.ctx.H.nodes.keys()], ["a", "b"]);
  const b = w.ctx.H.nodes.get("b");
  assert.equal(b.stored, true);
  assert.equal(b.storedRank, 1);
  assert.equal(b.state, "idle");
  assert.equal(b.active, false);
});

test("a live snapshot node wins over the stored row of the same session", () => {
  const w = world();
  w.ctx.H.snap = [{ sid: "a", state: "thinking", active: true }];
  vm.runInContext("applyBridgeSessions", w.ctx)([row("a"), row("c")]);
  assert.equal(w.ctx.H.nodes.get("a").state, "thinking");
  assert.equal(w.ctx.H.nodes.get("a").stored, undefined);
  assert.equal(w.ctx.H.nodes.get("c").stored, true);
});

test("a session deleted in this run never comes back from the stored list", () => {
  const w = world();
  w.ctx.H.deleted.add("gone");
  vm.runInContext("applyBridgeSessions", w.ctx)([row("gone"), row("kept")]);
  assert.deepEqual([...w.ctx.H.nodes.keys()], ["kept"]);
});

test("an idle snapshot row takes the stored last activity (not the lease's 'now')", () => {
  const w = world();
  w.ctx.H.snap = [{ sid: "a", state: "idle", active: false, terminalAt: null, updatedAt: 9999 }];
  vm.runInContext("applyBridgeSessions", w.ctx)([row("a", { lastActive: 500 })]);
  assert.equal(w.ctx.H.nodes.get("a").updatedAt, 500);
});

test("the rail orders idle sessions by last activity, running ones first", () => {
  const groups = fn("hermesGroups");
  const ctx = {
    H: { profiles: [], nodes: new Map(), rank: new Map(), requests: [], sel: null, subOpen: new Set() },
    nodeLive: (n) => n.state === "thinking", isSubagent: () => false, SUB_FOLD_AFTER_S: 600, Date, Math,
  };
  const add = (sid, updatedAt, state = "idle", rank = 0) => { ctx.H.nodes.set(sid, { sid, profile: "default", updatedAt, state, terminalAt: null }); ctx.H.rank.set(sid, rank); };
  add("old-live", 10, "idle", -5);
  add("newest", 300);
  add("middle", 200, "idle", -9);
  add("running", 50, "thinking");
  vm.createContext(ctx);
  vm.runInContext(groups, ctx);
  const order = vm.runInContext("hermesGroups", ctx)(1000)[0].rows.map((r) => r.node.sid);
  assert.deepEqual(JSON.parse(JSON.stringify(order)), ["running", "newest", "middle", "old-live"]);
});
