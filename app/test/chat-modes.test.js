"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const I18N = require("../renderer/i18n");
const rendererI18n = { DeckI18n: I18N, i18nText: I18N.t, i18nLocale: I18N.getLocale, i18nNode: I18N.node, i18nBind: I18N.bind };
beforeEach(() => I18N.setLanguage("en"));

function settings(raw, secure = false, decryptFails = false) {
  let saved;
  const context = {
    module: { exports: {} }, Buffer, URL, process: { env: {} },
    require: (id) => {
      if (id === "fs") return { readFileSync: () => { if (!raw) throw new Error("missing"); return JSON.stringify(raw); }, lstatSync: () => ({ isFile: () => true }), mkdirSync() {}, writeFileSync: (_p, v) => { saved = JSON.parse(v); }, renameSync() {} };
      if (id === "os") return { homedir: () => "/fixture-home" };
      if (id === "path") return path;
      if (id === "electron") return { app: { getPath: () => "/fixture-profile" }, safeStorage: { isEncryptionAvailable: () => secure, encryptString: value => Buffer.from(value), decryptString: value => { if (decryptFails) throw new Error("key temporarily unavailable"); return value.toString(); } } };
      if (id === "./envfile") return { loadEnvFile() {} };
      if (id === "./bridge") return { normalizeConfig: (v) => v };
      return require(path.join(__dirname, "../main", id));
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../main/settings.js"), "utf8"), context);
  const s = new context.module.exports.Settings().load();
  return { s, saved: () => saved };
}
const plain = (x) => JSON.parse(JSON.stringify(x));

test("unreadable encrypted keys survive unrelated settings changes and can be replaced", () => {
  const raw = { relay: { token: { enc: Buffer.from("fixture-relay").toString("base64") } },
    telegram: { apiHash: { enc: Buffer.from("a".repeat(32)).toString("base64") } },
    botscreen: { deviceToken: { enc: Buffer.from("x".repeat(64)).toString("base64") }, agents: ["default"] } };
  const unreadable = settings(raw, true, true);
  assert.equal(unreadable.s.data.botscreen.deviceToken, "", "unreadable keys are never used as credentials");
  unreadable.s.update({ language: "tr" });
  assert.deepEqual(unreadable.saved().botscreen.deviceToken, raw.botscreen.deviceToken);
  assert.equal(unreadable.s.publicView().botscreen.deviceKeyUnreadable, true);
  assert.deepEqual(unreadable.saved().relay.token, raw.relay.token);
  assert.deepEqual(unreadable.saved().telegram.apiHash, raw.telegram.apiHash);
  const recovered = settings(unreadable.saved(), true);
  assert.equal(recovered.s.data.botscreen.deviceToken, "x".repeat(64));
  unreadable.s.updateBotscreen({ deviceToken: "y".repeat(64) });
  assert.equal(unreadable.s.publicView().botscreen.deviceKeyUnreadable, false);
  assert.equal(settings(unreadable.saved(), true).s.data.botscreen.deviceToken, "y".repeat(64));
});

test("owner setup encrypts device credentials and refuses insecure storage or invalid hosting", () => {
  const setup = { relay: { url: "ws://127.0.0.1:9330", token: "fixture-relay-token" }, botscreen: { agents: ["default"], deviceToken: "x".repeat(64) }, hosting: { browser: true, desktop: true } };
  const secure = settings(setup, true);
  assert.deepEqual(plain(secure.s.importFile("/fixture/setup.json")), setup.hosting);
  assert.ok(secure.saved().relay.token.enc);
  assert.ok(secure.saved().botscreen.deviceToken.enc);
  assert.equal(secure.saved().botscreen.deviceToken.plain, undefined);
  const weak = settings(setup);
  assert.throws(() => weak.s.importFile("/fixture/setup.json"), /Secure settings storage/);
  assert.equal(weak.saved(), undefined);
  const invalid = settings({ ...setup, hosting: { desktop: "yes" } }, true);
  assert.throws(() => invalid.s.importFile("/fixture/setup.json"), /Hosting values/);
  assert.equal(invalid.saved(), undefined);
});

test("chat migration: fresh profiles pick modes first; configured profiles keep their channel", () => {
  const fresh = settings(null).s.publicView();
  assert.deepEqual(plain(fresh.chat), { modes: ["telegram", "sessions", "bots"], defaultMode: "telegram" });
  assert.equal(fresh.firstRunDone, false);
  assert.equal(fresh.language, "en");
  assert.equal(fresh.bridge.stream, "~/.hermes/hermes-deck/stream.py");
  for (const [channel, mode] of [["telegram", "telegram"], ["hermes", "sessions"]]) {
    const existing = settings({ chatChannel: channel, telegram: { apiId: "123456", apiHash: "a".repeat(32) } }).s.publicView();
    assert.equal(existing.chat.defaultMode, mode);
    assert.equal(existing.firstRunDone, true);
  }
});

test("language is validated before saving and survives a restart", () => {
  const { s, saved } = settings(null);
  assert.throws(() => s.update({ language: "unknown", firstRunDone: true }), /Language/);
  assert.equal(s.publicView().firstRunDone, false);
  s.update({ language: "tr" });
  assert.equal(settings(saved()).s.publicView().language, "tr");
  assert.equal(settings({ language: "unknown" }).s.publicView().language, "en");
});

test("composer.busySend defaults to queue, accepts queue|steer, rejects anything else without changing state", () => {
  const { s, saved } = settings(null);
  assert.equal(s.publicView().composer.busySend, "queue");
  for (const bad of [{ busySend: "now" }, { busySend: "" }, { busySend: 1 }, null, "steer", ["steer"]]) {
    const before = plain(s.publicView());
    assert.throws(() => s.update({ composer: bad, language: "tr" }), /queue or steer/);
    assert.deepEqual(plain(s.publicView()), before, "an invalid patch changes nothing, not even its valid parts");
  }
  s.update({ composer: { busySend: "steer" } });
  assert.equal(s.publicView().composer.busySend, "steer");
  assert.equal(saved().composer.busySend, "steer");
  assert.equal(settings(saved()).s.publicView().composer.busySend, "steer", "survives a restart");
  s.update({ composer: {} });
  assert.equal(s.publicView().composer.busySend, "steer", "an empty composer patch keeps the value");
  s.update({ composer: { busySend: "queue" } });
  assert.equal(s.publicView().composer.busySend, "queue");
  for (const raw of [{ composer: { busySend: "bogus" } }, { composer: null }, { composer: "steer" }]) {
    assert.equal(settings(raw).s.publicView().composer.busySend, "queue", `a corrupt file falls back: ${JSON.stringify(raw)}`);
  }
});

test("first run visits every setup step and grants device permissions only on Continue", async () => {
  const src = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
  const start = src.indexOf("  function firstRunForm()");
  const end = src.indexOf("  async function saveChatModes(", start);
  const patches = [];
  const hosting = [];
  const elements = new Map();
  const settingsView = { firstRunDone: false, chat: { modes: ["bots"], defaultMode: "bots" }, relay: { url: "", hasToken: false }, desktop: { pet: true, notifications: true }, language: "en" };
  const ctx = {
    ...rendererI18n,
    firstRunStep: 0, firstRunChat: settingsView.chat, firstRunDevice: null, firstRunDeviceLoading: false, firstRunDeviceAttempted: false, firstRunPrefs: null,
    FIRST_RUN_STEPS: ["chat", "bridge", "relay", "device", "preferences"], CHAT_TEXT: require("../renderer/chat-modes").TEXT,
    S: { settings: settingsView, tg: { status: "disabled" } }, settingsBuilt: false,
    h: (tag, attrs, ...kids) => {
      const el = element(tag, attrs, ...kids);
      el.dataset = {};
      el.prepend = (v) => el.kids.unshift(v);
      if (attrs && attrs.id) elements.set(attrs.id, el);
      return el;
    }, formCard: (title, intro, body, actions) => Object.assign(ctx.h("form", null, title, intro, body, actions), { intro }),
    chatModePicker: () => element("div"), paneHermesSettings: (kids, opts) => { assert.equal(opts.firstRun, true); kids.push(element("div")); },
    draftConfig: () => ({ mode: "local", python: "/fixture-python", stream: "/fixture-stream" }),
    field: (id, label, attrs) => ctx.h("input", { id, ...attrs }), formValues: {},
    cleanErr: String, busy: async (fn) => fn(), mark() {}, els: { msgsInner: { dataset: {} } },
    document: { getElementById: () => ({ value: "" }) },
    CM: require("../renderer/chat-modes"), chatModes: () => settingsView.chat.modes, syncChatMode: (mode) => { ctx.selected = mode; },
    deck: {
      settingsSave: async (patch) => { patches.push(plain(patch)); Object.assign(settingsView, plain(patch)); return settingsView; },
      device: { state: async () => ({ capabilities: ["browser", "desktop"], hosting: { browser: false, desktop: false } }), setHosting: async (cap, on) => hosting.push([cap, on]) },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end), ctx);
  const form = () => vm.runInContext("firstRunForm()", ctx);
  const continueFrom = async (card) => {
    const button = nodes(card).find((el) => el.tag === "button" && el.attrs.class === "btn primary");
    assert.equal(!!button.attrs.disabled, false);
    await button.attrs.onclick();
  };
  for (const step of ["chat", "bridge", "relay"]) {
    const card = form();
    assert.equal(card.dataset.step, step);
    assert.equal(card.intro, null, "self-explanatory steps have no intro paragraph");
    await continueFrom(card);
    assert.equal(settingsView.firstRunDone, false);
  }
  assert.equal(form().dataset.step, "device");
  await new Promise((r) => setImmediate(r));
  const device = form();
  assert.equal(elements.get("f-host-browser").attrs.checked, false);
  assert.equal(elements.get("f-host-desktop").attrs.checked, false);
  assert.deepEqual(hosting, []);
  elements.get("f-host-browser").attrs.onchange({ target: { checked: true } });
  assert.deepEqual(hosting, []);
  await continueFrom(device);
  assert.deepEqual(hosting, [["browser", true], ["desktop", false]]);
  assert.equal(settingsView.firstRunDone, false);
  const preferences = form();
  assert.equal(preferences.dataset.step, "preferences");
  assert.equal(ctx.firstRunPrefs.language, "en");
  elements.get("f-language").attrs.onchange({ target: { value: "tr" } });
  elements.get("f-notifications").attrs.onchange({ target: { checked: false } });
  await continueFrom(preferences);
  assert.equal(settingsView.firstRunDone, true);
  assert.equal(settingsView.language, "tr");
  assert.equal(settingsView.desktop.notifications, false);
  assert.equal(ctx.selected, "bots");
  assert.equal(patches.filter((patch) => patch.firstRunDone === true).length, 1);
});

test("chat settings reject empty, duplicate, unknown and disabled defaults without changing state", () => {
  I18N.setLanguage("tr");
  const { s, saved } = settings(null);
  const before = plain(s.publicView());
  for (const chat of [
    { modes: [], defaultMode: "telegram" },
    { modes: ["bots", "bots"], defaultMode: "bots" },
    { modes: ["unknown"], defaultMode: "unknown" },
    { modes: ["bots"], defaultMode: "telegram" },
    { modes: "bots", defaultMode: "bots" },
  ]) {
    assert.throws(() => s.update({ chat, firstRunDone: true }));
    assert.deepEqual(plain(s.publicView()), before);
  }
  s.update({ chat: { modes: ["bots", "sessions"], defaultMode: "bots" }, firstRunDone: true });
  assert.deepEqual(plain(s.publicView().chat), { modes: ["sessions", "bots"], defaultMode: "bots" });
  assert.equal(saved().chatChannel, "hermes");
  assert.equal(saved().firstRunDone, true);
  assert.equal(settings(saved()).s.publicView().chat.defaultMode, "bots");
  assert.throws(() => s.update({ chatChannel: "telegram" }), /Sohbet/);
  s.update({ chatChannel: "hermes" });
  assert.equal(s.publicView().chat.defaultMode, "bots");
});

test("migration recognizes relay and bridge profiles, but not untouched defaults", () => {
  for (const raw of [{ relay: { url: "ws://fixture.invalid", token: "fixture-token" } }, { bridge: { mode: "ssh" }, chatChannel: "hermes" }]) {
    assert.equal(settings(raw).s.publicView().firstRunDone, true);
  }
  assert.equal(settings({ desktop: { sound: false } }).s.publicView().firstRunDone, false);
  assert.equal(settings({ firstRunDone: false, bridge: { mode: "local" } }).s.publicView().firstRunDone, false);
});

test("mode switch uses enabled order, hides singleton and cycles only enabled modes", () => {
  const C = require("../renderer/chat-modes");
  const chat = { modes: ["bots", "telegram"], defaultMode: "bots" };
  assert.deepEqual(C.enabled(chat), ["telegram", "bots"]);
  assert.equal(C.start(chat), "bots");
  assert.deepEqual(C.switchItems(chat), ["telegram", "bots"]);
  assert.equal(C.next(chat, "bots"), "telegram");
  assert.equal(C.next(chat, "telegram"), "bots");
  assert.deepEqual(C.switchItems({ modes: ["sessions"], defaultMode: "sessions" }), []);
  assert.equal(C.next({ modes: ["sessions"] }, "sessions"), "sessions");
  const all = { modes: ["telegram", "sessions", "bots"], defaultMode: "sessions" };
  assert.deepEqual(C.switchItems(all), ["telegram", "sessions", "bots"]);
  assert.equal(C.start(all), "sessions");
  assert.deepEqual([C.next(all, "telegram"), C.next(all, "sessions"), C.next(all, "bots")], ["sessions", "bots", "telegram"]);
  assert.equal(C.telegramReady({ chat, firstRunDone: false }), false);
  assert.equal(C.telegramReady({ chat, firstRunDone: true }), true);
  assert.equal(C.telegramReady({ chat: { modes: ["sessions", "bots"] }, firstRunDone: true }), false);
});

test("chat mode labels default to English and follow a live language change", () => {
  const C = require("../renderer/chat-modes");
  assert.equal(I18N.getLanguage(), "en");
  assert.deepEqual([C.TEXT.title, C.TEXT.labels.sessions, C.TEXT.labels.bots, C.TEXT.next], ["Chat modes", "Sessions", "Bots", "Continue"]);
  I18N.setLanguage("tr");
  assert.deepEqual([C.TEXT.title, C.TEXT.labels.sessions, C.TEXT.labels.bots, C.TEXT.next], ["Sohbet modları", "Oturumlar", "Botlar", "Devam"]);
  I18N.setLanguage("en");
  assert.deepEqual(C.ORDER, ["telegram", "sessions", "bots"]);
  assert.equal(C.TEXT.labels.sessions, "Sessions");
});

function element(tag, attrs, ...kids) {
  return { tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(Boolean), replaceChildren(...v) { this.kids = v.flat(Infinity); } };
}
const nodes = (el) => [el, ...(el.kids || []).filter((x) => typeof x === "object").flatMap(nodes)];
test("copy diet keeps first-run controls without changing Settings descriptions", () => {
  const C = require("../renderer/chat-modes");
  for (const language of ["en", "tr"]) {
    I18N.setLanguage(language);
    const draft = { modes: ["telegram", "sessions", "bots"], defaultMode: "sessions" };
    const first = nodes(C.editor(element, draft, { firstRun: true }));
    assert.equal(first.filter(n => n.tag === "small").length, 0);
    assert.equal(first.filter(n => n.tag === "input" && n.attrs.type === "checkbox").length, 3);
    assert.equal(first.filter(n => n.tag === "input" && n.attrs.type === "radio").length, 3);
    assert.equal(nodes(C.editor(element, draft)).filter(n => n.tag === "small").length, 3);
  }
});

test("saved configured stream path survives loading and unrelated settings edits", () => {
  const stream = "/opt/hermes-deck/stream.py";
  const { s, saved } = settings({ bridge: { mode: "ssh", target: "fixture-host", python: "/fixture/python", stream } });
  assert.equal(s.publicView().bridge.stream, stream);
  s.update({ language: "tr" });
  assert.equal(saved().bridge.stream, stream);
  assert.equal(settings(saved()).s.publicView().bridge.stream, stream);
});

test("mode editor repairs default, refuses last disable, and renders first-run radios", () => {
  const C = require("../renderer/chat-modes");
  const draft = { modes: ["telegram", "bots"], defaultMode: "telegram" };
  const editor = C.editor(element, draft, { firstRun: true });
  const all = nodes(editor);
  const toggle = (v) => all.find((n) => n.tag === "input" && n.attrs.type === "checkbox" && n.attrs.value === v);
  toggle("telegram").attrs.onchange({ target: { checked: false } });
  assert.deepEqual(draft, { modes: ["bots"], defaultMode: "bots" });
  toggle("bots").attrs.onchange({ target: { checked: false } });
  assert.deepEqual(draft.modes, ["bots"]);
  assert.equal(all.filter((n) => n.tag === "input" && n.attrs.type === "radio").length, 3);
  const settingsEditor = C.editor(element, { modes: ["sessions"], defaultMode: "sessions" });
  assert.equal(nodes(settingsEditor).filter((n) => n.tag === "select").length, 1);
});

test("main never starts Telegram or loads its session for disabled modes or unfinished first run", async () => {
  const src = fs.readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  const fn = src.slice(src.indexOf("async function startTelegram()"), src.indexOf("function cancelLogin"));
  for (const data of [{ chat: { modes: ["bots"] }, firstRunDone: true }, { chat: { modes: ["telegram"] }, firstRunDone: false }]) {
    let status;
    let started = 0;
    const ctx = { settings: { data, hasTelegramKeys: () => true }, SOLO: true, tg: null, tgEpoch: 0, quitAttempt: null,
      telegramReady: require("../renderer/chat-modes").telegramReady,
      setTg: (s) => { status = s; }, cancelLogin() {}, send() {}, FIXTURE: false,
      secret: { loadSession: () => { started++; return "fake-session"; } },
      TelegramService: class { constructor() { started++; } },
    };
    await vm.runInNewContext(`${fn}\nstartTelegram()`, ctx);
    assert.equal(started, 0);
    assert.equal(status.status, "disabled");
  }
});

test("disabled bots mode makes no roster reads and an in-flight roster cannot open a disabled bot", async () => {
  const B = require("../renderer/bots");
  const oldWindow = global.window;
  const oldDocument = global.document;
  global.window = { DeckBotFace: require("../renderer/botface"), DeckI18n: I18N };
  global.document = { addEventListener() {}, hidden: false };
  let active = false;
  let reads = 0;
  let opens = 0;
  let resolve;
  const H = { nodes: new Map(), requests: [], sel: null };
  try {
    const bot = B.create({ h: element, mark() {}, store: { get: () => "bots", set() {} }, H: () => H,
      hermesMode: () => active, bridgeOpen: () => true, cleanErr: String, reselect() {}, renderNote() {},
      hermesOpen: () => { opens++; }, hermesSelect: () => { opens++; },
      deck: { bridge: { profiles: () => { reads++; return new Promise((r) => { resolve = r; }); }, botChat: () => { opens++; return Promise.resolve(null); } } },
    });
    bot.onModeChange();
    assert.equal(reads, 0);
    active = true;
    bot.autoSelect();
    bot.onModeChange();
    assert.equal(reads, 1);
    active = false;
    bot.onModeChange();
    resolve([{ name: "default", meta: {}, hasAvatar: false }]);
    await new Promise((r) => setImmediate(r));
    assert.equal(opens, 0);
  } finally { global.window = oldWindow; global.document = oldDocument; }
});

test("switching to sessions drops a bot draft so disabled bot mode cannot create its chat", () => {
  const src = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
  const fn = src.slice(src.indexOf("  function syncChatMode("), src.indexOf("  function setChatChannel("));
  const H = { sel: "bot:default" };
  const ctx = { ...rendererI18n, H, S: { settings: { chat: { modes: ["sessions"], defaultMode: "sessions" } } },
    RG: { leave() {} }, activeChatMode: "bots",
    CM: require("../renderer/chat-modes"), chatModes: () => ["sessions"],
    BT: { setView() {}, onModeChange() {}, isDraft: (sid) => sid.startsWith("bot:") },
    hermesMode: () => true, hermesAutoSelect: () => { if (!H.sel) H.sel = "fixture-session"; }, hermesPoll() {}, mark() {}, renderNote() {}, refreshSettingsPane() {},
  };
  vm.runInNewContext(`${fn}\nsyncChatMode('sessions');`, ctx);
  assert.equal(H.sel, "fixture-session");
});

test("disabling Telegram cancels a pending connect and its late success cannot reopen the client", async () => {
  const src = fs.readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  const fn = src.slice(src.indexOf("async function startTelegram()"), src.indexOf("function cancelLogin"));
  let resolve;
  let stops = 0;
  const statuses = [];
  const ctx = { tg: null, tgEpoch: 0, quitAttempt: null, SOLO: true, FIXTURE: false, wire() {}, send() {}, cancelLogin() {}, telegramOptions: () => ({}),
    secret: { loadSession: () => "fixture-session" }, telegramReady: require("../renderer/chat-modes").telegramReady,
    settings: { data: { chat: { modes: ["telegram"], defaultMode: "telegram" }, firstRunDone: true }, hasTelegramKeys: () => true },
    setTg: (s) => statuses.push(s.status),
    TelegramService: class { start() { return new Promise((r) => { resolve = r; }); } async stop() { stops++; } meInfo() { return {}; } },
  };
  vm.createContext(ctx);
  const pending = vm.runInContext(`${fn}\nstartTelegram()`, ctx);
  ctx.settings.data.chat = { modes: ["bots"], defaultMode: "bots" };
  await vm.runInContext("startTelegram()", ctx);
  resolve();
  await pending;
  assert.equal(ctx.tg, null);
  assert.ok(stops > 0);
  assert.equal(statuses.at(-1), "disabled");
  assert.equal(statuses.includes("open"), false);
});

test("the direct Hermes channel stages files instead of refusing them or bouncing to Telegram", () => {
  const src = fs.readFileSync(path.join(__dirname, "../renderer/attach.js"), "utf8");
  assert.ok(!/switchToTelegram|refuseInHermes|channelHelp|hermesNote/.test(src), "no Telegram-only refusal bar is left");
  assert.ok(!/dropEffect = hermesMode\(\)/.test(src), "dropping files is allowed in the Hermes channel");
  const canStage = src.slice(src.indexOf("function canStage()"), src.indexOf("async function pick()"));
  assert.match(canStage, /hermesMode\(\)/);
  assert.match(canStage, /ctx\.hermesKey\(\)/);
  assert.ok(!/S\.tg\.status/.test(canStage.slice(0, canStage.indexOf("if (!S.sel"))), "a Hermes chat needs no Telegram connection");
});

test("disabling Telegram during login's disconnect wait cannot start a new client", async () => {
  const src = fs.readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  const fn = src.slice(src.indexOf("function cancelLogin()"), src.indexOf("// --- IPC"));
  let release;
  let clients = 0;
  const ctx = { tgEpoch: 0, login: null, tg: { stop: () => new Promise((r) => { release = r; }) }, wire() {},
    settings: { data: { chat: { modes: ["telegram"] }, firstRunDone: true } },
    telegramReady: require("../renderer/chat-modes").telegramReady, telegramOptions: () => ({}), setTg() {},
    TelegramService: class { constructor() { clients++; } login() { return new Promise(() => {}); } },
  };
  vm.createContext(ctx);
  const pending = vm.runInContext(`${fn}\nstartLogin('+10000000000')`, ctx);
  ctx.settings.data.chat = { modes: ["sessions"], defaultMode: "sessions" };
  vm.runInContext("cancelLogin()", ctx);
  release();
  await pending;
  assert.equal(clients, 0);
  assert.equal(ctx.login, null);
});

test("cancelling a login before the disconnect finishes keeps it cancelled", async () => {
  const src = fs.readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  const fn = src.slice(src.indexOf("function cancelLogin()"), src.indexOf("// --- IPC"));
  let release;
  let clients = 0;
  const ctx = { tgEpoch: 0, login: null, tg: { stop: () => new Promise((r) => { release = r; }) }, wire() {},
    settings: { data: { chat: { modes: ["telegram"] }, firstRunDone: true } },
    telegramReady: require("../renderer/chat-modes").telegramReady, telegramOptions: () => ({}), setTg() {},
    TelegramService: class { constructor() { clients++; } login() { return new Promise(() => {}); } },
  };
  vm.createContext(ctx);
  const pending = vm.runInContext(`${fn}\nstartLogin('+10000000000')`, ctx);
  vm.runInContext("cancelLogin()", ctx);
  release();
  await pending;
  assert.equal(clients, 0);
  assert.equal(ctx.login, null);
});

test("wired Telegram events ignore disabled and superseded clients", () => {
  const { EventEmitter } = require("node:events");
  const src = fs.readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  const fn = src.slice(src.indexOf("function wire(svc)"), src.indexOf("// fixture mode"));
  const svc = new EventEmitter();
  const replacement = new EventEmitter();
  const messages = [];
  const ctx = { tg: svc, login: null, settings: { data: { chat: { modes: ["telegram"] }, firstRunDone: true } },
    telegramReady: require("../renderer/chat-modes").telegramReady, send: (_channel, m) => messages.push(m), svc,
  };
  vm.createContext(ctx);
  vm.runInContext(`${fn}\nwire(svc)`, ctx);
  svc.emit("dialogs", { bots: [] });
  assert.equal(messages.length, 1);
  ctx.settings.data.chat.modes = ["sessions"];
  svc.emit("dialogs", { bots: [{ key: "u1" }] });
  assert.equal(messages.length, 1);
  ctx.settings.data.chat.modes = ["telegram"];
  ctx.tg = replacement;
  svc.emit("msg", { id: 2 });
  assert.equal(messages.length, 1);
  ctx.tg = null;
  ctx.login = { svc };
  svc.emit("dialogs", { bots: [] });
  assert.equal(messages.length, 2);
});

test("a late login failure cannot restore login UI after Telegram is disabled", async () => {
  const src = fs.readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  const fn = src.slice(src.indexOf("function cancelLogin()"), src.indexOf("// --- IPC"));
  let reject;
  let release;
  const statuses = [];
  const ctx = { tgEpoch: 0, login: null, tg: null, wire() {},
    settings: { data: { chat: { modes: ["telegram"] }, firstRunDone: true } },
    telegramReady: require("../renderer/chat-modes").telegramReady, telegramOptions: () => ({}),
    loginMessage: String, setTg: (s) => statuses.push(s.status),
    TelegramService: class { login() { return new Promise((_r, j) => { reject = j; }); } stop() { return new Promise((r) => { release = r; }); } },
  };
  vm.createContext(ctx);
  await vm.runInContext(`${fn}\nstartLogin('+10000000000')`, ctx);
  reject(new Error("offline"));
  await new Promise((r) => setImmediate(r));
  ctx.settings.data.chat.modes = ["sessions"];
  vm.runInContext("cancelLogin(); setTg({status:'disabled'})", ctx);
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(statuses.at(-1), "disabled");
});

test("late fixture startup also respects Telegram disable without reopening its status", async () => {
  const src = fs.readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  const fn = src.slice(src.indexOf("function startFixture()"), src.indexOf("async function startTelegram()"));
  let release;
  let stopped = 0;
  const statuses = [];
  const ctx = { tg: null, fixture: null, relay: null, tgEpoch: 1, FIXTURE: "fixture.json", wire() {}, path,
    app: { getPath: () => "/fixture-profile" }, setRelay() {}, send() {}, setTg: (s) => statuses.push(s.status),
    settings: { data: { chat: { modes: ["telegram"] }, firstRunDone: true } }, telegramReady: require("../renderer/chat-modes").telegramReady,
    require: () => ({ FixtureService: class { data = {}; start() { return new Promise((r) => { release = r; }); } stop() { stopped++; } meInfo() { return {}; } },
      FixtureRelay: class { on() {} start() {} } }),
  };
  vm.createContext(ctx);
  const pending = vm.runInContext(`${fn}\nstartFixture()`, ctx);
  ctx.settings.data.chat.modes = ["sessions"];
  ctx.tg = null;
  ctx.tgEpoch++;
  release();
  await pending;
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.tg, null);
  assert.equal(statuses.includes("open"), false);
  assert.equal(stopped, 1);
});

test("disabled Hermes chat never reads history through background bridge events", async () => {
  const src = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
  const start = src.indexOf("  async function hermesLoadHistory(");
  const fn = src.slice(start, src.indexOf("    const n = H.nodes.get(sid);", start));
  let reads = 0;
  await vm.runInNewContext(`${fn}\n}\nhermesLoadHistory('fixture-session')`, {
    ...rendererI18n,
    BT: null, hermesMode: () => false, bridgeOpen: () => true, hHist: () => { reads++; return { loading: false }; },
  });
  assert.equal(reads, 0);
});

test("Botlar mode opens a bot when its remembered view was already bots; late creation keeps the new mode", async () => {
  const B = require("../renderer/bots");
  const oldWindow = global.window;
  const oldDocument = global.document;
  global.window = { DeckBotFace: require("../renderer/botface"), DeckI18n: I18N };
  global.document = { addEventListener() {}, hidden: false };
  let active = true;
  let releaseCreate;
  let opens = 0;
  const H = { nodes: new Map(), requests: [], sel: "ordinary-session" };
  const bot = B.create({ h: element, mark() {}, store: { get: (key) => key === "deck.hview" ? "bots" : "default", set() {} }, H: () => H,
    hermesMode: () => active, bridgeOpen: () => true, cleanErr: String, reselect() {}, renderNote() {},
    hermesSelect: (sid) => { H.sel = sid; }, hermesOpen: () => { opens++; },
    deck: { bridge: { profiles: async () => [{ name: "default", meta: {}, hasAvatar: false }], botChat: async () => null,
      botChatCreate: () => new Promise((r) => { releaseCreate = r; }) } },
  });
  try {
    bot.setView("bots");
    bot.onModeChange();
    await new Promise((r) => setImmediate(r));
    assert.equal(H.sel, "bot:default");
    const pending = bot.materialize(H.sel);
    active = false;
    H.sel = "ordinary-session";
    bot.onModeChange();
    releaseCreate({ sid: "bot-session", created: true });
    const created = await pending;
    assert.deepEqual(created, { sid: "bot-session", profile: "default" });
    assert.equal(opens, 0);
    assert.equal(H.sel, "ordinary-session");
  } finally {
    active = false;
    bot.onModeChange();
    global.window = oldWindow;
    global.document = oldDocument;
  }
});

test("spaces.defaultLevel defaults to watch, accepts watch|together|full, rejects anything else without changing state", () => {
  const { s, saved } = settings(null);
  assert.equal(s.publicView().spaces.defaultLevel, "watch");
  for (const bad of [{ defaultLevel: "root" }, { defaultLevel: "" }, null, "full", ["full"]]) {
    const before = plain(s.publicView());
    assert.throws(() => s.update({ spaces: bad, language: "tr" }));
    assert.deepEqual(plain(s.publicView()), before);
  }
  s.update({ spaces: { defaultLevel: "together" } });
  assert.equal(s.publicView().spaces.defaultLevel, "together");
  assert.equal(settings(saved()).s.publicView().spaces.defaultLevel, "together");
  assert.equal(settings({ spaces: { defaultLevel: "bogus" } }).s.publicView().spaces.defaultLevel, "watch");
});

test("desktops settings: defaults, validated limit/memory/cpus/idle/home warning, invalid patches change nothing, host only through updateDesktopsHost", () => {
  const { s, saved } = settings(null);
  assert.deepEqual(plain(s.publicView().desktops), { host: false, limit: 3, memory: "1.5g", cpus: 2, idleMin: 20, homeWarnGB: 10 });
  const bads = [
    { limit: -1 }, { limit: 17 }, { limit: 2.5 }, { limit: "3" },
    { cpus: 0 }, { cpus: 9 }, { cpus: 1.5 },
    { memory: "0.4g" }, { memory: "8.5g" }, { memory: "2gb" }, { memory: "2G" }, { memory: "1024m" }, { memory: 2 },
    { idleMin: 4 }, { idleMin: 241 }, { idleMin: null },
    { homeWarnGB: 0 }, { homeWarnGB: "10" },
    { host: true }, { host: false }, { bogus: 1 }, null, [], "on",
  ];
  for (const bad of bads) {
    const before = plain(s.publicView());
    assert.throws(() => s.update({ desktops: bad, language: "tr" }), (e) => e.message === I18N.t("set.desktopsInvalid"), JSON.stringify(bad));
    assert.deepEqual(plain(s.publicView()), before, JSON.stringify(bad));
  }
  s.update({ desktops: { limit: 0, memory: "0.5g", cpus: 1, idleMin: 5 } });
  s.update({ desktops: { limit: 16, memory: "8g", cpus: 8, idleMin: 240, homeWarnGB: 50 } });
  assert.deepEqual(plain(s.publicView().desktops), { host: false, limit: 16, memory: "8g", cpus: 8, idleMin: 240, homeWarnGB: 50 });
  s.updateDesktopsHost(true);
  assert.equal(s.publicView().desktops.host, true);
  assert.equal(saved().desktops.host, true);
  assert.deepEqual(plain(settings(saved()).s.publicView().desktops), { host: true, limit: 16, memory: "8g", cpus: 8, idleMin: 240, homeWarnGB: 50 });
  s.updateDesktopsHost("yes");
  assert.equal(s.publicView().desktops.host, false, "only true turns it on");
  // a hand-edited file falls back per field
  assert.deepEqual(plain(settings({ desktops: { host: "yes", limit: 99, memory: "lots", cpus: 4, idleMin: 1 } }).s.publicView().desktops),
    { host: false, limit: 3, memory: "1.5g", cpus: 4, idleMin: 20, homeWarnGB: 10 });
  assert.deepEqual(plain(settings({ desktops: "broken" }).s.publicView().desktops), { host: false, limit: 3, memory: "1.5g", cpus: 2, idleMin: 20, homeWarnGB: 10 });
});
