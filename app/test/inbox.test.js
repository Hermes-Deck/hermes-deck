"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const I = require("../renderer/inbox");

test("inbox groups real requests before failed and recent top-level finished sessions", () => {
  const items = I.collect({ requests: [{ id: "req-1", kind: "approval", sid: "s-1", profile: "default", choices: ["once", "deny"] }],
    direct: [{ sid: "s-1", state: "approval", profile: "default" }, { sid: "s-2", state: "error", terminalAt: 99990 },
      { sid: "s-3", state: "finished", terminalAt: 99980 }, { sid: "child", parent: "s-3", state: "finished", terminalAt: 99990 },
      { sid: "old", state: "finished", terminalAt: 1 }],
    relay: [{ sid: "s-2", state: "failed", lastTs: 99990 }, { sid: "s-4", state: "done", lastTs: 99970 }] }, 100000000);
  assert.deepEqual(items.map(x => x.type), ["approval", "failed", "done", "done"]);
  assert.deepEqual(items.map(x => x.sid), ["s-1", "s-2", "s-3", "s-4"]);
});

test("request controls only expose advertised session permission and preserve question ids", () => {
  const h = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat(Infinity).filter(x => x != null) });
  const store = I.createStore();
  const ctx = { h, store, t: key => key, forms: new Map(), redraw() {} };
  const walk = node => [node, ...(node.children || []).filter(x => typeof x === "object").flatMap(walk)];
  const approval = { key: "one", request: { id: "req-1", kind: "approval", choices: ["once", "deny", "always"] } };
  const controls = walk(I.requestBody(ctx, approval));
  assert.deepEqual(controls.filter(x => x.tag === "button").map(x => x.children.join("")), ["triage.deny", "triage.approve"]);
  approval.request.choices.push("session");
  assert.ok(walk(I.requestBody(ctx, approval)).some(x => x.children?.includes("triage.allowSession")));
  const question = { key: "two", request: { id: "req-2", kind: "question", questions: [{ qid: "qid-1", question: "Choose", choices: ["<b>one</b>", "two"], multi: false }] } };
  const tree = walk(I.requestBody(ctx, question));
  tree.find(x => x.tag === "input").attrs.oninput({ target: { value: "custom answer" } });
  assert.deepEqual(I.questionAnswers(question.request, ctx.forms.get("two")), { "qid-1": "custom answer" });
  assert.ok(tree.some(x => x.children?.includes("<b>one</b>")), "untrusted choices stay text children");
  const unusual = { key: "three", request: { kind: "question", questions: [{ qid: "constructor", question: "Question", choices: ["Choice"] }] } };
  assert.doesNotThrow(() => I.requestBody(ctx, unusual), "question ids never access object prototypes");
});

test("inbox navigation wraps and dismiss is local with undo", () => {
  const store = I.createStore({}, () => 100000000);
  store.feedRelay({ t: "snapshot", sessions: [{ sid: "s-1", state: "failed", lastTs: 99999 }, { sid: "s-2", state: "done", lastTs: 99990 }] });
  assert.equal(I.moveIndex(0, -1, 2), 1);
  assert.equal(I.moveIndex(1, 1, 2), 0);
  const row = store.items()[0];
  assert.equal(store.dismiss(row), true);
  assert.equal(store.items().length, 1);
  assert.equal(store.data.relay.length, 2);
  store.undo();
  assert.equal(store.items().length, 2);
  assert.equal(store.dismiss({ type: "approval", key: "request-1" }), false);
  assert.equal(I.keyIntent({ key: "a", target: { tagName: "INPUT" } }), null);
  assert.equal(I.keyIntent({ key: "a", repeat: true }), null);
  assert.equal(I.keyIntent({ key: "a" }), "approve");
  assert.equal(I.keyIntent({ key: "ArrowDown" }), "next");
  assert.equal(I.keyIntent({ key: "j", target: { tagName: "BUTTON" } }), "next");
  assert.equal(I.keyIntent({ key: "Enter", target: { tagName: "BUTTON" } }), null);
});

test("relay completion follows notification transitions, not idle or stale guesses", () => {
  const store = I.createStore({}, () => 100000000);
  store.feedRelay({ t: "snapshot", sessions: [{ sid: "idle", state: "idle", lastTs: 99999 }, { sid: "s-1", state: "running", lastTs: 99990 }, { sid: "cron", state: "running", cron: true, lastTs: 99990 }] });
  assert.equal(store.items().length, 0);
  store.feedRelay({ t: "evs", sessions: [{ sid: "s-1", state: "idle", lastTs: 99999, lastMsg: "Task complete" }, { sid: "cron", state: "idle", cron: true, lastTs: 99999 }] });
  assert.equal(store.items().length, 1);
  assert.equal(store.items()[0].type, "done");
  store.feedRelay({ t: "evs", sessions: [{ sid: "s-1", state: "idle", lastTs: 99999 }] });
  assert.equal(store.items().length, 1);
  store.feedRelay({ t: "evs", sessions: [{ sid: "s-1", state: "running", lastTs: 100000 }] });
  assert.equal(store.items().length, 0);
});

test("late initial status seeds untouched fields without replacing newer request pushes", async () => {
  let emit, resolve;
  const ready = new Promise(r => { resolve = r; });
  const deck = { bridge: { onEvent: fn => { emit = fn; return () => {}; }, status: () => ready } };
  const store = I.createStore(deck);
  const feed = I.connect(store, deck);
  emit({ t: "requests", list: [{ id: "new", kind: "approval", choices: ["once"] }] });
  resolve({ status: { status: "open" }, requests: [{ id: "old", kind: "approval" }], snapshot: { nodes: [{ sid: "s-1", state: "idle" }] } });
  await feed.ready;
  assert.equal(store.data.bridgeStatus, "open");
  assert.equal(store.data.requests[0].id, "new");
  assert.equal(store.data.direct[0].sid, "s-1");
  feed.stop();
});

test("inbox DOM view expands selection and opens the current row with Enter", () => {
  const { dom } = require("./inbox-dom-helper"), { h, doc, walk } = dom();
  const store = I.createStore({}, () => 100000000);
  store.feedBridge({ t: "requests", list: [{ id: "req-1", sid: "s-1", kind: "approval", command: "<script>text</script>", choices: ["once", "deny"] }, { id: "req-2", sid: "s-2", kind: "approval", choices: ["once"] }] });
  const opened = [];
  const view = I.createInbox({ h, doc, store, t: key => key, shell: { main: () => "inbox", icon: () => h("svg") }, openChat: row => opened.push(row.sid) });
  assert.equal(walk(view.root).filter(n => n.attrs?.class === "te-row-body").length, 1);
  assert.ok(walk(view.root).some(n => n.children?.includes("<script>text</script>")));
  view.keydown({ key: "j", preventDefault() {} });
  view.keydown({ key: "Enter", preventDefault() {} });
  assert.deepEqual(opened, ["s-2"]);
});

test("direct native starts supply honest elapsed time and completion survives idle snapshots", () => {
  const store = I.createStore({}, () => 100000000);
  store.feedBridge({ t: "snapshot", snapshot: { nodes: [{ sid: "s-1", profile: "default", state: "working" }] } });
  store.feedBridge({ t: "event", type: "message.start", sid: "s-1", profile: "default", payload: {} });
  assert.equal(store.data.direct[0].turnTs, 100000);
  store.feedBridge({ t: "event", type: "message.complete", sid: "s-1", profile: "default", payload: { text: "Complete" } });
  store.feedBridge({ t: "snapshot", snapshot: { nodes: [{ sid: "s-1", profile: "default", state: "idle", updatedAt: 100000 }] } });
  assert.equal(store.items()[0].type, "done");
  let updates = 0; store.subscribe(() => { updates++; });
  store.feedBridge({ t: "event", type: "message.delta", sid: "s-1", payload: { text: "irrelevant" } });
  assert.equal(updates, 0, "streaming text does not rebuild triage views");
});

test("inbox answers once through the existing bridge and never retries after rejection", async () => {
  let calls = 0;
  const store = I.createStore({ bridge: { answerApproval: async () => { calls++; throw new Error("Disconnected"); } } });
  store.feedBridge({ t: "status", status: "open" });
  store.feedBridge({ t: "requests", list: [{ id: "req-1", profile: "default", kind: "approval", choices: ["once", "deny"] }] });
  const row = store.items()[0];
  const first = store.answer(row, "once");
  assert.equal(await store.answer(row, "once"), false);
  assert.equal(await first, false);
  assert.equal(calls, 1);
  assert.equal(store.error(row.key), "Disconnected");
  store.feedBridge({ t: "status", status: "closed" });
  store.feedBridge({ t: "status", status: "open" });
  assert.equal(calls, 1);
  assert.equal(await store.answer(row, "once"), false);
});

test("an acknowledged answer leaves with the exit animation, inert, then disappears", async () => {
  const { dom } = require("./inbox-dom-helper"), { h, doc, walk } = dom();
  const store = I.createStore({ bridge: { answerApproval: async () => ({ status: "ok" }) } }, () => 100000000);
  store.feedBridge({ t: "status", status: "open" });
  store.feedBridge({ t: "requests", list: [{ id: "req-1", sid: "s-1", kind: "approval", choices: ["once"] }, { id: "req-2", sid: "s-2", kind: "approval", choices: ["once"] }] });
  const view = I.createInbox({ h, doc, store, t: key => key, shell: { main: () => "inbox", icon: () => h("svg") }, openChat: () => true });
  const rowsOf = () => walk(view.root).filter(n => n.tag === "article");
  assert.equal(await store.answer(store.items()[0], "once"), true);
  const rows = rowsOf();
  assert.equal(rows.length, 2, "the answered row stays for its exit");
  const out = rows.find(n => n.attrs.class.split(" ").includes("out"));
  assert.ok(out && out.inert && out.attrs["aria-hidden"] === "true", "the leaving row is marked out and inert");
  assert.ok(walk(view.root).some(n => n.tag === "h2" && n.children.some(c => c.tag === "b" && c.children.includes("1"))), "group counts exclude leaving rows");
  await new Promise(r => setTimeout(r, 300));
  assert.equal(rowsOf().length, 1);
  assert.ok(!rowsOf()[0].attrs.class.includes("out"));
});

test("dismiss animates through the same exit path and Undo brings the row back", async t => {
  globalThis.DeckUsage = require("../renderer/usage-view"); t.after(() => { delete globalThis.DeckUsage; });
  const { dom } = require("./inbox-dom-helper"), { h, doc, walk } = dom();
  const store = I.createStore({}, () => 100000000);
  store.feedRelay({ t: "snapshot", sessions: [{ sid: "s-1", state: "failed", lastTs: 99999 }, { sid: "s-2", state: "done", lastTs: 99990 }] });
  const view = I.createInbox({ h, doc, store, t: key => key, shell: { main: () => "inbox", icon: () => h("svg") }, openChat: () => true });
  view.keydown({ key: "x", preventDefault() {} });
  assert.equal(store.items().length, 1, "the store drops the row at once");
  assert.ok(walk(view.root).some(n => n.tag === "article" && n.attrs.class.includes("out")));
  walk(view.root).find(n => n.tag === "button" && n.children.includes("triage.undo")).click();
  assert.equal(store.items().length, 2);
  assert.equal(walk(view.root).filter(n => n.tag === "article" && n.attrs.class.includes("out")).length, 0);
});

test("a rejected delivery reports the translated message, never a source literal", async () => {
  const store = I.createStore({ bridge: { answerApproval: async () => ({ status: "gone" }) } }, () => 1, key => `T:${key}`);
  store.feedBridge({ t: "status", status: "open" });
  store.feedBridge({ t: "requests", list: [{ id: "req-1", kind: "approval", choices: ["once"] }] });
  const row = store.items()[0];
  assert.equal(await store.answer(row, "once"), false);
  assert.equal(store.error(row.key), "T:triage.notDelivered");
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../renderer/inbox.js"), "utf8");
  assert.ok(!src.includes("Answer not delivered"));
});

test("turn notes and local dismissals stay bounded", () => {
  let clock = 100000000;
  const store = I.createStore({}, () => clock);
  for (let i = 0; i < I.LIMIT + 50; i++) store.feedBridge({ t: "event", type: "message.start", sid: `s-${i}`, profile: "default" });
  assert.equal(store.sizes().turns, I.LIMIT);
  const sessions = Array.from({ length: I.LIMIT + 50 }, (_, i) => ({ sid: `f-${i}`, state: "failed", lastTs: 99999 }));
  store.feedRelay({ t: "snapshot", sessions });
  for (const row of store.items()) store.dismiss(row);
  assert.ok(store.sizes().dismissed <= I.LIMIT);
  const bag = new Set([1, 2, 3, 4]); I.cap(bag, 2);
  assert.deepEqual([...bag], [3, 4], "the oldest entries go first");
});
