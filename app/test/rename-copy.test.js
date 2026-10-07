"use strict";
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const i18n = require("../renderer/i18n");
afterEach(() => i18n.setLanguage("en"));
const source = fs.readFileSync(path.join(__dirname, "../renderer/botscreen.js"), "utf8");
const h = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter(v => v != null) });
const nodes = el => [el, ...el.kids.filter(v => v && typeof v === "object").flatMap(nodes)];

function explain(state) {
  let result;
  let opened = false;
  const context = { B: { st: state }, h, i18nText: i18n.t, i18nNode: i18n.t, hm: () => "12:00",
    ctx: { openSettings: () => { opened = true; } }, explainEl: { replaceChildren: (...kids) => { result = kids; } } };
  const fn = source.slice(source.indexOf("  function renderExplain()"), source.indexOf("  function renderGrant()"));
  vm.runInNewContext(`${fn}\nrenderExplain()`, context);
  return { result, opened: () => opened };
}

test("bot screen keeps setup steps behind native disclosure and one primary action", () => {
  for (const language of ["en", "tr"]) {
    i18n.setLanguage(language);
    const view = explain({ supported: true, on: false });
    const all = nodes(view.result[0]);
    const details = all.find(n => n.tag === "details");
    assert.ok(details);
    assert.notEqual(details.attrs.open, true);
    assert.equal(details.kids[0].tag, "summary");
    assert.equal(details.kids[0].kids[0], i18n.t("copy.setupSteps"));
    assert.equal(nodes(details).filter(n => n.tag === "li").length, 4);
    assert.equal(all.filter(n => n.tag === "p").length, 0);
    const buttons = all.filter(n => n.tag === "button");
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].attrs.class, "btn primary");
    buttons[0].attrs.onclick();
    assert.equal(view.opened(), true);
  }
});

test("bot screen hides setup once enabled and preserves paused/unsupported messages", () => {
  assert.equal(explain({ supported: true, on: true }).result.length, 0);
  const paused = explain({ supported: true, on: false, paused: { at: 1 } }).result[0];
  assert.equal(paused.tag, "p");
  assert.ok(paused.kids[0].includes("12:00"));
  const unsupported = nodes(explain({ supported: false, on: false }).result[0]);
  assert.ok(unsupported.find(n => n.attrs.class === "form-error"));
  assert.equal(unsupported.filter(n => n.tag === "button").length, 0);
});

test("copy diet preserves foreground consent and window visibility disclosures", () => {
  for (const key of ["botscreen.foregroundHelp", "U0778", "U0780", "U0781"]) {
    assert.ok(source.includes(`i18nNode("${key}"`), key);
    for (const language of ["en", "tr"]) assert.ok(i18n.tables[language][key]);
  }
  assert.ok(source.includes('"aria-describedby": "bs-foreground-help"'));
});
