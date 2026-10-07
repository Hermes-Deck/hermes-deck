"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { readMacWindow, readFocused } = require("../main/cua/frontmost-mac");
const { readWindow } = require("../main/cua/frontmost");
const i18n = require("../renderer/i18n");
const IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=", "base64");
const FOCUS = { pid: 4242, app: "Example", executable: "/Applications/Example.app/Contents/MacOS/Example", bundleId: "com.example.Editor", title: "Document", bounds: { x: -300, y: 40, width: 600, height: 400 } };
const WINDOW = { window_id: 1001, pid: 4242, app_name: "Example", title: "Document", bounds: FOCUS.bounds, is_on_screen: true, z_index: 3 };

function setup({ windows = [WINDOW], focus = [FOCUS], image = true, frame = {}, refuse = false } = {}) {
  const calls = [], manifests = [], native = [];
  let read = 0, stopped = 0;
  const readFocused = async (...args) => { native.push(args); return focus[Math.min(read++, focus.length - 1)]; };
  const driver = {
    ensure: async (m) => manifests.push(m),
    call: async (tool, args) => {
      calls.push({ tool, args });
      if (refuse) return JSON.stringify({ isError: true, structuredContent: { refusal: { message: "Denied" } } });
      return JSON.stringify(tool === "list_windows" ? { structuredContent: { windows } } : { structuredContent: { pid: 4242, window_id: 1001, window_bounds: FOCUS.bounds, screenshot_frame_valid: true, ...frame }, content: image ? [{ type: "image", mimeType: "image/png", data: IMAGE.toString("base64") }] : [] });
    },
    stop: async () => stopped++,
  };
  return { opts: { driver, readFocused }, calls, manifests, native, stopped: () => stopped };
}

test("Mac native helper failures use English by default without exposing native diagnostics", async () => {
  assert.equal(i18n.getLanguage(), "en");
  const diagnostic = "AX_PRIVATE_DIAGNOSTIC_DO_NOT_DISPLAY";
  for (const result of [{ code: 1, stdout: diagnostic, stderr: diagnostic }, { code: 0, stdout: diagnostic }]) {
    await assert.rejects(readFocused(null, false, async () => result), (error) => {
      assert.match(error.message, /could not|failed/i);
      assert.match(error.message, /window/i);
      assert.ok(!error.message.includes(diagnostic));
      return true;
    });
  }
});

test("Mac appshot uniquely matches focused metadata in a PID-only listing, then captures one window", async () => {
  const s = setup({ windows: [{ ...WINDOW, window_id: 1002, title: "Other", z_index: 99 }, WINDOW, { ...WINDOW, pid: 5555 }] });
  const shot = await readMacWindow({ ...s.opts, capture: true });
  assert.deepEqual(shot.bytes, IMAGE);
  assert.equal(shot.window.id, 1001, "focused metadata wins over stacking order");
  assert.deepEqual(s.calls, [
    { tool: "list_windows", args: { pid: 4242, on_screen_only: true } },
    { tool: "get_window_state", args: { pid: 4242, window_id: 1001, include_accessibility_tree: false, include_screenshot: true, max_image_dimension: 1920 } },
  ]);
  assert.match(s.manifests[0].text, /applications: \[4242\]/);
  assert.match(s.manifests[1].text, /windows:\n\s+- pid: 4242\n\s+window_id: 1001/);
  for (const m of s.manifests) {
    assert.match(m.text, /display: false/);
    assert.ok(!/click|type_text|clipboard|apps:|windows: all|get_desktop_state/.test(m.text));
  }
  assert.equal(s.stopped(), 1);
});

test("Mac missing, ambiguous, hidden or foreign focused-window candidates fail before capture", async () => {
  i18n.setLanguage("tr");
  for (const windows of [[], [WINDOW, { ...WINDOW, window_id: 1002 }], [{ ...WINDOW, is_on_screen: false }], [{ ...WINDOW, pid: 5555 }], [{ ...WINDOW, bounds: { ...WINDOW.bounds, x: 10 } }]]) {
    const s = setup({ windows });
    await assert.rejects(readMacWindow({ ...s.opts, capture: true }), /eşleş|bulunamadı/);
    assert.equal(s.calls.filter((c) => c.tool === "get_window_state").length, 0);
    assert.equal(s.stopped(), 1);
  }
});

test("Mac focus/identity changes before or after capture reject the entire shot", async () => {
  i18n.setLanguage("tr");
  for (const focus of [[FOCUS, { ...FOCUS, pid: 5555 }], [FOCUS, FOCUS, FOCUS, { ...FOCUS, title: "Changed" }], [FOCUS, { ...FOCUS, executable: "/Applications/Other.app/Contents/MacOS/Other" }]]) {
    const s = setup({ focus });
    await assert.rejects(readMacWindow({ ...s.opts, capture: true }), /değişti/);
    assert.equal(s.stopped(), 1);
  }
});

test("Mac own/password windows, driver refusals, stale frames and missing images fail closed", async () => {
  i18n.setLanguage("tr");
  const own = setup();
  await assert.rejects(readMacWindow({ ...own.opts, capture: true, ownPids: new Set([4242]) }), /kendi/);
  assert.equal(own.calls.length, 0);
  const vault = setup({ focus: [{ ...FOCUS, bundleId: "com.apple.Passwords" }] });
  await assert.rejects(readMacWindow({ ...vault.opts, capture: true }), /Parola/);
  assert.equal(vault.calls.length, 0);
  for (const options of [{ refuse: true }, { image: false }, { frame: { window_id: 9999 } }, { frame: { screenshot_frame_valid: false } }, { frame: { window_bounds: { ...FOCUS.bounds, width: 200 } } }]) {
    const s = setup(options);
    await assert.rejects(readMacWindow({ ...s.opts, capture: true }));
    assert.equal(s.stopped(), 1);
  }
});

test("Mac consent revalidates the pinned app/window while Deck is focused", async () => {
  const s = setup();
  const target = { ...FOCUS, id: 1001, sourceId: "window:1001:0" };
  const window = await readMacWindow({ ...s.opts, target, validateOnly: true });
  assert.equal(window.id, 1001);
  assert.ok(s.native.every((args) => args[0] === 4242 && args[1] === true));
  assert.equal(s.calls.filter((c) => c.tool === "get_window_state").length, 0);
});

test("Mac native helper uses built-in public metadata only and readWindow routes to the injected driver", async () => {
  i18n.setLanguage("tr");
  const script = fs.readFileSync(path.join(__dirname, "../main/cua/frontmost-mac.jxa"), "utf8");
  new vm.Script(script); // parse only; this test never runs ObjC/System Events
  assert.match(script, /frontmostApplication/);
  assert.match(script, /AXFocusedWindow/);
  assert.ok(!/_AXUIElementGetWindow|CGWindowList|screencapture|runningApplications/.test(script));
  let calls = 0;
  const meta = await readFocused(4242, true, async (file, args) => {
    calls++;
    assert.equal(file, "/usr/bin/osascript");
    assert.deepEqual(args.slice(-2), ["4242", "identity"]);
    return { code: 0, stdout: JSON.stringify(FOCUS) };
  });
  assert.deepEqual(meta, FOCUS);
  const s = setup();
  const result = await readWindow({ ...s.opts, platform: "darwin", capture: true });
  assert.equal(result.window.bundleId, "com.example.Editor");
  await assert.rejects(readMacWindow({ readFocused: async () => { calls++; return FOCUS; } }), /doğrulanmış/);
  assert.equal(calls, 1, "no native metadata is read without the required driver");
});

test("Mac canceled reads never return pixels and still stop their own driver", async () => {
  i18n.setLanguage("tr");
  const s = setup();
  let alive = true;
  await assert.rejects(readMacWindow({ ...s.opts, capture: true, current: () => alive, encodeImage: (bytes) => { alive = false; return bytes; } }), /durduruldu/);
  assert.equal(s.stopped(), 1);
});

test("Mac required-driver errors follow en to tr to en changes before reading metadata", async () => {
  let reads = 0;
  try {
    for (const [language, wording] of [["en", /verified.*cua-driver/i], ["tr", /doğrulanmış.*cua-driver/], ["en", /verified.*cua-driver/i]]) {
      i18n.setLanguage(language);
      await assert.rejects(readMacWindow({ readFocused: async () => { reads++; return FOCUS; } }), wording);
    }
    assert.equal(reads, 0, "missing-driver failures never read native metadata");
  } finally {
    i18n.setLanguage("tr");
  }
});

test("bot screen shortcut tooltips use native Mac state in either language", () => {
  const source = fs.readFileSync(path.join(__dirname, "../renderer/botscreen.js"), "utf8");
  const renderActions = source.slice(source.indexOf("  function renderActions()"), source.indexOf("  function selected()"));
  const renderStatus = source.slice(source.indexOf("  function renderStatus()"), source.indexOf("  function renderExplain()"));
  for (const language of ["en", "tr"]) {
    i18n.setLanguage(language);
    let buttons, chips;
    const box = {
      B: { st: { supported: true, on: true, agents: ["fixture"], driver: { status: "installed", version: "0.33.3" }, link: { status: "ready" },
        hotkey: { registered: true, label: "⌃⌥⇧S" }, frontmost: { supported: true, registered: false, hotkey: "⌃⌥P" } } },
      i18nText: i18n.t, i18nNode: i18n.node,
      h: (tag, attrs, ...kids) => ({ tag, attrs, kids }), chip: (text, tone, title) => ({ text, tone, title }),
      actionsEl: { replaceChildren: (...kids) => { buttons = kids; } }, statusEl: { replaceChildren: (...kids) => { chips = kids; } },
      leaseProfile: () => null, openSheet: () => {}, doStop: () => {},
    };
    vm.runInNewContext(`${renderActions}\n${renderStatus}\nrenderActions(); renderStatus();`, box);
    assert.equal(buttons[1].attrs.title, i18n.t("frontmost.shortcutHelp", { hotkey: "⌃⌥P" }));
    assert.equal(buttons[1].attrs.disabled, null);
    assert.ok(chips.some(item => item.text === i18n.t("frontmost.hotkeyUnavailable", { hotkey: "⌃⌥P" })));
    assert.ok(chips.some(item => item.text === i18n.t("common.stopShortcut", { hotkey: "⌃⌥⇧S" })));
    assert.ok(!buttons[1].attrs.title.includes("Ctrl+Alt+P"));
  }
  i18n.setLanguage("en");
});

test("paused Bot screen resumes locally without restoring a window grant or visiting Settings", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../renderer/botscreen.js"), "utf8");
  const actions = source.slice(source.indexOf("  function renderActions()"), source.indexOf("  function selected()"));
  const resume = source.slice(source.indexOf("  async function doResume()"), source.indexOf("  async function doLease("));
  let buttons, enabled = 0;
  const resumed = { supported: true, on: true, grant: null };
  const box = { B: { st: { supported: true, on: false, paused: { by: "button" }, agents: ["default"], driver: { status: "installed" } } },
    h: (tag, attrs, ...kids) => ({ tag, attrs, kids }), i18nText: key => key, i18nNode: key => key,
    actionsEl: { replaceChildren: (...kids) => { buttons = kids; } }, leaseProfile: () => null,
    openSheet() {}, doStop() {}, update() {}, err: e => e.message,
    deck: { device: { setHosting: async (cap, on) => { assert.equal(cap, "desktop"); assert.equal(on, true); enabled++; } } },
    api: { state: async () => resumed },
  };
  vm.runInNewContext(`${actions}\n${resume}\nrenderActions();`, box);
  assert.equal(buttons[0].kids[0], "botscreen.resume");
  await buttons[0].attrs.onclick();
  assert.equal(enabled, 1);
  assert.equal(box.B.st.grant, null);
  assert.equal(box.B.msg.ok, true);
  box.B.st = { supported: true, on: false, paused: null, hasToken: true, agents: ["default"], driver: { status: "installed" } };
  vm.runInNewContext("renderActions();", box);
  assert.equal(buttons[0].kids[0], "botscreen.resume", "a restart after Stop still offers the local resume action");
});
