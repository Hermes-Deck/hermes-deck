"use strict";
// What Enter does while the selected Hermes session is busy (window.DeckBusySend). Settings > composer.busySend picks
// the default ("queue": the Deck outbox, sent when the turn ends; "steer": added to the running turn now); Ctrl/Cmd+Enter
// (or Ctrl/Cmd+click on the button) does the other one once. Steering needs a turn the Hermes plugin controls and a
// message without files; otherwise the message is queued and `fallback` says why.
(() => {
  /** The saved default, read defensively. */
  const modeOf = (settings) => ((((settings || {}).composer) || {}).busySend === "steer" ? "steer" : "queue");

  /**
   * {action: "send" | "queue" | "steer", fallback: null | "files" | "control"}.
   * busy: the turn is live or the outbox still holds messages; live/controllable: the node now.
   */
  function decide({ mode = "queue", alt = false, busy = false, live = false, controllable = false, files = false } = {}) {
    if (!busy) return { action: "send", fallback: null };
    if (!live) return { action: "queue", fallback: null }; // idle but earlier messages still wait: keep their order
    const want = alt ? (mode === "steer" ? "queue" : "steer") : mode === "steer" ? "steer" : "queue";
    if (want === "queue") return { action: "queue", fallback: null };
    if (files) return { action: "queue", fallback: "files" };
    if (!controllable) return { action: "queue", fallback: "control" };
    return { action: "steer", fallback: null };
  }

  /**
   * The composer hint while busy: the modifier's choice as {key, vars}, or null when there is no choice (the Send
   * button already names what Enter does). No choice: the turn cannot be steered, or files are staged.
   */
  function hint({ mode = "queue", live = false, controllable = false, files = false, mac = false } = {}) {
    if (!live || !controllable || files) return null;
    return { key: mode === "steer" ? "live.hintAlt.queue" : "live.hintAlt.steer", vars: { mod: mac ? "⌘" : "Ctrl" } };
  }

  const api = { modeOf, decide, hint };
  if (typeof window !== "undefined") window.DeckBusySend = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
