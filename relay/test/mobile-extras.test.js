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

// ---------------------------------------------------------------------------------------------- X5 searchMessages
function searchRoot(t, { many = 0 } = {}) {
  const sqlite = require('node:sqlite');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mk = file => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new sqlite.DatabaseSync(file);
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at REAL NOT NULL, title TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
        tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, reasoning TEXT, active INTEGER NOT NULL DEFAULT 1);`);
    return db;
  };
  const a = mk(path.join(root, 'state.db'));
  a.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run('s-a', 'cli', 100, 'Deploy notes');
  const add = (db, sid, role, content, ts, active = 1) => db.prepare('INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?,?,?,?,?)').run(sid, role, content, ts, active);
  add(a, 's-a', 'user', 'Please check the Nginx config before the deploy', 101);
  add(a, 's-a', 'assistant', 'The nginx config is fine; the token is sk-abcdefghijklmnopqrstuvwxyz0123456789 and NGINX reloads cleanly.', 102);
  add(a, 's-a', 'tool', 'nginx -t output', 103);
  add(a, 's-a', 'user', 'old rewound nginx question', 104, 0);
  add(a, 's-a', 'user', 'İstanbul sunucusu için ŞİFRE değil, nginx ayarı', 105);
  for (let i = 0; i < many; i++) add(a, 's-a', 'assistant', `filler ${i}`, 106 + i / 1e6);
  a.close();
  const r = mk(path.join(root, 'profiles', 'research', 'state.db'));
  r.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run('s-r', 'cli', 200, 'Paper');
  add(r, 's-r', 'user', 'nginx 100% done_now_ok', 150);
  r.close();
  return root;
}

test('X5 searchMessages: case-insensitive text search of user and assistant messages, redacted snippets with ranges, newest first', async t => {
  const { History } = require('../src/history');
  const history = new History({ hermesRoot: searchRoot(t) });
  t.after(() => history.close?.());
  const { mobile, device } = fixture(t, { history });
  const caps = mobile.capabilities().searchMessages;
  assert.deepEqual(caps, { v: 1, scanRows: 60000, maxLimit: 50 });
  const call = args => mobile.call(device, { id: `r.${crypto.randomUUID()}`, op: 'searchMessages', args });
  const all = await call({ q: 'nginx' });
  assert.deepEqual(all.results.map(result => result.id), ['h:research:1', 'h:default:5', 'h:default:2', 'h:default:1']);
  assert.equal(all.next, null);
  assert.equal(all.partial, false);
  const hit = all.results.find(result => result.id === 'h:default:2');
  assert.deepEqual([hit.profile, hit.sid, hit.title, hit.role, hit.ts], ['default', 's-a', 'Deploy notes', 'assistant', 102]);
  assert.ok(!hit.snippet.includes('sk-abcdefghij'), 'a secret in the message is redacted in the snippet');
  assert.deepEqual(hit.ranges.map(([from, to]) => hit.snippet.slice(from, to).toLowerCase()), ['nginx', 'nginx']);
  for (const result of all.results) for (const [from, to] of result.ranges) assert.equal(result.snippet.slice(from, to).toLowerCase(), 'nginx');
  assert.ok(!all.results.some(result => result.snippet.includes('rewound') || result.snippet.includes('-t output')), 'no rewound or tool rows');
  // Turkish capitals: İSTANBUL -> İstanbul; LIKE wildcards in the query are literal.
  for (const q of ['istanbul', 'İSTANBUL', 'İstanbul', 'şifre']) assert.deepEqual((await call({ q })).results.map(result => result.id), ['h:default:5'], q);
  const turkish = (await call({ q: 'şifre' })).results[0];
  assert.deepEqual(turkish.ranges.map(([from, to]) => turkish.snippet.slice(from, to)), ['ŞİFRE']);
  assert.deepEqual((await call({ q: '100%' })).results.map(result => result.id), ['h:research:1']);
  assert.deepEqual((await call({ q: '_now_' })).results.map(result => result.id), ['h:research:1']);
  assert.deepEqual((await call({ q: '%%' })).results, []);
  assert.deepEqual((await call({ q: 'nginx', profile: 'research' })).results.map(result => result.id), ['h:research:1']);
  assert.deepEqual((await call({ q: 'nginx', profile: 'nobody' })).results, []);
  for (const args of [{ q: 'x' }, { q: '' }, { q: 'a'.repeat(201) }, { q: 'nginx', limit: 0 }, { q: 'nginx', limit: 51 }, { q: 'nginx', profile: '../x' }, { q: 'nginx', cursor: '!!' }, { q: 'nginx', cursor: Buffer.from('{"../x":1}').toString('base64url') }, { q: 'nginx', extra: 1 }])
    await assert.rejects(call(args), error => error.code === 'bad_request', JSON.stringify(args));
  assert.equal(device.ids.size, 0, 'a read: no mutation id used');
});

test('X5 searchMessages: pages with a cursor without repeats or gaps; a bounded scan says partial; off without history', async t => {
  const { History } = require('../src/history');
  const history = new History({ hermesRoot: searchRoot(t) });
  t.after(() => history.close?.());
  const { mobile, device } = fixture(t, { history });
  const call = args => mobile.call(device, { id: `r.${crypto.randomUUID()}`, op: 'searchMessages', args });
  const seen = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const answer = await call({ q: 'nginx', limit: 1, ...(cursor ? { cursor } : {}) });
    seen.push(...answer.results.map(result => result.id));
    cursor = answer.next;
    if (!cursor) break;
  }
  assert.deepEqual(seen, ['h:research:1', 'h:default:5', 'h:default:2', 'h:default:1']);
  // A relay without history: the flag is off and the op says so.
  const none = fixture(t, {});
  assert.equal(none.mobile.capabilities().searchMessages, false);
  await assert.rejects(none.mobile.call(none.device, { id: 'r.1', op: 'searchMessages', args: { q: 'nginx' } }), error => error.code === 'unavailable');
  // The scan window: a store larger than the window answers partial and never sees the oldest rows.
  const search = require('../src/message-search');
  const big = new History({ hermesRoot: searchRoot(t, { many: 40 }) });
  t.after(() => big.close?.());
  const original = search.SCAN_PER_PROFILE;
  const answer = search.searchMessages(big.hermes, { q: 'nginx' }, { claudeProfile: 'claude-code', scanRows: 10 });
  assert.equal(original, 30000);
  assert.equal(answer.partial, true);
  assert.deepEqual(answer.results.map(result => result.id), ['h:research:1'], 'the default profile\'s matches are older than its newest 10 rows');
});

// ------------------------------------------------------------------------------------------------------------ X6 hue
test('X6 hue: profiles rows carry a valid hue from ui_meta[hermes-deck]; anything else dropped; old rows unchanged', async t => {
  const { projectProfiles, AGENT_HUES } = require('../../app/main/bridge');
  assert.deepEqual([...AGENT_HUES], ['indigo', 'blue', 'cyan', 'teal', 'purple', 'magenta', 'moss']);
  const rows = projectProfiles({ profiles: [
    { name: 'default', ui_meta: { 'hermes-deck': { hue: 'teal' }, 'hermes-bots': { color: '#6fb3a6' } } },
    { name: 'research', ui_meta: { 'hermes-deck': { hue: 'red' } } },
    { name: 'writer', ui_meta: { 'hermes-deck': { hue: 'url(javascript:x)' } } },
    { name: 'ops', ui_meta: { 'hermes-deck': 'teal' } },
    { name: 'plain' },
  ] });
  assert.deepEqual(rows.map(row => row.hue), ['teal', undefined, undefined, undefined, undefined]);
  assert.ok(!('hue' in rows[4]), 'no hue key at all when none is set: an old app sees the old row');
  assert.deepEqual(rows[0].meta, { color: '#6fb3a6' }, 'the desktop bot colour is untouched');
  // Through the phone op: the flag, and the rows as the bridge projects them; no write op exists for it.
  const { mobile, device } = fixture(t, { bridge: { profiles: async () => rows }, bridgeConfig: { mode: 'local' } });
  assert.equal(mobile.capabilities().profileHue, true);
  const answer = await mobile.call(device, { id: 'r.1', op: 'profiles', args: {} });
  assert.equal(answer[0].hue, 'teal');
  await assert.rejects(mobile.call(device, { id: 'm.1', op: 'setHue', args: { profile: 'default', hue: 'teal' } }), error => error.code === 'operation');
});

// -------------------------------------------------------------------------------------------------- X7 Live Activity
const ACT = 'b'.repeat(160);
function activityGateway() {
  const activities = new Map();
  return {
    activities,
    setActivity: async (id, body) => { activities.set(id, body); return { registered: true }; },
    removeActivity: async id => { activities.delete(id); return { removed: true }; },
  };
}
const jsonFetch = (url, method, token, body) => fetch(url, { method, headers: { ...bearer(token), 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('X7 Live Activity: register per chat; needs-you and finished go to the activity instead of a banner; answered elsewhere -> silent Working', async t => {
  const clock = fakeClock(1700000000000);
  const open = [];
  const gateway = activityGateway();
  const { mobile, device, sent, paired } = fixture(t, { now: clock, features: ['liveActivity', 'badge'], push: gateway, bridge: { listRequests: () => open } });
  assert.equal(mobile.capabilities().liveActivity, true);
  const url = await serve(t, mobile);
  const answer = await jsonFetch(`${url}/mobile/activity`, 'PUT', paired.token, { token: ACT, profile: 'default', sid: 's1', since: 1699999990 });
  assert.equal(answer.status, 200);
  const registered = await answer.json();
  assert.match(registered.id, /^a_[a-f0-9]{48}$/);
  assert.equal(registered.expires, clock() + 8 * 3600000);
  assert.deepEqual(gateway.activities.get(registered.id), { target: device.id, token: ACT, expires: registered.expires });
  assert.ok(!JSON.stringify(registered).includes(ACT), 'the token is never echoed');
  // An approval opens in s1: the activity gets it (alert), not a banner.
  open.push({ id: 'ap-1', sid: 's1', profile: 'default', kind: 'approval', at: clock(), command: 'git push', description: 'Push', choices: ['once', 'deny'] });
  mobile.notify(device, 'requests', [...open]);
  await flush(mobile);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { target: device.id, id: sent[0].id, kind: 'liveactivity', activity: registered.id, live: { state: 'approval', waiting: 1, since: 1699999990, at: 1700000000, event: 'update', alert: true } });
  assert.ok(!JSON.stringify(sent).includes('git push'), 'content-free');
  // Answered at the desktop: one silent update back to Working.
  open.length = 0;
  mobile.activityCheck(device);
  await flush(mobile);
  assert.deepEqual([sent[1].kind, sent[1].live.state, sent[1].live.alert, sent[1].live.waiting], ['liveactivity', 'working', undefined, 0]);
  mobile.activityCheck(device); await flush(mobile);
  assert.equal(sent.length, 2, 'once');
  // An approval in another chat is a normal banner.
  open.push({ id: 'ap-2', sid: 's2', profile: 'default', kind: 'approval', at: clock(), command: 'ls', description: 'List', choices: ['once', 'deny'] });
  mobile.notify(device, 'requests', [...open]);
  await flush(mobile);
  assert.equal(sent[2].kind, 'approval');
  // The turn ends: the end update (alert, dismissal in 15 minutes) instead of the done banner; the activity is gone.
  clock.advance(60000);
  device.notifications.set(`e_${clock()}_${'c'.repeat(48)}`, { sid: 's1', profile: 'default', kind: 'done', title: 'Atlas', body: 'Deployed', agent: '', thread: 'd'.repeat(32), expires: clock() + 3600000, delivery: 'pending' });
  mobile.persist(device); await flush(mobile);
  const end = sent.at(-1);
  assert.deepEqual([end.kind, end.live.state, end.live.event, end.live.alert, end.live.dismiss], ['liveactivity', 'finished', 'end', true, Math.floor(clock() / 1000) + 900]);
  assert.ok(!JSON.stringify(end).includes('Deployed'));
  assert.equal(mobile.activityFor(device, 'default', 's1'), null);
  // A later done in that chat is a banner again.
  device.notifications.set(`e_${clock()}_${'e'.repeat(48)}`, { sid: 's1', profile: 'default', kind: 'done', title: 'Atlas', body: 'Again', agent: '', thread: 'd'.repeat(32), expires: clock() + 3600000, delivery: 'pending' });
  mobile.persist(device); await flush(mobile);
  assert.equal(sent.at(-1).kind, 'done');
});

test('X7 Live Activity: same breaker as banners; bounded to three; unregister; expiry; refused without push, gateway support or a phone token', async t => {
  const clock = fakeClock(1700000000000);
  const gateway = activityGateway();
  const { mobile, device, sent, paired, file } = fixture(t, { now: clock, features: ['liveActivity'], push: gateway, policy: { scope: 'all', burst: 1 } });
  const url = await serve(t, mobile);
  const put = (body, token = paired.token) => jsonFetch(`${url}/mobile/activity`, 'PUT', token, body);
  for (const body of [{ token: 'xyz', profile: 'default', sid: 's1' }, { token: ACT, sid: 's1' }, { token: ACT, profile: 'default' }, { token: ACT, profile: 'default', sid: 's1', since: 1 }, { token: ACT, profile: 'default', sid: 's1', title: 'x' }])
    assert.equal((await put(body)).status, 400, JSON.stringify(body).slice(0, 60));
  assert.equal((await put({ token: ACT, profile: 'default', sid: 's1' }, 'x'.repeat(32))).status, 401, 'the desktop token is not a phone');
  const ids = [];
  for (const sid of ['s1', 's2', 's3', 's4']) { ids.push((await (await put({ token: ACT, profile: 'default', sid })).json()).id); clock.advance(10); }
  assert.equal(mobile.activities(device).size, 3);
  assert.equal(mobile.activityFor(device, 'default', 's1'), null, 'the oldest is replaced');
  assert.ok(!gateway.activities.has(ids[0]));
  // Re-registering a chat replaces its activity.
  const again = (await (await put({ token: ACT, profile: 'default', sid: 's4' })).json()).id;
  assert.equal(mobile.activityFor(device, 'default', 's4').id, again);
  assert.ok(!gateway.activities.has(ids[3]));
  // Another phone cannot remove this phone's activity.
  const other = mobile.pair({ code: createPair(file), name: 'tablet' });
  assert.deepEqual(await (await jsonFetch(`${url}/mobile/activity`, 'DELETE', other.token, { profile: 'default', sid: 's2' })).json(), { ok: true, removed: false });
  assert.ok(mobile.activityFor(device, 'default', 's2'));
  assert.equal((await put({ token: ACT, profile: 'default', sid: 's9' }, other.token)).status, 409, 'no push registration: not_registered');
  assert.deepEqual(await (await jsonFetch(`${url}/mobile/activity`, 'DELETE', paired.token, { profile: 'default', sid: 's2' })).json(), { ok: true, removed: true });
  // The breaker: burst 1 -> the second alerting update is held like a banner would be.
  const record = (sid, kind) => device.notifications.set(`e_${clock()}_${crypto.randomBytes(24).toString('hex')}`, { sid, profile: 'default', kind, title: '', body: '', agent: '', expires: clock() + 3600000, delivery: 'pending' }) && mobile.persist(device);
  record('s3', 'approval'); await flush(mobile);
  record('s4', 'question'); await flush(mobile);
  assert.deepEqual(sent.map(event => [event.kind, event.live?.state]), [['liveactivity', 'approval']]);
  assert.ok([...device.notifications.values()].some(item => item.kind === 'question' && item.delivery === 'held'));
  // Expiry: after eight hours the activity is forgotten and its chat gets banners again.
  clock.advance(8 * 3600000); mobile.govern(device);
  assert.equal(mobile.activities(device).size, 0);
  // Push disabled: activities forgotten; a gateway without the feature: 409 unsupported and the flag is off.
  const old = fixture(t, { now: clock, push: activityGateway() });
  const url2 = await serve(t, old.mobile);
  const refused = await jsonFetch(`${url2}/mobile/activity`, 'PUT', old.paired.token, { token: ACT, profile: 'default', sid: 's1' });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, 'unsupported');
  assert.equal(old.mobile.capabilities().liveActivity, false);
});

test('X7 push client: activity routes and liveactivity events only to a gateway that lists liveActivity', async () => {
  const { MobilePushClient } = require('../src/mobile-push');
  const requests = [];
  let features = ['liveActivity'];
  const fetchImpl = async (url, options) => {
    const route = new URL(url).pathname;
    if (route === '/health') return { ok: true, status: 200, json: async () => ({ ok: true, features }) };
    requests.push([options.method, route, options.body ? JSON.parse(options.body) : null]);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const client = new MobilePushClient({ url: 'https://push.example', credential: 'a'.repeat(43), fetch: fetchImpl });
  await client.refreshFeatures(true);
  await client.setActivity('a_1', { target: 'd1', token: ACT, expires: 1 });
  const live = { state: 'working', waiting: 0, since: 1700000000, at: 1700000001, event: 'update' };
  await client.notify('d1', { id: 'e_1', kind: 'liveactivity', activity: 'a_1', live, collapse: 'c'.repeat(32), badge: 2 });
  await client.removeActivity('a_1');
  assert.deepEqual(requests, [['PUT', '/v1/activities/a_1', { target: 'd1', token: ACT, expires: 1 }], ['POST', '/v1/events', { target: 'd1', id: 'e_1', kind: 'liveactivity', activity: 'a_1', live }], ['DELETE', '/v1/activities/a_1', null]]);
  features = [];
  await client.refreshFeatures(true);
  await assert.rejects(client.setActivity('a_2', { target: 'd1', token: ACT, expires: 1 }), error => error.code === 'unsupported');
  assert.deepEqual(await client.notify('d1', { id: 'e_2', kind: 'liveactivity', activity: 'a_1', live }), { skipped: true });
  assert.equal(requests.length, 3);
});
