"use strict";
// relay-wire lane: bridge behaviour the relay's phone API relies on (single-flight bind, reads that never resume,
// stale rows for a failed profile, explicit profile on every request). Host stubbed at BridgeClient.request.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BridgeClient } = require("../main/bridge");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function client(reply) {
  const c = new BridgeClient({ mode: "off" });
  c.conn = {};
  c.epoch = 1;
  const calls = [];
  c.request = async (method, params) => {
    calls.push({ method, params });
    return reply(method, params, calls);
  };
  return { c, calls };
}

test("10 concurrent sends to an unbound session share one session.resume", async () => {
  const { c, calls } = client(async (method) => {
    if (method === "session.resume") { await sleep(30); return { session_id: "rt-1" }; }
    return { status: "ok" };
  });
  const sends = await Promise.all(Array.from({ length: 10 }, () => c.send("stored-a", "hello", { profile: "atlas" })));
  assert.equal(sends.length, 10);
  assert.equal(calls.filter((x) => x.method === "session.resume").length, 1);
  assert.equal(calls.filter((x) => x.method === "prompt.submit").length, 10);
  assert.ok(calls.filter((x) => x.method === "prompt.submit").every((x) => x.params.session_id === "rt-1"));
});

test("a failed resume fails every waiting caller once; the next call resumes again", async () => {
  let fail = true;
  const { c, calls } = client(async (method) => {
    if (method === "session.resume") { await sleep(10); if (fail) throw Object.assign(new Error("Persisted session not found"), { rpcCode: 4007 }); return { session_id: "rt-2" }; }
    return { status: "ok" };
  });
  const tries = await Promise.allSettled(Array.from({ length: 5 }, () => c.send("stored-b", "hi", { profile: "atlas" })));
  assert.ok(tries.every((x) => x.status === "rejected" && x.reason.rpcCode === 4007));
  assert.equal(calls.filter((x) => x.method === "session.resume").length, 1);
  fail = false;
  await c.send("stored-b", "hi", { profile: "atlas" });
  assert.equal(calls.filter((x) => x.method === "session.resume").length, 2);
});

test("resume:false reads never send session.resume; the desktop default still binds (once)", async () => {
  const { c, calls } = client(async (method) => {
    if (method === "session.resume") { await sleep(30); return { session_id: "rt-3" }; }
    if (method === "subagent.list") return { subagents: [] };
    if (method === "model.options") return { providers: [] };
    return {};
  });
  const phone = await Promise.all(Array.from({ length: 10 }, () => c.subagents("stored-c", { profile: "atlas", resume: false })));
  assert.ok(phone.every((r) => r.available === false && r.subagents.length === 0));
  const tail = await c.subagentTail("stored-c", "sub-1", { profile: "atlas", resume: false });
  assert.deepEqual(tail, { id: "sub-1", available: false, text: "", truncated: false, detail: null });
  await c.modelOptions("stored-c", { profile: "atlas", resume: false });
  assert.equal(calls.filter((x) => x.method === "session.resume").length, 0);
  assert.deepEqual(calls.find((x) => x.method === "model.options").params, { profile: "atlas", include_unconfigured: false, refresh: false });
  // the desktop path (resume default true) binds, single flight
  await Promise.all(Array.from({ length: 10 }, () => c.subagents("stored-c", { profile: "atlas" })));
  assert.equal(calls.filter((x) => x.method === "session.resume").length, 1);
  // once bound on this connection, a resume:false read uses the binding
  calls.length = 0;
  const bound = await c.subagents("stored-c", { profile: "atlas", resume: false });
  assert.equal(bound.available, undefined);
  assert.deepEqual(calls.map((x) => x.method), ["subagent.list"]);
  assert.equal(calls[0].params.session_id, "rt-3");
});

test("sessionIndex: with keepStaleIndex a failed profile keeps its last good rows marked stale; the desktop default does not", async () => {
  for (const keep of [true, false]) {
    let failBeta = false;
    const { c } = client(async (method, params) => {
      if (method === "profiles.list") return { profiles: [{ name: "default" }, { name: "beta" }] };
      if (method === "deck.session_index") {
        if (params.profile === "beta" && failBeta) throw Object.assign(new Error("The Hermes request timed out"), { kind: "timeout" });
        return { sessions: [{ id: `${params.profile || "default"}-1`, title: "t" }], has_more: false };
      }
      return {};
    });
    c.keepStaleIndex = keep;
    const first = await c.sessionIndex({ force: true });
    assert.deepEqual(first.rows.map((r) => r.id).sort(), ["beta-1", "default-1"]);
    failBeta = true;
    const second = await c.sessionIndex({ force: true });
    const beta = second.profiles.find((p) => p.name === "beta");
    assert.equal(beta.ok, false);
    assert.equal(beta.code, "timeout");
    assert.match(beta.error, /timed out/); // the desktop's sentence stays
    if (keep) {
      assert.equal(beta.stale, true);
      assert.deepEqual(second.rows.map((r) => r.id).sort(), ["beta-1", "default-1"]);
    } else {
      assert.equal(beta.stale, undefined);
      assert.deepEqual(second.rows.map((r) => r.id), ["default-1"]);
    }
  }
});

test("every profile-scoped request names its profile, \"default\" included; a foreign row is never listed under the asked profile", async () => {
  const { c, calls } = client(async (method, params) => {
    if (method === "session.create") return { session_id: "rt-new", stored_session_id: "s-new" };
    if (method === "session.resume") return { session_id: "rt-r" };
    if (method === "session.list") {
      if (params.title) return { sessions: [] };
      return { sessions: [{ id: "s-own", profile_name: params.profile }, { id: "s-foreign", profile_name: "beta" }, { id: "s-plain" }] };
    }
    if (method === "deck.plan") return { plan: null };
    if (method === "deck.session_index") return { sessions: [] };
    return { status: "ok" };
  });
  await c.create({ profile: "default" });
  await c.send("s-other", "hi", { profile: "default" });
  await c.botChat("default");
  await c.plan("s-other", { profile: "default" });
  await c.sessionPage({ profile: "default" });
  const listed = await c.sessions({ profile: "default" });
  for (const m of ["session.create", "session.resume", "deck.plan", "deck.session_index"]) {
    assert.equal(calls.find((x) => x.method === m).params.profile, "default", m);
  }
  assert.ok(calls.filter((x) => x.method === "session.list").every((x) => x.params.profile === "default"));
  assert.deepEqual(listed.map((r) => [r.id, r.profile]), [["s-own", "default"], ["s-plain", "default"]]);
});
