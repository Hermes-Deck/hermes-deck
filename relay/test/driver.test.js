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
/**
 * Hermes' cua-driver runtime contract for a `manifest` (a port of its _manifest_contract_reason): "" when Hermes'
 * computer_use would start with this driver, else why not.
 */
function hermesContractReason(m) {
  if (!m || typeof m !== "object") return "driver manifest is missing or invalid";
  const v = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(m.binary_version || "").trim());
  if (!v) return "driver manifest does not report a semantic version";
  const [a, b, c] = v.slice(1).map(Number);
  if (a * 1e6 + b * 1e3 + c < 20 * 1e3) return "Hermes computer use requires cua-driver 0.20.0 or newer";
  const args = m.mcp_invocation && m.mcp_invocation.args;
  if (!Array.isArray(args) || !args.every((x) => typeof x === "string")) return "driver manifest does not provide an MCP launch command";
  const need = { mcp: ["--socket", "--grant"], serve: ["--socket", "--permission-mode", "--capability-manifest", "--approve-capability-manifest", "--embedded"], stop: ["--socket"] };
  const have = {};
  for (const s of m.subcommands || []) if (s && typeof s.name === "string") have[s.name] = new Set((s.args || []).filter((x) => x && typeof x.name === "string").map((x) => x.name));
  const missing = Object.entries(need).flatMap(([cmd, flags]) => flags.filter((f) => !(have[cmd] || new Set()).has(f)).map((f) => `${cmd} ${f}`));
  return missing.length ? `driver manifest is missing: ${missing.join(", ")}` : "";
}
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

async function relayWithDriver({ desktopHost = false, spacesMode = null, ...extra } = {}) {
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
    // agent spaces (DECK_SPACES): no cua-spacesd behind it in these tests
    spaces: spacesMode ? { mode: spacesMode, url: "http://127.0.0.1:9", tokenFile: path.join(dir, "no-spacesd-token") } : null,
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

/** deck-cua's side of the local socket by hand: a hello, then data lines; every relay message is kept in order. */
function localClient(sock, hello) {
  const s = net.connect(sock);
  const c = { s, msgs: [], closedAt: null };
  let buf = "";
  s.on("connect", () => s.write(JSON.stringify({ t: "hello", v: 1, sid: "", skey: "", ...hello }) + "\n"));
  s.on("data", (b) => {
    buf += b;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      c.msgs.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  s.on("error", () => {});
  c.closed = new Promise((resolve) => s.on("close", () => resolve((c.closedAt = Date.now()))));
  c.data = (obj) => s.write(JSON.stringify({ t: "data", b64: Buffer.from(JSON.stringify(obj) + "\n").toString("base64") }) + "\n");
  c.raw = (text) => s.write(JSON.stringify({ t: "data", b64: Buffer.from(text).toString("base64") }) + "\n"); // any bytes, e.g. half a line
  c.lines = () => c.msgs.filter((m) => m.t === "data").map((m) => JSON.parse(Buffer.from(m.b64, "base64").toString()));
  return c;
}

/** Task 3's Desktops as the driver sees it: resolve answers what the test says; resolve and touch calls are kept. */
function fakeDesktops(answer) {
  const d = { resolved: [], touched: [] };
  d.resolve = (p) => (d.resolved.push(p), typeof answer === "function" ? answer(p) : Promise.resolve(answer));
  d.touch = (p) => d.touched.push(p);
  d.stop = async () => {};
  d.state = () => "ready";
  d.hosts = () => [];
  d.list = () => [];
  return d;
}

/** cua-spacesd's Streamable HTTP /mcp as the space tunnel answers it: initialize hands out a session id. */
function fakeSpace() {
  const f = { opened: [], reqs: [] };
  f.spaceFetch = (host, profile) => {
    f.opened.push([host, profile]);
    return async (req) => {
      const msg = JSON.parse(Buffer.from(req.body).toString());
      f.reqs.push({ ...req, msg });
      const json = (obj, extra = {}) => ({ status: 200, headers: { "content-type": "application/json", ...extra }, body: Buffer.from(JSON.stringify(obj)) });
      if (msg.id === undefined) return { status: 202, headers: {}, body: Buffer.alloc(0) };
      if (msg.method === "initialize") return json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", serverInfo: { name: "cua-spacesd" } } }, { "mcp-session-id": "sess-1" });
      return json({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "screenshot" }], session: req.headers["mcp-session-id"] || null } });
    };
  };
  return f;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  assert.match(gone.result.content[0].text, /^Bot screen: the handed window, Notepad \(notes\.txt\), is not on screen on Test PC/);
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
  assert.match(bad.err, /deck-cua: Bot screen: get_desktop_state is not available/);
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
  assert.match(w.err, /^deck-cua: Bot screen: no device is available/);
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

// ---- agent spaces phase 2: an agent's own desktop --------------------------------------------------------------
test("F10: device MCP replies reword foreground hints across chunks without changing the approval gate", () => {
  for (const quote of ["'", '"']) {
    const replies = [];
    const fence = new McpFence({ ctx: () => ({}), toDevice() {}, toHermes: (b) => replies.push(String(b)) });
    const hint = `Retry with delivery_mode=${quote}foreground${quote} (separate approval).`;
    const reply = { id: 1, result: { isError: true, structuredContent: { escalation_hint: hint }, content: [{ type: "text", text: JSON.stringify({ escalation_hint: hint }) }] } };
    const encoded = JSON.stringify(reply) + "\n";
    fence.fromDevice(Buffer.from(encoded.slice(0, 47)));
    fence.fromDevice(Buffer.from(encoded.slice(47)));
    const result = JSON.parse(replies.join("")).result;
    assert.doesNotMatch(JSON.stringify(result), /approval/);
    assert.match(result.structuredContent.escalation_hint, /user must allow foreground input in Hermes Deck/);
    assert.equal(JSON.parse(result.content[0].text).escalation_hint, result.structuredContent.escalation_hint);
    const unchanged = '{"id":2,"result":{"isError":true,"content":[{"type":"text","text":"Approval requested: sudo whoami"}]}}\n';
    fence.fromDevice(Buffer.from(unchanged));
    assert.equal(replies.at(-1), unchanged);
  }
});

const AGENT_DESKTOP = { kind: "space", host: "agent-host", port: 1 };

test("overflow: list follows a read-only shared session until sticky expiry", async (t) => {
  let now = 0;
  const { relay, sock } = await relayWithDriver({ spacesMode: "overflow", desktops: fakeDesktops(AGENT_DESKTOP), spaceFetch: fakeSpace().spaceFetch, now: () => now });
  t.after(() => relay.stop());
  const list = async () => (await fetch(`http://127.0.0.1:${relay.port}/spaces`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.equal((await query(sock, { profile: "scout", skey: SKEY, read: true })).device, "host");
  assert.equal(relay.driver.spaces.lock.state().holder, null);
  let row = (await list()).spaces.find((r) => r.id === "scout");
  assert.equal(row.usingShared, true);
  assert.equal(row.state, "off");
  now = 120000;
  row = (await list()).spaces.find((r) => r.id === "scout");
  assert.equal(row.usingShared, false);
  assert.equal(row.state, "off");
});

test("overflow: free shared route takes the phase 1 lock, hello follows it", async (t) => {
  const desktops = fakeDesktops(AGENT_DESKTOP);
  const { relay, sock } = await relayWithDriver({ spacesMode: "overflow", desktops, spaceFetch: fakeSpace().spaceFetch });
  t.after(() => relay.stop());
  const q = await query(sock);
  assert.deepStrictEqual([q.ok, q.device, relay.driver.spaces.lock.state().holder], [true, "host", "scout"]);
  const c = localClient(sock, { argv: ["mcp"], profile: "scout", skey: SKEY });
  assert.strictEqual((await until(() => c.msgs[0])).device, "host");
  assert.deepStrictEqual(desktops.resolved, []);
});

test("overflow: busy shared route uses own desktop, query and hello agree", async (t) => {
  const { relay, sock } = await relayWithDriver({ spacesMode: "overflow", desktops: fakeDesktops(AGENT_DESKTOP), spaceFetch: fakeSpace().spaceFetch });
  t.after(() => relay.stop());
  const lock = relay.driver.spaces.lock;
  lock.request("research");
  assert.strictEqual((await query(sock)).device, "space:scout@agent-host");
  lock.release("research"); // between the plugin's query and the driver's hello
  const c = localClient(sock, { argv: ["mcp"], profile: "scout", skey: SKEY });
  assert.strictEqual((await until(() => c.msgs[0])).device, "space:scout@agent-host");
  assert.strictEqual(lock.state().holder, null);
});

for (const first of ["query", "hello"]) test(`overflow: delayed ${first} keeps the concurrent shared session's desktop`, async (t) => {
  let finishDesktop, resolving;
  const pending = new Promise((resolve) => { finishDesktop = resolve; });
  const started = new Promise((resolve) => { resolving = resolve; });
  const desktops = fakeDesktops(() => { resolving(); return pending; });
  const { relay, sock } = await relayWithDriver({ spacesMode: "overflow", desktops, spaceFetch: fakeSpace().spaceFetch, desktopWaitMs: Infinity, helloDesktopMs: Infinity });
  t.after(() => { finishDesktop(AGENT_DESKTOP); return relay.stop(); });
  const lock = relay.driver.spaces.lock;
  lock.request("research");
  const delayed = first === "query" ? query(sock) : localClient(sock, { argv: ["mcp"], profile: "scout", skey: SKEY });
  await started;
  lock.release("research");
  assert.strictEqual((await query(sock)).device, "host");
  const active = localClient(sock, { argv: ["mcp"], profile: "scout", skey: SKEY });
  assert.strictEqual((await until(() => active.msgs[0])).device, "host");
  assert.strictEqual(lock.state().holder, "scout");

  finishDesktop(AGENT_DESKTOP);
  const route = first === "query" ? await delayed : await until(() => delayed.msgs[0]);
  assert.strictEqual(route.device, "host", "a delayed desktop resolution must keep the newer shared route");
  assert.strictEqual((await query(sock)).device, "host", "the shared choice stays sticky");
  assert.ok(relay.driver.state().sessions.every((s) => s.device === "host"));
  assert.strictEqual(active.closedAt, null);
});

for (const reason of ["offline", "limit", "failed", "none"]) test(`overflow: own desktop unavailable (${reason}) queues with reason`, async (t) => {
  const { relay, sock } = await relayWithDriver({ spacesMode: "overflow", desktops: fakeDesktops({ kind: "fallback", reason }), spaceFetch: fakeSpace().spaceFetch });
  t.after(() => relay.stop());
  relay.driver.spaces.lock.request("research");
  const q = await query(sock);
  assert.deepStrictEqual([q.ok, q.busy], [false, true]);
  assert.match(q.error, /1st in line/);
  assert.match(q.error, { offline: /host is offline/, limit: /host is full/, failed: /could not start/, none: /No desktop host/ }[reason]);
  assert.deepStrictEqual(relay.driver.spaces.lock.state().queue, ["scout"]);
});

test("overflow: device pin overrides a sticky own desktop and the shared desktop", async (t) => {
  const desktops = fakeDesktops(AGENT_DESKTOP);
  const { relay, sock, deckToken } = await relayWithDriver({ spacesMode: "overflow", desktops, spaceFetch: fakeSpace().spaceFetch });
  t.after(() => relay.stop());
  relay.driver.spaces.lock.request("research");
  assert.strictEqual((await query(sock)).device, "space:scout@agent-host");
  await connectDeck(relay, deckToken);
  relay.presence.setPin("p:scout", "desktop", { kind: "device", id: DEVICE });
  const before = desktops.resolved.length;
  assert.strictEqual((await query(sock)).device, DEVICE);
  const c = localClient(sock, { argv: ["mcp"], profile: "scout", skey: SKEY });
  assert.strictEqual((await until(() => c.msgs[0])).device, DEVICE);
  assert.strictEqual(desktops.resolved.length, before);
});

test("overflow: own desktop sticks across reads, expires after inactivity, sessions are independent", async (t) => {
  let now = 0;
  const { relay, sock } = await relayWithDriver({ spacesMode: "overflow", desktops: fakeDesktops(AGENT_DESKTOP), spaceFetch: fakeSpace().spaceFetch, now: () => now });
  t.after(() => relay.stop());
  const lock = relay.driver.spaces.lock;
  lock.request("research");
  assert.strictEqual((await query(sock)).device, "space:scout@agent-host");
  lock.release("research");
  now = 119000;
  assert.strictEqual((await query(sock, { profile: "scout", skey: SKEY, read: true })).device, "space:scout@agent-host");
  assert.strictEqual((await query(sock, { profile: "scout", skey: "another-session" })).device, "host");
  now = 238000; // only 119 s since the read: it refreshed stickiness
  assert.strictEqual((await query(sock)).device, "space:scout@agent-host");
  now = 358000; // exactly 120 s without a call
  assert.strictEqual((await query(sock)).device, "host");
});

test("overflow: shared session losing lock stays busy, including hello, until sticky expiry", async (t) => {
  let now = 0;
  const desktops = fakeDesktops(AGENT_DESKTOP);
  const { relay, sock } = await relayWithDriver({ spacesMode: "overflow", desktops, spaceFetch: fakeSpace().spaceFetch, now: () => now });
  t.after(() => relay.stop());
  const lock = relay.driver.spaces.lock;
  assert.strictEqual((await query(sock)).device, "host");
  lock.release("scout");
  lock.request("research");
  now = 60000;
  const q = await query(sock);
  assert.deepStrictEqual([q.ok, q.busy], [false, true]);
  const c = localClient(sock, { argv: ["mcp"], profile: "scout", skey: SKEY });
  await c.closed;
  assert.equal(c.msgs[0].ok, false);
  assert.match(c.msgs[0].error, /in use by research/);
  assert.deepStrictEqual(desktops.resolved, []);
  now = 180000;
  assert.strictEqual((await query(sock)).device, "space:scout@agent-host");
});

test("overflow: stale sticky entries are swept without another session call", async (t) => {
  let now = 0;
  const { relay, sock } = await relayWithDriver({ spacesMode: "overflow", desktops: fakeDesktops(AGENT_DESKTOP), spaceFetch: fakeSpace().spaceFetch, now: () => now });
  t.after(() => relay.stop());
  assert.equal((await query(sock)).ok, true);
  assert.equal(relay.driver.sticky?.size, 1);
  now = 120000;
  relay.driver.prune(); // existing periodic maintenance, no new timer
  assert.equal(relay.driver.sticky.size, 0);
});

test("overflow: a blocked write replaces earlier read intent before hello", async (t) => {
  const { relay, sock } = await relayWithDriver({ spacesMode: "overflow", desktops: fakeDesktops(AGENT_DESKTOP), spaceFetch: fakeSpace().spaceFetch });
  t.after(() => relay.stop());
  assert.equal((await query(sock)).device, "host");
  relay.driver.spaces.lock.release("scout");
  relay.driver.spaces.lock.request("research");
  assert.equal((await query(sock, { profile: "scout", skey: SKEY, read: true })).device, "host");
  assert.equal((await query(sock)).busy, true);
  const c = localClient(sock, { argv: ["mcp"], profile: "scout", skey: SKEY });
  const route = await until(() => c.msgs[0]);
  assert.equal(route.ok, false, "a previous capture must not let a blocked writer bypass the shared lock");
});

test("overflow: no shared desktop uses own; neither desktop returns the reason", async (t) => {
  let answer = AGENT_DESKTOP;
  const { relay, sock } = await relayWithDriver({ spacesMode: "overflow", desktops: fakeDesktops(() => Promise.resolve(answer)), spaceFetch: fakeSpace().spaceFetch, sharedFallback: false });
  t.after(() => relay.stop());
  assert.strictEqual((await query(sock)).device, "space:scout@agent-host");
  answer = { kind: "fallback", reason: "limit" };
  const q = await query(sock, { profile: "research", skey: "" });
  assert.deepStrictEqual([q.ok, q.busy, q.error], [false, false, "Every desktop host is full right now; retry later or ask the user."]);
  const c = localClient(sock, { argv: ["mcp"], profile: "research" });
  await c.closed;
  assert.equal(c.msgs[0].error, q.error);
});

test("overflow: no shared or own desktop never routes to an unpinned device", async (t) => {
  const { relay, sock, deckToken } = await relayWithDriver({ spacesMode: "overflow", desktops: fakeDesktops({ kind: "fallback", reason: "none" }), spaceFetch: fakeSpace().spaceFetch });
  t.after(() => relay.stop());
  await connectDeck(relay, deckToken);
  relay.presence.fallback.desktop = null;
  const q = await query(sock);
  assert.deepStrictEqual([q.ok, q.error], [false, "No desktop host is available; ask the user."]);
});

test("agent mode: hello for a profile with a desktop answers a space route and pipes MCP through the bridge", async (t) => {
  const desktops = fakeDesktops(AGENT_DESKTOP);
  const space = fakeSpace();
  const { relay, sock } = await relayWithDriver({ spacesMode: "agent", desktops, spaceFetch: space.spaceFetch });
  t.after(() => relay.stop());

  const c = localClient(sock, { argv: ["mcp"], profile: "aurora" });
  const route = await until(() => c.msgs[0]);
  assert.deepStrictEqual(Object.keys(route).sort(), ["device", "epoch", "ok", "t"]);
  assert.deepStrictEqual([route.t, route.ok, route.device], ["route", true, "space:aurora@agent-host"]);
  assert.ok(Number.isInteger(route.epoch));
  assert.deepStrictEqual(desktops.resolved, ["aurora"]);
  assert.deepStrictEqual(space.opened, [["agent-host", "aurora"]]); // the bridge reaches that host, for that agent

  c.data({ jsonrpc: "2.0", id: 1, method: "initialize" });
  const init = await until(() => c.lines()[0]);
  assert.deepStrictEqual([init.id, init.result.serverInfo.name], [1, "cua-spacesd"]);
  c.data({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const list = await until(() => c.lines()[1]);
  assert.deepStrictEqual([list.id, list.result.session], [2, "sess-1"]); // initialize's session id goes along
  assert.deepStrictEqual(space.reqs.map((r) => [r.method, r.path, r.msg.method]), [["POST", "/mcp", "initialize"], ["POST", "/mcp", "tools/list"]]);
  assert.deepStrictEqual(desktops.touched, ["aurora", "aurora"]); // every message keeps the desktop from idling out
  assert.deepStrictEqual(relay.driver.state().sessions, [{ key: "p:aurora", verb: "mcp", device: "space:aurora@agent-host" }]);

  // the plugin's query for the same agent: the same route, and a live session on it; the shared lock stays free
  const q = await query(sock, { profile: "aurora", skey: "", sid: "" });
  assert.deepStrictEqual([q.ok, q.device, q.live], [true, "space:aurora@agent-host", true]);
  assert.strictEqual(relay.driver.spaces.lock.state().holder, null);

  // Hermes ends its MCP session: the wrapper exits 0
  c.s.write(JSON.stringify({ t: "close" }) + "\n");
  await c.closed;
  assert.deepStrictEqual(c.msgs.at(-1), { t: "exit", code: 0 });

  // deck-cua itself (a real process) pipes its stdio over the socket for a space route
  const w = wrapper(sock, ["mcp"]);
  w.send({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} });
  const got = await until(() => w.lines()[0]);
  assert.strictEqual(got.id, 7);
  assert.deepStrictEqual(space.opened.at(-1), ["agent-host", "scout"]);
  w.p.stdin.end();
  assert.strictEqual(await w.exit, 0, w.err);

  // only the MCP transport reaches an agent's own desktop (info verbs are the relay's own: see the fix round 1 test)
  const m = wrapper(sock, ["serve"]);
  assert.strictEqual(await m.exit, 126);
  assert.match(m.err, /only the MCP transport is available/);
});

test("agent mode: a desktop that is still starting answers busy so the plugin waits", async (t) => {
  const desktops = fakeDesktops(() => sleep(3000).then(() => AGENT_DESKTOP));
  const { relay, sock } = await relayWithDriver({ spacesMode: "agent", desktops, spaceFetch: fakeSpace().spaceFetch });
  t.after(() => relay.stop());

  let t0 = Date.now();
  const q = await query(sock);
  const took = Date.now() - t0;
  assert.deepStrictEqual([q.t, q.ok, q.busy, q.error], ["route", false, true, "Your desktop is starting; retry the same action now."]);
  assert.ok(took >= 1900 && took < 2900, `answered after ${took} ms`); // the 2 s race, not the whole start

  // deck-cua's own hello waits for the whole start (Hermes runs it only after the plugin's query said ok)
  t0 = Date.now();
  const c = localClient(sock, { argv: ["mcp"], profile: "scout", skey: SKEY });
  const route = await until(() => c.msgs[0], 6000);
  assert.deepStrictEqual([route.ok, route.device], [true, "space:scout@agent-host"]);
  assert.ok(Date.now() - t0 >= 2900, "the hello waited for the desktop");
  c.s.destroy();
});

test("agent mode: fallback goes to the shared desktop through the phase 1 lock", async (t) => {
  const desktops = fakeDesktops({ kind: "fallback", reason: "offline" });
  const { relay, sock } = await relayWithDriver({ spacesMode: "agent", desktops, spaceFetch: fakeSpace().spaceFetch });
  t.after(() => relay.stop());
  const spaces = relay.driver.spaces;
  const gated = [];
  const gate = spaces.gate.bind(spaces);
  spaces.gate = (profile, kind, o) => (gated.push([profile, kind]), gate(profile, kind, o));

  const q = await query(sock);
  assert.deepStrictEqual([q.ok, q.device], [true, "host"]);
  assert.deepStrictEqual(gated, [["scout", "host"]]);
  assert.strictEqual(spaces.lock.state().holder, "scout");
  // the lock is real: another agent falling back waits in line behind Scout
  const other = await query(sock, { profile: "research", skey: "agent:main:telegram:dm:2002", sid: "" });
  assert.deepStrictEqual([other.ok, other.busy], [false, true]);
  assert.match(other.error, /in use by Scout; you are 1st in line/);

  // deck-cua's hello on a fallback runs the agent host's own driver, as in phase 1
  const c = localClient(sock, { argv: ["mcp"], profile: "scout", skey: SKEY });
  const route = await until(() => c.msgs[0]);
  assert.deepStrictEqual([route.ok, route.device], [true, "host"]);
  c.s.destroy();
});

test("agent mode without the shared desktop as fallback: the agent is told why it has no desktop", async (t) => {
  const answer = { kind: "fallback", reason: "offline" };
  const desktops = fakeDesktops(() => Promise.resolve({ ...answer }));
  const { relay, sock } = await relayWithDriver({ spacesMode: "agent", desktops, spaceFetch: fakeSpace().spaceFetch, sharedFallback: false });
  t.after(() => relay.stop());
  const texts = {
    offline: "Your desktop host is offline; ask the user.",
    limit: "Every desktop host is full right now; retry later or ask the user.",
    failed: "Your desktop could not start; ask the user to check Settings > This device > Agent desktops.",
    none: "No desktop host is available; ask the user.",
  };
  for (const [reason, text] of Object.entries(texts)) {
    answer.reason = reason;
    const q = await query(sock);
    assert.deepStrictEqual([q.ok, q.busy, q.device, q.error], [false, false, null, text], reason);
  }
  // a registry that throws counts as a desktop that could not start
  desktops.resolve = () => Promise.reject(new Error("boom"));
  assert.strictEqual((await query(sock)).error, texts.failed);
  // deck-cua gets the same words and no route
  answer.reason = "offline";
  desktops.resolve = () => Promise.resolve({ ...answer });
  const w = wrapper(sock, ["mcp"]);
  assert.strictEqual(await w.exit, 69);
  assert.match(w.err, /Your desktop host is offline; ask the user\./);
  assert.strictEqual(relay.driver.spaces.lock.state().holder, null); // the shared desktop was never offered
});

test("agent mode: a device pin (Work on this device) wins over the agent's own desktop", async (t) => {
  const desktops = fakeDesktops(AGENT_DESKTOP);
  const { relay, sock, deckToken } = await relayWithDriver({ spacesMode: "agent", desktops, spaceFetch: fakeSpace().spaceFetch });
  t.after(() => relay.stop());
  const deck = await connectDeck(relay, deckToken);
  assert.deepStrictEqual(relay.presence.setPin("p:scout", "desktop", { kind: "device", id: DEVICE }), { ok: true });

  const q = await query(sock);
  assert.deepStrictEqual([q.ok, q.device, q.name], [true, DEVICE, "Test PC"]);
  const s = wrapper(sock, ["mcp"]);
  s.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await until(() => s.lines().length === 1);
  assert.deepStrictEqual(deck.calls.map((x) => x.method), ["initialize"]); // it ran on the device
  assert.deepStrictEqual(desktops.resolved, []); // the agent's own desktop was never asked for
  s.p.stdin.end();
  assert.strictEqual(await s.exit, 0, s.err);
  // another agent without a pin still gets its own desktop
  assert.strictEqual((await query(sock, { profile: "research", skey: "", sid: "" })).device, "space:research@agent-host");
});

test("agent mode: Stop ends space sessions like device sessions and leaves the shared desktop's lock alone", async (t) => {
  const desktops = fakeDesktops(AGENT_DESKTOP);
  const { relay, sock } = await relayWithDriver({ spacesMode: "agent", desktops, spaceFetch: fakeSpace().spaceFetch });
  t.after(() => relay.stop());
  const lock = relay.driver.spaces.lock;

  for (const device of ["host", undefined]) {
    assert.strictEqual(lock.request("research").ok, true); // another agent works on the shared desktop meanwhile
    const c = localClient(sock, { argv: ["mcp"], profile: "scout", skey: SKEY });
    await until(() => c.msgs[0]);
    c.data({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await until(() => c.lines().length === 1);
    assert.strictEqual(lock.state().holder, "research"); // a space session never takes the shared lock
    const res = await (await post(relay, "/desktop/stop", device === undefined ? {} : { device })).json();
    assert.deepStrictEqual([res.ok, res.wrappers], [true, 1], String(device));
    await c.closed;
    assert.deepStrictEqual(c.msgs.at(-1), { t: "exit", code: 75 });
    assert.match(Buffer.from(c.msgs.find((m) => m.t === "err").b64, "base64").toString(), /stopped from Hermes Deck/);
    await until(() => relay.driver.state().sessions.length === 0); // the relay side of the socket closed too
  }
});

test("Review Focus 1: the Deck host's connection closes during a space session: deck-cua gets an error and the session ends", async (t) => {
  const desktops = fakeDesktops({ kind: "space", host: DEVICE, port: 1 });
  const spaceFetch = () => async () => {
    throw new Error("the Deck's connection is gone"); // what the space tunnel rejects with when the Deck drops
  };
  const { relay, sock } = await relayWithDriver({ spacesMode: "agent", desktops, spaceFetch });
  t.after(() => relay.stop());

  const c = localClient(sock, { argv: ["mcp"], profile: "scout", skey: SKEY });
  const route = await until(() => c.msgs[0]);
  assert.deepStrictEqual([route.ok, route.device], [true, `space:scout@${DEVICE}`]);
  const t0 = Date.now();
  c.data({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "screenshot", arguments: {} } });
  await Promise.race([c.closed, sleep(1000)]);
  assert.ok(c.closedAt && c.closedAt - t0 < 1000, "the local socket ended within 1 s");
  const [err] = c.lines();
  assert.deepStrictEqual([err.jsonrpc, err.id, err.error.code], ["2.0", 1, -32000]);
  assert.match(err.error.message, /not reachable right now \(the Deck's connection is gone\)/);
  assert.deepStrictEqual(c.msgs.at(-1), { t: "exit", code: 75 });
  await until(() => relay.driver.state().sessions.length === 0); // the relay side of the socket closed too
});

// ---- Task 6 fix round 1 -----------------------------------------------------------------------------------------

test("agent mode: info verbs are answered by the relay before any desktop starts; a one-shot call is refused", async (t) => {
  const desktops = fakeDesktops(AGENT_DESKTOP);
  const { relay, sock } = await relayWithDriver({ spacesMode: "agent", desktops, spaceFetch: fakeSpace().spaceFetch });
  t.after(() => relay.stop());

  // the wire: a route, one manifest line, exit 0
  const c = localClient(sock, { argv: ["manifest"], profile: "scout" });
  await c.closed;
  assert.deepStrictEqual([c.msgs[0].t, c.msgs[0].ok, c.msgs[0].device], ["route", true, "space:scout"]);
  assert.deepStrictEqual(c.lines()[0].mcp_invocation, { command: "deck-cua", args: ["mcp"] });
  assert.deepStrictEqual(c.msgs.at(-1), { t: "exit", code: 0 });
  // the real wrapper: exit 0, and mcp_invocation pointed back at itself (bot-screen-protocol.md:29)
  const m = wrapper(sock, ["manifest"]);
  assert.strictEqual(await m.exit, 0, m.err);
  const man = JSON.parse(m.text());
  assert.deepStrictEqual(man.mcp_invocation, { command: SELF, args: ["mcp"] });
  assert.strictEqual(typeof man.binary_version, "string");
  assert.ok(Array.isArray(man.subcommands) && man.subcommands.some((x) => x.name === "mcp"));
  // Hermes' computer_use refuses to start unless `<driver> manifest` meets its runtime contract (its reader,
  // tools/computer_use/cua_backend_driver.py _manifest_contract_reason): a semantic binary_version >= 0.20.0, a list
  // of mcp_invocation args, and these subcommand flags advertised. "agent-desktop" failed it (phase 2 side test).
  assert.strictEqual(hermesContractReason(man), "");
  assert.strictEqual(hermesContractReason(c.lines()[0]), "");
  // --help, status, doctor: one readable line, exit 0
  for (const verb of ["--help", "status", "doctor"]) {
    const w = wrapper(sock, [verb]);
    assert.strictEqual(await w.exit, 0, `${verb}: ${w.err}`);
    assert.match(w.text(), /agent's own desktop/, verb);
  }
  // a one-shot call: 126 and a line the agent can read
  const call = wrapper(sock, ["call", "screenshot", "{}"]);
  assert.strictEqual(await call.exit, 126);
  assert.match(call.err, /one-shot calls are not available on an agent's own desktop; use the MCP session/);
  assert.deepStrictEqual(desktops.resolved, []); // nothing above started a desktop
});

test("agent mode: the relay's fence on an agent's own desktop: kill_app, hiding the agent cursor and the capture scope never reach it", async (t) => {
  const space = fakeSpace();
  const { relay, sock } = await relayWithDriver({ spacesMode: "agent", desktops: fakeDesktops(AGENT_DESKTOP), spaceFetch: space.spaceFetch });
  t.after(() => relay.stop());
  const c = localClient(sock, { argv: ["mcp"], profile: "scout", skey: SKEY });
  await until(() => c.msgs[0]);
  const call = (id, name, args) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n";
  // two requests in one chunk, and two more split across chunks mid-line: the fence reads whole lines
  c.raw(call(1, "set_agent_cursor_enabled", { session: "s", enabled: false }) + call(2, "kill_app", { pid: 7 }));
  const tail = call(3, "set_config", { key: "capture_scope", value: "desktop" }) + call(4, "click", { x: 5, y: 5 }) + call(5, "set_agent_cursor_enabled", { session: "s", enabled: true });
  c.raw(tail.slice(0, 30));
  c.raw(tail.slice(30));
  const got = await until(() => (c.lines().length >= 5 ? c.lines() : null));
  const byId = Object.fromEntries(got.map((l) => [l.id, l]));
  for (const id of [1, 2, 3]) assert.strictEqual(byId[id].result.isError, true, String(id));
  assert.match(byId[1].result.content[0].text, /agent cursor stays visible/);
  assert.match(byId[2].result.content[0].text, /kill_app is not available/);
  assert.match(byId[3].result.content[0].text, /capture scope cannot be changed/);
  assert.deepStrictEqual(space.reqs.map((r) => r.msg.params.name), ["click", "set_agent_cursor_enabled"]); // only the allowed calls
  assert.strictEqual(byId[4].result.isError, undefined);
});

test("agent mode: the Deck computer that hosts an agent's desktop disconnects: its idle space sessions end", async (t) => {
  const desktops = fakeDesktops((p) => Promise.resolve(p === "research" ? AGENT_DESKTOP : { kind: "space", host: DEVICE, port: 1 }));
  const { relay, sock, deckToken } = await relayWithDriver({ spacesMode: "agent", desktops, spaceFetch: fakeSpace().spaceFetch });
  t.after(() => relay.stop());
  const deck = await connectDeck(relay, deckToken);
  const c = localClient(sock, { argv: ["mcp"], profile: "scout", skey: SKEY });
  assert.strictEqual((await until(() => c.msgs[0])).device, `space:scout@${DEVICE}`);
  const other = localClient(sock, { argv: ["mcp"], profile: "research" }); // on the agent host: not affected
  assert.strictEqual((await until(() => other.msgs[0])).device, "space:research@agent-host");

  deck.ws.close(); // idle: no request in flight that a tunnel error could end
  await Promise.race([c.closed, sleep(1000)]);
  assert.ok(c.closedAt, "the session on the gone Deck ended");
  assert.match(Buffer.from(c.msgs.find((x) => x.t === "err").b64, "base64").toString(), /the computer that hosts your desktop disconnected/);
  assert.deepStrictEqual(c.msgs.at(-1), { t: "exit", code: 75 });
  assert.strictEqual(other.closedAt, null);
  other.s.destroy();
});

test("agent mode: the desktop goes away between the plugin's query and deck-cua's hello: the shared desktop is not used without its lock", async (t) => {
  let n = 0;
  const desktops = fakeDesktops(() => Promise.resolve(n++ === 0 ? AGENT_DESKTOP : { kind: "fallback", reason: "offline" }));
  const { relay, sock } = await relayWithDriver({ spacesMode: "agent", desktops, spaceFetch: fakeSpace().spaceFetch });
  t.after(() => relay.stop());
  assert.strictEqual((await query(sock)).device, "space:scout@agent-host");
  const c = localClient(sock, { argv: ["mcp"], profile: "scout", skey: SKEY });
  const route = await until(() => c.msgs[0]);
  c.s.destroy();
  assert.deepStrictEqual(route, { t: "route", ok: false, error: "Your desktop went away; retry the same action now.", code: 75 });
  assert.strictEqual(relay.driver.spaces.lock.state().holder, null);
  // but when the query itself fell back, a read-only one (a capture: no turn taken) still leads to the shared desktop
  const q = await query(sock, { profile: "scout", skey: SKEY, sid: "", read: true });
  assert.deepStrictEqual([q.ok, q.device], [true, "host"]);
  const c2 = localClient(sock, { argv: ["mcp"], profile: "scout", skey: SKEY });
  const route2 = await until(() => c2.msgs[0]);
  c2.s.destroy();
  assert.deepStrictEqual([route2.ok, route2.device], [true, "host"]);
});

test("agent mode: deck-cua's hello waits for a starting desktop only up to its cap", async (t) => {
  const desktops = fakeDesktops(() => sleep(1500).then(() => AGENT_DESKTOP));
  const { relay, sock } = await relayWithDriver({ spacesMode: "agent", desktops, spaceFetch: fakeSpace().spaceFetch, helloDesktopMs: 300 });
  t.after(() => relay.stop());
  assert.strictEqual(relay.driver.o.helloDesktopMs, 300);
  assert.strictEqual(new Driver({ presence: new Presence(), log: () => {} }).o.helloDesktopMs, 13_000); // under deck-cua's 15 s
  const t0 = Date.now();
  const c = localClient(sock, { argv: ["mcp"], profile: "scout", skey: SKEY });
  await c.closed;
  assert.deepStrictEqual(c.msgs[0], { t: "route", ok: false, error: "Your desktop is starting; retry the same action now.", code: 75 });
  assert.ok(c.closedAt - t0 < 1200, `ended after ${c.closedAt - t0} ms`);
});

test("agent mode: no own desktop and no shared route either: the agent hears why it has no desktop", async (t) => {
  const answer = { kind: "fallback", reason: "offline" };
  const desktops = fakeDesktops(() => Promise.resolve({ ...answer }));
  const { relay, sock } = await relayWithDriver({ spacesMode: "agent", desktops, spaceFetch: fakeSpace().spaceFetch });
  t.after(() => relay.stop());
  relay.presence.fallback.desktop = null; // the agent host offers no shared desktop now
  let q = await query(sock);
  assert.deepStrictEqual([q.ok, q.error], [false, "Your desktop host is offline; ask the user."]);
  answer.reason = "limit";
  q = await query(sock);
  assert.strictEqual(q.error, "Every desktop host is full right now; retry later or ask the user.");
  const c = localClient(sock, { argv: ["mcp"], profile: "scout", skey: SKEY });
  await c.closed;
  assert.deepStrictEqual([c.msgs[0].ok, c.msgs[0].error], [false, "Every desktop host is full right now; retry later or ask the user."]);
});

// ---- final fix wave I4: in agent mode only `mcp` and the info verbs pass; nothing else starts a desktop -----------

test("I4 agent mode: serve, stop and any other verb are refused with 126 before a desktop is resolved", async (t) => {
  const desktops = fakeDesktops(AGENT_DESKTOP);
  const { relay, sock } = await relayWithDriver({ spacesMode: "agent", desktops, spaceFetch: fakeSpace().spaceFetch });
  t.after(() => relay.stop());
  for (const argv of [["serve", "--socket", "/tmp/x"], ["stop"], ["screenshot"]]) {
    const w = wrapper(sock, argv);
    assert.strictEqual(await w.exit, 126, argv[0]);
    assert.match(w.err, /On an agent's own desktop only the MCP transport is available; keep computer_use\.permission_mode at standard\./, argv[0]);
  }
  assert.deepStrictEqual(desktops.resolved, [], "no desktop was resolved (or started) for them");
  const call = wrapper(sock, ["call", "screenshot", "{}"]);
  assert.strictEqual(await call.exit, 126);
  assert.match(call.err, /one-shot calls are not available/, "call keeps its own text");
});
