"use strict";
// Headless screenshot runs never use the user's own profile: main.js is loaded in a child process with a
// stand-in for Electron, and the run stops right after the settings are set up. It reports where userData
// went and whether the saved settings (with the relay token) were read. No window, no relay, no browser.
//   node --test "app/test/*.test.js"
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const MAIN = path.join(__dirname, "..", "main", "main.js");

// Runs in the child: a deep no-op Electron, a recording app.setPath and Settings.load, and a stop right after
// settings (cua.shotBar is the next call in main.js's whenReady).
const PROBE = `
const Module = require("module");
const path = require("path");
const out = { userData: null, loaded: false };
const STOP = new Error("probe stop");
const stub = (name) => new Proxy(function () {}, {
  get: (_t, k) => (k === "then" || typeof k === "symbol" ? undefined : stub(name + "." + String(k))),
  apply: () => stub(name + "()"),
  construct: () => stub("new " + name),
});
const electron = new Proxy({}, { get: (_t, k) => (k === "app" ? app : k === "__esModule" ? false : stub(String(k))) });
const app = new Proxy({}, {
  get: (_t, k) => {
    if (k === "setPath") return (what, p) => { if (what === "userData") out.userData = p; };
    if (k === "getPath") return (what) => path.join(process.env.PROBE_TMP, what);
    if (k === "requestSingleInstanceLock") return () => true;
    if (k === "whenReady") return () => Promise.resolve();
    if (k === "isPackaged") return false;
    if (k === "then" || typeof k === "symbol") return undefined;
    return stub("app." + String(k));
  },
});
const resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === "electron" ? "electron" : resolve.call(this, req, ...rest); };
require.cache.electron = { id: "electron", filename: "electron", loaded: true, exports: electron };
const dir = process.env.PROBE_MAIN_DIR;
const { Settings } = require(path.join(dir, "settings"));
Settings.prototype.load = function () { out.loaded = true; return this; };
// --shot-pet now returns before settings load, so the stop is the first call after them: cua's shotBar()
const desktop = require(path.join(dir, "desktop"));
desktop.shotPet = () => false;
const cua = require(path.join(dir, "cua"));
cua.shotBar = () => { throw STOP; };
const done = () => { process.stdout.write("PROBE " + JSON.stringify(out) + "\\n"); process.exit(0); };
process.on("unhandledRejection", (e) => (e === STOP ? done() : (console.error(e), process.exit(3))));
process.prependListener("uncaughtException", (e) => (e === STOP ? done() : (console.error(e), process.exit(4))));
require(path.join(dir, "main.js"));
setTimeout(() => { console.error("probe: never reached settings"); process.exit(5); }, 10000);
`;

function probe(args) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deck-shot-"));
  try {
    // HOME points into the temp folder too: nothing here may read the real ~/.hermes-deck
    const env = { ...process.env, PROBE_TMP: tmp, PROBE_MAIN_DIR: path.dirname(MAIN), HOME: tmp, USERPROFILE: tmp };
    const r = spawnSync(process.execPath, ["-e", PROBE, "--", ...args], { env, encoding: "utf8", timeout: 30_000 });
    const line = String(r.stdout || "").split("\n").find((l) => l.startsWith("PROBE "));
    assert.ok(line, `probe failed (${r.status}): ${r.stderr}`);
    return { ...JSON.parse(line.slice(6)), tmp };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("shot: --workspace-agent alone runs in a temp profile and never reads the saved settings or relay token", () => {
  const r = probe(["--shot=ws.png", "--tab=workspace", "--workspace-agent=scout"]);
  assert.equal(r.userData, path.join(r.tmp, "temp", "hermes-deck-ws-demo"), "userData moved to a temp folder");
  assert.equal(r.loaded, false, "settings.load() must not run (it reads the stored relay token)");
});

test("shot: --workspace-demo and --fixture keep their temp profiles; a plain run reads its settings", () => {
  const demo = probe(["--shot=ws.png", "--workspace-demo=https://example.com/", "--workspace-agent=scout"]);
  assert.equal(demo.userData, path.join(demo.tmp, "temp", "hermes-deck-ws-demo"));
  assert.equal(demo.loaded, false);
  const fixture = probe(["--shot=x.png", `--fixture=${path.join(__dirname, "fixtures", "telegram.json")}`]);
  assert.equal(fixture.userData, path.join(fixture.tmp, "temp", "hermes-deck-fixture"));
  assert.equal(fixture.loaded, false);
  const plain = probe(["--shot=x.png", "--tab=fleet"]);
  assert.equal(plain.userData, null, "an ordinary shot keeps the default profile");
  assert.equal(plain.loaded, true);
});
