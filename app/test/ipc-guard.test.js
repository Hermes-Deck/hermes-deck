"use strict";
// Security audit L4: every IPC channel of the Deck's main window answers only the Deck's own page. main.js
// is loaded in a child process with a stand-in for Electron whose ipcMain records each registration; the run
// goes as far as the Workspace tab (presence + workspace channels) and stops before the desktop shell. Each
// recorded handler is then called as a foreign frame: invoke handlers must refuse, send handlers must do
// nothing. No window, no relay, no browser.
//   node --test "app/test/*.test.js"
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { isApp, fromApp, appIpc, GUARDED, REFUSED } = require("../main/ipc-guard");

const MAIN = path.join(__dirname, "..", "main", "main.js");
const PRELOAD = path.join(__dirname, "..", "main", "preload.js");

const PROBE = `
const Module = require("module");
const path = require("path");
const STOP = new Error("probe stop");
const { GUARDED, REFUSED } = require(path.join(process.env.PROBE_MAIN_DIR, "ipc-guard"));
const stub = (name) => new Proxy(function () {}, {
  get: (_t, k) => (k === "then" || typeof k === "symbol" ? undefined : stub(name + "." + String(k))),
  apply: () => stub(name + "()"),
  construct: () => stub("new " + name),
});
const handlers = [];
const ipcMain = {
  handle: (channel, fn) => handlers.push({ channel, kind: "handle", fn }),
  on: (channel, fn) => handlers.push({ channel, kind: "on", fn }),
};
const app = new Proxy({}, {
  get: (_t, k) => {
    if (k === "getPath") return (what) => path.join(process.env.PROBE_TMP, what);
    if (k === "requestSingleInstanceLock") return () => true;
    if (k === "whenReady") return () => Promise.resolve();
    if (k === "isPackaged") return false;
    if (k === "getVersion") return () => "0.0.0";
    if (k === "then" || typeof k === "symbol") return undefined;
    return stub("app." + String(k));
  },
});
const electron = new Proxy({}, { get: (_t, k) => (k === "app" ? app : k === "ipcMain" ? ipcMain : k === "__esModule" ? false : stub(String(k))) });
const resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === "electron" ? "electron" : resolve.call(this, req, ...rest); };
require.cache.electron = { id: "electron", filename: "electron", loaded: true, exports: electron };
const dir = process.env.PROBE_MAIN_DIR;
const desktop = require(path.join(dir, "desktop"));
desktop.shotPet = () => false;
desktop.init = () => { throw STOP; }; // the Workspace tab's channels are registered by then
const cua = require(path.join(dir, "cua"));
cua.shotBar = () => false;
const done = () => {
  const out = handlers.map(({ channel, kind, fn }) => {
    let refused = null;
    if (kind === "handle") {
      try {
        fn({ senderFrame: { url: "https://example.com/" } });
        refused = false;
      } catch (e) {
        refused = e.message === REFUSED;
      }
    }
    return { channel, kind, guarded: !!fn[GUARDED], refused };
  });
  process.stdout.write("PROBE " + JSON.stringify(out) + "\\n");
  process.exit(0);
};
process.on("unhandledRejection", (e) => (e === STOP ? done() : (console.error(e), process.exit(3))));
process.prependListener("uncaughtException", (e) => (e === STOP ? done() : (console.error(e), process.exit(4))));
require(path.join(dir, "main.js"));
setTimeout(() => { console.error("probe: never reached desktop.init"); process.exit(5); }, 10000);
`;

function probe() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deck-ipc-"));
  try {
    const env = { ...process.env, PROBE_TMP: tmp, PROBE_MAIN_DIR: path.dirname(MAIN), HOME: tmp, USERPROFILE: tmp, TMPDIR: tmp };
    const r = spawnSync(process.execPath, ["-e", PROBE], { env, encoding: "utf8", timeout: 30_000 });
    const line = String(r.stdout || "").split("\n").find((l) => l.startsWith("PROBE "));
    assert.ok(line, `probe failed (${r.status}): ${r.stderr}`);
    return JSON.parse(line.slice(6));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("ipc: every main-window channel refuses a foreign frame (bridge, settings, tg, login, media, relay, ws, device)", () => {
  const got = probe();
  const byChannel = new Map(got.map((h) => [h.channel, h]));
  // every channel the main window's preload uses, except the bot screen's (cua/index.js checks e.sender against
  // its window in its own wrapper) and the desktop shell's (desktop.js: e.sender === win.webContents), which are
  // registered later, in their own modules
  const preload = fs.readFileSync(PRELOAD, "utf8");
  const used = [...new Set([...preload.matchAll(/ipcRenderer\.(?:invoke|send)\("([^"]+)"/g)].map((m) => m[1]))].filter((ch) => !/^(bs|desktop):/.test(ch));
  const missing = used.filter((ch) => !byChannel.has(ch));
  assert.deepEqual(missing, [], "registered before desktop.init");
  for (const ch of used) {
    const h = byChannel.get(ch);
    assert.equal(h.guarded, true, `${ch} goes through ipc-guard`);
    if (h.kind === "handle") assert.equal(h.refused, true, `${ch} refuses a foreign frame`);
  }
  // the c9 review's list, by name
  for (const ch of ["tg:media", "tg:media-open", "tg:media-save", "tg:login-start", "tg:login-answer", "tg:login-cancel", "tg:logout", "tg:retry", "bridge:send", "bridge:set-effort", "settings:get", "settings:save", "device:set-hosting", "ws:navigate", "relay:messages", "open-external", "ready"]) {
    assert.equal((byChannel.get(ch) || {}).guarded, true, ch);
  }
  // the work pane's channels (Lane C): sub-agent roster, tail, steer and interrupt, the plan (bridge and relay paths)
  // and the latest tool calls; each one is in the preload and refuses a foreign frame
  for (const ch of ["bridge:subagents", "bridge:subagent-tail", "bridge:subagent-steer", "bridge:subagent-interrupt", "bridge:plan", "bridge:tool-calls", "relay:plan", "relay:tools"]) {
    assert.ok(used.includes(ch), `${ch} is in the preload`);
    assert.deepEqual([byChannel.get(ch)?.kind, byChannel.get(ch)?.guarded, byChannel.get(ch)?.refused], ["handle", true, true], ch);
  }
});

test("ipc-guard: handle refuses and on ignores a foreign frame; the Deck's page passes", async () => {
  const reg = {};
  const ipc = appIpc({ handle: (ch, fn) => (reg[ch] = fn), on: (ch, fn) => (reg[ch] = fn) });
  const calls = [];
  ipc.handle("x:get", (_e, a) => (calls.push(["get", a]), a * 2));
  ipc.on("x:send", (_e, a) => calls.push(["send", a]));
  const own = { senderFrame: { url: "deck://app/index.html", parent: null } };
  const pet = { senderFrame: { url: "deck://app/pet.html" } };
  assert.equal(reg["x:get"](own, 21), 42);
  assert.throws(() => reg["x:get"](pet, 1), new RegExp(REFUSED));
  reg["x:send"](own, 1);
  reg["x:send"](pet, 2);
  reg["x:send"]({}, 3);
  assert.deepEqual(calls, [["get", 21], ["send", 1]]);
  assert.equal(reg["x:get"][GUARDED], true);
  assert.throws(() => fromApp({ senderFrame: null }), new RegExp(REFUSED));
  assert.equal(isApp({ senderFrame: { url: "deck://app/index.html?x=1" } }), true);
});
