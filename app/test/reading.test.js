"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const file = path.join(__dirname, "../renderer/reading.js");

function browser(settingsGet) {
  assert.ok(fs.existsSync(file), "reading module exists");
  const element = { dataset: {}, style: { values: {}, setProperty(key, value) { this.values[key] = value; } } };
  const events = {};
  const window = { deck: { settingsGet }, document: { documentElement: element } };
  window.deck.desktop = { onEvent(fn) { events.desktop = fn; } };
  const context = { window, console };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context);
  return { api: window.DeckReading, element, events };
}
test("reading stylesheet is opt-in, theme-based and excludes your bubbles and notices", () => {
  const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
  assert.match(html, /href="shell.css">\s*<link rel="stylesheet" href="reading.css">/);
  assert.match(html, /src="app.js"><\/script>\s*<script src="reading.js">/);
  const css = fs.readFileSync(path.join(__dirname, "../renderer/reading.css"), "utf8");
  assert.match(css, /:root\[data-agent-messages="bubble"\].*\.msg:not\(\.out\):not\(\.sysmsg\)/);
  assert.match(css, /background: var\(--l1\)/);
  assert.match(css, /border: 1px solid var\(--line\)/);
  assert.match(css, /border-radius: 14px/);
  assert.match(css, /padding: 16px 18px/);
  assert.doesNotMatch(css, /\.receipt\s*\{|\.think-block\s*\{|overflow:\s*hidden/);
});

test("message reading defaults to Newsreader 17px and validates all font and size choices", () => {
  const { api, element } = browser();
  assert.equal(api.normalize().font, "newsreader");
  assert.equal(api.normalize().size, 17);
  for (const font of ["newsreader", "geist", "atkinson"]) for (let size = 14; size <= 20; size++) {
    api.apply({ font, size, agentMessages: "bubble" });
    assert.equal(element.dataset.messageFont, font);
    assert.equal(element.style.values["--message-size"], `${size}px`);
    assert.equal(element.style.values["--message-leading"], "1.7");
  }
  for (const size of [null, "20", NaN, 13, 21, 15.5, Infinity]) assert.equal(api.normalize({ size }).size, 17);
  assert.equal(api.normalize({ font: 'url("remote")' }).font, "newsreader");
  for (const value of [null, [], "geist", 14]) assert.equal(api.normalize(value).size, 17);
});

const tick = () => new Promise(resolve => setImmediate(resolve));

test("reading boot defaults to plain, reads stored settings and follows desktop settings", async () => {
  const { element, events } = browser(async () => ({ reading: { agentMessages: "bubble" } }));
  assert.equal(element.dataset.agentMessages, "plain");
  await tick();
  assert.equal(element.dataset.agentMessages, "bubble");
  events.desktop({ t: "settings", settings: { reading: { agentMessages: "plain" } } });
  assert.equal(element.dataset.agentMessages, "plain");
});

test("a late boot read never overwrites a live preference", async () => {
  let resolve;
  const { api, element } = browser(() => new Promise(done => { resolve = done; }));
  await tick();
  api.apply({ agentMessages: "bubble" });
  resolve({ reading: { agentMessages: "plain" } });
  await tick();
  assert.equal(element.dataset.agentMessages, "bubble");
  api.apply({ agentMessages: "invalid" });
  assert.equal(element.dataset.agentMessages, "plain");
});
