"use strict";
// Workspace tab, large view: the stream size follows the stage, and pointer/keys still land on the right pixel.
// Offline: pure functions, a fake CDP socket for LiveView.resize, main/workspace.js against a fake relay. No Electron.
//   node --test app/test/ws-view.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const os = require("os");
const fs = require("fs");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const { EventEmitter } = require("events");
const VW = require("../renderer/ws-view");
const { LiveView } = require("../main/cdp-view");
const { setLanguage, t } = require("../renderer/i18n");
setLanguage("en");

// ---- the stream size follows the stage ------------------------------------------------------------------------
test("streamSize(): follows the stage width and DPR, snaps to steps, keeps 640..1920", () => {
  assert.deepEqual(VW.streamSize({ width: 560, dpr: 1 }), { maxWidth: 896, maxHeight: 896, large: false }, "panel default: 560 * 1.5 -> 840 -> step 896");
  assert.equal(VW.streamSize({ width: 300, dpr: 1 }).maxWidth, 640, "tiny stage: floor");
  assert.equal(VW.streamSize({ width: 1400, dpr: 1, large: true }).maxWidth, 1920, "expanded 1400 css px: 2100 wanted, capped at 1920");
  assert.equal(VW.streamSize({ width: 900, dpr: 1 }).maxWidth, 1408, "900 * 1.5 = 1350 -> step 1408");
  assert.equal(VW.streamSize({ width: 560, dpr: 2 }).maxWidth, 1792, "HiDPI: 560 * 2 * 1.5 = 1680 -> step 1792");
  assert.equal(VW.streamSize({}).maxWidth, 896, "no size yet: the panel's default width");
  assert.equal(VW.streamSize({ width: NaN, dpr: -3 }).maxWidth, 896);
  assert.equal(VW.streamSize({ width: 800, large: true }).large, true);
  for (const w of [1, 200, 500, 777, 1000, 2000, 5000]) {
    const s = VW.streamSize({ width: w, dpr: 1.25 });
    assert.ok(s.maxWidth >= 640 && s.maxWidth <= 1920 && s.maxWidth === s.maxHeight, `width ${w}: ${s.maxWidth}`);
  }
  // dragging the gutter 1 px at a time must not change the answer every pixel
  const seen = new Set();
  for (let w = 600; w < 640; w++) seen.add(VW.streamSize({ width: w, dpr: 1 }).maxWidth);
  assert.ok(seen.size <= 2, `a 40 px drag spans ${seen.size} stream sizes`);
});

test("createResizer(): debounces a burst to ONE request, skips an unchanged size, resets on start/stop", () => {
  const timers = [];
  let now = 0;
  const setTimer = (fn, ms) => {
    const tm = { fn, at: now + ms, live: true };
    timers.push(tm);
    return tm;
  };
  const clearTimer = (tm) => {
    if (tm) tm.live = false;
  };
  const advance = (ms) => {
    now += ms;
    for (const tm of timers) if (tm.live && tm.at <= now) ((tm.live = false), tm.fn());
  };
  const asks = [];
  const r = VW.createResizer((s) => asks.push(s), { setTimer, clearTimer });
  const small = VW.streamSize({ width: 560 });
  const big = VW.streamSize({ width: 1400, large: true });
  r.start(small);
  r.observe(small);
  assert.equal(r.pending, false, "the size the watch itself asked for is not asked again");
  // expand: a burst of layout changes during the transition
  for (const w of [700, 900, 1100, 1400]) {
    r.observe(VW.streamSize({ width: w, large: true }));
    advance(80);
  }
  assert.equal(asks.length, 0, "nothing while the size is still changing");
  advance(VW.DEBOUNCE_MS);
  assert.deepEqual(asks, [big], "one request, with the final size");
  // a change that lands on the same stream size: no request
  r.observe(VW.streamSize({ width: 1395, large: true }));
  assert.equal(r.pending, false);
  // collapse: asks again (small, not large)
  r.observe(small);
  advance(VW.DEBOUNCE_MS);
  assert.deepEqual(asks, [big, small]);
  assert.equal(asks[1].large, false, "collapsing drops the large allowance");
  // the same pixel size but large flipped is still a change (the relay's cap differs)
  r.observe({ ...small, large: true });
  advance(VW.DEBOUNCE_MS);
  assert.equal(asks.length, 3);
  // a burst that returns to the asked size cancels itself
  r.observe(big);
  r.observe({ ...small, large: true });
  advance(VW.DEBOUNCE_MS * 2);
  assert.equal(asks.length, 3);
  // stop forgets: a pending ask never fires after the watch ended
  r.observe(big);
  r.stop();
  advance(VW.DEBOUNCE_MS * 2);
  assert.equal(asks.length, 3);
  assert.equal(r.asked, null);
});

// ---- coordinates: pointer -> page, at any stage size, with and without letterboxing --------------------------
test("mapPoint(): exact when the box has the picture's aspect ratio, at any stage size and after a resolution change", () => {
  // the same 1280x800 page, shown in the panel (560 wide) and expanded (1400 wide), at two stream resolutions
  for (const [boxW, picW] of [[560, 896], [560, 1408], [1400, 1408], [1400, 1920]]) {
    const picH = (picW * 800) / 1280;
    const box = { left: 100, top: 40, width: boxW, height: (boxW * 800) / 1280 };
    const mid = VW.mapPoint(box.left + box.width / 2, box.top + box.height / 2, box, picW, picH);
    assert.ok(Math.abs(mid.x - 0.5) < 1e-9 && Math.abs(mid.y - 0.5) < 1e-9 && mid.inside, `${boxW}/${picW} centre`);
    const q = VW.mapPoint(box.left + box.width * 0.25, box.top + box.height * 0.75, box, picW, picH);
    assert.ok(Math.abs(q.x - 0.25) < 1e-9 && Math.abs(q.y - 0.75) < 1e-9, `${boxW}/${picW} quarter`);
    // what main does with it (cdp-view input(): x * deviceWidth): the page pixel does not depend on the stream size
    assert.ok(Math.abs(q.x * 1280 - 320) < 1e-6 && Math.abs(q.y * 800 - 600) < 1e-6, `${boxW}/${picW} page pixel`);
  }
});

test("mapPoint(): a wide expanded box letterboxes the picture; bands are outside, the picture edge is 0 and 1", () => {
  // 1280x800 picture in a 1600x700 box: height limits, so the picture is 1120x700 centred (240 px bands each side)
  const box = { left: 0, top: 0, width: 1600, height: 700 };
  const c = VW.contentBox(box, 1280, 800);
  assert.ok(Math.abs(c.width - 1120) < 1e-9 && Math.abs(c.height - 700) < 1e-9 && Math.abs(c.left - 240) < 1e-9 && c.top === 0);
  assert.equal(VW.mapPoint(100, 350, box, 1280, 800).inside, false, "left band");
  assert.equal(VW.mapPoint(1500, 350, box, 1280, 800).inside, false, "right band");
  const left = VW.mapPoint(240, 0, box, 1280, 800);
  assert.ok(left.inside && left.x === 0 && left.y === 0, "picture's own left/top edge is 0,0");
  const right = VW.mapPoint(1360, 700, box, 1280, 800);
  assert.ok(right.inside && Math.abs(right.x - 1) < 1e-9 && Math.abs(right.y - 1) < 1e-9, "picture's own right/bottom edge is 1,1");
  assert.ok(Math.abs(VW.mapPoint(800, 350, box, 1280, 800).x - 0.5) < 1e-9, "the box centre is the picture centre");
  // a tall box: bands above and below
  const tall = { left: 10, top: 10, width: 640, height: 900 };
  const p = VW.contentBox(tall, 1280, 800);
  assert.ok(Math.abs(p.height - 400) < 1e-9 && Math.abs(p.top - 260) < 1e-9);
  assert.equal(VW.mapPoint(300, 100, tall, 1280, 800).inside, false, "top band");
  // while a drag leaves the picture the point clamps to 0..1 (pointer capture keeps sending moves)
  const out = VW.mapPoint(-500, 5000, box, 1280, 800);
  assert.deepEqual([out.x, out.y, out.inside], [0, 1, false]);
  // a bitmap size that has not arrived yet (0): the whole box
  assert.deepEqual(VW.contentBox(box, 0, 0), { left: 0, top: 0, width: 1600, height: 700 });
});

test("mapPoint(): the resolution change swaps the bitmap size, never the page pixel", () => {
  // frame metadata of the SAME page at two stream sizes: deviceWidth/Height stay 1280x800, the bitmap changes
  const box = { left: 0, top: 0, width: 1400, height: 875 };
  const before = VW.mapPoint(700, 437.5, box, 896, 560);
  const after = VW.mapPoint(700, 437.5, box, 1920, 1200);
  assert.deepEqual([before.x, before.y], [after.x, after.y]);
  // between the old canvas size and the first new frame, a canvas still holding the old bitmap keeps its own aspect
  const mid = VW.mapPoint(700, 437.5, box, 896, 560);
  assert.ok(Math.abs(mid.x - 0.5) < 1e-9 && Math.abs(mid.y - 0.5) < 1e-9);
});

test("isExpandKey(): Ctrl/Cmd+Shift+F only", () => {
  assert.equal(VW.isExpandKey({ ctrlKey: true, shiftKey: true, key: "F" }), true);
  assert.equal(VW.isExpandKey({ metaKey: true, shiftKey: true, key: "f" }), true);
  assert.equal(VW.isExpandKey({ ctrlKey: true, key: "f" }), false, "plain Ctrl+F is the page's / find");
  assert.equal(VW.isExpandKey({ ctrlKey: true, shiftKey: true, altKey: true, key: "f" }), false);
  assert.equal(VW.isExpandKey({ shiftKey: true, key: "F" }), false, "typing a capital F while controlling");
  assert.equal(VW.isExpandKey({ ctrlKey: true, shiftKey: true, key: "h" }), false);
  assert.equal(VW.isExpandKey(null), false);
});

test("i18n: ws.expand* have EN and TR texts; the tips carry the shortcut", () => {
  for (const k of ["ws.expand", "ws.expandTip", "ws.collapse", "ws.collapseTip"]) {
    for (const l of ["en", "tr"]) {
      setLanguage(l);
      assert.notEqual(t(k, { key: "Ctrl+Shift+F" }), k, `${k} ${l}`);
    }
  }
  setLanguage("en");
  assert.match(t("ws.expandTip", { key: "Ctrl+Shift+F" }), /Ctrl\+Shift\+F/);
  assert.match(t("ws.collapseTip", { key: "Ctrl+Shift+F" }), /Esc/);
});

// ---- LiveView.resize(): the running stream changes size in place -------------------------------------------------
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
        calls,
        starts: () => calls.filter((c) => c.method === "Page.startScreencast"),
        close: () => (wss.clients.forEach((c) => c.terminate()), srv.close()),
      })
    )
  );
}
const browserOn = (port) => Object.assign(new EventEmitter(), { port, wsPath: "/devtools/browser/fake", controller: "agent", lastAct: null });

test("LiveView.resize(): restarts the screencast on the attached page only, with the new size, once per change", async (t) => {
  const chrome = await fakeChrome();
  const lv = new LiveView(browserOn(chrome.port), { maxWidth: 896, maxHeight: 896 });
  t.after(() => (lv.stop(), chrome.close()));
  await lv.start();
  assert.equal(chrome.starts().length, 1);
  assert.deepEqual([chrome.starts()[0].params.maxWidth, chrome.starts()[0].params.maxHeight], [896, 896]);
  const attaches = chrome.calls.filter((c) => c.method === "Target.attachToTarget").length;
  let tabEvents = 0;
  lv.on("tabs", () => tabEvents++);

  await lv.resize({ maxWidth: 1920, maxHeight: 1920 });
  assert.equal(chrome.starts().length, 2);
  assert.deepEqual([chrome.starts()[1].params.maxWidth, chrome.starts()[1].params.maxHeight], [1920, 1920]);
  assert.equal(chrome.starts()[1].sessionId, "S-A", "on the page's own session");
  const order = chrome.calls.map((c) => c.method).filter((m) => /Screencast$/.test(m));
  assert.deepEqual(order, ["Page.startScreencast", "Page.stopScreencast", "Page.startScreencast"], "stop then start: never two streams");
  assert.equal(chrome.calls.filter((c) => c.method === "Target.attachToTarget").length, attaches, "no re-attach (the page is not touched)");
  assert.equal(tabEvents, 0, "no tab events: the picture does not blank");
  assert.equal(chrome.starts()[1].params.quality, 62, "quality kept");

  await lv.resize({ maxWidth: 1920, maxHeight: 1920 });
  assert.equal(chrome.starts().length, 2, "the same size is not asked twice");
  await lv.resize({ maxWidth: 0, maxHeight: "x" });
  await lv.resize({});
  assert.equal(chrome.starts().length, 2, "junk sizes are ignored");
});

test("LiveView.resize(): a burst is serialized (never two restarts at once) and the last size wins", async (t) => {
  const chrome = await fakeChrome();
  const lv = new LiveView(browserOn(chrome.port), { maxWidth: 896, maxHeight: 896 });
  t.after(() => (lv.stop(), chrome.close()));
  await lv.start();
  const p = [lv.resize({ maxWidth: 1024, maxHeight: 1024 }), lv.resize({ maxWidth: 1408, maxHeight: 1408 }), lv.resize({ maxWidth: 1920, maxHeight: 1920 })];
  await Promise.all(p);
  const seq = chrome.calls.map((c) => c.method).filter((m) => /Screencast$/.test(m));
  for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1], `start/stop alternate: ${seq.join(",")}`);
  assert.equal(seq[seq.length - 1], "Page.startScreencast", "ends running");
  assert.equal(chrome.starts().pop().params.maxWidth, 1920, "the last size wins");
  assert.equal(lv.opts.maxWidth, 1920);
});

test("LiveView.resize(): before attach it only records the size; a later attach uses it; after stop it does nothing", async (t) => {
  const chrome = await fakeChrome();
  const lv = new LiveView(browserOn(chrome.port), { maxWidth: 896, maxHeight: 896 });
  t.after(() => (lv.stop(), chrome.close()));
  await lv.resize({ maxWidth: 1408, maxHeight: 1408 }); // not started: no session
  assert.equal(chrome.calls.length, 0);
  await lv.start();
  assert.equal(chrome.starts()[0].params.maxWidth, 1408, "the view starts at the size asked for meanwhile");
  lv.stop();
  const n = chrome.calls.length;
  await lv.resize({ maxWidth: 1920, maxHeight: 1920 });
  assert.equal(chrome.calls.length, n, "a stopped view is left alone");
});

// ---- main: ws:resize goes to the right side, and `large` reaches the relay -------------------------------------
function loadWorkspace() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deck-wsview-"));
  const handlers = new Map();
  const electron = {
    app: { getPath: () => tmp, on() {}, isPackaged: false },
    ipcMain: { handle: (c, fn) => handlers.set(c, fn), on: (c, fn) => handlers.set(c, fn) },
    safeStorage: { isEncryptionAvailable: () => false },
  };
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === "electron" ? electron : load.call(this, request, ...rest);
  };
  try {
    const key = require.resolve("../main/workspace");
    delete require.cache[key];
    return { initWorkspace: require("../main/workspace").initWorkspace, handlers };
  } finally {
    Module._load = load;
  }
}
class FakeRelay extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.open = true;
  }
  send(d) {
    this.sent.push(typeof d === "string" ? JSON.parse(d) : d);
    return true;
  }
}
const fakePresence = () => Object.assign(new EventEmitter(), { id: "a1b2c3d4e5f60708", name: "Test PC", hosting: { browser: false, desktop: false }, register() {}, state: () => ({}), attach() {}, push() {} });

test("main: ws:watch passes `large` to the relay, ws:resize asks the relay to resize in place (no re-watch)", async () => {
  const { initWorkspace, handlers } = loadWorkspace();
  const ws = initWorkspace({ send() {}, presence: fakePresence() });
  const relay = new FakeRelay();
  ws.attachRelay(relay);
  ws.onRelayMsg({ t: "devices", pins: [{ capability: "browser", sessionKey: "scout", host: { kind: "fallback" } }], routes: [], defaults: { browser: "host" }, fallback: { browser: { name: "host" } } });
  ws.onRelayMsg({ t: "ws-browsers", host: "host", browsers: [{ slug: "scout", status: "running" }] });
  await new Promise((r) => setImmediate(r));
  const reqs = () => relay.sent.filter((m) => m.t === "ws-req");
  const answer = (op) => {
    const q = reqs().filter((m) => m.op === op).pop();
    if (q) ws.onRelayMsg({ t: "ws-res", id: q.id, ok: true, value: null });
    return q;
  };
  const e = { senderFrame: { url: "deck://app/index.html", parent: null } }; // the Deck's own page (ipc-guard)
  await handlers.get("ws:watch")(e, "scout", { maxWidth: 896, maxHeight: 896 });
  const w1 = answer("watch");
  assert.ok(w1, "watch reached the relay");
  assert.deepEqual([w1.maxWidth, w1.maxHeight, w1.large], [896, 896, false]);

  const pr = handlers.get("ws:resize")(e, "scout", { maxWidth: 1920, maxHeight: 1920, large: true });
  const r1 = answer("resize");
  await pr;
  assert.deepEqual([r1.slug, r1.maxWidth, r1.maxHeight, r1.large], ["scout", 1920, 1920, true]);
  assert.equal(reqs().filter((m) => m.op === "watch").length, 1, "no second watch: the view is not rebuilt");
  assert.equal(reqs().filter((m) => m.op === "unwatch").length, 0);

  // junk is clamped like the first request; an unknown agent is refused; an older relay's error is swallowed
  const pj = handlers.get("ws:resize")(e, "scout", { maxWidth: 99999, maxHeight: -4, large: "yes" });
  const r2 = answer("resize");
  await pj;
  assert.deepEqual([r2.maxWidth, r2.maxHeight, r2.large], [1920, 320, false], "clamped to 320..1920; only a real `true` is large");
  await assert.rejects(async () => handlers.get("ws:resize")(e, "Bad Slug!", {}));
  const pe = handlers.get("ws:resize")(e, "scout", { maxWidth: 1024, maxHeight: 1024 });
  const r3 = reqs().filter((m) => m.op === "resize").pop();
  ws.onRelayMsg({ t: "ws-res", id: r3.id, ok: false, error: "bad request" });
  assert.equal(await pe, undefined, "an old relay that does not know resize leaves the old size; no error shown");

  // a view for another slug is not resized (nothing to resize); the next watch reads the stored size
  const none = await handlers.get("ws:resize")(e, "other", { maxWidth: 1408, maxHeight: 1408 });
  assert.equal(none, null);
  assert.equal(reqs().filter((m) => m.op === "resize").length, 3);
});
