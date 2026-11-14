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
