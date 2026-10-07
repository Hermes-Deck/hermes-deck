"use strict";
// 0.3.0 appearance: the theme setting, the pet size setting and the pet catalog, as settings.js validates them,
// and the theme tokens every theme block in styles.css must define.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const I18N = require("../renderer/i18n");
const CATALOG = require("../renderer/pets/catalog");
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

test("theme: basalt by default, the four choices save, anything else is refused or reset", () => {
  const { s, saved } = settings({ firstRunDone: true });
  assert.equal(s.publicView().theme, "basalt");
  for (const t of ["marble", "aegean", "system", "basalt"]) {
    s.update({ theme: t });
    assert.equal(s.publicView().theme, t);
    assert.equal(saved().theme, t);
  }
  assert.throws(() => s.update({ theme: "neon" }), /Unknown theme/);
  assert.equal(settings({ theme: "neon" }).s.publicView().theme, "basalt", "a bad saved value falls back");
});

test("pet size: 1 by default, the four presets save, other numbers are refused or reset", () => {
  const { s, saved } = settings({ firstRunDone: true });
  assert.equal(s.publicView().desktop.petSize, 1);
  for (const k of [0.75, 1.25, 1.5, 1]) {
    s.update({ desktop: { petSize: k } });
    assert.equal(s.publicView().desktop.petSize, k);
    assert.equal(saved().desktop.petSize, k);
  }
  assert.throws(() => s.update({ desktop: { petSize: 2 } }), /Pet size/);
  assert.throws(() => s.update({ desktop: { petSize: "1.5" } }), /Pet size/);
  assert.equal(settings({ desktop: { petSize: 3 } }).s.publicView().desktop.petSize, 1);
});

test("pet catalog: every look is a valid setting, has a label in both languages, and sprites have art and a skin", () => {
  const { s } = settings({ firstRunDone: true });
  const root = path.join(__dirname, "../renderer");
  const html = fs.readFileSync(path.join(root, "pet.html"), "utf8");
  for (const { id, label } of CATALOG.SKINS) {
    s.update({ desktop: { petSkin: id } });
    assert.equal(s.publicView().desktop.petSkin, id);
    for (const lang of ["en", "tr"]) assert.ok(I18N.tables[lang][label], `${id}: ${lang} label ${label}`);
    if (id === "orb" || id === "agent") continue;
    assert.match(html, new RegExp(`pets/skins/${id}\.js`), `${id}: pet.html loads its skin`);
    assert.match(html, new RegExp(`pets/skins/${id}\.css`), `${id}: pet.html loads its hit areas`);
    const x3 = /x3: true/.test(fs.readFileSync(path.join(root, "pets/skins", `${id}.js`), "utf8"));
    for (const a of ["idle", "working", "reply", "waiting", "offline", "stand", "wake", "still-idle", "still-offline"]) {
      for (const sfx of ["", "@2x", ...(x3 ? ["@3x"] : [])]) assert.ok(fs.existsSync(path.join(root, "pets", id, `${a}${sfx}.png`)), `${id}/${a}${sfx}.png`);
    }
  }
  assert.throws(() => s.update({ desktop: { petSkin: "dragon" } }));
});

test("themes: marble and aegean re-point every colour token basalt defines", () => {
  const css = fs.readFileSync(path.join(__dirname, "../renderer/styles.css"), "utf8");
  const block = (sel) => css.slice(css.indexOf(sel), css.indexOf("}", css.indexOf(sel)));
  const names = (b) => new Set([...b.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
  const basalt = [...names(block(":root {"))].filter((n) => !/^--(display|body|mono|r|top|gilt-edge|gilt-wash|amphora-edge|amphora-edge-2)$/.test(n));
  for (const t of ["marble", "aegean"]) {
    const own = names(block(`:root[data-theme="${t}"]`));
    // aegean keeps the dark theme's white-on-dark lift, black shadows and sender hues; everything else must be set
    const missing = basalt.filter((n) => !own.has(n) && !(t === "aegean" && /^--(hi|shade|who0|lichen)-rgb$/.test(n)));
    assert.deepEqual(missing, [], `${t} misses ${missing.join(", ")}`);
  }
});

test("wallpaper: only real images are imported, one stored copy, only its folder is served", () => {
  const os = require("os");
  const W = require("../main/wallpaper");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hd-wall-"));
  const png = path.join(tmp, "a.png");
  fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]));
  const fake = path.join(tmp, "b.jpg");
  fs.writeFileSync(fake, "not a jpeg");
  const profile = path.join(tmp, "profile");
  const name = W.importImage(profile, png);
  assert.match(name, W.NAME_RE);
  assert.equal(W.importImage(profile, png), name, "the same picture is stored once");
  assert.throws(() => W.importImage(profile, fake), /wall\.badType/);
  assert.throws(() => W.importImage(profile, path.join(tmp, "c.txt")), /wall\.badType/);
  const jpg = path.join(tmp, "d.jpg");
  fs.writeFileSync(jpg, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]));
  const second = W.importImage(profile, jpg);
  assert.deepEqual(fs.readdirSync(path.join(profile, "wallpapers")).sort(), [name, second].sort(), "two modes, two pictures");
  W.clean(profile, W.used({ telegram: { file: second, dim: 40 }, sessions: { file: "", dim: 55 } }));
  assert.deepEqual(fs.readdirSync(path.join(profile, "wallpapers")), [second], "a picture no mode uses is removed");
  assert.equal(W.fileFor(profile, `/user-wallpaper/${second}`), path.join(profile, "wallpapers", second));
  for (const bad of ["/user-wallpaper/../settings.json", "/user-wallpaper/%2e%2e%2fsettings.json", "/user-wallpaper/x.png", "/index.html"]) {
    assert.equal(W.fileFor(profile, bad), null, bad);
  }
  const none = { file: "", dim: 55 };
  assert.deepEqual(W.normalize({ file: "../x", dim: 200 }), { telegram: none, sessions: none, bots: none });
  assert.deepEqual(W.normalize({ bots: { file: second, dim: 20 } }), { telegram: none, sessions: none, bots: { file: second, dim: 20 } });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("wallpaper setting: one per chat mode; the generic save moves only a mode's dimming, within 0..90", () => {
  const { s } = settings({ firstRunDone: true });
  const view = () => JSON.parse(JSON.stringify(s.publicView().wallpaper));
  assert.deepEqual(Object.keys(view()), ["telegram", "sessions", "bots"]);
  s.update({ wallpaper: { sessions: { dim: 30 } } });
  assert.equal(view().sessions.dim, 30);
  assert.equal(view().telegram.dim, 55, "other modes keep theirs");
  assert.throws(() => s.update({ wallpaper: { sessions: { dim: 95 } } }), /Dimming/);
  assert.throws(() => s.update({ wallpaper: { dim: 30 } }), /Dimming/, "a mode must be named");
  assert.throws(() => s.update({ wallpaper: { bots: { file: "0123456789abcdef.png", dim: 30 } } }), /Dimming/);
  s.setWallpaperFile("bots", "0123456789abcdef.png");
  assert.equal(view().bots.file, "0123456789abcdef.png");
  assert.equal(view().telegram.file, "");
  s.setWallpaperFile("bots", "../../evil.png");
  assert.equal(view().bots.file, "");
  assert.throws(() => s.setWallpaperFile("email", "0123456789abcdef.png"));
});

test("wallpaper presets: built-ins are valid settings, never stored or cleaned, and every one ships", () => {
  const W = require("../main/wallpaper");
  for (const id of W.PRESETS) {
    assert.ok(W.valid(`preset:${id}`), id);
    assert.ok(fs.existsSync(path.join(__dirname, "../renderer/wallpapers", `${id}.jpg`)), `renderer/wallpapers/${id}.jpg`);
    for (const lang of ["en", "tr"]) assert.ok(I18N.tables[lang][`wall.preset.${id}`], `${lang} label ${id}`);
  }
  assert.equal(W.valid("preset:../../settings"), false);
  assert.equal(W.valid("preset:nope"), false);
  const w = W.normalize({ telegram: { file: "preset:aegean", dim: 30 }, sessions: { file: "0123456789abcdef.png" } });
  assert.equal(w.telegram.file, "preset:aegean");
  assert.deepEqual(W.used(w), ["0123456789abcdef.png"], "only stored pictures are kept by clean()");
  const { s } = settings({ firstRunDone: true });
  s.setWallpaperFile("bots", "preset:papyrus");
  assert.equal(s.publicView().wallpaper.bots.file, "preset:papyrus");
});
