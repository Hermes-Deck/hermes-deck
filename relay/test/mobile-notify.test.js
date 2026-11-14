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

// A turn of `count` assistant messages `gap` ms apart on a fake clock, sweeps in between, then its end.
async function turn(clock, mobile, device, sid, turnId, { count = 5, gap = 30000, end = 'turn.complete' } = {}) {
  for (let i = 1; i <= count; i++) {
    mobile.notify(device, 'native', reply(sid, `Step ${i} of ${turnId}.`));
    clock.advance(gap); mobile.govern(device); await flush(mobile);
  }
  if (end) mobile.notify(device, 'native', { type: end, sid, profile: 'default', payload: { turn_id: turnId, ...(end === 'turn.error' ? { error: 'Provider refused the request' } : {}) } });
  await flush(mobile);
}
function fakeClock(start = 1_800_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = ms => { now += ms; };
  return clock;
}
const pushedBodies = (device, sent) => sent.map(event => device.notifications.get(event.id)?.body);

test('R11: five messages 30 s apart and the end of the turn are exactly one push with the last message', async t => {
  const clock = fakeClock(), nodes = { s1: { title: 'Chat', turnId: 't1' } };
  const { mobile, device, sent } = fixture(t, { now: clock, policy: { scope: 'all' }, bridge: { nodeFor: sid => nodes[sid] || null } });
  await turn(clock, mobile, device, 's1', 't1');
  assert.deepEqual(sent.map(event => event.kind), ['done']);
  assert.deepEqual(pushedBodies(device, sent), ['Step 5 of t1.']);
  assert.equal(device.notifications.size, 1, 'one record per turn');
  // A second turn is a second push.
  nodes.s1.turnId = 't2';
  await turn(clock, mobile, device, 's1', 't2', { count: 2 });
  assert.deepEqual(sent.map(event => event.kind), ['done', 'done']);
  assert.deepEqual(pushedBodies(device, sent), ['Step 5 of t1.', 'Step 2 of t2.']);
  // The same end seen again through the snapshot is not a third push.
  mobile.notify(device, 'snapshot', { nodes: [{ sid: 's1', profile: 'default', state: 'working', turnId: 't2' }] });
  mobile.notify(device, 'snapshot', { nodes: [{ sid: 's1', profile: 'default', state: 'finished', turnId: 't2' }] });
  await flush(mobile);
  assert.equal(sent.length, 2);
});

test('R11: an old client with every kind on still gets one push per turn; its done is carried as reply when done is off', async t => {
  const clock = fakeClock(), nodes = { s1: { title: 'Chat', turnId: 't1' } };
  const { mobile, device, sent } = fixture(t, { now: clock, kinds: ['reply', 'done', 'approval', 'question', 'error'], bridge: { nodeFor: sid => nodes[sid] || null } });
  mobile.notices.stake(device, 'default', 's1');
  await turn(clock, mobile, device, 's1', 't1');
  assert.deepEqual(sent.map(event => event.kind), ['done']);
  const replyOnly = fixture(t, { now: clock, kinds: ['reply'], bridge: { nodeFor: sid => nodes[sid] || null } });
  replyOnly.mobile.notices.stake(replyOnly.device, 'default', 's1');
  await turn(clock, replyOnly.mobile, replyOnly.device, 's1', 't1');
  assert.deepEqual(replyOnly.sent.map(event => event.kind), ['reply']);
  assert.deepEqual(pushedBodies(replyOnly.device, replyOnly.sent), ['Step 5 of t1.']);
});

test('R11: with reply on in a policy, a turn quiet for 20 s pushes its reply once; its end pushes again only after newer text', async t => {
  const clock = fakeClock(), nodes = { s1: { title: 'Chat', turnId: 't1' } };
  const { mobile, device, sent } = fixture(t, { now: clock, kinds: ['reply', 'done'], policy: { scope: 'all' }, bridge: { nodeFor: sid => nodes[sid] || null } });
  mobile.notify(device, 'native', reply('s1', 'Started.'));
  clock.advance(19000); mobile.govern(device); await flush(mobile);
  assert.equal(sent.length, 0, 'not before 20 s of quiet');
  mobile.notify(device, 'native', reply('s1', 'Still going.'));
  clock.advance(19000); mobile.govern(device); await flush(mobile);
  assert.equal(sent.length, 0, 'each message restarts the quiet period');
  clock.advance(1000); mobile.govern(device); await flush(mobile);
  assert.deepEqual(sent.map(event => event.kind), ['reply']);
  // More messages of the same running turn do not push; its end pushes the last text once.
  await turn(clock, mobile, device, 's1', 't1', { count: 3 });
  assert.deepEqual(sent.map(event => event.kind), ['reply', 'done']);
  assert.equal(pushedBodies(device, sent)[1], 'Step 3 of t1.');
  // A turn whose settle push was its last message ends silently.
  nodes.s1.turnId = 't2';
  mobile.notify(device, 'native', reply('s1', 'Only message.'));
  clock.advance(25000); mobile.govern(device); await flush(mobile);
  mobile.notify(device, 'native', { type: 'turn.complete', sid: 's1', profile: 'default', payload: { turn_id: 't2' } });
  await flush(mobile);
  assert.deepEqual(sent.map(event => event.kind), ['reply', 'done', 'reply']);
});

test('R11: an error ends the turn with its own text; a turn that never ends is dropped after six hours', async t => {
  const clock = fakeClock(), nodes = { s1: { title: 'Chat', turnId: 't1' }, s2: { title: 'Other', turnId: 'u1' } };
  const { mobile, device, sent } = fixture(t, { now: clock, policy: { scope: 'all' }, bridge: { nodeFor: sid => nodes[sid] || null } });
  await turn(clock, mobile, device, 's1', 't1', { count: 2, end: 'turn.error' });
  assert.deepEqual(sent.map(event => event.kind), ['error']);
  assert.deepEqual(pushedBodies(device, sent), ['Provider refused the request']);
  await turn(clock, mobile, device, 's2', 'u1', { count: 1, end: null });
  clock.advance(5 * 3600000); mobile.govern(device); await flush(mobile);
  assert.equal(sent.length, 1);
  const open = [...device.notifications.values()].find(item => item.sid === 's2');
  assert.equal(open.delivery, 'pending');
  clock.advance(3600000); mobile.govern(device); await flush(mobile);
  assert.equal(open.delivery, 'dropped');
  assert.equal(sent.length, 1);
});
