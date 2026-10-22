"use strict";
// A bounded, renderer-only turn ledger. All tool payloads remain text previews.
(function (root) {
  const MAX_TURNS = 64, MAX_CALLS = 256, MAX_SESSIONS = 80;
  function preview(v) {
    if (v == null) return "";
    try { return String(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 301); }
    catch { return ""; }
  }
  // "unknown": the link dropped before the call's end was seen; that is not a tool failure.
  const failed = call => !["ok", "running", "unknown"].includes(call.status);
  const nodeLive = n => !!n && n.terminalAt == null && (n.active === true || ["thinking", "working", "searching"].includes(n.state));
  // Readable durations (human.js): "4.2s", "2m 05s", "1h 04m"; a plain seconds fallback when it is not loaded.
  const human = () => root.DeckHuman || (typeof module === "object" && module.exports ? require("./human") : null);
  const dur = ms => human()?.duration(ms) || `${(ms / 1000).toFixed(1)}s`;
  /**
   * `seconds` is null for a group that was not observed from start to end (imported transport history): the Deck
   * does not know when that turn began or ended, so it shows a call count, never a fabricated "Worked Ns".
   */
  function stats(turn, now = Date.now()) {
    return { seconds: turn.measured === false ? null : Math.max(0, Math.round(((turn.end ?? now) - turn.since) / 1000)), tools: turn.calls.length,
      failed: turn.calls.filter(failed).length, running: turn.end == null };
  }
  function createStore() {
    const sessions = new Map();
    let seq = 0;
    function turns(sid) {
      if (!sessions.has(sid)) {
        sessions.set(sid, []);
        while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      }
      return sessions.get(sid);
    }
    const active = sid => { const last = turns(sid).filter(turn => !turn.imported).at(-1); return last && last.end == null ? last : null; };
    function start(sid, at) {
      const list = turns(sid);
      const live = active(sid);
      if (live) return live;
      const turn = { id: `receipt-${++seq}`, since: at, end: null, open: false, calls: [], anchor: null, measured: true, turnId: null };
      list.push(turn);
      while (list.length > MAX_TURNS) list.shift();
      return turn;
    }
    /** Keep at most MAX_CALLS per session: the oldest calls go first; a turn they empty goes too (not the live one). */
    function bound(sid) {
      const list = turns(sid);
      let total = list.reduce((n, turn) => n + turn.calls.length, 0);
      while (total > MAX_CALLS && list.length) {
        const turn = list[0];
        const drop = Math.min(turn.calls.length, total - MAX_CALLS);
        turn.calls.splice(0, drop); total -= drop;
        if (!turn.calls.length && turn !== active(sid)) list.shift();
        else if (!drop) break;
      }
    }
    function find(sid, id) {
      for (const turn of turns(sid)) {
        const call = turn.calls.find(c => c.call === id);
        if (call) return { turn, call };
      }
      return null;
    }
    function finish(sid, at) {
      const turn = active(sid);
      if (!turn) return;
      turn.end = at; turn.open = false;
      // A call without its end event was cut short by the turn's end; its own duration is unknown.
      for (const call of turn.calls) if (call.status === "running") call.status = "interrupted";
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
        turn.calls.push({ call: id || `local-${++seq}`, tool: preview(p.name || p.tool), args: preview(p.arguments ?? p.args ?? p.parameters), ts: at / 1000, status: "running", ms: null, err: null, result: null });
        bound(sid);
      } else {
        const hit = found || { call: active(sid)?.calls.findLast(c => c.status === "running") };
        if (!hit.call) return;
        const reported = p.duration_ms ?? p.ms;
        Object.assign(hit.call, { status: p.status || (p.error || p.is_error ? "error" : "ok"),
          ms: Number.isFinite(reported) ? Math.max(0, reported) : Math.max(0, at - hit.call.ts * 1000),
          err: preview(p.error ?? p.err) || null, result: preview(p.result ?? p.output) || null });
      }
    }
    /**
     * A transport list (deck.tools push, relay `recent`): known calls are updated in place; new calls that started
     * inside the live turn join it; older ones form one closed, unmeasured history group placed before the live turn.
     */
    function replace(sid, rows, at = Date.now()) {
      const incoming = (Array.isArray(rows) ? rows : []).slice(-MAX_CALLS);
      const list = turns(sid);
      let imported = null;
      for (const row of incoming) {
        if (!row || !row.call) continue;
        const hit = find(sid, String(row.call));
        const ts = row.ts != null && row.ts !== "" && Number.isFinite(Number(row.ts)) ? Number(row.ts) : null;
        const call = { call: String(row.call), tool: preview(row.tool), args: preview(row.args), ts,
          status: typeof row.status === "string" && row.status ? row.status.slice(0, 32) : "ok", ms: Number.isFinite(row.ms) ? Math.max(0, row.ms) : null,
          result: preview(row.result) || null, err: preview(row.err) || null };
        if (hit) {
          if (row.args == null) call.args = hit.call.args;
          if (row.ts == null) call.ts = hit.call.ts;
          // A finished call never reopens; one the Deck lost track of ("unknown") may still be running.
          if (!["running", "unknown"].includes(hit.call.status) && call.status === "running") call.status = hit.call.status;
          Object.assign(hit.call, call);
          continue;
        }
        const live = active(sid);
        // A running call belongs to the live turn even when that turn was first seen after the call began.
        if (live && (ts * 1000 >= live.since || (!live.measured && call.status === "running"))) { live.calls.push(call); continue; }
        if (!imported) {
          const since = (ts ?? at / 1000) * 1000;
          let i = list.length;
          while (i > 0 && list[i - 1].since > since) i--;
          // A session watched from here (a sub-agent, a TUI or Telegram run) pushes its list once per call: new calls
          // join the history group next to them, never one group per push (that piled up as "1 tools" receipts).
          // Placement still splits a group by user message.
          imported = list[i - 1]?.imported ? list[i - 1] : list[i]?.imported ? list[i] : null;
          if (!imported) {
            imported = { id: `receipt-${++seq}`, since, end: null, open: false, calls: [], anchor: null, measured: false, imported: true };
            list.splice(i, 0, imported);
          } else if (since < imported.since) imported.since = since;
        }
        imported.calls.push(call);
      }
      // History groups are closed while none of their calls runs (the Deck saw no turn end for them) and open again
      // when a new call of theirs runs. A turn the snapshot follows ends on the snapshot (observe), not here.
      for (const turn of list) {
        if (!turn.imported) continue;
        const running = turn.calls.some(c => c.status === "running");
        if (running) { turn.end = null; continue; }
        if (turn.end == null) turn.open = false;
        turn.end = Math.max(turn.since, ...turn.calls.map(c => c.ts * 1000));
      }
      while (list.length > MAX_TURNS) list.shift();
      bound(sid);
    }
    /**
     * A bridge snapshot node for `sid`. A live node with no live receipt turn starts an unmeasured turn (driven
     * elsewhere: its real start is unknown) that absorbs that session's running calls; a node that is no longer live,
     * or a newer turn id, folds the live turn once. A turn the link lost reopens when its turn id is still live.
     */
    function observe(sid, node, at = Date.now()) {
      if (!sid || !node) return false;
      const live = active(sid), turnId = node.turnId || "";
      if (nodeLive(node)) {
        if (live) {
          // A turn this Deck drives ends on its own events; the snapshot only confirms it runs.
          if (live.measured || live.turnId === turnId) { live.turnId = turnId; live.sawLive = true; return false; }
          finish(sid, at);
        } else {
          const lost = turns(sid).filter(turn => !turn.imported).at(-1);
          if (lost?.lost && lost.turnId === turnId) {
            lost.end = null; lost.lost = false;
            for (const call of lost.calls) if (call.status === "unknown") call.status = "running";
            return true;
          }
        }
        if (!sessions.has(sid) && !turnId) return false;
        const turn = start(sid, at);
        Object.assign(turn, { measured: false, turnId, sawLive: true });
        for (const old of turns(sid)) {
          if (!old.imported) continue;
          const running = old.calls.filter(call => call.status === "running");
          if (!running.length) continue;
          old.calls = old.calls.filter(call => call.status !== "running");
          turn.calls.push(...running);
        }
        turns(sid).splice(0, Infinity, ...turns(sid).filter(t => t.calls.length || t === turn));
        return true;
      }
      // A snapshot that lags behind the Deck's own send is still idle: fold a Deck turn only after it was seen live.
      if (live && (!live.measured || live.sawLive) && !["approval", "question"].includes(node.state)) { finish(sid, at); return true; }
      return false;
    }
    /** The link dropped: fold every live turn in every session; the end of its running calls is unknown. */
    function disconnect(at = Date.now()) {
      let changed = false;
      for (const sid of sessions.keys()) {
        const live = active(sid);
        if (!live) continue;
        live.end = at; live.open = false; live.lost = true; changed = true;
        for (const call of live.calls) if (call.status === "running") call.status = "unknown";
      }
      return changed;
    }
    return { turns, start, finish, event, find, replace, active, observe, disconnect, sessions: () => sessions.size, ids: () => [...sessions.keys()] };
  }
  function receipt({ h, t, sid, turn, select, selected = null }) {
    const totals = stats(turn);
    // "1 tool" / "2 tools": the `.one` form for a single call (en and tr both use it for exactly one)
    const key = totals.running ? "conv.working" : totals.seconds == null ? "conv.receiptCount" : "conv.receipt";
    const label = t(totals.tools === 1 ? `${key}.one` : key, { ...totals, seconds: totals.seconds == null ? null : dur(totals.seconds * 1000) });
    const fold = h("details", { class: "receipt-fold", open: turn.open ? true : null, ontoggle: () => { turn.open = fold.open; } },
      h("summary", { class: "receipt-summary" }, label, totals.failed ? h("span", { class: "receipt-fail" }, t("conv.failed", totals)) : null),
      h("div", { class: "receipt-calls" }, turn.calls.map(call => {
        const active = selected?.sid === sid && selected.call === call.call;
        // the call the turn runs now is marked, not unfolded: following a live turn must not open every call it makes
        const unfold = active && selected.source !== "live";
        const item = h("details", { class: `receipt-call${failed(call) ? " failed" : ""}${active ? " selected" : ""}`, open: unfold || call.open ? true : null,
          dataset: { call: call.call }, ontoggle: () => { call.open = item.open; } },
          // only unfolding picks the call (and lands on it in Run); folding it back leaves Run alone
          h("summary", { onclick: () => { if (!item.open) select(sid, call.call, false); } },
            h("span", { class: call.status === "running" ? "receipt-spinner" : "receipt-dot", "aria-hidden": "true" }),
            h("span", { class: "receipt-tool" }, call.tool), h("code", { class: "receipt-args" }, call.args),
            h("span", { class: "receipt-duration" }, call.ms == null ? "…" : dur(call.ms))),
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
    let session = shell.last("session") || {}, scheduled = false, pendingReveal = null, highlighted = null, highlightTimer = null;
    const sidOf = () => session.sid || (session.kind === "hermes" ? session.id : null);
    const changed = () => { for (const fn of subscribers) { try { fn(); } catch (e) { console.warn("Receipt listener failed", e); } } refresh(); };
    /**
     * Where each receipt goes. A live turn follows the latest user message; an ended turn keeps the anchor it had.
     * Imported history (no observed turn) is split by user-message timestamps (`data-ts`, seconds) and is not shown
     * inline when the transcript has none: the Run tab still lists those calls.
     */
    function placements(sid, users) {
      const parts = [];
      const hermes = session.kind === "hermes";
      const stamps = users.map(el => Number(el.dataset.ts));
      const userAt = ts => {
        if (!Number.isFinite(ts)) return null;
        let hit = null;
        users.forEach((el, i) => { if (el.dataset.ts && Number.isFinite(stamps[i]) && stamps[i] <= ts) hit = el; });
        return hit;
      };
      for (const turn of store.turns(sid)) {
        // A Hermes chat shows each call under the thought that made it while the turn runs, and the live row says what
        // runs now: the receipt waits for the turn's end (a summary), unless the reader opened one of its calls.
        const waiting = hermes && turn.end == null && !turn.open;
        if (waiting && turn.measured) continue;
        // a turn followed from the snapshot takes part even before its first call: it holds its user turn's receipt
        if (!turn.calls.length && !waiting) continue;
        if (!turn.imported) {
          // Fixed at first placement (calls arrive after the user's message is on screen), so a later steer or
          // queued message never pulls an earlier turn's receipt; a turn seen only via snapshots uses timestamps
          // (provisional while it still runs: the calls it absorbs may be older).
          let el = turn.anchor ? users.find(u => u.dataset.convKey === turn.anchor) : null;
          if (!turn.anchor) {
            const times = turn.calls.map(call => call.ts).filter(Number.isFinite);
            el = turn.measured ? users.at(-1) : times.length ? userAt(Math.min(...times)) : waiting ? users.at(-1) : null;
            if (el && !waiting) turn.anchor = el.dataset.convKey;
          }
          if (el || (turn.measured && !users.length)) parts.push({ turn, anchor: el || null, calls: turn.calls });
          continue;
        }
        const groups = new Map();
        for (const call of turn.calls) {
          const el = userAt(call.ts);
          if (!el) continue;
          if (!groups.has(el)) groups.set(el, []);
          groups.get(el).push(call);
        }
        for (const [el, calls] of groups) parts.push({ turn, anchor: el, calls });
      }
      // ONE receipt per user turn: every turn, snapshot-followed run and history group placed under the same user
      // message is summed up in one receipt (a long autonomous run is many of them, and listing each piled up a row of
      // "1 tools" receipts under the work stretch). It waits while any part of that user turn still runs.
      const byAnchor = new Map();
      for (const part of parts) {
        if (!byAnchor.has(part.anchor)) byAnchor.set(part.anchor, []);
        byAnchor.get(part.anchor).push(part);
      }
      const out = [];
      for (const [anchor, list] of byAnchor) {
        const turns = [...new Set(list.map(part => part.turn))];
        if (hermes && !turns.some(turn => turn.open) && turns.some(turn => turn.end == null)) continue;
        const calls = list.flatMap(part => part.calls);
        if (!calls.length) continue;
        const turn = list.length === 1 && list[0].calls === list[0].turn.calls ? list[0].turn : combined(list[0].turn.id + (anchor ? `@${anchor.dataset.convKey}` : ""), turns, calls);
        out.push({ key: turn.id, turn, anchor: anchor || undefined, calls });
      }
      return out;
    }
    /** The parts of one user turn as one receipt turn: their calls, their span, and one fold shared by all of them. */
    function combined(id, turns, calls) {
      const ends = turns.map(turn => turn.end);
      const turn = { id, since: Math.min(...turns.map(t => t.since)), end: ends.includes(null) ? null : Math.max(...ends), calls,
        measured: turns.every(t => t.measured !== false) };
      return Object.defineProperty(turn, "open", { enumerable: true, get: () => turns.some(t => t.open), set: value => { for (const t of turns) t.open = value; } });
    }
    const after = el => { let next = el.nextElementSibling; while (next?.matches(".receipt")) next = next.nextElementSibling; return next; };
    function paint() {
      scheduled = false;
      const sid = sidOf();
      const users = [...inner.querySelectorAll(".msg.out:not(.outbox):not(.sysmsg)")];
      const wanted = sid ? placements(sid, users) : [];
      const keep = new Set();
      for (const { key, turn, anchor } of wanted) {
        const selected = controller.selection();
        const sig = JSON.stringify([turn.calls, turn.end, turn.open, turn.measured, selected, t("conv.inspect")]);
        let cached = nodes.get(key);
        if (!cached || cached.sig !== sig) {
          const el = receipt({ h, t, sid, turn, selected, select: (s, c, inspect) => { controller.select(s, c, inspect); refresh(); } });
          if (cached?.el.isConnected) cached.el.replaceWith(el);
          nodes.delete(key);
          nodes.set(key, cached = { sig, el });
          while (nodes.size > MAX_TURNS * 2) nodes.delete(nodes.keys().next().value);
        }
        keep.add(cached.el);
        // After this turn's work (messages that called tools or only thought: the transcript shows each call where it
        // was made) and before the prose that follows it; with no such message, before the final prose. Never in
        // another user's turn: the receipt sums the work up, it does not split it.
        let target = anchor ? anchor.nextElementSibling : inner.firstElementChild || null, last = null, afterWork = null, worked = false;
        while (target && !target.matches(".msg.out:not(.outbox)")) {
          if (target.matches(".msg.work")) { worked = true; afterWork = null; }
          else if (target.matches(".msg:not(.out):not(.sysmsg)")) { last = target; if (!afterWork) afterWork = target; }
          target = target.nextElementSibling;
        }
        const ref = (worked ? afterWork : last) || target || inner.querySelector(".livebar, .outbox, .conv-wait") || null;
        if (cached.el.parentNode !== inner || after(cached.el) !== ref) inner.insertBefore(cached.el, ref);
      }
      for (const el of inner.querySelectorAll(".receipt")) if (!keep.has(el)) el.remove();
      doc.dispatchEvent(new root.CustomEvent("deck-receipts-render"));
      if (highlighted) receiptFor(highlighted)?.el.classList.add("receipt-reveal");
      revealStep();
    }
    // Compare opaque call ids as strings, never interpolate them into a selector.
    function receiptFor({ sid, call }) {
      for (const el of inner.querySelectorAll(".receipt")) {
        if (el.dataset.sid !== sid) continue;
        const row = [...el.querySelectorAll(".receipt-call")].find(node => node.dataset.call === call);
        if (row) return { el, row };
      }
      return null;
    }
    function revealResult(detail, status) {
      doc.dispatchEvent(new root.CustomEvent("deck-tool-reveal-result", { detail: { sid: detail.sid, call: detail.call, status } }));
    }
    function finishReveal(status) {
      const want = pendingReveal;
      if (!want) return;
      root.clearTimeout(want.timer);
      pendingReveal = null;
      revealResult(want, status);
    }
    function clearHighlight() {
      root.clearTimeout(highlightTimer);
      highlighted = null;
      for (const el of inner.querySelectorAll(".receipt-reveal")) el.classList.remove("receipt-reveal");
    }
    /**
     * Last resort when the receipt itself cannot be placed: the loaded user message the call was made under (latest
     * `data-ts` at or before the call). Needs a real call time and a loaded message that precedes it.
     */
    function nearestMessage(ts) {
      if (!Number.isFinite(ts)) return null;
      const users = [...inner.querySelectorAll(".msg.out[data-ts]")].map(el => ({ el, at: Number(el.dataset.ts) })).filter(u => Number.isFinite(u.at));
      return users.filter(u => u.at <= ts).at(-1)?.el || null;
    }
    const loadedFrom = () => Math.min(...[...inner.querySelectorAll(".msg.out[data-ts]")].map(el => Number(el.dataset.ts)).filter(Number.isFinite));
    function giveUp(ts) {
      const el = nearestMessage(ts);
      if (!el) { finishReveal("missing"); return; }
      clearHighlight();
      el.classList.add("receipt-reveal");
      root.DeckTimeline?.reveal(el);
      highlightTimer = root.setTimeout(clearHighlight, 1800);
      finishReveal("nearby");
    }
    function revealStep() {
      if (!pendingReveal || pendingReveal.sid !== sidOf()) return;
      const hit = receiptFor(pendingReveal);
      if (hit) {
        hit.el.querySelector(".receipt-fold").open = true;
        hit.row.open = true;
        clearHighlight();
        highlighted = { sid: pendingReveal.sid, call: pendingReveal.call };
        hit.el.classList.add("receipt-reveal");
        root.DeckTimeline?.reveal(hit.el);
        highlightTimer = root.setTimeout(clearHighlight, 1800);
        finishReveal("found");
        return;
      }
      const known = store.find(pendingReveal.sid, pendingReveal.call)?.call;
      const ts = Number.isFinite(known?.ts) ? known.ts : pendingReveal.ts;
      const older = inner.querySelector('[data-fk="h-older"]');
      if (!older || inner.querySelector(".hist-err")) { giveUp(ts); return; }
      // Imported calls need a real timestamp; without one (and unknown to the store) there is nothing to page toward.
      if (!Number.isFinite(ts)) { finishReveal("missing"); return; }
      // The call's time is already covered by the loaded messages yet no receipt was placed: paging cannot help.
      if (loadedFrom() <= ts) { giveUp(ts); return; }
      if (pendingReveal.requested?.isConnected || older.disabled) {
        if (!pendingReveal.timer) pendingReveal.timer = root.setTimeout(() => giveUp(ts), 15000);
        return;
      }
      root.clearTimeout(pendingReveal.timer);
      pendingReveal.requested = older;
      pendingReveal.timer = root.setTimeout(() => giveUp(ts), 15000);
      revealResult(pendingReveal, "loading");
      // Reuse app.js's read-only pagination and its cache/offset/merge path. Only this explicit action chains pages.
      older.click();
    }
    doc.addEventListener("deck-tool-reveal", e => {
      const d = e.detail;
      if (!d?.sid || !d.call || d.sid !== sidOf()) return;
      finishReveal("cancelled");
      const turn = store.find(d.sid, d.call)?.turn;
      if (turn) turn.open = true;
      controller.select(d.sid, d.call, false, "run");
      pendingReveal = { sid: d.sid, call: d.call, ts: Number.isFinite(Number(d.ts)) && d.ts !== null && d.ts !== "" ? Number(d.ts) : null, requested: null, timer: null };
      refresh();
    });
    function refresh() { if (!scheduled) { scheduled = true; root.requestAnimationFrame(paint); } }
    function ingest(sid, type, payload, at) {
      // A watched gateway sub-agent's mirrored tool events (Hermes ids "submirror:<child>:<n>") only feed the live row:
      // that child's calls arrive with their real ids in its deck.tools push, and counting both doubled them.
      if (/^tool\./.test(type) && /^submirror:/.test(String(payload?.tool_id || ""))) return;
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
      if (m.t === "event" && m.type === "deck.tools" && typeof m.sid === "string") { store.replace(m.sid, m.payload?.tools); changed(); }
      if (m.t === "snapshot" && Array.isArray(m.snapshot?.nodes)) {
        let any = false;
        const seen = new Set();
        for (const n of m.snapshot.nodes) if (n && typeof n.sid === "string") { seen.add(n.sid); any = store.observe(n.sid, n) || any; }
        // A session that left the snapshot is no longer running there.
        for (const sid of store.ids()) if (!seen.has(sid) && store.active(sid) && !store.active(sid).measured) { store.finish(sid, Date.now()); any = true; }
        if (any) changed();
      }
      if (m.t === "status" && m.status !== "open" && store.disconnect()) changed();
    });
    deck.onRelay?.(m => {
      for (const e of m.evs || []) {
        if (e.ev === "tool_start") ingest(e.sid, "tool.start", { ...e, name: e.tool, tool_id: e.call }, e.ts * 1000);
        if (e.ev === "tool_end") ingest(e.sid, "tool.complete", { ...e, tool_id: e.call }, e.ts * 1000);
        if (e.ev === "turn_start") ingest(e.sid, "message.start", e, e.ts * 1000);
        if (e.ev === "turn_end" || e.ev === "stopped") ingest(e.sid, "message.complete", e, e.ts * 1000);
      }
    });
    /**
     * Previews for the opened session: the direct connection's latest deck.tools list, else the relay's `recent`.
     * Each source failing on its own keeps the other; results are stored under the session they were asked for.
     */
    async function load() {
      const sid = sidOf(), profile = session.profile;
      if (!sid) return;
      for (const read of [() => deck.bridge?.toolCalls?.(sid, { profile }), async () => (await deck.session?.(sid))?.recent]) {
        try {
          const calls = await read();
          if (Array.isArray(calls) && calls.length) { store.replace(sid, calls); changed(); return; }
        } catch (e) { console.warn("Receipt previews unavailable", e); }
      }
    }
    shell.on("session", s => { finishReveal("cancelled"); clearHighlight(); session = s; refresh(); load(); });
    const publicApi = { refresh, turns: store.turns, calls: sid => store.turns(sid).flatMap(turn => turn.calls), selection: controller.selection,
      subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); } };
    refresh(); load();
    return publicApi;
  }
  const api = { createStore, stats, preview, failed, receipt, createController, mount, MAX_TURNS, MAX_CALLS, MAX_SESSIONS };
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.DeckReceiptLogic = Object.freeze(api);
    root.DeckReceipts = mount(root.DeckShell, root.deck);
  }
})(typeof window === "object" ? window : globalThis);
