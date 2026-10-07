"use strict";
// One desktop host's agent desktops (agent spaces phase 2, spec 2026-10-07): containers from Cua's Spaces image,
// one per agent, driven through the `docker` CLI. Pure Node (no electron import): the relay uses it for the agent
// host, each Deck for its own computer. The container token (cua-spacesd's) is made and kept here — a file per
// agent in dataDir, mode 0600 — and never handed out: callers ask tokenOf() only for their own loopback fetches.
//
// Network isolation (docs/agent-spaces.md, "Limits and isolation"; the scripts are NET_SCRIPTS below): desktops live on the user-defined
// network `hermes-deck-desktops`; scoped iptables rules (set from a privileged helper container in the Docker VM's
// network namespace) keep them off the host, the LAN and the tailnet while the internet still works. The rules do
// not survive a Docker/VM restart, so this class FAILS CLOSED: ensure() applies and checks them before every
// `docker run` and every `docker start`, and does nothing else if that fails. Every argv element goes to the
// runner as its own element (no shell: Git Bash rewrites POSIX-looking arguments on Windows).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // Hermes profiles that are also Docker-name safe
const containerName = (p) => (typeof p === "string" && PROFILE_RE.test(p) && !p.includes("..") ? `hermes-deck-space-${p}` : null);
const volumeName = (p) => (containerName(p) ? `hermes-deck-home-${p}` : null);
const LABEL = "hermes-deck.space=1";
const NET = "hermes-deck-desktops";
const SUBNET_FORMAT = '{{range .IPAM.Config}}{{.Subnet}}{{"\\n"}}{{end}}';

// The probe's scripts, verbatim. `$1` is the network's IPv4 subnet. setup is idempotent (exit 0: all eight rules in
// place), check changes nothing (exit 0 only if all eight exist), teardown removes only rules that exist.
const NET_SCRIPTS = Object.freeze({
  setup: String.raw`set -e; apk add -q iptables 2>/dev/null; S="$1"; C="-m comment --comment hermes-deck"; for D in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do iptables -C DOCKER-USER -s "$S" -d "$D" $C -j REJECT 2>/dev/null || iptables -I DOCKER-USER 1 -s "$S" -d "$D" $C -j REJECT; done; iptables -C DOCKER-USER -s "$S" -m conntrack --ctstate ESTABLISHED,RELATED $C -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER 1 -s "$S" -m conntrack --ctstate ESTABLISHED,RELATED $C -j ACCEPT; iptables -C INPUT -s "$S" $C -j REJECT 2>/dev/null || iptables -I INPUT 1 -s "$S" $C -j REJECT; iptables -C INPUT -s "$S" -m conntrack --ctstate ESTABLISHED,RELATED $C -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -s "$S" -m conntrack --ctstate ESTABLISHED,RELATED $C -j ACCEPT`,
  check: String.raw`set -e; apk add -q iptables 2>/dev/null; S="$1"; C="-m comment --comment hermes-deck"; for D in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do iptables -C DOCKER-USER -s "$S" -d "$D" $C -j REJECT; done; iptables -C DOCKER-USER -s "$S" -m conntrack --ctstate ESTABLISHED,RELATED $C -j ACCEPT; iptables -C INPUT -s "$S" $C -j REJECT; iptables -C INPUT -s "$S" -m conntrack --ctstate ESTABLISHED,RELATED $C -j ACCEPT`,
  teardown: String.raw`set -e; apk add -q iptables 2>/dev/null; S="$1"; C="-m comment --comment hermes-deck"; for D in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do iptables -C DOCKER-USER -s "$S" -d "$D" $C -j REJECT 2>/dev/null && iptables -D DOCKER-USER -s "$S" -d "$D" $C -j REJECT; done; iptables -C DOCKER-USER -s "$S" -m conntrack --ctstate ESTABLISHED,RELATED $C -j ACCEPT 2>/dev/null && iptables -D DOCKER-USER -s "$S" -m conntrack --ctstate ESTABLISHED,RELATED $C -j ACCEPT; iptables -C INPUT -s "$S" $C -j REJECT 2>/dev/null && iptables -D INPUT -s "$S" $C -j REJECT; iptables -C INPUT -s "$S" -m conntrack --ctstate ESTABLISHED,RELATED $C -j ACCEPT 2>/dev/null && iptables -D INPUT -s "$S" -m conntrack --ctstate ESTABLISHED,RELATED $C -j ACCEPT; true`,
});

const NET_CREATE_ARGV = ["network", "create", "--driver", "bridge", "--opt", "com.docker.network.bridge.enable_icc=false", "--label", LABEL, NET];
const NET_ERR = "network isolation could not be set up";
const short = (r) => String((r && r.stderr) || "").trim().slice(0, 200);

const SNAP_ID = /^[a-f0-9-]{36}$/;
const SNAP_REASONS = new Set(["stop", "start", "before-risky-command", "before-undo"]);
const SNAP_SCRIPTS = Object.freeze({
  measure: 'du -sk /home',
  pack: 'umask 077; tar -czf "/snap/$1.part" -C /home .; mv "/snap/$1.part" "/snap/$1.tar.gz"; stat -c %s "/snap/$1.tar.gz"',
  drop: 'rm -f -- "/snap/$1.part" "/snap/$1.tar.gz"',
  verify: 'test -s "/snap/$1.tar.gz"; gzip -t "/snap/$1.tar.gz"; tar -tzf "/snap/$1.tar.gz" >/dev/null',
  unpack: 'tar -tzf "/snap/$1.tar.gz" >/dev/null; tar -xzf "/snap/$1.tar.gz" -C /stage',
  install: 'find /home -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; cp -a /stage/. /home/',
  rollback: 'find /home -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzf "/snap/$1.tar.gz" -C /home',
});

class DesktopHost {
  constructor({ run, pin, dataDir, opts = {}, now = () => Date.now() }) {
    Object.assign(this, { run, pin, dataDir, now });
    // Isolation is not optional: the network args are a constant; opts.network (if a caller still passes it) is ignored.
    this.opts = { memory: "1.5g", cpus: 2, shm: "1g", ...opts };
    this.image = `${pin.repository}@${pin.digest}`;
    this._homesQueue = new Map();
    this._snapshotJobs = new Map();
    this._blockedHomes = new Set();
    this.onSnapshot = () => {};
    this._netQueue = Promise.resolve(); // network setup/repair/teardown run one at a time (the rules are not race-safe)
  }

  _need(profile) {
    const c = containerName(profile);
    if (!c) throw new Error(`bad profile: ${String(profile).slice(0, 70)}`);
    return c;
  }

  _tokenFile(profile) {
    // Named from a hex encoding of the profile: unique on case-insensitive filesystems (Aurora vs aurora), and never
    // a Windows device name (con, nul, aux, com1 ...).
    return path.join(this.dataDir, `${Buffer.from(profile, "utf8").toString("hex")}.token`);
  }

  tokenOf(profile) {
    if (!containerName(profile)) return null;
    try {
      return fs.readFileSync(this._tokenFile(profile), "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  _newToken(profile) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const t = crypto.randomBytes(24).toString("hex");
    fs.writeFileSync(this._tokenFile(profile), t, { mode: 0o600 });
    return t;
  }

  async docker() {
    try {
      const r = await this.run(["version", "--format", "{{.Server.Version}}"]);
      return r.code === 0 ? "ready" : "stopped";
    } catch (e) {
      return e && e.code === "ENOENT" ? "missing" : "stopped";
    }
  }

  /** The pinned helper image (isolation rules), or null when none is pinned. */
  get helperImage() {
    const h = this.pin && this.pin.helper;
    return h && h.repository && h.digest ? `${h.repository}@${h.digest}` : null;
  }

  /** Both pinned images are here: the desktop image and the helper (netEnsure must never pull one implicitly). */
  async imagePresent() {
    for (const img of [this.image, this.helperImage].filter(Boolean)) {
      const r = await this.run(["image", "inspect", img, "--format", "{{.Id}}"]);
      if (r.code !== 0) return false;
    }
    return true;
  }

  /** Pull the helper (small) and then the desktop image; onLine(line, "helper" | "image") for progress. */
  async pull(onLine = () => {}) {
    const jobs = [[this.helperImage, "helper"], [this.image, "image"]].filter(([img]) => img);
    for (const [img, which] of jobs) {
      const r = await this.run(["pull", img], { onLine: (l) => onLine(l, which) });
      if (r.code !== 0) throw new Error(`docker pull failed: ${(r.stderr || "").trim().slice(0, 200)}`);
    }
  }

  // ---- network isolation ----

  _serial(fn) {
    const p = this._netQueue.then(fn, fn);
    this._netQueue = p.catch(() => {});
    return p;
  }

  /** {exists, subnet}: the isolation network's IPv4 subnet (first non-empty line without ':'), or null. */
  async _readSubnet() {
    const r = await this.run(["network", "inspect", NET, "--format", SUBNET_FORMAT]);
    if (r.code !== 0) return { exists: false, subnet: null };
    const line = String(r.stdout || "").split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.includes(":"));
    return { exists: true, subnet: line && /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(line) ? line : null };
  }

  /** Run one isolation script in a privileged helper in the VM's network namespace (probe argv shape). */
  async _helper(script, subnet) {
    const img = this.helperImage;
    if (!img) throw new Error("no helper image is pinned (desktops-pin.json helper)");
    // --pull never: the helper is pulled with the user's consent (pull()); a removed one fails here, clearly
    return this.run(["run", "--rm", "--pull", "never", "--privileged", "--net=host", img, "sh", "-c", script, "sh", subnet]);
  }

  /**
   * The network exists and its rules are in place. Each helper run costs ~1.7 s (it installs iptables), so the
   * read-only check runs first and setup (then the check again) only when it fails; `apply` (netRepair, after the
   * rules were removed) skips that first check. Fails closed: any failure, or a check that still fails, throws.
   */
  async _netEnsure({ apply = false } = {}) {
    let n = await this._readSubnet();
    if (!n.exists) {
      const c = await this.run(NET_CREATE_ARGV);
      if (c.code !== 0) throw new Error(`docker network create failed: ${short(c)}`);
      n = await this._readSubnet();
    }
    if (!n.subnet) throw new Error(`network ${NET} has no IPv4 subnet`);
    if (!apply && (await this._helper(NET_SCRIPTS.check, n.subnet)).code === 0) return;
    const s = await this._helper(NET_SCRIPTS.setup, n.subnet);
    if (s.code !== 0) throw new Error(`rules not applied: ${short(s)}`);
    const c = await this._helper(NET_SCRIPTS.check, n.subnet);
    if (c.code !== 0) throw new Error(`rules not in place after setup: ${short(c)}`);
  }

  /** Create the network if missing, apply the rules, verify them. Throws if isolation is not in place. */
  netEnsure() {
    return this._serial(async () => {
      try {
        await this._netEnsure();
      } catch (e) {
        throw new Error(`${NET_ERR}: ${(e && e.message) || e}`);
      }
    });
  }

  /** Read-only: true only when every rule exists (helper exit 0). A missing network or any failure is false. */
  async netCheck() {
    try {
      const n = await this._readSubnet();
      if (!n.subnet) return false;
      const r = await this._helper(NET_SCRIPTS.check, n.subnet);
      return r.code === 0;
    } catch {
      return false;
    }
  }

  /** Remove the rules (if the network exists), throwing on a real error. */
  async _rulesOff() {
    const n = await this._readSubnet();
    if (!n.subnet) return;
    const r = await this._helper(NET_SCRIPTS.teardown, n.subnet);
    if (r.code !== 0) throw new Error(`rules not removed: ${short(r)}`);
  }

  /**
   * Re-apply from scratch: rules off, then netEnsure, so a partial state never leaves the reject above the accept.
   * The network itself stays (desktops are attached to it, and re-creating it could change the subnet that the
   * old rules were written for).
   */
  netRepair() {
    return this._serial(async () => {
      try {
        await this._rulesOff();
        await this._netEnsure({ apply: true }); // the rules were just removed: no point checking first
      } catch (e) {
        throw new Error(`${NET_ERR}: ${(e && e.message) || e}`);
      }
    });
  }

  /** Hosting turned off: rules out, then the network removed (a missing network is fine). */
  netTeardown() {
    return this._serial(async () => {
      try {
        await this._rulesOff();
      } catch (e) {
        throw new Error(`network isolation could not be torn down: ${(e && e.message) || e}`);
      }
      const r = await this.run(["network", "rm", NET]);
      if (r.code !== 0 && !/no such network|not found/i.test(`${r.stderr || ""}${r.stdout || ""}`)) {
        throw new Error(`docker network rm failed: ${short(r)}`);
      }
    });
  }

  _cleanupBlocked(profile) { return this._blockedHomes.has(profile) || !!this._snapMeta(profile).cleanupFailed; }
  _assertSnapshotReady(profile) {
    if (this._cleanupBlocked(profile)) throw new Error("snapshot failed; cleanup-failed: recovery required");
  }
  _blockSnapshot(profile, helperName) {
    this._blockedHomes.add(profile); // stays blocked even if persisting the recovery marker fails
    try {
      const m = this._snapMeta(profile);
      m.cleanupFailed = true; m.cleanupHelper = helperName || m.cleanupHelper || null; m.dirty = true;
      this._saveSnap(profile, m);
    } finally { this._notice(profile, "cleanup-failed"); }
  }
  snapshotBusy(profile) { return this._homesQueue.has(profile) || (containerName(profile) ? this._cleanupBlocked(profile) : false); }
  _homeSerial(profile, fn, snapshot = false) {
    try { this._need(profile); } catch (e) { return Promise.reject(e); }
    const next = () => { this._assertSnapshotReady(profile); return fn(); };
    const p = (this._homesQueue.get(profile) || Promise.resolve()).then(next, next);
    this._homesQueue.set(profile, p);
    if (snapshot) this._snapshotJobs.set(profile, (this._snapshotJobs.get(profile) || 0) + 1);
    const done = () => {
      if (this._homesQueue.get(profile) === p) this._homesQueue.delete(profile);
      if (snapshot) this._finishSnapshotJob(profile);
    };
    p.then(done, done);
    return p;
  }
  _finishSnapshotJob(profile) {
    const count = this._snapshotJobs.get(profile) - 1;
    if (count) this._snapshotJobs.set(profile, count);
    else this._snapshotJobs.delete(profile);
  }
  _snapFile(profile) {
    this._need(profile);
    return path.join(this.dataDir, `${Buffer.from(profile).toString("hex")}.snapshots.json`);
  }
  _snapMeta(profile) {
    try { return { points: [], keep: 10, dirty: false, recovery: false, ...JSON.parse(fs.readFileSync(this._snapFile(profile), "utf8")) }; }
    catch (e) { if (e.code === "ENOENT") return { points: [], keep: 10, dirty: false, recovery: false }; throw new Error("snapshot metadata unavailable"); }
  }
  _saveSnap(profile, m) {
    const file = this._snapFile(profile);
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(m), { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  }
  _markHomeDirty(profile) {
    const m = this._snapMeta(profile); m.dirty = true; this._saveSnap(profile, m);
  }
  _notice(profile, event, id = crypto.randomUUID()) {
    if (this._cleanupBlocked(profile)) event = "cleanup-failed";
    const notice = { id, time: this.now(), event };
    try {
      const m = this._snapMeta(profile); m.notice = notice;
      // ponytail: retain 100 host notices for reconnect replay; add a spool if longer offline history is needed.
      m.notices = [...(m.notices || []), notice].slice(-100);
      this._saveSnap(profile, m);
    } catch {}
    try { this.onSnapshot(profile, notice); } catch {}
  }
  async snapshots(profile) {
    const m = this._snapMeta(profile);
    const points = m.points.filter((p) => !p.deleting);
    return { points: points.map(({ id, time, reason, size, consistent }) => ({ id, time, reason, size, consistent })),
      totalBytes: points.reduce((n, p) => n + p.size, 0), notice: m.notice || null, notices: m.notices || [],
      busy: this._snapshotJobs.has(profile) || this._cleanupBlocked(profile), recovery: m.recovery === true || this._cleanupBlocked(profile) };
  }
  _snapVolume(profile) { this._need(profile); return `hermes-deck-snap-${profile}`; }
  async _snapRun(profile, op, mounts, args = []) {
    this._need(profile);
    this._assertSnapshotReady(profile);
    if (!this.helperImage || !SNAP_SCRIPTS[op]) throw new Error("snapshot failed");
    const r = await this.run(["run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
      ...mounts.flatMap((m) => ["-v", m]), this.helperImage, "sh", "-ceu", SNAP_SCRIPTS[op], "sh", ...args]);
    if (r.cleanupFailed) {
      this._blockSnapshot(profile, r.helperName);
      this._assertSnapshotReady(profile);
    }
    if (r.code !== 0) throw new Error("snapshot failed");
    return r.stdout;
  }
  async _snapInfo(profile) {
    const r = await this.run(["container", "inspect", this._need(profile)]);
    if (r.code !== 0) {
      if (/no such container/i.test(r.stderr || "")) return null;
      throw new Error("snapshot failed");
    }
    try { return JSON.parse(r.stdout)[0]; } catch { throw new Error("snapshot failed"); }
  }
  snapshot(profile, reason, options = {}) {
    return this._homeSerial(profile, () => this._snapshot(profile, reason, options), true);
  }
  async _snapshot(profile, reason, options) {
    this._snapshotJobs.set(profile, (this._snapshotJobs.get(profile) || 0) + 1);
    try { return await this._takeSnapshot(profile, reason, options); }
    finally { this._finishSnapshotJob(profile); }
  }
  async _takeSnapshot(profile, reason, { keep = this.opts.snapshotKeep ?? this._snapMeta(profile).keep, protect = [] } = {}) {
    if (!SNAP_REASONS.has(reason) || !Number.isInteger(keep) || keep < 1 || keep > 100) throw new Error("bad snapshot options");
    const name = this._need(profile), vol = this._snapVolume(profile), id = crypto.randomUUID();
    const info = await this._snapInfo(profile);
    let pauseAttempted = false, consistent = true, point;
    try {
      if (info?.State?.Running && !info.State.Paused) {
        pauseAttempted = true;
        const r = await this.run(["pause", name]);
        if (r.code !== 0) {
          if (/pause.*(?:not supported|unsupported|not implemented)/i.test(r.stderr || "")) consistent = false;
          else throw new Error("snapshot failed");
        }
      }
      const home = `${volumeName(profile)}:/home:ro`;
      const measured = /^(\d+)\s/.exec(await this._snapRun(profile, "measure", [home]));
      const bytes = measured ? Number(measured[1]) * 1024 : NaN;
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("snapshot failed");
      if (bytes > 2_000_000_000) { this._notice(profile, "too-large"); return { ok: false, reason: "too-large" }; }
      if ((await this.run(["volume", "create", vol])).code !== 0) throw new Error("snapshot failed");
      // Reserve the quota until pack reports its size: a failed/partial archive must remain tracked for deletion.
      point = { id, time: this.now(), reason, size: 5_000_000_000, consistent, deleting: true };
      const pending = this._snapMeta(profile); pending.points.unshift(point); this._saveSnap(profile, pending);
      const size = Number(await this._snapRun(profile, "pack", [home, `${vol}:/snap`], [id]));
      if (Number.isSafeInteger(size) && size > 0) {
        point.size = size;
        this._saveSnap(profile, pending);
      }
      if (!Number.isSafeInteger(size) || size <= 0 || size > 5_000_000_000) throw new Error("snapshot failed");
      delete point.deleting;
      this._saveSnap(profile, pending);
    } catch {
      if (point && !this._cleanupBlocked(profile)) await this._dropSnapshot(profile, id).catch(() => {});
      this._notice(profile, "failed");
      throw new Error("snapshot failed");
    } finally {
      if (pauseAttempted) {
        const state = await this._snapInfo(profile).catch(() => null);
        // Docker rejects unpause when already running; unknown state still needs a resume attempt.
        const r = state?.State?.Paused === false ? { code: 0 }
          : await this.run(["unpause", name]).catch(() => ({ code: 1 }));
        if (r.code !== 0 && (await this._snapInfo(profile).catch(() => null))?.State?.Paused !== false) {
          try { await this._stopRaw(profile); }
          catch { this._blockSnapshot(profile); }
          const m = this._snapMeta(profile); m.dirty = true; this._saveSnap(profile, m);
          if (point && !this._cleanupBlocked(profile)) await this._dropSnapshot(profile, id).catch(() => {});
          this._notice(profile, "failed");
          throw new Error("snapshot failed");
        }
      }
    }
    const m = this._snapMeta(profile);
    m.keep = keep;
    try { this._saveSnap(profile, m); await this._pruneSnapshots(profile, new Set([id, ...protect])); }
    catch {
      if (!this._cleanupBlocked(profile)) await this._dropSnapshot(profile, id).catch(() => {});
      throw new Error("snapshot quota could not be enforced");
    }
    this._notice(profile, consistent ? "created" : "unpaused", id);
    return { ok: true, point };
  }
  async _pruneSnapshots(profile, protect = new Set()) {
    let m = this._snapMeta(profile);
    for (const p of [...m.points].reverse()) {
      if (!p.deleting && m.points.length <= m.keep && m.points.reduce((n, x) => n + x.size, 0) <= 5_000_000_000) continue;
      if (protect.has(p.id) || (m.recovery && p.id === m.recoveryPoint)) continue;
      await this._dropSnapshot(profile, p.id);
      m = this._snapMeta(profile);
    }
    if (m.points.reduce((n, x) => n + x.size, 0) > 5_000_000_000) throw new Error("snapshot quota exceeded");
  }
  dropSnapshot(profile, id) { return this._homeSerial(profile, () => this._dropSnapshot(profile, id), true); }
  async _dropSnapshot(profile, id) {
    this._assertSnapshotReady(profile);
    if (id !== null && !SNAP_ID.test(id)) throw new Error("bad snapshot");
    const m = this._snapMeta(profile);
    if (m.recovery && (id === null || id === m.recoveryPoint)) throw new Error("restore recovery required");
    for (const p of m.points.filter((p) => id === null || p.id === id)) {
      p.deleting = true;
      this._saveSnap(profile, m);
      await this._snapRun(profile, "drop", [`${this._snapVolume(profile)}:/snap`], [p.id]);
      m.points = m.points.filter((x) => x.id !== p.id);
      this._saveSnap(profile, m);
    }
    return { ok: true };
  }

  ensure(profile) {
    return this._homeSerial(profile, async () => {
      const m = this._snapMeta(profile);
      if (m.recovery) throw new Error("restore recovery required");
      const info = await this._snapInfo(profile);
      let homeExists = !!info;
      if (!info && m.dirty) {
        const r = await this.run(["volume", "inspect", volumeName(profile)]);
        if (r.code !== 0 && !/no such volume/i.test(r.stderr || "")) throw new Error("snapshot failed");
        homeExists = r.code === 0;
      }
      if (homeExists && !info?.State?.Running && m.dirty) {
        try { await this._snapshot(profile, "start"); } catch { this._notice(profile, "failed"); }
      }
      this._assertSnapshotReady(profile);
      return this._ensure(profile);
    });
  }
  stop(profile) {
    return this._homeSerial(profile, async () => {
      await this._stopRaw(profile); // no new agent writes while taking the stop point
      this._notice(profile, "stopped");
      const existed = await this._snapInfo(profile).catch(() => { this._notice(profile, "failed"); return null; });
      if (!existed && !this._snapMeta(profile).dirty) return null;
      let result = null;
      try {
        result = await this._snapshot(profile, "stop");
        if (result.ok) { const m = this._snapMeta(profile); m.dirty = false; this._saveSnap(profile, m); }
      } catch { this._notice(profile, "failed"); }
      this._assertSnapshotReady(profile);
      return result;
    });
  }
  reset(profile) {
    return this._homeSerial(profile, async () => {
      if (this._snapMeta(profile).recovery) throw new Error("restore recovery required");
      await this._reset(profile);
      const m = this._snapMeta(profile); m.dirty = false; this._saveSnap(profile, m);
    });
  }
  restore(profile, id, { keep = 10 } = {}) {
    return this._homeSerial(profile, async () => {
      if (!SNAP_ID.test(id) || !this._snapMeta(profile).points.some((p) => p.id === id && !p.deleting)) throw new Error("bad snapshot");
      const stage = `hermes-deck-restore-${crypto.randomUUID()}`;
      const snap = `${this._snapVolume(profile)}:/snap:ro`;
      const home = `${volumeName(profile)}:/home`;
      let before = null, changed = false;
      try {
        await this._stopRaw(profile);
        const marker = this._snapMeta(profile); marker.recovery = true; this._saveSnap(profile, marker);
        if ((await this.run(["volume", "create", stage])).code !== 0) throw new Error("restore failed");
        // Archive extraction sees a fresh staging volume, a read-only archive volume and a read-only root.
        // It has neither the live home nor a writable backup mount, even for malicious archive symlinks.
        await this._snapRun(profile, "unpack", [snap, `${stage}:/stage`], [id]);
        const saved = await this._snapshot(profile, "before-undo", { keep, protect: [id] });
        if (!saved.ok) throw new Error("restore failed");
        before = saved.point.id;
        await this._snapRun(profile, "verify", [snap], [before]);
        // A retry may be backing up a partial home: keep the original intact recovery point pinned.
        const recovery = this._snapMeta(profile); recovery.recoveryPoint ||= before; this._saveSnap(profile, recovery);
        changed = true;
        await this._snapRun(profile, "install", [`${stage}:/stage:ro`, home]);
        changed = false; // a later retention failure must not roll back a successfully restored home
        const m = this._snapMeta(profile); m.recovery = false; m.recoveryPoint = null; m.dirty = false; this._saveSnap(profile, m);
        await this._pruneSnapshots(profile, new Set([before]));
        this._notice(profile, "restored");
        return { ok: true, before };
      } catch {
        if (changed && before && !this._cleanupBlocked(profile)) await this._snapRun(profile, "rollback", [snap, home], [before]).catch(() => {});
        this._notice(profile, "failed");
        throw new Error("restore failed; desktop stays off and undo points are kept");
      } finally {
        if (!this._cleanupBlocked(profile)) await this.run(["volume", "rm", "-f", stage]).catch(() => {});
      }
    }, true);
  }

  // ---- desktops ----

  async _inspect(name) {
    const r = await this.run(["container", "inspect", name]);
    if (r.code !== 0) return null;
    try {
      return JSON.parse(r.stdout)[0] || null;
    } catch {
      return null;
    }
  }

  async _port(name) {
    const r = await this.run(["port", name, "3211"]);
    const m = /127\.0\.0\.1:(\d+)/.exec(r.stdout || "");
    if (!m) throw new Error(`no loopback port for ${name}`);
    return Number(m[1]);
  }

  async _create(profile, name) {
    const token = this.tokenOf(profile) || this._newToken(profile);
    // --pull never: a removed image fails clearly instead of being pulled implicitly (pull() runs after consent)
    const argv = ["run", "--pull", "never", "-d", "--name", name, "--label", LABEL, "--label", `hermes-deck.profile=${profile}`,
      "-e", `CUA_ENV_TOKEN=${token}`, "-p", "127.0.0.1::3211", "-v", `${volumeName(profile)}:/home/cua`,
      "--memory", String(this.opts.memory), "--cpus", String(this.opts.cpus), "--shm-size", String(this.opts.shm),
      "--restart", "no", "--network", NET, this.image];
    this._markHomeDirty(profile); // persist before run; even a failed reply may have started the desktop
    const r = await this.run(argv);
    if (r.code !== 0) throw new Error(`docker run failed: ${short(r)}`);
  }

  async _ensure(profile) {
    const name = this._need(profile);
    const info = await this._inspect(name);
    const nm = info && info.HostConfig && info.HostConfig.NetworkMode;
    const recreate =
      !!info &&
      ((info.Config && info.Config.Image !== this.image) || // a new pinned image
        (typeof nm === "string" && nm !== NET)); // never start one on the default bridge
    const running = !!(info && info.State && info.State.Running);
    if (running) this._markHomeDirty(profile);
    if (info && !recreate && running) return { port: await this._port(name) };

    await this.netEnsure(); // fail closed: nothing below runs unless the rules are in place
    if (!info) await this._create(profile, name);
    else if (recreate) {
      await this.run(["rm", "-f", name]); // the home volume stays
      await this._create(profile, name);
    } else {
      this._markHomeDirty(profile); // isolation succeeded; a failed start reply remains uncertain
      const r = await this.run(["start", name]);
      if (r.code !== 0) throw new Error(`docker start failed: ${short(r)}`);
    }
    return { port: await this._port(name) };
  }

  /** Stop a desktop. A failed (or timed-out) `docker stop` throws, so callers keep its slot; a missing one is stopped. */
  async _stopRaw(profile) {
    const r = await this.run(["stop", "-t", "10", this._need(profile)]);
    if (r.code !== 0 && !/no such container/i.test(`${r.stderr || ""}${r.stdout || ""}`)) throw new Error(`docker stop failed: ${short(r)}`);
  }

  async _reset(profile) {
    const name = this._need(profile);
    await this.run(["rm", "-f", name]);
    await this.run(["volume", "rm", "-f", volumeName(profile)]);
    try {
      fs.rmSync(this._tokenFile(profile), { force: true });
    } catch {}
  }

  async list() {
    const r = await this.run(["ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.Names}}\t{{.Status}}\t{{.Ports}}"]);
    const out = [];
    for (const line of (r.stdout || "").split("\n")) {
      const [n, status, ports] = line.split("\t");
      if (!n || !n.startsWith("hermes-deck-space-")) continue;
      const m = /127\.0\.0\.1:(\d+)->3211/.exec(ports || "");
      out.push({ profile: n.slice("hermes-deck-space-".length), running: /^Up\b/.test(status || ""), port: m ? Number(m[1]) : null });
    }
    return out;
  }

  async stats() {
    // `docker stats` takes no --filter (Docker 29: "unknown flag"): name this host's running desktops instead. With no
    // names it would report every container on the machine, so nothing running means no stats call at all.
    const ps = await this.run(["ps", "--filter", `label=${LABEL}`, "--filter", "status=running", "--format", "{{.Names}}"]);
    const names = String((ps && ps.stdout) || "").split(/\r?\n/).map((l) => l.trim()).filter((n) => n.startsWith("hermes-deck-space-"));
    if (!names.length) return [];
    const r = await this.run(["stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}", ...names]);
    const out = [];
    for (const line of (r.stdout || "").split("\n")) {
      const [n, mem, cpu] = line.split("\t");
      if (!n || !n.startsWith("hermes-deck-space-")) continue;
      const mm = /([\d.]+)\s*(KiB|MiB|GiB)/.exec(mem || "");
      const mb = mm ? Number(mm[1]) * (mm[2] === "GiB" ? 1024 : mm[2] === "KiB" ? 1 / 1024 : 1) : 0;
      out.push({ profile: n.slice("hermes-deck-space-".length), memMB: Math.round(mb), cpuPct: Number(String(cpu || "0").replace("%", "")) || 0 });
    }
    return out;
  }

  async homeSize(profile) {
    const r = await this.run(["system", "df", "-v", "--format", "{{json .Volumes}}"]);
    try {
      const v = JSON.parse(r.stdout).find((x) => x.Name === volumeName(profile));
      const m = v && /([\d.]+)\s*(B|kB|MB|GB)/.exec(v.Size || "");
      return m ? Math.round(Number(m[1]) * { B: 1, kB: 1e3, MB: 1e6, GB: 1e9 }[m[2]]) : null;
    } catch {
      return null;
    }
  }
}

// Every docker call has a time bound (final review I1): a wedged Docker Desktop or colima VM, or an isolation helper
// whose `apk add` stalls (its `sh` is PID 1 and ignores SIGTERM), must never hang the relay's start, a resolve, the
// sweep or the Deck's poll. On a timeout the CLI gets SIGKILL and the runner answers {code: 124} without waiting for
// that process to exit; archives first await bounded helper removal. Callers treat a non-zero code as a failure.
//   short   15 s  version, inspect, ps, port, stats, network inspect, volume/image listing: answers from the daemon
//   long    60 s  run -d (create), start, stop -t 10, rm, network create/rm, volume rm, system df
//   helper  60 s  the isolation helper (`docker run --rm ...`), which installs iptables with apk first (~1.7 s)
//   archive 120 s offline snapshot helpers; timed-out helpers are removed before the host can unpause
//   pull    never killed by default: a big image takes many minutes on a slow line, and a non-TTY `docker pull` prints
//           a line per layer state only, so one big layer can be silent for a long time. Nothing waits on a pull: the
//           Deck pulls in the background after consent (its poll goes on), the relay never pulls. pullIdleMs (> 0)
//           sets an idle bound renewed by every output line, for callers that want one.
// The helper is named hermes-deck-nethelper-<pid>-<n> so that one that timed out can be removed (`docker rm -f`, best
// effort for isolation, awaited for archives); `docker rm -f $(docker ps -aq --filter name=hermes-deck-nethelper-)` removes any left behind.
const RUN_MS = Object.freeze({ short: 15_000, long: 60_000, helper: 60_000, archive: 120_000, pullIdle: 0 });
const HELPER_PREFIX = "hermes-deck-nethelper-";
const LONG_VERBS = new Set(["run", "create", "start", "stop", "restart", "rm"]);

/** Which bound an argv gets: "short" | "long" | "helper" | "archive" | "pull". */
function runClass(argv) {
  const [a, b] = argv;
  if (a === "pull") return "pull";
  if (a === "run" && argv.includes("--rm") && argv[argv.indexOf("--network") + 1] === "none") return "archive";
  if (a === "run" && argv.includes("--rm")) return "helper";
  if (LONG_VERBS.has(a) || a === "system") return "long";
  if ((a === "network" || a === "volume") && (b === "create" || b === "rm")) return "long";
  return "short";
}

let helperSeq = 0;

/**
 * The real `docker` runner: argv without "docker"; opts.onLine gets each stdout/stderr line (pull progress). No shell.
 * o.bin (or a string, the binary), o.spawnFn (tests), o.shortMs/longMs/helperMs/archiveMs/pullIdleMs (the bounds above).
 */
function dockerRunner(o = {}) {
  const opt = typeof o === "string" ? { bin: o } : o || {};
  const bin = opt.bin || "docker";
  const spawn = opt.spawnFn || require("child_process").spawn;
  const ms = { short: opt.shortMs || RUN_MS.short, long: opt.longMs || RUN_MS.long, helper: opt.helperMs || RUN_MS.helper, archive: opt.archiveMs || RUN_MS.archive, pull: opt.pullIdleMs || RUN_MS.pullIdle }; // pull 0: no bound
  const run = (argv, { onLine } = {}) =>
    new Promise((resolve, reject) => {
      const kind = runClass(argv);
      const name = kind === "helper" || kind === "archive" ? `${HELPER_PREFIX}${process.pid}-${++helperSeq}` : null;
      const full = name ? ["run", "--name", name, ...argv.slice(1)] : argv;
      const p = spawn(bin, full, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      let done = false;
      let timer = null;
      const settle = (fn) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn();
      };
      const finishArchive = async (result) => {
        await run(["rm", "-f", name]).catch(() => {});
        const inspected = await run(["container", "inspect", name]).catch(() => null);
        const gone = inspected && inspected.code !== 0 && /no such (?:container|object):/i.test(inspected.stderr || "");
        resolve({ ...result, helperName: name, cleanupFailed: !gone });
      };
      const arm = () => {
        clearTimeout(timer);
        if (!(ms[kind] > 0)) return; // an unbounded pull
        timer = setTimeout(() => {
          try { p.kill("SIGKILL"); } catch {}
          const result = { code: 124, stdout, stderr: `${stderr}\ntimed out` };
          if (kind === "archive") {
            settle(() => { void finishArchive(result); });
          } else {
            settle(() => resolve(result));
            if (name) run(["rm", "-f", name]).catch(() => {});
          }
        }, ms[kind]);
      };
      arm();
      const feed = (chunk, sink) => {
        const s = String(chunk);
        if (kind === "pull" && !done) arm(); // pull: an idle bound (when set), renewed by every line
        if (onLine && !done) for (const l of s.split(/\r?\n/)) if (l.trim()) onLine(l.trim());
        return sink + s;
      };
      p.stdout.on("data", (c) => (stdout = feed(c, stdout).slice(-(1 << 20))));
      p.stderr.on("data", (c) => (stderr = feed(c, stderr).slice(-(1 << 16))));
      p.on("error", (e) => settle(() => {
        if (kind === "archive") void finishArchive({ code: 1, stdout, stderr: e.message });
        else reject(e);
      }));
      p.on("close", (code) => settle(() => {
        const result = { code: code ?? 1, stdout, stderr };
        if (kind === "archive" && code !== 0) void finishArchive(result);
        else resolve(result);
      }));
    });
  return run;
}

module.exports = { DesktopHost, containerName, volumeName, PROFILE_RE, NET_SCRIPTS, SNAP_SCRIPTS, NET_NAME: NET, dockerRunner, runClass, RUN_MS, HELPER_PREFIX };
