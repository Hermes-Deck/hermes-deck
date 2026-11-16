"use strict";
// Find in the open chat (chat-find.js): matching over the drawn transcript, stepping, and searching earlier pages.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const CF = require("../renderer/chat-find");
const I = require("../renderer/i18n");
I.extend(require("../renderer/i18n-b"));

// a small DOM: elements with a tag, classes and children; text nodes with `data`
const BLOCKS = new Set("p,li,td,th,pre,h1,h2,h3,h4,h5,h6,blockquote,summary,button,figcaption,dt,dd,div".split(","));
function el(tag, attrs, ...kids) {
  const node = { tag, attrs: attrs || {}, kids: [], parentElement: null, listeners: {}, hidden: !!(attrs && attrs.hidden), disabled: false, textContent: "", value: "",
    classList: { set: new Set(String((attrs && attrs.class) || "").split(" ").filter(Boolean)), toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    appendChild(k) { k.parentElement = node; node.kids.push(k); return k; },
    addEventListener(type, fn) { (node.listeners[type] ||= []).push(fn); },
    fire(type, e = {}) { for (const fn of node.listeners[type] || []) fn({ preventDefault() {}, stopPropagation() {}, ...e }); },
    closest(sel) {
      for (let n = node; n; n = n.parentElement) {
        for (const part of sel.split(",")) {
          if (part === "[hidden]" ? n.hidden : part[0] === "." ? n.classList.set.has(part.slice(1)) : n.tag === part) return n;
        }
      }
      return null;
    },
    scrollIntoView() { node.scrolled = (node.scrolled || 0) + 1; }, focus() { node.focused = true; }, select() {} };
  for (const [k, v] of Object.entries(attrs || {})) if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) node.appendChild(typeof k === "string" ? { data: k, parentElement: null } : k);
  return node;
}
const textNodes = (n) => n.kids.flatMap((k) => (k.data !== undefined ? [k] : textNodes(k)));
const doc = { listeners: {}, createTreeWalker: (rootEl) => { const all = textNodes(rootEl); let i = -1; return { nextNode: () => all[++i] || null }; },
  createRange: () => ({ setStart(n, o) { this.s = [n, o]; }, setEnd(n, o) { this.e = [n, o]; } }),
  addEventListener(type, fn) { (doc.listeners[type] ||= []).push(fn); } };
const cut = (m) => {
  // the matched text, read back through the nodes
  const all = [];
  let n = m.startNode;
  const order = textNodes(top(m.startNode));
  for (let i = order.indexOf(n); i < order.length; i++) {
    const t = order[i], from = t === m.startNode ? m.startOffset : 0, to = t === m.endNode ? m.endOffset : t.data.length;
    all.push(t.data.slice(from, to));
    if (t === m.endNode) break;
  }
  return all.join("");
};
const top = (t) => { let n = t.parentElement; while (n.parentElement) n = n.parentElement; return n; };

test("folding ignores case and the Turkish dotted/dotless i, and keeps offsets", () => {
  assert.equal(CF.fold("İstanbul IŞIK ısı"), "istanbul işik isi");
  assert.equal(CF.fold("Straße").length, "Straße".length);
  assert.deepEqual(CF.offsets("aaaa", "aa"), [0, 2], "matches do not overlap");
  assert.deepEqual(CF.offsets("abc", ""), []);
  assert.equal(CF.offsets("a".repeat(50), "a", 7).length, 7);
});

test("matches: across formatting inside a block, not across blocks, not in hidden or own UI", () => {
  const inner = el("div", { class: "msgs-inner" },
    el("div", { class: "msg" },
      el("p", null, "Run ", el("code", null, "workers/", el("wbr"), "playbooks/", "Release.yaml"), " then ", el("strong", null, "deploy"), "."),
      el("p", null, "Deploy again"),
      el("pre", null, el("code", null, "echo deploy"), el("button", { class: "md-copy" }, "Copy deploy")),
      el("div", { hidden: true }, el("p", null, "deploy in a folded part"))),
    el("div", { class: "msg" }, el("p", null, "end with wor"), el("p", null, "kers")));
  const found = CF.matches(inner, "DEPLOY", doc);
  assert.deepEqual(found.map(cut), ["deploy", "Deploy", "deploy"], "bold text, another paragraph, the code block; not the Copy button, not the hidden part");
  const pathHit = CF.matches(inner, "playbooks/release", doc);
  assert.deepEqual(pathHit.map(cut), ["playbooks/Release"], "a path the renderer split into parts is one match");
  assert.notEqual(pathHit[0].startNode, pathHit[0].endNode);
  assert.deepEqual(CF.matches(inner, "workers", doc).map(cut), ["workers"], "'wor' + 'kers' in two paragraphs is not a match");
  assert.deepEqual(CF.matches(inner, "", doc), []);
});

function make({ pages = [], hasHighlights = true } = {}) {
  const host = el("div", { class: "chat" });
  const scroller = el("div", { class: "msgs" });
  const inner = scroller.appendChild(el("div", { class: "msgs-inner" }));
  const sets = new Map();
  const win = { CSS: hasHighlights ? { highlights: sets } : {}, Highlight: function (...r) { const s = new Set(r); return s; }, getSelection: () => win.selection || "" };
  const loads = [];
  const left = [...pages];
  const cf = CF.create({ h: el, t: I.t, host, scroller, inner, doc, win, frame: (fn) => setImmediate(fn),
    earlier: () => ({ available: left.length > 0, load: async () => { loads.push(1); const p = left.shift(); inner.kids.unshift(p); p.parentElement = inner; } }) });
  const q = (cls) => { const walk = (n) => [n, ...n.kids.filter((k) => k.tag).flatMap(walk)]; return walk(host).find((n) => n.classList.set.has(cls)); };
  const type = (text) => { q("chat-find-input").value = text; q("chat-find-input").fire("input"); };
  return { cf, host, inner, sets, loads, q, type, win, scroller };
}
const msg = (...texts) => el("div", { class: "msg" }, texts.map((t) => el("p", null, t)));
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

test("the bar: opens focused, counts from the newest match, steps both ways and wraps, Esc closes and clears", () => {
  const w = make();
  w.inner.appendChild(msg("first build", "second build"));
  w.inner.appendChild(msg("the build is done"));
  assert.equal(w.q("chat-find").hidden, true);
  w.cf.open();
  assert.equal(w.q("chat-find").hidden, false);
  assert.equal(w.q("chat-find-input").focused, true);
  w.type("BUILD");
  assert.equal(w.q("chat-find-count").textContent, "3 / 3", "the newest match first");
  assert.equal(w.sets.get("deck-find").size, 2);
  assert.equal(w.sets.get("deck-find-current").size, 1);
  w.q("chat-find").fire("keydown", { key: "Enter" });
  assert.equal(w.q("chat-find-count").textContent, "2 / 3", "Enter: the match before");
  w.q("chat-find").fire("keydown", { key: "Enter", shiftKey: true });
  w.q("chat-find").fire("keydown", { key: "Enter", shiftKey: true });
  assert.equal(w.q("chat-find-count").textContent, "1 / 3", "wraps to the oldest");
  w.q("prev").fire("click");
  assert.equal(w.q("chat-find-count").textContent, "3 / 3");
  w.type("nothing like this");
  assert.equal(w.q("chat-find-count").textContent, I.t("find.none"));
  assert.ok(w.q("chat-find").classList.contains("none"));
  assert.equal(w.sets.has("deck-find"), false);
  assert.equal(w.q("prev").disabled, true);
  w.type("build");
  w.q("chat-find").fire("keydown", { key: "Escape" });
  assert.equal(w.cf.isOpen(), false);
  assert.equal(w.q("chat-find").hidden, true);
  assert.equal(w.sets.size, 0, "no highlight left in the transcript");
  assert.equal(w.scroller.focused, true);
});

test("a transcript repainted while the bar is open is searched again and keeps the same match current", async () => {
  const w = make();
  w.inner.appendChild(msg("alpha one", "alpha two"));
  w.cf.open();
  w.type("alpha");
  w.q("chat-find").fire("keydown", { key: "Enter" }); // 1 / 2
  const scrolled = () => w.inner.kids.flatMap((m) => m.kids).reduce((n, p) => n + (p.scrolled || 0), 0);
  const before = scrolled();
  w.inner.appendChild(msg("a streamed reply with alpha in it"));
  for (const fn of doc.listeners["deck-transcript-paint"]) fn();
  await settle();
  assert.equal(w.q("chat-find-count").textContent, "1 / 3", "the same match, one more found below it");
  assert.equal(scrolled(), before, "a repaint does not move the reader");
});

test("'Search earlier messages' loads older pages until a match shows up, and says when there is nothing earlier", async () => {
  const w = make({ pages: [msg("nothing here"), msg("the needle is here"), msg("never loaded")] });
  w.inner.appendChild(msg("latest message"));
  w.cf.open();
  w.type("needle");
  assert.equal(w.q("chat-find-count").textContent, I.t("find.none"));
  assert.equal(w.q("chat-find-more").hidden, false, "earlier messages are not loaded yet");
  w.q("chat-find-more").fire("click");
  await settle(); await settle();
  assert.equal(w.loads.length, 2, "stops at the page that has a match");
  assert.equal(w.q("chat-find-count").textContent, "1 / 1");
  assert.equal(w.q("chat-find-more").hidden, false, "one more page is left");
  w.q("chat-find-more").fire("click");
  await settle(); await settle();
  assert.equal(w.loads.length, 3);
  assert.equal(w.q("chat-find-more").hidden, true, "the session's start is reached");
  // without the Highlight API the bar still counts and steps
  const plain = make({ hasHighlights: false });
  plain.inner.appendChild(msg("x y x"));
  plain.cf.open(); plain.type("x");
  assert.equal(plain.q("chat-find-count").textContent, "2 / 2");
});

test("wiring: Ctrl/Cmd+F opens it for the chat on screen; the module loads before app.js; highlights are styled", () => {
  const app = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
  assert.match(app, /\(e\.ctrlKey \|\| e\.metaKey\) && !e\.shiftKey && !e\.altKey && e\.key\.toLowerCase\(\) === "f" && !e\.isComposing && CF && chatEl\.offsetParent !== null\) \{\s+e\.preventDefault\(\);\s+CF\.open\(\);/);
  assert.match(app, /load: \(\) => hermesLoadHistory\(sid, \{ older: true \}\)/);
  const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
  assert.ok(html.indexOf('src="chat-find.js"') > 0 && html.indexOf('src="chat-find.js"') < html.indexOf('src="app.js"'));
  const css = fs.readFileSync(path.join(__dirname, "../renderer/messages.css"), "utf8");
  assert.match(css, /::highlight\(deck-find\) \{/);
  assert.match(css, /::highlight\(deck-find-current\) \{/);
  assert.match(css, /\.chat-find\[hidden\] \{ display: none; \}/);
  for (const k of ["find.placeholder", "find.prev", "find.next", "find.close", "find.none", "find.earlier", "find.searching"]) assert.notEqual(I.t(k), k);
});
