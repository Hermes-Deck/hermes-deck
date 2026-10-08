"use strict";
// The collapsed "Thinking" block of a finished assistant message (window.DeckThinkBlock): the reasoning Hermes stored
// with the message (history `think`) or the reasoning streamed during the turn that just ended. Closed by default,
// one click opens it, a small Copy button copies the text. Plain text only (never markdown, never HTML).
(() => {
  const MAX = 20000; // characters shown (the tail); the store may hold more

  /**
   * `seconds(sid)` resolves the measured thinking time of the turn that just ended in that session. It is only asked
   * for the finished live message (key "<sid>:live"): a stored message never borrows a later turn's duration and
   * keeps the unknown-duration label unless the caller passes its own measured `seconds`.
   */
  function create({ h, i18nText, copy, seconds: measured }) {
    const lookup = measured || ((sid) => (typeof window === "object" && window.DeckLiveActivity ? window.DeckLiveActivity.thoughtSeconds(sid) : null));
    const write = copy || ((text) => (typeof navigator !== "undefined" && navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.resolve()));
    // blocks the reader opened (by message key): the transcript is rebuilt on every event, an open block stays open
    const opened = new Set();
    /** The block for `text`, or null when there is nothing to show. `key` identifies the message. */
    function el(text, key = "", seconds = null) {
      const t = String(text || "").trim();
      if (!t) return null;
      const k = String(key || "");
      if (seconds == null && k.endsWith(":live")) seconds = lookup(k.slice(0, -":live".length));
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
        h("summary", null, h("span", { class: "tb-label" }, i18nText(Number.isFinite(seconds) ? "conv.thought" : "conv.thoughtUnknown", { seconds })), btn),
        h("p", { class: "tb-text" }, shown));
      return d;
    }
    return { el };
  }

  const api = { create, MAX };
  if (typeof window !== "undefined") window.DeckThinkBlock = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
