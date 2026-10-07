"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Spaces } = require("../src/spaces");
const { SpaceLock } = require("../src/space-lock");

// The fixtures unref their servers and sockets so a failing assert cannot hang the run. On Linux a socket event can
// then arrive after Node sees an empty loop and cancels the file; one ref'd timer keeps it polling until the end.
const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));

const mk =(o = {}) => new Spaces({ mode: "shared", lock: new SpaceLock(), spacesd: null, ...o });

test("overflow: configuration accepts the mode and clamps sticky seconds", () => {
  const { config } = require("../src/index");
  for (const [value, ms] of [[undefined, 120000], ["", 120000], ["bad", 120000], ["0", 30000], ["29", 30000], ["45", 45000], ["901", 900000]]) {
    const cfg = config({ DECK_SPACES: "overflow", DECK_SPACES_STICKY_SEC: value });
    assert.equal(cfg.spaces?.mode, "overflow");
    assert.equal(cfg.driver.stickyMs, ms, String(value));
  }
  assert.equal(mk().mode, "shared");
});

test("overflow: shared gate takes turns without an explicit fallback flag", () => {
  const s = mk({ mode: "overflow" });
  assert.deepEqual(s.gate("aurora", "host"), { ok: true });
  assert.equal(s.gate("scout", "host").busy, true);
  assert.equal(s.gate("scout", "host", { read: true }).ok, true);
});

test("overflow: list marks the shared holder and restores the real desktop state on release", () => {
  const s = mk({ mode: "overflow", desktops: fakeDesktops([]), profiles: () => ["aurora", "scout"] });
  const row = () => s.list().spaces.find((r) => r.id === "aurora");
  s.gate("aurora", "host");
  assert.equal(row().usingShared, true);
  assert.equal(row().state, "off");
  assert.equal(row().fallback, null);
  assert.equal(s.list().spaces.find((r) => r.id === "scout").usingShared, false);
  s.release("aurora");
  assert.equal(row().usingShared, false);
  assert.equal(row().state, "off");
  s.gate("aurora", "host");
  s.mode = "agent";
  assert.equal(row().usingShared, false);
});

test("overflow: constructor and mode API accept desktops and reject missing registry", async (t) => {
  const s = mk({ mode: "overflow", desktops: fakeDesktops([]) });
  assert.equal(s.list().mode, "overflow");
  for (const [spaces, expected] of [[s, { ok: true, mode: "overflow" }], [mk(), { ok: false, error: "no desktop host" }]]) {
    const f = await front(spaces);
    t.after(() => f.srv.close());
    const r = await fetch(`${f.base}/spaces/mode`, { method: "POST", body: JSON.stringify({ mode: "overflow" }) });
    assert.deepEqual(await r.json(), expected);
  }
});

for (const feature of ["list", "control", "start", "watching", "view"]) test(`overflow: per-desktop API ${feature}`, async (t) => {
  const desktops = fakeDesktops([{ profile: "aurora", host: "a1b2c3d4", state: "ready" }], {
    start: async () => ({ kind: "space", host: "a1b2c3d4" }), state: () => "ready",
  });
  const s = mk({ desktops });
  s.mode = "overflow"; // exercise each feature independently of constructor/mode parsing
  const f = await front(s);
  t.after(() => f.srv.close());
  const post = async (path, b) => (await fetch(`${f.base}${path}`, { method: "POST", body: JSON.stringify(b) })).json();
  if (feature === "list") {
    const list = await (await fetch(`${f.base}/spaces`)).json();
    assert.deepEqual(list.spaces.map((r) => r.id), ["host", "aurora"]);
  } else if (feature === "control") {
    assert.equal((await post("/spaces/control", { space: "aurora", level: "full" })).ok, true);
    assert.equal(s.gate("aurora", "space:aurora@a1b2c3d4", { read: true }).ok, false);
    assert.equal(s.gate("scout", "space:scout@a1b2c3d4").ok, true);
  } else if (feature === "start") {
    assert.deepEqual(await post("/spaces/desktop", { profile: "aurora", action: "start" }), { ok: true, state: "ready" });
  } else if (feature === "watching") {
    await fetch(`${f.base}/spaces?watching=aurora`);
    assert.deepEqual(desktops.calls.watching, [["aurora", true]]);
  } else {
    // A known desktop reaches the view transport (absent here -> 502), rather than being rejected as unknown.
    assert.equal((await fetch(`${f.base}/spaces/aurora/view/viewer/`)).status, 502);
  }
});

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

test("POST /spaces/mode: shared is accepted, per-agent needs a desktop host", async () => {
  const s = new Spaces({ mode: "shared", lock: new SpaceLock() });
  assert.deepEqual(await s._mode({ mode: "agent" }), { ok: false, error: "no desktop host" });
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

// ---- agent spaces phase 2: one desktop per agent (spec 2026-10-07, sections 4.4, 6, 7) ------------------------

const net = require("node:net");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { makeSpaceFetch, makeReady, pickHeaders, viewPath, upgradeRequest } = require("../src/spaces");

const listen = async (srv) => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  srv.unref(); // a failing assert must not leave the run hanging
  return srv.address().port;
};
/** A front server that hands every request and upgrade to the Spaces under test, as the relay does. */
async function front(s) {
  const srv = http.createServer((req, res) => {
    if (!s.onHttp(req, res, new URL(req.url, "http://relay"))) {
      res.statusCode = 404;
      res.end();
    }
  });
  srv.on("connection", (c) => c.unref()); // a failing assert must not leave the run hanging on an open socket
  srv.on("upgrade", (req, socket, head) => {
    if (!s.onUpgrade(req, socket, head, new URL(req.url, "http://relay"))) socket.destroy();
  });
  const port = await listen(srv);
  return { srv, port, base: `http://127.0.0.1:${port}` };
}
/** A fake Desktops: `rows` [{profile, host, state}], records watching/markOff calls. */
function fakeDesktops(rows, extra = {}) {
  const calls = { watching: [], markOff: [] };
  return {
    calls,
    list: () => rows,
    hosts: () => [{ id: "agent-host", name: "mac", ready: true, limit: 1, running: 1 }, { id: "a1b2c3d4", name: "pc", ready: true, limit: 3, running: 1, idleMin: 20 }],
    homes: {},
    home: () => "auto",
    watching: (p, on) => calls.watching.push([p, on]),
    markOff: (p) => calls.markOff.push(p),
    ...extra,
  };
}
/** Raw upgrade request on a socket; resolves with the socket and the first chunk it gets back. */
function upgrade(port, path, extraHeaders = "") {
  return new Promise((resolve) => {
    const c = net.connect(port, "127.0.0.1", () =>
      c.write(`GET ${path} HTTP/1.1\r\nHost: relay\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: deck=1\r\n${extraHeaders}\r\n`)
    );
    c.on("error", () => {});
    c.unref();
    c.once("data", (b) => resolve({ c, first: b.toString("latin1") }));
    c.once("close", () => resolve({ c, first: "" }));
  });
}

test("agent mode: list shows each agent's desktop and the hosts, never a port or a token", () => {
  const desktops = { list: () => [{ profile: "aurora", host: "a1b2c3d4", state: "ready", since: 1 }], hosts: () => [{ id: "a1b2c3d4", name: "pc", ready: true, limit: 3, running: 1 }], homes: { aurora: "a1b2c3d4" }, home: (p) => (p === "aurora" ? "a1b2c3d4" : "auto") };
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops, agentName: (p) => ({ aurora: "Aurora" })[p] || p });
  const l = s.list();
  assert.equal(l.mode, "agent");
  const a = l.spaces.find((x) => x.id === "aurora");
  assert.deepEqual([a.kind, a.host, a.state, a.holderName], ["agent", "a1b2c3d4", "ready", "Aurora"]);
  assert.deepEqual(l.homes, { aurora: "a1b2c3d4" });
  assert.doesNotMatch(JSON.stringify(l), /token|port/i);
});

test("full control on one agent's desktop pauses only that agent", async () => {
  const desktops = { list: () => [], hosts: () => [], homes: {}, home: () => "auto" };
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops, profiles: () => ["aurora", "pioneer"] }); // fix1-11: known agents only
  await s._control({ space: "aurora", level: "full" });
  assert.equal(s.gate("aurora", "space:aurora@a1b2c3d4").error, "The user is controlling your desktop.");
  assert.deepEqual(s.gate("pioneer", "space:pioneer@a1b2c3d4"), { ok: true });
  await s._control({ space: "aurora", level: "release" });
  assert.deepEqual(s.gate("aurora", "space:aurora@a1b2c3d4"), { ok: true });
});

test("POST /spaces/home validates through Desktops; /spaces/mode accepts agent only with desktops", async () => {
  const calls = [];
  const desktops = { list: () => [], hosts: () => [], homes: {}, home: () => "auto", setHome: (p, h) => (calls.push([p, h]), { ok: true }) };
  const s = new Spaces({ mode: "shared", lock: new SpaceLock(), desktops });
  assert.deepEqual(await s._home({ profile: "aurora", host: "a1b2c3d4" }), { ok: true });
  assert.deepEqual(calls, [["aurora", "a1b2c3d4"]]);
  assert.deepEqual(await s._mode({ mode: "agent" }), { ok: true, mode: "agent" });
  assert.deepEqual(await new Spaces({ mode: "shared", lock: new SpaceLock() })._mode({ mode: "agent" }), { ok: false, error: "no desktop host" });
});

test("the per-desktop view proxy refuses an unknown desktop and a path outside the allow list", async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push([req.url, req.headers.authorization]);
    res.end("ok");
  });
  const upPort = await listen(upstream);
  const local = { list: async () => [{ profile: "aurora", running: true, port: upPort }], tokenOf: (p) => (p === "aurora" ? "box-token" : null) };
  const desktops = fakeDesktops([{ profile: "aurora", host: "agent-host", state: "ready", since: 1 }]);
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops, local });
  const f = await front(s);
  assert.equal((await fetch(`${f.base}/spaces/ghost/view/viewer/`)).status, 404);
  assert.equal((await fetch(`${f.base}/spaces/aurora/view/mcp`)).status, 403);
  const ok = await fetch(`${f.base}/spaces/aurora/view/viewer/`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "ok");
  assert.deepEqual(seen, [["/viewer/", "Bearer box-token"]], "the upstream saw only the allowed request, with the container token added by the relay");
  upstream.close();
  f.srv.close();
});

test("per-desktop view: input paths follow that desktop's own level, not the shared one's", async () => {
  const upstream = http.createServer((req, res) => res.end("ok"));
  const upPort = await listen(upstream);
  const local = { list: async () => [{ profile: "aurora", running: true, port: upPort }], tokenOf: () => "box-token" };
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops: fakeDesktops([{ profile: "aurora", host: "agent-host", state: "ready" }]), local });
  const f = await front(s);
  const st = async (id) => (await fetch(`${f.base}/spaces/${id}/view/cua.env.v1.ComputerService/Click`, { method: "POST" })).status;
  assert.equal(await st("aurora"), 403, "watch: no input");
  await s._control({ level: "together" }); // the shared desktop's level
  assert.equal(await st("aurora"), 403, "the shared desktop's level does not open input on aurora");
  await s._control({ space: "aurora", level: "together" });
  assert.equal(await st("aurora"), 200);
  assert.equal(s.list().spaces.find((x) => x.id === "aurora").level, "together");
  upstream.close();
  f.srv.close();
});

test("per-desktop view on a Deck host goes through the tunnel with allowlisted headers only (no cookie, no credentials)", async () => {
  const sent = [];
  // 11b: viewer HTTP streams (tunnel.stream); MCP and health keep the buffered tunnel.http
  const tunnel = { stream: async (dev, req) => (sent.push([dev, req]), { status: 200, headers: { "content-type": "text/html", "x-up": "1" }, body: Readable.from([Buffer.from("hi")]) }) };
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops: fakeDesktops([{ profile: "pioneer", host: "a1b2c3d4", state: "ready" }]), tunnel });
  const f = await front(s);
  const r = await fetch(`${f.base}/spaces/pioneer/view/viewer/index.html?x=1`, {
    headers: { cookie: "deck=1", authorization: "Bearer relay", "x-cua-env-authorization": "Bearer ticket", "x-custom-auth": "s3cret", accept: "text/html" },
  });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "hi");
  assert.equal(sent.length, 1);
  const [dev, req] = sent[0];
  assert.equal(dev, "a1b2c3d4");
  assert.deepEqual([req.profile, req.method, req.path], ["pioneer", "GET", "/viewer/index.html?x=1"]);
  assert.equal(req.headers.accept, "text/html");
  for (const h of ["cookie", "authorization", "x-cua-env-authorization", "x-custom-auth", "host", "connection"]) assert.equal(req.headers[h], undefined, h);
  f.srv.close();
});

test("per-desktop view: a Deck answering 'not running' marks that desktop off (502 to the viewer)", async () => {
  const tunnel = { stream: async () => { throw Object.assign(new Error("that agent's desktop is not running"), { status: 502 }); } };
  const desktops = fakeDesktops([{ profile: "pioneer", host: "a1b2c3d4", state: "ready" }]);
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops, tunnel });
  const f = await front(s);
  const r = await fetch(`${f.base}/spaces/pioneer/view/viewer/`);
  assert.equal(r.status, 502);
  assert.deepEqual(desktops.calls.markOff, ["pioneer"]);
  f.srv.close();
});

test("per-desktop view socket on a Deck host: counts as watching while open, stops when the Deck goes mid-view", async () => {
  const opened = [];
  let sock = null;
  const tunnel = {
    openWs(dev, o) {
      sock = new EventEmitter();
      sock.got = [];
      sock.send = (b) => sock.got.push(Buffer.from(b));
      sock.close = () => sock.emit("close", "closed by the relay");
      opened.push([dev, o]);
      setImmediate(() => sock.emit("data", Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")));
      return sock;
    },
  };
  const desktops = fakeDesktops([{ profile: "pioneer", host: "a1b2c3d4", state: "ready" }]);
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops, tunnel });
  const f = await front(s);
  const { c, first } = await upgrade(f.port, "/spaces/pioneer/view/media?x=1", "Authorization: Bearer relay\r\nX-Custom-Auth: s3cret\r\n");
  assert.match(first, /^HTTP\/1\.1 101/);
  assert.equal(opened.length, 1);
  const [dev, o] = opened[0];
  assert.deepEqual([dev, o.profile, o.path], ["a1b2c3d4", "pioneer", "/media?x=1"]);
  assert.equal(o.headers.upgrade, "websocket");
  assert.equal(o.headers["sec-websocket-key"], "dGhlIHNhbXBsZSBub25jZQ==");
  for (const h of ["cookie", "authorization", "x-custom-auth", "host"]) assert.equal(o.headers[h], undefined, h);
  assert.deepEqual(desktops.calls.watching, [["pioneer", true]]);
  const closed = new Promise((r) => c.once("close", r));
  sock.emit("close", "the Deck's connection is gone"); // tunnel.removeDeck
  await closed;
  for (let i = 0; i < 100 && desktops.calls.watching.length < 2; i++) await new Promise((r) => setTimeout(r, 10)); // the relay side's close event
  assert.deepEqual(desktops.calls.watching, [["pioneer", true], ["pioneer", false]]);
  f.srv.close();
});

test("per-desktop view socket on the agent host: container token added, cookie and origin dropped, watching ends on close", async () => {
  const lines = [];
  const upstream = net.createServer((s) => {
    s.once("data", (b) => {
      lines.push(...b.toString("latin1").split("\r\n"));
      s.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
    s.on("error", () => {});
  });
  const upPort = await listen(upstream);
  const local = { list: async () => [{ profile: "aurora", running: true, port: upPort }], tokenOf: () => "box-token" };
  const desktops = fakeDesktops([{ profile: "aurora", host: "agent-host", state: "ready" }]);
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops, local });
  const f = await front(s);
  const { c, first } = await upgrade(f.port, "/spaces/aurora/view/media", "Origin: http://deck\r\n");
  assert.match(first, /^HTTP\/1\.1 101/);
  assert.equal(lines[0], "GET /media HTTP/1.1");
  assert.ok(lines.includes("Authorization: Bearer box-token"));
  assert.ok(!lines.some((l) => /^(cookie|origin):/i.test(l)), "no cookie, no origin");
  assert.deepEqual(desktops.calls.watching, [["aurora", true]]);
  c.destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(desktops.calls.watching, [["aurora", true], ["aurora", false]]);
  const refused = await upgrade(f.port, "/spaces/ghost/view/media");
  assert.match(refused.first, /^HTTP\/1\.1 404/);
  upstream.close();
  f.srv.close();
});

test("full control on an agent's desktop ends by itself 30 s after its last view socket closed", async () => {
  const c = { t: 0 };
  const desktops = fakeDesktops([{ profile: "aurora", host: "agent-host", state: "ready" }]);
  const s = new Spaces({ mode: "agent", lock: new SpaceLock({ now: () => c.t }), desktops, now: () => c.t });
  await s._control({ space: "aurora", level: "full" });
  const v = s._viewerOpened("aurora");
  s._viewerClosed("aurora", v);
  c.t = 29_000;
  s.polled();
  s.sweep();
  assert.equal(s.list().spaces.find((x) => x.id === "aurora").user, true);
  c.t = 31_000;
  s.polled();
  s.sweep();
  const a = s.list().spaces.find((x) => x.id === "aurora");
  assert.deepEqual([a.user, a.level], [false, "watch"]);
  assert.deepEqual(s.gate("aurora", "space:aurora@agent-host"), { ok: true });
});

test("POST /spaces/desktop starts and stops one agent's desktop through Desktops; bad input is refused", async () => {
  const calls = [];
  const desktops = fakeDesktops([], {
    start: async (p) => (calls.push(["start", p]), { kind: "space", host: "agent-host" }),
    stop: async (p) => void calls.push(["stop", p]),
    state: () => "off",
  });
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops, profiles: () => ["aurora"] });
  assert.equal((await s._desktop({ profile: "aurora", action: "start" })).ok, true);
  assert.equal((await s._desktop({ profile: "aurora", action: "stop" })).ok, true);
  assert.deepEqual(calls, [["start", "aurora"], ["stop", "aurora"]]);
  assert.deepEqual(await s._desktop({ profile: "../x", action: "start" }), { ok: false, error: "bad profile" });
  assert.deepEqual(await s._desktop({ profile: "aurora", action: "explode" }), { ok: false, error: "bad action" });
  const full = fakeDesktops([], { start: async () => ({ kind: "fallback", reason: "limit" }), state: () => "off" });
  assert.deepEqual(await new Spaces({ mode: "agent", lock: new SpaceLock(), desktops: full, profiles: () => ["aurora"] })._desktop({ profile: "aurora", action: "start" }), { ok: false, error: "limit" });
  assert.deepEqual(await new Spaces({ mode: "agent", lock: new SpaceLock() })._desktop({ profile: "aurora", action: "start" }), { ok: false, error: "no desktop host" });
});

test("agent mode list: one entry per configured agent (off until started), hosts reduced to what a Deck shows", () => {
  const desktops = fakeDesktops([{ profile: "aurora", host: "a1b2c3d4", state: "ready" }], { fallbackOf: (p) => (p === "pioneer" ? "limit" : null) });
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops, profiles: () => ["aurora", "pioneer"] });
  const l = s.list();
  assert.deepEqual(l.spaces.map((x) => x.id), ["host", "aurora", "pioneer"]);
  const p = l.spaces.find((x) => x.id === "pioneer");
  assert.deepEqual([p.state, p.host, p.online, p.fallback], ["off", null, false, "limit"]);
  const a = l.spaces.find((x) => x.id === "aurora");
  assert.deepEqual([a.hostName, a.online], ["pc", true]);
  assert.deepEqual(l.hosts, [{ id: "agent-host", name: "mac", ready: true, limit: 1, running: 1 }, { id: "a1b2c3d4", name: "pc", ready: true, limit: 3, running: 1 }]);
  assert.deepEqual(new Spaces({ mode: "shared", lock: new SpaceLock(), desktops, profiles: () => ["aurora"] }).list().spaces.map((x) => x.id), ["host"], "shared mode: no agent pills");
});

// ---- spaceFetch (the driver's MCP path) and the health wait --------------------------------------------------

test("pickHeaders keeps only allowlisted headers", () => {
  const h = pickHeaders({ "content-type": "application/json", accept: "x", "mcp-session-id": "s", cookie: "c", authorization: "a", "proxy-authorization": "p", "x-cua-env-authorization": "t", "x-api-key": "k", "mcp-protocol-version": "v", "last-event-id": "e" }, "mcp");
  assert.deepEqual(h, { "content-type": "application/json", accept: "x", "mcp-session-id": "s", "mcp-protocol-version": "v", "last-event-id": "e" });
});

test("spaceFetch to a Deck host: POST /mcp only, allowlisted headers, never an SSE GET", async () => {
  const sent = [];
  const tunnel = { http: async (dev, req) => (sent.push([dev, req]), { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}") }) };
  const desktops = { markOff() {}, resolve: async () => ({ kind: "space", host: "a1b2c3d4" }) };
  const fetchFor = makeSpaceFetch({ desktops, tunnel });
  const f = fetchFor("a1b2c3d4", "pioneer");
  const r = await f({ method: "POST", path: "/mcp", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "abc", cookie: "c", authorization: "Bearer x", "x-cua-env-authorization": "t" }, body: Buffer.from("{}") });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0][0], sent[0][1].profile, sent[0][1].method, sent[0][1].path], ["a1b2c3d4", "pioneer", "POST", "/mcp"]);
  assert.deepEqual(sent[0][1].headers, { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "abc" });
  await assert.rejects(f({ method: "GET", path: "/mcp", headers: { accept: "text/event-stream" } }), /POST \/mcp/);
  await assert.rejects(f({ method: "POST", path: "/files/x", headers: {} }), /POST \/mcp/);
  assert.equal(sent.length, 1, "nothing else reached the tunnel");
});

test("spaceFetch: a 'not running' answer marks the desktop off and resolves once more, then retries once on the new place (no loop)", async () => {
  const calls = [];
  let fails = 1;
  const tunnel = {
    http: async (dev) => {
      calls.push(["http", dev]);
      if (fails-- > 0) throw Object.assign(new Error("that agent's desktop is not running"), { status: 502 });
      return { status: 200, headers: {}, body: Buffer.from("{}") };
    },
  };
  const desktops = { markOff: (p) => calls.push(["off", p]), resolve: async (p) => (calls.push(["resolve", p]), { kind: "space", host: "b2c3d4e5" }) };
  const f = makeSpaceFetch({ desktops, tunnel })("a1b2c3d4", "pioneer");
  assert.equal((await f({ method: "POST", path: "/mcp", headers: {}, body: Buffer.from("{}") })).status, 200);
  assert.deepEqual(calls, [["http", "a1b2c3d4"], ["off", "pioneer"], ["resolve", "pioneer"], ["http", "b2c3d4e5"]]);
  // always not running: one mark-off, one resolve, one retry, then the error
  calls.length = 0;
  fails = 99;
  await assert.rejects(f({ method: "POST", path: "/mcp", headers: {}, body: Buffer.from("{}") }), /not running/);
  assert.deepEqual(calls.map((c) => c[0]), ["http", "off", "resolve", "http"]);
  // the new resolve falls back: the error stands, no retry
  calls.length = 0;
  fails = 99;
  const fb = makeSpaceFetch({ desktops: { markOff: (p) => calls.push(["off", p]), resolve: async () => (calls.push(["resolve"]), { kind: "fallback", reason: "offline" }) }, tunnel })("a1b2c3d4", "pioneer");
  await assert.rejects(fb({ method: "POST", path: "/mcp", headers: {}, body: Buffer.from("{}") }), /not running/);
  assert.deepEqual(calls.map((c) => c[0]), ["http", "off", "resolve"]);
});

test("spaceFetch on the agent host: loopback with the container token; a refused connection counts as not running", async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      seen.push([req.method, req.url, req.headers.authorization, req.headers.cookie, req.headers["content-type"], b]);
      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", "s1");
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
  });
  const upPort = await listen(upstream);
  const local = { tokenOf: () => "box-token", list: async () => [] };
  const offs = [];
  const desktops = { portOf: () => upPort, markOff: (p) => offs.push(p), resolve: async () => ({ kind: "fallback", reason: "offline" }) };
  const f = makeSpaceFetch({ desktops, local })("agent-host", "aurora");
  const r = await f({ method: "POST", path: "/mcp", headers: { "content-type": "application/json", cookie: "c" }, body: Buffer.from('{"id":1}') });
  assert.equal(r.status, 200);
  assert.equal(r.headers["mcp-session-id"], "s1");
  assert.equal(r.body.toString(), '{"jsonrpc":"2.0","id":1,"result":{}}');
  assert.deepEqual(seen, [["POST", "/mcp", "Bearer box-token", undefined, "application/json", '{"id":1}']]);
  await new Promise((r) => upstream.close(r));
  await assert.rejects(f({ method: "POST", path: "/mcp", headers: {}, body: Buffer.from("{}") }), /not running/);
  assert.deepEqual(offs, ["aurora"]);
});

test("ready: polls /health every interval until it answers, else gives up at the deadline", async () => {
  let n = 0;
  const upstream = http.createServer((req, res) => {
    n += 1;
    res.statusCode = req.url === "/health" && n >= 3 ? 204 : 503;
    res.end();
  });
  const upPort = await listen(upstream);
  const ready = makeReady({ intervalMs: 10, timeoutMs: 2000 });
  await ready("agent-host", "aurora", upPort);
  assert.equal(n, 3);
  const viaTunnel = [];
  const tunnelReady = makeReady({ tunnel: { http: async (dev, req) => (viaTunnel.push([dev, req.profile, req.path]), { status: 204, headers: {}, body: Buffer.alloc(0) }) }, intervalMs: 10, timeoutMs: 2000 });
  await tunnelReady("a1b2c3d4", "pioneer", null);
  assert.deepEqual(viaTunnel, [["a1b2c3d4", "pioneer", "/health"]]);
  const never = makeReady({ intervalMs: 10, timeoutMs: 100 });
  await new Promise((r) => upstream.close(r));
  await assert.rejects(never("agent-host", "aurora", upPort), /did not answer/);
});

// ---- relay wiring (index.js): device frames, config, start ------------------------------------------------------

test("deckHooks: with spaces on, the deck socket takes large frames, [0xD6] frames go to the space tunnel, its close drops the Deck", () => {
  const { deckHooks } = require("../src/index");
  const { encode, OP } = require("../src/space-tunnel");
  const presence = { connect() {}, disconnect() {}, state: () => ({}), heartbeat() {} };
  const spaces = { onHttp: () => false, onUpgrade: () => false };
  assert.equal(deckHooks(presence, null, null, null, null, null).maxPayload, undefined, "nothing large without a feature");
  assert.equal(deckHooks(presence, null, null, null, null, spaces).maxPayload, 64 * 1024 * 1024, "a [0xD6] answer over 64 KB must not close the Deck's connection (1009)");
  const got = [];
  const tunnel = { onFrame: (ws, d) => (got.push(["tunnel", d[0]]), d[0] === 0xd6), removeDeck: (ws) => got.push(["removeDeck", ws.id]) };
  const driver = { onFrame: (ws, d) => (got.push(["driver", d[0]]), d[0] === 0xd5), addDeck() {}, removeDeck() {} };
  const h = deckHooks(presence, null, driver, null, null, spaces, tunnel);
  assert.equal(h.maxPayload, 64 * 1024 * 1024);
  const ws = { id: "w1", send() {} };
  assert.equal(h.onMessage(ws, encode(OP.HTTP_RES, 7, { status: 200 }), true), true);
  assert.equal(h.onMessage(ws, Buffer.from([0xd5, 1, 0, 0, 0, 1]), true), true);
  h.onClose(ws);
  assert.deepEqual(got, [["tunnel", 0xd6], ["tunnel", 0xd5], ["driver", 0xd5], ["removeDeck", "w1"]]);
});

test("config: phase 2 settings from the environment; the agent host hosts nothing unless asked, and nothing below 16 GB unless a limit is set", () => {
  const { config } = require("../src/index");
  const GB = 1024 ** 3;
  const off = config({ DECK_SPACES: "agent" }, 64 * GB).desktops;
  assert.deepEqual([off.host, off.idleMin, off.sharedFallback], [false, 20, true]);
  const big = config({ DECK_SPACES: "agent", DECK_DESKTOPS_HOST: "1" }, 64 * GB).desktops;
  assert.deepEqual([big.host, big.limit, big.lowMem], [true, 1, false]);
  const small = config({ DECK_SPACES: "agent", DECK_DESKTOPS_HOST: "1" }, 8 * GB).desktops;
  assert.deepEqual([small.limit, small.lowMem], [0, true]);
  const set = config({ DECK_SPACES: "agent", DECK_DESKTOPS_HOST: "1", DECK_DESKTOPS_LIMIT: "2", DECK_DESKTOPS_IDLE_MIN: "45", DECK_SPACES_SHARED_FALLBACK: "0" }, 8 * GB).desktops;
  assert.deepEqual([set.limit, set.lowMem, set.idleMin, set.sharedFallback], [2, false, 45, false]);
  const clamped = config({ DECK_SPACES: "agent", DECK_DESKTOPS_LIMIT: "99", DECK_DESKTOPS_IDLE_MIN: "1" }, 64 * GB).desktops;
  assert.deepEqual([clamped.limit, clamped.idleMin], [16, 5]);
  assert.equal(config({}, 64 * GB).spaces, null);
});

function relayCfg(extra = {}) {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp8-"));
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify({ profiles: { aurora: { name: "Aurora" }, pioneer: { name: "Pioneer" } } }));
  return {
    host: "127.0.0.1", port: 0, token: "r".repeat(32), eventsDir: path.join(dir, "events"), stateDir: path.join(dir, "state"), dataDir: path.join(dir, "data"),
    agentsFile, claudeDirs: [], claudeProfile: null, codexbar: null, launchdPrefixes: [], history: false, tickMs: 1000, broadcastWindowS: 300, cdp: { port: null },
    spaces: { mode: "agent", url: "http://127.0.0.1:9", tokenFile: path.join(dir, "none") },
    ...extra,
  };
}
const getSpaces = async (relay) => (await fetch(`http://127.0.0.1:${relay.port}/spaces`, { headers: { authorization: `Bearer ${"r".repeat(32)}` } })).json();

test("start: agent mode with DECK_DESKTOPS_HOST unset serves every agent (off), no agent-host desktop host, and stops cleanly", async () => {
  const { start } = require("../src/index");
  const relay = await start(relayCfg());
  try {
    const l = await getSpaces(relay);
    assert.equal(l.mode, "agent");
    assert.deepEqual(l.spaces.map((x) => [x.id, x.kind, x.state || null]), [["host", "shared", null], ["aurora", "agent", "off"], ["pioneer", "agent", "off"]]);
    assert.deepEqual(l.hosts, []);
    assert.ok(relay.desktops, "the desktop registry exists (Deck computers may host)");
  } finally {
    await relay.stop();
  }
});

test("start: shared mode (phase 1) is unchanged by phase 2's wiring: no agent entries", async () => {
  const { start } = require("../src/index");
  const relay = await start(relayCfg({ spaces: { ...relayCfg().spaces, mode: "shared" } }));
  try {
    const l = await getSpaces(relay);
    assert.deepEqual([l.mode, l.spaces.length, l.spaces[0].id], ["shared", 1, "host"]);
  } finally {
    await relay.stop();
  }
});

test("start: with DECK_DESKTOPS_HOST=1 the agent host's running desktops are adopted at start (a fake docker), never with a port in the API", async () => {
  const { start } = require("../src/index");
  const argv = [];
  const runner = async (a) => {
    argv.push(a.join(" "));
    if (a[0] === "version") return { code: 0, stdout: "27.0.0\n", stderr: "" };
    if (a[0] === "image") return { code: 0, stdout: "sha256:x\n", stderr: "" };
    if (a[0] === "ps") return { code: 0, stdout: "hermes-deck-space-aurora\tUp 3 minutes\t127.0.0.1:41234->3211/tcp\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "not in this test" };
  };
  const cfg = relayCfg();
  const relay = await start({ ...cfg, desktops: { host: true, limit: 1, idleMin: 20, sharedFallback: true, lowMem: false, runner } });
  try {
    const l = await getSpaces(relay);
    const a = l.spaces.find((x) => x.id === "aurora");
    assert.deepEqual([a.state, a.host], ["ready", "agent-host"]);
    assert.deepEqual(l.hosts.map((h) => [h.id, h.limit, h.running]), [["agent-host", 1, 1]]);
    assert.doesNotMatch(JSON.stringify(l), /41234|token|port/i);
    assert.ok(argv.some((x) => x.startsWith("ps ")), "docker ps ran once at start (adopt)");
    assert.equal(argv.filter((x) => x.startsWith("run ") || x.startsWith("start ") || x.startsWith("pull ")).length, 0, "nothing started or pulled");
  } finally {
    await relay.stop();
  }
});

// ---- Task 8 fix round 1 ----------------------------------------------------------------------------------------

const SMUGGLE = "media/%20HTTP/1.1%0d%0aHost:%20x%0d%0a%0d%0aPOST%20/mcp%20HTTP/1.1%0d%0aX-Pad:%20";

test("fix1-1: a view path with CR/LF or a space after decoding is refused (HTTP 403), nothing reaches the desktop", async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => (seen.push(req.url), res.end("ok")));
  const upPort = await listen(upstream);
  const local = { list: async () => [{ profile: "aurora", running: true, port: upPort }], tokenOf: () => "box-token" };
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops: fakeDesktops([{ profile: "aurora", host: "agent-host", state: "ready" }]), local });
  const f = await front(s);
  for (const p of [SMUGGLE, "viewer/a%20b", "viewer/%0aX", "viewer/%C3%A9"]) {
    assert.equal((await fetch(`${f.base}/spaces/aurora/view/${p}`)).status, 403, p);
  }
  assert.deepEqual(seen, []);
  assert.equal(viewPath(`/spaces/aurora/view/${SMUGGLE}`, true).rest, "");
  assert.equal(viewPath("/spaces/host/view/media%0d%0aX:%20y", true).rest, "");
  upstream.close();
  f.srv.close();
});

test("fix1-1: the WebSocket upgrade with a smuggling path is refused, on an agent desktop and on the shared one; the upstream sees no request", { timeout: 5000 }, async () => {
  const got = [];
  const upstream = net.createServer((sock) => {
    sock.on("data", (b) => got.push(b.toString("latin1")));
    sock.on("error", () => {});
  });
  const upPort = await listen(upstream);
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sp-")), "token");
  fs.writeFileSync(tokenFile, "env-token\n");
  const local = { list: async () => [{ profile: "aurora", running: true, port: upPort }], tokenOf: () => "box-token" };
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops: fakeDesktops([{ profile: "aurora", host: "agent-host", state: "ready" }]), local, spacesd: { url: `http://127.0.0.1:${upPort}`, tokenFile } });
  const f = await front(s);
  for (const id of ["aurora", "host"]) {
    const r = await upgrade(f.port, `/spaces/${id}/view/${SMUGGLE}`);
    assert.match(r.first, /^HTTP\/1\.1 (403|400)/, id);
    r.c.destroy();
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got, [], "no request line, no token, no smuggled POST /mcp");
  upstream.close();
  f.srv.close();
});

test("fix1-1: the raw upgrade request writer refuses any path outside printable ASCII (defence in depth)", () => {
  assert.equal(upgradeRequest({ path: "/media\r\nPOST /mcp", host: "127.0.0.1:1", token: "t", headers: {} }), null);
  assert.equal(upgradeRequest({ path: "/media x", host: "127.0.0.1:1", token: "t", headers: {} }), null);
  const ok = upgradeRequest({ path: "/media?x=1", host: "127.0.0.1:1", token: "t", headers: { "sec-websocket-version": "13" } });
  assert.match(ok, /^GET \/media\?x=1 HTTP\/1\.1\r\nHost: 127\.0\.0\.1:1\r\nAuthorization: Bearer t\r\n/);
  assert.match(ok, /sec-websocket-version: 13\r\n\r\n$/);
});

test("fix1-3: a reset connection is an error, not 'not running' (the desktop is not marked off)", async () => {
  const upstream = net.createServer((sock) => {
    sock.on("error", () => {});
    sock.once("data", () => sock.resetAndDestroy());
  });
  const upPort = await listen(upstream);
  const offs = [];
  const desktops = { portOf: () => upPort, markOff: (p) => offs.push(p), resolve: async () => ({ kind: "fallback", reason: "offline" }) };
  const f = makeSpaceFetch({ desktops, local: { tokenOf: () => "t", list: async () => [] } })("agent-host", "aurora");
  await assert.rejects(f({ method: "POST", path: "/mcp", headers: {}, body: Buffer.from("{}") }), (e) => !/not running/.test(e.message));
  assert.deepEqual(offs, []);
  upstream.close();
});

test("fix1-4: not running with an MCP session: mark off, start the resolve without waiting, rethrow (no retry against a new container)", { timeout: 5000 }, async () => {
  const calls = [];
  const tunnel = { http: async (dev) => (calls.push(["http", dev]), Promise.reject(Object.assign(new Error("that agent's desktop is not running"), { status: 502 }))) };
  let resolved = null;
  const desktops = { markOff: (p) => calls.push(["off", p]), resolve: (p) => (calls.push(["resolve", p]), new Promise((r) => (resolved = r))) };
  const f = makeSpaceFetch({ desktops, tunnel })("a1b2c3d4", "pioneer");
  await assert.rejects(f({ method: "POST", path: "/mcp", headers: { "mcp-session-id": "s1" }, body: Buffer.from("{}") }), /not running/);
  assert.deepEqual(calls, [["http", "a1b2c3d4"], ["off", "pioneer"], ["resolve", "pioneer"]], "resolve started, not awaited, no retry");
  resolved({ kind: "space", host: "b2c3d4e5" });
});

test("fix1-5: in shared mode (phase 1 strictly) no per-desktop start, control or viewer", async () => {
  const upstream = http.createServer((req, res) => res.end("ok"));
  const upPort = await listen(upstream);
  const local = { list: async () => [{ profile: "aurora", running: true, port: upPort }], tokenOf: () => "t" };
  const started = [];
  const desktops = fakeDesktops([{ profile: "aurora", host: "agent-host", state: "ready" }], { start: async (p) => (started.push(p), { kind: "space", host: "agent-host" }), stop: async () => {}, state: () => "off" });
  const s = new Spaces({ mode: "shared", lock: new SpaceLock(), desktops, local, profiles: () => ["aurora"] });
  assert.deepEqual(await s._desktop({ profile: "aurora", action: "start" }), { ok: false, error: "not in agent mode" });
  assert.deepEqual(started, []);
  assert.deepEqual(await s._control({ space: "aurora", level: "full" }), { ok: false, error: "not in agent mode" });
  const f = await front(s);
  assert.equal((await fetch(`${f.base}/spaces/aurora/view/viewer/`)).status, 404);
  const r = await upgrade(f.port, "/spaces/aurora/view/media");
  assert.match(r.first, /^HTTP\/1\.1 404/);
  r.c.destroy();
  upstream.close();
  f.srv.close();
});

test("fix1-6: a profile named host is never an agent desktop", async () => {
  const desktops = fakeDesktops([{ profile: "host", host: "agent-host", state: "ready" }], { homes: { host: "agent-host" }, start: async () => ({ kind: "space", host: "agent-host" }), state: () => "off" });
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops, profiles: () => ["host", "aurora"] });
  assert.deepEqual(s.list().spaces.map((x) => [x.id, x.kind]), [["host", "shared"], ["aurora", "agent"]]);
  assert.deepEqual(await s._desktop({ profile: "host", action: "start" }), { ok: false, error: "bad profile" });
  assert.equal((await s._control({ space: "aurora", level: "watch" })).ok, true);
  assert.deepEqual(s.gate("host", "space:host@agent-host"), { ok: true });
});

test("fix1-6: the relay warns at start when a configured profile is named host", async () => {
  const fs = require("node:fs");
  const { start } = require("../src/index");
  const cfg = relayCfg();
  fs.writeFileSync(cfg.agentsFile, JSON.stringify({ profiles: { host: { name: "Host" }, aurora: { name: "Aurora" } } }));
  const warn = console.warn;
  const said = [];
  console.warn = (...a) => said.push(a.join(" "));
  let relay;
  try {
    relay = await start(cfg);
  } finally {
    console.warn = warn;
  }
  try {
    assert.ok(said.some((x) => /profile named "host"/.test(x)), said.join("\n"));
    assert.deepEqual((await getSpaces(relay)).spaces.map((x) => x.id), ["host", "aurora"]);
  } finally {
    await relay.stop();
  }
});

test("fix1-7: a refused view socket is destroyed, so a half-open client cannot keep the desktop watched", async () => {
  const local = { list: async () => [], tokenOf: () => null }; // not running
  const desktops = fakeDesktops([{ profile: "aurora", host: "agent-host", state: "ready" }]);
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops, local });
  const f = await front(s);
  const c = net.connect({ port: f.port, host: "127.0.0.1", allowHalfOpen: true });
  c.on("error", () => {});
  c.unref();
  await new Promise((r) => c.once("connect", r));
  c.write("GET /spaces/aurora/view/media HTTP/1.1\r\nHost: relay\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
  const first = await new Promise((r) => c.once("data", (b) => r(b.toString("latin1"))));
  assert.match(first, /^HTTP\/1\.1 502/);
  for (let i = 0; i < 100 && desktops.calls.watching.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(desktops.calls.watching.at(-1), ["aurora", false], "the client never closed its side; the relay's did");
  c.destroy();
  f.srv.close();
});

test("fix1-8: ready gives up when a Deck never answers /health (each attempt bounded by the time left)", { timeout: 5000 }, async () => {
  const ready = makeReady({ tunnel: { http: () => new Promise(() => {}) }, intervalMs: 10, timeoutMs: 200 });
  const t0 = Date.now();
  await assert.rejects(ready("a1b2c3d4", "pioneer", null), /did not answer/);
  assert.ok(Date.now() - t0 < 1500, `gave up after ${Date.now() - t0} ms`);
});

test("fix1-11: control is only for agents the relay knows (configured, in the registry, or with a home)", async () => {
  const desktops = fakeDesktops([{ profile: "aurora", host: "agent-host", state: "ready" }], { homes: { scout: "agent-host" } });
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops, profiles: () => ["pioneer"] });
  for (const p of ["aurora", "pioneer", "scout"]) assert.equal((await s._control({ space: p, level: "together" })).ok, true, p);
  assert.deepEqual(await s._control({ space: "stranger1", level: "full" }), { ok: false, error: "unknown agent" });
  assert.equal(s.ctl.has("stranger1"), false, "no entry made");
});

// ---- Task 9: a Deck viewing an agent desktop on its own loopback still counts as watching (ruling 3) ----------

test("GET /spaces?watching=<id> marks that agent desktop watched for a short while; it ends when the polls stop", () => {
  const c = { t: 0 };
  const desktops = fakeDesktops([{ profile: "aurora", host: "a1b2c3d4", state: "ready" }]);
  const s = new Spaces({ mode: "agent", lock: new SpaceLock({ now: () => c.t }), desktops, profiles: () => ["aurora"], now: () => c.t });
  s.polled("aurora");
  assert.deepEqual(desktops.calls.watching, [["aurora", true]], "watched from the first poll");
  c.t = 3_000;
  s.polled("aurora");
  c.t = 14_000;
  s.sweep();
  assert.deepEqual(desktops.calls.watching.at(-1), ["aurora", true], "polled 11 s ago: still watched");
  c.t = 19_000;
  s.sweep();
  assert.deepEqual(desktops.calls.watching.at(-1), ["aurora", false], "no poll for 16 s: no longer watched");
});

test("GET /spaces?watching= is ignored for the shared space, unknown or bad ids, and outside agent mode", () => {
  const desktops = fakeDesktops([{ profile: "aurora", host: "a1b2c3d4", state: "ready" }]);
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops, profiles: () => ["aurora"] });
  for (const id of ["host", "nobody", "../x", "", null, "a b"]) s.polled(id);
  assert.deepEqual(desktops.calls.watching, []);
  assert.equal(s.ctl.size, 0, "no control entry for an unknown id");
  const shared = new Spaces({ mode: "shared", lock: new SpaceLock(), desktops, profiles: () => ["aurora"] });
  shared.polled("aurora");
  assert.deepEqual(desktops.calls.watching, [], "shared mode is phase 1, strictly");
  assert.ok(shared.lastPoll !== null, "still a sign of life");
});

test("the relay's GET /spaces reads ?watching=<id> (the Deck's panel while it shows a desktop on its own loopback)", async () => {
  const desktops = fakeDesktops([{ profile: "aurora", host: "a1b2c3d4", state: "ready" }]);
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops, profiles: () => ["aurora"] });
  const f = await front(s);
  try {
    const r = await fetch(`${f.base}/spaces?watching=aurora`);
    assert.equal(r.status, 200);
    assert.ok((await r.json()).spaces.some((x) => x.id === "aurora"));
    assert.deepEqual(desktops.calls.watching, [["aurora", true]]);
  } finally {
    f.srv.close();
  }
});

test("full control on an agent desktop watched only on the Deck's loopback lasts while it is shown; ends 30 s after it is not", async () => {
  const c = { t: 0 };
  const desktops = fakeDesktops([{ profile: "aurora", host: "a1b2c3d4", state: "ready" }]);
  const s = new Spaces({ mode: "agent", lock: new SpaceLock({ now: () => c.t }), desktops, profiles: () => ["aurora"], now: () => c.t });
  await s._control({ space: "aurora", level: "full" }); // no relay view socket: the Deck shows it from loopback
  const user = () => s.list().spaces.find((x) => x.id === "aurora").user;
  for (c.t = 0; c.t <= 60_000; c.t += 3_000) {
    s.polled("aurora");
    s.sweep();
  }
  assert.equal(user(), true, "a minute of polls with the desktop shown: still the user's");
  const last = c.t - 3_000; // the last poll that said it was shown; the panel keeps polling without it
  for (; c.t < last + 15_000 + 30_000; c.t += 3_000) {
    s.polled();
    s.sweep();
  }
  c.t = last + 15_000 + 29_000;
  s.polled();
  s.sweep();
  assert.equal(user(), true, "the watch expired 29 s ago");
  c.t = last + 15_000 + 30_000;
  s.polled();
  s.sweep();
  assert.equal(user(), false, "30 s after the watch expired, full control ends by itself");
});

// ---- Task 11b: viewer HTTP to a Deck-hosted desktop streams (Together's presence: PresenceService/Join) ------------
test("11b: Join through the relay to a Deck-hosted desktop streams: first bytes before the answer ends; the viewer leaving closes the desktop's request", { timeout: 10000 }, async () => {
  const { SpaceTunnel } = require("../src/space-tunnel");
  const { SpaceTunnelServer } = require("../../app/main/space-tunnel");
  const until = async (fn, ms = 3000) => {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > ms) return false;
      await new Promise((x) => setTimeout(x, 5));
    }
    return true;
  };
  const wait = (p, ms = 3000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out: the answer was buffered")), ms))]);
  let release;
  const gate = new Promise((r) => (release = r));
  const closes = [];
  const seen = [];
  const daemon = http.createServer((req, res) => {
    seen.push([req.url, req.headers.authorization]);
    res.on("close", () => closes.push(req.url));
    res.writeHead(200, { "content-type": "application/connect+json" });
    res.write("hello");
    if (req.url.includes("n=1")) gate.then(() => res.end("bye"));
  });
  const dport = await listen(daemon);
  const host = { list: async () => [{ profile: "pioneer", running: true, port: dport }], tokenOf: () => "container-token", ensure: async () => ({ port: null }), stop: async () => {} };
  let deck = null;
  const ws = { readyState: 1, send: (b) => deck.onFrame(b) };
  const tunnel = new SpaceTunnel({ presence: { connOf: (id) => (id === "a1b2c3d4" ? ws : null) } });
  deck = new SpaceTunnelServer({ host, allowed: () => true, send: (b) => tunnel.onFrame(ws, b) });
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops: fakeDesktops([{ profile: "pioneer", host: "a1b2c3d4", state: "ready" }]), tunnel });
  const f = await front(s);
  const join = (n, o = {}) => fetch(`${f.base}/spaces/pioneer/view/cua.env.v1.PresenceService/Join?n=${n}`, { method: "POST", headers: { "content-type": "application/connect+json", authorization: "Bearer relay" }, body: "{}", ...o });

  const r = await wait(join(1)); // buffered, the head would come only when the answer ends (never, here)
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/connect+json");
  const reader = r.body.getReader();
  const first = await wait(reader.read());
  assert.equal(Buffer.from(first.value).toString(), "hello", "the first bytes arrive while the desktop's answer is still open");
  release();
  let rest = "";
  for (;;) {
    const { value, done } = await wait(reader.read());
    if (done) break;
    rest += Buffer.from(value).toString();
  }
  assert.equal(rest, "bye");
  assert.deepEqual(seen[0], ["/cua.env.v1.PresenceService/Join?n=1", "Bearer container-token"], "the token is added on the Deck");

  const ac = new AbortController();
  const r2 = await join(2, { signal: ac.signal });
  const reader2 = r2.body.getReader();
  await wait(reader2.read());
  ac.abort();
  assert.ok(await until(() => closes.some((u) => u.includes("n=2"))), "the viewer went: the Deck dropped the desktop's request");
  assert.ok(await until(() => tunnel.streams.size === 0 && deck.streams.size === 0));
  daemon.close();
  f.srv.close();
});

// ---- final fix wave I1: a wedged Docker never hangs a waiter (the real runner with tiny bounds, a fake `docker`) ----

/**
 * The real dockerRunner over a fake `docker` whose processes ignore kill() and never close, except the argv that
 * answer(argv) answers ({code, stdout}). Bounds are tiny: each call that hangs is cut after 20 ms.
 */
function wedgedRunner(answer = () => null) {
  const { EventEmitter } = require("node:events");
  const { dockerRunner } = require("../../app/main/desktop-host");
  const spawnFn = (bin, argv) => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => {}; // ignored: never closes
    const a = answer(argv);
    if (a) setImmediate(() => { if (a.stdout) p.stdout.emit("data", a.stdout); p.emit("close", a.code); });
    return p;
  };
  return dockerRunner({ spawnFn, shortMs: 20, longMs: 20, helperMs: 20 });
}

test("I1 start: DECK_DESKTOPS_HOST=1 with a Docker that never answers: the relay still comes up, the agent host hosts nothing", { timeout: 5000 }, async () => {
  const { start } = require("../src/index");
  const t0 = Date.now();
  const relay = await start({ ...relayCfg(), desktops: { host: true, limit: 1, idleMin: 20, sharedFallback: true, lowMem: false, runner: wedgedRunner() } });
  try {
    assert.ok(Date.now() - t0 < 3000, `started in ${Date.now() - t0} ms`);
    const l = await getSpaces(relay);
    assert.deepEqual(l.hosts, [], "Docker did not answer: no agent-host desktops");
  } finally {
    await relay.stop();
  }
});

test("I1 start: Docker answers version and images but hangs on ps: adopt() gives up within the bound and the relay comes up", { timeout: 5000 }, async () => {
  const { start } = require("../src/index");
  const runner = wedgedRunner((a) => (a[0] === "version" ? { code: 0, stdout: "27.0.0\n" } : a[0] === "image" ? { code: 0, stdout: "sha256:x\n" } : null));
  const relay = await start({ ...relayCfg(), desktops: { host: true, limit: 1, idleMin: 20, sharedFallback: true, lowMem: false, runner } });
  try {
    const l = await getSpaces(relay);
    assert.deepEqual(l.hosts.map((h) => h.id), ["agent-host"]);
    assert.ok(l.spaces.filter((x) => x.kind === "agent").every((x) => x.state === "off"), "nothing adopted");
  } finally {
    await relay.stop();
  }
});

// ---- final fix wave: M5 start only for known agents; I3 the allow list (config and the Deck's Start) ------------

test("M5 POST /spaces/desktop start: only for an agent the relay knows; an unknown name starts nothing", async () => {
  const calls = [];
  const desktops = fakeDesktops([], { start: async (p) => (calls.push(p), { kind: "space", host: "agent-host" }), stop: async () => {}, state: () => "off" });
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops, profiles: () => ["aurora"] });
  assert.deepEqual(await s._desktop({ profile: "stranger", action: "start" }), { ok: false, error: "unknown agent" });
  assert.deepEqual(calls, []);
  assert.equal((await s._desktop({ profile: "aurora", action: "start" })).ok, true);
  assert.deepEqual(calls, ["aurora"]);
});

test("I3 POST /spaces/desktop start for an agent off DECK_DESKTOPS_AGENTS: refused with none, nothing started", async () => {
  const { Desktops } = require("../src/desktops");
  const started = [];
  const local = { async ensure(p) { started.push(p); return { port: 40001 }; }, async stop() {}, async list() { return []; } };
  const desktops = new Desktops({ local, localLimit: 2, presence: { desktopHosts: () => [] }, store: { load: () => ({}), save: () => {} }, allowed: ["aurora"] });
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops, profiles: () => ["aurora", "pioneer"] });
  assert.deepEqual(await s._desktop({ profile: "pioneer", action: "start" }), { ok: false, error: "none" });
  assert.deepEqual(started, []);
  const p = s.list().spaces.find((x) => x.id === "pioneer");
  assert.equal(p.fallback, "none", "Settings and the pill say why");
});

test("I3 config: DECK_DESKTOPS_AGENTS is a comma list of profiles; unset or empty means every configured agent", () => {
  const { desktopsConfig } = require("../src/index");
  assert.equal(desktopsConfig({}).agents, null);
  assert.equal(desktopsConfig({ DECK_DESKTOPS_AGENTS: "  " }).agents, null);
  assert.deepEqual(desktopsConfig({ DECK_DESKTOPS_AGENTS: "aurora, summit ,," }).agents, ["aurora", "summit"]);
});

test("I3 start: the relay passes DECK_DESKTOPS_AGENTS to the registry", async () => {
  const { start } = require("../src/index");
  const relay = await start({ ...relayCfg(), desktops: { host: false, limit: 1, idleMin: 20, sharedFallback: true, lowMem: false, agents: ["aurora"] } });
  try {
    assert.equal(relay.desktops.allowed("aurora"), true);
    assert.equal(relay.desktops.allowed("pioneer"), false);
    assert.deepEqual(await relay.desktops.resolve("pioneer"), { kind: "fallback", reason: "none" });
  } finally {
    await relay.stop();
  }
});

// ---- final fix wave M3: a viewer that leaves aborts the upstream request -----------------------------------------

/** An upstream that answers a head and then holds the body open; resolves `gone` when the request's socket closes. */
function holdingUpstream() {
  let gone;
  const closed = new Promise((r) => (gone = r));
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/connect+proto" });
    res.write("x");
    req.socket.on("close", () => gone());
  });
  return { srv, closed };
}
/** GET through the front, read the head, then leave. */
function getAndLeave(port, path, method = "POST") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, agent: false }, (res) => {
      res.once("data", () => {
        req.destroy();
        resolve(res.statusCode);
      });
    });
    req.on("error", () => {});
    req.setTimeout(3000, () => reject(new Error("no head")));
    req.end();
  });
}
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what)), ms))]);

test("M3 agent host viewer: the viewer leaving aborts the desktop's request (a held PresenceService/Join stream)", { timeout: 5000 }, async () => {
  const up = holdingUpstream();
  const upPort = await listen(up.srv);
  const local = { list: async () => [{ profile: "aurora", running: true, port: upPort }], tokenOf: () => "box-token" };
  const s = new Spaces({ mode: "agent", lock: new SpaceLock(), desktops: fakeDesktops([{ profile: "aurora", host: "agent-host", state: "ready" }]), local });
  const f = await front(s);
  try {
    assert.equal(await getAndLeave(f.port, "/spaces/aurora/view/cua.env.v1.PresenceService/Join"), 200);
    await within(up.closed, 1500, "the upstream request stayed open after the viewer left");
  } finally {
    up.srv.closeAllConnections();
    up.srv.close();
    f.srv.closeAllConnections();
    f.srv.close();
  }
});

test("M3 shared desktop viewer (phase 1 _proxyHttp): the viewer leaving aborts the request to cua-spacesd", { timeout: 5000 }, async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const up = holdingUpstream();
  const upPort = await listen(up.srv);
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "m3-")), "token");
  fs.writeFileSync(tokenFile, "spacesd-token");
  const s = new Spaces({ mode: "shared", lock: new SpaceLock(), spacesd: { url: `http://127.0.0.1:${upPort}`, tokenFile } });
  const f = await front(s);
  try {
    assert.equal(await getAndLeave(f.port, "/spaces/host/view/cua.env.v1.PresenceService/Join"), 200);
    await within(up.closed, 1500, "the upstream request stayed open after the viewer left");
  } finally {
    up.srv.closeAllConnections();
    up.srv.close();
    f.srv.closeAllConnections();
    f.srv.close();
  }
});

test("safety endpoints require bearer auth, validate profiles, and hide infrastructure errors", async (t) => {
  const { createServer } = require("../src/server");
  const approvals = { list: () => [], answer: async () => ({ ok: true }) };
  const audit = { settings: () => ({ audit: true }), update: () => ({ audit: false }), page: async () => ({ records: [], next: null }), frame: async () => ({ mime: "image/png", bytes: Buffer.from("image") }), record() {} };
  const desktops = { homes: {}, list: () => [], snapshots: async () => { throw new Error("private-token private-path private-port"); } };
  const spaces = new Spaces({ lock: new SpaceLock(), desktops, profiles: () => ["agent1"], audit, approvals });
  const model = { snapshot: () => ({}), tokens: () => ({}), sessions: new Map() };
  const server = createServer({ token: "test-token", model, fleet: { data: {} }, hooks: { onHttp: (...a) => spaces.onHttp(...a) }, queryToken: true });
  await new Promise((r) => server.server.listen(0, r));
  t.after(() => { server.server.closeAllConnections(); server.server.close(); });
  const base = new URL(`http://localhost:${server.server.address().port}`);
  const get = (p, auth = true) => fetch(new URL(p, base), { headers: auth ? { authorization: "Bearer test-token" } : {} });
  for (const p of ["/spaces/settings", "/spaces/approvals", "/spaces/agent1/audit", "/spaces/agent1/snapshots"]) {
    assert.equal((await get(p, false)).status, 401);
    assert.equal((await get(p + "?token=test-token", false)).status, 401);
  }
  assert.equal((await get("/spaces/settings")).status, 200);
  assert.equal((await get("/spaces/unknown/audit")).status, 404);
  const result = await get("/spaces/agent1/snapshots");
  assert.equal(result.status, 409);
  assert.doesNotMatch(await result.text(), /private-/);
  assert.equal((await get("/spaces/agent1/audit/frame/11111111-1111-4111-8111-111111111111")).headers.get("cache-control"), "no-store");

  const invalid = await fetch(new URL("/spaces/approvals/11111111-1111-4111-8111-111111111111", base), {
    method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: JSON.stringify({ choice: "always" }),
  });
  assert.equal(invalid.status, 400);
});

test("F6: remote stop notices and reconnect replay are audited without GET snapshots", async (t) => {
  const { Desktops } = require("../src/desktops");
  const { SpaceAudit } = require("../src/space-audit");
  const cfg = relayCfg();
  const now = Date.now(), pointId = "11111111-1111-4111-8111-111111111111";
  const host = "a1b2c3d4";
  let notices = [], time = now;
  const remote = {
    list: async () => [],
    stop: async () => { notices = [{ id: pointId, time: now, event: "created" },
      { id: "22222222-2222-4222-8222-222222222222", time: now, event: "stopped" }]; },
    snapshots: async () => ({ points: [], notices, busy: false }),
  };
  const store = { load: () => ({ snapshotHosts: { agent1: host } }) };
  const make = () => {
    const audit = new SpaceAudit({ dataDir: cfg.dataDir, env: {} });
    const d = new Desktops({ presence: { desktopHosts: () => [{ id: host, ready: true, running: 0 }] }, remote, store, now: () => time });
    new Spaces({ desktops: d, audit });
    return { audit, d };
  };
  const first = make();
  first.d.d.set("agent1", { host, state: "ready" });
  await first.d.stop("agent1"); await first.audit.flush();
  assert.equal((await first.audit.page("agent1")).records.length, 2);
  const restarted = make();
  await restarted.d.syncHosts(); await restarted.audit.flush();
  assert.equal((await restarted.audit.page("agent1")).records.length, 2);
  notices.push({ id: "33333333-3333-4333-8333-333333333333", time: now, event: "restored" });
  time += 11_000;
  await restarted.d.syncHosts(); await restarted.audit.flush();
  assert.equal((await restarted.audit.page("agent1")).records.length, 3, "new offline host notices replay even with unchanged running count");
});

test("settings rejects out-of-range values before persistence", () => {
  const { validSettings } = require("../src/space-audit");
  for (const value of [{ days: 91 }, { days: 0 }, { snapshotKeep: 0 }, { audit: 1 }, { approvals: null }]) assert.equal(validSettings(value), false);
  assert.equal(validSettings({ days: 90, snapshotKeep: 10 }), true);
});

test("safety API consumes audit, approvals and snapshot contracts", async (t) => {
  const { SpaceAudit } = require("../src/space-audit");
  const { SpaceApprovals } = require("../src/space-approvals");
  const cfg = relayCfg();
  const audit = new SpaceAudit({ dataDir: cfg.dataDir, env: {} });
  const calls = [];
  const id = "11111111-1111-4111-8111-111111111111";
  const notice = { id, time: Date.now(), event: "created" };
  const result = { points: [{ id, size: 12 }], totalBytes: 12, notice, notices: [notice], busy: false, recovery: false, host: "agent-host" };
  const desktops = { homes: {}, list: () => [], snapshots: async () => result,
    restore: async (...a) => (calls.push(["restore", ...a]), { ok: true }),
    dropSnapshot: async (...a) => (calls.push(["delete", ...a]), { ok: true }) };
  const approvals = new SpaceApprovals({ snapshot: async (...a) => (calls.push(["snapshot", ...a]), { ok: true }) });
  const card = approvals.check({ profile: "agent1", session: "session1", host: "agent-host", command: "sudo true", text: "sudo true", args: { text: "sudo true" } });
  const spaces = mk({ profiles: () => ["agent1"], desktops, audit, approvals });
  desktops.onSnapshot("agent1", "agent-host", notice);
  desktops.onSnapshot("agent1", "agent-host", notice);
  spaces.endSpace = (p) => calls.push(["end", p]);
  const f = await front(spaces);
  t.after(() => { f.srv.closeAllConnections(); f.srv.close(); });
  const request = async (route, data, method = data === undefined ? "GET" : "POST") => {
    const r = await fetch(f.base + route, { method, headers: { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
  };
  assert.deepEqual((await request("/spaces/settings")).body, { settings: audit.settings() });
  assert.deepEqual((await request("/spaces/settings", { typedText: true })).body, { ok: true, settings: audit.settings() });
  for (const patch of [{ days: 91 }, { secret: true }, [], null])
    assert.deepEqual(await request("/spaces/settings", patch), { status: 400, body: { ok: false, error: "bad-request" } });
  assert.equal((await request("/spaces/approvals")).body.approvals[0].id, card.id);
  for (const patch of [{ choice: "always" }, { choice: "once", withoutSnapshot: 1 }, { choice: "once", extra: true }])
    assert.equal((await request(`/spaces/approvals/${card.id}`, patch)).status, 400);
  assert.deepEqual((await request(`/spaces/approvals/${card.id}`, { choice: "once" })).body, { ok: true, state: "approved" });
  assert.deepEqual(calls.shift(), ["snapshot", "agent1", "before-risky-command", "agent-host"]);
  assert.equal((await request(`/spaces/approvals/${card.id}`, { choice: "deny" })).status, 409);
  assert.deepEqual((await request("/spaces/agent1/snapshots")).body, { ok: true, ...result });
  await request("/spaces/agent1/snapshots");
  await audit.flush();
  const page = await request("/spaces/agent1/audit?limit=1");
  assert.equal(page.body.records.length, 1, "a repeated snapshot notice is recorded once");
  assert.equal(page.body.records[0].event, "created");
  assert.equal(page.body.next, null);
  for (const query of ["limit=0", "limit=101", "limit=1.5", "before=bad"])
    assert.equal((await request(`/spaces/agent1/audit?${query}`)).status, 400);
  assert.equal((await request(`/spaces/agent1/audit/frame/${id}`)).status, 404);
  for (const profile of ["host", "unknown", "bad..name", "%2F"])
    assert.equal((await request(`/spaces/${profile}/snapshots`)).status, 404);
  assert.equal((await request("/spaces/agent1/restore", { id: "bad" })).status, 400);
  assert.equal((await request("/spaces/agent1/restore", { id: [id] })).status, 400);
  assert.equal((await request("/spaces/agent1/snapshots/delete", { id })).status, 400);
  for (const data of [[], true, 1])
    assert.equal((await request("/spaces/agent1/snapshots/delete", data)).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await request("/spaces/agent1/restore", { id })).status, 200);
  assert.equal((await request("/spaces/agent1/snapshots/delete", {})).status, 200);
  assert.deepEqual(calls, [["end", "agent1"], ["restore", "agent1", id], ["delete", "agent1"]]);
  assert.equal((await request("/spaces/settings", undefined, "DELETE")).status, 405);
});

test("safety config carries explicit environment values and startup serves them without a desktop host", async (t) => {
  const { config, start } = require("../src/index");
  const { Driver } = require("../src/driver");
  t.mock.method(Driver.prototype, "start", async () => {}); // composition test: no driver listener
  const env = { DECK_AUDIT: "0", DECK_AUDIT_DAYS: "9", DECK_SNAPSHOT_KEEP: "12", DECK_RISKY_PATTERNS_FILE: "patterns.txt" };
  const safety = config(env).safety;
  assert.deepEqual(safety, { auditEnv: { DECK_AUDIT: "0", DECK_AUDIT_DAYS: "9", DECK_SNAPSHOT_KEEP: "12" }, riskyPatternsFile: "patterns.txt" });
  const cfg = relayCfg({ safety: { ...safety, riskyPatternsFile: null } });
  cfg.driver = { tokensFile: require("node:path").join(cfg.dataDir, "test-device-tokens.json") };
  const relay = await start(cfg);
  t.after(() => relay.stop());
  const r = await fetch(`http://127.0.0.1:${relay.port}/spaces/settings`, { headers: { authorization: `Bearer ${cfg.token}` } });
  assert.equal(r.status, 200);
  const { settings } = await r.json();
  assert.deepEqual([settings.audit, settings.auditLocked, settings.days, settings.snapshotKeep], [false, true, 9, 12]);
  assert.equal(relay.desktops.snapshotSettings().snapshotKeep, 12);
  const { spaceAudit, spaceApprovals, spaces } = relay.driver;
  assert.equal(spaceAudit, spaces.audit);
  assert.equal(spaceApprovals, spaces.approvals);
  assert.equal(spaceAudit.known("aurora"), true);
  assert.equal(spaceAudit.known("unknown"), false);
  relay.model.cfg.profiles.newAgent = {};
  assert.equal(spaceAudit.known("newAgent"), true, "the injected gate follows current known agents");
  assert.equal(mk()._known("unknown"), false, "known-profile check tolerates no desktop registry");
});

test("first local start after relay restart prunes crash-recovery snapshots with relay retention 12, not stored 10", async (t) => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { randomUUID } = require("node:crypto");
  const { config, start } = require("../src/index");
  const { SNAP_SCRIPTS } = require("../../app/main/desktop-host");
  const cfg = relayCfg({ safety: config({ DECK_SNAPSHOT_KEEP: "12" }).safety });
  const dir = path.join(cfg.dataDir, "desktops");
  const file = path.join(dir, `${Buffer.from("aurora").toString("hex")}.snapshots.json`);
  const points = Array.from({ length: 12 }, (_, i) => ({ id: randomUUID(), time: 12 - i, reason: "stop", size: 128, consistent: true }));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ points, keep: 10, dirty: true, recovery: false }));
  const dropped = [];
  const runner = async (a) => {
    let stdout = "";
    if (a[0] === "version") stdout = "27.0.0\n";
    else if (a[0] === "image") stdout = "sha256:x\n";
    else if (a[0] === "ps") stdout = ""; // the crashed desktop is not running and cannot be adopted
    else if (a[0] === "container") stdout = JSON.stringify([{ State: { Running: false } }]);
    else if (a[0] === "network") stdout = "172.30.0.0/16\n";
    else if (a[0] === "port") stdout = "127.0.0.1:41234\n";
    else if (a.includes(SNAP_SCRIPTS.measure)) stdout = "1 /home\n";
    else if (a.includes(SNAP_SCRIPTS.pack)) stdout = "128\n";
    else if (a.includes(SNAP_SCRIPTS.drop)) dropped.push(a.at(-1));
    return { code: 0, stdout, stderr: "" };
  };
  const relay = await start({ ...cfg, desktops: { host: true, limit: 1, runner } });
  t.after(() => relay.stop());
  relay.desktops.ready = async () => true; // exercise the real host/snapshot path without a daemon or Docker
  assert.equal((await relay.desktops.resolve("aurora")).kind, "space");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.points[0].reason, "start", "the first ensure created a crash-recovery point");
  assert.equal(saved.keep, 12);
  assert.equal(saved.points.length, 12);
  assert.deepEqual(dropped, [points.at(-1).id], "only the oldest point is pruned under the relay policy");
});

 test("F5: never-hosted profile snapshots return HTTP 200 and an empty list", async (t) => {
  const { Desktops } = require("../src/desktops");
  const desktops = new Desktops({ presence: {} });
  const spaces = mk({ desktops, profiles: () => ["agent1"], audit: {}, approvals: {} });
  const f = await front(spaces);
  t.after(() => { f.srv.closeAllConnections(); f.srv.close(); });
  const result = await fetch(f.base + "/spaces/agent1/snapshots");
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true, points: [], totalBytes: 0, busy: false, recovery: false, host: null });
});
