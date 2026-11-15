"use strict";
// Phone pairing page: a short-lived, unauthenticated web page on the relay that shows the QR code of the app's
// pairing link (hermesdeck://pair?u=...&c=...) for one pending pairing code.
//
// A ticket is 24 random bytes (192 bits) as base64url, used only as the page's path segment (/pair/<ticket>). The
// pairing code it shows is derived from it (HMAC-SHA256(ticket, "hermes-deck pair code v1"), first 16 bytes as hex),
// so the relay's pairing file holds neither in clear: it stores SHA-256 hashes only, in the same `<devices>.pairs`
// file as the plain pending codes (mobile.js createPair/pair), under `pages`:
//   {pairs: {<sha256(code)>: {expires, page: true}}, pages: {<sha256(ticket)>: {code: <sha256(code)>, created, expires, paired?: {name, at}}}}
// The code cannot be turned back into the ticket. A ticket lives as long as its code (5 minutes) and dies at the first
// successful pairing (mobile.js pair() marks it paired; the page then shows the device's name for a short while and
// never the code again) or at expiry. Like the pending codes, open tickets survive a relay restart (same file).
// At most OPEN_LIMIT tickets wait at once; making another drops the oldest together with its code.
//
// HTTP (no bearer; server.js routes /pair and /pair/* here before any token check):
//   GET /pair/<ticket>          the page (HTML)
//   GET /pair/<ticket>/status   {state: "waiting", expiresAt, remainingS} | {state: "paired", name} | 404 {state: "gone"}
// Unknown, expired, dropped and malformed tickets get one generic answer (404, same page / same JSON). Misses are
// rate-limited per client address (MISS_LIMIT per minute, at most MAX_ADDRESSES tracked; beyond that new addresses
// share one bucket); a limited address gets 429 for every /pair/ request, hits included, so it learns nothing more.
// Only GET is answered (405 otherwise, HEAD included). Nothing about a ticket or code is ever logged.
const crypto = require("node:crypto");
const fs = require("node:fs");
const tokens = require("./devtokens");
const { atomicWriteJson, readJson } = require("./util");
const view = require("./pair-page-view");

const TTL_MS = 5 * 60 * 1000;
const OPEN_LIMIT = 3; // waiting tickets at once; the oldest is dropped
const PAGE_CAP = 8; // waiting + recently paired entries kept in the file
const PAIRED_KEEP_MS = 60 * 1000; // a paired ticket still answers "paired" this long (or until its expiry, if later)
const PAIR_LIMIT = 10; // pending codes at once, shared with mobile.js createPair
const MISS_LIMIT = 20, MISS_WINDOW_MS = 60 * 1000, MAX_ADDRESSES = 1024;
const TICKET_RE = /^[A-Za-z0-9_-]{32}$/;
const CODE_INFO = "hermes-deck pair code v1";

const pairFile = (file) => `${file}.pairs`; // the same file as mobile.js pairFile
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

/** The pairing code a ticket shows: 32 hex characters, never stored. */
const codeOf = (ticket) => crypto.createHmac("sha256", Buffer.from(ticket, "utf8")).update(CODE_INFO).digest().subarray(0, 16).toString("hex");

/**
 * DECK_RELAY_PUBLIC_URL normalised to `https://host[:port][/path]` without a trailing slash, or null when unset.
 * Throws on a value that is set but unusable (not https, credentials, query or fragment).
 */
function publicBase(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("DECK_RELAY_PUBLIC_URL is not a URL");
  }
  if (u.protocol !== "https:") throw new Error("DECK_RELAY_PUBLIC_URL must start with https://");
  if (u.username || u.password || u.search || u.hash) throw new Error("DECK_RELAY_PUBLIC_URL must be a plain https address (no user, query or #)");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

const keepUntil = (page) => (page.paired ? Math.max(page.expires, page.paired.at + PAIRED_KEEP_MS) : page.expires);

/** Drops expired pending codes and finished pages (in place). */
function prune(data, now) {
  data.pairs = Object.fromEntries(Object.entries(data.pairs || {}).filter(([, v]) => v && v.expires > now));
  data.pages = Object.fromEntries(Object.entries(data.pages || {}).filter(([, p]) => p && typeof p.code === "string" && keepUntil(p) > now));
  return data;
}

function privateWrite(file, value) {
  atomicWriteJson(file, value);
  fs.chmodSync(file, 0o600);
}

/**
 * Makes a ticket and its pending code in the pairing file next to `file` (the mobile devices file). Returns
 * {ticket, path, url (only with a public address), expiresAt (ISO 8601 UTC), expires (ms)}.
 */
function createPage(file, { publicUrl = null, now = Date.now() } = {}) {
  const base = publicBase(publicUrl);
  const data = prune(readJson(pairFile(file), { pairs: {} }), now);
  const entries = () => Object.entries(data.pages).sort((a, b) => a[1].created - b[1].created);
  const drop = (key) => {
    delete data.pairs[data.pages[key].code];
    delete data.pages[key];
  };
  let open = entries().filter(([, p]) => !p.paired);
  while (open.length >= OPEN_LIMIT) drop(open.shift()[0]);
  let all = entries();
  while (all.length >= PAGE_CAP) drop(all.shift()[0]);
  if (Object.keys(data.pairs).length >= PAIR_LIMIT) throw fail("limit", "Too many pending pairs", 429);
  const ticket = crypto.randomBytes(24).toString("base64url");
  const expires = now + TTL_MS;
  const codeKey = tokens.hash(codeOf(ticket));
  data.pairs[codeKey] = { expires, page: true };
  data.pages[tokens.hash(ticket)] = { code: codeKey, created: now, expires };
  privateWrite(pairFile(file), data);
  const path = `/pair/${ticket}`;
  return { ticket, path, ...(base ? { url: `${base}${path}` } : {}), expiresAt: new Date(expires).toISOString(), expires };
}

/** {state: "waiting", code, expires} | {state: "paired", name} | {state: "gone"} for a ticket. Every stored hash is
 * compared in constant time (no early exit), so the answer time does not depend on which entry, if any, matched.
 */
function lookup(file, ticket, now = Date.now()) {
  if (typeof ticket !== "string" || !TICKET_RE.test(ticket)) return { state: "gone" };
  const data = readJson(pairFile(file), { pairs: {} });
  const want = Buffer.from(tokens.hash(ticket), "hex");
  let found = null;
  for (const [key, page] of Object.entries(data.pages || {})) {
    const have = /^[a-f0-9]{64}$/.test(key) ? Buffer.from(key, "hex") : Buffer.alloc(32);
    if (crypto.timingSafeEqual(have, want) && page && typeof page.code === "string") found = page;
  }
  if (!found || keepUntil(found) <= now) return { state: "gone" };
  if (found.paired) return { state: "paired", name: found.paired.name || "" };
  const pending = data.pairs && data.pairs[found.code];
  if (found.expires <= now || !pending || pending.expires <= now) return { state: "gone" };
  return { state: "waiting", code: codeOf(ticket), expires: found.expires };
}

/** Per-address miss counter with a hard size bound; once full, untracked addresses share one overflow bucket. */
const OVERFLOW = "\u0000overflow";
class MissLimiter {
  constructor({ limit = MISS_LIMIT, windowMs = MISS_WINDOW_MS, maxAddresses = MAX_ADDRESSES, now = Date.now } = {}) {
    Object.assign(this, { limit, windowMs, maxAddresses, now });
    this.map = new Map(); // at most maxAddresses entries, the overflow bucket included
  }
  current(key, now) {
    const e = this.map.get(key);
    if (e && e.until <= now) {
      this.map.delete(key);
      return null;
    }
    return e || null;
  }
  full() {
    return this.map.size >= this.maxAddresses - 1;
  }
  limited(address) {
    const now = this.now();
    const e = this.current(String(address || "unknown"), now) || (this.full() ? this.current(OVERFLOW, now) : null);
    return !!e && e.count >= this.limit;
  }
  miss(address) {
    const now = this.now();
    let key = String(address || "unknown");
    let e = this.current(key, now);
    if (!e) {
      if (this.full()) for (const [k, v] of this.map) if (v.until <= now) this.map.delete(k);
      if (this.full()) {
        key = OVERFLOW;
        e = this.current(key, now);
      }
      if (!e) {
        e = { count: 0, until: now + this.windowMs };
        this.map.set(key, e);
      }
    }
    e.count++;
  }
}

const HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};
const csp = (nonce) => `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?::\d{1,5})?$/;

class PairPages {
  /** `file`: the mobile devices file (pairing state lives next to it); `publicUrl`: DECK_RELAY_PUBLIC_URL or null. */
  constructor({ file, publicUrl = null, now = Date.now, limiter = null }) {
    this.file = file;
    this.base = publicBase(publicUrl);
    this.now = now;
    this.limiter = limiter || new MissLimiter({ now });
  }
  /** POST /mobile/pair/page and the host tool: {url | path, expiresAt}. */
  create() {
    const made = createPage(this.file, { publicUrl: this.base, now: this.now() });
    return made.url ? { url: made.url, expiresAt: made.expiresAt } : { path: made.path, expiresAt: made.expiresAt };
  }
  /**
   * The https address the QR code and the deep link carry: DECK_RELAY_PUBLIC_URL, else the request's Host header when
   * it is a plain host name or IPv4 address with an optional port (anything else: null, the page shows the code only).
   * A forged Host only changes the answer the forger itself receives (no-store, nothing cached or stored).
   */
  address(req) {
    if (this.base) return this.base;
    const host = String(req.headers.host || "");
    return host.length <= 255 && HOST_RE.test(host) ? `https://${host.toLowerCase()}` : null;
  }
  send(res, status, type, body, extra = {}) {
    res.writeHead(status, { ...HEADERS, "content-type": type, ...extra });
    res.end(body);
  }
  json(res, status, value) {
    this.send(res, status, "application/json; charset=utf-8", JSON.stringify(value), { "content-security-policy": "default-src 'none'; frame-ancestors 'none'" });
  }
  html(res, status, render) {
    const nonce = crypto.randomBytes(16).toString("base64");
    this.send(res, status, "text/html; charset=utf-8", render(nonce), { "content-security-policy": csp(nonce) });
  }
  /** true when it answered (every path /pair and /pair/...). */
  onHttp(req, res, url) {
    const route = url.pathname;
    if (route !== "/pair" && !route.startsWith("/pair/")) return false;
    req.resume();
    const lang = view.language(req.headers["accept-language"]);
    const m = /^\/pair\/([^/]+)(\/status)?$/.exec(route);
    const status = !!(m && m[2]);
    if (req.method !== "GET") {
      this.send(res, 405, "text/plain; charset=utf-8", "method not allowed\n", { allow: "GET", "content-security-policy": "default-src 'none'" });
      return true;
    }
    const address = req.socket && req.socket.remoteAddress;
    if (this.limiter.limited(address)) {
      this.send(res, 429, "text/plain; charset=utf-8", "too many requests\n", { "retry-after": "60", "content-security-policy": "default-src 'none'" });
      return true;
    }
    const found = m ? lookup(this.file, m[1], this.now()) : { state: "gone" };
    if (found.state === "gone") {
      this.limiter.miss(address);
      if (status) this.json(res, 404, { state: "gone" });
      else this.html(res, 404, (nonce) => view.gonePage({ lang, nonce }));
      return true;
    }
    if (found.state === "paired") {
      if (status) this.json(res, 200, { state: "paired", name: found.name });
      else this.html(res, 200, (nonce) => view.pairedPage({ lang, nonce, name: found.name }));
      return true;
    }
    const remainingS = Math.max(0, Math.ceil((found.expires - this.now()) / 1000));
    if (status) this.json(res, 200, { state: "waiting", expiresAt: new Date(found.expires).toISOString(), remainingS });
    else this.html(res, 200, (nonce) => view.waitingPage({ lang, nonce, address: this.address(req), code: found.code, remainingS }));
    return true;
  }
}

module.exports = { PairPages, MissLimiter, createPage, lookup, codeOf, publicBase, pairFile, TTL_MS, OPEN_LIMIT, PAGE_CAP, PAIRED_KEEP_MS, MISS_LIMIT, TICKET_RE };
