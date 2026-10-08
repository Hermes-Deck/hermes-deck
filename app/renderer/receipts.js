"use strict";
// A bounded, renderer-only turn ledger. All tool payloads remain text previews.
(function (root) {
  const MAX_TURNS = 64, MAX_CALLS = 256, MAX_SESSIONS = 80;
  function preview(v) {
    if (v == null) return "";
    try { return String(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 301); }
    catch { return ""; }
  }
  const failed = call => call.status !== "ok" && call.status !== "running";
  function stats(turn, now = Date.now()) {
    return { seconds: Math.max(0, Math.round(((turn.end ?? now) - turn.since) / 1000)), tools: turn.calls.length,
      failed: turn.calls.filter(failed).length, running: turn.end == null };
  }
  function createStore() {
    const sessions = new Map();
    let seq = 0;
    function turns(sid) {
      if (!sessions.has(sid)) {
        sessions.set(sid, []);
        if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      }
      return sessions.get(sid);
    }
    function start(sid, at) {
      const list = turns(sid);
      const last = list.at(-1);
      if (last && last.end == null) return last;
      const turn = { id: `receipt-${++seq}`, since: at, end: null, open: true, calls: [], anchor: null };
      list.push(turn);
      if (list.length > MAX_TURNS) list.shift();
      return turn;
    }
    function find(sid, id) {
      for (const turn of turns(sid)) {
        const call = turn.calls.find(c => c.call === id);
        if (call) return { turn, call };
      }
      return null;
    }
    function finish(sid, at) {
      const turn = turns(sid).at(-1);
      if (!turn || turn.end != null) return;
      turn.end = at; turn.open = false;
      for (const call of turn.calls) if (call.status === "running") { call.status = "blocked"; call.ms = Math.max(0, at - call.ts * 1000); }
    }
    function event(sid, type, p = {}, at = Date.now()) {
      if (!sid) return;
      if (type === "local.sent" || type === "message.start") { start(sid, at); return; }
      if (type === "message.complete" || type === "local.stopped" || /error/.test(type)) { finish(sid, at); return; }
      if (type !== "tool.start" && type !== "tool.complete") return;
      const id = String(p.tool_id || p.call || p.id || "");
      const found = id ? find(sid, id) : null;
      if (type === "tool.start") {
        if (found) return;
        const turn = start(sid, at);
        if (turn.calls.length >= MAX_CALLS) return;
        turn.calls.push({ call: id || `local-${++seq}`, tool: preview(p.name || p.tool), args: preview(p.arguments ?? p.args ?? p.parameters), ts: at / 1000, status: "running", ms: null, err: null, result: null });
      } else {
        const hit = found || { call: turns(sid).at(-1)?.calls.findLast(c => c.status === "running") };
        if (!hit.call) return;
        Object.assign(hit.call, { status: p.status || (p.error || p.is_error ? "error" : "ok"),
          ms: Number.isFinite(p.duration_ms ?? p.ms) ? Math.max(0, p.duration_ms ?? p.ms) : Math.max(0, at - hit.call.ts * 1000),
          err: preview(p.error ?? p.err) || null, result: preview(p.result ?? p.output) || null });
      }
    }
    function replace(sid, rows, at = Date.now()) {
      const incoming = (Array.isArray(rows) ? rows : []).slice(-MAX_CALLS);
      let imported = null;
      for (const row of incoming) {
        if (!row || !row.call) continue;
        const hit = find(sid, String(row.call));
        const ts = Number.isFinite(Number(row.ts)) ? Number(row.ts) : at / 1000;
        const call = { call: String(row.call), tool: preview(row.tool), args: preview(row.args), ts,
          status: row.status || "ok", ms: Number.isFinite(row.ms) ? Math.max(0, row.ms) : null,
          result: preview(row.result) || null, err: preview(row.err) || null };
        if (hit) {
          if (row.args == null) call.args = hit.call.args;
          if (row.ts == null) call.ts = hit.call.ts;
          Object.assign(hit.call, call);
        } else {
          const active = turns(sid).at(-1);
          const turn = active && active.end == null && ts * 1000 >= active.since ? active :
            imported || (imported = start(sid, ts * 1000));
          if (turn.calls.length < MAX_CALLS) turn.calls.push(call);
        }
      }
      if (imported && !imported.calls.some(c => c.status === "running")) {
        imported.end = Math.max(imported.since, ...imported.calls.map(c => c.ts * 1000 + (c.ms || 0)));
        imported.open = false;
      }
    }
    return { turns, start, finish, event, find, replace };
  }
  function receipt({ h, t, sid, turn, select, selected = null }) {
    const totals = stats(turn);
    const label = t(totals.running ? "conv.working" : "conv.receipt", totals);
    const fold = h("details", { class: "receipt-fold", open: turn.open ? true : null, ontoggle: () => { if (turn.end != null) turn.open = fold.open; } },
      h("summary", { class: "receipt-summary" }, label, totals.failed ? h("span", { class: "receipt-fail" }, t("conv.failed", totals)) : null),
      h("div", { class: "receipt-calls" }, turn.calls.map(call => {
        const active = selected?.sid === sid && selected.call === call.call;
        const item = h("details", { class: `receipt-call${failed(call) ? " failed" : ""}${active ? " selected" : ""}`, open: active || call.open ? true : null,
          dataset: { call: call.call }, ontoggle: () => { call.open = item.open; } },
          h("summary", { onclick: () => select(sid, call.call, false) },
            h("span", { class: call.status === "running" ? "receipt-spinner" : "receipt-dot", "aria-hidden": "true" }),
            h("span", { class: "receipt-tool" }, call.tool), h("code", { class: "receipt-args" }, call.args),
            h("span", { class: "receipt-duration" }, call.ms == null ? "…" : `${(call.ms / 1000).toFixed(1)}s`)),
          h("pre", { tabindex: "0", "aria-label": t("conv.output") }, call.err || call.result || t("conv.noOutput")));
        return item;
      })));
    return h("div", { class: `receipt${totals.running ? " running" : ""}`, dataset: { receipt: turn.id, sid, failed: String(totals.failed > 0) } }, fold,
      h("button", { class: "receipt-inspect", type: "button", onclick: () => select(sid, selected?.sid === sid && turn.calls.some(c => c.call === selected.call) ? selected.call : turn.calls.at(-1)?.call, true) },
        t("conv.inspect"), h("kbd", null, "Ctrl+\\")));
  }
  function createController({ emit, openRight }) {
    let selected = null;
    return {
      selection: () => selected,
      receive(detail) { if (detail?.sid && detail.call) selected = { sid: detail.sid, call: detail.call, source: detail.source }; },
      select(sid, call, inspect = false, source = "receipt") {
        if (!sid || !call) return;
        selected = { sid, call, source };
        if (inspect) openRight("work", "run");
        emit(selected);
      }
    };
  }
  function mount(shell, deck, doc = root.document) {
    const h = shell.service("h"), t = root.DeckI18n.t;
    const inner = doc.getElementById("msgs-inner");
    if (!h || !inner) return null;
    const store = createStore(), subscribers = new Set(), nodes = new Map();
    const controller = createController({ openRight: (...a) => shell.openRight(...a),
      emit: detail => doc.dispatchEvent(new root.CustomEvent("deck-tool-select", { detail })) });
    let session = shell.last("session") || {}, scheduled = false;
    const sidOf = () => session.sid || (session.kind === "hermes" ? session.id : null);
    const changed = () => { for (const fn of subscribers) { try { fn(); } catch (e) { console.warn("Receipt listener failed", e); } } refresh(); };
    function paint() {
      scheduled = false;
      const sid = sidOf();
      for (const el of inner.querySelectorAll(".receipt")) if (el.dataset.sid !== sid) el.remove();
      if (!sid) return;
      const users = [...inner.querySelectorAll(".msg.out:not(.outbox):not(.sysmsg)")];
      for (const turn of store.turns(sid)) {
        if (!turn.calls.length) continue;
        if (!turn.anchor && users.length) turn.anchor = users.at(-1).dataset.convKey;
        const anchor = users.find(el => el.dataset.convKey === turn.anchor);
        if (turn.anchor && !anchor) continue;
        const selected = controller.selection();
        const sig = JSON.stringify([turn.calls, turn.end, turn.open, selected, t("conv.inspect")]);
        let cached = nodes.get(turn.id);
        if (!cached || cached.sig !== sig) {
          const el = receipt({ h, t, sid, turn, selected, select: (s, c, inspect) => { controller.select(s, c, inspect); refresh(); } });
          if (cached?.el.isConnected) cached.el.replaceWith(el);
          nodes.set(turn.id, cached = { sig, el });
          if (nodes.size > MAX_TURNS * 2) nodes.delete(nodes.keys().next().value);
        }
        if (!cached.el.isConnected) {
          // Put the receipt before this turn's final prose, never in another user's turn.
          let target = anchor?.nextElementSibling || null, last = null;
          while (target && !(target.matches(".msg.out:not(.outbox)"))) {
            if (target.matches(".msg:not(.out):not(.sysmsg)")) last = target;
            target = target.nextElementSibling;
          }
          inner.insertBefore(cached.el, last || inner.querySelector(".livebar, .outbox, .conv-wait") || null);
        }
      }
      doc.dispatchEvent(new root.CustomEvent("deck-receipts-render"));
    }
    function refresh() { if (!scheduled) { scheduled = true; root.requestAnimationFrame(paint); } }
    function ingest(sid, type, payload, at) {
      store.event(sid, type, payload, at);
      if (type === "tool.start") controller.select(sid, String(payload?.tool_id || payload?.call || payload?.id || ""), false, "live");
      changed();
    }
    doc.addEventListener("deck-conversation-turn", e => { const d = e.detail; ingest(d.sid, d.type, d.payload, d.at); });
    doc.addEventListener("deck-conversation-render", refresh);
    doc.addEventListener("deck-tool-select", e => {
      controller.receive(e.detail);
      if (e.detail?.source === "run") {
        const turn = store.find(e.detail.sid, e.detail.call)?.turn;
        if (turn) turn.open = true;
      }
      refresh();
    });
    // Direct tool pushes also cover turns started in another client. Raw turn events flow through LA once.
    deck.bridge?.onEvent(m => {
      if (m.t === "event" && m.type === "deck.tools") { store.replace(m.sid, m.payload?.tools); changed(); }
      if (m.t === "status" && m.status !== "open") { for (const turn of store.turns(sidOf())) if (turn.end == null) store.finish(sidOf(), Date.now()); changed(); }
    });
    deck.onRelay?.(m => {
      for (const e of m.evs || []) {
        if (e.ev === "tool_start") ingest(e.sid, "tool.start", { ...e, name: e.tool, tool_id: e.call }, e.ts * 1000);
        if (e.ev === "tool_end") ingest(e.sid, "tool.complete", { ...e, tool_id: e.call }, e.ts * 1000);
        if (e.ev === "turn_start") ingest(e.sid, "message.start", e, e.ts * 1000);
        if (e.ev === "turn_end" || e.ev === "stopped") ingest(e.sid, "message.complete", e, e.ts * 1000);
      }
    });
    async function load() {
      const sid = sidOf();
      if (!sid) return;
      try {
        const calls = await deck.bridge?.toolCalls(sid, { profile: session.profile });
        if (calls?.length) { store.replace(sid, calls); changed(); return; }
        const detail = await deck.session?.(sid);
        if (detail?.recent?.length) { store.replace(sid, detail.recent); changed(); }
      } catch (e) { console.warn("Receipt previews unavailable", e); }
    }
    shell.on("session", s => { session = s; refresh(); load(); });
    const publicApi = { refresh, turns: store.turns, calls: sid => store.turns(sid).flatMap(turn => turn.calls), selection: controller.selection,
      subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); } };
    refresh(); load();
    return publicApi;
  }
  const api = { createStore, stats, preview, failed, receipt, createController, mount, MAX_TURNS, MAX_CALLS };
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.DeckReceiptLogic = Object.freeze(api);
    root.DeckReceipts = mount(root.DeckShell, root.deck);
  }
})(typeof window === "object" ? window : globalThis);
