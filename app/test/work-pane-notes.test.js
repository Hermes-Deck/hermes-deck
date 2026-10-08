"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const W = require("../renderer/work-pane");

test("agentNotes returns an empty string for tool-only or leading-partial tails", () => {
  assert.equal(W.agentNotes('partial output\n12:34:56 tool     | -> read_file({})\ncontinuation\n12:34:57 result   | raw output'), "");
  assert.equal(W.agentNotes("only a partial entry\nwithout any timestamp"), "");
  assert.equal(W.agentNotes(undefined), "");
  assert.equal(W.agentNotes("12:34:56 assistant| A\r\ncontinuation\r\n12:34:57 result   | Ignore"), "A\ncontinuation");
});

test("agentNotes keeps assistant, final and think entries with continuation lines, never partial prefixes or tool logs", () => {
  const text = [
    "partial result from a clipped entry", "second partial line",
    "12:34:56 tool     | -> read_file({\"path\":\"example.js\"})",
    "tool argument continuation", "12:34:57 result   | read_file ok 0.1s: {\"content\":\"raw log\"}",
    "result continuation", "12:34:58 think    | Check the boundary case.", "Keep the next line.",
    "12:34:59 assistant| The file needs one change.", "```js", "const safe = true;", "```",
    "12:35:00 tool     | -> patch(...)\nignore me", "12:35:01 final    | The change is complete."
  ].join("\n");
  assert.equal(W.agentNotes(text), "Check the boundary case.\nKeep the next line.\n\nThe file needs one change.\n```js\nconst safe = true;\n```\n\nThe change is complete.");
});
