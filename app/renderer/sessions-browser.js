"use strict";
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
var i18nLocale = typeof module === "object" && module.exports ? require("./i18n").getLocale : window.DeckI18n.getLocale;
// The session browser: every stored Hermes session of every platform and profile in one searchable list, with
// open, rename, pin, archive, delete and bulk actions. It is an overlay over the chat column (the rail keeps its
// live work as it is) and reads only through deck.bridge.sessionIndex (main/bridge.js: deck.session_index per
// profile, merged, cached). Hermes owns the data: a row only ever shows an id Hermes returned.
//
// A session a messaging platform owns (Telegram, Discord, ...) opens read-only: a message sent from here continues
// it in a COPY (session.branch_stored), so the Deck never writes into a chat that its gateway is serving.
// The pure helpers at the top are exported for test/sessions-browser.test.js.
(() => {
  const SOURCES = ["telegram", "discord", "webui", "tui", "deck", "desktop", "cli", "ios", "other"];
  // sessions Hermes' own surfaces keep: continuing one from here is what its TUI/Desktop resume does as well
  const DIRECT = new Set(["tui", "cli", "desktop", "deck", "webui"]);
  const SHOWN_STEP = 150; // rows drawn at once; the rest sit behind "Show more" (keeps a 400-row list light)
  const REFRESH_MS = 60000;

  // ---------------------------------------------------------------- pure helpers

  /** One of SOURCES for a Hermes `source` string; anything unknown is "other". */
  function sourceKey(source) {
    const s = String(source || "").trim().toLowerCase();
    return SOURCES.includes(s) ? s : "other";
  }

  /** True when the row belongs to something other than the Deck-adjacent surfaces: continue it in a copy. */
  const needsCopy = (source) => !DIRECT.has(String(source || "").trim().toLowerCase());

  const rowKey = (r) => `${r.profile}\u0000${r.id}`;
  const fkOf = (r) => `sb:${r.profile}:${r.id}`;

  /** Newest first; a tie falls back to the start time, then the id (a stable order between refreshes). */
  function sortRows(rows) {
    return [...rows].sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0) || (b.startedAt || 0) - (a.startedAt || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Rows matching the search words (all of them, in title, preview or id), the platforms and the profile. */
  function filterRows(rows, { q = "", sources = null, profile = "" } = {}) {
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter((r) => {
      if (profile && r.profile !== profile) return false;
      if (sources && sources.size && !sources.has(sourceKey(r.source))) return false;
      if (!words.length) return true;
      const hay = `${r.title}\n${r.preview}\n${r.lastPreview || ""}\n${r.id}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  /** How many rows each platform has (before the platform filter, so the chips stay meaningful). */
  function countBySource(rows) {
    const out = new Map();
    for (const r of rows) out.set(sourceKey(r.source), (out.get(sourceKey(r.source)) || 0) + 1);
    return out;
  }

  const pad = (n) => String(n).padStart(2, "0");
  const dayOf = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  /**
   * Pinned rows first (one group), then one group per local day, newest first:
   * [{kind: "pinned" | "today" | "yesterday" | "day", ts, rows}].
   */
  function groupRows(rows, nowMs = Date.now(), { pinned = true } = {}) {
    const sorted = sortRows(rows);
    const groups = [];
    const pins = pinned ? sorted.filter((r) => r.pinned) : [];
    if (pins.length) groups.push({ kind: "pinned", ts: 0, rows: pins });
    const today = dayOf(nowMs);
    const yesterday = dayOf(nowMs - 86400000);
    let cur = null;
    for (const r of sorted) {
      if (pinned && r.pinned) continue;
      const ms = (r.lastActive || r.startedAt || 0) * 1000;
      const key = dayOf(ms);
      if (!cur || cur.key !== key) {
        cur = { key, kind: key === today ? "today" : key === yesterday ? "yesterday" : "day", ts: ms, rows: [] };
        groups.push(cur);
      }
      cur.rows.push(r);
    }
    return groups.map(({ kind, ts, rows: list }) => ({ kind, ts, rows: list }));
  }

  /** Row `i` moved by `delta` inside [0, n); Home/End as -Infinity/Infinity. */
  const moveIndex = (i, delta, n) => (n <= 0 ? -1 : Math.max(0, Math.min(n - 1, delta === -Infinity ? 0 : delta === Infinity ? n - 1 : (i < 0 ? 0 : i + delta))));

  // ---------------------------------------------------------------- the view

  function create(d) {
    const { h, deck, mark, ago, cleanErr, nodeLive, bridgeOpen, hermesMode, hermesOpen, hermesForget, MV } = d;
    const B = {
      open: false,
      view: "active", // "active" | "archived"
      q: "",
      sources: new Set(),
      profile: "",
      data: { active: null, archived: null }, // {rows, profiles, legacy, at} per view
      loading: false,
      error: "",
      selected: new Map(), // rowKey -> row
      anchor: null, // rowKey a shift-click range starts from
      cursor: null, // rowKey the keyboard is on
      shown: SHOWN_STEP,
      busy: false, // a bulk action is running (the browser stays open meanwhile, even when a deleted chat was open)
      timer: null,
    };
    const copyOnly = new Set(); // ids opened read-only here: the next send branches them first
    let root = null;
    let parts = null;
    let visible = []; // the rows drawn, in order
    let entryEl = null;

    const L = (k, v) => i18nText(`sessions.${k}`, v);
    const dataNow = () => B.data[B.view];
    const allRows = () => (dataNow() ? dataNow().rows : []);
    const profileCount = () => new Set(allRows().map((r) => r.profile)).size;

    // ------------------------------------------------------------ building the shell once

    function build() {
      const keep = parts ? parts.search.value : B.q;
      const search = h("input", { class: "sb-search", type: "search", placeholder: L("search"), "aria-label": L("searchLabel"), autocomplete: "off", spellcheck: "false", dataset: { fk: "sb-search" } });
      search.value = keep;
      search.addEventListener("input", () => {
        B.q = search.value;
        B.shown = SHOWN_STEP;
        renderList();
        renderChips();
      });
      search.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          focusList();
        } else if (e.key === "Escape" && search.value) {
          e.preventDefault();
          e.stopPropagation();
          search.value = "";
          B.q = "";
          renderList();
          renderChips();
        }
      });
      const viewBtn = (id) => h("button", { type: "button", "aria-pressed": B.view === id ? "true" : "false", dataset: { fk: `sb-view:${id}` }, onclick: () => setView(id) }, L(`view.${id}`));
      const views = h("span", { class: "chan sb-views", role: "group", "aria-label": L("view") }, viewBtn("active"), viewBtn("archived"));
      const profile = h("select", { class: "sb-profile", "aria-label": L("profile"), dataset: { fk: "sb-profile" } });
      profile.addEventListener("change", () => {
        B.profile = profile.value;
        B.shown = SHOWN_STEP;
        renderList();
        renderChips();
      });
      const refresh = h("button", { class: "sb-iconbtn", type: "button", title: L("refresh"), "aria-label": L("refresh"), dataset: { fk: "sb-refresh" }, onclick: () => load(true) }, refreshIcon());
      const back = h("button", { class: "linkbtn sb-back", type: "button", dataset: { fk: "sb-back" }, onclick: () => close() }, `‹ ${L("back")}`);
      const count = h("span", { class: "sb-count", "aria-live": "polite" });
      const chips = h("div", { class: "sb-chips", role: "group", "aria-label": L("platforms") });
      const notes = h("div", { class: "sb-notes" });
      const list = h("div", { class: "sb-list", role: "listbox", "aria-multiselectable": "true", "aria-label": L("title"), tabindex: "0", dataset: { fk: "sb-list" } });
      const bulk = h("div", { class: "sb-bulk", role: "toolbar", "aria-label": L("bulkLabel"), hidden: true });
      const keys = h("p", { class: "sb-keys" }, L("keys"));
      list.addEventListener("click", onListClick);
      list.addEventListener("contextmenu", onListContext);
      list.addEventListener("keydown", onListKey);
      list.addEventListener("focus", () => {
        if (!B.cursor && visible.length) setCursor(rowKey(visible[0]), false);
        else markCursor();
      });
      const head = h("header", { class: "sb-head" }, back, h("h2", { class: "sb-title" }, L("title")), count, h("span", { class: "sb-grow" }), refresh);
      const tools = h("div", { class: "sb-tools" }, search, profile, views);
      const next = h("section", { class: "sb", role: "region", "aria-label": L("title"), hidden: !B.open, dataset: { fk: "sb" } }, head, tools, chips, notes, list, bulk, keys);
      next.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".cd-back") && !document.querySelector(".ctx")) {
          e.preventDefault();
          close();
        } else if ((e.key === "/" && e.target !== search) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f")) {
          e.preventDefault();
          search.focus();
          search.select();
        }
      });
      parts = { search, profile, views, count, chips, notes, list, bulk, back };
      if (root && root.parentNode) root.replaceWith(next);
      root = next;
    }

    const refreshIcon = () => {
      const NS = "http://www.w3.org/2000/svg";
      const s = document.createElementNS(NS, "svg");
      for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", width: "14", height: "14", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) s.setAttribute(k, v);
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", "M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3");
      s.appendChild(p);
      return s;
    };

    // ------------------------------------------------------------ rendering

    function view() {
      const rows = allRows();
      const base = filterRows(rows, { q: B.q, profile: B.profile });
      return { base, rows: filterRows(base, { sources: B.sources }) };
    }

    function renderAll() {
      if (!root) return;
      renderProfiles();
      renderChips();
      renderNotes();
      renderList();
    }

    function renderProfiles() {
      const names = dataNow() ? dataNow().profiles.map((p) => p.name) : [];
      if (B.profile && !names.includes(B.profile)) B.profile = "";
      parts.profile.replaceChildren(h("option", { value: "" }, L("allProfiles")), ...names.map((n) => h("option", { value: n }, n)));
      parts.profile.value = B.profile;
      parts.profile.hidden = names.length < 2;
    }

    function renderChips() {
      if (!root) return;
      const counts = countBySource(view().base);
      const chips = SOURCES.filter((s) => counts.get(s) || B.sources.has(s)).map((s) =>
        h("button", { class: `sb-chip src-${s}`, type: "button", "aria-pressed": B.sources.has(s) ? "true" : "false", dataset: { fk: `sb-chip:${s}` }, onclick: () => toggleSource(s) },
          h("span", { class: "sb-dot", "aria-hidden": "true" }), L(`src.${s}`), h("span", { class: "sb-n" }, String(counts.get(s) || 0)))
      );
      parts.chips.replaceChildren(...chips);
      parts.chips.hidden = !chips.length;
      for (const b of parts.views.children) b.setAttribute("aria-pressed", b.dataset.fk === `sb-view:${B.view}` ? "true" : "false");
    }

    function renderNotes() {
      const data = dataNow();
      const notes = [];
      if (B.error) notes.push(h("p", { class: "sb-note bad", role: "alert" }, L("loadError", { e: B.error })));
      if (data) {
        const failed = data.profiles.filter((p) => !p.ok).map((p) => p.name);
        if (failed.length) notes.push(h("p", { class: "sb-note warn" }, L("profileError", { profiles: failed.join(", ") })));
        const more = data.profiles.filter((p) => p.ok && p.hasMore).map((p) => p.name);
        if (more.length) notes.push(h("p", { class: "sb-note" }, L("more", { profiles: more.join(", ") })));
        if (data.legacy) notes.push(h("p", { class: "sb-note warn" }, L("legacy")));
      }
      parts.notes.replaceChildren(...notes);
      parts.notes.hidden = !notes.length;
    }

    function dayLabel(g) {
      if (g.kind === "pinned") return L("pinned");
      if (g.kind === "today") return L("today");
      if (g.kind === "yesterday") return L("yesterday");
      const d0 = new Date(g.ts);
      const sameYear = d0.getFullYear() === new Date().getFullYear();
      return d0.toLocaleDateString(i18nLocale(), sameYear ? { weekday: "short", day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" });
    }

    function renderList() {
      if (!root) return;
      const { rows } = view();
      const total = allRows().length;
      parts.count.textContent = dataNow() ? L("count", { shown: rows.length, total }) : "";
      const prune = new Set(rows.map(rowKey));
      for (const k of [...B.selected.keys()]) if (!prune.has(k)) B.selected.delete(k);
      const groups = groupRows(rows, Date.now(), { pinned: B.view === "active" });
      visible = [];
      const kids = [];
      let drawn = 0;
      const many = profileCount() > 1;
      for (const g of groups) {
        if (drawn >= B.shown) break;
        const take = g.rows.slice(0, B.shown - drawn);
        drawn += take.length;
        kids.push(h("div", { class: `sb-day${g.kind === "pinned" ? " pin" : ""}`, role: "presentation" }, dayLabel(g), h("span", { class: "sb-day-n" }, String(g.rows.length))));
        for (const r of take) {
          visible.push(r);
          kids.push(rowEl(r, many));
        }
      }
      if (rows.length > drawn) {
        kids.push(h("button", { class: "linkbtn sb-more", type: "button", dataset: { fk: "sb-more" }, onclick: () => { B.shown += SHOWN_STEP; renderList(); } }, L("showMore", { n: Math.min(SHOWN_STEP, rows.length - drawn) })));
      }
      if (!rows.length) kids.push(emptyEl(total));
      parts.list.replaceChildren(...kids);
      if (B.cursor && !visible.some((r) => rowKey(r) === B.cursor)) B.cursor = null;
      markCursor();
      renderBulk();
    }

    function emptyEl(total) {
      if (B.loading && !dataNow()) return h("p", { class: "sb-empty", role: "status" }, L("loading"));
      if (!bridgeOpen() && !dataNow()) return h("p", { class: "sb-empty" }, L("offline"));
      if (!dataNow()) return h("p", { class: "sb-empty" }, B.error ? "" : L("loading"));
      if (!total) return h("p", { class: "sb-empty" }, B.view === "archived" ? L("archivedEmpty") : L("empty"));
      return h("div", { class: "sb-empty" }, h("p", null, L("noMatch")), h("button", { class: "btn", type: "button", onclick: clearFilters }, L("clearFilters")));
    }

    function rowEl(r, showProfile) {
      const k = rowKey(r);
      const on = B.selected.has(k);
      const live = !!(d.H().nodes.get(r.id) && nodeLive(d.H().nodes.get(r.id)));
      const title = displayTitle(r);
      const check = h("input", { class: "sb-check", type: "checkbox", tabindex: "-1", "aria-label": L("select", { title }) });
      check.checked = on;
      const key = sourceKey(r.source);
      return h("div", { class: `sb-row${on ? " on" : ""}`, role: "option", id: optId(r), "aria-selected": on ? "true" : "false", dataset: { fk: fkOf(r), k }, title: `${title}\n${r.id}` },
        h("span", { class: "sb-cell" }, check),
        h("span", { class: `sb-src src-${key}` }, h("span", { class: "sb-dot", "aria-hidden": "true" }), key === "other" && r.source ? r.source.slice(0, 12) : L(`src.${key}`)),
        h("span", { class: "sb-main" }, h("span", { class: "sb-name" }, live ? h("span", { class: "sb-live", title: L("live"), "aria-label": L("live") }) : null, title), (r.lastPreview || r.preview) ? h("span", { class: "sb-prev" }, r.lastPreview || r.preview) : null),
        h("span", { class: "sb-meta" }, showProfile ? h("span", { class: "sb-prof" }, r.profile) : null, h("span", { class: "sb-time" }, r.lastActive ? ago(r.lastActive) : ""), h("span", { class: "sb-msgs" }, L("messages", { n: r.messages })))
      );
    }

    let optSeq = 0;
    const optIds = new Map();
    const optId = (r) => {
      const k = rowKey(r);
      if (!optIds.has(k)) optIds.set(k, `sb-opt-${++optSeq}`);
      return optIds.get(k);
    };
    const displayTitle = (r) => r.title || r.preview.slice(0, 80) || `${L("untitled")} · ${r.id.slice(-8)}`;

    function renderBulk() {
      const n = B.selected.size;
      parts.bulk.hidden = !n;
      if (!n) return parts.bulk.replaceChildren();
      const archived = B.view === "archived";
      parts.bulk.replaceChildren(
        h("span", { class: "sb-bulk-n", "aria-live": "polite" }, L("selected", { n })),
        h("button", { class: "btn", type: "button", disabled: B.busy, onclick: selectAllShown }, L("selectAll")),
        h("span", { class: "sb-grow" }),
        h("button", { class: "btn", type: "button", disabled: B.busy, dataset: { fk: "sb-bulk-archive" }, onclick: () => archiveMany([...B.selected.values()], !archived) }, L(archived ? "menu.unarchive" : "menu.archive")),
        h("button", { class: "btn danger", type: "button", disabled: B.busy, dataset: { fk: "sb-bulk-delete" }, onclick: () => deleteMany([...B.selected.values()]) }, L("menu.delete")),
        h("button", { class: "btn", type: "button", disabled: B.busy, onclick: clearSelection }, L("clearSelection"))
      );
    }

    // ------------------------------------------------------------ cursor and selection

    const rowByKey = (k) => visible.find((r) => rowKey(r) === k) || null;
    const elOf = (k) => {
      for (const el of parts.list.children) if (el.dataset && el.dataset.k === k) return el;
      return null;
    };

    function markCursor() {
      if (!parts) return;
      for (const el of parts.list.children) if (el.classList && el.dataset.k) el.classList.toggle("cur", el.dataset.k === B.cursor);
      const el = B.cursor ? elOf(B.cursor) : null;
      if (el) parts.list.setAttribute("aria-activedescendant", el.id);
      else parts.list.removeAttribute("aria-activedescendant");
    }

    function setCursor(k, scroll = true) {
      B.cursor = k;
      markCursor();
      const el = k ? elOf(k) : null;
      if (scroll && el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
    }

    const focusList = () => {
      parts.list.focus();
      if (!B.cursor && visible.length) setCursor(rowKey(visible[0]));
    };

    function toggleSelect(r, force) {
      const k = rowKey(r);
      const on = force === undefined ? !B.selected.has(k) : force;
      if (on) B.selected.set(k, r);
      else B.selected.delete(k);
      B.anchor = k;
      syncSelection();
    }

    function selectRange(r) {
      const from = visible.findIndex((x) => rowKey(x) === (B.anchor || B.cursor));
      const to = visible.findIndex((x) => rowKey(x) === rowKey(r));
      if (from < 0 || to < 0) return toggleSelect(r, true);
      for (const x of visible.slice(Math.min(from, to), Math.max(from, to) + 1)) B.selected.set(rowKey(x), x);
      syncSelection();
    }

    function syncSelection() {
      for (const el of parts.list.children) {
        if (!el.dataset || !el.dataset.k) continue;
        const on = B.selected.has(el.dataset.k);
        el.classList.toggle("on", on);
        el.setAttribute("aria-selected", on ? "true" : "false");
        const box = el.children[0] && el.children[0].children[0];
        if (box) box.checked = on;
      }
      parts.list.classList.toggle("selecting", B.selected.size > 0);
      renderBulk();
    }

    const selectAllShown = () => {
      for (const r of visible) B.selected.set(rowKey(r), r);
      syncSelection();
    };
    const clearSelection = () => {
      B.selected.clear();
      syncSelection();
    };

    function clearFilters() {
      B.q = "";
      B.sources.clear();
      B.profile = "";
      parts.search.value = "";
      parts.profile.value = "";
      renderList();
      renderChips();
    }

    function toggleSource(s) {
      if (B.sources.has(s)) B.sources.delete(s);
      else B.sources.add(s);
      B.shown = SHOWN_STEP;
      renderChips();
      renderList();
    }

    function setView(v) {
      if (B.view === v) return;
      B.view = v;
      B.selected.clear();
      B.cursor = null;
      B.shown = SHOWN_STEP;
      B.error = "";
      renderAll();
      load(false);
    }

    // ------------------------------------------------------------ pointer and keyboard

    const rowOf = (e) => {
      const el = e.target && e.target.closest ? e.target.closest("[role=option]") : null;
      return el ? rowByKey(el.dataset.k) : null;
    };

    function onListClick(e) {
      const r = rowOf(e);
      if (!r) return;
      setCursor(rowKey(r), false);
      const onBox = e.target.classList && e.target.classList.contains("sb-check");
      if (e.shiftKey) selectRange(r);
      else if (onBox || e.ctrlKey || e.metaKey || B.selected.size) toggleSelect(r);
      else openRow(r);
    }

    function onListContext(e) {
      const r = rowOf(e);
      if (!r) return;
      e.preventDefault();
      setCursor(rowKey(r), false);
      menuFor(r, e.clientX === 0 && e.clientY === 0 ? null : { x: e.clientX, y: e.clientY });
    }

    function onListKey(e) {
      const i = visible.findIndex((r) => rowKey(r) === B.cursor);
      const cur = i >= 0 ? visible[i] : null;
      const go = (delta) => {
        e.preventDefault();
        const next = visible[moveIndex(i, delta, visible.length)];
        if (!next) return;
        setCursor(rowKey(next));
        if (e.shiftKey) selectRange(next);
      };
      if (e.key === "ArrowDown") go(1);
      else if (e.key === "ArrowUp") go(-1);
      else if (e.key === "PageDown") go(10);
      else if (e.key === "PageUp") go(-10);
      else if (e.key === "Home") go(-Infinity);
      else if (e.key === "End") go(Infinity);
      else if (e.key === "Enter" && cur) {
        e.preventDefault();
        if (B.selected.size) toggleSelect(cur);
        else openRow(cur);
      } else if (e.key === " " && cur) {
        e.preventDefault();
        toggleSelect(cur);
      } else if ((e.key === "a" || e.key === "A") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        selectAllShown();
      } else if (e.key === "F2" && cur) {
        e.preventDefault();
        renameRow(cur);
      } else if ((e.key === "Delete" || e.key === "Backspace") && (cur || B.selected.size)) {
        e.preventDefault();
        deleteMany(B.selected.size ? [...B.selected.values()] : [cur]);
      } else if ((e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) && cur) {
        e.preventDefault();
        menuFor(cur, null);
      } else if (e.key === "Escape" && B.selected.size) {
        e.preventDefault();
        e.stopPropagation();
        clearSelection();
      }
    }

    function menuFor(r, pos) {
      const el = elOf(rowKey(r));
      if (!el) return;
      const archived = B.view === "archived";
      const multi = B.selected.size > 1 && B.selected.has(rowKey(r));
      let items;
      if (multi) {
        const rows = [...B.selected.values()];
        items = [
          { label: L(archived ? "menu.unarchive" : "menu.archive"), noReturn: true, run: () => archiveMany(rows, !archived) },
          "-",
          { label: `${L("menu.delete")} (${rows.length})`, danger: true, noReturn: true, run: () => deleteMany(rows) },
        ];
      } else {
        items = [
          { label: L("menu.open"), noReturn: true, run: () => openRow(r) },
          { label: L("menu.rename"), noReturn: true, run: () => renameRow(r) },
          { label: L(r.pinned ? "menu.unpin" : "menu.pin"), enabled: !archived, run: () => pinRow(r) },
          { label: L(archived ? "menu.unarchive" : "menu.archive"), run: () => archiveMany([r], !archived) },
          { label: L("menu.copyId"), run: () => copyId(r) },
          "-",
          { label: L("menu.delete"), danger: true, noReturn: true, run: () => deleteMany([r]) },
        ];
      }
      MV.openMenu(items, el, pos, L("menuLabel", { title: displayTitle(r) }));
    }

    // ------------------------------------------------------------ actions

    function openRow(r) {
      if (!r || B.busy) return;
      close();
      d.H().titles.set(r.id, displayTitle(r));
      if (needsCopy(r.source)) {
        copyOnly.add(r.id);
        MV.toast(L("foreignNote", { source: sourceName(r.source) }));
      } else copyOnly.delete(r.id);
      hermesOpen(r.id, r.profile);
    }

    const sourceName = (s) => {
      const key = sourceKey(s);
      return key === "other" ? String(s || "").slice(0, 24) || L("src.other") : L(`src.${key}`);
    };

    /**
     * app.js hermesSend asks before a message goes out: a session opened read-only here is branched into a copy
     * and the copy's id is returned (and opened); every other id comes back unchanged.
     */
    async function beforeSend(sid, profile) {
      if (!copyOnly.has(sid)) return sid;
      const node = d.H().nodes.get(sid);
      if (node && nodeLive(node)) return sid; // already running here: not a plain stored chat any more
      MV.toast(L("branching"));
      const r = await deck.bridge.branchSession(sid, { profile: profile || "default" });
      copyOnly.delete(sid);
      d.H().titles.set(r.sid, d.H().titles.get(sid) || "");
      hermesOpen(r.sid, r.profile);
      return r.sid;
    }

    function dialog({ title, body, field, ok, danger }) {
      return new Promise((resolve) => {
        const back = document.activeElement;
        const err = h("p", { class: "form-error", role: "alert" });
        const input = field ? h("input", { class: "sb-input", type: "text", maxlength: "100", "aria-label": field.label, autocomplete: "off", spellcheck: "false" }) : null;
        if (input) input.value = field.value;
        const okBtn = h("button", { class: `btn ${danger ? "danger" : "primary"}`, type: "button", dataset: { fk: "sb-dialog-ok" } }, ok);
        const cancel = h("button", { class: "btn", type: "button" }, L("cancel"));
        const box = h("div", { class: "cd", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "sbd-title", "aria-describedby": "sbd-body" },
          h("h2", { id: "sbd-title" }, title), h("p", { id: "sbd-body" }, body),
          input ? h("label", { class: "sb-field" }, h("span", null, field.label), input) : null, err,
          h("div", { class: "form-actions" }, cancel, okBtn));
        const overlay = h("div", { class: "cd-back" }, box);
        let done = false;
        const finish = (value) => {
          if (done) return;
          done = true;
          overlay.remove();
          if (back && back.isConnected && typeof back.focus === "function") back.focus();
          resolve(value);
        };
        const submit = async () => {
          okBtn.disabled = cancel.disabled = true;
          err.textContent = "";
          try {
            const out = await (field && field.run ? field.run(input.value) : undefined);
            finish({ ok: true, value: out });
          } catch (e) {
            err.textContent = cleanErr(e);
            okBtn.disabled = cancel.disabled = false;
          }
        };
        cancel.addEventListener("click", () => finish(null));
        okBtn.addEventListener("click", () => (field && field.run ? submit() : finish({ ok: true })));
        overlay.addEventListener("click", (e) => { if (e.target === overlay && !okBtn.disabled) finish(null); });
        overlay.addEventListener("keydown", (e) => {
          if (e.key === "Escape" && !okBtn.disabled) { e.preventDefault(); e.stopPropagation(); finish(null); }
          else if (e.key === "Enter" && input && e.target === input && !okBtn.disabled) { e.preventDefault(); submit(); }
          else if (e.key === "Tab") {
            const order = [input, cancel, okBtn].filter(Boolean);
            const at = order.indexOf(document.activeElement);
            e.preventDefault();
            order[(at + (e.shiftKey ? -1 : 1) + order.length) % order.length].focus();
          }
        });
        document.body.appendChild(overlay);
        (input || cancel).focus(); // a delete starts on the safe answer
        if (input && typeof input.select === "function") input.select();
      });
    }

    async function renameRow(r) {
      if (B.busy) return;
      const res = await dialog({
        title: L("renameTitle"), body: "", ok: L("renameSave"),
        field: { label: L("renameLabel"), value: r.title, run: (v) => deck.bridge.renameSession(r.id, { profile: r.profile, title: v }) },
      });
      if (!res) return;
      r.title = (res.value && res.value.title) || r.title;
      d.H().titles.set(r.id, r.title);
      const n = d.H().nodes.get(r.id);
      if (n) n.title = r.title;
      MV.toast(L("renamedToast"));
      renderList();
      mark("rail", "head");
      load(true);
    }

    async function pinRow(r) {
      if (B.busy) return;
      try {
        const res = await deck.bridge.pinSession(r.id, { profile: r.profile, pinned: !r.pinned });
        r.pinned = res.pinned === true;
        MV.toast(L(r.pinned ? "pinnedToast" : "unpinnedToast"));
        renderList();
        load(true);
      } catch (e) {
        MV.toast(cleanErr(e), true);
      }
    }

    /** Runs `fn` for each row in turn; returns {ok: rows done, failed: [{row, error}]}. */
    async function each(rows, fn, progress) {
      B.busy = true;
      renderBulk();
      const ok = [];
      const failed = [];
      try {
        for (const r of rows) {
          try {
            await fn(r);
            ok.push(r);
          } catch (e) {
            failed.push({ row: r, error: e });
          }
          if (progress) progress(ok.length + failed.length);
        }
      } finally {
        B.busy = false;
      }
      return { ok, failed };
    }

    const dropRows = (rows) => {
      const gone = new Set(rows.map(rowKey));
      const data = dataNow();
      if (data) data.rows = data.rows.filter((r) => !gone.has(rowKey(r)));
      for (const k of gone) B.selected.delete(k);
    };

    const failNote = (failed) => {
      const first = failed.length ? failed[0].error : null;
      const text = first && /active session|running|çalış/i.test(String(first.message || first)) ? i18nText("session.deleteActive") : first ? cleanErr(first) : "";
      return text;
    };

    async function archiveMany(rows, archived) {
      if (B.busy || !rows.length) return;
      const { ok, failed } = await each(rows, (r) => deck.bridge.archiveSession(r.id, { profile: r.profile, archived }));
      dropRows(ok);
      renderList();
      if (ok.length) MV.toast(rows.length === 1 ? L(archived ? "archivedToast" : "unarchivedToast") : failed.length ? L("partial", { ok: ok.length, skipped: failed.length, why: failNote(failed) }) : L(archived ? "archivedMany" : "unarchivedMany", { n: ok.length }));
      else if (failed.length) MV.toast(failNote(failed), true);
      load(true);
    }

    async function deleteMany(rows) {
      if (B.busy || !rows.length) return;
      const one = rows.length === 1;
      const res = await dialog({
        title: one ? i18nText("session.deleteTitle") : L("deleteManyTitle", { n: rows.length }),
        body: one ? h("span", null, h("strong", null, displayTitle(rows[0])), i18nText("session.deleteBody")) : L("deleteManyBody"),
        ok: i18nText("session.delete"), danger: true,
        field: null,
      });
      if (!res) return;
      const results = await each(rows, async (r) => {
        await deck.bridge.deleteSession(r.id, { profile: r.profile });
        hermesForget(r.id);
        copyOnly.delete(r.id);
      });
      dropRows(results.ok);
      renderList();
      if (results.ok.length && !results.failed.length) MV.toast(one ? i18nText("session.deleted") : L("deletedMany", { n: results.ok.length }));
      else if (results.ok.length) MV.toast(L("partial", { ok: results.ok.length, skipped: results.failed.length, why: failNote(results.failed) }), true);
      else MV.toast(failNote(results.failed), true);
      load(true);
    }

    async function copyId(r) {
      try {
        await navigator.clipboard.writeText(r.id);
        MV.toast(L("copied"));
      } catch (e) {
        MV.toast(cleanErr(e), true);
      }
    }

    // ------------------------------------------------------------ data

    async function load(force = false) {
      if (!B.open) return;
      if (!bridgeOpen()) {
        B.error = "";
        renderAll();
        return;
      }
      const v = B.view;
      B.loading = !B.data[v];
      if (B.loading) renderList();
      try {
        const r = await deck.bridge.sessionIndex({ archived: v === "archived", force });
        B.data[v] = r;
        if (v === B.view) B.error = "";
      } catch (e) {
        if (v === B.view) B.error = cleanErr(e);
      } finally {
        B.loading = false;
        if (v === B.view && B.open) renderAll();
      }
    }

    // ------------------------------------------------------------ open / close and the rail entry

    function ensure() {
      if (root) return;
      build();
      const chat = document.getElementById("chat");
      if (chat) chat.appendChild(root);
    }

    function show() {
      if (!hermesMode() || B.open) return load(false);
      if (d.beforeOpen) d.beforeOpen();
      ensure();
      B.open = true;
      root.hidden = false;
      document.body.classList.add("sb-open");
      renderAll();
      focusList();
      load(false);
      clearInterval(B.timer);
      B.timer = setInterval(() => {
        // the Telegram view has no use for the browser: leaving the Hermes modes closes it (this tick notices)
        if (B.open && !hermesMode() && !B.busy) return close();
        if (B.open && document.visibilityState !== "hidden" && !B.busy) load(false);
      }, REFRESH_MS);
      if (B.timer && typeof B.timer.unref === "function") B.timer.unref(); // Node (tests): never keep the process alive
      mark("rail");
    }

    function close() {
      if (!B.open || B.busy) return;
      B.open = false;
      if (root) root.hidden = true;
      document.body.classList.remove("sb-open");
      clearInterval(B.timer);
      B.timer = null;
      B.selected.clear();
      mark("rail");
    }

    /** The "All sessions" row for the top of the rail (rebuilt on every rail render). */
    function entry() {
      if (B.open && !hermesMode()) close(); // rebuilt on every rail render: a switch to Telegram closes the overlay
      const total = B.data.active ? B.data.active.rows.length : 0;
      entryEl = h("button", { class: "row sb-entry", type: "button", title: L("entryHint"), "aria-pressed": B.open ? "true" : "false", dataset: { fk: "sb-entry" }, onclick: () => (B.open ? close() : show()) },
        h("span", { class: "sb-entry-ico", "aria-hidden": "true" }, listIcon()),
        h("span", { class: "who" }, h("span", { class: "name" }, L("entry"))),
        h("span", { class: "meta" }, total ? String(total) : ""));
      return entryEl;
    }

    const listIcon = () => {
      const NS = "http://www.w3.org/2000/svg";
      const s = document.createElementNS(NS, "svg");
      for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "aria-hidden": "true" })) s.setAttribute(k, v);
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", "M2.5 4h11M2.5 8h11M2.5 12h7");
      s.appendChild(p);
      return s;
    };

    document.addEventListener("deck-language", () => {
      if (!root) return;
      const was = B.open;
      build();
      const chat = document.getElementById("chat");
      if (chat && !root.parentNode) chat.appendChild(root);
      root.hidden = !was;
      if (was) renderAll();
    });

    // adopt: a stored chat opened from the rail follows the same rule as one opened here
    const adopt = (sid, source) => { if (needsCopy(source)) copyOnly.add(sid); else copyOnly.delete(sid); };
    return { entry, show, close, beforeSend, adopt, isOpen: () => B.open, readOnly: (sid) => copyOnly.has(sid), onStatus: () => { if (B.open) load(false); } };
  }

  const api = { create, SOURCES, sourceKey, needsCopy, sortRows, filterRows, countBySource, groupRows, moveIndex, rowKey };
  if (typeof window !== "undefined") window.DeckSessions = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
