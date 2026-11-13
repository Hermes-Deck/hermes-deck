"use strict";
// Repainting a chat column without disturbing the reader: window.DeckStableList.
//
// The transcript is rebuilt as a fresh list of elements on every change (a streamed token, a history poll, a
// download's progress). Swapping the whole list for the new one drops the reader's text selection and, when they
// have scrolled up, can move what they are reading: the column is a column-reverse scroller, so its scroll offset is
// measured from the newest message, and other modules add and move rows right after each repaint.
//
//   paint(scroller, inner, kids)  makes the rows this module placed in `inner` equal `kids`, but keeps every row whose
//                                 fresh copy is identical to what was painted before, in place and untouched: only
//                                 messages that really changed are replaced, so a selection in an older message
//                                 survives. Rows other modules put into `inner` (tool receipts) are left alone.
//   hold(scroller, inner, change) runs `change` and, when the reader is away from the newest message, keeps the row
//                                 at the top of their view where it was, also through the next frames (rows that are
//                                 moved or added right after a repaint), until the reader scrolls again.
// At the newest message (offset 0) nothing is held: the view follows the reply as before.
(() => {
  const SLACK = 2; // px from the newest message that still counts as "at the bottom"
  const SETTLE_FRAMES = 3; // frames after a change in which late layout changes are still corrected
  // Rows with these inside are bound to live state by the module that built them (the working row, a voice player) or
  // load on their own (pictures): the fresh element is always used.
  const ALWAYS_FRESH = ".livebar, .vb, img, audio, video, canvas";

  const placed = new WeakMap(); // inner -> Set(rows this module put there)
  const pristine = new WeakMap(); // row -> a copy as it was painted (other modules decorate rows afterwards)
  const sessions = new WeakMap(); // scroller -> the reader's held place

  /** A cheap bucket key; isEqualNode decides. */
  const sig = (n) => {
    const t = n.textContent || "";
    return `${n.nodeType}|${n.nodeName}|${n.className || ""}|${t.length}|${t.slice(0, 48)}`;
  };
  const count = (n) => (n.getElementsByTagName ? n.getElementsByTagName("*").length : 0);
  const volatile = (n) => n.nodeType !== 1 || (typeof n.matches === "function" && (n.matches(ALWAYS_FRESH) || !!n.querySelector(ALWAYS_FRESH)));

  /**
   * The list to put on screen: for every fresh element the row already on screen that was painted from an identical
   * one (each used once, first match first), else the fresh element itself. A row that lost a part since it was
   * painted (an element another module moved elsewhere) is not kept.
   */
  function reuse(inner, kids) {
    const mine = placed.get(inner);
    const old = new Map();
    if (mine) {
      for (const c of inner.childNodes) {
        const was = mine.has(c) ? pristine.get(c) : null;
        if (!was) continue;
        const k = sig(was);
        const list = old.get(k);
        if (list) list.push(c);
        else old.set(k, [c]);
      }
    }
    return kids.map((k) => {
      if (volatile(k)) return k;
      const list = old.get(sig(k));
      if (!list) return k;
      const at = list.findIndex((c) => c === k || (pristine.get(c).isEqualNode(k) && count(c) >= count(k)));
      return at < 0 ? k : list.splice(at, 1)[0];
    });
  }

  /**
   * Make the rows this module placed in `parent` exactly `want`, in order, moving only what is not already in place.
   * Rows it did not place stay where they are. The first paint of a list takes it over whole.
   */
  function patch(parent, want) {
    const keep = new Set(want);
    const mine = placed.get(parent);
    for (const c of [...parent.childNodes]) if (!keep.has(c) && (!mine || mine.has(c))) parent.removeChild(c);
    let at = parent.firstChild;
    for (const k of want) {
      let next = at;
      while (next && !keep.has(next)) next = next.nextSibling; // another module's row: not ours to order
      if (k === next) at = next.nextSibling;
      else parent.insertBefore(k, at);
    }
    for (const k of want) if (!pristine.has(k) && !volatile(k)) pristine.set(k, k.cloneNode(true));
    placed.set(parent, keep);
  }

  const away = (scroller) => Math.abs(scroller.scrollTop) > SLACK;
  const frame = (fn) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : 0);

  /** The reader's place: the rows in view with where they were, kept until the reader scrolls. */
  function sessionOf(scroller, inner) {
    let s = sessions.get(scroller);
    if (!s) {
      s = { marks: null, at: 0, frames: 0, ticking: false };
      sessions.set(scroller, s);
      if (typeof scroller.addEventListener === "function") {
        // any scroll that is not this module's own correction is the reader's (wheel, keys, scrollbar, a jump): their
        // new place is measured afresh at the next change
        scroller.addEventListener("scroll", () => { if (Math.abs(scroller.scrollTop - s.at) > 1) s.marks = null; }, { passive: true });
      }
    }
    if (s.marks && !s.marks.some((m) => m.el.parentNode === inner)) s.marks = null;
    if (s.marks && Math.abs(scroller.scrollTop - s.at) > 1) s.marks = null;
    return s;
  }

  function measure(scroller, inner) {
    const box = scroller.getBoundingClientRect();
    const marks = []; // the rows in view, top first
    for (const c of inner.children) {
      const r = c.getBoundingClientRect();
      if (r.bottom <= box.top) continue;
      if (r.top >= box.bottom) break;
      marks.push({ el: c, top: r.top });
    }
    return marks;
  }

  /** Put the first row of the held place that is still there back at its top. Sub-pixel differences are left alone. */
  function settle(scroller, inner, s) {
    const kept = s.marks && s.marks.find((m) => m.el.parentNode === inner);
    if (!kept) {
      s.marks = null;
      return;
    }
    const moved = kept.el.getBoundingClientRect().top - kept.top;
    if (Math.abs(moved) >= 1) scroller.scrollTop += Math.round(moved);
    s.at = scroller.scrollTop;
  }

  /**
   * Run `change`; a reader who scrolled up keeps their place: the first row in their view that survives the change
   * stays where it was, now and through the next frames. The place is measured once and kept until the reader
   * scrolls, so many changes in a row cannot add up to a drift.
   */
  function hold(scroller, inner, change) {
    if (!away(scroller)) {
      const s = sessions.get(scroller);
      if (s) s.marks = null;
      return change();
    }
    const s = sessionOf(scroller, inner);
    if (!s.marks) s.marks = measure(scroller, inner);
    s.at = scroller.scrollTop;
    const out = change();
    settle(scroller, inner, s);
    s.frames = SETTLE_FRAMES;
    if (!s.ticking && s.marks) {
      s.ticking = true;
      const tick = () => {
        // the reader scrolled meanwhile, or went back to the newest message: nothing to hold
        if (!s.marks || Math.abs(scroller.scrollTop - s.at) > 1 || !away(scroller)) {
          s.marks = null;
          s.ticking = false;
          return;
        }
        settle(scroller, inner, s);
        if (--s.frames > 0 && s.marks) frame(tick);
        else s.ticking = false;
      };
      if (!frame(tick)) s.ticking = false;
    }
    return out;
  }

  /** Paint `kids` (elements; empty entries are skipped) into `inner`, reusing unchanged rows and holding the view. */
  function paint(scroller, inner, kids) {
    const fresh = kids.filter((k) => k && typeof k === "object");
    hold(scroller, inner, () => patch(inner, reuse(inner, fresh)));
  }

  const api = { paint, hold, patch, reuse, away, SLACK, ALWAYS_FRESH };
  if (typeof window !== "undefined") window.DeckStableList = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api;
})();
