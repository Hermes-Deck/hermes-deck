"use strict";
var i18nNode = (key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).node(key, vars, typeof document === "object" ? document : null);
var i18nBind = (el, attr, key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).bind(el, attr, key, vars);
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
var i18nLocale = typeof module === "object" && module.exports ? require("./i18n").getLocale : window.DeckI18n.getLocale;
// Hermes Deck message view (window.DeckMsgView.create(ctx)). Builds one Telegram message as DOM and
// owns the chat pieces around messages: media (lazy thumbnails, lightbox, files, audio, stickers,
// videos), group senders (photo, stable name colour, owner/admin badge), reply quotes, inline
// keyboards, Bot API rich messages (blocks from main/telegram.js richOf, with a "Open in Telegram"
// note only for parts that cannot be drawn), markdown text, the right-click menu, the reply bar and toasts.
// app.js keeps the state (S) and the render scheduling; this file reads S and reaches the main process
// only through deck.*. Message strings always enter the DOM as text nodes.
(() => {
  const MAX_FULL = 25 * 1024 * 1024; // main refuses full downloads above this
  const PALETTE = 6; // name colours, see messages.css (--who-0..5)
  const INLINE_IMAGE = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
  // opened only through "Download": main refuses "Open" for these (media.isRisky); its list comes with deck.ready()
  // as S.riskyExt, so the button is hidden for exactly the same names (security audit L9)
  const risky = (S, name) => {
    const m = /\.([^.\\/]+)$/.exec(String(name || ""));
    return !!(m && S.riskyExt && S.riskyExt.has(m[1].toLowerCase()));
  };

  function create(ctx) {
    const { h, S, deck, els, renderText, hm, mediaLabel, cleanErr, VB } = ctx; // VB: voice-bubble.js, optional
    const chat = document.getElementById("chat");

    // ---------------------------------------------------------------- helpers
    const bytes = (n) => {
      if (!n && n !== 0) return "";
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
      return `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
    };
    const clock = (sec) => {
      const s = Math.max(0, Math.round(sec || 0));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    /** First non-empty line as plain text (markdown markers dropped), else the media label: for quotes and the reply bar. */
    const firstLine = (r) => {
      const md = (!r.ents || !r.ents.length) && window.DeckMarkdown && window.DeckMarkdown.looksLike(r.text || "");
      const lines = (r.text || "").split("\n").map((x) => x.trim());
      let t = lines.find((x) => x && !(md && /^(`{3,}|~{3,}|\|?[\s:|-]+\|?$)/.test(x))) || "";
      if (md) t = t.replace(/^(#{1,6}|>|[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "").replace(/\*\*|__|~~|`/g, "").replace(/\s*\|\s*/g, " · ").replace(/^ · | · $/g, "");
      return (t || mediaLabel(r.media) || "").slice(0, 140);
    };
    const initial = (name) => (Array.from(String(name || "?").trim())[0] || "?").toUpperCase();
    /** Stable colour class per sender id (or name when the id is unknown). */
    const hue = (id) => {
      let x = 0;
      for (const ch of String(id || "?")) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
      return `hue-${x % PALETTE}`;
    };
    const person = (id) => (S.people && id && S.people[id]) || {};
    const msgOf = (key, id) => {
      const map = S.msgs.get(key);
      return map ? map.get(Number(id)) || null : null;
    };
    const sameDay = (a, b) => new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
    /** Fit a w x h box into maxW x maxH without enlarging it; returns the display width and the CSS aspect ratio. */
    const fit = (w, ht, maxW, maxH) => {
      const W = w > 0 ? w : 4;
      const H = ht > 0 ? ht : 3;
      const s = Math.min(1, maxW / W, maxH / H);
      return { w: Math.max(96, Math.round(W * s)), ar: `${W} / ${H}` };
    };

    /** t.me link for a message: group messages by id, bot DMs open the bot chat (private chats have no message links). */
    function tgLink(m) {
      if (m.key[0] === "t") {
        const g = S.tg.group;
        const cid = g ? String(g.id).replace(/^-100/, "") : "";
        if (!/^\d+$/.test(cid)) return null;
        const tid = Number(m.key.slice(1));
        return tid > 1 ? `https://t.me/c/${cid}/${tid}/${m.id}` : `https://t.me/c/${cid}/${m.id}`;
      }
      const bot = S.tg.bots.find((b) => b.key === m.key);
      return bot && bot.username ? `https://t.me/${bot.username}` : null;
    }

    async function copy(text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = h("textarea", { class: "sr-only", readonly: true });
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
    }

    // ---------------------------------------------------------------- toasts
    let toastHost = null;
    function toast(text, bad = false) {
      if (!toastHost) {
        toastHost = h("div", { class: "toasts", "aria-live": "polite" });
        chat.appendChild(toastHost);
      }
      // just above the message list, whatever sits below it (strip, reply bar, a tall composer)
      const gap = chat.getBoundingClientRect().bottom - els.msgs.getBoundingClientRect().bottom;
      toastHost.style.setProperty("bottom", `${Math.max(12, Math.round(gap + 12))}px`);
      const t = h("div", { class: `toast${bad ? " bad" : ""}`, role: bad ? "alert" : "status" }, text);
      toastHost.appendChild(t);
      setTimeout(() => t.classList.add("out"), bad ? 6000 : 4000);
      setTimeout(() => t.remove(), bad ? 6400 : 4400);
    }

    // ---------------------------------------------------------------- media loading
    // Media is fetched once per message+variant; images come back as data: URLs, audio as bytes that
    // become a blob: URL. Thumbnails load when they scroll near the view. m.ref ("p0", "d1") marks a
    // rich message's photo or document: the media builders below get a stand-in record carrying it.
    const got = new Map(); // "key:id[:ref]:variant" -> Promise<{type, url?, name?, size?}>
    const mkey = (m) => `${m.key}:${m.id}${m.ref ? `:${m.ref}` : ""}`;
    function fetchMedia(m, variant) {
      const k = `${mkey(m)}:${variant}`;
      if (!got.has(k)) {
        const p = deck.media(m.key, m.id, variant, m.ref || undefined).then((r) => {
          if (r && r.type === "audio") return { type: "audio", url: URL.createObjectURL(new Blob([r.bytes], { type: r.mime })) };
          return r;
        });
        p.catch(() => got.delete(k)); // a failed load may be retried later
        got.set(k, p);
      }
      return got.get(k);
    }

    const pending = new WeakMap();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          const fn = pending.get(e.target);
          pending.delete(e.target);
          if (fn) fn();
        }
      },
      { root: els.msgs, rootMargin: "600px 0px" }
    );
    const lazy = (el, fn) => {
      pending.set(el, fn);
      io.observe(el);
    };

    // Media blocks are reused across re-renders (keyed by message), so a loaded picture never blinks and
    // a playing voice message keeps playing when a new message arrives.
    const nodes = new Map(); // "key:id[:ref]" -> {sig, el}
    function mediaNode(m) {
      const k = mkey(m);
      const sig = JSON.stringify(m.media);
      const hit = nodes.get(k);
      if (hit && hit.sig === sig) return hit.el;
      const el = buildMedia(m);
      nodes.delete(k);
      nodes.set(k, { sig, el });
      if (nodes.size > 600) nodes.delete(nodes.keys().next().value);
      return el;
    }

    function buildMedia(m) {
      const md = m.media;
      switch (md.kind) {
        case "photo":
          return md.gone || md.ttl ? h("div", { class: "media" }, md.ttl ? i18nNode("U0823") : i18nNode("U0824")) : photo(m);
        case "sticker":
          return sticker(m);
        case "voice":
        case "audio":
          return audio(m);
        case "video":
        case "round":
        case "gif":
          return video(m);
        case "file":
          return md.gone ? h("div", { class: "media" }, i18nNode("U0825")) : file(m);
        case "unsupported":
          return richFallback(m);
        default:
          return h("div", { class: "media" }, `[${mediaLabel(md)}${md.title ? `: ${md.title}` : ""}]`);
      }
    }

    function photo(m) {
      const md = m.media;
      const { w, ar } = fit(md.w, md.h, 340, 380);
      const img = h("img", { alt: "", draggable: "false", decoding: "async" });
      const el = h(
        "button",
        { class: `ph loading${md.spoiler ? " spoiler" : ""}`, type: "button", "aria-label": md.spoiler ? i18nText("U0826") : i18nText("U0827"), style: { "--w": `${w}px`, "aspect-ratio": ar } },
        img,
        md.spoiler ? h("span", { class: "ph-veil" }, i18nNode("U0828")) : null
      );
      el.addEventListener("click", () => {
        if (el.classList.contains("spoiler")) {
          el.classList.remove("spoiler");
          i18nBind(el, "aria-label", "U0827");
          const veil = el.querySelector(".ph-veil");
          if (veil) veil.remove();
          return;
        }
        openLightbox(m, img.getAttribute("src"));
      });
      lazy(el, () =>
        fetchMedia(m, "thumb")
          .then((r) => {
            if (r.type !== "image") throw new Error(i18nText("U0829"));
            img.src = r.url;
            el.classList.remove("loading");
          })
          .catch(() => {
            el.classList.remove("loading");
            el.classList.add("failed");
            el.appendChild(h("span", { class: "ph-err" }, i18nNode("U0830")));
          })
      );
      return el;
    }

    function sticker(m) {
      const md = m.media;
      const el = h("div", { class: "stk", title: md.alt ? i18nText("U0831", { alt: md.alt }) : i18nText("U0832") });
      const alt = () => el.replaceChildren(h("span", { class: "stk-alt", role: "img", "aria-label": i18nText("U0275") , "data-i18n-aria-label": "U0275"}, md.alt || "◆"));
      const variant = INLINE_IMAGE.has(md.mime) && (md.size || 0) < 1024 * 1024 ? "full" : md.thumb ? "thumb" : null;
      if (!variant) {
        alt();
        return el;
      }
      const img = h("img", { alt: md.alt ? i18nText("U0833", { alt: md.alt }) : i18nText("U0275"), draggable: "false" });
      el.appendChild(img);
      lazy(el, () =>
        fetchMedia(m, variant)
          .then((r) => {
            if (r.type !== "image") throw new Error(i18nText("U0834"));
            img.src = r.url;
          })
          .catch(alt)
      );
      return el;
    }

    /** Telegram voice notes and audio as the inline voice bubble (voice-bubble.js); TDLib's own waveform/duration draw it before the clip loads. */
    function voiceBubble(m) {
      const md = m.media;
      const voice = md.kind === "voice";
      const label = voice ? null : [md.performer, md.title].filter(Boolean).join(" – ") || md.name || i18nText("A0253");
      return VB.bubble({
        id: `t:${mkey(m)}`,
        name: label,
        duration: md.dur > 0 ? md.dur : 0,
        waveform: voice ? VB.decodeWaveform(md.wave) : null,
        load: async () => {
          const r = await deck.media(m.key, m.id, "full", m.ref || undefined);
          if (!r || r.type !== "audio") throw Object.assign(new Error(i18nText("U0836")), { reason: "not-audio" });
          return r;
        },
        menu: () => {
          const run = (fn, done) => fn().then((ok) => ok && done && toast(done)).catch((e) => toast(cleanErr(e), true));
          const items = [];
          if (!risky(S, md.name)) items.push({ label: i18nText("U0842"), onclick: () => run(() => deck.mediaOpen(m.key, m.id, m.ref || undefined)) });
          items.push({ label: i18nText("U0843"), onclick: () => run(() => deck.mediaSave(m.key, m.id, m.ref || undefined), i18nText("common.saved")) });
          return items;
        },
        fallback: () => audio(m, true),
      });
    }

    function audio(m, plain = false) {
      const md = m.media;
      if (VB && !plain && (md.size || 0) <= MAX_FULL) return voiceBubble(m);
      const voice = md.kind === "voice";
      const label = voice ? i18nText("A0350") : [md.performer, md.title].filter(Boolean).join(" – ") || md.name || i18nText("A0253");
      const meta = [md.dur ? clock(md.dur) : null, md.size ? bytes(md.size) : null].filter(Boolean).join(" · ");
      const el = h("div", { class: `aud${voice ? " voice" : ""}` }, h("div", { class: "aud-head" }, h("span", { class: "aud-name" }, label), meta ? h("span", { class: "aud-meta" }, meta) : null));
      if ((md.size || 0) > MAX_FULL) {
        el.appendChild(h("div", { class: "facts" }, h("span", { class: "fnote" }, i18nNode("U0835")), tgButton(m)));
        return el;
      }
      const player = h("audio", { controls: true, preload: "metadata" });
      const load = () =>
        fetchMedia(m, "full")
          .then((r) => {
            if (r.type !== "audio") throw new Error(i18nText("U0836"));
            player.src = r.url;
            player.hidden = false;
          })
          .catch((e) => el.appendChild(h("span", { class: "ferr" }, i18nNode("U0837", { e: cleanErr(e) }))));
      el.appendChild(player);
      if ((md.size || 0) > 5 * 1024 * 1024) {
        // a large audio file is fetched only when asked for
        player.hidden = true;
        const btn = h("button", { class: "btn small", type: "button", onclick: () => (btn.remove(), load()) }, i18nNode("U0838", { size: bytes(md.size) }));
        el.appendChild(btn);
      } else lazy(el, load);
      return el;
    }

    function video(m) {
      const md = m.media;
      const round = md.kind === "round";
      const { w, ar } = round ? { w: 200, ar: "1 / 1" } : fit(md.w || 16, md.h || 9, 340, 340);
      const img = md.thumb ? h("img", { alt: "", draggable: "false" }) : null;
      const pic = h(
        "button",
        { class: `vid${round ? " round" : ""}${img ? " loading" : " blank"}`, type: "button", "aria-label": i18nText("U0839", { md: mediaLabel(md) }), style: { "--w": `${w}px`, "aspect-ratio": ar } , "data-i18n-aria-label": "U0839", "data-i18n-aria-label-vars": JSON.stringify({ md: mediaLabel(md) })},
        img,
        h("span", { class: "vid-badge" }, `${md.kind === "gif" ? "GIF" : "▶"}${md.dur ? ` ${clock(md.dur)}` : ""}`)
      );
      if (img) {
        lazy(pic, () =>
          fetchMedia(m, "thumb")
            .then((r) => {
              if (r.type === "image") img.src = r.url;
              pic.classList.remove("loading");
            })
            .catch(() => {
              pic.classList.remove("loading");
              pic.classList.add("blank");
            })
        );
      }
      const acts = fileActions(m, true);
      pic.addEventListener("click", () => {
        const open = acts.querySelector("button[data-act='open']");
        if (open) open.click();
      });
      return h("div", { class: "vidbox" }, pic, acts);
    }

    function file(m) {
      const md = m.media;
      const extM = /\.([a-z0-9]{1,5})$/i.exec(md.name || "");
      const ext = extM ? extM[1] : (md.mime || "").split("/")[1] || "";
      const icon = h("span", { class: "ficon", "aria-hidden": "true" }, (ext || i18nText("common.file")).slice(0, 4).toUpperCase());
      if (md.thumb) {
        lazy(icon, () =>
          fetchMedia(m, "thumb")
            .then((r) => {
              if (r.type === "image") icon.replaceChildren(h("img", { src: r.url, alt: "" }));
            })
            .catch(() => {})
        );
      }
      return h(
        "div",
        { class: "file" },
        icon,
        h("div", { class: "finfo" }, h("span", { class: "fname", title: md.name || "" }, md.name || i18nNode("A0078")), h("span", { class: "fmeta" }, [bytes(md.size), md.mime].filter(Boolean).join(" · "))),
        fileActions(m)
      );
    }

    /**
     * "Open" (default app; downloads into the cache first) and "Download" (save as). Over 25 MB: Telegram only.
     * sized: the block above shows no size line (videos), so the note carries it.
     */
    function fileActions(m, sized = false) {
      const md = m.media;
      if ((md.size || 0) > MAX_FULL) {
        const note = i18nText("U0840", { v: sized ? `${bytes(md.size)} · ` : "" });
        return h("div", { class: "facts" }, h("span", { class: "fnote" }, note), tgButton(m));
      }
      const status = h("span", { class: "fstatus", role: "status" });
      const acts = h("div", { class: "facts" });
      const run = async (fn, done) => {
        const btns = acts.querySelectorAll("button");
        btns.forEach((b) => (b.disabled = true));
        i18nBind(status, "textContent", "U0841");
        try {
          const ok = await fn();
          if (ok && done) toast(done);
        } catch (e) {
          toast(cleanErr(e), true);
        } finally {
          status.textContent = "";
          btns.forEach((b) => (b.disabled = false));
        }
      };
      if (!risky(S, md.name)) {
        acts.appendChild(h("button", { class: "btn small", type: "button", dataset: { act: "open" }, onclick: () => run(() => deck.mediaOpen(m.key, m.id, m.ref || undefined)) }, i18nNode("U0842")));
      }
      acts.appendChild(h("button", { class: "btn small", type: "button", dataset: { act: "save" }, onclick: () => run(() => deck.mediaSave(m.key, m.id, m.ref || undefined), i18nText("common.saved")) }, i18nNode("U0843")));
      acts.appendChild(status);
      return acts;
    }

    function tgButton(m) {
      const url = tgLink(m);
      return url ? h("button", { class: "btn small", type: "button", onclick: () => deck.openExternal(url) }, i18nNode("U0844")) : null;
    }

    /** MessageMediaUnsupported: content newer than the client's layer (229); rich messages render as blocks. */
    function richFallback(m) {
      return h("div", { class: "rich-fb" }, h("span", { class: "rich-fb-text" }, i18nNode("U0845")), tgButton(m));
    }

    // ---------------------------------------------------------------- lightbox
    let lb = null;
    function openLightbox(m, placeholder) {
      closeLightbox();
      const back = document.activeElement;
      const img = h("img", { class: "lb-img", alt: m.text ? m.text.slice(0, 140) : i18nText("U0846"), draggable: "false" });
      if (placeholder) img.src = placeholder;
      const status = h("span", { class: "lb-status", role: "status" }, i18nNode("U0847"));
      const close = h("button", { class: "lb-x", type: "button", "aria-label": i18nText("A0197"), title: i18nText("A0351"), onclick: () => closeLightbox() , "data-i18n-aria-label": "A0197", "data-i18n-title": "A0351"}, "✕");
      const save = h("button", { class: "btn small", type: "button", onclick: () => saveMedia(m) }, i18nNode("U0843"));
      const stage = h("div", { class: "lb-stage" }, img);
      const root = h(
        "div",
        { class: "lightbox", role: "dialog", "aria-modal": "true", "aria-label": i18nText("U0846") , "data-i18n-aria-label": "U0846"},
        h("div", { class: "lb-bar" }, status, save, close),
        stage,
        m.text ? h("p", { class: "lb-cap" }, m.text.length > 300 ? `${m.text.slice(0, 300)}…` : m.text) : null
      );
      root.addEventListener("click", (e) => {
        if (e.target === root || e.target === stage) closeLightbox();
      });
      root.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          closeLightbox();
        } else if (e.key === "Tab") {
          // keep focus inside the dialog
          e.preventDefault();
          const f = [save, close];
          f[(f.indexOf(document.activeElement) + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
        }
      });
      document.body.appendChild(root);
      lb = { root, back };
      close.focus();
      if (!placeholder) {
        fetchMedia(m, "thumb")
          .then((r) => {
            if (lb && lb.root === root && !img.getAttribute("src") && r.type === "image") img.src = r.url;
          })
          .catch(() => {});
      }
      fetchMedia(m, "full")
        .then((r) => {
          if (r.type !== "image") throw new Error(i18nText("U0848"));
          img.src = r.url;
          status.textContent = "";
        })
        .catch((e) => (i18nBind(status, "textContent", "U0849", { e: cleanErr(e) })));
    }

    function closeLightbox() {
      if (!lb) return;
      const { root, back } = lb;
      lb = null;
      root.remove();
      if (back && back.isConnected) back.focus({ preventScroll: true });
    }

    async function saveMedia(m) {
      try {
        if (await deck.mediaSave(m.key, m.id, m.ref || undefined)) toast(i18nText("common.saved"));
      } catch (e) {
        toast(cleanErr(e), true);
      }
    }

    // ---------------------------------------------------------------- senders, replies, buttons
    function whoLine(m) {
      const p = person(m.fromId);
      const badge = p.rank || (p.role === "owner" ? i18nText("common.owner") : p.role === "admin" ? i18nText("U0850") : null);
      return h(
        "div",
        { class: `who ${hue(m.fromId || m.from)}` },
        h("span", { class: "who-name" }, m.from || i18nNode("A0352")),
        badge ? h("span", { class: `role${p.role === "owner" ? " owner" : ""}`, title: p.role === "owner" ? i18nText("A0353") : i18nText("U0851") }, badge) : null
      );
    }

    function avatar(m) {
      const p = person(m.fromId);
      const url = p.avatar || (m.fromId && S.avatars[`u${m.fromId}`]) || null;
      return h("span", { class: `sav ${hue(m.fromId || m.from)}`, "aria-hidden": "true" }, url ? h("img", { src: url, alt: "", draggable: "false" }) : initial(m.from));
    }

    function quote(m) {
      const r = m.replyToId ? msgOf(m.key, m.replyToId) : null;
      const who = r ? (r.out ? i18nText("A0354") : r.from || i18nText("A0352")) : null;
      const line = m.replyQuote ? m.replyQuote.split("\n")[0] : r ? firstLine(r) : i18nText("U0852");
      return h(
        "button",
        {
          class: `rq ${r ? (r.out ? "hue-me" : hue(r.fromId || r.from)) : ""}`,
          type: "button",
          title: r ? i18nText("U0853") : i18nText("U0854"),
          onclick: (e) => {
            e.stopPropagation();
            jumpTo(m.key, m.replyToId);
          },
        },
        who ? h("span", { class: "rq-who" }, who) : null,
        h("span", { class: "rq-text" }, line)
      );
    }

    let flash = null;
    function jumpTo(key, id) {
      if (!id) return;
      const target = els.msgsInner.querySelector(`.msg[data-mid="${Number(id)}"]`);
      if (!target) return toast(i18nText("U0855"));
      flash = { key, id: Number(id), until: Date.now() + 1600 };
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.remove("flash");
      void target.offsetWidth; // restart the highlight animation
      target.classList.add("flash");
      focusMsg(target, true);
    }

    const busyBtn = new Set(); // "key:id:where:row:col" of callback buttons waiting for the bot
    function keyboard(m) {
      return h(
        "div",
        { class: "kb", role: "group", "aria-label": i18nText("U0856") , "data-i18n-aria-label": "U0856"},
        m.buttons.map((row, r) => h("div", { class: "kb-row" }, row.map((b, c) => kbButton(m, b, r, c))))
      );
    }

    /** where: "kb" for the inline keyboard, "rich" for a button row inside a rich message (r = its row number). */
    function kbButton(m, b, r, c, where = "kb") {
      const base = { class: `kb-btn ${b.t}${b.tone ? ` tone-${b.tone}` : ""}`, type: "button" };
      if (b.t === "url") {
        const ok = /^https?:\/\//i.test(b.url || "");
        return h(
          "button",
          { ...base, title: b.url, onclick: () => (ok ? deck.openExternal(b.url) : toast(i18nText("U0857"))) },
          h("span", { class: "kb-label" }, b.text),
          h("span", { class: "kb-ico", "aria-hidden": "true" }, "↗")
        );
      }
      if (b.t === "cb") {
        const id = `${m.key}:${m.id}:${where}:${r}:${c}`;
        return h(
          "button",
          { ...base, class: `${base.class}${busyBtn.has(id) ? " busy" : ""}`, "aria-busy": busyBtn.has(id) ? "true" : null, onclick: (e) => press(m, r, c, e.currentTarget, where) },
          h("span", { class: "kb-label" }, b.text)
        );
      }
      if (b.t === "copy") {
        return h(
          "button",
          { ...base, title: i18nText("A0195"), onclick: () => copy(b.copy || "").then(() => toast(i18nText("U0668"))) , "data-i18n-title": "A0195"},
          h("span", { class: "kb-label" }, b.text),
          h("span", { class: "kb-ico", "aria-hidden": "true" }, "⧉")
        );
      }
      return h("button", { ...base, disabled: true, title: i18nText("U0415") , "data-i18n-title": "U0415"}, h("span", { class: "kb-label" }, b.text));
    }

    /** A callback button runs only on the user's click; the bot's answer shows as a toast. */
    async function press(m, r, c, btn, where = "kb") {
      const id = `${m.key}:${m.id}:${where}:${r}:${c}`;
      if (busyBtn.has(id)) return;
      busyBtn.add(id);
      btn.classList.add("busy");
      btn.setAttribute("aria-busy", "true");
      try {
        const a = await deck.callback(m.key, m.id, r, c, where);
        if (a && a.timeout) toast(i18nText("U0858"));
        else toast((a && a.message) || i18nText("U0859"));
      } catch (e) {
        toast(i18nText("U0860", { e: cleanErr(e) }), true);
      } finally {
        busyBtn.delete(id);
        btn.classList.remove("busy");
        btn.removeAttribute("aria-busy");
      }
    }

    function textEl(m) {
      const md = window.DeckMarkdown;
      if ((!m.ents || !m.ents.length) && md && md.looksLike(m.text)) {
        const d = h("div", { class: "text md" });
        d.appendChild(md.render(m.text));
        return d;
      }
      return h("div", { class: "text" }, renderText(m.text, m.ents));
    }

    // ---------------------------------------------------------------- rich messages
    // m.rich comes from main/telegram.js richOf(): blocks with text runs {text, ents} in the message
    // entity shapes (drawn by renderText), media blocks with a ref that the media builders above load
    // through a stand-in record, and button rows numbered for "rich" callbacks. A built message is
    // reused across list renders (like media nodes) so an opened "Thinking" or details block stays open.
    const RICH_DEPTH = 20;
    const richNodes = new Map(); // "key:id" -> {sig, el}
    const run = (r) => (r && r.text ? renderText(r.text, r.ents || []) : null);
    const webUrl = (u) => (/^https?:\/\/[^\s]+$/i.test(String(u || "")) ? String(u) : null);
    const longDate = (ts) => new Date(ts * 1000).toLocaleDateString(i18nLocale(), { day: "numeric", month: "long", year: "numeric" });

    function richEl(m) {
      const k = `${m.key}:${m.id}`;
      const sig = JSON.stringify([m.rich, m.edit]);
      const hit = richNodes.get(k);
      if (hit && hit.sig === sig) return hit.el;
      const r = m.rich;
      const st = { gaps: 0 };
      const el = h("div", { class: "text md rich", dir: r.rtl ? "rtl" : null });
      richInto(el, m, r.blocks, 0, st);
      if (r.part || r.cut || (r.gaps || 0) > st.gaps) el.appendChild(richNote(m, r));
      richNodes.delete(k);
      richNodes.set(k, { sig, el });
      if (richNodes.size > 200) richNodes.delete(richNodes.keys().next().value);
      return el;
    }

    function richInto(parent, m, blocks, depth, st) {
      if (depth > RICH_DEPTH) return;
      for (const b of blocks || []) {
        const node = b && typeof b === "object" ? richBlock(m, b, depth, st) : null;
        if (node) parent.appendChild(node);
      }
    }

    function richBlock(m, b, depth, st) {
      switch (b.t) {
        case "h":
          return h(`h${Math.min(6, Math.max(1, Number(b.n) || 3))}`, null, run(b.text));
        case "p":
          return h("p", null, run(b.text));
        case "kicker":
          return h("p", { class: "r-kicker" }, run(b.text));
        case "footer":
          return h("p", { class: "r-footer" }, run(b.text));
        case "byline":
          return h("p", { class: "r-byline" }, run(b.text), b.date ? `${b.text ? " · " : ""}${longDate(b.date)}` : null);
        case "pre":
          return h(
            "pre",
            { class: b.math ? "r-math" : null, tabindex: "0", "aria-label": b.math ? i18nText("U0861") : b.lang ? i18nText("common.codeLanguage", { lang: b.lang }) : i18nText("A0228") },
            h("code", null, String(b.code || ""))
          );
        case "hr":
          return h("hr");
        case "ul":
        case "ol":
          return richList(m, b, depth, st);
        case "quote": {
          const q = h("blockquote", { class: b.pull ? "r-pull" : null }, b.text ? h("p", null, run(b.text)) : null);
          richInto(q, m, b.blocks, depth + 1, st);
          if (b.caption) q.appendChild(h("footer", null, run(b.caption)));
          return q;
        }
        case "table":
          return richTable(b);
        case "details": {
          const d = h("details", { open: b.open ? true : null }, h("summary", null, run(b.title) || i18nNode("U0862")));
          richInto(d, m, b.blocks, depth + 1, st);
          return d;
        }
        case "think": // the bot's reasoning: folded away, one click to read
          return h("details", { class: "r-think" }, h("summary", null, i18nNode("U0863")), h("p", null, run(b.text)));
        case "media":
          return richFigure(m, b);
        case "gallery": {
          const g = h("div", { class: "r-gallery" });
          richInto(g, m, b.items, depth + 1, st);
          return b.caption ? h("figure", { class: "r-fig" }, g, h("figcaption", null, run(b.caption))) : g;
        }
        case "embed":
          return webUrl(b.url) ? h("p", { class: "r-embed" }, link(b.url, b.url), b.caption ? h("span", { class: "r-cap" }, " — ", run(b.caption)) : null) : null;
        case "links":
          return h(
            "div",
            { class: "r-links" },
            b.title ? h("p", { class: "r-kicker" }, run(b.title)) : null,
            h("ul", null, (b.items || []).map((a) => h("li", null, webUrl(a.url) ? link(a.url, a.title || a.url) : a.title || "", a.desc ? h("span", { class: "r-cap" }, ` — ${a.desc}`) : null)))
          );
        case "map":
          return richMap(b);
        case "buttons":
          return h(
            "div",
            { class: `kb r-btns${b.align ? ` align-${b.align}` : ""}`, role: "group", "aria-label": i18nText("U0856") , "data-i18n-aria-label": "U0856"},
            h("div", { class: "kb-row" }, (b.buttons || []).map((x, c) => kbButton(m, x, Number(b.row) || 0, c, "rich")))
          );
        default: // "gap": a part this view cannot draw
          st.gaps++;
          return h("div", { class: "rich-fb r-gap" }, h("span", { class: "rich-fb-text" }, i18nNode("U0864")), tgButton(m));
      }
    }

    function richList(m, b, depth, st) {
      const ol = b.t === "ol";
      const list = h(ol ? "ol" : "ul", { start: ol && b.start ? String(b.start) : null, reversed: ol && b.reversed ? true : null });
      for (const it of b.items || []) {
        const task = it.check === true || it.check === false;
        const li = h("li", { class: task ? "task" : null });
        if (ol && it.num && /^\d{1,9}$/.test(it.num)) li.value = Number(it.num);
        else if (it.num) li.appendChild(h("span", { class: "r-num" }, `${it.num} `));
        if (task) li.appendChild(h("span", { class: "tick", "aria-label": it.check ? i18nText("U0822") : i18nText("U0821") }, it.check ? "☑" : "☐"));
        if (it.text) li.appendChild(run(it.text));
        else richInto(li, m, it.blocks, depth + 1, st);
        list.appendChild(li);
      }
      return list;
    }

    function richTable(b) {
      const body = h("tbody");
      for (const row of b.rows || []) {
        body.appendChild(
          h(
            "tr",
            null,
            row.map((c) => h(c.head ? "th" : "td", { colspan: c.cs ? String(c.cs) : null, rowspan: c.rs ? String(c.rs) : null, "data-align": c.align || null }, run(c.text)))
          )
        );
      }
      return h(
        "div",
        { class: "md-table", tabindex: "0", role: "region", "aria-label": i18nText("A0356") , "data-i18n-aria-label": "A0356"},
        h("table", { class: b.striped ? "r-striped" : null }, b.title ? h("caption", null, run(b.title)) : null, body)
      );
    }

    /** A rich message's photo, video, audio or file: the ordinary media block for a stand-in record with its ref. */
    function richFigure(m, b) {
      const md = b.media && typeof b.media === "object" ? b.media : { kind: "other" };
      const stand = { ...m, media: md, ref: b.ref || null, text: b.caption ? b.caption.text : "", buttons: null, rich: null };
      // no ref: the block points at something the message did not carry ("gone"); never cache that
      const body = b.ref ? mediaNode(stand) : buildMedia(stand);
      return h("figure", { class: "r-fig" }, body, b.caption ? h("figcaption", null, run(b.caption)) : null);
    }

    function richMap(b) {
      const lat = Number(b.lat);
      const lon = Number(b.long);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const z = Math.min(19, Math.max(2, Number(b.zoom) || 14));
      const url = `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=${z}/${lat.toFixed(5)}/${lon.toFixed(5)}`;
      return h(
        "div",
        { class: "r-map" },
        h("span", { class: "r-map-pin", "aria-hidden": "true" }, "⌖"),
        h("span", null, i18nNode("A0358", { v: lat.toFixed(5), v2: lon.toFixed(5) })),
        h("button", { class: "btn small", type: "button", onclick: () => deck.openExternal(url) }, i18nNode("U0865")),
        b.caption ? h("span", { class: "r-cap" }, run(b.caption)) : null
      );
    }

    /** An http(s) link that opens in the browser (never navigates the deck). */
    function link(url, label) {
      return h(
        "a",
        {
          class: "md-a",
          href: url,
          title: url,
          rel: "noreferrer",
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            deck.openExternal(url);
          },
        },
        String(label || url)
      );
    }

    /** Under the blocks when something is missing: a partial delivery, our size limit, or inline parts. */
    function richNote(m, r) {
      const text = r.part ? i18nText("U0866") : r.cut ? i18nText("U0867") : i18nText("U0868");
      return h("div", { class: "rich-fb r-note" }, h("span", { class: "rich-fb-text" }, text), tgButton(m));
    }

    // ---------------------------------------------------------------- one message
    const focusId = new Map(); // chat key -> id of the message that holds the list's single tab stop
    const sameRun = (a, b) => a && b && !a.out && !b.out && a.fromId && a.fromId === b.fromId && sameDay(a.date, b.date) && Math.abs(b.date - a.date) < 600;

    /**
     * prev/next are the neighbouring records (for grouping a sender's consecutive messages: the name on
     * the first, the photo beside the last). Group messages from others get the sender column.
     */
    function msgEl(m, prev, next) {
      if (m.service) return h("div", { class: "svcmsg", dataset: { mid: String(m.id) } }, m.service); // topic created, pin, join…
      if (prev && prev.service) prev = null;
      if (next && next.service) next = null;
      const lead = m.key[0] === "t" && !m.out;
      const contPrev = lead && sameRun(prev, m);
      const contNext = lead && sameRun(m, next);
      const md = m.media && typeof m.media === "object" ? m.media : null;
      const bare = md && md.kind === "sticker" && !m.text && !m.replyToId && !(m.buttons && m.buttons.length);
      const f = focusId.get(m.key);
      const stop = f !== undefined && msgOf(m.key, f) ? f === m.id : !next;
      const flashing = flash && flash.key === m.key && flash.id === m.id && Date.now() < flash.until;
      const bubble = h(
        "div",
        {
          class: `msg${m.out ? " out" : ""}${bare ? " bare" : ""}${flashing ? " flash" : ""}`,
          tabindex: stop ? "0" : "-1",
          dataset: { mid: String(m.id), fk: `msg:${m.key}:${m.id}` },
        },
        lead && !contPrev ? whoLine(m) : null,
        m.replyToId || m.replyQuote ? quote(m) : null,
        md ? mediaNode(m) : m.media ? h("div", { class: "media" }, `[${mediaLabel(m.media)}]`) : null,
        m.rich && Array.isArray(m.rich.blocks) ? richEl(m) : m.text && !(VB && md && VB.hidesDefaultText(m.text, [md])) ? textEl(m) : null, // a voice note shows no plugin default text
        m.buttons && m.buttons.length ? keyboard(m) : null,
        RX ? RX.chips(m) : null, // C9: reactions (renderer/reactions.js)
        h("time", { class: "t", title: new Date(m.date * 1000).toLocaleString(i18nLocale()) }, hm(m.date) + (m.edit ? i18nText("U0869") : ""))
      );
      if (!lead) return bubble;
      return h("div", { class: `msg-row${contNext ? " cont" : ""}` }, contNext ? h("span", { class: "sav-gap", "aria-hidden": "true" }) : avatar(m), bubble);
    }

    // ---------------------------------------------------------------- keyboard: one tab stop, arrows move
    function focusMsg(el, scroll = false) {
      for (const x of els.msgsInner.querySelectorAll('.msg[tabindex="0"]')) if (x !== el) x.tabIndex = -1;
      el.tabIndex = 0;
      if (document.activeElement !== el) el.focus({ preventScroll: !scroll });
      const [, key, id] = el.dataset.fk.split(":");
      focusId.set(key, Number(id));
    }

    els.msgsInner.addEventListener("focusin", (e) => {
      if (e.target.classList && e.target.classList.contains("msg")) focusMsg(e.target);
    });

    let ctxKeyAt = 0; // a keyboard-opened menu swallows the contextmenu event that may follow
    els.msgs.addEventListener("keydown", (e) => {
      const el = e.target;
      if (!el.classList || !el.classList.contains("msg")) return;
      if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
        e.preventDefault();
        ctxKeyAt = Date.now();
        openMenuFor(el, null);
        return;
      }
      const all = [...els.msgsInner.querySelectorAll(".msg")];
      const i = all.indexOf(el);
      const to = { ArrowUp: all[i - 1], ArrowDown: all[i + 1], Home: all[0], End: all[all.length - 1] }[e.key];
      if (!(e.key in { ArrowUp: 1, ArrowDown: 1, Home: 1, End: 1 })) return;
      e.preventDefault();
      if (to) focusMsg(to, true);
    });

    // ---------------------------------------------------------------- context menu
    let menu = null;
    els.msgs.addEventListener("contextmenu", (e) => {
      const el = e.target.closest && e.target.closest(".msg");
      if (!el || !els.msgsInner.contains(el)) return;
      e.preventDefault();
      if (Date.now() - ctxKeyAt < 500) return;
      const fromKeys = e.clientX === 0 && e.clientY === 0;
      openMenuFor(el, fromKeys ? null : { x: e.clientX, y: e.clientY });
    });

    function openMenuFor(el, pos) {
      const [, key, id] = el.dataset.fk.split(":");
      const m = msgOf(key, id);
      if (!m) return;
      const sel = window.getSelection();
      const picked = sel && !sel.isCollapsed && el.contains(sel.anchorNode) ? sel.toString() : "";
      const items = [
        { label: i18nText("U0607"), enabled: S.tg.status === "open", noReturn: true, run: () => armReply(m) },
        RX ? RX.menuItem(m, el, pos) : null, // C9: "Tepki ver" opens the quick picker
        { label: picked ? i18nText("U0870") : i18nText("A0053"), enabled: !!(picked || m.text), run: () => copy(picked || m.text).then(() => toast(i18nText("U0668"))) },
        m.key[0] === "t" ? { label: i18nText("U0844"), enabled: !!tgLink(m), run: () => deck.openExternal(tgLink(m)) } : null,
      ];
      openMenu(items.filter(Boolean), el, pos, i18nText("U0871"));
    }

    /**
     * A context menu at pos (or by the anchor element when opened from the keyboard). items: {label,
     * enabled?, danger?, noReturn?, run} or "-" for a separator. Escape/Tab/an action return focus to
     * the anchor (found again by its data-fk, as the list may have been rebuilt), unless noReturn.
     */
    function openMenu(items, anchor, pos, label, cls = null) {
      closeMenu();
      const box = h("div", { class: cls ? `ctx ${cls}` : "ctx", role: "menu", "aria-label": label || i18nText("U0872") });
      for (const it of items) {
        if (it === "-") {
          box.appendChild(h("div", { class: "ctx-sep", role: "separator" }));
          continue;
        }
        box.appendChild(
          h(
            "button",
            {
              class: it.danger ? "danger" : null,
              type: "button",
              role: "menuitem",
              tabindex: "-1",
              disabled: it.enabled === false,
              title: it.title || null, // icon-only items (the reaction picker)
              "aria-label": it.title || null,
              "aria-pressed": it.pressed === undefined ? null : String(!!it.pressed),
              onclick: (e) => {
                closeMenu(it.noReturn ? null : anchor.dataset.fk);
                it.run(e); // e: the click (the reaction picker acts only on a real one)
              },
            },
            it.label
          )
        );
      }
      document.body.appendChild(box);
      const r = anchor.getBoundingClientRect();
      const p = pos || { x: r.left + 24, y: r.top + Math.min(r.height, 28) };
      box.style.setProperty("left", `${Math.max(4, Math.min(p.x, innerWidth - box.offsetWidth - 4))}px`);
      box.style.setProperty("top", `${Math.max(4, Math.min(p.y, innerHeight - box.offsetHeight - 4))}px`);
      box.addEventListener("keydown", menuKeys);
      const scroller = anchor.closest(".msgs, .rail") || els.msgs;
      menu = { box, fk: anchor.dataset.fk, scroller, top: scroller.scrollTop };
      const first = box.querySelector("button:not(:disabled)");
      if (first) first.focus();
    }

    function menuKeys(e) {
      // a held Enter/Space is one press: its key repeats must not activate the item that has focus now
      // ("Tepki ver" opens the reaction picker and focuses its first item, which would take them as
      // fresh clicks and send a reaction the user never chose)
      if (e.repeat && (e.key === "Enter" || e.key === " ")) return e.preventDefault();
      if (!menu) return;
      const btns = [...menu.box.querySelectorAll("button:not(:disabled)")];
      const i = btns.indexOf(document.activeElement);
      const go = (k) => btns.length && btns[(k + btns.length) % btns.length].focus();
      if (e.key === "Escape" || e.key === "Tab") closeMenu(menu.fk);
      else if (e.key === "ArrowDown" || e.key === "ArrowRight") go(i + 1); // Right/Left: the reaction picker's row
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") go(i < 0 ? -1 : i - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(-1);
      else return;
      e.preventDefault();
    }

    function closeMenu(returnTo) {
      if (!menu) return;
      menu.box.remove();
      menu = null;
      if (returnTo) {
        const t = document.querySelector(`[data-fk="${CSS.escape(returnTo)}"]`);
        if (t) t.focus({ preventScroll: true });
      }
    }
    document.addEventListener("pointerdown", (e) => menu && !menu.box.contains(e.target) && closeMenu(), true);
    // the menu belongs to a spot in its list: it closes once that list really moves (a late scroll
    // event from a scroll that ended before the menu opened leaves it open)
    document.addEventListener("scroll", (e) => menu && e.target === menu.scroller && Math.abs(menu.scroller.scrollTop - menu.top) > 2 && closeMenu(), { capture: true, passive: true });
    window.addEventListener("blur", () => closeMenu());
    window.addEventListener("resize", () => closeMenu());

    // reactions (C9): chips, the quick picker and toggling live in renderer/reactions.js
    const RX = window.DeckReactions ? window.DeckReactions.create({ h, S, deck, toast, person, hue, initial, mark: ctx.mark, msgOf, openMenu, cleanErr }) : null;

    // ---------------------------------------------------------------- reply bar
    const replies = new Map(); // chat key -> id of the message the next send replies to
    const bar = h("div", { class: "replybar", hidden: true, role: "group", "aria-label": i18nText("U0057") , "data-i18n-aria-label": "U0057"});
    const composer = els.input.closest(".composer");
    composer.parentElement.insertBefore(bar, composer);

    function armReply(m) {
      replies.set(m.key, m.id);
      renderBar();
      els.input.focus();
    }

    function clearReply(key) {
      replies.delete(key);
      renderBar();
    }

    function renderBar() {
      const key = S.sel;
      const id = key ? replies.get(key) : null;
      if (!id) {
        bar.hidden = true;
        bar.replaceChildren();
        return;
      }
      const r = msgOf(key, id);
      const who = r ? (r.out ? i18nText("A0354") : r.from || i18nText("A0352")) : i18nText("A0360");
      bar.className = `replybar ${r ? (r.out ? "hue-me" : hue(r.fromId || r.from)) : ""}`;
      bar.hidden = false;
      bar.replaceChildren(
        h("span", { class: "rb-ico", "aria-hidden": "true" }, "↩"),
        h(
          "button",
          { class: "rb-body", type: "button", title: i18nText("U0853"), onclick: () => jumpTo(key, id) , "data-i18n-title": "U0853"},
          h("span", { class: "rb-who" }, i18nNode("U0873", { who: who })),
          h("span", { class: "rb-text" }, r ? firstLine(r) : `#${id}`)
        ),
        h(
          "button",
          {
            class: "rb-x",
            type: "button",
            "aria-label": i18nText("U0874"),
            title: i18nText("U0875"),
            onclick: () => {
              clearReply(key);
              els.input.focus();
            },
           "data-i18n-aria-label": "U0874", "data-i18n-title": "U0875"},
          "✕"
        )
      );
    }

    els.input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && S.sel && replies.has(S.sel)) {
        e.preventDefault();
        clearReply(S.sel);
      }
    });

    // ---------------------------------------------------------------- fixture scenes (development screenshots)
    let scene = null;
    function applyScene(sc) {
      if (sc.scroll) {
        const el = els.msgsInner.querySelector(`.msg[data-mid="${Number(sc.scroll)}"]`);
        if (el) el.scrollIntoView({ block: "start" });
        // the scroll event closes menus: open the rest once it has fired
        setTimeout(() => applyScene({ ...sc, scroll: null }), 300);
        return;
      }
      if (sc.reply) {
        const m = msgOf(S.sel, sc.reply);
        if (m) armReply(m);
      }
      if (sc.jump) jumpTo(S.sel, sc.jump);
      if (sc.menu) {
        const el = els.msgsInner.querySelector(`.msg[data-mid="${Number(sc.menu)}"]`);
        if (el) {
          const r = el.getBoundingClientRect();
          openMenuFor(el, { x: r.left + Math.min(r.width - 20, 120), y: r.top + 18 });
        }
      }
      if (sc.lightbox) {
        const m = msgOf(S.sel, sc.lightbox);
        if (m) openLightbox(m);
      }
      const richIn = (id) => els.msgsInner.querySelector(`.msg[data-mid="${Number(id)}"] .rich`);
      if (sc.richOpen && richIn(sc.richOpen)) for (const d of richIn(sc.richOpen).querySelectorAll("details")) d.open = true;
      if (sc.richPress && richIn(sc.richPress)) {
        const b = richIn(sc.richPress).querySelector(".r-btns .kb-btn.cb");
        if (b) b.click(); // the real "rich" callback path, answered by the fixture
      }
      if (sc.toast) toast(String(sc.toast));
      if (RX && sc.react) {
        // C9: {id, pick?: "<key>" (toggle through the real IPC path), picker?: true (open the quick picker)}
        const el = els.msgsInner.querySelector(`.msg[data-mid="${Number(sc.react.id)}"]`);
        const m = msgOf(S.sel, sc.react.id);
        if (el && m && sc.react.pick) RX.react(m.key, m.id, String(sc.react.pick));
        if (el && m && sc.react.picker) {
          const r = el.getBoundingClientRect();
          RX.openPicker(m, el, { x: r.left + Math.min(r.width - 20, 120), y: r.top + 18 });
        }
      }
    }

    /** Called by app.js after each message-list render. */
    function afterRender() {
      renderBar();
      // the list always keeps one tab stop (the newest message unless one was focused before)
      if (!els.msgsInner.querySelector('.msg[tabindex="0"]')) {
        const all = els.msgsInner.querySelectorAll(".msg");
        if (all.length) all[all.length - 1].tabIndex = 0;
      }
      if (scene && S.sel && S.loaded.has(S.sel)) {
        const sc = scene;
        scene = null;
        setTimeout(() => applyScene(sc), 300);
      }
    }

    return {
      msgEl,
      afterRender,
      toast,
      openMenu, // shared with the rail's topic menu (topics.js)
      /** Message id the next send in this chat replies to, or null. */
      replyTarget: (key) => replies.get(key) || null,
      clearReply,
      /** Merge group member updates ({id: {avatar?, role?, rank?}}) from the main process. */
      people(users) {
        if (!users) return;
        if (!S.people) S.people = {};
        for (const [id, p] of Object.entries(users)) S.people[id] = { ...(S.people[id] || {}), ...p };
      },
      setScene: (sc) => (scene = sc && typeof sc === "object" ? sc : null),
      /** C9: a live reaction change ({key, id, reactions}); true when that message is loaded here. */
      reactions: (x) => (RX ? RX.update(x) : false),
    };
  }

  window.DeckMsgView = Object.freeze({ create });
})();
