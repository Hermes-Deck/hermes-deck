"use strict";
// The status pet's only door to main: its state and events come in; hover, drag and button signals go out.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("deckLanguage", process.argv.includes("--deck-language=tr") ? "tr" : "en");
// colour theme: the first paint uses the --deck-theme argument, later changes arrive as "theme" (main/theme.js)
const themeArg = process.argv.find((a) => a.startsWith("--deck-theme="));
contextBridge.exposeInMainWorld("deckTheme", {
  initial: themeArg ? themeArg.slice("--deck-theme=".length) : "basalt",
  onChange: (cb) => { ipcRenderer.on("theme", (_e, name) => cb(String(name))); },
});

const on = (ch) => (cb) => {
  ipcRenderer.on(ch, (_e, v) => cb(v)); // returns nothing: ipcRenderer itself never reaches the page
};

contextBridge.exposeInMainWorld("pet", {
  onLanguage: on("language"),
  onState: on("pet:state"),
  onEvent: on("pet:event"), // {kind: "reply"|"ask"|"done", agent, snippet, key, avatar?, quiet}
  onVisible: on("pet:visible"), // false while the window is hidden or minimized
  ready: () => ipcRenderer.send("pet:ready"),
  rendered: () => ipcRenderer.send("pet:rendered"),
  open: (key) => ipcRenderer.send("pet:open", typeof key === "string" ? key : null), // a bubble passes its chat
  hide: () => ipcRenderer.send("pet:hide"),
  drag: (phase) => ipcRenderer.send("pet:drag", phase), // "start" | "end"; main follows the cursor between
  interactive: (on) => ipcRenderer.send("pet:interactive", !!on),
});
