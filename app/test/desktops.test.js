"use strict";
// A Deck computer as an agent-desktop host (agent spaces phase 2, app/main/desktops.js): heartbeat field, pull
// progress, the CTRL ensure gate (hosting switch, this computer's limit), the periodic isolation check, hosting
// on/off through IPC and the stop on quit. Everything runs against a fake DesktopHost and a fake relay: no Docker.
//   node --test "app/test/desktops.test.js"
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { heartbeatField, pullPct, initDesktops, LIMIT_ERROR } = require("../main/desktops");
const { OP, encode, decode, json } = require("../main/space-tunnel-frames");
const { NOT_HOSTING } = require("../main/space-tunnel");

test("heartbeat field: ready only with hosting on, Docker ready and the image present; counts running; carries the idle minutes", () => {
  assert.deepEqual(heartbeatField({ host: false, docker: "ready", image: "present", limit: 3, running: 0, idleMin: 20 }), { ready: false, limit: 3, running: 0, idleMin: 20 });
  assert.deepEqual(heartbeatField({ host: true, docker: "stopped", image: "present", limit: 3, running: 0, idleMin: 20 }), { ready: false, limit: 3, running: 0, idleMin: 20 });
  assert.deepEqual(heartbeatField({ host: true, docker: "ready", image: "pulling", limit: 3, running: 0, idleMin: 20 }), { ready: false, limit: 3, running: 0, idleMin: 20 });
  assert.deepEqual(heartbeatField({ host: true, docker: "ready", image: "present", limit: 3, running: 2, idleMin: 45 }), { ready: true, limit: 3, running: 2, idleMin: 45 });
});

test("heartbeat field: idle minutes clamped to 5..240 (20 when unset); a failed isolation check makes the host not ready", () => {
  const f = (idleMin) => heartbeatField({ host: true, docker: "ready", image: "present", limit: 3, running: 0, idleMin }).idleMin;
  assert.deepEqual([f(1), f(5), f(240), f(999), f(undefined), f("x"), f(30.6)], [5, 5, 240, 240, 20, 20, 31]);
  assert.deepEqual(heartbeatField({ host: true, docker: "ready", image: "present", limit: 3, running: 0, idleMin: 20, isolated: false }), { ready: false, limit: 3, running: 0, idleMin: 20 });
});

test("pull progress from docker's layer lines", () => {
  const p = pullPct();
  p.line("a1: Pulling fs layer"); p.line("b2: Pulling fs layer");
  assert.equal(p.pct(), 0);
  p.line("a1: Pull complete");
  assert.equal(p.pct(), 50);
  p.line("b2: Already exists");
  assert.equal(p.pct(), 100);
});

// ---------------------------------------------------------------- fakes

function fakeHost() {
  const h = {
    calls: [],
    opts: { memory: "1.5g", cpus: 2, shm: "1g" },
    dockerState: "ready",
    present: true,
    desktops: [], // {profile, running, port}
    netOk: [true], // netCheck answers, in order (the last one repeats)
    pullLines: [],
    pullFail: null,
    pullGate: null, // a promise the pull waits on
    async docker() { return h.dockerState; },
    async imagePresent() { return h.present; },
    async pull(onLine) {
      h.calls.push("pull");
      for (const l of h.pullLines) onLine(l);
      if (h.pullGate) await h.pullGate;
      if (h.pullFail) throw new Error(h.pullFail);
      h.present = true;
    },
    async list() { return h.desktops.map((d) => ({ ...d })); },
    async stats() { return h.desktops.filter((d) => d.running).map((d) => ({ profile: d.profile, memMB: 700, cpuPct: 3.5 })); },
    async homeSize() { return 2e9; },
    async ensure(p) {
      h.calls.push(["ensure", p, { ...h.opts }]);
      const d = h.desktops.find((x) => x.profile === p);
      if (d) d.running = true;
      else h.desktops.push({ profile: p, running: true, port: 41000 + h.desktops.length });
      return { port: h.desktops.find((x) => x.profile === p).port };
    },
    async stop(p) {
      h.calls.push(["stop", p]);
      const d = h.desktops.find((x) => x.profile === p);
      if (d) d.running = false;
    },
    async reset(p) { h.calls.push(["reset", p]); h.desktops = h.desktops.filter((x) => x.profile !== p); },
    tokenOf(p) { return `tok-${p}`; },
    async netCheck() { h.calls.push("netCheck"); return h.netOk.length > 1 ? h.netOk.shift() : h.netOk[0]; },
    async netRepair() { h.calls.push("netRepair"); },
  };
  return h;
}

function fakeSettings(over = {}) {
  const s = {
    data: { desktops: { host: false, limit: 3, memory: "1.5g", cpus: 2, idleMin: 20, homeWarnGB: 10, ...over } },
    hostCalls: [],
    updateDesktopsHost(on) { s.hostCalls.push(on); s.data.desktops.host = on === true; },
    publicView() { return { desktops: { ...s.data.desktops } }; },
  };
  return s;
}

function fakePresence() {
  const p = { field: null, pushes: 0, setDesktops(fn) { p.field = fn; }, push() { p.pushes++; }, beat() { return { desktops: p.field ? p.field() : null }; } };
  return p;
}

function fakeIpc() {
  const handlers = new Map();
  return { handlers, handle: (ch, fn) => handlers.set(ch, fn), call: (ch, ...a) => handlers.get(ch)({ senderFrame: null }, ...a) };
}

function fakeRelay() {
  const r = new EventEmitter();
  r.sent = [];
  r.send = (b) => { r.sent.push(b); return true; };
  return r;
}

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function setup({ settings = {}, host = fakeHost(), clock = { t: 1_000_000 } } = {}) {
  const st = fakeSettings(settings);
  const presence = fakePresence();
  const ipc = fakeIpc();
  const events = [];
  const detached = [];
  const api = initDesktops({
    ipc, settings: st, presence, send: (ch, m) => events.push([ch, m]), dataDir: "/fixture-desktops",
    host, now: () => clock.t, setInterval: () => ({ fake: true }), clearInterval: () => {}, detach: (argv) => detached.push(argv),
  });
  return { api, host, st, presence, ipc, events, detached, clock };
}

/** Desktops that this session started: the first look (which stops an earlier run's leftovers) found none. */
async function setupRunning(desktops, o = {}) {
  const env = setup(o);
  await env.api._test.poll();
  env.host.desktops = desktops;
  return env;
}

async function ctrl(relay, ch, m) {
  relay.emit("frame", encode(OP.CTRL, ch, m));
  await flush();
  const res = relay.sent.map(decode).find((f) => f && f.op === OP.CTRL_RES && f.ch === ch);
  return res ? json(res.payload) : null;
}

// ---------------------------------------------------------------- the CTRL ensure gate (ruling 2)

test("CTRL: everything is refused while hosting is off", async () => {
  const { api, host } = setup();
  const relay = fakeRelay();
  api.attachRelay(relay);
  assert.deepEqual(await ctrl(relay, 1, { op: "ensure", profile: "aurora" }), { ok: false, error: NOT_HOSTING });
  assert.deepEqual(await ctrl(relay, 2, { op: "list" }), { ok: false, error: NOT_HOSTING });
  assert.equal(host.calls.filter((c) => Array.isArray(c) && c[0] === "ensure").length, 0);
});

test("CTRL ensure: refused when this computer already runs its limit of other desktops; its own desktop is not counted", async () => {
  const { api, host } = await setupRunning([{ profile: "a", running: true, port: 41001 }, { profile: "b", running: true, port: 41002 }, { profile: "c", running: false, port: null }], { settings: { host: true, limit: 2 } });
  await api._test.poll();
  const relay = fakeRelay();
  api.attachRelay(relay);
  const r = await ctrl(relay, 3, { op: "ensure", profile: "c" });
  assert.equal(r.ok, false);
  assert.equal(r.error, LIMIT_ERROR);
  assert.match(LIMIT_ERROR, /limit/);
  assert.equal(host.calls.filter((c) => Array.isArray(c) && c[0] === "ensure").length, 0, "the gate stops it before Docker");
  // a desktop that already runs may be ensured again (it is one of the `limit`, not one more)
  assert.deepEqual(await ctrl(relay, 4, { op: "ensure", profile: "a" }), { ok: true, port: null });
});

test("CTRL ensure: under the limit it goes to the host, with this computer's memory and CPU settings", async () => {
  const host = fakeHost();
  const { api } = setup({ settings: { host: true, limit: 2, memory: "3g", cpus: 4 }, host });
  await api._test.poll();
  const relay = fakeRelay();
  api.attachRelay(relay);
  assert.deepEqual(await ctrl(relay, 5, { op: "ensure", profile: "aurora" }), { ok: true, port: null });
  const call = host.calls.find((c) => Array.isArray(c) && c[0] === "ensure");
  assert.equal(call[1], "aurora");
  assert.equal(call[2].memory, "3g");
  assert.equal(call[2].cpus, 4);
});

test("CTRL ensure: limit 0 refuses every desktop; two ensures at once cannot both take the last slot", async () => {
  const zero = setup({ settings: { host: true, limit: 0 } });
  await zero.api._test.poll();
  const r0 = fakeRelay();
  zero.api.attachRelay(r0);
  assert.equal((await ctrl(r0, 6, { op: "ensure", profile: "a" })).error, LIMIT_ERROR);

  const host = fakeHost();
  let release;
  const gate = new Promise((r) => (release = r));
  const ensure = host.ensure;
  host.ensure = async (p) => { await gate; return ensure(p); };
  const one = setup({ settings: { host: true, limit: 1 }, host });
  await one.api._test.poll();
  const relay = fakeRelay();
  one.api.attachRelay(relay);
  relay.emit("frame", encode(OP.CTRL, 7, { op: "ensure", profile: "a" }));
  await flush();
  const second = await ctrl(relay, 8, { op: "ensure", profile: "b" });
  assert.equal(second.error, LIMIT_ERROR, "a desktop being started holds its slot");
  release();
  await flush();
  const first = relay.sent.map(decode).find((f) => f && f.op === OP.CTRL_RES && f.ch === 7);
  assert.equal(json(first.payload).ok, true);
});

test("the relay connection carries other tunnels' frames: only [0xD6] frames reach the space tunnel", async () => {
  const { api } = setup({ settings: { host: true } });
  const relay = fakeRelay();
  api.attachRelay(relay);
  const cdp = Buffer.from([0xcd, 1, 0, 0, 0, 9, 0x7b, 0x7d]);
  const driver = Buffer.from([0xd5, 1, 0, 0, 0, 9]);
  assert.doesNotThrow(() => { relay.emit("frame", cdp); relay.emit("frame", driver); relay.emit("frame", Buffer.alloc(0)); });
  await flush();
  assert.equal(relay.sent.length, 0, "nothing answered for frames that are not ours");
  assert.equal((await ctrl(relay, 10, { op: "list" })).ok, true);
  // a replaced connection: the old one no longer reaches the tunnel
  const next = fakeRelay();
  api.attachRelay(next);
  relay.emit("frame", encode(OP.CTRL, 11, { op: "list" }));
  await flush();
  assert.equal(relay.sent.map(decode).filter((f) => f && f.ch === 11).length, 0);
  assert.equal((await ctrl(next, 12, { op: "list" })).ok, true);
});

// ---------------------------------------------------------------- isolation check (ruling 3)

test("isolation: checked every 60 s while desktops run; a failure is repaired, else every desktop stops and the host is not ready until a later check passes", async () => {
  const clock = { t: 1_000_000 };
  const { api, presence, host } = await setupRunning([{ profile: "a", running: true, port: 41001 }, { profile: "b", running: true, port: 41002 }], { settings: { host: true }, clock });
  host.netOk = [true];
  await api._test.poll();
  assert.equal(host.calls.filter((c) => c === "netCheck").length, 1, "first poll with running desktops checks");
  assert.equal(presence.beat().desktops.ready, true);

  clock.t += 30_000;
  await api._test.poll();
  assert.equal(host.calls.filter((c) => c === "netCheck").length, 1, "not again within 60 s");

  // the rules vanished; repair works
  clock.t += 30_000;
  host.netOk = [false, true];
  await api._test.poll();
  assert.deepEqual(host.calls.slice(-3), ["netCheck", "netRepair", "netCheck"]);
  assert.equal(presence.beat().desktops.ready, true);
  assert.equal(host.calls.filter((c) => Array.isArray(c) && c[0] === "stop").length, 0);

  // they vanish again and the repair does not hold: every desktop stops, the host is not ready
  clock.t += 60_000;
  host.netOk = [false];
  await api._test.poll();
  assert.deepEqual(host.calls.filter((c) => Array.isArray(c) && c[0] === "stop").map((c) => c[1]).sort(), ["a", "b"]);
  assert.equal(presence.beat().desktops.ready, false);
  assert.equal(api._test.state().isolation, false);
  const relay = fakeRelay();
  api.attachRelay(relay);
  assert.equal((await ctrl(relay, 20, { op: "ensure", profile: "a" })).ok, false, "no desktop starts while isolation failed");

  // no desktop runs now, but the failed host keeps checking; a later pass makes it ready again
  clock.t += 60_000;
  host.netOk = [true];
  await api._test.poll();
  assert.equal(presence.beat().desktops.ready, true);
  assert.equal(api._test.state().isolation, true);
});

test("isolation: no check while no desktop runs, hosting is off, or Docker is not ready", async () => {
  const idle = setup({ settings: { host: true } });
  await idle.api._test.poll();
  assert.equal(idle.host.calls.filter((c) => c === "netCheck").length, 0);
  const off = setup();
  off.host.desktops = [{ profile: "a", running: true, port: 1 }];
  await off.api._test.poll();
  assert.equal(off.host.calls.filter((c) => c === "netCheck").length, 0);
  const down = fakeHost();
  down.dockerState = "stopped";
  down.desktops = [{ profile: "a", running: true, port: 1 }];
  const stopped = setup({ settings: { host: true }, host: down });
  await stopped.api._test.poll();
  assert.equal(stopped.host.calls.filter((c) => c === "netCheck").length, 0);
});

// ---------------------------------------------------------------- hosting on / off, pull, state, quit

test("hosting on through IPC: the switch is saved, the image is pulled in the background with progress, then the host is ready", async () => {
  const host = fakeHost();
  host.present = false;
  host.pullLines = ["l1: Pulling fs layer", "l2: Pulling fs layer", "l1: Pull complete"];
  let release;
  host.pullGate = new Promise((r) => (release = r));
  const { api, st, ipc, events, presence } = setup({ host });
  assert.equal(presence.beat().desktops, null, "no desktops field while hosting is off");
  const r = await ipc.call("desktops:host", true);
  assert.deepEqual(st.hostCalls, [true]);
  assert.equal(r.settings.desktops.host, true);
  await flush();
  assert.equal(api._test.state().image, "pulling");
  assert.deepEqual(api._test.state().pull, { pct: 47 }, "half the desktop image's layers: 95% x 50%");
  assert.ok(events.some(([ch, m]) => ch === "desktops" && m.image === "pulling" && m.pull && m.pull.pct === 47), "progress is pushed");
  assert.equal(presence.beat().desktops.ready, false, "not ready while pulling");
  release();
  await flush();
  const s = await ipc.call("desktops:state");
  assert.equal(s.image, "present");
  assert.equal(s.pull, null);
  assert.equal(s.host, true);
  assert.equal(s.docker, "ready");
  assert.equal(s.sizeBytes > 0, true);
  assert.deepEqual(presence.beat().desktops, { ready: true, limit: 3, running: 0, idleMin: 20 });
  assert.equal(host.calls.filter((c) => c === "pull").length, 1);
});

test("a failed pull leaves the image absent with the reason; a second hosting-on does not start a second pull while one runs", async () => {
  const host = fakeHost();
  host.present = false;
  host.pullFail = "docker pull failed: denied";
  const { api, ipc } = setup({ host });
  await ipc.call("desktops:host", true);
  await flush();
  const s = api._test.state();
  assert.equal(s.image, "absent");
  assert.match(s.error, /denied/);

  const h2 = fakeHost();
  h2.present = false;
  let release;
  h2.pullGate = new Promise((r) => (release = r));
  const two = setup({ host: h2 });
  await two.ipc.call("desktops:host", true);
  await two.ipc.call("desktops:host", true);
  await two.api._test.poll();
  release();
  await flush();
  assert.equal(h2.calls.filter((c) => c === "pull").length, 1);
});

test("hosting on with Docker missing: no pull, the state says why", async () => {
  const host = fakeHost();
  host.dockerState = "missing";
  host.present = false;
  const { ipc } = setup({ host });
  await ipc.call("desktops:host", true);
  await flush();
  const s = await ipc.call("desktops:state");
  assert.equal(s.docker, "missing");
  assert.equal(s.image, "absent");
  assert.equal(host.calls.filter((c) => c === "pull").length, 0);
});

test("hosting off through IPC: every running desktop stops and the tunnel stops answering", async () => {
  const { api, st, ipc, presence, host } = await setupRunning([{ profile: "a", running: true, port: 41001 }, { profile: "b", running: false, port: null }], { settings: { host: true } });
  await api._test.poll();
  const relay = fakeRelay();
  api.attachRelay(relay);
  assert.equal((await ctrl(relay, 30, { op: "list" })).ok, true);
  await ipc.call("desktops:host", false);
  await flush();
  assert.deepEqual(st.hostCalls, [false]);
  assert.deepEqual(host.calls.filter((c) => Array.isArray(c) && c[0] === "stop").map((c) => c[1]), ["a"], "only the running one");
  assert.deepEqual(await ctrl(relay, 31, { op: "list" }), { ok: false, error: NOT_HOSTING });
  assert.equal(presence.beat().desktops, null);
});

test("desktops:state lists running desktops with RAM, CPU and home size; stop and reset go to the host", async () => {
  const { api, ipc, host } = await setupRunning([{ profile: "aurora", running: true, port: 41001 }, { profile: "old", running: false, port: null }], { settings: { host: true } });
  await api._test.poll();
  const s = await ipc.call("desktops:state");
  assert.deepEqual(s.running, [{ profile: "aurora", memMB: 700, cpuPct: 3.5, homeBytes: 2e9 }]);
  assert.equal(s.limit, 3);
  await ipc.call("desktops:stop", "aurora");
  await ipc.call("desktops:reset", "old");
  assert.ok(host.calls.some((c) => Array.isArray(c) && c[0] === "stop" && c[1] === "aurora"));
  assert.ok(host.calls.some((c) => Array.isArray(c) && c[0] === "reset" && c[1] === "old"));
  await assert.rejects(() => ipc.call("desktops:stop", "../x"));
  await assert.rejects(() => ipc.call("desktops:reset", 42));
});

test("port and token for this Deck's own viewer: only while hosting, only for a running desktop", async () => {
  const on = await setupRunning([{ profile: "aurora", running: true, port: 41001 }], { settings: { host: true } });
  const host = on.host;
  assert.equal(await on.api.port("aurora"), 41001);
  assert.equal(await on.api.port("nobody"), null);
  assert.equal(on.api.token("aurora"), "tok-aurora");
  const off = setup({ host });
  assert.equal(await off.api.port("aurora"), null);
  assert.equal(off.api.token("aurora"), null);
});

test("stopAll stops what runs; quit hands the stop to a detached docker process, once, and only when something runs", async () => {
  const { api, detached, host } = await setupRunning([{ profile: "a", running: true, port: 1 }, { profile: "b", running: true, port: 2 }], { settings: { host: true } });
  await api._test.poll();
  api.quit();
  api.quit();
  assert.deepEqual(detached, [["stop", "-t", "10", "hermes-deck-space-a", "hermes-deck-space-b"]]);
  await api.stopAll();
  assert.deepEqual(host.calls.filter((c) => Array.isArray(c) && c[0] === "stop").map((c) => c[1]).sort(), ["a", "b"]);
  const none = setup({ settings: { host: true } });
  await none.api._test.poll();
  none.api.quit();
  assert.deepEqual(none.detached, []);
});

test("stopAll survives Docker being gone", async () => {
  const host = fakeHost();
  host.list = async () => { const e = new Error("spawn docker ENOENT"); e.code = "ENOENT"; throw e; };
  const { api } = setup({ settings: { host: true }, host });
  await assert.doesNotReject(() => api.stopAll());
});

test("presence heartbeat carries the desktops field from desktops.js, and null without one", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const electron = { app: { getPath: () => "/fixture-profile" }, ipcMain: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0, getSystemIdleState: () => "active" } };
  const context = { module: { exports: {} }, process, Buffer,
    require: (id) => (id === "electron" ? electron : id === "fs" ? { readFileSync: () => { throw new Error("none"); } } : require(id.startsWith(".") ? path.join(__dirname, "../main", id) : id)) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../main/presence.js"), "utf8"), context);
  const p = new context.module.exports.DevicePresence({ persist: false });
  assert.equal(p.beat().desktops, null);
  p.setDesktops(() => ({ ready: true, limit: 4, running: 1, idleMin: 30 }));
  assert.deepEqual({ ...p.beat().desktops }, { ready: true, limit: 4, running: 1, idleMin: 30 });
  p.setDesktops(() => null);
  assert.equal(p.beat().desktops, null);
  p.setDesktops(() => { throw new Error("broken"); });
  assert.equal(p.beat().desktops, null, "a broken field never breaks the heartbeat");
});

// ---------------------------------------------------------------- fix round 1

test("fix1 #1: hosting off while a start is in flight: the desktop it started is stopped and the relay hears not hosting", async () => {
  const host = fakeHost();
  let release;
  const gate = new Promise((r) => (release = r));
  const ensure = host.ensure;
  host.ensure = async (p) => { await gate; return ensure(p); };
  const { api, ipc } = setup({ settings: { host: true }, host });
  await api._test.poll();
  const relay = fakeRelay();
  api.attachRelay(relay);
  relay.emit("frame", encode(OP.CTRL, 40, { op: "ensure", profile: "a" }));
  await flush();
  await ipc.call("desktops:host", false);
  await flush();
  release();
  await flush();
  const stops = host.calls.filter((c) => Array.isArray(c) && c[0] === "stop").map((c) => c[1]);
  assert.deepEqual(stops, ["a"], "the late start is stopped");
  assert.equal(host.desktops.find((d) => d.profile === "a").running, false);
  const res = relay.sent.map(decode).find((f) => f && f.op === OP.CTRL_RES && f.ch === 40);
  assert.deepEqual(json(res.payload), { ok: false, error: NOT_HOSTING });
});

test("fix1 #1: off then on again during a start still stops it (a new hosting generation)", async () => {
  const host = fakeHost();
  let release;
  const gate = new Promise((r) => (release = r));
  const ensure = host.ensure;
  host.ensure = async (p) => { await gate; return ensure(p); };
  const { api, ipc } = setup({ settings: { host: true }, host });
  await api._test.poll();
  const relay = fakeRelay();
  api.attachRelay(relay);
  relay.emit("frame", encode(OP.CTRL, 41, { op: "ensure", profile: "a" }));
  await flush();
  await ipc.call("desktops:host", false);
  await ipc.call("desktops:host", true);
  await flush();
  release();
  await flush();
  assert.ok(host.calls.some((c) => Array.isArray(c) && c[0] === "stop" && c[1] === "a"));
});

test("fix1 #1: quit stops what still runs even with hosting off", async () => {
  const { api, ipc, host, detached } = await setupRunning([{ profile: "a", running: true, port: 1 }], { settings: { host: true } });
  await api._test.poll();
  host.stop = async () => { throw new Error("docker stop timed out"); }; // the off switch could not stop it
  await ipc.call("desktops:host", false);
  await flush();
  api.quit();
  assert.deepEqual(detached, [["stop", "-t", "10", "hermes-deck-space-a"]]);
});

test("fix1 #2: the first look stops desktops left running by an earlier run; later looks and this session's starts are left alone", async () => {
  const host = fakeHost();
  host.desktops = [{ profile: "x", running: true, port: 1 }, { profile: "y", running: false, port: null }];
  const { api } = setup({ settings: { host: true }, host });
  await api._test.poll();
  assert.deepEqual(host.calls.filter((c) => Array.isArray(c) && c[0] === "stop").map((c) => c[1]), ["x"]);
  assert.equal(api._test.state().running.length, 0);
  const relay = fakeRelay();
  api.attachRelay(relay);
  assert.equal((await ctrl(relay, 50, { op: "ensure", profile: "a" })).ok, true);
  host.desktops.push({ profile: "z", running: true, port: 3 });
  await api._test.poll();
  await api._test.poll();
  assert.deepEqual(host.calls.filter((c) => Array.isArray(c) && c[0] === "stop").map((c) => c[1]), ["x"], "only once, at the first look");
});

test("fix1 #2: leftovers are stopped at the first look even if Docker was not ready at start", async () => {
  const host = fakeHost();
  host.dockerState = "stopped";
  host.desktops = [{ profile: "x", running: true, port: 1 }];
  const { api } = setup({ settings: { host: true }, host });
  await api._test.poll();
  assert.equal(host.calls.filter((c) => Array.isArray(c) && c[0] === "stop").length, 0);
  host.dockerState = "ready";
  await api._test.poll();
  assert.deepEqual(host.calls.filter((c) => Array.isArray(c) && c[0] === "stop").map((c) => c[1]), ["x"]);
});

test("fix1 #3: the heartbeat carries this computer's idle minutes from Settings", async () => {
  const { api, presence } = setup({ settings: { host: true, idleMin: 45 } });
  await api._test.poll();
  assert.deepEqual(presence.beat().desktops, { ready: true, limit: 3, running: 0, idleMin: 45 });
});

test("fix1 #4: pull progress weighs the desktop image 95% and the helper image 5%", async () => {
  const host = fakeHost();
  host.present = false;
  let release;
  host.pullGate = new Promise((r) => (release = r));
  host.pull = async (onLine) => {
    host.calls.push("pull");
    onLine("a1: Pulling fs layer", "image"); onLine("a1: Pull complete", "image");
    onLine("h1: Pulling fs layer", "helper");
    await host.pullGate;
    host.present = true;
  };
  const { api, ipc } = setup({ host });
  await ipc.call("desktops:host", true);
  await flush();
  assert.deepEqual(api._test.state().pull, { pct: 95 });
  release();
  await flush();
  assert.equal(api._test.state().image, "present");
});

test("fix1 #7: two starts of one desktop hold its slot until the last settles", async () => {
  const host = fakeHost();
  const gates = [];
  host.ensure = async (p) => {
    host.calls.push(["ensure", p]);
    const g = {};
    g.p = new Promise((res, rej) => { g.res = res; g.rej = rej; });
    gates.push(g);
    await g.p;
    host.desktops.push({ profile: p, running: true, port: 41001 });
    return { port: 41001 };
  };
  const { api } = setup({ settings: { host: true, limit: 1 }, host });
  await api._test.poll();
  const relay = fakeRelay();
  api.attachRelay(relay);
  relay.emit("frame", encode(OP.CTRL, 60, { op: "ensure", profile: "a" }));
  relay.emit("frame", encode(OP.CTRL, 61, { op: "ensure", profile: "a" }));
  await flush();
  assert.equal(gates.length, 2);
  gates[0].rej(new Error("docker run failed: name in use")); // the first one fails, the second is still starting
  await flush();
  assert.equal((await ctrl(relay, 62, { op: "ensure", profile: "b" })).error, LIMIT_ERROR, "a's second start still holds the slot");
  gates[1].res();
  await flush();
});

// ---- final fix wave I1: a wedged Docker never hangs the Deck's poll ----------------------------------------------

test("I1 poll: with Docker answering only `version`, every other docker call times out and poll() settles within the bound", { timeout: 3000 }, async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { dockerRunner } = require("../main/desktop-host");
  const spawnFn = (bin, argv) => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => {}; // ignored: never closes
    if (argv[0] === "version") setImmediate(() => { p.stdout.emit("data", "27.0.0\n"); p.emit("close", 0); });
    return p;
  };
  const st = fakeSettings({ host: true });
  const api = initDesktops({
    ipc: fakeIpc(), settings: st, presence: fakePresence(), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "i1-deck-")),
    runner: dockerRunner({ spawnFn, shortMs: 20, longMs: 20, helperMs: 20 }),
    now: () => 1_000_000, setInterval: () => ({ fake: true }), clearInterval: () => {}, detach: () => {},
  });
  const t0 = Date.now();
  await api._test.poll();
  await api._test.poll(); // a second look starts and settles too (the first one did not keep `polling` set)
  assert.ok(Date.now() - t0 < 2000, `settled in ${Date.now() - t0} ms`);
  const s = api._test.state();
  assert.equal(s.docker, "ready");
  assert.deepEqual(s.running, []);
});

test("snapshot CTRL methods go through hosting gate and policy is bounded", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../main/desktops.js"), "utf8");
  assert.match(source, /\["snapshot", "snapshots", "restore", "dropSnapshot"\]/);
  assert.match(source, /if \(!hosting\(\) \|\| !containerName\(p\)\)/);
  assert.match(source, /snapshotKeep >= 1 && s.snapshotKeep <= 100/);
});

test("snapshot gate rejects busy starts and stale hosting generations; policy and stop retention are bounded", async () => {
  const { api, host, ipc, presence } = setup({ settings: { host: true } });
  await api._test.poll();
  const relay = fakeRelay();
  api.attachRelay(relay);
  api.safetyPolicy({ snapshotKeep: 7 });
  for (const snapshotKeep of [0, 101, 1.5, "10", null]) api.safetyPolicy({ snapshotKeep });
  assert.equal(host.opts.snapshotKeep, 7);
  await ctrl(relay, 9200, { op: "stop", profile: "agent1", keep: 4 });
  assert.equal(host.opts.snapshotKeep, 4);
  host.snapshotBusy = () => true;
  assert.equal((await ctrl(relay, 9201, { op: "ensure", profile: "agent1" })).error, "desktop operation in progress");
  assert.equal(host.calls.some((c) => c[0] === "ensure"), false);
  host.snapshotBusy = () => false;
  await ctrl(relay, 9202, { op: "ensure", profile: "agent1" });
  assert.equal(presence.beat().desktops.running, 1);
  const id = "11111111-1111-4111-8111-111111111111";
  host.restore = async () => ({ ok: true, before: id });
  assert.deepEqual(await ctrl(relay, 9203, { op: "restore", profile: "agent1", id, keep: 10 }), { ok: true, before: id });
  assert.equal(presence.beat().desktops.running, 0);
  let finish;
  host.snapshots = () => new Promise((resolve) => { finish = resolve; });
  relay.emit("frame", encode(OP.CTRL, 9204, { op: "snapshots", profile: "agent1", keep: 10 }));
  await flush();
  await ipc.call("desktops:host", false);
  await ipc.call("desktops:host", true);
  finish({ points: [], totalBytes: 0 });
  await flush();
  const stale = relay.sent.map(decode).find((f) => f.ch === 9204);
  assert.deepEqual(json(stale.payload), { ok: false, error: "snapshot operation failed" });
});

test("ensure cannot queue a start when a snapshot begins during its host listing", async () => {
  const { api, host } = setup({ settings: { host: true } });
  await api._test.poll();
  const relay = fakeRelay();
  api.attachRelay(relay);
  let finish, busy = false;
  host.snapshotBusy = () => busy;
  host.list = () => new Promise((resolve) => { finish = resolve; });
  relay.emit("frame", encode(OP.CTRL, 9300, { op: "ensure", profile: "agent1" }));
  await flush();
  busy = true;
  finish([]);
  await flush();
  const reply = json(relay.sent.map(decode).find((f) => f.ch === 9300).payload);
  assert.equal(reply.error, "desktop operation in progress");
  assert.equal(host.calls.some((c) => c[0] === "ensure"), false);
});
