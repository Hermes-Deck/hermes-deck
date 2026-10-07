"use strict";
const fs = require("fs");
const path = require("path");
const { Tailer } = require("./tailer");
const { clip, textOf, normUsage, readJson } = require("./util");

const OPEN_SUB_STATUSES = new Set(["async_launched", "running", "pending", "started", "queued"]);
const MAX_REQ_MEMO = 400;

/**
 * Turns Claude Code transcript lines (interactive sessions or a bot bridge running `claude -p`) into the
 * same event shape the Hermes deck-events plugin writes: turn_start/turn_end, llm (usage deltas),
 * tool_start/tool_end, sub_start/sub_stop, plus `cost` (cumulative USD from cost-state lines).
 *
 * Transcript facts this relies on (Claude Code 2026-10):
 * - one JSONL per session: <project>/<sessionId>.jsonl
 * - sub-agents (Agent tool, forked Skills): <project>/<sessionId>/subagents/agent-<agentId>.jsonl
 *   (+ .meta.json with agentType); their lines carry the parent sessionId, isSidechain and agentId
 * - an API response is split into one line per content block, all with the same requestId and usage,
 *   so usage is counted as per-request deltas (never double counted, growth still captured)
 * - the parent's tool_result for a sub-agent carries toolUseResult.agentId (+ status/success)
 */
class ClaudeNormalizer {
  constructor({ profile = "claude-code", chatOf = () => ({}) } = {}) {
    this.profile = profile;
    this.chatOf = chatOf;
    this.per = new Map(); // event sid -> {tools: Map, counted: Map}
    this.started = new Set(); // child sids that got sub_start
    this.stopped = new Set(); // child sids that got sub_stop
    this.lastTs = new Map(); // main sid -> last timestamp seen (cost-state lines carry none)
  }

  _st(sid) {
    let s = this.per.get(sid);
    if (!s) {
      s = { tools: new Map(), counted: new Map() };
      this.per.set(sid, s);
    }
    return s;
  }

  /**
   * @param {object} r transcript line
   * @param {{agentId?: string, role?: string}} meta set for sub-agent files
   * @returns {object[]} normalized events
   */
  handle(r, meta = {}) {
    const main = r && r.sessionId;
    if (!main) return [];
    let ts = r.timestamp ? Date.parse(r.timestamp) / 1000 : NaN;
    if (isFinite(ts)) this.lastTs.set(main, ts);
    else ts = this.lastTs.get(main) || Date.now() / 1000;
    const child = meta.agentId ? `${main}/${meta.agentId}` : null;
    const sid = child || main;
    const base = { ts, profile: this.profile, sid, ...this.chatOf(main) };
    const out = [];

    if (r.type === "user") {
      const c = r.message && r.message.content;
      if (typeof c === "string" || (Array.isArray(c) && c.some((b) => b && b.type === "text") && !c.some((b) => b && b.type === "tool_result"))) {
        const text = typeof c === "string" ? c : textOf(c);
        if (child && !this.started.has(child)) {
          this.started.add(child);
          out.push({ ...base, sid: main, ev: "sub_start", child, sa: meta.agentId, role: meta.role, goal: clip(text) });
          out.push({ ...base, ev: "turn_start", msg: clip(text), first: true });
        } else if (!r.isMeta) {
          out.push({ ...base, ev: "turn_start", msg: clip(text) });
        }
      } else if (Array.isArray(c)) {
        const st = this._st(sid);
        for (const b of c) {
          if (!b || b.type !== "tool_result") continue;
          const t = st.tools.get(b.tool_use_id);
          st.tools.delete(b.tool_use_id);
          const err = b.is_error === true;
          out.push({
            ...base,
            ev: "tool_end",
            tool: t && t.tool,
            call: b.tool_use_id,
            ms: t ? Math.max(0, Math.round((ts - t.ts) * 1000)) : undefined,
            status: err ? "error" : "ok",
            result: clip(textOf(b.content)),
          });
          const tur = r.toolUseResult;
          if (tur && typeof tur === "object" && tur.agentId) {
            const kid = `${main}/${tur.agentId}`;
            if (!OPEN_SUB_STATUSES.has(String(tur.status || "")) && !this.stopped.has(kid)) {
              this.stopped.add(kid);
              out.push({
                ...base,
                ev: "sub_stop",
                child: kid,
                status: err || tur.success === false ? "failed" : "completed",
                summary: clip(textOf(tur.result)),
              });
            }
          }
        }
      }
    } else if (r.type === "assistant") {
      const m = r.message || {};
      const st = this._st(sid);
      const u = normUsage(m.usage);
      const rid = r.requestId || m.id;
      if (u && rid) {
        const seen = st.counted.get(rid);
        const prev = seen || { in: 0, cr: 0, cw: 0, out: 0, rs: 0 };
        const delta = {};
        let any = false;
        for (const k of Object.keys(prev)) {
          const d = (u[k] || 0) - prev[k];
          if (d > 0) {
            delta[k] = d;
            prev[k] = u[k];
            any = true;
          }
        }
        if (!seen) {
          st.counted.set(rid, prev);
          if (st.counted.size > MAX_REQ_MEMO) st.counted.delete(st.counted.keys().next().value);
        }
        if (any) out.push({ ...base, ev: "llm", model: m.model, usage: delta, cont: seen ? true : undefined });
      }
      for (const b of m.content || []) {
        if (b && b.type === "tool_use") {
          st.tools.set(b.id, { tool: b.name, ts });
          out.push({ ...base, ev: "tool_start", tool: b.name, call: b.id, args: clip(b.input) });
        }
      }
      if (m.stop_reason === "end_turn") {
        out.push({ ...base, ev: "turn_end", model: m.model });
        if (child && !this.stopped.has(child)) {
          this.stopped.add(child);
          out.push({ ...base, sid: main, ev: "sub_stop", child, status: "completed" });
        }
      }
    } else if (r.type === "cost-state" && !child) {
      const usd = Number(r.totalCostUSD);
      if (isFinite(usd)) out.push({ ...base, ev: "cost", usd });
    }
    return out;
  }
}

/**
 * Watches Claude Code project dirs (~/.claude/projects/<encoded cwd>) and feeds new transcript lines
 * through the normalizer.
 * Only files modified within `recentHours` are tailed; idle tailers are parked (checkpoint kept).
 */
class ClaudeSource {
  constructor({ dirs, profile = "claude-code", chatMapFile = null, checkpoints = {}, onEvent, recentHours = 24, warmBytes = 512 * 1024 }) {
    this.dirs = dirs;
    this.chatMapFile = chatMapFile;
    this.checkpoints = checkpoints;
    this.onEvent = onEvent;
    this.recentMs = recentHours * 3600 * 1000;
    this.warmBytes = warmBytes;
    this.tailers = new Map(); // file -> Tailer
    this.parked = new Map(); // file -> mtimeMs when parked; re-added only if it changes again
    this.chatBySession = new Map();
    this.norm = new ClaudeNormalizer({ profile, chatOf: (sid) => this.chatBySession.get(sid) || {} });
  }

  /**
   * Optional: map sessions to Telegram chats from a bridge's state file shaped like
   * {chats: {"<chatId>[:<threadId>]": {session: "<claude session id>"}}}.
   */
  refreshChats() {
    if (!this.chatMapFile) return;
    const st = readJson(this.chatMapFile, null);
    if (!st || typeof st.chats !== "object") return;
    const m = new Map();
    for (const [key, v] of Object.entries(st.chats)) {
      if (!v || typeof v.session !== "string") continue;
      const [chat, rawThread] = key.split(":");
      const thread = rawThread && rawThread.replace(/^t/, "");
      m.set(v.session, thread ? { chat, thread } : { chat });
    }
    this.chatBySession = m;
  }

  scan() {
    const now = Date.now();
    for (const dir of this.dirs) {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(dir, name);
        if (!this._recent(file, now)) continue;
        this._ensure(file, {});
        const subDir = path.join(dir, name.slice(0, -6), "subagents");
        let subs;
        try {
          subs = fs.readdirSync(subDir);
        } catch {
          continue;
        }
        for (const s of subs) {
          const m = /^agent-([A-Za-z0-9]+)\.jsonl$/.exec(s);
          if (!m) continue;
          const sf = path.join(subDir, s);
          if (!this._recent(sf, now)) continue;
          const metaFile = path.join(subDir, `agent-${m[1]}.meta.json`);
          const meta = readJson(metaFile, {}) || {};
          this._ensure(sf, { agentId: m[1], role: meta.agentType });
        }
      }
    }
  }

  _recent(file, now) {
    if (this.tailers.has(file)) return true;
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return false;
    }
    const parkedAt = this.parked.get(file);
    if (parkedAt !== undefined) {
      if (mtime <= parkedAt) return false;
      this.parked.delete(file);
      return true;
    }
    return now - mtime < this.recentMs;
  }

  _ensure(file, meta) {
    if (this.tailers.has(file)) return;
    const t = new Tailer(
      file,
      (line, live) => {
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          return;
        }
        for (const ev of this.norm.handle(r, meta)) this.onEvent(ev, live);
      },
      { checkpoint: this.checkpoints[file] || null, warmBytes: this.warmBytes }
    );
    this.tailers.set(file, t);
  }

  poll() {
    let n = 0;
    for (const t of this.tailers.values()) n += t.poll();
    // Park files idle for 2h (they are re-added by scan() if they change again).
    const cutoff = Date.now() - 2 * 3600 * 1000;
    for (const [file, t] of this.tailers) {
      if (t.lastGrowth < cutoff) {
        const cp = t.checkpoint();
        if (cp) this.checkpoints[file] = cp;
        try {
          this.parked.set(file, fs.statSync(file).mtimeMs);
        } catch {
          /* deleted: nothing to park */
        }
        this.tailers.delete(file);
      }
    }
    return n;
  }

  checkpointAll() {
    for (const [file, t] of this.tailers) {
      const cp = t.checkpoint();
      if (cp) this.checkpoints[file] = cp;
    }
    return this.checkpoints;
  }
}

module.exports = { ClaudeNormalizer, ClaudeSource };
