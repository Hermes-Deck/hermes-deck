"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../../renderer/i18n");
// One "Agent'a ver" grant: which agent may act in which window of this device, and until when.
// Pure; unit-tested in app/test/cua-protocol.test.js.

const MAX_MS = 2 * 60 * 60 * 1000; // a grant lasts at most 2 h (docs/bot-screen-protocol.md, Consent defaults)
const IDLE_MIN = 30; // ...and stops after 30 min without driver activity

const PROFILE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const clip = (s, n) => String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const posInt = (v) => Number.isSafeInteger(v) && v > 0;

/**
 * Builds a grant from the consent sheet's choices. Throws with a user-facing (Turkish) message when a part
 * is missing; the window must come from the driver's own window list, so it has a pid.
 * @param {{agent: string, profile: string, app: string, window: {id: number, pid: number, title: string}, now?: number, durationMs?: number}} o
 */
function makeGrant({ agent, profile, app, window: w, foreground = false, now = Date.now(), durationMs = MAX_MS }) {
  const name = clip(agent, 64);
  if (!name) throw new Error(i18nText("U0138"));
  if (!PROFILE_RE.test(String(profile || ""))) throw new Error(i18nText("U0139"));
  if (!w || !posInt(w.id)) throw new Error(i18nText("U0140"));
  if (!posInt(w.pid)) throw new Error(i18nText("U0141"));
  const ms = Math.min(MAX_MS, Math.max(60 * 1000, Number(durationMs) || MAX_MS));
  return {
    agent: name,
    profile: String(profile),
    app: clip(app, 120) || i18nText("A0089"),
    window: { id: w.id, pid: w.pid, title: clip(w.title, 300) },
    startedAt: now,
    expires: now + ms,
    idleMin: IDLE_MIN,
    foreground: foreground === true,
  };
}

/** Exactly the contract's grant object (what the relay gets in {"t":"grant"}). */
function wireGrant(g) {
  return { agent: g.agent, app: g.app, window: { id: g.window.id, pid: g.window.pid, title: g.window.title }, expires: g.expires, idleMin: g.idleMin, foreground: g.foreground === true };
}

/** Why a grant must end now: "expiry", "idle", or null while it is still good. */
function endReason(g, { now = Date.now(), lastActivity = 0 } = {}) {
  if (!g) return null;
  if (now >= g.expires) return "expiry";
  const last = Math.max(lastActivity || 0, g.startedAt || 0);
  if (now - last >= g.idleMin * 60 * 1000) return "idle";
  return null;
}

/** Milliseconds until the grant expires (0 when it already has). */
const remaining = (g, now = Date.now()) => (g ? Math.max(0, g.expires - now) : 0);

module.exports = { MAX_MS, IDLE_MIN, PROFILE_RE, makeGrant, wireGrant, endReason, remaining };
