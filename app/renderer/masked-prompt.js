"use strict";
// Masked prompt cards (window.DeckMaskedPrompt). Hermes asks the user, through its server requests, for a sudo
// password (`sudo`), a named secret (`secret`), a password manager's master password (`vault.unlock_prompt`), a login
// to save and fill (`vault.save_login`) or a one-time code (`vault.code`). The bridge lists them as requests of kind
// "secret"; this module draws them in the same place and style as approval and question cards.
//  - The typed value lives only in the card's input and in this card's draft while the card is open (a re-render
//    rebuilds the card, like a question card). Submit, Cancel/Esc and a withdrawn request wipe both at once.
//  - It goes to main once (deck.bridge.answerSecret); it is never stored, logged, put in app state or echoed back.
//  - Cancel and Esc answer "" (declined). No countdown: question cards show none either.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DeckMaskedPrompt = api;
})(typeof window === "object" ? window : globalThis, function () {
  const PROMPTS = ["sudo", "secret", "vault.unlock_prompt", "vault.save_login", "vault.code"];
  const keyOf = (r) => JSON.stringify([r.profile || null, r.id, r.rpcId || ""]);
  const isCode = (r) => r.method === "vault.code";
  const isLogin = (r) => r.method === "vault.save_login";

  /** The card's title as an i18n key and its values. */
  function title(r) {
    if (r.method === "sudo") return { key: "mp.sudo", vars: {} };
    if (r.method === "secret") return r.envVar ? { key: "mp.secret", vars: { name: r.envVar } } : { key: "mp.secretUnnamed", vars: {} };
    if (r.method === "vault.unlock_prompt") return { key: "mp.unlock", vars: { name: r.displayName || "Vault" } };
    if (isLogin(r)) return { key: "mp.saveLogin", vars: { site: r.site || r.origin || "?" } };
    return r.site ? { key: "mp.code", vars: { site: r.site } } : { key: "mp.codeNoSite", vars: {} };
  }

  /** Context the agent sent with the prompt (never a value): the sudo command, the secret's prompt, the code hint. */
  function detail(r) {
    if (r.method === "sudo") return r.command ? { code: r.command } : null;
    if (r.method === "secret") return r.prompt ? { text: r.prompt } : null;
    if (isLogin(r)) return r.origin && r.origin !== r.site ? { text: r.origin } : null;
    if (isCode(r)) return r.hint ? { text: r.hint } : null;
    return null;
  }

  /**
   * ctx: {h, t(key, vars), errText(e), answer(r, value) -> Promise<{status}>, redraw()}.
   * answer gets the typed string, {identifier, password} for a login, or "" to decline.
   */
  function create(ctx) {
    const { h, t, errText = (e) => String((e && e.message) || e), answer, redraw = () => {} } = ctx;
    const drafts = new Map(); // keyOf(request) -> {identifier, secret, shown, busy, error, inputs}

    function draft(r) {
      let d = drafts.get(keyOf(r));
      if (!d) {
        d = { identifier: "", secret: "", shown: false, busy: false, error: "", inputs: [] };
        drafts.set(keyOf(r), d);
      }
      return d;
    }

    /** Forget what was typed: the draft's copy and the inputs currently on screen. */
    function wipe(d) {
      d.identifier = "";
      d.secret = "";
      d.shown = false;
      for (const input of d.inputs) {
        try {
          input.value = "";
          if (input.dataset && input.dataset.mpSecret) input.setAttribute("type", "password");
          if (input.blur) input.blur();
        } catch {
          /* already gone */
        }
      }
    }

    async function send(r, d, value) {
      d.busy = true;
      d.error = "";
      redraw();
      try {
        const res = await answer(r, value);
        if (res && (res.status === "ok" || res.status === "expired")) drafts.delete(keyOf(r));
        else d.error = t("U0036");
      } catch (e) {
        d.error = errText(e);
      } finally {
        d.busy = false;
        redraw();
      }
    }

    function submit(r, open) {
      const d = draft(r);
      if (d.busy || !open()) return;
      const identifier = d.identifier.trim();
      const secret = d.secret;
      if (isLogin(r) && (!identifier || !secret)) {
        d.error = t("mp.needLogin");
        return redraw();
      }
      if (!(isCode(r) ? secret.replace(/[\s-]/g, "") : secret)) {
        d.error = t("mp.needValue");
        return redraw();
      }
      const value = isLogin(r) ? { identifier, password: secret } : secret;
      wipe(d);
      send(r, d, value);
    }

    function cancel(r, open) {
      const d = draft(r);
      if (d.busy || !open()) return;
      wipe(d);
      send(r, d, "");
    }

    /**
     * The card for one open masked prompt. who: the session's name; open(): the connection can answer now.
     * A fresh element on every render (the draft carries what was typed), with data-fk so focus and caret come back.
     */
    function card(r, { who = "", open = () => true } = {}) {
      const d = draft(r);
      const disabled = d.busy || !open();
      const name = title(r);
      const info = detail(r);
      const keys = (e) => {
        if (e.isComposing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          submit(r, open);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancel(r, open);
        }
      };
      const field = (attrs, key) => {
        const input = h("input", { class: "hreq-text mp-input", disabled, spellcheck: "false", autocapitalize: "off", autocorrect: "off",
          dataset: { fk: `mp:${r.id}:${key}`, ...(key === "secret" ? { mpSecret: "1" } : {}) },
          oninput: (e) => { d[key] = e.target.value; }, onkeydown: keys, ...attrs });
        input.value = d[key]; // the property, never the attribute: the page's markup never carries the value
        return input;
      };
      const kids = [];
      let login = null;
      if (isLogin(r)) {
        login = field({ type: "text", autocomplete: "off", "aria-label": t("mp.identifier"), placeholder: t("mp.identifier") }, "identifier");
        kids.push(h("label", { class: "mp-field" }, h("span", null, t("mp.identifier")), login));
      }
      const secretLabel = isLogin(r) ? t("mp.password") : isCode(r) ? t("mp.codeLabel") : r.method === "secret" ? (r.envVar || t("mp.value")) : t("mp.password");
      const masked = field({
        type: d.shown ? "text" : "password",
        autocomplete: isCode(r) ? "one-time-code" : "new-password",
        ...(isCode(r) ? { inputmode: "numeric" } : {}),
        "aria-label": secretLabel, placeholder: secretLabel,
      }, "secret");
      d.inputs = login ? [login, masked] : [masked];
      const toggle = h("button", { class: "btn mini mp-show", type: "button", disabled, "aria-pressed": d.shown ? "true" : "false",
        dataset: { fk: `mp:${r.id}:show` },
        onclick: () => { d.shown = !d.shown; masked.setAttribute("type", d.shown ? "text" : "password"); toggle.setAttribute("aria-pressed", d.shown ? "true" : "false"); toggle.textContent = t(d.shown ? "mp.hide" : "mp.show"); } },
        t(d.shown ? "mp.hide" : "mp.show"));
      kids.push(h("div", { class: "mp-field mp-secret" }, isLogin(r) ? h("span", null, secretLabel) : null, h("div", { class: "mp-row" }, masked, toggle)));
      const primary = r.method === "vault.unlock_prompt" ? "mp.unlockButton" : isLogin(r) ? "mp.save" : "mp.send";
      return h("section", { class: "hreq mp", tabindex: "-1", "aria-label": t("mp.aria"),
        dataset: { hold: "1", requestId: r.id, requestProfile: r.profile, mpMethod: r.method } },
        h("div", { class: "hreq-head" }, h("span", { class: "hreq-kind" }, t(isCode(r) ? "mp.kindCode" : "mp.kindPassword")), h("span", { class: "hreq-who" }, who)),
        h("p", { class: "mp-title" }, t(name.key, name.vars)),
        info && info.code ? h("pre", { class: "hreq-cmd" }, info.code) : null,
        info && info.text ? h("p", { class: "hreq-desc" }, info.text) : null,
        h("div", { class: "mp-fields" }, kids),
        h("div", { class: "form-actions" },
          h("button", { class: "btn", type: "button", disabled, dataset: { fk: `mp:${r.id}:cancel` }, onclick: () => cancel(r, open) }, t("mp.cancel")),
          h("button", { class: "btn primary", type: "button", disabled, dataset: { fk: `mp:${r.id}:send` }, onclick: () => submit(r, open) }, d.busy ? t("U0464") : t(primary))),
        d.error ? h("p", { class: "form-error", role: "alert" }, d.error) : null);
    }

    /** Drop (and wipe) the drafts of requests that are no longer open: answered elsewhere, expired, disconnected. */
    function prune(list) {
      const open = new Set((Array.isArray(list) ? list : []).filter((r) => r && r.kind === "secret").map(keyOf));
      for (const [key, d] of drafts) {
        if (open.has(key)) continue;
        wipe(d);
        drafts.delete(key);
      }
    }

    return { card, prune, size: () => drafts.size, _drafts: drafts };
  }

  return { PROMPTS, keyOf, title, detail, create };
});
