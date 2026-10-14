"use strict";
// Blend Work pane. Renderer-only dependencies are injected for offline tests.
(function (root) {
  const number = v => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  function planSummary(plan) {
    if (!plan || !Array.isArray(plan.items)) return null;
    return { done: plan.items.filter(x => x.state === "done").length,
      total: Math.max(plan.items.length, number(plan.total) || 0), shown: plan.items.length,
      active: plan.items.some(x => x.state === "active") };
  }
  const failed = c => c.status !== "ok" && c.status !== "running" && c.status !== "interrupted";
  const stamp = ts => number(ts) === null ? null : ts > 1e12 ? ts : ts * 1000;
  function runStats(calls, data = {}) {
    return { calls: calls.length, time: calls.reduce((n, c) => n + (number(c.ms) || 0), 0),
      failed: calls.filter(failed).length, running: calls.filter(c => c.status === "running").length,
      cost: number(data.costUsd) ?? number(data.cost) };
  }
  function timingBars(calls, now = Date.now()) {
    const spans = calls.map(c => { const start = stamp(c.ts); return { start, ms: number(c.ms) ?? (c.status === "running" && start !== null ? Math.max(0, now - start) : 0) }; });
    const starts = spans.filter(x => x.start !== null).map(x => x.start);
    const origin = starts.length ? Math.min(...starts) : 0;
    const end = Math.max(origin + 1, ...spans.map(x => (x.start ?? origin) + x.ms));
    return spans.map(x => ({ left: 100 * ((x.start ?? origin) - origin) / (end - origin), width: 100 * x.ms / (end - origin) }));
  }
  // Previews may be clipped JSON. Never guess a path or claim a complete diff from one.
  function object(value) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return {};
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed : {}; }
    catch { return {}; }
  }
  // A clipped JSON document may still contain a complete path string. Decode only a closed JSON string token.
  function previewPath(value, fields = "path|file_path", array = false) {
    if (typeof value !== "string") return null;
    const pattern = new RegExp('"(?:' + fields + ')"\\s*:\\s*' + (array ? '\\[\\s*' : '') + '"((?:[^"\\\\]|\\\\.)*)"');
    const match = pattern.exec(value.slice(0, 300));
    if (!match) return null;
    try { return JSON.parse(`"${match[1]}"`); } catch { return null; }
  }
  function diffPathPreview(value) {
    if (typeof value !== "string") return null;
    let text = value;
    // Serialized diffs contain escaped newlines. Decode the complete prefix only, and discard its last partial line.
    const encoded = /"diff"\s*:\s*"((?:[^"\\]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*)/.exec(value);
    if (encoded) {
      try { text = JSON.parse(`"${encoded[1]}"`).split("\n").slice(0, -1).join("\n"); }
      catch { return null; }
    }
    return /^(?:--- a\/|\+\+\+ b\/)([^\r\n\t]+)/m.exec(text)?.[1] || null;
  }
  /** One successful patch/write_file call -> { path, added, removed } (counts only from a complete preview diff), or null. */
  function writeTarget(c) {
    if (!c || c.status !== "ok" || !/(^|[.:_])(?:patch|write_file)$/.test(c.tool || "")) return null;
    const args = object(c.args), result = object(c.result);
    if (result.success === false || result.error || result.isError === true) return null;
    const path = [args.path, args.file_path, previewPath(c.args), result.files_modified?.[0],
      previewPath(c.result, "files_modified", true), result.resolved_path, previewPath(c.result, "resolved_path"),
      result.path, previewPath(c.result, "path"), diffPathPreview(result.diff || c.result)]
      .find(value => typeof value === "string" && value && !/[\n\r\0…<>]/.test(value));
    if (!path || !path.split(/[\\/]/).pop()) return null;
    let added = null, removed = null;
    const diff = typeof result.diff === "string" ? result.diff : typeof c.result === "string" && /^--- /m.test(c.result) ? c.result : "";
    if (diff && !diff.includes("…") && /^@@ /m.test(diff)) {
      added = diff.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++")).length;
      removed = diff.split("\n").filter(l => l.startsWith("-") && !l.startsWith("---")).length;
    }
    return { path, added, removed };
  }
  function changedFiles(calls) {
    const files = new Map();
    for (const c of calls) {
      const target = writeTarget(c);
      if (!target) continue;
      // Paths stay text; this summary keys files by basename, whether relative or absolute.
      const name = target.path.split(/[\\/]/).pop(), { added, removed } = target;
      const prev = files.get(name);
      files.set(name, { name, added: added === null ? prev?.added ?? null : (prev?.added || 0) + added,
        removed: removed === null ? prev?.removed ?? null : (prev?.removed || 0) + removed });
    }
    return [...files.values()];
  }
  /** Agent-written entries from the timestamped live tail; leading partial entries and tool continuations are dropped. */
  function agentNotes(text) {
    if (typeof text !== "string") return "";
    const entries = [];
    let lines = null;
    const finish = () => { const body = lines?.join("\n").trim(); if (body) entries.push(body); };
    for (const line of text.split(/\r?\n/)) {
      const entry = /^\d{2}:\d{2}:\d{2}\s+([^\s|]+)\s*\| ?(.*)$/.exec(line);
      if (entry) {
        finish();
        lines = ["assistant", "final", "think"].includes(entry[1]) ? [entry[2]] : null;
      } else if (lines) lines.push(line);
    }
    finish();
    return entries.join("\n\n");
  }
  function agentRows(agents) {
    const list = agents.filter(a => a && a.id).slice(0, 128), ids = new Set(list.map(a => a.id)), seen = new Set(), out = [];
    function walk(a, depth) {
      if (seen.has(a.id)) return;
      seen.add(a.id); out.push({ agent: a, depth: Math.min(depth, 3) });
      for (const child of list) if (child.parentId === a.id) walk(child, depth + 1);
    }
    for (const a of list) if (!a.parentId || !ids.has(a.parentId)) walk(a, 0);
    for (const a of list) walk(a, 0);
    return out;
  }
  // --- relay-sourced sub-agents (works for sessions this Deck does not own, and for finished children)
  const RELAY_STATE = { running: "running", done: "completed", failed: "failed", stopped: "interrupted", idle: "queued" };
  const notOwned = e => /not owned|session not found|\b4001\b/i.test(String(e && e.message || e || ""));
  const mod = (path, name) => () => typeof module === "object" && module.exports ? require(path) : root[name];
  const human = mod("./human", "DeckHuman"), activity = mod("./activity-view", "DeckActivity"), usage = mod("./usage-view", "DeckUsage");
  /**
   * Elapsed time of one relay child: a finished child's own measured run (sub_stop ms); a live one counts from its own
   * first event to now; anything else spans its first to its last event. Never the parent's clock.
   */
  function relayElapsedMs(c, now = Date.now() / 1000) {
    if (number(c.ms) !== null) return c.ms;
    if (number(c.firstTs) === null) return null;
    if (c.state === "running" && !c.stale) return Math.max(0, (now - c.firstTs) * 1000);
    return number(c.lastTs) !== null ? Math.max(0, (c.lastTs - c.firstTs) * 1000) : null;
  }
  function relayAgents(children, now = Date.now() / 1000) {
    return (Array.isArray(children) ? children : []).filter(c => c && c.sid).slice(0, 128).map(c => {
      const ms = relayElapsedMs(c, now);
      const tk = c.tokens && typeof c.tokens === "object" ? { input: number(c.tokens.in) || 0, output: number(c.tokens.out) || 0, cache_read: number(c.tokens.cr) || 0, cache_write: number(c.tokens.cw) || 0 } : null;
      return { id: c.sa || c.sid, childSid: c.sid, goal: c.goal || c.role || "", model: c.route?.model || c.model || "", effort: c.route?.effort || "",
        category: c.route?.category || "", status: RELAY_STATE[c.state] || "unknown", elapsedS: ms === null ? null : ms / 1000, toolCount: number(c.ntools),
        tokens: tk, summary: c.summary || "", acceptingSteer: false, relayOnly: true, row: c };
    });
  }
  const present = (a, b) => a === undefined || a === null || a === "" ? b : a;
  // Hermes' roster reports elapsed as now - started for every listed child, so a finished child's figure keeps
  // growing; the relay's measured run time wins for those.
  const settled = b => b && b.status !== "running" && b.status !== "queued";
  /** Bridge rows win (live controls, tree); relay rows add finished children and fill goal/model/summary/tokens/counts. */
  function mergeRoster(relayRows, bridgeRows) {
    const relay = relayRows || [], seen = new Set();
    const out = (bridgeRows || []).map(b => {
      const r = relay.find(x => (x.id === b.id) || (b.childSid && x.childSid === b.childSid));
      if (r) seen.add(r);
      return r ? { ...b, goal: present(b.goal, r.goal), model: present(b.model, r.model), effort: present(b.effort, r.effort), childSid: present(b.childSid, r.childSid),
        summary: present(b.summary, r.summary), tokens: present(b.tokens, r.tokens), toolCount: present(b.toolCount, r.toolCount),
        elapsedS: settled(b) && number(r.elapsedS) !== null ? r.elapsedS : present(b.elapsedS, r.elapsedS), row: r.row } : b;
    });
    for (const r of relay) if (!seen.has(r)) out.push(r);
    return out.slice(0, 128);
  }
  // --- Run tab: history turns (oldest first) plus live calls; unknown live calls join the newest turn
  function groupTurns(turns, live) {
    const out = (Array.isArray(turns) ? turns : []).map(t => ({ ...t, calls: (t.calls || []).slice() }));
    const index = new Map();
    out.forEach((t, ti) => t.calls.forEach((c, ci) => index.set(c.call, [ti, ci])));
    const extra = [];
    for (const c of live || []) {
      const at = index.get(c.call);
      if (at) out[at[0]].calls[at[1]] = { ...out[at[0]].calls[at[1]], ...c };
      else extra.push(c);
    }
    if (extra.length) {
      if (out.length) out[out.length - 1].calls.push(...extra);
      else out.push({ id: "live", ts: stamp(extra[0].ts) === null ? null : stamp(extra[0].ts) / 1000, text: "", calls: extra });
    }
    return out;
  }
  const canSteer = agent => agent?.status === "running" && agent.acceptingSteer === true;
  const STEER_MAX = 32000;
  // Lane C validates again in main; this keeps the failure inline and the draft intact.
  const steerError = text => !String(text || "").trim() ? "work.steerEmpty" : String(text).length > STEER_MAX ? "work.steerTooLong" : null;
  // A child that left the live tree has ended for this view: a late tail may update its text, never revive it.
  const ended = a => a && { ...a, status: a.status === "running" || a.status === "queued" ? "" : a.status, acceptingSteer: false };
  // Inline call detail (tool-detail.js) and file diffs (diff-view.js): page globals in the renderer, modules in tests.
  const toolDetail = () => root.DeckToolDetail || (typeof module === "object" && typeof require === "function" ? require("./tool-detail") : null);
  const diffView = () => root.DeckDiff || (typeof module === "object" && typeof require === "function" ? require("./diff-view") : null);
  const DIFF_FILE_CALLS = 12; // edits shown per expanded Diff file (the newest ones, oldest first)
  const DIFF_FETCH_BUDGET = 32; // full-call reads one Diff render may start
  /** Before a rebuild, remember inner scroll offsets ([data-keep]) and the focused control ([data-focus]); restore after. */
  function keepView(el, doc, build) {
    const scrolls = [], all = sel => { try { return [...(el.querySelectorAll?.(sel) || [])]; } catch { return []; } };
    for (const n of all("[data-keep]")) if (n.scrollTop || n.scrollLeft) scrolls.push([n.getAttribute("data-keep"), n.scrollTop, n.scrollLeft]);
    const active = doc?.activeElement, focus = active && active !== el && el.contains?.(active) ? active.getAttribute?.("data-focus") : null;
    build();
    if (!scrolls.length && !focus) return;
    const now = all("[data-keep],[data-focus]");
    for (const [key, top, left] of scrolls) { const n = now.find(x => x.getAttribute("data-keep") === key); if (n) { n.scrollTop = top; n.scrollLeft = left; } }
    if (focus) now.find(x => x.getAttribute("data-focus") === focus)?.focus?.({ preventScroll: true });
  }
  function create({ shell, deck, doc = root.document, h = shell.service("h"), t = root.DeckI18n.t,
    setTimer = root.setTimeout.bind(root), clearTimer = root.clearTimeout.bind(root),
    emit = detail => doc.dispatchEvent(new root.CustomEvent("deck-tool-select", { detail })),
    emitReveal = detail => doc.dispatchEvent(new root.CustomEvent("deck-tool-reveal", { detail })),
    receipts = () => root.DeckReceipts, copy = text => root.navigator?.clipboard?.writeText?.(text) }) {
    let session = shell.last("session") || shell.state().session || {};
    let disposed = false, timer = null, pendingAgent = null, agentNotice = null;
    let copied = null, copiedTimer = null, scrollTimer = null, scrollTarget = null;
    const cache = new Map(), off = [], runMemo = new WeakMap();
    // Full stored calls behind clipped previews, read on expansion only (relay GET /session/<sid>/call/<id>).
    const fullCalls = toolDetail()?.createFullCalls({ read: typeof deck.toolCall === "function" ? (sid, call) => deck.toolCall(sid, call) : null,
      onChange: () => redraw() }) || null;
    const sidOf = s => s.sid || (s.kind === "hermes" ? s.id : null);
    const current = () => sidOf(session);
    function record(sid) {
      if (!cache.has(sid)) {
        cache.set(sid, { plan: null, planVersion: 0, loaded: false, loading: false, error: "",
          tools: [], toolsVersion: 0, toolError: "", toolsLoading: false, selected: null, pinned: false, extra: null, data: {}, writes: new Map(),
          agents: [], failed: [], agentError: "", agentLoading: false, agentsLoaded: false,
          turns: [], turnsNext: null, turnsLoaded: false, turnsLoading: false, turnOpen: new Map(), childHist: new Map(),
          agentId: null, detail: null, vanished: new Set(), tail: null, tailVersion: 0, agentMessages: new Map(), drafts: new Map(), busy: new Set(), expanded: new Set(),
          open: null, scrollTo: null });
        if (cache.size > 32) cache.delete(cache.keys().next().value);
      }
      return cache.get(sid);
    }
    const msg = e => String(e && e.message || e || t("work.unavailable"));
    function redraw() {
      if (disposed) return;
      const r = current() ? record(current()) : null;
      if (r) syncControls(r);
      shell.setTabLive("plan", !!planSummary(r && r.plan)?.active);
      shell.setTabLive("run", !!r?.tools.some(c => c.status === "running"));
      shell.setTabLive("agents", !!r?.agents.some(a => a.status === "running"));
      if (shell.isOpen("work")) shell.refresh();
    }
    async function readPlan(sid, opts) {
      if (deck.bridge?.plan) {
        try { return await deck.bridge.plan(sid, opts); }
        catch (e) { if (!deck.sessionPlan) throw e; }
      }
      return deck.sessionPlan ? deck.sessionPlan(sid) : { plan: null };
    }
    async function load(sid) {
      if (!sid || disposed) return;
      const r = record(sid);
      if (r.loading || r.loaded) return;
      r.loading = true; r.toolsLoading = true;
      const version = r.planVersion, toolsVersion = r.toolsVersion;
      const opts = session.profile ? { profile: session.profile } : undefined;
      loadTurns(sid);
      const toolsRead = (async () => {
        try {
          let calls = [];
          if (deck.bridge?.toolCalls) {
            try { calls = await deck.bridge.toolCalls(sid, opts); }
            catch (e) { if (!deck.session) throw e; }
          }
          let data = {};
          if (deck.session) {
            try { data = await deck.session(sid); }
            catch (e) { if (!calls.length) throw e; }
          }
          if (disposed) return;
          r.data = data || {};
          if (!calls.length) calls = data?.recent || [];
          if (r.toolsVersion === toolsVersion) replaceTools(sid, calls);
          r.toolError = "";
        } catch (e) { if (r.toolsVersion === toolsVersion) r.toolError = msg(e); }
        finally { r.toolsLoading = false; if (current() === sid) redraw(); }
      })();
      try {
        const data = await readPlan(sid, opts);
        if (r.planVersion === version) { r.plan = data.plan; r.error = ""; }
      } catch (e) { if (r.planVersion === version) r.error = msg(e); }
      finally { await toolsRead; r.loading = false; r.loaded = true; if (current() === sid) redraw(); }
    }
    // Whole-session history from the relay: the newest turns first, older pages on demand. Failures leave the live list alone.
    async function loadTurns(sid, before = null) {
      const r = record(sid);
      if (!deck.sessionTools || r.turnsLoading) return;
      r.turnsLoading = true;
      try {
        const page = await deck.sessionTools(sid, before);
        if (disposed) return;
        const got = Array.isArray(page?.turns) ? page.turns : [];
        const ids = new Set(got.map(x => x.id));
        r.turns = before === null ? (got.length ? [...r.turns.filter(x => !ids.has(x.id) && typeof x.id === "number" && x.id < got.find(y => typeof y.id === "number" && y.id > 0)?.id), ...got] : r.turns)
          : [...got, ...r.turns.filter(x => !ids.has(x.id))];
        if (before !== null || !r.turnsLoaded) r.turnsNext = page?.next || null;
        r.turnsLoaded = true;
        if (page?.meta && number(page.meta.cost) !== null) r.historyCost = page.meta.cost;
        for (const turn of r.turns) for (const c of turn.calls) if (changedFiles([c]).length) r.writes.set(c.call, c);
        while (r.writes.size > 200) r.writes.delete(r.writes.keys().next().value);
      } catch { r.turnsLoaded = true; }
      finally { r.turnsLoading = false; if (sid === current()) redraw(); }
    }
    const grouped = r => groupTurns(r.turns, r.tools);
    const allCalls = r => grouped(r).flatMap(t => t.calls);
    function replaceTools(sid, tools) {
      const r = record(sid), previous = r.tools.find(c => c.call === r.selected);
      r.tools = (Array.isArray(tools) ? tools : []).filter(c => c && c.call).slice(-30).map(c => ({ ...c, status: c.status || (c.ms == null ? "running" : "ok") }));
      for (const c of r.tools) if (changedFiles([c]).length) r.writes.set(c.call, c);
      while (r.writes.size > 200) r.writes.delete(r.writes.keys().next().value);
      if (r.selected && !allCalls(r).some(c => c.call === r.selected)) {
        if (r.pinned) { if (previous) r.extra = previous; }
        else r.selected = null;
      }
      if (r.extra && (r.extra.call !== r.selected || allCalls(r).some(c => c.call === r.extra.call))) r.extra = null;
      if (!r.pinned) r.selected = [...r.tools].reverse().find(c => c.status === "running")?.call || r.tools.at(-1)?.call || null;
    }
    function selectTool({ sid, call, source, tool }, { open = true, notify = true, expand = false } = {}) {
      if (!sid || !call || disposed) return;
      const r = record(sid);
      if (source === "live" && r.pinned) return;
      const known = allCalls(r).some(c => c.call === call), given = tool && tool.call === call ? tool : null;
      // A live call is genuinely recent; an explicit older selection is shown beside the list, never merged into it.
      if (!known && given && source === "live") replaceTools(sid, [...r.tools, given]);
      if (r.selected !== call) r.revealNotice = null;
      r.selected = call; r.pinned = source !== "live";
      const turnOf = grouped(r).find(t => t.calls.some(c => c.call === call));
      if (turnOf) r.turnOpen.set(String(turnOf.id), true);
      if (!allCalls(r).some(c => c.call === call)) {
        let found = given;
        if (!found) { try { found = receipts()?.calls?.(sid)?.find(c => c && c.call === call) || null; } catch { found = null; } }
        r.extra = found ? { ...found } : null;
      } else r.extra = null;
      // A call picked in the chat (or the Diff tab) lands on its Run row: expanded and scrolled into view once.
      if (expand) { r.open = call; r.scrollTo = call; fullCalls?.forget(sid, call); }
      if (notify) emit({ sid, call, source: "run" });
      if (sid === current()) { if (open) shell.openRight("work", "run"); redraw(); }
    }
    function bridgeEvent(e) {
      if (!e || !e.sid || disposed) return;
      const r = record(e.sid);
      if (e.type === "deck.plan") { r.planVersion++; r.plan = e.payload?.plan || null; r.error = ""; }
      else if (e.type === "deck.tools") { r.toolsVersion++; replaceTools(e.sid, e.payload?.tools); r.toolError = ""; }
      else return;
      if (e.sid === current()) redraw();
    }
    function relayEvent(m) {
      for (const s of m?.sessions || []) if (s.sid && cache.has(s.sid)) record(s.sid).data = { ...record(s.sid).data, ...s };
      for (const e of m?.evs || []) {
        if (e.ev === "plan") bridgeEvent({ type: "deck.plan", sid: e.sid, payload: { plan: e } });
        else if (e.sid && (e.ev === "tool_start" || e.ev === "tool_end")) {
          const r = record(e.sid);
          r.toolsVersion++;
          if (e.ev === "tool_start" && r.turnsLoaded && !allCalls(r).some(c => c.call === e.call) && !r.refreshAt) {
            r.refreshAt = setTimer(() => { r.refreshAt = null; loadTurns(e.sid); }, 2000);
          }
          const list = r.tools.slice(), index = list.findIndex(c => c.call === e.call);
          const call = { ...(index >= 0 ? list[index] : {}), ...e, status: e.ev === "tool_start" ? "running" : e.status || "ok" };
          if (index >= 0) list[index] = call; else list.push(call);
          replaceTools(e.sid, list);
          if (e.sid === current()) redraw();
        }
      }
    }
    const duration = ms => (ms == null ? "" : human().duration(ms)) || "—";
    const count = n => human().count(n);
    const money = (value, estimated) => value == null ? "—" : `${estimated ? "≈" : ""}$${value.toFixed(4)}`;
    function stat(label, value, bad = false, title = null) { return h("div", { title }, h("small", null, t(label)), h("b", { class: bad ? "bad" : "" }, value)); }
    // Expansion is recorded on the user's click (summary click precedes the native toggle), so detached or
    // rebuilt <details> elements cannot clear it through late toggle events.
    function disclosure(r, key, attrs, summaryKids, body) {
      return h("details", { ...attrs, open: r.expanded.has(key) ? true : null },
        h("summary", { onclick: e => {
          const opening = !e.currentTarget?.parentNode?.open;
          r.expanded.delete(key); if (opening) r.expanded.add(key);
          while (r.expanded.size > 200) r.expanded.delete(r.expanded.keys().next().value);
        } }, summaryKids), body);
    }
    function showInChat(sid, call) {
      selectTool({ sid, call }, { open: false });
      const ts = Number(allCalls(record(sid)).find(c => c.call === call)?.ts ?? record(sid).extra?.ts);
      emitReveal(Number.isFinite(ts) ? { sid, call, ts, origin: "run" } : { sid, call, origin: "run" });
    }
    const revealButton = (sid, call) => h("button", { class: "wk-reveal", type: "button", onclick: () => showInChat(sid, call), title: t("work.showInChat"), "aria-label": t("work.showInChat") }, "↗");
    // --- inline call detail: the expanded row shows its arguments and output right under it, both open
    function toggleKey(r, key) {
      if (r.expanded.has(key)) r.expanded.delete(key); else r.expanded.add(key);
      while (r.expanded.size > 200) r.expanded.delete(r.expanded.keys().next().value);
      redraw();
    }
    function copyText(text, key) {
      Promise.resolve().then(() => copy(text)).then(() => {
        if (disposed) return;
        copied = key;
        if (copiedTimer !== null) clearTimer(copiedTimer);
        copiedTimer = setTimer(() => { copiedTimer = null; copied = null; redraw(); }, 1200);
        redraw();
      }, () => {});
    }
    /** Call `c`'s detail; `fetchSid` names the session whose stored call can be read in full (null: preview only). */
    function detailOf(c, r, key, fetchSid) {
      const D = toolDetail();
      if (!D) return h("pre", null, c.err || c.result || "");
      return D.render(c, { h, t, key, full: fetchSid ? fullCalls?.get(fetchSid, c) || null : null, failed: failed(c), copied,
        isOn: k => r.expanded.has(k), toggle: k => toggleKey(r, k), copy: copyText });
    }
    function toggleRow(sid, call) {
      const r = record(sid);
      r.open = r.open === call ? null : call; r.scrollTo = null;
      if (r.open) fullCalls?.forget(sid, call);
      selectTool({ sid, call }, { open: false });
    }
    const whenOf = ts => number(ts) === null ? "" : new Date(ts * 1000).toLocaleString(root.DeckI18n?.getLocale?.() || "en-US", { dateStyle: "short", timeStyle: "short" });
    function runRow(c, bars, i, r, sid, barNodes) {
      const open = r.open === c.call, bar = h("i", { style: { left: `${bars[i].left}%`, width: `${bars[i].width}%` } });
      barNodes.push(bar);
      const item = h("div", { class: `wk-run-item${open ? " open" : ""}`, "data-item": c.call }, h("button", {
        class: `wk-run-row${c.call === r.selected ? " selected" : ""}${failed(c) ? " fail" : ""}${c.status === "interrupted" ? " stopped" : ""}`, type: "button", "aria-pressed": c.call === r.selected ? "true" : "false",
        "aria-expanded": open ? "true" : "false", "data-call": c.call, "data-focus": `row:${c.call}`, title: c.args || c.tool, onclick: () => toggleRow(sid, c.call) },
        h("span", { class: "wk-status", "aria-label": t(c.status === "running" ? "work.running" : c.status === "interrupted" ? "work.agentState.interrupted" : failed(c) ? "work.failed" : "work.state.done") }, c.status === "running" ? "◌" : c.status === "interrupted" ? "–" : failed(c) ? "×" : "✓"),
        h("span", { class: "wk-name", title: c.tool }, c.tool), h("span", { class: "wk-bar" }, bar), h("span", { class: "wk-time" }, duration(c.ms))), revealButton(sid, c.call),
        open ? detailOf(c, r, `run:${c.call}`, sid) : null);
      if (open && r.scrollTo === c.call) scrollTarget = item;
      return item;
    }
    function renderTurn(turn, index, total, r, sid, barRefs) {
      const key = String(turn.id), newest = index === total - 1;
      const open = r.turnOpen.has(key) ? r.turnOpen.get(key) : newest;
      const bars = timingBars(turn.calls), nodes = [];
      barRefs.push({ calls: turn.calls, nodes });
      return h("details", { class: "wk-turn", "data-turn": key, open: open ? true : null },
        h("summary", { onclick: e => { const opening = !e.currentTarget?.parentNode?.open; r.turnOpen.set(key, opening); } },
          h("b", null, turn.text || t("work.turnUntitled")), h("small", null, [whenOf(turn.ts), t("work.turnCalls", { n: turn.calls.length })].filter(Boolean).join(" · "))),
        h("div", { class: "wk-gantt" }, turn.calls.map((c, i) => runRow(c, bars, i, r, sid, nodes))));
    }
    // The pane redraws every second while Run is open; an unchanged view is kept (selection, focus, inner scroll
    // survive) and only running timing bars move. Anything the view shows must be part of this signature.
    function runSignature(sid, r, turns, outside) {
      const call = c => [c.call, c.tool, c.status, c.ms, c.ts, String(c.args ?? "").length, String(c.result ?? "").length, String(c.err ?? "").length, c.truncated === true];
      const full = [r.open, outside?.call].map(id => { const e = id ? fullCalls?.peek(sid, id) : null; return e ? [e.state, String(e.data?.args ?? "").length, String(e.data?.result ?? "").length] : null; });
      return JSON.stringify([sid, t("work.arguments"), r.selected, r.open, r.revealNotice, r.turnsNext, r.turnsLoading, r.toolsLoading, r.toolError,
        r.data.ntools, r.data.cost, r.data.costUsd, r.historyCost, r.data.cost_estimated, r.data.costStatus, copied, [...r.expanded],
        turns.map(x => [x.id, x.ts, x.text, r.turnOpen.get(String(x.id)) ?? null, x.calls.map(call)]), outside ? call(outside) : null, full]);
    }
    function tickBars(refs) {
      for (const ref of refs) {
        if (!ref.calls.some(c => c.status === "running")) continue;
        const bars = timingBars(ref.calls);
        ref.nodes.forEach((n, i) => { n.style?.setProperty?.("left", `${bars[i].left}%`); n.style?.setProperty?.("width", `${bars[i].width}%`); });
      }
    }
    /** Bring a row picked elsewhere into view once, after the shell has restored the pane's scroll offset. */
    function scrollSoon(node, r) {
      const call = r.scrollTo;
      if (scrollTimer !== null) clearTimer(scrollTimer);
      scrollTimer = setTimer(() => {
        scrollTimer = null;
        if (disposed || r.scrollTo !== call || node.isConnected === false) return;
        r.scrollTo = null;
        node.scrollIntoView?.({ block: "nearest" });
      }, 0);
    }
    function renderRun(el) {
      const sid = current();
      if (!sid) { runMemo.delete(el); return el.replaceChildren(shell.empty(t("work.noSession"))); }
      const r = record(sid), turns = grouped(r), calls = turns.flatMap(x => x.calls), stats = runStats(calls, { ...r.data, cost: r.data.cost ?? r.historyCost });
      const total = number(r.data.ntools);
      const inList = calls.find(c => c.call === r.selected);
      const outside = !inList && r.selected ? (r.extra?.call === r.selected ? r.extra : null) : null;
      const partial = total !== null && calls.length < total;
      const sig = runSignature(sid, r, turns, outside), memo = runMemo.get(el);
      if (memo && memo.sig === sig && memo.node === el.firstChild) { memo.tick(); return; }
      const barRefs = [];
      scrollTarget = null;
      // A selected call outside the loaded list keeps a compact detail at the top, never below every turn.
      const outsideBox = outside ? h("div", { class: "wk-outside", "data-item": outside.call },
        h("div", { class: "wk-outside-head" }, h("code", null, outside.tool || ""), h("small", null, t("work.selectedOutside")), revealButton(sid, outside.call)),
        detailOf(outside, r, `run:${outside.call}`, sid)) : null;
      if (outside && r.scrollTo === outside.call) scrollTarget = outsideBox;
      const section = h("section", { class: "wk-content" }, r.toolError && !calls.length ? h("p", { class: "wk-error", role: "alert" }, r.toolError) : null,
        h("div", { class: "wk-stats" }, stat("work.sessionCalls", String(total ?? stats.calls), false, t("work.sessionCallsHint")), stat("work.toolTime", duration(stats.time)), stat("work.failed", String(stats.failed), !!stats.failed), stat("work.cost", money(stats.cost, r.data.cost_estimated || r.data.costStatus === "estimated"))),
        partial ? h("p", { class: "wk-note" }, t("work.loadedCalls", { n: calls.length, total })) : null,
        r.revealNotice?.call === r.selected ? h("p", { class: "wk-note", role: "status" }, t(r.revealNotice.key)) : null,
        outsideBox || (!inList && r.selected ? h("p", { class: "wk-note", role: "status" }, t("work.selectedUnavailable")) : null),
        turns.length ? h("div", { class: "wk-turns" }, [...turns].reverse().map((turn, i) => renderTurn(turn, turns.length - 1 - i, turns.length, r, sid, barRefs))) : shell.empty(t(r.toolsLoading || r.turnsLoading ? "work.loading" : "work.noTools")),
        r.turnsNext ? h("button", { class: "btn wk-older", type: "button", "data-action": "older", disabled: r.turnsLoading, onclick: () => loadTurns(sid, r.turnsNext) }, t(r.turnsLoading ? "work.loadingOlder" : "work.loadOlder")) : null);
      keepView(el, doc, () => el.replaceChildren(section));
      runMemo.set(el, { sig, node: el.firstChild, tick: () => tickBars(barRefs) });
      if (scrollTarget) scrollSoon(scrollTarget, r);
    }
    function renderPlan(el) {
      const sid = current();
      if (!sid) return el.replaceChildren(shell.empty(t("work.noSession")));
      const r = record(sid), summary = planSummary(r.plan);
      const error = r.error ? h("p", { class: "wk-error", role: "alert" }, r.error) : null;
      if (!summary || !summary.shown) return el.replaceChildren(...[error, shell.empty(t(r.loading && !r.loaded ? "work.loading" : summary ? "work.planCleared" : "work.noPlan"))].filter(Boolean));
      const source = r.plan.source === "omh" ? "work.sourceOmh" : "work.sourceTodo";
      let phase = null;
      const rows = [];
      for (const item of r.plan.items) {
        if (item.phase && item.phase !== phase) { phase = item.phase; rows.push(h("li", { class: "wk-phase" }, phase)); }
        const state = ["done", "active", "cancelled"].includes(item.state) ? item.state : "pending";
        rows.push(h("li", { class: `wk-task ${state} depth-${Math.min(3, Math.max(0, Math.trunc(item.depth) || 0))}` },
          h("span", { class: "wk-tick", "aria-label": t(`work.state.${state}`) }, state === "done" ? "✓" : state === "cancelled" ? "−" : ""),
          h("div", { class: "wk-task-text" }, h("span", null, item.text), item.blocked ? h("small", { class: "wk-blocked" }, t("work.blocked", { reason: item.blocked })) : null)));
      }
      el.replaceChildren(h("section", { class: "wk-content" }, error,
        h("div", { class: "wk-plan-head" }, h("span", { class: "sh-chip" }, t(source)), h("span", null, t("work.doneCount", { n: summary.done, total: summary.total }))),
        h("ul", { class: "wk-todo" }, rows), summary.total > summary.shown ? h("p", { class: "wk-note" }, t("work.planClipped", { n: summary.shown, total: summary.total })) : null));
    }
    /** The diff model of a write call (full call when read), memoized: the Diff tab re-renders on every live event. */
    const models = new Map();
    function modelOf(sid, c, entry) {
      const D = diffView();
      if (!D) return null;
      const call = toolDetail()?.merged(c, entry) || c;
      const key = [sid, c.call, c.status, entry?.state || "", String(call.args ?? "").length, String(call.result ?? "").length].join("\n");
      if (!models.has(key)) {
        models.set(key, D.fromCall(call));
        while (models.size > 300) models.delete(models.keys().next().value);
      }
      return models.get(key);
    }
    /** The Diff tab's files: each with its write calls (session order) and +/− totals, known only when every edit's diff is. */
    function fileGroups(sid, calls) {
      const D = diffView(), groups = [];
      const order = calls.map((c, i) => [c, i, stamp(c.ts)]).sort((a, b) => (a[2] !== null && b[2] !== null ? a[2] - b[2] : 0) || a[1] - b[1]).map(x => x[0]);
      for (const c of order) {
        const target = writeTarget(c);
        if (!target) continue;
        const model = modelOf(sid, c, fullCalls?.peek(sid, c.call));
        for (const f of model?.files.length ? model.files : [null]) {
          const path = f?.path || target.path;
          let g = groups.find(x => D ? D.samePath(x.path, path) : x.path === path);
          if (!g) { g = { path, calls: [], added: 0, removed: 0, known: true }; groups.push(g); }
          if (!g.calls.includes(c)) g.calls.push(c);
          if (f && f.complete) { g.added += f.added; g.removed += f.removed; }
          else if (!f && target.added !== null) { g.added += target.added; g.removed += target.removed; }
          else g.known = false;
        }
      }
      return groups;
    }
    /** Open a call in Run from elsewhere in the pane (the Diff tab): selected, its row expanded and scrolled to. */
    const focusCall = (sid, c) => selectTool({ sid, call: c.call, source: "diff", tool: c }, { open: true, expand: true });
    const clock = ms => new Date(ms).toLocaleTimeString(root.DeckI18n?.getLocale?.() || "en-US", { hour: "2-digit", minute: "2-digit" });
    function renderDiff(el) {
      const sid = current();
      if (!sid) return el.replaceChildren(shell.empty(t("work.noSession")));
      const r = record(sid), groups = fileGroups(sid, [...r.writes.values()]), D = diffView();
      let budget = DIFF_FETCH_BUDGET; // expanded files read their clipped calls in full, a bounded number per render
      const edit = (g, c) => {
        const entry = !fullCalls ? null : budget > 0 ? fullCalls.get(sid, c) : fullCalls.peek(sid, c.call);
        if (entry?.state === "loading") budget--;
        const model = modelOf(sid, c, entry), ms = stamp(c.ts);
        const opts = { t, key: `diff:${c.call}`, isFull: k => r.expanded.has(k), showAll: k => toggleKey(r, k) };
        const view = model && D ? D.render(h, model, { ...opts, only: model.files.length > 1 ? p => D.samePath(p, g.path) : null }) || D.render(h, model, opts) : null;
        return h("div", { class: "wk-edit", "data-call": c.call },
          h("div", { class: "wk-edit-head" }, h("span", null, ms === null ? c.tool : `${clock(ms)} · ${c.tool}`),
            h("button", { class: "wk-link", type: "button", onclick: () => focusCall(sid, c) }, t("diff.inRun"))),
          entry?.state === "loading" ? h("p", { class: "wk-note", role: "status" }, t("tooldetail.loading"))
            : view || h("p", { class: "wk-note" }, t("work.noDiff")));
      };
      const file = g => {
        const key = `diff:file:${g.path}`, open = r.expanded.has(key), shown = open ? g.calls.slice(-DIFF_FILE_CALLS) : [];
        return h("details", { class: "wk-file", "data-path": g.path, open: open ? true : null },
          h("summary", { title: g.path, onclick: e => {
            const opening = !e.currentTarget?.parentNode?.open;
            r.expanded.delete(key); if (opening) r.expanded.add(key);
            while (r.expanded.size > 200) r.expanded.delete(r.expanded.keys().next().value);
            redraw();
          } }, h("code", null, D ? D.shortPath(g.path) : g.path),
            g.known && g.added ? h("span", { class: "wk-add" }, `+${g.added}`) : null, g.known && g.removed ? h("span", { class: "wk-del" }, `−${g.removed}`) : null),
          open ? h("div", { class: "wk-edits" }, g.calls.length > shown.length ? h("p", { class: "wk-note" }, t("diff.olderEdits", { n: g.calls.length - shown.length })) : null,
            shown.map(c => edit(g, c))) : null);
      };
      keepView(el, doc, () => el.replaceChildren(h("section", { class: "wk-content" },
        r.toolError ? h("p", { class: "wk-error", role: "alert" }, r.toolError) : null,
        groups.some(g => !g.known) ? h("p", { class: "wk-note" }, t("work.diffPreview")) : null,
        groups.length ? h("div", { class: "wk-files" }, groups.map(file)) : shell.empty(t(r.toolsLoading ? "work.loading" : "work.noFiles")))));
    }
    const optsOf = () => session.profile ? { profile: session.profile } : undefined;
    async function loadAgents() {
      const sid = current();
      if (!sid || disposed || !shell.isOpen("work", "agents")) return;
      const r = record(sid);
      if (r.agentLoading) return;
      if (!deck.bridge?.subagents && !deck.session) { r.agentError = t("work.agentsNeedDirect"); redraw(); return; }
      r.agentLoading = true;
      let bridgeData = null, bridgeError = null, relayRows = null, relayError = null;
      await Promise.all([
        (async () => { if (!deck.bridge?.subagents) return; try { bridgeData = await deck.bridge.subagents(sid, optsOf()); } catch (e) { bridgeError = e; } })(),
        (async () => { if (!deck.session) return; try { const d = await deck.session(sid); relayRows = relayAgents(d?.children); if (d) r.data = { ...r.data, ...d, children: undefined }; } catch (e) { relayError = e; } })(),
      ]);
      try {
        if (disposed) return;
        // A session this Deck does not own is not an error: the relay roster is shown read-only.
        const live = bridgeData && Array.isArray(bridgeData.subagents) ? bridgeData.subagents.slice(0, 128) : null;
        r.agentOwned = !!live;
        r.agents = mergeRoster(relayRows, live);
        r.failed = bridgeData && Array.isArray(bridgeData.failed) ? bridgeData.failed.slice(0, 64) : [];
        r.agentError = !live && !relayRows ? msg(bridgeError && !notOwned(bridgeError) ? bridgeError : relayError || bridgeError) : bridgeError && !notOwned(bridgeError) && !relayRows ? msg(bridgeError) : "";
        if (pendingAgent && pendingAgent.sid === sid) {
          const want = pendingAgent, hit = r.agents.find(a => (want.subagentId && a.id === want.subagentId) || (want.childSid && a.childSid === want.childSid));
          if (hit) { pendingAgent = null; agentNotice = null; r.agentId = hit.id; r.detail = hit; r.tail = null; r.tailVersion++; loadChildHistory(sid, hit); }
          else if (++want.reads >= 4) { pendingAgent = null; agentNotice = { sid, key: "work.agentMissing" }; }
        }
        const detail = r.agents.find(a => a.id === r.agentId);
        if (detail) { r.detail = detail; r.vanished.delete(detail.id); }
        else if (r.agentId) { r.vanished.add(r.agentId); r.detail = ended(r.detail); }
      } finally { r.agentLoading = false; r.agentsLoaded = true; if (sid === current()) redraw(); }
      if (sid === current() && shell.isOpen("work", "agents")) await loadTail();
    }
    // A relay-known child is an ordinary stored session: its tool calls and last messages come from relay history.
    async function loadChildHistory(sid, agent) {
      const r = record(sid), child = agent?.childSid;
      if (!child || !deck.messages) return;
      const cur = r.childHist.get(child);
      if (cur?.loading || (cur?.done && agent.status !== "running")) return;
      const entry = cur || { loading: false, done: false, messages: [], calls: [], error: "" };
      r.childHist.set(child, entry); entry.loading = true;
      while (r.childHist.size > 16) r.childHist.delete(r.childHist.keys().next().value);
      try {
        const page = await deck.messages(child);
        if (disposed) return;
        const items = Array.isArray(page?.items) ? page.items : [];
        const results = new Map(items.filter(i => i.role === "tool" && i.call).map(i => [i.call, i]));
        entry.calls = items.filter(i => i.role === "assistant").flatMap(i => (i.calls || []).map(c => ({ call: c.call, tool: c.name || "tool", args: c.args || "", result: results.get(c.call)?.text || "", status: "ok",
          truncated: c.truncated === true || results.get(c.call)?.truncated === true })));
        entry.messages = items.filter(i => i.role === "assistant" && i.text).slice(-5).map(i => i.text);
        entry.error = ""; entry.done = true;
      } catch (e) { entry.error = msg(e); }
      finally { entry.loading = false; if (sid === current() && r.agentId === agent.id) redraw(); }
    }
    async function loadTail() {
      const sid = current();
      if (!sid || disposed || !shell.isOpen("work", "agents")) return;
      const r = record(sid), id = r.agentId;
      if (id && (r.detail?.relayOnly || r.agentOwned === false)) { loadChildHistory(sid, r.detail); return; }
      if (!id || !deck.bridge?.subagentTail) return;
      const version = ++r.tailVersion;
      try {
        const tail = await deck.bridge.subagentTail(sid, id, optsOf());
        if (disposed || version !== r.tailVersion || id !== r.agentId) return;
        r.tail = tail;
        // The tree is the authoritative state; a tail may have been sampled earlier.
        if (tail.detail && r.vanished.has(id)) r.detail = ended({ ...tail.detail, id });
      } catch (e) { if (version === r.tailVersion && id === r.agentId) r.tail = { error: msg(e) }; }
      if (sid === current()) redraw();
    }
    function openAgent(id) {
      const sid = current(); if (!sid || disposed) return;
      const r = record(sid), agent = r.agents.find(a => a.id === id);
      if (!agent) return;
      r.agentId = id; r.detail = agent; r.tail = null; r.tailVersion++; r.vanished.delete(id); agentNotice = null;
      loadChildHistory(sid, agent);
      shell.openRight("work", "agents");
      loadTail(); redraw();
    }
    async function mutateAgent(kind, sid, id) {
      const r = record(sid), a = r.agents.find(x => x.id === id) || r.detail;
      if (disposed || sid !== current() || id !== r.agentId || r.busy.has(id) || a?.status !== "running" || a?.relayOnly) return;
      const text = (r.drafts.get(id) || "").trim();
      if (kind === "steer" && (!canSteer(a) || !text)) return;
      const fail = key => { r.agentMessages.set(id, { text: t(key, { max: STEER_MAX }), error: true }); redraw(); };
      if (kind === "steer" && steerError(text)) return fail(steerError(text));
      const method = deck.bridge?.[kind === "steer" ? "steerSubagent" : "interruptSubagent"];
      if (typeof method !== "function") return fail("work.controlNeedsDirect");
      r.busy.add(id); r.agentMessages.delete(id); redraw();
      const opts = optsOf();
      try {
        const result = (kind === "steer" ? await method.call(deck.bridge, sid, id, text, opts) : await method.call(deck.bridge, sid, id, opts)) || {};
        if (kind === "steer") {
          if (r.drafts.get(id)?.trim() === text) r.drafts.delete(id);
          r.agentMessages.set(id, { text: t(result.status === "queued" ? "work.steerQueued" : "work.steerAccepted"), error: false });
        } else {
          r.agentMessages.set(id, { text: t(result.found ? "work.stopRequested" : "work.agentEnded"), error: false });
          if (!result.found) { a.status = "completed"; a.acceptingSteer = false; }
        }
      } catch (e) { r.agentMessages.set(id, { text: msg(e), error: true }); }
      finally { r.busy.delete(id); if (sid === current() && id === r.agentId) redraw(); }
    }
    async function poll() {
      if (disposed) return;
      if (shell.isOpen("work", "agents")) await loadAgents();
      else if (shell.isOpen("work", "run")) redraw();
    }
    function schedule() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (disposed || !shell.isOpen("work")) return;
      const tab = shell.right().tab;
      if (tab !== "agents" && tab !== "run") return;
      timer = setTimer(async () => { timer = null; await poll(); schedule(); }, tab === "agents" ? 2500 : 1000);
    }
    const agentState = a => t(`work.agentState.${["queued", "running", "completed", "failed", "error", "timeout", "interrupted"].includes(a.status) ? a.status : "unknown"}`);
    // A sub-agent's call: tool, state and time on one line (arguments in the tooltip); opening it shows the same
    // detail as a Run row. The body is built only while open, so closed rows never read or diff anything.
    function toolDisclosure(c, r) {
      const key = `agent:${r.agentId}:${c.call}`, open = r.expanded.has(key);
      const state = t(c.status === "running" ? "work.running" : c.status === "interrupted" ? "work.agentState.interrupted" : failed(c) ? "work.failed" : "work.state.done");
      return h("details", { class: `wk-tool${failed(c) ? " fail" : ""}`, "data-call": c.call, open: open ? true : null },
        h("summary", { title: typeof c.args === "string" ? c.args.slice(0, 300) : null, "data-focus": `agent:${c.call}`, onclick: e => {
          const opening = !e.currentTarget?.parentNode?.open;
          r.expanded.delete(key); if (opening) r.expanded.add(key);
          while (r.expanded.size > 200) r.expanded.delete(r.expanded.keys().next().value);
          redraw();
        } }, h("code", null, c.tool), h("span", { class: "wk-tool-state" }, state), h("small", null, duration(c.ms))),
        open ? detailOf(c, r, key, r.detail?.childSid || null) : null);
    }
    // Without the direct mutation methods the controls are disabled; say why instead of failing silently.
    const controlNotice = a => a?.relayOnly && a.status === "running" ? { text: t("work.controlNeedsOpen"), error: false } : a?.status === "running" && (!deck.bridge?.steerSubagent || !deck.bridge?.interruptSubagent) ? { text: t("work.controlNeedsDirect"), error: false } : null;
    // Shell holds pane rebuilds while typing. These controls still follow current runtime state.
    function syncControls(r) {
      const form = r.form;
      if (!form || form.id !== r.agentId || !form.field.isConnected) return;
      const a = r.agents.find(x => x.id === form.id) || r.detail;
      const busy = r.busy.has(form.id), draft = r.drafts.get(form.id) || "", message = r.agentMessages.get(form.id) || controlNotice(a);
      form.field.disabled = !canSteer(a) || busy || !deck.bridge?.steerSubagent;
      form.steer.disabled = form.field.disabled || !draft.trim();
      form.stop.disabled = a?.status !== "running" || a?.relayOnly || busy || !deck.bridge?.interruptSubagent;
      form.field.value = draft;
      form.note.textContent = message?.text || "";
      form.note.className = message?.error ? "wk-error" : "wk-note";
      form.note.setAttribute?.("role", message?.error ? "alert" : "status");
    }
    // Recently ended delegations: real failures in red; ones that were stopped on purpose (interrupted) fold into one
    // muted line, since Hermes lists them among its "failed" rows.
    function failedRows(r) {
      const stopped = r.failed.filter(f => f.status === "interrupted"), failures = r.failed.filter(f => f.status !== "interrupted");
      const rows = failures.slice(0, 8).map(f => h("div", { class: "wk-failed" }, h("b", null, f.goal), h("p", { class: "wk-error" }, f.error || t("work.failed"))));
      if (failures.length > 8) rows.push(h("p", { class: "wk-note" }, t("work.moreFailed", { n: failures.length - 8 })));
      if (stopped.length) rows.push(h("p", { class: "wk-note wk-stopped" }, t("work.stoppedAgents", { n: stopped.length })));
      return rows;
    }
    // The child's own relay session (live via the app's relaySession service, else the roster's copy) feeds the
    // same metric cells as the activity drawer; bridge-only fields fill in when the relay has none.
    const relaySession = sid => { try { return (sid && shell.service("relaySession")?.(sid)) || null; } catch { return null; } };
    function agentFigures(a, hist) {
      const rel = relaySession(a.childSid) || a.row || null, tk = a.tokens;
      const tokens = rel?.tokens && typeof rel.tokens === "object" ? rel.tokens
        : tk ? { in: number(tk.input) || 0, out: number(tk.output) || 0, cr: number(tk.cache_read) || 0, cw: number(tk.cache_write) || 0 } : null;
      const total = tokens ? ["in", "out", "cr", "cw"].reduce((n, key) => n + (number(tokens[key]) || 0), 0) : null;
      const source = { ...(rel || {}), tokens: tokens || {}, parent: rel?.parent || true, ntools: 0 };
      const node = { ctxPercent: a.ctxPercent, ctxMax: a.ctxMax, ctxUsed: a.ctxUsed };
      const ctx = activity().ctxPercent(source, node);
      const calls = number(a.toolCount) ?? a.tools?.length ?? hist?.calls.length ?? number(rel?.ntools) ?? 0;
      const cost = number(a.costUsd) ?? (number(rel?.cost) || null);
      const estimated = a.costStatus === "estimated" || (number(a.costUsd) === null && !!rel && (rel.cost_estimated === true || rel.cost_label === "API list-price equivalent"));
      return { source, node, ctx, total, calls, cost, estimated };
    }
    function agentGrid(a, hist) {
      const f = agentFigures(a, hist), A = activity(), items = [];
      const elapsed = number(a.elapsedS) === null ? null : a.elapsedS * 1000;
      if (elapsed !== null) items.push({ id: "elapsed", label: t("work.elapsed"), value: duration(elapsed) });
      if (f.total !== null) items.push({ id: "tokens", label: t("work.tokens"), value: count(f.total), tip: `${t("work.tokensHint")}\n${human().exact(f.total)}` });
      items.push(...A.metricItems(f.source, f.node, count, { sparse: true }));
      items.push({ id: "calls", label: t("work.calls"), value: count(f.calls) });
      if (f.cost !== null) items.push({ id: "cost", label: t("work.agentCost"), value: money(f.cost, f.estimated) });
      return A.metricGrid(h, items);
    }
    /** One short line under a sub-agent's goal: model · effort · state · elapsed · context. */
    function agentLine(agent) {
      const elapsed = number(agent.elapsedS) === null ? null : duration(agent.elapsedS * 1000);
      const ctx = agentFigures(agent, null).ctx;
      return [agent.model, agent.effort, agentState(agent), elapsed, ctx === null ? null : t("wux.ctx", { p: usage().pct(ctx) })].filter(Boolean).join(" · ");
    }
    function renderAgents(el) {
      const sid = current();
      if (!sid) return el.replaceChildren(shell.empty(t("work.noSession")));
      const r = record(sid), a = r.detail, error = r.agentError ? h("p", { class: "wk-error", role: "alert" }, r.agentError) : null;
      if (!r.agentId || !a) {
        const rows = agentRows(r.agents);
        const noticeKey = pendingAgent ? (pendingAgent.sid === sid ? "work.agentSearching" : "work.agentElsewhere") : agentNotice?.sid === sid ? agentNotice.key : null;
        const notice = noticeKey ? h("p", { class: "wk-note", role: "status" }, t(noticeKey)) : null;
        el.replaceChildren(h("section", { class: "wk-content" }, error, notice, rows.length ? h("div", { class: "wk-agents" }, rows.map(({ agent, depth }) => h("button", {
          class: `wk-agent depth-${depth}${agent.status === "running" ? " live" : ""}`, type: "button", "data-agent": agent.id, onclick: () => openAgent(agent.id) },
          h("span", { class: "wk-agent-dot", "aria-hidden": "true" }), h("span", null, h("b", null, agent.goal || agent.id), h("small", null, agentLine(agent)))))) : shell.empty(t(r.agentLoading ? "work.loading" : "work.noAgents")),
          ...failedRows(r)));
        return;
      }
      const message = r.agentMessages.get(a.id) || controlNotice(a), busy = r.busy.has(a.id);
      const notes = agentNotes(r.tail?.text), hist = a.childSid ? r.childHist.get(a.childSid) : null;
      const field = h("textarea", { class: "wk-steer-input", "data-hold": "", "aria-label": t("work.steerLabel"), placeholder: t("work.steerPlaceholder"), maxlength: 32000,
        disabled: !canSteer(a) || busy || !deck.bridge?.steerSubagent, oninput: e => { r.drafts.set(a.id, e.target.value); syncControls(r); },
        onkeydown: e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); mutateAgent("steer", sid, a.id); } } });
      field.value = r.drafts.get(a.id) || "";
      const steer = h("button", { class: "btn primary", type: "button", "data-action": "steer", disabled: !canSteer(a) || busy || !deck.bridge?.steerSubagent || !field.value.trim(), onclick: () => mutateAgent("steer", sid, a.id) }, t("work.steer"));
      const stop = h("button", { class: "btn danger-outline", type: "button", "data-action": "stop", disabled: a.status !== "running" || a.relayOnly || busy || !deck.bridge?.interruptSubagent, onclick: () => mutateAgent("stop", sid, a.id) }, t("work.stop"));
      const note = h("p", { class: message?.error ? "wk-error" : "wk-note", role: message?.error ? "alert" : "status", "data-agent-message": a.id }, message?.text || "");
      r.form = { id: a.id, field, steer, stop, note };
      el.replaceChildren(h("section", { class: "wk-content" }, h("button", { class: "wk-back", type: "button", onclick: () => { r.agentId = null; r.detail = null; r.tailVersion++; redraw(); } }, t("work.back")), error,
        h("header", { class: "wk-agent-head" }, h("b", null, a.id), h("small", null, [a.model, a.effort, agentState(a), a.state ? t(`work.runtimeState.${["idle", "thinking", "working", "searching", "finished", "error", "question", "approval", "ratelimit"].includes(a.state) ? a.state : "unknown"}`) : null].filter(Boolean).join(" · "))),
        r.vanished.has(a.id) ? h("p", { class: "wk-note", role: "status" }, t("work.agentGone")) : null,
        h("p", { class: "wk-task-goal" }, a.goal),
        agentGrid(a, hist),
        notes ? [h("h3", { class: "wk-label" }, t("work.notes")), h("pre", { class: "wk-notes" }, notes)] : null,
        r.tail?.error ? h("p", { class: "wk-error", role: "alert" }, r.tail.error)
          : r.tail?.available === false ? h("p", { class: "wk-note" }, t("work.tailEnded")) : null,
        notes && r.tail?.truncated ? h("p", { class: "wk-note" }, t("work.tailClipped")) : null,
        a.summary ? [h("h3", { class: "wk-label" }, t("work.agentSummary")), h("p", { class: "wk-notes" }, a.summary)] : null,
        hist?.messages.length ? [h("h3", { class: "wk-label" }, t("work.agentHistory")), h("pre", { class: "wk-notes" }, hist.messages.join("\n\n"))] : null,
        hist?.error ? h("p", { class: "wk-error", role: "alert" }, hist.error) : null,
        h("h3", { class: "wk-label" }, t("work.calls")), h("div", { class: "wk-tools" }, (a.tools?.length ? a.tools : hist?.calls || []).map(c => toolDisclosure(c, r))),
        h("div", { class: "wk-steer" }, field, h("footer", null, h("small", null, t("work.steerHint")), steer)), stop, note));
    }
    // Lane E fleet: select a child by runtime id or stored child sid once the parent's live tree has it.
    function selectAgent(detail) {
      if (!detail || typeof detail.sid !== "string" || !detail.sid || disposed) return;
      const { sid, profile } = detail, childSid = detail.childSid || null, subagentId = detail.subagentId || null;
      pendingAgent = childSid || subagentId ? { sid, childSid, subagentId, reads: 0 } : null;
      agentNotice = null;
      if (sid !== current()) {
        const openChat = shell.service("openChat");
        if (typeof openChat === "function") openChat({ sid, profile, origin: "fleet" });
      } else { const r = record(sid); r.agentId = null; r.detail = null; r.tailVersion++; }
      shell.openRight("work", "agents");
      if (sid === current()) loadAgents();
      redraw();
    }
    shell.registerWorkTab("agents", { title: () => t("shell.tab.agents"), render: renderAgents });
    shell.registerWorkTab("diff", { title: () => t("shell.tab.diff"), render: renderDiff });
    shell.registerWorkTab("run", { title: () => t("shell.tab.run"), render: renderRun });
    shell.registerWorkTab("plan", { title: () => t("shell.tab.plan"), render: renderPlan });
    off.push(shell.on("toolSelect", value => selectTool(value)));
    off.push(shell.on("right", () => { load(current()); poll(); schedule(); redraw(); }));
    off.push(shell.on("session", s => {
      session = s || {};
      if (pendingAgent && pendingAgent.sid !== current()) pendingAgent = null;
      if (agentNotice && agentNotice.sid !== current()) agentNotice = null;
      load(current()); poll(); schedule(); redraw(); }));
    const unsubBridge = deck.bridge?.onEvent?.(bridgeEvent), unsubRelay = deck.onRelay?.(relayEvent);
    if (typeof unsubBridge === "function") off.push(unsubBridge);
    if (typeof unsubRelay === "function") off.push(unsubRelay);
    // A tool call picked in the chat (a receipt row, Inspect) lands on its Run row, expanded; live follow-the-turn
    // selections only move the highlight.
    const receiptSelection = e => {
      const d = e.detail;
      if (!d || d.source === "run") return;
      const chat = d.source !== "live";
      selectTool(d, { open: chat, notify: false, expand: chat });
    };
    doc.addEventListener("deck-tool-select", receiptSelection);
    // History tool chips in the transcript reveal their receipt (receipts.js) and open the call in Run as well.
    const chatReveal = e => {
      const d = e.detail;
      if (disposed || !d || d.origin === "run" || !d.sid || !d.call || d.sid !== current()) return;
      selectTool({ sid: d.sid, call: d.call, source: "chat" }, { open: true, notify: false, expand: true });
    };
    doc.addEventListener("deck-tool-reveal", chatReveal);
    const revealStatus = e => {
      const d = e.detail;
      if (disposed || !d || d.sid !== current()) return;
      const r = record(d.sid);
      if (d.call !== r.selected) return;
      const key = d.status === "loading" ? "work.historyLoading" : d.status === "missing" ? "work.historyMissing" : d.status === "nearby" ? "work.historyNearby" : null;
      r.revealNotice = key ? { call: d.call, key } : null;
      redraw();
    };
    doc.addEventListener("deck-tool-reveal-result", revealStatus);
    const agentSelection = e => selectAgent(e.detail);
    doc.addEventListener("deck-agent-select", agentSelection);
    const language = () => redraw();
    doc.addEventListener("deck-language", language);
    load(current()); poll(); schedule();
    const initialSelection = root.DeckReceipts?.selection?.();
    if (initialSelection) selectTool(initialSelection, { open: false, notify: false });
    redraw();
    return { selectTool, selectAgent, openAgent, poll, dispose() { disposed = true; if (timer !== null) clearTimer(timer); if (copiedTimer !== null) clearTimer(copiedTimer); if (scrollTimer !== null) clearTimer(scrollTimer); off.forEach(f => f()); doc.removeEventListener("deck-language", language); doc.removeEventListener("deck-agent-select", agentSelection); doc.removeEventListener("deck-tool-select", receiptSelection); doc.removeEventListener("deck-tool-reveal", chatReveal); doc.removeEventListener("deck-tool-reveal-result", revealStatus); } };
  }
  function createSurfaces({ shell, h = shell.service("h"), t = root.DeckI18n.t, doc = root.document,
    setTimer = root.setTimeout.bind(root), clearTimer = root.clearTimeout.bind(root),
    emit = detail => doc.dispatchEvent(new root.CustomEvent("deck-surfaces", { detail })) }) {
    let disposed = false, timer = null, previous = "";
    const serviceOf = kind => shell.service(kind === "browser" ? "workspace" : "botscreen");
    const live = (kind, { profile } = {}) => ["browser", "screen"].includes(kind) && !!serviceOf(kind)?.live?.(profile);
    function refresh() {
      if (disposed) return;
      const state = { browser: live("browser"), screen: live("screen") };
      shell.setTabLive("browser", state.browser); shell.setTabLive("screen", state.screen);
      const key = JSON.stringify(state);
      if (key !== previous) { previous = key; emit(state); }
    }
    function tick() { refresh(); if (!disposed) timer = setTimer(tick, 1500); }
    const off = shell.on("service", refresh);
    doc.addEventListener("deck-language", refresh);
    tick();
    return { live, refresh,
      chip(kind, opts = {}) {
        if (!live(kind, opts)) return null;
        return h("button", { class: "wk-surface-chip", type: "button", title: t(`work.${kind}Live`),
          onclick: () => { serviceOf(kind)?.selectProfile?.(opts.profile); shell.openRight("work", kind); } },
          h("i", { "aria-hidden": "true" }), t(`work.${kind}`));
      },
      dispose() { disposed = true; if (timer !== null) clearTimer(timer); off(); doc.removeEventListener("deck-language", refresh); },
    };
  }
  const api = { planSummary, runStats, timingBars, changedFiles, agentNotes, agentRows, canSteer, steerError, ended, relayAgents, mergeRoster, groupTurns, notOwned, create, createSurfaces };
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root.DeckShell && root.deck) {
    const pane = create({ shell: root.DeckShell, deck: root.deck });
    const surfaces = createSurfaces({ shell: root.DeckShell });
    root.DeckSurfaces = Object.freeze(surfaces);
    // top bar: a live Screen chip for the open session's agent, rebuilt when a surface or the language changes
    const shell = root.DeckShell, doc = root.document;
    const crumb = () => {
      if (typeof shell.mount !== "function") return;
      const profile = shell.last?.("session")?.profile || undefined;
      const chips = [surfaces.chip("screen", { profile })].filter(Boolean);
      if (!chips.length) { shell.mount("crumb-extra", null); return; }
      const box = doc.createElement("span");
      box.className = "wk-surface-chips";
      box.append(...chips);
      shell.mount("crumb-extra", box);
    };
    const offCrumb = typeof shell.on === "function" ? shell.on("session", crumb) : null;
    doc.addEventListener?.("deck-surfaces", crumb);
    doc.addEventListener?.("deck-language", crumb);
    crumb();
    const disposeCrumb = () => { if (typeof offCrumb === "function") offCrumb(); doc.removeEventListener?.("deck-surfaces", crumb); doc.removeEventListener?.("deck-language", crumb); };
    root.DeckWorkPane = Object.freeze({ ...api, ...pane, dispose() { pane.dispose(); surfaces.dispose(); disposeCrumb(); } });
  } else root.DeckWorkPane = api;
})(typeof window === "object" ? window : globalThis);
