"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readWindow, checkedWindow } = require("../main/cua/frontmost");
const { AttachStore } = require("../main/attach");
const bridge = require("../main/bridge");
const { setLanguage } = require("../renderer/i18n");
setLanguage("tr");
const IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=", "base64");
const RAW = { window_id: 1001, pid: 4242, app_name: "Example", title: "Example document", executable: "C:\\Program Files\\Example\\example.exe" };

test("frontmost resolves one identity, keeps own/password blocks and rechecks capture identity", async () => {
  const calls = [];
  const run = async (file, args, opts) => { calls.push({ file, args, opts }); return { code: 0, stdout: JSON.stringify({ ...RAW, image: IMAGE.toString("base64"), text: "Document text" }) }; };
  const target = await readWindow({ platform: "win32", run });
  const shot = await readWindow({ platform: "win32", run, target, capture: true });
  assert.deepEqual(shot.bytes, IMAGE);
  assert.equal(shot.text, "Document text");
  assert.equal(calls[0].opts.env.HD_WINDOW, "");
  assert.equal(calls[1].opts.env.HD_WINDOW, "1001");
  assert.equal(calls[1].opts.env.HD_WINDOW_PID, "4242");
  assert.ok(calls.every((c) => !c.args.some((a) => /list_windows|list_apps|desktopCapturer/.test(a))));
  assert.throws(() => checkedWindow({ ...RAW, executable: "C:\\Apps\\Bitwarden.exe" }), /Parola/);
  assert.throws(() => checkedWindow(RAW, { ownPids: new Set([4242]) }), /kendi/);
  assert.throws(() => checkedWindow(RAW, { ownExecutable: RAW.executable.toUpperCase() }), /kendi/);
  await assert.rejects(readWindow({ platform: "linux", run }), /Windows ve macOS/);
  await assert.rejects(readWindow({ platform: "win32", run, target: { ...target, pid: 77 }, capture: true }), /değişti/);
  const script = fs.readFileSync(path.join(__dirname, "../main/cua/frontmost.ps1"), "utf8");
  assert.ok(!/EnumWindows|CopyFromScreen|Get-Process\s*(?:\||;|\n)/.test(script));
  assert.match(script, /IsPassword -or \$current.IsOffscreen/);
});

test("appshot stays token-backed and removable; only the bounded attach method may exceed the text limit", async () => {
  const store = new AttachStore();
  const view = await store.stageAppshot({ bytes: IMAGE, window: { app: "Example", title: "Document" }, text: "x".repeat(16000) });
  assert.equal(view.appshot, true);
  assert.equal(view.text.length, 800);
  assert.equal(view.path, undefined);
  assert.equal(view.buffer, undefined);
  // the capture rides as one more file of deck.attach_submit (a window capture is an ordinary tray item)
  const p = { session_id: "rpc-s-main", text: "Describe this", files: [{ filename: "appshot-example.png", content_base64: IMAGE.toString("base64") }] };
  bridge.checkRequest("deck.attach_submit", p);
  assert.throws(() => bridge.checkRequest("deck.attach_submit", { ...p, files: [{ filename: "../image.png", content_base64: IMAGE.toString("base64") }] }), /Geçersiz/);
  assert.throws(() => bridge.checkRequest("prompt.submit", { text: "x".repeat(60001) }), /60\.000/);
  assert.equal(store.discard(view.token), true);
  assert.throws(() => store.get(view.token), /artık yok/);
});
