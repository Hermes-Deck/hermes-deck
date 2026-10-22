"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const HS = require("../renderer/host-switcher");
const I18N = require("../renderer/i18n");
const RENDERER = path.join(__dirname, "../renderer");

// ---- a tiny DOM: elements with attributes, children, listeners and focus
function fakeDoc() {
  const listeners = new Map();
  class El {
    constructor(tag) { this.tag = tag; this.attrs = new Map(); this.children = []; this.l = new Map(); this.hidden = false; this.className = ""; this.textContent = ""; this.parentNode = null; this.dataset = {}; this.style = { set: new Map(), setProperty(k, v) { this.set.set(k, v); } }; }
    setAttribute(k, v) { this.attrs.set(k, String(v)); if (k === "class") this.className = String(v); }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    removeAttribute(k) { this.attrs.delete(k); }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    replaceChildren(...k) { this.children = []; k.forEach(c => this.appendChild(c)); }
    get firstChild() { return this.children[0]; }
    get lastChild() { return this.children[this.children.length - 1]; }
    addEventListener(t, fn) { if (!this.l.has(t)) this.l.set(t, []); this.l.get(t).push(fn); }
    focus() { doc.activeElement = this; }
    remove() { this.removed = true; }
    fire(t, e = {}) { const ev = { target: this, preventDefault() { ev.defaultPrevented = true; }, ...e }; for (const fn of this.l.get(t) || []) fn(ev); return ev; }
    click() { return this.fire("click"); }
  }
  const doc = {
    activeElement: null, documentElement: new El("html"),
    createElement: tag => new El(tag),
    addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
    removeEventListener(t, fn) { listeners.set(t, (listeners.get(t) || []).filter(x => x !== fn)); },
    key(e) { const ev = { target: doc.activeElement, preventDefault() { ev.defaultPrevented = true; }, ...e }; for (const fn of listeners.get("keydown") || []) fn(ev); return ev; },
    listenerCount: t => (listeners.get(t) || []).length,
  };
  return doc;
}

const HOSTS = [{ id: "h1", name: "Atlas" }, { id: "h2", name: "Borealis" }, { id: "h3", name: "Cirrus" }];
function make(extra = {}) {
  const doc = fakeDoc(), calls = [];
  const state = { hosts: HOSTS, active: "h1", pending: false, ready: true, own: { relay: "open", sessions: "open" }, ...extra.state };
  const ctx = { doc, t: (k, v) => I18N.t(k, v), icon: (n, s) => ({ icon: n, size: s }),
    ready: () => state.ready, hosts: () => state.hosts, active: () => state.active, pending: () => state.pending,
    own: () => state.own, select: id => { calls.push(["select", id]); return Promise.resolve(); },
    setSplit: async on => { calls.push(["split", on]); return { split: on, pane: "left", hostId: state.active, panes: [{ side: "left", hostId: state.active }, { side: "right", hostId: "h2" }] }; },
    onError: e => calls.push(["error", String(e)]), ...extra.ctx };
  if (extra.noSplit) delete ctx.setSplit;
  const sw = HS.create(ctx);
  sw.render();
  const nums = () => sw.root.children[0].children;
  return { sw, doc, calls, state, nums, split: () => sw.root.children[1] };
}

test("states normalise to five words and the dot colours follow 'both open / some down / none up / nothing observed'", () => {
  assert.deepEqual(["open", "connecting", "starting", "closed", "offline", "off", "unconfigured", "saved", undefined].map(HS.normState),
    ["open", "connecting", "connecting", "offline", "offline", "unconfigured", "unconfigured", "saved", "saved"]);
  assert.equal(HS.dotOf("open", "open"), "ok");
  assert.equal(HS.dotOf("open", "off"), "ok", "a relay-only host is fine with Sessions not configured");
  assert.equal(HS.dotOf("off", "open"), "ok");
  assert.equal(HS.dotOf("open", "connecting"), "warn");
  assert.equal(HS.dotOf("connecting", "closed"), "warn");
  assert.equal(HS.dotOf("open", "closed"), "warn", "one of them down");
  assert.equal(HS.dotOf("closed", "closed"), "bad");
  assert.equal(HS.dotOf("closed", "off"), "bad");
  assert.equal(HS.dotOf("off", "off"), "off");
  assert.equal(HS.dotOf("saved", "saved"), "off", "saved config is not a connection");
});

test("own host reads live inputs, others read status frames, then Settings' saved config and observed watcher", () => {
  const cs = (configured, status) => (!configured ? "unconfigured" : status === "open" ? "open" : "saved");
  const status = new Map([["h2", { id: "h2", relay: "closed", sessions: "open" }]]);
  const base = { shown: "h1", own: { relay: "open", sessions: "connecting" }, status, connectionState: cs };
  assert.deepEqual(HS.statesFor({ id: "h1" }, { ...base }), { relay: "open", sessions: "connecting" });
  assert.deepEqual(HS.statesFor({ id: "h2" }, { ...base }), { relay: "offline", sessions: "open" });
  const saved = { id: "h3", relay: { url: "ws://r", hasToken: true }, bridge: { mode: "ssh" } };
  assert.deepEqual(HS.statesFor(saved, { ...base, remote: { id: "h3", status: "open" } }), { relay: "saved", sessions: "open" });
  assert.deepEqual(HS.statesFor({ id: "h4", relay: { url: "" }, bridge: { mode: "off" } }, base), { relay: "unconfigured", sessions: "unconfigured" });
});

test("one numbered button per saved host in settings order; the shown host is lit and the roving tab stop", () => {
  const { sw, nums } = make();
  assert.equal(sw.root.hidden, false);
  assert.deepEqual(nums().map(b => b.firstChild.textContent), ["1", "2", "3"]);
  assert.deepEqual(nums().map(b => b.className), ["hb-num lit", "hb-num", "hb-num"]);
  assert.deepEqual(nums().map(b => b.getAttribute("aria-checked")), ["true", "false", "false"]);
  assert.deepEqual(nums().map(b => b.getAttribute("tabindex")), ["0", "-1", "-1"]);
  assert.deepEqual(nums().map(b => b.getAttribute("role")), ["radio", "radio", "radio"]);
  assert.equal(sw.root.children[0].getAttribute("role"), "radiogroup");
});

test("hidden with one host, before first run or with no hosts; the split button goes with it", () => {
  for (const state of [{ hosts: [HOSTS[0]] }, { hosts: [] }, { ready: false }]) assert.equal(make({ state }).sw.root.hidden, true);
});

test("tooltip and accessible name: host name, Relay and Sessions states, localised", () => {
  const { nums } = make({ state: { own: { relay: "open", sessions: "connecting" } } });
  assert.equal(nums()[0].getAttribute("title"), "Atlas — Relay: Connected · Sessions: Connecting");
  assert.equal(nums()[0].getAttribute("aria-label"), nums()[0].getAttribute("title"));
  assert.equal(nums()[1].getAttribute("title"), "Borealis — Relay: Not configured · Sessions: Not configured", "no status frame and no config: nothing observed");
  I18N.setLanguage("tr");
  try {
    const tr = make({ state: { own: { relay: "open", sessions: "open" } } });
    assert.equal(tr.nums()[0].getAttribute("title"), "Atlas — Relay: Bağlı · Oturumlar: Bağlı");
    assert.equal(tr.split().getAttribute("title"), "Yan yana göster");
  } finally { I18N.setLanguage("en"); }
});

test("status frames colour every host's dot; a frame for an unknown host is ignored", () => {
  const { sw, nums } = make();
  sw.setStatus([{ id: "h2", name: "Borealis", relay: "open", sessions: "open" }, { id: "h3", relay: "closed", sessions: "closed" }, { id: "gone", relay: "open", sessions: "open" }, null]);
  assert.deepEqual(nums().map(b => b.lastChild.className), ["hb-dot ok", "hb-dot ok", "hb-dot bad"]);
  assert.match(nums()[2].getAttribute("title"), /^Cirrus — Relay: Disconnected · Sessions: Disconnected$/);
  sw.setStatus([{ id: "h2", relay: "connecting", sessions: "open" }]);
  assert.equal(nums()[1].lastChild.className, "hb-dot warn");
  sw.setStatus("garbage"); // ignored
  assert.equal(nums()[1].lastChild.className, "hb-dot warn");
});

test("clicking another number selects it; the lit number and a pending switch do nothing", () => {
  const { nums, calls, state, sw } = make();
  nums()[0].click();
  assert.deepEqual(calls, [], "already lit");
  nums()[1].click();
  assert.deepEqual(calls, [["select", "h2"]]);
  state.pending = true; sw.render();
  assert.equal(nums()[2].getAttribute("aria-disabled"), "true");
  nums()[2].click();
  assert.equal(calls.length, 1, "serialized while a switch is pending");
  state.pending = false; sw.render();
  assert.equal(nums()[2].getAttribute("aria-disabled"), null);
});

test("arrow keys move focus (wrapping), Home/End jump, Enter/Space come from the native button click", () => {
  const { nums, doc, calls } = make();
  nums()[0].focus();
  const key = k => nums()[0].parentNode.fire("keydown", { key: k });
  assert.ok(key("ArrowRight").defaultPrevented);
  assert.equal(doc.activeElement, nums()[1]);
  assert.deepEqual(nums().map(b => b.getAttribute("tabindex")), ["-1", "0", "-1"]);
  key("ArrowRight"); key("ArrowRight");
  assert.equal(doc.activeElement, nums()[0], "wraps");
  key("ArrowLeft");
  assert.equal(doc.activeElement, nums()[2]);
  key("Home"); assert.equal(doc.activeElement, nums()[0]);
  key("End"); assert.equal(doc.activeElement, nums()[2]);
  assert.ok(!key("a").defaultPrevented);
  assert.deepEqual(calls, [], "moving focus never switches");
  assert.equal(nums()[0].tag, "button", "native buttons give Enter and Space");
});

test("Ctrl/Cmd+digit selects host N; Shift, Alt/AltGr, composing and out-of-range digits are left alone", () => {
  const { doc, calls } = make();
  const press = e => doc.key({ key: "2", ctrlKey: true, ...e });
  assert.ok(press({}).defaultPrevented);
  assert.ok(press({ metaKey: true, ctrlKey: false }).defaultPrevented);
  assert.deepEqual(calls, [["select", "h2"], ["select", "h2"]]);
  for (const e of [{ shiftKey: true }, { altKey: true }, { isComposing: true }, { ctrlKey: false }, { key: "9" }, { key: "0" }, { key: "a" }]) assert.ok(!press(e).defaultPrevented, JSON.stringify(e));
  assert.ok(doc.key({ key: "1", ctrlKey: true }).defaultPrevented);
  assert.equal(calls.length, 2, "Ctrl+1 is the lit host: prevented but no switch");
  assert.equal(HS.digitIndex({ key: "3", ctrlKey: true }), 2);
  assert.equal(HS.digitIndex({ key: "3", ctrlKey: true, defaultPrevented: true }), -1);
});

test("Ctrl+digit does nothing while the bar is hidden (one host); destroy removes the listener", () => {
  const one = make({ state: { hosts: [HOSTS[0]] } });
  assert.ok(!one.doc.key({ key: "1", ctrlKey: true }).defaultPrevented);
  const { sw, doc } = make();
  assert.equal(doc.listenerCount("keydown"), 1);
  sw.destroy();
  assert.equal(doc.listenerCount("keydown"), 0);
  assert.equal(sw.root.removed, true);
});

test("split toggle: hidden without setSplit, calls setSplit(!split), lit when split, tooltip flips, errors surface", async () => {
  assert.equal(make({ noSplit: true }).split().hidden, true);
  const { split, calls, sw, doc } = make();
  assert.equal(split().hidden, false);
  assert.equal(split().getAttribute("title"), "Split view");
  assert.equal(split().getAttribute("aria-pressed"), "false");
  split().click(); await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, [["split", true]]);
  assert.equal(split().getAttribute("title"), "Single view");
  assert.equal(split().getAttribute("aria-pressed"), "true");
  assert.equal(split().className, "hb-split lit");
  assert.equal(doc.documentElement.dataset.pane, "left");
  split().click(); await new Promise(r => setImmediate(r));
  assert.deepEqual(calls.at(-1), ["split", false]);
  const bad = make({ ctx: { setSplit: async () => { throw new Error("one host"); } } });
  bad.split().click(); await new Promise(r => setImmediate(r));
  assert.deepEqual(bad.calls, [["error", "Error: one host"]]);
  assert.equal(bad.split().getAttribute("aria-disabled"), null, "the toggle recovers");
});

test("layout drives which number is lit, marks the other pane's host and sets data-pane; no layout means 'full'", () => {
  const { sw, nums, doc, state } = make();
  assert.equal(doc.documentElement.dataset.pane, "full");
  state.active = "h1"; // the saved active host is irrelevant once the page knows its own placement
  sw.setLayout({ split: true, pane: "right", hostId: "h3", panes: [{ side: "left", hostId: "h1" }, { side: "right", hostId: "h3" }] });
  assert.equal(doc.documentElement.dataset.pane, "right");
  assert.deepEqual(nums().map(b => b.className), ["hb-num other", "hb-num", "hb-num lit"]);
  assert.equal(sw.shown(), "h3");
  sw.setLayout({ split: false, pane: "full", hostId: "h2", panes: [{ side: "full", hostId: "h2" }] });
  assert.equal(doc.documentElement.dataset.pane, "full");
  assert.deepEqual(nums().map(b => b.className), ["hb-num", "hb-num lit", "hb-num"]);
  sw.setLayout({ pane: "nonsense", hostId: "h1" });
  assert.equal(doc.documentElement.dataset.pane, "full", "an unknown pane is treated as full");
  sw.setLayout(null); assert.equal(sw.shown(), "h1");
  // the right pane's click on the left pane's host swaps: the lit check uses this pane's host, not the saved active host
  const w = make();
  w.sw.setLayout({ split: true, pane: "right", hostId: "h2", panes: [{ side: "left", hostId: "h1" }, { side: "right", hostId: "h2" }] });
  w.nums()[0].click();
  assert.deepEqual(w.calls, [["select", "h1"]]);
});

test("--hb-half follows the width of the bar so the crumb stops short of the centre", () => {
  const { doc, sw } = make();
  assert.equal(doc.documentElement.style.set.get("--hb-half"), `${(3 * 32 - 6 + 40) / 2}px`);
  const w = make({ noSplit: true });
  assert.equal(w.doc.documentElement.style.set.get("--hb-half"), `${(3 * 32 - 6) / 2}px`);
  assert.ok(sw);
});

test("wiring: module and stylesheet are linked, the old select/status line and title span are gone", () => {
  const html = fs.readFileSync(path.join(RENDERER, "index.html"), "utf8");
  assert.ok(html.indexOf('src="host-switcher.js"') > html.indexOf('src="settings-view.js"') && html.indexOf('src="host-switcher.js"') < html.indexOf('src="app.js"'));
  assert.ok(html.indexOf('href="host-switcher.css"') > html.indexOf('href="shell.css"'));
  const app = fs.readFileSync(path.join(RENDERER, "app.js"), "utf8"), css = fs.readFileSync(path.join(RENDERER, "shell.css"), "utf8");
  for (const gone of ["host-select", "host-status", "host-control", "hostSelect", "hostStatus"]) assert.ok(!app.includes(gone) && !css.includes(gone), gone);
  assert.ok(!/sh-ct/.test(app + css), "the crumb title span is gone");
  // contract calls are feature-detected: a missing one keeps today's single pane
  for (const call of ["deck.hosts?.layout", "deck.hosts?.onLayout", "deck.hosts?.status", "deck.hosts?.setSplit"]) assert.ok(app.includes(call), call);
  assert.ok(/t === "status"/.test(app), "status frames from deck.hosts.onEvent");
  assert.match(css, /html\[data-pane="left"\] \.app \.topbar \{ padding-right: 12px; \}/, "only full and right panes reserve the caption buttons");
});

test("both icon tables carry the split icon", () => {
  const SH = require("../renderer/shell");
  assert.ok(SH.ICONS.split);
  assert.match(fs.readFileSync(path.join(RENDERER, "settings-view.js"), "utf8"), /split: "M2\.5 3\.5h4\.5v9h-4\.5zM9 3\.5h4\.5v9h-4\.5z"/);
  assert.equal(SH.ICONS.split, "M2.5 3.5h4.5v9h-4.5zM9 3.5h4.5v9h-4.5z");
});

test("i18n: hostbar keys exist in both languages with the same placeholders", () => {
  for (const lang of ["en", "tr"]) {
    I18N.setLanguage(lang);
    for (const key of ["hostbar.tip", "hostbar.split", "hostbar.single"]) assert.notEqual(I18N.t(key, { name: "N", relay: "R", sessions: "S" }), key, `${lang} ${key}`);
    assert.match(I18N.t("hostbar.tip", { name: "N", relay: "R", sessions: "S" }), /N.*R.*S/);
  }
  I18N.setLanguage("en");
});

// The real app.js block, run against stubs of the multiview contract (and without it).
function appBlock(deckHosts) {
  const src = fs.readFileSync(path.join(RENDERER, "app.js"), "utf8");
  const a = src.indexOf("  const HSW = window.DeckHostSwitcher.create({"), b = src.indexOf("  /** Show host `id` in this pane.");
  assert.ok(a > 0 && b > a);
  const doc = fakeDoc(), calls = [], handlers = {};
  const crumb = { before: el => calls.push(["mounted", el.id]) };
  const ctx = { window: { DeckHostSwitcher: HS }, document: doc, i18nText: (k, v) => I18N.t(k, v), SH: { icon: (n, s) => ({ icon: n, size: s }) },
    S: { settings: { firstRunDone: true, activeHost: "h1", relay: { url: "ws://r", hasToken: true }, bridge: { mode: "ssh" }, hosts: HOSTS.map(x => ({ ...x })) }, relay: { status: "open" } }, H: { status: { status: "open" } },
    SVM: { connectionState: (c, s) => (!c ? "unconfigured" : s === "open" ? "open" : "saved") }, hostSwitchPending: false, remoteHosts: [], els: { crumb },
    selectHost: id => calls.push(["selectHost", id]), MV: { toast: m => calls.push(["toast", m]) }, cleanErr: String,
    deck: { hosts: deckHosts(calls, handlers) } };
  ctx.document.addEventListener = doc.addEventListener;
  vm.createContext(ctx);
  vm.runInContext(src.slice(a, b) + "\nthis.HSW = HSW; this.renderHosts = renderHosts; this.shownHost = shownHost;", ctx);
  return { ctx, calls, handlers, doc };
}
const tick = () => new Promise(r => setImmediate(r));

test("app.js wiring against the contract: layout, onLayout, status frames, setSplit", async () => {
  const layout = { split: true, pane: "right", hostId: "h2", panes: [{ side: "left", hostId: "h1" }, { side: "right", hostId: "h2" }] };
  const w = appBlock((calls, handlers) => ({
    layout: async () => layout, onLayout: cb => { handlers.layout = cb; }, status: async () => [{ id: "h3", relay: "closed", sessions: "closed" }],
    setSplit: async on => { calls.push(["setSplit", on]); return { ...layout, split: on }; }, onEvent: cb => { handlers.event = cb; },
  }));
  await tick();
  const bar = w.ctx.HSW.root, nums = bar.children[0].children;
  assert.equal(w.ctx.shownHost(), "h2");
  assert.deepEqual([...nums].map(b => b.className), ["hb-num other", "hb-num lit", "hb-num"]);
  assert.equal(nums[2].lastChild.className, "hb-dot bad", "status() colours a host that is not this page's");
  assert.equal(bar.children[1].hidden, false, "setSplit present: the toggle shows");
  w.handlers.layout({ ...layout, split: false, pane: "full", hostId: "h3", panes: [{ side: "full", hostId: "h3" }] });
  assert.equal(w.ctx.shownHost(), "h3");
  assert.equal(w.doc.documentElement.dataset.pane, "full");
  bar.children[1].click(); await tick();
  assert.deepEqual(w.calls.filter(c => c[0] === "setSplit"), [["setSplit", true]]);
  nums[0].click();
  assert.deepEqual(w.calls.filter(c => c[0] === "selectHost"), [["selectHost", "h1"]]);
});

test("app.js wiring without the contract: select only, no split button, today's single pane", async () => {
  const w = appBlock(() => ({ select: async () => {}, onEvent() {} }));
  await tick();
  w.ctx.renderHosts(); // the app's "top" repaint
  const bar = w.ctx.HSW.root;
  assert.equal(bar.hidden, false);
  assert.equal(bar.children[1].hidden, true, "no setSplit: no split button");
  assert.equal(w.ctx.shownHost(), "h1", "the saved active host is the lit one");
  assert.equal(w.doc.documentElement.dataset.pane, "full");
  assert.deepEqual([...bar.children[0].children].map(b => b.lastChild.className), ["hb-dot ok", "hb-dot off", "hb-dot off"], "own host live, the rest unobserved");
});
