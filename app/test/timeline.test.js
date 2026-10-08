"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const T = require("../renderer/timeline");
test("timeline positions bound ticks to content and nearest selection works at both ends", () => {
  const marks = T.positions([{ type: "user", y: -10 }, { type: "failed", y: 500 }, { type: "heading", y: 1200 }], 1000);
  assert.deepEqual(marks.map(m => m.ratio), [0, .5, 1]);
  assert.equal(T.nearest(marks, -.2).type, "user");
  assert.equal(T.nearest(marks, .6).type, "failed");
  assert.equal(T.nearest(marks, 2).type, "heading");
  assert.equal(T.nearest([], .5), null);
  assert.equal(T.positions(Array.from({ length: 1000 }, (_, y) => ({ y })), 1000).length, T.MAX_TICKS);
});
test("zero-height content produces finite positions", () => {
  assert.equal(T.positions([{ y: 20 }], 0)[0].ratio, 0);
});
