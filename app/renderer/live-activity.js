"use strict";
// The live "working" row of the Hermes chat (window.DeckLiveActivity): while the selected session works, ONE
// assistant-side row sits where the next message will appear and says, in a few words, what the model is doing
// (Thinking… / Running <tool> / Writing… / Waiting for approval), with the elapsed time and a "Show thinking"
// disclosure. It never carries message text: message.delta keeps rendering as its own bubble in app.js, so the row
// cannot duplicate the reply.
//  - Sources, in priority: the live bridge events of a turn this Deck drives (reduce()), else the snapshot node of a
//    turn driven elsewhere (TUI, Telegram): its state and last step names.
//  - The disclosure shows the streamed reasoning (reasoning.delta, bounded tail) when Hermes sends it, else the step
//    log of the turn (tool names), never an error text. reasoning.available is the reply text, never shown here.
//  - row() builds the element and remembers its parts, so patch() can update label/text in place on every reasoning
//    token without rebuilding the transcript.
(() => {
  const measured = new Map();
  let lastView = null;
  function emit(name, detail) {
    if (typeof document === "object" && typeof CustomEvent === "function") document.dispatchEvent(new CustomEvent(name, { detail }));
  }
  const MAX_THINK = 12000; // characters of reasoning kept (the tail)
  const MAX_STEPS = 12;
  const STALE_MS = 15000; // event state with no event for this long and no live node is over
  const SEARCH_RE = /search|browse|web_|fetch|crawl|lookup/i;

  /** A fresh per-turn state. */
  const fresh = (at) => ({ phase: "thinking", tool: "", arg: "", since: at, lastAt: at, think: "", steps: [], done: false });

  /** Append streamed reasoning text, keeping the tail. */
  function addThink(st, text) {
    const t = String(text || "");
    if (!t) return false;
    st.think += t;
    if (st.think.length > MAX_THINK) st.think = st.think.slice(-MAX_THINK);
    return true;
  }

  function addStep(st, name) {
    const n = String(name || "").slice(0, 96);
    if (!n) return;
    const last = st.steps[st.steps.length - 1];
    if (last && last.name === n && !last.done) return;
    st.steps.push({ name: n, done: false });
    if (st.steps.length > MAX_STEPS) st.steps.splice(0, st.steps.length - MAX_STEPS);
  }

  /**
   * One bridge event into the per-turn state. Returns [nextState|null, changed]. null = the turn is over (the row
   * goes). Types this row does not care about return the state unchanged.
   */
  function reduce(st, type, p, at) {
    const pl = p || {};
    switch (type) {
      case "local.sent": // the Deck just submitted a prompt: show "Thinking…" before Hermes' first event arrives
        return [st && !st.done ? st : fresh(at), !st || st.done];
      case "message.start":
        return [st && !st.done ? { ...st, lastAt: at } : fresh(at), !st || st.done];
      case "thinking.delta": {
        // Hermes clears its spinner with an empty text at every API call boundary: not a phase change
        if (!String(pl.text || "").trim()) return [st, false];
        const s = st && !st.done ? st : fresh(at);
        const changed = s.phase !== "thinking" && s.phase !== "tool";
        if (s.phase !== "tool") s.phase = "thinking";
        s.lastAt = at;
        return [s, changed || !st];
      }
      // reasoning.available is NOT reasoning: Hermes sends the assistant's visible text under that name
      // (agent/turn_response_intake.py _relay_thinking), so it would repeat the reply. Ignored (default branch).
      case "reasoning.delta": {
        const s = st && !st.done ? st : fresh(at);
        const added = addThink(s, pl.text);
        if (s.phase === "writing") s.phase = "thinking";
        s.lastAt = at;
        return [s, added || !st];
      }
      case "message.delta":
      case "message.interim": {
        if (!st || st.done) return [fresh(at), true];
        const changed = st.phase !== "writing";
        st.phase = "writing";
        st.tool = "";
        st.arg = "";
        st.lastAt = at;
        return [st, changed];
      }
      case "tool.generating":
      case "tool.start": {
        const s = st && !st.done ? st : fresh(at);
        const name = String(pl.name || "").slice(0, 96);
        const changed = s.phase !== "tool" || s.tool !== name;
        s.phase = "tool";
        s.tool = name;
        s.arg = previewArg(pl.arguments ?? pl.args ?? pl.parameters);
        if (type === "tool.start" || !s.steps.length || s.steps[s.steps.length - 1].name !== name) addStep(s, name);
        s.lastAt = at;
        return [s, changed || !st];
      }
      case "tool.complete": {
        if (!st || st.done) return [st, false];
        const last = st.steps[st.steps.length - 1];
        if (last) last.done = true;
        st.phase = "thinking";
        st.tool = "";
        st.arg = "";
        st.lastAt = at;
        return [st, true];
      }
      case "status.update": {
        if (!st || st.done || pl.kind !== "compacting") return [st, false];
        st.phase = "compacting";
        st.lastAt = at;
        return [st, true];
      }
      case "message.complete":
        return [null, !!st];
      default:
        if (typeof type === "string" && type.includes("error")) return [null, !!st];
        return [st, false];
    }
  }

  /** What the snapshot says a turn driven elsewhere is doing: {phase, tool}. */
  function fromNode(n) {
    const steps = Array.isArray(n && n.steps) ? n.steps : [];
    const last = steps[steps.length - 1] || "";
    if (n && n.state === "searching") return { phase: "searching", tool: "" };
    if (n && n.state === "working" && last && last !== "Thinking") return { phase: "tool", tool: last };
    return { phase: "thinking", tool: "" };
  }

  /** The label of a phase as {key, vars}. */
  function label(phase, tool) {
    if (phase === "approval") return { key: "live.approval", vars: {} };
    if (phase === "question") return { key: "live.question", vars: {} };
    if (phase === "writing") return { key: "live.writing", vars: {} };
    if (phase === "compacting") return { key: "live.compacting", vars: {} };
    if (phase === "searching" || (phase === "tool" && SEARCH_RE.test(tool))) return { key: "live.searching", vars: {} };
    if (phase === "tool" && tool) return { key: "live.tool", vars: { tool } };
    return { key: "live.thinking", vars: {} };
  }

  function previewArg(value) {
    if (value == null) return "";
    try { return (typeof value === "string" ? value : JSON.stringify(value)).slice(0, 300); }
    catch { return ""; }
  }

  function create(ctx) {
    const { h, i18nText, ticker, store, now = () => Date.now(), onToggle = () => {} } = ctx;
    const displayLabel = (v) => v.phase === "tool" && v.tool ? i18nText("conv.running", { tool: v.tool }) : i18nText(v.label.key, v.label.vars);
    const raf = ctx.raf || ((fn) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : fn()));
    const turns = new Map(); // sid -> per-turn event state
    const seen = new Map(); // sid -> {turnId, at}: when a turn driven elsewhere was first seen live
    // sid -> {at, turnId}: a turn whose end the events reported. A snapshot lags up to a few seconds and may still
    // call that turn live; the row must not come back for it (only for a newer turn id).
    const ended = new Map();
    const ENDED_MS = 60000;
    let open = !!(store && store.get("deck.live.thinking") === "1");
    let built = null; // {sid, el, labelEl, bodyEl, textEl, key, pinned}

    /** What the row shows for a session now, or null. request: "approval" | "question" | null (an open request). */
    function view(sid, { node = null, live = false, request = null } = {}) {
      const at = now();
      let st = turns.get(sid) || null;
      // a quiet turn the snapshot calls idle is over; one the snapshot does not list yet (a new session) gets longer
      if (st && !live && !request && at - st.lastAt > (node && !node.fresh ? STALE_MS : STALE_MS * 4)) {
        turns.delete(sid);
        st = null;
      }
      if (!st && !request && live && ended.has(sid)) {
        const e = ended.get(sid);
        const turn = (node && node.turnId) || "";
        if (e.turnId === null) e.turnId = turn;
        if (e.turnId === turn && at - e.at < ENDED_MS) return null;
        ended.delete(sid);
      } else if (!live) ended.delete(sid);
      if (!st && !live && !request) return null;
      let since = st ? st.since : 0;
      let phase;
      let tool = "";
      if (st) {
        phase = st.phase;
        tool = st.tool;
      } else {
        ({ phase, tool } = fromNode(node));
        const turn = (node && node.turnId) || "";
        const s = seen.get(sid);
        if (!s || s.turnId !== turn) seen.set(sid, { turnId: turn, at });
        since = seen.get(sid).at;
      }
      if (request === "approval" || request === "question") phase = request;
      const steps = st ? st.steps.map((x) => x.name) : (node && Array.isArray(node.steps) ? node.steps.filter((x) => x !== "Thinking").slice(-MAX_STEPS) : []);
      return { sid, phase, tool, arg: st ? st.arg : "", since, think: st ? st.think : "", steps, source: st ? "events" : "snapshot", label: label(phase, tool), node };
    }

    /** "Show thinking" on/off: remembered, and the caller asks Hermes for reasoning of the sessions it drives. */
    function setOpen(value) {
      open = !!value;
      if (store) store.set("deck.live.thinking", open ? "1" : "");
      onToggle(open);
    }

    function bodyKids(v) {
      if (v.think) return [h("p", { class: "la-think" }, v.think)];
      if (v.steps.length) return [h("ol", { class: "la-steps" }, v.steps.map((s, i) => h("li", { class: i === v.steps.length - 1 && v.phase === "tool" ? "now" : "" }, s)))];
      return [h("p", { class: "la-none" }, i18nText("live.nothingYet"))];
    }

    function follow(b) {
      if (!b || !b.bodyEl || !b.pinned) return;
      raf(() => { if (b.bodyEl.isConnected) b.bodyEl.scrollTop = b.bodyEl.scrollHeight; });
    }

    /** The row element for a view (or null). */
    function row(v) {
      emit("deck-conversation-live", { sid: v?.sid || built?.sid, view: v });
      lastView = v;
      if (!v) {
        built = null;
        return null;
      }
      const entering = !built || built.sid !== v.sid;
      const labelEl = h("span", { class: "la-label" }, displayLabel(v));
      const body = open || v.think ? h("div", { class: "la-body", "aria-live": "off", tabindex: "0" }, bodyKids(v)) : null;
      const b = { sid: v.sid, labelEl, bodyEl: body, key: `${open}|${v.think ? "t" : v.steps.length ? "s" : "n"}`, pinned: entering || !built || built.pinned };
      if (body) {
        body.addEventListener("scroll", () => { b.pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 12; }, { passive: true });
        // a reader who scrolled up keeps their place when the transcript re-renders
        const prevTop = !b.pinned && built && built.bodyEl ? built.bodyEl.scrollTop : 0;
        if (prevTop) raf(() => { body.scrollTop = prevTop; });
      }
      const toggle = h("button", {
        class: "la-toggle", type: "button", "aria-expanded": open ? "true" : "false", dataset: { fk: "la-toggle" },
        onclick: () => setOpen(!open),
      }, i18nText(open ? "live.hideThinking" : "live.showThinking"));
      b.el = h("div", { class: `livebar ph-${v.phase}${entering ? " la-enter" : ""}${open ? " open" : ""}`, dataset: { sid: v.sid } },
        h("div", { class: "la-head", role: "status" },
          h("span", { class: "la-dot", "aria-hidden": "true" }),
          labelEl,
          b.argEl = h("code", { class: "la-arg" }, v.arg || ""),
          v.since ? h("span", { class: "la-time" }, ticker(Math.floor(v.since / 1000))) : null,
          toggle),
        body);
      built = b;
      follow(b);
      return b.el;
    }

    /** Update the row on screen in place; false when it is not there or needs a rebuild (caller re-renders). */
    function patch(v) {
      emit("deck-conversation-live", { sid: v?.sid || built?.sid, view: v });
      lastView = v;
      const b = built;
      const shown = !!(b && b.el.isConnected);
      if (!v) return !shown; // nothing to show and nothing shown: done; a row to remove needs a rebuild
      if (!shown || b.sid !== v.sid) return false;
      const key = `${open}|${v.think ? "t" : v.steps.length ? "s" : "n"}`;
      if (key !== b.key) return false;
      b.el.className = `livebar ph-${v.phase}${open ? " open" : ""}`;
      b.labelEl.textContent = displayLabel(v);
      if (b.argEl) b.argEl.textContent = v.arg || "";
      if (b.bodyEl) {
        b.bodyEl.replaceChildren(...bodyKids(v));
        follow(b);
      }
      return true;
    }

    return {
      /** Feed one event; true when the row would change. */
      event(sid, type, payload) {
        if (!sid) return false;
        const at = now();
        const prior = turns.get(sid) || null;
        const [next, changed] = reduce(prior, type, payload, at);
        if (next && (!prior || prior.done)) measured.set(sid, { ms: 0, since: null });
        const clock = measured.get(sid);
        if (clock) {
          const thinking = next && (next.phase === "thinking" || next.phase === "searching");
          if (!thinking && clock.since != null) { clock.ms += at - clock.since; clock.since = null; }
          else if (thinking && clock.since == null) clock.since = at;
        }
        if (measured.size > 80) measured.delete(measured.keys().next().value);
        emit("deck-conversation-turn", { sid, type, payload, at });
        if (next) {
          turns.set(sid, next);
          ended.delete(sid);
        } else {
          if (turns.has(sid) || type === "message.complete") ended.set(sid, { at: now(), turnId: null });
          turns.delete(sid);
        }
        return changed;
      },
      /** The turn was stopped or Hermes said none runs: drop the row now (and keep it dropped for that turn). */
      end(sid) {
        emit("deck-conversation-turn", { sid, type: "local.stopped", payload: {}, at: now() });
        const had = turns.delete(sid);
        seen.delete(sid);
        ended.set(sid, { at: now(), turnId: null });
        return had;
      },
      clear() {
        turns.clear();
        seen.clear();
        ended.clear();
      },
      has: (sid) => turns.has(sid),
      /** The streamed reasoning of the running turn ("" when none); read before message.complete drops it. */
      think: (sid) => (turns.get(sid) || {}).think || "",
      isOpen: () => open,
      setOpen,
      view,
      row,
      patch,
    };
  }

  const api = { create, reduce, label, fromNode, previewArg, lastView: () => lastView, thoughtSeconds: sid => measured.has(sid) ? Math.round(measured.get(sid).ms / 1000) : null, MAX_THINK, MAX_STEPS, STALE_MS };
  if (typeof window !== "undefined") window.DeckLiveActivity = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
