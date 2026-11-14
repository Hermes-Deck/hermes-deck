'use strict';
// The mobile wire's typed errors, its per-device request gate and its mutation replay memory. Pure: no I/O, the clock
// is injectable. MobileRelay (mobile.js) calls these from `call`/`dispatch` and from the response writers.

/** Hermes JSON-RPC codes that mean "refused before anything ran" (parse, request shape, unknown method, params). */
const PRE_DISPATCH_RPC = new Set([-32700, -32600, -32601, -32602]);
const BUSY_RETRY_MS = 1000;

/**
 * The wire error for anything thrown while serving an op: `{code, message, uncertain, ...}`.
 * - Relay errors keep their own `code` (bad_request, duplicate, limit, unauthorized, operation, not_found, ...).
 * - Bridge errors carry a `kind` (app/main/bridge.js MSG_KIND / kindError); it becomes the code, so a client never has
 *   to read `message` (kept for logs only):
 *     busy -> busy (+retryAfterMs, certain: nothing was sent)       offline -> offline (certain)
 *     timeout | lost | closed | changed -> timeout (+reason; uncertain: it may have run)
 *     host -> host (+rpcCode; certain only for JSON-RPC pre-dispatch codes)   unsupported -> host (certain)
 *     reply -> host (uncertain: Hermes answered nonsense)            stale -> stale (certain: state moved on)
 *     invalid -> bad_request (certain)                                limit -> limit (certain)
 * - Anything else (no kind, no code) is `host` + uncertain: unknown, never `bridge_error`.
 */
function wireError(error) {
  if (error?.wire && typeof error.wire.code === 'string') return { ...error.wire }; // a replayed outcome (ReplayMemory)
  const message = typeof error?.message === 'string' ? error.message : String(error);
  const kind = typeof error?.kind === 'string' ? error.kind : '';
  const rpc = Number.isInteger(error?.rpcCode) ? { rpcCode: error.rpcCode } : {};
  switch (kind) {
    case 'busy': return { code: 'busy', message, uncertain: false, retryAfterMs: retryAfter(error) };
    case 'offline': return { code: 'offline', message, uncertain: false };
    case 'timeout': case 'lost': case 'closed': case 'changed': return { code: 'timeout', reason: kind, message, uncertain: true };
    case 'host': return { code: 'host', ...rpc, message, uncertain: !PRE_DISPATCH_RPC.has(error.rpcCode) };
    case 'unsupported': return { code: 'host', reason: 'unsupported', rpcCode: Number.isInteger(error.rpcCode) ? error.rpcCode : -32601, message, uncertain: false };
    case 'reply': return { code: 'host', reason: 'reply', ...rpc, message, uncertain: true };
    case 'stale': return { code: 'stale', message, uncertain: false };
    case 'invalid': return { code: 'bad_request', message, uncertain: false };
    case 'limit': return { code: 'limit', message, uncertain: false };
  }
  if (typeof error?.code === 'string' && error.code) {
    const out = { code: error.code, message, uncertain: error.uncertain === true };
    if (error.code === 'busy' && Number.isFinite(error.retryAfterMs)) out.retryAfterMs = error.retryAfterMs;
    return out;
  }
  return { code: 'host', ...rpc, message, uncertain: true };
}
const retryAfter = error => Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0 ? Math.round(error.retryAfterMs) : BUSY_RETRY_MS;

/** sessionIndex: a failed profile's `error` sentence becomes its wire code (the sentence stays out of the phone's UI). */
function wireSessionIndex(result) {
  if (!result || !Array.isArray(result.profiles)) return result;
  return { ...result, profiles: result.profiles.map(info => info && info.ok === false
    ? { ...info, error: wireError({ message: info.error, kind: info.code || info.kind }).code } : info) };
}

const GATE = Object.freeze({ limit: 8, queue: 32, waitMs: 10000 });
const BACKGROUND = Object.freeze({ limit: 2, queue: 32, waitMs: 10000 });
const busyError = (message, retryAfterMs, gate) => Object.assign(new Error(message), { kind: 'busy', retryAfterMs, gate });

/**
 * At most `limit` operations run at once; up to `queue` more wait in FIFO order for at most `waitMs`, then fail `busy`
 * (nothing ran). Concurrent calls with the same share key (identical reads) join the one already running or waiting.
 * A finishing operation hands its slot straight to the oldest waiter, so a newcomer can never overtake the queue.
 */
class Gate {
  constructor({ limit = GATE.limit, queue = GATE.queue, waitMs = GATE.waitMs } = {}) {
    Object.assign(this, { limit, queue, waitMs });
    this.active = 0;
    this.waiting = [];
    this.shared = new Map();
  }
  /** Synchronous: would run() take this call now (a slot, a queue place, or an identical call to join)? */
  admits(key) { return (key != null && this.shared.has(key)) || this.active < this.limit || this.waiting.length < this.queue; }
  /** The refusal run() gives when admits() is false. */
  refusal() { return busyError('Too many requests in flight for this device; retry shortly', BUSY_RETRY_MS, 'full'); }
  get size() { return { active: this.active, waiting: this.waiting.length, shared: this.shared.size }; }
  run(fn, key = null) {
    if (key != null && this.shared.has(key)) return this.shared.get(key);
    const run = this.enter(fn);
    if (key != null) {
      this.shared.set(key, run);
      run.then(() => {}, () => {}).then(() => { if (this.shared.get(key) === run) this.shared.delete(key); });
    }
    return run;
  }
  async enter(fn) {
    if (this.active < this.limit) this.active++;
    else await this.wait();
    try { return await fn(); } finally { this.release(); }
  }
  wait() {
    if (this.waiting.length >= this.queue) return Promise.reject(this.refusal());
    return new Promise((resolve, reject) => {
      const item = { resolve };
      item.timer = setTimeout(() => {
        const at = this.waiting.indexOf(item);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(busyError('The request waited too long for a free slot and was not sent; retry shortly', 2 * BUSY_RETRY_MS, 'queued'));
      }, this.waitMs);
      item.timer.unref?.();
      this.waiting.push(item);
    });
  }
  release() {
    const next = this.waiting.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); } // the slot passes to the oldest waiter
    else this.active--;
  }
}

/** Stable key for identical reads: op plus args with sorted keys. */
function shareKey(op, args) {
  const stable = value => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return `${op}\u0000${JSON.stringify(stable(args || {}))}`;
}

const { AsyncLocalStorage } = require('node:async_hooks');
/** Set while a phone's op runs (MobileRelay.call); requests outside it are the relay's own background work. */
const FOREGROUND = new AsyncLocalStorage();
const foreground = fn => FOREGROUND.run(true, fn);

/**
 * The relay's BridgeClient with a separate budget for its own background requests: anything not issued under a
 * phone op (notification enrichment, the profile-name roster, the staging probe, the bridge's own keep-alive reads)
 * goes through a per-bridge Gate of 2 (+32 queued, 10 s), so background work can never crowd out the phone's ops.
 * Phone ops are bounded by the device's own Gate in MobileRelay.call. The desktop app never uses this class.
 */
function withBackgroundBudget(BridgeClient, options = BACKGROUND) {
  if (!BridgeClient) return BridgeClient;
  return class MobileBridgeClient extends BridgeClient {
    constructor(...args) {
      super(...args);
      this.keepStaleIndex = true; // sessionIndex: a failed profile keeps its last good rows, marked stale (R3b)
    }
    request(method, params) {
      if (FOREGROUND.getStore()) return super.request(method, params);
      this.backgroundGate ||= new Gate(options);
      return this.backgroundGate.run(() => super.request(method, params));
    }
  };
}

const REPLAY = Object.freeze({ size: 256, ttlMs: 600000, maxBytes: 65536 });
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

/**
 * The outcome of a device's recent mutations, by mutation id (R10 / G12): the last `size` for `ttlMs`. A repeated id
 * answers the first outcome instead of `duplicate`: the result (`replayed: true`), a certain failure again, `pending`
 * while the first still runs. An uncertain failure is not replayed: its true outcome is still unknown, so a repeat
 * answers `duplicate` ("refresh, never resend"), as before. In memory only: after a relay restart a repeat answers
 * `duplicate` from the persisted receipt.
 */
class ReplayMemory {
  constructor({ size = REPLAY.size, ttlMs = REPLAY.ttlMs, maxBytes = REPLAY.maxBytes, now = Date.now } = {}) {
    Object.assign(this, { size, ttlMs, maxBytes, now });
    this.entries = new Map();
  }
  prune() {
    const floor = this.now() - this.ttlMs;
    for (const [id, entry] of this.entries) if (entry.state !== 'pending' && entry.at <= floor) this.entries.delete(id);
    while (this.entries.size > this.size) this.entries.delete(this.entries.keys().next().value);
  }
  get(id) { this.prune(); return this.entries.get(id); }
  begin(id) { this.entries.delete(id); this.entries.set(id, { state: 'pending', at: this.now() }); this.prune(); }
  settle(id, ok, value) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.at = this.now();
    if (ok) {
      let text;
      try { text = JSON.stringify(value); } catch { text = null; }
      if (text === null || (text !== undefined && text.length > this.maxBytes)) { this.entries.delete(id); return; } // too big to keep: duplicate
      Object.assign(entry, { state: 'ok', result: text === undefined ? undefined : JSON.parse(text) });
    } else if (value && value.uncertain !== true) Object.assign(entry, { state: 'error', wire: { ...value } });
    else this.entries.delete(id); // uncertain: the receipt answers duplicate
    this.prune();
  }
  forget(id) { this.entries.delete(id); }
  /** The answer for a repeated id: a result to return, or an error to throw. `meta.replayed` is set on a replay. */
  answer(entry, meta = {}) {
    if (entry.state === 'pending') {
      throw Object.assign(new Error('The first request with this ID is still running; wait for its response or refresh'), { wire: { code: 'pending', message: 'The first request with this ID is still running; wait for its response or refresh', uncertain: true } });
    }
    meta.replayed = true;
    if (entry.state === 'ok') return clone(entry.result);
    throw Object.assign(new Error(entry.wire.message), { wire: { ...entry.wire, replayed: true } });
  }
}

module.exports = { ReplayMemory, REPLAY, wireError, wireSessionIndex, BUSY_RETRY_MS, Gate, GATE, BACKGROUND, shareKey, foreground, withBackgroundBudget };
