"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Spaces } = require("../src/spaces");
const { SpaceLock } = require("../src/space-lock");

const mk = (o = {}) => new Spaces({ mode: "shared", lock: new SpaceLock(), spacesd: null, ...o });

test("gate: host route takes the shared lock; a second agent gets a readable busy error", () => {
  const s = mk();
  assert.deepEqual(s.gate("aurora", "host"), { ok: true });
  const r = s.gate("pioneer", "host");
  assert.equal(r.ok, false);
  assert.equal(r.busy, true);
  assert.match(r.error, /in use by aurora; you are 1st in line/);
});

test("gate: a device route never touches the lock", () => {
  const s = mk();
  s.gate("aurora", "host");
  assert.deepEqual(s.gate("pioneer", "device"), { ok: true });
});

test("gate: per-agent mode has no lock", () => {
  const s = mk({ mode: "agent" });
  s.gate("aurora", "host");
  assert.deepEqual(s.gate("pioneer", "host"), { ok: true });
});

test("gate: user control fails fast with the spec's message", () => {
  const s = mk();
  s.takeUser();
  const r = s.gate("aurora", "host");
  assert.equal(r.ok, false);
  assert.equal(r.error, "The user is controlling this desktop.");
});

test("list never includes the spacesd token", async () => {
  const s = mk({ spacesd: { url: "http://127.0.0.1:3211", tokenFile: "/nonexistent" } });
  const txt = JSON.stringify(s.list());
  assert.doesNotMatch(txt, /token/i);
  assert.equal(s.list().spaces[0].id, "host");
});


test("POST /spaces/route pins and unpins through presence", async () => {
  const calls = [];
  const presence = { setPin: (k, cap, pin) => (calls.push([k, cap, pin]), { ok: true }) };
  const s = new Spaces({ mode: "shared", lock: new SpaceLock(), presence });
  const res = await s._route({ profile: "aurora", target: "device:a1b2c3d4" });
  assert.deepEqual(res, { ok: true });
  await s._route({ profile: "aurora", target: "space" });
  assert.deepEqual(calls, [["p:aurora", "desktop", { kind: "device", id: "a1b2c3d4" }], ["p:aurora", "desktop", null]]);
  assert.deepEqual(await s._route({ profile: "../x", target: "space" }), { ok: false, code: "bad" });
});

const http = require("node:http");

test("control levels: full takes the lock for the user, release gives it back", async () => {
  const s = new Spaces({ mode: "shared", lock: new SpaceLock() });
  s.gate("aurora", "host");
  assert.equal((await s._control({ level: "full" })).state.holder, "user");
  assert.equal((await s._control({ level: "release" })).state.holder, "aurora");
  assert.deepEqual(await s._control({ level: "bogus" }), { ok: false, error: "bad level" });
});

test("full control ends by itself 30 s after the last view socket closed", () => {
  const c = { t: 0 };
  const s = new Spaces({ mode: "shared", lock: new SpaceLock({ now: () => c.t }), now: () => c.t });
  s._control({ level: "full" });
  s.viewerOpened();
  s.viewerClosed();
  c.t = 29_000;
  s.sweep();
  assert.equal(s.list().spaces[0].holder, "user");
  c.t = 31_000;
  s.sweep();
  assert.equal(s.list().spaces[0].user, false);
});

test("view proxy: adds the spacesd token, refuses paths outside the allow list and traversal", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const seen = [];
  const upstream = http.createServer((req, res) => { seen.push([req.url, req.headers.authorization]); res.end("ok"); });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  upstream.unref(); // a failing assert must not leave the run hanging
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sp-")), "token");
  fs.writeFileSync(tokenFile, "secret-env-token\n", { mode: 0o600 });
  const s = new Spaces({ mode: "shared", lock: new SpaceLock(), spacesd: { url: `http://127.0.0.1:${upstream.address().port}`, tokenFile } });
  const front = http.createServer((req, res) => { if (!s.onHttp(req, res, new URL(req.url, "http://relay"))) { res.statusCode = 404; res.end(); } });
  await new Promise((r) => front.listen(0, "127.0.0.1", r));
  front.unref();
  const base = `http://127.0.0.1:${front.address().port}`;
  const ok = await fetch(`${base}/spaces/host/view/viewer/index.html`);
  assert.equal(ok.status, 200);
  assert.deepEqual(seen[0], ["/viewer/index.html", "Bearer secret-env-token"]);
  for (const bad of ["/spaces/host/view/../health", "/spaces/host/view/%2e%2e/health", "/spaces/host/view/files/x", "/spaces/host/view//etc"]) {
    const r = await fetch(`${base}${bad}`);
    assert.equal(r.status, 403, bad);
  }
  upstream.close();
  front.close();
});

test("view proxy: the allow list follows the control level (probe: only what the viewer calls)", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const upstream = http.createServer((req, res) => res.end("ok"));
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  upstream.unref(); // a failing assert must not leave the run hanging
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sp-")), "token");
  fs.writeFileSync(tokenFile, "t\n", { mode: 0o600 });
  const s = new Spaces({ mode: "shared", lock: new SpaceLock(), spacesd: { url: `http://127.0.0.1:${upstream.address().port}`, tokenFile } });
  const front = http.createServer((req, res) => { if (!s.onHttp(req, res, new URL(req.url, "http://relay"))) { res.statusCode = 404; res.end(); } });
  await new Promise((r) => front.listen(0, "127.0.0.1", r));
  front.unref();
  const st = async (p) => (await fetch(`http://127.0.0.1:${front.address().port}/spaces/host/view/${p}`, { method: "POST" })).status;
  assert.equal(await st("cua.env.v1.StreamService/OpenMedia"), 200);
  assert.equal(await st("cua.env.v1.PresenceService/Join"), 200);
  assert.equal(await st("cua.env.v1.SystemService/GetCapabilities"), 200);
  assert.equal(await st("cua.env.v1.SystemService/Shutdown"), 403);
  assert.equal(await st("cua.env.v1.ProcessService/Spawn"), 403);
  assert.equal(await st("cua.env.v1.ComputerService/Click"), 403, "watch: no input");
  await s._control({ level: "together" });
  assert.equal(await st("cua.env.v1.ComputerService/Click"), 200);
  await s._control({ level: "watch" });
  assert.equal(await st("cua.env.v1.ComputerService/Click"), 403);
  upstream.close();
  front.close();
});

test("relay: a /spaces/ WebSocket needs the relay token before the space hook sees it", async () => {
  const net = require("node:net");
  const { createServer } = require("../src/server");
  const TOKEN = "r".repeat(32);
  const seen = [];
  const hooks = { onUpgrade: (req, socket) => (seen.push(req.url), socket.end("HTTP/1.1 204 No Content\r\n\r\n"), true) };
  const relay = createServer({ token: TOKEN, model: { sessions: new Map(), snapshot: () => ({}), tokens: () => ({}) }, fleet: { data: {} }, hooks });
  relay.server.listen(0, "127.0.0.1");
  await new Promise((r) => relay.server.once("listening", r));
  const port = relay.server.address().port;
  const ask = (auth) =>
    new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () =>
        s.write(`GET /spaces/host/view/media HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${auth}\r\n`)
      );
      let got = "";
      s.on("data", (b) => (got += b));
      s.on("close", () => resolve(got.split("\r\n")[0]));
    });
  assert.match(await ask(""), /401/);
  assert.equal(seen.length, 0);
  assert.match(await ask(`Authorization: Bearer ${TOKEN}\r\n`), /204/);
  assert.deepEqual(seen, ["/spaces/host/view/media"]);
  await new Promise((r) => relay.server.close(r));
});

test("POST /spaces/mode: shared is accepted, per-agent answers phase 2", async () => {
  const s = new Spaces({ mode: "shared", lock: new SpaceLock() });
  assert.deepEqual(await s._mode({ mode: "agent" }), { ok: false, error: "phase 2" });
  assert.deepEqual(await s._mode({ mode: "shared" }), { ok: true, mode: "shared" });
  assert.deepEqual(await s._mode({ mode: "x" }), { ok: false, error: "bad mode" });
});

test("list shows which agents are pinned to a device (work on this device), and nothing else of the pins", () => {
  const presence = { pinList: () => [
    { sessionKey: "p:aurora", capability: "desktop", host: { kind: "device", id: "a1b2c3d4", name: "pc" } },
    { sessionKey: "scout", capability: "browser", host: { kind: "device", id: "a1b2c3d4" } },
  ] };
  const s = new Spaces({ mode: "shared", lock: new SpaceLock(), presence });
  assert.deepEqual(s.list().here, [{ profile: "aurora", device: "a1b2c3d4" }]);
  assert.deepEqual(new Spaces({ mode: "shared", lock: new SpaceLock() }).list().here, []);
});

test("list reports the control level, so a Deck follows the relay (a restarted relay is back at watch)", async () => {
  const s = new Spaces({ mode: "shared", lock: new SpaceLock() });
  assert.equal(s.list().spaces[0].level, "watch");
  await s._control({ level: "together" });
  assert.equal(s.list().spaces[0].level, "together");
  await s._control({ level: "full" });
  assert.equal(s.list().spaces[0].level, "full");
  await s._control({ level: "release" });
  assert.equal(s.list().spaces[0].level, "watch");
});

test("full control also ends when no Deck has asked for /spaces for 30 s, even if a view socket looks open (a crashed or sleeping Deck)", async () => {
  const c = { t: 0 };
  const s = new Spaces({ mode: "shared", lock: new SpaceLock({ now: () => c.t }), now: () => c.t });
  await s._control({ level: "full" });
  s.viewerOpened(); // half-open: the Deck died without closing it
  c.t = 20_000;
  s.polled(); // the panel still asks every 3 s
  c.t = 45_000;
  s.sweep();
  assert.equal(s.list().spaces[0].user, true, "asked 25 s ago: still the user's");
  c.t = 51_000;
  s.sweep();
  assert.equal(s.list().spaces[0].user, false);
  assert.equal(s.list().spaces[0].level, "watch");
});

test("gate: a read-only action (capture, listing) looks without taking the desktop or a place in line", () => {
  const s = mk();
  assert.deepEqual(s.gate("aurora", "host"), { ok: true });
  assert.deepEqual(s.gate("pioneer", "host", { read: true }), { ok: true });
  assert.deepEqual(s.list().spaces[0].queue, [], "no place taken");
  assert.equal(s.list().spaces[0].holder, "aurora");
  s.release("aurora");
  assert.deepEqual(s.gate("pioneer", "host", { read: true }), { ok: true });
  assert.equal(s.list().spaces[0].holder, null, "looking does not take a free desktop either");
  assert.equal(s.gate("pioneer", "host").ok, true, "its first input takes it");
});

test("list names the holder for display (agent names come from the relay's agents.json)", () => {
  const s = new Spaces({ mode: "shared", lock: new SpaceLock(), agentName: (p) => ({ aurora: "Aurora" })[p] || p });
  assert.equal(s.list().spaces[0].holderName, null);
  s.gate("aurora", "host");
  assert.equal(s.list().spaces[0].holderName, "Aurora");
});
