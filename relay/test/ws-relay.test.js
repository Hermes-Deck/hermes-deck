"use strict";
// Workspace "relay is not connected" recovery, relay tests: a deck that lost the one-shot {t:"devices"} message asks
// for it again ({t:"devices?"}), and the whole agent-browser path works end to end with FAKES (no Chrome, no live
// ports): Hermes' CDP URL (/agent/<profile>) -> gateway -> agent host browser -> {t:"ws-browsers"} on the deck.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const { start } = require("../src/index");

const TOKEN = "t".repeat(32);
const PC = "a1b2c3d4e5f60708";
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
const beat = { t: "heartbeat", device: { id: PC, name: "Test PC" }, os: "win32", idleSec: 1, locked: false, hosting: { browser: true, desktop: false }, driverOk: { browser: true } };

/** A stand-in for the agent host's persistent Chrome: /json/version + a browser socket that answers every command. */
async function fakeChrome() {
  const methods = [];
  const srv = http.createServer((req, res) => {
    const port = srv.address().port;
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/json/version")) return res.end(JSON.stringify({ Browser: "FakeChrome/1.0", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake-1` }));
    res.statusCode = 404;
    res.end("{}");
  });
  const wss = new WebSocket.WebSocketServer({ server: srv });
  wss.on("connection", (ws) =>
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      methods.push(m.method);
      const result = m.method === "Target.createTarget" ? { targetId: "PAGE1" } : m.method === "Target.attachToTarget" ? { sessionId: "S1" } : m.method === "Target.getTargets" ? { targetInfos: [] } : {};
      ws.send(JSON.stringify({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
    })
  );
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, methods, close: () => (wss.clients.forEach((c) => c.terminate()), srv.close()) };
}

async function relayWith(t, { profile = "default" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-wsrelay-"));
  const chrome = await fakeChrome();
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify({ profiles: {} }));
  const cfg = {
    host: "127.0.0.1", port: 0, token: TOKEN, eventsDir: path.join(dir, "events"), stateDir: path.join(dir, "state"), dataDir: path.join(dir, "data"),
    claudeDirs: [], claudeProfile: "claude-code", claudeChatMap: null, launchdPrefixes: [], codexbar: null, agentsFile, broadcastWindowS: 300, tickMs: 100,
    cdp: { port: 0, defaultAgent: profile, fallback: false, browserPath: null, externalCdp: `http://127.0.0.1:${chrome.port}`, externalAgent: profile, browserDefault: "host", probeMs: 500 },
    hostName: "agent host",
  };
  const relay = await start(cfg);
  const decks = [];
  t.after(async () => {
    for (const d of decks) d.terminate();
    await relay.stop();
    chrome.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const deck = async (open = true) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
    decks.push(ws);
    const json = [];
    ws.on("message", (d, bin) => {
      if (!bin) json.push(JSON.parse(d));
    });
    if (open) await once(ws, "open");
    return { ws, json };
  };
  return { relay, chrome, deck };
}

test("relay: a deck that missed the one-shot device list asks again with devices? and gets it (and the browsers)", async (t) => {
  const { relay, deck } = await relayWith(t);
  const d = await deck();
  d.ws.send(JSON.stringify(beat));
  await until(() => d.json.some((m) => m.t === "devices"));
  const first = d.json.filter((m) => m.t === "devices").length;
  assert.ok(first >= 1);
  d.json.length = 0;
  d.ws.send(JSON.stringify({ t: "devices?" }));
  const again = await until(() => d.json.find((m) => m.t === "devices"));
  assert.ok(Array.isArray(again.pins) && Array.isArray(again.routes), "the full list, with pins");
  assert.strictEqual(again.defaults.browser, "host");
  assert.deepStrictEqual(again.agentHost, { name: "agent host" });
  assert.ok(again.fallback.browser.agents.includes("default"), "the agent host serves the default agent");
  await until(() => d.json.find((m) => m.t === "ws-browsers"));
  // the ask is handled by the deck hooks, not mistaken for a Workspace request (no ws-res, no error)
  assert.ok(!d.json.some((m) => m.t === "ws-res"));
  // the relay survives junk of the same shape
  d.ws.send(JSON.stringify({ t: "devices?", extra: "x".repeat(100) }));
  await until(() => d.json.filter((m) => m.t === "devices").length >= 2);
  assert.ok(relay.port > 0);
});

test("agent-browser path with fakes: Hermes' /agent/<profile> CDP URL reaches the agent host browser and the deck sees it", async (t) => {
  const { relay, chrome, deck } = await relayWith(t, { profile: "default" });
  // the deck connects LATE (after the relay's start) and lost its one-shot messages: it asks, and learns everything
  const d = await deck();
  d.ws.send(JSON.stringify(beat));
  d.json.length = 0;
  d.ws.send(JSON.stringify({ t: "devices?" }));
  const devices = await until(() => d.json.find((m) => m.t === "devices"));
  assert.strictEqual(devices.fallback.browser.agents[0], "default");

  // Hermes (browser.cdp_url = http://127.0.0.1:<port>/agent/default): discovery is rewritten onto the gateway
  const v = await (await fetch(`http://127.0.0.1:${relay.cdpPort}/agent/default/json/version`)).json();
  assert.match(v.webSocketDebuggerUrl, new RegExp(`^ws://127\\.0\\.0\\.1:${relay.cdpPort}/agent/default/devtools/browser/`));
  assert.doesNotMatch(JSON.stringify(v), new RegExp(String(chrome.port)), "the agent never sees the browser's own port");
  // a bare /json/version belongs to the default agent too (DECK_CDP_DEFAULT_AGENT)
  const bare = await (await fetch(`http://127.0.0.1:${relay.cdpPort}/json/version`)).json();
  assert.match(bare.webSocketDebuggerUrl, /\/agent\/default\//);

  // the agent opens a page over CDP
  const agent = new WebSocket(v.webSocketDebuggerUrl);
  await once(agent, "open");
  const answers = new Map();
  agent.on("message", (raw) => {
    const m = JSON.parse(raw);
    answers.set(m.id, m);
  });
  let id = 0;
  const call = async (method, params = {}) => {
    const i = ++id;
    agent.send(JSON.stringify({ id: i, method, params }));
    return until(() => answers.get(i));
  };
  assert.strictEqual((await call("Target.createTarget", { url: "https://example.com/" })).result.targetId, "PAGE1");
  t.after(() => agent.terminate());
  assert.ok(chrome.methods.includes("Target.createTarget"), "the command reached the agent host's browser");

  // the deck's Workspace data: a running browser for "default" with the agent's channel and use
  const b = await until(async () => {
    const m = [...d.json].reverse().find((x) => x.t === "ws-browsers" && x.browsers.some((i) => i.slug === "default" && i.agentChannels >= 1));
    return m && m.browsers.find((i) => i.slug === "default");
  });
  assert.strictEqual(b.status, "running");
  assert.strictEqual(b.external, true);
  assert.ok(b.lastAgentAt > 0, "the agent's command counts as use: the footer stops saying 'has not used this browser yet'");
  // the route the picker follows for this slug is the agent host
  assert.strictEqual(relay.presence.routeFor("default", "browser").host.kind, "fallback");
  // The shared host browser belongs to ONE slug. Another profile (e.g. Hermes profile "ada" while cdp_url says
  // /agent/default) is not served there: it routes to a hosting Deck, never into the host browser, and the picker's
  // "default" entry is the one that shows this browser.
  assert.strictEqual(relay.presence.routeFor("ada", "browser").host.id, PC);
  assert.strictEqual(relay.fallback.serves("ada"), false);
});
