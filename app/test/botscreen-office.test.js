"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const i18n = require("../renderer/i18n");
const source = fs.readFileSync(require.resolve("../renderer/botscreen"), "utf8");
const render = source.slice(source.indexOf("  function renderSheet()"), source.indexOf("  // ---------------------------------------------------------------- Settings"));

test("Office confirmation shows a localized note without enabling foreground control", () => {
  for (const language of ["en", "tr"]) {
    i18n.setLanguage(language);
    for (const [executable, expected] of [["EXCEL.EXE", true], ["C:\\Office\\WINWORD.EXE", true], ["/Office/powerpnt.exe", true], ["outlook.exe", true], ["notepad.exe", false], ["myexcel.exe", false], ["", false]]) {
      let tree;
      const w = { executable, app: "Example", title: "Window" };
      const context = { B: { sheet: { step: "confirm", profile: "scout", foreground: false }, st: { agents: ["scout"], hotkey: { label: "Stop" } } },
        pickedWindow: () => w, nameOf: p => p, dative: p => p, closeSheet() {}, confirm() {},
        i18nText: i18n.t, i18nNode: key => key,
        h: (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat().filter(Boolean) }),
        sheetBack: { replaceChildren(t) { tree = t; } } };
      vm.runInNewContext(render + "\nrenderSheet();", context);
      const nodes = [];
      const walk = n => { if (n && typeof n === "object") { nodes.push(n); n.children.forEach(walk); } };
      walk(tree);
      const note = nodes.find(n => n.children.includes("botscreen.officeForegroundNote"));
      assert.equal(!!note, expected, executable);
      assert.equal(nodes.find(n => n.attrs.type === "checkbox").attrs.checked, null);
      if (note) assert.notEqual(i18n.t("botscreen.officeForegroundNote"), "botscreen.officeForegroundNote");
    }
  }
});

test("window picker supplies executable basenames without exposing local paths", async () => {
  const main = fs.readFileSync(require.resolve("../main/cua/index"), "utf8");
  const fn = main.slice(main.indexOf("async function listWindows()"), main.indexOf("async function previewWindow("));
  const calls = [];
  const context = {
    S: { fixture: false }, IS_WIN: true, IS_MAC: false, enabled: () => true, installed: () => true,
    desktopCapturer: { getSources: async () => [] }, startPicker: async () => ({ call: async () => "" }),
    BrowserWindow: { getAllWindows: () => [] }, app: { getAppMetrics: () => [] }, process: { pid: 999 },
    W: { parseListWindows: () => [], mergeWindows: () => [{ pid: 42 }, { pid: 42 }, { pid: 43 }] },
    path: require("node:path"), executablePath: async pid => { calls.push(pid); if (pid === 43) throw Error("gone"); return "C:\\Private\\Office\\EXCEL.EXE"; },
  };
  const result = await vm.runInNewContext(fn + "\nlistWindows()", context);
  assert.deepEqual(calls, [42, 43]);
  assert.equal(result.windows[0].executable, "EXCEL.EXE");
  assert.equal(result.windows[2].executable, "");
  assert.equal(JSON.stringify(result).includes("Private"), false);
  const frontmost = vm.runInNewContext('publicWindow({ executable: "C:/Private/Office/WINWORD.EXE" })', context);
  assert.equal(frontmost.executable, "WINWORD.EXE");
});
