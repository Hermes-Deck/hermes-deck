"use strict";
// History window of the Hermes chat view, window.DeckHistory (pure helpers, no DOM beyond a scroll box).
//   - A session opens on its latest ROWS_INITIAL stored rows (tool and system rows count too, so far fewer
//     visible messages), fetched as PAGE-sized requests: the bridge and the host plugin cap one request at 100.
//   - Older pages load by themselves when the reader scrolls near the top (no click); the "Load earlier" button
//     stays as an accessible fallback and for a failed page.
//   - The periodic poll only re-reads the newest page and merges it under what is already loaded, so older pages
//     the reader opened are never thrown away.
(() => {
  const PAGE = 100; // rows per session.messages request (the bridge and the plugin accept at most 100)
  const ROWS_INITIAL = 200; // rows of the latest window loaded when a session opens
  const MAX_TOP_UP = 4; // requests beyond the first one for the opening window (bounds a runaway loop)
  const NEAR_TOP = 600; // px above the viewport that start loading the next older page

  /** Latest page merged under older pages already loaded; null when the two no longer overlap. */
  function mergeLatest(old, latest) {
    if (!latest.length) return old;
    if (latest.some((m) => !m.id) || old.some((m) => !m.id)) return null;
    const ids = new Set(latest.map((m) => m.id));
    const at = old.findIndex((m) => ids.has(m.id));
    return at === -1 ? null : [...old.slice(0, at), ...latest];
  }

  /** An older page put in front of the loaded messages; rows the list already has (the window slid) are dropped. */
  function prependOlder(msgs, older) {
    const known = new Set(msgs.map((m) => m.id).filter(Boolean));
    return [...older.filter((m) => !m.id || !known.has(m.id)), ...msgs];
  }

  /**
   * Distance in px between the top of the viewport and the top of the content. The chat scroller is a
   * `column-reverse` flex box: scrollTop is 0 at the newest message and goes negative while scrolling up.
   */
  function distanceFromTop(box) {
    return Math.max(0, box.scrollHeight - box.clientHeight + box.scrollTop);
  }

  /** Whether the next older page should be requested now. */
  function wantsOlder(st, distance) {
    return !!st && st.loaded === true && st.hasMore === true && !st.loading && !st.olderFailed && distance <= NEAR_TOP;
  }

  /**
   * The opening window: the newest page, topped up with older pages until ROWS_INITIAL rows are in or the
   * session has no more. `fetchPage(offset, limit)` returns the bridge's {messages, offset, hasMore, returned}.
   */
  async function openingWindow(fetchPage) {
    const first = await fetchPage(0, PAGE);
    let { messages, offset, hasMore } = first;
    let rows = first.returned;
    for (let i = 0; i < MAX_TOP_UP && hasMore && rows < ROWS_INITIAL; i++) {
      const next = await fetchPage(offset, PAGE);
      messages = prependOlder(messages, next.messages);
      offset = next.offset;
      hasMore = next.hasMore;
      rows += next.returned;
    }
    return { messages, offset, hasMore };
  }

  const api = { PAGE, ROWS_INITIAL, NEAR_TOP, mergeLatest, prependOlder, distanceFromTop, wantsOlder, openingWindow };
  if (typeof window !== "undefined") window.DeckHistory = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
