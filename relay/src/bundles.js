"use strict";
// D3: the relay stores only sealed-box ciphertext. Keys, cookies and browser state stay on the endpoints.
// Every HTTP request also needs server.js's relay bearer and an authenticated, fresh device websocket.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const devtokens = require("./devtokens");

const DEVICE_RE = /^[a-f0-9]{8,64}$/;
const BUNDLE_RE = /^[a-f0-9]{32}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LIMITS = Object.freeze({ maxBytes: 8 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, maxEntries: 64, maxTtlMs: 300_000 });
const fail = (status, message) => Object.assign(new Error(message), { status });
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
function base64(value, max) {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(max / 3) * 4) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length <= max && bytes.toString("base64") === value ? bytes : null;
}
function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
async function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (part) => {
      size += part.length;
      if (size > max) {
        if (!tooLarge) reject(fail(413, "bundle body too large"));
        tooLarge = true;
        parts.length = 0;
      } else if (!tooLarge) parts.push(part);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try {
        const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
        if (!object(body)) throw fail(400, "invalid bundle body");
        resolve(body);
      } catch (e) { reject(e.status ? e : fail(400, "invalid JSON")); }
    });
    req.on("error", reject);
    req.on("aborted", () => reject(fail(400, "bundle request aborted")));
  });
}

class BundleStore {
  constructor({ dir, tokensFile, presence, now = Date.now, onStored = () => {}, onBeforeStore = () => {}, ...limits }) {
    Object.assign(this, { dir, tokensFile, presence, now, onStored, onBeforeStore });
    this.o = { ...LIMITS, ...limits };
    this.links = new Map();
    this.bundles = new Map();
    this.serverReady = false;
    this.registryFile = path.join(dir, "devices.json");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let records = [];
    try {
      if (fs.statSync(this.registryFile).size > 128 * 1024) throw new Error("bundle device registry too large");
      records = JSON.parse(fs.readFileSync(this.registryFile, "utf8"));
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (!Array.isArray(records) || records.length > 128) throw new Error("invalid bundle device registry");
    this.registry = new Map();
    const names = new Set();
    for (const r of records) {
      if (!object(r) || (!DEVICE_RE.test(r.deviceId) && r.deviceId !== "fallback") || base64(r.publicKey, 32)?.length !== 32 || this.registry.has(r.deviceId)) throw new Error("invalid bundle device identity");
      if (r.deviceId !== "fallback" && (!devtokens.NAME_RE.test(r.tokenName) || !/^[a-f0-9]{64}$/.test(r.tokenHash) || names.has(r.tokenName))) throw new Error("invalid bundle device owner");
      names.add(r.tokenName);
      this.registry.set(r.deviceId, r);
    }
    for (const name of fs.readdirSync(dir)) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!BUNDLE_RE.test(id)) continue;
      try {
        const file = this._file(id);
        if (fs.statSync(file).size > this._bodyLimit()) throw fail(413, "bundle too large");
        const b = JSON.parse(fs.readFileSync(file, "utf8"));
        const checked = this._envelope(b, b.source);
        if (b.id !== id) throw fail(400, "invalid bundle id");
        this.bundles.set(id, { ...checked, id });
      } catch { fs.unlinkSync(this._file(id)); }
    }
    this.prune();
  }

  _file(id) { return path.join(this.dir, `${id}.json`); }
  _bodyLimit() { return Math.ceil(this.o.maxBytes / 3) * 4 + 8192; }
  _saveRegistry() {
    const tmp = `${this.registryFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.registry.values()]), { mode: 0o600 });
    fs.renameSync(tmp, this.registryFile);
  }
  _valid(r) {
    return !!r && (r.deviceId === "fallback" || devtokens.stillValid(this.tokensFile, r.tokenName, r.tokenHash));
  }
  boundDevice(ws) {
    const link = this.links.get(ws);
    const hb = this.presence.conns.get(ws);
    const r = link && this.registry.get(link.deviceId);
    return this._valid(r) && link.tokenHash === r.tokenHash && ws.readyState === 1 && hb && hb.id === link.deviceId && this.now() - hb.at < this.presence.o.staleMs ? link.deviceId : null;
  }
  connOf(deviceId) {
    for (const ws of this.links.keys()) if (this.boundDevice(ws) === deviceId) return ws;
    return null;
  }
  _live(deviceId, hosting = false) {
    if (deviceId === "fallback") return this.serverReady;
    for (const [ws, link] of this.links) {
      const hb = this.presence.conns.get(ws);
      if (link.deviceId !== deviceId || this.boundDevice(ws) !== deviceId) continue;
      if (!hosting || (!hb.locked && hb.hosting.browser && (typeof hb.driverOk === "boolean" ? hb.driverOk : hb.driverOk.browser !== false))) return true;
    }
    return false;
  }

  /** Public identity only. Revoked tokens immediately disappear; stale devices cannot receive a new export. */
  identity(deviceId) {
    const r = this.registry.get(deviceId);
    return this._valid(r) ? { deviceId, publicKey: r.publicKey, fresh: this._live(deviceId, true) } : null;
  }
  devices() { return [...this.registry.keys()].map((id) => this.identity(id)).filter(Boolean); }
  _register(deviceId, publicKey, tokenName, tokenHash) {
    const old = this.registry.get(deviceId);
    if (old && (old.publicKey !== publicKey || old.tokenName !== tokenName || old.tokenHash !== tokenHash)) throw fail(409, "device identity already registered");
    for (const r of this.registry.values()) if (tokenName && r.tokenName === tokenName && r.deviceId !== deviceId) throw fail(409, "device token already belongs to another device");
    if (!old) {
      if (this.registry.size >= 128) throw fail(503, "device registry full");
      this.registry.set(deviceId, { deviceId, publicKey, tokenName, tokenHash });
      try { this._saveRegistry(); } catch (e) { this.registry.delete(deviceId); throw e; }
    }
    return this.identity(deviceId);
  }
  registerServer({ deviceId = "fallback", publicKey }) {
    if (deviceId !== "fallback" || base64(publicKey, 32)?.length !== 32) throw fail(400, "invalid server identity");
    this._register(deviceId, publicKey, null, null);
    this.serverReady = true;
    return this.identity(deviceId);
  }

  /** The authenticated connection, presence ID and token owner must agree before HTTP access is possible. */
  onMessage(ws, m) {
    if (m.t !== "bundle-hello") return false;
    try {
      const { deviceId, deviceToken, publicKey } = m;
      if (!DEVICE_RE.test(String(deviceId || "")) || base64(publicKey, 32)?.length !== 32) throw fail(400, "invalid device identity");
      const hb = this.presence.conns.get(ws);
      if (!hb || hb.id !== deviceId || this.now() - hb.at >= this.presence.o.staleMs) throw fail(403, "device heartbeat required");
      const tokenName = devtokens.match(this.tokensFile, deviceToken);
      if (!tokenName) throw fail(401, "device token not accepted");
      const tokenHash = devtokens.hash(deviceToken);
      this._register(deviceId, publicKey, tokenName, tokenHash);
      this.links.set(ws, { deviceId, tokenHash });
      ws.send(JSON.stringify({ t: "bundle-identity", ok: true, identity: this.identity(deviceId) }));
    } catch (e) {
      this.links.delete(ws);
      ws.send(JSON.stringify({ t: "bundle-identity", ok: false, error: e.status ? e.message : "device registration failed" }));
    }
    return true;
  }
  onClose(ws) { this.links.delete(ws); }
  _actor(req) {
    const deviceId = req.headers["x-deck-device-id"];
    const token = req.headers["x-deck-device-token"];
    if (typeof deviceId !== "string" || !DEVICE_RE.test(deviceId) || typeof token !== "string") throw fail(401, "device credentials required");
    const r = this.registry.get(deviceId);
    if (!r || devtokens.match(this.tokensFile, token) !== r.tokenName || devtokens.hash(token) !== r.tokenHash || !this._live(deviceId)) throw fail(403, "device ownership not accepted");
    return deviceId;
  }

  _envelope(m, source) {
    if (!object(m) || typeof m.slug !== "string" || !SLUG_RE.test(m.slug) || typeof m.target !== "string" || m.source !== source || source === m.target || (!DEVICE_RE.test(source) && source !== "fallback")) throw fail(400, "invalid bundle identity");
    const from = this.registry.get(source);
    const target = this.registry.get(m.target);
    if (!this._valid(from) || !this._valid(target)) throw fail(403, "bundle device is not registered");
    const createdAt = m.createdAt === undefined ? this.now() : m.createdAt;
    if (!Number.isSafeInteger(createdAt) || createdAt < this.now() - this.o.maxTtlMs || createdAt > this.now() + 30_000 || !Number.isSafeInteger(m.expiresAt) || m.expiresAt <= this.now() || m.expiresAt > createdAt + this.o.maxTtlMs) throw fail(400, "invalid bundle expiration");
    const reason = m.reason === undefined ? "manual" : m.reason;
    if (!["manual", "sleep", "checkpoint"].includes(reason)) throw fail(400, "invalid bundle reason");
    if ((m.version !== undefined && m.version !== 1) || (m.publicKey !== undefined && m.publicKey !== target.publicKey)) throw fail(400, "invalid envelope key or version");
    if (typeof m.ciphertext !== "string" || m.ciphertext.length > Math.ceil(this.o.maxBytes / 3) * 4) throw fail(413, "bundle too large");
    const ciphertext = Buffer.from(m.ciphertext, "base64");
    if (ciphertext.length > this.o.maxBytes) throw fail(413, "bundle too large");
    if (ciphertext.length < 48 || ciphertext.toString("base64") !== m.ciphertext || typeof m.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(m.sha256) || sha256(ciphertext) !== m.sha256) throw fail(400, "bundle SHA-256 mismatch or invalid ciphertext");
    return { slug: m.slug, source, target: m.target, createdAt, expiresAt: m.expiresAt, reason, version: 1, publicKey: target.publicKey, sha256: m.sha256, ciphertext: m.ciphertext, bytes: ciphertext.length };
  }
  _meta(b) { const { ciphertext, bytes, ...meta } = b; return meta; }
  prune() {
    for (const [id, b] of this.bundles) if (b.expiresAt <= this.now() || !this._valid(this.registry.get(b.source)) || !this._valid(this.registry.get(b.target))) this._remove(id);
  }
  _remove(id) {
    try { fs.unlinkSync(this._file(id)); } catch (e) { if (e.code !== "ENOENT") throw e; }
    this.bundles.delete(id);
  }
  put(deviceId, m) {
    this.prune();
    if (!this._live(deviceId)) throw fail(403, "source device is unavailable");
    const b = this._envelope(m, deviceId);
    if (!this._live(b.target, true)) throw fail(409, "target device is unavailable for browser hosting");
    const previous = b.reason === "checkpoint" ? [...this.bundles.values()].filter((v) => v.reason === "checkpoint" && v.source === b.source && v.slug === b.slug && v.target === b.target) : [];
    const replaced = previous.reduce((sum, v) => sum + v.bytes, 0);
    const total = [...this.bundles.values()].reduce((sum, v) => sum + v.bytes, 0);
    if (this.bundles.size - previous.length >= this.o.maxEntries || total - replaced + b.bytes > this.o.totalBytes) throw fail(507, "bundle storage full");
    b.id = crypto.randomBytes(16).toString("hex");
    const meta = this._meta(b);
    this.onBeforeStore(meta);
    const tmp = path.join(this.dir, `${b.id}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(b), { flag: "wx", mode: 0o600 });
      fs.renameSync(tmp, this._file(b.id));
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* failed before a temp file existed */ }
      throw e;
    }
    this.bundles.set(b.id, b);
    try { this.onStored(meta); } catch (e) { this._remove(b.id); throw e; }
    for (const old of previous) this._remove(old.id);
    return meta;
  }
  _forTarget(deviceId, id) {
    if (!BUNDLE_RE.test(String(id || ""))) throw fail(404, "bundle not found");
    this.prune();
    const b = this.bundles.get(id);
    if (!b || b.target !== deviceId) throw fail(404, "bundle not found");
    if (!this._live(deviceId)) throw fail(403, "target device is unavailable");
    return b;
  }
  get(deviceId, id) { const b = this._forTarget(deviceId, id); return { ...this._meta(b), ciphertext: b.ciphertext }; }
  ack(deviceId, id) { this._forTarget(deviceId, id); this._remove(id); return { ok: true }; }
  listFor(deviceId) {
    this.prune();
    return [...this.bundles.values()].filter((b) => b.target === deviceId).map((b) => this._meta(b));
  }
  latestCheckpoint(source, slug) {
    this.prune();
    const found = [...this.bundles.values()].filter((b) => b.reason === "checkpoint" && b.source === source && b.slug === slug).sort((a, b) => b.createdAt - a.createdAt)[0];
    return found ? this._meta(found) : null;
  }
  putServer(body) { return this.put("fallback", body); }
  getServer(id) { return this.get("fallback", id); }
  ackServer(id) { return this.ack("fallback", id); }

  /** server.js invokes this only after its ordinary relay authentication. */
  onHttp(req, res, url) {
    if (url.pathname !== "/bundle" && !url.pathname.startsWith("/bundle/")) return false;
    this._http(req, res, url).catch((e) => reply(res, e.status || 500, { error: e.status ? e.message : "bundle storage failed" }));
    return true;
  }
  async _http(req, res, url) {
    const actor = this._actor(req);
    const { pathname } = url;
    if (pathname === "/bundle/devices" && req.method === "GET") return reply(res, 200, { devices: this.devices() });
    if (pathname === "/bundle" && req.method === "GET") return reply(res, 200, { bundles: this.listFor(actor) });
    if (pathname === "/bundle/register" && req.method === "POST") {
      const m = await readBody(req, 1024);
      const identity = this.identity(actor);
      if (!identity || m.deviceId !== actor || m.publicKey !== identity.publicKey) throw fail(403, "device identity does not match websocket registration");
      return reply(res, 200, { identity });
    }
    if (pathname === "/bundle" && req.method === "POST") return reply(res, 201, { bundle: this.put(actor, await readBody(req, this._bodyLimit())) });
    const match = /^\/bundle\/([a-f0-9]{32})$/.exec(pathname);
    if (match && req.method === "GET") return reply(res, 200, { bundle: this.get(actor, match[1]) });
    if (match && req.method === "DELETE") return reply(res, 200, this.ack(actor, match[1]));
    return reply(res, match || pathname === "/bundle" || pathname === "/bundle/register" || pathname === "/bundle/devices" ? 405 : 404, { error: "bundle route not found or method not allowed" });
  }
}

module.exports = { BundleStore, LIMITS, sha256 };
