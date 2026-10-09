"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
test("entrance tracking skips history and never replays a block on rebuild or pagination", () => {
  const tracker = C.createEntranceTracker();
  const first = tracker.assign("s", ["u1", "a1"]);
  assert.deepEqual(first.fresh, []);
  const appended = tracker.assign("s", ["u1", "a1", "a2"]);
  assert.deepEqual(appended.ids.slice(0, 2), first.ids, "aligned blocks keep their identity");
  assert.equal(appended.fresh.length, 1);
  assert.equal(appended.fresh[0], appended.ids[2]);
  assert.deepEqual(tracker.scan("s", ["u1", "a1", "a2"]), []);
  const paged = tracker.assign("s", ["old", "u1", "a1", "a2"], false);
  assert.deepEqual(paged.fresh, []);
  assert.deepEqual(paged.ids.slice(1), appended.ids, "a prepended page keeps the later ids");
  assert.deepEqual(tracker.scan("other", ["new"]), []);
  assert.deepEqual(tracker.scan("s", ["old", "u1", "a1", "a2"]), []);
});
test("relocation moves approval and queue nodes without replacing their action handlers", () => {
  let called = 0;
  const approval = { onclick() { called++; } }, queued = { onclick() { called++; } };
  const inner = { querySelectorAll(s) { return s === ".hreq" ? [approval] : [queued]; } };
  const tray = { replaceChildren(...kids) { this.kids = kids; } }, queue = { replaceChildren(...kids) { this.kids = kids; } };
  C.relocate(inner, tray, queue);
  assert.equal(tray.kids[0], approval); assert.equal(queue.kids[0], queued);
  tray.kids[0].onclick(); queue.kids[0].onclick(); assert.equal(called, 2);
});
const C = require("../renderer/composer");
test("via line is kept only for read-only and sub-agent routes", () => {
  assert.equal(C.via({ channel: "hermes", profile: "lab" }), null);
  assert.equal(C.via({ channel: "telegram" }, { bot: "ExampleBot" }), null);
  assert.equal(C.via({ channel: "readonly" }).key, "conv.readonly");
  assert.deepEqual(C.via({ channel: "sub", id: "s" }, { title: "Review" }), { key: "conv.subagent", vars: { agent: "Review" } });
});

test("compact composer: card owns focus, one-row layout starts on and keeps status rows full width", () => {
  const fs = require("node:fs"), path = require("node:path");
  const css = fs.readFileSync(path.join(__dirname, "../renderer/composer.css"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
  assert.match(css, /\.app \.composer textarea:focus-visible \{ outline: none; \}/);
  assert.match(css, /\.app \.composer\.compact > :not\(textarea, \.composer-bar, \.conv-filament\) \{ flex: 0 0 100%; \}/);
  assert.match(html, /<div class="composer compact">/);
});

test("compact composer: an empty box fits one row even when the placeholder overflows", () => {
  const fs = require("node:fs"), path = require("node:path");
  const app = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
  assert.match(app, /box\.clientWidth >= 120 && \(!box\.value \|\| box\.scrollWidth <= box\.clientWidth\)/);
});
