"use strict";
// Settings view (renderer/settings-view.js): the Bot screen tab rule, the busy-send preference, and the view's own
// behaviour on a small fake DOM (no Electron, no browser): sections built once and kept, no rebuild under typing,
// switches saving at once with an inline note, Esc closing, and the wiring into index.html / app.js.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const i18n = require("../renderer/i18n");
const SVM = require("../renderer/settings-view");

const RENDERER = path.join(__dirname, "..", "renderer");
beforeEach(() => i18n.setLanguage("en"));

// ---------------------------------------------------------------- pure rules

test("Bot screen tab: shown only while desktop control is on (or paused by Stop)", () => {
  assert.equal(SVM.screenTabVisible({ on: false, paused: null }, "activity"), false);
  assert.equal(SVM.screenTabVisible({ on: true }, "activity"), true);
  assert.equal(SVM.screenTabVisible({ on: false, paused: { at: 1 } }, "activity"), true, "Resume stays one click away");
  // before botscreen's first state arrives, a persisted Bot screen tab is not thrown away
  assert.equal(SVM.screenTabVisible(null, "screen"), true);
  assert.equal(SVM.screenTabVisible(null, "fleet"), false);
  assert.equal(SVM.screenTabVisible({ on: false, paused: null, spaces: true }, "activity"), true, "an agent space is watched there even with desktop control off");
});

test("tab fallback: settings is no longer a tab; a hidden Bot screen tab falls back to Activity", () => {
  assert.equal(SVM.tabFor("settings", null), "activity");
  assert.equal(SVM.tabFor("", null), "activity");
  assert.equal(SVM.tabFor(null, { on: true }), "activity");
  assert.equal(SVM.tabFor("screen", { on: false }), "activity");
  assert.equal(SVM.tabFor("screen", { on: true }), "screen");
  assert.equal(SVM.tabFor("screen", null), "screen", "kept until botscreen reports its state");
  for (const t of ["activity", "fleet", "tokens", "workspace"]) assert.equal(SVM.tabFor(t, { on: false }), t);
});

test("busy-send preference reads queue unless the snapshot says steer", () => {
  assert.equal(SVM.busySendOf(null), "queue");
  assert.equal(SVM.busySendOf({}), "queue");
  assert.equal(SVM.busySendOf({ composer: { busySend: "bogus" } }), "queue");
  assert.equal(SVM.busySendOf({ composer: { busySend: "steer" } }), "steer");
  assert.deepEqual(SVM.BUSY_SEND, ["queue", "steer"]);
  assert.equal(SVM.sectionOf("nope"), "general");
  assert.equal(SVM.sectionOf("relay"), "relay");
});

// ---------------------------------------------------------------- a small fake DOM

class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.dataset = {};
    this.listeners = {};
    this.style = { setProperty() {} };
    this.classList = { add: (c) => this._cls(c, true), remove: (c) => this._cls(c, false), contains: (c) => this.className.split(/\s+/).includes(c) };
    this.className = "";
    this.hidden = false;
    this.value = "";
    this.defaultValue = "";
    this.checked = false;
    this.disabled = false;
    this.scrollTop = 0;
    this.textContent = "";
  }
  _cls(c, on) { const s = new Set(this.className.split(/\s+/).filter(Boolean)); if (on) s.add(c); else s.delete(c); this.className = [...s].join(" "); }
  get id() { return this.attrs.id || ""; }
  get type() { return this.attrs.type || ""; }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === "hidden") this.hidden = true;
    if (k === "checked") this.checked = true;
    if (k === "disabled") this.disabled = true;
    if (k === "value") this.value = this.defaultValue = String(v);
  }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { if (c.parentNode) c.parentNode.children = c.parentNode.children.filter((x) => x !== c); c.parentNode = this; this.children.push(c); return c; }
  replaceChildren(...kids) { for (const c of this.children) c.parentNode = null; this.children = []; for (const c of kids.flat(Infinity)) if (c) this.appendChild(c); }
  replaceWith(n) { const p = this.parentNode; if (!p) return; const i = p.children.indexOf(this); p.children[i] = n; n.parentNode = p; this.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this); this.parentNode = null; }
  after(n) { const p = this.parentNode; p.children.splice(p.children.indexOf(this) + 1, 0, n); n.parentNode = p; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(type, extra = {}) {
    const e = { type, target: this, currentTarget: null, key: extra.key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    // capture listeners on ancestors first (the view records the changed control there), then target, then bubble
    const chain = [];
    for (let n = this; n; n = n.parentNode) chain.push(n);
    for (const n of chain.slice().reverse()) for (const fn of n.listeners[`${type}:capture`] || []) { e.currentTarget = n; fn(e); }
    for (const n of chain) for (const fn of n.listeners[type] || []) { e.currentTarget = n; fn(e); }
    return e;
  }
  closest(sel) { for (let n = this; n; n = n.parentNode) if (n.matches && n.matches(sel)) return n; return null; }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  focus() { doc.activeElement = this; }
  matches(sel) { return sel.split(",").some((s) => matchOne(this, s.trim())); }
  querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  get text() { return this.textContent + this.children.map((c) => c.text).join(""); }
}
// enough selector support for the view: tag, #id, .class, [attr], [attr="v"], :not([type=x]), "A B" descendant
function matchOne(n, sel) {
  const parts = sel.split(/\s+/);
  if (parts.length > 1) {
    if (!matchOne(n, parts.at(-1))) return false;
    const rest = parts.slice(0, -1).join(" ");
    for (let p = n.parentNode; p; p = p.parentNode) if (p.matches && matchOne(p, rest)) return true;
    return false;
  }
  let s = sel;
  const nots = [];
  s = s.replace(/:not\(([^)]*)\)/g, (_m, inner) => { nots.push(inner); return ""; });
  if (nots.some((x) => matchOne(n, x))) return false;
  const tag = s.match(/^[a-zA-Z]+/);
  if (tag && n.tagName !== tag[0].toUpperCase()) return false;
  for (const [, id] of s.matchAll(/#([\w-]+)/g)) if (n.id !== id) return false;
  for (const [, c] of s.matchAll(/\.([\w-]+)/g)) if (!n.className.split(/\s+/).includes(c)) return false;
  for (const [, k, v] of s.matchAll(/\[([\w-]+)(?:="?([^"\]]*)"?)?\]/g)) {
    const val = k.startsWith("data-") ? n.dataset[k.slice(5).replace(/-(\w)/g, (_m, ch) => ch.toUpperCase())] : k === "type" ? n.type : n.getAttribute(k);
    if (val === undefined || val === null) return false;
    if (v !== undefined && String(val) !== v) return false;
  }
  return true;
}
const doc = {
  activeElement: null,
  body: new Node("body"),
  createElement: (t) => new Node(t),
  createElementNS: (_ns, t) => new Node(t),
  createTextNode: (v) => { const n = new Node("#text"); n.textContent = String(v); return n; },
  getElementById: (id) => doc.body.querySelector(`#${id}`),
  querySelector: (sel) => doc.body.querySelector(sel),
  addEventListener() {},
};
// capture listeners: the view calls addEventListener(type, fn, true)
const origAdd = Node.prototype.addEventListener;
Node.prototype.addEventListener = function (t, fn, capture) { return origAdd.call(this, capture === true ? `${t}:capture` : t, fn); };

function h(tag, attrs, ...kids) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.appendChild(typeof c === "object" ? c : doc.createTextNode(c));
  return el;
}

function mount(over = {}) {
  global.document = doc;
  global.window = { DeckI18n: i18n };
  global.CSS = { escape: (s) => s };
  doc.body.replaceChildren(h("main", { id: "chat" }));
  doc.activeElement = null;
  const saves = [];
  let settings = { language: "en", composer: { busySend: "queue" }, chat: { modes: ["telegram", "sessions"], defaultMode: "telegram" }, relay: { url: "", hasToken: false }, telegram: {}, downloads: { dir: "", ask: false }, desktop: { notifications: true, pet: true }, hiddenBots: [] };
  const builds = { general: 0, relay: 0 };
  const store = new Map();
  const ctx = {
    h, CM: require("../renderer/chat-modes"), deck: {}, store: { get: (k) => store.get(k) || null, set: (k, v) => store.set(k, v) },
    settings: () => { builds.general++; return settings; }, tg: () => ({}), deskInfo: () => ({}), windows: () => false,
    canOpen: () => true, hasSection: () => true,
    save: async (patch, ok) => { saves.push(patch); settings = { ...settings, ...patch }; sv.notify(true, ok); },
    saveCall: async () => {}, saveChat: (d) => saves.push({ chat: d }), readReceiptsChanged() {}, logout: async () => {}, testNotification() {},
    hermes: (kids) => kids.push(h("p", null, "hermes form")), workspaceRows: () => [h("p", null, "ws")], botscreenRows: () => [h("p", null, "bs")],
    screenTab: () => false, openScreen() {}, onToggle() {},
    ...over,
  };
  const sv = SVM.create(ctx);
  return { sv, saves, builds, store, ctx, root: () => doc.body.querySelector(".sv"), setSettings: (s) => { settings = s; } };
}

test("the view opens over the chat column with one section shown; Esc closes it", () => {
  const { sv, root } = mount();
  assert.equal(root(), null, "nothing is built before it is opened");
  sv.open();
  assert.ok(root(), "mounted inside #chat");
  assert.equal(root().parentNode.id, "chat");
  assert.equal(root().hidden, false);
  assert.equal(sv.isOpen(), true);
  const nav = root().querySelectorAll(".sv-nav-item");
  assert.deepEqual(nav.map((b) => b.dataset.fk), SVM.SECTIONS.map((s) => `sv-nav:${s}`));
  assert.equal(root().querySelectorAll(".sv-section").length, 1, "only the shown section is built");
  assert.ok(root().querySelector("#s-busy-send"), "General carries the busy-send control");
  root().dispatch("keydown", { key: "Escape" });
  assert.equal(sv.isOpen(), false);
  assert.equal(root().hidden, true);
});

test("switching sections keeps built sections (and their scroll) instead of rebuilding them", () => {
  const { sv, root } = mount();
  sv.open("relay");
  const relay = root().querySelector('.sv-section[data-section="relay"]');
  relay.scrollTop = 120;
  root().querySelector('[data-fk="sv-nav:general"]').dispatch("click");
  assert.equal(relay.hidden, true);
  root().querySelector('[data-fk="sv-nav:relay"]').dispatch("click");
  assert.equal(root().querySelector('.sv-section[data-section="relay"]'), relay, "the same element, not a rebuilt one");
  assert.equal(relay.scrollTop, 120);
  assert.equal(relay.hidden, false);
  assert.equal(sv.section(), "relay");
});

test("busy-send segmented control saves composer.busySend at once and notes Saved next to it", async () => {
  const { sv, saves, root } = mount();
  sv.open("general");
  const steer = root().querySelector('[data-fk="s-busy-send:steer"]');
  assert.equal(root().querySelector('[data-fk="s-busy-send:queue"]').getAttribute("aria-pressed"), "true");
  steer.dispatch("click");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(saves.at(-1), { composer: { busySend: "steer" } });
  const row = root().querySelector('[data-fk="s-busy-send:steer"]').closest(".sv-row");
  assert.match(row.text, /Saved/, "the note sits in the control's own row, not a banner");
  assert.equal(root().querySelector(".sv-head").text.includes("Saved"), false);
});

test("a refresh never rebuilds the section the user is typing in; it is rebuilt when shown again", () => {
  const { sv, root } = mount();
  sv.open("relay");
  const url = root().querySelector("#s-relay-url");
  url.focus();
  url.value = "ws://typing";
  sv.refresh();
  assert.equal(root().querySelector("#s-relay-url"), url, "not rebuilt under typing");
  doc.activeElement = null;
  root().querySelector('[data-fk="sv-nav:general"]').dispatch("click");
  root().querySelector('[data-fk="sv-nav:relay"]').dispatch("click");
  const again = root().querySelector("#s-relay-url");
  assert.notEqual(again, url, "the stale section was rebuilt when shown");
  assert.equal(again.value, "ws://typing", "typed text survives the rebuild");
});

test("the This device section carries the hosting rows; Open Bot screen only while its tab exists", () => {
  let tab = false;
  const { sv, root } = mount({ screenTab: () => tab });
  sv.open("device");
  const box = root().querySelector('.sv-section[data-section="device"]');
  assert.match(box.text, /ws/);
  assert.match(box.text, /bs/);
  assert.equal(box.querySelector('[data-fk="bs:open"]'), null);
  tab = true;
  sv.refresh({ force: true });
  assert.ok(root().querySelector('[data-fk="bs:open"]'));
});

// ---------------------------------------------------------------- wiring and copy

test("index.html loads the view before app.js; app.js routes every Settings entry point to it", () => {
  const html = fs.readFileSync(path.join(RENDERER, "index.html"), "utf8");
  assert.ok(html.includes('href="settings-view.css"'));
  assert.ok(html.indexOf('src="settings-view.js"') > 0 && html.indexOf('src="settings-view.js"') < html.indexOf('src="app.js"'));
  const app = fs.readFileSync(path.join(RENDERER, "app.js"), "utf8");
  assert.ok(!/\["settings",\s*i18nText/.test(app), "Settings is not a right-panel tab any more");
  assert.ok(!/setTab\("settings"\)/.test(app), "no caller still opens the old tab");
  assert.match(app, /if \(id === "settings"\) return openSettings\(\)/, "an old setTab('settings') path still lands in the view");
  assert.match(app, /screenTabOn\(\) \? \["screen"/, "the Bot screen tab is conditional");
  assert.match(app, /e\.key === ","/, "Ctrl+, opens Settings");
  assert.ok(!/function paneSettings\(/.test(app), "the old one-long-form pane is gone");
});

test("new set.* strings exist in English and Turkish and the view uses no other hardcoded UI text", () => {
  const keys = Object.keys(i18n.tables.en).filter((k) => k.startsWith("set."));
  assert.ok(keys.length >= 20);
  for (const k of keys) assert.equal(typeof i18n.tables.tr[k], "string", k);
  const src = fs.readFileSync(path.join(RENDERER, "settings-view.js"), "utf8");
  for (const [, k] of src.matchAll(/node\("([\w.]+)"/g)) assert.ok(k in i18n.tables.en, `missing key ${k}`);
  for (const [, k] of src.matchAll(/\bT\("([\w.]+)"/g)) assert.ok(k in i18n.tables.en, `missing key ${k}`);
  // help paragraphs are gone: no .fhelp is created by the view
  assert.ok(!/class: "fhelp"/.test(src));
});
