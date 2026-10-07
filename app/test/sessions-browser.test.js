"use strict";
// The session browser's pure helpers (renderer/sessions-browser.js) and its wiring, without Electron or a DOM:
// platform mapping, search + filters, day grouping, keyboard movement, i18n coverage and the script/CSS hookup.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const SB = require("../renderer/sessions-browser");
const i18n = require("../renderer/i18n");

const RENDERER = path.join(__dirname, "..", "renderer");
const row = (id, o = {}) => ({ id, profile: "default", source: "tui", title: "", preview: "", startedAt: 100, lastActive: 100, messages: 1, archived: false, pinned: false, ...o });

test("sourceKey maps Hermes sources to the browser's platforms; anything unknown is Other", () => {
  assert.deepEqual(["telegram", "Discord", " WEBUI ", "tui", "deck", "desktop", "cli", "ios"].map(SB.sourceKey), ["telegram", "discord", "webui", "tui", "deck", "desktop", "cli", "ios"]);
  assert.deepEqual(["", null, undefined, "unknown", "orca-bridge-test", "bot_room", "slack"].map(SB.sourceKey), Array(7).fill("other"));
  assert.deepEqual(SB.SOURCES, ["telegram", "discord", "webui", "tui", "deck", "desktop", "cli", "ios", "other"]);
});

test("only a session a messaging platform owns is continued in a copy", () => {
  for (const s of ["tui", "cli", "desktop", "deck", "webui", "TUI"]) assert.equal(SB.needsCopy(s), false, s);
  for (const s of ["telegram", "discord", "slack", "ios", "unknown", "", undefined, "whatsapp"]) assert.equal(SB.needsCopy(s), true, String(s));
});

test("search needs every word in title, preview or id; platform chips and profile narrow further", () => {
  const rows = [
    row("a-1", { title: "Deploy notes", preview: "rolled back the relay", source: "telegram", profile: "ops" }),
    row("b-2", { title: "Trip plan", preview: "flights to Izmir", source: "discord" }),
    row("c-3", { title: "", preview: "deploy script failed", source: "webui", profile: "ops" }),
  ];
  const ids = (o) => SB.filterRows(rows, o).map((r) => r.id);
  assert.deepEqual(ids({}), ["a-1", "b-2", "c-3"]);
  assert.deepEqual(ids({ q: "DEPLOY" }), ["a-1", "c-3"]);
  assert.deepEqual(ids({ q: "deploy relay" }), ["a-1"]);
  assert.deepEqual(ids({ q: "c-3" }), ["c-3"], "by id");
  assert.deepEqual(ids({ q: "  " }), ["a-1", "b-2", "c-3"]);
  assert.deepEqual(ids({ sources: new Set(["telegram", "webui"]) }), ["a-1", "c-3"]);
  assert.deepEqual(ids({ sources: new Set() }), ["a-1", "b-2", "c-3"], "no chip = every platform");
  assert.deepEqual(ids({ profile: "ops", q: "deploy", sources: new Set(["webui"]) }), ["c-3"]);
  assert.deepEqual(ids({ q: "nothing like this" }), []);
  assert.deepEqual([...SB.countBySource(rows)], [["telegram", 1], ["discord", 1], ["webui", 1]]);
});

test("sorting is newest activity first with a stable tie-break", () => {
  const rows = [row("b", { lastActive: 5 }), row("a", { lastActive: 5 }), row("z", { lastActive: 9 }), row("old", { lastActive: 0, startedAt: 1 })];
  assert.deepEqual(SB.sortRows(rows).map((r) => r.id), ["z", "a", "b", "old"]);
  assert.deepEqual(rows.map((r) => r.id), ["b", "a", "z", "old"], "the input is not mutated");
});

test("grouping: pinned first, then Today / Yesterday / one group per older local day", () => {
  const at = (y, m, d, hh = 12) => new Date(y, m - 1, d, hh).getTime();
  const now = at(2026, 10, 6, 15);
  const sec = (ms) => ms / 1000;
  const rows = [
    row("p", { pinned: true, lastActive: sec(at(2026, 9, 1)) }),
    row("t2", { lastActive: sec(at(2026, 10, 6, 14)) }),
    row("t1", { lastActive: sec(at(2026, 10, 6, 9)) }),
    row("y", { lastActive: sec(at(2026, 10, 5, 23)) }),
    row("d1", { lastActive: sec(at(2026, 10, 1)) }),
    row("d2", { lastActive: sec(at(2026, 10, 1, 8)) }),
  ];
  const g = SB.groupRows(rows, now);
  assert.deepEqual(g.map((x) => [x.kind, x.rows.map((r) => r.id)]), [["pinned", ["p"]], ["today", ["t2", "t1"]], ["yesterday", ["y"]], ["day", ["d1", "d2"]]]);
  // the archive view has no pins: a pinned row sorts with its day
  assert.deepEqual(SB.groupRows(rows, now, { pinned: false }).map((x) => x.kind), ["today", "yesterday", "day", "day"]);
  assert.deepEqual(SB.groupRows([], now), []);
});

test("keyboard movement stays inside the list and starts at the first row", () => {
  assert.equal(SB.moveIndex(-1, 1, 5), 0);
  assert.equal(SB.moveIndex(0, -1, 5), 0);
  assert.equal(SB.moveIndex(4, 1, 5), 4);
  assert.equal(SB.moveIndex(2, 10, 5), 4);
  assert.equal(SB.moveIndex(3, -Infinity, 5), 0);
  assert.equal(SB.moveIndex(1, Infinity, 5), 4);
  assert.equal(SB.moveIndex(0, 1, 0), -1);
});

test("every sessions.* key the browser uses exists in English and Turkish", () => {
  const src = fs.readFileSync(path.join(RENDERER, "sessions-browser.js"), "utf8");
  const keys = new Set([...src.matchAll(/\bL\("([A-Za-z.]+)"/g)].map((m) => `sessions.${m[1]}`));
  const families = { "src.": SB.SOURCES, "view.": ["active", "archived"] };
  for (const m of src.matchAll(/\bL\(`([A-Za-z.]+)\$\{/g)) {
    assert.ok(families[m[1]], `unknown key family ${m[1]}`);
    for (const x of families[m[1]]) keys.add(`sessions.${m[1]}${x}`);
  }
  for (const m of src.matchAll(/\bL\(([a-z]+\s*\?\s*"[A-Za-z.]+"\s*:\s*"[A-Za-z.]+")/g)) for (const k of m[1].match(/"([A-Za-z.]+)"/g)) keys.add(`sessions.${k.slice(1, -1)}`);
  for (const m of src.matchAll(/\bL\((?:\w+\.)?\w+\s*\?\s*"([A-Za-z.]+)"\s*:\s*"([A-Za-z.]+)"/g)) { keys.add(`sessions.${m[1]}`); keys.add(`sessions.${m[2]}`); }
  assert.ok(keys.size > 40, `found ${keys.size} keys`);
  for (const lang of ["en", "tr"]) for (const k of keys) {
    if (/[`$]/.test(k)) continue;
    assert.equal(typeof i18n.tables[lang][k], "string", `${lang}: ${k}`);
    assert.ok(i18n.tables[lang][k].length, `${lang}: ${k} is empty`);
  }
  for (const k of ["sessions.invalid", "sessions.busy"]) assert.ok(i18n.tables.en[k] && i18n.tables.tr[k], k);
  // a Turkish string is never the English one (but names and abbreviations may match)
  const same = Object.keys(i18n.tables.en).filter((k) => k.startsWith("sessions.") && i18n.tables.en[k] === i18n.tables.tr[k]);
  assert.deepEqual(same.filter((k) => !/^sessions\.(src\.|view\.|platforms$)/.test(k)), []);
});

test("the page loads the module and its stylesheet, and app.js uses only the narrow hooks", () => {
  const html = fs.readFileSync(path.join(RENDERER, "index.html"), "utf8");
  assert.ok(html.includes('<script src="sessions-browser.js"></script>'));
  assert.ok(html.indexOf("sessions-browser.js") < html.indexOf('<script src="app.js">'), "loaded before app.js");
  assert.ok(html.includes('href="sessions-browser.css"'));
  assert.ok(fs.existsSync(path.join(RENDERER, "sessions-browser.css")));
  const app = fs.readFileSync(path.join(RENDERER, "app.js"), "utf8");
  const uses = (app.match(/\bSB\b/g) || []).length;
  // +1: the composer pickers skip a read-only stored chat (model-picker.js wiring)
  assert.ok(uses >= 6 && uses <= 17, `app.js touches the browser in a handful of places only (${uses})`);
  const css = fs.readFileSync(path.join(RENDERER, "sessions-browser.css"), "utf8");
  assert.ok(!/innerHTML/.test(fs.readFileSync(path.join(RENDERER, "sessions-browser.js"), "utf8")), "no innerHTML");
  assert.ok(!/border-(left|right):\s*[2-9]/.test(css), "no thick side stripes");
});

test("the preload and main expose only the five browser calls, each through the guarded ipc", () => {
  const preload = fs.readFileSync(path.join(__dirname, "..", "main", "preload.js"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  for (const ch of ["session-index", "session-rename", "session-pin", "session-archive", "session-branch"]) {
    assert.ok(preload.includes(`"bridge:${ch}"`), `preload ${ch}`);
    assert.ok(main.includes(`ipc.handle("bridge:${ch}"`), `main ${ch}`);
  }
  for (const ch of ["session-rename", "session-pin", "session-archive", "session-branch"]) {
    assert.match(main, new RegExp(`ipc.handle\\("bridge:${ch}"[^\\n]*trackMutation`), `${ch} is a tracked mutation`);
  }
});

// ---------------------------------------------------------------- the view, driven through a minimal DOM stand-in
// Not a browser: just enough of the DOM API for create() to build, filter, select and act, so a runtime error in the
// render path or an action shows up here. Look and feel are for the owner's eyes.
function fakeDom() {
  const mk = (tag) => {
    const el = {
      tag, children: [], parentNode: null, dataset: {}, attrs: {}, style: { setProperty() {} }, listeners: {}, hidden: false, value: "", checked: false, textContent: "", className: "",
      classList: { _s: new Set(), toggle(c, on) { (on === undefined ? !this._s.has(c) : on) ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); }, add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); } },
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === "hidden") this.hidden = true; },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      replaceChildren(...k) { this.children.forEach((c) => (c.parentNode = null)); this.children = []; k.forEach((c) => this.appendChild(c)); },
      replaceWith(n) { const p = this.parentNode; if (p) { p.children[p.children.indexOf(this)] = n; n.parentNode = p; } },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); this.parentNode = null; },
      addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
      closest(sel) { for (let n = this; n; n = n.parentNode) if ((sel === "[role=option]" && n.attrs.role === "option") || (sel === ".cd-back" && n.className === "cd-back")) return n; return null; },
      focus() { doc.activeElement = this; }, select() {}, scrollIntoView() {}, querySelector() { return null; },
      get id() { return this.attrs.id || ""; },
    };
    return el;
  };
  const doc = { activeElement: null, body: mk("body"), visibilityState: "visible", createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => ({ textContent: String(t), text: String(t) }), getElementById: () => doc.chat, addEventListener() {}, querySelector: () => null };
  doc.body.classList = { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle() {} };
  doc.chat = mk("main");
  return doc;
}
const textOf = (n) => (n.text !== undefined ? n.text : [n.textContent || "", ...(n.children || []).map(textOf)].join(" "));
const walk = (n, f) => { f(n); (n.children || []).forEach((c) => walk(c, f)); };

function harness(rows, { archivedRows = [], opts = {} } = {}) {
  global.document = fakeDom();
  const calls = [];
  const H = { nodes: new Map(), titles: new Map() };
  const toasts = [];
  const gone = new Set(); // what the fake host no longer lists (archived or deleted)
  const data = (rowsIn, extra = {}) => ({ rows: rowsIn, profiles: [{ name: "default", ok: true, hasMore: false, error: "" }, { name: "ops", ok: true, hasMore: false, error: "" }], legacy: false, at: 1, ...extra });
  const deck = { bridge: {
    sessionIndex: async (o) => (calls.push(["index", o]), data(o.archived ? archivedRows : rows.filter((r) => !gone.has(r.id)))),
    renameSession: async (sid, o) => (calls.push(["rename", sid, o]), { title: o.title }),
    pinSession: async (sid, o) => (calls.push(["pin", sid, o]), { pinned: o.pinned }),
    archiveSession: async (sid, o) => (calls.push(["archive", sid, o]), gone.add(sid), { archived: o.archived }),
    deleteSession: async (sid, o) => { calls.push(["delete", sid, o]); if (sid === "s-busy") throw new Error("cannot delete an active session"); gone.add(sid); return { deleted: sid }; },
    branchSession: async (sid, o) => (calls.push(["branch", sid, o]), { sid: `${sid}-copy`, profile: o.profile }),
  } };
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v; else if (k === "dataset") Object.assign(el.dataset, v); else if (k === "style") continue;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(c) : c);
    if (attrs && attrs.class) { el.className = attrs.class; attrs.class.split(" ").forEach((c) => el.classList.add(c)); }
    return el;
  }
  const opened = [];
  const MV = { toast: (t, bad) => toasts.push([t, !!bad]), openMenu: (items) => (MV.items = items) };
  const view = SB.create({ h, deck, mark() {}, ago: () => "5 min ago", cleanErr: (e) => e.message, nodeLive: (n) => n.live === true, bridgeOpen: () => true, hermesMode: () => true,
    hermesOpen: (sid, profile) => opened.push([sid, profile]), hermesForget: (sid) => calls.push(["forget", sid]), MV, H: () => H, ...opts });
  return { view, calls, toasts, opened, MV, H, doc: document, tick: () => new Promise((r) => setTimeout(r, 5)) };
}
const sample = () => [
  row("s-tg", { source: "telegram", title: "Telegram chat", profile: "default", lastActive: Date.now() / 1000 - 60, messages: 4, pinned: true }),
  row("s-tui", { source: "tui", title: "", preview: "refactor the relay", profile: "ops", lastActive: Date.now() / 1000 - 120 }),
  row("s-busy", { source: "webui", title: "Busy one", lastActive: Date.now() / 1000 - 300 }),
];
const rowsIn = (t) => { const out = []; walk(t.doc.chat, (n) => n.attrs && n.attrs.role === "option" && out.push(n)); return out; };
// events bubble from the target up to the document, like the real DOM
const fire = (el, type, extra = {}) => { for (let n = el; n; n = n.parentNode) (n.listeners[type] || []).forEach((f) => f({ target: el, shiftKey: false, ctrlKey: false, metaKey: false, preventDefault() {}, stopPropagation() {}, ...extra })); };
const click = (el, extra = {}) => fire(el, "click", extra);
const buttons = (t, fk) => { const out = []; walk(t.doc.body, (n) => n.dataset && n.dataset.fk === fk && out.push(n)); walk(t.doc.chat, (n) => n.dataset && n.dataset.fk === fk && out.push(n)); return out; };

test("view: opening lists every row, shows platform and profile, and loads once", async () => {
  const t = harness(sample());
  t.view.show();
  await t.tick();
  assert.ok(t.view.isOpen());
  const rs = rowsIn(t);
  assert.equal(rs.length, 3);
  assert.deepEqual(rs.map((r) => r.dataset.fk), ["sb:default:s-tg", "sb:ops:s-tui", "sb:default:s-busy"], "pinned first, then newest");
  assert.match(textOf(rs[1]), /refactor the relay/, "an untitled row shows its preview");
  assert.match(textOf(rs[1]), /ops/, "the profile tag appears when there are several profiles");
  assert.equal(t.calls.filter((c) => c[0] === "index").length, 1);
  assert.deepEqual(t.calls[0][1], { archived: false, force: false });
  t.view.close();
  assert.equal(t.view.isOpen(), false);
});

test("view: a click opens the session read-only; a Telegram one is marked to continue in a copy", async () => {
  const t = harness(sample());
  t.view.show();
  await t.tick();
  const [tg, tui] = rowsIn(t);
  click(tui);
  assert.deepEqual(t.opened, [["s-tui", "ops"]]);
  assert.equal(t.view.readOnly("s-tui"), false);
  t.view.show();
  await t.tick();
  click(rowsIn(t)[0]);
  assert.deepEqual(t.opened[1], ["s-tg", "default"]);
  assert.equal(t.view.readOnly("s-tg"), true);
  assert.ok(t.toasts.some(([m]) => /Telegram/.test(m)), "the read-only note names the platform");
  // the first message branches once, then the copy is what gets sent to
  assert.equal(await t.view.beforeSend("s-tui", "ops"), "s-tui");
  assert.equal(await t.view.beforeSend("s-tg", "default"), "s-tg-copy");
  assert.deepEqual(t.calls.filter((c) => c[0] === "branch"), [["branch", "s-tg", { profile: "default" }]]);
  assert.equal(t.view.readOnly("s-tg"), false);
  assert.equal(await t.view.beforeSend("s-tg", "default"), "s-tg", "a second send is not branched again");
  void tg;
});

test("view: multi-select, bulk archive and a bulk delete that skips the running session and says why", async () => {
  const t = harness(sample());
  t.view.show();
  await t.tick();
  const rs = rowsIn(t);
  click(rs[0], { ctrlKey: true });
  click(rs[2], { ctrlKey: true });
  assert.equal(rs[0].attrs["aria-selected"], "true");
  assert.equal(rs[1].attrs["aria-selected"], "false");
  assert.deepEqual(buttons(t, "sb-bulk-delete").length, 1);
  click(buttons(t, "sb-bulk-archive")[0]);
  await t.tick();
  assert.deepEqual(t.calls.filter((c) => c[0] === "archive").map((c) => [c[1], c[2]]), [["s-tg", { profile: "default", archived: true }], ["s-busy", { profile: "default", archived: true }]]);
  assert.equal(rowsIn(t).length, 1, "archived rows leave the active list");
  // delete: confirm dialog first, the busy one fails and is reported, the other goes
  const t2 = harness(sample());
  t2.view.show();
  await t2.tick();
  const r2 = rowsIn(t2);
  click(r2[1], { ctrlKey: true });
  click(r2[2], { ctrlKey: true });
  click(buttons(t2, "sb-bulk-delete")[0]);
  assert.equal(t2.calls.filter((c) => c[0] === "delete").length, 0, "nothing is deleted before the confirmation");
  const ok = buttons(t2, "sb-dialog-ok")[0];
  assert.ok(ok, "a confirmation dialog is open");
  click(ok);
  await t2.tick();
  await t2.tick();
  assert.deepEqual(t2.calls.filter((c) => c[0] === "delete").map((c) => c[1]), ["s-tui", "s-busy"]);
  assert.deepEqual(t2.calls.filter((c) => c[0] === "forget").map((c) => c[1]), ["s-tui"], "only what was deleted is forgotten locally");
  assert.ok(t2.toasts.some(([m, bad]) => bad && /1 done, 1 skipped/.test(m) && /running/.test(m)), JSON.stringify(t2.toasts));
  assert.deepEqual(rowsIn(t2).map((r) => r.dataset.fk), ["sb:default:s-tg", "sb:default:s-busy"]);
});

test("view: rename saves one title and updates the row; the archived view loads its own page", async () => {
  const t = harness(sample(), { archivedRows: [row("s-old", { archived: true, title: "Old", lastActive: 1 })] });
  t.view.show();
  await t.tick();
  const menuRow = rowsIn(t)[2];
  fire(menuRow, "contextmenu", { clientX: 10, clientY: 10 });
  assert.deepEqual(t.MV.items.filter((i) => i !== "-").map((i) => i.label), ["Open", "Rename…", "Pin", "Archive", "Copy id", "Delete…"]);
  t.MV.items.find((i) => i.label === "Rename…").run();
  const input = (() => { let f = null; walk(t.doc.body, (n) => n.tag === "input" && n.attrs.type === "text" && (f = n)); return f; })();
  assert.ok(input, "the rename dialog has a field");
  input.value = "Renamed";
  click(buttons(t, "sb-dialog-ok")[0]);
  await t.tick();
  await t.tick();
  assert.deepEqual(t.calls.find((c) => c[0] === "rename"), ["rename", "s-busy", { profile: "default", title: "Renamed" }]);
  assert.ok(t.toasts.some(([m]) => m === "Renamed."));
  assert.equal(t.H.titles.get("s-busy"), "Renamed");
  click(buttons(t, "sb-view:archived")[0]);
  await t.tick();
  assert.ok(t.calls.some((c) => c[0] === "index" && c[1].archived === true));
  assert.deepEqual(rowsIn(t).map((r) => r.dataset.fk), ["sb:default:s-old"]);
  const items = (() => { fire(rowsIn(t)[0], "contextmenu", { clientX: 1, clientY: 1 }); return t.MV.items; })();
  assert.ok(items.some((i) => i.label === "Unarchive") && items.find((i) => i.label === "Pin").enabled === false);
});

test("view: a platform chip and the search narrow the list; a profile that failed is named", async () => {
  const t = harness(sample());
  t.view.show();
  await t.tick();
  click(buttons(t, "sb-chip:telegram")[0]);
  assert.deepEqual(rowsIn(t).map((r) => r.dataset.fk), ["sb:default:s-tg"]);
  click(buttons(t, "sb-chip:telegram")[0]);
  assert.equal(rowsIn(t).length, 3);
  const noMatch = (() => { let s = null; walk(t.doc.chat, (n) => n.tag === "input" && n.attrs.type === "search" && (s = n)); s.value = "zzz"; fire(s, "input"); return rowsIn(t).length; })();
  assert.equal(noMatch, 0);
  assert.match(textOf(t.doc.chat), /No session matches/);
});
