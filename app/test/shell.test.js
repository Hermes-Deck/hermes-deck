"use strict";
// The Blend shell (renderer/shell.js): the right-slot model, old tab ids, shortcuts, the channel chip, the sidebar's
// smart filters, the DeckShell mount API on a small fake DOM, and how index.html / app.js wire it in.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const SH = require("../renderer/shell");
const I18N = require("../renderer/i18n");

const RENDERER = path.join(__dirname, "..", "renderer");
const plain = (v) => JSON.parse(JSON.stringify(v));
const vm = require("node:vm");
/** A two-space-indent function of the renderer IIFE, cut out of app.js by brace matching. */
function appFn(name) {
  const src = fs.readFileSync(path.join(RENDERER, "app.js"), "utf8");
  const at = src.indexOf(`  function ${name}(`);
  assert.ok(at >= 0, `${name} found`);
  let depth = 0;
  for (let i = src.indexOf("{", at); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

test("right slot: the Work pane alone, it remembers its tab, toggle closes it, an old kind changes nothing", () => {
  assert.deepEqual(SH.KINDS, ["work"], "the Inspector is gone");
  let r = { kind: null, last: { ...SH.DEFAULT_TAB } };
  assert.equal(r.last.work, "run", "a fresh profile opens Run");
  r = SH.nextRight(r, "open", "work", "session");
  assert.deepEqual(plain(r), { kind: "work", last: { work: "session" } });
  r = SH.nextRight(r, "toggle", "work");
  assert.equal(r.kind, null, "toggling the open kind closes the slot");
  assert.equal(r.last.work, "session", "the pane keeps its tab for next time");
  r = SH.nextRight(r, "toggle", "work", "screen");
  assert.deepEqual([r.kind, r.last.work], ["work", "screen"]);
  assert.equal(SH.nextRight(r, "toggle", "work", "plan").kind, "work", "a toggle with a tab opens that tab");
  assert.equal(SH.nextRight(r, "open", "inspector", "usage").kind, "work", "the removed Inspector kind changes nothing");
  assert.equal(SH.nextRight(r, "open", "bogus").kind, "work", "an unknown kind changes nothing");
  assert.equal(SH.nextRight(r, "close").kind, null);
});

test("old right-panel tab ids route into the Work pane or the Usage view", () => {
  assert.deepEqual(SH.legacyTab("activity"), ["work", "session"], "Activity became Work › Session");
  assert.deepEqual(SH.legacyTab("session"), ["work", "session"], "Inspector › Session is Work › Session");
  assert.deepEqual(SH.legacyTab("fleet"), ["main", "usage"], "Fleet opens the Usage view");
  assert.deepEqual(SH.legacyTab("tokens"), ["main", "usage"], "Token opens the Usage view");
  assert.deepEqual(SH.legacyTab("usage"), ["main", "usage"], "Inspector › Usage is the Usage view");
  assert.deepEqual(SH.legacyTab("workspace"), ["work", "browser"]);
  assert.deepEqual(SH.legacyTab("screen"), ["work", "screen"]);
  assert.deepEqual(SH.legacyTab("plan"), ["work", "plan"]);
  assert.equal(SH.legacyTab("settings"), null, "Settings is its own view, not a tab");
  assert.equal(SH.legacyTab("__proto__"), null);
  assert.equal(SH.pickTab("screen", ["run", "browser"]), "run", "a hidden tab falls back to the first visible one");
  assert.deepEqual(SH.sortTabs("work", ["custom", "screen", "run", "browser", "session"]), ["session", "run", "browser", "screen", "custom"], "Session is the first tab");
});

test("stored right-slot state: an old Inspector comes back as Work › Session or the Usage view", () => {
  const from = (o) => SH.restoreRight((k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null));
  assert.deepEqual(plain(from({})), { kind: null, last: { work: "run" }, view: null }, "fresh profile: closed, Run remembered");
  assert.deepEqual(plain(from({ "deck.right": "work", "deck.wtab": "plan" })), { kind: "work", last: { work: "plan" }, view: null });
  assert.deepEqual(plain(from({ "deck.right": "", "deck.wtab": "diff" })), { kind: null, last: { work: "diff" }, view: null });
  assert.deepEqual(plain(from({ "deck.right": "inspector", "deck.itab": "session", "deck.wtab": "run" })), { kind: "work", last: { work: "session" }, view: null });
  assert.deepEqual(plain(from({ "deck.right": "inspector", "deck.itab": "activity" })), { kind: "work", last: { work: "session" }, view: null });
  assert.deepEqual(plain(from({ "deck.right": "inspector", "deck.itab": "usage", "deck.wtab": "agents" })), { kind: null, last: { work: "agents" }, view: "usage" });
  assert.deepEqual(plain(from({ "deck.right": "inspector", "deck.itab": "nonsense" })), { kind: "work", last: { work: "session" }, view: null });
  assert.deepEqual(plain(from({ "deck.panelClosed": "0", "deck.tab": "fleet" })), { kind: null, last: { work: "run" }, view: "usage" }, "pre-Blend Fleet");
  assert.deepEqual(plain(from({ "deck.panelClosed": "0", "deck.tab": "activity" })), { kind: "work", last: { work: "session" }, view: null }, "pre-Blend Activity");
  assert.deepEqual(plain(from({ "deck.right": "bogus" })), { kind: null, last: { work: "run" }, view: null });
});

test("shortcuts: Ctrl/Cmd+\\ work pane, Ctrl/Cmd+Alt+I its Session tab, Ctrl/Cmd+B sidebar, Ctrl/Cmd+J fleet", () => {
  const k = (key, mods = {}) => SH.keyAction({ key, ctrlKey: true, ...mods });
  assert.equal(k("\\"), "work");
  assert.equal(k("\\", { altKey: true }), "work", "AltGr layouts (Ctrl+Alt) still reach the work pane");
  assert.equal(SH.keyAction({ key: "\\", metaKey: true }), "work", "Cmd on macOS");
  assert.equal(k("i", { altKey: true }), "session");
  assert.equal(k("ı", { altKey: true, code: "KeyI" }), "session", "Turkish keyboard: the key's code counts");
  assert.equal(k("b"), "sidebar");
  assert.equal(k("j"), "fleet");
  assert.equal(k("i"), null, "plain Ctrl+I is left to the page");
  assert.equal(k("b", { shiftKey: true }), null);
  assert.equal(SH.keyAction({ key: "b" }), null, "no modifier, no action");
  assert.equal(k("b", { isComposing: true }), null);
});

test("channel chip: computed from the mode and the session, never from free text", () => {
  const label = (o) => { const c = SH.channelOf(o); return I18N.t(c.key, c.vars); };
  assert.equal(label({ mode: "sessions" }), "Hermes");
  assert.equal(label({ mode: "telegram" }), "Telegram");
  assert.equal(label({ mode: "sessions", readOnly: true, source: "telegram" }), "Telegram · read-only");
  assert.equal(label({ mode: "sessions", readOnly: true, source: "discord" }), "Discord · read-only");
  assert.equal(label({ mode: "bots" }), "Bot Chat");
  assert.equal(label({ mode: "bots", subagent: true }), "Sub-agent", "a sub-agent chat steers it, whatever the mode");
  assert.equal(SH.channelOf({ mode: "sessions", subagent: true }).id, "sub");
  I18N.setLanguage("tr");
  try {
    assert.equal(label({ mode: "sessions", readOnly: true, source: "telegram" }), "Telegram · salt okunur");
  } finally {
    I18N.setLanguage("en");
  }
});

test("smart filters: needs you, running, waiting (nothing for you), today, pinned", () => {
  assert.deepEqual(SH.FILTERS, ["needs", "all", "running", "waiting", "today", "pinned"]);
  const now = Date.UTC(2026, 9, 8, 12) / 1000;
  const f = { needs: 0, live: true, waiting: false, pinned: false, updatedAt: now - 60 };
  assert.equal(SH.matchFilter("all", f, now), true);
  assert.equal(SH.matchFilter("running", f, now), true);
  assert.equal(SH.matchFilter("needs", f, now), false);
  assert.equal(SH.matchFilter("needs", { ...f, needs: 2 }, now), true);
  assert.equal(SH.matchFilter("waiting", { ...f, waiting: true }, now), true);
  assert.equal(SH.matchFilter("waiting", { ...f, waiting: true, needs: 1 }, now), false, "an approval is Needs you, not Waiting");
  assert.equal(SH.matchFilter("today", f, now), true);
  assert.equal(SH.matchFilter("today", { ...f, updatedAt: now - 3 * 86400 }, now), false);
  assert.equal(SH.matchFilter("today", { ...f, updatedAt: 0 }, now), false);
  assert.equal(SH.matchFilter("pinned", { ...f, pinned: true }, now), true);
  assert.equal(SH.matchFilter("all", null, now), false);
});

// ---------------------------------------------------------------- a small fake DOM for the mount API
function fakeDom(ids) {
  const listeners = new Map();
  const make = (tag) => {
    const el = {
      tagName: tag.toUpperCase(), children: [], attrs: {}, dataset: {}, style: { setProperty() {} }, hidden: false, textContent: "",
      scrollTop: 0, listeners: {}, className: "", parentNode: null,
      classList: { set: new Set(), toggle(c, on) { if (on === undefined ? !this.set.has(c) : on) this.set.add(c); else this.set.delete(c); }, add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
      appendChild(c) { if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
      append(...cs) { for (const c of cs) this.appendChild(typeof c === "string" ? { text: c } : c); },
      prepend(c) { this.children.unshift(c); },
      replaceChildren(...cs) { this.children = []; for (const c of cs) this.appendChild(c); },
      get firstChild() { return this.children[0] || null; },
      addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
      querySelector() { return null; }, getBoundingClientRect: () => ({ width: 1440, left: 0, right: 1440 }),
      focus() {},
    };
    return el;
  };
  const byId = new Map(ids.map((id) => [id, Object.assign(make("div"), { id })]));
  const doc = {
    body: make("body"), documentElement: make("html"),
    getElementById: (id) => byId.get(id) || null,
    createElement: make, createElementNS: (_ns, tag) => make(tag), createTextNode: (text) => ({ text }),
    querySelector: () => null,
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
    fire: (t, e) => (listeners.get(t) || []).forEach((fn) => fn(e)),
  };
  const mem = new Map();
  const win = { localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) }, innerWidth: 1440, addEventListener() {}, navigator: { platform: "Linux" }, console };
  return { doc, win, byId, mem };
}
const IDS = ["app", "side", "topbar", "chat", "inbox", "right", "work", "work-tabs", "work-body", "gutter-left", "gutter-right",
  "side-open", "side-close", "work-btn", "work-close", "capsule", "timeline", "composer-status", "crumb-extra", "side-extra", "find-btn", "find-kbd"];

test("DeckShell API: register tabs, open/close the right slot, events, live dots, slots, inbox stub", () => {
  const { doc, win, byId, mem } = fakeDom(IDS);
  const api = SH.create(doc, win);
  const events = [];
  api.on("right", (r) => events.push(["right", r.kind, r.tab]));
  api.on("main", (m) => events.push(["main", m.kind]));
  assert.deepEqual(plain(api.right()), { kind: null, tab: null }, "the right slot starts closed");
  assert.equal(byId.get("right").hidden, true);
  assert.equal(api.registerInspectorTab, undefined, "no Inspector registration left");

  let renders = 0;
  api.registerWorkTab("run", { title: "Run", render: (el) => { renders++; el.replaceChildren(doc.createTextNode("runs")); } });
  api.openRight("work");
  assert.deepEqual(plain(api.right()), { kind: "work", tab: "run" });
  assert.equal(byId.get("right").hidden, false);
  assert.equal(byId.get("work").hidden, false);
  assert.equal(renders, 1, "the module's renderer replaced the shell's empty state");
  assert.equal(mem.get("deck.right"), "work", "the open kind is remembered");

  api.registerWorkTab("session", { title: "Session", render: (el) => el.replaceChildren(doc.createTextNode("facts")) });
  assert.deepEqual(byId.get("work-tabs").children.map((b) => b.dataset.tab), ["session", "run", "plan", "diff", "agents"], "Session is the first tab");
  api.openRight("inspector", "session");
  assert.deepEqual(plain(api.right()), { kind: "work", tab: "run" }, "the removed Inspector kind changes nothing");
  api.openRight("work", "session");
  assert.deepEqual(events.filter((e) => e[0] === "right").map((e) => e.slice(1)), [["work", "run"], ["work", "session"]]);

  // weak registration (app.js defaults) never replaces a module's own tab
  assert.equal(api.registerWorkTab("run", { weak: true, render() { throw new Error("must not run"); } }), false);
  api.setTabLive("run", true);
  api.openRight("work", "run");
  const tab = byId.get("work-tabs").children.find((b) => b.dataset.tab === "run");
  assert.ok(tab.className.includes("lv"), "a live tab carries its dot");
  assert.equal(tab.attrs["aria-selected"], "true");

  // a failing tab renderer shows an empty state instead of breaking the shell
  api.registerWorkTab("diff", { title: "Diff", render() { throw new Error("boom"); } });
  const errors = console.error;
  console.error = () => {};
  try { api.openRight("work", "diff"); } finally { console.error = errors; }
  assert.equal(api.right().tab, "diff");

  // only the shown tab's pane is attached: a module root elsewhere is disconnected and stops its live view
  assert.deepEqual(byId.get("work-body").children.map((p) => p.dataset.tab), ["diff"]);
  api.openRight("work", "run");
  assert.deepEqual(byId.get("work-body").children.map((p) => p.dataset.tab), ["run"]);
  assert.equal(byId.get("work-body").children[0].children[0].text, "runs", "a tab's content survives being detached");

  api.closeRight();
  assert.equal(byId.get("right").hidden, true);
  assert.equal(byId.get("work-body").children.length, 0, "a closed slot holds no live module");

  // slots
  const capsule = { tagName: "DIV", parentNode: null };
  assert.equal(api.mount("capsule", capsule), byId.get("capsule"));
  assert.equal(byId.get("capsule").children[0], capsule);
  assert.throws(() => api.mount("nowhere", capsule), /unknown slot/);
  api.mount("timeline", capsule);
  assert.equal(byId.get("timeline").hidden, false, "a filled slot shows");
  api.mount("timeline", null);
  assert.equal(byId.get("timeline").hidden, true);

  // main area: chat or the inbox (stub until a module mounts its own)
  api.publish("needs", { count: 2 });
  api.setMain("inbox");
  assert.equal(byId.get("app").dataset.main, "inbox");
  assert.equal(byId.get("inbox").children.length, 1, "the inbox shows its empty state");
  api.setMain("chat");
  assert.deepEqual(events.filter((e) => e[0] === "main"), [["main", "inbox"], ["main", "chat"]]);

  // session events: sent on change only; a throwing listener never breaks the others
  const seen = [];
  api.on("session", () => { throw new Error("bad listener"); });
  api.on("session", (s) => seen.push(s.id));
  console.error = () => {};
  try {
    api.publish("session", { id: "a", channel: "hermes" });
    api.publish("session", { id: "a", channel: "hermes" });
    api.publish("session", { id: "b", channel: "telegram" });
  } finally { console.error = errors; }
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(api.last("session").id, "b", "late subscribers can read the last value");

  // services: what app.js shares with later modules
  const got = [];
  api.on("service", (e) => got.push(e.name));
  assert.equal(api.service("workspace"), null);
  const ws = { root: {} };
  api.provide("workspace", ws);
  assert.equal(api.service("workspace"), ws);
  assert.deepEqual(got, ["workspace"]);
});

test("DeckShell keys: Ctrl+\\ toggles the work pane, Ctrl+Alt+I its Session tab, Ctrl+B the sidebar; first run locks the right slot", () => {
  const { doc, win, byId } = fakeDom(IDS);
  const api = SH.create(doc, win);
  api.registerWorkTab("session", { render() {} });
  const key = (k, mods = {}) => doc.fire("keydown", { key: k, ctrlKey: true, preventDefault() {}, ...mods });
  key("\\");
  assert.deepEqual(plain(api.right()), { kind: "work", tab: "run" }, "a fresh profile opens Run");
  key("i", { altKey: true, code: "KeyI" });
  assert.deepEqual(plain(api.right()), { kind: "work", tab: "session" }, "Ctrl+Alt+I lands on Work › Session");
  key("i", { altKey: true, code: "KeyI" });
  assert.equal(api.right().kind, null, "again: closes the pane");
  key("i", { altKey: true, code: "KeyI" });
  assert.deepEqual(plain(api.right()), { kind: "work", tab: "session" }, "from closed: opens on Session");
  api.openRight("work", "plan");
  key("i", { altKey: true, code: "KeyI" });
  assert.deepEqual(plain(api.right()), { kind: "work", tab: "session" }, "from another Work tab: switches to Session");
  key("\\");
  assert.equal(api.right().kind, null);
  key("b");
  assert.equal(api.sidebarHidden(), true);
  assert.equal(byId.get("app").classList.contains("side-hidden"), true);
  key("b");
  assert.equal(api.sidebarHidden(), false);
  key("i", { altKey: true, code: "KeyI" });
  api.setLocked(true);
  assert.equal(byId.get("right").hidden, true, "first run: no right slot");
  key("\\");
  key("i", { altKey: true, code: "KeyI" });
  assert.deepEqual(plain(api.right()), { kind: "work", tab: "session" }, "locked: the shortcuts change nothing");
  api.setLocked(false);
  assert.equal(byId.get("right").hidden, false);
});

test("Ctrl+J: the fleet panel when it listens, else the Usage view through the usageView service", () => {
  const { doc, win } = fakeDom(IDS);
  const api = SH.create(doc, win);
  const key = () => doc.fire("keydown", { key: "j", ctrlKey: true, preventDefault() {} });
  let toggles = 0;
  key(); // nothing provides a Usage view yet: a no-op, never an Inspector
  assert.equal(api.right().kind, null);
  api.provide("usageView", { toggle: () => { toggles++; } });
  key();
  assert.equal(toggles, 1, "no fleet listener: the Usage view toggles");
  assert.equal(api.right().kind, null, "the right slot is untouched");
  let fleet = 0;
  const off = api.on("fleet", () => { fleet++; });
  key();
  assert.deepEqual([fleet, toggles], [1, 1], "the fleet panel wins while it listens");
  off();
  key();
  assert.equal(toggles, 2);
});

test("a stored Inspector state migrates once: Session -> Work › Session, Usage -> the Usage view", () => {
  const session = fakeDom(IDS);
  session.mem.set("deck.right", "inspector");
  session.mem.set("deck.itab", "session");
  session.mem.set("deck.wtab", "run");
  const a = SH.create(session.doc, session.win);
  a.registerWorkTab("session", { render() {} });
  assert.deepEqual(plain(a.right()), { kind: "work", tab: "session" });
  assert.equal(a.takeView(), null);
  assert.equal(session.mem.get("deck.right"), "work", "the new state is written at once, so the next start reads it");
  assert.equal(session.mem.get("deck.wtab"), "session");

  const usage = fakeDom(IDS);
  usage.mem.set("deck.right", "inspector");
  usage.mem.set("deck.itab", "usage");
  usage.mem.set("deck.wtab", "agents");
  const b = SH.create(usage.doc, usage.win);
  assert.equal(b.right().kind, null, "the right slot stays closed");
  assert.equal(b.takeView(), "usage", "app.js opens the Usage view");
  assert.equal(b.takeView(), null, "handed out once");
  assert.equal(usage.mem.get("deck.right"), "");
  assert.equal(usage.mem.get("deck.wtab"), "agents", "the Work tab is kept");
  const again = SH.create(usage.doc, usage.win);
  assert.equal(again.takeView(), null, "the next start does not reopen it");
});

test("an old open right panel comes back as the matching right-slot tab", () => {
  const { doc, win, mem } = fakeDom(IDS);
  mem.set("deck.panelClosed", "0");
  mem.set("deck.tab", "workspace");
  const api = SH.create(doc, win);
  api.registerWorkTab("browser", { render() {} });
  assert.deepEqual(plain(api.right()), { kind: "work", tab: "browser" });
  const closed = fakeDom(IDS);
  closed.mem.set("deck.panelClosed", "1");
  assert.equal(SH.create(closed.doc, closed.win).right().kind, null);
});

test("wiring: index.html has the Blend frame and every slot; scripts load in order; no inline style or script", () => {
  const html = fs.readFileSync(path.join(RENDERER, "index.html"), "utf8");
  for (const id of ["app", "side", "modes", "rail", "side-foot", "conn", "topbar", "crumb", "capsule", "find-btn", "work-btn",
    "chat", "inbox", "timeline", "composer-status", "right", "work", "work-tabs", "work-body", "msgs", "input", "send", "detail"]) {
    assert.ok(html.includes(`id="${id}"`), `#${id}`);
  }
  for (const gone of ["insp", "insp-btn", "insp-tabs", "insp-body", "insp-close"]) assert.ok(!html.includes(`id="${gone}"`), `#${gone} is gone with the Inspector`);
  assert.ok(!/shell\.(inspector|inspectorTip|closeInspector)/.test(html), "no removed Inspector labels");
  assert.ok(html.indexOf('src="shell.js"') > html.indexOf('src="i18n.js"') && html.indexOf('src="shell.js"') < html.indexOf('src="app.js"'));
  assert.ok(html.indexOf('src="human.js"') < html.indexOf('src="app.js"') && html.indexOf('src="human.js"') < html.indexOf('src="work-pane.js"'), "readable numbers load before their users");
  assert.ok(html.indexOf('src="usage-detail.js"') > 0 && html.indexOf('src="usage-detail.js"') < html.indexOf('src="app.js"'), "the Usage view loads before app.js");
  for (const lane of ["b", "d", "e"]) {
    assert.ok(html.indexOf(`src="i18n-${lane}.js"`) > html.indexOf('src="i18n.js"') && html.indexOf(`src="i18n-${lane}.js"`) < html.indexOf('src="shell.js"'), `i18n-${lane}.js`);
  }
  assert.ok(html.indexOf('href="shell.css"') > html.indexOf('href="think-block.css"'), "shell.css comes last: it restyles module containers");
  assert.ok(!/\sstyle=/.test(html), "no inline style attributes");
  assert.ok(!/<script>/.test(html), "no inline scripts");
  assert.ok(!/https?:\/\//.test(html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, "")), "no remote URLs");
  const app = fs.readFileSync(path.join(RENDERER, "app.js"), "utf8");
  assert.match(app, /const SH = window\.DeckShell;/);
  assert.ok(!/togglePanel|toggleCompact|panel-closed|"panel-open"/.test(app), "the old panel toggle and compact rail are gone");
  assert.match(app, /SH\.registerWorkTab\("browser"/, "Workspace mounts as the work pane's Browser tab");
  assert.match(app, /SH\.registerWorkTab\("screen"/, "Bot screen mounts as the work pane's Screen tab");
  assert.match(app, /SH\.registerWorkTab\("session"/, "Session is a Work pane tab");
  assert.ok(!/registerInspectorTab|isOpen\("inspector"/.test(app), "nothing in app.js still reaches for the Inspector");
  assert.match(app, /SH\.provide\("usageView"/, "the Usage view is a shared service (Ctrl+J fallback, fleet panel)");
  assert.match(app, /SH\.provide\("relaySession"/, "work-pane.js reads a child's relay session through a service");
  assert.match(app, /isOpen: \(\) => UD\.isOpen\(\)/, "token refreshes follow the Usage view's open state");
});

test("app.js setTab: old ids reach Work › Session or the Usage view (--tab=usage|fleet|tokens|session|activity)", () => {
  const calls = [];
  const SVM = require("../renderer/settings-view");
  const make = new Function("SVM", "SH", "UD", "openSettings", "screenState", `${appFn("setTab")}; return setTab;`);
  const setTab = make(SVM, { legacyTab: SH.legacyTab, openRight: (k, t) => calls.push(["right", k, t]) }, { open: () => calls.push(["usage"]) },
    () => calls.push(["settings"]), () => null);
  for (const id of ["usage", "fleet", "tokens", "session", "activity", "plan", "settings", "bogus"]) setTab(id);
  assert.deepEqual(calls, [["usage"], ["usage"], ["usage"], ["right", "work", "session"], ["right", "work", "session"], ["right", "work", "plan"], ["settings"], ["right", "work", "session"]]);
});

test("fonts: Geist, Geist Mono and Newsreader come from @fontsource through copy-fonts.js, never a CDN", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "copy-fonts.js"), "utf8");
  for (const pkg of ["@fontsource/geist", "@fontsource/geist-mono", "@fontsource-variable/newsreader"]) assert.ok(src.includes(`"${pkg}"`), pkg);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  for (const name of ["@fontsource/geist", "@fontsource/geist-mono", "@fontsource-variable/newsreader"]) assert.ok(pkg.devDependencies[name], name);
  const css = fs.readFileSync(path.join(RENDERER, "styles.css"), "utf8") + fs.readFileSync(path.join(RENDERER, "shell.css"), "utf8");
  assert.ok(!/https?:\/\//.test(css), "no remote stylesheet or font URL");
  assert.match(css, /--body: "Geist"/);
  assert.match(css, /--mono: "Geist Mono"/);
  assert.match(css, /--display: "Newsreader"/);
  const html = fs.readFileSync(path.join(RENDERER, "index.html"), "utf8");
  assert.match(html, /font-src 'self'/, "CSP unchanged: fonts only from the app itself");
});

test("shell strings exist in English and Turkish; lane string files extend without clashes", () => {
  const keys = Object.keys(I18N.tables.en).filter((k) => k.startsWith("shell."));
  assert.ok(keys.length >= 50);
  for (const k of keys) assert.equal(typeof I18N.tables.tr[k], "string", k);
  const used = new Set();
  for (const f of ["shell.js", "app.js", "index.html"]) {
    for (const [, k] of fs.readFileSync(path.join(RENDERER, f), "utf8").matchAll(/["`](shell\.[a-zA-Z.]+[a-zA-Z])[`"]/g)) if (!/\.(js|css)$/.test(k)) used.add(k);
  }
  for (const k of used) {
    if (k === "shell.view" || k.endsWith(".")) continue;
    assert.ok(k in I18N.tables.en, `missing key ${k}`);
  }
  for (const v of SH.FILTERS) assert.ok(`shell.view.${v}` in I18N.tables.en, v);
  for (const lane of ["b", "d", "e"]) {
    const strings = require(`../renderer/i18n-${lane}.js`);
    assert.deepEqual(Object.keys(strings.en).sort(), Object.keys(strings.tr).sort(), `i18n-${lane}.js: same keys in en and tr`);
    for (const k of Object.keys(strings.en)) assert.ok(!(k in I18N.tables.en), `i18n-${lane}.js: ${k} already exists`);
  }
});

test("sidebar filters keep a parent of a matching sub-agent, survive parent cycles, and do nothing when unfiltered", () => {
  const node = (sid, extra = {}) => ({ sid, profile: "default", source: "deck", ...extra });
  const nodes = [node("root"), node("kid", { parent: "root", source: "subagent" }), node("other"), node("a", { parent: "b" }), node("b", { parent: "a" })];
  const ctx = { SH, H: { nodes: new Map(nodes.map((n) => [n.sid, n])) }, isSubagent: (n) => !!n.parent || n.source === "subagent",
    window: { DeckSessions: require("../renderer/sessions-browser") }, sidebarSources: null,
    rail: { view: "all", source: "all", agent: null } };
  vm.createContext(ctx);
  vm.runInContext(appFn("railScope") + "\n" + appFn("railFilter"), ctx);
  const facts = new Map(nodes.map((n) => [n.sid, { live: n.sid === "kid", needs: 0, profile: n.profile, source: n.source }]));
  assert.equal(ctx.railFilter(facts), null, "no filter: the list is not walked at all");
  ctx.rail.view = "running";
  const keep = ctx.railFilter(facts);
  assert.deepEqual(nodes.filter(keep).map((n) => n.sid), ["root", "kid"], "the running sub-agent keeps its parent in view");
  assert.equal(keep(ctx.H.nodes.get("a")), false, "a parent cycle ends instead of recursing forever");
});
