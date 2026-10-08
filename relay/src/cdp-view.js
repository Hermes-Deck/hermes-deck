"use strict";
// Watching an agent's browser for the Workspace tab, shared by both ends:
//   app/main/cdp-view.js    agent browsers on a Hermes Deck (agent-browser.js, cdp-tunnel.js)
//   relay/src/cdp-view.js   the agent host's own browser (browser.js, workspace.js)
// The two packages are deployed separately and cannot load each other, so this file exists twice and the
// copies must stay byte-identical (relay/test/cdp.test.js checks). Pure Node: events + ws.
//   CdpClient     a minimal CDP client
//   AgentTracker  reads one agent socket: which page each command acts on, and whether it is real use or
//                 connection bookkeeping (Hermes's CDP supervisor attaching to about:blank is not use)
//   LiveView      screencast + tabs of one agent browser; follows the page the agent works on, keeps the
//                 last frame ("Last seen") when the agent closes it, and never hides the agent's tab
//   Trail         where the agent went, recorded while nobody watches
//   wallOf        "this page is a robot check": the user is told and solves it; nothing here solves or hides it
const { EventEmitter } = require("events");
const WebSocket = require("ws");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const blank = (u) => !u || u === "about:blank";
const clip = (s, n) => (typeof s === "string" ? s.slice(0, n) : "");
// Chrome's discovery events carry a page's new title late, often only when it closes; Target.getTargetInfo
// has it. After a page opens or navigates, ask at these delays (ms).
const RETITLE_MS = [250, 800, 2000, 5000, 10_000];
/** No title yet: Chrome shows the address (without its scheme) until the page sets one. */
const standInTitle = (t) => !t.title || t.title === t.url || t.title === String(t.url || "").replace(/^[a-z][\w+.-]*:\/\//i, "");

// ---- a minimal CDP client -------------------------------------------------------------------------------
class CdpClient extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.calls = new Map();
  }

  connect(timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024, handshakeTimeout: timeoutMs });
      this.ws = ws;
      ws.once("open", () => resolve(this));
      ws.once("error", reject);
      ws.on("error", () => {});
      ws.on("message", (data) => this._message(data));
      ws.on("close", () => {
        for (const c of this.calls.values()) {
          clearTimeout(c.timer);
          c.reject(new Error("CDP connection closed"));
        }
        this.calls.clear();
        this.emit("close");
      });
    });
  }

  get open() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  _message(data) {
    let m;
    try {
      m = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (m.id !== undefined) {
      const c = this.calls.get(m.id);
      if (!c) return;
      this.calls.delete(m.id);
      clearTimeout(c.timer);
      if (m.error) c.reject(Object.assign(new Error(m.error.message || "CDP error"), { code: m.error.code }));
      else c.resolve(m.result || {});
    } else if (m.method) this.emit("event", m);
  }

  send(method, params = {}, sessionId = null, timeoutMs = 15_000) {
    if (!this.open) return Promise.reject(new Error("CDP is not connected"));
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.calls.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }

  close() {
    if (!this.ws) return;
    if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
    else if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

// ---- what an agent's CDP traffic means ------------------------------------------------------------------
// While the user holds control the agent can still read the page, but not click, type or navigate, and not
// open or bring another tab to the front (a hidden tab paints nothing: the user's view would freeze). A new
// tab is refused with or without background:true, like PUT /json/new. Nor may it close the
// user's tab another way (a whole browser context, the browser itself, or a crash): the Deck owns the
// browser's lifecycle and stops it over its own connection, not the agent's.
const USER_ONLY = /^(?:Input\.\w+|Page\.(?:navigate|reload|navigateToHistoryEntry|resetNavigationHistory|close|bringToFront|crash)|Target\.(?:createTarget|closeTarget|activateTarget|disposeBrowserContext)|Browser\.(?:close|crash|crashGpuProcess))$/;
/**
 * The legacy (non-flat) attach transport: Target.sendMessageToTarget carries a whole CDP command as an
 * opaque string, so no gate ever sees the inner method; attaching without flatten:true opens a session
 * driven that way. Refused whoever holds control (app/main/cdp-tunnel.js refuses it as DEVICE_ONLY /
 * FLATTEN_ONLY; the relay's agent-host browser uses this).
 */
function legacyTransport(msg) {
  if (!msg || typeof msg.method !== "string") return false;
  if (msg.method === "Target.sendMessageToTarget") return true;
  if (msg.method !== "Target.attachToTarget" && msg.method !== "Target.setAutoAttach") return false;
  return !(msg.params && typeof msg.params === "object" && msg.params.flatten === true);
}
const LEGACY_BLOCKED = "Hermes Deck: the legacy CDP transport (Target.sendMessageToTarget) is refused here. Attach sessions with flatten:true.";
// The same for the HTTP discovery routes the agent reaches through the relay: open, close or activate a tab.
const USER_ONLY_HTTP = /^\/json\/(?:new|close|activate)\b/;
const BLOCKED =
  "Hermes Deck: the user has taken control of this browser (Workspace tab). Reading the page still works; clicks, typing and navigation are refused until the user hands control back.";
// Connection bookkeeping (attach, subscribe, inject helpers), not use: Hermes's CDP supervisor sends only
// these when it attaches to a tab. Everything else counts as the agent using the browser.
const SETUP =
  /^(?:\w+\.(?:enable|disable)|Target\.(?:getTargets|getTargetInfo|setDiscoverTargets|setAutoAttach|autoAttachRelated|attachToTarget|attachToBrowserTarget|detachFromTarget|getBrowserContexts)|Runtime\.(?:addBinding|removeBinding|runIfWaitingForDebugger|getIsolateId)|Page\.(?:addScriptToEvaluateOnNewDocument|removeScriptToEvaluateOnNewDocument|setLifecycleEventsEnabled|getFrameTree|setInterceptFileChooserDialog|createIsolatedWorld)|Browser\.(?:getVersion|getWindowForTarget|setDownloadBehavior)|Network\.(?:setCacheDisabled|setExtraHTTPHeaders|setUserAgentOverride)|(?:Emulation|Log|Inspector|Security|Fetch|ServiceWorker|Schema|SystemInfo)\.\w+)$/;
// Acting on one page, strongest first: the live view follows these.
const NAV = /^Page\.(?:navigate|reload|navigateToHistoryEntry)$/;
const INPUT = /^(?:Input\.\w+|DOM\.focus|Page\.bringToFront|Target\.activateTarget)$/;
const LOOK = /^(?:Runtime\.(?:evaluate|callFunctionOn)|Page\.(?:captureScreenshot|printToPDF)|DOM\.\w+|DOMSnapshot\.\w+|Accessibility\.\w+)$/;

/**
 * A read on a blank page is bookkeeping too: Hermes's supervisor ends its attach with a Runtime.evaluate on
 * about:blank (its dialog bridge). `pages` is the Trail's targetId -> targetInfo map.
 */
function readsBlank(hint, pages) {
  if (!hint || hint.act !== "look" || typeof hint.targetId !== "string" || !pages) return false;
  const t = pages.get(hint.targetId);
  return !!t && blank(t.url);
}

function parseJson(data) {
  try {
    const v = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/**
 * One agent socket's traffic. command(msg) for each command the agent sends, reply(data) for each message
 * the browser sends back. Flattened sessions are mapped to their page (Target.attachToTarget answers,
 * auto-attach events; an iframe's session acts for its page), so a command says which page it acts on.
 * Only replies to commands it waits for, and the two attach events, are parsed: big answers (screenshots)
 * are recognized from their first bytes and passed by.
 */
class AgentTracker {
  /** @param {string|null} pageTarget the page of a /devtools/page/<id> socket (its commands carry no sessionId) */
  constructor(pageTarget = null) {
    this.page = pageTarget;
    this.sessions = new Map(); // flattened sessionId -> page targetId
    this.waiting = new Map(); // command id -> {kind: "attach", targetId} | {kind: "create"}
  }

  /** {use, act, targetId}: use = not mere bookkeeping; act = "nav" | "input" | "look" | null on that page. */
  command(msg) {
    const m = String(msg.method || "");
    const p = msg.params && typeof msg.params === "object" ? msg.params : {};
    if (msg.id !== undefined && (m === "Target.attachToTarget" || m === "Target.createTarget")) {
      if (this.waiting.size >= 256) this.waiting.delete(this.waiting.keys().next().value);
      if (m === "Target.createTarget") this.waiting.set(msg.id, { kind: "create" });
      else if (typeof p.targetId === "string") this.waiting.set(msg.id, { kind: "attach", targetId: p.targetId });
    }
    const sid = typeof msg.sessionId === "string" ? msg.sessionId : null;
    const targetId = sid ? this.sessions.get(sid) || null : m === "Target.activateTarget" && typeof p.targetId === "string" ? p.targetId : this.page;
    const act = !targetId ? null : NAV.test(m) ? "nav" : INPUT.test(m) ? "input" : LOOK.test(m) ? "look" : null;
    return { use: !SETUP.test(m), act, targetId };
  }

  /** A message from the browser: {act: "create", targetId} when it answers the agent's Target.createTarget. */
  reply(data) {
    const head = typeof data === "string" ? data.slice(0, 48) : Buffer.isBuffer(data) ? data.toString("latin1", 0, Math.min(data.length, 48)) : "";
    const r = /^\{"id":(\d+),/.exec(head);
    if (r) {
      const w = this.waiting.get(Number(r[1]));
      if (!w) return null;
      this.waiting.delete(Number(r[1]));
      const res = (parseJson(data) || {}).result;
      if (!res) return null;
      if (w.kind === "attach" && typeof res.sessionId === "string") this.sessions.set(res.sessionId, w.targetId);
      else if (w.kind === "create" && typeof res.targetId === "string") return { act: "create", targetId: res.targetId };
      return null;
    }
    if (!/^\{"method":"Target\.(?:attachedToTarget|detachedFromTarget)"/.test(head)) return null;
    const e = parseJson(data);
    const p = e && e.params;
    if (!p || typeof p.sessionId !== "string") return null;
    if (e.method === "Target.detachedFromTarget") this.sessions.delete(p.sessionId);
    else if (p.targetInfo && typeof p.targetInfo === "object") {
      const own = p.targetInfo.type === "page" ? p.targetInfo.targetId : typeof e.sessionId === "string" ? this.sessions.get(e.sessionId) : null;
      if (typeof own === "string") this.sessions.set(p.sessionId, own);
    }
    return null;
  }
}

// ---- robot checks -------------------------------------------------------------------------------------------
const WALL_URL = /\/sorry\/|\/cdn-cgi\/challenge-platform\/|[/?&#.](?:re|h)?captcha\b/i;
const WALL_TITLE =
  /captcha|unusual traffic|are you a robot|not a robot|robot (?:check|kontrol|doğrula)|verify(?:ing)? (?:that )?you(?: are|'re) (?:a )?human|just a moment\.\.\.|attention required|olağan ?dışı trafik|güvenlik (?:kontrolü|doğrulaması)/i;
const WALL_TEXT = /unusual traffic|not a robot|are you a robot|verify (?:that )?you(?: are|'re) (?:a )?human|olağan ?dışı trafik|robot olmadığınızı|insan olduğunuzu doğrula/i;
const WALL_PROBE = "(document.body ? document.body.innerText : '').slice(0, 4000)";

/** "url" | "title" | "text" when a page looks like a verification wall (a robot check), else null. */
function wallOf(url, title, text = "") {
  if (WALL_URL.test(String(url || ""))) return "url";
  if (WALL_TITLE.test(String(title || ""))) return "title";
  if (text && WALL_TEXT.test(String(text))) return "text";
  return null;
}

// ---- the live view: screencast, tabs, following the agent, the user's input --------------------------------
const isPage = (t) => !!t && t.type === "page" && !/^(devtools|chrome-extension|chrome-untrusted|chrome-search):/i.test(t.url || "");
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
const int = (v, lo, hi) => Math.round(clamp(v, lo, hi));
// Following (ms): a read never pulls the view off a page the agent navigated or typed in this recently, and
// a page that changes its own address is the agent's only if the agent worked there this recently.
const STRONG_MS = 5000;
const OWN_MS = 5000;
const MOUSE = { down: "mousePressed", up: "mouseReleased", move: "mouseMoved" };
const BUTTONS = new Set(["none", "left", "middle", "right", "back", "forward"]);

/** What the URL bar accepts: http(s) and about:blank; a bare host gets https://; anything else is a search. */
function normalizeUrl(input) {
  const s = String(input || "").trim();
  if (!s || s.length > 4096) return null;
  if (s.toLowerCase() === "about:blank") return "about:blank";
  if (/^https?:\/\//i.test(s)) {
    try {
      return new URL(s).toString();
    } catch {
      return null;
    }
  }
  const hostLike = /^(?:localhost|[\w-]+(?:\.[\w-]+)+|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d{1,5})?(?:[/?#]\S*)?$/i.test(s);
  if (hostLike) {
    const local = /^(?:localhost|127\.|10\.|192\.168\.|\[)/i.test(s);
    try {
      return new URL(`${local ? "http" : "https"}://${s}`).toString();
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/\s/.test(s)) return null; // javascript:, file:, chrome: ... not here
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
}

/**
 * Watches one agent browser: its own CDP connection (separate from the agent's), a JPEG screencast of the
 * page on screen (about `fps` frames a second, each acknowledged), the tab list of every browser context,
 * and the user's input, forwarded only while the user holds control.
 *
 * Following. The view shows the page the agent works on: a page it opens, navigates, clicks or types in
 * (the agent's own commands arrive as "agent-act" events from its browser), or merely reads when nothing
 * stronger happened in the last few seconds; a bare about:blank it only reads (Hermes's CDP supervisor)
 * is never followed. A tab the user picks pauses following until the agent opens or navigates a page.
 * Address changes the agent did not cause (a page's own history.pushState, redirects in a tab the agent
 * left) never move the view.
 * Hidden (background) tabs paint nothing, but bringing one to the front hides the tab in front, and a
 * hidden tab slows or hangs the agent's screenshots there. So a tab comes to the front only for the user
 * who holds control, or when it is the page the agent itself acted on last (_mayFront). Any other tab is
 * watched where it is; if it is hidden, status().hidden says so ("arka plan sekmesi") until it paints.
 * When the shown page closes, the last frame stays as "Last seen".
 *
 * @param {object} browser {port, wsPath, controller: "agent"|"user", lastAct?}, an EventEmitter of
 *   "agent-act" {targetId, act: "nav"|"input"|"look"|"create", at}
 * Events: "frame" {targetId, data: Buffer, meta}, "tabs" (list; status() changed too), "lost".
 */
class LiveView extends EventEmitter {
  constructor(browser, { maxWidth = 1280, maxHeight = 1280, fps = 8, quality = 62, ready = null } = {}) {
    super();
    this.browser = browser;
    this.opts = { maxWidth, maxHeight, fps, quality };
    this.canSend = typeof ready === "function" ? ready : () => true; // false holds the next frame back (slow link)
    this.cdp = null;
    this.targets = new Map(); // targetId -> targetInfo: pages of every browser context
    this.used = new Map(); // targetId -> when the agent last worked there
    this.targetId = null; // the page on screen; null once it closed ("Last seen")
    this.session = null;
    this.meta = null;
    this.lastAck = 0;
    this.lastEmit = 0; // when the last frame went out (at most `fps` a second)
    this.held = null; // a frame that came too soon: it goes out at the next slot unless a newer one replaces it
    this.heldTimer = null;
    this.hidden = false; // the page on screen is a background tab that paints nothing
    this.follow = true; // false: the user picked a tab
    this.lastSeen = null; // {url, title, at}: the page on screen closed and nothing replaced it
    this.wall = null; // {url, title, at}: the page on screen looks like a robot check
    this.strong = null; // {targetId, at}: the agent's last navigation or input (outranks reading another page)
    this.want = null; // a page the agent acts on that discovery has not reported yet
    this.early = null; // the agent's last act while start() ran
    this.started = false; // no following until the first page is shown
    this.closed = false;
    this._onAct = (a) => this._act(a);
  }

  status() {
    return { follow: this.follow, lastSeen: this.lastSeen, wall: this.wall, hidden: this.hidden };
  }

  async start() {
    const b = this.browser;
    this.cdp = new CdpClient(`ws://127.0.0.1:${b.port}${b.wsPath}`);
    await this.cdp.connect(5000);
    this.cdp.on("event", (e) => this._event(e));
    this.cdp.on("close", () => {
      if (!this.closed) this.emit("lost");
    });
    if (typeof b.on === "function") b.on("agent-act", this._onAct);
    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    // a just-started Chrome reports its port a moment before its first tab exists
    for (let i = 0; i < 20; i++) {
      const { targetInfos = [] } = await this.cdp.send("Target.getTargets");
      for (const t of targetInfos) if (isPage(t)) this.targets.set(t.targetId, t);
      if (this.targets.size) break;
      await sleep(100);
    }
    const first = this._pick();
    const id = first ? first.targetId : (await this.cdp.send("Target.createTarget", { url: "about:blank" })).targetId;
    await this._attach(id);
    this.started = true;
    const a = this.early; // the agent moved on while we were attaching
    this.early = null;
    if (a) this._act(a);
  }

  /** The page to show first: where the agent acted last, the browser-harness tab ("🐴 " title), a real page. */
  _pick() {
    const pages = [...this.targets.values()];
    const la = this.browser.lastAct;
    const last = la && pages.find((t) => t.targetId === la.targetId && !blank(t.url));
    return last || pages.find((t) => /^\u{1F434} /u.test(t.title || "")) || pages.find((t) => !blank(t.url)) || pages[0] || null;
  }

  stop() {
    this.closed = true;
    clearTimeout(this.heldTimer);
    this.held = null;
    if (typeof this.browser.off === "function") this.browser.off("agent-act", this._onAct);
    if (this.session && this.cdp) this.cdp.send("Page.stopScreencast", {}, this.session).catch(() => {});
    if (this.cdp) setTimeout(() => this.cdp.close(), 50);
  }

  /**
   * Ask for a different frame size (the view got bigger or smaller). The screencast restarts on the page that is
   * already attached: no re-attach, no tab events, and the viewer keeps showing the last frame until the first one
   * of the new size arrives (so nothing blinks). Frames never exceed the page's own viewport size: this is the cap.
   * Input coordinates are unaffected (they use the frame metadata's device size, not the bitmap size).
   */
  resize({ maxWidth, maxHeight } = {}) {
    const w = Math.round(Number(maxWidth));
    const h = Math.round(Number(maxHeight));
    if (this.closed || !(w > 0) || !(h > 0) || (w === this.opts.maxWidth && h === this.opts.maxHeight)) return Promise.resolve();
    this.opts = { ...this.opts, maxWidth: w, maxHeight: h }; // a page attached later reads these too
    const sessionId = this.session;
    if (!sessionId || !this.cdp) return Promise.resolve();
    // one restart at a time; the last request wins (it reads this.opts when its turn comes)
    this._rescreen = (this._rescreen || Promise.resolve())
      .then(async () => {
        if (this.closed || this.session !== sessionId) return;
        const { maxWidth: mw, maxHeight: mh, quality } = this.opts;
        await this.cdp.send("Page.stopScreencast", {}, sessionId);
        if (this.closed || this.session !== sessionId) return;
        await this.cdp.send("Page.startScreencast", { format: "jpeg", quality, maxWidth: mw, maxHeight: mh, everyNthFrame: 1 }, sessionId);
      })
      .catch(() => {});
    return this._rescreen;
  }

  tabs() {
    return [...this.targets.values()].map((t) => ({ id: t.targetId, title: t.title || "", url: t.url || "", shown: t.targetId === this.targetId }));
  }

  _emitTabs() {
    if (!this.closed) this.emit("tabs", this.tabs());
  }

  /**
   * May this tab come to the front? Only for the user who holds control, or when it is the page the agent
   * itself acted on last (not a mere read). Bringing a tab forward hides the one in front, and the agent's
   * screenshots of a hidden tab slow down or hang: watching must never do that to the agent's working tab.
   */
  _mayFront(targetId) {
    if (this.browser.controller === "user") return true;
    const la = this.browser.lastAct;
    return !!la && la.targetId === targetId && la.act !== "look";
  }

  /** Bring the shown tab forward (see _mayFront): a hidden tab paints no frames. */
  _front(targetId) {
    if (this.browser.transferring) return Promise.resolve();
    return this.cdp.send("Target.activateTarget", { targetId }).catch(() => {});
  }

  async _attach(targetId, front = this._mayFront(targetId)) {
    const prev = this.session;
    this.session = null;
    this.meta = null;
    this.held = null;
    this.hidden = false;
    this.targetId = targetId;
    this.lastSeen = null;
    this.wall = null;
    if (prev) {
      this.cdp.send("Page.stopScreencast", {}, prev).catch(() => {});
      this.cdp.send("Target.detachFromTarget", { sessionId: prev }).catch(() => {});
    }
    this._emitTabs();
    if (front) await this._front(targetId);
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    if (this.closed || this.targetId !== targetId) {
      this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      return;
    }
    this.session = sessionId;
    await this.cdp.send("Page.enable", {}, sessionId).catch(() => {});
    const { maxWidth, maxHeight, quality } = this.opts;
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality, maxWidth, maxHeight, everyNthFrame: 1 }, sessionId);
    if (!front) this._checkHidden(targetId, sessionId);
    this._emitTabs();
    this._retitle(targetId);
    this._checkWall(true);
  }

  /** A tab watched where it is: if it is a background tab it paints nothing; the user is told (status().hidden). */
  async _checkHidden(targetId, sessionId) {
    const r = await this.cdp.send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true, silent: true }, sessionId, 3000).catch(() => null);
    if (this.closed || this.session !== sessionId || this.meta) return; // moved on, or a frame came: it paints
    const hidden = !!(r && r.result && r.result.value === "hidden");
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this._emitTabs();
  }

  /** The page's current title (and address) from Chrome; discovery events lag behind (RETITLE_MS). */
  _retitle(targetId) {
    if (this.closed || !this.cdp || !this.cdp.open) return;
    this.cdp
      .send("Target.getTargetInfo", { targetId }, null, 5000)
      .then(({ targetInfo: t }) => {
        const old = this.targets.get(targetId);
        if (!old || !isPage(t) || (old.title === t.title && old.url === t.url)) return;
        this.targets.set(targetId, t);
        if (targetId === this.targetId) this._checkWall(false);
        this._emitTabs();
      })
      .catch(() => {});
  }

  _retitleSoon(targetId) {
    for (const ms of RETITLE_MS) setTimeout(() => this._retitle(targetId), ms);
  }

  _event({ method, params, sessionId }) {
    if (method === "Page.screencastFrame") return this._frame(params, sessionId);
    if (method === "Page.loadEventFired" || method === "Page.domContentEventFired") {
      if (sessionId !== this.session) return;
      this._retitle(this.targetId);
      if (method === "Page.loadEventFired") this._checkWall(true);
      return;
    }
    const t = params && params.targetInfo;
    if (method === "Target.targetCreated" && isPage(t)) {
      const known = this.targets.has(t.targetId);
      this.targets.set(t.targetId, t);
      if (!known && this.want === t.targetId) {
        this.want = null; // the agent acted on it before discovery reported it
        this.used.set(t.targetId, Date.now());
        this._follow(t.targetId, "nav");
      } else if (!known && !blank(t.url) && t.openerId && this._agentPage(t.openerId)) {
        this._follow(t.targetId, "create", true); // the agent's page opened it (a link, window.open)
      }
      if (!known && !blank(t.url)) this._retitleSoon(t.targetId);
      this._emitTabs();
    } else if (method === "Target.targetInfoChanged" && t) {
      const old = this.targets.get(t.targetId);
      if (!isPage(t)) {
        if (old) this.targets.delete(t.targetId);
      } else {
        // an event may carry Chrome's stand-in title (the address) after we already asked for the real one
        this.targets.set(t.targetId, old && old.url === t.url && standInTitle(t) ? { ...t, title: old.title } : t);
        if (old && old.url !== t.url && !blank(t.url)) {
          // a page navigated: follow only the agent's own page (its click led there), never a page that
          // changes its own address (pushState, a redirect) in a tab the agent left
          if (this._agentPage(t.targetId)) this._follow(t.targetId, "nav", true);
          this._retitleSoon(t.targetId);
        }
        if (old && t.targetId === this.targetId && (old.title !== t.title || old.url !== t.url)) this._checkWall(false);
      }
      this._emitTabs();
    } else if (method === "Target.targetDestroyed") {
      const old = this.targets.get(params.targetId);
      this.targets.delete(params.targetId);
      this.used.delete(params.targetId);
      if (params.targetId === this.targetId) this._closedShown(old);
      this._emitTabs();
    } else if (method === "Target.detachedFromTarget" && params.sessionId === this.session) {
      this.session = null;
      if (this.targets.has(this.targetId)) this._attach(this.targetId).catch(() => {});
    }
  }

  _frame(params, sessionId) {
    if (sessionId !== this.session) {
      this.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId).catch(() => {});
      return;
    }
    this.meta = params.metadata;
    if (this.hidden) this._reshow(this.targetId); // it paints after all
    // Chrome keeps about two frames in flight, so pacing the ack alone lets ~2x `fps` through: a frame that
    // comes too soon waits for the next slot, and a newer one replaces it
    this.held = { targetId: this.targetId, data: params.data, meta: params.metadata, sessionId };
    this._emitHeld();
    // the next frame only comes after the ack: delaying it caps the frame rate (and waits out a slow link)
    const ack = () => {
      if (this.closed || !this.cdp.open || sessionId !== this.session) return;
      if (!this.canSend()) return setTimeout(ack, 100);
      this.lastAck = Date.now();
      this.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId).catch(() => {});
    };
    setTimeout(ack, Math.max(0, this.lastAck + 1000 / this.opts.fps - Date.now()));
  }

  /** Send the held frame if its slot has come (at most `fps` frames a second), else when it comes. */
  _emitHeld() {
    clearTimeout(this.heldTimer);
    this.heldTimer = null;
    const f = this.held;
    if (!f || this.closed) return;
    if (f.sessionId !== this.session) {
      this.held = null;
      return;
    }
    const wait = this.lastEmit + 1000 / this.opts.fps - Date.now();
    if (wait > 0) {
      this.heldTimer = setTimeout(() => this._emitHeld(), wait);
      return;
    }
    this.held = null;
    this.lastEmit = Date.now();
    this.emit("frame", { targetId: f.targetId, data: Buffer.from(f.data, "base64"), meta: f.meta });
  }

  /** The agent's own command acted on a page (its browser's "agent-act"). */
  _act(a) {
    if (!a || typeof a.targetId !== "string" || this.closed) return;
    if (!this.started) {
      this.early = a;
      return;
    }
    if (!this.targets.has(a.targetId)) {
      if (a.act !== "look") this.want = a.targetId; // discovery reports it in a moment
      return;
    }
    this._follow(a.targetId, a.act);
  }

  /**
   * Is this the page the agent works in? It acted there in the last OWN_MS, and no navigation or input of the
   * agent on another page is newer. Discovery events (a page changing its own address) count only then.
   */
  _agentPage(targetId, now = Date.now()) {
    const la = this.browser.lastAct;
    const at = Math.max(this.used.get(targetId) || 0, la && la.targetId === targetId ? la.at || 0 : 0);
    if (!at || now - at > OWN_MS) return false;
    return !(this.strong && this.strong.targetId !== targetId && this.strong.at > at);
  }

  /**
   * Show the page the agent works on, unless the user drives, or picked a tab and this is no new page or
   * navigation. `discovery`: Chrome reported it (not the agent's own command): it neither marks the page as
   * used nor outranks the agent's reads elsewhere (this.strong), so a busy page cannot keep the view.
   */
  _follow(targetId, act, discovery = false) {
    const t = this.targets.get(targetId);
    if (!t || !this.started || this.closed) return;
    const now = Date.now();
    if (!discovery) this.used.set(targetId, now);
    if (this.browser.controller === "user") return;
    const strong = act === "nav" || act === "create";
    if (!this.follow && !strong) return;
    if (act === "look") {
      if (blank(t.url)) return; // e.g. Hermes's CDP supervisor on about:blank
      if (this.strong && this.strong.targetId !== targetId && now - this.strong.at < STRONG_MS) return;
    } else if (!discovery) this.strong = { targetId, at: now };
    const resumed = !this.follow;
    this.follow = true;
    if (targetId !== this.targetId) this._attach(targetId).catch(() => {});
    else {
      // the shown page became the agent's working page: bring it forward if it was watched hidden
      if (this.hidden && this._mayFront(targetId)) this._front(targetId).then(() => this._reshow(targetId));
      if (resumed) this._emitTabs();
    }
  }

  /** The shown tab was just brought forward: it paints now. */
  _reshow(targetId) {
    if (this.closed || this.targetId !== targetId || !this.hidden) return;
    this.hidden = false;
    this._emitTabs();
  }

  /** The page on screen closed: keep its last frame ("Last seen") unless the agent works in another page. */
  _closedShown(old) {
    this.session = null;
    this.targetId = null;
    this.meta = null;
    this.wall = null;
    this.follow = true; // a tab the user picked is gone
    const real = [...this.targets.values()].filter((t) => !blank(t.url));
    real.sort((x, y) => (this.used.get(y.targetId) || 0) - (this.used.get(x.targetId) || 0));
    if (old && !blank(old.url)) {
      this.lastSeen = { url: old.url, title: old.title || "", at: Date.now() };
      if (real[0] && this.used.get(real[0].targetId)) this._attach(real[0].targetId).catch(() => {});
    } else {
      const any = real[0] || [...this.targets.values()][0];
      if (any) this._attach(any.targetId).catch(() => {});
    }
  }

  async _checkWall(deep) {
    const id = this.targetId;
    const t = id ? this.targets.get(id) : null;
    if (!t) return;
    let why = wallOf(t.url, t.title);
    if (!why && deep && !blank(t.url) && this.session) {
      const r = await this.cdp.send("Runtime.evaluate", { expression: WALL_PROBE, returnByValue: true, silent: true }, this.session, 3000).catch(() => null);
      if (this.targetId !== id || this.closed) return;
      why = wallOf("", "", r && r.result && typeof r.result.value === "string" ? r.result.value : "");
    }
    const cur = this.targets.get(id) || t;
    if (!why && !deep && this.wall && this.wall.url === cur.url) return; // a new title alone never clears a body match
    const next = why ? { url: cur.url || "", title: cur.title || "", at: this.wall && this.wall.url === cur.url ? this.wall.at : Date.now() } : null;
    if (JSON.stringify(next) === JSON.stringify(this.wall)) return;
    this.wall = next;
    this._emitTabs();
  }

  _need() {
    if (this.browser.transferring) throw new Error("The browser is being transferred; try again when it finishes.");
    if (!this.session) throw new Error("tab not ready");
    return this.session;
  }

  /** The user picked a tab: following pauses until the agent opens or navigates a page. */
  async selectTab(targetId) {
    if (!this.targets.has(targetId)) throw new Error("tab not found");
    this.follow = false;
    // watching a tab is not driving it: it comes to the front only while the user holds control, so the
    // agent's working tab stays visible (a background pick may show "arka plan sekmesi" until control)
    await this._attach(targetId, this.browser.controller === "user");
  }

  /** "Follow agent": follow again, starting with the page the agent used last. */
  async resume() {
    this.follow = true;
    const la = this.browser.lastAct;
    let id = la && this.targets.has(la.targetId) && !blank(this.targets.get(la.targetId).url) ? la.targetId : null;
    if (!id) {
      const used = [...this.used.entries()].filter(([k]) => this.targets.has(k)).sort((x, y) => y[1] - x[1])[0];
      id = used ? used[0] : null;
    }
    if (id && id !== this.targetId) await this._attach(id);
    else this._emitTabs();
  }

  async newTab(url) {
    if (this.browser.transferring) throw new Error("The browser is being transferred; try again when it finishes.");
    const { targetId } = await this.cdp.send("Target.createTarget", { url: normalizeUrl(url) || "about:blank" });
    this.follow = false;
    await this._attach(targetId);
  }

  async closeTab(targetId) {
    if (this.browser.transferring) throw new Error("The browser is being transferred; try again when it finishes.");
    if (!this.targets.has(targetId)) throw new Error("tab not found");
    if (this.targets.size === 1) await this.cdp.send("Target.createTarget", { url: "about:blank" }); // keep one tab
    await this.cdp.send("Target.closeTarget", { targetId });
  }

  async navigate(url) {
    const u = normalizeUrl(url);
    if (!u) throw new Error("This address cannot be opened");
    await this.cdp.send("Page.navigate", { url: u }, this._need());
  }

  async history(delta) {
    const s = this._need();
    const { currentIndex, entries } = await this.cdp.send("Page.getNavigationHistory", {}, s);
    const e = entries[currentIndex + (delta < 0 ? -1 : 1)];
    if (e) await this.cdp.send("Page.navigateToHistoryEntry", { entryId: e.id }, s);
  }

  async reload() {
    await this.cdp.send("Page.reload", {}, this._need());
  }

  /** Bring the shown tab to the front so key events reach it (on taking control); a hidden pick paints now. */
  focus() {
    if (!this.session || this.browser.transferring) return;
    const id = this.targetId;
    this.cdp.send("Page.bringToFront", {}, this.session).then(() => this._reshow(id), () => {});
  }

  /** One input event from the user, in normalized coordinates (0..1 of the shown frame). */
  input(ev) {
    if (!ev || typeof ev !== "object" || !this.session || !this.meta || this.browser.controller !== "user" || this.browser.transferring) return;
    const s = this.session;
    const W = this.meta.deviceWidth || 1280;
    const H = this.meta.deviceHeight || 800;
    const modifiers = int(ev.modifiers, 0, 15);
    const x = clamp(ev.x, 0, 1) * W;
    const y = clamp(ev.y, 0, 1) * H;
    const fire = (method, params) => this.cdp.send(method, params, s).catch(() => {});
    if (ev.type === "mouse" && MOUSE[ev.action]) {
      const type = MOUSE[ev.action];
      const button = BUTTONS.has(ev.button) ? ev.button : "none";
      fire("Input.dispatchMouseEvent", { type, x, y, modifiers, button: type === "mouseMoved" && !ev.buttons ? "none" : button, buttons: int(ev.buttons, 0, 31), clickCount: type === "mouseMoved" ? 0 : int(ev.clickCount, 1, 3) });
    } else if (ev.type === "wheel") {
      fire("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, modifiers, button: "none", deltaX: clamp(ev.dx, -5000, 5000), deltaY: clamp(ev.dy, -5000, 5000) });
    } else if (ev.type === "key" && (ev.action === "down" || ev.action === "up")) {
      const kc = int(ev.keyCode, 0, 255);
      const base = { key: clip(ev.key, 32), code: clip(ev.code, 32), windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers, location: int(ev.location, 0, 3) };
      const text = typeof ev.text === "string" && ev.text.length > 0 && ev.text.length <= 4 ? ev.text : "";
      if (ev.action === "down") fire("Input.dispatchKeyEvent", { ...base, type: text ? "keyDown" : "rawKeyDown", text: text || undefined, unmodifiedText: text || undefined, autoRepeat: !!ev.repeat });
      else fire("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    } else if (ev.type === "text") {
      const text = clip(ev.text, 20_000);
      if (text) fire("Input.insertText", { text });
    }
  }
}

// ---- the trail: where the agent went, kept while nobody watches -------------------------------------------
/**
 * A discovery-only CDP connection to one agent browser: pages opened, navigated and closed (with titles and
 * times, the last `max`), and whether any open page looks like a robot check. Never attaches to a page.
 * Events: "change", "lost".
 */
class Trail extends EventEmitter {
  constructor(url, { max = 24, entries = [] } = {}) {
    super();
    this.url = url;
    this.max = max;
    this.cdp = null;
    this.pages = new Map();
    this.entries = entries.slice(-max); // {at, kind: "open"|"nav"|"close", url, title, id}
    this.wall = null; // {url, title, at}
    this.closed = false;
  }

  async start() {
    this.cdp = new CdpClient(this.url);
    await this.cdp.connect(5000);
    this.cdp.on("event", (e) => this._event(e));
    this.cdp.on("close", () => {
      if (!this.closed) this.emit("lost");
    });
    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    return this;
  }

  stop() {
    this.closed = true;
    if (this.cdp) this.cdp.close();
  }

  snapshot(n = 8) {
    return { trail: this.entries.slice(-n).map(({ at, kind, url, title }) => ({ at, kind, url, title })), wall: this.wall };
  }

  _event({ method, params }) {
    let t = params && params.targetInfo;
    if (method === "Target.targetCreated" && isPage(t)) {
      this.pages.set(t.targetId, t);
      if (!blank(t.url)) this._add("open", t);
    } else if (method === "Target.targetInfoChanged" && t) {
      const old = this.pages.get(t.targetId);
      if (!isPage(t)) {
        if (!old) return;
        this.pages.delete(t.targetId);
      } else {
        if (old && old.url === t.url && standInTitle(t)) t = { ...t, title: old.title }; // keep the real title we asked for
        this.pages.set(t.targetId, t);
        if (!old) {
          if (!blank(t.url)) this._add("open", t);
        } else if (old.url !== t.url && !blank(t.url)) this._add("nav", t);
        else if (old.title !== t.title) this._rename(t);
        else return;
      }
    } else if (method === "Target.targetDestroyed") {
      const old = this.pages.get(params.targetId);
      if (!old) return;
      this.pages.delete(params.targetId);
      if (!blank(old.url)) this._add("close", old);
    } else return;
    this._changed();
  }

  _add(kind, t) {
    this.entries.push({ at: Date.now(), kind, url: clip(t.url, 500), title: standInTitle(t) ? "" : clip(t.title, 160), id: t.targetId });
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    if (kind !== "close") for (const ms of RETITLE_MS) setTimeout(() => this._ask(t.targetId), ms);
  }

  /** The page's real title from Chrome (discovery events bring it late). */
  _ask(targetId) {
    if (this.closed || !this.cdp || !this.cdp.open || !this.pages.has(targetId)) return;
    this.cdp
      .send("Target.getTargetInfo", { targetId }, null, 5000)
      .then(({ targetInfo: t }) => {
        const old = this.pages.get(targetId);
        if (!old || !isPage(t) || t.url !== old.url || t.title === old.title || standInTitle(t)) return;
        this.pages.set(targetId, t);
        this._rename(t);
        this._changed();
      })
      .catch(() => {});
  }

  /** A page got its title: the entry that opened it shows it. */
  _rename(t) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.id !== t.targetId) continue;
      if (e.kind !== "close" && e.url === clip(t.url, 500) && !standInTitle(t)) e.title = clip(t.title, 160);
      return;
    }
  }

  _changed() {
    const w = [...this.pages.values()].find((p) => wallOf(p.url, p.title));
    const next = w ? { url: clip(w.url, 500), title: clip(w.title, 160), at: this.wall && this.wall.url === clip(w.url, 500) ? this.wall.at : Date.now() } : null;
    this.wall = next;
    this.emit("change");
  }
}

module.exports = { CdpClient, AgentTracker, LiveView, Trail, wallOf, normalizeUrl, isPage, readsBlank, USER_ONLY, USER_ONLY_HTTP, BLOCKED, legacyTransport, LEGACY_BLOCKED, SETUP, WALL_PROBE };
