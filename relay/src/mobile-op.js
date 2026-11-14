'use strict';
// POST /mobile/op (PROTOCOL-GAPS G21 / 4.1): one op over plain HTTPS, for a notification action or a share extension
// that has no WebSocket. Same handler as the socket (MobileRelay.call): same validation, mutation ids, receipts,
// replay, gate and limits. The body is the WebSocket request frame plus an optional `waitMs`; the answer is the
// WebSocket response frame with status 200, also for an op-level failure (`ok:false`), so one decoder serves both.
// 400 / 401 / 413 only for an unreadable body, a bad bearer, an oversized body (MobileRelay.handle / object()).

const { wireError, BUSY_RETRY_MS } = require('./mobile-gate');

/** Ops a client may send over HTTP (announced in capabilities.httpOps.ops). Everything else: ok:false `operation`. */
const HTTP_OPS = Object.freeze(['answerApproval', 'answerQuestion', 'send', 'create', 'createBotChat', 'interrupt', 'sessions', 'botChat', 'profiles', 'start', 'avatar']);
const FIELDS = new Set(['id', 'op', 'args', 'waitMs']);
const WAIT_MAX_MS = 20000;
const WAITERS_MAX = 8; // HTTP ops of one device held open at once (waiting for the bridge or running)

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const frame = (id, body) => ({ t: 'response', ...(typeof id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(id) ? { id } : {}), ...body });

/** Waits until the bridge reports `open`, at most `ms`; resolves either way (the op then answers `offline` itself). */
function whenOpen(bridge, ms) {
  if (!ms || bridge?.status?.status === 'open' || typeof bridge?.on !== 'function') return Promise.resolve();
  return new Promise(resolve => {
    let timer = null;
    const seen = status => { if (status?.status === 'open') done(); };
    const done = () => { clearTimeout(timer); bridge.off?.('status', seen); resolve(); };
    timer = setTimeout(done, ms);
    bridge.on('status', seen);
  });
}

/**
 * Runs one HTTP op for `device` and returns the response frame. `relay` is the MobileRelay; a successful mutation
 * calls its device-seen hook when it has one (`relay.deviceSeen(device, 'op')`, lane relay-notify).
 */
async function httpOp(relay, device, value, { readOps }) {
  const id = value?.id;
  const answer = async () => {
    const unknown = Object.keys(value).find(key => !FIELDS.has(key));
    if (unknown) throw fail('bad_request', 'Unknown field');
    if (!HTTP_OPS.includes(value.op)) throw fail('operation', 'Operation not available over HTTP; use the WebSocket');
    const waitMs = value.waitMs ?? 0;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > WAIT_MAX_MS) throw fail('bad_request', 'Invalid waitMs');
    if ((device.httpOps || 0) >= WAITERS_MAX) throw fail('busy', 'Too many HTTP operations in flight for this device; retry shortly', { retryAfterMs: BUSY_RETRY_MS });
    device.httpOps = (device.httpOps || 0) + 1;
    try {
      if (waitMs) {
        let bridge = null;
        try { bridge = relay.bridge(device); } catch { /* not configured: call() answers unavailable */ }
        await whenOpen(bridge, waitMs);
      }
      const meta = {};
      const result = await relay.call(device, { id, op: value.op, args: value.args }, meta);
      if (!readOps.has(value.op)) { try { relay.deviceSeen?.(device, 'op'); } catch { /* the seen hook never fails an op */ } }
      return frame(id, { ok: true, result, ...(meta.replayed ? { replayed: true } : {}) });
    } finally { device.httpOps--; }
  };
  try { return await answer(); }
  catch (error) { return frame(id, { ok: false, error: wireError(error), ...(error?.wire?.replayed ? { replayed: true } : {}) }); }
}

module.exports = { httpOp, HTTP_OPS, WAIT_MAX_MS };
