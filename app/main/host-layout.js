"use strict";
// Split view (multi-host): the pure part of where each host's page sits. One or two panes inside the main window:
// `primary` is the left (or the only, "full") pane's host, which is also settings.data.activeHost; `right` is the
// other pane's host while `split` is on. Electron bounds and views are in host-views.js; this file is unit-tested.

const DIVIDER = 6; // px between the panes (the drag handle)
const MIN_PANE = 360; // px; a narrower window keeps the panes equal instead
const RATIO = { min: 0.15, max: 0.85 };
const SIDES = ["full", "left", "right"];

const ratioOk = (r) => typeof r === "number" && Number.isFinite(r) && r >= RATIO.min && r <= RATIO.max;

/** A complete, valid state from anything stored: {primary, split, right, ratio}. */
function normalize(s, hostIds) {
  const o = s && typeof s === "object" ? s : {};
  const ids = Array.isArray(hostIds) ? hostIds.map(String) : null;
  const primary = String(o.primary ?? "");
  let right = typeof o.right === "string" ? o.right : "";
  if (right && (right === primary || (ids && !ids.includes(right)))) right = "";
  return { primary, split: o.split === true && !!right, right: o.split === true && right ? right : "", ratio: ratioOk(o.ratio) ? o.ratio : 0.5 };
}

/** The hosts on screen, left to right. */
function shown(state) {
  return state.split && state.right ? [state.primary, state.right] : [state.primary];
}

/** Which pane a host's page is in: "full" | "left" | "right", or null when its page is hidden. */
function paneOf(state, hostId) {
  const id = String(hostId ?? "");
  if (!state.split) return id === state.primary ? "full" : null;
  return id === state.primary ? "left" : id === state.right ? "right" : null;
}

/** CONTRACT `deck.hosts.layout()` for one page: its own placement plus every pane. */
function placement(state, hostId) {
  const panes = state.split ? [{ side: "left", hostId: state.primary }, { side: "right", hostId: state.right }] : [{ side: "full", hostId: state.primary }];
  return { split: !!state.split, pane: paneOf(state, hostId), hostId: String(hostId ?? ""), panes };
}

/**
 * `deck.hosts.select(target)` from the page of `caller`: show the target in the caller's pane; when the other pane
 * already shows it, the two panes swap hosts. A page that is not on screen counts as the primary pane.
 */
function select(state, caller, target) {
  const t = String(target ?? ""), c = String(caller ?? "");
  const s = { ...state };
  if (!s.split) return { ...s, primary: t, right: "" };
  const callerRight = c === s.right;
  if (callerRight) {
    if (t === s.primary) return { ...s, primary: s.right, right: t }; // swap
    return { ...s, right: t };
  }
  if (t === s.right) return { ...s, primary: t, right: s.primary }; // swap
  return { ...s, primary: t };
}

/**
 * `deck.hosts.setSplit(on)` from the page of `caller`. On: the right pane opens the first saved host not on screen
 * (hostIds in saved order); fewer than two hosts is an error. Off: the caller's pane becomes the full one.
 */
function setSplit(state, on, caller, hostIds) {
  const ids = (Array.isArray(hostIds) ? hostIds : []).map(String);
  const c = String(caller ?? "");
  if (on) {
    if (state.split) return state;
    if (ids.length < 2) throw new Error("mview.needTwo");
    const next = ids.find((id) => id !== state.primary);
    if (next === undefined) throw new Error("mview.needTwo");
    return { ...state, split: true, right: next };
  }
  if (!state.split) return state;
  const keep = c === state.right ? state.right : state.primary;
  return { ...state, split: false, primary: keep, right: "" };
}

/** A removed host leaves its pane: the right pane closes, a removed primary makes way for the next host. */
function without(state, hostId, hostIds) {
  const id = String(hostId ?? "");
  const ids = (Array.isArray(hostIds) ? hostIds : []).map(String).filter((x) => x !== id);
  let s = state;
  if (s.right === id) s = { ...s, split: false, right: "" };
  if (s.primary === id) s = { ...s, primary: s.split && s.right ? s.right : ids[0] || "", split: false, right: "" };
  return s;
}

/** The ratio the divider may take at this width: both panes at least MIN_PANE when the window allows it. */
function clampRatio(ratio, width) {
  const r = ratioOk(ratio) ? ratio : 0.5;
  const usable = width - DIVIDER;
  if (!(usable >= 2 * MIN_PANE)) return 0.5;
  const lo = MIN_PANE / usable, hi = 1 - MIN_PANE / usable;
  return Math.min(hi, Math.max(lo, r));
}

/**
 * Pane rectangles (window content coordinates, integers) for the window content size.
 * Full: {full}. Split: {left, right, divider}.
 */
function paneBounds({ width, height }, state) {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
  if (!state.split) return { full: { x: 0, y: 0, width: w, height: h } };
  const ratio = clampRatio(state.ratio, w);
  const leftW = Math.round((w - DIVIDER) * ratio);
  return {
    left: { x: 0, y: 0, width: Math.max(1, leftW), height: h },
    divider: { x: leftW, y: 0, width: DIVIDER, height: h },
    right: { x: leftW + DIVIDER, y: 0, width: Math.max(1, w - leftW - DIVIDER), height: h },
  };
}

/** The ratio for a divider dragged to window x. */
function ratioAt(x, width) {
  const usable = width - DIVIDER;
  if (!(usable > 0)) return 0.5;
  return clampRatio((x - DIVIDER / 2) / usable, width);
}

module.exports = { DIVIDER, MIN_PANE, RATIO, SIDES, normalize, shown, paneOf, placement, select, setSplit, without, clampRatio, paneBounds, ratioAt };
