'use strict';
// relay-wire lane: typed errors, the per-device gate, reads that never resume, the op log, replay, POST /mobile/op, start.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MobileRelay, createPair } = require('../src/mobile');
const { wireError } = require('../src/mobile-gate');
const { BridgeClient } = require('../../app/main/bridge');
const { t: i18nText } = require('../../app/renderer/i18n');

const mutationID = (time = Date.now()) => `m.${time}.${crypto.randomUUID()}`;
const SENTENCES = ['U0030', 'U0031', 'U0032', 'U0033', 'U0034', 'U0035', 'U0036'].map(key => i18nText(key));

/** A relay with a paired device whose bridge is the given stub (no child process). */
function relayWith(t, stub = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-wire-')), file = path.join(dir, 'devices.json');
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'local' } });
  const logs = [];
  if (mobile.oplog) mobile.oplog.sink = line => logs.push(JSON.parse(line));
  t.after(() => mobile.stop());
  const paired = mobile.pair({ code: createPair(file), name: 'phone' }), device = mobile.device(paired.deviceId);
  device.bridge = { status: { status: 'open' }, pending: new Map(), stop: async () => {}, listRequests: () => [], ...stub };
  return { mobile, device, paired, file, logs };
}
const outcome = promise => promise.then(result => ({ ok: true, result }), error => ({ ok: false, error: wireError(error) }));

/** A BridgeClient with a fake open connection whose writes go nowhere (requests never answer unless settled). */
function openClient(timing = {}) {
  const c = new BridgeClient({ mode: 'off' }, { timing: { request: 15000, ...timing } });
  const written = [];
  c.conn = { ready: true, closed: false, timers: {}, child: { stdin: { writableLength: 0, write: line => { written.push(JSON.parse(line)); return true; } } } };
  c.epoch = 1; c.stopped = false;
  return { c, written };
}

test('W1: every bridge transport error carries a stable kind and maps to a typed code, never a sentence', async () => {
  const offline = new BridgeClient({ mode: 'off' });
  const seen = {};
  seen.offline = await outcome(offline.request('session.list', { limit: 1 }));
  const full = openClient();
  for (let i = 0; i < 64; i++) full.c.pending.set(`x-${i}`, { resolve() {}, reject() {}, timer: null });
  seen.busy = await outcome(full.c.request('session.list', { limit: 1 }));
  const slow = openClient({ request: 20 });
  seen.timeout = await outcome(slow.c.request('session.list', { limit: 1 }));
  const dropped = openClient();
  const lost = dropped.c.request('session.list', { limit: 1 });
  dropped.c._failPending(i18nText('U0032'));
  seen.lost = await outcome(lost);
  const settled = openClient();
  const host = settled.c.request('session.list', { limit: 1 });
  settled.c._settle({ id: settled.written[0].id, error: 'Persisted session not found', rpcCode: 4007 });
  seen.host = await outcome(host);
  const unsupported = openClient();
  const missing = unsupported.c.request('session.list', { limit: 1 });
  unsupported.c._settle({ id: unsupported.written[0].id, error: 'Unsupported Hermes Deck control', rpcCode: -32601 });
  seen.unsupported = await outcome(missing);
  seen.invalid = await outcome(openClient().c.history('bad sid with spaces', { profile: 'default' }));
  seen.notOpen = await outcome(openClient().c.answerApproval('nope', 'once', { profile: 'default' }));

  assert.deepEqual(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, [v.error.code, v.error.uncertain]])), {
    offline: ['offline', false], busy: ['busy', false], timeout: ['timeout', true], lost: ['timeout', true],
    host: ['host', true], unsupported: ['host', false], invalid: ['bad_request', false], notOpen: ['stale', false],
  });
  assert.equal(seen.busy.error.retryAfterMs > 0, true);
  assert.equal(seen.lost.error.reason, 'lost');
  assert.equal(seen.host.error.rpcCode, 4007);
  assert.equal(seen.unsupported.error.rpcCode, -32601);
  for (const value of Object.values(seen)) {
    assert.notEqual(value.error.code, 'bridge_error');
    assert.ok(!SENTENCES.includes(value.error.code));
    assert.equal(typeof value.error.message, 'string'); // kept for logs
  }
  // the desktop's sentences are unchanged
  assert.equal(seen.busy.error.message, i18nText('U0034'));
  assert.equal(seen.offline.error.message, i18nText('U0030'));
});

test('W1: relay responses use the typed codes and advertise errors v2; relay codes keep their meaning', async t => {
  const { mobile, device } = relayWith(t, {
    sessions: async () => { throw Object.assign(new Error(i18nText('U0034')), { kind: 'busy' }); },
    profiles: async () => { throw new Error('something unexpected'); },
    sessionIndex: async () => ({ rows: [], legacy: false, at: 1, profiles: [{ name: 'default', ok: true, hasMore: false, error: '' }, { name: 'atlas', ok: false, hasMore: false, error: i18nText('U0031'), code: 'timeout' }] }),
  });
  assert.deepEqual(mobile.capabilities().errors, { v: 2 });
  const busy = await outcome(mobile.call(device, { id: 'r1', op: 'sessions' }));
  assert.equal(busy.error.code, 'busy'); assert.equal(busy.error.uncertain, false);
  const unknown = await outcome(mobile.call(device, { id: 'r2', op: 'profiles' }));
  assert.equal(unknown.error.code, 'host'); assert.equal(unknown.error.uncertain, true);
  const index = await mobile.call(device, { id: 'r3', op: 'sessionIndex' });
  assert.equal(index.profiles[1].error, 'timeout');
  assert.equal(index.profiles[0].error, '');
  const bad = await outcome(mobile.call(device, { id: 'r4', op: 'sessions', args: { nope: 1 } }));
  assert.deepEqual([bad.error.code, bad.error.uncertain], ['bad_request', false]);
  const expired = await outcome(mobile.call(device, { id: mutationID(Date.now() - 8 * 86400000), op: 'create' }));
  assert.deepEqual([expired.error.code, expired.error.uncertain], ['expired_request', true]);
});

test('W2: a never-answering bridge and 200 reads from one device: at most 8 reach the bridge, the rest are busy', async t => {
  const { c } = openClient({ request: 60000 });
  const { mobile, device } = relayWith(t);
  mobile.gateOptions = { limit: 8, queue: 32, waitMs: 60 };
  device.bridge = c;
  let peak = 0;
  const original = c.request.bind(c);
  c.request = (method, params) => { const p = original(method, params); peak = Math.max(peak, c.pending.size); return p; };
  const answers = await Promise.all(Array.from({ length: 200 }, (_, i) => outcome(Promise.race([
    mobile.call(device, { id: `read-${i}`, op: 'sessions', args: { limit: i + 1 } }),
    new Promise(resolve => setTimeout(() => resolve('still running'), 300)),
  ]))));
  assert.equal(peak, 8);
  const busy = answers.filter(a => !a.ok && a.error.code === 'busy');
  assert.equal(busy.length, 192);
  assert.ok(busy.every(a => a.error.retryAfterMs > 0 && a.error.uncertain === false));
  assert.equal(answers.filter(a => a.ok && a.result === 'still running').length, 8);
  assert.ok(!JSON.stringify(answers.map(a => a.error?.code)).includes(i18nText('U0034')));
  assert.ok(!answers.some(a => !a.ok && a.error.message === i18nText('U0034')));
  c.stop();
});

test('W2: identical concurrent reads share one bridge call; a queued-out mutation keeps its ID usable', async t => {
  let historyCalls = 0, release;
  const { mobile, device } = relayWith(t, {
    history: () => { historyCalls++; return new Promise(resolve => { release = () => resolve({ messages: [{ role: 'assistant', text: 'x' }] }); }); },
  });
  const reads = Array.from({ length: 5 }, (_, i) => mobile.call(device, { id: `h-${i}`, op: 'history', args: { sid: 'session-a', profile: 'atlas' } }));
  await new Promise(resolve => setImmediate(resolve));
  release();
  const results = await Promise.all(reads);
  assert.equal(historyCalls, 1);
  assert.equal(results.length, 5);
  // the gate full of slow mutations: a queued one times out as busy and its ID is not burnt
  const alive = setInterval(() => {}, 5); t.after(() => clearInterval(alive)); // gate wait timers are unref'd
  const fresh = relayWith(t, { create: () => new Promise(() => {}) });
  fresh.mobile.gateOptions = { limit: 1, queue: 1, waitMs: 20 };
  fresh.mobile.call(fresh.device, { id: mutationID(), op: 'create', args: { profile: 'atlas' } }).catch(() => {});
  const id = mutationID();
  const queued = await outcome(fresh.mobile.call(fresh.device, { id, op: 'create', args: { profile: 'atlas' } }));
  assert.deepEqual([queued.error.code, queued.error.uncertain], ['busy', false]);
  assert.equal(fresh.device.ids.has(id), false);
});

test('W2: the relay\'s own background requests use a separate budget of 2; phone ops are not counted there', async () => {
  const { withBackgroundBudget, foreground } = require('../src/mobile-gate');
  const Gated = withBackgroundBudget(BridgeClient);
  const c = new Gated({ mode: 'off' }, { timing: { request: 60000 } });
  c.conn = { ready: true, closed: false, timers: {}, child: { stdin: { writableLength: 0, write: () => true } } };
  c.epoch = 1; c.stopped = false;
  const background = Array.from({ length: 10 }, () => c.request('session.list', { limit: 1 }).catch(e => e));
  assert.equal(c.pending.size, 2);
  const phone = Array.from({ length: 5 }, () => foreground(() => c.request('session.list', { limit: 1 })).catch(e => e));
  assert.equal(c.pending.size, 7);
  c.stop();
  const errors = await Promise.all([...background, ...phone]);
  assert.equal(errors.length, 15);
});

test('W3: phone reads of an unbound session never resume it; capability readsNeverResume', async t => {
  const { c, written } = openClient();
  const { mobile, device } = relayWith(t);
  device.bridge = c;
  assert.equal(mobile.capabilities().readsNeverResume, true);
  const reads = await Promise.all(Array.from({ length: 10 }, (_, i) => mobile.call(device, { id: `sa-${i}`, op: 'subagents', args: { sid: 'session-a', profile: 'atlas' } })));
  assert.ok(reads.every(r => r.available === false));
  const tail = await mobile.call(device, { id: 'tail', op: 'subagentTail', args: { sid: 'session-a', profile: 'atlas', id: 'sub-1' } });
  assert.equal(tail.available, false);
  const options = mobile.call(device, { id: 'mo', op: 'modelOptions', args: { sid: 'session-a', profile: 'atlas' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(written.map(frame => frame.method), ['model.options']);
  assert.equal(written[0].params.session_id, undefined);
  c._settle({ id: written[0].id, result: { providers: [] } });
  await options;
  const { withBackgroundBudget } = require('../src/mobile-gate');
  assert.equal(new (withBackgroundBudget(BridgeClient))({ mode: 'off' }).keepStaleIndex, true);
  c.stop();
});
