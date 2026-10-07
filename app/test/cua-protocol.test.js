"use strict";
// Pure parts of the bot screen's device side: argv rules, grants, the capability manifest and the consent
// sheet's window matching (the frames: cua-channel.test.js). Run: cd app && npm test
const test = require("node:test");
const assert = require("node:assert");
const P = require("../main/cua/protocol");
const G = require("../main/cua/grant");
const M = require("../main/cua/manifest");
const W = require("../main/cua/windows");
const { setLanguage } = require("../renderer/i18n");
setLanguage("tr");

test("protocol: verb allowlist and forbidden flags answer 126", () => {
  for (const v of ["mcp", "manifest", "--help", "call", "status", "doctor"]) assert.deepStrictEqual(P.checkArgv([v]), { ok: true, verb: v });
  assert.deepStrictEqual(P.checkArgv(["call", "list_windows", '{"pid":1}']), { ok: true, verb: "call" });
  for (const argv of [["serve"], ["revoke", "--all"], ["update", "--apply"], ["kill_app", "{}"], [], ["MCP"]]) {
    assert.deepStrictEqual(P.checkArgv(argv), { ok: false, code: 126, error: "verb not allowed" }, argv.join(" "));
  }
  for (const argv of [
    ["mcp", "--socket", "\\\\.\\pipe\\other"],
    ["mcp", "--socket=/tmp/x.sock"],
    ["call", "--permission-mode", "unrestricted", "click"],
    ["mcp", "--dangerously-bypass-approvals"],
    ["mcp", "--direct"],
    ["mcp", "--embedded"],
    ["mcp", "--no-overlay"],
    ["status", "--pid-file", "x"],
    ["mcp", "--http-endpoint=0.0.0.0:1"],
    ["mcp", "--Capability-Manifest", "x.yaml"],
    ["mcp", "--grant", "existing-profile"],
    ["call", "get_window_state", "{}", "--screenshot-out-file", "C:\\Users\\x\\Desktop\\a.png"],
    ["call", "zoom", "{}", "--output-dir=/tmp"],
  ]) {
    assert.deepStrictEqual(P.checkArgv(argv), { ok: false, code: 126, error: "flag not allowed" }, argv.join(" "));
  }
  assert.strictEqual(P.checkArgv(["call", "x\0y"]).ok, false);
  assert.deepStrictEqual(P.checkArgv(["doctor", "--json"]), { ok: true, verb: "doctor" });
  assert.deepStrictEqual(P.checkArgv(["manifest", "--pretty"]), { ok: true, verb: "manifest" });
});

test("protocol: info verbs leave without this computer's home folder", () => {
  const home = "C:\\Users\\someone";
  const man = JSON.stringify({ binary_path: "C:\\Users\\someone\\AppData\\Local\\hermes-deck\\cua-driver\\0.33.3\\cua-driver.exe", binary_version: "0.33.3", mcp_invocation: { command: "C:\\Users\\someone\\AppData\\Local\\x\\cua-driver.exe", args: ["mcp"] } });
  const out = JSON.parse(P.scrubInfo("manifest", man, home));
  assert.deepStrictEqual(out, { binary_path: "cua-driver", binary_version: "0.33.3", mcp_invocation: { command: "cua-driver", args: ["mcp"] } });
  const doctor = P.scrubInfo("doctor", '{"log":"C:\\\\Users\\\\someone\\\\AppData\\\\x.log","cfg":"c:/users/SOMEONE/.cua"}\nlog dir C:\\Users\\someone\\logs', home);
  assert.ok(!/someone/i.test(doctor), doctor);
  assert.ok(doctor.includes("~\\\\AppData") && doctor.includes("~/.cua") && doctor.includes("~\\logs"), doctor);
  assert.strictEqual(P.scrubInfo("--help", "usage: cua-driver", home), "usage: cua-driver");
  assert.ok(P.INFO_VERBS.has("manifest") && !P.INFO_VERBS.has("mcp") && !P.INFO_VERBS.has("call"));
});

test("protocol: the Deck's own socket and bounded environment", () => {
  assert.deepStrictEqual(P.spawnArgs(["mcp"], { socket: "S" }), ["mcp", "--socket", "S"]);
  assert.deepStrictEqual(P.spawnArgs(["call", "list_windows", "{}"], { socket: "S" }), ["call", "--socket", "S", "list_windows", "{}"]);
  assert.deepStrictEqual(P.spawnArgs(["status"], { socket: "S" }), ["status", "--socket", "S"]);
  assert.deepStrictEqual(P.spawnArgs(["manifest"], { socket: "S" }), ["manifest"]);
  assert.deepStrictEqual(P.daemonArgs({ socket: "S", manifest: "/m.yaml" }), ["serve", "--socket", "S", "--permission-mode", "bounded", "--capability-manifest", "/m.yaml", "--approve-capability-manifest"]);
  const env = P.driverEnv({ PATH: "/bin", CUA_DRIVER_PERMISSION_MODE: "unrestricted", CUA_DRIVER_RS_MCP_HTTP_PORT: "9000", CUA_DRIVER_POLICY_FILE: "/p.yaml", ELECTRON_RUN_AS_NODE: "1" }, { manifest: "/m.yaml" });
  assert.deepStrictEqual(env, { PATH: "/bin", CUA_DRIVER_POLICY_FILE: "/p.yaml", CUA_DRIVER_PERMISSION_MODE: "bounded", CUA_DRIVER_CAPABILITY_MANIFEST_FILE: "/m.yaml", CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: "1" });
  assert.strictEqual(P.exitCode(0, null), 0);
  assert.strictEqual(P.exitCode(3, null), 3);
  assert.strictEqual(P.exitCode(null, "SIGKILL"), 137);
  assert.strictEqual(P.exitCode(null, "SIGTERM"), 143);
  assert.strictEqual(P.exitCode(null, null), 1);
  assert.deepStrictEqual(P.chunks(Buffer.alloc(10), 4).map((b) => b.length), [4, 4, 2]);
});

test("grant: shape, 2 h cap, idle and expiry", () => {
  const now = 1_000_000;
  const g = G.makeGrant({ agent: "Atlas", profile: "atlas", app: "Excel", window: { id: 1001, pid: 4242, title: "Book1 - Excel\n" }, now, durationMs: 10 * 3600 * 1000 });
  assert.strictEqual(g.expires, now + 2 * 3600 * 1000);
  assert.strictEqual(g.idleMin, 30);
  assert.deepStrictEqual(G.wireGrant(g), { agent: "Atlas", app: "Excel", window: { id: 1001, pid: 4242, title: "Book1 - Excel" }, expires: now + 7200000, idleMin: 30, foreground: false });
  for (const value of [undefined, false, "true", 1, true]) {
    const consent = G.makeGrant({ agent: "Atlas", profile: "atlas", app: "Excel", window: g.window, foreground: value });
    assert.strictEqual(consent.foreground, value === true);
    assert.strictEqual(G.wireGrant(consent).foreground, value === true);
  }
  assert.strictEqual(G.endReason(g, { now: now + 60000, lastActivity: now }), null);
  assert.strictEqual(G.endReason(g, { now: now + 30 * 60000, lastActivity: now }), "idle");
  assert.strictEqual(G.endReason(g, { now: now + 40 * 60000, lastActivity: now + 20 * 60000 }), null);
  assert.strictEqual(G.endReason(g, { now: now + 2 * 3600 * 1000, lastActivity: now + 2 * 3600 * 1000 }), "expiry");
  assert.strictEqual(G.remaining(g, now + 3600 * 1000), 3600 * 1000);
  assert.throws(() => G.makeGrant({ agent: "Atlas", profile: "atlas", app: "X", window: { id: 1, pid: null, title: "t" } }), /uygulaması/);
  assert.throws(() => G.makeGrant({ agent: "", profile: "atlas", app: "X", window: { id: 1, pid: 2 } }), /Ajan/);
  assert.throws(() => G.makeGrant({ agent: "A", profile: "../x", app: "X", window: { id: 1, pid: 2 } }), /profili/);
});

test("manifest: bounded, one app, no kill_app, full display only for the picker's window list", () => {
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  const grant = G.makeGrant({ agent: "Atlas", profile: "atlas", app: "Excel", window: { id: 1001, pid: 4242, title: "Book1 - Excel" }, now });
  const win = M.grantManifest({ grant, ident: { executable: 'C:\\Program Files\\Office\\EXCEL "x".EXE' }, platform: "win32", now: now + 2 * 60000 });
  assert.match(win.text, /^version: 3$/m);
  assert.match(win.text, /^expires_after: 118m$/m);
  assert.match(win.text, /^idle_timeout: 30m$/m);
  assert.ok(win.text.includes('    - executable: "C:\\\\Program Files\\\\Office\\\\EXCEL \\"x\\".EXE"'), win.text);
  // launch_app may start the granted app only: the driver scopes it to this one app entry
  assert.match(win.text, /launch: true\n {6}windows: all\n {6}terminate: deny/);
  assert.match(win.text, /desktop:\n {4}display: false/);
  // never, whatever the relay's fence would pass: killing apps, moving the user's windows or pointer, the
  // whole desktop, the clipboard
  for (const never of ["kill_app", "bring_to_front", "set_window_frame", "move_cursor", "get_desktop_state", "get_accessibility_tree", "clipboard_read", "clipboard_write", "browser_click", "start_recording", "install_extension"]) {
    assert.ok(!new RegExp(`- ${never}$`, "m").test(win.text), never);
  }
  // what Hermes calls under the hood (the relay pins list_windows to the granted pid and cuts the answer down to
  // the granted window); list_apps has no pid filter, so it could never pass display: false: the relay answers it
  for (const tool of ["click", "get_window_state", "list_windows", "launch_app", "get_config", "set_agent_cursor_enabled"]) assert.match(win.text, new RegExp(`^ {4}- ${tool}$`, "m"), tool);
  assert.ok(!/^ {4}- list_apps$/m.test(win.text));
  assert.ok(win.text.split("\n").every((l) => l.length <= 120), "comment lines stay whole");
  const mac = M.grantManifest({ grant, ident: { bundleId: "com.microsoft.Excel" }, platform: "darwin", now });
  assert.ok(mac.text.includes('    - bundle_id: "com.microsoft.Excel"'));
  assert.notStrictEqual(mac.key, M.grantManifest({ grant: { ...grant, startedAt: now + 1 }, ident: { bundleId: "com.microsoft.Excel" }, platform: "darwin", now }).key);
  assert.throws(() => M.grantManifest({ grant, ident: { executable: "EXCEL.EXE" }, platform: "win32" }), /kimliği/);
  assert.throws(() => M.grantManifest({ grant, ident: {}, platform: "darwin" }), /kimliği/);
  // tools the installed driver does not know are dropped (`cua-driver list-tools` prints "name: description")
  const known = M.knownTools("bring_to_front: Activate a window\nclick: Left-click against a target pid\nget_window_state: Walk a running app's AX tree\nkill_app: Force-terminate\nstart_session: Optionally create a session\n");
  const slim = M.grantManifest({ grant, ident: { bundleId: "com.example.App" }, platform: "darwin", now, known });
  assert.deepStrictEqual(slim.text.match(/^ {4}- (\w+)$/gm).map((l) => l.trim().slice(2)), ["start_session", "get_window_state", "click"]);
  assert.match(slim.text, /launch: false/, "no launch_app, so no launching");
  assert.strictEqual(M.knownTools({ tools: [{ name: "click" }, { name: "get_window_state" }, { name: "start_session" }] }).size, 3);
  // output that is not plainly a tool list means "unknown": the full list is written
  assert.strictEqual(M.knownTools("not json"), null);
  assert.strictEqual(M.knownTools({ tools: [{ name: "click" }] }), null);
  assert.strictEqual(M.knownTools(JSON.stringify({ binary_version: "0.33.3", subcommands: [] })), null);
  assert.match(mac.text, /desktop:\n {4}display: false/);
  assert.match(slim.text, /desktop:\n {4}display: false/);
  // the consent sheet lists every window: cua-driver 0.33.3 refuses a list_windows without a pid under
  // display: false, so the picker (and only the picker) gets display: true, with list_windows as its one tool
  const picker = M.pickerManifest();
  assert.strictEqual(picker.key, "picker");
  assert.match(picker.text, /^resources:\n {2}desktop:\n {4}display: true$/m);
  assert.ok(!/apps:/.test(picker.text));
  assert.deepStrictEqual(picker.text.match(/^ {4}- (\w+)$/gm).map((l) => l.trim().slice(2)), ["start_session", "end_session", "list_windows"]);
  assert.ok(picker.text.split("\n").every((l) => l.length <= 120));
  assert.strictEqual(M.duration(59000), "1m");
});

test("windows: capture sources matched with list_windows; the Deck and password managers are kept out", () => {
  assert.strictEqual(W.sourceHandle("window:132456:0"), 132456);
  assert.strictEqual(W.sourceHandle("screen:0:0"), null);
  assert.strictEqual(W.guessApp("Book1 - Excel"), "Excel");
  assert.strictEqual(W.guessApp("Untitled"), "Untitled");
  const recs = W.parseListWindows('log line\n{"windows":[{"window_id":11,"pid":5,"app_name":"Excel","title":"Book1 - Excel"},{"window_id":12,"pid":6,"app_name":"Notes","title":"Ideas"},{"window_id":13,"pid":99,"app_name":"Hermes Deck","title":"Hermes Deck"},{"window_id":14,"pid":7,"app_name":"1Password","title":"1Password"}]}');
  assert.strictEqual(recs.length, 4);
  assert.deepStrictEqual(W.parseListWindows({ content: [{ type: "text", text: JSON.stringify([{ window_id: 3, pid: 4, title: "x" }]) }] }).map((r) => r.id), [3]);
  assert.deepStrictEqual(W.parseListWindows({ structuredContent: { windows: [{ window_id: 8, pid: 9 }] } }).map((r) => r.id), [8]);
  const sources = [
    { id: "window:11:0", name: "Book1 - Excel", thumb: "data:image/png;base64,AA" },
    { id: "window:777:0", name: "Ideas" }, // legacy non-Windows title fallback
    { id: "window:13:0", name: "Hermes Deck" }, // the Deck itself
    { id: "window:500:0", name: "Bitwarden" }, // no record: no pid
    { id: "window:14:0", name: "1Password" },
    { id: "window:600:0", name: "Hermes Deck durumu" },
  ];
  const list = W.mergeWindows(sources, recs, { ownIds: new Set(["window:600:0"]), ownPids: new Set([99]), platform: "darwin" });
  assert.deepStrictEqual(
    list.map((w) => [w.sourceId, w.id, w.pid, w.app, !!w.blocked]),
    [
      ["window:11:0", 11, 5, "Excel", false],
      ["window:777:0", 12, 6, "Notes", false],
      ["window:500:0", 500, null, "Bitwarden", true],
      ["window:14:0", 14, 7, "1Password", true],
    ]
  );
  // a window the driver did not report is blocked with that reason; with no records at all, the driver is the cause
  const stray = [{ id: "window:501:0", name: "Untitled - Paint" }];
  assert.strictEqual(W.mergeWindows(stray, recs)[0].blocked, "Uygulaması belirlenemedi: sürücü bu pencereyi listelemedi.");
  assert.strictEqual(W.mergeWindows(stray, [])[0].blocked, "Uygulaması belirlenemedi: önce sürücüyü kur ve çalıştır.");
  const sameTitle = W.mergeWindows([{ id: "window:999:0", name: "Ideas" }], recs, { platform: "win32" });
  assert.equal(sameTitle[0].pid, null, "Windows never borrows another HWND's owner from its title");
  assert.ok(sameTitle[0].blocked);
  // macOS without the Deck's Screen Recording grant: no sources, the driver's windows still show
  const fallback = W.mergeWindows([], recs, { ownPids: new Set([99]) });
  assert.deepStrictEqual(fallback.map((w) => w.sourceId), ["cua:11", "cua:12", "cua:14"]);
  assert.ok(W.isPasswordManager({ executable: "C:\\Program Files\\KeePassXC\\KeePassXC.exe" }));
  assert.ok(W.isPasswordManager({ bundleId: "com.apple.Passwords" }));
  assert.ok(!W.isPasswordManager({ app: "Excel", executable: "C:\\Office\\EXCEL.EXE" }));
  assert.strictEqual(W.exeFromPowerShell("C:\\Program Files\\Microsoft Office\\EXCEL.EXE\r\n"), "C:\\Program Files\\Microsoft Office\\EXCEL.EXE");
  assert.strictEqual(W.exeFromPowerShell("Get-Process : Cannot find a process"), null);
  assert.strictEqual(W.bundlePathFromComm("/Applications/Microsoft Excel.app/Contents/MacOS/Microsoft Excel\n"), "/Applications/Microsoft Excel.app");
  assert.strictEqual(W.bundlePathFromComm("/usr/bin/vim"), null);
  assert.strictEqual(W.parseBundleId("com.microsoft.Excel\n"), "com.microsoft.Excel");
  assert.ok(W.samePath("C:\\A\\electron.exe", "c:/a/ELECTRON.exe", "win32"));
  assert.ok(!W.samePath("/a/b", "/a/B", "linux"));
});
