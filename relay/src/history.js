"use strict";
const fs = require("fs");
const path = require("path");
const { redact, normUsage } = require("./util");

/**
 * Message history of one session, read on demand for the deck's sub-agent views (B1, B3):
 *   GET /session/<sid>/messages?before=<cursor>&limit=50   the newest page (oldest first) + `next` to page back
 *   GET /session/<sid>/call/<callId>                         one tool call: full args and result
 *   GET /message/<id>/full                                   one message with every field (up to 256 KB each)
 *
 * Item shape (both sources): {id, role: user|assistant|tool, ts, text?, think?, calls?: [{call, name, args}],
 * call?, name?, status?, child?, truncated?}. Pages clip each field to FIELD chars and set `truncated`.
 * Text is redacted with the same secret patterns as the live previews.
 *
 * Sources:
 * - Hermes: the profile's state.db (~/.hermes/state.db, ~/.hermes/profiles/<p>/state.db), opened read-only
 *   (node:sqlite, readOnly + PRAGMA query_only) and only through indexed lookups, so a multi-GB store
 *   answers in milliseconds. Sub-agents are ordinary sessions there (source "subagent", parent_session_id).
 * - Claude Code (Dispatch): the session's JSONL transcript; sub-agent sidechains live in
 *   <sessionId>/subagents/agent-<agentId>.jsonl. A per-file line index (byte ranges) is built once and
 *   extended as the file grows, so paging never re-parses the whole transcript.
 */

const FIELD = 4096;
const FULL = 256 * 1024;
const PAGE = 50;
const MAX_PAGE = 200;
const MARGIN = 256; // read a little past a cut so redaction never sees half a secret
const IDLE_CLOSE_MS = 5 * 60 * 1000;
const MAX_INDEXES = 16;

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HERMES_SID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CLAUDE_SID_RE = /^([0-9A-Fa-f][0-9A-Fa-f-]{7,63})(?:\/([A-Za-z0-9]{1,64}))?$/;
const CALL_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const HERMES_ID_RE = /^h:([A-Za-z0-9][A-Za-z0-9_-]{0,63}):(\d{1,15})$/;
const CLAUDE_ID_RE = /^c:([0-9A-Fa-f][0-9A-Fa-f-]{7,63}(?:\/[A-Za-z0-9]{1,64})?):(\d{1,15})(?:\.(\d{1,4}))?$/;

class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Redact, then clip to `n` chars. `len` is the original length when the caller read only a prefix. */
function put(item, key, value, n, len) {
  if (value === undefined || value === null || value === "") return;
  let s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined) return;
  s = redact(s);
  const total = typeof len === "number" ? len : s.length;
  if (s.length > n || total > n) {
    item[key] = s.slice(0, n);
    item.truncated = true;
  } else item[key] = s;
}

/** Same for one entry of item.calls; a clipped call marks the whole item `truncated` too. */
function callOf(item, call, name, args, n, len) {
  const c = { call: call || undefined, name: name || undefined };
  put(c, "args", args, n, len);
  if (c.truncated) item.truncated = true;
  return c;
}

const blocks = (content) => (Array.isArray(content) ? content : []);

/** Flatten Claude message content blocks (string | blocks[]) to text; images and documents become a marker. */
function blocksText(content) {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((b) => {
      if (typeof b === "string") return b;
      if (!b) return "";
      if (b.type === "text") return b.text || "";
      if (b.type === "image") return "[image]";
      if (b.type === "document") return "[document]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

// ------------------------------------------------------------------------------------------- Hermes

let sqliteMod; // undefined = not tried, null = unavailable
function loadSqlite() {
  if (sqliteMod === undefined) {
    try {
      sqliteMod = require("node:sqlite");
    } catch {
      sqliteMod = null;
    }
  }
  return sqliteMod;
}

class HermesStore {
  constructor(root) {
    this.root = root || null;
    this.dbs = new Map(); // profile -> {db, msgCols, sesCols, stmts, used}
    this.profilesAt = 0;
    this.profileList = [];
  }

  dbPath(profile) {
    return profile === "default" ? path.join(this.root, "state.db") : path.join(this.root, "profiles", profile, "state.db");
  }

  /** Profiles that have a state.db, default first (cached for a minute). */
  profiles() {
    if (!this.root) return [];
    if (Date.now() - this.profilesAt < 60_000) return this.profileList;
    const out = [];
    if (fs.existsSync(this.dbPath("default"))) out.push("default");
    let names = [];
    try {
      names = fs.readdirSync(path.join(this.root, "profiles"));
    } catch {
      /* no named profiles */
    }
    for (const n of names.sort()) if (PROFILE_RE.test(n) && fs.existsSync(this.dbPath(n))) out.push(n);
    this.profileList = out;
    this.profilesAt = Date.now();
    return out;
  }

  open(profile) {
    let h = this.dbs.get(profile);
    if (h) {
      h.used = Date.now();
      return h;
    }
    const sqlite = loadSqlite();
    if (!sqlite) throw new HttpError(501, "history needs Node 22.13+ (node:sqlite) on the relay host");
    if (!this.root || !PROFILE_RE.test(profile)) throw new HttpError(404, "unknown profile");
    const file = this.dbPath(profile);
    if (!fs.existsSync(file)) throw new HttpError(404, "no state.db for this profile");
    const db = new sqlite.DatabaseSync(file, { readOnly: true, timeout: 2000 });
    db.exec("PRAGMA query_only = ON"); // belt and braces: this connection can never write
    const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name));
    h = { db, msgCols: cols("messages"), sesCols: cols("sessions"), stmts: new Map(), used: Date.now() };
    this.dbs.set(profile, h);
    return h;
  }

  stmt(h, sql) {
    let s = h.stmts.get(sql);
    if (!s) {
      s = h.db.prepare(sql);
      h.stmts.set(sql, s);
    }
    return s;
  }

  /** Which profile's store holds this session: the hint first, then every profile. */
  find(sid, hint) {
    const order = [...new Set([hint, ...this.profiles()].filter((p) => p && PROFILE_RE.test(p)))];
    for (const p of order) {
      let h;
      try {
        h = this.open(p);
      } catch (e) {
        if (e.code === 501) throw e;
        continue;
      }
      if (this.stmt(h, "SELECT 1 AS x FROM sessions WHERE id = ?").get(sid)) return p;
    }
    return null;
  }

  _activeSql(h) {
    // `active = 0` rows are Undo/Rewind leftovers: not part of the conversation any more
    return h.msgCols.has("active") ? " AND active = 1" : "";
  }

  meta(profile, sid) {
    const h = this.open(profile);
    const want = ["id", "source", "model", "parent_session_id", "started_at", "ended_at", "end_reason", "message_count", "tool_call_count",
      "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "estimated_cost_usd",
      "actual_cost_usd", "cost_status", "title"].filter((c) => h.sesCols.has(c));
    const r = this.stmt(h, `SELECT ${want.join(", ")} FROM sessions WHERE id = ?`).get(sid);
    if (!r) return null;
    const meta = {
      kind: "hermes",
      profile,
      source: r.source || undefined,
      model: r.model || undefined,
      parent: r.parent_session_id || undefined,
      title: r.title || undefined,
      startedAt: r.started_at || undefined,
      endedAt: r.ended_at || undefined,
      endReason: r.end_reason || undefined,
      msgs: r.message_count || 0,
      tools: r.tool_call_count || 0,
      tokens: { in: r.input_tokens || 0, cr: r.cache_read_tokens || 0, cw: r.cache_write_tokens || 0, out: r.output_tokens || 0, rs: r.reasoning_tokens || 0 },
    };
    // A price only when Hermes actually knows one (cost_status "unknown"/"included" means it does not).
    const known = r.cost_status && !/^(unknown|included|none)$/i.test(r.cost_status);
    if (r.actual_cost_usd > 0) meta.cost = r.actual_cost_usd;
    else if (known && r.estimated_cost_usd > 0) meta.cost = r.estimated_cost_usd;
    if (h.sesCols.has("parent_session_id")) {
      const kids = this.stmt(h, "SELECT id, source, model, started_at, ended_at, end_reason FROM sessions WHERE parent_session_id = ? ORDER BY started_at LIMIT 200").all(sid);
      const subs = kids.filter((k) => k.source === "subagent");
      if (subs.length) meta.kids = subs.map((k) => ({ sid: k.id, model: k.model || undefined, startedAt: k.started_at, endedAt: k.ended_at || undefined, endReason: k.end_reason || undefined }));
      // a compression continuation: the conversation goes on in a new session id
      const cont = kids.find((k) => k.source !== "subagent");
      if (cont && r.end_reason === "compression") meta.continuedIn = cont.id;
    }
    return meta;
  }

  _rowSql(h, n) {
    const think = h.msgCols.has("reasoning") ? `substr(reasoning, 1, ${n}) AS reasoning, length(reasoning) AS rlen` : "NULL AS reasoning, 0 AS rlen";
    return `SELECT id, role, substr(content, 1, ${n}) AS content, length(content) AS clen, tool_call_id, tool_name, timestamp, ${think}, (tool_calls IS NOT NULL) AS has_calls FROM messages`;
  }

  _callsSql(n) {
    const args = "COALESCE(json_extract(j.value, '$.function.arguments'), json_extract(j.value, '$.input'), json_extract(j.value, '$.arguments'))";
    return (
      `SELECT m.id AS mid, COALESCE(json_extract(j.value, '$.id'), json_extract(j.value, '$.call_id')) AS call, ` +
      `COALESCE(json_extract(j.value, '$.function.name'), json_extract(j.value, '$.name')) AS name, ` +
      `substr(${args}, 1, ${n}) AS args, length(${args}) AS alen ` +
      `FROM messages m, json_each(m.tool_calls) j `
    );
  }

  _item(profile, r, n, calls) {
    const it = { id: `h:${profile}:${r.id}`, role: r.role, ts: r.timestamp };
    put(it, "text", r.content, n, r.clen);
    if (r.role === "tool") {
      if (r.tool_call_id) it.call = r.tool_call_id;
      if (r.tool_name) it.name = r.tool_name;
    }
    if (r.reasoning) put(it, "think", r.reasoning, n, r.rlen);
    if (calls && calls.length) it.calls = calls.map((c) => callOf(it, c.call, c.name, c.args, n, c.alen));
    return it;
  }

  page(profile, sid, before, limit) {
    const h = this.open(profile);
    const n = FIELD + MARGIN;
    const rows = this.stmt(h, `${this._rowSql(h, n)} WHERE session_id = ?${this._activeSql(h)} AND id < ? ORDER BY id DESC LIMIT ?`).all(sid, before, limit + 1);
    const more = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    const byMsg = new Map();
    if (page.some((r) => r.has_calls)) {
      const lo = page[0].id;
      const hi = page[page.length - 1].id;
      const sql = `${this._callsSql(n)}WHERE m.session_id = ? AND m.id BETWEEN ? AND ? AND m.tool_calls IS NOT NULL AND json_valid(m.tool_calls) AND json_type(m.tool_calls) = 'array' ORDER BY m.id, CAST(j.key AS INTEGER)`;
      for (const c of this.stmt(h, sql).all(sid, lo, hi)) {
        if (!byMsg.has(c.mid)) byMsg.set(c.mid, []);
        byMsg.get(c.mid).push(c);
      }
    }
    return {
      items: page.map((r) => this._item(profile, r, FIELD, byMsg.get(r.id))),
      next: more && page.length ? String(page[0].id) : null,
    };
  }

  full(profile, rowid) {
    const h = this.open(profile);
    const n = FULL + MARGIN;
    const r = this.stmt(h, `${this._rowSql(h, n)} WHERE id = ?`).get(rowid);
    if (!r) return null;
    const calls = r.has_calls ? this.stmt(h, `${this._callsSql(n)}WHERE m.id = ? AND json_valid(m.tool_calls) AND json_type(m.tool_calls) = 'array' ORDER BY CAST(j.key AS INTEGER)`).all(rowid) : [];
    return this._item(profile, r, FULL, calls);
  }

  call(profile, sid, callId) {
    const h = this.open(profile);
    const n = FULL + MARGIN;
    const act = this._activeSql(h);
    const mact = act ? " AND m.active = 1" : "";
    // instr() narrows to the one assistant row that mentions the id before json_each unpacks it
    const asked = this.stmt(
      h,
      `${this._callsSql(n)}WHERE m.session_id = ?${mact} AND m.role = 'assistant' AND m.tool_calls IS NOT NULL AND instr(m.tool_calls, ?) > 0 AND json_valid(m.tool_calls) AND json_type(m.tool_calls) = 'array' ` +
        `AND COALESCE(json_extract(j.value, '$.id'), json_extract(j.value, '$.call_id')) = ? ORDER BY m.id DESC LIMIT 1`
    ).get(sid, callId, callId);
    const res = this.stmt(h, `${this._rowSql(h, n)} WHERE session_id = ?${act} AND tool_call_id = ? ORDER BY id DESC LIMIT 1`).get(sid, callId);
    if (!asked && !res) return null;
    const out = { call: callId, name: (asked && asked.name) || (res && res.tool_name) || undefined };
    if (asked) {
      out.argsId = `h:${profile}:${asked.mid}`;
      put(out, "args", asked.args, FULL, asked.alen);
    }
    if (res) {
      out.resultId = `h:${profile}:${res.id}`;
      out.ts = res.timestamp;
      put(out, "result", res.content, FULL, res.clen);
    }
    return out;
  }

  sweep(now = Date.now()) {
    for (const [p, h] of this.dbs) {
      if (now - h.used < IDLE_CLOSE_MS) continue;
      try {
        h.db.close();
      } catch {
        /* already closed */
      }
      this.dbs.delete(p);
    }
  }

  close() {
    this.sweep(Infinity);
  }
}

// ------------------------------------------------------------------------------------------- Claude Code

/**
 * Index entries: {k: "u"|"a"|"t", start, end, ts, b?, mid?, calls?, call?}. `start`/`end` are the byte range
 * of the entry's lines; an assistant response written as one line per content block becomes one entry.
 */
class TranscriptStore {
  constructor(dirs) {
    this.dirs = (dirs || []).filter(Boolean);
    this.cache = new Map(); // file -> index (LRU)
  }

  /** sid -> {file, main, agent} for an existing transcript, else null. */
  locate(sid) {
    const m = CLAUDE_SID_RE.exec(sid);
    if (!m) return null;
    const [, main, agent] = m;
    for (const dir of this.dirs) {
      const file = agent ? path.join(dir, main, "subagents", `agent-${agent}.jsonl`) : path.join(dir, `${main}.jsonl`);
      if (fs.existsSync(file)) return { file, main, agent: agent || null, dir };
    }
    return null;
  }

  index(loc) {
    const { file } = loc;
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      throw new HttpError(404, "transcript gone");
    }
    let idx = this.cache.get(file);
    if (idx && (idx.ino !== st.ino || st.size < idx.scanned)) idx = null; // rotated or rewritten
    if (!idx) {
      idx = { ino: st.ino, scanned: 0, items: [], names: new Map(), usage: new Map(), model: undefined, firstTs: undefined, lastTs: 0, sub: !!loc.agent };
      if (loc.agent) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(loc.dir, loc.main, "subagents", `agent-${loc.agent}.meta.json`), "utf8"));
          if (meta && typeof meta.agentType === "string") idx.role = meta.agentType;
        } catch {
          /* no meta file */
        }
      }
    }
    if (st.size > idx.scanned) this._extend(idx, file, st.size);
    this.cache.delete(file);
    this.cache.set(file, idx);
    while (this.cache.size > MAX_INDEXES) this.cache.delete(this.cache.keys().next().value);
    return idx;
  }

  _extend(idx, file, size) {
    const fd = fs.openSync(file, "r");
    try {
      let pos = idx.scanned;
      let carry = Buffer.alloc(0);
      let carryStart = pos;
      while (pos < size) {
        const len = Math.min(1 << 20, size - pos);
        const chunk = Buffer.allocUnsafe(len);
        const got = fs.readSync(fd, chunk, 0, len, pos);
        if (got <= 0) break;
        pos += got;
        const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, got)]) : chunk.subarray(0, got);
        let s = 0;
        let nl;
        while ((nl = data.indexOf(0x0a, s)) !== -1) {
          this._line(idx, data.toString("utf8", s, nl), carryStart + s, carryStart + nl + 1);
          s = nl + 1;
        }
        carry = Buffer.from(data.subarray(s));
        carryStart += s;
      }
      idx.scanned = carryStart; // a partial last line waits for its newline
    } finally {
      fs.closeSync(fd);
    }
  }

  _line(idx, text, start, end) {
    let r;
    try {
      r = JSON.parse(text);
    } catch {
      return;
    }
    if (!r || typeof r !== "object") return;
    if (!idx.sub && r.isSidechain === true) return; // old transcripts kept sidechains inline
    const parsed = r.timestamp ? Date.parse(r.timestamp) / 1000 : NaN;
    const ts = isFinite(parsed) ? parsed : idx.lastTs;
    if (isFinite(parsed)) {
      idx.lastTs = parsed;
      if (idx.firstTs === undefined) idx.firstTs = parsed;
    }
    const items = idx.items;
    if (r.type === "assistant") {
      const m = r.message || {};
      const mid = m.id || r.requestId || r.uuid || String(start);
      if (m.model && m.model !== "<synthetic>") idx.model = m.model;
      const u = normUsage(m.usage);
      if (u) {
        // one response repeats its usage on every block line: keep the largest per response
        const prev = idx.usage.get(mid) || { in: 0, cr: 0, cw: 0, out: 0, rs: 0 };
        for (const k of Object.keys(prev)) prev[k] = Math.max(prev[k], u[k] || 0);
        idx.usage.set(mid, prev);
      }
      const calls = [];
      for (const b of blocks(m.content)) {
        if (b && b.type === "tool_use" && b.id) {
          calls.push(b.id);
          idx.names.set(b.id, b.name);
        }
      }
      const last = items[items.length - 1];
      if (last && last.k === "a" && last.mid === mid) {
        last.end = end;
        last.calls.push(...calls);
      } else items.push({ k: "a", start, end, ts, mid, calls });
    } else if (r.type === "user") {
      const c = r.message && r.message.content;
      if (Array.isArray(c) && c.some((b) => b && b.type === "tool_result")) {
        c.forEach((b, i) => {
          if (b && b.type === "tool_result") items.push({ k: "t", start, end, ts, b: i, call: b.tool_use_id });
        });
      } else if (!r.isMeta && (typeof c === "string" || Array.isArray(c))) {
        items.push({ k: "u", start, end, ts });
      }
    }
  }

  _read(file, start, end) {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.allocUnsafe(end - start);
      const got = fs.readSync(fd, buf, 0, end - start, start);
      return buf
        .toString("utf8", 0, got)
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }
  }

  _item(sid, loc, idx, e, n) {
    const lines = this._read(loc.file, e.start, e.end);
    const it = { id: `c:${sid}:${e.start}${e.k === "t" ? `.${e.b}` : ""}`, ts: e.ts };
    if (e.k === "u") {
      it.role = "user";
      put(it, "text", blocksText(lines[0] && lines[0].message && lines[0].message.content), n);
    } else if (e.k === "a") {
      it.role = "assistant";
      const text = [];
      const think = [];
      const calls = [];
      for (const r of lines) {
        const m = r.message || {};
        if (m.model && m.model !== "<synthetic>") it.model = m.model;
        if (typeof m.content === "string") text.push(m.content);
        for (const b of blocks(m.content)) {
          if (!b) continue;
          if (b.type === "text" && b.text) text.push(b.text);
          else if (b.type === "thinking" && b.thinking) think.push(b.thinking);
          else if (b.type === "tool_use") calls.push(b);
        }
      }
      put(it, "text", text.join("\n\n"), n);
      put(it, "think", think.join("\n\n"), n);
      if (calls.length) it.calls = calls.map((b) => callOf(it, b.id, b.name, b.input === undefined ? undefined : JSON.stringify(b.input, null, 2), n));
    } else {
      it.role = "tool";
      const r = lines[0] || {};
      const all = blocks(r.message && r.message.content);
      const b = all[e.b] || {};
      it.call = b.tool_use_id;
      it.name = idx.names.get(b.tool_use_id);
      if (b.is_error === true) it.status = "error";
      put(it, "text", blocksText(b.content), n);
      const tur = r.toolUseResult;
      const nResults = all.filter((x) => x && x.type === "tool_result").length;
      if (tur && typeof tur === "object" && tur.agentId && nResults === 1 && /^[A-Za-z0-9]{1,64}$/.test(tur.agentId)) it.child = `${loc.main}/${tur.agentId}`;
    }
    return it;
  }

  meta(sid, loc, idx) {
    const tokens = { in: 0, cr: 0, cw: 0, out: 0, rs: 0 };
    for (const u of idx.usage.values()) for (const k of Object.keys(tokens)) tokens[k] += u[k] || 0;
    return {
      kind: "claude",
      model: idx.model,
      parent: loc.agent ? loc.main : undefined,
      role: idx.role,
      startedAt: idx.firstTs,
      msgs: idx.items.length,
      tools: idx.names.size,
      tokens,
    };
  }

  page(sid, loc, before, limit) {
    const idx = this.index(loc);
    const items = idx.items;
    // first entry at or after the cursor (entries are in file order)
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid].start < before) lo = mid + 1;
      else hi = mid;
    }
    const from = Math.max(0, lo - limit);
    const slice = items.slice(from, lo);
    return {
      meta: this.meta(sid, loc, idx),
      items: slice.map((e) => this._item(sid, loc, idx, e, FIELD)),
      next: from > 0 && slice.length ? String(slice[0].start) : null,
    };
  }

  full(sid, loc, start, b) {
    const idx = this.index(loc);
    const e = idx.items.find((x) => x.start === start && (x.k !== "t" || x.b === b));
    return e ? this._item(sid, loc, idx, e, FULL) : null;
  }

  call(sid, loc, callId) {
    const idx = this.index(loc);
    let asked = null;
    let res = null;
    for (let i = idx.items.length - 1; i >= 0 && !(asked && res); i--) {
      const e = idx.items[i];
      if (!res && e.k === "t" && e.call === callId) res = e;
      if (!asked && e.k === "a" && e.calls.includes(callId)) asked = e;
    }
    if (!asked && !res) return null;
    const out = { call: callId, name: idx.names.get(callId) };
    if (asked) {
      const a = this._item(sid, loc, idx, asked, FULL);
      const c = (a.calls || []).find((x) => x.call === callId) || {};
      out.argsId = a.id;
      if (c.args !== undefined) out.args = c.args;
      if (c.truncated) out.truncated = true;
    }
    if (res) {
      const t = this._item(sid, loc, idx, res, FULL);
      out.resultId = t.id;
      out.ts = t.ts;
      if (t.text !== undefined) out.result = t.text;
      if (t.status) out.status = t.status;
      if (t.child) out.child = t.child;
      if (t.truncated) out.truncated = true;
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------- routes

class History {
  /**
   * @param {{model?: object, hermesRoot?: string|null, claudeDirs?: string[], claudeProfile?: string}} opts
   * `model` (the live Model) tells which profile a session belongs to; unknown ids are probed.
   */
  constructor({ model = null, hermesRoot = null, claudeDirs = [], claudeProfile = "claude-code" } = {}) {
    this.model = model;
    this.claudeProfile = claudeProfile;
    this.hermes = new HermesStore(hermesRoot);
    this.claude = new TranscriptStore(claudeDirs);
    this.timer = setInterval(() => this.hermes.sweep(), 60_000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.hermes.close();
  }

  /** {kind: "claude", loc} | {kind: "hermes", profile} for a session id; throws 404 when nobody has it. */
  resolve(sid) {
    const live = this.model && this.model.sessions ? this.model.sessions.get(sid) : null;
    if (!live || live.profile === this.claudeProfile) {
      const loc = this.claude.locate(sid);
      if (loc) return { kind: "claude", loc };
      if (live) throw new HttpError(404, "transcript not found");
    }
    if (!HERMES_SID_RE.test(sid)) throw new HttpError(400, "bad session id");
    const profile = this.hermes.find(sid, live && live.profile);
    if (!profile) throw new HttpError(404, "session not found");
    return { kind: "hermes", profile };
  }

  messages(sid, q) {
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(q.get("limit")) || PAGE));
    const rawBefore = q.get("before");
    if (rawBefore !== null && !/^\d{1,15}$/.test(rawBefore)) throw new HttpError(400, "bad cursor");
    const before = rawBefore === null ? Number.MAX_SAFE_INTEGER : Number(rawBefore);
    const src = this.resolve(sid);
    if (src.kind === "claude") return { sid, ...this.claude.page(sid, src.loc, before, limit) };
    const meta = this.hermes.meta(src.profile, sid);
    return { sid, meta, ...this.hermes.page(src.profile, sid, before, limit) };
  }

  full(id) {
    let m = HERMES_ID_RE.exec(id);
    if (m) return this.hermes.full(m[1], Number(m[2]));
    m = CLAUDE_ID_RE.exec(id);
    if (!m) throw new HttpError(400, "bad message id");
    const loc = this.claude.locate(m[1]);
    if (!loc) return null;
    return this.claude.full(m[1], loc, Number(m[2]), m[3] === undefined ? undefined : Number(m[3]));
  }

  call(sid, callId) {
    if (!CALL_RE.test(callId)) throw new HttpError(400, "bad call id");
    const src = this.resolve(sid);
    return src.kind === "claude" ? this.claude.call(sid, src.loc, callId) : this.hermes.call(src.profile, sid, callId);
  }

  /** Route a GET; null when the path is not a history route. Never throws. */
  handle(url) {
    const p = url.pathname;
    const dec = (s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        throw new HttpError(400, "bad path");
      }
    };
    try {
      let m = /^\/session\/([^/]+)\/messages$/.exec(p);
      if (m) return { code: 200, body: this.messages(dec(m[1]), url.searchParams) };
      m = /^\/session\/([^/]+)\/call\/([^/]+)$/.exec(p);
      if (m) {
        const r = this.call(dec(m[1]), dec(m[2]));
        return r ? { code: 200, body: r } : { code: 404, body: { error: "call not found" } };
      }
      m = /^\/message\/([^/]+)\/full$/.exec(p);
      if (m) {
        const r = this.full(dec(m[1]));
        return r ? { code: 200, body: r } : { code: 404, body: { error: "message not found" } };
      }
      return null;
    } catch (e) {
      if (e instanceof HttpError) return { code: e.code, body: { error: e.message } };
      console.error(`history: ${e.message}`);
      return { code: 500, body: { error: "history read failed" } };
    }
  }
}

module.exports = { History, HermesStore, TranscriptStore, FIELD, FULL };
