"use strict";
var i18nNode = (key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).node(key, vars, typeof document === "object" ? document : null);
var i18nBind = (el, attr, key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).bind(el, attr, key, vars);
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
var i18nLocale = typeof module === "object" && module.exports ? require("./i18n").getLocale : window.DeckI18n.getLocale;
// Hermes Deck sub-agent views (window.DeckAgents.create(ctx)):
//   B1  one session or sub-agent in the chat column: header, message history, live steps, "Back to chat"
//   B2  "Running now": every running session and sub-agent across agents, on top of Activity
//   B3  tool calls that open to their full arguments and result (monospace, copy button)
//   B4  the sub-agent tree on Activity cards: nesting depth, retries linked, tokens/cost per branch
//   A13 role and OMH provenance chips on sub-agent rows
//   F2  prompts with their Telegram context ([Replying to: …], [Name|id], [Group context …]) folded away
// app.js owns the state (S), the scheduler and the prompt-prefix parser (splitPrompt); this file reads
// S.relay and reaches main only through deck.messages / messageFull / toolCall / session. Every string
// from the relay enters the DOM as a text node (or through DeckMarkdown, which never parses HTML).
(() => {
  // ---------------------------------------------------------------- pure helpers (unit-tested in Node)
  const FAILED = new Set(["failed", "stopped"]);
  const RETRY_WINDOW_S = 6 * 3600;

  /** Goals compared for retries: whitespace and case folded, the preview's "…" dropped. */
  const goalKey = (g) => String(g || "").replace(/…$/, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 160);

  /**
   * Retries: the same goal of the same agent re-run after an attempt that failed or was stopped (for example
   * failed with one model, redone with another). Returns sid -> {of?: earlier sid, by?: later sid}.
   */
  function retryIndex(sessions, windowS = RETRY_WINDOW_S) {
    const groups = new Map();
    for (const s of sessions) {
      if (!s || !s.parent) continue;
      const key = goalKey(s.goal);
      if (key.length < 8) continue; // "" or "x" says nothing about sameness
      const g = `${s.agent || ""}\u0000${key}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(s);
    }
    const out = new Map();
    const link = (sid, k, v) => out.set(sid, { ...(out.get(sid) || {}), [k]: v });
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => (a.firstTs || 0) - (b.firstTs || 0));
      list.forEach((a, i) => {
        if (!FAILED.has(a.state)) return;
        // the next attempt that started once this one had stopped (a copy running alongside is not a retry)
        const end = a.lastTs || a.firstTs || 0;
        const b = list.slice(i + 1).find((x) => (x.firstTs || 0) >= end - 5 && !(out.get(x.sid) || {}).of);
        if (!b || (b.firstTs || 0) - end > windowS) return;
        link(a.sid, "by", b.sid);
        link(b.sid, "of", a.sid);
      });
    }
    return out;
  }

  /** A session plus all its descendants: fresh/cached/output tokens, cost where known, size and depth. */
  function branchTotals(s, kidsOf) {
    const t = { fresh: 0, cr: 0, out: 0, cost: 0, hasCost: false, n: 0, depth: 0 };
    const seen = new Set();
    const walk = (x, d) => {
      if (!x || seen.has(x.sid)) return;
      seen.add(x.sid);
      const tk = x.tokens || {};
      t.fresh += (tk.in || 0) + (tk.cw || 0);
      t.cr += tk.cr || 0;
      t.out += tk.out || 0;
      if (typeof x.cost === "number" && x.cost > 0) {
        t.cost += x.cost;
        t.hasCost = true;
      }
      if (d > 0) t.n += 1;
      if (d > t.depth) t.depth = d;
      for (const c of kidsOf(x)) walk(c, d + 1);
    };
    walk(s, 0);
    return t;
  }

  /** Message ids sort in the order the store wrote them: Hermes row id, Claude byte offset (+ block). */
  function seqOf(id) {
    const m = /:(\d+)(?:\.(\d+))?$/.exec(String(id || ""));
    return m ? Number(m[1]) + (m[2] ? Number(m[2]) / 1e4 : 0) : 0;
  }

  /** A tool argument string, pretty-printed when it is a JSON object or array. */
  function pretty(s) {
    if (typeof s !== "string") return s === undefined || s === null ? "" : JSON.stringify(s, null, 2);
    const t = s.trim();
    if (!/^[[{]/.test(t)) return s;
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      return s; // clipped or not JSON: as is
    }
  }

  function create(ctx) {
    const { h, S, deck, mark, k, dur, ago, hm, ticker, stateOf, isLive, STATE_TR, where, cleanErr, kidsOf, nums, toolToggle, toolList, toggleTools, cardControls, splitPrompt, store } = ctx;
    const box = document.getElementById("detail");
    const oneLine = (s, n = 160) => {
      const t = String(s || "").replace(/\s+/g, " ").trim();
      return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
    };
    const sessions = () => S.relay.sessions;

    // ---------------------------------------------------------------- shared pieces
    /** A13: OMH route and role chips for a sub-agent (nothing for native Hermes children). */
    function labels(s) {
      const out = [];
      if (s.origin === "omh") {
        const r = s.route || {};
        const tip = r.model ? i18nText("U0346", { v: r.category || "?", model: r.model, v2: r.provider ? ` (${r.provider}${r.effort ? `, ${r.effort}` : ""})` : "" }) : i18nText("U0347");
        out.push(h("span", { class: "sa-lbl omh", title: tip }, r.category ? `OMH · ${r.category}` : "OMH"));
      }
      const role = s.omhRole || s.role;
      if (role && s.parent) out.push(h("span", { class: "sa-lbl", title: s.omhRole ? i18nText("U0348") : i18nText("U0349") }, role));
      return out;
    }

    const tokText = (t) => [i18nText("time.freshCount", { fresh: k(t.fresh) }), t.cr ? i18nText("U0350", { cr: k(t.cr) }) : null, i18nText("U0351", { out: k(t.out) }), t.hasCost ? `$${t.cost.toFixed(2)}` : null].filter(Boolean).join(" · ");

    /** Where a session sits: "Agent · # topic" for top-level, its goal for a sub-agent. */
    function titleOf(s) {
      if (!s) return "";
      if (s.parent) return oneLine(s.goal || s.sa || i18nText("common.subagent"), 240);
      const p = s.lastMsg ? splitPrompt(s.lastMsg) : null;
      return oneLine((p && !p.cut && p.text) || s.lastMsg || "", 240);
    }

    async function copyText(text, btn) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = h("textarea", { class: "sr-only", readonly: true });
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      if (btn) {
        i18nBind(btn, "textContent", "U0352");
        btn.classList.add("done");
        setTimeout(() => {
          i18nBind(btn, "textContent", "A0053");
          btn.classList.remove("done");
        }, 1500);
      }
    }

    const copyBtn = (text) => h("button", { class: "copy", type: "button", title: i18nText("A0195"), onclick: (e) => copyText(text, e.currentTarget) , "data-i18n-title": "A0195"}, i18nNode("A0053"));

    // ---------------------------------------------------------------- F2: prompt context
    const ctxOpen = new Set(); // keys whose "context" is expanded

    function ctxLines(blocks) {
      return blocks.map((b) =>
        h("div", { class: `pctx-line ${b.kind}` },
          h("span", { class: "pctx-kind" }, b.kind === "reply" ? i18nNode("U0353") : b.kind === "sender" ? i18nNode("U0354") : b.cut ? i18nNode("common.truncated") : i18nNode("U0355")),
          h("span", { class: "pctx-text" }, b.body || ""))
      );
    }

    /** The "context" chip (and its box when open) for blocks split off a prompt; key keeps it open across renders. */
    function ctxChip(key, blocks) {
      if (!blocks.length) return null;
      const open = ctxOpen.has(key);
      const n = blocks.length;
      const tip = blocks.map((b) => oneLine(b.body, 80)).join(" · ");
      return h("div", { class: "pctx" },
        h("button", {
          class: "pctx-chip", type: "button", "aria-expanded": open ? "true" : "false", title: open ? null : tip, dataset: { fk: `ctx:${key}` },
          onclick: (e) => {
            e.stopPropagation();
            if (open) ctxOpen.delete(key);
            else ctxOpen.add(key);
            mark("panel", "msgs", true);
            renderSoon(true);
          },
        }, open ? i18nNode("U0356") : i18nNode("U0357", { v: n > 1 ? ` (${n})` : "" })),
        open ? h("div", { class: "pctx-box" }, ctxLines(blocks)) : null);
    }

    /** F2 split of one prompt: the request text, the reply quote and the folded context blocks. */
    function promptParts(text) {
      const p = splitPrompt(text || "");
      const blocks = p.blocks.slice();
      let req = p.text;
      if (p.cut) {
        // a clipped preview that ends inside a context block: the request itself is not in it
        blocks.push({ kind: "context", body: p.text, cut: true });
        req = "";
      }
      return { req, reply: blocks.find((b) => b.kind === "reply") || null, blocks };
    }

    /** Activity card prompt: the request first, everything bracketed folded into "context". */
    function ask(s) {
      const { req, blocks } = promptParts(s.lastMsg);
      return h("div", { class: "ask-wrap" },
        h("p", { class: "ask", title: req || null }, req || h("span", { class: "muted" }, i18nNode("U0358"))),
        ctxChip(`card:${s.sid}`, blocks));
    }

    /** A user message in a chat view: reply quote on top, sender tag dropped, other context folded. */
    function userMessage(text, key) {
      const { req, reply, blocks } = promptParts(text);
      const rest = blocks.filter((b) => b.kind === "context");
      return {
        quote: reply ? h("div", { class: "rq static", title: reply.body }, h("span", { class: "rq-who" }, i18nNode("U0057")), h("span", { class: "rq-text" }, oneLine(reply.body, 400))) : null,
        text: req,
        chip: ctxChip(key, rest),
      };
    }

    // ---------------------------------------------------------------- B3: tool calls
    const callOpen = new Set(); // "<key>" of expanded calls
    const callFull = new Map(); // key -> {loading} | {error} | {args, result, status}

    function statusEl(c) {
      if (c.running) return h("span", { class: "call-st run" }, c.since ? ticker(c.since, i18nText("U0359")) : i18nNode("U0360"));
      if (c.status === undefined || c.status === null) return h("span", { class: "call-st" });
      const ok = c.status === "ok";
      return h("span", { class: `call-st ${ok ? "ok" : "err"}` }, `${ok ? "✓" : "✗"}${c.ms !== undefined ? ` ${dur(c.ms)}` : ""}`);
    }

    function block(label, text, bad) {
      const s = text === undefined || text === null ? "" : String(text);
      return h("div", { class: `cblock${bad ? " bad" : ""}` },
        h("div", { class: "cblock-head" }, h("span", null, label), h("span", { class: "cblock-len" }, s ? i18nNode("common.characters", { v: s.length.toLocaleString(i18nLocale()) }) : ""), s ? copyBtn(s) : null),
        h("pre", { class: "cpre" }, s || "—"));
    }

    async function toggleCall(c, block = "nearest") {
      if (callOpen.has(c.key)) {
        callOpen.delete(c.key);
        if (D.pin === c.key) D.pin = null;
      } else {
        callOpen.add(c.key);
        if (D.sid) D.anchor = { key: c.key, block };
        if (c.loadFull && !callFull.has(c.key)) {
          callFull.set(c.key, { loading: true });
          try {
            callFull.set(c.key, await c.loadFull());
          } catch (e) {
            callFull.set(c.key, { error: cleanErr(e) });
          }
        }
      }
      if (D.sid && callOpen.has(c.key)) D.anchor = { key: c.key, block }; // again, now that the full text is in
      mark("panel", true);
      renderSoon(true);
    }

    /**
     * One tool call row that opens to its full input and result.
     * c = {key, name, args, result, status, ms, ts, running, since, loadFull?}
     */
    function callRow(c) {
      const open = callOpen.has(c.key);
      const head = h("button", { class: "call-head", type: "button", "aria-expanded": open ? "true" : "false", title: open ? i18nText("A0197") : i18nText("U0361"), dataset: { fk: `call:${c.key}` }, onclick: () => toggleCall(c) },
        h("span", { class: "call-chev", "aria-hidden": "true" }, open ? "▾" : "▸"),
        h("span", { class: "call-time" }, c.ts ? hm(c.ts) : ""),
        h("span", { class: "call-name" }, c.name || "?"),
        h("span", { class: "call-args" }, oneLine(c.args)),
        statusEl(c));
      if (!open) return h("div", { class: "call" }, head);
      const f = callFull.get(c.key) || {};
      const args = f.args !== undefined ? f.args : c.args;
      const result = f.result !== undefined ? f.result : c.result;
      const bad = c.status && c.status !== "ok";
      return h("div", { class: "call open" }, head,
        h("div", { class: "call-body" },
          f.loading ? h("p", { class: "call-note" }, i18nNode("U0362")) : null,
          f.error ? h("p", { class: "call-note" }, i18nNode("U0363", { error: f.error })) : null,
          block(i18nText("A0199"), pretty(args)),
          c.running && (result === undefined || result === null) ? h("p", { class: "call-note" }, i18nNode("U0364")) : block(bad ? i18nText("U0365") : i18nText("U0366"), result, bad)));
    }

    /** Activity tool row (B3): the relay's 300-char previews, the full call fetched on first open. */
    function toolRow(sid, t) {
      return callRow({
        key: `${sid}#${t.call}`,
        name: t.tool,
        args: t.args,
        result: t.result || t.err,
        status: t.status,
        ms: t.ms,
        ts: t.ts,
        running: t.status === undefined,
        since: t.status === undefined ? t.ts : null,
        loadFull: t.call ? async () => {
          const r = await deck.toolCall(sid, t.call);
          return { args: r.args, result: r.result };
        } : null,
      });
    }

    // ---------------------------------------------------------------- B4: sub-agent tree
    let retries = new Map();
    let retriesAt = 0;
    function retryOf(sid) {
      if (Date.now() - retriesAt > 500) {
        retries = retryIndex(sessions().values());
        retriesAt = Date.now();
      }
      return retries.get(sid) || null;
    }

    const shortGoal = (s) => oneLine(s ? s.goal || s.sa || i18nText("common.subagent") : "?", 60);

    function retryLine(s) {
      const r = retryOf(s.sid);
      if (!r) return null;
      const bits = [];
      if (r.of) {
        const a = sessions().get(r.of);
        bits.push(h("button", { class: "retry", type: "button", title: a ? i18nText("U0367", { a: shortGoal(a) }) : null, onclick: () => open(r.of) },
          i18nNode("A0200", { v: a && a.model ? `${a.model} ` : "", v2: a ? STATE_TR[stateOf(a)] || a.state : i18nText("U0368"), v3: s.model && a && a.model && a.model !== s.model ? i18nText("A0201", { model: s.model }) : "" })));
      }
      if (r.by) {
        const b = sessions().get(r.by);
        bits.push(h("button", { class: "retry", type: "button", title: b ? i18nText("A0202", { b: shortGoal(b) }) : null, onclick: () => open(r.by) },
          i18nNode("A0203", { v: b && b.model ? ` → ${b.model}` : "", v2: b ? ` (${STATE_TR[stateOf(b)] || b.state})` : "" })));
      }
      return h("p", { class: "retry-line" }, bits);
    }

    /** One sub-agent and its own sub-agents. compact (inside B1): no tool lists or controls, a click opens it. */
    function node(c, depth, compact) {
      const st = stateOf(c);
      const kids = kidsOf(c);
      const branch = kids.length ? branchTotals(c, kidsOf) : null;
      const fkp = compact ? "dt-" : "";
      return h("div", { class: `node${depth > 1 ? " deep" : ""}${D.sid === c.sid ? " here" : ""}`, dataset: { depth: String(depth) } },
        h("div", { class: "node-line" },
          h("span", { class: `state ${st}` }, STATE_TR[st] || st),
          depth > 1 ? h("span", { class: "depth", title: i18nText("A0204", { depth: depth }) , "data-i18n-title": "A0204", "data-i18n-title-vars": JSON.stringify({ depth: depth })}, `${depth}.`) : null,
          h("button", { class: "node-goal", type: "button", title: i18nText("U0369", { v: c.goal || c.sa || i18nText("common.subagent") }), dataset: { fk: `${fkp}node:${c.sid}` }, onclick: () => open(c.sid) , "data-i18n-title": "U0369", "data-i18n-title-vars": JSON.stringify({ v: c.goal || c.sa || i18nText("common.subagent") })}, c.goal || c.sa || i18nNode("common.subagent")),
          labels(c),
          h("span", { class: "muted node-model" }, c.model || "")),
        retryLine(c),
        isLive(c) && c.curTool ? h("p", { class: "now" }, ticker(c.curTool.since, `${c.curTool.tool} · `)) : null,
        h("p", { class: "nums" }, nums(c), branch ? h("span", { class: "branch", title: i18nText("U0370") , "data-i18n-title": "U0370"}, i18nNode("A0205", { branch: tokText(branch) })) : null),
        !compact && cardControls ? cardControls(c.sid) : null,
        compact ? null : toolToggle(c),
        !compact && S.open.has(c.sid) ? toolList(c.sid) : null,
        kids.length ? h("div", { class: "branch-kids" }, kids.map((g) => node(g, depth + 1, compact))) : null);
    }

    /** B4: the whole tree under a top-level session (replaces the flat sub-agent list on the card). */
    function tree(s, compact) {
      const kids = kidsOf(s);
      if (!kids.length) return null;
      const t = branchTotals(s, kidsOf);
      const live = [];
      const walk = (x) => {
        for (const c of kidsOf(x)) {
          if (isLive(c)) live.push(c);
          walk(c);
        }
      };
      walk(s);
      const sum = [i18nText("common.subagents", { n: t.n }), t.depth > 1 ? i18nText("common.levels", { depth: t.depth }) : null, live.length ? i18nText("U0371", { length: live.length }) : null].filter(Boolean).join(" · ");
      return h("div", { class: "tree" },
        h("p", { class: "tree-sum" }, h("span", { class: live.length ? "live" : "" }, sum), h("span", { title: i18nText("U0372") , "data-i18n-title": "U0372"}, i18nNode("A0206", { t: tokText(t) }))),
        kids.map((c) => node(c, 1, compact)));
    }

    /** "Session details" on a card: opens B1 for the top-level session itself. */
    const detailLink = (s) => h("button", { class: "linkbtn", type: "button", dataset: { fk: `open:${s.sid}` }, onclick: () => open(s.sid) }, i18nNode("U0373"));

    // ---------------------------------------------------------------- B2: running now
    let runClosed = store.get("deck.runningClosed") === "1";

    function runRow(s, depth, parentShown) {
      const top = !s.parent;
      const title = titleOf(s) || (top ? i18nText("common.session") : i18nText("common.subagent"));
      const parent = s.parent ? sessions().get(s.parent) : null;
      const ctxBits = top ? [s.agent, where(s)] : parentShown ? [] : [s.agent, parent ? i18nText("U0374", { v: where(parent) || "?" }) : i18nText("common.subagent")];
      const startTs = top ? s.turnTs || s.firstTs : s.firstTs;
      return h("button", { class: `run-row${depth ? " sub" : ""}`, type: "button", style: depth ? { "--depth": String(depth) } : null, title: i18nText("U0375", { title: title }), dataset: { fk: `run:${s.sid}` }, onclick: () => open(s.sid) , "data-i18n-title": "U0375", "data-i18n-title-vars": JSON.stringify({ title: title })},
        h("span", { class: "run-dot", "aria-hidden": "true" }),
        h("span", { class: "run-main" },
          h("span", { class: "run-title" }, ctxBits.filter(Boolean).length ? h("span", { class: "run-where" }, `${ctxBits.filter(Boolean).join(" · ")} · `) : null, title),
          h("span", { class: "run-now" }, s.curTool ? ticker(s.curTool.since, `${s.curTool.tool} · `) : i18nNode("U0376"), labels(s))),
        h("span", { class: "run-dur", title: top ? i18nText("U0377") : i18nText("U0378") }, startTs ? ticker(startTs) : ""));
    }

    function runningBlock() {
      if (S.relay.status !== "open" && !sessions().size) return null;
      const live = [...sessions().values()].filter(isLive);
      const ids = new Set(live.map((s) => s.sid));
      const order = Object.keys(S.relay.agents || {});
      const rank = (s) => {
        const i = order.indexOf(s.agent);
        return i === -1 ? order.length : i;
      };
      // top-level sessions with their running descendants; then running sub-agents whose parent is idle
      const rows = [];
      const done = new Set();
      const add = (s, depth, parentShown) => {
        if (done.has(s.sid)) return;
        done.add(s.sid);
        rows.push(runRow(s, depth, parentShown));
        for (const c of kidsOf(s)) if (ids.has(c.sid)) add(c, depth + 1, true);
      };
      const tops = live.filter((s) => !s.parent).sort((a, b) => rank(a) - rank(b) || (b.turnTs || b.firstTs) - (a.turnTs || a.firstTs));
      for (const s of tops) add(s, 0, false);
      const orphans = live.filter((s) => s.parent && !ids.has(s.parent)).sort((a, b) => rank(a) - rank(b) || a.firstTs - b.firstTs);
      for (const s of orphans) add(s, 0, false);
      for (const s of live) add(s, 0, false);
      const head = h("button", { class: "runnow-head", type: "button", "aria-expanded": runClosed ? "false" : "true", dataset: { fk: "running" }, onclick: () => {
        runClosed = !runClosed;
        store.set("deck.runningClosed", runClosed ? "1" : "0");
        mark("panel", true);
      } },
        h("span", null, h("span", { class: "chev", "aria-hidden": "true" }, runClosed ? "▸" : "▾"), i18nNode("U0379")),
        h("span", { class: rows.length ? "live" : "" }, rows.length ? String(rows.length) : i18nNode("common.none")));
      return h("section", { class: `runnow${rows.length ? " busy" : ""}`, "aria-label": i18nText("U0379") , "data-i18n-aria-label": "U0379"},
        head,
        runClosed ? null : rows.length ? h("div", { class: "run-list" }, rows) : h("p", { class: "run-empty" }, i18nNode("U0380")));
    }

    // ---------------------------------------------------------------- B1: detail in the chat column
    const D = {
      sid: null,
      gen: 0, // bumps on every open/close: late answers for another session are dropped
      items: new Map(), // id -> history item
      next: undefined, // older-page cursor (null: nothing older; undefined: first page not here yet)
      meta: null,
      loading: false,
      error: null,
      fallback: null, // /session/<sid> (recent tools) when the history route is unavailable
      live: new Map(), // call -> live step from relay events
      wantExpand: null, // fixture scene: a call to open once loaded
      treeOpen: null, // the header's sub-agent tree; null = open when it is small
      anchor: null, // {key, block}: a call to bring into view on the next render
      pin: null, // key of the opened call that keeps its place until the user scrolls
      refreshT: 0,
    };
    let headEl = null;
    let bodyEl = null;

    function reset(sid) {
      D.gen += 1;
      D.sid = sid;
      D.items = new Map();
      D.next = undefined;
      D.meta = null;
      D.loading = false;
      D.error = null;
      D.fallback = null;
      D.live = new Map();
      D.wantExpand = null;
      D.treeOpen = null;
      D.anchor = null;
      D.pin = null;
      clearTimeout(D.refreshT);
      D.refreshT = 0;
    }

    function open(sid, opts = {}) {
      if (!sid || !box) return;
      if (D.sid !== sid) reset(sid);
      if (opts.expand) D.wantExpand = opts.expand;
      document.body.classList.add("detail-open");
      box.hidden = false;
      if (!headEl) {
        headEl = h("header", { class: "dt-head" });
        bodyEl = h("div", { class: "dt-body", tabindex: "-1" });
        // the user scrolling releases a pinned call; from then on the view follows the newest message again
        const unpin = () => (D.pin = null);
        bodyEl.addEventListener("wheel", unpin, { passive: true });
        bodyEl.addEventListener("keydown", (e) => /^(Page|Arrow|Home|End| )/.test(e.key) && unpin());
        bodyEl.addEventListener("pointerdown", (e) => e.target === bodyEl && unpin()); // the scrollbar
        box.replaceChildren(headEl, bodyEl);
      }
      renderNow(true);
      if (!D.items.size && !D.loading) load(false);
      requestAnimationFrame(() => bodyEl && bodyEl.focus({ preventScroll: true }));
    }

    function close() {
      if (!D.sid) return;
      reset(null);
      document.body.classList.remove("detail-open");
      if (box) box.hidden = true;
      mark("head", "msgs", "strip", true);
      const input = document.getElementById("input");
      if (input) input.focus({ preventScroll: true });
    }

    async function load(older) {
      const sid = D.sid;
      const gen = D.gen;
      if (!sid || D.loading) return;
      D.loading = true;
      renderSoon(true);
      try {
        const r = await deck.messages(sid, older ? D.next : undefined);
        if (gen !== D.gen) return;
        const items = r.items || [];
        // a newest page that no longer touches what is loaded (many new messages): start over from it
        const gap = !older && D.items.size && items.length && !items.some((i) => D.items.has(i.id));
        if (gap) D.items = new Map();
        for (const it of items) D.items.set(it.id, it);
        if (older || gap || D.next === undefined) D.next = r.next || null;
        if (r.meta) D.meta = r.meta;
        D.error = null;
        if (D.wantExpand) {
          const key = findCallKey(D.wantExpand);
          if (key) {
            D.wantExpand = null;
            const c = callsById().get(key);
            if (c) toggleCall(c, "start");
          }
        }
      } catch (e) {
        if (gen !== D.gen) return;
        D.error = cleanErr(e);
        if (!D.fallback) {
          try {
            const d = await deck.session(sid);
            if (gen === D.gen) D.fallback = { recent: d.recent || [] };
          } catch {
            /* the live model may not know it either */
          }
        }
      } finally {
        if (gen === D.gen) {
          D.loading = false;
          renderSoon(true);
        }
      }
    }

    /** Re-read the newest page soon after the open session moved (debounced). */
    function refreshSoon() {
      if (!D.sid || D.refreshT) return;
      D.refreshT = setTimeout(() => {
        D.refreshT = 0;
        if (D.sid && !D.error) load(false);
      }, 1800);
    }

    function onRelay(m) {
      if (!D.sid) return;
      // any push may move the header (its sub-agent tree, the parent link); renders are throttled
      const touched = m.t === "evs" || m.t === "snapshot";
      if (m.t === "evs") {
        for (const e of m.evs || []) {
          if (e.ev === "sub_stop" && e.child === D.sid) refreshSoon(); // the open sub-agent just finished
          if (e.sid !== D.sid) continue;
          if (e.ev === "tool_start" && e.call) D.live.set(e.call, { call: e.call, tool: e.tool, args: e.args, ts: e.ts });
          else if (e.ev === "tool_end" && e.call) {
            const x = D.live.get(e.call) || { call: e.call, tool: e.tool, ts: e.ts };
            Object.assign(x, { status: e.status, ms: e.ms, result: e.result || e.err });
            D.live.set(e.call, x);
          }
          if (/^(tool_end|turn_end|llm|session_end)$/.test(e.ev)) refreshSoon();
        }
      }
      if (touched) renderSoon(false);
    }

    // rendering: throttled; the body keeps its scroll position, or follows the newest message when it was there
    let rafT = 0;
    let lastRender = 0;
    let soonT = 0;
    function renderSoon(force) {
      if (!D.sid) return;
      if (force) return renderNow();
      if (soonT || rafT) return;
      const wait = Math.max(0, 700 - (Date.now() - lastRender));
      soonT = setTimeout(() => {
        soonT = 0;
        renderNow();
      }, wait);
    }
    function renderNow(toEnd) {
      if (rafT) return;
      rafT = requestAnimationFrame(() => {
        rafT = 0;
        lastRender = Date.now();
        if (!D.sid || !headEl) return;
        const callEl = (key) => (key ? bodyEl.querySelector(`[data-fk="${CSS.escape(`call:${key}`)}"]`) : null);
        const top0 = () => bodyEl.getBoundingClientRect().top;
        // a call the user opened keeps its place while new steps arrive below it
        const pinned = !D.anchor && callEl(D.pin);
        const pinOffset = pinned ? pinned.getBoundingClientRect().top - top0() : null;
        const atEnd = !pinned && (toEnd || bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 48);
        const keep = bodyEl.scrollTop;
        const a = document.activeElement;
        const fk = a && box.contains(a) && a.dataset ? a.dataset.fk : null; // focus stays on the same control
        headEl.replaceChildren(...detailHead().filter(Boolean)); // replaceChildren would print a null as "null"
        bodyEl.replaceChildren(...detailBody().filter(Boolean));
        bodyEl.scrollTop = atEnd ? bodyEl.scrollHeight : keep;
        if (fk) {
          const el = box.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
          if (el) el.focus({ preventScroll: true });
        }
        const anchored = D.anchor && callEl(D.anchor.key);
        if (anchored) {
          // a call just opened comes into view (from the top when a scene opened it) and stays pinned
          anchored.scrollIntoView({ block: D.anchor.block });
          D.pin = D.anchor.key;
        } else if (pinOffset !== null) {
          const el = callEl(D.pin);
          if (el) bodyEl.scrollTop += el.getBoundingClientRect().top - top0() - pinOffset;
          else D.pin = null;
        }
        D.anchor = null;
      });
    }

    function sorted() {
      return [...D.items.values()].sort((a, b) => seqOf(a.id) - seqOf(b.id));
    }

    /** Every call in the loaded history: key -> callRow source (args from the assistant item, result from the tool item). */
    function callsById() {
      const results = new Map();
      for (const it of D.items.values()) if (it.role === "tool" && it.call) results.set(it.call, it);
      const s = sessions().get(D.sid);
      const working = !!(s && isLive(s)); // a finished session's call without a result is not "running"
      const out = new Map();
      for (const it of D.items.values()) {
        for (const c of it.calls || []) {
          const res = results.get(c.call);
          const key = `${it.id}#${c.call}`;
          const liveStep = D.live.get(c.call);
          out.set(key, {
            key,
            name: c.name,
            args: c.args,
            result: res ? res.text : liveStep ? liveStep.result : undefined,
            status: res ? res.status || "ok" : liveStep ? liveStep.status : undefined,
            ms: liveStep ? liveStep.ms : undefined,
            ts: it.ts,
            running: working && !res && !(liveStep && liveStep.status),
            since: it.ts,
            loadFull: c.truncated || (res && res.truncated) ? async () => fullCall(it, c, res) : null,
          });
        }
      }
      return out;
    }

    function findCallKey(callId) {
      for (const key of callsById().keys()) if (key.endsWith(`#${callId}`)) return key;
      return null;
    }

    /** B3 inside B1: the call's full args and result from /message/<id>/full (both items when both were clipped). */
    async function fullCall(asked, c, res) {
      const out = {};
      if (c.truncated) {
        const f = await deck.messageFull(asked.id);
        const fc = (f.calls || []).find((x) => x.call === c.call);
        if (fc) out.args = fc.args;
      }
      if (res && res.truncated) {
        const f = await deck.messageFull(res.id);
        out.result = f.text;
      }
      return out;
    }

    function detailHead() {
      const s = sessions().get(D.sid) || null;
      const m = D.meta || {};
      const st = s ? stateOf(s) : m.endedAt ? "done" : "idle";
      const parentSid = (s && s.parent) || m.parent || null;
      const parent = parentSid ? sessions().get(parentSid) : null;
      const title = s ? titleOf(s) : "";
      const t = s ? branchTotals({ ...s, children: [] }, () => []) : null;
      const tok = m.tokens ? { fresh: (m.tokens.in || 0) + (m.tokens.cw || 0), cr: m.tokens.cr || 0, out: m.tokens.out || 0, cost: m.cost || 0, hasCost: typeof m.cost === "number" && m.cost > 0 } : null;
      // the store's totals cover the whole session; the live model only what the relay saw
      const tokens = tok && (!t || tok.fresh + tok.cr + tok.out >= t.fresh + t.cr + t.out) ? tok : t;
      if (tokens && s && s.cost > 0 && !tokens.hasCost) Object.assign(tokens, { cost: s.cost, hasCost: true });
      const startTs = s ? (s.parent ? s.firstTs : s.turnTs || s.firstTs) : m.startedAt;
      const running = s && isLive(s);
      const span = running && startTs
        ? ticker(startTs)
        : s && s.ms
          ? dur(s.ms)
          : m.startedAt && m.endedAt
            ? dur((m.endedAt - m.startedAt) * 1000)
            : s
              ? dur(Math.max(0, (s.lastTs - s.firstTs) * 1000))
              : "";
      const kind = s ? (s.parent ? i18nText("common.subagent") : i18nText("common.session")) : parentSid ? i18nText("common.subagent") : i18nText("common.session");
      const metaBits = [
        h("span", null, i18nNode("U0381", { v: typeof span === "string" ? span : "" }), typeof span === "string" ? null : span),
        tokens ? h("span", null, tokText(tokens)) : null,
        s && s.ntools ? h("span", null, i18nNode("U0382", { ntools: s.ntools })) : m.tools ? h("span", null, i18nNode("U0383", { tools: m.tools })) : null,
        s && s.lastTs ? h("span", { title: new Date(s.lastTs * 1000).toLocaleString(i18nLocale()) }, i18nNode("A0207", { lastTs: ago(s.lastTs) })) : null,
      ].filter(Boolean);
      const kids = s ? kidsOf(s) : [];
      return [
        h("div", { class: "dt-top" },
          h("button", { class: "btn mini dt-back", type: "button", title: i18nText("U0384"), dataset: { fk: "dt-back" }, onclick: close , "data-i18n-title": "U0384"}, i18nNode("U0385")),
          h("span", { class: `state ${st}` }, STATE_TR[st] || st),
          h("span", { class: "dt-kind" }, kind),
          s ? labels(s) : null,
          h("span", { class: "dt-model" }, (s && s.model) || m.model || ""),
          s && s.agent ? h("span", { class: "dt-agent" }, `${s.agent}${!s.parent && where(s) ? ` · ${where(s)}` : ""}`) : null),
        h("h2", { class: "dt-title", title: title || null }, title || (m.title ? oneLine(m.title, 240) : i18nNode("A0208", { v: D.sid.slice(-8) }))),
        h("p", { class: "dt-meta" }, metaBits.flatMap((b, i) => (i ? [h("span", { class: "dt-sep", "aria-hidden": "true" }, "·"), b] : [b]))),
        parentSid
          ? h("p", { class: "dt-parent" }, i18nNode("U0386"),
            h("button", { class: "linkbtn", type: "button", dataset: { fk: "dt-parent" }, onclick: () => open(parentSid) },
              parent ? `${parent.parent ? i18nText("A0209") : `${parent.agent}${where(parent) ? ` · ${where(parent)}` : ""} · `}${oneLine(titleOf(parent), 70) || parentSid.slice(-8)}` : parentSid.slice(-12)))
          : null,
        s ? retryLine(s) : null,
        isLive(s || {}) && s.curTool ? h("p", { class: "now" }, ticker(s.curTool.since, `${s.curTool.tool} · `)) : null,
        kids.length
          ? h("details", { class: "dt-tree", open: (D.treeOpen === null ? kids.length <= 6 : D.treeOpen) ? true : null, ontoggle: (e) => (D.treeOpen = e.currentTarget.open) },
            h("summary", { dataset: { fk: "dt-tree" } }, i18nNode("A0210", { n: branchTotals(s, kidsOf).n })), tree(s, true))
          : null,
      ];
    }

    function itemLabel(it, first) {
      const role = it.role === "user" ? (first && D.meta && D.meta.parent ? i18nText("U0387") : i18nText("common.request")) : it.role === "assistant" ? i18nText("common.agent") : it.role === "tool" ? i18nText("U0388") : it.role;
      return h("div", { class: "dt-label" }, h("span", null, role), it.ts ? h("time", { title: new Date(it.ts * 1000).toLocaleString(i18nLocale()) }, hm(it.ts)) : null);
    }

    function textBlock(text, md) {
      if (!text) return null;
      const M = window.DeckMarkdown;
      if (md && M && M.looksLike(text)) {
        const d = h("div", { class: "dt-text md" });
        d.appendChild(M.render(text, { openUrl: (u) => deck.openExternal(u) }));
        return d;
      }
      return h("div", { class: "dt-text" }, text);
    }

    function detailBody() {
      const out = [];
      const list = sorted();
      if (D.next) {
        out.push(h("div", { class: "dt-older" }, h("button", { class: "linkbtn", type: "button", disabled: D.loading, dataset: { fk: "dt-older" }, onclick: () => load(true) }, D.loading ? i18nNode("U0389") : i18nNode("A0211"))));
      }
      if (!list.length) {
        if (D.loading) out.push(h("p", { class: "dt-empty" }, i18nNode("U0390")));
        else if (D.error) out.push(h("p", { class: "dt-empty" }, i18nNode("U0391", { error: D.error }), h("br"), h("span", { class: "muted" }, i18nNode("U0392"))));
        else out.push(h("p", { class: "dt-empty" }, i18nNode("U0393")));
      } else if (D.error) out.push(h("p", { class: "dt-warn" }, i18nNode("U0394", { error: D.error })));
      const calls = callsById();
      const asked = new Set();
      for (const it of list) for (const c of it.calls || []) asked.add(c.call);
      let first = true;
      for (const it of list) {
        if (it.role === "tool" && it.call && asked.has(it.call)) continue; // shown under its call
        out.push(itemEl(it, calls, first));
        first = false;
      }
      // live steps: tool calls the relay saw that the history does not have yet
      const known = new Set([...asked, ...list.filter((i) => i.role === "tool").map((i) => i.call)]);
      const s = sessions().get(D.sid);
      const steps = [...D.live.values()].filter((x) => !known.has(x.call));
      if (s && isLive(s) && s.curTool && s.curTool.call && !known.has(s.curTool.call) && !D.live.has(s.curTool.call)) steps.push({ call: s.curTool.call, tool: s.curTool.tool, ts: s.curTool.since });
      const fb = D.fallback && !list.length ? D.fallback.recent.filter((x) => !known.has(x.call)) : [];
      const all = [...fb, ...steps];
      if (all.length) {
        out.push(h("div", { class: "dt-item dt-live" },
          h("div", { class: "dt-label" }, h("span", { class: steps.length && s && isLive(s) ? "live" : "" }, steps.length ? i18nNode("U0395") : i18nNode("U0396"))),
          h("div", { class: "dt-content" }, all.map((x) => callRow({
            key: `${D.sid}#${x.call}`, name: x.tool, args: x.args, result: x.result, status: x.status, ms: x.ms, ts: x.ts,
            running: x.status === undefined, since: x.ts,
            loadFull: x.call ? async () => {
              const r = await deck.toolCall(D.sid, x.call);
              return { args: r.args, result: r.result };
            } : null,
          })))));
      }
      if (s && isLive(s) && !s.curTool) out.push(h("p", { class: "dt-thinking" }, i18nNode("U0397")));
      return out;
    }

    function itemEl(it, calls, first) {
      if (it.role === "user") {
        const u = userMessage(it.text, `dt:${it.id}`);
        return h("div", { class: "dt-item user" }, itemLabel(it, first), h("div", { class: "dt-content" }, u.quote, textBlock(u.text || (u.chip ? "" : it.text), false), u.chip));
      }
      if (it.role === "assistant") {
        const thinkKey = `think:${it.id}`;
        return h("div", { class: "dt-item assistant" }, itemLabel(it, first),
          h("div", { class: "dt-content" },
            it.think
              ? h("div", { class: "pctx" },
                h("button", { class: "pctx-chip think", type: "button", "aria-expanded": ctxOpen.has(thinkKey) ? "true" : "false", dataset: { fk: thinkKey }, onclick: () => {
                  if (ctxOpen.has(thinkKey)) ctxOpen.delete(thinkKey);
                  else ctxOpen.add(thinkKey);
                  renderSoon(true);
                } }, ctxOpen.has(thinkKey) ? i18nNode("U0398") : i18nNode("U0399")),
                ctxOpen.has(thinkKey) ? h("div", { class: "pctx-box" }, it.think) : null)
              : null,
            textBlock(it.text, true),
            (it.calls || []).map((c) => callRow(calls.get(`${it.id}#${c.call}`)))));
      }
      // a tool result whose call is on an older page (or a store without the call)
      return h("div", { class: "dt-item tool" }, itemLabel(it, first),
        h("div", { class: "dt-content" }, callRow({
          key: it.id, name: it.name || i18nText("U0400"), args: "", result: it.text, status: it.status || "ok", ts: it.ts,
          loadFull: it.truncated ? async () => ({ result: (await deck.messageFull(it.id)).text }) : null,
        }), it.child ? h("button", { class: "linkbtn", type: "button", onclick: () => open(it.child) }, i18nNode("U0401")) : null));
    }

    // close on Esc (unless a menu, the photo viewer or an inline field has it) and when a chat is picked in the rail
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !D.sid || e.defaultPrevented) return;
      if (document.querySelector('.ctx[role="menu"], .lightbox') || /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || "")) return;
      close();
    });
    const rail = document.getElementById("rail");
    if (rail) rail.addEventListener("click", (e) => {
      if (D.sid && e.target.closest && e.target.closest(".row")) close();
    });

    // ---------------------------------------------------------------- fixture scenes (development screenshots)
    function setScene(sc) {
      if (!sc || typeof sc !== "object") return;
      if (typeof sc.running === "boolean") runClosed = !sc.running;
      if (typeof sc.ctx === "string") ctxOpen.add(sc.ctx);
      const later = () => {
        if (typeof sc.tools === "string" && toggleTools && !S.open.has(sc.tools)) toggleTools(sc.tools);
        if (typeof sc.toolExpand === "string") {
          const key = sc.toolExpand; // "<sid>#<call>", as Activity tool rows key their calls
          const [sid, call] = key.split("#");
          callOpen.add(key);
          callFull.set(key, { loading: true });
          deck
            .toolCall(sid, call)
            .then(
              (r) => callFull.set(key, { args: r.args, result: r.result }),
              (e) => callFull.set(key, { error: cleanErr(e) })
            )
            .then(() => mark("panel", true));
        }
        if (typeof sc.open === "string") open(sc.open, { expand: typeof sc.expand === "string" ? sc.expand : null });
      };
      setTimeout(later, 600); // after the first snapshot
    }

    return { runningBlock, titleOf, tree, ask, toolRow, detailLink, labels, userMessage, open, close, onRelay, setScene, isOpen: () => !!D.sid };
  }

  const api = { create, retryIndex, branchTotals, goalKey, seqOf, pretty };
  if (typeof window !== "undefined") window.DeckAgents = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
