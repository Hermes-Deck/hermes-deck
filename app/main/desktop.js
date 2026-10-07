"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
// Desktop shell, kept out of main.js: OS notifications (A9), the status pet (A10), the tray icon and
// close-to-tray (A11), start at login (G2, main/autostart.js). main.js hands it every message it sends the
// renderer (observe), asks startHidden() before making the window, calls init() once the window exists
// and applySettings() after a settings save.
//
// For other features: notify(kind, {title, body, key}) shows a toast while the deck is in the background.
// The bridge uses kind "approval" or "question" for things that wait for the user's answer (second chime,
// the toast stays until dismissed); key is the chat to open on click ("u<botId>" or "t<topicId>").
const { app, ipcMain, nativeImage, Notification } = require("electron");
const fs = require("fs");
const path = require("path");
const { Notifier, clip, textOf } = require("./notify");
const { Pet, statusParts, SKINS: PET_SKINS } = require("./pet");
const { PetFeed } = require("./pet-model"); // pet events: replies, questions, finished runs
const { DeckTray } = require("./tray");
const autostart = require("./autostart"); // G2: "Bilgisayar açılınca başlat"
const { createUpdateNotice } = require("./updates");
const { badgeText, badgeCount, badgePng } = require("./taskbar-badge");

const IS_WIN = process.platform === "win32";
// Telegram chat, a Hermes session from the bridge, or an agent's Workspace tab (ws:<profile>: a robot check)
const KEY_RE = /^(?:(u|t)\d+|hs:[\w.:-]{1,200}|ws:[a-z0-9][a-z0-9_-]{0,63})$/;
const APP_ID = "io.github.hermes-deck"; // = appId in electron-builder.yml
const arg = (name) => {
  const a = process.argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  return a === undefined ? undefined : a.includes("=") ? a.split("=").slice(1).join("=") : true;
};

// Windows shows a toast only for an app it can tie to a Start menu shortcut. Unpackaged, that is the
// electron.exe shortcut `npm run shortcuts` creates; its implicit AppUserModelID is the exe path
// (Electron's documented setup for unpackaged apps). Packaged, the installer's Start menu shortcut carries
// the appId as its AppUserModelID, and Electron's own default ("electron.app.<name>") would not match it.
// The zip build has no such shortcut, so it shows no toasts. Set before any window exists.
if (IS_WIN) app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);

const S = {
  win: null,
  settings: null,
  icon: null, // build/icon.png
  shot: false,
  quitting: false,
  dialogs: null, // latest Telegram dialogs: chat names for the toasts
  agents: {}, // latest relay agents: which bot belongs to which agent
  live: new Map(), // session id -> running (and not stale), to spot a session that just finished
  avatars: {}, // chat key ("group" for the forum group) -> data: URL
  summary: { running: 0, subs: 0, unread: 0, pending: 0, offline: true }, // from the renderer
  hidden: false, // G2: this run started at login straight into the tray (window not shown)
  autostart: null, // G2: the login-start state last read from the OS
};
let notifier = null;
let pet = null;
let petFeed = null;
let tray = null;
let updates = null;
const icons = new Map(); // chat key -> {url, img}

const flags = () => (S.settings ? S.settings.data.desktop : {});
const toRenderer = (msg) => S.win && !S.win.isDestroyed() && S.win.webContents.send("desktop", msg);
const inFront = () => !!(S.win && !S.win.isDestroyed() && S.win.isVisible() && !S.win.isMinimized() && S.win.isFocused());
const isLive = (s) => s.state === "running" && !s.stale;
const count = (v) => Math.max(0, Math.min(99999, Math.floor(Number(v)) || 0));

function showDeck(key) {
  const w = S.win;
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  if (key && KEY_RE.test(key)) toRenderer({ t: "select", key });
}

/** Brings the deck forward at a Settings section (a toast about updates opens Settings > General). */
function openSettings(section) {
  showDeck(null);
  toRenderer({ t: "settings-open", section: typeof section === "string" ? section : "general" });
}

// --- names and avatars for the toasts --------------------------------------------------------------
function agentOfBot(bot) {
  const u = bot && bot.username ? bot.username.toLowerCase() : null;
  return u ? Object.values(S.agents).find((a) => a && a.bot && a.bot.toLowerCase() === u) || null : null;
}

/** DM: the agent's name (the bot's when the relay does not know it); topic: "# title". */
function chatTitle(key) {
  const d = S.dialogs;
  if (!d || !key) return null;
  if (key[0] === "u") {
    const bot = (d.bots || []).find((b) => b.key === key);
    if (!bot) return null;
    const a = agentOfBot(bot);
    return (a && a.name) || bot.title || (bot.username ? `@${bot.username}` : null);
  }
  const t = (d.topics || []).find((x) => x.key === key);
  return t ? `# ${t.title}` : null;
}

/** The chat a finished session belongs to: its group topic, else the agent's bot DM. */
function sessionKey(s) {
  const d = S.dialogs;
  if (!d) return null;
  if (s.thread && d.group && String(s.chat) === String(d.group.id)) return `t${String(s.thread).replace(/^t/, "")}`;
  const a = S.agents[s.agent];
  const bot = a && a.bot ? (d.bots || []).find((b) => b.username && b.username.toLowerCase() === a.bot.toLowerCase()) : null;
  return bot ? bot.key : null;
}

function avatarIcon(key) {
  if (!key) return undefined;
  const url = S.avatars[key[0] === "t" ? "group" : key];
  if (!url) return undefined;
  let c = icons.get(key);
  if (!c || c.url !== url) {
    c = { url, img: nativeImage.createFromDataURL(url) };
    icons.set(key, c);
  }
  return c.img.isEmpty() ? undefined : c.img;
}

// --- the status pet's events (A10) ------------------------------------------------------------------
/** Who a chat (and a message in it) belongs to, for the pet: the agent's name and avatar (a data: URL). */
function petWho(key, m) {
  if (key && key[0] === "t") {
    const bot = m && m.fromId ? `u${m.fromId}` : null; // a bot in the group: its DM avatar, when the deck lists that bot
    return { agent: (m && m.from) || chatTitle(key) || "Hermes", avatar: (bot && S.avatars[bot]) || S.avatars.group };
  }
  return { agent: chatTitle(key) || "Hermes", avatar: key ? S.avatars[key] : undefined };
}

/** A pet event goes to the pet; its agent becomes the one the Ajan skin shows. */
function petEvent(ev) {
  if (!pet) return;
  pet.event(ev);
  if (ev.agent) pet.setAgent({ name: ev.agent, avatar: ev.avatar });
}

// --- what main sends the renderer, seen on its way --------------------------------------------------
function observe(ch, msg) {
  if (!notifier || !msg || typeof msg !== "object") return;
  try {
    if (ch === "tg") fromTelegram(msg);
    else if (ch === "relay") fromRelay(msg);
    else if (ch === "bridge") fromBridge(msg);
  } catch (e) {
    console.error(`desktop: ${e.message}`); // a notification problem never breaks the deck's own feed
  }
}

function fromTelegram(m) {
  if (m.t === "dialogs") S.dialogs = m;
  else if (m.t === "avatar" && typeof m.key === "string") S.avatars[m.key] = m.url;
  else if (m.t === "msg") {
    notifier.message(m.m);
    petFeed.message(m.m); // the pet hops and says who replied
  } else if (m.t === "edit") {
    notifier.edit(m.m);
    petFeed.edit(m.m);
  }
}

function fromRelay(m) {
  if (m.t === "hello" && updates) updates.available(m.v);
  if (m.agents && typeof m.agents === "object") S.agents = m.agents;
  if (m.t === "snapshot") {
    S.live = new Map((m.sessions || []).map((s) => [s.sid, isLive(s)]));
    return;
  }
  if (m.t !== "evs") return;
  for (const s of m.sessions || []) {
    const was = S.live.get(s.sid);
    const now = isLive(s);
    S.live.delete(s.sid); // re-insert: the map stays in last-seen order, so trimming drops the oldest
    S.live.set(s.sid, now);
    // a top-level session that stopped running. Not: a sub-agent, a cron job (its result arrives as a
    // message), a context-compression hand-over to a new session id, or a session that only went quiet.
    if (was && !now && !s.parent && !s.cron && !s.splitInto && !s.stale) sessionDone(s);
    // the pet's Ajan skin shows the agent that started working last
    if (!was && now && !s.parent && s.agent && pet) pet.setAgent({ name: s.agent, avatar: petWho(sessionKey(s)).avatar });
  }
  while (S.live.size > 3000) S.live.delete(S.live.keys().next().value);
}

// bridge: an approval or a question that waits for the user. One toast per request, never repeated.
const asked = new Set();
function fromBridge(m) {
  if (m.t !== "requests" || !Array.isArray(m.list)) return;
  const open = new Set();
  for (const r of m.list) {
    if (!r || typeof r.id !== "string") continue;
    open.add(r.id);
    if (asked.has(r.id)) continue;
    asked.add(r.id);
    const q = r.kind === "question" && Array.isArray(r.questions) && r.questions[0] ? r.questions[0].question : "";
    notifier.notify(r.kind === "approval" ? "approval" : "question", {
      title: r.kind === "approval" ? i18nText("U0216") : i18nText("A0138"),
      body: clip(r.kind === "approval" ? r.description || r.command : q, 120),
      key: typeof r.sid === "string" && r.sid ? `hs:${r.sid}` : null,
    });
    petFeed.ask(r); // the pet shakes and asks too
  }
  for (const id of asked) if (!open.has(id)) asked.delete(id); // answered or gone: forget it
}

function sessionDone(s) {
  const key = sessionKey(s);
  const topic = key && key[0] === "t" ? chatTitle(key) : null;
  const verb = s.state === "failed" ? i18nText("A0139") : s.state === "stopped" ? i18nText("A0140") : i18nText("U0217");
  notifier.finished({
    key,
    title: topic ? `${s.agent} · ${topic}` : s.agent || "Hermes",
    body: s.lastMsg ? `${verb}: ${clip(s.lastMsg, 90)}` : verb,
    icon: avatarIcon(key),
  });
  petFeed.done({ agent: s.agent, key, state: s.state, avatar: petWho(key).avatar }); // a happy hop when it went well
}

// --- taskbar badge ----------------------------------------------------------------------------------
// How many chats wait for the user (new replies + questions) on the app's taskbar button: Windows overlays a small
// disc with the number on the icon, macOS and Linux show the count as the dock/launcher badge. A count that grows
// while the deck is in the background also flashes the taskbar button (macOS: one dock bounce) when
// notifications are on. Settings > Desktop > "Badge on the taskbar icon".
const badge = { text: null, count: 0, attention: null, seen: false }; // seen: the first summary came (no flash for it)

function applyBadge() {
  if (S.shot || !S.win || S.win.isDestroyed()) return;
  const on = flags().taskbarBadge !== false;
  const count = on ? badgeCount(S.summary) : 0;
  const text = on ? badgeText(S.summary) : "";
  const grew = badge.seen && count > badge.count; // the counts at start-up are not news
  badge.count = count;
  if (grew && !inFront() && flags().notifications) {
    if (IS_WIN) S.win.flashFrame(true); // stops when the window is focused (focus handler below)
    else if (process.platform === "darwin" && app.dock) badge.attention = app.dock.bounce("informational");
  }
  if (text === badge.text) return;
  badge.text = text;
  try {
    if (IS_WIN) S.win.setOverlayIcon(text ? nativeImage.createFromBuffer(badgePng(text)) : null, text ? i18nText("set.badgeTip", { count }) : "");
    else app.setBadgeCount(count);
  } catch (e) {
    console.error(`taskbar badge: ${e.message}`); // a desktop without badges: the tray and the pet still show it
  }
}

function clearAttention() {
  if (IS_WIN && S.win && !S.win.isDestroyed()) S.win.flashFrame(false);
  if (badge.attention !== null && app.dock) app.dock.cancelBounce(badge.attention);
  badge.attention = null;
}

// --- settings ---------------------------------------------------------------------------------------
function setFlag(name, on) {
  S.settings.update({ desktop: { [name]: !!on } });
  applySettings();
  toRenderer({ t: "settings", settings: S.settings.publicView() }); // the Settings tab shows the change
}

/** Tray "Pet görünümü": Karakter / Küre / Ajan. */
function setSkin(name) {
  if (!PET_SKINS.includes(name)) return;
  S.settings.update({ desktop: { petSkin: name } });
  applySettings();
  toRenderer({ t: "settings", settings: S.settings.publicView() });
}

/** What the pet page follows from Settings → Masaüstü. */
function petOptions() {
  const f = flags();
  return { skin: f.petSkin, motion: f.petMotion !== false, bubbles: !!f.notifications, size: f.petSize };
}

function applySettings() {
  if (S.shot || !pet) return;
  const f = flags();
  if (f.pet) pet.show();
  else pet.hide();
  pet.refresh(); // skin, animations, bubbles
  if (tray) {
    tray.update(f);
    tray.status(statusParts(S.summary).map((p) => p.text).join(" · "));
  }
  // G2: only a change of the switch itself touches the OS, so another setting's save never undoes a
  // login item the user turned off in Task Manager meanwhile
  if (!!f.autostart !== S.autostart) syncAutostart(autostart.apply(!!f.autostart));
  applyBadge(); // the badge switch, or notifications (flashing) turned on or off
}

/** G2: the "autostart" flag follows what the OS reports (it can refuse, or be changed outside the deck). */
function syncAutostart(real) {
  S.autostart = real;
  if (!!flags().autostart !== real) S.settings.update({ desktop: { autostart: real } });
}

/**
 * G2, called by main.js before the window exists: a login start with "Kapatınca tepside çalışsın" on
 * opens straight into the tray. init() still shows the window when no tray icon could be made.
 */
function startHidden(settings) {
  S.hidden = !!(settings && settings.data.desktop.closeToTray) && autostart.launchedAtLogin();
  return S.hidden;
}

/** For the Settings pane (main.js sends it with "ready"): build type and whether login start works here. */
function info() {
  return { packaged: app.isPackaged, autostart: autostart.support() };
}

/** Bot screen (main/cua): the tray turns red with a "Durdur" item while an agent may act here. */
function trayAlert(on, alert) {
  if (tray) tray.alert(on, alert);
}

/**
 * Tray "Çıkış" and `--quit`: a real quit, also when closing the window only hides it. app.quit() closes every
 * window (the deck's, the pet's, the bot screen's bar), so the quit never waits on "window-all-closed": an
 * open bar window kept the app alive when only the deck's window was closed. main.js's will-quit cleanup
 * runs either way.
 */
function quit() {
  S.quitting = true;
  app.quit();
}

function cancelQuit() {
  S.quitting = false;
}

function cleanSummary(s) {
  const o = s && typeof s === "object" ? s : {};
  return { running: count(o.running), subs: count(o.subs), unread: count(o.unread), pending: count(o.pending), offline: !!o.offline };
}

// --- setup ------------------------------------------------------------------------------------------
function init({ win, settings, icon, shot }) {
  Object.assign(S, { win, settings, icon, shot: !!shot });
  if (S.shot) return devScroll(win); // screenshot runs: no tray, no pet, no toasts
  notifier = new Notifier({
    enabled: () => !!flags().notifications,
    sound: () => !!flags().sound,
    active: inFront,
    describe: (key) => ({ title: chatTitle(key), icon: avatarIcon(key) }),
    onClick: showDeck,
    chime: (kind) => toRenderer({ t: "chime", kind }),
    icon,
  });
  updates = createUpdateNotice({ file: path.join(app.getPath("userData"), "updates.json"), version: app.getVersion(),
    legacyProfile: settings.data.firstRunDone === true,
    notify: (key, vars) => notifier.notify("update", { title: i18nText("updates.title"), body: i18nText(key, vars), quiet: true }),
  });
  pet = new Pet({
    loadPos: () => flags().petPos || null,
    savePos: (pos) => S.settings.update({ desktop: { petPos: pos } }),
    onOpen: (key) => showDeck(key), // the pet itself: null; a speech bubble: its chat
    onHide: () => setFlag("pet", false),
    options: petOptions,
  });
  // replies, questions and finished runs become pet events; no bubble while the deck is in front
  petFeed = new PetFeed({ emit: petEvent, describe: petWho, textOf, quiet: inFront });
  try {
    tray = new DeckTray({ icon, onShow: () => showDeck(null), onToggle: setFlag, onSkin: setSkin, onQuit: quit });
    tray.status(statusParts(S.summary).map((p) => p.text).join(" · "));
  } catch (e) {
    console.error(`tray: ${e.message}`); // no tray on this desktop: closing the window quits, as before
    tray = null;
  }
  if (S.hidden && !tray) win.show(); // G2: a login start never stays invisible without a tray icon

  win.on("focus", () => {
    notifier.clear();
    clearAttention();
  });
  let trayHinted = false; // once per run: say where the deck went
  win.on("close", (e) => {
    if (S.quitting || !tray || !flags().closeToTray) return;
    e.preventDefault();
    win.hide();
    if (trayHinted) return;
    trayHinted = true;
    notifier.notify("info", { title: i18nText("U0218"), body: i18nText("U0219"), quiet: true });
  });
  win.on("closed", () => {
    // the deck itself is gone: the pet and the tray icon go too, so the app quits as before
    if (petFeed) petFeed.stop();
    if (pet) pet.hide();
    if (tray) tray.destroy();
    tray = null;
  });
  if (IS_WIN) for (const ev of ["query-session-end", "session-end"]) win.on(ev, () => (S.quitting = true)); // never hold up a logoff
  app.on("before-quit", () => (S.quitting = true));
  app.on("activate", () => showDeck(null)); // macOS: dock click while the window is hidden
  if (IS_WIN && typeof Notification.handleActivation === "function") Notification.handleActivation(() => showDeck(null));

  ipcMain.on("desktop:pet-state", (e, s) => {
    if (win.isDestroyed() || e.sender !== win.webContents) return;
    S.summary = cleanSummary(s);
    pet.setState(S.summary);
    if (tray) tray.status(statusParts(S.summary).map((p) => p.text).join(" · "));
    applyBadge();
    badge.seen = true;
  });
  ipcMain.handle("desktop:test", (e) => {
    if (win.isDestroyed() || e.sender !== win.webContents) return "error";
    if (!Notification.isSupported()) return "unsupported";
    notifier.notify("test", { title: "Hermes Deck", body: i18nText("U0220"), force: true });
    return "ok";
  });
  syncAutostart(autostart.state()); // G2: the switch shows the real OS state on every start
  applySettings();
}

/** Entry point for other features; see the header. Returns the Notification or null. */
function notify(kind, payload) {
  return notifier ? notifier.notify(kind, payload) : null;
}

// --- dev screenshots -----------------------------------------------------------------------------------
const PET_STATES = {
  idle: { running: 0, subs: 0, unread: 0, pending: 0, offline: false },
  working: { running: 2, subs: 3, unread: 0, pending: 0, offline: false },
  reply: { running: 1, subs: 0, unread: 76, pending: 0, offline: false },
  waiting: { running: 0, subs: 1, unread: 4, pending: 1, offline: false },
  offline: { running: 0, subs: 0, unread: 0, pending: 0, offline: true },
};
PET_STATES.replies = PET_STATES.reply; // the old name
const PET_EVENTS = {
  reply: { kind: "reply", snippet: "Rapor hazır: üç kaynağı taradım, özeti ve bağlantıları ekledim." },
  ask: { kind: "ask", snippet: "Değişiklikleri main dalına göndermemi onaylıyor musun?" },
  done: { kind: "done", get snippet() { return i18nText("U0217"); } },
};

/**
 * --shot-pet=<png> draws only the pet, in a window that is never shown, and quits. Returns false when the flag
 * is absent. Options:
 *   --pet-skin=<id> (pets/catalog.js)  --pet-state=idle|working|reply|waiting|offline (replies = reply)
 *   --pet-from=<state>                 start there, then change to --pet-state: records the transition
 *   --pet-event=reply|ask|done         play an event after the first render (bubble included)
 *   --pet-frames=<n> [--pet-interval=ms]  a strip of n captures over time (default with --pet-from: 24 x 100 ms)
 *   --theme=basalt|marble|aegean       the colour theme of the bar and bubble
 *   --pet-size=0.75|1|1.25|1.5         the pet size (Settings > Desktop)
 *   --pet-motion=off  --pet-side=left|right  --pet-open | --pet-hover  --pet-bg=#rrggbb  --wait=ms
 *   --pet-agent=<name> [--pet-avatar]  the Ajan skin's agent (--pet-avatar: the app icon as its avatar)
 *   --pet-cpu=<seconds> [--pet-cpu-live [--pet-cpu-paused]]  measure CPU instead (hidden pet; live = kept drawing),
 *                                      the JSON result goes to the --shot-pet file
 */
function shotPet() {
  const file = arg("shot-pet");
  if (!file) return false;
  const out = typeof file === "string" ? path.resolve(file) : path.join(app.getPath("temp"), "hermes-deck-pet.png");
  const pick = (name, fallback) => PET_STATES[arg(name)] || fallback;
  const skin = PET_SKINS.includes(arg("pet-skin")) ? arg("pet-skin") : "character";
  if (typeof arg("theme") === "string") require("./theme").setChoice(arg("theme")); // --theme=marble|aegean|basalt
  const options = { skin, motion: arg("pet-motion") !== "off", bubbles: true, size: Number(arg("pet-size")) || 1 };
  const agentName = typeof arg("pet-agent") === "string" ? arg("pet-agent").slice(0, 40) : "Hermes";
  let avatar;
  if (arg("pet-avatar")) avatar = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, "..", "build", "icon.png")).toString("base64")}`;
  const agent = { name: agentName, avatar };
  const done = (msg) => {
    console.log(msg);
    app.quit();
  };
  const fail = (e) => {
    console.error(`pet screenshot failed: ${e.message}`);
    app.exit(1);
  };
  if (arg("pet-cpu")) {
    new Pet()
      .measure({ seconds: Math.max(5, Number(arg("pet-cpu")) || 30), state: pick("pet-state", PET_STATES.idle), options, live: !!arg("pet-cpu-live"), pause: !arg("pet-cpu-live") || !!arg("pet-cpu-paused") })
      .then((r) => {
        fs.writeFileSync(out, JSON.stringify(r, null, 2));
        done(`pet cpu: ${JSON.stringify(r)}`);
      })
      .catch(fail);
    return true;
  }
  const from = arg("pet-from") ? pick("pet-from", null) : null;
  const ev = PET_EVENTS[arg("pet-event")] ? { ...PET_EVENTS[arg("pet-event")], agent: agentName, avatar, key: null } : null;
  const frames = Math.min(64, Math.max(1, Number(arg("pet-frames")) || (from ? 24 : 1)));
  const bg = typeof arg("pet-bg") === "string" && /^#[0-9a-f]{3,8}$/i.test(arg("pet-bg")) ? arg("pet-bg") : null;
  new Pet()
    .capture({
      state: pick("pet-state", PET_STATES.working),
      from,
      event: ev,
      agent,
      options,
      side: arg("pet-side") === "left" ? "left" : "right",
      open: !!arg("pet-open"),
      hover: !!arg("pet-hover"),
      bg,
      file: out,
      wait: Number(arg("wait")) || 1500,
      frames,
      interval: Math.max(30, Number(arg("pet-interval")) || 100),
    })
    .then((f) => done(`pet screenshot: ${f}`))
    .catch(fail);
  return true;
}

/** --shot with --shot-scroll=<css selector>: scroll that element into view before the capture. */
function devScroll(win) {
  const sel = arg("shot-scroll");
  if (typeof sel !== "string") return;
  const js = `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.scrollIntoView({ block: "start" }); })()`;
  win.webContents.once("did-finish-load", () => setTimeout(() => win.webContents.executeJavaScript(js).catch(() => {}), 2500));
}

module.exports = { observe, init, applySettings, notify, quit, cancelQuit, shotPet, startHidden, info, trayAlert, openSettings };
