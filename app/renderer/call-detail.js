"use strict";
// A tool call opened where it stands in the transcript: window.DeckCallDetail.
//
// A step of a turn lists the calls it made ("terminal  cd app && npm test…"). A click on one unfolds that call right
// under its line: its arguments and its output, whole (tool-detail.js, the same view as a Work > Run row). Nothing
// else moves: the turn's receipt stays folded and the Work pane stays as it is. "Open in Run" in the unfolded call is
// the way to the Run pane for whoever wants it.
//  - The call's data: the turn's receipt (receipts.js) while it has it, else the session's stored calls, read once
//    per session on the first unfold (deck.bridge.toolCalls). A preview that was cut is read in full
//    (deck.toolCall) by tool-detail.js.
//  - A call still running shows its arguments and "Running"; the output follows when the call ends.
(function (root) {
  const MAX_OPEN = 200;
  function create({ h, t, deck, redraw, receipts = () => root.DeckReceipts, detail = () => root.DeckToolDetail, copy = (text) => root.navigator?.clipboard?.writeText?.(text),
    emitReveal = (d) => root.document.dispatchEvent(new root.CustomEvent("deck-tool-reveal", { detail: d })), setTimer = (fn, ms) => root.setTimeout(fn, ms) }) {
    const open = new Set(); // `${sid}\n${call}`
    const flags = new Set(); // Raw switches and diff caps of the unfolded calls
    const stored = new Map(); // sid -> {state: "loading" | "done" | "error", calls: Map(call -> row)}
    let full = null, copied = null;
    const keyOf = (sid, call) => `${sid}\n${call}`;
    const fullCalls = () => full || (full = detail()?.createFullCalls({ read: typeof deck.toolCall === "function" ? (sid, call) => deck.toolCall(sid, call) : null, onChange: () => redraw() }) || null);

    /** The session's stored calls, read once (again after an error, on the next unfold). */
    function load(sid, profile) {
      const was = stored.get(sid);
      if (was && was.state !== "error") return was;
      const entry = { state: "loading", calls: new Map() };
      stored.set(sid, entry);
      Promise.resolve().then(() => deck.bridge?.toolCalls?.(sid, profile ? { profile } : undefined)).then((rows) => {
        for (const r of Array.isArray(rows) ? rows : []) if (r && r.call != null) entry.calls.set(String(r.call), r);
        entry.state = "done";
      }, () => { entry.state = "error"; }).then(() => redraw());
      return entry;
    }

    /** What is known of a call now: the receipt's row, else the stored row, else the line's own name and argument. */
    function dataOf(sid, c, profile) {
      const live = receipts()?.calls?.(sid)?.find((x) => x.call === c.id);
      const kept = stored.get(sid);
      // the receipt knows a call of this turn at once; an older turn's call comes from the store
      const row = live && (live.result != null || live.err != null || live.status === "running") ? live : kept?.calls.get(c.id) || live;
      if (row) return { row: { ...row, call: c.id, tool: row.tool || c.name }, loading: false };
      const entry = load(sid, profile);
      return { row: { call: c.id, tool: c.name, args: c.arg || "", status: entry.state === "loading" ? "running" : "ok" }, loading: entry.state === "loading" };
    }

    function toggle(sid, call, profile) {
      const key = keyOf(sid, call);
      if (open.has(key)) open.delete(key);
      else {
        open.add(key);
        while (open.size > MAX_OPEN) open.delete(open.keys().next().value);
        const known = receipts()?.calls?.(sid)?.find((x) => x.call === call);
        if (!known || (known.result == null && known.err == null)) {
          const entry = stored.get(sid);
          if (entry && entry.state === "done" && !entry.calls.has(call)) stored.delete(sid); // a call made since the last read
          load(sid, profile);
        }
      }
      redraw();
    }

    /** The unfolded call under its line, or null when it is folded. */
    function el(sid, c, { profile = null, ts = null } = {}) {
      if (!c.id || !open.has(keyOf(sid, c.id))) return null;
      const D = detail();
      const { row, loading } = dataOf(sid, c, profile);
      const key = `tc:${sid}:${c.id}`;
      const body = !D ? h("pre", { class: "td-pre" }, row.err || row.result || row.args || "")
        : D.render(row, { h, t, key, full: fullCalls()?.get(sid, row) || null, failed: row.status === "error" || row.status === "failed" || !!row.err, copied,
          isOn: (k) => flags.has(k), toggle: (k) => { if (flags.has(k)) flags.delete(k); else flags.add(k); redraw(); },
          copy: (text, k) => Promise.resolve().then(() => copy(text)).then(() => { copied = k; redraw(); setTimer(() => { if (copied === k) { copied = null; redraw(); } }, 1200); }, () => {}) });
      return h("div", { class: "tc-detail" },
        loading ? h("p", { class: "td-note", role: "status" }, t("tooldetail.loading")) : null,
        body,
        h("button", { class: "tc-run", type: "button", onclick: () => emitReveal({ sid, call: c.id, ts: ts || null }) }, t("calls.openRun")));
    }

    return { el, toggle, isOpen: (sid, call) => open.has(keyOf(sid, call)), forget: (sid) => { stored.delete(sid); } };
  }
  const api = { create };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DeckCallDetail = Object.freeze(api);
})(typeof window !== "undefined" ? window : globalThis);
