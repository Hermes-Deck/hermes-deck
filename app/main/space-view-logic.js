"use strict";
// Pure helpers for the agent space viewer (space-view.js, space-proxy.js, spaces.js), unit-tested in app/test/spaces.test.js.
// The viewer is cua-spacesd's own page; its options travel in the URL hash (docs/agent-spaces.md):
// view_only=1 is the Watch level, and the Deck never asks for audio or clipboard sync. The viewer's clipboard sync is
// off only with clipboard=off: clipboard=0 just hides its toolbar button and the sync still polls GetClipboard.
const LEVELS = ["watch", "together", "full"];
const levelOk = (l) => LEVELS.includes(l);
const inputBlocked = (l) => !levelOk(l) || l === "watch";
/** base: the local space proxy's base for one space ("http://127.0.0.1:<port>/<secret>/<spaceId>/"). */
const viewUrl = (base, level) => `${base}viewer/#${inputBlocked(level) ? "view_only=1&" : ""}audio=none&clipboard=off`;
/** The agent that just took the shared desktop (display name), given the previous holder and a /spaces answer. */
const takenBy = (prev, list) => {
  const st = list && Array.isArray(list.spaces) ? list.spaces.find((s) => s && s.id === "host") || list.spaces[0] : null;
  const h = st && st.holder && st.holder !== "user" ? st.holder : null;
  return h && h !== prev ? st.holderName || h : null;
};

// ---- the viewer's paths: the relay's rule (relay/src/spaces.js viewPath), mirrored for a desktop on this computer,
// which the Deck reaches on loopback without the relay. A parity test runs both on the same paths.
const ALLOW = [/^viewer(\/|$)/, /^media(\/|$)/, /^cua\.env\.v1\.(Stream|Presence)Service\/[A-Za-z]+$/, /^cua\.env\.v1\.SystemService\/GetCapabilities$/];
// clipboard paths are never input: the viewer opens with clipboard=off, so nothing legitimate calls them (final review T5)
const INPUT = /^cua\.env\.v1\.ComputerService\/(?!(?:Get|Set)Clipboard$)[A-Za-z]+$/;
const PRINTABLE = /^[\x21-\x7e]+$/;
/** A decoded path that may be forwarded at all: printable ASCII only (no space, CR, LF, tab), no way out. */
const safeRest = (rest) => typeof rest === "string" && !!rest && PRINTABLE.test(rest) && !rest.includes("..") && !rest.startsWith("/") && !rest.includes("//") && !rest.includes("\\");
/** The decoded cua-spacesd path when a viewer may reach it (input paths only when `input`, i.e. above Watch), else null. */
const viewRest = (rest, input) => (safeRest(rest) && (ALLOW.some((re) => re.test(rest)) || (!!input && INPUT.test(rest))) ? rest : null);
// a space id in a viewer URL: the shared desktop ("host") or an agent profile (never "host", which is reserved)
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isProfile = (p) => typeof p === "string" && PROFILE_RE.test(p) && !p.includes("..") && p !== "host";
const isSpace = (id) => id === "host" || isProfile(id);

// ---- agent pills (spec 2026-10-07 section 8)
const PILL = { ready: "ready", starting: "starting", pulling: "starting", off: "off", stopping: "off", failed: "failed" };
const REASONS = ["offline", "limit", "failed", "none"];
/**
 * One agent desktop's pill state: actual shared usage wins, then running or starting; after a fallback, "shared" when there is a shared
 * desktop to fall back to and "none" (no desktop at all; its actions get a tool error) when there is not; else its state.
 */
const pillState = (s, hasShared = true) => {
  if (s && s.usingShared === true) return "shared";
  const st = PILL[s && s.state] || "off";
  if (st === "ready" || st === "starting") return st;
  if (s && s.fallback) return hasShared ? "shared" : "none";
  return st;
};
/** A /spaces answer has a shared desktop: its "host" entry, with a viewer. */
const sharedOf = (spaces) => spaces.some((s) => s && s.id === "host" && s.kind === "shared" && s.viewer !== false);
/** The pills of a /spaces answer: one per agent desktop, then the shared desktop when there is one. */
function pills(list) {
  const spaces = list && Array.isArray(list.spaces) ? list.spaces : [];
  const hasShared = sharedOf(spaces);
  const out = spaces
    .filter((s) => s && s.kind === "agent" && isProfile(s.id))
    .map((s) => ({ id: s.id, label: s.holderName || s.id, state: pillState(s, hasShared), where: s.usingShared ? null : s.hostName || null }));
  if (hasShared) out.push({ id: "host", label: null, state: "shared", where: null });
  return out;
}
/**
 * Agents whose pill turned to "shared" (fell back to the shared desktop) or "none" (no desktop at all) between two
 * /spaces answers: [{who, reason, to}]. None for the first answer (prev null): a fallback older than this Deck's start
 * is not news.
 */
function fallbackFor(prev, list) {
  if (!prev) return [];
  const was = new Map(pills(prev).map((p) => [p.id, p.state]));
  const all = list && Array.isArray(list.spaces) ? list.spaces : [];
  const hasShared = sharedOf(all);
  return all
    .filter((s) => s && s.kind === "agent" && isProfile(s.id))
    .map((s) => [s, pillState(s, hasShared)])
    .filter(([s, st]) => s.fallback && (st === "shared" || st === "none") && was.get(s.id) !== st)
    .map(([s, st]) => ({ who: s.holderName || s.id, reason: REASONS.includes(s.fallback) ? s.fallback : "none", to: st }));
}

module.exports = { LEVELS, levelOk, inputBlocked, viewUrl, takenBy, viewRest, safeRest, isSpace, isProfile, pills, pillState, fallbackFor, REASONS };
