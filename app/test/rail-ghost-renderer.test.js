"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const src = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
function newSessionWorld({ untouched = true, profile = "default" } = {}) {
  const calls = [];
  const H = { sel: "new", nodes: new Map([["new", { profile }]]) };
  const ctx = { H, creating: false, bridgeOpen: () => true, chatMode: () => "sessions", SB: null,
    RG: { reusable: (sid, p) => untouched && p === profile, mint: async (p) => { calls.push(["create", { profile: p }]); return { sid: "second", profile: p }; }, leave: (sid) => { calls.push(["leave", sid]); } },
    els: { input: { focus: () => calls.push(["focus"]) } },
    deck: { bridge: { create: async (opts) => { calls.push(["create", opts]); return { sid: "second", profile: opts.profile }; } } },
    hermesSelect: (sid) => { calls.push(["select", sid]); H.sel = sid; },
    setFormMsg: () => {}, i18nText: (k) => k, cleanErr: String, console,
  };
  vm.createContext(ctx);
  const start = src.indexOf("  async function newHermesSession(");
  const end = src.indexOf("  function hermesSelect(", start);
  vm.runInContext(src.slice(start, end), ctx);
  return { ctx, calls };
}

test("Hermes rows trade letter coins and duplicate timestamps for compact status", () => {
  const start = src.indexOf("  function hermesRow(");
  const end = src.indexOf("  // ------------------------------------------------------------ session menu", start);
  const h = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat().filter((x) => x != null) });
  const ctx = { h, H: { sel: "one", requests: [] }, hermesTitle: (n) => n.title, nodeLive: (n) => n.active,
    isSubagent: () => false, hermesSelect() {}, H_STATE_TR: { idle: "idle" },
    ago: () => "2m", hm: () => "duplicate-clock", coin: () => h("span", { class: "coin" }),
    i18nText: (key, v) => v ? `${key} ${v.percent ?? ""}` : key, i18nNode: (k) => k,
  };
  vm.createContext(ctx); vm.runInContext(src.slice(start, end), ctx);
  const row = ctx.hermesRow({ sid: "one", title: "Long session title", state: "idle", steps: [], updatedAt: 1, source: "deck", ctxUsed: 82, ctxMax: 100 }, 0);
  const tree = JSON.stringify(row);
  assert.equal(tree.includes('"coin"'), false);
  assert.equal(tree.includes("duplicate-clock"), false);
  assert.equal(tree.includes("idle ·"), false);
  assert.equal(tree.includes("82%"), true);
  assert.equal(tree.includes("rail-monogram"), true);
  const normal = JSON.stringify(ctx.hermesRow({ sid: "two", title: "Other", state: "idle", steps: [], ctxUsed: 60, ctxMax: 100 }, 0));
  assert.equal(normal.includes("60%"), false, "no low-context noise");
  const live = JSON.stringify(ctx.hermesRow({ sid: "live", title: "Working", state: "thinking", active: true, steps: ["Searching"] }, 0));
  assert.equal(live.includes("rail-live-dot"), true);
  assert.equal(live.includes("Searching"), true);
  const head = src.slice(src.indexOf("  function renderHermesHead("), src.indexOf("  function hermesTextEl("));
  assert.equal(head.includes("coin(title"), false, "chat header also drops the letter coin");
});

test("New session creates for draft intent or a different profile, and serializes clicks", async () => {
  for (const opts of [{ untouched: false }, { profile: "work" }]) {
    const { ctx, calls } = newSessionWorld(opts);
    await ctx.newHermesSession("default");
    assert.equal(calls.filter(([type]) => type === "create").length, 1);
    assert.equal(ctx.H.sel, "second");
  }
  const { ctx, calls } = newSessionWorld({ untouched: false });
  let resolve;
  ctx.RG.mint = () => { calls.push(["create"]); return new Promise((r) => { resolve = r; }); };
  const first = ctx.newHermesSession("default");
  await ctx.newHermesSession("default");
  resolve({ sid: "second", profile: "default" }); await first;
  assert.equal(calls.filter(([type]) => type === "create").length, 1);
});

test("late New session replies do not steal a manually selected chat", async () => {
  const { ctx, calls } = newSessionWorld({ untouched: false });
  let resolve;
  ctx.RG.mint = () => new Promise((r) => { resolve = r; });
  const pending = ctx.newHermesSession("default");
  ctx.H.sel = "existing";
  resolve({ sid: "late", profile: "default" }); await pending;
  assert.equal(ctx.H.sel, "existing");
  assert.equal(calls.some(([type, sid]) => type === "leave" && sid === "late"), true);
  assert.equal(calls.some(([type]) => type === "select"), false);
});

test("renderer intent uses the correct draft, file tray, outbox and history for each session", () => {
  let d;
  const H = { sel: "new", nodes: new Map(), hist: new Map(), live: new Map(), echo: new Map() };
  const ctx = { H, window: { DeckRailSessions: { create: (deps) => { d = deps; return { bindUnload() {} }; } } },
    DR: { key: () => "hermes:new", read: () => null }, els: { input: { value: "" } },
    AT: { pending: () => false }, OB: { size: () => 0 }, nodeLive: (n) => n && n.active,
  };
  const start = src.indexOf("  const RG = ");
  const end = src.indexOf("  // All sessions (", start);
  vm.runInNewContext(src.slice(start, end), ctx);
  assert.equal(!!d.hasIntent("new"), false);
  ctx.els.input.value = "unsaved draft";
  assert.equal(!!d.hasIntent("new"), true, "current text protects before the draft debounce");
  assert.equal(!!d.hasIntent("other"), false, "another chat's text is not intent here");
  ctx.els.input.value = "";
  ctx.DR.read = (key) => key === "hermes:other" ? { text: "stored draft" } : null;
  assert.equal(!!d.hasIntent("other"), true);
  ctx.DR.read = () => null;
  ctx.AT.pending = (key) => key === "hermes:files";
  assert.equal(!!d.hasIntent("files"), true);
  assert.equal(!!d.hasIntent("new"), false);
  ctx.OB.size = (sid) => sid === "queue" ? 1 : 0;
  assert.equal(!!d.hasIntent("queue"), true);
  H.hist.set("history", { msgs: [{ role: "user" }] });
  H.nodes.set("active", { active: true });
  H.echo.set("echo", []); H.live.set("live", {});
  for (const sid of ["history", "active", "echo", "live"]) assert.equal(!!d.hasIntent(sid), true, sid);
});

test("host resumes close and reload as distinct unload actions", () => {
  const main = fs.readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  const start = main.indexOf("function resumeRailUnload()");
  assert.ok(start >= 0, "host unload resumer exists");
  const end = main.indexOf('\nipc.handle("bridge:unload-done"', start);
  for (const windowClosing of [true, false]) {
    const calls = [];
    const ctx = { windowClosing, appUrl: () => "deck://app/index.html?host=h1", win: { isDestroyed: () => false, close: () => calls.push("close"), loadURL: () => { calls.push("reload"); return Promise.resolve(); } } };
    vm.runInNewContext(main.slice(start, end) + "\nresumeRailUnload();", ctx);
    assert.deepEqual(calls, [windowClosing ? "close" : "reload"]);
  }
});

test("New session focuses an untouched current session instead of creating another", async () => {
  const { ctx, calls } = newSessionWorld();
  await ctx.newHermesSession("default");
  assert.deepEqual(calls, [["focus"]]);
});
