"use strict";
// History window of the Hermes chat (renderer/history-window.js): the opening window, the merge under older
// pages, the prepend that never duplicates, and the "near the top" trigger for automatic older pages.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const HW = require("../renderer/history-window");

const row = (i) => ({ id: `m${i}`, role: i % 2 ? "user" : "assistant", text: `t${i}` });
const ids = (list) => list.map((m) => m.id);

/** A fake bridge over `total` stored rows: latest-first paging by offset, like session.messages order=latest. */
function bridge(total, calls = []) {
  return (offset, limit) => {
    calls.push([offset, limit]);
    const end = total - offset;
    const start = Math.max(0, end - limit);
    const messages = [];
    for (let i = start; i < end; i++) messages.push(row(i));
    return Promise.resolve({ messages, offset: offset + limit, hasMore: start > 0, returned: messages.length });
  };
}

test("openingWindow: loads the latest 200 rows in 100-row requests, oldest first", async () => {
  const calls = [];
  const w = await HW.openingWindow(bridge(1000, calls));
  assert.deepEqual(calls, [[0, 100], [100, 100]]);
  assert.equal(w.messages.length, 200);
  assert.equal(w.messages.at(-1).id, "m999");
  assert.equal(w.messages[0].id, "m800");
  assert.equal(w.offset, 200);
  assert.equal(w.hasMore, true);
});

test("openingWindow: a short session needs one request and has nothing more", async () => {
  const calls = [];
  const w = await HW.openingWindow(bridge(30, calls));
  assert.deepEqual(calls, [[0, 100]]);
  assert.equal(w.messages.length, 30);
  assert.equal(w.hasMore, false);
});

test("openingWindow: 150 rows end after the second request without a third", async () => {
  const calls = [];
  const w = await HW.openingWindow(bridge(150, calls));
  assert.equal(calls.length, 2);
  assert.equal(w.messages.length, 150);
  assert.equal(w.hasMore, false);
});

test("openingWindow: a failing older request fails the whole open (the caller shows the error)", async () => {
  let n = 0;
  await assert.rejects(HW.openingWindow(async () => { if (n++) throw new Error("boom"); return { messages: [row(1)], offset: 100, hasMore: true, returned: 100 }; }), /boom/);
});

test("prependOlder: puts a page in front and drops rows the list already has (the window slid)", () => {
  const msgs = [row(5), row(6)];
  const out = HW.prependOlder(msgs, [row(3), row(4), row(5)]);
  assert.deepEqual(ids(out), ["m3", "m4", "m5", "m6"]);
  const noId = HW.prependOlder([{ role: "user", text: "a" }], [{ role: "user", text: "b" }]);
  assert.equal(noId.length, 2);
});

test("mergeLatest: the poll's newest page replaces the tail; older pages stay put", () => {
  const old = [row(1), row(2), row(3), row(4)];
  const merged = HW.mergeLatest(old, [row(3), row(4), row(5)]);
  assert.deepEqual(ids(merged), ["m1", "m2", "m3", "m4", "m5"]);
  assert.equal(HW.mergeLatest(old, []), old);
  assert.equal(HW.mergeLatest(old, [row(9)]), null); // no overlap: the caller reloads
  assert.equal(HW.mergeLatest(old, [{ role: "user", text: "x" }]), null); // rows without ids cannot be matched
});

test("distanceFromTop: column-reverse scroller (scrollTop 0 = newest, negative going up)", () => {
  const box = { scrollHeight: 5000, clientHeight: 600, scrollTop: 0 };
  assert.equal(HW.distanceFromTop(box), 4400);
  box.scrollTop = -4000;
  assert.equal(HW.distanceFromTop(box), 400);
  box.scrollTop = -4400;
  assert.equal(HW.distanceFromTop(box), 0);
  assert.equal(HW.distanceFromTop({ scrollHeight: 100, clientHeight: 600, scrollTop: 0 }), 0); // short list: at the top
});

test("wantsOlder: only a loaded session with more pages, idle, not failed, near the top", () => {
  const st = { loaded: true, hasMore: true, loading: false, olderFailed: false };
  assert.equal(HW.wantsOlder(st, 100), true);
  assert.equal(HW.wantsOlder(st, HW.NEAR_TOP + 1), false);
  assert.equal(HW.wantsOlder({ ...st, loading: true }, 0), false);
  assert.equal(HW.wantsOlder({ ...st, hasMore: false }, 0), false);
  assert.equal(HW.wantsOlder({ ...st, olderFailed: true }, 0), false);
  assert.equal(HW.wantsOlder({ ...st, loaded: false }, 0), false);
  assert.equal(HW.wantsOlder(undefined, 0), false);
});

test("scroll anchor: a column-reverse scroller keeps the view when older rows are added above", () => {
  // In a column-reverse box the offset is measured from the newest end, so adding height at the top (older
  // rows) leaves scrollTop - and therefore the rows on screen - unchanged. This pins that arithmetic.
  const box = { scrollHeight: 5000, clientHeight: 600, scrollTop: -4200 };
  const bottomGap = (b) => -b.scrollTop; // px between the newest end and the viewport bottom
  const before = bottomGap(box);
  box.scrollHeight += 3000; // an older page rendered
  assert.equal(bottomGap(box), before);
  assert.equal(HW.distanceFromTop(box), 3200); // 5000+3000-600-4200: the next trigger is far away again
});
