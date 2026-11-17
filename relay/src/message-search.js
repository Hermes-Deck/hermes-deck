"use strict";
/**
 * Message-text search for the phone (`searchMessages`, lane relay-extras X5) over Hermes' state.db files, read-only,
 * through the relay's HermesStore (history.js): the same stores and the same authorization as the history reads a
 * phone already has (any session of any profile on this host). Claude Code transcripts are not searched.
 *
 * Cost bound: one call reads at most SCAN_TOTAL stored messages, the newest of each searched profile, split evenly
 * (at most SCAN_PER_PROFILE per profile), restricted to the user and assistant rows of the window by rowid (a primary
 * key range, so SQLite never touches older rows). A result whose profile had older messages outside the window says
 * `partial: true`. Matching is SQL LIKE (case-insensitive for ASCII) over the typed text and its lower, upper and
 * capitalised forms, then a case-insensitive match (Turkish i/I/İ/ı folded together) on the redacted text builds the snippet and its ranges.
 */
const { redact } = require("./util");

const SCAN_TOTAL = 60000;
const SCAN_PER_PROFILE = 30000;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const MAX_PROFILES = 16;
const READ_CHARS = 65536; // of one message's text, for the snippet
const BEFORE = 60, AFTER = 100, MAX_RANGES = 8;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const fail = (message) => Object.assign(new Error(message), { code: "bad_request" });
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The case forms a person is likely to have typed or stored (LIKE folds only ASCII). */
function variants(q) {
  const cap = q ? q[0].toLocaleUpperCase("tr") + q.slice(1) : q;
  return [...new Set([q, q.toLowerCase(), q.toUpperCase(), q.toLocaleLowerCase("tr"), q.toLocaleUpperCase("tr"), cap, q[0].toUpperCase() + q.slice(1)])].slice(0, 6);
}

/** A case-insensitive matcher that also folds Turkish i/I/İ/ı (the JS `i` flag does not): one class per character. */
function matcher(q) {
  const cls = [...q].map((c) => {
    const forms = new Set([c, c.toLowerCase(), c.toUpperCase(), c.toLocaleLowerCase("tr"), c.toLocaleUpperCase("tr")]);
    if (c === "i" || c === "I" || c === "\u0130" || c === "\u0131") ["i", "I", "\u0130", "\u0131"].forEach((f) => forms.add(f));
    const single = [...forms].filter((f) => [...f].length === 1);
    return single.length > 1 ? `[${single.map(escapeRegex).join("")}]` : escapeRegex(c);
  });
  return new RegExp(cls.join(""), "gu");
}

function readCursor(raw) {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw !== "string" || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw fail("Invalid cursor");
  let value;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw fail("Invalid cursor");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("Invalid cursor");
  const out = {};
  for (const [p, id] of Object.entries(value)) {
    if (!PROFILE_RE.test(p) || !Number.isSafeInteger(id) || id < 0) throw fail("Invalid cursor");
    out[p] = id;
  }
  return out;
}

/** A window of `text` around its first match, and every match inside it as [start, end) UTF-16 offsets. */
function snippet(text, rx) {
  rx.lastIndex = 0;
  const first = rx.exec(text);
  if (!first) return null;
  let start = Math.max(0, first.index - BEFORE);
  let end = Math.min(text.length, first.index + first[0].length + AFTER);
  // never cut a surrogate pair
  if (start > 0 && /[\udc00-\udfff]/.test(text[start])) start--;
  if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1])) end++;
  const lead = start > 0 ? "\u2026" : "";
  const tail = end < text.length ? "\u2026" : "";
  const body = text.slice(start, end).replace(/\s/g, " ");
  const ranges = [];
  rx.lastIndex = 0;
  let m;
  const window = text.slice(start, end);
  while ((m = rx.exec(window)) && ranges.length < MAX_RANGES) {
    if (!m[0].length) break;
    ranges.push([m.index + lead.length, m.index + m[0].length + lead.length]);
  }
  return { snippet: lead + body + tail, ranges };
}

/**
 * searchMessages {q, profile?, cursor?, limit?} -> {results, next, partial, scanRows}.
 * results: [{id: "h:<profile>:<rowid>", profile, sid, title, role, ts, snippet, ranges}], newest first across profiles.
 */
function searchMessages(store, args = {}, { claudeProfile = "claude-code", scanRows: perProfile = SCAN_PER_PROFILE } = {}) {
  const q = typeof args.q === "string" ? args.q.trim() : null;
  if (!q || [...q].length < 2 || [...q].length > 200) throw fail("Search text must be 2 to 200 characters");
  const limit = args.limit === undefined ? DEFAULT_LIMIT : args.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw fail(`limit must be 1..${MAX_LIMIT}`);
  if (args.profile !== undefined && (typeof args.profile !== "string" || !PROFILE_RE.test(args.profile))) throw fail("Invalid profile");
  const cursor = readCursor(args.cursor);
  let profiles = store.profiles().filter((p) => p !== claudeProfile);
  if (args.profile !== undefined) profiles = profiles.filter((p) => p === args.profile);
  profiles = profiles.slice(0, MAX_PROFILES);
  // a profile the cursor marks as done (0) is not searched again
  const active = profiles.filter((p) => cursor[p] !== 0);
  const scanRows = Math.min(perProfile, Math.floor(SCAN_TOTAL / Math.max(1, profiles.length)));
  const rx = matcher(q);
  const likes = variants(q).map((v) => `%${escapeLike(v)}%`);
  const lists = {};
  const state = {};
  let partial = false;
  for (const p of active) {
    let h;
    try {
      h = store.open(p);
    } catch (e) {
      if (e.code === 501) throw Object.assign(new Error(e.message), { code: "unavailable", status: 503 });
      continue;
    }
    const span = store.stmt(h, "SELECT MAX(id) AS hi, MIN(id) AS lo FROM messages").get() || {};
    if (!span.hi) { state[p] = { done: true, before: Number.MAX_SAFE_INTEGER }; lists[p] = []; continue; }
    const floor = Math.max(0, span.hi - scanRows);
    if (span.lo <= floor) partial = true;
    const before = cursor[p] === undefined ? Number.MAX_SAFE_INTEGER : cursor[p];
    const act = h.msgCols.has("active") ? " AND active = 1" : "";
    const sql = `SELECT id, session_id, role, timestamp, substr(content, 1, ${READ_CHARS}) AS content FROM messages ` +
      `WHERE id < ? AND id > ? AND role IN ('user', 'assistant')${act} AND (${likes.map(() => "content LIKE ? ESCAPE '\\'").join(" OR ")}) ` +
      `ORDER BY id DESC LIMIT ?`;
    const rows = store.stmt(h, sql).all(before, floor, ...likes, limit + 1);
    state[p] = { done: rows.length <= limit, before };
    lists[p] = rows.slice(0, limit).map((r) => ({ p, h, r }));
  }
  // Newest first across profiles: a merge of each profile's rows (newest rowid first), always taking the head with the
  // latest timestamp, so what one page hands out of a profile is a prefix of that profile's rows (the cursor is exact).
  const heads = Object.fromEntries(active.map((p) => [p, 0]));
  const taken = [];
  while (taken.length < limit) {
    let best = null;
    for (const p of Object.keys(lists)) {
      const c = lists[p][heads[p]];
      if (c && (!best || (c.r.timestamp || 0) > (best.r.timestamp || 0) || ((c.r.timestamp || 0) === (best.r.timestamp || 0) && c.r.id > best.r.id))) best = c;
    }
    if (!best) break;
    heads[best.p]++;
    taken.push(best);
  }
  const results = [];
  const titles = new Map();
  for (const { p, h, r } of taken) {
    const cut = snippet(redact(String(r.content || "")), rx);
    if (!cut) continue; // the match sat inside a redacted secret, or past the readable text
    const key = `${p}\u0000${r.session_id}`;
    if (!titles.has(key)) {
      const row = h.sesCols.has("title") ? store.stmt(h, "SELECT title FROM sessions WHERE id = ?").get(r.session_id) : null;
      titles.set(key, row && typeof row.title === "string" ? row.title.slice(0, 160) : null);
    }
    results.push({ id: `h:${p}:${r.id}`, profile: p, sid: r.session_id, title: titles.get(key), role: r.role, ts: r.timestamp, ...cut });
  }
  // Cursor: per profile the rowid below which the next page continues; 0 = nothing more in its window.
  const next = {};
  let more = false;
  for (const p of profiles) {
    if (cursor[p] === 0) { next[p] = 0; continue; }
    const s = state[p];
    if (!s) continue; // not opened (an error): searched from the top again next page
    const used = heads[p] || 0;
    if (s.done && used >= (lists[p] || []).length) { next[p] = 0; continue; }
    more = true;
    if (used > 0) next[p] = lists[p][used - 1].r.id;
    else if (s.before !== Number.MAX_SAFE_INTEGER) next[p] = s.before;
  }
  return { results, next: more ? Buffer.from(JSON.stringify(next)).toString("base64url") : null, partial, scanRows };
}

module.exports = { searchMessages, SCAN_TOTAL, SCAN_PER_PROFILE, MAX_LIMIT, snippet, variants, matcher };
