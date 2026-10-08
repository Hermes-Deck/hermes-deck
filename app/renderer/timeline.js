"use strict";
// The rail maps semantic transcript landmarks to the height of the loaded conversation.
(function (root) {
  const MAX_TICKS = 256;
  const clamp = value => Math.max(0, Math.min(1, value));
  function positions(marks, height) {
    const list = marks.length <= MAX_TICKS ? marks : Array.from({ length: MAX_TICKS }, (_, i) => marks[Math.round(i * (marks.length - 1) / (MAX_TICKS - 1))]);
    return list.map(mark => ({ ...mark, ratio: height > 0 ? clamp((Number(mark.y) || 0) / height) : 0 }));
  }
  function nearest(marks, ratio) {
    return marks.reduce((best, mark) => !best || Math.abs(mark.ratio - ratio) < Math.abs(best.ratio - ratio) ? mark : best, null);
  }
  function mount(shell, doc = root.document) {
    const h = shell.service("h"), t = root.DeckI18n.t;
    const msgs = doc.getElementById("msgs"), inner = doc.getElementById("msgs-inner"), chat = doc.getElementById("chat");
    if (!h || !msgs || !inner) return null;
    let marks = [], dragging = false, scheduled = false;
    const rail = h("div", { class: "conv-timeline", role: "group", "aria-label": t("conv.timeline") });
    const ticks = h("div", { class: "conv-ticks" });
    const viewport = h("div", { class: "conv-timeline-view", "aria-hidden": "true" });
    const tip = h("span", { class: "conv-timeline-tip", role: "tooltip", hidden: true });
    rail.append(viewport, ticks, tip);
    const slot = shell.mount("timeline", rail);
    function jump(mark, smooth = true) {
      if (!mark?.el.isConnected) return;
      const delta = mark.el.getBoundingClientRect().top - msgs.getBoundingClientRect().top - 24;
      const reduced = root.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      msgs.scrollTo({ top: msgs.scrollTop + delta, behavior: smooth && !reduced ? "smooth" : "auto" });
    }
    function tooltip(mark) {
      tip.hidden = !mark;
      if (!mark) return;
      tip.textContent = `${t(`conv.timeline.${mark.type}`)}${mark.text ? ` · ${mark.text}` : ""}`;
      tip.style.setProperty("--tick", `${mark.ratio * 100}%`);
    }
    function scrub(e) {
      const rect = rail.getBoundingClientRect();
      const mark = nearest(marks, clamp((e.clientY - rect.top) / Math.max(1, rect.height)));
      tooltip(mark); jump(mark, false);
    }
    rail.addEventListener("pointerdown", e => {
      if (e.button !== 0 || !marks.length) return;
      dragging = true; rail.setPointerCapture(e.pointerId); scrub(e);
    });
    rail.addEventListener("pointermove", e => { if (dragging) scrub(e); });
    rail.addEventListener("pointerup", e => { dragging = false; if (rail.hasPointerCapture(e.pointerId)) rail.releasePointerCapture(e.pointerId); tip.hidden = true; });
    rail.addEventListener("pointercancel", () => { dragging = false; tip.hidden = true; });
    rail.addEventListener("lostpointercapture", () => { dragging = false; });
    function paint() {
      scheduled = false;
      const current = shell.last("session");
      slot.hidden = !current?.id || !inner.children.length || shell.main() !== "chat";
      if (slot.hidden) return;
      const box = inner.getBoundingClientRect(), height = Math.max(inner.scrollHeight, box.height);
      marks = positions([...inner.querySelectorAll(".msg.out:not(.outbox):not(.sysmsg), .receipt, .text h1, .text h2, .text h3, .conv-wait")].map(el => ({
        el, y: el.getBoundingClientRect().top - box.top,
        type: el.matches(".conv-wait") ? "approval" : el.matches(".receipt") ? el.dataset.failed === "true" ? "failed" : "receipt" : el.matches(".msg.out") ? "user" : "heading",
        text: (el.matches(".receipt") ? el.querySelector(".receipt-summary")?.textContent : el.querySelector(".text")?.textContent || el.textContent || "").trim().slice(0, 100)
      })), height);
      const focused = doc.activeElement?.dataset.timelineKey;
      ticks.replaceChildren(...marks.map((mark, i) => h("button", { class: `conv-tick ${mark.type}`, type: "button", style: { "--tick": `${mark.ratio * 100}%` },
        dataset: { timelineKey: mark.el.dataset.convKey || mark.el.dataset.receipt || `heading-${i}` },
        "aria-label": `${t(`conv.timeline.${mark.type}`)}${mark.text ? ` · ${mark.text}` : ""}`,
        onclick: () => jump(mark), onmouseenter: () => tooltip(mark), onmouseleave: () => { if (!dragging) tooltip(null); },
        onfocus: () => tooltip(mark), onblur: () => tooltip(null) }, h("i", { "aria-hidden": "true" }))));
      if (focused) [...ticks.children].find(el => el.dataset.timelineKey === focused)?.focus({ preventScroll: true });
      const rect = msgs.getBoundingClientRect(), chatRect = chat.getBoundingClientRect();
      slot.style.setProperty("--timeline-top", `${rect.top - chatRect.top + 24}px`);
      slot.style.setProperty("--timeline-bottom", `${Math.max(0, chatRect.bottom - rect.bottom + 24)}px`);
      updateView();
    }
    function updateView() {
      if (slot.hidden) return;
      const box = inner.getBoundingClientRect(), rect = msgs.getBoundingClientRect();
      const height = Math.max(1, inner.scrollHeight, box.height);
      viewport.style.setProperty("--view-top", `${clamp((rect.top - box.top) / height) * 100}%`);
      viewport.style.setProperty("--view-height", `${Math.min(100, Math.max(2, rect.height / height * 100))}%`);
    }
    function refresh() { if (!scheduled) { scheduled = true; root.requestAnimationFrame(paint); } }
    doc.addEventListener("deck-conversation-render", refresh);
    doc.addEventListener("deck-receipts-render", refresh);
    doc.addEventListener("deck-language", refresh);
    shell.on("session", refresh); shell.on("main", refresh); shell.on("right", refresh);
    msgs.addEventListener("scroll", updateView, { passive: true });
    const resize = new root.ResizeObserver(refresh); resize.observe(msgs); resize.observe(inner);
    refresh();
    return { refresh };
  }
  const api = { positions, nearest, mount, MAX_TICKS };
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.DeckTimelineLogic = Object.freeze(api); root.DeckTimeline = mount(root.DeckShell); }
})(typeof window === "object" ? window : globalThis);
