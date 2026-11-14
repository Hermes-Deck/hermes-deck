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

module.exports = { wireError, wireSessionIndex, BUSY_RETRY_MS };
