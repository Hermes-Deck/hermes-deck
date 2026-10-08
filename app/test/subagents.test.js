"use strict";
// The work pane's direct-connection data (Lane C): subagent.list / subagent.tail (reads), subagent.steer /
// subagent.interrupt (click-driven mutations, never replayed), deck.plan (a stored session's plan) and the plugin's live
// deck.plan / deck.tools events. Request shapes, reply projections, the fake host and the real stream.py + testhost.
//   node --test "app/test/*.test.js"
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const bridge = require("../main/bridge");
const { setLanguage } = require("../renderer/i18n");

setLanguage("en");
const { BridgeClient } = bridge;
const FAKE = path.join(__dirname, "fake-stream.js");
const HOST = path.join(__dirname, "..", "..", "hermes-plugin", "hermes-deck", "testhost.py");
const CFG = { mode: "ssh", target: "hermes-test", python: "/usr/bin/python3", stream: "/srv/example/hermes-deck/stream.py" };
const FAST = { request: 1500, write: 1000, handshake: 1500, heartbeat: 1200, kill: 500, backoffMin: 40, backoffMax: 160, keepalive: 60000 };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "deck-subagents-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const SECRET = "sk-" + "d".repeat(32);

const readLog = (file) => {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

function makeClient(t, flags = []) {
  const c = new BridgeClient(CFG, { launch: { file: process.execPath, args: [FAKE, "--serve", ...flags] }, timing: FAST });
  t.after(() => c.stop());
  return c;
}

function next(emitter, event, pred = () => true, ms = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, on);
      reject(new Error(`timed out waiting for ${event}`));
    }, ms);
    function on(v) {
      if (!pred(v)) return;
      clearTimeout(timer);
      emitter.off(event, on);
      resolve(v);
    }
    emitter.on(event, on);
  });
}

test("subagent.* and deck.plan: allow-listed with strict shapes; steer/interrupt are mutations", () => {
  for (const m of ["subagent.list", "subagent.tail", "deck.plan"]) assert.ok(bridge.READS.includes(m), m);
  for (const m of ["subagent.steer", "subagent.interrupt"]) assert.ok(bridge.MUTATIONS.includes(m), m);
  for (const m of ["subagent.list", "subagent.tail", "subagent.steer", "subagent.interrupt", "deck.plan"]) assert.ok(bridge.METHODS.has(m), m);
  assert.throws(() => bridge.checkRequest("subagent.spawn", { session_id: "rpc-1" }), /Unsupported|Desteklenmeyen/);
  assert.throws(() => bridge.checkRequest("subagent.pause", { session_id: "rpc-1" }), /Unsupported|Desteklenmeyen/);

  bridge.checkRequest("subagent.list", { session_id: "rpc-1" });
  bridge.checkRequest("subagent.tail", { session_id: "rpc-1", subagent_id: "sa-0-abcd1234" });
  bridge.checkRequest("subagent.interrupt", { session_id: "rpc-1", subagent_id: "sa-0-abcd1234" });
  bridge.checkRequest("subagent.steer", { session_id: "rpc-1", subagent_id: "sa-0-abcd1234", text: "focus on the tests" });
  bridge.checkRequest("subagent.steer", { session_id: "rpc-1", subagent_id: "sa-0-abcd1234", text: "x".repeat(bridge.MAX_TEXT) });
  const bad = {
    "subagent.list": [{}, { session_id: "" }, { session_id: "a b" }, { session_id: 7 }, { session_id: "rpc-1", subagent_id: "sa-0" }, { session_id: "rpc-1", profile: "x" }],
    "subagent.tail": [{ session_id: "rpc-1" }, { session_id: "rpc-1", subagent_id: "" }, { session_id: "rpc-1", subagent_id: "a b" }, { session_id: "rpc-1", subagent_id: "x".repeat(129) },
      { session_id: "rpc-1", subagent_id: 5 }, { session_id: "rpc-1", subagent_id: "sa", lines: 10 }, { subagent_id: "sa" }],
    "subagent.interrupt": [{ session_id: "rpc-1" }, { session_id: "rpc-1", subagent_id: "sa\n1" }, { session_id: "rpc-1", subagent_id: "sa", all: true }],
    "subagent.steer": [{ session_id: "rpc-1", subagent_id: "sa" }, { session_id: "rpc-1", subagent_id: "sa", text: "" }, { session_id: "rpc-1", subagent_id: "sa", text: "   " },
      { session_id: "rpc-1", subagent_id: "sa", text: "x".repeat(bridge.MAX_TEXT + 1) }, { session_id: "rpc-1", subagent_id: "sa", text: 3 }, { session_id: "rpc-1", text: "go" },
      { session_id: "rpc-1", subagent_id: "sa", text: "go", priority: "high" }],
    "deck.plan": [{}, { session_id: "" }, { session_id: "a b" }, { session_id: "s-1", profile: "../x" }, { session_id: "s-1", profile: "" }, { session_id: "s-1", limit: 5 }],
  };
  for (const [method, list] of Object.entries(bad)) {
    for (const params of list) assert.throws(() => bridge.checkRequest(method, params), Error, `${method} ${JSON.stringify(params)}`);
  }
  bridge.checkRequest("deck.plan", { session_id: "s-1" });
  bridge.checkRequest("deck.plan", { session_id: "s-1", profile: "research" });
});

test("projections: sub-agent detail, failed delegations, tail, plan and tool calls are bounded and typed", () => {
  const listed = bridge.projectSubagents({
    subagents: [
      { subagent_id: "sa-0-abcd1234", parent_id: null, depth: 1, goal: "Find\nthree examples", model: "model-b", provider: "prov", started_at: 1700000000, status: "running",
        tool_count: 2, last_tool: "web_search", accepting_steer: true, elapsed_s: 42.5, child_session_id: "s-child", reasoning_effort: "high", state: "working",
        tokens: { input: 1200, output: 340, bogus: 5, cache_read: "9" }, cost_usd: 0.0123, cost_status: "estimated", context_used: 10, context_max: 100,
        tools: [...Array.from({ length: 30 }, (_, i) => ({ call: `c${i}`, tool: "terminal", args: "a".repeat(5000), ts: i, status: "ok", ms: i, err: null, result: "r" })), { tool: "" }] },
      { subagent_id: "bad id with spaces" },
      "not an object",
      { subagent_id: "sa-1-x", status: "made-up", state: "made-up", reasoning_effort: "<script>" },
    ],
    delegations: [{ delegation_id: "d-1", task_index: 2, status: "failed", goal: "Old task", error: "timeout", dispatched_at: 1, completed_at: 2 }, 7],
  });
  assert.equal(listed.subagents.length, 2);
  const [a, b] = listed.subagents;
  assert.deepEqual([a.id, a.goal, a.model, a.effort, a.status, a.state, a.elapsedS, a.toolCount, a.acceptingSteer, a.childSid, a.costUsd, a.ctxMax],
    ["sa-0-abcd1234", "Find\nthree examples", "model-b", "high", "running", "working", 42.5, 2, true, "s-child", 0.0123, 100]);
  assert.deepEqual(a.tokens, { input: 1200, output: 340 });
  assert.equal(a.tools.length, 20, "the last 20 tool calls");
  assert.deepEqual(Object.keys(a.tools[0]).sort(), ["args", "call", "err", "ms", "result", "status", "tool", "ts"]);
  assert.ok(a.tools[0].args.length <= 301);
  assert.deepEqual([b.status, b.state, b.effort, b.acceptingSteer, b.tokens, b.tools], ["", "", "", false, null, []]);
  assert.deepEqual(listed.failed, [{ delegationId: "d-1", taskIndex: 2, status: "failed", goal: "Old task", error: "timeout", dispatchedAt: 1, completedAt: 2 }]);
  assert.deepEqual(bridge.projectSubagents(null), { subagents: [], failed: [] });

  const tail = bridge.projectSubagentTail({ subagent_id: "sa-0-x", available: true, text: "line 1\nline 2", truncated: true, model: "m", elapsed_s: 3 }, "sa-0-x");
  assert.deepEqual([tail.id, tail.available, tail.text, tail.truncated, tail.detail.model, tail.detail.elapsedS], ["sa-0-x", true, "line 1\nline 2", true, "m", 3]);
  assert.deepEqual(bridge.projectSubagentTail({ available: false, error: "gone" }, "sa-0-x"), { id: "sa-0-x", available: false, text: "", truncated: false, detail: null });

  const plan = bridge.projectPlan({ source: "omh", rev: 4, ts: 9, total: 100, items: [
    { id: "1", text: "Phase one", state: "active", depth: 9, phase: "I. Start", blocked: "waiting" },
    { id: "2", text: "x".repeat(900), state: "weird" },
    null,
  ] });
  assert.deepEqual(plan.items[0], { id: "1", text: "Phase one", state: "active", depth: 3, phase: "I. Start", blocked: "waiting" });
  assert.equal(plan.items[1].state, "pending");
  assert.ok(plan.items[1].text.length <= 301);
  assert.deepEqual([plan.source, plan.rev, plan.ts, plan.total, plan.items.length], ["omh", 4, 9, 100, 2]);
  for (const badPlan of [null, {}, { source: "x", items: [] }, { source: "todo" }]) assert.equal(bridge.projectPlan(badPlan), null);
  assert.equal(bridge.projectToolCall({ tool: "" }), null);
});

const feed = (c, line) => c._onLine(c.conn, Buffer.from(line));

test("live deck.plan / deck.tools events are projected, re-emitted and kept for plan() and toolCalls()", async (t) => {
  const c = makeClient(t);
  const ready = next(c, "status", (s) => s.status === "open");
  c.start();
  await ready;
  const evs = [];
  c.on("event", (e) => evs.push(e));
  feed(c, JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "deck.plan", session_id: "s-main", profile_name: "default",
    payload: { plan: { source: "todo", rev: 3, ts: 5, items: [{ id: "1", text: `Deploy token=${SECRET}`.slice(0, 10), state: "done", depth: 0 }, { id: "2", text: "Verify", state: "active", depth: 0 }] } } } }));
  feed(c, JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "deck.tools", session_id: "s-main", profile_name: "default",
    payload: { tools: [{ call: "c1", tool: "terminal", args: "{\"command\": \"ls\"}", ts: 1, status: "ok", ms: 12, err: null, result: "a\nb" }, { call: "c2", tool: "read_file", ts: 2, status: "running" }] } } }));
  feed(c, JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "deck.plan", session_id: "bad id", payload: { plan: { source: "todo", items: [] } } } }));
  feed(c, JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "deck.plan", session_id: "s-x", payload: { plan: "nope" } } }));
  assert.deepEqual(evs.map((e) => [e.type, e.sid, e.profile]), [["deck.plan", "s-main", "default"], ["deck.tools", "s-main", "default"]]);
  assert.deepEqual(evs[0].payload.plan.items.map((i) => i.state), ["done", "active"]);
  assert.deepEqual((await c.plan("s-main")).live, true);
  assert.deepEqual(c.toolCalls("s-main").map((x) => [x.call, x.tool, x.status, x.ms]), [["c1", "terminal", "ok", 12], ["c2", "read_file", "running", null]]);
  assert.deepEqual(c.toolCalls("s-idle"), []);
  // no live plan: deck.plan, answered -32601 by a host without it (the fake) -> null, not an error
  assert.deepEqual(await c.plan("s-idle"), { sid: "s-idle", plan: null, live: false });
  assert.throws(() => c.toolCalls("a b"));
});

test("subagent.steer / subagent.interrupt lost with the connection are never replayed", async (t) => {
  for (const method of ["subagent.steer", "subagent.interrupt"]) {
    const log = path.join(fs.mkdtempSync(path.join(TMP, "log-")), "requests.log");
    const c = makeClient(t, ["--exit-on", method, "--log", log]);
    const ready = next(c, "status", (s) => s.status === "open");
    c.start();
    await ready;
    const call = method === "subagent.steer" ? c.steerSubagent("s-main", "sa-0-abcd1234", "focus") : c.interruptSubagent("s-main", "sa-0-abcd1234");
    await assert.rejects(call, Error);
    await next(c, "status", (s) => s.status === "open", 8000);
    await new Promise((r) => setTimeout(r, 300));
    const entries = readLog(log);
    assert.ok(entries.filter((e) => e.start).length >= 2, "the fake was restarted");
    assert.equal(entries.filter((e) => e.method === method).length, 1, `${method} sent once`);
    const sent = entries.find((e) => e.method === method);
    assert.equal(sent.params.session_id, "rpc-s-main", "addressed to the runtime id the Deck bound");
    await c.stop();
  }
});

test("bad arguments fail before anything is sent", async (t) => {
  const log = path.join(fs.mkdtempSync(path.join(TMP, "log-")), "requests.log");
  const c = makeClient(t, ["--log", log]);
  const ready = next(c, "status", (s) => s.status === "open");
  c.start();
  await ready;
  await assert.rejects(c.subagentTail("s-main", "a b"));
  await assert.rejects(c.steerSubagent("s-main", "sa-0-x", "   "));
  await assert.rejects(c.steerSubagent("s-main", "sa-0-x", "x".repeat(bridge.MAX_TEXT + 1)));
  await assert.rejects(c.interruptSubagent("s-main", ""));
  await assert.rejects(c.subagents("bad id"));
  const methods = readLog(log).map((e) => e.method).filter(Boolean);
  assert.ok(!methods.some((m) => m.startsWith("subagent.") || m === "session.resume"), methods.join(","));
});

const HOST_PY = process.env.DECK_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
const HOST_WRAPPER = process.env.DECK_TEST_HOST_WRAPPER;

test("against the real stream.py and plugin: sub-agent detail, steer, interrupt, live plan and tool calls", async (t) => {
  if (process.platform === "win32" && !HOST_WRAPPER) return t.skip("needs Unix sockets (Linux/macOS)");
  if (spawnSync(HOST_PY, ["--version"]).status !== 0) return t.skip("no python");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hd-")); // short: Unix socket paths are limited
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const launch = { file: HOST_PY, args: [...(HOST_WRAPPER ? [HOST_WRAPPER] : []), HOST, home] };
  const c = new BridgeClient(CFG, { launch, timing: { ...FAST, handshake: 10000, request: 5000, heartbeat: 12000 } });
  t.after(() => c.stop());
  const planEv = next(c, "event", (e) => e.type === "deck.plan" && e.sid === "s-main", 15000);
  const toolsEv = next(c, "event", (e) => e.type === "deck.tools" && e.sid === "s-main", 15000);
  c.start();
  const [plan, tools] = await Promise.all([planEv, toolsEv]);
  assert.deepEqual([plan.payload.plan.source, plan.payload.plan.rev, plan.payload.plan.items.map((i) => i.state)], ["todo", 3, ["done", "active"]]);
  const todo = tools.payload.tools.find((x) => x.call === "call-todo-1");
  assert.deepEqual([todo.tool, todo.status, todo.ms, typeof todo.args, typeof todo.result], ["todo_list", "ok", 2, "string", "string"]);
  assert.equal((await c.plan("s-main")).plan.rev, 3);

  const list = await c.subagents("s-main");
  assert.equal(list.subagents.length, 1);
  const sa = list.subagents[0];
  assert.deepEqual([sa.id, sa.goal, sa.model, sa.status, sa.acceptingSteer], ["sa-0-test", "Find three examples", "model-b", "running", true]);
  assert.ok(sa.elapsedS >= 0, "the plugin completes elapsed time");
  assert.ok(Array.isArray(sa.tools));
  const tail = await c.subagentTail("s-main", "sa-0-test");
  assert.deepEqual([tail.available, tail.text], [true, "searching\nfound one\n"]);
  assert.deepEqual(await c.steerSubagent("s-main", "sa-0-test", "focus on the tests"), { status: "queued" });
  assert.deepEqual(await c.interruptSubagent("s-main", "sa-0-test"), { found: true });
});
