"use strict";
// Botlar's pure helpers (renderer/bots.js) and the bot faces (renderer/botface.js), without Electron or a DOM:
// roster order and names as Hermes Desktop derives them, the avatar precedence, state lines, and a face built
// only through createElementNS-style calls (no innerHTML anywhere).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const B = require("../renderer/bots");
const F = require("../renderer/botface");
const i18n = require("../renderer/i18n");

const RENDERER = path.join(__dirname, "..", "renderer");

test("names and handles follow Desktop: title > display_name > Hermes for default > Title Cased", () => {
  assert.equal(B.displayName({ name: "research", meta: { title: "Araştırmacı" }, displayName: "R" }), "Araştırmacı");
  assert.equal(B.displayName({ name: "writer", meta: {}, displayName: "Yazar" }), "Yazar");
  assert.equal(B.displayName({ name: "default", meta: {} }), "Hermes");
  assert.equal(B.displayName({ name: "night-owl_bot", meta: {} }), "Night Owl Bot");
  assert.equal(B.handleOf("default"), "hermes");
  assert.equal(B.handleOf("ops"), "ops");
  assert.equal(B.stripA2A("Message from 🤖 Hermes (@hermes): kaynak listesini güncelledim"), "kaynak listesini güncelledim");
  assert.equal(B.stripA2A("Message from agent 'ops': tamam"), "tamam");
  assert.equal(B.stripA2A("Normal bir mesaj"), "Normal bir mesaj");
});

test("roster: hidden left out, pinned first, then newest activity; one row per profile", () => {
  const rows = B.buildRoster([
    { name: "default", meta: {}, canonical: { lastActive: 1000 } },
    { name: "old", meta: {}, last: { lastActive: 10 } },
    { name: "pinned", meta: { pinned: true } },
    { name: "hidden", meta: { hidden: true }, canonical: { lastActive: 99999 } },
    { name: "fresh", meta: { created: 2_000_000 } }, // ms, like Desktop's created
  ]);
  assert.deepEqual(rows.map((r) => r.name), ["pinned", "fresh", "default", "old"]);
  assert.deepEqual(rows.map((r) => r.title), ["Pinned", "Fresh", "Hermes", "Old"]);
  // a host without profiles.list: the profiles the snapshot shows, default first
  assert.deepEqual(B.fallbackProfiles([{ profile: "zeta" }, { profile: "alpha" }, { profile: "zeta" }]).map((p) => p.name), ["default", "alpha", "zeta"]);
});

test("state line: waiting beats working beats idle, from the bot's sessions and open requests", (t) => {
  i18n.setLanguage("tr");
  t.after(() => i18n.setLanguage("en"));
  const live = (n) => n.state === "working";
  const bot = { name: "ops", canonical: { lastActive: 50 }, last: null };
  const idle = B.botState(bot, { nodes: [{ sid: "a", profile: "other", state: "working" }], nodeLive: live });
  assert.deepEqual([idle.kind, idle.lastActive], ["idle", 50]);
  const working = B.botState(bot, { nodes: [{ sid: "a", profile: "ops", state: "working", steps: ["dosya okunuyor"], updatedAt: 60 }], nodeLive: live });
  assert.deepEqual([working.kind, working.step, working.lastActive], ["live", "dosya okunuyor", 60]);
  const ask = B.botState(bot, { nodes: [{ sid: "a", profile: "ops", state: "working" }], requests: [{ sid: "chat" }, { sid: "a" }], chatSid: "chat", nodeLive: live });
  assert.deepEqual([ask.kind, ask.asks, ask.live], ["ask", 2, true]);
  const ago = () => "5 dk";
  assert.equal(B.stateText(idle, ago), "boşta · 5 dk");
  assert.equal(B.stateText(working, ago), "çalışıyor · dosya okunuyor");
  assert.equal(B.stateText(ask, ago), "2 istek yanıt bekliyor");
});

test("state labels default to English and switch live without changing profile or step text", (t) => {
  assert.equal(i18n.getLanguage(), "en");
  t.after(() => i18n.setLanguage("en"));
  const working = { kind: "live", step: "dosya okunuyor" };
  assert.equal(B.stateText({ kind: "idle" }, String), "idle");
  assert.equal(B.stateText(working, String), "working · dosya okunuyor");
  assert.equal(B.stateText({ kind: "ask", asks: 2 }, String), "2 requests waiting for a reply");
  i18n.setLanguage("tr");
  assert.equal(B.stateText({ kind: "idle" }, String), "boşta");
  assert.equal(B.stateText(working, String), "çalışıyor · dosya okunuyor");
  assert.equal(B.displayName({ name: "research", meta: { title: "Araştırmacı" } }), "Araştırmacı");
  i18n.setLanguage("en");
  assert.equal(B.stateText(working, String), "working · dosya okunuyor");
});

test("avatar precedence: real picture > picked face > Desktop's face raster > face from the name", () => {
  const photo = { found: true, url: "data:image/png;base64,AAAA", raster: false };
  const raster = { found: true, url: "data:image/png;base64,BBBB", raster: true };
  const picked = { custom: true, shape: "hexagon", color: "#6fb3a6" };
  assert.deepEqual(B.avatarSpec({ name: "w", meta: picked }, photo, F), { kind: "photo", url: photo.url });
  assert.deepEqual(B.avatarSpec({ name: "w", meta: picked }, raster, F), { kind: "face", shape: "hexagon", color: "#6fb3a6" });
  assert.deepEqual(B.avatarSpec({ name: "w", meta: {} }, raster, F), { kind: "raster", url: raster.url });
  assert.deepEqual(B.avatarSpec({ name: "default", meta: {} }, null, F), { kind: "face", shape: "squircle", color: "#8b5cf6" });
  // a blobatar pick is drawn by Desktop's raster (the Deck does not ship blobatar)
  assert.deepEqual(B.avatarSpec({ name: "w", meta: { custom: true, shape: "blobatar:x:round" } }, raster, F).kind, "raster");
  assert.equal(B.wantsAsset({ name: "w", hasAvatar: true, meta: picked }, F), false, "a picked vector face needs no download");
  assert.equal(B.wantsAsset({ name: "w", hasAvatar: true, meta: {} }, F), true);
  assert.equal(B.wantsAsset({ name: "w", hasAvatar: false, meta: {} }, F), false);
});

test("avatars are fetched one at a time: Hermes' 4 MiB per-client queue never holds two ~1.3 MB replies", async () => {
  const bots = ["a", "b", "c", "d", "e", "f", "g", "h"].map((name) => ({ name, hasAvatar: true, meta: {} }));
  const cache = new Map();
  let inFlight = 0;
  let peak = 0;
  const asked = [];
  const waiting = [];
  let changed = 0;
  let open = true;
  const run = B.avatarFetcher({
    roster: () => bots,
    wants: (bot) => B.wantsAsset(bot, F),
    cache,
    open: () => open,
    changed: () => changed++,
    fetch: (name) => {
      asked.push(name);
      peak = Math.max(peak, ++inFlight);
      return new Promise((resolve, reject) => waiting.push(() => {
        inFlight--;
        if (name === "c") reject(new Error("Hermes isteği zaman aşımına uğradı"));
        else resolve(name === "d" ? { found: false } : { found: true, url: `data:image/png;base64,${name}` });
      }));
    },
  });
  const settle = () => new Promise((r) => setImmediate(r));
  const done = run();
  const again = run(); // a second refresh while the first run is going: folded into it, no parallel request
  await again;
  for (let i = 0; i < 20 && waiting.length; i++) {
    assert.equal(waiting.length, 1, "never more than one avatar request outstanding");
    if (asked.length === 3) cache.clear(); // a reconnect clears the cache while "c" is asked
    waiting.shift()();
    await settle();
  }
  await done;
  assert.equal(peak, 1);
  // the first pass goes on to h; the folded second run then refills what the clear dropped (a-c); the reply
  // for the "c" asked before the clear is dropped, not written over the cleared cache
  assert.deepEqual(asked, ["a", "b", "c", "d", "e", "f", "g", "h", "a", "b", "c"]);
  assert.equal(cache.get("a").url, "data:image/png;base64,a");
  assert.deepEqual(cache.get("c"), { found: false }, "a failed fetch falls back to the generated face");
  assert.deepEqual(cache.get("d"), { found: false });
  assert.equal(cache.size, 8);
  assert.equal(changed, 11);
  // a closed bridge stops the queue; the rest is asked on the next run
  cache.clear();
  asked.length = 0;
  const closing = run();
  open = false;
  waiting.shift()();
  await closing;
  assert.deepEqual(asked, ["a"]);
  assert.equal(waiting.length, 0);
});

test("faces: Desktop's deterministic shape and colour, its 40x44 geometry", () => {
  // the (h*31 + c) >>> 0 hash: stable per name, one of seven shapes, hsl(h % 360 68% 58%)
  let h = 0;
  for (const ch of "research") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  assert.equal(F.defaultShapeFor("research"), F.SHAPES[h % 7]);
  assert.equal(F.profileColor("research"), `hsl(${h % 360} 68% 58%)`);
  assert.equal(F.profileColor("default"), null);
  assert.deepEqual(F.appearance("default", {}), { shape: "squircle", color: "#8b5cf6" });
  assert.deepEqual(F.appearance("default", { custom: true, shape: "pill", color: "#123456" }), { shape: "pill", color: "#123456" });
  const m = F.faceModel({ shape: "hexagon", color: "#f0e0d0" });
  assert.equal(m.viewBox, "0 0 40 44");
  assert.deepEqual(m.eyes.map((e) => [e.cx, e.cy, e.rx, e.ry]), [[15.4, 17.2, 2.2, 2.3], [24.6, 17.2, 2.2, 2.3]]);
  assert.equal(m.eyes[0].fill, "rgba(0,0,0,0.85)", "a light body gets dark eyes");
  assert.equal(F.faceModel({ shape: "circle", color: "#101010" }).eyes[0].fill, "rgba(232,220,195,0.95)");
  assert.equal(F.faceModel({ shape: "cloud", color: "#fff" }).eyes[0].cy, 22);
  assert.equal(F.faceModel({ shape: "circle", color: "#fff", working: true }).eyes[0].ry, 2.6);
  assert.match(m.body.d, /^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+)+Z$/);
  for (const shape of F.SHAPES) assert.ok(F.faceModel({ shape, color: "#888" }).body.d.length > 20, shape);
});

test("renderFace builds SVG with element calls only, and no renderer file for Botlar uses innerHTML", () => {
  const made = [];
  const el = (tag, attrs) => {
    const node = { tag, attrs: { ...attrs }, kids: [], dataset: {}, appendChild(k) { this.kids.push(k); return k; } };
    made.push(node);
    return node;
  };
  const root = F.renderFace(el, F.faceModel({ shape: "pill", color: "#e8846a" }), { size: 42, label: "ops" });
  assert.equal(root.tag, "svg");
  assert.deepEqual([root.attrs.width, root.attrs.viewBox, root.dataset.bot], [42, "0 0 40 44", "ops"]);
  assert.deepEqual(root.kids.map((k) => k.tag), ["path", "g", "path", "g"]);
  assert.equal(made.filter((n) => n.tag === "ellipse").length, 2);
  for (const file of ["bots.js", "botface.js"]) {
    const src = fs.readFileSync(path.join(RENDERER, file), "utf8").replace(/\/\/.*$/gm, "");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|DOMParser|document\.write/.test(src), `${file} builds markup from strings`);
  }
});

test("Botlar never reads Telegram data: the rail mode is fed by the Hermes bridge only", () => {
  const src = fs.readFileSync(path.join(RENDERER, "bots.js"), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/telegram|agentList|S\.tg|deck\.tg\b|\.chats\(\)/i.test(src), "bots.js reaches for Telegram");
  assert.ok(/deck\.bridge\.profiles\(/.test(src) && /deck\.bridge\.botChat\(/.test(src));
});
