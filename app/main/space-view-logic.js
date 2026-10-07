"use strict";
// Pure helpers for the agent space viewer (space-view.js), unit-tested in app/test/spaces.test.js.
// The viewer is cua-spacesd's own page; its options travel in the URL hash (docs/agent-spaces.md):
// view_only=1 is the Watch level, and the Deck never asks for audio or clipboard sync.
const LEVELS = ["watch", "together", "full"];
const levelOk = (l) => LEVELS.includes(l);
const inputBlocked = (l) => !levelOk(l) || l === "watch";
/** base: the local space proxy's base ("http://127.0.0.1:<port>/<secret>/"). */
const viewUrl = (base, level) => `${base}viewer/#${inputBlocked(level) ? "view_only=1&" : ""}audio=none&clipboard=0`;
/** The agent that just took the shared desktop (display name), given the previous holder and a /spaces answer. */
const takenBy = (prev, list) => {
  const st = list && Array.isArray(list.spaces) ? list.spaces[0] : null;
  const h = st && st.holder && st.holder !== "user" ? st.holder : null;
  return h && h !== prev ? st.holderName || h : null;
};
module.exports = { LEVELS, levelOk, inputBlocked, viewUrl, takenBy };
