"use strict";
// BridgeClient against fake-stream.js (the host side of the protocol). Run from the repo root:
//   node --test "app/test/*.test.js"
// Nothing here touches SSH, the network or a real Hermes host.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const bridge = require("../main/bridge");
const { setLanguage } = require("../renderer/i18n");
setLanguage("tr");

const { BridgeClient } = bridge;
const FAKE = path.join(__dirname, "fake-stream.js");
const CFG = { mode: "ssh", target: "hermes-test", python: "/usr/bin/python3", stream: "/srv/hermes/hermes-deck/stream.py" };
const FAST = { request: 1500, write: 1000, handshake: 1500, heartbeat: 1200, kill: 500, backoffMin: 40, backoffMax: 160, keepalive: 60000 };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "deck-bridge-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpLog() {
  return path.join(fs.mkdtempSync(path.join(TMP, "log-")), "requests.log");
}

function readLog(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
const calls = (file, method) => readLog(file).filter((e) => e.method === method);

function makeClient(t, flags = [], { timing = {}, ...opts } = {}) {
  const c = new BridgeClient(CFG, { launch: { file: process.execPath, args: [FAKE, "--serve", ...flags] }, timing: { ...FAST, ...timing }, ...opts });
  t.after(() => c.stop());
  return c;
}

/** Resolve with the first `event` value that passes `pred`. */
function next(emitter, event, pred = () => true, ms = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, on);
      reject(new Error(`timed out waiting for ${event}`));
    }, ms);
    function on(v) {
      if (!pred(v)) return;
      clearTimeout(timer);
      emitter.off(event, on);
      resolve(v);
    }
    emitter.on(event, on);
  });
}

async function startOpen(c) {
  const ready = next(c, "status", (s) => s.status === "open");
  c.start();
  await ready;
}

// ---------------------------------------------------------------- launch command and validation

test("builds Desk's ssh and wsl commands with every remote argument quoted", () => {
  const ssh = bridge.launchSpec(
    { mode: "ssh", target: "me@box", python: "~/.hermes/venv/bin/python", stream: "/opt/it's/stream.py" },
    { platform: "win32", systemRoot: "C:\\Windows" }
  );
  assert.equal(ssh.file, "C:\\Windows\\System32\\OpenSSH\\ssh.exe");
  assert.deepEqual(ssh.args.slice(0, 11), ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2", "--", "me@box"]);
  assert.equal(ssh.args[11], `exec "$HOME"/'.hermes/venv/bin/python' '-I' '/opt/it'\\''s/stream.py' '--follow'`);
  assert.equal(ssh.args.length, 12);

  const wsl = bridge.launchSpec(
    { mode: "wsl", distribution: "Ubuntu-24.04", python: "/usr/bin/python3", stream: "~/.hermes/hermes-deck/stream.py" },
    { platform: "win32", systemRoot: "C:\\Windows" }
  );
  assert.equal(wsl.file, "C:\\Windows\\System32\\wsl.exe");
  assert.deepEqual(wsl.args, ["--distribution", "Ubuntu-24.04", "--exec", "/bin/sh", "-c", `exec '/usr/bin/python3' '-I' "$HOME"/'.hermes/hermes-deck/stream.py' '--follow'`]);

  const local = bridge.launchSpec({ mode: "local", python: "~/.venv/bin/python", stream: "/srv/stream.py" }, { platform: "linux", home: "/home/u" });
  assert.deepEqual(local, { file: "/home/u/.venv/bin/python", args: ["-I", "/srv/stream.py", "--follow"] });
  assert.equal(bridge.launchSpec({ ...CFG }, { platform: "darwin" }).file, "/usr/bin/ssh");
});

test("rejects targets, paths and modes that could reach a shell or cannot run here", () => {
  for (const bad of ["", "a b", "a;b", "$(id)", "`id`", "a@b@c", "-oProxyCommand=x", "user@-host", "a|b", "a'b", "host:22", "ü@host"]) {
    assert.equal(bridge.validTarget(bad), false, bad);
  }
  for (const good of ["mac", "me@box.local", "me@100.64.0.1", "my_alias-2"]) assert.equal(bridge.validTarget(good), true, good);
  assert.equal(bridge.validPath("/x/stream.py", false), true);
  assert.equal(bridge.validPath("~/x/stream.py", false), true);
  assert.equal(bridge.validPath("relative/stream.py", false), false);
  assert.equal(bridge.validPath("/x\n/y", false), false);
  assert.equal(bridge.validPath("python3", true), true);
  assert.equal(bridge.validPath("python3", false), false);
  assert.match(bridge.configError({ mode: "local", python: "/p", stream: "/s" }, "win32"), /Windows/);
  assert.match(bridge.configError({ mode: "wsl", python: "/p", stream: "/s" }, "darwin"), /WSL/);
  assert.match(bridge.configError({ mode: "ssh", python: "/p", stream: "/s" }, "win32"), /hedef gerekli/);
  assert.match(bridge.configError({ mode: "off", target: "a b" }, "win32"), /SSH hedefi/);
  assert.equal(bridge.configError({ mode: "off" }, "win32"), null);
  assert.match(bridge.configError({ mode: "ssh", target: "box", python: "/p" }, "win32"), /stream\.py/);
  assert.throws(() => bridge.normalizeConfig({ mode: "telnet" }), /geçersiz/);
  assert.deepEqual(bridge.normalizeConfig({ mode: " ssh ", target: " box ", python: " /p ", stream: " /s " }, "win32"), {
    mode: "ssh", target: "box", python: "/p", stream: "/s", distribution: "",
  });
});

test("invalid settings wait for new ones instead of retrying", async () => {
  const c = new BridgeClient({ mode: "local", python: "/p", stream: "/s" }, { platform: "win32", timing: FAST });
  const st = next(c, "status");
  c.start();
  const s = await st;
  assert.equal(s.status, "setup");
  assert.equal(s.code, "config");
  assert.equal(c.retryTimer, null);
  await c.stop();
});

test("a missing ssh.exe gives a specific message, then backs off", async (t) => {
  const c = new BridgeClient(CFG, { launch: { file: path.join(os.tmpdir(), "no-such-dir", "ssh.exe"), args: [] }, timing: FAST });
  t.after(() => c.stop());
  const st = next(c, "status", (s) => s.status === "offline");
  c.start();
  const s = await st;
  assert.equal(s.code, "spawn");
  assert.match(s.error, /OpenSSH/);
  assert.equal(s.retryInMs, 40);
});

test("the new stream schema opens a live BridgeClient", async (t) => {
  const c = makeClient(t, ["--snapshot-schema", "hermes-deck.v1"]);
  const ready = next(c, "status", s => s.status === "open");
  c.start();
  assert.equal((await ready).status, "open");
});

test("only the Hermes Deck snapshot schema counts as the handshake", () => {
  const snap = { schema: "hermes-deck.v1", connection_id: "hermes", online: true, nodes: [] };
  assert.equal(bridge.isSnapshot(snap), true);
  assert.equal(bridge.isSnapshot({ ...snap, schema: "retired-bridge.v1" }), false);
  assert.equal(bridge.isSnapshot({ ...snap, connection_id: "studio-box" }), true); // older installed stream.py labels
  assert.equal(bridge.isSnapshot({ ...snap, connection_id: "a b" }), false);
  assert.equal(bridge.isSnapshot({ ...snap, online: false }), false);
  assert.equal(bridge.isSnapshot({ ...snap, nodes: {} }), false);
  assert.equal(bridge.isSnapshot({ ...snap, schema: "other" }), false);
});

test("reply parsing: string id, no method, exactly one of result or error", () => {
  for (const frame of [
    { jsonrpc: "2.0", id: "deck-1" },
    { jsonrpc: "2.0", id: "deck-1", method: "approval", params: {} },
    { jsonrpc: "2.0", id: "deck-1", result: {}, error: { message: "bad" } },
    { id: "deck-1", result: {} },
    { jsonrpc: "2.0", id: 7, result: {} },
    { jsonrpc: "2.0", id: "deck-1", error: "flat string" },
  ]) {
    assert.equal(bridge.rpcReply(frame), null, JSON.stringify(frame));
  }
  assert.deepEqual(bridge.rpcReply({ jsonrpc: "2.0", id: "deck-1", result: null }), { id: "deck-1", result: null });
  assert.deepEqual(bridge.rpcReply({ jsonrpc: "2.0", id: "deck-1", error: { message: "x".repeat(2000) } }).error.length, 1024);
});

test("request shapes: allowlisted methods, bounded params, read-only history, session-scoped model", () => {
  // session.delete (rail context menu): one stored id, optionally a profile; session.close: one runtime id
  bridge.checkRequest("session.delete", { session_id: "s-1" });
  bridge.checkRequest("session.delete", { session_id: "s-1", profile: "bot-a" });
  for (const params of [{}, { session_id: "" }, { session_id: "a b" }, { session_id: "s-1", profile: "../x" }, { session_id: "s-1", profile: "" }, { session_id: "s-1", hard: true }, { session_id: 7 }]) {
    assert.throws(() => bridge.checkRequest("session.delete", params), /Geçersiz oturum isteği/, JSON.stringify(params));
  }
  bridge.checkRequest("session.close", { session_id: "rpc-1" });
  for (const params of [{}, { session_id: "rpc-1", extra: 1 }, { session_id: "x y" }]) {
    assert.throws(() => bridge.checkRequest("session.close", params), /Geçersiz oturum isteği/, JSON.stringify(params));
  }
  assert.throws(() => bridge.checkRequest("terminal.execute", {}), /Desteklenmeyen/);
  // file attachments: the protocol has no upload call of its own; files travel only in deck.attach_submit
  assert.equal(bridge.ATTACHMENTS, false);
  for (const m of ["image.attach", "file.upload", "attachment.add", "clipboard.paste"]) assert.throws(() => bridge.checkRequest(m, {}), /Desteklenmeyen/);
  // by name segment: "profiles.list" is not a file method (profiles.get_asset only reads a profile's avatar)
  const fileish = (m) => m.split(/[._]/).some((seg) => /^(attach\w*|upload\w*|files?|images?|clipboard)$/.test(seg));
  // deck.file_read is the other "file" method: it carries no upload, only a bounded read of a file the agent offered;
  // deck.attach_staged carries no bytes either: only relay spool ids (48 hex) of files the relay already holds on disk
  assert.deepEqual([...bridge.METHODS].filter(fileish).sort(), ["deck.attach_staged", "deck.attach_submit", "deck.file_read"], "only the bounded attach method uploads files");
  assert.ok(bridge.METHODS.has("deck.transcribe") && bridge.METHODS.has("deck.file_read"));
  assert.ok(fileish("image.attach") && fileish("file.upload") && !fileish("profiles.list"));
  assert.throws(() => bridge.checkRequest("session.list", []), /nesne/);
  assert.throws(() => bridge.checkRequest("prompt.submit", { session_id: "s", text: "x".repeat(60001) }), /60\.000/);
  for (const params of [
    { session_id: "" },
    { session_id: "id", limit: 0 },
    { session_id: "id", limit: 101 },
    { session_id: "id", limit: 1.5 },
    { session_id: "id", offset: -1 },
    { session_id: "id", order: "oldest" },
    { session_id: "id", inline_images: true },
    { session_id: "id", profile: "../other" },
    { session_id: "id", profile: ".." },
    { session_id: "id", source: "tui" },
  ]) {
    assert.throws(() => bridge.checkRequest("session.messages", params), /geçmiş/, JSON.stringify(params));
  }
  bridge.checkRequest("session.messages", { session_id: "id", profile: "default", limit: 40, offset: 0, order: "latest", inline_images: false });
  for (const params of [
    { session_id: "s", key: "api_key", value: "x --session" },
    { session_id: "s", key: "model", value: "" },
    { session_id: "s", key: "model", value: "m --provider p --session --global" },
    { session_id: "s", key: "model", value: "m --provider p -g --session" },
    { session_id: "s", key: "model", value: "m --provider p" },
    { key: "model", value: "m --provider p --session" },
  ]) {
    assert.throws(() => bridge.checkRequest("config.set", params), /modeli/, JSON.stringify(params));
  }
  bridge.checkRequest("config.set", { session_id: "s", key: "model", value: "m --provider p --session" });
  // "Show thinking": one runtime session id and a real boolean; never Hermes' config.set reasoning (it writes config.yaml)
  bridge.checkRequest("deck.reasoning_view", { session_id: "rpc-1", show: true });
  for (const params of [{}, { session_id: "rpc-1" }, { session_id: "rpc-1", show: "true" }, { session_id: "rpc-1", show: 1 }, { session_id: "a b", show: true }, { session_id: "rpc-1", show: true, scope: "global" }]) {
    assert.throws(() => bridge.checkRequest("deck.reasoning_view", params), /Geçersiz oturum isteği/, JSON.stringify(params));
  }
  assert.throws(() => bridge.checkRequest("config.set", { session_id: "s", key: "reasoning", value: "show" }), /modeli/);
});

test("Show thinking: asked for every session this Deck binds (resume and create), and switched for the bound ones", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log], { showReasoning: true });
  await startOpen(c);
  const waitFor = async (n) => {
    for (let i = 0; i < 200 && calls(log, "deck.reasoning_view").length < n; i++) await sleep(10);
    return calls(log, "deck.reasoning_view");
  };
  await c.send("s-main", "Merhaba");
  const r1 = await waitFor(1);
  assert.deepEqual(r1.map((e) => e.params), [{ session_id: "rpc-s-main", show: true }]);
  const made = await c.create({ profile: "default" });
  const r1b = await waitFor(2);
  assert.equal(r1b[1].params.show, true, `a created session (${made.sid}) is asked too`);
  assert.deepEqual(c.setReasoning(false), { show: false });
  const r2 = await waitFor(4);
  assert.deepEqual(r2.slice(2).map((e) => e.params.show), [false, false], "every bound session is switched off");
  await c.send("s-idle", "Selam", { profile: "default" });
  await sleep(50);
  assert.equal(calls(log, "deck.reasoning_view").length, 4, "off: a newly bound session is not asked");
});

test("Show thinking survives a reconnect: the rebound session is asked again on the new connection", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--exit-on", "native.steer", "--log", log], { showReasoning: true });
  await startOpen(c);
  await c.send("s-main", "Merhaba");
  for (let i = 0; i < 200 && calls(log, "deck.reasoning_view").length < 1; i++) await sleep(10);
  // the fake exits on this request: the connection drops and comes back with nothing bound
  c.request("native.steer", { session_id: "s-main", turn_id: "t1", owner_pid: 4242, text: "x" }).catch(() => {});
  await next(c, "status", (s) => s.status === "offline", 8000);
  await next(c, "status", (s) => s.status === "open", 8000);
  await c.send("s-main", "Tekrar");
  for (let i = 0; i < 200 && calls(log, "deck.reasoning_view").length < 2; i++) await sleep(10);
  assert.equal(calls(log, "session.resume").length, 2, "rebound on the new connection");
  assert.deepEqual(calls(log, "deck.reasoning_view").map((e) => e.params), [
    { session_id: "rpc-s-main", show: true },
    { session_id: "rpc-s-main", show: true },
  ]);
});

test("history keeps an assistant message's stored reasoning as `think` (display_reasoning first, never details)", () => {
  const out = bridge.projectHistory([
    { id: 1, role: "user", content: "17*23?", reasoning: "never for a user row" },
    { id: 2, role: "assistant", content: "391", reasoning: "17 × 23 = 391.", reasoning_content: "17 × 23 = 391." },
    { id: 3, role: "assistant", content: "ok", reasoning: "raw with commentary", display_reasoning: "clean" },
    { id: 4, role: "assistant", content: "", reasoning: "a tool-call step that only thought" },
    { id: 5, role: "assistant", content: "x", reasoning_details: [{ type: "thinking", thinking: "replay data" }] },
    { id: 6, role: "assistant", content: "", reasoning: "   " },
    { id: 7, role: "assistant", content: "y", reasoning_content: "z".repeat(30000) },
  ]);
  assert.deepEqual(out.map((m) => [m.id, m.text, m.think]), [
    ["1", "17*23?", undefined],
    ["2", "391", "17 × 23 = 391."],
    ["3", "ok", "clean"],
    ["4", "", "a tool-call step that only thought"],
    ["5", "x", undefined],
    ["7", "y", "z".repeat(20000)],
  ]);
});

test("history keeps the tool calls of an assistant step, in order, with a masked one-line argument", () => {
  const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
  const out = bridge.projectHistory([
    { id: 1, role: "user", content: "run the tests" },
    { id: 2, role: "assistant", content: "", reasoning: "Run the suite first.", tool_calls: [
      call("c1", "terminal", { command: "npm test\n  -- --watch=false", timeout: 600 }),
      call("c2", "read_file", { offset: 3, path: "app/main.js" }),
    ] },
    { id: 3, role: "tool", tool_call_id: "c1", content: "ok" },
    { id: 4, role: "assistant", content: "", tool_calls: [call("c3", "terminal", { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwx' https://example.com" })] },
    { id: 5, role: "assistant", content: "Checking.", tool_calls: [call("c4", "web_search", "not json at all")] },
    { id: 6, role: "assistant", content: "", tool_calls: [call("c5", "tool_call", { name: "mcp_x", arguments: {} })],
      tool_call_labels: { c5: [{ name: "github_create_issue", preview: "Fix the build" }] } },
    { id: 7, role: "assistant", content: "", tool_calls: [{ id: "c6", function: { name: "" } }, "junk"] },
    { id: 8, role: "assistant", content: "", tool_calls: [call("c7", "write_file", { path: "/tmp/" + "x".repeat(400) })] },
    { id: 9, role: "assistant", content: "done" },
  ]);
  assert.deepEqual(out.map((m) => [m.id, m.text, m.think, m.calls]), [
    ["1", "run the tests", undefined, undefined],
    ["2", "", "Run the suite first.", [{ id: "c1", name: "terminal", arg: "npm test -- --watch=false" }, { id: "c2", name: "read_file", arg: "app/main.js" }]],
    ["4", "", undefined, [{ id: "c3", name: "terminal", arg: "curl -H 'Authorization: Bearer •••' https://example.com" }]],
    ["5", "Checking.", undefined, [{ id: "c4", name: "web_search", arg: "not json at all" }]],
    ["6", "", undefined, [{ id: "c5", name: "github_create_issue", arg: "Fix the build" }]],
    ["8", "", undefined, [{ id: "c7", name: "write_file", arg: `/tmp/${"x".repeat(154)}…` }]],
    ["9", "done", undefined, undefined],
  ], "a step that only called a tool is kept; a tool row and a call with no name are not shown");
  assert.equal(out[5].calls[0].arg.length, 160);
});

test("failure wording names the actual problem", () => {
  const c = (stderr, code) => bridge.classifyFailure(null, stderr, { code }).code;
  assert.equal(c("user@host: Permission denied (publickey).", 255), "key");
  assert.equal(c("Host key verification failed.", 255), "host-unknown");
  assert.equal(c("@@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@@\nHost key verification failed.", 255), "hostkey-changed");
  assert.equal(c("ssh: Could not resolve hostname nope: No such host is known.", 255), "dns");
  assert.equal(c("ssh: connect to host 10.0.0.9 port 22: Connection timed out", 255), "network");
  assert.equal(c("zsh:1: no such file or directory: /x/bin/python", 127), "python");
  assert.equal(c("sh: 1: exec: /x/bin/python: not found", 127), "python");
  assert.equal(c("/x/bin/python: can't open file '/x/stream.py': [Errno 2] No such file or directory", 2), "stream");
});

// ---------------------------------------------------------------- framing and transport

test("frames split across reads and CRLF line ends still parse", async (t) => {
  const c = makeClient(t, ["--split", "--crlf"]);
  await startOpen(c);
  const rows = await c.sessions();
  assert.deepEqual(rows.map((r) => r.id), ["s-main", "s-idle"]);
  const h = await c.history("s-main");
  assert.equal(h.messages.length, 3);
});

test("snapshots are normalized and emitted only when they change", async (t) => {
  const c = makeClient(t, ["--interval", "50"]);
  let count = 0;
  const first = next(c, "snapshot");
  c.on("snapshot", () => count++);
  c.start();
  const snap = await first;
  assert.equal(snap.connectionId, "hermes");
  const main = snap.nodes.find((n) => n.sid === "s-main");
  assert.deepEqual(
    { state: main.state, active: main.active, turnId: main.turnId, ownerPid: main.ownerPid, controlAvailable: main.controlAvailable, profile: main.profile, bound: main.bound },
    { state: "working", active: true, turnId: "t1", ownerPid: 4242, controlAvailable: true, profile: "default", bound: false }
  );
  assert.equal(snap.nodes.find((n) => n.sid === "s-child").parent, "s-main");
  assert.equal(snap.nodes.find((n) => n.sid === "s-idle").profile, "research");
  await sleep(400);
  // updated_at moves every frame, so these do change; identical frames would not be re-emitted
  assert.ok(count >= 2);
  const before = c.snapshotKey;
  c._emitSnapshot();
  assert.equal(c.snapshotKey, before);
});

test("an oversized frame drops the connection, then it reconnects", async (t) => {
  const c = makeClient(t, ["--oversize"]);
  const down = next(c, "status", (s) => s.status === "offline");
  c.start();
  const s = await down;
  assert.equal(s.code, "frame");
  await next(c, "status", (x) => x.status === "open");
});

test("replies match their own call; unknown ids and server requests with the same id cannot complete it", async (t) => {
  const c = makeClient(t, ["--late-reply", "--delay", "session.list=150"]);
  await startOpen(c);
  const [rows, hist] = await Promise.all([c.sessions(), c.history("s-main", { limit: 10 })]);
  assert.equal(rows[0].id, "s-main");
  assert.equal(hist.sid, "s-main");
  assert.equal(hist.messages[0].text, "Merhaba");
  // the server requests that reused our request ids were kept as approvals, not taken as replies
  assert.ok(c.listRequests().some((r) => r.command === "same id as a pending call"));
  for (let i = 0; i < 40 && c.pending.size; i++) await new Promise((r) => setTimeout(r, 25)); // the automatic recent list may still be in flight
  assert.equal(c.pending.size, 0);
});

test("a call without a reply times out, says it may have completed, and leaves nothing pending", async (t) => {
  const c = makeClient(t, ["--drop", "session.list"], { timing: { request: 300 } });
  await startOpen(c);
  await assert.rejects(c.sessions(), /zaman aşımına uğradı; tamamlanmış olabilir/);
  assert.equal(c.pending.size, 0);
});

test("no first snapshot: handshake timeout, then backoff 40, 80, 160, 160 ms", async (t) => {
  const c = makeClient(t, ["--no-snapshot"], { timing: { handshake: 150 } });
  const seen = [];
  const four = new Promise((resolve) => {
    c.on("status", (s) => {
      if (s.status !== "offline") return;
      seen.push(s);
      if (seen.length === 4) resolve();
    });
  });
  c.start();
  await four;
  assert.deepEqual(seen.map((s) => s.retryInMs), [40, 80, 160, 160]);
  assert.ok(seen.every((s) => s.code === "handshake"));
  await assert.rejects(c.sessions(), /çevrimdışı/);
});

test("a silent heartbeat drops a ready connection; backoff restarts after a good one", async (t) => {
  const c = makeClient(t, ["--snapshots", "1"], { timing: { heartbeat: 300 } });
  await startOpen(c);
  const s = await next(c, "status", (x) => x.status === "offline");
  assert.equal(s.code, "heartbeat");
  assert.equal(s.retryInMs, 40);
  await next(c, "status", (x) => x.status === "open");
});

test("a mutation lost with the connection is never replayed; offline calls are never queued", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--exit-on", "prompt.submit", "--log", log]);
  await startOpen(c);
  await assert.rejects(c.send("s-main", "bir kez"), /tekrar gönderilmedi/);
  // while offline: fails at once and is not kept for later
  if (c.status.status !== "open") await assert.rejects(c.steer("s-main", "sonra"), /çevrimdışı|hazır değil/);
  await next(c, "status", (s) => s.status === "open", 8000);
  await sleep(300);
  const entries = readLog(log);
  const starts = entries.map((e, i) => (e.start ? i : -1)).filter((i) => i >= 0);
  assert.ok(starts.length >= 2, "the fake was restarted");
  assert.equal(calls(log, "prompt.submit").length, 1);
  assert.equal(calls(log, "session.resume").length, 1);
  assert.equal(calls(log, "native.steer").length, 0);
  const afterRestart = entries.slice(starts[1] + 1).map((e) => e.method);
  assert.ok(afterRestart.every((m) => m === "session.list" || m === "deck.session_index"), afterRestart.join(","));
  // ids are never reused across connections
  const ids = entries.filter((e) => e.id).map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("stop() reaps only its own child and fails what is pending", async (t) => {
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
  t.after(() => sleeper.kill());
  const c = makeClient(t, ["--drop", "session.usage"]);
  await startOpen(c);
  const child = c.lastChild;
  assert.ok(c.pid > 0);
  const pending = assert.rejects(c.request("session.usage", { session_id: "rpc-x" }), /kapatıldı; istekler tekrar gönderilmedi/);
  await c.stop();
  await pending;
  assert.ok(child.exitCode !== null || child.signalCode !== null, "our child exited");
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0), "an unrelated process is untouched");
  assert.equal(c.status.status, "off");
  await assert.rejects(c.sessions(), /çevrimdışı/);
});

// ---------------------------------------------------------------- reads

test("history is the read-only projection: visible user/assistant text, exact paging params", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log]);
  await startOpen(c);
  const h = await c.history("s-main", { profile: "default", limit: 40, offset: 0 });
  assert.deepEqual(
    h.messages.map((m) => [m.id, m.role, m.text]),
    [["11", "user", "Merhaba"], ["12", "assistant", "Selam"], ["15", "assistant", "Görünen metin"]]
  );
  assert.equal(h.messages[0].ts, 1700000000.5);
  assert.equal(h.hasMore, false);
  assert.equal(h.offset, 40);
  const older = await c.history("s-main", { offset: 40 });
  assert.equal(older.messages[0].text, "Eski soru");
  assert.deepEqual(calls(log, "session.messages")[0].params, { session_id: "s-main", profile: "default", limit: 40, offset: 0, order: "latest", inline_images: false });
  await assert.rejects(c.history("s-main", { profile: "../x" }), /Profil/);
  await assert.rejects(c.history("bad id"), /Oturum kimliği/);
  // reads never resume or create a session
  assert.equal(calls(log, "session.resume").length, 0);
});

test("session.list is sent on its own once the connection is ready (opens the event socket), then last activity is added", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log]);
  const rows = next(c, "sessions");
  c.start();
  const list = await rows;
  assert.equal(list[0].profile, "default");
  assert.deepEqual(calls(log, "session.list")[0].params, { limit: 50 });
  assert.deepEqual(calls(log, "deck.session_index")[0].params, { limit: 100, archived: "exclude" });
  const first = (m) => calls(log, m)[0];
  assert.ok(first("session.list") && first("deck.session_index"), "both were sent");
});

test("an older plugin without deck.session_index still gets the recent list from session.list", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log, "--no-index"]);
  const rows = next(c, "sessions");
  c.start();
  const list = await rows;
  assert.equal(list[0].title, "Ana oturum");
  assert.deepEqual(calls(log, "session.list")[0].params, { limit: 50 });
});

// ---------------------------------------------------------------- mutations, each against the fake

test("send resumes once per connection, then prompt.submit; stream events map to the stored id", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log]);
  await startOpen(c);
  const events = [];
  c.on("event", (e) => events.push(e));
  const done = next(c, "event", (e) => e.type === "message.complete");
  assert.deepEqual(await c.send("s-main", "Merhaba"), { status: "streaming" });
  const complete = await done;
  assert.equal(complete.sid, "s-main");
  assert.equal(complete.rpcId, "rpc-s-main");
  assert.equal(complete.payload.text, "Merhaba");
  assert.ok(!events.some((e) => e.payload.replay), "replayed frames are dropped");
  assert.deepEqual(await c.send("s-main", "Tekrar"), { status: "streaming" });
  assert.deepEqual(calls(log, "session.resume").map((e) => e.params), [{ session_id: "s-main", omit_messages: true, inline_images: false }]);
  assert.deepEqual(calls(log, "prompt.submit").map((e) => e.params), [
    { session_id: "rpc-s-main", text: "Merhaba" },
    { session_id: "rpc-s-main", text: "Tekrar" },
  ]);
  assert.equal(c.currentSnapshot().nodes.find((n) => n.sid === "s-main").bound, true);
  // a session of another profile is resumed in that profile
  await c.send("s-idle", "Selam", { profile: "research" });
  assert.deepEqual(calls(log, "session.resume")[1].params, { session_id: "s-idle", omit_messages: true, inline_images: false, profile: "research" });
  await assert.rejects(c.send("s-main", "   "), /boş/);
});

test("deleteSession sends session.delete with the stored id and forgets the session locally", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log]);
  await startOpen(c);
  assert.ok(c.currentSnapshot().nodes.some((n) => n.sid === "s-idle"));
  assert.deepEqual(await c.deleteSession("s-idle", { profile: "research" }), { deleted: "s-idle" });
  // the stored key and the node's own profile go out; an idle session this Deck never resumed is not closed first
  assert.deepEqual(calls(log, "session.delete").map((e) => e.params), [{ session_id: "s-idle", profile: "research" }]);
  assert.equal(calls(log, "session.close").length, 0);
  assert.ok(!c.currentSnapshot().nodes.some((n) => n.sid === "s-idle"), "gone from the snapshot");
  await assert.rejects(c.deleteSession("bad id"), /geçersiz/i);
  await assert.rejects(c.deleteSession("s-main", { profile: "../x" }), /geçersiz/i);
  assert.equal(calls(log, "session.delete").length, 1);
});

test("a deleted session stays out of later snapshots even though the stream still lists it", async (t) => {
  const c = makeClient(t, []);
  await startOpen(c);
  await c.deleteSession("s-idle");
  await new Promise((r) => setTimeout(r, 700)); // the fake stream re-sends its snapshot every 200 ms, s-idle included
  assert.ok(!c.currentSnapshot().nodes.some((n) => n.sid === "s-idle"), "tombstoned for this run");
  assert.ok(c.currentSnapshot().nodes.some((n) => n.sid === "s-main"), "others stay");
});

test("deleteSession releases a session this Deck resumed before deleting it", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log]);
  await startOpen(c);
  await c.send("s-idle", "Selam", { profile: "research" }); // resumes it: it is live in the gateway now
  await c.deleteSession("s-idle", { profile: "research" });
  const methods = readLog(log).map((e) => e.method).filter((m) => ["session.resume", "session.close", "session.delete"].includes(m));
  assert.deepEqual(methods, ["session.resume", "session.close", "session.delete"]);
  assert.deepEqual(calls(log, "session.close")[0].params, { session_id: "rpc-s-idle" });
});

test("deleteSession passes Hermes's refusal of a running session on and keeps the session", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log]);
  await startOpen(c);
  await assert.rejects(c.deleteSession("s-main"), /cannot delete an active session/);
  assert.ok(c.currentSnapshot().nodes.some((n) => n.sid === "s-main"), "still listed");
  assert.equal(calls(log, "session.close").length, 0, "a running session is never torn down first");
});

test("a busy session queues the new turn", async (t) => {
  const c = makeClient(t, ["--busy"]);
  await startOpen(c);
  assert.deepEqual(await c.send("s-main", "sırada"), { status: "queued" });
});

test("files use the resumed runtime id and send once through the bounded host method", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log]);
  await startOpen(c);
  const files = [
    { filename: "shot.jpg", content_base64: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)]).toString("base64") },
    { filename: "clip.mp4", content_base64: Buffer.from("not really a video").toString("base64") },
  ];
  assert.deepEqual(await c.send("s-main", "Look at these", { files }), { status: "streaming" });
  assert.deepEqual(calls(log, "deck.attach_submit").map((r) => r.params), [{ session_id: "rpc-s-main", text: "Look at these", files }]);
  assert.equal(calls(log, "prompt.submit").length, 0);
  // a message of files only: empty text is allowed for this method (the host adds a default one)
  assert.deepEqual(await c.send("s-main", "", { files }), { status: "streaming" });
  assert.equal(calls(log, "deck.attach_submit")[1].params.text, "");
  // plain text still goes through prompt.submit and must not be empty
  await assert.rejects(c.send("s-main", "  ", { files: [] }), /boş/);
});

test("deck.attach_submit: strict shape, name charset, per-file and total caps; only it may be large", () => {
  const { HERMES_ATTACH } = require("../main/media");
  const b64 = (n) => Buffer.alloc(n, 0x61).toString("base64");
  const ok = { session_id: "rpc-s-main", text: "", files: [{ filename: "a.txt", content_base64: b64(10) }] };
  bridge.checkRequest("deck.attach_submit", ok);
  const bad = [
    { ...ok, path: "/etc/passwd" }, { ...ok, session_id: "" }, { ...ok, session_id: "a b" }, { ...ok, text: 5 }, { ...ok, text: "x".repeat(32001) },
    { ...ok, files: [] }, { ...ok, files: "x" }, { ...ok, files: Array(HERMES_ATTACH.files + 1).fill(ok.files[0]) },
    { ...ok, files: [{ filename: "../a.txt", content_base64: b64(3) }] }, { ...ok, files: [{ filename: "d/a.txt", content_base64: b64(3) }] },
    { ...ok, files: [{ filename: "d\\a.txt", content_base64: b64(3) }] }, { ...ok, files: [{ filename: "a\n.txt", content_base64: b64(3) }] },
    { ...ok, files: [{ filename: "..", content_base64: b64(3) }] }, { ...ok, files: [{ filename: "x".repeat(161), content_base64: b64(3) }] },
    { ...ok, files: [{ filename: "a.txt", content_base64: "not base64!" }] }, { ...ok, files: [{ filename: "a.txt", content_base64: "abc" }] },
    { ...ok, files: [{ filename: "a.txt", content_base64: "" }] }, { ...ok, files: [{ filename: "a.txt", content_base64: b64(3), path: "/x" }] },
    { ...ok, files: [{ filename: "a.txt", content_base64: b64(HERMES_ATTACH.file + 1) }] },
    { ...ok, files: ["x"] },
  ];
  for (const p of bad) assert.throws(() => bridge.checkRequest("deck.attach_submit", p), /Geçersiz|büyük/, JSON.stringify(p).slice(0, 120));
  // exactly at the per-file cap is fine, the total cap is enforced across files
  const full = { filename: "f.bin", content_base64: b64(HERMES_ATTACH.file) };
  bridge.checkRequest("deck.attach_submit", { ...ok, files: [full, { ...full, filename: "g.bin" }] });
  assert.throws(() => bridge.checkRequest("deck.attach_submit", { ...ok, files: [full, { ...full, filename: "g.bin" }, { ...full, filename: "h.bin" }] }), /Geçersiz|büyük/);
  // every other method keeps the 60,000-byte limit
  assert.throws(() => bridge.checkRequest("prompt.submit", { session_id: "rpc-s-main", text: "x".repeat(60001) }), /60\.000/);
  assert.throws(() => bridge.checkRequest("deck.appshot", {}), /Desteklenmeyen/);
});

test("steer, redirect and interrupt carry the live turn id and owner pid", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log]);
  await startOpen(c);
  assert.deepEqual(await c.steer("s-main", "kısa tut"), { status: "queued" });
  assert.deepEqual(await c.redirect("s-main", "önce testleri yaz", { turnId: "t1" }), { status: "redirected" });
  assert.deepEqual(await c.interrupt("s-main"), { status: "interrupted" });
  assert.deepEqual(await c.steer("s-child", "alt-ajana not"), { status: "queued" });
  assert.deepEqual(calls(log, "native.steer")[0].params, { session_id: "s-main", turn_id: "t1", owner_pid: 4242, text: "kısa tut" });
  assert.deepEqual(calls(log, "native.redirect")[0].params, { session_id: "s-main", turn_id: "t1", owner_pid: 4242, text: "önce testleri yaz" });
  assert.deepEqual(calls(log, "native.interrupt")[0].params, { session_id: "s-main", turn_id: "t1", owner_pid: 4242 });
  // refused locally, never sent: a stale turn, a session without live control, oversized text
  await assert.rejects(c.steer("s-main", "eski tur", { turnId: "t0" }), /Tur değişti/);
  await assert.rejects(c.steer("s-idle", "x", { profile: "research" }), /Canlı kontrol hazır değil/);
  await assert.rejects(c.steer("s-main", "x".repeat(32001)), /32\.000/);
  assert.equal(calls(log, "native.steer").length, 2);
  // controls never resume a session
  assert.equal(calls(log, "session.resume").length, 0);
});

test("interrupt falls back to the bound gateway session when the plugin has no control", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--uncontrolled", "--log", log]);
  await startOpen(c);
  await assert.rejects(c.interrupt("s-main"), /Durdurulacak/);
  await c.send("s-main", "başla");
  assert.deepEqual(await c.interrupt("s-main"), { status: "interrupted" });
  assert.deepEqual(calls(log, "session.interrupt")[0].params, { session_id: "rpc-s-main" });
  assert.equal(calls(log, "native.interrupt").length, 0);
});

test("model options, then a session-scoped switch that keeps Hermes's confirmation step", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log]);
  await startOpen(c);
  const m = await c.modelOptions("s-main");
  assert.deepEqual(m.current, { model: "model-a", provider: "prov" });
  assert.deepEqual(m.options.map((o) => [o.id, o.provider, o.current]), [["model-a", "prov", true], ["model-b", "prov", false], ["lab-1.5", "custom:labrelay", false]]);
  assert.deepEqual(m.options.map((o) => o.reasoning), [true, false, true]);
  assert.deepEqual(calls(log, "model.options")[0].params, { session_id: "rpc-s-main", include_unconfigured: false, refresh: false });
  // a custom provider (custom:<name>) switches like any other
  assert.deepEqual(await c.setModel("s-main", { model: "lab-1.5", provider: "custom:labrelay" }), { confirmRequired: false, message: "", warning: "", deferred: true });
  assert.equal(calls(log, "config.set").pop().params.value, "lab-1.5 --provider custom:labrelay --session");
  const ask = await c.setModel("s-main", { model: "model-b", provider: "prov" });
  assert.equal(ask.confirmRequired, true);
  assert.match(ask.message, /onaylıyor musun/);
  const done = await c.setModel("s-main", { model: "model-b", provider: "prov", confirm: true });
  assert.deepEqual(done, { confirmRequired: false, message: "", warning: "", deferred: true });
  assert.deepEqual(calls(log, "config.set").slice(1).map((e) => e.params), [
    { session_id: "rpc-s-main", key: "model", value: "model-b --provider prov --session" },
    { session_id: "rpc-s-main", key: "model", value: "model-b --provider prov --session", confirm_expensive_model: true },
  ]);
  await assert.rejects(c.setModel("s-main", { model: "model b", provider: "prov" }), /Model adı/);
  await assert.rejects(c.setModel("s-main", { model: "m", provider: "p --global" }), /Sağlayıcı/);
  await assert.rejects(c.setModel("s-main", { model: "m", provider: "custom:x --global" }), /Sağlayıcı/);
  assert.equal(calls(log, "session.resume").length, 1);
});

test("reasoning effort: one session, a known level, nothing else", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log]);
  await startOpen(c);
  assert.deepEqual(await c.setEffort("s-main", { effort: "high" }), { effort: "high" });
  assert.deepEqual(await c.setEffort("s-main", { effort: "none" }), { effort: "none" });
  assert.deepEqual(calls(log, "config.set").map((e) => e.params), [
    { session_id: "rpc-s-main", key: "reasoning", value: "high" },
    { session_id: "rpc-s-main", key: "reasoning", value: "none" },
  ]);
  for (const effort of ["show", "hide", "full", "High", "high --global", "", undefined]) {
    await assert.rejects(c.setEffort("s-main", { effort }), Error, String(effort));
  }
  assert.equal(calls(log, "config.set").length, 2, "refused before anything is sent");
});

test("config.set validation: model stays session-only; reasoning is one session and an effort word", () => {
  const { validModelSet, validReasoningSet, checkRequest } = bridge;
  assert.equal(validModelSet({ session_id: "r", key: "model", value: "m --provider custom:labrelay --session" }), true);
  assert.equal(validModelSet({ session_id: "r", key: "model", value: "m --provider p --session --global" }), false);
  assert.equal(validModelSet({ session_id: "r", key: "model", value: "m --provider p" }), false);
  for (const v of bridge.REASONING_EFFORTS) assert.equal(validReasoningSet({ session_id: "r", key: "reasoning", value: v }), true, v);
  for (const p of [
    { key: "reasoning", value: "high" },
    { session_id: "", key: "reasoning", value: "high" },
    { session_id: "a b", key: "reasoning", value: "high" },
    { session_id: "r", key: "reasoning", value: "high", scope: "global" },
    { session_id: "r", key: "reasoning", value: "show" },
    { session_id: "r", key: "reasoning", value: "hide" },
    { session_id: "r", key: "reasoning", value: "full" },
    { session_id: "r", key: "reasoning", value: "ultra" },
    { session_id: "r", key: "reasoning", value: ["high"] },
    { session_id: "r", key: "fast", value: "fast" },
  ]) {
    assert.equal(validReasoningSet(p), false, JSON.stringify(p));
    assert.throws(() => checkRequest("config.set", p), Error, JSON.stringify(p));
  }
  assert.doesNotThrow(() => checkRequest("config.set", { session_id: "r", key: "reasoning", value: "xhigh" }));
});

test("model options: custom providers kept, current matched by alias, capabilities projected, junk dropped", () => {
  const r = bridge.projectModelOptions({
    model: "lab-1.5", provider: "labrelay",
    providers: [
      { slug: "openai-codex", name: "OpenAI Codex", models: ["gpt-5", "gpt-5", "bad id"], capabilities: { "gpt-5": { reasoning: true, can_disable_reasoning: false } } },
      { slug: "custom:labrelay", name: "Lab Relay", is_user_defined: true, aliases: ["custom:labrelay", "labrelay"], models: ["lab-1.5"] },
      { slug: "custom:x --global", name: "Bad", models: ["m"] },
      { slug: "locked", name: "Locked", authenticated: false, models: ["z"] },
      { slug: "nous", name: "Nous", models: ["a", "b"], unavailable_models: ["b"] },
    ],
  });
  assert.deepEqual(r.current, { model: "lab-1.5", provider: "labrelay" });
  assert.deepEqual(r.options.map((o) => `${o.provider}/${o.id}`), ["openai-codex/gpt-5", "custom:labrelay/lab-1.5", "nous/a"]);
  const lab = r.options[1];
  assert.deepEqual([lab.current, lab.providerCurrent, lab.userDefined, lab.providerName], [true, true, true, "Lab Relay"]);
  assert.deepEqual([r.options[0].reasoning, r.options[0].canDisable, lab.canDisable], [true, false, null]);
});

test("approvals and questions: listed, answered once, then gone", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--approval", "--log", log]);
  const both = next(c, "requests", (list) => list.length === 2);
  c.start();
  const list = await both;
  const a = list.find((r) => r.id === "A7");
  const q = list.find((r) => r.id === "Q3");
  assert.deepEqual([a.kind, a.command, a.choices], ["approval", "rm -rf build", ["once", "session", "always", "deny"]]);
  assert.deepEqual(q.questions, [{ qid: "q1", question: "Hangi dal?", choices: ["main", "dev"], multi: false }]);
  await assert.rejects(c.answerApproval("A7", "forever"), /seçenek/);
  await assert.rejects(c.answerApproval("Q3", "once"), /açık değil/);
  await assert.rejects(c.answerQuestion("Q3", { other: "x" }), /bu soruya ait değil/);
  assert.deepEqual(await c.answerApproval("A7", "once"), { status: "ok" });
  assert.deepEqual(await c.answerQuestion("Q3", { q1: "main" }), { status: "ok" });
  assert.deepEqual(calls(log, "request.answer").map((e) => e.params), [
    { id: "A7", result: { choice: "once" } },
    { id: "Q3", result: { answers: { q1: "main" } } },
  ]);
  assert.equal(c.listRequests().length, 0);
  await assert.rejects(c.answerApproval("A7", "once"), /açık değil/);
  assert.equal(calls(log, "request.answer").length, 2);
});

test("a withdrawn approval disappears; a dropped connection clears every request", async (t) => {
  const c = makeClient(t, ["--approval", "--cancel-approval", "80"]);
  const asked = next(c, "requests", (list) => list.length === 2);
  c.start();
  await asked;
  const left = await next(c, "requests", (list) => list.length === 1);
  assert.equal(left[0].id, "Q3");
  const cleared = next(c, "requests", (list) => list.length === 0);
  c.stop();
  await cleared;
});

// ---------------------------------------------------------------- connection test (Settings)

test("the connection test reports success, a missing plugin, a rejected key and a missing python", async () => {
  const run = (flags) => bridge.probe(CFG, { launch: { file: process.execPath, args: [FAKE, "--serve", ...flags] }, timing: FAST, timeoutMs: 8000 });
  const good = await run([]);
  assert.equal(good.ok, true);
  assert.equal(good.sessions, 2);
  assert.match(good.text, /Bağlantı tamam/);
  assert.equal((await run(["--no-gateway"])).code, "plugin");
  assert.equal((await run(["--fail-stderr", "user@host: Permission denied (publickey).", "--exit-code", "255"])).code, "key");
  assert.equal((await run(["--fail-stderr", "Host key verification failed.", "--exit-code", "255"])).code, "host-unknown");
  assert.equal((await run(["--fail-stderr", "zsh:1: no such file or directory: /x/python", "--exit-code", "127"])).code, "python");
  assert.equal((await run(["--fail-stderr", "/x/python: can't open file '/x/stream.py': [Errno 2] No such file or directory", "--exit-code", "2"])).code, "stream");
  assert.equal((await run(["--no-snapshot"])).code, "handshake");
});

// ---------------------------------------------------------------- the real host side (hermes-deck plugin)

// testhost.py runs the hermes-deck plugin's own observer (control socket) and stream.py in one process, with
// a fake Hermes gateway behind them. It needs Unix sockets, so it runs on Linux and macOS.
const HOST = path.join(__dirname, "..", "..", "hermes-plugin", "hermes-deck", "testhost.py");
// ---------------------------------------------------------------- Botlar (profiles.list, avatars, Bot Chat)

test("Botlar request shapes: read-only roster and avatar, Bot Chat lookup/create/title only", () => {
  bridge.checkRequest("profiles.list", {});
  assert.throws(() => bridge.checkRequest("profiles.list", { include_sessions: false }), /profil listesi/);
  bridge.checkRequest("profiles.get_asset", { name: "bot-a", asset: "avatar" });
  for (const params of [{ name: "bot-a" }, { name: "../x", asset: "avatar" }, { name: "bot-a", asset: "soul" }, { name: "bot-a", asset: "avatar", data: "x" }]) {
    assert.throws(() => bridge.checkRequest("profiles.get_asset", params), /avatar/, JSON.stringify(params));
  }
  bridge.checkRequest("session.list", { limit: 50, profile: "bot-a" });
  bridge.checkRequest("session.list", { title: "Bot Chat", include_hidden: true, limit: 200, profile: "bot-a" });
  for (const params of [{ include_hidden: true }, { title: "Other" }, { title: "Bot Chat", include_hidden: "yes" }, { limit: 500 }, { profile: "../x" }, { order: "x" }]) {
    assert.throws(() => bridge.checkRequest("session.list", params), /oturum listesi/, JSON.stringify(params));
  }
  bridge.checkRequest("session.create", { idempotency_key: "0b1f8c1e-1111-4222-8333-944445555666", profile: "bot-a", title: "Bot Chat", hidden: true, follow_profile_config: true });
  for (const params of [{ hidden: true }, { title: "Other" }, { title: "Bot Chat", hidden: false }, { follow_profile_config: false }, { cwd: "/" }, { model: "m" }, { idempotency_key: "short" }]) {
    assert.throws(() => bridge.checkRequest("session.create", params), /yeni oturum/, JSON.stringify(params));
  }
  bridge.checkRequest("session.title", { session_id: "rpc-1", title: "Bot Chat" });
  for (const params of [{ session_id: "rpc-1", title: "Renamed" }, { session_id: "rpc-1" }, { title: "Bot Chat" }, { session_id: "rpc-1", title: "Bot Chat", profile: "x" }]) {
    assert.throws(() => bridge.checkRequest("session.title", params), /Bot Chat/, JSON.stringify(params));
  }
  // still no profile or cron writes
  for (const m of ["profiles.configure", "profiles.create", "profiles.set_asset", "cron.manage", "bot_relay.deliver"]) assert.throws(() => bridge.checkRequest(m, {}), /Desteklenmeyen/);
});

test("profiles.list projection: names, Bot Mode metadata and session refs; no paths, models, providers or workers", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log]);
  await startOpen(c);
  const rows = await c.profiles();
  assert.deepEqual(calls(log, "profiles.list").map((e) => e.params), [{}]);
  assert.deepEqual(rows.map((r) => r.name), ["default", "research", "writer", "ops", "archive-bot"]);
  const wire = JSON.stringify(rows);
  for (const leak of ["/home/someone", "model-a", "prov", "skill", "kanban", "w-1", "worker", "path", "legacy"]) assert.ok(!wire.includes(leak), `projection leaks ${leak}`);
  const research = rows.find((r) => r.name === "research");
  assert.deepEqual(research.meta, { title: "Araştırmacı", description: "Kaynak tarar, özet çıkarır.", shape: "hexagon", color: "#6fb3a6", custom: true, pinned: true, created: research.meta.created });
  assert.equal(research.canonical.id, "s-bot-research");
  assert.equal(research.canonical.resolvedId, "s-bot-research-2", "the compression tip is what opens");
  assert.equal(rows.find((r) => r.name === "writer").canonical, null);
  assert.equal(rows.find((r) => r.name === "writer").displayName, "Yazar");
  assert.equal(rows.find((r) => r.name === "default").isDefault, true);
  assert.deepEqual(rows.find((r) => r.name === "default").meta, {}, "a dead legacy ui_meta key is dropped");
  assert.equal(rows.find((r) => r.name === "archive-bot").meta.hidden, true);
  // hostile metadata never reaches an SVG attribute or the DOM unchecked
  const odd = bridge.projectProfiles({ profiles: [
    { name: "x", ui_meta: { "hermes-bots": { color: "url(javascript:alert(1))", shape: "<svg onload=x>", title: "a\nb", custom: "yes" } } },
    { name: "../evil" }, { name: "x" },
  ] });
  assert.equal(odd.length, 1);
  assert.deepEqual(odd[0].meta, { title: "a b" });
});

test("avatars: checked data: URLs only, Desktop's 160x160 face raster told apart, oversize refused", async (t) => {
  const c = makeClient(t);
  await startOpen(c);
  const def = await c.avatar("default");
  assert.deepEqual([def.found, def.mime, def.raster], [true, "image/png", true]);
  const writer = await c.avatar("writer");
  assert.deepEqual([writer.found, writer.raster], [true, false], "a real picture is not the face raster");
  assert.deepEqual(await c.avatar("ops"), { found: false });
  await assert.rejects(c.avatar("../x"), /Profil adı/);
  assert.deepEqual(bridge.projectAvatar({ found: true, data: "data:image/svg+xml;base64,PHN2Zz4=" }), { found: false, error: "format" });
  assert.deepEqual(bridge.projectAvatar({ found: true, data: "data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQ==" }), { found: false, error: "format" }, "bytes must match the declared type");
  const big = makeClient(t, ["--big-avatar"]);
  await startOpen(big);
  assert.deepEqual(await big.avatar("default"), { found: false, error: "size" });
  assert.deepEqual((await big.sessions()).map((r) => r.id), ["s-main", "s-idle"], "a big avatar reply did not drop the connection");
});

test("Bot Chat lookup: exact-title, hidden included, tip id; fails closed on errors, old hosts and vanished chats", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log]);
  await startOpen(c);
  const chat = await c.botChat("research");
  assert.deepEqual([chat.sid, chat.id, chat.profile, chat.title], ["s-bot-research-2", "s-bot-research", "research", "Bot Chat"]);
  assert.deepEqual(calls(log, "session.list").find((e) => e.params.title).params, { title: "Bot Chat", include_hidden: true, limit: 200, profile: "research" });
  assert.equal((await c.botChat("default")).sid, "s-bot-default");
  assert.ok(!("profile" in calls(log, "session.list").filter((e) => e.params.title)[1].params), "default is the gateway's own profile");
  assert.equal(await c.botChat("writer"), null, "no Bot Chat yet");
  await assert.rejects(c.botChat("writer", { expect: true }), /doğrulanamadı/, "the roster said it exists: empty is not 'none'");
  assert.equal(calls(log, "session.create").length, 0, "a lookup never creates");

  const fail = makeClient(t, ["--bot-lookup-fail"]);
  await startOpen(fail);
  await assert.rejects(fail.botChat("research"), /okunamadı.*yeni sohbet açılmadı/);
  await assert.rejects(fail.createBotChat("writer"), /okunamadı/);

  const old = makeClient(t, ["--title-ignored"]);
  await startOpen(old);
  await assert.rejects(old.botChat("research"), /desteklemiyor/, "a host that ignores title lists recent sessions");

  // seen once, then gone: fail closed instead of minting a second one
  const seen = makeClient(t, []);
  await startOpen(seen);
  await seen.botChat("ops");
  seen.botSeen.add("writer");
  await assert.rejects(seen.botChat("writer"), /doğrulanamadı/);
});

test("Bot Chat create: on first send only, Desktop's params, title persisted at once, no kickoff prompt", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log, "--no-bot-chat"]);
  await startOpen(c);
  // two first messages at once: one create
  const [a, b] = await Promise.all([c.createBotChat("writer"), c.createBotChat("writer")]);
  assert.equal(a.sid, b.sid);
  assert.deepEqual([a.created, a.pending, a.profile], [true, false, "writer"]);
  const creates = calls(log, "session.create");
  assert.equal(creates.length, 1);
  const { idempotency_key: key, ...rest } = creates[0].params;
  assert.match(key, /^[0-9a-f-]{36}$/);
  assert.deepEqual(rest, { title: "Bot Chat", hidden: true, follow_profile_config: true, profile: "writer" });
  assert.deepEqual(calls(log, "session.title").map((e) => e.params), [{ session_id: "rpc-s-bot-new-1", title: "Bot Chat" }]);
  assert.equal(calls(log, "prompt.submit").length, 0, "creating sends no prompt");
  // the next lookup finds the stored one; another create adopts it
  assert.equal((await c.botChat("writer")).sid, a.sid);
  assert.equal((await c.createBotChat("writer")).created, false);
  assert.equal(calls(log, "session.create").length, 1);
  // the user's first message then goes to the bound runtime session
  await c.send(a.sid, "Merhaba", { profile: "writer" });
  assert.deepEqual(calls(log, "prompt.submit").map((e) => e.params), [{ session_id: "rpc-s-bot-new-1", text: "Merhaba" }]);
  assert.equal(calls(log, "session.resume").length, 0, "a session created here needs no resume");
  // an existing Bot Chat is never created again
  const ex = makeClient(t, ["--log", log]);
  await startOpen(ex);
  const r = await ex.createBotChat("research", { expect: true });
  assert.deepEqual([r.sid, r.created], ["s-bot-research-2", false]);
  assert.equal(calls(log, "session.create").length, 1);
});

test("Bot Chat create: a title already taken adopts the winner; a host without session.title waits for the first turn", async (t) => {
  const log = tmpLog();
  const taken = makeClient(t, ["--log", log, "--no-bot-chat", "--title-taken"]);
  await startOpen(taken);
  const won = await taken.createBotChat("writer");
  assert.deepEqual([won.sid, won.created, won.adopted], ["s-bot-winner", false, true]);
  assert.ok(!taken.currentSnapshot().nodes.some((n) => n.sid === "s-bot-new-1"), "the abandoned lazy session is not shown");

  const log2 = tmpLog();
  const old = makeClient(t, ["--log", log2, "--no-bot-chat", "--no-title"]);
  await startOpen(old);
  const p = await old.createBotChat("writer");
  assert.deepEqual([p.created, p.pending], [true, true]);
  // until its first turn Hermes has no row titled Bot Chat: the lookup answers our pending chat, no second mint
  const again = await old.createBotChat("writer");
  assert.deepEqual([again.sid, again.pending], [p.sid, true]);
  assert.equal(calls(log2, "session.create").length, 1);
});

test("profiles.* on a host without the Botlar extension: a clear error, nothing else breaks", async (t) => {
  const c = makeClient(t, ["--no-profiles"]);
  await startOpen(c);
  await assert.rejects(c.profiles(), /Unsupported Hermes/);
  assert.deepEqual((await c.sessions()).map((r) => r.id), ["s-main", "s-idle"]);
});

const HOST_PY = process.env.DECK_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
const HOST_WRAPPER = process.env.DECK_TEST_HOST_WRAPPER; // a local shim that runs testhost.py where Python lacks AF_UNIX

test("BridgeClient against the real hermes-deck stream.py and plugin control socket", async (t) => {
  if (process.platform === "win32" && !HOST_WRAPPER) return t.skip("needs Unix sockets (Linux/macOS)");
  if (spawnSync(HOST_PY, ["--version"]).status !== 0) return t.skip("no python");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hd-")); // short: Unix socket paths are limited
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const launch = { file: HOST_PY, args: [...(HOST_WRAPPER ? [HOST_WRAPPER] : []), HOST, home] };
  const timing = { ...FAST, handshake: 10000, request: 5000, heartbeat: 12000 };
  const c = new BridgeClient(CFG, { launch, timing });
  t.after(() => c.stop());
  const snap = next(c, "snapshot", (s) => s.nodes.some((n) => n.sid === "s-main"), 15000);
  const asked = next(c, "requests", (list) => list.length === 1, 15000);
  c.start();
  const s = await snap;
  const main = s.nodes.find((n) => n.sid === "s-main");
  assert.deepEqual(
    { connectionId: s.connectionId, running: s.gateway.running, controlAvailable: main.controlAvailable, turnId: main.turnId, state: main.state, profile: main.profile },
    { connectionId: "hermes", running: true, controlAvailable: true, turnId: "t1", state: "thinking", profile: "default" }
  );
  // the automatic session.list opened the gateway socket, so Hermes' approval reaches the Deck
  const [approval] = await asked;
  assert.deepEqual([approval.id, approval.kind, approval.command, approval.choices], ["A1", "approval", "rm -rf build", ["once", "deny"]]);
  assert.deepEqual((await c.sessions()).map((r) => r.id), ["s-main", "s-idle"]);
  const h = await c.history("s-main");
  assert.deepEqual(h.messages.map((m) => [m.id, m.role, m.text]), [["11", "user", "Merhaba"], ["12", "assistant", "Selam"]]);
  const done = next(c, "event", (e) => e.type === "message.complete", 10000);
  assert.deepEqual(await c.send("s-main", "Merhaba"), { status: "streaming" });
  const complete = await done;
  assert.deepEqual([complete.sid, complete.rpcId, complete.payload.text], ["s-main", "rpc-s-main", "Merhaba"]);
  assert.deepEqual(await c.steer("s-main", "kısa tut"), { status: "queued" });
  assert.deepEqual(await c.redirect("s-main", "önce testleri yaz", { turnId: "t1" }), { status: "redirected" });
  assert.deepEqual(await c.interrupt("s-main"), { status: "interrupted" });
  const m = await c.modelOptions("s-main");
  assert.deepEqual(m.options.map((o) => [o.id, o.current]), [["model-a", true], ["model-b", false]]);
  assert.deepEqual(await c.setModel("s-main", { model: "model-b", provider: "prov" }), { confirmRequired: false, message: "", warning: "", deferred: true });
  assert.deepEqual(await c.answerApproval("A1", "once"), { status: "ok" });
  assert.equal(c.listRequests().length, 0);
  await c.stop();
  // the Settings connection test against a fresh host
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "hd-"));
  t.after(() => fs.rmSync(home2, { recursive: true, force: true }));
  const probed = await bridge.probe(CFG, { launch: { ...launch, args: [...launch.args.slice(0, -1), home2] }, timing, timeoutMs: 20000 });
  assert.equal(probed.ok, true, probed.text);
  assert.equal(probed.sessions, 2);
});

// ---------------------------------------------------------------- session browser (all sessions, every profile)

test("session browser request shapes: paged index, rename/pin, archive and branch are strict", () => {
  bridge.checkRequest("deck.session_index", { profile: "research", archived: "only", limit: 100, offset: 100 });
  bridge.checkRequest("deck.session_index", {});
  for (const params of [{ limit: 0 }, { limit: 101 }, { limit: "5" }, { offset: -1 }, { offset: 100001 }, { archived: "include" }, { archived: true },
    { profile: "../x" }, { profile: "" }, { source: "telegram" }, { include_hidden: true }, { query: "x" }]) {
    assert.throws(() => bridge.checkRequest("deck.session_index", params), /Geçersiz oturum isteği/, JSON.stringify(params));
  }
  bridge.checkRequest("deck.session_update", { session_id: "s-1", profile: "bot-a", title: "A  name", pinned: true });
  bridge.checkRequest("deck.session_update", { session_id: "s-1", pinned: false });
  for (const params of [{}, { session_id: "s-1" }, { session_id: "a b", title: "x" }, { session_id: "s-1", title: "" }, { session_id: "s-1", title: "  " },
    { session_id: "s-1", title: "x".repeat(101) }, { session_id: "s-1", title: "a\u0000b" }, { session_id: "s-1", title: "a\u202eb" },
    { session_id: "s-1", title: "Bot Chat" }, { session_id: "s-1", title: 4 }, { session_id: "s-1", pinned: "yes" },
    { session_id: "s-1", title: "x", hidden: true }, { session_id: "s-1", title: "x", archived: true }, { session_id: "s-1", title: "x", profile: "a/b" }]) {
    assert.throws(() => bridge.checkRequest("deck.session_update", params), /Geçersiz oturum isteği/, JSON.stringify(params));
  }
  bridge.checkRequest("session.archive", { session_id: "s-1", archived: true });
  bridge.checkRequest("session.archive", { session_id: "s-1", archived: false, profile: "bot-a" });
  for (const params of [{}, { session_id: "s-1" }, { archived: true }, { session_id: "s-1", archived: "true" }, { session_id: "s-1", archived: 1 },
    { session_id: "a b", archived: true }, { session_id: "s-1", archived: true, session_key: "k" }, { session_id: "s-1", archived: true, profile: "../x" }]) {
    assert.throws(() => bridge.checkRequest("session.archive", params), /Geçersiz oturum isteği/, JSON.stringify(params));
  }
  bridge.checkRequest("session.branch_stored", { parent_session_id: "s-1", profile: "bot-a", idempotency_key: "abcd-1234-efgh" });
  for (const params of [{}, { parent_session_id: "a b" }, { parent_session_id: "s-1", cwd: "/" }, { parent_session_id: "s-1", messages: [] },
    { parent_session_id: "s-1", title: "Bot Chat" }, { parent_session_id: "s-1", source: "telegram" }, { parent_session_id: "s-1", idempotency_key: "x" }]) {
    assert.throws(() => bridge.checkRequest("session.branch_stored", params), /Geçersiz oturum isteği/, JSON.stringify(params));
  }
  // nothing else on session.* may be reached
  for (const m of ["session.set_hidden", "session.pin", "session.compress", "session.most_recent", "session.foreign.import"]) assert.throws(() => bridge.checkRequest(m, { session_id: "s-1" }), /Desteklenmeyen/, m);
  assert.equal(bridge.cleanTitle("  a \n b  "), "a b");
  assert.equal(bridge.cleanTitle(" Bot   Chat "), null);
});

test("projectIndexRows keeps only ids Hermes returned, bounds fields and never invents a profile row", () => {
  const rows = bridge.projectIndexRows({ sessions: [
    { id: "s-1", title: " A\n title ", preview: "p".repeat(500), source: " Telegram ", started_at: 10, last_active: null, message_count: 3, archived: true, pinned: true },
    { id: "bad id" }, { id: 7 }, null, "x", { title: "no id" },
    { id: "s-2", started_at: "nope", last_active: 99 },
  ] }, "bot-a");
  assert.deepEqual(rows.map((r) => r.id), ["s-1", "s-2"]);
  assert.deepEqual(rows[0], { id: "s-1", profile: "bot-a", source: "telegram", title: "A title", preview: "p".repeat(200), lastPreview: "", lastRole: "", startedAt: 10, lastActive: 10, messages: 3, archived: true, pinned: true });
  assert.equal(rows[1].lastActive, 99);
  // plugin 2.7.0: the newest message rides along; a bad role is dropped
  const last = bridge.projectIndexRows({ sessions: [{ id: "s-3", preview: "first", last_preview: " newest \n line ", last_role: "assistant" }, { id: "s-4", last_preview: "x", last_role: "tool" }] }, "x");
  assert.deepEqual([last[0].preview, last[0].lastPreview, last[0].lastRole, last[1].lastRole], ["first", "newest line", "assistant", ""]);
  assert.deepEqual(bridge.projectIndexRows(null, "x"), []);
  assert.equal(bridge.projectIndexRows({ sessions: Array.from({ length: 500 }, (_, i) => ({ id: `s-${i}` })) }, "x").length, 200);
});

test("sessionIndex merges every profile's pages once, reports a profile that fails and caches", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log, "--index-fail", "ops"]);
  await startOpen(c);
  await new Promise((r) => setTimeout(r, 100)); // the automatic recent list (its own first page) goes first
  const mark0 = calls(log, "deck.session_index").length;
  const r = await c.sessionIndex();
  const byProfile = (name) => r.rows.filter((x) => x.profile === name);
  assert.equal(byProfile("default").length, 130, "two pages of the default profile");
  assert.deepEqual(byProfile("research").map((x) => [x.id, x.source, x.pinned]), [["s-tg-1", "telegram", true], ["s-dc-1", "discord", false]]);
  assert.equal(new Set(r.rows.map((x) => `${x.profile}/${x.id}`)).size, r.rows.length, "a session never appears twice");
  assert.deepEqual(r.profiles.filter((p) => !p.ok).map((p) => p.name), ["ops"]);
  assert.equal(r.legacy, false);
  const sent = calls(log, "deck.session_index").slice(mark0).map((e) => e.params);
  assert.ok(sent.every((p) => p.limit === 100 && p.archived === "exclude"));
  assert.deepEqual(sent.filter((p) => !p.profile).map((p) => p.offset || 0), [0, 100], "default: page 1, then page 2");
  // a second call inside the TTL is served from memory; force and mutations refresh
  const before = calls(log, "deck.session_index").length;
  assert.equal(await c.sessionIndex(), r);
  assert.equal(calls(log, "deck.session_index").length, before);
  await c.pinSession("s-tg-1", { profile: "research", pinned: false });
  const again = await c.sessionIndex();
  assert.notEqual(again, r);
  assert.equal(again.rows.find((x) => x.id === "s-tg-1").pinned, false);
  // concurrent callers share one fetch
  c.indexCache.clear();
  const n = calls(log, "deck.session_index").length;
  const [x, y] = await Promise.all([c.sessionIndex(), c.sessionIndex()]);
  assert.equal(x, y);
  const perRound = calls(log, "deck.session_index").length - n;
  assert.ok(perRound <= before, `one round of reads, not two (${perRound} vs ${before})`);
});

test("archived index lists only archived rows; unarchive and archive go through session.archive", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log]);
  await startOpen(c);
  const a = await c.sessionIndex({ archived: true });
  assert.deepEqual(a.rows.map((x) => [x.id, x.archived, x.profile]), [["s-old-1", true, "research"]]);
  assert.deepEqual(await c.archiveSession("s-old-1", { profile: "research", archived: false }), { archived: false });
  assert.deepEqual(calls(log, "session.archive")[0].params, { session_id: "s-old-1", archived: false, profile: "research" });
  await assert.rejects(c.archiveSession("s-old-1", { archived: "yes" }), /Geçersiz oturum/);
  await assert.rejects(c.archiveSession("bad id", { archived: true }), /geçersiz/i);
  assert.equal(calls(log, "session.archive").length, 1);
});

test("a running session is not archived from here; Hermes' own refusal is passed on", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log]);
  await startOpen(c);
  await assert.rejects(c.archiveSession("s-main", { archived: true }), /çalışıyor/);
  assert.equal(calls(log, "session.archive").length, 0);
});

test("rename sends one cleaned title as a user title; bad titles never leave", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log]);
  await startOpen(c);
  assert.deepEqual(await c.renameSession("s-dc-1", { profile: "research", title: "  Plan \n  B " }), { title: "Plan B" });
  assert.deepEqual(calls(log, "deck.session_update")[0].params, { session_id: "s-dc-1", title: "Plan B", profile: "research" });
  for (const title of ["", "   ", "Bot Chat", "x".repeat(101), "a\u0000b", 5]) await assert.rejects(c.renameSession("s-dc-1", { title }), /Geçersiz oturum/, String(title));
  assert.equal(calls(log, "deck.session_update").length, 1);
});

test("an older plugin without deck.session_index falls back to session.list (one window, no archive view)", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log, "--no-index"]);
  await startOpen(c);
  const r = await c.sessionIndex();
  assert.equal(r.legacy, true);
  assert.deepEqual(r.rows.filter((x) => x.profile === "default").map((x) => x.id), ["s-main", "s-idle"]);
  assert.ok(r.rows.every((x) => x.archived === false && x.pinned === false));
  const a = await c.sessionIndex({ archived: true });
  assert.deepEqual(a.rows, []);
  await assert.rejects(c.renameSession("s-idle", { profile: "default", title: "x" }), /Unsupported/);
});

test("Continue here branches a stored session into a new bound session without touching the original", async (t) => {
  const log = tmpLog();
  const c = makeClient(t, ["--log", log]);
  await startOpen(c);
  const r = await c.branchSession("s-tg-1", { profile: "research" });
  assert.deepEqual(r, { sid: "s-branch-s-tg-1", profile: "research" });
  const p = calls(log, "session.branch_stored")[0].params;
  assert.deepEqual(Object.keys(p).sort(), ["idempotency_key", "parent_session_id", "profile"]);
  assert.equal(p.parent_session_id, "s-tg-1");
  const node = c.nodeFor("s-branch-s-tg-1", "research");
  assert.ok(node && node.profile === "research" && node.fresh !== true, "shown until a snapshot lists it, history readable");
  assert.equal(calls(log, "session.resume").length, 0, "the original is never resumed");
  await assert.rejects(c.branchSession("bad id"), /geçersiz/i);
});
