"use strict";
// Preserve the native driver's grounding metadata; refresh only an exact-window screenshot.
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { StringDecoder } = require("node:string_decoder");
const MAX_BYTES = 64 * 1024 * 1024;

async function refresh(packet, args, capture, mcp) {
  const result = mcp ? packet.result : packet;
  if (!result || result.isError || result.error) return packet;
  const meta = mcp ? result.structuredContent : result;
  const images = mcp ? (result.content || []).filter(c => c.type === "image") : [];
  if (!meta || (!images.length && !meta.screenshot_png_b64)) return packet;
  try {
    if (meta.pid !== args.pid || meta.window_id !== args.window_id) throw Error("Captured window identity differs from the request");
    const png = await capture(args, meta);
    if (!png) return packet;
    const data = png.toString("base64");
    if (meta.screenshot_png_b64) meta.screenshot_png_b64 = data;
    meta.screenshot_mime_type = "image/png";
    for (const image of images) Object.assign(image, { data, mimeType: "image/png" });
    return packet;
  } catch (e) {
    const error = `Window capture failed: ${String(e.message || e).slice(0, 160)}`;
    return mcp ? { jsonrpc: "2.0", id: packet.id, result: { isError: true, content: [{ type: "text", text: error }] } } : { error };
  }
}

function captureOutput(child, argv, capture) {
  const mcp = argv[0] === "mcp";
  if (!mcp && !(argv[0] === "call" && argv[1] === "get_window_state")) return child;
  let callArgs;
  if (!mcp) { try { callArgs = JSON.parse(argv[2]); } catch { return child; } }
  const p = Object.assign(new EventEmitter(), { pid: child.pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: child.stderr,
    exitCode: null, signalCode: null, kill: (...a) => child.kill(...a) });
  const requests = new Map();
  const inDecoder = new StringDecoder("utf8"), outDecoder = new StringDecoder("utf8");
  let input = "", output = "", queue = Promise.resolve(), failed = false;
  const write = data => {
    if (!p.stdout.write(data)) { child.stdout.pause(); p.stdout.once("drain", () => child.stdout.resume()); }
  };
  const fail = error => { if (!failed) { failed = true; child.kill(); p.emit("error", error); } };
  p.stdin.on("data", chunk => {
    if (!mcp || failed) return;
    input += inDecoder.write(chunk);
    if (Buffer.byteLength(input) > MAX_BYTES) return fail(Error("Driver request exceeds the size limit"));
    let nl;
    while ((nl = input.indexOf("\n")) >= 0) {
      const line = input.slice(0, nl); input = input.slice(nl + 1);
      try {
        const r = JSON.parse(line);
        if (r.method === "tools/call" && r.params?.name === "get_window_state") {
          if (requests.size >= 32) return fail(Error("Too many pending window captures"));
          requests.set(JSON.stringify(r.id), r.params.arguments || {});
        }
      } catch { /* The native driver/fence handles invalid input. */ }
    }
  });
  p.stdin.on("error", () => {});
  p.stdin.pipe(child.stdin);
  const writeLine = line => {
    queue = queue.then(async () => {
      if (failed) return;
      let packet;
      try { packet = JSON.parse(line); } catch { write(line + "\n"); return; }
      const key = JSON.stringify(packet.id), args = requests.get(key);
      if (args) { requests.delete(key); packet = await refresh(packet, args, capture, true); }
      write(JSON.stringify(packet) + "\n");
    }).catch(fail);
  };
  child.stdout.on("data", chunk => {
    output += outDecoder.write(chunk);
    if (Buffer.byteLength(output) > MAX_BYTES) return fail(Error("Driver response exceeds the size limit"));
    if (!mcp) return;
    let nl;
    while ((nl = output.indexOf("\n")) >= 0) { const line = output.slice(0, nl); output = output.slice(nl + 1); writeLine(line); }
  });
  child.on("error", error => p.emit("error", error));
  child.on("close", (code, signal) => {
    output += outDecoder.end();
    if (mcp && output.trim()) { writeLine(output); output = ""; }
    queue = queue.then(async () => {
      if (!mcp && !failed) {
        let packet;
        try { packet = JSON.parse(output); } catch { write(output); }
        if (packet) write(JSON.stringify(await refresh(packet, callArgs, capture, false)) + "\n");
      }
      p.exitCode = code; p.signalCode = signal;
      p.stdout.once("end", () => p.emit("close", code, signal));
      p.stdout.end();
    }).catch(fail);
  });
  return p;
}
module.exports = { captureOutput };
