"use strict";
// Watch (window.DeckWatch): the live Hermes session this page shows, followed read-only on the page's own host.
// The Deck receives a session's live events (tool.*, message.*, and with Show thinking on, reasoning.delta) only
// after it binds that session on its connection; sending binds it, merely opening a session did not. So while the
// selected session's snapshot node is live (a sub-agent, a turn from another Deck or Hermes Desktop), the page asks main
// to watch it (deck.bridge.watch -> BridgeClient.watch: session.resume with omit_messages, never a prompt or a
// takeover), again after every reconnect, and unwatches it when the page leaves it or it goes idle.
//  - One watched session per page (main keys it by the page, so a split view watches one per pane).
//  - At most one attempt per session and connection: `gen` counts the bridge's open transitions; a refused resume is
//    not retried until the next connection (main enforces the same).
//  - Idle sessions are never watched: a finished turn reads from the stored transcript.
(() => {
  /**
   * deps: deck (preload API), want() -> {sid, profile} of the selected live session or null, onError(e) optional.
   */
  function create({ deck, want, onError = () => {} }) {
    let gen = 0; // bridge connections seen open on this page
    let cur = null; // {sid, profile, gen}: what this page asked main to watch
    const same = (a, b) => !!a && !!b && a.sid === b.sid && (a.profile || "default") === (b.profile || "default");

    /** Follow the selection and the node's state: call after a selection change and after every snapshot. */
    function sync() {
      const w = want();
      if (cur && cur.gen === gen && same(cur, w)) return;
      if (!w) {
        if (cur && cur.gen === gen) deck.bridge.unwatch(cur.sid, { profile: cur.profile }).catch(onError);
        cur = null;
        return;
      }
      // a different session replaces the previous one in main (one per page): no separate unwatch needed
      cur = { sid: w.sid, profile: w.profile || "default", gen };
      deck.bridge.watch(cur.sid, { profile: cur.profile }).catch(onError);
    }

    /** The bridge's status (and the one before it): every new open connection watches again; a closed one has no bindings left. */
    function status(s, was) {
      if (s === "open") {
        if (was === "open" && cur) return;
        gen += 1;
        cur = null;
        sync();
      } else cur = null;
    }

    const watching = () => (cur && cur.gen === gen ? { sid: cur.sid, profile: cur.profile } : null);
    return { sync, status, watching };
  }

  const api = { create };
  if (typeof window !== "undefined") window.DeckWatch = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
