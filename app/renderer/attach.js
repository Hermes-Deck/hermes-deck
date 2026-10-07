"use strict";
var i18nNode = (key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).node(key, vars, typeof document === "object" ? document : null);
var i18nBind = (el, attr, key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).bind(el, attr, key, vars);
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
var i18nLocale = typeof module === "object" && module.exports ? require("./i18n").getLocale : window.DeckI18n.getLocale;
// File attachments in the composer (A7), window.DeckAttach.create(ctx).
//  - The clip button opens the main-process file picker; files dropped on the chat column and images
//    pasted into the message box are staged the same way. Main keeps every staged file; this page only
//    holds a token, a name, a size and (for images) a small preview. It never sees a path.
//  - Staged files sit in a tray above the composer, per chat. "Gönder" uploads them one after another;
//    the typed text becomes the first file's caption and the reply target (if any) the first file's.
//  - Photos go as compressed photos unless "Dosya olarak gönder" is ticked. A running upload shows its
//    progress and can be cancelled.
//  - Both channels take any file (paste, drop, picker; screenshots, video, text, PDF...). Telegram uploads them
//    one by one; direct Hermes sends the whole tray with the message through its bounded host method.
//    A window capture (the explicit "▣" button) is just one more tray item: an image plus its window text.
(() => {
  const NS = "http://www.w3.org/2000/svg";
  const CLIP = "M10.5 4.5 5.4 9.6a1.6 1.6 0 0 0 2.3 2.3l5.4-5.4a3 3 0 0 0-4.3-4.3L3.4 7.6a4.4 4.4 0 0 0 6.2 6.2l4.6-4.6";
  // window capture: a window frame with a corner-bracket viewfinder
  const CAPTURE = "M2.5 5.5v-2a1 1 0 0 1 1-1h2M10.5 2.5h2a1 1 0 0 1 1 1v2M13.5 10.5v2a1 1 0 0 1-1 1h-2M5.5 13.5h-2a1 1 0 0 1-1-1v-2M5.5 6.5h5v3h-5z";
  const MAX_CAPTION = 1024; // checked again in main

  const size = (n) => (n >= 1024 * 1024 * 1024 ? `${(n / 1024 / 1024 / 1024).toFixed(2)} GB` : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

  function create(ctx) {
    const { h, S, deck, els, MV, mark, cleanErr, hermesMode, setChannel, onSent, renderNote } = ctx;
    const trays = new Map(); // chat key -> [{token, name, size, kind, risky, preview, p?, state?}]
    const asFile = new Map(); // chat key -> "Dosya olarak gönder" ticked
    let busyKey = null; // chat whose files are uploading now
    let current = null; // token uploading now
    let capturing = false;

    const composer = els.input.closest(".composer");
    const tray = h("div", { class: "attach-tray", hidden: true, role: "group", "aria-label": i18nText("A0303") , "data-i18n-aria-label": "A0303"});
    composer.parentElement.insertBefore(tray, composer);

    const icon = (d = CLIP) => {
      const s = document.createElementNS(NS, "svg");
      s.setAttribute("viewBox", "0 0 16 16");
      s.setAttribute("aria-hidden", "true");
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      s.appendChild(p);
      return s;
    };
    const button = h("button", { class: "attach-btn", type: "button", title: i18nText("U0671"), "aria-label": i18nText("A0149"), onclick: () => pick() , "data-i18n-title": "U0671", "data-i18n-aria-label": "A0149"}, icon());
    // the composer card: text on top, a slim toolbar below (attach, window capture; dictation joins from voice.js)
    const tools = composer.querySelector(".composer-tools") || composer;
    tools.appendChild(button);
    const appshotButton = h("button", { class: "attach-btn", type: "button", title: i18nText("appshot.captureHelp"), "aria-label": i18nText("appshot.add"), onclick: appshot , "data-i18n-title": "appshot.captureHelp", "data-i18n-aria-label": "appshot.add"}, icon(CAPTURE));
    tools.appendChild(appshotButton);

    const chatKey = () => hermesMode() ? `hermes:${ctx.hermesKey() || ""}` : S.sel;
    const items = (key = chatKey()) => (key && trays.get(key)) || [];
    const pending = (key) => items(key).length > 0;

    async function appshot() {
      if (capturing || busyKey || (hermesMode() && ctx.hermesBusy())) return;
      if (hermesMode() ? !ctx.hermesKey() || !ctx.hermesReady() : !S.sel || S.tg.status !== "open") return note(i18nText("appshot.selectChat"));
      const key = chatKey();
      capturing = true;
      appshotButton.disabled = true;
      try { take(key, { items: [await deck.attach.appshot()] }); }
      catch (e) { note(i18nText("appshot.captureFailed", { e: cleanErr(e) })); }
      finally { capturing = false; render(); }
    }

    function note(text, bad = true) {
      S.note = text;
      S.noteBad = bad;
      renderNote();
    }

    /** Adds what main staged ({items, errors}) to this chat's tray. */
    function persist(key) {
      if (!deck.attach.saveDraft || key === "hermes:") return;
      return deck.attach.saveDraft(key, items(key).map(x => x.token)).catch(e => note(i18nText("draft.attachSaveFailed", { e: cleanErr(e) })));
    }

    function take(key, r) {
      const list = trays.get(key) || [];
      for (const it of (r && r.items) || []) list.push({ ...it, p: null, state: null });
      trays.set(key, list);
      persist(key);
      const errs = (r && r.errors) || [];
      if (errs.length) note(errs.join(" · "));
      else if (list.length) note(null, false);
      render();
    }

    /** Whether a file can be staged now: a selected chat in the active channel (Telegram must be connected). */
    function canStage() {
      if (hermesMode()) {
        if (ctx.hermesKey()) return true;
        note(i18nText("U0672"));
        return false;
      }
      if (!S.sel || S.tg.status !== "open") {
        note(i18nText("U0672"));
        return false;
      }
      return true;
    }

    async function pick() {
      if (!canStage()) return;
      const key = chatKey();
      try {
        take(key, await deck.attach.pick());
      } catch (e) {
        note(i18nText("A0304", { e: cleanErr(e) }));
      }
    }

    /** A pasted/dropped file without a path (clipboard bitmap, a file from a browser or an app): its bytes go to main. */
    async function stagePasted(key, file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const it = await deck.attach.paste(bytes, file.name || "", file.type || "");
      take(key, { items: [it], errors: [] });
    }

    /** Files from a drop or a paste: those with a path go through main's checks, path-less ones as bytes. */
    async function stageFiles(fileList) {
      const files = Array.from(fileList || []);
      if (!files.length || !canStage()) return;
      const key = chatKey();
      const errs = [];
      try {
        let r = { items: [], errors: [], nopath: [] };
        try {
          r = await deck.attach.drop(files);
          take(key, r);
        } catch (e) {
          errs.push(cleanErr(e));
        }
        for (const i of r.nopath || []) {
          const f = files[i];
          if (!f) continue;
          try {
            await stagePasted(key, f);
          } catch (e) {
            errs.push(`${f.name || i18nText("common.file")}: ${cleanErr(e)}`);
          }
        }
        if (errs.length || (r.errors && r.errors.length)) note([...((r && r.errors) || []), ...errs].join(" · "));
      } catch (e) {
        note(i18nText("A0304", { e: cleanErr(e) }));
      }
    }

    /** Very long pasted text becomes a .txt attachment (like Claude does) instead of flooding the message box. */
    async function stageLongText(text) {
      if (!canStage()) return;
      const key = chatKey();
      try {
        const bytes = new TextEncoder().encode(text);
        take(key, { items: [await deck.attach.paste(bytes, "pasted-text.txt", "text/plain")], errors: [] });
      } catch (e) {
        note(cleanErr(e));
      }
    }

    async function discard(key, it) {
      if (it.state === "sending") return;
      trays.set(key, items(key).filter((x) => x !== it));
      render();
      try {
        await deck.attach.discard(it.token);
      } catch {
        /* main drops it with the next restart anyway */
      }
    }

    function cancel(it) {
      if (it.state !== "sending") return;
      it.state = "canceling";
      render();
      deck.attach.cancel(it.token).catch(() => {});
    }

    /** Upload this chat's tray in order; the text and the reply go with the first file. */
    async function send() {
      if (hermesMode()) {
        const list = items();
        return ctx.sendHermes(list.map((x) => x.token), list.map((x) => x.name), list.map((x) => x.preview || null));
      }
      const key = S.sel;
      const list = items(key);
      if (!list.length || busyKey || S.tg.status !== "open") return;
      const text = els.input.value.trim();
      if (text.length > MAX_CAPTION) {
        note(i18nText("U0674", { length: text.length, MAX_CAPTION: MAX_CAPTION }));
        return;
      }
      busyKey = key;
      S.sending = true;
      let replyTo = MV.replyTarget(key);
      let caption = text;
      let sent = 0;
      try {
        for (const it of list.slice()) {
          current = it.token;
          it.state = "sending";
          it.p = 0;
          note(i18nText("U0675", { name: it.name }), false);
          render();
          const m = await deck.attach.send(key, it.token, { caption: caption || undefined, replyTo: replyTo || undefined, asDocument: !!asFile.get(key) });
          sent++;
          trays.set(key, items(key).filter((x) => x !== it));
          if (caption) {
            if (ctx.draftSent) ctx.draftSent(key, caption); // the draft of the chat it was typed in
            else if (els.input.value.trim() === caption) {
              els.input.value = "";
              els.input.dispatchEvent(new Event("input")); // autosize
            }
          }
          caption = "";
          if (replyTo) {
            MV.clearReply(key);
            replyTo = null;
          }
          onSent(m);
        }
        note(null, false);
      } catch (e) {
        const left = items(key);
        for (const x of left) x.state = x.state === "sending" || x.state === "canceling" ? "failed" : x.state;
        note(`${sent ? i18nText("U0676", { sent: sent }) : ""}${cleanErr(e)}`, !/iptal edildi/.test(cleanErr(e)));
      } finally {
        busyKey = null;
        current = null;
        S.sending = false;
        render();
        renderNote();
      }
    }

    function chip(key, it) {
      const sending = it.state === "sending" || it.state === "canceling";
      const pct = sending && typeof it.p === "number" ? Math.round(it.p * 100) : null;
      return h(
        "div",
        { class: `att${sending ? " sending" : ""}${it.state === "failed" ? " failed" : ""}`, dataset: { token: it.token } },
        it.preview ? h("img", { class: "att-thumb", src: it.preview, alt: "" }) : h("span", { class: "att-ico", "aria-hidden": "true" }, it.image || it.kind === "photo" ? "▣" : window.DeckVoiceBubble && window.DeckVoiceBubble.isAudio(it.name) ? "♪" : "▤"),
        h(
          "span",
          { class: "att-body" },
          h("span", { class: "att-name", title: it.name }, it.name),
          it.appshot ? h("details", { class: "att-text" }, h("summary", null, i18nNode("appshot.windowText")), h("pre", null, it.text)) : null,
          h(
            "span",
            { class: "att-meta" },
            `${it.kind === "photo" ? (asFile.get(key) ? i18nText("U0677") : i18nText("U0274")) : i18nText("common.file")} · ${size(it.size)}`,
            it.risky ? h("span", { class: "att-risky", title: i18nText("U0678") , "data-i18n-title": "U0678"}, i18nNode("U0679")) : null
          ),
          sending ? h("span", { class: "att-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct || 0), "aria-label": i18nText("U0680", { name: it.name }) , "data-i18n-aria-label": "U0680", "data-i18n-aria-label-vars": JSON.stringify({ name: it.name })}, h("span", { class: "att-fill", style: { width: `${pct || 0}%` } })) : null
        ),
        sending
          ? h("button", { class: "att-cancel", type: "button", disabled: it.state === "canceling", onclick: () => cancel(it) }, it.state === "canceling" ? i18nNode("A0305") : i18nNode("U0681", { v: pct || 0 }))
          : h("button", { class: "att-x", type: "button", "aria-label": i18nText("U0682", { name: it.name }), title: i18nText("U0683"), disabled: !!busyKey || (hermesMode() && ctx.hermesBusy()), onclick: () => discard(key, it) , "data-i18n-aria-label": "U0682", "data-i18n-aria-label-vars": JSON.stringify({ name: it.name }), "data-i18n-title": "U0683"}, "✕")
      );
    }

    function render() {
      button.disabled = !!busyKey || (hermesMode() && ctx.hermesBusy());
      const isHermes = hermesMode();
      const appshotSupported = /Win|Mac/i.test(navigator.platform);
      appshotButton.disabled = capturing || !!busyKey || (isHermes && ctx.hermesBusy()) || !appshotSupported;
      i18nBind(appshotButton, "title", appshotSupported ? "appshot.captureHelp" : "frontmost.windowsOnly");
      const key = chatKey();
      const list = items(key);
      renderNote(); // the Send button follows the tray (text or staged files)
      tray.hidden = !list.length;
      if (!list.length) return tray.replaceChildren();
      tray.className = "attach-tray";
      const photos = list.some((x) => x.kind === "photo");
      tray.replaceChildren(
        ...[
          h("div", { class: "att-list" }, list.map((it) => chip(key, it))),
          photos && !isHermes
            ? h(
                "label",
                { class: "att-opt" },
                h("input", {
                  type: "checkbox",
                  checked: !!asFile.get(key),
                  disabled: !!busyKey,
                  onchange: (e) => {
                    asFile.set(key, e.target.checked);
                    render();
                  },
                }),
                i18nNode("U0687")
              )
            : null,
        ].filter(Boolean)
      );
    }

    // progress from main: {t: "upload", token, p}; only the bar is touched, so a fast upload stays cheap
    deck.onTelegram((m) => {
      if (!m || m.t !== "upload" || m.token !== current) return;
      for (const list of trays.values()) {
        const it = list.find((x) => x.token === m.token);
        if (!it || it.state !== "sending") continue;
        it.p = m.p;
        const el = tray.querySelector(`.att[data-token="${CSS.escape(it.token)}"]`);
        if (!el) continue;
        const pct = Math.round(m.p * 100);
        const fill = el.querySelector(".att-fill");
        if (fill) fill.style.width = `${pct}%`;
        const bar = el.querySelector(".att-bar");
        if (bar) bar.setAttribute("aria-valuenow", String(pct));
        const c = el.querySelector(".att-cancel");
        if (c && !c.disabled) i18nBind(c, "textContent", "U0689", { pct: pct });
      }
    });

    // drag and drop onto the chat column: only files count; the page itself never navigates to a drop
    const chat = composer.closest(".chat") || document.body;
    const zone = h("div", { class: "drop-zone", hidden: true, "aria-hidden": "true" }, h("span", null, i18nNode("U0690")));
    chat.appendChild(zone);
    const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
    let depth = 0;
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => e.preventDefault());
    chat.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      zone.hidden = false;
    });
    chat.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    chat.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) zone.hidden = true;
    });
    chat.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      zone.hidden = true;
      stageFiles(e.dataTransfer.files);
    });

    // pasting: any file on the clipboard (a screenshot bitmap, a video or document copied in the file manager) is
    // staged; text pastes as usual, except a very long text, which becomes a .txt attachment
    const LONG_PASTE = 4000;
    els.input.addEventListener("paste", (e) => {
      const cd = e.clipboardData;
      if (!cd) return;
      const files = Array.from(cd.files || []);
      if (!files.length) {
        const text = cd.getData("text/plain") || "";
        if (text.length > LONG_PASTE) {
          e.preventDefault();
          stageLongText(text);
        }
        return;
      }
      e.preventDefault();
      stageFiles(files);
    });

    // ---------------------------------------------------------------- fixture scenes (development screenshots)
    // {attach: [{w, h, name?}], attachFiles: [{name, type, size?, text?}]}: images drawn on a canvas and generic
    // files (video, text...) go through the real paste path; attachSend then sends them against the fixture
    // (a pretend upload, nothing leaves the process). Works in both channels (Hermes: --bridge-fake).
    function applyScene(sc) {
      const key = chatKey();
      const fileJobs = (Array.isArray(sc.attachFiles) ? sc.attachFiles : []).map(async (f) => {
        const bytes = typeof f.text === "string" ? new TextEncoder().encode(f.text) : new Uint8Array(Math.max(1, Number(f.size) || 2048)).fill(7);
        return deck.attach.paste(bytes, String(f.name || "file.bin"), String(f.type || ""));
      });
      const jobs = (Array.isArray(sc.attach) ? sc.attach : []).map(async (a, i) => {
        const c = document.createElement("canvas");
        c.width = Number(a.w) || 640;
        c.height = Number(a.h) || 400;
        const g = c.getContext("2d");
        const grad = g.createLinearGradient(0, 0, c.width, c.height);
        grad.addColorStop(0, i % 2 ? "#2c4a45" : "#24314d");
        grad.addColorStop(1, i % 2 ? "#cda65a" : "#e7a57c");
        g.fillStyle = grad;
        g.fillRect(0, 0, c.width, c.height);
        const blob = await new Promise((r) => c.toBlob(r, "image/png"));
        return deck.attach.paste(new Uint8Array(await blob.arrayBuffer()));
      });
      Promise.all([...jobs, ...fileJobs])
        .then((list) => {
          take(key, { items: list, errors: [] });
          if (sc.attachCaption) els.input.value = String(sc.attachCaption);
          if (sc.attachAsFile) {
            asFile.set(key, true);
            render();
          }
          if (sc.attachSend) send();
        })
        .catch((e) => note(i18nText("U0692", { e: cleanErr(e) })));
    }
    let scene = null;
    const ready = deck.attach.restoreDrafts ? deck.attach.restoreDrafts().then(drafts => {
      for (const [key, restored] of Object.entries(drafts || {})) {
        if (key.startsWith("outbox:")) continue; // queued tokens stay staged in main, not in the tray
        const existing = items(key);
        const seen = new Set(existing.map(x => x.token));
        trays.set(key, [...restored.filter(x => !seen.has(x.token)), ...existing]);
      }
      render();
    }).catch(e => note(i18nText("draft.attachRestoreFailed", { e: cleanErr(e) }))) : Promise.resolve();

    return {
      /** Whether "Gönder" should upload this chat's tray instead of sending text. */
      pending,
      ready,
      forgetChat(key) {
        trays.delete(key);
        if (deck.attach.forgetDraft) deck.attach.forgetDraft(key).catch(e => note(cleanErr(e)));
        render();
      },
      queued(key, tokens) {
        if (deck.attach.saveDraft) deck.attach.saveDraft(`outbox:${key}`, tokens).catch(e => note(cleanErr(e)));
        trays.set(key, items(key).filter(x => !tokens.includes(x.token)));
        render();
      },
      send,
      /** Called from renderMsgs (both channels): the tray follows the selected chat. */
      render() {
        if (scene && (hermesMode() ? ctx.hermesKey() : S.sel && S.loaded.has(S.sel))) {
          const sc = scene;
          scene = null;
          setTimeout(() => applyScene(sc), 400);
        }
        render();
      },
      busy: () => !!busyKey,
      key: chatKey,
      sent(key, tokens) {
        trays.set(key, items(key).filter((x) => !tokens.includes(x.token)));
        render();
      },
      /** The staged files of a tray, as the outbox keeps them (still staged in main until sent or discarded). */
      views: (key, tokens) => items(key).filter((x) => tokens.includes(x.token)).map(({ token, name, size, kind, preview, image }) => ({ token, name, size, kind, preview, image })),
      /** Put queued files back into a tray (Edit on a queued message). */
      restore: (key, views) => take(key, { items: (views || []).filter((v) => v && v.token), errors: [] }),
      /** Drop staged files main still holds (Cancel on a queued message). */
      forget: (tokens) => { for (const t of tokens || []) deck.attach.discard(t).catch(() => {}); },
      setScene: (sc) => (scene = sc && typeof sc === "object" && (Array.isArray(sc.attach) || Array.isArray(sc.attachFiles)) ? sc : null),
    };
  }

  window.DeckAttach = Object.freeze({ create });
})();
