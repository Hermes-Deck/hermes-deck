"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { environment } = require("./composer-dom-helper");

function harness() {
  const env = environment(), timers = new Map();
  let seq = 0;
  env.win.setTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; };
  env.win.clearTimeout = id => timers.delete(id);
  if (!env.win.DeckI18n.tables.en["work.showInChat"]) env.win.DeckI18n.extend(require("../renderer/i18n-d"));
  env.user = (text, ts) => env.h("div", { class: "msg out", dataset: { ts: String(ts), convKey: `user-${ts}` } }, text);
  env.inner.append(env.user("First prompt", 900));
  env.load("receipts"); env.load("timeline"); env.flush();
  env.timersById = timers;
  return env;
}

test("Run reveal expands and selects the exact live receipt, scrolls, then clears its brass highlight", () => {
  const env = harness(), call = 'call"[not-a-selector]';
  const selections = [];
  env.doc.addEventListener("deck-tool-select", e => selections.push(e.detail));
  for (const [type, payload] of [["local.sent", {}], ["tool.start", { call, name: "terminal" }], ["tool.complete", { call, result: "Output" }], ["message.complete", {}]]) {
    env.fire("deck-conversation-turn", { sid: "s", type, payload, at: env.clock });
  }
  env.flush();
  assert.ok(!env.inner.querySelector(".receipt-fold").open);
  env.fire("deck-tool-reveal", { sid: "s", call }); env.flush();
  const receipt = env.inner.querySelector(".receipt"), row = receipt.querySelector(".receipt-call");
  assert.equal(receipt.querySelector(".receipt-fold").open, true);
  assert.equal(row.open, true);
  assert.ok(row.classList.contains("selected"));
  assert.ok(receipt.classList.contains("receipt-reveal"));
  assert.equal(env.win.DeckReceipts.selection().call, call);
  assert.equal(selections.at(-1).source, "run");
  assert.equal(env.msgs.lastScroll.behavior, "auto", "reduced motion uses immediate scrolling");
  assert.equal(env.opens.length, 0, "never opens another session or pane");
  for (const timer of env.timersById.values()) timer.fn();
  assert.equal(receipt.classList.contains("receipt-reveal"), false);
});

test("missing imported timestamps never fabricate a turn association", () => {
  const env = harness(), results = [];
  env.doc.addEventListener("deck-tool-reveal-result", e => results.push(e.detail));
  env.bridgeEvent({ t: "event", type: "deck.tools", sid: "s", payload: { tools: [{ call: "no-time", tool: "terminal", status: "ok" }] } });
  env.fire("deck-tool-reveal", { sid: "s", call: "no-time" }); env.flush();
  assert.equal(env.inner.querySelectorAll(".receipt").length, 0);
  assert.equal(results.at(-1).status, "missing");
  assert.equal(env.msgs.lastScroll, undefined);
});

test("a user message just after a call is not that imported call's anchor", () => {
  const env = harness();
  env.inner.append(env.user("Next prompt", 950));
  env.bridgeEvent({ t: "event", type: "deck.tools", sid: "s", payload: { tools: [{ call: "before-next", tool: "terminal", ts: 949.5, status: "ok" }] } });
  env.fire("deck-tool-reveal", { sid: "s", call: "before-next" }); env.flush();
  assert.equal(env.inner.querySelector(".receipt").previousElementSibling.dataset.ts, "900");
});

test("an elsewhere-running call keeps its actual call time, not the later snapshot time, as its anchor", () => {
  const env = harness(), results = [];
  env.doc.addEventListener("deck-tool-reveal-result", e => results.push(e.detail));
  env.bridgeEvent({ t: "event", type: "deck.tools", sid: "s", payload: { tools: [{ call: "elsewhere", tool: "terminal", ts: 75, status: "running" }] } });
  env.bridgeEvent({ t: "snapshot", snapshot: { nodes: [{ sid: "s", turnId: "turn-live", active: true, state: "working" }] } });
  env.fire("deck-tool-reveal", { sid: "s", call: "elsewhere" }); env.flush();
  assert.equal(env.inner.querySelectorAll(".receipt").length, 0, "the latest prompt is not this older call's turn");
  assert.equal(results.at(-1).status, "missing");
});

test("history exhaustion and page errors stop reveal with an honest missing result", () => {
  for (const mode of ["end", "error", "timeout"]) {
    const env = harness(), results = [];
    env.doc.addEventListener("deck-tool-reveal-result", e => results.push(e.detail));
    env.bridgeEvent({ t: "event", type: "deck.tools", sid: "s", payload: { tools: [{ call: "old", tool: "terminal", ts: 1, status: "ok" }] } });
    let reads = 0;
    const button = env.h("button", { dataset: { fk: "h-older" }, onclick: () => {
      reads++;
      if (mode === "timeout") return;
      env.frames.push(() => {
        env.inner.replaceChildren(env.user("Still too recent", 50), mode === "error" ? env.h("p", { class: "hist-err" }, "Read failed") : null);
        env.fire("deck-conversation-render");
      });
    } });
    env.inner.prepend(env.h("div", { class: "older" }, button));
    env.fire("deck-tool-reveal", { sid: "s", call: "old" }); env.flush();
    if (mode === "timeout") for (const timer of env.timersById.values()) timer.fn();
    assert.equal(reads, 1, mode);
    assert.equal(results.at(-1).status, "missing", mode);
    assert.equal(env.msgs.lastScroll, undefined, mode);
    assert.equal(env.timersById.size, 0, mode);
  }
});

test("changing session cancels an in-flight reveal instead of paging or scrolling the next chat", () => {
  const env = harness(), results = [];
  env.doc.addEventListener("deck-tool-reveal-result", e => results.push(e.detail));
  env.bridgeEvent({ t: "event", type: "deck.tools", sid: "s", payload: { tools: [{ call: "old", tool: "terminal", ts: 1, status: "ok" }] } });
  let reads = 0;
  env.inner.prepend(env.h("div", { class: "older" }, env.h("button", { dataset: { fk: "h-older" }, onclick: () => { reads++; } })));
  env.fire("deck-tool-reveal", { sid: "s", call: "old" }); env.flush();
  assert.equal(reads, 1);
  assert.equal(env.timersById.size, 1);
  env.select({ sid: "another", id: "another", kind: "hermes" });
  env.fire("deck-conversation-render"); env.flush();
  assert.equal(env.timersById.size, 0);
  assert.equal(results.at(-1).status, "cancelled");
  assert.equal(reads, 1);
  assert.equal(env.msgs.lastScroll, undefined);
});

test("imported reveal uses existing older-page actions until its timestamp's user turn is loaded", () => {
  const env = harness(), results = [];
  env.doc.addEventListener("deck-tool-reveal-result", e => results.push(e.detail));
  env.bridgeEvent({ t: "event", type: "deck.tools", sid: "s", payload: { tools: [
    { call: "old", tool: "terminal", ts: 75, status: "ok" },
    { call: "new", tool: "read_file", ts: 950, status: "ok" }
  ] } });
  let reads = 0;
  const pages = [700, 100, 50], users = [env.user("Latest prompt", 900)];
  function render() {
    const button = pages.length ? env.h("button", { dataset: { fk: "h-older" }, onclick: () => {
      reads++; button.disabled = true;
      // An unrelated repaint while the original request runs must not click twice.
      env.fire("deck-conversation-render");
      env.frames.push(() => { users.unshift(env.user(`Older prompt ${pages[0]}`, pages.shift())); render(); });
    } }, "Earlier") : null;
    env.inner.replaceChildren(button ? env.h("div", { class: "older" }, button) : null, ...users);
    env.fire("deck-conversation-render");
  }
  render(); env.flush();
  env.fire("deck-tool-reveal", { sid: "s", call: "old" }); env.flush();
  assert.equal(reads, 3);
  const row = [...env.inner.querySelectorAll(".receipt-call")].find(el => el.dataset.call === "old");
  const receipt = row.closest(".receipt");
  assert.equal(receipt.previousElementSibling.dataset.ts, "50");
  assert.ok(row.open && row.classList.contains("selected"));
  assert.equal(results.at(-1).status, "found");
  assert.equal(env.opens.length, 0);
});

test("a call whose receipt cannot be placed falls back to the message it was made under", () => {
  const env = harness(), results = [];
  env.doc.addEventListener("deck-tool-reveal-result", e => results.push(e.detail));
  env.inner.append(env.user("Second prompt", 1000));
  env.bridgeEvent({ t: "event", type: "deck.tools", sid: "s", payload: { tools: [{ call: "nots", tool: "terminal", status: "ok" }] } });
  env.fire("deck-tool-reveal", { sid: "s", call: "nots", ts: 950 }); env.flush();
  assert.equal(env.inner.querySelectorAll(".receipt").length, 0);
  assert.equal(results.at(-1).status, "nearby");
  assert.ok(env.msgs.lastScroll, "scrolled");
  assert.ok(env.inner.querySelector('.msg.out[data-ts="900"]').classList.contains("receipt-reveal"));
  env.fire("deck-tool-reveal", { sid: "s", call: "ghost", ts: 10 }); env.flush();
  assert.equal(results.at(-1).status, "missing", "no loaded message precedes the call");
});
