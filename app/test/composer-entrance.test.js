"use strict";
// Entrance identity of transcript blocks (composer.js decorate), mounted on the DOM stand-in.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot } = require("./composer-dom-helper");

const fresh = env => env.inner.querySelectorAll(".conv-fresh").map(el => el.textContent);
function render(env, list) {
  env.inner.replaceChildren(...list.map(([who, text, extra]) => who === "u" ? env.user(text, extra) : env.agent(text, extra)));
  env.flush();
  return fresh(env);
}

test("an identical user message sent again animates only the new one", () => {
  const env = boot();
  render(env, [["u", "ok"], ["a", "first"]]);
  assert.deepEqual(render(env, [["u", "ok"], ["a", "first"], ["u", "ok"]]), ["ok"]);
  const els = env.inner.querySelectorAll(".msg.out");
  assert.equal(els[0].classList.contains("conv-fresh"), false, "the older identical message keeps its identity");
  assert.equal(els[1].classList.contains("conv-fresh"), true);
  assert.deepEqual(render(env, [["u", "ok"], ["a", "first"], ["u", "ok"], ["a", "second"]]), ["second"]);
  assert.deepEqual(render(env, [["u", "ok"], ["a", "first"], ["u", "ok"], ["a", "second"]]), [], "a rebuild never replays");
});

test("a page of older messages prepended while at the bottom never replays", () => {
  const env = boot();
  render(env, [["u", "ok"], ["a", "one"], ["u", "ok"], ["a", "two"]]);
  // the reader stays at the bottom (scrollTop 0 in the reversed list) while an older page arrives
  assert.deepEqual(render(env, [["u", "ok"], ["a", "zero"], ["u", "ok"], ["a", "one"], ["u", "ok"], ["a", "two"]]), []);
  assert.deepEqual(render(env, [["u", "ok"], ["a", "zero"], ["u", "ok"], ["a", "one"], ["u", "ok"], ["a", "two"], ["u", "next"]]), ["next"]);
});

test("live prose sealing into the stored message does not replay it", () => {
  const env = boot();
  render(env, [["u", "hello"], ["a", "reply"], ["u", "go"]]);
  assert.deepEqual(render(env, [["u", "hello"], ["a", "reply"], ["u", "go"], ["a", "stream", { class: "msg live" }]]), ["stream"]);
  assert.deepEqual(render(env, [["u", "hello"], ["a", "reply"], ["u", "go"], ["a", "streaming more", { class: "msg live" }]]), []);
  assert.deepEqual(render(env, [["u", "hello"], ["a", "reply"], ["u", "go"], ["a", "streaming more text"]]), [], "stored copy of the live block");
});

test("switching session through a loading state never animates the loaded history", () => {
  const env = boot();
  env.select({ id: "b", sid: "b", kind: "hermes", channel: "hermes", profile: "default" });
  env.inner.replaceChildren(env.h("div", { class: "empty" }, "Loading…"));
  env.flush();
  assert.deepEqual(render(env, [["u", "old question"], ["a", "old answer"]]), []);
  assert.deepEqual(render(env, [["u", "old question"], ["a", "old answer"], ["u", "new"]]), ["new"]);
  // switching back to the first session shows its history without entrances
  env.select({ id: "s", sid: "s", kind: "hermes", channel: "hermes", profile: "default" });
  assert.deepEqual(render(env, [["u", "hello"], ["a", "reply"], ["u", "ok"]]), []);
});

test("an unrelated append to the transcript keeps the request tray and queue", () => {
  const env = boot();
  const card = env.h("section", { class: "hreq", dataset: { hold: "1" }, "data-i18n-aria-label": "U0603" }, env.h("button", { dataset: { fk: "hreq:r:once" } }, "Allow"));
  const queued = env.h("div", { class: "msg out outbox" }, env.h("div", { class: "text" }, "later"));
  env.inner.append(card, queued);
  env.flush();
  const tray = env.doc.querySelector(".conv-tray"), queue = env.doc.querySelector(".conv-queue");
  assert.equal(tray.children.length, 1); assert.equal(queue.children.length, 1);
  env.inner.append(env.h("div", { class: "reaction-note" }, "👍"));
  env.flush();
  assert.equal(tray.children[0], card, "tray kept");
  assert.equal(queue.children[0], queued, "queue kept");
  assert.equal(tray.hidden, false);
  // a full rebuild without the request clears the tray
  env.inner.replaceChildren(env.user("hello"), env.agent("reply"));
  env.flush();
  assert.equal(tray.children.length, 0); assert.equal(tray.hidden, true);
  assert.equal(queue.children.length, 0); assert.equal(queue.hidden, true);
});

test("entrance and thought label maps stay bounded", () => {
  const env = boot();
  const list = [];
  for (let i = 0; i < 300; i++) { list.push(["u", `q${i}`], ["a", `a${i}`]); }
  render(env, list);
  for (let i = 0; i < 50; i++) { env.select({ id: `x${i}`, sid: `x${i}`, kind: "hermes", channel: "hermes", profile: "default" }); render(env, list.slice(0, 40)); }
  const C = require("../renderer/composer");
  const tracker = C.createEntranceTracker();
  for (let i = 0; i < 20; i++) tracker.scan(`s${i}`, Array.from({ length: 1000 }, (_, k) => `k${k}`));
  assert.ok(tracker.size() <= C.MAX_SEEN);
});
