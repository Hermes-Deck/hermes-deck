"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { once } = require("events");
const WebSocket = require("ws");
const { Presence } = require("../src/presence");
const { BundleStore, sha256 } = require("../src/bundles");
const { createServer } = require("../src/server");
const devtokens = require("../src/devtokens");

const SOURCE = "a1b2c3d4e5f60708";
const TARGET = "0f0e0d0c0b0a0908";
const OTHER = "0123456789abcdef";
const RELAY_TOKEN = "fixture-relay-token".repeat(3);
const publicKey = () => crypto.randomBytes(32).toString("base64");
const beat = (deviceId, extra = {}) => ({ t: "heartbeat", device: { id: deviceId, name: "Fixture device" }, hosting: { browser: true }, driverOk: { browser: true }, idleSec: 0, ...extra });

async function setup(t, limits = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-bundles-"));
  const tokensFile = path.join(dir, "tokens.json");
  const clock = { ms: 2_000_000_000, now: () => clock.ms };
  const presence = new Presence({ now: clock.now });
  const options = { dir: path.join(dir, "bundles"), tokensFile, presence, now: clock.now, ...limits };
  const store = new BundleStore(options);
  const hooks = {
    onConnect: (ws) => presence.connect(ws),
    onMessage: (ws, raw) => {
      const m = JSON.parse(raw);
      if (m.t === "heartbeat") { presence.heartbeat(ws, m); return true; }
      return store.onMessage(ws, m);
    },
    onClose: (ws) => { store.onClose(ws); presence.disconnect(ws); },
  };
  const relay = createServer({ token: RELAY_TOKEN, model: { sessions: new Map(), snapshot: () => ({}), tokens: () => ({}) }, fleet: { data: {} }, hooks, bundles: store });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  t.after(async () => {
    for (const ws of relay.clients) ws.terminate();
    await new Promise((resolve) => relay.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function connect(deviceId, token, key = publicKey(), heartbeat = true) {
    const ws = new WebSocket(`${base.replace("http:", "ws:")}/events`, { headers: { authorization: `Bearer ${RELAY_TOKEN}` } });
    await once(ws, "open");
    const waitIdentity = () => new Promise((resolve) => {
      const listener = (raw) => {
        const m = JSON.parse(raw);
        if (m.t !== "bundle-identity") return;
        ws.off("message", listener);
        resolve(m);
      };
      ws.on("message", listener);
    });
    const hello = async () => {
      const answer = waitIdentity();
      ws.send(JSON.stringify({ t: "bundle-hello", deviceId, deviceToken: token, publicKey: key }));
      return answer;
    };
    if (heartbeat) ws.send(JSON.stringify(beat(deviceId)));
    return { ws, token, deviceId, publicKey: key, answer: await hello(), hello };
  }
  const sourceToken = devtokens.add(tokensFile, "fixture-source");
  const targetToken = devtokens.add(tokensFile, "fixture-target");
  const source = await connect(SOURCE, sourceToken);
  const target = await connect(TARGET, targetToken);
  assert.equal(source.answer.ok, true);
  assert.equal(target.answer.ok, true);
  const headers = (actor = source) => ({ authorization: `Bearer ${RELAY_TOKEN}`, "x-deck-device-id": actor.deviceId, "x-deck-device-token": actor.token });
  const request = (pathname, { actor = source, method = "GET", body, ...rest } = {}) => fetch(`${base}${pathname}`, { method, headers: { ...headers(actor), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...rest });
  const envelope = (patch = {}) => {
    const bytes = crypto.randomBytes(96);
    return { version: 1, publicKey: target.publicKey, slug: "scout", source: SOURCE, target: TARGET, createdAt: clock.ms, expiresAt: clock.ms + 60_000, reason: "manual", ciphertext: bytes.toString("base64"), sha256: sha256(bytes), ...patch };
  };
  return { dir, tokensFile, clock, presence, options, store, base, source, target, connect, headers, request, envelope };
}

test("bundle HTTP: relay bearer, device token and fresh authenticated websocket are all required", async (t) => {
  const x = await setup(t);
  assert.equal((await fetch(`${x.base}/bundle`)).status, 401);
  assert.equal((await fetch(`${x.base}/bundle?token=${RELAY_TOKEN}`, { headers: { "x-deck-device-id": SOURCE, "x-deck-device-token": x.source.token } })).status, 401);
  assert.equal((await fetch(`${x.base}/bundle`, { headers: { authorization: `Bearer ${RELAY_TOKEN}` } })).status, 401);
  assert.equal((await fetch(`${x.base}/bundle`, { headers: { ...x.headers(), "x-deck-device-id": TARGET } })).status, 403);
  const registered = await x.request("/bundle/register", { method: "POST", body: { deviceId: SOURCE, publicKey: x.source.publicKey } });
  assert.equal(registered.status, 200);
  assert.equal((await registered.json()).identity.deviceId, SOURCE);
  assert.equal((await x.request("/bundle/register", { method: "POST", body: { deviceId: TARGET, publicKey: x.target.publicKey } })).status, 403);
  const identities = (await (await x.request("/bundle/devices")).json()).devices;
  assert.equal(identities.length, 2);
  assert.equal(identities.every((d) => d.fresh && !d.tokenHash && !d.tokenName), true);
  assert.equal(fs.readFileSync(x.store.registryFile, "utf8").includes(x.source.token), false);
  x.clock.ms += 30_000;
  assert.equal((await x.request("/bundle")).status, 403);
});

test("bundle identities: a heartbeat alone cannot impersonate a registered device or replace its key", async (t) => {
  const x = await setup(t);
  const forged = await x.connect(SOURCE, x.target.token, publicKey());
  assert.equal(forged.answer.ok, false);
  assert.equal(x.store.boundDevice(x.presence.connOf(SOURCE)), null);
  assert.equal(x.store.boundDevice(x.store.connOf(SOURCE)), SOURCE);
  const duplicateOwner = await x.connect(OTHER, x.source.token);
  assert.equal(duplicateOwner.answer.ok, false);
  const noHeartbeat = await x.connect(OTHER, devtokens.add(x.tokensFile, "fixture-other"), publicKey(), false);
  assert.equal(noHeartbeat.answer.ok, false);
  const changedKey = await x.connect(SOURCE, x.source.token, publicKey());
  assert.equal(changedKey.answer.ok, false);
  assert.equal(x.store.identity(SOURCE).publicKey, x.source.publicKey);
});

test("bundle HTTP: sealed envelope is opaque, target-only, retained until acknowledgement and then deleted", async (t) => {
  const x = await setup(t);
  const body = x.envelope();
  const result = await x.request("/bundle", { method: "POST", body });
  assert.equal(result.status, 201);
  const { bundle } = await result.json();
  assert.equal(bundle.ciphertext, undefined);
  assert.equal(bundle.sha256, body.sha256);
  const file = path.join(x.store.dir, `${bundle.id}.json`);
  assert.equal(fs.readFileSync(file, "utf8").includes(body.ciphertext), true);
  assert.equal((await x.request(`/bundle/${bundle.id}`)).status, 404);
  assert.equal((await x.request(`/bundle/${bundle.id}`, { method: "DELETE" })).status, 404);
  assert.deepEqual((await (await x.request("/bundle", { actor: x.source })).json()).bundles, []);
  assert.equal((await (await x.request("/bundle", { actor: x.target })).json()).bundles.length, 1);
  for (let attempt = 0; attempt < 2; attempt++) {
    const received = (await (await x.request(`/bundle/${bundle.id}`, { actor: x.target })).json()).bundle;
    assert.equal(received.ciphertext, body.ciphertext);
    assert.equal(sha256(Buffer.from(received.ciphertext, "base64")), received.sha256);
  }
  assert.equal((await x.request(`/bundle/${bundle.id}`, { actor: x.target, method: "DELETE" })).status, 200);
  assert.equal(fs.existsSync(file), false);
  assert.equal((await x.request(`/bundle/${bundle.id}`, { actor: x.target })).status, 404);
});

test("bundle trust boundary: digest, expiry, keys, source, sizes and recipient hosting are validated", async (t) => {
  const x = await setup(t, { maxBytes: 128, totalBytes: 192, maxEntries: 2 });
  for (const patch of [{ sha256: "0".repeat(64) }, { expiresAt: x.clock.ms }, { expiresAt: x.clock.ms + 300_001 }, { source: TARGET }, { target: SOURCE }, { publicKey: publicKey() }, { version: 2 }, { ciphertext: "not base64" }, { slug: "../secret" }, { slug: ["scout"] }, { slug: 1 }, { reason: "surprise" }]) {
    assert.throws(() => x.store.put(SOURCE, x.envelope(patch)));
  }
  const tooBig = Buffer.alloc(129);
  assert.throws(() => x.store.put(SOURCE, x.envelope({ ciphertext: tooBig.toString("base64"), sha256: sha256(tooBig) })), { status: 413 });
  const tooLargeBody = await x.request("/bundle", { method: "POST", body: { padding: "x".repeat(10_000) } });
  assert.equal(tooLargeBody.status, 413);
  const recipient = x.store.connOf(TARGET);
  x.presence.heartbeat(recipient, beat(TARGET, { hosting: { browser: false } }));
  assert.throws(() => x.store.put(SOURCE, x.envelope()), { status: 409 });
  x.presence.heartbeat(recipient, beat(TARGET));
  x.store.put(SOURCE, x.envelope({ createdAt: x.clock.ms + 20_000, expiresAt: x.clock.ms + 320_000 }));
  x.store.put(SOURCE, x.envelope());
  assert.throws(() => x.store.put(SOURCE, x.envelope()), { status: 507 });
});

test("bundle checkpoint: replacement is bounded, callbacks can reject safely, expiration deletes ciphertext", async (t) => {
  const x = await setup(t, { maxEntries: 1 });
  const first = x.store.put(SOURCE, x.envelope({ reason: "checkpoint" }));
  x.store.onBeforeStore = () => { throw new Error("wrong browser route"); };
  assert.throws(() => x.store.put(SOURCE, x.envelope({ reason: "checkpoint" })), /wrong browser route/);
  assert.equal(x.store.latestCheckpoint(SOURCE, "scout").id, first.id);
  x.store.onBeforeStore = () => {};
  x.store.onStored = () => { throw new Error("handoff was refused"); };
  assert.throws(() => x.store.put(SOURCE, x.envelope({ reason: "checkpoint" })), /handoff was refused/);
  assert.equal(x.store.latestCheckpoint(SOURCE, "scout").id, first.id);
  x.store.onStored = () => {};
  x.clock.ms += 1;
  const second = x.store.put(SOURCE, x.envelope({ reason: "checkpoint" }));
  assert.equal(x.store.bundles.size, 1);
  assert.equal(x.store.latestCheckpoint(SOURCE, "scout").id, second.id);
  assert.equal(fs.existsSync(path.join(x.store.dir, `${first.id}.json`)), false);
  x.clock.ms += 60_000;
  x.store.prune();
  assert.equal(x.store.bundles.size, 0);
  assert.equal(fs.existsSync(path.join(x.store.dir, `${second.id}.json`)), false);
});

test("bundle restart and revocation: bindings persist, source loss permits retrieval, revocation deletes pending data", async (t) => {
  const x = await setup(t);
  const b = x.store.put(SOURCE, x.envelope());
  const restart = new BundleStore(x.options);
  assert.equal(restart.identity(SOURCE).publicKey, x.source.publicKey);
  assert.equal(restart.listFor(TARGET)[0].id, b.id);
  const sourceConn = x.store.connOf(SOURCE);
  x.store.onClose(sourceConn);
  x.presence.disconnect(sourceConn);
  assert.equal(x.store.get(TARGET, b.id).sha256, b.sha256);
  devtokens.revoke(x.tokensFile, "fixture-source");
  assert.equal(x.store.identity(SOURCE), null);
  assert.throws(() => x.store.get(TARGET, b.id), { status: 404 });
  assert.equal(fs.existsSync(path.join(x.store.dir, `${b.id}.json`)), false);
  devtokens.revoke(x.tokensFile, "fixture-target");
  assert.equal((await x.request("/bundle", { actor: x.target })).status, 403);
});

test("bundle server actor: fallback access stays internal and is registered with an immutable key", async (t) => {
  const x = await setup(t);
  const key = publicKey();
  assert.deepEqual(x.store.registerServer({ publicKey: key }), { deviceId: "fallback", publicKey: key, fresh: true });
  assert.throws(() => x.store.registerServer({ publicKey: publicKey() }), { status: 409 });
  const toServer = x.store.put(SOURCE, x.envelope({ target: "fallback", publicKey: key }));
  assert.equal(x.store.getServer(toServer.id).target, "fallback");
  assert.equal((await x.request(`/bundle/${toServer.id}`, { actor: { deviceId: "fallback", token: x.source.token } })).status, 401);
  x.store.ackServer(toServer.id);
  const fromServer = x.store.putServer(x.envelope({ source: "fallback" }));
  assert.equal(x.store.get(TARGET, fromServer.id).source, "fallback");
  const restart = new BundleStore(x.options);
  assert.equal(restart.identity("fallback").fresh, false);
  assert.throws(() => restart.putServer(x.envelope({ source: "fallback" })), { status: 403 });
  restart.registerServer({ publicKey: key });
  assert.equal(restart.identity("fallback").fresh, true);
});
