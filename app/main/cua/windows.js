"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../../renderer/i18n");
// The consent sheet's window list: Electron's desktopCapturer windows (thumbnails) matched with the driver's
// own `list_windows` records (window id, pid, app name), plus the helpers that turn a pid into the app
// identity the capability manifest needs. Pure; unit-tested in app/test/cua-protocol.test.js.

/** "window:<handle>:0" (Electron) -> handle. On macOS that is the CGWindowID, on Windows the HWND. */
function sourceHandle(id) {
  const m = /^window:(\d+):\d+$/.exec(String(id || ""));
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** "Book1 - Excel" -> "Excel": Windows titles usually end with the app's name. */
function guessApp(title) {
  const t = String(title || "").trim();
  const parts = t.split(/\s+[-–—]\s+/);
  const last = parts.length > 1 ? parts[parts.length - 1].trim() : t;
  return (last.length <= 40 ? last : t).slice(0, 40) || i18nText("A0089");
}

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

/** One `list_windows` record in a fixed shape, or null. */
function normRecord(r) {
  if (!r || typeof r !== "object") return null;
  const id = Number(r.window_id ?? r.windowId ?? r.id);
  const pid = Number(r.pid ?? r.owner_pid ?? r.ownerPid);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    app: String(r.app_name ?? r.appName ?? r.app ?? r.owner_name ?? "").slice(0, 120),
    title: String(r.title ?? r.name ?? "").slice(0, 300),
    onScreen: r.is_on_screen !== false && r.isOnScreen !== false,
  };
}

/**
 * Parses what `cua-driver call list_windows` prints. Accepts a bare array, {windows}, {result: ...}, an MCP
 * tool result ({structuredContent} or a text block holding JSON), or JSON after a line of text.
 */
function parseListWindows(out) {
  let v = out;
  if (typeof v === "string" || Buffer.isBuffer(v)) {
    const s = String(v);
    const at = s.search(/[[{]/);
    if (at < 0) return [];
    try {
      v = JSON.parse(s.slice(at));
    } catch {
      return [];
    }
  }
  for (let depth = 0; depth < 4 && v && !Array.isArray(v); depth++) {
    if (Array.isArray(v.windows)) v = v.windows;
    else if (v.structuredContent) v = v.structuredContent;
    else if (v.result !== undefined) v = v.result;
    else if (Array.isArray(v.content)) {
      const text = v.content.find((c) => c && c.type === "text" && typeof c.text === "string");
      return text ? parseListWindows(text.text) : [];
    } else break;
  }
  return Array.isArray(v) ? v.map(normRecord).filter(Boolean) : [];
}

// Password managers are never handed to an agent, even when the user picks one by mistake.
const PASSWORD_APPS = /(^|[\\/\s.])(1password|bitwarden|keepass(xc)?|lastpass|dashlane|keeper( password manager)?|enpass|nordpass|proton ?pass|roboform|keychain access|anahtar zinciri erişimi)(\.exe|\.app)?$/i;
const PASSWORD_BUNDLES = /^(com\.1password\.|com\.agilebits\.|com\.bitwarden\.|org\.keepassxc\.|com\.lastpass\.|com\.dashlane\.|com\.callpod\.|in\.sinew\.|com\.nordpass\.|me\.proton\.pass|com\.apple\.passwords|com\.apple\.keychainaccess)/i;
function isPasswordManager({ app, executable, bundleId } = {}) {
  if (bundleId && PASSWORD_BUNDLES.test(bundleId)) return true;
  if (executable && PASSWORD_APPS.test(String(executable).replace(/\.exe$/i, ""))) return true;
  const a = String(app || "").trim();
  return !!a && (PASSWORD_APPS.test(a) || /^(passwords|parolalar)$/i.test(a));
}

/**
 * Merges capture sources with driver records for the picker.
 * @param {{id: string, name: string, thumb?: string}[]} sources  desktopCapturer windows (thumb: data URL)
 * @param {ReturnType<normRecord>[]} records  parsed `list_windows`
 * @param {{ownIds?: Set<string>, ownPids?: Set<number>}} [o]  the Deck's own windows and processes (never listed)
 */
function mergeWindows(sources, records, { ownIds = new Set(), ownPids = new Set(), platform = process.platform } = {}) {
  const left = (records || []).filter((r) => !(r.pid && ownPids.has(r.pid)));
  const used = new Set();
  const take = (pred) => {
    const r = left.find((x) => !used.has(x) && pred(x));
    if (r) used.add(r);
    return r || null;
  };
  const out = [];
  for (const s of sources || []) {
    if (!s || ownIds.has(s.id)) continue;
    const handle = sourceHandle(s.id);
    if (!handle) continue;
    const ownByRecord = (records || []).find((r) => r.id === handle && r.pid && ownPids.has(r.pid));
    if (ownByRecord) continue;
    const r = take((x) => x.id === handle) || (platform !== "win32" && (take((x) => x.title && x.title === s.name) || take((x) => x.title && norm(x.title) === norm(s.name))));
    out.push(entry({ sourceId: s.id, id: r ? r.id : handle, pid: r ? r.pid : null, title: s.name, app: r && r.app ? r.app : guessApp(s.name), thumb: s.thumb || null, matched: !!r }, left.length > 0));
  }
  // No capture sources at all (macOS without the Deck's Screen Recording grant): offer the driver's
  // on-screen windows without thumbnails.
  if (!(sources || []).length) {
    for (const r of left) {
      if (!r.onScreen || !r.title) continue;
      out.push(entry({ sourceId: `cua:${r.id}`, id: r.id, pid: r.pid, title: r.title, app: r.app || guessApp(r.title), thumb: null, matched: true }));
    }
  }
  return out;
}

/**
 * One card. `listed`: the driver did list windows, so a card without a pid is one window it did not report (the
 * hint is then not "install the driver", which would be wrong); with no records at all the driver is the cause.
 */
function entry(w, listed = true) {
  const why = listed ? i18nText("U0214") : i18nText("U0215");
  const blocked = isPasswordManager({ app: w.app }) ? i18nText("U0137") : !w.pid ? why : null;
  return { ...w, blocked };
}

// --- pid -> app identity (the manifest names apps, not windows) ----------------------------------------
/** A native process-image query's PowerShell output -> absolute .exe path, or null. */
function exeFromPowerShell(out) {
  const line = String(out || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
  return /^[A-Za-z]:\\.+\.exe$/i.test(line) || /^\\\\.+\.exe$/i.test(line) ? line : null;
}

/** `ps -o comm= -p N` output on macOS -> the outermost .app bundle path, or null. */
function bundlePathFromComm(out) {
  const p = String(out || "").trim();
  const i = p.indexOf(".app/");
  if (!p.startsWith("/") || i < 0) return null;
  return p.slice(0, i + 4);
}

/** `plutil -extract CFBundleIdentifier raw -o - Info.plist` output -> bundle id, or null. */
function parseBundleId(out) {
  const s = String(out || "").trim();
  return /^[A-Za-z0-9.-]{1,255}$/.test(s) ? s : null;
}

/** Two executable paths name the same file (Windows paths compare case-insensitively). */
function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  const n = (p) => String(p).replace(/[\\/]+/g, "/").replace(/\/$/, "");
  return platform === "win32" || platform === "darwin" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

module.exports = {
  sourceHandle,
  guessApp,
  parseListWindows,
  normRecord,
  isPasswordManager,
  mergeWindows,
  exeFromPowerShell,
  bundlePathFromComm,
  parseBundleId,
  samePath,
};
