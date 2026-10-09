"use strict";
const { localDay } = require("./util");
const provenance = require("./provenance"); // A13: OMH route / role labels on delegate_task children
const { normalizePlan } = require("./plan"); // the Deck's Plan tab: latest todo_list / omh_todo plan per session

const RECENT_TOOLS = 30;
const KEEP_MS = 24 * 3600 * 1000;
// "running" but silent this long = interrupted/killed, not live. A tool in flight may legitimately
// run long (builds, waits); between tools the model is only thinking, which never takes 15 minutes.
const STALE_TOOL_S = 45 * 60;
const STALE_IDLE_S = 15 * 60;
const ZERO = () => ({ in: 0, cr: 0, cw: 0, out: 0, rs: 0 });
const FINISHED = new Set(["done", "failed", "stopped"]);
// Token pane ranges. "24h" is a true rolling window read from 5-minute rollups kept for 48 h; day ranges are
// local calendar days including today; "all" is every day rollup plus monthly archives of anything older.
const RANGES = ["24h", "7d", "14d", "30d", "all"];
const FINE_S = 300;
const FINE_KEEP_S = 48 * 3600;
const KEEP_DAYS = 400; // day rollups older than this fold into month rollups instead of being dropped
const WEEKS_UP_TO_S = 182 * 86400; // "all" charts weeks while the data spans up to ~6 months, months after
const SUMS = ["n", "sessions", "in", "cr", "cw", "out", "rs", "usd", "actual_usd", "estimated_usd", "equivalent_usd", "unknownCost"];

/** Add one rollup row's counters into another (cost fields keep 6 decimals). */
function addInto(target, row) {
  for (const f of SUMS) if (row[f]) target[f] = (target[f] || 0) + row[f];
  for (const f of ["usd", "actual_usd", "estimated_usd", "equivalent_usd"]) if (target[f]) target[f] = Math.round(target[f] * 1e6) / 1e6;
  if (row.estimated) target.estimated = true;
  if (row.cost_label) target.cost_label = row.cost_label;
  if (row.source && !target.source) target.source = row.source;
  return target;
}
const hourStart = ts => { const d = new Date(ts * 1000); d.setMinutes(0, 0, 0); return d.getTime() / 1000; };
const dayStart = day => new Date(`${day}T00:00:00`).getTime() / 1000;
/** Monday (local) of the week a "YYYY-MM-DD" day falls in, as "YYYY-MM-DD". */
function weekOf(day) {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDay(d.getTime() / 1000);
}
const SPLIT_EVS = new Set(["tool_start", "tool_end", "llm", "turn_end", "session_end"]);

function planInfo(plan) {
  const cur = plan.items.find((i) => i.state === "active");
  const out = { source: plan.source, rev: plan.rev, ts: plan.ts, n: plan.total || plan.items.length,
    done: plan.items.filter((i) => i.state === "done").length, active: plan.items.filter((i) => i.state === "active").length };
  if (cur) out.cur = cur.text.slice(0, 120);
  return out;
}

function isStale(s, now) {
  if (s.state !== "running") return false;
  const silent = now - s.lastTs;
  return s.curTool ? silent >= STALE_TOOL_S : silent >= STALE_IDLE_S;
}

/**
 * Live model of every agent session: state, current tool, recent tool calls, sub-agent tree,
 * token totals and per-day rollups. Fed by normalized events (Hermes plugin + Claude Code adapter).
 *
 * `live=false` events (checkpoint warm-up replay) rebuild state but never touch the rollups, so
 * rollups count each API call exactly once across relay restarts.
 */
class Model {
  constructor(agentsCfg, roll = {}, { fine = {}, months = {} } = {}) {
    this.cfg = agentsCfg || { profiles: {} };
    this.sessions = new Map();
    this.roll = roll; // "day\tagent\tmodel" -> {n, in, cr, cw, out, rs, usd}
    this.fine = fine; // "5-minute start epoch\tagent\tmodel" -> same counters, last 48 h (rolling 24 h range)
    this.months = months; // "YYYY-MM\tagent\tmodel": day rollups older than KEEP_DAYS, folded by prune()
    this.dirty = new Set(); // sids changed since the last takeDirty()
  }

  /** Summaries of sessions changed since the last call (pushed to clients with each event batch). */
  takeDirty(now = Date.now() / 1000) {
    const out = [];
    for (const sid of this.dirty) {
      const s = this.sessions.get(sid);
      if (s) out.push(this.summary(s, now));
    }
    this.dirty.clear();
    return out;
  }

  agentName(profile) {
    const p = this.cfg.profiles[profile];
    return p ? p.name : profile;
  }

  _s(sid, ev) {
    let s = this.sessions.get(sid);
    if (!s) {
      s = {
        sid, profile: ev.profile, agent: this.agentName(ev.profile), state: "idle",
        firstTs: ev.ts, lastTs: ev.ts, turns: 0, ntools: 0, curTool: null,
        tokens: ZERO(), children: [], recent: [],
      };
      this.sessions.set(sid, s);
    }
    if (typeof ev.ts === "number") {
      if (!(ev.ts <= s.lastTs)) s.lastTs = ev.ts;
      if (!(ev.ts >= s.firstTs)) s.firstTs = ev.ts;
    }
    for (const k of ["chat", "thread", "skey", "platform"]) if (ev[k] && !s[k]) s[k] = ev[k];
    if (ev.cron) s.cron = true;
    return s;
  }

  _rollAdd(ev, agent, model, u, { call = false, usd = 0 } = {}) {
    if (this.usageRoll !== undefined && ev.profile !== this.externalProfile) return;
    const ts = ev.ts || Date.now() / 1000;
    const tail = `\t${agent}\t${model || "?"}`;
    for (const [store, key] of [[this.roll, `${localDay(ts)}${tail}`], [this.fine, `${Math.floor(ts / FINE_S) * FINE_S}${tail}`]]) {
      const r = store[key] || (store[key] = { n: 0, ...ZERO(), usd: 0 });
      if (call) r.n += 1;
      if (u) for (const k of ["in", "cr", "cw", "out", "rs"]) r[k] += u[k] || 0;
      if (usd) r.usd = Math.round((r.usd + usd) * 1e6) / 1e6;
    }
  }

  apply(ev, live) {
    if (!ev || !ev.ev) return;
    if (ev.ev === "stopped") {
      for (const s of this.sessions.values()) {
        if (ev.skey && s.skey === ev.skey && s.state === "running") {
          s.state = "idle";
          s.curTool = null;
          this.dirty.add(s.sid);
        }
      }
      return;
    }
    if (!ev.sid) return;
    const absoluteCost = ev.ev === "cost" && ev.mode === "absolute";
    const s = absoluteCost ? this.sessions.get(ev.sid) : this._s(ev.sid, ev);
    if (!s) return; // Persisted display costs never create sessions or advance activity time.
    this.dirty.add(ev.sid);
    if (ev.child) this.dirty.add(ev.child);

    // Hermes context compression splits a running session into a new sid mid-turn ("Session split
    // detected: A -> B"). B's first events are tools/llm/turn_end with no turn_start of its own. One chat
    // (skey) runs one turn at a time, so hand A's running state to B instead of leaving A "running".
    if (!s.parent && s.turns === 0 && ev.skey && SPLIT_EVS.has(ev.ev)) {
      for (const o of this.sessions.values()) {
        if (o === s || o.parent || o.skey !== ev.skey || o.state !== "running" || o.firstTs > s.firstTs) continue;
        o.state = "idle";
        o.curTool = null;
        o.splitInto = s.sid;
        this.dirty.add(o.sid);
        s.prev = o.sid;
        s.turns = 1;
        if (!s.lastMsg) s.lastMsg = o.lastMsg;
        if (!s.turnTs) s.turnTs = o.turnTs; // the turn keeps its start time across the split
        provenance.handover(o, s);
        if (!FINISHED.has(s.state)) s.state = "running";
      }
    }

    switch (ev.ev) {
      case "turn_start":
        // A new turn in a top-level session always runs, even after an earlier turn was stopped or failed (the
        // user sent the next message to the same chat). Sub-agents stay finished: their sid is never reused.
        if (!s.parent || !FINISHED.has(s.state)) s.state = "running";
        s.turns += 1;
        s.turnTs = ev.ts; // B2: how long the current turn has been running
        provenance.turnBoundary(s);
        if (ev.model) s.model = ev.model;
        if (ev.msg) {
          if (s.parent) s.goal = s.goal || ev.msg;
          else s.lastMsg = ev.msg;
        }
        break;
      case "turn_end":
        if (s.state === "running") s.state = "idle";
        s.curTool = null;
        provenance.turnBoundary(s);
        break;
      case "session_end":
        if (!FINISHED.has(s.state)) s.state = ev.failed ? "failed" : ev.interrupted ? "stopped" : "idle";
        if (ev.reason) s.exit = ev.reason;
        s.curTool = null;
        break;
      case "tool_start":
        s.curTool = { tool: ev.tool, call: ev.call, since: ev.ts };
        s.ntools += 1;
        s.recent.push({ call: ev.call, tool: ev.tool, args: ev.args, ts: ev.ts });
        if (s.recent.length > RECENT_TOOLS) s.recent.shift();
        provenance.toolStart(s, ev);
        break;
      case "tool_end": {
        let t = null;
        for (let i = s.recent.length - 1; i >= 0; i--) if (s.recent[i].call === ev.call) { t = s.recent[i]; break; }
        if (!t) {
          t = { call: ev.call, tool: ev.tool, ts: ev.ts };
          s.recent.push(t);
          if (s.recent.length > RECENT_TOOLS) s.recent.shift();
        }
        Object.assign(t, { ms: ev.ms, status: ev.status, result: ev.result, err: ev.err });
        if (s.curTool && s.curTool.call === ev.call) s.curTool = null;
        provenance.toolEnd(s, ev, t);
        break;
      }
      case "llm":
      case "aux": {
        const u = ev.usage;
        if (ev.ev === "llm" && ev.model) s.model = ev.model;
        if (u) for (const k of ["in", "cr", "cw", "out", "rs"]) s.tokens[k] += u[k] || 0;
        if (ev.ev === "llm" && u && !ev.cont) {
          s.ctxUsed = (u.in || 0) + (u.cr || 0) + (u.cw || 0); // prompt size of the latest call
          if (ev.ctx_len) s.ctxLen = ev.ctx_len;
          // latest call's split: a big prompt with almost no cache read = paying full price (cold cache)
          s.lastCall = { in: u.in || 0, cr: u.cr || 0, cw: u.cw || 0, out: u.out || 0, ts: ev.ts };
        }
        // Generation speed needs a real timing signal: output tokens and the call's API duration (minus the
        // time to first byte when the plugin measured it). Sources without `dur` (transcripts) never get one.
        if (ev.ev === "llm" && u && u.out > 0 && !ev.cont && typeof ev.dur === "number" && ev.dur > 0) {
          const gen = typeof ev.ttfb === "number" && ev.dur - ev.ttfb > 0 ? ev.dur - ev.ttfb : ev.dur;
          if (gen >= 0.3) {
            s.genOut = (s.genOut || 0) + u.out;
            s.genSecs = Math.round(((s.genSecs || 0) + gen) * 1000) / 1000;
          }
        }
        if (live) this._rollAdd(ev, s.agent, ev.model || s.model, u, { call: !ev.cont });
        break;
      }
      case "cost": {
        if (ev.mode === "absolute") {
          if (typeof ev.usd !== "number" || !Number.isFinite(ev.usd) || ev.usd < 0) break;
          s.cost = ev.usd;
          s.cost_estimated = !!ev.estimated;
          if (ev.cost_label) s.cost_label = ev.cost_label;
          break; // persisted display snapshot, not an incremental accounting event
        }
        if (ev.mode === "delta") {
          if (typeof ev.usd !== "number" || !Number.isFinite(ev.usd) || ev.usd < 0) break;
          s.cost = Math.round(((s.cost || 0) + ev.usd) * 1e6) / 1e6;
          if (ev.cost_label) s.cost_label = ev.cost_label;
          if (ev.estimated) s.cost_estimated = true;
          if (live) this._rollAdd(ev, s.agent, ev.model || s.model, null, { usd: ev.usd });
          break;
        }
        const last = s.costLast || 0;
        let delta;
        if (ev.usd < last) {
          // a new `claude -p` process on the same session restarted its counter
          s.costBase = (s.costBase || 0) + last;
          delta = ev.usd;
        } else {
          delta = ev.usd - last;
        }
        s.costLast = ev.usd;
        s.cost = Math.round(((s.costBase || 0) + ev.usd) * 1e6) / 1e6;
        if (live && delta > 0) this._rollAdd(ev, s.agent, s.model, null, { usd: delta });
        break;
      }
      case "sub_start": {
        const c = this._s(ev.child, { ...ev, sid: ev.child });
        c.parent = ev.sid;
        c.agent = s.agent;
        if (ev.sa) c.sa = ev.sa;
        if (ev.role) c.role = ev.role;
        if (ev.goal) c.goal = ev.goal;
        if (!FINISHED.has(c.state)) c.state = "running";
        if (!s.children.includes(ev.child)) s.children.push(ev.child);
        provenance.subStart(s, c, ev);
        break;
      }
      case "plan": {
        const plan = normalizePlan(ev);
        if (!plan) break;
        // an older revision (a replayed or reordered line) never replaces a newer plan of the same source
        if (s.plan && s.plan.source === plan.source && plan.rev && s.plan.rev > plan.rev) break;
        s.plan = { ...plan, ts: ev.ts };
        break;
      }
      case "sub_stop": {
        const c = this._s(ev.child, { ...ev, sid: ev.child });
        c.parent = c.parent || ev.sid;
        c.agent = s.agent;
        c.state = ev.status === "completed" || ev.status === "ok" ? "done" : ev.status === "interrupted" ? "stopped" : "failed";
        if (ev.ms !== undefined) c.ms = ev.ms;
        if (ev.summary) c.summary = ev.summary;
        c.curTool = null;
        if (!s.children.includes(ev.child)) s.children.push(ev.child);
        break;
      }
      default:
        break;
    }
  }

  /** Session row for snapshots and `evs` pushes. The full plan stays out (it is in detail() and the `plan` event);
   * `planInfo` says one exists: {source, rev, ts, n, done, active, cur} (cur = the first active item's text). */
  summary(s, now = Date.now() / 1000) {
    const { recent, plan, ...rest } = s;
    return {
      ...rest,
      stale: isStale(s, now) ? true : undefined,
      lastTool: recent.length ? recent[recent.length - 1] : undefined,
      planInfo: plan ? planInfo(plan) : undefined,
    };
  }

  detail(sid) {
    const s = this.sessions.get(sid);
    if (!s) return null;
    return {
      ...s,
      children: s.children.map((c) => this.sessions.get(c)).filter(Boolean).map((c) => this.summary(c)),
    };
  }

  // With a canonical store configured, Hermes events are in-flight display only.
  // External Claude Code transcript rollups remain a separate source.
  rollEntries() {
    return this._entries(this.roll, this.usageRoll);
  }

  _entries(own, usage) {
    if (this.usageRoll === undefined) return Object.entries(own);
    return [...Object.entries(own).filter(([key]) => this.externalAgent && key.split("\t")[1] === this.externalAgent),
      ...Object.entries(usage || {})];
  }

  /** Per-agent live status for the deck sidebar. */
  agents(now = Date.now() / 1000) {
    const today = localDay(now);
    const out = {};
    for (const [profile, p] of Object.entries(this.cfg.profiles)) {
      out[p.name] = { name: p.name, profile, bot: p.bot, emoji: p.emoji, running: 0, subsRunning: 0, lastTs: 0, curTool: null, today: { n: 0, ...ZERO(), usd: 0 } };
    }
    for (const s of this.sessions.values()) {
      const a = out[s.agent];
      if (!a) continue;
      if (s.lastTs > a.lastTs) a.lastTs = s.lastTs;
      if (s.state === "running" && !isStale(s, now)) {
        if (s.parent) a.subsRunning += 1;
        else a.running += 1;
        if (s.curTool && (!a.curTool || s.curTool.since > a.curTool.since)) a.curTool = { ...s.curTool, sid: s.sid };
      }
    }
    for (const [key, r] of this.rollEntries()) {
      const [day, agent] = key.split("\t");
      const a = out[agent] || (out[agent] = { name: agent, profile: r.profile, running: 0, subsRunning: 0, lastTs: 0, curTool: null, today: { n: 0, ...ZERO(), usd: 0 } });
      if (day !== today) continue;
      for (const k of ["n", "in", "cr", "cw", "out", "rs", "usd", "sessions", "estimated_usd", "actual_usd", "equivalent_usd", "unknownCost"]) a.today[k] = (a.today[k] || 0) + (r[k] || 0);
      if (r.estimated) a.today.estimated = true;
      if (r.cost_label) a.today.cost_label = r.cost_label;
      if (r.source) a.today.source = r.source;
    }
    return out;
  }

  snapshot(limit = 300) {
    const sessions = [...this.sessions.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, limit).map((s) => this.summary(s));
    return { agents: this.agents(), sessions };
  }

  tokens(days = 7, now = Date.now() / 1000) {
    const keep = new Set();
    for (let i = 0; i < days; i++) keep.add(localDay(now - i * 86400));
    const rows = [];
    for (const [key, r] of this.rollEntries()) {
      const [day, agent, model] = key.split("\t");
      if (keep.has(day)) rows.push({ day, agent, model, ...r });
    }
    return rows.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.in + b.out - (a.in + a.out)));
  }

  /**
   * Usage for one Token-pane range: {range, bucket, from, to, since, rows:[{t, agent, model, ...counters}]}.
   *   24h      bucket "hour": t = local hour start (epoch s); rows only from 5-minute slots inside [now-24h, now]
   *   7d..30d  bucket "day":  t = "YYYY-MM-DD", the last N local days including today
   *   all      bucket "week" (t = Monday "YYYY-MM-DD") while the data spans <= ~6 months, else "month" ("YYYY-MM")
   * `since` is the start of the oldest data any source holds (epoch s) or null when there is none.
   */
  tokensRange(range, now = Date.now() / 1000) {
    if (!RANGES.includes(range)) throw new Error("bad range");
    const out = new Map();
    const put = (t, agent, model, r) => {
      const key = `${t}\t${agent}\t${model}`;
      if (!out.has(key)) out.set(key, { t, agent, model, profile: r.profile });
      addInto(out.get(key), r);
    };
    const since = this.dataSince();
    let bucket, from;
    if (range === "24h") {
      bucket = "hour";
      from = now - 86400;
      for (const [key, r] of this._entries(this.fine, this.usageFine)) {
        const [slot, agent, model] = key.split("\t");
        // a 5-minute slot counts when it overlaps the window (resolution: 5 minutes at the old edge)
        if (Number(slot) + FINE_S > from && Number(slot) <= now) put(hourStart(Math.max(Number(slot), from)), agent, model, r);
      }
    } else if (range !== "all") {
      bucket = "day";
      const days = Number(range.slice(0, -1));
      const keep = new Set();
      for (let i = 0; i < days; i++) keep.add(localDay(now - i * 86400));
      from = dayStart(localDay(now - (days - 1) * 86400));
      for (const [key, r] of this.rollEntries()) {
        const [day, agent, model] = key.split("\t");
        if (keep.has(day)) put(day, agent, model, r);
      }
    } else {
      from = since;
      bucket = since !== null && now - since > WEEKS_UP_TO_S ? "month" : "week";
      for (const [key, r] of this.rollEntries()) {
        const [day, agent, model] = key.split("\t");
        put(bucket === "week" ? weekOf(day) : day.slice(0, 7), agent, model, r);
      }
      for (const [key, r] of this._entries(this.months, this.usageMonths)) {
        const [month, agent, model] = key.split("\t");
        put(month, agent, model, r);
      }
    }
    const rows = [...out.values()].sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : b.in + b.out - (a.in + a.out)));
    return { range, bucket, from, to: now, since, rows };
  }

  /** Start of the oldest usage any source holds (epoch s), or null. */
  dataSince() {
    // state.db reports its exact oldest session start; the relay's own event rollups only know their day/month
    let since = typeof this.usageSince === "number" ? this.usageSince : null;
    const older = ts => { if (Number.isFinite(ts) && (since === null || ts < since)) since = ts; };
    const own = this.usageRoll === undefined ? () => true : key => this.externalAgent && key.split("\t")[1] === this.externalAgent;
    for (const key of Object.keys(this.roll)) if (own(key)) older(dayStart(key.split("\t")[0]));
    for (const key of Object.keys(this.months)) if (own(key)) older(dayStart(`${key.split("\t")[0]}-01`));
    return since;
  }

  /** Drop finished sessions idle for 24h (children go with their parent); fold day rollups older than 400 days into months. */
  prune(now = Date.now()) {
    const cutoff = now / 1000 - KEEP_MS / 1000;
    for (const [sid, s] of this.sessions) {
      if (s.lastTs < cutoff && s.state !== "running" && !s.parent) {
        for (const c of s.children) this.sessions.delete(c);
        this.sessions.delete(sid);
      }
    }
    for (const [sid, s] of this.sessions) {
      if (s.parent && !this.sessions.has(s.parent) && s.lastTs < cutoff) this.sessions.delete(sid);
    }
    const oldest = localDay(now / 1000 - KEEP_DAYS * 86400);
    for (const [key, r] of Object.entries(this.roll)) {
      const [day, ...rest] = key.split("\t");
      if (day >= oldest) continue;
      const monthKey = [day.slice(0, 7), ...rest].join("\t");
      this.months[monthKey] = addInto(this.months[monthKey] || { n: 0, ...ZERO(), usd: 0 }, r);
      delete this.roll[key];
    }
    const fineCutoff = now / 1000 - FINE_KEEP_S;
    for (const key of Object.keys(this.fine)) if (Number(key.split("\t")[0]) < fineCutoff) delete this.fine[key];
  }
}

module.exports = { Model, RANGES, addInto, weekOf, hourStart, FINE_S, FINE_KEEP_S, KEEP_DAYS };
