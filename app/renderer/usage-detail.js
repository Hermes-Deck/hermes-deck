"use strict";
// The Usage view (window.DeckUsageDetail): a main-area view over the chat column, like Settings, opened from the
// fleet panel's "Usage details" row, Ctrl/Cmd+J without the fleet panel, or --tab=usage. It hosts the existing Usage
// renderers (app.js fill: quotas, today across all agents, profiles, services, token history); nothing is computed
// here. Back or Escape returns to the chat. Text from the relay reaches the DOM only through those renderers' h().
(function (root) {
  function create({ h, doc = root.document, t, fill, canOpen = () => true, onToggle = () => {}, host = () => doc.getElementById("chat") }) {
    let open = false, built = null, returnFocus = null;
    function build() {
      const back = h("button", { class: "linkbtn sb-back ud-back", type: "button", dataset: { fk: "ud-back" }, onclick: () => close() });
      const title = h("h2", { class: "sb-title", id: "ud-title" });
      const body = h("div", { class: "ud-body" });
      const view = h("section", { class: "ud", role: "region", "aria-labelledby": "ud-title", hidden: true, dataset: { fk: "ud" } },
        h("header", { class: "sb-head ud-head" }, back, title), body);
      view.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
        e.preventDefault();
        close();
      });
      built = { view, back, title, body };
    }
    function attach() {
      if (!built) build();
      const at = host();
      if (at && built.view.parentNode !== at) at.appendChild(built.view);
    }
    /** Re-draw the figures (the app's render loop calls this while the view is open); scroll stays where it was. */
    function refresh() {
      if (!open || !built) return;
      built.back.textContent = `‹ ${t("set.back")}`;
      built.title.textContent = t("shell.tab.usage");
      const kids = [];
      try { fill(kids); } catch (e) { kids.push(h("p", { class: "form-error", role: "alert" }, String((e && e.message) || e))); }
      const top = built.body.scrollTop;
      built.body.replaceChildren(h("div", { class: "ud-inner" }, kids));
      built.body.scrollTop = top;
    }
    function show() {
      if (open || !canOpen()) return false;
      attach();
      open = true;
      returnFocus = doc.activeElement || null;
      built.view.hidden = false;
      built.body.scrollTop = 0;
      refresh();
      built.back.focus({ preventScroll: true });
      onToggle(true);
      return true;
    }
    function close(restore = true) {
      if (!open) return;
      open = false;
      built.view.hidden = true;
      const back = returnFocus;
      returnFocus = null;
      if (restore && back && back.isConnected && typeof back.focus === "function") back.focus({ preventScroll: true });
      onToggle(false);
    }
    const language = () => refresh();
    doc.addEventListener("deck-language", language);
    return {
      open: show, close, refresh,
      toggle: () => (open ? (close(), false) : show()),
      isOpen: () => open,
      get root() { return built ? built.view : null; },
      dispose() { close(false); doc.removeEventListener("deck-language", language); if (built && built.view.parentNode) built.view.parentNode.removeChild(built.view); },
    };
  }
  const api = { create };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DeckUsageDetail = Object.freeze(api);
})(typeof window === "object" ? window : globalThis);
