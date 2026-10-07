"use strict";
// Workspace large view, relay half: a deck's watch is capped at 1024 px unless it says `large` (its expanded view,
// up to 1920), and {op:"resize"} changes the running stream in place (no re-watch). Fakes only: a fake CDP socket
// stands in for the agent host's Chrome; no browser, no live ports.
//   node --test relay/test/ws-view.test.js
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { EventEmitter } = require("events");
const WebSocket = require("ws");
const { WorkspaceHub, VIEW } = require("../src/workspace");

const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 15));
  }
};

function fakeChrome() {
  const calls = [];
  const srv = http.createServer((req, res) => res.end("{}"));
  const wss = new WebSocket.WebSocketServer({ server: srv });
  wss.on("connection", (ws) =>
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      calls.push({ method: m.method, params: m.params || {}, sessionId: m.sessionId });
      let result = {};
      if (m.method === "Target.getTargets") result = { targetInfos: [{ targetId: "A", type: "page", url: "https://agent.example/", title: "page", attached: false }] };
      else if (m.method === "Target.attachToTarget") result = { sessionId: `S-${m.params.targetId}` };
      else if (m.method === "Target.getTargetInfo") result = { targetInfo: { targetId: "A", type: "page", url: "https://agent.example/", title: "page" } };
      else if (m.method === "Runtime.evaluate") result = { result: { type: "string", value: "visible" } };
      ws.send(JSON.stringify({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
    })
  );
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () =>
      resolve({
        port: srv.address().port,
        starts: () => calls.filter((c) => c.method === "Page.startScreencast").map((c) => c.params),
        stops: () => calls.filter((c) => c.method === "Page.stopScreencast").length,
        close: () => (wss.clients.forEach((c) => c.terminate()), srv.close()),
      })
    )
  );
}

async function hubOn(t) {
  const chrome = await fakeChrome();
  const b = Object.assign(new EventEmitter(), { slug: "scout", status: "running", port: chrome.port, wsPath: "/devtools/browser/fake", controller: "agent", lastAct: null, viewers: 0, info: () => ({ slug: "scout", status: "running" }) });
  const fallback = Object.assign(new EventEmitter(), { available: true, name: "agent host", peek: (s) => (s === "scout" ? b : null), list: () => [b.info()], setController() {} });
  const sent = [];
  const deck = { readyState: 1, bufferedAmount: 0, send: (d) => sent.push(JSON.parse(d)) };
  const hub = new WorkspaceHub({ presence: {}, fallback, broadcast() {} });
  t.after(() => (hub.stop(), chrome.close()));
  let id = 0;
  const req = async (msg) => {
    const n = ++id;
    hub.onMessage(deck, { t: "ws-req", id: n, slug: "scout", ...msg });
    return until(() => sent.find((m) => m.t === "ws-res" && m.id === n));
  };
  return { chrome, hub, deck, sent, req };
}

test("watch: a panel-sized view is capped at 1024, an expanded (`large`) one may reach 1920", async (t) => {
  assert.equal(VIEW.side, 1024);
  assert.equal(VIEW.largeSide, 1920);
  const a = await hubOn(t);
  assert.equal((await a.req({ op: "watch", maxWidth: 1920, maxHeight: 1920 })).ok, true);
  await until(() => a.chrome.starts().length === 1);
  assert.deepEqual([a.chrome.starts()[0].maxWidth, a.chrome.starts()[0].maxHeight], [1024, 1024], "an old or panel-sized request stays at 1024");

  const b = await hubOn(t);
  assert.equal((await b.req({ op: "watch", maxWidth: 1920, maxHeight: 1920, large: true })).ok, true);
  await until(() => b.chrome.starts().length === 1);
  assert.deepEqual([b.chrome.starts()[0].maxWidth, b.chrome.starts()[0].maxHeight], [1920, 1920]);

  const c = await hubOn(t);
  assert.equal((await c.req({ op: "watch", maxWidth: 99999, maxHeight: 10, large: true })).ok, true);
  await until(() => c.chrome.starts().length === 1);
  assert.deepEqual([c.chrome.starts()[0].maxWidth, c.chrome.starts()[0].maxHeight], [1920, 320], "never past 1920, never under 320");
});

test("resize: the running stream changes size in place (stop + start on the same page), large lifts the cap, collapse lowers it", async (t) => {
  const { chrome, hub, req } = await hubOn(t);
  await req({ op: "watch", maxWidth: 896, maxHeight: 896 });
  await until(() => chrome.starts().length === 1);
  const watching = hub.viewers.values().next().value.get("scout");
  const lv = watching.lv || (await until(() => watching.lv));
  const attaches = () => 0; // (the fake does not count them: the stop/start pair below is the proof)

  // without `large` the relay keeps its 1024 cap: 1920 becomes 1024 (a real change from 896, so it restarts at 1024)
  assert.equal((await req({ op: "resize", maxWidth: 1920, maxHeight: 1920 })).ok, true);
  await until(() => chrome.starts().length === 2);
  assert.equal(chrome.starts()[1].maxWidth, 1024);
  assert.equal(lv.opts.maxWidth, 1024);

  assert.equal((await req({ op: "resize", maxWidth: 1920, maxHeight: 1920, large: true })).ok, true);
  await until(() => chrome.starts().length === 3);
  assert.deepEqual([chrome.starts()[2].maxWidth, chrome.starts()[2].maxHeight], [1920, 1920]);
  assert.equal(chrome.stops() >= 2, true, "each old stream stopped before the next started");
  assert.equal(attaches(), 0);

  assert.equal((await req({ op: "resize", maxWidth: 896, maxHeight: 896 })).ok, true);
  await until(() => chrome.starts().length === 4);
  assert.equal(chrome.starts()[3].maxWidth, 896, "collapsing goes back down");
  // same size again: nothing happens
  await req({ op: "resize", maxWidth: 896, maxHeight: 896 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(chrome.starts().length, 4);
});

test("resize: without a watch it is refused (nothing is started), and a resize during start applies once the view runs", async (t) => {
  const x = await hubOn(t);
  const res = await x.req({ op: "resize", maxWidth: 1408, maxHeight: 1408, large: true });
  assert.equal(res.ok, false, "nothing watched: the deck is told");
  assert.equal(x.chrome.starts().length, 0);

  const y = await hubOn(t);
  await y.req({ op: "watch", maxWidth: 896, maxHeight: 896 }); // starts asynchronously
  assert.equal((await y.req({ op: "resize", maxWidth: 1408, maxHeight: 1408, large: true })).ok, true); // may land before the view is up
  await until(() => y.chrome.starts().some((p) => p.maxWidth === 1408));
  assert.equal(y.chrome.starts().pop().maxWidth, 1408, "whichever order the two arrived in, the stream ends at the last size");
});
