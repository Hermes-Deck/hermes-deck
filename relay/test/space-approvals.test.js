"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { SpaceApprovals } = require("../src/space-approvals");
const action = { profile: "agent1", host: "agent-host", session: "session-a", command: "sudo whoami", text: "sudo whoami", args: { text: "sudo whoami", window_id: 2 } };

test("capacity preserves existing requests and grants, and releases answered profile slots", async () => {
  const a = new SpaceApprovals({ snapshot: async () => ({ ok: true }) });
  const actions = Array.from({ length: 21 }, (_, i) => ({ ...action, command: `sudo echo ${i}`, text: `sudo echo ${i}`, args: { text: `sudo echo ${i}` }, session: `session-${i}` }));
  const requests = actions.slice(0, 20).map((v) => a.check(v));
  const message = "Too many pending approvals; ask the user to answer the open ones.";
  assert.deepEqual(a.check(actions[20]), { ok: false, message });
  assert.equal(a.entries.size, 20);
  assert.equal(a.check(actions[0]).id, requests[0].id);
  await a.answer(requests[0].id, { choice: "once" });
  assert.ok(a.check(actions[20]).id);
  assert.equal(a.check(actions[0]).ok, true);
  await a.answer(requests[1].id, { choice: "deny" });
  assert.ok(a.check(actions[0]).id);
  assert.equal(a.check(actions[1]).message, "The user denied this command.");
});

test("total capacity includes grants, reclaims expiry, and never evicts consent", async () => {
  let clock = 0;
  const a = new SpaceApprovals({ now: () => clock, snapshot: async () => ({ ok: true }) });
  const actions = Array.from({ length: 201 }, (_, i) => ({ ...action, profile: `agent${i}` }));
  const requests = actions.slice(0, 200).map((v) => a.check(v));
  await a.answer(requests[0].id, { choice: "once" });
  await a.answer(requests[1].id, { choice: "deny" });
  assert.equal(a.check(actions[200]).message, "Too many pending approvals; ask the user to answer the open ones.");
  assert.equal(a.entries.size, 200);
  assert.equal(a.check(actions[2]).id, requests[2].id);
  assert.equal(a.check(actions[0]).ok, true);
  assert.ok(a.check(actions[200]).id);
  assert.equal(a.check(actions[1]).message, "The user denied this command.");
  assert.ok(a.check(actions[0]).id);
  assert.equal(a.check(actions[1]).id, undefined, "total cap remains full until expiry");
  clock = 600_000;
  assert.ok(a.check(actions[2]).id);
  assert.equal(a.entries.size, 1);
});

test("oversized actions are refused intact; exact character and UTF-8 JSON limits are accepted", async () => {
  const a = new SpaceApprovals({ snapshot: async () => ({ ok: true }) });
  const text = "x".repeat(2000);
  const bounded = { ...action, command: text, text, args: { text } };
  const r = a.check(bounded);
  assert.ok(r.id);
  await a.answer(r.id, { choice: "once" });
  const args = { text: action.text, payload: "" };
  args.payload = "é".repeat(Math.floor((8192 - Buffer.byteLength(JSON.stringify(args))) / 2));
  args.payload += "x".repeat(8192 - Buffer.byteLength(JSON.stringify(args)));
  assert.equal(Buffer.byteLength(JSON.stringify(args)), 8192);
  assert.ok(a.check({ ...action, args }).id);
  for (const oversized of [
    { ...bounded, command: text + "x" },
    { ...bounded, text: text + "x", args: { text: text + "x" } },
    { ...action, args: { ...args, payload: args.payload + "x" } },
  ]) {
    const result = a.check(oversized);
    assert.equal(result.ok, false);
    assert.equal(result.id, undefined);
    assert.match(result.message, /too large/i);
    assert.equal(a.entries.size, 2);
  }
  assert.equal(a.check(bounded).ok, true, "oversized variants never consume or weaken consent");
});

test("mismatched text is rejected before lookup without altering the existing grant", async () => {
  const a = new SpaceApprovals({ snapshot: async () => ({ ok: true }) });
  const r = a.check(action);
  await a.answer(r.id, { choice: "once" });
  const before = { ...a.entries.get(r.id) };
  const result = a.check({ ...action, args: { ...action.args, text: "sudo id" } });
  assert.equal(result.ok, false);
  assert.equal(result.id, undefined);
  assert.match(result.message, /text.*match/i);
  assert.deepEqual(a.entries.get(r.id), before);
  assert.equal(a.check({ ...action, args: { ...action.args, text: ` ${action.text}\n` } }).ok, false);
  assert.equal(a.check(action).ok, true);
});

test("existing fingerprint lookups do not scan entries, including grant consumption", async () => {
  const a = new SpaceApprovals({ snapshot: async () => ({ ok: true }) });
  const pending = a.check(action);
  const other = { ...action, profile: "other" };
  const grant = a.check(other);
  await a.answer(grant.id, { choice: "once" });
  a.entries[Symbol.iterator] = a.entries.values = () => { throw new Error("lookup scanned entries"); };
  assert.equal(a.check(action).id, pending.id);
  assert.equal(a.check(other).ok, true);
});

test("double approve, expiry and one pass", async () => {
  let clock = 0, calls = 0, finish;
  const a = new SpaceApprovals({ now: () => clock, snapshot: () => { calls++; return new Promise((r) => { finish = r; }); } });
  const req = a.check(action);
  assert.equal(req.ok, false);
  assert.equal(a.check(action).id, req.id);
  const p = a.answer(req.id, { choice: "once" });
  assert.equal((await a.answer(req.id, { choice: "once" })).ok, false);
  assert.equal((await a.answer(req.id, { choice: "deny" })).ok, false);
  assert.equal(a.list()[0].state, "snapshotting");
  assert.equal(a.check(action).id, req.id);
  finish({ ok: true }); await p;
  assert.equal(calls, 1);
  assert.equal(a.check({ ...action, session: "new-process", host: "new-host", args: { ...action.args, window_id: 3 } }).ok, true);
  assert.equal(a.check(action).ok, false, "second use requests fresh consent");
  assert.equal((await a.answer(req.id, { choice: "once" })).ok, false);
  const req2 = a.check({ ...action, session: "session-b" });
  const approved = a.answer(req2.id, { choice: "once" }); finish({ ok: true }); await approved;
  clock += 600_001;
  assert.equal(a.check({ ...action, session: "session-b" }).ok, false);
  assert.equal(a.list().every((r) => r.expires > clock), true);
});

test("deny is explicit, snapshot failure requires deliberate override, profile grant survives", async () => {
  const a = new SpaceApprovals({ snapshot: async () => ({ ok: false, reason: "too-large" }) });
  const r = a.check(action);
  assert.equal((await a.answer(r.id, { choice: "once" })).state, "snapshot-failed");
  assert.equal((await a.answer(r.id, { choice: "once" })).ok, false);
  assert.equal(a.check(action).ok, false);
  assert.equal((await a.answer(r.id, { choice: "once", withoutSnapshot: true })).ok, true);
  assert.equal(a.check({ ...action, session: "new-process" }).ok, true);
  const n = a.check(action);
  await a.answer(n.id, { choice: "deny" });
  assert.equal(a.check(action).message, "The user denied this command.");
  assert.notEqual(a.check(action).id, n.id, "denial applies to the next attempt only");
});

test("late snapshot cannot revive request; no Deck request expires", async () => {
  let clock = 0, finish;
  const a = new SpaceApprovals({ now: () => clock, snapshot: () => new Promise((r) => { finish = r; }) });
  const r = a.check(action);
  const p = a.answer(r.id, { choice: "once" });
  clock = 600_001;
  finish({ ok: true });
  assert.equal((await p).ok, false);
  assert.equal(a.list().length, 0);
  assert.equal(a.check(action).ok, false);
});

test("F2: profile and exact text bind consent across processes and argument changes", async () => {
  const a = new SpaceApprovals({ snapshot: async () => ({ ok: true }) });
  const r = a.check(action);
  const retry = { ...action, host: "other-host", session: "new-process", args: { text: action.text, window_id: 3 } };
  assert.equal(a.check(retry).id, r.id);
  assert.equal(a.list().length, 1);
  await a.answer(r.id, { choice: "once" });
  for (const changed of [
    { ...action, profile: "agent2" },
    { ...action, text: "sudo  whoami", args: { text: "sudo  whoami" } },
    { ...action, text: " sudo whoami\n", args: { text: " sudo whoami\n" } },
    { ...action, command: "sudo whoami; rm file" },
  ]) assert.equal(a.check(changed).ok, false);
  assert.equal(a.check(retry).ok, true);
  assert.equal(a.check(retry).ok, false);
  const pending = a.check(retry);
  await a.answer(pending.id, { choice: "deny" });
  assert.equal(a.check(action).message, "The user denied this command.");
  assert.ok(a.check(action).id);
});

test("snapshot uses the original host and grants a fresh ten minutes after completion", async () => {
  let clock = 0, finish;
  const calls = [];
  const a = new SpaceApprovals({ now: () => clock, snapshot: (...args) => {
    calls.push(args); return new Promise((resolve) => { finish = resolve; });
  } });
  const r = a.check(action);
  const p = a.answer(r.id, { choice: "once" });
  clock = 599_999;
  finish({ ok: true });
  assert.deepEqual(await p, { ok: true, state: "approved" });
  assert.deepEqual(calls, [["agent1", "before-risky-command", "agent-host"]]);
  assert.deepEqual(a.list(), []);
  clock = 600_001;
  assert.equal(a.check(action).ok, true);
});

test("unknown choices and premature or non-boolean overrides leave consent pending", async () => {
  let calls = 0;
  const a = new SpaceApprovals({ snapshot: async () => { calls++; return { ok: true }; } });
  const r = a.check(action);
  for (const input of [undefined, {}, { choice: "always" }, { choice: "once", withoutSnapshot: true },
    { choice: "once", withoutSnapshot: "true" }]) {
    assert.deepEqual(await a.answer(r.id, input), { ok: false, error: "approval unavailable" });
    assert.equal(a.list()[0].state, "pending");
  }
  assert.deepEqual(await a.answer("missing", { choice: "once" }), { ok: false, error: "approval unavailable" });
  assert.equal(calls, 0);
});

test("snapshot failures and exceptions stay closed and expose only safe reasons", async () => {
  for (const outcome of ["too-large", "private host failure", undefined, new Error("private host failure")]) {
    let calls = 0, clock = 0;
    const a = new SpaceApprovals({ now: () => clock, ttlMs: 100, snapshot: async () => {
      calls++;
      if (outcome instanceof Error) throw outcome;
      return outcome === undefined ? undefined : { ok: false, reason: outcome };
    } });
    const r = a.check(action);
    assert.deepEqual(await a.answer(r.id, { choice: "once" }), { ok: true, state: "snapshot-failed" });
    assert.equal(a.list()[0].reason, outcome === "too-large" ? "too-large" : "failed");
    assert.equal(a.check(action).id, r.id);
    assert.equal((await a.answer(r.id, { choice: "once" })).ok, false);
    clock = 99;
    assert.deepEqual(await a.answer(r.id, { choice: "once", withoutSnapshot: true }), { ok: true, state: "approved" });
    assert.equal((await a.answer(r.id, { choice: "once", withoutSnapshot: true })).ok, false);
    clock = 101;
    assert.equal(a.check(action).ok, true);
    assert.equal(calls, 1);
  }
});

test("snapshot failure can be denied without retrying the snapshot", async () => {
  const a = new SpaceApprovals({ snapshot: async () => ({ ok: false }) });
  const r = a.check(action);
  await a.answer(r.id, { choice: "once" });
  assert.deepEqual(await a.answer(r.id, { choice: "deny" }), { ok: true, state: "denied" });
  assert.deepEqual(a.list(), []);
  assert.equal(a.check(action).message, "The user denied this command.");
});

test("sweep expires every state at the exact TTL boundary, including unanswered requests", async () => {
  for (const state of ["pending", "snapshotting", "snapshot-failed", "denied", "approved"]) {
    let clock = 0, finish, p;
    const a = new SpaceApprovals({ now: () => clock, ttlMs: 20,
      snapshot: () => new Promise((resolve) => { finish = resolve; }) });
    const r = a.check(action);
    if (state === "denied") await a.answer(r.id, { choice: "deny" });
    else if (state !== "pending") {
      p = a.answer(r.id, { choice: "once" });
      if (state !== "snapshotting") { finish({ ok: state === "approved" }); await p; }
    }
    clock = 20;
    a.sweep();
    assert.deepEqual(a.list(), [], state);
    assert.equal((await a.answer(r.id, { choice: "once", withoutSnapshot: true })).ok, false);
    const fresh = a.check(action);
    assert.equal(fresh.ok, false, state);
    assert.notEqual(fresh.id, r.id, state);
    if (state === "snapshotting") { finish({ ok: true }); assert.equal((await p).ok, false); }
    assert.equal(a.check(action).id, fresh.id);
  }
});
