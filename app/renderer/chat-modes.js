"use strict";
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
var i18nLocale = typeof module === "object" && module.exports ? require("./i18n").getLocale : window.DeckI18n.getLocale;
// Shared mode policy: main gates Telegram startup; the renderer owns the active (not default) mode.
(() => {
  const ORDER = ["telegram", "sessions", "bots"];
  const TEXT = {
    get title() { return i18nText("chat.modes"); }, get picker() { return i18nText("chat.pickModes"); },
    get intro() { return i18nText("chat.pickHelp"); },
    labels: { telegram: "Telegram", get sessions() { return i18nText("A0312"); }, get bots() { return i18nText("A0313"); } },
    descriptions: { get telegram() { return i18nText("chat.telegramHelp"); }, get sessions() { return i18nText("chat.sessionHelp"); }, get bots() { return i18nText("chat.botHelp"); } },
    get default() { return i18nText("chat.default"); }, get next() { return i18nText("A0229"); }, get skip() { return i18nText("chat.skip"); }, get save() { return i18nText("A0151"); }, get saved() { return i18nText("chat.saved"); },
    get minimum() { return i18nText("chat.minimum"); }, get shortcut() { return i18nText("chat.shortcut"); },
  };
  const enabled = (chat) => ORDER.filter((v) => !chat || !Array.isArray(chat.modes) || chat.modes.includes(v));
  const start = (chat) => enabled(chat).includes(chat && chat.defaultMode) ? chat.defaultMode : enabled(chat)[0];
  const switchItems = (chat) => enabled(chat).length > 1 ? enabled(chat) : [];
  const next = (chat, current) => { const modes = enabled(chat); return modes[(modes.indexOf(current) + 1) % modes.length]; };
  const telegramReady = (settings) => !!settings && settings.firstRunDone !== false && enabled(settings.chat).includes("telegram");
  // One editor for first run and Settings; updates controls in place so keyboard focus survives.
  function editor(h, draft, { firstRun = false } = {}) {
    const checks = new Map();
    const radios = new Map();
    const error = h("p", { class: "form-error", role: "alert" });
    const select = firstRun ? null : h("select", { id: "s-chat-default", onchange: (e) => { draft.defaultMode = e.target.value; } });
    function sync() {
      for (const v of ORDER) {
        const on = draft.modes.includes(v);
        checks.get(v).checked = on;
        if (firstRun) {
          radios.get(v).disabled = !on;
          radios.get(v).checked = on && draft.defaultMode === v;
        }
      }
      if (select) select.replaceChildren(...enabled(draft).map((v) => h("option", { value: v, selected: v === draft.defaultMode ? true : null }, TEXT.labels[v])));
    }
    const cards = ORDER.map((v) => {
      const check = h("input", { type: "checkbox", value: v, checked: draft.modes.includes(v),
        ...(firstRun ? {} : { role: "switch" }),
        onchange: (e) => {
          if (!e.target.checked && draft.modes.length === 1) {
            error.textContent = TEXT.minimum;
          } else {
            draft.modes = ORDER.filter((id) => id === v ? e.target.checked : draft.modes.includes(id));
            if (!draft.modes.includes(draft.defaultMode)) draft.defaultMode = draft.modes[0];
            error.textContent = "";
          }
          sync();
        } });
      checks.set(v, check);
      const radio = firstRun ? h("input", { type: "radio", name: "chat-default", value: v, checked: draft.defaultMode === v,
        disabled: !draft.modes.includes(v), onchange: () => { draft.defaultMode = v; sync(); } }) : null;
      if (radio) radios.set(v, radio);
      return h("div", { class: "chat-mode-card" },
        h("label", { class: "chat-mode-choice" }, check, h("span", null, h("strong", null, TEXT.labels[v]), firstRun ? null : h("small", null, TEXT.descriptions[v]))),
        radio ? h("label", { class: "chat-mode-default" }, radio, TEXT.default) : null);
    });
    sync();
    return h("div", { class: "chat-mode-editor", id: firstRun ? "first-run-chat-modes" : "settings-chat-modes" },
      cards, select ? h("label", { class: "field", for: "s-chat-default" }, h("span", { class: "flabel" }, TEXT.default), select) : null, error);
  }
  const api = { ORDER, TEXT, enabled, start, switchItems, next, telegramReady, editor };
  if (typeof window !== "undefined") window.DeckChatModes = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api;
})();
