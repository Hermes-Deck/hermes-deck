"use strict";
// Receipt transport fallback, per-call disclosure and text safety, mounted on the DOM stand-in.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { boot } = require("./composer-dom-helper");

test("receipts.css hides no existing transcript element", () => {
  const css = fs.readFileSync(path.join(__dirname, "../renderer/receipts.css"), "utf8");
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (/display:\s*none/.test(body)) assert.ok(/receipt/.test(selector), `only receipt parts may be hidden: ${selector.trim()}`);
  }
});

test("a failing direct tool list falls back to the relay detail", async () => {
  const env = boot();
  env.win.deck.bridge.toolCalls = async () => { throw new Error("bridge down"); };
  env.details.set("b", { recent: [{ call: "r1", tool: "terminal", args: "ls", ts: 1, status: "ok", ms: 2, result: "README" }] });
  const warn = console.warn; console.warn = () => {};
  try {
    env.select({ id: "b", sid: "b", kind: "hermes", channel: "hermes", profile: "default" });
    await env.settle();
  } finally { console.warn = warn; }
  assert.equal(env.win.DeckReceipts.calls("b").map(c => c.call).join(), "r1");
});

test("a slow tool list for a previous session never lands in the current one", async () => {
  const env = boot();
  let release;
  env.win.deck.bridge.toolCalls = sid => sid === "b" ? new Promise(r => { release = r; }) : Promise.resolve([]);
  env.select({ id: "b", sid: "b", kind: "hermes", channel: "hermes", profile: "default" });
  env.select({ id: "c", sid: "c", kind: "hermes", channel: "hermes", profile: "default" });
  release([{ call: "late", tool: "x", ts: 1, status: "ok" }]);
  await env.settle();
  assert.equal(env.win.DeckReceipts.calls("c").length, 0);
  assert.equal(env.win.DeckReceipts.calls("b").length, 1, "stored under its own session");
  assert.equal(env.inner.querySelectorAll(".receipt").length, 0);
});

test("per-call disclosure: select opens one call, closing keeps it closed across repaints, output stays text", () => {
  const env = boot();
  const hostile = "<img src=x onerror=alert(1)>";
  env.fire("deck-conversation-turn", { sid: "s", type: "message.start", payload: {}, at: env.clock });
  env.fire("deck-conversation-turn", { sid: "s", type: "tool.start", payload: { tool_id: "a", name: "terminal", arguments: { cmd: hostile } }, at: env.clock });
  env.fire("deck-conversation-turn", { sid: "s", type: "tool.complete", payload: { tool_id: "a", result: hostile, duration_ms: 1200 }, at: env.clock });
  env.fire("deck-conversation-turn", { sid: "s", type: "tool.start", payload: { tool_id: "b", name: "read_file" }, at: env.clock });
  env.fire("deck-conversation-turn", { sid: "s", type: "tool.complete", payload: { tool_id: "b", error: "denied" }, at: env.clock });
  env.fire("deck-conversation-turn", { sid: "s", type: "message.complete", payload: {}, at: env.clock + 3000 });
  env.flush();
  const call = id => env.inner.querySelector(`.receipt-call[data-call="${id}"]`);
  call("a").querySelector("summary").click();
  env.flush();
  assert.ok(call("a").open && call("a").classList.contains("selected"));
  assert.ok(!call("b").open);
  assert.equal(call("a").querySelector("pre").textContent, hostile);
  assert.equal(env.inner.querySelectorAll("img").length, 0, "no markup was parsed");
  assert.equal(call("a").querySelector(".receipt-duration").textContent, "1.2s");
  assert.equal(call("b").querySelector("pre").textContent, "denied");
  assert.ok(call("b").classList.contains("failed"));
  // the reader closes the call; a later repaint (new selection elsewhere) keeps it closed
  call("a").querySelector("summary").click();
  env.flush();
  env.fire("deck-tool-select", { sid: "s", call: "b", source: "run" });
  env.flush();
  assert.ok(!call("a").open, "closed call stays closed");
  assert.ok(call("b").open, "the Run selection opens its call");
});
