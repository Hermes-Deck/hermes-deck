"use strict";
// Run the renderer count paths and inbox boot with fixture data, never a live host.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { dom } = require("./inbox-dom-helper");
const F = require("../renderer/fleet-capsule");
const app = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
const inbox = fs.readFileSync(path.join(__dirname, "../renderer/inbox.js"), "utf8");
const request = (kind = "approval") => ({ id: "same", sid: "same", profile: "default", kind, choices: ["once", "deny"], questions: [] });
const host = (id, requests, status = "open") => ({ id, name: id, status, requests });

async function world(t, remote = []) {
  const { h, doc, win, walk } = dom();
  const services = new Map(), marks = [], published = new Map(), events = {};
  const H = { requests: [request()], nodes: new Map() };
  const SH = { service: name => services.get(name), provide: (name, value) => services.set(name, value),
    on() {}, mount() {}, main: () => "chat", setMain() {}, icon: () => h("svg"),
    FILTERS: ["needs", "all"], matchFilter: () => false, publish: (key, value) => published.set(key, value) };
  const ctx = { document: doc, DeckI18n: { t: (key, v) => v?.n !== undefined ? `${key}:${v.n}` : key },
    DeckUsage: { agoText: () => "now" },
    matchMedia: () => ({ matches: true }), setTimeout, clearTimeout, H, SH, h,
    store: new Map(), composerActivity: () => null, LA: { isOpen: () => false, setOpen() {} },
    workspace: null, botscreen: null, sidebarSources: null, rail: { view: "all", source: "all" }, unseen: new Set(),
    S: { relay: { status: "open" }, tg: { status: "open" }, settings: { firstRunDone: true }, unread: new Map() },
    els: { sum: h("div"), conn: h("div") }, agentList: () => [], chatModes: () => ["sessions"],
    chatMode: () => "sessions", hermesMode: () => true, hermesConn: () => null, renderModes() {}, renderFind() {},
    i18nText: key => key, i18nNode: key => key, mark: (...parts) => marks.push(parts),
    triageData: () => ({ bridgeStatus: "open", requests: [...H.requests] }),
    deck: { bridge: { onEvent: fn => { events.bridge = fn; }, answerApproval: async () => ({ status: "ok" }) },
      hosts: { onEvent: fn => { events.hosts = fn; }, requests: async () => remote, answer: async () => ({ status: "ok" }) } },
  };
  ctx.window = ctx;
  ctx.addEventListener = win.addEventListener.bind(win);
  ctx.removeEventListener = win.removeEventListener.bind(win);
  ctx.DeckShell = SH;
  vm.createContext(ctx);
  for (const [start, end] of [["  function pendingCount(", "  function desktopSync("],
    ["  function railScope(", "  function railFilter("],
    ["  function smartFilters(", "  /** Agents:"], ["  function renderTop(", "  /** The sidebar's mode switch"]]) {
    const a = app.indexOf(start), b = app.indexOf(end, a);
    assert.ok(a >= 0 && b > a);
    vm.runInContext(app.slice(a, b), ctx);
  }
  vm.runInContext(app.split("\n").filter(line => line.startsWith("  SH.provide(")).join("\n"), ctx);
  vm.runInContext(inbox, ctx); // actual boot, seed, subscriptions and initial inactive-host fetch
  await new Promise(resolve => setImmediate(resolve));
  const store = ctx.DeckInbox.store;
  const fleet = F.createFleet({ h, doc, win, shell: SH, store, t: ctx.DeckI18n.t, usage: {} });
  t.after(() => fleet.destroy());
  const count = (node, cls) => Number(walk(node).find(n => n.attrs.class === cls)?.children[0]?.split(":").at(-1) || 0);
  return { ctx, H, store, marks, events, check(n) {
    const nav = ctx.smartFilters(new Map());
    const needs = walk(nav).find(node => node.dataset.fk === "view:needs");
    ctx.renderTop();
    assert.deepEqual({
      pending: ctx.pendingCount(),
      sidebar: count(needs, "sh-count brass"),
      header: count(fleet.button, "tf-need"),
      shell: published.get("needs").count,
      desktop: ctx.desktopSummary().pending,
      inbox: store.items().filter(row => row.request).length,
    }, { pending: n, sidebar: n, header: n, shell: n, desktop: n, inbox: n });
  } };
}

test("all count surfaces include inactive hosts without merging equal ids or counting failures", async t => {
  const w = await world(t, [host("h2", [request("question")]), host("h3", [request()])]);
  w.store.feedBridge({ t: "snapshot", snapshot: { nodes: [
    { sid: "failed", state: "failed", terminalAt: Date.now() / 1000 },
    { sid: "done", state: "done", terminalAt: Date.now() / 1000 },
  ] } });
  w.check(3);
  assert.equal(w.H.requests.length, 1, "active-host source remains scoped");
  assert.equal(w.store.data.requests.length, 1);
  assert.equal(w.store.items().length, 5, "failed and completed rows exist but are not pending requests");
});

test("remote snapshots, removals, disconnects and answers refresh counts without an active-host event", async t => {
  const w = await world(t);
  w.check(1);
  const push = hosts => {
    w.marks.length = 0;
    w.events.hosts({ t: "requests", hosts });
    assert.ok(w.marks.some(parts => parts.includes("top") && parts.includes("rail")), "host push schedules count repaint");
  };
  push([host("h2", [request("question")]), host("h3", [request()])]);
  w.check(3);
  push([host("h2", []), host("h3", [request()])]);
  w.check(2);
  push([host("h3", [], "connecting")]);
  w.check(1);
  push([host("h3", [request()])]);
  w.check(2);
  w.marks.length = 0;
  assert.equal(await w.store.answer(w.store.items().find(row => row.host === "h3"), "once"), true);
  assert.ok(w.marks.some(parts => parts.includes("top") && parts.includes("rail")), "answer schedules count repaint");
  w.check(1);
  w.events.bridge({ t: "requests", list: [] });
  w.check(0); // stale H mirror must not resurrect a request removed from the inbox
});

test("pending count keeps the active-host fallback before inbox boot", () => {
  const ctx = { window: {}, H: { requests: [request()] } };
  vm.runInNewContext(app.slice(app.indexOf("  function pendingCount("), app.indexOf("  function desktopSummary(")), ctx);
  assert.equal(ctx.pendingCount(), 1);
  delete ctx.H;
  assert.equal(ctx.pendingCount(), 0);
});
