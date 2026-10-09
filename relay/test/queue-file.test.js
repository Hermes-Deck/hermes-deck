"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Worker } = require("node:worker_threads");
const { withQueue, readQueue } = require("../src/queue-file");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-queue-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "queue.json");
}

test("withQueue reads the current queue under an exclusive lock and writes a unique temporary file", (t) => {
  const file = fixture(t);
  const writes = [];
  let firstToken;
  const io = { ...fs, writeFileSync: (target, ...args) => { writes.push(target); return fs.writeFileSync(target, ...args); } };
  withQueue(file, (q) => {
    assert.deepEqual(q, []);
    firstToken = fs.readFileSync(`${file}.lock`, "utf8");
    assert.match(firstToken, new RegExp(`^${process.pid}:[a-f0-9]{16}$`));
    return [{ profile: "first" }];
  }, { fs: io, now: () => 123, pid: process.pid });
  assert.equal(fs.existsSync(`${file}.lock`), false);
  withQueue(file, (q) => {
    assert.notEqual(fs.readFileSync(`${file}.lock`, "utf8"), firstToken);
    return [...q, { profile: "second" }];
  });
  assert.deepEqual(readQueue(file), [{ profile: "first" }, { profile: "second" }]);
  assert.ok(writes.includes(`${file}.${process.pid}.123.tmp`));
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("release leaves a replacement holder's lock in place", (t) => {
  const file = fixture(t);
  const replacement = `${process.pid}:fedcba9876543210`;
  withQueue(file, () => {
    fs.writeFileSync(`${file}.lock`, replacement);
    return [{ profile: "first" }];
  });
  assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), replacement);
  assert.deepEqual(readQueue(file), [{ profile: "first" }]);
});

test("stale recovery leaves a lock replaced between observation and re-read", (t) => {
  const file = fixture(t);
  const lock = `${file}.lock`;
  const replacement = `${process.pid}:fedcba9876543210`;
  fs.writeFileSync(lock, `${process.pid}:0123456789abcdef`);
  fs.utimesSync(lock, new Date(0), new Date(0));
  let replaced = false;
  const io = { ...fs, statSync: (target, ...args) => {
    const stat = fs.statSync(target, ...args);
    if (target === lock && !replaced) { fs.writeFileSync(lock, replacement); replaced = true; }
    return stat;
  } };
  let clock = Date.now();
  t.mock.method(Date, "now", () => { clock += 5000; return clock; });
  assert.throws(() => withQueue(file, () => assert.fail("entered a replacement lock"), { fs: io }), /lock.*timed out/);
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(lock, "utf8"), replacement);
  assert.equal(fs.existsSync(file), false);
});

test("undefined leaves the queue unchanged and callback or rename errors release the lock", (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, "[  ]");
  withQueue(file, () => undefined);
  assert.equal(fs.readFileSync(file, "utf8"), "[  ]");
  assert.throws(() => withQueue(file, () => { throw new Error("callback failed"); }), /callback failed/);
  assert.throws(() => withQueue(file, () => [1], { fs: { ...fs, renameSync: () => { throw new Error("rename failed"); } } }), /rename failed/);
  assert.equal(fs.readFileSync(file, "utf8"), "[  ]");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["queue.json"]);
});

test("corrupt queues are preserved under the lock; display reads do not modify them", (t) => {
  const file = fixture(t);
  for (const [i, raw] of ["{bad", "{}", "null"].entries()) {
    fs.writeFileSync(file, raw);
    assert.deepEqual(readQueue(file), []);
    assert.equal(fs.readFileSync(file, "utf8"), raw);
    withQueue(file, (q) => { assert.deepEqual(q, []); return [{ profile: "safe" }]; }, { now: () => i });
    assert.equal(fs.readFileSync(`${file}.corrupt-${i}`, "utf8"), raw);
  }
});

test("non-ENOENT read errors abort without invoking the callback or changing the queue", (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, "[]");
  const io = { ...fs, readFileSync: (target, ...args) => {
    if (target === file) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return fs.readFileSync(target, ...args);
  } };
  assert.throws(() => readQueue(file, { fs: io }), /denied/);
  assert.throws(() => withQueue(file, () => assert.fail("callback ran"), { fs: io }), /denied/);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.equal(fs.readFileSync(file, "utf8"), "[]");
});

for (const stale of [false, true]) {
  test(`recovers a ${stale ? "lock older than 30 seconds" : "dead owner lock"}`, (t) => {
    const file = fixture(t);
    fs.writeFileSync(`${file}.lock`, `${stale ? process.pid : 2147483647}:0123456789abcdef`);
    if (stale) fs.utimesSync(`${file}.lock`, new Date(0), new Date(0));
    withQueue(file, () => ["recovered"]);
    assert.deepEqual(readQueue(file), ["recovered"]);
  });
}

test("a live lock times out without changing its owner or queue", (t) => {
  const file = fixture(t);
  fs.writeFileSync(`${file}.lock`, String(process.pid));
  assert.throws(() => withQueue(file, () => assert.fail("entered a held lock")), /lock.*timed out|timed out.*lock/);
  assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), String(process.pid));
  assert.equal(fs.existsSync(file), false);
});

test("concurrent writers serialize read-modify-write without losing entries", async (t) => {
  const file = fixture(t);
  const modulePath = require.resolve("../src/queue-file");
  await Promise.all(["a", "b", "c"].map((profile) => new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { workerData } = require("node:worker_threads");
      const { withQueue } = require(workerData.modulePath);
      withQueue(workerData.file, (q) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
        return [...q, { profile: workerData.profile }];
      });
    `, { eval: true, workerData: { file, modulePath, profile } });
    worker.once("error", reject);
    worker.once("exit", (code) => code ? reject(new Error(`worker exit ${code}`)) : resolve());
  })));
  assert.deepEqual(readQueue(file).map((q) => q.profile).sort(), ["a", "b", "c"]);
});
