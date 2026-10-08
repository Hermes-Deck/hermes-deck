"use strict";
const fs = require("fs");
const path = require("path");
const { redact } = require("./util");
// usage.js requires model.js, which requires this file: load the store reader on first use, not at require time
const readStore = (...args) => require("./usage").readStore(...args);
const errorKind = (e) => require("./usage").errorKind(e);

/**
 * Agent plans for the Deck's Plan tab.
 *
 * Live: the plugin writes one `plan` event per todo_list / todo / omh_todo result (events.py parse_plan):
 *   {ev: "plan", sid, source: "todo"|"omh", rev, items: [{id, text, state, depth, phase?, blocked?}], total?}
 * normalizePlan() checks it again here (the relay never trusts a line's bounds), and the model keeps the latest one per
 * session.
 *
 * History: for a session the model has no plan for, storedPlan() rebuilds it from the newest todo tool result in the
 * profile's state.db, read-only (usage.js readStore: in place when that creates no files, else a bounded private copy).
 * parseResult() is the same parser as the plugin's events.parse_plan (keep the two in step).
 */

const PLAN_ITEMS = 64;
const TEXT_MAX = 300;
const PHASE_MAX = 80;
const DEPTH_MAX = 3;
const RESULT_MAX = 4 * 1024 * 1024;
const TOOLS = { todo_list: "todo", todo: "todo", omh_todo: "omh" };
const STATES = new Set(["pending", "active", "done", "cancelled"]);
const TODO_STATES = { pending: "pending", in_progress: "active", completed: "done", cancelled: "cancelled" };
const OMH_STATES = { pending: "pending", active: "active", done: "done", skipped: "cancelled", cancelled: "cancelled" };
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SID_RE = /^[\x21-\x7e]{1,512}$/;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** Redacted, control characters replaced, trimmed, at most `max` characters ("…" marks a cut). */
function text(v, max = TEXT_MAX) {
  if (typeof v !== "string") return "";
  const s = redact(v.replace(CTRL, " ")).trim();
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function rev(v) {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(Math.trunc(v), Number.MAX_SAFE_INTEGER)) : 0;
}

const intDepth = (v) => (Number.isInteger(v) ? Math.max(0, Math.min(v, DEPTH_MAX)) : 0);

/** A plan as the Deck receives it, from a plugin event or a parsed result; null when it is not one. */
function normalizePlan(p) {
  if (!isObj(p) || (p.source !== "todo" && p.source !== "omh") || !Array.isArray(p.items)) return null;
  const items = [];
  for (const [i, raw] of p.items.slice(0, PLAN_ITEMS).entries()) {
    if (!isObj(raw)) continue;
    const id = typeof raw.id === "string" && raw.id ? raw.id.replace(CTRL, " ").slice(0, 64) : String(i + 1);
    const item = { id, text: text(raw.text), state: STATES.has(raw.state) ? raw.state : "pending", depth: intDepth(raw.depth) };
    const phase = text(raw.phase, PHASE_MAX);
    if (phase) item.phase = phase;
    const blocked = text(raw.blocked);
    if (blocked) item.blocked = blocked;
    items.push(item);
  }
  const out = { source: p.source, rev: rev(p.rev), items };
  const total = Number.isInteger(p.total) ? p.total : p.items.length;
  if (total > items.length) out.total = Math.min(total, 1e6);
  return out;
}

function parseTodo(data) {
  if (!Array.isArray(data.todos) || "error" in data) return null;
  const r = rev(data.revision);
  if (!data.todos.length && r === 0) return null; // an unused store reads back empty: not a plan
  const rows = data.todos.filter(isObj);
  const idOf = (t) => (typeof t.id === "string" || (Number.isInteger(t.id))) ? String(t.id) : null;
  const parents = new Map();
  for (const t of rows.slice(0, 1024)) {
    const id = idOf(t);
    if (id !== null) parents.set(id, typeof t.parent === "string" || Number.isInteger(t.parent) ? String(t.parent) : "");
  }
  const depth = (id) => {
    let d = 0;
    const seen = new Set([id]);
    while (d < DEPTH_MAX) {
      id = parents.get(id) || "";
      if (!id || seen.has(id) || !parents.has(id)) break;
      seen.add(id);
      d += 1;
    }
    return d;
  };
  const items = rows.slice(0, PLAN_ITEMS).map((t, i) => {
    const id = idOf(t) !== null ? idOf(t).slice(0, 64) : String(i + 1);
    const state = TODO_STATES[String(t.status ?? "").trim().toLowerCase()] || "pending";
    return { id, text: text(t.content), state, depth: depth(id) };
  });
  return { source: "todo", rev: r, items, total: rows.length };
}

function parseOmh(data) {
  const todo = data.todo;
  if (!isObj(todo) || !Array.isArray(todo.items)) return null;
  const rows = todo.items.filter(isObj);
  const items = rows.slice(0, PLAN_ITEMS).map((t, i) => {
    const item = { id: String(i + 1), text: text(t.text), state: OMH_STATES[String(t.state ?? "").trim().toLowerCase()] || "pending", depth: intDepth(t.depth) };
    const phase = text(t.phase, PHASE_MAX);
    if (phase) item.phase = phase;
    const blocked = text(t.blocked_reason);
    if (blocked) item.blocked = blocked;
    return item;
  });
  const at = typeof todo.updated_at === "string" ? Date.parse(todo.updated_at.slice(0, 40)) : NaN;
  return { source: "omh", rev: Number.isFinite(at) ? rev(at) : 0, items, total: rows.length };
}

/** {source, rev, items[, total]} from one todo tool result (a JSON string or object), or null. Never throws. */
function parseResult(toolName, result) {
  try {
    let data = result;
    if (typeof result === "string") {
      if (result.length > RESULT_MAX) return null;
      data = JSON.parse(result);
    }
    if (!isObj(data)) return null;
    const kind = TOOLS[toolName];
    const plan = kind === "todo" ? parseTodo(data) : kind === "omh" ? parseOmh(data) : parseTodo(data) || parseOmh(data);
    if (plan && plan.total <= plan.items.length) delete plan.total;
    return plan;
  } catch {
    return null;
  }
}

const PLAN_SQL = `SELECT tool_name, content FROM messages WHERE session_id = ? AND role = 'tool'
  AND tool_name IN ('todo_list', 'todo', 'omh_todo')%ACTIVE% ORDER BY id DESC LIMIT 5`;

/**
 * Rebuilds plans of stored sessions from Hermes' state.db (read-only). One indexed query per session (and per
 * compression ancestor, at most five); answers are cached per (profile, session) for `ttlMs`.
 */
class PlanStore {
  constructor({ root, ttlMs = 30_000, maxCache = 256, read = readStore } = {}) {
    this.root = root || null;
    this.ttlMs = ttlMs;
    this.maxCache = maxCache;
    this.read = read;
    this.cache = new Map(); // "profile\tsid" -> {at, plan}
  }

  file(profile) {
    return profile === "default" ? path.join(this.root, "state.db") : path.join(this.root, "profiles", profile, "state.db");
  }

  /** Profiles that have a state.db, default first. */
  profiles() {
    if (!this.root) return [];
    const out = fs.existsSync(this.file("default")) ? ["default"] : [];
    let names = [];
    try {
      names = fs.readdirSync(path.join(this.root, "profiles")).sort();
    } catch {
      /* no named profiles */
    }
    for (const n of names) if (PROFILE_RE.test(n) && fs.existsSync(this.file(n))) out.push(n);
    return out;
  }

  /**
   * {plan, profile, found} for a stored session: `hint` (the profile the live model knows) first, then every profile.
   * plan is null when the session never published one; found is false when no profile has the session. Throws (with
   * `kind`) only when the session was not found and some store could not be read.
   */
  get(sid, hint, now = Date.now()) {
    if (!this.root || typeof sid !== "string" || !SID_RE.test(sid)) return { plan: null, profile: null, found: false };
    const hit = this.cache.get(sid);
    if (hit && now - hit.at < this.ttlMs && (!hint || hit.profile === hint || !hit.found)) return hit.value;
    const order = [...new Set([hint, ...this.profiles()].filter((p) => typeof p === "string" && PROFILE_RE.test(p)))];
    let failure = null;
    let value = { plan: null, profile: null, found: false };
    for (const profile of order) {
      let plan;
      try {
        plan = this.read(this.file(profile), (db) => this._query(db, sid));
      } catch (e) {
        failure = failure || e;
        continue;
      }
      if (plan !== undefined) {
        value = { plan, profile, found: true };
        break;
      }
    }
    if (!value.found && failure) throw failure;
    this.cache.delete(sid);
    this.cache.set(sid, { at: now, profile: value.profile, found: value.found, value });
    while (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  /** The session's plan (null: none), or undefined when this store does not have the session. */
  _query(db, sid) {
    const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name));
    const msgCols = cols("messages");
    const sesCols = cols("sessions");
    if (!sesCols.has("id") || !db.prepare("SELECT 1 AS x FROM sessions WHERE id = ?").get(sid)) return undefined;
    if (!msgCols.has("tool_name") || !msgCols.has("content")) return null;
    const stmt = db.prepare(PLAN_SQL.replace("%ACTIVE%", msgCols.has("active") ? " AND active = 1" : ""));
    const parentStmt = sesCols.has("parent_session_id") ? db.prepare("SELECT parent_session_id AS parent, source FROM sessions WHERE id = ?") : null;
    let current = sid;
    const seen = new Set();
    for (let hop = 0; hop < 6 && current && !seen.has(current); hop++) {
      seen.add(current);
      for (const row of stmt.all(current)) {
        const plan = parseResult(row.tool_name, row.content);
        if (plan) return normalizePlan(plan);
      }
      if (!parentStmt) break;
      const meta = parentStmt.get(current);
      // a compression continuation goes on in a new session id; a sub-agent's parent is another agent's plan
      if (!meta || !meta.parent || meta.source === "subagent") break;
      current = meta.parent;
    }
    return null;
  }
}

module.exports = { normalizePlan, parseResult, PlanStore, PLAN_ITEMS, TEXT_MAX, errorKind };
