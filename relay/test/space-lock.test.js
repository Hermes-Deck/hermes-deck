"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { SpaceLock } = require("../src/space-lock");

function clock(t0 = 1_000_000) {
  const c = { t: t0 };
  c.now = () => c.t;
  return c;
}

test("first caller takes the lock; the same profile keeps it", () => {
  const c = clock();
  const l = new SpaceLock({ now: c.now });
  assert.deepEqual(l.request("aurora"), { ok: true });
  assert.deepEqual(l.request("aurora"), { ok: true });
  assert.deepEqual(l.state(), { holder: "aurora", user: false, queue: [] });
});

test("two callers at once: one holds, the other queues FIFO with its position", () => {
  const c = clock();
  const l = new SpaceLock({ now: c.now });
  l.request("aurora");
  const b = l.request("pioneer");
  assert.equal(b.ok, false);
  assert.equal(b.busy, true);
  assert.equal(b.holder, "aurora");
  assert.equal(b.position, 1);
  assert.equal(l.request("default").position, 2);
  assert.equal(l.request("pioneer").position, 1, "asking again keeps the place");
  assert.deepEqual(l.state().queue, ["pioneer", "default"]);
});

test("release hands the lock to the head of the queue on its next request", () => {
  const c = clock();
  const l = new SpaceLock({ now: c.now });
  l.request("aurora");
  l.request("pioneer");
  l.request("default");
  assert.equal(l.release("aurora"), true);
  assert.equal(l.request("default").busy, true, "not the head: still waits");
  assert.deepEqual(l.request("pioneer"), { ok: true });
  assert.deepEqual(l.state(), { holder: "pioneer", user: false, queue: ["default"] });
});

test("a holder idle for 90 s loses the lock (a turn that crashed without turn_end)", () => {
  const c = clock();
  const l = new SpaceLock({ now: c.now });
  l.request("aurora");
  c.t += 89_000;
  l.sweep();
  assert.equal(l.state().holder, "aurora");
  c.t += 2_000;
  l.sweep();
  assert.equal(l.state().holder, null);
  assert.deepEqual(l.request("pioneer"), { ok: true });
});

test("a queued caller times out after 120 s and leaves the queue", () => {
  const c = clock();
  const l = new SpaceLock({ now: c.now, holdMs: 10 * 60_000 });
  l.request("aurora");
  l.request("pioneer");
  c.t += 60_000;
  l.request("aurora"); // keeps the holder fresh
  c.t += 61_000;
  const r = l.request("pioneer");
  assert.equal(r.ok, false);
  assert.equal(r.timeout, true);
  assert.equal(r.holder, "aurora");
  assert.deepEqual(l.state().queue, []);
});

test("a queue entry nobody asks for again for 15 s is dropped (the agent gave up)", () => {
  const c = clock();
  const l = new SpaceLock({ now: c.now });
  l.request("aurora");
  l.request("pioneer");
  c.t += 16_000;
  l.request("aurora");
  l.sweep();
  assert.deepEqual(l.state().queue, []);
});

test("user full control: agents fail fast; release returns to the previous holder first", () => {
  const c = clock();
  const l = new SpaceLock({ now: c.now });
  l.request("aurora");
  l.request("pioneer");
  assert.deepEqual(l.takeUser(), { ok: true, previous: "aurora" });
  const r = l.request("aurora");
  assert.equal(r.ok, false);
  assert.equal(r.holder, "user");
  assert.deepEqual(l.releaseUser(), { ok: true, next: "aurora" });
  assert.deepEqual(l.request("aurora"), { ok: true });
});

test("user release with the previous holder gone hands to the queue head", () => {
  const c = clock();
  const l = new SpaceLock({ now: c.now });
  l.request("aurora");
  l.request("pioneer");
  l.takeUser();
  l.release("aurora"); // its turn ended meanwhile
  assert.deepEqual(l.releaseUser(), { ok: true, next: "pioneer" });
  assert.deepEqual(l.request("pioneer"), { ok: true });
});
