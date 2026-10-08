"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const W = require("../renderer/work-pane");
const I18N = require("../renderer/i18n");
I18N.extend(require("../renderer/i18n-d"));

function harness(bridge = {}, relay = {}, options = {}) {
  const tabs = new Map(), listeners = new Map(), live = new Map(), timers = new Map();
  const docListeners = new Map();
  const doc = { activeElement: null, addEventListener: (n, f) => docListeners.set(n, f), removeEventListener: n => docListeners.delete(n),
    dispatchEvent: e => docListeners.get(e.type)?.(e) };
  const h = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, children: kids.flat(Infinity).filter(x => x != null), value: "", isConnected: true,
    replaceChildren(...cs) { this.children = cs; }, querySelector() { return null; }, focus() { doc.activeElement = this; } });
  let session = { sid: "session-a", profile: "default" }, right = { kind: "work", tab: "plan" };
  const panes = new Map();
  const shell = { registerWorkTab: (id, def) => tabs.set(id, def), service: n => n === "h" ? h : null,
    last: n => n === "session" ? session : null, state: () => ({ session }),
    on(n, f) { listeners.set(n, f); return () => listeners.delete(n); },
    setTabLive: (id, v) => live.set(id, v), isOpen: (kind, tab) => right.kind === kind && (!tab || right.tab === tab),
    right: () => right, empty: (a, b) => h("div", { class: "sh-empty" }, a, b),
    openRight(kind, tab) { const changed = right.kind !== kind || right.tab !== tab; right = { kind, tab }; if (changed) listeners.get("right")?.(right); this.refresh(); },
    refresh() { if (!tabs.has(right.tab)) return; const el = panes.get(right.tab) || h("section"); panes.set(right.tab, el); tabs.get(right.tab).render(el); } };
  let event, relayEvent;
  const deck = { bridge: { ...bridge, onEvent: f => { event = f; return () => {}; } }, ...relay,
    onRelay: f => { relayEvent = f; return () => {}; } };
  const app = W.create({ shell, deck, doc, h, t: I18N.t, setTimer: f => { const id = Symbol(); timers.set(id, f); return id; }, clearTimer: id => timers.delete(id),
    emit: detail => doc.dispatchEvent({ type: "deck-tool-select", detail }), ...options });
  return { app, shell, tabs, live, panes, timers, doc, event: m => event(m), relay: m => relayEvent(m),
    session(s) { session = s; listeners.get("session")(s); },
    async settle() { for (let n = 0; n < 12; n++) await Promise.resolve(); shell.refresh(); },
    nodes(el = panes.get(shell.right().tab)) { const out = []; const walk = x => { if (x && typeof x === "object") { out.push(x); x.children?.forEach(walk); } }; walk(el); return out; },
    text(el = panes.get(shell.right().tab)) { const walk = x => typeof x === "object" ? (x.children || []).map(walk).join(" ") : String(x); return walk(el); } };
}

test("Plan tab renders native and OMH states safely, stays live and distinguishes cleared", async () => {
  const b = harness({ plan: async () => ({ plan: { source: "todo", items: [{ text: "<script>unsafe</script>", state: "active", depth: 1 }] } }) });
  await b.settle();
  assert.match(b.text(), /Hermes todo/);
  assert.match(b.text(), /<script>unsafe<\/script>/);
  assert.equal(b.live.get("plan"), true);
  b.event({ type: "deck.plan", sid: "session-a", payload: { plan: { source: "omh", items: [{ text: "Ship", state: "done", phase: "Build", blocked: "Review", depth: 2 }] } } });
  await b.settle();
  assert.match(b.text(), /OMH.*1 of 1 done.*Build.*Review/);
  assert.equal(b.live.get("plan"), false);
  b.event({ type: "deck.plan", sid: "session-a", payload: { plan: { source: "todo", items: [] } } });
  await b.settle(); assert.match(b.text(), /Plan cleared/);
  b.session({ sid: "session-b", profile: "default" });
  b.event({ type: "deck.plan", sid: "session-b", payload: { plan: null } });
  await b.settle(); assert.match(b.text(), /This agent did not publish a plan/);
  b.app.dispose(); assert.equal(b.timers.size, 0);
});

test("live plan supersedes an in-flight read and previous-session reads never repaint", async () => {
  const pending = [];
  const b = harness({ plan: () => new Promise(resolve => pending.push(resolve)) });
  b.event({ type: "deck.plan", sid: "session-a", payload: { plan: { source: "todo", items: [{ text: "New plan", state: "active" }] } } });
  pending[0]({ plan: { items: [{ text: "Stale read", state: "pending" }] } });
  await b.settle(); assert.match(b.text(), /New plan/); assert.doesNotMatch(b.text(), /Stale read/);
  b.session({ sid: "session-b" });
  b.event({ type: "deck.plan", sid: "session-a", payload: { plan: { items: [{ text: "Wrong session", state: "active" }] } } });
  pending[1]({ plan: null }); await b.settle(); assert.doesNotMatch(b.text(), /Wrong session/);
  b.app.dispose();
});

test("plan reads fall back to the relay and rejected reads show an inline error", async () => {
  const b = harness({ plan: async () => { throw Error("Direct unavailable"); } }, { sessionPlan: async () => ({ plan: { source: "omh", items: [{ text: "Relay plan", state: "pending" }] } }) });
  await b.settle(); assert.match(b.text(), /Relay plan/); b.app.dispose();
  const c = harness({ plan: async () => { throw Error("Read refused"); } });
  await c.settle(); assert.match(c.text(), /Read refused/); c.app.dispose();
});

test("renderer module self-registers the Plan tab", () => {
  const fs = require("node:fs"), vm = require("node:vm");
  const b = harness();
  const window = { DeckShell: b.shell, deck: { bridge: {} }, DeckI18n: I18N, document: b.doc, setTimeout, clearTimeout,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../renderer/work-pane"), "utf8"), { window });
  assert.equal(typeof window.DeckWorkPane.dispose, "function");
  assert.equal(b.tabs.get("plan").title(), "Plan");
  window.DeckWorkPane.dispose(); b.app.dispose();
});

test("Run statistics count failures honestly and timing bars normalize seconds and milliseconds", () => {
  const calls = [
    { call: "a", tool: "terminal", ts: 1767323000, status: "ok", ms: 1000 },
    { call: "b", tool: "patch", ts: 1767323001000, status: "blocked", ms: 500 },
    { call: "c", tool: "write_file", ts: 1767323002, status: "running", ms: null },
    { call: "d", tool: "terminal", ts: 1767323003, status: "custom-failure", ms: -3 }
  ];
  assert.deepEqual(W.runStats(calls, { cost: 0 }), { calls: 4, time: 1500, failed: 2, running: 1, cost: 0 });
  assert.equal(W.runStats([], {}).cost, null);
  const bars = W.timingBars(calls, 1767323004000);
  assert.equal(bars[0].left, 0); assert.equal(bars[0].width, 25);
  assert.equal(bars[1].left, 25); assert.equal(bars[2].width, 50);
  assert.ok(bars.every(x => x.left >= 0 && x.width >= 0 && x.left + x.width <= 100));
});

test("Run replaces tool pushes, follows running calls and synchronizes explicit selection", async () => {
  const b = harness({ toolCalls: async () => [{ call: "old", tool: "terminal", status: "ok", ms: 10, result: "Earlier output" }] });
  b.shell.openRight("work", "run"); await b.settle();
  assert.match(b.text(), /Earlier output/);
  b.event({ type: "deck.tools", sid: "session-a", payload: { tools: [
    { call: "a", tool: "terminal", status: "ok", ms: 20, result: "<img onerror=bad>" },
    { call: "b", tool: "patch", status: "running", ms: null }
  ] } });
  await b.settle(); assert.equal(b.live.get("run"), true); assert.doesNotMatch(b.text(), /Earlier output/);
  b.app.selectTool({ sid: "session-a", call: "a" }); await b.settle();
  assert.match(b.text(), /<img onerror=bad>/);
  assert.ok(b.nodes().find(n => n.attrs["aria-pressed"] === "true" && n.children.some(c => c?.children?.includes("terminal"))));
  b.event({ type: "deck.tools", sid: "session-a", payload: { tools: [] } });
  await b.settle(); assert.equal(b.live.get("run"), false); assert.match(b.text(), /No tool calls/);
  b.app.dispose();
});

test("Run relay reads and incremental tool events preserve output and cost", async () => {
  const b = harness({}, { session: async () => ({ cost: 0.12, cost_estimated: true, recent: [{ call: "a", tool: "terminal", ts: 100, status: "ok", ms: 25, result: "Relay output" }] }) });
  b.shell.openRight("work", "run"); await b.settle(); assert.match(b.text(), /Relay output/); assert.match(b.text(), /≈\$0.1200/);
  b.relay({ t: "evs", evs: [{ ev: "tool_start", sid: "session-a", call: "b", tool: "patch", ts: 101, args: "{}" }] });
  await b.settle(); assert.equal(b.live.get("run"), true);
  b.relay({ t: "evs", evs: [{ ev: "tool_end", sid: "session-a", call: "b", tool: "patch", status: "failed", ms: 15, err: "Write refused" }] });
  await b.settle(); assert.equal(b.live.get("run"), false); assert.match(b.text(), /Write refused/); b.app.dispose();
});

test("Diff extracts successful writes without inventing paths, counts or diffs", () => {
  const calls = [
    { call: "a", tool: "write_file", status: "ok", args: JSON.stringify({ path: "src/example.js", content: "new" }), result: "Written" },
    { call: "b", tool: "patch", status: "ok", args: JSON.stringify({ path: "src/example.js" }), result: JSON.stringify({ success: true, diff: "--- a/src/example.js\n+++ b/src/example.js\n@@ -1 +1 @@\n-old\n+new" }) },
    { call: "c", tool: "write_file", status: "failed", args: JSON.stringify({ path: "no.js" }) },
    { call: "d", tool: "patch", status: "ok", args: '{"path":"truncated…' },
    { call: "e", tool: "terminal", status: "ok", args: '{"command":"touch not-evidence.js"}' },
    { call: "f", tool: "write_file", status: "ok", args: '{"path":"hidden.js"}', result: '{"success":false}' }
  ];
  assert.deepEqual(W.changedFiles(calls), [{ name: "example.js", added: 1, removed: 1 }]);
  assert.deepEqual(W.changedFiles([{ tool: "write_file", status: "ok", args: '{"path":"/srv/example/private.js"}' }]), [{ name: "private.js", added: null, removed: null }]);
});

test("Diff retains observed files across replacement windows and labels missing real diffs", async () => {
  const b = harness(); b.shell.openRight("work", "diff"); await b.settle(); assert.match(b.text(), /No changed files/);
  b.event({ type: "deck.tools", sid: "session-a", payload: { tools: [{ call: "write-1", tool: "patch", status: "ok", args: '{"path":"example.js"}', result: JSON.stringify({ diff: "--- a/example.js\n+++ b/example.js\n@@ -1,2 +1,3 @@\n-one\n-two\n+first\n+second\n+third" }) }] } });
  await b.settle(); assert.match(b.text(), /example.js.*\+3.*−2/); assert.match(b.text(), /No complete diff/);
  b.event({ type: "deck.tools", sid: "session-a", payload: { tools: [] } }); await b.settle(); assert.match(b.text(), /example.js/);
  b.session({ sid: "session-b" }); await b.settle(); assert.doesNotMatch(b.text(), /example.js/); b.app.dispose();
});

test("Diff renders basenames for clipped write arguments and never shows invented line counts", async () => {
  const b = harness(); b.shell.openRight("work", "diff"); await b.settle();
  const args = JSON.stringify({ path: "src/large-output.js", content: "x".repeat(600) }).slice(0, 300) + "…";
  b.event({ type: "deck.tools", sid: "session-a", payload: { tools: [{ call: "large-write", tool: "write_file", status: "ok", args, result: "Written" }] } });
  await b.settle();
  assert.match(b.text(), /large-output\.js/);
  assert.doesNotMatch(b.text(), /src\/|No changed files|\+\d|−\d/);
  b.app.dispose();
});

test("agent tree includes orphans once and bounds cycles", () => {
  const rows = W.agentRows([{ id: "a", parentId: "b" }, { id: "b", parentId: "a" }, { id: "c", parentId: "missing" }, { id: "d", parentId: "c" }]);
  assert.equal(rows.length, 4); assert.equal(new Set(rows.map(x => x.agent.id)).size, 4);
  assert.equal(rows.find(x => x.agent.id === "d").depth, 1);
  assert.equal(W.canSteer({ status: "completed", acceptingSteer: true }), false);
  assert.equal(W.canSteer({ status: "running", acceptingSteer: false }), false);
  assert.equal(W.canSteer({ status: "running", acceptingSteer: true }), true);
});

test("Agents detail reads tail, renders tool disclosure and steers once through Ctrl+Enter", async () => {
  const calls = [], child = { id: "child-a", goal: "<script>task</script>", status: "running", acceptingSteer: true,
    model: "model-b", effort: "high", elapsedS: 12, tokens: { input: 40, output: 10 }, costUsd: 0.01,
    tools: [{ call: "tool-a", tool: "terminal", status: "ok", result: "Child output" }] };
  const b = harness({ subagents: async () => ({ subagents: [child], failed: [] }),
    subagentTail: async () => ({ available: true, text: "12:34:50 tool     | -> read_file({})\n12:34:51 result   | raw tool log\n12:34:56 assistant| Notes so far", detail: child }),
    steerSubagent: async (...args) => { calls.push(args); return { status: "queued" }; } });
  b.shell.openRight("work", "agents"); await b.settle();
  b.nodes().find(n => n.tag === "button" && n.attrs["data-agent"] === child.id).attrs.onclick(); await b.settle();
  assert.match(b.text(), /<script>task<\/script>/); assert.match(b.text(), /model-b.*high/); assert.match(b.text(), /Notes so far/);
  assert.ok(b.nodes().find(n => n.tag === "details")); assert.match(b.text(), /Child output/);
  assert.doesNotMatch(b.text(), /12:34:|raw tool log|-> read_file/);
  const field = b.nodes().find(n => n.tag === "textarea"); field.value = "Check edge cases";
  field.attrs.oninput({ target: field });
  const e = { key: "Enter", ctrlKey: true, preventDefault() {} };
  field.attrs.onkeydown(e); field.attrs.onkeydown(e); await b.settle();
  assert.equal(calls.length, 1); assert.equal(calls[0][0], "session-a"); assert.equal(calls[0][1], "child-a");
  assert.equal(calls[0][2], "Check edge cases"); assert.match(b.text(), /Queued; not yet delivered/);
  b.app.dispose(); assert.equal(b.timers.size, 0);
});

test("Agents omit Notes entirely for tool-only tails, while keeping their tool disclosures", async () => {
  const child = { id: "notes-child", goal: "Task", status: "running", acceptingSteer: true,
    tools: [{ call: "t", tool: "read_file", status: "ok", result: "Tool output" }] };
  const b = harness({ subagents: async () => ({ subagents: [child], failed: [] }), subagentTail: async () => ({ available: true, truncated: true,
    text: '12:34:56 tool     | -> read_file({})\n12:34:57 result   | read_file ok 0.1s: raw tool log\nresult continuation' }) });
  b.shell.openRight("work", "agents"); await b.settle(); b.app.openAgent(child.id); await b.settle();
  assert.doesNotMatch(b.text(), /Notes so far|No live output|Only the latest output|raw tool log|result continuation/);
  assert.equal(b.nodes().filter(n => n.attrs.class === "wk-notes").length, 0);
  assert.match(b.text(), /Tool output/);
  b.app.dispose();
});

test("Agents with no notes still show relevant tail-ended and read-error notices", async () => {
  const child = { id: "notes-child", goal: "Task", status: "running", tools: [] };
  for (const unavailable of [true, false]) {
    const b = harness({ subagents: async () => ({ subagents: [child], failed: [] }), subagentTail: async () => {
      if (!unavailable) throw Error("Tail read refused");
      return { available: false, text: "" };
    } });
    b.shell.openRight("work", "agents"); await b.settle(); b.app.openAgent(child.id); await b.settle();
    assert.doesNotMatch(b.text(), /Notes so far|No live output was published/);
    assert.match(b.text(), unavailable ? /Live output is unavailable/ : /Tail read refused/);
    b.app.dispose();
  }
});

test("Agents mutation failures stay inline, stop is not replayed and ended children reject steer", async () => {
  let stopped = 0, steered = 0;
  const child = { id: "child-a", goal: "Task", status: "running", acceptingSteer: true, tools: [] };
  const b = harness({ subagents: async () => ({ subagents: [child], failed: [{ delegationId: "failed-a", goal: "Other task", error: "Timeout" }] }),
    subagentTail: async () => ({ available: true, detail: child, text: "" }),
    interruptSubagent: async () => { stopped++; throw Error("Connection dropped"); },
    steerSubagent: async () => { steered++; return { status: "queued" }; } });
  b.shell.openRight("work", "agents"); await b.settle(); assert.match(b.text(), /Timeout/);
  b.app.openAgent("child-a"); await b.settle();
  const stop = b.nodes().find(n => n.attrs["data-action"] === "stop"); stop.attrs.onclick(); stop.attrs.onclick(); await b.settle();
  assert.equal(stopped, 1); assert.match(b.text(), /Connection dropped/);
  child.status = "completed";
  await b.app.poll(); await b.settle();
  const field = b.nodes().find(n => n.tag === "textarea"); assert.equal(field.attrs.disabled, true);
  field.value = "Do not send"; field.attrs.oninput({ target: field }); field.attrs.onkeydown({ key: "Enter", metaKey: true, preventDefault() {} }); await b.settle();
  assert.equal(steered, 0); assert.equal(stopped, 1); b.app.dispose();
});

test("Agents polls only while its tab is open and stale tails never replace another detail", async () => {
  const tails = [], agents = [{ id: "a", goal: "First", status: "running" }, { id: "b", goal: "Second", status: "running" }];
  let reads = 0;
  const b = harness({ subagents: async () => { reads++; return { subagents: agents, failed: [] }; },
    subagentTail: (_sid, id) => new Promise(resolve => tails.push({ id, resolve })) });
  await b.settle(); assert.equal(reads, 0);
  b.shell.openRight("work", "agents"); await b.settle(); assert.equal(reads, 1);
  b.app.openAgent("a"); await b.settle(); b.app.openAgent("b"); await b.settle();
  tails.find(x => x.id === "a").resolve({ available: true, text: "12:34:56 assistant| Old tail" });
  tails.find(x => x.id === "b").resolve({ available: true, text: "12:34:56 assistant| New tail" });
  await b.settle(); assert.match(b.text(), /New tail/); assert.doesNotMatch(b.text(), /Old tail/);
  b.shell.openRight("work", "run"); await b.app.poll(); assert.equal(reads, 1); b.app.dispose();
});

test("surface liveness reflects browsers, unexpired grants and online spaces, not permission alone", () => {
  const V = require("../renderer/ws-view");
  assert.equal(V.browserLive({ status: "running" }), true);
  assert.equal(V.browserLive({ status: "stopped", lastAgentAt: 100 }), false);
  assert.equal(V.screenLive({ on: true, link: { status: "ready" } }, "default", 100), false);
  assert.equal(V.screenLive({ on: true, link: { status: "ready" }, grant: { profile: "default", expires: 200 } }, "default", 100), true);
  assert.equal(V.screenLive({ on: true, link: { status: "ready" }, grant: { profile: "default", expires: 50 } }, "default", 100), false);
  assert.equal(V.spaceLive({ spaces: [{ id: "default", online: true, kind: "agent" }] }, "default"), true);
  assert.equal(V.spaceLive({ spaces: [{ id: "default", online: true }] }, "other"), false);
});

test("surface chips safely open existing views and their tab dots track live services", () => {
  const b = harness(), browser = { live: profile => !profile || profile === "default", selectProfile: profile => { browser.selected = profile; } }, screen = { live: () => false };
  const service = b.shell.service;
  b.shell.service = name => name === "workspace" ? browser : name === "botscreen" ? screen : service(name);
  const surfaces = W.createSurfaces({ shell: b.shell, h: service("h"), t: I18N.t, doc: b.doc,
    setTimer: f => { b.timers.set("surface", f); return "surface"; }, clearTimer: id => b.timers.delete(id), emit() {} });
  assert.equal(b.live.get("browser"), true); assert.equal(b.live.get("screen"), false);
  assert.equal(surfaces.chip("screen"), null); assert.equal(surfaces.chip("browser", { profile: "other" }), null);
  const chip = surfaces.chip("browser", { profile: "default" }); assert.ok(chip); chip.attrs.onclick();
  assert.equal(b.shell.right().tab, "browser"); assert.equal(browser.selected, "default");
  browser.live = () => false; surfaces.refresh(); assert.equal(b.live.get("browser"), false);
  surfaces.dispose(); b.app.dispose(); assert.equal(b.timers.size, 0);
});

test("expanded surfaces use the one-pixel gutter, preserve work tabs and respect hidden sidebar", () => {
  const fs = require("node:fs"), path = require("node:path");
  for (const filename of ["workspace.css", "botscreen.css"]) {
    const css = fs.readFileSync(path.join(__dirname, "../renderer", filename), "utf8");
    assert.doesNotMatch(css, /left:\s*calc\([^;]*\+ 6px\)/);
    assert.match(css, /left:\s*calc\([^;]*\+ 1px\)/);
    assert.match(css, /\.app\.side-hidden\s+\.(ws|sp)\.expanded\s*\{\s*left:\s*0/);
    assert.match(css, /top:\s*calc\(var\(--top\)\s*\+\s*44px\)/);
  }
});

test("receipt selection events highlight Run without opening it or creating event loops", async () => {
  const b = harness({ toolCalls: async () => [{ call: "a", tool: "terminal", status: "ok", result: "Receipt selected" }, { call: "b", tool: "patch", status: "ok", result: "Other output" }] });
  await b.settle();
  b.doc.dispatchEvent({ type: "deck-tool-select", detail: { sid: "session-a", call: "a", source: "receipt" } });
  assert.equal(b.shell.right().tab, "plan");
  b.shell.openRight("work", "run"); await b.settle(); assert.match(b.text(), /Receipt selected/);
  const row = b.nodes().find(n => n.tag === "button" && n.attrs["aria-pressed"] === "true"); row.attrs.onclick();
  await b.settle(); assert.match(b.text(), /Receipt selected/); b.app.dispose();
});

test("failed bridge tool reads fall back to relay recent calls", async () => {
  const b = harness({ toolCalls: async () => { throw Error("Direct offline"); } }, { session: async () => ({ recent: [{ call: "a", tool: "terminal", status: "ok", result: "Fallback output" }] }) });
  b.shell.openRight("work", "run"); await b.settle(); assert.match(b.text(), /Fallback output/); b.app.dispose();
});

test("Agents controls update inline while a focused hold prevents a pane rebuild", async () => {
  const child = { id: "a", goal: "Task", status: "running", acceptingSteer: true, tools: [] };
  const b = harness({ subagents: async () => ({ subagents: [child], failed: [] }),
    steerSubagent: async () => ({ status: "queued" }) });
  b.shell.openRight("work", "agents"); await b.settle(); b.app.openAgent("a"); await b.settle();
  const field = b.nodes().find(n => n.tag === "textarea"), button = b.nodes().find(n => n.attrs["data-action"] === "steer"), status = b.nodes().find(n => n.attrs["data-agent-message"] === "a");
  b.shell.refresh = () => {};
  field.value = "Steer once"; field.attrs.oninput({ target: field }); assert.equal(button.disabled, false);
  field.attrs.onkeydown({ key: "Enter", ctrlKey: true, preventDefault() {} }); await b.settle();
  assert.equal(field.value, ""); assert.equal(button.disabled, true); assert.match(status.textContent, /Queued; not yet delivered/);
  field.value = "Keep draft"; field.attrs.oninput({ target: field }); child.status = "completed";
  await b.app.poll(); assert.equal(field.disabled, true); assert.equal(button.disabled, true); assert.equal(field.value, "Keep draft"); b.app.dispose();
});

test("plan summary distinguishes absent, cleared and truncated plans", () => {
  assert.equal(W.planSummary(null), null);
  assert.deepEqual(W.planSummary({ items: [] }), { done: 0, total: 0, shown: 0, active: false });
  assert.deepEqual(W.planSummary({ total: 80, items: [{ state: "done" }, { state: "active" }, { state: "cancelled" }] }),
    { done: 1, total: 80, shown: 3, active: true });
});

test("every Run row and the selected output header reveal their call through the document contract", async () => {
  const revealed = [];
  const b = harness({ toolCalls: async () => [{ call: "a", tool: "terminal", status: "ok" }, { call: "b", tool: "patch", status: "ok" }] }, {},
    { emitReveal: detail => revealed.push(detail) });
  b.shell.openRight("work", "run"); await b.settle();
  const actions = b.nodes().filter(n => n.tag === "button" && n.attrs["aria-label"] === "Show in chat");
  assert.equal(actions.length, 3, "two row actions plus the output header action");
  actions[0].attrs.onclick(); await b.settle();
  assert.deepEqual(revealed, [{ sid: "session-a", call: "a" }]);
  b.nodes().find(n => n.attrs?.class?.startsWith("wk-run-row") && n.children.some(c => c?.attrs?.class === "wk-name" && c.children.includes("patch"))).attrs.onclick(); await b.settle();
  assert.deepEqual(revealed.at(-1), { sid: "session-a", call: "b" }, "a row click also reveals");
  b.nodes().find(n => n.attrs?.class?.startsWith("wk-run-row") && n.children.some(c => c?.attrs?.class === "wk-name" && c.children.includes("terminal"))).attrs.onclick(); await b.settle();
  assert.ok(b.nodes().some(n => n.attrs?.class === "wk-name" && n.attrs.title === "patch"), "full tool name in a title");
  b.nodes().find(n => n.tag === "header").children.find(n => n.tag === "button").attrs.onclick();
  assert.deepEqual(revealed.at(-1), { sid: "session-a", call: "a" });
  assert.ok(b.nodes().filter(n => n.tag === "button").every(n => !n.children.some(c => c?.tag === "button")), "no nested buttons");
  b.app.dispose();
});

test("Run reports unavailable chat history honestly and only for the matching selected call", async () => {
  const b = harness({ toolCalls: async () => [{ call: "a", tool: "terminal", status: "ok" }] });
  b.shell.openRight("work", "run"); await b.settle();
  b.doc.dispatchEvent({ type: "deck-tool-reveal-result", detail: { sid: "session-a", call: "a", status: "loading" } });
  await b.settle(); assert.match(b.text(), /Loading earlier history/);
  b.doc.dispatchEvent({ type: "deck-tool-reveal-result", detail: { sid: "other", call: "a", status: "missing" } });
  await b.settle(); assert.doesNotMatch(b.text(), /Not in the loaded history/);
  b.doc.dispatchEvent({ type: "deck-tool-reveal-result", detail: { sid: "session-a", call: "a", status: "missing" } });
  await b.settle(); assert.match(b.text(), /Not in the loaded history/);
  b.doc.dispatchEvent({ type: "deck-tool-reveal-result", detail: { sid: "session-a", call: "a", status: "found" } });
  await b.settle(); assert.doesNotMatch(b.text(), /Not in the loaded history|Loading earlier history/);
  b.app.dispose();
});

const ticks = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };

test("a slow plan read never holds resolved Run tools or their live dot", async () => {
  const b = harness({ plan: () => new Promise(() => {}), toolCalls: async () => [{ call: "a", tool: "terminal", status: "running", ms: null }] });
  b.shell.openRight("work", "run"); await ticks();
  assert.equal(b.live.get("run"), true);
  b.shell.refresh(); assert.doesNotMatch(b.text(), /Loading/); assert.match(b.text(), /terminal/);
  b.shell.openRight("work", "plan"); assert.match(b.text(), /Loading/); b.app.dispose();
  const c = harness({ plan: () => new Promise(() => {}), toolCalls: async () => [] });
  c.shell.openRight("work", "run"); await c.settle(); assert.match(c.text(), /No tool calls/); c.app.dispose();
});

test("a child that leaves the tree stays ended even when a late tail reports it running", async () => {
  let agents = [{ id: "a", goal: "Task", status: "running", acceptingSteer: true, tools: [] }];
  let tail = { available: true, text: "12:34:56 assistant| Early" };
  const b = harness({ subagents: async () => ({ subagents: agents, failed: [] }), subagentTail: async () => tail,
    steerSubagent: async () => ({ status: "queued" }), interruptSubagent: async () => ({ found: true }) });
  b.shell.openRight("work", "agents"); await b.settle(); b.app.openAgent("a"); await b.settle();
  assert.equal(b.nodes().find(n => n.tag === "textarea").attrs.disabled, false);
  agents = []; tail = { available: true, text: "12:34:56 assistant| Late notes", detail: { id: "a", goal: "Task", status: "running", acceptingSteer: true, elapsedS: 9, tools: [] } };
  await b.app.poll(); await b.settle();
  assert.match(b.text(), /Late notes/); assert.match(b.text(), /no longer in the live list/);
  assert.equal(b.nodes().find(n => n.tag === "textarea").attrs.disabled, true);
  assert.equal(b.nodes().find(n => n.attrs["data-action"] === "stop").attrs.disabled, true);
  assert.equal(b.live.get("agents"), false); b.app.dispose();
});

test("explicit selection outside the recent list uses receipt previews or says output is unavailable", async () => {
  const receipts = { calls: sid => sid === "session-a" ? [{ call: "old", tool: "terminal", status: "ok", ms: 5, result: "Receipt preview" }] : [] };
  const b = harness({ toolCalls: async () => [{ call: "a", tool: "terminal", status: "ok", result: "Recent output" }] }, {}, { receipts: () => receipts });
  b.shell.openRight("work", "run"); await b.settle();
  b.doc.dispatchEvent({ type: "deck-tool-select", detail: { sid: "session-a", call: "old", source: "receipt" } }); await b.settle();
  assert.match(b.text(), /Receipt preview/); assert.match(b.text(), /not in the recent list/); assert.doesNotMatch(b.text(), /Recent output/);
  b.event({ type: "deck.tools", sid: "session-a", payload: { tools: [{ call: "b", tool: "patch", status: "ok", result: "Newer" }] } }); await b.settle();
  assert.match(b.text(), /Receipt preview/);
  b.doc.dispatchEvent({ type: "deck-tool-select", detail: { sid: "session-a", call: "missing", source: "receipt" } }); await b.settle();
  assert.match(b.text(), /output is unavailable here/); assert.doesNotMatch(b.text(), /Receipt preview|Newer/); b.app.dispose();
});

test("agent tool and Run argument disclosures keep their expansion across rebuilds", async () => {
  const child = { id: "a", goal: "Task", status: "running", acceptingSteer: true, tools: [{ call: "t1", tool: "terminal", status: "ok", args: "{}", result: "Out" }] };
  const b = harness({ subagents: async () => ({ subagents: [child], failed: [] }), toolCalls: async () => [{ call: "r1", tool: "terminal", status: "ok", args: "{\"command\":\"ls\"}", result: "Listing" }] });
  b.shell.openRight("work", "agents"); await b.settle(); b.app.openAgent("a"); await b.settle();
  const details = () => b.nodes().find(n => n.tag === "details");
  const summary = () => details().children.find(n => n.tag === "summary");
  summary().attrs.onclick({ currentTarget: { parentNode: { open: false } } }); b.shell.refresh();
  assert.equal(details().attrs.open, true);
  summary().attrs.onclick({ currentTarget: { parentNode: { open: true } } }); b.shell.refresh();
  assert.ok(!details().attrs.open);
  b.shell.openRight("work", "run"); await b.settle();
  summary().attrs.onclick({ currentTarget: { parentNode: { open: false } } }); b.shell.refresh();
  assert.equal(details().attrs.open, true); b.app.dispose();
});

test("browser surfaces count remote browsers only while the relay link is open", () => {
  const V = require("../renderer/ws-view");
  const remote = [{ slug: "default", status: "running" }];
  assert.equal(V.browserSurfaceLive({ local: [], remote, link: { status: "closed" } }), false);
  assert.equal(V.browserSurfaceLive({ local: [], remote, link: { status: "open" } }), true);
  assert.equal(V.browserSurfaceLive({ local: [], remote, link: { status: "open" }, profile: "other" }), false);
  assert.equal(V.browserSurfaceLive({ local: [{ slug: "other", status: "running" }], remote: [], link: null, profile: "other" }), true);
  assert.equal(V.browserSurfaceLive({ local: [{ slug: "other", status: "stopped" }], remote: [], link: null }), false);
  const ws = require("node:fs").readFileSync(require("node:path").join(__dirname, "../renderer/workspace.js"), "utf8");
  assert.match(ws, /browserSurfaceLive\(/);
});

test("steer and stop guard missing bridge methods and over-long text inline", async () => {
  const child = { id: "a", goal: "Task", status: "running", acceptingSteer: true, tools: [] };
  const b = harness({ subagents: async () => ({ subagents: [child], failed: [] }) });
  b.shell.openRight("work", "agents"); await b.settle(); b.app.openAgent("a"); await b.settle();
  assert.match(b.text(), /direct connection/);
  let field = b.nodes().find(n => n.tag === "textarea"); field.value = "Go"; field.attrs.oninput({ target: field });
  field.attrs.onkeydown({ key: "Enter", ctrlKey: true, preventDefault() {} }); await b.settle();
  assert.doesNotMatch(b.text(), /not a function/); assert.match(b.text(), /direct connection/);
  b.nodes().find(n => n.attrs["data-action"] === "stop").attrs.onclick(); await b.settle();
  assert.doesNotMatch(b.text(), /not a function/); b.app.dispose();
  let sent = 0;
  const c = harness({ subagents: async () => ({ subagents: [child], failed: [] }), steerSubagent: async () => { sent++; return { status: "queued" }; } });
  c.shell.openRight("work", "agents"); await c.settle(); c.app.openAgent("a"); await c.settle();
  field = c.nodes().find(n => n.tag === "textarea"); field.value = "x".repeat(32001); field.attrs.oninput({ target: field });
  field.attrs.onkeydown({ key: "Enter", ctrlKey: true, preventDefault() {} }); await c.settle();
  assert.equal(sent, 0); assert.match(c.text(), /too long/); assert.equal(W.steerError("x".repeat(32000)), null); c.app.dispose();
});

test("unknown elapsed reads as a dash and the token figure says what it counts", async () => {
  const child = { id: "a", goal: "Task", status: "running", acceptingSteer: true, tools: [], tokens: { input: 1, output: 2, reasoning: 50 } };
  const b = harness({ subagents: async () => ({ subagents: [child], failed: [] }) });
  b.shell.openRight("work", "agents"); await b.settle();
  assert.doesNotMatch(b.text(), /0\.0s/);
  b.app.openAgent("a"); await b.settle();
  assert.match(b.text(), /Tokens 3/);
  assert.ok(b.nodes().some(n => /reasoning/i.test(n.attrs?.title || ""))); b.app.dispose();
});

test("fleet child selection opens Agents and the matching child once the tree has it", async () => {
  let agents = [];
  const b = harness({ subagents: async () => ({ subagents: agents, failed: [] }), subagentTail: async () => ({ available: true, text: "12:34:56 assistant| Child notes" }),
    steerSubagent: async () => ({ status: "queued" }) });
  b.doc.dispatchEvent({ type: "deck-agent-select", detail: { sid: "session-a", profile: "default", childSid: "child-stored", subagentId: null } });
  await b.settle();
  assert.equal(b.shell.right().tab, "agents"); assert.match(b.text(), /Looking for the selected sub-agent/);
  agents = [{ id: "sa-1", childSid: "child-stored", goal: "Child goal", status: "running", acceptingSteer: true, tools: [] }];
  await b.app.poll(); await b.settle();
  assert.match(b.text(), /Child goal/); assert.match(b.text(), /Child notes/); assert.ok(b.nodes().find(n => n.tag === "textarea"));
  assert.equal(typeof b.app.selectAgent, "function"); b.app.dispose();
});

test("fleet selection for another session asks the app to open it and never fabricates a missing child", async () => {
  const opened = [];
  const b = harness({ subagents: async () => ({ subagents: [], failed: [] }) });
  const service = b.shell.service; b.shell.service = n => n === "openChat" ? (x => { opened.push(x); }) : service(n);
  b.doc.dispatchEvent({ type: "deck-agent-select", detail: { sid: "session-b", profile: "default", childSid: "child-b", subagentId: null } });
  assert.deepEqual(opened, [{ sid: "session-b", profile: "default", origin: "fleet" }]);
  b.session({ sid: "session-b", profile: "default" });
  for (let i = 0; i < 5; i++) { await b.settle(); await b.app.poll(); }
  await b.settle();
  assert.match(b.text(), /not in the live list/); assert.equal(b.nodes().some(n => n.tag === "textarea"), false); b.app.dispose();
  const c = harness({ subagents: async () => ({ subagents: [], failed: [] }) });
  c.doc.dispatchEvent({ type: "deck-agent-select", detail: { sid: "session-z", childSid: "child-z" } }); await c.settle();
  assert.match(c.text(), /another session/);
  c.doc.dispatchEvent({ type: "deck-agent-select", detail: { sid: "session-a" } }); await c.settle();
  assert.doesNotMatch(c.text(), /another session/); assert.match(c.text(), /No sub-agents/); c.app.dispose();
});

test("renderer module mounts a live Screen chip into the top bar and clears it when nothing is live", () => {
  const fs = require("node:fs"), vm = require("node:vm");
  const b = harness();
  let live = { browser: true, screen: true };
  const mounted = [], listeners = new Map(), sessionSubs = [];
  const el = (tag) => ({ tag, className: "", children: [], append(...k) { this.children.push(...k); } });
  const doc = Object.assign(Object.create(b.doc), {
    createElement: el,
    addEventListener: (t, f) => listeners.set(t, f), removeEventListener: (t) => listeners.delete(t),
    dispatchEvent: (e) => listeners.get(e.type)?.(e),
  });
  const shell = Object.assign(Object.create(b.shell), {
    service: (n) => n === "workspace" ? { live: () => live.browser } : n === "botscreen" ? { live: () => live.screen } : b.shell.service(n),
    mount: (slot, node) => mounted.push([slot, node]),
    on: (ev, f) => { if (ev === "session") sessionSubs.push(f); return () => {}; },
    setTabLive() {},
  });
  const window = { DeckShell: shell, deck: { bridge: {} }, DeckI18n: I18N, document: doc, setTimeout: () => 0, clearTimeout() {},
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../renderer/work-pane"), "utf8"), { window });
  const [slot, node] = mounted.at(-1);
  assert.equal(slot, "crumb-extra");
  assert.equal(node.className, "wk-surface-chips");
  assert.equal(node.children.length, 1, "only the live surface gets a chip");
  live = { browser: false, screen: false };
  listeners.get("deck-surfaces")({ type: "deck-surfaces" });
  assert.deepEqual(mounted.at(-1), ["crumb-extra", null]);
  window.DeckWorkPane.dispose(); b.app.dispose();
  assert.equal(listeners.has("deck-surfaces"), false, "dispose removes the top-bar listeners");
});

test("Agents lists real failures and folds sub-agents that were stopped on purpose into one muted line", async () => {
  const failed = [
    { delegationId: "x1", goal: "Broke", status: "failed", error: "Timeout" },
    ...Array.from({ length: 3 }, (_, i) => ({ delegationId: `s${i}`, goal: `Stopped ${i}`, status: "interrupted", error: "Operation interrupted" })),
  ];
  const b = harness({ subagents: async () => ({ subagents: [], failed }) });
  b.shell.openRight("work", "agents"); await b.settle();
  const text = b.text();
  assert.match(text, /Broke/); assert.match(text, /Timeout/);
  assert.doesNotMatch(text, /Stopped 0|Operation interrupted/);
  assert.ok(b.nodes().some(n => n.attrs?.class === "wk-note wk-stopped"));
  b.app.dispose();
});
