'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MobileRelay } = require('../src/mobile');
const mutationID = () => `m.${Date.now()}.${crypto.randomUUID()}`;
const reads = ['plan', 'toolCalls', 'subagents', 'subagentTail', 'commands'];
const mutations = ['steerSubagent', 'interruptSubagent'];
const argsFor = op => op === 'commands' ? { profile: 'research' } : {
  sid: 'session:opaque/1', profile: 'research',
  ...(['subagentTail', ...mutations].includes(op) ? { id: 'sa:opaque/1' } : {}),
  ...(op === 'steerSubagent' ? { text: 'Focus on tests' } : {}),
};
function setup(t, configured = false) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'mobile-work-'));
  const mobile = new MobileRelay({ tokensFile: path.join(dir, 'devices.json'), bridgeConfig: configured ? { mode: 'local' } : { mode: 'off' } });
  t.after(async () => { await mobile.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return mobile;
}
test('work capability flags require a configured bridge', t => {
  for (const configured of [false, true]) {
    const mobile = setup(t, configured);
    for (const flag of ['work', 'subagents', 'commands']) assert.equal(mobile.capabilities()[flag], configured);
  }
  const absent = new MobileRelay({ tokensFile: path.join(process.env.TMPDIR, `mobile-${crypto.randomUUID()}.json`) });
  t.after(() => absent.stop());
  assert.equal(absent.capabilities().work, false);
});
test('all work operations dispatch exact bridge arguments; reads need no mutation ID', async t => {
  const mobile = setup(t), calls = [];
  const bridge = Object.fromEntries([...reads.filter(x => x !== 'commands'), ...mutations, 'commandCatalog'].map(method => [method, (...args) => { calls.push([method, args]); return { method }; }]));
  mobile.bridge = () => bridge;
  const device = mobile.device('phone');
  for (const op of [...reads, ...mutations]) {
    const args = argsFor(op), id = mutations.includes(op) ? mutationID() : op;
    const method = op === 'commands' ? 'commandCatalog' : op;
    assert.deepEqual(await mobile.call(device, { id, op, args }), { method });
    const expected = op === 'commands' ? [args.profile] : [args.sid, ...(args.id ? [args.id] : []), ...(args.text ? [args.text] : []), { profile: args.profile }];
    assert.deepEqual(calls.at(-1), [method, expected]);
    assert.equal(device.ids.has(id), mutations.includes(op));
  }
});
test('work arguments fail closed before bridge methods; no coercion, controls or oversized IDs/text', async t => {
  const mobile = setup(t), device = mobile.device('phone');
  mobile.bridge = () => new Proxy({}, { get: () => () => assert.fail('invalid arguments reached bridge method') });
  for (const op of [...reads, ...mutations]) {
    const args = argsFor(op);
    const bad = [{ ...args, extra: true }];
    for (const profile of [undefined, null, {}, ['research'], 4, '', '../research', 'x'.repeat(65)]) bad.push({ ...args, profile });
    if (op !== 'commands') for (const sid of [undefined, null, {}, ['a'], 1, '', 'a b', 'a\n', 'a\0', 'x'.repeat(513)]) bad.push({ ...args, sid });
    if (args.id) for (const id of [undefined, null, {}, ['a'], 1, '', 'a b', 'a\n', 'x'.repeat(129)]) bad.push({ ...args, id });
    if (op === 'steerSubagent') for (const text of [undefined, null, {}, 1, '', ' \n ', 'x'.repeat(32001)]) bad.push({ ...args, text });
    for (const invalid of bad) await assert.rejects(mobile.call(device, { id: mutations.includes(op) ? mutationID() : crypto.randomUUID(), op, args: invalid }), { code: 'bad_request' });
  }
});
test('sub-agent mutations consume IDs before dispatch; duplicate refused after device/restart', async t => {
  const mobile = setup(t), device = mobile.device('phone');
  let sent = 0;
  mobile.bridge = () => ({ steerSubagent: () => { sent++; throw Error('Connection lost'); }, interruptSubagent: () => { sent++; throw Error('Connection lost'); } });
  for (const op of mutations) {
    const message = { id: mutationID(), op, args: argsFor(op) };
    await assert.rejects(mobile.call(device, message), /Connection lost/);
    await assert.rejects(mobile.call(device, message), { code: 'duplicate' });
    const restarted = new MobileRelay({ tokensFile: mobile.tokensFile, bridgeConfig: { mode: 'off' } });
    t.after(() => restarted.stop());
    await assert.rejects(restarted.call(restarted.device('phone'), message), { code: 'duplicate' });
  }
  assert.equal(sent, 2);
  for (const op of mutations) await assert.rejects(mobile.call(device, { id: 'not-a-mutation', op, args: argsFor(op) }), { code: 'bad_request' });
});
function next(emitter, event, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.off(event, read); reject(Error(`timeout: ${event}`)); }, 8000);
    function read(value) { if (predicate(value)) { clearTimeout(timer); emitter.off(event, read); resolve(value); } }
    emitter.on(event, read);
  });
}
test('real mobile BridgeClient never replays sub-agent controls after host reconnect', async t => {
  for (const [op, method] of [['steerSubagent', 'subagent.steer'], ['interruptSubagent', 'subagent.interrupt']]) {
    const mobile = setup(t, true), log = path.join(path.dirname(mobile.tokensFile), 'requests.log');
    mobile.bridgeConfig = { mode: 'local', python: '/usr/bin/python3', stream: '/example/stream.py' };
    mobile.bridgeOptions = { launch: { file: process.execPath, args: [path.resolve(__dirname, '../../app/test/fake-stream.js'), '--serve', '--log', log, '--exit-on', method] }, timing: { handshake: 1500, request: 1500, heartbeat: 5000, kill: 100, backoffMin: 40, backoffMax: 80 } };
    const device = mobile.device('phone'), bridge = mobile.bridge(device);
    if (bridge.status.status !== 'open') await next(bridge, 'status', value => value.status === 'open');
    const message = { id: mutationID(), op, args: { ...argsFor(op), sid: 's-main', profile: 'default', id: 'sa-0-example' } };
    await assert.rejects(mobile.call(device, message));
    await next(bridge, 'status', value => value.status === 'open');
    await assert.rejects(mobile.call(device, message), { code: 'duplicate' });
    const entries = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(entries.filter(x => x.start).length >= 2);
    assert.equal(entries.filter(x => x.method === method).length, 1);
    assert.equal(entries.find(x => x.method === method).params.session_id, 'rpc-s-main');
    await mobile.stop();
  }
});
