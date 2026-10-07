"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { Transform } = require("node:stream");
const { runFile, POWERSHELL } = require("./installer");

// Driver tool names, matching relay/src/mcpfence.js (the packaged app has no relay dependency).
const INPUT = new Set(["click", "double_click", "right_click", "middle_click", "type_text", "press_key", "hotkey", "scroll", "drag", "set_value"]);
const MAX_BYTES = 4 * 1024 * 1024;

async function raiseWindow(hwnd, { platform = process.platform, run = runFile, signal } = {}) {
  if (platform !== "win32" || !Number.isSafeInteger(hwnd) || hwnd <= 0) return { raised: false };
  try {
    const script = fs.readFileSync(path.join(__dirname, "foreground.ps1"), "utf8");
    const r = await run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      timeout: 5000, signal, env: { ...process.env, HD_WINDOW: String(hwnd) },
    });
    return { raised: r.code === 0 && JSON.parse(r.stdout).raised === true };
  } catch { return { raised: false }; }
}

/** Ordered MCP input: inspect complete lines, but forward their original bytes. */
function foregroundInput({ grant, profile, raise, active }) {
  let tail = Buffer.alloc(0);
  const abort = new AbortController();
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      const data = Buffer.concat([tail, chunk]);
      tail = Buffer.alloc(0);
      const forward = async () => {
        let start = 0, nl;
        while ((nl = data.indexOf(10, start)) >= 0) {
          if (!active()) return;
          const line = data.subarray(start, nl + 1);
          if (line.length > MAX_BYTES) throw Error("Driver request exceeds the size limit");
          start = nl + 1;
          try {
            const r = JSON.parse(line.toString("utf8"));
            const g = grant(), a = r.params?.arguments;
            if (r.method === "tools/call" && INPUT.has(r.params?.name) && a?.delivery_mode === "foreground"
                && g?.foreground === true && g.profile === profile && Date.now() < g.expires
                && Number.isSafeInteger(g.window?.id) && g.window.id > 0
                && Number.isSafeInteger(g.window?.pid) && g.window.pid > 0
                && a.pid === g.window.pid && a.window_id === g.window.id) {
              await raise(g.window.id, { signal: abort.signal });
            }
          } catch { /* Raising is best effort; the driver reports foreground_unavailable. */ }
          if (active()) this.push(line);
        }
        tail = data.subarray(start);
        if (tail.length > MAX_BYTES) throw Error("Driver request exceeds the size limit");
      };
      forward().then(() => callback(), callback);
    },
    flush(callback) {
      if (active() && tail.length) this.push(tail);
      callback();
    },
  });
  stream.once("close", () => abort.abort());
  return stream;
}

module.exports = { raiseWindow, foregroundInput };
