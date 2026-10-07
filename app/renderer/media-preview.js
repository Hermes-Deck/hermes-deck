"use strict";
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
// Images and files the user sent, drawn in the Hermes chat view, window.DeckMediaPreview.create(ctx).
// Hermes stores an attachment as `@image:<path>` / `@file:<path>` lines under the caption; main (media-refs.js) takes
// those lines out of the text and the history carries `m.media = [{kind, name, ref}]`: an opaque ref and a name,
// never a host path. Here:
//   - an image becomes a thumbnail (max 240 px, aspect kept) that loads when it scrolls near the view, is kept in a
//     byte-capped in-memory cache, and opens a lightbox (Esc / backdrop / X close, Save uses the download flow);
//   - an image the host refuses, has lost or that is too big for a preview is a neutral chip with the file name;
//   - any other file is the existing file chip (hermes-files.js).
// The CSP allows data: for images but not blob:, so the cache holds data: URLs and nothing needs revoking: an evicted
// entry simply drops its string.
(() => {
  const CACHE_BYTES = 48 * 1024 * 1024; // data: URL characters kept across all thumbnails
  const CACHE_ENTRIES = 160;
  const MAX_LOADS = 3; // image reads running at once (each is a few host calls)
  const MAX_OBSERVED = 64;

  /** Insertion-ordered LRU with a byte cap; failures count as entries without bytes. */
  function createCache({ maxBytes = CACHE_BYTES, maxEntries = CACHE_ENTRIES } = {}) {
    const map = new Map();
    let total = 0;
    return {
      get(key) {
        const e = map.get(key);
        if (e) {
          map.delete(key);
          map.set(key, e);
        }
        return e;
      },
      set(key, entry) {
        const old = map.get(key);
        if (old) total -= old.bytes || 0;
        map.delete(key);
        map.set(key, entry);
        total += entry.bytes || 0;
        while ((total > maxBytes || map.size > maxEntries) && map.size > 1) {
          const [oldest, e] = map.entries().next().value;
          map.delete(oldest);
          total -= e.bytes || 0;
        }
      },
      delete(key) {
        const e = map.get(key);
        if (e) total -= e.bytes || 0;
        map.delete(key);
      },
      get bytes() {
        return total;
      },
      get size() {
        return map.size;
      },
    };
  }

  function create(ctx) {
    const { h, deck, mark, cleanErr, HF } = ctx;
    const doc = ctx.document || (typeof document !== "undefined" ? document : null);
    const cache = ctx.cache || createCache();
    const inflight = new Set();
    const queue = [];
    const observed = new Set();
    let active = 0;
    let seq = 0;
    let lb = null;
    const redraw = () => mark("msgs", true);

    const io =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(
            (entries) => {
              for (const e of entries) {
                if (!e.isIntersecting) continue;
                io.unobserve(e.target);
                observed.delete(e.target);
                const job = e.target.__mediaJob;
                if (job) request(job.key, job.where, job.a);
              }
            },
            { root: null, rootMargin: "300px 0px" }
          )
        : null;

    function sweep() {
      if (!io || observed.size <= MAX_OBSERVED) return;
      for (const el of observed) {
        if (el.isConnected === false) {
          io.unobserve(el);
          observed.delete(el);
        }
      }
    }

    function pump() {
      while (active < MAX_LOADS && queue.length) {
        const job = queue.shift();
        active++;
        deck.bridge.file
          .image(job.where.sid, job.a.ref, { profile: job.where.profile })
          .then((r) => {
            if (r && r.ok && typeof r.url === "string" && r.url.startsWith("data:image/")) cache.set(job.key, { state: "ok", url: r.url, bytes: r.url.length, mime: r.mime });
            else cache.set(job.key, { state: "fail", reason: r && r.reason === "too-big" ? "too-big" : r && r.reason === "not-image" ? "not-image" : "unavailable", bytes: 0 });
          })
          .catch(() => cache.set(job.key, { state: "fail", reason: "unavailable", bytes: 0 }))
          .finally(() => {
            active--;
            inflight.delete(job.key);
            redraw();
            pump();
          });
      }
    }

    function request(key, where, a) {
      if (inflight.has(key) || cache.get(key)) return;
      inflight.add(key);
      queue.push({ key, where, a });
      pump();
    }

    // ------------------------------------------------------------------ lightbox (the shared .lightbox styles)
    function closeLightbox() {
      if (!lb) return;
      lb.root.remove();
      const back = lb.back;
      lb = null;
      if (back && back.isConnected && typeof back.focus === "function") back.focus();
    }

    /** `item`: {name, url, save?: () => Promise<{name}>}. */
    function openLightbox(item) {
      closeLightbox();
      const back = doc.activeElement;
      const status = h("span", { class: "lb-status", role: "status" });
      const close = h("button", { class: "lb-x", type: "button", "aria-label": i18nText("media.close"), title: i18nText("media.close"), onclick: () => closeLightbox() }, "✕");
      let saving = false;
      const save = item.save
        ? h(
            "button",
            {
              class: "btn small",
              type: "button",
              onclick: async () => {
                if (saving) return;
                saving = true;
                save.disabled = true;
                status.textContent = i18nText("media.saving");
                try {
                  const r = await item.save();
                  status.textContent = r && r.name ? i18nText("download.saved", { name: r.name }) : "";
                } catch (e) {
                  status.textContent = cleanErr(e);
                } finally {
                  saving = false;
                  save.disabled = false;
                }
              },
            },
            i18nText("media.save")
          )
        : null;
      const img = h("img", { class: "lb-img", alt: item.name, draggable: "false", src: item.url });
      const stage = h("div", { class: "lb-stage" }, img);
      const root = h(
        "div",
        { class: "lightbox", role: "dialog", "aria-modal": "true", "aria-label": i18nText("media.lightbox", { name: item.name }) },
        h("div", { class: "lb-bar" }, status, save, close),
        stage,
        h("p", { class: "lb-cap" }, item.name)
      );
      root.addEventListener("click", (e) => {
        if (e.target === root || e.target === stage) closeLightbox();
      });
      root.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeLightbox();
        } else if (e.key === "Tab") {
          e.preventDefault();
          const f = [save, close].filter(Boolean);
          f[(f.indexOf(doc.activeElement) + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
        }
      });
      doc.body.appendChild(root);
      lb = { root, back };
      close.focus();
      return root;
    }

    // ------------------------------------------------------------------ pieces
    const thumbButton = (name, url, onOpen, many) =>
      h(
        "button",
        { class: `mthumb${many ? " many" : ""}`, type: "button", "aria-label": i18nText("media.open", { name }), title: name, onclick: onOpen },
        h("img", { class: "mthumb-img", src: url, alt: "", draggable: "false", decoding: "async" })
      );

    const neutralChip = (a, text, retry) =>
      h(
        "div",
        { class: "mchip", role: "group", "aria-label": `${text}: ${a.name}`, dataset: { ref: a.ref || "" } },
        h("span", { class: "mchip-ico", "aria-hidden": "true" }, "▣"),
        h("span", { class: "mchip-text" }, h("span", { class: "mchip-title" }, text), h("span", { class: "mchip-name", title: a.name }, a.name)),
        retry ? h("button", { class: "btn small", type: "button", onclick: retry }, i18nText("media.retry")) : null
      );

    function imageTile(a, where, many) {
      if (!a.ref) return neutralChip(a, i18nText("media.unavailable"));
      const key = `${where.sid}:${a.ref}`;
      const e = cache.get(key);
      if (e && e.state === "ok") {
        const save = async () => {
          const ticket = `dl-${Date.now().toString(36)}-${++seq}`;
          const r = await deck.bridge.file.download(where.sid, a.ref, { ticket, profile: where.profile });
          return r && r.status === "done" ? { name: r.name } : null;
        };
        return thumbButton(a.name, e.url, () => openLightbox({ name: a.name, url: e.url, save }), many);
      }
      if (e && e.state === "fail") {
        if (e.reason === "too-big" && HF) return HF.chip({ ref: a.ref, name: a.name }, where); // a download chip instead
        return neutralChip(a, i18nText(e.reason === "not-image" ? "media.notImage" : "media.unavailable"), () => {
          cache.delete(key);
          redraw();
        });
      }
      const ph = h("div", { class: `mthumb-ph${many ? " many" : ""}`, role: "img", "aria-label": `${i18nText("media.loading")}: ${a.name}`, dataset: { ref: a.ref } });
      if (io) {
        ph.__mediaJob = { key, where, a };
        observed.add(ph);
        io.observe(ph);
        sweep();
      } else {
        request(key, where, a);
      }
      return ph;
    }

    /** The attachments of one stored user message, or null. `where`: {sid, profile}. */
    function strip(m, where) {
      if (!m || m.role !== "user" || !Array.isArray(m.media) || !m.media.length) return null;
      const images = m.media.filter((a) => a.kind === "image");
      const many = images.length > 1;
      const kids = m.media.map((a) => {
        if (a.kind === "image") return imageTile(a, where, many);
        if (!a.ref) return neutralChip(a, i18nText("media.fileUnavailable"));
        return HF ? HF.chip({ ref: a.ref, name: a.name }, where) : neutralChip(a, i18nText("media.unavailable"));
      });
      return h("div", { class: "mmedia", dataset: { count: String(m.media.length) } }, ...kids);
    }

    /** The thumbnails of a just-sent message, from the tray's own previews (until the stored row replaces it). */
    function echo(previews, names) {
      const list = (previews || []).map((url, i) => ({ url, name: (names && names[i]) || "" })).filter((x) => typeof x.url === "string" && x.url.startsWith("data:image/"));
      if (!list.length) return null;
      const many = list.length > 1;
      return h("div", { class: "mmedia", dataset: { count: String(list.length), echo: "1" } }, ...list.map((x) => thumbButton(x.name || i18nText("media.lightbox", { name: "" }).trim(), x.url, () => openLightbox({ name: x.name, url: x.url }), many)));
    }

    return { strip, echo, openLightbox, closeLightbox, cache, request, pending: () => ({ inflight: inflight.size, queued: queue.length, active }) };
  }

  const api = { create, createCache, CACHE_BYTES, CACHE_ENTRIES, MAX_LOADS };
  if (typeof window !== "undefined") window.DeckMediaPreview = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api;
})();
