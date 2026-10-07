"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
// Sender checks for the main window's IPC channels (security audit L4). Only the Deck's own page,
// deck://app/index.html in a top-level frame, may call them: never the pet (deck://app/pet.html) or the bot
// screen bar (deck://app/botbar.html), which have their own preloads and channels (pet.js, cua/bar.js), and
// never a frame from anywhere else. Today nothing else can reach these channels (contextIsolation, sandbox,
// will-navigate pinned to deck://, a CSP without frames); this keeps it so if any of that changes.
// Pure Node (ipcMain is passed in), so tests load it without Electron.

const APP_PAGE = "deck://app/index.html";
const REFUSED = () => i18nText("U0258");

/** True when the IPC event comes from the Deck's own main page. */
function isApp(e) {
  const f = e && e.senderFrame;
  if (!f) return false; // the frame is gone (navigated or destroyed) by the time the message arrives
  if (f.parent) return false; // a sub-frame, whatever its address
  const url = String(f.url || "");
  return url === APP_PAGE || url.startsWith(`${APP_PAGE}#`) || url.startsWith(`${APP_PAGE}?`);
}

function fromApp(e) {
  if (!isApp(e)) throw new Error(REFUSED());
}

/**
 * ipcMain for main-window channels: `handle` rejects a foreign sender before the handler runs; `on`
 * (fire-and-forget, nobody to reject to) ignores it.
 */
function appIpc(ipcMain) {
  const mark = (wrapper) => Object.defineProperty(wrapper, GUARDED, { value: true }); // tests check every channel
  return {
    handle(channel, fn) {
      ipcMain.handle(
        channel,
        mark((e, ...args) => {
          fromApp(e);
          return fn(e, ...args);
        })
      );
    },
    on(channel, fn) {
      ipcMain.on(
        channel,
        mark((e, ...args) => {
          if (isApp(e)) fn(e, ...args);
        })
      );
    },
  };
}
const GUARDED = Symbol.for("hermes-deck.ipc-guarded");

module.exports = { isApp, fromApp, appIpc, APP_PAGE, get REFUSED() { return REFUSED(); }, GUARDED };
