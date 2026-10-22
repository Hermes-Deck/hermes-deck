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

test("host form submits separate Relay and direct configs for Local, SSH, WSL and relay-only", async () => {
  for (const [windows, mode] of [[false, "local"], [false, "ssh"], [true, "wsl"], [false, "off"]]) {
    let spec;
    const { sv, root } = mount({ windows: () => windows, deck: { hosts: { add: async s => { spec = s; } } },
      saveCall: async call => { await call(); return true; } });
    sv.open("relay");
    const get = id => root().querySelector(`#s-host-${id}`);
    assert.equal(get("token").type, "password");
    assert.deepEqual(get("mode").children.map(n => n.getAttribute("value")), ["off", "ssh", windows ? "wsl" : "local"]);
    get("name").value = "Fixture host";
    get("url").value = "ws://192.0.2.1:9330";
    get("token").value = "fixture-token";
    get("mode").value = mode; get("mode").dispatch("change");
    assert.equal(get("target").closest(".sv-row").hidden, mode !== "ssh");
    assert.equal(get("dist").closest(".sv-row").hidden, mode !== "wsl");
    get("target").value = "fixture-alias";
    get("python").value = "python3";
    get("dist").value = "FixtureLinux";
    root().querySelector('[data-fk="hosts:add"]').dispatch("click");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(spec, { name: "Fixture host", relay: { url: "ws://192.0.2.1:9330", token: "fixture-token" },
      bridge: { mode, target: mode === "ssh" ? "fixture-alias" : "", python: "python3", stream: "~/.hermes/hermes-deck/stream.py", distribution: mode === "wsl" ? "FixtureLinux" : "" } });
    assert.equal(get("token").value, "", "successful add clears the secret field");
    sv.close();
  }
});

test("host list separates saved and observed state, switches through the shared draft-safe path", () => {
  const picked = [];
  const hosts = [
    { id: "h1", name: "Relay only", relay: { url: "ws://192.0.2.1", hasToken: true }, bridge: { mode: "off" } },
    { id: "h2", name: "Remote", relay: { url: "ws://192.0.2.2", hasToken: true }, bridge: { mode: "ssh" } },
  ];
  const { sv, root } = mount({ settings: () => ({ hosts, activeHost: "h1", relay: hosts[0].relay }),
    deck: { hosts: {} }, selectHost: id => picked.push(id),
    hostStates: () => ({ relay: "open", sessions: "off", remote: [{ id: "h2", status: "open" }] }) });
  sv.open("relay");
  const rows = root().querySelectorAll(".sv-host-label");
  assert.match(rows[0].text, /Relay: Connected · Sessions: Not configured/);
  assert.match(rows[1].text, /Relay: Saved · not checked · Sessions: Connected/);
  root().querySelector('[data-fk="hosts:use:h2"]').dispatch("click");
  assert.deepEqual(picked, ["h2"]);
  const configure = root().querySelectorAll("button").find(b => b.text === "Configure Sessions");
  configure.dispatch("click");
  assert.equal(sv.section(), "hermes");
});

test("real direct failure status stays disconnected in active and inactive host rows", () => {
  const { BridgeClient } = require("../main/bridge");
  const client = new BridgeClient({ mode: "off" }, { retry: false });
  client.stopped = false;
  client._afterFailure({}, { code: "fixture", text: "Disconnected fixture" });
  assert.equal(client.status.status, "offline");
  assert.equal(SVM.connectionState(true, client.status.status), "offline");
  const hosts = [{ id: "h1", name: "Active", bridge: { mode: "local" } }, { id: "h2", name: "Remote", bridge: { mode: "ssh" } }];
  const { sv, root } = mount({ settings: () => ({ hosts, activeHost: "h1" }), deck: { hosts: {} },
    hostStates: () => ({ sessions: client.status.status, remote: [{ id: "h2", ...client.status }] }) });
  sv.open("relay");
  for (const row of root().querySelectorAll(".sv-host-label")) assert.match(row.text, /Sessions: Disconnected/);
  for (const [status, expected] of [["off", "saved"], ["setup", "offline"], ["connecting", "connecting"], ["open", "open"]]) {
    assert.equal(SVM.connectionState(true, status), expected);
  }
});

test("notification surface is labelled in both languages, saves one preference, and disables with notifications", () => {
  for (const language of ["en", "tr"]) for (const notifications of [true, false]) {
    i18n.setLanguage(language);
    const { sv, root, saves } = mount({ settings: () => ({ desktop: { notifications, pet: false, notificationMode: "banner" } }) });
    window.PetCatalog = { SKINS: [] };
    sv.open("desktop");
    const select = root().querySelector("#s-desk-notificationMode");
    assert.ok(root().querySelector('[for="s-desk-notificationMode"]'));
    assert.equal(select.disabled, !notifications);
    assert.deepEqual(select.children.map(n => n.getAttribute("value")), ["auto", "pet", "banner"]);
    select.value = "pet"; select.dispatch("change");
    assert.deepEqual(saves.at(-1), { desktop: { notificationMode: "pet" } });
    sv.close();
  }
});

test("pet Always on top is a labelled checkbox and saves only its boolean in both languages", async () => {
  for (const language of ["en", "tr"]) {
    i18n.setLanguage(language);
    const { sv, saves, root } = mount({ settings: () => ({ desktop: { pet: true, petAlwaysOnTop: true } }) });
    window.PetCatalog = { SKINS: [] };
    sv.open("desktop");
    const checkbox = root().querySelector("#s-desk-petAlwaysOnTop");
    assert.ok(checkbox);
    assert.equal(checkbox.getAttribute("type"), "checkbox");
    assert.ok(root().querySelector('[for="s-desk-petAlwaysOnTop"]'));
    assert.match(checkbox.closest(".sv-row").text, language === "en" ? /Always on top/ : /Her zaman üstte/);
    checkbox.checked = false;
    checkbox.dispatch("change");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(saves.at(-1), { desktop: { petAlwaysOnTop: false } });
    sv.close();
  }
  i18n.setLanguage("en");
});

test("Appearance offers plain agent messages by default and saves bubble through ctx.save", async () => {
  i18n.extend(require("../renderer/i18n-b"));
  const { sv, saves, root } = mount();
  window.PetCatalog = { SKINS: [] };
  sv.open("desktop");
  const choice = root().querySelector("#s-agent-messages");
  assert.ok(choice, "Appearance includes the agent-message control");
  assert.equal(choice.children.find(el => el.getAttribute("selected") !== null).getAttribute("value"), "plain");
  choice.value = "bubble";
  choice.dispatch("change");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(saves.at(-1), { reading: { agentMessages: "bubble" } });
  assert.match(root().querySelector("#s-agent-messages").closest(".sv-row").text, /Saved/);
});

test("agent message preview is immediate and a failed save restores the held preference", async () => {
  const applied = [];
  let finish;
  const { sv, root } = mount({ save: () => new Promise(resolve => { finish = resolve; }) });
  window.PetCatalog = { SKINS: [] };
  window.DeckReading = { apply: value => applied.push(value) };
  sv.open("desktop");
  const choice = root().querySelector("#s-agent-messages");
  choice.value = "bubble";
  choice.dispatch("change");
  assert.equal(applied.at(-1).agentMessages, "bubble");
  await new Promise(resolve => setImmediate(resolve));
  finish(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(applied.at(-1), undefined, "held settings omitted reading, so default is reapplied");
  assert.equal(root().querySelector("#s-agent-messages").children.find(el => el.getAttribute("selected") !== null).getAttribute("value"), "plain");
});

test("Appearance offers bundled message fonts and every integer size from 14 through 20", async () => {
  const { sv, root, saves } = mount();
  window.PetCatalog = { SKINS: [] };
  window.DeckReading = require("../renderer/reading");
  sv.open("desktop");
  const font = root().querySelector("#s-message-font");
  assert.ok(font, "Appearance has a message-font control");
  assert.deepEqual(font.children.map(option => option.getAttribute("value")), ["newsreader", "geist", "atkinson"]);
  assert.equal(font.children.find(option => option.getAttribute("selected") !== null).getAttribute("value"), "newsreader");
  const size = root().querySelector("#s-message-size");
  assert.ok(size);
  assert.deepEqual(size.children.map(option => option.getAttribute("value")), ["14", "15", "16", "17", "18", "19", "20"]);
  assert.equal(size.children.find(option => option.getAttribute("selected") !== null).getAttribute("value"), "17");
  font.value = "atkinson"; font.dispatch("change");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(saves.at(-1), { reading: { font: "atkinson" } });
  size.value = "20"; size.dispatch("change");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(saves.at(-1), { reading: { size: 20 } });
});

test("rapid reading choices preserve the entire live preview and serialize saves", async () => {
  const Reading = require("../renderer/reading");
  const applied = [], calls = [];
  let settings = { desktop: {}, reading: { agentMessages: "plain", font: "newsreader", size: 17 } };
  const { sv, root } = mount({ settings: () => settings,
    save: patch => new Promise(resolve => calls.push({ patch, finish() {
      settings = { ...settings, reading: { ...settings.reading, ...patch.reading } };
      sv.notify(true, "Saved"); resolve(true);
    } })) });
  window.PetCatalog = { SKINS: [] };
  window.DeckReading = { normalize: Reading.normalize, apply: value => applied.push(Reading.normalize(value)) };
  sv.open("desktop");
  const font = root().querySelector("#s-message-font"), size = root().querySelector("#s-message-size");
  font.value = "geist"; font.dispatch("change");
  size.value = "20"; size.dispatch("change");
  assert.deepEqual(applied.at(-1), { agentMessages: "plain", font: "geist", size: 20 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, "one save in flight");
  calls[0].finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.deepEqual(applied.at(-1), { agentMessages: "plain", font: "geist", size: 20 }, "older save must not undo a newer preview");
  calls[1].finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(root().querySelector("#s-message-font").value, "geist");
  assert.equal(root().querySelector("#s-message-size").value, "20");
});

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

test("Agent desktops: the host switch asks for consent first (download size from the pin); declining saves nothing", async () => {
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  const calls = [];
  let answer = false;
  let push = null;
  let last = null;
  const base = { docker: "ready", image: "absent", pull: null, host: false, limit: 3, running: [], error: null, isolation: true, sizeBytes: 486649135 };
  const deck = {
    desktops: {
      state: async () => last || base, // what the main process holds now
      host: async (on) => { calls.push(["host", on]); last = { ...base, host: on, image: "pulling", pull: { pct: 10 } }; return { settings: { language: "en", desktops: { host: on } }, state: last }; },
      stop: async (p) => { calls.push(["stop", p]); return last; },
      reset: async (p) => { calls.push(["reset", p]); return last; },
      onEvent: (cb) => { push = (st) => cb((last = st)); },
    },
    openExternal: (u) => calls.push(["open", u]),
  };
  const asked = [];
  const { sv, root, saves } = mount({ deck, confirm: async (o) => { asked.push(o); return answer; }, saveCall: async (call) => { await call(); } });
  sv.open("device");
  await flush();
  const box = () => root().querySelector('.sv-section[data-section="device"]');
  assert.match(box().text, /Agent desktops/);
  const sw = () => box().querySelector("#s-dk-host");
  assert.equal(sw().checked, false);

  sw().checked = true;
  sw().dispatch("change");
  await flush();
  assert.equal(asked.length, 1);
  assert.match(asked[0].body, /about 487 MB once/);
  assert.match(asked[0].body, /Undo points use up to 5 GB per agent on this computer\./);
  assert.equal(calls.filter((c) => c[0] === "host").length, 0, "declined: nothing saved, nothing downloaded");
  assert.equal(sw().checked, false);

  answer = true;
  sw().checked = true;
  sw().dispatch("change");
  await flush();
  assert.deepEqual(calls.filter((c) => c[0] === "host"), [["host", true]]);
  assert.match(box().text, /Downloading the desktop image… 10%/);

  push({ ...base, host: true, image: "present", running: [{ profile: "aurora", memMB: 700, cpuPct: 3.5, homeBytes: 12e9 }] });
  assert.match(box().text, /Ready/);
  assert.match(box().text, /aurora/);
  assert.match(box().text, /700 MB · 3.5% CPU · 12.0 GB/);
  assert.match(box().text, /Home folder is over 10 GB/);
  box().querySelector('[data-fk="dk:stop:aurora"]').dispatch("click");
  await flush();
  box().querySelector('[data-fk="dk:reset:aurora"]').dispatch("click");
  await flush();
  assert.deepEqual(calls.filter((c) => c[0] === "stop" || c[0] === "reset"), [["stop", "aurora"], ["reset", "aurora"]]);
  assert.match(asked.at(-1).body, /Reset aurora's desktop\?/);

  // turning it off needs no consent
  const before = asked.length;
  sw().checked = false;
  sw().dispatch("change");
  await flush();
  assert.equal(asked.length, before);
  assert.deepEqual(calls.filter((c) => c[0] === "host").at(-1), ["host", false]);

  push({ ...base, docker: "missing" });
  assert.match(box().text, /Docker is not installed/);
  box().querySelector('[data-fk="dk:docker-link"]').dispatch("click");
  assert.deepEqual(calls.at(-1), ["open", SVM.DOCKER_URL]);
  push({ ...base, docker: "stopped" });
  assert.match(box().text, /Docker is not running/);

  const limit = box().querySelector("#s-dk-limit");
  limit.value = "4";
  limit.dispatch("change");
  const mem = box().querySelector("#s-dk-memory");
  mem.value = "2.5";
  mem.dispatch("change");
  const idle = box().querySelector("#s-dk-idleMin");
  idle.value = "";
  idle.dispatch("change");
  assert.deepEqual(saves.filter((p) => p.desktops), [{ desktops: { limit: 4 } }, { desktops: { memory: "2.5g" } }], "an emptied field saves nothing");
  assert.equal(saves.some((p) => p.desktops && "host" in p.desktops), false, "the switch never goes through the generic save");
});

test("Agent desktops: a failed turn-on leaves the switch off even while it has the focus (fix1 #6)", async () => {
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  const base = { docker: "ready", image: "absent", pull: null, host: false, limit: 3, running: [], error: null, isolation: true, sizeBytes: 1e9 };
  const deck = { desktops: { state: async () => base, host: async () => { throw new Error("disk full"); }, onEvent() {} }, openExternal() {} };
  const { sv, root } = mount({ deck, confirm: async () => true, saveCall: async (call) => { try { await call(); } catch {} } });
  sv.open("device");
  await flush();
  const sw = root().querySelector("#s-dk-host");
  sw.focus();
  sw.checked = true;
  sw.dispatch("change");
  await flush();
  assert.equal(root().querySelector("#s-dk-host").checked, false);
});

test("Agent desktops: Turkish reset confirmation names the agent naturally (fix1 #8)", () => {
  i18n.setLanguage("tr");
  assert.match(i18n.t("desktops.resetConfirm", { agent: "Hermes" }), /^Hermes ajanının masaüstü sıfırlansın mı\?/);
});

test("Agent desktops: no group without the desktops API; sizes read as people say them", () => {
  const { sv, root } = mount();
  sv.open("device");
  assert.equal(root().querySelector("#s-dk-host"), null);
  assert.equal(SVM.sizeText(486649135), "487 MB");
  assert.equal(SVM.sizeText(1.2e9), "1.2 GB");
  assert.equal(SVM.sizeText(null), "?");
});

test("hidden bots: saved usernames render with Show buttons and Show removes only that username", async () => {
  const { sv, root, saves, setSettings } = mount();
  setSettings({ hiddenBots: ["BotFather", "ExampleBot"] });
  sv.open("telegram");
  assert.match(root().text, /@BotFather/);
  assert.match(root().text, /@ExampleBot/);
  const show = root().querySelector('[data-fk="hidden-show:examplebot"]');
  assert.ok(show, "saved bot has a Show button");
  assert.equal(show.text, "Show");
  show.dispatch("click");
  await new Promise(setImmediate);
  assert.deepEqual(saves, [{ hiddenBots: ["BotFather"] }]);
  assert.doesNotMatch(root().text, /@ExampleBot/);
});

test("hidden bots: manual add trims, strips @ and dedupes without dropping saved entries", async () => {
  const { sv, root, saves, setSettings } = mount();
  setSettings({ hiddenBots: ["BotFather", "botfather"] });
  sv.open("telegram");
  const add = () => root().querySelector('[data-fk="hidden-add"]');
  assert.ok(add(), "manual Hide button exists");
  root().querySelector("#s-hidden").value = "  @ExampleBot  ";
  add().dispatch("click");
  await new Promise(setImmediate);
  assert.deepEqual(saves.at(-1), { hiddenBots: ["BotFather", "ExampleBot"] });
  root().querySelector("#s-hidden").value = "@examplebot";
  root().querySelector("#s-hidden").dispatch("keydown", { key: "Enter" });
  await new Promise(setImmediate);
  assert.deepEqual(saves.at(-1), { hiddenBots: ["BotFather", "ExampleBot"] });
  assert.equal(root().querySelectorAll('[data-fk="hidden-show:examplebot"]').length, 1);
});

test("hidden bots: empty state, blank input and 50-entry limit", async () => {
  const { sv, root, saves, setSettings } = mount();
  sv.open("telegram");
  assert.match(root().text, /No hidden bots/);
  root().querySelector("#s-hidden").value = "  @  ";
  root().querySelector('[data-fk="hidden-add"]').dispatch("click");
  await new Promise(setImmediate);
  assert.equal(saves.length, 0);
  setSettings({ hiddenBots: Array.from({ length: 50 }, (_, i) => `ExampleBot${i}`) });
  sv.refresh();
  root().querySelector("#s-hidden").value = "OverflowBot";
  root().querySelector('[data-fk="hidden-add"]').dispatch("click");
  await new Promise(setImmediate);
  assert.equal(saves.length, 0, "a full list must not pretend to save another bot");
  assert.match(root().text, /50/);
});

test("hidden bots: Enter refreshes the list while the input has focus and keeps other drafts", async () => {
  const { sv, root } = mount();
  sv.open("telegram");
  root().querySelector("#s-apiid").value = "1234567";
  const input = root().querySelector("#s-hidden");
  input.value = "@ExampleBot";
  input.focus();
  input.dispatch("keydown", { key: "Enter" });
  await new Promise(setImmediate);
  assert.ok(root().querySelector('[data-fk="hidden-show:examplebot"]'), "Show appears without leaving the input");
  assert.equal(root().querySelector("#s-hidden").value, "");
  assert.equal(root().querySelector("#s-apiid").value, "1234567");
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

// ---------------------------------------------------------------- agent spaces, phase 2 (Task 9)

function spacesDeck(list, calls = []) {
  return {
    spaces: {
      list: async () => list,
      mode: async (m) => (calls.push(["mode", m]), { ok: true }),
      home: async (p, host) => (calls.push(["home", p, host]), { ok: true }),
    },
  };
}

// Relay-owned settings must never pass through the local settings save path.
const safetyDefaults = { audit: true, typedText: false, screenshots: true, days: 7, approvals: true, snapshotKeep: 10 };
test("activity/safety settings wait for relay defaults and save single validated properties only to relay", async () => {
  const patches = [];
  let loaded, finish;
  let value = { ...safetyDefaults };
  const m = mount({ deck: { spaces: {
    list: async () => ({ mode: "agent", hosts: [], spaces: [] }),
    safety: (patch) => {
      if (!patch) return new Promise((resolve) => { loaded = resolve; });
      patches.push(patch);
      return new Promise((resolve) => { finish = () => { value = { ...value, ...patch }; resolve({ settings: value }); }; });
    },
  } } });
  m.sv.open("device");
  const control = (key) => m.root().querySelector(`#s-safety-${key}`);
  for (const key of Object.keys(value)) {
    assert.ok(control(key), `missing safety control: ${key}`);
    assert.equal(control(key).disabled, true);
  }
  loaded({ settings: value });
  await new Promise(setImmediate);
  for (const [key, expected] of Object.entries(value)) {
    assert.equal(control(key).disabled, false);
    assert.equal(typeof expected === "boolean" ? control(key).checked : control(key).value, typeof expected === "boolean" ? expected : String(expected));
  }
  for (const [key, next] of Object.entries({ audit: false, typedText: true, screenshots: false, days: 90, approvals: false, snapshotKeep: 100 })) {
    const el = control(key);
    if (el.type === "checkbox") el.checked = next; else el.value = String(next);
    el.dispatch("change");
    assert.equal(el.disabled, true);
    assert.deepEqual(patches.at(-1), { [key]: next });
    finish();
    await new Promise(setImmediate);
    assert.equal(el.disabled, false);
  }
  for (const [key, bad] of [["days", ""], ["days", "0"], ["days", "91"], ["days", "1.5"], ["snapshotKeep", "101"], ["snapshotKeep", "no"]]) {
    control(key).value = bad;
    control(key).dispatch("change");
    await new Promise(setImmediate);
    assert.equal(control(key).value, String(value[key]));
  }
  assert.equal(patches.length, 6, "invalid values never reach IPC");
  assert.equal(m.saves.length, 0);
});

test("failed safety saves revert and stopped-agent undo deletion requires confirmation and refreshes totals", async () => {
  const deletes = [], reads = [], asked = [];
  let consent = false, failDelete = true;
  const m = mount({ confirm: async (o) => { asked.push(o); return consent; }, deck: { spaces: {
    list: async () => ({ mode: "agent", hosts: [], spaces: [{ id: "host", kind: "shared" }, { id: "agent1", kind: "agent", state: "stopped" }] }),
    safety: async (patch) => patch ? { ok: false, error: "operation-failed" } : { settings: safetyDefaults },
    snapshots: async (id) => { reads.push(id); return { points: [], totalBytes: deletes.length > 1 ? 0 : 123_000_000 }; },
    deleteSnapshots: async (id) => { deletes.push(id); return { ok: !failDelete }; },
  } } });
  m.sv.open("device"); await new Promise(setImmediate);
  const typed = m.root().querySelector("#s-safety-typedText");
  assert.ok(typed);
  typed.checked = true; typed.dispatch("change"); await new Promise(setImmediate);
  assert.equal(typed.checked, false);
  assert.match(m.root().querySelector(".sv-safety").text, /Could not save or load safety settings/);
  assert.deepEqual(reads, ["agent1"]);
  const button = m.root().querySelector('[data-snapshot-delete="agent1"]');
  assert.ok(button);
  assert.match(m.root().querySelector(".sv-snapshot-disk").text, /123 MB/);
  button.dispatch("click"); await new Promise(setImmediate);
  assert.deepEqual(deletes, []);
  assert.match(asked[0].body, /current home folder will be kept/);
  consent = true; button.dispatch("click"); await new Promise(setImmediate);
  assert.deepEqual(deletes, ["agent1"]);
  assert.equal(button.disabled, false, "failed deletion can be retried");
  failDelete = false; button.dispatch("click"); await new Promise(setImmediate);
  assert.deepEqual(deletes, ["agent1", "agent1"]);
  assert.deepEqual(reads, ["agent1", "agent1"]);
  assert.match(m.root().querySelector(".sv-snapshot-disk").text, /Undo points: 0 MB/);
  assert.equal(m.saves.length, 0);
});

test("safety load failures leave controls disabled and unavailable snapshots cannot be deleted", async () => {
  const m = mount({ deck: { spaces: {
    list: async () => ({ mode: "agent", hosts: [], spaces: [{ id: "agent1", kind: "agent" }] }),
    safety: async () => { throw new Error("offline"); },
    snapshots: async () => ({ ok: false, error: "offline" }),
  } } });
  m.sv.open("device"); await new Promise(setImmediate);
  assert.ok(m.root().querySelector("#s-safety-audit"));
  for (const key of Object.keys(safetyDefaults)) assert.equal(m.root().querySelector(`#s-safety-${key}`).disabled, true);
  assert.match(m.root().querySelector(".sv-safety").text, /Could not save or load safety settings/);
  assert.match(m.root().querySelector(".sv-snapshot-disk").text, /Unavailable/);
  assert.equal(m.root().querySelector('[data-snapshot-delete="agent1"]').disabled, true);
});

for (const [flag, message] of [["auditLocked", /disabled by the relay's environment/], ["loggingPaused", /paused because storage is unavailable/]]) test(`safety reports ${flag} and respects the relay audit lock`, async () => {
  const m = mount({ deck: { spaces: {
    list: async () => ({ mode: "shared", hosts: [], spaces: [] }),
    safety: async () => ({ settings: { ...safetyDefaults, audit: false, [flag]: true } }),
  } } });
  m.sv.open("device"); await new Promise(setImmediate);
  const audit = m.root().querySelector("#s-safety-audit");
  assert.ok(audit);
  assert.equal(audit.disabled, flag === "auditLocked");
  assert.equal(audit.checked, false);
  assert.match(m.root().querySelector(".sv-safety").text, message);
});
test("undo point totals and deletion stay available in shared mode, for every known agent", async () => {
  const reads = [];
  const m = mount({ agents: () => [{ profile: "agent1", name: "Agent One" }, { profile: "host" }], deck: { spaces: {
    list: async () => ({ mode: "shared", hosts: [], spaces: [{ id: "host", kind: "shared" }] }),
    safety: async () => ({ settings: safetyDefaults }),
    snapshots: async (id) => { reads.push(id); return { points: [], totalBytes: 50_000_000 }; },
    deleteSnapshots: async () => ({ ok: true }),
  } } });
  m.sv.open("device"); await new Promise(setImmediate); await new Promise(setImmediate);
  assert.deepEqual(reads, ["agent1"], "the shared desktop id is never an agent");
  assert.ok(m.root().querySelector('[data-snapshot-delete="agent1"]'));
  assert.match(m.root().querySelector(".sv-snapshot-disk").text, /Agent One/);
  assert.match(m.root().querySelector(".sv-snapshot-disk").text, /50 MB/);
});

test("the audit lock explanation survives a saved edit and a deletion", async () => {
  const m = mount({ agents: () => [{ profile: "agent1" }], confirm: async () => true, deck: { spaces: {
    list: async () => ({ mode: "agent", hosts: [], spaces: [{ id: "agent1", kind: "agent" }] }),
    safety: async (patch) => ({ ok: true, settings: { ...safetyDefaults, audit: false, auditLocked: true, ...(patch || {}) } }),
    snapshots: async () => ({ points: [], totalBytes: 0 }),
    deleteSnapshots: async () => ({ ok: true }),
  } } });
  m.sv.open("device"); await new Promise(setImmediate); await new Promise(setImmediate);
  const typed = m.root().querySelector("#s-safety-typedText");
  typed.checked = true; typed.dispatch("change"); await new Promise(setImmediate);
  assert.match(m.root().querySelector(".sv-safety").text, /disabled by the relay's environment/);
  assert.match(m.root().querySelector(".sv-safety").text, /Saved/);
  m.root().querySelector('[data-snapshot-delete="agent1"]').dispatch("click"); await new Promise(setImmediate); await new Promise(setImmediate);
  assert.match(m.root().querySelector(".sv-safety").text, /disabled by the relay's environment/);
});

const flushAll = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

for (const [lang, label] of [["en", "Shared first, own desktop when busy"], ["tr", "Önce ortak masaüstü, doluysa kendi masaüstü"]]) test(`overflow: Settings option in ${lang} saves mode`, async () => {
  i18n.setLanguage(lang);
  const calls = [];
  const { sv, root } = mount({ deck: spacesDeck({ mode: "shared", spaces: [], hosts: [], homes: {} }, calls), saveCall: async (call) => call() });
  sv.open("device");
  await flushAll();
  const mode = root().querySelector("#s-space-mode");
  const option = mode.children.find((o) => o.attrs.value === "overflow");
  assert.ok(option, "overflow option exists");
  assert.equal(option.text, label);
  mode.value = "overflow";
  mode.dispatch("change");
  await flushAll();
  assert.deepEqual(calls.at(-1), ["mode", "overflow"]);
});

test("Agent spaces: a mode the relay refuses does not stay selected", async () => {
  const deck = spacesDeck({ mode: "shared", spaces: [], hosts: [], homes: {} }, []);
  deck.spaces.mode = async () => ({ ok: false, error: "bad mode" });
  let failed = null;
  const { sv, root } = mount({ deck, saveCall: async (call) => { try { await call(); } catch (e) { failed = e; } } });
  sv.open("device");
  await flushAll();
  const mode = root().querySelector("#s-space-mode");
  mode.value = "overflow";
  mode.dispatch("change");
  await flushAll();
  assert.match(String(failed && failed.message), /bad mode/);
  assert.equal(mode.value, "shared", "back to the relay's mode");
});

test("overflow: Settings shows no-host hint", async () => {
  const { sv, root } = mount({ deck: spacesDeck({ mode: "overflow", spaces: [], hosts: [], homes: {} }) });
  sv.open("device");
  await flushAll();
  assert.match(root().querySelector('.sv-section[data-section="device"]').text, /No computer hosts agent desktops yet/);
});

test("Agent spaces: own desktop per agent is selectable; one home-host row per agent (never host), a not-ready host dimmed, a vanished home offline; a change goes to the relay", async () => {
  const calls = [];
  const list = {
    mode: "agent",
    spaces: [{ id: "host", kind: "shared" }],
    hosts: [{ id: "agent-host", name: "mac", ready: true, limit: 1, running: 0 }, { id: "a1b2c3d4", name: "pc", ready: true, limit: 3, running: 1 }, { id: "b2c3d4e5", name: "laptop", ready: false, limit: 2, running: 0 }],
    homes: { aurora: "a1b2c3d4", scout: "c3d4e5f6" },
  };
  const { sv, root } = mount({
    deck: spacesDeck(list, calls),
    agents: () => [{ profile: "aurora", name: "Aurora" }, { profile: "pioneer" }, { profile: "host" }, { profile: "scout", name: "Scout" }],
    saveCall: async (call) => { await call(); },
  });
  sv.open("device");
  await flushAll();
  const mode = root().querySelector("#s-space-mode");
  assert.equal(mode.disabled, false);
  assert.equal(mode.value, "agent");
  const agentOpt = mode.children.find((o) => o.attrs.value === "agent");
  assert.equal(agentOpt.disabled, false, "Own desktop per agent can be chosen");
  assert.doesNotMatch(agentOpt.text, /phase 2/i);
  const a = root().querySelector("#s-space-home-aurora");
  assert.ok(a, "a row for Aurora");
  assert.ok(root().querySelector("#s-space-home-pioneer"));
  assert.equal(root().querySelector("#s-space-home-host"), null, "profile host is never an agent");
  assert.equal(a.value, "a1b2c3d4");
  assert.equal(root().querySelector("#s-space-home-pioneer").value, "auto");
  assert.deepEqual(a.children.map((o) => o.attrs.value), ["auto", "agent-host", "a1b2c3d4", "b2c3d4e5"]);
  assert.deepEqual(a.children.map((o) => o.text), ["Automatic", "Agent host", "pc", "laptop (not ready)"]);
  assert.ok(a.children[3].classList.contains("off"), "a connected device that cannot host yet is dimmed");
  const s = root().querySelector("#s-space-home-scout");
  assert.equal(s.value, "c3d4e5f6", "a home host that is gone stays shown");
  assert.equal(s.children.at(-1).text, "c3d4e5f6 (offline)");
  assert.match(root().querySelector('.sv-section[data-section="device"]').text, /Aurora/);
  const p = root().querySelector("#s-space-home-pioneer");
  p.value = "agent-host";
  p.dispatch("change");
  await flushAll();
  assert.deepEqual(calls.at(-1), ["home", "pioneer", "agent-host"]);
  assert.doesNotMatch(root().querySelector('.sv-section[data-section="device"]').text, /No computer hosts agent desktops/);
});

test("Agent spaces: in agent mode with no desktop host yet, Settings says how to get one", async () => {
  const { sv, root } = mount({ deck: spacesDeck({ mode: "agent", spaces: [], hosts: [], homes: {} }), agents: () => [{ profile: "aurora" }] });
  sv.open("device");
  await flushAll();
  assert.match(root().querySelector('.sv-section[data-section="device"]').text, /No computer hosts agent desktops yet/);
  const { sv: sv2, root: root2 } = mount({ deck: spacesDeck({ mode: "shared", spaces: [], hosts: [], homes: {} }), agents: () => [] });
  sv2.open("device");
  await flushAll();
  assert.doesNotMatch(root2().querySelector('.sv-section[data-section="device"]').text, /No computer hosts agent desktops/, "shared mode needs no desktop host");
});

// ------------------------------------------------------------------ Update the host (docs/updating.md)
const hostState = (update, over = {}) => ({
  app: "1.3.0", protocol: 1, relay: { version: "1.2.0", older: true, mismatch: false },
  plugins: [{ profile: "default", version: "1.2.0", older: true, source: "relay" }],
  commands: { relay: "relay/bin/deck-relay-update apply", plugin: "python hermes-plugin/hermes-deck/install.py" },
  update, ...over,
});
const remoteOk = { enabled: true, managed: true };

test("Host version: Update button, live progress, and Restart now with a confirm", async () => {
  const calls = [];
  let state = hostState({ remote: remoteOk, status: null, restarts: [], queueError: null });
  const deck = { hostUpdate: { update: async () => { calls.push(["update"]); return { ok: true, state: "started" }; }, restart: async (p) => { calls.push(["restart", p]); return { ok: true }; } } };
  const asked = [];
  const { sv, root } = mount({ deck, hostVersions: () => state, confirm: async (o) => { asked.push(o); return true; } });
  sv.open("relay");
  const btn = () => root().querySelector('[data-fk="hostupd:update"]');
  assert.match(btn().text, /Update the host to 1\.3\.0/);
  btn().dispatch("click");
  await flushAll();
  assert.deepEqual(calls, [["update"]]);
  state = hostState({ remote: remoteOk, status: { version: "1.3.0", step: "health", state: "running" }, restarts: [{ profile: "default", state: "busy", reason: "plugin 1.3.0" }], queueError: null });
  sv.refresh({ force: true });
  assert.match(root().querySelector('.sv-section[data-section="relay"]').text, /Restarting the relay/);
  assert.equal(btn().disabled, true, "no second press while it runs");
  sv.open("hermes");
  assert.match(root().querySelector('.sv-section[data-section="hermes"]').text, /default: waiting, a turn is running/);
  root().querySelector('[data-fk="hostupd:restart:default"]').dispatch("click");
  await flushAll();
  assert.equal(asked.length, 1);
  assert.match(asked[0].body, /Restart the default gateway now/);
  assert.deepEqual(calls.at(-1), ["restart", "default"]);
});

test("Host version: a declined confirm restarts nothing; pending and restarting rows offer no Restart now", async () => {
  const calls = [];
  const state = hostState({ remote: remoteOk, status: null, restarts: [{ profile: "default", state: "waiting" }, { profile: "aurora", state: "pending" }, { profile: "pioneer", state: "restarting" }], queueError: null });
  const deck = { hostUpdate: { update: async () => ({}), restart: async (p) => { calls.push(p); return { ok: true }; } } };
  const { sv, root } = mount({ deck, hostVersions: () => state, confirm: async () => false });
  sv.open("hermes");
  root().querySelector('[data-fk="hostupd:restart:default"]').dispatch("click");
  await flushAll();
  assert.deepEqual(calls, []);
  assert.equal(root().querySelector('[data-fk="hostupd:restart:aurora"]'), null);
  assert.equal(root().querySelector('[data-fk="hostupd:restart:pioneer"]'), null);
  assert.match(root().querySelector('.sv-section[data-section="hermes"]').text, /aurora: the plugin install has not finished/);
});

test("Host version: an older relay on a checkout disables the button and says to update it once; remote off says so", () => {
  const deck = { hostUpdate: { update: async () => ({}), restart: async () => ({}) } };
  const a = mount({ deck, hostVersions: () => hostState({ remote: { enabled: true, managed: false }, status: null, restarts: [], queueError: null }) });
  a.sv.open("relay");
  assert.equal(a.root().querySelector('[data-fk="hostupd:update"]').disabled, true);
  assert.match(a.root().querySelector('.sv-section[data-section="relay"]').text, /Update it once on the host.*git pull && cd relay && npm ci --omit=dev/);
  const b = mount({ deck, hostVersions: () => hostState({ remote: { enabled: false, managed: true }, status: null, restarts: [], queueError: null }) });
  b.sv.open("relay");
  assert.equal(b.root().querySelector('[data-fk="hostupd:update"]').disabled, true);
  assert.match(b.root().querySelector('.sv-section[data-section="relay"]').text, /DECK_REMOTE_UPDATE=0/);
});

test("Host version: a relay that can adopt its checkout enables the button and says the first update moves it", async () => {
  const calls = [];
  const deck = { hostUpdate: { update: async () => { calls.push("update"); return { ok: true, state: "started" }; }, restart: async () => ({}) } };
  let state = hostState({ remote: { enabled: true, managed: false, adopt: true }, status: null, restarts: [], queueError: null });
  const { sv, root } = mount({ deck, hostVersions: () => state });
  sv.open("relay");
  const btn = root().querySelector('[data-fk="hostupd:update"]');
  assert.ok(!btn.disabled);
  const text = () => root().querySelector('.sv-section[data-section="relay"]').text;
  assert.match(text(), /first update copies it to an install root/);
  assert.doesNotMatch(text(), /git pull/);
  btn.dispatch("click");
  await flushAll();
  assert.deepEqual(calls, ["update"]);
  state = hostState({ remote: { enabled: true, managed: false, adopt: true }, status: { version: "1.3.0", step: "adopt", state: "running" }, restarts: [], queueError: null });
  sv.refresh({ force: true });
  assert.match(text(), /Moving the relay to an install root/);
  assert.doesNotMatch(text(), /first update copies/, "the note goes once the update runs");
  // only the plugin behind: the plugin step runs from the checkout and moves nothing
  state = hostState({ remote: { enabled: true, managed: false, adopt: true }, status: null, restarts: [], queueError: null }, { relay: { version: "1.3.0", older: false, mismatch: false } });
  sv.open("hermes");
  sv.refresh({ force: true });
  assert.ok(root().querySelector('[data-fk="hostupd:update"]'));
  assert.doesNotMatch(root().querySelector('.sv-section[data-section="hermes"]').text, /first update copies/);
});

test("Host version: a relay without host updates keeps only the command; a current host shows no button", () => {
  const deck = { hostUpdate: { update: async () => ({}), restart: async () => ({}) } };
  const a = mount({ deck, hostVersions: () => hostState(null) });
  a.sv.open("relay");
  assert.equal(a.root().querySelector('[data-fk="hostupd:update"]'), null);
  assert.match(a.root().querySelector('.sv-section[data-section="relay"]').text, /deck-relay-update apply/);
  const b = mount({ deck, hostVersions: () => hostState({ remote: remoteOk, status: null, restarts: [], queueError: null }, { relay: { version: "1.3.0", older: false, mismatch: false }, plugins: [{ profile: "default", version: "1.3.0", older: false, source: "relay" }] }) });
  b.sv.open("relay");
  assert.equal(b.root().querySelector('[data-fk="hostupd:update"]'), null, "the host is current: nothing to press");
});

test("General Updates channel resets the target without installing; only the checked target is sent", async () => {
  let status = { version: "1.0.0", channel: "stable", unchecked: true }, checks = 0;
  const installs = [], selections = [];
  const deck = { updates: {
    status: async () => ({ status }), on() {}, open() {},
    channel: async channel => { selections.push(channel); status = { version: "1.0.0", channel, unchecked: true }; return { status }; },
    check: async () => { checks++; status = { ...status, unchecked: false, action: "release", target: "checked-test-target", release: { tag: "v1.0.0-test.2", newer: true } }; return { status }; },
    install: async target => { installs.push(target); return { ok: true }; },
  } };
  const { sv, root, saves } = mount({ deck });
  sv.open("general");
  await new Promise(resolve => setImmediate(resolve));
  let channel = root().querySelector("#s-upd-channel");
  assert.deepEqual(channel.children.map(n => n.getAttribute("value")), ["stable", "test"]);
  assert.equal(channel.children.find(n => n.getAttribute("selected") !== null).getAttribute("value"), "stable");
  assert.match(root().text, /Only this desktop app/);
  channel.value = "test";
  channel.dispatch("change");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(selections, ["test"]);
  assert.deepEqual(installs, []);
  assert.deepEqual(saves, []);
  assert.equal(checks, 0);
  assert.equal(root().querySelector('[data-fk="upd:install"]'), null);
  root().querySelector('[data-fk="upd:check"]').dispatch("click");
  await new Promise(resolve => setImmediate(resolve));
  assert.match(root().text, /Target versionv1\.0\.0-test\.2/);
  root().querySelector('[data-fk="upd:install"]').dispatch("click");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(installs, ["checked-test-target"], "main process provides native confirmation");
  channel = root().querySelector("#s-upd-channel");
  channel.value = "stable";
  channel.dispatch("change");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(root().querySelector('[data-fk="upd:install"]'), null);
});

test("General › Updates: the host auto-update switch saves updates.host", async () => {
  const deck = { updates: { status: async () => ({ status: { version: "1.3.0" }, busy: null }), check: async () => ({}), install: async () => ({}), open() {}, on() {} } };
  const { sv, saves, root, setSettings } = mount({ deck });
  setSettings({ language: "en", composer: { busySend: "queue" }, chat: { modes: ["telegram", "sessions"], defaultMode: "telegram" }, relay: { url: "", hasToken: false }, telegram: {}, downloads: { dir: "", ask: false }, desktop: { notifications: true, pet: true }, hiddenBots: [], updates: { auto: true, host: false, repo: "", branch: "main", hasToken: false, fromSource: false } });
  sv.open("general");
  await flushAll();
  const sw = root().querySelector("#s-upd-host");
  assert.ok(sw, "the switch is there");
  assert.ok(!sw.checked, "off by default");
  sw.checked = true;
  sw.dispatch("change");
  await flushAll();
  assert.deepEqual(saves.at(-1), { updates: { host: true } });
});

test("Host version: an error from the Update button stays visible after the rebuild", async () => {
  const deck = { hostUpdate: { update: async () => ({ ok: false, error: "hostupd.needDeviceKey" }), restart: async () => ({}) } };
  const { sv, root } = mount({ deck, hostVersions: () => hostState({ remote: remoteOk, status: null, restarts: [], queueError: null }) });
  sv.open("relay");
  root().querySelector('[data-fk="hostupd:update"]').dispatch("click");
  await flushAll();
  assert.match(root().querySelector('.sv-section[data-section="relay"]').text, /needs a device key/);
});

test("Host version: no button for a finished update on a current host, or for direct-connection drift only", () => {
  const deck = { hostUpdate: { update: async () => ({}), restart: async () => ({}) } };
  const current = { relay: { version: "1.3.0", older: false, mismatch: false }, plugins: [{ profile: "default", version: "1.3.0", older: false, source: "relay" }] };
  const a = mount({ deck, hostVersions: () => hostState({ remote: remoteOk, status: { version: "1.3.0", from: "1.2.0", step: "done", state: "done" }, restarts: [], queueError: null }, current) });
  a.sv.open("relay");
  assert.equal(a.root().querySelector('[data-fk="hostupd:update"]'), null);
  assert.match(a.root().querySelector('.sv-section[data-section="relay"]').text, /The host is on 1\.3\.0/);
  const b = mount({ deck, hostVersions: () => hostState({ remote: remoteOk, status: null, restarts: [], queueError: null }, { relay: { version: "1.3.0", older: false, mismatch: false }, plugins: [{ profile: null, version: "1.2.0", older: true, legacy: false, source: "bridge" }] }) });
  b.sv.open("hermes");
  assert.equal(b.root().querySelector('[data-fk="hostupd:update"]'), null, "the direct connection is not updated by the relay");
});

test("Host version: a restart queue error shows even with no plugin rows", () => {
  const deck = { hostUpdate: { update: async () => ({}), restart: async () => ({}) } };
  const { sv, root } = mount({ deck, hostVersions: () => hostState({ remote: remoteOk, status: null, restarts: [], queueError: "EACCES: permission denied" }, { relay: { version: "1.3.0", older: false, mismatch: false }, plugins: [] }) });
  sv.open("hermes");
  assert.match(root().querySelector('.sv-section[data-section="hermes"]').text, /cannot read its gateway restart queue: EACCES/);
});

test("Host version: an install that stopped half way (pending restarts, failed status, current host) offers Try again", async () => {
  const calls = [];
  const deck = { hostUpdate: { update: async () => { calls.push("update"); return { ok: true }; }, restart: async () => ({}) } };
  const current = { relay: { version: "1.3.0", older: false, mismatch: false }, plugins: [{ profile: "default", version: "1.3.0", older: false, source: "relay" }] };
  const u = { remote: remoteOk, status: { version: "1.3.0", step: "plugin", state: "failed", error: "the update stopped without reporting (abandoned)" }, restarts: [{ profile: "default", state: "pending" }], queueError: null };
  const { sv, root } = mount({ deck, hostVersions: () => hostState(u, current) });
  sv.open("relay");
  const btn = root().querySelector('[data-fk="hostupd:update"]');
  assert.ok(btn, "the update can be finished from the app");
  assert.match(btn.text, /Try again/);
  btn.dispatch("click");
  await flushAll();
  assert.deepEqual(calls, ["update"]);
  sv.open("hermes");
  assert.ok(root().querySelector('.sv-section[data-section="hermes"] [data-fk="hostupd:update"]'), "also next to the pending rows");
});
