"use strict";
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
var i18nLocale = typeof module === "object" && module.exports ? require("./i18n").getLocale : window.DeckI18n.getLocale;
// Activity panel: ONE tree of sessions and their sub-agents (window.DeckActivity.create(ctx)).
//   - every agent is rendered once, as one compact row: status (single vocabulary), short title, model +
//     reasoning level, elapsed time, cost so far; a drawer holds the metrics (context, cache hit, speed, tokens)
//   - controls live in one overflow menu per row (Steer / Stop / Model / tools / details), never a button wall
//   - totals say what they include ("lead + N sub-agents" vs "sub-agents only")
//   - colour roles: patina = live, gilt = needs attention / threshold, amphora = failed, neutral = data
// Pure helpers are exported for Node tests; app.js owns state and passes in what the view needs.
// Every string from the relay enters the DOM as a text node.
(function (root) {
  const num = n => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);
  const pct = v => (typeof module === "object" && module.exports ? require("./usage-view") : root.DeckUsage).pct(v);
  const plural = (base, n, vars = {}) => i18nText(`${base}.${new Intl.PluralRules(i18nLocale()).select(n) === "one" ? "one" : "other"}`, { n, ...vars });
  const CTX_WARN = 70; // context window fullness: gilt at 70%, amphora at 90%
  const CTX_BAD = 90;

  // ---------------------------------------------------------------- pure helpers
  /** "claude-sonnet-5-5-20260101" -> "sonnet-5-5"; "vendor/model-x" -> "model-x". */
  function shortModel(model) {
    const m = String(model || "").split("/").pop().replace(/-\d{8}$/, "").replace(/^claude-/, "");
    return m;
  }

  /** The reasoning level label of a session: the live agent's (bridge node), else the delegated route's. */
  function effortOf(s, node) {
    const v = (node && node.effort) || (s && s.route && s.route.effort) || "";
    return /^[a-z][a-z0-9_.-]{0,23}$/.test(v) ? v : "";
  }

  /** Titles of siblings without the words they all share at the start and at the end (full text stays in the tooltip). */
  function stripCommonPrefix(titles) {
    const list = titles.map(t => String(t || ""));
    if (list.length < 2 || list.some(t => !t)) return list;
    const common = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };
    let pre = list[0].length;
    for (const t of list) pre = Math.min(pre, common(list[0], t));
    const head = list[0].slice(0, pre);
    const cut = Math.max(head.lastIndexOf(" "), head.lastIndexOf("/"), head.lastIndexOf(":")) + 1;
    let out = cut >= 12 ? list.map(t => t.slice(cut)) : list;
    const rev = out.map(t => [...t].reverse().join(""));
    let suf = rev[0].length;
    for (const t of rev) suf = Math.min(suf, common(rev[0], t));
    const tail = rev[0].slice(0, suf);
    const back = Math.max(tail.lastIndexOf(" "), tail.lastIndexOf("/")) ; // keep whole words only
    const drop = back >= 12 ? back + 1 : 0;
    if (drop) out = out.map(t => t.slice(0, t.length - drop).trimEnd());
    return out.some(t => t.length < 3) ? list : out.map(t => t.replace(/[\s,;:–-]+$/, ""));
  }

  /** Share of prompt tokens served from the cache: cached / (cached + fresh input). Null without prompt tokens. */
  function cacheRate(t) {
    const fresh = num(t && t.in) + num(t && t.cw);
    const cached = num(t && t.cr);
    return fresh + cached > 0 ? Math.round((100 * cached) / (fresh + cached)) : null;
  }

  /** Output tokens per second of generation; only from calls the plugin timed (genOut/genSecs), never estimated. */
  function tokensPerSec(s) {
    const secs = num(s && s.genSecs);
    const out = num(s && s.genOut);
    if (secs < 1 || !out) return null;
    const v = out / secs;
    return v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
  }

  /** How full the context window is, 0..100, or null when unknown. */
  function ctxPercent(s, node) {
    let p = null;
    if (s && s.ctxLen > 0 && s.ctxUsed > 0) p = (100 * s.ctxUsed) / s.ctxLen;
    else if (node && node.ctxPercent > 0) p = node.ctxPercent;
    else if (node && node.ctxMax > 0 && node.ctxUsed > 0) p = (100 * node.ctxUsed) / node.ctxMax;
    return p === null ? null : Math.min(100, Math.max(0, Math.round(p)));
  }

  /**
   * ONE status vocabulary for every place an agent appears. kind: thinking | tool | waiting | idle | failed | done
   * | stopped | quiet. The relay session is the source of truth; the bridge node only adds "waiting" (a question or
   * an approval is open) while the turn is live.
   */
  function statusOf(s, node) {
    if (s.stale) return { kind: "quiet" };
    if (s.state === "failed") return { kind: "failed" };
    if (s.state === "stopped") return { kind: "stopped" };
    if (s.state === "done") return { kind: "done" };
    if (s.state !== "running") return { kind: "idle" };
    if (node && node.terminalAt === null && (node.state === "question" || node.state === "approval")) return { kind: "waiting" };
    return s.curTool ? { kind: "tool", tool: s.curTool.tool } : { kind: "thinking" };
  }
  const isLiveKind = kind => kind === "thinking" || kind === "tool" || kind === "waiting";

  /** Lead alone, the whole tree, and the sub-agents only (tree minus lead): fresh/cached/output tokens and cost. */
  function treeTotals(s, kidsOf) {
    const zero = () => ({ fresh: 0, cr: 0, out: 0, cost: 0, hasCost: false });
    const add = (t, x) => {
      const k = x.tokens || {};
      t.fresh += num(k.in) + num(k.cw);
      t.cr += num(k.cr);
      t.out += num(k.out);
      if (num(x.cost) > 0) { t.cost += x.cost; t.hasCost = true; }
    };
    const lead = zero();
    add(lead, s);
    const subs = zero();
    let n = 0;
    let running = 0;
    let failed = 0;
    const seen = new Set([s.sid]);
    const walk = x => {
      for (const c of kidsOf(x)) {
        if (!c || seen.has(c.sid)) continue;
        seen.add(c.sid);
        add(subs, c);
        n += 1;
        if (c.state === "running" && !c.stale) running += 1;
        if (c.state === "failed") failed += 1;
        walk(c);
      }
    };
    walk(s);
    const all = { fresh: lead.fresh + subs.fresh, cr: lead.cr + subs.cr, out: lead.out + subs.out, cost: lead.cost + subs.cost, hasCost: lead.hasCost || subs.hasCost };
    return { lead, subs, all, n, running, failed };
  }

  /** "$1.20", or "≈$1.20" when the figure is an API list-price equivalent / estimate rather than a bill. */
  function costText(usd, approx) {
    return `${approx ? "≈" : ""}$${num(usd).toFixed(2)}`;
  }
  const isEquivalent = s => s.cost_label === "API list-price equivalent" || s.cost_estimated === true;

  // ---------------------------------------------------------------- rendering
  function create(ctx) {
    const { h, k, dur, ticker, kidsOf, nodeOf, actions, controlBox, toolList, toggleTools, openDetail, askEl, titleOf, retryIndex, mark, store, isOpenTools, sessions } = ctx;
    const expanded = new Set(); // rows whose metrics drawer is open
    const folded = new Map(); // sid -> true/false: the user's choice for a sub-agent group (absent: automatic)
    let menu = null; // sid whose overflow menu is open
    let runClosed = store && store.get("deck.runningClosed") === "1";
    const redraw = () => mark("panel", true);
    const focusFk = fk => requestAnimationFrame(() => { const el = document.querySelector(`[data-fk="${CSS.escape(fk)}"]`); if (el) el.focus({ preventScroll: true }); });
    document.addEventListener("click", e => {
      if (menu && !(e.target.closest && e.target.closest(".amenu-wrap"))) { menu = null; redraw(); }
    });

    const STATUS_KEY = { thinking: "activity.st.thinking", waiting: "activity.st.waiting", idle: "activity.st.idle", failed: "activity.st.failed", done: "activity.st.done", stopped: "activity.st.stopped", quiet: "activity.st.quiet" };

    function statusEl(s, st) {
      if (st.kind === "tool" && s.curTool) return ticker(s.curTool.since, `${i18nText("activity.st.tool", { tool: st.tool })} · `);
      return i18nText(STATUS_KEY[st.kind] || STATUS_KEY.idle);
    }

    function elapsed(s, st) {
      const start = s.parent ? s.firstTs : s.turnTs || s.firstTs;
      if (isLiveKind(st.kind)) return start ? ticker(start) : "";
      if (s.ms) return dur(s.ms);
      return s.firstTs && s.lastTs > s.firstTs ? dur((s.lastTs - s.firstTs) * 1000) : "";
    }

    function metric(label, value, tip, extra = {}) {
      return h("div", { class: `ametric${extra.tone ? ` ${extra.tone}` : ""}`, title: tip },
        h("span", { class: "ametric-k" }, label),
        h("span", { class: "ametric-v" }, value),
        extra.meter !== undefined ? h("span", { class: "ameter", role: "meter", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": extra.meter, "aria-label": label }, h("i", { style: { width: `${extra.meter}%` } })) : null);
  }

    function metrics(s, node) {
      const t = s.tokens || {};
      const out = [];
      const p = ctxPercent(s, node);
      if (p !== null) out.push(metric(i18nText("activity.m.context"), pct(p), i18nText("activity.tipContext"), { meter: p, tone: p >= CTX_BAD ? "bad" : p >= CTX_WARN ? "warn" : "" }));
      const rate = cacheRate(t);
      if (rate !== null) out.push(metric(i18nText("activity.m.cache"), pct(rate), i18nText("activity.tipCache"), { meter: rate }));
      const tps = tokensPerSec(s);
      if (tps !== null) out.push(metric(i18nText("activity.m.speed"), i18nText("activity.tps", { v: tps.toLocaleString(i18nLocale()) }), i18nText("activity.tipSpeed")));
      out.push(metric(i18nText("activity.m.fresh"), k(num(t.in) + num(t.cw)), i18nText("activity.tipFresh")));
      if (num(t.cr)) out.push(metric(i18nText("activity.m.cached"), k(t.cr), i18nText("activity.tipCached")));
      out.push(metric(i18nText("activity.m.output"), k(t.out), i18nText("activity.tipOutput")));
      out.push(metric(i18nText("activity.m.tools"), String(num(s.ntools)), i18nText("activity.tipTools")));
      if (!s.parent && s.turns) out.push(metric(i18nText("activity.m.turns"), String(s.turns), i18nText("activity.tipTurns")));
      return h("div", { class: "ametrics" }, out);
    }

    function menuEl(s, node) {
      const items = [...(actions(s.sid) || [])];
      if (num(s.ntools)) items.push({ id: "tools", label: isOpenTools(s.sid) ? i18nText("U0506") : i18nText("U0507", { ntools: s.ntools }), run: () => toggleTools(s.sid) });
      items.push({ id: "details", label: i18nText("U0373"), run: () => openDetail(s.sid) });
      const fk = id => `amenu:${s.sid}:${id}`;
      const close = () => { menu = null; redraw(); focusFk(`amore:${s.sid}`); };
      return h("div", {
        class: "amenu", role: "menu", "aria-label": i18nText("activity.more"),
        onkeydown: e => {
          const live = [...e.currentTarget.querySelectorAll("button:not(:disabled)")];
          const at = live.indexOf(document.activeElement);
          if (e.key === "Escape") { e.preventDefault(); close(); }
          else if (e.key === "ArrowDown") { e.preventDefault(); live[(at + 1) % live.length].focus(); }
          else if (e.key === "ArrowUp") { e.preventDefault(); live[(at - 1 + live.length) % live.length].focus(); }
          else if (e.key === "Tab") { menu = null; redraw(); }
        },
      }, items.map(it => h("button", {
        class: `amenu-item${it.danger ? " danger" : ""}${it.on ? " on" : ""}`, type: "button", role: "menuitem", disabled: it.disabled || null,
        title: it.title || null, dataset: { fk: fk(it.id) },
        onclick: () => { if (!it.keepOpen) menu = null; it.run(); redraw(); },
      }, it.label)));
    }

    function overflow(s, node) {
      const open = menu === s.sid;
      const btn = h("button", {
        class: `amore${open ? " on" : ""}`, type: "button", "aria-haspopup": "menu", "aria-expanded": open ? "true" : "false",
        "aria-label": i18nText("activity.more"), title: i18nText("activity.more"), dataset: { fk: `amore:${s.sid}` },
        onclick: e => {
          e.stopPropagation();
          menu = open ? null : s.sid;
          redraw();
          if (menu) requestAnimationFrame(() => { const first = document.querySelector(".amenu .amenu-item:not(:disabled)"); if (first) first.focus({ preventScroll: true }); });
        },
      }, h("span", { class: "amore-ic", "aria-hidden": "true" }));
      return h("div", { class: "amenu-wrap" }, btn, open ? menuEl(s, node) : null);
    }

    /** One agent: a compact row plus its drawer; nested sub-agents come from group(). */
    function row(s, depth, title, retry) {
      const node = nodeOf(s.sid);
      const st = statusOf(s, node);
      const open = expanded.has(s.sid);
      const effort = effortOf(s, node);
      const model = shortModel(s.model || (node && node.model));
      const cost = s.cost ? h("span", { class: "acost", title: isEquivalent(s) ? i18nText("usage.apiEquivalent") : i18nText("activity.tipCost") }, costText(s.cost, isEquivalent(s))) : null;
      const chips = [];
      if (retry && retry.of) chips.push(h("span", { class: "achip", title: i18nText("activity.retryTip") }, i18nText("activity.retry")));
      if (retry && retry.by && st.kind === "failed") chips.push(h("span", { class: "achip", title: i18nText("activity.retriedTip") }, i18nText("activity.retried")));
      const toggle = h("button", {
        class: "arow-main", type: "button", "aria-expanded": open ? "true" : "false", title: title.full,
        dataset: { fk: `arow:${s.sid}` }, onclick: () => { open ? expanded.delete(s.sid) : expanded.add(s.sid); redraw(); },
      },
        h("span", { class: "adot", "aria-hidden": "true" }),
        h("span", { class: "atitle" }, title.short),
        h("span", { class: "atime", title: i18nText(s.parent ? "U0378" : "U0377") }, elapsed(s, st)),
        h("span", { class: "astatus" }, statusEl(s, st)),
        cost,
        h("span", { class: "asub" },
          model ? h("span", { class: "amodel", title: s.model || (node && node.model) || null }, model) : null,
          effort ? h("span", { class: "achip effort", title: i18nText("activity.effortTip", { v: effort }) }, effort) : null,
          chips));
      const box = controlBox(s.sid);
      const drawer = open ? h("div", { class: "adrawer" }, s.parent ? null : (s.lastMsg ? askEl(s) : null), metrics(s, node)) : null;
      return h("div", { class: `arow st-${st.kind}${open ? " open" : ""}${depth ? " sub" : ""}`, style: depth ? { "--depth": String(depth) } : null, dataset: { sid: s.sid } },
        h("div", { class: "arow-head" }, toggle, overflow(s, node)), box, drawer, isOpenTools(s.sid) ? toolList(s.sid) : null);
    }

    function totalsBlock(s, tt) {
      const part = t => [i18nText("time.fresh", { v: k(t.fresh) }), t.cr ? i18nText("U0350", { cr: k(t.cr) }) : null, i18nText("U0351", { out: k(t.out) }), t.hasCost ? costText(t.cost, isEquivalent(s)) : null].filter(Boolean);
      const line = (label, t, tip) => h("div", { class: "atot", title: tip },
        h("span", { class: "atot-k" }, label),
        h("span", { class: "atot-v" }, part(t).map(x => h("span", null, x))));
      return h("div", { class: "atotals" },
        line(plural("activity.totalAll", tt.n), tt.all, i18nText("activity.tipTotalAll")),
        line(i18nText("activity.totalSubs"), tt.subs, i18nText("activity.tipTotalSubs")));
    }

    /** A session's sub-agents, nested; a header with the running count folds them. */
    function group(s, depth) {
      const kids = kidsOf(s);
      if (!kids.length) return null;
      const tt = treeTotals(s, kidsOf);
      const auto = tt.running > 0 || tt.failed > 0 || tt.n <= 3;
      const open = folded.has(s.sid) ? !folded.get(s.sid) : auto;
      const retries = retryIndex();
      const titles = stripCommonPrefix(kids.map(c => titleOf(c)));
      const sumBits = [h("b", null, plural("activity.subs", tt.n)),
        tt.running ? h("span", { class: "sum-run" }, i18nText("activity.subsRunning", { n: tt.running })) : null,
        tt.failed ? h("span", { class: "sum-bad" }, i18nText("activity.subsFailed", { n: tt.failed })) : null].filter(Boolean);
      const head = h("button", {
        class: `agroup-head${tt.running ? " live" : ""}`, type: "button", "aria-expanded": open ? "true" : "false", dataset: { fk: `agroup:${s.sid}` },
        onclick: () => { folded.set(s.sid, open); redraw(); },
      }, h("span", { class: "chev", "aria-hidden": "true" }, open ? "▾" : "▸"), h("span", { class: "agroup-sum" }, sumBits));
      return h("div", { class: "agroup" }, head, totalsBlock(s, tt),
        open ? h("div", { class: "akids" }, kids.map((c, i) => node(c, depth + 1, { short: titles[i], full: titleOf(c) }, retries.get(c.sid)))) : null);
    }

    function node(s, depth, title, retry) {
      return h("div", { class: "anode" }, row(s, depth, title, retry), group(s, depth));
    }

    /** A top-level session (or an orphaned sub-agent) with everything under it. */
    function card(s, opts = {}) {
      const title = { short: titleOf(s), full: titleOf(s) };
      const tt = kidsOf(s).length ? treeTotals(s, kidsOf) : null;
      const live = isLiveKind(statusOf(s, nodeOf(s.sid)).kind) || (tt && tt.running > 0);
      return h("article", { class: `acard${live ? " live" : ""}${opts.mine ? " mine" : ""}` }, node(s, 0, title, null));
    }

    function descendants(s, out = new Set()) {
      out.add(s.sid);
      for (const c of kidsOf(s)) if (c && !out.has(c.sid)) descendants(c, out);
      return out;
    }

    /** Running sessions that the open chat's list does not show: one disclosure, same cards, nothing twice. */
    function elsewhere(shown) {
      const all = [...sessions().values()];
      const live = all.filter(x => x.state === "running" && !x.stale && !shown.has(x.sid));
      const liveIds = new Set(live.map(x => x.sid));
      const roots = live.filter(x => !x.parent || !liveIds.has(x.parent) || shown.has(x.parent));
      const cards = [];
      const used = new Set();
      for (const r of roots.sort((a, b) => (b.turnTs || b.firstTs || 0) - (a.turnTs || a.firstTs || 0))) {
        if (used.has(r.sid)) continue;
        descendants(r, used);
        cards.push(card(r));
      }
      if (!cards.length) return null;
      const head = h("button", { class: "runnow-head", type: "button", "aria-expanded": runClosed ? "false" : "true", dataset: { fk: "running" }, onclick: () => {
        runClosed = !runClosed;
        if (store) store.set("deck.runningClosed", runClosed ? "1" : "0");
        redraw();
      } }, h("span", null, h("span", { class: "chev", "aria-hidden": "true" }, runClosed ? "▸" : "▾"), i18nText("activity.elsewhere")), h("span", { class: "live" }, String(cards.length)));
      return h("section", { class: "runnow busy", "aria-label": i18nText("activity.elsewhere") }, head, runClosed ? null : h("div", { class: "run-list" }, cards));
    }

    return { card, elsewhere, descendants };
  }

  const api = { create, shortModel, effortOf, stripCommonPrefix, cacheRate, tokensPerSec, ctxPercent, statusOf, treeTotals, costText, isLiveKind };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DeckActivity = Object.freeze(api);
})(typeof window !== "undefined" ? window : globalThis);
