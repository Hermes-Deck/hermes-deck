"use strict";
// Versions the relay reports about itself and its host (/health, the WebSocket hello, mobile capabilities).
// App, relay and plugin share one version (root compat.json); PROTOCOL is bumped only on a breaking wire change,
// and minor/patch versions interoperate within one protocol. relay/test/compat.test.js keeps these equal.
const fs = require("fs");
const path = require("path");

const VERSION = require("../package.json").version;
const PROTOCOL = 1;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SEMVER_RE = /^v?(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;
const INSTALLED = path.join("hermes-deck", "installed.json"); // written by hermes-plugin/hermes-deck/install.py

/** The plugin version one Hermes home reports in <home>/hermes-deck/installed.json, or null. */
function installedVersion(home) {
  try {
    const file = path.join(home, INSTALLED);
    if (fs.statSync(file).size > 64 * 1024) return null;
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v.version === "string" && SEMVER_RE.test(v.version) ? v.version.replace(/^v/, "") : null;
  } catch {
    return null;
  }
}

/**
 * {profile: version|null} for every Hermes profile under the root (HERMES_ROOT): "default" is the root itself,
 * the others are profiles/<name> with a config.yaml or a state.db (the same homes history.js and usage.js read).
 * null = a profile without installed.json (no plugin, or a plugin older than 0.3.6).
 */
function pluginVersions(root) {
  const out = {};
  if (!root) return out;
  const isHome = (dir) => ["config.yaml", "state.db", INSTALLED].some((f) => fs.existsSync(path.join(dir, f)));
  if (isHome(root)) out.default = installedVersion(root);
  let names = [];
  try {
    names = fs.readdirSync(path.join(root, "profiles")).sort();
  } catch {
    /* no named profiles */
  }
  for (const n of names) {
    if (Object.keys(out).length >= 64) break;
    const dir = path.join(root, "profiles", n);
    if (PROFILE_RE.test(n) && isHome(dir)) out[n] = installedVersion(dir);
  }
  return out;
}

/** pluginVersions() cached for `ttlMs` (the /health endpoint is unauthenticated and may be polled). */
function pluginCache(root, ttlMs = 30_000, now = Date.now) {
  let at = -Infinity;
  let value = {};
  return () => {
    if (now() - at >= ttlMs) {
      value = pluginVersions(root);
      at = now();
    }
    return value;
  };
}

/** The updater's last --check result (relay/tools/update.js writes it to <dataDir>/update-check.json), or null. */
function updateStatus(dataDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dataDir, "update-check.json"), "utf8"));
    if (!v || typeof v !== "object") return null;
    const latest = typeof v.latest === "string" && SEMVER_RE.test(v.latest) ? v.latest.replace(/^v/, "") : null;
    return { available: v.updateAvailable === true && !!latest, latest, checkedAt: typeof v.checkedAt === "string" ? v.checkedAt : null };
  } catch {
    return null;
  }
}

module.exports = { VERSION, PROTOCOL, pluginVersions, pluginCache, installedVersion, updateStatus, SEMVER_RE };
