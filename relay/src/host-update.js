"use strict";
// Host update from the app (docs/updating.md): POST /host/update {version} starts relay/bin/deck-relay-update as a
// transient job (update-job.js) and follows <data>/update-status.json; POST /host/restart {profile} restarts one
// queued gateway now (restarts.js). Both need the relay bearer header, a desktop device token and a live desktop
// connection with that device id; mobile connections never qualify. DECK_REMOTE_UPDATE=0 turns both off.
const path = require("path");
const devtokens = require("./devtokens");
const job = require("./update-job");
const { locate, compare } = require("../tools/update");

const SEMVER = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;
const DEVICE_RE = /^[a-f0-9]{8,64}$/;
const FINAL = new Set(["done", "failed", "rolled-back", "plugin-failed"]);
const STALE_MS = 15 * 60 * 1000;

const reply = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
const fail = (status, error, extra = {}) => Object.assign(new Error(error), { status, extra });

function readBody(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { parts.length = 0; reject(fail(413, "body too large")); } else parts.push(c);
    });
    req.on("end", () => {
      if (size > max) return;
      try { const v = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"); if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(); resolve(v); }
      catch { reject(fail(400, "invalid JSON")); }
    });
    req.on("error", reject);
  });
}

class HostUpdate {
  constructor(o) {
    this.o = o;
    Object.assign(this, { dataDir: o.dataDir, relayDir: o.relayDir, version: o.version, remoteUpdate: o.remoteUpdate !== false, tokensFile: o.tokensFile, presence: o.presence,
      plugins: o.plugins || (() => ({})), restarts: o.restarts, platform: o.platform || process.platform, uid: o.uid, node: o.node || process.execPath,
      run: o.run, fs: o.fs || require("fs"), now: o.now || Date.now, broadcast: o.broadcast || (() => {}) });
    this.statusFile = path.join(this.dataDir, "update-status.json");
    this.queueFile = path.join(this.dataDir, "restart-queue.json");
    this.lastSeen = null;
    this.cleanedJob = null;
    this.cleaning = false;
  }
  status() {
    try { return JSON.parse(this.fs.readFileSync(this.statusFile, "utf8")); } catch { return null; }
  }
  _running(st = this.status()) {
    return !!st && !FINAL.has(st.state) && this.now() - Date.parse(st.at || 0) < STALE_MS;
  }
  managed() {
    try { return locate({ fs: this.fs, env: {} }, { here: this.relayDir }).managed; } catch { return false; }
  }
  info() {
    return { remote: { enabled: this.remoteUpdate, managed: this.managed() }, status: this.status(), restarts: this.restarts ? this.restarts.rows() : [] };
  }
  publicInfo() {
    const st = this.status();
    return st ? { state: st.state, version: st.version } : null;
  }
  /** Push status and queue changes; the first poll also cleans up a job finished before this relay started. */
  poll() {
    const info = this.info();
    const st = info.status;
    const s = JSON.stringify(info);
    if (s === this.lastSeen) return;
    this.lastSeen = s;
    if (st && FINAL.has(st.state) && st.job && st.job.kind === "launchd" && this.cleanedJob !== st.job.label) {
      this.cleanedJob = st.job.label;
      this.cleaning = true;
      job.cleanupJob(st.job, { run: this.run, fs: this.fs, uid: this.uid }).finally(() => { this.cleaning = false; }).catch(() => {});
    }
    this.broadcast({ t: "hostUpdate", ...info });
  }
  _actor(req) {
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ")) throw fail(401, "relay bearer required");
    const id = req.headers["x-deck-device-id"];
    const token = req.headers["x-deck-device-token"];
    if (typeof id !== "string" || !DEVICE_RE.test(id) || typeof token !== "string") throw fail(401, "device credentials required");
    if (!devtokens.match(this.tokensFile, token)) throw fail(403, "device key not accepted");
    const d = this.presence.devices().get(id);
    if (!d || !d.hb || !Number.isFinite(d.hb.at) || this.now() - d.hb.at >= this.presence.o.staleMs || !d.conn || d.conn.mobileDevice) throw fail(403, "no live desktop connection for this device");
    return id;
  }
  _current(version) {
    const relayOk = compare(this.version, version) >= 0;
    const plugins = Object.values(this.plugins()).filter((v) => typeof v === "string");
    const pluginsOk = plugins.every((v) => compare(v, version) >= 0);
    return { relayOk, pluginsOk, newerPlugin: plugins.some((v) => compare(v, relayOk ? this.version : version) > 0) };
  }
  async _update(req, res) {
    this._actor(req);
    if (!this.remoteUpdate) throw fail(403, "remote updates are off on this host (DECK_REMOTE_UPDATE=0)");
    const body = await readBody(req);
    this._actor(req); // Credentials and presence can change while the body arrives.
    const version = body.version;
    if (typeof version !== "string" || !SEMVER.test(version)) throw fail(400, "version must be X.Y.Z");
    const { relayOk, pluginsOk, newerPlugin } = this._current(version);
    if (relayOk && pluginsOk) return reply(res, 200, { state: "current", version });
    const st = this.status();
    if (this._running(st)) {
      if (compare(version, st.version) > 0) throw fail(409, "another update is running; try again when it ends", { status: st });
      return reply(res, 200, { ...st, state: "running" });
    }
    if (this.cleaning) throw fail(409, "previous update cleanup is still running; try again when it ends");
    if (!this.managed()) throw fail(409, "the relay is not running from an install root", { command: "node relay/bin/deck-relay-update init ~/hermes-deck --dry-run" });
    // The updater installs the bundled plugin into every installed profile.
    if (newerPlugin) throw fail(409, "an installed plugin is newer than this release; refusing a downgrade");
    const updater = path.join(this.relayDir, "bin", "deck-relay-update");
    const args = relayOk
      ? ["plugin", "--status-file", this.statusFile, "--restart-queue", this.queueFile]
      : ["apply", "--version", version, "--with-plugin", "--status-file", this.statusFile, "--restart-queue", this.queueFile];
    let spec;
    try {
      spec = job.jobSpec({ platform: this.platform, uid: this.uid, node: this.node, updater, args, dataDir: this.dataDir, logDir: path.join(path.dirname(this.dataDir), "logs"), now: this.now });
    } catch (e) {
      throw fail(501, e.message);
    }
    const starting = { version, from: this.version, step: "starting", state: "running", at: new Date(this.now()).toISOString(), job: { kind: spec.kind, label: spec.label, ...(spec.plistFile ? { plistFile: spec.plistFile } : {}) } };
    this.fs.writeFileSync(`${this.statusFile}.tmp`, JSON.stringify(starting));
    this.fs.renameSync(`${this.statusFile}.tmp`, this.statusFile);
    const r = await job.startJob(spec, { run: this.run, fs: this.fs });
    if (!r.ok) {
      this.fs.writeFileSync(`${this.statusFile}.tmp`, JSON.stringify({ ...starting, state: "failed", error: r.error }));
      this.fs.renameSync(`${this.statusFile}.tmp`, this.statusFile);
      this.poll();
      throw fail(500, r.error);
    }
    this.poll();
    return reply(res, 202, { state: "started", version });
  }
  async _restart(req, res) {
    this._actor(req);
    if (!this.remoteUpdate) throw fail(403, "remote updates are off on this host (DECK_REMOTE_UPDATE=0)");
    const body = await readBody(req);
    this._actor(req);
    const r = await this.restarts.restartNow(String(body.profile || ""));
    this.poll();
    return reply(res, r.ok ? 200 : 409, { ...r, profile: String(body.profile || "") });
  }
  onHttp(req, res, url) {
    if (req.method !== "POST" || (url.pathname !== "/host/update" && url.pathname !== "/host/restart")) return false;
    const go = url.pathname === "/host/update" ? this._update(req, res) : this._restart(req, res);
    go.catch((e) => reply(res, e.status || 500, { error: e.status ? e.message : "host update failed", ...(e.extra || {}) }));
    return true;
  }
}

module.exports = { HostUpdate, FINAL };
