"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DesktopHost, SNAP_SCRIPTS, runClass, dockerRunner } = require("../main/desktop-host");
const pin = { repository: "desktop", digest: "sha256:" + "a".repeat(64), helper: { repository: "helper", digest: "sha256:" + "b".repeat(64) } };
test("F1: listing during ensure or stop never holds the relay or aborts a start", async (t) => {
  const { Desktops } = require("../../relay/src/desktops");
  const { h } = snapRig(t);
  const d = new Desktops({ local: h, localLimit: 1, presence: {} });
  d._rememberSnapshotHost("agent1", "agent-host");
  for (const method of ["_ensure", "_stopRaw"]) {
    const original = h[method];
    let release, entered;
    const gate = new Promise((r) => { release = r; });
    const waiting = new Promise((r) => { entered = r; });
    h[method] = async (...args) => { entered(); await gate; return original.apply(h, args); };
    const operation = method === "_ensure" ? d.resolve("agent1") : d.stop("agent1");
    await waiting;
    try {
      assert.equal((await h.snapshots("agent1")).busy, false);
      assert.equal((await d.snapshots("agent1")).busy, false);
      assert.equal(d.busy("agent1"), false);
    } finally { release(); }
    const result = await operation;
    if (method === "_ensure") assert.equal(result.kind, "space");
    h[method] = original;
  }
  assert.equal((await d.resolve("agent1")).kind, "space");
});
function snapRig(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-snap-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = { exists: true, homeExists: true, running: true, paused: false, bytes: 100, size: 20, calls: [], fail: null, unsupported: false, home: "original", archives: new Map(), corrupt: new Set(), stage: null, ...options };
  const run = async (argv) => {
    const op = Object.entries(SNAP_SCRIPTS || {}).find(([, script]) => argv.includes(script))?.[0] || argv[0];
    s.calls.push({ op, argv });
    if (s.fail && s.fail(op)) return { code: 1, stdout: "", stderr: "private diagnostic" };
    if (op === "container" && !s.exists) return { code: 1, stdout: "", stderr: "No such container" };
    if (op === "volume" && argv[1] === "inspect" && !s.homeExists) return { code: 1, stdout: "", stderr: "No such volume" };
    if (op === "pause" && s.unsupported) return { code: 1, stdout: "", stderr: "pause is not supported" };
    if (op === "unpause" && !s.paused) return { code: 1, stdout: "", stderr: "container is not paused" };
    if (op === "pause") s.paused = true;
    if (op === "unpause") s.paused = false;
    if (op === "stop") { s.running = false; s.paused = false; }
    if (op === "start") s.running = true;
    if (op === "run" && argv.includes("-d")) { s.exists = true; s.running = true; s.homeExists = true; }
    if (op === "pack") { assert.ok(!s.running || s.paused || s.unsupported); s.archives.set(argv.at(-1), s.home); }
    if (op === "drop") s.archives.delete(argv.at(-1));
    if (op === "verify" && (!s.archives.has(argv.at(-1)) || s.corrupt.has(argv.at(-1)))) return { code: 1, stdout: "", stderr: "corrupt archive" };
    if (op === "unpack") s.stage = s.archives.get(argv.at(-1));
    if (op === "install") s.home = s.stage;
    if (op === "rollback") s.home = s.archives.get(argv.at(-1));
    const stdout = op === "container" ? JSON.stringify([{ State: { Running: s.running, Paused: s.paused }, Config: { Image: "desktop@" + pin.digest } }])
      : op === "measure" ? `${Math.ceil(s.bytes / 1024)}\t/home` : op === "pack" ? String(s.size) : "";
    return { code: 0, stdout, stderr: "" };
  };
  const h = new DesktopHost({ run, pin, dataDir: dir });
  h.netEnsure = async () => {};
  h._port = async () => 1;
  return { h, s, dir };
}
test("F4: pending and deleting archives are hidden while retaining internal quota", async (t) => {
  const { h } = snapRig(t);
  const kept = (await h.snapshot("agent1", "stop")).point;
  const run = h.run;
  for (const op of ["pack", "drop"]) {
    let release, entered;
    const gate = new Promise((r) => { release = r; });
    const waiting = new Promise((r) => { entered = r; });
    h.run = async (argv) => { if (argv.includes(SNAP_SCRIPTS[op])) { entered(); await gate; } return run(argv); };
    const task = op === "pack" ? h.snapshot("agent1", "stop") : h.dropSnapshot("agent1", null);
    await waiting;
    try {
      const internal = h._snapMeta("agent1").points;
      assert.ok(internal.some((p) => p.deleting));
      if (op === "pack") assert.ok(internal.some((p) => p.size === 5_000_000_000));
      const listed = await h.snapshots("agent1");
      assert.deepEqual(listed.points, [kept]);
      assert.equal(listed.totalBytes, kept.size);
    } finally { release(); await task; }
  }
});

test("F6: local snapshots and idle stops reach persistent audit without a UI listing", async (t) => {
  const { Desktops } = require("../../relay/src/desktops");
  const { Spaces } = require("../../relay/src/spaces");
  const { SpaceAudit } = require("../../relay/src/space-audit");
  const { h, dir } = snapRig(t);
  const audit = new SpaceAudit({ dataDir: dir, env: {} });
  const d = new Desktops({ local: h, localLimit: 1, presence: {}, idleMs: 0 });
  new Spaces({ desktops: d, audit });
  await d.resolve("agent1");
  await d.sweep();
  await audit.flush();
  const rows = (await audit.page("agent1")).records;
  assert.equal(rows.filter((r) => r.event === "created").length, 1);
  assert.equal(rows.filter((r) => r.event === "stopped").length, 1);
  const point = (await h.snapshots("agent1")).points[0];
  assert.equal(rows.find((r) => r.event === "created").id, point.id);
  const restartedAudit = new SpaceAudit({ dataDir: dir, env: {} });
  new Spaces({ desktops: d, audit: restartedAudit });
  await d.snapshots("agent1");
  await d.snapshots("agent1");
  await restartedAudit.flush();
  assert.equal((await restartedAudit.page("agent1")).records.length, 2);
});

test("archive uses only named volumes, readonly home, pinned offline helper and pause/finally", async (t) => {
  const { h, s } = snapRig(t);
  const r = await h.snapshot("agent1", "before-risky-command");
  assert.equal(r.ok, true); assert.equal(r.point.consistent, true);
  const pack = s.calls.find((x) => x.op === "pack").argv;
  assert.ok(pack.includes("hermes-deck-home-agent1:/home:ro"));
  assert.ok(pack.includes("hermes-deck-snap-agent1:/snap"));
  assert.equal(pack[pack.indexOf("--network") + 1], "none");
  assert.ok(pack.includes("--rm") && pack.includes("--read-only"));
  assert.ok(pack.includes(h.helperImage)); assert.ok(!pack.includes("--privileged"));
  assert.equal(s.paused, false);
  assert.ok(s.calls.findIndex((x) => x.op === "pause") < s.calls.findIndex((x) => x.op === "pack"));
  assert.ok(s.calls.findIndex((x) => x.op === "unpause") > s.calls.findIndex((x) => x.op === "pack"));
  assert.equal(runClass(pack), "archive");
});
test("archive failures unpause, resume failures stop", async (t) => {
  for (const failing of ["measure", "pack", "unpause"]) {
    const { h, s } = snapRig(t, { fail: (op) => op === failing });
    await assert.rejects(h.snapshot("agent1", "stop"), /snapshot failed/);
    assert.equal(s.paused, false, failing);
    if (failing === "unpause") assert.equal(s.running, false);
  }
});
test("unsupported pause keeps the inconsistent snapshot and the desktop running", async (t) => {
  const { h, s } = snapRig(t, { unsupported: true });
  const result = await h.snapshot("agent1", "before-risky-command");
  assert.equal(result.ok, true);
  assert.equal(result.point.consistent, false);
  assert.equal(s.running, true);
  assert.equal(s.paused, false);
  assert.equal(s.calls.some((x) => ["unpause", "stop", "drop"].includes(x.op)), false);
  const listed = await h.snapshots("agent1");
  assert.deepEqual(listed.points, [result.point]);
  assert.equal(listed.notice.event, "unpaused");
});

test("pause failure confirmed not paused does not unpause or stop", async (t) => {
  const { h, s } = snapRig(t, { fail: (op) => op === "pause" });
  await assert.rejects(h.snapshot("agent1", "stop"), /snapshot failed/);
  assert.equal(s.running, true);
  assert.equal(s.calls.some((x) => ["unpause", "stop", "pack"].includes(x.op)), false);
});
test("2 GB skip, keep count, 5 GB cap and explicit deletion", async (t) => {
  const { h, s } = snapRig(t, { bytes: 2_000_000_001 });
  assert.deepEqual(await h.snapshot("agent1", "stop"), { ok: false, reason: "too-large" });
  assert.equal(s.calls.some((x) => x.op === "pack"), false);
  s.bytes = 100;
  for (let i = 0; i < 3; i++) await h.snapshot("agent1", "stop", { keep: 2 });
  assert.equal((await h.snapshots("agent1")).points.length, 2);
  s.size = 1_900_000_000;
  for (let i = 0; i < 4; i++) await h.snapshot("agent1", "stop", { keep: 10 });
  assert.ok((await h.snapshots("agent1")).totalBytes <= 5_000_000_000);
  await h.dropSnapshot("agent1", null);
  assert.equal((await h.snapshots("agent1")).totalBytes, 0);
  await assert.rejects(h.snapshot("../x", "stop"), /bad profile/);
  await assert.rejects(h.dropSnapshot("agent1", "../x"), /bad snapshot/);
});
test("archive timeout waits for helper removal before reporting failure", async () => {
  const { EventEmitter } = require("node:events");
  const children = [];
  const spawnFn = (_bin, argv) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => {}; children.push({ argv, child }); return child;
  };
  const run = dockerRunner({ spawnFn, archiveMs: 5, longMs: 1000, shortMs: 30 });
  let done = false;
  const pending = run(["run", "--rm", "--network", "none", "helper"]).then((r) => { done = true; return r; });
  await new Promise((r) => setTimeout(r, 20));
  const cleanup = children.find((x) => x.argv[0] === "rm");
  assert.ok(cleanup); assert.equal(done, false);
  cleanup.child.emit("close", 0);
  await new Promise((r) => setImmediate(r));
  const inspected = children.find((x) => x.argv[0] === "container");
  if (inspected) {
    assert.deepEqual(inspected.argv, ["container", "inspect", cleanup.argv[2]]);
    assert.equal(done, false);
    inspected.child.stderr.emit("data", "Error: No such container: " + cleanup.argv[2]);
    inspected.child.emit("close", 1);
  }
  const result = await pending;
  assert.ok(inspected, "removal must be confirmed by inspecting the named helper");
  assert.equal(result.code, 124); assert.equal(result.cleanupFailed, false);
});

test("snapshot queue stays busy through deletion and recovers after rejection", async (t) => {
  const { h, s } = snapRig(t);
  const runner = h.run;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  h.run = async (argv) => {
    if (argv.includes(SNAP_SCRIPTS.pack)) await gate;
    return runner(argv);
  };
  const pending = h.snapshot("agent1", "stop");
  const deletion = h.dropSnapshot("agent1", null);
  assert.equal(h.snapshotBusy("agent1"), true);
  assert.equal(h.snapshotBusy("agent2"), false);
  release();
  assert.equal((await h.snapshots("agent1")).busy, true);
  await pending;
  await deletion;
  assert.equal(h.snapshotBusy("agent1"), false);
  assert.equal((await h.snapshots("agent1")).busy, false);
  assert.equal((await h.snapshots("agent1")).points.length, 0);
  assert.ok(s.calls.findIndex((x) => x.op === "pack") < s.calls.findIndex((x) => x.op === "drop"));
  s.fail = (op) => op === "pack";
  const failed = assert.rejects(h.snapshot("agent1", "stop"), /snapshot failed/);
  const next = h.dropSnapshot("agent1", null);
  await failed;
  assert.deepEqual(await next, { ok: true });
  assert.equal(h.snapshotBusy("agent1"), false);
});

test("snapshot metadata survives reconnect, caches keep and bounds callback notices", async (t) => {
  const { h, s, dir } = snapRig(t);
  const notices = [];
  h.onSnapshot = (profile, notice) => {
    assert.equal(profile, "agent1");
    notices.push(notice);
    throw new Error("callback must be isolated");
  };
  await h.snapshot("agent1", "stop", { keep: 1 });
  const last = await h.snapshot("agent1", "before-risky-command");
  s.bytes = 2_000_000_001;
  for (let i = 0; i < 100; i++) await h.snapshot("agent1", "stop");
  const reconnected = new DesktopHost({ run: h.run, pin, dataDir: dir });
  const result = await reconnected.snapshots("agent1");
  assert.deepEqual(result.points, [last.point]);
  assert.equal(result.totalBytes, 20);
  assert.equal(notices.length, 102);
  assert.deepEqual(result.notices, notices.slice(-100));
  assert.deepEqual(result.notice, notices.at(-1));
  assert.equal(result.notice.event, "too-large");
  assert.deepEqual(Object.keys(result.points[0]).sort(), ["consistent", "id", "reason", "size", "time"]);
  assert.deepEqual(Object.keys(result.notice).sort(), ["event", "id", "time"]);
});

test("automatic stop and start snapshots use current retention before cached keep", async (t) => {
  const { h, s } = snapRig(t);
  await h.snapshot("agent1", "stop", { keep: 3 });
  await h.snapshot("agent1", "stop");
  h.opts.snapshotKeep = 1;
  const stopped = await h.stop("agent1");
  assert.deepEqual((await h.snapshots("agent1")).points, [stopped.point]);
  await h.ensure("agent1");
  h.opts.snapshotKeep = 2;
  s.running = false;
  await h.ensure("agent1");
  const points = (await h.snapshots("agent1")).points;
  assert.deepEqual(points.map((p) => p.reason), ["start", "stop"]);
  const explicit = await h.snapshot("agent1", "stop", { keep: 1 });
  assert.deepEqual((await h.snapshots("agent1")).points, [explicit.point]);
  h.opts.snapshotKeep = null;
  const cached = await h.snapshot("agent1", "stop");
  assert.deepEqual((await h.snapshots("agent1")).points, [cached.point]);
});

test("protected points survive pruning, quota failure discards the new archive", async (t) => {
  const { h, s } = snapRig(t, { size: 1_900_000_000 });
  const first = (await h.snapshot("agent1", "stop")).point;
  const second = (await h.snapshot("agent1", "stop")).point;
  await assert.rejects(h.snapshot("agent1", "before-undo", { protect: [first.id, second.id] }), /quota/);
  assert.deepEqual((await h.snapshots("agent1")).points.map((p) => p.id), [second.id, first.id]);
  const third = (await h.snapshot("agent1", "stop", { keep: 2, protect: [first.id] })).point;
  assert.deepEqual((await h.snapshots("agent1")).points.map((p) => p.id), [third.id, first.id]);
  assert.ok(s.calls.some((x) => x.op === "drop" && x.argv.at(-1) === second.id));
  await h.dropSnapshot("agent1", first.id);
  assert.deepEqual((await h.snapshots("agent1")).points, [third]);
});

test("cleanup failure keeps the profile blocked, unpauses and never starts deletion", async (t) => {
  const { h, s, dir } = snapRig(t);
  const runner = h.run;
  h.run = async (argv) => argv.includes(SNAP_SCRIPTS.pack)
    ? { code: 124, stdout: "", stderr: "private diagnostic", cleanupFailed: true } : runner(argv);
  const pending = assert.rejects(h.snapshot("agent1", "stop"), /snapshot failed/);
  const queued = assert.rejects(h.dropSnapshot("agent1", null), /cleanup-failed/);
  await Promise.all([pending, queued]);
  assert.equal(h.snapshotBusy("agent1"), true);
  assert.equal(s.paused, false);
  assert.equal(s.calls.some((x) => x.op === "unpause"), true);
  assert.equal(s.calls.some((x) => x.op === "drop"), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "6167656e7431.snapshots.json"))).dirty, true);
  assert.equal((await h.snapshots("agent1")).notice.event, "cleanup-failed");
  const reconnected = new DesktopHost({ run: h.run, pin, dataDir: dir });
  assert.equal(reconnected.snapshotBusy("agent1"), true);
  assert.equal((await reconnected.snapshots("agent1")).busy, true);
  assert.equal((await reconnected.snapshots("agent1")).recovery, true, "unconfirmed helper cleanup must retain the relay recovery hold");
  const count = s.calls.length;
  for (const host of [h, reconnected]) {
    await assert.rejects(host.ensure("agent1"), /cleanup-failed/);
    await assert.rejects(host.reset("agent1"), /cleanup-failed/);
    await assert.rejects(host.snapshot("agent1", "stop"), /cleanup-failed/);
  }
  assert.equal(s.calls.length, count);
});

test("pause timeout after Docker pauses still restores the original running state", async (t) => {
  for (const rejects of [false, true]) {
    const { h, s } = snapRig(t);
    const runner = h.run;
    h.run = async (argv) => {
      const result = await runner(argv);
      if (argv[0] !== "pause") return result;
      if (rejects) throw new Error("lost CLI");
      return { code: 124, stdout: "", stderr: "timed out" };
    };
    await assert.rejects(h.snapshot("agent1", "stop"), /snapshot failed/);
    assert.equal(s.paused, false);
    assert.equal(s.running, true);
    assert.ok(s.calls.filter((x) => x.op === "container").length >= 2, "ambiguous pause is inspected");
    assert.equal(s.calls.some((x) => x.op === "pack"), false);
  }
});

test("failed unpause checks fallback stop and reports unresolved recovery", async (t) => {
  for (const failedStop of [false, true]) {
    const { h, s } = snapRig(t, { fail: (op) => op === "unpause" || (failedStop && op === "stop") });
    await assert.rejects(h.snapshot("agent1", "stop"), /snapshot failed/);
    assert.equal(s.calls.some((x) => x.op === "stop"), true);
    assert.equal(h.snapshotBusy("agent1"), failedStop);
    assert.equal((await h.snapshots("agent1")).notice.event, failedStop ? "cleanup-failed" : "failed");
    if (!failedStop) assert.equal(s.running, false);
  }
});

test("lost unpause reply confirmed running preserves the snapshot without stopping", async (t) => {
  const { h, s } = snapRig(t);
  const runner = h.run;
  h.run = async (argv) => {
    const r = await runner(argv);
    return argv[0] === "unpause" ? { ...r, code: 124 } : r;
  };
  const result = await h.snapshot("agent1", "stop");
  assert.equal(s.running, true);
  assert.equal(s.paused, false);
  assert.equal(s.calls.some((x) => x.op === "stop"), false);
  assert.deepEqual((await h.snapshots("agent1")).points, [result.point]);
  assert.equal((await h.snapshots("agent1")).notice.event, "created");
});

test("failed pruning and rollback deletion retain all 5.7 GB until a later drop", async (t) => {
  const { h, s, dir } = snapRig(t, { size: 1_900_000_000 });
  await h.snapshot("agent1", "stop");
  await h.snapshot("agent1", "stop");
  s.fail = (op) => op === "drop";
  await assert.rejects(h.snapshot("agent1", "stop"), /quota/);
  assert.equal(s.archives.size, 3);
  assert.equal((await h.snapshots("agent1")).totalBytes, 1_900_000_000);
  assert.equal(h._snapMeta("agent1").points.reduce((n, p) => n + p.size, 0), 5_700_000_000);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "6167656e7431.snapshots.json")));
  assert.equal(meta.points.filter((p) => p.deleting).length, 2);
  await assert.rejects(h.dropSnapshot("agent1", null), /snapshot failed/);
  assert.equal((await h.snapshots("agent1")).totalBytes, 1_900_000_000);
  assert.equal(h._snapMeta("agent1").points.reduce((n, p) => n + p.size, 0), 5_700_000_000);
  s.fail = null;
  await h.dropSnapshot("agent1", null);
  assert.equal(s.archives.size, 0);
  assert.equal((await h.snapshots("agent1")).totalBytes, 0);
});

test("prune retries pending deletions even below quota; failed pack cleanup remains tracked", async (t) => {
  const { h, s, dir } = snapRig(t);
  const first = (await h.snapshot("agent1", "stop")).point;
  s.fail = (op) => op === "drop";
  await assert.rejects(h.dropSnapshot("agent1", first.id), /snapshot failed/);
  s.fail = null;
  await h.snapshot("agent1", "stop");
  assert.equal(s.archives.has(first.id), false);
  const runner = h.run;
  h.run = async (argv) => {
    const r = await runner(argv);
    return argv.includes(SNAP_SCRIPTS.pack) ? { ...r, code: 1 } : r;
  };
  s.fail = (op) => op === "drop";
  await assert.rejects(h.snapshot("agent1", "stop"), /snapshot failed/);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "6167656e7431.snapshots.json")));
  for (const id of s.archives.keys()) assert.ok(meta.points.some((p) => p.id === id), "failed pack stays tracked");
  assert.ok(meta.points.some((p) => p.deleting));
  s.fail = null;
  await h.dropSnapshot("agent1", null);
  assert.equal(s.archives.size, 0);
});

test("unconfirmed restore helper termination forbids rollback and stage cleanup", async (t) => {
  for (const failing of ["unpack", "verify", "install", "rollback"]) {
    const { h, s } = snapRig(t);
    const target = (await h.snapshot("agent1", "stop")).point;
    s.home = "changed";
    s.calls.length = 0;
    const runner = h.run;
    h.run = async (argv) => {
      const r = await runner(argv);
      if (argv.includes(SNAP_SCRIPTS[failing])) return { ...r, code: 124, cleanupFailed: true };
      if (failing === "rollback" && argv.includes(SNAP_SCRIPTS.install)) return { ...r, code: 1 };
      return r;
    };
    await assert.rejects(h.restore("agent1", target.id), /restore failed/);
    assert.equal(h.snapshotBusy("agent1"), true, failing);
    assert.equal((await h.snapshots("agent1")).notice.event, "cleanup-failed");
    assert.equal(s.running, false);
    const last = s.calls.findIndex((x) => x.op === failing);
    assert.equal(s.calls.slice(last + 1).some((x) => ["rollback", "drop"].includes(x.op) || (x.op === "volume" && x.argv[1] === "rm")), false);
  }
});

test("archive runner confirms removal on every ambiguous exit and fails closed on inspect errors", async () => {
  const { EventEmitter } = require("node:events");
  for (const exit of ["timeout", "close", "error"]) {
    for (const state of ["alive", "unavailable", "gone"]) {
      const calls = [];
      const spawnFn = (_bin, argv) => {
        calls.push(argv);
        const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {};
        setImmediate(() => {
          if (argv[0] === "run") {
            if (exit === "close") p.emit("close", 1);
            if (exit === "error") p.emit("error", new Error("CLI disconnected"));
          } else if (argv[0] === "rm") p.emit("close", state === "alive" ? 0 : 1);
          else {
            p.stderr.emit("data", state === "gone" ? "Error: No such container: " + argv[2] : "daemon unavailable");
            p.emit("close", state === "alive" ? 0 : 1);
          }
        });
        return p;
      };
      const run = dockerRunner({ spawnFn, archiveMs: 5, longMs: 30, shortMs: 30 });
      const r = await run(["run", "--rm", "--network", "none", "helper"]).catch(() => ({}));
      assert.equal(r.cleanupFailed, state !== "gone", `${exit}/${state}`);
      const name = calls[0][2];
      assert.deepEqual(calls.slice(1), [["rm", "-f", name], ["container", "inspect", name]]);
    }
  }
});

test("stopped and already paused desktops preserve their state; invalid options run no helpers", async (t) => {
  for (const state of [{ running: false }, { paused: true }]) {
    const { h, s } = snapRig(t, state);
    assert.equal((await h.snapshot("agent1", "start")).point.consistent, true);
    assert.equal(s.calls.some((x) => x.op === "pause" || x.op === "unpause"), false);
  }
  const { h, s } = snapRig(t);
  for (const keep of [0, 101, 1.5, "10"]) await assert.rejects(h.snapshot("agent1", "stop", { keep }), /bad snapshot options/);
  await assert.rejects(h.snapshot("agent1", "invalid"), /bad snapshot options/);
  assert.equal(s.calls.length, 0);
});

test("restore prepares before changing home, takes before-undo and leaves desktop off", async (t) => {
  const { h, s } = snapRig(t);
  const old = (await h.snapshot("agent1", "stop")).point;
  s.home = "changed";
  const r = await h.restore("agent1", old.id, { keep: 1 });
  assert.equal(s.home, "original"); assert.equal(s.running, false);
  const before = (await h.snapshots("agent1")).points.find((x) => x.id === r.before);
  assert.equal(before.reason, "before-undo");
  assert.equal(s.archives.get(before.id), "changed");
  await h.restore("agent1", before.id, { keep: 1 });
  assert.equal(s.home, "changed", "undo itself can be undone");
  assert.equal((await h.snapshots("agent1")).points.length, 1, "repeated undo respects keep=1");
  assert.ok(s.calls.findIndex((x) => x.op === "unpack") < s.calls.findIndex((x) => x.op === "install"));
  const verified = s.calls.findIndex((x) => x.op === "verify");
  assert.ok(verified > s.calls.findIndex((x) => x.op === "pack"));
  assert.ok(verified < s.calls.findIndex((x) => x.op === "install"));
  assert.ok(s.calls[verified].argv.includes("hermes-deck-snap-agent1:/snap:ro"));
  assert.equal(s.calls.some((x) => x.op === "start"), false);
});
test("restore failure matrix preserves old home or before-undo; never restarts", async (t) => {
  for (const failAt of ["unpack", "pack", "install", "rollback"]) {
    const { h, s } = snapRig(t);
    const point = (await h.snapshot("agent1", "stop")).point;
    s.home = "changed";
    s.fail = (op) => {
      if (op === "install") { s.home = "partial"; return failAt === "install" || failAt === "rollback"; }
      return op === failAt;
    };
    await assert.rejects(h.restore("agent1", point.id), /restore failed/);
    assert.equal(s.running, false, failAt);
    assert.equal(s.calls.some((x) => x.op === "start"), false);
    if (failAt === "unpack" || failAt === "pack") assert.equal(s.home, "changed");
    else assert.ok((await h.snapshots("agent1")).points.some((x) => x.reason === "before-undo" && s.archives.get(x.id) === "changed"));
    await assert.rejects(h.ensure("agent1"), /restore recovery required/);
  }
});
test("stop archives, clean start skips, unclean start archives once; reset retains points", async (t) => {
  const { h, s } = snapRig(t);
  await h.stop("agent1");
  assert.equal((await h.snapshots("agent1")).points[0].reason, "stop");
  const n = s.calls.filter((x) => x.op === "pack").length;
  await h.ensure("agent1");
  assert.equal(s.calls.filter((x) => x.op === "pack").length, n);
  s.running = false;
  await h.ensure("agent1");
  assert.equal((await h.snapshots("agent1")).points[0].reason, "start");
  const ids = (await h.snapshots("agent1")).points.map((p) => p.id);
  await h.reset("agent1");
  assert.deepEqual((await h.snapshots("agent1")).points.map((p) => p.id), ids);
  assert.equal(s.calls.some((x) => x.argv[0] === "volume" && x.argv.includes("hermes-deck-snap-agent1")), true);
  assert.equal(s.calls.some((x) => x.argv[0] === "volume" && x.argv[1] === "rm" && x.argv.includes("hermes-deck-snap-agent1")), false);
});
test("archive failure and oversized home do not prevent idle/hosting-off stop", async (t) => {
  for (const options of [{ bytes: 2_000_000_001 }, { fail: (op) => op === "pack" }]) {
    const { h, s } = snapRig(t, options);
    await h.stop("agent1");
    assert.equal(s.running, false);
    assert.ok(["too-large", "failed"].includes((await h.snapshots("agent1")).notice.event));
  }
});

test("lifecycle operations wait for an archive on the same profile", async (t) => {
  for (const operation of ["ensure", "stop", "reset"]) {
    const { h, s } = snapRig(t);
    const runner = h.run;
    let release, entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const packing = new Promise((resolve) => { entered = resolve; });
    h.run = async (argv) => {
      if (argv.includes(SNAP_SCRIPTS.pack)) { entered(); await gate; }
      return runner(argv);
    };
    const archive = h.snapshot("agent1", "stop");
    await packing;
    const count = s.calls.length;
    const pending = h[operation]("agent1");
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(s.calls.length, count, operation);
    } finally {
      release();
      await Promise.all([archive, pending]);
    }
    assert.equal(h.snapshotBusy("agent1"), false);
  }
});

test("failed restore protects its recovery point across reconnect and allows retry", async (t) => {
  const { h, s, dir } = snapRig(t);
  assert.equal((await h.snapshots("agent1")).recovery, false);
  const target = (await h.snapshot("agent1", "stop")).point;
  s.home = "changed";
  s.fail = (op) => op === "install";
  await assert.rejects(h.restore("agent1", target.id), /restore failed/);
  const reconnected = new DesktopHost({ run: h.run, pin, dataDir: dir });
  assert.equal((await reconnected.snapshots("agent1")).recovery, true);
  const before = (await reconnected.snapshots("agent1")).points.find((p) => p.reason === "before-undo");
  await assert.rejects(reconnected.reset("agent1"), /restore recovery required/);
  await assert.rejects(reconnected.ensure("agent1"), /restore recovery required/);
  await assert.rejects(reconnected.dropSnapshot("agent1", before.id), /restore recovery required/);
  await assert.rejects(reconnected.dropSnapshot("agent1", null), /restore recovery required/);
  s.fail = null;
  await reconnected.snapshot("agent1", "stop", { keep: 1 });
  assert.equal(s.archives.get(before.id), "changed");
  await reconnected.restore("agent1", before.id, { keep: 1 });
  assert.equal(s.home, "changed");
  assert.equal(s.running, false);
  assert.equal((await reconnected.snapshots("agent1")).points.length, 1);
  assert.equal((await reconnected.snapshots("agent1")).recovery, false);
});

test("stop returns snapshot outcome, stops before packing and retries archiving after a failed stop point", async (t) => {
  const { h, s } = snapRig(t);
  await h.ensure("agent1");
  s.fail = (op) => op === "pack";
  assert.equal(await h.stop("agent1"), null);
  assert.equal(s.running, false);
  s.fail = null;
  await h.ensure("agent1");
  assert.equal((await h.snapshots("agent1")).points[0].reason, "start");
  const n = s.calls.filter((x) => x.op === "pack").length;
  await h.ensure("agent1");
  assert.equal(s.calls.filter((x) => x.op === "pack").length, n);
  assert.equal((await h.stop("agent1")).point.reason, "stop");
  assert.ok(s.calls.findIndex((x) => x.op === "stop") < s.calls.findIndex((x) => x.op === "pack"));
  s.bytes = 2_000_000_001;
  assert.deepEqual(await h.stop("agent1"), { ok: false, reason: "too-large" });
});

test("failed restore retries and keep=1 stop preserve the original recovery archive", async (t) => {
  const { h, s, dir } = snapRig(t);
  const target = (await h.snapshot("agent1", "stop")).point;
  s.home = "intact pre-restore home";
  s.fail = (op) => {
    if (op === "install") s.home = "partial";
    return op === "install" || op === "rollback";
  };
  await assert.rejects(h.restore("agent1", target.id, { keep: 1 }), /restore failed/);
  const original = (await h.snapshots("agent1")).points.find((p) => p.reason === "before-undo");
  const reconnected = new DesktopHost({ run: h.run, pin, dataDir: dir });
  await assert.rejects(reconnected.restore("agent1", target.id, { keep: 1 }), /restore failed/);
  await reconnected.stop("agent1");
  assert.equal(s.home, "partial");
  assert.equal(s.archives.get(original.id), "intact pre-restore home");
  assert.equal(reconnected._snapMeta("agent1").recoveryPoint, original.id);
  assert.ok((await reconnected.snapshots("agent1")).points.some((p) => p.id === original.id));
  s.fail = null;
  await reconnected.restore("agent1", original.id, { keep: 1 });
  assert.equal(s.home, "intact pre-restore home");
  assert.equal(reconnected._snapMeta("agent1").recovery, false);
});

test("corrupt before-undo archive rejects restore before touching home and reports failure", async (t) => {
  const { h, s } = snapRig(t);
  const target = (await h.snapshot("agent1", "stop")).point;
  s.home = "intact home";
  s.calls.length = 0;
  const runner = h.run;
  h.run = async (argv) => {
    const r = await runner(argv);
    if (argv.includes(SNAP_SCRIPTS.pack)) s.corrupt.add(argv.at(-1)); // pack reports a positive size despite corrupt output
    return r;
  };
  await assert.rejects(h.restore("agent1", target.id), /restore failed/);
  assert.equal(s.home, "intact home");
  assert.equal(s.running, false);
  assert.equal(s.calls.some((x) => x.op === "install" || x.op === "rollback"), false);
  assert.equal((await h.snapshots("agent1")).notice.event, "failed");
});

test("ENOSPC persisting the recovery marker stops first and reports failure without changing home", async (t) => {
  const { h, s } = snapRig(t);
  const target = (await h.snapshot("agent1", "stop")).point;
  s.home = "intact home";
  s.calls.length = 0;
  const notices = [];
  h.onSnapshot = (_profile, notice) => notices.push(notice.event);
  const write = fs.writeFileSync;
  let runningAtWrite;
  t.mock.method(fs, "writeFileSync", (file, data, options) => {
    if (file === h._snapFile("agent1") + ".tmp") {
      runningAtWrite ??= s.running;
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }
    return write(file, data, options);
  });
  await assert.rejects(h.restore("agent1", target.id), /restore failed/);
  assert.equal(runningAtWrite, false);
  assert.equal(s.running, false);
  assert.equal(s.home, "intact home");
  assert.equal(s.calls.some((x) => ["pack", "unpack", "install", "rollback"].includes(x.op)), false);
  assert.deepEqual(notices, ["failed"]);
});

test("dirty home surviving an absent container is archived before recreation only if the volume exists", async (t) => {
  for (const homeExists of [true, false]) {
    const { h, s } = snapRig(t);
    await h.ensure("agent1");
    s.exists = false; s.running = false; s.homeExists = homeExists;
    s.home = "interrupted recreation";
    s.calls.length = 0;
    await h.ensure("agent1");
    const points = (await h.snapshots("agent1")).points;
    assert.equal(points.length, homeExists ? 1 : 0);
    assert.ok(s.calls.some((x) => x.argv.join(" ") === "volume inspect hermes-deck-home-agent1"));
    if (homeExists) {
      assert.equal(points[0].reason, "start");
      assert.equal(s.archives.get(points[0].id), "interrupted recreation");
      assert.ok(s.calls.findIndex((x) => x.op === "pack") < s.calls.findIndex((x) => x.argv.includes("-d")));
    }
    await h.ensure("agent1");
    assert.equal((await h.snapshots("agent1")).points.length, points.length);
  }
});

test("dirty missing-container recovery refuses to start when volume inspection is uncertain", async (t) => {
  const { h, s } = snapRig(t);
  await h.ensure("agent1");
  s.exists = false; s.running = false;
  s.calls.length = 0;
  s.fail = (op) => op === "volume";
  await assert.rejects(h.ensure("agent1"), /snapshot failed/);
  assert.equal(s.calls.some((x) => x.op === "start" || x.argv.includes("-d")), false);
});
