"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../../renderer/i18n");
// Bot screen, device side (E2–E6; contract: docs/bot-screen-protocol.md). A Hermes agent may use
// computer_use on this computer, in the one window the user handed over ("Agent'a ver"), through a
// cua-driver this Deck supervises in the user's session. The user keeps their own mouse: the driver acts in
// the background and draws its own agent cursor. While an agent may act the user always sees it (the bar,
// a red tray icon, notifications) and can stop it at once: Stop on the bar, the tray, the Bot screen tab,
// or Ctrl+Alt+Shift+S (⌃⌥⌘S on macOS). Durdur is local first and works with the relay or Hermes offline.
//
// Off unless the user switched on "Desktop control" here (Settings → This device: presence's "desktop"
// hosting switch; nothing from the relay can turn it on), and only for the agents allowed there.
// main.js: init() once the window exists, attachRelay() when the relay connection changes, shotBar() for
// --shot-botbar. Renderer: renderer/botscreen.js through deck.botscreen (preload.js).
const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, nativeImage, powerMonitor } = require("electron");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const os = require("os");
const path = require("path");
const { Installer, runFile } = require("./installer");
const { PINS } = require("./pins");
const { Driver, killProcess } = require("./driver");
const { DriverChannel } = require("./channel");
const { raiseWindow } = require("./foreground");
const { OP } = require("./wire");
const { checkArgv, GRANT_VERBS, INFO_VERBS, scrubInfo } = require("./protocol");
const G = require("./grant");
const M = require("./manifest");
const W = require("./windows");
const { executablePath } = require("./process-path");
const { readWindow } = require("./frontmost");
const { captureWindow, cancelCaptures } = require("./window-capture");
const { ActivityBar } = require("./bar");

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const SUPPORTED = IS_WIN || IS_MAC;
const HOTKEY = IS_MAC ? "Control+Alt+Command+S" : "Control+Alt+Shift+S";
const HOTKEY_LABEL = IS_MAC ? "⌃⌥⌘S" : "Ctrl+Alt+Shift+S";
const FRONTMOST_HOTKEY = "Control+Alt+P";
const FRAME_RE = /^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._:-]{1,128}\/\d{1,16}\.(?:jpe?g|png)$/; // events.py writes millisecond timestamps
const PICKER_IDLE_MS = 5 * 60 * 1000; // the consent sheet's window lister stops after this
const STOP_TEXT = {
  get button() { return i18nText("U0142"); },
  get hotkey() { return i18nText("U0143", { HOTKEY_LABEL: HOTKEY_LABEL }); },
  get toggle() { return i18nText("U0144"); },
  get lock() { return i18nText("U0145"); },
  get expiry() { return i18nText("U0146"); },
  get idle() { return i18nText("U0147"); },
  get remote() { return i18nText("U0148"); },
};
const arg = (name) => {
  const a = process.argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  return a === undefined ? undefined : a.includes("=") ? a.split("=").slice(1).join("=") : true;
};

const S = {
  win: null,
  settings: null,
  presence: null, // main/presence.js DevicePresence: device id, the "desktop" switch, heartbeats
  send: null, // main.js send(channel, msg) to the renderer
  desktop: null, // main/desktop.js: notify(), trayAlert()
  version: "",
  shot: false,
  inert: false, // another screenshot run: this feature stays out of the way
  fixture: null, // fixture scene (cua/fixture.js)
  fixtureUi: null,
  fixtureFed: false,
  installer: null,
  pinInfo: null,
  driver: null, // the grant's bounded daemon + channel processes
  pickerDriver: null, // a second, list-only daemon while the consent sheet is open
  appshotDriver: null, // private, read-only Mac discovery/capture; never handed to the relay
  quitting: false,
  pickerTimer: null,
  link: null,
  linkState: { status: "off" },
  bar: null,
  driverInfo: { status: "unknown" },
  known: null, // tool names the installed driver knows
  install: null, // {phase, got, total, error}
  grant: null, // grant.makeGrant + {ident}
  lastActivity: 0,
  grantTimer: null,
  expiryTimer: null,
  picker: { list: [], at: 0 },
  hotkey: { registered: null },
  frontmostHotkey: false,
  frontmostBusy: false,
  paused: null, // {by, at}: Durdur turned the switch off
  lastStop: null,
  lease: {}, // profile -> "human" | null
  stopping: false,
  pushTimer: null,
};

const enabled = () => SUPPORTED && !!(S.presence && S.presence.hosting.desktop);
const allowed = () => {
  const a = S.settings && S.settings.data.botscreen && S.settings.data.botscreen.agents;
  return Array.isArray(a) ? a : [];
};
const token = () => (S.settings && S.settings.data.botscreen && S.settings.data.botscreen.deviceToken) || "";
const installed = () => S.driverInfo.status === "installed";
const locate = () => (installed() ? { bin: S.driverInfo.bin, app: S.driverInfo.app } : null);
const channelCount = () => (S.channel ? S.channel.channels.size : 0);
// Windows: the driver lives in the local (not roaming) profile; macOS keeps only records (the app is in Applications)
const driverDir = () => (IS_WIN ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "hermes-deck", "cua-driver") : path.join(app.getPath("userData"), "cua-driver"));
const workDir = () => path.join(app.getPath("userData"), "cua"); // manifests and the drivers' working folder

function relayCfg() {
  const d = S.settings && S.settings.data.relay;
  if (!d || !d.url || !d.token) return null;
  return { url: d.url, token: d.token, http: d.url.replace(/^ws/i, "http").replace(/\/+$/, "") };
}

// ---------------------------------------------------------------- state for the renderer
function publicState() {
  const g = S.grant;
  const d = S.driverInfo;
  return {
    supported: SUPPORTED,
    platform: process.platform,
    fixture: !!S.fixture,
    on: enabled(),
    paused: enabled() ? null : S.paused,
    device: S.presence ? { id: S.presence.id, name: S.presence.name } : null,
    agents: allowed(),
    hasToken: !!token(),
    relay: !!relayCfg() || !!S.fixture,
    driver: { status: d.status, version: d.version || null, error: d.error || null, source: d.source || null },
    pin: S.pinInfo,
    install: S.install,
    daemon: S.driver ? { status: S.driver.state, error: S.driver.error } : { status: S.fixture && g ? "running" : "stopped", error: null },
    link: S.linkState,
    channels: channelCount(),
    grant: g ? { agent: g.agent, profile: g.profile, app: g.app, title: g.window.title, startedAt: g.startedAt, expires: g.expires, idleMin: g.idleMin, foreground: g.foreground, lastActivity: S.lastActivity } : null,
    lease: { ...S.lease },
    hotkey: { label: HOTKEY_LABEL, registered: S.hotkey.registered },
    frontmost: { supported: SUPPORTED, hotkey: IS_MAC ? "⌃⌥P" : "Ctrl+Alt+P", registered: S.frontmostHotkey },
    lastStop: S.lastStop,
    ui: S.fixtureUi,
  };
}

function push() {
  if (S.pushTimer) return;
  S.pushTimer = setTimeout(() => {
    S.pushTimer = null;
    if (S.send) S.send("botscreen", { t: "state", state: publicState() });
  }, 60);
}

function setLink(s) {
  S.linkState = s;
  push();
}

// ---------------------------------------------------------------- the relay's driver channel
/** HELLO payload (channel 0): this device's presence id and key, the driver's state, the switch. */
function hello() {
  const d = S.driverInfo;
  return {
    v: 1,
    device: S.presence.id,
    os: process.platform,
    deck: S.version,
    driver: d.status === "installed" ? { ok: true, version: d.version || null } : { ok: false, error: d.error || (d.status === "missing" ? "not installed" : String(d.status)) },
    desktop: enabled(),
    pid: process.pid,
    token: token(),
  };
}

/** Every channel "open" passes here before a process starts. Errors are for the agent (English). */
async function gate(m) {
  const v = checkArgv(m.argv);
  if (!v.ok) return v;
  if (!enabled()) return { ok: false, code: 1, error: "desktop control is switched off on this device" };
  if (!installed()) return { ok: false, code: 127, error: "cua-driver is not installed on this device" };
  const profile = String(m.profile || "");
  if (!profile || !allowed().includes(profile)) return { ok: false, code: 1, error: `agent profile "${profile}" is not allowed on this device` };
  if (GRANT_VERBS.has(v.verb)) {
    if (!S.grant) return { ok: false, code: 1, error: "no window was handed over on this device: ask the user to use \"Hand to agent\" in Hermes Deck" };
    if (profile !== S.grant.profile) return { ok: false, code: 1, error: `this device's window was handed to ${S.grant.agent}, not to this agent` };
    try {
      await S.driver.ensure(grantManifest());
    } catch (e) {
      return { ok: false, code: 1, error: `cua-driver did not start: ${e.message}` };
    }
  }
  if (S.grant) S.lastActivity = Date.now();
  return { ok: true };
}

/** A channel's process. Info verbs run to completion here and leave with this computer's home folder scrubbed. */
function runner(argv) {
  if (INFO_VERBS.has(argv[0])) return infoProcess(argv);
  return S.driver.run(argv);
}

/** A process-shaped stand-in (stdout, stderr, close) for one info verb. */
function infoProcess(argv) {
  const p = new EventEmitter();
  p.stdout = new PassThrough();
  p.stderr = new PassThrough();
  p.stdin = new PassThrough();
  p.exitCode = null;
  p.signalCode = null;
  p.pid = 0;
  let done = false;
  const finish = (code, signal = null) => {
    if (done) return;
    done = true;
    p.exitCode = code;
    p.signalCode = signal;
    p.stdout.once("end", () => setImmediate(() => p.emit("close", code, signal)));
    p.stdout.end();
    p.stderr.end();
    p.stdout.resume();
    p.emit("exit", code, signal);
  };
  p.kill = () => finish(null, "SIGKILL");
  const home = os.homedir();
  S.driver.execInfo(argv).then(
    (r) => {
      if (done) return;
      if (r.stdout) p.stdout.write(scrubInfo(argv[0], r.stdout, home));
      if (r.stderr) p.stderr.write(scrubInfo("", r.stderr, home));
      finish(r.code);
    },
    (e) => {
      if (done) return;
      p.stderr.write(String(e.message || e));
      finish(1);
    }
  );
  return p;
}

/** The driver channel rides the Deck's relay connection (main.js attachRelay); this makes it say hello or not. */
function startLink() {
  if (!S.channel) return;
  if (S.inert || !SUPPORTED || !enabled()) return stopLink();
  if (!token()) {
    S.channel.stop();
    return setLink({ status: "off", error: i18nText(S.settings.unreadableSecrets?.["botscreen.deviceToken"] ? "botscreen.keyUnreadable" : "U0149") });
  }
  S.channel.start(); // HELLO now when connected (again with a new key), else at the next connect
}

function stopLink() {
  if (S.channel) S.channel.stop(); // the relay connection itself is shared: it stays up
  else setLink({ status: "off" });
}

function makeChannel() {
  const ch = new DriverChannel({ hello, gate, runner, grant: () => S.grant, raise: IS_WIN ? raiseWindow : null,
    kill: (p) => (p.pid ? killProcess(p, process.platform) : p.kill()) });
  ch.on("status", (s) => {
    setLink(s);
    reportDriver();
    if (s.status === "ready" && S.grant) ch.control(OP.GRANT, { grant: G.wireGrant(S.grant) }); // after a reconnect
  });
  ch.on("activity", (t) => {
    if (S.grant) S.lastActivity = t;
  });
  ch.on("channels", () => push());
  ch.on("stop", () => endGrant("remote"));
  return ch;
}

/** Presence heartbeat: driverOk.desktop is true only while the relay accepts this device's driver hello. */
function reportDriver() {
  const ok = installed() && !!S.channel && S.channel.ready;
  if (S.presence.driverOk.desktop === ok) return;
  S.presence.register("desktop", ok);
  S.presence.push();
}

// ---------------------------------------------------------------- relay HTTP (frames, lease, stop)
async function relayFetch(method, p, body, { timeoutMs = 8000 } = {}) {
  const r = relayCfg();
  if (!r) throw new Error(i18nText("U0112"));
  return fetch(`${r.http}${p}`, {
    method,
    headers: { authorization: `Bearer ${r.token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(Math.min(930_000, Math.max(1000, timeoutMs))),
  });
}

/** Step 5 of Durdur: the relay hands control back to the human and ends the wrappers. Never waited for. */
function relayStop() {
  if (S.fixture || !relayCfg()) return;
  relayFetch("POST", "/desktop/stop", { device: S.presence.id }).catch(() => {});
}

async function frame(p) {
  const s = String(p || "");
  if (!FRAME_RE.test(s) || s.split("/").some((x) => x === "." || x === "..")) throw new Error(i18nText("U0150"));
  if (S.fixture) return require("./fixture").frame(s);
  const r = await relayFetch("GET", `/cu/${s.split("/").map(encodeURIComponent).join("/")}`);
  if (!r.ok) throw new Error(r.status === 404 ? i18nText("U0151") : `Relay: HTTP ${r.status}`);
  const type = String(r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "image/jpeg" && type !== "image/png") throw new Error(i18nText("U0152"));
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw new Error(i18nText("U0153"));
  return `data:${type};base64,${buf.toString("base64")}`;
}

/** Take control / Return control: Hermes' own lease for that agent, through the relay. */
async function lease(profile, hold) {
  if (!G.PROFILE_RE.test(profile)) throw new Error(i18nText("U0154"));
  if (S.fixture) {
    S.lease[profile] = hold ? "human" : null;
    push();
    return { ok: true, holder: S.lease[profile] };
  }
  const r = await relayFetch("POST", "/desktop/lease", { profile, hold });
  if (!r.ok) throw new Error(r.status === 404 ? i18nText("U0155") : `Relay: HTTP ${r.status}`);
  const j = await r.json().catch(() => ({}));
  S.lease[profile] = j && j.holder === "human" ? "human" : null;
  push();
  return { ok: !!(j && j.ok), holder: S.lease[profile] };
}

// ---------------------------------------------------------------- driver install and detection
async function detect() {
  let d;
  try {
    d = await S.installer.detect();
  } catch (e) {
    d = { status: "error", error: e.message };
  }
  await applyDetect(d);
}

async function applyDetect(d) {
  S.driverInfo = d || { status: "missing" };
  S.known = null;
  if (installed()) {
    try {
      S.known = M.knownTools(await S.driver.toolList());
    } catch {
      S.known = null;
    }
  }
  reportDriver();
  push();
  if (enabled() && !S.inert) startLink(); // a new HELLO carries the driver state (channels stay open)
}

async function install() {
  if (S.fixture) throw new Error(i18nText("U0156"));
  if (S.install && !["done", "error"].includes(S.install.phase)) throw new Error(i18nText("U0157"));
  S.install = { phase: "download", got: 0, total: (S.pinInfo && S.pinInfo.size) || 0 };
  push();
  try {
    const d = await S.installer.install((p) => {
      S.install = { ...S.install, ...p };
      push();
    });
    S.install = { phase: "done" };
    await applyDetect(d);
  } catch (e) {
    S.install = { phase: "error", error: e.message };
    push();
    throw e;
  }
}

async function macPermissions() {
  if (!IS_MAC) throw new Error(i18nText("U0158"));
  const loc = locate();
  if (!loc) throw new Error(i18nText("U0159"));
  const r = await runFile(loc.bin, ["permissions", "grant"], { timeout: 180000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 200) || i18nText("U0160"));
  return true;
}

// ---------------------------------------------------------------- the consent sheet
/** The window list for "Agent'a ver": capture thumbnails matched with the driver's own window list. */
async function listWindows() {
  if (S.fixture) {
    S.picker = { list: require("./fixture").windows(), at: Date.now() };
    return { windows: S.picker.list.map(publicWindow), note: null };
  }
  if (!enabled()) throw new Error(i18nText("U0161"));
  const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: IS_WIN ? { width: 0, height: 0 } : { width: 320, height: 200 }, fetchWindowIcons: false });
  let records = [];
  let note = null;
  if (installed()) {
    try {
      const d = await startPicker();
      records = W.parseListWindows(await d.call("list_windows", {}));
    } catch (e) {
      note = i18nText("U0162", { message: e.message });
    }
  } else note = i18nText("U0163");
  const ownIds = new Set();
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      ownIds.add(w.getMediaSourceId());
    } catch {
      /* closing */
    }
  }
  const ownPids = new Set([process.pid, ...app.getAppMetrics().map((x) => x.pid)]);
  const list = W.mergeWindows(
    sources.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null })),
    records,
    { ownIds, ownPids }
  );
  if (IS_WIN) {
    const names = new Map();
    await Promise.all(list.filter(w => w.pid && !w.blocked).map(async w => {
      if (!names.has(w.pid)) names.set(w.pid, executablePath(w.pid).then(exe => path.win32.basename(exe || "")).catch(() => ""));
      w.executableName = await names.get(w.pid);
    }));
  }
  S.picker = { list, at: Date.now() };
  if (!sources.length && IS_MAC) note = note || i18nText("U0164");
  return { windows: list.map(publicWindow), note };
}

const publicWindow = (w) => ({ sourceId: w.sourceId, title: w.title, app: w.app, executable: path.win32.basename(w.executable || w.executableName || ""), thumb: w.thumb, matched: !!w.matched, blocked: w.blocked || null, livePreview: IS_WIN && !S.fixture });

async function previewWindow(sourceId) {
  const w = S.picker.list.find(x => x.sourceId === sourceId);
  if (!w || w.blocked || !enabled() || Date.now() - S.picker.at > 10 * 60 * 1000) throw Error(i18nText("U0171"));
  if (!IS_WIN || S.fixture) return w.thumb;
  const ident = await appIdentity(w.pid);
  const png = await captureWindow({ ...w, executable: ident.executable }, { width: 320 }, () => enabled() && S.picker.list.includes(w) && Date.now() - S.picker.at <= 10 * 60 * 1000);
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function refreshWindowFrame(args, meta) {
  const grant = S.grant;
  const authorized = () => enabled() && S.grant === grant && !!grant && Date.now() < grant.expires && allowed().includes(grant.profile);
  if (!authorized() || args.pid !== grant.window.pid || args.window_id !== grant.window.id) throw Error("The window grant has ended");
  return captureWindow({ ...grant.window, executable: grant.ident.executable },
    { width: meta.screenshot_width, height: meta.screenshot_height, bounds: meta.window_bounds }, authorized);
}

/** Resolve exactly one native window. A button hides Deck briefly so the preceding app is frontmost. */
async function frontmost(capture = false) {
  if (S.fixture) {
    const w = require("./fixture").windows().find((x) => !x.blocked);
    S.picker = { list: [w], at: Date.now() };
    return capture ? { window: w, bytes: nativeImage.createFromBitmap(Buffer.from([80, 80, 80, 255]), { width: 1, height: 1 }).toPNG(), text: "Example window text" } : { windows: [publicWindow(w)], note: null };
  }
  if (S.shot) throw new Error(i18nText("frontmost.shotDisabled"));
  if (!SUPPORTED) throw new Error(i18nText("frontmost.windowsOnlyNow"));
  if (!capture && !enabled()) throw new Error(i18nText("U0161"));
  if (S.frontmostBusy) throw new Error(i18nText("frontmost.busy"));
  S.frontmostBusy = true;
  const hidden = S.win && S.win.isFocused();
  try {
    if (hidden) {
      if (IS_MAC) app.hide(); // hiding one NSWindow leaves the Cocoa app frontmost
      else S.win.hide();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const ownPids = new Set([process.pid, ...app.getAppMetrics().map((x) => x.pid)]);
    if (IS_MAC) {
      const result = await macWindow({ capture, ownPids });
      if (capture) return result;
      S.picker = { list: [result], at: Date.now() };
      return { windows: [publicWindow(result)], note: null };
    }
    const window = await readWindow({ ownPids });
    if (capture) return await readWindow({ target: window, capture: true, ownPids });
    S.picker = { list: [window], at: Date.now() };
    return { windows: [publicWindow(window)], note: null };
  } finally {
    S.frontmostBusy = false;
    if (hidden && S.win && !S.win.isDestroyed() && !S.quitting) {
      if (IS_MAC) app.show();
      S.win.showInactive();
    }
  }
}

/** Same pinned driver supervisor, but no grant daemon, shared picker or relay channel is reused. */
async function macWindow(opts) {
  if (!S.pinInfo || !S.pinInfo.available || S.pinInfo.version !== "0.33.3") throw new Error(i18nText("macshot.pinNeeded"));
  if (!installed() || S.driverInfo.version !== "0.33.3") throw new Error(i18nText("macshot.installedNeeded"));
  if (S.appshotDriver || S.quitting) throw new Error(i18nText("macshot.busyClosing"));
  const driver = S.makeDriver({ dir: path.join(workDir(), "appshot"), locate });
  S.appshotDriver = driver;
  try {
    return await readWindow({ ...opts, platform: "darwin", driver, current: () => !S.quitting && S.appshotDriver === driver, encodeImage: (bytes) => {
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error(i18nText("macshot.decodeFailed"));
      const size = image.getSize();
      if (Math.max(size.width, size.height) > 1920) throw new Error(i18nText("macshot.captureInvalid"));
      return image.toJPEG(80);
    } });
  } finally { if (S.appshotDriver === driver) S.appshotDriver = null; }
}

function registerFrontmostHotkey() {
  if (S.shot || S.fixture || !SUPPORTED) return;
  try { S.frontmostHotkey = globalShortcut.register(FRONTMOST_HOTKEY, async () => {
    try {
      const r = await frontmost(); // resolve before bringing Deck forward
      S.win.show();
      S.win.focus();
      S.send("botscreen", { t: "frontmost", ...r });
    } catch (e) {
      S.win.show();
      S.win.focus();
      S.send("botscreen", { t: "frontmost-error", error: e.message });
    }
  }); } catch { S.frontmostHotkey = false; }
}

function unregisterFrontmostHotkey() {
  if (S.frontmostHotkey) globalShortcut.unregister(FRONTMOST_HOTKEY);
  S.frontmostHotkey = false;
}

/** A list-only bounded daemon of its own, so an active grant's daemon is never restarted for the picker. */
async function startPicker() {
  if (!S.pickerDriver) S.pickerDriver = S.makeDriver({ dir: path.join(workDir(), "picker"), locate });
  await S.pickerDriver.ensure(M.pickerManifest({ known: S.known }));
  clearTimeout(S.pickerTimer);
  S.pickerTimer = setTimeout(stopPicker, PICKER_IDLE_MS);
  return S.pickerDriver;
}

function stopPicker() {
  clearTimeout(S.pickerTimer);
  S.pickerTimer = null;
  if (S.pickerDriver) S.pickerDriver.stop().catch(() => {});
}

/** pid -> what the manifest names: the absolute executable (Windows) or the bundle id (macOS). */
async function appIdentity(pid) {
  if (IS_WIN) {
    const exe = await executablePath(pid);
    if (!exe) throw new Error(i18nText("U0165"));
    if (W.samePath(exe, process.execPath)) throw new Error(i18nText("U0166"));
    if (W.isPasswordManager({ executable: exe })) throw new Error(i18nText("U0137"));
    return { executable: exe };
  }
  if (IS_MAC) {
    const bundle = W.bundlePathFromComm((await runFile("/bin/ps", ["-o", "comm=", "-p", String(pid)])).stdout);
    if (!bundle) throw new Error(i18nText("U0167"));
    const own = W.bundlePathFromComm(process.execPath);
    if (own && W.samePath(bundle, own)) throw new Error(i18nText("A0104"));
    const id = W.parseBundleId((await runFile("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(bundle, "Contents", "Info.plist")])).stdout);
    if (!id) throw new Error(i18nText("U0168"));
    if (W.isPasswordManager({ bundleId: id })) throw new Error(i18nText("U0137"));
    return { bundleId: id };
  }
  throw new Error(i18nText("A0106"));
}

const grantManifest = () => M.grantManifest({ grant: S.grant, ident: S.grant.ident, platform: process.platform, known: S.known });

/** "Agent'a ver" confirmed: write the grant, (re)start the bounded driver, tell the relay, show it everywhere. */
async function giveGrant(o) {
  const x = o && typeof o === "object" ? o : {};
  const profile = String(x.profile || "");
  const agent = String(x.agent || "");
  if (!enabled()) throw new Error(i18nText("U0161"));
  if (!allowed().includes(profile)) throw new Error(i18nText("U0169"));
  if (!S.fixture && !installed()) throw new Error(i18nText("U0170"));
  const w = S.picker.list.find((y) => y.sourceId === x.sourceId);
  if (!w || Date.now() - S.picker.at > 10 * 60 * 1000) throw new Error(i18nText("U0171"));
  if (w.blocked) throw new Error(w.blocked);
  if (!S.fixture && w.executable) {
    const opts = { target: w, ownPids: new Set([process.pid, ...app.getAppMetrics().map((x) => x.pid)]) };
    if (IS_MAC) await macWindow({ ...opts, validateOnly: true });
    else await readWindow(opts);
  }
  const g = G.makeGrant({ agent, profile, app: w.app, window: { id: w.id, pid: w.pid, title: w.title }, foreground: x.foreground });
  if (S.fixture) {
    S.grant = { ...g, ident: { executable: "C:\\Program Files\\Example\\app.exe" } };
    S.lastActivity = Date.now();
    S.fixtureUi = null;
    return push();
  }
  const ident = await appIdentity(w.pid);
  // a grant that was running ends first: its channels die with the daemon restart below
  if (S.grant || channelCount()) {
    S.channel.closeChannels({ notify: true, code: 1, error: "the window was handed over again" });
    if (S.grant) S.channel.control(OP.REVOKE);
  }
  S.grant = { ...g, ident };
  S.lastActivity = Date.now();
  try {
    await S.driver.ensure(grantManifest());
  } catch (e) {
    clearGrant();
    hideActive();
    push();
    throw new Error(i18nText("U0172", { message: e.message }));
  }
  stopPicker();
  S.channel.control(OP.GRANT, { grant: G.wireGrant(g) }); // offline: sent again on READY after the reconnect
  showActive();
  startGrantTimers();
  S.desktop.notify("botscreen", { title: i18nText("U0173", { agent: g.agent }), body: i18nText("A0109", { app: g.app, HOTKEY_LABEL: HOTKEY_LABEL }), force: true });
  push();
}

function startGrantTimers() {
  clearInterval(S.grantTimer);
  clearTimeout(S.expiryTimer);
  S.grantTimer = setInterval(() => {
    const why = G.endReason(S.grant, { lastActivity: S.lastActivity });
    if (why) endGrant(why);
  }, 15000);
  S.expiryTimer = setTimeout(() => S.grant && endGrant("expiry"), G.remaining(S.grant) + 50);
}

function clearGrant() {
  S.grant = null;
  clearInterval(S.grantTimer);
  clearTimeout(S.expiryTimer);
  S.grantTimer = null;
  S.expiryTimer = null;
}

function showActive() {
  const g = S.grant;
  if (!g || S.shot) return; // a screenshot run never puts a window on the desktop
  if (S.bar) S.bar.show({ agent: g.agent, app: g.app, title: g.window.title, expires: g.expires, hotkey: HOTKEY_LABEL });
  S.desktop.trayAlert(true, { get text() { return i18nText("A0110", { agent: g.agent, app: g.app }); }, get stopLabel() { return i18nText("A0111", { agent: g.agent, app: g.app }); }, onStop: () => stop("button") });
}

function hideActive() {
  if (S.bar) S.bar.hide();
  if (S.desktop) S.desktop.trayAlert(false);
}

// ---------------------------------------------------------------- stopping
/** Steps 1 and 2 of every stop: channels closed, driver processes killed, the grant gone. Synchronous. */
function teardown() {
  cancelCaptures();
  if (S.channel) S.channel.closeChannels(); // 1
  if (S.driver) S.driver.killAll(); // 2
  if (S.pickerDriver) S.pickerDriver.killAll();
  if (S.appshotDriver) S.appshotDriver.killAll();
  S.appshotDriver = null;
  clearGrant();
}

/**
 * Durdur (bar, tray, tab: "button"; the global shortcut: "hotkey"). Local first, in the contract's order:
 * close channels, kill driver processes, switch to paused, send `stopped`, then the relay's stop endpoint.
 * Nothing here waits for the network.
 */
function stop(by) {
  const had = !!S.grant;
  teardown();
  if (enabled()) {
    S.stopping = true; // our own switch change: onHosting leaves the rest to us
    try {
      S.presence.setHosting("desktop", false);
    } catch {
      /* not registered on this platform */
    } finally {
      S.stopping = false;
    }
  }
  S.paused = { by, at: Date.now() };
  if (S.channel) {
    if (had) S.channel.control(OP.REVOKE);
    S.channel.control(OP.STOPPED, { by }); // 4 (dropped when offline: the heartbeat already says the switch is off)
  }
  relayStop(); // 5
  deactivate();
  afterStop(by, true);
}

/** A stop that ends the grant but leaves the switch as it is: lock, expiry, idle, toggle, quit, remote. */
function endGrant(by) {
  const had = !!S.grant;
  if (!had && !channelCount()) return false;
  teardown();
  if (by !== "remote") {
    if (S.channel) {
      if (had) S.channel.control(OP.REVOKE);
      S.channel.control(OP.STOPPED, { by });
    }
    if (by !== "quit") relayStop();
  }
  afterStop(by, had);
  return true;
}

function afterStop(by, notify) {
  S.lastStop = { by, at: Date.now() };
  hideActive();
  if (notify && by !== "quit" && S.desktop) S.desktop.notify("botscreen", { title: i18nText("U0174"), body: STOP_TEXT[by] || "", force: true });
  push();
}

// ---------------------------------------------------------------- the switch, the hotkey, quitting
function activate() {
  registerHotkey();
  startLink();
}

function deactivate() {
  unregisterHotkey();
  stopLink();
  stopPicker();
  if (S.driver) S.driver.stop().catch(() => {});
  push();
}

function onHosting(cap, on) {
  if (cap !== "desktop" || S.stopping) return;
  if (on) {
    S.paused = null;
    activate();
  } else {
    endGrant("toggle");
    deactivate();
  }
  push();
}

function registerHotkey() {
  if (S.inert || S.fixture || S.hotkey.registered) return;
  let ok = false;
  try {
    ok = globalShortcut.register(HOTKEY, () => stop("hotkey"));
  } catch {
    ok = false;
  }
  S.hotkey.registered = ok; // false: another app holds the combination (Electron says nothing else)
  push();
}

function unregisterHotkey() {
  if (S.hotkey.registered) {
    try {
      globalShortcut.unregister(HOTKEY);
    } catch {
      /* quitting */
    }
  }
  S.hotkey.registered = null;
}

function onQuit() {
  cancelCaptures();
  S.quitting = true;
  if (S.appshotDriver) S.appshotDriver.killAll();
  S.appshotDriver = null;
  endGrant("quit");
  stopLink();
  if (S.driver) S.driver.killAll();
  if (S.pickerDriver) S.pickerDriver.killAll();
  unregisterHotkey();
  unregisterFrontmostHotkey();
}

// ---------------------------------------------------------------- renderer calls (each one checked)
function registerIpc() {
  const own = (e) => !!(S.win && !S.win.isDestroyed() && e.sender === S.win.webContents);
  const handle = (ch, fn) =>
    ipcMain.handle(ch, async (e, ...a) => {
      if (!own(e)) throw new Error(i18nText("U0175"));
      return fn(...a);
    });
  handle("bs:state", () => {
    if (S.fixture) fixtureFeed();
    return publicState();
  });
  handle("bs:agents", (list) => {
    S.settings.updateBotscreen({ agents: Array.isArray(list) ? list : [] });
    if (S.grant && !allowed().includes(S.grant.profile)) endGrant("toggle"); // its permission was just taken away
    push();
    return publicState();
  });
  handle("bs:token", (t) => {
    S.settings.updateBotscreen({ deviceToken: String(t || "") });
    if (enabled()) startLink(); // HELLO again with the new key
    push();
    return publicState();
  });
  handle("bs:install", async () => {
    await install();
    return publicState();
  });
  handle("bs:windows", () => listWindows());
  handle("bs:preview", sourceId => previewWindow(sourceId));
  handle("bs:frontmost", () => frontmost());
  handle("bs:picker-closed", () => {
    if (!S.fixture && !S.grant) stopPicker();
    if (S.fixture) S.fixtureUi = null;
  });
  handle("bs:grant", async (o) => {
    await giveGrant(o);
    return publicState();
  });
  handle("bs:stop", () => {
    stop("button");
    return publicState();
  });
  handle("bs:lease", (profile, hold) => lease(String(profile || ""), hold === true));
  handle("bs:frame", (p) => frame(p));
  handle("bs:mac-permissions", () => macPermissions());
}

// ---------------------------------------------------------------- fixture mode (development screenshots)
function fixtureInit() {
  const FX = require("./fixture");
  const scene = FX.SCENES.has(String(S.fixture)) ? String(S.fixture) : "on";
  S.fixture = scene;
  S.pinInfo = new Installer({ dir: os.tmpdir(), pins: PINS }).pinInfo(); // the table only; nothing is read or written
  const on = !["off", "paused"].includes(scene);
  S.presence.hosting.desktop = on; // this run only: a screenshot run never writes device.json
  S.presence.register("desktop", on && scene !== "missing");
  S.settings.data.botscreen = { agents: ["atlas"], deviceToken: "fixture-device-key" }; // fixture settings are never saved
  S.driverInfo = scene === "missing" ? { status: "missing" } : { status: "installed", version: "0.33.3", source: "deck" };
  S.linkState = on ? { status: "ready" } : { status: "off" };
  S.hotkey.registered = on ? true : null;
  if (scene === "paused") S.paused = { by: "hotkey", at: Date.now() - 4 * 60000 };
  if (scene === "on") {
    S.grant = { ...G.makeGrant({ agent: "Atlas", profile: "atlas", app: "Excel", window: { id: 1001, pid: 4242, title: FX.ATLAS_TITLE }, now: Date.now() - 18 * 60000 }), ident: { executable: "C:\\Program Files\\Example\\EXCEL.EXE" } };
    S.lastActivity = Date.now() - 24000;
  }
  if (scene === "missing") S.fixtureUi = { installArmed: true };
  if (scene === "sheet") S.fixtureUi = { sheet: "pick" };
  if (scene === "confirm") S.fixtureUi = { sheet: "confirm", pick: "window:1001:0", profile: "atlas" };
}

/** The made-up cu events go through the relay channel, as live ones do. */
function fixtureFeed() {
  if (S.fixtureFed) return;
  S.fixtureFed = true;
  const evs = require("./fixture").events(S.presence.id);
  setTimeout(() => S.send("relay", { t: "evs", evs, sessions: [] }), 50);
}

// ---------------------------------------------------------------- entry points for main.js
/**
 * @param {object} o
 * @param {Electron.BrowserWindow} o.win
 * @param {import("../settings").Settings} o.settings
 * @param {import("../presence").DevicePresence} o.presence
 * @param {(ch: string, msg: object) => void} o.send
 * @param {{notify: Function, trayAlert: Function}} o.desktop
 * @param {boolean} [o.shot]      a headless screenshot run
 * @param {string|null} [o.fixture]  fixture scene (fixture mode only)
 */
function init(o) {
  Object.assign(S, { win: o.win, settings: o.settings, presence: o.presence, send: o.send, desktop: o.desktop, version: app.getVersion(), shot: !!o.shot, fixture: o.fixture || null });
  // o.test (scripts/botscreen-e2e.js only): a fake installer and driver; the real wiring runs, headless
  const t = o.test || null;
  S.inert = S.shot && !S.fixture && !t;
  if (SUPPORTED) S.presence.register("desktop", false); // "Desktop control" exists on this platform
  registerIpc();
  if (S.fixture) return fixtureInit();
  S.installer = t ? t.installer : new Installer({ dir: driverDir(), pins: PINS });
  S.pinInfo = S.installer.pinInfo();
  S.makeDriver = t ? t.makeDriver : (opts) => new Driver(opts);
  S.driver = S.makeDriver({ dir: workDir(), locate, capture: IS_WIN && !t ? refreshWindowFrame : null });
  S.driver.on("status", () => push());
  S.channel = makeChannel(); // rides the relay connection main.js hands over in attachRelay()
  S.bar = new ActivityBar({ onStop: () => stop("button") });
  S.presence.on("hosting", onHosting);
  if (S.inert || !SUPPORTED) return;
  powerMonitor.on("lock-screen", () => endGrant("lock"));
  powerMonitor.on("suspend", () => endGrant("lock"));
  app.on("before-quit", onQuit);
  app.on("will-quit", unregisterHotkey);
  app.on("will-quit", unregisterFrontmostHotkey);
  registerFrontmostHotkey();
  detect().then(() => {
    if (enabled()) activate();
  });
}

/**
 * main.js startRelay(): the Deck's relay connection (RelayClient, or null while unconfigured). The driver
 * channel rides it as [0xD5] frames, next to presence heartbeats and the CDP tunnel; channels of a replaced
 * connection die with it.
 */
function attachRelay(relay) {
  if (!S.channel || S.inert) return;
  S.channel.attach(relay || null);
}

/** --shot-botbar=<png> [--wait=ms]: draws only the bar, in a window that is never shown, and quits. */
function shotBar() {
  const file = arg("shot-botbar");
  if (!file) return false;
  new ActivityBar()
    .capture({
      info: { agent: "Atlas", app: "Excel", title: "Örnek bütçe - Excel", expires: Date.now() + 102 * 60000 + 30000, hotkey: HOTKEY_LABEL },
      file: typeof file === "string" ? path.resolve(file) : path.join(app.getPath("temp"), "hermes-deck-botbar.png"),
      wait: Number(arg("wait")) || 800,
    })
    .then((out) => {
      console.log(`bot bar screenshot: ${out}`);
      app.quit();
    })
    .catch((e) => {
      console.error(`bot bar screenshot failed: ${e.message}`);
      app.exit(1);
    });
  return true;
}

/** main.js's quit watchdog: the driver daemons and channel processes end now (synchronous, never throws). */
function killAll() {
  try {
    cancelCaptures();
    if (S.channel) S.channel.closeChannels();
    if (S.driver) S.driver.killAll();
    if (S.pickerDriver) S.pickerDriver.killAll();
  } catch {
    /* quitting anyway */
  }
}

module.exports = {
  init,
  relayFetch, // agent spaces (main/spaces.js) reach the relay the same way
  relayCfg,
  cancelQuit: () => { S.quitting = false; },
  attachRelay,
  shotBar,
  stop,
  killAll,
  HOTKEY,
  HOTKEY_LABEL,
  frontmost,
  // scripts/botscreen-e2e.js drives these directly (the consent sheet's window list needs a real desktop)
  _test: { S, giveGrant, publicState, endGrant, setPicker: (list) => (S.picker = { list, at: Date.now() }) },
};
