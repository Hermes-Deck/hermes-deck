"use strict";
// Composer extensions preserve the original input and all existing send/action handlers.
(function (root) {
  function via(session = {}, chat = {}) {
    if (session.channel === "sub" || session.subagent) return { key: "conv.subagent", vars: { agent: chat.title || session.id || "" } };
    if (session.channel === "readonly" || session.readOnly) return { key: "conv.readonly", vars: {} };
    if (session.channel === "telegram" || session.kind === "telegram") return chat.bot ? { key: "conv.telegram", vars: { bot: chat.bot } } : { key: "conv.telegramGroup", vars: {} };
    return { key: "conv.direct", vars: { profile: session.profile || "default" } };
  }
  function createEntranceTracker() {
    const seen = new Set();
    let current = null;
    return { scan(session, keys, atEnd = true) {
      const boot = session !== current; current = session;
      const fresh = boot || !atEnd ? [] : keys.filter(key => !seen.has(`${session}:${key}`));
      for (const key of keys) seen.add(`${session}:${key}`);
      while (seen.size > 4000) seen.delete(seen.values().next().value);
      return fresh;
    } };
  }
  function relocate(inner, tray, queue) {
    tray.replaceChildren(...inner.querySelectorAll(".hreq"));
    queue.replaceChildren(...inner.querySelectorAll(".outbox"));
  }
  const MAX_TRACKED = 64;
  const nodeLive = n => !!n && n.terminalAt == null && (n.active === true || ["thinking", "working", "searching"].includes(n.state));
  /** The bridge's native control rule: a plugin-controlled turn with its owner process. */
  const steerable = n => !!n && nodeLive(n) && n.controlAvailable === true && !!n.turnId && Number.isSafeInteger(n.ownerPid) && n.ownerPid > 0;
  /** Stop also works through a bound gateway session (bridge.interrupt falls back to session.interrupt). */
  const stoppable = n => !!n && nodeLive(n) && (steerable(n) || n.bound === true);
  /** "gone" when no turn runs any more, else the message to show. */
  function stopOutcome(status, t = root.DeckI18n?.t) {
    if (["interrupted", "not_running", "not_interrupted"].includes(status)) return "gone";
    if (status === "stale") return t("U0089");
    return t("conv.stopFailed", { status: String(status || "unknown").slice(0, 64) });
  }
  function mount(shell, deck, doc = root.document) {
    const h = shell.service("h"), t = root.DeckI18n.t;
    const composer = doc.querySelector(".composer"), inner = doc.getElementById("msgs-inner"), input = doc.getElementById("input"), send = doc.getElementById("send");
    if (!h || !composer || !inner) return null;
    const tracker = createEntranceTracker(), thoughtLabels = new Map(), snapshots = new Map(), stopped = new Map();
    let session = shell.last("session") || {}, view = root.DeckLiveActivity.lastView(), pending = false, fullRender = true, focused = null, stopping = null;
    const sidOf = () => session.sid || (session.kind === "hermes" ? session.id : null);
    const tray = h("div", { class: "conv-tray", hidden: true });
    const queue = h("div", { class: "conv-queue", hidden: true });
    const row = h("div", { class: "conv-status" });
    const spinner = h("span", { class: "conv-spinner", "aria-hidden": "true" });
    const label = h("span", { class: "conv-step" });
    const arg = h("code", { class: "conv-arg" });
    const elapsed = h("span", { class: "conv-elapsed" });
    const hint = h("span", { class: "conv-hint" });
    const error = h("p", { class: "conv-error", role: "alert", hidden: true });
    const stop = h("button", { class: "btn mini conv-stop", type: "button", onclick: stopNow }, t("conv.stop"));
    row.append(spinner, label, arg, elapsed, hint, stop);
    const slot = shell.mount("composer-status", row);
    composer.prepend(tray, slot, queue, error, h("div", { class: "conv-filament", "aria-hidden": "true" }));
    const viaEl = h("p", { class: "conv-via" });
    const footer = h("div", { class: "conv-footer" }, doc.getElementById("note"), viaEl);
    composer.after(footer);
    function status() {
      const sid = sidOf(), node = snapshots.get(sid) || view?.node;
      if (view && isStopped(sid, node)) view = null;
      const waiting = tray.children.length > 0;
      const working = !!view && view.sid === sid && !waiting && !["approval", "question"].includes(view.phase);
      composer.classList.toggle("conv-working", working);
      slot.hidden = !working;
      if (working) {
        const text = view.tool ? t("conv.running", { tool: view.tool }) : view.phase === "thinking" ? t("conv.thinking") : t(view.label?.key || "live.writing", view.label?.vars);
        if (label.textContent !== text) label.textContent = text;
        if (arg.textContent !== (view.arg || "")) arg.textContent = view.arg || "";
        elapsed.textContent = `${Math.max(0, Math.floor((Date.now() - view.since) / 1000))}s`;
        const kind = send.dataset.kind;
        hint.textContent = t(kind === "steer" ? "conv.steerHint" : steerable(node) ? "conv.queueHint" : "conv.queueOnly");
        stop.disabled = !stoppable(node) || stopping === sid;
      }
      stop.textContent = t("conv.stop");
      const record = shell.service("chat")?.() || {};
      const route = via(session, { ...record, bot: record.bot || (/^@/.test(record.title || "") ? record.title : null) });
      viaEl.hidden = !session.id;
      const viaText = t(route.key, route.vars);
      if (viaEl.textContent !== viaText) viaEl.textContent = viaText;
      viaEl.dataset.channel = session.channel || "";
    }
    async function stopNow() {
      const sid = sidOf(), node = snapshots.get(sid) || view?.node;
      if (!sid || !view || stopping === sid || !stoppable(node)) return;
      const turn = node?.turnId || "";
      stopping = sid; stop.disabled = true; error.hidden = true;
      let note = null;
      try {
        // The app's own stop path also reconciles its control state; the bridge call is the fallback.
        const viaApp = shell.service("stopTurn");
        const args = { sid, profile: session.profile || node?.profile || "default", ...(turn ? { turnId: turn } : {}) };
        const result = viaApp ? await viaApp(args) : await deck.bridge.interrupt(sid, { profile: args.profile, ...(turn ? { turnId: turn } : {}) });
        const outcome = stopOutcome(result?.status);
        if (outcome === "gone") {
          markStopped(sid, turn);
          if (!viaApp) doc.dispatchEvent(new root.CustomEvent("deck-conversation-turn", { detail: { sid, type: "local.stopped", payload: {}, at: Date.now() } }));
        } else note = outcome;
      } catch (e) { note = String(e?.message || e); }
      finally {
        stopping = null;
        if (sidOf() === sid) {
          if (note) { error.textContent = note; error.hidden = false; }
          else if (isStopped(sid, snapshots.get(sid) || view?.node || { turnId: turn })) view = null;
        }
        status();
      }
    }
    function markStopped(sid, turn) {
      stopped.delete(sid); stopped.set(sid, turn);
      while (stopped.size > MAX_TRACKED) stopped.delete(stopped.keys().next().value);
    }
    const isStopped = (sid, node) => stopped.has(sid) && stopped.get(sid) === (node?.turnId || "");
    function keyOf(text) {
      let hash = 2166136261;
      for (const ch of text) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
      return (hash >>> 0).toString(36);
    }
    function decorate() {
      pending = false;
      observer.disconnect();
      const records = [...inner.querySelectorAll(".msg:not(.outbox):not(.sysmsg)")];
      const duplicate = new Map();
      for (const el of records.filter(el => el.classList.contains("out")).reverse()) {
        const hash = el.dataset.mid || keyOf((el.querySelector(".text")?.textContent || el.querySelector(".mstrip")?.textContent || "").trim());
        const count = (duplicate.get(hash) || 0) + 1; duplicate.set(hash, count);
        el.dataset.convKey = `user-${hash}-${count}`;
      }
      let user = "initial", ordinal = 0;
      for (const el of records) {
        if (el.classList.contains("out")) { user = el.dataset.convKey; ordinal = 0; }
        else el.dataset.convKey = el.dataset.mid ? `msg-${el.dataset.mid}` : `${user}-agent-${ordinal++}`;
      }
      const fresh = new Set(tracker.scan(session.id, records.map(el => el.dataset.convKey), doc.getElementById("msgs").scrollTop > -60));
      for (const el of records) if (fresh.has(el.dataset.convKey)) el.classList.add("conv-fresh");
      if (fullRender || inner.querySelector(".hreq, .outbox")) {
        relocate(inner, tray, queue);
        tray.hidden = !tray.children.length; queue.hidden = !queue.children.length;
      }
      fullRender = false;
      inner.querySelector(".conv-wait")?.remove();
      if (tray.children.length) {
        const approval = !!tray.querySelector('[data-i18n-aria-label="U0603"]');
        inner.appendChild(h("p", { class: "conv-wait", dataset: { timeline: "approval" } }, t(approval ? "conv.waitApproval" : "conv.waitQuestion")));
      }
      for (const el of records) {
        const seconds = thoughtLabels.get(`${session.id}:${el.dataset.convKey}`);
        if (seconds != null && el.querySelector(".tb-label")) el.querySelector(".tb-label").textContent = t("conv.thought", { seconds });
      }
      if (focused?.el && !focused.el.isConnected && (doc.activeElement === doc.body || doc.activeElement === null)) {
        // focus() fires focusin synchronously and replaces `focused`: keep the caret before moving focus.
        const { fk, start, end } = focused;
        const replacement = [...tray.querySelectorAll("[data-fk]")].find(el => el.dataset.fk === fk);
        if (replacement) { replacement.focus({ preventScroll: true }); if (replacement.setSelectionRange && start != null) replacement.setSelectionRange(start, end); }
      }
      status();
      observer.observe(inner, { childList: true, subtree: true });
      doc.dispatchEvent(new root.CustomEvent("deck-conversation-render"));
    }
    function schedule() { if (!pending) { pending = true; root.requestAnimationFrame(decorate); } }
    const observer = new root.MutationObserver(records => {
      // Receipt insertion is a module-owned mutation; it must not start a repaint feedback loop.
      const meaningful = records.filter(r => [...r.addedNodes, ...r.removedNodes].some(n => n.nodeType !== 1 || !n.matches?.(".receipt, .conv-wait")));
      if (!meaningful.length) return;
      if (meaningful.some(r => r.target === inner)) fullRender = true;
      schedule();
    });
    doc.addEventListener("focusin", e => { const el = e.target; focused = tray.contains(el) ? { el, fk: el.dataset.fk, start: el.selectionStart, end: el.selectionEnd } : null; });
    tray.addEventListener("input", e => { if (focused?.el === e.target) { focused.start = e.target.selectionStart; focused.end = e.target.selectionEnd; } });
    doc.addEventListener("deck-conversation-live", e => {
      const d = e.detail;
      if (d.sid !== sidOf()) return;
      view = d.view && isStopped(d.sid, d.view.node || snapshots.get(d.sid)) ? null : d.view;
      status();
    });
    doc.addEventListener("deck-conversation-turn", e => {
      const d = e.detail;
      if (d.sid !== sidOf()) return;
      if (d.type === "message.complete") {
        const last = [...inner.querySelectorAll(".msg:not(.out):not(.sysmsg)")].at(-1);
        const seconds = root.DeckLiveActivity.thoughtSeconds(d.sid);
        if (last?.dataset.convKey && seconds != null) thoughtLabels.set(`${session.id}:${last.dataset.convKey}`, seconds);
      }
      if (d.type === "local.sent" || d.type === "message.start") stopped.delete(d.sid);
      if (d.type === "local.sent" && !view) view = { sid: d.sid, phase: "thinking", since: d.at, tool: "", arg: "" };
      if (["message.complete", "local.stopped", "error"].includes(d.type)) view = null;
      status(); schedule();
    });
    doc.addEventListener("keydown", e => {
      if (e.key !== "Escape" || e.defaultPrevented || e.repeat || e.isComposing || !view || stop.disabled || doc.querySelector('.pick-pop:not([hidden]), dialog[open], .sv, .lightbox, .ctx')) return;
      if (e.target !== input && e.target !== doc.body && !row.contains(e.target)) return;
      e.preventDefault(); stopNow();
    });
    deck.bridge?.onEvent(m => {
      if (m.t === "snapshot") {
        const list = Array.isArray(m.snapshot?.nodes) ? m.snapshot.nodes : [];
        snapshots.clear(); for (const n of list) if (n && typeof n.sid === "string") snapshots.set(n.sid, n);
        // A stop is remembered for its own turn only: a newer turn id or an idle node forgets it.
        for (const [sid, turn] of stopped) { const n = snapshots.get(sid); if (!n || !nodeLive(n) || (n.turnId || "") !== turn) stopped.delete(sid); }
        const sid = sidOf(), node = snapshots.get(sid);
        if (node && nodeLive(node) && !isStopped(sid, node)) {
          if (!view || view.sid !== sid) view = { sid, ...root.DeckLiveActivity.fromNode(node), since: Date.now(), arg: "", node };
          else view.node = node;
        } else if (node && !["approval", "question"].includes(node.state)) view = null;
        status();
      }
      if (m.t === "status" && m.status !== "open") { view = null; status(); }
    });
    shell.on("session", s => { session = s; view = null; fullRender = true; error.hidden = true; schedule(); });
    doc.addEventListener("deck-language", schedule);
    root.setInterval(() => { if (!doc.hidden && view) status(); }, 1000);
    decorate();
    return { decorate, refresh: schedule };
  }
  const api = { via, createEntranceTracker, relocate, mount, nodeLive, steerable, stoppable, stopOutcome, MAX_TRACKED };
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.DeckComposerLogic = Object.freeze(api); root.DeckComposer = mount(root.DeckShell, root.deck); }
})(typeof window === "object" ? window : globalThis);
