"use strict";
// Explicit takeover intent: never steal a runtime automatically or retry uncertain sends.
(() => {
  const refused = error => /open in another|running on another|another UI|not owned by this transport|not a session of this Hermes Deck connection/i.test(String(error?.message || error));
  const key = target => JSON.stringify([target.profile, target.sid]);
  function create(ctx) {
    const intents = new Map();
    return {
      offer(error, target, retry) {
        if (!refused(error)) return false;
        intents.set(key(target), { target: { ...target }, retry, busy: false });
        ctx.changed();
        return true;
      },
      pending: target => intents.get(key(target)) || null,
      async run(target) {
        const intent = intents.get(key(target));
        if (!intent || intent.busy) return;
        intent.busy = true; ctx.changed();
        try {
          const result = await ctx.takeover(intent.target.sid, { profile: intent.target.profile });
          if (result?.ok !== true || !['transferred', 'restarted'].includes(result.mode)) throw new Error('Invalid takeover reply');
          intents.delete(key(target));
          const retried = await intent.retry(result);
          if (retried === true && result.mode === "restarted") ctx.completed?.(result);
        } catch (error) { ctx.error(error); }
        finally { intent.busy = false; ctx.changed(); }
      },
    };
  }
  const api = { create, refused };
  if (typeof window !== 'undefined') window.DeckTakeover = Object.freeze(api);
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
