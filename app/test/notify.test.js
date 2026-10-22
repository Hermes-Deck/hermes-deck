"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const notificationRoute = (...a) => require("../main/notification-route").notificationRoute(...a);
const otherAppFullscreen = (...a) => require("../main/notification-route").otherAppFullscreen(...a);
const { BridgeClient } = require("../main/bridge");
const { setLanguage } = require("../renderer/i18n");
setLanguage("en");

function rig(route = () => "banner") {
  const banners = [], pets = [], chimes = [], timers = [];
  const state = { enabled: true, sound: true, active: false, unlocked: true };
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; }
    show() { banners.push(this); }
    close() { this.closed = true; this.emit("close"); }
  }
  const context = { module: { exports: {} }, console, Date,
    setTimeout: fn => { timers.push(fn); return fn; }, clearTimeout: fn => { const i = timers.indexOf(fn); if (i >= 0) timers.splice(i, 1); },
    require: id => id === "electron" ? { Notification } : require(path.join(__dirname, "../main", id)) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../main/notify.js"), "utf8"), context);
  const n = new context.module.exports.Notifier({ enabled: () => state.enabled, sound: () => state.sound,
    active: () => state.active, unlocked: () => state.unlocked, describe: () => ({}), onClick() {},
    route, onPet: e => pets.push(e), chime: e => chimes.push(e) });
  return { n, state, banners, pets, chimes, timers, approvalNotice: context.module.exports.approvalNotice };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

// These tests never invoke osascript, display a notification or connect to a host.
test("auto selects one channel: real fullscreen/unknown, explicit overrides and hidden pet", async () => {
  const flags = { notifications: true, pet: true, notificationMode: "auto" };
  for (const [value, expected] of [[true, "banner"], [false, "pet"], [null, "banner"]]) {
    assert.equal(await notificationRoute(flags, { platform: "darwin", fullscreen: async () => value }), expected);
  }
  for (const [mode, pet, expected] of [["pet", true, "pet"], ["pet", false, null], ["banner", true, "banner"], ["auto", false, "banner"]]) {
    assert.equal(await notificationRoute({ ...flags, notificationMode: mode, pet }, { platform: "darwin", fullscreen: () => { throw Error("must not probe"); } }), expected);
  }
  assert.equal(await notificationRoute({ ...flags, notifications: false }), null);
  assert.equal(await notificationRoute(flags, { platform: "win32" }), "pet");
  assert.equal(flags.pet, true);
});

test("native probe is bounded and treats failures/malformed/empty output as unknown", async () => {
  for (const [error, stdout, expected] of [[null, "true\n", true], [null, "false\n", false], [null, "null", null], [Error("timeout"), "false", null], [null, "", null], [null, "0", null]]) {
    assert.equal(await otherAppFullscreen((file, args, opts, done) => {
      assert.equal(file, "/usr/bin/osascript");
      assert.ok(args.includes("-e"), "packaged ASAR script is passed as text, not an unreadable external path");
      assert.equal(opts.timeout, 1500);
      assert.equal(opts.maxBuffer, 1024);
      done(error, stdout);
    }), expected);
  }
  const script = fs.readFileSync(path.join(__dirname, "../main/fullscreen-mac.jxa"), "utf8");
  assert.match(script, /AXFullScreen/);
  assert.match(script, /currentSystemPresentationOptions/);
  assert.doesNotMatch(script, /Application\('System Events'\)|CGS|AXIsProcessTrustedWithOptions/);
});

test("JXA bridges generic AX CFTypeRef values before reuse and boolean unwrapping", () => {
  const script = fs.readFileSync(path.join(__dirname, "../main/fullscreen-mac.jxa"), "utf8");
  for (const value of [true, false]) {
    const window = {}, element = {};
    const $ = s => s;
    Object.assign($, {
      NSWorkspace: { sharedWorkspace: { frontmostApplication: { processIdentifier: 42, isTerminated: false } } },
      NSApplication: { sharedApplication: { currentSystemPresentationOptions: 0 } },
      NSApplicationPresentationFullScreen: 1024,
      AXIsProcessTrusted: () => true,
      AXUIElementCreateApplication: () => element,
      AXUIElementCopyAttributeValue: (object, attribute, output) => {
        assert.equal(object, attribute === "AXFocusedWindow" ? element : window);
        output[0] = { cfValue: attribute === "AXFocusedWindow" ? window : value };
        return 0;
      },
    });
    const context = { $, Ref: () => [], ObjC: { import() {}, castRefToObject: ref => ref.cfValue, unwrap: object => object } };
    vm.createContext(context); vm.runInContext(script, context);
    assert.equal(context.run(["7"]), String(value));
  }
});

test("one logical event gets one route and sound owner; async revocation cannot deliver", async () => {
  let resolve, routes = 0;
  const r = rig(() => { routes++; return new Promise(r => { resolve = r; }); });
  r.n.notify("approval", { body: "npm run build" });
  resolve("pet"); await flush();
  assert.equal(routes, 1); assert.equal(r.pets.length, 1); assert.equal(r.banners.length, 0);
  assert.deepEqual(r.chimes, ["approval"]);
  const pending = r.n.notify("reply", { body: "next" });
  pending.close(); resolve("banner"); await flush();
  assert.equal(r.banners.length, 0);
  r.n.notify("reply"); r.state.enabled = false; resolve("pet"); await flush();
  assert.equal(r.pets.length, 1);
});

test("settled replies and delayed completion share routing, without a parallel pet feed", async () => {
  const r = rig(() => "pet");
  r.n.message({ key: "u1", id: 1, text: "old" });
  r.n.edit({ key: "u1", id: 1, text: "new" });
  r.timers.shift()();
  assert.equal(r.pets.length, 1); assert.equal(r.pets[0].snippet, "new");
  r.n.route = () => "banner";
  r.n.message({ key: "u1", id: 1, text: "replayed" });
  assert.equal(r.timers.length, 0, "same message cannot cross from pet to banner on replay");
  r.n.route = () => "pet";
  r.n.finished({ key: "u1", body: "done" }); r.timers.shift()();
  assert.equal(r.pets.length, 1, "recent reply suppresses duplicate completion in either mode");
  r.n.finished({ key: "u2", body: "done" }); r.timers.shift()();
  assert.equal(r.pets.length, 2); assert.equal(r.banners.length, 0);
});

test("native actions run once, body click reviews, dismissal never denies, lock revokes", async () => {
  const r = rig(); let actions = 0, reviews = 0, current = true;
  const payload = { body: "npm run build", exactBody: true, current: () => current,
    onClick: () => reviews++, actions: [{ text: "Approve once", run: () => actions++ }, { text: "Reject", run: () => actions++ }] };
  r.n.notify("approval", payload);
  const first = r.banners[0];
  assert.equal(first.options.body, "npm run build");
  assert.equal(first.options.silent, false); assert.deepEqual(r.chimes, []);
  first.emit("action", {}, 0); first.emit("action", {}, 1); await flush();
  assert.equal(actions, 1);
  r.n.notify("approval", payload); r.banners[1].emit("click");
  assert.equal(reviews, 1); assert.equal(actions, 1);
  r.n.notify("approval", payload); r.banners[2].emit("close");
  assert.equal(actions, 1, "dismissal is not denial");
  r.n.notify("approval", payload); current = false; r.banners[3].emit("action", {}, 0); await flush();
  assert.equal(actions, 1);
  current = true; r.n.notify("approval", payload);
  r.state.unlocked = false; r.banners[4].emit("action", {}, 0); await flush();
  assert.equal(actions, 1, "lock blocks a previously rendered action");
  r.n.notify("approval", payload); assert.equal(r.banners.length, 5, "lock suppresses new banners as well as actions");
  r.n.closeAll(); r.state.unlocked = true; r.banners[4].emit("action", {}, 0); await flush();
  assert.equal(actions, 1, "unlock never reactivates old actions");
});

test("quick approval requires attested exact short command AND target/cwd; legacy is review-only", () => {
  const { approvalNotice } = rig();
  const request = { command: "npm run build" };
  const captured = { preview: { command: request.command, target: "local", cwd: "/work", complete: true }, choices: ["once", "deny", "always"], current: () => true, answer() {} };
  const host = { id: "h1", name: "Alpha" };
  const valid = approvalNotice(request, captured, () => true, host);
  assert.equal(valid.actions.length, 2); assert.equal(valid.exactBody, true);
  assert.equal(valid.body, "Host: Alpha [h1]\nnpm run build\nTarget: local\nDirectory: /work");
  for (const patch of [{ complete: false }, { command: "" }, { target: "" }, { cwd: "" }, { command: "x".repeat(121) }, { command: "echo a\nb" }, { command: "[REDACTED]" }, { command: "echo ..." }, { command: "echo \u202eabc" }]) {
    assert.equal(approvalNotice(request, { ...captured, preview: { ...captured.preview, ...patch } }, () => true, host).actions.length, 0);
  }
  assert.equal(approvalNotice(request, captured, () => false, host).actions.length, 0);
  assert.equal(approvalNotice(request, null, () => true, host).actions.length, 0);
});

test("native approval requires a complete original host within the same preview budget", () => {
  const { approvalNotice } = rig();
  const captured = { preview: { command: "echo ok", target: "local", cwd: "/work", complete: true }, choices: ["once", "deny"], current: () => true };
  for (const host of [null, {}, { id: "h1", name: "" }, { id: "", name: "Alpha" },
    { id: "h1", name: "A\nBeta" }, { id: "h1", name: "A\u202eBeta" }, { id: "h1", name: "Alpha..." },
    { id: "h1", name: "A".repeat(121) }, { id: "h1\nBeta", name: "Alpha" }]) {
    const notice = approvalNotice({}, captured, () => true, host);
    assert.equal(notice.actions.length, 0, JSON.stringify(host));
    assert.equal(notice.exactBody, false);
  }
  const host = { id: "h1", name: "Alpha" };
  for (const language of ["en", "tr"]) {
    setLanguage(language);
    const base = approvalNotice({}, captured, () => true, host).body;
    for (const length of [120, 121]) {
      const preview = { ...captured.preview, command: captured.preview.command + "x".repeat(length - base.length) };
      const notice = approvalNotice({}, { ...captured, preview }, () => true, host);
      assert.equal(notice.body.length, length);
      assert.equal(notice.actions.length, length === 120 ? 2 : 0);
    }
  }
  setLanguage("en");
});

test("bridge notification feed closes replacements, answers and disconnects without duplicate routing", () => {
  const source = fs.readFileSync(path.join(__dirname, "../main/desktop.js"), "utf8");
  const start = source.indexOf("const asked = new Map();");
  const end = source.indexOf("\nfunction sessionDone", start);
  const notices = [], events = [];
  const context = { S: { settings: { data: { hosts: [] } } }, process: { platform: "darwin" }, directLive: new Map(), relayLive: new Map(), unlocked: () => true,
    sessionIdentity: r => JSON.stringify([r.profile, r.sid]), sourceOf: (r, hostId) => ({ ...r, hostId }), sessionKey: () => null,
    i18nText: key => key, approvalNotice: rig().approvalNotice, openSource: (source, r) => events.push({ t: "source-open", ...source, id: r.id }),
    notifier: { notify: (_kind, payload) => { const notice = { payload, close() { this.closed = true; } }; notices.push(notice); return notice; } } };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const r = { id: "a1", kind: "approval", sid: "s1", profile: "default", rpcId: "rpc", command: "npm run build" };
  context.fromBridge({ t: "requests", list: [r] });
  context.fromBridge({ t: "requests", list: [{ ...r, at: 999 }] });
  assert.equal(notices.length, 1);
  notices[0].payload.onClick();
  assert.equal(events[0].t, "source-open"); assert.equal(events[0].id, "a1"); assert.equal(events[0].profile, "default");
  context.fromBridge({ t: "requests", list: [{ ...r, command: "changed" }] });
  assert.equal(notices[0].closed, true); assert.equal(notices[0].payload.current(), false);
  assert.equal(notices.length, 2);
  context.fromBridge({ t: "requests", list: [] });
  assert.equal(notices[1].closed, true);
  context.fromBridge({ t: "requests", list: [r] });
  context.fromBridge({ t: "status", status: "offline" });
  assert.equal(notices[2].closed, true); assert.equal(notices[2].payload.current(), false);
});

test("subagent sound never bypasses OS Focus in banner mode", async () => {
  const r = rig(async () => "banner");
  assert.equal(await r.n.subagent(), false);
  assert.equal(r.chimes.length, 0); assert.equal(r.banners.length, 0);
});

function client() {
  const c = new BridgeClient({ mode: "off" });
  c.stopped = false; c.conn = { ready: true, closed: false }; c.epoch = 1;
  c._sessionRef = (rpcId, params) => ({ sid: "session", profile: params.profile || "default" });
  const params = { session_id: "rpc", command: "npm run build", profile: "default", cwd: "/work", execution_target: "local", command_complete: true, context_complete: true };
  c._onServerFrame({ id: "a1", method: "approval", params });
  const req = [...c.openRequests.values()][0];
  c.openRequests.clear(); c.openRequests.set("request", req);
  return { c, req, params };
}

test("bridge captures raw completeness without leaking execution paths to renderer", () => {
  const { c, params } = client();
  assert.equal(c.captureApproval("a1").preview.command, "npm run build");
  assert.equal(c.captureApproval("a1").preview.cwd, "/work");
  assert.equal(c.listRequests()[0].notification, undefined);
  assert.ok(!JSON.stringify(c.listRequests()).includes("/work"));
  c._onServerFrame({ id: "a2", method: "approval", params: { ...params, command: "x".repeat(4001) } });
  const long = [...c.openRequests.values()].find(r => r.id === "a2");
  assert.equal(long.command.length, 4000); assert.equal(long.notification.command, "");
});

test("native capability rejects replaced/gone/ambiguous/reconnected requests and blanket choices", async () => {
  for (const mutate of [({ c }) => c.openRequests.clear(), ({ c, req }) => c.openRequests.set("request", { ...req, command: "changed" }), ({ c }) => { c.conn = { ready: true }; }, ({ c }) => c.epoch++, ({ req }) => { req.command = "changed"; }, ({ req }) => { req.profile = "other"; }, ({ c, req }) => c.openRequests.set("duplicate", { ...req, profile: "other" })]) {
    const state = client(); let sent = 0; state.c.request = async () => { sent++; return { status: "ok" }; };
    const token = state.c.captureApproval("a1"); mutate(state);
    await assert.rejects(token.answer("once")); assert.equal(sent, 0);
  }
  const { c } = client(); const token = c.captureApproval("a1");
  await assert.rejects(token.answer("always"));
});

test("native and renderer share in-flight responder and write only request.answer once", async () => {
  const { c } = client(); const sent = []; let resolve;
  c.request = (method, params) => { sent.push({ method, params }); return new Promise(r => { resolve = r; }); };
  const token = c.captureApproval("a1");
  const answer = token.answer("once");
  await assert.rejects(c.answerApproval("a1", "deny"));
  await assert.rejects(token.answer("once"));
  assert.deepEqual(sent, [{ method: "request.answer", params: { id: "a1", result: { choice: "once" } } }]);
  resolve({ status: "ok" }); await answer;
  assert.equal(c.listRequests().length, 0);
});

test("replayed server frames cannot unlock an in-flight approval", async () => {
  const { c, params } = client();
  c.openRequests.clear();
  c._onServerFrame({ id: "a1", method: "approval", params });
  let writes = 0, resolve;
  c.request = () => { writes++; return new Promise(r => { resolve = r; }); };
  const first = c.answerApproval("a1", "once");
  c._onServerFrame({ id: "a1", method: "approval", params });
  await assert.rejects(c.answerApproval("a1", "deny"));
  assert.equal(c.captureApproval("a1").current(), false);
  assert.equal(writes, 1);
  resolve({ status: "ok" }); await first;
});

test("pending fullscreen checks honor replaced routing settings", async () => {
  for (const [patch, expected] of [[{ notificationMode: "banner", pet: false }, "banner"], [{ notificationMode: "pet", pet: false }, null], [{ notifications: false }, null]]) {
    let flags = { notifications: true, pet: true, notificationMode: "auto" }, resolve;
    const route = notificationRoute(() => flags, { platform: "darwin", fullscreen: () => new Promise(r => { resolve = r; }) });
    flags = { ...flags, ...patch };
    resolve(false);
    assert.equal(await route, expected);
  }
});

test("pet routing preserves agent-only messages, speaker avatars and quiet failures", () => {
  const r = rig(() => "pet");
  r.n.describePet = () => ({ agent: "Bot", avatar: "data:image/png;base64,AA==" });
  for (const message of [{ key: "t1", id: 1, text: "human" }, { key: "u1", id: 2, service: true, text: "service" }]) {
    r.n.message(message); r.timers.shift()();
  }
  assert.equal(r.pets.length, 0); assert.equal(r.chimes.length, 0);
  r.n.message({ key: "t1", id: 3, fromBot: true, from: "Bot", text: "reply" }); r.timers.shift()();
  assert.equal(r.pets.length, 1);
  assert.equal(r.pets[0].snippet, "reply"); assert.equal(r.pets[0].agent, "Bot");
  assert.equal(r.pets[0].avatar, "data:image/png;base64,AA==");
  r.n.finished({ body: "failed", petEligible: false }); r.timers.shift()();
  assert.equal(r.pets.length, 1);
});

test("wake and user switching recheck lock state without replaying notices", () => {
  const source = fs.readFileSync(path.join(__dirname, "../main/desktop.js"), "utf8");
  const start = source.indexOf("  const lock = () =>");
  const end = source.indexOf("  updates = createUpdateNotice", start);
  let idle = "locked", withdrawals = 0;
  const monitor = new EventEmitter(); monitor.getSystemIdleState = () => idle;
  const context = { locked: false, petTargets: new Map(), powerMonitor: monitor, notifier: { closeAll() { withdrawals++; } } };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  monitor.emit("lock-screen"); monitor.emit("resume"); assert.equal(context.locked, true);
  monitor.emit("unlock-screen"); assert.equal(context.locked, false);
  monitor.emit("user-did-resign-active"); idle = "unknown";
  monitor.emit("user-did-become-active"); assert.equal(context.locked, true);
  idle = "idle"; monitor.emit("user-did-become-active"); assert.equal(context.locked, false);
  assert.equal(withdrawals, 2);
});

test("bridge keeps explicit completion identity/source and drops initial/history frames", () => {
  const { c } = client(); const events = []; c.on("event", e => events.push(e));
  const params = { type: "message.complete", session_id: "rpc", profile: "default", turn_id: "turn-1", event_id: "event-1", source: "cli", payload: { text: "done" } };
  for (const flag of ["initial", "historical", "replay"]) c._onServerFrame({ method: "event", params: { ...params, [flag]: true } });
  assert.equal(events.length, 0);
  c._onServerFrame({ method: "event", params });
  assert.equal(events[0].turnId, "turn-1"); assert.equal(events[0].eventId, "event-1"); assert.equal(events[0].source, "cli");
  c._onServerFrame({ method: "event", params: { ...params, turn_id: "x".repeat(513), event_id: "bad\u0000id" } });
  assert.equal(events[1].turnId, ""); assert.equal(events[1].eventId, "", "invalid identity is absent, not repaired or truncated");
});
