"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { notificationView } = require("../renderer/shell");
const { connectionState } = require("../renderer/settings-view");
const src = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
function functionSource(start, end) {
  const a = src.indexOf(start), b = src.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return src.slice(a, b);
}

test("notification identity requires the painted mode, session, profile and chat key", () => {
  for (const mode of ["telegram", "sessions", "bots"]) {
    const current = { mode, id: "one", key: mode === "telegram" ? "u1" : null, sid: "s1", profile: "work" };
    assert.equal(notificationView({ current, displayed: current, visible: true }).visible, true);
    assert.equal(notificationView({ current, displayed: current, visible: false }).visible, false);
    for (const key of ["mode", "id", "key", "sid", "profile"]) {
      const v = notificationView({ current, displayed: { ...current, [key]: "other" }, visible: true });
      assert.deepEqual(v, { channel: mode, key: null, sid: null, profile: null, visible: false });
    }
    assert.equal(notificationView({ current, visible: true }).visible, false, "loading has no painted chat");
  }
});

test("publication clears remembered selections for overlays, panes, hidden pages and a pending host switch", async () => {
  const calls = [];
  const state = { main: "chat", settings: false, usage: false, browser: false, right: null, detail: true };
  const c = { mode: "sessions", id: "s1", sid: "s1", profile: "work" };
  const ctx = {
    S: { settings: { firstRunDone: true }, tg: { status: "open" } }, hostSwitchPending: false,
    displayedChat: c, lastDesktopView: "", current: c,
    deck: { desktop: { view: v => calls.push(plain(v)) } },
    document: { hidden: false, getElementById: () => ({ hidden: state.detail }) },
    SH: { notificationView, main: () => state.main, right: () => ({ tab: state.right }) },
    SV: { isOpen: () => state.settings }, UD: { isOpen: () => state.usage },
    allSessionsView: () => ({ isOpen: () => state.browser }), hermesMode: () => ctx.current.mode !== "telegram",
    currentChat: () => ctx.current,
  };
  vm.createContext(ctx);
  vm.runInContext(functionSource("  function publishDesktopView()", "  function renderCrumb()"), ctx);
  ctx.publishDesktopView();
  assert.equal(calls.at(-1).visible, true);
  const checks = [
    [state, "main", "inbox"], [state, "settings", true], [state, "usage", true], [state, "browser", true],
    [state, "right", "browser"], [state, "right", "screen"], [state, "detail", false],
    [ctx.document, "hidden", true], [ctx, "hostSwitchPending", true], [ctx.S.settings, "firstRunDone", false],
  ];
  for (const [obj, key, value] of checks) {
    const before = obj[key]; obj[key] = value; ctx.publishDesktopView();
    assert.equal(calls.at(-1).visible, false, key);
    obj[key] = before; ctx.publishDesktopView();
    assert.equal(calls.at(-1).visible, true, `restored ${key}`);
  }
  ctx.current = { mode: "telegram", id: "u2", key: "u2", sid: null, profile: null };
  ctx.publishDesktopView();
  assert.equal(calls.at(-1).visible, false, "mode change clears immediately, before render settles");
  ctx.displayedChat = ctx.current; ctx.publishDesktopView();
  assert.deepEqual(calls.at(-1), { channel: "telegram", key: "u2", sid: null, profile: null, visible: true });
  ctx.S.tg.status = "login"; ctx.publishDesktopView();
  assert.equal(calls.at(-1).visible, false, "login is not reading the remembered chat");
  const count = calls.length; ctx.publishDesktopView();
  assert.equal(calls.length, count, "unchanged view sends no duplicate IPC");
  ctx.lastDesktopView = "";
  ctx.deck.desktop.view = () => Promise.reject(new Error("stale page"));
  ctx.publishDesktopView();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ctx.lastDesktopView, "", "refused publication can retry without an unhandled rejection");
});

test("host switch persists the draft before guarded selection, serializes clicks, and recovers on refusal", async () => {
  const calls = [];
  let reject;
  const ctx = { window: {}, hostSwitchPending: false, S: { settings: { activeHost: "h1" } },
    DR: { flush: () => calls.push("draft") }, renderHosts: () => calls.push("render"), publishDesktopView: () => calls.push("view"),
    deck: { hosts: { select: id => { calls.push(id); return new Promise((_resolve, no) => { reject = no; }); } } },
    MV: { toast: () => calls.push("error") }, i18nText: k => k, cleanErr: String,
  };
  vm.createContext(ctx);
  vm.runInContext(functionSource("  async function selectHost(id)", "  if (deck.hosts?.onEvent)"), ctx);
  await ctx.selectHost("h1"); assert.deepEqual(calls, []);
  const pending = ctx.selectHost("h2");
  await ctx.selectHost("h3");
  assert.deepEqual(calls, ["draft", "render", "view", "h2"]);
  assert.equal(ctx.hostSwitchPending, true);
  reject(new Error("stale page")); await pending;
  assert.equal(ctx.hostSwitchPending, false);
  assert.equal(calls.at(-1), "error");
});

// Exercise the real desktop callback, navigation functions, and feed callbacks together.
// Only DOM painting, IPC transport and feed decoding are fixture boundaries; no OS or network.
function sourceWorld({ host = "h1", storage = new Map(), ready = true } = {}) {
  const calls = [], frames = [], handlers = {};
  const ctx = {
    sourceOpenReady: ready, pendingSourceOpen: null, sourceRequestsReady: false,
    window: {},
    pageHost: host, hostSwitchPending: false, activeChatMode: "bots", scrollToEnd: false,
    S: { settings: { activeHost: host, hosts: [{ id: "h1" }, { id: "h2" }, { id: "h3" }], firstRunDone: true,
      chat: { modes: ["telegram", "sessions", "bots"], defaultMode: "bots" } },
      tg: { status: "open", bots: [{ key: "u101" }], topics: [] }, sel: null,
      unread: new Map(), loaded: new Set(["u101"]), loading: new Set(), relay: { sessions: new Map() } },
    H: { status: { status: "open" }, nodes: new Map(), stored: new Map(), hist: new Map(), requests: [], answers: new Map(), sel: null,
      snap: [], deleted: new Set(), gone: new Map(), ctl: new Map(), titles: new Map() },
    sessionStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    store: { set: (k, v) => calls.push(["store", k, v]) },
    DR: { flush: () => calls.push(["draft"]), sync: () => calls.push(["draft-sync"]) },
    deck: { hosts: { select: async id => { calls.push(["host", id]); } },
      bridge: { onEvent: cb => { handlers.bridge = cb; }, answer: () => assert.fail("body click answered") },
      history: async () => [], onTelegram: cb => { handlers.telegram = cb; }, onRelay: cb => { handlers.relay = cb; }, rendered() {} },
    desk: { onEvent: cb => { handlers.desktop = cb; } },
    document: { activeElement: { blur: () => calls.push(["blur"]) }, querySelectorAll: () => ctx.H.requests.map(r => ({
      dataset: { requestId: r.id, requestProfile: r.profile }, scrollIntoView() {}, focus: () => calls.push(["focus", r.id, r.profile]),
    })) },
    requestAnimationFrame: cb => { frames.push(cb); },
    CM: require("../renderer/chat-modes"),
    chatModes: () => ctx.S.settings.chat.modes, chatMode: () => ctx.activeChatMode,
    hermesMode: () => ctx.activeChatMode !== "telegram", bridgeOpen: () => ctx.H.status.status === "open",
    syncChatMode: mode => { ctx.activeChatMode = mode; calls.push(["mode", mode]); },
    SV: { close() {}, refresh() {} }, UD: { close() {} }, SH: { setMain: v => calls.push(["main", v]) },
    SB: { isOpen: () => false, close() {} }, allSessionsView: () => ctx.SB,
    RG: { leave() {} }, BT: null, AG: null,
    renderHosts() {}, publishDesktopView() {}, mark() {}, renderNote() {}, renderMsgs() {}, hermesPoll() {},
    hermesLoadHistory: sid => calls.push(["history", sid, ctx.H.nodes.get(sid)?.profile || ctx.H.hist.get(sid)?.profile]),
    MV: { toast: () => calls.push(["error"]) }, i18nText: k => k, cleanErr: String,
    refreshSettingsPane() {}, setRailView: v => calls.push(["rail", v]),
    applyDetail() {},
    applyBridgeStatus: m => { ctx.H.status = m; },
    applyBridgeEvent() {}, refreshHermesProfiles() {}, hermesRank() {}, outboxDrain() {}, hermesAutoSelect() {},
    updateBridgeStatusLine() {}, liveRowRefresh() {}, nodeLive: () => false,
    applyTgStatus: m => Object.assign(ctx.S.tg, m), applyDialogs: m => Object.assign(ctx.S.tg, m),
  };
  vm.createContext(ctx);
  const names = ["selectHost", "setChatChannel", "select", "hermesSelect", "hermesOpen", "hHist", "openChatFor",
    "validSourceOpen", "clearSourceOpen", "restoreSourceOpen", "openSource", "resumeSourceOpen", "focusRequest",
    "applyBridgeSnapshot", "applyBridgeSessions", "hermesMergeNodes"];
  for (const name of names) {
    const match = src.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  }`));
    if (match) vm.runInContext(match[0], ctx);
  }
  vm.runInContext(functionSource("    desk.onEvent((e) => {", "\n  // ---------------------------------------------------------------- direct Hermes").replace(/\n  }\s*$/, ""), ctx);
  vm.runInContext(functionSource("  deck.bridge.onEvent((m) => {", "  document.addEventListener(\"visibilitychange\", () => hermesPoll());"), ctx);
  vm.runInContext(functionSource("  deck.onTelegram((m) => {", "  // ---------------------------------------------------------------- desktop shell"), ctx);
  vm.runInContext(functionSource("  deck.onRelay((m) => {", "  deck.onTelegram((m) => {"), ctx);
  return { ctx, calls, storage, emit: e => handlers.desktop(e), bridge: m => handlers.bridge(m),
    telegram: m => handlers.telegram(m),
    relay: m => handlers.relay(m),
    frames: () => { while (frames.length) frames.shift()(); },
    boot: () => vm.runInContext(functionSource("    sourceOpenReady = true;", "    deck.rendered();"), ctx),
  };
}
const sourceTarget = (extra = {}) => ({ t: "source-open", hostId: "h1", channel: "sessions", key: null, sid: "s-one", profile: "work", ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("source-open desktop event selects exact same-host Telegram and Sessions, without answering", async () => {
  const w = sourceWorld();
  w.emit(sourceTarget({ channel: "telegram", key: "u101", sid: null, profile: null }));
  await tick();
  assert.equal(w.ctx.S.sel, "u101");
  assert.equal(w.ctx.activeChatMode, "telegram");
  w.ctx.H.nodes.set("s-one", { sid: "s-one", profile: "work" });
  w.emit(sourceTarget()); await tick();
  assert.equal(w.ctx.H.sel, "s-one");
  assert.equal(w.ctx.activeChatMode, "sessions");
  assert.ok(w.calls.some(c => c[0] === "history" && c[2] === "work"));
  assert.equal(w.storage.size, 0);
});

for (const request of [false, true]) test(`source-open closes unrelated session details before ${request ? "request focus" : "completion navigation"}`, async () => {
  const w = sourceWorld(); let detail = true;
  w.ctx.AG = { close: () => { detail = false; w.calls.push(["detail-close"]); } };
  w.ctx.H.nodes.set("s-one", { sid: "s-one", profile: "work" });
  if (request) w.bridge({ t: "requests", list: [{ id: "r-one", sid: "s-one", profile: "work" }] });
  w.emit(sourceTarget(request ? { id: "r-one" } : {})); await tick(); w.frames();
  assert.equal(detail, false); assert.equal(w.ctx.H.sel, "s-one");
  assert.ok(w.calls.findIndex(c => c[0] === "detail-close") < w.calls.findIndex(c => c[0] === "history"));
  if (request) assert.ok(w.calls.some(c => c[0] === "focus"));
});
test("relay-only source navigation consumes exact identity on immediate and late relay feeds", async () => {
  for (const arrival of ["immediate", "snapshot", "evs"]) {
    const w = sourceWorld(), opened = [];
    w.ctx.H.status.status = "off";
    w.ctx.AG = { close() {}, onRelay() {}, open: sid => opened.push(sid) };
    const snapshot = { t: "snapshot", sessions: [{ sid: "s-one", profile: "work", source: "cli" }] };
    if (arrival === "immediate") w.relay(snapshot);
    w.emit(sourceTarget()); await tick();
    if (arrival !== "immediate") { assert.deepEqual(opened, []); w.relay({ ...snapshot, t: arrival }); await tick(); }
    assert.deepEqual(opened, ["s-one"]); assert.equal(w.ctx.pendingSourceOpen, null);
    assert.equal(w.ctx.H.sel, null); assert.ok(!w.calls.some(c => c[0] === "history"));
    w.relay(snapshot); assert.equal(opened.length, 1);
  }
});
test("relay-only source navigation survives the guarded cross-host reload", async () => {
  const a = sourceWorld(); a.emit(sourceTarget({ hostId: "h2" })); await tick();
  const b = sourceWorld({ host: "h2", storage: a.storage, ready: false }), opened = [];
  b.ctx.AG = { close() {}, onRelay() {}, open: sid => opened.push(sid) };
  b.ctx.H.status.status = "off";
  b.boot(); await tick(); assert.deepEqual(opened, []);
  b.relay({ t: "snapshot", sessions: [{ sid: "s-one", profile: "work" }] }); await tick();
  assert.deepEqual(opened, ["s-one"]); assert.equal(b.storage.size, 0);
  assert.ok(!b.calls.some(c => c[0] === "history"));
});
test("relay fallback preserves host, profile, mode, connection and request guards", async () => {
  for (const variant of ["profile", "missing-profile", "host", "mode", "connecting", "offline", "request"]) {
    const w = sourceWorld(), opened = [];
    w.ctx.H.status.status = ["connecting", "offline"].includes(variant) ? variant : "off";
    w.ctx.AG = { close() {}, open: sid => opened.push(sid) };
    w.ctx.S.relay.sessions.set("s-one", { sid: "s-one", profile: variant === "profile" ? "other" : variant === "missing-profile" ? undefined : "work" });
    if (variant === "host") w.ctx.S.settings.activeHost = "h2";
    if (variant === "mode") w.ctx.S.settings.chat.modes = ["bots"];
    if (variant === "request") w.bridge({ t: "requests", list: [{ id: "r-one", sid: "s-one", profile: "work" }] });
    w.emit(sourceTarget(variant === "request" ? { id: "r-one" } : {})); await tick();
    assert.deepEqual(opened, [], variant);
  }
});

test("source-open cross-host uses draft guard, persists through reload and waits for exact session", async () => {
  const a = sourceWorld();
  a.emit(sourceTarget({ hostId: "h2" })); await tick();
  assert.deepEqual(a.calls.slice(0, 2), [["draft"], ["host", "h2"]]);
  assert.equal(a.ctx.H.sel, null);
  assert.equal(a.storage.size, 1);
  const b = sourceWorld({ host: "h2", storage: a.storage, ready: false });
  b.boot(); await tick();
  assert.equal(b.ctx.H.sel, null);
  b.bridge({ t: "snapshot", snapshot: { nodes: [{ sid: "s-one", profile: "other" }] } }); await tick();
  assert.equal(b.ctx.H.sel, null, "equal sid in another profile is never selected");
  // Wrong profile is a hard refusal, not permission to wait for a different identity.
  b.bridge({ t: "snapshot", snapshot: { nodes: [{ sid: "s-one", profile: "work" }] } }); await tick();
  assert.equal(b.ctx.H.sel, null);
  b.emit(sourceTarget({ hostId: "h2" })); await tick();
  assert.equal(b.ctx.H.sel, "s-one");
  assert.equal(b.storage.size, 0);
});

test("source-open late session/request arrival focuses review; revocation before paint fails closed", async () => {
  const w = sourceWorld();
  w.emit(sourceTarget({ id: "r-one" })); await tick();
  w.bridge({ t: "snapshot", snapshot: { nodes: [{ sid: "s-one", profile: "work" }] } }); await tick();
  assert.equal(w.ctx.H.sel, null, "request list has not arrived");
  const request = { id: "r-one", sid: "s-one", profile: "work" };
  w.bridge({ t: "requests", list: [request] }); await tick(); w.frames();
  assert.equal(w.ctx.H.sel, "s-one");
  assert.ok(w.calls.some(c => c[0] === "focus"));
  w.calls.length = 0;
  w.emit(sourceTarget({ id: "r-one" })); await tick();
  w.bridge({ t: "requests", list: [] }); w.frames();
  assert.ok(!w.calls.some(c => c[0] === "focus"));
  w.ctx.H.sel = null; w.emit(sourceTarget({ id: "r-one" })); await tick();
  assert.equal(w.ctx.H.sel, null, "stale request does not navigate");
});

test("source-open failed host selection clears intent; overlapping navigation cannot replace it", async () => {
  const w = sourceWorld(); let reject;
  w.ctx.deck.hosts.select = id => { w.calls.push(["host", id]); return new Promise((_r, no) => { reject = no; }); };
  w.emit(sourceTarget({ hostId: "h2" }));
  w.emit(sourceTarget({ hostId: "h3", sid: "s-other" })); await tick();
  assert.deepEqual(w.calls.filter(c => c[0] === "host"), [["host", "h2"]]);
  assert.equal(JSON.parse([...w.storage.values()][0]).hostId, "h2");
  reject(new Error("removed")); await tick();
  assert.equal(w.storage.size, 0);
  assert.equal(w.ctx.hostSwitchPending, false);
  assert.equal(w.ctx.H.sel, null);
});

test("source-open rejects removed hosts, stale page identity, malformed targets and disabled modes", async () => {
  for (const extra of [{ hostId: "removed" }, { channel: "wrong" }, { sid: "" }, { profile: null }, { id: {} }, { channel: "telegram", key: "u101 trailing" }]) {
    const w = sourceWorld(); w.emit(sourceTarget(extra)); await tick();
    assert.equal(w.calls.length, 0, JSON.stringify(extra));
    assert.equal(w.storage.size, 0);
  }
  const w = sourceWorld(); w.ctx.S.settings.activeHost = "h2";
  w.emit(sourceTarget()); await tick(); assert.equal(w.calls.length, 0);
  const d = sourceWorld(); d.ctx.S.settings.chat.modes = ["bots"];
  d.ctx.H.nodes.set("s-one", { sid: "s-one", profile: "work" });
  d.emit(sourceTarget()); await tick(); assert.equal(d.ctx.H.sel, null);
});

test("source-open unknown source uses only an exact known Sessions target, never saved Bots mode", async () => {
  const w = sourceWorld(); w.emit(sourceTarget({ channel: null })); await tick();
  assert.equal(w.ctx.H.sel, null);
  w.bridge({ t: "sessions", list: [{ id: "s-one", profile: "work" }] }); await tick();
  assert.equal(w.ctx.H.sel, "s-one"); assert.equal(w.ctx.activeChatMode, "sessions");
});

test("source-open reload resumes once after late connection and Telegram dialogs; old host cannot consume it", async () => {
  const a = sourceWorld();
  a.emit(sourceTarget({ hostId: "h2" })); await tick();
  const b = sourceWorld({ host: "h2", storage: a.storage, ready: false });
  b.ctx.H.status.status = "connecting";
  b.bridge({ t: "snapshot", snapshot: { nodes: [{ sid: "s-one", profile: "work" }] } });
  b.boot(); await tick(); assert.equal(b.ctx.H.sel, null);
  b.bridge({ t: "status", status: "open" }); await tick();
  assert.equal(b.ctx.H.sel, "s-one"); assert.equal(b.storage.size, 0);
  b.ctx.H.sel = "s-manual";
  b.bridge({ t: "snapshot", snapshot: { nodes: [{ sid: "s-one", profile: "work" }] } });
  assert.equal(b.ctx.H.sel, "s-manual", "consumed intent does not replay");

  const t = sourceWorld({ ready: false });
  t.ctx.S.tg.bots = []; t.ctx.S.tg.status = "starting";
  t.emit(sourceTarget({ channel: "telegram", key: "t202", sid: null, profile: null }));
  t.boot(); await tick(); assert.equal(t.ctx.S.sel, null);
  t.telegram({ t: "dialogs", bots: [], topics: [{ key: "t202", id: "202" }] });
  assert.equal(t.ctx.S.sel, null);
  t.telegram({ t: "status", status: "open" }); await tick();
  assert.equal(t.ctx.S.sel, "t202"); assert.equal(t.ctx.activeChatMode, "telegram");
});

test("source-open reload rejects removed/mismatched hosts, expired targets and blocked persistence", async () => {
  for (const change of [w => { w.ctx.S.settings.hosts = [{ id: "h1" }]; },
    w => { w.ctx.S.settings.activeHost = "h3"; },
    w => { const e = JSON.parse([...w.storage.values()][0]); e.expiresAt = 1; w.storage.set("deck.source-open", JSON.stringify(e)); }]) {
    const a = sourceWorld(); a.emit(sourceTarget({ hostId: "h2" })); await tick();
    const b = sourceWorld({ host: "h2", storage: a.storage, ready: false });
    change(b); b.boot(); await tick();
    assert.equal(b.calls.length, 0); assert.equal(b.storage.size, 0);
  }
  const w = sourceWorld(); w.ctx.sessionStorage.setItem = () => { throw new Error("blocked"); };
  w.emit(sourceTarget({ hostId: "h2" })); await tick();
  assert.equal(w.calls.length, 0, "never switch if the destination would be lost");
});

test("source-open focus cannot cross a later host or conversation navigation; legacy clicks still work", async () => {
  const w = sourceWorld();
  const request = { id: "r-one", sid: "s-one", profile: "work" };
  w.ctx.H.nodes.set("s-one", { sid: "s-one", profile: "work" });
  w.bridge({ t: "requests", list: [request] });
  w.emit(sourceTarget({ id: "r-one" })); await tick();
  w.ctx.S.settings.activeHost = "h2"; w.frames();
  assert.ok(!w.calls.some(c => c[0] === "focus"));
  w.ctx.S.settings.activeHost = "h1";
  w.emit({ t: "request-open", ...request }); w.frames();
  assert.ok(w.calls.some(c => c[0] === "focus"));
  w.calls.length = 0;
  w.emit(sourceTarget({ id: "r-one" })); await tick();
  w.ctx.H.sel = "s-other"; w.frames();
  assert.ok(!w.calls.some(c => c[0] === "focus"));
  w.emit({ t: "select", key: "u101" }); await tick();
  assert.equal(w.ctx.S.sel, "u101");
  w.emit({ t: "select", key: "hs:s-one", profile: "work" });
  assert.equal(w.ctx.H.sel, "s-one");
});

test("source-open waits for fresh requests after disconnect, and Bots retains its explicit channel", async () => {
  const w = sourceWorld();
  const request = { id: "r-one", sid: "s-one", profile: "work" };
  w.ctx.H.nodes.set("s-one", { sid: "s-one", profile: "work" });
  w.bridge({ t: "requests", list: [request] });
  w.emit(sourceTarget({ id: "r-one", channel: "bots" })); await tick();
  assert.equal(w.ctx.activeChatMode, "bots");
  w.bridge({ t: "status", status: "offline" }); w.frames();
  assert.ok(!w.calls.some(c => c[0] === "focus"));
  w.ctx.H.sel = null;
  w.emit(sourceTarget({ id: "r-one" }));
  w.bridge({ t: "status", status: "open" }); await tick();
  assert.equal(w.ctx.H.sel, null, "a reconnect cannot reuse the old request list");
  w.bridge({ t: "requests", list: [] }); await tick();
  assert.equal(w.ctx.H.sel, null);
});

test("connection labels distinguish observed state from config, including unwatched relay", () => {
  assert.equal(connectionState(false, "open"), "unconfigured");
  for (const status of [null, undefined, "off"]) assert.equal(connectionState(true, status), "saved");
  assert.equal(connectionState(true, "open"), "open");
  assert.equal(connectionState(true, "connecting"), "connecting");
  for (const status of ["closed", "error", "protocol"]) assert.equal(connectionState(true, status), "offline");
});

test("view publication is wired to render completion, navigation, visibility and the named preload door", () => {
  const preload = fs.readFileSync(path.join(__dirname, "../main/preload.js"), "utf8");
  assert.match(preload, /view: \(value\) => ipcRenderer\.invoke\("desktop:view", value\)/);
  assert.match(src, /SH\.on\("main", publishDesktopView\)/);
  assert.match(src, /addEventListener\("visibilitychange", publishDesktopView\)/);
  assert.match(functionSource("  function mark(", "  function flush("), /publishDesktopView\(\)/);
  assert.match(functionSource("  function renderMsgs(", "  \/\/ ---------------------------------------------------------------- first-run"), /displayedChat =/);
  assert.match(functionSource("  function renderHermesMsgs(", "  function renderHermesStrip("), /return true/);
  assert.match(src, /selectHost,\n    hostStates:/, "Settings Switch reuses the same draft-safe path");
});
