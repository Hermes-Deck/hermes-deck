"use strict";
var i18nNode = (key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).node(key, vars, typeof document === "object" ? document : null);
var i18nBind = (el, attr, key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).bind(el, attr, key, vars);
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
var i18nLocale = typeof module === "object" && module.exports ? require("./i18n").getLocale : window.DeckI18n.getLocale;
// Workspace tab (renderer): the selected agent's own browser, live. Loaded before app.js, which calls
// window.DeckWorkspace(ctx) once and mounts the returned root in the right panel; the root then updates
// itself (frames arrive several times a second and must not rebuild the panel). Every string from the
// agent's browser goes in through textContent. Main side: main/workspace.js; styles: workspace.css.
// The browser runs on this computer or on the agent host (the relay's machine). The header pill says where
// and opens the host picker ("Otomatik" / "Bu bilgisayar" / the agent host), which the relay keeps per agent.
// The view follows the page the agent works on; a tab the user picks pauses that until the agent opens or
// navigates a page. A closed page stays on screen as "Last seen", with the agent's recent steps below.
window.DeckWorkspace = function DeckWorkspace(ctx) {
  const { h, deck } = ctx;
  const api = deck.workspace;
  const WR = window.DeckWsRelay; // ws-relay.js: relay link + devices snapshot -> the menu's reasons
  const VW = window.DeckWsView; // ws-view.js: stream size, resize debounce, pointer -> page mapping, the expand shortcut
  const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  const ACTIVE_MS = 15_000; // "the agent is using it" = a real command in the last 15 s
  const RECENT_MS = 60_000; // other agents used their browser this recently: marked in the selector

  const W = {
    st: null, // main/workspace.js state()
    devices: null, // relay {t:"devices"}: where agent work runs, the user's pins (relay/src/presence.js)
    link: null, // this deck's relay socket {status, error, since}: the title bar's source (ws-relay.js)
    browsers: new Map(), // slug -> this computer's browser info
    remote: new Map(), // slug -> the agent host's browser info (relay {t:"ws-browsers"})
    remoteHost: null,
    slug: null, // the agent shown
    picked: false, // chosen in this tab (else it follows the open chat)
    lastPref: undefined,
    watching: null,
    viewKind: null, // "local" | "remote": where the live view runs (main says)
    tabs: [],
    follow: true, // false: the user picked a tab
    lastSeen: null, // {url, title, at}: the page on screen closed
    wall: null, // {url, title, at}: the page on screen is a robot check
    hidden: false, // the page on screen is a background tab: it paints nothing until it comes forward
    viewError: null,
    hasFrame: false,
    msg: null,
    menu: false, // the host picker is open
    sceneDone: false, // screenshot scene "host": open the picker once
    expanded: false, // the large view: the stage covers the chat and the panel (this window only, never saved)
  };

  const ago = (ms) => {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return i18nText("U0594");
    if (s < 3600) return i18nText("U0403", { v: Math.round(s / 60) });
    if (s < 86400) return i18nText("U0404", { v: Math.round(s / 3600) });
    return i18nText("U0405", { v: Math.round(s / 86400) });
  };
  const clock = (ms) => new Date(ms).toLocaleTimeString(i18nLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const shortUrl = (u) => {
    const s = String(u || "").replace(/^https?:\/\/(www\.)?/i, "");
    return s.length > 70 ? `${s.slice(0, 69)}…` : s;
  };
  const siteOf = (u) => {
    try {
      return new URL(u).host || shortUrl(u);
    } catch {
      return shortUrl(u);
    }
  };
  const VERBS = () => [
    [/^Page\.(navigate|reload|navigateToHistoryEntry)$/, i18nText("U0906")],
    [/^Input\.dispatchMouseEvent$/, i18nText("U0907")],
    [/^Input\.(dispatchKeyEvent|insertText|imeSetComposition)$/, i18nText("U0908")],
    [/^Page\.captureScreenshot$/, i18nText("U0909")],
    [/^Target\.createTarget$/, i18nText("U0910")],
    [/^Target\.closeTarget$/, i18nText("U0911")],
    [/^(Runtime|DOM|DOMSnapshot|Accessibility|CSS)\./, i18nText("U0912")],
  ];
  const verb = (m) => (VERBS().find(([re]) => re.test(m || "")) || [null, null])[1];
  const TRAIL_VERB = { get open() { return i18nText("U0913"); }, nav: "gitti", get close() { return i18nText("U0914"); } };

  // ---------------------------------------------------------------- DOM (built once)
  const sel = h("select", {
    class: "ws-agent",
    "aria-label": i18nText("A0185"),
    onchange: () => {
      W.slug = sel.value;
      W.picked = true;
      update();
    },
   "data-i18n-aria-label": "A0185"});
  const whereEl = h("button", {
    class: "ws-where",
    type: "button",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    onclick: () => {
      W.menu = !W.menu;
      renderMenu();
    },
  });
  const menu = h("div", { class: "ws-menu", role: "menu", "aria-label": i18nText("U0915") , "data-i18n-aria-label": "U0915"});
  menu.hidden = true;
  // Expand / Collapse: drawn corner arrows (one stroke weight, like the other toolbar glyphs)
  const svgIcon = (...paths) => {
    const ns = "http://www.w3.org/2000/svg";
    const s = document.createElementNS(ns, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) s.setAttribute(k, v);
    for (const d of paths) {
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", d);
      s.append(p);
    }
    return s;
  };
  const ICON_EXPAND = ["M10 2h4v4", "M14 2l-4.5 4.5", "M6 14H2v-4", "M2 14l4.5-4.5"];
  const ICON_COLLAPSE = ["M14 6h-4V2", "M10 6l4-4", "M2 10h4v4", "M6 10l-4 4"];
  const expandBtn = h("button", { class: "ws-expand", type: "button", "aria-pressed": "false", onclick: () => setExpanded(!W.expanded) });
  const shortcutLabel = () => (/mac|iphone|ipad/i.test((typeof navigator === "object" && navigator.platform) || "") ? "⌘⇧F" : "Ctrl+Shift+F");
  const tabsEl = h("div", { class: "ws-tabs", role: "tablist", "aria-label": i18nText("A0375") , "data-i18n-aria-label": "A0375"});
  const followEl = h("span", { class: "ws-follow" });
  const navBtn = (label, key, fn) => h("button", { class: "ws-nav", type: "button", title: i18nText(key), "data-i18n-title": key, "aria-label": i18nText(key), "data-i18n-aria-label": key, onclick: fn }, label);
  const back = navBtn("‹", "A0340", () => call(() => api.history(W.slug, -1)));
  const fwd = navBtn("›", "U0776", () => call(() => api.history(W.slug, 1)));
  const reload = navBtn("↻", "A0376", () => call(() => api.reload(W.slug)));
  const url = h("input", { class: "ws-url", type: "text", spellcheck: "false", autocomplete: "off", "aria-label": i18nText("A0236") , "data-i18n-aria-label": "A0236"});
  url.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = url.value;
      url.blur();
      call(() => api.navigate(W.slug, v));
    } else if (e.key === "Escape") {
      url.value = shownTab() ? shownTab().url : "";
      url.blur();
    }
  });
  const newTab = h("button", { class: "ws-newtab", type: "button", title: i18nText("A0377"), onclick: () => call(() => api.newTab(W.slug)) , "data-i18n-title": "A0377"}, i18nNode("A0378"));
  const wallEl = h("div", { class: "ws-wall", role: "alert" });
  const canvas = h("canvas", { class: "ws-view", tabindex: "0", width: "1280", height: "800", "aria-label": i18nText("U0916") , "data-i18n-aria-label": "U0916"});
  const seenEl = h("div", { class: "ws-seen", role: "status" });
  const overlay = h("div", { class: "ws-overlay" });
  const stage = h("div", { class: "ws-stage" }, canvas, seenEl, overlay);
  const statusEl = h("p", { class: "ws-status", role: "status" });
  const control = h("button", { class: "btn primary ws-control", type: "button", onclick: () => toggleControl() });
  const transferButton = h("button", { class: "btn", type: "button", onclick: () => call(() => handoffDialog(W.slug)) }, i18nNode("transfer.button"));
  const msgEl = h("p", { class: "ws-msg", role: "alert" });
  const trailEl = h("section", { class: "ws-trail", "aria-label": i18nText("U0917") , "data-i18n-aria-label": "U0917"});
  const note = h("p", { class: "ws-note" });
  const tabRow = h("div", { class: "ws-tabrow" }, tabsEl, followEl, newTab);
  const bar = h("div", { class: "ws-bar" }, back, fwd, reload, url);
  const root = h(
    "div",
    { class: "ws" },
    h("div", { class: "ws-head" }, sel, whereEl, expandBtn, menu),
    tabRow,
    bar,
    wallEl,
    stage,
    h("div", { class: "ws-foot" }, statusEl, transferButton, control),
    msgEl,
    trailEl,
    note
  );
  const g = canvas.getContext("2d");

  // ---------------------------------------------------------------- derived state
  const me = () => (W.st && W.st.device ? W.st.device.id : null);
  const deviceName = (id) => {
    const d = W.devices && (W.devices.devices || []).find((x) => x.id === id);
    return d ? d.name : i18nText("U0918");
  };
  /** The agent host's name ("Home server"), from the relay. */
  const hostName = () =>
    (W.devices && W.devices.agentHost && W.devices.agentHost.name) || W.remoteHost || (W.devices && W.devices.fallback && W.devices.fallback.browser && W.devices.fallback.browser.name) || i18nText("A0379");
  // the agent host can run THIS agent's browser (an attached external browser serves only some agents: fallback.agents)
  const fallbackOn = () => {
    const fb = W.devices && W.devices.fallback && W.devices.fallback.browser;
    return !!fb && (!Array.isArray(fb.agents) || fb.agents.includes(W.slug));
  };
  // "Otomatik" puts the browser on the agent host first (relay DECK_BROWSER_DEFAULT=host, the default)
  const hostFirst = () => !!W.devices && !(W.devices.defaults && W.devices.defaults.browser === "device");

  /** The relay's route for this agent's browser, if any. */
  function route() {
    const routes = (W.devices && W.devices.routes) || [];
    return routes.find((r) => r.capability === "browser" && r.sessionKey === W.slug) || null;
  }
  /** The user's pin for this agent's browser, if any (none = "Otomatik"). */
  function pin() {
    const pins = (W.devices && W.devices.pins) || [];
    return pins.find((p) => p.capability === "browser" && p.sessionKey === W.slug && p.host) || null;
  }
  /** "auto" | "here" | "agent-host" | "device" (pinned to another computer). */
  function pref() {
    const p = pin();
    if (!p) return "auto";
    if (p.host.kind === "fallback") return "agent-host";
    return p.host.id === me() ? "here" : "device";
  }

  /** Where this agent's browser is (same rules as main/workspace.js sourceFor): {kind, info, name?}. */
  function src() {
    if (!W.slug) return { kind: null, info: null };
    const loc = W.browsers.get(W.slug) || null;
    const rem = W.remote.get(W.slug) || null;
    const r = route();
    if (r && r.host) {
      if (r.host.kind === "fallback") return { kind: "remote", info: rem };
      if (r.host.id === me()) return { kind: "local", info: loc };
      return { kind: "other", info: null, name: r.host.name || deviceName(r.host.id) };
    }
    if (hostFirst() && fallbackOn() && rem && rem.status === "running") return { kind: "remote", info: rem };
    if (loc && loc.status === "running") return { kind: "local", info: loc };
    if (rem && rem.status === "running") return { kind: "remote", info: rem };
    if (pref() === "agent-host") return { kind: "remote", info: rem };
    return { kind: "local", info: loc };
  }
  const info = () => src().info;
  const running = () => !!info() && info().status === "running";
  const live = () => running() && W.watching === W.slug && !!W.viewKind;
  const userHas = () => running() && info().controller === "user";
  const shownTab = () => W.tabs.find((t) => t.shown) || null;

  function agentOptions() {
    const list = [];
    const add = (slug, name) => {
      if (SLUG_RE.test(slug) && !list.some((x) => x.slug === slug)) list.push({ slug, name });
    };
    for (const a of ctx.agents()) add(String(a.profile || "").toLowerCase(), a.name || String(a.profile || "").toLowerCase());
    for (const slug of W.browsers.keys()) add(slug, slug);
    for (const slug of W.remote.keys()) add(slug, slug);
    if (W.st && W.st.demo) add(W.st.demo, W.st.demo);
    // another agent used its browser a moment ago: say so (its activity is not on screen)
    return list.map((o) => {
      const b = W.browsers.get(o.slug) || W.remote.get(o.slug);
      const hot = !!b && b.lastAgentAt && Date.now() - b.lastAgentAt < RECENT_MS;
      return { ...o, hot };
    });
  }

  function chooseSlug(opts) {
    const has = (s) => !!s && opts.some((o) => o.slug === s);
    const pref = ctx.preferred ? String(ctx.preferred() || "").toLowerCase() || null : null;
    if (pref !== W.lastPref) {
      W.lastPref = pref; // a different chat: follow it again
      W.picked = false;
    }
    if (W.picked && has(W.slug)) return W.slug;
    if (W.st && has(W.st.demo)) return W.st.demo;
    if (has(pref)) return pref;
    if (has(W.slug)) return W.slug;
    return opts[0] ? opts[0].slug : null;
  }

  /** Where the agent's browser is now, for the pill at the top right. */
  function whereNow() {
    const s = src();
    if (s.kind === "other") return { text: s.name, cls: "away" };
    if (running()) return { text: s.kind === "remote" ? hostName() : i18nText("A0380"), cls: "here" };
    if (s.kind === "remote") return { text: hostName(), cls: "away" };
    return { text: i18nText("U0919"), cls: "off" };
  }

  /** Where it would open if the agent started now. */
  function whereNext() {
    if (!W.devices) return null;
    const p = pin();
    if (p) {
      if (p.host.kind === "fallback") return i18nText("U0920", { v: hostName() });
      if (p.host.id === me()) return i18nText("U0921");
      return i18nText("U0920", { v: p.host.name || deviceName(p.host.id) });
    }
    if (hostFirst() && fallbackOn()) return i18nText("U0920", { v: hostName() });
    const id = W.devices.active && W.devices.active.browser;
    if (id && id === me()) return i18nText("U0921");
    if (id) return i18nText("U0922", { id: deviceName(id) });
    if (fallbackOn()) return i18nText("U0920", { v: hostName() });
    return i18nText("U0923");
  }

  // ---------------------------------------------------------------- render (in place)
  function update() {
    const opts = agentOptions();
    W.slug = chooseSlug(opts);
    if (W.st && /^host/.test(W.st.scene || "") && !W.sceneDone && W.devices) {
      W.sceneDone = true; // screenshot scene: the picker open
      W.menu = true;
    }
    renderSelect(opts);
    renderWhere();
    renderExpand();
    renderMenu();
    renderTabs();
    renderBar();
    renderWall();
    renderStage();
    renderFoot();
    renderTrail();
    sync();
  }

  function renderSelect(opts) {
    const key = JSON.stringify([opts, W.slug]);
    if (sel.dataset.key === key || document.activeElement === sel) return;
    sel.dataset.key = key;
    const label = (o) => (o.hot && o.slug !== W.slug ? i18nText("A0381", { name: o.name }) : o.name);
    sel.replaceChildren(...(opts.length ? opts.map((o) => h("option", { value: o.slug, selected: o.slug === W.slug ? true : null }, label(o))) : [h("option", { value: "" }, i18nNode("A0382"))]));
    sel.value = W.slug || "";
    sel.disabled = !opts.length;
  }

  function renderWhere() {
    const wn = whereNow();
    const p = pref();
    whereEl.className = `ws-where ${wn.cls}${W.menu ? " open" : ""}`;
    whereEl.disabled = !W.slug;
    whereEl.setAttribute("aria-expanded", W.menu ? "true" : "false");
    i18nBind(whereEl, "title", "U0924", { v: p === "auto" ? i18nText("A0383") : i18nText("common.pinned") });
    whereEl.replaceChildren(h("span", { class: "dot", "aria-hidden": "true" }), h("span", { class: "now" }, wn.text), h("span", { class: "pref" }, p === "auto" ? i18nNode("A0383") : i18nNode("A0384")), h("span", { class: "caret", "aria-hidden": "true" }, "▾"));
  }

  /** The large view: the button's icon, label and pressed state follow the mode. */
  function renderExpand() {
    const on = W.expanded;
    root.classList.toggle("expanded", on);
    expandBtn.setAttribute("aria-pressed", on ? "true" : "false");
    expandBtn.disabled = !W.slug;
    expandBtn.replaceChildren(svgIcon(...(on ? ICON_COLLAPSE : ICON_EXPAND)));
    const vars = { key: shortcutLabel() };
    i18nBind(expandBtn, "title", on ? "ws.collapseTip" : "ws.expandTip", vars);
    i18nBind(expandBtn, "aria-label", on ? "ws.collapse" : "ws.expand");
  }

  /** Large view on or off. Nothing else changes: the same canvas, input forwarding and control; only the box grows. */
  function setExpanded(on, { focus = true } = {}) {
    on = !!on && !!W.slug;
    if (on === W.expanded) return;
    W.expanded = on;
    W.menu = false;
    renderExpand();
    renderMenu();
    stageSized(); // the stream follows the new size (debounced)
    if (focus) (userHas() && live() ? canvas : expandBtn).focus();
  }

  /** The host picker: Otomatik, this computer, the agent host (disabled with the reason when it cannot host). */
  function renderMenu() {
    menu.hidden = !W.menu || !W.slug;
    whereEl.classList.toggle("open", !menu.hidden);
    whereEl.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
    if (menu.hidden) return menu.replaceChildren();
    const cur = pref();
    const name = hostName();
    const rr = WR.reason({ link: W.link, devices: W.devices });
    const relayWhy = rr ? i18nText(rr.key) : null;
    const hereWhy = W.st && !W.st.browser ? i18nText("A0385") : W.st && !W.st.allowed ? i18nText("U0926") : null;
    const items = [
      { where: "auto", label: i18nText("A0383"), desc: fallbackOn() ? (hostFirst() ? i18nText("workspace.autoHost", { name: name }) : i18nText("U0927", { name: name })) : i18nText("U0928"), why: relayWhy },
      { where: "here", label: i18nText("A0380"), desc: W.st && W.st.device ? W.st.device.name : "", why: relayWhy || hereWhy },
      { where: "agent-host", label: name, desc: i18nText("U0929"), why: relayWhy || (fallbackOn() ? null : i18nText("U0930")) },
    ];
    if (cur === "device") items.push({ where: "device", label: pin().host.name || i18nText("U0931"), desc: i18nText("U0932"), why: "", fixed: true });
    menu.replaceChildren(
      h("p", { class: "ws-menu-title" }, i18nNode("U0933")),
      ...items.map((it) => {
        const on = cur === it.where;
        const b = h(
          "button",
          {
            class: `ws-opt${on ? " on" : ""}`,
            type: "button",
            role: "menuitemradio",
            "aria-checked": on ? "true" : "false",
            disabled: it.why || it.fixed ? true : null,
            onclick: () => {
              W.menu = false;
              renderMenu();
              renderWhere();
              if (!on) call(() => api.setHost(W.slug, it.where));
            },
          },
          h("span", { class: "radio", "aria-hidden": "true" }),
          h("span", { class: "txt" }, h("span", { class: "label" }, it.label), it.desc ? h("span", { class: "desc" }, it.desc) : null, it.why ? h("span", { class: "why" }, it.why) : null)
        );
        return b;
      }),
      h("p", { class: "ws-menu-note" }, i18nNode("U0934"))
    );
  }

  function renderTabs() {
    const on = live();
    tabsEl.replaceChildren(
      ...(on ? W.tabs : []).map((t) => {
        const label = t.title || t.url || i18nText("A0377");
        return h(
          "span",
          { class: `ws-tab${t.shown ? " shown" : ""}`, role: "presentation" },
          h("button", { class: "ws-tabbtn", type: "button", role: "tab", "aria-selected": t.shown ? "true" : "false", title: t.url, onclick: () => call(() => api.selectTab(W.slug, t.id)) }, label),
          userHas() ? h("button", { class: "ws-tabx", type: "button", title: i18nText("A0386"), "aria-label": i18nText("A0387", { label: label }), onclick: () => call(() => api.closeTab(W.slug, t.id)) , "data-i18n-title": "A0386", "data-i18n-aria-label": "A0387", "data-i18n-aria-label-vars": JSON.stringify({ label: label })}, "×") : null
        );
      })
    );
    tabRow.hidden = !on; // tabs and the address bar only exist for a live browser
    bar.hidden = !on;
    newTab.disabled = !userHas();
    newTab.title = userHas() ? i18nText("A0377") : i18nText("U0935");
    renderFollow();
  }

  /** Following the agent, paused by a tab the user picked, or off while the user drives. */
  function renderFollow() {
    followEl.hidden = !live();
    if (followEl.hidden) return followEl.replaceChildren();
    if (userHas()) {
      followEl.className = "ws-follow off";
      i18nBind(followEl, "title", "U0936");
      return followEl.replaceChildren(i18nText("U0937"));
    }
    if (!W.follow) {
      followEl.className = "ws-follow paused";
      i18nBind(followEl, "title", "U0938");
      return followEl.replaceChildren(i18nText("U0939"), h("button", { class: "ws-followbtn", type: "button", onclick: () => call(() => api.follow(W.slug)) }, i18nNode("U0940")));
    }
    followEl.className = "ws-follow on";
    i18nBind(followEl, "title", "U0941");
    followEl.replaceChildren(h("span", { class: "dot", "aria-hidden": "true" }), shownTab() ? i18nText("U0942") : i18nText("U0943"));
  }

  function renderBar() {
    const on = live();
    const mine = userHas();
    for (const b of [back, fwd, reload]) b.disabled = !mine;
    url.readOnly = !mine;
    url.disabled = !on;
    url.placeholder = mine ? i18nText("A0388") : i18nText("U0944");
    if (document.activeElement !== url) url.value = on && shownTab() ? shownTab().url : on && W.lastSeen ? W.lastSeen.url : "";
  }

  /** A robot check on the agent's page: the user takes control and solves it (nothing here solves it). */
  function renderWall() {
    const b = info();
    const w = running() ? W.wall || (b && b.wall) || null : null;
    wallEl.hidden = !w;
    if (!w) return wallEl.replaceChildren();
    const mine = userHas();
    wallEl.replaceChildren(
      h("span", { class: "ic", "aria-hidden": "true" }, "!"),
      h(
        "span",
        { class: "txt" },
        h("strong", null, i18nNode("U0339")),
        i18nNode("U0945", { url: siteOf(w.url), v: mine ? i18nText("U0946") : i18nText("U0947") })
      ),
      mine ? null : h("button", { class: "btn mini", type: "button", onclick: () => takeForWall(w) }, i18nNode("U0764"))
    );
  }

  function takeForWall(w) {
    call(async () => {
      const t = W.tabs.find((x) => x.url === w.url);
      if (t && !t.shown) await api.selectTab(W.slug, t.id);
      const r = await api.control(W.slug, "user");
      canvas.focus();
      return r;
    });
  }

  function overlayMsg(title, text, action) {
    overlay.hidden = false;
    overlay.replaceChildren(h("div", { class: "ws-card" }, title ? h("h3", null, title) : null, text ? h("p", null, text) : null, action || null));
  }

  /** "Last seen": the shown page closed; its last frame stays under this strip. */
  function renderSeen() {
    const s = live() && W.lastSeen && !shownTab() && W.hasFrame ? W.lastSeen : null;
    seenEl.hidden = !s;
    if (!s) return seenEl.replaceChildren();
    seenEl.replaceChildren(
      h("span", { class: "tag" }, i18nNode("U0948")),
      h("span", { class: "title" }, s.title || siteOf(s.url)),
      h("span", { class: "url" }, shortUrl(s.url)),
      h("span", { class: "when" }, i18nNode("U0949", { at: ago(s.at) }))
    );
  }

  const startBtn = (where, label) => h("button", { class: "btn", type: "button", onclick: () => call(() => api.start(W.slug, where)) }, label);

  function renderStage() {
    const st = W.st;
    const s = src();
    const b = s.info;
    stage.classList.toggle("user", userHas());
    stage.classList.toggle("blank", !(live() && W.hasFrame));
    renderSeen();
    if (!st) return overlayMsg(null, i18nText("U0389"));
    if (!W.slug) return overlayMsg(i18nText("U0950"), i18nText("U0951"));
    if (s.kind === "other") {
      return overlayMsg(i18nText("U0952"), i18nText("U0953", { name: s.name }));
    }
    if (s.kind === "remote") {
      if (b && b.status === "starting") return overlayMsg(null, i18nText("U0954", { v: hostName() }));
      if (b && b.status === "error") return overlayMsg(i18nText("U0955"), b.error || "", startBtn("agent-host", i18nText("A0221")));
      if (!running()) return overlayMsg(i18nText("U0956", { v: hostName() }), i18nText("U0957"), startBtn("agent-host", i18nText("U0958", { v: hostName() })));
    } else {
      if (!st.allowed && !running()) {
        return overlayMsg(
          i18nText("U0959"),
          fallbackOn()
            ? i18nText("U0960", { v: hostName() })
            : i18nText("U0961"),
          h("button", { class: "btn", type: "button", onclick: () => ctx.openSettings() }, i18nNode("U0962"))
        );
      }
      if (!st.browser && !running()) return overlayMsg(i18nText("U0963"), i18nText("U0964"));
      if (b && b.status === "starting") return overlayMsg(null, i18nText("U0965"));
      if (b && b.status === "error") return overlayMsg(i18nText("U0955"), b.error || "", startBtn(null, i18nText("A0221")));
      if (!running()) return overlayMsg(i18nText("U0966"), whereNext() || i18nText("U0967"), startBtn(null, i18nText("U0968")));
    }
    if (W.viewError && !W.hasFrame) return overlayMsg(i18nText("U0969"), err(W.viewError));
    // a tab picked while the agent drives stays in the background (bringing it forward would hide the agent's tab)
    if (W.hidden && shownTab()) return overlayMsg(i18nText("A0389"), i18nText("U0970"));
    if (!W.hasFrame) {
      if (W.lastSeen) return overlayMsg(i18nText("U0948"), i18nText("U0971", { v: W.lastSeen.title || shortUrl(W.lastSeen.url), at: ago(W.lastSeen.at) }));
      return overlayMsg(null, i18nText("U0972"));
    }
    overlay.hidden = true;
    overlay.replaceChildren();
  }

  function renderFoot() {
    const s = src();
    const b = s.info;
    let cls = "";
    let text;
    if (!W.st || !W.slug) text = "";
    else if (s.kind === "other") text = i18nText("U0973", { name: s.name });
    else if (!running()) {
      text = whereNext() || "";
      if (text.startsWith(i18nText("U0974"))) cls = "warn";
    } else if (b.controller === "user") {
      cls = "warn";
      text = i18nText("U0975");
    } else if (b.lastAgentAt && Date.now() - b.lastAgentAt < ACTIVE_MS) {
      cls = "live";
      const v = verb(b.lastAgentMethod);
      text = i18nText("U0976", { v: v ? ` · ${v}` : "" });
    } else if (b.agentChannels > 0) text = b.lastAgentAt ? i18nText("U0977", { lastAgentAt: ago(b.lastAgentAt) }) : i18nText("U0978");
    else if (b.lastAgentAt) text = i18nText("U0979", { lastAgentAt: ago(b.lastAgentAt) });
    else text = i18nText("U0980");
    statusEl.className = `ws-status ${cls}`;
    statusEl.replaceChildren(...(text ? [h("span", { class: "dot", "aria-hidden": "true" }), text] : []));
    control.hidden = !running() || s.kind === "other";
    transferButton.disabled = !W.slug || !(route() || running());
    control.textContent = userHas() ? i18nText("A0327") : i18nText("U0764");
    control.classList.toggle("primary", !userHas());
    control.title = userHas() ? i18nText("U0981") : i18nText("U0982");
    msgEl.textContent = W.msg || "";
    msgEl.hidden = !W.msg;
    note.textContent = running()
      ? userHas()
        ? i18nText("U0983")
        : s.kind === "remote"
          ? i18nText("U0984", { v: hostName() })
          : i18nText("U0985")
      : "";
  }

  /** The agent's recent steps in this browser (kept while nobody watched). */
  function renderTrail() {
    const b = info();
    const list = b && Array.isArray(b.trail) ? b.trail.slice(-6).reverse() : [];
    trailEl.hidden = !list.length || src().kind === "other";
    if (trailEl.hidden) return trailEl.replaceChildren();
    trailEl.replaceChildren(
      h("h4", null, i18nNode("U0986")),
      h(
        "ol",
        null,
        ...list.map((e) =>
          h(
            "li",
            { class: `k-${e.kind}`, title: e.url },
            h("time", null, clock(e.at)),
            h("span", { class: "verb" }, TRAIL_VERB[e.kind] || ""),
            h("span", { class: "what" }, h("span", { class: "t" }, e.title || siteOf(e.url)), h("span", { class: "u" }, shortUrl(e.url)))
          )
        )
      )
    );
  }

  // ---------------------------------------------------------------- watching (only while visible)
  function visible() {
    // getClientRects: offsetParent is null for the expanded (position: fixed) view too
    if (!root.isConnected || root.getClientRects().length === 0) return false;
    return document.visibilityState !== "hidden" || !!(W.st && W.st.demo);
  }

  // The screencast follows the stage: a new size (expand, collapse, panel gutter, window resize) is asked for once the
  // burst is over (~300 ms), on the running stream, so the picture never blanks. main/workspace.js "ws:resize".
  const resizer = VW.createResizer((size) => {
    if (W.watching) api.resize(W.watching, size).catch(() => {});
  });
  const stageSize = () => VW.streamSize({ width: stage.offsetWidth, dpr: window.devicePixelRatio || 1, large: W.expanded });
  function stageSized() {
    if (W.watching) resizer.observe(stageSize());
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(stageSized).observe(stage);

  function resetView() {
    W.hasFrame = false;
    W.tabs = [];
    W.viewError = null;
    W.follow = true;
    W.lastSeen = null;
    W.wall = null;
    W.hidden = false;
    clearCanvas();
  }

  function sync() {
    const want = W.st && W.slug && visible() ? W.slug : null;
    if (want === W.watching) return;
    W.watching = want;
    W.viewKind = null;
    resetView();
    if (want) {
      const size = stageSize();
      resizer.start(size); // later size changes are compared with what the watch itself asked for
      api.watch(want, size).then(applyState).catch(() => {});
    } else {
      resizer.stop();
      api.unwatch().catch(() => {});
    }
  }

  function clearCanvas() {
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--obsidian").trim() || "#0d0e10";
    g.fillRect(0, 0, canvas.width, canvas.height);
  }

  // ---------------------------------------------------------------- frames
  let decoding = false;
  let pending = null;
  async function paint() {
    decoding = true;
    while (pending) {
      const m = pending;
      pending = null;
      try {
        const bmp = await createImageBitmap(new Blob([m.data], { type: "image/jpeg" }));
        if (m.slug === W.watching) {
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas.width = bmp.width;
            canvas.height = bmp.height;
          }
          g.drawImage(bmp, 0, 0);
          if (!W.hasFrame) {
            W.hasFrame = true;
            renderStage();
          }
        }
        bmp.close();
      } catch {
        /* a broken frame: the next one replaces it */
      }
    }
    decoding = false;
  }

  // ---------------------------------------------------------------- the user's input (only with control)
  // 0..1 on the page: relative to the picture itself, not the canvas box (the large view letterboxes the picture)
  const norm = (e) => {
    const p = VW.mapPoint(e.clientX, e.clientY, canvas.getBoundingClientRect(), canvas.width, canvas.height);
    return { x: p.x, y: p.y };
  };
  const onPicture = (e) => VW.mapPoint(e.clientX, e.clientY, canvas.getBoundingClientRect(), canvas.width, canvas.height).inside;
  const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  const BTN = ["left", "middle", "right", "back", "forward"];
  const input = (ev) => api.input(W.slug, ev);
  let lastClick = { t: 0, x: 0, y: 0, n: 0 };
  let moveEv = null;
  let wheelEv = null;
  let frameReq = 0;
  const flushMoves = () => {
    frameReq = 0;
    if (moveEv) input(moveEv);
    if (wheelEv) input(wheelEv);
    moveEv = null;
    wheelEv = null;
  };
  const later = () => {
    if (!frameReq) frameReq = requestAnimationFrame(flushMoves);
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (!userHas()) return;
    e.preventDefault();
    canvas.focus();
    if (!onPicture(e)) return; // a click in the empty band beside the picture does not reach the page
    canvas.setPointerCapture(e.pointerId);
    const p = norm(e);
    const now = performance.now();
    const near = Math.abs(e.clientX - lastClick.x) < 5 && Math.abs(e.clientY - lastClick.y) < 5;
    lastClick = { t: now, x: e.clientX, y: e.clientY, n: now - lastClick.t < 500 && near ? Math.min(3, lastClick.n + 1) : 1 };
    flushMoves();
    input({ type: "mouse", action: "down", ...p, button: BTN[e.button] || "left", buttons: e.buttons, clickCount: lastClick.n, modifiers: mods(e) });
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!userHas()) return;
    e.preventDefault();
    flushMoves();
    input({ type: "mouse", action: "up", ...norm(e), button: BTN[e.button] || "left", buttons: e.buttons, clickCount: lastClick.n, modifiers: mods(e) });
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!userHas()) return;
    moveEv = { type: "mouse", action: "move", ...norm(e), buttons: e.buttons, button: e.buttons & 1 ? "left" : "none", modifiers: mods(e) };
    later();
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!userHas()) return;
      e.preventDefault();
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      const p = norm(e);
      wheelEv = { type: "wheel", ...p, dx: (wheelEv ? wheelEv.dx : 0) + e.deltaX * k, dy: (wheelEv ? wheelEv.dy : 0) + e.deltaY * k, modifiers: mods(e) };
      later();
    },
    { passive: false }
  );
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("keydown", (e) => {
    if (VW.isExpandKey(e)) {
      // the deck's own shortcut works while the page has the keys, and is not sent to the page
      e.preventDefault();
      e.stopPropagation();
      return setExpanded(!W.expanded);
    }
    if (!userHas() || e.isComposing) return;
    const accel = e.ctrlKey || e.metaKey;
    if (accel && e.key.toLowerCase() === "v") return e.stopPropagation(); // the paste event brings the text
    e.preventDefault();
    e.stopPropagation(); // deck shortcuts (Ctrl+B, Ctrl+J) stay out of the agent's page
    const text = e.key === "Enter" ? "\r" : e.key.length === 1 && !accel ? e.key : "";
    input({ type: "key", action: "down", key: e.key, code: e.code, keyCode: e.keyCode, text, modifiers: mods(e), repeat: e.repeat, location: e.location });
  });
  canvas.addEventListener("keyup", (e) => {
    if (!userHas()) return;
    e.preventDefault();
    e.stopPropagation();
    input({ type: "key", action: "up", key: e.key, code: e.code, keyCode: e.keyCode, modifiers: mods(e), location: e.location });
  });
  canvas.addEventListener("paste", (e) => {
    if (!userHas()) return;
    e.preventDefault();
    const t = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    if (t) input({ type: "text", text: t });
  });

  // the host picker closes on a click elsewhere or Escape
  document.addEventListener("pointerdown", (e) => {
    if (W.menu && !menu.contains(e.target) && !whereEl.contains(e.target)) {
      W.menu = false;
      renderMenu();
    }
  });
  // Ctrl+Shift+F toggles the large view while the Workspace has focus (or is large); Esc leaves it
  document.addEventListener("keydown", (e) => {
    if (!root.isConnected) return;
    if (VW.isExpandKey(e) && (W.expanded || root.contains(document.activeElement))) {
      e.preventDefault();
      setExpanded(!W.expanded);
    } else if (e.key === "Escape" && W.expanded && !e.defaultPrevented && !W.menu && !/^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || "") && !document.querySelector("dialog[open]")) {
      setExpanded(false);
    }
  });
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation(); // closes the picker only, not the large view behind it
      W.menu = false;
      renderMenu();
      whereEl.focus();
    }
  });

  // ---------------------------------------------------------------- actions
  let msgTimer = 0;
  async function call(fn) {
    try {
      const r = await fn();
      if (r && r.device) applyState(r);
    } catch (e) {
      W.msg = ctx.cleanErr ? ctx.cleanErr(e) : String(e.message || e);
      clearTimeout(msgTimer);
      msgTimer = setTimeout(() => {
        W.msg = null;
        renderFoot();
      }, 6000);
      renderFoot();
    }
  }

  function toggleControl() {
    const to = userHas() ? "agent" : "user";
    call(async () => {
      const r = await api.control(W.slug, to);
      if (to === "user") canvas.focus();
      return r;
    });
  }

  async function handoffDialog(slug, requested = null) {
    if (!slug || !SLUG_RE.test(slug)) throw new Error(i18nText("transfer.chooseAgent"));
    const list = await api.transferTargets();
    const current = (W.devices?.routes || []).find((r) => r.capability === "browser" && r.sessionKey === slug)?.host;
    const source = current?.kind === "fallback" ? "fallback" : current?.id;
    const targets = list.filter((d) => d.fresh && d.deviceId !== source);
    const matches = requested ? targets.filter((d) => d.deviceId === requested || d.name.toLowerCase() === requested.toLowerCase()) : [];
    if (requested && matches.length !== 1) throw new Error(i18nText("transfer.deviceNoMatch"));
    if (!targets.length) throw new Error(i18nText("transfer.otherDeviceRequired"));
    const chooser = h("select", { "aria-label": i18nText("transfer.target") , "data-i18n-aria-label": "transfer.target"}, ...targets.map((d) => h("option", { value: d.deviceId }, d.name)));
    if (matches[0]) chooser.value = matches[0].deviceId;
    const automatic = h("input", { type: "checkbox", checked: W.st?.transfer?.automaticTarget ? true : null });
    const automaticChoice = () => { automatic.disabled = chooser.value === me(); if (automatic.disabled) automatic.checked = false; };
    chooser.addEventListener("change", automaticChoice);
    automaticChoice();
    const error = h("p", { class: "form-error", role: "alert" });
    const dialog = h("dialog", { class: "ws-transfer", "aria-labelledby": "ws-transfer-title" });
    const close = () => { dialog.close(); dialog.remove(); transferButton.focus(); };
    const submit = h("button", { class: "btn primary", type: "button", onclick: async () => {
      submit.disabled = true;
      chooser.disabled = true;
      try {
        await api.transferConsent(chooser.value, automatic.checked);
        await api.handoff(slug, chooser.value);
        W.msg = i18nText("transfer.requested");
        renderFoot();
        close();
      } catch (e) { error.textContent = ctx.cleanErr ? ctx.cleanErr(e) : e.message; submit.disabled = false; chooser.disabled = false; }
    } }, i18nNode("transfer.confirm"));
    dialog.append(
      h("h3", { id: "ws-transfer-title" }, i18nNode("transfer.title")),
      h("p", null, i18nNode("transfer.contents")),
      h("label", null, i18nNode("transfer.targetDevice"), chooser),
      h("p", { class: "muted small" }, i18nNode("transfer.limitations")),
      h("label", { class: "ws-transfer-auto" }, automatic, i18nNode("transfer.automatic")),
      h("p", { class: "muted small" }, i18nNode("transfer.checkpointHelp")),
      h("p", { class: "muted small" }, i18nNode("transfer.automaticHelp")),
      error,
      h("div", { class: "form-actions" }, h("button", { class: "btn", type: "button", onclick: close }, i18nNode("U0451")), submit)
    );
    dialog.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
    document.body.append(dialog);
    dialog.showModal();
    chooser.focus();
  }

  async function command(text) {
    if (!/^\/handoff(?:\s|$)/i.test(text)) return false;
    const requested = text.replace(/^\/handoff\s*/i, "").trim();
    await handoffDialog(W.slug || (ctx.preferred && ctx.preferred()), requested || null);
    return true;
  }

  function applyRemote(list, hostLabel) {
    W.remote = new Map((Array.isArray(list) ? list : []).filter((b) => b && SLUG_RE.test(String(b.slug || ""))).map((b) => [b.slug, b]));
    if (typeof hostLabel === "string") W.remoteHost = hostLabel;
  }

  function applyState(st) {
    if (!st) return;
    W.st = st;
    WR.fromState(W, st); // the relay link and the last devices snapshot: a late or reloaded window still gets them
    for (const b of st.browsers || []) W.browsers.set(b.slug, b);
    if (st.remote) applyRemote(st.remote.browsers, st.remote.host);
    if (st.view && st.view.slug === W.watching) {
      W.viewKind = st.view.kind || null;
      if (st.view.tabs) {
        W.tabs = st.view.tabs;
        W.follow = st.view.follow !== false;
        W.lastSeen = st.view.lastSeen || null;
        W.wall = st.view.wall || null;
        W.hidden = !!st.view.hidden;
      }
    }
    update();
  }

  // ---------------------------------------------------------------- feeds
  api.onEvent((m) => {
    if (!m) return;
    if (m.t === "frame") {
      if (m.slug !== W.watching) return;
      pending = m;
      if (!decoding) paint();
    } else if (m.t === "tabs") {
      if (m.slug !== W.watching) return;
      W.tabs = m.tabs || [];
      W.follow = m.follow !== false;
      W.lastSeen = m.lastSeen || null;
      W.wall = m.wall || null;
      W.hidden = !!m.hidden;
      renderTabs();
      renderBar();
      renderWall();
      renderStage();
    } else if (m.t === "view") {
      if (m.slug !== W.watching) return;
      W.viewKind = m.kind || null; // the view started (or stopped) on this deck or on the agent host
      resetView();
      update();
    } else if (m.t === "browser") {
      const known = W.browsers.has(m.info.slug);
      W.browsers.set(m.info.slug, m.info);
      if (!known && root.isConnected) update(); // a new agent browser joins the selector
      else if (m.info.slug === W.slug && root.isConnected) update();
    } else if (m.t === "view-error") {
      if (m.slug === W.watching) {
        W.viewError = err(m.error);
        renderStage();
      }
    } else if (m.t === "state") {
      applyState(m.state);
      if (ctx.refreshSettings) ctx.refreshSettings();
    } else if (m.t === "transfer-state") {
      if (W.st) W.st.transfer = m.state;
      if (ctx.refreshSettings) ctx.refreshSettings();
    } else if (m.t === "transfer-consent") {
      call(() => handoffDialog(m.slug, m.target));
    } else if (m.t === "transfer-status") {
      W.msg = m.status === "done" ? i18nText("transfer.done") : m.status === "importing" ? i18nText("transfer.importing") : m.error;
      renderFoot();
    }
  });
  deck.onRelay((m) => {
    if (!m) return;
    if (m.t === "status") {
      WR.track(W, m);
      if (root.isConnected) update();
    } else if (m.t === "devices") {
      WR.track(W, m);
      if (root.isConnected) update();
    } else if (m.t === "ws-browsers") {
      applyRemote(m.browsers, m.host);
      if (root.isConnected) update();
    }
  });
  // a robot-check notification was clicked: show that agent's browser
  if (deck.desktop && deck.desktop.onEvent) {
    deck.desktop.onEvent((e) => {
      if (!e || e.t !== "select" || !/^ws:/.test(String(e.key || ""))) return;
      const slug = String(e.key).slice(3);
      if (!SLUG_RE.test(slug)) return;
      W.slug = slug;
      W.picked = true;
      if (ctx.openWorkspace) ctx.openWorkspace();
      update();
    });
  }
  // status text ages ("just now"), and the tab can be hidden without a re-render
  setInterval(() => {
    // the panel was closed or switched to another tab behind the large view: it ends with it
    if (W.expanded && (!root.isConnected || root.getClientRects().length === 0)) setExpanded(false, { focus: false });
    if (root.isConnected) {
      renderFoot();
      renderSeen();
      if (W.menu && W.link && W.link.status === "open" && !W.devices) renderMenu(); // "waiting" turns into "no list" with time
    }
    sync();
  }, 1000);

  api
    .state()
    .then((st) => {
      applyState(st);
      if (ctx.refreshSettings) ctx.refreshSettings();
    })
    .catch(() => {});

  // ---------------------------------------------------------------- Settings > This device
  /** Rows for the Settings tab's "This device" section (hosting is a per-device choice, off by default). */
  function settingsRows() {
    const st = W.st;
    const box = h("input", { type: "checkbox", id: "s-host-browser", checked: st && st.allowed ? true : null, disabled: st ? null : true });
    box.addEventListener("change", async () => {
      const on = box.checked;
      box.disabled = true;
      try {
        await deck.device.setHosting("browser", on);
        applyState(await api.state());
        if (ctx.settingsMessage) ctx.settingsMessage(true, on ? i18nText("U0987") : i18nText("U0988"));
      } catch (e) {
        box.checked = !on;
        if (ctx.settingsMessage) ctx.settingsMessage(false, `Kaydedilemedi: ${ctx.cleanErr ? ctx.cleanErr(e) : e.message}`);
      } finally {
        box.disabled = false;
      }
    });
    return [
      h("label", { class: "toggle", for: "s-host-browser", title: i18nText("U0990") }, box, h("span", { class: "sw", "aria-hidden": "true" }), h("span", { class: "tbody" }, h("span", { class: "tlabel" }, i18nNode("U0989"), h("span", { class: "sv-note", "aria-live": "polite" })))),
      st && !st.browser ? h("p", { class: "form-error" }, i18nNode("U0991")) : null,
      st?.transfer?.automaticTarget ? h("button", { class: "btn", type: "button", onclick: () => call(async () => { await api.disableTransferAutomatic(); return api.state(); }) }, i18nNode("transfer.disableAutomatic")) : null,
    ].filter(Boolean); // the panel uses replaceChildren, which would print a null
  }

  document.addEventListener("deck-language", () => { if (root.isConnected) update(); });
  return { root, update, settingsRows, command,
    live: (profile) => VW.browserSurfaceLive({ local: [...W.browsers.values()], remote: [...W.remote.values()], link: W.link, profile: profile || null }),
    selectProfile: profile => { if (SLUG_RE.test(String(profile || ""))) { W.slug = profile; W.picked = true; update(); } },
  };
};
