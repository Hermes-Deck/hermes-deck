"use strict";
// Hermes Deck shell (Blend): the frame every view lives in (sidebar | main | right slot) and the small mount API that
// the conversation, work-pane and triage modules plug into: window.DeckShell. The pure helpers at the top (right-slot
// model, old tab ids, shortcuts, channel chip, sidebar filters) are exported for Node tests; the DOM part only runs in
// the page. Everything here builds DOM with text nodes; nothing from a chat or the relay is parsed as HTML.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DeckShell = api.create(root.document, root);
})(typeof window === "object" ? window : globalThis, function (root) {
  const I18N = () => (typeof module === "object" && module.exports ? require("./i18n") : root.DeckI18n);
  const T = (key, vars) => I18N().t(key, vars);

  // ---------------------------------------------------------------- pure helpers
  const KINDS = ["work"];
  /** Tab order per right-slot kind; ids a module adds later go after these, in registration order. */
  const ORDER = { work: ["session", "run", "plan", "diff", "agents", "browser", "screen"] };
  const DEFAULT_TAB = { work: "run" };
  /**
   * Old right-panel ids (persisted, --tab=, old callers) -> [kind, tab]. The Inspector is gone: its Session tab is the
   * Work pane's first tab, and Usage is a main-area view (kind "main"), opened by whoever provides the usageView service.
   */
  const LEGACY = {
    activity: ["work", "session"], session: ["work", "session"],
    fleet: ["main", "usage"], tokens: ["main", "usage"], usage: ["main", "usage"],
    workspace: ["work", "browser"], screen: ["work", "screen"],
  };
  for (const k of KINDS) for (const id of ORDER[k]) LEGACY[id] = LEGACY[id] || [k, id];
  const legacyTab = (id) => (typeof id === "string" && Object.prototype.hasOwnProperty.call(LEGACY, id) ? LEGACY[id] : null);

  /**
   * The right slot a stored state comes back as. Returns {kind, last, view}: view "usage" when the stored state was the
   * old Inspector's Usage tab (the caller opens the Usage view once); an old Inspector Session lands on Work › Session.
   * get(key) reads the stored strings (deck.right, deck.itab, deck.wtab, and the pre-Blend deck.panelClosed/deck.tab).
   */
  function restoreRight(get) {
    const last = { work: get("deck.wtab") || DEFAULT_TAB.work };
    const saved = get("deck.right");
    let old = null;
    if (saved === "inspector") old = legacyTab(get("deck.itab") || "session") || LEGACY.session;
    else if (saved !== null) return { kind: KINDS.includes(saved) ? saved : null, last, view: null };
    else if (get("deck.panelClosed") === "0") old = legacyTab(get("deck.tab") || "activity");
    if (!old) return { kind: null, last, view: null };
    if (old[0] === "main") return { kind: null, last, view: old[1] };
    last[old[0]] = old[1];
    return { kind: old[0], last, view: null };
  }

  /** One spot for the right slot's transitions: opening one kind closes the other; each kind remembers its tab. */
  function nextRight(state, action, kind, tab) {
    const last = { ...DEFAULT_TAB, ...(state && state.last) };
    const cur = state && KINDS.includes(state.kind) ? state.kind : null;
    if (action === "close") return { kind: null, last };
    if (!KINDS.includes(kind)) return { kind: cur, last };
    if (action === "toggle" && cur === kind && !tab) return { kind: null, last };
    if (tab) last[kind] = tab;
    return { kind, last };
  }

  /** The tab to show: the wanted one when it is visible, else the first visible one (or null). */
  function pickTab(want, visible) {
    if (visible.includes(want)) return want;
    return visible[0] || null;
  }

  function sortTabs(kind, ids) {
    const order = ORDER[kind] || [];
    const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
    return ids.map((id, i) => [id, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([id]) => id);
  }

  /** Shell-level shortcuts. Ctrl on Windows/Linux, Cmd on macOS. Returns an action name or null. */
  function keyAction(e) {
    if (!e || !(e.ctrlKey || e.metaKey) || e.isComposing) return null;
    const key = String(e.key || "").toLowerCase();
    // Ctrl+\ ; on layouts where "\" needs AltGr (Ctrl+Alt on Windows) the key still reads "\"
    if (!e.shiftKey && (e.key === "\\" || (!e.altKey && e.code === "Backslash"))) return "work";
    if (e.altKey && !e.shiftKey && (e.code === "KeyI" || key === "i")) return "session";
    if (!e.shiftKey && !e.altKey && key === "b") return "sidebar";
    if (!e.shiftKey && !e.altKey && key === "j") return "fleet";
    return null;
  }

  const sourceName = (s) => {
    const v = String(s || "").trim();
    return v ? v.charAt(0).toUpperCase() + v.slice(1) : "";
  };

  /**
   * The channel chip of the chat on screen: what the composer talks to. Inputs are plain facts the app knows:
   * the sidebar mode, whether the open session is a sub-agent, and whether a send from here continues in a Deck copy
   * (a messaging-platform session the Deck must not write into). Returns {id, key, vars} for i18n.
   */
  function channelOf({ mode, subagent = false, readOnly = false, source = "" } = {}) {
    if (subagent) return { id: "sub", key: "shell.chip.sub", vars: {} };
    if (mode === "bots") return { id: "bot", key: "shell.chip.bot", vars: {} };
    if (mode === "telegram") return { id: "telegram", key: "shell.chip.telegram", vars: {} };
    if (readOnly) return { id: "readonly", key: "shell.chip.readOnly", vars: { source: sourceName(source) || "Telegram" } };
    return { id: "hermes", key: "shell.chip.hermes", vars: {} };
  }

  /** Smart filters of the Sessions sidebar, in display order. */
  const FILTERS = ["needs", "all", "running", "waiting", "today", "pinned"];
  const sameDay = (a, b) => new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
  /**
   * Does a session fact record pass a filter? f = {needs, live, waiting, pinned, updatedAt (epoch s)}.
   * needs = an approval or question waits for you; waiting = queued messages or a rate limit, nothing for you to do.
   */
  function matchFilter(view, f, now = Date.now() / 1000) {
    if (!f) return false;
    switch (view) {
      case "needs": return !!f.needs;
      case "running": return !!f.live;
      case "waiting": return !!f.waiting && !f.needs;
      case "today": return !!f.updatedAt && sameDay(f.updatedAt, now);
      case "pinned": return !!f.pinned;
      default: return true;
    }
  }

  // ---------------------------------------------------------------- icons (16px line set from the Blend mockup)
  const ICONS = {
    side: "M2.5 3.5h11v9h-11zM6.5 3.5v9", search: "M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 1 1 9 0zM10.5 10.5l3 3",
    work: "M2.5 3.5h4v4h-4zM9.5 8.5h4v4h-4zM6.5 5.5h3v3", gear: "M6.88 3.33L7.13 1.56L8.87 1.56L9.12 3.33L10.51 3.91L11.94 2.83L13.17 4.06L12.09 5.49L12.67 6.88L14.44 7.13L14.44 8.87L12.67 9.12L12.09 10.51L13.17 11.94L11.94 13.17L10.51 12.09L9.12 12.67L8.87 14.44L7.13 14.44L6.88 12.67L5.49 12.09L4.06 13.17L2.83 11.94L3.91 10.51L3.33 9.12L1.56 8.87L1.56 7.13L3.33 6.88L3.91 5.49L2.83 4.06L4.06 2.83L5.49 3.91ZM8 6a2 2 0 1 0 0 4a2 2 0 1 0 0-4z",
    inbox: "M2.5 9.5h3l1 2h3l1-2h3M2.5 9.5l2-6h7l2 6v4h-11z", all: "M2.5 4.5h11M2.5 8h11M2.5 11.5h7", running: "M1.5 8h3L6 4l3 8 1.5-4h4",
    waiting: "M4 2.5h8M4 13.5h8M5 2.5c0 3 6 3.5 6 5.5s-6 2.5-6 5.5M11 2.5c0 3-6 3.5-6 5.5s6 2.5 6 5.5", today: "M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 1.5v3M10.5 1.5v3",
    pin: "M6 2.5h4l-.5 4 2 2.5h-7l2-2.5zM8 9v4.5", chev: "M6 4l4 4-4 4", x: "M4 4l8 8M12 4l-8 8",
    telegram: "M14 2.5 2 7l4.5 1.5L8 13.5zM6.5 8.5l7.5-6", sessions: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z", bots: "M4.5 5.5h7v7h-7zM8 2.5v3M6.5 8.5h.01M9.5 8.5h.01",
    agent: "M8 2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5zM3 13.5c.5-3 2.5-4 5-4s4.5 1 5 4", hermes: "M3 13 7 3h3L6 13zM8 13l4-10h2l-4 10z",
    lock: "M4.5 7.5h7v6h-7zM6 7.5v-2a2 2 0 1 1 4 0v2", steer: "M2.5 8h8M7.5 4.5 11 8l-3.5 3.5M13.5 3v10",
  };
  function icon(doc, name, size = 16) {
    const NS = "http://www.w3.org/2000/svg";
    const s = doc.createElementNS(NS, "svg");
    for (const [k, v] of Object.entries({ class: "i", viewBox: "0 0 16 16", width: size, height: size, "aria-hidden": "true" })) s.setAttribute(k, String(v));
    const p = doc.createElementNS(NS, "path");
    p.setAttribute("d", ICONS[name] || ICONS.all);
    s.appendChild(p);
    return s;
  }

  // ---------------------------------------------------------------- the page shell
  function create(doc, win) {
    const $ = (id) => (doc ? doc.getElementById(id) : null);
    const listeners = new Map();
    const lastEvent = new Map();
    const on = (ev, fn) => {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
      return () => listeners.get(ev).delete(fn);
    };
    /** Listener errors are logged, never thrown: one module must not break another (or the app's render loop). */
    function emit(ev, detail) {
      lastEvent.set(ev, detail);
      for (const fn of [...(listeners.get(ev) || [])]) {
        try { fn(detail); } catch (e) { if (win && win.console) win.console.error(`DeckShell ${ev} listener:`, e); }
      }
    }
    const store = {
      get(k) { try { return win.localStorage.getItem(k); } catch { return null; } },
      set(k, v) { try { win.localStorage.setItem(k, v); } catch { /* per-viewer convenience only */ } },
    };
    const defs = { work: new Map() };
    const services = new Map();
    const live = new Set();
    const el = {
      app: $("app"), side: $("side"), topbar: $("topbar"), chat: $("chat"), inbox: $("inbox"), right: $("right"),
      work: $("work"), workTabs: $("work-tabs"), workBody: $("work-body"),
      gl: $("gutter-left"), gr: $("gutter-right"), sideOpen: $("side-open"), sideClose: $("side-close"), workBtn: $("work-btn"),
      workClose: $("work-close"),
    };
    const ready = !!(el.app && el.right);
    const num = (k) => Number(store.get(k)) || 0;
    const lay = {
      side: num("deck.railW") || 272,
      hidden: store.get("deck.sideHidden") === "1",
      work: num("deck.panelW") || 560,
    };
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    // the right slot: a stored choice, an old Inspector state (Session -> Work › Session, Usage -> the Usage view once),
    // or (first run of the Blend shell) the old panel's open/closed state
    const restored = restoreRight((k) => store.get(k));
    let right = { kind: restored.kind, last: restored.last };
    let pendingView = restored.view;
    let main = "chat";
    let hold = () => false;
    let locked = false; // first run: no right slot, no shortcuts
    const shown = { work: null }; // tab rendered last per kind (scroll resets on a tab change)
    const panes = new Map();

    const visibleTabs = (kind) => sortTabs(kind, [...defs[kind].keys()].filter((id) => {
      const d = defs[kind].get(id);
      try { return !d.visible || d.visible(); } catch { return false; }
    }));
    const activeTab = (kind) => pickTab(right.last[kind], visibleTabs(kind));
    const bodyOf = () => el.workBody;
    const titleOf = (d, id) => {
      try { return String(typeof d.title === "function" ? d.title() : d.title || id); } catch { return id; }
    };

    function persist() {
      store.set("deck.right", right.kind || "");
      store.set("deck.wtab", right.last.work);
      store.set("deck.railW", String(Math.round(lay.side)));
      store.set("deck.sideHidden", lay.hidden ? "1" : "0");
      store.set("deck.panelW", String(Math.round(lay.work)));
    }
    if (store.get("deck.right") === "inspector" || pendingView) persist(); // migrate once: the next start reads the new state

    function applyLayout() {
      if (!ready) return;
      const total = (el.app.getBoundingClientRect && el.app.getBoundingClientRect().width) || win.innerWidth || 1280;
      const sideW = lay.hidden ? 0 : (lay.side = clamp(lay.side, 200, 480));
      const kind = locked ? null : right.kind;
      let rw = 0;
      if (kind) rw = lay[kind] = clamp(lay[kind], 280, Math.max(280, total - sideW - 2 - 380)); // the chat keeps >= 380px
      const rootStyle = doc.documentElement.style;
      rootStyle.setProperty("--rail-w", `${sideW}px`);
      rootStyle.setProperty("--panel-w", `${rw}px`);
      el.app.classList.toggle("side-hidden", lay.hidden);
      doc.body.classList.toggle("side-hidden", lay.hidden);
      el.app.dataset.right = kind || "";
      el.right.hidden = !kind;
      if (el.gr) el.gr.hidden = !kind;
      if (el.work) el.work.hidden = kind !== "work";
      if (el.workBtn) { el.workBtn.setAttribute("aria-pressed", kind === "work" ? "true" : "false"); el.workBtn.hidden = locked; }
      if (el.sideOpen) el.sideOpen.hidden = !lay.hidden;
    }

    // ------------------------------------------------------------ right slot tabs
    function renderTabs(kind) {
      const box = el.workTabs;
      if (!box) return;
      const cur = activeTab(kind);
      box.replaceChildren(...visibleTabs(kind).map((id) => {
        const b = doc.createElement("button");
        b.type = "button";
        b.className = `rtab${live.has(id) ? " lv" : ""}`;
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", id === cur ? "true" : "false");
        b.tabIndex = id === cur ? 0 : -1;
        b.dataset.tab = id;
        b.dataset.fk = `rtab:${kind}:${id}`;
        b.textContent = titleOf(defs[kind].get(id), id);
        b.addEventListener("click", () => api.openRight(kind, id));
        return b;
      }));
    }
    for (const kind of KINDS) {
      const box = el.workTabs;
      if (box) box.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const ids = visibleTabs(kind);
        const next = ids[(ids.indexOf(activeTab(kind)) + d + ids.length) % ids.length];
        if (!next) return;
        api.openRight(kind, next);
        const b = box.querySelector(`[data-tab="${next}"]`);
        if (b) b.focus();
      });
    }
    function paneFor(kind, id) {
      const key = `${kind}:${id}`;
      let p = panes.get(key);
      if (!p) {
        p = doc.createElement("div");
        p.className = "pane rpane";
        p.dataset.tab = id;
        p.setAttribute("role", "tabpanel");
        panes.set(key, p);
      }
      if (p.parentNode !== bodyOf(kind)) bodyOf(kind).appendChild(p);
      return p;
    }
    /**
     * Draw the open tab (and its tab strip). Called on open and whenever the app's render loop marks the panel.
     * Every other tab's pane is detached, as the old panel did: a module root that is not connected (workspace.js,
     * botscreen.js, space-panel.js) stops its live view, and its state survives for the next time it is shown.
     */
    function refresh() {
      if (!ready) return;
      const kind = locked ? null : right.kind;
      const id = kind ? activeTab(kind) : null;
      for (const [key, p] of panes) if (key !== `${kind}:${id}` && p.parentNode) p.parentNode.removeChild(p);
      if (!kind) return;
      renderTabs(kind);
      const d = id ? defs[kind].get(id) : null;
      if (!d) return;
      const body = bodyOf(kind);
      const p = paneFor(kind, id);
      if (hold(body)) return; // typing in a card's inline field: no rebuild under the caret
      const changed = shown[kind] !== id;
      const top = body.scrollTop;
      try {
        d.render(p, { id, kind, shell: api });
      } catch (e) {
        if (win && win.console) win.console.error(`DeckShell tab ${kind}:${id}:`, e);
        p.replaceChildren(api.empty(T("shell.tabFailed"), String((e && e.message) || e)));
      }
      body.scrollTop = changed ? 0 : top;
      shown[kind] = id;
    }

    function setRight(next) {
      const before = `${right.kind}|${right.kind ? activeTab(right.kind) : ""}`;
      right = next;
      persist();
      applyLayout();
      refresh();
      const tab = right.kind ? activeTab(right.kind) : null;
      if (`${right.kind}|${tab || ""}` !== before) emit("right", { kind: right.kind, tab });
    }

    function register(kind, id, def) {
      if (!KINDS.includes(kind) || typeof id !== "string" || !id || !def || typeof def.render !== "function") throw new Error("DeckShell: register(kind, id, {render})");
      if (def.weak && defs[kind].has(id)) return false; // a module already owns this tab
      defs[kind].set(id, def);
      if (def.live !== undefined) api.setTabLive(id, !!def.live);
      if (right.kind === kind) refresh();
      return true;
    }

    // ------------------------------------------------------------ slots
    const SLOTS = {
      capsule: "capsule", inbox: "inbox", timeline: "timeline", "composer-status": "composer-status",
      "crumb-extra": "crumb-extra", "side-extra": "side-extra",
    };
    const mounted = new Set();
    let needs = { count: 0 };
    function renderInboxStub() {
      if (!el.inbox || mounted.has("inbox")) return;
      const box = doc.createElement("div");
      box.className = "inbox-empty";
      const h = doc.createElement("h2");
      h.textContent = T("shell.inboxTitle");
      const p = doc.createElement("p");
      p.textContent = needs.count ? T("shell.inboxCount", { n: needs.count }) : T("shell.inboxNone");
      const back = doc.createElement("button");
      back.type = "button";
      back.className = "btn";
      back.textContent = T("shell.inboxBack");
      back.addEventListener("click", () => api.setMain("chat"));
      box.append(icon(doc, "inbox", 22), h, p, back);
      el.inbox.replaceChildren(box);
    }

    // ------------------------------------------------------------ gutters (drag, keyboard, double-click)
    function gutter(g, side) {
      if (!g) return;
      g.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        g.setPointerCapture(e.pointerId);
        g.classList.add("dragging");
        doc.body.classList.add("dragging-col");
        const box = el.app.getBoundingClientRect();
        const move = (ev) => {
          if (side === "left") {
            const w = ev.clientX - box.left;
            lay.hidden = w < 150; // drag far left to hide the sidebar
            if (!lay.hidden) lay.side = w;
          } else if (right.kind) lay[right.kind] = box.right - ev.clientX;
          applyLayout();
        };
        const up = (ev) => {
          g.releasePointerCapture(ev.pointerId);
          g.classList.remove("dragging");
          doc.body.classList.remove("dragging-col");
          g.removeEventListener("pointermove", move);
          g.removeEventListener("pointerup", up);
          persist();
          emit("sidebar", { hidden: lay.hidden });
        };
        g.addEventListener("pointermove", move);
        g.addEventListener("pointerup", up);
      });
      g.addEventListener("dblclick", () => {
        if (side === "left") { lay.side = 272; lay.hidden = false; } else if (right.kind) lay[right.kind] = 560;
        applyLayout();
        persist();
      });
      g.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
        if (!d) return;
        e.preventDefault();
        if (side === "left") { lay.hidden = false; lay.side += d; } else if (right.kind) lay[right.kind] -= d;
        applyLayout();
        persist();
      });
    }

    // ------------------------------------------------------------ the API
    const api = {
      KINDS, ORDER, FILTERS, legacyTab, channelOf, matchFilter, keyAction, nextRight, pickTab,
      icon: (name, size) => icon(doc, name, size),
      on,
      /** The last value of an event ("session", "mode", "right", "main", "needs", "sidebar"), for late subscribers. */
      last: (ev) => lastEvent.get(ev),
      state: () => ({ main, right: { kind: right.kind, tab: right.kind ? activeTab(right.kind) : null }, sidebarHidden: lay.hidden, session: lastEvent.get("session") || null, mode: lastEvent.get("mode") || null }),
      setMain(kind) {
        const k = kind === "inbox" ? "inbox" : "chat";
        if (!ready) return;
        el.app.dataset.main = k;
        if (k === main) return;
        main = k;
        if (k === "inbox") renderInboxStub();
        emit("main", { kind: k });
      },
      main: () => main,
      openRight(kind, tab) { if (!locked) setRight(nextRight(right, "open", kind, tab)); },
      toggleRight(kind, tab) { if (!locked) setRight(nextRight(right, "toggle", kind, tab)); },
      closeRight() { setRight(nextRight(right, "close")); },
      right: () => ({ kind: right.kind, tab: right.kind ? activeTab(right.kind) : null }),
      isOpen: (kind, tab) => !locked && right.kind === kind && (!tab || activeTab(kind) === tab),
      registerWorkTab: (id, def) => register("work", id, def),
      /** A main-area view an old stored Inspector state asked for ("usage"), handed out once; null otherwise. */
      takeView() { const v = pendingView; pendingView = null; return v; },
      setTabLive(id, on) {
        const was = live.has(id);
        if (on) live.add(id); else live.delete(id);
        if (was !== !!on && right.kind) renderTabs(right.kind);
      },
      /** Re-draw the open tab; a tab whose visible() turned false falls back to the first visible one. */
      refresh,
      /** Put a module's element into a named slot (null clears it). Returns the slot element. */
      mount(name, node) {
        const id = SLOTS[name];
        const s = id ? $(id) : null;
        if (!s) throw new Error(`DeckShell: unknown slot "${name}"`);
        s.replaceChildren(...(node ? [node] : []));
        if (node) mounted.add(name); else mounted.delete(name);
        if (name !== "inbox" && name !== "capsule") s.hidden = !node;
        if (name === "inbox" && !node && main === "inbox") renderInboxStub();
        return s;
      },
      slot: (name) => (SLOTS[name] ? $(SLOTS[name]) : null),
      empty(title, body) {
        const box = doc.createElement("div");
        box.className = "sh-empty";
        const b = doc.createElement("b");
        b.textContent = title || "";
        box.appendChild(b);
        if (body) box.appendChild(doc.createTextNode(body));
        return box;
      },
      toggleSidebar() {
        lay.hidden = !lay.hidden;
        applyLayout();
        persist();
        emit("sidebar", { hidden: lay.hidden });
      },
      sidebarHidden: () => lay.hidden,
      /** Objects app.js shares with later modules (see contracts.md): "h", "workspace", "botscreen", "openSettings", "chat". */
      service: (name) => (services.has(name) ? services.get(name) : null),
      // ---- for app.js only
      /** app.js: publish "session" / "mode" / "needs"; a value equal to the last one is not sent again. */
      publish(ev, detail) {
        if (ev === "session" || ev === "mode" || ev === "needs") {
          const key = JSON.stringify(detail);
          if (lastEvent.has(ev) && JSON.stringify(lastEvent.get(ev)) === key) return;
        }
        if (ev === "needs") {
          needs = detail || { count: 0 };
          if (main === "inbox") renderInboxStub();
        }
        emit(ev, detail);
      },
      setHold(fn) { hold = typeof fn === "function" ? fn : () => false; },
      provide(name, value) {
        services.set(name, value);
        emit("service", { name });
      },
      setLocked(v) {
        if (locked === !!v) return;
        locked = !!v;
        applyLayout();
        refresh();
      },
      applyLayout,
      activeBody: () => (right.kind ? bodyOf(right.kind) : null),
    };
    if (!ready) return api;

    // the four work tabs a later module fills (Run, Plan, Diff, Agents): calm empty states until then
    const stub = (id, title, head, body) =>
      register("work", id, { title: () => T(title), render: (p) => { if (!p.firstChild) p.appendChild(api.empty(T(head), T(body))); } });
    stub("run", "shell.tab.run", "shell.empty.runTitle", "shell.empty.runBody");
    stub("plan", "shell.tab.plan", "shell.empty.planTitle", "shell.empty.planBody");
    stub("diff", "shell.tab.diff", "shell.empty.diffTitle", "shell.empty.diffBody");
    stub("agents", "shell.tab.agents", "shell.empty.agentsTitle", "shell.empty.agentsBody");

    // icons of the frame's buttons (index.html keeps no inline SVG)
    const ICON_OF = { "side-close": "side", "side-open": "side", "work-btn": "work", "work-close": "x" };
    for (const [id, name] of Object.entries(ICON_OF)) { const b = $(id); if (b && !b.firstChild) b.appendChild(icon(doc, name, 16)); }
    const find = $("find-btn");
    if (find) find.prepend(icon(doc, "search", 14));
    const kbd = $("find-kbd");
    if (kbd && /Mac/i.test((win.navigator && win.navigator.platform) || "")) kbd.textContent = "\u2318K";
    const mark = doc.querySelector(".brand-mark");
    if (mark && !mark.firstChild) mark.appendChild(icon(doc, "hermes", 18));

    gutter(el.gl, "left");
    gutter(el.gr, "right");
    const click = (node, fn) => { if (node) node.addEventListener("click", fn); };
    click(el.sideOpen, () => api.toggleSidebar());
    click(el.sideClose, () => api.toggleSidebar());
    click(el.workBtn, () => api.toggleRight("work"));
    click(el.workClose, () => api.closeRight());
    doc.addEventListener("keydown", (e) => {
      const a = keyAction(e);
      if (!a) return;
      e.preventDefault();
      if (a === "sidebar") return api.toggleSidebar();
      if (locked) return;
      if (a === "work") return api.toggleRight("work");
      // Ctrl+Alt+I: the Work pane on its Session tab (again: closes it)
      if (a === "session") return api.toggleRight("work", api.isOpen("work", "session") ? undefined : "session");
      // Ctrl+J: the fleet capsule's panel when a module listens, else the Usage view (app.js's usageView service)
      if (listeners.has("fleet") && listeners.get("fleet").size) emit("fleet", {});
      else { const view = services.get("usageView"); if (view && typeof view.toggle === "function") view.toggle(); }
    });
    doc.addEventListener("deck-language", () => {
      if (right.kind) renderTabs(right.kind);
      if (main === "inbox") renderInboxStub();
    });
    win.addEventListener("resize", applyLayout);
    el.app.dataset.main = main;
    applyLayout();
    return api;
  }

  return { create, KINDS, ORDER, FILTERS, DEFAULT_TAB, legacyTab, restoreRight, nextRight, pickTab, sortTabs, keyAction, channelOf, matchFilter, sourceName, ICONS };
});
