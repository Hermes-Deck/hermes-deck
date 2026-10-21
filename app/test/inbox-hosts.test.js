"use strict";
// Shared approval inbox across hosts: each card answers to the host that raised it, and only while it is connected.
const test = require("node:test");
const assert = require("node:assert/strict");
const I = require("../renderer/inbox");

const h = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat(Infinity).filter(x => x != null) });
const walk = node => [node, ...(node.children || []).filter(x => typeof x === "object").flatMap(walk)];
const buttons = (store, row) => walk(I.requestBody({ h, store, t: k => k, forms: new Map(), redraw() {} }, row)).filter(n => n.tag === "button");
const req = (id, extra = {}) => ({ id, sid: "s-1", profile: "default", kind: "approval", command: "make build", choices: ["once", "deny"], ...extra });

function world() {
  const sent = [];
  const deck = {
    bridge: { answerApproval: async (id, v, o) => { sent.push(["active", id, v, o.profile]); return { status: "ok" }; } },
    hosts: { answer: async (host, kind, id, v, o) => { sent.push([host, id, v, o.profile]); return { status: "ok" }; } },
  };
  const store = I.createStore(deck);
  store.feedBridge({ t: "status", status: "open" });
  return { store, sent };
}

test("the same request id on the active host and another host shows two cards, each answered to its own host", async () => {
  const { store, sent } = world();
  store.feedBridge({ t: "requests", list: [req("A1")] });
  store.feedHosts({ t: "requests", hosts: [{ id: "h2", name: "Host B", status: "open", requests: [req("A1")] }] });
  const rows = store.items();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].key, rows[1].key);
  const remote = rows.find(r => r.host === "h2"), local = rows.find(r => !r.host);
  assert.equal(await store.answer(remote, "deny"), true);
  assert.equal(await store.answer(local, "once"), true);
  assert.deepEqual(sent, [["h2", "A1", "deny", "default"], ["active", "A1", "once", "default"]]);
});

test("equal ids on two other hosts never meet", async () => {
  const { store, sent } = world();
  store.feedHosts({ t: "requests", hosts: [
    { id: "h2", name: "Host B", status: "open", requests: [req("A1")] },
    { id: "h3", name: "Host C", status: "open", requests: [req("A1")] },
  ] });
  const rows = store.items();
  assert.equal(rows.length, 2);
  assert.equal(await store.answer(rows.find(r => r.host === "h3"), "once"), true);
  assert.deepEqual(sent, [["h3", "A1", "once", "default"]]);
  assert.deepEqual(store.items().map(r => r.host), ["h2"], "only the answered card leaves");
});

test("a card of a disconnected host is inert and sends nothing; the active host is unaffected", async () => {
  const { store, sent } = world();
  store.feedHosts({ t: "requests", hosts: [{ id: "h2", name: "Host B", status: "open", requests: [req("A1")] }] });
  const row = store.items()[0];
  assert.ok(buttons(store, row).every(b => !b.attrs.disabled));
  store.feedHosts({ t: "requests", hosts: [{ id: "h2", name: "Host B", status: "connecting", requests: [req("A1")] }] });
  assert.ok(buttons(store, row).every(b => b.attrs.disabled), "the host is not connected");
  assert.equal(await store.answer(row, "once"), false);
  assert.deepEqual(sent, []);
});

test("a remote answer with an unknown outcome is not sent again", async () => {
  let calls = 0;
  const store = I.createStore({ hosts: { answer: async () => { calls++; throw new Error("timed out"); } } });
  store.feedHosts({ t: "requests", hosts: [{ id: "h2", name: "Host B", status: "open", requests: [req("A1")] }] });
  const row = store.items()[0];
  const first = store.answer(row, "once");
  assert.equal(await store.answer(row, "once"), false, "a second click while in flight is refused");
  assert.equal(await first, false);
  store.feedHosts({ t: "requests", hosts: [{ id: "h2", name: "Host B", status: "open", requests: [req("A1")] }] });
  assert.equal(calls, 1, "nothing retries on its own");
  assert.equal(store.error(row.key), "timed out");
});

test("a card answered on another device leaves when its host stops listing it", () => {
  const { store } = world();
  store.feedHosts({ t: "requests", hosts: [{ id: "h2", name: "Host B", status: "open", requests: [req("A1"), req("A2")] }] });
  assert.equal(store.items().length, 2);
  store.feedHosts({ t: "requests", hosts: [{ id: "h2", name: "Host B", status: "open", requests: [req("A2")] }] });
  assert.deepEqual(store.items().map(r => r.id), ["A2"]);
});

test("each card names its host, as text", () => {
  const { dom } = require("./inbox-dom-helper"), { h: hh, doc, walk: w } = dom();
  const { store } = world();
  store.feedHosts({ t: "requests", hosts: [{ id: "h2", name: "<b>Host B</b>", status: "open", requests: [req("A1")] }] });
  const view = I.createInbox({ h: hh, doc, store, t: (k, v) => (v ? `${k}:${v.host}` : k), shell: { main: () => "inbox", icon: () => hh("svg") }, openChat: () => true });
  assert.ok(w(view.root).some(n => (n.children || []).some(c => typeof c === "string" && c.includes("triage.fromHost:<b>Host B</b>"))));
});

test("only an advertised choice reaches another host", async () => {
  const { store, sent } = world();
  store.feedHosts({ t: "requests", hosts: [{ id: "h2", name: "Host B", status: "open", requests: [req("A1")] }] });
  assert.equal(await store.answer(store.items()[0], "always"), false);
  assert.deepEqual(sent, []);
});
