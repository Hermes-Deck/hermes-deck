"use strict";
// Timeline rail geometry and interaction, mounted on the DOM stand-in (rectangles are set by hand: not layout evidence).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot } = require("./composer-dom-helper");
const T = require("../renderer/timeline");

/** #msgs is a column-reverse scroller: scrollTop 0 is the newest message and grows negative upwards. */
function layout(env, { scrollTop = 0, viewTop = 100, viewHeight = 400, chatBottom = 700 } = {}) {
  const contentHeight = 2000;
  env.msgs.scrollTop = scrollTop;
  env.msgs.rect = { top: viewTop, bottom: viewTop + viewHeight, height: viewHeight };
  env.chat.rect = { top: 0, bottom: chatBottom, height: chatBottom };
  // content top on screen: the bottom of the content sits at the bottom of the view when scrollTop is 0
  const innerTop = viewTop + viewHeight - contentHeight - scrollTop;
  env.inner.rect = { top: innerTop, bottom: innerTop + contentHeight, height: contentHeight };
  env.inner.scrollHeight = contentHeight;
  env.inner.children.forEach((el, i, all) => { const y = innerTop + (i + 0.5) * contentHeight / all.length; el.rect = { top: y, bottom: y + 20, height: 20 }; });
}
const ticks = env => env.doc.getElementById("timeline").querySelectorAll(".conv-tick");
const rail = env => env.doc.querySelector(".conv-timeline");

test("ticks map to content position and the viewport window follows the reversed scroll", () => {
  const env = boot();
  env.inner.replaceChildren(env.user("a"), env.agent("1"), env.user("b"), env.agent("2"));
  layout(env);
  env.resize(); env.flush();
  const ratios = ticks(env).map(el => parseFloat(el.style.getPropertyValue("--tick")));
  assert.deepEqual(ratios, [12.5, 62.5]);
  const view = env.doc.querySelector(".conv-timeline-view");
  assert.equal(view.style.getPropertyValue("--view-top"), "80%", "at the newest message the window sits at the bottom");
  assert.equal(view.style.getPropertyValue("--view-height"), "20%");
  layout(env, { scrollTop: -1600 });
  env.msgs.dispatchEvent(env.event("scroll", { bubbles: false }));
  assert.equal(view.style.getPropertyValue("--view-top"), "0%", "scrolled to the oldest message");
});

test("the rail follows the composer height through #msgs resizes", () => {
  const env = boot();
  layout(env, { viewHeight: 400 });
  env.resize(); env.flush();
  const slot = env.doc.getElementById("timeline");
  assert.equal(slot.style.getPropertyValue("--timeline-top"), "124px");
  assert.equal(slot.style.getPropertyValue("--timeline-bottom"), "224px");
  layout(env, { viewHeight: 300 }); // the composer grew by 100px
  env.resize(); env.flush();
  assert.equal(slot.style.getPropertyValue("--timeline-bottom"), "324px");
});

test("click jumps to the mark; reduced motion never animates; drag scrubs with pointer capture", () => {
  const env = boot();
  env.inner.replaceChildren(env.user("a"), env.agent("1"), env.user("b"), env.agent("2"));
  layout(env);
  env.flush();
  ticks(env)[0].click();
  // mark a sits 250px into the 2000px content: 1650px above the view bottom -> scrollTop -1650 + 24px margin
  assert.equal(env.msgs.lastScroll.top, 0 + (env.inner.children[0].rect.top - 100 - 24));
  assert.equal(env.msgs.lastScroll.behavior, "auto", "reduced motion: no smooth scroll");
  env.win.matchMedia = () => ({ matches: false });
  ticks(env)[1].click();
  assert.equal(env.msgs.lastScroll.behavior, "smooth");
  rail(env).rect = { top: 100, bottom: 500, height: 400 };
  rail(env).dispatchEvent(env.event("pointerdown", { button: 0, pointerId: 3, clientY: 110 }));
  assert.equal(rail(env).captured, 3);
  assert.equal(env.msgs.lastScroll.behavior, "auto", "scrubbing never animates");
  const tip = env.doc.querySelector(".conv-timeline-tip");
  assert.equal(tip.hidden, false);
  assert.match(tip.textContent, /Your turn · a/);
  rail(env).dispatchEvent(env.event("pointermove", { pointerId: 3, clientY: 490 }));
  assert.match(tip.textContent, /· b/);
  rail(env).dispatchEvent(env.event("pointerup", { pointerId: 3 }));
  assert.equal(rail(env).captured, null);
  assert.equal(tip.hidden, true);
  const moves = env.msgs.lastScroll;
  rail(env).dispatchEvent(env.event("pointermove", { pointerId: 3, clientY: 110 }));
  assert.equal(env.msgs.lastScroll, moves, "no scrub after release");
  rail(env).dispatchEvent(env.event("pointerdown", { button: 2, pointerId: 4, clientY: 110 }));
  assert.equal(rail(env).captured, null, "secondary button does not scrub");
});

test("keyboard: one tab stop, arrows move between ticks and focus survives a rebuild", () => {
  const env = boot();
  env.inner.replaceChildren(env.user("a"), env.agent("1"), env.user("b"), env.agent("2"), env.user("c"));
  layout(env); env.flush();
  assert.deepEqual(ticks(env).map(el => el.getAttribute("tabindex")), ["-1", "-1", "0"], "the newest tick is the tab stop");
  ticks(env)[2].focus();
  env.key(ticks(env)[2], "ArrowUp");
  assert.equal(env.doc.activeElement.textContent, "", "a tick button has no visible text");
  assert.equal(env.doc.activeElement, ticks(env)[1]);
  const key = env.doc.activeElement.dataset.timelineKey;
  // an older page is prepended and the transcript is rebuilt: focus stays on the same message's tick
  env.inner.replaceChildren(env.user("older"), env.agent("0"), env.user("a"), env.agent("1"), env.user("b"), env.agent("2"), env.user("c"));
  layout(env); env.flush();
  assert.equal(env.doc.activeElement?.dataset.timelineKey, key);
  assert.match(env.doc.activeElement.getAttribute("aria-label"), /· b$/);
  assert.equal(ticks(env).filter(el => el.getAttribute("tabindex") === "0").length, 1);
  env.key(env.doc.activeElement, "Home");
  assert.match(env.doc.activeElement.getAttribute("aria-label"), /· older$/);
});

test("hidden main view or no session hides the rail and its tooltip and stops a drag", () => {
  const env = boot();
  layout(env); env.flush();
  rail(env).rect = { top: 100, bottom: 500, height: 400 };
  rail(env).dispatchEvent(env.event("pointerdown", { button: 0, pointerId: 1, clientY: 200 }));
  env.main = "inbox"; env.emitShell("main", { kind: "inbox" }); env.flush();
  const slot = env.doc.getElementById("timeline");
  assert.equal(slot.hidden, true);
  assert.equal(env.doc.querySelector(".conv-timeline-tip").hidden, true);
  const before = env.msgs.lastScroll;
  rail(env).dispatchEvent(env.event("pointermove", { pointerId: 1, clientY: 400 }));
  assert.equal(env.msgs.lastScroll, before, "the drag ended with the view");
  env.main = "chat"; env.emitShell("main", { kind: "chat" }); env.flush();
  assert.equal(slot.hidden, false);
  env.select({ id: null, sid: null, kind: null }); env.flush();
  assert.equal(slot.hidden, true);
});

test("tick sampling keeps every failure and approval within the bound", () => {
  const marks = Array.from({ length: 1000 }, (_, i) => ({ type: i % 97 === 0 ? "failed" : "user", y: i }));
  marks.push({ type: "approval", y: 1000 });
  const out = T.positions(marks, 1001);
  assert.equal(out.length, T.MAX_TICKS);
  assert.equal(out.filter(m => m.type === "failed").length, marks.filter(m => m.type === "failed").length);
  assert.equal(out.at(-1).type, "approval");
  assert.ok(out.every((m, i) => i === 0 || m.y > out[i - 1].y), "transcript order kept");
});
