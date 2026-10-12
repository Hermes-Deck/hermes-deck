"use strict";
// Notification sounds. Each event (a new reply, a finished task, an approval, a question, a finished sub-agent)
// plays what Settings > Desktop > Notifications says (main/sounds.js): a built-in sound synthesized here with
// WebAudio (no audio files ship with the app), nothing, or the user's own file, played from the profile as
// deck://app/user-sound/<name>. main asks for an event through deck.desktop ({t: "chime", kind: <event>});
// app.js calls deckChime(event, settings). The settings view previews any choice with DeckSounds.play().
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.DeckSounds = api;
    root.deckChime = (event, settings) => api.playEvent(event, settings);
  }
})(typeof window === "object" ? window : globalThis, function (root) {
  // [frequency multiple, level, decay s]: a sine plus quiet inharmonic partials sounds like a small bell, a
  // strong fourth partial with a short decay like a wooden bar, slower high partials like glass
  const BELL = [[1, 1, 1.2], [2.76, 0.25, 0.5], [5.4, 0.06, 0.25]];
  const WOOD = [[1, 1, 0.38], [3.93, 0.22, 0.08], [9.8, 0.03, 0.03]];
  const GLASS = [[1, 1, 1.8], [2.32, 0.3, 0.9], [4.25, 0.08, 0.4]];
  // notes: [start s, frequency Hz, slide-to Hz?]. Keep the ids the same as main/sounds.js PRESETS.
  const TUNES = {
    bell: { voice: BELL, peak: 0.12, notes: [[0, 659.25], [0.13, 987.77]] }, // E5, B5: the original reply chime
    rise: { voice: BELL, peak: 0.14, notes: [[0, 880], [0.11, 1108.73], [0.22, 1318.51]] }, // A5, C#6, E6: the original ask chime
    chord: { voice: BELL, peak: 0.1, notes: [[0, 523.25], [0.07, 659.25], [0.14, 783.99], [0.21, 1046.5]] }, // C major: done
    pop: { voice: [[1, 1, 0.13]], peak: 0.24, notes: [[0, 900, 320]] },
    marimba: { voice: WOOD, peak: 0.22, notes: [[0, 783.99], [0.12, 1174.66]] }, // G5, D6
    glass: { voice: GLASS, peak: 0.07, notes: [[0, 1567.98], [0.09, 2093]] }, // G6, C7
    knock: { voice: [[1, 1, 0.09]], wave: "triangle", peak: 0.4, notes: [[0, 210, 150], [0.14, 210, 150]] },
    tick: { voice: [[1, 1, 0.05], [2.4, 0.2, 0.02]], peak: 0.08, notes: [[0, 1760]] },
    alert: { voice: [[1, 1, 0.16], [2, 0.12, 0.08]], wave: "triangle", peak: 0.14, notes: [[0, 987.77], [0.17, 783.99], [0.34, 987.77], [0.51, 783.99]] },
  };
  const PRESETS = Object.keys(TUNES);
  const EVENTS = ["reply", "done", "approval", "question", "subagent"];
  const DEFAULT_EVENTS = { reply: "preset:bell", done: "preset:chord", approval: "preset:rise", question: "preset:rise", subagent: "preset:tick" };
  const DEFAULT_VOLUME = 80;
  const OWN_RE = /^[a-f0-9]{16}\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|webm)$/; // main/sounds.js NAME_RE
  const MAX_PLAY_MS = 10000; // an own file longer than this is cut: a notification, not a song

  /** What an event plays under these settings: {value: "preset:<id>" | "" | stored name, volume: 0..100}. */
  function resolve(event, settings) {
    const ev = event === "ask" ? "question" : EVENTS.includes(event) ? event : "reply";
    const s = settings && settings.sounds && typeof settings.sounds === "object" ? settings.sounds : {};
    const v = s.events && typeof s.events[ev] === "string" ? s.events[ev] : DEFAULT_EVENTS[ev];
    const known = v === "" || OWN_RE.test(v) || (v.startsWith("preset:") && PRESETS.includes(v.slice(7)));
    const volume = Number.isInteger(s.volume) && s.volume >= 0 && s.volume <= 100 ? s.volume : DEFAULT_VOLUME;
    return { value: known ? v : DEFAULT_EVENTS[ev], volume };
  }

  let ctx = null;
  let idle = 0;
  let own = null; // the own file playing now: {audio, timer}

  function tone(t0, freq, slide, voice, wave, peak, out) {
    for (const [mult, level, decay] of voice) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = wave || "sine";
      osc.frequency.setValueAtTime(freq * mult, t0);
      if (slide) osc.frequency.exponentialRampToValueAtTime(slide * mult, t0 + decay);
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * level), t0 + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
      osc.connect(env).connect(out);
      osc.start(t0);
      osc.stop(t0 + decay + 0.05);
    }
  }

  function playPreset(id, volume) {
    const tune = TUNES[id];
    if (!tune || typeof root.AudioContext !== "function") return false;
    if (!ctx) ctx = new root.AudioContext();
    if (ctx.state === "suspended") ctx.resume();
    const out = ctx.createGain();
    out.gain.value = volume / 100; // 80 (the default) = the level the single chime always had
    out.connect(ctx.destination);
    const t = ctx.currentTime + 0.03;
    for (const [at, f, slide] of tune.notes) tone(t + at, f, slide, tune.voice, tune.wave, tune.peak, out);
    // let the audio device rest once the last note has rung out
    clearTimeout(idle);
    idle = setTimeout(() => ctx && ctx.state === "running" && ctx.suspend(), 3000);
    return true;
  }

  /** Stops the own file playing now (a preview the user cut short, or the next sound replacing it). */
  function stop() {
    if (!own) return;
    clearTimeout(own.timer);
    try {
      own.audio.pause();
    } catch {
      /* already gone */
    }
    own = null;
  }

  function playOwn(name, volume) {
    if (!OWN_RE.test(name) || typeof root.Audio !== "function") return false;
    stop(); // one own sound at a time
    const audio = new root.Audio(`deck://app/user-sound/${name}`);
    audio.volume = volume / 100;
    const mine = { audio, timer: setTimeout(() => own === mine && stop(), MAX_PLAY_MS) };
    own = mine;
    audio.addEventListener("ended", () => own === mine && stop());
    const p = audio.play();
    if (p && typeof p.catch === "function") p.catch(() => own === mine && stop()); // unreadable or removed file: silent
    return true;
  }

  /** Plays one sound value ("preset:<id>", "" or a stored name) at volume 0..100. False when nothing plays. */
  function play(value, volume = DEFAULT_VOLUME) {
    const vol = Number.isFinite(volume) ? Math.min(100, Math.max(0, volume)) : DEFAULT_VOLUME;
    if (typeof value !== "string" || !value || vol === 0) return false;
    try {
      if (value.startsWith("preset:")) return playPreset(value.slice(7), vol);
      return playOwn(value, vol);
    } catch {
      return false; // no audio output: stay silent
    }
  }

  /** Plays an event's sound under the given settings snapshot (S.settings). */
  function playEvent(event, settings) {
    const { value, volume } = resolve(event, settings);
    return play(value, volume);
  }

  return { PRESETS, EVENTS, DEFAULT_EVENTS, DEFAULT_VOLUME, OWN_RE, MAX_PLAY_MS, resolve, play, playEvent, stop };
});
