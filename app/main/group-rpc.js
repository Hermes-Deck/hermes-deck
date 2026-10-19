"use strict";
// Group Chat over the direct Hermes connection: the request shapes the Deck may send for the gateway's hosted rooms
// (tui_gateway/methods_groups.py, groups.*) and the projections of their replies. bridge.js checks every groups.*
// request with validGroupRequest before it leaves the app, and hands the renderer only the projected fields.
// The host plugin checks the same shapes again (hermes-plugin/hermes-deck/observer.py group_params_ok).
//
// Wire (Hermes):
//   groups.capabilities {}                                        -> {driver, methods, max_log_limit, ...}
//   groups.list         {limit?, offset?}                         -> {rooms: [room], next_offset}
//   groups.state        {room_id}                                 -> {room, driver_status?: {working, pending_actions}}
//   groups.log          {room_id, since_seq, limit}               -> {events, cursor, latest_seq, has_more}
//   groups.create       {room_id, name, members}                  -> {room}
//   groups.send         {room_id, event_id, payload: {text, thread_id}} -> {event, accepted}
//   groups.rename       {room_id, event_id, name}                 -> {room}
//   groups.stop / groups.disband {room_id}; groups.retry {room_id, task_id}
//   groups.approve      {room_id, member_id, task_id, execution_generation, request_id, choice}
// There is no live push for rooms: the client polls groups.log (cursor) and groups.state (driver status).

const GROUP_READS = ["groups.capabilities", "groups.list", "groups.state", "groups.log"];
const GROUP_MUTATIONS = ["groups.create", "groups.send", "groups.rename", "groups.stop", "groups.approve", "groups.retry", "groups.disband"];
// (required keys, optional keys) per method; no other key passes
const SHAPES = {
  "groups.capabilities": [[], []],
  "groups.list": [[], ["limit", "offset"]],
  "groups.state": [["room_id"], []],
  "groups.log": [["room_id", "since_seq", "limit"], []],
  "groups.create": [["room_id", "name", "members"], []],
  "groups.send": [["room_id", "event_id", "payload"], []],
  "groups.rename": [["room_id", "event_id", "name"], []],
  "groups.stop": [["room_id"], []],
  "groups.disband": [["room_id"], []],
  "groups.retry": [["room_id", "task_id"], []],
  "groups.approve": [["room_id", "member_id", "task_id", "execution_generation", "request_id", "choice"], []],
};
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/; // hosted_rooms_common.IDENTIFIER_RE, 128 chars
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const REQUEST_ID_RE = /^[\x21-\x7e]{1,512}$/;
const CHOICES = ["once", "session", "always", "deny"];
const NAME_MAX = 200; // hosted_rooms.MAX_ROOM_NAME_CHARS
const TEXT_MAX = 32000; // characters the Deck sends in one room message (the gateway's cap is 64 KiB; the pipe's ~60 KB)
const MIN_MEMBERS = 2;
const MAX_MEMBERS = 6; // hosted_room_discussion.MIN/MAX_DISCUSSION_MEMBERS
const LOG_PAGE = 200;
const MAIN_THREAD = "main"; // every Deck message goes to one thread, so members keep one running context

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isId = (v) => typeof v === "string" && ID_RE.test(v);
const isName = (v) => typeof v === "string" && !!v.trim() && v.length <= NAME_MAX;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
const oneLine = (v, max) => (typeof v === "string" ? v.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const keepLines = (v, max) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").slice(0, max) : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function validMember(m) {
  if (!isObj(m)) return false;
  const keys = Object.keys(m);
  if (!["member_id", "profile", "handle"].every((k) => keys.includes(k)) || !keys.every((k) => ["member_id", "profile", "handle", "display_name"].includes(k))) return false;
  const name = m.display_name === undefined ? "" : m.display_name;
  return isId(m.member_id) && isId(m.handle) && typeof m.profile === "string" && PROFILE_RE.test(m.profile) && typeof name === "string" && name.length <= NAME_MAX;
}

/** Whether a groups.* request has exactly the shape the Deck sends (bridge.js checkRequest). */
function validGroupRequest(method, p) {
  const shape = SHAPES[method];
  if (!shape || !isObj(p)) return false;
  const [required, optional] = shape;
  const keys = Object.keys(p);
  if (!required.every((k) => keys.includes(k)) || !keys.every((k) => required.includes(k) || optional.includes(k))) return false;
  if ("room_id" in p && !isId(p.room_id)) return false;
  switch (method) {
    case "groups.list":
      return (!("limit" in p) || isInt(p.limit, 1, 500)) && (!("offset" in p) || isInt(p.offset, 0, 1000000));
    case "groups.log":
      return isInt(p.since_seq, 0, Number.MAX_SAFE_INTEGER) && isInt(p.limit, 1, 500);
    case "groups.create":
      return isName(p.name) && Array.isArray(p.members) && p.members.length >= MIN_MEMBERS && p.members.length <= MAX_MEMBERS && p.members.every(validMember) &&
        new Set(p.members.map((m) => m.profile)).size === p.members.length && new Set(p.members.map((m) => m.handle.toLowerCase())).size === p.members.length;
    case "groups.send": {
      const pl = p.payload;
      return isId(p.event_id) && isObj(pl) && Object.keys(pl).length === 2 && typeof pl.text === "string" && !!pl.text.trim() && pl.text.length <= TEXT_MAX && isId(pl.thread_id);
    }
    case "groups.rename":
      return isId(p.event_id) && isName(p.name);
    case "groups.retry":
      return isId(p.task_id);
    case "groups.approve":
      return isId(p.member_id) && isId(p.task_id) && isInt(p.execution_generation, 1, Number.MAX_SAFE_INTEGER) &&
        typeof p.request_id === "string" && REQUEST_ID_RE.test(p.request_id) && CHOICES.includes(p.choice);
    default:
      return true;
  }
}

/** desktop data.ts botHandle: the primary profile answers to @hermes; reserved @all / @everyone are never a handle. */
const handleOf = (profile) => (String(profile).toLowerCase() === "default" ? "hermes" : String(profile));

/**
 * The create picker's choice -> groups.create members. Local profiles only (no peer target): member id = profile,
 * handle = the bot's @-tag, display name = its title. Throws on fewer than 2 or more than 6 distinct bots.
 */
function roomMembers(list) {
  const out = [];
  const seen = new Set();
  for (const b of Array.isArray(list) ? list : []) {
    const profile = isObj(b) ? b.profile : null;
    if (typeof profile !== "string" || !PROFILE_RE.test(profile) || seen.has(profile)) continue;
    seen.add(profile);
    const handle = handleOf(profile);
    if (["all", "everyone"].includes(handle.toLowerCase())) continue;
    const name = oneLine(b.name, NAME_MAX);
    out.push({ member_id: profile, profile, handle, ...(name ? { display_name: name } : {}) });
  }
  if (out.length < MIN_MEMBERS || out.length > MAX_MEMBERS) throw new RangeError("members");
  return out;
}

function projectMember(m) {
  if (!isObj(m) || !isId(m.member_id)) return null;
  return {
    id: m.member_id,
    profile: typeof m.profile === "string" && PROFILE_RE.test(m.profile) ? m.profile : "",
    handle: isId(m.handle) ? m.handle : m.member_id,
    name: oneLine(m.display_name, 120),
    remote: isObj(m.target) && m.target.kind === "peer",
  };
}

/** A hosted room row -> {id, name, members, latestSeq, updatedAt, createdAt}; null for anything unusable. */
function projectRoom(r) {
  if (!isObj(r) || !isId(r.room_id)) return null;
  return {
    id: r.room_id,
    name: oneLine(r.name, NAME_MAX) || r.room_id,
    members: (Array.isArray(r.members) ? r.members : []).slice(0, 16).map(projectMember).filter(Boolean),
    latestSeq: Number.isInteger(r.latest_seq) && r.latest_seq >= 0 ? r.latest_seq : 0,
    updatedAt: num(r.updated_at),
    createdAt: num(r.created_at),
    disbanded: r.disbanded_at !== undefined && r.disbanded_at !== null,
  };
}

function projectRooms(result) {
  const rows = isObj(result) && Array.isArray(result.rooms) ? result.rooms : [];
  const out = [];
  const seen = new Set();
  for (const r of rows.slice(0, 500)) {
    const room = projectRoom(r);
    if (!room || room.disbanded || seen.has(room.id)) continue;
    seen.add(room.id);
    out.push(room);
  }
  return out;
}

/** groups.capabilities -> {supported, maxLog}: rooms are shown only with a running hosted driver and the core methods. */
function projectCapabilities(result) {
  const methods = isObj(result) && Array.isArray(result.methods) ? result.methods.filter((m) => typeof m === "string") : [];
  const core = ["groups.list", "groups.create", "groups.state", "groups.log", "groups.send"];
  const supported = isObj(result) && result.driver === true && core.every((m) => methods.includes(m));
  return {
    supported,
    methods: methods.filter((m) => /^groups\.[a-z_.]+$/.test(m)).slice(0, 40),
    maxLog: isInt(result && result.max_log_limit, 1, 500) ? result.max_log_limit : LOG_PAGE,
  };
}

const KINDS = new Set(["message.user", "message.member", "turn.settled", "turn.failed", "turn.cancelled", "turn.deferred", "room.activity", "room.stop_requested", "room.renamed", "room.created", "member.unavailable"]);

/**
 * One log event -> the fields the room view reads. Every event keeps its seq (the cursor moves past kinds the Deck
 * does not show); text is kept as lines, everything else as one bounded line.
 */
function projectEvent(e) {
  if (!isObj(e) || !Number.isInteger(e.seq) || e.seq < 1) return null;
  const kind = typeof e.kind === "string" && KINDS.has(e.kind) ? e.kind : "other";
  const p = isObj(e.payload) ? e.payload : {};
  const a = isObj(e.actor) ? e.actor : {};
  const out = { seq: e.seq, id: oneLine(e.event_id, 128), kind, at: num(e.created_at) };
  if (kind === "other") return out;
  out.actor = { kind: oneLine(a.kind, 16), id: oneLine(a.id, 128), profile: typeof a.profile === "string" && PROFILE_RE.test(a.profile) ? a.profile : "", name: oneLine(a.display_name, 120) };
  if (typeof p.thread_id === "string") out.thread = oneLine(p.thread_id, 128);
  if (typeof p.member_id === "string") out.member = oneLine(p.member_id, 128);
  if (typeof p.discussion_event_id === "string") out.discussion = oneLine(p.discussion_event_id, 128);
  if (Number.isInteger(p.round_index)) out.round = p.round_index;
  if (kind === "message.user" || kind === "message.member") out.text = keepLines(p.text, 70000);
  if (kind === "turn.settled") out.passed = p.passed === true;
  if (kind === "turn.failed") {
    out.error = oneLine(String(p.error || "").split("\n")[0], 300);
    out.reason = oneLine(p.reason_code, 64);
  }
  if (kind === "room.activity") out.status = oneLine(p.status, 32);
  if (kind === "room.renamed") out.name = oneLine(p.name, NAME_MAX);
  return out;
}

/** groups.log -> {events, cursor, latestSeq, hasMore}; events in seq order, no repeats. */
function projectLog(result) {
  const r = isObj(result) ? result : {};
  const seen = new Set();
  const events = [];
  for (const e of (Array.isArray(r.events) ? r.events : []).slice(0, 500)) {
    const ev = projectEvent(e);
    if (!ev || seen.has(ev.seq)) continue;
    seen.add(ev.seq);
    events.push(ev);
  }
  events.sort((a, b) => a.seq - b.seq);
  const last = events.length ? events[events.length - 1].seq : 0;
  const cursor = Number.isInteger(r.cursor) && r.cursor >= 0 ? r.cursor : last;
  const latestSeq = Number.isInteger(r.latest_seq) && r.latest_seq >= 0 ? r.latest_seq : cursor;
  return { events, cursor, latestSeq, hasMore: r.has_more === true && cursor < latestSeq };
}

/**
 * groups.state -> {room, working, blocked, approvals, retries}. Approvals carry what the card shows and what
 * groups.approve needs back; the room session id and run id stay here.
 */
function projectState(result) {
  const r = isObj(result) ? result : {};
  const d = isObj(r.driver_status) ? r.driver_status : {};
  const approvals = [];
  const retries = [];
  for (const a of (Array.isArray(d.pending_actions) ? d.pending_actions : []).slice(0, 20)) {
    if (!isObj(a)) continue;
    if (a.kind === "retry" && isId(a.task_id)) retries.push({ taskId: a.task_id });
    if (a.kind !== "approval" || !isId(a.member_id) || !isId(a.task_id) || !isInt(a.execution_generation, 1, Number.MAX_SAFE_INTEGER)) continue;
    const ap = isObj(a.approval) ? a.approval : {};
    const requestId = typeof a.request_id === "string" && REQUEST_ID_RE.test(a.request_id) ? a.request_id : typeof ap.request_id === "string" && REQUEST_ID_RE.test(ap.request_id) ? ap.request_id : "";
    if (!requestId) continue;
    const choices = (Array.isArray(ap.choices) ? ap.choices : []).filter((c) => CHOICES.includes(c));
    approvals.push({
      memberId: a.member_id,
      taskId: a.task_id,
      generation: a.execution_generation,
      requestId,
      command: keepLines(ap.command, 4000),
      description: oneLine(ap.description, 400),
      choices: choices.length ? [...new Set(choices)] : ["once", "deny"],
    });
  }
  return { room: projectRoom(r.room), working: d.working === true, blocked: d.blocked === true, approvals, retries };
}

module.exports = {
  GROUP_READS,
  GROUP_MUTATIONS,
  SHAPES,
  CHOICES,
  TEXT_MAX,
  MIN_MEMBERS,
  MAX_MEMBERS,
  LOG_PAGE,
  MAIN_THREAD,
  validGroupRequest,
  roomMembers,
  projectRoom,
  projectRooms,
  projectCapabilities,
  projectEvent,
  projectLog,
  projectState,
};
