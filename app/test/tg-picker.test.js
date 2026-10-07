"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
function fn(name) {
  const start = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(src);
  assert.ok(start, `missing ${name}`);
  return src.slice(start.index, src.indexOf("\n  }\n", start.index) + 5);
}
function world() {
  let picker;
  const n = { sid: "telegram-session", profile: "lab", model: "model-a", effort: "high" };
  const ctx = {
    S: { sel: "u-bot", relay: { status: "open" }, tg: { status: "open" } },
    H: { sel: "unrelated-hermes", nodes: new Map([[n.sid, n]]), hist: new Map() },
    BT: { isDraft: () => false }, SB: { readOnly: () => false },
    hermesMode: () => false, bridgeOpen: () => true,
    liveFor: (key) => key === "u-bot" || key === "t-topic" ? { sid: n.sid } : null,
    h: () => {}, i18nText: (key) => key, cleanErr: () => "", deck: { bridge: {} },
    document: { querySelector: () => ({}) }, els: { send: {} }, LA: {},
    send: async () => true, scopeOf: () => ({ kind: "dm" }), agentList: () => [],
    window: { DeckModelPicker: { create: (opts) => { picker = opts; return {}; } } },
    PK: null,
  };
  vm.createContext(ctx);
  if (src.includes("function composerSession(")) vm.runInContext(fn("composerSession"), ctx);
  const start = src.indexOf("  PK = window.DeckModelPicker.create({");
  vm.runInContext(src.slice(start, src.indexOf("\n  });", start) + 6), ctx);
  return { ctx, n, session: () => picker.session() };
}

test("picker resolves the Hermes node/profile behind a selected Telegram DM or topic, not H.sel", () => {
  const w = world();
  for (const key of ["u-bot", "t-topic"]) {
    w.ctx.S.sel = key;
    const s = w.session();
    assert.ok(s, key);
    assert.equal(s.sid, w.n.sid);
    assert.equal(s.profile, "lab");
    assert.equal(s.node, w.n);
  }
});

test("Telegram custom picker works without mapping, bridge, or relay", () => {
  const w = world();
  w.ctx.S.sel = "u-unmapped";
  assert.equal(w.session().telegram, true);
  assert.equal(w.session().inventory, false);
  w.ctx.H.nodes.clear();
  w.ctx.bridgeOpen = () => false;
  w.ctx.S.relay.status = "closed";
  assert.equal(w.session().key, "u-unmapped");
  w.ctx.S.tg.status = "closed";
  assert.equal(w.session(), null);
});

test("Hermes mode keeps its selected session and excludes drafts/read-only rows", () => {
  const w = world();
  w.ctx.hermesMode = () => true;
  w.ctx.H.nodes.set(w.ctx.H.sel, { sid: w.ctx.H.sel, profile: "default" });
  assert.equal(w.session().sid, "unrelated-hermes");
  w.ctx.BT.isDraft = () => true;
  assert.equal(w.session(), null);
  w.ctx.BT.isDraft = () => false;
  w.ctx.SB.readOnly = () => true;
  assert.equal(w.session(), null);
});

test("Telegram picker uses mapped inventory without a private capability", () => {
  const w = world();
  const s = w.session();
  assert.equal(s.telegram, true);
  assert.equal(s.inventory, true);
  assert.equal(s.switchDisabled, undefined);
});

const MP = require("../renderer/model-picker");
function pickerWorld(session, overrides = {}) {
  function element(tag, attrs = {}, ...kids) {
    const el = { tag, ...attrs, kids: kids.flat().filter(Boolean), classList: { toggle() {} },
      setAttribute(k, v) { this[k] = v; }, appendChild(k) { this.kids.push(k); },
      replaceChildren(...ks) { this.kids = ks.flat().filter(Boolean); }, focus() {},
      contains() { return false; }, querySelector() { return null; } };
    return el;
  }
  const oldDocument = global.document;
  const oldWindow = global.window;
  const oldFrame = global.requestAnimationFrame;
  global.requestAnimationFrame = () => {};
  global.document = { createElementNS: (_ns, tag) => element(tag), addEventListener() {} };
  global.window = { addEventListener() {} };
  const calls = [];
  const composer = element("div");
  const parent = { insertBefore(bar) { this.bar = bar; } };
  let thinking = false;
  try {
    const picker = MP.create({ h: element, composer, send: { parentNode: parent },
      i18nText: (key) => key, session: () => session.value,
      bridge: { modelOptions: () => { calls.push("options"); return Promise.resolve({ options: [] }); },
        setModel: () => calls.push("model"), setEffort: () => calls.push("effort") },
      thinking: { isOpen: () => thinking, setOpen: (v) => { thinking = v; } }, note() {}, cleanErr: String, ...overrides });
    picker.sync();
    const restore = () => { global.document = oldDocument; global.window = oldWindow; global.requestAnimationFrame = oldFrame; };
    return { picker, bar: parent.bar, pop: composer.kids[0], calls, thinking: () => thinking, restore };
  } catch (e) { global.document = oldDocument; global.window = oldWindow; global.requestAnimationFrame = oldFrame; throw e; }
}

test("Telegram chips do not offer switches against a different TUI runtime; Show thinking stays usable", (t) => {
  const w = world();
  assert.equal(w.session().telegram, true);
  const s = { value: { ...w.session(), switchDisabled: "Use /model or /reasoning in Telegram" } };
  const p = pickerWorld(s);
  t.after(p.restore);
  assert.equal(p.bar.hidden, false);
  assert.equal(p.bar.kids[0].disabled, true);
  assert.equal(p.bar.kids[0].title, s.value.switchDisabled);
  // Use the public picker action, not a browser/DOM probe.
  p.bar.kids[1].onclick();
  const items = p.pop.kids[0].kids;
  const levels = items.filter((x) => x.role === "menuitemradio");
  assert.equal(levels.length, MP.EFFORTS.length);
  assert.ok(levels.every((x) => x.disabled && x.title === s.value.switchDisabled));
  const toggle = items.find((x) => x.role === "menuitemcheckbox");
  toggle.onclick();
  assert.equal(p.thinking(), true);
  assert.deepEqual(p.calls, [], "no resume/options/config mutation for the external Telegram runtime");
  s.value = null;
  p.picker.sync();
  assert.equal(p.bar.hidden, true);
  assert.equal(p.pop.hidden, true);
});

test("unavailable Telegram controls have disabled styling and popover focus skips them", (t) => {
  const p = pickerWorld({ value: { sid: "s", node: { effort: "high" }, switchDisabled: "Unavailable" } });
  t.after(p.restore);
  const selectors = [];
  p.pop.querySelector = (selector) => { selectors.push(selector); return null; };
  global.requestAnimationFrame = (f) => f();
  p.bar.kids[1].onclick();
  assert.ok(selectors.length >= 1);
  assert.ok(selectors.every((selector) => selector.includes(":not(:disabled)")));
  const css = fs.readFileSync(path.join(__dirname, "../renderer/model-picker.css"), "utf8");
  assert.match(css, /\.pick-chip:disabled/);
  assert.match(css, /\.pick-item:disabled/);
});

test("Telegram selection waits for Change model, sends once, and stays pending until bot reply", async (t) => {
  const session = { value: { sid: "s-tg", key: "u-bot", profile: "lab", telegram: true, inventory: true, node: { model: "chat-model", provider: "custom:lab", effort: "high" } } };
  const requests = [];
  const p = pickerWorld(session, { sendCommand: async (text, key) => { requests.push(["send", key, text]); return true; }, bridge: {
    modelOptions: async (sid, opts) => { requests.push(["options", sid, opts]); return { current: { model: "profile-model", provider: "p" }, options: [{ id: "model-next", provider: "custom:lab", providerCurrent: true }] }; },
    setModel: () => assert.fail("Telegram must not use config.set"), setEffort: () => assert.fail("Telegram must not use config.set"),
  } });
  t.after(p.restore);
  p.picker.openModel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests[0], ["options", "s-tg", { profile: "lab", profileOnly: true }]);
  const walk = (el) => [el, ...(el.kids || []).filter((x) => typeof x === "object").flatMap(walk)];
  walk(p.pop).find((x) => x.class?.includes("pick-row") && x.title === "@custom:lab:model-next").onclick();
  assert.equal(requests.length, 1, "selecting a row does not send");
  const list = walk(p.pop).find((x) => x.role === "listbox");
  assert.equal(list.kids[1].title, "@custom:lab:chat-model", "Current stays on the reported model, not the candidate");
  const change = walk(p.pop).find((x) => x.class?.includes("pick-change"));
  assert.equal(change.kids[0], "pick.changeModel");
  assert.equal(change.disabled, false);
  change.onclick();
  change.onclick();
  assert.equal(p.bar.kids[0].kids[0].textContent, "model-next");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests[1], ["send", "u-bot", "/model model-next --provider custom:lab --session"]);
  assert.equal(requests.length, 2, "double click is one send");
  assert.match(p.bar.kids[0].title, /pick.pending/);
  p.picker.sync();
  assert.equal(p.bar.kids[0].kids[0].textContent, "model-next", "stale report cannot erase pending choice");
  p.picker.telegramReply("u-other");
  assert.match(p.bar.kids[0].title, /pick.pending/);
  session.value.node.model = "model-next";
  p.picker.telegramReply("u-bot");
  assert.doesNotMatch(p.bar.kids[0].title, /pick.pending/);
  p.bar.kids[1].onclick();
  p.pop.kids[0].kids.find((x) => x.role === "menuitemradio" && x.kids[0] === "pick.effort.low").onclick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests.at(-1), ["send", "u-bot", "/reasoning low"]);
});


test("picker commands use normal Telegram send, preserve drafts/files, and paint chat history", async () => {
  const w = composerWorld();
  const sent = [], history = new Map();
  w.ctx.els.input.value = "unsent draft";
  Object.assign(w.ctx, { MV: { replyTarget: () => 99, clearReply: () => assert.fail("reply draft cleared") },
    DR: { sent: () => assert.fail("text draft cleared") }, msgMap: () => history,
    AT: { pending: () => true, send: () => assert.fail("staged files sent with command") },
    scrollToEnd: false });
  w.ctx.deck.send = async (...args) => { sent.push(args); return { key: "u-bot", id: 1, text: args[1] }; };
  assert.equal(await w.run('send({ command: "/reasoning high", key: "u-bot" })'), true);
  assert.deepEqual(sent, [["u-bot", "/reasoning high", undefined]]);
  assert.equal(history.get(1).text, "/reasoning high");
  assert.equal(w.ctx.els.input.value, "unsent draft");
  assert.equal(w.ctx.S.sending, false);
  w.ctx.S.sel = "u-other";
  assert.equal(await w.run('send({ command: "/reasoning low", key: "u-bot" })'), false);
  assert.equal(sent.length, 1, "stale picker must not send into a different selected chat");
});

test("unmapped Telegram custom selection uses Change model; Enter is its shortcut", async (t) => {
  const sent = [];
  const p = pickerWorld({ value: { sid: "tg:u-bot", key: "u-bot", telegram: true, inventory: false, node: null } }, {
    sendCommand: async (...args) => { sent.push(args); return true; },
  });
  t.after(p.restore);
  p.picker.openModel();
  assert.deepEqual(p.calls, [], "no bridge calls for unmapped chat");
  assert.equal(p.pop.kids.some((x) => x.class === "pick-searchrow" || x.role === "listbox"), false, "unmapped chat is custom-only, not a loading inventory");
  const row = p.pop.kids.find((x) => x.class === "pick-customrow");
  row.kids[0].value = "@custom:lab:claude-opus-5-5[1m]";
  row.kids[1].onclick();
  assert.deepEqual(sent, [], "custom add selects without sending");
  const change = p.pop.kids.find((x) => x.class === "pick-actions").kids[0];
  assert.equal(change.disabled, false);
  change.onclick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [["/model claude-opus-5-5[1m] --provider custom:lab --session", "u-bot"]]);
  p.picker.openModel();
  const next = p.pop.kids.find((x) => x.class === "pick-customrow").kids[0];
  next.value = "@p:model-two";
  next.onkeydown({ key: "Enter", preventDefault() {} });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent.at(-1), ["/model model-two --provider p --session", "u-bot"]);
});

test("Hermes picker still switches immediately through config bridge", async (t) => {
  const calls = [];
  const p = pickerWorld({ value: { sid: "s-cli", profile: "lab", node: { model: "m", provider: "p" } } }, { bridge: {
    modelOptions: async () => ({ options: [] }),
    setModel: async (...args) => { calls.push(["model", ...args]); return {}; },
    setEffort: async (...args) => { calls.push(["effort", ...args]); return {}; },
  }, sendCommand: () => assert.fail("Hermes mode must not send a Telegram command") });
  t.after(p.restore);
  p.picker.openModel();
  await new Promise((r) => setImmediate(r));
  const custom = p.pop.kids.find((x) => x.class === "pick-customrow").kids[0];
  custom.value = "@p:model-next";
  custom.onkeydown({ key: "Enter", preventDefault() {} });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls[0], ["model", "s-cli", { model: "model-next", provider: "p", confirm: false, profile: "lab" }]);
  p.bar.kids[1].onclick();
  p.pop.kids[0].kids.find((x) => x.role === "menuitemradio" && x.kids[0] === "pick.effort.low").onclick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls[1], ["effort", "s-cli", { effort: "low", profile: "lab" }]);
});

test("only a fresh bot reply settles Telegram pending picks", () => {
  const w = world();
  let receive;
  const replies = [], histories = new Map();
  w.ctx.deck.onTelegram = (f) => { receive = f; };
  Object.assign(w.ctx, { PK: { telegramReply: (key) => replies.push(key) },
    msgMap: (key) => { if (!histories.has(key)) histories.set(key, new Map()); return histories.get(key); }, mark() {} });
  w.ctx.S.unread = new Map();
  const start = src.indexOf("  deck.onTelegram((m) => {");
  vm.runInContext(src.slice(start, src.indexOf("\n  });", start) + 6), w.ctx);
  for (const [t, m] of [["msg", { key: "t-topic", id: 1, out: false, fromBot: false }],
    ["msg", { key: "t-topic", id: 2, out: true, fromBot: true }],
    ["edit", { key: "t-topic", id: 3, out: false, fromBot: true }],
    ["msg", { key: "t-topic", id: 4, out: false, fromBot: true }],
    ["msg", { key: "t-topic", id: 4, out: false, fromBot: true }]]) receive({ t, m });
  assert.deepEqual(replies, ["t-topic"]);
});

test("a stale open picker cannot switch the newly selected Telegram chat", async (t) => {
  const session = { value: { sid: "tg:u-one", key: "u-one", telegram: true, inventory: false } };
  const sent = [];
  const p = pickerWorld(session, { sendCommand: async (...args) => { sent.push(args); return true; } });
  t.after(p.restore);
  p.picker.openModel();
  const row = p.pop.kids.find((x) => x.class === "pick-customrow");
  row.kids[0].value = "@p:m";
  row.kids[1].onclick();
  const change = p.pop.kids.find((x) => x.class === "pick-actions").kids[0];
  session.value = { sid: "tg:u-two", key: "u-two", telegram: true, inventory: false };
  change.onclick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, []);
});

test("custom-only Telegram picker focuses the visible input", (t) => {
  const p = pickerWorld({ value: { sid: "tg:u-bot", key: "u-bot", telegram: true, inventory: false } });
  t.after(p.restore);
  let frame, focused = false;
  global.requestAnimationFrame = (f) => { frame = f; };
  p.picker.openModel();
  p.pop.kids.find((x) => x.class === "pick-customrow").kids[0].focus = () => { focused = true; };
  frame();
  assert.equal(focused, true);
});

test("mapped forum topic commands address its owning bot", () => {
  const w = world();
  w.ctx.S.sel = "t-topic";
  w.ctx.scopeOf = () => ({ kind: "topic" });
  w.ctx.liveFor = () => ({ sid: w.n.sid, agent: "Example" });
  w.ctx.agentList = () => [{ name: "Other", bot: "other_bot" }, { name: "Example", bot: "example_bot" }];
  assert.equal(w.session().bot, "example_bot");
  assert.equal(MP.modelCommand({ id: "model-a", provider: "p" }, w.session().bot), "/model@example_bot model-a --provider p --session");
});

test("Telegram command send failure restores the reported reasoning level", async (t) => {
  const notes = [];
  const p = pickerWorld({ value: { sid: "tg:u-bot", key: "u-bot", telegram: true, inventory: false, node: { effort: "medium" } } }, {
    sendCommand: async () => { throw new Error("offline"); }, note: (...args) => notes.push(args),
  });
  t.after(p.restore);
  p.bar.kids[1].onclick();
  p.pop.kids[0].kids.find((x) => x.role === "menuitemradio" && x.kids[0] === "pick.effort.high").onclick();
  await new Promise((r) => setImmediate(r));
  assert.equal(p.bar.kids[1].kids[0].textContent, "pick.effort.medium");
  assert.deepEqual(notes.at(-1), ["pick.effortFailed", true]);
});

function composerWorld() {
  const w = world();
  const calls = [];
  Object.assign(w.n, { terminalAt: null, active: true, controlAvailable: true, turnId: "turn-tg", ownerPid: 42 });
  Object.assign(w.ctx, {
    AT: { pending: () => false }, PK: { sync() {} },
    els: { input: { value: "" }, note: {}, send: { dataset: {}, classList: { toggle() {} } } },
    i18nBind: (el, field, key) => { el[field] = key; },
    workspace: null, mark() {}, ctlTurnGone: () => false, CTL_TR: {},
    hermesComposerState: () => null,
  });
  w.ctx.LA.end = (sid) => calls.push(["end", sid]);
  w.ctx.deck.bridge.interrupt = async (sid, opts) => { calls.push(["interrupt", sid, opts.turnId]); return { status: "interrupted" }; };
  vm.runInContext(src.match(/^  const nodeLive = .*$/m)[0] + "\n" + src.match(/^  const nodeControllable = .*$/m)[0], w.ctx);
  if (src.includes("function telegramComposerState(")) vm.runInContext(fn("telegramComposerState"), w.ctx);
  vm.runInContext(["renderNote", "send", "hermesStopNow"].map(fn).join("\n"), w.ctx);
  return { ...w, calls, run: (code) => vm.runInContext(code, w.ctx) };
}

test("Telegram Send becomes Stop only for an empty composer and a mapped live controllable/bound node", () => {
  const w = composerWorld();
  w.run("renderNote()");
  assert.equal(w.ctx.els.send.dataset.kind, "stop");
  assert.equal(w.ctx.els.send.disabled, false);
  w.n.controlAvailable = false;
  w.run("renderNote()");
  assert.equal(w.ctx.els.send.dataset.kind, "send");
  w.n.bound = true;
  w.run("renderNote()");
  assert.equal(w.ctx.els.send.dataset.kind, "stop");
  w.n.active = false;
  w.n.terminalAt = 1;
  w.run("renderNote()");
  assert.equal(w.ctx.els.send.dataset.kind, "send");
  w.n.active = true;
  w.n.terminalAt = null;
  w.ctx.els.input.value = "draft";
  w.run("renderNote()");
  assert.equal(w.ctx.els.send.dataset.kind, "send", "Telegram text still sends through Telegram");
  w.ctx.els.input.value = "";
  w.ctx.AT.pending = () => true;
  w.run("renderNote()");
  assert.equal(w.ctx.els.send.dataset.kind, "send", "attachments are never stopped instead of sent");
  w.ctx.AT.pending = () => false;
  w.ctx.bridgeOpen = () => false;
  w.run("renderNote()");
  assert.equal(w.ctx.els.send.dataset.kind, "send");
});

test("Telegram Stop interrupts the mapped node and its turn, not the unrelated Hermes selection", async () => {
  const w = composerWorld();
  await w.run("send()");
  assert.deepEqual(w.calls, [["interrupt", w.n.sid, "turn-tg"], ["end", w.n.sid]]);
  assert.equal(w.ctx.H.stopping, null);
  assert.equal(w.ctx.S.note, null);
});

test("Telegram selection/head refresh synchronizes both chips and Stop even with held header focus", () => {
  const w = composerWorld();
  let notes = 0;
  w.ctx.renderNote = () => { notes++; };
  w.ctx.holdRegion = () => true;
  vm.runInContext(fn("renderHead"), w.ctx);
  w.run("renderHead()");
  assert.equal(notes, 1);
});

test("relay status changes schedule the head/composer alongside session updates", () => {
  const w = world();
  const marks = [];
  let onRelay;
  Object.assign(w.ctx, { AG: null, mark: (...parts) => marks.push(parts), applyDetail() {}, applyDialogs() {} });
  w.ctx.S.tg.bots = [];
  w.ctx.S.relay.sessions = new Map();
  w.ctx.deck.onRelay = (f) => { onRelay = f; };
  const start = src.indexOf("  deck.onRelay((m) => {");
  vm.runInContext(src.slice(start, src.indexOf("\n  });", start) + 6), w.ctx);
  for (const frame of [{ t: "status", status: "closed" }, { t: "snapshot", sessions: [] }, { t: "evs", sessions: [], evs: [] }]) {
    onRelay(frame);
    assert.ok(marks.pop().includes("head"), frame.t);
  }
});

test("bridge snapshots refresh Telegram Stop without requiring Hermes mode", () => {
  const w = world();
  let notes = 0;
  Object.assign(w.ctx.H, { deleted: new Set(), gone: new Map(), ctl: new Map() });
  Object.assign(w.ctx, { hermesRank() {}, hermesMergeNodes() {}, outboxDrain() {},
    updateBridgeStatusLine() {}, mark() {}, liveRowRefresh() {}, renderNote: () => { notes++; } });
  vm.runInContext(fn("applyBridgeSnapshot"), w.ctx);
  vm.runInContext("applyBridgeSnapshot({nodes: []})", w.ctx);
  assert.equal(notes, 1);
});




test("model popover never hands null to replaceChildren (native DOM prints it as \"null\")", async (t) => {
  for (const telegram of [true, false]) {
    const session = { value: { sid: "s-x", key: "u-bot", profile: "lab", telegram, inventory: true, node: { model: "m1", provider: "p" } } };
    const p = pickerWorld(session, { sendCommand: async () => true, bridge: {
      modelOptions: async () => ({ options: [{ id: "m1", provider: "p", providerCurrent: true }] }), setModel: async () => ({}), setEffort: async () => ({}) } });
    t.after(p.restore);
    const raw = [];
    p.pop.replaceChildren = function (...ks) { raw.push(ks); this.kids = ks.flat().filter(Boolean); };
    p.picker.openModel();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(raw.length >= 1);
    for (const args of raw) assert.ok(args.every((k) => k !== null && k !== undefined), `telegram=${telegram}: null child`);
  }
});

test("a bot reply naming the picked model keeps it on the chip until the session reports it", async (t) => {
  const session = { value: { sid: "s-tg", key: "u-bot", profile: "lab", telegram: true, inventory: true, node: { model: "old-model", provider: "custom:lab", effort: "high" } } };
  const p = pickerWorld(session, { sendCommand: async () => true, bridge: {
    modelOptions: async () => ({ options: [{ id: "new-model[1m]", provider: "custom:lab", providerCurrent: true }] }) } });
  t.after(p.restore);
  p.picker.openModel();
  await new Promise((resolve) => setImmediate(resolve));
  const walk = (el) => [el, ...(el.kids || []).filter((x) => typeof x === "object").flatMap(walk)];
  walk(p.pop).find((x) => x.class?.includes("pick-row") && x.title === "@custom:lab:new-model[1m]").onclick();
  walk(p.pop).find((x) => x.class?.includes("pick-change")).onclick();
  await new Promise((resolve) => setImmediate(resolve));
  p.picker.telegramReply("u-bot", "Model switched to new-model[1m]\nProvider: Lab");
  p.picker.sync();
  assert.equal(p.bar.kids[0].kids[0].textContent, "new-model[1m]", "confirmed pick shown while the node still says old-model");
  assert.doesNotMatch(p.bar.kids[0].title, /pick.pending/);
  session.value.node.model = "new-model[1m]";
  p.picker.sync();
  assert.equal(p.bar.kids[0].kids[0].textContent, "new-model[1m]");
  p.bar.kids[1].onclick();
  walk(p.pop).find((x) => x.role === "menuitemradio" && x.kids[0] === "pick.effort.low").onclick();
  await new Promise((resolve) => setImmediate(resolve));
  p.picker.telegramReply("u-bot", "Unknown reasoning level");
  p.picker.sync();
  assert.equal(p.bar.kids[1].kids[0].textContent, "pick.effort.high", "a reply that does not confirm the level reverts to the reported one");
});
