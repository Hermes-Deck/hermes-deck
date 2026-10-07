"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { PassThrough } = require("node:stream");
const { captureOutput } = require("../main/cua/capture-output");
const args = { pid: 12, window_id: 34 };
const meta = { ...args, snapshot_id: "native-snapshot", capture_id: "native-capture", screenshot_width: 320, screenshot_height: 180 };
function child() { const c = new EventEmitter(); return Object.assign(c, { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} }); }
function collect(p) { let out = ""; p.stdout.on("data", b => { out += b; }); return () => out; }

test("window capture overrides default media denial only for its live video worker", async () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const session = { setPermissionCheckHandler(fn) { this.check = fn; }, setPermissionRequestHandler(fn) { this.request = fn; }, webRequest: { onBeforeRequest() {} } };
  let destroyed = false;
  const wc = { id: 41, session, setWindowOpenHandler() {}, on() {},
    async executeJavaScript() {
      // Without a partition-specific check handler, the app's default media denial wins.
      assert.equal(session.check?.(wc, "media", "file://worker", { mediaType: "video" }) ?? false, true);
      assert.equal(session.check(wc, "media", "", { mediaType: "audio" }), false);
      assert.equal(session.check({ id: 99 }, "media", "", { mediaType: "video" }), false);
      assert.equal(session.check(null, "media", "", {}), false);
      assert.equal(session.check(wc, "clipboard-read", "", {}), false);
      let allowed;
      session.request(wc, "media", v => { allowed = v; }, { mediaTypes: ["video"] });
      assert.equal(allowed, true);
      session.request(wc, "media", v => { allowed = v; }, { mediaTypes: ["video", "audio"] });
      assert.equal(allowed, false);
      return "data:image/png;base64,ZmFrZQ==";
    } };
  class Window { constructor() { this.webContents = wc; } async loadFile() {} isDestroyed() { return destroyed; } destroy() { destroyed = true; } }
  const bounds = { x: 0, y: 0, width: 320, height: 180 };
  const context = { module: { exports: {} }, __dirname: __dirname, setTimeout, clearTimeout, require(id) {
    if (id === "./frontmost") return { readWindow: async () => ({ bounds, extendedBounds: bounds }) };
    if (id === "electron") return { BrowserWindow: Window, desktopCapturer: { getSources: async () => [{ id: "window:34:0" }] }, nativeImage: { createFromDataURL: () => ({ isEmpty: () => false, resize: () => ({ toPNG: () => Buffer.from("fresh") }) }) } };
    return require(id);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../main/cua/window-capture.js"), "utf8"), context);
  const frame = await context.module.exports.captureWindow({ id: 34 }, { width: 320 }, () => true);
  assert.equal(frame.toString(), "fresh");
  assert.equal(destroyed, true);
  assert.equal(session.check(wc, "media", "", { mediaType: "video" }), false, "finished workers lose media access");
});

test("MCP: the exact window gets fresh pixels; native grounding ids stay intact and close waits for capture", async () => {
  const c = child(); let finish;
  const p = captureOutput(c, ["mcp"], async (_args, body) => { assert.equal(body.capture_id, "native-capture"); await new Promise(r => { finish = r; }); return Buffer.from("fresh-window"); });
  const out = collect(p);
  p.stdin.write(JSON.stringify({ id: 7, method: "tools/call", params: { name: "get_window_state", arguments: args } }) + "\n");
  const reply = JSON.stringify({ id: 7, result: { structuredContent: meta, content: [{ type: "image", mimeType: "image/png", data: "OLD" }] } }) + "\n";
  c.stdout.write(reply.slice(0, 50)); c.stdout.write(reply.slice(50)); c.emit("close", 0, null);
  let closed = false; p.on("close", () => { closed = true; });
  await new Promise(r => setImmediate(r)); assert.equal(closed, false);
  const done = once(p, "close"); finish(); await done;
  const r = JSON.parse(out());
  assert.equal(r.result.content[0].data, Buffer.from("fresh-window").toString("base64"));
  assert.equal(r.result.structuredContent.capture_id, "native-capture");
  assert.equal(r.result.structuredContent.window_id, 34);
});

test("CLI: pretty JSON is refreshed too; a mismatched window never invokes the capturer", async () => {
  const c = child(); let called = 0;
  const p = captureOutput(c, ["call", "get_window_state", JSON.stringify(args)], async () => { called++; return Buffer.from("fresh"); });
  const out = collect(p); const done = once(p, "close");
  c.stdout.write(JSON.stringify({ ...meta, screenshot_png_b64: "OLD" }, null, 2)); c.emit("close", 0, null); await done;
  assert.equal(JSON.parse(out()).screenshot_png_b64, Buffer.from("fresh").toString("base64"));
  const bad = child(); const q = captureOutput(bad, ["call", "get_window_state", JSON.stringify(args)], async () => { called++; return Buffer.from("wrong"); });
  const badOut = collect(q); const badDone = once(q, "close");
  bad.stdout.write(JSON.stringify({ ...meta, pid: 99, screenshot_png_b64: "OTHER_WINDOW" })); bad.emit("close", 0, null); await badDone;
  assert.equal(called, 1); assert.ok(JSON.parse(badOut()).error); assert.ok(!badOut().includes("OTHER_WINDOW"));
});

test("revoked/failed fresh capture returns an error, never the old GDI image", async () => {
  const c = child(); const p = captureOutput(c, ["call", "get_window_state", JSON.stringify(args)], async () => { throw Error("window grant ended"); });
  const out = collect(p); const done = once(p, "close");
  c.stdout.write(JSON.stringify({ ...meta, screenshot_png_b64: "OLD" })); c.emit("close", 0, null); await done;
  assert.match(JSON.parse(out()).error, /window grant ended/); assert.ok(!out().includes("OLD"));
});
