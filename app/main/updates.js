"use strict";
const fs = require("fs");
const path = require("path");

function newer(a, b) {
  const parse = v => typeof v === "string" && /^v?(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(v) ? v.replace(/^v/, "").split(".").map(Number) : null;
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// Only version numbers are persisted. Relay hello is authenticated by the existing connection.
function createUpdateNotice({ file, version, legacyProfile = false, notify }) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { /* first run */ }
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + ".tmp", JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(file + ".tmp", file);
    } catch { /* unavailable storage must not prevent startup */ }
  };
  // 0.1.0 was the sole release before version receipts; configured legacy profiles are upgrades.
  const previous = state.installed || (legacyProfile ? "0.1.0" : version);
  if (newer(version, previous)) notify("updates.installed", { version });
  state = { installed: version, notified: typeof state.notified === "string" ? state.notified : "" };
  save();
  return {
    available(candidate) {
      if (!newer(candidate, version) || candidate === state.notified || (state.notified && !newer(candidate, state.notified))) return false;
      if (!notify("updates.available", { version: candidate.replace(/^v/, "") })) return false;
      state.notified = candidate;
      save();
      return true;
    },
  };
}

module.exports = { newer, createUpdateNotice };
