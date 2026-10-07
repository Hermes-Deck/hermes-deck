"use strict";
// The collapsed "Thinking" block of a finished assistant message (window.DeckThinkBlock): the reasoning Hermes stored
// with the message (history `think`) or the reasoning streamed during the turn that just ended. Closed by default,
// one click opens it, a small Copy button copies the text. Plain text only (never markdown, never HTML).
(() => {
  const MAX = 20000; // characters shown (the tail); the store may hold more

  function create({ h, i18nText, copy }) {
    const write = copy || ((text) => (typeof navigator !== "undefined" && navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.resolve()));
    // blocks the reader opened (by message key): the transcript is rebuilt on every event, an open block stays open
    const opened = new Set();
    /** The block for `text`, or null when there is nothing to show. `key` identifies the message. */
    function el(text, key = "") {
      const t = String(text || "").trim();
      if (!t) return null;
      const k = String(key || "");
      const shown = t.length > MAX ? `…${t.slice(-MAX)}` : t;
      const btn = h("button", {
        class: "tb-copy", type: "button", title: i18nText("think.copy"), "aria-label": i18nText("think.copy"),
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          Promise.resolve(write(t)).then(() => { btn.textContent = i18nText("think.copied"); setTimeout(() => { btn.textContent = i18nText("think.copy"); }, 1200); }, () => {});
        },
      }, i18nText("think.copy"));
      const d = h("details", {
        class: "think-block", open: k && opened.has(k) ? true : null,
        ontoggle: () => { if (k) { if (d.open) opened.add(k); else opened.delete(k); if (opened.size > 200) opened.delete(opened.values().next().value); } },
      },
        h("summary", null, h("span", { class: "tb-label" }, i18nText("think.label")), btn),
        h("p", { class: "tb-text" }, shown));
      return d;
    }
    return { el };
  }

  const api = { create, MAX };
  if (typeof window !== "undefined") window.DeckThinkBlock = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
