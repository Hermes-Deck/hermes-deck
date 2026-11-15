"use strict";
// The pairing page's words and look (src/pair-page-view.js): English and Turkish from Accept-Language, light and dark
// by prefers-color-scheme, phone and desktop layouts, system fonts only.
const test = require("node:test");
const assert = require("node:assert/strict");
const view = require("../src/pair-page-view");

const CODE = "0123456789abcdef0123456789abcdef";
const page = (lang) => view.waitingPage({ lang, nonce: "n0nce", address: "https://relay.example", code: CODE, remainingS: 299 });

test("language: Turkish only when it ranks above English; English otherwise and by default", () => {
  const cases = {
    "": "en", "tr": "tr", "tr-TR": "tr", "TR-tr,tr;q=0.9": "tr", "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7": "tr",
    "en-US,en;q=0.9,tr;q=0.8": "en", "de-DE,de;q=0.9,tr;q=0.5": "tr", "de-DE,fr": "en", "en;q=0.5, tr;q=0.6": "tr",
    "tr;q=0, en;q=0.1": "en", "tr;q=0": "en", "*": "en", "tr;q=abc": "tr", "en, tr": "en", "tr, en": "tr",
  };
  for (const [header, want] of Object.entries(cases)) assert.equal(view.language(header), want, JSON.stringify(header));
  assert.equal(view.language(undefined), "en");
  assert.equal(view.language(`${"x,".repeat(5000)}tr`), "en", "an absurd header is cut, not parsed forever");
});

test("strings: both languages carry the same keys and shapes; no jargon words on the page", () => {
  const { en, tr } = view.STRINGS;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(tr).sort());
  for (const k of Object.keys(en)) assert.equal(Array.isArray(en[k]), Array.isArray(tr[k]), k);
  const text = (lang) => Object.values(view.STRINGS[lang]).flat().join(" ").toLowerCase();
  for (const word of ["relay", "token", "ticket", "base64", "bearer", "api", "endpoint", "röle"]) {
    assert.ok(!new RegExp(`\\b${word}\\b`).test(text("en")) && !text("tr").includes(word), word);
  }
});

test("page: Turkish page in Turkish, English page in English, two short instruction lines each", () => {
  const tr = page("tr"), en = page("en");
  assert.match(tr, /<html lang="tr"/);
  assert.ok(tr.includes("Telefonunu Hermes Deck’e bağla") && tr.includes("Hermes Deck’te aç") && tr.includes("içinde kapanır"));
  assert.match(en, /<html lang="en"/);
  assert.ok(en.includes("Connect your phone to Hermes Deck") && en.includes("Open in Hermes Deck") && en.includes("This page closes in "));
  for (const html of [tr, en]) assert.equal((/<div class="steps">([\s\S]*?)<\/div>/.exec(html)[1].match(/<p>/g) || []).length, 2);
  assert.ok(view.pairedPage({ lang: "tr", nonce: "n", name: "Ada" }).includes("<strong id=\"device\">Ada</strong> bağlandı."));
  assert.ok(view.gonePage({ lang: "tr", nonce: "n" }).includes("Hermes’ten yeni bir bağlantı iste."));
  assert.ok(view.pairedPage({ lang: "en", nonce: "n", name: "" }).includes("Your phone is connected."));
});

test("look: light and dark by prefers-color-scheme, phone viewport, desktop layout, system fonts, no web fonts", () => {
  const html = page("en");
  assert.ok(html.includes('<meta name="viewport" content="width=device-width,initial-scale=1">'));
  assert.ok(html.includes("color-scheme:light dark"));
  assert.match(html, /@media \(prefers-color-scheme:dark\)\{:root\{--bg:/);
  assert.match(html, /@media \(min-width:720px\)\{main\{max-width:820px/);
  assert.match(html, /font:17px\/1\.45 system-ui,-apple-system,"Segoe UI",Roboto/);
  assert.ok(!/@font-face|fonts\.googleapis|woff/.test(html));
  assert.match(html, /\.qr\{background:#fff/, "the QR code keeps a light background in dark mode");
  assert.match(html, /\.open\{[^}]*min-height:48px/, "a large tap target");
});

test("page without an address: no QR code and no deep link, the code and a plain instruction instead", () => {
  const html = view.waitingPage({ lang: "en", nonce: "n", address: null, code: CODE, remainingS: 10 });
  assert.ok(!html.includes("<svg") && !html.includes("hermesdeck://"));
  assert.ok(html.includes(`<span class="half"><span>0123</span><span>4567</span><span>89ab</span><span>cdef</span></span>`) && html.includes("Enter your Deck’s web address and this code in the app."));
});
