"use strict";
// The split view's divider: press, drag, release. Main widens this page to the window on "start" (so the pointer's
// x is the window's content x from then on) and places the panes after every move.
(function () {
  const api = window.deckDivider;
  if (!api) return;
  let dragging = false;
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("dragging");
    api.drag("end", e.clientX);
  };
  document.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || dragging) return;
    dragging = true;
    document.body.classList.add("dragging");
    try { document.body.setPointerCapture(e.pointerId); } catch { /* capture is a nicety: the widened page gets the moves anyway */ }
    api.drag("start", e.clientX);
  });
  document.addEventListener("pointermove", (e) => { if (dragging) api.drag("move", e.clientX); });
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);
  window.addEventListener("blur", () => end({ clientX: NaN }));
})();
