"use strict";
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
var i18nLocale = typeof module === "object" && module.exports ? require("./i18n").getLocale : window.DeckI18n.getLocale;
// Token pane (window.DeckTokens.create(ctx)): one range control (24h · 7d · 14d · 30d · All) drives every number
// on the pane: four figures, a fresh-vs-cached chart sized to the range, agents, models. Data per range is kept,
// so switching paints at once from the last copy while a background fetch refreshes it.
// Pure helpers are exported for Node tests. Relay strings (agent and model names) enter the DOM as text nodes.
(function (root) {
  const U = () => (typeof module === "object" && module.exports ? require("./usage-view") : root.DeckUsage);
  const RANGES = ["24h", "7d", "14d", "30d", "all"];
  const DAYS = { "7d": 7, "14d": 14, "30d": 30 };
  const WEEKS_UP_TO_S = 182 * 86400; // same switch point as the relay: weeks up to ~6 months of data, months after
  const STALE_MS = 2 * 60e3; // "updated …" appears only when the shown data is older than this
  const REFRESH_MS = 60e3;
  const PREFETCH_MS = 5 * 60e3;
  const EQUIVALENT = "API list-price equivalent";
  const num = n => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);

  // ---------------------------------------------------------------- time helpers (local time, like the relay)
  const localDay = ts => new Date(ts * 1000).toLocaleDateString("sv-SE");
  const dayStart = day => new Date(`${day}T00:00:00`).getTime() / 1000;
  const hourStart = ts => { const d = new Date(ts * 1000); d.setMinutes(0, 0, 0); return d.getTime() / 1000; };
  /** Monday of the week a "YYYY-MM-DD" day falls in. */
  function weekOf(day) {
    const d = new Date(`${day}T12:00:00`);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return localDay(d.getTime() / 1000);
  }
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

  /**
   * One shape for every source: {range, bucket, from, to, since, rows:[{t, agent, model, ...}], partial}.
   * - a new relay answers ?range= with exactly this (partial null)
   * - an old relay only has day rows (array, or {legacy, rows}): 24h becomes "today" (partial "today", shown as such),
   *   day ranges filter days, All re-buckets days into weeks or months
   */
  function normalize(range, body, now = Date.now() / 1000) {
    if (!RANGES.includes(range)) range = "7d";
    if (body && !Array.isArray(body) && Array.isArray(body.rows) && !body.legacy && body.bucket) {
      const since = typeof body.since === "number" ? body.since : null;
      return { range: RANGES.includes(body.range) ? body.range : range, bucket: body.bucket, from: typeof body.from === "number" ? body.from : since,
        to: typeof body.to === "number" ? body.to : now, since, rows: body.rows.filter(r => r && typeof r === "object"), partial: null };
    }
    const dayRows = (Array.isArray(body) ? body : (body && body.rows) || []).filter(r => r && DAY_RE.test(r.day));
    if (range === "all") {
      const first = dayRows.reduce((m, r) => (m === null || r.day < m ? r.day : m), null);
      const since = first ? dayStart(first) : null;
      const bucket = since !== null && now - since > WEEKS_UP_TO_S ? "month" : "week";
      return { range, bucket, from: since, to: now, since, rows: dayRows.map(r => ({ ...r, t: bucket === "week" ? weekOf(r.day) : r.day.slice(0, 7) })), partial: null };
    }
    const days = range === "24h" ? 1 : DAYS[range];
    const keep = new Set();
    for (let i = 0; i < days; i++) keep.add(localDay(now - i * 86400));
    return { range, bucket: "day", from: dayStart(localDay(now - (days - 1) * 86400)), to: now, since: null,
      rows: dayRows.filter(r => keep.has(r.day)).map(r => ({ ...r, t: r.day })), partial: range === "24h" ? "today" : null };
  }

  /** Range totals. fresh = input + cache writes (paid at full price), cached = cache reads; reasoning is inside output. */
  function totals(rows) {
    const t = { tokens: 0, fresh: 0, cached: 0, out: 0, n: 0, sessions: 0, usd: 0, estimated: false, equivalent: false, unknownCost: 0 };
    for (const r of rows || []) {
      t.fresh += num(r.in) + num(r.cw);
      t.cached += num(r.cr);
      t.out += num(r.out);
      t.n += num(r.n);
      t.sessions += num(r.sessions);
      t.usd += num(r.usd);
      t.estimated ||= !!r.estimated;
      t.equivalent ||= r.cost_label === EQUIVALENT;
      t.unknownCost += num(r.unknownCost);
    }
    t.tokens = t.fresh + t.cached + t.out;
    t.usd = Math.round(t.usd * 1e6) / 1e6;
    t.hit = t.fresh + t.cached > 0 ? t.cached / (t.fresh + t.cached) : null;
    return t;
  }

  /** Every bucket of the range in order (zero buckets included), oldest first: hour starts, days, Mondays or months. */
  function axis(data) {
    const to = data.to;
    const out = [];
    if (data.bucket === "hour") {
      const seen = new Set();
      for (let t = hourStart(typeof data.from === "number" ? data.from : to - 86400); t <= to && out.length < 50; t += 3600) {
        const h = hourStart(t);
        if (!seen.has(h)) { seen.add(h); out.push(h); }
      }
    } else if (data.bucket === "day") {
      const end = localDay(to);
      for (let day = localDay(typeof data.from === "number" ? data.from : to); day <= end && out.length < 400; day = localDay(dayStart(day) + 36 * 3600)) out.push(day);
    } else if (data.bucket === "week") {
      const end = weekOf(localDay(to));
      for (let w = weekOf(localDay(typeof data.since === "number" ? data.since : to)); w <= end && out.length < 60; w = weekOf(localDay(dayStart(w) + 7.5 * 86400))) out.push(w);
    } else if (data.bucket === "month") {
      const end = localDay(to).slice(0, 7);
      const first = localDay(typeof data.since === "number" ? data.since : to).slice(0, 7);
      let [y, m] = first.split("-").map(Number);
      for (let key = first; key <= end && out.length < 600;) {
        out.push(key);
        m += 1;
        if (m > 12) { m = 1; y += 1; }
        key = `${y}-${String(m).padStart(2, "0")}`;
      }
    }
    return out;
  }

  /** The chart's columns: every axis bucket with its fresh / cached / output / calls. */
  function series(data) {
    const cols = axis(data).map(t => ({ t, fresh: 0, cached: 0, out: 0, n: 0, usd: 0 }));
    const at = new Map(cols.map(c => [String(c.t), c]));
    for (const r of data.rows || []) {
      const c = at.get(String(r.t));
      if (!c) continue;
      c.fresh += num(r.in) + num(r.cw);
      c.cached += num(r.cr);
      c.out += num(r.out);
      c.n += num(r.n);
      c.usd += num(r.usd);
    }
    return cols;
  }

  /** Per-agent totals for the range, sorted by tokens (or cost). */
  function byAgent(rows, sort = "tokens") {
    const by = new Map();
    for (const r of rows || []) {
      const name = String(r.agent || "?");
      if (!by.has(name)) by.set(name, []);
      by.get(name).push(r);
    }
    const list = [...by].map(([agent, rs]) => ({ agent, ...totals(rs) })).filter(a => a.tokens || a.n || a.usd);
    return list.sort((a, b) => (sort === "cost" ? b.usd - a.usd || b.tokens - a.tokens : b.tokens - a.tokens || b.usd - a.usd) || a.agent.localeCompare(b.agent));
  }

  /** Cost figure: "$12.40" plus an "≈" marker whose tooltip says why (estimate, subscription list price, unknown parts). */
  function costParts(t) {
    const why = U().costWhy(t);
    const value = t.unknownCost && !t.usd ? "–" : `$${num(t.usd).toFixed(2)}`;
    return { value, approx: !!why && value !== "–", why };
  }

  // ---------------------------------------------------------------- labels
  const fmt = (opts, d) => d.toLocaleString(i18nLocale(), opts);
  const asDate = (bucket, t) => (bucket === "hour" ? new Date(t * 1000) : new Date(`${bucket === "month" ? `${t}-01` : t}T12:00:00`));

  /** Short axis tick for one bucket. */
  function tickLabel(data, t) {
    const d = asDate(data.bucket, t);
    if (data.bucket === "hour") return fmt({ hour: "2-digit" }, d);
    if (data.bucket === "day") return data.range === "7d" || data.partial ? fmt({ weekday: "short" }, d) : fmt({ day: "numeric" }, d);
    if (data.bucket === "week") return fmt({ day: "numeric", month: "short" }, d);
    const multiYear = typeof data.since === "number" && localDay(data.since).slice(0, 4) !== localDay(data.to).slice(0, 4);
    return fmt(multiYear ? { month: "short", year: "2-digit" } : { month: "short" }, d);
  }

  /** Full name of one bucket, for the hover readout. */
  function whenLabel(data, t) {
    const d = asDate(data.bucket, t);
    if (data.bucket === "hour") {
      const end = new Date((t + 3600) * 1000);
      return `${fmt({ weekday: "short", hour: "2-digit", minute: "2-digit" }, d)}–${fmt({ hour: "2-digit", minute: "2-digit" }, end)}`;
    }
    if (data.bucket === "day") return fmt({ weekday: "short", day: "numeric", month: "short" }, d);
    if (data.bucket === "week") return i18nText("tok.weekOf", { d: fmt({ day: "numeric", month: "short", year: "numeric" }, d) });
    return fmt({ month: "long", year: "numeric" }, d);
  }

  /** Which ticks to print: at most ~7, always the newest. */
  function tickEvery(n) { return Math.max(1, Math.ceil(n / 7)); }

  // ---------------------------------------------------------------- rendering
  function create(ctx) {
    const { h, k, deck, store, mark } = ctx;
    const cache = new Map(); // range -> { data, at (ms) }
    const inflight = new Set();
    const saved = store && store.get("deck.tokRange");
    let range = RANGES.includes(saved) ? saved : "7d";
    let sort = store && store.get("deck.tokSort") === "cost" ? "cost" : "tokens";
    let timer = null;
    let hover = null; // {range, t, text} of the chart column under the pointer
    const manual = { busy: false, error: false };

    async function load(r, strict = false) {
      if (inflight.has(r)) return;
      inflight.add(r);
      try {
        const body = await deck.tokens(r);
        cache.set(r, { data: normalize(r, body), at: Date.now() });
      } catch (e) {
        // Keep the last copy; a click-driven refresh also reports the failed read.
        if (strict) throw e;
      } finally {
        inflight.delete(r);
        // after the in-flight mark is gone, so the redraw re-enables Refresh at once
        if (r === range && ctx.isOpen()) mark("panel");
      }
    }

    /** The selected range now, then quietly the others, so every switch can paint at once. */
    async function refresh() {
      clearTimeout(timer);
      await load(range);
      for (const r of RANGES) {
        const c = cache.get(r);
        if (r !== range && (!c || Date.now() - c.at > PREFETCH_MS)) await load(r);
      }
      clearTimeout(timer);
      if (ctx.isOpen()) timer = setTimeout(() => { if (ctx.isOpen()) refresh(); }, REFRESH_MS);
    }

    function select(r) {
      if (!RANGES.includes(r) || r === range) return;
      range = r;
      if (store) store.set("deck.tokRange", r);
      mark("panel", true);
      const c = cache.get(r);
      if (!c || Date.now() - c.at > REFRESH_MS) load(r);
    }

    function current() {
      const c = cache.get(range);
      if (c) return c;
      const snap = ctx.snapshotRows ? ctx.snapshotRows() : null;
      if (range === "7d" && Array.isArray(snap) && snap.length) return { data: normalize("7d", snap), at: null };
      return null;
    }

    function rangeControl() {
      return h("div", { class: "tok-range", role: "radiogroup", "aria-label": i18nText("tok.rangeAria") },
        RANGES.map(r => h("button", {
          type: "button", role: "radio", "aria-checked": r === range ? "true" : "false", class: r === range ? "on" : null,
          tabindex: r === range ? "0" : "-1", title: i18nText(`tok.rangeTip.${r}`), dataset: { fk: `tokrange:${r}` },
          onclick: () => select(r),
          onkeydown: e => {
            const i = RANGES.indexOf(r);
            const next = e.key === "ArrowRight" ? RANGES[(i + 1) % RANGES.length] : e.key === "ArrowLeft" ? RANGES[(i - 1 + RANGES.length) % RANGES.length] : null;
            if (!next) return;
            e.preventDefault();
            select(next);
            // after the redraw (which restores focus to the old key), move focus to the new choice
            requestAnimationFrame(() => { const el = document.querySelector(`[data-fk="tokrange:${next}"]`); if (el) el.focus({ preventScroll: true }); });
          },
        }, i18nText(`tok.range.${r}`))));
    }

    function meta(entry, now) {
      const bits = [];
      const d = entry && entry.data;
      if (d && d.partial === "today") bits.push(h("span", { class: "tok-meta-warn", title: i18nText("tok.todayOnlyTip") }, i18nText("tok.todayOnly")));
      if (d && d.range === "all" && typeof d.since === "number") bits.push(h("span", null, i18nText("tok.since", { d: new Date(d.since * 1000).toLocaleDateString(i18nLocale(), { day: "numeric", month: "short", year: "numeric" }) })));
      if (entry && entry.at && now - entry.at > STALE_MS) bits.push(h("span", null, i18nText("usage.updatedAgo", { v: U().agoText(entry.at / 1000, now) })));
      return h("div", { class: "tok-meta" }, bits);
    }

    function figure(label, value, opts = {}) {
      return h("div", { class: "tok-fig", title: opts.title || null },
        h("span", { class: "tok-fig-v" }, value, opts.approx ? h("span", { class: "tok-approx", "aria-label": opts.why || null }, "≈") : null),
        h("span", { class: "tok-fig-k" }, label));
    }

    function figures(t) {
      const dash = "–";
      if (!t) return h("div", { class: "tok-figs" }, ["tok.fig.tokens", "tok.fig.cost", "tok.fig.calls", "tok.fig.cache"].map(key => figure(i18nText(key), dash)));
      const cost = costParts(t);
      return h("div", { class: "tok-figs" },
        figure(i18nText("tok.fig.tokens"), k(t.tokens), { title: i18nText("tok.tokensTip", { fresh: k(t.fresh), cached: k(t.cached), out: k(t.out) }) }),
        figure(i18nText("tok.fig.cost"), cost.value, { approx: cost.approx, why: cost.why, title: cost.why }),
        figure(i18nText("tok.fig.calls"), t.n >= 1e4 ? k(t.n) : t.n.toLocaleString(i18nLocale()), { title: t.sessions ? U().plural("tok.sessions", t.sessions) : null }),
        figure(i18nText("tok.fig.cache"), t.hit === null ? dash : U().pct(Math.round(t.hit * 100))));
    }

    function chart(data) {
      const cols = data ? series(data) : [];
      const max = cols.reduce((m, c) => Math.max(m, c.fresh + c.cached), 0);
      // the pane redraws on every relay event batch: the hovered bucket survives it (cleared when the pointer leaves)
      const held = hover && data && hover.range === data.range ? cols.find(c => String(c.t) === hover.t) : null;
      const readout = h("span", { class: "tok-readout-v" }, held ? hover.text : null);
      const show = (t, text) => () => { hover = { range: data.range, t: String(t), text }; readout.textContent = text; };
      const clear = () => { hover = null; readout.textContent = ""; };
      const every = tickEvery(cols.length);
      const n = Math.max(cols.length, 1);
      const bars = cols.map((c, i) => {
        const total = c.fresh + c.cached;
        const detail = i18nText("tok.bar", { when: whenLabel(data, c.t), total: k(total + c.out), fresh: k(c.fresh), cached: k(c.cached), n: c.n });
        const pctOf = v => (max ? `${Math.max(v ? 1.5 : 0, (100 * v) / max)}%` : "0%");
        return h("span", { class: `tok-col${i === cols.length - 1 ? " now" : ""}`, role: "img", "aria-label": detail, onmouseenter: show(c.t, detail) },
          h("i", { class: "c", style: { height: pctOf(c.cached) } }),
          h("i", { class: "f", style: { height: pctOf(c.fresh) } }));
      });
      const ticks = cols.map((c, i) => h("span", null, (cols.length - 1 - i) % every === 0 ? tickLabel(data, c.t) : ""));
      return h("section", { class: `tok-chart${data ? "" : " is-pending"}`, "aria-label": i18nText("tok.chartAria") },
        h("div", { class: "tok-readout" },
          h("span", { class: "tok-key f" }, i18nText("tok.fresh")),
          h("span", { class: "tok-key c" }, i18nText("tok.cached")),
          readout),
        h("div", { class: "tok-bars", style: { "--n": String(n) }, onmouseleave: clear }, bars),
        h("div", { class: "tok-axis", style: { "--n": String(n) }, "aria-hidden": "true" }, ticks));
    }

    function agents(rows) {
      const list = byAgent(rows, sort);
      if (!list.length) return [];
      const top = list.reduce((m, a) => Math.max(m, sort === "cost" ? a.usd : a.tokens), 0);
      const head = key => h("button", {
        type: "button", class: `tok-sort${sort === key ? " on" : ""}`, "aria-pressed": sort === key ? "true" : "false", dataset: { fk: `toksort:${key}` },
        onclick: () => { sort = key; if (store) store.set("deck.tokSort", key); mark("panel", true); },
      }, i18nText(key === "cost" ? "tok.fig.cost" : "tok.fig.tokens"));
      return [
        h("div", { class: "tok-list-head" }, h("h2", { class: "section-h" }, i18nText("tok.agents")), h("span", { class: "tok-sorts" }, head("tokens"), head("cost"))),
        h("div", { class: "tok-agents", role: "list" }, list.map(a => {
          const share = top ? (100 * (sort === "cost" ? a.usd : a.tokens)) / top : 0;
          const cost = costParts(a);
          return h("div", { class: "tok-agent", role: "listitem",
            title: i18nText("tok.agentTip", { calls: U().plural("usage.calls", a.n), hit: a.hit === null ? "–" : U().pct(Math.round(a.hit * 100)), out: k(a.out) }) },
          h("span", { class: "tok-agent-name" }, a.agent),
          h("span", { class: "tok-share", "aria-hidden": "true" }, h("i", { style: { width: `${Math.max(share ? 2 : 0, share)}%` } })),
          h("span", { class: "tok-agent-v" }, k(a.tokens)),
          h("span", { class: "tok-agent-c", title: cost.why }, cost.approx ? `≈${cost.value}` : cost.value));
        })),
      ];
    }

    function warnings(now) {
      const out = [];
      for (const s of (ctx.sessions && ctx.sessions()) || []) {
        if (s.parent || now / 1000 - s.lastTs > 86400) continue;
        const who = `${s.agent} · ${ctx.where ? ctx.where(s) : ""}`;
        if (s.ctxLen && s.ctxUsed / s.ctxLen >= 0.7) {
          out.push(h("div", { class: "tok-warn", title: i18nText("U0531") }, h("b", null, who), i18nText("U0530", { v: Math.round((100 * s.ctxUsed) / s.ctxLen), ctxUsed: k(s.ctxUsed), ctxLen: k(s.ctxLen) })));
        }
        const lc = s.lastCall;
        if (lc) {
          const prompt = num(lc.in) + num(lc.cr) + num(lc.cw);
          if (prompt > 40000 && num(lc.cr) / prompt < 0.2) out.push(h("div", { class: "tok-warn", title: i18nText("U0533") }, h("b", null, who), i18nText("U0532", { prompt: k(prompt) })));
        }
      }
      return out.length ? [h("h2", { class: "section-h" }, i18nText("U0529")), ...out] : [];
    }

    /** The whole pane. */
    function pane(kids, now = Date.now()) {
      const entry = current();
      const data = entry ? entry.data : null;
      const t = data ? totals(data.rows) : null;
      kids.push(h("div", { class: "tok-top" }, rangeControl(), meta(entry, now),
        h("button", { type: "button", class: "tok-refresh quota-refresh", dataset: { fk: "token-refresh" }, disabled: manual.busy || inflight.has(range),
          "aria-busy": manual.busy ? "true" : "false", onclick: async () => {
            if (manual.busy || inflight.has(range)) return;
            manual.busy = true; manual.error = false; mark("panel", true);
            try { await load(range, true); } catch { manual.error = true; }
            finally { manual.busy = false; mark("panel", true); }
          } }, i18nText(manual.busy ? "usage.refreshing" : "triage.refresh"))));
      if (manual.error) kids.push(h("p", { class: "tok-meta-warn", role: "status" }, i18nText("triage.usageRefreshFailed")));
      if (ctx.usageStatus) kids.push(...U().failureStatuses(h, ctx.usageStatus(), now));
      kids.push(figures(t));
      kids.push(chart(data));
      if (data && !data.rows.length) kids.push(h("p", { class: "tok-empty" }, i18nText("tok.empty")));
      if (data && data.rows.length) {
        kids.push(...agents(data.rows));
        kids.push(h("h2", { class: "section-h" }, i18nText("tok.models")));
        kids.push(U().modelTable(h, data.rows, k));
      }
      kids.push(...warnings(now));
    }

    return { pane, refresh, select, get range() { return range; } };
  }

  const api = { create, RANGES, normalize, totals, axis, series, byAgent, costParts, tickLabel, whenLabel, tickEvery, weekOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DeckTokens = Object.freeze(api);
})(typeof window !== "undefined" ? window : globalThis);
