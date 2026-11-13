"use strict";
// The command box above the composer's working row: the command a turn runs (or ran last), clipped or whole.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { boot } = require("./composer-dom-helper");
const LA = require("../renderer/live-activity");

const node = (extra = {}) => ({ sid: "s", state: "working", turnId: "t1", controlAvailable: true, ownerPid: 7, bound: false, terminalAt: null, steps: ["terminal"], ...extra });
const snap = (env, ...nodes) => { env.bridgeEvent({ t: "snapshot", snapshot: { nodes } }); env.flush(); };
const live = (env, view) => { env.fire("deck-conversation-live", { sid: "s", view: view && { sid: "s", phase: "tool", tool: "terminal", since: env.clock, arg: "", label: { key: "live.thinking" }, ...view } }); env.flush(); };
const box = (env) => env.doc.querySelector(".conv-cmd");

test("the whole command is kept: the command itself with real line breaks, then the other arguments", () => {
  const long = `cd /srv/app && for f in a b c; do\n  echo "$f"\ndone\n${"x".repeat(5000)}\nlast line`;
  assert.equal(LA.detailArg({ command: long, timeout: 600, workdir: "/srv/app", background: false, empty: "" }), `${long}\n\ntimeout: 600\nworkdir: /srv/app\nbackground: false`);
  assert.equal(LA.detailArg({ code: "print(1)\nprint(2)" }), "print(1)\nprint(2)");
  assert.equal(LA.detailArg("plain"), "plain");
  assert.equal(LA.detailArg({ a: 1, b: [2] }), JSON.stringify({ a: 1, b: [2] }, null, 2));
  assert.equal(LA.detailArg(null), "");
  assert.equal(LA.detailArg({}), "");
  assert.equal(LA.detailArg({ command: "y".repeat(LA.MAX_CMD + 50) }).length, LA.MAX_CMD);
  // through the turn's events: Hermes sends the full arguments as `args`
  const h = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, kids, addEventListener() {}, isConnected: true });
  const la = LA.create({ h, i18nText: (k) => k, ticker: () => h("span"), now: () => 1000 });
  la.event("s", "message.start");
  assert.equal(la.view("s").cmd, null);
  la.event("s", "tool.start", { name: "terminal", tool_id: "a", args: { command: long } });
  assert.deepEqual(la.view("s").cmd, { tool: "terminal", text: long, running: true });
  assert.ok(la.view("s").arg.length <= 300, "the one-line preview stays short");
  la.event("s", "tool.complete", { tool_id: "a" });
  assert.deepEqual(la.view("s").cmd, { tool: "terminal", text: long, running: false }, "the last command stays until the next one");
  la.event("s", "message.delta", { text: "Done" });
  assert.equal(la.view("s").cmd.text, long);
  la.event("s", "tool.start", { name: "read_file", tool_id: "b", args: { path: "/srv/app/a.txt" } });
  assert.deepEqual(la.view("s").cmd, { tool: "read_file", text: "/srv/app/a.txt", running: true });
});

test("the box sits above the working row, shows the whole text, and folds between clipped and full", () => {
  const env = boot();
  snap(env, node());
  live(env, {});
  assert.equal(box(env).hidden, true, "no command: no box");
  const text = "line 1\nline 2\nline 3\nline 4\nthe last line";
  live(env, { arg: '{"command":"line 1…', cmd: { tool: "terminal", text, running: true } });
  const b = box(env);
  assert.equal(b.hidden, false);
  assert.equal(b.nextElementSibling, env.doc.getElementById("composer-status"), "directly above the Thinking / Stop row");
  assert.equal(b.querySelector(".conv-cmd-text").textContent, text, "every line is in the box");
  assert.equal(b.querySelector(".conv-cmd-lines").textContent, "5 lines");
  assert.equal(b.querySelector(".conv-cmd-tool").textContent, "Running terminal");
  assert.equal(env.doc.querySelector(".conv-arg").textContent, "", "the one-line preview is not repeated beside it");
  const toggle = b.querySelector(".conv-cmd-toggle");
  assert.ok(!b.classList.contains("open") && toggle.attrs["aria-expanded"] === "false", "clipped by default");
  toggle.click();
  assert.ok(b.classList.contains("open") && toggle.attrs["aria-expanded"] === "true");
  // the same command painted again leaves the text node alone (a selection or scroll position in it stays)
  const pre = b.querySelector(".conv-cmd-text"), kept = pre.firstChild;
  pre.scrollTop = 40;
  live(env, { cmd: { tool: "terminal", text, running: false } });
  assert.equal(pre.firstChild, kept);
  assert.equal(pre.scrollTop, 40);
  assert.equal(b.querySelector(".conv-cmd-tool").textContent, "Last: terminal");
  assert.ok(b.classList.contains("open"), "stays unfolded for the next command");
  live(env, { cmd: { tool: "execute_code", text: "print(1)", running: true } });
  assert.equal(pre.textContent, "print(1)");
  assert.equal(pre.scrollTop, 0);
  assert.equal(b.querySelector(".conv-cmd-lines").textContent, "");
  toggle.click();
  assert.ok(!b.classList.contains("open"));
});

test("styles: clipped to three lines, unfolded scrolls inside its own box", () => {
  const css = fs.readFileSync(path.join(__dirname, "../renderer/composer.css"), "utf8");
  assert.match(css, /\.conv-cmd-text \{[^}]*white-space: pre-wrap;[^}]*-webkit-line-clamp: 3; overflow: hidden; \}/);
  assert.match(css, /\.conv-cmd\.open \.conv-cmd-text \{ display: block; -webkit-line-clamp: none; max-height: min\(34vh, 320px\); overflow: auto;/);
  assert.match(css, /\.conv-cmd\[hidden\] \{ display: none; \}/);
});
