"use strict";
// Find in the open chat (Ctrl/Cmd+F): window.DeckChatFind.
//
// A small bar at the top right of the chat searches the transcript as it is drawn: every match is marked, the current
// one in a stronger colour and scrolled into view, with "3 / 17" beside the box. Enter (or the up arrow) goes to the
// match before, Shift+Enter (or the down arrow) to the one after; the first match shown is the newest. Esc closes.
//  - Matches are drawn with the CSS Custom Highlight API: nothing in the transcript's DOM changes, so a reply that
//    streams meanwhile, the reader's scroll position and a text selection are left alone (stable-list.js).
//  - The search runs over the text on screen, so a match may run across formatting (a path broken into parts, bold
//    inside a sentence) but not from one paragraph into the next. Letter case is ignored, and so is the Turkish
//    dotted/dotless i. Text that is folded away (a collapsed Thinking block, a tool call not unfolded) is not in the
//    transcript and so not found.
//  - A session opens on its latest messages only (history-window.js). When earlier ones are not loaded yet the bar
//    says so, and "Search earlier" loads older pages until a new match shows up or the session's start is reached.
(function (root) {
  const BLOCK = "p,li,td,th,pre,h1,h2,h3,h4,h5,h6,blockquote,summary,button,figcaption,dt,dd,div";
  const SKIP = ".md-copy,.chat-find,[hidden],script,style";
  const MAX_MATCHES = 5000; // drawn and counted; a one-letter query in a long session stops here
  const MAX_PAGES = 30; // older pages one "Search earlier" loads at most

  /** Text folded for comparing, one unit out for one unit in (so offsets stay those of the original). */
  function fold(s) {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "I" || c === "\u0130" || c === "\u0131") { out += "i"; continue; }
      const l = c.toLowerCase();
      out += l.length === 1 ? l : c;
    }
    return out;
  }

  /** Start offsets of `needle` (already folded) in `hay` (already folded), not overlapping. */
  function offsets(hay, needle, limit = MAX_MATCHES) {
    const at = [];
    if (!needle) return at;
    for (let i = hay.indexOf(needle); i !== -1 && at.length < limit; i = hay.indexOf(needle, i + needle.length)) at.push(i);
    return at;
  }

  /** The text nodes under `rootEl` that are on screen, grouped by the block they belong to, in document order. */
  function groups(rootEl, doc) {
    const out = [];
    const seen = new Map(); // element -> shown?
    const shown = (el) => {
      if (seen.has(el)) return seen.get(el);
      const ok = !el.closest(SKIP) && (typeof el.checkVisibility !== "function" || el.checkVisibility());
      seen.set(el, ok);
      return ok;
    };
    const walker = doc.createTreeWalker(rootEl, 4 /* NodeFilter.SHOW_TEXT */);
    let last = null, cur = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.data || !shown(el)) continue;
      const block = el.closest(BLOCK) || rootEl;
      if (block !== last) { cur = { nodes: [], text: "" }; out.push(cur); last = block; }
      cur.nodes.push({ node: n, at: cur.text.length });
      cur.text += n.data;
    }
    return out;
  }

  /** Every match of `query` under `rootEl` as {startNode, startOffset, endNode, endOffset}, in document order. */
  function matches(rootEl, query, doc) {
    const needle = fold(query);
    const found = [];
    if (!needle) return found;
    for (const g of groups(rootEl, doc)) {
      const at = offsets(fold(g.text), needle, MAX_MATCHES - found.length);
      let k = 0;
      const locate = (pos, end) => {
        // the node holding `pos`; an end position on a node boundary stays in the node before it
        while (k + 1 < g.nodes.length && (end ? g.nodes[k + 1].at < pos : g.nodes[k + 1].at <= pos)) k++;
        return { node: g.nodes[k].node, offset: pos - g.nodes[k].at };
      };
      for (const a of at) {
        const s = locate(a, false);
        const keep = k;
        const e = locate(a + needle.length, true);
        k = keep;
        found.push({ startNode: s.node, startOffset: s.offset, endNode: e.node, endOffset: e.offset });
      }
      if (found.length >= MAX_MATCHES) break;
    }
    return found;
  }

  function create({ h, t, host, scroller, inner, doc = root.document, win = root, earlier = null, frame = (fn) => win.requestAnimationFrame(fn) }) {
    const highlights = win.CSS && win.CSS.highlights && typeof win.Highlight === "function" ? win.CSS.highlights : null;
    let open = false, query = "", found = [], cur = -1, fromEnd = 0, busy = false, queued = false, shownFor = null;

    const input = h("input", { class: "chat-find-input", type: "text", spellcheck: "false", autocomplete: "off", placeholder: t("find.placeholder"), "aria-label": t("find.placeholder") });
    const count = h("span", { class: "chat-find-count", role: "status", "aria-live": "polite" });
    const btn = (cls, label, glyph, fn) => h("button", { class: `chat-find-btn ${cls}`, type: "button", title: label, "aria-label": label, onclick: fn }, glyph);
    const prev = btn("prev", t("find.prev"), "\u2191", () => step(-1));
    const next = btn("next", t("find.next"), "\u2193", () => step(1));
    const shut = btn("shut", t("find.close"), "\u00d7", () => close());
    const more = h("button", { class: "chat-find-more", type: "button", hidden: true, onclick: () => searchEarlier() }, t("find.earlier"));
    const bar = h("div", { class: "chat-find", role: "search", hidden: true }, h("div", { class: "chat-find-row" }, input, count, prev, next, shut), more);
    host.appendChild(bar);

    function draw() {
      if (!highlights) return;
      highlights.delete("deck-find");
      highlights.delete("deck-find-current");
      if (!open || !found.length) return;
      const range = (m) => { const r = doc.createRange(); r.setStart(m.startNode, m.startOffset); r.setEnd(m.endNode, m.endOffset); return r; };
      const all = new win.Highlight();
      found.forEach((m, i) => { if (i !== cur) all.add(range(m)); });
      highlights.set("deck-find", all);
      if (cur >= 0) highlights.set("deck-find-current", new win.Highlight(range(found[cur])));
    }

    function label() {
      const state = earlier ? earlier() : null;
      const capped = found.length >= MAX_MATCHES;
      count.textContent = !query ? "" : !found.length ? t("find.none") : `${cur + 1} / ${found.length}${capped ? "+" : ""}`;
      bar.classList.toggle("none", !!query && !found.length);
      prev.disabled = next.disabled = found.length < 2;
      const can = !!query && !!state && state.available;
      more.hidden = !can;
      more.disabled = busy;
      more.textContent = busy ? t("find.searching") : t("find.earlier");
    }

    function reveal() {
      const m = found[cur];
      const key = m ? `${query}\n${fromEnd}\n${found.length}` : null;
      if (!m || key === shownFor) return;
      shownFor = key;
      const el = m.startNode.parentElement;
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "nearest" });
    }

    /** Search again over the transcript as drawn now. */
    function refresh({ jump = false } = {}) {
      const was = found[cur] || null;
      found = open && query ? matches(inner, query, doc) : [];
      // the same match stays current: the transcript keeps the elements it has (stable-list.js), so its text node is
      // still there after a reply streamed below it or an older page loaded above. Else: the same count from the newest.
      const same = was && !jump ? found.findIndex((m) => m.startNode === was.startNode && m.startOffset === was.startOffset) : -1;
      cur = same !== -1 ? same : found.length ? Math.max(0, found.length - 1 - Math.min(fromEnd, found.length - 1)) : -1;
      if (cur !== -1) fromEnd = found.length - 1 - cur;
      draw();
      label();
      if (jump) { shownFor = null; reveal(); }
      return found.length;
    }
    function schedule() {
      if (!open || queued) return;
      queued = true;
      frame(() => { queued = false; if (open) refresh(); });
    }

    function step(d) {
      if (!found.length) return;
      cur = (cur + d + found.length) % found.length;
      fromEnd = found.length - 1 - cur;
      draw();
      label();
      shownFor = null;
      reveal();
    }

    /** Older pages are loaded until a match appears above the ones known, or there is nothing earlier. */
    async function searchEarlier() {
      if (busy || !earlier || !query) return;
      busy = true;
      label();
      const before = found.length, asked = query;
      try {
        for (let i = 0; i < MAX_PAGES && open && query === asked; i++) {
          const state = earlier();
          if (!state || !state.available) break;
          if ((await earlier().load()) === false) break;
          await new Promise((r) => frame(() => frame(r))); // the page is drawn
          if (refresh() > before) break;
        }
      } catch { /* the transcript shows its own error for a page that failed */ }
      busy = false;
      if (open && query === asked && found.length > before) {
        // the oldest of the new matches is the furthest away; land on the newest of them
        cur = found.length - before - 1;
        fromEnd = found.length - 1 - cur;
        draw();
        shownFor = null;
        reveal();
      }
      label();
    }

    function show() {
      const sel = win.getSelection ? String(win.getSelection() || "") : "";
      open = true;
      bar.hidden = false;
      if (sel && sel.length <= 200 && !sel.includes("\n")) input.value = sel;
      if (input.value !== query) { query = input.value; fromEnd = 0; }
      refresh({ jump: !!query });
      input.focus();
      input.select();
    }
    function close() {
      if (!open) return;
      open = false;
      busy = false;
      bar.hidden = true;
      found = [];
      cur = -1;
      draw();
      if (scroller && scroller.focus) scroller.focus({ preventScroll: true });
    }

    input.addEventListener("input", () => { query = input.value; fromEnd = 0; refresh({ jump: true }); });
    bar.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); step(e.shiftKey ? 1 : -1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
      else if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
    });
    doc.addEventListener("deck-transcript-paint", schedule);

    return { open: show, close, isOpen: () => open, refresh, /** another chat was opened: the bar closes with it */ reset: close, el: bar };
  }

  const api = { create, fold, offsets, matches, groups, MAX_MATCHES };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DeckChatFind = Object.freeze(api);
})(typeof window !== "undefined" ? window : globalThis);
