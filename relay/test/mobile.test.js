'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { MobileRelay, createPair } = require('../src/mobile');
const { createServer } = require('../src/server');
const tokens = require('../src/devtokens');
const crypto = require('node:crypto');
const mutationID = (time = Date.now()) => `m.${time}.${crypto.randomUUID()}`;
const mutationIds = new Map();
const readOps = new Set(['sessions', 'history', 'profiles', 'avatar', 'botChat', 'modelOptions', 'sessionPage', 'sessionIndex']);
const { deckHooks } = require('../src/index');
function rpc(ws, id, op, args = {}) {
  if (!readOps.has(op)) { if (!mutationIds.has(id)) mutationIds.set(id, mutationID()); id = mutationIds.get(id); }
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', read); reject(new Error('response timeout')); }, 5000);
    function read(data) { const message = JSON.parse(data); if (message.t === 'response' && message.id === id) { clearTimeout(timer); ws.off('message', read); resolve(message); } }
    ws.on('message', read);
  });
  ws.send(JSON.stringify({ id, op, args }));
  return promise;
}
test('pair single use, hashed auth, upload boundaries, persisted request IDs and metadata-only push', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-unit-')), file = path.join(dir, 'devices.json'), notices = [], removed = [];
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'off' }, push: { configured: true, notify: async (deviceId, event) => notices.push({ deviceId, event }), removeDevice: async id => removed.push(id) } });
  t.after(() => mobile.stop());
  const code = createPair(file), paired = mobile.pair({ code, name: 'phone' }), device = mobile.device(paired.deviceId);
  assert.equal(mobile.authenticate({ headers: { authorization: `Bearer ${paired.token}` } }).id, paired.deviceId);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(paired.token));
  assert.throws(() => mobile.pair({ code, name: 'other' }), /Invalid/);
  for (let i = 0; i < 10; i++) assert.throws(() => mobile.pair({ code: 'wrong', name: 'phone' }, 'rate'));
  assert.throws(() => mobile.pair({ code: createPair(file), name: 'phone' }, 'rate'), /limit/);
  assert.throws(() => mobile.createUpload(device, { name: '../secret', mime: 'text/plain', size: 1 }), /Invalid/);
  assert.throws(() => mobile.createUpload(device, { name: 'a', mime: 'text/plain', size: 26214401 }), /Invalid/);
  const ticket = mobile.createUpload(device, { name: 'a', mime: 'text/plain', size: 1 });
  assert.throws(() => mobile.upload({ id: 'other' }, ticket.id), /missing/);
  device.uploads.get(ticket.id).expires = 0;
  assert.throws(() => mobile.upload(device, ticket.id), /expired/);
  await assert.rejects(mobile.call(device, { id: 'unknown', op: 'request' }), /operation/);
  const onceID = mutationID();
  await assert.rejects(mobile.call(device, { id: onceID, op: 'create' }), /configured/);
  await mobile.stop();
  const restarted = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'off' }, push: mobile.push });
  t.after(() => restarted.stop());
  await assert.rejects(restarted.call(restarted.device(paired.deviceId), { id: onceID, op: 'profiles' }), /already/);
  const liveDevice = restarted.device(paired.deviceId);
  liveDevice.observePush = true; restarted.persist(liveDevice);
  restarted.notify(liveDevice, 'requests', [{ id: 'approval-a', sid: 'session-a', profile: 'default', kind: 'approval', prompt: 'SECRET' }]);
  restarted.notify(liveDevice, 'requests', [{ id: 'approval-a', sid: 'session-a', profile: 'default', kind: 'approval', prompt: 'SECRET' }]);
  assert.equal(notices.length, 1);
  assert.deepEqual(Object.keys(notices[0].event).sort(), ['id', 'kind']);
  assert.ok(!JSON.stringify(notices).includes('SECRET'));
  assert.equal(liveDevice.notifications.get(notices[0].event.id).sid, 'session-a');
  let bridgeFrames = 0, legacyFrames = 0;
  const bridgeSocket = { readyState: 1, mobileBridge: true, bufferedAmount: 0, send: () => bridgeFrames++, terminate() {} };
  const legacySocket = { readyState: 1, bufferedAmount: 0, send: () => legacyFrames++, terminate() {} };
  liveDevice.sockets.add(bridgeSocket); liveDevice.sockets.add(legacySocket);
  restarted.emit(liveDevice, { t: 'bridge', event: 'snapshot', data: {} });
  assert.equal(bridgeFrames, 1); assert.equal(legacyFrames, 0);
  liveDevice.sockets.clear();
  await restarted.revoke(device);
  await restarted.flushPush();
  assert.deepEqual(removed, [paired.deviceId]);
});
test('mobile events cannot host/impersonate desktop or input another controller browser', () => {
  let heartbeat, routed = 0, binary = 0;
  const presence = { heartbeat: (_, value) => { heartbeat = value; } };
  const workspace = { holders: new Map(), onMessage: () => { routed++; return true; } };
  const hooks = deckHooks(presence, { onFrame: () => binary++ }, null, workspace);
  const ws = { mobileDevice: { id: 'mobile-own' }, send() {} };
  hooks.onMessage(ws, Buffer.from(JSON.stringify({ t: 'heartbeat', device: { id: 'desktop-other' }, hosting: { browser: true, desktop: true }, driverOk: true })), false);
  assert.equal(heartbeat.device.id, 'mobile-own');
  assert.deepEqual(heartbeat.hosting, { browser: false, desktop: false });
  assert.equal(heartbeat.driverOk, false);
  hooks.onMessage(ws, Buffer.from([0xd5]), true);
  hooks.onMessage(ws, Buffer.from(JSON.stringify({ t: 'ws-input', slug: 'agent', ev: {} })), false);
  assert.equal(binary, 0); assert.equal(routed, 0);
  workspace.holders.set('agent', ws);
  hooks.onMessage(ws, Buffer.from(JSON.stringify({ t: 'ws-input', slug: 'agent', ev: {} })), false);
  assert.equal(routed, 1);
});
test('loopback persistent BridgeClient, nonreplay, transfers, legacy reads and own-device revoke', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-http-')), file = path.join(dir, 'devices.json');
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'local', python: '/usr/bin/python3', stream: '/srv/stream.py' }, bridgeOptions: {
    launch: { file: process.execPath, args: [path.resolve(__dirname, '../../app/test/fake-stream.js'), '--serve'] },
    timing: { handshake: 2000, request: 1500, heartbeat: 5000, kill: 100, backoffMin: 50 },
  } });
  const model = { snapshot: () => ({ sessions: [] }), tokens: () => ({}), sessions: new Map() };
  const relay = createServer({ token: 'x'.repeat(32), model, fleet: { data: {} }, version: 'test', mobile });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  t.after(async () => { await mobile.stop(); for (const ws of relay.clients) ws.terminate(); await new Promise(resolve => relay.server.close(resolve)); });
  const request = async (route, method = 'GET', data, token) => {
    const response = await fetch(base + route, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  const first = (await request('/mobile/pair', 'POST', { code: createPair(file), name: 'phone' })).body;
  const second = (await request('/mobile/pair', 'POST', { code: createPair(file), name: 'tablet' })).body;
  assert.equal((await request('/snapshot', 'GET', undefined, first.token)).status, 200);
  assert.equal((await request('/snapshot', 'GET', undefined, 'x'.repeat(32))).status, 200);
  assert.equal((await request('/mobile/capabilities', 'GET', undefined, 'x'.repeat(32))).status, 401);
  assert.equal((await request('/bundle', 'GET', undefined, first.token)).status, 403);
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/mobile/bridge', { headers: { authorization: `Bearer ${first.token}` } });
  await new Promise(resolve => ws.once('open', resolve));
  const bridge = mobile.devices.get(first.deviceId).bridge;
  if (!bridge.snapshot) await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('bridge timeout')), 4000); bridge.once('snapshot', () => { clearTimeout(timer); resolve(); }); });
  assert.equal((await rpc(ws, 'sessions', 'sessions')).ok, true);
  assert.equal((await rpc(ws, 'page-021', 'sessionPage', { profile: 'default', archived: false, offset: 0 })).ok, true);
  assert.equal((await rpc(ws, 'index-021', 'sessionIndex', { archived: false })).ok, true);
  assert.equal((await rpc(ws, 'rename-021', 'renameSession', { sid: 's-idle', profile: 'default', title: 'Mobile title' })).ok, true);
  assert.equal((await rpc(ws, 'pin-021', 'pinSession', { sid: 's-idle', profile: 'default', pinned: true })).ok, true);
  assert.equal((await rpc(ws, 'archive-021', 'archiveSession', { sid: 's-idle', profile: 'default', archived: true })).ok, true);
  assert.equal((await rpc(ws, 'branch-021', 'branchSession', { sid: 's-tg-1', profile: 'research' })).ok, true);
  assert.equal((await rpc(ws, 'effort-021', 'setEffort', { sid: 's-idle', profile: 'default', effort: 'high' })).ok, true);
  assert.equal((await rpc(ws, 'reasoning-021', 'reasoning', { show: true })).ok, true);
  assert.equal((await rpc(ws, 'bad-page-021', 'sessionPage', { archived: 'yes' })).error.code, 'bad_request');
  const created = await rpc(ws, 'create', 'create', { profile: 'default' });
  assert.equal(created.ok, true);
  assert.equal((await rpc(ws, 'create', 'create', { profile: 'default' })).error.code, 'duplicate');
  const ticket = (await request('/mobile/uploads', 'POST', { name: 'a.txt', mime: 'text/plain', size: 3 }, first.token)).body;
  assert.equal((await fetch(base + '/mobile/uploads/' + ticket.id, { method: 'PUT', headers: { authorization: `Bearer ${second.token}` }, body: 'abc' })).status, 404);
  assert.equal((await fetch(base + '/mobile/uploads/' + ticket.id, { method: 'PUT', headers: { authorization: `Bearer ${first.token}` }, body: 'abc' })).status, 200);
  const sid = created.result.sid || created.result.id;
  const sent = await rpc(ws, 'send', 'send', { sid, text: 'fixture', uploads: [ticket.id] });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal((await rpc(ws, 'resend', 'send', { sid, text: 'fixture', uploads: [ticket.id] })).error.code, 'not_found');
  const history = await rpc(ws, 'files-history', 'history', { sid: 's-files', profile: 'default' });
  assert.equal(history.ok, true);
  const ref = history.result.messages.flatMap(m => m.files || []).find(f => f.name === 'report.txt').ref;
  assert.ok(!ref.includes('/'));
  assert.equal((await request('/mobile/files/info', 'POST', { sid: 's-files', profile: 'other', ref }, first.token)).status, 404);
  assert.equal((await request('/mobile/files/info', 'POST', { sid: 's-files', profile: 'default', ref }, second.token)).status, 404);
  const info = await request('/mobile/files/info', 'POST', { sid: 's-files', profile: 'default', ref }, first.token);
  assert.equal(info.status, 200, JSON.stringify(info));
  assert.equal((await fetch(base + '/mobile/files/' + info.body.id, { headers: { authorization: `Bearer ${second.token}` } })).status, 404);
  const download = await fetch(base + '/mobile/files/' + info.body.id, { headers: { authorization: `Bearer ${first.token}` } });
  assert.equal(download.status, 200); assert.ok((await download.text()).length);
  assert.equal((await request('/mobile/files/info', 'POST', { sid: 's-files', profile: 'default', ref: '/home/user/.ssh/id_ed25519' }, first.token)).status, 404);
  const revoked = await request('/mobile/pair', 'DELETE', { deviceId: first.deviceId }, second.token);
  assert.equal(revoked.status, 200);
  assert.equal((await request('/snapshot', 'GET', undefined, second.token)).status, 401);
  assert.equal((await request('/snapshot', 'GET', undefined, first.token)).status, 200);
  ws.close(); await new Promise(resolve => ws.once('close', resolve));
  assert.equal(mobile.devices.get(first.deviceId).bridge, bridge);
  const again = new WebSocket(base.replace('http:', 'ws:') + '/mobile/bridge', { headers: { authorization: `Bearer ${first.token}` } });
  await new Promise(resolve => again.once('open', resolve));
  const closed = new Promise(resolve => again.once('close', resolve));
  tokens.revoke(file, first.deviceId); await closed;
  assert.equal((await request('/snapshot', 'GET', undefined, first.token)).status, 401);
});
test('lost host mutation reports uncertain and never replays after bridge reconnect', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-lost-')), file = path.join(dir, 'devices.json'), log = path.join(dir, 'requests.log');
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'local', python: '/usr/bin/python3', stream: '/srv/stream.py' }, bridgeOptions: {
    launch: { file: process.execPath, args: [path.resolve(__dirname, '../../app/test/fake-stream.js'), '--serve', '--log', log, '--exit-on', 'prompt.submit'] },
    timing: { handshake: 1500, request: 1500, heartbeat: 5000, kill: 100, backoffMin: 30, backoffMax: 50 },
  } });
  const relay = createServer({ token: 'x'.repeat(32), mobile, model: { snapshot: () => ({}), sessions: new Map(), tokens: () => ({}) }, fleet: { data: {} }, version: 'test' });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await mobile.stop(); await new Promise(resolve => relay.server.close(resolve)); });
  const paired = mobile.pair({ code: createPair(file), name: 'phone' });
  const ws = new WebSocket(`ws://127.0.0.1:${relay.server.address().port}/mobile/bridge`, { headers: { authorization: `Bearer ${paired.token}` } });
  await new Promise(resolve => ws.once('open', resolve));
  const bridge = mobile.device(paired.deviceId).bridge;
  if (!bridge.snapshot) await new Promise(resolve => bridge.once('snapshot', resolve));
  const session = await rpc(ws, 'create-lost', 'create', { profile: 'default' });
  const failed = await rpc(ws, 'send-lost', 'send', { sid: session.result.sid || session.result.id, text: 'fixture' });
  assert.equal(failed.ok, false); assert.equal(failed.error.uncertain, true);
  await new Promise(resolve => setTimeout(resolve, 250));
  const entries = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.filter(entry => entry.method === 'prompt.submit').length, 1);
  assert.equal((await rpc(ws, 'send-lost', 'send', { sid: session.result.sid || session.result.id, text: 'fixture' })).error.code, 'duplicate');
});
test('push outage retries durable metadata after restart and own revoke cleanup survives key removal', async t => {
  const http = require('node:http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-push-outage-')), file = path.join(dir, 'devices.json');
  let offline = true;
  const forwarded = [], removals = [], attempts = [];
  const gateway = http.createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part;
    attempts.push({ method: req.method, path: req.url, body: text });
    res.writeHead(offline ? 503 : 200, { 'content-type': 'application/json' });
    if (!offline) {
      if (req.method === 'POST') forwarded.push(JSON.parse(text));
      else removals.push(req.url.split('/').at(-1));
    }
    res.end(JSON.stringify({ ok: !offline }));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => gateway.close(resolve)));
  const endpoint = `http://127.0.0.1:${gateway.address().port}`;
  const push = { configured: true,
    notify: async (target, event) => { const res = await fetch(endpoint + '/events', { method: 'POST', body: JSON.stringify({ target, ...event }) }); if (!res.ok) throw Error('offline'); return res.json(); },
    removeDevice: async id => { const res = await fetch(endpoint + '/devices/' + id, { method: 'DELETE' }); if (!res.ok) throw Error('offline'); return res.json(); },
  };
  const make = async () => {
    const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'off' }, push });
    const relay = createServer({ token: 'x'.repeat(32), mobile, model: { snapshot: () => ({}), sessions: new Map(), tokens: () => ({}) }, fleet: { data: {} }, version: 'test' });
    await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
    const close = async () => { await mobile.stop(); await new Promise(resolve => relay.server.close(resolve)); };
    return { mobile, close, url: `http://127.0.0.1:${relay.server.address().port}` };
  };
  let current = await make();
  t.after(async () => current.close());
  const first = current.mobile.pair({ code: createPair(file), name: 'phone' });
  const other = current.mobile.pair({ code: createPair(file), name: 'tablet' });
  current.mobile.device(first.deviceId).observePush = true; current.mobile.persist(current.mobile.device(first.deviceId));
  current.mobile.notify(current.mobile.device(first.deviceId), 'requests', [{ id: 'approval-outage', sid: 'session-a', profile: 'default', kind: 'approval', prompt: 'PRIVATE PROMPT' }]);
  await current.mobile.flushPush();
  const saved = JSON.parse(fs.readFileSync(file + '.state', 'utf8'));
  const eventId = Object.keys(saved.devices[first.deviceId].notifications)[0];
  assert.equal(saved.devices[first.deviceId].notifications[eventId].delivery, 'pending');
  assert.equal(forwarded.length, 0);
  await current.close(); current = await make(); offline = false;
  await current.mobile.flushPush();
  assert.equal(forwarded.length, 1); assert.equal(forwarded[0].id, eventId);
  assert.deepEqual(Object.keys(forwarded[0]).sort(), ['id', 'kind', 'target']);
  assert.equal(JSON.parse(fs.readFileSync(file + '.state', 'utf8')).devices[first.deviceId].notifications[eventId].delivery, 'accepted');
  await current.mobile.flushPush(); assert.equal(forwarded.length, 1);
  const route = await fetch(current.url + '/mobile/notifications/' + eventId, { headers: { authorization: `Bearer ${first.token}` } });
  assert.equal((await route.json()).sid, 'session-a');
  offline = true;
  current.mobile.notify(current.mobile.device(first.deviceId), 'requests', [{ id: 'approval-revoked', sid: 'session-b', profile: 'default', kind: 'approval', prompt: 'PRIVATE PROMPT' }]);
  await current.mobile.flushPush();
  const response = await fetch(current.url + '/mobile/pair', { method: 'DELETE', headers: { authorization: `Bearer ${first.token}` }, body: JSON.stringify({ deviceId: other.deviceId }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, revoked: true, pushCleanup: 'pending' });
  assert.equal((await fetch(current.url + '/snapshot', { headers: { authorization: `Bearer ${first.token}` } })).status, 401);
  assert.equal((await fetch(current.url + '/snapshot', { headers: { authorization: `Bearer ${other.token}` } })).status, 200);
  const revoked = JSON.parse(fs.readFileSync(file + '.state', 'utf8'));
  assert.ok(revoked.revocations[first.deviceId]); assert.equal(revoked.devices[first.deviceId], undefined);
  await current.close(); current = await make(); offline = false;
  await current.mobile.flushPush();
  assert.deepEqual(removals, [first.deviceId]); assert.equal(forwarded.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file + '.state', 'utf8')).revocations[first.deviceId], undefined);
  assert.ok(!JSON.stringify(attempts).includes('PRIVATE PROMPT'));
});
test('more than 10000 read calls remain usable; active duplicates and uncertain mutations stay protected after restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-read-budget-')), file = path.join(dir, 'devices.json');
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'local' } });
  t.after(() => mobile.stop());
  const paired = mobile.pair({ code: createPair(file), name: 'phone' }), device = mobile.device(paired.deviceId);
  let unblock;
  device.bridge = { sessions: async () => [], send: async () => { throw Error('uncertain host result'); }, stop: async () => {} };
  for (let i = 0; i < 10010; i++) await mobile.call(device, { id: `read-${i}`, op: 'sessions' });
  assert.equal(device.ids.size, 0); assert.equal(device.reads.size, 0);
  device.bridge.sessions = () => new Promise(resolve => { unblock = resolve; });
  const pending = mobile.call(device, { id: 'active-read', op: 'sessions' });
  await assert.rejects(mobile.call(device, { id: 'active-read', op: 'sessions' }), /already/);
  unblock([]); await pending;
  device.bridge.sessions = async () => [];
  await mobile.call(device, { id: 'active-read', op: 'sessions' });
  const uncertainID = mutationID();
  await assert.rejects(mobile.call(device, { id: uncertainID, op: 'send', args: { sid: 'session', text: 'fixture' } }), /uncertain/);
  await assert.rejects(mobile.call(device, { id: uncertainID, op: 'send', args: { sid: 'session', text: 'fixture' } }), /already/);
  await mobile.stop();
  const restarted = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'off' } });
  t.after(() => restarted.stop());
  await assert.rejects(restarted.call(restarted.device(paired.deviceId), { id: uncertainID, op: 'send' }), /already/);
  restarted.device(paired.deviceId).ids = new Set(Array.from({ length: 10000 }, (_, i) => `m.${Date.now()}.00000000-0000-0000-0000-${i.toString(16).padStart(12, '0')}`));
  restarted.bridgeConfig = { mode: 'local' };
  restarted.device(paired.deviceId).bridge = { sessions: async () => [], stop: async () => {} };
  await restarted.call(restarted.device(paired.deviceId), { id: 'read-after-mutation-cap', op: 'sessions' });
});
test('timestamp mutation receipts expire safely while stale, future and legacy IDs never dispatch', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-receipt-window-')), file = path.join(dir, 'devices.json');
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'off' } });
  const paired = mobile.pair({ code: createPair(file), name: 'phone' }), device = mobile.device(paired.deviceId);
  const expired = mutationID(Date.now() - 8 * 86400000), legacy = crypto.randomUUID();
  device.ids = new Set([expired, legacy]); mobile.persist(device); await mobile.stop();
  const restarted = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'local' } });
  t.after(() => restarted.stop());
  const restored = restarted.device(paired.deviceId);
  assert.equal(restored.ids.size, 0);
  assert.equal(JSON.parse(fs.readFileSync(file + '.state', 'utf8')).devices[paired.deviceId].ids.length, 0);
  let executed = 0;
  restored.bridge = { create: async () => { executed++; return { sid: 'fresh-session' }; }, stop: async () => {} };
  await assert.rejects(restarted.call(restored, { id: expired, op: 'create' }), error => error.code === 'expired_request' && error.uncertain === true);
  await assert.rejects(restarted.call(restored, { id: legacy, op: 'create' }), error => error.code === 'bad_request');
  await assert.rejects(restarted.call(restored, { id: mutationID(Date.now() + 16 * 60000), op: 'create' }), error => error.code === 'clock_skew');
  assert.equal(executed, 0);
  const fresh = mutationID();
  assert.equal((await restarted.call(restored, { id: fresh, op: 'create' })).sid, 'fresh-session');
  await assert.rejects(restarted.call(restored, { id: fresh, op: 'create' }), error => error.code === 'duplicate');
  assert.equal(executed, 1);
  // Age cleanup also runs on normal validated calls without restarting the relay.
  restored.ids.add(expired); restarted.persist(restored);
  await restarted.call(restored, { id: mutationID(), op: 'create' });
  assert.equal(restored.ids.has(expired), false); assert.equal(executed, 2);
});
test('persisted expiry floor prevents replay after server clock rollback and restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-clock-floor-')), file = path.join(dir, 'devices.json');
  const now = Date.now(), old = mutationID(now - 8 * 86400000);
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'local' } });
  const paired = mobile.pair({ code: createPair(file), name: 'phone' }), device = mobile.device(paired.deviceId);
  device.ids.add(old); mobile.persist(device);
  device.bridge = { sessions: async () => [], stop: async () => {} };
  await mobile.call(device, { id: 'prune', op: 'sessions' });
  assert.equal(device.ids.has(old), false);
  const floor = JSON.parse(fs.readFileSync(file + '.state', 'utf8')).devices[paired.deviceId].receiptFloor;
  await mobile.stop();
  const realNow = Date.now;
  Date.now = () => now - 2 * 86400000;
  try {
    const restarted = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'local' } });
    t.after(() => restarted.stop());
    const restored = restarted.device(paired.deviceId);
    let executed = 0;
    restored.bridge = { create: async () => { executed++; }, stop: async () => {} };
    assert.equal(restored.receiptFloor, floor);
    // This ID is now only six days old by wall time, but remains below the durable floor.
    await assert.rejects(restarted.call(restored, { id: old, op: 'create' }), error => error.code === 'expired_request');
    assert.equal(executed, 0);
    assert.equal(JSON.parse(fs.readFileSync(file + '.state', 'utf8')).devices[paired.deviceId].receiptFloor, floor);
  } finally { Date.now = realNow; }
});
test('standalone relay imports with mobile bridge off and configured missing library fails before sockets start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-standalone-')), src = path.join(dir, 'relay', 'src');
  fs.mkdirSync(src, { recursive: true });
  for (const name of ['mobile.js', 'devtokens.js', 'util.js', 'compat.js']) fs.copyFileSync(path.join(__dirname, '..', 'src', name), path.join(src, name));
  fs.copyFileSync(path.join(__dirname, '..', 'package.json'), path.join(dir, 'relay', 'package.json')); // compat.js: the relay version
  fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(dir, 'relay', 'node_modules'), 'dir');
  const { MobileRelay: Standalone } = require(path.join(src, 'mobile.js'));
  const off = new Standalone({ tokensFile: path.join(dir, 'devices.json'), bridgeConfig: { mode: 'off' } });
  assert.equal(off.capabilities().bridge, false);
  assert.equal(off.BridgeClient, null);
  await off.stop();
  assert.throws(() => new Standalone({ tokensFile: path.join(dir, 'devices.json'), bridgeConfig: { mode: 'local', python: 'python3', stream: '/srv/stream.py' } }),
    error => error.code === 'unavailable' && error.message.includes('full Hermes Deck source layout including app/main/bridge.js'));
});
test('timestamped push event IDs stay stable across reconnect and terminal expiry is not retried after restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-push-event-id-')), file = path.join(dir, 'devices.json');
  const submissions = [];
  const push = { configured: true, notify: async (target, event) => {
    submissions.push({ target, ...event });
    throw Object.assign(Error('Gateway event expired'), { status: 410, code: 'EVENT_EXPIRED' });
  }, removeDevice: async () => {} };
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'off' }, push });
  const paired = mobile.pair({ code: createPair(file), name: 'phone' }), device = mobile.device(paired.deviceId), timestamp = Date.now() - 1000;
  device.observePush = true; mobile.persist(device);
  mobile.notify(device, 'requests', [{ id: 'same-approval', sid: 'session', profile: 'default', kind: 'approval', at: timestamp, command: 'PRIVATE COMMAND' }]);
  await mobile.flushPush();
  assert.equal(submissions.length, 1);
  const id = submissions[0].id;
  assert.match(id, /^e_\d{13}_[a-f0-9]{48}$/); assert.equal(id.split('_')[1], String(timestamp));
  assert.equal(device.notifications.get(id).delivery, 'expired');
  // A fresh arrival timestamp for the same host request cannot change the retained event ID.
  mobile.notify(device, 'requests', [{ id: 'same-approval', sid: 'session', profile: 'default', kind: 'approval', at: Date.now() }]);
  await mobile.flushPush(); assert.equal(submissions.length, 1);
  await mobile.stop();
  const restarted = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'off' }, push });
  t.after(() => restarted.stop());
  assert.equal(restarted.device(paired.deviceId).notifications.get(id).delivery, 'expired');
  restarted.notify(restarted.device(paired.deviceId), 'requests', [{ id: 'same-approval', sid: 'session', profile: 'default', kind: 'approval', at: Date.now() }]);
  await restarted.flushPush(); assert.equal(submissions.length, 1);
  assert.ok(!JSON.stringify(submissions).includes('PRIVATE COMMAND'));
});
test('mobile controls and notification identity stay scoped to authoritative profile plus SID', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-profile-scope-')), file = path.join(dir, 'devices.json');
  const notices = [], controls = [];
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'local' }, push: { configured: true,
    notify: async (target, event) => notices.push({ target, ...event }), removeDevice: async () => {} } });
  t.after(() => mobile.stop());
  const paired = mobile.pair({ code: createPair(file), name: 'phone' }), device = mobile.device(paired.deviceId);
  device.observePush = true; mobile.persist(device);
  const nodes = [{ sid: 'same-sid', profile: 'alpha', state: 'working', turnId: 'same-turn' }, { sid: 'same-sid', profile: 'beta', state: 'working', turnId: 'same-turn' }];
  device.bridge = { nodeFor: (sid, profile) => nodes.find(node => node.sid === sid && node.profile === profile),
    steer: async (sid, text, options) => controls.push({ sid, text, profile: options.profile }),
    interrupt: async (sid, options) => controls.push({ sid, profile: options.profile }),
    listRequests: () => [{ id: 'request-owned', profile: 'alpha' }],
    answerApproval: async (id, choice, options) => controls.push({ id, choice, profile: options.profile }), stop: async () => {} };
  await assert.rejects(mobile.call(device, { id: mutationID(), op: 'steer', args: { sid: 'same-sid', text: 'fixture' } }), /Explicit control profile/);
  await assert.rejects(mobile.call(device, { id: mutationID(), op: 'interrupt', args: { sid: 'same-sid', profile: 'missing' } }), /does not match/);
  await mobile.call(device, { id: mutationID(), op: 'steer', args: { sid: 'same-sid', profile: 'alpha', text: 'fixture' } });
  await mobile.call(device, { id: mutationID(), op: 'interrupt', args: { sid: 'same-sid', profile: 'beta' } });
  await assert.rejects(mobile.call(device, { id: mutationID(), op: 'answerApproval', args: { id: 'request-owned', profile: 'beta', choice: 'once' } }), /request profile/);
  await mobile.call(device, { id: mutationID(), op: 'answerApproval', args: { id: 'request-owned', profile: 'alpha', choice: 'once' } });
  assert.deepEqual(controls.map(item => item.profile), ['alpha', 'beta', 'alpha']);
  mobile.notify(device, 'snapshot', { nodes });
  mobile.notify(device, 'snapshot', { nodes: nodes.map(node => ({ ...node, state: 'finished', terminalAt: Date.now() / 1000 })) });
  await mobile.flushPush();
  const routes = [...device.notifications.values()];
  assert.equal(routes.length, 2); assert.deepEqual(routes.map(item => item.profile).sort(), ['alpha', 'beta']);
  mobile.notify(device, 'requests', [{ id: 'same-host-id', sid: 'same-sid', profile: 'alpha', kind: 'approval', at: Date.now() },
    { id: 'same-host-id', sid: 'same-sid', profile: 'beta', kind: 'approval', at: Date.now() }]);
  await mobile.flushPush();
  await mobile.flushPush();
  assert.equal(device.notifications.size, 4); assert.equal(new Set(notices.map(item => item.id)).size, 4);
  mobile.notify(device, 'native', { type: 'message.complete', sid: 'same-sid', profile: 'beta' });
  await mobile.flushPush();
  assert.equal([...device.notifications.values()].at(-1).profile, 'beta');
  const count = device.notifications.size;
  mobile.notify(device, 'native', { type: 'message.complete', sid: 'same-sid', profile: null });
  assert.equal(device.notifications.size, count);
});
test('late push registration after revoke queues durable cleanup and held device does not block another', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-push-race-')), file = path.join(dir, 'devices.json');
  const registered = new Set();
  let releaseRegistration, registrationEntered, offlineCleanup = false, releaseA, heldA, deliveredB;
  const entered = new Promise(resolve => { registrationEntered = resolve; });
  const registrationGate = new Promise(resolve => { releaseRegistration = resolve; });
  const aEntered = new Promise(resolve => { heldA = resolve; });
  const bDelivered = new Promise(resolve => { deliveredB = resolve; });
  const aGate = new Promise(resolve => { releaseA = resolve; });
  let aid, bid, activeA = 0, maximumA = 0;
  const push = { configured: true,
    setDevice: async id => { registrationEntered(); await registrationGate; registered.add(id); },
    removeDevice: async id => { if (offlineCleanup) throw Error('gateway unavailable'); registered.delete(id); },
    notify: async id => {
      if (id === aid) { activeA++; maximumA = Math.max(maximumA, activeA); heldA(); await aGate; activeA--; }
      if (id === bid) deliveredB();
    },
  };
  const make = async () => {
    const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'off' }, push });
    const relay = createServer({ token: 'x'.repeat(32), mobile, model: { snapshot: () => ({}), sessions: new Map(), tokens: () => ({}) }, fleet: { data: {} }, version: 'test' });
    await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
    return { mobile, url: `http://127.0.0.1:${relay.server.address().port}`,
      close: async () => { await mobile.stop(); await new Promise(resolve => relay.server.close(resolve)); } };
  };
  let current = await make();
  t.after(async () => { releaseA(); releaseRegistration(); await current.close(); });
  const first = current.mobile.pair({ code: createPair(file), name: 'phone' });
  const putting = fetch(current.url + '/mobile/push', { method: 'PUT', headers: { authorization: `Bearer ${first.token}` }, body: JSON.stringify({ enabled: true }) });
  await entered;
  const revoked = await fetch(current.url + '/mobile/pair', { method: 'DELETE', headers: { authorization: `Bearer ${first.token}` } });
  assert.equal(revoked.status, 200); assert.equal((await revoked.json()).pushCleanup, 'pending');
  assert.ok(current.mobile.meta.revocations[first.deviceId]);
  offlineCleanup = true; releaseRegistration();
  assert.equal((await putting).status, 401);
  assert.equal(registered.has(first.deviceId), true);
  assert.ok(JSON.parse(fs.readFileSync(file + '.state', 'utf8')).revocations[first.deviceId]);
  assert.equal((await fetch(current.url + '/snapshot', { headers: { authorization: `Bearer ${first.token}` } })).status, 401);
  await current.close(); offlineCleanup = false; current = await make();
  await current.mobile.flushPush();
  assert.equal(registered.has(first.deviceId), false); assert.equal(current.mobile.meta.revocations[first.deviceId], undefined);
  const a = current.mobile.pair({ code: createPair(file), name: 'a' }), b = current.mobile.pair({ code: createPair(file), name: 'b' });
  aid = a.deviceId; bid = b.deviceId;
  for (const id of [aid, bid]) { const enrolled = current.mobile.device(id); enrolled.observePush = true; current.mobile.persist(enrolled); }
  const queue = Array.from({ length: 256 }, (_, i) => ({ id: `approval-${i}`, sid: 'session', profile: 'default', kind: 'approval', at: Date.now() }));
  current.mobile.notify(current.mobile.device(aid), 'requests', queue);
  await aEntered;
  current.mobile.notify(current.mobile.device(bid), 'requests', [{ id: 'fresh-b', sid: 'session', profile: 'default', kind: 'approval', at: Date.now() }]);
  let deadline;
  try { await Promise.race([bDelivered, new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('device B blocked behind held A')), 1000); })]); }
  finally { clearTimeout(deadline); }
  assert.equal(activeA, 1); assert.equal(maximumA, 1); assert.ok(current.mobile.pushTasks.size <= 4);
  assert.equal(current.mobile.device(aid).notifications.size, 256);
  releaseA();
});
test('push-only registration intent survives DELETE during held PUT and crash before settlement cleanup', async t => {
  const http = require('node:http'), { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-registration-crash-')), file = path.join(dir, 'devices.json');
  const registrations = new Set(); let ownershipBeforeGateway = false, enteredGateway, releaseGateway;
  const entered = new Promise(resolve => { enteredGateway = resolve; });
  const held = new Promise(resolve => { releaseGateway = resolve; });
  const gateway = http.createServer(async (req, res) => {
    const id = req.url.slice('/devices/'.length);
    if (req.method === 'PUT') {
      ownershipBeforeGateway = fs.existsSync(file + '.state') && !!JSON.parse(fs.readFileSync(file + '.state', 'utf8')).devices[id];
      enteredGateway(); await held; registrations.add(id);
    } else registrations.delete(id);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => gateway.close(resolve)));
  const gatewayURL = `http://127.0.0.1:${gateway.address().port}`;
  const script = `
    const [mobilePath,serverPath,tokensFile,url]=process.argv.slice(1);
    const {MobileRelay,createPair}=require(mobilePath),{createServer}=require(serverPath);
    const mobile=new MobileRelay({tokensFile,bridgeConfig:{mode:'off'},push:{configured:true,
      removeDevice:async(id)=>{await fetch(url+'/devices/'+id,{method:'DELETE'});},
      setDevice:async(id,registration)=>{await fetch(url+'/devices/'+id,{method:'PUT',body:JSON.stringify(registration),signal:AbortSignal.timeout(2000)});process.exit(0);}
    }});
    const relay=createServer({token:'x'.repeat(32),mobile,model:{snapshot:()=>({}),sessions:new Map(),tokens:()=>({})},fleet:{data:{}},version:'fixture'});
    relay.server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:relay.server.address().port,pair:mobile.pair({code:createPair(tokensFile),name:'push-only'})})+'\\n'));
  `;
  const child = spawn(process.execPath, ['-e', script, require.resolve('../src/mobile'), require.resolve('../src/server'), file, gatewayURL], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const ready = await new Promise((resolve, reject) => {
    let text = ''; const timeout = setTimeout(() => reject(Error('fixture startup timed out')), 3000);
    child.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(text.split('\n')[0])); } });
  });
  const crashWindow = assert.rejects(fetch(`http://127.0.0.1:${ready.port}/mobile/push`, { method: 'PUT', headers: { authorization: `Bearer ${ready.pair.token}` }, body: '{"enabled":true}' }));
  await entered;
  const optedOut = await fetch(`http://127.0.0.1:${ready.port}/mobile/push`, { method: 'DELETE', headers: { authorization: `Bearer ${ready.pair.token}` } });
  assert.equal(optedOut.status, 503);
  const pending = JSON.parse(fs.readFileSync(file + '.state', 'utf8')).devices[ready.pair.deviceId];
  assert.ok(pending.pushAttempt && pending.pushRemoval); assert.equal(pending.observePush, false);
  releaseGateway(); await crashWindow;
  assert.equal(await exited, 0); assert.equal(ownershipBeforeGateway, true);
  assert.equal(registrations.has(ready.pair.deviceId), true);
  const state = JSON.parse(fs.readFileSync(file + '.state', 'utf8'));
  assert.ok(state.devices[ready.pair.deviceId]); assert.deepEqual(state.devices[ready.pair.deviceId].ids, []);
  const restarted = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'off' }, push: { configured: true,
    removeDevice: async id => { const response = await fetch(gatewayURL + '/devices/' + id, { method: 'DELETE' }); assert.equal(response.status, 200); },
  } });
  t.after(() => restarted.stop());
  await restarted.flushPush();
  assert.equal(registrations.has(ready.pair.deviceId), false);
  assert.equal(restarted.meta.devices[ready.pair.deviceId].pushRemoval, null);
  assert.equal(restarted.meta.devices[ready.pair.deviceId].pushAttempt, null);
  assert.equal(restarted.meta.devices[ready.pair.deviceId].observePush, false);
  assert.equal(tokens.match(file, ready.pair.token), ready.pair.deviceId);
  assert.equal(restarted.meta.revocations[ready.pair.deviceId], undefined);
});
test('round9 authorized background observation restores without phone; overflow and ambiguous requests preserve valid records', async t => {
  const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-background-')), file = path.join(dir, 'devices.json');
  let registrations = 0, starts = 0, removalUnavailable = false;
  const forwarded = [];
  const push = { configured: true, setDevice: async () => { registrations++; }, removeDevice: async () => { if (removalUnavailable) throw Error('gateway offline'); }, notify: async (target, event) => forwarded.push({ target, ...event }) };
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'off' }, push });
  const relay = createServer({ token: 'x'.repeat(32), mobile, model: { snapshot: () => ({}), sessions: new Map(), tokens: () => ({}) }, fleet: { data: {} }, version: 'fixture' });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await mobile.stop(); if (relay.server.listening) await new Promise(resolve => relay.server.close(resolve)); });
  const paired = mobile.pair({ code: createPair(file), name: 'push-phone' });
  const response = await fetch(`http://127.0.0.1:${relay.server.address().port}/mobile/push`, { method: 'PUT', headers: { authorization: `Bearer ${paired.token}` }, body: '{"enabled":true}' });
  assert.equal(response.status, 200); assert.equal(registrations, 1);
  const revoked = mobile.pair({ code: createPair(file), name: 'revoked' });
  mobile.device(revoked.deviceId).observePush = true; mobile.persist(mobile.device(revoked.deviceId)); tokens.revoke(file, revoked.deviceId);
  const disabled = mobile.pair({ code: createPair(file), name: 'push-disabled' });
  mobile.persist(mobile.device(disabled.deviceId));
  const rejected = mobile.pair({ code: createPair(file), name: 'quota-rejected' });
  const uncertain = mobile.pair({ code: createPair(file), name: 'unknown-acceptance' });
  const rejectedURL = `http://127.0.0.1:${relay.server.address().port}/mobile/push`;
  const originalRegistration = push.setDevice;
  const possibleTargets = new Set();
  push.removeDevice = async id => { if (removalUnavailable) throw Error('gateway offline'); possibleTargets.delete(id); };
  removalUnavailable = true;
  push.setDevice = async id => {
    if (id === rejected.deviceId) throw Object.assign(Error('fixture quota rejection'), { status: 429, code: 'SENDER_QUOTA' });
    possibleTargets.add(id); throw Error('fixture acknowledgement lost after acceptance');
  };
  for (const [entry, status] of [[rejected, 429], [uncertain, 500]]) {
    const attempt = await fetch(rejectedURL, { method: 'PUT', headers: { authorization: `Bearer ${entry.token}` }, body: '{"enabled":true}' });
    assert.equal(attempt.status, status); assert.equal(mobile.device(entry.deviceId).observePush, false);
  }
  assert.equal(mobile.meta.devices[rejected.deviceId].pushAttempt, null);
  assert.ok(mobile.meta.devices[uncertain.deviceId].pushAttempt); assert.equal(possibleTargets.has(uncertain.deviceId), true);
  const concurrent = mobile.pair({ code: createPair(file), name: 'concurrent-registration' });
  let enteredRegistration, releaseRegistration;
  const registrationEntered = new Promise(resolve => { enteredRegistration = resolve; });
  const registrationGate = new Promise(resolve => { releaseRegistration = resolve; });
  const remoteOrder = [];
  push.setDevice = async (_id, registration) => { remoteOrder.push(registration.environment); enteredRegistration(); if (remoteOrder.length === 1) await registrationGate; };
  const firstRegistration = fetch(rejectedURL, { method: 'PUT', headers: { authorization: `Bearer ${concurrent.token}` }, body: '{"enabled":true,"environment":"sandbox"}' });
  await registrationEntered;
  const overlapping = await fetch(rejectedURL, { method: 'PUT', headers: { authorization: `Bearer ${concurrent.token}` }, body: '{"enabled":true,"environment":"production"}' });
  assert.equal(overlapping.status, 409); assert.deepEqual(remoteOrder, ['sandbox']);
  releaseRegistration(); assert.equal((await firstRegistration).status, 200);
  assert.equal((await fetch(rejectedURL, { method: 'PUT', headers: { authorization: `Bearer ${concurrent.token}` }, body: '{"enabled":true,"environment":"production"}' })).status, 200);
  assert.deepEqual(remoteOrder, ['sandbox', 'production']);
  mobile.device(concurrent.deviceId).observePush = false; mobile.persist(mobile.device(concurrent.deviceId));
  push.setDevice = originalRegistration;
  await mobile.stop(); await new Promise(resolve => relay.server.close(resolve));
  const options = { tokensFile: file, settleMs: 0, bridgeConfig: { mode: 'local' }, push, bridgeOptions: { launch: { file: 'in-memory-fixture', args: [] }, autoList: false, keepalive: false, timing: { kill: 1 },
    spawn: () => {
      starts++;
      const child = new EventEmitter(); Object.assign(child, { pid: 4242, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      child.kill = () => { child.exitCode = 0; child.emit('exit', 0, null); };
      return child;
    },
  } };
  const restarted = new MobileRelay(options);
  t.after(() => restarted.stop());
  assert.equal(starts, 1); assert.equal(registrations, 1);
  const device = restarted.devices.get(paired.deviceId);
  assert.ok(device.bridge); assert.equal(device.sockets.size, 0); assert.equal(restarted.devices.has(revoked.deviceId), false); assert.equal(restarted.devices.has(disabled.deviceId), false);
  assert.equal(restarted.devices.has(rejected.deviceId), false); assert.equal(restarted.devices.has(uncertain.deviceId), false);
  assert.ok(restarted.meta.devices[uncertain.deviceId].pushRemoval);
  await restarted.flushPush();
  removalUnavailable = false;
  restarted.pushRetryAt.delete(uncertain.deviceId); await restarted.flushPush();
  assert.equal(possibleTargets.has(uncertain.deviceId), false);
  assert.equal(restarted.meta.devices[uncertain.deviceId].pushAttempt, null);
  assert.equal(restarted.meta.devices[uncertain.deviceId].observePush, false);
  const bridge = device.bridge;
  bridge.nodes.set(JSON.stringify(['alpha', 'same']), { sid: 'same', profile: 'alpha' });
  bridge.nodes.set(JSON.stringify(['beta', 'same']), { sid: 'same', profile: 'beta' });
  assert.throws(() => bridge.nodeFor('same'), /Session profile is ambiguous; select a profile/);
  bridge.emit('requests', [{ id: 'ambiguous', rpcId: 'same', sid: null, profile: null, kind: 'approval' },
    { id: 'valid', rpcId: 'same', sid: null, profile: 'alpha', kind: 'approval', at: Date.now() }]);
  await restarted.flushPush();
  assert.equal(forwarded.length, 1); assert.equal([...device.notifications.values()][0].profile, 'alpha');
  bridge.rpcToStored.set('rpc-one', { sid: 'route-one', profile: 'alpha' });
  bridge.rpcToStored.set('rpc-two', { sid: 'route-two', profile: 'alpha' });
  for (const rpcId of ['rpc-one', 'rpc-two']) bridge._onServerFrame({ jsonrpc: '2.0', id: 'same-profile-host-id', method: 'approval', params: { session_id: rpcId, choices: ['once', 'deny'] } });
  await restarted.flushPush(); await restarted.flushPush();
  assert.deepEqual([...device.notifications.values()].map(item => item.sid).sort(), ['route-one', 'route-two', 'same']);
  const turn = { sid: 'same', profile: 'alpha', turnId: 'authoritative-turn', state: 'working', terminalAt: null };
  bridge.nodes.set(JSON.stringify(['alpha', 'same']), turn);
  bridge.emit('snapshot', { nodes: [turn] });
  bridge._onServerFrame({ jsonrpc: '2.0', method: 'event', params: { type: 'turn.complete', session_id: 'same', profile_name: 'alpha', payload: { turn_id: 'authoritative-turn', counter: 99 } } });
  bridge.emit('snapshot', { nodes: [{ ...turn, state: 'finished', terminalAt: Date.now() / 1000 }] });
  await restarted.flushPush(); await restarted.flushPush();
  assert.equal([...device.notifications.values()].filter(item => item.kind === 'done').length, 1);
  assert.equal(forwarded.filter(item => item.kind === 'done').length, 1);
  // Hold all retained records valid: half pending, half acknowledged and still tappable.
  const expiry = Date.now() + 86400000;
  for (let i = 0; device.notifications.size < 10000; i++) device.notifications.set(`e_${Date.now()}_${i.toString(16).padStart(48, '0')}`, { sid: `retained-${i}`, profile: 'alpha', kind: 'approval', expires: expiry, delivery: i % 2 ? 'pending' : 'accepted' });
  restarted.persist(device);
  const retained = [...device.notifications.keys()];
  assert.equal(retained.length, 10000);
  const result = restarted.notify(device, 'requests', [{ id: 'overflow-new', sid: 'same', profile: 'alpha', kind: 'approval', at: Date.now() }]);
  assert.equal(result.accepted, 0); assert.equal(result.overflow, 1); assert.equal(device.notificationOverflow, 1);
  assert.deepEqual([...device.notifications.keys()], retained);
  assert.equal(JSON.parse(fs.readFileSync(file + '.state', 'utf8')).devices[paired.deviceId].notifications[retained[0]].sid, 'same');
  const never = restarted.device(disabled.deviceId);
  const before = forwarded.length;
  assert.equal(restarted.notify(never, 'requests', [{ id: 'never-enrolled', sid: 'same', profile: 'alpha', kind: 'approval' }]).available, false);
  assert.equal(never.notifications.size, 0);
  const chatBridge = device.bridge;
  const live = createServer({ token: 'x'.repeat(32), mobile: restarted, model: { snapshot: () => ({}), sessions: new Map(), tokens: () => ({}) }, fleet: { data: {} }, version: 'fixture' });
  await new Promise(resolve => live.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => live.server.close(resolve)));
  const url = `http://127.0.0.1:${live.server.address().port}`;
  removalUnavailable = true;
  const optedOut = await fetch(url + '/mobile/push', { method: 'DELETE', headers: { authorization: `Bearer ${paired.token}` } });
  assert.equal(optedOut.status, 503);
  assert.equal(device.observePush, false);
  assert.equal(JSON.parse(fs.readFileSync(file + '.state', 'utf8')).devices[paired.deviceId].observePush, false);
  assert.equal(restarted.notify(device, 'requests', [{ id: 'disabled-new', sid: 'same', profile: 'alpha', kind: 'approval' }]).available, false);
  await restarted.flushPush(); assert.equal(forwarded.length, before);
  assert.deepEqual([...device.notifications.keys()], retained);
  assert.equal(device.bridge, chatBridge); assert.equal(chatBridge.stopped, false);
  assert.equal(tokens.match(file, paired.token), paired.deviceId); assert.equal(restarted.meta.revocations[paired.deviceId], undefined);
  const rejectedRemoval = device.pushRemoval;
  let cleanupEntered, releaseFailedCleanup;
  const cleanupStarted = new Promise(resolve => { cleanupEntered = resolve; });
  const cleanupHeld = new Promise(resolve => { releaseFailedCleanup = resolve; });
  push.removeDevice = async () => { cleanupEntered(); await cleanupHeld; throw Error('old cleanup still offline'); };
  restarted.pushRetryAt.delete(paired.deviceId);
  const heldCleanup = restarted.flushPush(); await cleanupStarted;
  push.setDevice = async () => { throw Object.assign(Error('replacement rejected'), { status: 429, code: 'SENDER_QUOTA' }); };
  const replacement = fetch(url + '/mobile/push', { method: 'PUT', headers: { authorization: `Bearer ${paired.token}` }, body: '{"enabled":true}' });
  const waitUntil = Date.now() + 1000;
  while (!device.registrationBusy && Date.now() < waitUntil) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(device.registrationBusy, true); assert.equal(device.pushRemoval, rejectedRemoval);
  releaseFailedCleanup(); await heldCleanup;
  assert.equal((await replacement).status, 429);
  assert.equal(device.pushRemoval, rejectedRemoval); assert.equal(device.observePush, false);
  const oldRemoval = device.pushRemoval;
  assert.ok(oldRemoval);
  let releaseOld;
  const oldGate = new Promise(resolve => { releaseOld = resolve; });
  push.removeDevice = async () => oldGate;
  restarted.pushRetryAt.set(paired.deviceId, Date.now() + 60000);
  const oldAcknowledgement = restarted.pushOne(paired.deviceId);
  const newRemoval = device.pushRemoval = crypto.randomBytes(24).toString('hex');
  restarted.persist(device);
  releaseOld(); await oldAcknowledgement;
  assert.equal(device.pushRemoval, newRemoval); assert.notEqual(device.pushRemoval, oldRemoval);
  assert.equal(JSON.parse(fs.readFileSync(file + '.state', 'utf8')).devices[paired.deviceId].pushRemoval, newRemoval);
  await restarted.stop(); await new Promise(resolve => live.server.close(resolve));
  let cleanupRetries = 0;
  removalUnavailable = false;
  push.removeDevice = async id => { assert.equal(id, paired.deviceId); cleanupRetries++; };
  const recovered = new MobileRelay({ ...options, bridgeConfig: { mode: 'off' } });
  t.after(() => recovered.stop());
  await recovered.flushPush();
  assert.equal(cleanupRetries, 1); assert.equal(recovered.meta.devices[paired.deviceId].pushRemoval, null);
  assert.equal(recovered.meta.devices[paired.deviceId].observePush, false);
  assert.deepEqual(Object.keys(recovered.meta.devices[paired.deviceId].notifications), retained);
  assert.equal(tokens.match(file, paired.token), paired.deviceId);
  assert.equal(recovered.meta.revocations[paired.deviceId], undefined);
  const pushOff = new MobileRelay({ ...options, push: { configured: false } }); await pushOff.stop(); assert.equal(starts, 1);
  const bridgeOff = new MobileRelay({ ...options, bridgeConfig: { mode: 'off' } }); await bridgeOff.stop(); assert.equal(starts, 1);
});
test('held upload send keeps the shared byte quota reserved until success, cancellation or revoke settles', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-upload-reservation-')), file = path.join(dir, 'devices.json');
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'local' } });
  t.after(() => mobile.stop());
  const paired = mobile.pair({ code: createPair(file), name: 'phone' }), device = mobile.device(paired.deviceId), chunk = 25 * 1024 * 1024;
  const stage = (name, ready = true) => { const ticket = mobile.createUpload(device, { name, mime: 'application/octet-stream', size: chunk }); if (ready) device.uploads.get(ticket.id).bytes = Buffer.alloc(chunk); return ticket.id; };
  let resolveSend, rejectSend, retainedFiles;
  const held = () => new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
  device.bridge = { send: (_sid, _text, options) => { retainedFiles = options.files; return held(); }, stop: async () => { rejectSend?.(Error('revoked')); } };
  const refs = [stage('one.bin'), stage('two.bin')];
  const sending = mobile.call(device, { id: mutationID(), op: 'send', args: { sid: 'session', profile: 'default', text: 'fixture', uploads: refs } });
  assert.equal(device.uploads.size, 0); assert.equal(device.inflightBytes, 2 * chunk); assert.equal(retainedFiles.length, 2);
  assert.throws(() => mobile.createUpload(device, { name: 'refill.bin', mime: 'application/octet-stream', size: 1 }), error => error.code === 'limit');
  assert.throws(() => mobile.upload(device, refs[0]), error => error.code === 'not_found');
  resolveSend({ status: 'ok' }); await sending; retainedFiles = null;
  assert.equal(device.inflightBytes, 0);
  const next = stage('next.bin');
  const cancelled = mobile.call(device, { id: mutationID(), op: 'send', args: { sid: 'session', text: 'fixture', uploads: [next] } });
  const refill = stage('refill.bin', false);
  assert.equal(device.inflightBytes, chunk);
  assert.throws(() => mobile.createUpload(device, { name: 'over.bin', mime: 'application/octet-stream', size: 1 }), error => error.code === 'limit');
  device.uploads.delete(refill); // staged cancellation frees only its own reservation, not the send's.
  assert.equal(device.inflightBytes, chunk);
  rejectSend(Error('cancelled')); await assert.rejects(cancelled, /cancelled/); retainedFiles = null;
  assert.equal(device.inflightBytes, 0);
  const last = stage('last.bin');
  const revoked = mobile.call(device, { id: mutationID(), op: 'send', args: { sid: 'session', text: 'fixture', uploads: [last] } });
  const failure = assert.rejects(revoked, /revoked/);
  await mobile.revoke(device); await failure; retainedFiles = null;
  assert.equal(device.inflightBytes, 0); assert.equal(mobile.devices.has(paired.deviceId), false);
});
test('review20 short terminal turn and precise request arrival identities survive repeated feeds and restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-notification-identity-')), file = path.join(dir, 'devices.json');
  const delivered = [];
  const push = { configured: true, removeDevice: async () => {}, notify: async (target, event) => delivered.push({ target, ...event }) };
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'off' }, push });
  const paired = mobile.pair({ code: createPair(file), name: 'phone' }), device = mobile.device(paired.deviceId);
  device.observePush = true; mobile.persist(device);
  let node = { sid: 'session', profile: 'default', state: 'finished', turnId: 'first-turn', terminalAt: Date.now() / 1000 };
  device.bridge = { nodeFor: () => node, stop: async () => {} };
  mobile.notify(device, 'snapshot', { nodes: [node] });
  assert.equal(mobile.notify(device, 'native', { type: 'turn.complete', sid: 'session', profile: 'default', payload: { turn_id: 'fast-second-turn' } }).skipped, 1);
  node = { ...node, turnId: 'fast-second-turn' }; // No intermediate working snapshot was observed.
  assert.equal(mobile.notify(device, 'snapshot', { nodes: [node] }).accepted, 1); await mobile.flushPush();
  mobile.notify(device, 'snapshot', { nodes: [node] });
  mobile.notify(device, 'native', { type: 'turn.complete', sid: 'session', profile: 'default', payload: { turn_id: 'fast-second-turn' } });
  await mobile.flushPush(); assert.equal(delivered.filter(event => event.kind === 'done').length, 1);
  const createdAt = Math.floor(Date.now() / 1000) + 0.123456;
  const original = { id: 'same-host-request', rpcId: 'runtime-session', sid: 'session', profile: 'default', kind: 'approval', createdAt };
  assert.equal(mobile.notify(device, 'requests', [original]).accepted, 1); await mobile.flushPush();
  assert.equal(mobile.notify(device, 'requests', [{ ...original, at: Date.now() + 1000 }]).duplicate, 1);
  const replacement = { ...original, createdAt: createdAt + 0.000001 };
  assert.equal(Math.floor(original.createdAt * 1000), Math.floor(replacement.createdAt * 1000));
  assert.equal(mobile.notify(device, 'requests', [replacement]).accepted, 1); await mobile.flushPush();
  assert.equal(delivered.filter(event => event.kind === 'approval').length, 2);
  const retainedIDs = [...device.notifications.keys()]; await mobile.stop();
  const restarted = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'off' }, push }); t.after(() => restarted.stop());
  const restored = restarted.device(paired.deviceId);
  assert.equal(restarted.notify(restored, 'requests', [{ ...replacement, at: Date.now() + 2000 }]).duplicate, 1);
  await restarted.flushPush(); assert.deepEqual([...restored.notifications.keys()], retainedIDs);
  assert.equal(delivered.filter(event => event.kind === 'approval').length, 2);
});

test('0.2.1 mobile history strips injected context and scopes opaque user media', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-media-'));
  const mobile = new MobileRelay({ tokensFile: path.join(dir, 'devices.json'), bridgeConfig: { mode: 'off' } });
  t.after(() => mobile.stop());
  const paired = mobile.pair({ code: createPair(mobile.tokensFile), name: 'phone' });
  const device = mobile.device(paired.deviceId);
  mobile.bridge = () => ({ history: async () => ({ messages: [
    { role: 'user', text: 'caption\n@image:/srv/photo.png\n<memory-context>private injected text</memory-context>' },
    { role: 'assistant', text: 'answer', think: 'stored reasoning' }
  ], offset: 40, hasMore: false }) });
  const result = await mobile.call(device, { id: 'media-read', op: 'history', args: { sid: 'same', profile: 'alpha' } });
  assert.equal(result.messages[0].text, 'caption');
  assert.equal(result.messages[1].think, 'stored reasoning');
  const attachment = result.messages[0].media[0];
  assert.deepEqual({ kind: attachment.kind, name: attachment.name }, { kind: 'image', name: 'photo.png' });
  assert.match(attachment.ref, /^[a-f0-9]{16}$/);
  assert.equal(mobile.offers(device).pathOf(JSON.stringify(['alpha', 'same']), attachment.ref), '/srv/photo.png');
  assert.equal(mobile.offers(device).pathOf(JSON.stringify(['beta', 'same']), attachment.ref), null);
  assert.ok(!JSON.stringify(result).includes('/srv/') && !JSON.stringify(result).includes('private injected'));
});

test('notification previews: plain-text title/body stored on the relay, served to the paired device only, gateway payload stays content-free', async t => {
  const { previewText, notificationBody, conversationTitle } = require('../src/mobile');
  assert.equal(previewText('**Done!** See [the report](https://x.example/a) now.\n\n```js\nsecret()\n```\n- second *line* here\nthird line'), 'Done! See the report now.\nsecond line here\nthird line');
  assert.equal(previewText('# Heading\n> quoted\nthird'), 'Heading\nquoted\nthird');
  assert.equal(previewText('x'.repeat(500)).length, 300);
  assert.ok(previewText('x'.repeat(500)).endsWith('\u2026'));
  assert.equal(previewText('a\u0000b\u202ec'), 'a b c');
  assert.equal(previewText(42), ''); assert.equal(previewText(''), '');
  assert.equal(notificationBody('approval', { command: 'rm -rf /tmp/x', description: '' }), 'rm -rf /tmp/x');
  assert.equal(notificationBody('approval', { command: 'rm', description: 'Delete the build folder' }), 'Delete the build folder');
  assert.equal(notificationBody('question', { questions: [{ question: 'Which branch?' }] }), 'Which branch?');
  assert.equal(notificationBody('error', { payload: { error: 'Rate limit hit' } }), 'Rate limit hit');
  assert.equal(conversationTitle({ nodeFor: () => ({ title: '  Plan\nthe trip ' }) }, 's', 'default'), 'Plan the trip');
  assert.equal(conversationTitle({ nodeFor: () => ({ title: '' }), recent: [{ id: 's', profile: 'default', title: 'From list' }] }, 's', 'default'), 'From list');
  assert.equal(conversationTitle({ nodeFor: () => { throw Error('ambiguous'); } }, 's', 'research'), 'research');

  const http = require('node:http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-preview-')), file = path.join(dir, 'devices.json');
  const sent = [];
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'off' }, push: { configured: true, notify: async (target, event) => sent.push({ target, ...event }), removeDevice: async () => {} } });
  const relay = createServer({ token: 'x'.repeat(32), mobile, model: { snapshot: () => ({}), sessions: new Map(), tokens: () => ({}) }, fleet: { data: {} }, version: 'test' });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await mobile.stop(); await new Promise(resolve => relay.server.close(resolve)); });
  const url = `http://127.0.0.1:${relay.server.address().port}`;
  const first = mobile.pair({ code: createPair(file), name: 'phone' }), other = mobile.pair({ code: createPair(file), name: 'tablet' });
  const device = mobile.device(first.deviceId);
  device.observePush = true; mobile.persist(device);
  device.bridge = { nodeFor: () => ({ title: 'Trip planning', turnId: 'turn-1' }), stop: async () => {} };
  mobile.notify(device, 'native', { type: 'message.complete', sid: 'sid-a', profile: 'research', payload: { text: 'Your flights are booked.\nHotel next.\nThird line.' } });
  mobile.notify(device, 'native', { type: 'turn.complete', sid: 'sid-a', profile: 'research', payload: { turn_id: 'turn-1' } });
  mobile.notify(device, 'requests', [{ id: 'req-1', sid: 'sid-a', profile: 'research', kind: 'approval', at: Date.now(), command: 'git push origin main', description: 'Push the release branch' }]);
  await mobile.flushPush(); await mobile.flushPush(); await mobile.flushPush();
  assert.equal(sent.length, 2); // reply + done of one turn are one banner
  for (const event of sent) assert.deepEqual(Object.keys(event).sort(), ['id', 'kind', 'target']);
  assert.ok(!JSON.stringify(sent).includes('flights') && !JSON.stringify(sent).includes('Trip planning'));
  const get = async (id, token) => fetch(`${url}/mobile/notifications/${id}`, { headers: { authorization: `Bearer ${token}` } });
  const byKind = Object.fromEntries(sent.map(event => [event.kind, event.id]));
  const reply = await (await get(byKind.reply, first.token)).json();
  assert.deepEqual(reply, { sid: 'sid-a', profile: 'research', kind: 'reply', title: 'Trip planning', body: 'Your flights are booked.\nHotel next.\nThird line.', agent: 'Research' });
  const approval = await (await get(byKind.approval, first.token)).json();
  assert.equal(approval.body, 'Push the release branch'); assert.equal(approval.kind, 'approval');
  assert.equal((await get(byKind.reply, other.token)).status, 404); // another device cannot read it
  assert.equal((await get(byKind.reply, 'wrong')).status, 401);
  // Content is stored in the owner's private state file only, never in the tokens file.
  assert.ok(!fs.readFileSync(file, 'utf8').includes('flights'));
  assert.ok(fs.readFileSync(file + '.state', 'utf8').includes('Trip planning'));
  // Old persisted items (no title/body) still serve with a safe fallback.
  const legacy = [...device.notifications.entries()].find(([, item]) => item.kind === 'approval');
  delete legacy[1].title; delete legacy[1].body; delete legacy[1].agent;
  assert.deepEqual(await (await get(legacy[0], first.token)).json(), { sid: 'sid-a', profile: 'research', kind: 'approval', title: 'Research', body: '', agent: 'Research' });
});

function notifyFixture(t, { bridge, settleMs = 0, kinds } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-notify2-')), file = path.join(dir, 'devices.json'), sent = [];
  const mobile = new MobileRelay({ tokensFile: file, settleMs, bridgeConfig: { mode: 'off' }, push: { configured: true, notify: async (target, event) => sent.push({ target, ...event }), removeDevice: async () => {} } });
  t.after(() => mobile.stop());
  const paired = mobile.pair({ code: createPair(file), name: 'phone' }), device = mobile.device(paired.deviceId);
  device.observePush = true; if (kinds) device.pushKinds = kinds; mobile.persist(device);
  device.bridge = { stop: async () => {}, ...bridge };
  return { mobile, device, sent, paired };
}
const bodyOf = (device, kind) => [...device.notifications.values()].find(item => item.kind === kind);

test('notify2: a done without message text reads the last assistant message of the session; agent is the display name, never default', async t => {
  const history = [];
  const { mobile, device, sent } = notifyFixture(t, { settleMs: 2000, bridge: {
    nodeFor: () => ({ title: 'Morning check-in', turnId: 't1' }),
    profiles: async () => [{ name: 'default', displayName: 'Atlas' }, { name: 'ada', displayName: 'Ada' }],
    history: async (sid, args) => { history.push({ sid, ...args }); return { messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'Good morning, I am here.\nWhat are we working on today?' }, { role: 'user', text: 'x' }] }; },
  } });
  await mobile.refreshNames(device.bridge);
  mobile.notify(device, 'snapshot', { nodes: [{ sid: 's1', profile: 'default', state: 'working', turnId: 't1' }] });
  mobile.notify(device, 'snapshot', { nodes: [{ sid: 's1', profile: 'default', state: 'finished', turnId: 't1', terminalAt: Date.now() / 1000 }] });
  await mobile.flushPush(); assert.equal(sent.length, 0, 'held while the reply is being read');
  await new Promise(resolve => setTimeout(resolve, 60));
  await mobile.flushPush();
  assert.equal(sent.length, 1);
  assert.deepEqual(history[0], { sid: 's1', profile: 'default', limit: 12, offset: 0 });
  const item = bodyOf(device, 'done');
  assert.deepEqual([item.title, item.agent, item.body], ['Morning check-in', 'Atlas', 'Good morning, I am here.\nWhat are we working on today?']);
});

test('notify2: a failed history read still sends after the hold with a display-name agent; reply then done is one banner', async t => {
  const { mobile, device, sent } = notifyFixture(t, { settleMs: 30, bridge: { nodeFor: () => ({ title: 'T' }), history: async () => { throw new Error('down'); } } });
  mobile.notify(device, 'snapshot', { nodes: [{ sid: 's2', profile: 'default', state: 'working', turnId: 't' }] });
  mobile.notify(device, 'snapshot', { nodes: [{ sid: 's2', profile: 'default', state: 'finished', turnId: 't' }] });
  await new Promise(resolve => setTimeout(resolve, 120)); await mobile.flushPush();
  assert.equal(sent.length, 1);
  assert.equal(bodyOf(device, 'done').agent, 'Hermes'); // roster unknown: friendly fallback, not 'default'
  // reply (with text) first, then the snapshot done of the same turn: still one notification
  mobile.notify(device, 'native', { type: 'message.complete', sid: 's3', profile: 'default', payload: { text: 'All done here.' } });
  mobile.notify(device, 'snapshot', { nodes: [{ sid: 's3', profile: 'default', state: 'working', turnId: 'u' }] });
  mobile.notify(device, 'snapshot', { nodes: [{ sid: 's3', profile: 'default', state: 'finished', turnId: 'u' }] });
  await mobile.flushPush();
  assert.equal([...device.notifications.values()].filter(item => item.sid === 's3').length, 1);
  assert.equal(sent.length, 2);
});

test('notify2: done first and reply text later fill the same banner; a reply seen under the runtime id before the sid is bound is found', async t => {
  const bound = new Map();
  const { mobile, device, sent } = notifyFixture(t, { settleMs: 0, bridge: { nodeFor: (id) => (id === 'new-sid' ? { rpcId: 'rpc-1', title: 'Fresh chat' } : null), rpcToStored: bound } });
  // first-turn message.complete arrives before the sid is bound: remembered under the runtime id only
  mobile.notify(device, 'native', { type: 'message.complete', rpcId: 'rpc-1', profile: 'default', payload: { text: 'First answer.' } });
  assert.equal(sent.length, 0);
  bound.set('rpc-1', { sid: 'new-sid', profile: 'default' });
  mobile.notify(device, 'snapshot', { nodes: [{ sid: 'new-sid', profile: 'default', state: 'working', turnId: 'k' }] });
  mobile.notify(device, 'snapshot', { nodes: [{ sid: 'new-sid', profile: 'default', state: 'finished', turnId: 'k' }] });
  await mobile.flushPush();
  assert.equal(bodyOf(device, 'done').body, 'First answer.');
  // done admitted without text, then the reply text arrives: the existing banner is completed, not duplicated
  const second = notifyFixture(t, { settleMs: 5000, bridge: { nodeFor: () => ({ title: 'C' }) } });
  second.mobile.notify(second.device, 'snapshot', { nodes: [{ sid: 'x', profile: 'default', state: 'working', turnId: 'k' }] });
  second.mobile.notify(second.device, 'snapshot', { nodes: [{ sid: 'x', profile: 'default', state: 'finished', turnId: 'k' }] });
  second.mobile.notify(second.device, 'native', { type: 'message.complete', sid: 'x', profile: 'default', payload: { text: 'Late text' } });
  assert.equal([...second.device.notifications.values()].length, 1);
  assert.equal(bodyOf(second.device, 'done').body, 'Late text');
  assert.equal(bodyOf(second.device, 'done').hold, undefined);
});

test('notify2: a subagent notification shows the parent conversation and its own name with the parent agent', async t => {
  const nodes = { child: { title: 'Release audit subagent', parent: 'root', subagentId: 'sa-1', role: 'subagent' }, root: { title: 'Release audit' } };
  const { mobile, device } = notifyFixture(t, { bridge: { nodeFor: sid => nodes[sid] || null, profiles: async () => [{ name: 'default', displayName: 'Atlas' }] } });
  await mobile.refreshNames(device.bridge);
  mobile.notify(device, 'native', { type: 'message.complete', sid: 'child', profile: 'default', payload: { text: 'Audit finished.' } });
  const item = bodyOf(device, 'reply');
  assert.deepEqual([item.title, item.agent, item.body], ['Release audit', 'Release audit subagent \u00b7 Atlas', 'Audit finished.']);
});

test('notify2: dictation language is an optional allowlisted argument, advertised in capabilities, never defaulted', async t => {
  const calls = [];
  const { mobile, device } = notifyFixture(t, { bridge: { transcribe: async (bytes, mime, options) => { calls.push({ mime, options }); return { text: 'merhaba' }; } } });
  assert.equal(mobile.capabilities().transcribeLanguage, true);
  const upload = async () => { const ticket = mobile.createUpload(device, { name: 'd.m4a', mime: 'audio/mp4', size: 3 }); const item = mobile.upload(device, ticket.id); item.bytes = Buffer.from('abc'); return ticket.id; };
  mobile.bridge = () => device.bridge;
  await mobile.call(device, { id: 'm.' + Date.now() + '.' + crypto.randomUUID(), op: 'transcribe', args: { upload: await upload(), mime: 'audio/mp4' } });
  await mobile.call(device, { id: 'm.' + Date.now() + '.' + crypto.randomUUID(), op: 'transcribe', args: { upload: await upload(), mime: 'audio/mp4', language: 'tr-TR' } });
  assert.deepEqual(calls.map(call => call.options), [undefined, { language: 'tr' }]);
  await assert.rejects(mobile.call(device, { id: 'm.' + Date.now() + '.' + crypto.randomUUID(), op: 'transcribe', args: { upload: await upload(), language: '../x' } }), /language/);
});

test('POST /fleet/quotas/refresh: relay token and mobile token allowed, other POSTs stay denied', async () => {
  let calls = 0;
  const fleet = { data: { quotas: { claude: { ok: true } }, profiles: {} }, refreshQuotas: async () => { calls++; return { refreshed: true, throttled: false, timedOut: false, retryAfterS: 0, fleet: fleet.data }; } };
  const mobile = { onHttp: () => false, authenticate: req => req.headers.authorization === 'Bearer mobile' ? { id: 'd1' } : null };
  const token = 'x'.repeat(32);
  const relay = createServer({ token, mobile, model: { snapshot: () => ({}), sessions: new Map(), tokens: () => ({}) }, fleet, version: 'test' });
  await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  try {
    const asMobile = await fetch(base + '/fleet/quotas/refresh', { method: 'POST', headers: { authorization: 'Bearer mobile' } });
    assert.equal(asMobile.status, 200);
    const body = await asMobile.json();
    assert.equal(body.ok, true); assert.equal(body.refreshed, true); assert.deepEqual(body.quotas, { claude: { ok: true } });
    const asRelay = await fetch(base + '/fleet/quotas/refresh', { method: 'POST', headers: { authorization: 'Bearer ' + token } });
    assert.equal(asRelay.status, 200);
    assert.equal(calls, 2);
    assert.equal((await fetch(base + '/fleet/quotas/refresh', { method: 'POST' })).status, 401);
    assert.equal((await fetch(base + '/fleet/quotas/refresh', { method: 'GET', headers: { authorization: 'Bearer mobile' } })).status, 403);
    assert.equal((await fetch(base + '/fleet/other', { method: 'POST', headers: { authorization: 'Bearer mobile' } })).status, 403);
  } finally { relay.server.close(); }
});
