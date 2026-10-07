"use strict";
// Composer pickers (window.DeckModelPicker): a model chip and a reasoning chip left of Send, each opening a popover
// anchored to the composer. Hermes uses session-scoped config.set; Telegram sends native chat commands.
// Pure helpers at the top are exported for unit tests.
(() => {
  // ---------------------------------------------------------------- pure helpers
  /** Levels Hermes accepts for one session (hermes_constants.parse_reasoning_effort); "none" turns thinking off. */
  const EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,199}$/;
  const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const ROWS_PER_GROUP = 80; // a group draws this many until "Show all"
  const SEARCH_MAX = 300; // matches drawn while searching
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const lower = (s) => String(s || "").toLowerCase();

  /** "anthropic/claude-sonnet-4-5-20250929" -> "claude-sonnet-4-5": the last path part without a date stamp. */
  function shortName(id) {
    const s = String(id || "");
    return s.split("/").pop().replace(/-\d{8}$/, "") || s;
  }

  /** Every word of the query appears in the name, the id, the provider slug or the provider name. */
  function matches(o, query) {
    const words = lower(query).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = lower(`${shortName(o.id)} ${o.id} ${o.provider} ${o.providerName}`);
    return words.every((w) => hay.includes(w));
  }

  /**
   * Options -> provider groups: the current provider first, then by name; models by name (numeric-aware).
   * Only options that match `query`.
   */
  function buildGroups(options, { query = "", currentProvider = "" } = {}) {
    const by = new Map();
    for (const o of options || []) {
      if (!o || !matches(o, query)) continue;
      let g = by.get(o.provider);
      if (!g) by.set(o.provider, (g = { provider: o.provider, name: o.providerName || o.provider, current: false, userDefined: !!o.userDefined, models: [] }));
      if (o.providerCurrent || (currentProvider && o.provider === currentProvider)) g.current = true;
      g.models.push(o);
    }
    const groups = [...by.values()];
    for (const g of groups) g.models.sort((a, b) => collator.compare(shortName(a.id), shortName(b.id)) || collator.compare(a.id, b.id));
    groups.sort((a, b) => Number(b.current) - Number(a.current) || collator.compare(a.name, b.name) || collator.compare(a.provider, b.provider));
    return groups;
  }

  /** The option the session runs on: Hermes' own flag, else the reported model under the reported provider. */
  function currentOption(data) {
    const opts = (data && data.options) || [];
    const cur = (data && data.current) || {};
    return opts.find((o) => o.current) || opts.find((o) => o.id === cur.model && (!cur.provider || o.provider === cur.provider)) || null;
  }

  /** Levels to offer for a model: none when it has no reasoning control; no "none" when it cannot turn thinking off. */
  function effortsFor(o) {
    if (o && o.reasoning === false) return [];
    return o && o.canDisable === false ? EFFORTS.filter((e) => e !== "none") : EFFORTS.slice();
  }

  /** A reported level as one of EFFORTS ("off" is how the plugin reports a disabled level), else "". */
  function effortKey(v) {
    const e = lower(v).trim();
    if (e === "off" || e === "none" || e === "disabled") return "none";
    return EFFORTS.includes(e) ? e : "";
  }

  /**
   * The custom model box: "model-id" (on `fallback`, the session's provider) or "@provider:model-id". Provider slugs
   * may hold a colon (custom:name), so a known slug is matched first. {provider, model} or null.
   */
  function parseCustom(text, slugs, fallback) {
    const t = String(text || "").trim();
    if (!t || /\s/.test(t)) return null;
    let provider = fallback || "";
    let model = t;
    if (t.startsWith("@")) {
      const body = t.slice(1);
      const known = [...(slugs || [])].filter((s) => body.startsWith(`${s}:`)).sort((a, b) => b.length - a.length)[0];
      if (known) {
        provider = known;
        model = body.slice(known.length + 1);
      } else {
        const parts = body.split(":");
        const take = parts[0] === "custom" && parts.length > 2 ? 2 : 1;
        provider = parts.slice(0, take).join(":");
        model = parts.slice(take).join(":");
      }
    }
    return SLUG_RE.test(provider) && MODEL_ID_RE.test(model) ? { provider, model } : null;
  }

  /** Native parser splits on whitespace, not shell syntax: bracket IDs must remain unquoted. */
  function commandName(name, bot) {
    if (bot && !/^[A-Za-z0-9_]{1,32}$/.test(bot)) throw new Error("pick.commandInvalid");
    return `/${name}${bot ? `@${bot}` : ""}`;
  }
  function modelCommand(o, bot = "") {
    if (!o || typeof o.id !== "string" || typeof o.provider !== "string" || !MODEL_ID_RE.test(o.id) || !SLUG_RE.test(o.provider)) throw new Error("pick.commandInvalid");
    return `${commandName("model", bot)} ${o.id} --provider ${o.provider} --session`;
  }

  function reasoningCommand(effort, bot = "") {
    if (!EFFORTS.includes(effort)) throw new Error("pick.commandInvalid");
    return `${commandName("reasoning", bot)} ${effort}`;
  }

  // ---------------------------------------------------------------- the view
  const SVGNS = "http://www.w3.org/2000/svg";
  const PATHS = { chev: "M4.5 6.5 8 10l3.5-3.5", x: "M4.5 4.5l7 7m0-7-7 7", plus: "M8 3.5v9M3.5 8h9" };
  function icon(name) {
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", "0 0 16 16");
    s.setAttribute("class", `pick-ic pick-ic-${name}`);
    s.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", PATHS[name]);
    s.appendChild(p);
    return s;
  }

  /**
   * ctx: {h, i18nText, bridge, composer, send, cleanErr, note(text, bad), thinking: {isOpen, setOpen},
   *       session(): {sid, profile, node, switchDisabled?: string} | null}
   */
  function create(ctx) {
    const { h, bridge, composer, send } = ctx;
    const T = (key, vars) => ctx.i18nText(key, vars);
    const failure = (e) => e?.message === "pick.commandInvalid" ? T("pick.commandInvalid") : ctx.cleanErr(e);
    const cache = new Map(); // sid -> model.options projection
    const loading = new Set(); // sids with a model.options request in flight
    const chosen = new Map(); // sid -> {provider, model, was}: picked here, until the session reports a change
    const effortChosen = new Map(); // sid -> {effort, was}: picked here, until the session reports a change
    const busy = new Set(); // `${sid}:model` | `${sid}:effort`
    let open = null; // "model" | "effort" | null
    let openSid = null;
    let openKey = null;
    let candidate = null; // Telegram row selection, not yet submitted
    let query = "";
    let loadError = null;
    let confirm = null; // {option, message}: Hermes asked to confirm an expensive model
    let shell = null; // the model popover's fixed parts: search, list, custom
    let lastKey = "";
    const groupOpen = new Map(); // provider -> open, as toggled since the popover opened
    const showAll = new Set();

    const modelLabel = h("span", { class: "pick-label" });
    const effortLabel = h("span", { class: "pick-label" });
    const modelChip = h("button", { class: "pick-chip pick-model", type: "button", "aria-haspopup": "dialog", "aria-expanded": "false", dataset: { fk: "pick-model" }, onclick: () => toggle("model") }, modelLabel, icon("chev"));
    const effortChip = h("button", { class: "pick-chip pick-effort", type: "button", "aria-haspopup": "menu", "aria-expanded": "false", dataset: { fk: "pick-effort" }, onclick: () => toggle("effort") }, effortLabel, icon("chev"));
    const bar = h("div", { class: "pick-bar", hidden: true, onkeydown: (e) => { if (e.key === "Escape" && open) { e.preventDefault(); close(true); } } }, modelChip, effortChip);
    const pop = h("div", { class: "pick-pop", hidden: true, onkeydown: onPopKey, onfocusout: onPopBlur });
    send.parentNode.insertBefore(bar, send);
    composer.appendChild(pop);

    // ------------------------------------------------------------ state helpers
    const dataOf = (sid) => cache.get(sid) || null;
    /** What the session runs next: a pick made here, else the live report, else the last model.options answer. */
    function selectedOf(sid) {
      const c = chosen.get(sid);
      if (c) return c;
      const data = dataOf(sid);
      const s = ctx.session();
      const n = s && s.sid === sid ? s.node : null;
      if (s && s.telegram && n && n.model && n.provider) return { provider: n.provider, model: n.model };
      if (n && n.model && data) {
        const live = data.options.find((o) => o.id === n.model && o.provider === n.provider) || data.options.find((o) => o.id === n.model && o.providerCurrent);
        if (live) return { provider: live.provider, model: live.id };
      }
      const o = currentOption(data);
      return o ? { provider: o.provider, model: o.id } : null;
    }
    function optionOf(sid) {
      const sel = selectedOf(sid);
      const data = dataOf(sid);
      return sel && data ? data.options.find((o) => o.provider === sel.provider && o.id === sel.model) || null : null;
    }
    /** The session's own report wins as soon as it moves (to the pick, or to a change made elsewhere). */
    function settle(s) {
      const n = s.node;
      const c = chosen.get(s.sid);
      if (c && !c.pending && n && n.model && (n.model === c.model || n.model !== c.was)) chosen.delete(s.sid);
      const e = effortChosen.get(s.sid);
      if (e && !e.pending && n && (effortKey(n.effort) === e.effort || (n.effort || "") !== e.was)) effortChosen.delete(s.sid);
    }
    function modelText(s) {
      const c = chosen.get(s.sid);
      if (c) return { text: shortName(c.model), title: `@${c.provider}:${c.model}${c.pending ? ` · ${T("pick.pending")}` : ""}` };
      const n = s.node;
      if (n && n.model) return { text: shortName(n.model), title: n.provider ? `@${n.provider}:${n.model}` : n.model };
      const o = currentOption(dataOf(s.sid));
      if (o) return { text: shortName(o.id), title: `@${o.provider}:${o.id}` };
      return { text: T("pick.model"), title: "" };
    }
    function effortNow(s) {
      const e = effortChosen.get(s.sid);
      return e ? e.effort : effortKey(s.node && s.node.effort);
    }

    // ------------------------------------------------------------ chips
    /** Show, hide and relabel the chips for the chat on screen. Cheap: nothing changes when nothing did. */
    function sync() {
      const s = ctx.session();
      if (!s) {
        if (open) close(false);
        bar.hidden = true;
        lastKey = "";
        return;
      }
      if (open && (openSid !== s.sid || openKey !== s.key || (open === "model" && s.switchDisabled))) close(false);
      settle(s);
      const m = modelText(s);
      const e = effortNow(s);
      const key = [s.sid, m.text, m.title, e, s.switchDisabled, busy.has(`${s.sid}:model`), busy.has(`${s.sid}:effort`), open, T("pick.modelTip")].join("|"); // last: the language
      bar.hidden = false;
      if (key === lastKey) return;
      lastKey = key;
      modelLabel.textContent = m.text;
      modelChip.disabled = !!s.switchDisabled;
      modelChip.title = s.switchDisabled || (m.title ? `${m.title} · ${T("pick.modelTip")}` : T("pick.modelTip"));
      modelChip.classList.toggle("busy", busy.has(`${s.sid}:model`) || !!chosen.get(s.sid)?.pending);
      modelChip.setAttribute("aria-expanded", open === "model" ? "true" : "false");
      effortLabel.textContent = T(`pick.effort.${e || "default"}`);
      effortChip.title = s.switchDisabled || T(effortChosen.get(s.sid)?.pending ? "pick.pending" : "pick.effortTip");
      effortChip.classList.toggle("busy", busy.has(`${s.sid}:effort`) || !!effortChosen.get(s.sid)?.pending);
      effortChip.setAttribute("aria-expanded", open === "effort" ? "true" : "false");
    }
    const resync = () => {
      lastKey = "";
      sync();
    };

    // ------------------------------------------------------------ popover
    function toggle(kind) {
      if (open === kind) close(true);
      else openPop(kind);
    }

    function openPop(kind) {
      const s = ctx.session();
      if (!s || (kind === "model" && s.switchDisabled)) return;
      if (open) close(false);
      open = kind;
      openSid = s.sid;
      openKey = s.key;
      candidate = null;
      loadError = null;
      if (kind === "model") {
        query = "";
        groupOpen.clear();
        showAll.clear();
      }
      load(s); // refreshed on every open; a cached list paints at once meanwhile
      pop.className = `pick-pop pick-pop-${kind}`;
      pop.hidden = false;
      render();
      resync();
      requestAnimationFrame(() => {
        if (open !== kind) return;
        const target = kind === "model" ? shell && (s.telegram && !s.inventory ? shell.custom : shell.search) : pop.querySelector('.pick-item[aria-checked="true"]:not(:disabled)') || pop.querySelector(".pick-item:not(:disabled)");
        if (target) target.focus({ preventScroll: true });
      });
    }

    function close(returnFocus) {
      if (!open) return;
      const was = open;
      open = null;
      openSid = null;
      openKey = null;
      candidate = null;
      confirm = null;
      shell = null;
      pop.hidden = true;
      pop.replaceChildren();
      if (returnFocus) (was === "effort" ? effortChip : modelChip).focus({ preventScroll: true });
      resync();
    }

    function load(s) {
      if (s.switchDisabled || (s.telegram && !s.inventory) || loading.has(s.sid)) return;
      loading.add(s.sid);
      bridge.modelOptions(s.sid, { profile: s.profile, ...(s.telegram ? { profileOnly: true } : {}) })
        .then((data) => {
          cache.set(s.sid, data);
          if (openSid === s.sid) loadError = null;
        })
        .catch((e) => {
          if (openSid === s.sid) loadError = T("pick.loadFailed", { e: ctx.cleanErr(e) });
        })
        .finally(() => {
          loading.delete(s.sid);
          if (open && openSid === s.sid) open === "model" ? renderList() : render();
          resync();
        });
    }

    function render() {
      if (open === "model") renderModel();
      else if (open === "effort") renderEffort();
    }

    // ------------------------------------------------------------ model popover
    /** The fixed parts (search, custom id) are built once per open; typing re-renders only the list. */
    function renderModel() {
      const search = h("input", {
        class: "pick-search pick-nav", type: "text", value: query, spellcheck: "false", autocomplete: "off",
        placeholder: T("pick.search"), "aria-label": T("pick.search"),
        oninput: (e) => {
          query = e.target.value;
          clear.hidden = !query;
          renderList();
        },
        onkeydown: (e) => {
          if (e.key === "Enter" && !e.isComposing) {
            e.preventDefault();
            if (ctx.session()?.telegram && candidate) apply(candidate, false);
            else {
              const first = list.querySelector(".pick-row");
              if (first) first.click();
            }
          }
        },
      });
      const clear = h("button", {
        class: "pick-clear", type: "button", hidden: !query, title: T("pick.clear"), "aria-label": T("pick.clear"),
        onclick: () => {
          query = "";
          search.value = "";
          clear.hidden = true;
          renderList();
          search.focus({ preventScroll: true });
        },
      }, icon("x"));
      const list = h("div", { class: "pick-list", role: "listbox", "aria-label": T("pick.model") });
      const custom = h("input", {
        class: "pick-custom-in pick-nav", type: "text", spellcheck: "false", autocomplete: "off",
        placeholder: T("pick.customPh"), "aria-label": T("pick.custom"),
        onkeydown: (e) => {
          if (e.key === "Enter" && !e.isComposing) {
            e.preventDefault();
            useCustom(true);
          }
        },
      });
      const add = h("button", { class: "pick-add pick-nav", type: "button", title: T("pick.customUse"), "aria-label": T("pick.customUse"), onclick: () => useCustom() }, icon("plus"));
      const status = h("p", { class: "pick-status", role: "status" });
      const change = ctx.session()?.telegram ? h("button", {
        class: "btn primary pick-change pick-nav", type: "button", disabled: true,
        onclick: () => apply(candidate, false),
      }, T("pick.changeModel")) : null;
      shell = { search, list, custom, status, change };
      const inventory = !ctx.session()?.telegram || ctx.session().inventory;
      // native replaceChildren turns null into a "null" text node: pass only real parts
      pop.replaceChildren(...[
        inventory ? h("div", { class: "pick-searchrow" }, search, clear) : null,
        ctx.session()?.telegram ? null : h("p", { class: "pick-scope" }, T("pick.scope")),
        status,
        inventory ? list : null,
        h("div", { class: "pick-customrow" }, custom, add),
        change ? h("div", { class: "pick-actions" }, change) : null].filter(Boolean));
      renderList();
    }

    function useCustom(submit = false) {
      if (!shell) return;
      const data = dataOf(openSid);
      const slugs = new Set(((data && data.options) || []).map((o) => o.provider));
      const sel = selectedOf(openSid);
      const c = parseCustom(shell.custom.value, slugs, sel ? sel.provider : "");
      if (!c) {
        shell.status.textContent = T("pick.customBad");
        shell.status.className = "pick-status bad";
        shell.custom.focus({ preventScroll: true });
        return;
      }
      const known = data && data.options.find((o) => o.provider === c.provider && o.id === c.model);
      const o = known || { id: c.model, provider: c.provider, providerName: c.provider };
      if (ctx.session()?.telegram) { select(o); if (submit) apply(o, false); }
      else apply(o, false);
    }

    function select(o) {
      if (!ctx.session()?.telegram) return apply(o, false);
      candidate = o;
      renderList();
      shell?.change?.focus({ preventScroll: true });
    }

    function row(o, sel) {
      const on = !!sel && sel.provider === o.provider && sel.model === o.id;
      return h("button", {
        class: `pick-row pick-nav${on ? " on" : ""}`, type: "button", role: "option", "aria-selected": on ? "true" : "false",
        title: `@${o.provider}:${o.id}`, onclick: () => select(o),
      },
      h("span", { class: "pick-row-top" }, h("span", { class: "pick-name" }, shortName(o.id)), on ? h("span", { class: "pick-badge" }, T("pick.selected")) : null),
      h("span", { class: "pick-id" }, `@${o.provider}:${o.id}`));
    }

    function renderList() {
      if (!shell || open !== "model") return;
      const { list, status } = shell;
      const data = dataOf(openSid);
      const current = selectedOf(openSid);
      const sel = candidate ? { provider: candidate.provider, model: candidate.id } : current;
      if (shell.change) shell.change.disabled = !candidate || busy.has(`${openSid}:model`);
      status.className = `pick-status${loadError || confirm ? " bad" : ""}`;
      status.replaceChildren();
      if (confirm) {
        const c = confirm;
        status.append(h("span", null, c.message),
          h("span", { class: "pick-confirm" },
            h("button", { class: "btn mini danger pick-nav", type: "button", onclick: () => apply(c.option, true) }, T("pick.confirm")),
            h("button", { class: "btn mini pick-nav", type: "button", onclick: () => { confirm = null; renderList(); } }, T("pick.cancel"))));
      } else if (loadError) status.textContent = loadError;
      if (!data) {
        list.replaceChildren(ctx.session()?.telegram && !ctx.session().inventory ? [] :
          h("p", { class: "pick-empty" }, T(loadError ? "pick.none" : "pick.loading")));
        return;
      }
      const searching = !!query.trim();
      const groups = buildGroups(data.options, { query, currentProvider: data.current && data.current.provider });
      const kids = [];
      // a custom id picked here may not be in any list: it is still what the session runs next
      const cur = !searching && current && (optionOf(openSid) || { id: current.model, provider: current.provider, providerName: current.provider });
      if (cur) kids.push(h("div", { class: "pick-sec" }, T("pick.current")), row(cur, sel));
      let drawn = 0;
      for (const g of groups) {
        const isOpen = searching || (groupOpen.has(g.provider) ? groupOpen.get(g.provider) : g.current || groups.length === 1);
        kids.push(h("button", {
          class: `pick-group pick-nav${isOpen ? " open" : ""}`, type: "button", "aria-expanded": isOpen ? "true" : "false", dataset: { provider: g.provider },
          onclick: () => {
            groupOpen.set(g.provider, !isOpen);
            renderList();
            refocus(".pick-group", g.provider);
          },
        }, icon("chev"), h("span", { class: "pick-gname" }, g.name), h("span", { class: "pick-count" }, String(g.models.length))));
        if (!isOpen) continue;
        const cap = searching ? Math.max(0, SEARCH_MAX - drawn) : showAll.has(g.provider) ? Infinity : ROWS_PER_GROUP;
        const shown = g.models.slice(0, cap);
        drawn += shown.length;
        for (const o of shown) kids.push(row(o, sel));
        if (!searching && shown.length < g.models.length) {
          kids.push(h("button", { class: "pick-more pick-nav", type: "button", onclick: () => { showAll.add(g.provider); renderList(); refocus(".pick-group", g.provider); } }, T("pick.showAll", { n: g.models.length })));
        }
      }
      if (searching && !groups.length) kids.push(h("p", { class: "pick-empty" }, T("pick.noMatch")));
      else if (!data.options.length) kids.push(h("p", { class: "pick-empty" }, T("pick.none")));
      list.replaceChildren(...kids);
    }

    /** After a list re-render, keep the keyboard on the group header that was used. */
    function refocus(selector, provider) {
      if (!shell) return;
      const el = [...shell.list.querySelectorAll(selector)].find((x) => x.dataset.provider === provider);
      if (el) el.focus({ preventScroll: true });
    }

    /** Pick a model: the chip shows it at once; Hermes switches the session (now, or at the next turn). */
    async function apply(o, confirmed) {
      const s = ctx.session();
      if (!s || s.sid !== openSid || s.key !== openKey || s.switchDisabled || !o || busy.has(`${s.sid}:model`)) return;
      const sid = s.sid;
      const before = chosen.get(sid);
      chosen.set(sid, { provider: o.provider, model: o.id, was: (s.node && s.node.model) || "",
        ...(s.telegram ? { pending: true, key: s.key } : {}) });
      confirm = null;
      busy.add(`${sid}:model`);
      close(true);
      try {
        if (s.telegram) {
          if (!await ctx.sendCommand(modelCommand(o, s.bot), s.key)) throw new Error(T("pick.sendFailed"));
          return; // Delivery is not a model-switch receipt; the bot's reply remains authoritative.
        }
        const r = await bridge.setModel(sid, { model: o.id, provider: o.provider, confirm: confirmed, profile: s.profile });
        if (r.confirmRequired) {
          if (before) chosen.set(sid, before);
          else chosen.delete(sid);
          busy.delete(`${sid}:model`);
          const now = ctx.session();
          if (now && now.sid === sid) {
            openPop("model");
            confirm = { option: o, message: r.message || T("pick.confirmAsk") };
            renderList();
          }
          return;
        }
        if (r.warning) ctx.note(r.warning, false);
      } catch (e) {
        if (before) chosen.set(sid, before);
        else chosen.delete(sid);
        ctx.note(T("pick.failed", { e: failure(e) }), true);
      } finally {
        busy.delete(`${sid}:model`);
        resync();
      }
    }

    // ------------------------------------------------------------ reasoning popover
    function renderEffort() {
      const s = ctx.session();
      if (!s) return;
      const now = effortNow(s);
      const o = optionOf(s.sid);
      const levels = o ? effortsFor(o) : EFFORTS.slice();
      const item = (e) => h("button", {
        class: `pick-item pick-nav${e === now ? " on" : ""}`, type: "button", role: "menuitemradio", "aria-checked": e === now ? "true" : "false",
        disabled: !!s.switchDisabled, title: s.switchDisabled || "",
        onclick: () => applyEffort(e),
      }, T(`pick.effort.${e}`));
      const showing = ctx.thinking.isOpen();
      const thinking = h("button", {
        class: `pick-item pick-toggle pick-nav${showing ? " on" : ""}`, type: "button", role: "menuitemcheckbox", "aria-checked": showing ? "true" : "false",
        onclick: () => {
          ctx.thinking.setOpen(!ctx.thinking.isOpen());
          renderEffort();
          const t = pop.querySelector(".pick-toggle");
          if (t) t.focus({ preventScroll: true });
        },
      }, h("span", null, T("live.showThinking")), h("span", { class: "pick-switch", "aria-hidden": "true" }));
      pop.replaceChildren(h("div", { class: "pick-menu", role: "menu", "aria-label": T("pick.effortTip") },
        levels.length ? levels.map(item) : h("p", { class: "pick-empty" }, T("pick.noEffort")),
        h("div", { class: "pick-sep", role: "separator" }),
        thinking));
    }

    /** The chip shows the level at once; Hermes keeps it for this session only. */
    async function applyEffort(effort) {
      const s = ctx.session();
      if (!s || s.sid !== openSid || s.key !== openKey || s.switchDisabled || busy.has(`${s.sid}:effort`)) return;
      const sid = s.sid;
      const before = effortChosen.get(sid);
      effortChosen.set(sid, { effort, was: (s.node && s.node.effort) || "",
        ...(s.telegram ? { pending: true, key: s.key } : {}) });
      busy.add(`${sid}:effort`);
      close(true);
      try {
        if (s.telegram) {
          if (!await ctx.sendCommand(reasoningCommand(effort, s.bot), s.key)) throw new Error(T("pick.sendFailed"));
        } else await bridge.setEffort(sid, { effort, profile: s.profile });
      } catch (e) {
        if (before) effortChosen.set(sid, before);
        else effortChosen.delete(sid);
        ctx.note(T("pick.effortFailed", { e: failure(e) }), true);
      } finally {
        busy.delete(`${sid}:effort`);
        resync();
      }
    }

    // ------------------------------------------------------------ keyboard and dismissal
    function onPopKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (confirm) {
          confirm = null;
          renderList();
        } else close(true);
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const all = [...pop.querySelectorAll(".pick-nav, .pick-item")].filter((el) => !el.disabled && el.offsetParent !== null);
      if (!all.length) return;
      e.preventDefault();
      const at = all.indexOf(document.activeElement);
      const next = e.key === "ArrowDown" ? (at + 1) % all.length : (at - 1 + all.length) % all.length;
      all[at < 0 ? 0 : next].focus({ preventScroll: false });
    }
    function onPopBlur(e) {
      const to = e.relatedTarget;
      if (!to) return; // a click on empty popover space, or the window lost focus
      if (pop.contains(to) || bar.contains(to)) return;
      close(false);
    }
    document.addEventListener("pointerdown", (e) => {
      if (open && !pop.contains(e.target) && !bar.contains(e.target)) close(false);
    }, true);

    /**
     * The bot answered in the chat a command was sent to. The session's own report (the snapshot node) only moves
     * at its next turn, so a reply that names the picked value keeps the pick on the chip (no longer pending) until
     * the node catches up (settle); any other reply (an error, a refusal) drops the pick and the chip shows the node.
     */
    function telegramReply(key, text = "") {
      const said = String(text || "").toLowerCase();
      for (const [sid, c] of chosen) {
        if (!c.pending || c.key !== key) continue;
        if (said.includes(String(c.model).toLowerCase())) chosen.set(sid, { ...c, pending: false });
        else chosen.delete(sid);
      }
      for (const [sid, e] of effortChosen) {
        if (!e.pending || e.key !== key) continue;
        if (said.includes(String(e.effort).toLowerCase())) effortChosen.set(sid, { ...e, pending: false });
        else effortChosen.delete(sid);
      }
      resync();
    }
    return { sync, close, telegramReply, isOpen: () => !!open, openModel: () => openPop("model") };
  }

  const api = { EFFORTS, shortName, matches, buildGroups, currentOption, effortsFor, effortKey, parseCustom, modelCommand, reasoningCommand, ROWS_PER_GROUP, SEARCH_MAX, create: typeof create === "function" ? create : null };
  if (typeof window !== "undefined") window.DeckModelPicker = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
