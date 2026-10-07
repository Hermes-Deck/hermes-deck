"use strict";
// Per-chat composer drafts (renderer/drafts.js): chats keep separate drafts, a send clears only its own chat's
// draft, drafts survive a reload, storage is bounded. No Electron: a tiny fake textarea and storage.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const D = require("../renderer/drafts");

class FakeInput {
  constructor() {
    this.value = "";
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.scrollTop = 0;
    this.handlers = {};
  }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  dispatchEvent(ev) { for (const fn of this.handlers[ev.type] || []) fn(ev); }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  type(text) { this.value = text; this.selectionStart = this.selectionEnd = text.length; this.dispatchEvent({ type: "input" }); }
}
global.Event ||= class { constructor(type) { this.type = type; } };

function memory(seed = {}) {
  const m = { ...seed };
  return { get: (k) => (k in m ? m[k] : null), set: (k, v) => { m[k] = v; }, raw: m };
}

function rig({ storage = memory(), now = () => 1000 } = {}) {
  const input = new FakeInput();
  let key = "hermes:a";
  const timers = [];
  const ctx = {
    els: { input }, storage, now, key: () => key, autosize() {}, after() {},
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: (id) => { timers[id - 1] = null; },
  };
  const dr = D.create(ctx);
  return { dr, input, storage, go(k) { key = k; return dr.sync(); }, tick() { for (const fn of timers.splice(0)) if (fn) fn(); } };
}

test("drafts: each chat keeps its own text; switching back restores it with the caret", () => {
  const r = rig();
  r.go("hermes:a");
  r.input.type("hello from a");
  r.input.setSelectionRange(5, 5);
  r.go("hermes:b");
  assert.equal(r.input.value, ""); // b has no draft: the text did not follow
  r.input.type("note for b");
  r.go("hermes:a");
  assert.equal(r.input.value, "hello from a");
  assert.equal(r.input.selectionStart, 5);
  r.go("hermes:b");
  assert.equal(r.input.value, "note for b");
});

test("drafts: sync is idempotent for the same chat and does not clobber a half-typed box", () => {
  const r = rig();
  r.go("hermes:a");
  r.input.type("typing");
  assert.equal(r.dr.sync(), false);
  assert.equal(r.input.value, "typing");
});

test("drafts: a send clears only the chat it was sent in, also after the reader moved away", () => {
  const r = rig();
  r.go("hermes:a");
  r.input.type("question one");
  r.go("hermes:b");
  r.input.type("draft b");
  r.tick(); // b's debounce fired
  r.dr.sent("hermes:a", "question one"); // the send in a finishes while b is on screen
  assert.equal(r.input.value, "draft b");
  assert.equal(r.dr.read("hermes:a"), null);
  assert.equal(r.dr.read("hermes:b").text, "draft b");
  r.go("hermes:a");
  assert.equal(r.input.value, "");
});

test("drafts: a send in the visible chat clears the box only when it still holds the sent text", () => {
  const r = rig();
  r.go("hermes:a");
  r.input.type("sent text");
  r.dr.sent("hermes:a", "sent text");
  assert.equal(r.input.value, "");
  r.input.type("sent text, then more");
  r.dr.sent("hermes:a", "sent text"); // the owner kept typing: leave it
  assert.equal(r.input.value, "sent text, then more");
});

test("drafts: a draft changed after the send began is kept for the chat that is not on screen", () => {
  const r = rig();
  r.go("hermes:a");
  r.input.type("first");
  r.go("hermes:b");
  r.dr.write("hermes:a", { text: "first and edited", start: 0, end: 0, scroll: 0 });
  r.dr.sent("hermes:a", "first");
  assert.equal(r.dr.read("hermes:a").text, "first and edited");
});

test("drafts: restored after a reload (persisted debounced and on leaving a chat)", () => {
  const storage = memory();
  const r = rig({ storage });
  r.go("hermes:a");
  r.input.type("survives reload");
  r.tick(); // the debounce fired
  const r2 = rig({ storage });
  r2.go("hermes:a");
  assert.equal(r2.input.value, "survives reload");
  // leaving a chat persists too, without waiting for the debounce
  r2.input.type("changed");
  r2.go("hermes:b");
  const r3 = rig({ storage });
  r3.go("hermes:a");
  assert.equal(r3.input.value, "changed");
});

test("drafts: empty text removes the draft; a deleted chat leaves nothing", () => {
  const r = rig();
  r.go("hermes:a");
  r.input.type("x");
  r.go("hermes:b");
  assert.deepEqual(r.dr.store.keys(), ["hermes:a"]);
  r.go("hermes:a");
  r.input.type("   ");
  r.go("hermes:b");
  assert.deepEqual(r.dr.store.keys(), []);
  r.input.type("keep me");
  r.dr.forget("hermes:b");
  assert.equal(r.input.value, "");
  assert.deepEqual(r.dr.store.keys(), []);
});

test("drafts: a chat with no selection never persists; storage is bounded in count, size and age", () => {
  const r = rig();
  r.go("hermes:"); // no session selected
  r.input.type("floating");
  r.go("hermes:a");
  assert.deepEqual(r.dr.store.keys(), []);
  r.go("hermes:");
  assert.equal(r.input.value, "floating"); // kept while the page lives

  let t = 0;
  const storage = memory();
  const s = new D.DraftStore(storage, { now: () => ++t, maxDrafts: 3 });
  for (let i = 0; i < 5; i++) s.set(`k${i}`, { text: `t${i}`, start: 0, end: 0, scroll: 0 });
  assert.deepEqual(s.keys(), ["k2", "k3", "k4"]); // oldest dropped
  s.set("big", { text: "x".repeat(D.MAX_CHARS + 500), start: 0, end: 0, scroll: 0 });
  assert.equal(s.get("big").text.length, D.MAX_CHARS);

  const old = JSON.stringify({ stale: { text: "old", start: 0, end: 0, scroll: 0, at: 1 }, fresh: { text: "new", start: 0, end: 0, scroll: 0, at: D.MAX_AGE_MS + 10 } });
  const aged = new D.DraftStore(memory({ [D.STORE_KEY]: old }), { now: () => D.MAX_AGE_MS + 20 });
  assert.deepEqual(aged.keys(), ["fresh"]);
  assert.deepEqual(new D.DraftStore(memory({ [D.STORE_KEY]: "{not json" })).keys(), []);
  assert.deepEqual(new D.DraftStore(memory({ [D.STORE_KEY]: "[1,2]" })).keys(), []);
});

test("drafts: a Telegram chat key and a Hermes key are separate drafts", () => {
  const r = rig();
  r.go("-100123:7");
  r.input.type("telegram text");
  r.go("hermes:a");
  assert.equal(r.input.value, "");
  r.go("-100123:7");
  assert.equal(r.input.value, "telegram text");
});
