"use strict";
// Split view layout logic (main/host-layout.js): pane placement, the select swap rule, split on/off, removal,
// the divider's bounds and clamping. Pure functions, no Electron.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const L = require("../main/host-layout");

const one = { primary: "a", split: false, right: "", ratio: 0.5 };
const two = { primary: "a", split: true, right: "b", ratio: 0.5 };
const IDS = ["a", "b", "c"];

test("placement: every page gets its own host id, its pane, and both panes; a hidden page has pane null", () => {
  assert.deepEqual(L.placement(one, "a"), { split: false, pane: "full", hostId: "a", panes: [{ side: "full", hostId: "a" }] });
  assert.deepEqual(L.placement(one, "b"), { split: false, pane: null, hostId: "b", panes: [{ side: "full", hostId: "a" }] });
  assert.deepEqual(L.placement(two, "b"), { split: true, pane: "right", hostId: "b", panes: [{ side: "left", hostId: "a" }, { side: "right", hostId: "b" }] });
  assert.equal(L.placement(two, "c").pane, null);
  assert.deepEqual(L.shown(two), ["a", "b"]);
  assert.deepEqual(L.shown(one), ["a"]);
});

test("select: the caller's pane takes the host; the panes swap when the other pane already shows it", () => {
  assert.deepEqual(L.select(one, "a", "b"), { ...one, primary: "b" });
  assert.deepEqual(L.select(two, "a", "c"), { ...two, primary: "c" }, "left pane changes, right stays");
  assert.deepEqual(L.select(two, "b", "c"), { ...two, right: "c" }, "right pane changes, left stays");
  assert.deepEqual(L.select(two, "a", "b"), { ...two, primary: "b", right: "a" }, "swap from the left");
  assert.deepEqual(L.select(two, "b", "a"), { ...two, primary: "b", right: "a" }, "swap from the right");
  assert.deepEqual(L.select(two, "c", "b"), { ...two, primary: "b", right: "a" }, "a hidden page counts as the primary pane");
  assert.deepEqual(L.select(two, "a", "a"), two, "selecting the shown host changes nothing");
});

test("setSplit: on opens the first host not on screen; off keeps the caller's pane; one host cannot split", () => {
  assert.deepEqual(L.setSplit(one, true, "a", IDS), { ...one, split: true, right: "b" });
  assert.deepEqual(L.setSplit({ ...one, primary: "b" }, true, "b", IDS), { ...one, primary: "b", split: true, right: "a" });
  assert.throws(() => L.setSplit(one, true, "a", ["a"]), /mview\.needTwo/);
  assert.throws(() => L.setSplit(one, true, "a", []), /mview\.needTwo/);
  assert.deepEqual(L.setSplit(two, true, "a", IDS), two, "already split");
  assert.deepEqual(L.setSplit(two, false, "a", IDS), { ...two, split: false, right: "" });
  assert.deepEqual(L.setSplit(two, false, "b", IDS), { ...two, primary: "b", split: false, right: "" }, "the right pane's page keeps the screen");
  assert.deepEqual(L.setSplit(one, false, "a", IDS), one);
});

test("without: a removed right host closes the split; a removed primary hands over to the right pane or the next host", () => {
  assert.deepEqual(L.without(two, "b", IDS), { ...two, split: false, right: "" });
  assert.deepEqual(L.without(two, "a", IDS), { ...two, primary: "b", split: false, right: "" });
  assert.deepEqual(L.without(one, "a", IDS), { ...one, primary: "b" });
  assert.deepEqual(L.without(one, "c", IDS), one, "a hidden host leaves nothing on screen");
  assert.deepEqual(L.without(one, "a", ["a"]), { ...one, primary: "" });
});

test("normalize: a stored state keeps only a saved, non-primary right host and an in-range ratio", () => {
  assert.deepEqual(L.normalize({ primary: "a", split: true, right: "b", ratio: 0.3 }, IDS), { primary: "a", split: true, right: "b", ratio: 0.3 });
  assert.deepEqual(L.normalize({ primary: "a", split: true, right: "a", ratio: 0.3 }, IDS), { primary: "a", split: false, right: "", ratio: 0.3 });
  assert.deepEqual(L.normalize({ primary: "a", split: true, right: "zz", ratio: 7 }, IDS), { primary: "a", split: false, right: "", ratio: 0.5 });
  assert.deepEqual(L.normalize({ primary: "a", split: false, right: "b" }, IDS), { primary: "a", split: false, right: "", ratio: 0.5 });
  assert.deepEqual(L.normalize(null, IDS), { primary: "", split: false, right: "", ratio: 0.5 });
});

test("bounds: one full pane, or two panes around a divider with a minimum pane width; narrow windows stay equal", () => {
  assert.deepEqual(L.paneBounds({ width: 1500, height: 900 }, one), { full: { x: 0, y: 0, width: 1500, height: 900 } });
  const b = L.paneBounds({ width: 1500, height: 900 }, two);
  assert.equal(b.left.width + b.divider.width + b.right.width, 1500);
  assert.equal(b.divider.width, L.DIVIDER);
  assert.equal(b.left.width, b.right.width);
  const narrow = L.paneBounds({ width: 1100, height: 900 }, { ...two, ratio: 0.2 });
  assert.ok(narrow.left.width >= L.MIN_PANE && narrow.right.width >= L.MIN_PANE, "both panes keep the minimum");
  assert.equal(narrow.right.x, narrow.left.width + L.DIVIDER);
  const tiny = L.paneBounds({ width: 500, height: 400 }, { ...two, ratio: 0.2 });
  assert.equal(tiny.left.width, tiny.right.width, "too narrow for two minimum panes: equal halves");
  assert.equal(L.clampRatio(0.9, 1500), L.clampRatio(0.99, 1500));
  assert.equal(L.clampRatio(0.5, 1500), 0.5);
  assert.equal(L.clampRatio(NaN, 1500), 0.5);
});

test("ratioAt: dragging the divider maps the pointer to a clamped ratio", () => {
  assert.ok(Math.abs(L.ratioAt(750 + L.DIVIDER / 2, 1500) - 0.5) < 0.01);
  assert.equal(L.ratioAt(10, 1500), L.clampRatio(0, 1500));
  assert.equal(L.ratioAt(1490, 1500), L.clampRatio(1, 1500));
  assert.equal(L.ratioAt(100, 0), 0.5);
});
