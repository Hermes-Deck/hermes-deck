'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Gate, shareKey, wireError } = require('../src/mobile-gate');

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('gate: limit in flight, FIFO queue with a wait limit, refusals are busy and certain', async () => {
  const gate = new Gate({ limit: 2, queue: 2, waitMs: 40 });
  const jobs = [deferred(), deferred(), deferred(), deferred()];
  let running = 0, peak = 0;
  const order = [];
  const work = (i) => async () => { running++; peak = Math.max(peak, running); order.push(i); try { return await jobs[i].promise; } finally { running--; } };
  const runs = jobs.map((_, i) => gate.run(work(i)));
  assert.equal(gate.admits(null), false);
  await assert.rejects(gate.run(work(0)), e => wireError(e).code === 'busy' && wireError(e).uncertain === false && e.gate === 'full');
  await tick();
  assert.deepEqual(order, [0, 1]);
  jobs[1].resolve('b');
  await tick(); await tick();
  assert.deepEqual(order, [0, 1, 2]); // the freed slot went to the oldest waiter
  const late = gate.run(async () => 'late'); // queued behind 3
  jobs[0].resolve('a'); jobs[2].resolve('c');
  await tick(); await tick();
  jobs[3].resolve('d');
  assert.deepEqual(await Promise.all([...runs, late]), ['a', 'b', 'c', 'd', 'late']);
  assert.equal(peak, 2);
  assert.deepEqual(gate.size, { active: 0, waiting: 0, shared: 0 });
});

test('gate: a queued call that waits too long fails busy (queued) and frees its place', async () => {
  const gate = new Gate({ limit: 1, queue: 1, waitMs: 20 });
  const alive = setInterval(() => {}, 5); // the gate's wait timer is unref'd (it never holds the relay open)
  const hold = deferred();
  const first = gate.run(() => hold.promise);
  const queued = gate.run(async () => 'never');
  await assert.rejects(queued, e => e.kind === 'busy' && e.gate === 'queued' && wireError(e).retryAfterMs > 0);
  assert.equal(gate.size.waiting, 0);
  hold.resolve(1);
  assert.equal(await first, 1);
  assert.equal(await gate.run(async () => 2), 2);
  clearInterval(alive);
});

test('gate: identical keys share one call, also when it fails; different args do not', async () => {
  const gate = new Gate({ limit: 8 });
  let calls = 0;
  const hold = deferred();
  const fn = () => { calls++; return hold.promise; };
  const key = shareKey('history', { sid: 's', limit: 40, profile: 'atlas' });
  assert.equal(key, shareKey('history', { profile: 'atlas', limit: 40, sid: 's' }));
  const all = Array.from({ length: 5 }, () => gate.run(fn, key));
  const other = gate.run(async () => { calls++; return 'other'; }, shareKey('history', { sid: 't' }));
  hold.reject(new Error('boom'));
  for (const run of all) await assert.rejects(run, /boom/);
  assert.equal(await other, 'other');
  assert.equal(calls, 2);
  await tick();
  assert.equal(gate.size.shared, 0);
});
