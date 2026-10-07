"use strict";
// The Deck's private driver daemon with the fake cua-driver: bounded flags and environment, restart on a new
// manifest, a failing start reported at once, killAll. Run: cd app && npm test
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Driver, callError } = require("../main/cua/driver");
const M = require("../main/cua/manifest");
const W = require("../main/cua/windows");
const { setLanguage } = require("../renderer/i18n");
setLanguage("tr");

// the fake driver is a plain process, never a CuaDriver.app: macOS runs the spawn path too
const PLATFORM = process.platform === "darwin" ? "linux" : process.platform;
const FAKE = path.join(__dirname, "fixtures", "fake-cua-driver.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-cua-drv-"));
  const log = path.join(dir, "calls.ndjson");
  const sock = process.platform === "win32" ? `\\\\.\\pipe\\hdtest-${crypto.randomBytes(6).toString("hex")}` : path.join(dir, "d.sock");
  // an inherited unrestricted mode and HTTP listener must never reach the driver
  const env = { ...process.env, FAKE_CUA_LOG: log, CUA_DRIVER_RS_MCP_HTTP_PORT: "9999", CUA_DRIVER_PERMISSION_MODE: "unrestricted", ...extraEnv };
  const driver = new Driver({ dir, platform: PLATFORM, locate: () => ({ bin: process.execPath, prefix: [FAKE] }), socket: sock, env });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, sock, driver, calls };
}

test("driver: bounded daemon, restart on a new manifest, fast failure, killAll", { timeout: 60000 }, async () => {
  const { dir, sock, driver, calls } = setup();
  try {
    await driver.ensure({ key: "a", text: "version: 3\n" });
    assert.strictEqual(driver.state, "running");
    const serve = calls().find((c) => c.argv[0] === "serve");
    assert.deepStrictEqual(serve.argv, ["serve", "--socket", sock, "--permission-mode", "bounded", "--capability-manifest", path.join(dir, "session.yaml"), "--approve-capability-manifest"]);
    assert.deepStrictEqual([serve.mode, serve.approved, serve.manifest, serve.http], ["bounded", "1", path.join(dir, "session.yaml"), null]);
    await driver.ensure({ key: "a", text: "version: 3\n" }); // same manifest: no restart
    assert.strictEqual(calls().filter((c) => c.argv[0] === "serve").length, 1);

    const child = driver.run(["mcp"]);
    for (let i = 0; i < 100 && !calls().some((c) => c.argv[0] === "mcp"); i++) await sleep(50);
    const mcp = calls().find((c) => c.argv[0] === "mcp");
    assert.ok(mcp, "the bounded MCP channel started within five seconds");
    assert.deepStrictEqual(mcp.argv, ["mcp", "--socket", sock]);
    await driver.ensure({ key: "b", text: "version: 3\n# another grant\n" });
    assert.strictEqual(calls().filter((c) => c.argv[0] === "serve").length, 2, "restarted for the new manifest");
    assert.ok(child.exitCode !== null || child.signalCode, "channel processes of the old daemon were killed");
    assert.match(await driver.call("list_windows", {}), /Book1 - Excel/);
    assert.match((await driver.execInfo(["manifest"])).stdout, /mcp_invocation/);

    driver.killAll();
    assert.strictEqual(driver.state, "stopped");
    for (let i = 0; i < 60; i++) {
      if ((await driver.exec(process.execPath, [FAKE, "status", "--socket", sock], { timeout: 4000 })).code !== 0) break;
      await sleep(100);
    }
    assert.notStrictEqual((await driver.exec(process.execPath, [FAKE, "status", "--socket", sock], { timeout: 4000 })).code, 0, "the daemon is gone");
  } finally {
    driver.killAll();
  }

  const bad = setup({ FAKE_CUA_SERVE_FAIL: "1" });
  const t0 = Date.now();
  await assert.rejects(bad.driver.ensure({ key: "x", text: "version: 3\n" }), /sürücü başlamadı: fake failure on start/);
  assert.ok(Date.now() - t0 < 5000, "a daemon that exits is reported at once, not after the 10 s wait");
  assert.strictEqual(bad.driver.state, "error");
});

// The EADDRINUSE seen on Linux: a SIGKILLed daemon (killAll, a restart for a new manifest) leaves its Unix
// socket file behind, and the next daemon's listen() on the same path failed. The driver clears a stale socket
// file before it starts a daemon; anything that is not a socket is left alone.
test("driver: a stale socket file from a killed daemon does not stop the next start", { skip: process.platform === "win32" ? "named pipes leave no file" : false, timeout: 30000 }, async () => {
  const { sock, driver } = setup();
  const { spawn } = require("child_process");
  try {
    // a process listens on the path and is SIGKILLed, as killAll does to a daemon: the socket file stays
    const holder = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(sock)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((r) => holder.stdout.once("data", r));
    holder.kill("SIGKILL");
    await new Promise((r) => holder.once("exit", r));
    assert.ok(fs.lstatSync(sock).isSocket(), "a dead socket file is there");
    await driver.ensure({ key: "a", text: "version: 3\n" });
    assert.strictEqual(driver.state, "running");
    driver.killAll();
    // a regular file at the path is not ours to delete: the start fails and the file stays
    for (let i = 0; i < 50 && fs.existsSync(sock) && fs.lstatSync(sock).isSocket(); i++) {
      try {
        fs.unlinkSync(sock);
      } catch {
        /* gone */
      }
    }
    fs.writeFileSync(sock, "not a socket");
    await assert.rejects(driver.ensure({ key: "b", text: "version: 3\n" }), /sürücü başlamadı/);
    assert.strictEqual(fs.readFileSync(sock, "utf8"), "not a socket");
  } finally {
    driver.killAll();
  }
});

test("driver: the consent sheet's daemon lists every window; a grant's daemon only the granted pid", { timeout: 60000 }, async () => {
  // cua-driver 0.33.3 in bounded mode, as the fake models it from the real driver: under desktop.display: false a
  // list_windows without a pid, and any list_apps, is "desktop display observation" and refused. Two daemons, each
  // started once (no restart on one socket path, so this runs on hosts where that restart is flaky).
  const sources = [
    { id: "window:1001:0", name: "Book1 - Excel" },
    { id: "window:1002:0", name: "notes.txt - Notepad" },
  ];
  const picker = setup();
  const granted = setup();
  try {
    // the picker: display: true, list_windows only. Every window comes back with its pid, so the cards resolve
    await picker.driver.ensure(M.pickerManifest());
    const records = W.parseListWindows(await picker.driver.call("list_windows", {}));
    assert.deepStrictEqual(records.map((r) => [r.id, r.pid]), [[1001, 4242], [77, 4242], [1002, 4343]]);
    const cards = W.mergeWindows(sources, records);
    assert.deepStrictEqual(cards.map((w) => [w.id, w.pid, w.app, w.blocked]), [[1001, 4242, "Excel", null], [1002, 4343, "Notepad", null]]);
    // display: true buys the window list and nothing else: tools outside allow.tools stay refused
    for (const tool of ["list_apps", "get_screen_size", "get_desktop_state", "click"]) await assert.rejects(picker.driver.call(tool, {}), /outside the capability manifest/, tool);

    // a grant: display: false. Pid-less listings are refused, the granted pid answers
    const grant = { agent: "Atlas", expires: Date.now() + 3600_000, idleMin: 30, startedAt: 1 };
    await granted.driver.ensure(M.grantManifest({ grant, ident: { executable: "C:\\Example\\excel.exe" }, platform: "win32" }));
    await assert.rejects(granted.driver.call("list_windows", {}), /desktop display observation is outside the capability manifest/);
    await assert.rejects(granted.driver.call("list_windows", { on_screen_only: true }), /desktop display observation/);
    // list_apps is not in the grant's manifest at all (the relay answers it; see relay/src/mcpfence.js)
    await assert.rejects(granted.driver.call("list_apps", {}), /outside the capability manifest/);
    assert.deepStrictEqual(W.parseListWindows(await granted.driver.call("list_windows", { pid: 4242, on_screen_only: true })).map((r) => r.id), [1001, 77]);

    // the old symptom, for the record: a picker under display: false lists nothing, so every card is blocked
    let note = null;
    let none = [];
    try {
      none = W.parseListWindows(await granted.driver.call("list_windows", {}));
    } catch (e) {
      note = e.message;
    }
    assert.strictEqual(note, "protected resource is outside the capability manifest: desktop display observation is outside the capability manifest");
    assert.ok(W.mergeWindows(sources, none).every((w) => /^Uygulaması belirlenemedi/.test(w.blocked)));
  } finally {
    picker.driver.killAll();
    granted.driver.killAll();
  }
});

test("driver: a failed call reads as one line (a bounded refusal's message, not its JSON)", () => {
  const refusal = { refusal: { code: "bounded_resource_outside_manifest", message: "desktop display observation is outside the capability manifest" }, status: "refused" };
  assert.strictEqual(callError({ code: 1, stdout: JSON.stringify(refusal, null, 2), stderr: "" }), refusal.refusal.message);
  assert.strictEqual(callError({ code: 1, stdout: "", stderr: "daemon not running\n" }), "daemon not running");
  assert.strictEqual(callError({ code: 1, stdout: "{ not json", stderr: "" }), "{ not json");
  assert.strictEqual(callError({ code: 3, stdout: "", stderr: "" }), "çıkış 3");
  assert.strictEqual(callError({ code: 1, stdout: "x".repeat(500), stderr: "" }).length, 200);
  // the refusal is found wherever it is: next to a stderr warning, after text with brackets, before a hint,
  // or on stderr itself
  const json = JSON.stringify(refusal);
  const why = refusal.refusal.message;
  assert.strictEqual(callError({ code: 1, stdout: json + "\n", stderr: "warning: something\n" }), why);
  assert.strictEqual(callError({ code: 1, stdout: `Error [bounded] {call}: ${json}`, stderr: "" }), why);
  assert.strictEqual(callError({ code: 1, stdout: `${json}\nhint: see {docs} for the manifest`, stderr: "" }), why);
  assert.strictEqual(callError({ code: 1, stdout: "", stderr: `error: ${JSON.stringify(refusal, null, 2)}\n` }), why);
  assert.strictEqual(callError({ code: 1, stdout: JSON.stringify({ error: "no such tool" }), stderr: "trace {" }), "no such tool");
  // a quoted brace inside the message does not cut the object short
  assert.strictEqual(callError({ code: 1, stdout: JSON.stringify({ refusal: { message: 'window "}" is gone' } }), stderr: "" }), 'window "}" is gone');
  // no refusal anywhere: stderr's text first, as before
  assert.strictEqual(callError({ code: 1, stdout: '{"status":"failed"}', stderr: "daemon crashed\n" }), "daemon crashed");
  assert.strictEqual(callError({ code: 1, stdout: '{"status":"failed"}', stderr: "" }), '{"status":"failed"}');
});
