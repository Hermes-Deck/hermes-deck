"use strict";
// The Plan tab's data: the plugin's `plan` event in the model (latest per session, bounded, redacted again), the
// session payloads that carry it, and the rebuild of a stored session's plan from a fixture state.db, read-only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Model } = require("../src/model");
const { normalizePlan, parseResult, PlanStore, PLAN_ITEMS, TEXT_MAX } = require("../src/plan");
const { createServer } = require("../src/server");

let sqlite = null;
try {
  sqlite = require("node:sqlite");
} catch {
  /* Node without node:sqlite: the state.db tests skip */
}
const SECRET = "sk-" + "c".repeat(32);
const TOKEN = "fixture-token-123456789012345";

const todoResult = (todos, revision = 1) => JSON.stringify({ todos, revision, summary: { total: todos.length } });
const omhResult = (items, updatedAt = "2026-01-02T03:04:05Z") =>
  JSON.stringify({ status: "written", todo: { status: "established", source: "omh_todo", updated_at: updatedAt, items } });

test("plan: a plan event becomes the session's plan; snapshot rows carry only planInfo", () => {
  const m = new Model({ profiles: { default: { name: "ExampleBot" } } });
  m.apply({ ev: "turn_start", sid: "s1", profile: "default", ts: 100 }, true);
  m.apply({ ev: "plan", sid: "s1", profile: "default", ts: 101, source: "todo", rev: 2, items: [
    { id: "1", text: "Read the brief", state: "done", depth: 0 },
    { id: "2", text: "Write the parser", state: "active", depth: 0 },
    { id: "2a", text: "Malformed input", state: "pending", depth: 1 },
  ] }, true);
  const d = m.detail("s1");
  assert.deepEqual(d.plan, { source: "todo", rev: 2, ts: 101, items: [
    { id: "1", text: "Read the brief", state: "done", depth: 0 },
    { id: "2", text: "Write the parser", state: "active", depth: 0 },
    { id: "2a", text: "Malformed input", state: "pending", depth: 1 },
  ] });
  const row = m.snapshot().sessions.find((s) => s.sid === "s1");
  assert.equal(row.plan, undefined, "the full plan stays out of snapshot rows");
  assert.deepEqual(row.planInfo, { source: "todo", rev: 2, ts: 101, n: 3, done: 1, active: 1, cur: "Write the parser" });
  assert.deepEqual(m.takeDirty().find((s) => s.sid === "s1").planInfo.n, 3);
});

test("plan: an older revision never replaces a newer one; another source or a clear does", () => {
  const m = new Model({ profiles: {} });
  const plan = (rev, text, source = "todo") => ({ ev: "plan", sid: "s1", profile: "p", ts: rev, source, rev, items: [{ id: "1", text, state: "pending", depth: 0 }] });
  m.apply(plan(5, "five"), true);
  m.apply(plan(4, "four (replayed)"), false);
  assert.equal(m.detail("s1").plan.items[0].text, "five");
  m.apply(plan(6, "six"), true);
  assert.equal(m.detail("s1").plan.items[0].text, "six");
  m.apply(plan(1767323045000, "omh", "omh"), true);
  assert.equal(m.detail("s1").plan.source, "omh");
  m.apply({ ev: "plan", sid: "s1", profile: "p", ts: 9, source: "todo", rev: 9, items: [] }, true);
  assert.deepEqual(m.detail("s1").plan.items, []);
});

test("plan: the relay bounds and redacts a plan line again, whatever the line says", () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ id: `i${i}`, text: `x${i} ${"y".repeat(2000)}`, state: i % 2 ? "done" : "weird", depth: 99, phase: "P".repeat(500), blocked: `needs token=${SECRET}` }));
  items[3] = "not an object";
  const p = normalizePlan({ source: "omh", rev: -5, items });
  assert.equal(p.items.length, PLAN_ITEMS - 1);
  assert.equal(p.total, 200);
  assert.equal(p.rev, 0);
  for (const item of p.items) {
    assert.ok(item.text.length <= TEXT_MAX);
    assert.ok(item.phase.length <= 80);
    assert.ok(["pending", "active", "done", "cancelled"].includes(item.state));
    assert.ok(item.depth <= 3);
  }
  assert.ok(!JSON.stringify(p).includes(SECRET));
  for (const bad of [null, {}, { source: "x", items: [] }, { source: "todo", items: "no" }]) assert.equal(normalizePlan(bad), null);
  const m = new Model({ profiles: {} });
  m.apply({ ev: "plan", sid: "s2", profile: "p", ts: 1, source: "nope", items: [] }, true);
  assert.equal(m.detail("s2").plan, undefined);
});

test("plan: parseResult reads todo_list and omh_todo results like the plugin, and never throws", () => {
  assert.deepEqual(parseResult("todo_list", todoResult([
    { id: "1", content: "A", status: "completed" },
    { id: "2", content: "B", status: "in_progress", parent: "1" },
    { id: "3", content: "C", status: "cancelled" },
  ], 7)), { source: "todo", rev: 7, items: [
    { id: "1", text: "A", state: "done", depth: 0 },
    { id: "2", text: "B", state: "active", depth: 1 },
    { id: "3", text: "C", state: "cancelled", depth: 0 },
  ] });
  assert.deepEqual(parseResult("omh_todo", omhResult([{ text: "Phase", state: "skipped", phase: "I. Start", blocked_reason: "waiting", depth: 1 }])),
    { source: "omh", rev: 1767323045000, items: [{ id: "1", text: "Phase", state: "cancelled", depth: 1, phase: "I. Start", blocked: "waiting" }] });
  assert.equal(parseResult("todo_list", todoResult([], 0)), null);
  assert.deepEqual(parseResult("todo_list", todoResult([], 4)).items, []);
  for (const bad of [null, "", "garbage", "[1]", JSON.stringify({ error: "x", todos: [] }), "{".repeat(50000), 42])
    assert.equal(parseResult("todo_list", bad), null);
  assert.equal(parseResult("todo_list", "x".repeat(5 * 1024 * 1024)), null);
});

function fixtureDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, parent_session_id TEXT, started_at REAL NOT NULL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
      tool_call_id TEXT, tool_name TEXT, timestamp REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX idx_messages_session_id ON messages(session_id, id);`);
  const session = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)");
  const msg = db.prepare("INSERT INTO messages (session_id, role, content, tool_name, timestamp, active) VALUES (?, ?, ?, ?, ?, ?)");
  session.run("s-plan", "cli", null, 1);
  msg.run("s-plan", "user", "Plan the work", null, 1, 1);
  msg.run("s-plan", "tool", todoResult([{ id: "1", content: "Old step", status: "pending" }], 1), "todo_list", 2, 1);
  msg.run("s-plan", "tool", todoResult([{ id: "1", content: `Deploy with token=${SECRET}`, status: "completed" }, { id: "2", content: "Verify", status: "in_progress" }], 2), "todo_list", 3, 1);
  msg.run("s-plan", "tool", todoResult([{ id: "1", content: "Rewound step", status: "pending" }], 3), "todo_list", 4, 0); // undone: not part of the conversation
  msg.run("s-plan", "tool", "plain terminal output", "terminal", 5, 1);
  session.run("s-root", "cli", null, 1);
  msg.run("s-root", "tool", omhResult([{ text: "Phase one", state: "active" }]), "omh_todo", 6, 1);
  session.run("s-tip", "cli", "s-root", 2); // a compression continuation
  session.run("s-none", "cli", null, 1);
  msg.run("s-none", "tool", "{}", "terminal", 7, 1);
  return db;
}

const listDir = (dir) => Object.fromEntries(fs.readdirSync(dir).map((n) => [n, fs.statSync(path.join(dir, n)).mtimeMs]));

test("plan: a stored session's plan is rebuilt from the newest active todo result in state.db, read-only", { skip: !sqlite && "needs node:sqlite" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-plan-"));
  try {
    const db = fixtureDb(path.join(dir, "profiles", "research", "state.db"));
    db.close();
    const before = listDir(path.join(dir, "profiles", "research"));
    const store = new PlanStore({ root: dir });
    const r = store.get("s-plan");
    assert.equal(r.profile, "research");
    assert.equal(r.found, true);
    assert.deepEqual(r.plan.items.map((i) => [i.state, i.text.startsWith("Deploy") ? "deploy" : i.text]), [["done", "deploy"], ["active", "Verify"]]);
    assert.equal(r.plan.rev, 2);
    assert.ok(!JSON.stringify(r.plan).includes(SECRET), "redacted");
    assert.equal(store.get("s-tip", "research").plan.source, "omh", "a continuation finds the plan of the session it continues");
    assert.deepEqual(store.get("s-none"), { plan: null, profile: "research", found: true });
    assert.deepEqual(store.get("s-missing"), { plan: null, profile: null, found: false });
    assert.deepEqual(listDir(path.join(dir, "profiles", "research")), before, "no new files and no writes next to Hermes' store");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("plan: a live WAL store is read in place without touching its sidecars", { skip: !sqlite && "needs node:sqlite" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-plan-wal-"));
  const file = path.join(dir, "state.db");
  const writer = fixtureDb(file);
  try {
    writer.exec("PRAGMA journal_mode=WAL");
    writer.prepare("INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES (?, ?, ?, ?, ?)")
      .run("s-plan", "tool", todoResult([{ id: "9", content: "Only in the WAL", status: "in_progress" }], 9), "todo_list", 10);
    const before = listDir(dir);
    assert.ok("state.db-wal" in before && "state.db-shm" in before);
    const r = new PlanStore({ root: dir }).get("s-plan");
    assert.equal(r.plan.items[0].text, "Only in the WAL");
    assert.deepEqual(listDir(dir), before);
  } finally {
    writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("plan: GET /session/<sid>/plan and the session detail fall back to the stored plan; live plans win", { skip: !sqlite && "needs node:sqlite" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-plan-http-"));
  fixtureDb(path.join(dir, "state.db")).close();
  const model = new Model({ profiles: {} });
  model.apply({ ev: "turn_start", sid: "s-plan", profile: "default", ts: 1 }, true);
  model.apply({ ev: "turn_start", sid: "s-live", profile: "default", ts: 1 }, true);
  model.apply({ ev: "plan", sid: "s-live", profile: "default", ts: 2, source: "todo", rev: 1, items: [{ id: "1", text: "Live", state: "active", depth: 0 }] }, true);
  const { server } = createServer({ token: TOKEN, model, fleet: { data: {} }, version: "test", plans: new PlanStore({ root: dir }) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const get = async (p) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    return { code: res.status, body: await res.json() };
  };
  try {
    const live = await get("/session/s-live/plan");
    assert.deepEqual([live.code, live.body.stored, live.body.plan.items[0].text], [200, false, "Live"]);
    const stored = await get("/session/s-plan/plan");
    assert.deepEqual([stored.code, stored.body.stored, stored.body.plan.items[1].text], [200, true, "Verify"]);
    const detail = await get("/session/s-plan");
    assert.equal(detail.body.plan.items[1].state, "active", "the session payload the app reads carries the plan");
    const unknownToModel = await get("/session/s-root/plan");
    assert.equal(unknownToModel.body.plan.source, "omh", "a stored session the model never saw");
    assert.deepEqual((await get("/session/s-none/plan")).body, { sid: "s-none", plan: null, stored: false });
    assert.equal((await get("/session/nope/plan")).code, 404);
    assert.equal((await get("/session/%E0%A4%A/plan")).code, 400);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/session/s-plan/plan`);
    assert.equal(res.status, 401, "the token is required");
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
