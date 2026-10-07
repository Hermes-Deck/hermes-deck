"use strict";
// Bot screen, agent-host side: deck-cua, the driver channel on a deck's relay connection, the relay's MCP
// fence, device tokens, lease, stop and frames. The deck here is a fake speaking the frames of driver.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const WebSocket = require("ws");
const { start } = require("../src/index");
const { Presence } = require("../src/presence");
const { Driver, OP, encodeFrame, decodeFrame } = require("../src/driver");
const { McpFence, checkCall, appsAnswer, fenceGrant } = require("../src/mcpfence");
const wire = require("../src/driver-wire");
const devtokens = require("../src/devtokens");
const deckCua = require("../bin/deck-cua.js"); // ".js": the extensionless bin/deck-cua is the sh shim

const TOKEN = "t".repeat(32);
const DEVICE = "a1b2c3d4e5f60708";
const WRAPPER = path.join(__dirname, "..", "bin", "deck-cua.js");
const SELF = "/opt/hermes-deck/relay/bin/deck-cua";
const HOME_SCOUT = path.join(os.tmpdir(), "hermes-home", "profiles", "scout");
const SKEY = "agent:main:telegram:dm:1001";
const AGENTS = { profiles: { scout: { name: "Scout", bot: "ExampleScoutBot", emoji: "🔭" } } };
const MANIFEST = {
  binary_version: "0.33.3",
  mcp_invocation: { command: "C:\\Users\\someone\\AppData\\Local\\cua-driver\\cua-driver.exe", args: ["mcp"] },
  subcommands: [{ name: "mcp", args: [{ name: "--socket" }, { name: "--grant" }] }],
};
const WINDOWS = [
  { pid: 4242, window_id: 77, app_name: "Notepad", title: "notes.txt" },
  { pid: 4242, window_id: 78, app_name: "Notepad", title: "private.txt" },
  { pid: 5150, window_id: 90, app_name: "Chrome", title: "bank" },
];
const GRANT = { agent: "Scout", app: "Notepad", window: { id: 77, pid: 4242, title: "notes.txt" }, expires: Date.now() + 3600_000, idleMin: 30 };

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "deck-driver-"));
const once = (em, ev) => new Promise((resolve) => em.once(ev, (...a) => resolve(a)));
const sockPath = (dir) => (process.platform === "win32" ? `\\\\.\\pipe\\deck-driver-test-${crypto.randomBytes(6).toString("hex")}` : path.join(dir, "d.sock"));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function relayWithDriver({ desktopHost = false, ...extra } = {}) {
  const dir = tmpDir();
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify(AGENTS));
  const tokensFile = path.join(dir, "devices.json");
  const deckToken = devtokens.add(tokensFile, "test-pc");
  const deckHome = path.join(dir, "deck-home");
  const cfg = {
    host: "127.0.0.1", port: 0, token: TOKEN, eventsDir: path.join(dir, "events"), stateDir: path.join(dir, "state"), dataDir: path.join(dir, "data"),
    claudeDirs: [], claudeProfile: "claude-code", claudeChatMap: null, launchdPrefixes: [], codexbar: null, agentsFile, broadcastWindowS: 300, tickMs: 100,
    cdp: { port: null },
    driver: { deckHome, sockPath: sockPath(dir), cuDir: path.join(deckHome, "cu"), tokensFile, hermesPython: "", desktopHost, ...extra },
  };
  const relay = await start(cfg);
  return { relay, dir, cfg, deckToken, sock: cfg.driver.sockPath };
}

/** A deck on the relay's /events socket that hosts the desktop capability with a fake cua-driver. */
async function connectDeck(relay, deckToken, { pid = 999 } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
  await once(ws, "open");
  const deck = { ws, frames: [], opens: [], calls: [], chans: new Map(), windows: WINDOWS };
  deck.send = (op, ch, payload) => ws.send(encodeFrame(op, ch, payload), { binary: true });
  deck.beat = (desktop = true) =>
    ws.send(JSON.stringify({ t: "heartbeat", device: { id: DEVICE, name: "Test PC" }, os: "win32", idleSec: 1, locked: false, hosting: { browser: false, desktop }, driverOk: { desktop: true } }));
  ws.on("message", (data, isBinary) => {
    const f = isBinary ? decodeFrame(data) : null;
    if (!f) return;
    deck.frames.push(f);
    const m = f.op === OP.DATA ? null : JSON.parse(f.payload.toString() || "{}");
    if (f.op === OP.OPEN) {
      deck.opens.push({ ch: f.ch, ...m });
      fakeDriver(deck, f.ch, m.argv);
    } else if (f.op === OP.DATA && deck.chans.has(f.ch)) deck.chans.get(f.ch)(f.payload);
    else if (f.op === OP.CLOSE && deck.chans.delete(f.ch)) deck.send(OP.CLOSE, f.ch, { code: 0 }); // killed
  });
  deck.beat(true);
  deck.send(OP.HELLO, 0, { v: 1, device: DEVICE, os: "win32", deck: "0.0.0-test", driver: { ok: true, version: "0.33.3" }, desktop: true, pid, token: deckToken });
  const ready = await until(() => deck.frames.find((f) => f.op === OP.READY));
  deck.ready = JSON.parse(ready.payload.toString());
  return deck;
}

// cua-driver 0.33.3 under the grant's manifest (desktop.display: false), as measured on a real driver: a listing
// without a pid, and any list_apps, is refused as desktop display observation; list_windows {pid} answers that
// process's windows. The CLI prints the refusal on stdout and exits 1; MCP answers isError with the same text.
const REFUSAL = {
  refusal: { code: "bounded_resource_outside_manifest", message: "protected resource is outside the capability manifest: desktop display observation is outside the capability manifest" },
  status: "refused",
};
const boundedListing = (deck, name, args) => {
  const pid = args && Number.isInteger(args.pid) && args.pid > 0 ? args.pid : null;
  if (name === "list_apps" || (name === "list_windows" && !pid)) return null;
  return { windows: deck.windows.filter((w) => w.pid === pid) };
};

/** cua-driver as the deck would run it: manifest, a one-shot `call`, and an MCP server that answers each request. */
function fakeDriver(deck, ch, argv) {
  const out = (obj) => deck.send(OP.DATA, ch, Buffer.from(JSON.stringify(obj) + "\n"));
  if (argv[0] === "manifest") {
    deck.send(OP.DATA, ch, Buffer.from(JSON.stringify(MANIFEST)));
    return deck.send(OP.CLOSE, ch, { code: 0 });
  }
  if (argv[0] === "call") {
    deck.calls.push({ cli: argv });
    const listing = boundedListing(deck, argv[1], JSON.parse(argv[2] || "{}"));
    deck.send(OP.DATA, ch, Buffer.from(JSON.stringify(listing || REFUSAL)));
    return deck.send(OP.CLOSE, ch, { code: listing ? 0 : 1 });
  }
  if (argv[0] !== "mcp") return deck.send(OP.CLOSE, ch, { code: 126, error: "verb not allowed" });
  let buf = "";
  deck.chans.set(ch, (b) => {
    buf += b.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const req = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      deck.calls.push(req);
      if (req.id === undefined) continue;
      const name = req.params && req.params.name;
      if (name === "list_windows" || name === "list_apps") {
        const listing = boundedListing(deck, name, req.params.arguments);
        const result = listing
          ? { content: [{ type: "text", text: JSON.stringify(listing.windows) }], structuredContent: listing }
          : { content: [{ type: "text", text: REFUSAL.refusal.message }], isError: true, structuredContent: REFUSAL };
        out({ jsonrpc: "2.0", id: req.id, result });
      } else out({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: `ran ${req.method}${name ? " " + name : ""}` }] } });
    }
  });
}

/** deck-cua as Hermes runs it (a real process), on the given socket. */
function wrapper(sock, argv, env = {}) {
  const p = spawn(process.execPath, [WRAPPER, ...argv], {
    env: { ...process.env, DECK_DRIVER_SOCK: sock, DECK_RELAY_ENV: path.join(os.tmpdir(), "no-such-relay.env"), DECK_CUA_SELF: SELF, HERMES_HOME: HOME_SCOUT, HERMES_SESSION_KEY: SKEY, HERMES_SESSION_ID: "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const r = { p, out: [], err: "" };
  p.stdout.on("data", (b) => r.out.push(b));
  p.stderr.on("data", (b) => (r.err += b));
  r.exit = new Promise((resolve) => p.on("exit", (code) => resolve(code)));
  r.text = () => Buffer.concat(r.out).toString();
  r.lines = () => r.text().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  r.send = (obj) => p.stdin.write(JSON.stringify(obj) + "\n");
  return r;
}

/** What the deck-events plugin asks before a computer_use call. */
function query(sock, ident = { profile: "scout", skey: SKEY, sid: "" }) {
  return new Promise((resolve, reject) => {
    const s = net.connect(sock);
    let buf = "";
    s.on("connect", () => s.write(JSON.stringify({ t: "query", v: 1, ...ident }) + "\n"));
    s.on("data", (b) => {
      buf += b;
      const i = buf.indexOf("\n");
      if (i >= 0) {
        resolve(JSON.parse(buf.slice(0, i)));
        s.destroy();
      }
    });
    s.on("error", reject);
  });
}

const post = (relay, p, body, token = TOKEN) =>
  fetch(`http://127.0.0.1:${relay.port}${p}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

// ---------------------------------------------------------------------------------------------------------------

test("device tokens: only hashes at rest, matched by hash, revocable", () => {
  const file = path.join(tmpDir(), "devices.json");
  const tok = devtokens.add(file, "office-pc");
  assert.match(tok, /^[a-f0-9]{64}$/);
  assert.ok(!fs.readFileSync(file, "utf8").includes(tok));
  assert.strictEqual(devtokens.match(file, tok), "office-pc");
  assert.strictEqual(devtokens.match(file, "f".repeat(64)), null);
  assert.throws(() => devtokens.add(file, "office-pc"), /already has a token/);
  assert.throws(() => devtokens.add(file, "../evil"), /device name/);
  assert.deepStrictEqual(devtokens.list(file).map((r) => r.name), ["office-pc"]);
  assert.ok(devtokens.stillValid(file, "office-pc", devtokens.hash(tok)));
  assert.strictEqual(devtokens.revoke(file, "office-pc"), true);
  assert.strictEqual(devtokens.match(file, tok), null);
  assert.ok(!devtokens.stillValid(file, "office-pc", devtokens.hash(tok)));
});

test("driver wire: one routing key for deck-cua and the plugin, device argv, framing", () => {
  assert.strictEqual(wire.profileFromHome(HOME_SCOUT), "scout");
  assert.strictEqual(wire.profileFromHome(path.join(os.tmpdir(), "hermes-home")), "default");
  assert.strictEqual(wire.profileFromHome(""), "default");
  assert.strictEqual(wire.routeKey({ profile: "scout", skey: SKEY, sid: "s1" }), `p:scout/k:${SKEY}`); // the gateway key wins
  assert.strictEqual(wire.routeKey({ profile: "scout", sid: "s1" }), "p:scout/s:s1");
  assert.strictEqual(wire.routeKey({ profile: "scout" }), "p:scout");
  // a `call get_window_state` loses Hermes' temp path on the agent host; anything else is untouched
  const argv = ["call", "get_window_state", JSON.stringify({ pid: 1, window_id: 2, screenshot_out_file: "/tmp/cua_shot_x.png" })];
  assert.deepStrictEqual(JSON.parse(wire.deviceArgv(argv)[2]), { pid: 1, window_id: 2 });
  assert.deepStrictEqual(wire.deviceArgv(["mcp"]), ["mcp"]);
  const got = [];
  const feed = wire.lineReader((m) => got.push(m));
  feed(Buffer.from('{"a":1}\n{"b"'));
  feed(Buffer.from(":2}\n"));
  assert.deepStrictEqual(got, [{ a: 1 }, { b: 2 }]);
  let bad = null;
  wire.lineReader(() => {}, (e) => (bad = e.message))(Buffer.from("nope\n"));
  assert.strictEqual(bad, "bad JSON line");
  const f = decodeFrame(encodeFrame(OP.OPEN, 7, { argv: ["mcp"] }));
  assert.deepStrictEqual([f.op, f.ch, JSON.parse(f.payload)], [OP.OPEN, 7, { argv: ["mcp"] }]);
  assert.strictEqual(decodeFrame(Buffer.from([0xcd, 1, 0, 0, 0, 1])), null); // a CDP tunnel frame is not ours
  assert.strictEqual(deckCua.rewriteManifest(JSON.stringify(MANIFEST), SELF).includes(SELF), true);
  assert.strictEqual(deckCua.rewriteManifest("usage: cua-driver ...", SELF), "usage: cua-driver ...");
});

test("mcp fence: each driver call stays on the handed window; listings are filtered", () => {
  const ctx = { grant: fenceGrant(GRANT, 999), deckPid: 999, device: "Test PC" };
  const ok = (name, args) => checkCall(name, args, ctx).ok;
  assert.ok(ok("start_session", { session: "hermes-1" }));
  assert.ok(ok("get_window_state", { pid: 4242, window_id: 77 }));
  assert.ok(ok("click", { pid: 4242, window_id: 77, element_index: 3 }));
  assert.ok(ok("type_text", { pid: 4242, window_id: 77, text: "hi" }));
  assert.ok(ok("screenshot", { window_id: 77 }));
  assert.ok(ok("launch_app", { name: "notepad" }));
  assert.ok(!ok("get_window_state", { pid: 4242 })); // no window = the frontmost one, the user's
  assert.ok(!ok("get_window_state", { pid: 4242, window_id: 78 }));
  assert.ok(!ok("click", { window_id: 77 })); // no pid
  assert.ok(!ok("click", { pid: 5150, window_id: 90 }));
  assert.ok(!ok("hotkey", { pid: 4242, window_id: 77, keys: ["ctrl", "v"], delivery_mode: "foreground" }));
  for (const name of ["get_desktop_state", "clipboard_read", "kill_app", "bring_to_front", "browser_navigate", "move_cursor", "something_new"]) assert.ok(!ok(name, { pid: 4242, window_id: 77 }), name);
  assert.ok(!ok("launch_app", { name: "Chrome" }));
  assert.ok(!ok("set_config", { key: "capture_scope", value: "desktop" }));
  assert.ok(ok("set_config", { key: "max_image_dimension", value: 1456 }));
  assert.ok(!checkCall("get_window_state", { pid: 4242, window_id: 77 }, { ...ctx, grant: null }).ok);
  assert.strictEqual(fenceGrant({ ...GRANT, window: { id: 5, pid: 999 } }, 999), null); // the deck's own window
  assert.strictEqual(fenceGrant({ ...GRANT, expires: Date.now() - 1 }, 999), null);
  // list_windows is pinned to the handed process: the device's driver refuses a listing without a pid
  // (desktop.display: false), and Hermes never sends one
  assert.deepStrictEqual(checkCall("list_windows", { on_screen_only: true, session: "h" }, ctx), { ok: true, filter: "list_windows", args: { on_screen_only: true, session: "h", pid: 4242 } });
  assert.deepStrictEqual(checkCall("list_windows", { pid: 0 }, ctx).args, { pid: 4242 }); // a zero-filled pid means unset
  assert.deepStrictEqual(checkCall("list_windows", { pid: "4242" }, ctx).args, { pid: 4242 }); // the driver's schema wants an integer
  assert.deepStrictEqual(checkCall("list_windows", { pid: 4242 }, ctx), { ok: true, filter: "list_windows", args: { pid: 4242 } }); // always re-serialized
  // no pid shape reaches the device as sent: anything but a positive integer is pinned, a foreign one refused
  for (const pid of [-1, [4242], [5150], 4242.5, true, null, "abc", " 5150"]) assert.deepStrictEqual(checkCall("list_windows", { pid }, ctx).args, { pid: 4242 }, JSON.stringify(pid));
  for (const pid of ["5150", 1e20]) assert.ok(!ok("list_windows", { pid }), JSON.stringify(pid));
  for (const args of ["pid=5150", [5150]]) assert.deepStrictEqual(checkCall("list_windows", args, ctx).args, { pid: 4242 });
  assert.match(checkCall("list_windows", { pid: 5150 }, ctx).message, /list_windows on Test PC may only list Notepad \(notes\.txt\)/);
  assert.ok(!ok("list_windows", { pid: 999 })); // the Deck itself
  assert.ok(!checkCall("list_windows", {}, { ...ctx, grant: null }).ok);
  // list_apps has no pid filter in the driver: asked as list_windows on the handed process
  assert.deepStrictEqual(checkCall("list_apps", { session: "h" }, ctx), { ok: true, filter: "list_apps", tool: "list_windows", args: { pid: 4242, on_screen_only: false, session: "h" } });
  assert.ok(!checkCall("list_apps", {}, { ...ctx, grant: null }).ok);
  // ... and answered with the handed app as one row, nothing else of the listing
  assert.deepStrictEqual(appsAnswer({ structuredContent: { windows: WINDOWS } }, ctx.grant), { apps: [{ name: "Notepad", pid: 4242, running: true }] });
  assert.deepStrictEqual(appsAnswer({ windows: [{ ...WINDOWS[1], app_name: "notepad.exe" }] }, ctx.grant), { apps: [{ name: "notepad.exe", pid: 4242, running: true, display_name: "Notepad" }] });
  assert.deepStrictEqual(appsAnswer({ windows: [WINDOWS[2]] }, ctx.grant), { apps: [] }); // its process has no window: not running
  assert.deepStrictEqual(appsAnswer({ windows: WINDOWS }, null), { apps: [] });

  const toDevice = [];
  const toHermes = [];
  const fence = new McpFence({ ctx: () => ctx, toDevice: (b) => toDevice.push(b.toString()), toHermes: (b) => toHermes.push(b.toString()) });
  const call = (id, name, args) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n";
  fence.fromHermes(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }) + "\n" + call(1, "get_desktop_state", {}) + call(2, "list_windows", {})));
  fence.fromHermes(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/read", params: {} }) + "\n"));
  assert.strictEqual(toDevice.length, 2); // initialize and list_windows; the rest never reached the device
  assert.deepStrictEqual(JSON.parse(toDevice[1]), { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_windows", arguments: { pid: 4242 } } });
  const refused = toHermes.map((l) => JSON.parse(l));
  assert.strictEqual(refused[0].id, 1);
  assert.strictEqual(refused[0].result.isError, true);
  assert.match(refused[0].result.content[0].text, /get_desktop_state is not available/);
  assert.strictEqual(refused[1].error.code, -32601);
  // the listing answer comes back with the handed window only, its text part rewritten too
  const answer = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(WINDOWS) }], structuredContent: { windows: WINDOWS } } });
  fence.fromDevice(Buffer.from(answer.slice(0, 40)));
  fence.fromDevice(Buffer.from(answer.slice(40) + "\n"));
  const filtered = JSON.parse(toHermes[2]);
  assert.deepStrictEqual(filtered.result.structuredContent.windows.map((w) => w.window_id), [77]);
  assert.ok(!toHermes[2].includes("private.txt") && !toHermes[2].includes("bank"));
  fence.fromDevice(Buffer.from('{"jsonrpc":"2.0","id":9,"result":{}}\n'));
  assert.strictEqual(toHermes[3], '{"jsonrpc":"2.0","id":9,"result":{}}\n'); // anything else passes byte for byte

  // list_apps: the device is asked list_windows on the handed process; Hermes gets one app row and no titles
  fence.fromHermes(Buffer.from(call(4, "list_apps", { session: "h" })));
  assert.deepStrictEqual(JSON.parse(toDevice[2]).params, { name: "list_windows", arguments: { pid: 4242, on_screen_only: false, session: "h" } });
  fence.fromDevice(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "Notepad: notes.txt, private.txt" }], structuredContent: { windows: WINDOWS.slice(0, 2), current_space_id: 1 } } }) + "\n"));
  const apps = JSON.parse(toHermes[4]);
  assert.strictEqual(apps.id, 4);
  assert.deepStrictEqual(apps.result.structuredContent, { apps: [{ name: "Notepad", pid: 4242, running: true }] });
  assert.deepStrictEqual(JSON.parse(apps.result.content[0].text), apps.result.structuredContent);
  assert.ok(!toHermes[4].includes(".txt"));

  // a refusal keeps its reason, which is all Hermes reads; an empty listing says the handed window is gone
  fence.fromHermes(Buffer.from(call(5, "list_windows", { pid: 4242 }) + call(6, "list_windows", { on_screen_only: true })));
  assert.strictEqual(toDevice[3], call(5, "list_windows", { pid: 4242 })); // nothing to pin: re-serialized, same text
  const why = "protected resource is outside the capability manifest: desktop display observation is outside the capability manifest";
  const refusal = { refusal: { code: "bounded_resource_outside_manifest", message: why }, status: "refused" };
  fence.fromDevice(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: why }], isError: true, structuredContent: refusal } }) + "\n"));
  fence.fromDevice(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 6, result: { content: [{ type: "text", text: "private.txt" }], structuredContent: { windows: [WINDOWS[1]] } } }) + "\n"));
  const kept = JSON.parse(toHermes[5]);
  assert.deepStrictEqual([kept.result.isError, kept.result.content], [true, [{ type: "text", text: why }]]);
  const gone = JSON.parse(toHermes[6]);
  assert.strictEqual(gone.result.isError, true);
  assert.match(gone.result.content[0].text, /^Bot ekranı: the handed window, Notepad \(notes\.txt\), is not on screen on Test PC/);
  assert.ok(!toHermes[6].includes("private.txt"));

  // a duplicate "pid" key parses here as the last one; the device only ever sees one, the granted pid
  fence.fromHermes(Buffer.from('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_windows","arguments":{"pid":5150,"pid":4242}}}\n'));
  assert.strictEqual(toDevice.at(-1), call(7, "list_windows", { pid: 4242 }));
  assert.ok(!toDevice.at(-1).includes("5150"));
});

test("foreground input needs local consent and the exact live window", () => {
  const args = { pid: 4242, window_id: 77, delivery_mode: "foreground", x: 5, y: 5 };
  for (const value of [undefined, false, "true", 1, true]) {
    const grant = fenceGrant({ ...GRANT, foreground: value }, 999);
    assert.strictEqual(grant.foreground, value === true);
    assert.strictEqual(checkCall("click", args, { grant }).ok, value === true);
  }
  const grant = fenceGrant({ ...GRANT, foreground: true }, 999);
  for (const bad of [{ ...args, pid: 5150 }, { ...args, window_id: 78 }, { ...args, window_id: undefined }, { ...args, pid: undefined }, { ...args, scope: "desktop" }]) {
    assert.strictEqual(checkCall("click", bad, { grant }).ok, false);
  }
  for (const name of ["bring_to_front", "get_desktop_state", "clipboard_read", "kill_app", "get_window_state"]) {
    assert.strictEqual(checkCall(name, args, { grant }).ok, false);
  }
  assert.strictEqual(checkCall("click", args, { grant: null }).ok, false);
  const expired = fenceGrant({ ...GRANT, foreground: true, expires: Date.now() - 1 }, 999);
  assert.strictEqual(checkCall("click", args, { grant: expired }).ok, false);
});

test("mcp fence: a request id that is still waiting for its answer is refused, so no answer slips past the filter", () => {
  const ctx = { grant: fenceGrant(GRANT, 999), deckPid: 999, device: "Test PC" };
  const toDevice = [];
  const toHermes = [];
  const fence = new McpFence({ ctx: () => ctx, toDevice: (b) => toDevice.push(b.toString()), toHermes: (b) => toHermes.push(b.toString()) });
  const call = (id, name, args) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n";
  const listing = (id) => JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "notes.txt, SECRET other doc.txt" }], structuredContent: { windows: WINDOWS } } }) + "\n";

  // two listings under one id: the second never reaches the device, and both answers Hermes gets are cut
  fence.fromHermes(Buffer.from(call(9, "list_windows", {}) + call(9, "list_apps", {})));
  assert.strictEqual(toDevice.length, 1);
  assert.strictEqual(fence.refused, 1);
  const dup = JSON.parse(toHermes[0]);
  assert.deepStrictEqual([dup.id, dup.result.isError], [9, true]);
  assert.match(dup.result.content[0].text, /request id 9 is already waiting for an answer/);
  fence.fromDevice(Buffer.from(listing(9))); // the one answer the device owes: cut to the handed window
  assert.strictEqual(toHermes.length, 2);
  assert.deepStrictEqual(JSON.parse(toHermes[1]).result.structuredContent.windows.map((w) => w.window_id), [77]);
  assert.ok(!toHermes[1].includes("SECRET") && !toHermes[1].includes("private.txt"));

  // any method counts: a capture still in flight blocks a listing under its id, and the id is free once answered
  fence.fromHermes(Buffer.from(call(10, "get_window_state", { pid: 4242, window_id: 77 }) + call(10, "list_windows", {})));
  assert.strictEqual(toDevice.length, 2);
  assert.match(JSON.parse(toHermes[2]).result.content[0].text, /request id 10 is already waiting/);
  fence.fromHermes(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "10", method: "ping" }) + "\n")); // "10" is not 10
  assert.strictEqual(toDevice.length, 3);
  fence.fromHermes(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "10", method: "ping" }) + "\n"));
  assert.strictEqual(JSON.parse(toHermes[3]).error.code, -32600); // a non-tools/call duplicate gets a JSON-RPC error
  fence.fromDevice(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "sampling/createMessage", params: {} }) + "\n")); // the device's own request
  fence.fromHermes(Buffer.from(call(10, "list_windows", {})));
  assert.strictEqual(toDevice.length, 3); // a device request with that id does not end Hermes' request
  fence.fromDevice(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 10, result: { content: [] } }) + "\n"));
  fence.fromHermes(Buffer.from(call(10, "list_windows", {})));
  assert.strictEqual(toDevice.length, 4);
  assert.deepStrictEqual(JSON.parse(toDevice[3]).params.arguments, { pid: 4242 });
  fence.fromDevice(Buffer.from(listing(10)));
  assert.deepStrictEqual(JSON.parse(toHermes.at(-1)).result.structuredContent.windows.map((w) => w.window_id), [77]);

  // a listing without an id could not be matched to its answer: it never reaches the device
  const before = [toDevice.length, toHermes.length, fence.refused];
  fence.fromHermes(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "list_apps", arguments: {} } }) + "\n"));
  fence.fromHermes(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: null, method: "tools/call", params: { name: "list_windows", arguments: {} } }) + "\n"));
  assert.deepStrictEqual([toDevice.length, toHermes.length, fence.refused], [before[0], before[1], before[2] + 2]);
});

test("bot screen end-to-end: deck-cua over a deck's own relay connection, fenced", async (t) => {
  const { relay, sock, deckToken } = await relayWithDriver();
  t.after(() => relay.stop());

  // a wrong device token gets READY {ok:false} and the deck hosts nothing
  const intruder = await connectDeck(relay, "0".repeat(64));
  assert.strictEqual(intruder.ready.ok, false);
  intruder.ws.close();

  const deck = await connectDeck(relay, deckToken);
  assert.deepStrictEqual(deck.ready, { ok: true });

  // manifest: answered by the device's driver, MCP command pointed back at the wrapper
  const m = wrapper(sock, ["manifest"]);
  assert.strictEqual(await m.exit, 0, m.err);
  const manifest = JSON.parse(m.text());
  assert.strictEqual(manifest.mcp_invocation.command, SELF);
  assert.deepStrictEqual(manifest.mcp_invocation.args, ["mcp"]);
  assert.deepStrictEqual(deck.opens[0], { ch: deck.opens[0].ch, argv: ["manifest"], agent: "Scout", profile: "scout", sid: SKEY });

  // the plugin's query: same route, no grant yet, the deck's pid for its fence
  let q = await query(sock);
  assert.deepStrictEqual([q.ok, q.device, q.name, q.grant, q.deckPid, q.live], [true, DEVICE, "Test PC", null, 999, false]);
  deck.send(OP.GRANT, 0, { grant: GRANT });
  for (let i = 0; i < 200 && !(q = await query(sock)).grant; i++) await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(q.grant.window.id, 77);
  assert.strictEqual(q.grant.foreground, false);
  for (const value of ["true", true, false]) {
    deck.send(OP.GRANT, 0, { grant: { ...GRANT, foreground: value } });
    await until(async () => (await query(sock)).grant.foreground === (value === true));
  }
  assert.strictEqual((await query(sock, { profile: "research", skey: SKEY })).grant, null); // handed to Scout, not to research

  // one MCP session end to end: allowed calls reach the device, the rest is answered by the relay
  const s = wrapper(sock, ["mcp"]);
  s.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  s.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_window_state", arguments: { pid: 4242, window_id: 77 } } });
  s.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_desktop_state", arguments: {} } });
  s.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_windows", arguments: {} } });
  s.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "launch_app", arguments: { name: "Chrome" } } });
  s.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "list_apps", arguments: { session: "h" } } });
  const answers = await until(() => (s.lines().length >= 6 ? s.lines() : null));
  const byId = Object.fromEntries(answers.map((a) => [a.id, a]));
  assert.strictEqual(byId[2].result.content[0].text, "ran tools/call get_window_state");
  assert.strictEqual(byId[3].result.isError, true);
  // the fake device driver refuses a list_windows without a pid, as the real one does under display: false
  assert.deepStrictEqual(byId[4].result.structuredContent.windows.map((w) => w.window_id), [77]);
  assert.strictEqual(byId[5].result.isError, true);
  assert.deepStrictEqual(byId[6].result.structuredContent, { apps: [{ name: "Notepad", pid: 4242, running: true }] });
  assert.deepStrictEqual(deck.calls.map((c) => (c.params && c.params.name) || c.method), ["initialize", "get_window_state", "list_windows", "list_windows"]);
  assert.deepStrictEqual(deck.calls.slice(2).map((c) => c.params.arguments), [{ pid: 4242 }, { pid: 4242, on_screen_only: false, session: "h" }]);
  assert.strictEqual((await query(sock)).live, true);
  s.p.stdin.end(); // Hermes closes its MCP session
  assert.strictEqual(await s.exit, 0, s.err);

  // a CLI `call` is fenced at the door, and its listing comes back filtered
  const bad = wrapper(sock, ["call", "get_desktop_state", "{}"]);
  assert.strictEqual(await bad.exit, 69);
  assert.match(bad.err, /deck-cua: Bot ekranı: get_desktop_state is not available/);
  const lw = wrapper(sock, ["call", "list_windows", "{}"]);
  assert.strictEqual(await lw.exit, 0, lw.err);
  assert.deepStrictEqual(JSON.parse(lw.text()).windows.map((w) => w.window_id), [77]);
  const la = wrapper(sock, ["call", "list_apps", "{}"]);
  assert.strictEqual(await la.exit, 0, la.err);
  assert.deepStrictEqual(JSON.parse(la.text()), { apps: [{ name: "Notepad", pid: 4242, running: true }] });
  // what the device ran: both pinned to the handed pid, list_apps as list_windows
  assert.deepStrictEqual(deck.calls.filter((c) => c.cli).map((c) => c.cli), [
    ["call", "list_windows", '{"pid":4242}'],
    ["call", "list_windows", '{"pid":4242,"on_screen_only":false}'],
  ]);
  const other = wrapper(sock, ["call", "list_windows", '{"pid":5150}']);
  assert.strictEqual(await other.exit, 69);
  assert.match(other.err, /list_windows on Test PC may only list Notepad/);

  // verbs outside the allowlist never reach a device
  const serve = wrapper(sock, ["serve", "--socket", "/tmp/x"]);
  assert.strictEqual(await serve.exit, 126);
  assert.match(serve.err, /cannot run on a device/);
  assert.ok(!deck.opens.some((o) => o.argv[0] === "serve"));
});

test("bot screen: no route, no relay, and the agent host as fallback", async (t) => {
  // no device and DECK_DESKTOP_HOST off: one line the agent can read, exit 69
  const a = await relayWithDriver();
  t.after(() => a.relay.stop());
  const w = wrapper(a.sock, ["manifest"]);
  assert.strictEqual(await w.exit, 69);
  assert.match(w.err, /^deck-cua: Bot ekranı: no device is available/);
  assert.ok(w.err.trim().split("\n").pop().length <= 200, "Hermes keeps 200 chars of the last stderr line");
  const q = await query(a.sock);
  assert.strictEqual(q.ok, false);
  // no relay at all
  const down = wrapper(a.sock + "-missing", ["manifest"]);
  assert.strictEqual(await down.exit, 75);
  assert.match(down.err, /relay is not running/);

  // DECK_DESKTOP_HOST=1: the local driver runs here (spawn faked); manifest rewritten, a stop ends the session
  const b = await relayWithDriver({ desktopHost: true });
  t.after(() => b.relay.stop());
  const driverPath = path.join(b.dir, "cua-driver");
  fs.writeFileSync(driverPath, "");
  const spawned = [];
  const fakeSpawn = (cmd, argv, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.killed = [];
    child.kill = (sig) => {
      child.killed.push(sig);
      setImmediate(() => child.emit("close", null, sig));
      return true;
    };
    spawned.push({ cmd, argv, opts, child });
    if (argv[0] === "manifest") {
      setImmediate(() => {
        child.stdout.end(JSON.stringify(MANIFEST));
        setImmediate(() => child.emit("close", 0, null));
      });
    }
    return child;
  };
  const io = () => {
    const out = [];
    const err = [];
    return { out, err, stdout: { write: (x) => out.push(String(x)) }, stderr: { write: (x) => err.push(String(x)) } };
  };
  const base = { env: { HERMES_HOME: HOME_SCOUT, HERMES_SESSION_KEY: SKEY, PATH: "" }, self: SELF, settings: { sock: b.sock, driver: driverPath }, spawn: fakeSpawn, signals: new EventEmitter(), stdin: () => assert.fail("a host route must never open stdin") };
  const m = io();
  assert.strictEqual(await deckCua.run({ ...base, ...m, argv: ["manifest"] }), 0);
  assert.strictEqual(JSON.parse(m.out.join("")).mcp_invocation.command, SELF);
  assert.deepStrictEqual([spawned[0].cmd, spawned[0].argv, spawned[0].opts.stdio[1]], [driverPath, ["manifest"], "pipe"]);
  assert.strictEqual((await query(b.sock)).device, "host");

  const s = io();
  const session = deckCua.run({ ...base, ...s, argv: ["mcp"] });
  await until(() => spawned.length === 2);
  assert.strictEqual(spawned[1].opts.stdio, "inherit");
  const res = await (await post(b.relay, "/desktop/stop", { device: "host" })).json();
  assert.deepStrictEqual([res.ok, res.wrappers], [true, 1]);
  assert.strictEqual(await session, 75);
  assert.deepStrictEqual(spawned[1].child.killed, ["SIGTERM"]);
  assert.match(s.err.join(""), /stopped from Hermes Deck/);
  // a wrapper that would run itself as the local driver refuses
  const loop = io();
  assert.strictEqual(await deckCua.run({ ...base, ...loop, settings: { sock: b.sock, driver: WRAPPER }, self: WRAPPER, argv: ["manifest"] }), 127);
  assert.match(loop.err.join(""), /points at deck-cua itself/);
});

test("bot screen: stop, device loss, a local Durdur and a revoked token end the device's sessions", async (t) => {
  const { relay, sock, deckToken, cfg } = await relayWithDriver();
  t.after(() => relay.stop());
  const deck = await connectDeck(relay, deckToken);
  const live = () => {
    const s = wrapper(sock, ["mcp"]);
    s.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    return s;
  };

  let s = live();
  await until(() => s.lines().length === 1);
  const res = await (await post(relay, "/desktop/stop", { device: DEVICE })).json();
  assert.deepStrictEqual([res.ok, res.devices, res.wrappers], [true, [DEVICE], 1]);
  assert.strictEqual(await s.exit, 75);
  assert.match(s.err, /stopped from Hermes Deck/);
  assert.ok(deck.frames.some((f) => f.op === OP.STOP));
  assert.strictEqual(relay.presence.state().routes.length, 0); // the route is gone too
  assert.strictEqual((await (await post(relay, "/desktop/stop", { device: "../x" })).json()).ok, false);

  // the user turns hosting off on the device: its route is lost and the session ends
  s = live();
  await until(() => s.lines().length === 1);
  deck.beat(false);
  assert.strictEqual(await s.exit, 75);
  assert.match(s.err, /no longer available/);
  deck.beat(true);

  // Durdur on the device itself
  s = live();
  await until(() => s.lines().length === 1);
  deck.send(OP.STOPPED, 0, { by: "hotkey" });
  assert.strictEqual(await s.exit, 75);
  assert.match(s.err, /hotkey/);

  // the device token is revoked on the agent host
  s = live();
  await until(() => s.lines().length === 1);
  devtokens.revoke(cfg.driver.tokensFile, "test-pc");
  relay.driver._checkTokens();
  assert.strictEqual(await s.exit, 75);
  const ready = deck.frames.filter((f) => f.op === OP.READY).pop();
  assert.strictEqual(JSON.parse(ready.payload).ok, false);
  const w = wrapper(sock, ["manifest"]);
  assert.strictEqual(await w.exit, 69);
  assert.match(w.err, /no driver channel/);
});

test("bot screen (POSIX): a 0600 socket, the plugin's own query, and the sh shim through a symlink", { skip: process.platform === "win32" && "Unix sockets and sh only" }, async (t) => {
  const { relay, sock, deckToken, dir } = await relayWithDriver();
  t.after(() => relay.stop());
  assert.strictEqual(fs.statSync(sock).mode & 0o777, 0o600);
  await connectDeck(relay, deckToken);
  const run = (cmd, args, env) =>
    new Promise((resolve) => {
      const p = spawn(cmd, args, { env: { ...process.env, ...env } });
      let out = "";
      let err = "";
      p.stdout.on("data", (b) => (out += b));
      p.stderr.on("data", (b) => (err += b));
      p.on("error", () => resolve({ code: -1, out, err }));
      p.on("exit", (code) => resolve({ code, out, err }));
    });
  // the plugin's real socket client against the real relay: hermes-deck's events part, and the deprecated
  // deck-events plugin that existing installs still run
  const py = process.env.DECK_TEST_PYTHON || "python3";
  const code = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('deck_events', sys.argv[1])",
    "de = importlib.util.module_from_spec(spec); spec.loader.exec_module(de)",
    "print(json.dumps(de._relay_query({'sid': '', 'skey': sys.argv[2], 'profile': 'scout'})))",
  ].join("\n");
  for (const plugin of [["hermes-deck", "events.py"]]) {
    const q = await run(py, ["-c", code, path.join(__dirname, "..", "..", "hermes-plugin", ...plugin), SKEY], { DECK_DRIVER_SOCK: sock });
    if (q.code === -1) t.diagnostic("python3 not found; plugin query not checked");
    else assert.deepStrictEqual(((r) => [r.ok, r.device, r.deckPid])(JSON.parse(q.out)), [true, DEVICE, 999], `${plugin[0]}: ${q.err}`);
  }
  // Hermes runs the shim through a symlink: it must find deck-cua.js and report the symlink as the MCP command
  const link = path.join(dir, "deck-cua");
  fs.symlinkSync(path.join(__dirname, "..", "bin", "deck-cua"), link);
  const m = await run(link, ["manifest"], { DECK_DRIVER_SOCK: sock, DECK_RELAY_ENV: path.join(dir, "none.env"), HERMES_HOME: HOME_SCOUT, HERMES_SESSION_KEY: SKEY, DECK_NODE: process.execPath });
  assert.strictEqual(m.code, 0, m.err);
  assert.strictEqual(JSON.parse(m.out).mcp_invocation.command, link);
});

test("bot screen: Kontrolü al / geri ver through Hermes' own lease module", async (t) => {
  const py = process.env.DECK_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
  if (spawnSync(py, ["--version"]).status !== 0) return t.skip("no python");
  // a stand-in Hermes checkout: hermes_constants + tools/bot_desktop/lease.py with the same calls
  const src = tmpDir();
  const root = path.join(src, "hermes-root");
  fs.mkdirSync(path.join(root, "profiles", "scout"), { recursive: true });
  fs.mkdirSync(path.join(src, "tools", "bot_desktop"), { recursive: true });
  fs.writeFileSync(path.join(src, "hermes_constants.py"), "import os\nfrom pathlib import Path\n\ndef get_default_hermes_root():\n    return Path(os.environ['FAKE_HERMES_ROOT'])\n");
  fs.writeFileSync(path.join(src, "tools", "__init__.py"), "");
  fs.writeFileSync(path.join(src, "tools", "bot_desktop", "__init__.py"), "");
  fs.writeFileSync(
    path.join(src, "tools", "bot_desktop", "lease.py"),
    [
      "import json",
      "from pathlib import Path",
      "AGENT, HUMAN = 'agent', 'human'",
      "class Lease:",
      "    def __init__(self, holder=AGENT, viewer_id=None):",
      "        self.holder, self.viewer_id = holder, viewer_id",
      "def _f(key):",
      "    return Path(key) / 'bot-desktop' / 'lease.json'",
      "def _get(key):",
      "    try:",
      "        return Lease(**json.loads(_f(key).read_text()))",
      "    except FileNotFoundError:",
      "        return Lease()",
      "def _put(key, lease):",
      "    _f(key).parent.mkdir(parents=True, exist_ok=True)",
      "    _f(key).write_text(json.dumps({'holder': lease.holder, 'viewer_id': lease.viewer_id}))",
      "    return lease",
      "def acquire(viewer_id, *, profile_key=None, reason=''):",
      "    return _put(profile_key, Lease(HUMAN, viewer_id))",
      "def release(viewer_id=None, *, profile_key=None, unless_human=False):",
      "    cur = _get(profile_key)",
      "    if cur.holder == HUMAN and viewer_id is not None and cur.viewer_id != viewer_id:",
      "        return cur",
      "    return _put(profile_key, Lease())",
      "",
    ].join("\n")
  );
  process.env.HERMES_AGENT_DIR = src;
  process.env.FAKE_HERMES_ROOT = root;
  t.after(() => {
    delete process.env.HERMES_AGENT_DIR;
    delete process.env.FAKE_HERMES_ROOT;
  });
  const { relay } = await relayWithDriver({ hermesPython: py });
  t.after(() => relay.stop());
  const lease = async (body) => {
    const r = await post(relay, "/desktop/lease", body);
    return [r.status, await r.json()];
  };
  assert.deepStrictEqual(await lease({ profile: "scout", hold: true }), [200, { ok: true, holder: "human" }]);
  const file = path.join(root, "profiles", "scout", "bot-desktop", "lease.json");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), { holder: "human", viewer_id: "hermes-deck" });
  assert.deepStrictEqual(await lease({ profile: "scout", hold: false }), [200, { ok: true, holder: null }]);
  // another viewer holds it: the Deck's "geri ver" leaves them in control
  fs.writeFileSync(file, JSON.stringify({ holder: "human", viewer_id: "web-viewer" }));
  assert.deepStrictEqual(await lease({ profile: "scout", hold: false }), [200, { ok: true, holder: "human" }]);
  assert.strictEqual((await lease({ profile: "nobody", hold: true }))[0], 404);
  assert.strictEqual((await lease({ profile: "../etc", hold: true }))[0], 400);
  assert.strictEqual((await lease({ profile: "scout" }))[0], 400);
  assert.strictEqual((await post(relay, "/desktop/lease", { profile: "scout", hold: true }, "wrong".repeat(8))).status, 401);
});

test("bot screen: frames are served with the relay token and pruned by age, then size", async (t) => {
  const { relay, cfg } = await relayWithDriver();
  t.after(() => relay.stop());
  const dir = path.join(cfg.driver.cuDir, "scout", "s1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "1.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  fs.writeFileSync(path.join(cfg.driver.deckHome, "secret.jpg"), "x"); // next to cu/, never served
  const get = (p, token = TOKEN) => fetch(`http://127.0.0.1:${relay.port}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const ok = await get("/cu/scout/s1/1.jpg");
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.headers.get("content-type"), "image/jpeg");
  assert.strictEqual((await ok.arrayBuffer()).byteLength, 4);
  assert.strictEqual((await get("/cu/scout/s1/1.jpg", null)).status, 401);
  assert.strictEqual((await get("/cu/..%2Fsecret.jpg")).status, 404);
  assert.strictEqual((await get("/cu/scout/s1/2.jpg")).status, 404);
  fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  assert.strictEqual((await get("/cu/scout/s1/notes.txt")).status, 404);

  // prune: the day-old frame goes, then the oldest until the folder fits
  const d = new Driver({ presence: new Presence(), cuDir: path.join(tmpDir(), "cu"), deckHome: tmpDir(), cuMaxBytes: 2500, log: () => {} });
  const s = path.join(d.o.cuDir, "scout", "s2");
  fs.mkdirSync(s, { recursive: true });
  const now = Date.now();
  const frame = (name, ageMin) => {
    const p = path.join(s, name);
    fs.writeFileSync(p, Buffer.alloc(1000));
    const t = (now - ageMin * 60_000) / 1000;
    fs.utimesSync(p, t, t);
    return p;
  };
  const old = frame("1.jpg", 25 * 60);
  const a = frame("2.jpg", 30);
  const b = frame("3.jpg", 20);
  const c = frame("4.png", 10);
  const r = d.prune(now);
  assert.deepStrictEqual([fs.existsSync(old), fs.existsSync(a), fs.existsSync(b), fs.existsSync(c)], [false, false, true, true]);
  assert.deepStrictEqual(r, { removed: 2, total: 2000 });
  await d.stop();
});

test("fence: the agent's own cursor stays visible on a device (two cursors); turning it on or asking stays allowed", () => {
  const grant = { pid: 4242, windowId: 77, app: "Notepad", title: "notes.txt", foreground: false };
  const off = checkCall("set_agent_cursor_enabled", { session: "s", enabled: false }, { grant, device: "pc" });
  assert.equal(off.ok, false);
  assert.match(off.message, /cursor/);
  assert.equal(checkCall("set_agent_cursor_enabled", { session: "s", enabled: true }, { grant, device: "pc" }).ok, true);
  assert.equal(checkCall("get_agent_cursor_state", {}, { grant, device: "pc" }).ok, true);
});
