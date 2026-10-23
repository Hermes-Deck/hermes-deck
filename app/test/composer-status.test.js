"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot } = require("./composer-dom-helper");
const node = (extra = {}) => ({ sid: "s", profile: "default", state: "working", turnId: "t1", controlAvailable: true, ownerPid: 7, steps: ["read_file", "terminal"], model: "model-example", ...extra });
const snap = (env, ...nodes) => { env.bridgeEvent({ t: "snapshot", snapshot: { nodes } }); env.flush(); };
const get = (env, cls) => env.doc.querySelector(`.conv-${cls}`);
const slot = env => env.doc.getElementById("composer-status");

// Exercise app.js's actual selected-chat adapter, not a second implementation of its routing.
function appActivity() {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
  const LA = require("../renderer/live-activity");
  const ctx = { hostSwitchPending: false, direct: true, online: true,
    chat: { id: "s", sid: "s", profile: "default", agent: "Example" },
    H: { sel: "s", nodes: new Map(), requests: [] }, BT: null,
    S: { sel: "chat", relay: { status: "open" }, details: new Map() },
    window: { DeckLiveActivity: LA }, LA: LA.create({}),
    hermesMode: () => ctx.direct, bridgeOpen: () => ctx.online, currentChat: () => ctx.chat,
    nodeLive: require("../renderer/composer").nodeLive, liveFor: () => ctx.relay,
    isLive: s => s.state === "running" && !s.stale, stateOf: s => s.stale ? "stale" : s.state,
  };
  vm.createContext(ctx);
  for (const name of ["hermesLiveView", "composerActivity", "applyDetail", "toggleTools"]) vm.runInContext(source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  }`))[0], ctx);
  ctx.source = source; ctx.run = code => vm.runInContext(code, ctx);
  return ctx;
}

test("relay events populate recent steps from an empty cache without opening Work", async () => {
  const app = appActivity(); app.direct = false;
  app.relay = { sid: "s", state: "running", agent: "Worker" };
  app.applyDetail({ ev: "message", sid: "s" });
  assert.equal(app.S.details.size, 0);
  for (const [call, tool] of [["c1", "web_search"], ["c2", "read_file"]]) {
    app.applyDetail({ ev: "tool_start", sid: "s", call, tool, ts: 100 });
    app.applyDetail({ ev: "tool_end", sid: "s", call, status: "ok", ms: 20 });
  }
  app.relay.state = "done";
  assert.deepEqual(Array.from(app.composerActivity().steps), ["web_search", "read_file"]);
  assert.equal(app.S.details.get("s").recent[0].status, "ok");
  let reads = 0;
  app.S.open = new Set(); app.mark = () => {};
  const history = [{ tool: "older_tool" }, ...app.S.details.get("s").recent];
  app.deck = { session: async () => { reads++; return { recent: history }; } };
  await app.toggleTools("s");
  assert.equal(reads, 1, "observed-only cache must not prevent loading full tool history");
  assert.deepEqual(Array.from(app.composerActivity().steps), ["older_tool", "web_search", "read_file"]);
});

test("failed history reads preserve observed steps and retry on reopen", async () => {
  const app = appActivity(); app.direct = false;
  app.relay = { sid: "s", state: "running", agent: "Worker" };
  app.S.open = new Set(); app.mark = () => {}; app.cleanErr = String;
  app.applyDetail({ ev: "tool_start", sid: "s", call: "c1", tool: "read_file", ts: 100 });
  let reads = 0;
  app.deck = { session: async () => {
    reads++;
    if (reads === 1) {
      app.applyDetail({ ev: "tool_start", sid: "s", call: "c2", tool: "terminal", ts: 101 });
      throw new Error("offline");
    }
    return { recent: [{ call: "c1", tool: "read_file", ts: 100 }] };
  } };
  await app.toggleTools("s");
  assert.deepEqual(Array.from(app.composerActivity().steps), ["read_file", "terminal"]);
  assert.match(app.S.details.get("s").error, /offline/);
  await app.toggleTools("s"); await app.toggleTools("s");
  assert.equal(reads, 2);
  assert.equal(app.S.details.get("s").error, undefined);
  assert.deepEqual(Array.from(app.composerActivity().steps), ["read_file", "terminal"], "newer observed calls survive an older server snapshot");
});

test("topic status names the selected relay worker, not the Telegram group", () => {
  const app = appActivity(); app.direct = false;
  app.S.settings = { firstRunDone: true }; app.S.sel = "t42";
  app.S.tg = { group: { id: "g1", title: "Team room" }, topics: [{ id: 42, title: "Work" }] };
  app.S.relay.sessions = new Map([["s", { sid: "s", state: "running", agent: "Worker", chat: "g1", thread: "42" }]]);
  app.chatMode = () => "telegram"; app.SH = { channelOf: () => "telegram" };
  app.run('const threadIs = (thread, tid) => thread === tid || thread === `t${tid}`;');
  for (const name of ["scopeOf", "inChat", "sessionsFor", "liveFor", "currentChat"]) app.run(app.source.match(new RegExp(`  function ${name}\\([^]*?\\n  }`))[0]);
  assert.equal(app.currentChat().agent, "Team room");
  assert.equal(app.composerActivity().agent, "Worker");
});

test("actual app adapter follows relay tools, completed/stale status and connection instead of old bridge nodes", () => {
  const app = appActivity(); app.direct = false;
  app.relay = { sid: "s", state: "running", curTool: { tool: "read_file", since: 100 }, model: "model-example" };
  app.S.details.set("s", { recent: [{ tool: "web_search" }, { tool: "read_file" }] });
  assert.equal(app.composerActivity().tool, "read_file");
  assert.equal(app.composerActivity().since, 100000);
  assert.equal(app.composerActivity().source, "relay");
  assert.equal(app.composerActivity().node, undefined);
  assert.deepEqual(Array.from(app.composerActivity().steps), ["web_search", "read_file"]);
  app.relay.state = "done";
  assert.equal(app.composerActivity().label.key, "status.completed");
  assert.equal(app.composerActivity().tool, "");
  app.relay.state = "running"; app.relay.stale = true;
  assert.equal(app.composerActivity().label.key, "status.stale");
  app.S.relay.status = "closed";
  assert.equal(app.composerActivity().phase, "disconnected");
  app.hostSwitchPending = true;
  assert.equal(app.composerActivity(), null);
});

test("actual direct adapter respects event completion, host switch, profile boundary and disconnect", () => {
  const app = appActivity(); app.H.nodes.set("s", node());
  assert.equal(app.composerActivity().tool, "terminal");
  app.LA.event("s", "message.start");
  app.LA.event("s", "message.complete");
  assert.equal(app.composerActivity().phase, "idle", "lagging node cannot restart completed event state");
  app.H.nodes.set("s", node({ profile: "other" }));
  assert.equal(app.composerActivity(), null);
  app.online = false;
  assert.equal(app.composerActivity().phase, "disconnected");
  app.hostSwitchPending = true;
  assert.equal(app.composerActivity(), null);
});

test("status visibility uses the app's existing per-host storage keys", () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
  const storage = new Map();
  function forHost(host) {
    const ctx = { URLSearchParams, location: { search: `?host=${host}` },
      localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) } };
    vm.createContext(ctx);
    const start = source.indexOf("  const pageHost ="), end = source.indexOf("  // ---------------------------------------------------------------- derived views", start);
    vm.runInContext(source.slice(start, end) + "\nthis.storage = store;", ctx);
    return ctx.storage;
  }
  forHost("h1").set("deck.status.hidden", "1");
  assert.equal(forHost("h1").get("deck.status.hidden"), "1");
  assert.equal(forHost("h2").get("deck.status.hidden"), null);
  forHost("h2").set("deck.status.hidden", "0");
  assert.equal(forHost("h1").get("deck.status.hidden"), "1");
});

test("Stop rechecks canonical activity at click time after host-switch or disconnect", async () => {
  const env = boot(); let current = { sid: "s", phase: "tool", tool: "terminal", node: node(), since: env.clock };
  const base = env.win.DeckShell.service;
  env.win.DeckShell.service = key => key === "composerActivity" ? () => current : base(key);
  env.emitShell("activity", {});
  assert.equal(get(env, "stop").disabled, false);
  current = null; // host switch began, before the next paint
  get(env, "stop").click(); await env.settle();
  assert.equal(env.mutations.length, 0);
  assert.equal(get(env, "stop").disabled, true);
});

test("status starts collapsed, expands real steps/model, and opens the existing Work pane", () => {
  const env = boot(); snap(env, node());
  assert.equal(slot(env).parentNode, env.chat);
  assert.equal(get(env, "expand").getAttribute("aria-expanded"), "false");
  assert.equal(get(env, "details").hidden, true);
  get(env, "expand").click();
  assert.equal(get(env, "expand").getAttribute("aria-expanded"), "true");
  assert.equal(get(env, "details").hidden, false);
  assert.match(get(env, "details").textContent, /read_file.*terminal/);
  assert.match(get(env, "model").textContent, /model-example/);
  get(env, "work").click();
  assert.deepEqual(env.opens, [["work", "run"]]);
  get(env, "expand").click();
  assert.equal(get(env, "details").hidden, true);
});

test("full hide persists through updates, session switches and reload; toolbar restores without changing the draft", () => {
  const store = new Map(), env = boot({ store }); snap(env, node());
  get(env, "hide").focus(); get(env, "hide").click();
  assert.equal(slot(env).hidden, true);
  assert.equal(env.doc.activeElement, get(env, "visibility"));
  assert.equal(get(env, "visibility").getAttribute("aria-pressed"), "false");
  snap(env, node({ steps: ["web_search"] }));
  env.select({ id: "b", sid: "b", kind: "hermes", profile: "default" });
  snap(env, node({ sid: "b" }));
  assert.equal(slot(env).hidden, true);
  const reloaded = boot({ store }); snap(reloaded, node());
  assert.equal(slot(reloaded).hidden, true);
  get(reloaded, "visibility").click();
  assert.equal(slot(reloaded).hidden, false);
  assert.equal(get(reloaded, "details").hidden, true);
  assert.equal(reloaded.input.value, "Retained draft");
  assert.equal(boot().win.DeckShell.service("store").get("deck.status.hidden"), undefined, "another host's store is independent");
});

test("hide leaves approval/question nodes, handlers and focus reachable independently", () => {
  const env = boot(); snap(env, node());
  let answers = 0;
  const approve = env.h("button", { onclick: () => answers++ }, "Allow once");
  const field = env.h("input", { class: "hreq-text", dataset: { fk: "question:sample" } });
  env.inner.append(env.h("section", { class: "hreq", "data-i18n-aria-label": "U0603" }, approve), env.h("section", { class: "hreq" }, field));
  env.flush();
  get(env, "hide").click();
  const tray = get(env, "tray");
  assert.equal(slot(env).hidden, true);
  assert.equal(tray.hidden, false);
  assert.equal(tray.contains(approve), true);
  assert.equal(answers, 0, "hide never answers");
  field.focus(); assert.equal(env.doc.activeElement, field);
  approve.click(); assert.equal(answers, 1);
  assert.equal(env.mutations.length, 0);
});

test("completed/disconnected turns cannot resurrect from a stale snapshot, and snapshot steps refresh", () => {
  const env = boot(); snap(env, node());
  snap(env, node({ steps: ["web_search"] }));
  assert.match(get(env, "step").textContent, /web_search/);
  env.fire("deck-conversation-turn", { sid: "s", type: "message.complete", at: env.clock });
  snap(env, node());
  assert.equal(slot(env).hidden, true);
  snap(env, node({ turnId: "t2" }));
  assert.equal(slot(env).hidden, false);
  env.bridgeEvent({ t: "status", status: "closed" });
  snap(env, node({ turnId: "t2" }));
  assert.equal(slot(env).hidden, true);
  assert.equal(get(env, "stop").disabled, true);
});

test("foreign profiles cannot supply Stop controls and untrusted status strings remain text", () => {
  const env = boot(); snap(env, node({ profile: "other" }));
  assert.equal(slot(env).hidden, true);
  snap(env, node({ steps: ['<img src=x onerror=alert(1)>'], model: '<script>bad()</script>' }));
  get(env, "expand").click();
  assert.equal(slot(env).querySelector("img, script"), null);
  assert.match(get(env, "details").textContent, /<img/);
});

test("canonical app activity handles relay, disconnect and thinking toggles without granting relay Stop", () => {
  const env = boot({ session: { id: "chat", sid: "s", kind: "telegram", profile: "default" } });
  let current = { sid: "s", phase: "tool", tool: "read_file", source: "relay", since: env.clock, steps: ["read_file"], agent: "Example", node: node() };
  let open = false; const toggles = [];
  const base = env.win.DeckShell.service;
  env.win.DeckShell.service = key => key === "composerActivity" ? () => current : key === "liveThinking" ? { isOpen: () => open, setOpen: v => { open = v; toggles.push(v); } } : base(key);
  env.emitShell("activity", {});
  assert.equal(slot(env).hidden, false);
  assert.equal(get(env, "stop").disabled, true);
  get(env, "expand").click();
  get(env, "thinking-toggle").click();
  assert.deepEqual(toggles, [true]);
  current = { ...current, source: "events", phase: "thinking", think: "Real streamed reasoning" };
  env.emitShell("activity", {});
  assert.match(get(env, "thinking").textContent, /Real streamed reasoning/);
  current = { sid: "s", phase: "disconnected", label: { key: "status.disconnected" } };
  env.emitShell("activity", {});
  assert.equal(get(env, "status").dataset.phase, "disconnected");
  assert.equal(get(env, "stop").disabled, true);
  assert.equal(env.composer.classList.contains("conv-working"), false);
  const e = env.key(env.input, "Escape");
  assert.equal(e.defaultPrevented, false);
});
