"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
// User settings, kept in Electron's userData folder (never in the app directory, so nothing personal
// ships with the code). Secret fields are encrypted with safeStorage (DPAPI on Windows, Keychain on
// macOS); the renderer only ever sees whether a secret is set, never its value.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, safeStorage } = require("electron");
const { loadEnvFile } = require("./envfile");
const { normalizeConfig: normalizeBridge } = require("./bridge");
const { validFolderSetting } = require("./hermes-files");
const wallpaper = require("./wallpaper");

const DEFAULTS = {
  relay: { url: "", token: "" }, // url: ws://<private-ip>:9330
  telegram: { apiId: "", apiHash: "" },
  groupChatId: "", // optional: a forum supergroup whose topics are listed under the agents
  hiddenBots: ["BotFather"],
  readReceipts: true, // C5: chats looked at in the Deck are marked read on Telegram too (off: unread is tracked locally only)
  // desktop shell (main/desktop.js): notifications, chime, status pet, close-to-tray; petPos = the pet's
  // last screen position (DIP), kept here so it survives restarts. autostart (G2) mirrors the OS login
  // item: desktop.js re-reads the real state on every start (main/autostart.js). petSkin: the pet's look
  // (character = Character, orb = Orb, agent = Agent); petMotion: its animations (off = stills).
  desktop: { notifications: true, sound: true, pet: true, closeToTray: true, autostart: false, petPos: null, petSkin: "character", petMotion: true, petSize: 1, taskbarBadge: true },
  // direct connection to a Hermes host's stream.py (no secrets: SSH keys stay in the user's ~/.ssh)
  bridge: { mode: "off", target: "", python: "", stream: "~/.hermes/hermes-deck/stream.py", distribution: "" },
  // downloads of files a Hermes agent offered (main/hermes-files.js): dir = a folder the owner picked ("" = the OS
  // Downloads folder + "Hermes Deck"); ask = show a Save As dialog for every file instead
  downloads: { dir: "", ask: false },
  chatChannel: "telegram", // compatibility alias for older callers
  chat: { modes: ["telegram", "sessions", "bots"], defaultMode: "telegram" },
  firstRunDone: false,
  language: "en",
  theme: "basalt", // Settings > Appearance: basalt | marble | aegean | system (main/theme.js)
  // chat backgrounds (main/wallpaper.js), one per chat mode: stored file name ("" = none), % of ground over it
  wallpaper: { telegram: { file: "", dim: 55 }, sessions: { file: "", dim: 55 }, bots: { file: "", dim: 55 } },
  // bot screen (main/cua): agents (profiles) allowed to act on this computer's desktop, and this device's
  // key for the relay's driver channel. The on/off switch itself is presence's "desktop" hosting switch.
  botscreen: { agents: [], deviceToken: "" },
  // composer: what Enter does while the agent is busy with a turn. queue = the message waits in the outbox
  // (its bubble keeps "Send now"); steer = it is injected into the running turn.
  composer: { busySend: "queue" },
  // reading: how agent messages read (renderer/reading.js): plain or a quiet bubble, the message font and text size
  reading: { agentMessages: "plain", font: "newsreader", size: 17 },
  // agent spaces (main/spaces.js): the control level the Bot screen opens the agents' desktop with
  spaces: { defaultLevel: "watch" },
  // agent spaces phase 2 (main/desktops.js): this computer hosts agents' own desktops in Docker. host is the user's
  // switch (off on a new install; it changes only through the desktops:host IPC, after the consent sheet); the rest
  // are this computer's limits for them. homeWarnGB is a warning in Settings, not a cap (volumes have none).
  desktops: { host: false, limit: 3, memory: "1.5g", cpus: 2, idleMin: 20, homeWarnGB: 10 },
  // updates (main/update-check.js): auto = check on start and every 6 h; repo/branch override the build's own
  // ("" = where it was built from, main); token: a GitHub token when neither GH_TOKEN nor the gh CLI has one
  updates: { auto: true, repo: "", branch: "main", token: "", fromSource: false },
};
const BUSY_SEND = ["queue", "steer"];
const READING = { agentMessages: ["plain", "bubble"], font: ["newsreader", "geist", "atkinson"] };
const readingSize = (v) => Number.isInteger(v) && v >= 14 && v <= 20;
/** A complete, valid reading preference from anything stored (unknown values fall back to the defaults). */
function normalizeReading(r) {
  const x = r && typeof r === "object" && !Array.isArray(r) ? r : {};
  return {
    agentMessages: READING.agentMessages.includes(x.agentMessages) ? x.agentMessages : "plain",
    font: READING.font.includes(x.font) ? x.font : "newsreader",
    size: readingSize(x.size) ? x.size : 17,
  };
}
/** A reading patch is valid when it is an object of known keys with allowed values (checked before any change). */
function readingPatchOk(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return false;
  for (const [k, v] of Object.entries(r)) {
    if (k === "size") { if (!readingSize(v)) return false; }
    else if (!READING[k] || !READING[k].includes(v)) return false;
  }
  return true;
}
const SPACE_LEVELS = ["watch", "together", "full"]; // agent spaces: main/space-view-logic.js LEVELS
// agent desktops (main/desktops.js): each field's rule. memory is Docker's --memory in gigabytes ("1.5g").
const intIn = (lo, hi) => (v) => Number.isInteger(v) && v >= lo && v <= hi;
const DESKTOP_RULES = {
  limit: intIn(0, 16),
  memory: (v) => typeof v === "string" && /^\d+(\.\d+)?g$/.test(v) && Number(v.slice(0, -1)) >= 0.5 && Number(v.slice(0, -1)) <= 8,
  cpus: intIn(1, 8),
  idleMin: intIn(5, 240),
  homeWarnGB: intIn(1, 1000),
};
/** A saved desktops object, field by field: anything invalid falls back to its default; host is true only if true. */
function normalizeDesktops(v) {
  const o = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  const out = { host: o.host === true };
  for (const [k, ok] of Object.entries(DESKTOP_RULES)) out[k] = ok(o[k]) ? o[k] : DEFAULTS.desktops[k];
  return out;
}
const DESKTOP_FLAGS = ["notifications", "sound", "pet", "closeToTray", "autostart", "petMotion", "taskbarBadge"];
const PET_SKINS = require("../renderer/pets/catalog").IDS;
const PET_SIZES = [0.75, 1, 1.25, 1.5]; // Small / Medium / Large / Extra large (pet-model.js scales by it)
const THEMES = ["basalt", "marble", "aegean", "system"];
const CHAT_CHANNELS = ["telegram", "hermes"];
const CHAT_MODES = ["telegram", "sessions", "bots"];
function validateChat(chat) {
  if (!chat || !Array.isArray(chat.modes) || !chat.modes.length ||
      chat.modes.some((v) => !CHAT_MODES.includes(v)) || new Set(chat.modes).size !== chat.modes.length) {
    throw new Error(i18nText("chat.validModes"));
  }
  if (!chat.modes.includes(chat.defaultMode)) throw new Error(i18nText("chat.enabledDefault"));
  return { modes: CHAT_MODES.filter((v) => chat.modes.includes(v)), defaultMode: chat.defaultMode };
}
const SECRETS = [
  ["relay", "token"],
  ["telegram", "apiHash"],
  ["botscreen", "deviceToken"],
  ["updates", "token"],
];
const PROFILE_RE = /^[A-Za-z0-9._-]{1,64}$/;

const clone = (x) => JSON.parse(JSON.stringify(x));

class Settings {
  constructor() {
    this.file = path.join(app.getPath("userData"), "settings.json");
    this.data = clone(DEFAULTS);
    this.plainSecrets = false;
    this.unreadableSecrets = {};
  }

  canEncrypt() {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /**
   * True when the saved secrets are effectively readable by anyone who can read settings.json: no encryption
   * at all, or Linux's "basic_text" backend (no keyring: safeStorage still "encrypts", with a fixed key).
   * The renderer then shows its warning (security audit L1).
   */
  weakStorage() {
    if (!this.canEncrypt()) return true;
    try {
      return process.platform === "linux" && typeof safeStorage.getSelectedStorageBackend === "function" && safeStorage.getSelectedStorageBackend() === "basic_text";
    } catch {
      return false;
    }
  }

  load() {
    this.unreadableSecrets = {};
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      raw = null;
    }
    if (!raw) {
      this.data = this._fromLegacy();
      this.data.firstRunDone = this._configuredProfile();
      if (this.data.firstRunDone) this.save();
      return this;
    }
    const d = clone(DEFAULTS);
    for (const [k, v] of Object.entries(raw)) if (k in d) d[k] = typeof d[k] === "object" && !Array.isArray(d[k]) ? { ...d[k], ...v } : v;
    // diagnostics only (never the values): how each secret loaded
    let st = null;
    try {
      st = fs.statSync(this.file);
    } catch {}
    this.loadTrace = { file: this.file, at: new Date().toISOString(), size: st && st.size, mtime: st && st.mtime, rawBotscreen: raw.botscreen && typeof raw.botscreen === "object" ? Object.keys(raw.botscreen) : typeof raw.botscreen, rawKeys: Object.keys(raw), secrets: {} };
    for (const [sec, key] of SECRETS) {
      const v = d[sec][key];
      const tr = (this.loadTrace.secrets[`${sec}.${key}`] = { stored: v && typeof v === "object" ? (v.enc ? "enc" : v.plain !== undefined ? "plain" : "object") : typeof v });
      if (v && typeof v === "object" && v.enc) {
        try {
          d[sec][key] = safeStorage.decryptString(Buffer.from(v.enc, "base64"));
          tr.len = d[sec][key].length;
        } catch (e) {
          tr.error = String((e && e.message) || e).slice(0, 160);
          this.unreadableSecrets[`${sec}.${key}`] = v;
          d[sec][key] = ""; // fail closed, but keep ciphertext for the next save/restart
        }
      } else if (v && typeof v === "object" && v.plain !== undefined) {
        d[sec][key] = String(v.plain);
      }
    }
    this.data = d;
    if (!raw.chat) d.chat.defaultMode = d.chatChannel === "hermes" ? "sessions" : "telegram";
    try { d.chat = validateChat(d.chat); } catch { d.chat = clone(DEFAULTS.chat); }
    d.chatChannel = d.chat.defaultMode === "telegram" ? "telegram" : "hermes";
    if (typeof raw.firstRunDone !== "boolean") d.firstRunDone = this._configuredProfile();
    if (!["en", "tr"].includes(d.language)) d.language = DEFAULTS.language;
    if (!THEMES.includes(d.theme)) d.theme = DEFAULTS.theme;
    d.wallpaper = wallpaper.normalize(d.wallpaper);
    if (!PET_SIZES.includes(d.desktop.petSize)) d.desktop.petSize = DEFAULTS.desktop.petSize;
    if (!d.composer || !BUSY_SEND.includes(d.composer.busySend)) d.composer = clone(DEFAULTS.composer);
    d.reading = normalizeReading(raw.reading);
    if (!d.spaces || !SPACE_LEVELS.includes(d.spaces.defaultLevel)) d.spaces = clone(DEFAULTS.spaces);
    d.desktops = normalizeDesktops(raw.desktops);
    return this;
  }

  _configuredProfile() {
    return this.isConfigured() || !!this.data.telegram.apiId || this.data.bridge.mode !== "off";
  }

  save() {
    const out = clone(this.data);
    const enc = this.canEncrypt();
    this.plainSecrets = !enc;
    for (const [sec, key] of SECRETS) {
      const v = out[sec][key];
      if (!v) {
        if (this.unreadableSecrets[`${sec}.${key}`]) out[sec][key] = this.unreadableSecrets[`${sec}.${key}`];
        continue;
      }
      out[sec][key] = enc ? { enc: safeStorage.encryptString(v).toString("base64") } : { plain: v };
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    for (const [sec, key] of SECRETS) if (this.data[sec][key]) delete this.unreadableSecrets[`${sec}.${key}`];
  }

  isConfigured() {
    return !!(this.data.relay.url && this.data.relay.token);
  }

  hasTelegramKeys() {
    return !!(Number(this.data.telegram.apiId) && this.data.telegram.apiHash);
  }

  /** What the renderer may see. */
  publicView() {
    const d = this.data;
    return {
      relay: { url: d.relay.url, hasToken: !!d.relay.token },
      telegram: { apiId: d.telegram.apiId, hasApiHash: !!d.telegram.apiHash },
      groupChatId: d.groupChatId,
      hiddenBots: d.hiddenBots,
      readReceipts: d.readReceipts !== false,
      downloads: { dir: typeof d.downloads.dir === "string" ? d.downloads.dir : "", ask: d.downloads.ask === true },
      desktop: { ...Object.fromEntries(DESKTOP_FLAGS.map((k) => [k, !!d.desktop[k]])), petSkin: PET_SKINS.includes(d.desktop.petSkin) ? d.desktop.petSkin : "character", petSize: PET_SIZES.includes(d.desktop.petSize) ? d.desktop.petSize : 1 },
      bridge: { ...d.bridge },
      chatChannel: d.chatChannel,
      chat: clone(d.chat),
      firstRunDone: d.firstRunDone,
      language: d.language,
      theme: THEMES.includes(d.theme) ? d.theme : "basalt",
      updates: { auto: d.updates.auto !== false, repo: d.updates.repo || "", branch: d.updates.branch || "main", hasToken: !!d.updates.token, fromSource: d.updates.fromSource === true },
      wallpaper: wallpaper.normalize(d.wallpaper),
      composer: { busySend: BUSY_SEND.includes(d.composer && d.composer.busySend) ? d.composer.busySend : "queue" },
      reading: normalizeReading(d.reading),
      spaces: { defaultLevel: SPACE_LEVELS.includes(d.spaces && d.spaces.defaultLevel) ? d.spaces.defaultLevel : "watch" },
      desktops: normalizeDesktops(d.desktops),
      botscreen: { agents: Array.isArray(d.botscreen.agents) ? [...d.botscreen.agents] : [], hasDeviceToken: !!d.botscreen.deviceToken, deviceKeyUnreadable: !!this.unreadableSecrets["botscreen.deviceToken"] },
      plainSecrets: this.plainSecrets || this.weakStorage(),
    };
  }

  /** A chat mode's wallpaper (a stored name, "preset:<id>", or "" = none); only the wallpaper:* IPC handlers call this. */
  setWallpaperFile(mode, name) {
    if (!wallpaper.MODES.includes(mode)) throw new Error(i18nText("wall.badDim"));
    const w = wallpaper.normalize(this.data.wallpaper);
    w[mode] = { ...w[mode], file: wallpaper.valid(name) ? name : "" };
    this.data.wallpaper = w;
    this.save();
  }

  /**
   * Bot screen settings, changed only through main/cua (never through the generic settings:save, and
   * never from the relay). agents: profiles allowed to act on this desktop; deviceToken: empty keeps it.
   */
  updateBotscreen(patch) {
    const b = this.data.botscreen;
    if (patch.agents !== undefined) {
      if (!Array.isArray(patch.agents)) throw new Error(i18nText("U0289"));
      b.agents = [...new Set(patch.agents.map((p) => String(p)).filter((p) => PROFILE_RE.test(p)))].slice(0, 50);
    }
    if (typeof patch.deviceToken === "string" && patch.deviceToken.trim()) {
      const t = patch.deviceToken.trim();
      if (t.length < 16 || t.length > 512 || /\s/.test(t)) throw new Error(i18nText("U0290"));
      b.deviceToken = t;
    }
    this.save();
  }

  /**
   * "Host agent desktops on this device": changed only by the desktops:host IPC (main/desktops.js), which the renderer
   * calls after its consent sheet. Never through the generic settings:save (update() refuses `host`), never from the relay.
   */
  updateDesktopsHost(on) {
    this.data.desktops = { ...normalizeDesktops(this.data.desktops), host: on === true };
    this.save();
  }

  /** Explicit first-start setup file: the installed app owns encryption of every imported secret. */
  importFile(file) {
    if (!fs.lstatSync(file).isFile()) throw new Error("Setup must be a local JSON file");
    const input = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Setup must be an object");
    const { botscreen, hosting, ...patch } = input;
    if (!this.canEncrypt() || this.weakStorage()) throw new Error("Secure settings storage unavailable");
    if (hosting && (typeof hosting !== "object" || Array.isArray(hosting) || Object.values(hosting).some(v => typeof v !== "boolean"))) throw new Error("Hosting values must be booleans");
    this.update(patch);
    if (botscreen) this.updateBotscreen(botscreen);
    return hosting || null;
  }

  /** Apply a renderer patch; empty secret fields mean "keep the stored value". */
  update(patch) {
    const d = this.data;
    // Validate mode changes before mutating any settings (an invalid patch must not enable a client).
    let chat = patch.chat === undefined ? null : validateChat(patch.chat);
    if (patch.chatChannel !== undefined) {
      if (!CHAT_CHANNELS.includes(patch.chatChannel)) throw new Error(i18nText("U0295"));
      if (!chat) chat = validateChat({ ...d.chat, defaultMode: patch.chatChannel === "telegram" ? "telegram" : d.chat.defaultMode !== "telegram" ? d.chat.defaultMode : d.chat.modes.find((v) => v !== "telegram") });
    }
    if (patch.firstRunDone !== undefined && typeof patch.firstRunDone !== "boolean") throw new Error(i18nText("setup.invalidState"));
    if (patch.language !== undefined && !["en", "tr"].includes(patch.language)) throw new Error(i18nText("settings.invalidLanguage"));
    if (patch.theme !== undefined && !THEMES.includes(patch.theme)) throw new Error(i18nText("settings.invalidTheme"));
    // the generic save only moves a mode's dimming ({wallpaper: {<mode>: {dim}}}); the picture itself changes through
    // wallpaper:pick / wallpaper:clear
    if (patch.updates !== undefined) {
      const u = patch.updates;
      if (!u || typeof u !== "object" || Array.isArray(u) ||
          (u.auto !== undefined && typeof u.auto !== "boolean") ||
          (u.fromSource !== undefined && typeof u.fromSource !== "boolean") ||
          (u.repo !== undefined && !(u.repo === "" || /^[\w.-]+\/[\w.-]+$/.test(u.repo))) ||
          (u.branch !== undefined && !/^[\w./-]{1,100}$/.test(u.branch)) ||
          (u.token !== undefined && u.token !== null && (typeof u.token !== "string" || u.token.length > 400))) throw new Error(i18nText("updates.badSetting"));
    }
    if (patch.wallpaper !== undefined) {
      const w = patch.wallpaper;
      const ok = w && typeof w === "object" && !Array.isArray(w) && Object.keys(w).length > 0 && Object.entries(w).every(([m, v]) =>
        wallpaper.MODES.includes(m) && v && typeof v === "object" && Object.keys(v).join() === "dim" &&
        Number.isInteger(v.dim) && v.dim >= wallpaper.DIM.min && v.dim <= wallpaper.DIM.max);
      if (!ok) throw new Error(i18nText("wall.badDim"));
    }
    if (patch.desktop && patch.desktop.petSize !== undefined && !PET_SIZES.includes(patch.desktop.petSize)) throw new Error(i18nText("settings.invalidPetSize"));
    if (patch.composer !== undefined && (!patch.composer || typeof patch.composer !== "object" || Array.isArray(patch.composer) ||
        (patch.composer.busySend !== undefined && !BUSY_SEND.includes(patch.composer.busySend)))) throw new Error(i18nText("set.busySendInvalid"));
    if (patch.reading !== undefined && !readingPatchOk(patch.reading)) throw new Error(i18nText("set.readingInvalid"));
    if (patch.spaces !== undefined && (!patch.spaces || typeof patch.spaces !== "object" || Array.isArray(patch.spaces) ||
        (patch.spaces.defaultLevel !== undefined && !SPACE_LEVELS.includes(patch.spaces.defaultLevel)))) throw new Error(i18nText("space.levelInvalid"));
    if (patch.desktops !== undefined) {
      const k = patch.desktops;
      // host is not here on purpose: it changes only through updateDesktopsHost (the desktops:host IPC)
      const ok = k && typeof k === "object" && !Array.isArray(k) && Object.keys(k).length > 0 &&
        Object.entries(k).every(([f, v]) => Object.hasOwn(DESKTOP_RULES, f) && DESKTOP_RULES[f](v));
      if (!ok) throw new Error(i18nText("set.desktopsInvalid"));
    }
    if (patch.relay) {
      if (typeof patch.relay.url === "string") d.relay.url = normalizeRelayUrl(patch.relay.url);
      if (typeof patch.relay.token === "string" && patch.relay.token.trim()) d.relay.token = patch.relay.token.trim();
    }
    if (patch.telegram) {
      if (patch.telegram.apiId !== undefined) {
        const id = String(patch.telegram.apiId).trim();
        if (id && !/^\d{3,12}$/.test(id)) throw new Error(i18nText("U0291"));
        d.telegram.apiId = id;
      }
      if (typeof patch.telegram.apiHash === "string" && patch.telegram.apiHash.trim()) {
        const h = patch.telegram.apiHash.trim();
        if (!/^[0-9a-f]{32}$/i.test(h)) throw new Error(i18nText("U0292"));
        d.telegram.apiHash = h;
      }
    }
    if (patch.groupChatId !== undefined) {
      const g = String(patch.groupChatId).trim();
      if (g && !/^-100\d{5,15}$/.test(g)) throw new Error(i18nText("U0293"));
      d.groupChatId = g;
    }
    if (patch.hiddenBots !== undefined) {
      const list = Array.isArray(patch.hiddenBots) ? patch.hiddenBots : String(patch.hiddenBots).split(",");
      d.hiddenBots = list.map((b) => String(b).trim().replace(/^@/, "")).filter(Boolean).slice(0, 50);
    }
    if (typeof patch.readReceipts === "boolean") d.readReceipts = patch.readReceipts;
    if (patch.downloads && typeof patch.downloads === "object") {
      const dl = patch.downloads;
      let dir = d.downloads.dir;
      if (dl.dir !== undefined) {
        // "" / null = back to the default. Anything else must look like an absolute folder path; whether it exists
        // and is writable is checked when a download starts (the folder may be on a drive that is not there today).
        if (dl.dir === "" || dl.dir === null) dir = "";
        else if (validFolderSetting(dl.dir)) dir = dl.dir;
        else throw new Error(i18nText("download.badFolderSetting"));
      }
      if (dl.ask !== undefined && typeof dl.ask !== "boolean") throw new Error(i18nText("download.badFolderSetting"));
      d.downloads = { dir, ask: dl.ask === undefined ? d.downloads.ask : dl.ask };
    }
    if (patch.desktop && typeof patch.desktop === "object") {
      for (const k of DESKTOP_FLAGS) if (typeof patch.desktop[k] === "boolean") d.desktop[k] = patch.desktop[k];
      if (patch.desktop.petSkin !== undefined) {
        if (!PET_SKINS.includes(patch.desktop.petSkin)) throw new Error(i18nText("U0294"));
        d.desktop.petSkin = patch.desktop.petSkin;
      }
      if (patch.desktop.petSize !== undefined) d.desktop.petSize = patch.desktop.petSize;
      const p = patch.desktop.petPos;
      // v: the position format (pet-model.js POS_V); an untagged one is from the 88 px coin and gets migrated
      if (p !== undefined) d.desktop.petPos = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: Math.round(p.x), y: Math.round(p.y), ...(Number.isInteger(p.v) ? { v: p.v } : {}) } : null;
    }
    if (patch.bridge !== undefined) d.bridge = normalizeBridge(patch.bridge); // throws a Turkish message when invalid
    if (chat) {
      d.chat = chat;
      d.chatChannel = chat.defaultMode === "telegram" ? "telegram" : "hermes";
    }
    if (patch.firstRunDone !== undefined) d.firstRunDone = patch.firstRunDone;
    if (patch.language !== undefined) d.language = patch.language;
    if (patch.theme !== undefined) d.theme = patch.theme;
    if (patch.updates !== undefined) {
      const u = patch.updates;
      d.updates = { ...d.updates,
        ...(u.auto !== undefined ? { auto: u.auto } : {}),
        ...(u.fromSource !== undefined ? { fromSource: u.fromSource } : {}),
        ...(u.repo !== undefined ? { repo: u.repo } : {}),
        ...(u.branch !== undefined ? { branch: u.branch } : {}),
        ...(typeof u.token === "string" && u.token.trim() ? { token: u.token.trim() } : {}),
        ...(u.token === null ? { token: "" } : {}) };
    }
    if (patch.wallpaper !== undefined) {
      const w = wallpaper.normalize(d.wallpaper);
      for (const [m, v] of Object.entries(patch.wallpaper)) w[m] = { ...w[m], dim: v.dim };
      d.wallpaper = w;
    }
    if (patch.composer && patch.composer.busySend !== undefined) d.composer = { ...d.composer, busySend: patch.composer.busySend };
    if (patch.reading) d.reading = normalizeReading({ ...d.reading, ...patch.reading });
    if (patch.spaces && patch.spaces.defaultLevel !== undefined) d.spaces = { ...d.spaces, defaultLevel: patch.spaces.defaultLevel };
    if (patch.desktops !== undefined) d.desktops = { ...normalizeDesktops(d.desktops), ...patch.desktops };
    this.save();
  }

  /** First run: pick up values an earlier install kept in ~/.hermes-deck (env files + deck.local.json). */
  _fromLegacy() {
    const d = clone(DEFAULTS);
    const dir = path.join(os.homedir(), ".hermes-deck");
    const env = {};
    const keep = { ...process.env };
    for (const f of ["relay.env", "telegram.env"]) loadEnvFile(path.join(dir, f));
    for (const k of ["DECK_RELAY_HOST", "DECK_RELAY_PORT", "DECK_RELAY_TOKEN", "TG_API_ID", "TG_API_HASH"]) env[k] = process.env[k];
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; // do not leak into the app env
    if (env.DECK_RELAY_HOST && env.DECK_RELAY_TOKEN) {
      d.relay.url = normalizeRelayUrl(`${env.DECK_RELAY_HOST}:${env.DECK_RELAY_PORT || 9330}`);
      d.relay.token = env.DECK_RELAY_TOKEN;
    }
    if (env.TG_API_ID && env.TG_API_HASH) d.telegram = { apiId: String(env.TG_API_ID), apiHash: env.TG_API_HASH };
    try {
      const local = JSON.parse(fs.readFileSync(path.join(dir, "deck.local.json"), "utf8"));
      if (local.hqChatId || local.groupChatId) d.groupChatId = String(local.groupChatId || local.hqChatId);
      if (Array.isArray(local.hiddenBots)) d.hiddenBots = local.hiddenBots;
    } catch {
      /* no local overrides */
    }
    return d;
  }
}

function normalizeRelayUrl(v) {
  let s = String(v || "").trim();
  if (!s) return "";
  if (!/^wss?:\/\//i.test(s)) s = `ws://${s}`;
  const u = new URL(s);
  if (!u.port) u.port = "9330";
  return `${u.protocol}//${u.host}`;
}

module.exports = { Settings, normalizeRelayUrl, PET_SIZES, THEMES, normalizeDesktops };
