"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const MP = require("../renderer/model-picker");
const I = require("../renderer/i18n");
I.extend(require("../renderer/i18n-b"));
const walk = el => [el, ...(el.kids || []).filter(x => typeof x === "object").flatMap(walk)];
function world(t) {
  function h(tag, attrs = {}, ...kids) {
    return { tag, ...attrs, kids: kids.flat(Infinity).filter(Boolean), classList: { toggle() {} },
      setAttribute(k, v) { this[k] = v; }, appendChild(k) { this.kids.push(k); }, replaceChildren(...k) { this.kids = k.flat(Infinity).filter(Boolean); }, focus() {}, contains() { return false; },
      querySelector(s) { return walk(this).find(x => x.class?.split(" ").includes(s.slice(1))) || null; } };
  }
  const old = [global.document, global.requestAnimationFrame];
  const events = {};
  global.document = { createElementNS: (_ns, tag) => h(tag), addEventListener(name, fn) { events[name] = fn; } };
  global.requestAnimationFrame = () => {};
  t.after(() => { [global.document, global.requestAnimationFrame] = old; });
  const composer = h("div");
  let bar;
  const calls = [];
  const session = { sid: "s", key: "s", profile: "default", node: { model: "model-a", effort: "high" } };
  const picker = MP.create({ h, i18nText: I.t, composer, send: { parentNode: { insertBefore(b) { bar = b; } } }, session: () => session,
    bridge: { modelOptions: async () => ({ options: [{ id: "model-a", provider: "example", current: true }], current: { provider: "example" } }), setEffort: async (...a) => calls.push(a) },
    thinking: { isOpen: () => false, setOpen() {} }, cleanErr: String, note() {} });
  picker.sync();
  return { picker, bar, pop: composer.kids[0], calls, events };
}
test("one visible token opens search, custom id and four reasoning segments together", async t => {
  const w = world(t);
  assert.equal(w.bar.kids.filter(x => !x.hidden).length, 1);
  w.picker.openModel();
  await new Promise(r => setImmediate(r));
  const nodes = walk(w.pop);
  assert.ok(nodes.some(x => x.class?.includes("pick-search")));
  assert.ok(nodes.some(x => x.class?.includes("pick-custom-in")));
  assert.equal(nodes.filter(x => x.role === "radio" && ["Low", "Medium", "High", "Max"].includes(x.kids[0])).length, 4);
});
test("Ctrl E submits session-scoped effort once, including with the picker closed", async t => {
  const w = world(t);
  let prevented = 0;
  w.events.keydown({ ctrlKey: true, code: "KeyE", key: "e", preventDefault() { prevented++; } });
  w.events.keydown({ ctrlKey: true, code: "KeyE", key: "e", repeat: true, preventDefault() { prevented++; } });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(w.calls, [["s", { effort: "max", profile: "default" }]]);
  assert.equal(prevented, 1);
});
