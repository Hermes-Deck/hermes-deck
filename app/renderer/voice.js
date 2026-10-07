"use strict";
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
// Dictation in the composer, window.DeckVoice.create(ctx).
//   - The mic button (or Ctrl+Shift+M) starts recording from this computer's microphone; pressing it again stops
//     and sends the clip to the Hermes host, whose own STT (config `stt:`) transcribes it. The text is inserted at
//     the cursor of the message box for the owner to edit. It is NEVER sent: the owner presses Send.
//   - Esc while recording throws the audio away. A recording stops by itself after 120 s. The clip lives in memory
//     only (it is never written to disk here) and goes nowhere but the owner's own Hermes host.
//   - Both chat channels use it: it needs the direct Hermes connection (the transcription runs there), not the
//     Hermes chat view.
// The state machine (Dictation) has no DOM and takes every browser API as a dependency, so the tests drive it with
// a fake MediaRecorder; create() binds it to the composer.
(() => {
  const MAX_SECONDS = 120; // a recording stops by itself here
  const MIN_MS = 400; // anything shorter is a mis-click, not speech
  const MIME_PREFERENCE = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
  const MIC = "M8 1.5a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0V4A2.5 2.5 0 0 0 8 1.5ZM3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5";

  const clock = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  /** `text` placed at [start, end) of `value`, spaced like running prose; returns {value, caret}. */
  function insertAtCursor(value, start, end, text) {
    const v = String(value || "");
    const a = Math.max(0, Math.min(Number.isInteger(start) ? start : v.length, v.length));
    const b = Math.max(a, Math.min(Number.isInteger(end) ? end : a, v.length));
    const before = v.slice(0, a);
    const after = v.slice(b);
    const t = String(text || "").trim();
    if (!t) return { value: v, caret: a };
    const lead = before && !/\s$/.test(before) ? " " : "";
    const tail = after && !/^\s/.test(after) ? " " : "";
    const out = before + lead + t + tail + after;
    return { value: out, caret: (before + lead + t).length };
  }

  /** The best container this browser can record, or "" (the browser default). */
  function pickMime(Recorder) {
    if (!Recorder || typeof Recorder.isTypeSupported !== "function") return "";
    return MIME_PREFERENCE.find((m) => Recorder.isTypeSupported(m)) || "";
  }

  /** Error text for what can go wrong before there is a recording. */
  function micError(e) {
    const name = e && e.name;
    if (name === "NotAllowedError" || name === "SecurityError") return i18nText("voice.denied");
    if (name === "NotFoundError" || name === "OverconstrainedError") return i18nText("voice.noMic");
    if (name === "NotReadableError") return i18nText("voice.micBusy");
    return i18nText("voice.micFailed", { e: (e && e.message ? String(e.message) : String(e || "")).slice(0, 160) });
  }

  class Dictation {
    /**
     * deps: {getUserMedia(), Recorder, transcribe(bytes, mime) -> {text}, insert(text), onState(state, info),
     *        onError(message), setInterval, clearInterval, now}
     */
    constructor(deps) {
      this.d = deps;
      this.state = "idle"; // idle | starting | recording | transcribing
      this.run = 0; // identifies the current recording, so a late event of an abandoned one is ignored
      this.rec = null;
      this.stream = null;
      this.chunks = [];
      this.timer = null;
      this.started = 0;
      this.discard = false;
    }

    get busy() {
      return this.state !== "idle";
    }

    _set(state, info = {}) {
      this.state = state;
      if (this.d.onState) this.d.onState(state, info);
    }

    elapsed() {
      return this.state === "recording" ? this.d.now() - this.started : 0;
    }

    /** Button / shortcut: idle -> record, recording -> stop and transcribe; busy otherwise. */
    toggle() {
      if (this.state === "idle") return this.start();
      if (this.state === "recording") return this.stop();
      return Promise.resolve(false);
    }

    async start() {
      if (this.state !== "idle") return false;
      const run = ++this.run;
      this._set("starting");
      let stream;
      try {
        stream = await this.d.getUserMedia();
      } catch (e) {
        if (run === this.run) {
          this._set("idle");
          this.d.onError(micError(e));
        }
        return false;
      }
      if (run !== this.run || this.state !== "starting") {
        for (const t of stream.getTracks()) t.stop(); // cancelled while the permission prompt was open
        return false;
      }
      const mime = pickMime(this.d.Recorder);
      let rec;
      try {
        rec = new this.d.Recorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32000 });
      } catch (e) {
        for (const t of stream.getTracks()) t.stop();
        this._set("idle");
        this.d.onError(micError(e));
        return false;
      }
      this.stream = stream;
      this.rec = rec;
      this.chunks = [];
      this.discard = false;
      rec.ondataavailable = (ev) => {
        if (run === this.run && ev && ev.data && ev.data.size) this.chunks.push(ev.data);
      };
      rec.onerror = () => {
        if (run !== this.run) return;
        this._release();
        this._set("idle");
        this.d.onError(i18nText("voice.recordFailed"));
      };
      rec.onstop = () => this._stopped(run, rec.mimeType || mime || "audio/webm");
      this.started = this.d.now();
      rec.start();
      this.timer = this.d.setInterval(() => {
        if (run !== this.run || this.state !== "recording") return;
        const ms = this.elapsed();
        this._set("recording", { ms });
        if (ms >= MAX_SECONDS * 1000) this.stop();
      }, 250);
      this._set("recording", { ms: 0 });
      return true;
    }

    stop() {
      if (this.state !== "recording") return Promise.resolve(false);
      this.discard = false;
      this._end();
      return Promise.resolve(true);
    }

    /** Esc: throw the recording away (or abandon a pending permission prompt). */
    cancel() {
      if (this.state === "starting") {
        this.run++;
        this._set("idle");
        return true;
      }
      if (this.state !== "recording") return false;
      this.discard = true;
      this._end();
      return true;
    }

    _end() {
      if (this.timer !== null) this.d.clearInterval(this.timer);
      this.timer = null;
      try {
        this.rec.stop(); // the recorder's last data event and `stop` follow
      } catch {
        this._stopped(this.run, "audio/webm");
      }
    }

    _release() {
      if (this.timer !== null) this.d.clearInterval(this.timer);
      this.timer = null;
      if (this.stream) for (const t of this.stream.getTracks()) t.stop(); // the microphone indicator goes off
      this.stream = null;
      this.rec = null;
      this.run++;
    }

    async _stopped(run, mime) {
      if (run !== this.run) return;
      const held = this.d.now() - this.started;
      const chunks = this.chunks;
      const discard = this.discard;
      this.chunks = [];
      this._release();
      if (discard) return this._set("idle", { cancelled: true });
      if (held < MIN_MS || !chunks.length) {
        this._set("idle");
        return this.d.onError(i18nText("voice.tooShort"));
      }
      const mine = this.run;
      this._set("transcribing");
      try {
        const blob = new Blob(chunks, { type: mime });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const r = await this.d.transcribe(bytes, mime);
        if (mine !== this.run) return; // abandoned meanwhile (the connection went away)
        const text = r && typeof r.text === "string" ? r.text.trim() : "";
        this._set("idle");
        if (!text) return this.d.onError(i18nText("voice.nothingHeard"));
        this.d.insert(text);
      } catch (e) {
        if (mine !== this.run) return;
        this._set("idle");
        this.d.onError(i18nText("voice.failed", { e: this.d.clean ? this.d.clean(e) : String((e && e.message) || e).slice(0, 200) }));
      }
    }

    /** The connection or the page is going away: stop quietly, keep nothing. */
    abort() {
      this.discard = true;
      if (this.rec) {
        try {
          this.rec.onstop = null;
          this.rec.stop();
        } catch {
          /* already stopped */
        }
      }
      this._release();
      this.chunks = [];
      if (this.state !== "idle") this._set("idle");
    }
  }

  /** Binds the state machine to the composer: the mic button, the elapsed time, Esc and Ctrl+Shift+M. */
  function create(ctx) {
    const { h, S, deck, els, renderNote, autosize } = ctx;
    const doc = ctx.document || document;
    const NS = "http://www.w3.org/2000/svg";
    const icon = () => {
      const s = doc.createElementNS(NS, "svg");
      s.setAttribute("viewBox", "0 0 16 16");
      s.setAttribute("aria-hidden", "true");
      const p = doc.createElementNS(NS, "path");
      p.setAttribute("d", MIC);
      s.appendChild(p);
      return s;
    };
    const label = h("span", { class: "voice-time", "aria-hidden": "true" });
    const button = h("button", { class: "attach-btn voice-btn", type: "button", onclick: () => toggle() }, icon(), label);
    const composer = els.input.closest(".composer");
    (composer.querySelector(".composer-tools") || composer).appendChild(button);
    let ownNote = null; // the composer note this module wrote, cleared by it
    let startKey = null; // the chat whose box was active when the recording began (the text belongs to its draft)

    const say = (text, bad = true) => {
      ownNote = text;
      S.note = text;
      S.noteBad = bad;
      renderNote();
    };
    const clearNote = () => {
      if (ownNote !== null && S.note === ownNote) {
        S.note = null;
        S.noteBad = false;
        renderNote();
      }
      ownNote = null;
    };

    const dictation = new Dictation({
      getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }),
      Recorder: window.MediaRecorder,
      transcribe: (bytes, mime) => deck.bridge.transcribe(bytes, mime),
      clean: ctx.cleanErr,
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (t) => window.clearInterval(t),
      now: () => Date.now(),
      onError: (m) => say(m, true),
      insert: (text) => {
        const input = els.input;
        const drafts = ctx.drafts;
        if (drafts && startKey !== null && ctx.chatKey && ctx.chatKey() !== startKey) {
          // the reader moved to another chat meanwhile: the text goes into the draft of the chat that recorded it
          const rec = drafts.read(startKey) || { text: "", start: 0, end: 0, scroll: 0 };
          const r = insertAtCursor(rec.text, rec.start, rec.end, text);
          drafts.write(startKey, { ...rec, text: r.value, start: r.caret, end: r.caret });
          say(i18nText("draft.dictationElsewhere"), false);
          return;
        }
        const r = insertAtCursor(input.value, input.selectionStart, input.selectionEnd, text);
        input.value = r.value;
        input.focus();
        input.setSelectionRange(r.caret, r.caret);
        autosize();
        say(i18nText("voice.inserted"), false);
      },
      onState: (state, info) => {
        paint(state, info);
      },
    });

    function ready() {
      return !!ctx.hermesReady();
    }

    function paint(state, info = {}) {
      const rec = state === "recording";
      button.classList.toggle("recording", rec);
      button.classList.toggle("busy", state === "transcribing" || state === "starting");
      button.setAttribute("aria-pressed", rec ? "true" : "false");
      label.textContent = rec ? clock(info.ms || 0) : "";
      const title = rec ? i18nText("voice.stopHelp") : state === "transcribing" ? i18nText("voice.transcribing") : ready() ? i18nText("voice.startHelp") : i18nText("voice.needsHermes");
      button.title = title;
      button.setAttribute("aria-label", rec ? i18nText("voice.stop") : i18nText("voice.start"));
      button.disabled = state === "transcribing" || state === "starting" || (state === "idle" && !ready());
      if (rec) say(i18nText("voice.recording", { t: clock(info.ms || 0) }), false);
      else if (state === "transcribing") say(i18nText("voice.transcribing"), false);
      else if (state === "idle" && info.cancelled) say(i18nText("voice.cancelled"), false);
      else if (state === "idle" && ownNote !== null && (S.note === i18nText("voice.transcribing") || /^(Recording|Kayıt)/.test(String(S.note || "")))) clearNote();
    }

    function toggle() {
      if (!ready() && !dictation.busy) return say(i18nText("voice.needsHermes"), true);
      if (dictation.state === "idle") startKey = ctx.chatKey ? ctx.chatKey() : null;
      return dictation.toggle();
    }

    doc.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && (dictation.state === "recording" || dictation.state === "starting")) {
          e.preventDefault();
          e.stopPropagation();
          dictation.cancel();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && String(e.key).toLowerCase() === "m" && !e.isComposing) {
          e.preventDefault();
          toggle();
        }
      },
      true
    );
    window.addEventListener("beforeunload", () => dictation.abort());
    paint("idle");

    return {
      dictation,
      toggle,
      /** Called by the page whenever the connection state may have changed. */
      sync: () => {
        if (dictation.state === "idle") paint("idle");
        else if (!ready() && dictation.state === "recording") dictation.abort(); // the connection is gone: drop it
      },
      button,
    };
  }

  const api = { create, Dictation, insertAtCursor, pickMime, micError, clock, MAX_SECONDS, MIN_MS, MIME_PREFERENCE };
  if (typeof window !== "undefined") window.DeckVoice = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
