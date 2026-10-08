"use strict";
// Hermes rail: right-click (or the menu key / Shift+F10) on a session row opens a menu with "Delete"; Delete asks
// first, then calls deck.bridge.deleteSession with the stored session id; Hermes's refusal of a running session is
// shown in plain words; deleting the open session moves the selection on. The renderer is one big script, so the
// functions under test are cut out of it and run in a vm against a fake DOM (as chat-modes.test.js does).
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const I18N = require("../renderer/i18n");
beforeEach(() => I18N.setLanguage("en"));

const SRC = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
const START = SRC.indexOf("  // ------------------------------------------------------------ session menu (right-click > Delete)");
const END = SRC.indexOf('  /** "+ Yeni oturum" under a profile heading');
assert.ok(START > 0 && END > START, "session menu block found in app.js");

function element(tag, attrs, ...kids) {
  const listeners = {};
  return {
    tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(Boolean), dataset: (attrs && attrs.dataset) || {}, listeners, removed: false,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    remove() { this.removed = true; }, focus() {}, disabled: false, isConnected: true, textContent: "",
  };
}
const plain = (x) => JSON.parse(JSON.stringify(x)); // values built inside the vm have its own prototypes
const walk = (el) => [el, ...(el.kids || []).filter((x) => typeof x === "object").flatMap(walk)];
const nodeText = (el) => (el.kids || []).map((k) => (typeof k === "string" ? k : k.textContent !== undefined && !k.kids ? k.textContent : nodeText(k))).join("");

/** The menu's Delete item (the menu also offers Pin for the sidebar's Pinned filter). */
const del = (menu) => menu.items.find((i) => i.danger);

function world({ deleteImpl } = {}) {
  const sent = [];
  const menus = [];
  const toasts = [];
  const body = [];
  const sessions = [
    { sid: "s-a", profile: "default", title: "Alpha" },
    { sid: "s-b", profile: "research", title: "Beta" },
  ];
  const ctx = {
    i18nText: I18N.t, i18nNode: (k, v) => ({ textContent: I18N.t(k, v) }),
    i18nBind: (el, attr, key, vars) => { el[attr] = I18N.t(key, vars); },
    H: { sel: "s-a", nodes: new Map(sessions.map((n) => [n.sid, n])), hist: new Map([["s-a", {}]]), live: new Map([["s-a", {}]]), echo: new Map(), ctl: new Map(), titles: new Map(), rank: new Map(), requests: [{ sid: "s-a", id: "r1" }], deleted: new Set(), snap: [], stored: new Map() },
    OB: { drop() {} }, DR: { forget() {} },
    rail: { pins: new Set() }, togglePin(sid) { ctx.rail.pins.add(sid); },
    BT: null, store: { value: "s-a", set(k, v) { this.value = v; } },
    els: { rail: element("nav") },
    MV: { openMenu: (items, anchor, pos, label) => menus.push({ items, anchor, pos, label }), toast: (t) => toasts.push(t) },
    h: element, cleanErr: (e) => String((e && e.message) || e),
    hermesMode: () => true, bridgeOpen: () => true, hermesTitle: (n) => n.title, mark() {},
    hermesGroups: () => [{ profile: "default", rows: [...ctx.H.nodes.values()].map((node) => ({ node, depth: 0 })) }],
    hermesSelect(sid) { ctx.H.sel = sid; }, Date,
    document: { activeElement: null, body: { appendChild: (el) => body.push(el) } },
    deck: { bridge: { deleteSession: async (sid, opts) => { sent.push([sid, opts]); if (deleteImpl) return deleteImpl(sid); return { deleted: sid }; } } },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(START, END), ctx);
  const row = (sid) => ({ dataset: { fk: `hrow:${sid}` }, closest: () => row[sid] });
  for (const n of sessions) row[n.sid] = { dataset: { fk: `hrow:${n.sid}` } };
  const target = (sid) => ({ closest: (sel) => (sel === ".row.hrow" ? row[sid] : null) });
  const press = (type, ev) => { const calls = []; for (const fn of ctx.els.rail.listeners[type] || []) fn({ preventDefault: () => calls.push("prevented"), ...ev }); return calls; };
  const dialog = () => body[body.length - 1];
  const buttons = () => walk(dialog()).filter((n) => n.tag === "button");
  return { ctx, sent, menus, toasts, body, target, press, dialog, buttons, row };
}

test("right-click on a session row opens a menu with Delete; Delete asks before anything is sent", async () => {
  const w = world();
  const calls = w.press("contextmenu", { target: w.target("s-b"), clientX: 40, clientY: 60 });
  assert.deepEqual(calls, ["prevented"], "the browser's own menu is suppressed");
  assert.equal(w.menus.length, 1);
  const menu = w.menus[0];
  assert.deepEqual(plain(menu.pos), { x: 40, y: 60 });
  assert.deepEqual(plain(menu.items.map((i) => i.label)), ["Pin", "Delete"], "Pin (sidebar's Pinned filter), then Delete");
  assert.equal(del(menu).danger, true);
  assert.equal(!!menu.items[0].danger, false, "Pin is not destructive");
  assert.match(menu.label, /Beta/);
  menu.items[0].run(); // Pin only marks the row: nothing is sent
  assert.deepEqual(plain([...w.ctx.rail.pins]), ["s-b"]);
  assert.equal(w.sent.length, 0);
  del(menu).run(); // choosing Delete opens the confirmation
  assert.equal(w.sent.length, 0, "nothing deleted before the user confirms");
  assert.equal(w.dialog().attrs.class, "cd-back");
  assert.match(nodeText(w.dialog()), /Delete session\?/);
  assert.match(nodeText(w.dialog()), /Beta/);
  assert.match(nodeText(w.dialog()), /cannot be undone/);
});

test("Cancel closes the dialog and deletes nothing", async () => {
  const w = world();
  w.press("contextmenu", { target: w.target("s-a"), clientX: 1, clientY: 1 });
  del(w.menus[0]).run();
  const cancel = w.buttons().find((b) => b.attrs.class === "btn");
  cancel.listeners.click[0]();
  assert.equal(w.dialog().removed, true);
  assert.equal(w.sent.length, 0);
});

test("confirm sends the stored session id and its profile, then forgets the session", async () => {
  const w = world();
  w.press("contextmenu", { target: w.target("s-b"), clientX: 1, clientY: 1 });
  del(w.menus[0]).run();
  const ok = w.buttons().find((b) => b.attrs.class === "btn danger");
  await ok.listeners.click[0]();
  assert.deepEqual(plain(w.sent), [["s-b", { profile: "research" }]]);
  assert.equal(w.dialog().removed, true);
  assert.deepEqual(w.toasts, ["Session deleted."]);
  assert.equal(w.ctx.H.nodes.has("s-b"), false);
  assert.equal(w.ctx.H.sel, "s-a", "another session stays open when the deleted one was not the open one");
});

test("deleting the open session moves the selection to another one and clears its local state", async () => {
  const w = world();
  w.press("contextmenu", { target: w.target("s-a"), clientX: 1, clientY: 1 });
  del(w.menus[0]).run();
  await w.buttons().find((b) => b.attrs.class === "btn danger").listeners.click[0]();
  assert.deepEqual(plain(w.sent), [["s-a", { profile: "default" }]]);
  assert.equal(w.ctx.H.sel, "s-b", "the next session in the rail opens");
  for (const m of ["hist", "live"]) assert.equal(w.ctx.H[m].has("s-a"), false, m);
  assert.deepEqual(plain(w.ctx.H.requests), [], "its open approvals are dropped");
});

test("deleting the last session leaves no selection", async () => {
  const w = world();
  w.ctx.H.nodes.delete("s-b");
  w.press("contextmenu", { target: w.target("s-a"), clientX: 1, clientY: 1 });
  del(w.menus[0]).run();
  await w.buttons().find((b) => b.attrs.class === "btn danger").listeners.click[0]();
  assert.equal(w.ctx.H.sel, null);
  assert.equal(w.ctx.store.value, "");
});

test("Hermes refusing a running session shows a friendly message and keeps everything", async () => {
  const w = world({ deleteImpl: async () => { throw new Error("Error invoking remote method 'bridge:delete': Error: cannot delete an active session"); } });
  w.press("contextmenu", { target: w.target("s-a"), clientX: 1, clientY: 1 });
  del(w.menus[0]).run();
  const ok = w.buttons().find((b) => b.attrs.class === "btn danger");
  await ok.listeners.click[0]();
  const err = walk(w.dialog()).find((n) => n.attrs && n.attrs.class === "form-error");
  assert.equal(err.textContent, "This session is running; stop it first, then delete it.");
  assert.equal(w.dialog().removed, false, "the dialog stays open");
  assert.equal(ok.disabled, false, "and can be retried or cancelled");
  assert.equal(w.ctx.H.nodes.has("s-a"), true);
  assert.equal(w.ctx.H.sel, "s-a");
  assert.deepEqual(w.toasts, []);
});

test("other failures show their own text", async () => {
  const w = world({ deleteImpl: async () => { throw new Error("session not found"); } });
  w.press("contextmenu", { target: w.target("s-a"), clientX: 1, clientY: 1 });
  del(w.menus[0]).run();
  await w.buttons().find((b) => b.attrs.class === "btn danger").listeners.click[0]();
  assert.equal(walk(w.dialog()).find((n) => n.attrs && n.attrs.class === "form-error").textContent, "session not found");
});

test("the menu key and Shift+F10 open it by the row; a following contextmenu event is swallowed", () => {
  const w = world();
  assert.deepEqual(w.press("keydown", { target: w.target("s-a"), key: "ContextMenu" }), ["prevented"]);
  assert.equal(w.menus.length, 1);
  assert.equal(w.menus[0].pos, null, "anchored to the row, not to a point");
  w.press("keydown", { target: w.target("s-b"), key: "F10", shiftKey: true });
  assert.equal(w.menus.length, 2);
  w.press("keydown", { target: w.target("s-b"), key: "F10", shiftKey: false });
  w.press("keydown", { target: w.target("s-b"), key: "a" });
  assert.equal(w.menus.length, 2, "other keys do nothing");
  w.press("contextmenu", { target: w.target("s-b"), clientX: 0, clientY: 0 });
  assert.equal(w.menus.length, 2, "the contextmenu event the keyboard menu triggers does not open a second menu");
});

test("non-session targets and Bot Chats get no menu", () => {
  const w = world();
  assert.deepEqual(w.press("contextmenu", { target: { closest: () => null }, clientX: 1, clientY: 1 }), []);
  w.ctx.BT = { owns: (sid) => sid === "s-b" };
  w.press("contextmenu", { target: w.target("s-b"), clientX: 1, clientY: 1 });
  assert.equal(w.menus.length, 0, "a bot's chat is managed in Botlar, not deleted from here");
  w.ctx.hermesMode = () => false;
  assert.deepEqual(w.press("contextmenu", { target: w.target("s-a"), clientX: 1, clientY: 1 }), [], "Telegram mode keeps its own menus");
});

test("session menu strings exist in English and Turkish", () => {
  for (const key of ["session.delete", "session.menuLabel", "session.deleteTitle", "session.deleteBody", "session.deleteBusy", "session.deleted", "session.deleteActive", "session.deleteInvalid"]) {
    assert.equal(typeof I18N.tables.en[key], "string", `en ${key}`);
    assert.equal(typeof I18N.tables.tr[key], "string", `tr ${key}`);
    assert.notEqual(I18N.tables.en[key], I18N.tables.tr[key], key);
  }
});
