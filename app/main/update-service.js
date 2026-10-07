"use strict";
// Wires main/update-check.js into the app: real network/process access, the "updates:*" IPC channels for
// Settings > General > Updates, a check on start and every 6 h (Settings: updates.auto), and one notification per
// new main commit or release. Clicking it opens Settings at the Updates group.
const { app, shell } = require("electron");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { t: i18nText } = require("../renderer/i18n");
const { UpdateChecker, buildInfo } = require("./update-check");

const EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_MS = 20 * 1000;
const GH_PATHS = process.platform === "win32"
  ? [path.join(process.env.ProgramFiles || "C:\\Program Files", "GitHub CLI", "gh.exe"), "gh"]
  : ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh", "gh"];

const execOut = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 8000, windowsHide: true, ...opts }, (err, stdout) => resolve(err ? "" : String(stdout).trim()));
});

/** A GitHub token: the environment, the saved one, or the GitHub CLI's login (cached for 10 minutes). */
function tokenSource(settings) {
  let cached = { at: 0, token: "" };
  return async () => {
    const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
    if (env) return env;
    const saved = settings.data.updates && settings.data.updates.token;
    if (saved) return saved;
    if (Date.now() - cached.at < 10 * 60 * 1000) return cached.token;
    let token = "";
    for (const gh of GH_PATHS) {
      if (gh !== "gh" && !fs.existsSync(gh)) continue;
      token = await execOut(gh, ["auth", "token"]);
      if (token) break;
    }
    cached = { at: Date.now(), token };
    return token;
  };
}

/** Runs a command, collecting the tail of its output; `detached` starts it and returns at once (installers). */
function run(cmd, args, { cwd, detached = false } = {}) {
  return new Promise((resolve) => {
    const shellNeeded = process.platform === "win32" && /^(npm|npx)$/i.test(cmd); // .cmd shims need a shell
    let child;
    try {
      child = spawn(cmd, args, { cwd, detached, windowsHide: true, shell: shellNeeded, stdio: detached ? "ignore" : ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ code: 1, out: e.message });
    }
    if (detached) {
      child.unref();
      return resolve({ code: 0, out: "" });
    }
    let out = "";
    const keep = (d) => { out = (out + d).slice(-8000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (e) => resolve({ code: 1, out: e.message }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const has = async (cmd) => !!(await execOut(process.platform === "win32" ? "where" : "which", [cmd]));

/**
 * @param {object} o
 * @param {object} o.ipc        appIpc(ipcMain): sender-checked handlers
 * @param {object} o.settings   Settings
 * @param {(ch: string, msg: object) => void} o.send  to the deck window
 * @param {(kind: string, payload: object) => void} o.notify  desktop.notify
 * @param {() => void} o.quit   leaves the app so an installer can replace it
 * @param {() => void} o.openSettings  a toast click: the deck at Settings > General
 * @param {boolean} [o.shot]    screenshot runs: no timers, no network
 */
function initUpdates({ ipc, settings, send, notify, quit, openSettings = () => {}, shot = false }) {
  const git = (args) => {
    try {
      return require("child_process").execFileSync("git", args, { cwd: path.join(__dirname, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    } catch {
      return "";
    }
  };
  const checker = new UpdateChecker({
    version: app.getVersion(),
    info: buildInfo({ dir: __dirname, git }),
    settings: () => settings.data.updates || {},
    token: tokenSource(settings),
    fetch: (url, opts) => fetch(url, opts),
    platform: process.platform,
    arch: process.arch,
    workDir: app.getPath("userData"),
    run,
    has,
    progress: (ev) => send("updates", { t: "progress", ...ev }),
  });
  const view = () => ({ status: checker.status || { ...checker.base(), unchecked: true }, busy: checker.busy });
  const announce = () => send("updates", { t: "status", ...view() });

  // one notification per new state: the branch head or the release tag we last told the user about
  const seenFile = path.join(app.getPath("userData"), "update-check.json");
  let seen = "";
  try {
    seen = JSON.parse(fs.readFileSync(seenFile, "utf8")).seen || "";
  } catch {
    // first run
  }
  function tell(st) {
    if (!st || st.error) return;
    const key = st.release && st.release.newer ? `release:${st.release.tag}` : st.behind > 0 ? `head:${st.head}` : "";
    if (!key || key === seen) return;
    seen = key;
    try {
      fs.writeFileSync(seenFile, JSON.stringify({ seen }));
    } catch {
      // read-only profile: it may tell again next start
    }
    const body = st.release && st.release.newer ? i18nText("updates.toastRelease", { tag: st.release.tag })
      : i18nText("updates.toastBehind", { count: st.behind, branch: st.branch });
    notify("update", { title: i18nText("updates.toastTitle"), body, quiet: true, onClick: openSettings });
  }

  async function check() {
    const st = await checker.check();
    announce();
    return st;
  }

  ipc.handle("updates:status", () => view());
  ipc.handle("updates:check", async () => {
    await check();
    return view();
  });
  ipc.handle("updates:install", async () => {
    try {
      const file = await checker.install();
      send("updates", { t: "progress", phase: "quit", text: path.basename(file) });
      setTimeout(quit, 800); // the installer waits for this process to end before it replaces the app
      return { ok: true };
    } catch (e) {
      announce();
      // macOS: the checksum-verified zip is downloaded; open its folder so the user can install it by hand
      if (e.message === "updates.manualDownloaded" && e.file && fs.existsSync(e.file)) shell.showItemInFolder(e.file);
      return { ok: false, error: /^updates\./.test(e.message) ? e.message : "updates.failed", detail: e.detail || (/^updates\./.test(e.message) ? "" : e.message) };
    }
  });
  ipc.handle("updates:open", () => {
    const st = checker.status;
    const url = st && st.release && st.release.url;
    if (url && /^https:\/\/github\.com\//.test(url)) shell.openExternal(url);
  });

  if (shot) return { checker };
  const auto = () => settings.data.updates && settings.data.updates.auto !== false;
  setTimeout(() => auto() && check().then(tell), FIRST_MS);
  setInterval(() => auto() && check().then(tell), EVERY_MS).unref();
  return { checker, check };
}

module.exports = { initUpdates, tokenSource, run };
