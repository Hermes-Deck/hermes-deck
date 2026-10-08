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
  const CHANGED = "__changed"; // the category list's "Changed" entry

  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  /** Categories in Hermes' order, then the rest alphabetically. */
  function categories(fields, order = []) {
    const seen = new Set(Object.values(fields || {}).map((f) => f.category || "general"));
    const head = order.filter((c) => seen.has(c));
    return [...head, ...[...seen].filter((c) => !head.includes(c)).sort()];
  }

  const ACRONYMS = new Set(["id", "ids", "url", "urls", "api", "ttl", "tts", "stt", "llm", "mcp", "ssh", "ui", "cli", "ip", "tls", "dm", "dms", "ok", "mb", "gb", "ms", "uri", "pty", "tui", "lsp", "gpu", "cpu", "http", "https", "html", "json", "yaml", "sql", "oauth", "pr"]);

  /** "max_iterations" -> "Max iterations" (known acronyms upper-cased). */
  function humanize(name) {
    const words = String(name || "").split(/[_\-\s]+/).filter(Boolean).map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w));
    const text = words.join(" ");
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
  }

  /** The title of a field: its last key segment, humanized. */
  const labelOf = (key) => humanize(String(key).split(".").pop());

  /** The sub-section a key sits in inside its category: the path between the category and the last segment. */
  function sectionOf(key, category) {
    const parts = String(key).split(".").slice(0, -1);
    if (parts[0] === category) parts.shift();
    return parts.map(humanize).join(" › ");
  }

  /**
   * Keys grouped by [category and] sub-section, in schema order; the section-less group of a category comes first.
   * -> [{category, section, keys}]
   */
  function groupKeys(keys, fields, { byCategory = false } = {}) {
    const groups = new Map();
    for (const k of keys) {
      const category = (fields[k] && fields[k].category) || "general";
      const section = sectionOf(k, category);
      const id = `${byCategory ? category : ""}\u0000${section}`;
      if (!groups.has(id)) groups.set(id, { category: byCategory ? category : null, section, keys: [] });
      groups.get(id).keys.push(k);
    }
    const out = [...groups.values()];
    const rank = (g) => (g.section ? 1 : 0);
    return byCategory ? out : out.sort((a, b) => rank(a) - rank(b)); // stable: schema order inside each rank
  }

  /** {category: count} plus the number of changed fields (written in config.yaml or staged). */
  function categoryCounts(fields, explicit = [], draft = new Map()) {
    const counts = {};
    for (const f of Object.values(fields || {})) counts[f.category || "general"] = (counts[f.category || "general"] || 0) + 1;
    const set = new Set([...explicit, ...draft.keys()]);
    return { counts, changed: Object.keys(fields || {}).filter((k) => set.has(k)).length };
  }

  /** Split text for match highlighting: [{t, hit}]. */
  function highlightParts(text, search) {
    const str = String(text ?? "");
    const words = [...new Set(String(search || "").trim().toLowerCase().split(/\s+/).filter(Boolean))];
    if (!words.length) return [{ t: str, hit: false }];
    const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
    return str.split(re).map((t, i) => ({ t, hit: i % 2 === 1 })).filter((x) => x.t !== ""); // odd entries are the captured matches
  }

  /** A default as short text (null when there is nothing worth showing). */
  function defaultText(field) {
    const d = field && field.default;
    if (d === undefined || d === null) return null;
    if (Array.isArray(d)) return d.length ? d.map(String).join(", ").slice(0, 80) : null;
    if (typeof d === "boolean") return d ? "on" : "off";
    const s = String(d);
    return s === "" ? null : s.length > 80 ? `${s.slice(0, 77)}…` : s;
  }

  /** i18n key of the inline message for text a control cannot take, or null. */
  function invalidReason(field, text) {
    return parseInput(field, text).ok ? null : field.type === "number" ? "hcfg.badNumber" : "hcfg.badValue";
  }

  /** Help text long enough to be worth a "more" toggle. */
  const isLongHelp = (help) => String(help || "").length > 150;

  /** The keys to show: a search across key, title, description and help (any category), else one category or the changed ones. */
  function visibleKeys(fields, { category = "general", search = "", explicit = [], draft = new Map() } = {}) {
    const keys = Object.keys(fields || {});
    const q = String(search || "").trim().toLowerCase();
    if (q) {
      const words = q.split(/\s+/);
      return keys.filter((k) => {
        const hay = `${k} ${labelOf(k)} ${fields[k].description || ""} ${fields[k].help || ""}`.toLowerCase();
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
      saving: false, open: new Set(), errs: new Map(), // open: keys whose help is expanded; errs: key -> i18n key
      restart: null, // /hermes/restart state
      busy: null, // "gateway" | "relay" while one is running
    };
    let listBox = null, footBox = null, msgBox = null, restartBox = null, navBox = null;
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
      const state = S.busy ? "busy" : needed ? "needed" : "ok";
      const status = S.busy ? T(S.busy === "gateway" ? "hcfg.gatewayRunning" : "hcfg.relayRunning") : needed ? T("hcfg.restartNeededLong") : T("hcfg.restartUpToDate");
      const unsup = S.restart && S.restart.relay && !S.restart.relay.supervised;
      const kids = [
        h("div", { class: "hcfg-rs-head" },
          h("span", { class: `hcfg-led ${state}`, "aria-hidden": "true" }),
          h("div", { class: "hcfg-rs-text" }, h("strong", null, T("hcfg.restartLabel")), h("span", { class: "hcfg-rs-status" }, status)),
          h("div", { class: "hcfg-rs-btns" },
            h("button", { class: "btn mini", type: "button", disabled: S.busy ? true : null, dataset: { fk: "hcfg:restart-gateway" }, onclick: () => restart("gateway") }, T("hcfg.restartGateway")),
            h("button", { class: "btn mini", type: "button", disabled: S.busy || unsup ? true : null, title: unsup ? T("hcfg.relayUnsupervised") : null, dataset: { fk: "hcfg:restart-relay" }, onclick: () => restart("relay") }, T("hcfg.restartRelay")))),
      ];
      if (g && g.output) kids.push(h("details", { class: "hcfg-out", open: g.state === "failed" ? true : null },
        h("summary", null, T(g.state === "running" ? "hcfg.gatewayRunning" : g.state === "done" ? "hcfg.gatewayDone" : "hcfg.gatewayFailed")),
        h("pre", null, g.output)));
      restartBox.replaceChildren(...kids);
    }

    // ------------------------------------------------------------ fields
    const current = (k) => (S.draft.has(k) ? (S.draft.get(k).unset ? undefined : S.draft.get(k).value) : S.cfg.values[k]);

    function stage(k, field, text) {
      const p = parseInput(field, text, S.cfg.values[k]);
      if (!p.ok) {
        S.invalid.add(k);
        S.errs.set(k, invalidReason(field, text));
      } else {
        S.invalid.delete(k);
        S.errs.delete(k);
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
      row.classList.toggle("changed", S.draft.has(k) || S.cfg.explicit.includes(k));
      const err = row.querySelector(".hcfg-err");
      if (err) err.textContent = S.invalid.has(k) ? T(S.errs.get(k) || "hcfg.badValue") : "";
      paintNav();
    }

    function control(k, field) {
      const v = current(k);
      const id = `hcfg-${k.replace(/[^A-Za-z0-9_-]/g, "_")}`;
      if (field.type === "boolean") {
        return h("label", { class: "toggle hcfg-toggle", for: id },
          h("input", { id, type: "checkbox", role: "switch", "aria-label": labelOf(k), checked: v === true ? true : null, onchange: (e) => stageValue(k, e.target.checked) }),
          h("span", { class: "sw", "aria-hidden": "true" }));
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
      S.errs.delete(k);
      if (same(value, S.cfg.values[k])) S.draft.delete(k);
      else S.draft.set(k, { value });
      paintFoot();
      markRow(k);
    }

    /** Text with the search words marked (text nodes and <mark> only). */
    function marked(text) {
      return highlightParts(text, S.search).map((p) => (p.hit ? h("mark", null, p.t) : p.t));
    }

    function copyKey(k, el) {
      const done = () => { el.classList.add("copied"); setTimeout(() => el.classList.remove("copied"), 1200); };
      try {
        const w = typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText(k);
        if (w && w.then) w.then(done, () => {});
        else done();
      } catch { /* clipboard unavailable: nothing to do */ }
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
        paintNav();
      } }, T(resetting ? "hcfg.undoReset" : "hcfg.reset")) : null;
      const help = field.help && field.help !== field.description ? field.help : (field.help || "");
      const long = isLongHelp(help);
      const opened = S.open.has(k);
      const def = defaultText(field);
      const helpEl = help ? h("p", { class: `hcfg-help${long && !opened ? " clamp" : ""}` }, marked(help)) : null;
      const more = long ? h("button", { class: "linkbtn hcfg-more", type: "button", "aria-expanded": opened ? "true" : "false", onclick: (e) => {
        const on = !S.open.has(k);
        if (on) S.open.add(k); else S.open.delete(k);
        helpEl.classList.toggle("clamp", !on);
        e.currentTarget.setAttribute("aria-expanded", on ? "true" : "false");
        e.currentTarget.textContent = T(on ? "hcfg.less" : "hcfg.more");
      } }, T(opened ? "hcfg.less" : "hcfg.more")) : null;
      const label = h("div", { class: "hcfg-label" },
        h("div", { class: "hcfg-title" }, h("span", { class: "hcfg-name" }, marked(labelOf(k))),
          h("span", { class: "hcfg-badge", title: T("hcfg.explicitTip") }, T("hcfg.badgeChanged"))),
        helpEl, more,
        h("div", { class: "hcfg-meta" },
          h("button", { class: "hcfg-key", type: "button", title: T("hcfg.copyKey"), "aria-label": `${T("hcfg.copyKey")}: ${k}`, onclick: (e) => copyKey(k, e.currentTarget) }, marked(k)),
          def !== null ? h("span", { class: "hcfg-default" }, T("hcfg.defaultIs", { v: def })) : null));
      const ctl = resetting ? h("span", { class: "hcfg-resetting" }, T("hcfg.willReset")) : control(k, field);
      const cls = `hcfg-row${field.type === "list" ? " wide" : ""}${field.type === "boolean" ? " bool" : ""}${S.draft.has(k) ? " edited" : ""}${S.invalid.has(k) ? " invalid" : ""}${explicit || S.draft.has(k) ? " changed" : ""}`;
      return h("div", { class: cls, dataset: { key: k } },
        label,
        h("div", { class: "hcfg-ctl" }, h("div", { class: "hcfg-ctl-line" }, ctl, reset),
          h("p", { class: "hcfg-err", role: "alert" }, S.invalid.has(k) ? T(S.errs.get(k) || "hcfg.badValue") : "")));
    }

    function renderList() {
      if (!listBox || !S.schema || !S.cfg) return;
      const keys = visibleKeys(S.schema.fields, { category: S.category, search: S.search, explicit: S.cfg.explicit, draft: S.draft });
      if (!keys.length) return listBox.replaceChildren(h("p", { class: "sv-hint" }, T(S.search ? "hcfg.noMatch" : "hcfg.noneChanged")));
      const wide = !!S.search.trim() || S.category === CHANGED; // across categories: say which one each group is in
      const kids = [];
      for (const g of groupKeys(keys, S.schema.fields, { byCategory: wide })) {
        const title = [g.category ? g.category.replace(/_/g, " ") : "", g.section].filter(Boolean).join(" › ");
        kids.push(h("section", { class: "hcfg-sec" },
          title ? h("h3", { class: "hcfg-sec-title" }, title.charAt(0).toUpperCase() + title.slice(1), h("span", { class: "hcfg-sec-n" }, String(g.keys.length))) : null,
          h("div", { class: "sv-group hcfg-group" }, ...g.keys.map(row))));
      }
      if (S.search && keys.length >= SEARCH_MAX) kids.push(h("p", { class: "sv-hint" }, T("hcfg.tooMany", { n: SEARCH_MAX })));
      listBox.replaceChildren(...kids);
    }

    function paintNav() {
      if (!navBox || !S.schema || !S.cfg) return;
      const { counts, changed } = categoryCounts(S.schema.fields, S.cfg.explicit, S.draft);
      const cats = categories(S.schema.fields, S.schema.categoryOrder);
      const searching = !!S.search.trim();
      const item = (id, label, n, extra) => h("button", { class: `hcfg-cat${S.category === id && !searching ? " on" : ""}`, type: "button", "aria-current": S.category === id && !searching ? "true" : null, dataset: { fk: `hcfg:cat:${id}` }, onclick: () => {
        S.category = id;
        if (S.search) { S.search = ""; const q = document.getElementById("hcfg-search"); if (q) q.value = ""; }
        if (ctx.store) ctx.store.set("deck.hcfgCategory", id);
        renderList();
        paintNav();
      } }, h("span", { class: "hcfg-cat-name" }, label), h("span", { class: `hcfg-cat-n${extra ? ` ${extra}` : ""}` }, String(n)));
      navBox.replaceChildren(
        item(CHANGED, T("hcfg.changedShort"), changed, "chg"),
        h("div", { class: "hcfg-nav-sep", role: "presentation" }),
        ...cats.map((c) => item(c, c.replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase()), counts[c] || 0)));
    }

    function paintFoot() {
      if (!footBox) return;
      const n = S.draft.size;
      const bad = S.invalid.size;
      footBox.hidden = !n && !bad;
      footBox.replaceChildren(
        h("span", { class: `hcfg-count${bad ? " bad" : ""}` }, h("b", null, String(bad || n)), " ", bad ? T("hcfg.invalid", { n: bad }).replace(/^\d+\s*/, "") : T("hcfg.pending", { n }).replace(/^\d+\s*/, "")),
        h("button", { class: "linkbtn sv-link", type: "button", dataset: { fk: "hcfg:discard" }, onclick: () => { S.draft.clear(); S.invalid.clear(); S.errs.clear(); renderList(); paintFoot(); paintNav(); } }, T("hcfg.discard")),
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
          S.errs.clear();
          S.restart = { ...(S.restart || {}), restartNeeded: true };
          setMsg(true, T("hcfg.saved", { n: (r.saved || []).length, backup: r.backup || "-" }));
        } else setMsg(false, r.status === 409 ? `${r.error} ${T("hcfg.reloadHint")}` : r.error);
      } catch (e) {
        setMsg(false, String((e && e.message) || e));
      }
      S.saving = false;
      renderList();
      paintFoot();
      paintNav();
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
      restartBox = h("div", { class: "hcfg-restart" });
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
      const switchProfile = async (name) => {
        if (name === S.profile) return;
        if (S.draft.size && !(await ctx.confirm({ title: T("hcfg.leaveTitle"), body: T("hcfg.leaveBody", { n: S.draft.size }), ok: T("hcfg.discard") }))) return;
        S.profile = name;
        if (ctx.store) ctx.store.set("deck.hcfgProfile", S.profile);
        S.draft.clear(); S.invalid.clear(); S.errs.clear(); S.cfg = null; setMsg(true, null);
        load();
        ctx.refresh();
      };
      const profiles = S.schema.profiles;
      const profile = profiles.length <= 6
        ? h("span", { class: "chan hcfg-profiles", role: "group", "aria-label": T("hcfg.profile") },
          ...profiles.map((p) => h("button", { type: "button", "aria-pressed": p === S.profile ? "true" : "false", dataset: { fk: `hcfg:profile:${p}` }, onclick: () => switchProfile(p) }, p)))
        : h("select", { id: "hcfg-profile", "aria-label": T("hcfg.profile"), onchange: (e) => { const v = e.target.value; e.target.value = S.profile; switchProfile(v); } },
          profiles.map((p) => h("option", { value: p, selected: p === S.profile ? true : null }, p)));
      const cats = categories(S.schema.fields, S.schema.categoryOrder);
      if (S.category !== CHANGED && !cats.includes(S.category)) S.category = cats[0] || "general";
      const search = h("input", { id: "hcfg-search", type: "search", autocomplete: "off", spellcheck: "false", "aria-label": T("hcfg.searchLabel"), placeholder: T("hcfg.search", { n: Object.keys(S.schema.fields).length }), value: S.search, oninput: (e) => {
        S.search = e.target.value;
        renderList();
        paintNav();
      } });
      const reload = h("button", { class: "btn mini", type: "button", title: T("hcfg.reloadTip"), dataset: { fk: "hcfg:reload" }, onclick: () => { S.draft.clear(); S.invalid.clear(); S.errs.clear(); setMsg(true, null); load({ schema: true }); } }, T("hcfg.reload"));
      kids.push(h("div", { class: "hcfg-bar" }, profile, search, reload));
      if (S.cfg.managed) kids.push(h("p", { class: "form-error" }, T("hcfg.managed")));
      navBox = h("nav", { class: "hcfg-nav", "aria-label": T("hcfg.category") });
      listBox = h("div", { class: "hcfg-list" });
      footBox = h("div", { class: "hcfg-foot", role: "region", "aria-label": T("hcfg.pendingRegion") });
      renderList();
      paintNav();
      paintFoot();
      kids.push(h("div", { class: "hcfg-body" }, navBox, listBox), footBox);
    }

    return { build, hasDraft: () => S.draft.size > 0, _state: S };
  }

  const api = { create, humanize, labelOf, sectionOf, groupKeys, categoryCounts, highlightParts, defaultText, invalidReason, isLongHelp, categories, visibleKeys, parseInput, showValue, changes, brief, CHANGED, SEARCH_MAX };
  if (typeof window !== "undefined") window.DeckHermesConfigView = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
