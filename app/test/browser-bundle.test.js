"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const sodium = require("libsodium-wrappers");
const B = require("../main/browser-bundle");
const source = "1111111111111111", target = "2222222222222222", now = 1700000000000;
const state = () => ({ version: 1, contexts: [{ id: "default", cookies: [{ name: "session", value: "private-cookie", domain: "example.test", path: "/", httpOnly: true, secure: false, sameSite: "Lax", expires: -1 }], tabs: [{ url: "http://example.test/form", localStorage: { token: "private-local" }, sessionStorage: { draft: "private-session" }, forms: [{ index: 0, tag: "INPUT", type: "text", id: "name", name: "name", value: "private-form", checked: false }], scroll: { x: 0, y: 170 } }] }] });
async function identity() { await sodium.ready; const k = sodium.crypto_box_keypair(); return { publicKey: Buffer.from(k.publicKey).toString("base64"), privateKey: k.privateKey }; }

test("bundle: sealed box round-trip, wrong key, tamper, expiry and bound metadata", async () => {
  const key = await identity(), wrong = await identity();
  const e = await B.sealBundle(state(), { source, target, slug: "demo", publicKey: key.publicKey, now });
  assert.deepEqual(await B.openBundle(e, key, { deviceId: target, now: now + 1 }), state());
  assert.equal(e.reason, "manual");
  assert.equal(e.expiresAt, now + 300000);
  for (const secret of ["private-cookie", "private-local", "private-session", "private-form"]) assert.ok(!JSON.stringify(e).includes(secret));
  await assert.rejects(B.openBundle(e, wrong, { deviceId: target, now }), /bundle|key/i);
  await assert.rejects(B.openBundle({ ...e, source: "3333333333333333" }, key, { deviceId: target, now }), /bundle|metadata/i);
  await assert.rejects(B.openBundle({ ...e, reason: "sleep" }, key, { deviceId: target, now }), /bundle|metadata/i);
  await assert.rejects(B.openBundle(e, key, { deviceId: source, now }), /bundle|target/i);
  await assert.rejects(B.openBundle(e, key, { deviceId: target, now: e.expiresAt }), /bundle|expired/i);
  const changed = Buffer.from(e.ciphertext, "base64"); changed[changed.length - 1] ^= 1;
  const bad = { ...e, ciphertext: changed.toString("base64"), sha256: crypto.createHash("sha256").update(changed).digest("hex") };
  await assert.rejects(B.openBundle(bad, key, { deviceId: target, now }), /bundle/i);
  await assert.rejects(B.openBundle({ ...e, sha256: "0".repeat(64) }, key, { deviceId: target, now }), /bundle|checksum/i);
  await assert.rejects(B.sealBundle(state(), { source, target, slug: 0, publicKey: key.publicKey, now }), /metadata/i);
});

test("bundle: identity persists protected bytes and rejects corrupt identity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-key-")), file = path.join(dir, "identity");
  const wrap = { protect: s => Buffer.from(s).map(v => v ^ 0x5a), unprotect: b => Buffer.from(b).map(v => v ^ 0x5a).toString() };
  try {
    const a = await B.loadIdentity(file, wrap), b = await B.loadIdentity(file, wrap);
    assert.equal(a.publicKey, b.publicKey); assert.deepEqual(a.privateKey, b.privateKey);
    assert.ok(!fs.readFileSync(file).toString().includes(a.publicKey));
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, "broken"); await assert.rejects(B.loadIdentity(file, wrap), /identity/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("bundle: rejects invalid URL and malformed state before connecting to target", async () => {
  const key = await identity();
  for (const url of ["file:///private", "javascript:alert(1)", "https://user:secret@example.test/"]) {
    const s = state(); s.contexts[0].tabs[0].url = url;
    await assert.rejects(B.sealBundle(s, { source, target, slug: "demo", publicKey: key.publicKey, now }), /state|URL/i);
    await assert.rejects(B.importState({}, s, class { constructor() { assert.fail("invalid state must not connect"); } }), /state|URL/i);
  }
  const s = state(); s.contexts[0].tabs[0].forms[0].type = "password";
  await assert.rejects(B.sealBundle(s, { source, target, slug: "demo", publicKey: key.publicKey, now }), /state|form/i);
  const badCookie = state(); badCookie.contexts[0].cookies[0].url = "file:///private";
  await assert.rejects(B.sealBundle(badCookie, { source, target, slug: "demo", publicKey: key.publicKey, now }), /state/i);
});

class FakeCdp {
  static calls = []; static closed = 0; static failNavigation = false;
  constructor(url) { assert.match(url, /^ws:\/\/127\.0\.0\.1:4321\/devtools\/browser\/demo$/); }
  async connect() { return this; }
  close() { FakeCdp.closed++; }
  async send(method, params = {}, session = null) {
    FakeCdp.calls.push({ method, params, session });
    if (method === "Target.getTargets") return { targetInfos: [{ targetId: "tab-a", type: "page", url: "http://example.test/form" }, { targetId: "blank", type: "page", url: "about:blank" }, { targetId: "tab-b", type: "page", browserContextId: "private", url: "http://example.test/form" }] };
    if (method === "Storage.getCookies") return { cookies: state().contexts[0].cookies };
    if (method === "Target.attachToTarget") { assert.equal(params.flatten, true); return { sessionId: "session-" + params.targetId }; }
    if (method === "Runtime.evaluate") {
      if (params.expression.includes("document.readyState")) return { result: { value: true } };
      if (params.expression.includes("document.querySelectorAll") && params.expression.includes("localStorage")) return { result: { value: state().contexts[0].tabs[0] } };
      return { result: { value: true } };
    }
    if (method === "Target.createBrowserContext") return { browserContextId: "new-context-" + FakeCdp.calls.length };
    if (method === "Target.createTarget") return { targetId: "new-tab-" + FakeCdp.calls.length };
    if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "storage-script" };
    if (method === "Page.navigate" && FakeCdp.failNavigation) return { errorText: "simulated navigation failure" };
    return {};
  }
}
const browser = { port: 4321, wsPath: "/devtools/browser/demo" };

test("bundle: a blank-only paused browser exports and restores without opaque-origin storage access", async () => {
  class BlankCdp extends FakeCdp {
    async send(method, params, session) {
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "blank", type: "page", url: "about:blank" }] };
      assert.notEqual(method, "Runtime.evaluate");
      return super.send(method, params, session);
    }
  }
  FakeCdp.calls = [];
  const blank = await B.exportState({ ...browser, controller: "user" }, BlankCdp);
  assert.equal(blank.controller, "user");
  assert.equal(blank.contexts[0].tabs[0].url, "about:blank");
  assert.deepEqual(blank.contexts[0].cookies, []);
  const restored = await B.importState(browser, blank, BlankCdp);
  assert.equal(restored.tabs.length, 1);
  assert.ok(!FakeCdp.calls.some(c => c.method === "Page.navigate" || c.method === "Runtime.evaluate"));
  blank.contexts[0].tabs[0].localStorage = { token: "not-allowed" };
  assert.throws(() => B.validateState(blank), /state/i);
});

test("bundle: CDP keeps cookie contexts, detaches source and restores fresh contexts in order", async () => {
  FakeCdp.calls = []; FakeCdp.closed = 0;
  const s = await B.exportState({ ...browser, controller: "user" }, FakeCdp);
  assert.equal(s.controller, "user");
  const key = await identity();
  assert.equal((await B.openBundle(await B.sealBundle(s, { source, target, slug: "demo", publicKey: key.publicKey, now }), key, { deviceId: target, now })).controller, "user");
  assert.equal(s.contexts.length, 2); assert.equal(s.contexts[0].tabs.length, 1); assert.equal(s.contexts[1].tabs.length, 1);
  assert.equal(FakeCdp.calls.filter(c => c.method === "Storage.getCookies").length, 2);
  assert.equal(FakeCdp.calls.filter(c => c.method === "Target.detachFromTarget").length, 2);
  FakeCdp.calls = [];
  const restored = await B.importState(browser, s, FakeCdp);
  assert.equal(restored.contexts.length, 2); assert.equal(restored.tabs.length, 2);
  assert.equal(FakeCdp.closed, 2);
  const calls = FakeCdp.calls;
  assert.equal(calls.find(c => c.method === "Target.createBrowserContext").params.disposeOnDetach, false);
  const nav = calls.findIndex(c => c.method === "Page.navigate");
  assert.ok(calls.findIndex(c => c.method === "Storage.setCookies") < nav);
  const storage = calls.find(c => c.method === "Page.addScriptToEvaluateOnNewDocument");
  assert.ok(calls.indexOf(storage) < nav); assert.ok(storage.params.source.includes("location.origin"));
  assert.ok(calls.findIndex(c => c.method === "Page.removeScriptToEvaluateOnNewDocument") > nav);
});

test("bundle: failed import disposes all newly created contexts and closes connection", async () => {
  FakeCdp.calls = []; FakeCdp.failNavigation = true;
  try { await assert.rejects(B.importState(browser, state(), FakeCdp), /restore|navigation/i); }
  finally { FakeCdp.failNavigation = false; }
  assert.equal(FakeCdp.calls.filter(c => c.method === "Target.disposeBrowserContext").length, 1);
});

test("bundle: portable app and relay modules stay byte-identical", () => {
  assert.equal(fs.readFileSync(path.join(__dirname, "../main/browser-bundle.js"), "utf8"), fs.readFileSync(path.join(__dirname, "../../relay/src/browser-bundle.js"), "utf8"));
});

test("bundle: real headless browser preserves isolated cookies, first-script storage, form and scroll", { skip: process.env.DECK_TEST_BROWSER_BUNDLE_REAL !== "1", timeout: 45000 }, async () => {
  const http = require("node:http");
  const { findBrowser, launchBrowser } = require("../main/agent-browser");
  const { CdpClient } = require("../main/cdp-view");
  const exe = findBrowser(); assert.ok(exe, "a headless Chromium browser is required");
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<script>window.initialStorage={local:localStorage.getItem('token'),session:sessionStorage.getItem('draft')};</script><input id="name" name="name"><input id="secret" type="password"><input type="file"><select id="choice" name="choice"><option>zero</option><option>one</option></select><div style="height:4000px"></div>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-real-"));
  const running = [], clients = [];
  let lastMethod = "launch", phase = "start";
  const evalPage = async (c, s, expression) => {
    const r = await c.send("Runtime.evaluate", { expression, returnByValue: true }, s); assert.ok(!r.exceptionDetails); return r.result.value;
  };
  const ready = async (c, s) => {
    for (let i = 0; i < 100; i++) { if (await evalPage(c, s, "document.readyState==='complete'")) return; await new Promise(r => setTimeout(r, 20)); }
    assert.fail("local test page did not finish loading");
  };
  try {
    for (const name of ["source", "target"]) running.push(await launchBrowser({ exe: exe.path, dir: path.join(dir, name), timeoutMs: 10000 }));
    for (const b of running) {
      const c = await new CdpClient(`ws://127.0.0.1:${b.port}${b.wsPath}`).connect();
      const send = c.send.bind(c); c.send = (...args) => { lastMethod = args[0]; return send(...args); }; clients.push(c);
    }
    const c = clients[0];
    for (const name of ["one", "two"]) {
      phase = "source-" + name;
      const { browserContextId } = await c.send("Target.createBrowserContext", { disposeOnDetach: false });
      await c.send("Storage.setCookies", { browserContextId, cookies: [{ name: "auth", value: name, domain: "127.0.0.1", path: "/", httpOnly: true }] });
      const { targetId } = await c.send("Target.createTarget", { browserContextId, url: "about:blank" });
      const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
      await c.send("Page.navigate", { url: origin + "/form?context=" + name }, sessionId); await ready(c, sessionId);
      await evalPage(c, sessionId, `localStorage.setItem('token',${JSON.stringify(name)});sessionStorage.setItem('draft',${JSON.stringify(name + "-draft")});document.getElementById('name').value=${JSON.stringify(name + "-form")};document.getElementById('secret').value='must-not-transfer';document.getElementById('choice').selectedIndex=1;window.scrollTo(0,230);true`);
      await c.send("Target.detachFromTarget", { sessionId });
    }
    phase = "export";
    const exported = await B.exportState(running[0]);
    assert.equal(exported.contexts.length, 2);
    assert.ok(!JSON.stringify(exported).includes("must-not-transfer"));
    const key = await identity();
    const e = await B.sealBundle(exported, { source, target, slug: "demo", publicKey: key.publicKey });
    phase = "import";
    const restored = await B.importState(running[1], await B.openBundle(e, key, { deviceId: target }));
    assert.equal(restored.contexts.length, 2);
    const after = await B.exportState(running[1]);
    const normalized = s => s.contexts.map(ctx => ({ cookies: ctx.cookies.map(k => ({ name: k.name, value: k.value, httpOnly: k.httpOnly })), tabs: ctx.tabs })).sort((a,b) => a.tabs[0].url.localeCompare(b.tabs[0].url));
    assert.deepEqual(normalized(after), normalized(exported));
    for (let i = 0; i < restored.tabs.length; i++) {
      const { sessionId } = await clients[1].send("Target.attachToTarget", { targetId: restored.tabs[i], flatten: true });
      const captured = await evalPage(clients[1], sessionId, "window.initialStorage");
      const name = new URL(exported.contexts[i].tabs[0].url).searchParams.get("context");
      assert.deepEqual(captured, { local: name, session: name + "-draft" });
      assert.equal(await evalPage(clients[1], sessionId, "document.getElementById('secret').value"), "");
    }
  } catch (e) { e.message = `${phase}, ${lastMethod}, browser exits ${running.map(b => b.proc.exitCode).join(',')}: ${e.message}`; throw e; }
  finally {
    for (const c of clients) { try { await c.send("Browser.close", {}, null, 1000); } catch {} c.close(); }
    for (const b of running) { if (b.proc.exitCode === null) { await Promise.race([new Promise(r => b.proc.once("exit", r)), new Promise(r => setTimeout(r, 3000))]); if (b.proc.exitCode === null) b.proc.kill(); } }
    await new Promise(resolve => server.close(resolve));
    // Windows may retain a profile lock briefly while the browser's utility processes quit.
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
