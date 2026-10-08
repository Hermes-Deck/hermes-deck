"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const I18N = require("../renderer/i18n");
const SVM = require("../renderer/settings-view");
const SRC = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
beforeEach(() => I18N.setLanguage("en"));
const plain = (v) => JSON.parse(JSON.stringify(v));

function world({ mode = "telegram", hidden = [], fail = false } = {}) {
  const menus = [], saves = [], toasts = [], notes = [], marks = [];
  const bots = [
    { key: "u1", username: "AgentBot", title: "Example agent" },
    { key: "u2", username: "ExampleBot", title: "Example bot" },
    { key: "u3", username: null, title: "Unnamed bot" },
  ];
  const h = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, dataset: attrs?.dataset || {}, kids });
  const ctx = {
    S: { settings: { hiddenBots: hidden }, tg: { bots, topics: [], status: "open" }, sel: "u2",
      relay: { agents: { example: { name: "Example agent", bot: "AgentBot" } }, status: "open" },
      unread: new Map(), msgs: new Map(), loaded: new Set(), avatars: {} },
    SVM, h, i18nText: I18N.t, i18nNode: I18N.t, chatMode: () => mode,
    latestTop: () => null, typingNow: () => false, lastMsg: () => null, coin: () => null,
    store: { get: () => null, set() {} }, reads: { forget() {} },
    select: (key) => { ctx.S.sel = key; },
    MV: { openMenu: (items, row, pos, label) => menus.push({ items, row, pos, label }), toast: (s) => toasts.push(s) },
    deck: { settingsSave: async (patch) => {
      saves.push(plain(patch));
      if (fail) throw new Error("save unavailable");
      return { ...ctx.S.settings, ...patch };
    } },
    applyWallpaper() {}, settingsMessage: (ok, text) => notes.push({ ok, text }),
    mark: (...args) => marks.push(args), cleanErr: (e) => e.message,
  };
  vm.createContext(ctx);
  for (const [start, end] of [
    ["  const agentList =", "  function scopeOf("],
    ["  function agentRow(", "  function topicRow("],
    ["  async function saveSettings(", "  /** A save through another IPC call"],
    ["  function applyDialogs(", "  deck.onRelay("],
  ]) vm.runInContext(SRC.slice(SRC.indexOf(start), SRC.indexOf(end, SRC.indexOf(start))), ctx);
  global.document = { addEventListener() {} };
  ctx.SV = SVM.create({ h, settings: () => ctx.S.settings, save: (patch, ok) => ctx.saveSettings(patch, ok) });
  const row = (key) => ctx.agentRow(ctx.railAgents().find((it) => it.key === key));
  const fire = (row, type, extra = {}) => {
    const e = { currentTarget: row, target: row, clientX: 12, clientY: 34, preventDefault() { this.prevented = true; }, ...extra };
    row.attrs[`on${type}`]?.(e);
    return e;
  };
  const open = () => { const r = row("u2"); fire(r, "contextmenu"); assert.equal(menus.length, 1, "eligible bot opens a menu"); return menus[0]; };
  return { ctx, menus, saves, toasts, notes, marks, row, fire, open };
}

test("bot menu: only Telegram non-agent rows with a username offer Hide from list", () => {
  const w = world();
  const menu = w.open();
  assert.equal(menu.items.length, 1);
  assert.equal(menu.items[0].label, "Hide from list");
  assert.deepEqual(plain(menu.pos), { x: 12, y: 34 });
  for (const key of ["u1", "u3"]) w.fire(w.row(key), "contextmenu");
  assert.equal(w.menus.length, 1, "agent and username-less rows have no hide menu");
  for (const mode of ["bots", "sessions"]) {
    const other = world({ mode });
    other.fire(other.row("u2"), "contextmenu");
    assert.equal(other.menus.length, 0);
  }
});

test("bot menu: ContextMenu and Shift+F10 open once at the row", () => {
  for (const key of ["ContextMenu", "F10"]) {
    const w = world(), r = w.row("u2");
    assert.equal(w.fire(r, "keydown", { key, shiftKey: true }).prevented, true);
    assert.equal(w.menus.length, 1);
    assert.equal(w.menus[0].pos, null);
    w.fire(r, "contextmenu", { clientX: 0, clientY: 0 });
    w.fire(r, "keydown", { key: "F10", shiftKey: false });
    assert.equal(w.menus.length, 1);
  }
});

test("hiding merges current settings case-insensitively, removes the row and moves selection", async () => {
  const w = world();
  const menu = w.open();
  w.ctx.S.settings.hiddenBots = ["BotFather", "botfather", "OtherBot"];
  await menu.items[0].run();
  assert.deepEqual(w.saves, [{ hiddenBots: ["BotFather", "OtherBot", "ExampleBot"] }]);
  assert.deepEqual(plain(w.ctx.railAgents().map((it) => it.key)), ["u1", "u3"]);
  assert.equal(w.ctx.S.sel, "u1");
  assert.match(w.toasts[0], /Settings.*Telegram/);
  assert.ok(w.marks.some((args) => args.includes("rail")));
});

test("hiding the last bot clears selection; hiding another leaves the selected chat alone", async () => {
  for (const last of [true, false]) {
    const w = world();
    if (last) w.ctx.S.tg.bots = w.ctx.S.tg.bots.filter((b) => b.key === "u2");
    else w.ctx.S.sel = "u1";
    await w.open().items[0].run();
    assert.equal(w.ctx.S.sel, last ? null : "u1");
  }
});

test("failed hiding keeps the row and selection and shows the error", async () => {
  const w = world({ fail: true });
  await w.open().items[0].run();
  assert.equal(w.ctx.S.sel, "u2");
  assert.equal(w.ctx.railAgents().length, 3);
  assert.equal(w.notes.at(-1).ok, false);
  assert.match(w.toasts.at(-1), /save unavailable/);
});

test("Show survives dialogs arriving before the settings save reply", async () => {
  const w = world({ hidden: ["ExampleBot"] });
  w.ctx.S.sel = "u1";
  const incoming = plain(w.ctx.S.tg);
  w.ctx.deck.settingsSave = async () => {
    w.ctx.applyDialogs(incoming);
    return { hiddenBots: [] };
  };
  await w.ctx.saveSettings({ hiddenBots: [] }, "Saved");
  assert.deepEqual(plain(w.ctx.railAgents().map((it) => it.key)), ["u1", "u2", "u3"]);
  assert.equal(w.ctx.S.sel, "u1");
});

test("concurrent hides wait for the preceding save and preserve both usernames", async () => {
  const w = world({ hidden: ["BotFather"] });
  w.ctx.S.tg.bots.push({ key: "u4", username: "OtherBot", title: "Other bot" });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  w.ctx.deck.settingsSave = async (patch) => {
    w.saves.push(plain(patch));
    if (w.saves.length === 1) await pending;
    return { hiddenBots: patch.hiddenBots };
  };
  const first = w.open().items[0].run();
  await new Promise(setImmediate);
  w.fire(w.row("u4"), "contextmenu");
  const second = w.menus[1].items[0].run();
  await new Promise(setImmediate);
  const beforeReply = w.saves.length;
  release();
  await Promise.all([first, second]);
  assert.equal(beforeReply, 1, "only one hidden-bot save may be in flight");
  assert.deepEqual(plain(w.ctx.S.settings.hiddenBots), ["BotFather", "ExampleBot", "OtherBot"]);
});

test("hidden-bot copy exists in both languages with matching placeholders", () => {
  for (const key of ["hiddenBots.hide", "hiddenBots.hidden", "hiddenBots.menu", "hiddenBots.show", "hiddenBots.add", "hiddenBots.username", "hiddenBots.empty", "hiddenBots.limit"]) {
    for (const lang of ["en", "tr"]) assert.equal(typeof I18N.tables[lang][key], "string", `${lang}: ${key}`);
    const slots = (s) => (s.match(/\{\w+\}/g) || []).sort();
    assert.deepEqual(slots(I18N.tables.en[key]), slots(I18N.tables.tr[key]), key);
  }
  assert.equal(I18N.tables.tr["hiddenBots.hide"], "Listeden gizle");
  assert.equal(I18N.tables.tr["hiddenBots.show"], "Göster");
});
