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

// ---------------------------------------------------------------------------------------------------------- X3 watch
function watchBridge() {
  const calls = [];
  return {
    calls,
    watch: async (sid, options) => { calls.push(['watch', sid, options]); return sid === 'leased' ? { watching: false, error: 'Session is in use by another process' } : { watching: true }; },
    unwatch: (sid, options) => { calls.push(['unwatch', sid, options]); return { watching: false }; },
  };
}
const liveSocket = () => ({ mobileBridge: true, readyState: 1, bufferedAmount: 0, send() {}, terminate() {}, close() {} });

test('X3 watch: read op over the live connection; one session per device; profile required; a refusal says why', async t => {
  const spy = watchBridge();
  const { mobile, device } = fixture(t, { bridge: spy, bridgeConfig: { mode: 'local' } });
  assert.equal(mobile.capabilities().watch, true);
  const call = (op, args, id = `r.${crypto.randomUUID()}`) => mobile.call(device, { id, op, args });
  await assert.rejects(call('watch', { sid: 's1', profile: 'default' }), error => error.code === 'bad_request', 'no live socket: refused');
  device.sockets.add(liveSocket());
  assert.deepEqual(await call('watch', { sid: 's1', profile: 'default' }), { watching: true });
  assert.deepEqual(device.watching, { sid: 's1', profile: 'default' });
  assert.deepEqual(spy.calls[0], ['watch', 's1', { profile: 'default', owner: 'mobile' }]);
  // Watching another session: the bridge's one-per-owner rule replaces the first; the device remembers only the latest.
  assert.deepEqual(await call('watch', { sid: 's2', profile: 'research' }), { watching: true });
  assert.deepEqual(device.watching, { sid: 's2', profile: 'research' });
  assert.ok(spy.calls.every(([, , options]) => options.owner === 'mobile'), 'one owner per device: bounded to one watched session');
  assert.deepEqual(await call('watch', { sid: 'leased', profile: 'default' }), { watching: false, error: 'Session is in use by another process' });
  assert.equal(device.watching, null);
  for (const args of [{ sid: 's1' }, { sid: 's1', profile: '../x' }, { sid: '', profile: 'default' }, { sid: 's1', profile: 'default', extra: 1 }])
    await assert.rejects(call('watch', args), error => error.code === 'bad_request', JSON.stringify(args));
  assert.deepEqual(await call('unwatch', { sid: 's2', profile: 'research' }), { ok: true, watching: false });
  assert.deepEqual(spy.calls.at(-1), ['unwatch', 's2', { profile: 'research', owner: 'mobile' }]);
  // A read: no mutation id needed, nothing burnt; never a stake in the chat (watching is not taking part).
  assert.equal(device.ids.size, 0);
  assert.equal(device.stake.size, 0);
});

test('X3 watch: ends when the last live socket closes; not over HTTP; another device or the desktop token cannot touch it', async t => {
  const { WebSocket } = require('ws');
  const spy = watchBridge();
  const { mobile, device, paired, file } = fixture(t, { bridge: spy, bridgeConfig: { mode: 'local' } });
  const url = await serve(t, mobile);
  const ws = new WebSocket(`${url.replace('http', 'ws')}/mobile/bridge`, { headers: bearer(paired.token) });
  const frames = [];
  ws.on('message', data => frames.push(JSON.parse(data)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ id: 'w.1', op: 'watch', args: { sid: 's1', profile: 'default' } }));
  for (let i = 0; i < 50 && !frames.some(frame => frame.id === 'w.1'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(frames.find(frame => frame.id === 'w.1').result, { watching: true });
  // Over HTTP: not in the allow-list.
  const http = await (await fetch(`${url}/mobile/op`, { method: 'POST', headers: { ...bearer(paired.token), 'content-type': 'application/json' }, body: JSON.stringify({ id: 'w.2', op: 'watch', args: { sid: 's1', profile: 'default' } }) })).json();
  assert.equal(http.error.code, 'operation');
  // The desktop relay token is not a phone: no /mobile/bridge for it.
  const desk = await fetch(`${url}/mobile/op`, { method: 'POST', headers: { ...bearer('x'.repeat(32)), 'content-type': 'application/json' }, body: '{}' });
  assert.equal(desk.status, 401);
  // A second phone's unwatch is its own: the first phone's watch stays.
  const other = mobile.device(mobile.pair({ code: createPair(file), name: 'tablet' }).deviceId);
  other.bridge = device.bridge;
  await mobile.call(other, { id: 'o.1', op: 'unwatch', args: { sid: 's9', profile: 'default' } });
  assert.deepEqual(device.watching, { sid: 's1', profile: 'default' });
  ws.close();
  for (let i = 0; i < 50 && device.watching; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(device.watching, null);
  assert.deepEqual(spy.calls.filter(call => call[1] === 's1').map(call => call[0]), ['watch', 'unwatch']);
});

// ------------------------------------------------------------------------------------------------- X4 masked prompts
function bridgeClass(state) {
  const { EventEmitter } = require('node:events');
  return class FakeBridge extends EventEmitter {
    constructor() { super(); state.instance = this; this.status = { status: 'open' }; this.snapshot = state.snapshot; }
    start() {}
    async stop() {}
    listRequests() { return state.requests; }
    nodeFor(id, profile) { return (state.snapshot?.nodes || []).find(node => (node.sid === id || node.rpcId === id) && node.profile === profile) || null; }
  };
}

test('X4 masked prompt: content-free flag on the snapshot node and a maskedPrompts event; never text, method or kind', async t => {
  const state = { snapshot: { nodes: [{ sid: 's1', rpcId: 'rpc-1', profile: 'default', state: 'working', title: 'Atlas' }, { sid: 's2', profile: 'default', state: 'idle' }] }, requests: [] };
  const { mobile, device } = fixture(t, { bridgeConfig: { mode: 'local' } });
  delete mobile.bridge; device.bridge = null;
  mobile.BridgeClient = bridgeClass(state);
  assert.equal(mobile.capabilities().maskedPrompt, true);
  const frames = [];
  device.sockets.add({ ...liveSocket(), send: text => frames.push(JSON.parse(text)) });
  const bridge = mobile.bridge(device);
  bridge.emit('snapshot', state.snapshot);
  assert.equal(frames.at(-1).data.nodes[0].maskedPrompt, undefined, 'nothing open: the snapshot is passed through untouched');
  assert.equal(frames.at(-1).data, frames.at(-1).data);
  // A sudo prompt opens for s1 (known by its runtime id only) next to an approval.
  state.requests = [
    { id: 'srq-1', kind: 'secret', method: 'sudo', rpcId: 'rpc-1', sid: null, profile: 'default', prompt: 'Password for apt-get install ripgrep' },
    { id: 'srq-2', kind: 'approval', sid: 's2', profile: 'default', command: 'make', choices: ['once', 'deny'] },
  ];
  frames.length = 0;
  bridge.emit('requests', state.requests);
  const masked = frames.find(frame => frame.event === 'maskedPrompts');
  assert.deepEqual(masked.data, [{ sid: 's1', profile: 'default' }]);
  const snap = frames.find(frame => frame.event === 'snapshot');
  assert.deepEqual(snap.data.nodes.map(node => node.maskedPrompt), [true, undefined]);
  assert.deepEqual(frames.find(frame => frame.event === 'requests').data.map(request => request.id), ['srq-2'], 'the prompt itself stays off the phone');
  assert.equal(state.snapshot.nodes[0].maskedPrompt, undefined, 'the bridge snapshot itself is never changed');
  // The same set again: no repeated event; a later snapshot carries the flag.
  frames.length = 0;
  bridge.emit('requests', state.requests);
  assert.equal(frames.filter(frame => frame.event === 'maskedPrompts').length, 0);
  bridge.emit('snapshot', state.snapshot);
  assert.equal(frames.at(-1).data.nodes[0].maskedPrompt, true);
  // Answered on the computer: an empty list, and the flag is gone.
  state.requests = [];
  frames.length = 0;
  bridge.emit('requests', state.requests);
  assert.deepEqual(frames.find(frame => frame.event === 'maskedPrompts').data, []);
  assert.equal(frames.find(frame => frame.event === 'snapshot').data.nodes[0].maskedPrompt, undefined);
  const text = JSON.stringify(frames);
  for (const word of ['sudo', 'ripgrep', 'Password', 'srq-1', '"secret"']) assert.ok(!text.includes(word), word);
});

test('X4 masked prompt: the handshake of a new socket carries the flag; an old client simply ignores both', async t => {
  const { WebSocket } = require('ws');
  const state = { snapshot: { nodes: [{ sid: 's1', profile: 'research', state: 'working' }] }, requests: [{ id: 'srq-9', kind: 'secret', method: 'vault.code', sid: 's1', profile: 'research', hint: '6-digit code' }] };
  const { mobile, paired } = fixture(t, { bridgeConfig: { mode: 'local' } });
  delete mobile.bridge;
  mobile.device(paired.deviceId).bridge = null;
  mobile.BridgeClient = bridgeClass(state);
  const url = await serve(t, mobile);
  const ws = new WebSocket(`${url.replace('http', 'ws')}/mobile/bridge`, { headers: bearer(paired.token) });
  const frames = [];
  ws.on('message', data => frames.push(JSON.parse(data)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  for (let i = 0; i < 50 && !frames.some(frame => frame.event === 'maskedPrompts'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  ws.close();
  assert.deepEqual(frames.map(frame => frame.event || frame.t), ['hello', 'status', 'snapshot', 'requests', 'maskedPrompts']);
  assert.equal(frames[2].data.nodes[0].maskedPrompt, true);
  assert.deepEqual(frames[3].data, []);
  assert.deepEqual(frames[4].data, [{ sid: 's1', profile: 'research' }]);
  assert.ok(!JSON.stringify(frames).includes('6-digit') && !JSON.stringify(frames).includes('vault'));
});
