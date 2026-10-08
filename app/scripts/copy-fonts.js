"use strict";
// Copies the woff2 files the deck uses out of @fontsource into renderer/fonts and writes fonts.css,
// so the renderer can load them from its own origin under a strict CSP (no CDN, works offline).
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const out = path.join(root, "renderer", "fonts");
const SUBSETS = {
  latin:
    "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  "latin-ext":
    "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
};
// Static families: one file per weight. Geist and Geist Mono carry the Blend UI; the older three stay for the
// classic themes, the status pet and the bot screen bar.
const FAMILIES = [
  { pkg: "@fontsource/geist", slug: "geist", family: "Geist", weights: [400, 500, 600, 700] },
  { pkg: "@fontsource/geist-mono", slug: "geist-mono", family: "Geist Mono", weights: [400, 500] },
  { pkg: "@fontsource/marcellus", slug: "marcellus", family: "Marcellus", weights: [400] },
  { pkg: "@fontsource/atkinson-hyperlegible-next", slug: "atkinson-hyperlegible-next", family: "Atkinson Hyperlegible Next", weights: [400, 500, 700] },
  { pkg: "@fontsource/atkinson-hyperlegible-mono", slug: "atkinson-hyperlegible-mono", family: "Atkinson Hyperlegible Mono", weights: [400, 500] },
];
// Variable families: one file per style covers a weight range (Newsreader's opsz file carries wght too).
const VARIABLE = [
  { pkg: "@fontsource-variable/newsreader", slug: "newsreader", axis: "opsz", family: "Newsreader", weight: "200 800", styles: ["normal", "italic"] },
];

fs.mkdirSync(out, { recursive: true });
const css = [];
let copied = 0;
let missing = 0;
function copy(dir, file) {
  const src = path.join(dir, file);
  if (!fs.existsSync(src)) {
    missing++;
    return false;
  }
  fs.copyFileSync(src, path.join(out, file));
  copied++;
  return true;
}
for (const f of FAMILIES) {
  const dir = path.join(root, "node_modules", f.pkg, "files");
  for (const w of f.weights) {
    for (const [subset, range] of Object.entries(SUBSETS)) {
      const file = `${f.slug}-${subset}-${w}-normal.woff2`;
      if (!copy(dir, file)) continue;
      css.push(
        `@font-face { font-family: "${f.family}"; font-style: normal; font-weight: ${w}; font-display: swap; src: url("fonts/${file}") format("woff2"); unicode-range: ${range}; }`
      );
    }
  }
}
for (const f of VARIABLE) {
  const dir = path.join(root, "node_modules", f.pkg, "files");
  for (const style of f.styles) {
    for (const [subset, range] of Object.entries(SUBSETS)) {
      const file = `${f.slug}-${subset}-${f.axis}-${style}.woff2`;
      if (!copy(dir, file)) continue;
      css.push(
        `@font-face { font-family: "${f.family}"; font-style: ${style}; font-weight: ${f.weight}; font-display: swap; src: url("fonts/${file}") format("woff2-variations"), url("fonts/${file}") format("woff2"); unicode-range: ${range}; }`
      );
    }
  }
}
fs.writeFileSync(path.join(root, "renderer", "fonts.css"), css.join("\n") + "\n");
console.log(`copy-fonts: ${copied} files -> renderer/fonts, fonts.css written${missing ? ` (${missing} missing: run npm ci)` : ""}`);
