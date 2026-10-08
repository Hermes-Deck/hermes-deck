"use strict";
// Settings > Hermes config: the renderer's pure helpers (renderer/hermes-config-view.js), the main side's argument
// checks and answer mapping (main/hermes-config.js), and the wiring into settings-view / index.html / preload.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const i18n = require("../renderer/i18n");
const HV = require("../renderer/hermes-config-view");
const main = require("../main/hermes-config");
const SVM = require("../renderer/settings-view");

const FIELDS = {
  model: { type: "string", description: "Default model", category: "general" },
  "agent.max_turns": { type: "string", description: "Agent → Max Turns", category: "agent", free: true },
  "display.compact": { type: "boolean", description: "Display → Compact", category: "display" },
  "terminal.backend": { type: "select", description: "Terminal execution backend", category: "terminal", options: ["local", "docker"] },
  toolsets: { type: "list", description: "Toolsets", category: "general" },
  "zeta.x": { type: "number", description: "Zeta X", category: "zeta" },
};

test("categories: Hermes' order first, the rest alphabetically", () => {
  assert.deepEqual(HV.categories(FIELDS, ["general", "agent", "display", "nothere"]), ["general", "agent", "display", "terminal", "zeta"]);
});

test("visibleKeys: one category, the changed ones, or a search across all of them", () => {
  assert.deepEqual(HV.visibleKeys(FIELDS, { category: "general" }), ["model", "toolsets"]);
  const draft = new Map([["zeta.x", { value: 2 }]]);
  assert.deepEqual(HV.visibleKeys(FIELDS, { category: HV.CHANGED, explicit: ["display.compact"], draft }), ["display.compact", "zeta.x"]);
  assert.deepEqual(HV.visibleKeys(FIELDS, { category: "zeta", search: "max turns" }), ["agent.max_turns"], "search ignores the category");
  assert.deepEqual(HV.visibleKeys(FIELDS, { search: "BACKEND execution" }), ["terminal.backend"]);
});

test("parseInput: numbers, lists, free (null-default) fields and text", () => {
  assert.deepEqual(HV.parseInput(FIELDS["zeta.x"], "2.5"), { ok: true, value: 2.5 });
  assert.equal(HV.parseInput(FIELDS["zeta.x"], "").ok, false);
  assert.equal(HV.parseInput(FIELDS["zeta.x"], "abc").ok, false);
  assert.deepEqual(HV.parseInput(FIELDS.toolsets, " web \n\nterminal\n"), { ok: true, value: ["web", "terminal"] });
  assert.deepEqual(HV.parseInput(FIELDS.toolsets, "1\n2\nx", [3]), { ok: true, value: [1, 2, "x"] }, "a numeric list stays numeric");
  const free = FIELDS["agent.max_turns"];
  assert.deepEqual(HV.parseInput(free, "60"), { ok: true, value: 60 });
  assert.deepEqual(HV.parseInput(free, ""), { ok: true, value: null });
  assert.deepEqual(HV.parseInput(free, "true"), { ok: true, value: true });
  assert.deepEqual(HV.parseInput(free, "abc"), { ok: true, value: "abc" });
  assert.deepEqual(HV.parseInput(FIELDS.model, "60"), { ok: true, value: "60" }, "a text field keeps text");
});

test("showValue / changes / brief", () => {
  assert.equal(HV.showValue(FIELDS.toolsets, ["a", "b"]), "a\nb");
  assert.equal(HV.showValue(FIELDS.model, null), "");
  assert.deepEqual(HV.changes(new Map([["a", { value: 1 }], ["b", { unset: true }]])), { set: { a: 1 }, unset: ["b"] });
  assert.equal(HV.brief(undefined), "—");
  assert.ok(HV.brief("x".repeat(200)).length <= 80);
});

test("main: save requests are checked before they reach the relay", () => {
  const rev = "a".repeat(64);
  assert.deepEqual(main.checkSave({ profile: "ada", rev, set: { "agent.max_turns": 3 }, unset: ["display.compact"] }), { profile: "ada", rev, set: { "agent.max_turns": 3 }, unset: ["display.compact"] });
  for (const bad of [
    { profile: "../x", rev, set: { a: 1 } },
    { profile: "ada", rev: "short", set: { a: 1 } },
    { profile: "ada", rev, set: {} },
    { profile: "ada", rev, set: { "a b": 1 } },
    { profile: "ada", rev, set: { a: { nested: 1 } } },
    { profile: "ada", rev, set: { a: [{}] } },
    { profile: "ada", rev, set: {}, unset: [5] },
  ]) assert.throws(() => main.checkSave(bad), undefined, JSON.stringify(bad));
});

test("main: relay answers keep the relay's own error text; a bare 404 means an older relay", () => {
  assert.deepEqual(main.answer({ status: 200, body: { ok: true, rev: "x" } }), { ok: true, rev: "x" });
  assert.deepEqual(main.answer({ status: 409, body: { ok: false, error: "changed" } }), { ok: false, status: 409, error: "changed" });
  assert.equal(main.answer({ status: 404, body: {} }).error, i18n.t("hcfg.relayTooOld"));
});

test("main: channels go to the relay with the right routes", async () => {
  const handlers = {};
  const calls = [];
  main.register({ handle: (ch, fn) => (handlers[ch] = fn) }, () => ({ call: async (...a) => (calls.push(a), { status: 200, body: { ok: true } }) }));
  assert.deepEqual(Object.keys(handlers).sort(), ["hcfg:get", "hcfg:restart", "hcfg:restart-state", "hcfg:save", "hcfg:schema"]);
  await handlers["hcfg:get"]({}, "ada");
  await handlers["hcfg:restart"]({}, "gateway");
  assert.deepEqual(calls.map((c) => [c[0], c[1]]), [["GET", "/hermes/config?profile=ada"], ["POST", "/hermes/restart"]]);
  assert.deepEqual(calls[1][2], { target: "gateway" });
  await assert.rejects(handlers["hcfg:restart"]({}, "host"));
  await assert.rejects(handlers["hcfg:get"]({}, "a/b"));
  const none = {};
  main.register({ handle: (ch, fn) => (none[ch] = fn) }, () => null);
  await assert.rejects(none["hcfg:schema"]({}));
});

test("wiring: a Hermes config section, its script before settings-view.js, channels in the preload and main", () => {
  assert.ok(SVM.SECTIONS.includes("hermescfg"));
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  assert.ok(html.indexOf("hermes-config-view.js") > 0 && html.indexOf("hermes-config-view.js") < html.indexOf("settings-view.js\""));
  assert.ok(html.includes("hermes-config-view.css"));
  const preload = fs.readFileSync(path.join(__dirname, "..", "main", "preload.js"), "utf8");
  for (const ch of ["hcfg:schema", "hcfg:get", "hcfg:save", "hcfg:restart-state", "hcfg:restart"]) assert.ok(preload.includes(`"${ch}"`), ch);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8"), /require\("\.\/hermes-config"\)\.register\(ipc,/);
  for (const k of ["set.hermesConfig", "hcfg.restartGateway", "hcfg.reviewTitle"]) assert.ok(i18n.tables.en[k] && i18n.tables.tr[k], k);
});
