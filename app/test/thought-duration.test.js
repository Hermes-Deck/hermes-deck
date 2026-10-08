"use strict";
// "Thought for Ns" only on the message whose reasoning was measured; older history keeps the unknown label.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot } = require("./composer-dom-helper");
const TB = require("../renderer/think-block");
const I18N = require("../renderer/i18n");
if (!Object.prototype.hasOwnProperty.call(I18N.tables.en, "conv.stop")) I18N.extend(require("../renderer/i18n-b"));

const plain = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(x => x != null) });
const label = el => el.kids[0].kids[0].kids.join("");

test("a stored message never borrows the session's latest measured duration", () => {
  const block = TB.create({ h: plain, i18nText: I18N.t, seconds: sid => (sid === "s" ? 7 : null) });
  assert.equal(label(block.el("reasoning", "s:123")), "Thought");
  assert.equal(label(block.el("reasoning", "s:live")), "Thought for 7s", "the just-finished live message is the measured one");
  assert.equal(label(block.el("reasoning", "other:live")), "Thought");
  assert.equal(label(block.el("reasoning", "s:123", 4)), "Thought for 4s", "an explicit duration wins");
});

function measuredTurn(env, seconds) {
  const LA = env.win.DeckLiveActivity.create({ h: env.h, i18nText: I18N.t, ticker: () => env.h("span"), store: null, now: () => env.clock });
  LA.event("s", "message.start", {});
  LA.event("s", "reasoning.delta", { text: "hmm" });
  env.clock += seconds * 1000;
  LA.event("s", "message.delta", { text: "done" });
  return LA;
}
const thinkMsg = (env, text, label = "Thought") => env.h("div", { class: "msg" }, env.h("details", { class: "think-block" }, env.h("summary", null, env.h("span", { class: "tb-label" }, label))), env.h("div", { class: "text" }, text));

test("the measured label lands on the finished turn's message only", () => {
  const env = boot();
  env.inner.replaceChildren(env.user("first"), thinkMsg(env, "old answer"), env.user("second"));
  env.flush();
  const LA = measuredTurn(env, 4);
  env.inner.replaceChildren(env.user("first"), thinkMsg(env, "old answer"), env.user("second"), thinkMsg(env, "new answer", "Thought for 4s"));
  env.flush();
  LA.event("s", "message.complete", {});
  env.flush();
  // the stored copy replaces the live one with the unknown label; the composer restores the measured label
  env.inner.replaceChildren(env.user("first"), thinkMsg(env, "old answer"), env.user("second"), thinkMsg(env, "new answer"));
  env.flush();
  const labels = env.inner.querySelectorAll(".tb-label").map(el => el.textContent);
  assert.deepEqual(labels, ["Thought", "Thought for 4s"]);
});

test("a turn that ends without its own message never relabels an older one", () => {
  const env = boot();
  env.inner.replaceChildren(env.user("first"), thinkMsg(env, "old answer"), env.user("second"));
  env.flush();
  const LA = measuredTurn(env, 5);
  LA.event("s", "message.complete", {});
  env.flush();
  env.inner.replaceChildren(env.user("first"), thinkMsg(env, "old answer"), env.user("second"));
  env.flush();
  env.inner.replaceChildren(env.user("first"), thinkMsg(env, "old answer"), env.user("second"), env.user("third"), thinkMsg(env, "later"));
  env.flush();
  assert.deepEqual(env.inner.querySelectorAll(".tb-label").map(el => el.textContent), ["Thought", "Thought"]);
});
