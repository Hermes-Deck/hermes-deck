"use strict";
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
var i18nLocale = typeof module === "object" && module.exports ? require("./i18n").getLocale : window.DeckI18n.getLocale;
// Hermes Deck message reactions (C9), like Telegram Desktop: chips under a bubble (emoji, custom emoji,
// stars; the user's own highlighted; the reactors' photos instead of the number while there are only a
// few), a quick picker opened from the message menu ("Tepki ver"), and toggling with an optimistic update
// that rolls back on error. msgview.js calls create(ctx) and draws chips(m) in each bubble.
// The pure helpers at the top are shared with the tests (node requires this file; the browser gets
// window.DeckReactions). Records come from main/reactions.js: m.reactions = {list: [{t, e|id, n, mine?, who?}], canSee?}.
(() => {
  const WHO_MAX = 3; // main sends who only up to this many reactors; drawn only while it covers them all

  /** "e:👍" | "c:<documentId>" | "paid" for a chip or picker item. */
  const keyOf = (it) => (it.t === "paid" ? "paid" : it.t === "custom" ? `c:${it.id}` : `e:${it.e}`);
  const itemOf = (k) => (k === "paid" ? { t: "paid" } : k.startsWith("c:") ? { t: "custom", id: k.slice(2) } : { t: "emoji", e: k.slice(2) });

  /** The user's own reactions (paid ones aside: they are never sent from here), oldest choice first. */
  function mineKeys(rec) {
    return ((rec && rec.list) || [])
      .filter((it) => it.mine && it.t !== "paid")
      .sort((a, b) => a.mine - b.mine)
      .map(keyOf);
  }

  /**
   * The user's new set after clicking k: off when it was on; else added, dropping the oldest choices
   * once more than max are set (Telegram's per-user limit: 1 without Premium, so a click replaces).
   */
  function toggle(mine, k, max = 1) {
    if (mine.includes(k)) return mine.filter((x) => x !== k);
    const next = [...mine, k];
    return next.slice(Math.max(0, next.length - Math.max(1, max)));
  }

  /**
   * rec with the user's own reactions set to mine (what the chips show until Telegram answers): counts
   * move by one, chips that reach zero go, new ones join at the end; meId joins or leaves the drawn
   * reactors. Returns null when nothing is left.
   */
  function applyMine(rec, mine, meId) {
    const list = [];
    const seen = new Set();
    for (const it of (rec && rec.list) || []) {
      const k = keyOf(it);
      seen.add(k);
      if (it.t === "paid") {
        list.push(it);
        continue;
      }
      const was = !!it.mine;
      const now = mine.includes(k);
      const n = it.n + (now ? 1 : 0) - (was ? 1 : 0);
      if (n <= 0) continue;
      const x = { ...it, n };
      delete x.mine;
      if (now) x.mine = mine.indexOf(k) + 1;
      if (it.who && meId) {
        const others = it.who.filter((u) => u !== meId);
        const who = now ? [...others, meId] : others;
        if (who.length === n && n <= WHO_MAX) x.who = who;
        else delete x.who;
      }
      list.push(x);
    }
    for (const k of mine) {
      if (seen.has(k)) continue;
      const x = { ...itemOf(k), n: 1, mine: mine.indexOf(k) + 1 };
      if (meId) x.who = [meId];
      list.push(x);
    }
    if (!list.length) return null;
    return rec && rec.canSee ? { list, canSee: true } : { list };
  }

  /**
   * rec from a "min" update (rec.min: main could not tell which reactions are the user's own) with the
   * user's own marks taken from prev, the record the view already shows. A reaction the user had that
   * is gone from rec is dropped. Returns rec unchanged when it is not min.
   */
  function keepMine(prev, rec) {
    if (!rec || !rec.min) return rec;
    const mine = new Map(((prev && prev.list) || []).filter((it) => it.mine).map((it) => [keyOf(it), it.mine]));
    const list = rec.list.map((it) => {
      const x = { ...it };
      delete x.mine;
      if (mine.has(keyOf(it))) x.mine = mine.get(keyOf(it));
      return x;
    });
    return rec.canSee ? { list, canSee: true } : { list };
  }

  /** Whether a chip shows its reactors' photos instead of the number. */
  const showWho = (it) => Array.isArray(it.who) && it.who.length > 0 && it.who.length === it.n && it.n <= WHO_MAX;

  /** Telegram-style short counts: 999, 1,2B, 12B, 1,5M (Turkish: bin, milyon). */
  function countLabel(n) {
    const v = Number(n) || 0;
    const short = (x, unit) => `${(x < 10 ? Math.floor(x * 10) / 10 : Math.floor(x)).toLocaleString(i18nLocale(), { maximumFractionDigits: 1, useGrouping: false })}${unit}`;
    if (v < 1000) return String(v);
    if (v < 1e6) return short(v / 1000, i18nLocale() === "tr-TR" ? "B" : "K");
    return short(v / 1e6, "M");
  }

  function create(ctx) {
    const { h, S, deck, toast, person, hue, initial, mark, msgOf, openMenu, cleanErr } = ctx;
    const emojiUrls = new Map(); // documentId -> data: URL | null (null: nothing drawable)
    const emojiWait = new Map(); // documentId -> Promise
    const choices = new Map(); // chat key -> Promise<{list, max}>
    const busy = new Set(); // "key:id" while a change is on its way

    const meId = () => (S.tg.me && S.tg.me.id ? String(S.tg.me.id) : null);
    const label = (it) => (it.t === "paid" ? i18nText("U0877") : it.t === "custom" ? i18nText("U0878") : it.e);

    /** A custom emoji's picture once main has it; a neutral placeholder meanwhile or when it has none. */
    function customIcon(id, cls) {
      const url = emojiUrls.get(id);
      if (url) return h("img", { class: cls, src: url, alt: "", draggable: "false" });
      const ph = h("span", { class: `${cls} react-ph`, "aria-hidden": "true" });
      if (url === undefined && !emojiWait.has(id) && deck.emoji) {
        const p = deck
          .emoji(id)
          .then((u) => {
            emojiUrls.set(id, u || null);
            if (u) mark("msgs");
          })
          .catch(() => emojiUrls.set(id, null))
          .finally(() => emojiWait.delete(id));
        emojiWait.set(id, p);
      }
      return ph;
    }

    function icon(it) {
      if (it.t === "paid") return h("span", { class: "react-ico react-star", "aria-hidden": "true" }, "★");
      if (it.t === "custom") return customIcon(String(it.id), "react-ico");
      return h("span", { class: "react-ico", "aria-hidden": "true" }, it.e);
    }

    /** A reactor's photo: group member, a bot's chat photo, else a monogram in their name colour. */
    function face(uid) {
      const p = person(uid);
      const me = uid === meId();
      const name = me ? i18nText("A0354") : p.name || null;
      const url = p.avatar || S.avatars[`u${uid}`] || null;
      return h(
        "span",
        { class: `react-av ${me ? "hue-me" : hue(uid)}`, title: name },
        url ? h("img", { src: url, alt: "", draggable: "false" }) : initial(me ? (S.tg.me && S.tg.me.name) || "?" : p.name || "?")
      );
    }

    function chipTitle(it) {
      const names = showWho(it) ? it.who.map((u) => (u === meId() ? i18nText("A0354") : person(u).name)).filter(Boolean) : [];
      const head = it.t === "paid" ? i18nText("U0879", { n: it.n }) : `${label(it)} · ${it.n}`;
      return names.length ? `${head}: ${names.join(", ")}` : head;
    }

    /** The chips under a bubble, or null when the message has no reactions. */
    function chips(m) {
      const list = m.reactions && Array.isArray(m.reactions.list) ? m.reactions.list : [];
      if (!list.length) return null;
      const pending = busy.has(`${m.key}:${m.id}`);
      return h(
        "div",
        { class: "reacts", role: "group", "aria-label": i18nText("A0365") , "data-i18n-aria-label": "A0365"},
        list.map((it) =>
          h(
            "button",
            {
              class: `react-chip${it.mine ? " mine" : ""}${it.t === "paid" ? " paid" : ""}`,
              type: "button",
              "aria-pressed": it.t === "paid" ? null : it.mine ? "true" : "false",
              "aria-label": chipTitle(it),
              title: chipTitle(it),
              disabled: pending,
              // a held Enter/Space would toggle again and again: only the first press counts
              onkeydown: (e) => {
                if (e.repeat && (e.key === "Enter" || e.key === " ")) e.preventDefault();
              },
              onclick: (e) => {
                e.stopPropagation();
                if (!e.isTrusted) return; // a Telegram write: only a real click (mouse, Enter or Space), never a script
                if (it.t === "paid") return toast(i18nText("U0880"));
                react(m.key, m.id, keyOf(it));
              },
            },
            icon(it),
            showWho(it) ? h("span", { class: "react-who" }, it.who.map(face)) : h("span", { class: "react-n" }, countLabel(it.n))
          )
        )
      );
    }

    function loadChoices(key) {
      if (!choices.has(key)) {
        const p = deck.reactionChoices(key);
        p.catch(() => choices.delete(key)); // asked again next time
        choices.set(key, p);
      }
      return choices.get(key);
    }

    /**
     * Toggle reaction k on a message: the chips change at once, main sets the user's whole new set, and
     * Telegram's answer (or the old chips, on an error) replaces the guess.
     */
    async function react(key, id, k, max) {
      const tag = `${key}:${id}`;
      if (!msgOf(key, id) || busy.has(tag)) return;
      if (S.tg.status !== "open") return toast(i18nText("U0881"), true);
      // the lock is taken before the first await: a double click (or a second click while the chat's
      // choices load) must not send a second messages.sendReaction
      busy.add(tag);
      mark("msgs");
      let guess = null;
      let before = null;
      try {
        let limit = max;
        if (!limit) {
          try {
            limit = (await loadChoices(key)).max || 1;
          } catch {
            limit = 1;
          }
        }
        const m = msgOf(key, id);
        if (!m) return;
        before = m.reactions || null;
        const mine = toggle(mineKeys(before), k, limit);
        guess = applyMine(before, mine, meId());
        m.reactions = guess;
        mark("msgs");
        const now = await deck.react(key, id, mine);
        const cur = msgOf(key, id);
        if (cur && now !== undefined) cur.reactions = keepMine(guess, now);
      } catch (e) {
        const cur = msgOf(key, id);
        if (cur && guess !== null && cur.reactions === guess) cur.reactions = before; // nothing newer arrived meanwhile
        toast(i18nText("U0882", { e: cleanErr(e) }), true);
      } finally {
        busy.delete(tag);
        mark("msgs");
      }
    }

    /** The quick picker ("Tepki ver"): the reactions this chat allows, the user's own marked. */
    async function openPicker(m, anchor, pos) {
      let c;
      try {
        c = await loadChoices(m.key);
      } catch (e) {
        return toast(i18nText("U0883", { e: cleanErr(e) }), true);
      }
      if (!c || !c.list || !c.list.length) return toast(i18nText("U0884"));
      if (!anchor.isConnected) return;
      const mine = new Set(mineKeys(m.reactions));
      const items = c.list.slice(0, 80).map((it) => ({
        label: it.t === "custom" ? customIcon(String(it.id), "react-pick") : h("span", { class: "react-pick" }, it.e),
        title: label(it),
        pressed: mine.has(keyOf(it)),
        run: (e) => (e && e.isTrusted ? react(m.key, m.id, keyOf(it), c.max) : undefined), // only a real click writes
      }));
      openMenu(items, anchor, pos, i18nText("U0885"), "ctx-react");
    }

    /** The "Tepki ver" entry for the message menu. */
    function menuItem(m, anchor, pos) {
      return { label: i18nText("A0366"), enabled: S.tg.status === "open", noReturn: true, run: () => openPicker(m, anchor, pos) };
    }

    /** Live change from main ({key, id, reactions}); false when that message is not loaded here. */
    function update(x) {
      const m = msgOf(x.key, x.id);
      if (!m) return false;
      m.reactions = keepMine(m.reactions, x.reactions || null);
      return true;
    }

    return { chips, menuItem, openPicker, react, update };
  }

  const api = { create, keyOf, mineKeys, toggle, applyMine, keepMine, showWho, countLabel, WHO_MAX };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window === "object") window.DeckReactions = Object.freeze(api);
})();
