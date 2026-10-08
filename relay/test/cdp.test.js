"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;
const { OP, encodeFrame, decodeFrame, parseCdpPath, rewriteDiscovery, Channel, CdpGateway, createCdpServer } = require("../src/cdp");
const { Presence } = require("../src/presence");
const { findBrowser, FallbackHost, HostBrowser } = require("../src/browser");
const { AgentTracker, wallOf, LiveView } = require("../src/cdp-view");
const { WorkspaceHub } = require("../src/workspace");
const { start } = require("../src/index");

// The deck's half of the tunnel lives in the app; use it when the app's dependencies are installed, so
// these tests also prove both halves speak the same framing.
let AppTunnel = null;
try {
  ({ CdpTunnel: AppTunnel } = require("../../app/main/cdp-tunnel"));
} catch {
  AppTunnel = null;
}

const TOKEN = "t".repeat(32);
const DEVICE = "a1b2c3d4e5f60708";
const DOWNLOADS = path.join(os.tmpdir(), "agent-profile", "Downloads");
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "deck-cdp-"));
const once = (em, ev) => new Promise((resolve) => em.once(ev, (...a) => resolve(a)));
const nextMessage = (ws) => once(ws, "message").then(([d]) => JSON.parse(d));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const heartbeat = (hosting = true, extra = {}) => ({ t: "heartbeat", device: { id: DEVICE, name: "Test PC" }, os: "win32", idleSec: 1, locked: false, hosting: { browser: hosting, desktop: false }, driverOk: { browser: true }, ...extra });
async function untilAsync(fn, ms = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}
/** A plain CDP client for the "Hermes" side of a test. */
async function cdpCall(url) {
  const ws = new WebSocket(url);
  await once(ws, "open");
  const pending = new Map();
  ws.on("message", (d) => {
    const m = JSON.parse(d);
    if (pending.has(m.id)) pending.get(m.id)(m);
  });
  let id = 0;
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { ws, call };
}

/** A stand-in for an agent's Chrome: discovery over HTTP, and a CDP socket that echoes each command. */
function fakeBrowser() {
  const srv = http.createServer((req, res) => {
    const port = srv.address().port;
    res.setHeader("content-type", "application/json; charset=UTF-8");
    if (req.url.startsWith("/json/version")) return res.end(JSON.stringify({ Browser: "FakeChrome/1.0", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake-id` }));
    if (req.url.startsWith("/json/list") || req.url === "/json") {
      return res.end(JSON.stringify([{ id: "P1", type: "page", url: "about:blank", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/P1`, devtoolsFrontendUrl: `/devtools/inspector.html?ws=127.0.0.1:${port}/devtools/page/P1` }]));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  const wss = new WebSocketServer({ server: srv });
  const paths = [];
  wss.on("connection", (ws, req) => {
    paths.push(req.url);
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      ws.send(JSON.stringify({ id: m.id, result: { echo: m.method, params: m.params }, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () =>
      resolve({
        port: srv.address().port,
        paths,
        close: () => {
          for (const c of wss.clients) c.terminate();
          srv.close();
        },
      })
    )
  );
}

/** Without the app installed: the smallest deck tunnel that passes discovery and sockets through. */
class MiniTunnel {
  constructor({ host, send }) {
    Object.assign(this, { host, send, socks: new Map() });
  }

  async onFrame(data) {
    const f = decodeFrame(data);
    const m = f && f.op !== OP.DATA ? JSON.parse(f.payload.toString() || "{}") : null;
    if (f.op === OP.HTTP) {
      const b = await this.host.ensure(m.slug);
      const r = await fetch(`http://127.0.0.1:${b.port}${m.path}`);
      this.send(encodeFrame(OP.HTTP_RES, f.ch, { status: r.status, type: r.headers.get("content-type"), body: await r.text() }));
    } else if (f.op === OP.OPEN) {
      const b = await this.host.ensure(m.slug);
      const ws = new WebSocket(`ws://127.0.0.1:${b.port}${m.path.startsWith("/devtools/browser/") ? b.wsPath : m.path}`);
      this.socks.set(f.ch, ws);
      ws.on("open", () => this.send(encodeFrame(OP.OPENED, f.ch)));
      ws.on("message", (d) => this.send(encodeFrame(OP.DATA, f.ch, d)));
      ws.on("close", () => this.send(encodeFrame(OP.CLOSE, f.ch, { code: 1000, reason: "" })));
    } else if (f.op === OP.DATA) this.socks.get(f.ch).send(f.payload.toString());
    else if (f.op === OP.CLOSE && this.socks.has(f.ch)) this.socks.get(f.ch).close();
  }
}

async function relayWithCdp(extra = {}) {
  const dir = tmpDir();
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify({ profiles: {} }));
  const cfg = {
    host: "127.0.0.1", port: 0, token: TOKEN, eventsDir: path.join(dir, "events"), stateDir: path.join(dir, "state"), dataDir: path.join(dir, "data"),
    claudeDirs: [], claudeProfile: "claude-code", claudeChatMap: null, launchdPrefixes: [], codexbar: null, agentsFile, broadcastWindowS: 300, tickMs: 100,
    cdp: { port: 0, defaultAgent: "default", fallback: false, browserPath: null, ...extra },
    hostName: "agent host",
  };
  return Object.assign(await start(cfg), { dir });
}

/** A deck on the relay's /events socket: heartbeat + a tunnel to the given browser. */
async function connectDeck(relay, browser, { hosting = true, controller = () => "agent" } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
  await once(ws, "open");
  const json = [];
  const host = {
    enabled: () => true,
    ensure: async () => ({ port: browser.port, wsPath: "/devtools/browser/fake-id" }),
    controller,
    downloadDir: () => DOWNLOADS,
    channelOpened() {},
    channelClosed() {},
    noteAgent() {},
    touch() {},
  };
  const Tunnel = AppTunnel || MiniTunnel;
  const tunnel = new Tunnel({ host, send: (buf) => (ws.readyState === 1 ? (ws.send(buf, { binary: true }), true) : false) });
  ws.on("message", (d, isBinary) => (isBinary ? tunnel.onFrame(d) : json.push(JSON.parse(d))));
  ws.send(JSON.stringify(heartbeat(hosting)));
  return { ws, json, tunnel };
}

function rawRequest(port, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: p, headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
  });
}

// ------------------------------------------------------------------------------------------------------
test("cdp tunnel framing: round trip, rejects strangers, same bytes on both ends", () => {
  for (const [op, payload] of [[OP.OPEN, { slug: "scout", path: "/devtools/browser/x", kind: "agent" }], [OP.OPENED, null], [OP.DATA, '{"id":1,"method":"Page.navigate"}'], [OP.CLOSE, { code: 1000, reason: "bye" }], [OP.HTTP, { slug: "a", method: "GET", path: "/json/version" }], [OP.HTTP_RES, { status: 200, body: "{}" }]]) {
    const f = decodeFrame(encodeFrame(op, 0xffffffff, payload));
    assert.strictEqual(f.op, op);
    assert.strictEqual(f.ch, 0xffffffff);
    const expect = payload === null ? "" : typeof payload === "string" ? payload : JSON.stringify(payload);
    assert.strictEqual(f.payload.toString(), expect);
  }
  const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
  assert.strictEqual(decodeFrame(encodeFrame(OP.DATA, 7, big)).payload.length, big.length);
  assert.strictEqual(decodeFrame(Buffer.from("{\"t\":\"ping\"}")), null); // a JSON message is not a frame
  assert.strictEqual(decodeFrame(Buffer.from([0xcd, 9, 0, 0, 0, 1])), null); // unknown op
  assert.strictEqual(decodeFrame(Buffer.from([0xcd, 3, 0])), null); // short
  if (AppTunnel) {
    const app = require("../../app/main/cdp-tunnel");
    const p = { slug: "x", path: "/json/version", method: "GET" };
    assert.ok(app.encodeFrame(OP.HTTP, 42, p).equals(encodeFrame(OP.HTTP, 42, p)));
    assert.deepStrictEqual(app.OP, OP);
    assert.strictEqual(app.decodeFrame(encodeFrame(OP.DATA, 5, "hi")).payload.toString(), "hi");
  }
});

test("cdp guard: the legacy non-flat attach transport cannot smuggle blocked commands", { skip: AppTunnel ? false : "app not installed" }, () => {
  const { deviceGuard } = require("../../app/main/cdp-tunnel");
  const downloads = "/tmp/dl";
  // the escape used in practice: a whole CDP command wrapped as an opaque string the guard can't read
  assert.ok(deviceGuard({ method: "Target.sendMessageToTarget", params: { sessionId: "S", message: JSON.stringify({ id: 1, method: "Page.navigate", params: { url: "file:///etc/passwd" } }) } }, downloads));
  // the only way in is a flattened session, whose inner commands arrive as their own guarded frames
  assert.ok(deviceGuard({ method: "Target.attachToTarget", params: { targetId: "P1" } }, downloads)); // flatten omitted
  assert.ok(deviceGuard({ method: "Target.attachToTarget", params: { targetId: "P1", flatten: false } }, downloads));
  assert.ok(deviceGuard({ method: "Target.setAutoAttach", params: { autoAttach: true, flatten: false } }, downloads));
  assert.strictEqual(deviceGuard({ method: "Target.attachToTarget", params: { targetId: "P1", flatten: true } }, downloads), null);
  // granting the host's camera, microphone or geolocation to a page is refused
  assert.ok(deviceGuard({ method: "Browser.grantPermissions", params: { permissions: ["videoCapture", "audioCapture", "geolocation"] } }, downloads));
  assert.ok(deviceGuard({ method: "Browser.setPermission", params: { permission: { name: "camera" }, setting: "granted" } }, downloads));
  // ordinary page work still passes
  assert.strictEqual(deviceGuard({ method: "Runtime.evaluate", params: { expression: "1" } }, downloads), null);
  assert.strictEqual(deviceGuard({ method: "Page.navigate", params: { url: "https://example.com/" } }, downloads), null);
});

test("cdp discovery: per-agent paths and URLs rewritten to the gateway", () => {
  assert.deepStrictEqual(parseCdpPath("/agent/Scout/json/version", "default"), { slug: "scout", rest: "/json/version" });
  assert.deepStrictEqual(parseCdpPath("/json/version", "default"), { slug: "default", rest: "/json/version" });
  assert.deepStrictEqual(parseCdpPath("/agent/r_2-x/devtools/page/AB12", "d"), { slug: "r_2-x", rest: "/devtools/page/AB12" });
  assert.strictEqual(parseCdpPath("/agent/../json", "d"), null);
  assert.strictEqual(parseCdpPath("/agent/%E0%A4%A/json", "d"), null);

  const host = "127.0.0.1:9333";
  const v = JSON.parse(rewriteDiscovery(JSON.stringify({ Browser: "Chrome/148", webSocketDebuggerUrl: "ws://127.0.0.1:53111/devtools/browser/0a-b" }), { host, slug: "scout" }));
  assert.strictEqual(v.webSocketDebuggerUrl, "ws://127.0.0.1:9333/agent/scout/devtools/browser/0a-b");
  assert.strictEqual(v.Browser, "Chrome/148");
  const list = JSON.parse(
    rewriteDiscovery(JSON.stringify([{ id: "P", webSocketDebuggerUrl: "ws://localhost:1/devtools/page/P", devtoolsFrontendUrl: "https://chrome-devtools-frontend.appspot.com/serve_rev/@x/inspector.html?ws=127.0.0.1:1/devtools/page/P" }]), { host, slug: "r" })
  );
  assert.strictEqual(list[0].webSocketDebuggerUrl, "ws://127.0.0.1:9333/agent/r/devtools/page/P");
  assert.ok(list[0].devtoolsFrontendUrl.endsWith("?ws=127.0.0.1:9333/agent/r/devtools/page/P"));
  // a socket URL that is not the local browser's is dropped rather than passed on
  assert.strictEqual(JSON.parse(rewriteDiscovery(JSON.stringify({ webSocketDebuggerUrl: "ws://10.0.0.5:9222/devtools/browser/x" }), { host, slug: "r" })).webSocketDebuggerUrl, undefined);
  assert.strictEqual(rewriteDiscovery("Target activated", { host, slug: "r" }), "Target activated");
});

test("cdp end-to-end: Hermes -> relay :cdp -> deck tunnel -> agent browser, and back", async (t) => {
  const browser = await fakeBrowser();
  const relay = await relayWithCdp();
  let controller = "agent";
  const deck = await connectDeck(relay, browser, { controller: () => controller });
  t.after(async () => {
    deck.ws.terminate();
    await relay.stop();
    browser.close();
  });
  const base = `http://127.0.0.1:${relay.cdpPort}`;
  await until(() => relay.presence.activeDevice("browser"));
  // the deck learns where agent work runs
  await until(() => deck.json.some((m) => m.t === "devices" && m.active.browser === DEVICE));

  const v = await (await fetch(`${base}/agent/Demo/json/version`)).json();
  assert.strictEqual(v.Browser, "FakeChrome/1.0");
  assert.strictEqual(v.webSocketDebuggerUrl, `ws://127.0.0.1:${relay.cdpPort}/agent/demo/devtools/browser/fake-id`);
  const list = await (await fetch(`${base}/agent/demo/json/list/`)).json();
  assert.strictEqual(list[0].webSocketDebuggerUrl, `ws://127.0.0.1:${relay.cdpPort}/agent/demo/devtools/page/P1`);
  assert.strictEqual(relay.presence.routeFor("demo", "browser").host.id, DEVICE);

  const cdp = new WebSocket(v.webSocketDebuggerUrl);
  await once(cdp, "open");
  let reply = nextMessage(cdp);
  cdp.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
  assert.deepStrictEqual(await reply, { id: 1, result: { echo: "Browser.getVersion" } });
  assert.deepStrictEqual(browser.paths, ["/devtools/browser/fake-id"]); // only the agent browser's own socket
  assert.strictEqual(relay.presence.routeFor("demo", "browser").open, 1);

  if (AppTunnel) {
    // the user takes control in the Workspace tab: the agent may read, not click or navigate
    controller = "user";
    reply = nextMessage(cdp);
    cdp.send(JSON.stringify({ id: 2, method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 1, y: 1 }, sessionId: "S1" }));
    const err = await reply;
    assert.strictEqual(err.id, 2);
    assert.strictEqual(err.sessionId, "S1");
    assert.strictEqual(err.error.code, -32000);
    assert.match(err.error.message, /taken control/);
    reply = nextMessage(cdp);
    cdp.send(JSON.stringify({ id: 3, method: "Runtime.evaluate", params: { expression: "1" } }));
    assert.deepStrictEqual(await reply, { id: 3, result: { echo: "Runtime.evaluate", params: { expression: "1" } } });
    controller = "agent";

    // the browser runs on the user's computer: the computer itself stays out of reach
    const ask = async (msg) => {
      const p = nextMessage(cdp);
      cdp.send(JSON.stringify(msg));
      return p;
    };
    for (const [i, msg] of [
      { method: "DOM.setFileInputFiles", params: { files: ["C:\\Users\\me\\secret.pdf"], nodeId: 1 } },
      { method: "Page.navigate", params: { url: "fi\tle:///C:/Windows/win.ini" } }, // a browser strips the tab
      { method: "Target.createTarget", params: { url: "chrome://settings" } },
      { method: "Target.exposeDevToolsProtocol", params: { targetId: "P1" } },
      { method: "Input.dispatchDragEvent", params: { type: "drop", x: 1, y: 1, data: { items: [], files: ["/etc/passwd"], dragOperationsMask: 1 } } },
      { method: "PWA.install", params: { manifestId: "x" } },
    ].entries()) {
      const r = await ask({ id: 10 + i, ...msg });
      assert.strictEqual(r.id, 10 + i);
      assert.match(r.error.message, /keeps the computer's files/, msg.method);
    }
    const nav = await ask({ id: 20, method: "Page.navigate", params: { url: "https://example.com/" } });
    assert.strictEqual(nav.result.echo, "Page.navigate");
    const dl = await ask({ id: 21, method: "Browser.setDownloadBehavior", params: { behavior: "allowAndName", downloadPath: "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup" } });
    assert.strictEqual(dl.result.params.downloadPath, DOWNLOADS); // downloads only land in the agent's own folder
    assert.strictEqual((await fetch(`${base}/agent/demo/json/new?${encodeURIComponent("file:///etc/passwd")}`, { method: "PUT" })).status, 403);
  }

  // the deck going away closes the agent's socket instead of leaving it hanging
  const closed = once(cdp, "close");
  deck.ws.terminate();
  await closed;
  await until(() => !relay.presence.activeDevice("browser"));
});

test("cdp gateway: loopback only, no foreign Host or Origin, unknown paths refused", async (t) => {
  const relay = await relayWithCdp();
  t.after(() => relay.stop());
  const port = relay.cdpPort;
  assert.strictEqual(await rawRequest(port, "/agent/demo/json/version", { host: "evil.example:9333" }), 403); // DNS rebinding
  assert.strictEqual(await rawRequest(port, "/agent/demo/json/nope", { host: `127.0.0.1:${port}` }), 404);
  assert.strictEqual(await rawRequest(port, "/agent/demo/devtools/browser/x", { host: `127.0.0.1:${port}` }), 404); // sockets need an upgrade
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent/demo/devtools/browser/x`, { origin: "https://evil.example" });
  ws.on("error", () => {});
  const [req, res] = await once(ws, "unexpected-response");
  assert.strictEqual(res.statusCode, 403); // a web page can never reach an agent browser
  req.destroy();
  // nobody hosts and there is no fallback: "no workspace"
  const r = await fetch(`http://127.0.0.1:${port}/agent/demo/json/version`);
  assert.strictEqual(r.status, 503);
  assert.match((await r.json()).error, /no workspace: this relay has no agent host browser/);
});

test("cdp: a deck that switches hosting off stops getting work; the relay host's fallback takes over", async (t) => {
  // routing over a fake deck connection and a fake fallback, without sockets
  const presence = new Presence({ browserDefault: "device", fallback: { browser: { name: "mini (yedek)" } } });
  const fallbackCalls = [];
  const fallback = {
    http: async (slug, req) => {
      fallbackCalls.push([slug, req.path]);
      return { status: 200, type: "application/json", body: JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/fb" }) };
    },
    open: async () => new Channel(0, { send() {}, close() {} }),
  };
  const gw = new CdpGateway({ presence, fallback, timeoutMs: 1000 });
  const sent = [];
  const conn = { readyState: 1, send: (buf) => sent.push(decodeFrame(buf)) };
  presence.connect(conn);
  gw.addDeck(conn);
  presence.heartbeat(conn, heartbeat(true));

  // an active deck that allows it gets the new session
  const pending = gw.http("research", { method: "GET", path: "/json/version" });
  await until(() => sent.length === 1);
  assert.strictEqual(sent[0].op, OP.HTTP);
  assert.deepStrictEqual(JSON.parse(sent[0].payload), { slug: "research", method: "GET", path: "/json/version" });
  gw.onFrame(conn, encodeFrame(OP.HTTP_RES, sent[0].ch, { status: 200, type: "application/json", body: "{}" }));
  assert.strictEqual((await pending).status, 200);

  // its owner switches hosting off: that route is lost and new work goes to the fallback
  presence.heartbeat(conn, heartbeat(false));
  const r = await gw.http("research", { method: "GET", path: "/json/version" });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(fallbackCalls, [["research", "/json/version"]]);
  assert.strictEqual(presence.routeFor("research", "browser").host.kind, "fallback");

  // the same through the HTTP endpoint, with the answer rewritten to the gateway
  const srv = createCdpServer({ gateway: gw, defaultSlug: "default" });
  await new Promise((resolve) => srv.server.listen(0, "127.0.0.1", resolve));
  t.after(() => srv.close());
  const port = srv.server.address().port;
  const v = await (await fetch(`http://127.0.0.1:${port}/agent/research/json/version`)).json();
  assert.strictEqual(v.webSocketDebuggerUrl, `ws://127.0.0.1:${port}/agent/research/devtools/browser/fb`);
});

/** Rejects with "<what>: no answer within <ms> ms" unless `p` settles first. */
function within(p, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** A small CDP client where every wait is bounded: the connect, each command and each awaited event. */
async function cdpClient(url, ms) {
  const ws = new WebSocket(url, { handshakeTimeout: ms });
  await within(
    new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
    ms,
    "CDP connect"
  );
  let id = 0;
  const pending = new Map();
  const events = []; // every event so far, so a wait cannot miss one that arrived before it started
  const waiters = new Set();
  ws.on("message", (d) => {
    const m = JSON.parse(d);
    if (m.id !== undefined) {
      const done = pending.get(m.id);
      pending.delete(m.id);
      if (done) done(m);
      return;
    }
    events.push(m);
    for (const w of [...waiters]) w(m);
  });
  ws.on("close", () => {
    for (const done of pending.values()) done({ error: { message: "CDP socket closed" } });
    pending.clear();
  });
  const call = (method, params = {}, sessionId) =>
    within(
      new Promise((resolve, reject) => {
        id += 1;
        pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
      ms,
      method
    );
  const waitFor = (match, what) =>
    within(
      new Promise((resolve) => {
        const seen = events.find(match);
        if (seen) return resolve(seen);
        const w = (m) => {
          if (!match(m)) return;
          waiters.delete(w);
          resolve(m);
        };
        waiters.add(w);
      }),
      ms,
      what
    );
  return { call, waitFor, close: () => ws.terminate() };
}

// Chrome refuses to start as root on Linux without --no-sandbox, which the fallback browser never passes.
// DECK_TEST_CHROME_AS_ROOT=1 says the browser found on PATH is a wrapper that adds --no-sandbox itself
// (`exec /usr/bin/google-chrome --no-sandbox "$@"`), so the test can run in a root container.
const asRoot = process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0 && process.env.DECK_TEST_CHROME_AS_ROOT !== "1";
const browserExe = findBrowser();
const skipChrome = !browserExe ? "no Chrome/Chromium/Edge here" : asRoot ? "running as root: Chrome would need --no-sandbox" : false;
const STEP_MS = 45_000; // bound for each step; a loaded CI runner has taken ~20 s just to start Chrome
test("cdp fallback browser: a real headless Chrome on the relay host, its own profile", { skip: skipChrome, timeout: 180_000 }, async (t) => {
  const relay = await relayWithCdp({ fallback: true, launchTimeoutMs: STEP_MS });
  let cdp = null;
  t.after(async () => {
    if (cdp) cdp.close();
    await relay.stop(); // resolves once the fallback Chrome has exited
    try {
      fs.rmSync(relay.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* Windows: a Chrome helper may still hold a file for a moment; it is only a temp folder */
    }
  });
  const base = `http://127.0.0.1:${relay.cdpPort}`;
  // the first request starts Chrome; the relay answers once Chrome has written its DevToolsActivePort
  const res = await fetch(`${base}/agent/fb-test/json/version`, { signal: AbortSignal.timeout(STEP_MS * 2) });
  const v = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(v));
  assert.match(v.Browser, /Chrome|Edg/);
  assert.match(v.webSocketDebuggerUrl, new RegExp(`^ws://127\\.0\\.0\\.1:${relay.cdpPort}/agent/fb-test/devtools/browser/`));
  cdp = await cdpClient(v.webSocketDebuggerUrl, STEP_MS);
  const { targetId } = await cdp.call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.call("Target.attachToTarget", { targetId, flatten: true });
  await cdp.call("Page.enable", {}, sessionId);
  await cdp.call("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
  // Wait for this navigation's own "load": until it commits, the target still shows its first about:blank
  // document, whose title is "" (that race failed about one run in four on a loaded machine). Lifecycle
  // events carry the loaderId Page.navigate returns, so the replayed events of about:blank cannot match.
  const nav = await cdp.call("Page.navigate", { url: "data:text/html,<title>fallback ok</title>" }, sessionId);
  assert.ok(nav.loaderId && !nav.errorText, `navigation failed: ${JSON.stringify(nav)}`);
  await cdp.waitFor((m) => m.sessionId === sessionId && m.method === "Page.lifecycleEvent" && m.params.loaderId === nav.loaderId && m.params.name === "load", "load event of the data: page");
  const r = await cdp.call("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId);
  assert.strictEqual(r.result.value, "fallback ok");
  // the agent got the relay host's browser, with its profile under the relay's data dir (never the user's)
  assert.strictEqual(relay.presence.routeFor("fb-test", "browser").host.kind, "fallback");
  assert.ok(fs.existsSync(path.join(relay.dir, "data", "agent-browsers", "fb-test", "DevToolsActivePort")));
});

// ---- Workspace tab: following the agent, the host pick, the agent host's browser on a deck -----------------
const APP_VIEW = path.join(__dirname, "..", "..", "app", "main", "cdp-view.js");
test("cdp-view.js: the relay's copy is the app's, byte for byte", { skip: fs.existsSync(APP_VIEW) ? false : "app not checked out next to the relay" }, () => {
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "src", "cdp-view.js")).equals(fs.readFileSync(APP_VIEW)), "copy app/main/cdp-view.js to relay/src/cdp-view.js");
});

test("agent tracker: sessions map to pages, bookkeeping is not use, the agent's new pages are reported", () => {
  const tr = new AgentTracker();
  assert.deepStrictEqual(tr.command({ id: 1, method: "Target.getTargets" }), { use: false, act: null, targetId: null });
  tr.command({ id: 2, method: "Target.attachToTarget", params: { targetId: "P1", flatten: true } });
  assert.strictEqual(tr.reply(Buffer.from('{"id":2,"result":{"sessionId":"S1"}}')), null);
  // Hermes's supervisor after attaching: bookkeeping on that page, not use
  assert.deepStrictEqual(tr.command({ id: 3, method: "Page.enable", sessionId: "S1" }), { use: false, act: null, targetId: "P1" });
  assert.deepStrictEqual(tr.command({ id: 4, method: "Runtime.addBinding", sessionId: "S1", params: { name: "x" } }).use, false);
  assert.deepStrictEqual(tr.command({ id: 5, method: "Runtime.evaluate", sessionId: "S1", params: {} }), { use: true, act: "look", targetId: "P1" });
  assert.deepStrictEqual(tr.command({ id: 6, method: "Page.navigate", sessionId: "S1", params: { url: "https://example.com/" } }), { use: true, act: "nav", targetId: "P1" });
  assert.strictEqual(tr.command({ id: 7, method: "Input.dispatchMouseEvent", sessionId: "S1", params: {} }).act, "input");
  assert.strictEqual(tr.command({ id: 8, method: "Target.activateTarget", params: { targetId: "P1" } }).act, "input");
  // a page the agent opens: the browser's answer names it
  tr.command({ id: 9, method: "Target.createTarget", params: { url: "about:blank", background: true } });
  assert.deepStrictEqual(tr.reply('{"id":9,"result":{"targetId":"P2"}}'), { act: "create", targetId: "P2" });
  // auto-attach: a page, and an iframe whose session acts for that page
  tr.reply('{"method":"Target.attachedToTarget","params":{"sessionId":"S2","targetInfo":{"targetId":"P2","type":"page"},"waitingForDebugger":false}}');
  tr.reply('{"method":"Target.attachedToTarget","params":{"sessionId":"S3","targetInfo":{"targetId":"F1","type":"iframe"},"waitingForDebugger":false},"sessionId":"S2"}');
  assert.strictEqual(tr.command({ id: 10, method: "Input.insertText", sessionId: "S3", params: { text: "x" } }).targetId, "P2");
  tr.reply('{"method":"Target.detachedFromTarget","params":{"sessionId":"S2"}}');
  assert.strictEqual(tr.command({ id: 11, method: "Page.reload", sessionId: "S2" }).act, null);
  // answers nobody waits for (a screenshot) are passed by unparsed
  assert.strictEqual(tr.reply(Buffer.from(`{"id":5,"result":{"data":"${"A".repeat(4096)}`)), null);
  // a /devtools/page/<id> socket: every command acts on that page
  assert.deepStrictEqual(new AgentTracker("P9").command({ id: 1, method: "Page.navigate", params: {} }), { use: true, act: "nav", targetId: "P9" });
});

test("robot checks are recognized for the user (address, title, page text), not every page that says robot", () => {
  assert.strictEqual(wallOf("https://www.google.com/sorry/index?continue=x", ""), "url");
  assert.strictEqual(wallOf("https://example.com/cdn-cgi/challenge-platform/h/b", ""), "url");
  assert.strictEqual(wallOf("https://example.com/", "Just a moment..."), "title");
  assert.strictEqual(wallOf("https://example.com/", "Example", "Our systems have detected unusual traffic from your computer network."), "text");
  assert.strictEqual(wallOf("https://example.com/robots", "Robots in film", "A history of robots on screen."), null);
});

test("workspace: the user's host pick goes over the deck's own connection; a pinned device is the only place", async (t) => {
  const browser = await fakeBrowser();
  const relay = await relayWithCdp();
  const deck = await connectDeck(relay, browser);
  t.after(async () => {
    deck.ws.terminate();
    await relay.stop();
    browser.close();
  });
  const base = `http://127.0.0.1:${relay.cdpPort}`;
  await until(() => relay.presence.activeDevice("browser"));
  let n = 0;
  const req = async (msg) => {
    const id = ++n;
    deck.ws.send(JSON.stringify({ t: "ws-req", id, ...msg }));
    return until(() => deck.json.find((m) => m.t === "ws-res" && m.id === id));
  };
  // decks learn the agent host's name for the picker, with or without its browser
  assert.deepStrictEqual((await until(() => deck.json.find((m) => m.t === "devices"))).agentHost, { name: "agent host" });
  // the agent host has no browser here (DECK_FALLBACK_BROWSER=0): refused with the reason
  const no = await req({ op: "route", slug: "demo", where: "agent-host" });
  assert.strictEqual(no.ok, false);
  assert.match(no.error, /DECK_FALLBACK_BROWSER=1/);
  // "Bu bilgisayar": the deck that asks, by its own heartbeat
  assert.strictEqual((await req({ op: "route", slug: "demo", where: "here" })).ok, true);
  await until(() => deck.json.some((m) => m.t === "devices" && (m.pins || []).some((p) => p.sessionKey === "demo" && p.host.id === DEVICE)));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(relay.dir, "data", "workspace-pins.json"), "utf8")).pins, [{ sessionKey: "demo", capability: "browser", host: { kind: "device", id: DEVICE, name: "Test PC" } }]);
  // the user walks away (no input for 15 min): the agent still gets this deck's browser
  deck.ws.send(JSON.stringify(heartbeat(true, { idleSec: 900 })));
  await until(() => !relay.presence.activeDevice("browser"));
  assert.strictEqual((await (await fetch(`${base}/agent/demo/json/version`)).json()).Browser, "FakeChrome/1.0");
  // its owner switches hosting off: the agent is told why; nothing else stands in
  deck.ws.send(JSON.stringify(heartbeat(false)));
  await until(() => relay.presence.state().devices.every((d) => !d.hosting.browser));
  const r = await fetch(`${base}/agent/demo/json/version`);
  assert.strictEqual(r.status, 503);
  const why = (await r.json()).error;
  assert.match(why, /pinned this agent's browser to one of their computers/);
  assert.doesNotMatch(why, /Test PC/, "the device name never reaches the agent");
  // Otomatik again; malformed requests are refused, never thrown
  assert.strictEqual((await req({ op: "route", slug: "demo", where: "auto" })).ok, true);
  assert.strictEqual((await req({ op: "route", slug: "../x", where: "auto" })).ok, false);
  assert.strictEqual((await req({ op: "route", slug: "demo", where: "mars" })).ok, false);
  assert.strictEqual((await req({ op: "nope", slug: "demo" })).ok, false);
  assert.strictEqual((await req({ op: "watch", slug: "demo" })).ok, false); // no agent-host browser to watch
});

test("cdp: a host pick moves a running agent; its sockets to the old place are cut", async () => {
  const presence = new Presence({ browserDefault: "device", fallback: { browser: { name: "agent host" } } });
  const fallback = { http: async () => ({ status: 200, type: "application/json", body: "{}" }), open: async () => new Channel(0, { send() {}, close() {} }) };
  const gw = new CdpGateway({ presence, fallback, timeoutMs: 1000 });
  const sent = [];
  const conn = { readyState: 1, send: (buf) => sent.push(decodeFrame(buf)) };
  presence.connect(conn);
  gw.addDeck(conn);
  presence.heartbeat(conn, heartbeat(true));
  const opening = gw.open("scout", "/devtools/browser/x");
  await until(() => sent.length === 1);
  gw.onFrame(conn, encodeFrame(OP.OPENED, sent[0].ch));
  const chan = await opening;
  const closed = once(chan, "close");
  assert.deepStrictEqual(presence.setPin("scout", "browser", { kind: "fallback" }), { ok: true });
  const [code, reason] = await closed;
  assert.strictEqual(code, 1012);
  assert.match(reason, /moved/);
  assert.ok(sent.some((f) => f.op === OP.CLOSE && f.ch === sent[0].ch)); // the deck closes its side too
  assert.strictEqual(presence.routeFor("scout", "browser").host.kind, "fallback");
});

test("workspace: the agent host's browser, watched and driven from a deck over its relay connection", { skip: skipChrome, timeout: 90_000 }, async (t) => {
  const relay = await relayWithCdp({ fallback: true });
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
  await once(ws, "open");
  const json = [];
  ws.on("message", (d, bin) => {
    if (!bin) json.push(JSON.parse(d));
  });
  let hermes = null;
  t.after(async () => {
    if (hermes) hermes.ws.terminate();
    ws.terminate();
    await relay.stop();
  });
  let n = 0;
  const req = async (msg) => {
    const id = ++n;
    ws.send(JSON.stringify({ t: "ws-req", id, ...msg }));
    return until(() => json.find((m) => m.t === "ws-res" && m.id === id), 20_000);
  };
  const view = (pred) => until(() => json.find((m) => m.t === "ws-view" && m.slug === "hostview" && pred(m)), 20_000);
  ws.send(JSON.stringify(heartbeat(false))); // this deck does not host: the agent host does
  assert.strictEqual((await req({ op: "route", slug: "hostview", where: "agent-host" })).ok, true);
  assert.strictEqual((await req({ op: "watch", slug: "hostview", maxWidth: 4000, maxHeight: 4000 })).ok, true);

  // Hermes: discovery, then a page; the deck sees it live (tabs, JPEG frames, at most 1024 px)
  const v = await (await fetch(`http://127.0.0.1:${relay.cdpPort}/agent/hostview/json/version`)).json();
  hermes = await cdpCall(v.webSocketDebuggerUrl);
  const { call } = hermes;
  const page = "data:text/html,<title>agent host page</title><button id=b style='width:300px;height:120px' onclick='this.textContent=`clicked`'>x</button><input id=i>";
  const { result: target } = await call("Target.createTarget", { url: page });
  const { result: att } = await call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  await view((m) => m.ev === "tabs" && m.tabs.some((x) => x.shown && x.id === target.targetId && x.title === "agent host page"));
  const frame = await view((m) => m.ev === "frame" && m.targetId === target.targetId);
  const jpeg = Buffer.from(frame.data, "base64");
  assert.ok(jpeg[0] === 0xff && jpeg[1] === 0xd8, "a JPEG frame");
  let w = 0; // the JPEG's own width (SOF0/SOF2 marker): capped at 1024 whatever the deck asked
  for (let i = 2; i < jpeg.length - 8; i++) if (jpeg[i] === 0xff && (jpeg[i + 1] === 0xc0 || jpeg[i + 1] === 0xc2)) (w = jpeg.readUInt16BE(i + 7)), (i = jpeg.length);
  assert.ok(w > 0 && w <= 1024, `frame width ${w}`);
  // every deck learns about the agent host's browser: running, the agent connected and using it
  await until(() => json.some((m) => m.t === "ws-browsers" && m.browsers.some((b) => b.slug === "hostview" && b.status === "running" && b.agentChannels >= 1 && b.lastAgentAt > 0)), 20_000);

  // the user takes control: the agent is refused, the user's click lands (input only while the user holds it)
  assert.strictEqual((await req({ op: "control", slug: "hostview", who: "user" })).ok, true);
  const refused = await call("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 }, att.sessionId);
  assert.strictEqual(refused.error.code, -32000);
  assert.match(refused.error.message, /taken control/);
  const box = JSON.parse((await call("Runtime.evaluate", { expression: "JSON.stringify(document.getElementById('b').getBoundingClientRect())", returnByValue: true }, att.sessionId)).result.result.value);
  const meta = (await view((m) => m.ev === "frame" && m.targetId === target.targetId && m.meta && m.meta.deviceWidth)).meta;
  const at = { x: (box.x + box.width / 2) / meta.deviceWidth, y: (box.y + box.height / 2) / meta.deviceHeight };
  for (const action of ["down", "up"]) ws.send(JSON.stringify({ t: "ws-input", slug: "hostview", ev: { type: "mouse", action, ...at, button: "left", buttons: action === "down" ? 1 : 0, clickCount: 1 } }));
  await untilAsync(async () => (await call("Runtime.evaluate", { expression: "document.getElementById('b').textContent", returnByValue: true }, att.sessionId)).result.result.value === "clicked");
  // the user's typing lands in the focused field while the user holds control (so the check below can fail)
  const typed = async () => (await call("Runtime.evaluate", { expression: "document.getElementById('i').value", returnByValue: true }, att.sessionId)).result.result.value;
  await call("Runtime.evaluate", { expression: "document.getElementById('i').focus()" }, att.sessionId);
  ws.send(JSON.stringify({ t: "ws-input", slug: "hostview", ev: { type: "text", text: "yes" } }));
  await untilAsync(async () => (await typed()) === "yes");
  assert.strictEqual((await req({ op: "control", slug: "hostview", who: "agent" })).ok, true);
  const again = await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }, att.sessionId);
  assert.ok(!again.error, "the agent may click again");
  // input while the agent holds control is ignored: the field still holds only what the user typed before
  ws.send(JSON.stringify({ t: "ws-input", slug: "hostview", ev: { type: "text", text: "nope" } }));
  await new Promise((r) => setTimeout(r, 750)); // "yes" above landed well within this
  assert.strictEqual(await typed(), "yes", "the deck's input reached the page without control");

  // the agent closes its page: the deck keeps it as "Son görülen", not about:blank
  await call("Target.closeTarget", { targetId: target.targetId });
  const seen = await view((m) => m.ev === "tabs" && m.lastSeen);
  assert.strictEqual(seen.lastSeen.title, "agent host page");
  assert.ok(!seen.tabs.some((x) => x.shown));
  // unwatch: no more frames to this deck
  assert.strictEqual((await req({ op: "unwatch", slug: "hostview" })).ok, true);
  assert.strictEqual(relay.fallback.peek("hostview").viewers, 0);
});

test("fallback browser: while the user holds control, /json/new, /json/close and /json/activate are refused", async () => {
  const fb = new FallbackHost({ dir: tmpDir(), browserPath: process.execPath, name: "agent host" }); // never launched here
  const fetched = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => (fetched.push(String(url)), { status: 200, headers: { get: () => "application/json" }, text: async () => "{}" });
  try {
    const a = new HostBrowser("held");
    Object.assign(a, { status: "running", port: 1, wsPath: "/devtools/browser/x", proc: { exitCode: null, kill() {} }, controller: "user" });
    fb.agents.set("held", a);
    for (const p of ["/json/close/T1", "/json/activate/T1", "/json/new?https://example.com/", "/json/new"]) {
      await assert.rejects(fb.http("held", { method: p.startsWith("/json/new") ? "PUT" : "GET", path: p }), (e) => e.status === 409 && /taken control/.test(e.message), p);
    }
    assert.deepStrictEqual(fetched, [], "nothing reached the browser");
    assert.strictEqual((await fb.http("held", { method: "GET", path: "/json/version" })).status, 200); // reading still works
    a.controller = "agent";
    assert.strictEqual((await fb.http("held", { method: "GET", path: "/json/close/T1" })).status, 200);
    assert.deepStrictEqual(fetched, ["http://127.0.0.1:1/json/version", "http://127.0.0.1:1/json/close/T1"]);
  } finally {
    global.fetch = realFetch;
    fb.stopAll();
  }
});

test("fallback browser: the agent's CDP socket is gated like the deck tunnel (legacy transport, tabs, browser close)", async (t) => {
  // a stand-in for the agent host's Chrome: records every method that reaches it and answers {}
  const reached = [];
  const srv = http.createServer();
  const wss = new WebSocketServer({ server: srv });
  wss.on("connection", (s) =>
    s.on("message", (d) => {
      const m = JSON.parse(d);
      reached.push(m.method);
      s.send(JSON.stringify({ id: m.id, result: {}, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
    })
  );
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const fb = new FallbackHost({ dir: tmpDir(), browserPath: process.execPath, name: "agent host" }); // never launched here
  const a = new HostBrowser("gate");
  Object.assign(a, { status: "running", port: srv.address().port, wsPath: "/devtools/browser/x", proc: { exitCode: null, kill() {} } });
  fb.agents.set("gate", a);
  const chan = await fb.open("gate", "/devtools/browser/x");
  t.after(() => {
    chan.close();
    wss.clients.forEach((c) => c.terminate());
    srv.close();
    fb.stopAll();
  });
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
  const legacy = [
    ["Target.sendMessageToTarget", { sessionId: "S1", message: JSON.stringify({ id: 1, method: "Page.navigate", params: { url: "https://example.com/" } }) }],
    ["Target.attachToTarget", { targetId: "T1", flatten: false }],
    ["Target.attachToTarget", { targetId: "T1" }],
    ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false }],
  ];
  // the legacy (non-flat) transport hides the inner command from the gate: refused whoever holds control
  for (const [m, p] of legacy) {
    const r = await call(m, p);
    assert.ok(r.error && /flatten:true/.test(r.error.message), `${m} ${JSON.stringify(p)} refused under agent control`);
  }
  a.controller = "user";
  for (const [m, p] of legacy) {
    const r = await call(m, p);
    assert.ok(r.error && /flatten:true/.test(r.error.message), `${m} refused under user control`);
  }
  // while the user drives: no new tab (it would hide the user's tab), no closing contexts or the browser
  for (const m of ["Target.createTarget", "Target.disposeBrowserContext", "Browser.close", "Browser.crash", "Browser.crashGpuProcess"]) {
    const r = await call(m, m === "Target.createTarget" ? { url: "about:blank" } : { browserContextId: "C1" });
    assert.ok(r.error && /taken control/.test(r.error.message), `${m} refused under user control`);
  }
  assert.deepStrictEqual(reached, [], "nothing reached the browser");
  // flat attach and reads still work while the user drives
  assert.ok(!(await call("Target.attachToTarget", { targetId: "T1", flatten: true })).error);
  assert.ok(!(await call("Target.getTargets")).error);
  // the agent's turn again: tabs and flat sessions pass
  a.controller = "agent";
  assert.ok(!(await call("Target.createTarget", { url: "about:blank" })).error);
  assert.deepStrictEqual(reached, ["Target.attachToTarget", "Target.getTargets", "Target.createTarget"]);
});

test("fallback browser: control survives a browser exit, and can always be handed back", async () => {
  const fb = new FallbackHost({ dir: tmpDir(), browserPath: process.execPath, name: "agent host" }); // never launched here
  try {
    const a = new HostBrowser("exit");
    Object.assign(a, { status: "running", port: 1, wsPath: "/devtools/browser/x", proc: { exitCode: null, kill() {} } });
    fb.agents.set("exit", a);
    fb.setController("exit", "user");
    a._gone(); // the browser exits (crash, or any close that got past the gate)
    assert.strictEqual(a.status, "stopped");
    assert.strictEqual(a.controller, "user", "the user keeps control: a relaunch does not hand the browser to the agent");
    assert.throws(() => fb.setController("exit", "user"), (e) => e.status === 409, "taking control still needs a running browser");
    fb.setController("exit", "agent"); // releasing always works
    assert.strictEqual(a.controller, "agent");
  } finally {
    fb.stopAll();
  }
});

test("workspace: the controlling deck leaving releases a stopped browser too", () => {
  const b = new HostBrowser("gone");
  Object.assign(b, { status: "stopped", controller: "user" });
  const fallback = Object.assign(new (require("events").EventEmitter)(), {
    available: true,
    name: "agent host",
    peek: (slug) => (slug === "gone" ? b : null),
    list: () => [b.info()],
    setController: (slug, who) => {
      b.controller = who;
    },
  });
  const sent = [];
  const deck = { readyState: 1, send() {} };
  const hub = new WorkspaceHub({ presence: {}, fallback, broadcast: (m) => sent.push(m) });
  hub.holders.set("gone", deck);
  hub.onClose(deck);
  assert.strictEqual(b.controller, "agent", "a browser that exited under user control goes back to the agent with its deck");
  assert.ok(sent.some((m) => m.t === "ws-browsers" && m.browsers[0].controller === "agent"));
  hub.stop();
});

test("workspace: control belongs to the deck that took it; the new controller reaches it before the answer", async () => {
  const b = new HostBrowser("ctl");
  Object.assign(b, { status: "running", port: 1, wsPath: "/devtools/browser/x" });
  const fallback = Object.assign(new (require("events").EventEmitter)(), {
    available: true,
    name: "agent host",
    peek: (slug) => (slug === "ctl" ? b : null),
    list: () => [b.info()],
    setController: (slug, who) => {
      b.controller = who;
    },
  });
  const sent = [];
  const deck = { readyState: 1, send: (d) => sent.push(JSON.parse(d)) };
  const hub = new WorkspaceHub({ presence: {}, fallback, broadcast: (m) => sent.push({ ...m, broadcast: true }) });
  hub.onMessage(deck, { t: "ws-req", id: 1, op: "control", slug: "ctl", who: "user" });
  await until(() => sent.some((m) => m.t === "ws-res" && m.id === 1));
  const res = sent.findIndex((m) => m.t === "ws-res" && m.id === 1);
  const list = sent.findIndex((m) => m.t === "ws-browsers" && m.browsers[0].controller === "user");
  assert.ok(list >= 0 && list < res, "ws-browsers with controller user comes before ws-res");
  // the controlling deck drops: the agent gets its browser back, and every deck hears it
  hub.onClose(deck);
  assert.strictEqual(b.controller, "agent");
  assert.ok(sent.some((m) => m.broadcast && m.t === "ws-browsers" && m.browsers[0].controller === "agent"));
  // another deck closing does not touch control
  b.controller = "user";
  hub.holders.set("ctl", deck);
  hub.onClose({ readyState: 1, send() {} });
  assert.strictEqual(b.controller, "user");
  hub.stop();
});

test("live view on a real Chrome: watching another tab never hides the agent's tab or slows its screenshots", { skip: skipChrome, timeout: 60_000 }, async (t) => {
  const { launchHeadless } = require("../src/browser");
  const dir = tmpDir();
  const r = await launchHeadless(browserExe, path.join(dir, "profile"));
  const b = new (require("events").EventEmitter)();
  Object.assign(b, { port: r.port, wsPath: r.wsPath, controller: "agent", lastAct: null });
  let lv = null;
  const agent = await cdpCall(`ws://127.0.0.1:${r.port}${r.wsPath}`);
  t.after(() => {
    if (lv) lv.stop();
    agent.ws.terminate();
    r.proc.kill();
  });
  const { call } = agent;
  // the agent's tab, in front, with an animation (a hidden tab would stall it)
  const page = (title) => `data:text/html,<title>${title}</title><body><div id=d></div><script>let n=0;(function f(){document.getElementById('d').textContent=++n;requestAnimationFrame(f)})()</script>`;
  const mine = (await call("Target.createTarget", { url: page("agent tab") })).result.targetId;
  const sid = (await call("Target.attachToTarget", { targetId: mine, flatten: true })).result.sessionId;
  await call("Target.activateTarget", { targetId: mine });
  const other = (await call("Target.createTarget", { url: page("other tab"), background: true })).result.targetId;
  const vis = async () => (await call("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }, sid)).result.result.value;
  await untilAsync(async () => (await vis()) === "visible");
  b.lastAct = { targetId: mine, act: "nav", at: Date.now() };
  lv = new LiveView(b, { fps: 4 });
  await lv.start();
  assert.strictEqual(lv.targetId, mine);
  // the user picks the other tab without taking control
  await lv.selectTab(other);
  await new Promise((res) => setTimeout(res, 500));
  assert.strictEqual(await vis(), "visible", "the agent's tab is still in front");
  const t0 = Date.now();
  const shot = await call("Page.captureScreenshot", { format: "jpeg", quality: 30 }, sid);
  const ms = Date.now() - t0;
  assert.ok(shot.result && shot.result.data, "the agent's screenshot works");
  assert.ok(ms < 1500, `the agent's screenshot stays fast (${ms} ms)`);
  await until(() => lv.status().hidden === true, 5000); // the picked background tab is flagged, not forced forward
  // taking control brings the picked tab forward (the user drives it now)
  b.controller = "user";
  lv.focus();
  await until(() => lv.status().hidden === false, 5000);
  assert.strictEqual(await vis(), "hidden");
});
