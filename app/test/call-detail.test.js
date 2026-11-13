"use strict";
// A tool call unfolded where it stands in the transcript (call-detail.js): only that call, its arguments and output,
// and nothing else moves (no receipt reveal, no Run pane) unless "Open in Run" is chosen.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const CD = require("../renderer/call-detail");
const TD = require("../renderer/tool-detail");
const I = require("../renderer/i18n");
I.extend(require("../renderer/i18n-b"));
for (const f of ["i18n-c", "i18n-d"]) { try { I.extend(require(`../renderer/${f}`)); } catch { /* not every build has it */ } }

const h = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter((k) => k != null && k !== false) });
const walk = (x) => [x, ...(x.kids || []).filter((k) => typeof k === "object").flatMap(walk)];
const texts = (x) => walk(x).flatMap((n) => n.kids.filter((k) => typeof k === "string"));
const settle = () => new Promise((r) => setImmediate(r));

function make({ receipt = [], storedCalls = [], full = null } = {}) {
  const reveals = [], reads = [], fullReads = [];
  let redraws = 0;
  const deck = {
    bridge: { toolCalls: async (sid, opts) => { reads.push([sid, opts]); return storedCalls; } },
    ...(full ? { toolCall: async (sid, call) => { fullReads.push(call); return full; } } : {}),
  };
  const cd = CD.create({ h, t: I.t, deck, redraw: () => { redraws++; }, receipts: () => ({ calls: () => receipt }), detail: () => TD,
    copy: async () => {}, emitReveal: (d) => reveals.push(d), setTimer: () => 0 });
  return { cd, reveals, reads, fullReads, redraws: () => redraws };
}

test("a folded call draws nothing; unfolding shows that call's arguments and output from the turn's receipt", () => {
  const long = `cd /work/app && python3 - <<'EOF'\n${"line\n".repeat(400)}EOF`;
  const w = make({ receipt: [
    { call: "a", tool: "terminal", args: JSON.stringify({ command: "git status" }), status: "ok", ms: 100, result: "clean" },
    { call: "b", tool: "terminal", args: JSON.stringify({ command: long, timeout: 400 }), status: "ok", ms: 9700, result: "clippy=0\ntest=0\nlast line of the output" },
  ] });
  const c = { id: "b", name: "terminal", arg: "cd /work/app && pyth…" };
  assert.equal(w.cd.el("s", c), null);
  assert.equal(w.cd.isOpen("s", "b"), false);
  w.cd.toggle("s", "b");
  assert.equal(w.cd.isOpen("s", "b"), true);
  assert.equal(w.cd.isOpen("s", "a"), false, "the other calls stay folded");
  assert.equal(w.redraws(), 1);
  const el = w.cd.el("s", c);
  assert.equal(el.attrs.class, "tc-detail");
  const all = texts(el);
  assert.ok(all.includes(long), "the whole command, to its last line");
  assert.ok(all.includes("clippy=0\ntest=0\nlast line of the output"), "the whole output");
  assert.ok(all.includes("400") || all.includes('400'), "the other arguments");
  assert.deepEqual(w.reads, [], "a call the receipt knows needs no read");
  assert.deepEqual(w.reveals, [], "nothing is revealed anywhere else");
  // folding it back
  w.cd.toggle("s", "b");
  assert.equal(w.cd.el("s", c), null);
});

test("'Open in Run' is the only way to the Run pane", () => {
  const w = make({ receipt: [{ call: "a", tool: "terminal", args: "{}", status: "ok", result: "x" }] });
  w.cd.toggle("s", "a");
  const el = w.cd.el("s", { id: "a", name: "terminal", arg: "" }, { ts: 101 });
  const run = walk(el).find((n) => n.attrs.class === "tc-run");
  assert.deepEqual(run.kids, [I.t("calls.openRun")]);
  assert.deepEqual(w.reveals, []);
  run.attrs.onclick();
  assert.deepEqual(w.reveals, [{ sid: "s", call: "a", ts: 101 }]);
});

test("a call of an older turn is read from the session's stored calls, once; a running call shows its arguments", async () => {
  const w = make({ storedCalls: [{ call: "old", tool: "read_file", args: JSON.stringify({ path: "/work/app/a.txt" }), status: "ok", result: "file body" }] });
  const c = { id: "old", name: "read_file", arg: "/work/app/a.txt" };
  w.cd.toggle("s", "old", "ada");
  const first = w.cd.el("s", c, { profile: "ada" });
  assert.ok(texts(first).includes(I.t("tooldetail.loading")), "says it is loading");
  assert.ok(texts(first).some((x) => x.includes("/work/app/a.txt")), "the line's own argument meanwhile");
  await settle();
  assert.deepEqual(w.reads, [["s", { profile: "ada" }]]);
  assert.ok(texts(w.cd.el("s", c)).includes("file body"));
  w.cd.toggle("s", "old"); w.cd.toggle("s", "old");
  await settle();
  assert.equal(w.reads.length, 1, "read once per session");
  // a call made after that read is not in it: unfolding it reads again
  w.cd.toggle("s", "newer");
  await settle();
  assert.equal(w.reads.length, 2);
  // still running: arguments now, no output yet
  const r = make({ receipt: [{ call: "run", tool: "terminal", args: JSON.stringify({ command: "sleep 60" }), status: "running", ms: null }] });
  r.cd.toggle("s", "run");
  const el = r.cd.el("s", { id: "run", name: "terminal", arg: "sleep 60" });
  assert.ok(texts(el).includes("sleep 60") && texts(el).includes(I.t("work.running")));
});

test("a preview that was cut is read in full", async () => {
  const w = make({ receipt: [{ call: "a", tool: "terminal", args: '{"command":"cd /work && very long…', status: "ok", result: "short…" }],
    full: { args: JSON.stringify({ command: "cd /work && very long command to its end" }), result: "the complete output" } });
  w.cd.toggle("s", "a");
  w.cd.el("s", { id: "a", name: "terminal", arg: "" });
  await settle();
  assert.deepEqual(w.fullReads, ["a"]);
  const all = texts(w.cd.el("s", { id: "a", name: "terminal", arg: "" }));
  assert.ok(all.includes("cd /work && very long command to its end") && all.includes("the complete output"));
});

test("wiring: the transcript's call line toggles in place and the modules load before app.js", () => {
  const app = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
  const at = app.indexOf("function hermesCallsEl(");
  const body = app.slice(at, app.indexOf("\n  }", at));
  assert.match(body, /onclick: \(\) => CD\.toggle\(sid, c\.id, where\.profile\)/);
  assert.match(body, /open \? CD\.el\(sid, c, where\) : null/);
  assert.doesNotMatch(body, /deck-tool-reveal/, "a click reveals nothing in the receipt or the Run pane");
  const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
  const pos = (s) => html.indexOf(`src="${s}"`);
  assert.ok(pos("tool-detail.js") > 0 && pos("tool-detail.js") < pos("call-detail.js") && pos("call-detail.js") < pos("app.js"));
  assert.equal(html.split('src="tool-detail.js"').length, 2, "loaded once");
});
