"use strict";
// G2: start Hermes Deck when the user logs in. The OS holds the real state (the user can also switch it
// off in Task Manager or System Settings), so desktop.js reads it back on every start instead of
// trusting settings.json.
//   Windows: a value under HKCU\Software\Microsoft\Windows\CurrentVersion\Run that starts this exe with
//            --autostart. A dev run registers electron.exe with the app folder as its first argument.
//   macOS:   a login item for the .app bundle. Packaged builds only: a dev run would register the bare
//            Electron.app from node_modules, which opens Electron's default window instead of the deck.
//   Linux:   not offered (Electron has no login item API there).
const { app } = require("electron");

const FLAG = "--autostart";
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
// Run value name. The NSIS uninstaller (build/installer.nsh) deletes the packaged one, so keep them equal.
const RUN_NAME = app.isPackaged ? "Hermes Deck" : "Hermes Deck (dev)";

/** "ok" when the switch works here; "mac-dev" (unpackaged macOS run) or "unsupported" otherwise. */
function support() {
  if (IS_WIN) return "ok";
  if (IS_MAC) return app.isPackaged ? "ok" : "mac-dev";
  return "unsupported";
}

/**
 * Windows: the command the Run value holds, given the same way to set and get. Electron 44 quotes the exe
 * and every argument itself (so the app folder goes in bare, despite the typings' advice), but its lookup
 * splits an unquoted exe path at the first space ("Hermes Deck.exe"); a quoted path is matched in every
 * version (Electron strips the quotes before writing).
 */
function winOptions() {
  return {
    path: `"${process.execPath}"`,
    args: app.isPackaged ? [FLAG] : [app.getAppPath(), FLAG],
  };
}

/** true when the OS will start the deck at the next login. */
function state() {
  if (support() !== "ok") return false;
  try {
    if (IS_WIN) {
      const items = app.getLoginItemSettings(winOptions()).launchItems || [];
      // enabled = false when the user switched it off in Task Manager / Settings > Apps > Startup
      return items.some((i) => i.name === RUN_NAME && i.scope === "user" && i.enabled);
    }
    return !!app.getLoginItemSettings().openAtLogin;
  } catch (e) {
    console.error(`autostart: ${e.message}`);
    return false;
  }
}

/** Turns login start on or off; returns the state the OS reports afterwards. */
function apply(on) {
  if (support() !== "ok") return false;
  try {
    // enabled: true also clears a Task Manager "disabled" mark, so switching on in the deck really turns it on
    if (IS_WIN) app.setLoginItemSettings({ openAtLogin: !!on, enabled: true, name: RUN_NAME, ...winOptions() });
    else app.setLoginItemSettings({ openAtLogin: !!on });
  } catch (e) {
    console.error(`autostart: ${e.message}`);
  }
  return state();
}

/** true when this process was started by the login item, not by the user. */
function launchedAtLogin() {
  if (IS_WIN) return process.argv.includes(FLAG);
  if (IS_MAC && app.isPackaged) {
    try {
      return !!app.getLoginItemSettings().wasOpenedAtLogin;
    } catch {
      return false;
    }
  }
  return false;
}

module.exports = { support, state, apply, launchedAtLogin };
