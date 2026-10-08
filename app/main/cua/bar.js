"use strict";
const { t: i18nText, getLocale: i18nLocale, getLanguage: i18nLanguage } = require("../../renderer/i18n");
// Bot screen: the always-on-top bar shown for as long as an agent may act on this computer
// ("<Agent> on this computer: <App> · Stop"). Same pattern as the status pet (main/pet.js): frameless,
// transparent, never focused, click-through except its Stop button. It is kept out of screen captures
// where the OS allows it (Windows), so the agent's own screenshots never show it. Its page:
// renderer/botbar.html (+ botbar.js, botbar.css), its preload: bar-preload.js.
const { BrowserWindow, ipcMain, screen } = require("electron");
const fs = require("fs");
const path = require("path");
const theme = require("../theme");

const W = 640;
const H = 56;
const TOP = 6; // gap below the top of the work area
const PAGE = "deck://app/botbar.html";
const PRELOAD = path.join(__dirname, "bar-preload.js");

let current = null; // the bar whose window is open (one at a time)
let screenHooked = false;
const fromBar = (e) => (current && current.win && !current.win.isDestroyed() && e.sender === current.win.webContents ? current : null);
ipcMain.on("botbar:ready", (e) => {
  if (!fromBar(e)) return;
  current.win.webContents.send("language", i18nLanguage());
  current._send();
});
ipcMain.on("botbar:stop", (e) => fromBar(e) && current.onStop());
ipcMain.on("botbar:interactive", (e, on) => fromBar(e) && current._interactive(!!on));
ipcMain.on("botbar:rendered", (e) => fromBar(e) && current.onRendered && current.onRendered());

class ActivityBar {
  /** @param {{onStop?: () => void}} [o] onStop: the bar's Stop button */
  constructor({ onStop = () => {} } = {}) {
    this.onStop = onStop;
    this.win = null;
    this.info = null; // {agent, app, title, expires, hotkey}
    this.interactive = false;
    this.shot = null;
  }

  get visible() {
    return !!(this.win && !this.win.isDestroyed());
  }

  /** Shows the bar (or updates it) for one grant. */
  show(info) {
    this.info = info;
    if (this.visible) return this._send();
    this._create();
  }

  hide() {
    if (this.visible) this.win.destroy();
    this.win = null;
    if (current === this) current = null;
  }

  _send() {
    if (!this.visible || !this.info) return;
    this.win.webContents.send("botbar:state", { ...this.info, now: Date.now(), shot: !!this.shot });
  }

  _bounds() {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: Math.round(wa.x + (wa.width - W) / 2), y: Math.round(wa.y + TOP), width: W, height: H };
  }

  _create() {
    current = this;
    const shot = this.shot;
    const b = shot ? { x: 0, y: 0, width: W, height: H } : this._bounds();
    const win = new BrowserWindow({
      ...b,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false, // never takes the keyboard from what the user (or the agent) is typing in
      title: i18nText("A0054"),
      webPreferences: { preload: PRELOAD, additionalArguments: [`--deck-language=${i18nLanguage()}`, theme.arg()], contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
    });
    this.win = win;
    this.interactive = false;
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.on("closed", () => {
      if (this.win === win) this.win = null;
      if (current === this) current = null;
    });
    if (!shot) {
      win.setAlwaysOnTop(true, "screen-saver"); // above full-screen windows too
      win.setContentProtection(true); // Windows: left out of every screen capture, the agent's included
      if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setIgnoreMouseEvents(true, { forward: true }); // clicks pass through, except over Stop
      win.once("ready-to-show", () => win.showInactive());
      this._hookScreen();
    }
    win.loadURL(PAGE);
  }

  _hookScreen() {
    if (screenHooked) return;
    screenHooked = true;
    const again = () => current && current.visible && !current.shot && current.win.setBounds(current._bounds());
    for (const ev of ["display-removed", "display-added", "display-metrics-changed"]) screen.on(ev, again);
  }

  /** The pointer is over the Stop button: take the click there, pass everything else through. */
  _interactive(on) {
    if (!this.visible || this.shot || on === this.interactive) return;
    this.interactive = on;
    if (on) this.win.setIgnoreMouseEvents(false);
    else this.win.setIgnoreMouseEvents(true, { forward: true });
  }

  /**
   * Dev (--shot-botbar): render the bar for `info` in a window that is never shown, and write a PNG.
   * @param {{info: object, file: string, wait?: number, hover?: boolean}} opts
   */
  capture(opts) {
    this.shot = opts;
    this.info = opts.info;
    return new Promise((resolve, reject) => {
      this.onRendered = () => {
        this.onRendered = null;
        setTimeout(async () => {
          try {
            const img = await this.win.webContents.capturePage();
            fs.writeFileSync(opts.file, img.toPNG());
            resolve(opts.file);
          } catch (e) {
            reject(e);
          }
        }, opts.wait || 800);
      };
      this._create();
    });
  }
}

module.exports = { ActivityBar, BAR_W: W, BAR_H: H };
