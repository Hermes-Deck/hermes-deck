"use strict";
// Composer pickers (renderer/model-picker.js): the pure helpers, and how app.js / index.html wire the chips in.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const MP = require("../renderer/model-picker");
const i18n = require("../renderer/i18n");

const RENDERER = path.join(__dirname, "..", "renderer");
const opt = (provider, id, extra = {}) => ({ id, provider, providerName: extra.providerName || provider, ...extra });

// a model.options projection shaped like the live inventory: a subscription, a custom provider, an aggregator
const OPTIONS = [
  opt("openrouter", "z-ai/glm-4.6", { providerName: "OpenRouter" }),
  opt("openrouter", "anthropic/claude-sonnet-4-5-20250929", { providerName: "OpenRouter" }),
  opt("claude-sub", "claude-opus-5", { providerName: "Claude Subscription", providerCurrent: true, current: true }),
  opt("claude-sub", "claude-haiku-4", { providerName: "Claude Subscription", providerCurrent: true }),
  opt("custom:labrelay", "lab-model-1.5", { providerName: "Lab Relay", userDefined: true }),
  opt("openai-codex", "gpt-5.10", { providerName: "OpenAI Codex" }),
  opt("openai-codex", "gpt-5.9", { providerName: "OpenAI Codex" }),
];

test("shortName drops the vendor path and a date stamp", () => {
  assert.equal(MP.shortName("anthropic/claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
  assert.equal(MP.shortName("lab-model-1.5"), "lab-model-1.5");
  assert.equal(MP.shortName(""), "");
});

test("groups: current provider first, then by name; models by name, numeric-aware; custom providers included", () => {
  const g = MP.buildGroups(OPTIONS, { currentProvider: "claude-sub" });
  assert.deepEqual(g.map((x) => x.name), ["Claude Subscription", "Lab Relay", "OpenAI Codex", "OpenRouter"]);
  assert.deepEqual(g[0].models.map((o) => o.id), ["claude-haiku-4", "claude-opus-5"]);
  assert.deepEqual(g[2].models.map((o) => o.id), ["gpt-5.9", "gpt-5.10"], "5.9 before 5.10");
  assert.deepEqual(g[3].models.map((o) => MP.shortName(o.id)), ["claude-sonnet-4-5", "glm-4.6"]);
  assert.equal(g[1].userDefined, true);
  assert.equal(g.reduce((n, x) => n + x.models.length, 0), OPTIONS.length, "every model is listed");
});

test("search filters across groups by name, id, provider slug or provider name; every word must match", () => {
  const ids = (q) => MP.buildGroups(OPTIONS, { query: q }).flatMap((x) => x.models.map((o) => o.id));
  assert.deepEqual(ids("labrelay"), ["lab-model-1.5"]);
  assert.deepEqual(ids("LAB-MODEL"), ["lab-model-1.5"]);
  assert.deepEqual(ids("anthropic"), ["anthropic/claude-sonnet-4-5-20250929"], "matches the full id, not only the short name");
  assert.deepEqual(ids("codex 5.10"), ["gpt-5.10"]);
  assert.deepEqual(ids("claude"), ["claude-haiku-4", "claude-opus-5", "anthropic/claude-sonnet-4-5-20250929"]);
  assert.deepEqual(ids("nothing-like-this"), []);
  assert.equal(ids("   ").length, OPTIONS.length, "a blank query shows all");
});

test("currentOption: Hermes' flag first, else the reported model under the reported provider", () => {
  assert.equal(MP.currentOption({ options: OPTIONS }).id, "claude-opus-5");
  const plain = OPTIONS.map((o) => ({ ...o, current: false }));
  assert.equal(MP.currentOption({ options: plain, current: { model: "gpt-5.9", provider: "openai-codex" } }).id, "gpt-5.9");
  assert.equal(MP.currentOption({ options: plain, current: { model: "gone", provider: "x" } }), null);
  assert.equal(MP.currentOption(null), null);
});

test("reasoning levels follow the model's capabilities", () => {
  assert.deepEqual(MP.effortsFor({ reasoning: true, canDisable: null }), MP.EFFORTS.slice());
  assert.deepEqual(MP.effortsFor({ reasoning: true, canDisable: false }), MP.EFFORTS.filter((e) => e !== "none"));
  assert.deepEqual(MP.effortsFor({ reasoning: false }), []);
  assert.deepEqual(MP.effortsFor(null), MP.EFFORTS.slice(), "unknown model: the standard set");
  assert.deepEqual(MP.EFFORTS, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("effortKey maps the plugin's report onto the levels", () => {
  assert.equal(MP.effortKey("off"), "none");
  assert.equal(MP.effortKey("HIGH"), "high");
  assert.equal(MP.effortKey("xhigh"), "xhigh");
  assert.equal(MP.effortKey(""), "");
  assert.equal(MP.effortKey("fast"), "", "provider-specific words show as Default");
});

test("custom model id: bare id on the session's provider, or @provider:model with colon slugs", () => {
  const slugs = new Set(["custom:labrelay", "openrouter"]);
  assert.deepEqual(MP.parseCustom("my-model", slugs, "openrouter"), { provider: "openrouter", model: "my-model" });
  assert.deepEqual(MP.parseCustom("@custom:labrelay:lab-2", slugs, "x"), { provider: "custom:labrelay", model: "lab-2" });
  assert.deepEqual(MP.parseCustom("@openrouter:z-ai/glm-5", slugs, "x"), { provider: "openrouter", model: "z-ai/glm-5" });
  assert.deepEqual(MP.parseCustom("@custom:new:m-1", slugs, "x"), { provider: "custom:new", model: "m-1" }, "an unlisted custom provider");
  assert.deepEqual(MP.parseCustom("@nous:hermes-5", slugs, "x"), { provider: "nous", model: "hermes-5" });
  for (const bad of ["", "two words", "m --global", "@:m", "@p:", "@p q:m"]) assert.equal(MP.parseCustom(bad, slugs, "openrouter"), null, bad);
  assert.equal(MP.parseCustom("m", slugs, ""), null, "no provider to put a bare id on");
});

test("every pick.* key exists in English and Turkish; the effort labels cover every level and Default", () => {
  const en = Object.keys(i18n.tables.en).filter((k) => k.startsWith("pick."));
  assert.ok(en.length >= 25);
  for (const k of en) assert.equal(typeof i18n.tables.tr[k], "string", k);
  for (const e of [...MP.EFFORTS, "default"]) assert.ok(`pick.effort.${e}` in i18n.tables.en, e);
  const src = fs.readFileSync(path.join(RENDERER, "model-picker.js"), "utf8");
  for (const [, k] of src.matchAll(/\bT\("([\w.]+)"/g)) assert.ok(k in i18n.tables.en, `missing key ${k}`);
  assert.ok(!/\bT\("pick\.effort\.\$/.test(src));
});

test("wiring: index.html loads the picker before app.js; the header menu is gone; chips sit left of Send", () => {
  const html = fs.readFileSync(path.join(RENDERER, "index.html"), "utf8");
  assert.ok(html.includes('href="model-picker.css"'));
  assert.ok(html.indexOf('src="model-picker.js"') > 0 && html.indexOf('src="model-picker.js"') < html.indexOf('src="app.js"'));
  const app = fs.readFileSync(path.join(RENDERER, "app.js"), "utf8");
  assert.ok(!/hermesHeadMenu|hermesHeadControls|headMenu/.test(app), "no chat-header overflow menu");
  assert.match(app, /window\.DeckModelPicker\.create\(/);
  assert.match(app, /e\.key\.toLowerCase\(\) === "k"/, "Ctrl+K opens the model picker");
  const src = fs.readFileSync(path.join(RENDERER, "model-picker.js"), "utf8");
  assert.match(src, /send\.parentNode\.insertBefore\(bar, send\)/, "the chips go right before Send");
  assert.match(src, /setEffort\(sid, \{ effort/);
  assert.match(src, /T\("live\.showThinking"\)/, "Show thinking lives in the reasoning popover");
});

test("Settings: the SSH setup wizard and its main-process backend are gone; the connection fields stay", () => {
  const app = fs.readFileSync(path.join(RENDERER, "app.js"), "utf8");
  assert.ok(!/renderWizard|loadKeyInfo|scanHost|trustHost|createKey|copyKey|bridge\.ssh/.test(app));
  for (const id of ["s-br-mode", "s-br-target", "s-br-python", "s-br-stream", "s-br-dist"]) assert.ok(app.includes(`"${id}"`), id);
  assert.match(app, /onclick: testBridge/, "Test connection stays");
  assert.equal(fs.existsSync(path.join(__dirname, "..", "main", "sshsetup.js")), false);
  const main = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "main", "preload.js"), "utf8");
  assert.ok(!/bridge:ssh-|sshsetup/.test(main) && !/bridge:ssh-/.test(preload));
  assert.match(preload, /"bridge:set-effort"/);
});
