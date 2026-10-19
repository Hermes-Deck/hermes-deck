"use strict";
// Group Chat request shapes and reply projections (app/main/group-rpc.js), and the groups.* methods in the bridge's
// allowlist. Pure: no Electron, no host. Run from the repo root: node --test app/test/group-rpc.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const G = require("../main/group-rpc");
const bridge = require("../main/bridge");

const MEMBERS = [
  { member_id: "atlas", profile: "atlas", handle: "atlas", display_name: "Atlas" },
  { member_id: "default", profile: "default", handle: "hermes" },
];
const SAMPLES = {
  "groups.capabilities": {},
  "groups.list": { limit: 100 },
  "groups.state": { room_id: "deck-1" },
  "groups.log": { room_id: "deck-1", since_seq: 0, limit: 200 },
  "groups.create": { room_id: "deck-1", name: "Planning", members: MEMBERS },
  "groups.send": { room_id: "deck-1", event_id: "deck-2", payload: { text: "@atlas hi", thread_id: "main" } },
  "groups.rename": { room_id: "deck-1", event_id: "deck-3", name: "Launch" },
  "groups.stop": { room_id: "deck-1" },
  "groups.disband": { room_id: "deck-1" },
  "groups.retry": { room_id: "deck-1", task_id: "dtask:ab" },
  "groups.approve": { room_id: "deck-1", member_id: "atlas", task_id: "dtask:ab", execution_generation: 1, request_id: "req-1", choice: "once" },
};

test("every groups.* method the Deck sends is in the bridge allowlist and passes checkRequest", () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), Object.keys(G.SHAPES).sort());
  for (const m of G.GROUP_READS) assert.ok(bridge.READS.includes(m), m);
  for (const m of G.GROUP_MUTATIONS) assert.ok(bridge.MUTATIONS.includes(m), m);
  for (const [m, p] of Object.entries(SAMPLES)) assert.doesNotThrow(() => bridge.checkRequest(m, p), m);
  // the replication / promotion / peer methods stay closed
  for (const m of ["groups.replicate", "groups.promote", "groups.demote", "groups.peer.invite", "groups.peer.register", "groups.replica_state"]) {
    assert.throws(() => bridge.checkRequest(m, { room_id: "deck-1" }), m);
  }
});

test("groups.* shapes: extra keys and bad values are refused", () => {
  for (const [m, p] of Object.entries(SAMPLES)) assert.equal(G.validGroupRequest(m, { ...p, profile: "x" }), false, m);
  const bad = [
    ["groups.list", { limit: 0 }], ["groups.list", { offset: -1 }],
    ["groups.state", { room_id: "../x" }], ["groups.state", { room_id: "" }], ["groups.state", { room_id: "a".repeat(129) }],
    ["groups.log", { room_id: "r", since_seq: -1, limit: 10 }], ["groups.log", { room_id: "r", since_seq: 0, limit: 501 }],
    ["groups.create", { room_id: "r", name: "  ", members: MEMBERS }],
    ["groups.create", { room_id: "r", name: "Room", members: MEMBERS.slice(0, 1) }],
    ["groups.create", { room_id: "r", name: "Room", members: [...MEMBERS, ...MEMBERS.map((m) => ({ ...m, member_id: `${m.member_id}2` }))] }],
    ["groups.create", { room_id: "r", name: "Room", members: [{ ...MEMBERS[0], target: { kind: "peer" } }, MEMBERS[1]] }],
    ["groups.send", { room_id: "r", event_id: "e", payload: { text: " ", thread_id: "main" } }],
    ["groups.send", { room_id: "r", event_id: "e", payload: { text: "hi" } }],
    ["groups.send", { room_id: "r", event_id: "e", payload: { text: "x".repeat(G.TEXT_MAX + 1), thread_id: "main" } }],
    ["groups.rename", { room_id: "r", event_id: "e", name: "" }],
    ["groups.approve", { ...SAMPLES["groups.approve"], choice: "all" }],
    ["groups.approve", { ...SAMPLES["groups.approve"], execution_generation: 0 }],
  ];
  for (const [m, p] of bad) assert.equal(G.validGroupRequest(m, p), false, `${m} ${JSON.stringify(p).slice(0, 80)}`);
  for (const choice of ["once", "session", "always", "deny"]) assert.ok(G.validGroupRequest("groups.approve", { ...SAMPLES["groups.approve"], choice }));
});

test("roomMembers: local bots, @hermes for the primary profile, 2-6 distinct", () => {
  assert.deepEqual(G.roomMembers([{ profile: "atlas", name: "Atlas" }, { profile: "default", name: "Hermes" }, { profile: "atlas", name: "dup" }]), [
    { member_id: "atlas", profile: "atlas", handle: "atlas", display_name: "Atlas" },
    { member_id: "default", profile: "default", handle: "hermes", display_name: "Hermes" },
  ]);
  assert.throws(() => G.roomMembers([{ profile: "atlas" }]), RangeError);
  assert.throws(() => G.roomMembers(["a", "b", "c", "d", "e", "f", "g"].map((profile) => ({ profile }))), RangeError);
  assert.throws(() => G.roomMembers([{ profile: "../x" }, { profile: "atlas" }]), RangeError);
});

test("projections keep only what the room view reads", () => {
  assert.deepEqual(G.projectCapabilities({ driver: true, methods: ["groups.list", "groups.create", "groups.state", "groups.log", "groups.send"], max_log_limit: 500 }).supported, true);
  assert.equal(G.projectCapabilities({ driver: false, methods: ["groups.list", "groups.create", "groups.state", "groups.log", "groups.send"] }).supported, false);
  assert.equal(G.projectCapabilities({ driver: true, methods: ["groups.list"] }).supported, false);
  assert.equal(G.projectCapabilities(null).supported, false);
  const rooms = G.projectRooms({ rooms: [
    { room_id: "deck-1", name: "Planning\u0000", members: [{ member_id: "atlas", profile: "atlas", handle: "atlas", display_name: "Atlas", target: { kind: "local", profile: "atlas" } }], latest_seq: 4, updated_at: 1700000000, authority_gateway_id: "gw" },
    { room_id: "bad id" }, { room_id: "deck-2", name: "Gone", members: [], disbanded_at: 1 },
  ] });
  assert.deepEqual(rooms, [{ id: "deck-1", name: "Planning", members: [{ id: "atlas", profile: "atlas", handle: "atlas", name: "Atlas", remote: false }], latestSeq: 4, updatedAt: 1700000000, createdAt: null, disbanded: false }]);
  const log = G.projectLog({ events: [
    { seq: 2, event_id: "dmessage:1", kind: "message.member", actor: { kind: "member", id: "atlas", profile: "atlas", display_name: "Atlas" }, payload: { text: "Hi\nthere", thread_id: "main", member_id: "atlas", discussion_event_id: "user:1", round_index: 0 }, created_at: 5 },
    { seq: 1, event_id: "user:1", kind: "message.user", actor: { kind: "user", id: "desktop" }, payload: { text: "@atlas hi", thread_id: "main" }, created_at: 4 },
    { seq: 3, event_id: "x", kind: "authority.claimed", actor: { kind: "system", id: "s" }, payload: { secret: "no" } },
    { seq: 4, event_id: "dterminal:1", kind: "turn.failed", actor: { kind: "gateway", id: "gw" }, payload: { error: "boom\nstack", reason_code: "provider_error", member_id: "atlas" } },
  ], cursor: 4, latest_seq: 6, has_more: true });
  assert.deepEqual(log.events.map((e) => [e.seq, e.kind]), [[1, "message.user"], [2, "message.member"], [3, "other"], [4, "turn.failed"]]);
  assert.equal(log.events[1].text, "Hi\nthere");
  assert.equal(log.events[1].actor.name, "Atlas");
  assert.equal(log.events[3].error, "boom");
  assert.equal(JSON.stringify(log.events[2]).includes("secret"), false);
  assert.deepEqual([log.cursor, log.latestSeq, log.hasMore], [4, 6, true]);
  const st = G.projectState({ room: { room_id: "deck-1", name: "P", members: [] }, driver_status: { working: true, pending_actions: [
    { kind: "approval", member_id: "atlas", task_id: "dtask:1", execution_generation: 2, request_id: "req-1", session_id: "secret-session", run_id: "run", approval: { command: "rm -rf build", description: "Delete", choices: ["once", "deny", "weird"] } },
    { kind: "retry", task_id: "dtask:2" }, { kind: "approval", member_id: "atlas" },
  ] } });
  assert.deepEqual(st.approvals, [{ memberId: "atlas", taskId: "dtask:1", generation: 2, requestId: "req-1", command: "rm -rf build", description: "Delete", choices: ["once", "deny"] }]);
  assert.deepEqual(st.retries, [{ taskId: "dtask:2" }]);
  assert.equal(st.working, true);
  assert.equal(JSON.stringify(st).includes("secret-session"), false);
});
