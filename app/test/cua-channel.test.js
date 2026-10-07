"use strict";
// The Deck's driver channel (protocol v2) end to end, without Electron, against the real relay:
//   relay      relay/src/index.js start() with its driver module, device tokens and MCP fence (temp dirs)
//   "Hermes"   the real relay/bin/deck-cua.js wrapper, as Hermes runs it
//   Deck       app/main/relay.js RelayClient + presence heartbeat + cua/channel.js DriverChannel + cua/driver.js
//   driver     test/fixtures/fake-cua-driver.js in place of cua-driver
// Needs the relay's dependencies (cd ../relay && npm ci); the wire test alone needs none. Run: cd app && npm test
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const wire = require("../main/cua/wire");
const { DriverChannel } = require("../main/cua/channel");
const { Driver, killProcess } = require("../main/cua/driver");
const { checkArgv, GRANT_VERBS } = require("../main/cua/protocol");
const M = require("../main/cua/manifest");

const RELAY = path.join(__dirname, "..", "..", "relay");
// the fake driver is a plain process, never a CuaDriver.app: macOS runs the spawn path too
const PLATFORM = process.platform === "darwin" ? "linux" : process.platform;
const FAKE = path.join(__dirname, "fixtures", "fake-cua-driver.js");
const TOKEN = "r".repeat(40);
const DEVICE = crypto.randomBytes(8).toString("hex");
const SKEY = "agent:main:telegram:dm:1001";
const HOME_SCOUT = path.join(os.tmpdir(), "hermes-home", "profiles", "scout");
let relayMod = null;
try {
  relayMod = { index: require(path.join(RELAY, "src", "index")), driver: require(path.join(RELAY, "src", "driver")), devtokens: require(path.join(RELAY, "src", "devtokens")) };
} catch {
  relayMod = null; // relay dependencies not installed: the end-to-end test is skipped
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, what = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}

test("wire: byte-identical to the relay's driver frames; CDP frames are not ours", () => {
  const cases = [
    [wire.OP.HELLO, 0, { v: 1, device: DEVICE, token: "x" }],
    [wire.OP.OPEN, 7, { argv: ["mcp"], agent: "Scout", profile: "scout", sid: "s" }],
    [wire.OP.DATA, 3, Buffer.from([0, 1, 2, 255, 10])],
    [wire.OP.CLOSE, 4294967295, { code: 0 }],
    [wire.OP.REVOKE, 0, undefined],
  ];
  for (const [op, ch, payload] of cases) {
    const ours = wire.encodeFrame(op, ch, payload);
    if (relayMod) assert.ok(ours.equals(relayMod.driver.encodeFrame(op, ch, payload)), `op ${op}`);
    const back = wire.decodeFrame(ours);
    assert.deepStrictEqual([back.op, back.ch], [op, ch]);
  }
  assert.deepStrictEqual(wire.OP, relayMod ? relayMod.driver.OP : wire.OP);
  assert.strictEqual(wire.decodeFrame(Buffer.from([0xcd, 1, 0, 0, 0, 1])), null);
  assert.strictEqual(wire.decodeFrame(Buffer.from([0xd5, 99, 0, 0, 0, 1])), null);
  assert.deepStrictEqual(wire.frameJson(Buffer.from('{"ok":true}')), { ok: true });
  assert.strictEqual(wire.frameJson(Buffer.from("[1]")), null);
});

/** The relay as the agent host runs it, in temp folders, with one device token issued. */
async function startRelay() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-bs-relay-"));
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify({ profiles: { scout: { name: "Scout", bot: "ExampleScoutBot" } } }));
  const tokensFile = path.join(dir, "devices.json");
  const deckToken = relayMod.devtokens.add(tokensFile, "test-pc");
  const deckHome = path.join(dir, "deck-home");
  const sock = process.platform === "win32" ? `\\\\.\\pipe\\deck-bs-test-${crypto.randomBytes(6).toString("hex")}` : path.join(dir, "d.sock");
  const cfg = {
    host: "127.0.0.1", port: 0, token: TOKEN, eventsDir: path.join(dir, "events"), stateDir: path.join(dir, "state"), dataDir: path.join(dir, "data"),
    claudeDirs: [], claudeProfile: "claude-code", claudeChatMap: null, launchdPrefixes: [], codexbar: null, agentsFile, broadcastWindowS: 300, tickMs: 100,
    cdp: { port: null },
    driver: { deckHome, sockPath: sock, cuDir: path.join(deckHome, "cu"), tokensFile, hermesPython: "", desktopHost: false },
  };
  const relay = await relayMod.index.start(cfg);
  return { relay, cfg, deckToken, sock, tokensFile };
}

/** deck-cua as Hermes runs it. */
function wrapper(sock, argv) {
  const p = spawn(process.execPath, [path.join(RELAY, "bin", "deck-cua.js"), ...argv], {
    env: { ...process.env, DECK_DRIVER_SOCK: sock, DECK_RELAY_ENV: path.join(os.tmpdir(), "no-such-relay.env"), DECK_CUA_SELF: "/opt/hermes-deck/relay/bin/deck-cua", HERMES_HOME: HOME_SCOUT, HERMES_SESSION_KEY: SKEY, HERMES_SESSION_ID: "" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const r = { p, out: "", err: "" };
  p.stdout.on("data", (b) => (r.out += b));
  p.stderr.on("data", (b) => (r.err += b));
  r.exit = new Promise((resolve) => p.on("exit", (code) => resolve(code)));
  r.send = (obj) => p.stdin.write(JSON.stringify(obj) + "\n");
  r.reply = (id) => until(() => r.out.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === id), 10000, `reply ${id}`);
  return r;
}

/** The Deck's device side: relay connection, presence heartbeat, driver channel, fake driver. */
function deckSide({ url, deckToken }) {
  const { RelayClient } = require("../main/relay");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-bs-deck-"));
  const log = path.join(dir, "calls.ndjson");
  const sock = process.platform === "win32" ? `\\\\.\\pipe\\hdtest-${crypto.randomBytes(6).toString("hex")}` : path.join(dir, "drv.sock");
  const driver = new Driver({ dir, platform: PLATFORM, locate: () => ({ bin: process.execPath, prefix: [FAKE] }), socket: sock, env: { ...process.env, FAKE_CUA_LOG: log } });
  const D = { dir, log, driver, grant: null, token: deckToken };
  D.calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const relay = new RelayClient({ url, token: TOKEN });
  D.relay = relay;
  D.beat = () => relay.send({ t: "heartbeat", device: { id: DEVICE, name: "Test PC" }, os: process.platform, idleSec: 1, locked: false, hosting: { browser: false, desktop: true }, driverOk: { desktop: true } });
  relay.on("status", (s) => s.status === "open" && D.beat());
  D.statuses = [];
  D.stops = [];
  const channel = new DriverChannel({
    hello: () => ({ v: 1, device: DEVICE, os: process.platform, deck: "0.0.0-test", driver: { ok: true, version: "0.21.0-fake" }, desktop: true, pid: 4000000, token: D.token }),
    gate: async (m) => {
      const v = checkArgv(m.argv);
      if (!v.ok) return v;
      if (m.profile !== "scout") return { ok: false, code: 1, error: "not allowed on this device" };
      if (GRANT_VERBS.has(v.verb)) {
        if (!D.grant) return { ok: false, code: 1, error: "no window was handed over on this device" };
        await driver.ensure(M.grantManifest({ grant: { ...D.grant, startedAt: 1, idleMin: 30 }, ident: { executable: "C:\\Example\\app.exe", bundleId: "com.example.app" }, platform: process.platform }));
      }
      return { ok: true };
    },
    runner: (argv) => driver.run(argv),
    kill: (p) => killProcess(p, process.platform),
  });
  channel.on("status", (s) => D.statuses.push(s.status));
  channel.on("stop", (r) => D.stops.push(r));
  D.channel = channel;
  return D;
}

test("channel: HELLO/READY with the device key, grant, an MCP session through the relay's fence, CLOSE, STOP, a dropped connection", { skip: !relayMod && "relay dependencies not installed (cd relay && npm ci)", timeout: 90000 }, async () => {
  const R = await startRelay();
  const D = deckSide({ url: `ws://127.0.0.1:${R.relay.port}`, deckToken: R.deckToken });
  const wrappers = [];
  try {
    // a wrong key first: READY {ok:false}, nothing is opened
    D.token = "not-a-device-token-0000000000";
    D.channel.attach(D.relay);
    D.channel.start();
    D.relay.start();
    await until(() => D.channel.state.status === "refused", 8000, "READY refused");
    assert.match(D.channel.state.error, /device token not accepted/);
    // the right key: HELLO again (as after the user saves a new key)
    D.token = R.deckToken;
    D.channel.start();
    await until(() => D.channel.ready, 8000, "READY ok");

    // no grant yet: the Deck's own gate refuses the mcp process (layer 3), the wrapper ends with the reason
    D.beat();
    const early = wrapper(R.sock, ["mcp"]);
    wrappers.push(early);
    early.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const earlyCode = await Promise.race([early.exit, sleep(10000).then(() => "timeout")]);
    assert.ok(earlyCode !== 0 && earlyCode !== "timeout", `exit ${earlyCode}`);
    assert.match(early.err, /no window was handed over/);
    assert.ok(!D.calls().some((c) => c.argv[0] === "mcp"), "no driver process started without a grant");

    // the consent sheet's grant reaches the relay; an MCP session runs on the device's fake driver
    D.grant = { agent: "Scout", app: "Example", window: { id: 77, pid: 4242, title: "notes" }, expires: Date.now() + 3600_000, idleMin: 30 };
    assert.ok(D.channel.control(wire.OP.GRANT, { grant: D.grant }));
    await sleep(200);
    const w = wrapper(R.sock, ["mcp"]);
    wrappers.push(w);
    w.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.match(JSON.stringify(await w.reply(1)), /fake-cua-driver/);
    w.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_window_state", arguments: { pid: 4242, window_id: 77 } } });
    assert.match(JSON.stringify(await w.reply(2)), /ok get_window_state/);
    // layer 2 refuses what the grant does not cover; it never reaches the device
    w.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "kill_app", arguments: { pid: 4242 } } });
    const r3 = await w.reply(3);
    assert.ok(r3.result && r3.result.isError, JSON.stringify(r3));
    // Hermes' untargeted listings: the device's driver refuses a list_windows without a pid under the grant's
    // display: false, so the relay pins it to the granted pid (the answer cut to the granted window) and answers
    // list_apps from such a listing
    w.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_windows", arguments: { on_screen_only: true, session: "h" } } });
    const r4 = await w.reply(4);
    assert.deepStrictEqual(r4.result.structuredContent.windows.map((x) => [x.window_id, x.pid]), [[77, 4242]], JSON.stringify(r4));
    w.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_apps", arguments: { session: "h" } } });
    const r5 = await w.reply(5);
    assert.deepStrictEqual(r5.result.structuredContent, { apps: [{ name: "Excel", pid: 4242, running: true, display_name: "Example" }] }, JSON.stringify(r5));
    const mcp = D.calls().find((c) => c.argv[0] === "mcp");
    assert.deepStrictEqual(mcp.argv, ["mcp", "--socket", D.driver.socket]);
    assert.strictEqual(mcp.mode, "bounded");
    assert.strictEqual(D.channel.channels.size, 1);

    // Hermes closes stdin: the relay sends CLOSE, the Deck kills the process and answers CLOSE, the wrapper ends
    w.p.stdin.end();
    const code = await Promise.race([w.exit, sleep(10000).then(() => "timeout")]);
    assert.notStrictEqual(code, "timeout");
    await until(() => D.driver.children.size === 0 && D.channel.channels.size === 0, 8000, "the mcp process to end");

    // info verbs: argv[0] outside the allowlist never reaches the Deck's runner
    const man = wrapper(R.sock, ["manifest"]);
    wrappers.push(man);
    assert.strictEqual(await man.exit, 0);
    assert.match(man.out, /mcp_invocation/);

    // POST /desktop/stop (Durdur on another deck): STOP reaches this device and kills its channels
    const live = wrapper(R.sock, ["mcp"]);
    wrappers.push(live);
    live.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await live.reply(1);
    assert.strictEqual(D.channel.channels.size, 1);
    const res = await fetch(`http://127.0.0.1:${R.relay.port}/desktop/stop`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ device: DEVICE }) });
    assert.strictEqual(res.status, 200);
    await until(() => D.stops.length === 1 && D.channel.channels.size === 0 && D.driver.children.size === 0, 8000, "STOP");
    await Promise.race([live.exit, sleep(8000)]);

    // the connection drops with a session open: the channel goes offline and kills the process (Hermes fails
    // closed); RelayClient reconnects and the Deck says HELLO again
    const lost = wrapper(R.sock, ["mcp"]);
    wrappers.push(lost);
    lost.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await lost.reply(1);
    await until(() => D.driver.children.size === 1, 8000, "a live mcp process");
    D.relay.ws.terminate();
    await until(() => D.statuses.includes("offline") && D.driver.children.size === 0, 8000, "offline and the process killed");
    await until(() => D.channel.ready, 15000, "READY again after the reconnect");

    // the Deck's own Durdur: STOPPED on channel 0
    assert.ok(D.channel.control(wire.OP.STOPPED, { by: "hotkey" }));
  } finally {
    for (const w of wrappers) if (w.p.exitCode === null) w.p.kill();
    D.relay.stop();
    D.driver.killAll();
    await R.relay.stop();
  }
});

test("channel: OPEN before READY, a refused verb and a gate refusal answer CLOSE; DATA reaches stdin", async () => {
  const { EventEmitter } = require("events");
  const sent = [];
  const relay = new EventEmitter();
  relay.ws = { readyState: 1, bufferedAmount: 0 };
  relay.send = (buf) => sent.push(wire.decodeFrame(buf)) || true;
  const ch = new DriverChannel({ hello: () => ({ v: 1, token: "k" }), gate: async (m) => (m.argv[0] === "status" ? { ok: false, code: 1, error: "nope" } : { ok: true }), runner: () => { throw new Error("no driver here"); } });
  ch.attach(relay);
  ch.start();
  assert.strictEqual(sent[0].op, wire.OP.HELLO);
  assert.deepStrictEqual(wire.frameJson(sent[0].payload), { v: 1, token: "k" });
  relay.emit("frame", wire.encodeFrame(wire.OP.OPEN, 5, { argv: ["mcp"], profile: "scout" }));
  await sleep(10);
  assert.deepStrictEqual(wire.frameJson(sent[1].payload), { code: 1, error: "desktop control is switched off on this device" }, "nothing opens before READY");
  relay.emit("frame", wire.encodeFrame(wire.OP.READY, 0, { ok: true }));
  assert.ok(ch.ready);
  relay.emit("frame", wire.encodeFrame(wire.OP.OPEN, 6, { argv: ["status"], profile: "scout" }));
  relay.emit("frame", wire.encodeFrame(wire.OP.OPEN, 7, { argv: ["mcp"], profile: "scout" }));
  await sleep(10);
  const closes = sent.filter((f) => f.op === wire.OP.CLOSE).map((f) => [f.ch, wire.frameJson(f.payload)]);
  assert.deepStrictEqual(closes.slice(1), [
    [6, { code: 1, error: "nope" }],
    [7, { code: 127, error: "no driver here" }],
  ]);
  relay.emit("status", { status: "closed" });
  assert.strictEqual(ch.state.status, "offline");
  ch.stop();
  assert.strictEqual(ch.state.status, "off");
});
