"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { localDay } = require("./util");
const { FINE_S, FINE_KEEP_S, KEEP_DAYS } = require("./model");
const ARCHIVE_EVERY_S = 6 * 3600; // how often the all-time (older than KEEP_DAYS) month aggregate is rebuilt

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKENS = { in: "input_tokens", cr: "cache_read_tokens", cw: "cache_write_tokens", out: "output_tokens", rs: "reasoning_tokens" };
const amount = v => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024; // only the last-resort private copy is bounded; direct reads are not
const BUSY_MS = 2000;

/** Map a SQLite/fs failure to a coarse, UI-safe kind. Never carries paths or row data. */
function errorKind(e) {
  const msg = String(e && e.message || "");
  if (e && e.kind) return e.kind;
  if (e && e.code === "ENOENT") return "missing";
  const code = typeof e.errcode === "number" ? e.errcode & 0xff : 0;
  if (code === 5 || code === 6 || /database is locked|database table is locked|busy/i.test(msg)) return "locked";
  if (/no such (table|column)/i.test(msg)) return "schema";
  return "unavailable";
}
const tagged = (kind, message) => Object.assign(new Error(message), { kind });

function fileStamp(file) {
  try {
    const s = fs.statSync(file, { bigint: true });
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
  } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

/** Canonical session counters across all surfaces. The live store is opened read-only in place (see plan()):
 * no 60-second copy of a multi-hundred-MB file and no WAL/SHM files created next to it.
 * Queries select counter/metadata columns only; the private-copy fallback is removed after reading.
 * Full bounded (400-day) session-counter scans deliberately avoid last_activity_at watermarks:
 * token writers can update counters without advancing that field, and repaired rows can decrease.
 * Days/models inherit session start/model (not an invented per-request billing ledger).
 * Auxiliary task rows are add-only; ordinary session_model_usage rows are NOT added again.
 */
class HostUsage {
  constructor({ root, model, onChange = () => {}, maxSnapshotBytes = MAX_SNAPSHOT_BYTES }) {
    this.root = root;
    this.model = model;
    this.onChange = onChange;
    this.maxSnapshotBytes = maxSnapshotBytes;
    this.cached = new Map();
    this.lastOk = new Map();
    this.model.usageRoll = {};
    this.model.usageFine = {};
    this.model.usageMonths = {};
    this.model.usageSince = null;
    this.status = { source: "state.db", profiles: {}, attribution: "session-start", checkedAt: null };
  }

  profiles() {
    const profiles = [];
    if (fs.existsSync(path.join(this.root, "state.db"))) profiles.push("default");
    try {
      for (const p of fs.readdirSync(path.join(this.root, "profiles")).sort()) {
        if (PROFILE_RE.test(p) && fs.existsSync(path.join(this.root, "profiles", p, "state.db"))) profiles.push(p);
      }
    } catch { /* no named profiles */ }
    return profiles;
  }

  storeFile(profile) {
    return profile === "default" ? path.join(this.root, "state.db") : path.join(this.root, "profiles", profile, "state.db");
  }

  /** Pick how to read the store without ever creating files next to it.
   * - live WAL store (-wal and -shm both present, i.e. a running Hermes): read-only connection. SQLite then
   *   attaches the existing -shm and creates nothing (verified by test: no new files, unchanged mtimes).
   * - no -wal and no -journal (Hermes stopped): `immutable=1`, the file cannot change under us and SQLite
   *   touches no sidecar.
   * - anything else (stale -wal without -shm, hot -journal): bounded private copy, the only path that can say
   *   "too-large". */
  plan(file) {
    if (!fs.existsSync(file)) throw tagged("missing", "state store missing");
    const wal = fs.existsSync(`${file}-wal`);
    const shm = fs.existsSync(`${file}-shm`);
    const journal = fs.existsSync(`${file}-journal`);
    const uri = require("node:url").pathToFileURL(file).href;
    if (wal && shm) return { mode: "live-ro", uri: `${uri}?mode=ro` };
    if (!wal && !journal) return { mode: "immutable", uri: `${uri}?mode=ro&immutable=1` };
    return { mode: "copy" };
  }

  /** {roll, fine, months, since, bound, mode}; `months` is null unless `archive` asked for the older-than-bound scan.
   * `dayFrom` (epoch s): start of the day scan when the cached archive was built at an older bound. */
  read(profile, now, archive = false, dayFrom = null) {
    const file = this.storeFile(profile);
    const plan = this.plan(file);
    if (plan.mode === "copy") return { ...this.readCopy(file, profile, now, archive, dayFrom), mode: "copy" };
    try {
      return { ...this.query(plan.uri, profile, now, archive, dayFrom), mode: plan.mode };
    } catch (e) {
      // Contention or an unrecoverable shm: retry once through a private copy when it is small enough.
      if (!["locked", "unavailable"].includes(errorKind(e))) throw e;
      try { return { ...this.readCopy(file, profile, now, archive, dayFrom), mode: "copy" }; } catch (copyError) {
        if (copyError.kind === "too-large") throw e; // report the real failure, not the fallback's size limit
        throw copyError;
      }
    }
  }

  readCopy(file, profile, now, archive = false, dayFrom = null) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "deck-usage-read-"));
    try {
      fs.chmodSync(temp, 0o700);
      // A read-only open of a WAL store without -shm would create one. Reconstruct sidecars in a private copy only.
      const files = [file, `${file}-wal`];
      const before = files.map(fileStamp);
      if (files.reduce((n, f, i) => n + (before[i] ? fs.statSync(f).size : 0), 0) > this.maxSnapshotBytes) throw tagged("too-large", "snapshot too large");
      for (let i = 0; i < files.length; i++) if (before[i]) fs.copyFileSync(files[i], path.join(temp, path.basename(files[i])));
      if (files.some((f, i) => fileStamp(f) !== before[i])) throw tagged("locked", "store changed during snapshot");
      return this.query(path.join(temp, path.basename(file)), profile, now, archive, dayFrom);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }

  query(location, profile, now, archive = false, dayFrom = null) {
    const { DatabaseSync } = require("node:sqlite");
    let db;
    try {
      db = new DatabaseSync(location, { readOnly: true, timeout: BUSY_MS });
      db.exec("PRAGMA query_only = ON");
      // One consistent read snapshot for session + auxiliary counters.
      db.exec("BEGIN");
      const cols = table => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
      const sessionCols = cols("sessions");
      const select = (columns, prefix = "") => ["model", "billing_provider", "cost_status", "cost_source", "api_call_count", ...Object.values(TOKENS), "estimated_cost_usd", "actual_cost_usd"]
        .map(c => columns.has(c) ? `${prefix}${c}` : `NULL AS ${c}`).join(", ");
      // A rebuilt archive takes everything before now-KEEP_DAYS. Between rebuilds the day scan reaches back to the last
      // archive's own bound (`dayFrom`), so a session crossing the moving 400-day line is counted exactly once.
      const bound = !archive && typeof dayFrom === "number" ? Math.min(dayFrom, now - KEEP_DAYS * 86400) : now - KEEP_DAYS * 86400;
      const rows = db.prepare(`SELECT started_at, ${select(sessionCols)} FROM sessions WHERE started_at >= ?`).all(bound);
      const roll = {};
      const fine = {}; // 5-minute slots of session start, last 48 h: the rolling "24 h" range
      const months = {}; // sessions older than the day-rollup bound, by month (only when archive is due)
      const agent = this.model.agentName(profile);
      const add = (row, auxiliary = false, archived = false) => {
        const tail = `\t${agent}\t${row.model || "?"}`;
        const keys = archived ? [[months, `${localDay(row.started_at).slice(0, 7)}${tail}`]] : [[roll, `${localDay(row.started_at)}${tail}`]];
        if (!archived && row.started_at >= now - FINE_KEEP_S) keys.push([fine, `${Math.floor(row.started_at / FINE_S) * FINE_S}${tail}`]);
        for (const [store, key] of keys) count(store[key] || (store[key] = { n: 0, sessions: 0, in: 0, cr: 0, cw: 0, out: 0, rs: 0, usd: 0,
          actual_usd: 0, estimated_usd: 0, unknownCost: 0, equivalent_usd: 0, source: "state.db", profile }), row, auxiliary);
      };
      const count = (r, row, auxiliary) => {
        r.n += amount(row.api_call_count);
        if (!auxiliary) r.sessions++;
        for (const [key, col] of Object.entries(TOKENS)) r[key] += amount(row[col]);
        const actual = row.actual_cost_usd;
        const estimate = row.estimated_cost_usd;
        const hasActual = typeof actual === "number" && Number.isFinite(actual) && actual >= 0;
        const known = hasActual || (typeof estimate === "number" && Number.isFinite(estimate) && estimate >= 0);
        const cost = hasActual ? actual : amount(estimate);
        r.usd += cost;
        if (hasActual) r.actual_usd += cost;
        else if (known) { r.estimated_usd += cost; r.estimated = true; }
        else r.unknownCost++;
        if (row.billing_provider === "claude-subscription-directsdk-experimental") {
          r.cost_label = "API list-price equivalent";
          r.equivalent_usd += cost;
        }
      };
      for (const row of rows) add(row);
      const auxCols = cols("session_model_usage");
      const aux = auxCols.has("task") && auxCols.has("session_id");
      if (aux) {
        for (const row of db.prepare(`SELECT s.started_at, ${select(auxCols, "u.")} FROM session_model_usage u
          JOIN sessions s ON s.id = u.session_id WHERE s.started_at >= ? AND u.task != ''`).all(bound)) add(row, true);
      }
      // "All": the oldest session start is one indexed lookup every refresh. Sessions older than the day-rollup
      // bound are only aggregated (by month) when the caller says the archive is due, i.e. rarely.
      const oldest = db.prepare("SELECT MIN(started_at) AS t FROM sessions").get();
      const since = oldest && typeof oldest.t === "number" && Number.isFinite(oldest.t) ? oldest.t : null;
      let archived = null;
      if (archive && since !== null && since < bound) {
        for (const row of db.prepare(`SELECT started_at, ${select(sessionCols)} FROM sessions WHERE started_at < ?`).all(bound)) add(row, false, true);
        if (aux) {
          for (const row of db.prepare(`SELECT s.started_at, ${select(auxCols, "u.")} FROM session_model_usage u
            JOIN sessions s ON s.id = u.session_id WHERE s.started_at < ? AND u.task != ''`).all(bound)) add(row, true, true);
        }
        archived = months;
      } else if (archive) archived = {};
      for (const store of [roll, fine, months]) for (const r of Object.values(store)) for (const c of ["usd", "actual_usd", "estimated_usd", "equivalent_usd"]) r[c] = Math.round(r[c] * 1e6) / 1e6;
      db.exec("ROLLBACK");
      return { roll, fine, months: archived, since, bound };
    } finally {
      if (db) try { db.close(); } catch { /* already closed */ }
    }
  }

  refresh(now = Date.now() / 1000) {
    const profiles = this.profiles();
    const states = {};
    for (const profile of profiles) {
      try {
        // The older-than-bound month archive is rebuilt at most every ARCHIVE_EVERY_S per profile (data that old
        // changes only through rare repairs); the per-minute scan stays bounded to KEEP_DAYS.
        const prev = this.cached.get(profile);
        const archive = !prev || !prev.archivedAt || now - prev.archivedAt >= ARCHIVE_EVERY_S || now < prev.archivedAt;
        const { roll, fine, months, since, bound, mode } = this.read(profile, now, archive, archive ? null : prev.archiveBound);
        this.cached.set(profile, months
          ? { roll, fine, since, months, archivedAt: now, archiveBound: bound }
          : { roll, fine, since, months: prev.months, archivedAt: prev.archivedAt, archiveBound: prev.archiveBound });
        this.lastOk.set(profile, now);
        states[profile] = { ok: true, mode, updatedAt: now };
      } catch (e) {
        // error kinds: missing | locked | too-large | schema | unavailable. Cached counters stay visible (stale).
        states[profile] = { ok: false, error: errorKind(e), stale: this.cached.has(profile), updatedAt: this.lastOk.get(profile) || null };
      }
    }
    for (const p of this.cached.keys()) if (!profiles.includes(p)) { this.cached.delete(p); this.lastOk.delete(p); }
    const merge = part => {
      const out = {};
      for (const cached of this.cached.values()) for (const [key, row] of Object.entries(cached[part] || {})) {
        if (!out[key]) { out[key] = { ...row }; continue; }
        const target = out[key];
        for (const field of ["n", "sessions", "in", "cr", "cw", "out", "rs", "usd", "actual_usd", "estimated_usd", "equivalent_usd", "unknownCost"]) target[field] += row[field] || 0;
        if (row.estimated) target.estimated = true;
        if (row.cost_label) target.cost_label = row.cost_label;
      }
      return out;
    };
    this.model.usageRoll = merge("roll");
    this.model.usageFine = merge("fine");
    this.model.usageMonths = merge("months");
    const starts = [...this.cached.values()].map(c => c.since).filter(t => typeof t === "number");
    this.model.usageSince = starts.length ? Math.min(...starts) : null;
    this.status = { ...this.status, checkedAt: now, profiles: states };
    this.onChange(this.status);
    return this.status;
  }
}
module.exports = { HostUsage, errorKind };
