"use strict";
// Windows MSIX virtualization: a Deck started from a packaged app (Claude, Codex) writes its AppData into that
// package's LocalCache copy, so it would keep a second, diverging settings.json (main/launch-context.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { virtualizingPackage } = require("../main/launch-context");

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-launch-"));
  const local = path.join(root, "Local");
  const userData = path.join(root, "Roaming", "hermes-deck");
  fs.mkdirSync(path.join(local, "Packages", "Some.App_x"), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  return { root, local, userData };
}

test("a normal launch: the marker stays in userData, no package copy has it", () => {
  const w = world();
  assert.equal(virtualizingPackage({ userData: w.userData, localAppData: w.local, platform: "win32" }), null);
  assert.deepEqual(fs.readdirSync(w.userData), [], "the marker is removed again");
});

test("a launch inside a package's virtualization: the marker turns up in that package's LocalCache copy", () => {
  const w = world();
  const cache = path.join(w.local, "Packages", "Claude_abc", "LocalCache", "Roaming", "hermes-deck");
  fs.mkdirSync(cache, { recursive: true });
  // what Windows does for a virtualized process: its write to userData lands in the package copy
  const redirect = { writeFileSync: (p, data) => fs.writeFileSync(path.join(cache, path.basename(p)), data), unlinkSync: (p) => fs.rmSync(path.join(cache, path.basename(p)), { force: true }) };
  // the check only runs on Windows: say so explicitly, so the test exercises it on any CI runner
  assert.equal(virtualizingPackage({ userData: w.userData, localAppData: w.local, platform: "win32", fsw: redirect }), "Claude_abc");
  assert.deepEqual(fs.readdirSync(cache), [], "the marker is removed again");
});

test("not Windows, or no LocalAppData: nothing to check", () => {
  const w = world();
  assert.equal(virtualizingPackage({ userData: w.userData, localAppData: "" }), null);
  assert.equal(virtualizingPackage({ userData: w.userData, localAppData: w.local, platform: "darwin" }), null);
});
