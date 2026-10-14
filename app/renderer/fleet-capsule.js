"use strict";
// Fleet presentation shares inbox's read model and guarded answer path.
(function (root) {
  const I = () => typeof module === "object" && module.exports ? require("./inbox") : root.DeckInbox;
  const live = s => !s.stale && (s.active || ["running", "thinking", "working", "searching"].includes(s.state));
  const waiting = s => ["question", "approval"].includes(s.state);
  function derive(data = {}) {
    const all = I().sessions(data), by = new Map();
    for (const a of Object.values(data.agents || {})) if (a) by.set(a.profile || a.name, { ...a, profile: a.profile || a.name, name: a.name || a.profile });
    for (const s of all) {
      const profile = s.profile || "default";
      if (!by.has(profile)) by.set(profile, { profile, name: s.agent || profile });
    }
    for (const r of data.requests || []) {
      const profile = r.profile || "default";
      if (!by.has(profile)) by.set(profile, { profile, name: profile });
    }
    const agents = [...by.values()].map(a => {
      const mine = all.filter(s => (s.profile || "default") === a.profile);
      const roots = mine.filter(s => !s.parent && !s.parentId);
      const requests = (data.requests || []).filter(r => (r.profile || "default") === a.profile);
      const isOnline = s => s.origin === "direct" ? data.bridgeStatus === "open" : data.relayStatus === "open";
      const rank = s => requests.some(r => r.sid === s.sid) || waiting(s) && isOnline(s) ? 0 : live(s) && isOnline(s) ? 1 : 2;
      roots.sort((a, b) => rank(a) - rank(b) || (b.updatedAt || b.lastTs || 0) - (a.updatedAt || a.lastTs || 0));
      const session = roots[0] || null;
      const online = session ? isOnline(session) : data.relayStatus === "open" && !data.fleet?.profiles?.[a.profile]?.stale;
      const state = requests.length || roots.some(s => waiting(s) && isOnline(s)) ? "waiting"
        : roots.some(s => live(s) && isOnline(s)) || data.relayStatus === "open" && a.running > 0 ? "running" : online ? "idle" : "offline";
      return { ...a, state, session, requests, task: session?.title || session?.lastMsg || session?.name || session?.goal || "",
        children: mine.filter(s => s.parent && roots.some(p => p.sid === s.parent)), model: session?.model || "", effort: session?.effort || session?.reasoning || "" };
    });
    const order = { waiting: 0, running: 1, idle: 2, offline: 3 };
    return agents.sort((a, b) => order[a.state] - order[b.state] || String(a.name).localeCompare(String(b.name)));
  }
  function elapsed(session, now = Date.now() / 1000) {
    const start = session?.turnTs || session?.startedAt;
    return typeof start === "number" && start > 0 ? Math.max(0, Math.floor(now - start)) : null;
  }
  function today(data) {
    const rows = Object.values(data.agents || {}).map(a => a.today).filter(Boolean);
    if (!rows.length) return null;
    const tokens = typeof module === "object" && module.exports ? require("./tokens-view") : root.DeckTokens;
    return tokens.totals(rows);
  }
  function createFleet(ctx) {
    const { h, doc, win, shell, store, t, usage } = ctx;
    const button = h("button", { type: "button", class: "tf-cap", title: t("triage.fleetTip"), "aria-label": t("triage.fleetTip"), "aria-expanded": "false", "aria-controls": "triage-fleet", onclick: () => toggle() });
    const panel = h("section", { id: "triage-fleet", class: "tf-panel", role: "dialog", "aria-modal": "false", "aria-label": t("triage.fleet"), hidden: true });
    doc.body.append(panel);
    const forms = new Map(), elapsedNodes = new Map(), expandedKids = new Set();
    let open = false, timer = null, returnFocus = null, notice = null;
    const number = n => Number(n).toLocaleString(root.DeckI18n?.getLocale() || "en", { notation: "compact", maximumFractionDigits: 1 });
    const duration = s => s === null ? "–" : s < 60 ? t("triage.elapsedSeconds", { s }) : t("triage.elapsed", { m: Math.floor(s / 60), s: String(s % 60).padStart(2, "0") });
    function tick() { for (const [node, session] of elapsedNodes) node.textContent = duration(elapsed(session)); }
    function elapsedNode(s) { const node = h("span", null, duration(elapsed(s))); elapsedNodes.set(node, s); return node; }
    function place() {
      const r = button.getBoundingClientRect(), width = Math.min(520, win.innerWidth - 24);
      panel.style.left = `${Math.max(12, Math.min(win.innerWidth - width - 12, r.left + r.width / 2 - width / 2))}px`;
      panel.style.top = `${r.bottom + 8}px`;
    }
    function close(restore = true) {
      open = false; clearInterval(timer); timer = null;
      panel.classList.remove("show"); panel.hidden = true;
      button.setAttribute("aria-expanded", "false");
      if (restore) (returnFocus || button).focus({ preventScroll: true });
    }
    function toggle() {
      if (open) { close(); return; }
      returnFocus = doc.activeElement; open = true; panel.hidden = false;
      redraw(); panel.classList.add("show"); button.setAttribute("aria-expanded", "true");
      panel.querySelector(".tf-close")?.focus({ preventScroll: true });
      timer = setInterval(tick, 1000);
    }
    function openChat(a) {
      if (!a.session || ctx.openChat(a.session) === false) { notice = t("triage.navigationUnavailable"); redraw(); return; }
      close(false);
    }
    function redraw() {
      const agents = derive(store.data), total = today(store.data), need = store.data.requests.length;
      const running = agents.filter(a => a.state === "running").length;
      const tile = a => h("span", { class: `tf-avatar ${a.state}`, "aria-hidden": "true" }, String(a.name || "?").slice(0, 1));
      const cost = total ? usage.costText(total) : "–";
      button.replaceChildren(...[h("span", { class: "tf-stack" }, agents.filter(a => ["waiting", "running"].includes(a.state)).slice(0, 4).map(tile)),
        h("span", { class: "tf-running" }, t("triage.runningCount", { n: running })),
        need ? h("span", { class: "tf-need" }, t("triage.needsCount", { n: need })) : null,
        h("span", { class: "tf-cost", title: total ? usage.costWhy(total) : t("triage.unavailable") }, cost)].filter(Boolean));
      if (!open || panel.contains(doc.activeElement) && doc.activeElement?.matches("input[data-hold]")) return;
      const focus = panel.contains(doc.activeElement) ? doc.activeElement?.dataset.fk : null;
      elapsedNodes.clear();
      const kids = [h("header", { class: "tf-head" }, h("b", null, t("triage.fleet")),
        h("span", null, t("triage.runningCount", { n: running })),
        ctx.refreshButton ? ctx.refreshButton() : null,
        h("button", { type: "button", class: "tf-close te-btn", "aria-label": t("triage.close"), dataset: { fk: "fleet-close" }, onclick: () => close() }, "×"))];
      if (!agents.length) kids.push(h("div", { class: "tf-empty" }, t("triage.fleetEmpty")));
      for (const a of agents) {
        const details = [];
        for (const r of a.requests) {
          const row = store.items().find(x => x.request === r);
          if (row) details.push(I().requestBody({ h, store, t, forms, redraw }, row));
        }
        const liveKids = a.children.filter(live), doneKids = a.children.filter(c => !live(c));
        const showDone = expandedKids.has(a.profile);
        const shownKids = showDone ? [...liveKids, ...doneKids.slice(0, 20)] : liveKids;
        const moreKids = doneKids.length ? h("button", { type: "button", class: "tf-more", dataset: { fk: `fleet-more:${a.profile}` },
          onclick: () => { if (showDone) expandedKids.delete(a.profile); else expandedKids.add(a.profile); redraw(); } },
          showDone ? t("triage.hideFinished") : t("triage.finishedSubs", { n: doneKids.length })) : null;
        if (shownKids.length || moreKids) details.push(h("div", { class: "tf-children" }, ...shownKids.map(child => h("button", {
          type: "button", class: "tf-child", title: t("triage.subagent"), dataset: { fk: `fleet-child:${I().sessionKey(child)}` },
          onclick: () => {
            const selection = { sid: child.parent, profile: child.profile || a.profile, childSid: child.sid, subagentId: child.subagentId || null };
            shell.openRight("work", "agents"); ctx.selectAgent(selection); close(false);
          } }, h("span", null, child.goal || child.title || child.name || child.sid), live(child) ? elapsedNode(child) : h("small", null, child.state))), moreKids));
        kids.push(h("article", { class: `tf-agent ${a.state}` }, tile(a),
          h("button", { type: "button", class: "tf-agent-main", dataset: { fk: `fleet-agent:${a.profile}` }, onclick: () => openChat(a) },
            h("b", null, a.name), h("span", { class: "tf-task" }, a.task || t("triage.noTask"))),
          h("div", { class: "tf-runtime" }, a.state === "running" ? elapsedNode(a.session) : h("span", null, t(`triage.state.${a.state}`)),
            h("small", null, [a.model, a.effort].filter(Boolean).join(" · "))),
          details.length ? h("div", { class: "tf-details" }, details) : null));
      }
      const stats = [["today", cost], ["tokens", total ? number(total.tokens) : "–"], ["calls", total ? number(total.n) : "–"], ["cache", total?.hit != null ? usage.pct(total.hit * 100) : "–"]];
      // the titled entry to the full Usage view (quotas, today, profiles, token history); the popover steps aside
      if (ctx.openUsage) kids.push(h("button", { type: "button", class: "tf-usage", title: t("usagev.detailsTip"), dataset: { fk: "fleet-usage" },
        onclick: () => { close(false); ctx.openUsage(); } }, h("span", null, t("usagev.details")), h("span", { class: "tf-chev", "aria-hidden": "true" }, "›")));
      kids.push(h("section", { class: "tf-today" }, stats.map(([key, value]) => h("div", null, h("small", null, t(`triage.${key}`)), h("b", null, value)))));
      if (store.data.fleet) kids.push(h("section", { class: "tf-quotas", "aria-label": t("triage.quota") }, usage.quotaRows(h, store.data.fleet)));
      if (notice) kids.push(h("p", { class: "tf-notice", role: "status" }, notice));
      kids.push(h("footer", { class: "tf-footer" }, t("triage.fleetFooter")));
      panel.replaceChildren(...kids); place();
      if (focus) [...panel.querySelectorAll("[data-fk]")].find(x => x.dataset.fk === focus)?.focus({ preventScroll: true });
    }
    const keydown = e => { if (open && e.key === "Escape" && !e.isComposing) { e.preventDefault(); close(); } };
    const outside = e => { if (open && !panel.contains(e.target) && !button.contains(e.target)) close(false); };
    const resize = () => { if (open) place(); };
    const unsubscribe = store.subscribe(redraw);
    doc.addEventListener("keydown", keydown); doc.addEventListener("pointerdown", outside); win.addEventListener("resize", resize);
    panel.addEventListener("focusout", e => { if (e.target.matches("input[data-hold]")) setTimeout(redraw, 0); });
    redraw();
    return { button, panel, toggle, close, redraw,
      destroy() { close(false); unsubscribe(); doc.removeEventListener("keydown", keydown); doc.removeEventListener("pointerdown", outside); win.removeEventListener("resize", resize); panel.remove(); } };
  }
  /** The one child-selection handshake (contracts.md): the work pane listens for this document event. */
  function selectAgent(doc, selection) {
    const s = selection || {};
    if (typeof s.sid !== "string" || !s.sid) return false;
    const detail = { sid: s.sid, profile: s.profile || "default", childSid: typeof s.childSid === "string" ? s.childSid : null,
      subagentId: typeof s.subagentId === "string" ? s.subagentId : null };
    doc.dispatchEvent(new CustomEvent("deck-agent-select", { detail }));
    return true;
  }
  // Re-reads the relay snapshot (the same "ready" resync main.js runs) and the quota windows (as the Usage refresh does).
  let refreshing = null;
  function refreshAll(button, t) {
    if (refreshing) return refreshing;
    button.disabled = true; button.classList.add("is-busy"); button.setAttribute("aria-busy", "true");
    refreshing = (async () => {
      try { await root.deck?.ready?.(); await root.deck?.quotaRefresh?.(); button.title = t("triage.refreshTip"); }
      catch { button.title = t("usage.refreshFailed"); }
      finally { refreshing = null; button.disabled = false; button.classList.remove("is-busy"); button.removeAttribute("aria-busy"); }
    })();
    return refreshing;
  }
  function boot() {
    const shell = root.DeckShell, inbox = I(), store = inbox?.store, h = shell?.service("h");
    if (!h || !store || api.view) return;
    const t = root.DeckI18n.t;
    // the fleet panel's header refresh (built on each redraw; a running refresh keeps its busy state)
    const refreshButton = () => {
      const b = h("button", { type: "button", class: "tf-refresh te-btn", title: t("triage.refreshTip"), "aria-label": t("triage.refresh"), dataset: { fk: "fleet-refresh" },
        onclick: () => refreshAll(b, t).then(() => api.view?.redraw()) }, h("span", { "aria-hidden": "true" }, "↻"));
      if (refreshing) { b.disabled = true; b.classList.add("is-busy"); b.setAttribute("aria-busy", "true"); }
      return b;
    };
    api.view = createFleet({ h, shell, store, doc: root.document, win: root, t, usage: root.DeckUsage, openChat: inbox.openChat, refreshButton,
      selectAgent: selection => selectAgent(root.document, selection),
      openUsage: () => shell.service("usageView")?.open() });
    shell.mount("capsule", api.view.button);
    shell.on("fleet", api.view.toggle);
    root.document.addEventListener("deck-language", api.view.redraw);
  }
  const api = { derive, elapsed, today, createFleet, selectAgent, boot };
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.DeckFleetCapsule = api; boot(); }
})(typeof window === "object" ? window : globalThis);
