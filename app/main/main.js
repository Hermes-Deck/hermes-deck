"use strict";
const { t: i18nText, getLocale: i18nLocale, getLanguage: i18nLanguage, setLanguage: i18nSetLanguage } = require("../renderer/i18n");
// Headless dev runs (--shot, --shot-pet, --fixture) must never put an error dialog on the user's screen: an
// exception while the app loads (a missing module in a fresh worktree, say) is logged and the run exits.
// Electron skips its own error dialog once the app has an uncaughtException listener.
if (process.argv.some((a) => /^--(shot|shot-pet|fixture)(=|$)/.test(a))) {
  process.on("uncaughtException", (e) => {
    console.error(`hermes-deck headless run failed: ${(e && e.stack) || e}`);
    process.exit(1);
  });
}
const { app, BrowserWindow, ipcMain, protocol, net, shell, dialog, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { RelayClient } = require("./relay");
const { TelegramService, KEY_RE, REF_RE } = require("./telegram");
const { Settings } = require("./settings");
const { telegramReady } = require("../renderer/chat-modes");
const secret = require("./secret");
const desktop = require("./desktop"); // desktop shell (A9–A11): notifications, status pet, tray
const theme = require("./theme"); // Settings > Appearance: which colour theme every window uses
const wallpaper = require("./wallpaper"); // Settings > Appearance: the chat background picture
const notifySounds = require("./sounds"); // Settings > Desktop > Notifications: each event's sound
const { initUpdates } = require("./update-service"); // Settings > General > Updates
const { HostVersions } = require("./host-versions"); // relay / plugin older than this app, protocol mismatch
const { createHostUpdater } = require("./host-update"); // Settings › Update the host (relay /host/update)
const { initSpaces } = require("./spaces"); // Bot screen: the agents' own desktop (agent spaces)
const { initDesktops } = require("./desktops"); // agent spaces phase 2: this computer as an agent-desktop host
const { virtualizingPackage } = require("./launch-context"); // Windows: started inside a packaged app's AppData copy
const { spawn: spawnDetached } = require("child_process");
const { BridgeClient, probe: probeBridge, normalizeConfig: normalizeBridgeConfig } = require("./bridge");
const media = require("./media");
// files the agent offers in a Hermes session, and their download (main/hermes-files.js)
const { FileOffers, Downloads, resolveFolder, FILE_MAX } = require("./hermes-files");
// the images/files the USER sent (stored as @image: / @file: lines) and their inline preview (main/media-refs.js, media-fetch.js)
const { projectMedia } = require("./media-refs");
const { fetchImage, fetchAudio } = require("./media-fetch");
// file attachments (A7): staging, validation and upload errors (main/attach.js)
const { AttachStore, checkCaption, uploadError, progressTracker, MAX_PHOTO, MAX_STAGED } = require("./attach");
const hermesUploads = require("./hermes-uploads"); // large attachments for direct Hermes chats: through the relay's disk spool
const hermesDownloads = require("./hermes-downloads"); // large downloads of offered files: streamed from the relay
// Workspace tab: device presence (hosting switches, heartbeat) + agent browsers and their CDP tunnel
const { DevicePresence } = require("./presence");
const { initWorkspace } = require("./workspace");
// Bot screen (E2–E6): an agent may use this computer's desktop in one handed-over window; consent, Stop
const botscreen = require("./cua");
// every main-window channel answers only the Deck's own page (security audit L4; main/ipc-guard.js)
const { isApp, fromApp, appIpc } = require("./ipc-guard");
const ipc = appIpc(ipcMain);

const RENDERER = path.join(__dirname, "..", "renderer");
const IS_MAC = process.platform === "darwin";
const arg = (name) => {
  const a = process.argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  return a === undefined ? undefined : a.includes("=") ? a.split("=").slice(1).join("=") : true;
};
// Screenshot mode for development checks: electron . --shot[=file] [--tab=fleet] [--select=AgentName|t<topicId>]
// (--shot-pet=file draws only the status pet; see desktop.js)
const SHOT = arg("shot") || arg("shot-pet");
// `electron . --quit` asks a running deck to quit (closing its window only hides it to the tray); with no
// deck running it just exits
const QUIT = !!arg("quit");

// --- fixture mode (development): --shot + --fixture=<json> replay a file instead of Telegram/relay ---
// It runs in its own profile folder, so it never reads the user's settings or session and never
// competes for the single-instance lock. [--scene=<name>] opens a UI state listed in the file.
const FIXTURE = SHOT && typeof arg("fixture") === "string" ? path.resolve(arg("fixture")) : null;
const SCENE = FIXTURE && typeof arg("scene") === "string" ? arg("scene") : null;
if (FIXTURE && typeof arg("user-data-dir") !== "string") app.setPath("userData", path.join(app.getPath("temp"), "hermes-deck-fixture"));
// --shot-pet gets its own profile folder (and with it its own single-instance lock) unless --user-data-dir
// names one: run next to an open deck it neither writes into the deck's profile nor makes the deck come forward
else if (arg("shot-pet") && !app.commandLine.hasSwitch("user-data-dir")) app.setPath("userData", path.join(app.getPath("temp"), "hermes-deck-pet"));
// a Workspace screenshot (--workspace-demo, or --workspace-agent alone) too: never the user's own profile,
// stored relay token or relay. Its settings are defaults only (see settings.load below), so no relay is set up.
const WS_SHOT = !FIXTURE && !!SHOT && (typeof arg("workspace-demo") === "string" || arg("workspace-agent") !== undefined);
if (WS_SHOT) app.setPath("userData", path.join(app.getPath("temp"), "hermes-deck-ws-demo"));
// a headless run must never leave an error dialog on screen: log and exit instead
if (SHOT) {
  process.on("uncaughtException", (e) => {
    console.error(e);
    app.exit(1);
  });
}
let fixture = null;

protocol.registerSchemesAsPrivileged([{ scheme: "deck", privileges: { standard: true, secure: true } }]);

// One window per user: two copies would drive the same Telegram session at once, which Telegram can
// answer by revoking it. A screenshot run beside an open app skips Telegram for the same reason.
// Started from inside a packaged app (an agent's terminal in Claude or Codex, or an installer they ran): Windows
// would give this Deck a private copy of its AppData (main/launch-context.js), so its keys would live where the
// Deck you open from the Start menu never looks. A plain launch starts again through Explorer, outside the
// package, and this copy quits before it takes the single-instance lock.
if (app.isPackaged && !SHOT && process.argv.slice(1).every((a) => a === "--updated")) {
  const pkg = virtualizingPackage({ userData: app.getPath("userData"), localAppData: process.env.LOCALAPPDATA });
  if (pkg) {
    try {
      spawnDetached("explorer.exe", [process.execPath], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      app.exit(0);
    } catch {
      /* Explorer could not start it: carry on in here rather than not at all */
    }
  }
}
const SOLO = app.requestSingleInstanceLock();
// This instance has nothing to clean up (it never got past this line), so it exits at once: app.quit()
// before "ready" depends on the app's lifecycle and could leave the --quit instance running.
if ((!SOLO && !SHOT) || QUIT) app.exit(0);
app.on("second-instance", (_e, argv) => {
  if (argv.includes("--quit")) return desktop.quit();
  if (argv.includes("--diagnostics")) return writeDiagnostics();
  if (!win || SHOT) return; // a headless screenshot window never shows itself
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});
const ICON = path.join(__dirname, "..", "build", "icon.png");

let win = null;
let windowClosing = false; // distinguish a window close from a renderer reload during ghost cleanup
let settings = null;
let relay = null;
let tg = null;
let tgEpoch = 0; // invalidate an in-flight Telegram connection when the mode is disabled
let login = null; // in-flight interactive login
let tgStatus = { status: "starting" };
let relayStatus = { status: "starting" };
let workspace = null; // Workspace tab (main/workspace.js)
let desktopsHost = null; // Settings > This device > Agent desktops (main/desktops.js)
const outboundMutations = new Set();
let quitAttempt = null;

// Local troubleshooting only: deliberately omit credentials, chat content and window titles.
function writeDiagnostics() {
  const bs = botscreen._test.publicState();
  const out = { checkedAt: new Date().toISOString(), pid: process.pid, version: app.getVersion(), userData: app.getPath("userData"), localAppData: process.env.LOCALAPPDATA,
    hasRelayKey: !!settings?.data.relay.token, hasDeviceKey: bs.hasToken, unreadableSecrets: Object.keys(settings?.unreadableSecrets || {}),
    driverDirectory: botscreen._test.S.installer?.dir, driver: bs.driver, channel: bs.link, desktop: bs.on,
    cwd: process.cwd(), argv: process.argv.slice(1), loadTrace: settings?.loadTrace || null,
    deviceKeyLen: (settings?.data.botscreen.deviceToken || "").length };
  fs.writeFileSync(path.join(app.getPath("userData"), "diagnostics.json"), JSON.stringify(out, null, 2), { mode: 0o600 });
}

const send = (ch, msg) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, msg);
  desktop.observe(ch, msg); // desktop shell: notifications watch the same feed (also while the window is hidden)
};
const httpUrl = (u) => {
  try {
    const x = new URL(String(u));
    return x.protocol === "https:" || x.protocol === "http:" ? x.toString() : null;
  } catch {
    return null;
  }
};

// --- host versions (host-versions.js) ------------------------------------------------------------
// The relay's hello and the direct connection's deck.version tell which relay / plugin versions run on the host.
// Drift is shown in Settings and told once; a protocol mismatch stops only that connection until settings change.
let hostVersions = null;
let hostUpdater = null; // set once the device presence exists (whenReady)
const hostState = () => (hostVersions ? hostVersions.state() : null);
function initHostVersions() {
  hostVersions = new HostVersions({
    app: app.getVersion(),
    file: path.join(app.getPath("userData"), "host-versions.json"),
    notify: (key, vars, section) => !!desktop.notify("update", { title: i18nText("hostupd.title"), body: i18nText(key, vars), quiet: true, onClick: () => desktop.openSettings(section) }),
    onChange: (state) => {
      send("hostver", state);
      if (hostUpdater) hostUpdater.maybeAuto(state).catch(() => {}); // Settings › Updates › update the host automatically
    },
  });
}

// --- relay ------------------------------------------------------------------------------------
function setRelay(s) {
  relayStatus = s;
  send("relay", { t: "status", ...s });
}

function relayMsg(r, m) {
  if (m && m.t === "hostUpdate" && hostVersions) { hostVersions.hostUpdate(m); return; } // update progress, restart rows
  // large attachments: the picker/drop accepts files up to the relay's per-file limit (the send checks the channel again)
  if (m && m.t === "hello") attachments.maxUpload = (r.uploads && r.uploads.fileBytes) || 0;
  if (m && m.t === "hello" && hostVersions && !hostVersions.relayHello(m)) {
    // a relay speaking another wire protocol: stop this connection only (the banner says why); version drift never stops it.
    // The hello still goes out: its `v` may announce a newer app that speaks the relay's protocol (desktop.js).
    send("relay", m);
    r.stop();
    if (relay === r) setRelay({ status: "closed", error: i18nText("hostupd.protocolRelayShort"), code: "protocol" });
    return;
  }
  (workspace && workspace.onRelayMsg(m)) || send("relay", m); // Workspace tab keeps its frames and answers
}

function startRelay() {
  if (relay) relay.stop();
  relay = null;
  if (workspace) workspace.attachRelay(null); // Workspace tab: drop the old connection's heartbeat + tunnel
  botscreen.attachRelay(null); // Bot screen: the old connection's driver channels end
  if (hostVersions) hostVersions.relayGone();
  if (desktopsHost) desktopsHost.attachRelay(null); // agent desktops: the old connection's [0xD6] tunnel ends
  if (!settings.isConfigured()) return setRelay({ status: "unconfigured" });
  const r = (relay = new RelayClient({ url: settings.data.relay.url, token: settings.data.relay.token }));
  relay.on("status", (s) => relay === r && setRelay(s));
  relay.on("msg", (m) => relay === r && relayMsg(r, m));
  if (workspace) workspace.attachRelay(relay); // Workspace tab: heartbeat + CDP tunnel on this connection
  botscreen.attachRelay(relay); // Bot screen: [0xD5] driver frames on this connection
  if (desktopsHost && !SHOT) desktopsHost.attachRelay(relay); // agent desktops: [0xD6] space tunnel frames on this connection
  relay.start();
}

// --- direct Hermes connection (bridge) ---------------------------------------------------------
// One BridgeClient for the saved bridge settings, restarted whenever they change. Inputs from the
// renderer are checked here and again inside BridgeClient; mutations only ever follow a click.
let bridge = null;
let bridgeStatus = { status: "off" };
let bridgeSessions = [];
let bridgeReasoning = false; // the chat's "Show thinking" (the renderer persists it and sends it on start and on toggle)
const BRIDGE_SID = /^[\x21-\x7e]{1,512}$/;
// Screenshot runs only: --bridge-fake[=approval,busy] feeds the bridge from test/fake-stream.js (synthetic sessions).
const BRIDGE_FAKE = SHOT ? arg("bridge-fake") : undefined;

function fakeBridgeOptions() {
  const flags = typeof BRIDGE_FAKE === "string" ? BRIDGE_FAKE.split(",").filter(Boolean).map((f) => `--${f}`) : [];
  return {
    launch: { file: process.execPath, args: [path.join(__dirname, "..", "test", "fake-stream.js"), "--serve", ...flags] },
    spawn: (file, args, opts) => require("child_process").spawn(file, args, { ...opts, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }),
  };
}

function setBridge(s) {
  bridgeStatus = s;
  send("bridge", { t: "status", ...s });
}

function startBridge() {
  const old = bridge;
  bridge = null;
  bridgeSessions = [];
  if (old) {
    old.removeAllListeners();
    old.stop();
  }
  const cfg = settings.data.bridge;
  if (hostVersions) hostVersions.bridgeVersion(null);
  if (!cfg || cfg.mode === "off") return setBridge({ status: "off" });
  const b = new BridgeClient(cfg, { ...(BRIDGE_FAKE ? fakeBridgeOptions() : {}), showReasoning: bridgeReasoning });
  bridge = b;
  const mine = (fn) => (...a) => bridge === b && fn(...a);
  b.on("status", mine(setBridge));
  // the host plugin's version, once per connection (host-versions.js); a different wire protocol stops this connection
  b.on("status", mine((s) => {
    if (s.status !== "open" || !hostVersions) return;
    b.version().then(mine((v) => {
      if (v && !hostVersions.bridgeVersion(v)) {
        b.removeAllListeners();
        b.stop();
        bridge = null;
        setBridge({ status: "offline", code: "protocol", error: i18nText("hostupd.protocolBridgeShort"), retryInMs: null });
      }
    }));
  }));
  b.on("snapshot", mine((snapshot) => send("bridge", { t: "snapshot", snapshot })));
  b.on("event", mine((e) => send("bridge", { t: "event", ...e })));
  b.on("requests", mine((list) => send("bridge", { t: "requests", list })));
  b.on("sessions", mine((list) => {
    bridgeSessions = list;
    send("bridge", { t: "sessions", list });
  }));
  b.start();
}

const needBridge = () => {
  if (!bridge) throw new Error(i18nText("U0045"));
  return bridge;
};
const bObj = (o) => (o && typeof o === "object" && !Array.isArray(o) ? o : {});
const bSid = (v) => {
  const s = String(v ?? "");
  if (!BRIDGE_SID.test(s)) throw new Error(i18nText("U0102"));
  return s;
};
const bText = (v) => {
  if (typeof v !== "string") throw new Error(i18nText("U0240"));
  return v;
};
const bProfile = (o) => (typeof bObj(o).profile === "string" ? bObj(o).profile : undefined);
const bTurn = (o) => (typeof bObj(o).turnId === "string" ? bObj(o).turnId : undefined);
const bInt = (v, d) => (Number.isInteger(v) ? v : d);

ipc.handle("bridge:status", () => ({
  status: bridgeStatus,
  snapshot: bridge ? bridge.currentSnapshot() : null,
  requests: bridge ? bridge.listRequests() : [],
  sessions: bridgeSessions,
  platform: process.platform,
}));
// reads
ipc.handle("bridge:sessions", (_e, o) => needBridge().sessions({ limit: bInt(bObj(o).limit, 50), profile: bProfile(o) }));
ipc.handle("bridge:history", async (_e, sid, o) => {
  const s = bSid(sid);
  const r = await needBridge().history(s, { profile: bProfile(o) || "default", limit: bInt(bObj(o).limit, 40), offset: bInt(bObj(o).offset, 0) });
  // File chips: main parses the files an ASSISTANT message offers (MEDIA: or a backticked absolute path) and gives the
  // page only an opaque ref + the file name; a download is by ref, so the page can never ask for a path of its own.
  for (const m of r.messages) {
    const files = fileOffers.collect(s, m);
    if (files.length) m.files = files;
    projectMedia(s, m, fileOffers); // a USER message's @image:/@file: lines become m.media [{kind, name, ref}]
  }
  return r;
});

// --- dictation: a recording is transcribed by Hermes' own STT on the host; the text goes back to the composer ---
// The clip stays in memory (never written to this computer); at most one at a time, and a bounded size: the page
// records at most 120 s of Opus (well under 1 MB), the host accepts up to 25 MB.
const DICTATION_MAX = 8 * 1024 * 1024;
let dictating = false;
ipc.handle("bridge:transcribe", async (_e, bytes, mime) => {
  if (dictating) throw new Error(i18nText("voice.busy"));
  const buf = bytes instanceof Uint8Array ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes instanceof ArrayBuffer ? Buffer.from(bytes) : null;
  if (!buf || !buf.length || buf.length > DICTATION_MAX) throw new Error(i18nText("voice.invalid"));
  dictating = true;
  try {
    return await needBridge().transcribe(buf, typeof mime === "string" ? mime.slice(0, 120) : "audio/webm");
  } finally {
    dictating = false;
  }
});

// --- files the agent offered: size lookup, download to the Downloads folder, open / show -----------------------
const fileOffers = new FileOffers();
// The folder is the owner's setting (Settings > Download folder), else the OS Downloads folder + "Hermes Deck". It is
// validated at download time (exists, is a folder, writable); an unusable chosen folder is an error, never a silent
// write somewhere else.
const defaultDownloadDir = () => path.join(SHOT ? app.getPath("userData") : app.getPath("downloads"), SHOT ? "downloads" : "Hermes Deck");
const downloads = new Downloads({
  dir: () => resolveFolder({ custom: settings && settings.data.downloads ? settings.data.downloads.dir : "", fallback: defaultDownloadDir() }),
});
ipc.handle("downloads:pick-folder", async () => {
  if (SHOT) throw new Error(i18nText("U0259")); // no native dialog during a headless run
  const cur = settings.data.downloads.dir;
  const r = await dialog.showOpenDialog(win, { title: i18nText("download.pickTitle"), defaultPath: cur || defaultDownloadDir(), properties: ["openDirectory", "createDirectory"] });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return settings.publicView();
  resolveFolder({ custom: r.filePaths[0], fallback: "" }); // exists, a folder, writable: else the error is shown now
  settings.update({ downloads: { dir: r.filePaths[0] } });
  return settings.publicView();
});
ipc.handle("downloads:reset-folder", () => {
  settings.update({ downloads: { dir: "" } });
  return settings.publicView();
});
const DOWNLOAD_TICKET = /^[A-Za-z0-9-]{6,64}$/;
const bRef = (v) => {
  const s = String(v ?? "");
  if (!/^[0-9a-f]{16}$/.test(s)) throw new Error(i18nText("download.invalid"));
  return s;
};
/** The host path for a ref this session was offered (parsed by main from an assistant message), else an error. */
const offeredPath = (sid, ref) => {
  const p = fileOffers.pathOf(sid, ref);
  if (!p) throw new Error(i18nText("download.unknown"));
  return p;
};
const downloadError = (e, limit = FILE_MAX) => {
  if (e && e.code === "folder") {
    const why = ["missing", "not a folder", "not writable", "not an absolute path"].includes(e.why) ? e.why : "not writable";
    return new Error(i18nText("download.folderUnusable", { dir: String(e.dir || "").slice(0, 200), why: i18nText(`download.why.${why.replace(/ /g, "_")}`) }));
  }
  if (e && e.code === "busy") return new Error(i18nText("download.busy"));
  // the active limit: the relay path's (8 GB by default) or the chunk path's 200 MB
  if (e && (e.code === "too-big" || hermesDownloads.tooBig(e) || (e.relayDownload && e.status === 413))) return new Error(i18nText("download.tooBig", { n: media.human(e.max || limit) }));
  if (e && (e.code === "changed" || e.code === "incomplete" || (e.relayDownload && e.status === 409))) return new Error(i18nText("download.changed"));
  if (e && e.relayDownload && e.code !== "canceled") return new Error(i18nText("download.relayFailed", { e: String(e.message || e.code || "").slice(0, 200) }));
  return e;
};
// size and name of the file behind a chip (one byte is read; the host checks the offer and refuses secrets). A file over
// the chunk path's 200 MB asks for a relay download ticket instead when the relay and the plugin share this host.
ipc.handle("bridge:file-info", async (_e, sid, ref, o) => {
  const s = bSid(sid);
  const p = offeredPath(s, bRef(ref));
  const profile = bProfile(o);
  const b = needBridge();
  const name = require("path").posix.basename(p);
  let route = null;
  try {
    const c = await b.fileChunk(s, p, { offset: 0, length: 1, profile });
    return { size: c.size, mtime: c.mtime, name, risky: media.isRisky(name) };
  } catch (e) {
    route = hermesDownloads.tooBig(e) ? await hermesDownloads.pickRoute(relay, b) : null;
    if (!route) throw downloadError(e);
  }
  try {
    const g = await b.fileGrant(s, p, { profile });
    return { size: g.size, mtime: g.mtime, name, risky: media.isRisky(name) };
  } catch (e) {
    throw downloadError(e, hermesDownloads.activeLimit(route));
  }
});
// inline preview of an image the user sent: the whole picture (bounded) as a data: URL, or {ok: false, reason}
ipc.handle("bridge:media-image", async (_e, sid, ref, o) => {
  const s = bSid(sid);
  const p = offeredPath(s, bRef(ref));
  const profile = bProfile(o);
  const r = await fetchImage((offset, length) => needBridge().fileChunk(s, p, { offset, length, profile }));
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, mime: r.mime, size: r.bytes.length, url: `data:${r.mime};base64,${r.bytes.toString("base64")}` };
});
// the whole clip (bounded, 25 MB) of a voice note / audio file for the inline player: bytes for decodeAudioData + a blob: URL
ipc.handle("bridge:media-audio", async (_e, sid, ref, o) => {
  const s = bSid(sid);
  const p = offeredPath(s, bRef(ref));
  const profile = bProfile(o);
  const r = await fetchAudio((offset, length) => needBridge().fileChunk(s, p, { offset, length, profile }), { name: require("path").posix.basename(p) });
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, mime: r.mime, size: r.bytes.length, bytes: r.bytes };
});
ipc.handle("bridge:file-download", async (_e, sid, ref, o) => {
  const s = bSid(sid);
  const p = offeredPath(s, bRef(ref));
  const ticket = String(bObj(o).ticket ?? "");
  if (!DOWNLOAD_TICKET.test(ticket)) throw new Error(i18nText("download.invalid"));
  const profile = bProfile(o);
  const emit = (m) => {
    if (win && !win.isDestroyed()) win.webContents.send("files", { ticket, ...m });
  };
  const b = needBridge();
  let route = null;
  try {
    // Large downloads (hermes-downloads.js): granted by the plugin and streamed from the relay when both share this
    // host's spool (8 GB by default, resumed after a cut); else 1 MiB chunks through the bridge (200 MB).
    route = await hermesDownloads.pickRoute(relay, b);
    const grant = route ? await b.fileGrant(s, p, { profile }) : null;
    const size = grant ? grant.size : (await b.fileChunk(s, p, { offset: 0, length: 1, profile })).size;
    const name = require("path").posix.basename(p);
    let target;
    if (settings.data.downloads.ask) {
      // "Ask where to save each time": the Save As dialog confirms overwriting itself, so that file is replaced
      if (SHOT) throw new Error(i18nText("U0259"));
      const dir = (() => { try { return resolveFolder({ custom: settings.data.downloads.dir, fallback: defaultDownloadDir() }); } catch { return app.getPath("downloads"); } })();
      const pick = await dialog.showSaveDialog(win, { title: i18nText("A0151"), defaultPath: path.join(dir, media.safeName(name)) });
      if (pick.canceled || !pick.filePath) return { status: "cancelled" };
      target = pick.filePath;
    }
    const job = { name, target, size, max: hermesDownloads.activeLimit(route), onProgress: (pr) => emit({ t: "progress", ...pr }) };
    if (grant) job.open = hermesDownloads.opener({ relay: route.relay, bridge: b, sid: s, path: p, profile, grant });
    else job.read = (offset, length) => needBridge().fileChunk(s, p, { offset, length, profile });
    return await downloads.run(ticket, job);
  } catch (e) {
    throw downloadError(e, hermesDownloads.activeLimit(route));
  }
});
ipc.handle("bridge:file-cancel", (_e, ticket) => downloads.cancel(String(ticket ?? "")));
ipc.handle("bridge:file-open", async (_e, id) => {
  if (SHOT) throw new Error(i18nText("U0263")); // never another app's window during a headless run
  const p = downloads.pathOf(String(id ?? ""));
  if (!p || !fs.existsSync(p)) throw new Error(i18nText("download.gone"));
  if (media.isRisky(path.basename(p))) throw new Error(i18nText("U0264")); // "Open" refuses what runs code; the file stays saved
  const err = await shell.openPath(p);
  if (err) throw new Error(err);
  return true;
});
ipc.handle("bridge:file-reveal", (_e, id) => {
  if (SHOT) throw new Error(i18nText("U0263"));
  const p = downloads.pathOf(String(id ?? ""));
  if (!p || !fs.existsSync(p)) throw new Error(i18nText("download.gone"));
  shell.showItemInFolder(p);
  return true;
});
// mutations
ipc.handle("bridge:send", (e, sid, text, o) => trackMutation(async () => {
  fromApp(e);
  // Any staged file (picked, dropped, pasted) or window capture goes with the message through the bridge's one
  // bounded file method; a capture's window text is appended to the prompt. The renderer only names tokens.
  const tokens = bObj(o).files || [];
  if (!Array.isArray(tokens) || tokens.length > MAX_STAGED) throw new Error(i18nText("attach.hermesTooMany", { n: MAX_STAGED }));
  const tokenList = tokens.map((t) => String(t ?? ""));
  const typed = bText(text).trim();
  if (!tokenList.length) return needBridge().send(bSid(sid), bText(text), { profile: bProfile(o) });
  for (const t of tokenList) if (uploads.has(t)) throw new Error(i18nText("attach.hermesAlreadySending"));
  const b = needBridge();
  // Large attachments (hermes-uploads.js): through the relay's disk spool when the relay and the plugin share it,
  // with the relay's limits (2 GB per file by default); else the old single-line path (25 MB per file).
  const route = await hermesUploads.pickRoute(relay, b);
  if (route) return sendViaRelay(b, route, sid, typed, tokenList, o);
  const { items, files } = await attachments.hermesFiles(tokenList);
  const captures = items.filter((x) => x.appshotText).map((x) => x.appshotText);
  const prompt = [typed, ...captures].filter(Boolean).join("\n\n");
  for (const it of items) uploads.set(it.token, { isCanceled: false });
  try {
    const result = await b.send(bSid(sid), prompt, { profile: bProfile(o), files });
    for (const it of items) attachments.discard(it.token);
    return result;
  } finally { for (const it of items) uploads.delete(it.token); }
}));
// Running relay uploads of direct Hermes sends: cancelled from the chip (tg:upload-cancel) or when the app quits.
const relayUploads = new Set();
async function sendViaRelay(b, route, sid, typed, tokenList, o) {
  const items = attachments.hermesItems(tokenList, route.limits); // checked against the relay's limits, nothing read
  const captures = items.filter((x) => x.appshotText).map((x) => x.appshotText);
  const prompt = [typed, ...captures].filter(Boolean).join("\n\n");
  const controller = new AbortController();
  // the chip's Cancel sets isCanceled (tg:upload-cancel); here that aborts the running upload
  const cancel = { get isCanceled() { return controller.signal.aborted; }, set isCanceled(v) { if (v) controller.abort(); } };
  const trackers = new Map(items.map((it) => [it.token, progressTracker((p) => send("tg", { t: "upload", token: it.token, p, hermes: true }))]));
  for (const it of items) uploads.set(it.token, cancel);
  relayUploads.add(controller);
  try {
    const result = await hermesUploads.sendStaged({ relay: route.relay, bridge: b, items, sid: bSid(sid), text: prompt, profile: bProfile(o),
      signal: controller.signal, progress: (token, p) => trackers.get(token)(p) });
    for (const it of items) attachments.discard(it.token);
    return result;
  } finally {
    relayUploads.delete(controller);
    for (const it of items) {
      uploads.delete(it.token);
      send("tg", { t: "upload", token: it.token, p: null, hermes: true, done: true });
    }
  }
}
ipc.handle("bridge:create", (_e, o) => needBridge().create({ profile: bProfile(o) || "default" })); // a click on "New session"
ipc.handle("bridge:discard", (_e, sid) => needBridge().discard(bSid(sid))); // untouched New session, no transcript deletion
function resumeRailUnload() {
  if (!win || win.isDestroyed()) return;
  if (windowClosing) win.close();
  else win.webContents.reload();
}
ipc.handle("bridge:unload-done", (e) => { fromApp(e); resumeRailUnload(); });
ipc.handle("bridge:delete", (_e, sid, o) => needBridge().deleteSession(bSid(sid), { profile: bProfile(o) })); // right-click > Delete, confirmed
// session browser (renderer/sessions-browser.js): every profile's stored sessions (a read), then one click-driven write each
ipc.handle("bridge:session-index", (_e, o) => needBridge().sessionIndex({ archived: bObj(o).archived === true, force: bObj(o).force === true }));
ipc.handle("bridge:session-rename", (_e, sid, o) => trackMutation(() => needBridge().renameSession(bSid(sid), { profile: bProfile(o), title: bObj(o).title })));
ipc.handle("bridge:session-pin", (_e, sid, o) => trackMutation(() => needBridge().pinSession(bSid(sid), { profile: bProfile(o), pinned: bObj(o).pinned })));
ipc.handle("bridge:session-archive", (_e, sid, o) => trackMutation(() => needBridge().archiveSession(bSid(sid), { profile: bProfile(o), archived: bObj(o).archived })));
ipc.handle("bridge:session-branch", (_e, sid, o) => trackMutation(() => needBridge().branchSession(bSid(sid), { profile: bProfile(o) })));
ipc.handle("bridge:takeover", (e, sid, o) => { fromApp(e); return trackMutation(() => needBridge().takeover(bSid(sid), { profile: bProfile(o) })); });
ipc.handle("bridge:steer", (_e, sid, text, o) => needBridge().steer(bSid(sid), bText(text), { turnId: bTurn(o) }));
ipc.handle("bridge:redirect", (_e, sid, text, o) => needBridge().redirect(bSid(sid), bText(text), { turnId: bTurn(o) }));
ipc.handle("bridge:interrupt", (_e, sid, o) => needBridge().interrupt(bSid(sid), { turnId: bTurn(o) }));
// work pane (Run, Plan, Agents tabs): sub-agent roster and tail (reads), steer and interrupt of one child (a click
// each, never replayed), the session's plan (live, else stored) and its latest tool calls
const bSub = (v) => String(v ?? "").slice(0, 128); // bridge.js checks the shape (validSubagent)
ipc.handle("bridge:subagents", (_e, sid, o) => needBridge().subagents(bSid(sid), { profile: bProfile(o) }));
ipc.handle("bridge:subagent-tail", (_e, sid, id, o) => needBridge().subagentTail(bSid(sid), bSub(id), { profile: bProfile(o) }));
ipc.handle("bridge:subagent-steer", (_e, sid, id, text, o) => trackMutation(() => needBridge().steerSubagent(bSid(sid), bSub(id), bText(text), { profile: bProfile(o) })));
ipc.handle("bridge:subagent-interrupt", (_e, sid, id, o) => trackMutation(() => needBridge().interruptSubagent(bSid(sid), bSub(id), { profile: bProfile(o) })));
ipc.handle("bridge:plan", (_e, sid, o) => needBridge().plan(bSid(sid), { profile: bProfile(o) }));
ipc.handle("bridge:tool-calls", (_e, sid, o) => needBridge().toolCalls(bSid(sid), { profile: bProfile(o) }));
ipc.handle("bridge:reasoning", (_e, show) => {
  bridgeReasoning = show === true;
  return bridge ? bridge.setReasoning(bridgeReasoning) : { show: bridgeReasoning };
});
ipc.handle("bridge:model-options", (_e, sid, o) => needBridge().modelOptions(bSid(sid), { profile: bProfile(o), profileOnly: bObj(o).profileOnly === true }));
ipc.handle("bridge:set-model", (_e, sid, c) => {
  const x = bObj(c);
  return needBridge().setModel(bSid(sid), { model: String(x.model || ""), provider: String(x.provider || ""), confirm: x.confirm === true, profile: bProfile(x) });
});
ipc.handle("bridge:set-effort", (_e, sid, o) => needBridge().setEffort(bSid(sid), { effort: String(bObj(o).effort || ""), profile: bProfile(o) }));
ipc.handle("bridge:answer-approval", (_e, id, choice) => needBridge().answerApproval(String(id ?? "").slice(0, 256), String(choice ?? "")));
ipc.handle("bridge:answer-question", (_e, id, answers) => needBridge().answerQuestion(String(id ?? "").slice(0, 256), bObj(answers)));
// Botlar (renderer/bots.js): the profile roster and avatars (reads), the read-only Bot Chat lookup, and the
// Bot Chat create that only a first message sent from the composer triggers
const bName = (v) => String(v ?? "").slice(0, 64);
ipc.handle("bridge:profiles", () => needBridge().profiles());
ipc.handle("bridge:commands", (_e, profile) => needBridge().commandCatalog(bName(profile)));
ipc.handle("bridge:avatar", (_e, name) => needBridge().avatar(bName(name)));
ipc.handle("bridge:bot-chat", (_e, name, o) => needBridge().botChat(bName(name), { expect: bObj(o).expect === true }));
ipc.handle("bridge:bot-chat-create", (_e, name, o) => needBridge().createBotChat(bName(name), { expect: bObj(o).expect === true }));
ipc.handle("bridge:test", (_e, cfg) => probeBridge(normalizeBridgeConfig(bObj(cfg))));

// --- telegram ---------------------------------------------------------------------------------
function setTg(s) {
  tgStatus = s;
  send("tg", { t: "status", ...s });
}

function telegramOptions() {
  const d = settings.data;
  return {
    apiId: d.telegram.apiId,
    apiHash: d.telegram.apiHash,
    groupChatId: d.groupChatId,
    hiddenBots: d.hiddenBots,
    // C5 read receipts: only while the window is shown, focused and not minimized
    readReceipts: d.readReceipts !== false,
    readGate: () => !quitAttempt && !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused()),
    avatarDir: path.join(app.getPath("userData"), "avatars"),
    mediaDir: path.join(app.getPath("userData"), "media"),
  };
}

function trackMutation(action) {
  if (quitAttempt) return Promise.reject(new Error(i18nText("outbound.closing")));
  const pending = Promise.resolve().then(action);
  outboundMutations.add(pending);
  const settled = () => {
    outboundMutations.delete(pending);
    if (quitAttempt && quitAttempt.waiting && !outboundMutations.size) resumeQuit(quitAttempt);
  };
  pending.then(settled, settled);
  return pending;
}

function wire(svc) {
  // Service boundary also covers detached login and the ReadQueue's delayed receipts.
  for (const name of ["send", "sendFile", "callback", "react", "createTopic", "editTopic", "pinTopic", "deleteTopic", "logout", "login", "_sendRead"]) {
    const method = svc[name];
    if (typeof method !== "function") continue;
    svc[name] = (...args) => trackMutation(() => method.apply(svc, args));
  }
  const push = (m) => {
    if (telegramReady(settings.data) && (tg === svc || (login && login.svc === svc))) send("tg", m);
  };
  svc.on("dialogs", (d) => push({ t: "dialogs", ...d }));
  svc.on("msg", (m) => push({ t: "msg", m }));
  svc.on("edit", (m) => push({ t: "edit", m }));
  svc.on("reactions", (r) => push({ t: "reactions", ...r })); // C9: live reaction chips
  svc.on("typing", (x) => push({ t: "typing", ...x }));
  svc.on("avatar", (x) => push({ t: "avatar", ...x }));
  svc.on("people", (users) => push({ t: "people", users }));
  svc.on("read", (x) => push({ t: "read", ...x })); // C5: read on another device
  svc.on("counts", (x) => push({ t: "counts", ...x })); // C5: unread counts again after a reconnect
}

// fixture mode: a recorded-looking Telegram + relay from a JSON file, nothing over the network
function startFixture() {
  const { FixtureService, FixtureRelay } = require("./fixture");
  const svc = fixture = new FixtureService(FIXTURE, { mediaDir: path.join(app.getPath("userData"), "media") });
  tg = svc;
  wire(svc);
  relay = new FixtureRelay(svc.data.relay);
  relay.on("status", setRelay);
  relay.on("msg", (m) => send("relay", m));
  relay.start();
  return svc.start().then(() => {
    if (tg !== svc || !telegramReady(settings.data)) return svc.stop();
    setTg({ status: "open", me: svc.meInfo() });
  });
}

async function startTelegram() {
  if (quitAttempt) return; // a reconnect must not stop a service whose writes are draining
  cancelLogin();
  const epoch = ++tgEpoch;
  const old = tg;
  tg = null;
  if (old) await old.stop();
  if (epoch !== tgEpoch) return;
  if (!telegramReady(settings.data)) {
    send("tg", { t: "dialogs", me: null, group: null, bots: [], topics: [] });
    return setTg({ status: "disabled" });
  }
  if (FIXTURE) return startFixture();
  if (!SOLO) return setTg({ status: "error", code: "another-window", detail: i18nText("U0241") });
  if (!settings.hasTelegramKeys()) return setTg({ status: "setup" });
  let session = "";
  try {
    session = secret.loadSession();
  } catch {
    return setTg({ status: "login", step: "phone", error: i18nText("U0242") });
  }
  if (!session) return setTg({ status: "login", step: "phone" });
  const svc = new TelegramService({ ...telegramOptions(), session });
  tg = svc; // disabling the mode can stop this client even while start() is pending
  wire(svc);
  setTg({ status: "connecting" });
  try {
    await svc.start();
    if (epoch !== tgEpoch || !telegramReady(settings.data)) return svc.stop();
    setTg({ status: "open", me: svc.meInfo() });
  } catch (e) {
    await svc.stop();
    if (epoch !== tgEpoch || !telegramReady(settings.data)) return;
    tg = null;
    if (e.message === "not-authorized") {
      secret.clearSession();
      return setTg({ status: "login", step: "phone", error: i18nText("U0243") });
    }
    setTg({ status: "error", detail: String(e.message).slice(0, 160) });
  }
}

const RETRYABLE = /PHONE_CODE_INVALID|PHONE_CODE_EMPTY|PASSWORD_HASH_INVALID|Code is empty/;
function loginMessage(err) {
  const m = String((err && (err.errorMessage || err.message)) || err);
  if (/NO_ACCOUNT/.test(m)) return i18nText("U0244");
  if (/PHONE_NUMBER_INVALID/.test(m)) return i18nText("U0245");
  if (/PHONE_CODE_INVALID|PHONE_CODE_EMPTY|Code is empty/.test(m)) return i18nText("U0246");
  if (/PHONE_CODE_EXPIRED/.test(m)) return i18nText("U0247");
  if (/PASSWORD_HASH_INVALID/.test(m)) return i18nText("U0248");
  const flood = /FLOOD_WAIT_(\d+)|wait of (\d+) seconds/i.exec(m);
  if (flood) return i18nText("U0249", { v: flood[1] || flood[2] });
  if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(m)) return i18nText("U0250");
  if (/AUTH_USER_CANCEL/.test(m)) return null;
  return i18nText("U0251", { v: m.slice(0, 140) });
}

function cancelLogin() {
  ++tgEpoch; // also cancel a login waiting for the old client to disconnect
  const L = login;
  login = null;
  if (!L) return;
  if (L.pending) L.pending.reject(new Error("AUTH_USER_CANCEL"));
  L.svc.stop();
}

async function startLogin(phone) {
  cancelLogin();
  const epoch = ++tgEpoch;
  const old = tg;
  tg = null;
  if (old) await old.stop();
  if (epoch !== tgEpoch || !telegramReady(settings.data)) return;
  const svc = new TelegramService(telegramOptions());
  wire(svc);
  const L = { svc, pending: null, error: null };
  login = L;
  const ask = (step, extra = {}) =>
    new Promise((resolve, reject) => {
      if (login !== L) return reject(new Error("AUTH_USER_CANCEL"));
      L.pending = { step, resolve, reject };
      setTg({ status: "login", step, error: L.error, ...extra });
      L.error = null;
    });
  setTg({ status: "login", step: "sending" });
  svc
    .login({
      phone,
      askCode: (viaApp) => ask("code", { viaApp: !!viaApp }),
      askPassword: (hint) => ask("password", { hint: hint ? String(hint).slice(0, 60) : null }),
      onError: async (err) => {
        if (login !== L) return true; // cancelled
        L.error = loginMessage(err);
        return !RETRYABLE.test(String(err.errorMessage || err.message));
      },
    })
    .then((session) => {
      if (login !== L) return svc.stop();
      login = null;
      secret.saveSession(session);
      tg = svc;
      setTg({ status: "open", me: svc.meInfo() });
    })
    .catch(async (e) => {
      if (login !== L) return;
      login = null;
      await svc.stop();
      if (epoch !== tgEpoch || !telegramReady(settings.data)) return;
      setTg({ status: "login", step: "phone", error: L.error || loginMessage(e) });
    });
}

// --- IPC (every input from the renderer is validated here) -----------------------------------
ipc.handle("ready", () => {
  if (relay) relay.resync();
  return {
    tg: tgStatus,
    relay: relayStatus,
    dialogs: tg && tg.state ? tg.state : null,
    avatars: tg ? tg.avatars : {},
    people: tg ? tg.people || {} : {},
    settings: settings.publicView(),
    desktop: desktop.info(), // desktop shell: build type, whether start-at-login works here (Settings → Desktop)
    hostVersions: hostState(), // relay / plugin versions on the host (host-versions.js)
    riskyExt: [...media.RISKY_EXT], // the one list "Open" refuses (media.isRisky); the renderer hides the button for it (L9)
    ui: {
      tab: typeof arg("tab") === "string" ? arg("tab") : null,
      select: typeof arg("select") === "string" ? arg("select") : null,
      scene: fixture && SCENE ? (fixture.data.scenes || {})[SCENE] || null : null,
      // screenshot runs only: --hermes-view=bots|sessions picks the Hermes rail view (Botlar | Oturumlar)
      hview: SHOT && typeof arg("hermes-view") === "string" ? arg("hermes-view") : null,
    },
  };
});
ipc.handle("settings:get", () => settings.publicView());
ipc.handle("settings:save", async (_e, patch) => {
  if (quitAttempt) throw new Error(i18nText("outbound.settingsClosing"));
  const before = JSON.stringify(settings.data);
  settings.update(patch && typeof patch === "object" ? patch : {});
  const was = JSON.parse(before);
  const d = settings.data;
  if (d.language !== was.language) {
    i18nSetLanguage(d.language);
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("language", i18nLanguage());
    }
  }
  if (d.theme !== was.theme) theme.setChoice(d.theme);
  if (JSON.stringify(d.relay) !== JSON.stringify(was.relay)) startRelay();
  if (JSON.stringify(d.bridge) !== JSON.stringify(was.bridge)) startBridge();
  if (telegramReady(d) !== telegramReady(was) ||
      (JSON.stringify([d.telegram, d.groupChatId, d.hiddenBots]) !== JSON.stringify([was.telegram, was.groupChatId, was.hiddenBots]) && !login)) await startTelegram();
  if (d.readReceipts !== was.readReceipts && tg && tg.setReadReceipts) tg.setReadReceipts(d.readReceipts !== false); // C5, no reconnect needed
  desktop.applySettings(); // desktop shell: pet on/off, tray menu checkboxes
  if (desktopsHost && JSON.stringify(d.desktops) !== JSON.stringify(was.desktops)) desktopsHost.settingsChanged(); // the heartbeat's limit
  return settings.publicView();
});
ipc.handle("tg:retry", () => {
  if (!login) startTelegram();
});
ipc.handle("tg:login-start", (_e, phone) => {
  if (quitAttempt) throw new Error(i18nText("telegram.noClosingOperation"));
  if (!telegramReady(settings.data) || FIXTURE) throw new Error(i18nText("telegram.modeOff"));
  const p = String(phone || "").replace(/[\s()-]/g, "");
  if (!/^\+?\d{7,15}$/.test(p)) throw new Error(i18nText("U0252"));
  if (!settings.hasTelegramKeys()) throw new Error(i18nText("U0253"));
  startLogin(p.startsWith("+") ? p : `+${p}`);
  return true;
});
ipc.handle("tg:login-answer", (_e, step, value) => {
  const L = login;
  if (!L || !L.pending || L.pending.step !== step) throw new Error(i18nText("U0254"));
  const v = String(value || "").trim();
  if (!v) throw new Error(i18nText("U0255"));
  const { resolve } = L.pending;
  L.pending = null;
  setTg({ status: "login", step: "checking" });
  resolve(step === "code" ? v.replace(/\D/g, "") : v);
  return true;
});
ipc.handle("tg:login-cancel", () => {
  cancelLogin();
  setTg({ status: "login", step: "phone" });
});
ipc.handle("tg:logout", async () => {
  if (quitAttempt) throw new Error(i18nText("telegram.noClosingOperation"));
  cancelLogin();
  if (tg) {
    try {
      await tg.logout();
    } catch {
      /* offline: the local copy is still removed below */
    }
  }
  tg = null;
  secret.clearSession();
  send("tg", { t: "dialogs", me: null, group: null, bots: [], topics: [] });
  setTg({ status: settings.hasTelegramKeys() ? "login" : "setup", step: "phone" });
});
ipc.handle("tg:history", (e, key) => {
  fromApp(e); // the user's chats: only our own page
  if (!tg || !KEY_RE.test(String(key))) throw new Error(i18nText("U0256"));
  return tg.history(String(key));
});
// C5: the renderer saw chat `key` up to maxId (selected, window in front, scrolled into view)
ipc.on("tg:read", (e, key, maxId) => {
  // a Telegram write (read receipts): only our own page. A fire-and-forget send has no caller to
  // reject, and a throw here would be a main-process uncaught exception, so a foreign frame is ignored
  if (!isApp(e)) return;
  const id = Number(maxId);
  if (!tg || !tg.markRead || !KEY_RE.test(String(key)) || !Number.isSafeInteger(id) || id <= 0) return;
  tg.markRead(String(key), id);
});
ipc.handle("tg:send", (e, key, text, replyTo) => {
  fromApp(e); // a Telegram write: only our own page
  if (!tg || !KEY_RE.test(String(key))) throw new Error(i18nText("U0256"));
  const r = replyTo === undefined || replyTo === null ? null : Number(replyTo);
  if (r !== null && !(Number.isSafeInteger(r) && r > 0)) throw new Error(i18nText("U0257"));
  return tg.send(String(key), String(text), r);
});

// --- file attachments (A7) ---------------------------------------------------------------------
// A file is staged here from the open dialog, a drop (paths resolved in the preload, checked again in
// attach.js) or pasted image bytes; the renderer only holds a token. Uploads report progress as
// {t: "upload", token, p} on the "tg" channel and stop on "tg:upload-cancel".
const attachments = new AttachStore({ preview: attachPreview, draftDir: path.join(app.getPath("userData"), "draft-attachments") });
const uploads = new Map(); // token -> progress tracker (its isCanceled flag stops teleproto's upload)

/** A small data: URL thumbnail for a staged image, or null. Never decodes anything big. */
function attachPreview(item) {
  if (item.size > MAX_PHOTO * 2) return null;
  const img = item.buffer ? nativeImage.createFromBuffer(item.buffer) : nativeImage.createFromPath(item.path);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const scale = Math.min(1, 160 / Math.max(width, height, 1));
  return img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: "good" }).toDataURL();
}
async function stageAll(paths) {
  const items = [];
  const errors = [];
  for (const p of paths) {
    try {
      items.push(await attachments.stagePath(p));
    } catch (e) {
      errors.push(`${media.safeName(path.basename(String(p)))}: ${e.message}`);
    }
  }
  return { items, errors };
}
// Chat wallpaper: a native picker (the page never sees a path), the copy lives in the profile (main/wallpaper.js)
ipc.handle("wallpaper:pick", async (e, mode) => {
  fromApp(e);
  if (!wallpaper.MODES.includes(mode)) throw new Error(i18nText("wall.badDim"));
  if (SHOT) throw new Error(i18nText("U0259"));
  const r = await dialog.showOpenDialog(win, { title: i18nText("wall.pick"), properties: ["openFile"],
    filters: [{ name: i18nText("wall.images"), extensions: ["png", "jpg", "jpeg", "webp", "gif"] }] });
  if (r.canceled || !r.filePaths.length) return settings.publicView();
  let name;
  try {
    name = wallpaper.importImage(app.getPath("userData"), r.filePaths[0]);
  } catch (err) {
    throw new Error(i18nText(/^wall\./.test(err.message) ? err.message : "wall.badType"));
  }
  settings.setWallpaperFile(mode, name);
  wallpaper.clean(app.getPath("userData"), wallpaper.used(settings.data.wallpaper)); // a picture no mode uses goes
  return settings.publicView();
});
ipc.handle("wallpaper:preset", (e, mode, id) => {
  fromApp(e);
  if (!wallpaper.MODES.includes(mode) || !wallpaper.PRESETS.includes(id)) throw new Error(i18nText("wall.badDim"));
  settings.setWallpaperFile(mode, `preset:${id}`);
  wallpaper.clean(app.getPath("userData"), wallpaper.used(settings.data.wallpaper));
  return settings.publicView();
});
ipc.handle("wallpaper:clear", (e, mode) => {
  fromApp(e);
  if (!wallpaper.MODES.includes(mode)) throw new Error(i18nText("wall.badDim"));
  settings.setWallpaperFile(mode, "");
  wallpaper.clean(app.getPath("userData"), wallpaper.used(settings.data.wallpaper));
  return settings.publicView();
});
// Notification sounds: a native picker for the user's own file (the page never sees a path), copied into the
// profile (main/sounds.js); sounds:set picks a built-in sound or none. A file no event uses any more goes.
ipc.handle("sounds:pick", async (e, event) => {
  fromApp(e);
  if (!notifySounds.EVENTS.includes(event)) throw new Error(i18nText("sound.invalid"));
  if (SHOT) throw new Error(i18nText("U0259"));
  const r = await dialog.showOpenDialog(win, { title: i18nText("sound.pick"), properties: ["openFile"],
    filters: [{ name: i18nText("sound.files"), extensions: notifySounds.EXTS }] });
  if (r.canceled || !r.filePaths.length) return settings.publicView();
  let name;
  try {
    name = notifySounds.importSound(app.getPath("userData"), r.filePaths[0]);
  } catch (err) {
    throw new Error(i18nText(/^sound\./.test(err.message) ? err.message : "sound.badType"));
  }
  settings.setSoundEvent(event, name);
  notifySounds.clean(app.getPath("userData"), notifySounds.used(settings.data.sounds));
  return settings.publicView();
});
ipc.handle("sounds:set", (e, event, value) => {
  fromApp(e);
  if (!notifySounds.EVENTS.includes(event) || !notifySounds.isPresetOrNone(value)) throw new Error(i18nText("sound.invalid"));
  settings.setSoundEvent(event, value);
  notifySounds.clean(app.getPath("userData"), notifySounds.used(settings.data.sounds));
  return settings.publicView();
});
ipc.handle("tg:attach-pick", async (e) => {
  fromApp(e);
  if (SHOT) throw new Error(i18nText("U0259")); // no native dialog during a headless run
  const r = await dialog.showOpenDialog(win, { title: i18nText("A0149"), buttonLabel: i18nText("A0079"), properties: ["openFile", "multiSelections"] });
  if (r.canceled || !r.filePaths.length) return { items: [], errors: [] };
  return stageAll(r.filePaths.slice(0, MAX_STAGED));
});
// paths come from the preload's webUtils.getPathForFile on dropped File objects; attach.js checks each one
ipc.handle("tg:attach-drop", (e, paths) => {
  fromApp(e);
  if (!Array.isArray(paths) || paths.length > MAX_STAGED) throw new Error(i18nText("U0260", { MAX_STAGED: MAX_STAGED }));
  return stageAll(paths.filter((p) => typeof p === "string"));
});
ipc.handle("tg:attach-paste", (e, data) => {
  fromApp(e);
  const d = data && typeof data === "object" ? data : {};
  return attachments.stageData({ bytes: d.bytes, name: typeof d.name === "string" ? d.name.slice(0, 300) : undefined, type: typeof d.type === "string" ? d.type.slice(0, 200) : undefined });
});
ipc.handle("attach:draft-save", (e, key, tokens) => { fromApp(e); return attachments.saveDraft(key, tokens); });
ipc.handle("attach:draft-restore", (e) => { fromApp(e); return attachments.restoreDrafts(); });
ipc.handle("attach:draft-forget", (e, key) => { fromApp(e); return attachments.forgetDraft(key); });
ipc.handle("attach:appshot", async (e) => {
  fromApp(e);
  return attachments.stageAppshot(await botscreen.frontmost(true));
});
ipc.handle("tg:attach-discard", (e, token) => {
  fromApp(e);
  const t = String(token ?? "");
  return !uploads.has(t) && attachments.discard(t);
});
ipc.handle("tg:send-file", async (e, key, token, opts) => {
  fromApp(e);
  if (!tg || !tg.sendFile || !KEY_RE.test(String(key))) throw new Error(i18nText("U0256"));
  const o = opts && typeof opts === "object" ? opts : {};
  const r = o.replyTo === undefined || o.replyTo === null ? null : Number(o.replyTo);
  if (r !== null && !(Number.isSafeInteger(r) && r > 0)) throw new Error(i18nText("U0257"));
  const item = attachments.get(String(token ?? ""));
  const caption = checkCaption([checkCaption(o.caption), item.appshotText].filter(Boolean).join("\n\n"));
  if (uploads.has(item.token)) throw new Error(i18nText("U0261"));
  const progress = progressTracker((p) => send("tg", { t: "upload", token: item.token, p }));
  uploads.set(item.token, progress);
  try {
    const m = await tg.sendFile(String(key), item, { caption, replyTo: r, asDocument: o.asDocument === true, progress });
    attachments.discard(item.token);
    return m;
  } catch (err) {
    throw new Error(uploadError(err));
  } finally {
    uploads.delete(item.token);
  }
});
ipc.handle("tg:send-album", async (e, key, tokens, opts) => {
  fromApp(e);
  if (!tg || !tg.sendAlbum || !KEY_RE.test(String(key))) throw new Error(i18nText("U0256"));
  if (!Array.isArray(tokens) || tokens.length < 2 || tokens.length > 10) throw new Error(i18nText("U0256"));
  const o = opts && typeof opts === "object" ? opts : {};
  const r = o.replyTo === undefined || o.replyTo === null ? null : Number(o.replyTo);
  if (r !== null && !(Number.isSafeInteger(r) && r > 0)) throw new Error(i18nText("U0257"));
  const items = tokens.map((t) => attachments.get(String(t ?? "")));
  if (items.some((it) => it.kind !== "photo" || it.appshotText)) throw new Error(i18nText("U0256"));
  if (new Set(items.map((it) => it.token)).size !== items.length || items.some((it) => uploads.has(it.token))) throw new Error(i18nText("U0261"));
  const caption = checkCaption(o.caption);
  // one tracker for the whole album: cancelling any of its photos stops the upload
  const progress = progressTracker((p) => { for (const it of items) send("tg", { t: "upload", token: it.token, p }); });
  for (const it of items) uploads.set(it.token, progress);
  try {
    const list = await tg.sendAlbum(String(key), items, { caption, replyTo: r, progress });
    for (const it of items) attachments.discard(it.token);
    return list;
  } catch (err) {
    throw new Error(uploadError(err));
  } finally {
    for (const it of items) uploads.delete(it.token);
  }
});
ipc.handle("tg:upload-cancel", (e, token) => {
  fromApp(e);
  const p = uploads.get(String(token ?? ""));
  if (p) p.isCanceled = true;
  return !!p;
});

// --- media, inline buttons (message view) ------------------------------------------------------
const msgRef = (key, msgId) => {
  const k = String(key);
  const id = Number(msgId);
  if (!tg || !tg.fetchMedia) throw new Error(i18nText("U0256"));
  if (!KEY_RE.test(k) || !Number.isSafeInteger(id) || id <= 0) throw new Error(i18nText("U0262"));
  return { k, id };
};
/** Which of a rich message's photos/documents ("p<i>" / "d<i>"); none: the message's own media. */
const mediaRef = (ref) => {
  if (ref === undefined || ref === null || ref === "") return null;
  const r = String(ref);
  if (!REF_RE.test(r)) throw new Error(i18nText("U0258"));
  return r;
};

/** Images come back as data: URLs, audio as bytes (the renderer makes a blob: URL), anything else stays a file. */
ipc.handle("tg:media", async (_e, key, msgId, variant, ref) => {
  const { k, id } = msgRef(key, msgId);
  const v = String(variant);
  if (v !== "thumb" && v !== "full") throw new Error(i18nText("U0258"));
  const f = await tg.fetchMedia(k, id, v, mediaRef(ref));
  if (v === "thumb" || media.INLINE_IMAGE.has(f.mime)) {
    const buf = await fs.promises.readFile(f.path);
    const mime = media.sniffImage(buf) || (v === "thumb" ? "image/jpeg" : f.mime);
    if (!media.INLINE_IMAGE.has(mime)) return { type: "file", name: f.name, size: f.size };
    return { type: "image", url: `data:${mime};base64,${buf.toString("base64")}` };
  }
  if (/^audio\//.test(f.mime) || f.kind === "voice" || f.kind === "audio") {
    return { type: "audio", mime: /^audio\//.test(f.mime) ? f.mime : "audio/ogg", bytes: await fs.promises.readFile(f.path) };
  }
  return { type: "file", name: f.name, size: f.size };
});
ipc.handle("tg:media-open", async (_e, key, msgId, ref) => {
  const { k, id } = msgRef(key, msgId);
  const part = mediaRef(ref);
  if (SHOT) throw new Error(i18nText("U0263")); // never another app's window during a headless run
  const f = await tg.fetchMedia(k, id, "full", part);
  if (media.isRisky(f.name)) throw new Error(i18nText("U0264"));
  const err = await shell.openPath(f.path);
  if (err) throw new Error(err);
  return true;
});
ipc.handle("tg:media-save", async (_e, key, msgId, ref) => {
  const { k, id } = msgRef(key, msgId);
  const part = mediaRef(ref);
  if (SHOT) throw new Error(i18nText("U0265")); // no native dialog during a headless run
  const f = await tg.fetchMedia(k, id, "full", part);
  const r = await dialog.showSaveDialog(win, { title: i18nText("A0151"), defaultPath: path.join(app.getPath("downloads"), f.name) });
  if (r.canceled || !r.filePath) return false;
  await fs.promises.copyFile(f.path, r.filePath);
  return true;
});
// where: "kb" (the inline keyboard, default) or "rich" (a button row inside a rich message)
ipc.handle("tg:callback", (e, key, msgId, row, col, where) => {
  fromApp(e); // a Telegram write: only our own page
  const { k, id } = msgRef(key, msgId);
  const r = Number(row);
  const c = Number(col);
  const w = where === undefined || where === null ? "kb" : String(where);
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r > 499 || c > 99 || (w !== "kb" && w !== "rich")) throw new Error(i18nText("U0266"));
  return tg.callback(k, id, r, c, w);
});

// --- reactions (C9): the picker's choices, setting the user's own reactions, custom emoji pictures ---
ipc.handle("tg:reaction-choices", (e, key) => {
  fromApp(e);
  const k = String(key);
  if (!tg || !tg.reactionChoices) throw new Error(i18nText("U0256"));
  if (!KEY_RE.test(k)) throw new Error(i18nText("U0267"));
  return tg.reactionChoices(k);
});
// the composer's "/" suggestions: the commands the chat's bot(s) registered with Telegram (reads only)
ipc.handle("tg:bot-commands", (e, key) => {
  fromApp(e);
  const k = String(key);
  if (!tg || !tg.botCommands) return [];
  if (!KEY_RE.test(k)) throw new Error(i18nText("U0267"));
  return tg.botCommands(k);
});
// the composer's "@" suggestions: group members already seen in memory who have a username (a read)
ipc.handle("tg:members", (e) => {
  fromApp(e);
  return tg && tg.members ? tg.members() : [];
});
// keys: the user's whole new set ("e:<emoji>" | "c:<documentId>"), [] takes them all back
ipc.handle("tg:react", (e, key, msgId, keys) => {
  fromApp(e); // a Telegram write (messages.sendReaction): only our own page, only from a user's click there
  const { k, id } = msgRef(key, msgId);
  if (!tg.react) throw new Error(i18nText("U0256"));
  if (!Array.isArray(keys) || keys.length > 3 || keys.some((x) => typeof x !== "string" || x.length > 32)) throw new Error(i18nText("U0268"));
  return tg.react(k, id, keys);
});
ipc.handle("tg:emoji", async (e, docId) => {
  fromApp(e);
  const d = String(docId);
  if (!tg || !tg.customEmoji) throw new Error(i18nText("U0256"));
  if (!/^\d{1,20}$/.test(d)) throw new Error(i18nText("U0258"));
  const file = await tg.customEmoji(d);
  if (!file) return null;
  const buf = await fs.promises.readFile(file);
  const mime = media.sniffImage(buf);
  return mime && media.INLINE_IMAGE.has(mime) ? `data:${mime};base64,${buf.toString("base64")}` : null;
});

// --- forum topics of the configured group: create, rename, close/reopen, pin, delete -------------
// Telegram's six topic colours; General (id 1) can be neither closed nor deleted.
const TOPIC_COLORS = [0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f];
ipc.handle("tg:topic", (e, op, a) => {
  fromApp(e); // a Telegram write (create, rename, close, pin, delete a topic): only our own page
  if (!tg || !tg.createTopic) throw new Error(i18nText("U0256"));
  const x = a && typeof a === "object" ? a : {};
  const id = Number(x.id);
  const title = typeof x.title === "string" ? x.title.trim() : "";
  const needId = (general = true) => {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(i18nText("U0269"));
    if (!general && id === 1) throw new Error(i18nText("U0270"));
  };
  const needTitle = () => {
    if (!title || title.length > 128) throw new Error(i18nText("U0271"));
  };
  switch (op) {
    case "create":
      needTitle();
      if (!TOPIC_COLORS.includes(Number(x.color))) throw new Error(i18nText("U0272"));
      return tg.createTopic(title, Number(x.color));
    case "rename":
      needId();
      needTitle();
      return tg.editTopic(id, { title });
    case "close":
      needId(false);
      return tg.editTopic(id, { closed: !!x.closed });
    case "pin":
      needId();
      return tg.pinTopic(id, !!x.pinned);
    case "delete":
      needId(false);
      return tg.deleteTopic(id);
    default:
      throw new Error(i18nText("U0273"));
  }
});
ipc.handle("relay:session", (_e, sid) => {
  if (!relay) throw new Error(i18nText("U0235"));
  return relay.get(`/session/${encodeURIComponent(String(sid))}`);
});
// Plan tab (relay path): {sid, plan, stored}, the live plan or the one rebuilt from state.db
ipc.handle("relay:plan", (_e, sid) => {
  if (!relay) throw new Error(i18nText("U0235"));
  return relay.plan(String(sid ?? ""));
});
ipc.handle("relay:tokens", (_e, rangeOrDays) => {
  if (!relay) throw new Error(i18nText("U0235"));
  return require("./tokens-range").fetchTokens((p) => relay.get(p), rangeOrDays);
});
// On-demand quota refresh (Usage refresh button): the relay asks the plugins to refetch now, rate-limited to 30 s.
ipc.handle("relay:quota-refresh", async () => {
  if (!relay) throw new Error(i18nText("U0235"));
  const r = await relay.post("/fleet/quotas/refresh", 45000);
  return { refreshed: !!r.refreshed, throttled: !!r.throttled, timedOut: !!r.timedOut, retryAfterS: Number(r.retryAfterS) || 0 };
});
// sub-agent views (B1–B4): message history, full messages and tool calls through the relay (history.js)
require("./history").register(ipc, () => relay);
// Settings > Hermes config: Hermes' config.yaml per profile and the gateway / relay restarts, through the relay
require("./hermes-config").register(ipc, () => relay);
ipc.handle("open-external", (_e, url) => {
  const u = httpUrl(url);
  if (u) return shell.openExternal(u);
});
ipc.on("rendered", () => {
  if (!SHOT || !win) return;
  setTimeout(async () => {
    const img = await win.webContents.capturePage();
    const file = typeof SHOT === "string" ? path.resolve(SHOT) : path.join(app.getPath("temp"), "hermes-deck-shot.png");
    fs.writeFileSync(file, img.toPNG());
    console.log(`screenshot: ${file}`);
    app.quit();
  }, Number(arg("wait")) || 9000);
});

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1100,
    minHeight: 640,
    show: !SHOT && !desktop.startHidden(settings), // desktop shell: a login start may open straight into the tray
    backgroundColor: theme.windowColors().bg,
    title: "Hermes Deck",
    icon: ICON,
    autoHideMenuBar: true,
    ...(IS_MAC
      ? { titleBarStyle: "hiddenInset" }
      : { titleBarStyle: "hidden", titleBarOverlay: theme.titleBarOverlay() }),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      additionalArguments: [`--deck-language=${i18nLanguage()}`, theme.arg()],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    const u = httpUrl(url);
    if (u) shell.openExternal(u);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("deck://")) e.preventDefault();
  });
  require("./context-menu").attachContextMenu(win); // cut/copy/paste on right-click in text fields
  theme.attach(win);
  win.loadURL("deck://app/index.html");
  win.on("focus", () => tg && tg.wakeReads && tg.wakeReads()); // C5: marks held while in the background
}

// Dictation records from the microphone, in the Deck's own page only. Chromium asks the embedder; everything else
// (camera, geolocation, notifications, any other origin or frame) stays refused, as it was with no handler at all.
const MIC_PERMISSIONS = new Set(["media", "microphone"]);
function micAllowed(contents, permission, details) {
  if (!MIC_PERMISSIONS.has(permission)) return false;
  const url = String((details && (details.requestingUrl || details.securityOrigin)) || (contents && contents.getURL && contents.getURL()) || "");
  if (!url.startsWith("deck://app/")) return false;
  const types = details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
  return !types.length || types.every((t) => t === "audio"); // never video
}
function installPermissions() {
  const ses = require("electron").session.defaultSession;
  ses.setPermissionRequestHandler((contents, permission, callback, details) => callback(!!win && contents === win.webContents && micAllowed(contents, permission, details)));
  ses.setPermissionCheckHandler((contents, permission, _origin, details) => !!win && !!contents && contents === win.webContents && micAllowed(contents, permission, details));
}

app.whenReady().then(() => {
  if ((!SOLO && !SHOT) || QUIT) return; // quitting: the first window was focused (or asked to quit) instead
  installPermissions();
  protocol.handle("deck", (req) => {
    const u = new URL(req.url);
    const wall = wallpaper.fileFor(app.getPath("userData"), u.pathname); // the chat wallpaper, from the profile
    if (wall) return net.fetch(pathToFileURL(wall).toString());
    const sound = notifySounds.fileFor(app.getPath("userData"), u.pathname); // a notification sound, from the profile
    if (sound) return net.fetch(pathToFileURL(sound).toString());
    const p = path.normalize(path.join(RENDERER, decodeURIComponent(u.pathname)));
    if (!p.startsWith(RENDERER + path.sep)) return new Response("forbidden", { status: 403 });
    return net.fetch(pathToFileURL(p).toString());
  });
  // dev: --shot-pet=<png> draws only the status pet; it runs before settings load, so it reads no saved
  // settings (or a legacy ~/.hermes-deck config). Chromium's own files go to the separate profile set above.
  if (SHOT || arg("shot-botbar")) i18nSetLanguage(arg("shot-language"));
  if (desktop.shotPet()) return;
  settings = new Settings();
  // fixture and Workspace shots: defaults only, nothing read from or written to disk (load() would also fall
  // back to the legacy ~/.hermes-deck env files and their relay token)
  if (FIXTURE || WS_SHOT) settings.save = () => {};
  else settings.load();
  // Explicit owner-supplied setup file; secrets are encrypted by this installed app, never another exe.
  let setupHosting = null;
  if (!SHOT && typeof arg("configure") === "string") {
    setupHosting = settings.importFile(path.resolve(arg("configure")));
  }
  if ((SHOT || arg("shot-botbar")) && typeof arg("shot-language") === "string") settings.data.language = arg("shot-language") === "tr" ? "tr" : "en";
  i18nSetLanguage(settings.data.language);
  // dev: --theme=<name> previews a theme in screenshot runs without touching the saved choice
  if ((SHOT || arg("shot-botbar")) && typeof arg("theme") === "string" && theme.CHOICES.includes(arg("theme"))) settings.data.theme = arg("theme");
  theme.setChoice(settings.data.theme);
  // dev: --wallpaper=<image> [--wallpaper-dim=<0..90>] shows that chat background in every mode in screenshot runs
  if (SHOT && typeof arg("wallpaper") === "string") {
    const w = arg("wallpaper");
    const file = w.startsWith("preset:") ? w : wallpaper.importImage(app.getPath("userData"), path.resolve(w)); // --wallpaper=preset:<id> too
    settings.data.wallpaper = wallpaper.normalize({ file, dim: Number(arg("wallpaper-dim")) || 55 });
  }
  // Fixture-only mode scenarios never load a profile or start a real bridge.
  if (FIXTURE) {
    settings.data.firstRunDone = !arg("first-run");
    if (typeof arg("chat-modes") === "string") settings.update({ chat: {
      modes: arg("chat-modes").split(","), defaultMode: arg("chat-default") || arg("chat-modes").split(",")[0],
    } });
    if (BRIDGE_FAKE && !arg("first-run")) settings.data.bridge = { mode: "local", target: "", distribution: "", python: process.execPath, stream: path.join(__dirname, "..", "test", "fake-stream.js") };
  }
  if (botscreen.shotBar()) return; // dev: --shot-botbar=<png> draws only the bot screen's activity bar
  // --- Workspace tab: hosting is off until the user allows it in Settings > This device ---
  const device = new DevicePresence({ persist: !SHOT });
  if (setupHosting) {
    for (const cap of ["browser", "desktop"]) if (setupHosting[cap] !== undefined) device.hosting[cap] = setupHosting[cap];
    device._save();
  }
  device.registerIpc();
  // Settings › Update the host: the relay token and this device's key, before the desktop shell like every channel
  hostUpdater = createHostUpdater({ relay: () => relay, settings, deviceId: () => device.id, app: app.getVersion(), file: path.join(app.getPath("userData"), "host-update.json") });
  ipc.handle("hostupdate:update", () => hostUpdater.update());
  ipc.handle("hostupdate:restart", (_e, profile) => hostUpdater.restart(profile));
  const demoUrl = SHOT && typeof arg("workspace-demo") === "string" ? arg("workspace-demo") : null;
  // robot checks on an agent's page raise one desktop notification (desktop.notify works once desktop.init ran)
  workspace = initWorkspace({ send, presence: device, settings, notify: desktop.notify, shot: !!SHOT, demoUrl, demoAgent: arg("workspace-agent"), demoScene: arg("workspace-scene") });
  if (IS_MAC && app.dock) app.dock.setIcon(ICON);
  // updates: how far main moved since this build, and one button to update (Settings > General > Updates)
  initUpdates({ ipc, settings, send, notify: (k, p) => desktop.notify(k, p), quit: desktop.quit, openSettings: () => desktop.openSettings("general"), shot: !!SHOT });
  if (!SHOT) initHostVersions(); // Settings › Relay / › Hermes: host versions behind this app
  createWindow();
  // agent spaces: registered before the desktop shell like every channel of the main window
  // the agent desktops this computer runs (desktopsHost, set just below) are viewed on loopback, not through the relay
  const localDesktops = { port: async (p) => (desktopsHost ? desktopsHost.port(p) : null), token: (p) => (desktopsHost ? desktopsHost.token(p) : null) };
  initSpaces({ ipc, win, relayCfg: botscreen.relayCfg, relayFetch: botscreen.relayFetch, deviceId: () => device.id, settings, notify: (k, p) => desktop.notify(k, p), send, desktops: localDesktops });
  // agent desktops on this computer (off until the user turns them on, after the consent sheet); before the desktop shell
  desktopsHost = initDesktops({ ipc, settings, presence: device, send, dataDir: path.join(app.getPath("userData"), "desktops"), shot: !!SHOT });
  desktop.init({ win, settings, icon: ICON, shot: !!SHOT }); // desktop shell: notifications, pet, tray, close-to-tray
  win.on("close", (e) => { windowClosing = !e.defaultPrevented; }); // registered after close-to-tray
  // Bot screen: off until "Desktop control" is on (Settings > This device); fixture runs pick a scene with --botscreen=<scene>
  const bsScene = FIXTURE && arg("botscreen") ? (typeof arg("botscreen") === "string" ? arg("botscreen") : "on") : null;
  botscreen.init({ win, settings, presence: device, send, desktop, shot: !!SHOT, fixture: bsScene });
  if (FIXTURE) {
    if (BRIDGE_FAKE) startBridge();
    return startTelegram(); // fixture Telegram respects modes and never connects to the network
  }
  startRelay();
  startBridge();
  startTelegram();
});

/** The app's own connections and children end; safe to run more than once. */
function shutdown() {
  if (desktopsHost) desktopsHost.quit(); // agent desktops here stop (stopped, not removed); once
  if (relay) relay.stop();
  if (bridge) bridge.stop();
  cancelLogin();
}
app.on("window-all-closed", () => {
  shutdown();
  app.quit();
});
// app.quit() (tray "Quit", --quit) skips "window-all-closed": the same cleanup runs here
app.on("will-quit", shutdown);
// Drain external writes before closing windows. An unresolved write cancels quit after 30 s;
// its result stays available, so the user can decide whether a retry is safe.
const QUIT_GRACE_MS = 10_000;
const OUTBOUND_QUIT_WAIT_MS = 30_000;
function cancelQuit() {
  if (!quitAttempt) return;
  clearTimeout(quitAttempt.waitTimer);
  clearTimeout(quitAttempt.exitTimer);
  quitAttempt = null;
  desktop.cancelQuit();
  botscreen.cancelQuit();
  if (tg && tg.wakeReads) tg.wakeReads();
}
function resumeQuit(attempt) {
  if (quitAttempt !== attempt) return;
  if (attempt.cancelled) return cancelQuit();
  clearTimeout(attempt.waitTimer);
  attempt.waiting = false;
  // Let IPC handlers finish their upload cleanup and return the terminal result before closing windows.
  attempt.waitTimer = setTimeout(() => {
    if (quitAttempt === attempt && !outboundMutations.size) app.quit();
  }, 0);
}
app.on("before-quit", (e) => {
  if (e.defaultPrevented) return cancelQuit();
  const attempt = quitAttempt || (quitAttempt = { waiting: false });
  // a running relay upload (large attachment) is cancelled: nothing was sent to Hermes yet, the relay deletes it
  for (const controller of relayUploads) controller.abort();
  // a running download stops too (its .part file is removed; nothing on the host changes)
  downloads.cancelAll();
  if (outboundMutations.size) {
    // Observe other listeners cancelling this same attempt, including while our own barrier holds it.
    const prevent = e.preventDefault;
    const observeCancel = () => { attempt.cancelled = true; prevent.call(e); };
    e.preventDefault = observeCancel;
    prevent.call(e);
    Promise.resolve().then(() => {
      if (e.preventDefault === observeCancel) e.preventDefault = prevent;
      if (attempt.cancelled) cancelQuit();
    });
    if (attempt.waiting) return;
    attempt.waiting = true;
    attempt.waitTimer = setTimeout(() => {
      if (quitAttempt !== attempt) return;
      cancelQuit();
      console.error("hermes-deck: outbound operation unresolved after 30 s; quit cancelled");
      desktop.notify("info", { title: i18nText("desktop.quitCancelled"), body: i18nText("outbound.waitOperation"), force: true });
    }, OUTBOUND_QUIT_WAIT_MS);
    cancelLogin(); // a pending code/password prompt is cancellable; its service promise must still settle
    return;
  }
  // Lifecycle listeners can cancel a quit; only arm the stalled-quit fallback after they have run.
  Promise.resolve().then(() => {
    if (quitAttempt !== attempt) return;
    if (e.defaultPrevented) return cancelQuit();
    if (attempt.exitTimer) return;
    attempt.exitTimer = setTimeout(() => {
      if (quitAttempt !== attempt || outboundMutations.size) return;
      console.error(`hermes-deck: quit did not finish in ${QUIT_GRACE_MS / 1000} s; exiting`);
      try {
        if (workspace) workspace.host.killAll();
        botscreen.killAll();
        if (desktopsHost) desktopsHost.quit();
      } finally {
        app.exit(0);
      }
    }, QUIT_GRACE_MS);
    if (attempt.exitTimer.unref) attempt.exitTimer.unref();
  });
});
app.on("will-quit", (e) => {
  Promise.resolve().then(() => { if (e.defaultPrevented) cancelQuit(); });
});
app.on("quit", cancelQuit);
