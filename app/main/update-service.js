"use strict";
// Wires main/update-check.js into the app: real network/process access, the "updates:*" IPC channels for
// Settings > General > Updates, a check on start and every 6 h (Settings: updates.auto), and one notification per
// new selected-branch commit or release. Clicking it opens Settings at the Updates group.
const { app, shell, dialog } = require("electron");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { t: i18nText } = require("../renderer/i18n");
const { UpdateChecker, buildInfo, CANONICAL_REPO } = require("./update-check");

const EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_MS = 20 * 1000;
const GH_PATHS = process.platform === "win32"
  ? [path.join(process.env.ProgramFiles || "C:\\Program Files", "GitHub CLI", "gh.exe"), "gh"]
  : ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh", "gh"];

// A Mac app started from Finder or the Dock gets PATH=/usr/bin:/bin:/usr/sbin:/sbin: no Homebrew npm/node/gh, so a
// source build would never be offered. Add the usual install folders (git, npm and the build inherit this PATH).
if (process.platform === "darwin") {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin"].filter((d) => !(process.env.PATH || "").split(":").includes(d));
  if (extra.length) process.env.PATH = [process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin", ...extra].join(":");
}

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
function run(cmd, args, { cwd, env = process.env, detached = false } = {}) {
  return new Promise((resolve) => {
    const shellNeeded = process.platform === "win32" && /^(npm|npx)$/i.test(cmd); // .cmd shims need a shell
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, detached, windowsHide: true, shell: shellNeeded, stdio: detached ? "ignore" : ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ code: 1, out: e.message });
    }
    if (detached) {
      child.once("error", (e) => resolve({ code: 1, out: e.message }));
      child.once("spawn", () => { child.unref(); resolve({ code: 0, out: "" }); });
      return;
    }
    let out = "";
    const keep = (d) => { out = (out + d).slice(-8000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (e) => resolve({ code: 1, out: e.message }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

// NSIS targets the normal install and profile. A portable/isolated TEST must not replace them.
function windowsInstallSupported(exe, userData, localAppData, appData) {
  const same = (a, b) => path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();
  return !!localAppData && !!appData && same(exe, path.win32.join(localAppData, "Programs", "hermes-deck", "Hermes Deck.exe")) &&
    same(userData, path.win32.join(appData, "hermes-deck"));
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
    pid: process.pid,
    installSupported: process.platform !== "win32" || (app.isPackaged && windowsInstallSupported(process.execPath, app.getPath("userData"), process.env.LOCALAPPDATA, app.getPath("appData"))),
    // the running bundle (…/Hermes Deck.app/Contents/MacOS/…); a dev run (electron .) has none
    appBundle: process.platform === "darwin" && app.isPackaged ? ((/^(.+?\.app)\/Contents\/MacOS\//.exec(process.execPath) || [])[1] || "") : "",
    workDir: app.getPath("userData"),
    run,
    has,
    progress: (ev) => send("updates", { t: "progress", ...ev }),
  });
  let confirming = false;
  const view = () => ({ status: checker.status && checker.status.channel === checker.base().channel ? checker.status : { ...checker.base(), unchecked: true }, busy: confirming ? "confirm" : checker.busy });
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
    const releaseNotice = !(st.channel === "test" && st.behind > 0) && st.release && st.release.newer;
    const key = releaseNotice ? `release:${st.release.tag}` : st.behind > 0 ? `head:${st.head}` : "";
    if (!key || key === seen) return;
    seen = key;
    try {
      fs.writeFileSync(seenFile, JSON.stringify({ seen }));
    } catch {
      // read-only profile: it may tell again next start
    }
    const body = releaseNotice ? i18nText("updates.toastRelease", { tag: st.release.tag })
      : i18nText("updates.toastBehind", { count: st.behind, branch: st.branch });
    notify("update", { title: i18nText("updates.toastTitle"), body, quiet: true, onClick: openSettings });
  }

  async function check() {
    if (confirming || checker.busy) return checker.status;
    const st = await checker.check();
    announce();
    return st;
  }

  ipc.handle("updates:status", () => view());
  ipc.handle("updates:check", async () => {
    await check();
    return view();
  });
  ipc.handle("updates:channel", (_e, channel) => {
    if (checker.busy || confirming) return { ok: false, error: "updates.busy" };
    if (!["stable", "test"].includes(channel)) return { ok: false, error: "updates.badChannel" };
    settings.setUpdateChannel(channel);
    checker.status = null;
    announce(); // changing the channel only saves the choice; no network, build or install
    return view();
  });
  ipc.handle("updates:install", async (_e, target) => {
    if (checker.busy || confirming) return { ok: false, error: "updates.busy" };
    try {
      const st = checker.status;
      if (!st || !st.target || target !== st.target || st.channel !== checker.base().channel) throw new Error("updates.changed");
      confirming = true;
      announce();
      const answer = await dialog.showMessageBox({ type: "warning", title: i18nText("updates.title"),
        message: i18nText("updates.confirmTarget", { channel: i18nText(`updates.channel.${st.channel}`), target: st.action === "release" ? st.release.tag : st.head }),
        detail: i18nText(st.replaceBuild ? "updates.confirmReturn" : st.action === "build" ? "updates.confirmSource" : "updates.confirmDesktop"),
        buttons: [i18nText("updates.cancel"), i18nText("updates.install")], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response !== 1) return { ok: true, cancelled: true };
      const file = await checker.install(target);
      send("updates", { t: "progress", phase: "quit", text: path.basename(file) });
      setTimeout(quit, 800); // the installer waits for this process to end before it replaces the app
      return { ok: true };
    } catch (e) {
      announce();
      // macOS: the checksum-verified zip is downloaded; open its folder so the user can install it by hand
      if (/^updates\.manual(Downloaded|Built)$/.test(e.message) && e.file && fs.existsSync(e.file)) shell.showItemInFolder(e.file);
      return { ok: false, error: /^updates\./.test(e.message) ? e.message : "updates.failed", detail: e.detail || (/^updates\./.test(e.message) ? "" : e.message) };
    } finally {
      confirming = false;
      announce();
    }
  });
  ipc.handle("updates:open", () => {
    const st = checker.status;
    const url = st && st.release && st.release.url;
    if (url && url.startsWith(`https://github.com/${CANONICAL_REPO}/releases/tag/`)) shell.openExternal(url);
  });

  if (shot) return { checker };
  const auto = () => settings.data.updates && settings.data.updates.auto !== false;
  setTimeout(() => auto() && check().then(tell), FIRST_MS);
  setInterval(() => auto() && check().then(tell), EVERY_MS).unref();
  return { checker, check };
}

module.exports = { initUpdates, tokenSource, run, windowsInstallSupported };
