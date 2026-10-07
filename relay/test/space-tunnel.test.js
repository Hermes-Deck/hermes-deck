"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { SpaceTunnel } = require("../src/space-tunnel");
const { SpaceTunnelServer } = require("../../app/main/space-tunnel");

async function rig({ allowed = true, handler = null, onUpgrade = null, ctrlTimeoutMs, tunnelOpts = {}, deckOpts = {} } = {}) {
  const seen = [];
  const daemon = http.createServer((req, res) => {
    seen.push([req.url, req.headers.authorization]);
    if (handler) return handler(req, res);
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  if (onUpgrade) daemon.on("upgrade", onUpgrade);
  await new Promise((r) => daemon.listen(0, "127.0.0.1", r));
  daemon.unref();
  const port = daemon.address().port;
  const host = { ensure: async () => ({ port }), stop: async () => {}, list: async () => [{ profile: "aurora", running: true, port }], tokenOf: () => "secret-container-token", _port: async () => port, portOf: () => port };
  const toDeck = [];
  const ws = { readyState: 1, send: (b) => { toDeck.push(Buffer.from(b)); deck.onFrame(b); } };
  const presence = { connOf: (id) => (id === "a1b2c3d4" ? ws : null) };
  const tunnel = new SpaceTunnel({ presence, ...(ctrlTimeoutMs ? { ctrlTimeoutMs } : {}), ...tunnelOpts });
  const relaySeen = [];
  const deck = new SpaceTunnelServer({ host, allowed: () => allowed, send: (b) => { relaySeen.push(Buffer.from(b)); tunnel.onFrame(ws, b); }, ...deckOpts });
  return { tunnel, seen, relaySeen, ws, port, deck, toDeck, daemon };
}

test("ctrl ensure reaches the Deck's DesktopHost; an http call gets the token added on the Deck, never on the wire", async () => {
  const { tunnel, seen, relaySeen } = await rig();
  assert.deepEqual(await tunnel.ctrl("a1b2c3d4", { op: "ensure", profile: "aurora" }), { ok: true, port: null });
  const r = await tunnel.http("a1b2c3d4", { profile: "aurora", method: "POST", path: "/mcp", headers: { "content-type": "application/json" }, body: Buffer.from("{}") });
  assert.equal(r.status, 200);
  assert.deepEqual(seen.at(-1), ["/mcp", "Bearer secret-container-token"]);
  for (const f of relaySeen) assert.ok(!f.toString("latin1").includes("secret-container-token"), "the token never travels to the relay");
});

test("hosting off on the Deck: control and traffic are refused", async () => {
  const { tunnel } = await rig({ allowed: false });
  const r = await tunnel.ctrl("a1b2c3d4", { op: "ensure", profile: "aurora" });
  assert.equal(r.ok, false);
  await assert.rejects(tunnel.http("a1b2c3d4", { profile: "aurora", method: "GET", path: "/health", headers: {}, body: Buffer.alloc(0) }), /refused|not hosting/);
});

test("the Deck's connection going away fails pending calls at once (no hang)", async () => {
  const { tunnel, ws } = await rig();
  const p = tunnel.ctrl("a1b2c3d4", { op: "list" });
  tunnel.removeDeck(ws);
  await assert.rejects(p, /gone|closed/);
});

test("an unknown device or a profile Docker would reject never reaches the Deck", async () => {
  const { tunnel } = await rig();
  await assert.rejects(tunnel.ctrl("ffffffff", { op: "list" }), /no connection/);
  await assert.rejects(tunnel.http("a1b2c3d4", { profile: "../x", method: "GET", path: "/health", headers: {}, body: Buffer.alloc(0) }), /bad profile/);
});

// ---- controller decisions (task 4) -------------------------------------------------------------------
const frames = require("../../app/main/space-tunnel-frames");
const TOKEN = "secret-container-token";

/** Send one frame straight to the Deck (bypassing the relay's own checks) and wait for its answer on `ch`. */
function direct(r, op, ch, payload) {
  const from = r.relaySeen.length;
  r.deck.onFrame(frames.encode(op, ch, payload));
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      for (const b of r.relaySeen.slice(from)) {
        const f = frames.decode(b);
        if (f && f.ch === ch) return resolve(f);
      }
      if (Date.now() - t0 > 3000) return reject(new Error("no answer from the Deck"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test("a relay-supplied authorization header is replaced by the container token on the Deck; none comes back", async () => {
  const r = await rig({
    handler: (req, res) => {
      // a daemon that (badly) echoes the credential back must not leak it to the relay
      res.setHeader("authorization", req.headers.authorization || "");
      res.setHeader("x-echo", req.headers.authorization || "");
      res.setHeader("content-type", "text/plain");
      res.end("fine");
    },
  });
  // straight to the Deck: the relay's own stripping is not what saves us here
  const f = await direct(r, frames.OP.HTTP, 4242, { profile: "aurora", method: "GET", path: "/health", headers: { authorization: "Bearer relay-chosen", Authorization: "Bearer relay-chosen-2" }, body: "" });
  assert.equal(f.op, frames.OP.HTTP_RES);
  assert.deepEqual(r.seen.at(-1), ["/health", `Bearer ${TOKEN}`]);
  const m = frames.json(f.payload);
  assert.equal(m.status, 200);
  assert.equal(m.headers.authorization, undefined);
  assert.equal(m.headers["x-echo"], undefined, "a header carrying the token is dropped");
  // through the relay too
  const res = await r.tunnel.http("a1b2c3d4", { profile: "aurora", method: "GET", path: "/x", headers: { authorization: "Bearer relay-chosen" }, body: Buffer.alloc(0) });
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), "fine");
  assert.equal(res.headers.authorization, undefined);
  assert.deepEqual(r.seen.at(-1), ["/x", `Bearer ${TOKEN}`]);
  for (const b of r.toDeck) assert.ok(!b.toString("latin1").includes("relay-chosen"), "the relay never forwards an authorization header");
  for (const b of r.relaySeen) assert.ok(!b.toString("latin1").includes(TOKEN), "the token never travels to the relay");
});

test("the Deck refuses paths that do not start with / or carry .., // or \\ (403), and the daemon never sees them", async () => {
  const r = await rig();
  let ch = 5000;
  for (const path of ["health", "/a/../b", "/..", "//evil/x", "/a//b", "/a\\b", "/%2e%2e/x", "/a%2F%2Fb", "/a b", "/a\r\nX: y"]) {
    const f = await direct(r, frames.OP.HTTP, ++ch, { profile: "aurora", method: "GET", path, headers: {}, body: "" });
    assert.equal(f.op, frames.OP.HTTP_RES, path);
    assert.equal(frames.json(f.payload).status, 403, path);
    const o = await direct(r, frames.OP.OPEN, ++ch, { profile: "aurora", path, headers: {} });
    assert.equal(o.op, frames.OP.CLOSE, path);
  }
  assert.equal(r.seen.length, 0);
  // a query may carry what a path may not
  const ok = await direct(r, frames.OP.HTTP, ++ch, { profile: "aurora", method: "GET", path: "/ok?u=http://x/..", headers: {}, body: "" });
  assert.equal(frames.json(ok.payload).status, 200);
  // the relay refuses them before sending as well
  await assert.rejects(r.tunnel.http("a1b2c3d4", { profile: "aurora", method: "GET", path: "/a/../b", headers: {}, body: Buffer.alloc(0) }), /bad path/);
});

test("allowed() is asked on every CTRL, HTTP and OPEN", async () => {
  let allowed = true;
  const r = await rig();
  r.deck.allowed = () => allowed;
  assert.equal((await r.tunnel.ctrl("a1b2c3d4", { op: "list" })).ok, true);
  allowed = false;
  const c = await r.tunnel.ctrl("a1b2c3d4", { op: "list" });
  assert.equal(c.ok, false);
  assert.match(c.error, /not hosting/);
  await assert.rejects(r.tunnel.http("a1b2c3d4", { profile: "aurora", method: "GET", path: "/h", headers: {}, body: Buffer.alloc(0) }), /refused/);
  const s = r.tunnel.openWs("a1b2c3d4", { profile: "aurora", path: "/ws", headers: {} });
  const [reason] = await new Promise((resolve) => s.on("close", (...a) => resolve(a)));
  assert.match(String(reason), /not hosting/);
  assert.equal(r.seen.length, 0, "nothing reached the daemon");
});

test("list answers carry no ports or tokens", async () => {
  const r = await rig();
  const res = await r.tunnel.ctrl("a1b2c3d4", { op: "list" });
  assert.deepEqual(res, { ok: true, desktops: [{ profile: "aurora", running: true }] });
  assert.deepEqual(await r.tunnel.remote.list("a1b2c3d4"), [{ profile: "aurora", running: true }]);
  assert.deepEqual(await r.tunnel.remote.ensure("a1b2c3d4", "aurora"), { port: null });
  for (const b of r.relaySeen) assert.ok(!b.toString("latin1").includes(String(r.port)), "the loopback port never travels");
});

function upgradeEcho(seenUp) {
  return (req, socket, head) => {
    seenUp.push([req.url, req.headers.authorization, req.headers.upgrade]);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAuthorization: ${req.headers.authorization}\r\nX-Up: 1\r\n\r\n`);
    const echo = (d) => socket.write(Buffer.concat([Buffer.from("echo:"), d]));
    if (head && head.length) echo(head); // bytes that came with the upgrade request
    socket.on("data", echo);
    socket.on("end", () => socket.end());
    socket.on("error", () => {});
  };
}

test("openWs: the upgrade goes to the profile's port with the token added on the Deck; bytes flow both ways; the token never returns", async () => {
  const seenUp = [];
  const r = await rig({ onUpgrade: upgradeEcho(seenUp) });
  const s = r.tunnel.openWs("a1b2c3d4", { profile: "aurora", path: "/vnc/websockify?x=1", headers: { upgrade: "websocket", connection: "Upgrade", authorization: "Bearer relay-chosen", "sec-websocket-version": "13" } });
  let got = Buffer.alloc(0);
  s.on("data", (b) => (got = Buffer.concat([got, b])));
  s.send(Buffer.from("hello")); // before OPENED: queued on the Deck
  const t0 = Date.now();
  while (!got.toString().includes("echo:hello") && Date.now() - t0 < 3000) await new Promise((x) => setTimeout(x, 10));
  const text = got.toString();
  assert.match(text, /^HTTP\/1\.1 101 /);
  assert.match(text, /X-Up: 1/);
  assert.ok(!/authorization/i.test(text), "the upgrade answer reaches the relay without an authorization line");
  assert.ok(text.includes("echo:hello"));
  assert.deepEqual(seenUp, [["/vnc/websockify?x=1", `Bearer ${TOKEN}`, "websocket"]]);
  for (const b of r.relaySeen) assert.ok(!b.toString("latin1").includes(TOKEN));
  const closed = new Promise((resolve) => s.on("close", resolve));
  s.close();
  await closed;
});

test("removeDeck closes an open WS (emits close) and the Deck's later frames are ignored", async () => {
  const r = await rig({ onUpgrade: upgradeEcho([]) });
  const s = r.tunnel.openWs("a1b2c3d4", { profile: "aurora", path: "/ws", headers: { upgrade: "websocket", connection: "Upgrade" } });
  await new Promise((resolve) => s.once("data", resolve));
  const closed = new Promise((resolve) => s.on("close", (...a) => resolve(a)));
  r.tunnel.removeDeck(r.ws);
  const [reason] = await closed;
  assert.match(String(reason), /gone/);
  let late = false;
  s.on("data", () => (late = true));
  r.deck.closeAll("test over");
  await new Promise((x) => setTimeout(x, 30));
  assert.equal(late, false);
});

test("bodies over 32 MB are refused before they are sent; a frame from another connection cannot answer a call", async () => {
  const r = await rig();
  const before = r.toDeck.length;
  await assert.rejects(r.tunnel.http("a1b2c3d4", { profile: "aurora", method: "POST", path: "/big", headers: {}, body: Buffer.alloc(32 * 1024 * 1024 + 1) }), /too large/);
  assert.equal(r.toDeck.length, before);
  // the Deck refuses an oversized body too (413)
  const big = Buffer.alloc(32 * 1024 * 1024 + 1).toString("base64");
  const f = await direct(r, frames.OP.HTTP, 7777, { profile: "aurora", method: "POST", path: "/big", headers: {}, body: big });
  assert.equal(frames.json(f.payload).status, 413);
  // a forged answer from some other Deck's connection is ignored
  const other = { readyState: 1, send() {} };
  const p = r.tunnel.ctrl("a1b2c3d4", { op: "list" });
  const ch = frames.decode(r.toDeck.at(-1)).ch;
  r.tunnel.onFrame(other, frames.encode(frames.OP.CTRL_RES, ch, { ok: true, desktops: [{ profile: "forged", running: true }] }));
  assert.deepEqual((await p).desktops, [{ profile: "aurora", running: true }]);
});

test("ctrl times out when the Deck never answers; non-[0xD6] frames are not ours", async () => {
  const silent = { readyState: 1, send() {} };
  const tunnel = new SpaceTunnel({ presence: { connOf: () => silent }, ctrlTimeoutMs: 30 });
  await assert.rejects(tunnel.ctrl("a1b2c3d4", { op: "list" }), /did not answer/);
  assert.equal(tunnel.onFrame(silent, Buffer.from([0xcd, 1, 0, 0, 0, 1])), false);
  assert.equal(tunnel.onFrame(silent, frames.encode(frames.OP.CTRL_RES, 99, {})), true);
});

test("the relay's frame codec is byte-identical to the Deck's", () => {
  const relay = require("../src/space-tunnel");
  for (const [op, ch, p] of [[1, 1, { op: "list" }], [7, 0xfffffffe, Buffer.from([1, 2, 3])], [8, 3, null]]) {
    assert.deepEqual(relay.encode(op, ch, p), frames.encode(op, ch, p));
    assert.deepEqual(relay.decode(frames.encode(op, ch, p)), frames.decode(frames.encode(op, ch, p)));
  }
  assert.deepEqual(relay.OP, frames.OP);
  assert.equal(relay.MAGIC, frames.MAGIC);
});

// ---- fix round 1: OPEN is an upgrade, not a raw pipe; openWs has an OPENED deadline --------------------
const net = require("node:net");

/** A raw TCP daemon that records every byte it receives and answers the first request head with `answer`. */
async function rawRig(answer) {
  const got = [];
  const conns = [];
  const daemon = net.createServer((s) => {
    const c = { bytes: Buffer.alloc(0), closed: false };
    conns.push(c);
    let answered = false;
    s.on("data", (d) => {
      c.bytes = Buffer.concat([c.bytes, d]);
      got.push(Buffer.from(d));
      if (!answered && c.bytes.includes("\r\n\r\n")) {
        answered = true;
        s.write(answer);
      }
    });
    s.on("close", () => (c.closed = true));
    s.on("error", () => {});
  });
  await new Promise((r) => daemon.listen(0, "127.0.0.1", r));
  daemon.unref();
  const port = daemon.address().port;
  const host = { ensure: async () => ({ port }), stop: async () => {}, list: async () => [{ profile: "aurora", running: true, port }], tokenOf: () => TOKEN };
  const relaySeen = [];
  const deck = new SpaceTunnelServer({ host, allowed: () => true, send: (b) => relaySeen.push(Buffer.from(b)) });
  const all = () => Buffer.concat(got).toString("latin1");
  return { deck, relaySeen, conns, all, port };
}

const until = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((x) => setTimeout(x, 5));
  }
  return true;
};
const framesOn = (r, ch) => r.relaySeen.map((b) => frames.decode(b)).filter((f) => f && f.ch === ch);
const UPGRADE = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };

test("OPEN without upgrade: websocket is refused and nothing connects", async () => {
  const r = await rawRig("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
  r.deck.onFrame(frames.encode(frames.OP.OPEN, 11, { profile: "aurora", path: "/ok", headers: {} }));
  r.deck.onFrame(frames.encode(frames.OP.OPEN, 12, { profile: "aurora", path: "/ok", headers: { upgrade: "h2c", connection: "Upgrade" } }));
  assert.ok(await until(() => framesOn(r, 11).some((f) => f.op === frames.OP.CLOSE) && framesOn(r, 12).some((f) => f.op === frames.OP.CLOSE)));
  await new Promise((x) => setTimeout(x, 30));
  assert.equal(r.conns.length, 0);
});

test("the relay cannot pipeline a second HTTP request past the Deck's path and Host rules", async () => {
  const r = await rawRig("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
  r.deck.onFrame(frames.encode(frames.OP.OPEN, 21, { profile: "aurora", path: "/ok", headers: UPGRADE }));
  r.deck.onFrame(frames.encode(frames.OP.DATA, 21, Buffer.from("GET /../x//y HTTP/1.1\r\nHost: evil\r\n\r\n")));
  assert.ok(await until(() => framesOn(r, 21).some((f) => f.op === frames.OP.CLOSE)), "the channel closes");
  // more DATA after the refusal goes nowhere either
  r.deck.onFrame(frames.encode(frames.OP.DATA, 21, Buffer.from("GET /late HTTP/1.1\r\n\r\n")));
  assert.ok(await until(() => r.conns.every((c) => c.closed)), "the desktop socket is destroyed");
  const sent = r.all();
  assert.equal((sent.match(/HTTP\/1\.1\r\n/g) || []).length, 1, "exactly one request reached the daemon");
  assert.match(sent, /^GET \/ok HTTP\/1\.1\r\n/);
  assert.match(sent, /\r\nConnection: Upgrade\r\n/i);
  assert.ok(!sent.includes("/../x//y") && !sent.includes("Host: evil") && !sent.includes("/late"));
  const fs = framesOn(r, 21);
  assert.deepEqual(fs.map((f) => f.op), [frames.OP.OPENED, frames.OP.DATA, frames.OP.CLOSE]);
  assert.match(fs[1].payload.toString(), /^HTTP\/1\.1 200 OK\r\n/);
});

test("a non-101 answer is forwarded (head only), then the channel closes; queued DATA never reaches the daemon", async () => {
  const r = await rawRig(`HTTP/1.1 404 Not Found\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 5\r\n\r\nnope!`);
  r.deck.onFrame(frames.encode(frames.OP.OPEN, 31, { profile: "aurora", path: "/ws", headers: UPGRADE }));
  r.deck.onFrame(frames.encode(frames.OP.DATA, 31, Buffer.from("queued-bytes")));
  assert.ok(await until(() => framesOn(r, 31).some((f) => f.op === frames.OP.CLOSE)));
  assert.ok(await until(() => r.conns.every((c) => c.closed)));
  const fs = framesOn(r, 31);
  const head = fs.find((f) => f.op === frames.OP.DATA).payload.toString();
  assert.match(head, /^HTTP\/1\.1 404 Not Found\r\n/);
  assert.ok(!/authorization/i.test(head) && !head.includes(TOKEN));
  assert.match(frames.json(fs.at(-1).payload).reason, /404/);
  assert.ok(!r.all().includes("queued-bytes"));
});

test("a 101 answer flushes the queue and pipes both ways", async () => {
  const r = await rawRig("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  r.deck.onFrame(frames.encode(frames.OP.OPEN, 41, { profile: "aurora", path: "/ws", headers: UPGRADE }));
  r.deck.onFrame(frames.encode(frames.OP.DATA, 41, Buffer.from("early")));
  assert.ok(await until(() => r.all().includes("early")));
  r.deck.onFrame(frames.encode(frames.OP.DATA, 41, Buffer.from("later")));
  assert.ok(await until(() => r.all().includes("later")));
  assert.ok(r.all().indexOf("early") > r.all().indexOf("\r\n\r\n"), "queued bytes follow the upgrade request");
  assert.ok(!framesOn(r, 41).some((f) => f.op === frames.OP.CLOSE));
  r.deck.closeAll("test over");
});

test("openWs: a Deck that never answers OPEN times out (CLOSE sent, close emitted); OPENED in time clears it", async () => {
  const sent = [];
  const silent = { readyState: 1, send: (b) => sent.push(frames.decode(b)) };
  const tunnel = new SpaceTunnel({ presence: { connOf: () => silent }, openTimeoutMs: 30 });
  const s = tunnel.openWs("a1b2c3d4", { profile: "aurora", path: "/ws", headers: UPGRADE });
  const [reason] = await new Promise((resolve) => s.on("close", (...a) => resolve(a)));
  assert.match(String(reason), /did not answer in time/);
  const ch = sent[0].ch;
  assert.ok(sent.some((f) => f.op === frames.OP.CLOSE && f.ch === ch), "the Deck is told to drop the channel");
  // OPENED before the deadline
  const s2 = tunnel.openWs("a1b2c3d4", { profile: "aurora", path: "/ws", headers: UPGRADE });
  let closed = false;
  s2.on("close", () => (closed = true));
  tunnel.onFrame(silent, frames.encode(frames.OP.OPENED, sent.at(-1).ch));
  await new Promise((x) => setTimeout(x, 80));
  assert.equal(closed, false);
  s2.close();
});

// ---- Task 11b: streamed answers for viewer HTTP (PresenceService/Join is a server stream) -------------------------
const JOIN = "/cua.env.v1.PresenceService/Join";
const STREAM_CHUNK = 256 * 1024;
const wait = (p, ms = 3000, what = "timed out") => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what)), ms))]);
/** All of a Readable's remaining bytes, from its async iterator (rejects when it is destroyed with an error). */
async function drain(it) {
  const parts = [];
  for (;;) {
    const { value, done } = await it.next();
    if (done) return Buffer.concat(parts);
    parts.push(Buffer.from(value));
  }
}

test("11b stream: the first chunk reaches the relay before the desktop's answer ends; token added on the Deck only; frames <= 256 KB", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  let ended = false;
  const r = await rig({
    handler: (req, res) => {
      res.writeHead(200, { "content-type": "application/connect+proto", "x-echo": req.headers.authorization || "" });
      res.write("first");
      gate.then(() => {
        res.write(Buffer.alloc(600 * 1024, 0x61));
        res.end("last", () => (ended = true));
      });
    },
  });
  const a = await r.tunnel.stream("a1b2c3d4", { profile: "aurora", method: "POST", path: JOIN, headers: { "content-type": "application/connect+proto", authorization: "Bearer relay-chosen" }, body: Buffer.from("join") });
  assert.equal(a.status, 200);
  assert.equal(a.headers["content-type"], "application/connect+proto");
  assert.equal(a.headers["x-echo"], undefined, "a header holding the token is dropped");
  const it = a.body[Symbol.asyncIterator]();
  const first = await wait(it.next(), 3000, "no first chunk while the answer is still open");
  assert.equal(Buffer.from(first.value).toString(), "first");
  assert.equal(ended, false, "the desktop's answer has not ended yet");
  release();
  const rest = await wait(drain(it));
  assert.equal(rest.length, 600 * 1024 + 4);
  assert.equal(rest.subarray(-4).toString(), "last");
  assert.deepEqual(r.seen.at(-1), [JOIN, `Bearer ${TOKEN}`]);
  const data = r.relaySeen.map((b) => frames.decode(b)).filter((f) => f && f.op === frames.OP.DATA);
  assert.ok(data.length >= 3, "600 KB goes as several frames");
  for (const f of data) assert.ok(f.payload.length <= STREAM_CHUNK, `frame of ${f.payload.length} bytes`);
  for (const b of r.relaySeen) assert.ok(!b.toString("latin1").includes(TOKEN), "the token never travels to the relay");
  for (const b of r.toDeck) assert.ok(!b.toString("latin1").includes("relay-chosen"), "the relay never forwards an authorization header");
  assert.equal(r.tunnel.streams.size, 0);
  assert.equal(r.deck.streams.size, 0);
});

test("11b stream: the viewer going (abort) sends CLOSE and the Deck drops the desktop request, before and after the head", async () => {
  const closes = [];
  let head = true;
  const r = await rig({
    handler: (req, res) => {
      res.on("close", () => closes.push(req.url));
      if (head) {
        res.writeHead(200, { "content-type": "application/connect+proto" });
        res.write("x");
      } // else: never answers
    },
  });
  const ac = new AbortController();
  const a = await r.tunnel.stream("a1b2c3d4", { profile: "aurora", method: "POST", path: `${JOIN}?n=1`, headers: {}, body: Buffer.from("j"), signal: ac.signal });
  const it = a.body[Symbol.asyncIterator]();
  await wait(it.next());
  ac.abort();
  assert.ok(await until(() => closes.includes(`${JOIN}?n=1`)), "the desktop's request was closed");
  const last = frames.decode(r.toDeck.at(-1));
  assert.equal(last.op, frames.OP.CLOSE);
  assert.ok(r.toDeck.some((b) => { const f = frames.decode(b); return f.op === frames.OP.HTTP && f.ch === last.ch; }));
  await assert.rejects(drain(it));
  assert.equal(r.deck.streams.size, 0);
  assert.equal(r.tunnel.streams.size, 0);
  // before the head: the call rejects at once, the Deck still drops the request
  head = false;
  const ac2 = new AbortController();
  const p = r.tunnel.stream("a1b2c3d4", { profile: "aurora", method: "POST", path: `${JOIN}?n=2`, headers: {}, body: Buffer.from("j"), signal: ac2.signal });
  p.catch(() => {});
  assert.ok(await until(() => r.seen.some(([u]) => u === `${JOIN}?n=2`)));
  ac2.abort();
  await assert.rejects(p);
  assert.ok(await until(() => closes.includes(`${JOIN}?n=2`)), "the unanswered request was closed too");
  assert.equal(r.deck.streams.size, 0);
});

test("11b stream: idle timeout on the relay (no head, then no bytes) tells the Deck to drop it", async () => {
  const sent = [];
  let deck = null; // a fake Deck: answers what `deck` says
  const ws = { readyState: 1, send: (b) => { const f = frames.decode(b); sent.push(f); if (deck) deck(f); } };
  const tunnel = new SpaceTunnel({ presence: { connOf: () => ws }, streamIdleMs: 150 });
  await assert.rejects(tunnel.stream("a1b2c3d4", { profile: "aurora", method: "POST", path: JOIN, headers: {}, body: Buffer.alloc(0) }), (e) => e.status === 504);
  assert.ok(sent.some((f) => f.op === frames.OP.CLOSE), "CLOSE after no head");
  sent.length = 0;
  deck = (f) => {
    if (f.op !== frames.OP.HTTP) return;
    tunnel.onFrame(ws, frames.encode(frames.OP.HTTP_RES, f.ch, { status: 200, headers: {}, stream: true }));
    setTimeout(() => tunnel.onFrame(ws, frames.encode(frames.OP.DATA, f.ch, Buffer.from("a"))), 50);
    setTimeout(() => tunnel.onFrame(ws, frames.encode(frames.OP.DATA, f.ch, Buffer.from("b"))), 150); // 100 ms after "a": inside the 150 ms
  };
  const a = await tunnel.stream("a1b2c3d4", { profile: "aurora", method: "POST", path: JOIN, headers: {}, body: Buffer.alloc(0) });
  const got = [];
  const err = await wait(new Promise((resolve) => {
    a.body.on("data", (d) => got.push(d.toString()));
    a.body.on("error", resolve);
    a.body.on("end", () => resolve(null));
  }));
  assert.deepEqual(got, ["a", "b"], "bytes keep it alive; the clock counts from the last one");
  assert.ok(err && err.status === 504, "then nothing for 150 ms: it ends with an error");
  assert.ok(sent.some((f) => f.op === frames.OP.CLOSE));
  assert.equal(tunnel.streams.size, 0);
});

test("11b stream: idle timeout on the Deck (the desktop sends nothing) closes the desktop request and tells the relay", async () => {
  const closes = [];
  let mode = "stall-after-head";
  const r = await rig({
    deckOpts: { streamIdleMs: 80 },
    handler: (req, res) => {
      const m = mode;
      res.on("close", () => closes.push(m));
      if (m === "stall-after-head") {
        res.writeHead(200);
        res.write("x");
      }
    },
  });
  const a = await r.tunnel.stream("a1b2c3d4", { profile: "aurora", method: "POST", path: JOIN, headers: {}, body: Buffer.alloc(0) });
  await assert.rejects(wait(drain(a.body[Symbol.asyncIterator]())), /sent nothing/);
  assert.ok(await until(() => closes.includes("stall-after-head")));
  mode = "no-head";
  await assert.rejects(r.tunnel.stream("a1b2c3d4", { profile: "aurora", method: "POST", path: JOIN, headers: {}, body: Buffer.alloc(0) }), (e) => e.status === 504);
  assert.ok(await until(() => closes.includes("no-head")));
  assert.equal(r.deck.streams.size, 0);
});

test("11b stream: the Deck's policy holds (path, hosting, authorization); an older Deck's buffered answer still works", async () => {
  const r = await rig();
  // straight to the Deck, past the relay's own checks
  let ch = 9100;
  for (const path of ["/a/../b", "//x", "/%2e%2e/x", "relative"]) {
    const f = await direct(r, frames.OP.HTTP, ++ch, { profile: "aurora", method: "GET", path, headers: {}, body: "", stream: true });
    assert.equal(f.op, frames.OP.HTTP_RES, path);
    assert.equal(frames.json(f.payload).status, 403, path);
  }
  assert.equal(r.seen.length, 0, "nothing reached the desktop");
  r.deck.allowed = () => false;
  await assert.rejects(r.tunnel.stream("a1b2c3d4", { profile: "aurora", method: "GET", path: "/viewer/", headers: {} }), /refused|not hosting/);
  await assert.rejects(r.tunnel.stream("a1b2c3d4", { profile: "aurora", method: "GET", path: "/a/../b", headers: {} }), /bad path/);
  assert.equal(r.seen.length, 0);
  assert.equal(r.deck.streams.size, 0);
  // a Deck from before 11b answers a stream request in one piece
  const old = { readyState: 1, send: (b) => { const f = frames.decode(b); if (f.op === frames.OP.HTTP) setImmediate(() => tunnel.onFrame(old, frames.encode(frames.OP.HTTP_RES, f.ch, { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("whole").toString("base64") }))); } };
  const tunnel = new SpaceTunnel({ presence: { connOf: () => old } });
  const a = await tunnel.stream("a1b2c3d4", { profile: "aurora", method: "GET", path: "/viewer/", headers: {} });
  assert.equal(a.status, 200);
  assert.equal(a.headers["content-type"], "text/html");
  assert.equal((await drain(a.body[Symbol.asyncIterator]())).toString(), "whole");
  assert.equal(tunnel.streams.size, 0);
});

test("11b stream: buffered http() is unchanged (no stream flag, whole body in one HTTP_RES) for MCP and health", async () => {
  const r = await rig({ handler: (req, res) => { res.write("a"); setTimeout(() => res.end("b"), 20); } });
  const res = await r.tunnel.http("a1b2c3d4", { profile: "aurora", method: "POST", path: "/mcp", headers: {}, body: Buffer.from("{}") });
  assert.equal(res.body.toString(), "ab");
  const h = r.toDeck.map((b) => frames.decode(b)).find((f) => f.op === frames.OP.HTTP);
  assert.equal(frames.json(h.payload).stream, undefined);
  assert.ok(!r.relaySeen.some((b) => frames.decode(b).op === frames.OP.DATA), "one HTTP_RES, no DATA frames");
});

test("11b stream: removeDeck ends a running stream with an error; closeAll on the Deck aborts its desktop requests and tells the relay", async () => {
  const closes = [];
  const r = await rig({ handler: (req, res) => { res.on("close", () => closes.push(req.url)); res.writeHead(200); res.write("x"); } });
  const a = await r.tunnel.stream("a1b2c3d4", { profile: "aurora", method: "POST", path: `${JOIN}?n=1`, headers: {} });
  const it = a.body[Symbol.asyncIterator]();
  await wait(it.next());
  r.tunnel.removeDeck(r.ws);
  await assert.rejects(drain(it), /gone/);
  assert.equal(r.tunnel.streams.size, 0);
  r.deck.closeAll("relay connection lost");
  assert.ok(await until(() => closes.includes(`${JOIN}?n=1`)));
  const b = await r.tunnel.stream("a1b2c3d4", { profile: "aurora", method: "POST", path: `${JOIN}?n=2`, headers: {} });
  const it2 = b.body[Symbol.asyncIterator]();
  await wait(it2.next());
  r.deck.closeAll("agent desktops were switched off on this device", true);
  await assert.rejects(drain(it2), /switched off/);
  assert.ok(await until(() => closes.includes(`${JOIN}?n=2`)));
  assert.equal(r.deck.streams.size, 0);
});

test("11b stream: a viewer that does not read cannot make the relay buffer without bound", async () => {
  const sent = [];
  const ws = {
    readyState: 1,
    send: (b) => {
      const f = frames.decode(b);
      sent.push(f);
      if (f.op !== frames.OP.HTTP) return;
      setImmediate(() => tunnel.onFrame(ws, frames.encode(frames.OP.HTTP_RES, f.ch, { status: 200, headers: {}, stream: true })));
      setTimeout(() => { for (let i = 0; i < 10; i++) tunnel.onFrame(ws, frames.encode(frames.OP.DATA, f.ch, Buffer.alloc(1024))); }, 30);
    },
  };
  const tunnel = new SpaceTunnel({ presence: { connOf: () => ws }, maxStreamBuffer: 4096 });
  const a = await tunnel.stream("a1b2c3d4", { profile: "aurora", method: "GET", path: "/viewer/", headers: {} });
  const err = await wait(new Promise((resolve) => a.body.on("error", resolve)));
  assert.match(String(err.message), /not reading/);
  assert.ok(sent.some((f) => f.op === frames.OP.CLOSE), "the Deck is told to drop it");
  assert.equal(tunnel.streams.size, 0);
});

// ---- final fix wave: M2 the Deck's limit refusal is marked; M8 a failed Deck stop is a failure ------------------

test("M2 remote.ensure: the Deck's own limit refusal rejects with code LIMIT; other refusals carry no code", async () => {
  const { LIMIT_ERROR } = require("../../app/main/desktops");
  const { DECK_LIMIT_ERROR, DECK_NOT_HOSTING } = require("../src/space-tunnel");
  assert.equal(DECK_LIMIT_ERROR, LIMIT_ERROR, "the relay's copy matches the Deck's text");
  assert.equal(DECK_NOT_HOSTING, require("../../app/main/space-tunnel").NOT_HOSTING);
  const r = await rig();
  r.deck.host.ensure = async () => { throw new Error(LIMIT_ERROR); };
  await assert.rejects(r.tunnel.remote.ensure("a1b2c3d4", "aurora"), (e) => e.code === "LIMIT");
  r.deck.host.ensure = async () => { throw new Error("docker run failed: no space left"); };
  await assert.rejects(r.tunnel.remote.ensure("a1b2c3d4", "aurora"), (e) => e.code === undefined && /no space left/.test(e.message));
});

test("M8 remote.stop: a Deck whose docker stop failed makes the stop fail (the relay keeps the slot); not hosting is not a failure", async () => {
  const r = await rig();
  r.deck.host.stop = async () => { throw new Error("docker stop failed: timed out"); };
  await assert.rejects(r.tunnel.remote.stop("a1b2c3d4", "aurora"), /docker stop failed/);
  r.deck.host.stop = async () => {};
  await r.tunnel.remote.stop("a1b2c3d4", "aurora");
  const off = await rig({ allowed: false }); // hosting switched off: the Deck stopped its desktops itself
  await off.tunnel.remote.stop("a1b2c3d4", "aurora");
});

// ---- final fix wave: T3 streams only on viewer paths, T4 a throw never leaks a registered stream or socket -------

test("T3 Deck: stream:true is refused unless the path passes the viewer rule (never /mcp, /health or files)", async () => {
  const r = await rig();
  let ch = 9300;
  for (const path of ["/mcp", "/health", "/cua.env.v1.FileService/Read", "/cua.env.v1.SystemService/Reboot", "/cua.env.v1.ComputerService/GetClipboard", "/cua.env.v1.ComputerService/SetClipboard"]) {
    const f = await direct(r, frames.OP.HTTP, ++ch, { profile: "aurora", method: "POST", path, headers: {}, body: "", stream: true });
    assert.equal(f.op, frames.OP.HTTP_RES, path);
    assert.equal(frames.json(f.payload).status, 403, path);
  }
  assert.equal(r.seen.length, 0, "nothing reached the desktop");
  assert.equal(r.deck.streams.size, 0);
  // the viewer's own streams still pass (input paths too: the relay applied the level)
  for (const path of ["/cua.env.v1.PresenceService/Join", "/viewer/viewer.js?x=1", "/cua.env.v1.ComputerService/Click"]) {
    const f = await direct(r, frames.OP.HTTP, ++ch, { profile: "aurora", method: "GET", path, headers: {}, body: "", stream: true });
    assert.equal(frames.json(f.payload).status, 200, path);
  }
  // a buffered request (MCP, /health: space-fetch.js) is not a stream and keeps its own rule
  const mcp = await direct(r, frames.OP.HTTP, ++ch, { profile: "aurora", method: "POST", path: "/mcp", headers: {}, body: "" });
  assert.equal(frames.json(mcp.payload).status, 200);
});

test("T4 Deck: a throw inside _http after a stream registered ends it; a throw inside _open drops its socket", async () => {
  const r = await rig();
  r.deck._token = () => { throw new Error("boom"); }; // throws after the stream / socket is registered
  const f = await direct(r, frames.OP.HTTP, 9400, { profile: "aurora", method: "GET", path: "/cua.env.v1.PresenceService/Join", headers: {}, body: "", stream: true });
  assert.equal(f.op, frames.OP.HTTP_RES);
  assert.equal(frames.json(f.payload).status, 502);
  assert.equal(r.deck.streams.size, 0, "the stream is not leaked");
  const o = await direct(r, frames.OP.OPEN, 9401, { profile: "aurora", path: "/media", headers: { upgrade: "websocket" } });
  assert.equal(o.op, frames.OP.CLOSE);
  assert.equal(r.deck.socks.size, 0, "the socket is not leaked");
  assert.equal(r.deck.size, 0);
});

test("snapshot CTRL is gated and projected; disconnect fails restore and reconnect can list", async () => {
  const { tunnel, deck, ws, relaySeen } = await rig();
  const id = "11111111-1111-4111-8111-111111111111";
  const point = { id, time: 7, reason: "stop", size: 12, consistent: true };
  deck.host.snapshot = async () => ({ ok: true, point: { ...point, token: "private", path: "private", port: 9 } });
  deck.host.snapshots = async () => ({ points: [point], totalBytes: 12, notice: null, busy: false, recovery: false });
  deck.host.dropSnapshot = async () => ({ ok: true });
  const r = await tunnel.remote.snapshot("a1b2c3d4", "agent1", { reason: "stop", keep: 10 });
  assert.deepEqual(r.point, point);
  await assert.rejects(tunnel.ctrl("a1b2c3d4", { op: "restore", profile: "../x", id, keep: 10 }), /bad profile/);
  await assert.rejects(tunnel.ctrl("a1b2c3d4", { op: "restore", profile: "agent1", id: "../x", keep: 10 }), /bad snapshot/);
  let finish;
  deck.host.restore = () => new Promise((r) => { finish = r; });
  const pending = tunnel.remote.restore("a1b2c3d4", "agent1", { id, keep: 10 });
  await new Promise(setImmediate);
  tunnel.removeDeck(ws);
  await assert.rejects(pending, /gone/);
  finish({ ok: true, before: id });
  await new Promise(setImmediate);
  assert.equal((await tunnel.remote.snapshots("a1b2c3d4", "agent1", { keep: 10 })).points.length, 1);
  assert.equal(relaySeen.some((b) => /private/.test(b.toString())), false);
  deck.allowed = () => false;
  for (const op of ["snapshot", "snapshots", "restore", "dropSnapshot"]) {
    const reply = await tunnel.ctrl("a1b2c3d4", { op, profile: "agent1", id, reason: "stop", keep: 10 });
    assert.equal(reply.ok, false, op);
  }
});

test("snapshot commands validate both ends, forward bounded options, and redact failures", async () => {
  const r = await rig();
  const id = "11111111-1111-4111-8111-111111111111";
  const calls = [];
  r.deck.host.snapshot = async (...args) => { calls.push(args); return { ok: false, reason: "too-large", error: "private" }; };
  r.deck.host.restore = async (...args) => { calls.push(args); return { ok: true, before: id, path: "private" }; };
  r.deck.host.dropSnapshot = async (...args) => { calls.push(args); return { ok: true }; };
  r.deck.host.stop = async (...args) => { calls.push(args); };
  r.deck.host.ensure = async () => { throw new Error("snapshot must not start a desktop"); };
  let ch = 9000;
  for (const cmd of [
    { op: "snapshot", profile: "agent1", reason: "stop", keep: 0 },
    { op: "snapshots", profile: "agent1", keep: 101 },
    { op: "snapshots", profile: "agent1", keep: 1.5 },
    { op: "snapshot", profile: "agent1", reason: "private", keep: 10 },
    { op: "restore", profile: "agent1", id: null, keep: 10 },
    { op: "dropSnapshot", profile: "agent1", keep: 10 },
    { op: "snapshots", profile: "../x", keep: 10 },
    { op: "stop", profile: "agent1", keep: 0 },
  ]) {
    await assert.rejects(r.tunnel.ctrl("a1b2c3d4", cmd), /bad /);
    assert.equal(frames.json((await direct(r, frames.OP.CTRL, ++ch, cmd)).payload).ok, false);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await r.tunnel.remote.snapshot("a1b2c3d4", "agent1", { reason: "stop", keep: 1 }),
    { ok: false, reason: "too-large", error: "snapshot operation failed" });
  assert.deepEqual(calls.pop(), ["agent1", "stop", { keep: 1 }]);
  assert.deepEqual(await r.tunnel.remote.restore("a1b2c3d4", "agent1", { id, keep: 100 }), { ok: true, before: id });
  assert.deepEqual(calls.pop(), ["agent1", id, { keep: 100 }]);
  for (const dropId of [id, null]) {
    await r.tunnel.remote.dropSnapshot("a1b2c3d4", "agent1", { id: dropId });
    assert.deepEqual(calls.pop(), ["agent1", dropId]);
  }
  await r.tunnel.remote.stop("a1b2c3d4", "agent1", { keep: 7 });
  assert.deepEqual(calls.pop(), ["agent1", { keep: 7 }]);
  r.deck.host.snapshot = async () => { throw new Error("private path token port"); };
  await assert.rejects(r.tunnel.remote.snapshot("a1b2c3d4", "agent1", { reason: "start" }), /^Error: snapshot operation failed$/);
  assert.equal(r.relaySeen.some((b) => b.toString().includes("private")), false);
});

test("snapshot results are projected at each boundary and long operations get their required timeouts", async () => {
  const r = await rig({ ctrlTimeoutMs: 123 });
  const id = "11111111-1111-4111-8111-111111111111";
  const point = { id, time: 7, reason: "stop", size: 12, consistent: true };
  const notice = { id, time: 8, event: "created" };
  const result = { ok: true, points: [{ ...point, token: "private" }, { ...point, size: -1 }],
    totalBytes: 999, notice: { ...notice, path: "private" }, notices: [{ ...notice, port: 9 }, { ...notice, event: "private" }],
    busy: true, recovery: true, path: "private" };
  const expected = { ok: true, points: [point], totalBytes: 12, notice, notices: [notice], busy: true, recovery: true };
  r.deck.host.snapshots = async () => result;
  assert.deepEqual(frames.json((await direct(r, frames.OP.CTRL, 9100, { op: "snapshots", profile: "agent1", keep: 10 })).payload), expected);
  r.ws.send = (b) => {
    const f = frames.decode(b);
    r.tunnel.onFrame(r.ws, frames.encode(frames.OP.CTRL_RES, f.ch, result));
  };
  assert.deepEqual(await r.tunnel.remote.snapshots("a1b2c3d4", "agent1"), expected);
  r.tunnel._call = async (_ws, _kind, payload, timeout) => ({ payload, timeout });
  for (const [op, timeout] of [["ensure", 300_000], ["stop", 300_000], ["snapshot", 300_000],
    ["snapshots", 300_000], ["restore", 900_000], ["dropSnapshot", 300_000], ["list", 123]]) {
    const reply = await r.tunnel.ctrl("a1b2c3d4", { op, profile: "agent1", id, reason: "stop", keep: 10, path: "private" });
    assert.equal(reply.timeout, timeout, op);
    assert.equal(reply.payload.path, undefined);
  }
});
