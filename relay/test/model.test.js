"use strict";
// Session identity (R4): the bridge's profile for a session beats the event stamp, and /snapshot says per agent
// whether its numbers are attributed (`scoped`) or may include another profile's work.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Model } = require("../src/model");
const { reconcilingBridge } = require("../src/index");

const AGENTS = { profiles: { default: { name: "Primary" }, ada: { name: "Ada" }, atlas: { name: "Atlas" } } };
const T = 1_800_000_000;

// An older plugin stamped every event of a multiplexed gateway with one cached name ("default").
function oldStampedTurn(m, sid, { ts = T, child } = {}) {
  m.apply({ ev: "turn_start", sid, profile: "default", ts, msg: "do the thing" }, true);
  m.apply({ ev: "tool_start", sid, profile: "default", ts: ts + 1, tool: "terminal", call: "c1" }, true);
  m.apply({ ev: "llm", sid, profile: "default", ts: ts + 2, model: "model-a", usage: { in: 100, out: 10 } }, true);
  if (child) m.apply({ ev: "sub_start", sid, child, profile: "default", ts: ts + 3, goal: "help" }, true);
}

test("a session stamped with the wrong profile moves to the profile the bridge names", () => {
  const m = new Model(AGENTS);
  oldStampedTurn(m, "s-ada", { child: "s-ada-child" });
  let agents = m.agents(T + 10);
  assert.equal(agents.Primary.running, 1);
  assert.equal(agents.Primary.subsRunning, 1);
  assert.equal(agents.Primary.curTool.sid, "s-ada");
  assert.equal(agents.Primary.scoped, false); // unconfirmed stamps: host-wide, not Primary's own
  m.takeDirty(T + 10);

  assert.equal(m.reconcile([{ sid: "s-ada", profile: "ada" }]), 1);
  const { agents: after, sessions } = m.snapshot();
  const row = sessions.find((s) => s.sid === "s-ada");
  assert.equal(row.profile, "ada");
  assert.equal(row.agent, "Ada");
  assert.equal(row.stamped, "default");
  assert.equal(sessions.find((s) => s.sid === "s-ada-child").profile, "ada"); // its sub-agent follows
  agents = m.agents(T + 10);
  assert.equal(agents.Primary.running, 0);
  assert.equal(agents.Primary.subsRunning, 0);
  assert.equal(agents.Primary.curTool, null);
  assert.equal(agents.Ada.running, 1);
  assert.equal(agents.Ada.subsRunning, 1);
  assert.equal(agents.Ada.curTool.sid, "s-ada");
  assert.equal(after.Ada.scoped, false); // the sub-agent itself is not bridge-confirmed yet
  assert.deepEqual(m.takeDirty(T + 10).map((s) => s.sid).sort(), ["s-ada", "s-ada-child"]);
  m.reconcile([{ sid: "s-ada-child", profile: "ada" }]);
  assert.equal(m.agents(T + 10).Ada.scoped, true);
  assert.equal(m.agents(T + 10).Primary.scoped, true);

  // later events of the session keep the bridge's profile, and new token use books to the right agent
  m.apply({ ev: "llm", sid: "s-ada", profile: "default", ts: T + 20, model: "model-a", usage: { in: 7, out: 1 } }, true);
  assert.equal(m.sessions.get("s-ada").profile, "ada");
  const today = m.tokens(1, T + 30);
  assert.equal(today.find((r) => r.agent === "Ada").in, 7);
});

test("the bridge's profile applies to a session it names before its first event", () => {
  const m = new Model(AGENTS);
  m.reconcile([{ sid: "s-atlas", profile: "atlas" }]);
  oldStampedTurn(m, "s-atlas");
  const s = m.sessions.get("s-atlas");
  assert.equal(s.profile, "atlas");
  assert.equal(s.agent, "Atlas");
  assert.equal(s.stamped, "default");
  assert.equal(m.agents(T + 10).Atlas.running, 1);
  assert.equal(m.agents(T + 10).Primary.running, 0);
  assert.equal(m.tokens(1, T + 10).find((r) => r.agent === "Atlas").in, 100);
});

test("stamps from a plugin that resolves the profile per call are trusted (scoped) without the bridge", () => {
  const m = new Model(AGENTS);
  m.apply({ ev: "turn_start", sid: "s1", profile: "ada", pscope: "call", ts: T }, true);
  m.apply({ ev: "turn_start", sid: "s2", profile: "atlas", pscope: "call", ts: T }, true);
  const agents = m.agents(T + 5);
  assert.equal(agents.Ada.running, 1);
  assert.equal(agents.Ada.scoped, true);
  assert.equal(agents.Atlas.scoped, true);
  assert.equal(agents.Primary.scoped, true); // nothing counted here at all
});

test("reconcile ignores junk and agrees silently when the stamp was right", () => {
  const m = new Model(AGENTS);
  m.apply({ ev: "turn_start", sid: "s1", profile: "ada", ts: T }, true);
  assert.equal(m.reconcile([null, {}, { sid: "s1" }, { sid: "s1", profile: "../x" }, { sid: 5, profile: "ada" }]), 0);
  assert.equal(m.reconcile([{ sid: "s1", profile: "ada" }]), 0);
  const s = m.sessions.get("s1");
  assert.equal(s.profile, "ada");
  assert.equal(s.stamped, undefined);
  assert.equal(s.profileFrom, "bridge");
  assert.equal(m.agents(T).Ada.scoped, true);
});

test("the relay's bridge wrapper feeds snapshot nodes and runtime bindings to the model", () => {
  class FakeBridge extends EventEmitter {
    constructor(cfg) {
      super();
      this.cfg = cfg;
      this.rpcToStored = new Map([["rpc-1", { sid: "s-bound", profile: "atlas" }]]);
    }
  }
  const m = new Model(AGENTS);
  oldStampedTurn(m, "s-node");
  oldStampedTurn(m, "s-bound");
  const Bridge = reconcilingBridge(FakeBridge, m);
  const b = new Bridge({ mode: "local" });
  assert.deepEqual(b.cfg, { mode: "local" });
  b.emit("snapshot", { nodes: [{ sid: "s-node", profile: "ada", state: "working" }, { bogus: true }] });
  assert.equal(m.sessions.get("s-node").profile, "ada");
  assert.equal(m.sessions.get("s-bound").profile, "atlas");
  assert.doesNotThrow(() => b.emit("snapshot", null)); // never throws into the bridge
});
