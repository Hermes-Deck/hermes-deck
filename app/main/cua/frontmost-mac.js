"use strict";
const { t: i18nText } = require("../../renderer/i18n");
// Public focused-window metadata + PID-filtered discovery. The private driver never gets desktop.display.
const fs = require("fs");
const path = require("path");
const W = require("./windows");
const { runFile } = require("./installer");

async function readFocused(pid = null, identityOnly = false, run = runFile) {
  const script = fs.readFileSync(path.join(__dirname, "frontmost-mac.jxa"), "utf8");
  const r = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, pid ? String(pid) : "", identityOnly ? "identity" : "focused"], { timeout: 10000 });
  if (r.code !== 0) throw new Error(i18nText("frontmost.macReadFailed"));
  try { return JSON.parse(r.stdout); } catch { throw new Error(i18nText("frontmost.macDetailsFailed")); }
}

const titleOf = (x) => String(x.title || "").slice(0, 300);
const validBounds = (b) => b && [b.x, b.y, b.width, b.height].every((v) => typeof v === "number" && Number.isFinite(v)) && b.width > 0 && b.height > 0;
// ponytail: permit one point of public AX/WindowServer rounding; zero or multiple matches still fail closed.
const sameBounds = (a, b) => validBounds(a) && validBounds(b) && ["x", "y", "width", "height"].every((k) => Math.abs(a[k] - b[k]) <= 1);
const sameIdentity = (a, b) => a.pid === b.pid && a.bundleId === b.bundleId && W.samePath(a.executable, b.executable, "darwin");
const sameFocus = (a, b) => sameIdentity(a, b) && titleOf(a) === titleOf(b) && sameBounds(a.bounds, b.bounds);

function checkedMeta(raw, { ownPids = new Set(), ownExecutable = process.execPath, identityOnly = false } = {}) {
  if (!raw || !Number.isSafeInteger(raw.pid) || raw.pid <= 0 || raw.pid > 2147483647 || !W.parseBundleId(raw.bundleId) || typeof raw.executable !== "string" || !raw.executable.startsWith("/") || /[\x00-\x1f]/.test(raw.executable)) throw new Error(i18nText("frontmost.macAppMissing"));
  if (ownPids.has(raw.pid) || W.samePath(raw.executable, ownExecutable, "darwin")) throw new Error(i18nText("frontmost.ownWindow"));
  if (W.isPasswordManager(raw)) throw new Error(i18nText("frontmost.passwordManager"));
  if (!identityOnly && (typeof raw.title !== "string" || !validBounds(raw.bounds))) throw new Error(i18nText("frontmost.macFocusMissing"));
  return { ...raw, app: String(raw.app || i18nText("A0089")).slice(0, 120), ...(identityOnly ? {} : { title: titleOf(raw) }) };
}

function readonlyManifest(pid, windowId = null) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || (windowId !== null && (!Number.isSafeInteger(windowId) || windowId <= 0))) throw new Error(i18nText("frontmost.macInvalidId"));
  const tools = windowId === null ? ["list_windows"] : ["get_window_state"];
  const scope = windowId === null ? [`    applications: [${pid}]`] : ["    windows:", `      - pid: ${pid}`, `        window_id: ${windowId}`];
  return {
    key: `appshot:${pid}:${windowId || "list"}`,
    text: ["# Hermes Deck: private read-only appshot", "version: 3", "expires_after: 1m", "idle_timeout: 1m", "allow:", "  tools:", ...["start_session", "end_session", ...tools].map((t) => `    - ${t}`), "resources:", "  desktop:", ...scope, "    display: false", ""].join("\n"),
  };
}

function toolResult(raw) {
  let result;
  try { result = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { throw new Error(i18nText("frontmost.macDriverDetails")); }
  if (result && result.result) result = result.result;
  if (!result || result.isError || result.error || (result.structuredContent && result.structuredContent.refusal)) throw new Error(i18nText("frontmost.macDriverRefused"));
  return result;
}

async function readMacWindow({ driver, target = null, capture = false, validateOnly = false, readFocused: readMeta = readFocused, encodeImage = (b) => b, ownPids, ownExecutable, current = () => true } = {}) {
  if (!driver) throw new Error(i18nText("frontmost.macDriverRequired"));
  const checked = (raw) => checkedMeta(raw, { ownPids, ownExecutable, identityOnly: validateOnly });
  const active = () => { if (!current()) throw new Error(i18nText("frontmost.macReadStopped")); };
  try {
    active();
    const before = checked(await readMeta(validateOnly && target ? target.pid : null, validateOnly));
    active();
    if (target && !sameIdentity(before, target)) throw new Error(i18nText("frontmost.changed"));
    active();
    await driver.ensure(readonlyManifest(before.pid));
    active();
    const listed = toolResult(await driver.call("list_windows", { pid: before.pid, on_screen_only: true }));
    const rows = (listed.structuredContent || listed).windows;
    if (!Array.isArray(rows)) throw new Error(i18nText("frontmost.macWindowMissing"));
    const focused = validateOnly ? target : before;
    const matches = rows.filter((r) => r && r.pid === before.pid && r.is_on_screen === true && titleOf(r) === titleOf(focused) && sameBounds(r.bounds, focused.bounds) && (!target || r.window_id === target.id));
    if (matches.length !== 1) throw new Error(i18nText("frontmost.macAmbiguous"));
    const record = W.normRecord(matches[0]);
    if (!record || !record.pid) throw new Error(i18nText("frontmost.macWindowMissing"));
    const window = { ...record, executable: before.executable, bundleId: before.bundleId, bounds: matches[0].bounds, sourceId: `window:${record.id}:0`, matched: true, blocked: null, thumb: null };
    const stable = async () => {
      active();
      const after = checked(await readMeta(validateOnly ? before.pid : null, validateOnly));
      active();
      if (validateOnly ? !sameIdentity(before, after) : !sameFocus(before, after)) throw new Error(i18nText("frontmost.changed"));
    };
    await stable();
    if (!capture) return window;
    active();
    await driver.ensure(readonlyManifest(window.pid, window.id));
    await stable();
    const result = toolResult(await driver.call("get_window_state", { pid: window.pid, window_id: window.id, include_accessibility_tree: false, include_screenshot: true, max_image_dimension: 1920 }));
    const state = result.structuredContent;
    const image = Array.isArray(result.content) && result.content.find((c) => c && c.type === "image" && c.mimeType === "image/png");
    if (!state || state.pid !== window.pid || state.window_id !== window.id || state.screenshot_frame_valid !== true || !sameBounds(state.window_bounds, window.bounds) || !image || typeof image.data !== "string" || image.data.length > 8000000 || image.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error(i18nText("frontmost.macCaptureInvalid"));
    const bytes = Buffer.from(image.data, "base64");
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(i18nText("frontmost.macCaptureInvalid"));
    await stable();
    const encoded = await encodeImage(bytes);
    active();
    if (!Buffer.isBuffer(encoded) || !encoded.length || encoded.length > 1000000) throw new Error(i18nText("frontmost.macCaptureTooLarge"));
    return { window, bytes: encoded, text: before.title };
  } finally { await driver.stop(); }
}

module.exports = { readMacWindow, readFocused, readonlyManifest };
