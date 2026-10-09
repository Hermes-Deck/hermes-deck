"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const devtokens = require("../src/devtokens");

test("adding tokens preserves a symlink to shared devices", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-devtokens-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const linkPath = path.join(root, "release", "relay", "devices.json");
  const shared = path.join(root, "shared", "devices.json");
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    fs.symlinkSync("../../shared/devices.json", linkPath, "file");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.skip("Windows symlink creation requires permission");
      return;
    }
    throw error;
  }

  const token = devtokens.add(linkPath, "pc");
  assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
  assert.ok(fs.existsSync(shared));
  assert.equal(devtokens.match(linkPath, token), "pc");

  const nextToken = devtokens.add(linkPath, "pc2");
  assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
  assert.equal(devtokens.match(shared, token), "pc");
  assert.equal(devtokens.match(shared, nextToken), "pc2");
});
