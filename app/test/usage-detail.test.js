"use strict";
// The Usage view (renderer/usage-detail.js) and its entry in the fleet panel: opened from "Usage details", mounted over
// the chat column with the existing Usage renderers, closed by Back or Escape.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const UD = require("../renderer/usage-detail");
const F = require("../renderer/fleet-capsule");
const I18N = require("../renderer/i18n");

function fakeDoc() {
  const listeners = new Map();
  const doc = {
    activeElement: null,
    addEventListener: (t, fn) => listeners.set(t, fn), removeEventListener: (t) => listeners.delete(t),
    fire: (t) => listeners.get(t)?.(),
  };
  const h = (tag, attrs, ...kids) => {
    const node = {
      tag, attrs: attrs || {}, hidden: !!(attrs && attrs.hidden), children: kids.flat(Infinity).filter((x) => x != null), parentNode: null, isConnected: true,
      scrollTop: 0, textContent: "", listeners: new Map(),
      replaceChildren(...cs) { this.children = cs; },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
      addEventListener(t, fn) { this.listeners.set(t, fn); },
      focus() { doc.activeElement = this; },
    };
    return node;
  };
  const chat = h("main");
  return { doc, h, chat };
}

test("Usage view: opens over the chat with the existing renderers, Back and Escape return, refresh keeps the scroll", () => {
  I18N.setLanguage("en");
  const { doc, h, chat } = fakeDoc();
  const composer = h("textarea");
  composer.focus();
  let fills = 0, ready = false;
  const toggles = [];
  const view = UD.create({ h, doc, t: I18N.t, host: () => chat, canOpen: () => ready, onToggle: (open) => toggles.push(open),
    fill: (kids) => { fills++; kids.push(h("h2", { class: "section-h" }, "Quotas"), h("p", null, `figures ${fills}`)); } });
  assert.equal(view.open(), false, "first run: no Usage view");
  assert.equal(view.root, null);
  ready = true;
  assert.equal(view.open(), true);
  assert.equal(view.isOpen(), true);
  assert.equal(view.root.parentNode, chat, "mounted in the chat column, like Settings");
  assert.equal(view.root.hidden, false);
  assert.equal(view.root.attrs.role, "region");
  const [head, body] = view.root.children;
  const [back, title] = head.children;
  assert.equal(title.textContent, "Usage");
  assert.equal(back.textContent, "‹ Back");
  assert.equal(doc.activeElement, back, "focus moves into the view, so Escape reaches it");
  assert.equal(fills, 1, "the existing Usage renderers fill it");
  body.scrollTop = 240;
  view.refresh();
  assert.equal(fills, 2);
  assert.equal(body.scrollTop, 240, "a live refresh keeps the reader's place");
  back.attrs.onclick();
  assert.equal(view.isOpen(), false);
  assert.equal(view.root.hidden, true);
  assert.equal(doc.activeElement, composer, "Back returns focus to where it was");
  view.refresh();
  assert.equal(fills, 2, "a closed view draws nothing");

  view.open();
  let prevented = false;
  view.root.listeners.get("keydown")({ key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(view.isOpen(), false, "Escape closes it");
  assert.ok(prevented);
  view.open();
  view.root.listeners.get("keydown")({ key: "Escape", isComposing: true, preventDefault() {} });
  assert.equal(view.isOpen(), true, "Escape while composing text is left alone");
  assert.equal(view.toggle(), false);
  assert.equal(view.toggle(), true);
  view.close(false);
  assert.deepEqual(toggles, [true, false, true, false, true, false, true, false]);
  I18N.setLanguage("tr");
  try { view.open(); assert.equal(view.root.children[0].children[1].textContent, "Kullanım"); }
  finally { I18N.setLanguage("en"); }
  view.dispose();
  assert.equal(chat.children.length, 0);
});

test("Usage view: a failing renderer shows its error inside the view instead of breaking the app", () => {
  const { doc, h, chat } = fakeDoc();
  const view = UD.create({ h, doc, t: I18N.t, host: () => chat, fill: () => { throw new Error("relay gone"); } });
  view.open();
  const inner = view.root.children[1].children[0];
  assert.equal(inner.children[0].attrs.role, "alert");
  assert.equal(inner.children[0].children[0], "relay gone");
  view.dispose();
});

test("fleet panel: a titled Usage details row with a chevron opens the Usage view and steps aside", (t) => {
  const { dom } = require("./inbox-dom-helper"), { createStore } = require("../renderer/inbox");
  const { h, doc, win, walk } = dom();
  const store = createStore();
  store.feedRelay({ t: "snapshot", agents: { Primary: { name: "Primary", profile: "default", today: { usd: 1, n: 2, in: 10, out: 5 } } }, sessions: [] });
  let opened = 0;
  const fleet = F.createFleet({ h, doc, win, store, t: I18N.t, usage: require("../renderer/usage-view"), shell: { openRight() {} }, openChat() {}, selectAgent() {},
    openUsage: () => { opened++; } });
  t.after(() => fleet.destroy());
  fleet.toggle();
  const row = walk(fleet.panel).find((x) => x.attrs?.class === "tf-usage");
  assert.ok(row, "the entry is in the today / quota section");
  assert.equal(row.tag, "button");
  assert.match(row.attrs.title, /Quotas, today and token history/);
  assert.equal(row.children[0].children[0], "Usage details");
  assert.equal(row.children[1].attrs.class, "tf-chev", "a chevron says it opens something");
  const kids = fleet.panel.children.map((x) => x.attrs?.class);
  assert.ok(kids.indexOf("tf-usage") === kids.indexOf("tf-today") - 1, "the row heads today's figures");
  row.click();
  assert.equal(opened, 1);
  assert.equal(fleet.button.attrs["aria-expanded"], "false", "the popover closes");
  const bare = F.createFleet({ h, doc, win, store, t: I18N.t, usage: require("../renderer/usage-view"), shell: { openRight() {} }, openChat() {}, selectAgent() {} });
  bare.toggle();
  assert.equal(walk(bare.panel).filter((x) => x.attrs?.class === "tf-usage").length, 0, "no view to open: no dead row");
  bare.destroy();
});

test("fleet boot wires Usage details to the app's usageView service", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../renderer/fleet-capsule.js"), "utf8");
  assert.match(src, /openUsage: \(\) => shell\.service\("usageView"\)\?\.open\(\)/);
});
