'use strict';
/**
 * Phone notification decisions around MobileRelay (D9, D13, R11, R12): which chats are "mine", one banner per turn,
 * the per-device breaker at release time, the digest, the seen signal, the wire fields of a notification record and
 * the decision log. MobileRelay keeps the records, the ledger and the gateway transport; it calls in here.
 * Time comes from the relay's injected clock; nothing here reads Date.now().
 */
const crypto = require('node:crypto');
const { NotifyGovernor, normalizePolicy, isFresh } = require('./mobile-notify-policy');

/** A chat counts as "mine" for this long after the device sent to it, opened its history or steered it. */
const STAKE_MS = 12 * 3600000;
const STAKE_LIMIT = 200, TURN_LIMIT = 200;
/** A turn that is still running pushes its reply after this long without a further message (only when `reply` is on). */
const REPLY_SETTLE_MS = 20000;
/** An open turn banner that never saw its end is dropped after this long. */
const TURN_ABANDON_MS = 6 * 3600000;
const TEST_INTERVAL_MS = 30000;
const SEEN_REASONS = new Set(['foreground', 'notification', 'op', 'presence']);
/** Ops that show a person takes part in a chat (args carry `sid` + `profile`). */
const LEGACY_POLICY = Object.freeze({ agents: Object.freeze(['default']) });
const STAKE_OPS = new Set(['send', 'steer', 'redirect', 'interrupt', 'takeover', 'history', 'setModel', 'setEffort', 'renameSession', 'branchSession', 'steerSubagent']);
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SID = /^[\x21-\x7e]{1,512}$/;
const APPROVAL_CHOICES = 8, QUESTIONS = 10, CHOICES = 50;

const hash = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
/** Opaque per-chat id: APNs collapse id towards the gateway, thread id on the phone (G3). Never names the chat. */
const collapseId = (deviceId, profile, sid) => hash(`${deviceId}:${profile}:${sid}`);
/** The digest of a device replaces the previous digest, never a chat banner. */
const digestCollapse = deviceId => hash(`${deviceId}:digest`);
/** The test banner has its own thread so it never replaces a chat's banner. */
const testCollapse = deviceId => hash(`${deviceId}:test`);
/** Badge corrections of a device replace each other at APNs and never a chat banner (relay-extras X2). */
const badgeCollapse = deviceId => hash(`${deviceId}:badge`);
const BADGE_MAX = 999;
const short = value => typeof value === 'string' ? value.slice(0, 8) : null;
const singleLine = (text, max) => typeof text === 'string' && !!text.trim() && !/[\r\n]/.test(text.trim()) && [...text.trim()].length <= max;

/** True for a sub-agent's own session (never a compression continuation of the same chat). */
function isSubagentNode(node, sid) {
  if (!node || typeof node !== 'object') return false;
  if (node.subagentId || node.role === 'subagent' || node.source === 'subagent') return true;
  return typeof node.parent === 'string' && !!node.parent && node.parent !== sid && node.source !== 'deck';
}

/**
 * G17: what a notification action needs to answer a request without opening the app. No question text (the body has
 * it). `quick` keeps the "may be answered from a banner" judgement in one place:
 * approval: a single-line command of at most 200 characters, a description, and both `once` and `deny` offered;
 * question: exactly one single-choice question (free text or 1..4 choices) whose text is one line of at most 200.
 */
function requestRecord(source) {
  if (!source || typeof source.id !== 'string' || !source.id || source.id.length > 256) return null;
  if (source.kind === 'approval') {
    const choices = (Array.isArray(source.choices) ? source.choices : ['once', 'deny']).filter(choice => typeof choice === 'string' && choice.length <= 32).slice(0, APPROVAL_CHOICES);
    const quick = choices.includes('once') && choices.includes('deny') && singleLine(source.command, 200) && typeof source.description === 'string' && !!source.description.trim();
    return { id: source.id, kind: 'approval', choices, quick };
  }
  if (source.kind === 'question') {
    const questions = (Array.isArray(source.questions) ? source.questions : []).filter(q => q && typeof q.qid === 'string' && q.qid && q.qid.length <= 128).slice(0, QUESTIONS)
      .map(q => ({ qid: q.qid, choices: (Array.isArray(q.choices) ? q.choices : []).filter(choice => typeof choice === 'string').map(choice => choice.slice(0, 300)).slice(0, CHOICES), multi: q.multi === true }));
    const one = questions.length === 1 ? questions[0] : null;
    const quick = !!one && !one.multi && one.choices.length <= 4 && singleLine(source.questions.find(q => q?.qid === one.qid)?.question, 200);
    return { id: source.id, kind: 'question', questions, quick };
  }
  return null;
}

/**
 * The event body towards the push gateway (PROGRAMME "Push gateway contract for D9"): `collapse` only when the gateway
 * offers it, kind `digest` only when offered (else the digest travels as `done`). Old gateways reject unknown keys.
 */
function gatewayEvent(push, id, item, badge = null) {
  const offers = feature => typeof push?.offers === 'function' && push.offers(feature) === true;
  // The test banner travels as kind `test` (delivered whatever kinds the phone picked) when the gateway offers it, else
  // as the registration kind stored on the record when it was made (relay-extras X1).
  const kind = item.kind === 'digest' ? (offers('digest') ? 'digest' : 'done') : item.test && offers('test') ? 'test' : item.kind;
  const out = { id, kind, ...(offers('collapse') && /^[a-f0-9]{32}$/.test(item.thread || '') ? { collapse: item.thread } : {}) };
  // The badge (open approvals + questions) rides on every push to a gateway that offers it, so the app icon is right
  // even when the notification extension cannot reach the relay; a `badge` event is the silent correction (X2).
  const count = item.kind === 'badge' ? item.badge : badge;
  if (offers('badge') && Number.isSafeInteger(count) && count >= 0) out.badge = Math.min(count, BADGE_MAX);
  return out;
}

class NotifyCenter {
  constructor({ now, log } = {}) {
    this.now = now || Date.now;
    this.write = log || (line => console.log(line));
  }
  // --- device state -------------------------------------------------------------------------------------------------
  /** Restores the notification state of a device from its persisted metadata (bounded, tolerant of old files). */
  attach(device, saved = {}) {
    let policy = null;
    try { policy = saved.pushPolicy ? normalizePolicy(saved.pushPolicy) : null; } catch {}
    device.pushPolicy = policy;
    // No policy ever sent (an app from before the policy existed): its main assistant is followed, so a turn started at
    // the desktop still reaches the phone (the relay cannot see who started a turn). An app that sends a policy decides itself.
    device.governor = new NotifyGovernor({ policy: policy || LEGACY_POLICY, kinds: device.pushKinds, state: saved.pushGovernor, now: this.now });
    const cutoff = this.now() - STAKE_MS;
    device.stake = new Map((Array.isArray(saved.stake) ? saved.stake : []).filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && Number.isSafeInteger(entry[1]) && entry[1] > cutoff).slice(-STAKE_LIMIT));
    device.turns = new Map((Array.isArray(saved.turns) ? saved.turns : []).filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && typeof entry[1].id === 'string').slice(-TURN_LIMIT));
    device.lastTestPush = 0;
  }
  /** The fields persist() writes next to the notification ledger. */
  save(device) {
    const out = { pushPolicy: device.pushPolicy || null, stake: [...(device.stake || [])], turns: [...(device.turns || [])] };
    if (device.governor && !isFresh(device.governor.state)) out.pushGovernor = device.governor.state;
    return out;
  }
  /** A validated, clamped policy (or the defaults for null/undefined). Throws `bad_request` for a non-object. */
  setPolicy(device, raw) {
    let policy;
    try { policy = raw === undefined || raw === null ? null : normalizePolicy(raw); }
    catch { throw Object.assign(new Error('Invalid push policy'), { code: 'bad_request', status: 400 }); }
    device.pushPolicy = policy;
    device.governor.configure(policy || LEGACY_POLICY, device.pushKinds);
    return policy || normalizePolicy(LEGACY_POLICY);
  }
  /** Throws `bad_request` when a registration's `policy` cannot be read (checked before the gateway is called). */
  checkPolicy(raw) {
    try { normalizePolicy(raw); }
    catch { throw Object.assign(new Error('Invalid push policy'), { code: 'bad_request', status: 400 }); }
  }
  policy(device) { return device.governor.policy; }
  // --- stake: is this chat "mine" -----------------------------------------------------------------------------------
  /**
   * Called for every op the device sends: stake in the chat, and a mutation counts as "seen" (G1). `reply` is the
   * result of the `seen` op itself; `dirty` says the persisted state changed.
   */
  noteOp(device, op, args, mutation) {
    if (op === 'seen') { const { changed, ...reply } = this.seen(device, typeof args?.reason === 'string' ? args.reason : 'foreground'); return { reply, dirty: changed }; }
    let dirty = false;
    if (STAKE_OPS.has(op) && typeof args?.profile === 'string' && PROFILE_NAME.test(args.profile) && typeof args.sid === 'string' && SID.test(args.sid)) { this.stake(device, args.profile, args.sid); dirty = true; }
    if (mutation && this.seen(device, 'op').changed) dirty = true;
    return { reply: undefined, dirty };
  }
  stake(device, profile, sid) {
    const key = JSON.stringify([profile, sid]);
    device.stake.delete(key);
    device.stake.set(key, this.now());
    while (device.stake.size > STAKE_LIMIT) device.stake.delete(device.stake.keys().next().value);
  }
  /** "Mine": the device sent to, opened or steered the chat within 12 h under any id it is known by. */
  mine(device, profile, ids) {
    const cutoff = this.now() - STAKE_MS;
    for (const id of ids) {
      if (typeof id !== 'string' || !id) continue;
      const at = device.stake.get(JSON.stringify([profile, id]));
      if (at && at > cutoff) return true;
    }
    return false;
  }
  /** Every id the chat is known by: stored sid, runtime id of the event, of the live node, and bound runtime ids. */
  ids(bridge, item, node) {
    const all = new Set([item.sid, item.rpcId, node?.rpcId, node?.sid].filter(value => typeof value === 'string' && value));
    try { for (const [rpc, stored] of bridge?.rpcToStored || []) if (stored?.profile === item.profile && all.has(stored.sid)) all.add(rpc); } catch {}
    return [...all];
  }
  /** Scope decision for an arriving event: null = admitted, else the drop reason (logged by the caller). */
  scope(device, item) {
    if (item.kind === 'approval' || item.kind === 'question') return device.governor.scope({ kind: item.kind, profile: item.profile });
    let node = null;
    try { node = device.bridge?.nodeFor?.(item.sid, item.profile) || null; } catch {}
    return device.governor.scope({ kind: item.kind, profile: item.profile, subagent: isSubagentNode(node, item.sid), mine: this.mine(device, item.profile, this.ids(device.bridge, item, node)) });
  }
  // --- seen ---------------------------------------------------------------------------------------------------------
  /** The person looked at the phone: the breaker resets and what it held is dropped (G1). */
  seen(device, reason = 'foreground') {
    const fresh = isFresh(device.governor.state);
    const held = device.governor.seen();
    if (!fresh) this.log(device, 'seen', { reason: SEEN_REASONS.has(reason) ? reason : 'other', held });
    return { ok: true, held, changed: !fresh };
  }
  // --- one banner per turn (R11) ------------------------------------------------------------------------------------
  /**
   * An assistant message of a chat. While the chat has an open banner, the message updates it ('merged'). A banner
   * whose turn already ended but that has not gone out yet takes the text ('filled'). Otherwise the caller opens a new
   * banner ('open'), which waits for the turn's end (or REPLY_SETTLE_MS of silence, when `reply` is on and the device
   * sent a policy: an old client's `reply` only names the kind a turn's end is carried as, never a banner per message).
   * So a turn pushes once; with the settle rule at most twice (the still-running reply, then its end replacing it).
   */
  message(device, item, body) {
    const entry = device.turns.get(JSON.stringify([item.profile, item.sid]));
    const record = entry && device.notifications.get(entry.id);
    if (record && entry.phase === 'open' && record.delivery === 'pending') {
      if (body) record.body = body;
      entry.at = this.now();
      if (item.turn) entry.turn = item.turn;
      return 'merged';
    }
    // The settle rule already pushed this turn's reply: later messages only update it; the turn's end then pushes once more.
    if (record && entry.phase === 'pushed' && (!item.turn || !entry.turn || item.turn === entry.turn)) {
      if (body) record.body = body;
      entry.at = this.now();
      entry.after = true;
      return 'merged';
    }
    if (record && entry.phase === 'closed' && record.delivery === 'pending' && (!item.turn || !entry.turn || item.turn === entry.turn)) {
      if (body) { record.body = body; delete record.hold; }
      return 'filled';
    }
    return 'open';
  }
  /** Remembers the chat's new open banner. */
  opened(device, item, id) {
    const key = JSON.stringify([item.profile, item.sid]);
    device.turns.delete(key);
    device.turns.set(key, { id, turn: item.turn || null, at: this.now(), phase: item.kind === 'reply' ? 'open' : 'closed' });
    while (device.turns.size > TURN_LIMIT) device.turns.delete(device.turns.keys().next().value);
  }
  /**
   * The end of a turn (done/error). An open banner of the chat is closed and carries the end's kind ('merged'); the
   * same end seen twice (native event and snapshot) is a 'duplicate'; a reply banner already pushed by the settle rule
   * with no message since ends the turn silently ('merged'). Otherwise null: the caller creates the end's own banner.
   */
  terminal(device, item, finalKind, body = '') {
    const key = JSON.stringify([item.profile, item.sid]);
    const entry = device.turns.get(key);
    const record = entry && device.notifications.get(entry.id);
    if (!record) return null;
    if (entry.phase === 'closed' && item.turn && entry.turn === item.turn) return 'duplicate';
    if (entry.phase === 'pushed' && (!item.turn || !entry.turn || entry.turn === item.turn)) {
      if (entry.after) return null; // messages came after the settle push: the end gets its own (replacing) banner
      entry.phase = 'closed';
      return 'merged';
    }
    if (entry.phase !== 'open' || record.delivery !== 'pending') return null;
    entry.phase = 'closed';
    if (item.turn) entry.turn = item.turn;
    delete record.open;
    if (!finalKind) { record.delivery = 'dropped'; this.log(device, 'kind-off', item); return 'merged'; }
    record.kind = finalKind;
    // An error shows what went wrong; a done keeps the turn's last message (or the end's own text when it had none).
    if (body && (item.kind === 'error' || !record.body)) record.body = body;
    return 'merged';
  }
  /** Sweep: open banners whose turn went quiet push as `reply` when that kind is on; abandoned ones are dropped. */
  settle(device, replyOn) {
    const now = this.now();
    let changed = false;
    for (const [key, entry] of device.turns) {
      if (entry.phase !== 'open') continue;
      const record = device.notifications.get(entry.id);
      if (!record || record.delivery !== 'pending') { device.turns.delete(key); changed = true; continue; }
      if (replyOn && now - entry.at >= REPLY_SETTLE_MS) { delete record.open; entry.phase = 'pushed'; changed = true; }
      else if (now - entry.at >= TURN_ABANDON_MS) { record.delivery = 'dropped'; delete record.open; device.turns.delete(key); changed = true; }
    }
    return changed;
  }
  // --- breaker at release, digest -----------------------------------------------------------------------------------
  /**
   * The breaker's verdict for a banner about to go to the gateway: 'send' | 'hold' | 'bypass'. A digest and the test
   * push are the breaker's own output / an explicit user action and always go. A digest made due by this call is
   * returned so the caller stores it.
   */
  release(device, item) {
    if (item.kind === 'digest' || item.kind === 'badge' || item.kind === 'liveactivity' || item.test) return { action: 'bypass', digest: null };
    const verdict = device.governor.release({ kind: item.kind, chat: item.thread || collapseId(device.id, item.profile, item.sid) });
    if (verdict.action === 'hold') this.log(device, 'held', item);
    return verdict;
  }
  /** Sweep: a quiet window that ended with held events yields one digest (the caller stores and pushes it). */
  tick(device) { return device.governor.tick(this.now()); }
  // --- wire ---------------------------------------------------------------------------------------------------------
  /**
   * Capability flags (N10): `pushPolicy` says the relay takes `policy` in the registration, answers `/mobile/seen` and
   * the `seen` op, scopes pushes and has the test push; `collapse`/`digest` follow the gateway's features right now.
   * `notificationRequests`: approval/question records carry `request`.
   */
  capabilities(push) {
    const offers = feature => typeof push?.offers === 'function' && push.offers(feature) === true;
    return { pushPolicy: { v: 1, collapse: offers('collapse'), digest: offers('digest'), scope: true, seen: true, test: true, testKind: offers('test'), badge: offers('badge') }, notificationRequests: true };
  }
  /** Fields stored on a new record: the thread id and, for approvals and questions, the request (G3, G17). */
  recordFields(device, item) {
    const fields = { thread: collapseId(device.id, item.profile, item.sid) };
    const request = item.kind === 'approval' || item.kind === 'question' ? requestRecord(item.source) : null;
    if (request) fields.request = request;
    return fields;
  }
  /**
   * The wire additions of `GET /mobile/notifications/<id>`: `thread` (G3), `badge` (G5), `request` (G17). A digest is
   * `{kind: "digest", counts, thread, badge}` and a test banner `{kind: "done", test: true, thread, badge}`: no chat,
   * no text. Records stored by older relays get their thread computed now.
   */
  wire(device, item, badge) {
    if (item.kind === 'badge') return { kind: 'badge', badge, title: '', body: '', agent: '', thread: item.thread || badgeCollapse(device.id) };
    if (item.kind === 'digest') return { kind: 'digest', counts: item.counts || { updates: 0, chats: 0, needsYou: 0 }, title: '', body: '', agent: '', thread: item.thread || digestCollapse(device.id), badge };
    if (item.test) return { kind: item.kind, test: true, title: item.title || '', body: item.body || '', agent: '', thread: item.thread || testCollapse(device.id), badge };
    const out = { thread: item.thread || collapseId(device.id, item.profile, item.sid), badge };
    if (item.request && (item.kind === 'approval' || item.kind === 'question')) out.request = item.request;
    return out;
  }
  digestRecord(device, digest, timestamp) {
    return { kind: 'digest', counts: digest.counts, title: '', body: '', agent: '', thread: digestCollapse(device.id), expires: timestamp + 7 * 86400000, delivery: 'pending' };
  }
  /** A silent badge correction (no banner, no sound): the count only, kept for an hour (X2). */
  badgeRecord(device, count, timestamp) {
    return { kind: 'badge', badge: Math.min(count, BADGE_MAX), title: '', body: '', agent: '', thread: badgeCollapse(device.id), expires: timestamp + 3600000, delivery: 'pending' };
  }
  testRecord(device, timestamp, kind = 'done') {
    return { kind, test: true, title: 'Hermes Deck', body: 'Test notification', agent: '', thread: testCollapse(device.id), expires: timestamp + 7 * 86400000, delivery: 'pending' };
  }
  /** One test banner, at most one per TEST_INTERVAL_MS per device. Returns the wait in ms when refused, else 0. */
  testWait(device) {
    const wait = device.lastTestPush + TEST_INTERVAL_MS - this.now();
    if (wait > 0) return wait;
    device.lastTestPush = this.now();
    return 0;
  }
  /** Decision log: one JSON line per decision; kind, profile and 8 characters of the sid, never text or titles. */
  log(device, decision, item = {}, extra) {
    try {
      this.write(JSON.stringify({ t: 'push', decision, device: short(device.id), kind: item.kind || null, profile: typeof item.profile === 'string' ? item.profile : null, sid: short(item.sid), ...extra }));
    } catch {}
  }
}

module.exports = { NotifyCenter, gatewayEvent, requestRecord, collapseId, digestCollapse, badgeCollapse, isSubagentNode, STAKE_MS, REPLY_SETTLE_MS, TURN_ABANDON_MS, TEST_INTERVAL_MS, STAKE_OPS };
