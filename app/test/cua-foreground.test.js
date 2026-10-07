"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { DriverChannel } = require("../main/cua/channel");
const { OP, encodeFrame } = require("../main/cua/wire");
const { checkCall, fenceGrant, INPUT } = require("../../relay/src/mcpfence");
const tick = () => new Promise(resolve => setImmediate(resolve));
const grant = () => ({ profile: "scout", foreground: true, window: { id: 77, pid: 4242 }, expires: Date.now() + 60000 });
const call = (args = {}, name = "click") => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { pid: 4242, window_id: 77, delivery_mode: "foreground", ...args } } }) + "\r\n";

async function setup(g, raise) {
  const out = [];
  const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  proc.stdin.on("data", b => out.push(b));
  const relay = Object.assign(new EventEmitter(), { ws: { readyState: 1 }, send() { return true; } });
  const channel = new DriverChannel({ hello: () => ({}), gate: async () => ({ ok: true }), runner: () => proc, grant: () => g, raise });
  channel.attach(relay); channel.start();
  relay.emit("frame", encodeFrame(OP.READY, 0, { ok: true }));
  relay.emit("frame", encodeFrame(OP.OPEN, 1, { argv: ["mcp"], profile: "scout" }));
  await tick();
  return { channel, proc, out, send: b => relay.emit("frame", encodeFrame(OP.DATA, 1, Buffer.from(b))), close: () => relay.emit("frame", encodeFrame(OP.CLOSE, 1)) };
}

test("foreground input raises the grant HWND before forwarding unchanged fragmented calls", async () => {
  let finish;
  const raised = [];
  const h = await setup(grant(), hwnd => { raised.push(hwnd); return new Promise(r => { finish = r; }); });
  const line = call({ text: "Türkçe" }, "type_text");
  const bytes = Buffer.from(line);
  const split = bytes.indexOf(Buffer.from("ü")) + 1;
  h.send(bytes.subarray(0, split)); h.send(bytes.subarray(split));
  h.send('{"method":"ping","id":2}\n');
  await tick();
  assert.deepEqual(raised, [77]);
  assert.equal(h.out.length, 0, "input waits for raise completion");
  finish({ raised: true }); await tick();
  assert.equal(Buffer.concat(h.out).toString(), line + '{"method":"ping","id":2}\n');
  h.channel.stop();
});

test("foreground hook uses the fence INPUT set and skips unconsented or mismatched calls", async () => {
  for (const [g, args, name, expected] of [
    ...[...INPUT].map(name => [grant(), {}, name, 1]),
    [grant(), { delivery_mode: "background" }, "click", 0],
    [grant(), { window_id: 78 }, "click", 0],
    [grant(), { pid: 7 }, "click", 0],
    [grant(), { window_id: undefined }, "click", 0],
    [{ ...grant(), foreground: false }, {}, "click", 0],
    [{ ...grant(), foreground: "true" }, {}, "click", 0],
    [{ ...grant(), expires: 1 }, {}, "click", 0],
    [{ ...grant(), profile: "other" }, {}, "click", 0],
    [null, {}, "click", 0],
    [grant(), {}, "bring_to_front", 0],
    [grant(), {}, "get_window_state", 0],
  ]) {
    const raised = [];
    const h = await setup(g, async hwnd => { raised.push(hwnd); });
    const line = call(args, name); h.send(line); await tick();
    assert.equal(raised.length, expected, `${name}: ${JSON.stringify(args)}`);
    assert.equal(Buffer.concat(h.out).toString(), line);
    h.channel.stop();
  }
  for (const args of [{ window_id: 78 }, { pid: 7 }]) {
    assert.equal(checkCall("click", JSON.parse(call(args)).params.arguments, { grant: fenceGrant(grant()) }).ok, false);
  }
  assert.equal(checkCall("bring_to_front", {}, { grant: fenceGrant(grant()) }).ok, false);
});

test("failed raises still forward; stop during a raise drops pending input", async () => {
  for (const raise of [async () => false, async () => ({ raised: false }), async () => { throw Error("unavailable"); }]) {
    const h = await setup(grant(), raise); h.send(call()); await tick();
    assert.equal(Buffer.concat(h.out).toString(), call()); h.channel.stop();
  }
  let finish;
  const h = await setup(grant(), () => new Promise(r => { finish = r; }));
  h.send(call()); await tick(); assert.equal(typeof finish, "function");
  h.channel.stop(); finish(false); await tick();
  assert.equal(h.out.length, 0);
});

test("relay EOF waits for the raised call before ending driver stdin", async () => {
  let finish;
  const h = await setup(grant(), () => new Promise(r => { finish = r; }));
  h.send(call()); await tick(); h.close();
  assert.equal(h.proc.stdin.writableEnded, false);
  finish(true); await tick();
  assert.equal(Buffer.concat(h.out).toString(), call());
  assert.equal(h.proc.stdin.writableEnded, true);
  h.channel.stop();
});

test("Stop cancels an in-flight native raise", async () => {
  let signal, finish;
  const h = await setup(grant(), (hwnd, options) => {
    signal = options?.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  h.send(call()); await tick();
  assert.ok(signal, "the helper must be cancellable while PowerShell starts");
  h.channel.stop(); await tick();
  assert.equal(signal.aborted, true);
  finish(false); await tick();
  assert.equal(h.out.length, 0);
});

test("native raise uses an encoded helper, grant handle and five-second timeout, with safe failures", async () => {
  const { raiseWindow } = require("../main/cua/foreground");
  const { POWERSHELL } = require("../main/cua/installer");
  const fs = require("node:fs");
  const abort = new AbortController();
  let calls = 0;
  const run = async (cmd, args, options) => {
    calls++;
    assert.equal(cmd, POWERSHELL);
    assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    assert.equal(Buffer.from(args[3], "base64").toString("utf16le"), fs.readFileSync(require.resolve("../main/cua/foreground.ps1"), "utf8"));
    assert.equal(options.timeout, 5000);
    assert.equal(options.signal, abort.signal);
    assert.equal(options.env.HD_WINDOW, "77");
    return { code: 0, stdout: '{"raised":true}' };
  };
  assert.deepEqual(await raiseWindow(77, { platform: "win32", run, signal: abort.signal }), { raised: true });
  for (const hwnd of [0, -1, "77", "77; bad", NaN]) assert.deepEqual(await raiseWindow(hwnd, { platform: "win32", run }), { raised: false });
  assert.deepEqual(await raiseWindow(77, { platform: "darwin", run }), { raised: false });
  assert.equal(calls, 1);
  for (const result of [{ code: -1, stdout: "" }, { code: 0, stdout: "broken" }, { code: 0, stdout: '{"raised":false}' }]) {
    assert.deepEqual(await raiseWindow(77, { platform: "win32", run: async () => result }), { raised: false });
  }
  assert.deepEqual(await raiseWindow(77, { platform: "win32", run: async () => { throw Error("timeout"); } }), { raised: false });
});

test("PowerShell raise sequence restores only minimized targets and checks the exact foreground HWND", { skip: process.platform !== "win32" }, async () => {
  const fs = require("node:fs");
  const { runFile, POWERSHELL } = require("../main/cua/installer");
  const script = fs.readFileSync(require.resolve("../main/cua/foreground.ps1"), "utf8");
  // Replace the entire native type before executing any script: no user32 calls or real windows.
  const body = script.replace(/Add-Type -TypeDefinition @'[\s\S]*?'@\r?\n/, "");
  assert.equal(body.includes("DllImport"), false);
  const stub = `Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
public static class DeckForeground {
  public static IntPtr Foreground;
  public static bool Iconic, Valid, Allow;
  public static List<string> Calls = new List<string>();
  public static IntPtr SetThreadDpiAwarenessContext(IntPtr c) { Calls.Add("dpi:" + c); return IntPtr.Zero; }
  public static IntPtr GetForegroundWindow() { return Foreground; }
  public static bool IsWindow(IntPtr h) { return Valid; }
  public static bool IsIconic(IntPtr h) { return Iconic; }
  public static bool ShowWindow(IntPtr h, int c) { Calls.Add("show:" + h + ":" + c); return true; }
  public static bool SetForegroundWindow(IntPtr h) { Calls.Add("raise:" + h); if (Allow) Foreground = h; return Allow; }
  public static void keybd_event(byte key, byte scan, uint flags, UIntPtr extra) { Calls.Add("key:" + key + ":" + flags); }
}
'@
`;
  const cases = [
    { foreground: 77, iconic: false, valid: true, allow: true, raised: true, calls: ["dpi:-4"] },
    { foreground: 9, iconic: true, valid: true, allow: true, raised: true, calls: ["dpi:-4", "show:77:9", "key:18:0", "key:18:2", "raise:77"] },
    { foreground: 9, iconic: false, valid: true, allow: true, raised: true, calls: ["dpi:-4", "key:18:0", "key:18:2", "raise:77"] },
    { foreground: 9, iconic: false, valid: true, allow: false, raised: false, calls: ["dpi:-4", "key:18:0", "key:18:2", "raise:77"] },
    { foreground: 9, iconic: false, valid: false, allow: true, raised: false, calls: ["dpi:-4"] },
  ];
  const commands = cases.map(c => `
[DeckForeground]::Foreground = [IntPtr]::new(${c.foreground})
[DeckForeground]::Iconic = $${c.iconic}
[DeckForeground]::Valid = $${c.valid}
[DeckForeground]::Allow = $${c.allow}
[DeckForeground]::Calls.Clear()
$result = & { ${body} } | ConvertFrom-Json
@{ raised=$result.raised; calls=@([DeckForeground]::Calls) } | ConvertTo-Json -Compress
`).join("\n");
  const r = await runFile(POWERSHELL, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(stub + commands, "utf16le").toString("base64")], { timeout: 10000, env: { ...process.env, HD_WINDOW: "77" } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split(/\r?\n/).map(JSON.parse), cases.map(({ raised, calls }) => ({ raised, calls })));
});
