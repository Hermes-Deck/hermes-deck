"use strict";
// Colour themes (Settings > Appearance). The colours themselves are CSS tokens in renderer/styles.css; this
// module only decides which theme is on and tells every window. "system" follows the OS: basalt when it
// prefers dark, marble when light. Pages get the theme twice: once as --deck-theme=<name> in their
// additionalArguments (read by the preload, so the first paint is already right) and then as a "theme"
// message whenever it changes.
const { BrowserWindow, nativeTheme } = require("electron");

const THEMES = ["basalt", "marble", "aegean"];
const CHOICES = [...THEMES, "system"];
// window ground and Windows caption-button colours per theme (the page's --obsidian and --vein-text)
const WINDOW = {
  basalt: { bg: "#000000", symbol: "#7D7D7D" },
  marble: { bg: "#F3F0EA", symbol: "#67625A" },
  aegean: { bg: "#0A1020", symbol: "#8995B2" },
};
const TITLE_H = 44; // matches --top in styles.css

let choice = "basalt";
let applied = "basalt";
const framed = new Set(); // windows with an opaque ground and (on Windows) a caption overlay to recolour
let hooked = false;

/** The theme a choice stands for right now ("system" resolved against the OS). */
function resolve(c = choice) {
  if (c === "system") return nativeTheme.shouldUseDarkColors ? "basalt" : "marble";
  return THEMES.includes(c) ? c : "basalt";
}

const current = () => resolve();
const windowColors = (name = current()) => WINDOW[name] || WINDOW.basalt;
const arg = () => `--deck-theme=${current()}`;
/** BrowserWindow options for a framed window: ground and caption overlay in the current theme. */
function titleBarOverlay(name = current()) {
  const w = windowColors(name);
  return { color: w.bg, symbolColor: w.symbol, height: TITLE_H };
}

function paint(win, name) {
  if (!win || win.isDestroyed()) return;
  const w = windowColors(name);
  try {
    win.setBackgroundColor(w.bg);
    if (process.platform !== "darwin" && typeof win.setTitleBarOverlay === "function") win.setTitleBarOverlay(titleBarOverlay(name));
  } catch {
    // a window without an overlay (or already closing): the page colours are what matter
  }
}

function broadcast() {
  const name = current();
  applied = name;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("theme", name);
  }
  for (const win of framed) paint(win, name);
}

/** Recolours `win`'s ground and caption buttons with every theme change (main window). */
function attach(win) {
  framed.add(win);
  win.on("closed", () => framed.delete(win));
  paint(win, current());
}

/** Sets the user's choice; tells every window when the resolved theme changes. */
function setChoice(c) {
  choice = CHOICES.includes(c) ? c : "basalt";
  if (!hooked) {
    hooked = true;
    nativeTheme.on("updated", () => {
      if (choice === "system" && current() !== applied) broadcast();
    });
  }
  if (current() !== applied) broadcast();
}

module.exports = { THEMES, CHOICES, WINDOW, resolve, current, arg, setChoice, attach, titleBarOverlay, windowColors };
