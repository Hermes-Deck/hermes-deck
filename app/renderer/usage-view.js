"use strict";
var i18nNode = (key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).node(key, vars, typeof document === "object" ? document : null);
var i18nBind = (el, attr, key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).bind(el, attr, key, vars);
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
var i18nLocale = typeof module === "object" && module.exports ? require("./i18n").getLocale : window.DeckI18n.getLocale;
// Isolated usage rendering: values are plain text, never provider HTML or raw account payloads.
(function (root) {
  const num = n => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
  const volume = r => num(r.in) + num(r.cr) + num(r.cw) + num(r.out); // reasoning is already in output
  const WARN_AT = 60; // Brass marks quota windows above 60%; red is reserved for failed data.

  /** Percent in the UI language's own order: "58%" in English, "%58" in Turkish. */
  const formats = new Map();
  function pct(value) {
    const locale = i18nLocale();
    if (!formats.has(locale)) formats.set(locale, new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }));
    return formats.get(locale).format(Math.round(num(value)) / 100);
  }

  /** "<base>.one" / "<base>.other" by the UI language's plural rule ("1 call", "2 calls"). */
  function plural(base, n, vars = {}) {
    const category = new Intl.PluralRules(i18nLocale()).select(n);
    return i18nText(`${base}.${category === "one" ? "one" : "other"}`, { n, ...vars });
  }

  /** Short relative past: "now", "3 min ago", "2 h ago", "4 days ago". */
  function agoText(ts, now = Date.now()) {
    const d = now / 1000 - ts;
    if (d < 45) return i18nText("U0402");
    if (d < 3600) return i18nText("U0403", { v: Math.round(d / 60) });
    if (d < 86400) return i18nText("U0404", { v: Math.round(d / 3600) });
    return i18nText("U0405", { v: Math.round(d / 86400) });
  }

  /** Time until a reset: "12m", "6h 12m", "3d 4h". */
  function untilText(ms) {
    const minutes = Math.max(1, Math.round(ms / 60000));
    if (minutes < 60) return i18nText("usage.dur.m", { m: minutes });
    if (minutes < 1440) return i18nText("usage.dur.hm", { h: Math.floor(minutes / 60), m: minutes % 60 });
    return i18nText("usage.dur.dh", { d: Math.floor(minutes / 1440), h: Math.floor((minutes % 1440) / 60) });
  }

  /** "5h", "7d": the window length in the shortest honest unit. */
  function windowLabel(minutes) {
    if (!(minutes > 0)) return "–";
    if (minutes >= 2880) return i18nText("usage.win.d", { n: Math.round(minutes / 1440) });
    if (minutes >= 60) return i18nText("usage.win.h", { n: Math.round(minutes / 60) });
    return i18nText("usage.win.m", { n: Math.round(minutes) });
  }

  function totals(rows) {
    return rows.reduce((t, r) => {
      t.tokens += volume(r); t.usd += num(r.usd); t.n += num(r.n);
      t.estimated ||= !!r.estimated; t.equivalent ||= r.cost_label === "API list-price equivalent";
      t.unknownCost += num(r.unknownCost);
      return t;
    }, { tokens: 0, usd: 0, n: 0, estimated: false, equivalent: false, unknownCost: 0 });
  }
  function costText(r) {
    if (r.unknownCost && !r.usd) return "–";
    return `${r.estimated ? "≈" : ""}$${num(r.usd).toFixed(2)}`;
  }

  /** An inline status: drawn icon (CSS mask), one sentence, optional "last updated" meta. tone: warn | bad | info. */
  function status(h, tone, text, meta, title) {
    return h("div", { class: `ustatus ${tone}`, role: "status", title: title || null },
      h("span", { class: "ustatus-ic", "aria-hidden": "true" }),
      h("span", { class: "ustatus-text" }, text),
      meta ? h("span", { class: "ustatus-meta" }, meta) : null);
  }

  const PROVIDER_ORDER = ["claude", "codex"];
  const providerName = p => p === "claude" ? "Claude" : p === "codex" ? "ChatGPT / Codex" : String(p || "?");

  /** A limit that caps one model family (Claude Max: "Fable"), not the account: its display name, or null. */
  const modelName = w => typeof w.model === "string" && w.model.trim() ? w.model.trim().slice(0, 40) : null;

  function windowRow(h, name, w, now) {
    const used = Math.min(100, Math.max(0, w.used));
    const p = Math.round(used);
    const model = modelName(w);
    const span = windowLabel(w.minutes);
    const short = model || span;
    const long = model
      ? i18nText(w.minutes >= 10080 ? "usage.winModelWeek" : "usage.winModelSession", { m: model, w: span })
      : i18nText(w.minutes >= 10080 ? "usage.winWeek" : "usage.winSession", { w: span });
    const reset = w.resetsAt ? new Date(w.resetsAt) : null;
    const known = reset && Number.isFinite(reset.getTime());
    const left = known ? reset.getTime() - now : null;
    const resetText = !known ? i18nText("usage.resetUnknown")
      : left <= 0 ? i18nText("usage.resetDue")
      : i18nText("usage.resetsIn", { v: untilText(left) });
    const absolute = known ? i18nText("U0513", { v: reset.toLocaleString(i18nLocale(), { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) }) : i18nText("usage.resetUnknownTitle");
    return h("div", { class: "quota" },
      h("span", { class: `q-win${model ? " q-model" : ""}`, title: long }, short),
      h("span", { class: "bar", role: "progressbar", "aria-label": `${name} · ${long}`, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": p },
        h("i", { class: used > WARN_AT ? "warn" : "", style: { width: `${p}%` } })),
      h("span", { class: `pct${used > WARN_AT ? " warn" : ""}` }, pct(p)),
      h("span", { class: `q-reset${known ? "" : " unknown"}`, title: absolute }, resetText));
  }

  /** One block per provider account: name + profile tag, then its windows. Percentages of distinct accounts are never summed. */
  function quotaRows(h, fleet, opts = {}) {
    const now = opts.now || Date.now();
    const perProfile = Object.values(fleet.profiles || {}).flatMap(p => Object.values(p.quotas || {}));
    const globalQuotas = Object.values(fleet.quotas || {});
    const codexbarSelected = globalQuotas.some(q => q.source !== "hermes-account-usage");
    const quotas = perProfile.length && !codexbarSelected ? perProfile : globalQuotas;
    if (!quotas.length) return [h("p", { class: "muted" }, i18nNode("U0510"))];
    const rank = q => { const i = PROVIDER_ORDER.indexOf(q.provider); return i === -1 ? PROVIDER_ORDER.length : i; };
    const sorted = [...quotas].sort((a, b) => rank(a) - rank(b) || String(a.provider).localeCompare(String(b.provider)) || String(a.profile || "").localeCompare(String(b.profile || "")));
    return sorted.map(q => {
      const name = `${providerName(q.provider)}${q.profile ? ` · ${q.profile}` : ""}`;
      const raw = q.fetched_at || q.checkedAt;
      const stamp = raw > 1e9 ? raw : null; // epoch seconds; anything smaller is not a real fetch time
      const head = h("header", { class: "qhead" },
        h("b", { class: "qname" }, providerName(q.provider)),
        q.profile ? h("span", { class: "qtag", title: q.profile }, q.profile) : null);
      if (!q.ok) {
        const reason = q.error === "pending" ? i18nText("U0389") : q.err === "login-needed" ? i18nText("usage.loginNeeded") : i18nText("usage.quotaFailed");
        return h("section", { class: "qblock", "aria-label": name }, head, status(h, q.error === "pending" ? "info" : "warn", reason));
      }
      const valid = w => w && typeof w.used === "number" && Number.isFinite(w.used);
      const windows = (q.windows || []).filter(valid);
      // Model-family limits (Claude Max: Fable) come after the account windows, only when the account reports one.
      const models = (Array.isArray(q.modelWindows) ? q.modelWindows : []).filter(w => valid(w) && modelName(w));
      const stale = q.stale || q.error;
      return h("section", { class: `qblock${stale ? " is-stale" : ""}${models.length ? " has-model" : ""}`, "aria-label": name }, head,
        windows.length ? [...windows, ...models].map(w => windowRow(h, name, w, now)) : h("p", { class: "muted small" }, i18nNode("usage.noWindows")),
        stale ? status(h, "warn", i18nText("usage.staleShort"), stamp ? i18nText("usage.updatedAgo", { v: agoText(stamp, now) }) : null, i18nText("usage.stale")) : null);
    });
  }

  const ERROR_KINDS = { "too-large": "usage.err.tooLarge", locked: "usage.err.locked", missing: "usage.err.missing", schema: "usage.err.schema" };

  /** Failed profiles grouped by error kind: one inline status per kind, never one per profile. */
  function failureStatuses(h, status_, now) {
    const failed = Object.entries((status_ && status_.profiles) || {}).filter(([, p]) => p && !p.ok);
    const byKind = new Map();
    for (const [profile, p] of failed) {
      const kind = ERROR_KINDS[p.error] ? p.error : "unavailable";
      const g = byKind.get(kind) || { profiles: [], stale: true, updatedAt: 0 };
      g.profiles.push(profile);
      g.stale = g.stale && !!p.stale;
      g.updatedAt = Math.max(g.updatedAt, num(p.updatedAt));
      byKind.set(kind, g);
    }
    return [...byKind].map(([kind, g]) => {
      const reason = i18nText(ERROR_KINDS[kind] || "usage.err.unavailable");
      const tail = i18nText(g.stale ? "usage.err.showingLast" : "usage.err.noTotals");
      const meta = g.stale && g.updatedAt ? i18nText("usage.updatedAgo", { v: agoText(g.updatedAt, now) }) : null;
      return status(h, g.stale ? "warn" : "bad", `${reason} ${tail}`, meta, g.profiles.join(", "));
    });
  }

  /** Why a cost carries "≈" (tooltip only): subscription list price, estimate, or records without a cost. */
  function costWhy(t) {
    const why = [];
    if (t.equivalent) why.push(i18nText("tok.cost.equivalent"));
    else if (t.estimated) why.push(i18nText("tok.cost.estimated"));
    if (t.unknownCost) why.push(i18nText("tok.cost.unknown"));
    return why.join(" · ") || null;
  }

  /** Totals line + failures; nothing explanatory. "updated …" appears only when the data is older than 2 minutes. */
  function summary(h, rows, k, status_, opts = {}) {
    const now = opts.now || Date.now();
    const t = totals(rows);
    const profiles = Object.values((status_ && status_.profiles) || {});
    const updated = profiles.filter(p => p && p.ok && p.updatedAt).reduce((m, p) => Math.max(m, p.updatedAt), 0);
    const cost = h("span", { class: "usage-cost", title: costWhy(t) }, costText(t));
    const stale = updated && now / 1000 - updated > 120;
    return [
      h("div", { class: "usage-total" },
        h("span", { class: "usage-big" }, k(t.tokens)),
        h("span", { class: "usage-unit" }, i18nNode("usage.tokensUnit")),
        h("span", { class: "usage-sub" }, plural("usage.calls", t.n), h("span", { class: "usage-dot", "aria-hidden": "true" }, "·"), cost)),
      ...failureStatuses(h, status_, now),
      stale ? h("p", { class: "quota-note" }, i18nText("usage.updatedAgo", { v: agoText(updated, now) })) : null].filter(Boolean);
  }

  function modelTable(h, rows, k) {
    const by = new Map();
    for (const r of rows) {
      const key = `${r.agent}\t${r.model}`;
      const t = by.get(key) || { agent: r.agent, model: r.model, tokens: 0, usd: 0, estimated: false, unknownCost: 0 };
      t.tokens += volume(r); t.usd += num(r.usd); t.estimated ||= !!r.estimated;
      t.unknownCost += num(r.unknownCost);
      if (r.cost_label) t.cost_label = r.cost_label;
      by.set(key, t);
    }
    return h("table", { class: "tok usage-models" },
      h("thead", null, h("tr", null, [i18nText("usage.agentModel"), "Token", "$"].map(x => h("th", null, x)))),
      h("tbody", null, [...by.values()].sort((a, b) => b.tokens - a.tokens).map(r => h("tr", null,
        h("td", { class: "um-name", title: `${r.agent} · ${r.model}` }, h("b", null, r.agent), h("span", { class: "muted small usage-model" }, r.model)),
        h("td", null, k(r.tokens)), h("td", { title: costWhy({ ...r, equivalent: r.cost_label === "API list-price equivalent" }) }, costText(r))))));
  }
  /**
   * The quota refresh control: a small button next to the "Quotas" heading. `state` is {busy, note} owned by the caller;
   * `run` performs the refresh and returns the relay answer. The label changes only while busy or throttled.
   */
  function refreshButton(h, state, run, redraw) {
    const label = state.busy ? i18nText("usage.refreshing") : i18nText("usage.refresh");
    return h("button", {
      type: "button", class: `quota-refresh${state.busy ? " is-busy" : ""}`, disabled: state.busy ? "disabled" : null,
      title: state.note || i18nText("usage.refreshTip"), "aria-label": label, "aria-busy": state.busy ? "true" : "false",
      dataset: { fk: "quota-refresh" },
      onclick: async () => {
        if (state.busy) return;
        state.busy = true; state.note = null; redraw();
        try {
          const r = await run();
          state.note = r && r.throttled ? i18nText("usage.refreshWait", { s: r.retryAfterS || 30 })
            : r && r.timedOut ? i18nText("usage.refreshSlow") : null;
        } catch {
          state.note = i18nText("usage.refreshFailed");
        } finally {
          state.busy = false; redraw();
        }
      },
    }, h("span", { class: "quota-refresh-ic", "aria-hidden": "true" }, "↻"), h("span", { class: "quota-refresh-t" }, label));
  }
  const api = { refreshButton, totals, costText, costWhy, quotaRows, summary, failureStatuses, modelTable, pct, plural, agoText, untilText, windowLabel, status };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DeckUsage = api;
})(typeof window !== "undefined" ? window : globalThis);
