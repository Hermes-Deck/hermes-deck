"use strict";
var i18nNode = (key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).node(key, vars, typeof document === "object" ? document : null);
var i18nBind = (el, attr, key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).bind(el, attr, key, vars);
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
var i18nLocale = typeof module === "object" && module.exports ? require("./i18n").getLocale : window.DeckI18n.getLocale;
// Bot screen bar page: "<Agent> bu bilgisayarda: <App> · <time left> · Durdur". main/cua/bar.js owns the
// window; this page reports when the pointer is over Durdur (only there does the window take clicks) and
// sends the click. Strings go in through textContent only.
(() => {
  const bar = window.botbar;
  const $ = (id) => document.getElementById(id);
  const agent = $("agent");
  const app = $("app");
  const meta = $("meta");
  const stop = $("stop");
  let st = null;
  let skew = 0; // main's clock minus ours, so "time left" agrees with main
  let first = true;

  const left = (ms) => {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m >= 60) return i18nText("U0693", { v: Math.floor(m / 60), v2: m % 60 });
    return m ? i18nText("U0694", { m: m }) : "bitiyor";
  };

  function render() {
    if (!st) return;
    agent.textContent = st.agent || i18nText("A0185");
    app.textContent = st.app || i18nText("A0306");
    const parts = [];
    if (st.expires) parts.push(left(st.expires - (Date.now() + skew)));
    if (st.hotkey) parts.push(st.hotkey);
    meta.textContent = parts.join(" · ");
    stop.title = st.hotkey ? i18nText("U0695", { hotkey: st.hotkey }) : i18nText("U0696");
    i18nBind(stop, "aria-label", "common.stopAgent", { v: st.agent || i18nText("U0697") });
  }

  stop.addEventListener("mouseenter", () => bar.interactive(true));
  stop.addEventListener("mouseleave", () => bar.interactive(false));
  stop.addEventListener("click", () => bar.stop());

  bar.onState((s) => {
    if (!s || typeof s !== "object") return;
    st = s;
    if (typeof s.now === "number") skew = s.now - Date.now();
    document.body.classList.toggle("shot", !!s.shot);
    render();
    if (first) {
      first = false;
      document.fonts.ready.then(() => bar.rendered());
    }
  });
  setInterval(render, 15000);
  document.addEventListener("deck-language", () => render());
  bar.ready();
})();
