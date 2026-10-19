"use strict";
// Group Chat renderer helpers (app/renderer/group-chat.js): selection ids, log merging, the gateway's turn order
// replayed from the log (who the live row names), the transcript, row summaries and the composer's @ list.
// Pure: no DOM, no host. Run from the repo root: node --test app/test/group-chat.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setLanguage } = require("../renderer/i18n");
const G = require("../renderer/group-chat");

setLanguage("en");

const ROOM = {
  id: "deck-1",
  name: "Planning",
  members: [
    { id: "atlas", profile: "atlas", handle: "atlas", name: "Atlas" },
    { id: "ada", profile: "ada", handle: "ada", name: "Ada" },
    { id: "default", profile: "default", handle: "hermes", name: "Hermes" },
  ],
};
let seq = 0;
const ev = (kind, extra = {}) => ({ seq: ++seq, id: `e${seq}`, kind, at: 1000 + seq, thread: "main", ...extra });
const user = (text, extra) => ev("message.user", { text, actor: { kind: "user", id: "desktop" }, ...extra });
const said = (d, member, round, text) => ev("message.member", { text, member, round, discussion: d.id, actor: { kind: "member", id: member, profile: member, name: "" } });
const settled = (d, member, round, passed = false) => ev("turn.settled", { member, round, discussion: d.id, passed });
const activity = (d, status = "settled") => ev("room.activity", { status, discussion: d.id });

test("selection ids: room:<id> and the create form never look like Hermes sessions", () => {
  assert.equal(G.isRoomSel("room:deck-1"), true);
  assert.equal(G.isRoomSel(G.NEW), true);
  assert.equal(G.isRoomSel("bot:atlas"), false);
  assert.equal(G.isRoomSel(null), false);
  assert.equal(G.roomIdOf("room:deck-1"), "deck-1");
  assert.equal(G.roomIdOf(G.NEW), null);
  assert.equal(G.selOf("deck-2"), "room:deck-2");
});

test("mergeEvents: seq order, a later copy replaces an earlier one, no repeats", () => {
  const a = [{ seq: 3, kind: "x" }, { seq: 1, kind: "x" }];
  const b = [{ seq: 2, kind: "y" }, { seq: 3, kind: "z" }, { kind: "no seq" }];
  assert.deepEqual(G.mergeEvents(a, b).map((e) => [e.seq, e.kind]), [[1, "x"], [2, "y"], [3, "z"]]);
  const many = Array.from({ length: 2100 }, (_, i) => ({ seq: i + 1 }));
  const kept = G.mergeEvents([], many);
  assert.equal(kept.length, 2000);
  assert.equal(kept[0].seq, 101); // the newest are kept
});

test("addressed: like the gateway, no or unknown mention means everyone; @all / @everyone too", () => {
  const ids = (text, all) => G.addressed(text, ROOM.members, all).map((m) => m.id);
  assert.deepEqual(ids("hello"), ["atlas", "ada", "default"]);
  assert.deepEqual(ids("@ada and @HERMES look"), ["ada", "default"]);
  assert.deepEqual(ids("@nobody here"), ["atlas", "ada", "default"]);
  assert.deepEqual(ids("@all quick check"), ["atlas", "ada", "default"]);
  assert.deepEqual(ids("@everyone"), ["atlas", "ada", "default"]);
  assert.deepEqual(ids("no mention", false), []);
  assert.equal(G.mentionsUser("Done. @user please check."), true);
  assert.equal(G.mentionsUser("mail me at me@user.example"), false);
  assert.equal(G.mentionsUser("@username is a handle"), false);
});

test("pendingDiscussion: the latest user message until the gateway settles it or the owner stops", () => {
  seq = 0;
  const d1 = user("hi all");
  assert.equal(G.pendingDiscussion([d1]).id, d1.id);
  const done = [d1, said(d1, "atlas", 0, "hello"), settled(d1, "atlas", 0), activity(d1)];
  assert.equal(G.pendingDiscussion(done), null);
  const d2 = user("@ada next");
  assert.equal(G.pendingDiscussion([...done, d2]).id, d2.id);
  assert.equal(G.pendingDiscussion([...done, d2, ev("room.stop_requested")]), null);
  // one open message per thread, the oldest first; the other thread's turn comes after this one settles
  const t = user("side topic", { thread: "t-2" });
  assert.equal(G.pendingDiscussion([...done, d2, t]).id, d2.id);
  assert.equal(G.pendingDiscussion([...done, d2, t, activity(d2)]).id, t.id);
});

test("nextSpeaker: replays the gateway's turn order (addressed members, rotation by round, cited peers)", () => {
  seq = 0;
  const d = user("plan the week");
  assert.equal(G.nextSpeaker(ROOM, [d]).id, "atlas"); // nobody named: everyone, roster order
  const a1 = said(d, "atlas", 0, "I take the outline");
  const log = [d, a1, settled(d, "atlas", 0)];
  assert.equal(G.nextSpeaker(ROOM, log).id, "ada");
  log.push(settled(d, "ada", 0, true), said(d, "default", 0, "@ada can you check the numbers?"), settled(d, "default", 0));
  // round 1: only the cited peer that has not spoken since
  assert.equal(G.nextSpeaker(ROOM, log).id, "ada");
  log.push(said(d, "ada", 1, "Numbers are fine"), settled(d, "ada", 1));
  assert.equal(G.nextSpeaker(ROOM, log), null); // nothing cited any more: the round settles
  // an @mention picks the first round
  seq = 100;
  const m = user("@hermes and @ada only");
  assert.deepEqual([G.nextSpeaker(ROOM, [m]).id], ["ada"]);
  assert.equal(G.nextSpeaker(ROOM, [m, settled(m, "ada", 0)]).id, "default");
  assert.equal(G.nextSpeaker(ROOM, []), null);
});

test("liveState: an approval waits on its member; an idle driver does not keep a stale message 'working'", () => {
  seq = 0;
  const d = user("go");
  const now = d.at + 5;
  assert.deepEqual(G.liveState(ROOM, [d], null, now), { working: true, waiting: false, speaker: ROOM.members[0] });
  assert.deepEqual(G.liveState(ROOM, [d], { working: true, approvals: [] }, now).speaker.id, "atlas");
  const asking = G.liveState(ROOM, [d], { working: true, approvals: [{ memberId: "ada" }] }, now);
  assert.deepEqual([asking.working, asking.waiting, asking.speaker.id], [true, true, "ada"]);
  assert.equal(G.liveState(ROOM, [d], { working: false, blocked: false, approvals: [] }, d.at + 600).working, false);
  assert.equal(G.liveState(ROOM, [d, activity(d)], { working: false, approvals: [] }, now).working, false);
  assert.equal(G.liveState(ROOM, [], { working: true, approvals: [] }, now).working, true);
  assert.equal(G.liveState(ROOM, [], { working: true, approvals: [] }, now).speaker, null);
});

test("transcript: messages in arrival order, a failed turn, a rename and a stop as notes; other threads marked", () => {
  seq = 0;
  const d = user("hi");
  const items = G.transcript([
    d, said(d, "atlas", 0, "hello"), settled(d, "atlas", 0), ev("turn.failed", { member: "ada", error: "provider down" }),
    ev("room.renamed", { name: "Launch" }), ev("room.stop_requested"), user("side", { thread: "t-2" }), ev("other"),
  ]);
  assert.deepEqual(items.map((i) => i.type + (i.note ? `:${i.note}` : "")), ["user", "member", "note:failed", "note:renamed", "note:stopped", "user"]);
  assert.deepEqual([items[1].member, items[1].text, items[1].thread], ["atlas", "hello", false]);
  assert.equal(items[2].error, "provider down");
  assert.equal(items[5].thread, true);
});

test("rowSummary: latest message, unread member messages, @user = needs you; the owner's reply clears both", () => {
  seq = 0;
  const d = user("hi");
  const a = said(d, "atlas", 0, "hello");
  const b = said(d, "ada", 0, "@user which date?");
  let s = G.rowSummary([d, a, settled(d, "atlas", 0), b], d.seq);
  assert.deepEqual([s.last.id, s.unread, s.needsYou, s.at], [b.id, 2, true, b.at]);
  s = G.rowSummary([d, a, b], b.seq);
  assert.deepEqual([s.unread, s.needsYou], [0, false]);
  s = G.rowSummary([d, a, b, user("Friday")], 0);
  assert.deepEqual([s.unread, s.needsYou], [0, false]);
  assert.deepEqual(G.rowSummary([], 0), { last: null, unread: 0, needsYou: false, at: null });
});

test("composer @ list: every member by handle, then @all; create needs a name and 2-6 bots; approval buttons in order", () => {
  const items = G.mentionItems(ROOM, (m) => m.name);
  assert.deepEqual(items.map((i) => [i.insert, i.label]), [["@atlas", "Atlas"], ["@ada", "Ada"], ["@hermes", "Hermes"], ["@all", "@all"]]);
  assert.equal(items[3].detail, "Everyone in the group");
  assert.equal(G.canCreate("Planning", 2), true);
  assert.equal(G.canCreate("Planning", 6), true);
  assert.equal(G.canCreate("Planning", 1), false);
  assert.equal(G.canCreate("Planning", 7), false);
  assert.equal(G.canCreate("  ", 3), false);
  assert.deepEqual(G.choicesOf({ choices: ["deny", "once"] }), ["once", "deny"]);
  assert.deepEqual(G.choicesOf({ choices: ["always", "deny", "session", "once", "bogus"] }), ["once", "session", "always", "deny"]);
  const rooms = [{ id: "a", name: "B", updatedAt: 5 }, { id: "b", name: "A", updatedAt: 9 }, { id: "c", name: "C", updatedAt: 1 }];
  assert.deepEqual(G.sortRooms(rooms).map((r) => r.id), ["b", "a", "c"]);
  assert.deepEqual(G.sortRooms(rooms, (r) => (r.id === "c" ? 99 : null)).map((r) => r.id), ["c", "b", "a"]);
});

// ---------------------------------------------------------------- the view against a minimal DOM stand-in
// Not visual evidence: it only proves the rows, the room view, the create form, approvals and the composer hooks run
// against the bridge API shapes without throwing and call the right groups.* methods.

class FakeEl {
  constructor(tag, text = null) {
    this.tagName = String(tag).toUpperCase();
    this.text = text;
    this.childNodes = [];
    this.attrs = {};
    this.dataset = {};
    this.listeners = {};
    this.style = { setProperty() {} };
    this.className = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.isConnected = true;
  }
  appendChild(n) { this.childNodes.push(n); return n; }
  append(...ns) { ns.forEach((n) => this.appendChild(n)); }
  replaceChildren(...ns) { this.childNodes = ns; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === "value") this.value = v; if (k === "checked") this.checked = true; if (k === "disabled") this.disabled = true; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type, extra = {}) { for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, stopPropagation() {}, currentTarget: this, target: this, clientX: 0, clientY: 0, ...extra }); }
  remove() {}
  focus() {}
  select() {}
  get textContent() { return this.text !== null ? this.text : this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(v) { this.childNodes = [new FakeEl("#text", String(v))]; }
  all() { return [this, ...this.childNodes.flatMap((n) => n.all())]; }
  find(pred) { return this.all().find(pred) || null; }
}

function fakeDom() {
  const doc = {
    hidden: false,
    body: new FakeEl("body"),
    activeElement: null,
    createElement: (tag) => new FakeEl(tag),
    createTextNode: (t) => new FakeEl("#text", t),
    createDocumentFragment: () => new FakeEl("#fragment"),
    addEventListener() {},
    querySelector: () => null,
  };
  doc.activeElement = doc.body;
  return doc;
}

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style") continue;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  return el;
}

function fakeGroups() {
  const calls = [];
  const rooms = new Map();
  const logs = new Map();
  let n = 0;
  const api = {
    capabilities: async () => (calls.push(["capabilities"]), { supported: true }),
    list: async () => (calls.push(["list"]), [...rooms.values()].map((r) => ({ ...r, latestSeq: (logs.get(r.id) || []).length }))),
    log: async (id, since, limit) => {
      calls.push(["log", id, since, limit]);
      const all = logs.get(id) || [];
      const events = all.filter((e) => e.seq > since).slice(0, limit);
      return { events, cursor: events.length ? events[events.length - 1].seq : since, latestSeq: all.length, hasMore: false };
    },
    state: async (id) => (calls.push(["state", id]), { room: null, working: false, blocked: false, approvals: api.approvals || [], retries: [] }),
    create: async (o) => {
      calls.push(["create", o]);
      const room = { id: `deck-${++n}`, name: o.name, members: o.members.map((m) => ({ id: m.profile, profile: m.profile, handle: m.profile, name: m.name })), latestSeq: 0, updatedAt: 1 };
      rooms.set(room.id, room);
      logs.set(room.id, []);
      return room;
    },
    send: async (id, text) => {
      calls.push(["send", id, text]);
      const list = logs.get(id);
      const event = { seq: list.length + 1, id: `user:${list.length + 1}`, kind: "message.user", at: Date.now() / 1000, thread: "main", text, actor: { kind: "user", id: "desktop" } };
      list.push(event);
      return { event, accepted: true };
    },
    stop: async (id) => (calls.push(["stop", id]), { cancelled: 1 }),
    approve: async (id, a) => (calls.push(["approve", id, a]), { approved: true }),
    rename: async (id, name) => (calls.push(["rename", id, name]), { ...rooms.get(id), name }),
    disband: async (id) => (calls.push(["disband", id]), { disbanded: true }),
    retry: async (id, task) => (calls.push(["retry", id, task]), { retried: true }),
  };
  return { api, calls, rooms, logs };
}

test("view: rows, create form, room transcript with the live row, approvals, send and Stop call the right methods", async (t) => {
  const prevDoc = globalThis.document;
  globalThis.document = fakeDom();
  t.after(() => { globalThis.document = prevDoc; });
  const fake = fakeGroups();
  const H = { sel: null };
  const notes = [];
  const bots = [{ name: "atlas", title: "Atlas", handle: "atlas" }, { name: "ada", title: "Ada", handle: "ada" }, { name: "default", title: "Hermes", handle: "hermes" }];
  const store = new Map();
  const gc = G.create({
    h, deck: { bridge: { groups: fake.api } }, store: { get: (k) => store.get(k) || null, set: (k, v) => store.set(k, v) },
    mark() {}, hm: () => "12:00", cleanErr: (e) => String((e && e.message) || e), bridgeOpen: () => true, hermesMode: () => true,
    H: () => H, hermesSelect: (sid) => { H.sel = sid; }, leave: () => { H.sel = null; }, renderNote() {}, note: (text, bad) => notes.push([text, bad]),
    bots: () => ({ face: (name) => h("span", { class: "botav", dataset: { face: name } }), title: (name) => (bots.find((b) => b.name === name) || {}).title || name, known: (name) => bots.some((b) => b.name === name), list: () => bots }),
    menu() {}, toast() {},
  });
  t.after(() => { H.sel = null; gc.onSelect(); });
  await gc.refresh();
  assert.equal(gc.supported(), true);
  let kids = [];
  gc.railRows(kids);
  assert.equal(kids.length, 1); // the "Group chats" eyebrow with its "+" button, no rooms yet
  // "+" opens the create form in the chat column
  kids[0].find((e) => e.dataset.fk === "groups-new").fire("click");
  assert.equal(H.sel, G.NEW);
  let form = gc.view(H.sel).childNodes[0];
  const create = form.find((e) => e.dataset.fk === "groups-create");
  assert.equal(create.disabled, true);
  const name = form.find((e) => e.dataset.fk === "groups-name");
  name.value = "Planning";
  name.fire("input");
  for (const who of ["atlas", "ada"]) {
    const box = form.find((e) => e.dataset.fk === `groups-pick:${who}`);
    box.checked = true;
    box.fire("change");
  }
  assert.equal(create.disabled, false);
  create.fire("click");
  await new Promise((r) => setImmediate(r));
  const made = fake.calls.find((c) => c[0] === "create");
  assert.deepEqual(made[1], { name: "Planning", members: [{ profile: "atlas", name: "Atlas" }, { profile: "ada", name: "Ada" }] });
  assert.equal(H.sel, "room:deck-1");
  await new Promise((r) => setImmediate(r));
  // the room: empty, then the owner's message and the live row naming who the gateway runs first
  assert.equal(await gc.send(H.sel, "plan the week"), true);
  assert.deepEqual(fake.calls.find((c) => c[0] === "send"), ["send", "deck-1", "plan the week"]);
  let view = gc.view(H.sel);
  assert.match(view.textContent, /plan the week/);
  assert.match(view.textContent, /Atlas is thinking…/);
  assert.equal(gc.working(H.sel), true);
  // a member's reply arrives through the log; an approval through the state
  fake.logs.get("deck-1").push({ seq: 2, id: "dmessage:1", kind: "message.member", at: Date.now() / 1000, thread: "main", text: "On it. @user which week?", member: "atlas", round: 0, discussion: "user:1", actor: { kind: "member", id: "atlas", profile: "atlas", name: "Atlas" } });
  fake.api.approvals = [{ memberId: "ada", taskId: "dtask:1", generation: 1, requestId: "req-1", command: "rm -rf build", description: "Delete", choices: ["once", "deny"] }];
  await gc.stop(H.sel); // Stop cancels the round, then the same read refreshes the view
  assert.ok(fake.calls.some((c) => c[0] === "stop" && c[1] === "deck-1"));
  view = gc.view(H.sel);
  assert.match(view.textContent, /On it\. @user which week\?/);
  assert.match(view.textContent, /Ada wants to run a command/);
  assert.doesNotMatch(view.textContent, /is thinking/); // the approval card is the state; no second indicator
  const once = view.find((e) => e.dataset.fk === "groups-approve:once");
  assert.ok(view.find((e) => e.dataset.fk === "groups-approve:deny"));
  assert.equal(view.find((e) => e.dataset.fk === "groups-approve:always"), null); // only what the gateway offers
  fake.api.approvals = [];
  once.fire("click");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(fake.calls.find((c) => c[0] === "approve"), ["approve", "deck-1", { memberId: "ada", taskId: "dtask:1", generation: 1, requestId: "req-1", choice: "once" }]);
  // composer @ list, the header and the right panel
  assert.deepEqual(gc.mentionItems(H.sel).map((i) => i.insert), ["@atlas", "@ada", "@all"]);
  const head = gc.head(H.sel);
  assert.equal(head[1].textContent.startsWith("Planning"), true);
  const pane = [];
  gc.pane(pane, H.sel);
  assert.match(pane.map((e) => e.textContent).join(" "), /Atlas.*@atlas.*Ada.*@ada/);
  // the row: preview of the latest message; the open room shows no unread badge
  kids = [];
  gc.railRows(kids);
  assert.equal(kids.length, 2);
  assert.match(kids[1].textContent, /Planning/);
  assert.match(kids[1].textContent, /Atlas: On it\./);
  assert.equal(notes.length, 0, JSON.stringify(notes));
});
