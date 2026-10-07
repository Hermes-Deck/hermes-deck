"use strict";
// Opt-in, fixture-only: two actual headless browsers and authenticated local relay HTTP/WebSockets.
// DECK_TRANSFER_E2E=1 node --test test/browser-transfer-e2e.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { EventEmitter, once } = require("node:events");
const { createRequire } = require("node:module");
const relayRequire = createRequire(path.join(__dirname, "../../relay/package.json"));
const { Presence } = relayRequire("./src/presence");
const { BundleStore } = relayRequire("./src/bundles");
const { BrowserTransfers } = relayRequire("./src/browser-transfer");
const { WorkspaceHub } = relayRequire("./src/workspace");
const { createServer } = relayRequire("./src/server");
const { deckHooks } = relayRequire("./src/index");
const devtokens = relayRequire("./src/devtokens");
const { AgentBrowserHost, CdpClient } = require("../main/agent-browser");
const { BrowserTransfer } = require("../main/browser-transfer");
const { RelayClient } = require("../main/relay");
const { exportState } = require("../main/browser-bundle");
const SOURCE = "1111111111111111", TARGET = "2222222222222222", SLUG = "scout";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(25); }
  throw new Error(`Timed out: ${label}`);
}
async function evaluate(cdp, sessionId, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId, 3000);
  assert.ok(!r.exceptionDetails, "fixture page evaluation must succeed");
  return r.result.value;
}

test("D3 e2e: consent, sealed relay transfer, restored browser state, acknowledgement and sticky destination", { skip: process.env.DECK_TRANSFER_E2E !== "1", timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-transfer-e2e-"));
  const relayToken = crypto.randomBytes(32).toString("hex");
  const tokensFile = path.join(dir, "device-tokens.json");
  const presence = new Presence();
  const bundles = new BundleStore({ dir: path.join(dir, "relay-bundles"), tokensFile, presence });
  const relayTransfers = new BrowserTransfers({ presence, bundles, fallback: null, identity: null, policyFile: path.join(dir, "relay-policy.json") });
  const hub = new WorkspaceHub({ presence, transfers: relayTransfers });
  const relay = createServer({ token: relayToken, model: { sessions: new Map(), snapshot: () => ({}), tokens: () => ({}) },
    fleet: { data: {} }, version: "fixture", hooks: deckHooks(presence, null, null, hub, bundles), bundles });
  relayTransfers.broadcast = relay.broadcast;
  hub.setBroadcast(relay.broadcast);
  const stored = [];
  const errors = [];
  bundles.onBeforeStore = meta => relayTransfers.check(meta);
  bundles.onStored = meta => {
    const bytes = fs.readFileSync(path.join(bundles.dir, `${meta.id}.json`), "utf8");
    for (const privateValue of ["fixture-auth", "fixture-local", "draft-one", "draft-two", "form-one", "form-two"]) assert.ok(!bytes.includes(privateValue), "relay persists ciphertext only");
    stored.push(meta);
    if (meta.reason !== "checkpoint") relayTransfers.stored(meta).catch(e => errors.push(e));
  };
  const pageRequests = [];
  const pageServer = http.createServer((req, res) => {
    pageRequests.push({ url: req.url, cookie: req.headers.cookie || "" });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<script>window.bootStorage={local:localStorage.getItem('token'),session:sessionStorage.getItem('draft')};</script><input id="name" name="name"><input type="password" id="password"><input type="file"><select name="choice"><option>zero</option><option>one</option></select><div style="height:4000px"></div>`);
  });
  const devices = [], cdpClients = [];
  let phase = "start local servers";
  function device(deviceId, name, idleSec) {
    const host = new AgentBrowserHost({ root: path.join(dir, name, "agent-browsers"), enabled: true });
    assert.ok(host.enabled(), "a local headless Chromium browser must be available");
    const link = new RelayClient({ url: `ws://127.0.0.1:${relay.server.address().port}`, token: relayToken });
    const local = new EventEmitter(); local.id = deviceId;
    local.push = () => link.send({ t: "heartbeat", device: { id: deviceId, name }, os: process.platform, idleSec,
      locked: false, hosting: { browser: true, desktop: false }, driverOk: { browser: true } });
    const events = [], pending = new Map();
    let nextId = 1;
    const request = (op, slug, extra = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture relay request timed out: ${op}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      if (!link.send({ t: "ws-req", id, op, slug, ...extra })) {
        clearTimeout(timer); pending.delete(id); reject(new Error("Fixture relay disconnected"));
      }
    });
    // The fixture wraps key material with AES-GCM; no real OS keystore or account data is accessed.
    const wrappingKey = crypto.randomBytes(32);
    const protect = plain => {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", wrappingKey, iv);
      const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    };
    const unprotect = bytes => {
      const decipher = crypto.createDecipheriv("aes-256-gcm", wrappingKey, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    };
    const transfer = new BrowserTransfer({ host, presence: local, settings: { data: { botscreen: { deviceToken: devtokens.add(tokensFile, name) } } },
      dir: path.join(dir, name), protect, unprotect, request, emit: event => {
        events.push(event);
        if (event.t === "transfer-status" && event.status === "error") errors.push(new Error(event.error));
      } });
    transfer.attach(link);
    link.on("msg", m => {
      if (m.t === "ws-res") {
        const p = pending.get(m.id); if (!p) return;
        pending.delete(m.id); clearTimeout(p.timer);
        if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
      } else transfer.onMessage(m);
    });
    const heartbeat = setInterval(local.push, 3000);
    const d = { deviceId, host, link, local, transfer, request, events, heartbeat, pending };
    devices.push(d); link.start(); return d;
  }
  const checkErrors = () => { if (errors.length) throw errors[0]; };
  try {
    relay.server.listen(0, "127.0.0.1"); await once(relay.server, "listening");
    pageServer.listen(0, "127.0.0.1"); await once(pageServer, "listening");
    const origin = `http://127.0.0.1:${pageServer.address().port}`;
    phase = "register authenticated devices";
    const source = device(SOURCE, "fixture-source", 0), target = device(TARGET, "fixture-target", 20);
    await until(() => { checkErrors(); return source.transfer.registered && target.transfer.registered; }, "both device identities");
    assert.equal(bundles.identity(SOURCE).publicKey, source.transfer.identity.publicKey);
    assert.equal(bundles.identity(TARGET).publicKey, target.transfer.identity.publicKey);
    phase = "launch source and seed real browser state";
    await source.request("route", SLUG, { where: "here" });
    assert.equal(presence.routeFor(SLUG, "browser").host.id, SOURCE);
    await source.host.ensure(SLUG);
    const browser = source.host.peek(SLUG);
    const c = await new CdpClient(`ws://127.0.0.1:${browser.port}${browser.wsPath}`).connect(); cdpClients.push(c);
    const { browserContextId } = await c.send("Target.createBrowserContext", { disposeOnDetach: false });
    await c.send("Storage.setCookies", { browserContextId, cookies: [{ name: "auth", value: "fixture-auth", domain: "127.0.0.1", path: "/", httpOnly: true }] });
    for (const name of ["one", "two"]) {
      const { targetId } = await c.send("Target.createTarget", { browserContextId, url: "about:blank" });
      const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
      const url = `${origin}/form?tab=${name}`;
      await c.send("Page.navigate", { url }, sessionId);
      await until(() => evaluate(c, sessionId, `location.href===${JSON.stringify(url)} && document.readyState==='complete'`), "source fixture DOM");
      await evaluate(c, sessionId, `localStorage.setItem('token','fixture-local');sessionStorage.setItem('draft',${JSON.stringify("draft-" + name)});document.getElementById('name').value=${JSON.stringify("form-" + name)};document.getElementById('password').value='never-transfer-password';document.querySelector('select').selectedIndex=1;window.scrollTo(0,${name === "one" ? 230 : 430});true`);
      await c.send("Target.detachFromTarget", { sessionId });
    }
    source.host.setController(SLUG, "user");
    const originalState = await exportState(browser);
    assert.equal(originalState.contexts[0].tabs.length, 2);
    phase = "first-export consent";
    const consent = await source.transfer.handoff(SLUG, TARGET);
    assert.equal(consent.consentRequired, true);
    assert.equal(bundles.bundles.size, 0);
    assert.equal(target.host.peek(SLUG), null);
    await source.transfer.approve(TARGET, false);
    assert.equal(source.transfer.consent.allowed, true);
    phase = "real export, sealed upload, import and acknowledgement";
    const queued = await source.transfer.handoff(SLUG, TARGET);
    assert.equal(queued.queued, true);
    await until(() => { checkErrors(); return target.events.some(e => e.t === "transfer-status" && e.status === "done"); }, "successful transfer acknowledgement", 20000);
    await until(() => source.host.peek(SLUG).status === "stopped", "source browser stopped after acknowledgement");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].reason, "manual");
    assert.equal(bundles.bundles.size, 0, "acknowledgement deletes the sealed relay package");
    assert.ok(!fs.existsSync(path.join(bundles.dir, `${stored[0].id}.json`)));
    assert.equal(relayTransfers.pending.size, 0);
    assert.equal(presence.routeFor(SLUG, "browser").host.id, TARGET);
    assert.equal(presence.pinOf(SLUG, "browser").id, TARGET);
    phase = "destination browser state and first-script storage";
    const destination = target.host.peek(SLUG);
    assert.equal(destination.controller, "user");
    const restored = await exportState(destination);
    const comparable = state => state.contexts.map(ctx => ({ cookies: ctx.cookies.map(cookie => ({ name: cookie.name, value: cookie.value, httpOnly: cookie.httpOnly })), tabs: ctx.tabs.slice().sort((a,b) => a.url.localeCompare(b.url)) }));
    assert.deepEqual(comparable(restored), comparable(originalState));
    const targetCdp = await new CdpClient(`ws://127.0.0.1:${destination.port}${destination.wsPath}`).connect(); cdpClients.push(targetCdp);
    const { targetInfos } = await targetCdp.send("Target.getTargets");
    for (const tab of targetInfos.filter(t => t.type === "page" && t.url.startsWith(origin))) {
      const name = new URL(tab.url).searchParams.get("tab");
      const { sessionId } = await targetCdp.send("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
      assert.deepEqual(await evaluate(targetCdp, sessionId, "window.bootStorage"), { local: "fixture-local", session: "draft-" + name });
      assert.equal(await evaluate(targetCdp, sessionId, "document.getElementById('password').value"), "");
      await targetCdp.send("Target.detachFromTarget", { sessionId });
    }
    assert.ok(pageRequests.filter(r => r.url.startsWith("/form?")).every(r => r.cookie.includes("auth=fixture-auth")), "restored cookies are present on the first navigation request");
    phase = "source heartbeat cannot return the browser";
    source.local.push(); target.local.push();
    await source.request("transfer-policy", "default", { autoTarget: null }); // ordered WS round-trip after source heartbeat
    assert.equal(presence.routeFor(SLUG, "browser").host.id, TARGET);
    assert.equal(source.host.peek(SLUG).status, "stopped");
    checkErrors();
  } catch (e) { e.message = `${phase}: ${e.message}`; throw e; }
  finally {
    for (const c of cdpClients) c.close();
    for (const d of devices) {
      clearInterval(d.heartbeat); d.transfer.stop(); d.link.stop();
      for (const p of d.pending.values()) { clearTimeout(p.timer); p.reject(new Error("fixture closed")); }
      await d.host.stopAll(); d.host.killAll();
    }
    hub.stop(); relayTransfers.stop();
    for (const ws of relay.clients) ws.terminate();
    await new Promise(resolve => relay.server.close(resolve));
    await new Promise(resolve => pageServer.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
