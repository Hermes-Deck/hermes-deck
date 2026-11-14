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

test('W5: the op log has one line per refused or failed op, bridge status lines and a summary; never text', async t => {
  const { OpLog } = require('../src/oplog');
  const { mobile, device, logs } = relayWith(t, {
    send: () => new Promise(() => {}),
    sessions: async () => [{ id: 'session-secret-title', title: 'A private title' }],
    history: async () => { throw Object.assign(new Error('The Hermes request timed out; it may have completed.'), { kind: 'timeout' }); },
  });
  mobile.gateOptions = { limit: 1, queue: 0, waitMs: 10 };
  const secret = 'PRIVATE-MESSAGE-TEXT';
  mobile.call(device, { id: mutationID(), op: 'send', args: { sid: 'session-0123456789abcdef', profile: 'atlas', text: secret } }).catch(() => {});
  await outcome(mobile.call(device, { id: mutationID(), op: 'send', args: { sid: 'session-0123456789abcdef', profile: 'atlas', text: secret } }));
  device.gate.limit = 8;
  await mobile.call(device, { id: 'ok-read', op: 'sessions' });
  await outcome(mobile.call(device, { id: 'slow-read', op: 'history', args: { sid: 'session-0123456789abcdef', profile: 'atlas' } }));
  const ops = logs.filter(l => l.t === 'mobile.op');
  assert.equal(ops.length, 2, 'only the refused and the failed op are logged');
  assert.deepEqual(ops.map(l => [l.op, l.code, l.sid]), [['send', 'busy', 'session-'], ['history', 'timeout', 'session-']]);
  assert.equal(ops[0].inFlight, 1);
  assert.ok(ops.every(l => typeof l.ms === 'number' && typeof l.pending === 'number' && typeof l.uncertain === 'boolean' && l.device.length <= 6));
  const text = JSON.stringify(logs);
  for (const forbidden of [secret, 'A private title', 'session-0123456789', device.id]) assert.ok(!text.includes(forbidden), forbidden);
  // status lines and the summary
  const sink = [];
  const log = new OpLog({ sink: line => sink.push(JSON.parse(line)), summaryMs: 3600000 });
  t.after(() => log.stop());
  log.status(device, { status: 'offline', code: 'exit', error: 'ssh: host.example refused' }, 3);
  for (const ms of [5, 10, 20, 400]) log.op({ device, op: 'history', ms, gate: { active: 2, waiting: 0 }, pending: 4 });
  const summary = log.flush();
  assert.deepEqual(sink[0], { at: sink[0].at, t: 'mobile.bridge', device: device.id.slice(-6), status: 'offline', code: 'exit', pending: 3 });
  assert.ok(!JSON.stringify(sink).includes('host.example'));
  assert.deepEqual({ ...summary, windowMs: 0 }, { t: 'mobile.summary', windowMs: 0, ops: 4, failed: 0, busy: 0, p95Ms: 400, maxPending: 4, maxInFlight: 2 });
  assert.equal(log.flush(), null, 'no summary for an empty window');
});

test('W6: a repeated mutation id answers the first outcome: result, pending, certain failure; uncertain stays duplicate', async t => {
  let creates = 0, release;
  const { mobile, device } = relayWith(t, {
    create: () => { creates++; return new Promise(resolve => { release = () => resolve({ sid: 'session-new', profile: 'atlas' }); }); },
    send: async () => { throw Object.assign(new Error('The Hermes request timed out; it may have completed.'), { kind: 'timeout' }); },
    deleteSession: async () => { throw Object.assign(new Error('This session is running; stop it first.'), { kind: 'stale' }); },
  });
  assert.equal(mobile.capabilities().replay, true);
  const id = mutationID();
  const first = mobile.call(device, { id, op: 'create', args: { profile: 'atlas' } });
  const meanwhile = await outcome(mobile.call(device, { id, op: 'create', args: { profile: 'atlas' } }));
  assert.deepEqual([meanwhile.error.code, meanwhile.error.uncertain], ['pending', true]);
  release();
  const one = await first;
  const meta = {};
  const two = await mobile.call(device, { id, op: 'create', args: { profile: 'atlas' } }, meta);
  assert.deepEqual(two, one);
  assert.notEqual(two, one, 'a copy, never the stored object');
  assert.equal(meta.replayed, true);
  assert.equal(creates, 1);
  // a certain failure is answered again, marked replayed
  const del = mutationID();
  const firstDelete = await outcome(mobile.call(device, { id: del, op: 'delete', args: { sid: 'session-a', profile: 'atlas' } }));
  const againDelete = await outcome(mobile.call(device, { id: del, op: 'delete', args: { sid: 'session-a', profile: 'atlas' } }));
  assert.deepEqual([firstDelete.error.code, againDelete.error.code, againDelete.error.replayed], ['stale', 'stale', true]);
  // an uncertain failure is not replayed: outcome unknown -> duplicate (refresh, never resend)
  const sent = mutationID();
  assert.equal((await outcome(mobile.call(device, { id: sent, op: 'send', args: { sid: 'session-a', profile: 'atlas', text: 'x' } }))).error.code, 'timeout');
  assert.equal((await outcome(mobile.call(device, { id: sent, op: 'send', args: { sid: 'session-a', profile: 'atlas', text: 'x' } }))).error.code, 'duplicate');
});

test('W6: replay memory keeps the last 256 outcomes for 10 minutes', () => {
  const { ReplayMemory } = require('../src/mobile-gate');
  let now = 0;
  const memory = new ReplayMemory({ now: () => now });
  for (let i = 0; i < 300; i++) { memory.begin(`m${i}`); memory.settle(`m${i}`, true, { i }); }
  assert.equal(memory.get('m0'), undefined);
  assert.deepEqual(memory.get('m299').result, { i: 299 });
  assert.equal(memory.entries.size, 256);
  now = 600001;
  assert.equal(memory.get('m299'), undefined);
  memory.begin('big'); memory.settle('big', true, { text: 'x'.repeat(70000) });
  assert.equal(memory.get('big'), undefined, 'an oversized result is not kept: the receipt answers duplicate');
});

/** The relay behind a real HTTP server (createServer), with a stub bridge on the paired device. */
async function served(t, stub) {
  const { createServer } = require('../src/server');
  const ctx = relayWith(t, stub);
  const relay = createServer({ token: 'x'.repeat(32), mobile: ctx.mobile, model: { snapshot: () => ({}), sessions: new Map(), tokens: () => ({}) }, fleet: { data: {} }, version: 'test' });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => relay.server.close(resolve)));
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  const post = async (body, token = ctx.paired.token) => {
    const response = await fetch(`${base}/mobile/op`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { ...ctx, post, base };
}

test('W7: POST /mobile/op runs the same handler as the socket: receipts, replay, allow-list, 200 + ok:false, seen hook', async t => {
  let answers = 0;
  const { mobile, device, post } = await served(t, {
    listRequests: () => [{ id: 'request-1', profile: 'atlas', kind: 'approval' }],
    answerApproval: async () => { answers++; return { status: 'ok' }; },
    profiles: async () => [{ name: 'atlas' }],
    avatar: async () => ({ found: true, url: 'data:image/png;base64,AAAA', mime: 'image/png', raster: false }),
  });
  const seen = [];
  mobile.deviceSeen = (d, reason) => seen.push([d.id, reason]);
  assert.deepEqual(mobile.capabilities().httpOps, { v: 1, ops: ['answerApproval', 'answerQuestion', 'send', 'create', 'createBotChat', 'interrupt', 'sessions', 'botChat', 'profiles', 'start', 'avatar', 'searchMessages'] });
  const id = mutationID();
  const body = { id, op: 'answerApproval', args: { id: 'request-1', profile: 'atlas', choice: 'once' }, waitMs: 0 };
  const first = await post(body);
  assert.deepEqual(first, { status: 200, body: { t: 'response', id, ok: true, result: { status: 'ok' } } });
  const again = await post(body);
  assert.deepEqual(again.body, { t: 'response', id, ok: true, result: { status: 'ok' }, replayed: true });
  assert.equal(answers, 1);
  assert.equal(device.ids.has(id), true, 'the same receipt table as the socket');
  assert.deepEqual(seen, [[device.id, 'op'], [device.id, 'op']]);
  const read = await post({ id: 'read-1', op: 'profiles' });
  assert.deepEqual(read.body.result, [{ name: 'atlas' }]);
  const avatar = await post({ id: 'read-avatar', op: 'avatar', args: { name: 'atlas' } });
  assert.deepEqual(avatar.body.result, { found: true, url: 'data:image/png;base64,AAAA', mime: 'image/png', raster: false }, 'the notification extension reads the agent picture over HTTP');
  assert.equal(seen.length, 2, 'reads do not count as seen');
  const refused = await post({ id: 'read-2', op: 'history', args: { sid: 'session-a', profile: 'atlas' } });
  assert.deepEqual([refused.status, refused.body.ok, refused.body.error.code], [200, false, 'operation']);
  const extra = await post({ id: 'read-3', op: 'profiles', t: 'request' });
  assert.deepEqual([extra.status, extra.body.error.code], [200, 'bad_request']);
  const badWait = await post({ id: 'read-4', op: 'profiles', waitMs: 20001 });
  assert.equal(badWait.body.error.code, 'bad_request');
  const noId = await post({ op: 'profiles' });
  assert.deepEqual([noId.status, noId.body.ok, noId.body.error.code, 'id' in noId.body], [200, false, 'bad_request', false]);
  assert.equal((await post({ id: 'x', op: 'profiles' }, 'not-a-token')).status, 401);
  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post({ id: 'x', op: 'profiles', args: { pad: 'x'.repeat(70000) } })).status, 413);
});

test('W7: waitMs holds the op until the bridge is open; without it an offline bridge answers offline at once', async t => {
  const { EventEmitter } = require('node:events');
  const bridge = Object.assign(new EventEmitter(), { status: { status: 'connecting' }, pending: new Map(), stop: async () => {}, listRequests: () => [],
    sessions: async () => { if (bridge.status.status !== 'open') throw Object.assign(new Error(i18nText('U0030')), { kind: 'offline' }); return [{ id: 'session-a' }]; } });
  const { device, post } = await served(t, {});
  device.bridge = bridge;
  const offline = await post({ id: 'r-1', op: 'sessions' });
  assert.deepEqual([offline.body.ok, offline.body.error.code, offline.body.error.uncertain], [false, 'offline', false]);
  setTimeout(() => { bridge.status = { status: 'open' }; bridge.emit('status', bridge.status); }, 50);
  const started = Date.now();
  const waited = await post({ id: 'r-2', op: 'sessions', waitMs: 5000 });
  assert.equal(waited.body.ok, true);
  assert.ok(Date.now() - started < 2000);
  assert.equal(bridge.listenerCount('status'), 0, 'the wait leaves no listener behind');
});

test('W8: start is one op (create + first message); replay keeps it single; an unknown outcome names the session', async t => {
  const starts = [];
  const { mobile, device, post } = await served(t, {
    startChat: async args => { starts.push(args); if (args.text === 'lost') throw Object.assign(new Error('timed out'), { kind: 'timeout', session: { sid: 'session-9', profile: 'atlas' } }); return { sid: 'session-1', profile: 'atlas', status: 'ok' }; },
  });
  assert.equal(mobile.capabilities().start, true);
  const id = mutationID();
  const first = await mobile.call(device, { id, op: 'start', args: { profile: 'atlas', text: 'hello' } });
  assert.deepEqual(first, { sid: 'session-1', profile: 'atlas', status: 'ok' });
  assert.deepEqual(starts, [{ profile: 'atlas', text: 'hello', files: [] }]);
  const http = await post({ id, op: 'start', args: { profile: 'atlas', text: 'hello' } });
  assert.deepEqual([http.body.ok, http.body.replayed, http.body.result.sid], [true, true, 'session-1']);
  assert.equal(starts.length, 1);
  const lost = await outcome(mobile.call(device, { id: mutationID(), op: 'start', args: { profile: 'atlas', text: 'lost' } }));
  assert.deepEqual([lost.error.code, lost.error.uncertain, lost.error.session], ['timeout', true, { sid: 'session-9', profile: 'atlas' }]);
  for (const args of [{ text: 'x' }, { profile: 'atlas', text: 'x', sid: 'session-1' }]) {
    assert.equal((await outcome(mobile.call(device, { id: mutationID(), op: 'start', args }))).error.code, 'bad_request');
  }
});
