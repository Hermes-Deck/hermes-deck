"use strict";
// Notification chimes, synthesized with WebAudio (no audio files). "reply": two soft bell notes rising a
// fifth, for a new reply or a finished job. "ask": a brighter three-note rise, for something that waits for
// the user's answer. main asks for one through deck.desktop ({t: "chime", kind}); app.js calls deckChime().
(() => {
  const TUNES = {
    reply: { gap: 0.13, peak: 0.12, notes: [659.25, 987.77] }, // E5, B5
    ask: { gap: 0.11, peak: 0.14, notes: [880, 1108.73, 1318.51] }, // A5, C#6, E6
  };
  // [frequency multiple, level, decay s]: a sine plus two quiet inharmonic partials sounds like a small
  // bell rather than a beep
  const PARTIALS = [
    [1, 1, 1.2],
    [2.76, 0.25, 0.5],
    [5.4, 0.06, 0.25],
  ];
  let ctx = null;
  let idle = 0;

  function bell(t0, freq, peak, out) {
    for (const [mult, level, decay] of PARTIALS) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq * mult;
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(peak * level, t0 + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
      osc.connect(env).connect(out);
      osc.start(t0);
      osc.stop(t0 + decay + 0.05);
    }
  }

  window.deckChime = (kind) => {
    const tune = TUNES[kind] || TUNES.reply;
    try {
      if (!ctx) ctx = new AudioContext();
      if (ctx.state === "suspended") ctx.resume();
      const out = ctx.createGain();
      out.gain.value = 0.8;
      out.connect(ctx.destination);
      const t = ctx.currentTime + 0.03;
      tune.notes.forEach((f, i) => bell(t + i * tune.gap, f, tune.peak, out));
      // let the audio device rest once the last note has rung out
      clearTimeout(idle);
      idle = setTimeout(() => ctx && ctx.state === "running" && ctx.suspend(), 2500);
    } catch {
      /* no audio output: stay silent */
    }
  };
})();
