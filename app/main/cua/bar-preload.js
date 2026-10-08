"use strict";
// The bot screen bar's only door to main: its state comes in; Stop and hover go out.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("deckLanguage", process.argv.includes("--deck-language=tr") ? "tr" : "en");
// colour theme: the first paint uses the --deck-theme argument, later changes arrive as "theme" (main/theme.js)
const themeArg = process.argv.find((a) => a.startsWith("--deck-theme="));
contextBridge.exposeInMainWorld("deckTheme", {
  initial: themeArg ? themeArg.slice("--deck-theme=".length) : "basalt",
  onChange: (cb) => { ipcRenderer.on("theme", (_e, name) => cb(String(name))); },
});

contextBridge.exposeInMainWorld("botbar", {
  onLanguage: (cb) => { ipcRenderer.on("language", (_e, language) => cb(language)); },
  onState: (cb) => {
    ipcRenderer.on("botbar:state", (_e, s) => cb(s)); // returns nothing: ipcRenderer itself never reaches the page
  },
  ready: () => ipcRenderer.send("botbar:ready"),
  rendered: () => ipcRenderer.send("botbar:rendered"),
  stop: () => ipcRenderer.send("botbar:stop"),
  interactive: (on) => ipcRenderer.send("botbar:interactive", !!on),
});
