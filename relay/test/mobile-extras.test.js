'use strict';
// Phone-facing relay additions of lane relay-extras: test push (X1), badge (X2), watch (X3), masked-prompt flag (X4),
// searchMessages (X5), profile hue (X6), Live Activity (X7). Fake clock, stub gateway and stub bridges only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MobileRelay, createPair } = require('../src/mobile');

function fakeClock(start = Date.now()) {
  let now = start;
  const clock = () => now;
  clock.advance = ms => { now += ms; };
  return clock;
}
function fixture(t, { bridge = {}, kinds, policy = { scope: 'all' }, now, push = {}, features = [], bridgeConfig = { mode: 'off' }, history = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-extras-')), file = path.join(dir, 'devices.json'), sent = [], logs = [];
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = now || (() => Date.now());
  const gateway = { configured: true, notify: async (target, event) => { sent.push({ target, ...event }); }, removeDevice: async () => {}, setDevice: async () => ({ ok: true }),
    offers: feature => features.includes(feature), refreshFeatures: async () => {}, ...push };
  const mobile = new MobileRelay({ tokensFile: file, settleMs: 0, clock, pushLog: line => logs.push(JSON.parse(line)), bridgeConfig, push: gateway, history });
  t.after(() => mobile.stop());
  const paired = mobile.pair({ code: createPair(file), name: 'phone' }), device = mobile.device(paired.deviceId);
  device.observePush = true;
  if (kinds) device.pushKinds = kinds;
  if (policy) mobile.setPushPolicy(device, policy);
  mobile.persist(device);
  device.bridge = { stop: async () => {}, nodeFor: () => null, listRequests: () => [], status: { status: 'open' }, ...bridge };
  mobile.bridge = () => device.bridge;
  return { mobile, device, sent, logs, file, paired, gateway };
}
const flush = async mobile => { for (let i = 0; i < 6; i++) await mobile.flushPush(); };
async function serve(t, mobile) {
  const { createServer } = require('../src/server');
  const relay = createServer({ token: 'x'.repeat(32), mobile, model: { snapshot: () => ({}), sessions: new Map(), tokens: () => ({}) }, fleet: { data: {} }, version: 'test' });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => relay.server.close(resolve)));
  return `http://127.0.0.1:${relay.server.address().port}`;
}
const bearer = token => ({ authorization: `Bearer ${token}` });

// ---------------------------------------------------------------------------------------------------- X1 test push
test('X1 test push: exempt from the breaker and says so; a v2 registration without `done` gets a kind it has on', async t => {
  const clock = fakeClock();
  const { mobile, device, sent, paired } = fixture(t, { now: clock, kinds: ['approval', 'question'], policy: { scope: 'all', burst: 1 } });
  const url = await serve(t, mobile);
  // A quiet window is running: the breaker holds banners, never the test.
  device.governor.state.sent = 1; device.governor.state.quietUntil = clock() + 600000; device.governor.state.quietMs = 600000;
  const answer = await fetch(`${url}/mobile/push/test`, { method: 'POST', headers: bearer(paired.token) });
  assert.equal(answer.status, 200);
  const body = await answer.json();
  assert.deepEqual([body.ok, body.kind, body.breaker], [true, 'approval', 'exempt']);
  await flush(mobile);
  assert.deepEqual(sent, [{ target: device.id, id: body.id, kind: 'approval' }], 'a kind the registration has on, so the gateway does not discard it');
  const record = await (await fetch(`${url}/mobile/notifications/${body.id}`, { headers: bearer(paired.token) })).json();
  assert.deepEqual([record.test, record.kind, record.sid, record.request], [true, 'approval', undefined, undefined]);
  assert.equal(device.governor.state.sent, 0, 'never counted (and the tap counts as seen)');
});

test('X1 test push: kind `test` when the gateway offers it; every kind off and no `test` -> 409 no_kinds; other device and desktop token refused', async t => {
  const clock = fakeClock();
  const offered = fixture(t, { now: clock, kinds: [], features: ['test', 'collapse'] });
  const url = await serve(t, offered.mobile);
  const answer = await (await fetch(`${url}/mobile/push/test`, { method: 'POST', headers: bearer(offered.paired.token) })).json();
  assert.equal(answer.kind, 'test');
  await flush(offered.mobile);
  assert.equal(offered.sent[0].kind, 'test');
  assert.match(offered.sent[0].collapse, /^[a-f0-9]{32}$/);
  assert.equal(offered.mobile.capabilities().pushPolicy.testKind, true);
  const none = fixture(t, { now: clock, kinds: [] });
  const url2 = await serve(t, none.mobile);
  const refused = await fetch(`${url2}/mobile/push/test`, { method: 'POST', headers: bearer(none.paired.token) });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, 'no_kinds');
  assert.equal(none.device.lastTestPush, 0, 'a refusal does not use up the 30 s slot');
  assert.equal(none.mobile.capabilities().pushPolicy.testKind, false);
  // The relay's desktop token is not a mobile bearer: no test push through it.
  assert.equal((await fetch(`${url2}/mobile/push/test`, { method: 'POST', headers: bearer('x'.repeat(32)) })).status, 401);
  // A second paired phone without push gets 409, never the first phone's banner.
  const other = none.mobile.pair({ code: createPair(none.file), name: 'tablet' });
  assert.equal((await fetch(`${url2}/mobile/push/test`, { method: 'POST', headers: bearer(other.token) })).status, 409);
});

test('X1 push client: `test` only to a gateway that lists it, else `done`; a 400 to it re-reads the features', async () => {
  const { MobilePushClient } = require('../src/mobile-push');
  const bodies = [];
  let features = ['test'];
  const fetchImpl = async (url, options) => {
    const route = new URL(url).pathname;
    if (route === '/health') return { ok: true, status: 200, json: async () => ({ ok: true, features }) };
    const body = JSON.parse(options.body); bodies.push(body);
    if (body.kind === 'test' && !features.includes('test')) return { ok: false, status: 400, json: async () => ({}) };
    return { ok: true, status: 202, json: async () => ({ accepted: true }) };
  };
  const client = new MobilePushClient({ url: 'https://push.example', credential: 'a'.repeat(43), fetch: fetchImpl });
  await client.refreshFeatures(true);
  await client.notify('d1', { id: 'e_1', kind: 'test' });
  assert.equal(bodies.at(-1).kind, 'test');
  features = [];
  await client.refreshFeatures(true);
  await client.notify('d1', { id: 'e_2', kind: 'test' });
  assert.equal(bodies.at(-1).kind, 'done');
});

// ---------------------------------------------------------------------------------------------------------- X2 badge
test('X2 badge: every push carries open approvals + questions to a gateway that offers `badge`; none to an older gateway', async t => {
  const clock = fakeClock();
  const open = [
    { id: 'ap-1', sid: 's1', profile: 'default', kind: 'approval', at: clock(), command: 'make', description: 'Build', choices: ['once', 'deny'] },
    { id: 'q-1', sid: 's2', profile: 'default', kind: 'question', at: clock(), questions: [{ qid: 'a', question: 'Which?', choices: ['x'] }] },
    { id: 'sec-1', sid: 's1', profile: 'default', kind: 'secret', method: 'sudo' },
  ];
  const { mobile, device, sent } = fixture(t, { now: clock, features: ['badge'], bridge: { listRequests: () => open } });
  assert.equal(mobile.capabilities().pushPolicy.badge, true);
  mobile.notify(device, 'requests', open.filter(request => request.kind !== 'secret'));
  await flush(mobile);
  assert.deepEqual(sent.map(event => [event.kind, event.badge]), [['approval', 2], ['question', 2]], 'the masked prompt is never counted');
  assert.equal(device.badgeSent, 2);
  // An older gateway (no `badge` feature): exactly target/id/kind as before.
  const old = fixture(t, { now: clock, bridge: { listRequests: () => open } });
  old.mobile.notify(old.device, 'requests', open.slice(0, 1));
  await flush(old.mobile);
  assert.deepEqual(Object.keys(old.sent[0]).sort(), ['id', 'kind', 'target']);
  assert.equal(old.mobile.capabilities().pushPolicy.badge, false);
  // A bridge that is not open does not know the count: no badge rather than a wrong 0.
  device.bridge.status = { status: 'connecting' };
  mobile.storeDigest(device, { counts: { updates: 1, chats: 1, needsYou: 0 } });
  await flush(mobile);
  assert.equal(sent.at(-1).kind, 'done');
  assert.equal('badge' in sent.at(-1), false);
});

test('X2 badge: answered elsewhere -> one silent badge push with the lower count, settled, rate-limited, never upwards', async t => {
  const clock = fakeClock();
  const open = [
    { id: 'ap-1', sid: 's1', profile: 'default', kind: 'approval', at: clock(), command: 'make', description: 'Build', choices: ['once', 'deny'] },
    { id: 'ap-2', sid: 's2', profile: 'default', kind: 'approval', at: clock(), command: 'test', description: 'Test', choices: ['once', 'deny'] },
  ];
  const { mobile, device, sent, paired } = fixture(t, { now: clock, features: ['badge', 'collapse'], policy: { scope: 'all', burst: 1 }, bridge: { listRequests: () => open } });
  const listeners = {};
  device.bridge.on = (event, fn) => { (listeners[event] ||= []).push(fn); };
  mobile.notify(device, 'requests', [...open]);
  await flush(mobile);
  assert.deepEqual(sent.map(event => event.badge), [2], 'burst 1: the second approval is held by the breaker');
  // Both answered at the desktop: the list empties; nothing until the 2 s settle.
  open.length = 0;
  mobile.badgeCheck(device);
  mobile.govern(device); await flush(mobile);
  assert.equal(sent.length, 1);
  clock.advance(2000); mobile.govern(device); await flush(mobile);
  assert.equal(sent.length, 2);
  assert.deepEqual([sent[1].kind, sent[1].badge], ['badge', 0], 'past the breaker: a badge push shows nothing');
  assert.match(sent[1].collapse, /^[a-f0-9]{32}$/);
  assert.notEqual(sent[1].collapse, sent[0].collapse, 'its own collapse id: it never replaces a chat banner');
  const url = await serve(t, mobile);
  const record = await (await fetch(`${url}/mobile/notifications/${sent[1].id}`, { headers: bearer(paired.token) })).json();
  assert.deepEqual([record.kind, record.badge, record.body, record.sid], ['badge', 0, '', undefined]);
  // A new request raises the count: no badge push upwards (its own banner carries it).
  open.push({ id: 'ap-3', sid: 's3', profile: 'default', kind: 'approval', at: clock(), command: 'ls', description: 'List', choices: ['once', 'deny'] });
  mobile.badgeCheck(device); clock.advance(2000); mobile.govern(device); await flush(mobile);
  assert.equal(sent.filter(event => event.kind === 'badge').length, 1);
  // Rate limit: two drops within 10 s -> the second waits for the interval, and only the newest count is sent.
  device.badgeSent = 3; open.length = 1; clock.advance(10000);
  mobile.badgeCheck(device); clock.advance(2000); mobile.govern(device); await flush(mobile);
  assert.equal(sent.filter(event => event.kind === 'badge').length, 2, 'more than 10 s since the first');
  open.length = 0;
  mobile.badgeCheck(device); clock.advance(2000); mobile.govern(device); await flush(mobile);
  assert.equal(sent.filter(event => event.kind === 'badge').length, 2, 'within 10 s: waits');
  clock.advance(8000); mobile.govern(device); await flush(mobile);
  assert.deepEqual(sent.filter(event => event.kind === 'badge').map(event => event.badge), [0, 1, 0]);
});

test('X2 badge: no correction without a badge-capable gateway or before any push; another device is not touched', async t => {
  const clock = fakeClock();
  const open = [{ id: 'ap-1', sid: 's1', profile: 'default', kind: 'approval', at: clock(), command: 'make', description: 'Build', choices: ['once', 'deny'] }];
  const old = fixture(t, { now: clock, bridge: { listRequests: () => open } });
  old.mobile.notify(old.device, 'requests', [...open]);
  await flush(old.mobile);
  open.length = 0;
  old.mobile.badgeCheck(old.device); clock.advance(5000); old.mobile.govern(old.device); await flush(old.mobile);
  assert.deepEqual(old.sent.map(event => event.kind), ['approval'], 'an older gateway gets no badge event');
  const fresh = fixture(t, { now: clock, features: ['badge'], bridge: { listRequests: () => [] } });
  fresh.mobile.badgeCheck(fresh.device); clock.advance(5000); fresh.mobile.govern(fresh.device); await flush(fresh.mobile);
  assert.deepEqual(fresh.sent, [], 'nothing pushed yet: nothing to correct');
  const second = fresh.mobile.device(fresh.mobile.pair({ code: createPair(fresh.file), name: 'tablet' }).deviceId);
  assert.equal(second.badgeSent, undefined);
});

test('X2 push client: `badge` key and kind only to a gateway that lists `badge`; an older one gets neither', async () => {
  const { MobilePushClient } = require('../src/mobile-push');
  const bodies = [];
  let features = ['badge'];
  const fetchImpl = async (url, options) => {
    if (new URL(url).pathname === '/health') return { ok: true, status: 200, json: async () => ({ ok: true, features }) };
    bodies.push(JSON.parse(options.body));
    return { ok: true, status: 202, json: async () => ({ accepted: true }) };
  };
  const client = new MobilePushClient({ url: 'https://push.example', credential: 'a'.repeat(43), fetch: fetchImpl });
  await client.refreshFeatures(true);
  await client.notify('d1', { id: 'e_1', kind: 'approval', badge: 3 });
  await client.notify('d1', { id: 'e_2', kind: 'badge', badge: 1200 });
  assert.deepEqual(bodies, [{ target: 'd1', id: 'e_1', kind: 'approval', badge: 3 }, { target: 'd1', id: 'e_2', kind: 'badge', badge: 999 }]);
  features = [];
  await client.refreshFeatures(true);
  await client.notify('d1', { id: 'e_3', kind: 'approval', badge: 3 });
  assert.deepEqual((await client.notify('d1', { id: 'e_4', kind: 'badge', badge: 0 })), { skipped: true });
  assert.deepEqual(bodies.slice(2), [{ target: 'd1', id: 'e_3', kind: 'approval' }]);
});
