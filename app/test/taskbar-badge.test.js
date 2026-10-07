"use strict";
// The taskbar badge (main/taskbar-badge.js): what it says for a summary, and a disc that reads at 16 px.
const test = require("node:test");
const assert = require("node:assert");
const { badgeText, badgeCount, badgePixels, badgePng, FONT } = require("../main/taskbar-badge");

test("badgeText: replies plus questions, nothing at zero, 9+ past nine", () => {
  assert.strictEqual(badgeText({ unread: 0, pending: 0 }), "");
  assert.strictEqual(badgeText(null), "");
  assert.strictEqual(badgeText({ unread: 2, pending: 1 }), "3");
  assert.strictEqual(badgeText({ unread: 9 }), "9");
  assert.strictEqual(badgeText({ unread: 76, pending: 1 }), "9+");
  assert.strictEqual(badgeCount({ unread: 76, pending: 1 }), 77);
  assert.strictEqual(badgeCount({ unread: -3, pending: "x", running: 5 }), 0, "running agents are not waiting for the user");
});

test("badge: every glyph is 5x7; the disc is amphora with white ink, corners clear", () => {
  for (const [c, g] of Object.entries(FONT)) {
    assert.strictEqual(g.length, 7, c);
    for (const row of g) assert.strictEqual(row.length, 5, c);
  }
  for (const text of ["1", "8", "9+"]) {
    const size = 32;
    const px = badgePixels(text, size);
    const at = (x, y) => [...px.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
    assert.strictEqual(at(0, 0)[3], 0, "corner transparent");
    let white = 0;
    let amphora = 0;
    for (let i = 0; i < size * size; i++) {
      const [r, g, b, a] = px.subarray(i * 4, i * 4 + 4);
      if (a === 255 && r > 240 && g > 240 && b > 240) white++;
      if (a === 255 && Math.abs(r - 0xc9) < 6 && Math.abs(g - 0x6a) < 6 && Math.abs(b - 0x4e) < 6) amphora++;
    }
    assert.ok(white > 30, `${text}: digits drawn (${white} px)`);
    assert.ok(amphora > white, `${text}: on the amphora disc`);
  }
  const buf = badgePng("3");
  assert.deepStrictEqual([...buf.subarray(1, 4)], [0x50, 0x4e, 0x47], "a PNG");
});
