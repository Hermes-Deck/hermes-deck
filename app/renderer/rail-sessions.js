"use strict";
// Lifecycle of sessions created by the rail's New session action, never canonical Bot Chats.
(() => {
  function create(d) {
    const made = new Map();
    const closing = new Set();
    const minting = new Set();
    const track = (sid, profile) => { if (!made.has(sid)) made.set(sid, { profile, submitted: false }); };
    function untouched(sid) {
      const entry = made.get(sid);
      return !!entry && !entry.submitted && !d.hasIntent(sid);
    }
    function leave(sid) {
      if (!untouched(sid)) return Promise.resolve(false);
      const entry = made.get(sid);
      made.delete(sid);
      const restore = d.forget(sid); // paint immediately; the runtime close is best effort
      const pending = Promise.resolve().then(() => d.discard(sid)).then((result) => {
        if (result && result.discarded === null) {
          made.set(sid, { ...entry, submitted: true }); // a turn or another owner won the race
          if (typeof restore === "function") restore();
          return false;
        }
        return true;
      }).catch(() => true);
      closing.add(pending);
      pending.finally(() => closing.delete(pending));
      return pending;
    }
    async function close() {
      await Promise.allSettled([...minting]);
      return Promise.all([...made.keys()].map(leave).concat([...closing]));
    }
    return {
      track,
      mint(profile) {
        const pending = Promise.resolve(d.create(profile)).then((r) => { track(r.sid, r.profile || profile); return r; });
        minting.add(pending);
        pending.then(() => minting.delete(pending), () => minting.delete(pending));
        return pending;
      },
      reusable: (sid, profile) => untouched(sid) && made.get(sid).profile === profile,
      submit: (sid) => { const entry = made.get(sid); if (entry) entry.submitted = true; },
      forget: (sid) => made.delete(sid),
      leave,
      close,
      bindUnload(w) {
        let released = false, waiting = false;
        w.addEventListener("beforeunload", (event) => {
          if (released || (!minting.size && !closing.size && ![...made.keys()].some(untouched))) return;
          event.preventDefault();
          event.returnValue = ""; // Electron: hold this window until best-effort closes settle
          if (waiting) return;
          waiting = true;
          close().finally(() => {
            released = true;
            if (d.resumeUnload) d.resumeUnload();
            else w.close();
          });
        });
      },
    };
  }
  const api = { create };
  if (typeof window !== "undefined") window.DeckRailSessions = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api;
})();
