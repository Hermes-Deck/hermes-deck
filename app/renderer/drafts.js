"use strict";
// Per-chat composer drafts, window.DeckDrafts.
//   - The message box is ONE textarea shared by every chat (Hermes sessions, Telegram chats, bot chats). A draft
//     belongs to a chat, not to the box: the store is keyed like the attachment tray (DeckAttach `key()`), so the
//     typed text and the staged files switch together.
//   - sync() is called whenever the chat column renders: when the active chat changed, the box content is saved
//     under the old key and the new chat's draft is put in the box (text, caret and scroll position).
//   - Drafts persist in localStorage (bounded: MAX_DRAFTS drafts, MAX_CHARS characters each, MAX_AGE_MS old) and
//     are dropped when the chat is deleted (forget) or its message is sent (sent).
//   - Nothing here reaches the network; a draft never leaves this device.
(() => {
  const STORE_KEY = "deck.drafts";
  const MAX_DRAFTS = 100;
  const MAX_CHARS = 20000;
  const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
  const SAVE_DELAY = 300;

  const clampInt = (v, max) => (Number.isInteger(v) ? Math.max(0, Math.min(v, max)) : 0);

  /** A draft record cleaned to its bounded shape: {text, start, end, scroll, at}. */
  function clean(rec, now) {
    if (!rec || typeof rec !== "object" || typeof rec.text !== "string") return null;
    const text = rec.text.slice(0, MAX_CHARS);
    if (!text.trim()) return null;
    const start = clampInt(rec.start, text.length);
    return { text, start, end: Math.max(start, clampInt(rec.end, text.length)), scroll: clampInt(rec.scroll, 1e7), at: Number.isFinite(rec.at) ? rec.at : now };
  }

  /**
   * The persistent map key -> record. `storage` is {get(key), set(key, value)} (strings, never throws).
   * Reads are lazy and tolerant: a damaged value is an empty store.
   */
  class DraftStore {
    constructor(storage, { now = () => Date.now(), maxDrafts = MAX_DRAFTS, maxAge = MAX_AGE_MS } = {}) {
      this.storage = storage;
      this.now = now;
      this.maxDrafts = maxDrafts;
      this.maxAge = maxAge;
      this.map = new Map();
      this.load();
    }

    load() {
      this.map.clear();
      let raw = null;
      try {
        raw = JSON.parse(this.storage.get(STORE_KEY) || "null");
      } catch {
        raw = null;
      }
      const t = this.now();
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) {
          const rec = clean(v, t);
          if (rec && typeof k === "string" && k && t - rec.at <= this.maxAge) this.map.set(k, rec);
        }
      }
      this.trim();
    }

    /** Oldest drafts go first once there are more than maxDrafts. */
    trim() {
      if (this.map.size <= this.maxDrafts) return;
      const keep = [...this.map.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, this.maxDrafts);
      this.map = new Map(keep.reverse()); // oldest first, newest last: the Map stays in recency order
    }

    get(key) {
      const rec = this.map.get(key);
      return rec ? { ...rec } : null;
    }

    has(key) {
      return this.map.has(key);
    }

    /** Stores the draft (an empty text removes it). Returns whether anything changed. */
    set(key, rec) {
      if (!key) return false;
      const next = clean({ ...rec, at: this.now() }, this.now());
      const old = this.map.get(key);
      if (!next) return this.delete(key);
      if (old && old.text === next.text && old.start === next.start && old.end === next.end && old.scroll === next.scroll) return false;
      this.map.delete(key); // keeps the Map in recency order
      this.map.set(key, next);
      this.trim();
      this.persist();
      return true;
    }

    delete(key) {
      if (!this.map.delete(key)) return false;
      this.persist();
      return true;
    }

    keys() {
      return [...this.map.keys()];
    }

    persist() {
      try {
        this.storage.set(STORE_KEY, JSON.stringify(Object.fromEntries(this.map)));
      } catch {
        /* a full or blocked storage only loses the convenience */
      }
    }
  }

  /**
   * Binds the store to the message box. ctx: {els, key() -> string, storage, autosize(), after(),
   * setTimeout, clearTimeout, now}. `key()` must be safe to call at any time (it may name no chat: "").
   */
  function create(ctx) {
    const { els } = ctx;
    const input = els.input;
    const store = new DraftStore(ctx.storage, { now: ctx.now });
    const later = ctx.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const cancel = ctx.clearTimeout || ((t) => clearTimeout(t));
    const loose = new Map(); // drafts of "no chat selected" keys: kept while the page lives, never persisted
    let active = null; // the key whose draft the box shows now (null before the first sync)
    let timer = 0;

    const persistable = (key) => !!key && !/^(hermes:)?$/.test(key);
    const snapshot = () => ({ text: input.value, start: input.selectionStart, end: input.selectionEnd, scroll: input.scrollTop });
    const read = (key) => (persistable(key) ? store.get(key) : loose.get(key) || null);
    const write = (key, rec) => {
      if (persistable(key)) return store.set(key, rec);
      if (rec.text.trim()) loose.set(key, { ...rec, at: 0 });
      else loose.delete(key);
      return true;
    };
    const flush = () => {
      cancel(timer);
      timer = 0;
      if (active !== null) write(active, snapshot());
    };
    const schedule = () => {
      if (timer) return;
      timer = later(() => {
        timer = 0;
        if (active !== null) write(active, snapshot());
      }, SAVE_DELAY);
    };

    function show(rec) {
      input.value = rec ? rec.text : "";
      if (ctx.autosize) ctx.autosize();
      if (rec && typeof input.setSelectionRange === "function") {
        try {
          input.setSelectionRange(rec.start, rec.end);
        } catch {
          /* the box is not attached */
        }
      }
      input.scrollTop = rec ? rec.scroll : 0;
      if (ctx.after) ctx.after();
    }

    /** The chat column rendered: when the active chat changed, swap the draft (idempotent otherwise). */
    function sync() {
      const next = ctx.key() || "";
      if (next === active) return false;
      if (active !== null) write(active, snapshot()); // leave: whatever the box holds belongs to the old chat
      cancel(timer);
      timer = 0;
      active = next;
      show(read(next));
      return true;
    }

    input.addEventListener("input", schedule);
    input.addEventListener("blur", flush);
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", flush);
      window.addEventListener("beforeunload", flush);
    }

    return {
      store,
      sync,
      /** The key whose draft the box shows. */
      key: () => active,
      /** Persist the box now (the box changed without an input event). */
      touch: schedule,
      flush,
      read,
      write,
      /**
       * The message typed in chat `key` was sent. In the box: clear it when it still holds exactly that text
       * (the owner kept typing otherwise). Not in the box any more: drop its stored draft when unchanged.
       */
      sent(key, text) {
        const sentText = String(text || "").trim();
        if (key === active) {
          if (input.value.trim() === sentText) {
            input.value = "";
            if (ctx.autosize) ctx.autosize();
            input.dispatchEvent(new Event("input")); // autosize, send button, draft
            flush();
          }
          return;
        }
        const rec = read(key);
        if (rec && rec.text.trim() === sentText) (persistable(key) ? store.delete(key) : loose.delete(key));
      },
      /** A deleted chat leaves no draft behind. */
      forget(key) {
        if (ctx.attachments) ctx.attachments.forgetChat(key);
        if (key === active) {
          input.value = "";
          if (ctx.autosize) ctx.autosize();
          input.dispatchEvent(new Event("input"));
        }
        store.delete(key);
        loose.delete(key);
      },
    };
  }

  const api = { create, DraftStore, STORE_KEY, MAX_DRAFTS, MAX_CHARS, MAX_AGE_MS, SAVE_DELAY };
  if (typeof window !== "undefined") window.DeckDrafts = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
