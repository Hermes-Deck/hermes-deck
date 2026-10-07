"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { diagnose } = require("../tools/desktops-doctor");

test("doctor: under 16 GB with a limit above 0 warns; missing Docker fails; all good passes", () => {
  assert.equal(diagnose({ docker: "missing", image: false, totalMemGB: 64, limit: 1, isolation: true }).ok, false);
  const low = diagnose({ docker: "ready", image: true, totalMemGB: 16, limit: 1, isolation: true });
  assert.equal(low.ok, true);
  assert.ok(low.lines.some((l) => /16 GB/.test(l)));
  assert.equal(diagnose({ docker: "ready", image: true, totalMemGB: 32, limit: 2, isolation: false }).ok, false, "no isolation, no hosting");
});

test("doctor: below 16 GB the limit is 0 and the doctor says why and how to change it", () => {
  const r = diagnose({ docker: "ready", image: true, totalMemGB: 8, limit: 0, isolation: true });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => /less than 16 GB of RAM/.test(l) && /DECK_DESKTOPS_LIMIT/.test(l)), r.lines.join("\n"));
  // an explicit limit on a small machine still hosts, with a warning
  const forced = diagnose({ docker: "ready", image: true, totalMemGB: 8, limit: 1, isolation: true, limitSet: true });
  assert.equal(forced.ok, true);
  assert.ok(forced.lines.some((l) => /less than 16 GB/.test(l)));
});

test("doctor: a missing pinned image fails and the line gives the docker pull command", () => {
  const r = diagnose({ docker: "ready", image: false, totalMemGB: 32, limit: 1, isolation: null, images: ["ghcr.io/trycua/linux@sha256:abc", "alpine@sha256:def"] });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => /docker pull ghcr\.io\/trycua\/linux@sha256:abc/.test(l)), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /docker pull alpine@sha256:def/.test(l)));
});

test("doctor: isolation not set up yet is a note (applied before the first desktop starts), the desktops are listed", () => {
  const r = diagnose({ docker: "ready", image: true, totalMemGB: 32, limit: 2, isolation: null, freeMemGB: 10.5, desktops: [{ profile: "aurora", running: true, port: 41234 }, { profile: "summit", running: false, port: null }] });
  assert.equal(r.ok, true);
  assert.ok(r.lines.some((l) => /not set up yet/.test(l)));
  assert.ok(r.lines.some((l) => /aurora/.test(l) && /running/.test(l)));
  assert.ok(r.lines.some((l) => /summit/.test(l) && /stopped/.test(l)));
  assert.ok(r.lines.some((l) => /10\.5 GB free/.test(l)));
});

test("doctor: Docker installed but not running fails with the next step", () => {
  const r = diagnose({ docker: "stopped", image: false, totalMemGB: 32, limit: 1, isolation: null });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => /not running/.test(l)));
});

// ---- fix round 1 ----
const { EventEmitter } = require("node:events");
// final fix wave I1: one runner for the doctor, the relay and the Deck (app/main/desktop-host.js dockerRunner)
const { dockerRunner } = require("../../app/main/desktop-host");
const timedRunner = (o) => dockerRunner(o);

test("I1 doctor: it has no runner of its own; gather() uses the shared dockerRunner", () => {
  assert.equal(require("../tools/desktops-doctor").timedRunner, undefined);
  const src = require("node:fs").readFileSync(require.resolve("../tools/desktops-doctor"), "utf8");
  assert.match(src, /dockerRunner\(\)/);
  assert.doesNotMatch(src, /spawn\(/);
});

/** A fake child that never exits until kill(): records the kill. */
function hangingSpawn(log) {
  return (bin, argv) => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => { log.push(argv[0]); setImmediate(() => p.emit("close", null)); };
    return p;
  };
}

test("timedRunner: a docker call that never exits is killed and answers code 124 (helper run gets the longer timeout)", async () => {
  const killed = [];
  const run = timedRunner({ spawnFn: hangingSpawn(killed), shortMs: 20, longMs: 20, helperMs: 120 });
  const t0 = Date.now();
  const r = await run(["version"]);
  assert.equal(r.code, 124);
  assert.match(r.stderr, /timed out/);
  assert.ok(Date.now() - t0 < 100, "short timeout, not the helper one");
  const t1 = Date.now();
  const h = await run(["run", "--rm", "x"]);
  assert.equal(h.code, 124);
  assert.ok(Date.now() - t1 >= 100, "the helper run waits longer");
  assert.deepEqual(killed, ["version", "run"]);
});

test("timedRunner: a normal call returns its code and output; a missing binary rejects with ENOENT", async () => {
  const ok = (bin, argv) => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => {};
    setImmediate(() => { p.stdout.emit("data", "27.1\n"); p.emit("close", 0); });
    return p;
  };
  const r = await timedRunner({ spawnFn: ok, shortMs: 1000, helperMs: 1000 })(["version"]);
  assert.deepEqual({ code: r.code, out: r.stdout }, { code: 0, out: "27.1\n" });
  const missing = () => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {}; setImmediate(() => p.emit("error", Object.assign(new Error("nope"), { code: "ENOENT" }))); return p; };
  await assert.rejects(timedRunner({ spawnFn: missing })(["version"]), (e) => e.code === "ENOENT");
});

test("doctor: a docker that does not answer is reported as not responding and fails", () => {
  const r = diagnose({ docker: "unresponsive", image: false, totalMemGB: 32, limit: 1, isolation: null });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => /not responding/.test(l)), r.lines.join("\n"));
});

test("doctor: RAM shows one decimal and never rounds up to 16", () => {
  const r = diagnose({ docker: "ready", image: true, totalMemGB: 15.96, limit: 0, isolation: true });
  assert.ok(r.lines.some((l) => /15\.9 GB RAM/.test(l)), r.lines.join("\n"));
});

test("doctor: a limit set to 0 on a small machine does not say 'unless it is set'", () => {
  const r = diagnose({ docker: "ready", image: true, totalMemGB: 8, limit: 0, limitSet: true, isolation: true });
  assert.equal(r.ok, false);
  assert.ok(!r.lines.some((l) => /unless DECK_DESKTOPS_LIMIT is set/.test(l)), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /DECK_DESKTOPS_LIMIT is set to 0/.test(l)));
});

test("doctor: missing isolation rules say the helper may not have been able to install iptables", () => {
  const r = diagnose({ docker: "ready", image: true, totalMemGB: 32, limit: 1, isolation: false });
  assert.ok(r.lines.some((l) => /helper could not install iptables \(no internet\?\)/.test(l)), r.lines.join("\n"));
});

test("doctor: DECK_DESKTOPS_HOST not 1 is only a note, the exit stays ok", () => {
  const r = diagnose({ docker: "ready", image: true, totalMemGB: 32, limit: 1, isolation: true, hostFlag: false });
  assert.equal(r.ok, true);
  assert.ok(r.lines.some((l) => /DECK_DESKTOPS_HOST is not 1/.test(l)));
});

// ---- fix round 2 ----
test("timedRunner: a child that ignores kill() and never closes still answers 124 (SIGKILL sent, no second answer)", async () => {
  const signals = [];
  const stuck = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = (sig) => { signals.push(sig); }; // like `docker run --rm` whose PID 1 ignores SIGTERM: never closes
    return p;
  };
  const r = await timedRunner({ spawnFn: stuck, shortMs: 20, longMs: 20, helperMs: 20 })(["run", "--rm", "x"]);
  assert.equal(r.code, 124);
  assert.deepEqual(signals, ["SIGKILL"]);
});

test("doctor: when a docker call timed out the doctor says Docker is slow and does not claim missing images or rules", () => {
  const r = diagnose({ docker: "ready", image: false, totalMemGB: 32, limit: 1, isolation: false, slow: true, images: ["a@sha256:1"] });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => /Docker is slow or not answering/.test(l)), r.lines.join("\n"));
  assert.ok(!r.lines.some((l) => /docker pull|images are not here|rules are missing/.test(l)), r.lines.join("\n"));
});
