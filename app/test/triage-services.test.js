"use strict";
// app.js triage services (contracts.md, Lane E requests): DeckShell.service("openChat") opens a chat through the
// existing navigation only, and DeckShell.service("triageData") is a read-only seed for late modules. The renderer is
// one big script, so the block is cut out of it and run in a vm (as hermes-session-delete.test.js does).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const plain = (x) => JSON.parse(JSON.stringify(x)); // values built inside the vm have its own prototypes
const SRC = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
const START = SRC.indexOf("  // ------------------------------------------------------------ triage services");
const END = SRC.indexOf("  // ------------------------------------------------------------ end triage services");
assert.ok(START > 0 && END > START, "triage services block found in app.js");

function world({ bridge = "open", modes = ["telegram", "sessions", "bots"], mode = "telegram", firstRunDone = true, nodes = ["s-live"], relay = [] } = {}) {
  const calls = [];
  const ctx = {
    S: { settings: { firstRunDone }, relay: { status: "open", sessions: new Map(relay.map((sid) => [sid, { sid }])), agents: { A: { name: "A" } }, fleet: { profiles: {} }, tokens: [{ day: 1 }] } },
    H: { status: { status: bridge }, nodes: new Map(nodes.map((sid) => [sid, { sid, profile: "default" }])), requests: [{ id: "r1", sid: "s-live", kind: "approval" }] },
    mode,
    chatModes: () => modes,
    chatMode: () => ctx.mode,
    hermesMode: () => !!ctx.S.settings.firstRunDone && ctx.mode !== "telegram",
    bridgeOpen: () => ctx.H.status.status === "open",
    setChatChannel(v) { calls.push(["mode", v]); ctx.mode = v; },
    SV: { close: () => calls.push(["settings-close"]) },
    UD: { close: () => calls.push(["usage-close"]) },
    SH: { setMain: (k) => calls.push(["main", k]) },
    hermesSelect: (sid) => calls.push(["select", sid]),
    hermesOpen: (sid, profile) => calls.push(["open", sid, profile]),
    AG: { open: (sid) => calls.push(["detail", sid]) },
  };
  vm.createContext(ctx);
  vm.runInContext(`${SRC.slice(START, END)}\nthis.openChatFor = openChatFor; this.triageData = triageData;`, ctx);
  return { ctx, calls };
}

test("openChat switches from Telegram to Sessions and selects a known direct session", () => {
  const { ctx, calls } = world();
  assert.equal(ctx.openChatFor({ sid: "s-live", profile: "default", origin: "direct" }), true);
  assert.deepEqual(plain(calls), [["mode", "sessions"], ["settings-close"], ["usage-close"], ["main", "chat"], ["select", "s-live"]]);
});

test("openChat opens a session the rail does not list with its profile, and keeps the current Hermes mode", () => {
  const { ctx, calls } = world({ modes: ["sessions"], mode: "sessions" });
  assert.equal(ctx.openChatFor({ sid: "s-stored", profile: "research", origin: "relay" }), true);
  assert.deepEqual(plain(calls), [["settings-close"], ["usage-close"], ["main", "chat"], ["open", "s-stored", "research"]]);
});

test("openChat without the direct connection shows a relay session read-only, else reports false", () => {
  const w = world({ bridge: "closed", relay: ["s-relay"] });
  assert.equal(w.ctx.openChatFor({ sid: "s-relay", profile: "default", origin: "relay" }), true);
  assert.deepEqual(plain(w.calls), [["settings-close"], ["usage-close"], ["main", "chat"], ["detail", "s-relay"]]);
  const none = world({ bridge: "closed" });
  assert.equal(none.ctx.openChatFor({ sid: "s-gone" }), false);
  assert.deepEqual(plain(none.calls), [], "nothing navigates when the session cannot be shown");
});

test("openChat refuses malformed input and the first-run screen", () => {
  const { ctx, calls } = world();
  for (const bad of [null, {}, { sid: 42 }, { sid: "" }]) assert.equal(ctx.openChatFor(bad), false);
  assert.equal(world({ firstRunDone: false }).ctx.openChatFor({ sid: "s-live" }), false);
  assert.deepEqual(plain(calls), []);
});

test("triageData is a copy with bridgeStatus and relay status, never live app state", () => {
  const { ctx } = world({ relay: ["s-relay"] });
  const d = ctx.triageData();
  assert.equal(d.bridgeStatus, "open");
  assert.equal(d.relay.status, "open");
  assert.deepEqual(plain(d.direct.map((n) => n.sid)), ["s-live"]);
  assert.deepEqual(plain(d.relay.sessions.map((s) => s.sid)), ["s-relay"]);
  assert.equal(d.relay.tokens.length, 1);
  d.requests.length = 0;
  assert.equal(ctx.H.requests.length, 1, "the seed's request list is a copy");
});

test("inbox seed accepts the service shape", () => {
  const I = require("../renderer/inbox");
  const { ctx } = world({ relay: ["s-relay"] });
  const store = I.createStore({});
  store.seed(ctx.triageData());
  assert.equal(store.data.bridgeStatus, "open");
  assert.equal(store.data.relayStatus, "open");
  assert.equal(store.data.requests.length, 1);
  assert.deepEqual(plain(store.data.relay.map((s) => s.sid)), ["s-relay"]);
});

// stopTurn (contracts.md, Lane B request): composer Stop through app.js' own control state, no note of its own
function stopWorld(reply) {
  const calls = [];
  const ctx = {
    S: { settings: { firstRunDone: true }, relay: { sessions: new Map() } },
    H: { status: { status: "open" }, nodes: new Map([["s1", { sid: "s1", profile: "default", turnId: "t1" }]]), requests: [], gone: new Map(), live: new Set() },
    deck: { bridge: { interrupt: async (sid, opts) => { calls.push(["interrupt", sid, opts.turnId]); return reply(); } } },
    LA: { end: (sid) => calls.push(["end", sid]) },
    ctlTurnGone: (n, st) => { if (st !== "not_running" && st !== "not_interrupted") return false; calls.push(["gone", n.sid]); return true; },
    mark: () => calls.push(["mark"]),
    cleanErr: (e) => String(e && e.message || e),
    i18nText: (k) => (k === "U0087" ? "No live turn" : k),
  };
  vm.createContext(ctx);
  vm.runInContext(`${SRC.slice(START, END)}\nthis.stopTurnFor = stopTurnFor;`, ctx);
  return { ctx, calls };
}

test("stopTurn interrupts with the node's turn id, ends the live row and resolves with Hermes' status", async () => {
  const { ctx, calls } = stopWorld(() => ({ status: "interrupted" }));
  assert.deepEqual(plain(await ctx.stopTurnFor({ sid: "s1", profile: "default" })), { status: "interrupted" });
  assert.deepEqual(plain(calls), [["interrupt", "s1", "t1"], ["end", "s1"], ["mark"]]);
});

test("stopTurn marks a finished turn gone; the bridge's no-live-turn error resolves as not_running", async () => {
  const a = stopWorld(() => ({ status: "not_running" }));
  assert.deepEqual(plain(await a.ctx.stopTurnFor({ sid: "s1" })), { status: "not_running" });
  assert.ok(a.calls.some((c) => c[0] === "gone"));
  const b = stopWorld(() => { throw new Error("No live turn"); });
  assert.deepEqual(plain(await b.ctx.stopTurnFor({ sid: "s1" })), { status: "not_running" });
});

test("stopTurn passes stale through and rejects other errors with the user-facing text", async () => {
  const a = stopWorld(() => ({ status: "stale" }));
  assert.deepEqual(plain(await a.ctx.stopTurnFor({ sid: "s1" })), { status: "stale" });
  assert.ok(!a.calls.some((c) => c[0] === "gone" || c[0] === "end"));
  const b = stopWorld(() => { throw new Error("link down"); });
  await assert.rejects(b.ctx.stopTurnFor({ sid: "s1" }), /link down/);
  await assert.rejects(stopWorld(() => ({})).ctx.stopTurnFor({}), /No live turn/);
});

test("user bubbles carry their timestamp for receipt anchoring", () => {
  assert.match(SRC, /m\.role === "user" && m\.ts \? \{ dataset: \{ ts: String\(m\.ts\) \} \}/);
});
