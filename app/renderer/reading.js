"use strict";
// Reading preferences only affect transcript content; the shell and tool output keep their typography.
(function (root) {
  const DEFAULTS = Object.freeze({ agentMessages: "plain", font: "newsreader", size: 17 });
  const FONTS = Object.freeze(["newsreader", "geist", "atkinson"]);
  function normalize(value) {
    const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
      agentMessages: v.agentMessages === "bubble" ? "bubble" : "plain",
      font: FONTS.includes(v.font) ? v.font : DEFAULTS.font,
      size: Number.isInteger(v.size) && v.size >= 14 && v.size <= 20 ? v.size : DEFAULTS.size,
    };
  }
  let revision = 0;
  function apply(value, element = root.document?.documentElement) {
    const reading = normalize(value);
    revision++;
    if (element) {
      element.dataset.agentMessages = reading.agentMessages;
      element.dataset.messageFont = reading.font;
      element.style.setProperty("--message-size", `${reading.size}px`);
      element.style.setProperty("--message-leading", "1.7");
    }
    return reading;
  }
  const api = Object.freeze({ DEFAULTS, normalize, apply });
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.DeckReading = api;
    apply(DEFAULTS);
    const bootRevision = revision;
    // This script runs immediately after app.js, before its asynchronous history arrives.
    // A Settings change while the read is in flight takes precedence over that old snapshot.
    if (root.deck?.settingsGet) Promise.resolve().then(() => root.deck.settingsGet()).then(settings => {
      if (revision === bootRevision) apply(settings?.reading);
    }).catch(() => {});
    root.deck?.desktop?.onEvent?.(event => {
      if (event?.t === "settings" && event.settings) apply(event.settings.reading);
    });
  }
})(typeof window === "object" ? window : globalThis);
