"use strict";
// Real BridgeClient, fake JSON-RPC host; no network, runtime, credentials, or user sessions.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BridgeClient, normalizeSnapshot } = require("../main/bridge");

function next(c, name, pred = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { c.off(name, on); reject(new Error(`waiting for ${name}`)); }, 3000);
    function on(value) {
      if (!pred(value)) return;
      clearTimeout(timer);
      c.off(name, on);
      resolve(value);
    }
    c.on(name, on);
  });
}

async function fixture(t, flags = [], { retry = false, autoList = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-profile-scope-"));
  const log = path.join(dir, "requests.jsonl");
  const c = new BridgeClient({ mode: "local", python: "/unused", stream: "/unused" }, {
    launch: { file: process.execPath, args: [path.join(__dirname, "fake-stream.js"), "--serve", "--profile-collision", "--log", log, "--interval", "30", ...flags] },
    retry, autoList, keepalive: false,
    timing: { request: 1500, handshake: 1500, heartbeat: 1500, kill: 100, backoffMin: 40, backoffMax: 40 },
  });
  t.after(async () => { await c.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ready = next(c, "snapshot");
  c.start();
  await ready;
  const calls = (method) => fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse).filter((r) => r.method === method);
  return { c, calls };
}

test("one BridgeClient isolates cloned stored SIDs for sends, models, requests, native controls, and deletion", async (t) => {
  assert.deepEqual(normalizeSnapshot({ connection_id: "hermes", nodes: [
    { session_id: "s-shared", profile_name: "alpha" }, { session_id: "s-shared", profile_name: "beta" }, { session_id: "s-shared", profile_name: "alpha" },
  ] }).nodes.map((n) => n.profile), ["alpha", "beta"]);
  const { c, calls } = await fixture(t);
  assert.equal(c.currentSnapshot().nodes.length, 2);
  assert.throws(() => c.nodeFor("s-shared"), /ambiguous/);
  const events = [];
  c.on("event", (e) => events.push(e));
  const requests = next(c, "requests", (r) => r.length === 4);
  await Promise.all([c.send("s-shared", "alpha first", { profile: "alpha" }), c.send("s-shared", "beta first", { profile: "beta" })]);
  await requests;
  await c.send("s-shared", "alpha again", { profile: "alpha" });
  const options = await Promise.all([c.modelOptions("s-shared", { profile: "beta" }), c.modelOptions("s-shared", { profile: "alpha" })]);
  assert.deepEqual(options.map((o) => o.current.model), ["beta-model", "alpha-model"]);
  await Promise.all([c.setModel("s-shared", { profile: "alpha", model: "model-a", provider: "prov" }), c.setModel("s-shared", { profile: "beta", model: "model-a", provider: "prov" })]);
  assert.deepEqual(calls("session.resume").map((r) => r.params.profile).sort(), ["alpha", "beta"]);
  assert.deepEqual(calls("prompt.submit").map((r) => r.params.session_id), ["rpc-alpha-s-shared", "rpc-beta-s-shared", "rpc-alpha-s-shared"]);
  assert.deepEqual(new Set(calls("config.set").map((r) => r.params.session_id)), new Set(["rpc-alpha-s-shared", "rpc-beta-s-shared"]));
  assert.ok(c.currentSnapshot().nodes.every((n) => n.bound));
  assert.deepEqual(c.listRequests().map((r) => [r.id, r.profile, r.sid]).sort(), [
    ["A-alpha", "alpha", "s-shared"], ["A-beta", "beta", "s-shared"], ["Q-alpha", "alpha", "s-shared"], ["Q-beta", "beta", "s-shared"],
  ]);
  const complete = events.filter((e) => e.type === "message.complete");
  assert.deepEqual(complete.map((e) => [e.profile, e.sid]), [["alpha", "s-shared"], ["beta", "s-shared"], ["alpha", "s-shared"]]);
  await assert.rejects(c.answerApproval("A-alpha", "once", { profile: "beta" }));
  await c.answerApproval("A-alpha", "once", { profile: "alpha" });
  await c.answerQuestion("Q-beta", { q: "beta" }, { profile: "beta" });
  await assert.rejects(c.send("s-shared", "no profile"), /ambiguous/);
  await assert.rejects(c.steer("s-shared", "no profile"), /ambiguous/);
  await assert.rejects(c.interrupt("s-shared"), /ambiguous/);
  await assert.rejects(c.steer("s-shared", "wrong profile", { profile: "gamma", turnId: "t-alpha" }));
  await assert.rejects(c.interrupt("s-shared", { profile: "gamma", turnId: "t-alpha" }));
  await assert.rejects(c.interrupt("s-shared", { profile: "beta", turnId: "t-alpha" }));
  await c.steer("s-shared", "alpha guidance", { profile: "alpha", turnId: "t-alpha" });
  await c.redirect("s-shared", "beta guidance", { profile: "beta", turnId: "t-beta" });
  await c.interrupt("s-shared", { profile: "beta", turnId: "t-beta" });
  assert.deepEqual(calls("native.steer")[0].params, { session_id: "s-shared", turn_id: "t-alpha", owner_pid: 4242, text: "alpha guidance" });
  assert.equal(calls("native.interrupt")[0].params.owner_pid, 4343);
  const native = next(c, "event", (e) => e.type === "native.ambiguous");
  await c.sessions();
  assert.deepEqual([ (await native).sid, events.find((e) => e.type === "native.test").profile ], [null, "beta"]);
  await c.deleteSession("s-shared", { profile: "alpha" });
  assert.deepEqual(calls("session.delete")[0].params, { session_id: "s-shared", profile: "alpha" });
  assert.deepEqual(calls("session.close")[0].params, { session_id: "rpc-alpha-s-shared" });
  assert.deepEqual(c.currentSnapshot().nodes.filter((n) => n.sid === "s-shared").map((n) => n.profile), ["beta"]);
  await c.send("s-shared", "beta survives", { profile: "beta" });
  assert.equal(calls("session.resume").length, 2);
  assert.equal(calls("prompt.submit").at(-1).params.session_id, "rpc-beta-s-shared");
});

test("fresh sessions with cloned stored SIDs reconcile only their own profile", async (t) => {
  const { c, calls } = await fixture(t);
  await c.send("s-legacy-unknown", "legacy default profile");
  assert.equal(calls("session.resume")[0].params.profile, undefined);
  const alpha = await c.create({ profile: "alpha" });
  const beta = await c.create({ profile: "beta" });
  assert.equal(alpha.sid, beta.sid);
  assert.equal(c.created.size, 2);
  await c.send(alpha.sid, "materialize alpha", { profile: "alpha" });
  await next(c, "snapshot", () => c.created.size === 1);
  assert.equal(c.nodeFor(beta.sid, "beta").fresh, true);
  assert.deepEqual(c.currentSnapshot().nodes.filter((n) => n.sid === beta.sid).map((n) => n.profile).sort(), ["alpha", "beta"]);
  await c.deleteSession(beta.sid, { profile: "beta" });
  assert.ok(c.nodeFor(alpha.sid, "alpha"));
  assert.equal(c.nodeFor(beta.sid, "beta"), null);
});

test("a stored recent owner and another live owner require explicit selection for the same SID", async (t) => {
  const { c, calls } = await fixture(t, ["--profile-recent-owner"], { autoList: true });
  if (!c.recent.length) await next(c, "sessions");
  assert.equal(c.nodeFor("s-shared", "alpha").profile, "alpha");
  assert.equal(c.recent[0].profile, "default");
  await assert.rejects(c.send("s-shared", "ambiguous"), /ambiguous/);
  await assert.rejects(c.modelOptions("s-shared"), /ambiguous/);
  await assert.rejects(c.setModel("s-shared", { model: "model-a", provider: "prov" }), /ambiguous/);
  await assert.rejects(c.deleteSession("s-shared"), /ambiguous/);
  await assert.rejects(c.steer("s-shared", "ambiguous"), /ambiguous/);
  await assert.rejects(c.interrupt("s-shared"), /ambiguous/);
  assert.equal(calls("session.resume").length, 0);
  assert.equal(calls("session.delete").length, 0);
  assert.equal(calls("native.steer").length, 0);
  await c.send("s-shared", "default selected", { profile: "default" });
  await c.send("s-shared", "alpha selected", { profile: "alpha" });
  assert.deepEqual(calls("prompt.submit").map((r) => r.params.session_id), ["rpc-default-s-shared", "rpc-alpha-s-shared"]);
});

test("colliding host approval IDs and disconnect never route or replay a mutation", async (t) => {
  const { c, calls } = await fixture(t, ["--profile-request-collision"]);
  const asked = next(c, "requests", (r) => r.filter((x) => x.id === "A-shared").length === 2 && r.filter((x) => x.id === "A-native").length === 2);
  await Promise.all([c.send("s-shared", "one", { profile: "alpha" }), c.send("s-shared", "two", { profile: "beta" })]);
  await asked;
  await assert.rejects(c.answerApproval("A-shared", "once", { profile: "beta" }));
  assert.equal(calls("request.answer").length, 0);
  // Native server frames may use the same stored SID; frame profiles retain both requests too.
  assert.deepEqual(c.listRequests().filter((r) => r.id === "A-native").map((r) => r.profile).sort(), ["alpha", "beta"]);
  await assert.rejects(c.answerApproval("A-native", "once", { profile: "beta" }));
  const { c: lost, calls: lostCalls } = await fixture(t, ["--exit-on", "prompt.submit"], { retry: true });
  let offline = false;
  let authorityAtOpen;
  let staleControl;
  lost.on("status", (s) => {
    if (s.status === "offline") offline = true;
    if (s.status === "open" && offline) {
      authorityAtOpen = lost.nodeFor("s-shared", "alpha");
      staleControl = assert.rejects(lost.steer("s-shared", "stale before fresh snapshot", { profile: "alpha", turnId: "t-alpha" }));
    }
  });
  const reopened = next(lost, "status", (s) => s.status === "open");
  await assert.rejects(lost.send("s-shared", "once", { profile: "alpha" }));
  await assert.rejects(lost.send("s-shared", "offline", { profile: "beta" }));
  assert.equal(lostCalls("prompt.submit").length, 1);
  assert.equal(lost.bindings.size, 0);
  assert.equal(lost.rpcToStored.size, 0);
  assert.equal(lost.listRequests().length, 0);
  assert.equal(lost.nodeFor("s-shared", "alpha"), null);
  await reopened;
  await staleControl;
  assert.equal(authorityAtOpen, null);
  assert.equal(lostCalls("native.steer").length, 0);
  assert.equal(lostCalls("prompt.submit").length, 1);
});


test("interrupt uses only a current profile-bound gateway before its native snapshot", async (t) => {
  const { c, calls } = await fixture(t);
  const sid = "s-before-native";
  await Promise.all([c.modelOptions(sid, { profile: "alpha" }), c.modelOptions(sid, { profile: "beta" })]);
  assert.equal(c.nodeFor(sid, "alpha"), null);
  assert.equal(c.nodeFor(sid, "beta"), null);
  await assert.rejects(c.interrupt(sid), /ambiguous/);
  await assert.rejects(c.interrupt(sid, { profile: "gamma" }));
  await assert.rejects(c.interrupt(sid, { profile: "alpha", turnId: "unverified-turn" }));
  await assert.rejects(c.steer(sid, "guidance", { profile: "alpha" }));
  await assert.rejects(c.redirect(sid, "replacement", { profile: "beta" }));
  assert.equal(calls("session.interrupt").length, 0);
  assert.deepEqual(await c.interrupt(sid, { profile: "alpha" }), { status: "interrupted" });
  const binding = c.bindings.get(JSON.stringify(["alpha", sid]));
  binding.epoch -= 1;
  await assert.rejects(c.interrupt(sid, { profile: "alpha" }));
  assert.deepEqual(await c.interrupt(sid, { profile: "beta" }), { status: "interrupted" });
  assert.deepEqual(calls("session.interrupt").map((r) => r.params.session_id), ["rpc-alpha-s-before-native", "rpc-beta-s-before-native"]);
  assert.equal(calls("session.resume").length, 2); // interrupt never resumes or invents a binding
  assert.equal(calls("native.interrupt").length, 0);
  await c.stop();
  await assert.rejects(c.interrupt(sid, { profile: "beta" }));
  assert.equal(calls("session.interrupt").length, 2);
});


test("request cancellation matches runtime session and profile before unique legacy fallback", async (t) => {
  const { c } = await fixture(t, ["--profile-request-collision"]);
  const asked = next(c, "requests", (r) => r.filter((x) => x.id === "A-shared").length === 3);
  await Promise.all([
    c.send("s-cancel-one", "alpha one", { profile: "alpha" }),
    c.send("s-cancel-two", "alpha two", { profile: "alpha" }),
    c.send("s-cancel-one", "beta one", { profile: "beta" }),
  ]);
  await asked;
  const active = () => c.listRequests().filter((r) => r.id === "A-shared").map((r) => r.rpcId).sort();
  const cancel = (session_id, profile_name) => c._onServerFrame({ method: "event", params: {
    type: "request.cancel", session_id, ...(profile_name === undefined ? {} : { profile_name }), payload: { id: "A-shared", reason: "interrupted" },
  } });
  const all = ["rpc-alpha-s-cancel-one", "rpc-alpha-s-cancel-two", "rpc-beta-s-cancel-one"].sort();
  assert.deepEqual(active(), all);
  cancel("", "alpha"); // two same-profile candidates are ambiguous without runtime identity
  assert.deepEqual(active(), all);
  cancel("rpc-alpha-s-cancel-one", "beta"); // contradictory reported profile cannot fall back
  assert.deepEqual(active(), all);
  cancel("rpc-alpha-s-cancel-one", "alpha");
  assert.deepEqual(active(), ["rpc-alpha-s-cancel-two", "rpc-beta-s-cancel-one"]);
  cancel("");
  assert.equal(active().length, 2);
  cancel("rpc-alpha-s-cancel-two"); // authoritative current runtime binding supplies profile
  assert.deepEqual(active(), ["rpc-beta-s-cancel-one"]);
  cancel(""); // legacy ID-only cancellation is safe only for one remaining candidate
  assert.deepEqual(active(), []);
});


test("confirmed canonical deletion clears only matching bot expectation and allows explicit recreation", async (t) => {
  const { c, calls } = await fixture(t, ["--bot-delete-lifecycle"]);
  const ops = await c.botChat("ops");
  const research = await c.botChat("research");
  await c.deleteSession("s-unrelated", { profile: "ops" });
  assert.equal(c.botSeen.has("ops"), true);
  assert.equal(c.botSeen.has("research"), true);
  await c.deleteSession(ops.sid, { profile: "ops" });
  assert.equal(c.botSeen.has("ops"), false);
  assert.equal(c.botSeen.has("research"), true);
  assert.equal(await c.botChat("ops"), null);
  assert.equal(calls("session.create").length, 0); // deletion/lookup never recreate automatically
  const replacement = await c.createBotChat("ops");
  assert.equal(replacement.created, true);
  assert.notEqual(replacement.sid, ops.sid);
  assert.equal(calls("session.create").length, 1);
  assert.equal(c.created.get(JSON.stringify(["ops", replacement.sid])).fresh, true);
  await c.deleteSession(replacement.sid, { profile: "ops" }); // title already persisted this fresh canonical row
  assert.equal(calls("session.delete").at(-1).params.session_id, replacement.sid);
  assert.equal(await c.botChat("ops"), null);
  assert.equal(calls("session.create").length, 1);
  await c.deleteSession(research.sid, { profile: "research" }); // compressed tip alias is canonical too
  assert.equal(c.botSeen.has("research"), false);
  const rejected = await fixture(t, ["--bot-delete-lifecycle", "--bot-delete-fail"]);
  const retained = await rejected.c.botChat("ops");
  await assert.rejects(rejected.c.deleteSession(retained.sid, { profile: "ops" }), /refused/);
  assert.equal(rejected.c.botSeen.has("ops"), true);
  assert.equal((await rejected.c.botChat("ops")).sid, retained.sid);
  const lost = await fixture(t, ["--bot-delete-lifecycle", "--exit-on", "session.delete"]);
  const uncertain = await lost.c.botChat("ops");
  await assert.rejects(lost.c.deleteSession(uncertain.sid, { profile: "ops" }));
  assert.equal(lost.c.botSeen.has("ops"), true);
  assert.equal(lost.c.botPending.get("ops").chat.sid, uncertain.sid);
  assert.equal(lost.calls("session.create").length, 0);
});


test("a delayed answer retires only its captured request arrival", async (t) => {
  const { c, calls } = await fixture(t, ["--delay", "request.answer=90"]);
  const asked = next(c, "requests", (r) => r.some((x) => x.id === "A-alpha"));
  await c.send("s-shared", "ask", { profile: "alpha" });
  await asked;
  const old = c.listRequests().find((r) => r.id === "A-alpha");
  const answering = c.answerApproval(old.id, "once", { profile: "alpha" });
  c._onServerFrame({ id: old.id, method: "approval", params: { session_id: old.rpcId, command: old.command, description: old.description, choices: old.choices } });
  const replacement = [...c.openRequests.values()].find((r) => r.id === old.id);
  replacement.at = old.at; // even identical fields/same-millisecond arrival is a different request
  assert.deepEqual(c.listRequests().find((r) => r.id === old.id), old);
  await answering;
  assert.equal([...c.openRequests.values()].find((r) => r.id === old.id), replacement);
  await c.answerApproval(old.id, "once", { profile: "alpha" });
  assert.equal(c.listRequests().some((r) => r.id === old.id), false);
  assert.equal(calls("request.answer").length, 2);
});

test("session listing launch provenance resolves named alias and retains real root collisions", async (t) => {
  const named = await fixture(t, ["--profile-recent-owner", "--profile-launch-owner", "alpha"], { autoList: true });
  if (!named.c.recent.length) await next(named.c, "sessions");
  assert.equal(named.c.recent[0].profile, "alpha");
  await named.c.send("s-shared", "implicit named launch");
  assert.equal(named.calls("session.resume")[0].params.profile, "alpha");
  assert.equal(named.calls("prompt.submit")[0].params.session_id, "rpc-alpha-s-shared");
  assert.equal((await named.c.sessions({ profile: "beta" }))[0].profile, "beta"); // explicit request owns returned DB
  const root = await fixture(t, ["--profile-recent-owner", "--profile-launch-owner", "default"], { autoList: true });
  if (!root.c.recent.length) await next(root.c, "sessions");
  assert.equal(root.c.recent[0].profile, "default");
  await assert.rejects(root.c.send("s-shared", "real imported SID collision"), /ambiguous/);
  assert.equal(root.calls("session.resume").length, 0);
  await root.c.send("s-shared", "explicit root", { profile: "default" });
  assert.equal(root.calls("prompt.submit")[0].params.session_id, "rpc-default-s-shared");
  const bridge = require("../main/bridge");
  assert.equal(bridge.projectSessions({ launch_profile: "alpha", sessions: [{ id: "s", profile_name: "default" }] })[0].profile, "default");
  assert.equal(bridge.projectSessions({ launch_profile: "../invalid", sessions: [{ id: "s" }] })[0].profile, "default");
});


test("rejected profile claims stay rejected while legitimate pre-binding requests resolve", async (t) => {
  const { c, calls } = await fixture(t);
  const approval = (id, rpcId, claim) => c._onServerFrame({ id, method: "approval", params: {
    session_id: rpcId, ...(claim === undefined ? {} : { profile_name: claim }), command: "fixture command", choices: ["once", "deny"],
  } });
  approval("pending-explicit", "rpc-alpha-s-prebind", "alpha");
  approval("pending-implicit", "rpc-alpha-s-prebind");
  assert.equal(c.listRequests().find((r) => r.id === "pending-explicit").profile, "alpha");
  assert.equal(c.listRequests().find((r) => r.id === "pending-implicit").profile, null);
  await assert.rejects(c.answerApproval("pending-implicit", "once"));
  assert.equal(calls("request.answer").length, 0);
  await c.modelOptions("s-prebind", { profile: "alpha" });
  assert.deepEqual(c.listRequests().filter((r) => r.id.startsWith("pending-")).map((r) => [r.profile, r.sid]), [["alpha", "s-prebind"], ["alpha", "s-prebind"]]);
  approval("conflict", "rpc-alpha-s-prebind", "beta");
  approval("invalid", "rpc-alpha-s-prebind", "../invalid");
  c._onServerFrame({ id: "invalid-question", method: "clarify", params: { session_id: "rpc-alpha-s-prebind", profile_name: 42, questions: [{ qid: "q", question: "fixture" }] } });
  assert.equal(c.listRequests().some((r) => ["conflict", "invalid", "invalid-question"].includes(r.id)), false);
  await assert.rejects(c.answerApproval("conflict", "once"));
  await assert.rejects(c.answerApproval("invalid", "once", { profile: "alpha" }));
  await assert.rejects(c.answerQuestion("invalid-question", { q: "answer" }));
  approval("later-conflict", "rpc-beta-s-later", "alpha"); // valid explicit claim remains pending until a conflicting binding arrives
  await c.modelOptions("s-later", { profile: "beta" });
  assert.equal(c.listRequests().find((r) => r.id === "later-conflict").profile, null);
  await assert.rejects(c.answerApproval("later-conflict", "once"));
  await assert.rejects(c.answerApproval("later-conflict", "once", { profile: "beta" }));
  assert.equal(calls("request.answer").length, 0);
  approval("valid", "rpc-alpha-s-prebind", "alpha");
  await c.answerApproval("valid", "once", { profile: "alpha" });
  await c.answerApproval("pending-explicit", "once", { profile: "alpha" });
  await c.answerApproval("pending-implicit", "once");
  assert.deepEqual(calls("request.answer").map((r) => r.params.id), ["valid", "pending-explicit", "pending-implicit"]);
});


test("trusted request arrival survives repeated projection and reconnect without rounding replacement", async (t) => {
  const { c } = await fixture(t);
  const arrival = 1700000000.1234567;
  const replacementArrival = 1700000000.1234574;
  const frame = { id: "stable-arrival", method: "approval", request_created_at: arrival, params: { session_id: "rpc-alpha-s-arrival", command: "fixture", choices: ["once", "deny"] } };
  await c.modelOptions("s-arrival", { profile: "alpha" });
  c._onServerFrame(frame);
  const first = c.listRequests().find((r) => r.id === frame.id);
  assert.equal(first.createdAt, arrival);
  assert.deepEqual([first.profile, first.sid, first.rpcId], ["alpha", "s-arrival", "rpc-alpha-s-arrival"]);
  for (let i = 0; i < 3; i++) assert.equal(c.listRequests().find((r) => r.id === frame.id).createdAt, arrival);
  await c.stop();
  const restarted = next(c, "snapshot"); c.start(); await restarted;
  await c.modelOptions("s-arrival", { profile: "alpha" });
  c._onServerFrame(frame);
  assert.equal(c.listRequests().find((r) => r.id === frame.id).createdAt, arrival);
  c._onServerFrame({ ...frame, request_created_at: replacementArrival });
  const replacement = c.listRequests().find((r) => r.id === frame.id);
  assert.equal(Math.floor(arrival * 1000), Math.floor(replacementArrival * 1000));
  assert.equal(replacement.createdAt, replacementArrival);
  assert.notEqual(replacement.createdAt, first.createdAt);
  await c.modelOptions("s-arrival", { profile: "beta" });
  c._onServerFrame({ ...frame, id: "beta-arrival", params: { ...frame.params, session_id: "rpc-beta-s-arrival" } });
  assert.equal(c.listRequests().find((r) => r.id === "beta-arrival").profile, "beta");
  for (const [id, value] of [["legacy", undefined], ["invalid", "1700000000"], ["nonfinite", Infinity]]) {
    c._onServerFrame({ ...frame, id, request_created_at: value });
    assert.equal(Object.hasOwn(c.listRequests().find((r) => r.id === id), "createdAt"), false);
  }
});

test('0.2.1 lifecycle metadata and discard keep cloned session owners separate', async t => {
  const { c, calls } = await fixture(t);
  await c.renameSession('s-shared', { profile: 'alpha', title: 'alpha renamed' });
  assert.equal(c.nodeFor('s-shared', 'alpha').title, 'alpha renamed');
  assert.notEqual(c.nodeFor('s-shared', 'beta').title, 'alpha renamed');
  await c.pinSession('s-shared', { profile: 'beta', pinned: true });
  Object.assign(c.nodeFor('s-shared', 'alpha'), { active: true, terminalAt: null });
  await assert.rejects(c.archiveSession('s-shared', { profile: 'alpha', archived: true }), /running|busy|çalış/i);
  await c.archiveSession('s-shared', { profile: 'beta', archived: false });
  await c.setEffort('s-shared', { profile: 'beta', effort: 'high' });
  assert.equal(calls('config.set').at(-1).params.session_id, 'rpc-beta-s-shared');
  const a = await c.create({ profile: 'alpha' });
  const b = await c.create({ profile: 'beta' });
  assert.equal(a.sid, b.sid);
  assert.equal(c.newSessions.size, 2);
  await assert.rejects(c.discard(a.sid), /ambiguous/);
  await c.discard(a.sid, { profile: 'alpha' });
  assert.equal(c.nodeFor(b.sid, 'alpha'), null);
  assert.equal(c.nodeFor(b.sid, 'beta').profile, 'beta');
  assert.equal(c.newSessions.size, 1);
  c._onSnapshot(c.conn, { schema: 'hermes-deck.v1', hook_event_name: 'HermesSnapshot', connection_id: 'hermes', nodes: [
    { session_id: a.sid, profile_name: 'alpha' }, { session_id: b.sid, profile_name: 'beta' }
  ] });
  assert.deepEqual(c.currentSnapshot().nodes.filter(n => n.sid === a.sid).map(n => n.profile), ['beta']);
});
