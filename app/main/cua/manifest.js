"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../../renderer/i18n");
// The capability manifest the Deck's private driver runs under (cua-driver bounded mode, manifest v3:
// https://cua.ai/docs/cua-driver/guides/permissions). Deny by default: only the granted app, only the tools
// below. A grant's daemon never gets desktop.display (full-display capture, screen-coordinate input); only the
// picker's list-only daemon does, for the window list (pickerManifest). Pure; unit-tested in
// app/test/cua-protocol.test.js.

// Tools an agent gets for the one app it was handed: what the relay's fence (relay/src/mcpfence.js, layer 2)
// lets through and Hermes calls under the hood, and nothing more. The relay pins captures and input to the
// granted pid/window, and a list_windows to the granted pid (cua-driver 0.33.3 counts a listing without a pid
// as desktop display observation and refuses it under display: false; with the pid it passes this manifest),
// then cuts the answer down to the granted window. list_apps is not here: the driver has no pid filter for
// it, so it could never pass this manifest; the relay answers it itself from that pinned list_windows. The
// driver itself is scoped to the granted app, so launch_app can only start that app (resources.apps below).
// Left out on purpose, even where layer 2 would pass them: kill_app (never), bring_to_front, set_window_frame
// and move_cursor (the user's windows and pointer), get_desktop_state and get_accessibility_tree (the whole
// desktop), clipboard_read / clipboard_write (the user's clipboard), browser and page tools, recording,
// extensions and updates.
const GRANT_TOOLS = [
  "start_session",
  "end_session",
  "set_agent_cursor_enabled",
  "get_config",
  "set_config",
  "get_cursor_position",
  "get_screen_size",
  "list_windows",
  "launch_app",
  "get_window_state",
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
];
// While the consent sheet is open and nothing is granted: the Deck itself lists windows, nothing else (it
// never calls list_apps, so the picker does not get it either).
const PICKER_TOOLS = ["start_session", "end_session", "list_windows"];
const NEVER = new Set(["kill_app", "bring_to_front", "set_window_frame", "move_cursor", "get_desktop_state", "get_accessibility_tree", "clipboard_read", "clipboard_write"]);

const TOOL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const PICKER_MS = 15 * 60 * 1000;

/** Manifest durations are whole minutes ("118m"); never below one. */
function duration(ms) {
  return `${Math.max(1, Math.floor((Number(ms) || 0) / 60000))}m`;
}

/**
 * Tool names the installed driver knows, from `cua-driver list-tools` ("name: description" lines) or a JSON
 * description with a tools list. Lets the Deck drop names an older driver lacks instead of failing to start.
 * Returns a Set, or null when the output says nothing usable (then the full list is written).
 */
function knownTools(out) {
  let m = out;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      const names = m.split(/\r?\n/).map((l) => /^([a-z][a-z0-9_]{0,63}):\s/.exec(l.trim())).filter(Boolean).map((x) => x[1]);
      return sane(new Set(names));
    }
  }
  const list = m && (m.tools || (m.mcp && m.mcp.tools) || (m.mcp_tools && m.mcp_tools.tools) || m.mcp_tools);
  if (!Array.isArray(list)) return null;
  return sane(new Set(list.map((t) => (typeof t === "string" ? t : t && t.name)).filter((n) => typeof n === "string" && TOOL_RE.test(n))));
}

/** A tool list only counts when it plainly is one (it has the basics); anything else means "unknown". */
const sane = (set) => (set.has("click") && set.has("get_window_state") && set.has("start_session") ? set : null);

const q = (s) => JSON.stringify(String(s)); // a JSON string is a valid YAML double-quoted scalar
const oneLine = (s) => String(s || "").replace(/[\r\n\p{Zl}\p{Zp}]/gu, " ").slice(0, 80); // a comment stays one line

function render({ comment, expiresMs, idleMin, tools, apps, launch = false, display = false }) {
  const lines = [...comment.map((c) => `# ${oneLine(c)}`), "version: 3", `expires_after: ${duration(expiresMs)}`, `idle_timeout: ${idleMin}m`, "", "allow:", "  tools:"];
  for (const t of tools) lines.push(`    - ${t}`);
  lines.push("", "resources:");
  if (apps.length) {
    lines.push("  apps:");
    for (const a of apps) {
      lines.push(a.bundleId ? `    - bundle_id: ${q(a.bundleId)}` : `    - executable: ${q(a.executable)}`);
      lines.push(`      launch: ${launch && tools.includes("launch_app") ? "true" : "false"}`, "      windows: all", "      terminate: deny");
    }
  }
  lines.push("  desktop:", `    display: ${display === true ? "true" : "false"}`, "");
  return lines.join("\n");
}

function pickTools(base, known) {
  return base.filter((t) => !NEVER.has(t) && (!known || !known.size || known.has(t)));
}

/**
 * The manifest for an active grant.
 * @param {object} o
 * @param {object} o.grant   from grant.makeGrant
 * @param {{executable?: string, bundleId?: string}} o.ident  the app: absolute executable (Windows, Linux) or bundle id (macOS)
 * @param {string} o.platform  process.platform
 * @param {number} [o.now]
 * @param {Set<string>|null} [o.known]  tools the installed driver knows (knownTools)
 * @returns {{key: string, text: string}} key changes only when the daemon must restart
 */
function grantManifest({ grant, ident, platform, now = Date.now(), known = null }) {
  const app = platform === "darwin" ? { bundleId: ident && ident.bundleId } : { executable: ident && ident.executable };
  if (platform === "darwin" ? !/^[A-Za-z0-9.-]{1,255}$/.test(app.bundleId || "") : !app.executable || !isAbsolute(app.executable)) {
    throw new Error(i18nText("U0201"));
  }
  const text = render({
    comment: [
      "Hermes Deck: one \"Hand to agent\" grant (rewritten on every change)",
      `Agent: ${grant.agent} · ends ${new Date(grant.expires).toISOString()}`,
    ],
    expiresMs: grant.expires - now,
    idleMin: grant.idleMin,
    tools: pickTools(GRANT_TOOLS, known),
    apps: [app],
    launch: true, // the granted app only: the relay checks launch_app's target too
  });
  return { key: `grant:${grant.startedAt}:${app.bundleId || app.executable}`, text };
}

/**
 * The manifest while the consent sheet lists windows and nothing is granted yet. The sheet needs every window
 * (capture thumbnails matched by window id to a pid and an app), and cua-driver 0.33.3 refuses a list_windows
 * without a pid under display: false ("desktop display observation is outside the capability manifest"); every
 * card would then say "Could not tell the app". So this daemon, and only this one, gets desktop.display: true.
 * It allows list_windows and its session plumbing and nothing else (no capture, no input, not even
 * get_screen_size), so display: true buys the window list and nothing more. Only the Deck calls it (index.js
 * startPicker, on a private socket); a grant's daemon keeps display: false.
 */
function pickerManifest({ known = null } = {}) {
  const text = render({
    comment: ["Hermes Deck: the consent sheet lists windows; nothing is granted", "display: true only for list_windows without a pid; no other tool"],
    expiresMs: PICKER_MS,
    idleMin: 5,
    tools: pickTools(PICKER_TOOLS, known),
    apps: [],
    display: true,
  });
  return { key: "picker", text };
}

function isAbsolute(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}

module.exports = { GRANT_TOOLS, PICKER_TOOLS, duration, knownTools, grantManifest, pickerManifest };
