"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { atomicWriteJson, readJson } = require("./util");
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID = /^[a-f0-9-]{36}$/;
const DATE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const DEFAULTS = { audit: true, typedText: false, screenshots: true, days: 7, approvals: true, snapshotKeep: 10 };
function validSettings(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return false;
  return Object.entries(p).every(([k, v]) => ["audit", "typedText", "screenshots", "approvals"].includes(k)
    ? typeof v === "boolean" : k === "days" ? Number.isInteger(v) && v >= 1 && v <= 90
    : k === "snapshotKeep" ? Number.isInteger(v) && v >= 1 && v <= 100 : false);
}
function summary(tool, args, typed) {
  const a = args && typeof args === "object" ? args : {};
  if (tool === "type_text") return { length: String(a.text || "").length, ...(typed ? { text: String(a.text || "").slice(0, 200) } : {}) };
  const out = {};
  for (const k of ["x", "y", "dx", "dy", "amount", "direction", "key", "keys", "name", "app", "button"])
    if (typeof a[k] === "number" && Number.isFinite(a[k])) out[k] = a[k];
    else if (typeof a[k] === "string") out[k] = a[k].slice(0, 128);
    else if (k === "keys" && Array.isArray(a[k])) out[k] = a[k].filter((x) => typeof x === "string").slice(0, 8).map((x) => x.slice(0, 32));
  return out;
}
class SpaceAudit {
  constructor({ dataDir, env = process.env, now = Date.now, io = fs.promises, warn = console.warn,
    known = () => true, maxFrames = 300, maxFrameBytes = 200_000_000, maxQueueBytes = 8_000_000 }) {
    Object.assign(this, { dataDir, now, io, warn, known, maxFrames, maxFrameBytes, maxQueueBytes });
    this.root = path.join(dataDir, "audit");
    this.file = path.join(dataDir, "space-settings.json");
    this.locked = env.DECK_AUDIT === "0";
    this.cfg = { ...DEFAULTS };
    for (const [envKey, key, max] of [["DECK_AUDIT_DAYS", "days", 90], ["DECK_SNAPSHOT_KEEP", "snapshotKeep", 100]]) {
      const n = Number(env[envKey]);
      if (key === "days" && String(env[envKey] ?? "").trim() && Number.isFinite(n))
        this.cfg.days = Math.max(1, Math.min(max, Math.trunc(n)));
      else if (Number.isInteger(n) && n >= 1 && n <= max) this.cfg[key] = n;
    }
    const saved = readJson(this.file, {});
    if (validSettings(saved)) Object.assign(this.cfg, saved);
    this.queue = []; this.queued = 0; this.work = null; this.paused = false; this.seq = 0;
  }
  settings() { return { ...this.cfg, audit: this.cfg.audit && !this.locked, auditLocked: this.locked, loggingPaused: this.paused }; }
  update(patch) {
    if (!validSettings(patch)) throw new Error("bad settings");
    const next = { ...this.cfg, ...patch };
    atomicWriteJson(this.file, next);
    this.cfg = next;
    return this.settings();
  }
  _dir(profile) {
    if (typeof profile !== "string" || !PROFILE.test(profile) || profile.includes("..") || profile === "host") throw new Error("bad profile");
    return path.join(this.root, profile);
  }
  _pause() {
    if (this.paused) return;
    this.paused = true; this.queue = []; this.queued = 0;
    queueMicrotask(() => {
      try { Promise.resolve(this.warn("Agent space logging paused: storage unavailable or queue full.")).catch(() => {}); } catch {}
    });
  }
  record(call) {
    try {
      const cfg = this.settings();
      if (!cfg.audit || this.paused) return;
      // Hosts replay their last notices on every listing; the daily-log check below covers relay restarts.
      if (ID.test(call.noticeId)) {
        this.noticeIds ||= new Set();
        if (this.noticeIds.has(call.noticeId)) return;
        this.noticeIds.add(call.noticeId);
        if (this.noticeIds.size > 5000) this.noticeIds.delete(this.noticeIds.values().next().value);
      }
      this._dir(call.profile);
      const now = Number.isFinite(call.time) ? call.time : this.now();
      if (now < this.now() - cfg.days * 86400_000) return;
      const row = { id: ID.test(call.noticeId) ? call.noticeId : crypto.randomUUID(), order: `${String(now).padStart(16, "0")}-${String(++this.seq).padStart(12, "0")}`,
        time: now, profile: call.profile, host: typeof call.host === "string" ? call.host : undefined,
        tool: typeof call.tool === "string" ? call.tool.slice(0, 80) : "",
        summary: summary(call.tool, call.args, cfg.typedText || (call.outcome === "approval" && typeof call.command !== "string")),
        outcome: typeof call.outcome === "string" ? call.outcome : undefined,
        duration: Math.max(0, Number(call.duration) || 0), frame: null };
      if (typeof call.command === "string") row.command = call.command;
      if (["created", "too-large", "unpaused", "failed", "restored", "stopped", "cleanup-failed"].includes(call.event)) row.event = call.event;
      const image = cfg.screenshots && (call.result?.content || []).find((c) => c && c.type === "image" && MIME.has(c.mimeType) && typeof c.data === "string");
      const img = image ? { mimeType: image.mimeType, data: image.data } : null;
      // Count UTF-16 payloads and reserve space for the decoded frame while draining.
      const bytes = JSON.stringify(row).length * 2 + (img ? JSON.stringify(img).length * 2 + Math.ceil(img.data.length / 4) * 3 : 0);
      if (this.queued + bytes > this.maxQueueBytes) return this._pause();
      this.queue.push({ row, img, bytes }); this.queued += bytes;
      if (!this.work) this.work = new Promise((resolve) => setImmediate(resolve)).then(() => this._drain()).finally(() => { this.work = null; });
    } catch { this._pause(); }
  }
  async _drain() {
    try {
      while (this.queue.length && !this.paused) {
        const { row, img, bytes } = this.queue.shift();
        const dir = this._dir(row.profile);
        await this.io.mkdir(path.join(dir, "frames"), { recursive: true, mode: 0o700 });
        const day = new Date(row.time).toISOString().slice(0, 10);
        const file = path.join(dir, `${day}.jsonl`);
        if (row.event) {
          // Host replay is bounded to 100 notices; use the retained daily log as the durable dedupe index.
          let prior = "";
          try { prior = await this.io.readFile(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
          if (prior.split("\n").some((line) => { try { return JSON.parse(line).id === row.id; } catch { return false; } })) {
            this.queued -= bytes;
            continue;
          }
        }
        if (img) {
          const raw = Buffer.from(img.data, "base64");
          if (raw.length <= this.maxFrameBytes) {
            row.frame = row.id;
            const frame = path.join(dir, "frames", row.id);
            this.writingFrame = row.id;
            try {
              await this.io.writeFile(frame, raw, { mode: 0o600 });
              await this.io.writeFile(`${frame}.json`, JSON.stringify({ mime: img.mimeType, time: row.time, order: row.order, size: raw.length }), { mode: 0o600 });
            } catch (error) {
              try { await this.io.rm(frame, { force: true }); } catch {}
              try { await this.io.rm(`${frame}.json`, { force: true }); } catch {}
              throw error;
            } finally { this.writingFrame = null; }
          }
        }
        await this.io.appendFile(file, JSON.stringify(row) + "\n", { mode: 0o600 });
        this.queued -= bytes;
        await this._cleanProfile(row.profile);
      }
    } catch { this._pause(); }
  }
  async _names(dir) { try { return await this.io.readdir(dir); } catch (e) { if (e.code === "ENOENT") return []; throw e; } }
  async _cleanProfile(profile) {
    const dir = this._dir(profile), cutoff = this.now() - this.cfg.days * 86400_000;
    for (const name of await this._names(dir))
      if (DATE.test(name) && Date.parse(name.slice(0, 10)) + 86400_000 <= cutoff)
        await this.io.rm(path.join(dir, name), { force: true });
    const frames = path.join(dir, "frames"), list = [];
    const ids = new Set((await this._names(frames)).map((name) => name.replace(/\.json$/, "")).filter((id) => ID.test(id)));
    for (const id of ids) {
      if (id === this.writingFrame) continue;
      try { list.push({ id, ...JSON.parse(await this.io.readFile(path.join(frames, `${id}.json`), "utf8")) }); }
      catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        await this.io.rm(path.join(frames, id), { force: true });
        await this.io.rm(path.join(frames, `${id}.json`), { force: true });
      }
    }
    list.sort((a, b) => String(a.order).localeCompare(String(b.order)) || a.id.localeCompare(b.id));
    let count = list.length, bytes = list.reduce((n, x) => n + x.size, 0);
    for (const f of list) {
      if (f.time >= cutoff && count <= this.maxFrames && bytes <= this.maxFrameBytes) continue;
      await this.io.rm(path.join(frames, f.id), { force: true });
      await this.io.rm(path.join(frames, `${f.id}.json`), { force: true });
      count--; bytes -= f.size;
    }
  }
  async cleanup() {
    for (const p of await this._names(this.root)) {
      try { this._dir(p); } catch { continue; }
      try { await this._cleanProfile(p); } catch { this._pause(); }
    }
  }
  async page(profile, { before = "", limit = 50 } = {}) {
    const dir = this._dir(profile);
    if (before && !/^\d{16}-\d{12}:[a-f0-9-]{36}$/.test(before)) throw new Error("bad cursor");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("bad limit");
    if (!this.known(profile)) return { records: [], next: null };
    const rows = [], cutoff = this.now() - this.cfg.days * 86400_000;
    // ponytail: scan at most 90 daily files; add an index only if timeline reads become slow.
    for (const name of (await this._names(dir)).filter((n) => DATE.test(n)).sort().reverse()) {
      if (Date.parse(name.slice(0, 10)) + 86400_000 <= cutoff) continue;
      const input = fs.createReadStream(path.join(dir, name));
      input.on("error", () => {});
      const reader = readline.createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of reader) {
          let r; try { r = JSON.parse(line); } catch { continue; }
          if (!ID.test(r.id) || r.time < cutoff) continue;
          const cursor = `${r.order}:${r.id}`;
          if (before && cursor >= before) continue;
          rows.push(r); rows.sort((a, b) => `${b.order}:${b.id}`.localeCompare(`${a.order}:${a.id}`));
          if (rows.length > limit + 1) rows.pop();
        }
      } finally { reader.close(); input.destroy(); }
    }
    const more = rows.length > limit;
    const records = rows.slice(0, limit);
    return { records, next: more ? `${records.at(-1).order}:${records.at(-1).id}` : null };
  }
  async frame(profile, id) {
    const dir = path.join(this._dir(profile), "frames");
    if (!ID.test(id) || !this.known(profile)) return null;
    try {
      const meta = JSON.parse(await this.io.readFile(path.join(dir, `${id}.json`), "utf8"));
      if (!MIME.has(meta.mime) || meta.time < this.now() - this.cfg.days * 86400_000) return null;
      return { mime: meta.mime, bytes: await this.io.readFile(path.join(dir, id)) };
    } catch { return null; }
  }
  async flush() { while (this.work) await this.work; }
}
module.exports = { SpaceAudit, validSettings, DEFAULTS };
