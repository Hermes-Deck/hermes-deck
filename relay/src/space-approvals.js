"use strict";
const crypto = require("node:crypto");
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}
class SpaceApprovals {
  constructor({ snapshot, now = Date.now, ttlMs = 600_000 }) {
    Object.assign(this, { snapshot, now, ttlMs }); this.entries = new Map(); this.byKey = new Map();
  }
  _key(a) {
    return JSON.stringify([a.profile, a.text]);
  }
  _delete(r) {
    if (this.entries.get(r.id) !== r) return;
    this.entries.delete(r.id); this.byKey.delete(r.key);
  }
  sweep() { for (const r of this.entries.values()) if (r.expires <= this.now()) this._delete(r); }
  check(a) {
    const command = a.command, text = a.text;
    if (a.args?.text !== undefined && (typeof a.args.text !== "string" || a.args.text !== text))
      return { ok: false, message: "Action text and args.text must match." };
    if (command.length > 2000 || text.length > 2000 ||
        Buffer.byteLength(JSON.stringify(canonical({ ...a.args, text })), "utf8") > 8192)
      return { ok: false, message: "Action too large: command and text must be at most 2000 characters and arguments at most 8 KB." };
    const key = this._key(a);
    let r = this.byKey.get(key);
    if (r && r.expires <= this.now()) { this._delete(r); r = undefined; }
    // Split typing can give identical action text a different terminal command context.
    if (r && r.command !== command) return { ok: false, message: "Command context changed; repeat the exact approved command." };
    if (r?.state === "approved") { this._delete(r); return { ok: true, command: r.command }; }
    if (r?.state === "denied") { this._delete(r); return { ok: false, command: r.command, outcome: "denied", message: "The user denied this command." }; }
    if (!r) {
      this.sweep();
      // Admission scans at most 200 entries; add per-profile counters if this cap grows.
      const pending = [...this.entries.values()].filter((x) => x.profile === a.profile &&
        ["pending", "snapshotting", "snapshot-failed"].includes(x.state)).length;
      if (this.entries.size >= 200 || pending >= 20)
        return { ok: false, message: "Too many pending approvals; ask the user to answer the open ones." };
      r = { id: crypto.randomUUID(), key, profile: a.profile, host: a.host,
        command, text, created: this.now(), expires: this.now() + this.ttlMs, state: "pending" };
      this.entries.set(r.id, r); this.byKey.set(key, r);
    }
    return { ok: false, id: r.id, command: r.command,
      message: `Approval requested: ${r.command}. When the user approves it in Hermes Deck, repeat the same action exactly; do not try a variant.` };
  }
  list() {
    this.sweep();
    return [...this.entries.values()].filter((r) => ["pending", "snapshotting", "snapshot-failed"].includes(r.state))
      .map(({ id, profile, command, text, created, expires, state, reason }) => ({ id, profile, command, text, created, expires, state, ...(reason ? { reason } : {}) }));
  }
  async answer(id, { choice, withoutSnapshot = false } = {}) {
    this.sweep();
    const r = this.entries.get(id);
    const no = () => ({ ok: false, error: "approval unavailable" });
    if (!r || !["pending", "snapshot-failed"].includes(r.state)) return no();
    if (choice === "deny") { r.state = "denied"; return { ok: true, state: "denied" }; }
    if (choice !== "once" || typeof withoutSnapshot !== "boolean") return no();
    if (r.state === "snapshot-failed") {
      if (!withoutSnapshot) return no();
      r.state = "approved"; r.expires = this.now() + this.ttlMs;
      return { ok: true, state: "approved" };
    }
    if (withoutSnapshot) return no();
    r.state = "snapshotting";
    let result;
    try { result = await this.snapshot(r.profile, "before-risky-command", r.host); }
    catch { result = { ok: false }; }
    if (this.entries.get(id) !== r || r.expires <= this.now()) { this._delete(r); return no(); }
    if (!result?.ok) {
      r.state = "snapshot-failed"; r.reason = result?.reason === "too-large" ? "too-large" : "failed";
      return { ok: true, state: r.state };
    }
    r.state = "approved"; r.expires = this.now() + this.ttlMs;
    return { ok: true, state: r.state };
  }
}
module.exports = { SpaceApprovals };
