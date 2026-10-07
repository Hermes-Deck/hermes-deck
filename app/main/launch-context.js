"use strict";
// Windows only: is this Deck running inside a packaged app's file virtualization?
//
// A process started by an MSIX-packaged app (the Claude desktop app, Codex, …: their terminals and agents) inherits
// that package's AppData redirection: its writes to %APPDATA%\hermes-deck land in
// %LOCALAPPDATA%\Packages\<package>\LocalCache\Roaming\hermes-deck instead, and its reads see that copy first. Such
// a Deck keeps a second settings.json (device key, relay key, single-instance lock) that the Deck started from the
// Start menu never sees, which looks like keys "disappearing". The process has no package identity of its own
// (GetCurrentPackageFullName says so), so the redirection is detected by its effect: a marker written to userData
// that turns up in a package's LocalCache copy. main.js then starts the Deck again through Explorer (outside any
// package) and quits this copy. Pure Node (no electron import).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * The package folder name whose LocalCache receives this process's userData writes, or null.
 * @param {{userData: string, localAppData: string, platform?: string, fsw?: {writeFileSync: Function, unlinkSync: Function}}} o
 *   fsw: the write side (tests stand in for Windows' redirection); reads always use the real fs.
 */
function virtualizingPackage({ userData, localAppData, platform = process.platform, fsw = fs }) {
  if (platform !== "win32" || !userData || !localAppData) return null;
  const packages = path.join(localAppData, "Packages");
  const name = `.launch-probe-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const marker = path.join(userData, name);
  try {
    fs.mkdirSync(userData, { recursive: true });
    fsw.writeFileSync(marker, "probe");
  } catch {
    return null;
  }
  let found = null;
  try {
    // the copy's folder name is userData's own path below %APPDATA% (Roaming\hermes-deck)
    const roamingTail = path.join(path.basename(path.dirname(userData)), path.basename(userData));
    for (const pkg of fs.readdirSync(packages)) {
      const copy = path.join(packages, pkg, "LocalCache", roamingTail, name);
      if (fs.existsSync(copy)) {
        found = pkg;
        break;
      }
    }
  } catch {
    found = null;
  }
  try {
    fsw.unlinkSync(marker);
  } catch {}
  return found;
}

module.exports = { virtualizingPackage };
