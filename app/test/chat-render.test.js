"use strict";
// The chat column while a reply streams: what the reader sees must not be disturbed.
//   - stable-list.js: a repaint keeps every element whose fresh copy is identical (so a text selection in an older
//     message survives a streamed token) and a reader who scrolled up keeps their place;
//   - streamed text is drawn as markdown while it arrives, not only once the turn is stored;
//   - markdown.js: fenced code carries a Copy button whose feedback leaves the DOM unchanged, and code spans in table
//     cells get break points after their separators so a long path wraps instead of pushing the table out;
//   - hermes-files.js: a plain-path mention becomes a chip only once the host confirmed the file, and a file offered
//     again in a later message is a chip of its own.
// No browser here: a small DOM stand-in with the calls these modules use. The real layout (table widths, scroll
// positions in a column-reverse scroller) is checked in a browser; these tests pin the logic.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const I18N = require("../renderer/i18n");

const RENDERER = path.join(__dirname, "../renderer");
const read = (name) => fs.readFileSync(path.join(RENDERER, name), "utf8");

// ------------------------------------------------------------------ a small DOM
class FNode {
  constructor(type, name) {
    this.nodeType = type;
    this.nodeName = name;
    this.childNodes = [];
    this.parentNode = null;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() {
    const sibs = this.parentNode ? this.parentNode.childNodes : [];
    return sibs[sibs.indexOf(this) + 1] || null;
  }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get isConnected() { return !!this.parentNode && (this.parentNode.root === true || this.parentNode.isConnected); }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) {
    if (this.nodeType === 3) { this.data = String(v); return; }
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== "") this.appendChild(new FText(String(v)));
  }
  _detach(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
  }
  insertBefore(n, ref) {
    if (n.nodeType === 11) {
      for (const c of [...n.childNodes]) this.insertBefore(c, ref);
      return n;
    }
    this._detach(n);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (ref && at < 0) throw new Error("insertBefore: not a child");
    if (at < 0) this.childNodes.push(n);
    else this.childNodes.splice(at, 0, n);
    n.parentNode = this;
    FNode.ops++;
    return n;
  }
  appendChild(n) { return this.insertBefore(n, null); }
  prepend(n) { return this.insertBefore(n, this.firstChild); }
  removeChild(n) {
    const at = this.childNodes.indexOf(n);
    if (at < 0) throw new Error("removeChild: not a child");
    this.childNodes.splice(at, 1);
    n.parentNode = null;
    FNode.ops++;
    return n;
  }
  replaceChildren(...kids) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    for (const k of kids) this.appendChild(typeof k === "string" ? new FText(k) : k);
  }
  cloneNode() {
    if (this.nodeType === 3) return new FText(this.data);
    const ops = FNode.ops; // a copy is not a change to the document
    const c = new FElement(this.nodeName);
    for (const [k, v] of this.attrs) c.attrs.set(k, v);
    Object.assign(c.dataset, this.dataset);
    for (const kid of this.childNodes) c.appendChild(kid.cloneNode());
    FNode.ops = ops;
    return c;
  }
  isEqualNode(o) {
    if (!o || o.nodeType !== this.nodeType || o.nodeName !== this.nodeName) return false;
    if (this.nodeType === 3) return this.data === o.data;
    if (this.nodeType === 1) {
      const a = this._attrs();
      const b = o._attrs();
      if (a.length !== b.length || a.some((x, i) => x !== b[i])) return false;
    }
    return this.childNodes.length === o.childNodes.length && this.childNodes.every((c, i) => c.isEqualNode(o.childNodes[i]));
  }
}
FNode.ops = 0;
class FText extends FNode {
  constructor(data) { super(3, "#text"); this.data = data; }
}
class FElement extends FNode {
  constructor(tag) {
    super(1, tag.toUpperCase());
    this.attrs = new Map();
    this.dataset = {};
    this.listeners = {};
    this.animations = [];
    this.rect = { top: 0, bottom: 0 };
    const self = this;
    this.classList = {
      add: (c) => { if (!self.classList.contains(c)) self.className = `${self.className} ${c}`.trim(); },
      remove: (c) => { self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(" "); },
      contains: (c) => self.className.split(/\s+/).includes(c),
    };
  }
  get className() { return this.attrs.get("class") || ""; }
  set className(v) { this.attrs.set("class", String(v)); }
  set type(v) { this.attrs.set("type", v); }
  set tabIndex(v) { this.attrs.set("tabindex", String(v)); }
  set href(v) { this.attrs.set("href", v); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  _attrs() {
    return [...[...this.attrs].map(([k, v]) => `${k}=${v}`), ...Object.entries(this.dataset).map(([k, v]) => `data-${k}=${v}`)].sort();
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  animate(frames, opts) { this.animations.push({ frames, opts }); return {}; }
  getBoundingClientRect() { return typeof this.rect === "function" ? this.rect() : this.rect; }
  _all() { return this.children.flatMap((c) => [c, ...c._all()]); }
  _is(sel) {
    return sel.split(",").some((one) => { const x = one.trim(); return x.startsWith(".") ? this.classList.contains(x.slice(1)) : this.nodeName === x.toUpperCase(); });
  }
  matches(sel) { return this._is(sel); }
  getElementsByTagName() { return this._all(); }
  querySelectorAll(sel) {
    const direct = /^([^\s,]+) > ([^\s,]+)$/.exec(sel);
    if (direct) return this._all().filter((e) => e._is(direct[2]) && e.parentNode && e.parentNode._is && e.parentNode._is(direct[1]));
    return this._all().filter((e) => e._is(sel));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) {
    for (let e = this; e && e.nodeType === 1; e = e.parentNode) if (e._is(sel)) return e;
    return null;
  }
}
class FFragment extends FElement {
  constructor() { super("#fragment"); this.nodeType = 11; }
}

function fakeDocument() {
  const doc = new FElement("#document");
  doc.root = true;
  doc.createElement = (tag) => new FElement(tag);
  doc.createTextNode = (s) => new FText(String(s));
  doc.createDocumentFragment = () => new FFragment();
  return doc;
}

/** markdown.js in a vm with the DOM stand-in; `copied` collects what the Copy button wrote. */
function markdown({ clipboard = true } = {}) {
  const document = fakeDocument();
  const copied = [];
  const window = {
    DeckI18n: { t: I18N.t, getLocale: I18N.getLocale, node: (k, v) => document.createTextNode(I18N.t(k, v)), bind: (el, attr, key, vars) => el.setAttribute(attr, I18N.t(key, vars)) },
  };
  const navigator = { clipboard: clipboard ? { writeText: async (t) => { copied.push(t); } } : { writeText: async () => { throw new Error("denied"); } } };
  vm.runInNewContext(read("markdown.js"), { window, document, navigator, URL, console });
  const host = (text) => {
    const box = document.createElement("div");
    box.appendChild(window.DeckMarkdown.render(text));
    return box;
  };
  const click = async (target) => {
    for (const fn of document.listeners.click || []) fn({ target });
    await new Promise((r) => setImmediate(r));
  };
  return { md: window.DeckMarkdown, host, click, copied, document };
}

const SL = require("../renderer/stable-list");

// ------------------------------------------------------------------ stable-list.js
const msg = (doc, text, cls = "msg") => {
  const m = doc.createElement("div");
  m.className = cls;
  const t = doc.createElement("div");
  t.className = "text";
  t.appendChild(doc.createTextNode(text));
  m.appendChild(t);
  return m;
};

function column(texts) {
  const doc = fakeDocument();
  const scroller = doc.createElement("div");
  const inner = doc.createElement("div");
  doc.appendChild(scroller);
  scroller.appendChild(inner);
  scroller.scrollTop = 0;
  scroller.rect = { top: 0, bottom: 600 };
  const build = (list) => list.map((t) => msg(doc, t, t.startsWith("live:") ? "msg live" : "msg"));
  SL.paint(scroller, inner, build(texts));
  // the reader scrolling: the offset changes and the scroller says so
  const scrollTo = (top) => { scroller.scrollTop = top; for (const fn of scroller.listeners.scroll || []) fn({}); };
  return { doc, scroller, inner, build, scrollTo };
}

test("repaint: a message whose fresh copy is identical stays the same element; only the changed one is replaced", () => {
  const c = column(["one", "two", "live:Hel"]);
  const [one, two, live] = c.inner.childNodes;
  let fresh = c.build(["one", "two", "live:Hello"]);
  FNode.ops = 0;
  SL.paint(c.scroller, c.inner, fresh);
  assert.equal(c.inner.childNodes[0], one, "an older message is not rebuilt: a selection inside it survives");
  assert.equal(c.inner.childNodes[1], two);
  assert.notEqual(c.inner.childNodes[2], live);
  assert.equal(c.inner.childNodes[2].textContent, "live:Hello");
  assert.equal(live.parentNode, null, "the old streaming bubble is gone");
  assert.equal(FNode.ops, 2, "one removal and one insertion, nothing else moved");
  // nothing changed: nothing is touched at all
  fresh = c.build(["one", "two", "live:Hello"]);
  FNode.ops = 0;
  SL.paint(c.scroller, c.inner, fresh);
  assert.equal(FNode.ops, 0);
});

test("repaint: an older page on top, a message in the middle and a removed row keep every unchanged element", () => {
  const c = column(["a", "b", "c", "d"]);
  const [a, b, cc, d] = c.inner.childNodes;
  SL.paint(c.scroller, c.inner, c.build(["older-1", "older-2", "a", "b", "new", "d"]));
  const now = c.inner.childNodes;
  assert.deepEqual(now.map((n) => n.textContent), ["older-1", "older-2", "a", "b", "new", "d"]);
  assert.deepEqual([now[2], now[3], now[5]], [a, b, d]);
  assert.equal(cc.parentNode, null);
  // identical messages (the same text twice) are each kept once, in order
  const t = column(["same", "same", "x"]);
  const [s1, s2] = t.inner.childNodes;
  SL.paint(t.scroller, t.inner, t.build(["same", "same", "same", "x"]));
  assert.deepEqual([t.inner.childNodes[0], t.inner.childNodes[1]], [s1, s2]);
  assert.equal(t.inner.childNodes.length, 4);
  // a differing attribute or class is a different message
  const k = column(["p"]);
  const before = k.inner.childNodes[0];
  SL.paint(k.scroller, k.inner, [msg(k.doc, "p", "msg out")]);
  assert.notEqual(k.inner.childNodes[0], before);
  // empty entries are skipped, never drawn as text
  SL.paint(k.scroller, k.inner, [null, msg(k.doc, "p", "msg out"), undefined, false]);
  assert.equal(k.inner.childNodes.length, 1);
});

test("repaint: rows other modules decorated or added stay; a row that lost a part is rebuilt; live rows are always fresh", () => {
  const c = column(["user", "answer", "last"]);
  const [user, answer, last] = c.inner.childNodes;
  // what composer.js and receipts.js do after a paint: keys and classes on the rows, a receipt between them
  user.dataset.convKey = "k1";
  answer.classList.add("conv-fresh");
  const receipt = c.doc.createElement("div");
  receipt.className = "receipt";
  c.inner.insertBefore(receipt, last);
  SL.paint(c.scroller, c.inner, c.build(["user", "answer", "last", "live:x"]));
  assert.deepEqual(c.inner.childNodes.slice(0, 4), [user, answer, receipt, last], "decorated rows are the same elements and the receipt stays where it was");
  assert.equal(user.dataset.convKey, "k1");
  assert.equal(c.inner.childNodes[4].textContent, "live:x");
  // a row before the receipt changes: the receipt keeps its place between its neighbours
  SL.paint(c.scroller, c.inner, c.build(["user", "answer v2", "last"]));
  assert.deepEqual(c.inner.childNodes.map((n) => n.className || n.textContent), ["msg", "msg", "receipt", "msg"]);
  assert.equal(c.inner.childNodes[1].textContent, "answer v2");
  assert.equal(c.inner.childNodes[3], last);
  // a row whose part was moved out of it (an element another module keeps and re-homes) is not kept as it is
  const withPart = () => { const m = msg(c.doc, "media"); const part = c.doc.createElement("div"); part.className = "part"; m.appendChild(part); return m; };
  SL.paint(c.scroller, c.inner, [withPart()]);
  const shown = c.inner.childNodes.find((n) => n.textContent === "media");
  shown.removeChild(shown.querySelector(".part"));
  SL.paint(c.scroller, c.inner, [withPart()]);
  const now = c.inner.childNodes.find((n) => n.textContent === "media");
  assert.notEqual(now, shown);
  assert.ok(now.querySelector(".part"));
  // the working row, a voice player and pictures are bound to live state by their own modules: never an old copy
  for (const cls of ["livebar", "vb"]) {
    const bar = () => { const m = msg(c.doc, "same"); m.className = cls; return m; };
    SL.paint(c.scroller, c.inner, [bar()]);
    const first = c.inner.childNodes.find((n) => n.className === cls);
    const next = bar();
    SL.paint(c.scroller, c.inner, [next]);
    assert.equal(c.inner.childNodes.find((n) => n.className === cls), next, cls);
    assert.equal(first.parentNode, null);
  }
  const pic = () => { const m = msg(c.doc, "pic"); m.appendChild(c.doc.createElement("img")); return m; };
  SL.paint(c.scroller, c.inner, [pic()]);
  const again = pic();
  SL.paint(c.scroller, c.inner, [again]);
  assert.equal(c.inner.childNodes.find((n) => n.textContent === "pic"), again);
});

test("scrolled up: the row the reader was looking at stays where it was, through later frames, until they scroll", (t) => {
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  t.after(() => { delete globalThis.requestAnimationFrame; });
  const nextFrame = () => { const run = frames.splice(0); for (const fn of run) fn(); return run.length; };
  const c = column(["a", "b", "c", "live:x"]);
  const [a, b, cc] = c.inner.childNodes;
  // layout: `shift` moves the rows on screen (a taller block arrived, a receipt was put back a frame later)
  let shift = 0;
  a.rect = () => ({ top: -200 + shift, bottom: -20 + shift }); // above the view
  b.rect = () => ({ top: 40 + shift, bottom: 300 + shift }); // the first one in view
  cc.rect = () => ({ top: 320 + shift, bottom: 580 + shift });
  const scrolled = () => { const d = c.scroller.scrollTop - base; base = c.scroller.scrollTop; shift -= d; return d; }; // a correction moves the rows back
  let base = -400;
  c.scrollTo(-400);
  const out = SL.hold(c.scroller, c.inner, () => { shift = 137; return "result"; });
  assert.equal(out, "result", "the change's own result comes back");
  assert.equal(scrolled(), 137, "the view follows the row by exactly what it moved");
  // a frame later another module moves things again (a receipt re-inserted): corrected too, against the same place
  shift += 60;
  assert.equal(nextFrame(), 1);
  assert.equal(scrolled(), 60);
  assert.equal(b.rect().top, 40, "the row is where the reader had it");
  // many changes in a row: the place is measured once, sub-pixel steps never add up
  for (let i = 0; i < 50; i++) { SL.hold(c.scroller, c.inner, () => { shift += 0.4; }); scrolled(); nextFrame(); scrolled(); }
  assert.ok(Math.abs(b.rect().top - 40) < 1, `drift ${b.rect().top - 40}`);
  while (nextFrame()) scrolled();
  // the reader scrolls: their new place is the one that is held from now on
  shift = 0; base = -700;
  c.scrollTo(-700);
  b.rect = () => ({ top: 340 + shift, bottom: 600 + shift });
  SL.hold(c.scroller, c.inner, () => { shift = 25; });
  assert.equal(scrolled(), 25);
  assert.equal(b.rect().top, 340);
  while (nextFrame()) scrolled();
  // the first row in view was replaced: the next surviving one is the anchor
  a.rect = () => ({ top: 10 + shift, bottom: 30 + shift });
  shift = 0; base = -900;
  c.scrollTo(-900);
  SL.hold(c.scroller, c.inner, () => { c.inner.removeChild(a); shift = -50; });
  assert.equal(scrolled(), -50);
  while (nextFrame()) scrolled();
  // a reader who scrolls during the settle frames is not pulled back
  shift = 0; base = -900;
  SL.hold(c.scroller, c.inner, () => { shift = 10; });
  scrolled();
  c.scrollTo(-300);
  shift = 500;
  nextFrame();
  assert.equal(c.scroller.scrollTop, -300);
  // at the newest message the view follows the reply: no correction, no measuring
  shift = 0;
  c.scrollTo(0);
  let measured = 0;
  cc.rect = () => { measured++; return { top: 320 + shift, bottom: 580 + shift }; };
  SL.hold(c.scroller, c.inner, () => { shift = 500; });
  assert.equal(c.scroller.scrollTop, 0);
  assert.equal(measured, 0);
  assert.equal(nextFrame(), 0);
  assert.equal(SL.away({ scrollTop: -1 }), false, "a pixel of slack still counts as the bottom");
  assert.equal(SL.away({ scrollTop: -40 }), true);
});

// ------------------------------------------------------------------ streamed text is markdown
test("a reply is drawn as markdown while it streams, through the same renderer as the stored message", () => {
  const app = read("app.js");
  const cut = (name) => {
    const m = new RegExp(`^  function ${name}\\(`, "m").exec(app);
    assert.ok(m, `${name} exists`);
    return app.slice(m.index, app.indexOf("\n  }\n", m.index) + 5);
  };
  const rendered = [];
  const ctx = { window: { DeckMarkdown: { render: (t) => { rendered.push(t); return { md: t }; } } }, h: (tag, attrs, ...kids) => ({ tag, attrs, kids, appendChild(k) { this.kids.push(k); } }) };
  vm.createContext(ctx);
  vm.runInContext(`${cut("hermesTextEl")}\n${cut("hermesLiveTextEl")}`, ctx);
  const el = vm.runInContext("hermesLiveTextEl", ctx)("**bold** and a | table |");
  assert.equal(el.attrs.class, "text md");
  assert.deepEqual(rendered, ["**bold** and a | table |"]);
  assert.equal(el.kids[0].md, "**bold** and a | table |");
  // both the segment still streaming and the finished segments the history has not returned yet use it
  const body = cut("renderHermesMsgs");
  assert.equal((body.match(/hermesLiveTextEl\(/g) || []).length, 2);
  assert.doesNotMatch(body, /h\("div", \{ class: "text" \}, s(eg)?\.text\)/, "no plain-text bubble for streamed text");
  // the transcript is painted through stable-list.js in both chat views, and the live row grows inside a hold
  assert.match(body, /paintMsgs\(kids\);/);
  assert.doesNotMatch(body, /replaceChildren/);
  const paint = cut("paintMsgs");
  assert.match(paint, /DeckStableList\.paint\(els\.msgs, els\.msgsInner, kids\)/);
  assert.match(paint, /if \(stableFor !== key\) \{\n\s+els\.msgsInner\.replaceChildren\(\);/, "another session starts from an empty column");
  // composer.js (request tray, queue) and receipts.js follow every paint, also one that removed nothing
  assert.match(paint, /dispatchEvent\(new CustomEvent\("deck-transcript-paint"\)\)/);
  assert.match(read("composer.js"), /addEventListener\("deck-transcript-paint", \(\) => \{ fullRender = true; schedule\(\); \}\)/);
  // whatever else draws the column (forms, a Telegram chat) hands it back whole
  assert.equal((app.match(/^\s+stableFor = null;/gm) || []).length, 3);
  assert.match(cut("liveRowRefresh"), /DeckStableList\.hold\(els\.msgs, els\.msgsInner, \(\) => LA\.patch\(hermesLiveView\(\)\)\)/);
  const html = read("index.html");
  assert.ok(html.indexOf('src="stable-list.js"') > 0 && html.indexOf('src="stable-list.js"') < html.indexOf('src="app.js"'), "loaded before app.js");
});

test("markdown that is still arriving renders what is there: an open code fence, a table without its last row", () => {
  const { host } = markdown();
  const open = host("Run this:\n\n```sh\nnpm ci\nnpm te");
  assert.equal(open.querySelector("pre > code").textContent, "npm ci\nnpm te");
  const bold = host("so **this is bold** and `code`");
  assert.equal(bold.querySelector("strong").textContent, "this is bold");
  assert.ok(!bold.textContent.includes("**"));
  const table = host("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 |");
  assert.equal(table.querySelectorAll("tr").length, 3);
});

// ------------------------------------------------------------------ code blocks: Copy
test("fenced code sits in a frame with a Copy button that copies the code as written", async () => {
  const { host, click, copied } = markdown();
  const box = host("Before\n\n```js\nconst a = 1;\n  indented();\n```\n\nAfter `inline`");
  const frames = box.querySelectorAll(".md-code");
  assert.equal(frames.length, 1, "one frame per fenced block; inline code has none");
  const btn = frames[0].querySelector(".md-copy");
  assert.equal(btn.getAttribute("type"), "button");
  assert.equal(btn.getAttribute("aria-label"), I18N.t("A0195"));
  assert.equal(btn.querySelector(".md-copy-idle").textContent, I18N.t("think.copy"));
  assert.equal(btn.querySelector(".md-copy-done").textContent, I18N.t("think.copied"));
  assert.equal(frames[0].querySelector("pre > code").textContent, "const a = 1;\n  indented();");
  // a click anywhere on the button (its label span) copies only the code
  const fresh = host("Before\n\n```js\nconst a = 1;\n  indented();\n```\n\nAfter `inline`");
  await click(btn.querySelector(".md-copy-idle"));
  assert.deepEqual(copied, ["const a = 1;\n  indented();"]);
  // the "Copied" feedback is an animation: the DOM is as it was, so a repaint keeps this very element (and with it
  // the feedback) instead of swapping in a fresh copy on the next streamed token
  assert.ok(btn.querySelector(".md-copy-done").animations.length === 1 && btn.animations.length === 1);
  assert.ok(box.isEqualNode(fresh), "nothing in the DOM changed");
  // a click elsewhere copies nothing
  await click(box.querySelector("pre"));
  assert.equal(copied.length, 1);
});

test("Copy: an unavailable clipboard shows no 'Copied'", async () => {
  const { host, click } = markdown({ clipboard: false });
  const box = host("```\nx\n```");
  const btn = box.querySelector(".md-copy");
  await click(btn);
  assert.equal(btn.animations.length, 0);
});

// ------------------------------------------------------------------ tables
test("table cells: a long path in code may wrap after its separators; the text is unchanged", () => {
  const { host } = markdown();
  const p = "distributed_workers/playbooks/provisioning/node_acceptance.yaml:50";
  const box = host(`| # | Where |\n|---|---|\n| 5 | \`${p}\` |\n| 6 | \`short.sh\` and prose |`);
  const [long, short] = box.querySelectorAll("td").filter((td) => td.querySelector("code")).map((td) => td.querySelector("code"));
  assert.equal(long.textContent, p, "copying the cell still gives the path as written");
  const pieces = long.childNodes.filter((n) => n.nodeType === 3).map((n) => n.data);
  assert.deepEqual(pieces, ["distributed_workers/", "playbooks/", "provisioning/", "node_acceptance.yaml:50"], "a name stays in one piece");
  assert.equal(long.querySelectorAll("wbr").length, pieces.length - 1);
  assert.equal(short.querySelectorAll("wbr").length, 0, "short code is left alone");
  // code outside a table is not touched
  assert.equal(host(`See \`${p}\` here`).querySelectorAll("wbr").length, 0);
});

test("table CSS: words stay whole, code and links can break, and nothing forces the table wider than the column", () => {
  const css = read("messages.css");
  const rule = (sel) => {
    const at = css.indexOf(`${sel} {`);
    assert.ok(at >= 0, sel);
    return css.slice(at, css.indexOf("}", at));
  };
  assert.match(rule(".md table"), /width: auto;.*max-width: 100%/);
  assert.doesNotMatch(rule(".md table"), /max-content/);
  assert.match(rule(".md th, .md td"), /overflow-wrap: break-word/);
  assert.match(rule(".md td code, .md th code"), /white-space: normal; overflow-wrap: break-word/);
  assert.match(rule(".md td .md-a, .md th .md-a"), /overflow-wrap: anywhere/);
  // a very narrow column (a split pane): fitting wins over whole words
  assert.match(css, /\.msgs \{ container: msgs \/ inline-size; \}/);
  // a wide table widens into the pane beside the reading column instead of scrolling inside it
  assert.match(css, /> \.text > \.md-table \{\n\s+--table-max: max\(100%, min\(100cqw - 24px, 80rem\)\);[^\n]*\n\s+width: var\(--table-max\); max-width: none; margin-left: calc\(\(100% - var\(--table-max\)\) \/ 2\);\n\s+display: grid; grid-template-columns: minmax\(min\(var\(--col\), 100%\), max-content\); justify-content: center;/);
  assert.match(css, /\n@container msgs \(max-width: 760px\) \{\n\s+\.md th, \.md td, \.md td code, \.md th code \{ overflow-wrap: anywhere; \}/);
  // the Copy button is opaque and reachable by keyboard
  assert.match(rule(".md .md-copy"), /background: var\(--slate-2\)/);
  assert.match(css, /\.md \.md-code:hover > \.md-copy, \.md \.md-copy:focus-visible \{ opacity: 1; \}/);
});

// ------------------------------------------------------------------ file chips
function chips() {
  const HF = require("../renderer/hermes-files");
  const lookups = [];
  const downloads = [];
  let redraws = 0;
  const h = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(Boolean) });
  const deck = { bridge: { file: {
    onEvent() {},
    info: (sid, ref) => new Promise((resolve, reject) => lookups.push({ sid, ref, resolve, reject })),
    download: async (sid, ref) => { downloads.push(ref); return { status: "done", id: "d1", name: "test.zip", size: 3, risky: false }; },
  } } };
  const hf = HF.create({ h, deck, mark: () => { redraws++; }, cleanErr: (e) => String(e && e.message), VB: null });
  const flat = (el) => (el ? [el, ...el.kids.filter((k) => typeof k === "object").flatMap(flat)] : []);
  const texts = (el) => flat(el).flatMap((e) => e.kids.filter((k) => typeof k === "string"));
  const settle = () => new Promise((r) => setImmediate(r));
  return { hf, lookups, downloads, flat, texts, settle, redraws: () => redraws };
}

test("a plain-path mention gets its chip only once the host confirmed the file; a refused one never shows", async () => {
  const c = chips();
  const where = { sid: "s1", profile: "default" };
  const m = { id: "m1", role: "assistant", files: [{ ref: "aaaaaaaaaaaaaaaa", name: "test.zip", media: false, quiet: true }, { ref: "bbbbbbbbbbbbbbbb", name: "main.js", media: false, quiet: true }] };
  assert.equal(c.hf.chips(m, where), null, "nothing is drawn while the host is asked");
  assert.equal(c.lookups.length, 2, "both are looked up");
  c.lookups[0].resolve({ size: 2048, name: "test.zip" });
  c.lookups[1].reject(new Error("This file was not offered in this session"));
  await c.settle();
  assert.ok(c.redraws() >= 2);
  const drawn = c.hf.chips(m, where);
  assert.equal(drawn.kids.length, 1, "only the confirmed file");
  assert.ok(c.texts(drawn).includes("test.zip") && c.texts(drawn).includes("2 KB"));
  assert.ok(!c.texts(drawn).includes("main.js"));
  // a backticked or MEDIA: path is shown at once, as before, error included
  const loud = { id: "m2", role: "assistant", files: [{ ref: "cccccccccccccccc", name: "report.pdf", media: true }] };
  assert.ok(c.texts(c.hf.chips(loud, where)).includes("report.pdf"));
});

test("a file offered again in a later message is its own chip: not 'saved' already, size looked up afresh", async () => {
  const c = chips();
  const where = { sid: "s1", profile: "default" };
  const file = { ref: "aaaaaaaaaaaaaaaa", name: "Setup.exe", media: true };
  const first = { id: "m1", role: "assistant", files: [file] };
  const second = { id: "m9", role: "assistant", files: [file] };
  c.hf.chips(first, where);
  c.lookups[0].resolve({ size: 100, name: "Setup.exe" });
  await c.settle();
  const btn = c.flat(c.hf.chips(first, where)).find((e) => e.tag === "button");
  btn.attrs.onclick();
  await c.settle();
  assert.deepEqual(c.downloads, [file.ref]);
  assert.ok(c.texts(c.hf.chips(first, where)).some((t) => t.includes(I18N.t("download.open"))), "the first chip is saved");
  // the rebuilt file, offered again at the same path
  const again = c.hf.chips(second, where);
  assert.equal(c.lookups.length, 2, "its size is asked again");
  assert.ok(!c.texts(again).some((t) => t.includes(I18N.t("download.open"))), "the new offer is not shown as saved");
  c.lookups[1].resolve({ size: 250, name: "Setup.exe" });
  await c.settle();
  assert.ok(c.texts(c.hf.chips(second, where)).includes("250 B"));
  assert.ok(c.texts(c.hf.chips(first, where)).some((t) => t.includes(I18N.t("download.open"))), "the first keeps its own state");
});
