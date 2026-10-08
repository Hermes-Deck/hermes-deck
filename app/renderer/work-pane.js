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
  const failed = c => c.status !== "ok" && c.status !== "running";
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
  function changedFiles(calls) {
    const files = new Map();
    for (const c of calls) {
      if (c.status !== "ok" || !/(^|[.:_])(?:patch|write_file)$/.test(c.tool || "")) continue;
      const args = object(c.args), result = object(c.result);
      if (result.success === false || result.error || result.isError === true) continue;
      const path = [args.path, args.file_path, previewPath(c.args), result.files_modified?.[0],
        previewPath(c.result, "files_modified", true), result.resolved_path, previewPath(c.result, "resolved_path"),
        result.path, previewPath(c.result, "path"), diffPathPreview(result.diff || c.result)]
        .find(value => typeof value === "string" && value && !/[\n\r\0…<>]/.test(value));
      if (!path) continue;
      // Paths stay text and only basenames are displayed, whether relative or absolute.
      const name = path.split(/[\\/]/).pop();
      if (!name) continue;
      let added = null, removed = null;
      const diff = typeof result.diff === "string" ? result.diff : typeof c.result === "string" && /^--- /m.test(c.result) ? c.result : "";
      if (diff && !diff.includes("…") && /^@@ /m.test(diff)) {
        added = diff.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++")).length;
        removed = diff.split("\n").filter(l => l.startsWith("-") && !l.startsWith("---")).length;
      }
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
  const canSteer = agent => agent?.status === "running" && agent.acceptingSteer === true;
  const STEER_MAX = 32000;
  // Lane C validates again in main; this keeps the failure inline and the draft intact.
  const steerError = text => !String(text || "").trim() ? "work.steerEmpty" : String(text).length > STEER_MAX ? "work.steerTooLong" : null;
  // A child that left the live tree has ended for this view: a late tail may update its text, never revive it.
  const ended = a => a && { ...a, status: a.status === "running" || a.status === "queued" ? "" : a.status, acceptingSteer: false };
  function create({ shell, deck, doc = root.document, h = shell.service("h"), t = root.DeckI18n.t,
    setTimer = root.setTimeout.bind(root), clearTimer = root.clearTimeout.bind(root),
    emit = detail => doc.dispatchEvent(new root.CustomEvent("deck-tool-select", { detail })),
    emitReveal = detail => doc.dispatchEvent(new root.CustomEvent("deck-tool-reveal", { detail })),
    receipts = () => root.DeckReceipts }) {
    let session = shell.last("session") || shell.state().session || {};
    let disposed = false, timer = null, pendingAgent = null, agentNotice = null;
    const cache = new Map(), off = [];
    const sidOf = s => s.sid || (s.kind === "hermes" ? s.id : null);
    const current = () => sidOf(session);
    function record(sid) {
      if (!cache.has(sid)) {
        cache.set(sid, { plan: null, planVersion: 0, loaded: false, loading: false, error: "",
          tools: [], toolsVersion: 0, toolError: "", toolsLoading: false, selected: null, pinned: false, extra: null, data: {}, writes: new Map(),
          agents: [], failed: [], agentError: "", agentLoading: false, agentsLoaded: false,
          agentId: null, detail: null, vanished: new Set(), tail: null, tailVersion: 0, agentMessages: new Map(), drafts: new Map(), busy: new Set(), expanded: new Set() });
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
    function replaceTools(sid, tools) {
      const r = record(sid), previous = r.tools.find(c => c.call === r.selected);
      r.tools = (Array.isArray(tools) ? tools : []).filter(c => c && c.call).slice(-30).map(c => ({ ...c, status: c.status || (c.ms == null ? "running" : "ok") }));
      for (const c of r.tools) if (changedFiles([c]).length) r.writes.set(c.call, c);
      while (r.writes.size > 200) r.writes.delete(r.writes.keys().next().value);
      if (r.selected && !r.tools.some(c => c.call === r.selected)) {
        if (r.pinned) { if (previous) r.extra = previous; }
        else r.selected = null;
      }
      if (r.extra && (r.extra.call !== r.selected || r.tools.some(c => c.call === r.extra.call))) r.extra = null;
      if (!r.pinned) r.selected = [...r.tools].reverse().find(c => c.status === "running")?.call || r.tools.at(-1)?.call || null;
    }
    function selectTool({ sid, call, source, tool }, { open = true, notify = true } = {}) {
      if (!sid || !call || disposed) return;
      const r = record(sid);
      if (source === "live" && r.pinned) return;
      const known = r.tools.some(c => c.call === call), given = tool && tool.call === call ? tool : null;
      // A live call is genuinely recent; an explicit older selection is shown beside the list, never merged into it.
      if (!known && given && source === "live") replaceTools(sid, [...r.tools, given]);
      if (r.selected !== call) r.revealNotice = null;
      r.selected = call; r.pinned = source !== "live";
      if (!r.tools.some(c => c.call === call)) {
        let found = given;
        if (!found) { try { found = receipts()?.calls?.(sid)?.find(c => c && c.call === call) || null; } catch { found = null; } }
        r.extra = found ? { ...found } : null;
      } else r.extra = null;
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
          const list = r.tools.slice(), index = list.findIndex(c => c.call === e.call);
          const call = { ...(index >= 0 ? list[index] : {}), ...e, status: e.ev === "tool_start" ? "running" : e.status || "ok" };
          if (index >= 0) list[index] = call; else list.push(call);
          replaceTools(e.sid, list);
          if (e.sid === current()) redraw();
        }
      }
    }
    const duration = ms => ms == null ? "—" : t("work.seconds", { n: (ms / 1000).toFixed(1) });
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
      emitReveal({ sid, call });
    }
    const revealButton = (sid, call) => h("button", { class: "wk-reveal", type: "button", onclick: () => showInChat(sid, call) }, t("work.showInChat"));
    function output(c, r, note, sid) {
      return h("section", { class: `wk-output${failed(c) ? " fail" : ""}` }, h("header", null, c.tool, h("code", null, c.call), revealButton(sid, c.call)),
        note ? h("p", { class: "wk-note", role: "status" }, note) : null,
        c.args ? disclosure(r, `run:${c.call}`, null, t("work.arguments"), h("pre", null, c.args)) : null,
        h("pre", null, c.err || c.result || t(c.status === "running" ? "work.running" : "work.noOutput")), h("p", { class: "wk-note" }, t("work.preview")));
    }
    function renderRun(el) {
      const sid = current();
      if (!sid) return el.replaceChildren(shell.empty(t("work.noSession")));
      const r = record(sid), stats = runStats(r.tools, r.data), bars = timingBars(r.tools);
      const inList = r.tools.find(c => c.call === r.selected);
      const outside = !inList && r.selected ? (r.extra?.call === r.selected ? r.extra : null) : null;
      el.replaceChildren(h("section", { class: "wk-content" }, r.toolError ? h("p", { class: "wk-error", role: "alert" }, r.toolError) : null,
        h("div", { class: "wk-stats" }, stat("work.calls", String(stats.calls)), stat("work.toolTime", duration(stats.time)), stat("work.failed", String(stats.failed), !!stats.failed), stat("work.cost", money(stats.cost, r.data.cost_estimated || r.data.costStatus === "estimated"))),
        h("p", { class: "wk-note" }, t("work.recentCalls")),
        r.revealNotice?.call === r.selected ? h("p", { class: "wk-note", role: "status" }, t(r.revealNotice.key)) : null,
        r.tools.length ? h("div", { class: "wk-gantt" }, r.tools.map((c, i) => h("div", { class: "wk-run-item" }, h("button", {
          class: `wk-run-row${c.call === r.selected ? " selected" : ""}${failed(c) ? " fail" : ""}`, type: "button", "aria-pressed": c.call === r.selected ? "true" : "false",
          title: c.args || c.tool, onclick: () => selectTool({ sid, call: c.call }, { open: false }) },
          h("span", { class: "wk-status", "aria-label": t(c.status === "running" ? "work.running" : failed(c) ? "work.failed" : "work.state.done") }, c.status === "running" ? "◌" : failed(c) ? "×" : "✓"),
          c.tool, h("span", { class: "wk-bar" }, h("i", { style: { left: `${bars[i].left}%`, width: `${bars[i].width}%` } })), h("span", { class: "wk-time" }, duration(c.ms))), revealButton(sid, c.call)))) : shell.empty(t(r.toolsLoading ? "work.loading" : "work.noTools")),
        inList ? output(inList, r, null, sid) : outside ? output(outside, r, t("work.selectedOutside"), sid)
          : r.selected ? h("p", { class: "wk-note", role: "status" }, t("work.selectedUnavailable")) : null));
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
    function renderDiff(el) {
      const sid = current();
      if (!sid) return el.replaceChildren(shell.empty(t("work.noSession")));
      const r = record(sid), files = changedFiles([...r.writes.values()]);
      el.replaceChildren(h("section", { class: "wk-content" },
        r.toolError ? h("p", { class: "wk-error", role: "alert" }, r.toolError) : null,
        h("p", { class: "wk-note" }, t("work.diffPreview")), files.length ? h("ul", { class: "wk-files" }, files.map(file => h("li", null,
          h("code", null, file.name), file.added !== null ? h("span", { class: "wk-add" }, `+${file.added}`) : null,
          file.removed !== null ? h("span", { class: "wk-del" }, `−${file.removed}`) : null))) : shell.empty(t(r.toolsLoading ? "work.loading" : "work.noFiles")),
        h("p", { class: "wk-note" }, t("work.noDiff"))));
    }
    const optsOf = () => session.profile ? { profile: session.profile } : undefined;
    async function loadAgents() {
      const sid = current();
      if (!sid || disposed || !shell.isOpen("work", "agents")) return;
      const r = record(sid);
      if (r.agentLoading) return;
      if (!deck.bridge?.subagents) { r.agentError = t("work.agentsNeedDirect"); redraw(); return; }
      r.agentLoading = true;
      try {
        const data = await deck.bridge.subagents(sid, optsOf());
        if (disposed) return;
        r.agents = Array.isArray(data.subagents) ? data.subagents.slice(0, 128) : [];
        r.failed = Array.isArray(data.failed) ? data.failed.slice(0, 64) : [];
        r.agentError = "";
        if (pendingAgent && pendingAgent.sid === sid) {
          const want = pendingAgent, hit = r.agents.find(a => (want.subagentId && a.id === want.subagentId) || (want.childSid && a.childSid === want.childSid));
          if (hit) { pendingAgent = null; agentNotice = null; r.agentId = hit.id; r.detail = hit; r.tail = null; r.tailVersion++; }
          else if (++want.reads >= 4) { pendingAgent = null; agentNotice = { sid, key: "work.agentMissing" }; }
        }
        const detail = r.agents.find(a => a.id === r.agentId);
        if (detail) { r.detail = detail; r.vanished.delete(detail.id); }
        else if (r.agentId) { r.vanished.add(r.agentId); r.detail = ended(r.detail); }
      } catch (e) { r.agentError = msg(e); }
      finally { r.agentLoading = false; r.agentsLoaded = true; if (sid === current()) redraw(); }
      if (sid === current() && shell.isOpen("work", "agents")) await loadTail();
    }
    async function loadTail() {
      const sid = current();
      if (!sid || disposed || !shell.isOpen("work", "agents")) return;
      const r = record(sid), id = r.agentId;
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
      shell.openRight("work", "agents");
      loadTail(); redraw();
    }
    async function mutateAgent(kind, sid, id) {
      const r = record(sid), a = r.agents.find(x => x.id === id) || r.detail;
      if (disposed || sid !== current() || id !== r.agentId || r.busy.has(id) || a?.status !== "running") return;
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
    function toolDisclosure(c, r) {
      return disclosure(r, `agent:${r.agentId}:${c.call}`, { class: `wk-tool${failed(c) ? " fail" : ""}` },
        [h("code", null, c.tool), h("span", null, c.args || ""), h("small", null, duration(c.ms))],
        h("pre", null, c.err || c.result || t("work.noOutput")));
    }
    // Without the direct mutation methods the controls are disabled; say why instead of failing silently.
    const controlNotice = a => a?.status === "running" && (!deck.bridge?.steerSubagent || !deck.bridge?.interruptSubagent) ? { text: t("work.controlNeedsDirect"), error: false } : null;
    // Shell holds pane rebuilds while typing. These controls still follow current runtime state.
    function syncControls(r) {
      const form = r.form;
      if (!form || form.id !== r.agentId || !form.field.isConnected) return;
      const a = r.agents.find(x => x.id === form.id) || r.detail;
      const busy = r.busy.has(form.id), draft = r.drafts.get(form.id) || "", message = r.agentMessages.get(form.id) || controlNotice(a);
      form.field.disabled = !canSteer(a) || busy || !deck.bridge?.steerSubagent;
      form.steer.disabled = form.field.disabled || !draft.trim();
      form.stop.disabled = a?.status !== "running" || busy || !deck.bridge?.interruptSubagent;
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
          h("span", { class: "wk-agent-dot", "aria-hidden": "true" }), h("span", null, h("b", null, agent.goal || agent.id), h("small", null, [agent.model, agent.effort, agentState(agent), duration(number(agent.elapsedS) === null ? null : agent.elapsedS * 1000)].filter(Boolean).join(" · ")))))) : shell.empty(t(r.agentLoading ? "work.loading" : "work.noAgents")),
          ...failedRows(r)));
        return;
      }
      const message = r.agentMessages.get(a.id) || controlNotice(a), busy = r.busy.has(a.id), tokens = a.tokens;
      const notes = agentNotes(r.tail?.text);
      const tokenCount = tokens ? (number(tokens.input) || 0) + (number(tokens.output) || 0) + (number(tokens.cache_read) || 0) + (number(tokens.cache_write) || 0) : null;
      const field = h("textarea", { class: "wk-steer-input", "data-hold": "", "aria-label": t("work.steerLabel"), placeholder: t("work.steerPlaceholder"), maxlength: 32000,
        disabled: !canSteer(a) || busy || !deck.bridge?.steerSubagent, oninput: e => { r.drafts.set(a.id, e.target.value); syncControls(r); },
        onkeydown: e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); mutateAgent("steer", sid, a.id); } } });
      field.value = r.drafts.get(a.id) || "";
      const steer = h("button", { class: "btn primary", type: "button", "data-action": "steer", disabled: !canSteer(a) || busy || !deck.bridge?.steerSubagent || !field.value.trim(), onclick: () => mutateAgent("steer", sid, a.id) }, t("work.steer"));
      const stop = h("button", { class: "btn danger-outline", type: "button", "data-action": "stop", disabled: a.status !== "running" || busy || !deck.bridge?.interruptSubagent, onclick: () => mutateAgent("stop", sid, a.id) }, t("work.stop"));
      const note = h("p", { class: message?.error ? "wk-error" : "wk-note", role: message?.error ? "alert" : "status", "data-agent-message": a.id }, message?.text || "");
      r.form = { id: a.id, field, steer, stop, note };
      el.replaceChildren(h("section", { class: "wk-content" }, h("button", { class: "wk-back", type: "button", onclick: () => { r.agentId = null; r.detail = null; r.tailVersion++; redraw(); } }, t("work.back")), error,
        h("header", { class: "wk-agent-head" }, h("b", null, a.id), h("small", null, [a.model, a.effort, agentState(a), a.state ? t(`work.runtimeState.${["idle", "thinking", "working", "searching", "finished", "error", "question", "approval", "ratelimit"].includes(a.state) ? a.state : "unknown"}`) : null].filter(Boolean).join(" · "))),
        r.vanished.has(a.id) ? h("p", { class: "wk-note", role: "status" }, t("work.agentGone")) : null,
        h("p", { class: "wk-task-goal" }, a.goal),
        h("div", { class: "wk-stats" }, stat("work.elapsed", duration(number(a.elapsedS) === null ? null : a.elapsedS * 1000)), stat("work.tokens", tokenCount === null ? "—" : String(tokenCount), false, t("work.tokensHint")), stat("work.calls", String(number(a.toolCount) ?? a.tools?.length ?? 0)), stat("work.agentCost", money(number(a.costUsd), a.costStatus === "estimated"))),
        notes ? [h("h3", { class: "wk-label" }, t("work.notes")), h("pre", { class: "wk-notes" }, notes)] : null,
        r.tail?.error ? h("p", { class: "wk-error", role: "alert" }, r.tail.error)
          : r.tail?.available === false ? h("p", { class: "wk-note" }, t("work.tailEnded")) : null,
        notes && r.tail?.truncated ? h("p", { class: "wk-note" }, t("work.tailClipped")) : null,
        h("h3", { class: "wk-label" }, t("work.calls")), h("div", { class: "wk-tools" }, (a.tools || []).map(c => toolDisclosure(c, r))),
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
    const receiptSelection = e => { if (e.detail && e.detail.source !== "run") selectTool(e.detail, { open: false, notify: false }); };
    doc.addEventListener("deck-tool-select", receiptSelection);
    const revealStatus = e => {
      const d = e.detail;
      if (disposed || !d || d.sid !== current()) return;
      const r = record(d.sid);
      if (d.call !== r.selected) return;
      const key = d.status === "loading" ? "work.historyLoading" : d.status === "missing" ? "work.historyMissing" : null;
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
    return { selectTool, selectAgent, openAgent, poll, dispose() { disposed = true; if (timer !== null) clearTimer(timer); off.forEach(f => f()); doc.removeEventListener("deck-language", language); doc.removeEventListener("deck-agent-select", agentSelection); doc.removeEventListener("deck-tool-select", receiptSelection); doc.removeEventListener("deck-tool-reveal-result", revealStatus); } };
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
  const api = { planSummary, runStats, timingBars, changedFiles, agentNotes, agentRows, canSteer, steerError, ended, create, createSurfaces };
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root.DeckShell && root.deck) {
    const pane = create({ shell: root.DeckShell, deck: root.deck });
    const surfaces = createSurfaces({ shell: root.DeckShell });
    root.DeckSurfaces = Object.freeze(surfaces);
    // top bar: a live Browser / Screen chip for the open session's agent, rebuilt when a surface or the language changes
    const shell = root.DeckShell, doc = root.document;
    const crumb = () => {
      if (typeof shell.mount !== "function") return;
      const profile = shell.last?.("session")?.profile || undefined;
      const chips = ["browser", "screen"].map(k => surfaces.chip(k, { profile })).filter(Boolean);
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
