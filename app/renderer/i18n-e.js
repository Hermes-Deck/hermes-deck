"use strict";
// Lane E (inbox / fleet) UI strings. Loaded right after i18n.js; DeckI18n.extend adds them to both tables. Every key goes in
// en and tr with the same placeholders, and must not exist in i18n.js already (test/i18n.test.js checks this file).
(function (root) {
  const strings = {
    en: {},
    tr: {},
  };
  if (typeof module === "object" && module.exports) module.exports = strings;
  else root.DeckI18n.extend(strings);
})(typeof window === "object" ? window : globalThis);
