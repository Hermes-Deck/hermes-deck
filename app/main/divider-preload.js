"use strict";
// The split view's divider page (renderer/divider.html): its only door to main is the drag it reports. No Node,
// no raw ipcRenderer; main (host-views.js) accepts the channel from this page's webContents alone.
const { contextBridge, ipcRenderer } = require("electron");
const themeArg = process.argv.find((a) => a.startsWith("--deck-theme="));
contextBridge.exposeInMainWorld("deckTheme", {
  initial: themeArg ? themeArg.slice("--deck-theme=".length) : "basalt",
  onChange: (cb) => { ipcRenderer.on("theme", (_e, name) => cb(String(name))); },
});
contextBridge.exposeInMainWorld("deckDivider", {
  // phase: "start" | "move" | "end"; x: the pointer's x in the window's content area (the page covers it while dragging)
  drag: (phase, x) => ipcRenderer.send("mview:drag", { phase: String(phase), x: Number(x) }),
});
