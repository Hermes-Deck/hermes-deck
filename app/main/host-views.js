"use strict";
// Host pages (multi-host, split view): one renderer page per opened host, each a WebContentsView inside the one
// main window, loaded as deck://app/index.html?host=<id> with the main page's preload and web preferences. A page
// is made the first time its host is shown and kept alive, hidden, afterwards: switching back is instant with
// scroll and drafts intact. Shown pages sit side by side in split view around a thin divider view that takes the
// drag; hidden pages are throttled (background timers) but still receive their host's events.
//
// This module only places pages and routes messages. Which host goes where is decided in main.js from the pure
// rules in host-layout.js; the layout state here mirrors settings (activeHost = primary, settings.panes).
// Electron's classes come in through `deps`, so the unit tests run it without Electron.
const { EventEmitter } = require("events");
const L = require("./host-layout");
const { pageHost } = require("./ipc-guard");

const DRAG_CHANNEL = "mview:drag"; // the divider page's only channel: {phase: "start"|"move"|"end", x}

class HostViews extends EventEmitter {
  /**
   * @param {object} deps
   * @param {Function} deps.WebContentsView
   * @param {(hostId: string) => string} deps.pageUrl        deck://app/index.html?host=<id>
   * @param {() => object} deps.webPreferences                the main page's (preload, sandbox, contextIsolation, ...)
   * @param {() => object} [deps.dividerPreferences]          the divider page's (its own preload)
   * @param {string} [deps.dividerUrl]
   * @param {() => string} [deps.background]                  the window ground colour (a new page shows it until painted)
   * @param {(wc: object, hostId: string) => void} [deps.decorate]  per-page hooks (window-open handler, navigation pin, context menu)
   */
  constructor(deps) {
    super();
    this.deps = deps;
    this.win = null;
    this.pages = new Map(); // hostId -> {hostId, urlHost, view, wc, ready, readied, shown}
    this.state = { primary: "", split: false, right: "", ratio: 0.5 };
    this.divider = null; // {view, wc, dragging, rect}
  }

  /** The main window exists: pages are added to its content view and follow its size. */
  attach(win) {
    this.win = win;
    const relayout = () => this.layout();
    for (const ev of ["resize", "resized", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "enter-html-full-screen", "leave-html-full-screen"]) win.on(ev, relayout);
  }

  // --- pages ---------------------------------------------------------------------------------------
  has(hostId) { return this.pages.has(String(hostId ?? "")); }
  pageOf(hostId) { return this.pages.get(String(hostId ?? "")) || null; }
  hostIds() { return [...this.pages.keys()]; }
  primary() { return this.state.primary; }
  shownHosts() { return L.shown(this.state).filter((id) => this.pages.has(id)); }
  isShown(hostId) { return L.paneOf(this.state, hostId) !== null && this.pages.has(String(hostId ?? "")); }

  /** The page of one host; made on first show. */
  _ensure(hostId) {
    const id = String(hostId ?? "");
    const got = this.pages.get(id);
    if (got) return got;
    if (!this.win) return null;
    const view = new this.deps.WebContentsView({ webPreferences: this.deps.webPreferences() });
    const wc = view.webContents;
    const page = { hostId: id, urlHost: id, view, wc, shown: false, readied: false };
    page.ready = new Promise((resolve) => { page._readyResolve = resolve; });
    if (this.deps.background) view.setBackgroundColor(this.deps.background());
    view.setVisible(false);
    if (this.deps.decorate) this.deps.decorate(wc, id);
    wc.on("destroyed", () => {
      if (this.pages.get(id) === page) this.pages.delete(id);
      page._readyResolve(false);
      this.emit("page-gone", id);
    });
    wc.on("will-prevent-unload", () => { /* the page holds its unload (untouched new sessions, drafts): it finishes it with bridge:unload-done */ });
    this.pages.set(id, page);
    // under the divider (added last, stays on top): index 0 keeps every later page below it too
    this.win.contentView.addChildView(view, 0);
    wc.loadURL(this.deps.pageUrl(id)).catch(() => {});
    this.emit("page-made", id);
    return page;
  }

  /** The page called `ready`: its listeners are in place (source-open and layout events may go to it now). */
  markReady(hostId) {
    const page = this.pages.get(String(hostId ?? ""));
    if (!page || page.readied) return;
    page.readied = true;
    page._readyResolve(true);
  }

  /**
   * The page made before any host was saved (loaded as ?host=) becomes the first saved host's page, as the old
   * single page did: the first-run flow that is adding the host keeps its page; the next start loads ?host=<id>.
   */
  adopt(fromId, toId) {
    const from = String(fromId ?? ""), to = String(toId ?? "");
    const page = this.pages.get(from);
    if (!page || from === to || this.pages.has(to)) return false;
    this.pages.delete(from);
    page.hostId = to;
    this.pages.set(to, page);
    return true;
  }

  /** A removed host's page is destroyed (its runtime is gone too). */
  drop(hostId) {
    const id = String(hostId ?? "");
    const page = this.pages.get(id);
    if (!page) return false;
    this.pages.delete(id);
    try { this.win.contentView.removeChildView(page.view); } catch {}
    if (!page.wc.isDestroyed()) page.wc.close();
    page._readyResolve(false);
    return true;
  }

  /**
   * Keep warm pages for the saved hosts only: a page whose host is no longer saved goes (the cap on kept pages is
   * the number of saved hosts; a hidden page of a saved host stays).
   */
  prune(hostIds) {
    const keep = new Set((Array.isArray(hostIds) ? hostIds : []).map(String));
    for (const id of [...this.pages.keys()]) if (!keep.has(id)) this.drop(id);
  }

  // --- layout --------------------------------------------------------------------------------------
  /** Applies a layout state (host-layout.js shape): makes the shown pages, places them, hides the rest. */
  apply(state) {
    const next = L.normalize(state);
    const before = this.state;
    this.state = next;
    for (const id of L.shown(next)) if (id !== "" || next.primary === "") this._ensure(id);
    this.layout();
    this._throttle();
    this._focusAfter(before, next);
    this.broadcastLayout();
    this.emit("layout", next);
    return next;
  }

  /** Places the shown pages and the divider for the window's current content size. */
  layout() {
    if (!this.win || this.win.isDestroyed()) return;
    const cb = this.win.getContentBounds();
    const size = { width: Number(cb && cb.width) || 0, height: Number(cb && cb.height) || 0 };
    const b = L.paneBounds(size, this.state);
    const shown = new Set();
    const place = (id, rect) => {
      const page = this.pages.get(id);
      if (!page || !rect) return;
      page.view.setBounds(rect);
      page.view.setVisible(true);
      page.shown = true;
      shown.add(id);
    };
    if (b.full) place(this.state.primary, b.full);
    else { place(this.state.primary, b.left); place(this.state.right, b.right); }
    for (const [id, page] of this.pages) if (!shown.has(id) && page.shown) { page.view.setVisible(false); page.shown = false; }
    this._placeDivider(b.divider || null);
  }

  _throttle() {
    for (const page of this.pages.values()) {
      if (page.wc.isDestroyed() || typeof page.wc.setBackgroundThrottling !== "function") continue;
      page.wc.setBackgroundThrottling(!page.shown); // a hidden page must not keep animating; a shown one paints freely
    }
  }

  _focusAfter(before, next) {
    // the host that just came on screen in the pane the user acted in gets the keyboard
    const changed = L.shown(next).filter((id, i) => L.shown(before)[i] !== id);
    if (changed.length) this.focus(changed[0]);
  }

  /** The pane showing this host takes keyboard input. */
  focus(hostId) {
    const page = this.pages.get(String(hostId ?? ""));
    if (!page || !page.shown || page.wc.isDestroyed()) return false;
    try { page.wc.focus(); } catch {}
    return true;
  }

  /** CONTRACT `deck.hosts.layout()`: the calling page's own placement (its hostId is always its own host). */
  layoutFor(hostId) {
    return L.placement(this.state, hostId);
  }

  /** `deck.hosts.onLayout`: every page, hidden ones too, hears its own placement whenever anything changes. */
  broadcastLayout() {
    for (const [id, page] of this.pages) if (!page.wc.isDestroyed()) page.wc.send("hosts", { t: "layout", ...this.layoutFor(id) });
  }

  // --- messages ------------------------------------------------------------------------------------
  /** To the page of one host (nothing when it has none). */
  send(hostId, ch, msg) {
    const page = this.pages.get(String(hostId ?? ""));
    if (!page || page.wc.isDestroyed()) return false;
    page.wc.send(ch, msg);
    return true;
  }

  /** To every page; `msg` may be a function of the host id (per-page payloads such as the settings view). */
  sendAll(ch, msg) {
    for (const [id, page] of this.pages) if (!page.wc.isDestroyed()) page.wc.send(ch, typeof msg === "function" ? msg(id) : msg);
  }

  /** To the primary (left / full) pane's page: device-level answers to a click that may come from any pane. */
  sendPrimary(ch, msg) {
    return this.send(this.state.primary, ch, msg);
  }

  // --- the sender ----------------------------------------------------------------------------------
  /**
   * The host of the page an IPC event came from: its sender must be one of our pages and its URL's ?host= must be
   * that page's host. null for anything else (the gate in main.js refuses it).
   */
  hostOf(e) {
    const p = pageHost(e);
    if (p === null) return null;
    const sender = e && e.sender;
    for (const page of this.pages.values()) if (page.wc === sender) return page.urlHost === p ? page.hostId : null;
    return null;
  }

  owns(e) { return this.hostOf(e) !== null; }

  /** True when the sender is the primary pane's page (device hosting is granted from there only). */
  isPrimary(e) {
    const h = this.hostOf(e);
    return h !== null && h === this.state.primary;
  }

  /**
   * A notification's click: the host is shown in a pane (focused when already on screen, else in the primary pane)
   * and the promise resolves once its page is ready for the event (`ready` called).
   */
  async reveal(hostId, show) {
    const id = String(hostId ?? "");
    if (!this.isShown(id)) show(id); // main.js: the primary pane takes it (settings + device hosting follow)
    const page = this.pages.get(id);
    if (!page) return false;
    this.focus(id);
    return page.ready;
  }

  // --- the divider -------------------------------------------------------------------------------------
  /** The thin drag handle between the panes: a transparent view of its own that widens to the window while dragging. */
  _placeDivider(rect) {
    if (!rect) {
      if (this.divider) { this.divider.view.setVisible(false); this.divider.rect = null; }
      return;
    }
    if (!this.divider) {
      if (!this.deps.dividerUrl || !this.deps.dividerPreferences) return;
      const view = new this.deps.WebContentsView({ webPreferences: this.deps.dividerPreferences() });
      view.setBackgroundColor("#00000000");
      const wc = view.webContents;
      wc.setWindowOpenHandler(() => ({ action: "deny" }));
      wc.on("will-navigate", (ev) => ev.preventDefault());
      this.divider = { view, wc, dragging: false, rect: null };
      this.win.contentView.addChildView(view); // on top of every page
      wc.loadURL(this.deps.dividerUrl).catch(() => {});
    }
    this.divider.rect = rect;
    if (!this.divider.dragging) this.divider.view.setBounds(rect);
    this.divider.view.setVisible(true);
  }

  /** Registers the divider page's channel; `onRatio(ratio, final)` persists the final position. */
  registerDivider(ipcMain, onRatio) {
    ipcMain.on(DRAG_CHANNEL, (e, m) => {
      const d = this.divider;
      if (!d || !e || e.sender !== d.wc || !m || typeof m !== "object") return;
      const cb = this.win && !this.win.isDestroyed() ? this.win.getContentBounds() : null;
      const width = Number(cb && cb.width) || 0;
      if (m.phase === "start") {
        d.dragging = true;
        d.view.setBounds({ x: 0, y: 0, width, height: Number(cb && cb.height) || 0 }); // every pointer move lands here now
        return;
      }
      if (!d.dragging) return;
      const x = Number(m.x);
      if (Number.isFinite(x)) this.state = { ...this.state, ratio: L.ratioAt(x, width) };
      if (m.phase === "end") {
        d.dragging = false;
        this.layout();
        if (onRatio) onRatio(this.state.ratio, true);
      } else {
        // live: the panes follow the pointer; the divider view stays widened until the drag ends
        const b = L.paneBounds({ width, height: Number(cb && cb.height) || 0 }, this.state);
        const left = this.pages.get(this.state.primary), right = this.pages.get(this.state.right);
        if (left && b.left) left.view.setBounds(b.left);
        if (right && b.right) right.view.setBounds(b.right);
        if (d.rect && b.divider) d.rect = b.divider;
      }
    });
  }

  // --- closing ---------------------------------------------------------------------------------------
  /**
   * The window is closing for real: every page gets its unload (drafts flush, untouched sessions are discarded; a
   * page that holds finishes with bridge:unload-done). Resolves once every page is gone.
   */
  closeAll() {
    const waits = [];
    for (const page of this.pages.values()) {
      if (page.wc.isDestroyed()) continue;
      waits.push(new Promise((resolve) => page.wc.once("destroyed", resolve)));
      try { page.wc.close({ waitForBeforeUnload: true }); } catch { try { page.wc.close(); } catch {} }
    }
    if (this.divider && !this.divider.wc.isDestroyed()) { try { this.divider.wc.close(); } catch {} }
    return Promise.all(waits).then(() => true);
  }

  /** A page finished the unload it held (bridge:unload-done while the window closes): it goes now. */
  finishClose(hostId) {
    const page = this.pages.get(String(hostId ?? ""));
    if (!page || page.wc.isDestroyed()) return false;
    try { page.wc.close(); } catch {}
    return true;
  }

  /** Screenshot runs: the primary pane's page is the one captured. */
  primaryContents() {
    const page = this.pages.get(this.state.primary);
    return page && !page.wc.isDestroyed() ? page.wc : null;
  }
}

module.exports = { HostViews, DRAG_CHANNEL };
