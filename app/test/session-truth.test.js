"use strict";
// Session state consistency, renderer tests:
//  - D: a message sent from the Deck with attachments is stored by Hermes as the text plus "@image:<path>" /
//    "@file:<ref>" directive lines; the local echo must settle against that row (it showed twice before).
//    DECK_APP_JS points the settleEcho fixture at another copy of app.js (used to prove it fails on the old code).
//  - C: the Deck-side outbox (outbox.js): enqueue while live, cancel, edit, FIFO auto-drain, error retention.
//  - A/B: deleted-session tombstone, and Stop on a turn Hermes says is not running.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const I18N = require("../renderer/i18n");
const EM = require("../renderer/echo-match");
const OUTBOX = require("../renderer/outbox");
beforeEach(() => I18N.setLanguage("en"));

const SRC = fs.readFileSync(process.env.DECK_APP_JS || path.join(__dirname, "../renderer/app.js"), "utf8");
function fn(name) {
  const m = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(SRC);
  if (!m) return "";
  const end = SRC.indexOf("\n  }\n", m.index);
  return SRC.slice(m.index, end + 5);
}

// ------------------------------------------------------------------ D: echo vs stored row, through app.js settleEcho
function echoWorld() {
  const ctx = { H: { echo: new Map(), live: new Map() }, Date, EM, hermesLiveSegments: () => ({ text: "", sealed: [] }) };
  vm.createContext(ctx);
  vm.runInContext(fn("settleEcho"), ctx);
  const settle = (sid, msgs) => vm.runInContext("settleEcho", ctx)(sid, msgs);
  const left = (sid) => (ctx.H.echo.get(sid) || []).map((e) => e.text);
  return { ctx, settle, left };
}
const row = (text, ts = Date.now() / 1000 + 1, role = "user") => ({ id: String(Math.random()), role, text, ts });

test("D: an echo with text settles against the stored row that has @image: lines appended", () => {
  const w = echoWorld();
  w.ctx.H.echo.set("s", [{ text: "look at this", at: Date.now() }]);
  w.settle("s", [row("look at this\n@image:/data/uploads/pic one.png"), row("seen it", undefined, "assistant")]);
  assert.deepEqual(w.left("s"), []);
});

test("D: every quoting form of @image:/@file: and a [screenshot] placeholder are ignored", () => {
  for (const tail of ["@image:/a/b.png", "@image:`/a/b c.png`", '@image:"/a/b c.png"', "@image:'/a/b c.png'", "@file:uploads/notes.txt", "@image:/a/b.png\n[screenshot]"]) {
    const w = echoWorld();
    w.ctx.H.echo.set("s", [{ text: "caption  text", at: Date.now() }]);
    w.settle("s", [row(`caption text\n\n${tail}`)]);
    assert.deepEqual(w.left("s"), [], tail);
  }
});

test("D: an echo settles against a stored row carrying Hermes' --- Attached Context --- footer (showed twice)", () => {
  const w = echoWorld();
  w.ctx.H.echo.set("s", [{ text: "can you check the report? I attached it", at: Date.now() }]);
  const stored = "can you check the report? I attached it\n\n@file:/home/u/.hermes/attachments/report.bin\n\n" +
    "--- Attached Context ---\n\n📎 @file:/home/u/.hermes/attachments/report.bin (application/octet-stream, 257 B) — binary file, not inlined as text.";
  w.settle("s", [row(stored)]);
  assert.deepEqual(w.left("s"), []);
  assert.equal(EM.normalize(stored), "can you check the report? I attached it");
});

test("D: a file-only echo settles against a row that is only directives, or the default caption", () => {
  for (const stored of ["@image:/a/b.png", "@image:/a/b.png\n@file:uploads/x.pdf", "Please look at the attached file(s).\n\n@file:uploads/x.pdf", "What do you see in this image?\n@image:/a/b.png"]) {
    const w = echoWorld();
    w.ctx.H.echo.set("s", [{ text: "[Files: b.png]", at: Date.now(), files: true }]);
    w.settle("s", [row(stored)]);
    assert.deepEqual(w.left("s"), [], stored);
  }
});

test("D: a different message does not settle the echo, and an older row cannot settle a newer echo", () => {
  const w = echoWorld();
  const at = Date.now();
  w.ctx.H.echo.set("s", [{ text: "same words", at }]);
  w.settle("s", [row("something else\n@image:/a/b.png")]);
  assert.deepEqual(w.left("s"), ["same words"]);
  w.settle("s", [row("same words", at / 1000 - 3600)]); // sent an hour before this echo: an earlier turn
  assert.deepEqual(w.left("s"), ["same words"]);
  w.settle("s", [row("same words", at / 1000 + 2)]);
  assert.deepEqual(w.left("s"), []);
});

test("D: two identical sends settle one stored row each, in order", () => {
  const w = echoWorld();
  const at = Date.now();
  w.ctx.H.echo.set("s", [{ text: "again", at }, { text: "again", at: at + 1000 }]);
  w.settle("s", [row("again", at / 1000 + 1)]);
  assert.equal(w.left("s").length, 1, "one stored row settles only one echo");
  w.settle("s", [row("again", at / 1000 + 1), row("again\n@file:uploads/x.txt", at / 1000 + 3)]);
  assert.deepEqual(w.left("s"), []);
});

test("D: normalize keeps ordinary text, @mentions and inline mentions of @image:", () => {
  assert.equal(EM.normalize("mail me @image:x inline\n@image:/p.png"), "mail me @image:x inline");
  assert.equal(EM.normalize("  a \n\n b\t c "), "a b c");
  assert.equal(EM.normalize("@image:/p.png"), "");
});

// ------------------------------------------------------------------ C: outbox
function memStore() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), m };
}
function outbox(store = memStore(), clock = { t: 1000 }) {
  const el = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(Boolean) });
  return { ob: OUTBOX.create({ store, h: el, i18nText: I18N.t, i18nNode: (k, v) => ({ textContent: I18N.t(k, v) }), now: () => clock.t }), store, clock };
}

test("C: add queues in order, ignores empty text, stops at the maximum and persists per session", () => {
  const { ob, store } = outbox();
  assert.equal(ob.add("s", "  "), null);
  const a = ob.add("s", " first ");
  ob.add("s", "second");
  assert.deepEqual(ob.items("s").map((x) => x.text), ["first", "second"]);
  assert.equal(ob.size("other"), 0);
  assert.ok(JSON.parse(store.get("deck.outbox.s")).length === 2);
  // a fresh instance (renderer reload) reads it back
  const again = outbox(store).ob;
  assert.deepEqual(again.items("s").map((x) => x.text), ["first", "second"]);
  assert.equal(again.remove("s", a.id).text, "first");
  assert.deepEqual(outbox(store).ob.items("s").map((x) => x.text), ["second"]);
  for (let i = 0; i < OUTBOX.MAX + 5; i++) ob.add("full", `m${i}`);
  assert.equal(ob.size("full"), OUTBOX.MAX);
  assert.equal(ob.add("full", "one more"), null);
});

test("C: cancel removes the message and clears storage when the outbox is empty", () => {
  const { ob, store } = outbox();
  const a = ob.add("s", "x");
  assert.equal(ob.remove("s", a.id).text, "x");
  assert.equal(ob.remove("s", a.id), null);
  assert.equal(store.get("deck.outbox.s"), "");
});

test("C: next() waits while the session is live, then yields the head once, FIFO", () => {
  const { ob, clock } = outbox();
  ob.add("s", "one");
  ob.add("s", "two");
  assert.equal(ob.next("s", { live: true }), null, "never while the agent works");
  const head = ob.next("s", { live: false });
  assert.equal(head.text, "one");
  ob.submitted("s");
  assert.equal(ob.next("s", { live: false }), null, "the submitted head's turn has not shown up yet");
  ob.next("s", { live: true }); // its turn is seen running
  assert.equal(ob.next("s", { live: true }), null);
  ob.remove("s", head.id);
  assert.equal(ob.next("s", { live: false }).text, "two", "next one after the turn ended");
  // a turn that never shows up as live does not block the queue forever
  ob.submitted("s");
  assert.equal(ob.next("s", { live: false }), null);
  clock.t += OUTBOX.SETTLE_MS + 1;
  assert.equal(ob.next("s", { live: false }).text, "two");
});

test("C: a head that failed stays in the outbox with its error and blocks the drain until the user acts", () => {
  const { ob } = outbox();
  const a = ob.add("s", "one");
  ob.setError("s", a.id, "offline");
  assert.equal(ob.next("s", { live: false }), null);
  assert.equal(ob.pending("s"), 0);
  assert.equal(ob.size("s"), 1);
  assert.equal(ob.items("s")[0].error, "offline");
  const bubble = ob.bubbles("s", { edit() {}, cancel() {}, sendNow() {} })[0];
  assert.match(JSON.stringify(bubble), /Not sent: offline/);
});

test("C: bubbles show Send now and Cancel; Edit and Interrupt and send sit in the overflow menu, in both languages", () => {
  const { ob } = outbox();
  const a = ob.add("s", "hello");
  const calls = [];
  const walk = (n) => [n, ...(n.kids || []).filter((k) => typeof k === "object").flatMap(walk)];
  const on = { edit: (id) => calls.push(["edit", id]), cancel: (id) => calls.push(["cancel", id]), sendNow: (id) => calls.push(["now", id]), redirect: (id) => calls.push(["redirect", id]), redraw() {} };
  const fks = (b) => walk(b).filter((n) => n.tag === "button").map((n) => n.attrs.dataset.fk.split(":")[0]);
  let bubble = ob.bubbles("s", on)[0];
  assert.deepEqual(fks(bubble), ["outbox-sendnow", "outbox-cancel", "outbox-more"], "closed: Send now and Cancel visible, plus the menu button");
  const cancel = walk(bubble).find((n) => n.tag === "button" && /outbox-cancel/.test(n.attrs.dataset.fk));
  assert.match(cancel.attrs.class, /danger/);
  walk(bubble).find((n) => n.tag === "button" && /outbox-more/.test(n.attrs.dataset.fk)).attrs.onclick({ stopPropagation() {} });
  bubble = ob.bubbles("s", on)[0];
  assert.deepEqual(fks(bubble), ["outbox-sendnow", "outbox-cancel", "outbox-more", "outbox-edit", "outbox-redirect"]);
  for (const b of walk(bubble).filter((n) => n.tag === "button" && /sendnow|cancel|edit|redirect/.test(n.attrs.dataset.fk))) b.attrs.onclick();
  assert.deepEqual(calls, [["now", a.id], ["cancel", a.id], ["edit", a.id], ["redirect", a.id]]);
  assert.match(JSON.stringify(bubble), /"Queued"/);
  assert.match(JSON.stringify(bubble), /Interrupt and send/);
  // no redirect callback (the turn is not controllable) or files on the message: no "Interrupt and send"
  ob.bubbles("s", on)[0]; // menu still closed after picking
  const closed = ob.bubbles("s", { ...on, redirect: null })[0];
  walk(closed).find((n) => n.attrs && n.attrs.dataset && /outbox-more/.test(n.attrs.dataset.fk || "")).attrs.onclick({ stopPropagation() {} });
  assert.ok(!fks(ob.bubbles("s", { ...on, redirect: null })[0]).includes("outbox-redirect"));
  I18N.setLanguage("tr");
  assert.match(JSON.stringify(ob.bubbles("s", on)[0]), /Sırada/);
  assert.match(JSON.stringify(ob.bubbles("s", on)[0]), /İptal/);
});

// ------------------------------------------------------------------ C/A/B through the real app.js functions
function appWorld() {
  const sent = [];
  const steers = [];
  const note = {};
  const { ob } = outbox();
  const ctx = {
    H: { sel: "s", sending: false, nodes: new Map(), echo: new Map(), live: new Map(), hist: new Map(), ctl: new Map(), gone: new Map(), deleted: new Set(), requests: [] },
    S: note, els: { input: { value: "", focus() {} } }, OB: ob, EM, Date, Math,
    RG: { submit() {} },
    BS: require("../renderer/busy-send"), LA: { event() { return false; }, end() { return false; } }, setTimeout: (fn) => fn && 0,
    i18nText: I18N.t, i18nNode: (k) => ({ textContent: I18N.t(k) }), cleanErr: (e) => String((e && e.message) || e),
    TK: require("../renderer/takeover").create({ takeover: async () => ({ok:true,mode:'transferred'}), changed() {}, error() {} }),
    AT: { key: () => "k", queued() {}, sent() {}, render() {}, views: (key, toks) => toks.map((t) => ({ token: t, name: `${t}.png`, size: 3, kind: "photo" })), restore() {}, forget() {} }, BT: null, SB: null,
    // drafts.js stand-in: clears the box when it still holds the sent text, like DeckDrafts.sent for the chat on screen
    DR: { sent(key, text) { if (ctx.els.input.value.trim() === String(text || "").trim()) ctx.els.input.value = ""; } }, autosize() {}, renderNote() {}, mark() {}, hermesPoll() {},
    scrollToEnd: false, bridgeOpen: () => true, hermesMode: () => true, nowS: () => 5000,
    nodeLive: (n) => !!n && n.terminalAt === null && (n.active || n.state === "thinking"),
    nodeControllable: (n) => !!n && n.terminalAt === null && n.controlAvailable && !!n.turnId && !!n.ownerPid,
    CTL_TR: { get queued() { return "q"; } },
    deck: { bridge: { send: async (sid, text, o) => { sent.push([sid, text, o.files]); return { status: "streaming" }; }, steer: async (sid, text) => { steers.push([sid, text]); return { status: ctx.steerStatus || "queued" }; } } },
  };
  vm.createContext(ctx);
  vm.runInContext(["hermesSend", "hermesSteerNow", "outboxFiles", "outboxDrain", "outboxCancel", "outboxEdit", "outboxSendNow", "ctlTurnGone"].map(fn).join("\n") +
    '\nconst goneNode = (n) => ({ ...n, active: false, state: n.state === "error" ? "error" : "idle", terminalAt: n.terminalAt === null ? nowS() : n.terminalAt, controlAvailable: false });\nlet outboxBusy = false;', ctx);
  const run = (code) => vm.runInContext(code, ctx);
  const live = (extra = {}) => ({ sid: "s", profile: "default", state: "thinking", active: true, terminalAt: null, turnId: "t1", ownerPid: 7, controlAvailable: true, ...extra });
  return { ctx, sent, steers, run, live, ob };
}
test('takeover retries the captured chat/profile/text even after switching drafts',async()=>{
 const w=appWorld(),calls=[];w.ctx.H.nodes.set('s',w.live({profile:'alpha',state:'idle',active:false,terminalAt:1}));w.ctx.els.input.value='original';
 w.ctx.deck.bridge.send=async(sid,text,opts)=>{calls.push([sid,text,opts.profile]);if(calls.length===1)throw new Error('open in another UI');return {status:'streaming'};};
 await w.run('hermesSend([],[],{now:true})');assert.ok(w.ctx.TK.pending({sid:'s',profile:'alpha'}));
 w.ctx.H.sel='other';w.ctx.els.input.value='new draft';w.ctx.H.nodes.set('s',w.live({profile:'beta',state:'idle',active:false,terminalAt:1}));
 await w.ctx.TK.run({sid:'s',profile:'alpha'});assert.deepEqual(calls,[['s','original','alpha'],['s','original','alpha']]);assert.equal(w.ctx.els.input.value,'new draft');
});
test('successful takeover retry removes its failed outbox entry exactly once',async()=>{
 const w=appWorld();w.ctx.H.nodes.set('s',w.live({state:'idle',active:false,terminalAt:1}));let calls=0;w.ctx.deck.bridge.send=async()=>{if(++calls===1)throw new Error('another UI');return {status:'streaming'};};
 const item=w.ob.add('s','queued');await w.run(`outboxSendNow(${JSON.stringify(item.id)})`);assert.equal(w.ob.size('s'),1);
 await w.ctx.TK.run({sid:'s',profile:'default'});assert.equal(calls,2);assert.equal(w.ob.size('s'),0);
});
const tick = () => new Promise((r) => setTimeout(r, 5));

test("C: Send while the session works queues in the outbox and submits nothing", async () => {
  const w = appWorld();
  w.ctx.H.nodes.set("s", w.live());
  w.ctx.els.input.value = "later please";
  await w.run("hermesSend()");
  assert.deepEqual(w.sent, []);
  assert.deepEqual(w.ob.items("s").map((x) => x.text), ["later please"]);
  assert.equal(w.ctx.els.input.value, "", "the composer is cleared");
});

test("C: files are queued with the message while the session works, then sent with it", async () => {
  const w = appWorld();
  w.ctx.H.nodes.set("s", w.live());
  w.ctx.els.input.value = "with file";
  await w.run('hermesSend(["tok"], ["a.png"])');
  assert.deepEqual(w.sent, [], "nothing is submitted while it works");
  const [item] = w.ob.items("s");
  assert.equal(item.text, "with file");
  assert.deepEqual(JSON.parse(JSON.stringify(item.files.map((f) => f.token))), ["tok"]);
  assert.equal(w.ctx.els.input.value, "", "the composer is cleared");
  w.ctx.H.nodes.set("s", { ...w.live(), active: false, state: "idle", terminalAt: 4999 });
  w.run("outboxDrain()");
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(w.sent)), [["s", "with file", ["tok"]]], "the queued files go with the queued text");
  assert.equal(w.ob.size("s"), 0);
});

test("C: when the node goes idle the head is submitted once and removed; the next waits for its turn", async () => {
  const w = appWorld();
  w.ctx.H.nodes.set("s", w.live());
  w.ob.add("s", "one");
  w.ob.add("s", "two");
  w.run("outboxDrain()");
  await tick();
  assert.deepEqual(w.sent, [], "still live: nothing sent");
  w.ctx.H.nodes.set("s", w.live({ state: "idle", active: false, terminalAt: 1 }));
  w.run("outboxDrain()");
  await tick();
  assert.deepEqual(w.sent.map((x) => x[1]), ["one"]);
  assert.deepEqual(w.ob.items("s").map((x) => x.text), ["two"]);
  w.run("outboxDrain()");
  await tick();
  assert.deepEqual(w.sent.map((x) => x[1]), ["one"], "the second waits until the first turn has run");
});

test("C: a failed submit keeps the message in the outbox with the error", async () => {
  const w = appWorld();
  w.ctx.deck.bridge.send = async () => { throw new Error("relay down"); };
  w.ctx.H.nodes.set("s", w.live({ state: "idle", active: false, terminalAt: 1 }));
  w.ob.add("s", "one");
  w.run("outboxDrain()");
  await tick();
  assert.equal(w.ob.size("s"), 1);
  assert.equal(w.ob.items("s")[0].error, "relay down");
  w.run("outboxDrain()");
  await tick();
  assert.equal(w.ob.items("s").length, 1, "not retried by itself");
});

test("C: Edit puts the text back in the composer, Cancel drops it, Send now steers a controllable turn", async () => {
  const w = appWorld();
  w.ctx.H.nodes.set("s", w.live());
  const a = w.ob.add("s", "edit me");
  const b = w.ob.add("s", "cancel me");
  const c = w.ob.add("s", "steer me");
  w.ctx.els.input.value = "typing";
  w.run(`outboxEdit(${JSON.stringify(a.id)})`);
  assert.equal(w.ctx.els.input.value, "edit me\ntyping");
  w.run(`outboxCancel(${JSON.stringify(b.id)})`);
  await w.run(`outboxSendNow(${JSON.stringify(c.id)})`);
  assert.deepEqual(w.steers, [["s", "steer me"]]);
  assert.equal(w.ob.size("s"), 0);
});

test("C: Send now on a turn the plugin does not control submits through the normal path", async () => {
  const w = appWorld();
  w.ctx.H.nodes.set("s", w.live({ controlAvailable: false }));
  const a = w.ob.add("s", "now");
  await w.run(`outboxSendNow(${JSON.stringify(a.id)})`);
  assert.deepEqual(w.sent.map((x) => x[1]), ["now"]);
  assert.equal(w.ob.size("s"), 0);
});

// ------------------------------------------------------------------ busy-send: Enter = queue or steer (Settings), Ctrl/Cmd = the other
const steerMode = (w) => { w.ctx.S.settings = { composer: { busySend: "steer" } }; };

test("busy-send: default (no setting) Enter queues; Ctrl/Cmd+Enter steers the running turn at once", async () => {
  const w = appWorld();
  w.ctx.H.nodes.set("s", w.live());
  w.ctx.els.input.value = "later";
  await w.run("hermesSend()");
  assert.deepEqual(w.steers, []);
  assert.deepEqual(w.ob.items("s").map((x) => x.text), ["later"]);
  w.ctx.els.input.value = "now please";
  assert.equal(await w.run('hermesSend([], [], { alt: true })'), true);
  assert.deepEqual(w.steers, [["s", "now please"]]);
  assert.equal(w.ob.size("s"), 1, "the steer is not queued");
  assert.equal(w.ctx.els.input.value, "", "the box clears");
  assert.deepEqual([...w.ctx.H.echo.get("s").map((e) => e.text)], ["now please"], "shown as sent (Hermes stores the steer as the user's words)");
});

test("busy-send: busySend 'steer' steers on Enter; Ctrl/Cmd+Enter queues instead", async () => {
  const w = appWorld();
  steerMode(w);
  w.ctx.H.nodes.set("s", w.live());
  w.ctx.els.input.value = "go left";
  await w.run("hermesSend()");
  assert.deepEqual(w.steers, [["s", "go left"]]);
  w.ctx.els.input.value = "after that";
  await w.run('hermesSend([], [], { alt: true })');
  assert.deepEqual(w.steers.length, 1);
  assert.deepEqual(w.ob.items("s").map((x) => x.text), ["after that"]);
});

test("busy-send: steer falls back to the queue with files, on a turn the plugin does not control, and when Hermes refuses", async () => {
  const w = appWorld();
  steerMode(w);
  w.ctx.H.nodes.set("s", w.live());
  w.ctx.els.input.value = "with file";
  await w.run('hermesSend(["tok"], ["a.png"])');
  assert.deepEqual(w.steers, [], "files never steer");
  assert.equal(w.ctx.S.note, I18N.t("live.fallback.files"));
  w.ctx.H.nodes.set("s", w.live({ controlAvailable: false }));
  w.ctx.els.input.value = "no control";
  await w.run("hermesSend()");
  assert.deepEqual(w.steers, []);
  assert.equal(w.ctx.S.note, I18N.t("live.fallback.control"));
  w.ctx.H.nodes.set("s", w.live());
  w.ctx.steerStatus = "stale";
  w.ctx.els.input.value = "refused";
  await w.run("hermesSend()");
  assert.deepEqual(w.steers.map((x) => x[1]), ["refused"]);
  assert.equal(w.ctx.S.note, I18N.t("live.fallback.steerFailed"));
  assert.deepEqual(w.ob.items("s").map((x) => x.text), ["with file", "no control", "refused"], "nothing is lost");
  assert.equal((w.ctx.H.echo.get("s") || []).length, 0, "a refused steer leaves no 'sent' echo");
});

test("busy-send: an idle session with queued messages keeps their order (no steer, no direct send)", async () => {
  const w = appWorld();
  steerMode(w);
  w.ctx.H.nodes.set("s", w.live({ state: "idle", active: false, terminalAt: 1 }));
  w.ob.add("s", "first");
  w.ctx.els.input.value = "second";
  await w.run('hermesSend([], [], { alt: true })');
  assert.deepEqual(w.steers, []);
  assert.deepEqual(w.sent, []);
  assert.deepEqual(w.ob.items("s").map((x) => x.text), ["first", "second"]);
});

test("B: Stop on a turn Hermes says is not running drops the live state at once and keeps it dropped", () => {
  const w = appWorld();
  w.ctx.H.nodes.set("s", w.live());
  w.ctx.H.live.set("s", { text: "x" });
  assert.equal(w.run('ctlTurnGone(H.nodes.get("s"), "not_running")'), true);
  const n = w.ctx.H.nodes.get("s");
  assert.equal(w.ctx.nodeLive(n), false);
  assert.equal(n.state, "idle");
  assert.equal(w.ctx.H.live.has("s"), false);
  assert.equal(w.run('ctlTurnGone(H.nodes.get("s"), "interrupted")'), false, "other statuses do not clear anything");
});

test("B: a snapshot that still claims the stopped turn is neutralised; a newer turn is live again; deleted ids stay gone", () => {
  const SNAP = fn("applyBridgeSnapshot");
  assert.ok(SNAP, "applyBridgeSnapshot found");
  const w = appWorld();
  Object.assign(w.ctx, { refreshHermesProfiles() {}, hermesRank() {}, hermesAutoSelect() {}, updateBridgeStatusLine() {}, outboxDrain() {}, liveRowRefresh() {} });
  w.ctx.H.snap = [];
  w.ctx.H.stored = new Map();
  vm.runInContext(fn("hermesMergeNodes"), w.ctx);
  w.ctx.goneNode = (n) => ({ ...n, active: false, state: "idle", terminalAt: 5000, controlAvailable: false });
  vm.runInContext(SNAP, w.ctx);
  const apply = (nodes) => vm.runInContext("applyBridgeSnapshot", w.ctx)({ nodes });
  w.ctx.H.gone.set("s", "t1");
  apply([w.live()]);
  assert.equal(w.ctx.nodeLive(w.ctx.H.nodes.get("s")), false, "same turn: still stale");
  apply([w.live({ turnId: "t2" })]);
  assert.equal(w.ctx.nodeLive(w.ctx.H.nodes.get("s")), true, "a newer turn is live");
  assert.equal(w.ctx.H.gone.has("s"), false);
  w.ctx.H.deleted.add("ghost");
  apply([w.live(), w.live({ sid: "ghost" })]);
  assert.deepEqual([...w.ctx.H.nodes.keys()], ["s"], "a deleted session never comes back from a lagging snapshot");
});

test("B: the Stop confirmation is translated, not hardcoded", () => {
  I18N.setLanguage("en");
  assert.equal(I18N.t("session.stopped"), "Stopped.");
  I18N.setLanguage("tr");
  assert.equal(I18N.t("session.stopped"), "Durduruldu.");
  assert.doesNotMatch(SRC, /interrupted:\s*"Durduruldu\./);
});
