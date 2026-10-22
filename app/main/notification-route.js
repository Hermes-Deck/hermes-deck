"use strict";
const { execFile } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

// One bounded, read-only public AX query per notification burst. Never request permissions.
function otherAppFullscreen(run = execFile) {
  return new Promise(resolve => {
    try { run("/usr/bin/osascript", ["-l", "JavaScript", "-e", fs.readFileSync(path.join(__dirname, "fullscreen-mac.jxa"), "utf8"), String(process.pid)],
      { timeout: 1500, maxBuffer: 1024 }, (error, stdout) => {
        const result = !error && String(stdout).trim();
        resolve(result === "true" ? true : result === "false" ? false : null);
      }); } catch { resolve(null); }
  });
}

function fullscreenProbe(systemPreferences) {
  let generation = 0;
  let pending = null;
  const subscriptions = ["NSWorkspaceActiveSpaceDidChangeNotification", "NSWorkspaceDidActivateApplicationNotification"]
    .map(name => systemPreferences.subscribeWorkspaceNotification(name, () => { generation++; pending = null; }));
  return {
    get() {
      if (!pending) {
        const at = generation;
        const reading = otherAppFullscreen().then(value => at === generation ? value : null);
        pending = reading;
        reading.finally(() => { if (pending === reading) pending = null; });
      }
      return pending;
    },
    stop() {
      generation++;
      for (const id of subscriptions) systemPreferences.unsubscribeWorkspaceNotification(id);
    },
  };
}

async function notificationRoute(flags, { platform = process.platform, fullscreen = otherAppFullscreen } = {}) {
  const read = typeof flags === "function" ? flags : () => flags;
  const before = read();
  let state = false;
  if (before.notifications && before.pet && !["pet", "banner"].includes(before.notificationMode) && platform === "darwin") {
    try { state = await fullscreen(); } catch { state = null; }
  }
  // Settings may change while AX answers. Choose from the current preferences, not the captured object.
  flags = read();
  if (!flags.notifications) return null;
  if (flags.notificationMode === "banner") return "banner";
  if (flags.notificationMode === "pet") return flags.pet ? "pet" : null;
  if (!flags.pet) return "banner"; // never turn on a pet the user hid
  // Unknown (missing Accessibility access, timeout, unsupported AX window) uses the OS,
  // not an overlay that might cover a fullscreen app or bypass Focus.
  if (platform === "darwin" && state !== false) return "banner";
  return "pet";
}

module.exports = { notificationRoute, otherAppFullscreen, fullscreenProbe };
