"use strict";
// Top bar host switcher: one numbered, monitor-style button per saved host, a status dot on each, and (when the
// window can show two hosts) a split-view toggle. Logic is pure and DOM-free where it can be; create() paints.
// Main/preload contract (all optional, feature-detected by app.js): deck.hosts.layout / setSplit / onLayout / status.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DeckHostSwitcher = api;
})(typeof window === "object" ? window : globalThis, function () {
  const SPLIT_ICON = "split";

  /** Any connection word (settings connectionState or the main-process status frame) as one of five. */
  function normState(v) {
    switch (v) {
      case "open": return "open";
      case "connecting": case "starting": return "connecting";
      case "closed": case "offline": case "error": case "setup": case "protocol": return "offline";
      case "off": case "unconfigured": return "unconfigured";
      default: return "saved"; // configured, not observed
    }
  }

  /** The dot: ok (all configured parts open), warn (connecting, or some open and some down), bad (down), off (nothing observed). */
  function dotOf(relay, sessions) {
    const parts = [normState(relay), normState(sessions)].filter(s => s !== "unconfigured");
    if (!parts.length) return "off";
    if (parts.every(s => s === "open")) return "ok";
    if (parts.includes("connecting")) return "warn";
    if (parts.includes("open")) return "warn";
    if (parts.includes("offline")) return "bad";
    return "off";
  }

  /**
   * The states shown for one host. The page's own host is read live (own), other hosts come from the main process's
   * status frames; without them, from what Settings knows (saved config, observed direct watcher).
   */
  function statesFor(host, { shown, own, status, remote, connectionState }) {
    if (host.id === shown && own) return { relay: normState(own.relay), sessions: normState(own.sessions) };
    const frame = status && status.get(host.id);
    if (frame) return { relay: normState(frame.relay), sessions: normState(frame.sessions) };
    const cs = connectionState || ((configured) => (configured ? "saved" : "unconfigured"));
    return {
      relay: normState(cs(!!(host.relay && host.relay.url && host.relay.hasToken), null)),
      sessions: normState(cs(!!(host.bridge && host.bridge.mode && host.bridge.mode !== "off"), remote && remote.status)),
    };
  }

  /** What the bar shows, as plain records. hosts: [{id, name}], shown: id of this pane's host, layout: contract layout or null. */
  function model({ hosts, shown, layout, statuses }) {
    const other = layout && layout.split && Array.isArray(layout.panes)
      ? layout.panes.map(p => p && p.hostId).filter(id => id && id !== shown) : [];
    return hosts.map((x, i) => {
      const st = statuses(x);
      return { id: x.id, n: i + 1, name: x.name || x.id, lit: x.id === shown, other: other.includes(x.id), dot: dotOf(st.relay, st.sessions), relay: st.relay, sessions: st.sessions };
    });
  }

  /** Ctrl/Cmd+1..9 → zero-based host index, or -1. AltGr (Ctrl+Alt) and Shift are not ours. */
  function digitIndex(e) {
    if (!e || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.isComposing || e.defaultPrevented) return -1;
    return /^[1-9]$/.test(String(e.key)) ? Number(e.key) - 1 : -1;
  }

  /** Roving focus inside the numbers: the index to focus next, or -1 when the key is not a movement. */
  function moveIndex(key, i, n) {
    if (n < 1) return -1;
    if (key === "ArrowRight" || key === "ArrowDown") return (i + 1) % n;
    if (key === "ArrowLeft" || key === "ArrowUp") return (i - 1 + n) % n;
    if (key === "Home") return 0;
    if (key === "End") return n - 1;
    return -1;
  }

  function create(ctx) {
    const doc = ctx.doc;
    const el = (tag, attrs, ...kids) => {
      const e = doc.createElement(tag);
      for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : String(v));
      for (const c of kids) if (c) e.appendChild(c);
      return e;
    };
    const t = ctx.t;
    let layout = null, status = null, splitBusy = false, builtKey = "";
    const pending = () => !!(ctx.pending && ctx.pending());
    const buttons = new Map();
    const group = el("div", { class: "hb-nums", role: "radiogroup", "aria-label": t("hosts.select") });
    const splitBtn = el("button", { type: "button", class: "hb-split", "data-fk": "host-split", hidden: true }, ctx.icon(SPLIT_ICON, 15));
    const rootEl = el("div", { class: "host-bar", id: "host-bar", hidden: true }, group, splitBtn);
    let list = [];

    const shown = () => (layout && layout.hostId) || ctx.active();
    const remoteOf = (id) => (ctx.remote ? ctx.remote() : []).find(v => v && v.id === id);

    function tip(m) {
      return t("hostbar.tip", { name: m.name, relay: t(`hosts.state.${m.relay}`), sessions: t(`hosts.state.${m.sessions}`) });
    }

    function render() {
      const hosts = ctx.hosts();
      const visible = !!ctx.ready() && hosts.length > 1;
      rootEl.hidden = !visible;
      if (!visible) return;
      const sh = shown();
      const own = ctx.own ? ctx.own() : null;
      list = model({ hosts, shown: sh, layout, statuses: x => statesFor(x, { shown: sh, own, status, remote: remoteOf(x.id), connectionState: ctx.connectionState }) });
      group.setAttribute("aria-label", t("hosts.select"));
      const key = list.map(m => m.id).join("\u0001");
      if (key !== builtKey) {
        builtKey = key;
        buttons.clear();
        const kids = list.map(m => {
          const b = el("button", { type: "button", class: "hb-num", role: "radio", "data-fk": `host-num:${m.id}` });
          b.appendChild(el("span", { class: "hb-n", "aria-hidden": "true" }));
          b.appendChild(el("span", { class: "hb-dot", "aria-hidden": "true" }));
          b.addEventListener("click", () => choose(m.id));
          buttons.set(m.id, b);
          return b;
        });
        group.replaceChildren(...kids);
      }
      const anyLit = list.some(m => m.lit);
      list.forEach((m, i) => {
        const b = buttons.get(m.id);
        const text = tip(m);
        b.className = `hb-num${m.lit ? " lit" : ""}${m.other ? " other" : ""}`;
        b.setAttribute("aria-checked", m.lit ? "true" : "false");
        b.setAttribute("tabindex", m.lit || (!anyLit && i === 0) ? "0" : "-1");
        b.setAttribute("title", text);
        b.setAttribute("aria-label", text);
        if (pending()) b.setAttribute("aria-disabled", "true"); else b.removeAttribute("aria-disabled");
        b.firstChild.textContent = String(m.n);
        b.lastChild.className = `hb-dot ${m.dot}`;
      });
      const canSplit = typeof ctx.setSplit === "function";
      // half the bar's width (26px numbers, 6px gaps; the split button adds 40px): the crumb stops this far short of the centre
      splitBtn.hidden = !canSplit;
      if (canSplit) {
        const on = !!(layout && layout.split);
        const label = t(on ? "hostbar.single" : "hostbar.split");
        splitBtn.className = `hb-split${on ? " lit" : ""}`;
        splitBtn.setAttribute("aria-pressed", on ? "true" : "false");
        splitBtn.setAttribute("title", label);
        splitBtn.setAttribute("aria-label", label);
        if (splitBusy) splitBtn.setAttribute("aria-disabled", "true"); else splitBtn.removeAttribute("aria-disabled");
      }
    }

    function choose(id) {
      if (pending() || id === shown()) return; // the lit number is where you already are
      return ctx.select(id);
    }

    splitBtn.addEventListener("click", async () => {
      if (splitBusy || typeof ctx.setSplit !== "function") return;
      splitBusy = true; render();
      try { setLayout(await ctx.setSplit(!(layout && layout.split))); }
      catch (e) { if (ctx.onError) ctx.onError(e); }
      finally { splitBusy = false; render(); }
    });

    group.addEventListener("keydown", (e) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      const at = list.findIndex(m => buttons.get(m.id) === (doc.activeElement || e.target));
      const to = moveIndex(e.key, at < 0 ? 0 : at, list.length);
      if (to < 0) return;
      e.preventDefault();
      list.forEach((m, i) => buttons.get(m.id).setAttribute("tabindex", i === to ? "0" : "-1"));
      buttons.get(list[to].id).focus();
    });

    /** Ctrl/Cmd+digit: show host N here. Only while the numbers are on screen. */
    function onDocKey(e) {
      if (rootEl.hidden) return;
      const i = digitIndex(e);
      if (i < 0 || i >= list.length) return;
      e.preventDefault();
      choose(list[i].id);
    }
    doc.addEventListener("keydown", onDocKey);

    function setLayout(v) {
      if (!v || typeof v !== "object") return;
      layout = v;
      if (doc.documentElement && doc.documentElement.dataset) doc.documentElement.dataset.pane = ["left", "right"].includes(v.pane) ? v.pane : "full";
      render();
    }
    function setStatus(hosts) {
      if (!Array.isArray(hosts)) return;
      status = new Map(hosts.filter(x => x && typeof x.id === "string").map(x => [x.id, x]));
      render();
    }
    if (doc.documentElement && doc.documentElement.dataset) doc.documentElement.dataset.pane = "full";

    return { root: rootEl, render, setLayout, setStatus, shown, onDocKey,
      destroy() { doc.removeEventListener("keydown", onDocKey); rootEl.remove(); } };
  }

  return { create, model, dotOf, normState, statesFor, digitIndex, moveIndex, SPLIT_ICON };
});
