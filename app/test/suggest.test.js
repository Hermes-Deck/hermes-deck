"use strict";
// Composer "@" / "/" suggestions: the pure helpers of renderer/suggest.js, the popup's keys against a small DOM
// stand-in, the Telegram bot-command cache (main/bot-commands.js), the commands.catalog projection and request
// check in main/bridge.js, and how app.js / index.html wire it in.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const S = require("../renderer/suggest");
const { BotCommands, cleanCommands } = require("../main/bot-commands");
const bridge = require("../main/bridge");

const RENDERER = path.join(__dirname, "..", "renderer");

test("tokenAt: a leading slash, or @ at the start or after whitespace", () => {
  assert.deepEqual(S.tokenAt("/sta", 4), { kind: "/", start: 0, end: 4, query: "sta" });
  assert.deepEqual(S.tokenAt("/", 1), { kind: "/", start: 0, end: 1, query: "" });
  assert.equal(S.tokenAt(" /sta", 5), null, "a command is the whole message");
  assert.equal(S.tokenAt("/status now", 11), null, "past the command: nothing to suggest");
  assert.equal(S.tokenAt("a/b", 3), null);
  assert.deepEqual(S.tokenAt("hi @atl", 7), { kind: "@", start: 3, end: 7, query: "atl" });
  assert.deepEqual(S.tokenAt("@", 1), { kind: "@", start: 0, end: 1, query: "" });
  assert.equal(S.tokenAt("mail@x", 6), null, "an address is not a mention");
  assert.deepEqual(S.tokenAt("hi @atlas later", 5), { kind: "@", start: 3, end: 9, query: "a" }, "the token runs on past the caret");
});

test("rank: prefix, then word start, then anywhere; the source order inside a rank", () => {
  const items = [
    { insert: "/reasoning", label: "/reasoning", detail: "Set the effort" },
    { insert: "/new", label: "/new", detail: "Start a session" },
    { insert: "/model", label: "/model", detail: "Switch the model" },
    { insert: "/skill-new", label: "/skill-new", detail: "" },
  ];
  assert.deepEqual(S.rank(items, "").map((i) => i.insert), ["/reasoning", "/new", "/model", "/skill-new"]);
  assert.deepEqual(S.rank(items, "new").map((i) => i.insert), ["/new", "/skill-new"]);
  assert.deepEqual(S.rank(items, "/mo").map((i) => i.insert), ["/model"]);
  assert.deepEqual(S.rank(items, "effort").map((i) => i.insert), ["/reasoning"], "the description matches too");
  assert.deepEqual(S.rank([{ insert: "@atlas_bot", label: "Atlas", keys: ["nova"] }], "nov").length, 1, "keys match");
});

test("applyPick: replaces the token and adds one space", () => {
  assert.deepEqual(S.applyPick("/sta", S.tokenAt("/sta", 4), { insert: "/status" }), { value: "/status ", caret: 8 });
  assert.deepEqual(S.applyPick("hi @ar there", S.tokenAt("hi @ar there", 6), { insert: "@atlas_bot" }),
    { value: "hi @atlas_bot there", caret: 13 });
  assert.deepEqual(S.unique([{ insert: "@A" }, { insert: "@a" }, { insert: "@b" }]).map((i) => i.insert), ["@A", "@b"]);
});

// ---------------------------------------------------------------- the popup, against a small DOM stand-in
function dom() {
  class El {
    constructor(tag) {
      this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.hidden = false; this._text = "";
    }
    appendChild(c) { if (c) { this.children.push(c); c.parentNode = this; } return c; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(type, fn, capture) { (this.listeners[type] = this.listeners[type] || []).push({ fn, capture: !!capture }); }
    fire(type, init = {}) {
      let stopped = false;
      const e = { type, key: init.key, shiftKey: !!init.shiftKey, ctrlKey: false, metaKey: false, altKey: false, isComposing: false,
        defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { stopped = true; } };
      const all = this.listeners[type] || [];
      for (const l of [...all.filter((x) => x.capture), ...all.filter((x) => !x.capture)]) { if (stopped) break; l.fn(e); }
      return e;
    }
    focus() {}
    scrollIntoView() {}
  }
  const h = (tag, props, ...kids) => {
    const el = new El(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") el.className = v;
      else if (k === "hidden") el.hidden = !!v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) el.appendChild(typeof k === "string" ? Object.assign(new El("#text"), { _text: k }) : k);
    return el;
  };
  const input = new El("textarea");
  input.value = ""; input.selectionStart = 0; input.selectionEnd = 0;
  input.setSelectionRange = (a, b) => { input.selectionStart = a; input.selectionEnd = b; };
  const type = (v) => { input.value = v; input.setSelectionRange(v.length, v.length); input.fire("input"); };
  return { h, input, composer: new El("div"), type };
}
const tick = () => new Promise((r) => setImmediate(r));

function mount(items) {
  const d = dom();
  let changed = 0;
  const sent = [];
  d.input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sent.push(d.input.value); } });
  const sg = S.create({ h: d.h, i18nText: (k) => k, input: d.input, composer: d.composer, changed: () => changed++,
    source: async (kind) => items[kind] || [] });
  return { ...d, sg, sent, changed: () => changed };
}

test("popup: opens on /, arrows move, Tab inserts, the composer's Enter does not send", async () => {
  const m = mount({ "/": [{ insert: "/status", detail: "Session status" }, { insert: "/stop" }, { insert: "/new" }] });
  m.type("/st");
  await tick();
  assert.equal(m.sg.isOpen(), true);
  assert.deepEqual(m.sg.rows().map((r) => r.insert), ["/status", "/stop"]);
  assert.equal(m.input.getAttribute("aria-activedescendant"), "suggest-0");
  m.input.fire("keydown", { key: "ArrowDown" });
  assert.equal(m.input.getAttribute("aria-activedescendant"), "suggest-1");
  const e = m.input.fire("keydown", { key: "Enter" });
  assert.equal(e.defaultPrevented, true);
  assert.equal(m.input.value, "/stop ");
  assert.deepEqual(m.sent, [], "Enter picked, it did not send");
  assert.equal(m.sg.isOpen(), false);
  assert.equal(m.changed(), 1);
});

test("popup: Enter on a command typed in full sends it; Escape closes without touching the text", async () => {
  const m = mount({ "/": [{ insert: "/status" }, { insert: "/stop" }] });
  m.type("/status");
  await tick();
  assert.equal(m.sg.isOpen(), true);
  m.input.fire("keydown", { key: "Enter" });
  assert.deepEqual(m.sent, ["/status"]);
  m.type("/s");
  await tick();
  m.input.fire("keydown", { key: "Escape" });
  assert.equal(m.sg.isOpen(), false);
  assert.equal(m.input.value, "/s");
});

test("popup: @ mentions; nothing to offer keeps it closed; typing past the token closes it", async () => {
  const m = mount({ "@": [{ insert: "@atlas_bot", label: "Atlas" }, { insert: "@nova_bot", label: "Nova" }] });
  m.type("hey @nov");
  await tick();
  assert.deepEqual(m.sg.rows().map((r) => r.insert), ["@nova_bot"]);
  m.input.fire("keydown", { key: "Tab" });
  assert.equal(m.input.value, "hey @nova_bot ");
  m.type("hey @nova_bot ");
  await tick();
  assert.equal(m.sg.isOpen(), false);
  const empty = mount({});
  empty.type("/");
  await tick();
  assert.equal(empty.sg.isOpen(), false, "a chat without commands shows no popup");
  empty.input.fire("keydown", { key: "Enter" });
  assert.deepEqual(empty.sent, ["/"], "and Enter still sends");
});

// ---------------------------------------------------------------- main side
test("bot commands: valid names only, cached per bot, @bot in a topic", async () => {
  assert.deepEqual(cleanCommands([{ command: "Start", description: " Begin \n now " }, { command: "bad-name" }, { command: "start" }, null]),
    [{ command: "start", description: "Begin now" }]);
  let calls = 0;
  let now = 0;
  const bc = new BotCommands({ now: () => now, fetch: async (entity) => { calls++; return entity.id === 1 ? [{ command: "new", description: "New" }] : [{ command: "help" }]; } });
  const a = { entity: { id: 1 }, username: "atlas_bot" };
  const b = { entity: { id: 2 }, username: "nova_bot" };
  assert.deepEqual(await bc.list([a]), [{ insert: "/new", command: "new", description: "New", bot: "atlas_bot" }]);
  assert.deepEqual((await bc.list([a, b], { mention: true })).map((c) => c.insert), ["/new@atlas_bot", "/help@nova_bot"]);
  assert.equal(calls, 2, "the second list read bot 1 from the cache");
  now += 11 * 60 * 1000;
  await bc.list([a]);
  assert.equal(calls, 3, "stale after ten minutes");
  const failing = new BotCommands({ fetch: async () => { throw new Error("flood"); } });
  assert.deepEqual(await failing.list([a]), []);
});

test("commands.catalog: one profile, no session; the projection keeps commands and skills only", () => {
  assert.ok(bridge.METHODS.has("commands.catalog"));
  assert.doesNotThrow(() => bridge.checkRequest("commands.catalog", { profile: "default" }));
  for (const params of [{}, { profile: "../x" }, { profile: "default", session_id: "rpc-1" }]) {
    assert.throws(() => bridge.checkRequest("commands.catalog", params), undefined, JSON.stringify(params));
  }
  const out = bridge.projectCommandCatalog({
    categories: [{ name: "Session", pairs: [["/new", "Start a new session"], ["/model", "Switch\nmodel"], ["bad", "x"]] }],
    pairs: [["/new", "dup"], ["/model", "dup"], ["/pdf-tools", "Work with PDFs"], [3, "x"]],
    skills: { "/pdf-tools": { usage: 3, origin: "/Users/someone/.hermes/skills" } },
    sub: { "/model": ["a"] }, canon: {}, warning: "",
  });
  assert.deepEqual(out, [
    { command: "/new", description: "Start a new session", category: "Session" },
    { command: "/model", description: "Switch model", category: "Session" },
    { command: "/pdf-tools", description: "Work with PDFs", category: "Skills" },
  ]);
  assert.deepEqual(bridge.projectCommandCatalog(null), []);
});

test("wiring: suggest.js loads before app.js; app.js feeds both modes; the IPC is guarded and exposed", () => {
  const html = fs.readFileSync(path.join(RENDERER, "index.html"), "utf8");
  assert.ok(html.indexOf('src="suggest.js"') > 0 && html.indexOf('src="suggest.js"') < html.indexOf('src="app.js"'));
  const app = fs.readFileSync(path.join(RENDERER, "app.js"), "utf8");
  assert.match(app, /window\.DeckSuggest\.create\(/);
  assert.match(app, /deck\.botCommands\(S\.sel\)/);
  assert.match(app, /deck\.bridge\.commands\(profile\)/);
  const main = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  assert.match(main, /ipc\.handle\("tg:bot-commands", \(e, key\) => \{\n  fromApp\(e\);/);
  assert.match(main, /ipc\.handle\("tg:members", \(e\) => \{\n  fromApp\(e\);/);
  const preload = fs.readFileSync(path.join(__dirname, "..", "main", "preload.js"), "utf8");
  assert.match(preload, /botCommands: \(key\) => ipcRenderer\.invoke\("tg:bot-commands", key\)/);
  assert.match(preload, /commands: \(profile\) => ipcRenderer\.invoke\("bridge:commands", profile\)/);
});
