"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const file = path.join(__dirname, "../main/browser-transfer.js");
const ownRequire = createRequire(file);
require("../renderer/i18n").setLanguage("tr"); // Friendly uncertainty wording; CDP payloads stay invariant.

function harness(t, { controller = "agent", rejectAck = false, failDisposal = false, ackCommitted = false, unknownAck = false } = {}) {
  const calls = { snapshot: 0, import: 0, http: [], requests: [], events: [], disposed: [], close: 0 };
  const deviceId = "2222222222222222", source = "1111111111111111";
  const browser = { status: "running", port: 1234, wsPath: "/devtools/browser/demo", controller: "user" };
  const contexts = new Set(["original", "new-a", "new-b"]);
  class Cdp {
    async connect() { return this; }
    async send(method, { browserContextId }) {
      assert.equal(method, "Target.disposeBrowserContext");
      calls.disposed.push(browserContextId);
      if (failDisposal && browserContextId === "new-a") throw new Error("one context already gone");
      contexts.delete(browserContextId);
      return {};
    }
    close() { calls.close++; }
  }
  const bundle = {
    loadIdentity: async () => ({ publicKey: "fixture-key" }),
    exportState: async () => { calls.snapshot++; return {}; },
    sealBundle: async () => ({ ciphertext: "opaque-fixture" }),
    openBundle: async () => ({ controller }),
    importState: async () => { calls.import++; return { contexts: ["new-a", "new-b"], tabs: ["new-tab"] }; },
  };
  const files = new Map();
  const policyFs = {
    readFileSync: name => { if (!files.has(name)) throw new Error("missing fixture file"); return files.get(name); },
    mkdirSync: () => {},
    writeFileSync: (name, data) => files.set(name, data),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
  };
  const module = { exports: {} };
  const load = vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(file, "utf8")}\n})`, { filename: file });
  load(name => name === "fs" ? policyFs : name === "./browser-bundle" ? bundle : name === "./cdp-view" ? { CdpClient: Cdp } : ownRequire(name), module, module.exports);
  const presence = new EventEmitter(); presence.id = deviceId;
  const host = { peek: () => browser, enabled: () => true, ensure: async () => browser,
    setController: (_slug, next) => { browser.controller = next; }, list: () => [] };
  const transfer = new module.exports.BrowserTransfer({ host, presence, settings: { data: {} }, dir: path.join(__dirname, "missing-policy"),
    request: async (op, slug, extra) => {
      calls.requests.push({ op, slug, extra });
      if (rejectAck && op === "transfer-applied") throw new Error("apply acknowledgement refused");
      if (unknownAck && op === "transfer-state") throw new Error("relay disconnected");
      if (op === "transfer-state") return { committed: ackCommitted };
      return {};
    }, emit: m => calls.events.push(m) });
  t.after(() => transfer.stop());
  transfer.http = async (method, endpoint, body) => {
    calls.http.push({ method, endpoint, body });
    return { bundle: { slug: "demo", source, target: deviceId } };
  };
  return { transfer, browser, contexts, calls, files, message: { id: "b".repeat(32), slug: "demo", source } };
}

function approvalHarness(t) {
  const h = harness(t);
  const { transfer, calls } = h;
  const relay = new EventEmitter();
  transfer.attach(relay);
  transfer.registered = true;
  transfer.http = async (method, endpoint) => {
    calls.http.push({ relay: transfer.relay, method, endpoint });
    return { devices: [{ deviceId: "fallback", fresh: true }, { deviceId: transfer.presence.id, fresh: true }] };
  };
  transfer.request = async (op, slug, extra) => { calls.requests.push({ relay: transfer.relay, op, slug, extra }); return {}; };
  return { ...h, relay };
}

const connectionChanges = {
  forget: transfer => transfer.forget(),
  replace: transfer => { transfer.attach(new EventEmitter()); transfer.registered = true; },
  detach: transfer => transfer.attach(null),
  reconnect: transfer => {
    transfer.relay.emit("status", { status: "closed" });
    transfer.relay.emit("status", { status: "open" });
    transfer.registered = true;
  },
  "host switch": transfer => {
    transfer.forget();
    transfer.attach(new EventEmitter());
    transfer.registered = true;
  },
};

for (const boundary of ["devices", "policy"]) {
  for (const [change, invalidate] of Object.entries(connectionChanges)) {
    test(`transfer: pending approval at ${boundary} rejects after ${change}`, async t => {
      const { transfer, calls, files, relay } = approvalHarness(t);
      const entered = Promise.withResolvers(), resume = Promise.withResolvers();
      const method = boundary === "devices" ? "http" : "request";
      const original = transfer[method].bind(transfer);
      transfer[method] = async (...args) => {
        const result = await original(...args);
        entered.resolve();
        await resume.promise;
        return result;
      };
      const pending = transfer.approve("fallback", true);
      await entered.promise;
      invalidate(transfer);
      const saved = [...files];
      resume.resolve();
      const result = await pending.then(value => ({ value }), error => ({ error }));
      assert.deepEqual(calls.requests, boundary === "devices" ? [] : [
        { relay, op: "transfer-policy", slug: "default", extra: { autoTarget: "fallback" } },
      ], "a stale approval must never send policy to the new connection");
      assert.deepEqual(transfer.consent, { allowed: false, autoTarget: null }, "stale consent must stay off");
      assert.deepEqual([...files], saved, "stale approval must not persist consent");
      assert.ok(result.error, "stale approval must reject so the caller cannot continue to handoff");
    });
  }
}

for (const [target, automatic, autoTarget] of [["fallback", true, "fallback"], ["fallback", false, null], ["self", true, null]]) {
  test(`transfer: unchanged connection approves ${target}, automatic=${automatic}`, async t => {
    const { transfer, calls, files, relay } = approvalHarness(t);
    const state = await transfer.approve(target === "self" ? transfer.presence.id : target, automatic);
    assert.equal(state.consented, true);
    assert.equal(state.automaticTarget, autoTarget);
    assert.deepEqual(calls.requests, [{ relay, op: "transfer-policy", slug: "default", extra: { autoTarget } }]);
    assert.deepEqual(JSON.parse(files.get(transfer.policyFile)), { allowed: true, autoTarget });
  });
}

test("transfer: stale policy completion cannot overwrite fresh approval on the new host", async t => {
  const { transfer, files, calls } = approvalHarness(t);
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const request = transfer.request;
  transfer.request = async (...args) => {
    const result = await request(...args);
    entered.resolve();
    await resume.promise;
    return result;
  };
  const stale = transfer.approve("fallback", true);
  await entered.promise;
  connectionChanges["host switch"](transfer);
  transfer.request = request;
  await transfer.approve("fallback", false);
  const saved = files.get(transfer.policyFile);
  resume.resolve();
  const result = await stale.then(value => ({ value }), error => ({ error }));
  assert.deepEqual(transfer.consent, { allowed: true, autoTarget: null });
  assert.equal(files.get(transfer.policyFile), saved);
  assert.notEqual(calls.requests[0].relay, calls.requests[1].relay);
  assert.equal(calls.requests.length, 2);
  assert.ok(result.error);
});

test("transfer: rejected policy and stale targets never grant consent", async t => {
  const { transfer, calls, files } = approvalHarness(t);
  transfer.http = async () => ({ devices: [{ deviceId: "fallback", fresh: false }] });
  await assert.rejects(transfer.approve("fallback", true));
  assert.equal(calls.requests.length, 0);
  transfer.http = async () => ({ devices: [{ deviceId: "fallback", fresh: true }] });
  transfer.request = async () => { throw new Error("policy refused"); };
  await assert.rejects(transfer.approve("fallback", true), /policy refused/);
  assert.deepEqual(transfer.consent, { allowed: false, autoTarget: null });
  assert.equal(files.size, 0);
});

test("transfer: first-export consent gates snapshot and upload, and checkpoint stays quiet", async t => {
  const { transfer, calls } = harness(t);
  await transfer.export("demo", "1111111111111111", "fixture-key");
  assert.equal(calls.snapshot, 0); assert.equal(calls.http.length, 0);
  assert.equal(calls.events.length, 1); assert.equal(calls.events[0].t, "transfer-consent");
  calls.events.length = 0;
  await transfer.export("demo", "1111111111111111", "fixture-key", "checkpoint");
  assert.equal(calls.snapshot, 0); assert.equal(calls.http.length, 0); assert.equal(calls.events.length, 0);
  transfer.consent.allowed = true;
  await transfer.export("demo", "1111111111111111", "fixture-key");
  assert.equal(calls.snapshot, 1); assert.equal(calls.http.length, 1); assert.equal(calls.http[0].method, "POST");
});

test("transfer: failed apply acknowledgement discards new contexts and preserves original controller", async t => {
  const { transfer, browser, contexts, calls, message } = harness(t, { rejectAck: true });
  await assert.rejects(transfer.receive(message), /acknowledgement refused/);
  assert.deepEqual(calls.disposed, ["new-a", "new-b"]);
  assert.deepEqual([...contexts], ["original"]);
  assert.equal(browser.controller, "user");
  assert.equal(calls.close, 1);
  assert.equal(transfer.importing.size, 0);
  assert.equal(calls.requests.at(-1).op, "transfer-failed");
});

test("transfer: a checkpoint cannot release a manual handoff mutation fence", async t => {
  const { transfer, browser, calls } = harness(t);
  transfer.consent.allowed = true;
  await transfer.export("demo", "1111111111111111", "fixture-key", "manual");
  assert.equal(browser.transferring, true);
  await transfer.export("demo", "1111111111111111", "fixture-key", "checkpoint");
  assert.equal(calls.snapshot, 1);
  assert.equal(calls.http.length, 1);
  assert.equal(browser.transferring, true);
});

test("transfer: cleanup attempts every imported context if an earlier one has already gone", async t => {
  const { transfer, calls, message } = harness(t, { rejectAck: true, failDisposal: true });
  await assert.rejects(transfer.receive(message), /acknowledgement refused/);
  assert.deepEqual(calls.disposed, ["new-a", "new-b"]);
  assert.equal(calls.close, 1);
});

test("transfer: successful apply acknowledgement retains source user's control and imported contexts", async t => {
  const { transfer, browser, contexts, calls, message } = harness(t, { controller: "user" });
  await transfer.receive(message);
  assert.equal(browser.controller, "user");
  assert.deepEqual([...contexts], ["original", "new-a", "new-b"]);
  assert.equal(calls.requests[0].op, "transfer-applied");
  assert.equal(transfer.importing.size, 0);
  assert.equal(calls.disposed.length, 0);
});

test("transfer: a lost acknowledgement after relay commit never disposes the only restored state", async t => {
  const { transfer, contexts, calls, message } = harness(t, { rejectAck: true, ackCommitted: true, controller: "user" });
  await transfer.receive(message);
  assert.deepEqual([...contexts], ["original", "new-a", "new-b"]);
  assert.equal(calls.disposed.length, 0);
  assert.equal(calls.requests.at(-1).op, "transfer-state");
  assert.equal(transfer.uncertainImports.size, 0);
});

test("transfer: unknown acknowledgement outcome preserves imported state until reconnect reconciliation", async t => {
  const { transfer, contexts, calls, message } = harness(t, { rejectAck: true, unknownAck: true, controller: "user" });
  await assert.rejects(transfer.receive(message), /durumu korundu/);
  assert.deepEqual([...contexts], ["original", "new-a", "new-b"]);
  assert.equal(calls.disposed.length, 0);
  assert.equal(transfer.uncertainImports.size, 1);
  transfer.request = async () => ({ committed: true });
  await transfer.retryImport(transfer.uncertainImports.get(message.id));
  assert.equal(transfer.uncertainImports.size, 0);
  assert.equal(calls.disposed.length, 0);
});
