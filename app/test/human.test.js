"use strict";
// Readable numbers (renderer/human.js): durations and compact counts every view shares, in English and Turkish.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const H = require("../renderer/human");
const I18N = require("../renderer/i18n");

test("durations read like people write them: 4.2s, 42s, 2m 05s, 6h 38m, 2d 3h", () => {
  I18N.setLanguage("en");
  const cases = [
    [0, "0s"], [40, "<0.1s"], [999, "1.0s"], [4200, "4.2s"], [9960, "10s"], [42000, "42s"],
    [59900, "1m 00s"], [125000, "2m 05s"], [3599000, "59m 59s"], [3599600, "1h 00m"],
    [23902200, "6h 38m"], [86399000, "23h 59m"], [183600000, "2d 3h"],
  ];
  for (const [ms, want] of cases) assert.equal(H.duration(ms), want, `${ms} ms`);
  assert.doesNotMatch(H.duration(23902200), /23902/, "never the raw seconds the owner saw");
  for (const bad of [null, undefined, -1, NaN, Infinity, "x", ""]) assert.equal(H.duration(bad), "", String(bad));
  assert.equal(H.duration("4200"), "4.2s", "a numeric string still reads");
});

test("counts are compact with one decimal below 100 and the exact figure for tooltips", () => {
  I18N.setLanguage("en");
  const cases = [[0, "0"], [999, "999"], [999.6, "1k"], [1000, "1k"], [12400, "12.4k"], [99960, "100k"], [124000, "124k"],
    [999960, "1M"], [2905482981, "2.9B"], [2.9e6, "2.9M"], [29e6, "29M"]];
  for (const [n, want] of cases) assert.equal(H.count(n), want, String(n));
  assert.equal(H.count(undefined), "0");
  assert.equal(H.count(-5), "0");
  assert.equal(H.exact(2905482981), "2,905,482,981");
  assert.equal(H.exact(null), "0");
});

test("Turkish units and decimals come from the tr table", () => {
  I18N.setLanguage("tr");
  try {
    assert.equal(H.duration(4200), "4,2sn");
    assert.equal(H.duration(125000), "2dk 05sn");
    assert.equal(H.duration(23902200), "6sa 38dk");
    assert.equal(H.duration(183600000), "2g 3sa");
    assert.equal(H.count(12400), "12,4k");
    assert.equal(H.count(2905482981), "2,9Mr");
    assert.equal(H.exact(2905482981), "2.905.482.981");
  } finally { I18N.setLanguage("en"); }
});
