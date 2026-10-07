"use strict";
// C5: read receipts, the renderer's half (window.DeckReadSync).
//  - create(ctx).check() looks, after a short pause, at what the user can see right now: a chat is
//    "looked at" only while it is selected, the window is visible and focused, and its messages are
//    scrolled into view. The newest message id on screen goes to main (deck.markRead), which batches,
//    debounces and checks the window state again before anything reaches Telegram (main/readsync.js).
//  - afterRead / applyCounts turn Telegram's read updates into rail badges: a read on another device
//    only ever lowers a badge; the counts after a reconnect are taken as they are while receipts are
//    on (Telegram then knows everything the Deck saw) and only lower badges while they are off.
// Pure helpers are unit-tested in Node (test/readsync.test.js).
(() => {
  const DELAY = 250; // scroll and render bursts collapse into one look

  /**
   * Newest message id whose box overlaps the scroller's viewport. view: {top, bottom}; items:
   * [{id, top, bottom}] in the same coordinates. A message counts once any part of it is on screen.
   */
  function visibleMax(view, items) {
    let max = 0;
    for (const it of items || []) {
      if (!(it.id > max)) continue;
      if (it.bottom > view.top && it.top < view.bottom && it.bottom - it.top > 0) max = it.id;
    }
    return max;
  }

  /** The badge after Telegram says `unread` messages are still unread: a read never raises it. */
  const afterRead = (cur, unread) => Math.max(0, Math.min(Number(cur) || 0, Number.isFinite(Number(unread)) ? Number(unread) : Infinity));

  /**
   * Fresh counts from Telegram into the unread map (Map key -> n). exact: receipts are on, so Telegram's
   * number is the truth; otherwise it may only lower a badge. hold: the chat being looked at stays at 0.
   * Returns whether anything changed.
   */
  function applyCounts(unread, counts, { exact = true, hold = null } = {}) {
    let changed = false;
    for (const [key, n] of Object.entries(counts || {})) {
      if (!Number.isFinite(Number(n))) continue;
      const cur = unread.get(key) || 0;
      const next = key === hold ? 0 : exact ? Math.max(0, Number(n)) : afterRead(cur, n);
      if (next !== cur) {
        unread.set(key, next);
        changed = true;
      }
    }
    return changed;
  }

  // the browser's setTimeout must not be called as a method of another object ("Illegal invocation")
  const TIMERS = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };

  /**
   * ctx: viewing() -> true while the selected chat is really in front of the user; seen() -> {key, maxId}
   * of what is on screen; send(key, maxId); timers (tests). Each chat's id is sent once; forget() after
   * receipts are switched on again or the account changes.
   */
  function create({ viewing, seen, send, delay = DELAY, timers = TIMERS }) {
    const asked = new Map(); // key -> highest id sent to main
    let timer = null;

    function look() {
      timer = null;
      if (!viewing()) return;
      const s = seen();
      if (!s || !s.key || !(s.maxId > 0)) return;
      if (s.maxId <= (asked.get(s.key) || 0)) return;
      asked.set(s.key, s.maxId);
      send(s.key, s.maxId);
    }

    return {
      check() {
        if (!timer) timer = timers.setTimeout(look, delay);
      },
      forget() {
        asked.clear();
      },
    };
  }

  const api = { create, visibleMax, afterRead, applyCounts };
  if (typeof window !== "undefined") window.DeckReadSync = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
