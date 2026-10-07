"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { snapResult } = require("../main/space-tunnel");

test("snapshot listings pass stop and cleanup notices through to the relay", () => {
  const id = (n) => `00000000-0000-4000-8000-00000000000${n}`;
  const r = snapResult("snapshots", { ok: true, points: [], notice: { id: id(2), time: 2, event: "cleanup-failed" },
    notices: [{ id: id(1), time: 1, event: "stopped" }, { id: id(2), time: 2, event: "cleanup-failed" }, { id: id(3), time: 3, event: "bogus" }] });
  assert.deepStrictEqual(r.notices.map((n) => n.event), ["stopped", "cleanup-failed"]);
  assert.strictEqual(r.notice.event, "cleanup-failed");
});
