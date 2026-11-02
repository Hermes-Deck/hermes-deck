'use strict';
// Masked prompts (sudo, secret, vault.*: bridge request kind "secret") never reach the phone: the iOS app has no masked
// card and no op to answer them, so the relay neither lists nor pushes them. Approvals beside them still go through.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { MobileRelay, createPair, phoneRequests } = require('../src/mobile');

const SECRET_FRAMES = [
  { method: 'sudo', params: { command: 'apt-get install -y ripgrep' } },
  { method: 'secret', params: { env_var: 'ATLAS_API_KEY', prompt: 'API key for the Atlas skill' } },
  { method: 'vault.unlock_prompt', params: { backend: 'bitwarden', display_name: 'Bitwarden' } },
  { method: 'vault.save_login', params: { origin: 'https://login.example.com', site: 'login.example.com' } },
  { method: 'vault.code', params: { site: 'login.example.com', hint: '6-digit code' } },
];

test('phoneRequests keeps approvals and questions only', () => {
  const list = [{ id: 'a', kind: 'approval' }, { id: 'q', kind: 'question' }, { id: 's', kind: 'secret', method: 'sudo' }, null, { id: 'x' }];
  assert.deepEqual(phoneRequests(list).map(r => r.id), ['a', 'q']);
  assert.deepEqual(phoneRequests(undefined), []);
});

test('a phone hears approvals but never a masked prompt: not listed, not pushed, nothing about it in push metadata', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-masked-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'devices.json'), forwarded = [];
  const push = { configured: true, notify: async (deviceId, event) => { forwarded.push(event); }, removeDevice: async () => {} };
  const mobile = new MobileRelay({ tokensFile: file, settleMs: 0, bridgeConfig: { mode: 'local' }, push, bridgeOptions: {
    launch: { file: 'in-memory-fixture', args: [] }, autoList: false, keepalive: false, timing: { kill: 1 },
    spawn: () => {
      const child = new EventEmitter();
      Object.assign(child, { pid: 4242, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      child.kill = () => { child.exitCode = 0; child.emit('exit', 0, null); };
      return child;
    },
  } });
  t.after(() => mobile.stop());
  const paired = mobile.pair({ code: createPair(file), name: 'phone' });
  const device = mobile.device(paired.deviceId);
  device.observePush = true;
  const sent = [];
  device.sockets.add({ mobileBridge: true, readyState: 1, bufferedAmount: 0, send: text => sent.push(JSON.parse(text)), terminate() {}, close() {} });
  const bridge = mobile.bridge(device);
  for (const [i, f] of SECRET_FRAMES.entries()) {
    bridge._onServerFrame({ jsonrpc: '2.0', id: `srq-s${i}`, method: f.method, params: { session_id: 'rpc-one', profile_name: 'default', ...f.params } });
  }
  bridge._onServerFrame({ jsonrpc: '2.0', id: 'srq-a', method: 'approval', params: { session_id: 'rpc-one', profile_name: 'default', command: 'rm -rf build', choices: ['once', 'deny'] } });
  // the desktop's bridge itself lists all six; the phone's view of it carries the approval only
  assert.equal(bridge.listRequests().filter(r => r.kind === 'secret').length, 5);
  const lists = sent.filter(m => m.t === 'bridge' && m.event === 'requests').map(m => m.data);
  assert.ok(lists.length >= 6);
  for (const list of lists) assert.ok(list.every(r => r.kind === 'approval'), JSON.stringify(list));
  assert.deepEqual(lists.at(-1).map(r => r.id), ['srq-a']);
  bridge.rpcToStored.set('rpc-one', { sid: 'session-one', profile: 'default' });
  mobile.notify(device, 'requests', phoneRequests(bridge.listRequests()));
  mobile.deskCheck?.();
  await mobile.flushPush();
  await mobile.flushPush();
  const kinds = [...device.notifications.values()].map(n => n.kind);
  assert.deepEqual(kinds, ['approval']);
  // even a list that still holds masked prompts (an older caller) is not admitted for them
  const admission = mobile.notify(device, 'requests', bridge.listRequests().filter(r => r.kind === 'secret').map(r => ({ ...r, sid: 'session-one' })));
  assert.equal(admission.accepted, 0);
  const everything = JSON.stringify([sent, [...device.notifications.values()], forwarded, fs.readFileSync(`${file}.state`, 'utf8')]);
  for (const word of ['login.example.com', 'ATLAS_API_KEY', 'Bitwarden', 'ripgrep', 'vault.', '"secret"']) assert.ok(!everything.includes(word), word);
});
