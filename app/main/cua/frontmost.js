"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../../renderer/i18n");
// One native HWND, never a desktop/window list. Read-only and hidden; the shared picker blocks still apply.
const path = require("path");
const fs = require("fs");
const W = require("./windows");
const { runFile, POWERSHELL } = require("./installer");
const { PROCESS_PATH_SCRIPT } = require("./process-path");

function checkedWindow(raw, { ownPids = new Set(), ownExecutable = process.execPath } = {}) {
  const w = W.normRecord(raw);
  const executable = W.exeFromPowerShell(raw && raw.executable);
  if (!w || !w.pid || !executable) throw new Error(i18nText("frontmost.appMissing"));
  if (ownPids.has(w.pid) || W.samePath(executable, ownExecutable, "win32")) throw new Error(i18nText("frontmost.ownWindow"));
  if (W.isPasswordManager({ app: w.app, executable })) throw new Error(i18nText("frontmost.passwordManager"));
  return { ...w, executable, bounds: raw.bounds, extendedBounds: raw.extendedBounds, sourceId: `window:${w.id}:0`, matched: true, blocked: null, thumb: null };
}

async function readWindow(opts = {}) {
  const { target = null, capture = false, platform = process.platform, run = runFile, ownPids, ownExecutable } = opts;
  if (platform === "darwin") return require("./frontmost-mac").readMacWindow(opts);
  if (platform !== "win32") throw new Error(i18nText("frontmost.windowsOnlyNow"));
  // Electron reads this from app.asar too; PowerShell cannot execute an asar path directly.
  const script = PROCESS_PATH_SCRIPT + fs.readFileSync(path.join(__dirname, "frontmost.ps1"), "utf8");
  const r = await run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    timeout: 15000,
    env: { ...process.env, HD_WINDOW: target ? String(target.id) : "", HD_WINDOW_PID: target ? String(target.pid) : "", HD_WINDOW_EXE: target ? target.executable : "", HD_CAPTURE: capture ? "1" : "", HD_OWN_PIDS: [...(ownPids || [])].join(","), HD_OWN_EXE: ownExecutable || process.execPath },
  });
  if (r.code !== 0) throw new Error(i18nText("frontmost.readFailed"));
  let raw;
  try { raw = JSON.parse(r.stdout); } catch { throw new Error(i18nText("frontmost.detailsFailed")); }
  const window = checkedWindow(raw, { ownPids, ownExecutable });
  if (target && (window.id !== target.id || window.pid !== target.pid || !W.samePath(window.executable, target.executable, "win32"))) throw new Error(i18nText("frontmost.changed"));
  if (!capture) return window;
  if (typeof raw.image !== "string" || raw.image.length > 1400000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.image)) throw new Error(i18nText("frontmost.captureFailed"));
  return { window, bytes: Buffer.from(raw.image, "base64"), text: typeof raw.text === "string" ? raw.text.slice(0, 16000) : "" };
}

module.exports = { readWindow, checkedWindow };
