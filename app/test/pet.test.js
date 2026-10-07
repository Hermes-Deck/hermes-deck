"use strict";
// Status pet (A10): state mapping, the Karakter skin's pose graph and transition planning (PetLogic.Choreo),
// event routing on the page (routeEvent) and in main (PetFeed), and the window geometry. Run: node --test test/
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const L = require("../renderer/pets/logic");
const M = require("../main/pet-model");

/** notify.js, which desktop.js hands PetFeed its textOf from; it only needs Electron to show toasts. */
function loadNotify() {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === "electron" ? {} : load.call(this, request, ...rest);
  };
  try {
    return require("../main/notify");
  } finally {
    Module._load = load;
  }
}

const sum = (o = {}) => ({ running: 0, subs: 0, unread: 0, pending: 0, offline: false, ...o });

// ---------------------------------------------------------------- state mapping
test("stateOf: the summary by priority offline < idle < working < reply < waiting", () => {
  assert.strictEqual(L.stateOf(sum()), "idle");
  assert.strictEqual(L.stateOf(sum({ offline: true })), "offline");
  assert.strictEqual(L.stateOf(sum({ running: 2 })), "working");
  assert.strictEqual(L.stateOf(sum({ subs: 1 })), "working");
  assert.strictEqual(L.stateOf(sum({ running: 1, unread: 3 })), "reply");
  assert.strictEqual(L.stateOf(sum({ running: 1, unread: 3, pending: 1 })), "waiting");
  // running counts come from the relay: offline, they do not count; replies and answers still do
  assert.strictEqual(L.stateOf(sum({ offline: true, running: 4 })), "offline");
  assert.strictEqual(L.stateOf(sum({ offline: true, unread: 2 })), "reply");
  assert.strictEqual(L.stateOf(sum({ offline: true, pending: 1 })), "waiting");
  assert.strictEqual(L.stateOf(null), "offline");
  assert.strictEqual(L.stateOf({ running: "2", offline: false }), "working");
});

test("effective: an event's hold raises the state while it lasts, never lowers it", () => {
  assert.strictEqual(L.effective("idle", "reply"), "reply");
  assert.strictEqual(L.effective("offline", "reply"), "reply");
  assert.strictEqual(L.effective("working", "waiting"), "waiting");
  assert.strictEqual(L.effective("waiting", "reply"), "waiting");
  assert.strictEqual(L.effective("working", null), "working");
  assert.strictEqual(L.effective("idle", "nonsense"), "idle");
  assert.strictEqual(L.normState("replies"), "reply"); // the old --pet-state name
  assert.strictEqual(L.normState("toString"), null);
});

// ---------------------------------------------------------------- pose graph
test("route: strips between poses, chained through sitting", () => {
  const r = (a, b) => L.route(a, b).map((e) => `${e.strip}:${e.dir}`);
  assert.deepStrictEqual(r("sit", "sit"), []);
  assert.deepStrictEqual(r("sit", "stand"), ["stand:normal"]);
  assert.deepStrictEqual(r("stand", "sit"), ["stand:reverse"]);
  assert.deepStrictEqual(r("lie", "sit"), ["wake:normal"]);
  assert.deepStrictEqual(r("sit", "lie"), ["wake:reverse"]);
  assert.deepStrictEqual(r("stand", "lie"), ["stand:reverse", "wake:reverse"]);
  assert.deepStrictEqual(r("lie", "stand"), ["wake:normal", "stand:normal"]);
  for (const a of ["sit", "stand", "lie"]) {
    for (const b of ["sit", "stand", "lie"]) {
      const path = L.route(a, b);
      let at = a;
      for (const e of path) {
        assert.strictEqual(e.from, at, `${a}->${b} is connected`);
        at = e.to;
      }
      assert.strictEqual(at, b);
    }
  }
});

/** Drives a Choreo like the skin does: every strip ends, until a loop shows. */
function play(c, state) {
  const steps = [];
  let s = c.set(state);
  while (s) {
    steps.push(s.type === "loop" ? `loop:${s.name}` : `${s.name}:${s.dir}`);
    s = s.type === "strip" ? c.done() : null;
  }
  return steps;
}

test("Choreo: first state shows at once; same pose cross-fades; other poses play strips", () => {
  const c = new L.Choreo();
  const first = c.set("idle");
  assert.deepStrictEqual([first.type, first.name, first.fade], ["loop", "idle", 0]);
  const fade = c.set("working");
  assert.deepStrictEqual([fade.type, fade.name, fade.fade], ["loop", "working", L.FADE.loop]);
  assert.strictEqual(c.set("working"), null, "already there");
  assert.deepStrictEqual(play(c, "reply"), ["stand:normal", "loop:reply"]);
  assert.deepStrictEqual(play(c, "waiting"), ["loop:waiting"]);
  assert.deepStrictEqual(play(c, "idle"), ["stand:reverse", "loop:idle"]);
  assert.deepStrictEqual(play(c, "offline"), ["wake:reverse", "loop:offline"]);
  assert.deepStrictEqual(play(c, "waiting"), ["wake:normal", "stand:normal", "loop:waiting"]);
  assert.deepStrictEqual(play(c, "offline"), ["stand:reverse", "wake:reverse", "loop:offline"]);
});

test("Choreo: a change during a strip waits for it and continues from the pose it ended in", () => {
  const c = new L.Choreo();
  c.set("idle");
  const up = c.set("reply");
  assert.deepStrictEqual([up.name, up.dir, up.pose, up.to], ["stand", "normal", "sit", "stand"]);
  assert.ok(c.busy);
  assert.strictEqual(c.set("idle"), null, "queued, no jump mid-strip");
  assert.strictEqual(c.set("working"), null, "only the newest target counts");
  const down = c.done(); // standing now: sit back down toward the newest target
  assert.deepStrictEqual([down.name, down.dir], ["stand", "reverse"]);
  const loop = c.done();
  assert.deepStrictEqual([loop.type, loop.name, loop.fade], ["loop", "working", L.FADE.strip]);
  assert.ok(!c.busy);

  // a chain changes course at its middle pose
  c.set("offline"); // wake reverse
  c.done();
  c.set("waiting"); // lying: wake normal, then stand
  const mid = c.done(); // sitting again
  assert.deepStrictEqual([mid.name, mid.dir], ["stand", "normal"]);
  assert.strictEqual(c.set("idle"), null);
  const back = c.done(); // standing: the newest target is sitting
  assert.deepStrictEqual([back.name, back.dir], ["stand", "reverse"]);
  assert.deepStrictEqual([c.done().name], ["idle"]);
});

test("Choreo: jump shows a state without a transition; done() without a strip does nothing", () => {
  const c = new L.Choreo();
  c.set("idle");
  c.set("reply");
  const j = c.jump("offline");
  assert.deepStrictEqual([j.type, j.name, j.fade, j.pose], ["loop", "offline", 0, "lie"]);
  assert.ok(!c.busy);
  assert.strictEqual(c.done(), null);
  assert.strictEqual(c.set("bogus"), null);
});

// ---------------------------------------------------------------- events on the page
test("routeEvent: reply hops and holds reply, ask shakes and holds waiting, done hops happily", () => {
  const on = { bubbles: true };
  assert.deepStrictEqual(L.routeEvent({ kind: "reply", agent: "Ajan", snippet: "Hazır" }, on), { fx: "hop", hold: "reply", bubble: true, tone: "amphora" });
  assert.deepStrictEqual(L.routeEvent({ kind: "ask", agent: "Hermes", snippet: "Onay?" }, on), { fx: "shake", hold: "waiting", bubble: true, tone: "gilt" });
  assert.deepStrictEqual(L.routeEvent({ kind: "done", agent: "Ajan" }, on), { fx: "happy", hold: null, bubble: false, tone: "patina" });
  assert.strictEqual(L.routeEvent({ kind: "reply", agent: "A", snippet: "x" }, { bubbles: false }).bubble, false, "Bildirimler off");
  assert.strictEqual(L.routeEvent({ kind: "reply", agent: "A", snippet: "x", quiet: true }, on).bubble, false, "deck in front");
  assert.strictEqual(L.routeEvent({ kind: "reply" }, on).bubble, false, "nothing to say");
  assert.strictEqual(L.routeEvent({ kind: "boom" }, on), null);
  assert.strictEqual(L.routeEvent(null, on), null);
  assert.strictEqual(L.clean("  a\n b  "), "a b");
  assert.strictEqual(L.clean("x".repeat(10), 5), "xxxx…");
});

// ---------------------------------------------------------------- events in main (PetFeed)
function feed(opts = {}) {
  const out = [];
  const timers = [];
  const f = new M.PetFeed({
    emit: (e) => out.push(e),
    describe: (key, m) => (key[0] === "t" ? { agent: (m && m.from) || "# Konu" } : { agent: "Ajan", avatar: "data:image/png;base64,AAAA" }),
    textOf: (m) => m.text || "[fotoğraf]",
    timers: { setTimeout: (fn) => timers.push(fn) && timers.length, clearTimeout: () => {} },
    ...opts,
  });
  const flush = () => timers.splice(0).forEach((fn) => fn());
  return { f, out, flush };
}

test("PetFeed: an agent's message becomes one reply event after streamed edits settle", () => {
  const { f, out, flush } = feed();
  f.message({ key: "u7", id: 1, text: "Yazı" });
  f.edit({ key: "u7", id: 1, text: "Yazıyorum, birazdan bitecek ve uzun bir cümle olacak, altmış karakteri geçecek kadar uzun." });
  assert.strictEqual(out.length, 0, "waits for the stream to settle");
  flush();
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, "reply");
  assert.strictEqual(out[0].agent, "Ajan");
  assert.strictEqual(out[0].key, "u7");
  assert.ok(out[0].snippet.length <= 60 && out[0].snippet.endsWith("…"));
  assert.strictEqual(out[0].avatar, "data:image/png;base64,AAAA");
  f.message({ key: "u7", id: 1, text: "again" }); // the same message twice: no second hop
  flush();
  assert.strictEqual(out.length, 1);
});

test("PetFeed: outgoing, service and people's topic messages are not replies; bursts are one event", () => {
  const { f, out, flush } = feed();
  f.message({ key: "u7", id: 2, out: true, text: "benim" });
  f.message({ key: "u7", id: 3, service: "pinned", text: "" });
  f.message({ key: "t5", id: 4, fromBot: false, from: "Bir kişi", text: "selam" });
  f.message({ key: "x1", id: 5, text: "bad key" });
  flush();
  assert.strictEqual(out.length, 0);
  f.message({ key: "t5", id: 6, fromBot: true, from: "Ajan", text: "bir" });
  f.message({ key: "t5", id: 7, fromBot: true, from: "Ajan", text: "iki" });
  flush();
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual([out[0].agent, out[0].snippet, out[0].key], ["Ajan", "iki", "t5"]);
  assert.ok(!("avatar" in out[0]));
});

test("PetFeed: bridge requests ask, finished runs are done, quiet while the deck is in front", () => {
  let front = false;
  const { f, out } = feed({ quiet: () => front });
  f.ask({ id: "r1", kind: "approval", sid: "s1", description: "Dosyaları sil", command: "rm x" });
  f.ask({ id: "r2", kind: "question", sid: "", questions: [{ question: "Hangi dal?" }] });
  assert.deepStrictEqual(out.map((e) => [e.kind, e.snippet, e.key]), [["ask", "Dosyaları sil", "hs:s1"], ["ask", "Hangi dal?", null]]);
  f.done({ agent: "Ajan", key: "u7", state: "done" });
  f.done({ agent: "Ajan", key: "u7", state: "failed" });
  f.done({ agent: "Ajan", key: "u7", state: "stopped" });
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual([out[2].kind, out[2].agent, out[2].key], ["done", "Ajan", "u7"]);
  front = true;
  f.ask({ id: "r3", kind: "approval", sid: "s2", command: "ls" });
  assert.strictEqual(out[3].quiet, true);
  assert.strictEqual(out[0].quiet, undefined);
});

test("PetFeed with notify's textOf: a topic reply's snippet does not repeat the speaker", (t) => {
  const i18n = require("../renderer/i18n");
  i18n.setLanguage("tr");
  t.after(() => i18n.setLanguage("en"));
  const { textOf } = loadNotify();
  const { f, out, flush } = feed({ textOf });
  assert.strictEqual(textOf({ key: "t5", from: "Ajan", text: "Rapor hazır" }), "Ajan: Rapor hazır", "toasts keep the prefix");
  f.message({ key: "t5", id: 8, fromBot: true, from: "Ajan", text: "Rapor hazır: üç kaynağı taradım." });
  f.message({ key: "u7", id: 9, text: "", media: "photo" });
  flush();
  assert.deepStrictEqual(out.map((e) => [e.agent, e.snippet]), [["Ajan", "Rapor hazır: üç kaynağı taradım."], ["Ajan", "[fotoğraf]"]]);
});

test("avatarUrl: only inline images ride along", () => {
  assert.strictEqual(M.avatarUrl("data:image/jpeg;base64,/9j/AA=="), "data:image/jpeg;base64,/9j/AA==");
  assert.strictEqual(M.avatarUrl("https://example.com/a.png"), undefined);
  assert.strictEqual(M.avatarUrl("data:text/html;base64,AAAA"), undefined);
  assert.strictEqual(M.avatarUrl(null), undefined);
});

// ---------------------------------------------------------------- geometry
test("place / windowAt: the bar opens toward the middle, the bubble band stays on screen", () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const c = M.corner(wa);
  const p = M.place(c, wa);
  assert.strictEqual(p.side, "right");
  assert.deepStrictEqual(p.box, { x: 1920 - M.SLOT_W - M.MARGIN, y: 1040 - M.SLOT_H - M.MARGIN });
  const w = M.windowAt(p.box, p.side);
  assert.strictEqual(w.x + w.width, p.box.x + M.SLOT_W, "the box is the window's right end");
  assert.strictEqual(w.y + w.height, p.box.y + M.SLOT_H, "and its bottom");
  assert.strictEqual(w.height, M.BAND_H + M.SLOT_H);

  const left = M.place({ x: 40, y: 500 }, wa);
  assert.strictEqual(left.side, "left");
  assert.strictEqual(M.windowAt(left.box, left.side).x, 40, "the box is the window's left end");

  const top = M.place({ x: 900, y: -50 }, wa); // dragged off the top: pulled down so the bubble fits
  assert.strictEqual(top.box.y, M.BAND_H);
  assert.ok(M.windowAt(top.box, top.side).y >= wa.y);
  const off = M.place({ x: 5000, y: 5000 }, wa);
  assert.deepStrictEqual(off.box, { x: 1920 - M.SLOT_W, y: 1040 - M.SLOT_H });
  const second = M.place({ x: -400, y: 300 }, { x: -1920, y: 0, width: 1920, height: 1080 }); // a display left of the primary
  assert.strictEqual(second.side, "right");
});

test("place: a v1 saved position (the 88 px coin's top-left) is migrated; a v2 one is used as is", () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  // v1 at its default corner: {1816, 936}; read raw it would sit flush with the edges (0 px margin)
  const v1Corner = { x: wa.width - M.COIN_V1 - M.MARGIN, y: wa.height - M.COIN_V1 - M.MARGIN };
  assert.deepStrictEqual(M.place(v1Corner, wa).box, { x: 1920 - M.SLOT_W, y: 1040 - M.SLOT_H }, "unmigrated: flush");
  const migrated = M.place(v1Corner, wa, true);
  assert.deepStrictEqual(migrated.box, M.corner(wa), "the v2 default corner, 16 px margin kept");
  assert.strictEqual(migrated.side, "right");

  // left half: the coin's left and bottom edges are kept, so the figure stands where the coin sat
  const v1Left = { x: 40, y: 500 };
  const left = M.place(v1Left, wa, true);
  assert.deepStrictEqual(left.box, { x: 40, y: 500 + M.COIN_V1 - M.SLOT_H });
  assert.strictEqual(left.side, "left");
  // right half, away from the corner: right and bottom edges kept
  const right = M.place({ x: 1400, y: 500 }, wa, true).box;
  assert.strictEqual(right.x + M.SLOT_W, 1400 + M.COIN_V1);
  assert.strictEqual(right.y + M.SLOT_H, 500 + M.COIN_V1);
  // a v1 coin near the top: still pulled down so the bubble band fits
  assert.strictEqual(M.place({ x: 900, y: 0 }, wa, true).box.y, M.BAND_H);

  // what a drag saves is tagged v2 and comes back unchanged
  const tagged = M.savedPos({ x: 1792.4, y: 880 });
  assert.deepStrictEqual(tagged, { x: 1792, y: 880, v: M.POS_V });
  assert.deepStrictEqual(M.place(tagged, wa, true).box, { x: 1792, y: 880 });
  assert.deepStrictEqual(M.place(M.savedPos(left.box), wa, true).box, left.box, "no double migration");
});

test("pet size: box, band and window scale by k; unknown sizes fall back to 1", () => {
  assert.deepStrictEqual(M.dims(1), { k: 1, sw: 112, sh: 144, band: 88, w: 610, h: 232 });
  assert.deepStrictEqual(M.dims(1.5), { k: 1.5, sw: 168, sh: 216, band: 132, w: 915, h: 348 });
  assert.deepStrictEqual(M.dims(0.75), { k: 0.75, sw: 84, sh: 108, band: 66, w: 458, h: 174 });
  assert.deepStrictEqual(M.dims(3), M.dims(1));
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  for (const k of M.SIZES) {
    const d = M.dims(k);
    const c = M.corner(wa, k);
    assert.deepStrictEqual(c, { x: 1920 - d.sw - M.MARGIN, y: 1040 - d.sh - M.MARGIN }, `corner at ${k}`);
    const p = M.place(c, wa, false, k);
    assert.strictEqual(p.side, "right");
    const w = M.windowAt(p.box, p.side, k);
    assert.deepStrictEqual({ width: w.width, height: w.height }, { width: d.w, height: d.h });
    assert.strictEqual(w.x + w.width, p.box.x + d.sw, `the box is the window's right end at ${k}`);
    assert.strictEqual(w.y + d.band, p.box.y);
  }
});

test("pet size: a resize keeps the bottom edge and the outer side, and stays inside the work area", () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  // right half: the right edge stays put
  const r = M.resize({ x: 1700, y: 800 }, "right", 1, 1.5);
  assert.deepStrictEqual(r, { x: 1700 + 112 - 168, y: 800 + 144 - 216 });
  // left half: the left edge stays put
  assert.deepStrictEqual(M.resize({ x: 40, y: 800 }, "left", 1.5, 0.75), { x: 40, y: 800 + 216 - 108 });
  // back and forth returns to the start
  assert.deepStrictEqual(M.resize(M.resize({ x: 900, y: 600 }, "right", 1, 1.25), "right", 1.25, 1), { x: 900, y: 600 });
  // a pet in the corner grown to 1.5 is pulled back so the box and the bubble band stay on screen
  for (const k of M.SIZES) {
    const d = M.dims(k);
    const p = M.place(M.resize({ x: 1920 - 112, y: 1040 - 144 }, "right", 1, k), wa, false, k);
    assert.ok(p.box.x + d.sw <= 1920 && p.box.y + d.sh <= 1040 && p.box.y - d.band >= 0, `inside at ${k}`);
  }
  const top = M.place({ x: 500, y: 10 }, wa, false, 1.5);
  assert.strictEqual(top.box.y, M.dims(1.5).band, "the band never leaves the top");
});

test("Choreo: a figure's own poses (a cat waits sitting) change the route, not the states", () => {
  const c = new L.Choreo({ waiting: "sit" });
  assert.deepStrictEqual(c.jump("idle"), { type: "loop", name: "idle", pose: "sit", fade: 0 });
  const s = c.set("waiting"); // sitting to sitting: a cross-fade, no strip
  assert.strictEqual(s.type, "loop");
  assert.strictEqual(s.pose, "sit");
  const r = c.set("reply"); // sitting to standing: the stand strip
  assert.deepStrictEqual([r.type, r.name, r.dir], ["strip", "stand", "normal"]);
  assert.strictEqual(new L.Choreo().poses.waiting, "stand", "the default keeps POSE");
});
