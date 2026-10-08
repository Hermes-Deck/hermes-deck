"use strict";
// Composer Stop / snapshot guards, mounted on the deterministic DOM stand-in.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot } = require("./composer-dom-helper");

const node = (extra = {}) => ({ sid: "s", state: "working", turnId: "t1", controlAvailable: true, ownerPid: 7, bound: false, terminalAt: null, steps: ["terminal"], ...extra });
const snap = (env, ...nodes) => { env.bridgeEvent({ t: "snapshot", snapshot: { nodes } }); env.flush(); };
const status = env => env.doc.getElementById("composer-status");
const stop = env => env.doc.querySelector(".conv-stop");
const error = env => env.doc.querySelector(".conv-error");

test("a node without a turn id is not treated as already stopped", () => {
  const env = boot();
  snap(env, node({ turnId: undefined }));
  assert.equal(status(env).hidden, false, "working without a turn id still shows the status");
  snap(env, node({ turnId: "" }));
  assert.equal(status(env).hidden, false);
});

test("Stop is enabled for a bound runtime session and disabled for an uncontrollable one", () => {
  const env = boot();
  snap(env, node({ controlAvailable: false, ownerPid: null, bound: true }));
  assert.equal(stop(env).disabled, false, "bound gateway session can be interrupted");
  snap(env, node({ controlAvailable: false, ownerPid: null, bound: false }));
  assert.equal(stop(env).disabled, true);
  assert.equal(env.doc.querySelector(".conv-hint").textContent, "Enter queues");
  snap(env, node({ controlAvailable: true, ownerPid: null }));
  assert.equal(stop(env).disabled, true, "control needs an owner process, like the bridge");
});

test("a stale interrupt keeps the turn visible and says the turn changed", async () => {
  const env = boot();
  snap(env, node());
  env.interruptResult = { status: "stale" };
  stop(env).click();
  await env.settle();
  assert.equal(status(env).hidden, false);
  assert.equal(error(env).hidden, false);
  assert.equal(error(env).textContent, "The turn changed; try again.");
  assert.equal(stop(env).disabled, false, "Stop can be retried");
});

test("not_running hides the status as gone; a thrown error stays visible and retryable", async () => {
  const env = boot();
  snap(env, node());
  env.interruptResult = { status: "not_running" };
  stop(env).click();
  await env.settle();
  assert.equal(status(env).hidden, true);
  assert.equal(error(env).hidden, true);
  const env2 = boot();
  snap(env2, node());
  env2.interruptResult = new Error("The Hermes link is closed.");
  stop(env2).click();
  await env2.settle();
  assert.equal(status(env2).hidden, false);
  assert.equal(error(env2).textContent, "The Hermes link is closed.");
  assert.equal(env2.mutations.length, 1);
});

test("a stopped turn stays hidden against lagging snapshots and live rows, but a new turn shows again", async () => {
  const env = boot();
  snap(env, node());
  stop(env).click();
  await env.settle();
  assert.equal(status(env).hidden, true);
  snap(env, node());
  env.fire("deck-conversation-live", { sid: "s", view: { sid: "s", phase: "tool", tool: "terminal", since: env.clock, arg: "", label: { key: "live.thinking" } } });
  env.flush();
  assert.equal(status(env).hidden, true, "the stopped turn's lagging signals do not return");
  snap(env, node({ turnId: "t2" }));
  assert.equal(status(env).hidden, false, "a newer turn shows");
  stop(env).click();
  await env.settle();
  env.fire("deck-conversation-turn", { sid: "s", type: "local.sent", payload: {}, at: env.clock });
  env.flush();
  assert.equal(status(env).hidden, false, "the user's next message starts a fresh turn");
});

test("Stop prefers the app's stop service so app control state is reconciled", async () => {
  const env = boot();
  const calls = [];
  const base = env.win.DeckShell.service;
  env.win.DeckShell.service = name => name === "stopTurn" ? (arg) => { calls.push(arg); return Promise.resolve({ status: "interrupted" }); } : base(name);
  snap(env, node());
  stop(env).click();
  await env.settle();
  assert.equal(JSON.stringify(calls), JSON.stringify([{ sid: "s", profile: "default", turnId: "t1" }]));
  assert.equal(env.mutations.length, 0, "no second interrupt through the bridge");
  assert.equal(status(env).hidden, true);
});

test("switching session while Stop is in flight does not clear the new session's status", async () => {
  const env = boot();
  snap(env, node(), node({ sid: "b", turnId: "tb" }));
  let release;
  const base = env.win.DeckShell.service;
  env.win.DeckShell.service = name => name === "stopTurn" ? () => new Promise(r => { release = r; }) : base(name);
  stop(env).click();
  env.select({ id: "b", sid: "b", kind: "hermes", channel: "hermes", profile: "default" });
  snap(env, node(), node({ sid: "b", turnId: "tb" }));
  assert.equal(status(env).hidden, false);
  release({ status: "interrupted" });
  await env.settle();
  assert.equal(status(env).hidden, false, "the result belongs to session s");
});

test("a closed bridge link hides the working status and disables Escape", async () => {
  const env = boot();
  snap(env, node());
  env.bridgeEvent({ t: "status", status: "closed" });
  env.flush();
  assert.equal(status(env).hidden, true);
  const e = env.key(env.input, "Escape");
  await env.settle();
  assert.equal(e.defaultPrevented, false);
  assert.equal(env.mutations.length, 0);
});
