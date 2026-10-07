"use strict";
// End-to-end check of the bot screen's device side inside Electron, headless, all on this machine:
//   relay     relay/src/index.js start() with the driver module, a device token and the MCP fence (temp dirs)
//   Deck      main/cua (the real module) on a RelayClient, with a fake presence (heartbeats), fake settings,
//             a hidden window and test/fixtures/fake-cua-driver.js in place of cua-driver; no bar, no tray
//   "Hermes"  relay/bin/deck-cua.js, as Hermes runs it
// Checks: the switch turns on HELLO/READY and driverOk; "Agent'a ver" refuses the Deck's own program and
// grants a harmless process; an MCP call reaches the fake driver through the relay's fence; Durdur runs
// local first (grant gone, switch paused, processes killed, hotkey released) and works with the relay offline.
//   <electron.exe> app/scripts/botscreen-e2e.js --user-data-dir=<temp>   (needs app and relay dependencies)
const { app, BrowserWindow, globalShortcut } = require("electron");
const { EventEmitter } = require("events");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP = path.join(__dirname, "..");
const RELAY = path.join(APP, "..", "relay");
const FAKE = path.join(APP, "test", "fixtures", "fake-cua-driver.js");
const TOKEN = "e".repeat(40);
const DEVICE = crypto.randomBytes(8).toString("hex");
const NODE = process.env.HD_NODE || (process.platform === "win32" ? String(spawnSync("where", ["node"], { windowsHide: true }).stdout || "").split(/\r?\n/)[0].trim() : "node");
const HOME_SCOUT = path.join(os.tmpdir(), "hermes-home", "profiles", "scout");

let failed = false;
let diag = () => "";
const T0 = Date.now();
const step = (s) => console.log(`ok  ${s}  (+${((Date.now() - T0) / 1000).toFixed(1)} s)`);
function check(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg} [${diag()}]`);
  step(msg);
}
setTimeout(() => {
  console.error(`watchdog: still running after 100 s [${diag()}]`);
  process.exit(3);
}, 100000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, what = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}
process.on("uncaughtException", (e) => {
  console.error(e);
  app.exit(1); // never a dialog
});

async function main() {
  if (!NODE || !fs.existsSync(NODE) && NODE !== "node") throw new Error("node.exe not found (set HD_NODE)");
  const { start } = require(path.join(RELAY, "src", "index"));
  const devtokens = require(path.join(RELAY, "src", "devtokens"));
  const { RelayClient } = require(path.join(APP, "main", "relay"));
  const { Driver } = require(path.join(APP, "main", "cua", "driver"));
  const botscreen = require(path.join(APP, "main", "cua"));

  // --- relay ---------------------------------------------------------------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-bs-e2e-"));
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify({ profiles: { scout: { name: "Scout", bot: "ExampleScoutBot" } } }));
  const tokensFile = path.join(dir, "devices.json");
  const deckToken = devtokens.add(tokensFile, "e2e-pc");
  const sock = process.platform === "win32" ? `\\\\.\\pipe\\deck-bs-e2e-${crypto.randomBytes(6).toString("hex")}` : path.join(dir, "d.sock");
  const relaySrv = await start({
    host: "127.0.0.1", port: 0, token: TOKEN, eventsDir: path.join(dir, "events"), stateDir: path.join(dir, "state"), dataDir: path.join(dir, "data"),
    claudeDirs: [], claudeProfile: "claude-code", claudeChatMap: null, launchdPrefixes: [], codexbar: null, agentsFile, broadcastWindowS: 300, tickMs: 100,
    cdp: { port: null },
    driver: { deckHome: path.join(dir, "home"), sockPath: sock, cuDir: path.join(dir, "home", "cu"), tokensFile, hermesPython: "", desktopHost: false },
  });
  const url = `ws://127.0.0.1:${relaySrv.port}`;
  step(`relay on ${url}`);

  // --- the Deck's surroundings (fakes) ------------------------------------------------------------------
  const relay = new RelayClient({ url, token: TOKEN });
  const presence = new EventEmitter();
  Object.assign(presence, {
    id: DEVICE,
    name: "E2E PC",
    hosting: { browser: false, desktop: false },
    capabilities: new Set(),
    driverOk: {},
    beats: [],
    register(cap, ok) {
      this.capabilities.add(cap);
      this.driverOk[cap] = !!ok;
    },
    setHosting(cap, on) {
      this.hosting[cap] = !!on;
      this.emit("hosting", cap, !!on);
      this.push();
    },
    beat() {
      return { t: "heartbeat", device: { id: this.id, name: this.name }, os: process.platform, idleSec: 1, locked: false, hosting: { ...this.hosting }, driverOk: { ...this.driverOk } };
    },
    push() {
      const b = this.beat();
      this.beats.push(b);
      relay.send(b);
    },
  });
  relay.on("status", (s) => s.status === "open" && presence.push());
  const settings = {
    data: { relay: { url, token: TOKEN }, botscreen: { agents: ["scout"], deviceToken: deckToken } },
    updateBotscreen(p) {
      if (p.agents) this.data.botscreen.agents = p.agents;
      if (p.deviceToken) this.data.botscreen.deviceToken = p.deviceToken;
    },
  };
  const notes = [];
  const desktop = { notify: (kind, p) => notes.push({ kind, ...p }), trayAlert: () => {} };
  const pushes = [];
  const win = new BrowserWindow({ show: false, width: 400, height: 300 });
  const driverSock = process.platform === "win32" ? `\\\\.\\pipe\\hdtest-${crypto.randomBytes(6).toString("hex")}` : path.join(dir, "drv.sock");
  // the real Driver, pointed at the fake cua-driver (its working folder stays in this run's userData)
  const callLog = path.join(dir, "driver-calls.ndjson");
  const makeDriver = (o) => new Driver({ ...o, locate: () => ({ bin: NODE, prefix: [FAKE] }), socket: o.dir.endsWith("picker") ? `${driverSock}-picker` : driverSock, env: { ...process.env, FAKE_CUA_LOG: callLog } });
  diag = () => {
    const T = botscreen._test;
    const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8").trim().split("\n").slice(-6) : [];
    return `channel=${JSON.stringify(T.S.channel && T.S.channel.state)} chans=${T.S.channel ? T.S.channel.channels.size : "-"} children=${T.S.driver ? T.S.driver.children.size : "-"} daemon=${T.S.driver && T.S.driver.state} hosting=${presence.hosting.desktop} driverOk=${presence.driverOk.desktop} calls=${calls.join(" | ")}`;
  };
  const installer = { pinInfo: () => ({ available: false, reason: "e2e" }), detect: async () => ({ status: "installed", version: "0.21.0-fake", bin: NODE, source: "deck" }), install: async () => { throw new Error("e2e"); } };

  botscreen.init({ win, settings, presence, send: (ch, m) => pushes.push([ch, m]), desktop, shot: true, test: { installer, makeDriver } });
  const T = botscreen._test;
  relay.start();
  botscreen.attachRelay(relay);
  await until(() => T.S.driverInfo.status === "installed", 10000, "driver detection");
  check(!T.S.channel.ready && T.publicState().on === false, "off by default: no HELLO, no READY");

  // --- the switch -----------------------------------------------------------------------------------
  presence.setHosting("desktop", true);
  await until(() => T.S.channel.ready, 10000, "READY");
  check(T.publicState().link.status === "ready", "switch on: HELLO with the device key, READY ok");
  await until(() => presence.driverOk.desktop === true && presence.beats.some((b) => b.driverOk.desktop === true), 5000, "driverOk in a heartbeat");
  check(true, "heartbeat reports driverOk.desktop only now");
  const hk = T.S.hotkey.registered;
  if (hk === true) check(globalShortcut.isRegistered(botscreen.HOTKEY), `${botscreen.HOTKEY_LABEL} registered while on`);
  else console.log(`note: ${botscreen.HOTKEY_LABEL} could not be registered here (another app holds it); Settings shows that`);

  // --- "Agent'a ver" -------------------------------------------------------------------------------------
  const target = spawn(NODE, ["-e", "setTimeout(() => {}, 120000)"], { windowsHide: true, stdio: "ignore" });
  T.setPicker([
    { sourceId: "window:1:0", id: 76, pid: process.pid, title: "Hermes Deck", app: "Hermes Deck", matched: true, blocked: null },
    { sourceId: "window:2:0", id: 77, pid: target.pid, title: "e2e target", app: "node", matched: true, blocked: null },
  ]);
  let refused = null;
  await T.giveGrant({ profile: "scout", agent: "Scout", sourceId: "window:1:0" }).catch((e) => (refused = e.message));
  check(/kendi programına ait/.test(String(refused)), `the Deck's own program cannot be handed over (${refused})`);
  await T.giveGrant({ profile: "scout", agent: "Scout", sourceId: "window:2:0" });
  const g = T.publicState().grant;
  check(g && g.agent === "Scout" && g.app === "node", "grant written");
  check(/executable: ".*node(\.exe)?"/i.test(fs.readFileSync(T.S.driver.manifestPath, "utf8")), "bounded manifest names the target's executable (pid -> path)");
  check(T.S.driver.state === "running", "private bounded daemon running");
  check(notes.some((n) => /çalışabilir/.test(n.title) && n.force), "start notification shown");

  // --- an MCP session as Hermes runs it ------------------------------------------------------------------
  const w = spawn(NODE, [path.join(RELAY, "bin", "deck-cua.js"), "mcp"], {
    env: { ...process.env, DECK_DRIVER_SOCK: sock, DECK_RELAY_ENV: path.join(os.tmpdir(), "no-such-relay.env"), DECK_CUA_SELF: "/opt/deck-cua", HERMES_HOME: HOME_SCOUT, HERMES_SESSION_KEY: "agent:main:e2e", HERMES_SESSION_ID: "" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  let err = "";
  w.stdout.on("data", (b) => (out += b));
  w.stderr.on("data", (b) => (err += b));
  const wexit = new Promise((r) => w.on("exit", (c) => r(c)));
  const reply = (id) =>
    until(() => out.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === id), 10000, `reply ${id}`).catch((e) => {
      throw new Error(`${e.message}; wrapper stderr: ${err.trim().slice(-300)}; exit ${w.exitCode} [${diag()}]`);
    });
  w.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  await reply(1);
  w.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_window_state", arguments: { pid: target.pid, window_id: 77 } } }) + "\n");
  check(/ok get_window_state/.test(JSON.stringify(await reply(2))), "MCP call on the granted window reaches the device's driver through the relay's fence");
  check(T.S.channel.channels.size === 1 && T.S.driver.children.size === 1, "one channel, one driver process");

  // --- Durdur (hotkey) -----------------------------------------------------------------------------------
  botscreen.stop("hotkey");
  check(T.S.grant === null && T.S.driver.children.size === 0 && T.S.channel.channels.size === 0, "Durdur: channels closed, processes killed, grant gone (synchronously)");
  check(presence.hosting.desktop === false && T.publicState().paused.by === "hotkey", "Durdur: switch paused");
  check(!globalShortcut.isRegistered(botscreen.HOTKEY), "Durdur: hotkey released");
  const code = await Promise.race([wexit, sleep(10000).then(() => "timeout")]);
  check(code !== "timeout" && code !== 0, `Hermes' session ended (wrapper exit ${code})`);
  await until(() => T.S.driver.state === "stopped", 8000, "daemon stopped");
  check(notes.some((n) => /durdu/.test(n.title)), "stop notification shown");
  await until(() => presence.beats.length && presence.beats[presence.beats.length - 1].hosting.desktop === false, 5000, "heartbeat with the switch off");
  check(true, "heartbeat says the switch is off");

  // --- Durdur with the relay offline -----------------------------------------------------------------------
  presence.setHosting("desktop", true);
  await until(() => T.S.channel.ready, 10000, "READY again");
  T.setPicker([{ sourceId: "window:2:0", id: 77, pid: target.pid, title: "e2e target", app: "node", matched: true, blocked: null }]);
  await T.giveGrant({ profile: "scout", agent: "Scout", sourceId: "window:2:0" });
  await relaySrv.stop();
  await until(() => T.publicState().link.status === "offline", 10000, "relay offline");
  const t0 = Date.now();
  botscreen.stop("button");
  check(Date.now() - t0 < 1000 && T.S.grant === null && T.S.driver.children.size === 0 && presence.hosting.desktop === false, "Durdur works with the relay offline, at once");
  await until(() => T.S.driver.state === "stopped", 8000, "daemon stopped offline");

  target.kill();
  relay.stop();
}

app.whenReady().then(() =>
  main()
    .catch((e) => {
      failed = true;
      console.error(e.message || e);
    })
    .finally(() => {
      console.log(failed ? "botscreen e2e: FAILED" : "botscreen e2e: all ok");
      setTimeout(() => {
        app.exit(failed ? 1 : 0);
        setTimeout(() => process.exit(failed ? 1 : 0), 2000).unref();
      }, 200);
    })
);
