"use strict";
// Composer suggestions (window.DeckSuggest): typing "@" lists names to tag, a leading "/" lists slash commands.
// What is listed comes from the caller (app.js): in a Telegram chat the bots, agents and group members with a
// username, and the chat bot's registered commands; in a Hermes session the profile names and Hermes' own command
// palette (commands.catalog). Arrow keys move, Tab or Enter inserts, Escape closes. Focus never leaves the box.
// Pure helpers at the top are exported for unit tests.
(() => {
  // ---------------------------------------------------------------- pure helpers
  const SHOW_MAX = 40; // rows drawn at once; typing narrows the rest
  const lower = (s) => String(s || "").toLowerCase();

  /**
   * The token being typed at the caret: {kind: "/" | "@", start, end, query} or null. "/" only as the first
   * thing in the box (a command is the whole message); "@" at the start or after whitespace.
   */
  function tokenAt(text, caret) {
    const value = String(text || "");
    const at = Math.max(0, Math.min(Number.isInteger(caret) ? caret : value.length, value.length));
    const before = value.slice(0, at);
    const rest = /^[^\s]*/.exec(value.slice(at))[0]; // the token runs on past the caret until whitespace
    const slash = /^\/([^\s/]*)$/.exec(before);
    if (slash) return { kind: "/", start: 0, end: at + rest.length, query: slash[1] };
    const mention = /(^|\s)@([A-Za-z0-9_.-]*)$/.exec(before);
    if (mention) return { kind: "@", start: mention.index + mention[1].length, end: at + rest.length, query: mention[2] };
    return null;
  }

  /**
   * Items matching query, best first: label or insert starting with it, then a word of them starting with it,
   * then anywhere in label, insert, detail or keys. Order within a rank is the source's. Empty query: all.
   */
  function rank(items, query) {
    const q = lower(query).replace(/^[@/]/, "");
    const list = Array.isArray(items) ? items.filter((i) => i && typeof i.insert === "string" && i.insert) : [];
    if (!q) return list.slice();
    const scored = [];
    list.forEach((item, i) => {
      const names = [item.insert.replace(/^[@/]/, ""), item.label].map(lower);
      const all = [...names, lower(item.detail), ...(Array.isArray(item.keys) ? item.keys.map(lower) : [])];
      let score = -1;
      if (names.some((n) => n.startsWith(q))) score = 0;
      else if (names.some((n) => n.split(/[\s_.:@-]+/).some((w) => w.startsWith(q)))) score = 1;
      else if (all.some((n) => n.includes(q))) score = 2;
      if (score >= 0) scored.push({ item, score, i });
    });
    scored.sort((a, b) => a.score - b.score || a.i - b.i);
    return scored.map((s) => s.item);
  }

  /** The box after picking item for token: {value, caret}. One space follows the insert unless one is already there. */
  function applyPick(text, token, item) {
    const value = String(text || "");
    const tail = value.slice(token.end);
    const insert = item.insert + (/^\s/.test(tail) ? "" : " ");
    return { value: value.slice(0, token.start) + insert + tail, caret: token.start + insert.length };
  }

  /** One list without repeats (first wins), compared by insert text, case-insensitive. */
  function unique(items) {
    const seen = new Set();
    const out = [];
    for (const i of items) {
      if (!i || typeof i.insert !== "string") continue;
      const k = lower(i.insert);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(i);
    }
    return out;
  }

  // ---------------------------------------------------------------- the popup
  /**
   * ctx: {h, i18nText, input: <textarea>, composer: element the popup is appended to,
   *       source(kind): Promise<[{insert, label?, detail?, keys?, tag?}]>, changed(): after the box was edited}
   */
  function create(ctx) {
    const { h, input, composer } = ctx;
    const T = (key, vars) => ctx.i18nText(key, vars);
    const listId = "suggest-list";
    const list = h("div", { class: "pick-list suggest-list", id: listId, role: "listbox" });
    const status = h("p", { class: "pick-empty", hidden: true });
    const pop = h("div", { class: "pick-pop suggest-pop", hidden: true }, list, status);
    // a press in the popup must not take focus from the box (the click then picks)
    pop.addEventListener("mousedown", (e) => e.preventDefault());
    composer.appendChild(pop);

    let token = null;
    let rows = [];
    let active = 0;
    let gen = 0;
    let lastKind = "";

    const isOpen = () => !pop.hidden;
    function close() {
      gen++;
      token = null;
      rows = [];
      pop.hidden = true;
      input.removeAttribute("aria-activedescendant");
      input.setAttribute("aria-expanded", "false");
    }

    function draw() {
      list.textContent = "";
      rows.forEach((item, i) => {
        const row = h("div", {
          class: `pick-row pick-nav suggest-row${i === active ? " on" : ""}`, id: `suggest-${i}`, role: "option",
          "aria-selected": i === active ? "true" : "false", onclick: () => pick(i),
        },
        h("span", { class: "pick-row-top" },
          h("span", { class: "pick-name" }, item.label || item.insert),
          item.tag ? h("span", { class: "pick-badge" }, item.tag) : null),
        item.detail ? h("span", { class: "pick-id" }, item.detail) : null);
        list.appendChild(row);
      });
      list.hidden = !rows.length;
      if (rows.length) {
        input.setAttribute("aria-activedescendant", `suggest-${active}`);
        const on = list.children[active];
        if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
      } else input.removeAttribute("aria-activedescendant");
    }

    function showStatus(text) {
      status.textContent = text || "";
      status.hidden = !text;
    }

    /** Re-read the token at the caret and show what matches; closes when nothing is being typed. */
    async function refresh() {
      const t = tokenAt(input.value, input.selectionStart === input.selectionEnd ? input.selectionStart : -1);
      if (!t || input.selectionStart !== input.selectionEnd) return close();
      const mine = ++gen;
      token = t;
      if (t.kind !== lastKind || pop.hidden) active = 0;
      lastKind = t.kind;
      let items = [];
      let failed = false;
      try {
        items = unique((await ctx.source(t.kind)) || []);
      } catch {
        failed = true;
      }
      if (mine !== gen) return; // typed on meanwhile, or closed
      const prev = rows[active];
      rows = rank(items, t.query).slice(0, SHOW_MAX);
      const keep = prev ? rows.indexOf(prev) : -1;
      active = keep >= 0 ? keep : Math.min(active, Math.max(0, rows.length - 1));
      if (!rows.length && !failed && !items.length) return close(); // nothing to offer here at all
      showStatus(rows.length ? "" : T(failed ? "suggest.failed" : "suggest.none"));
      pop.hidden = false;
      pop.setAttribute("aria-label", T(t.kind === "/" ? "suggest.commands" : "suggest.mentions"));
      input.setAttribute("aria-controls", listId);
      input.setAttribute("aria-expanded", "true");
      draw();
    }

    function pick(i) {
      const item = rows[i];
      if (!item || !token) return false;
      const next = applyPick(input.value, token, item);
      input.value = next.value;
      input.setSelectionRange(next.caret, next.caret);
      close();
      input.focus();
      if (ctx.changed) ctx.changed();
      return true;
    }

    function move(d) {
      if (!rows.length) return;
      active = (active + d + rows.length) % rows.length;
      draw();
    }

    // capture: runs before the composer's own handlers (Enter sends, Escape clears a reply)
    input.addEventListener("keydown", (e) => {
      if (!isOpen() || e.isComposing) return;
      const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      if (e.key === "ArrowDown") { stop(); move(1); }
      else if (e.key === "ArrowUp") { stop(); move(-1); }
      else if ((e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) || (e.key === "Tab" && !e.shiftKey)) {
        if (!rows.length) { if (e.key === "Tab") { stop(); } else close(); return; }
        // Enter on a command typed out in full sends it, as it would without the list
        const typed = token ? lower(input.value.slice(token.start, token.end)) : "";
        if (e.key === "Enter" && typed && lower(rows[active].insert) === typed) { close(); return; }
        stop();
        pick(active);
      } else if (e.key === "Escape") { stop(); close(); }
    }, true);
    input.addEventListener("input", () => { refresh(); });
    input.addEventListener("click", () => { refresh(); });
    input.addEventListener("keyup", (e) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) refresh(); });
    input.addEventListener("blur", () => close());

    return { refresh, close, isOpen, pick: () => pick(active), rows: () => rows.slice(), pop };
  }

  const api = { tokenAt, rank, applyPick, unique, SHOW_MAX, create };
  if (typeof window !== "undefined") window.DeckSuggest = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
