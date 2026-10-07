"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { rootSandboxArgs } = require("../src/browser");

test("headless Chrome gets --no-sandbox only for root on Linux", () => {
  assert.deepStrictEqual(rootSandboxArgs("linux", 0), ["--no-sandbox"]);
  assert.deepStrictEqual(rootSandboxArgs("linux", 1000), []);
  assert.deepStrictEqual(rootSandboxArgs("darwin", 0), []);
  assert.deepStrictEqual(rootSandboxArgs("win32", -1), []);
});
