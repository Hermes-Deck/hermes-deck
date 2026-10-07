"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { viewUrl, levelOk, inputBlocked } = require("../main/space-view-logic");
const { startSpaceProxy } = require("../main/space-proxy");

test("control levels and what each lets through", () => {
  for (const l of ["watch", "together", "full"]) assert.ok(levelOk(l));
  assert.equal(levelOk("root"), false);
  assert.equal(inputBlocked("watch"), true);
  assert.equal(inputBlocked("together"), false);
  assert.equal(inputBlocked("full"), false);
});

test("the viewer URL is the local proxy; Watch is view-only; no audio, no clipboard, never a token", () => {
  const base = "http://127.0.0.1:5555/abc123/";
  assert.equal(viewUrl(base, "watch"), "http://127.0.0.1:5555/abc123/viewer/#view_only=1&audio=none&clipboard=0");
  assert.equal(viewUrl(base, "together"), "http://127.0.0.1:5555/abc123/viewer/#audio=none&clipboard=0");
  assert.equal(viewUrl(base, "full"), "http://127.0.0.1:5555/abc123/viewer/#audio=none&clipboard=0");
  assert.doesNotMatch(viewUrl(base, "full"), /token|bearer/i);
});

async function fakeRelay() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push([req.method, req.url, req.headers.authorization]);
    res.end("ok");
  });
  srv.on("upgrade", (req, sock) => {
    seen.push(["WS", req.url, req.headers.authorization]);
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    sock.on("data", (b) => sock.write(b)); // echo
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  srv.unref();
  return { srv, seen, base: `http://127.0.0.1:${srv.address().port}` };
}

test("space proxy: loopback only, path secret required, relay token added, only the view prefix", async () => {
  const relay = await fakeRelay();
  const p = await startSpaceProxy({ relayBase: () => relay.base, token: () => "relay-token" });
  try {
    const u = new URL(p.base);
    assert.equal(u.hostname, "127.0.0.1");
    assert.match(u.pathname, /^\/[A-Za-z0-9_-]{20,}\/$/);
    const ok = await fetch(`${p.base}viewer/viewer.js?x=1`);
    assert.equal(ok.status, 200);
    assert.deepEqual(relay.seen.at(-1), ["GET", "/spaces/host/view/viewer/viewer.js?x=1", "Bearer relay-token"]);
    const post = await fetch(`${p.base}cua.env.v1.StreamService/OpenMedia`, { method: "POST", body: "x" });
    assert.equal(post.status, 200);
    assert.deepEqual(relay.seen.at(-1), ["POST", "/spaces/host/view/cua.env.v1.StreamService/OpenMedia", "Bearer relay-token"]);
    const n = relay.seen.length;
    assert.equal((await fetch(`http://127.0.0.1:${u.port}/viewer/viewer.js`)).status, 404, "no secret");
    assert.equal((await fetch(`http://127.0.0.1:${u.port}/wrong-secret-wrong-secret/viewer/`)).status, 404);
    assert.equal((await fetch(`${p.base}viewer/%2e%2e/%2e%2e/snapshot`)).status, 404, "no way out of the view prefix");
    assert.equal(relay.seen.length, n, "none of those reached the relay");
  } finally {
    p.close();
  }
});

test("space proxy: the media WebSocket goes through with the token and carries data both ways", async () => {
  const relay = await fakeRelay();
  const p = await startSpaceProxy({ relayBase: () => relay.base, token: () => "relay-token" });
  try {
    const u = new URL(p.base);
    const reply = await new Promise((resolve, reject) => {
      const s = net.connect(Number(u.port), "127.0.0.1", () =>
        s.write(`GET ${u.pathname}media?ticket=t1 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`)
      );
      let got = "";
      s.on("data", (b) => {
        got += b;
        if (got.includes("\r\n\r\n") && !got.includes("ping")) s.write("ping");
        if (got.includes("ping")) (s.destroy(), resolve(got));
      });
      s.on("error", reject);
    });
    assert.match(reply, /^HTTP\/1\.1 101/);
    assert.match(reply, /ping$/);
    assert.deepEqual(relay.seen.at(-1), ["WS", "/spaces/host/view/media?ticket=t1", "Bearer relay-token"]);
  } finally {
    p.close();
  }
});

test("notify when an agent takes the shared desktop: once per new holder, never for the user or a release", () => {
  const { takenBy } = require("../main/space-view-logic");
  const list = (holder, holderName) => ({ spaces: [{ id: "host", holder, holderName }] });
  assert.equal(takenBy(null, list("aurora", "Aurora")), "Aurora");
  assert.equal(takenBy("aurora", list("aurora", "Aurora")), null, "still the same holder");
  assert.equal(takenBy("aurora", list("pioneer", "Pioneer")), "Pioneer");
  assert.equal(takenBy("aurora", list("user", null)), null, "the user's own full control");
  assert.equal(takenBy("aurora", list(null, null)), null, "released");
  assert.equal(takenBy(null, { spaces: [] }), null);
  assert.equal(takenBy(null, list("scout", null)), "scout", "no display name: the profile");
});
