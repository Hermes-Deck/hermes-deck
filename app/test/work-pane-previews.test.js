"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const W = require("../renderer/work-pane");
const clip = text => text.length > 300 ? text.slice(0, 300) + "…" : text;

test("Diff never accepts a cut path or invents counts from partial previews", () => {
  for (const args of ['{"path":"part…"}', '{"path":"unfinished…', clip(JSON.stringify({ path: "x".repeat(600) }))]) {
    assert.deepEqual(W.changedFiles([{ tool: "write_file", status: "ok", args }]), []);
  }
  const call = { tool: "patch", status: "ok", args: '{"path":"src/example.js"}' };
  for (const result of ['{"added":10,"removed":5}', JSON.stringify({ diff: "--- a/src/example.js\n+++ b/src/example.js\n@@ -1 +1 @@\n-old\n+new…" })]) {
    assert.deepEqual(W.changedFiles([{ ...call, result }]), [{ name: "example.js", added: null, removed: null }]);
  }
  assert.deepEqual(W.changedFiles([{ ...call, result: JSON.stringify({ diff: "--- a/src/example.js\n+++ b/src/example.js\n@@ -1 +1 @@\n-old\n+new" }) }]),
    [{ name: "example.js", added: 1, removed: 1 }]);
  assert.deepEqual(W.changedFiles([{ ...call, status: "error" }]), []);
});

test("Diff falls back to result file fields and complete headers in clipped patch results", () => {
  for (const result of [
    JSON.stringify({ files_modified: ["src/from-result.js"] }),
    JSON.stringify({ resolved_path: "src/from-result.js" }),
    JSON.stringify({ path: "src/from-result.js" }),
    clip(JSON.stringify({ files_modified: ["src/from-result.js"], diff: "x".repeat(600) })),
    clip(JSON.stringify({ resolved_path: "src/from-result.js", diff: "x".repeat(600) })),
    clip(JSON.stringify({ path: "src/from-result.js", diff: "x".repeat(600) })),
    clip("--- a/src/from-result.js\n+++ b/src/from-result.js\n@@ -1 +1 @@\n-old\n+new\n" + "x".repeat(600)),
    clip(JSON.stringify({ success: true, diff: "--- a/src/from-result.js\n+++ b/src/from-result.js\n@@ -1 +1 @@\n-old\n+new\n" + "x".repeat(600) })),
    clip("+++ b/src/from-result.js\n@@ -1 +1 @@\n-old\n+new\n" + "x".repeat(600))
  ]) {
    assert.deepEqual(W.changedFiles([{ tool: "patch", status: "ok", args: '{"path":"cut…', result }]),
      [{ name: "from-result.js", added: null, removed: null }], result);
  }
});

test("Diff recovers complete escaped paths from write_file args clipped mid-content", () => {
  const args = clip(JSON.stringify({ path: "src/long-file.js", content: "const content = '" + "x".repeat(600) + "';" }));
  assert.ok(args.endsWith("…"));
  assert.throws(() => JSON.parse(args));
  assert.deepEqual(W.changedFiles([{ tool: "functions.write_file", status: "ok", args, result: "Written" }]),
    [{ name: "long-file.js", added: null, removed: null }]);
  const windows = clip(JSON.stringify({ file_path: "C:\\project\\quoted\"file.js", content: "x".repeat(600) }));
  assert.deepEqual(W.changedFiles([{ tool: "write_file", status: "ok", args: windows }]),
    [{ name: 'quoted"file.js', added: null, removed: null }]);
});
