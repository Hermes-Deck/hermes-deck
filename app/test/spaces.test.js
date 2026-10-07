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
  // cua's viewer turns clipboard sync off only for clipboard=off; clipboard=0 merely hides its toolbar button while it
  // keeps polling ComputerService/GetClipboard once a second at Together and Full (seen in the phase 2 side test)
  assert.equal(viewUrl(base, "watch"), "http://127.0.0.1:5555/abc123/viewer/#view_only=1&audio=none&clipboard=off");
  assert.equal(viewUrl(base, "together"), "http://127.0.0.1:5555/abc123/viewer/#audio=none&clipboard=off");
  assert.equal(viewUrl(base, "full"), "http://127.0.0.1:5555/abc123/viewer/#audio=none&clipboard=off");
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
    const ok = await fetch(`${p.base}host/viewer/viewer.js?x=1`);
    assert.equal(ok.status, 200);
    assert.deepEqual(relay.seen.at(-1), ["GET", "/spaces/host/view/viewer/viewer.js?x=1", "Bearer relay-token"]);
    const post = await fetch(`${p.base}host/cua.env.v1.StreamService/OpenMedia`, { method: "POST", body: "x" });
    assert.equal(post.status, 200);
    assert.deepEqual(relay.seen.at(-1), ["POST", "/spaces/host/view/cua.env.v1.StreamService/OpenMedia", "Bearer relay-token"]);
    const n = relay.seen.length;
    assert.equal((await fetch(`http://127.0.0.1:${u.port}/host/viewer/viewer.js`)).status, 404, "no secret");
    assert.equal((await fetch(`http://127.0.0.1:${u.port}/wrong-secret-wrong-secret/host/viewer/`)).status, 404);
    assert.equal((await fetch(`${p.base}host/viewer/%2e%2e/%2e%2e/snapshot`)).status, 404, "no way out of the view prefix");
    assert.equal((await fetch(`${p.base}viewer.js`)).status, 404, "no space id: not a viewer path");
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
        s.write(`GET ${u.pathname}host/media?ticket=t1 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`)
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

// ---- agent spaces phase 2 (Task 9): agent pills, a desktop per agent, loopback when it runs on this computer -------

/** A fake upstream (the relay, or a cua-spacesd on loopback): records every request's method, url and headers. */
async function fakeUpstream() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.setHeader("set-cookie", "s=1");
    res.end("ok");
  });
  srv.on("upgrade", (req, sock) => {
    seen.push({ method: "WS", url: req.url, headers: req.headers });
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    sock.on("data", (b) => sock.write(b));
  });
  srv.on("connection", (c) => c.unref());
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  srv.unref();
  return { srv, seen, port: srv.address().port, base: `http://127.0.0.1:${srv.address().port}` };
}

/** Two upstreams and a proxy whose target sends "aurora" to the local one, everything else to the relay. */
async function twoWay({ level = () => "watch" } = {}) {
  const relay = await fakeUpstream();
  const box = await fakeUpstream();
  const p = await startSpaceProxy({
    relayBase: () => relay.base,
    token: () => "relay-token",
    target: (id) => (id === "aurora" ? { kind: "local", port: box.port, token: "box-token" } : { kind: "relay" }),
    level,
  });
  return { relay, box, p, u: new URL(p.base), calls: () => relay.seen.length + box.seen.length };
}

/** A raw HTTP request line on its own socket (fetch would refuse or normalize these): the status line it gets. */
function rawGet(port, path, extra = "") {
  return new Promise((resolve) => {
    const s = net.connect(Number(port), "127.0.0.1", () => s.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n${extra}\r\n`));
    let got = "";
    s.on("data", (b) => {
      got += b;
      if (got.includes("\r\n")) (s.destroy(), resolve(got.split("\r\n")[0]));
    });
    s.on("error", () => resolve(got.split("\r\n")[0]));
    s.on("close", () => resolve(got.split("\r\n")[0]));
  });
}
const WS = "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";
const code = (line) => line.split(" ")[1];

test("space proxy: a desktop on this computer is reached on loopback with its own token, others through the relay", async () => {
  const { relay, box, p, u, calls } = await twoWay();
  try {
    assert.equal((await fetch(`${p.base}aurora/viewer/viewer.js`)).status, 200);
    assert.equal(box.seen.at(-1).url, "/viewer/viewer.js", "local upstream sees the bare cua-spacesd path");
    assert.equal(box.seen.at(-1).headers.authorization, "Bearer box-token", "with the container token");
    assert.equal((await fetch(`${p.base}pioneer/viewer/viewer.js`)).status, 200);
    assert.equal(relay.seen.at(-1).url, "/spaces/pioneer/view/viewer/viewer.js", "relay sees its per-desktop view path");
    assert.equal(relay.seen.at(-1).headers.authorization, "Bearer relay-token", "with the relay token");
    const n = calls();
    assert.equal((await fetch(`${p.base}../x/viewer/`)).status, 404);
    assert.equal(code(await rawGet(u.port, `${u.pathname}../x/viewer/`)), "404", "raw, not normalized by fetch");
    assert.equal(calls(), n, "neither upstream is called");
  } finally {
    p.close();
  }
});

test("space proxy: CR, LF, space or tab in a decoded path never reaches either upstream (HTTP and WebSocket)", async () => {
  const { p, u, calls } = await twoWay();
  try {
    const n = calls();
    for (const id of ["aurora", "pioneer", "host"])
      for (const bad of ["%0d%0aX-Smuggle:%201", "viewer/%0d%0a", "viewer/a%20b", "viewer/a%09b", "media%0d%0aGET%20/files", "viewer//x", "viewer/%5cx", "viewer/%2e%2e/x", "%2fviewer", "viewer/%zz"]) {
        assert.equal(code(await rawGet(u.port, `${u.pathname}${id}/${bad}`)), "404", `HTTP ${id}/${bad}`);
        assert.equal(code(await rawGet(u.port, `${u.pathname}${id}/${bad}`, WS)), "404", `WS ${id}/${bad}`);
      }
    for (const id of ["%2e%2e", "a%20b", "..", "-x", "a%0d%0ab", "a%09b"]) {
      assert.equal(code(await rawGet(u.port, `${u.pathname}${id}/viewer/`)), "404", `space id ${id}`);
      assert.equal(code(await rawGet(u.port, `${u.pathname}${id}/media`, WS)), "404", `WS space id ${id}`);
    }
    assert.equal(calls(), n, "nothing reached an upstream");
  } finally {
    p.close();
  }
});

test("space proxy: upstream headers come from an allowlist: no client auth, cookie, origin or viewer ticket, to either upstream", async () => {
  const { relay, box, p, u } = await twoWay();
  const evil = { authorization: "Bearer evil", cookie: "deck=1", origin: "http://evil", "x-cua-env-authorization": "Bearer ticket", "proxy-authorization": "Basic x", "x-forwarded-for": "1.2.3.4", "content-type": "application/grpc-web+proto", "x-grpc-web": "1" };
  try {
    for (const id of ["aurora", "pioneer"]) {
      const r = await fetch(`${p.base}${id}/cua.env.v1.StreamService/OpenMedia`, { method: "POST", headers: evil, body: "x" });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("set-cookie"), null, "no cookie comes back to the viewer either");
      const h = (id === "aurora" ? box : relay).seen.at(-1).headers;
      assert.equal(h.authorization, id === "aurora" ? "Bearer box-token" : "Bearer relay-token");
      for (const k of ["cookie", "origin", "x-cua-env-authorization", "proxy-authorization", "x-forwarded-for"]) assert.equal(h[k], undefined, `${id}: ${k}`);
      assert.equal(h["content-type"], "application/grpc-web+proto", "the viewer's own call headers go through");
      assert.equal(h["x-grpc-web"], "1");
    }
    for (const [id, up] of [["aurora", box], ["pioneer", relay]]) {
      const ws = await rawGet(u.port, `${u.pathname}${id}/media?ticket=t1`, `${WS}Cookie: deck=1\r\nAuthorization: Bearer evil\r\nOrigin: http://evil\r\n`);
      assert.match(ws, /^HTTP\/1\.1 101/);
      const s = up.seen.at(-1);
      assert.deepEqual([s.method, s.url, s.headers.authorization, s.headers.cookie, s.headers.origin],
        ["WS", id === "aurora" ? "/media?ticket=t1" : "/spaces/pioneer/view/media?ticket=t1", id === "aurora" ? "Bearer box-token" : "Bearer relay-token", undefined, undefined]);
      assert.equal(s.headers["sec-websocket-key"], "dGhlIHNhbXBsZSBub25jZQ==");
    }
  } finally {
    p.close();
  }
});

test("space proxy, local desktop: the relay's allow list and level rules (input only above Watch; Watch = view only)", async () => {
  let lvl = "watch";
  const { box, p, u } = await twoWay({ level: (id) => (id === "aurora" ? lvl : "full") });
  try {
    const post = (path) => fetch(`${p.base}aurora/${path}`, { method: "POST", body: "x" }).then((r) => r.status);
    assert.equal(await post("cua.env.v1.StreamService/OpenMedia"), 200, "viewing is allowed at Watch");
    assert.equal(await post("cua.env.v1.SystemService/GetCapabilities"), 200);
    assert.equal(await post("cua.env.v1.ComputerService/Click"), 403, "no input at Watch");
    lvl = "together";
    assert.equal(await post("cua.env.v1.ComputerService/Click"), 200, "input above Watch");
    lvl = "full";
    assert.equal(await post("cua.env.v1.ComputerService/TypeText"), 200);
    const n = box.seen.length;
    for (const path of ["mcp", "cua.env.v1.FileService/Read", "cua.env.v1.ProcessService/Kill", "health", "cua.env.v1.ComputerService/Click/x", "cua.env.v1.TunnelService/Open"]) assert.equal(await post(path), 403, path);
    assert.equal(code(await rawGet(u.port, `${u.pathname}aurora/cua.env.v1.ComputerService/Click`, WS)), "403", "no WebSocket to input, at any level");
    lvl = "root";
    assert.equal(await post("cua.env.v1.ComputerService/Click"), 403, "an unknown level is Watch");
    assert.equal(box.seen.length, n, "none of those reached the desktop");
  } finally {
    p.close();
  }
});

test("space proxy: the Deck's local view rule is the relay's (relay/src/spaces.js viewPath), path for path", () => {
  const { viewRest } = require("../main/space-view-logic");
  const { viewPath } = require("../../relay/src/spaces");
  const cases = ["viewer", "viewer/", "viewer/viewer.js", "media", "media/x", "cua.env.v1.StreamService/OpenMedia", "cua.env.v1.PresenceService/Join", "cua.env.v1.SystemService/GetCapabilities",
    "cua.env.v1.SystemService/Reboot", "cua.env.v1.ComputerService/Click", "cua.env.v1.ComputerService/Click/x", "cua.env.v1.FileService/Read", "mcp", "health", "",
    "viewer/../x", "viewer//x", "/viewer", "viewer\\x", "viewer/a b", "viewer/a\tb", "viewer/a\r\nb", "viewers", "mediax", "viewer/é", "viewer/%"];
  for (const rest of cases)
    for (const input of [false, true]) {
      const relay = viewPath(`/spaces/aurora/view/${encodeURIComponent(rest).replace(/%2F/g, "/")}`, input);
      assert.equal(viewRest(rest, input), relay && relay.rest ? relay.rest : null, `${JSON.stringify(rest)} input=${input}`);
    }
});

test("pills: one per agent desktop with its state; the shared desktop only when it exists", () => {
  const { pills } = require("../main/space-view-logic");
  assert.deepEqual(pills({ spaces: [{ id: "host", kind: "shared" }, { id: "aurora", kind: "agent", state: "ready", holderName: "Aurora", host: "a1b2c3d4", hostName: "pc" }, { id: "pioneer", kind: "agent", state: "off" }] }),
    [{ id: "aurora", label: "Aurora", state: "ready", where: "pc" }, { id: "pioneer", label: "pioneer", state: "off", where: null }, { id: "host", label: null, state: "shared", where: null }]);
});

test("pills: profile host is never an agent pill; no shared pill without a shared desktop; fallen back reads shared", () => {
  const { pills } = require("../main/space-view-logic");
  assert.deepEqual(pills({ spaces: [{ id: "host", kind: "agent", state: "ready" }, { id: "host", kind: "shared", viewer: false }] }), []);
  assert.deepEqual(pills(null), []);
  const rows = [{ id: "scout", kind: "agent", state: "off", fallback: "offline" }, { id: "a", kind: "agent", state: "pulling" }, { id: "b", kind: "agent", state: "stopping" }, { id: "c", kind: "agent", state: "failed" }, { id: "d", kind: "agent", state: "ready", fallback: "limit" }, { id: "e", kind: "agent", state: "starting", fallback: "limit" }];
  const shared = { id: "host", kind: "shared" };
  assert.deepEqual(pills({ spaces: [shared, ...rows] }).map((p) => [p.id, p.state]), [["scout", "shared"], ["a", "starting"], ["b", "off"], ["c", "failed"], ["d", "ready"], ["e", "starting"], ["host", "shared"]]);
  assert.deepEqual(pills({ spaces: rows }).map((p) => [p.id, p.state]), [["scout", "none"], ["a", "starting"], ["b", "off"], ["c", "failed"], ["d", "ready"], ["e", "starting"]], "no shared desktop: a fallback means no desktop at all");
  assert.equal(pills({ spaces: [{ ...shared, viewer: false }, rows[0]] })[0].state, "none", "a shared entry without a viewer is no shared desktop");
});

test("overflow: pills show shared usage without inventing a fallback, then restore the desktop state", () => {
  const { pills, fallbackFor } = require("../main/space-view-logic");
  for (const state of ["off", "ready", "starting", "failed"]) {
    const row = { id: "aurora", kind: "agent", state, hostName: "pc", fallback: null };
    const before = { mode: "overflow", spaces: [row] };
    const during = { mode: "overflow", spaces: [{ ...row, usingShared: true }] };
    assert.equal(pills(during)[0].state, "shared");
    assert.equal(pills(during)[0].where, null);
    assert.deepEqual(fallbackFor(before, during), []);
    assert.equal(pills(before)[0].state, state);
  }
});

test("fell back: one notice per agent when its pill turns to shared, with the reason; none on the first look", () => {
  const { fallbackFor } = require("../main/space-view-logic");
  const L = (...a) => ({ mode: "agent", spaces: [{ id: "host", kind: "shared" }, ...a] });
  const off = { id: "aurora", kind: "agent", state: "off", holderName: "Aurora" };
  const fell = { ...off, fallback: "offline" };
  assert.deepEqual(fallbackFor(null, L(fell)), [], "the Deck just started: no notice for an old fallback");
  assert.deepEqual(fallbackFor(L(off), L(fell)), [{ who: "Aurora", reason: "offline", to: "shared" }]);
  assert.deepEqual(fallbackFor(L(fell), L(fell)), [], "still fallen back: not again");
  assert.deepEqual(fallbackFor(L(fell), L(off)), []);
  assert.deepEqual(fallbackFor(L({ ...off, state: "ready" }), L({ id: "aurora", kind: "agent", state: "failed", fallback: "failed" })), [{ who: "aurora", reason: "failed", to: "shared" }]);
  assert.deepEqual(fallbackFor(L(off), L({ ...off, fallback: "weird" })), [{ who: "Aurora", reason: "none", to: "shared" }], "an unknown reason reads as none");
  assert.deepEqual(fallbackFor(L(), L(fell)), [{ who: "Aurora", reason: "offline", to: "shared" }], "a new agent that is already on the shared desktop");
  // no shared desktop: the agent has no desktop at all, said once
  const N = (...a) => ({ mode: "agent", spaces: [...a] });
  assert.deepEqual(fallbackFor(N(off), N(fell)), [{ who: "Aurora", reason: "offline", to: "none" }]);
  assert.deepEqual(fallbackFor(N(fell), N(fell)), []);
});

// ---- main/spaces.js wiring (a fake view: no Electron in tests) ------------------------------------------------

const { initSpaces } = require("../main/spaces");
const RECT = { x: 0, y: 0, width: 400, height: 300 };

const ROWS = { mode: "agent", spaces: [{ id: "host", kind: "shared" }, { id: "aurora", kind: "agent", host: "a1b2c3d4", state: "ready" }, { id: "pioneer", kind: "agent", host: null, state: "off" }] };
function mainSpaces({ list = ROWS, ports = { aurora: 41000, pioneer: 41001 }, refuse = false, portDelay = 0 } = {}) {
  const handlers = {};
  const posts = [];
  const gets = [];
  const requests = [];
  const notes = [];
  const view = { space: "host", level: "watch", visible: false, shows: [] };
  const fakeView = {
    show: async (rect, space, level) => (view.shows.push(space), Object.assign(view, { space, level, visible: true })),
    hide: () => (view.visible = false),
    setLevel: async (l) => (view.level = l),
    current: () => ({ space: view.space, level: view.level, visible: view.visible }),
    destroy() {},
  };
  let made = null;
  const portCalls = { n: 0 };
  const S = { list };
  const out = initSpaces({
    ipc: { handle: (k, fn) => (handlers[k] = fn) },
    win: { on() {}, isDestroyed: () => false },
    relayCfg: () => ({ http: "http://127.0.0.1:9", token: "t" }),
    relayFetch: async (method, path, body, options) => {
      requests.push({ method, path, body, options });
      if (method === "GET") gets.push(path);
      else posts.push([path, body]);
      const b = method === "GET" ? S.list : refuse ? { ok: false, error: "no" } : { ok: true };
      return { ok: true, status: 200, json: async () => b };
    },
    deviceId: () => "a1b2c3d4",
    settings: { data: {} },
    notify: (k, p) => notes.push(p.body),
    desktops: {
      port: async (id) => {
        portCalls.n += 1;
        if (portDelay) await new Promise((r) => setTimeout(r, portDelay));
        return ports[id] || null;
      },
      token: (id) => (ports[id] ? "box-token" : null),
    },
    createView: (o) => ((made = o), fakeView),
    watchMs: 0,
  });
  const call = (k, ...a) => handlers[k]({}, ...a);
  return { out, call, posts, gets, requests, notes, view, S, portCalls, made: () => made };
}

test("main: the view shows the selected space; a desktop running on this computer is the loopback target, others the relay", async () => {
  const m = mainSpaces();
  await m.call("spaces:list"); // the relay's rows: aurora's desktop is on this device and ready
  await m.call("spaces:view", RECT, "watch", "aurora");
  assert.deepEqual(m.view.shows, ["aurora"]);
  assert.deepEqual(await m.made().target("aurora"), { kind: "local", port: 41000, token: "box-token" });
  assert.deepEqual(await m.made().target("pioneer"), { kind: "relay" }, "the relay does not place it here (a container may still run)");
  assert.deepEqual(await m.made().target("host"), { kind: "relay" }, "the shared desktop is always the relay's");
  await m.call("spaces:view", RECT, "watch");
  assert.equal(m.view.shows.at(-1), "host", "no space: the shared one (phase 1 callers)");
  await assert.rejects(m.call("spaces:view", RECT, "watch", "../x"), /bad space/);
  assert.equal(JSON.stringify(m.made()).includes("box-token"), false, "the view gets functions, never a token");
});

test("main: control acts on the given space; loopback input only after the relay accepted a level above Watch, for the shown space", async () => {
  const m = mainSpaces();
  await m.call("spaces:view", RECT, "together", "aurora");
  assert.equal(m.made().level("aurora"), "watch", "the view asks for Together, but the relay has not said yes");
  await m.call("spaces:control", "together", "aurora");
  assert.deepEqual(m.posts.at(-1), ["/spaces/control", { space: "aurora", level: "together" }]);
  assert.equal(m.made().level("aurora"), "together");
  assert.equal(m.made().level("pioneer"), "watch", "not the shown space");
  await m.call("spaces:view", RECT, "watch", "aurora");
  assert.equal(m.made().level("aurora"), "watch", "the view went back to Watch (the relay reset it): view only");
  await m.call("spaces:control", "full");
  assert.deepEqual(m.posts.at(-1), ["/spaces/control", { space: "host", level: "full" }], "no space: the shared one");
  await assert.rejects(m.call("spaces:control", "full", "a b"), /bad space/);
  const r = mainSpaces({ refuse: true });
  await r.call("spaces:view", RECT, "full", "aurora");
  await r.call("spaces:control", "full", "aurora");
  assert.equal(r.made().level("aurora"), "watch", "refused by the relay: still view only here");
});

test("main: the /spaces poll says which agent desktop this Deck shows on its own loopback, and only then", async () => {
  const m = mainSpaces();
  await m.call("spaces:list");
  assert.equal(m.gets.at(-1), "/spaces", "nothing shown");
  await m.call("spaces:view", RECT, "watch", "aurora");
  await m.made().target("aurora");
  await m.call("spaces:list");
  assert.equal(m.gets.at(-1), "/spaces?watching=aurora");
  await m.call("spaces:view", RECT, "watch", "pioneer");
  await m.made().target("pioneer");
  await m.call("spaces:list");
  assert.equal(m.gets.at(-1), "/spaces", "through the relay: its view socket counts there already");
  await m.call("spaces:view", RECT, "watch", "aurora");
  await m.call("spaces:view", null);
  await m.call("spaces:list");
  assert.equal(m.gets.at(-1), "/spaces", "hidden: not watched");
  m.S.list = { mode: "agent", spaces: [{ id: "host", kind: "shared" }, { id: "aurora", kind: "agent", state: "ready", holderName: "Aurora" }] };
  assert.deepEqual((await m.call("spaces:list")).pills.map((x) => x.id), ["aurora", "host"], "the panel's pills come with the list");
});

test("main: loopback only where the relay places the desktop now (this device, ready); one Docker listing per miss", async () => {
  // a container for aurora runs here, but the relay (restarted, or after a fallback) started it on the agent host
  const m = mainSpaces({ list: { mode: "agent", spaces: [{ id: "aurora", kind: "agent", host: "agent-host", state: "ready" }] }, portDelay: 20 });
  await m.call("spaces:list");
  await m.call("spaces:view", RECT, "watch", "aurora");
  assert.deepEqual(await m.made().target("aurora"), { kind: "relay" });
  await m.call("spaces:list");
  assert.equal(m.gets.at(-1), "/spaces", "not watched on loopback either");
  m.S.list = { mode: "agent", spaces: [{ id: "aurora", kind: "agent", host: "a1b2c3d4", state: "starting" }] };
  await m.call("spaces:list");
  assert.deepEqual(await m.made().target("aurora"), { kind: "relay" }, "here but not ready yet");
  assert.equal(m.portCalls.n, 0, "no Docker listing while the relay does not place it here");
  m.S.list = { mode: "agent", spaces: [{ id: "aurora", kind: "agent", host: "a1b2c3d4", state: "ready" }] };
  await m.call("spaces:list");
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => m.made().target("aurora")));
  for (const t of all) assert.deepEqual(t, { kind: "local", port: 41000, token: "box-token" });
  assert.equal(m.portCalls.n, 1, "concurrent misses share one listing");
  await m.call("spaces:list");
  assert.equal(m.gets.at(-1), "/spaces?watching=aurora");
  m.S.list = { mode: "agent", spaces: [{ id: "aurora", kind: "agent", host: "agent-host", state: "ready" }] };
  await m.call("spaces:list");
  assert.deepEqual(await m.made().target("aurora"), { kind: "relay" }, "moved away: the cached loopback answer is not used");
  await m.call("spaces:list");
  assert.equal(m.gets.at(-1), "/spaces");
});

test("overflow: main accepts mode and supplies shared and own desktop pills", async () => {
  const m = mainSpaces({ list: { ...ROWS, mode: "overflow" } });
  await m.call("spaces:mode", "overflow");
  assert.deepEqual(m.posts.at(-1), ["/spaces/mode", { mode: "overflow" }]);
  const list = await m.call("spaces:list");
  assert.deepEqual(list.pills.map((p) => p.id), ["aurora", "pioneer", "host"]);
});

test("main: home host and Start/Stop go to the relay, validated", async () => {
  const m = mainSpaces();
  await m.call("spaces:home", "aurora", "a1b2c3d4");
  assert.deepEqual(m.posts.at(-1), ["/spaces/home", { profile: "aurora", host: "a1b2c3d4" }]);
  await m.call("spaces:home", "aurora", "auto");
  await m.call("spaces:home", "aurora", "agent-host");
  assert.equal(m.posts.length, 3);
  await assert.rejects(m.call("spaces:home", "host", "auto"), /bad profile/, "host is the shared space, never an agent");
  await assert.rejects(m.call("spaces:home", "aurora", "evil host"), /bad host/);
  await m.call("spaces:desktop", "aurora", "start");
  assert.deepEqual(m.posts.at(-1), ["/spaces/desktop", { profile: "aurora", action: "start" }]);
  await m.call("spaces:desktop", "aurora", "stop");
  await assert.rejects(m.call("spaces:desktop", "aurora", "reset"), /bad action/);
  await assert.rejects(m.call("spaces:desktop", "../x", "start"), /bad profile/);
  assert.equal(m.posts.length, 5);
});

test("main: a fell-back notice once per transition, with its reason; the shared desktop's taken notice still works", async () => {
  const off = { id: "aurora", kind: "agent", state: "off", holderName: "Aurora" };
  const m = mainSpaces({ list: { mode: "agent", spaces: [{ id: "host", kind: "shared", holder: null }, off] } });
  await m.out._test.tick();
  assert.deepEqual(m.notes, []);
  m.S.list = { mode: "agent", spaces: [{ id: "host", kind: "shared", holder: "aurora", holderName: "Aurora" }, { ...off, fallback: "limit" }] };
  await m.out._test.tick();
  await m.out._test.tick();
  assert.deepEqual(m.notes, ["Aurora is working on the shared desktop", "Aurora is on the shared desktop: its desktop host has no room for another desktop"]);
  const n = mainSpaces({ list: { mode: "agent", spaces: [off] } });
  await n.out._test.tick();
  n.S.list = { mode: "agent", spaces: [{ ...off, fallback: "offline" }] };
  await n.out._test.tick();
  assert.deepEqual(n.notes, ["Aurora has no desktop: its desktop host is offline"], "no shared desktop to fall back to");
});

// ---- renderer/space-panel.js in a tiny fake DOM: pills drive the view, the controls and Start / Stop ----------

function panelHarness(list, safety = {}) {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const i18n = require("../renderer/i18n");
  let activeElement = null, modal = null;
  const mk = (tag) => {
    const e = {
      tag, attrs: {}, children: [], hidden: false, disabled: false, textContent: "", title: "", listeners: {}, isConnected: true, className: "", scrollTop: 0,
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === "hidden") this.hidden = true; if (k === "disabled") this.disabled = true; },
      focus() { if (modal && !modal.contains(this)) return; if (activeElement) activeElement.focused = false; activeElement = this; this.focused = true; },
      scrollIntoView() {},
      showModal() { this.open = true; modal = this; },
      close() { this.open = false; if (modal === this) modal = null; for (const fn of this.listeners.close || []) fn(); },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); this.parentNode = null; },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      replaceChildren(...k) { this._text = ""; for (const c of [...this.children]) if (typeof c === "object") c.remove(); this.children = []; this.append(...k.flat().filter((x) => x !== null && x !== undefined && x !== false)); },
      append(...k) { for (const c of k) { if (c && typeof c === "object") { c.remove(); c.parentNode = this; } this.children.push(c); } },
      insertBefore(child, anchor) { child.remove(); child.parentNode = this; this.children.splice(anchor ? this.children.indexOf(anchor) : this.children.length, 0, child); },
      get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; },
      addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
      click() { for (const fn of this.listeners.click || []) fn({ target: this }); },
      contains(n) { return n === this || this.children.some((c) => typeof c === "object" && c.contains(n)); },
      querySelector(selector) {
        for (const child of this.children.filter((c) => c && typeof c === "object")) {
          if (selector.startsWith(".") ? child.classList.contains(selector.slice(1)) : child.tag === selector) return child;
          const found = child.querySelector(selector); if (found) return found;
        }
        return null;
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 }),
      get text() { return this.textContent + this.children.map((c) => (typeof c === "object" ? c.text : String(c))).join(""); },
    };
    Object.defineProperty(e, "textContent", { get() { return this._text || ""; }, set(value) { this._text = String(value); this.children = []; } });
    e.classList = { toggle: (c, on) => { const s = new Set(e.className.split(" ").filter(Boolean)); if (on) s.add(c); else s.delete(c); e.className = [...s].join(" "); }, contains: (c) => e.className.split(" ").includes(c) };
    return e;
  };
  const h = (tag, attrs, ...kids) => {
    const e = mk(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    e.append(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false));
    return e;
  };
  const calls = { view: [], control: [], desktop: [] };
  const S = { list };
  const deck = {
    spaces: {
      list: async () => S.list,
      view: async (r, level, space) => void calls.view.push([r ? "shown" : null, level, space]),
      control: async (level, space) => {
        calls.control.push([level, space]);
        const st = S.list.spaces.find((x) => x.id === (space || "host"));
        if (st) st.level = level === "release" ? "watch" : level; // as the relay keeps it
        return { ok: true };
      },
      desktop: async (id, action) => (calls.desktop.push([id, action]), { ok: true }),
      route: async () => ({ ok: true }),
      ...safety,
    },
  };
  const frames = [], intervals = [], events = {};
  const sandbox = {
    window: { innerHeight: 800 },
    document: { hidden: false, createElementNS: (_n, t) => mk(t), addEventListener(t, fn) { (events[t] ||= []).push(fn); }, elementFromPoint: () => null, querySelector: () => null },
    i18nText: (k, v) => i18n.t(k, v),
    i18nLocale: () => i18n.getLocale(),
    requestAnimationFrame: (fn) => frames.push(fn),
    setInterval: (fn) => intervals.push(fn),
    console,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "renderer", "space-panel.js"), "utf8"), sandbox);
  const panel = sandbox.window.DeckSpacePanel({ h, deck, agents: () => [{ profile: "aurora", name: "Aurora" }, { profile: "pioneer" }] });
  const frame = () => { const f = frames.splice(0); for (const fn of f) fn(); };
  const pillsRow = () => panel.root.children.find((c) => c.className === "sp-pills");
  const find = (pred, n = panel.root) => (pred(n) ? n : n.children.filter((c) => typeof c === "object").map((c) => find(pred, c)).find(Boolean) || null);
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  return { panel, calls, S, frame, pillsRow, find, flush, events, intervals, document: sandbox.document };
}

const agentList = (o = {}) => ({
  mode: "agent",
  defaultLevel: "watch",
  hosts: [{ id: "a1b2c3d4", name: "pc", ready: true, limit: 3, running: 1 }],
  spaces: [
    { id: "host", kind: "shared", viewer: true, online: true, holder: null, queue: [], level: "watch" },
    { id: "aurora", kind: "agent", state: "ready", online: true, host: "a1b2c3d4", hostName: "pc", holderName: "Aurora", level: "watch" },
    { id: "pioneer", kind: "agent", state: "off", online: false, host: null, hostName: null, holderName: "pioneer", level: "watch", fallback: "offline" },
  ],
  pills: [{ id: "aurora", label: "Aurora", state: "ready", where: "pc" }, { id: "pioneer", label: "pioneer", state: "shared", where: null }, { id: "host", label: null, state: "shared", where: null }],
  ...o,
});

test("overflow: panel shows shared and own pills plus no-host hint", async () => {
  const t = panelHarness(agentList({ mode: "overflow", hosts: [] }));
  await t.flush();
  assert.equal(t.pillsRow().hidden, false);
  assert.deepEqual(t.pillsRow().children.map((b) => b.text), ["Aurora", "pioneer", "Shared desktop"]);
  assert.equal(t.find((n) => n.className === "sp-hint").hidden, false);
  t.panel.kick();
  t.frame();
  assert.deepEqual(t.calls.view.at(-1), ["shown", "watch", "aurora"]);
  t.pillsRow().children[2].click();
  t.frame();
  assert.deepEqual(t.calls.view.at(-1), ["shown", "watch", "host"]);
});

test("overflow: shared pill keeps own-desktop controls and has no false failure explanation", async () => {
  const { pills } = require("../main/space-view-logic");
  const list = agentList({ mode: "overflow" });
  list.spaces[1].usingShared = true;
  list.pills = pills(list);
  const t = panelHarness(list);
  await t.flush();
  assert.equal(t.pillsRow().children[0].attrs.title, "Aurora · On the shared desktop");
  assert.equal(t.find((n) => n.className === "sp-note sp-fell").hidden, true);
  const [start, stop] = t.find((n) => n.className === "sp-route").children;
  assert.deepEqual([start.hidden, stop.hidden], [true, false]);
});

test("panel: one pill per agent plus the shared desktop; the first agent is shown, with its badge and where it runs", async () => {
  const t = panelHarness(agentList());
  await t.flush();
  assert.equal(t.panel.root.hidden, false);
  const pills = t.pillsRow().children;
  assert.deepEqual(pills.map((b) => b.text), ["Aurora", "pioneer", "Shared desktop"]);
  assert.deepEqual(pills.map((b) => b.attrs["aria-pressed"]), ["true", "false", "false"]);
  assert.deepEqual(pills.map((b) => b.children[0].className), ["sp-pdot ready", "sp-pdot shared", "sp-pdot shared"]);
  const badge = t.find((n) => n.className.split(" ").includes("sp-badge"));
  assert.equal(badge.hidden, false);
  assert.match(badge.text, /^Aurora · on pc$/);
  t.panel.kick();
  t.frame();
  assert.deepEqual(t.calls.view.at(-1), ["shown", "watch", "aurora"], "the viewer shows the selected agent's desktop");
  assert.equal(t.find((n) => n.className === "sp-hint").hidden, true, "a desktop host exists: no hint");
});

test("panel: selecting a pill shows that desktop; level and Start act on it; a fallen-back agent says why", async () => {
  const t = panelHarness(agentList());
  await t.flush();
  t.panel.kick();
  t.frame();
  t.pillsRow().children[1].click(); // pioneer: off, fallen back
  t.frame();
  assert.equal(t.pillsRow().children[1].attrs["aria-pressed"], "true");
  assert.deepEqual(t.calls.view.at(-1), [null, "watch", "pioneer"], "not running: the stage is not covered");
  const fell = t.find((n) => n.className === "sp-note sp-fell");
  assert.equal(fell.hidden, false);
  assert.equal(fell.textContent, "pioneer is on the shared desktop: its desktop host is offline");
  const [start, stop] = t.find((n) => n.className === "sp-route").children;
  assert.deepEqual([start.hidden, stop.hidden], [false, true], "Start for a desktop that is not running");
  start.click();
  await t.flush();
  assert.deepEqual(t.calls.desktop, [["pioneer", "start"]]);
  t.pillsRow().children[0].click(); // back to Aurora, running
  const [start2, stop2] = t.find((n) => n.className === "sp-route").children;
  assert.deepEqual([start2.hidden, stop2.hidden], [true, false]);
  const levels = t.find((n) => n.className === "chan sp-levels");
  levels.children[1].click(); // Together
  await t.flush();
  assert.deepEqual(t.calls.control.at(-1), ["together", "aurora"], "the level acts on the selected desktop");
  t.frame();
  assert.deepEqual(t.calls.view.at(-1), ["shown", "together", "aurora"]);
  t.pillsRow().children[2].click(); // the shared desktop
  t.frame();
  assert.deepEqual(t.calls.view.at(-1), ["shown", "watch", "host"], "each desktop keeps its own level");
});

test("panel: agent mode with no desktop host shows the hint; shared mode shows no pills (phase 1 unchanged)", async () => {
  const t = panelHarness(agentList({ hosts: [] }));
  await t.flush();
  const hint = t.find((n) => n.className === "sp-hint");
  assert.equal(hint.hidden, false);
  assert.match(hint.textContent, /No computer hosts agent desktops yet/);
  const s = panelHarness({ mode: "shared", defaultLevel: "watch", spaces: [{ id: "host", kind: "shared", viewer: true, online: true, holder: "aurora", holderName: "Aurora", queue: [], level: "watch" }], pills: [{ id: "host", label: null, state: "shared", where: null }] });
  await s.flush();
  assert.equal(s.pillsRow().hidden, true);
  s.panel.kick();
  s.frame();
  assert.deepEqual(s.calls.view.at(-1), ["shown", "watch", "host"]);
  assert.match(s.find((n) => n.className.split(" ").includes("sp-badge")).text, /^Aurora$/);
  const [start, stop] = s.find((n) => n.className === "sp-route").children;
  assert.deepEqual([start.hidden, stop.hidden], [true, true], "no Start / Stop for the shared desktop");
});

test("panel: a default of Full is never sent to an agent desktop by itself: capped at Together, and only once its stage is shown", async () => {
  const t = panelHarness(agentList({ defaultLevel: "full" }));
  await t.flush();
  await t.panel.refresh();
  await t.flush();
  assert.deepEqual(t.calls.control, [], "Deck start and refreshes: nothing sent to an agent desktop");
  t.panel.kick();
  t.frame();
  await t.flush();
  assert.deepEqual(t.calls.control, [["together", "aurora"]], "shown: the default, capped at Together");
  assert.deepEqual(t.calls.view.at(-1), ["shown", "together", "aurora"]);
  t.frame();
  await t.panel.refresh();
  t.frame();
  await t.flush();
  assert.deepEqual(t.calls.control, [["together", "aurora"]], "once");
  t.pillsRow().children[1].click(); // pioneer: not running, its stage is not shown
  t.frame();
  await t.flush();
  assert.deepEqual(t.calls.control, [["together", "aurora"]], "not shown: nothing sent");
  const s = panelHarness({ mode: "shared", defaultLevel: "full", spaces: [{ id: "host", kind: "shared", viewer: true, online: true, holder: null, queue: [], level: "watch" }], pills: [{ id: "host", label: null, state: "shared", where: null }] });
  await s.flush();
  assert.deepEqual(s.calls.control, [["full", "host"]], "the shared desktop: phase 1 unchanged");
});

test("panel: without a shared desktop a fallen-back agent reads as having no desktop", async () => {
  const l = agentList();
  l.spaces = l.spaces.filter((x) => x.id !== "host");
  l.pills = [{ id: "aurora", label: "Aurora", state: "ready", where: "pc" }, { id: "pioneer", label: "pioneer", state: "none", where: null }];
  const t = panelHarness(l);
  await t.flush();
  t.pillsRow().children[1].click();
  assert.equal(t.pillsRow().children[1].children[0].className, "sp-pdot none");
  assert.match(t.pillsRow().children[1].attrs.title, /No desktop/);
  const fell = t.find((n) => n.className === "sp-note sp-fell");
  assert.equal(fell.textContent, "pioneer has no desktop: its desktop host is offline");
});

test("strings: the no-desktop-host hint names the real switch; no unused space keys", () => {
  const i18n = require("../renderer/i18n");
  assert.match(i18n.tables.en["space.noHost"], /'Host agent desktops on this device'/);
  assert.match(i18n.tables.en["space.noHost"], /set it up on the agent host/);
  assert.match(i18n.tables.tr["space.noHost"], /'Bu cihazda ajan masaüstlerini barındır'/);
  assert.equal(i18n.tables.en["desktops.host"], "Host agent desktops on this device");
  assert.equal("space.noAgents" in i18n.tables.en, false);
  assert.equal("space.noAgents" in i18n.tables.tr, false);
  assert.equal(i18n.tables.en["space.pill.none"], "No desktop");
  assert.equal(i18n.tables.tr["space.pill.none"], "Masaüstü yok");
  assert.equal(i18n.tables.tr["space.noDesktop"], "{who} için masaüstü yok: {reason}");
});

// ---- final fix wave: T5 no clipboard paths; M10 accepted levels follow the relay; M3 the Deck proxy aborts ---------

test("T5 view rule: ComputerService/GetClipboard and SetClipboard are never reachable, at any level, on both mirrors", () => {
  const { viewRest } = require("../main/space-view-logic");
  const { viewPath } = require("../../relay/src/spaces");
  for (const rest of ["cua.env.v1.ComputerService/GetClipboard", "cua.env.v1.ComputerService/SetClipboard"])
    for (const input of [false, true]) {
      assert.equal(viewRest(rest, input), null, `${rest} input=${input}`);
      assert.equal(viewPath(`/spaces/aurora/view/${rest}`, input).rest, "", `relay: ${rest} input=${input}`);
    }
  assert.equal(viewRest("cua.env.v1.ComputerService/Click", true), "cua.env.v1.ComputerService/Click", "other input stays");
  assert.equal(viewRest("cua.env.v1.ComputerService/GetClipboardX", true), "cua.env.v1.ComputerService/GetClipboardX", "only those two names");
});

test("M10 main: the loopback proxy follows a level the relay lowered (each /spaces row's level updates what was accepted)", async () => {
  const m = mainSpaces();
  await m.call("spaces:view", RECT, "full", "aurora");
  await m.call("spaces:control", "full", "aurora");
  assert.equal(m.made().level("aurora"), "full");
  // the relay ended Full by its view-loss rule (or another Deck lowered it): the next poll says watch
  m.S.list = { mode: "agent", spaces: [{ id: "host", kind: "shared" }, { id: "aurora", kind: "agent", host: "a1b2c3d4", state: "ready", level: "watch" }] };
  await m.call("spaces:list");
  assert.equal(m.made().level("aurora"), "watch", "no input on loopback any more");
  m.S.list = { mode: "agent", spaces: [{ id: "host", kind: "shared" }, { id: "aurora", kind: "agent", host: "a1b2c3d4", state: "ready", level: "together" }] };
  await m.call("spaces:list");
  assert.equal(m.made().level("aurora"), "together", "the view is at Full; the relay's Together is what applies");
  m.S.list = { mode: "agent", spaces: [{ id: "aurora", kind: "agent", host: "a1b2c3d4", state: "ready", level: "root" }] };
  await m.call("spaces:list");
  assert.equal(m.made().level("aurora"), "together", "a level that is not one is ignored");
});

test("M3 Deck space proxy: the viewer leaving aborts the upstream request (a held stream through the relay)", { timeout: 5000 }, async () => {
  let gone;
  const closed = new Promise((r) => (gone = r));
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/connect+proto" });
    res.write("x");
    req.socket.on("close", () => gone());
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  srv.unref();
  const p = await startSpaceProxy({ relayBase: () => `http://127.0.0.1:${srv.address().port}`, token: () => "relay-token" });
  try {
    const u = new URL(`${p.base}host/cua.env.v1.PresenceService/Join`);
    await new Promise((resolve, reject) => {
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", agent: false }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => {});
      req.setTimeout(3000, () => reject(new Error("no head")));
      req.end();
    });
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("the upstream request stayed open after the viewer left")), 1500))]);
  } finally {
    p.close();
    srv.closeAllConnections();
    srv.close();
  }
});

test("safety IPC routes typed requests and rejects unsafe IDs", async () => {
  const m = mainSpaces();
  await m.call("spaces:safety", { typedText: false });
  assert.deepEqual(m.posts.at(-1), ["/spaces/settings", { typedText: false }]);
  await m.call("spaces:answer", "11111111-1111-4111-8111-111111111111", "once", true);
  assert.deepEqual(m.posts.at(-1)[1], { choice: "once", withoutSnapshot: true });
  await assert.rejects(m.call("spaces:restore", "../x", "bad"), /bad/);
  await assert.rejects(m.call("spaces:answer", "bad", "always"), /bad/);
  await assert.rejects(m.call("spaces:restore", "aurora", ["11111111-1111-4111-8111-111111111111"]), /bad ID/);
  await assert.rejects(m.call("spaces:audit", "aurora", "", "50&before=bad"), /bad limit/);
});
test("approval notification is once per pending ID and opens its exact card", async () => {
  const notices = [], events = [];
  const id = "11111111-1111-4111-8111-111111111111";
  const main = initSpaces({ ipc: { handle() {} }, win: { on() {}, isDestroyed: () => false, show() {}, focus() {} },
    relayCfg: () => ({}), relayFetch: async (_method, route) => ({ ok: true, json: async () =>
      route === "/spaces/approvals" ? { approvals: [{ id, profile: "agent1" }] } : route === "/spaces/settings" ? { settings: { snapshotKeep: 10 } } : { spaces: [] } }),
    deviceId: () => "a1b2c3d4", settings: { data: {} }, notify: (_kind, value) => notices.push(value), send: (_kind, value) => events.push(value), watchMs: 0 });
  await main._test.tick(); await main._test.tick();
  assert.equal(notices.length, 1);
  notices[0].onClick();
  assert.deepEqual(events.at(-1), { t: "open-screen", profile: "agent1", approval: id });
  assert.doesNotMatch(notices[0].body, /sudo/);
});

test("delayed polls cannot clear approval deduplication or overwrite newer policy", async () => {
  const notices = [], policies = [];
  let release, calls = 0;
  const delayed = new Promise((resolve) => { release = resolve; });
  const main = initSpaces({ ipc: { handle() {} }, win: { on() {} }, relayCfg: () => ({}),
    relayFetch: async (_method, route) => {
      if (route === "/spaces") return { ok: true, json: async () => ({ spaces: [] }) };
      if (route === "/spaces/settings") return { ok: true, json: async () => ({ settings: { snapshotKeep: calls === 1 ? 3 : 12 } }) };
      const first = ++calls === 1;
      return { ok: true, json: async () => first ? delayed : { approvals: [{ id: "pending", profile: "agent1" }] } };
    }, deviceId: () => "a1b2c3d4", settings: { data: {} },
    desktops: { safetyPolicy: (s) => policies.push(s.snapshotKeep) }, notify: (_kind, n) => notices.push(n), watchMs: 0 });
  const first = main._test.tick();
  await new Promise(setImmediate);
  await main._test.tick();
  release({ approvals: [] });
  await first;
  await main._test.tick();
  await main._test.tick();
  assert.equal(notices.length, 1, "a delayed empty response must not cause a repeated notification");
  assert.deepEqual(policies, [3, 12, 12], "only sequential polls apply retention policy");
});

test("delayed poll settings cannot overwrite a newer applied safety IPC response", async () => {
  const handlers = {}, policies = [];
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const main = initSpaces({ ipc: { handle: (k, fn) => { handlers[k] = fn; } }, win: { on() {} }, relayCfg: () => ({}),
    relayFetch: async (method, route) => ({ ok: true, json: async () => route === "/spaces/settings"
      ? method === "GET" ? delayed : { settings: { snapshotKeep: 12 } }
      : route === "/spaces/approvals" ? { approvals: [] } : { spaces: [] } }),
    deviceId: () => "a1b2c3d4", settings: { data: {} }, desktops: { safetyPolicy: (s) => policies.push(s.snapshotKeep) }, watchMs: 0 });
  const poll = main._test.tick();
  await new Promise(setImmediate);
  await handlers["spaces:safety"]({}, { snapshotKeep: 12 });
  release({ settings: { snapshotKeep: 3 } });
  await poll;
  assert.deepEqual(policies, [12]);
});

test("failed approvals keep the poll guarded until delayed settings settle", async () => {
  let release, lists = 0;
  const delayed = new Promise((resolve) => { release = resolve; });
  const main = initSpaces({ ipc: { handle() {} }, win: { on() {} }, relayCfg: () => ({}),
    relayFetch: async (_method, route) => {
      if (route === "/spaces/approvals") throw new Error("offline");
      if (route === "/spaces") lists++;
      return { ok: true, json: async () => route === "/spaces/settings" ? delayed : { spaces: [] } };
    }, deviceId: () => "a1b2c3d4", settings: { data: {} }, watchMs: 0 });
  const poll = main._test.tick();
  await new Promise(setImmediate);
  const overlap = main._test.tick();
  await new Promise(setImmediate);
  release({ settings: { snapshotKeep: 12 } });
  await Promise.all([poll, overlap]);
  assert.equal(lists, 1);
  await main._test.tick();
  assert.equal(lists, 2);
});

test("poll guard is released after unsuccessful responses and thrown errors", async () => {
  const policies = [];
  let attempt = 0;
  const main = initSpaces({ ipc: { handle() {} }, win: { on() {} }, relayCfg: () => ({}),
    relayFetch: async (_method, route) => {
      if (route === "/spaces") {
        if (++attempt === 1) return { ok: false };
        if (attempt === 2) throw new Error("offline");
      }
      return { ok: true, json: async () => route === "/spaces/settings" ? { settings: { snapshotKeep: 12 } } : { spaces: [] } };
    }, deviceId: () => "a1b2c3d4", settings: { data: {} }, desktops: { safetyPolicy: (s) => policies.push(s.snapshotKeep) }, watchMs: 0 });
  await main._test.tick();
  await main._test.tick();
  await main._test.tick();
  assert.deepEqual(policies, [12]);
});

test("safety IPC uses bounded archive waits and clears viewer input before restore", async () => {
  const m = mainSpaces();
  const id = "11111111-1111-4111-8111-111111111111";
  await m.call("spaces:audit", "aurora", "cursor&limit=99", 10);
  assert.equal(m.gets.at(-1), "/spaces/aurora/audit?before=cursor%26limit%3D99&limit=10");
  await m.call("spaces:safety");
  assert.equal(m.gets.at(-1), "/spaces/settings");
  assert.equal(m.requests.at(-1).options.timeoutMs, 8000);
  await m.call("spaces:approvals");
  assert.equal(m.gets.at(-1), "/spaces/approvals");
  for (const [channel, args, timeout] of [
    ["spaces:answer", [id, "once", false], 330_000],
    ["spaces:snapshots", ["aurora"], 330_000],
    ["spaces:deleteSnapshots", ["aurora"], 330_000],
    ["spaces:desktop", ["aurora", "stop"], 330_000],
    ["spaces:desktop", ["aurora", "start"], 8000],
  ]) {
    await m.call(channel, ...args);
    assert.equal(m.requests.at(-1).options.timeoutMs, timeout, channel);
  }
  await m.call("spaces:list");
  await m.call("spaces:view", RECT, "full", "aurora");
  await m.call("spaces:control", "full", "aurora");
  await m.out._test.target("aurora");
  await m.call("spaces:restore", "aurora", id);
  assert.equal(m.view.visible, false);
  assert.deepEqual(m.posts.at(-1), ["/spaces/aurora/restore", { id }]);
  assert.equal(m.requests.at(-1).options.timeoutMs, 930_000);
  await m.call("spaces:view", RECT, "full", "aurora");
  assert.equal(m.out._test.levelFor("aurora"), "watch");
  await m.out._test.target("aurora");
  assert.equal(m.portCalls.n, 2, "restore invalidated the cached local target");
});

test("safety policy synchronizes when desktop notifications are disabled", async () => {
  const policies = [];
  const main = initSpaces({ ipc: { handle() {} }, win: { on() {} }, relayCfg: () => ({}),
    relayFetch: async (_method, route) => ({ ok: true, json: async () => route === "/spaces/settings"
      ? { settings: { snapshotKeep: 12 } } : route === "/spaces/approvals" ? { approvals: [] } : { spaces: [] } }),
    deviceId: () => "a1b2c3d4", settings: { data: {} }, desktops: { safetyPolicy: (s) => policies.push(s) }, watchMs: 0 });
  await main._test.tick();
  assert.deepEqual(policies, [{ snapshotKeep: 12 }]);
});

test("audit frame IPC only returns bounded supported images", async () => {
  const handlers = {};
  let mime = "image/png", ok = true, bytes = Buffer.from("image");
  initSpaces({ ipc: { handle: (k, fn) => (handlers[k] = fn) }, win: { on() {} }, relayCfg: () => ({}),
    relayFetch: async () => ({ ok, headers: { get: () => mime }, arrayBuffer: async () => bytes }),
    deviceId: () => "a1b2c3d4", settings: { data: {} }, watchMs: 0 });
  const frame = (p = "agent1", id = "11111111-1111-4111-8111-111111111111") => handlers["spaces:frame"]({}, p, id);
  assert.equal(await frame(), "data:image/png;base64,aW1hZ2U=");
  mime = "text/html";
  assert.equal(await frame(), null);
  mime = "image/png"; ok = false;
  assert.equal(await frame(), null);
  await assert.rejects(frame("host"), /bad profile/);
  await assert.rejects(frame("agent1", "../id"), /bad ID/);
});

const safetyList = () => agentList({
  spaces: [{ id: "agent1", kind: "agent", state: "ready", online: true, level: "watch" }],
  pills: [{ id: "agent1", label: "Agent 1", state: "ready" }],
});
test("approval card has full text and countdown, takes focus, Enter does not approve", async () => {
  const answers = [];
  const card = { id: "11111111-1111-4111-8111-111111111111", profile: "agent1", command: "sudo whoami", text: "do whoami", state: "pending", expires: Date.now() + 600_000 };
  const t = panelHarness(safetyList(), { approvals: async () => ({ approvals: [card] }), answer: async (...a) => (answers.push(a), { ok: true }) });
  await t.flush();
  const c = t.find((n) => n.className === "sp-approval");
  assert.match(c.text, /sudo whoami/); assert.ok(c.focused);
  const approve = t.find((n) => n.attrs["data-action"] === "approve");
  let prevented = false;
  for (const fn of c.listeners.keydown || []) fn({ key: "Enter", preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true); assert.equal(answers.length, 0);
  approve.click(); await t.flush();
  assert.deepEqual(answers[0], [card.id, "once", false]);
  assert.match(t.pillsRow().text, /1 approval/);
});
test("drawer pages, shows thumbnails and undo rows, confirms restore", async () => {
  const reads = [], restored = [];
  const id = "11111111-1111-4111-8111-111111111111";
  const t = panelHarness(safetyList(), {
    approvals: async () => ({ approvals: [] }),
    audit: async (_p, before) => { reads.push(before); return { records: before ? [] : [{ id: "r1", time: 5, tool: "click", summary: { x: 1 }, outcome: "ok", frame: id }], next: before ? null : "next" }; },
    frame: async () => "data:image/png;base64,YQ==",
    snapshots: async () => ({ points: [{ id, time: 6, reason: "stop", size: 20, consistent: true }] }),
    restore: async (...args) => (restored.push(args), { ok: true }),
  });
  await t.flush();
  const drawer = t.find((n) => n.className === "sp-activity");
  drawer.open = true;
  for (const fn of drawer.listeners.toggle || []) fn();
  await t.flush();
  assert.ok(t.find((n) => n.className === "sp-frame"));
  t.find((n) => n.attrs["data-action"] === "more").click(); await t.flush();
  assert.deepEqual(reads, ["", "next"]);
  t.find((n) => n.attrs["data-action"] === "restore").click(); await t.flush();
  assert.equal(restored.length, 0);
  t.find((n) => n.attrs["data-action"] === "confirm").click(); await t.flush();
  assert.deepEqual(restored[0], ["agent1", id]);
});
test("failed snapshot card requires explicit Approve anyway", async () => {
  const answers = [];
  const card = { id: "11111111-1111-4111-8111-111111111111", profile: "agent1", command: "sudo whoami", text: "sudo whoami", state: "snapshot-failed", reason: "too-large", expires: Date.now() + 600_000 };
  const t = panelHarness(safetyList(), { approvals: async () => ({ approvals: [card] }), answer: async (...a) => (answers.push(a), { ok: true }) });
  await t.flush();
  const approve = t.find((n) => n.attrs["data-action"] === "approve");
  assert.match(approve.text, /Approve anyway/);
  approve.click(); await t.flush();
  assert.equal(answers[0][2], true);
});

test("safety translations cover both dictionaries", () => {
  const { tables } = require("../renderer/i18n");
  assert.ok(Object.keys(tables.en).filter((k) => k.startsWith("safety.")).length >= 30);
  for (const key of Object.keys(tables.en).filter((k) => k.startsWith("safety."))) {
    assert.equal(typeof tables.tr[key], "string", key);
    assert.ok(tables.tr[key].length, key);
  }
});

test("late audit response cannot replace the selected agent's timeline", async () => {
  let finish;
  const list = safetyList();
  list.spaces.push({ id: "agent2", kind: "agent", state: "off", online: false, level: "watch" });
  list.pills.push({ id: "agent2", label: "Agent 2", state: "off" });
  const t = panelHarness(list, { approvals: async () => ({ approvals: [] }),
    audit: (p) => p === "agent1" ? new Promise((r) => { finish = r; }) : Promise.resolve({ records: [], next: null }),
    snapshots: async () => ({ points: [] }) });
  await t.flush();
  const drawer = t.find((n) => n.className === "sp-activity"); drawer.open = true;
  for (const fn of drawer.listeners.toggle || []) fn();
  await t.flush();
  t.pillsRow().children[1].click(); await t.flush();
  finish({ records: [{ id: "old", time: 1, tool: "old-agent-record", summary: {}, outcome: "ok" }], next: null });
  await t.flush();
  assert.doesNotMatch(t.panel.root.text, /old-agent-record/);
});

test("approval polling preserves nodes, renders literal text, and disables expired or snapshotting cards", async () => {
  const card = { id: "card1", profile: "agent1", command: "<script>whoami</script>", text: "<b>input</b>", state: "pending", expires: Date.now() + 600_000 };
  const answers = [];
  const t = panelHarness(safetyList(), { approvals: async () => ({ approvals: [card] }), answer: async (...a) => (answers.push(a), { ok: true }) });
  await t.flush();
  const button = t.find((n) => n.attrs["data-action"] === "approve");
  const command = t.find((n) => n.className === "sp-command");
  assert.equal(command.textContent, card.command);
  assert.equal(command.children.length, 0);
  assert.match(t.find((n) => n.className === "sp-time-left").text, /\d+ seconds left/);
  button.focus();
  await t.panel.refresh();
  assert.equal(t.find((n) => n.attrs["data-action"] === "approve"), button);
  assert.ok(button.focused);
  card.state = "snapshotting";
  await t.panel.refresh();
  assert.ok(button.disabled);
  card.state = "pending"; card.expires = Date.now() - 1;
  await t.panel.refresh();
  assert.ok(button.disabled);
  button.click(); await t.flush();
  assert.equal(answers.length, 0, "stale activation cannot approve an expired card");
});

test("undo and recorded-frame sheets hide the native view; refused restore reports failure", async () => {
  const t = panelHarness(safetyList(), {
    approvals: async () => ({ approvals: [] }),
    audit: async () => ({ records: [{ id: "r1", time: 5, tool: "screenshot", summary: {}, outcome: "ok", frame: "f1" }], next: null }),
    frame: async () => "data:image/png;base64,YQ==",
    snapshots: async () => ({ points: [{ id: "p1", time: 6, reason: "before-undo", size: 20, consistent: false }] }),
    restore: async () => ({ ok: false }),
  });
  await t.flush(); t.panel.kick(); t.frame();
  const drawer = t.find((n) => n.className === "sp-activity"); drawer.open = true;
  for (const fn of drawer.listeners.toggle) fn();
  await t.flush();
  t.find((n) => n.className === "sp-frame-button").click();
  assert.equal(t.find((n) => n.className === "sp-frame-large").getAttribute("src"), "data:image/png;base64,YQ==");
  t.frame(); assert.equal(t.calls.view.at(-1)[0], null);
  t.find((n) => n.className === "sp-sheet").close(); t.frame();
  assert.equal(t.calls.view.at(-1)[0], "shown");
  t.find((n) => n.attrs["data-action"] === "restore").click();
  assert.match(t.panel.root.text, /before-undo point will be kept/);
  t.find((n) => n.attrs["data-action"] === "confirm").click(); await t.flush();
  assert.match(t.panel.root.text, /Operation failed/);
});

test("selecting away and back invalidates in-flight audit even while approvals are delayed", async () => {
  let finishAudit, delayApprovals = false;
  const list = safetyList();
  list.spaces.push({ id: "agent2", kind: "agent", state: "off" });
  list.pills.push({ id: "agent2", label: "Agent 2", state: "off" });
  const t = panelHarness(list, {
    approvals: () => delayApprovals ? new Promise(() => {}) : Promise.resolve({ approvals: [] }),
    audit: () => new Promise((r) => { finishAudit = r; }),
    snapshots: async () => ({ points: [] }),
  });
  await t.flush();
  const drawer = t.find((n) => n.className === "sp-activity"); drawer.open = true;
  for (const fn of drawer.listeners.toggle) fn();
  await t.flush(); delayApprovals = true;
  t.panel.setAgent("agent2"); t.panel.setAgent("agent1");
  finishAudit({ records: [{ id: "old", time: 1, tool: "stale-generation", summary: {}, outcome: "ok" }], next: null });
  await t.flush();
  assert.doesNotMatch(t.panel.root.text, /stale-generation/);
});

async function openActivity(t) {
  await t.flush();
  const drawer = t.find((n) => n.className === "sp-activity");
  drawer.open = true;
  for (const fn of drawer.listeners.toggle) fn();
  await t.flush();
  return drawer;
}

test("notification cancels an old undo sheet before focusing the exact other-agent card", async () => {
  const list = safetyList(), restored = [];
  list.spaces.push({ id: "agent2", kind: "agent", state: "off" });
  list.pills.push({ id: "agent2", label: "Agent 2", state: "off" });
  const card = { id: "card2", profile: "agent2", command: "whoami", text: "whoami", state: "pending", expires: Date.now() + 600_000 };
  const t = panelHarness(list, {
    approvals: async () => ({ approvals: [card] }),
    audit: async () => ({ records: [], next: null }),
    snapshots: async () => ({ points: [{ id: "p1", time: 1, reason: "stop", size: 20, consistent: true }] }),
    restore: async (...args) => (restored.push(args), { ok: true }),
  });
  await openActivity(t);
  t.find((n) => n.attrs["data-action"] === "restore").click();
  const sheet = t.find((n) => n.className === "sp-sheet");
  const confirm = t.find((n) => n.attrs["data-action"] === "confirm");
  assert.equal(t.find((n) => n.attrs["data-id"] === card.id).focused, false, "focus is inside the sheet");
  await t.panel.focusApproval("agent2", card.id);
  assert.equal(sheet.open, false, "the old modal must close before focus moves");
  assert.equal(t.pillsRow().children[1].getAttribute("aria-pressed"), "true");
  assert.ok(t.find((n) => n.attrs["data-id"] === card.id).focused);
  confirm.click(); await t.flush();
  assert.deepEqual(restored, [], "a queued activation of the cancelled sheet cannot restore agent1");
});

test("three activity pages retain rows and fetched frames: 150 requests, never 300", async () => {
  const frames = [];
  const t = panelHarness(safetyList(), {
    approvals: async () => ({ approvals: [] }), snapshots: async () => ({ points: [] }),
    audit: async (_profile, cursor) => {
      const page = Number(cursor || 0);
      return { records: Array.from({ length: 50 }, (_, i) => ({ id: `r${page * 50 + i}`, time: 1000 - page * 50 - i,
        tool: "screenshot", outcome: "ok", summary: {}, frame: `f${page * 50 + i}` })), next: page < 2 ? String(page + 1) : null };
    },
    frame: async (_profile, id) => (frames.push(id), "data:image/png;base64,YQ=="),
  });
  await openActivity(t);
  const timeline = t.find((n) => n.className === "sp-timeline"), first = timeline.children[0];
  const img = first.querySelector("img");
  for (let page = 0; page < 2; page++) { t.find((n) => n.attrs["data-action"] === "more").click(); await t.flush(); }
  assert.equal(frames.length, 150);
  assert.equal(new Set(frames).size, 150);
  assert.equal(timeline.children.length, 150);
  assert.equal(timeline.children[0], first);
  assert.equal(first.querySelector("img"), img);
  assert.equal(img.getAttribute("src"), "data:image/png;base64,YQ==");
});

test("failed frames recover on refresh or paging without re-fetching successful images", async () => {
  for (const failure of ["reject", "null"]) for (const paging of [false, true]) {
    const calls = {};
    const src = "data:image/png;base64,YQ==";
    const t = panelHarness(safetyList(), {
      approvals: async () => ({ approvals: [] }), snapshots: async () => ({ points: [] }),
      audit: async (_profile, cursor) => ({ records: cursor ? [] : [0, 1, 2].map((i) => ({
        id: `r${i}`, time: 3 - i, tool: "screenshot", outcome: "ok", summary: {}, frame: `f${i}`,
      })), next: cursor ? null : "older" }),
      frame: async (_profile, id) => {
        calls[id] = (calls[id] || 0) + 1;
        if (id === "f0" && calls[id] === 1) {
          if (failure === "reject") throw new Error("offline");
          return null;
        }
        return src;
      },
    });
    await openActivity(t);
    const img = t.find((n) => n.className === "sp-frame");
    assert.equal(img.getAttribute("src"), null);
    assert.deepEqual(calls, { f0: 1, f1: 1, f2: 1 }, "no immediate retry");
    if (paging) t.find((n) => n.attrs["data-action"] === "more").click();
    else await t.panel.refresh();
    await t.flush();
    assert.equal(img.getAttribute("src"), src);
    assert.deepEqual(calls, { f0: 2, f1: 1, f2: 1 });
  }
});

test("failed frames stop after three attempts across later refreshes", async () => {
  let calls = 0;
  const t = panelHarness(safetyList(), {
    approvals: async () => ({ approvals: [] }), snapshots: async () => ({ points: [] }),
    audit: async () => ({ records: [{ id: "r0", time: 1, tool: "screenshot", outcome: "ok", summary: {}, frame: "f0" }], next: null }),
    frame: async () => { calls++; return null; },
  });
  await openActivity(t);
  for (let i = 0; i < 4; i++) {
    assert.equal(calls, Math.min(i + 1, 3));
    await t.panel.refresh(); await t.flush();
  }
  assert.equal(calls, 3);
});

test("frame queue bounds concurrency across selection changes and discards stale jobs", async () => {
  const pending = [], calls = [];
  let active = 0, peak = 0;
  const list = safetyList();
  list.spaces.push({ id: "agent2", kind: "agent", state: "off" });
  list.pills.push({ id: "agent2", label: "Agent 2", state: "off" });
  const t = panelHarness(list, {
    approvals: async () => ({ approvals: [] }), snapshots: async () => ({ points: [] }),
    audit: async () => ({ records: Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, time: i, tool: "screenshot", outcome: "ok", summary: {}, frame: `f${i}` })), next: null }),
    frame: (profile) => { calls.push(profile); peak = Math.max(peak, ++active); return new Promise((resolve) => pending.push(() => { active--; resolve("data:image/png;base64,YQ=="); })); },
  });
  await openActivity(t);
  assert.equal(calls.length, 4, "remaining frame requests wait in a queue");
  const oldImg = t.find((n) => n.className === "sp-frame");
  t.panel.setAgent("agent2"); await t.flush();
  assert.equal(calls.length, 4, "old in-flight requests still count against the limit");
  while (pending.length) { pending.splice(0).forEach((finish) => finish()); await t.flush(); }
  assert.equal(peak, 4);
  assert.equal(calls.filter((p) => p === "agent1").length, 4);
  assert.equal(calls.filter((p) => p === "agent2").length, 50);
  assert.equal(oldImg.getAttribute("src"), null);
});

test("timeline retains at most 500 newest rows and releases discarded image data", async () => {
  const t = panelHarness(safetyList(), {
    approvals: async () => ({ approvals: [] }), snapshots: async () => ({ points: [] }),
    audit: async (_profile, cursor) => {
      const page = Number(cursor || 0);
      return { records: Array.from({ length: 50 }, (_, i) => ({ id: `r${page * 50 + i}`, time: page * 50 + i,
        tool: "screenshot", outcome: "ok", summary: {}, frame: `f${page * 50 + i}` })), next: String(page + 1) };
    },
    frame: async () => "data:image/png;base64,YQ==",
  });
  await openActivity(t);
  const timeline = t.find((n) => n.className === "sp-timeline"), oldest = timeline.children.at(-1), img = oldest.querySelector("img");
  for (let page = 1; page < 11; page++) { t.find((n) => n.attrs["data-action"] === "more").click(); await t.flush(); }
  assert.equal(timeline.children.length, 500);
  assert.equal(timeline.contains(oldest), false);
  assert.equal(img.getAttribute("src"), null, "discarded data URLs are released");
});

test("snapshot failures have localized retry feedback independent of the audit result", async () => {
  const i18n = require("../renderer/i18n");
  try {
    for (const lang of ["en", "tr"]) for (const reject of [false, true]) {
      i18n.setLanguage(lang);
      let failing = true;
      const t = panelHarness(safetyList(), {
        approvals: async () => ({ approvals: [] }),
        audit: async () => ({ records: [{ id: "r1", time: 1, tool: "audit-still-visible", summary: {}, outcome: "ok" }], next: "older" }),
        snapshots: async () => { if (failing) { if (reject) throw new Error("offline"); return { ok: false, error: "offline", points: [] }; }
          return { points: [{ id: "p1", time: 2, reason: "stop", size: 20, consistent: true }] }; },
      });
      const drawer = await openActivity(t);
      const message = lang === "en" ? "Undo points are unavailable right now." : "Geri dönüş noktalarına şu anda ulaşılamıyor.";
      assert.ok(drawer.text.includes(message));
      assert.match(drawer.text, /audit-still-visible/);
      t.find((n) => n.attrs["data-action"] === "more").click(); await t.flush();
      assert.ok(drawer.text.includes(message), "paging cannot erase snapshot failure");
      failing = false;
      const retry = t.find((n) => n.attrs["data-action"] === "retry-snapshots");
      assert.equal(retry.text, lang === "en" ? "Retry" : "Yeniden dene");
      retry.click(); await t.flush();
      assert.equal(drawer.text.includes(message), false);
      assert.ok(t.find((n) => n.attrs["data-action"] === "restore"));
    }
  } finally { i18n.setLanguage("en"); }
});

test("approval answer errors stay on the affected card through timeline and language updates", async () => {
  const i18n = require("../renderer/i18n");
  const cards = ["c1", "c2"].map((id) => ({ id, profile: "agent1", command: "whoami", text: "whoami", state: "pending", expires: Date.now() + 600_000 }));
  let failing = true;
  const t = panelHarness(safetyList(), {
    approvals: async () => ({ approvals: cards }), answer: async () => { if (failing === "reject") throw new Error("offline"); return failing ? { ok: false } : { ok: true }; },
    audit: async () => ({ records: [], next: null }), snapshots: async () => ({ points: [] }),
  });
  await t.flush();
  const card = t.find((n) => n.attrs["data-id"] === "c1"), other = t.find((n) => n.attrs["data-id"] === "c2");
  t.find((n) => n.attrs["data-action"] === "approve", card).click(); await t.flush();
  assert.match(card.text, /Could not send your approval response\. Try again\./);
  assert.doesNotMatch(other.text, /Could not send/);
  const drawer = await openActivity(t);
  assert.doesNotMatch(drawer.text, /Could not send|Operation failed/);
  assert.match(card.text, /Could not send/);
  try {
    i18n.setLanguage("tr"); for (const fn of t.events["deck-language"]) fn();
    assert.match(t.find((n) => n.attrs["data-id"] === "c1").text, /Onay yanıtınız gönderilemedi\. Yeniden deneyin\./);
    failing = false;
    t.find((n) => n.attrs["data-action"] === "deny").click(); await t.flush();
    assert.doesNotMatch(t.find((n) => n.attrs["data-id"] === "c1").text, /gönderilemedi/);
    failing = "reject";
    t.find((n) => n.attrs["data-action"] === "approve").click(); await t.flush();
    assert.match(t.find((n) => n.attrs["data-id"] === "c1").text, /gönderilemedi/);
    await t.panel.refresh();
    assert.doesNotMatch(t.find((n) => n.attrs["data-id"] === "c1").text, /gönderilemedi/, "successful refresh clears the card error");
  } finally { i18n.setLanguage("en"); }
});

test("approval focus selects its agent and focused Space activation stays available; Deny never bypasses snapshot", async () => {
  const answers = [];
  const card = { id: "card2", profile: "agent2", command: "sudo whoami", text: "sudo whoami", state: "snapshot-failed", expires: Date.now() + 600_000 };
  const list = safetyList();
  list.spaces.push({ id: "agent2", kind: "agent", state: "off" });
  list.pills.push({ id: "agent2", label: "Agent 2", state: "off" });
  const t = panelHarness(list, { approvals: async () => ({ approvals: [card] }), answer: async (...a) => (answers.push(a), { ok: true }) });
  await t.flush(); await t.panel.focusApproval("agent2", card.id);
  assert.equal(t.pillsRow().children[1].getAttribute("aria-pressed"), "true");
  const root = t.find((n) => n.className === "sp-approval"); assert.ok(root.focused);
  const approve = t.find((n) => n.attrs["data-action"] === "approve"); approve.focus();
  let prevented = false;
  for (const fn of root.listeners.keydown || []) fn({ key: " ", target: approve, preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, false, "native button Space activation is not cancelled");
  assert.equal(answers.length, 0, "keydown itself never approves");
  approve.click(); await t.flush(); // browser's default Space activation
  assert.deepEqual(answers[0], [card.id, "once", true]);
  t.find((n) => n.attrs["data-action"] === "deny").click(); await t.flush();
  assert.deepEqual(answers[1], [card.id, "deny", false]);
});

test("F3: hidden panel polls new approvals and badges without loading the timeline", async () => {
  let approvals = [], reads = 0;
  const t = panelHarness(safetyList(), {
    approvals: async () => ({ approvals }),
    audit: async () => { reads++; return { records: [], next: null }; },
    snapshots: async () => ({ points: [] }),
  });
  await t.flush();
  t.document.hidden = true;
  t.find((n) => n.className === "sp-activity").open = true;
  approvals = [{ id: "new", profile: "agent1", command: "sudo whoami", text: "sudo whoami", state: "pending", expires: Date.now() + 600_000 }];
  for (let i = 0; i < 2; i++) for (const fn of t.intervals) fn();
  await t.flush();
  assert.ok(t.find((n) => n.attrs["data-id"] === "new"));
  assert.match(t.pillsRow().text, /1 approval/);
  assert.equal(reads, 0);
});

test("F7: denied timeline outcome is localized in EN and TR", async () => {
  const i18n = require("../renderer/i18n");
  const t = panelHarness(safetyList(), { approvals: async () => ({ approvals: [] }),
    audit: async () => ({ records: [{ id: "denied1", time: 5, tool: "type_text", outcome: "denied" }], next: null }),
    snapshots: async () => ({ points: [] }) });
  await t.flush();
  const drawer = t.find((n) => n.className === "sp-activity"); drawer.open = true;
  for (const fn of drawer.listeners.toggle) fn();
  await t.flush();
  try {
    for (const [language, label] of [["en", "Denied"], ["tr", "Reddedildi"]]) {
      i18n.setLanguage(language); for (const fn of t.events["deck-language"]) fn();
      assert.equal(t.find((n) => n.className === "sp-outcome").text, label);
    }
  } finally { i18n.setLanguage("en"); }
});

test("F8: drawer timestamps follow UI language and update existing rows", async () => {
  const i18n = require("../renderer/i18n"), time = Date.UTC(2026, 9, 8, 12, 30);
  const t = panelHarness(safetyList(), { approvals: async () => ({ approvals: [] }),
    audit: async () => ({ records: [{ id: "row", time, tool: "click", outcome: "ok" }], next: null }),
    snapshots: async () => ({ points: [] }) });
  await t.flush();
  const drawer = t.find((n) => n.className === "sp-activity"); drawer.open = true;
  for (const fn of drawer.listeners.toggle) fn();
  await t.flush();
  const stamp = t.find((n) => n.tag === "time");
  try {
    for (const language of ["tr", "en"]) {
      i18n.setLanguage(language); for (const fn of t.events["deck-language"]) fn();
      assert.equal(t.find((n) => n.tag === "time"), stamp);
      assert.equal(stamp.text, new Date(time).toLocaleString(i18n.getLocale()));
    }
  } finally { i18n.setLanguage("en"); }
});

test("language changes update safety cards, drawer, timeline and badges in place", async () => {
  const i18n = require("../renderer/i18n");
  const card = { id: "card1", profile: "agent1", command: "sudo whoami", text: "sudo whoami", state: "pending", expires: Date.now() + 600_000 };
  const t = panelHarness(safetyList(), {
    approvals: async () => ({ approvals: [card] }),
    audit: async () => ({ records: [], next: null }),
    snapshots: async () => ({ points: [{ id: "p1", time: 5, reason: "stop", size: 20, consistent: true }] }),
  });
  await t.flush();
  const drawer = t.find((n) => n.className === "sp-activity"); drawer.open = true;
  for (const fn of drawer.listeners.toggle) fn();
  await t.flush();
  try {
    i18n.setLanguage("tr"); for (const fn of t.events["deck-language"]) fn();
    assert.equal(drawer.querySelector("summary").text, "Etkinlik ve geri dönüş noktaları");
    assert.equal(t.find((n) => n.attrs["data-action"] === "more").text, "Daha fazla yükle");
    assert.equal(t.find((n) => n.attrs["data-action"] === "approve").text, "Bir kez onayla");
    assert.match(t.find((n) => n.className === "sp-timeline").text, /Durduruldu/);
    assert.match(t.pillsRow().text, /1 onay/);
  } finally { i18n.setLanguage("en"); }
});

test("frames reject remote URLs and late image responses after selection changes", async () => {
  for (const late of [false, true]) {
    let finish;
    const list = safetyList();
    list.spaces.push({ id: "host", kind: "shared", online: true });
    list.pills.push({ id: "host", state: "shared" });
    const t = panelHarness(list, {
      approvals: async () => ({ approvals: [] }),
      audit: async () => ({ records: [{ id: "r1", time: 5, tool: "click", summary: {}, outcome: "ok", frame: "f1" }], next: null }),
      snapshots: async () => ({ points: [] }),
      frame: () => late ? new Promise((r) => { finish = r; }) : Promise.resolve("https://example.invalid/frame.png"),
    });
    await t.flush();
    const drawer = t.find((n) => n.className === "sp-activity"); drawer.open = true;
    for (const fn of drawer.listeners.toggle) fn();
    await t.flush(); const img = t.find((n) => n.className === "sp-frame");
    if (late) {
      t.pillsRow().children[1].click();
      finish("data:image/png;base64,YQ=="); await t.flush();
      assert.ok(drawer.hidden);
    }
    assert.equal(img.getAttribute("src"), null);
  }
});
