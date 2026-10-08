"use strict";
const { t: i18nText, getLocale: i18nLocale, getLanguage: i18nLanguage } = require("../renderer/i18n");
// A10: the status pet. A small frameless, transparent, always-on-top window with an animated pet in one of
// three skins (Character, Orb, Agent). Its state is the summary the deck renderer sends (desktop.js forwards
// it here); events (a reply, a question, a finished run) make it hop and show a speech bubble.
// The window is click-through except over the pet, its bar and its bubble, can be dragged anywhere, remembers
// where it was left and snaps back into the visible work area. Its page: renderer/pet.html (+ pet.js,
// pet.css, pets/). Geometry and event routing are in pet-model.js (pure, unit-tested).
const { BrowserWindow, ipcMain, nativeImage, screen, app } = require("electron");
const fs = require("fs");
const path = require("path");
const M = require("./pet-model");
const theme = require("./theme");

const CLICK_PX = 4; // a press that moved less than this is a click
const URL = "deck://app/pet.html";
const PRELOAD = path.join(__dirname, "pet-preload.js");
const SKINS = require("../renderer/pets/catalog").IDS;
const KEY_RE = /^(?:(u|t)\d+|hs:[\w.:-]{1,200})$/; // the chat a bubble opens (same as desktop.js)

/** The fleet summary in words, as tagged parts: the pet's bar colours them, the tray tooltip joins them. */
function statusParts(s) {
  const parts = [];
  if (s.pending) parts.push({ text: i18nText("U0277", { pending: s.pending }), tone: "gilt" });
  if (s.offline) parts.push({ text: i18nText("U0278"), tone: "dim" });
  else if (s.running) {
    parts.push({ text: i18nText("U0279", { running: s.running }), tone: "patina" });
    if (s.subs) parts.push({ text: i18nText("common.subagentCount", { subs: s.subs }), tone: "patina" });
  } else if (s.subs) parts.push({ text: i18nText("U0280", { subs: s.subs }), tone: "patina" });
  else parts.push({ text: i18nText("U0281"), tone: "dim" });
  if (s.unread) parts.push({ text: i18nText("U0282", { unread: s.unread }), tone: "amphora" });
  return parts;
}

let current = null; // the Pet whose window is open (one at a time)
let screenHooked = false;
const fromPet = (e) => (current && current.win && !current.win.isDestroyed() && e.sender === current.win.webContents ? current : null);
ipcMain.on("pet:ready", (e) => {
  if (!fromPet(e)) return;
  current.win.webContents.send("language", i18nLanguage());
  current._send();
});
// no key: the pet itself was clicked; a key: a speech bubble about that chat
ipcMain.on("pet:open", (e, key) => fromPet(e) && current.onOpen(typeof key === "string" && KEY_RE.test(key) ? key : null));
ipcMain.on("pet:hide", (e) => fromPet(e) && current.onHide());
ipcMain.on("pet:drag", (e, phase) => fromPet(e) && (phase === "start" || phase === "end") && current._drag(phase));
ipcMain.on("pet:interactive", (e, on) => fromPet(e) && current._interactive(!!on));
ipcMain.on("pet:rendered", (e) => fromPet(e) && current.onRendered && current.onRendered());

class Pet {
  /**
   * @param {object} o
   * @param {() => ({x: number, y: number}|null)} o.loadPos  the pet box's saved screen position (DIP)
   * @param {(pos: {x: number, y: number}) => void} o.savePos
   * @param {(key: string|null) => void} o.onOpen  click on the pet or "Open Deck" (null), or on a bubble (its chat)
   * @param {() => void} o.onHide  "Hide"
   * @param {() => ({skin?: string, motion?: boolean, bubbles?: boolean})} o.options  Settings → Desktop
   */
  constructor({ loadPos = () => null, savePos = () => {}, onOpen = () => {}, onHide = () => {}, options = () => ({}) } = {}) {
    Object.assign(this, { loadPos, savePos, onOpen, onHide, options });
    this.win = null;
    this.state = { running: 0, subs: 0, unread: 0, pending: 0, offline: true };
    this.agent = null; // {name, avatar?}: the agent the Agent skin shows
    this.box = null; // the pet box's top-left on screen
    this.side = "right"; // where the box sits in the window; the bar opens toward the screen's middle
    this.drag = null;
    this.interactive = false;
    this.shot = null; // dev capture options
    this.k = 1; // the size the window is laid out at (Settings > Desktop > Pet size)
  }

  get visible() {
    return !!(this.win && !this.win.isDestroyed());
  }

  show() {
    if (!this.visible) this._create();
  }

  /** Off: the window is closed, not just hidden (nothing left running for a feature that is off). */
  hide() {
    this._stopDrag();
    if (this.visible) this.win.destroy();
    this.win = null;
    if (current === this) current = null;
  }

  setState(s) {
    this.state = s;
    this._send();
  }

  /** The agent shown by the Agent skin: {name, avatar?: data URL}. */
  setAgent(a) {
    const next = a && typeof a.name === "string" && a.name ? { name: M.clip(a.name, 40), avatar: M.avatarUrl(a.avatar) } : null;
    if (JSON.stringify(next) === JSON.stringify(this.agent)) return;
    this.agent = next;
    this._send();
  }

  /** Skin, motion, bubbles or size changed in Settings: the page follows; a new size re-anchors the window. */
  refresh() {
    const k = this._options().size;
    if (k !== this.k && this.visible && !this.shot && this.box) {
      const box = M.resize(this.box, this.side, this.k, k);
      this.k = k;
      this._place(box); // grows in place, pulled back inside the work area; sends the state
      this.savePos(M.savedPos(this.box));
      return;
    }
    this.k = k;
    this._send();
  }

  /** A pet event from PetFeed: {kind: "reply"|"ask"|"done", agent, snippet, key, avatar?, quiet?}. */
  event(ev) {
    if (!this.visible || !ev || typeof ev !== "object") return;
    this.win.webContents.send("pet:event", {
      kind: String(ev.kind),
      agent: M.clip(ev.agent, 40),
      snippet: M.clip(ev.snippet, 80),
      key: typeof ev.key === "string" && KEY_RE.test(ev.key) ? ev.key : null,
      avatar: M.avatarUrl(ev.avatar),
      quiet: !!ev.quiet,
    });
  }

  _options() {
    const o = (this.shot ? this.shot.options : this.options()) || {};
    return { skin: SKINS.includes(o.skin) ? o.skin : "character", motion: o.motion !== false, bubbles: o.bubbles !== false, size: M.SIZES.includes(o.size) ? o.size : 1 };
  }

  _send() {
    if (!this.visible) return;
    const shot = this.shot;
    this.win.webContents.send("pet:state", {
      ...this.state,
      parts: statusParts(this.state),
      side: this.side,
      agent: this.agent,
      ...this._options(),
      size: this.k, // the page zooms by it; the window is already this size
      // dev captures: "still" freezes every animation on its first frame; "live" lets them run
      shot: shot ? (shot.live ? "live" : "still") : null,
      open: !!(shot && shot.open),
      bg: shot && shot.bg ? shot.bg : null,
    });
  }

  _create() {
    current = this;
    const shot = this.shot;
    this.k = this._options().size;
    const d = M.dims(this.k);
    if (shot) this.side = shot.side;
    else {
      const saved = this.loadPos();
      this._place(saved || this._corner(), false, !!saved);
    }
    const b = shot ? { x: 0, y: 0, width: d.w, height: d.h } : M.windowAt(this.box, this.side, this.k);
    const win = new BrowserWindow({
      ...b,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false, // never takes focus from what the user is typing in
      title: i18nText("A0158"),
      // backgroundThrottling stays on for the real pet: covered, hidden or on a locked screen, its page counts
      // as hidden and Chromium stops drawing (the page also pauses its CSS animations). Live captures run in
      // a window that is never shown, so they switch it off to keep the animations running.
      webPreferences: { preload: PRELOAD, additionalArguments: [`--deck-language=${i18nLanguage()}`, theme.arg()], contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: !(shot && shot.live) },
    });
    this.win = win;
    this.interactive = false;
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.on("closed", () => {
      this._stopDrag();
      if (this.win === win) this.win = null;
      if (current === this) current = null;
    });
    // the page pauses its animations while the window is not on screen (also told by visibilitychange)
    const seen = (on) => () => !win.isDestroyed() && win.webContents.send("pet:visible", on);
    for (const ev of ["hide", "minimize"]) win.on(ev, seen(false));
    for (const ev of ["show", "restore"]) win.on(ev, seen(true));
    if (!shot) {
      win.setAlwaysOnTop(true, "screen-saver");
      if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setIgnoreMouseEvents(true, { forward: true }); // transparent parts pass clicks through
      win.once("ready-to-show", () => win.showInactive());
      this._hookScreen();
    }
    win.loadURL(URL);
  }

  /** Default spot: the bottom-right corner of the primary display's work area. */
  _corner() {
    return M.corner(screen.getPrimaryDisplay().workArea, this.k);
  }

  /**
   * Puts the pet box at `pos`, pulled back inside the work area of the display nearest to it, and picks the
   * side its bar opens to (toward the middle of that display). `saved`: `pos` came from loadPos (a v1 one is
   * migrated, see M.place).
   */
  _place(pos, move = true, saved = false) {
    const d = M.dims(this.k);
    const wa = screen.getDisplayNearestPoint({ x: Math.round(pos.x + d.sw / 2), y: Math.round(pos.y + d.sh / 2) }).workArea;
    const p = M.place(pos, wa, saved, this.k);
    this.box = p.box;
    this.side = p.side;
    if (move && this.visible) {
      this.win.setBounds(M.windowAt(this.box, this.side, this.k));
      this._send();
    }
  }

  _hookScreen() {
    if (screenHooked) return;
    screenHooked = true;
    // a monitor unplugged or rescaled: bring the pet back on screen
    const again = () => current && current.visible && !current.drag && current.box && current._place(current.box);
    for (const ev of ["display-removed", "display-added", "display-metrics-changed"]) screen.on(ev, again);
  }

  /**
   * Dragging: the page reports press and release; main follows the cursor in between (screen DIP, so mixed
   * display scales work) and decides whether it was a click or a move.
   */
  _drag(phase) {
    if (!this.visible || this.shot) return;
    if (phase === "start") {
      this._stopDrag();
      this.drag = { from: screen.getCursorScreenPoint(), box: { ...this.box }, side: this.side, moved: false };
      this.dragTimer = setInterval(() => this._dragTick(), 16);
      this.dragGuard = setTimeout(() => this._drag("end"), 60000); // a lost release never leaves it glued to the cursor
      return;
    }
    const d = this.drag;
    if (!d) return;
    this._dragTick();
    this._stopDrag();
    if (!d.moved) return this.onOpen(null);
    this._place(this.box);
    this.savePos(M.savedPos(this.box));
  }

  _dragTick() {
    const d = this.drag;
    if (!d || !this.visible) return;
    const p = screen.getCursorScreenPoint();
    const dx = p.x - d.from.x;
    const dy = p.y - d.from.y;
    if (!d.moved && Math.hypot(dx, dy) < CLICK_PX) return;
    d.moved = true;
    this.box = { x: d.box.x + dx, y: d.box.y + dy };
    // the side only flips on release, so the bar does not jump around mid-drag; setBounds (not setPosition)
    // keeps the size fixed when the window crosses displays with different scales
    this.win.setBounds(M.windowAt(this.box, d.side, this.k));
  }

  _stopDrag() {
    clearInterval(this.dragTimer);
    clearTimeout(this.dragGuard);
    this.dragTimer = null;
    this.dragGuard = null;
    this.drag = null;
  }

  /** The pointer is over the pet, the open bar or a bubble: take mouse input there, pass it through elsewhere. */
  _interactive(on) {
    if (!this.visible || this.shot) return;
    const want = on || !!this.drag;
    if (want === this.interactive) return;
    this.interactive = want;
    if (want) this.win.setIgnoreMouseEvents(false);
    else this.win.setIgnoreMouseEvents(true, { forward: true });
  }

  // ---------------------------------------------------------------- dev captures (--shot-pet)
  /**
   * Renders the pet in a window that is never shown and writes a PNG.
   * opts: {state, from?, event?, agent?, options: {skin, motion, bubbles}, side, open, hover, bg?, file, wait,
   *        frames, interval}
   *   state      the summary to show (with `from`: the summary it changes to)
   *   from       start in this summary, then change to `state`: the transition is recorded
   *   event      a pet event played after the first render
   *   frames > 1 a strip over time: `frames` captures `interval` ms apart, laid out left to right in rows
   *              of 8 (the pet's corner of the window only); otherwise one capture of the whole window after
   *              `wait` ms
   */
  capture(opts) {
    const live = opts.frames > 1;
    this.shot = { ...opts, live };
    this.state = opts.from || opts.state;
    this.agent = opts.agent || null;
    return new Promise((resolve, reject) => {
      this.onRendered = () => {
        this.onRendered = null;
        if (opts.hover) {
          const d = M.dims(this.k);
          const cx = opts.side === "right" ? d.w - d.sw / 2 : d.sw / 2;
          this.win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(cx), y: Math.round(d.h - d.sh / 3) });
        }
        const change = !!(opts.from || opts.event);
        setTimeout(() => {
          if (opts.from) this.setState(opts.state);
          if (opts.event) this.event(opts.event);
          const shoot = live ? this._strip(opts) : this._delay(opts.wait).then(() => this._one(opts.file));
          shoot.then(resolve, reject);
        }, change ? 600 : 0); // the starting state settles before the change under test
      };
      this._create();
    });
  }

  _delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async _one(file) {
    const img = await this.win.webContents.capturePage();
    fs.writeFileSync(file, img.toPNG());
    return file;
  }

  /** `frames` captures of the pet's corner, laid out in rows of 8 (raw bitmaps copied into one image). */
  async _strip({ frames, interval, file, side }) {
    const d = M.dims(this.k);
    const cw = Math.round(300 * this.k); // the pet box plus a full-width bubble
    const rect = { x: side === "right" ? d.w - cw : 0, y: 0, width: cw, height: d.h };
    const t0 = Date.now();
    const shots = [];
    for (let i = 0; i < frames; i++) {
      const due = t0 + i * interval;
      if (Date.now() < due) await this._delay(due - Date.now());
      const img = await this.win.webContents.capturePage(rect);
      shots.push({ at: Date.now() - t0, img });
    }
    const { width: fw, height: fh } = shots[0].img.getSize();
    const cols = Math.min(8, frames);
    const rows = Math.ceil(frames / cols);
    const out = Buffer.alloc(fw * cols * fh * rows * 4); // transparent
    shots.forEach(({ img }, i) => {
      const s = img.getSize();
      const src = img.toBitmap();
      const ox = (i % cols) * fw;
      const oy = Math.floor(i / cols) * fh;
      const w = Math.min(fw, s.width);
      for (let y = 0; y < Math.min(fh, s.height); y++) src.copy(out, ((oy + y) * fw * cols + ox) * 4, y * s.width * 4, (y * s.width + w) * 4);
    });
    const sheet = nativeImage.createFromBitmap(out, { width: fw * cols, height: fh * rows });
    fs.writeFileSync(file, sheet.toPNG());
    console.log(`pet strip: ${frames} frames, ms ${shots.map((s) => s.at).join(" ")}`);
    return file;
  }

  /**
   * Dev (--pet-cpu): CPU of every app process over `seconds`, the pet's window never shown. Default: the pet
   * as it is while hidden (background throttling on, the page told the window hid, so its animations are
   * paused). With `live` the page keeps animating (throttling off): the page's and the GPU process's share of
   * a visible pet. Not included: the OS compositor presenting a shown transparent always-on-top window.
   * Resolves with {visibility, live, seconds, cpu: {process type: % of one core}, total}.
   */
  measure({ seconds, state, options, live, pause = !live }) {
    this.shot = { options, live: !!live, side: "right" };
    this.state = state;
    return new Promise((resolve, reject) => {
      this.onRendered = async () => {
        this.onRendered = null;
        try {
          await this._delay(3000); // first paint and image decoding out of the way
          // hidden: what main tells the page when the window hides (it pauses every animation)
          if (pause) this.win.webContents.send("pet:visible", false);
          await this._delay(500);
          const visibility = await this.win.webContents.executeJavaScript("document.visibilityState + (document.body.classList.contains('paused') ? ' (paused)' : '')");
          const before = cpuTimes();
          await this._delay(seconds * 1000);
          const after = cpuTimes();
          const cpu = {};
          for (const [pid, a] of after) {
            const b = before.get(pid);
            if (!b) continue;
            const pct = ((a.t - b.t) / seconds) * 100;
            cpu[a.type] = Math.round(((cpu[a.type] || 0) + pct) * 100) / 100;
          }
          const total = Math.round(Object.values(cpu).reduce((n, v) => n + v, 0) * 100) / 100;
          resolve({ visibility, live: !!live, seconds, cpu, total });
        } catch (e) {
          reject(e);
        }
      };
      this._create();
    });
  }
}

/** Seconds of CPU each app process has used so far: pid -> {type, t}. */
function cpuTimes() {
  const m = new Map();
  for (const p of app.getAppMetrics()) m.set(p.pid, { type: p.type, t: p.cpu && typeof p.cpu.cumulativeCPUUsage === "number" ? p.cpu.cumulativeCPUUsage : 0 });
  return m;
}

module.exports = { Pet, statusParts, SKINS };
