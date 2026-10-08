"use strict";
// The rail maps semantic transcript landmarks to the height of the loaded conversation.
(function (root) {
  const MAX_TICKS = 256;
  const clamp = value => Math.max(0, Math.min(1, value));
  /** At most MAX_TICKS marks in transcript order: failures and approvals always survive, the rest is sampled evenly. */
  function sample(marks) {
    if (marks.length <= MAX_TICKS) return marks;
    const keep = new Set(marks.filter(m => m.type === "approval" || m.type === "failed").slice(-Math.floor(MAX_TICKS / 2)));
    const rest = marks.filter(m => !keep.has(m)), room = MAX_TICKS - keep.size;
    for (let i = 0; i < room; i++) keep.add(rest[Math.round(i * (rest.length - 1) / Math.max(1, room - 1))]);
    return marks.filter(m => keep.has(m));
  }
  function positions(marks, height) {
    return sample(marks).map(mark => ({ ...mark, ratio: height > 0 ? clamp((Number(mark.y) || 0) / height) : 0 }));
  }
  /** A tick id that survives rebuilds and earlier insertions (focus and roving tabindex follow it). */
  function keyOf(el, type, nth) {
    if (type === "user") return el.dataset.convKey || `user-${nth}`;
    if (type === "receipt" || type === "failed") return `receipt-${el.dataset.receipt || nth}`;
    if (type === "approval") return "approval";
    return `heading-${el.closest?.(".msg")?.dataset.convKey || "x"}-${nth}`;
  }
  function nearest(marks, ratio) {
    return marks.reduce((best, mark) => !best || Math.abs(mark.ratio - ratio) < Math.abs(best.ratio - ratio) ? mark : best, null);
  }
  function mount(shell, doc = root.document) {
    const h = shell.service("h"), t = root.DeckI18n.t;
    const msgs = doc.getElementById("msgs"), inner = doc.getElementById("msgs-inner"), chat = doc.getElementById("chat");
    if (!h || !msgs || !inner) return null;
    let marks = [], dragging = false, scheduled = false, active = null;
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
      tip.hidden = !mark || slot.hidden;
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
    // One tab stop for the rail (roving tabindex); arrows walk the ticks, Enter/Space jump (native button click).
    ticks.addEventListener("keydown", e => {
      const buttons = [...ticks.children], at = buttons.indexOf(e.target);
      if (at < 0) return;
      const to = { ArrowUp: at - 1, ArrowLeft: at - 1, ArrowDown: at + 1, ArrowRight: at + 1, Home: 0, End: buttons.length - 1 }[e.key];
      if (to == null) return;
      e.preventDefault();
      const next = buttons[Math.max(0, Math.min(buttons.length - 1, to))];
      for (const b of buttons) b.setAttribute("tabindex", b === next ? "0" : "-1");
      next.focus({ preventScroll: true });
    });
    rail.addEventListener("pointerup", e => { dragging = false; if (rail.hasPointerCapture(e.pointerId)) rail.releasePointerCapture(e.pointerId); tip.hidden = true; });
    rail.addEventListener("pointercancel", () => { dragging = false; tip.hidden = true; });
    rail.addEventListener("lostpointercapture", () => { dragging = false; });
    function paint() {
      scheduled = false;
      const current = shell.last("session");
      slot.hidden = !current?.id || !inner.children.length || shell.main() !== "chat";
      if (slot.hidden) { dragging = false; tooltip(null); return; }
      const box = inner.getBoundingClientRect(), height = Math.max(inner.scrollHeight, box.height);
      const headings = new Map();
      marks = positions([...inner.querySelectorAll(".msg.out:not(.outbox):not(.sysmsg), .receipt, .text h1, .text h2, .text h3, .conv-wait")].map((el, i) => {
        const type = el.matches(".conv-wait") ? "approval" : el.matches(".receipt") ? el.dataset.failed === "true" ? "failed" : "receipt" : el.matches(".msg.out") ? "user" : "heading";
        const owner = type === "heading" ? el.closest?.(".msg") || null : null;
        const nth = type === "heading" ? (headings.set(owner, (headings.get(owner) || 0) + 1), headings.get(owner)) : i;
        return { el, key: keyOf(el, type, nth), y: el.getBoundingClientRect().top - box.top, type,
          text: (el.matches(".receipt") ? el.querySelector(".receipt-summary")?.textContent : el.querySelector(".text")?.textContent || el.textContent || "").trim().slice(0, 100) };
      }), height);
      const focused = ticks.contains(doc.activeElement) ? doc.activeElement.dataset.timelineKey : null;
      if (!marks.some(m => m.key === active)) active = marks.at(-1)?.key ?? null;
      if (focused && marks.some(m => m.key === focused)) active = focused;
      ticks.replaceChildren(...marks.map(mark => h("button", { class: `conv-tick ${mark.type}`, type: "button", style: { "--tick": `${mark.ratio * 100}%` },
        tabindex: mark.key === active ? "0" : "-1", dataset: { timelineKey: mark.key },
        "aria-label": `${t(`conv.timeline.${mark.type}`)}${mark.text ? ` · ${mark.text}` : ""}`,
        onclick: () => jump(mark), onmouseenter: () => tooltip(mark), onmouseleave: () => { if (!dragging) tooltip(null); },
        onfocus: () => { active = mark.key; tooltip(mark); }, onblur: () => tooltip(null) }, h("i", { "aria-hidden": "true" }))));
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
  const api = { positions, nearest, sample, keyOf, mount, MAX_TICKS };
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.DeckTimelineLogic = Object.freeze(api); root.DeckTimeline = mount(root.DeckShell); }
})(typeof window === "object" ? window : globalThis);
