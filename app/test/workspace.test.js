"use strict";
// Workspace tab, offline: the deck's half of the CDP tunnel tells the agent-browser host which page each of
// the agent's commands acts on (the live view follows it) and what is real use, and the host keeps
// bookkeeping apart from use. A fake CDP endpoint stands in for Chrome; no browser is launched.
//   node --test "app/test/*.test.js"   (the real-browser checks are in scripts/workspace-e2e.js)
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const { CdpTunnel, OP, encodeFrame, decodeFrame } = require("../main/cdp-tunnel");
const { AgentBrowserHost } = require("../main/agent-browser");
const { normalizeUrl, wallOf, LiveView, USER_ONLY } = require("../main/cdp-view");
const { EventEmitter } = require("events");
const { setLanguage } = require("../renderer/i18n");
setLanguage("tr");

const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A stand-in for Chrome's browser socket: attach answers a session, createTarget a new page, the rest {}. */
function fakeChrome() {
  const srv = http.createServer();
  const wss = new WebSocket.WebSocketServer({ server: srv });
  wss.on("connection", (ws) =>
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      const result = m.method === "Target.attachToTarget" ? { sessionId: `S-${m.params.targetId}` } : m.method === "Target.createTarget" ? { targetId: "NEW1" } : {};
      ws.send(JSON.stringify({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
    })
  );
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ port: srv.address().port, close: () => (wss.clients.forEach((c) => c.terminate()), srv.close()) })));
}

test("tunnel: each agent command is read for the live view (which page, real use or bookkeeping)", async (t) => {
  const chrome = await fakeChrome();
  t.after(() => chrome.close());
  const notes = [];
  const host = {
    enabled: () => true,
    ensure: async () => ({ port: chrome.port, wsPath: "/devtools/browser/fake" }),
    controller: () => "agent",
    downloadDir: () => path.join(os.tmpdir(), "dl"),
    channelOpened() {},
    channelClosed() {},
    noteAgent: (slug, method, hint) => notes.push({ slug, method, ...hint }),
    touch() {},
  };
  const out = [];
  const tunnel = new CdpTunnel({ host, send: (buf) => out.push(decodeFrame(buf)) || true });
  tunnel.onFrame(encodeFrame(OP.OPEN, 7, { slug: "scout", path: "/devtools/browser/abc", kind: "agent" }));
  await until(() => out.some((f) => f.op === OP.OPENED));
  const cmd = (m) => tunnel.onFrame(encodeFrame(OP.DATA, 7, JSON.stringify(m)));
  const answered = (id) => until(() => out.some((f) => f.op === OP.DATA && JSON.parse(f.payload).id === id));

  cmd({ id: 1, method: "Target.attachToTarget", params: { targetId: "PAGE1", flatten: true } });
  await answered(1);
  cmd({ id: 2, method: "Page.enable", sessionId: "S-PAGE1" });
  cmd({ id: 3, method: "Page.navigate", params: { url: "https://example.com/" }, sessionId: "S-PAGE1" });
  cmd({ id: 4, method: "Target.createTarget", params: { url: "about:blank", background: true } });
  await answered(4);
  await until(() => notes.some((n) => n.act === "create"));
  assert.deepEqual(
    notes.map((n) => [n.method, n.use, n.act, n.targetId]),
    [
      ["Target.attachToTarget", false, null, null],
      ["Page.enable", false, null, "PAGE1"],
      ["Page.navigate", true, "nav", "PAGE1"],
      ["Target.createTarget", true, null, null],
      ["Target.createTarget", true, "create", "NEW1"], // the browser's answer names the new page
    ]
  );
  tunnel.closeAll("done");
});

test("agent-browser host: bookkeeping keeps the browser alive but is not use; acts reach the live view", () => {
  const host = new AgentBrowserHost({ root: path.join(os.tmpdir(), "deck-ws-test"), enabled: false });
  const b = host.get("scout");
  const acts = [];
  b.on("agent-act", (a) => acts.push(a));
  host.noteAgent("scout", "Target.attachToTarget", { use: false, act: null, targetId: null });
  host.noteAgent("scout", "Runtime.enable", { use: false, act: null, targetId: "P1" });
  assert.equal(b.lastAgentAt, 0, "attach/enable is not use");
  assert.ok(b.lastUsed > 0);
  host.noteAgent("scout", "Page.navigate", { use: true, act: "nav", targetId: "P1" });
  assert.ok(b.lastAgentAt > 0);
  assert.equal(b.lastAgentMethod, "Page.navigate");
  assert.deepEqual(acts.map((a) => [a.act, a.targetId]), [["nav", "P1"]]);
  assert.deepEqual(b.lastAct && [b.lastAct.act, b.lastAct.targetId], ["nav", "P1"]);
  host.noteAgent("scout", "Browser.getVersion"); // an older caller without a hint still counts
  assert.equal(b.lastAgentMethod, "Browser.getVersion");
  assert.deepEqual(b.info().trail, []);
  assert.equal(b.info().wall, null);
  host.killAll();
});

test("live view helpers: the address bar and robot checks", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com/");
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(wallOf("https://www.google.com/sorry/index", ""), "url");
  assert.equal(wallOf("https://example.com/", "Example Domain", "Hello"), null);
});

// ---- the live view must never hide the agent's working tab ------------------------------------------------
/**
 * A stand-in for an agent's Chrome with two pages, A (in front, the agent's) and B (background). It records
 * every CDP method on the browser socket and every HTTP path; `emit` pushes a discovery event to the viewer.
 */
function fakeTabs() {
  const calls = [];
  const paths = [];
  const pages = [
    { targetId: "A", type: "page", url: "https://agent.example/", title: "agent page", attached: false },
    { targetId: "B", type: "page", url: "https://other.example/", title: "other page", attached: false },
  ];
  const srv = http.createServer((req, res) => {
    paths.push(req.url);
    res.setHeader("content-type", "application/json; charset=UTF-8");
    res.end("{}");
  });
  const wss = new WebSocket.WebSocketServer({ server: srv });
  const socks = new Set();
  wss.on("connection", (ws) => {
    socks.add(ws);
    ws.on("close", () => socks.delete(ws));
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      calls.push({ method: m.method, params: m.params || {} });
      let result = {};
      if (m.method === "Target.getTargets") result = { targetInfos: pages };
      else if (m.method === "Target.attachToTarget") result = { sessionId: `S-${m.params.targetId}` };
      else if (m.method === "Target.getTargetInfo") result = { targetInfo: pages.find((p) => p.targetId === m.params.targetId) };
      else if (m.method === "Runtime.evaluate") result = { result: { type: "string", value: m.sessionId === "S-A" ? "visible" : "hidden" } };
      ws.send(JSON.stringify({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () =>
      resolve({
        port: srv.address().port,
        calls,
        paths,
        pages,
        activated: () => calls.filter((c) => c.method === "Target.activateTarget" || c.method === "Page.bringToFront"),
        emit: (method, params) => socks.forEach((ws) => ws.send(JSON.stringify({ method, params }))),
        close: () => (wss.clients.forEach((c) => c.terminate()), srv.close()),
      })
    )
  );
}

function fakeAgentBrowser(port) {
  const b = new EventEmitter();
  Object.assign(b, { port, wsPath: "/devtools/browser/fake", controller: "agent", lastAct: null });
  b.act = (targetId, act) => {
    b.lastAct = { targetId, act, at: Date.now() };
    b.emit("agent-act", b.lastAct);
  };
  return b;
}

test("live view: picking a tab without control never brings it forward (the agent's tab stays visible)", async (t) => {
  const chrome = await fakeTabs();
  const b = fakeAgentBrowser(chrome.port);
  const lv = new LiveView(b);
  t.after(() => (lv.stop(), chrome.close()));
  b.lastAct = { targetId: "A", act: "nav", at: Date.now() }; // the agent works in A
  await lv.start();
  assert.equal(lv.targetId, "A");
  assert.deepEqual(chrome.activated().map((c) => c.params.targetId), ["A"], "the agent's own page may come forward");

  // the user only watches B: shown, but left in the background, and the user is told
  await lv.selectTab("B");
  assert.equal(lv.targetId, "B");
  await until(() => lv.status().hidden === true);
  assert.deepEqual(chrome.activated().map((c) => c.params.targetId), ["A"], "selectTab without control must not activate B");
  assert.equal(lv.status().follow, false);

  // the agent only reads its page: B stays picked, nothing is activated
  b.act("A", "look");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(lv.targetId, "B");
  assert.equal(chrome.activated().length, 1);

  // the user takes control: now B may come forward (focus), and paints
  b.controller = "user";
  lv.focus();
  await until(() => lv.status().hidden === false);
  assert.ok(chrome.calls.some((c) => c.method === "Page.bringToFront"));
  b.controller = "agent";

  // the agent navigates A: the view follows and A, its own page, comes forward again
  b.act("A", "nav");
  await until(() => lv.targetId === "A" && lv.session === "S-A");
  assert.equal(chrome.activated().filter((c) => c.method === "Target.activateTarget").pop().params.targetId, "A");
});

test("live view: a page changing its own address in a background tab never pulls the view (or the front)", async (t) => {
  const chrome = await fakeTabs();
  const b = fakeAgentBrowser(chrome.port);
  const lv = new LiveView(b);
  t.after(() => (lv.stop(), chrome.close()));
  b.lastAct = { targetId: "A", act: "input", at: Date.now() };
  await lv.start();
  b.act("A", "input"); // the agent types in A
  const before = chrome.activated().length;
  // B calls history.replaceState: discovery reports a new address the agent did not cause
  chrome.emit("Target.targetInfoChanged", { targetInfo: { ...chrome.pages[1], url: "https://other.example/?tick=1" } });
  chrome.emit("Target.targetInfoChanged", { targetInfo: { ...chrome.pages[1], url: "https://other.example/?tick=2" } });
  await until(() => lv.targets.get("B").url.endsWith("tick=2"));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(lv.targetId, "A", "the view stays on the agent's tab");
  assert.equal(chrome.activated().length, before, "nothing else is brought forward");
  assert.ok(!lv.strong || lv.strong.targetId === "A", "discovery never claims the agent's strong act");
  // a page the agent's tab opens (a link with target=_blank) is followed
  chrome.emit("Target.targetCreated", { targetInfo: { targetId: "C", type: "page", url: "https://agent.example/next", title: "", openerId: "A" } });
  await until(() => lv.targetId === "C");
  // a page opened by some other tab is not
  chrome.emit("Target.targetCreated", { targetInfo: { targetId: "D", type: "page", url: "https://ads.example/", title: "", openerId: "B" } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(lv.targetId, "C");
});

test("tunnel: while the user holds control, discovery routes that open, close or activate tabs are refused", async (t) => {
  const chrome = await fakeTabs();
  t.after(() => chrome.close());
  let who = "user";
  const host = {
    enabled: () => true,
    ensure: async () => ({ port: chrome.port, wsPath: "/devtools/browser/fake" }),
    controller: () => who,
    downloadDir: () => path.join(os.tmpdir(), "dl"),
    channelOpened() {},
    channelClosed() {},
    noteAgent() {},
    touch() {},
  };
  const out = [];
  const tunnel = new CdpTunnel({ host, send: (buf) => out.push(decodeFrame(buf)) || true });
  let ch = 100;
  const get = async (p, method = "GET") => {
    const id = ++ch;
    tunnel.onFrame(encodeFrame(OP.HTTP, id, { slug: "scout", method, path: p }));
    const f = await until(() => out.find((x) => x.op === OP.HTTP_RES && x.ch === id));
    return JSON.parse(f.payload.toString());
  };
  for (const [p, m] of [["/json/close/B"], ["/json/activate/B"], ["/json/new?https://example.com/", "PUT"], ["/json/new"]]) {
    const r = await get(p, m);
    assert.equal(r.status, 409, p);
    assert.match(JSON.parse(r.body).error, /taken control/);
  }
  assert.deepEqual(chrome.paths, [], "nothing reached the browser");
  // reading still works while the user drives
  assert.equal((await get("/json/version")).status, 200);
  assert.equal((await get("/json/list")).status, 200);
  // the agent's turn again: the same routes pass
  who = "agent";
  assert.equal((await get("/json/close/B")).status, 200);
  assert.deepEqual(chrome.paths, ["/json/version", "/json/list", "/json/close/B"]);
  // and the CDP twins of those routes are refused under user control too
  assert.ok(USER_ONLY.test("Target.activateTarget") && USER_ONLY.test("Page.bringToFront") && USER_ONLY.test("Target.closeTarget"));
  assert.ok(!USER_ONLY.test("Runtime.evaluate") && !USER_ONLY.test("Page.captureScreenshot"));
});

test("tunnel: while the user holds control, no new tab, no closing contexts, no closing or crashing the browser", async (t) => {
  const chrome = await fakeTabs();
  t.after(() => chrome.close());
  let who = "user";
  const host = {
    enabled: () => true,
    ensure: async () => ({ port: chrome.port, wsPath: "/devtools/browser/fake" }),
    controller: () => who,
    downloadDir: () => path.join(os.tmpdir(), "dl"),
    channelOpened() {},
    channelClosed() {},
    noteAgent() {},
    touch() {},
  };
  const out = [];
  const tunnel = new CdpTunnel({ host, send: (buf) => out.push(decodeFrame(buf)) || true });
  t.after(() => tunnel.closeAll("done"));
  tunnel.onFrame(encodeFrame(OP.OPEN, 9, { slug: "scout", path: "/devtools/browser/abc", kind: "agent" }));
  await until(() => out.some((f) => f.op === OP.OPENED && f.ch === 9));
  let id = 0;
  const call = async (method, params = {}) => {
    const i = ++id;
    tunnel.onFrame(encodeFrame(OP.DATA, 9, JSON.stringify({ id: i, method, params })));
    const f = await until(() => out.find((x) => x.op === OP.DATA && x.ch === 9 && JSON.parse(x.payload).id === i));
    return JSON.parse(f.payload);
  };
  for (const [m, p] of [
    ["Target.createTarget", { url: "https://example.com/" }],
    ["Target.createTarget", { url: "about:blank", background: true }],
    ["Target.disposeBrowserContext", { browserContextId: "C1" }],
    ["Browser.close", {}],
    ["Browser.crash", {}],
    ["Browser.crashGpuProcess", {}],
  ]) {
    const r = await call(m, p);
    assert.ok(r.error && /taken control/.test(r.error.message), `${m} refused under user control`);
  }
  assert.deepEqual(chrome.calls, [], "nothing reached the browser");
  for (const m of ["Target.createTarget", "Target.disposeBrowserContext", "Browser.close", "Browser.crash", "Browser.crashGpuProcess"]) assert.ok(USER_ONLY.test(m), m);
  // the agent's turn again: a new tab passes
  who = "agent";
  assert.ok(!(await call("Target.createTarget", { url: "about:blank" })).error);
  assert.deepEqual(chrome.calls.map((c) => c.method), ["Target.createTarget"]);
});

test("agent-browser host: control survives a browser exit, and can always be handed back", () => {
  const host = new AgentBrowserHost({ root: path.join(os.tmpdir(), "deck-ws-test"), enabled: false });
  const b = host.get("scout");
  b.status = "running";
  host.setController("scout", "user");
  b._gone(); // the browser exits while the user holds control
  assert.equal(b.status, "stopped");
  assert.equal(b.controller, "user", "a relaunch must not hand the browser to the agent");
  assert.throws(() => host.setController("scout", "user"), /çalışmıyor/, "taking control still needs a running browser");
  host.setController("scout", "agent"); // releasing always works
  assert.equal(b.controller, "agent");
  host.killAll();
});

test("agent-browser host: the supervisor's read on about:blank is not use; a read on a real page is", () => {
  const host = new AgentBrowserHost({ root: path.join(os.tmpdir(), "deck-ws-test"), enabled: false });
  const b = host.get("scout");
  b.trail = { pages: new Map([["BLANK", { targetId: "BLANK", type: "page", url: "about:blank" }], ["REAL", { targetId: "REAL", type: "page", url: "https://example.com/" }]]), stop() {} };
  host.noteAgent("scout", "Runtime.evaluate", { use: true, act: "look", targetId: "BLANK" }); // Hermes's dialog bridge
  assert.equal(b.lastAgentAt, 0, "not 'kullanıyor' after a supervisor (re)attach");
  host.noteAgent("scout", "Runtime.evaluate", { use: true, act: "look", targetId: "REAL" });
  assert.ok(b.lastAgentAt > 0);
  b.trail = null;
  host.killAll();
});
