"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const picker = require("../renderer/model-picker");

test("native model commands are explicitly session scoped and preserve bracket ids/custom providers", () => {
  assert.equal(typeof picker.modelCommand, "function");
  assert.equal(picker.modelCommand({ id: "claude-opus-5-5[1m]", provider: "anthropic" }), "/model claude-opus-5-5[1m] --provider anthropic --session");
  assert.equal(picker.modelCommand({ id: "vendor/model_name", provider: "custom:lab" }, "example_bot"), "/model@example_bot vendor/model_name --provider custom:lab --session");
  assert.deepEqual(picker.parseCustom("@custom:lab:claude-opus-5-5[1m]", [], ""), { provider: "custom:lab", model: "claude-opus-5-5[1m]" });
  for (const id of ["m --global", "m\n/model other", "--global", "m'", ""]) assert.throws(() => picker.modelCommand({ id, provider: "p" }));
  assert.throws(() => picker.modelCommand({ id: "m", provider: "p --global" }));
  assert.throws(() => picker.modelCommand({ id: "m", provider: "p" }, "bot /model"));
  for (const o of [{ id: "m" }, { provider: "p" }, { id: 123, provider: "p" }]) assert.throws(() => picker.modelCommand(o));
});

test("native reasoning accepts only effort words and has no persistence flag", () => {
  assert.equal(typeof picker.reasoningCommand, "function");
  for (const level of picker.EFFORTS) assert.equal(picker.reasoningCommand(level), `/reasoning ${level}`);
  assert.equal(picker.reasoningCommand("high", "example_bot"), "/reasoning@example_bot high");
  for (const level of ["show", "hide", "off", "high --global", "HIGH", ""]) assert.throws(() => picker.reasoningCommand(level));
});
