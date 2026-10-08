"use strict";
// Mounted integration of the conversation modules on a deterministic DOM stand-in (not visual evidence).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot } = require("./composer-dom-helper");

const approvalCard = (env, id = "r1") => env.h("section", { class: "hreq", dataset: { hold: "1" }, "aria-label": "Approval", "data-i18n-aria-label": "U0603" },
  env.h("button", { class: "btn", type: "button", dataset: { fk: `hreq:${id}:once` } }, "Allow once"));
const questionCard = (env, id = "q1") => env.h("section", { class: "hreq", dataset: { hold: "1" }, "aria-label": "Question", "data-i18n-aria-label": "U0606" },
  env.h("input", { class: "hreq-text", type: "text", dataset: { fk: `hreqt:${id}:a` } }));

test("boot registers every conversation module and mounts the status row and rail into their slots", () => {
  const env = boot();
  assert.ok(env.win.DeckComposer && env.win.DeckReceipts && env.win.DeckTimeline);
  const status = env.doc.getElementById("composer-status");
  assert.equal(status.parentNode, env.composer, "status slot moved inside the composer");
  assert.ok(status.querySelector(".conv-status"));
  assert.equal(status.hidden, true, "idle: status hidden");
  assert.ok(env.composer.contains(env.input) && env.composer.contains(env.send), "original input and send survive");
  assert.equal(env.input.value, "Retained draft");
  assert.ok(env.doc.querySelector(".conv-footer .conv-via"));
  assert.equal(env.doc.querySelector(".conv-via").hidden, true, "direct session: no route line");
  assert.equal(env.doc.getElementById("timeline").querySelectorAll(".conv-tick").length, 1, "one user tick");
});

test("module-owned insertions do not start a decorate/paint feedback loop", () => {
  const env = boot();
  env.fire("deck-conversation-turn", { sid: "s", type: "message.start", payload: {}, at: env.clock });
  env.fire("deck-conversation-turn", { sid: "s", type: "tool.start", payload: { tool_id: "c1", name: "terminal" }, at: env.clock });
  assert.ok(env.flush() <= 6);
  assert.equal(env.inner.querySelectorAll(".receipt").length, 1);
  // A quiet second flush does nothing.
  assert.equal(env.flush(), 0);
});

test("a full transcript replacement re-decorates, keeps receipts anchored and never replays entrances", () => {
  const env = boot();
  env.fire("deck-conversation-turn", { sid: "s", type: "message.start", payload: {}, at: env.clock });
  env.fire("deck-conversation-turn", { sid: "s", type: "tool.start", payload: { tool_id: "c1", name: "terminal" }, at: env.clock });
  env.fire("deck-conversation-turn", { sid: "s", type: "tool.complete", payload: { tool_id: "c1", result: "ok" }, at: env.clock + 10 });
  env.flush();
  assert.equal(env.inner.querySelectorAll(".conv-fresh").length, 0, "history on boot never animates");
  env.inner.replaceChildren(env.user("hello"), env.agent("reply"), env.user("again"), env.agent("second"));
  env.flush();
  const fresh = env.inner.querySelectorAll(".conv-fresh").map(el => el.textContent);
  assert.deepEqual(fresh, ["again", "second"]);
  // The original turn's receipt stays in the first turn, before its prose.
  const kids = env.inner.children.map(el => el.className.split(" ")[0] + ":" + el.textContent.slice(0, 6));
  assert.equal(env.inner.children[1].classList.contains("receipt"), true, kids.join(","));
  env.inner.replaceChildren(env.user("hello"), env.agent("reply"), env.user("again"), env.agent("second"));
  env.flush();
  assert.equal(env.inner.querySelectorAll(".conv-fresh").length, 0, "rebuild never replays");
});

test("session switching clears receipts of the other session and resets the via line", () => {
  const env = boot();
  env.fire("deck-conversation-turn", { sid: "s", type: "tool.start", payload: { tool_id: "c1", name: "terminal" }, at: env.clock });
  env.flush();
  assert.equal(env.inner.querySelectorAll(".receipt").length, 1);
  env.select({ id: "chat-1", kind: "telegram", channel: "telegram", sid: null });
  env.inner.replaceChildren(env.user("hi"));
  env.flush();
  assert.equal(env.inner.querySelectorAll(".receipt").length, 0);
  assert.equal(env.doc.querySelector(".conv-via").hidden, true, "telegram session: no route line");
  assert.equal(env.doc.querySelector(".conv-via").textContent, "");
});

test("approval and question cards move into the composer tray with handlers and focus intact", () => {
  const env = boot();
  let answered = 0;
  const card = approvalCard(env);
  card.querySelector("button").addEventListener("click", () => answered++);
  env.inner.append(card);
  env.flush();
  const tray = env.doc.querySelector(".conv-tray");
  assert.equal(tray.hidden, false);
  assert.equal(tray.children[0], card, "the same node moved, never cloned");
  tray.querySelector("button").click();
  assert.equal(answered, 1);
  assert.equal(env.inner.querySelector(".conv-wait").textContent, "Waiting for your approval below");
  // A rebuild re-creates the request card; a focused answer field keeps focus and caret.
  const q = questionCard(env);
  env.inner.replaceChildren(env.user("hello"), env.agent("reply"), q);
  env.flush();
  const field = tray.querySelector("input");
  field.focus(); field.selectionStart = 2; field.selectionEnd = 3; field.dispatchEvent(env.event("input", { target: field }));
  env.inner.replaceChildren(env.user("hello"), env.agent("reply"), questionCard(env));
  env.flush();
  assert.equal(tray.querySelectorAll(".hreq").length, 1);
  assert.equal(env.doc.activeElement, tray.querySelector("input"), "focus restored on the rebuilt field");
  assert.equal(env.doc.activeElement.selectionStart, 2);
  assert.equal(env.inner.querySelector(".conv-wait").textContent, "Waiting for your answer below");
  // Answered: the next render has no card and the tray closes.
  env.inner.replaceChildren(env.user("hello"), env.agent("reply"));
  env.flush();
  assert.equal(tray.hidden, true);
  assert.equal(env.inner.querySelector(".conv-wait"), null);
});

test("Stop and Escape interrupt the running turn once and hide the working status", async () => {
  const env = boot();
  env.bridgeEvent({ t: "snapshot", snapshot: { nodes: [{ sid: "s", state: "working", turnId: "t1", controlAvailable: true, ownerPid: 7, steps: ["terminal"] }] } });
  env.flush();
  const status = env.doc.getElementById("composer-status");
  assert.equal(status.hidden, false);
  assert.ok(env.composer.classList.contains("conv-working"));
  const stop = env.doc.querySelector(".conv-stop");
  assert.equal(stop.disabled, false);
  const e = env.key(env.input, "Escape");
  assert.equal(e.defaultPrevented, true);
  await env.settle();
  assert.equal(env.mutations.length, 1);
  assert.equal(JSON.stringify(env.mutations[0]), JSON.stringify(["s", { profile: "default", turnId: "t1" }]));
  assert.equal(status.hidden, true);
  // A lagging snapshot for the stopped turn does not bring the status back.
  env.bridgeEvent({ t: "snapshot", snapshot: { nodes: [{ sid: "s", state: "working", turnId: "t1", controlAvailable: true, ownerPid: 7 }] } });
  env.flush();
  assert.equal(status.hidden, true);
  env.key(env.input, "Escape");
  await env.settle();
  assert.equal(env.mutations.length, 1, "no replay of the interrupt");
});

test("receipt selection opens Run on Inspect and follows Run selections without echo", () => {
  const env = boot();
  const emitted = [];
  env.doc.addEventListener("deck-tool-select", e => emitted.push(e.detail));
  env.fire("deck-conversation-turn", { sid: "s", type: "message.start", payload: {}, at: env.clock });
  env.fire("deck-conversation-turn", { sid: "s", type: "tool.start", payload: { tool_id: "c1", name: "terminal" }, at: env.clock });
  env.fire("deck-conversation-turn", { sid: "s", type: "tool.start", payload: { tool_id: "c2", name: "read_file" }, at: env.clock });
  env.fire("deck-conversation-turn", { sid: "s", type: "message.complete", payload: {}, at: env.clock + 5000 });
  env.flush();
  emitted.length = 0;
  env.inner.querySelector(".receipt-call[data-call=\"c1\"] summary").click();
  env.flush();
  assert.deepEqual(emitted.map(d => [d.call, d.source]), [["c1", "receipt"]]);
  assert.equal(env.opens.length, 0);
  env.inner.querySelector(".receipt-inspect").click();
  assert.deepEqual(env.opens, [["work", "run"]]);
  assert.equal(emitted.at(-1).call, "c1", "Inspect keeps the selected call");
  env.flush();
  const before = emitted.length;
  env.fire("deck-tool-select", { sid: "s", call: "c2", source: "run" });
  env.flush();
  assert.equal(emitted.length, before + 1, "only the Run event itself; receipts do not re-emit");
  assert.ok(env.inner.querySelector(".receipt-call[data-call=\"c2\"]").classList.contains("selected"));
  assert.equal(env.inner.querySelector(".receipt-fold").open, true, "a Run selection opens the folded receipt");
});

test("queued messages move into the composer with visible Send now and Cancel and working handlers", () => {
  const env = boot();
  const OB = require("../renderer/outbox");
  const store = new Map();
  const I18N = env.win.DeckI18n;
  const ob = OB.create({ store: { get: k => store.get(k), set: (k, v) => store.set(k, v) }, h: env.h, i18nText: I18N.t, i18nNode: (k, v) => I18N.t(k, v) });
  ob.add("s", "first", [{ token: "tok-1", name: "a.png", size: 3, kind: "image", image: true }]);
  ob.add("s", "second");
  const calls = [];
  const on = { sendNow: id => calls.push(["now", id]), cancel: id => { calls.push(["cancel", id]); ob.remove("s", id); render(); }, edit: id => calls.push(["edit", id]), redirect: id => calls.push(["redirect", id]), redraw: () => render() };
  const btn = (el, prefix) => el.querySelectorAll("button").find(b => (b.dataset.fk || "").startsWith(prefix));
  function render() { env.inner.replaceChildren(env.user("hello"), env.agent("reply"), ...ob.bubbles("s", on)); env.flush(); }
  render();
  const queue = env.doc.querySelector(".conv-queue");
  assert.equal(queue.hidden, false);
  assert.equal(queue.querySelectorAll(".msg.outbox").length, 2);
  assert.equal(env.inner.querySelectorAll(".outbox").length, 0, "the transcript keeps no queued copy");
  const first = queue.querySelectorAll(".msg.outbox")[0];
  const visible = first.querySelectorAll(".outbox-meta .linkbtn").map(b => b.textContent);
  assert.deepEqual(visible, ["Send now", "Cancel"]);
  assert.ok(first.querySelector(".outbox-file"), "attachment token chip kept");
  btn(first, "outbox-sendnow:").click();
  btn(first, "outbox-more:").click();
  const menu = queue.querySelectorAll(".msg.outbox")[0].querySelectorAll(".amenu-item").map(b => b.textContent);
  assert.deepEqual(menu, ["Edit"], "files: no Interrupt and send; Cancel is not duplicated in the menu");
  btn(queue.querySelectorAll(".msg.outbox")[0], "outbox-cancel:").click();
  assert.deepEqual(calls.map(c => c[0]), ["now", "cancel"]);
  assert.equal(queue.querySelectorAll(".msg.outbox").length, 1, "FIFO: the second message remains");
  assert.equal(queue.querySelector(".text").textContent, "second");
  assert.equal(JSON.parse(store.get("deck.outbox.s")).length, 1, "persisted");
  assert.equal(env.input.value, "Retained draft", "the draft is untouched");
});
