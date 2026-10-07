"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Desktops, choose } = require("../src/desktops");

const memStore = () => { let v = {}; return { load: () => v, save: (o) => (v = JSON.parse(JSON.stringify(o))) }; };
const hostA = { id: "agent-host", name: "agent host", ready: true, limit: 1, running: 0 };
const pc = { id: "a1b2c3d4", name: "pc", ready: true, limit: 3, running: 0 };
test("F1: an unrelated host busy listing never creates a restore hold", async () => {
  const { d, local } = rig();
  await d.resolve("agent1");
  local.snapshots = async () => ({ points: [], busy: true, recovery: false });
  await d.snapshots("agent1");
  assert.equal(d.busy("agent1"), false);
  assert.equal((await d.resolve("agent1")).kind, "space");
});
test("F6: reconnect twin cleanup collects notices from the stopped host without moving placement", async () => {
  const { d, local } = rig();
  await d.resolve("agent1");
  const notices = [], calls = [];
  local.snapshots = async () => ({ points: [], notices: [], busy: false });
  d.presence.desktopHosts = () => [pc];
  d.remote = {
    list: async () => [{ profile: "agent1", running: true }],
    stop: async (host, profile) => { calls.push([host, profile]); },
    snapshots: async () => ({ points: [], busy: false, notices: [{ id: "11111111-1111-4111-8111-111111111111", time: 1, event: "stopped" }] }),
  };
  d.onSnapshot = (...args) => notices.push(args);
  await d.syncHosts();
  assert.deepEqual(calls, [[pc.id, "agent1"]]);
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].slice(0, 2), ["agent1", pc.id]);
  assert.equal(d.snapshotHost("agent1"), "agent-host");
});
test("F6: delayed notice reads never delay remote start or stop completion", async () => {
  const { d } = rig({ localLimit: 0 });
  d.presence.desktopHosts = () => [pc];
  for (const action of ["start", "stop"]) {
    let release, completed = false;
    const pending = new Promise((r) => { release = r; });
    d.remote = { ensure: async () => ({}), stop: async () => ({}), snapshots: () => pending };
    const task = d[action]("agent1").then(() => { completed = true; });
    await new Promise(setImmediate);
    try { assert.equal(completed, true, action); }
    finally { release({ points: [], notices: [] }); await task; }
  }
});

test("choose: home host when ready and under its limit; auto prefers the agent host, then the roomiest device", () => {
  assert.deepEqual(choose({ home: "a1b2c3d4", hosts: [hostA, pc] }), { host: "a1b2c3d4" });
  assert.deepEqual(choose({ home: "auto", hosts: [hostA, pc] }), { host: "agent-host" });
  assert.deepEqual(choose({ home: "auto", hosts: [{ ...hostA, running: 1 }, pc] }), { host: "a1b2c3d4" });
  assert.deepEqual(choose({ home: "a1b2c3d4", hosts: [hostA, { ...pc, ready: false }] }), { fallback: "offline" });
  assert.deepEqual(choose({ home: "a1b2c3d4", hosts: [hostA] }), { fallback: "offline" });
  assert.deepEqual(choose({ home: "a1b2c3d4", hosts: [{ ...pc, running: 3 }] }), { fallback: "limit" });
  assert.deepEqual(choose({ home: "auto", hosts: [] }), { fallback: "none" });
});

function rig({ localLimit = 1, startMs = 0 } = {}) {
  const c = { t: 1_000_000 };
  const local = {
    started: [], stopped: [], running: new Set(),
    async ensure(p) { this.started.push(p); if (startMs) await new Promise((r) => setTimeout(r, startMs)); this.running.add(p); return { port: 40000 + this.started.length }; },
    async stop(p) { this.stopped.push(p); this.running.delete(p); },
    async list() { return [...this.running].map((p) => ({ profile: p, running: true, port: 40001 })); },
    async docker() { return "ready"; }, async imagePresent() { return true; },
  };
  const d = new Desktops({ local, localLimit, idleMs: 20 * 60_000, presence: { desktopHosts: () => [] }, remote: null, store: memStore(), now: () => c.t, ready: async () => true });
  return { d, local, c };
}

test("resolve starts the agent's desktop on demand and then answers ready", async () => {
  const { d, local } = rig();
  const r = await d.resolve("aurora");
  assert.equal(r.kind, "space");
  assert.equal(r.host, "agent-host");
  assert.deepEqual(local.started, ["aurora"]);
  assert.equal((await d.resolve("aurora")).kind, "space");
  assert.deepEqual(local.started, ["aurora"], "no second start");
});

test("each local start attempt applies the current snapshot retention before ensure", async () => {
  const { d, local } = rig();
  let keep = 12;
  const seen = [];
  local.opts = { snapshotKeep: 10, memory: "2g" };
  d.snapshotSettings = () => ({ snapshotKeep: keep });
  local.ensure = async () => {
    seen.push(local.opts.snapshotKeep);
    if (seen.length === 1) { keep = 7; throw new Error("retry start"); }
    return { port: 40001 };
  };
  assert.equal((await d.resolve("aurora")).kind, "space");
  assert.deepEqual(seen, [12, 7]);
  assert.equal(local.opts.memory, "2g", "unrelated host options survive policy refresh");
});

test("two agents at once on a host with room for one: one desktop, the other falls back (limit)", async () => {
  const { d, local } = rig({ localLimit: 1, startMs: 30 });
  const [a, b] = await Promise.all([d.resolve("aurora"), d.resolve("pioneer")]);
  const kinds = [a.kind, b.kind].sort();
  assert.deepEqual(kinds, ["fallback", "space"]);
  assert.equal([a, b].find((x) => x.kind === "fallback").reason, "limit");
  assert.equal(local.started.length, 1);
});

test("a desktop idle for 20 min with nobody watching stops; a watched one does not", async () => {
  const { d, local, c } = rig({ localLimit: 2 });
  await d.resolve("aurora");
  await d.resolve("pioneer");
  d.watching("pioneer", true);
  c.t += 21 * 60_000;
  await d.sweep();
  assert.deepEqual(local.stopped, ["aurora"]);
  assert.equal(d.state("aurora"), "off");
  assert.equal(d.state("pioneer"), "ready");
});

test("at the limit an idle desktop gives way to a new agent (least recently used first)", async () => {
  const { d, local, c } = rig({ localLimit: 1 });
  await d.resolve("aurora");
  c.t += 5 * 60_000; // idle, but not long enough to be swept
  const r = await d.resolve("pioneer");
  assert.equal(r.kind, "space");
  assert.deepEqual(local.stopped, ["aurora"]);
});

test("a failing start retries twice, then falls back with reason failed", async () => {
  const { d, local } = rig();
  local.ensure = async () => { throw new Error("docker run failed"); };
  assert.equal((await d.resolve("aurora")).reason, "failed");
  assert.equal(d.state("aurora"), "failed");
});

test("an active desktop is never stopped to make room: only one idle for at least 2 min gives way", async () => {
  const { d, local, c } = rig({ localLimit: 1 });
  await d.resolve("aurora");
  c.t += 60_000; // used a minute ago
  assert.equal((await d.resolve("pioneer")).reason, "limit");
  assert.deepEqual(local.stopped, []);
});

test("adopt: after a relay restart the agent host's running desktops count as ready (no second start)", async () => {
  const { d, local } = rig({ localLimit: 2 });
  local.running.add("aurora");
  await d.adopt();
  assert.equal(d.state("aurora"), "ready");
  assert.equal((await d.resolve("aurora")).kind, "space");
  assert.deepEqual(local.started, []);
});

test("home host is stored, validated and survives a restart", () => {
  const store = memStore();
  const d1 = new Desktops({ local: null, localLimit: 0, idleMs: 1, presence: { desktopHosts: () => [pc] }, remote: null, store, now: () => 0 });
  assert.deepEqual(d1.setHome("aurora", "a1b2c3d4"), { ok: true });
  assert.equal(d1.setHome("../x", "auto").ok, false);
  assert.equal(d1.setHome("aurora", "not a host").ok, false);
  const d2 = new Desktops({ local: null, localLimit: 0, idleMs: 1, presence: { desktopHosts: () => [pc] }, remote: null, store, now: () => 0 });
  assert.equal(d2.home("aurora"), "a1b2c3d4");
  assert.equal(d2.home("pioneer"), "auto");
});

// ---- isolation guard (controller ruling): the agent host's own desktops lose their network rules if Docker restarts ----
function netRig(opts) {
  const r = rig(opts);
  const net = { checks: 0, repairs: 0, ok: true, repairWorks: true, repairThrows: false };
  r.local.netCheck = async () => { net.checks += 1; return net.ok; };
  r.local.netRepair = async () => {
    net.repairs += 1;
    if (net.repairThrows) throw new Error("iptables failed");
    if (net.repairWorks) net.ok = true;
  };
  return { ...r, net };
}

test("isolation: netCheck false, repair works -> desktops keep running", async () => {
  const { d, local, c, net } = netRig({ localLimit: 2 });
  await d.resolve("aurora");
  net.ok = false;
  c.t += 61_000;
  await d.sweep();
  assert.equal(net.checks, 2, "check, repair, re-check");
  assert.equal(net.repairs, 1);
  assert.equal(d.state("aurora"), "ready");
  assert.deepEqual(local.stopped, []);
  assert.equal(d.hosts().find((h) => h.id === "agent-host").ready, true);
});

test("isolation: repair fails -> all agent-host desktops stop, host not ready, new resolve falls back, a later good repair recovers", async () => {
  const { d, local, c, net } = netRig({ localLimit: 2 });
  await d.resolve("aurora");
  await d.resolve("pioneer");
  net.ok = false;
  net.repairThrows = true;
  c.t += 61_000;
  await d.sweep();
  assert.deepEqual(local.stopped.sort(), ["aurora", "pioneer"]);
  assert.equal(d.state("aurora"), "off");
  assert.equal(d.state("pioneer"), "off");
  assert.equal(d.hosts().find((h) => h.id === "agent-host").ready, false);
  const startedBefore = local.started.length;
  assert.deepEqual(await d.resolve("aurora"), { kind: "fallback", reason: "none" });
  assert.equal(local.started.length, startedBefore, "nothing starts while isolation is failed");
  // repair still failing: stays failed
  await d.sweep();
  assert.equal(d.hosts().find((h) => h.id === "agent-host").ready, false);
  // repair works again
  net.repairThrows = false;
  await d.sweep();
  assert.equal(d.hosts().find((h) => h.id === "agent-host").ready, true);
  assert.equal((await d.resolve("aurora")).kind, "space");
});

test("isolation: repair 'succeeds' but the re-check is still false -> counts as failed", async () => {
  const { d, local, c, net } = netRig();
  await d.resolve("aurora");
  net.ok = false;
  net.repairWorks = false;
  c.t += 61_000;
  await d.sweep();
  assert.deepEqual(local.stopped, ["aurora"]);
  assert.equal(d.hosts().find((h) => h.id === "agent-host").ready, false);
  assert.equal((await d.resolve("aurora")).reason, "none");
});

test("isolation: with a home pinned to the agent host a failed isolation reads as offline", async () => {
  const { d, c, net } = netRig();
  d.setHome("aurora", "agent-host");
  await d.resolve("aurora");
  net.ok = false; net.repairThrows = true;
  c.t += 61_000;
  await d.sweep();
  assert.equal((await d.resolve("aurora")).reason, "offline");
});

test("isolation: netCheck runs at most once per 60 s", async () => {
  const { d, c, net } = netRig({ localLimit: 2 });
  await d.resolve("aurora");
  await d.sweep();
  assert.equal(net.checks, 1, "first sweep checks");
  c.t += 30_000;
  await d.sweep();
  c.t += 29_000;
  await d.sweep();
  assert.equal(net.checks, 1, "still inside the 60 s window");
  c.t += 2_000;
  await d.sweep();
  assert.equal(net.checks, 2, "window elapsed");
});

test("isolation: no running desktops -> no netCheck", async () => {
  const { d, c, net } = netRig();
  await d.sweep();
  c.t += 120_000;
  await d.sweep();
  assert.equal(net.checks, 0);
  await d.resolve("aurora");
  await d.stop("aurora");
  c.t += 120_000;
  await d.sweep();
  assert.equal(net.checks, 0, "an off desktop does not count");
});

test("isolation: a desktop still starting when isolation fails is not left running", async () => {
  const { d, local, c, net } = netRig({ localLimit: 2, startMs: 40 });
  await d.resolve("aurora"); // ready, so a check is due
  const pending = d.resolve("pioneer"); // starting
  net.ok = false; net.repairThrows = true;
  c.t += 61_000;
  await d.sweep();
  const r = await pending;
  assert.equal(r.kind, "fallback");
  assert.equal(d.state("pioneer"), "off");
  assert.ok(local.stopped.includes("pioneer"));
  assert.equal(local.running.has("pioneer"), false);
});

// ---- fix round 1 (task review) ----
const tick = () => new Promise((r) => setImmediate(r));
const gate = () => { let open; const p = new Promise((r) => (open = r)); return { p, open }; };

test("fix1: a start stopped while starting never restarts the desktop: no further ensure, state stays off, container stopped", async () => {
  const { d, local } = rig({ localLimit: 2 });
  const g = gate();
  d.ready = async () => { await g.p; throw new Error("unhealthy"); };
  const p = d.resolve("aurora");
  await tick();
  await d.stop("aurora"); // isolation guard / sweep / victim
  assert.equal(d.state("aurora"), "off");
  g.open();
  const r = await p;
  assert.deepEqual(r, { kind: "fallback", reason: "offline" });
  assert.equal(local.started.length, 1, "no restart after the stop");
  assert.equal(d.state("aurora"), "off", "off is not overwritten by failed");
  assert.equal(local.running.has("aurora"), false);
});

test("fix1: a start that exhausts its retries cleans up the half-started container", async () => {
  const { d, local } = rig();
  d.ready = async () => { throw new Error("unhealthy"); };
  assert.equal((await d.resolve("aurora")).reason, "failed");
  assert.equal(local.started.length, 3);
  assert.equal(d.state("aurora"), "failed");
  assert.equal(local.running.has("aurora"), false, "container stopped");
});

test("fix2: two concurrent resolves of one new profile at the limit (victim path) start it once and agree", async () => {
  const { d, local, c } = rig({ localLimit: 1 });
  await d.resolve("aurora");
  c.t += 5 * 60_000;
  const [a, b] = await Promise.all([d.resolve("pioneer"), d.resolve("pioneer")]);
  assert.equal(a.kind, "space");
  assert.deepEqual(a, b);
  assert.deepEqual(local.started, ["aurora", "pioneer"], "one ensure for pioneer");
});

test("fix3: a resolve during a stop never gets the dying desktop; it waits and starts afresh", async () => {
  const { d, local } = rig({ localLimit: 2 });
  const log = [];
  const ens = local.ensure.bind(local);
  local.ensure = async (p) => { log.push("ensure"); return ens(p); };
  local.stop = async function (p) { log.push("stop-begin"); await new Promise((r) => setTimeout(r, 20)); this.running.delete(p); log.push("stop-end"); };
  await d.resolve("aurora");
  const stopping = d.stop("aurora");
  assert.equal(d.hosts().find((h) => h.id === "agent-host").running, 1, "a stopping desktop still occupies its slot");
  const r = await d.resolve("aurora");
  await stopping;
  assert.equal(r.kind, "space");
  assert.deepEqual(log, ["ensure", "stop-begin", "stop-end", "ensure"]);
});

test("fix3: a failing stop keeps the slot counted and the next sweep retries it", async () => {
  const { d, local } = rig({ localLimit: 1 });
  await d.resolve("aurora");
  let broken = true;
  local.stop = async function (p) { if (broken) throw new Error("docker stop failed"); this.running.delete(p); this.stopped.push(p); };
  await d.stop("aurora");
  assert.equal(d.state("aurora"), "failed");
  assert.equal(d.hosts().find((h) => h.id === "agent-host").running, 1, "may still be running: stays counted");
  assert.equal((await d.resolve("pioneer")).reason, "limit");
  assert.equal((await d.resolve("aurora")).reason, "failed", "not handed out while its stop is unresolved");
  broken = false;
  await d.sweep();
  assert.equal(d.state("aurora"), "off");
  assert.equal(d.hosts().find((h) => h.id === "agent-host").running, 0);
  assert.deepEqual(local.stopped, ["aurora"]);
});

test("fix4: a stale start of a replaced entry does not stop the new desktop of the same profile", async () => {
  const { d, local } = rig({ localLimit: 2 });
  const g1 = gate();
  let n = 0;
  local.ensure = async function (p) { n += 1; if (n === 1) await g1.p; this.running.add(p); return { port: 40000 + n }; };
  const old = d.resolve("aurora");
  await tick();
  await d.stop("aurora"); // old start still in flight
  const fresh = await d.resolve("aurora");
  assert.equal(fresh.kind, "space");
  g1.open();
  assert.deepEqual(await old, { kind: "fallback", reason: "offline" });
  assert.equal(d.state("aurora"), "ready");
  assert.equal(local.running.has("aurora"), true, "the new desktop still runs");
  assert.deepEqual(local.stopped, ["aurora"], "only the explicit stop; the stale start stopped nothing");
});

test("fix5: a ready desktop on a remote host that went offline is no longer a space", async () => {
  const c = { t: 1_000_000 };
  let hostsNow = [pc];
  const calls = { ensure: [], stop: [] };
  const remote = { async ensure(dev, p) { calls.ensure.push([dev, p]); return { port: null }; }, async stop(dev, p) { calls.stop.push([dev, p]); }, async list() { return []; } };
  const d = new Desktops({ local: null, localLimit: 0, idleMs: 20 * 60_000, presence: { desktopHosts: () => hostsNow }, remote, store: memStore(), now: () => c.t });
  d.setHome("aurora", "a1b2c3d4");
  assert.equal((await d.resolve("aurora")).kind, "space");
  hostsNow = [{ ...pc, ready: false }];
  assert.deepEqual(await d.resolve("aurora"), { kind: "fallback", reason: "offline" });
  assert.equal(d.state("aurora"), "off");
  assert.deepEqual(calls.stop, [], "no stop sent to an unreachable host");
});

// ---- Task 8 carried items: per-host idle, Deck hosts' running desktops adopted, not-running marks off ----------

/** A Deck host rig: presence hosts are mutable, the remote records ensure/stop/list. */
function deckRig({ hosts = [{ ...pc }], running = [] } = {}) {
  const c = { t: 1_000_000 };
  const st = { hosts, running };
  const calls = { ensure: [], stop: [], list: [] };
  const remote = {
    async ensure(dev, p) { calls.ensure.push([dev, p]); return { port: null }; },
    async stop(dev, p) { calls.stop.push([dev, p]); },
    async list(dev) { calls.list.push(dev); return st.running.map((p) => ({ profile: p, running: true })); },
  };
  const d = new Desktops({ local: null, localLimit: 0, idleMs: 20 * 60_000, presence: { desktopHosts: () => st.hosts }, remote, store: memStore(), now: () => c.t });
  return { d, c, st, calls };
}

test("idle per host: a Deck host's own idleMin decides its desktops' idle stop; the agent host keeps idleMs", async () => {
  const { d, c, calls } = deckRig({ hosts: [{ ...pc, idleMin: 5 }] });
  d.setHome("aurora", "a1b2c3d4");
  await d.resolve("aurora");
  c.t += 6 * 60_000;
  await d.sweep();
  assert.deepEqual(calls.stop, [["a1b2c3d4", "aurora"]], "stopped after the host's 5 min, not the relay's 20");
  const { d: d2, local, c: c2 } = rig();
  await d2.resolve("aurora");
  c2.t += 6 * 60_000;
  await d2.sweep();
  assert.deepEqual(local.stopped, [], "the agent host waits its own 20 min");
  // a Deck host without idleMin falls back to idleMs
  const r = deckRig();
  r.d.setHome("aurora", "a1b2c3d4");
  await r.d.resolve("aurora");
  r.c.t += 6 * 60_000;
  await r.d.sweep();
  assert.deepEqual(r.calls.stop, []);
  r.c.t += 15 * 60_000;
  await r.d.sweep();
  assert.deepEqual(r.calls.stop, [["a1b2c3d4", "aurora"]]);
});

test("syncHosts: a Deck host that appears is listed and its running desktops adopted (last = now) so the idle sweep reaches them", async () => {
  const { d, c, st, calls } = deckRig({ hosts: [], running: ["aurora"] });
  await d.syncHosts();
  assert.deepEqual(calls.list, [], "no host yet");
  st.hosts = [{ ...pc, running: 1 }];
  await d.syncHosts();
  assert.deepEqual(calls.list, ["a1b2c3d4"]);
  assert.equal(d.state("aurora"), "ready");
  assert.deepEqual(d.list().map((x) => [x.profile, x.host]), [["aurora", "a1b2c3d4"]]);
  await d.syncHosts();
  assert.deepEqual(calls.list, ["a1b2c3d4"], "same host, same count: not listed again");
  c.t += 21 * 60_000;
  await d.sweep();
  assert.deepEqual(calls.stop, [["a1b2c3d4", "aurora"]], "the adopted desktop stops when idle");
});

test("syncHosts: a heartbeat count that differs from the tracked one lists again; a host that went away and came back is listed again", async () => {
  const { d, c, st, calls } = deckRig({ hosts: [{ ...pc, running: 0 }], running: [] });
  await d.syncHosts();
  assert.deepEqual(calls.list, ["a1b2c3d4"], "a new host is always listed once");
  st.running = ["pioneer"];
  st.hosts = [{ ...pc, running: 1 }]; // a desktop the relay does not know of (left over from before a relay restart)
  c.t += 11_000;
  await d.syncHosts();
  assert.deepEqual(calls.list, ["a1b2c3d4", "a1b2c3d4"]);
  assert.equal(d.state("pioneer"), "ready");
  // the host drops out (locked or asleep): the entry is kept, and its return lists again
  st.hosts = [];
  await d.syncHosts();
  assert.equal(await d.resolve("pioneer").then((r) => r.kind), "fallback");
  assert.equal(d.state("pioneer"), "off");
  st.hosts = [{ ...pc, running: 1 }];
  await d.syncHosts(); // back: listed at once, no throttle
  assert.deepEqual(calls.list, ["a1b2c3d4", "a1b2c3d4", "a1b2c3d4"]);
  assert.equal(d.state("pioneer"), "ready", "picked up again: tracked, so the idle sweep will stop it");
});

test("syncHosts: a ready desktop the Deck no longer runs is marked off; a starting one is left alone", async () => {
  const { d, c, st, calls } = deckRig({ hosts: [{ ...pc, running: 1 }], running: ["aurora"] });
  await d.syncHosts();
  assert.equal(d.state("aurora"), "ready");
  st.running = [];
  st.hosts = [{ ...pc, running: 0 }]; // the Deck stopped it (hosting off, Docker restart)
  c.t += 11_000;
  await d.syncHosts();
  assert.deepEqual(calls.list, ["a1b2c3d4", "a1b2c3d4"]);
  assert.equal(d.state("aurora"), "off");
  // a desktop starting on that host is not touched by a listing that does not show it yet
  d.setHome("pioneer", "a1b2c3d4");
  const starting = d.resolve("pioneer");
  st.hosts = [{ ...pc, running: 0 }];
  c.t += 11_000;
  await d.syncHosts();
  assert.notEqual(d.state("pioneer"), "off");
  assert.equal((await starting).kind, "space");
});

test("markOff and portOf: a dead ready desktop goes off (the next resolve starts it again); ports only for the agent host's own", async () => {
  const { d, local } = rig();
  await d.resolve("aurora");
  assert.equal(d.portOf("aurora"), 40001);
  assert.equal(d.markOff("aurora"), true);
  assert.equal(d.state("aurora"), "off");
  assert.equal(d.portOf("aurora"), null);
  assert.equal((await d.resolve("aurora")).kind, "space");
  assert.deepEqual(local.started, ["aurora", "aurora"], "started again");
  const r = deckRig();
  r.d.setHome("aurora", "a1b2c3d4");
  await r.d.resolve("aurora");
  assert.equal(r.d.portOf("aurora"), null, "a Deck host's port is never known here");
});

test("fallbackOf: the last reason a resolve fell back, cleared once the agent has its desktop", async () => {
  const { d, st } = deckRig({ hosts: [{ ...pc, running: 3 }] });
  d.setHome("aurora", "a1b2c3d4");
  assert.deepEqual(await d.resolve("aurora"), { kind: "fallback", reason: "limit" });
  assert.equal(d.fallbackOf("aurora"), "limit");
  st.hosts = [{ ...pc, running: 0 }];
  assert.equal((await d.resolve("aurora")).kind, "space");
  assert.equal(d.fallbackOf("aurora"), null);
});

// ---- Task 8 fix round 1 ----------------------------------------------------------------------------------------

test("fix1-2: a desktop watched by an open view keeps that across a replaced entry (markOff + restart, adopt), so the sweep never idle-stops it", async () => {
  const { d, local, c } = rig();
  await d.resolve("aurora");
  d.watching("aurora", true); // a view socket is open
  d.markOff("aurora");
  await d.resolve("aurora"); // a new entry for the restarted desktop
  c.t += 21 * 60_000;
  await d.sweep();
  assert.deepEqual(local.stopped, [], "restarted entry: still watched");
  const r = deckRig({ hosts: [{ ...pc, running: 1 }], running: ["pioneer"] });
  r.d.watching("pioneer", true); // the viewer opened before the relay knew of the desktop
  await r.d.syncHosts();
  r.c.t += 21 * 60_000;
  await r.d.sweep();
  assert.deepEqual(r.calls.stop, [], "adopted entry: still watched");
  r.d.watching("pioneer", false); // 11b: the idle time counts from when the last viewer left
  await r.d.sweep();
  assert.deepEqual(r.calls.stop, [], "not idle yet: the view just ended");
  r.c.t += 21 * 60_000;
  await r.d.sweep();
  assert.deepEqual(r.calls.stop, [["a1b2c3d4", "pioneer"]]);
});

test("fix1-6: a profile named host never gets a desktop of its own (resolve falls back, nothing starts)", async () => {
  const { d, local } = rig();
  assert.deepEqual(await d.resolve("host"), { kind: "fallback", reason: "none" });
  assert.deepEqual(local.started, []);
  assert.equal(d.setHome("host", "agent-host").ok, false);
});

// ---- Task 11b: idle = no agent action, no viewer and no user control (spec 5) ---------------------------------
const { Spaces } = require("../src/spaces");
const { SpaceLock } = require("../src/space-lock");

test("11b idle clock: the last viewer leaving restarts the idle time; a desktop that was not watched keeps its clock", async () => {
  const { d, local, c } = rig({ localLimit: 2 });
  await d.resolve("aurora");
  await d.resolve("pioneer");
  d.watching("aurora", true);
  c.t += 30 * 60_000; // watched for 30 min, far past the 20 min idle time
  d.watching("aurora", false);
  d.watching("pioneer", false); // never watched: no reset
  await d.sweep();
  assert.deepEqual(local.stopped, ["pioneer"], "the one nobody watched stops; the one just left alone does not");
  c.t += 19 * 60_000;
  await d.sweep();
  assert.deepEqual(local.stopped, ["pioneer"]);
  c.t += 2 * 60_000;
  await d.sweep();
  assert.deepEqual(local.stopped, ["pioneer", "aurora"], "20 min after the view ended");
});

test("11b idle clock: user control ending restarts the idle time (through Spaces' control levels)", async () => {
  const { d, local, c } = rig();
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops: d, profiles: () => ["aurora"], now: () => c.t });
  await d.resolve("aurora");
  c.t += 5 * 60_000;
  assert.equal((await s._control({ space: "aurora", level: "full" })).ok, true);
  c.t += 30 * 60_000; // the user held it for 30 min (no agent action meanwhile)
  await d.sweep();
  assert.deepEqual(local.stopped, [], "under user control: never idle");
  assert.equal((await s._control({ space: "aurora", level: "release" })).ok, true);
  await d.sweep();
  assert.deepEqual(local.stopped, [], "control just ended: not idle yet");
  c.t += 19 * 60_000;
  await d.sweep();
  assert.deepEqual(local.stopped, []);
  c.t += 2 * 60_000;
  await d.sweep();
  assert.deepEqual(local.stopped, ["aurora"], "20 min after control ended");
});

// ---- Task 11b: a Deck host that left does not keep its desktops "ready" -----------------------------------------

test("11b: a Deck host absent from presence longer than the heartbeat staleness: its ready desktops go off (fallback offline), no stop sent", async () => {
  const { d, c, st, calls } = deckRig({ running: ["aurora"] });
  d.setHome("aurora", "a1b2c3d4");
  assert.equal((await d.resolve("aurora")).kind, "space");
  await d.syncHosts(); // the host is known (listed once)
  st.hosts = []; // the Deck quit, or its heartbeat says locked/asleep
  await d.syncHosts();
  c.t += 29_000;
  await d.syncHosts();
  assert.equal(d.state("aurora"), "ready", "not yet: a heartbeat may just be late");
  c.t += 2_000;
  await d.syncHosts();
  assert.equal(d.state("aurora"), "off");
  assert.equal(d.fallbackOf("aurora"), "offline");
  assert.deepEqual(d.list().map((r) => [r.profile, r.state]), [["aurora", "off"]]);
  assert.deepEqual(calls.stop, [], "the host is not reachable: no stop is sent");
  // it comes back with the desktop still running: listed afresh and adopted as ready
  st.hosts = [{ ...pc, running: 1 }];
  st.running = ["aurora"];
  await d.syncHosts();
  assert.equal(d.state("aurora"), "ready");
  assert.equal(d.fallbackOf("aurora"), null, "running on its own desktop again");
});

test("11b: a Deck host absent for less than the staleness keeps its desktops; a later absence starts a new clock", async () => {
  const { d, c, st } = deckRig({ running: ["aurora"] });
  d.setHome("aurora", "a1b2c3d4");
  await d.resolve("aurora");
  st.hosts = [];
  await d.syncHosts();
  c.t += 20_000;
  await d.syncHosts();
  st.hosts = [{ ...pc, running: 1 }];
  st.running = ["aurora"];
  await d.syncHosts(); // back in time
  assert.equal(d.state("aurora"), "ready");
  st.hosts = [];
  c.t += 1_000;
  await d.syncHosts();
  c.t += 20_000;
  await d.syncHosts();
  assert.equal(d.state("aurora"), "ready", "20 s into the second absence, not 41 s since the first");
  c.t += 11_000;
  await d.syncHosts();
  assert.equal(d.state("aurora"), "off");
});

// ---- final fix wave I1: a wedged Docker never hangs a waiter (the real runner with tiny bounds, a fake `docker`) ----

/**
 * The real dockerRunner over a fake `docker` whose processes ignore kill() and never close, except the argv that
 * answer(argv) answers ({code, stdout}). Bounds are tiny: each call that hangs is cut after 20 ms.
 */
function wedgedRunner(answer = () => null) {
  const { EventEmitter } = require("node:events");
  const { dockerRunner } = require("../../app/main/desktop-host");
  const spawnFn = (bin, argv) => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => {}; // ignored: never closes
    const a = answer(argv);
    if (a) setImmediate(() => { if (a.stdout) p.stdout.emit("data", a.stdout); p.emit("close", a.code); });
    return p;
  };
  return dockerRunner({ spawnFn, shortMs: 20, longMs: 20, helperMs: 20 });
}

function wedgedHost(answer) {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { DesktopHost } = require("../../app/main/desktop-host");
  const pin = require("../../app/main/desktops-pin.json");
  return new DesktopHost({ run: wedgedRunner(answer), pin, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "i1-")) });
}

test("I1 resolve on the agent host: a helper that never exits makes the start fail within the bound, and the agent falls back", { timeout: 3000 }, async () => {
  // Docker answers inspect and network inspect; every helper run (and the final stop) hangs
  const local = wedgedHost((a) => {
    if (a[0] === "container" && a[1] === "inspect") return { code: 1 };
    if (a[0] === "network" && a[1] === "inspect") return { code: 0, stdout: "172.30.0.0/16\n" };
    return null;
  });
  const d = new Desktops({ local, localLimit: 1, presence: { desktopHosts: () => [] }, store: memStore(), ready: async () => true });
  const t0 = Date.now();
  const r = await d.resolve("aurora");
  assert.deepEqual(r, { kind: "fallback", reason: "failed" });
  assert.ok(Date.now() - t0 < 2000, `settled in ${Date.now() - t0} ms`);
  assert.equal(d.flight.size, 0, "no resolve left in flight");
});

test("I1 sweep: a docker stop that never exits does not hold the sweep; the desktop keeps its slot (stop failed)", { timeout: 3000 }, async () => {
  const c = { t: 1_000_000 };
  const local = wedgedHost((a) => (a[0] === "ps" ? { code: 0, stdout: "hermes-deck-space-aurora\tUp 3 minutes\t127.0.0.1:41234->3211/tcp\n" } : null));
  const d = new Desktops({ local, localLimit: 1, idleMs: 60_000, presence: { desktopHosts: () => [] }, store: memStore(), now: () => c.t, ready: async () => true });
  await d.adopt();
  assert.equal(d.state("aurora"), "ready");
  c.t += 2 * 60_000;
  const t0 = Date.now();
  await d.sweep();
  assert.ok(Date.now() - t0 < 2000, `sweep settled in ${Date.now() - t0} ms`);
  assert.equal(d.state("aurora"), "failed");
  assert.equal(d.hosts()[0].running, 1, "a desktop that may still run keeps its slot");
});

// ---- final fix wave: I3 allow list, T1 sticky stopFailed, T2 bail during stop, M2 Deck limit, M4 ".." ----------

test("I3 allow list: an agent not on DECK_DESKTOPS_AGENTS gets no desktop (fallback none), nothing starts; listed agents do", async () => {
  const c = { t: 1_000_000 };
  const local = { started: [], async ensure(p) { this.started.push(p); return { port: 40001 }; }, async stop() {}, async list() { return []; } };
  const d = new Desktops({ local, localLimit: 2, presence: { desktopHosts: () => [] }, store: memStore(), now: () => c.t, allowed: ["aurora"] });
  assert.deepEqual(await d.resolve("pioneer"), { kind: "fallback", reason: "none" });
  assert.deepEqual(await d.start("pioneer"), { kind: "fallback", reason: "none" });
  assert.deepEqual(local.started, [], "nothing started for an agent off the list");
  assert.equal(d.fallbackOf("pioneer"), "none");
  assert.equal(d.allowed("pioneer"), false);
  assert.equal((await d.resolve("aurora")).kind, "space");
  assert.deepEqual(local.started, ["aurora"]);
  // unset (null) = every configured agent
  const all = new Desktops({ local, localLimit: 2, presence: { desktopHosts: () => [] }, store: memStore(), now: () => c.t });
  assert.equal(all.allowed("pioneer"), true);
});

test("I3 allow list: a Deck host is never asked to start a desktop for an agent off the list (no CTRL ensure)", async () => {
  const calls = [];
  const remote = { async ensure(dev, p) { calls.push(["ensure", dev, p]); return { port: null }; }, async stop() {}, async list() { return []; } };
  const d = new Desktops({ local: null, localLimit: 0, presence: { desktopHosts: () => [{ ...pc }] }, remote, store: memStore(), allowed: ["aurora"] });
  d.setHome("pioneer", "a1b2c3d4");
  assert.deepEqual(await d.resolve("pioneer"), { kind: "fallback", reason: "none" });
  assert.deepEqual(calls, []);
});

test("T1: a start whose final stop fails after a concurrent stop succeeded does not leave a sticky stopFailed (the next resolve starts it)", async () => {
  let gate;
  const held = new Promise((r) => (gate = r));
  const local = {
    ensures: 0, stops: 0,
    async ensure() { this.ensures += 1; if (this.ensures <= 3) throw new Error("docker run failed"); return { port: 40001 }; },
    async stop() { this.stops += 1; if (this.stops === 1) { await held; throw new Error("docker stop failed"); } },
    async list() { return []; },
  };
  const d = new Desktops({ local, localLimit: 1, presence: { desktopHosts: () => [] }, store: memStore(), ready: async () => true });
  const first = d.resolve("aurora");
  while (local.stops < 1) await new Promise((r) => setImmediate(r)); // the final cleanup stop is in flight
  await d.stop("aurora"); // the user's Stop lands meanwhile and succeeds
  assert.equal(d.state("aurora"), "off");
  gate();
  assert.deepEqual(await first, { kind: "fallback", reason: "offline" });
  assert.equal(d.hosts()[0].running, 0, "no slot held");
  assert.equal((await d.resolve("aurora")).kind, "space", "not stuck on failed");
});

test("T2: a start orphaned by stop() does not send a second stop (stop() owns it)", async () => {
  let release;
  const slow = new Promise((r) => (release = r));
  const local = {
    stops: [],
    async ensure() { await slow; return { port: 40001 }; },
    async stop(p) { this.stops.push(p); await new Promise((r) => setTimeout(r, 30)); },
    async list() { return []; },
  };
  const d = new Desktops({ local, localLimit: 1, presence: { desktopHosts: () => [] }, store: memStore(), ready: async () => true });
  const r = d.resolve("aurora");
  await new Promise((x) => setImmediate(x));
  const stopping = d.stop("aurora"); // state -> stopping while ensure is still running
  release();
  assert.deepEqual(await r, { kind: "fallback", reason: "offline" });
  await stopping;
  assert.deepEqual(local.stops, ["aurora"], "one docker stop, not two");
  assert.equal(d.state("aurora"), "off");
});

test("M2: the Deck's own limit refusal falls back as limit at once (no retries, no stop), not failed", async () => {
  const calls = { ensure: 0, stop: 0 };
  const remote = {
    async ensure() { calls.ensure += 1; throw Object.assign(new Error("this computer is at its desktop limit"), { code: "LIMIT" }); },
    async stop() { calls.stop += 1; },
    async list() { return []; },
  };
  const d = new Desktops({ local: null, localLimit: 0, presence: { desktopHosts: () => [{ ...pc }] }, remote, store: memStore(), ready: async () => true });
  assert.deepEqual(await d.resolve("aurora"), { kind: "fallback", reason: "limit" });
  assert.deepEqual(calls, { ensure: 1, stop: 0 });
  assert.equal(d.state("aurora"), "off");
  assert.equal(d.fallbackOf("aurora"), "limit");
  assert.equal(d.hosts()[0].running, 0);
});

test("M4: a profile with '..' is refused like any bad profile (fallback none, nothing started)", async () => {
  const { d, local } = rig();
  assert.deepEqual(await d.resolve("a..b"), { kind: "fallback", reason: "none" });
  assert.deepEqual(local.started, []);
  assert.deepEqual(d.setHome("a..b", "agent-host"), { ok: false, error: "bad profile" });
});

test("snapshot placement survives restart and restore blocks resolve", async () => {
  let saved = {}, finish;
  const store = { load: () => saved, save: (v) => { saved = structuredClone(v); } };
  const local = { ensure: async () => ({ port: 1 }), opts: {}, list: async () => [],
    snapshots: async () => ({ points: [], totalBytes: 0, busy: false, recovery: false }),
    restore: () => new Promise((r) => { finish = r; }) };
  const opts = { local, localLimit: 1, presence: { desktopHosts: () => [] }, store };
  const d = new Desktops(opts);
  await d.resolve("agent1");
  const fresh = new Desktops(opts);
  assert.equal(fresh.snapshotHost("agent1"), "agent-host");
  const pending = fresh.restore("agent1", "11111111-1111-4111-8111-111111111111");
  assert.equal(fresh.busy("agent1"), true);
  assert.equal((await fresh.resolve("agent1")).kind, "fallback");
  await new Promise(setImmediate);
  finish({ ok: true }); await pending;
  assert.equal(fresh.state("agent1"), "off");
  assert.equal(fresh.busy("agent1"), false);
});

test("snapshot APIs route to durable placement without ensure and retain a failed restore barrier until reconciliation", async () => {
  let saved = {}, restoring, calls = [];
  const store = { load: () => saved, save: (v) => { saved = structuredClone(v); } };
  const remote = {
    ensure: async () => { throw new Error("must not ensure"); },
    list: async () => [{ profile: "agent1", running: true }],
    stop: async (...args) => { calls.push(["stop", ...args]); },
    snapshot: async (...args) => { calls.push(["snapshot", ...args]); return { ok: true }; },
    dropSnapshot: async (...args) => { calls.push(["dropSnapshot", ...args]); return { ok: true }; },
    snapshots: async () => ({ points: [], totalBytes: 0, busy: false, recovery: true }),
    restore: () => new Promise((_, reject) => { restoring = reject; }),
  };
  const opts = { presence: { desktopHosts: () => [] }, remote, store };
  const first = new Desktops(opts);
  await first._listHost("a1b2c3d4");
  first.snapshotSettings = () => ({ snapshotKeep: 3 });
  await first.stop("agent1");
  assert.deepEqual(calls.pop(), ["stop", "a1b2c3d4", "agent1", { keep: 3 }]);
  first.setHome("agent1", "agent-host");
  const d = new Desktops(opts);
  d.snapshotSettings = () => ({ snapshotKeep: 7 });
  assert.equal(d.snapshotHost("agent1"), "a1b2c3d4");
  await d.snapshot("agent1", "before-risky-command");
  assert.deepEqual(calls.pop(), ["snapshot", "a1b2c3d4", "agent1", { reason: "before-risky-command", keep: 7 }]);
  await d.dropSnapshot("agent1");
  assert.deepEqual(calls.pop(), ["dropSnapshot", "a1b2c3d4", "agent1", { id: null, keep: 7 }]);
  const pending = d.restore("agent1", "11111111-1111-4111-8111-111111111111");
  await assert.rejects(d.restore("agent1", "11111111-1111-4111-8111-111111111111"), /operation in progress/);
  await assert.rejects(d.dropSnapshot("agent1"), /operation in progress/);
  await new Promise(setImmediate);
  restoring(new Error("gone"));
  await assert.rejects(pending, /desktop stays off and undo points are kept/);
  assert.equal(d.busy("agent1"), true);
  assert.equal((await d.resolve("agent1")).kind, "fallback");
  assert.equal((await d.snapshots("agent1")).host, "a1b2c3d4");
  assert.equal(d.busy("agent1"), true);
  remote.snapshots = async () => ({ points: [], totalBytes: 0, busy: false, recovery: false });
  await d.snapshots("agent1");
  assert.equal(d.busy("agent1"), false);
  await assert.rejects(d.snapshots("../x"), /bad profile/);
  assert.deepEqual(await d.snapshots("unplaced"), { points: [], totalBytes: 0, busy: false, recovery: false, host: null });
});

test("resolve waiting for a stop respects a restore barrier before restarting", async () => {
  const { d, local } = rig();
  await d.resolve("aurora");
  let stopped, restored;
  local.stop = () => new Promise((resolve) => { stopped = resolve; });
  local.restore = () => new Promise((resolve) => { restored = resolve; });
  const stop = d.stop("aurora");
  const resolving = d.resolve("aurora");
  const restore = d.restore("aurora", "11111111-1111-4111-8111-111111111111");
  await new Promise(setImmediate);
  stopped();
  await stop;
  const result = await resolving;
  restored({ ok: true });
  await restore;
  assert.deepEqual(result, { kind: "fallback", reason: "failed" });
  assert.deepEqual(local.started, ["aurora"]);
});

for (const completed of [false, true]) {
  test(`restore barrier: capacity wait cannot start after an overlapping restore (completed=${completed})`, async () => {
    const { d, local, c } = rig();
    await d.resolve("pioneer");
    await d.stop("pioneer");
    await d.resolve("aurora");
    c.t += 5 * 60_000;
    const stopped = gate(), restored = gate();
    const stop = local.stop.bind(local);
    local.stop = async (p) => { await stopped.p; return stop(p); };
    local.restore = () => restored.p;
    const resolving = d.resolve("pioneer");
    await tick();
    const restore = d.restore("pioneer", "11111111-1111-4111-8111-111111111111");
    if (completed) { restored.open({ ok: true }); await restore; }
    stopped.open();
    const result = await resolving;
    restored.open({ ok: true });
    await restore;
    assert.deepEqual(result, { kind: "fallback", reason: "failed" });
    assert.deepEqual(local.started, ["pioneer", "aurora"], "no ensure after the capacity wait");
    assert.equal(d.state("pioneer"), "off");
  });
}

test("restore barrier: a completed restore invalidates a resolve waiting for its own stop", async () => {
  const { d, local } = rig();
  await d.resolve("aurora");
  const paused = gate();
  local.stop = () => paused.p;
  local.restore = async () => ({ ok: true });
  const stopping = d.stop("aurora");
  const resolving = d.resolve("aurora");
  await d.restore("aurora", "11111111-1111-4111-8111-111111111111");
  paused.open();
  await stopping;
  assert.deepEqual(await resolving, { kind: "fallback", reason: "failed" });
  assert.deepEqual(local.started, ["aurora"]);
});

for (const boundary of ["ensure", "ready", "cleanup"]) {
  for (const rejects of [false, true]) {
    for (const completed of [false, true]) {
      test(`restore barrier: ${boundary} await cannot publish or retry (rejects=${rejects}, completed=${completed})`, async () => {
        const { d, local } = rig();
        await d.resolve("aurora");
        await d.stop("aurora");
        const paused = gate(), restored = gate();
        const ensure = local.ensure.bind(local), stop = local.stop.bind(local);
        let healthChecks = 0;
        const wait = async () => { await paused.p; if (rejects) throw new Error("failed while restoring"); };
        local.ensure = async (p) => {
          const r = await ensure(p);
          if (boundary === "ensure") await wait();
          return r;
        };
        d.ready = async () => {
          healthChecks += 1;
          if (boundary === "cleanup") throw new Error("unhealthy");
          if (boundary === "ready") await wait();
        };
        local.stop = async (p) => { if (boundary === "cleanup") await wait(); return stop(p); };
        local.restore = () => restored.p;
        const resolving = d.resolve("aurora");
        await tick();
        const restore = d.restore("aurora", "11111111-1111-4111-8111-111111111111");
        if (completed) { restored.open({ ok: true }); await restore; }
        paused.open();
        const result = await resolving;
        const state = d.state("aurora");
        restored.open({ ok: true });
        await restore;
        assert.deepEqual(result, { kind: "fallback", reason: "failed" });
        assert.notEqual(state, "ready", "the stale resolution never publishes readiness");
        assert.equal(d.state("aurora"), "off");
        assert.equal(local.started.length, boundary === "cleanup" ? 4 : 2, "no ensure retry after restore began");
        assert.equal(healthChecks, boundary === "ensure" ? 0 : boundary === "ready" ? 1 : 3);
        assert.equal(local.stopped.length, boundary === "cleanup" && !rejects ? 2 : 1, "restore owns cleanup after the barrier");
      });
    }
  }
}

for (const completed of [false, true]) {
  for (const stopFails of [false, true]) {
    test(`restore barrier: stale start on another host is cleaned up (completed=${completed}, stopFails=${stopFails})`, async () => {
      const { d, local } = rig();
      await d.resolve("aurora");
      await d.stop("aurora");
      const paused = gate(), restored = gate(), stops = [];
      let running = false, attempts = 0;
      d.presence.desktopHosts = () => [pc];
      d.remote = {
        async ensure(host, profile) {
          assert.equal(host, pc.id);
          assert.equal(profile, "aurora");
          attempts += 1;
          await paused.p;
          running = true;
          return { port: null };
        },
        async stop(host, profile) {
          stops.push([host, profile]);
          if (stopFails && stops.length === 1) throw new Error("host unreachable");
          running = false;
        },
      };
      local.restore = () => restored.p;
      d.setHome("aurora", pc.id);
      const resolving = d.resolve("aurora");
      const restoring = d.restore("aurora", "11111111-1111-4111-8111-111111111111");
      if (completed) { restored.open({ ok: true }); await restoring; }
      paused.open();
      const result = await resolving;
      restored.open({ ok: true });
      await restoring;
      assert.deepEqual(result, { kind: "fallback", reason: "failed" });
      assert.deepEqual(stops, [[pc.id, "aurora"]], "restore on A cannot own cleanup on B");
      assert.equal(running, stopFails);
      assert.equal(d.state("aurora"), stopFails ? "failed" : "off");
      assert.equal(d.hosts().find((h) => h.id === pc.id).running, stopFails ? 1 : 0);
      assert.equal(d.snapshotHost("aurora"), "agent-host");
      assert.deepEqual(local.stopped, ["aurora"], "no extra cleanup on the restored host");
      if (stopFails) assert.deepEqual(await d.resolve("aurora"), { kind: "fallback", reason: "failed" });
      await d.sweep();
      assert.equal(stops.length, stopFails ? 2 : 1);
      assert.ok(stops.every(([host, profile]) => host === pc.id && profile === "aurora"));
      assert.equal(running, false);
      assert.equal(d.state("aurora"), "off");
      assert.equal(d.hosts().find((h) => h.id === pc.id).running, 0);
      assert.equal(attempts, 1, "the invalidated start is never retried");
    });
  }
}

for (const limited of [true, false]) {
  test(`snapshot placement: failed A-to-B start keeps confirmed A across restart (LIMIT=${limited})`, async () => {
    const { d, local } = rig();
    await d.resolve("aurora");
    await d.stop("aurora");
    const paused = gate(), routes = [];
    let attempts = 0, cleanups = 0;
    d.presence.desktopHosts = () => [pc];
    d.remote = {
      async ensure() { attempts += 1; await paused.p; throw Object.assign(new Error("start failed"), limited ? { code: "LIMIT" } : {}); },
      async stop() { cleanups += 1; },
      async snapshots(host) { routes.push(host); return { points: [], totalBytes: 0, busy: false, recovery: false }; },
    };
    local.snapshots = async () => { routes.push("agent-host"); return { points: [], totalBytes: 0, busy: false, recovery: false }; };
    d.setHome("aurora", pc.id);
    const resolving = d.resolve("aurora");
    await d.snapshots("aurora"); // the reservation on B has not even answered yet
    paused.open();
    assert.deepEqual(await resolving, { kind: "fallback", reason: limited ? "limit" : "failed" });
    await d.snapshots("aurora");
    const restarted = new Desktops({ local, remote: d.remote, presence: d.presence, store: d.store });
    await restarted.snapshots("aurora");
    assert.equal(attempts, limited ? 1 : 3);
    assert.equal(cleanups, limited ? 0 : 1);
    assert.equal(routes[0], "agent-host", "UI listing during reservation uses confirmed A");
    assert.deepEqual(routes.slice(1, -2), Array(attempts + cleanups).fill(pc.id), "lifecycle notices are collected from B without changing placement");
    assert.deepEqual(routes.slice(-2), ["agent-host", "agent-host"], "failed start and restart keep confirmed A");
    assert.equal(d.store.load().snapshotHosts.aurora, "agent-host");
  });
}

test("snapshot placement: a configured home without confirmed hosting is not a snapshot host", async () => {
  const { d, local } = rig();
  local.snapshots = async () => ({ points: [], totalBytes: 0, busy: false, recovery: false });
  d.setHome("aurora", "agent-host");
  assert.deepEqual(await d.snapshots("aurora"), { points: [], totalBytes: 0, busy: false, recovery: false, host: null });
});

for (const origin of ["restore", "recovery"]) {
  for (const status of ["done", "busy", "recovery", "unavailable"]) {
    test(`snapshot reconnect: ${origin} hold reconciles from recorded host reporting ${status}`, async () => {
      const { d, c, st, calls } = deckRig({ running: ["aurora"] });
      await d.syncHosts();
      const points = [], gone = gate();
      let restores = 0, answer = "recovery";
      d.remote.snapshots = async (host, profile) => {
        points.push([host, profile]);
        if (answer === "unavailable") throw new Error("host gone");
        return { points: [], totalBytes: 0, busy: answer === "busy", recovery: answer === "recovery" };
      };
      d.remote.restore = async () => { restores += 1; await gone.p; throw new Error("host gone"); };
      let restoring;
      if (origin === "restore") restoring = assert.rejects(d.restore("aurora", "11111111-1111-4111-8111-111111111111"), /restore failed/);
      else await d.snapshots("aurora");
      await tick();
      st.hosts = [];
      await d.syncHosts();
      gone.open();
      if (restoring) await restoring;
      assert.equal(d.busy("aurora"), true);
      d.setHome("aurora", "agent-host"); // preferences must not redirect recovery queries
      points.length = 0;
      answer = status;
      st.running = [];
      st.hosts = [pc, { ...pc, id: "b1b2c3d4" }];
      await d.syncHosts();
      assert.deepEqual(points, [[pc.id, "aurora"]], "reconnection automatically lists points on the recorded host only");
      assert.equal(d.busy("aurora"), status !== "done");
      if (status !== "done") {
        assert.deepEqual(await d.resolve("aurora"), { kind: "fallback", reason: "failed" });
        answer = "done";
        await d.syncHosts();
        assert.equal(points.length, 1, "held profiles are polled with the existing throttle");
        c.t += 11_000;
        await d.syncHosts();
        assert.equal(d.busy("aurora"), false, "fresh completion also releases a retained hold without another disconnect");
        assert.deepEqual(points, [[pc.id, "aurora"], [pc.id, "aurora"]]);
      }
      assert.equal(restores, origin === "restore" ? 1 : 0, "restore is never replayed");
      assert.deepEqual(calls.ensure, [], "reconciliation never starts the desktop");
    });
  }
}

for (const alreadyRestoring of [false, true]) {
  test(`snapshot reconnect: a point query overlapping restore cannot clear its failed hold (alreadyRestoring=${alreadyRestoring})`, async () => {
    const { d, c, st } = deckRig({ running: ["aurora"] });
    await d.syncHosts();
    d.remote.snapshots = async () => ({ points: [], totalBytes: 0, busy: false, recovery: true });
    await d.snapshots("aurora");
    st.hosts = [];
    await d.syncHosts();
    const points = gate(), restored = gate();
    d.remote.snapshots = () => points.p;
    d.remote.restore = async () => { await restored.p; throw new Error("disconnected"); };
    const restore = () => assert.rejects(d.restore("aurora", "11111111-1111-4111-8111-111111111111"), /restore failed/);
    let restoring = alreadyRestoring ? restore() : null;
    st.hosts = [pc];
    st.running = [];
    const syncing = d.syncHosts();
    if (!alreadyRestoring) restoring = restore();
    restored.open();
    await restoring;
    points.open({ points: [], totalBytes: 0, busy: false, recovery: false });
    await syncing;
    assert.equal(d.busy("aurora"), true, "only a query issued after restore settles may clear its hold");
    c.t += 11_000;
    await d.syncHosts();
    assert.equal(d.busy("aurora"), false, "a fresh point query can release the hold");
  });
}
