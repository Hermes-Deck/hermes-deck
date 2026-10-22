"use strict";
// Watch: the live session a page shows is followed read-only on that page's host (BridgeClient.watch/unwatch against
// fake-stream.js, and the renderer's selection hook renderer/watch.js against a fake preload). Nothing here touches
// SSH, the network or a real Hermes host.
//   node --test app/test/watch.test.js
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { BridgeClient } = require("../main/bridge");
const DeckWatch = require("../renderer/watch");
const { setLanguage } = require("../renderer/i18n");
setLanguage("en");

const FAKE = path.join(__dirname, "fake-stream.js");
const CFG = { mode: "ssh", target: "hermes-test", python: "/usr/bin/python3", stream: "~/.hermes/hermes-deck/stream.py" };
const FAST = { request: 1500, write: 1000, handshake: 1500, heartbeat: 1200, kill: 500, backoffMin: 40, backoffMax: 160, keepalive: 60000 };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "deck-watch-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpLog = () => path.join(fs.mkdtempSync(path.join(TMP, "log-")), "requests.log");
const readLog = (file) => { try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const calls = (file, method) => readLog(file).filter((e) => e.method === method);
const views = (log) => calls(log, "deck.reasoning_view").map((e) => [e.params.session_id, e.params.show]);
const WRITES = ["prompt.submit", "deck.takeover", "session.close", "session.interrupt", "native.interrupt", "deck.attach_submit"];
const writes = (log) => readLog(log).filter((e) => WRITES.includes(e.method)).map((e) => e.method);

function makeClient(t, flags = [], opts = {}) {
  const c = new BridgeClient(CFG, { launch: { file: process.execPath, args: [FAKE, "--serve", ...flags] }, timing: FAST, ...opts });
  t.after(() => c.stop());
  return c;
}
function next(emitter, event, pred = () => true, ms = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.off(event, on); reject(new Error(`timed out waiting for ${event}`)); }, ms);
    function on(v) { if (!pred(v)) return; clearTimeout(timer); emitter.off(event, on); resolve(v); }
    emitter.on(event, on);
  });
}
async function startOpen(c) {
  const ready = next(c, "status", (s) => s.status === "open");
  const snap = next(c, "snapshot");
  c.start();
  await ready;
  await snap; // nodeFor() knows the sub-agent child's parent from here
}
/** Wait until the log holds `n` calls of `method` (requests the client sends without awaiting a reply). */
async function waitCalls(log, method, n) {
  for (let i = 0; i < 200 && calls(log, method).length < n; i++) await sleep(10);
  return calls(log, method);
}
const boundOf = (c, sid) => c.currentSnapshot().nodes.find((n) => n.sid === sid).bound;

// ---------------------------------------------------------------- BridgeClient.watch / unwatch

test("watch: a live session is resumed once with omit_messages, its events reach the Deck, and nothing is written", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log, "--resume-events"], { showReasoning: true });
  const seen = [];
  c.on("event", (e) => seen.push([e.type, e.sid]));
  await startOpen(c);
  assert.deepEqual(await c.watch("s-main", { profile: "default", owner: "page-a" }), { watching: true });
  assert.deepEqual(calls(log, "session.resume").map((e) => e.params), [{ session_id: "s-main", omit_messages: true, inline_images: false }]);
  await waitCalls(log, "deck.reasoning_view", 1);
  assert.deepEqual(views(log), [["rpc-s-main", true]], "Show thinking on: the watched session streams its reasoning");
  for (let i = 0; i < 100 && seen.length < 2; i++) await sleep(10);
  assert.deepEqual(seen, [["tool.start", "s-main"], ["reasoning.delta", "s-main"]], "events arrive under the stored id");
  assert.deepEqual(await c.watch("s-main", { profile: "default", owner: "page-a" }), { watching: true });
  assert.equal(calls(log, "session.resume").length, 1, "watching again on the same connection does not resume again");
  assert.equal(boundOf(c, "s-main"), false, "a watch-only binding offers no Stop");
  assert.deepEqual(writes(log), [], "read-only: no prompt, takeover, close or interrupt");
});

test("watch: a gateway sub-agent child is resumed lazy (Hermes' agentless watch session the sub-agent mirror feeds)", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log]);
  await startOpen(c);
  assert.deepEqual(await c.watch("s-child", { owner: "page-a" }), { watching: true });
  assert.deepEqual(calls(log, "session.resume").map((e) => e.params), [{ session_id: "s-child", omit_messages: true, inline_images: false, lazy: true }]);
  assert.deepEqual(views(log), [], "Show thinking off: nothing is armed");
  assert.deepEqual(writes(log), []);
});

test("unwatch disarms only what the watch armed and closes nothing; coming back re-arms; another session replaces it", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log], { showReasoning: true });
  await startOpen(c);
  await c.watch("s-main", { owner: "page-a" });
  await waitCalls(log, "deck.reasoning_view", 1);
  assert.deepEqual(c.unwatch("s-main", { owner: "page-a" }), { watching: false });
  c.unwatch("s-main", { owner: "page-a" }); // twice: still one disarm
  await waitCalls(log, "deck.reasoning_view", 2);
  await c.watch("s-main", { owner: "page-a" }); // back to it: the binding stays, its reasoning view is armed again
  await waitCalls(log, "deck.reasoning_view", 3);
  await c.watch("s-child", { owner: "page-a" }); // the page selects another live session: the first one is left
  await waitCalls(log, "deck.reasoning_view", 5);
  await sleep(50);
  assert.deepEqual(views(log), [["rpc-s-main", true], ["rpc-s-main", false], ["rpc-s-main", true], ["rpc-s-main", false], ["rpc-s-child", true]]);
  assert.equal(calls(log, "session.resume").length, 2, "s-main was resumed once, s-child once");
  assert.deepEqual(writes(log), []);
});

test("two pages watching the same session: leaving it on one keeps it armed for the other", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log], { showReasoning: true });
  await startOpen(c);
  await c.watch("s-main", { owner: "page-a" });
  await c.watch("s-main", { owner: "page-b" });
  c.unwatch("s-main", { owner: "page-a" });
  await sleep(80);
  assert.deepEqual(views(log), [["rpc-s-main", true]]);
  c.unwatch("s-main", { owner: "page-b" });
  await waitCalls(log, "deck.reasoning_view", 2);
  assert.deepEqual(views(log), [["rpc-s-main", true], ["rpc-s-main", false]]);
});

test("Show thinking toggled while watching: on reaches the watched session only, off undoes what the watch armed", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log]);
  await startOpen(c);
  await c.watch("s-main", { owner: "page-a" });
  await c.watch("s-child", { owner: "page-b" });
  c.unwatch("s-child", { owner: "page-b" }); // left again: not armed by anything
  c.setReasoning(true);
  await waitCalls(log, "deck.reasoning_view", 1);
  await sleep(50);
  assert.deepEqual(views(log), [["rpc-s-main", true]], "the left session is not armed");
  c.setReasoning(false);
  await waitCalls(log, "deck.reasoning_view", 2);
  await sleep(50);
  assert.deepEqual(views(log), [["rpc-s-main", true], ["rpc-s-main", false]], "never a 'false' for a view this Deck did not arm");
});

test("a send turns a watched session into a driven one: Stop is offered, the resume is not repeated, leaving keeps it armed", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log], { showReasoning: true });
  await startOpen(c);
  await c.watch("s-main", { owner: "page-a" });
  await waitCalls(log, "deck.reasoning_view", 1);
  await c.send("s-main", "Hello");
  assert.equal(calls(log, "session.resume").length, 1);
  assert.equal(boundOf(c, "s-main"), true);
  c.unwatch("s-main", { owner: "page-a" });
  await sleep(80);
  assert.deepEqual(views(log), [["rpc-s-main", true]], "a session the Deck drives keeps Show thinking as before");
});

test("a watch-only binding never stops a turn or closes a runtime: Stop and delete behave as without the watch", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log, "--uncontrolled"]);
  await startOpen(c);
  await c.watch("s-main", { owner: "page-a" });
  await assert.rejects(c.interrupt("s-main"), /no live turn to stop/);
  await c.watch("s-idle", { profile: "research", owner: "page-a" }); // the renderer only watches live ones; main must still be safe
  await c.deleteSession("s-idle", { profile: "research" });
  const methods = readLog(log).map((e) => e.method).filter((m) => ["session.close", "session.delete", "session.interrupt"].includes(m));
  assert.deepEqual(methods, ["session.delete"], "no session.close of a runtime the Deck only watched");
});

test("a session another process owns: one refused resume per connection, retried after a reconnect", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log, "--resume-fail", "s-main", "--exit-on", "native.steer"]);
  await startOpen(c);
  const first = await c.watch("s-main", { owner: "page-a" });
  assert.equal(first.watching, false);
  assert.match(first.error, /live owner/);
  assert.deepEqual(await c.watch("s-main", { owner: "page-a" }), { watching: false });
  await c.watch("s-child", { owner: "page-a" });
  await c.watch("s-main", { owner: "page-a" });
  assert.equal(calls(log, "session.resume").filter((e) => e.params.session_id === "s-main").length, 1, "no retry loop on the same connection");
  c.request("native.steer", { session_id: "s-main", turn_id: "t1", owner_pid: 4242, text: "x" }).catch(() => {});
  await next(c, "status", (s) => s.status === "offline", 8000);
  await next(c, "status", (s) => s.status === "open", 8000);
  await c.watch("s-main", { owner: "page-a" });
  assert.equal(calls(log, "session.resume").filter((e) => e.params.session_id === "s-main").length, 2, "one attempt on the new connection");
  assert.deepEqual(writes(log), []);
});

test("a reconnect drops every watch: the page watches again and the session is resumed and armed on the new connection", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log, "--exit-on", "native.steer"], { showReasoning: true });
  await startOpen(c);
  await c.watch("s-main", { owner: "page-a" });
  await waitCalls(log, "deck.reasoning_view", 1);
  c.request("native.steer", { session_id: "s-main", turn_id: "t1", owner_pid: 4242, text: "x" }).catch(() => {});
  await next(c, "status", (s) => s.status === "offline", 8000);
  assert.equal(c.watching.size, 0);
  await next(c, "status", (s) => s.status === "open", 8000);
  await c.watch("s-main", { owner: "page-a" });
  await waitCalls(log, "deck.reasoning_view", 2);
  assert.equal(calls(log, "session.resume").length, 2);
  assert.deepEqual(views(log), [["rpc-s-main", true], ["rpc-s-main", true]]);
});

test("the page moved on while Hermes resumed: the late watch is disarmed at once", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log, "--delay", "session.resume=150"], { showReasoning: true });
  await startOpen(c);
  const slow = c.watch("s-main", { owner: "page-a" });
  await sleep(20);
  c.unwatch("s-main", { owner: "page-a" });
  assert.deepEqual(await slow, { watching: false });
  await waitCalls(log, "deck.reasoning_view", 2);
  assert.deepEqual(views(log), [["rpc-s-main", true], ["rpc-s-main", false]]);
});

// ---------------------------------------------------------------- renderer/watch.js (the page's selection hook)

function page() {
  const sent = [];
  const deck = { bridge: {
    watch: async (sid, o) => { sent.push(["watch", sid, o.profile]); return { watching: true }; },
    unwatch: async (sid, o) => { sent.push(["unwatch", sid, o.profile]); return { watching: false }; },
  } };
  const state = { sel: null };
  const W = DeckWatch.create({ deck, want: () => state.sel });
  return { W, sent, state };
}

test("renderer: the selected LIVE session is watched once per connection, left on idle or another selection", () => {
  const { W, sent, state } = page();
  W.status("open", "connecting");
  assert.deepEqual(sent, [], "nothing selected");
  state.sel = { sid: "s-main", profile: "default" };
  W.sync();
  W.sync(); // every snapshot calls it: no repeat
  assert.deepEqual(W.watching(), { sid: "s-main", profile: "default" });
  state.sel = { sid: "s-child", profile: "default" };
  W.sync(); // another live session: main replaces the old one (one per page)
  state.sel = null; // the session went idle or the page left it
  W.sync();
  W.sync();
  assert.deepEqual(sent, [["watch", "s-main", "default"], ["watch", "s-child", "default"], ["unwatch", "s-child", "default"]]);
  assert.equal(W.watching(), null);
});

test("renderer: a reconnect watches the still-selected session again; a dead connection is not unwatched", () => {
  const { W, sent, state } = page();
  state.sel = { sid: "s-main", profile: "research" };
  W.status("open", "connecting");
  W.status("open", "open"); // a repeated open frame: same connection
  W.status("offline", "open");
  state.sel = null;
  W.sync(); // nothing to unwatch: the old connection's bindings are gone
  state.sel = { sid: "s-main", profile: "research" };
  W.status("connecting", "offline");
  W.status("open", "connecting");
  assert.deepEqual(sent, [["watch", "s-main", "research"], ["watch", "s-main", "research"]]);
});

test("renderer: a failed watch call is swallowed (the row stays snapshot-only)", async () => {
  const errors = [];
  const deck = { bridge: { watch: async () => { throw new Error("offline"); }, unwatch: async () => ({}) } };
  const W = DeckWatch.create({ deck, want: () => ({ sid: "s-main", profile: "default" }), onError: (e) => errors.push(e.message) });
  W.status("open");
  await sleep(0);
  assert.deepEqual(errors, ["offline"]);
});

test("wiring: preload exposes watch/unwatch, main routes them by the sender page, app.js hooks selection, snapshots and status", () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const preload = src("main/preload.js"), main = src("main/main.js"), app = src("renderer/app.js"), html = src("renderer/index.html");
  assert.match(preload, /watch: \(sid, opts\) => ipcRenderer\.invoke\("bridge:watch", sid, opts\)/);
  assert.match(preload, /unwatch: \(sid, opts\) => ipcRenderer\.invoke\("bridge:unwatch", sid, opts\)/);
  assert.match(main, /ipc\.handle\("bridge:watch", \(e, sid, o\) => needBridge\(e\)\.watch\(/, "the sender page's own host runtime");
  assert.match(main, /ipc\.handle\("bridge:unwatch", \(e, sid, o\) => \{\n  const rt = runtimeOf\(e\);/);
  const body = (name) => { const i = app.indexOf(`  function ${name}(`); return app.slice(i, app.indexOf("\n  }\n", i)); };
  assert.match(body("hermesSelect"), /if \(WA\) WA\.sync\(\);/);
  assert.match(body("hermesLeave"), /if \(WA\) WA\.sync\(\);/);
  assert.match(body("applyBridgeSnapshot"), /if \(WA\) WA\.sync\(\);/);
  assert.match(body("applyBridgeStatus"), /if \(WA\) WA\.status\(s\.status, was\);/);
  assert.ok(html.indexOf('src="watch.js"') > 0 && html.indexOf('src="watch.js"') < html.indexOf('src="app.js"'), "loaded before app.js");
  const used = [...src("renderer/watch.js").matchAll(/deck\.bridge\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].sort(), ["unwatch", "watch"], "the renderer side calls nothing else (no write path)");
});

test("receipts: a watched gateway sub-agent's mirrored tool events do not double its calls (its deck.tools push carries them)", () => {
  const { boot } = require("./composer-dom-helper");
  const env = boot();
  env.inner.replaceChildren(env.user("go", { dataset: { ts: String(env.clock / 1000 - 1) } }));
  env.flush();
  env.fire("deck-conversation-turn", { sid: "s", type: "message.start", payload: {}, at: env.clock });
  env.fire("deck-conversation-turn", { sid: "s", type: "tool.start", payload: { tool_id: "submirror:s:1", name: "terminal" }, at: env.clock });
  env.bridgeEvent({ t: "event", type: "deck.tools", sid: "s", payload: { tools: [{ call: "c1", tool: "terminal", ts: env.clock / 1000, status: "running" }] } });
  env.fire("deck-conversation-turn", { sid: "s", type: "tool.complete", payload: { tool_id: "submirror:s:1" }, at: env.clock + 100 });
  env.flush();
  assert.deepEqual(Array.from(env.win.DeckReceipts.calls("s"), (c) => c.call), ["c1"], "one call, under its real id");
});
