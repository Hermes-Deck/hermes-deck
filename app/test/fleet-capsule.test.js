"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../renderer/fleet-capsule");
test("fleet merges direct and relay by profile and sorts waiting, running, idle, offline", () => {
  const data = { bridgeStatus: "open", relayStatus: "open", fleet: { profiles: { offline: { stale: true } } },
    agents: { Primary: { name: "Primary", profile: "default" }, Worker: { name: "Worker", profile: "worker" }, Idle: { name: "Idle", profile: "idle" }, Offline: { name: "Offline", profile: "offline" } },
    requests: [{ id: "req", sid: "wait", profile: "default", kind: "approval" }],
    direct: [{ sid: "wait", profile: "default", state: "approval", title: "Permission" }, { sid: "run", profile: "worker", state: "working", title: "Build" }],
    relay: [{ sid: "run", profile: "worker", agent: "Worker", state: "running", turnTs: 100 }, { sid: "child", parent: "run", profile: "worker", state: "running", goal: "Check", turnTs: 101 }] };
  const agents = F.derive(data);
  assert.deepEqual(agents.map(a => a.state), ["waiting", "running", "idle", "offline"]);
  assert.equal(agents[1].children.length, 1);
  assert.equal(agents[1].task, "Build");
  assert.equal(F.elapsed(agents[1].session, 110), 10);
  assert.equal(F.elapsed({ state: "working", updatedAt: 10 }, 100), null, "no guessed start from a snapshot refresh timestamp");
});

test("fleet today totals preserve unknown cost and cache denominator without reasoning duplication", () => {
  assert.equal(F.today({ agents: {} }), null);
  const total = F.today({ agents: { Primary: { today: { in: 100, cw: 10, cr: 90, out: 20, rs: 5, n: 2, usd: .125, estimated: true } }, Worker: { today: { out: 10, n: 1, unknownCost: 1 } } } });
  assert.equal(total.tokens, 230);
  assert.equal(total.hit, .45);
  assert.equal(total.n, 3);
  assert.equal(total.usd, .125);
  assert.equal(total.unknownCost, 1);
  assert.equal(total.estimated, true);
});

test("fleet capsule toggles a safe dialog, routes children and removes timers/listeners on teardown", t => {
  const { dom } = require("./inbox-dom-helper"), { createStore } = require("../renderer/inbox");
  const { h, doc, win, walk } = dom();
  const store = createStore();
  store.feedRelay({ t: "snapshot", agents: { Primary: { name: "Primary", profile: "default", today: { usd: 1, n: 2 } } }, sessions: [{ sid: "s-1", profile: "default", state: "running", lastMsg: "<b>Task</b>", turnTs: 10 }, { sid: "s-2", parent: "s-1", profile: "default", goal: "<script>Child</script>", state: "running" }] });
  const events = [];
  const fleet = F.createFleet({ h, doc, win, store, t: key => key, usage: require("../renderer/usage-view"), shell: { openRight: (...args) => events.push(args) }, openChat: row => events.push(row), selectAgent: row => events.push(row) });
  t.after(() => fleet.destroy());
  assert.ok(!fleet.button.children.includes(null), "native replaceChildren must not render a literal null label");
  assert.equal(fleet.button.attrs["aria-expanded"], "false");
  fleet.toggle();
  assert.equal(fleet.button.attrs["aria-expanded"], "true");
  assert.equal(fleet.panel.attrs.role, "dialog");
  assert.ok(walk(fleet.panel).some(x => x.children?.includes("<b>Task</b>")));
  walk(fleet.panel).find(x => x.attrs.class === "tf-child").click();
  assert.deepEqual(events[0], ["work", "agents"]);
  assert.equal(events[1].childSid, "s-2");
  assert.equal(fleet.button.attrs["aria-expanded"], "false");
  fleet.toggle();
  fleet.toggle();
  assert.equal(fleet.button.attrs["aria-expanded"], "false");
  fleet.destroy();
  assert.equal(doc.listeners.size, 0);
  assert.equal(win.listeners.size, 0);
});

test("fleet child selection is one document event with the Lane D shape, and a missing parent sends nothing", () => {
  const sent = [];
  const doc = { dispatchEvent: e => sent.push(e) };
  assert.equal(F.selectAgent(doc, { sid: "s-1", childSid: "s-2", subagentId: 7, extra: "<x>" }), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "deck-agent-select");
  assert.deepEqual(sent[0].detail, { sid: "s-1", profile: "default", childSid: "s-2", subagentId: null }, "only the documented fields, non-string ids dropped");
  assert.equal(F.selectAgent(doc, { childSid: "s-2" }), false);
  assert.equal(F.selectAgent(doc, null), false);
  assert.equal(sent.length, 1, "no event without a parent session");
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../renderer/fleet-capsule.js"), "utf8");
  assert.ok(!/DeckWorkPane|service\("selectAgent"\)/.test(src), "no dead fallbacks besides the documented event");
});

test("fleet shows only live sub-agents; finished ones fold behind one toggle", t => {
  const { dom } = require("./inbox-dom-helper"), { createStore } = require("../renderer/inbox");
  const { h, doc, win, walk } = dom();
  const store = createStore();
  const done = Array.from({ length: 12 }, (_, i) => ({ sid: `d-${i}`, parent: "s-1", profile: "default", goal: `Done ${i}`, state: "done" }));
  store.feedRelay({ t: "snapshot", agents: { Primary: { name: "Primary", profile: "default" } }, sessions: [{ sid: "s-1", profile: "default", state: "idle", lastMsg: "Root" }, { sid: "s-live", parent: "s-1", profile: "default", goal: "Live child", state: "running" }, ...done] });
  const fleet = F.createFleet({ h, doc, win, store, t: (key, v) => v && v.n !== undefined ? `${key}:${v.n}` : key, usage: require("../renderer/usage-view"), shell: { openRight() {} }, openChat() {}, selectAgent() {} });
  t.after(() => fleet.destroy());
  fleet.toggle();
  const kids = () => walk(fleet.panel).filter(x => x.attrs?.class === "tf-child");
  assert.equal(kids().length, 1, "only the running child is listed");
  const more = walk(fleet.panel).find(x => x.attrs?.class === "tf-more");
  assert.ok(more.children.includes("triage.finishedSubs:12"));
  more.click();
  assert.equal(kids().length, 13);
  walk(fleet.panel).find(x => x.attrs?.class === "tf-more").click();
  assert.equal(kids().length, 1);
});
