"use strict";
// The agent space viewer: cua-spacesd's own viewer page of one space (the shared desktop "host" or an agent's own
// desktop), reached via the local space proxy (space-proxy.js): through the relay (which adds the space's token), or
// straight on loopback when that agent desktop runs on this computer (the proxy adds its container token), shown in a
// WebContentsView of its own over the Bot screen tab. The view has its own in-memory partition, no preload, no permissions, and may
// not navigate anywhere but the viewer. Watch loads the viewer with view_only=1 and also drops keyboard input
// here; Together and Full load it without.
const { WebContentsView, session } = require("electron");
const { viewUrl, inputBlocked, levelOk } = require("./space-view-logic");
const { startSpaceProxy } = require("./space-proxy");

const PARTITION = "space-viewer"; // no "persist:" prefix: nothing of the viewer is kept on disk

function createSpaceView({ win, relayBase, relayToken, target, level: levelOf }) {
  const part = session.fromPartition(PARTITION);
  // nothing but full screen (the viewer's own button): no camera, microphone, clipboard, notifications …
  part.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "fullscreen"));
  part.setPermissionCheckHandler((_wc, perm) => perm === "fullscreen");
  let proxy = null; // Promise<{base, close}>
  let view = null;
  let level = "watch";
  let space = "host"; // the space shown: "host" (shared) or an agent profile
  let loaded = ""; // the URL the view shows now
  let rectNow = null; // the stage's bounds in the window (DIP)
  let full = false; // the viewer's own full-screen button: the view covers the whole window, made full screen

  const base = async () => (await (proxy ||= startSpaceProxy({ relayBase, token: relayToken, target, level: levelOf }))).base;

  function ensure() {
    if (view) return view;
    view = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    const wc = view.webContents;
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-navigate", (e, url) => {
      // only inside the shown space's viewer (its own base: /<secret>/<space>/)
      const page = loaded.split("#")[0];
      if (!loaded || !url.startsWith(page.slice(0, page.lastIndexOf("viewer/")))) e.preventDefault();
    });
    wc.on("before-input-event", (e, input) => {
      if (inputBlocked(level) && (input.type === "keyDown" || input.type === "keyUp" || input.type === "char")) e.preventDefault();
    });
    // the viewer's full-screen button asks for HTML full screen; a child view cannot take the screen by itself, so
    // the Deck window goes full screen and the view covers it until the viewer leaves (its button or Esc)
    wc.on("enter-html-full-screen", () => {
      full = true;
      win.setFullScreen(true);
      setTimeout(fit, 300); // after the window has its full-screen size
    });
    wc.on("leave-html-full-screen", () => {
      full = false;
      win.setFullScreen(false);
      setTimeout(fit, 300);
    });
    view.setBackgroundColor("#00000000");
    view.setVisible(false);
    win.contentView.addChildView(view);
    return view;
  }

  function fit() {
    if (!view) return;
    if (full) {
      const b = win.getContentBounds();
      view.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
    } else if (rectNow) view.setBounds(rectNow);
  }

  async function load() {
    const url = viewUrl(`${await base()}${space}/`, level);
    if (!view || url === loaded) return;
    // another space is another page (its path differs): a fresh load, never a same-document navigation
    const sameDoc = !!loaded && loaded.split("#")[0] === url.split("#")[0];
    loaded = url;
    // the viewer reads its options (view_only…) once, at start: a new level must be a fresh page, and a URL that
    // differs only in its #hash would be a same-document navigation, so it goes through a blank page first
    if (sameDoc) await view.webContents.loadURL("about:blank").catch(() => {});
    await view.webContents.loadURL(url).catch(() => {});
  }

  return {
    /**
     * rect: CSS pixels of the Bot screen's stage in the Deck page; s: the space to show ("host" or a profile); l: its
     * level. Space and level change together, so a switch is one fresh load of the new space, never the old one first.
     */
    async show(rect, s = "host", l = null) {
      const v = ensure();
      space = s;
      if (l !== null) level = levelOk(l) ? l : "watch";
      const z = win.webContents.getZoomFactor ? win.webContents.getZoomFactor() : 1;
      rectNow = {
        x: Math.round(rect.x * z),
        y: Math.round(rect.y * z),
        width: Math.max(1, Math.round(rect.width * z)),
        height: Math.max(1, Math.round(rect.height * z)),
      };
      fit();
      v.setVisible(true);
      await load();
    },
    /** Hidden = not watched: the page is unloaded too, so the space stops streaming (spec section 7). */
    hide() {
      if (full) return; // full screen covers the Deck page, whose own checks would otherwise hide it
      if (!view || !loaded) return;
      view.setVisible(false);
      loaded = "";
      view.webContents.loadURL("about:blank").catch(() => {});
    },
    /** What the view shows now (spaces.js: the loopback proxy's level rule and the relay's watching hint). */
    current() {
      return { space, level, visible: !!view && !!loaded };
    },
    async setLevel(l) {
      level = levelOk(l) ? l : "watch";
      if (view && view.getVisible()) await load();
    },
    /** Ends the stream (the space streams only while watched) and the local proxy. */
    destroy() {
      if (view) {
        try {
          win.contentView.removeChildView(view);
        } catch {}
        view.webContents.close();
        view = null;
        loaded = "";
      }
      if (proxy) proxy.then((p) => p.close()).catch(() => {});
      proxy = null;
    },
  };
}

module.exports = { createSpaceView, PARTITION };
