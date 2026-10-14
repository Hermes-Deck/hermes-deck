"use strict";
// Readable numbers shared by every view (window.DeckHuman): durations ("4.2s", "2m 05s", "6h 38m", "2d 3h") and
// compact counts ("999", "12.4k", "2.9M", "2.9B") with the exact figure for tooltips. Units come from i18n.
(function (root) {
  const I = () => (typeof module === "object" && module.exports ? require("./i18n") : root.DeckI18n);
  const T = (key, vars) => I().t(key, vars);
  const locale = () => { try { return I().getLocale() || "en-US"; } catch { return "en-US"; } };
  const finite = (v) => typeof v === "number" ? Number.isFinite(v) && v >= 0 : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0;
  const pad = (n) => String(n).padStart(2, "0");

  /** Milliseconds for people: under 10 s one decimal, under a minute whole seconds, then m+s, h+m, d+h. "" when unknown. */
  function duration(ms) {
    if (ms === null || ms === undefined || !finite(ms)) return "";
    const v = Number(ms);
    const tenths = Math.round(v / 100);
    if (tenths < 100) return T("wux.dur.s", { n: tenths === 0 ? (v > 0 ? `<${(0.1).toLocaleString(locale())}` : "0") : (tenths / 10).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
    const s = Math.round(v / 1000);
    if (s < 60) return T("wux.dur.s", { n: String(s) });
    if (s < 3600) return T("wux.dur.ms", { m: Math.floor(s / 60), s: pad(s % 60) });
    if (s < 86400) return T("wux.dur.hm", { h: Math.floor(s / 3600), m: pad(Math.floor((s % 3600) / 60)) });
    return T("wux.dur.dh", { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600) });
  }

  const UNITS = [["wux.num.k", 1e3], ["wux.num.m", 1e6], ["wux.num.b", 1e9]];
  /** A count for people: below 1000 as is, then k / M / B with one decimal below 100 ("12.4k", "124k", "2.9M"). */
  function count(n) {
    const v = finite(n) ? Number(n) : 0;
    if (Math.round(v) < 1000) return Math.round(v).toLocaleString(locale());
    let i = v >= 1e9 ? 2 : v >= 1e6 ? 1 : 0;
    const scaled = (x) => (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10);
    let r = scaled(v / UNITS[i][1]);
    if (r >= 1000 && i < UNITS.length - 1) { i += 1; r = scaled(v / UNITS[i][1]); }
    return T(UNITS[i][0], { n: r.toLocaleString(locale(), { maximumFractionDigits: 1 }) });
  }

  /** The exact figure, locale-grouped ("2,905,482,981"), for a tooltip next to a compact count. */
  function exact(n) {
    return Math.round(finite(n) ? Number(n) : 0).toLocaleString(locale());
  }

  const api = { duration, count, exact };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DeckHuman = Object.freeze(api);
})(typeof window === "object" ? window : globalThis);
