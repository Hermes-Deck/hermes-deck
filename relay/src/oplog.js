'use strict';
// The mobile relay's operation log (R8): one JSON line per refused or failed op, per bridge status change, and a summary
// every 60 s while ops ran. Metadata only: op name, code, counts and timings, at most 8 characters of a session id and
// a short device tag. Never message text, titles, tokens, file names or host error text. The sink is replaceable
// (tests read it); by default lines go to stdout, i.e. the relay unit's journal.

const SUMMARY_MS = 60000;
const SAMPLES = 2048; // durations kept per summary window for the p95

const short = (value, max = 8) => typeof value === 'string' && value ? value.slice(0, max) : undefined;
/** The device id is `mobile-<20 hex>`: its last 6 characters are enough to tell devices apart in a journal. */
const deviceTag = device => short(typeof device?.id === 'string' ? device.id.slice(-6) : '', 6);

class OpLog {
  constructor({ sink = line => process.stdout.write(`${line}\n`), now = Date.now, summaryMs = SUMMARY_MS } = {}) {
    Object.assign(this, { sink, now, summaryMs });
    this.window = this.fresh();
    this.timer = setInterval(() => this.flush(), summaryMs);
    this.timer.unref?.();
  }
  fresh() { return { at: this.now(), ops: 0, failed: 0, busy: 0, ms: [], maxPending: 0, maxInFlight: 0 }; }
  write(entry) {
    try { this.sink(JSON.stringify({ at: new Date(this.now()).toISOString(), ...entry })); } catch { /* a log sink never breaks an op */ }
  }
  /**
   * One finished op. `wire` is the wire error (mobile-gate.js wireError) or null on success; `gate` the device gate's
   * size, `pending` the bridge's pending request count.
   */
  op({ device, op, sid, ms, wire = null, gate = null, pending = 0, replayed = false }) {
    const w = this.window;
    w.ops++;
    if (w.ms.length < SAMPLES) w.ms.push(ms);
    w.maxPending = Math.max(w.maxPending, pending || 0);
    w.maxInFlight = Math.max(w.maxInFlight, gate?.active || 0);
    if (!wire) return;
    w.failed++;
    if (wire.code === 'busy') w.busy++;
    this.write({ t: 'mobile.op', device: deviceTag(device), op: typeof op === 'string' ? op.slice(0, 32) : '?', sid: short(sid),
      code: wire.code, ...(wire.reason ? { reason: wire.reason } : {}), ...(Number.isInteger(wire.rpcCode) ? { rpcCode: wire.rpcCode } : {}),
      uncertain: wire.uncertain === true, ...(replayed ? { replayed: true } : {}), ms: Math.round(ms),
      inFlight: gate?.active ?? 0, waiting: gate?.waiting ?? 0, pending: pending || 0 });
  }
  /** A bridge status change (open / offline / ...): its status word and code only, never the host's error text. */
  status(device, status, pending = 0) {
    const s = status && typeof status === 'object' ? status : {};
    this.write({ t: 'mobile.bridge', device: deviceTag(device), status: short(s.status, 16) || '?', ...(s.code ? { code: short(String(s.code), 32) } : {}), pending });
  }
  /** The window summary (ops, failures, p95 ms, max pending); nothing when no op ran. */
  flush() {
    const w = this.window;
    this.window = this.fresh();
    if (!w.ops) return null;
    const sorted = [...w.ms].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : 0;
    const entry = { t: 'mobile.summary', windowMs: this.now() - w.at, ops: w.ops, failed: w.failed, busy: w.busy, p95Ms: Math.round(p95), maxPending: w.maxPending, maxInFlight: w.maxInFlight };
    this.write(entry);
    return entry;
  }
  stop() { clearInterval(this.timer); }
}

module.exports = { OpLog, deviceTag };
