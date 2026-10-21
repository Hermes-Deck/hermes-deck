"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");
const { config, extraListeners, start } = require("../src/index");

const TOKEN = "t".repeat(32);
const UNAVAILABLE = "192.0.2.1"; // TEST-NET-1 (RFC 5737): never an address of this machine
const quiet = { log() {}, warn() {} };

/** True when this machine can listen on `host` (IPv6 loopback is missing on some CI runners). */
const canListen = (host) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(0, host, () => s.close(() => resolve(true)));
  });

const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("config(): DECK_RELAY_HOST takes a comma-separated list; the first address is the main one", () => {
  assert.deepStrictEqual([config({}).host, config({}).extraHosts], ["127.0.0.1", []]);
  const c = config({ DECK_RELAY_HOST: " 127.0.0.1 , 192.0.2.20,," });
  assert.strictEqual(c.host, "127.0.0.1");
  assert.deepStrictEqual(c.extraHosts, ["192.0.2.20"]);
  assert.deepStrictEqual(config({ DECK_RELAY_HOST: "fd7a::1" }).extraHosts, []);
});

test("extraListeners: an address this machine lacks is skipped with one warning, the main listener keeps serving", async (t) => {
  const server = http.createServer((_req, res) => res.end("ok"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const warnings = [];
  const extras = extraListeners(server, [UNAVAILABLE], server.address().port, { retryMs: 20, log: { log() {}, warn: (m) => warnings.push(m) } });
  t.after(() => extras.close());
  assert.deepStrictEqual(await extras.ready, [false]);
  assert.deepStrictEqual(extras.addresses(), []);
  await new Promise((r) => setTimeout(r, 120)); // several retries
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /192\.0\.2\.1/);
  assert.strictEqual(await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text(), "ok");
});

test("extraListeners: a busy address is retried and served once it is free", async (t) => {
  if (!(await canListen("::1"))) return t.skip("no IPv6 loopback");
  const server = http.createServer((_req, res) => res.end("ok"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = server.address().port;
  const blocker = net.createServer();
  const blocked = await new Promise((r) => {
    blocker.once("error", () => r(false));
    blocker.listen(port, "::1", () => r(true));
  });
  if (!blocked) return t.skip("port taken on ::1");
  const extras = extraListeners(server, ["::1"], port, { retryMs: 20, log: quiet });
  t.after(() => extras.close());
  assert.deepStrictEqual(await extras.ready, [false]);
  await new Promise((r) => blocker.close(r));
  await until(() => extras.addresses().length === 1);
  assert.strictEqual(await (await fetch(`http://[::1]:${port}/`)).text(), "ok");
  await extras.close();
  await assert.rejects(() => fetch(`http://[::1]:${port}/`));
});

test("relay: an extra address serves the same routes, auth and WebSocket; a missing one does not stop startup", async (t) => {
  const v6 = await canListen("::1");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-relay-"));
  const eventsDir = path.join(dir, "events");
  fs.mkdirSync(eventsDir);
  const cfg = {
    host: "127.0.0.1", extraHosts: [...(v6 ? ["::1"] : []), UNAVAILABLE], port: 0, token: TOKEN, eventsDir,
    stateDir: path.join(dir, "state"), dataDir: path.join(dir, "data"), claudeDirs: [], claudeProfile: "claude-code",
    claudeChatMap: null, launchdPrefixes: [], codexbar: null, agentsFile: path.join(dir, "agents.json"), broadcastWindowS: 300, tickMs: 100,
  };
  const warn = t.mock.method(console, "warn", () => {});
  t.mock.method(console, "log", () => {});
  const relay = await start(cfg);
  t.after(() => relay.stop());
  assert.deepStrictEqual(relay.listening(), ["127.0.0.1", ...(v6 ? ["::1"] : [])]);
  assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes(UNAVAILABLE)));
  if (!v6) return t.skip("no IPv6 loopback for the extra-address checks");

  const base = `http://[::1]:${relay.port}`;
  assert.strictEqual((await fetch(`${base}/health`)).status, 200);
  assert.strictEqual((await fetch(`${base}/snapshot`)).status, 401);
  assert.strictEqual((await fetch(`${base}/snapshot`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  const refused = new WebSocket(`ws://[::1]:${relay.port}/events`);
  assert.strictEqual(await new Promise((resolve) => {
    refused.on("unexpected-response", (_req, res) => resolve(res.statusCode));
    refused.on("open", () => resolve("open"));
    refused.on("error", () => {});
  }), 401);
  const ws = new WebSocket(`ws://[::1]:${relay.port}/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const first = await new Promise((resolve, reject) => {
    ws.once("message", (m) => resolve(JSON.parse(String(m))));
    ws.once("error", reject);
  });
  assert.ok(first && typeof first === "object");
  ws.close();
});
