"use strict";
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
// Settings > Hermes config: every config.yaml setting of each Hermes profile, edited through the relay
// (main/hermes-config.js -> relay/src/hermes-config.js -> Hermes' own config code). The field list comes from Hermes'
// schema, so new Hermes settings show up without a Deck release. Edits are staged; one Review step shows the changes
// and saves them together (the relay backs config.yaml up first). Restart buttons for the Hermes gateway and the relay
// sit at the top. Pure helpers are exported for test/hermes-config-view.test.js. All text goes in as text nodes.
(() => {
  // ---------------------------------------------------------------- pure helpers
  const SEARCH_MAX = 150;
  const CHANGED = "__changed"; // the category picker's "Changed from default" entry

  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  /** Categories in Hermes' order, then the rest alphabetically. */
  function categories(fields, order = []) {
    const seen = new Set(Object.values(fields || {}).map((f) => f.category || "general"));
    const head = order.filter((c) => seen.has(c));
    return [...head, ...[...seen].filter((c) => !head.includes(c)).sort()];
  }

  /** The keys to show: a search across key and description (any category), else one category or the changed ones. */
  function visibleKeys(fields, { category = "general", search = "", explicit = [], draft = new Map() } = {}) {
    const keys = Object.keys(fields || {});
    const q = String(search || "").trim().toLowerCase();
    if (q) {
      const words = q.split(/\s+/);
      return keys.filter((k) => {
        const hay = `${k} ${fields[k].description || ""}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      }).slice(0, SEARCH_MAX);
    }
    if (category === CHANGED) {
      const set = new Set([...explicit, ...draft.keys()]);
      return keys.filter((k) => set.has(k));
    }
    return keys.filter((k) => (fields[k].category || "general") === category);
  }

  /**
   * One control's text -> {ok, value} for the field's type. Lists take one item per line (numbers stay numbers when
   * the current list is numeric); "free" fields (Hermes' default is null) read true/false/null and numbers literally.
   */
  function parseInput(field, text, current) {
    const t = field.type;
    const s = String(text ?? "");
    if (t === "number") {
      if (!s.trim()) return { ok: false };
      const n = Number(s);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    }
    if (t === "list") {
      const numeric = Array.isArray(current) && current.length > 0 && current.every((x) => typeof x === "number");
      const items = s.split("\n").map((x) => x.trim()).filter(Boolean);
      return { ok: true, value: numeric ? items.map((x) => (Number.isFinite(Number(x)) ? Number(x) : x)) : items };
    }
    if (field.free) {
      const v = s.trim();
      if (!v || v === "null") return { ok: true, value: null };
      if (v === "true" || v === "false") return { ok: true, value: v === "true" };
      if (/^-?\d+(\.\d+)?$/.test(v)) return { ok: true, value: Number(v) };
      return { ok: true, value: s };
    }
    return { ok: true, value: s };
  }

  /** A value as the control shows it. */
  function showValue(field, v) {
    if (field.type === "list") return Array.isArray(v) ? v.map(String).join("\n") : "";
    if (v === null || v === undefined) return "";
    return String(v);
  }

  /** The save request for a draft: {set, unset}. */
  function changes(draft) {
    const set = {}, unset = [];
    for (const [k, d] of draft) {
      if (d.unset) unset.push(k);
      else set[k] = d.value;
    }
    return { set, unset };
  }

  /** Short text for one value in the review list. */
  function brief(v) {
    if (v === undefined) return "—";
    const s = JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 77)}…` : s;
  }

  // ---------------------------------------------------------------- the section
  /**
   * ctx: {h, deck (window.deck), store, confirm({title, body, ok}) -> Promise<bool>, relayOpen() -> bool,
   *       refresh() (asks settings-view to rebuild this section)}
   */
  function create(ctx) {
    const { h } = ctx;
    const T = (k, v) => i18nText(k, v);
    const api = () => (ctx.deck && ctx.deck.hermesConfig) || null;
    const S = {
      schema: null, schemaErr: null, loading: false,
      profile: (ctx.store && ctx.store.get("deck.hcfgProfile")) || "default",
      cfg: null, cfgErr: null, // {rev, values, explicit, managed, restartNeeded}
      draft: new Map(), invalid: new Set(),
      category: (ctx.store && ctx.store.get("deck.hcfgCategory")) || "general", search: "",
      msg: null, // {ok, text}
      saving: false,
      restart: null, // /hermes/restart state
      busy: null, // "gateway" | "relay" while one is running
    };
    let listBox = null, footBox = null, msgBox = null, restartBox = null;
    let pollTimer = 0;

    function load({ schema = false } = {}) {
      const a = api();
      if (!a) return;
      S.loading = true;
      const steps = [];
      if (schema || !S.schema) steps.push(a.schema().then((r) => {
        if (r.ok) Object.assign(S, { schema: r, schemaErr: null });
        else S.schemaErr = r.error;
      }));
      steps.push(a.get(S.profile).then((r) => {
        if (r.ok) Object.assign(S, { cfg: r, cfgErr: null });
        else Object.assign(S, { cfg: null, cfgErr: r.error });
      }));
      steps.push(a.restartState().then((r) => { if (r.ok) S.restart = r; }, () => {}));
      Promise.all(steps).catch((e) => { S.cfgErr = String((e && e.message) || e); }).finally(() => {
        S.loading = false;
        if (S.schema && !S.schema.profiles.includes(S.profile)) {
          S.profile = "default";
          return load();
        }
        ctx.refresh();
      });
    }

    function setMsg(ok, text) {
      S.msg = text ? { ok, text } : null;
      if (msgBox) paintMsg();
    }
    function paintMsg() {
      msgBox.replaceChildren(...(S.msg ? [h("p", { class: `hcfg-msg ${S.msg.ok ? "ok" : "bad"}`, role: S.msg.ok ? "status" : "alert" }, S.msg.text)] : []));
    }

    // ------------------------------------------------------------ restarts
    function poll() {
      clearTimeout(pollTimer);
      const a = api();
      if (!a || !S.busy) return;
      pollTimer = setTimeout(() => {
        a.restartState().then((r) => {
          if (!r.ok) return; // the relay is away (restarting): try again
          const was = S.restart;
          S.restart = r;
          if (S.busy === "gateway" && r.gateway && r.gateway.state !== "running") {
            S.busy = null;
            setMsg(r.gateway.state === "done", T(r.gateway.state === "done" ? "hcfg.gatewayDone" : "hcfg.gatewayFailed"));
          } else if (S.busy === "relay" && was && r.relay && r.relay.startedAt !== S.relayFrom) {
            S.busy = null;
            setMsg(true, T("hcfg.relayDone"));
          }
        }, () => {}).finally(() => {
          paintRestart();
          if (S.busy) poll();
        });
      }, 1500);
    }

    async function restart(target) {
      const a = api();
      if (!a || S.busy) return;
      const ok = await ctx.confirm({
        title: T(target === "gateway" ? "hcfg.restartGatewayTitle" : "hcfg.restartRelayTitle"),
        body: T(target === "gateway" ? "hcfg.restartGatewayBody" : "hcfg.restartRelayBody"),
        ok: T(target === "gateway" ? "hcfg.restartGateway" : "hcfg.restartRelay"),
      });
      if (!ok) return;
      S.relayFrom = S.restart && S.restart.relay ? S.restart.relay.startedAt : null;
      S.busy = target;
      setMsg(true, T(target === "gateway" ? "hcfg.gatewayRunning" : "hcfg.relayRunning"));
      paintRestart();
      try {
        const r = await a.restart(target);
        if (!r.ok) {
          S.busy = null;
          setMsg(false, r.error);
        } else if (target === "gateway") S.restart = { ...(S.restart || {}), gateway: r.job };
      } catch (e) {
        if (target === "gateway") { S.busy = null; setMsg(false, String((e && e.message) || e)); }
      }
      paintRestart();
      if (S.busy) poll();
    }

    function paintRestart() {
      if (!restartBox) return;
      const g = S.restart && S.restart.gateway;
      const needed = !!(S.restart && S.restart.restartNeeded) || !!(S.cfg && S.cfg.restartNeeded);
      const rows = [
        h("div", { class: "sv-row" },
          h("span", { class: "sv-label" }, T("hcfg.restartLabel"), needed ? h("span", { class: "hcfg-pill" }, T("hcfg.restartNeeded")) : null),
          h("div", { class: "sv-ctl" },
            h("button", { class: "btn mini", type: "button", disabled: S.busy ? true : null, dataset: { fk: "hcfg:restart-gateway" }, onclick: () => restart("gateway") }, T("hcfg.restartGateway")),
            h("button", { class: "btn mini", type: "button", disabled: S.busy || (S.restart && S.restart.relay && !S.restart.relay.supervised) ? true : null, title: S.restart && S.restart.relay && !S.restart.relay.supervised ? T("hcfg.relayUnsupervised") : null, dataset: { fk: "hcfg:restart-relay" }, onclick: () => restart("relay") }, T("hcfg.restartRelay")))),
      ];
      if (g && g.output) rows.push(h("details", { class: "sv-block hcfg-out", open: g.state === "failed" ? true : null },
        h("summary", null, T(g.state === "running" ? "hcfg.gatewayRunning" : g.state === "done" ? "hcfg.gatewayDone" : "hcfg.gatewayFailed")),
        h("pre", null, g.output)));
      restartBox.replaceChildren(h("div", { class: "sv-group" }, ...rows));
    }

    // ------------------------------------------------------------ fields
    const current = (k) => (S.draft.has(k) ? (S.draft.get(k).unset ? undefined : S.draft.get(k).value) : S.cfg.values[k]);

    function stage(k, field, text) {
      const p = parseInput(field, text, S.cfg.values[k]);
      if (!p.ok) S.invalid.add(k);
      else {
        S.invalid.delete(k);
        if (same(p.value, S.cfg.values[k])) S.draft.delete(k);
        else S.draft.set(k, { value: p.value });
      }
      paintFoot();
      markRow(k);
    }

    function markRow(k) {
      if (!listBox) return;
      const row = listBox.querySelector(`[data-key="${CSS.escape(k)}"]`);
      if (!row) return;
      row.classList.toggle("edited", S.draft.has(k));
      row.classList.toggle("invalid", S.invalid.has(k));
    }

    function control(k, field) {
      const v = current(k);
      const id = `hcfg-${k.replace(/[^A-Za-z0-9_-]/g, "_")}`;
      if (field.type === "boolean") {
        return h("input", { id, type: "checkbox", role: "switch", class: "hcfg-switch", checked: v === true ? true : null, onchange: (e) => stageValue(k, e.target.checked) });
      }
      if (field.type === "select") {
        const opts = (field.options || []).slice();
        if (v !== undefined && v !== null && !opts.some((o) => same(o, v))) opts.unshift(v);
        return h("select", { id, onchange: (e) => stageValue(k, opts[Number(e.target.value)]) },
          opts.map((o, i) => h("option", { value: String(i), selected: same(o, v) ? true : null }, o === "" ? T("hcfg.auto") : String(o))));
      }
      if (field.type === "list") {
        return h("textarea", { id, rows: Math.min(6, Math.max(2, (Array.isArray(v) ? v.length : 0) + 1)), spellcheck: "false", placeholder: T("hcfg.onePerLine"), oninput: (e) => stage(k, field, e.target.value) }, showValue(field, v));
      }
      return h("input", { id, type: field.type === "number" ? "number" : "text", step: field.type === "number" ? "any" : null, autocomplete: "off", spellcheck: "false",
        value: showValue(field, v), placeholder: field.free ? T("hcfg.freePlaceholder") : null, oninput: (e) => stage(k, field, e.target.value) });
    }

    function stageValue(k, value) {
      S.invalid.delete(k);
      if (same(value, S.cfg.values[k])) S.draft.delete(k);
      else S.draft.set(k, { value });
      paintFoot();
      markRow(k);
    }

    function row(k) {
      const field = S.schema.fields[k];
      const explicit = S.cfg.explicit.includes(k);
      const resetting = S.draft.has(k) && S.draft.get(k).unset;
      const reset = explicit ? h("button", { class: "linkbtn sv-link", type: "button", title: T("hcfg.resetTip"), dataset: { fk: `hcfg:reset:${k}` }, onclick: () => {
        if (resetting) S.draft.delete(k);
        else S.draft.set(k, { unset: true });
        renderList();
        paintFoot();
      } }, T(resetting ? "hcfg.undoReset" : "hcfg.reset")) : null;
      const label = h("div", { class: "hcfg-label" },
        h("span", { class: "hcfg-desc" }, field.description || k, explicit ? h("span", { class: "hcfg-dot", title: T("hcfg.explicitTip") }) : null),
        h("code", { class: "hcfg-key" }, k));
      const ctl = resetting ? h("span", { class: "hcfg-resetting" }, T("hcfg.willReset")) : control(k, field);
      return h("div", { class: `sv-row hcfg-row${field.type === "list" ? " wide" : ""}${S.draft.has(k) ? " edited" : ""}${S.invalid.has(k) ? " invalid" : ""}`, dataset: { key: k } },
        label, h("div", { class: "sv-ctl" }, ctl, reset));
    }

    function renderList() {
      if (!listBox || !S.schema || !S.cfg) return;
      const keys = visibleKeys(S.schema.fields, { category: S.category, search: S.search, explicit: S.cfg.explicit, draft: S.draft });
      if (!keys.length) return listBox.replaceChildren(h("p", { class: "sv-hint" }, T(S.search ? "hcfg.noMatch" : "hcfg.noneChanged")));
      const more = S.search && keys.length >= SEARCH_MAX ? h("p", { class: "sv-hint" }, T("hcfg.tooMany", { n: SEARCH_MAX })) : null;
      listBox.replaceChildren(...[h("div", { class: "sv-group" }, ...keys.map(row)), more].filter(Boolean));
    }

    function paintFoot() {
      if (!footBox) return;
      const n = S.draft.size;
      const bad = S.invalid.size;
      footBox.hidden = !n && !bad;
      footBox.replaceChildren(
        h("span", { class: "hcfg-count" }, bad ? T("hcfg.invalid", { n: bad }) : T("hcfg.pending", { n })),
        h("button", { class: "linkbtn sv-link", type: "button", dataset: { fk: "hcfg:discard" }, onclick: () => { S.draft.clear(); S.invalid.clear(); renderList(); paintFoot(); } }, T("hcfg.discard")),
        h("button", { class: "btn primary", type: "button", disabled: !n || bad || S.saving ? true : null, dataset: { fk: "hcfg:review" }, onclick: review }, T("hcfg.review")));
    }

    async function review() {
      const a = api();
      if (!a || !S.draft.size || S.invalid.size || S.saving) return;
      const lines = [...S.draft].map(([k, d]) => `${k}: ${brief(S.cfg.values[k])} → ${d.unset ? T("hcfg.default") : brief(d.value)}`);
      const ok = await ctx.confirm({ title: T("hcfg.reviewTitle", { profile: S.profile }), body: `${lines.join("\n")}\n\n${T("hcfg.reviewNote")}`, ok: T("hcfg.save") });
      if (!ok) return;
      S.saving = true;
      paintFoot();
      try {
        const r = await a.save({ profile: S.profile, rev: S.cfg.rev, ...changes(S.draft) });
        if (r.ok) {
          S.cfg = { ...S.cfg, ...r };
          S.draft.clear();
          S.invalid.clear();
          S.restart = { ...(S.restart || {}), restartNeeded: true };
          setMsg(true, T("hcfg.saved", { n: (r.saved || []).length, backup: r.backup || "-" }));
        } else setMsg(false, r.status === 409 ? `${r.error} ${T("hcfg.reloadHint")}` : r.error);
      } catch (e) {
        setMsg(false, String((e && e.message) || e));
      }
      S.saving = false;
      renderList();
      paintFoot();
      paintRestart();
    }

    // ------------------------------------------------------------ the builder (settings-view.js BUILDERS)
    function build(kids) {
      if (!api()) return kids.push(h("p", { class: "sv-hint" }, T("hcfg.unavailable")));
      if (!ctx.relayOpen()) {
        kids.push(h("p", { class: "sv-hint" }, T("hcfg.needsRelay")));
        return;
      }
      if (!S.schema && !S.schemaErr && !S.loading) load();
      kids.push(h("p", { class: "sv-hint" }, T("hcfg.intro")));
      restartBox = h("div", { class: "sv-group-wrap" });
      msgBox = h("div", { class: "hcfg-msgs", "aria-live": "polite" });
      paintRestart();
      paintMsg();
      kids.push(restartBox, msgBox);
      if (S.schemaErr || (S.cfgErr && !S.cfg)) {
        kids.push(h("p", { class: "form-error" }, S.schemaErr || S.cfgErr),
          h("div", { class: "form-actions sv-actions" }, h("button", { class: "btn mini", type: "button", onclick: () => { S.schemaErr = S.cfgErr = null; load({ schema: true }); } }, T("hcfg.retry"))));
        return;
      }
      if (!S.schema || !S.cfg) return kids.push(h("p", { class: "sv-hint" }, T("hcfg.loading")));
      const profile = h("select", { id: "hcfg-profile", "aria-label": T("hcfg.profile"), onchange: async (e) => {
        if (S.draft.size && !(await ctx.confirm({ title: T("hcfg.leaveTitle"), body: T("hcfg.leaveBody", { n: S.draft.size }), ok: T("hcfg.discard") }))) {
          e.target.value = S.profile;
          return;
        }
        S.profile = e.target.value;
        if (ctx.store) ctx.store.set("deck.hcfgProfile", S.profile);
        S.draft.clear(); S.invalid.clear(); S.cfg = null; setMsg(true, null);
        load();
        ctx.refresh();
      } }, S.schema.profiles.map((p) => h("option", { value: p, selected: p === S.profile ? true : null }, p)));
      const cats = categories(S.schema.fields, S.schema.categoryOrder);
      if (S.category !== CHANGED && !cats.includes(S.category)) S.category = cats[0] || "general";
      const category = h("select", { id: "hcfg-category", "aria-label": T("hcfg.category"), disabled: S.search ? true : null, onchange: (e) => {
        S.category = e.target.value;
        if (ctx.store) ctx.store.set("deck.hcfgCategory", S.category);
        renderList();
      } }, h("option", { value: CHANGED, selected: S.category === CHANGED ? true : null }, T("hcfg.changed", { n: S.cfg.explicit.length })),
        cats.map((c) => h("option", { value: c, selected: c === S.category ? true : null }, c.replace(/_/g, " "))));
      const search = h("input", { id: "hcfg-search", type: "search", autocomplete: "off", spellcheck: "false", placeholder: T("hcfg.search", { n: Object.keys(S.schema.fields).length }), value: S.search, oninput: (e) => {
        S.search = e.target.value;
        category.disabled = !!S.search.trim();
        renderList();
      } });
      const reload = h("button", { class: "btn mini", type: "button", title: T("hcfg.reloadTip"), dataset: { fk: "hcfg:reload" }, onclick: () => { S.draft.clear(); S.invalid.clear(); setMsg(true, null); load({ schema: true }); } }, T("hcfg.reload"));
      kids.push(h("div", { class: "hcfg-bar" }, profile, category, search, reload));
      if (S.cfg.managed) kids.push(h("p", { class: "form-error" }, T("hcfg.managed")));
      listBox = h("div", { class: "hcfg-list" });
      footBox = h("div", { class: "hcfg-foot", role: "region", "aria-label": T("hcfg.pendingRegion") });
      renderList();
      paintFoot();
      kids.push(listBox, footBox);
    }

    return { build, hasDraft: () => S.draft.size > 0, _state: S };
  }

  const api = { create, categories, visibleKeys, parseInput, showValue, changes, brief, CHANGED, SEARCH_MAX };
  if (typeof window !== "undefined") window.DeckHermesConfigView = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
