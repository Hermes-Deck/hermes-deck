"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const D = require("../renderer/diff-view");
const TD = require("../renderer/tool-detail");
const I18N = require("../renderer/i18n");

const kinds = file => file.hunks.flatMap(hk => hk.lines.map(l => `${l.t}:${l.text}`));
const numbers = file => file.hunks.flatMap(hk => hk.lines.map(l => [l.o, l.n]));
// A fake `h` that records the tree; leaves must stay plain strings (text nodes), never markup.
const h = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, children: kids.flat(Infinity).filter(x => x != null && x !== false) });
const walk = (node, out = []) => { out.push(node); for (const c of node.children || []) if (typeof c === "object") walk(c, out); return out; };
const text = node => typeof node === "string" ? node : (node.children || []).map(text).join(" ");

test("unified diffs parse into numbered hunks, several files and the no-newline marker", () => {
  const diff = [
    "--- a//srv/example/src/app.js", "+++ b//srv/example/src/app.js",
    "@@ -1,3 +1,3 @@ function main() {", " one", "-two", "+TWO", " three",
    "@@ -10,2 +10,3 @@", " ten", "+ten and a half", " eleven",
    "--- a/docs/notes.md", "+++ b/docs/notes.md", "@@ -4 +4 @@", "-last", "\\ No newline at end of file", "+last line", "\\ No newline at end of file",
  ].join("\n");
  const files = D.parseUnified(diff);
  assert.equal(files.length, 2);
  const [app, notes] = files;
  assert.equal(app.path, "/srv/example/src/app.js"); assert.equal(app.op, "edit"); assert.equal(app.complete, true);
  assert.equal(app.hunks.length, 2); assert.equal(app.hunks[0].label, "function main() {");
  assert.deepEqual(kinds(app), ["ctx:one", "del:two", "add:TWO", "ctx:three", "ctx:ten", "add:ten and a half", "ctx:eleven"]);
  assert.deepEqual(numbers(app), [[1, 1], [2, null], [null, 2], [3, 3], [10, 10], [null, 11], [11, 12]]);
  assert.deepEqual([app.added, app.removed], [2, 1]);
  assert.equal(notes.path, "docs/notes.md");
  assert.deepEqual(kinds(notes), ["del:last", "note:No newline at end of file", "add:last line", "note:No newline at end of file"]);
  assert.deepEqual([notes.added, notes.removed], [1, 1]);
});

test("unified diffs mark added, deleted and clipped files honestly", () => {
  const [added] = D.parseUnified("--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n");
  assert.equal(added.op, "add"); assert.equal(added.path, "new.txt"); assert.deepEqual(numbers(added), [[null, 1], [null, 2]]);
  const [gone] = D.parseUnified("--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n");
  assert.equal(gone.op, "delete"); assert.equal(gone.path, "old.txt");
  const [cut] = D.parseUnified("--- a/x.js\n+++ b/x.js\n@@ -1,4 +1,4 @@\n a\n-b\n+B…");
  assert.equal(cut.complete, false, "a hunk short of its counts is incomplete");
});

test("old/new strings diff by line: single change, insert, deletion and replace_all", () => {
  const one = D.fromStrings("a.js", "const x = 1;", "const x = 2;");
  assert.deepEqual(kinds(one), ["del:const x = 1;", "add:const x = 2;"]); assert.equal(one.numbered, false);
  const insert = D.fromStrings("a.js", "start\nend\n", "start\nmiddle 1\nmiddle 2\nend\n");
  assert.deepEqual(kinds(insert), ["ctx:start", "add:middle 1", "add:middle 2", "ctx:end"]); assert.deepEqual([insert.added, insert.removed], [2, 0]);
  const del = D.fromStrings("a.js", "keep\ndrop\nkeep too", "keep\nkeep too");
  assert.deepEqual(kinds(del), ["ctx:keep", "del:drop", "ctx:keep too"]);
  const all = D.fromStrings("a.js", "foo", "bar", { replaceAll: true });
  assert.equal(all.replaceAll, true);
  const long = D.fromStrings("a.js", Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n"), Array.from({ length: 20 }, (_, i) => i === 10 ? "changed" : `l${i}`).join("\n"));
  assert.equal(long.hunks.length, 1); assert.equal(long.hunks[0].skipped, 7, "far context folds into one '7 unchanged lines' separator");
  assert.deepEqual(kinds(long), ["ctx:l7", "ctx:l8", "ctx:l9", "del:l10", "add:changed", "ctx:l11", "ctx:l12", "ctx:l13"]);
  const model = D.fromCall({ tool: "patch", args: JSON.stringify({ path: "/srv/example/a.js", old_string: "x", new_string: "y", replace_all: true }), result: "{\"success\":true}" });
  assert.equal(model.source, "strings"); assert.equal(model.files[0].path, "/srv/example/a.js"); assert.equal(model.files[0].replaceAll, true);
  assert.deepEqual(model.summary, { applied: true, files: 1 });
});

test("V4A patches parse Update (several hunks), Add, Delete and Move", () => {
  const patch = [
    "*** Begin Patch", "*** Update File: src/app.py", "@@ def one():", " a = 1", "-b = 2", "+b = 3", "@@ def two():", "-return 1", "+return 2",
    "*** Add File: src/new.py", "+print('hi')", "+print('bye')", "*** Delete File: src/old.py", "*** Move File: src/a.py -> src/b.py", "*** End Patch",
  ].join("\n");
  const files = D.parseV4A(patch);
  assert.deepEqual(files.map(f => [f.op, f.path, f.from]), [["edit", "src/app.py", null], ["add", "src/new.py", null], ["delete", "src/old.py", null], ["move", "src/b.py", "src/a.py"]]);
  assert.equal(files[0].hunks.length, 2); assert.deepEqual(files[0].hunks.map(hk => hk.label), ["def one():", "def two():"]);
  assert.deepEqual(kinds(files[0]), ["ctx:a = 1", "del:b = 2", "add:b = 3", "del:return 1", "add:return 2"]);
  assert.deepEqual(numbers(files[1]), [[null, 1], [null, 2]], "an added file is numbered from 1");
  assert.ok(files.every(f => f.complete));
  const model = D.fromCall({ tool: "patch", args: JSON.stringify({ mode: "patch", patch }) });
  assert.equal(model.source, "v4a"); assert.equal(model.files.length, 4);
  const cut = D.parseV4A("*** Begin Patch\n*** Update File: x\n-a\n+b");
  assert.equal(cut.at(-1).complete, false, "no End Patch: the patch was cut");
});

test("write_file renders as an all-added file numbered from 1, with its result summary", () => {
  const model = D.fromCall({ tool: "write_file", args: JSON.stringify({ path: "/srv/example/out.txt", content: "a\nb\nc\n" }),
    result: JSON.stringify({ bytes_written: 2048, dirs_created: [], verified: true, resolved_path: "/srv/example/out.txt" }) });
  assert.equal(model.files[0].op, "write"); assert.deepEqual(numbers(model.files[0]), [[null, 1], [null, 2], [null, 3]]);
  assert.deepEqual([model.files[0].added, model.files[0].removed], [3, 0]);
  assert.deepEqual(model.summary, { bytes: 2048, verified: true, dirs: 0 });
  assert.equal(D.size(2048), "2.0 KB"); assert.equal(D.size(512), "512 B");
  assert.equal(D.fromCall({ tool: "write_file", args: '{"path":"a","content":"cut…' }).files.length, 0, "an unreadable preview yields no invented file");
});

test("a complete result diff wins over arguments; a clipped one falls back to the strings; lint errors surface", () => {
  const args = JSON.stringify({ path: "a.js", old_string: "x", new_string: "y" });
  const full = D.fromCall({ tool: "patch", args, result: JSON.stringify({ success: true, diff: "--- a/a.js\n+++ b/a.js\n@@ -5 +5 @@\n-x\n+y\n", lint: { status: "error", output: "a.js:5: bad" } }) });
  assert.equal(full.source, "diff"); assert.deepEqual(numbers(full.files[0]), [[5, null], [null, 5]]); assert.equal(full.lint, "a.js:5: bad");
  const clipped = D.fromCall({ tool: "patch", args, result: JSON.stringify({ success: true, diff: "--- a/a.js\n+++ b/a.js\n@@ -5,3 +5,3 @@\n-x\n" }) });
  assert.equal(clipped.source, "strings");
  const failed = D.fromCall({ tool: "patch", args, result: JSON.stringify({ success: false, error: "old_string not found" }) });
  assert.equal(failed.error, "old_string not found");
  assert.equal(D.fromCall({ tool: "terminal", args: "{}" }), null);
});

test("empty and garbage input never throws", () => {
  for (const bad of [undefined, null, "", "garbage", "@@ nonsense @@", "--- only a header", 42, {}, "*** Begin Patch", "\\ alone"]) {
    assert.doesNotThrow(() => D.parseUnified(bad)); assert.doesNotThrow(() => D.parseV4A(bad));
    assert.doesNotThrow(() => D.fromCall({ tool: "patch", args: bad, result: bad }));
    assert.doesNotThrow(() => D.fromCall({ tool: "write_file", args: bad, result: bad }));
    assert.doesNotThrow(() => D.render(h, D.fromCall({ tool: "patch", args: bad })));
  }
  assert.deepEqual(D.parseUnified("garbage"), []);
  assert.equal(D.render(h, { files: [] }), null);
  assert.equal(D.render(h, null), null);
  assert.doesNotThrow(() => D.fromStrings("x", "", ""));
  const huge = D.fromStrings("x", Array.from({ length: 800 }, (_, i) => `a${i}`).join("\n"), Array.from({ length: 800 }, (_, i) => `b${i}`).join("\n"));
  assert.deepEqual([huge.added, huge.removed], [800, 800], "past the LCS budget: all removed, then all added");
});

test("files past 400 lines are capped with a Show all button that lifts the cap", () => {
  const content = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join("\n");
  const model = D.fromCall({ tool: "write_file", args: JSON.stringify({ path: "big.txt", content }) });
  const full = new Set(), t = (k, v) => I18N.t(k, v);
  let tree = D.render(h, model, { t, key: "k", isFull: k => full.has(k), showAll: k => full.add(k) });
  assert.equal(walk(tree).filter(n => /^dv-line /.test(n.attrs?.class || "")).length, 400);
  const more = walk(tree).find(n => n.attrs?.class === "dv-more");
  assert.equal(text(more), "Show all 450 lines");
  more.attrs.onclick();
  tree = D.render(h, model, { t, key: "k", isFull: k => full.has(k), showAll: k => full.add(k) });
  assert.equal(walk(tree).filter(n => /^dv-line /.test(n.attrs?.class || "")).length, 450);
  assert.ok(!walk(tree).some(n => n.attrs?.class === "dv-more"));
});

test("the renderer builds text nodes only: hostile content stays text, files carry header, counts and gutter", () => {
  const hostile = "<img src=x onerror=alert(1)>";
  const model = D.fromCall({ tool: "patch", args: JSON.stringify({ path: "/srv/example/deep/dir/src/app.js" }),
    result: JSON.stringify({ success: true, diff: `--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-${hostile}\n+safe\n` }) });
  const tree = D.render(h, model, { t: (k, v) => I18N.t(k, v), key: "x" });
  const nodes = walk(tree);
  for (const n of nodes) for (const c of n.children) assert.ok(typeof c === "string" || (c && typeof c === "object" && c.tag), "children are elements or plain text");
  assert.ok(nodes.some(n => n.children.includes(hostile)), "markup arrives as a literal string");
  assert.ok(nodes.every(n => !Object.keys(n.attrs).some(k => /html/i.test(k))));
  assert.match(text(tree), /edit\s+src\/app\.js\s+\+1\s+−1/);
  assert.equal(D.shortPath("/srv/example/deep/dir/src/app.js"), "…/dir/src/app.js");
  assert.ok(nodes.some(n => n.attrs?.class === "dv-body numbered"));
  for (const file of ["diff-view.js", "tool-detail.js", "work-pane.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "../renderer", file), "utf8");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|DOMParser|document\.write/.test(src), `${file} builds markup from strings`);
  }
});

test("full-call reads: only for clipped calls, once per call, again once after a running call ends, LRU-capped", async () => {
  assert.equal(TD.needsFull({ call: "a", tool: "terminal", args: "{}", result: "ok" }), false);
  assert.equal(TD.needsFull({ call: "a", tool: "terminal", result: "x…" }), true);
  assert.equal(TD.needsFull({ call: "a", tool: "terminal", truncated: true }), true);
  assert.equal(TD.needsFull({ call: "a", tool: "patch", args: '{"path":"x","old_str' }), true, "a file tool with unreadable arguments");
  const reads = [], changes = [];
  const full = TD.createFullCalls({ read: async (sid, call) => { reads.push(call); return { call, args: "{}", result: reads.length > 1 ? "done" : undefined }; }, onChange: (sid, call) => changes.push(call), cap: 2 });
  const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  assert.equal(full.get("s", { call: "plain", tool: "terminal", status: "ok", result: "ok" }), null);
  const running = { call: "r", tool: "terminal", status: "running", args: "x…" };
  assert.equal(full.get("s", running).state, "loading"); await tick();
  full.get("s", running); await tick(); assert.deepEqual(reads, ["r"]);
  full.get("s", { ...running, status: "ok" }); await tick(); assert.deepEqual(reads, ["r", "r"], "read once more for the result");
  full.get("s", { ...running, status: "ok" }); await tick(); assert.equal(reads.length, 2);
  assert.equal(full.peek("s", "r").data.result, "done"); assert.deepEqual(changes, ["r", "r"]);
  full.get("s", { call: "b", result: "x…" }); full.get("s", { call: "c", result: "x…" }); await tick();
  assert.equal(full.size(), 2); assert.equal(full.peek("s", "r"), null, "least recently used goes first");
  const failing = TD.createFullCalls({ read: async () => { throw Error("offline"); } });
  const entry = failing.get("s", { call: "f", result: "x…" }); await tick();
  assert.equal(entry.state, "error"); failing.forget("s", "f"); assert.equal(failing.peek("s", "f"), null);
});

test("detail output prefers a readable error, then the full result", () => {
  assert.deepEqual(TD.outputOf({ err: "boom", result: "r" }), { text: "boom", error: true });
  assert.deepEqual(TD.outputOf({ err: "cut…", result: "full" }), { text: "full", error: false });
  assert.deepEqual(TD.outputOf({}), { text: "", error: false });
  const merged = TD.merged({ call: "a", args: "x…", result: "y…", truncated: true }, { data: { args: "X", result: "Y", truncated: true } });
  assert.deepEqual([merged.args, merged.result, merged.truncated, merged.capped], ["X", "Y", false, true]);
});
