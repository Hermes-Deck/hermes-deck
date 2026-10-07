"use strict";
// Colour theme for every Deck page (main window, status pet, bot screen bar): sets <html data-theme>, which
// re-points the colour tokens in styles.css. Loaded in <head> so the first paint is already in the theme.
(function () {
  const NAMES = ["basalt", "marble", "aegean"];
  const api = window.deckTheme;
  const set = (name) => {
    const t = NAMES.includes(name) ? name : "basalt";
    if (document.documentElement.dataset.theme === t) return;
    document.documentElement.dataset.theme = t;
    document.dispatchEvent(new CustomEvent("deck-theme", { detail: t }));
  };
  set(api && api.initial);
  if (api && api.onChange) api.onChange(set);
})();
