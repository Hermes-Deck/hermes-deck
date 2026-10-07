"use strict";
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const i18n = require("../renderer/i18n");
afterEach(() => i18n.setLanguage("en"));

function fakeDocument() {
  const texts = [], elements = [];
  const doc = {
    documentElement: {}, readyState: "complete",
    createTextNode(value) { const node = { textContent: value }; texts.push(node); return node; },
    querySelectorAll(selector) { return elements.filter(el => el.getAttribute(selector.slice(1, -1)) !== null); },
    createTreeWalker() { let at = 0; return { nextNode: () => texts[at++] || null }; },
    dispatchEvent(event) { this.lastEvent = event.type; },
  };
  const element = () => {
    const el = { values: {}, textContent: "",
      setAttribute(key, value) { this.values[key] = value; },
      getAttribute(key) { return this.values[key] ?? null; },
      removeAttribute(key) { delete this.values[key]; },
    };
    elements.push(el);
    return el;
  };
  return { doc, element };
}

test("translations have identical keys and interpolation names", () => {
  const slots = value => [...new Set(value.match(/\{[A-Za-z_]\w*\}/g) || [])].sort();
  assert.deepEqual(Object.keys(i18n.tables.en).sort(), Object.keys(i18n.tables.tr).sort());
  for (const key of Object.keys(i18n.tables.en)) {
    assert.equal(typeof i18n.tables.en[key], "string", key);
    assert.equal(typeof i18n.tables.tr[key], "string", key);
    assert.deepEqual(slots(i18n.tables.en[key]), slots(i18n.tables.tr[key]), key);
  }
});

test("English default, Turkish selection and safe interpolation", () => {
  assert.equal(i18n.getLanguage(), "en");
  assert.equal(i18n.getLocale(), "en-US");
  assert.equal(i18n.t("setup.connect"), "Connect to Hermes");
  assert.equal(i18n.t("common.fileNamed", { name: "<img onerror=alert(1)>" }), "file: <img onerror=alert(1)>");
  assert.equal(i18n.t("common.fileNamed", Object.create({ name: "inherited" })), "file: {name}");
  assert.equal(i18n.t("common.fileNamed", null), "file: {name}");
  assert.equal(i18n.t("missing.key"), "missing.key");
  assert.equal(i18n.t("toString"), "toString");
  i18n.setLanguage("tr");
  assert.equal(i18n.getLocale(), "tr-TR");
  assert.equal(i18n.t("setup.connect"), "Hermes'e bağlan");
  assert.equal(i18n.setLanguage("invalid"), "en");
});

test("live bindings update only explicit UI text, preserving user/fixture text and draft values", () => {
  const { doc, element } = fakeDocument();
  const label = i18n.node("setup.connect", {}, doc);
  const userText = doc.createTextNode("Gönder");
  const input = element();
  input.value = "unsent draft";
  i18n.bind(input, "placeholder", "common.fileNamed", { name: "<script>unsafe</script>" });
  i18n.apply(doc);
  i18n.setLanguage("tr");
  i18n.apply(doc);
  assert.equal(label.textContent, "Hermes'e bağlan");
  assert.equal(userText.textContent, "Gönder");
  assert.equal(input.values.placeholder, "dosya: <script>unsafe</script>");
  assert.equal(input.value, "unsent draft");
  assert.equal(doc.documentElement.lang, "tr");
});

test("overwritten validation, download and view messages do not return after a language change", () => {
  const { doc, element } = fakeDocument();
  const notice = element(), title = element();
  i18n.bind(notice, "textContent", "setup.loadingPermissions");
  i18n.bind(title, "title", "common.fileNamed", { name: "report" });
  const text = i18n.node("setup.connect", {}, doc);
  notice.textContent = "RPC failure";
  title.values.title = "Downloaded successfully";
  text.textContent = "Finished";
  i18n.setLanguage("tr");
  i18n.apply(doc);
  assert.equal(notice.textContent, "RPC failure");
  assert.equal(notice.getAttribute("data-i18n"), null);
  assert.equal(title.values.title, "Downloaded successfully");
  assert.equal(title.getAttribute("data-i18n-title"), null);
  assert.equal(text.textContent, "Finished");
});

test("classic script ignores system language and listens for changes from each native surface", () => {
  const source = fs.readFileSync(path.join(__dirname, "../renderer/i18n.js"), "utf8");
  for (const surface of ["deck", "pet", "botbar"]) {
    const { doc } = fakeDocument();
    let change;
    const browser = { document: doc, navigator: { language: "tr-TR" },
      [surface]: { onLanguage(fn) { change = fn; } },
      Event: class { constructor(type) { this.type = type; } },
    };
    browser.window = browser;
    vm.runInNewContext(source, browser);
    assert.equal(browser.DeckI18n.getLanguage(), "en");
    change("tr");
    assert.equal(browser.DeckI18n.getLanguage(), "tr");
    assert.equal(doc.documentElement.lang, "tr");
    assert.equal(doc.lastEvent, "deck-language");
  }
});

test("real index, pet and bar HTML starts in English and bootstraps Turkish without losing bindings", () => {
  const source = fs.readFileSync(path.join(__dirname, "../renderer/i18n.js"), "utf8");
  const decode = value => value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  for (const page of ["index.html", "pet.html", "botbar.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "../renderer", page), "utf8");
    assert.match(html, /<html lang="en">/);
    assert.equal(html.indexOf('src="i18n.js"') < html.indexOf('<script'), false, "i18n is a script element");
    // theme.js (data-theme before the first paint) may come first; i18n.js is the first script after it
    const rest = html.replace('<script src="theme.js"></script>', "");
    assert.match(rest.slice(rest.indexOf("<script")), /^<script src="i18n\.js">/);
    for (const language of ["en", "tr"]) {
      const { doc, element } = fakeDocument();
      const bindings = [];
      for (const match of html.matchAll(/<([a-z][a-z0-9-]*)([^>]*)>/gi)) {
        if (!/data-i18n/.test(match[2])) continue;
        const el = element();
        for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) el.values[attr[1]] = decode(attr[2]);
        if (el.values["data-i18n"]) {
          const rest = html.slice(match.index + match[0].length);
          el.textContent = decode(rest.slice(0, rest.indexOf(`</${match[1]}>`)));
          bindings.push([el, "textContent", el.values["data-i18n"]]);
        }
        for (const name of ["title", "placeholder", "aria-label"]) if (el.values[`data-i18n-${name}`]) bindings.push([el, name, el.values[`data-i18n-${name}`]]);
      }
      assert.ok(bindings.length > 0, `${page}: actual bindings`);
      for (const [el, attr, key] of bindings) assert.equal(attr === "textContent" ? el.textContent : el.values[attr], i18n.tables.en[key], `${page}: English fallback ${key}`);
      const browser = { document: doc, deckLanguage: language, navigator: { language: "tr-TR" } };
      browser.window = browser;
      vm.runInNewContext(source, browser);
      for (const [el, attr, key] of bindings) assert.equal(attr === "textContent" ? el.textContent : el.values[attr], i18n.tables[language][key], `${page}: ${language} bootstrap ${key}`);
      assert.equal(doc.documentElement.lang, language);
    }
  }
});

test("shared transport errors are localized at the display boundary; native diagnostics remain data", () => {
  const method = "Page.navigate";
  assert.equal(i18n.errorText(i18n.tables.tr.U0104), i18n.tables.en.U0104);
  assert.equal(i18n.errorText(`${method} zaman aşımı`), i18n.t("U0106", { method }));
  assert.equal(i18n.errorText("Invalid browser state URL"), i18n.t("browserBundle.invalidUrl"));
  assert.equal(i18n.errorText("native diagnostic: socket EOF"), "native diagnostic: socket EOF");
  i18n.setLanguage("tr");
  assert.equal(i18n.errorText(i18n.tables.en.U0104), i18n.tables.tr.U0104);
  assert.equal(i18n.errorText("Invalid browser state URL"), i18n.t("browserBundle.invalidUrl"));
});
