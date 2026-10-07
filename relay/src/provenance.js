"use strict";
/**
 * Role and provenance labels for delegate_task children (A13: OMH routing metadata).
 *
 * OMH ("Oh My Hermes") routes delegation per dispatch: `omh_delegate_route` writes the model, provider and
 * reasoning effort for the NEXT `delegate_task` of the same turn (Hermes re-reads delegation.* on every
 * dispatch). One route authorizes one dispatch. deck-events already streams both tool calls with their
 * argument/result previews, so the relay can label each child of that dispatch:
 *   child.origin = "omh", child.route = {category, model, provider, effort}
 * Children of an OMH child are OMH too (no route of their own). Native Hermes children get no label.
 * The plugin's role (`leaf`, `orchestrator`) is kept by the model as `role`; an OMH role marker in the goal
 * (`[omh-role:<name>]`) becomes `omhRole`.
 *
 * State between the route and the dispatch lives in WeakMaps keyed by the session object, so it never
 * shows up in session summaries and goes away with pruned sessions.
 */
const ROUTE_TOOL = "omh_delegate_route";
const SPAWN_TOOL = "delegate_task";
const ROUTE_ACTIONS = new Set(["set", "fallback"]);
const FAILED = new Set(["error", "failed", "blocked", "timeout"]);
const DISPATCH_TTL_S = 30 * 60; // a queued child can start late, but not a later turn's

const pending = new WeakMap(); // session -> route prepared by omh_delegate_route, not yet dispatched
const dispatched = new WeakMap(); // session -> route spent by its latest delegate_task

const strField = (k) => new RegExp(`"${k}"\\s*:\\s*"([^"\\\\]{1,80})"`);

/** Route fields from the tool's args preview (short, usually complete JSON) and result preview (often clipped). */
function parseRoute(args, result) {
  let a = null;
  try {
    a = JSON.parse(args);
  } catch {
    a = null; // a clipped preview: fall back to field patterns
  }
  const fromArgs = (k) => (a && typeof a === "object" && typeof a[k] === "string" ? a[k] : (strField(k).exec(args || "") || [])[1]);
  // the result's "applied" block is what Hermes will actually dispatch with
  const applied = /"applied"\s*:\s*\{([^{}]*)\}/.exec(result || "");
  const fromApplied = (k) => (applied ? (strField(k).exec(applied[1]) || [])[1] : undefined);
  const r = {
    action: fromArgs("action") || "set",
    category: fromArgs("category") || (strField("category").exec(result || "") || [])[1],
    model: fromApplied("model") || fromArgs("model"),
    provider: fromApplied("provider") || fromArgs("provider"),
    effort: fromApplied("reasoning_effort") || fromArgs("reasoning_effort"),
  };
  for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
  return r;
}

function toolStart(s, ev) {
  if (ev.tool !== SPAWN_TOOL) return;
  // the dispatch spends the prepared route, so a second delegate_task in the same turn is native again
  const r = pending.get(s);
  pending.delete(s);
  if (r) dispatched.set(s, { ...r, ts: ev.ts });
  else dispatched.delete(s);
}

/** `t` is the model's recent-tool entry (it holds the tool_start args preview). */
function toolEnd(s, ev, t) {
  if (ev.tool !== ROUTE_TOOL) return;
  const r = parseRoute(t && t.args, ev.result);
  if (FAILED.has(String(ev.status || "")) || !ROUTE_ACTIONS.has(r.action) || !(r.category || r.model)) {
    pending.delete(s); // "clear", a refused route or one we cannot read: the next dispatch is native
    return;
  }
  delete r.action;
  pending.set(s, r);
}

/** A new user turn (or its end): routes never carry over to another turn. */
function turnBoundary(s) {
  pending.delete(s);
  dispatched.delete(s);
}

/** Hermes context compression moved the running turn to a new session id. */
function handover(from, to) {
  for (const m of [pending, dispatched]) {
    if (m.has(from) && !m.has(to)) m.set(to, m.get(from));
    m.delete(from);
  }
}

function subStart(parent, child, ev) {
  const d = dispatched.get(parent);
  const fresh = d && (typeof ev.ts !== "number" || typeof d.ts !== "number" || ev.ts - d.ts < DISPATCH_TTL_S);
  if (fresh) {
    child.origin = "omh";
    child.route = { ...d };
    delete child.route.ts;
  } else if (parent.origin === "omh" && !child.origin) {
    child.origin = "omh";
  }
  const marker = /\[omh-role:([A-Za-z0-9_-]{1,40})\]/.exec(ev.goal || child.goal || "");
  if (marker) child.omhRole = marker[1];
}

module.exports = { parseRoute, toolStart, toolEnd, turnBoundary, handover, subStart };
