"use strict";
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
// File chips in the Hermes chat view, window.DeckHermesFiles.create(ctx).
// When an assistant message offers a file (MEDIA:/abs/path or a backticked absolute path), main parses it and the
// history carries `m.files = [{ref, name, media}]`: an opaque ref and a name, never a host path. Each ref is drawn as
// a chip with the file's icon, name, size (looked up lazily, when the chip is first drawn), a Download button with
// progress and Cancel, and, once saved, Open and Show in folder. The page never builds a path and never sends one.
(() => {
  const size = (n) => (n >= 1024 * 1024 * 1024 ? `${(n / 1024 / 1024 / 1024).toFixed(2)} GB` : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
  const extOf = (name) => {
    const m = /\.([A-Za-z0-9]{1,6})$/.exec(String(name || ""));
    return m ? m[1].toUpperCase() : "";
  };
  const MAX_INFO = 3; // size lookups running at once

  /** Per-chip state, kept across re-renders: key = `${sid}:${ref}`. */
  function create(ctx) {
    const { h, deck, mark, cleanErr, VB } = ctx; // VB: the shared voice-bubble player (voice-bubble.js), optional
    const state = new Map(); // key -> {info, error, dl: {ticket, received, size}, saved: {id, name}, busy}
    const queue = [];
    let lookups = 0;
    let seq = 0;
    const get = (key) => {
      let s = state.get(key);
      if (!s) {
        s = { info: null, error: null, dl: null, saved: null, asked: false };
        state.set(key, s);
        while (state.size > 400) state.delete(state.keys().next().value);
      }
      return s;
    };
    const redraw = () => mark("msgs", true);

    function pump() {
      while (lookups < MAX_INFO && queue.length) {
        const job = queue.shift();
        lookups++;
        deck.bridge.file
          .info(job.sid, job.ref, { profile: job.profile })
          .then((info) => {
            job.s.info = info;
          })
          .catch((e) => {
            job.s.error = cleanErr(e);
          })
          .finally(() => {
            lookups--;
            redraw();
            pump();
          });
      }
    }

    deck.bridge.file.onEvent((m) => {
      if (!m || m.t !== "progress") return;
      for (const s of state.values()) {
        if (s.dl && s.dl.ticket === m.ticket) {
          s.dl.received = m.received;
          s.dl.size = m.size;
          redraw();
          break;
        }
      }
    });

    async function download(sid, ref, profile, s) {
      if (s.dl) return;
      const ticket = `dl-${Date.now().toString(36)}-${++seq}`;
      s.dl = { ticket, received: 0, size: s.info ? s.info.size : 0 };
      s.error = null;
      redraw();
      try {
        const r = await deck.bridge.file.download(sid, ref, { ticket, profile });
        if (r && r.status === "done") s.saved = { id: r.id, name: r.name, size: r.size, risky: r.risky };
      } catch (e) {
        s.error = cleanErr(e);
      } finally {
        s.dl = null;
        redraw();
      }
    }

    /** An audio file as an inline voice bubble (voice-bubble.js); a clip that is too big or not audio falls back to the chip. */
    function voiceChip(f, where, s) {
      const name = (s.info && s.info.name) || f.name;
      const status = () => {
        if (s.dl) return `${size(s.dl.received)} / ${size(s.dl.size)}`;
        if (s.error) return s.error;
        if (s.saved) return i18nText("download.saved", { name: s.saved.name });
        return null;
      };
      return VB.bubble({
        id: `h:${where.sid}:${f.ref}`,
        name: VB.looksLikeVoiceNote(name) ? null : name,
        load: async () => {
          const r = await deck.bridge.file.audio(where.sid, f.ref, { profile: where.profile });
          if (!r || !r.ok) throw Object.assign(new Error(i18nText("vb.failed")), { reason: (r && r.reason) || "unavailable" });
          return r;
        },
        menu: () => {
          const items = [{ label: i18nText("download.download"), disabled: !!s.dl, onclick: () => download(where.sid, f.ref, where.profile, s) }];
          if (s.saved) {
            if (!s.saved.risky) items.push({ label: i18nText("download.open"), onclick: () => deck.bridge.file.open(s.saved.id).catch((e) => { s.error = cleanErr(e); redraw(); }) });
            items.push({ label: i18nText("download.reveal"), onclick: () => deck.bridge.file.reveal(s.saved.id).catch((e) => { s.error = cleanErr(e); redraw(); }) });
          }
          if (s.dl) items.push({ label: i18nText("download.cancel"), onclick: () => deck.bridge.file.cancel(s.dl.ticket) });
          return items;
        },
        note: status,
        fallback: () => {
          s.noPlayer = true;
          return fileChip(f, where);
        },
      });
    }

    /** One chip: an inline voice bubble for audio, else the file chip. `where`: {sid, profile}. */
    function chip(f, where) {
      if (VB && deck.bridge.file.audio && VB.isAudio(f.name)) {
        const s = get(`${where.sid}:${f.ref}`);
        if (!s.noPlayer) return voiceChip(f, where, s);
      }
      return fileChip(f, where);
    }

    function fileChip(f, where) {
      const key = `${where.sid}:${f.ref}`;
      const s = get(key);
      if (!s.asked) {
        s.asked = true;
        queue.push({ sid: where.sid, ref: f.ref, profile: where.profile, s });
        pump();
      }
      const name = (s.info && s.info.name) || f.name;
      const meta = [];
      if (s.saved) meta.push(i18nText("download.saved", { name: s.saved.name }));
      else if (s.info) meta.push(size(s.info.size));
      else if (!s.error) meta.push(i18nText("download.checking"));
      const pct = s.dl && s.dl.size ? Math.min(100, Math.round((s.dl.received / s.dl.size) * 100)) : 0;
      const actions = [];
      if (s.dl) {
        actions.push(h("span", { class: "fstatus" }, `${size(s.dl.received)} / ${size(s.dl.size)} · ${pct}%`));
        actions.push(h("button", { class: "btn small", type: "button", onclick: () => deck.bridge.file.cancel(s.dl.ticket) }, i18nText("download.cancel")));
      } else if (s.saved) {
        if (!s.saved.risky) actions.push(h("button", { class: "btn small", type: "button", onclick: () => deck.bridge.file.open(s.saved.id).catch((e) => { s.error = cleanErr(e); redraw(); }) }, i18nText("download.open")));
        actions.push(h("button", { class: "btn small", type: "button", onclick: () => deck.bridge.file.reveal(s.saved.id).catch((e) => { s.error = cleanErr(e); redraw(); }) }, i18nText("download.reveal")));
        actions.push(h("button", { class: "btn small", type: "button", onclick: () => { s.saved = null; download(where.sid, f.ref, where.profile, s); } }, i18nText("download.again")));
      } else if (!s.error || s.info) {
        actions.push(h("button", { class: "btn small primary", type: "button", disabled: !s.info, onclick: () => download(where.sid, f.ref, where.profile, s) }, i18nText("download.download")));
      } else {
        actions.push(h("button", { class: "btn small", type: "button", onclick: () => { s.asked = false; s.error = null; redraw(); } }, i18nText("download.retry")));
      }
      return h(
        "div",
        { class: "file hfile", role: "group", "aria-label": i18nText("download.chipLabel", { name }), dataset: { ref: f.ref } },
        h("div", { class: "ficon" }, extOf(name) || "FILE"),
        h("div", { class: "finfo" }, h("span", { class: "fname", title: name }, name), h("span", { class: "fmeta" }, meta.join(" · "))),
        h("div", { class: "facts" }, ...actions),
        s.dl ? h("span", { class: "att-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) }, h("span", { class: "att-fill", style: { width: `${pct}%` } })) : null,
        s.error ? h("span", { class: "ferr", role: "alert" }, s.error) : null
      );
    }

    /** The chips of one assistant message, or null. */
    function chips(m, where) {
      if (!m || m.role !== "assistant" || !Array.isArray(m.files) || !m.files.length) return null;
      return h("div", { class: "hfiles" }, ...m.files.map((f) => chip(f, where)));
    }

    return { chips, chip, state };
  }

  const api = { create, size, extOf };
  if (typeof window !== "undefined") window.DeckHermesFiles = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api;
})();
