'use strict';
// Phone notifications through MobileRelay: kinds (R14), one banner per turn (R11), scope (R12/D13), the breaker (D9),
// seen, policy, collapse/digest, the notification record and the test push. Fake clock and stub gateway only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MobileRelay, createPair } = require('../src/mobile');

function fixture(t, { bridge = {}, kinds, policy, settleMs = 0, now, push = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-notify-')), file = path.join(dir, 'devices.json'), sent = [], logs = [];
  const clock = now || (() => Date.now());
  const mobile = new MobileRelay({ tokensFile: file, settleMs, clock, pushLog: line => logs.push(JSON.parse(line)), bridgeConfig: { mode: 'off' },
    push: { configured: true, notify: async (target, event) => { sent.push({ target, ...event }); }, removeDevice: async () => {}, setDevice: async () => ({ ok: true }), ...push } });
  t.after(() => mobile.stop());
  const paired = mobile.pair({ code: createPair(file), name: 'phone' }), device = mobile.device(paired.deviceId);
  device.observePush = true;
  if (kinds) device.pushKinds = kinds;
  if (policy) mobile.setPushPolicy(device, policy);
  mobile.persist(device);
  device.bridge = { stop: async () => {}, nodeFor: () => null, listRequests: () => [], ...bridge };
  return { mobile, device, sent, logs, file, paired };
}
const flush = async mobile => { for (let i = 0; i < 6; i++) await mobile.flushPush(); };
const reply = (sid, text, extra = {}) => ({ type: 'message.complete', sid, profile: 'default', payload: { text, ...extra } });

test('R14: a device that never sent kinds gets no banner per assistant message, only the finished turn', async t => {
  const { mobile, device, sent } = fixture(t, { policy: { scope: 'all' }, bridge: { nodeFor: () => ({ title: 'Chat', turnId: 't1' }) } });
  assert.equal(device.pushKinds, null);
  mobile.notify(device, 'native', reply('s1', 'Working on it.'));
  await flush(mobile);
  assert.deepEqual(sent, [], 'a message.complete alone produces no push');
  mobile.notify(device, 'native', { type: 'turn.complete', sid: 's1', profile: 'default', payload: { turn_id: 't1' } });
  await flush(mobile);
  assert.deepEqual(sent.map(event => event.kind), ['done']);
  assert.equal([...device.notifications.values()][0].body, 'Working on it.');
  // A stored list wins, also one that names reply.
  const other = fixture(t, { kinds: ['reply'], policy: { scope: 'all' } });
  assert.equal(other.mobile.kindEnabled(other.device, 'reply'), true);
  assert.equal(other.mobile.kindEnabled(other.device, 'done'), false);
});
