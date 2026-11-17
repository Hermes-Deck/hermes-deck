'use strict';
// The relay's push gateway client against stub gateways (no network): features from GET /health, `collapse` and the
// `digest` kind only when offered; an older gateway (no /health, strict keys) keeps getting exactly today's events.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MobilePushClient } = require('../src/mobile-push');
const { MobileRelay, createPair } = require('../src/mobile');

/** A stub gateway as a fetch function. `features: null` = an older gateway without /health. Unknown keys are rejected. */
function stubGateway({ features = ['collapse', 'digest'] } = {}) {
  const events = [], health = [];
  const kinds = ['reply', 'done', 'approval', 'question', 'error', ...(features?.includes('digest') ? ['digest'] : [])];
  const allowed = ['id', 'kind', 'target', ...(features?.includes('collapse') ? ['collapse'] : [])];
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fetchImpl = async (url, options) => {
    const route = new URL(url).pathname.replace(/^\/prefix/, '');
    if (route === '/health') { health.push(options.headers?.authorization || null); return features ? reply(200, { ok: true, features }) : reply(404, { error: 'not found' }); }
    if (route === '/v1/events' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      if (Object.keys(body).some(key => !allowed.includes(key)) || !kinds.includes(body.kind) || ('collapse' in body && !/^[a-f0-9]{32}$/.test(body.collapse))) return reply(400, { code: 'BAD_EVENT' });
      events.push(body); return reply(202, { ok: true });
    }
    return reply(404, {});
  };
  return { fetchImpl, events, health };
}
const client = (gateway, now) => new MobilePushClient({ url: 'https://push.example/prefix', credential: 'a'.repeat(43), fetch: gateway.fetchImpl, now });

test('features: read from /health, cached for an hour, forced on demand; unknown features ignored; no bearer sent to /health', async () => {
  let now = 1000;
  const gateway = stubGateway({ features: ['collapse', 'digest', 'telepathy'] });
  const push = client(gateway, () => now);
  assert.equal(push.offers('collapse'), false, 'nothing before the first read');
  await push.refreshFeatures();
  assert.deepEqual([...push.features], ['collapse', 'digest']);
  await push.refreshFeatures(); now += 59 * 60000; await push.refreshFeatures();
  assert.equal(gateway.health.length, 1, 'cached');
  now += 60000; await push.refreshFeatures();
  assert.equal(gateway.health.length, 2, 'hourly');
  await push.refreshFeatures(true);
  assert.equal(gateway.health.length, 3, 'forced (registration)');
  assert.deepEqual(gateway.health, [null, null, null]);
});

test('events: collapse and digest only when offered; an older gateway gets exactly target/id/kind and a digest as done', async () => {
  const collapse = 'c'.repeat(32), id = `e_${Date.now()}_${'a'.repeat(48)}`;
  const modern = stubGateway();
  const push = client(modern);
  await push.refreshFeatures();
  await push.notify('dev', { id, kind: 'done', collapse });
  await push.notify('dev', { id, kind: 'digest', collapse });
  await push.notify('dev', { id, kind: 'done', collapse: 'not-hex' });
  assert.deepEqual(modern.events, [{ target: 'dev', id, kind: 'done', collapse }, { target: 'dev', id, kind: 'digest', collapse }, { target: 'dev', id, kind: 'done' }]);
  const old = stubGateway({ features: null });
  const legacy = client(old);
  await legacy.refreshFeatures();
  await legacy.notify('dev', { id, kind: 'done', collapse });
  await legacy.notify('dev', { id, kind: 'digest', collapse });
  assert.deepEqual(old.events, [{ target: 'dev', id, kind: 'done' }, { target: 'dev', id, kind: 'done' }]);
  // A gateway swapped for an older one while features were cached: the refusal makes the client read them again.
  const swapped = stubGateway();
  const stale = client(swapped);
  await stale.refreshFeatures();
  const downgraded = stubGateway({ features: null });
  stale.fetch = downgraded.fetchImpl;
  await assert.rejects(stale.notify('dev', { id, kind: 'done', collapse }), error => error.status === 400);
  assert.equal(stale.featuresAt, 0);
  await stale.refreshFeatures();
  await stale.notify('dev', { id, kind: 'done', collapse });
  assert.deepEqual(downgraded.events, [{ target: 'dev', id, kind: 'done' }]);
});

test('relay: a chat banner carries the per-chat collapse id; the digest uses the device digest id; both fall back for an old gateway', async t => {
  for (const features of [['collapse', 'digest'], null]) {
    const gateway = stubGateway({ features });
    const push = client(gateway);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mobile-features-')), file = path.join(dir, 'devices.json');
    let now = Date.now();
    const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: 'off' }, push, clock: () => now, pushLog: () => {} });
    t.after(() => mobile.stop());
    await push.refreshFeatures();
    const paired = mobile.pair({ code: createPair(file), name: 'phone' }), device = mobile.device(paired.deviceId);
    device.observePush = true; mobile.setPushPolicy(device, { scope: 'all', burst: 1, quietMinutes: 1 }); mobile.persist(device);
    const nodes = { s1: { title: 'Chat', turnId: 't1' }, s2: { title: 'Chat', turnId: 'u1' } };
    device.bridge = { stop: async () => {}, nodeFor: sid => nodes[sid] || null };
    for (const sid of ['s1', 's2']) {
      mobile.notify(device, 'native', { type: 'message.complete', sid, profile: 'default', payload: { text: 'Done.' } });
      mobile.notify(device, 'native', { type: 'turn.complete', sid, profile: 'default', payload: { turn_id: nodes[sid].turnId } });
      for (let i = 0; i < 4; i++) await mobile.flushPush();
    }
    now += 60000; mobile.govern(device);
    for (let i = 0; i < 4; i++) await mobile.flushPush();
    const chat = crypto.createHash('sha256').update(`${device.id}:default:s1`).digest('hex').slice(0, 32);
    const digest = crypto.createHash('sha256').update(`${device.id}:digest`).digest('hex').slice(0, 32);
    if (features) assert.deepEqual(gateway.events.map(event => [event.kind, event.collapse]), [['done', chat], ['digest', digest]]);
    else assert.deepEqual(gateway.events.map(event => Object.keys(event).sort().join() + ':' + event.kind), ['id,kind,target:done', 'id,kind,target:done']);
  }
});
