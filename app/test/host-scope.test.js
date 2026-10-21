"use strict";
// Multi-host: a page made for one host never acts on another; device trust does not travel with a switch.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { pageHost, samePage } = require("../main/ipc-guard");
const repo = path.join(__dirname, "../..");

const frame = url => ({ senderFrame: { url } });

test("a page from another host is refused; a page from before hosts existed belongs to the first", () => {
  assert.equal(pageHost(frame("deck://app/index.html?host=h2")), "h2");
  assert.equal(samePage(frame("deck://app/index.html?host=h2"), "h2"), true);
  assert.equal(samePage(frame("deck://app/index.html?host=h1"), "h2"), false, "late answer from the old host's page");
  assert.equal(samePage(frame("deck://app/index.html"), "h1"), true);
  assert.equal(samePage({}, "h1"), false, "no frame, no access");
});

test("the host gate covers every appIpc channel, including presence and workspace ones", async () => {
  const { appIpc, setHostGate } = require("../main/ipc-guard");
  const reg = new Map();
  const ipc = appIpc({ handle: (ch, fn) => reg.set(ch, fn), on: (ch, fn) => reg.set(ch, fn) });
  let ran = 0;
  for (const ch of ["device:set-hosting", "ws:handoff", "bridge:send", "bridge:unload-done"]) ipc.handle(ch, () => ++ran);
  const HOSTLESS = new Set(["bridge:unload-done"]);
  setHostGate((ch, e) => HOSTLESS.has(ch) || samePage(e, "h2"));
  try {
    const stale = frame("deck://app/index.html?host=h1");
    for (const ch of ["device:set-hosting", "ws:handoff", "bridge:send"]) assert.throws(() => reg.get(ch)(stale), undefined, ch);
    assert.equal(ran, 0, "a page from the old host runs nothing");
    reg.get("bridge:unload-done")(stale);
    reg.get("bridge:send")(frame("deck://app/index.html?host=h2"));
    assert.equal(ran, 2, "the switch can finish; the active page works");
  } finally { setHostGate(null); }
});

function fixture(raw) {
  let saved;
  const context = { module: { exports: {} }, Buffer, URL, process: { env: {} }, require(id) {
    if (id === "fs") return { readFileSync: () => JSON.stringify(raw), statSync: () => ({ size: 0 }), copyFileSync() {}, constants: {},
      lstatSync: () => ({ isFile: () => true }), mkdirSync() {}, renameSync() {}, writeFileSync: (_f, c) => { saved = JSON.parse(c); } };
    if (id === "os") return { homedir: () => "/fixture-home" };
    if (id === "path") return path;
    if (id === "electron") return { app: { getPath: () => "/fixture-profile" }, safeStorage: {
      isEncryptionAvailable: () => true, encryptString: v => Buffer.from([...v].reverse().join("")), decryptString: b => [...b.toString()].reverse().join("") } };
    if (id === "./envfile") return { loadEnvFile() {} };
    if (id === "./bridge") return { normalizeConfig: v => ({ ...v }) };
    return require(path.join(repo, "app/main", id));
  } };
  vm.runInNewContext(fs.readFileSync(path.join(repo, "app/main/settings.js"), "utf8"), context);
  return { settings: new context.module.exports.Settings().load(), saved: () => saved };
}

test("desktop control pairing and desktop hosting stay with the host they were given to", () => {
  const { settings, saved } = fixture({ firstRunDone: true, relay: { url: "ws://192.0.2.10:9330", token: { plain: "a".repeat(32) } } });
  settings.updateBotscreen({ agents: ["alpha"], deviceToken: "k".repeat(20) });
  settings.updateDesktopsHost(true);
  const b = settings.addHost({ name: "Host B", relay: { url: "192.0.2.20", token: "b".repeat(32) } });
  settings.selectHost(b);
  assert.deepEqual(JSON.parse(JSON.stringify(settings.data.botscreen)), { agents: [], deviceToken: "" }, "host B starts unpaired");
  assert.equal(settings.data.desktops.host, false, "hosting consent ends with the switch");
  assert.ok(!JSON.stringify(saved()).includes("k".repeat(20)), "the device key is sealed on disk");
  settings.selectHost("h1");
  assert.deepEqual(JSON.parse(JSON.stringify(settings.data.botscreen)), { agents: ["alpha"], deviceToken: "k".repeat(20) }, "host A's pairing comes back");
  assert.equal(settings.data.desktops.host, false, "but hosting stays off until the owner turns it on again");
});

test("drafts and selections are kept per host; the first host keeps the old keys", () => {
  const src = fs.readFileSync(path.join(repo, "app/renderer/app.js"), "utf8");
  const line = src.match(/const hostKey = \(key\) => .*;/)[0];
  const k = host => vm.runInNewContext(`const pageHost = ${JSON.stringify(host)}; ${line} hostKey("deck.drafts")`);
  assert.equal(k(""), "deck.drafts");
  assert.equal(k("h1"), "deck.drafts");
  assert.equal(k("h2"), "h2/deck.drafts");
});

test("an unreadable token stays with its own host and never fills another host's slot", () => {
  const bad = { enc: Buffer.from("not decryptable").toString("base64") };
  const { settings, saved } = fixture({ firstRunDone: true, relay: { url: "ws://192.0.2.10:9330", token: bad },
    hosts: [{ id: "h1", name: "Host A", relay: { url: "ws://192.0.2.10:9330", token: bad } },
            { id: "h2", name: "Host B", relay: { url: "ws://192.0.2.20:9330", token: "" } }], activeHost: "h1" });
  settings.selectHost("h2");
  const disk = saved();
  assert.equal(disk.relay.token, "", "host B does not inherit host A's ciphertext");
  assert.deepEqual(disk.hosts.find(h => h.id === "h1").relay.token, bad, "host A keeps its ciphertext");
});

test("another host's card offers no Open chat (it would open on the active host)", () => {
  const I = require("../renderer/inbox");
  const { dom } = require("./inbox-dom-helper"), { h, doc, walk } = dom();
  const store = I.createStore({});
  store.feedHosts({ t: "requests", hosts: [{ id: "h2", name: "Host B", status: "open", requests: [{ id: "A1", sid: "s-1", kind: "approval", choices: ["once"] }] }] });
  const opened = [];
  const view = I.createInbox({ h, doc, store, t: k => k, shell: { main: () => "inbox", icon: () => h("svg") }, openChat: r => opened.push(r) });
  assert.ok(!walk(view.root).some(n => n.tag === "button" && (n.children || []).includes("triage.openChat")));
  view.keydown({ key: "Enter", preventDefault() {} });
  assert.deepEqual(opened, []);
});
