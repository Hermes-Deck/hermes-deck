"use strict";
// The taskbar badge: how many chats wait for the user (new replies + questions), drawn as a small amphora disc
// with the number in it. Windows shows it as the taskbar button's overlay icon; macOS and Linux get the count
// through app.setBadgeCount instead. Pure Node (no canvas), so it is unit-tested in app/test/taskbar-badge.test.js.
const { png } = require("./badge");

const AMPHORA = [0xc9, 0x6a, 0x4e];
const RING = [0x0d, 0x0e, 0x10]; // a thin dark ring keeps the disc readable on a light taskbar
const INK = [0xff, 0xff, 0xff];

// 5x7 glyphs, one string per row, "#" = ink
const FONT = {
  0: [" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "],
  1: ["  #  ", " ##  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
  2: [" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"],
  3: ["#####", "   # ", "  #  ", "   # ", "    #", "#   #", " ### "],
  4: ["   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "],
  5: ["#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "],
  6: ["  ## ", " #   ", "#    ", "#### ", "#   #", "#   #", " ### "],
  7: ["#####", "    #", "   # ", "  #  ", " #   ", " #   ", " #   "],
  8: [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
  9: [" ### ", "#   #", "#   #", " ####", "    #", "   # ", " ##  "],
  "+": ["     ", "  #  ", "  #  ", "#####", "  #  ", "  #  ", "     "],
};

/** The badge's text for a fleet summary: "" when nothing waits, "1".."9", then "9+" (the overlay is 16 px). */
function badgeText(summary) {
  const n = badgeCount(summary);
  if (!n) return "";
  return n > 9 ? "9+" : String(n);
}

/** Chats that wait for the user: new replies plus open questions/approvals. */
function badgeCount(summary) {
  const s = summary && typeof summary === "object" ? summary : {};
  const n = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return n(s.unread) + n(s.pending);
}

/** Colour at a point of the unit square (-1..1) for `text`, or null outside the disc. */
function sampler(text) {
  const glyphs = [...text].map((c) => FONT[c]).filter(Boolean);
  const cols = glyphs.length * 6 - 1; // 5 px glyphs, 1 px gaps
  const unit = Math.min(1.12 / cols, 1.04 / 7); // glyph px in unit-square coordinates
  const x0 = -(cols * unit) / 2;
  const y0 = -(7 * unit) / 2;
  const ink = (x, y) => {
    const gx = Math.floor((x - x0) / unit);
    const gy = Math.floor((y - y0) / unit);
    if (gy < 0 || gy >= 7 || gx < 0 || gx >= cols || gx % 6 === 5) return false;
    return glyphs[Math.floor(gx / 6)][gy][gx % 6] === "#";
  };
  const bold = unit * 0.28; // strokes a little wider than one glyph pixel, so the digit survives a 16 px slot
  return (x, y) => {
    const r = Math.hypot(x, y);
    if (r > 0.99) return null;
    if (r > 0.9) return RING;
    return ink(x, y) || ink(x - bold, y) || ink(x + bold, y) || ink(x, y - bold * 0.6) ? INK : AMPHORA;
  };
}

/** RGBA pixels of the badge for `text`, `size` px square, supersampled. */
function badgePixels(text, size, ss = 4) {
  const sample = sampler(text);
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sj = 0; sj < ss; sj++) {
        for (let si = 0; si < ss; si++) {
          const c = sample(((i + (si + 0.5) / ss) / size) * 2 - 1, ((j + (sj + 0.5) / ss) / size) * 2 - 1);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      if (!a) continue;
      const o = (j * size + i) * 4;
      px[o] = Math.round(r / a);
      px[o + 1] = Math.round(g / a);
      px[o + 2] = Math.round(b / a);
      px[o + 3] = Math.round((255 * a) / (ss * ss));
    }
  }
  return px;
}

/** The badge as a PNG buffer (32 px: Windows scales the overlay down to its 16 px slot). */
function badgePng(text, size = 32) {
  return png(size, badgePixels(text, size));
}

module.exports = { badgeText, badgeCount, badgePixels, badgePng, FONT };
