"use strict";
// Notification sounds: main/sounds.js (stored files, the setting's shape), its use in main/settings.js, the
// renderer's player (renderer/chime.js) and settings view, and which sound each toast kind asks for
// (main/notify.js). No Electron, no audio device.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const I18N = require("../renderer/i18n");
const S = require("../main/sounds");
const CHIME = require("../renderer/chime");
const SVM = require("../renderer/settings-view");

beforeEach(() => I18N.setLanguage("en"));

function settings(raw) {
  let saved;
  const context = {
    module: { exports: {} }, Buffer, URL, process: { env: {} },
    require: (id) => {
      if (id === "fs") return { readFileSync: () => { if (!raw) throw new Error("missing"); return JSON.stringify(raw); }, lstatSync: () => ({ isFile: () => true }), mkdirSync() {}, writeFileSync: (_p, v) => { saved = JSON.parse(v); }, renameSync() {} };
      if (id === "os") return { homedir: () => "/fixture-home" };
      if (id === "path") return path;
      if (id === "electron") return { app: { getPath: () => "/fixture-profile" }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() } };
      if (id === "./envfile") return { loadEnvFile() {} };
      if (id === "./bridge") return { normalizeConfig: (v) => v };
      return require(path.join(__dirname, "../main", id));
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../main/settings.js"), "utf8"), context);
  return { s: new context.module.exports.Settings().load(), saved: () => saved };
}

const plain = (x) => JSON.parse(JSON.stringify(x));
const OWN = "0123456789abcdef.mp3";

test("the built-in sounds and defaults are the same in main, the player and the settings view, with labels", () => {
  assert.deepEqual(CHIME.PRESETS, S.PRESETS, "renderer/chime.js TUNES = main/sounds.js PRESETS");
  assert.deepEqual(SVM.SOUND_PRESETS, S.PRESETS, "renderer/settings-view.js SOUND_PRESETS");
  assert.deepEqual(CHIME.EVENTS, S.EVENTS);
  assert.deepEqual(CHIME.DEFAULT_EVENTS, plain(S.DEFAULTS.events));
  assert.equal(CHIME.DEFAULT_VOLUME, S.DEFAULTS.volume);
  assert.deepEqual(plain(SVM.SOUND_DEFAULTS), plain(S.DEFAULTS));
  assert.equal(String(CHIME.OWN_RE), String(S.NAME_RE));
  for (const lang of ["en", "tr"]) {
    for (const id of S.PRESETS) assert.ok(I18N.tables[lang][`sound.preset.${id}`], `${lang} sound.preset.${id}`);
    for (const ev of S.EVENTS) assert.ok(I18N.tables[lang][`sound.ev.${ev}`], `${lang} sound.ev.${ev}`);
  }
  for (const v of Object.values(S.DEFAULTS.events)) assert.ok(S.valid(v), v);
});

test("setting values: a built-in sound, none, or a stored file; anything else falls back to the default", () => {
  assert.ok(S.valid(""));
  assert.ok(S.valid("preset:marimba"));
  assert.ok(S.valid(OWN));
  for (const bad of ["preset:nope", "preset:../x", "../x.mp3", "0123456789abcdef.exe", "bell", null, 3]) assert.equal(S.valid(bad), false, String(bad));
  assert.deepEqual(plain(S.normalize(null)), plain(S.DEFAULTS));
  const n = S.normalize({ volume: 101, events: { reply: "", done: OWN, approval: "preset:alert", question: "../evil.mp3", extra: "preset:bell" } });
  assert.equal(n.volume, 80);
  assert.deepEqual(n.events, { reply: "", done: OWN, approval: "preset:alert", question: "preset:rise", subagent: "preset:tick" });
  assert.deepEqual(S.used({ events: { reply: OWN, done: OWN, approval: "preset:bell" } }), [OWN], "built-ins are never stored");
});

test("the generic save moves the volume and built-in sounds; own files only through the picker", () => {
  const { s, saved } = settings({ firstRunDone: true });
  const view = () => plain(s.publicView().sounds);
  assert.deepEqual(view(), plain(S.DEFAULTS));
  s.update({ sounds: { volume: 35 } });
  assert.equal(view().volume, 35);
  assert.equal(saved().sounds.volume, 35);
  s.update({ sounds: { events: { approval: "preset:alert", subagent: "" } } });
  assert.equal(view().events.approval, "preset:alert");
  assert.equal(view().events.subagent, "");
  assert.equal(view().events.reply, "preset:bell", "other events keep theirs");
  for (const bad of [{ volume: 120 }, { volume: "50" }, { events: { reply: OWN } }, { events: { nope: "preset:bell" } }, { events: { reply: "preset:nope" } }, { other: 1 }, {}, null, []]) {
    assert.throws(() => s.update({ sounds: bad }), /notification sound/, JSON.stringify(bad));
  }
  assert.equal(view().volume, 35, "a refused patch changes nothing");
  s.setSoundEvent("done", OWN);
  assert.equal(view().events.done, OWN);
  s.setSoundEvent("done", "preset:pop");
  assert.equal(view().events.done, "preset:pop");
  assert.throws(() => s.setSoundEvent("done", "../../evil.mp3"), /notification sound/);
  assert.throws(() => s.setSoundEvent("email", "preset:bell"), /notification sound/);
  assert.equal(settings({ sounds: { volume: -1, events: { reply: "x" } } }).s.publicView().sounds.volume, 80, "a bad saved value falls back");
});

test("own sound files: only real audio is imported, stored once, cleaned when unused, only its folder is served", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hd-sound-"));
  try {
    const profile = path.join(tmp, "profile");
    const write = (name, head) => {
      const f = path.join(tmp, name);
      fs.writeFileSync(f, Buffer.concat([Buffer.from(head, "latin1"), Buffer.alloc(64, 3)]));
      return f;
    };
    const mp3 = write("a.mp3", "ID3\x04\x00");
    const name = S.importSound(profile, mp3);
    assert.match(name, S.NAME_RE);
    assert.equal(S.importSound(profile, mp3), name, "the same file is stored once");
    const wav = S.importSound(profile, write("b.WAV", "RIFF\x24\x00\x00\x00WAVEfmt "));
    assert.match(wav, /\.wav$/);
    for (const [f, head] of [["c.ogg", "OggS"], ["d.flac", "fLaC"], ["e.m4a", "\x00\x00\x00\x20ftypM4A "], ["f.webm", "\x1a\x45\xdf\xa3"], ["g.opus", "OggS"]]) {
      assert.match(S.importSound(profile, write(f, head)), S.NAME_RE, f);
    }
    assert.match(S.importSound(profile, (() => { const f = path.join(tmp, "h.mp3"); fs.writeFileSync(f, Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0])); return f; })()), S.NAME_RE, "an MP3 without a tag");
    assert.throws(() => S.importSound(profile, write("fake.mp3", "not audio")), /sound\.badType/);
    assert.throws(() => S.importSound(profile, write("x.exe", "MZ")), /sound\.badType/);
    const big = path.join(tmp, "big.wav");
    fs.writeFileSync(big, Buffer.concat([Buffer.from("RIFF\x00\x00\x00\x00WAVE"), Buffer.alloc(S.MAX_BYTES)]));
    assert.throws(() => S.importSound(profile, big), /sound\.tooBig/);
    S.clean(profile, S.used({ events: { reply: wav, done: "preset:bell" } }));
    assert.deepEqual(fs.readdirSync(path.join(profile, "sounds")), [wav], "a file no event uses is removed");
    assert.equal(S.fileFor(profile, `/user-sound/${wav}`), path.join(profile, "sounds", wav));
    for (const bad of ["/user-sound/../settings.json", "/user-sound/%2e%2e%2fsettings.json", "/user-sound/x.mp3", "/user-wallpaper/" + wav, "/index.html"]) {
      assert.equal(S.fileFor(profile, bad), null, bad);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("player: each event resolves to its setting, with safe fallbacks; nothing plays without audio", () => {
  const set = { sounds: { volume: 40, events: { reply: "", done: OWN, approval: "preset:alert", question: "preset:nope" } } };
  assert.deepEqual(CHIME.resolve("reply", set), { value: "", volume: 40 });
  assert.deepEqual(CHIME.resolve("done", set), { value: OWN, volume: 40 });
  assert.deepEqual(CHIME.resolve("approval", set), { value: "preset:alert", volume: 40 });
  assert.deepEqual(CHIME.resolve("question", set), { value: "preset:rise", volume: 40 }, "unknown value: the default");
  assert.deepEqual(CHIME.resolve("ask", null), { value: "preset:rise", volume: 80 }, "the old ask kind is a question");
  assert.deepEqual(CHIME.resolve("nonsense", null), { value: "preset:bell", volume: 80 });
  assert.deepEqual(CHIME.resolve("subagent", { sounds: { volume: 7.5 } }), { value: "preset:tick", volume: 80 });
  assert.equal(CHIME.play("", 80), false, "none is silent");
  assert.equal(CHIME.play("preset:bell", 0), false, "volume 0 is silent");
  assert.equal(CHIME.play("preset:bell", 80), false, "no AudioContext here: silent, no throw");
  assert.equal(CHIME.play("../x.mp3", 80), false);
});

test("settings view: the sounds snapshot is cleaned like main's", () => {
  assert.deepEqual(plain(SVM.soundsOf(null)), plain(S.DEFAULTS));
  assert.deepEqual(plain(SVM.soundsOf({ sounds: { volume: 20, events: { reply: OWN, done: "../x" } } })),
    { volume: 20, events: { ...plain(S.DEFAULTS.events), reply: OWN } });
});

function notifier(opts = {}) {
  const shown = [];
  const chimes = [];
  class Notification {
    static isSupported() { return true; }
    constructor(o) { this.o = o; }
    on() {}
    show() { shown.push(this.o); }
    close() {}
  }
  const context = { module: { exports: {} }, console, setTimeout, clearTimeout, Date,
    require: (id) => (id === "electron" ? { Notification } : require(path.join(__dirname, "../main", id))) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../main/notify.js"), "utf8"), context);
  const { Notifier } = context.module.exports;
  const state = { enabled: true, sound: true, active: false, ...opts };
  const n = new Notifier({ enabled: () => state.enabled, sound: () => state.sound, active: () => state.active, describe: () => ({}), onClick() {}, chime: (e) => chimes.push(e), icon: null });
  return { n, shown, chimes, state };
}

test("toasts ask for their event's sound; quiet ones and a muted deck play nothing", () => {
  const { n, shown, chimes, state } = notifier();
  for (const k of ["reply", "done", "approval", "question", "ask", "test"]) n.notify(k, { title: "t", body: "b" });
  assert.deepEqual(chimes, ["reply", "done", "approval", "question", "question", "reply"]);
  assert.ok(shown.every((o) => o.silent === true), "the OS toast itself is always silent");
  n.notify("update", { title: "t", body: "b", quiet: true });
  assert.equal(chimes.length, 6);
  state.sound = false;
  n.notify("approval", { title: "t" });
  assert.equal(chimes.length, 6);
});

test("a finished sub-agent: a sound only, in the background, once per burst", () => {
  const { n, shown, chimes, state } = notifier();
  assert.equal(n.subagent(), true);
  assert.equal(n.subagent(), false, "a second one right after is the same burst");
  assert.deepEqual(chimes, ["subagent"]);
  assert.equal(shown.length, 0, "no toast");
  n.lastSub -= 60000;
  state.active = true;
  assert.equal(n.subagent(), false, "deck in front: nothing");
  state.active = false;
  state.sound = false;
  assert.equal(n.subagent(), false, "sound off: nothing");
  state.sound = true;
  state.enabled = false;
  assert.equal(n.subagent(), false, "notifications off: nothing");
  state.enabled = true;
  assert.equal(n.subagent(), true);
});

test("the sound file folder is served through the deck:// handler and the CSP allows playing it", () => {
  const main = fs.readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  assert.match(main, /notifySounds\.fileFor\(app\.getPath\("userData"\), u\.pathname\)/);
  assert.match(main, /ipc\.handle\("sounds:pick"/);
  assert.match(main, /ipc\.handle\("sounds:set"/);
  const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
  assert.match(html, /media-src 'self'/);
  assert.match(html, /<script src="chime\.js"><\/script>/);
});
