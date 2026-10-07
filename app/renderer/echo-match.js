"use strict";
// Matching a message this Deck just sent (the dimmed local echo) against the history Hermes stored
// (window.DeckEchoMatch). Hermes persists a user turn with attachments as the typed text plus appended directive
// lines ("@image:<path>", "@file:<ref>", sometimes a "[screenshot]" placeholder or an "[Image attached at: ...]"
// hint, then a "--- Attached Context ---" footer for an @file: Hermes expanded), and a send of files only carries the host's default caption, so comparing the echo with the stored row by
// exact text never matched and the message showed twice (stored copy + echo labelled "sent").
//  - normalize(): drops the standalone directive lines (any quoting form: bare, `...`, "...", '...') and collapses
//    whitespace, so both sides compare on what the person actually wrote.
//  - settle(): every stored user row settles at most one echo, in send order; a row older than the echo's send
//    time cannot settle it; a file-only echo matches a stored row that is only directives or the default caption.
(() => {
  // a whole line that starts with the directive: Hermes itself treats any "@image:" line at the end of a row so
  const DIRECTIVE = /^[ \t]*@(?:image|file):.*$/;
  const PLACEHOLDER = /^[ \t]*(?:\[screenshot\]|\[Image attached at: [^\n\]]*\])[ \t]*$/;
  // captions Hermes and the Deck host add when a message has files and no text of its own
  const DEFAULT_CAPTIONS = ["what do you see in this image?", "please look at the attached file(s)."];
  const CLOCK_SKEW_S = 30; // a stored timestamp may trail the local clock a little

  const collapse = (s) => String(s || "").replace(/\s+/g, " ").trim();

  /** Text without its directive/placeholder lines, whitespace collapsed. */
  function normalize(text) {
    return collapse(
      String(text || "")
        .replace(/<([a-z][a-z0-9_-]{0,40}-context)>[\s\S]*?<\/\1>/gi, "") // injected memory/OMH context, not the person's words
        .replace(/\n+--- (?:Context Warnings|Attached Context) ---\n[\s\S]*$/, "") // Hermes' @-reference footer (media-refs.js)
        .split(/\r?\n/)
        .filter((line) => !DIRECTIVE.test(line) && !PLACEHOLDER.test(line))
        .join("\n"),
    );
  }

  /** A stored row that says nothing of its own: only directives, or just the default caption. */
  const isAttachmentOnly = (text) => {
    const n = normalize(text);
    return !n || DEFAULT_CAPTIONS.includes(n.toLowerCase());
  };

  /**
   * Does the stored row settle this echo? `echo.files` marks a send of files without text of its own (its text is
   * only the "[Files: ...]" label).
   */
  function matches(echo, row) {
    if (!row || row.role !== "user") return false;
    if (typeof row.ts === "number" && echo.at && row.ts < echo.at / 1000 - CLOCK_SKEW_S) return false;
    if (echo.files) return isAttachmentOnly(row.text) || normalize(row.text) === normalize(echo.text);
    return normalize(row.text) === normalize(echo.text);
  }

  /**
   * The echoes still waiting for their stored row. `msgs` is the loaded history (oldest first); only its last
   * `window` user rows are looked at. Each row settles one echo; echoes are taken in send order.
   */
  function settle(list, msgs, nowMs, { window: span = 12, maxAgeMs = 120000 } = {}) {
    const rows = msgs.filter((m) => m.role === "user").slice(-span);
    const used = new Set();
    const ordered = list.map((e, i) => ({ e, i })).sort((a, b) => (a.e.at || 0) - (b.e.at || 0) || a.i - b.i);
    const settled = new Set();
    for (const { e } of ordered) {
      const at = rows.findIndex((r, i) => !used.has(i) && matches(e, r));
      if (at !== -1) {
        used.add(at);
        settled.add(e);
      }
    }
    return list.filter((e) => !settled.has(e) && nowMs - e.at < maxAgeMs);
  }

  /** The plugin's "Please look at the attached file(s)." (a send of files with no text of its own), alone in the row. */
  const isAttachDefault = (text) => normalize(text).toLowerCase() === DEFAULT_CAPTIONS[1];

  const api = { normalize, isAttachmentOnly, isAttachDefault, matches, settle, DEFAULT_CAPTIONS };
  if (typeof window !== "undefined") window.DeckEchoMatch = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
