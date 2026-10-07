"use strict";
// Agent host browser by default: presence routing order, and attaching an EXTERNAL (already running) browser.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;
const { Presence } = require("../src/presence");
const { FallbackHost, parseExternalCdp, EXTERNAL_BLOCKED } = require("../src/browser");
const { start, config } = require("../src/index");

const TOKEN = "t".repeat(32);
const PC = "a1b2c3d4e5f60708";
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "deck-ahb-"));
const once = (em, ev) => new Promise((resolve) => em.once(ev, (...a) => resolve(a)));
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const beat = (hosting = true) => ({ t: "heartbeat", device: { id: PC, name: "Test PC" }, os: "win32", idleSec: 1, locked: false, hosting: { browser: hosting, desktop: false }, driverOk: { browser: true } });

// ---- routing --------------------------------------------------------------------------------------------
test("presence default=host: Otomatik goes to the agent host even when a deck is active; a device pin wins", () => {
  const p = new Presence({ fallback: { browser: { name: "agent host" } } }); // browserDefault: "host"
  const pc = {};
  p.connect(pc);
  p.heartbeat(pc, beat(true));
  assert.strictEqual(p.activeDevice("browser").id, PC, "the deck qualifies");
  assert.strictEqual(p.routeFor("scout", "browser").host.kind, "fallback");
  assert.strictEqual(p.state().defaults.browser, "host");
  // the user moves it to their own PC, and back
  assert.deepStrictEqual(p.setPin("scout", "browser", { kind: "device", id: PC }), { ok: true });
  assert.strictEqual(p.routeFor("scout", "browser").host.id, PC);
  assert.deepStrictEqual(p.setPin("scout", "browser", { kind: "fallback" }), { ok: true });
  assert.strictEqual(p.routeFor("scout", "browser").host.kind, "fallback");
  // pinned to the PC and the PC goes away: no route (no silent switch to the agent host)
  p.setPin("scout", "browser", { kind: "device", id: PC });
  p.disconnect(pc);
  assert.strictEqual(p.routeFor("scout", "browser"), null);
});

test("presence default=host: without an agent host browser a deck still hosts; the bot screen stays device-first", () => {
  const p = new Presence({ fallback: { browser: null, desktop: { id: "host", name: "agent host" } } });
  const pc = {};
  p.connect(pc);
  p.heartbeat(pc, { ...beat(true), hosting: { browser: true, desktop: true } });
  assert.strictEqual(p.routeFor("scout", "browser").host.id, PC);
  assert.strictEqual(p.routeFor("scout", "desktop").host.id, PC, "default=host never changes the desktop capability");
});

test("presence default=device keeps the earlier order (active deck first, agent host second)", () => {
  const p = new Presence({ browserDefault: "device", fallback: { browser: { name: "agent host" } } });
  assert.strictEqual(p.routeFor("a", "browser").host.kind, "fallback", "no deck: the agent host");
  p.endSession("a", "browser");
  const pc = {};
  p.connect(pc);
  p.heartbeat(pc, beat(true));
  assert.strictEqual(p.routeFor("b", "browser").host.id, PC);
  assert.strictEqual(p.state().defaults.browser, "device");
  assert.strictEqual(new Presence({ browserDefault: "nonsense" }).browserDefault, "host");
});

test("presence: a fallback restricted to some agents (external browser) serves only those", () => {
  const p = new Presence({ fallback: { browser: { name: "agent host", agents: ["default"] } } });
  const pc = {};
  p.connect(pc);
  p.heartbeat(pc, beat(true));
  assert.strictEqual(p.routeFor("default", "browser").host.kind, "fallback");
  assert.strictEqual(p.routeFor("other", "browser").host.id, PC, "another agent has no browser on the agent host: the active deck");
  assert.deepStrictEqual(p.setPin("other", "browser", { kind: "fallback" }), { ok: false, code: "fallback" });
  assert.deepStrictEqual(p.setPin("default", "browser", { kind: "fallback" }), { ok: true });
  assert.deepStrictEqual(p.state().fallback.browser, { name: "agent host", agents: ["default"] });
  // a saved pin to the agent host for an agent it does not serve gives no route
  const q = new Presence({ fallback: { browser: { name: "h", agents: ["default"] } } });
  q.loadPins([{ sessionKey: "other", capability: "browser", host: { kind: "fallback" } }]);
  assert.strictEqual(q.routeFor("other", "browser"), null);
});

// ---- the external browser: a fake CDP endpoint ---------------------------------------------------------------
/** A stand-in for a persistent Chrome: /json/version + a browser websocket that records every method. */
async function fakeChrome(id = "ext-1") {
  const reached = [];
  let alive = true;
  const srv = http.createServer((req, res) => {
    if (!alive) return req.socket.destroy();
    const port = srv.address().port;
    res.setHeader("content-type", "application/json; charset=UTF-8");
    if (req.url.startsWith("/json/version")) return res.end(JSON.stringify({ Browser: "FakeChrome/1.0", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${id}` }));
    res.statusCode = 404;
    res.end("{}");
  });
  const wss = new WebSocketServer({ server: srv });
  wss.on("connection", (ws) =>
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      reached.push(m.method);
      ws.send(JSON.stringify({ id: m.id, result: { echo: m.method }, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
    })
  );
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    port: srv.address().port,
    reached,
    setId(v) {
      id = v;
    },
    kill() {
      alive = false;
      for (const c of wss.clients) c.terminate();
    },
    revive() {
      alive = true;
    },
    close() {
      for (const c of wss.clients) c.terminate();
      srv.close();
    },
  };
}

test("parseExternalCdp accepts only a loopback http debugging port", () => {
  assert.deepStrictEqual(parseExternalCdp("http://127.0.0.1:9222"), { port: 9222 });
  assert.deepStrictEqual(parseExternalCdp("http://localhost:9222/"), { port: 9222 });
  assert.deepStrictEqual(parseExternalCdp("http://[::1]:9222"), { port: 9222 });
  for (const bad of ["", null, "http://192.0.2.10:9222", "http://example.com:9222", "https://127.0.0.1:9222", "ws://127.0.0.1:9222", "http://127.0.0.1", "http://user:pw@127.0.0.1:9222", "http://127.0.0.1:9222/json?x=1", "http://127.0.0.1:99999", "9222", "http://127.0.0.1:9222/devtools/browser/x"]) {
    assert.strictEqual(parseExternalCdp(bad), null, String(bad));
  }
});

test("external browser: attached over its port, gated for the agent, never launched or closed by the relay", async (t) => {
  const fake = await fakeChrome();
  const fb = new FallbackHost({ dir: tmpDir(), name: "agent host", headless: false, external: { port: fake.port, agent: "default" }, probeMs: 60_000 });
  t.after(async () => {
    await fb.stopAll();
    fake.close();
  });
  assert.strictEqual(fb.available, true);
  assert.strictEqual(fb.headlessAvailable, false);
  assert.deepStrictEqual(fb.agentList(), ["default"]);
  assert.strictEqual(fb.serves("default"), true);
  assert.strictEqual(fb.serves("other"), false);
  await assert.rejects(fb.ensure("other"), (e) => e.status === 503, "no headless Chrome is launched for another agent");

  const a = await fb.ensure("default");
  assert.strictEqual(a.status, "running");
  assert.strictEqual(a.external, true);
  assert.strictEqual(a.proc, null, "the relay owns no process");
  assert.strictEqual(a.port, fake.port);
  assert.strictEqual(a.wsPath, "/devtools/browser/ext-1");
  assert.strictEqual(fb.list().find((i) => i.slug === "default").external, true);

  // discovery passes through
  assert.strictEqual((await fb.http("default", { method: "GET", path: "/json/version" })).status, 200);

  // the agent's CDP socket: any browser id maps to the current one; ordinary commands pass
  const chan = await fb.open("default", "/devtools/browser/whatever");
  const answers = new Map();
  chan.attach((buf) => {
    const m = JSON.parse(buf.toString());
    answers.set(m.id, m);
  }, () => {});
  let id = 0;
  const call = async (method, params = {}) => {
    const i = ++id;
    chan.send(Buffer.from(JSON.stringify({ id: i, method, params })));
    return until(() => answers.get(i));
  };
  assert.ok(!(await call("Target.getTargets")).error);
  // Browser.close / crash are refused whoever holds control: the browser is shared and persistent
  for (const m of ["Browser.close", "Browser.crash", "Browser.crashGpuProcess"]) {
    const r = await call(m);
    assert.strictEqual(r.error.message, EXTERNAL_BLOCKED, m);
  }
  // (the relay's own trail socket sends Target.setDiscoverTargets; the agent's getTargets passed)
  assert.ok(fake.reached.includes("Target.getTargets"));
  assert.ok(!fake.reached.some((m) => /^Browser\./.test(m)), "nothing destructive reached the external browser");
  // the user's takeover gates the rest, like on a deck
  fb.setController("default", "user");
  assert.match((await call("Page.navigate", { url: "https://example.com/" })).error.message, /taken control/);
  fb.setController("default", "agent");
  assert.ok(!(await call("Page.enable")).error);
  assert.ok(!fake.reached.some((m) => m === "Page.navigate"), "the refused navigation never reached the browser");
  chan.close();

  // stopAll only detaches: the process we never owned is not touched (the fake keeps answering)
  await fb.stopAll();
  assert.strictEqual((await fetch(`http://127.0.0.1:${fake.port}/json/version`)).status, 200);
  assert.ok(!fake.reached.includes("Browser.close"));
});

test("external browser: its exit is noticed, nothing is relaunched, and a restart is attached again", async (t) => {
  const fake = await fakeChrome("first");
  const fb = new FallbackHost({ dir: tmpDir(), name: "agent host", headless: false, external: { port: fake.port, agent: "default" }, probeMs: 80 });
  t.after(async () => {
    await fb.stopAll();
    fake.close();
  });
  const changes = [];
  fb.on("change", (i) => changes.push(i.status));
  await fb.attachExternal(); // the relay does this once at start
  const a = fb.peek("default");
  assert.strictEqual(a.status, "running");
  fb.setController("default", "user"); // the user is driving when it dies
  fake.kill();
  await until(() => a.status === "stopped");
  assert.strictEqual(a.controller, "user", "control survives the exit (see HostBrowser._gone)");
  assert.strictEqual(a.proc, null);
  await assert.rejects(fb.ensure("default"), (e) => e.status === 503);
  assert.strictEqual(a.status, "error");
  // it comes back under a new browser id: attached again by the probe, with no launch
  fake.revive();
  fake.setId("second");
  await until(() => a.status === "running" && a.wsPath === "/devtools/browser/second");
  assert.ok(changes.includes("stopped") && changes.includes("running"));
});

// ---- the relay end to end with a REAL throwaway Chrome on our own port --------------------------------------
function chromeExe() {
  for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    for (const dir of String(process.env.PATH || "").split(":")) {
      const p = path.join(dir, n);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* next */
      }
    }
  }
  return null;
}
const exe = process.platform === "win32" ? null : chromeExe();
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

test("agent host browser (external CDP): Otomatik lands there, the Deck watches and takes over, closing the relay leaves Chrome running", { skip: exe ? false : "no Chrome here", timeout: 120_000 }, async (t) => {
  const dir = tmpDir();
  // an "existing persistent browser": started by the test, on its own port (never 9222/9333), own profile
  const port = 20000 + Math.floor(Math.random() * 20000);
  const chrome = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(dir, "ext-profile")}`, "--headless=new", "--no-first-run", "--no-default-browser-check", "--password-store=basic", ...(asRoot ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore" });
  const alive = () => chrome.exitCode === null && chrome.signalCode === null;
  let relay = null;
  let deck = null;
  t.after(async () => {
    if (deck) deck.terminate();
    if (relay) await relay.stop();
    if (alive()) chrome.kill("SIGKILL");
    await new Promise((r) => (alive() ? chrome.once("exit", r) : r()));
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* temp folder only */
    }
  });
  await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null))?.ok, 40_000);

  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify({ profiles: {} }));
  const cfg = {
    host: "127.0.0.1", port: 0, token: TOKEN, eventsDir: path.join(dir, "events"), stateDir: path.join(dir, "state"), dataDir: path.join(dir, "data"),
    claudeDirs: [], claudeProfile: "claude-code", claudeChatMap: null, launchdPrefixes: [], codexbar: null, agentsFile, broadcastWindowS: 300, tickMs: 100,
    cdp: { port: 0, defaultAgent: "default", fallback: false, browserPath: null, externalCdp: `http://127.0.0.1:${port}`, externalAgent: "default", browserDefault: "host", probeMs: 500 },
    hostName: "agent host",
  };
  relay = await start(cfg);
  assert.ok(relay.fallback.external && !relay.fallback.headlessAvailable);

  // a deck that WOULD qualify (active, hosting on) is connected: the agent still goes to the agent host
  deck = new WebSocket(`ws://127.0.0.1:${relay.port}/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
  await once(deck, "open");
  const json = [];
  deck.on("message", (d, bin) => {
    if (!bin) json.push(JSON.parse(d));
  });
  deck.send(JSON.stringify(beat(true)));
  await until(() => relay.presence.activeDevice("browser"));
  let n = 0;
  const req = async (msg) => {
    const id = ++n;
    deck.send(JSON.stringify({ t: "ws-req", id, ...msg }));
    return until(() => json.find((m) => m.t === "ws-res" && m.id === id), 20_000);
  };

  // Hermes: discovery on the gateway, rewritten to it; the browser is the external one
  const v = await (await fetch(`http://127.0.0.1:${relay.cdpPort}/agent/default/json/version`)).json();
  assert.match(v.webSocketDebuggerUrl, new RegExp(`^ws://127\\.0\\.0\\.1:${relay.cdpPort}/agent/default/devtools/browser/`));
  assert.doesNotMatch(JSON.stringify(v), new RegExp(String(port)), "the external port never reaches the agent");
  assert.strictEqual(relay.presence.routeFor("default", "browser").host.kind, "fallback", "agent host first although a deck is active");

  // the Deck watches it live
  assert.strictEqual((await req({ op: "watch", slug: "default", maxWidth: 800, maxHeight: 600 })).ok, true);
  const agent = new WebSocket(v.webSocketDebuggerUrl);
  await once(agent, "open");
  const pending = new Map();
  agent.on("message", (d) => {
    const m = JSON.parse(d);
    if (pending.has(m.id)) pending.get(m.id)(m);
  });
  let id = 0;
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      agent.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const { result: tgt } = await call("Target.createTarget", { url: "data:text/html,<title>external ok</title><body style='background:#fc0'>hello" });
  const { result: att } = await call("Target.attachToTarget", { targetId: tgt.targetId, flatten: true });
  const frame = await until(() => json.find((m) => m.t === "ws-view" && m.slug === "default" && m.ev === "frame"), 30_000);
  const jpeg = Buffer.from(frame.data, "base64");
  assert.ok(jpeg[0] === 0xff && jpeg[1] === 0xd8, "a JPEG live-view frame of the external browser");
  await until(() => json.some((m) => m.t === "ws-browsers" && m.browsers.some((b) => b.slug === "default" && b.external === true && b.status === "running" && b.agentChannels >= 1)));

  // take control: the agent is refused; give back: it may act again
  assert.strictEqual((await req({ op: "control", slug: "default", who: "user" })).ok, true);
  assert.match((await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }, att.sessionId)).error.message, /taken control/);
  assert.strictEqual((await req({ op: "control", slug: "default", who: "agent" })).ok, true);
  assert.ok(!(await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }, att.sessionId)).error);

  // the agent cannot close the user's persistent browser
  const closed = await call("Browser.close");
  assert.strictEqual(closed.error.message, EXTERNAL_BLOCKED);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(alive(), "Chrome is still running after Browser.close");

  // moving to the user's own PC and back (pins), with the session handed off each time
  assert.strictEqual((await req({ op: "route", slug: "default", where: "here" })).ok, true);
  assert.strictEqual(relay.presence.routeFor("default", "browser").host.id, PC);
  await until(() => agent.readyState === WebSocket.CLOSED, 5000); // the agent's socket to the agent host was cut (handoff)
  assert.strictEqual((await req({ op: "route", slug: "default", where: "agent-host" })).ok, true);
  assert.strictEqual(relay.presence.routeFor("default", "browser").host.kind, "fallback");
  // agents without a browser on the agent host cannot be pinned there
  assert.strictEqual((await req({ op: "route", slug: "other", where: "agent-host" })).ok, false);

  // relay stop = detach only
  deck.terminate();
  deck = null;
  await relay.stop();
  relay = null;
  assert.ok(alive(), "the external Chrome survives the relay stopping");
  assert.strictEqual((await fetch(`http://127.0.0.1:${port}/json/version`)).status, 200);
});

test("config(): the external browser and the default switch come from the environment", () => {
  const c = config({ DECK_RELAY_TOKEN: TOKEN, DECK_FALLBACK_BROWSER_CDP: "http://127.0.0.1:9222" });
  assert.strictEqual(c.cdp.externalCdp, "http://127.0.0.1:9222");
  assert.strictEqual(c.cdp.externalAgent, "default");
  assert.strictEqual(c.cdp.browserDefault, "host");
  assert.strictEqual(c.cdp.fallback, false);
  const d = config({ DECK_RELAY_TOKEN: TOKEN, DECK_BROWSER_DEFAULT: "device", DECK_CDP_DEFAULT_AGENT: "Scout", DECK_FALLBACK_BROWSER_CDP_AGENT: "Work" });
  assert.strictEqual(d.cdp.browserDefault, "device");
  assert.strictEqual(d.cdp.externalAgent, "work");
});
