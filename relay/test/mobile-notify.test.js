'use strict';
// Phone notifications through MobileRelay: kinds (R14), one banner per turn (R11), scope (R12/D13), the breaker (D9),
// seen, policy, collapse/digest, the notification record and the test push. Fake clock and stub gateway only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MobileRelay, createPair } = require('../src/mobile');
const mutation = clock => `m.${clock ? clock() : Date.now()}.${crypto.randomUUID()}`;

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
function fakeClock(start = Date.now()) {
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

test('D13 scope mine: untouched chats stay quiet, a send or an opened history makes them mine for 12 h, approvals always', async t => {
  const clock = fakeClock(), nodes = {};
  const node = (sid, extra = {}) => (nodes[sid] = { sid, profile: 'default', title: 'Chat', turnId: 't0', ...extra });
  const bridge = { nodeFor: sid => nodes[sid] || null, send: async () => ({ ok: true }), history: async () => ({ messages: [] }), rpcToStored: new Map() };
  const { mobile, device, sent, logs } = fixture(t, { now: clock, settleMs: 0, bridge });
  mobile.bridge = () => device.bridge;
  node('auto');
  for (let i = 1; i <= 10; i++) { nodes.auto.turnId = `t${i}`; await turn(clock, mobile, device, 'auto', `t${i}`, { count: 1, gap: 1000 }); }
  assert.equal(sent.length, 0, 'ten turns of an autonomous chat: nothing');
  assert.ok(logs.some(line => line.decision === 'scoped-out' && line.sid === 'auto' && line.kind === 'done'));
  mobile.notify(device, 'requests', [{ id: 'r1', sid: 'auto', profile: 'default', kind: 'approval', at: clock(), command: 'ls', description: 'List' }]);
  await flush(mobile);
  assert.deepEqual(sent.map(event => event.kind), ['approval'], 'an approval comes from any chat');
  await mobile.call(device, { id: mutation(), op: 'send', args: { sid: 'auto', profile: 'default', text: 'take a look' } });
  nodes.auto.turnId = 't11';
  await turn(clock, mobile, device, 'auto', 't11', { count: 2, gap: 1000 });
  assert.deepEqual(sent.map(event => event.kind), ['approval', 'done'], 'after one send the chat is mine');
  // Opening the history of a chat also makes it mine; 12 hours later it is not any more.
  node('read');
  await mobile.call(device, { id: 'read-1', op: 'history', args: { sid: 'read', profile: 'default' } });
  await turn(clock, mobile, device, 'read', 't0', { count: 1, gap: 1000 });
  assert.equal(sent.length, 3);
  clock.advance(12 * 3600000);
  nodes.read.turnId = 't1';
  await turn(clock, mobile, device, 'read', 't1', { count: 1, gap: 1000 });
  assert.equal(sent.length, 3, 'stake expires after 12 h');
  // A chat the phone created and sent to under its runtime id is found again under its stored id.
  bridge.rpcToStored.set('rpc-new', { sid: 'stored-new', profile: 'default' });
  await mobile.call(device, { id: mutation(), op: 'send', args: { sid: 'rpc-new', profile: 'default', text: 'hello' } });
  node('stored-new', { rpcId: 'rpc-new', turnId: 'k1' });
  await turn(clock, mobile, device, 'stored-new', 'k1', { count: 1, gap: 1000 });
  assert.equal(sent.length, 4);
  // The stake survives a restart (persisted next to the ledger).
  const restarted = new MobileRelay({ tokensFile: mobile.tokensFile, bridgeConfig: { mode: 'off' }, clock, push: { configured: true, notify: async () => {}, removeDevice: async () => {} } });
  t.after(() => restarted.stop());
  const again = restarted.device(device.id);
  assert.equal(restarted.notices.mine(again, 'default', ['rpc-new']), true);
  assert.equal(restarted.notices.mine(again, 'default', ['read']), false);
});

test('D13: scope all, followed and muted agents; sub-agent sessions never push their own replies or ends', async t => {
  const clock = fakeClock();
  const nodes = { root: { sid: 'root', profile: 'default', title: 'Main', turnId: 'a' }, child: { sid: 'child', profile: 'default', title: 'Helper', parent: 'root', subagentId: 'sa-1', turnId: 'b' },
    cont: { sid: 'cont', profile: 'default', title: 'Continued', lineageParent: 'root', turnId: 'c' } };
  const { mobile, device, sent, logs } = fixture(t, { now: clock, policy: { scope: 'all' }, bridge: { nodeFor: sid => nodes[sid] || null } });
  await turn(clock, mobile, device, 'root', 'a', { count: 1, gap: 1000 });
  await turn(clock, mobile, device, 'child', 'b', { count: 1, gap: 1000 });
  await turn(clock, mobile, device, 'cont', 'c', { count: 1, gap: 1000 });
  assert.deepEqual(sent.map(event => device.notifications.get(event.id).sid), ['root', 'cont'], 'a compression continuation is the same chat, not a sub-agent');
  assert.ok(logs.some(line => line.decision === 'subagent' && line.sid === 'child'));
  mobile.notify(device, 'requests', [{ id: 'q', sid: 'child', profile: 'default', kind: 'question', at: clock(), questions: [{ qid: 'a', question: 'Which file?' }] }]);
  await flush(mobile);
  assert.equal(sent.at(-1).kind, 'question', 'a sub-agent still asks the person');
  // Muted: no replies or ends from that agent, whatever the scope; its approvals still come.
  const muted = fixture(t, { now: clock, policy: { scope: 'all', muted: ['default'] }, bridge: { nodeFor: sid => nodes[sid] || null } });
  await turn(clock, muted.mobile, muted.device, 'root', 'a', { count: 1, gap: 1000 });
  muted.mobile.notify(muted.device, 'requests', [{ id: 'r', sid: 'root', profile: 'default', kind: 'approval', at: clock(), command: 'ls', description: 'List' }]);
  await flush(muted.mobile);
  assert.deepEqual(muted.sent.map(event => event.kind), ['approval']);
  assert.ok(muted.logs.some(line => line.decision === 'muted'));
  // Followed: scope mine, never touched, but the agent is followed.
  const followed = fixture(t, { now: clock, policy: { agents: ['default'] }, bridge: { nodeFor: sid => nodes[sid] || null } });
  await turn(clock, followed.mobile, followed.device, 'root', 'a', { count: 1, gap: 1000 });
  assert.deepEqual(followed.sent.map(event => event.kind), ['done']);
  // The log never carries text or titles, and only 8 characters of a session id.
  const text = JSON.stringify([...logs, ...muted.logs, ...followed.logs]);
  for (const secret of ['Step 1', 'Main', 'Helper', 'Which file', 'List']) assert.ok(!text.includes(secret), secret);
  assert.ok([...logs, ...muted.logs].every(line => line.t === 'push' && (line.sid === null || line.sid.length <= 8)));
});

// Finished turns in `chats` distinct chats, all in scope, each its own push candidate.
async function finishTurns(clock, mobile, device, nodes, chats, prefix = 'c') {
  for (let i = 0; i < chats; i++) {
    const sid = `${prefix}${i}`;
    nodes[sid] = { sid, profile: 'default', title: 'Chat', turnId: `${sid}-t${clock()}` };
    mobile.notify(device, 'native', reply(sid, `Answer ${i}.`));
    mobile.notify(device, 'native', { type: 'turn.complete', sid, profile: 'default', payload: { turn_id: nodes[sid].turnId } });
    clock.advance(1000);
    await flush(mobile);
  }
}

test('D9 breaker in the relay: 5 pushes, then quiet; one digest after 10 minutes with counts only; doubling while unseen', async t => {
  const clock = fakeClock(), nodes = {};
  const { mobile, device, sent, logs } = fixture(t, { now: clock, policy: { scope: 'all' }, bridge: { nodeFor: sid => nodes[sid] || null } });
  await finishTurns(clock, mobile, device, nodes, 8);
  mobile.notify(device, 'requests', [{ id: 'r1', sid: 'c1', profile: 'default', kind: 'approval', at: clock(), command: 'ls', description: 'List' }]);
  await flush(mobile);
  assert.equal(sent.length, 5, 'five pushes, then the quiet window');
  assert.equal([...device.notifications.values()].filter(item => item.delivery === 'held').length, 4);
  assert.equal(logs.filter(line => line.decision === 'held').length, 4);
  clock.advance(9 * 60000); mobile.govern(device); await flush(mobile);
  assert.equal(sent.length, 5, 'nothing inside the window');
  clock.advance(60000); mobile.govern(device); await flush(mobile);
  assert.equal(sent.length, 6, 'one digest when the window ends');
  const digest = device.notifications.get(sent[5].id);
  assert.equal(sent[5].kind, 'done', 'a gateway without the digest feature gets the digest as done');
  assert.deepEqual([digest.kind, digest.counts, digest.body, digest.title], ['digest', { updates: 4, chats: 4, needsYou: 1 }, '', '']);
  assert.ok(logs.some(line => line.decision === 'digest' && line.counts.updates === 4));
  // Still unseen: the next window is 20 minutes; one more held event yields one more digest at its end.
  await finishTurns(clock, mobile, device, nodes, 2, 'd');
  assert.equal(sent.length, 6);
  clock.advance(19 * 60000); mobile.govern(device); await flush(mobile);
  assert.equal(sent.length, 6, 'the second window is twice as long');
  clock.advance(60000); mobile.govern(device); await flush(mobile);
  assert.equal(sent.length, 7);
  assert.deepEqual(device.notifications.get(sent[6].id).counts, { updates: 2, chats: 2, needsYou: 0 });
});

test('G1 seen: POST /mobile/seen, the seen op, any mutation and a foreground heartbeat reset the breaker and drop what it held', async t => {
  const http = require('node:http');
  const { createServer } = require('../src/server');
  const { deckHooks } = require('../src/index');
  const clock = fakeClock(), nodes = {};
  const { mobile, device, sent, paired } = fixture(t, { now: clock, policy: { scope: 'all', burst: 2 }, bridge: { nodeFor: sid => nodes[sid] || null, send: async () => ({ ok: true }) } });
  mobile.bridge = () => device.bridge;
  const relay = createServer({ token: 'x'.repeat(32), mobile, model: { snapshot: () => ({}), sessions: new Map(), tokens: () => ({}) }, fleet: { data: {} }, version: 'test' });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => relay.server.close(resolve)));
  const url = `http://127.0.0.1:${relay.server.address().port}`;
  const post = (body, token = paired.token) => fetch(`${url}/mobile/seen`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
  await finishTurns(clock, mobile, device, nodes, 5);
  assert.equal(sent.length, 2);
  assert.deepEqual(await (await post(JSON.stringify({ reason: 'notification' }))).json(), { ok: true, held: 3 });
  assert.deepEqual(await (await post('')).json(), { ok: true, held: 0 }, 'an empty body is fine');
  assert.equal((await post('[1]')).status, 400);
  assert.equal((await post('{}', 'wrong')).status, 401);
  await finishTurns(clock, mobile, device, nodes, 3, 'e');
  assert.equal(sent.length, 4, 'after seen the count restarts');
  assert.deepEqual(await mobile.call(device, { id: 'seen-1', op: 'seen', args: { reason: 'foreground' } }), { ok: true, held: 1 });
  await finishTurns(clock, mobile, device, nodes, 3, 'f');
  await mobile.call(device, { id: mutation(), op: 'send', args: { sid: 'f0', profile: 'default', text: 'ok' } });
  assert.equal(device.governor.state.sent, 0, 'a mutation from the phone counts as seen');
  // /events heartbeats of the phone: unlocked and active counts; locked or idle does not.
  await finishTurns(clock, mobile, device, nodes, 3, 'g');
  const hooks = deckHooks({ heartbeat() {}, connect() {}, disconnect() {}, state: () => ({}) }, null, null, null, null, null, null, mobile);
  const ws = { mobileDevice: { id: device.id } };
  hooks.onMessage(ws, Buffer.from(JSON.stringify({ t: 'heartbeat', locked: true, idleSec: 0 })), false);
  hooks.onMessage(ws, Buffer.from(JSON.stringify({ t: 'heartbeat', locked: false, idleSec: 300 })), false);
  assert.equal(device.governor.state.held.updates, 1);
  hooks.onMessage(ws, Buffer.from(JSON.stringify({ t: 'heartbeat', locked: false, idleSec: 0 })), false);
  assert.equal(device.governor.state.held.updates, 0);
  assert.equal(device.governor.state.sent, 0);
});

test('D9 breaker: a failed gateway call is not counted twice; bypass kinds go through a quiet window', async t => {
  const clock = fakeClock(), nodes = {};
  let failures = 1;
  const { mobile, device, sent } = fixture(t, { now: clock, policy: { scope: 'all', burst: 2, bypass: ['question'] }, bridge: { nodeFor: sid => nodes[sid] || null },
    push: { notify: async (target, event) => { if (failures-- > 0) throw Object.assign(new Error('Mobile push gateway returned HTTP 503'), { status: 503 }); sent.push({ target, ...event }); } } });
  await finishTurns(clock, mobile, device, nodes, 1);
  assert.equal(sent.length, 0);
  assert.equal(device.governor.state.sent, 0, 'refunded');
  mobile.pushRetryAt.clear(); await flush(mobile);
  assert.equal(sent.length, 1);
  assert.equal(device.governor.state.sent, 1);
  await finishTurns(clock, mobile, device, nodes, 2, 'h');
  assert.equal(sent.length, 2);
  mobile.notify(device, 'requests', [{ id: 'q', sid: 'h0', profile: 'default', kind: 'question', at: clock(), questions: [{ qid: 'a', question: 'Go on?' }] }]);
  await flush(mobile);
  assert.deepEqual(sent.map(event => event.kind), ['done', 'done', 'question'], 'a bypass kind is not held');
});

// An HTTP relay around a fixture's MobileRelay.
async function serve(t, mobile) {
  const { createServer } = require('../src/server');
  const relay = createServer({ token: 'x'.repeat(32), mobile, model: { snapshot: () => ({}), sessions: new Map(), tokens: () => ({}) }, fleet: { data: {} }, version: 'test' });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => relay.server.close(resolve)));
  return `http://127.0.0.1:${relay.server.address().port}`;
}
// The gateway accepts exactly these registration keys and rejects anything else, as push/gateway.js does.
const strictGateway = registrations => ({
  setDevice: async (id, body) => {
    if (Object.keys(body).sort().join() !== 'enabled,environment,kinds,token') throw Object.assign(new Error('Mobile push gateway returned HTTP 400'), { status: 400 });
    registrations.push(body); return { ok: true };
  },
});

test('G2 policy in the registration: validated, clamped, stored with the device, stripped before the gateway', async t => {
  const registrations = [];
  const { mobile, device, paired } = fixture(t, { push: strictGateway(registrations) });
  device.observePush = false; mobile.persist(device);
  const url = await serve(t, mobile);
  const put = body => fetch(`${url}/mobile/push`, { method: 'PUT', headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const base = { enabled: true, environment: 'production', kinds: ['done', 'approval', 'question', 'error'], token: 'a'.repeat(64) };
  const response = await put({ ...base, policy: { v: 1, burst: 50, quietMinutes: 0, bypass: ['approval', 'reply'], scope: 'all', agents: ['ada', '../x'], muted: ['atlas'], future: 1 } });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.deepEqual(answer, { ok: true, policy: { v: 1, burst: 20, quietMinutes: 1, maxQuietMinutes: 60, bypass: ['approval'], scope: 'all', agents: ['ada'], muted: ['atlas'] } });
  assert.deepEqual(registrations, [base], 'the gateway never sees the policy');
  assert.equal(device.observePush, true);
  // Persisted with the device: a restarted relay applies it.
  const again = new MobileRelay({ tokensFile: mobile.tokensFile, bridgeConfig: { mode: 'off' }, push: { configured: true, notify: async () => {}, removeDevice: async () => {} } });
  t.after(() => again.stop());
  assert.deepEqual(again.device(device.id).governor.policy, answer.policy);
  // A registration without a policy (an old app) means the defaults again.
  assert.deepEqual((await (await put(base)).json()).policy, { v: 1, burst: 5, quietMinutes: 10, maxQuietMinutes: 60, bypass: [], scope: 'mine', agents: [], muted: [] });
  assert.equal(device.pushPolicy, null);
  // A policy that is not an object is refused before the gateway is called.
  const bad = await put({ ...base, policy: 'all' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'bad_request');
  assert.equal(registrations.length, 2);
});

test('notification record: thread, badge, request {id, kind, choices | questions, quick}; a digest carries counts only', async t => {
  const clock = fakeClock(), nodes = { s1: { title: 'Release work', turnId: 't1' } };
  const open = [
    { id: 'ap-1', sid: 's1', profile: 'default', kind: 'approval', at: clock(), command: 'git push origin main', description: 'Push the release branch', choices: ['once', 'session', 'always', 'deny'] },
    { id: 'ap-2', sid: 's1', profile: 'default', kind: 'approval', at: clock(), command: 'rm -rf build\nmake all', description: 'Rebuild', choices: ['once', 'deny'] },
    { id: 'q-1', sid: 's1', profile: 'default', kind: 'question', at: clock(), questions: [{ qid: 'a', question: 'Which branch?', choices: ['main', 'next'], multi: false }] },
    { id: 'q-2', sid: 's1', profile: 'default', kind: 'question', at: clock(), questions: [{ qid: 'a', question: 'Pick', choices: ['1', '2'], multi: true }, { qid: 'b', question: 'Why?', choices: [] }] },
    { id: 'secret-1', sid: 's1', profile: 'default', kind: 'secret', method: 'sudo' },
  ];
  const { mobile, device, sent, paired } = fixture(t, { now: clock, policy: { scope: 'all', burst: 20 }, bridge: { nodeFor: sid => nodes[sid] || null, listRequests: () => open } });
  const url = await serve(t, mobile);
  const get = async id => (await fetch(`${url}/mobile/notifications/${id}`, { headers: { authorization: `Bearer ${paired.token}` } })).json();
  mobile.notify(device, 'requests', open.filter(request => request.kind !== 'secret'));
  await turn(clock, mobile, device, 's1', 't1', { count: 1, gap: 1000 });
  const byRequest = id => sent.find(event => device.notifications.get(event.id).request?.id === id).id;
  const thread = crypto.createHash('sha256').update(`${device.id}:default:s1`).digest('hex').slice(0, 32);
  const first = await get(byRequest('ap-1'));
  assert.deepEqual(first.request, { id: 'ap-1', kind: 'approval', choices: ['once', 'session', 'always', 'deny'], quick: true });
  assert.equal(first.thread, thread);
  assert.equal(first.badge, 4, 'open approvals + questions, never the masked prompt');
  assert.equal(first.body, 'Push the release branch');
  assert.equal((await get(byRequest('ap-2'))).request.quick, false, 'a multi-line command is not answered from a banner');
  assert.deepEqual((await get(byRequest('q-1'))).request, { id: 'q-1', kind: 'question', questions: [{ qid: 'a', choices: ['main', 'next'], multi: false }], quick: true });
  const many = await get(byRequest('q-2'));
  assert.equal(many.request.quick, false);
  assert.ok(!JSON.stringify(many.request).includes('Why?'), 'no question text beyond the body');
  const done = await get(sent.find(event => event.kind === 'done').id);
  assert.deepEqual([done.kind, done.thread, done.badge, done.request], ['done', thread, 4, undefined]);
  open.length = 0;
  assert.equal((await get(sent[0].id)).badge, 0, 'the badge is read at fetch time');
  // A digest: counts and ids only.
  mobile.storeDigest(device, { counts: { updates: 9, chats: 3, needsYou: 1 } });
  await flush(mobile);
  const digest = await get(sent.at(-1).id);
  assert.deepEqual(digest, { kind: 'digest', counts: { updates: 9, chats: 3, needsYou: 1 }, title: '', body: '', agent: '', thread: crypto.createHash('sha256').update(`${device.id}:digest`).digest('hex').slice(0, 32), badge: 0 });
});
