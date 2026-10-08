"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Restarts, idleState } = require("../src/restarts");

function hermes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-restarts-"));
  const home = (p) => (p === "default" ? root : path.join(root, "profiles", p));
  const state = (p, active, gw = "running", at = new Date().toISOString()) => {
    fs.mkdirSync(home(p), { recursive: true });
    fs.writeFileSync(path.join(home(p), "gateway_state.json"), JSON.stringify({ gateway_state: gw, active_agents: active, updated_at: at }));
  };
  const delegation = (p, lastLine) => {
    const dir = path.join(home(p), "cache", "delegation", "live", "d1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "task-1.log"), `start\n${lastLine}\n`);
  };
  return { root, home, state, delegation };
}

function setup(h, queue) {
  const file = path.join(h.root, "restart-queue.json");
  fs.writeFileSync(file, JSON.stringify(queue));
  const clock = { ms: Date.parse("2026-10-09T10:00:00Z") };
  const calls = [];
  const r = new Restarts({
    file, hermesRoot: h.root, hermesBin: "hermes", now: () => clock.ms, verifyMs: 60_000,
    run: async (cmd, args) => { calls.push([cmd, ...args].join(" ")); const p = args[0] === "-p" ? args[1] : "default"; h.state(p, 0, "running", new Date(clock.ms + 1000).toISOString()); return { code: 0, out: "" }; },
  });
  return { r, file, clock, calls };
}

test("idleState: active agents or an unfinished delegation log is busy; missing state is unknown", () => {
  const h = hermes();
  assert.equal(idleState(h.home("default"), Date.now()), "unknown");
  h.state("default", 1);
  assert.equal(idleState(h.home("default"), Date.now()), "busy");
  h.state("default", 0);
  assert.equal(idleState(h.home("default"), Date.now()), "idle");
  h.delegation("default", "step 3");
  assert.equal(idleState(h.home("default"), Date.now()), "busy");
  h.delegation("default", "final | end status=ok");
  assert.equal(idleState(h.home("default"), Date.now()), "idle");
});

test("restarts only after two consecutive idle checks, then verifies running", async () => {
  const h = hermes();
  h.state("research", 0);
  const x = setup(h, [{ profile: "research", reason: "plugin 1.3.0", since: "t" }]);
  await x.r.tick();
  assert.deepEqual(x.calls, [], "one idle check is not enough");
  x.clock.ms += 15_000;
  await x.r.tick();
  assert.deepEqual(x.calls, ["hermes -p research gateway restart"]);
  assert.equal(x.r.rows()[0].state, "restarted");
  assert.deepEqual(JSON.parse(fs.readFileSync(x.file, "utf8")), [], "done entries leave the queue file");
});

test("a profile that turns busy between checks resets its idle count", async () => {
  const h = hermes();
  h.state("default", 0);
  const x = setup(h, [{ profile: "default", reason: "plugin 1.3.0", since: "t" }]);
  await x.r.tick();
  h.state("default", 1);
  await x.r.tick();
  assert.equal(x.r.rows()[0].state, "busy");
  h.state("default", 0);
  await x.r.tick();
  assert.deepEqual(x.calls, [], "only one idle check since the busy one");
  x.clock.ms += 15_000;
  await x.r.tick();
  assert.deepEqual(x.calls, ["hermes gateway restart"]);
});

test("unknown state is never restarted automatically; restartNow does it", async () => {
  const h = hermes();
  const x = setup(h, [{ profile: "ghost", reason: "plugin 1.3.0", since: "t" }]);
  for (let i = 0; i < 4; i++) await x.r.tick();
  assert.deepEqual(x.calls, []);
  assert.equal(x.r.rows()[0].state, "unknown");
  const r = await x.r.restartNow("ghost");
  assert.equal(r.ok, true);
  assert.deepEqual(x.calls, ["hermes -p ghost gateway restart"]);
});

test("a gateway that does not report running within verifyMs is failed", async () => {
  const h = hermes();
  h.state("default", 0, "running", "2026-10-09T09:59:59Z");
  const x = setup(h, [{ profile: "default", reason: "plugin 1.3.0", since: "t" }]);
  x.r.run = async () => ({ code: 0, out: "" }); // state file never refreshed
  x.r.sleep = async (ms) => { x.clock.ms += ms; };
  await x.r.tick();
  x.clock.ms += 15_000;
  await x.r.tick();
  assert.equal(x.r.rows()[0].state, "failed");
  assert.match(x.r.rows()[0].error, /did not report running/);
});

test("restartNow refuses a profile that is not queued and an invalid name", async () => {
  const h = hermes();
  const x = setup(h, []);
  assert.equal((await x.r.restartNow("nope")).ok, false);
  assert.equal((await x.r.restartNow("../x")).ok, false);
});

test("a long wait sets longWait after notifyAfterMs", async () => {
  const h = hermes();
  h.state("default", 1);
  const x = setup(h, [{ profile: "default", reason: "plugin 1.3.0", since: new Date(Date.parse("2026-10-09T07:00:00Z")).toISOString() }]);
  await x.r.tick();
  assert.equal(x.r.rows()[0].longWait, true);
});

test("early idle ticks do not restart or move the first observation time", async () => {
  const h = hermes();
  h.state("default", 0);
  const x = setup(h, [{ profile: "default", reason: "plugin", since: "t" }]);
  await x.r.tick();
  await x.r.tick();
  assert.deepEqual(x.calls, [], "same timestamp must not count twice");
  x.clock.ms += 13_999;
  await x.r.tick();
  assert.deepEqual(x.calls, []);
  x.clock.ms += 1;
  await x.r.tick();
  assert.deepEqual(x.calls, ["hermes gateway restart"]);
});

test("an unknown observation resets the idle interval", async () => {
  const h = hermes();
  h.state("default", 0);
  const x = setup(h, [{ profile: "default", reason: "plugin", since: "t" }]);
  await x.r.tick();
  fs.writeFileSync(path.join(h.root, "gateway_state.json"), "invalid");
  x.clock.ms += 15_000;
  await x.r.tick();
  assert.equal(x.r.rows()[0].state, "unknown");
  h.state("default", 0);
  await x.r.tick();
  await x.r.tick();
  assert.deepEqual(x.calls, []);
  x.clock.ms += 15_000;
  await x.r.tick();
  assert.equal(x.calls.length, 1);
});

for (const [method, suffix] of [
  ["readdirSync", []],
  ["readdirSync", ["d1"]],
  ["statSync", ["d1", "task-1.log"]],
  ["readFileSync", ["d1", "task-1.log"]],
]) {
  test(`idleState handles missing and unreadable delegation data: ${method} ${suffix.join("/")}`, (t) => {
    const h = hermes();
    h.state("default", 0);
    h.delegation("default", "final | end status=ok");
    const target = path.join(h.root, "cache", "delegation", "live", ...suffix);
    const original = fs[method];
    let code = "EACCES";
    t.mock.method(fs, method, (file, ...args) => {
      if (file === target) throw Object.assign(new Error("denied"), { code });
      return original(file, ...args);
    });
    assert.equal(idleState(h.root, Date.now()), "unknown");
    code = "ENOENT";
    assert.equal(idleState(h.root, Date.now()), "idle");
  });
}

test("overlapping manual restarts share one command and result", async () => {
  const h = hermes();
  const x = setup(h, [{ profile: "default", reason: "plugin", since: "t" }]);
  let release, signalEntered;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  const run = x.r.run;
  let attempts = 0;
  x.r.run = async (...args) => { attempts++; signalEntered(); await gate; return run(...args); };
  const first = x.r.restartNow("default");
  await entered;
  const second = x.r.restartNow("default");
  release();
  const results = await Promise.all([first, second]);
  assert.equal(attempts, 1);
  assert.deepEqual(results, [{ ok: true, state: "restarted" }, { ok: true, state: "restarted" }]);
});

test("an overlapping tick returns immediately while manual restart shares the automatic command", async () => {
  const h = hermes();
  h.state("default", 0);
  h.state("research", 0);
  const x = setup(h, ["default", "research"].map((profile) => ({ profile, reason: "plugin", since: "t" })));
  await x.r.tick();
  x.clock.ms += 15_000;
  let release, signalEntered;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  const run = x.r.run;
  const attempts = [];
  x.r.run = async (cmd, args) => {
    attempts.push(args);
    if (args[0] === "gateway") { signalEntered(); await gate; }
    return run(cmd, args);
  };
  const first = x.r.tick();
  await entered;
  try {
    await x.r.tick();
    assert.equal(attempts.length, 1, "overlapping tick must not process the other profile");
  } finally { release(); }
  const manual = x.r.restartNow("default");
  await Promise.all([first, manual]);
  assert.deepEqual(x.calls, ["hermes gateway restart", "hermes -p research gateway restart"]);
});

for (const sync of [false, true]) {
  test(`a ${sync ? "synchronously throwing" : "rejected"} runner resolves as failed without retrying`, async () => {
    const h = hermes();
    h.state("default", 0);
    const x = setup(h, [{ profile: "default", reason: "plugin", since: "t" }]);
    let attempts = 0;
    x.r.run = () => {
      attempts++;
      if (sync) throw new Error("runner unavailable");
      return Promise.reject(new Error("runner unavailable"));
    };
    const result = await x.r.restartNow("default");
    assert.deepEqual(result, { ok: false, state: "failed", error: "hermes gateway restart failed: runner unavailable" });
    assert.equal(x.r.rows()[0].state, "failed");
    for (let i = 0; i < 3; i++) { x.clock.ms += 15_000; await x.r.tick(); }
    assert.equal(attempts, 1);
  });
}

for (const failed of [false, true]) {
  test(`queue write failure preserves a ${failed ? "failed" : "restarted"} result and prevents retries`, async (t) => {
    const h = hermes();
    h.state("default", 0);
    const entry = { profile: "default", reason: "plugin", since: "t" };
    const x = setup(h, [entry]);
    const rename = fs.renameSync;
    const renameMock = t.mock.method(fs, "renameSync", (from, to) => {
      if (to === x.file) throw new Error("queue denied");
      return rename(from, to);
    });
    const run = x.r.run;
    let attempts = 0;
    x.r.run = async (...args) => {
      attempts++;
      if (failed) throw new Error("runner unavailable");
      return run(...args);
    };
    const result = await x.r.restartNow("default");
    assert.equal(result.state, failed ? "failed" : "restarted");
    assert.match(result.error, /could not update the restart queue: queue denied/);
    if (failed) assert.match(result.error, /hermes gateway restart failed: runner unavailable/);
    assert.equal(x.r.rows()[0].state, result.state);
    assert.equal(x.r.rows()[0].error, result.error);
    assert.deepEqual(JSON.parse(fs.readFileSync(x.file, "utf8")), [entry]);
    for (let i = 0; i < 3; i++) { x.clock.ms += 15_000; await x.r.tick(); }
    await x.r.restartNow("default");
    assert.equal(attempts, 1);
    renameMock.mock.restore();
    fs.writeFileSync(x.file, JSON.stringify([{ ...entry, since: "new update" }]));
    await x.r.restartNow("default");
    assert.equal(attempts, 2, "a new queue entry for the profile remains eligible");
  });
}

test("pending installs block restarts until two idle checks after becoming ready", async () => {
  const h = hermes();
  h.state("default", 0);
  const entry = { profile: "default", reason: "plugin", since: "t", pending: true };
  const x = setup(h, [entry]);
  for (let i = 0; i < 4; i++) {
    await x.r.tick();
    x.clock.ms += 15_000;
  }
  assert.deepEqual(x.calls, []);
  assert.equal(x.r.rows()[0].state, "pending");
  assert.deepEqual(await x.r.restartNow("default"), {
    ok: false, state: "waiting", error: "the plugin install for this profile has not finished",
  });
  assert.deepEqual(x.calls, []);
  fs.writeFileSync(x.file, JSON.stringify([{ ...entry, pending: false }]));
  await x.r.tick();
  assert.deepEqual(x.calls, [], "pending ticks must not count as idle checks");
  x.clock.ms += 15_000;
  await x.r.tick();
  assert.deepEqual(x.calls, ["hermes gateway restart"]);
  assert.equal(x.r.rows()[0].state, "restarted");
});
