"use strict";
// One product version: compat.json, app/package.json, relay/package.json, the plugin's plugin.yaml and the
// version/protocol constants the plugin and the relay report (stream.py deck.version, install.py installed.json,
// relay/src/compat.js) must all agree. The release cut bumps them together.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

test("compat.json, both package.json files and plugin.yaml carry one version", () => {
  const compat = JSON.parse(read("compat.json"));
  assert.match(compat.version, SEMVER);
  assert.ok(Number.isInteger(compat.protocol) && compat.protocol >= 1, "protocol is a positive integer");
  assert.match(compat.minHermes, SEMVER);
  for (const part of ["app", "relay", "plugin"]) assert.match(compat.minimum[part], SEMVER, `minimum.${part}`);
  assert.strictEqual(JSON.parse(read("app", "package.json")).version, compat.version, "app/package.json");
  assert.strictEqual(JSON.parse(read("relay", "package.json")).version, compat.version, "relay/package.json");
  const yaml = /^version:\s*["']?([^"'\s]+)["']?\s*$/m.exec(read("hermes-plugin", "hermes-deck", "plugin.yaml"));
  assert.ok(yaml, "plugin.yaml has a version line");
  assert.strictEqual(yaml[1], compat.version, "plugin.yaml");
});

test("the plugin and the relay report the compat.json version and protocol", () => {
  const compat = JSON.parse(read("compat.json"));
  const stream = read("hermes-plugin", "hermes-deck", "stream.py");
  assert.strictEqual(/^VERSION = "([^"]+)"$/m.exec(stream)?.[1], compat.version, "stream.py VERSION");
  assert.strictEqual(Number(/^PROTOCOL = (\d+)$/m.exec(stream)?.[1]), compat.protocol, "stream.py PROTOCOL");
  const install = read("hermes-plugin", "hermes-deck", "install.py");
  assert.strictEqual(Number(/^PROTOCOL = (\d+)/m.exec(install)?.[1]), compat.protocol, "install.py PROTOCOL");
  const relay = require("../src/compat");
  assert.strictEqual(relay.VERSION, compat.version);
  assert.strictEqual(relay.PROTOCOL, compat.protocol);
});
