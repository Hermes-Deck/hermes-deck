"use strict";
// Deck-side outbox (window.DeckOutbox): a message written while the selected session is busy is NOT submitted.
// Hermes has no call that removes a queued prompt, and its default busy mode ("interrupt") may redirect or even
// hard-interrupt the running turn, so a sent-while-busy message can neither be cancelled nor safely waited for.
// Instead the Deck keeps it here, per session, shown as a pending bubble with Edit / Cancel / Send now, and
// submits the head of the queue (one at a time, FIFO) once the session is idle again.
//  - Persisted in localStorage per session id (survives a renderer reload), at most MAX items. Files ride along as the
//    staged tokens main holds (name/size/kind persisted; image previews only in memory); a cancel discards them.
//  - Pure state + persistence + the bubble builder; the sending itself stays in app.js (the normal send path).
(() => {
  const MAX = 20;
  const MAX_TEXT = 32000;
  const KEY = (sid) => `deck.outbox.${sid}`;
  const MAX_FILES = 10;
  /** A staged file as the outbox keeps it: the token main holds plus what the bubble shows. */
  const fileOf = (f) => (f && typeof f.token === "string" && f.token ? {
    token: f.token.slice(0, 64), name: String(f.name || "file").slice(0, 160), size: Number(f.size) || 0,
    kind: String(f.kind || "").slice(0, 24), image: f.image === true, preview: typeof f.preview === "string" && f.preview.startsWith("data:image/") ? f.preview : null,
  } : null);
  const SETTLE_MS = 15000; // after a submit, wait this long for the node to be seen running before the next one

  function create(ctx) {
    const { store, h, i18nText, i18nNode, now = () => Date.now() } = ctx;
    const lists = new Map(); // sid -> [{id, text, at, error}]
    const waiting = new Map(); // sid -> {since, sawLive}: a head was just submitted, its turn has not shown up yet
    let seq = 0;
    let menuOpen = null; // id of the queued message whose overflow menu is open

    function load(sid) {
      if (lists.has(sid)) return lists.get(sid);
      let list = [];
      try {
        const raw = JSON.parse(store.get(KEY(sid)) || "[]");
        if (Array.isArray(raw)) {
          list = raw
            .filter((x) => x && typeof x.text === "string" && typeof x.id === "string")
            .map((x) => ({ id: x.id, text: x.text.slice(0, MAX_TEXT), at: Number(x.at) || 0, error: null,
              files: (Array.isArray(x.files) ? x.files : []).map(fileOf).filter(Boolean).slice(0, MAX_FILES) }))
            .filter((x) => x.text.trim() || x.files.length)
            .slice(0, MAX);
        }
      } catch {
        list = [];
      }
      lists.set(sid, list);
      return list;
    }
    function save(sid) {
      const list = lists.get(sid) || [];
      // previews stay in memory: a data: URL per image would fill localStorage
      store.set(KEY(sid), list.length ? JSON.stringify(list.map(({ id, text, at, files }) => ({ id, text, at,
        files: (files || []).map(({ token, name, size, kind, image }) => ({ token, name, size, kind, image })) }))) : "");
    }

    const api = {
      MAX,
      items: (sid) => load(sid).slice(),
      size: (sid) => load(sid).length,
      /** Messages that will still be sent by themselves (a failed one waits for the user and does not count). */
      pending: (sid) => load(sid).filter((x) => !x.error).length,
      /** Queue a message (text and/or staged files); null when the outbox is full or there is nothing to send. */
      add(sid, text, files = []) {
        const t = String(text || "").trim().slice(0, MAX_TEXT);
        const fs = (Array.isArray(files) ? files : []).map(fileOf).filter(Boolean).slice(0, MAX_FILES);
        const list = load(sid);
        if ((!t && !fs.length) || list.length >= MAX) return null;
        const item = { id: `o${now().toString(36)}${(seq++).toString(36)}`, text: t, at: now(), error: null, files: fs };
        list.push(item);
        save(sid);
        return item;
      },
      get: (sid, id) => load(sid).find((x) => x.id === id) || null,
      remove(sid, id) {
        const list = load(sid);
        const at = list.findIndex((x) => x.id === id);
        if (at === -1) return null;
        const [item] = list.splice(at, 1);
        save(sid);
        return item;
      },
      setError(sid, id, text) {
        const item = api.get(sid, id);
        if (item) item.error = text ? String(text) : null;
      },
      /** Forget a deleted session's outbox. */
      drop(sid) {
        lists.set(sid, []);
        waiting.delete(sid);
        save(sid);
        lists.delete(sid);
      },
      /** Sessions that hold queued messages (those of this run plus stored ones are loaded lazily by the caller). */
      sids: () => [...lists.entries()].filter(([, l]) => l.length).map(([sid]) => sid),
      /**
       * The message to submit now, or null: the session must be idle (not live), nothing may be in flight, the
       * previous submit must have shown up as a running turn (or SETTLE_MS passed), and a head that failed
       * stays put until the user acts on it.
       */
      next(sid, { live }) {
        const list = load(sid);
        const w = waiting.get(sid);
        if (w) {
          if (live) w.sawLive = true;
          else if (w.sawLive || now() - w.since >= SETTLE_MS) waiting.delete(sid);
        }
        if (live || waiting.has(sid) || !list.length || list[0].error) return null;
        return list[0];
      },
      submitted(sid) {
        waiting.set(sid, { since: now(), sawLive: false });
      },
      /**
       * One bubble per queued message: text, a label, Send now (the one primary action) and an overflow menu with Edit,
       * Interrupt and send (only when on.redirect is given: the running turn can be redirected) and Cancel.
       */
      bubbles(sid, on) {
        return load(sid).map((it, i) => {
          const open = menuOpen === it.id;
          const pick = (fn) => () => { menuOpen = null; fn(it.id); if (on.redraw) on.redraw(); };
          const items = [
            h("button", { class: "amenu-item", type: "button", role: "menuitem", dataset: { fk: `outbox-edit:${it.id}` }, onclick: pick(on.edit) }, i18nNode("queue.edit")),
            on.redirect && !(it.files && it.files.length) ? h("button", { class: "amenu-item", type: "button", role: "menuitem", title: i18nText("live.redirectTip"), dataset: { fk: `outbox-redirect:${it.id}` }, onclick: pick(on.redirect) }, i18nNode("live.redirect")) : null,
            h("button", { class: "amenu-item danger", type: "button", role: "menuitem", dataset: { fk: `outbox-cancel:${it.id}` }, onclick: pick(on.cancel) }, i18nNode("queue.cancel")),
          ];
          return h("div", { class: `msg out outbox${it.error ? " failed" : ""}`, dataset: { fk: `outbox:${it.id}` } },
            it.text ? h("div", { class: "text" }, it.text) : null,
            it.files && it.files.length ? h("div", { class: "outbox-files" }, ...it.files.map((f) =>
              h("span", { class: "outbox-file", title: f.name }, f.preview ? h("img", { src: f.preview, alt: "", draggable: "false" }) : null, h("span", { class: "nm" }, f.name)))) : null,
            it.error ? h("p", { class: "form-error", role: "alert" }, i18nText("queue.failed", { e: it.error })) : null,
            h("div", { class: "outbox-meta" },
              h("span", { class: "outbox-label" }, i18nNode("queue.label"), i > 0 ? ` · ${i + 1}` : ""),
              h("button", { class: "linkbtn", type: "button", dataset: { fk: `outbox-sendnow:${it.id}` }, onclick: () => on.sendNow(it.id) }, i18nNode("queue.sendNow")),
              h("div", { class: "amenu-wrap outbox-more" },
                h("button", {
                  class: `amore${open ? " on" : ""}`, type: "button", "aria-haspopup": "menu", "aria-expanded": open ? "true" : "false",
                  "aria-label": i18nText("activity.more"), title: i18nText("activity.more"), dataset: { fk: `outbox-more:${it.id}` },
                  onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); menuOpen = open ? null : it.id; if (on.redraw) on.redraw(); },
                }, h("span", { class: "amore-ic", "aria-hidden": "true" })),
                open ? h("div", { class: "amenu", role: "menu", "aria-label": i18nText("activity.more") }, items) : null)));
        });
      },
      /** Close an open bubble menu (a click elsewhere); true when one was open. */
      closeMenu() {
        const was = menuOpen !== null;
        menuOpen = null;
        return was;
      },
    };
    return api;
  }

  const api = { create, MAX, SETTLE_MS };
  if (typeof window !== "undefined") window.DeckOutbox = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
