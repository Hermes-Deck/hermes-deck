'use strict';
/**
 * Phone push policy (D9), pure and clock-injected: which events may reach a phone at all (kinds, scope, followed and
 * muted agents, sub-agent sessions) and the per-device burst breaker with its digest.
 *
 * Breaker, per device:
 * - after `burst` pushes sent since the device was last seen, a quiet window of `quietMinutes` starts; nothing is sent
 *   inside it (kinds in `bypass` excepted, and they are never counted);
 * - events that arrive inside the window are counted, never queued (updates, distinct chats, needs-you);
 * - when the window ends and something was held: ONE digest, and the next window starts at once, twice as long
 *   (capped at `maxQuietMinutes`, or `quietMinutes` when that is longer);
 * - when the window ends and nothing was held: the window closes; the next event is sent and starts the next, longer
 *   window right away (the device is still unseen);
 * - `seen` (app in the foreground, a notification opened, any user op) resets everything and drops what was held.
 *
 * Every function takes `now` (ms); the state is a plain JSON object so it can be persisted as is.
 */
const KINDS = Object.freeze(['reply', 'done', 'approval', 'question', 'error']);
/** Kinds a device gets when it never sent a list (R14): one banner per finished turn, not per message. */
const DEFAULT_KINDS = Object.freeze(['done', 'approval', 'question', 'error']);
const NEEDS_YOU = new Set(['approval', 'question']);
const SCOPES = Object.freeze(['mine', 'followed', 'all']);
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RANGES = Object.freeze({ burst: [1, 20], quietMinutes: [1, 120] });
const MAX_QUIET_MINUTES = 60;
const AGENT_LIMIT = 64;
/** Distinct chats remembered per window; beyond that they are still counted, not remembered. */
const CHAT_LIMIT = 200;
const MINUTE = 60000;
const DEFAULT_POLICY = Object.freeze({ v: 1, burst: 5, quietMinutes: 10, maxQuietMinutes: MAX_QUIET_MINUTES, bypass: Object.freeze([]), scope: 'mine', agents: Object.freeze([]), muted: Object.freeze([]) });

const clamp = (value, [low, high], fallback) => Number.isFinite(value) ? Math.min(high, Math.max(low, Math.round(value))) : fallback;
const profiles = value => Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string' && PROFILE.test(item)))].slice(0, AGENT_LIMIT) : [];

/**
 * A device policy from untrusted input: unknown keys ignored, numbers clamped, bad entries dropped. `undefined`/`null`
 * means the defaults. Anything else that is not a plain object is a client bug and throws (the route answers 400).
 */
function normalizePolicy(raw) {
  if (raw === undefined || raw === null) return { ...DEFAULT_POLICY, bypass: [], agents: [], muted: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Push policy must be an object');
  const quietMinutes = clamp(raw.quietMinutes, RANGES.quietMinutes, DEFAULT_POLICY.quietMinutes);
  return {
    v: 1,
    burst: clamp(raw.burst, RANGES.burst, DEFAULT_POLICY.burst),
    quietMinutes,
    maxQuietMinutes: Math.max(MAX_QUIET_MINUTES, quietMinutes),
    bypass: Array.isArray(raw.bypass) ? [...NEEDS_YOU].filter(kind => raw.bypass.includes(kind)) : [],
    scope: SCOPES.includes(raw.scope) ? raw.scope : DEFAULT_POLICY.scope,
    agents: profiles(raw.agents),
    muted: profiles(raw.muted),
  };
}
/** The kinds a device receives: its stored list (a list always wins, also an empty one), else the defaults. */
function kindsOf(stored) {
  return Array.isArray(stored) ? stored.filter(kind => KINDS.includes(kind)) : [...DEFAULT_KINDS];
}
/**
 * Scope (R12 + D13) for one event `{kind, profile, subagent, mine}`: null = admitted, else the drop reason.
 * Approvals and questions come from every agent and every session (they block work); the breaker still applies.
 * Sub-agent sessions never produce reply/done/error of their own, whatever the scope. A muted agent beats a followed one.
 * `mine`: the caller's judgement that a person on this device takes part in the chat.
 */
function scopeDecision(policy, event) {
  const p = policy || DEFAULT_POLICY;
  if (NEEDS_YOU.has(event.kind)) return null;
  if (event.subagent) return 'subagent';
  if (p.muted.includes(event.profile)) return 'muted';
  if (p.scope === 'all' || p.agents.includes(event.profile)) return null;
  if (p.scope === 'followed') return 'scoped-out';
  return event.mine ? null : 'scoped-out';
}

const emptyHeld = () => ({ updates: 0, needsYou: 0, chats: [], moreChats: 0 });
/** A fresh breaker: nothing sent since seen, no window. */
function freshState() { return { sent: 0, quietUntil: 0, quietMs: 0, held: emptyHeld() }; }
/** A persisted state read back: anything malformed becomes a fresh state (never throws). */
function restoreState(raw) {
  const state = freshState();
  if (!raw || typeof raw !== 'object') return state;
  for (const key of ['sent', 'quietUntil', 'quietMs']) if (Number.isSafeInteger(raw[key]) && raw[key] >= 0) state[key] = raw[key];
  const held = raw.held;
  if (held && typeof held === 'object') {
    for (const key of ['updates', 'needsYou', 'moreChats']) if (Number.isSafeInteger(held[key]) && held[key] >= 0) state.held[key] = held[key];
    if (Array.isArray(held.chats)) state.held.chats = [...new Set(held.chats.filter(chat => typeof chat === 'string' && chat.length <= 64))].slice(0, CHAT_LIMIT);
  }
  return state;
}
function startWindow(state, policy, now) {
  const cap = Math.max(policy.maxQuietMinutes, policy.quietMinutes) * MINUTE;
  state.quietMs = state.quietMs ? Math.min(state.quietMs * 2, cap) : Math.min(policy.quietMinutes * MINUTE, cap);
  state.quietUntil = now + state.quietMs;
}
function hold(state, event) {
  const held = state.held;
  held.updates++;
  if (NEEDS_YOU.has(event.kind)) held.needsYou++;
  if (typeof event.chat === 'string' && event.chat && !held.chats.includes(event.chat)) {
    if (held.chats.length < CHAT_LIMIT) held.chats.push(event.chat);
    else held.moreChats++;
  }
}
/**
 * The end of a quiet window: a digest `{counts: {updates, chats, needsYou}}` when something was held (and the next,
 * longer window starts now), else null (the window closes). Null while no window has ended.
 */
function tick(state, policy, now) {
  if (!state.quietUntil || now < state.quietUntil) return null;
  const held = state.held;
  if (!held.updates) { state.quietUntil = 0; return null; }
  const digest = { counts: { updates: held.updates, chats: held.chats.length + held.moreChats, needsYou: held.needsYou } };
  state.held = emptyHeld();
  startWindow(state, policy, now);
  return digest;
}
/**
 * The breaker's verdict for one push about to be sent, `{kind, chat}`: `{action: 'send' | 'hold' | 'bypass', digest}`.
 * `digest` is set when this call also ended a window that `tick` had not closed yet (the caller sends it first).
 * A `send` is counted at once; call `refund` when the transport then failed, so a retry is not counted twice.
 */
function admit(state, policy, event, now) {
  const digest = tick(state, policy, now);
  if (policy.bypass.includes(event.kind)) return { action: 'bypass', digest };
  if (state.quietUntil > now) { hold(state, event); return { action: 'hold', digest }; }
  state.sent++;
  if (state.sent >= policy.burst) startWindow(state, policy, now);
  return { action: 'send', digest };
}
/** Undo the count of one `send` whose transport failed (the window it may have started stays: erring quiet is safe). */
function refund(state) { if (state.sent > 0) state.sent--; }
/** The device was seen: everything resets; returns how many held events are now dropped. */
function seen(state) {
  const held = state.held.updates;
  Object.assign(state, freshState());
  return held;
}
/** True when the state carries anything worth persisting (avoids a disk write per heartbeat of an idle device). */
function isFresh(state) { return !state.sent && !state.quietUntil && !state.quietMs && !state.held.updates; }

/**
 * One device's governor: policy + kinds + breaker state behind a clock. `admit(event)` is the full decision for an event
 * `{kind, chat, profile, subagent, mine, merge}`: `{decision: 'drop', reason}` (kind off, scope), `{decision: 'merge'}`
 * (the caller found the turn's open banner), else the breaker's `send`/`hold` (`bypass` reported as `send`).
 * The relay uses the two halves separately: `scope` when an event arrives, `release` when its banner is about to go out.
 */
class NotifyGovernor {
  constructor({ policy, kinds, state, now = Date.now } = {}) {
    this.now = now;
    this.configure(policy, kinds);
    this.state = restoreState(state);
  }
  configure(policy, kinds) {
    this.policy = normalizePolicy(policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : undefined);
    this.kinds = kindsOf(kinds);
  }
  kindOn(kind) { return this.kinds.includes(kind); }
  scope(event) { return scopeDecision(this.policy, event); }
  release(event) { return admit(this.state, this.policy, event, this.now()); }
  admit(event) {
    if (!this.kindOn(event.kind)) return { decision: 'drop', reason: 'kind-off' };
    const reason = this.scope(event);
    if (reason) return { decision: 'drop', reason };
    if (event.merge) return { decision: 'merge' };
    const verdict = this.release(event);
    return { decision: verdict.action === 'hold' ? 'hold' : 'send', bypass: verdict.action === 'bypass', digest: verdict.digest };
  }
  refund() { refund(this.state); }
  seen() { return seen(this.state); }
  tick(now = this.now()) { return tick(this.state, this.policy, now); }
  toJSON() { return this.state; }
}

module.exports = { KINDS, DEFAULT_KINDS, DEFAULT_POLICY, RANGES, MAX_QUIET_MINUTES, NEEDS_YOU, normalizePolicy, kindsOf, scopeDecision, freshState, restoreState, tick, admit, refund, seen, isFresh, NotifyGovernor };
