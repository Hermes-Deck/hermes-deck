"use strict";
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
// Inline voice-note player (window.DeckVoiceBubble), the desktop twin of the iOS VoiceBubble.
// Audio attachments (a Hermes session's file chips, the files a user sent, Telegram voice notes and audio) draw as
// one bubble instead of a file chip: play/pause, a waveform that doubles as the scrubber, elapsed/total time,
// 1x/1.5x/2x speed and a small menu for Download. Only one clip plays at a time.
//  - Part 1 is pure logic (audio detection, the plugin's default text, clock, scrub maths, waveform sampling and the
//    Telegram 5-bit waveform); the unit tests drive it directly (test/voice-bubble.test.js).
//  - Part 2 is the player: create(ctx) keeps one state per clip OUTSIDE the DOM (an unattached Audio element, the
//    waveform, the speed), so a re-render of the chat never stops playback or loses the position.
// Bytes come from the caller's `load()` ({bytes, mime}); the page builds a blob: URL itself (the CSP allows blob:
// for media) and decodes the waveform with an OfflineAudioContext. Nothing here touches a host path.
(() => {
  // ================================================================ part 1: pure logic
  const ATTACH_DEFAULT_TEXT = "Please look at the attached file(s)."; // hermes-plugin observer.py ATTACH_DEFAULT_TEXT
  const AUDIO_EXT = new Set(["m4a", "mp3", "wav", "ogg", "oga", "opus", "aac", "caf", "amr", "flac", "aif", "aiff", "webm"]);
  const MAX_BYTES = 25 * 1024 * 1024; // a clip bigger than this stays a download chip
  const BARS = 48;
  const LEVELS = 31;
  const RATES = [1, 1.5, 2];
  const STEP_S = 5; // arrow keys
  const STEP_BIG_S = 15; // Shift + arrow

  const extOf = (name) => {
    const m = /[.]([A-Za-z0-9]{1,5})$/.exec(String(name || ""));
    return m ? m[1].toLowerCase() : "";
  };
  /** An audio file by its name. webm counts here; a video .webm is rare in chats and fails soft to the file chip. */
  const isAudioName = (name) => AUDIO_EXT.has(extOf(name));
  /** Voice/audio kind (Telegram, the Deck's own), any audio/* mime, or an audio file name. `a` may be just a name. */
  function isAudio(a) {
    if (typeof a === "string") return isAudioName(a);
    if (!a || typeof a !== "object") return false;
    if (a.kind === "voice" || a.kind === "voice_note" || a.kind === "audio") return true;
    if (/^audio\//i.test(String(a.mime || ""))) return true;
    return isAudioName(a.name);
  }

  /** A generated recording name ("voice_note.ogg", "Voice message.m4a", "audio_2026-...ogg") carries no information: the bubble omits it. */
  const looksLikeVoiceNote = (name) => /^(voice|audio|recording|ptt|record|new recording)([\s_.-]|$)/i.test(String(name || "").trim());

  const echoMatch = () => (typeof module === "object" && module.exports ? require("./echo-match") : window.DeckEchoMatch);
  /** The plugin's default caption, judged by echo-match (normalized: directive lines dropped, case-insensitive). */
  const isAttachDefault = (text) => {
    const em = echoMatch();
    return em ? em.isAttachDefault(text) : String(text || "").replace(/\s+/g, " ").trim().toLowerCase() === ATTACH_DEFAULT_TEXT.toLowerCase();
  };
  /** A message whose whole text is the plugin default and that carries audio shows only the voice bubble. */
  const hidesDefaultText = (text, attachments) => isAttachDefault(text) && Array.isArray(attachments) && attachments.some(isAudio);

  /** "0:07" (floor, like the recording clock); non-finite or negative values read 0:00. */
  function clock(seconds) {
    const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  const fraction = (time, duration) => (duration > 0 && Number.isFinite(time) ? Math.min(1, Math.max(0, time / duration)) : 0);
  /** Seconds for a pointer at `x` over a waveform `width` px wide. */
  const timeAt = (x, width, duration) => (width > 0 && duration > 0 ? Math.min(duration, Math.max(0, (x / width) * duration)) : 0);
  const stepped = (time, delta, duration) => Math.min(duration > 0 ? duration : 0, Math.max(0, (Number.isFinite(time) ? time : 0) + delta));

  const nextRate = (rate) => {
    const i = RATES.findIndex((r) => Math.abs(r - rate) < 0.01);
    return i < 0 ? RATES[0] : RATES[(i + 1) % RATES.length];
  };
  const rateLabel = (rate) => (Math.abs(rate - 1.5) < 0.01 ? "1.5x" : `${Math.round(rate)}x`);

  // ---- waveform
  /** TDLib / Telegram `waveform`: 5-bit samples packed little-endian. `bytes`: Uint8Array/Buffer/array. */
  function unpack5(bytes) {
    const b = bytes || [];
    const count = Math.floor((b.length * 8) / 5);
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      const bit = i * 5;
      const byte = bit >> 3;
      const value = b[byte] | ((byte + 1 < b.length ? b[byte + 1] : 0) << 8);
      out[i] = (value >> (bit & 7)) & 0x1f;
    }
    return out;
  }
  function pack5(samples) {
    const out = new Uint8Array(Math.ceil((samples.length * 5) / 8) + 1);
    samples.forEach((s, i) => {
      const bit = i * 5;
      const v = (s & 0x1f) << (bit & 7);
      out[bit >> 3] |= v & 0xff;
      out[(bit >> 3) + 1] |= v >> 8;
    });
    return out.slice(0, Math.ceil((samples.length * 5) / 8));
  }
  /** Samples from the base64 string main sends for a Telegram voice note, or null. */
  function decodeWaveform(b64) {
    if (typeof b64 !== "string" || !b64 || b64.length > 4096) return null;
    let raw;
    try {
      raw = typeof Buffer === "function" ? Uint8Array.from(Buffer.from(b64, "base64")) : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    } catch {
      return null;
    }
    const s = unpack5(raw);
    return s.length ? s : null;
  }

  /** `count` bars in 0.08...1 from 0...31 samples: each bar takes the loudest sample of its slice; few samples repeat. */
  function bars(samples, count = BARS) {
    if (!(count > 0)) return [];
    if (!samples || !samples.length) return new Array(count).fill(0.12);
    const n = samples.length;
    return Array.from({ length: count }, (_, i) => {
      const lo = Math.floor((i * n) / count);
      const hi = Math.max(lo + 1, Math.floor(((i + 1) * n) / count));
      let peak = 0;
      for (let k = lo; k < Math.min(hi, n); k++) peak = Math.max(peak, samples[k]);
      return Math.max(0.08, Math.min(1, peak / LEVELS));
    });
  }
  /** Per-window RMS over decoded channels (arrays of floats): `count` windows across the whole clip. */
  function rmsWindows(channels, count = BARS) {
    const list = (channels || []).filter((c) => c && c.length);
    if (!list.length || !(count > 0)) return [];
    const n = list[0].length;
    const out = new Array(count).fill(0);
    for (let w = 0; w < count; w++) {
      const lo = Math.floor((w * n) / count);
      const hi = Math.max(lo + 1, Math.floor(((w + 1) * n) / count));
      let sum = 0;
      let seen = 0;
      const step = Math.max(1, Math.floor((hi - lo) / 2048)); // plenty of points per window, bounded work
      for (let i = lo; i < Math.min(hi, n); i += step) {
        let mix = 0;
        for (const c of list) mix += c[i] || 0;
        mix /= list.length;
        sum += mix * mix;
        seen++;
      }
      out[w] = seen ? Math.sqrt(sum / seen) : 0;
    }
    return out;
  }
  /** 0...31 samples from RMS values: peak-normalised and mildly compressed so quiet speech stays visible. */
  function normalize(rms) {
    const peak = Math.max(0, ...(rms || []));
    if (!(peak > 0)) return (rms || []).map(() => 0);
    return rms.map((v) => Math.min(LEVELS, Math.max(0, Math.round(Math.pow(v / peak, 0.6) * LEVELS))));
  }
  /** Decoded channels -> samples (0...31), `count` of them. */
  const waveformOf = (channels, count = BARS) => normalize(rmsWindows(channels, count));

  /** Bytes as a Uint8Array whatever realm they came from (IPC and contextBridge hand over typed arrays or buffers), else null. */
  function toBytes(raw) {
    if (!raw) return null;
    if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (Object.prototype.toString.call(raw) === "[object ArrayBuffer]") return new Uint8Array(raw);
    return null;
  }

  const logic = { toBytes, ATTACH_DEFAULT_TEXT, AUDIO_EXT, MAX_BYTES, BARS, RATES, STEP_S, STEP_BIG_S, extOf, isAudioName, isAudio, looksLikeVoiceNote, isAttachDefault, hidesDefaultText, clock, fraction, timeAt, stepped, nextRate, rateLabel, unpack5, pack5, decodeWaveform, bars, rmsWindows, normalize, waveformOf };

  // ================================================================ part 2: the player
  const MAX_LOADS = 2; // clips fetched/decoded at once
  const MAX_STATES = 80;

  /**
   * ctx: {h, mark, cleanErr, document?, makeAudio?, decode?}. `bubble(opts)`:
   *   id        stable key of the clip (a re-render finds the same player again)
   *   name      file name / label shown above the waveform (omit for a voice note)
   *   duration  seconds when already known (Telegram), waveform: 0...31 samples when already known
   *   load()    -> Promise<{bytes: Uint8Array|ArrayBuffer, mime}>; rejects with {reason: "too-big"|"not-audio"|...}
   *   menu()    -> [{label, onclick, disabled?}]  (Download ...), evaluated each time the menu opens
   *   fallback(reason) -> Element shown in place of the bubble when the clip is too big or not audio
   *   note      -> string|null: a status line under the bubble (download state or error)
   *   pending   true: a sent echo, no playback yet
   */
  function create(ctx) {
    const { h, mark, cleanErr } = ctx;
    const doc = ctx.document || (typeof document !== "undefined" ? document : null);
    const states = new Map(); // id -> state, oldest first
    const queue = [];
    let loads = 0;
    let current = null;
    let menuOpen = null; // {root, close}
    const redraw = () => mark && mark("msgs", true);

    const io =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(
            (entries) => {
              for (const e of entries) {
                if (!e.isIntersecting) continue;
                io.unobserve(e.target);
                const st = e.target.__vbState;
                if (st) ensure(st).catch(() => {});
              }
            },
            { root: null, rootMargin: "300px 0px" }
          )
        : null;

    function stateFor(opts) {
      let st = states.get(opts.id);
      if (st) {
        states.delete(opts.id);
        states.set(opts.id, st); // most recently used last
      } else {
        st = {
          id: opts.id,
          audio: null,
          url: null,
          ready: null,
          status: "idle", // idle | loading | ready | error
          reason: null,
          error: null,
          playing: false,
          rate: 1,
          time: 0,
          pendingTime: null,
          duration: 0,
          samples: null,
          drag: null,
          raf: 0,
          view: null,
        };
        states.set(opts.id, st);
        for (const [k, old] of states) {
          if (states.size <= MAX_STATES) break;
          if (old === current || old.playing) continue;
          dispose(old);
          states.delete(k);
        }
      }
      // what the caller knows now (re-supplied on every render)
      st.load = opts.load;
      if (opts.duration > 0 && !(st.audioDuration > 0)) st.duration = st.duration || opts.duration;
      if (opts.waveform && opts.waveform.length && !st.decoded) st.samples = opts.waveform;
      st.hasMeta = !!(opts.waveform && opts.waveform.length && opts.duration > 0);
      return st;
    }

    function dispose(st) {
      stopRaf(st);
      if (st.audio) {
        st.audio.pause();
        st.audio.removeAttribute("src");
      }
      if (st.url && typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(st.url);
      st.audio = null;
      st.url = null;
    }

    // ------------------------------------------------ loading
    function enqueue(job) {
      return new Promise((resolve, reject) => {
        queue.push({ job, resolve, reject });
        pump();
      });
    }
    function pump() {
      while (loads < MAX_LOADS && queue.length) {
        const q = queue.shift();
        loads++;
        Promise.resolve()
          .then(q.job)
          .then(q.resolve, q.reject)
          .finally(() => {
            loads--;
            pump();
          });
      }
    }

    let decoder = null;
    async function decodeChannels(bytes) {
      if (ctx.decode) return ctx.decode(bytes);
      const Offline = typeof OfflineAudioContext === "function" ? OfflineAudioContext : typeof webkitOfflineAudioContext === "function" ? webkitOfflineAudioContext : null;
      if (!Offline) return null;
      decoder = decoder || new Offline(1, 1, 44100); // decodeAudioData on an offline context needs no user gesture and counts against no live-context limit
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); // decodeAudioData detaches its input
      const buf = await decoder.decodeAudioData(copy);
      return { duration: buf.duration, channels: Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i)) };
    }

    function ensure(st) {
      if (st.ready) return st.ready;
      st.status = "loading";
      st.error = null;
      st.reason = null;
      paint(st);
      const p = enqueue(async () => {
        const r = await st.load();
        const raw = r && r.bytes;
        const bytes = toBytes(raw);
        if (!bytes || !bytes.length) throw Object.assign(new Error("empty"), { reason: "unavailable" });
        if (bytes.length > MAX_BYTES) throw Object.assign(new Error("too big"), { reason: "too-big" });
        const url = URL.createObjectURL(new Blob([bytes], { type: (r && r.mime) || "audio/mpeg" }));
        const audio = ctx.makeAudio ? ctx.makeAudio() : new Audio();
        audio.preload = "auto";
        wire(st, audio);
        if (st.url) URL.revokeObjectURL(st.url);
        st.url = url;
        audio.src = url;
        st.audio = audio;
        if (!st.hasMeta) {
          try {
            const dec = await decodeChannels(bytes);
            if (dec) {
              st.samples = waveformOf(dec.channels, BARS);
              st.decoded = true;
              if (dec.duration > 0) st.audioDuration = dec.duration;
            }
          } catch {
            // an undecodable clip may still play (or fail below); the bars stay flat
          }
        }
        if (st.audioDuration > 0) st.duration = st.audioDuration;
        st.status = "ready";
        paint(st);
      }).catch((e) => {
        st.status = "error";
        st.reason = (e && e.reason) || "unavailable";
        st.error = cleanErr ? cleanErr(e) : String((e && e.message) || e);
        st.ready = null;
        if (st.reason === "too-big" || st.reason === "not-audio") redraw(); // the caller's fallback chip replaces the bubble
        else paint(st);
        throw e;
      });
      st.ready = p;
      p.catch(() => {});
      return p;
    }

    function wire(st, audio) {
      audio.addEventListener("loadedmetadata", () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          st.audioDuration = audio.duration;
          st.duration = audio.duration;
        }
        if (st.pendingTime != null) {
          audio.currentTime = Math.min(st.pendingTime, st.duration || st.pendingTime);
          st.pendingTime = null;
        }
        paint(st);
      });
      audio.addEventListener("play", () => {
        st.playing = true;
        startRaf(st);
        paint(st);
      });
      audio.addEventListener("pause", () => {
        st.playing = false;
        stopRaf(st);
        st.time = audio.currentTime || 0;
        paint(st);
      });
      audio.addEventListener("ended", () => {
        st.playing = false;
        stopRaf(st);
        st.time = 0;
        audio.currentTime = 0;
        paint(st);
      });
      audio.addEventListener("timeupdate", () => {
        if (!st.playing) st.time = audio.currentTime || 0;
        paint(st);
      });
      audio.addEventListener("error", () => {
        st.playing = false;
        stopRaf(st);
        st.status = "error";
        st.reason = "play";
        st.error = i18nText("vb.cantPlay");
        st.ready = null;
        paint(st);
      });
    }

    // the playhead repaints every frame while playing (injectable for tests)
    const raf = ctx.raf || ((fn) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : setTimeout(fn, 100)));
    const unraf = ctx.unraf || ((id) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id)));
    function startRaf(st) {
      stopRaf(st);
      const tick = () => {
        if (!st.playing || !st.audio) return;
        st.time = st.audio.currentTime || 0;
        paint(st);
        st.raf = raf(tick);
      };
      st.raf = raf(tick);
    }
    function stopRaf(st) {
      if (st.raf) unraf(st.raf);
      st.raf = 0;
    }

    // ------------------------------------------------ transport
    function pause(st) {
      if (st.audio) st.audio.pause();
    }
    async function play(st) {
      try {
        if (st.status !== "ready") await ensure(st);
      } catch {
        return;
      }
      const audio = st.audio;
      if (!audio) return;
      if (current && current !== st) pause(current); // one player at a time
      current = st;
      audio.playbackRate = st.rate;
      if (st.pendingTime != null && audio.readyState >= 1) {
        audio.currentTime = st.pendingTime;
        st.pendingTime = null;
      }
      try {
        await audio.play();
      } catch (e) {
        if (!e || e.name !== "AbortError") {
          st.status = "error";
          st.reason = "play";
          st.error = i18nText("vb.cantPlay");
          st.ready = null;
          paint(st);
        }
      }
    }
    const toggle = (st) => (st.playing ? pause(st) : play(st));
    function seek(st, seconds) {
      const t = Math.min(st.duration || seconds, Math.max(0, seconds));
      st.time = t;
      if (st.audio && st.audio.readyState >= 1) st.audio.currentTime = t;
      else st.pendingTime = t; // applied when the clip is loaded
      paint(st);
    }
    function setRate(st) {
      st.rate = nextRate(st.rate);
      if (st.audio) st.audio.playbackRate = st.rate;
      paint(st);
    }

    // ------------------------------------------------ view
    function paint(st) {
      const v = st.view;
      if (!v) return;
      const dur = st.duration || 0;
      const t = st.drag != null ? st.drag * dur : st.time;
      const p = st.drag != null ? st.drag : fraction(t, dur);
      v.over.style.setProperty("--p", `${(p * 100).toFixed(2)}%`);
      v.time.textContent = `${clock(t)} / ${clock(dur)}`;
      v.root.dataset.state = st.status === "error" ? "error" : st.playing ? "playing" : st.status === "loading" ? "loading" : "idle";
      const label = st.playing ? i18nText("vb.pause") : i18nText("vb.play");
      v.play.setAttribute("aria-label", label);
      v.play.title = label;
      v.play.setAttribute("aria-pressed", st.playing ? "true" : "false");
      v.wave.setAttribute("aria-valuemax", String(Math.max(0, Math.floor(dur))));
      v.wave.setAttribute("aria-valuenow", String(Math.floor(t)));
      v.wave.setAttribute("aria-valuetext", i18nText("vb.position", { time: clock(t), total: clock(dur) }));
      v.rate.textContent = rateLabel(st.rate);
      v.rate.setAttribute("aria-label", i18nText("vb.speed", { rate: rateLabel(st.rate) }));
      if (v.paintedSamples !== st.samples) {
        v.paintedSamples = st.samples;
        const heights = bars(st.samples, BARS);
        heights.forEach((x, i) => {
          const value = `${Math.round(x * 100)}%`; // both layers share the heights; the "on" layer is clipped by --p
          v.barEls[i].style.setProperty("--h", value);
          v.overEls[i].style.setProperty("--h", value);
        });
        v.root.classList.toggle("flat", !st.samples);
      }
      if (v.err) {
        v.err.textContent = st.status === "error" ? st.error || i18nText("vb.failed") : "";
        v.err.hidden = st.status !== "error";
      }
    }

    function closeMenu() {
      if (!menuOpen) return;
      menuOpen.close();
      menuOpen = null;
    }
    if (doc && doc.addEventListener) {
      doc.addEventListener("pointerdown", (e) => {
        if (menuOpen && !menuOpen.root.contains(e.target)) closeMenu();
      });
      doc.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && menuOpen) {
          const back = menuOpen.button;
          closeMenu();
          if (back && back.focus) back.focus();
        }
      });
    }

    function bubble(opts) {
      const st = stateFor(opts);
      if (st.status === "error" && (st.reason === "too-big" || st.reason === "not-audio") && opts.fallback) return opts.fallback(st.reason);
      const hadFocus = !!(st.view && st.view.wave && doc && st.view.wave === doc.activeElement);
      const mk = () => h("span", { class: "vb-bar" });
      const barEls = Array.from({ length: BARS }, mk);
      const overEls = Array.from({ length: BARS }, mk);
      const base = h("div", { class: "vb-bars", "aria-hidden": "true" }, ...barEls);
      const over = h("div", { class: "vb-bars vb-on", "aria-hidden": "true" }, ...overEls);
      const play = h("button", { class: "vb-play", type: "button", disabled: !!opts.pending, onclick: () => toggle(st) });
      const wave = h("div", { class: "vb-wave", role: "slider", tabindex: opts.pending ? "-1" : "0", "aria-label": i18nText("vb.seek"), "aria-valuemin": "0", "aria-valuemax": "0", "aria-valuenow": "0" }, base, over);
      const time = h("span", { class: "vb-time" });
      const rate = h("button", { class: "vb-rate", type: "button", disabled: !!opts.pending, onclick: () => setRate(st) });
      const more = opts.menu ? h("button", { class: "vb-more", type: "button", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": i18nText("vb.more"), title: i18nText("vb.more") }, "⋯") : null;
      const err = h("span", { class: "vb-err", role: "alert", hidden: true });
      const name = opts.name ? h("span", { class: "vb-name", title: opts.name }, opts.name) : null;
      const root = h("div", { class: `vb${opts.pending ? " pending" : ""}`, role: "group", "aria-label": `${i18nText("A0350")}${opts.name ? `: ${opts.name}` : ""}`, dataset: { vb: opts.id } }, play, h("div", { class: "vb-body" }, name, wave), h("div", { class: "vb-side" }, time, h("span", { class: "vb-ctl" }, rate, more)), err);
      st.view = { root, wave, play, time, rate, over, err, barEls, overEls, paintedSamples: undefined };

      // scrubbing: press/drag on the waveform, commit on release
      if (!opts.pending) {
        const at = (e) => {
          const r = wave.getBoundingClientRect();
          return r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
        };
        wave.addEventListener("pointerdown", (e) => {
          if (e.button !== undefined && e.button !== 0) return;
          st.drag = at(e);
          if (wave.setPointerCapture) wave.setPointerCapture(e.pointerId);
          wave.focus({ preventScroll: true });
          paint(st);
          if (st.status === "idle") ensure(st).catch(() => {}); // a click on a clip that has not loaded yet starts loading it
        });
        wave.addEventListener("pointermove", (e) => {
          if (st.drag == null) return;
          st.drag = at(e);
          paint(st);
        });
        const end = (e) => {
          if (st.drag == null) return;
          const f = st.drag;
          st.drag = null;
          seek(st, f * (st.duration || 0));
          if (e && e.type === "pointerup" && st.duration) paint(st);
        };
        wave.addEventListener("pointerup", end);
        wave.addEventListener("pointercancel", () => {
          st.drag = null;
          paint(st);
        });
        wave.addEventListener("keydown", (e) => {
          const big = e.shiftKey ? STEP_BIG_S : STEP_S;
          let handled = true;
          if (e.key === " " || e.key === "Enter") toggle(st);
          else if (e.key === "ArrowRight") seek(st, stepped(st.time, big, st.duration));
          else if (e.key === "ArrowLeft") seek(st, stepped(st.time, -big, st.duration));
          else if (e.key === "Home") seek(st, 0);
          else if (e.key === "End") seek(st, Math.max(0, (st.duration || 0) - 0.05));
          else handled = false;
          if (handled) {
            e.preventDefault();
            e.stopPropagation(); // the message list's own arrow navigation must not see these
          }
        });
        if (io && st.status === "idle" && !st.hasMeta) {
          root.__vbState = st;
          io.observe(root); // loads (and draws the waveform) when it scrolls near; Telegram clips that carry their own waveform wait for Play
        }
      }

      // the Download menu
      if (more) {
        more.addEventListener("click", (e) => {
          e.stopPropagation();
          if (menuOpen && menuOpen.root === root) return closeMenu();
          closeMenu();
          const items = opts.menu() || [];
          const pop = h("div", { class: "vb-menu", role: "menu" }, ...items.map((it) => h("button", { class: "vb-item", type: "button", role: "menuitem", disabled: !!it.disabled, onclick: () => (closeMenu(), it.onclick && it.onclick()) }, it.label)));
          root.appendChild(pop);
          more.setAttribute("aria-expanded", "true");
          const first = pop.querySelector("button:not([disabled])");
          if (first) first.focus();
          pop.addEventListener("keydown", (ev) => {
            const btns = [...pop.querySelectorAll("button:not([disabled])")];
            const i = btns.indexOf(doc.activeElement);
            if (ev.key === "ArrowDown" && btns.length) (ev.preventDefault(), btns[(i + 1) % btns.length].focus());
            else if (ev.key === "ArrowUp" && btns.length) (ev.preventDefault(), btns[(i + btns.length - 1) % btns.length].focus());
          });
          menuOpen = {
            root,
            button: more,
            close: () => {
              pop.remove();
              more.setAttribute("aria-expanded", "false");
            },
          };
        });
      }

      paint(st);
      if (hadFocus && typeof requestAnimationFrame === "function") requestAnimationFrame(() => root.isConnected && wave.focus({ preventScroll: true }));
      const note = opts.note ? opts.note() : null;
      return note ? h("div", { class: "vb-wrap" }, root, h("span", { class: "vb-note", role: "status" }, note)) : root;
    }

    /** Pause whatever plays (a chat switch does not need this: the clip keeps its state). */
    const pauseAll = () => current && pause(current);
    return { ...logic, bubble, stateFor, play, pause, toggle, seek, pauseAll, states, current: () => current, pending: () => ({ queued: queue.length, loads }) };
  }

  const api = { ...logic, create };
  if (typeof window !== "undefined") window.DeckVoiceBubble = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api;
})();
