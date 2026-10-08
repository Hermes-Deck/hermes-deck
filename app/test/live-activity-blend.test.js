"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const LA = require("../renderer/live-activity");
const TB = require("../renderer/think-block");
const I = require("../renderer/i18n");
I.extend(require("../renderer/i18n-b"));
test("finished reasoning labels measured time without inventing duration for stored history", () => {
  const tb = TB.create({ h, i18nText: I.t });
  const label = el => walk(el).find(x => x.attrs.class === "tb-label").kids[0];
  assert.equal(label(tb.el("Reason", "s:m", 3)), "Thought for 3s");
  assert.equal(label(tb.el("Old reason", "s:old")), "Thought");
});
const h = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat().filter(Boolean), addEventListener() {}, isConnected: true });
const walk = (x) => [x, ...(x.kids || []).filter(k => typeof k === "object").flatMap(walk)];
test("live tool arguments are bounded and reasoning streams even with disclosure closed", () => {
  const la = LA.create({ h, i18nText: I.t, ticker: () => h("span"), now: () => 1000 });
  la.event("s", "tool.start", { name: "terminal", arguments: { command: "npm test" } });
  assert.equal(la.view("s").arg, '{"command":"npm test"}');
  la.event("s", "reasoning.delta", { text: "Check the result." });
  assert.ok(walk(la.row(la.view("s"))).some(x => x.attrs.class === "la-think" && x.kids[0] === "Check the result."));
  la.event("s", "tool.complete", {});
  assert.equal(la.view("s").arg, "");
});
test("thinking duration excludes tool time", () => {
  let now = 1000;
  const la = LA.create({ h, i18nText: I.t, ticker: () => h("span"), now: () => now });
  la.event("s", "message.start");
  now = 3000; la.event("s", "tool.start", { name: "terminal" });
  now = 8000; la.event("s", "tool.complete");
  now = 9000; la.event("s", "message.complete");
  assert.equal(LA.thoughtSeconds("s"), 3);
});
