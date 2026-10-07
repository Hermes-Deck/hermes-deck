"use strict";
// This Deck computer as an agent-desktop host (agent spaces phase 2, spec 2026-10-07 sections 4.1, 5, 7 and 10).
// The user turns it on in Settings > This device > Agent desktops (consent sheet first, in the renderer); from then on:
//   - the pinned image is pulled once, in the background, with progress in Settings (never at an agent's first call);
//   - Docker, the image and the running desktops are polled every 10 s, and the state is pushed to the renderer;
//   - the presence heartbeat carries desktops:{ready, limit, running} (null while hosting is off), so the relay
//     (relay/src/presence.js, relay/src/desktops.js) can pick this computer as an agent's home host;
//   - the relay starts, stops and reaches the desktops over this Deck's own relay connection ([0xD6] frames,
//     space-tunnel.js): no inbound port. The relay owns per-agent allow lists and idle stops; this module refuses
//     anything while hosting is off and refuses a start that would go past this computer's own limit;
//   - the network isolation rules (DesktopHost.netCheck) are re-checked every 60 s while a desktop runs; if they are
//     gone and cannot be repaired, every desktop stops and the host reports not ready until a later check passes;
//   - turning hosting off, or quitting the app, stops every desktop here (stopped, not removed: home folders stay).
// Network and run options are DesktopHost's (desktop-host.js), which holds Task 1's decision as constants; see
// docs/agent-spaces.md ("Limits and isolation"). Pure Node (no electron import): main.js passes ipc, settings, presence.
const { DesktopHost, dockerRunner, containerName } = require("./desktop-host");
const { SpaceTunnelServer, NOT_HOSTING } = require("./space-tunnel");
const { MAGIC } = require("./space-tunnel-frames");

const POLL_MS = 10_000; // Docker / image / running desktops, while hosting is on
const ISO_MS = 60_000; // isolation rules re-checked at most this often
const HOME_MS = 60_000; // `docker system df -v` is slow: a home folder's size is refreshed at most this often
const PULL_RETRY_MS = 5 * 60_000; // a failed pull is tried again after this long (consent was given already)
const LIMIT_ERROR = "this computer is at its desktop limit";
const ISO_ERROR = "network isolation is not verified on this computer";
const IMAGE_ERROR = "the desktop image is not downloaded yet";
const DOCKER_ERROR = "Docker is not running on this computer";

const IDLE_DEFAULT = 20;
/** Idle minutes for the heartbeat: a whole number in 5..240, 20 when unset or not a number. */
const idleOf = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.min(240, Math.max(5, Math.round(v))) : IDLE_DEFAULT);

/**
 * The presence heartbeat's desktops field: ready only with hosting on, Docker ready, the image present (and isolation
 * holding). idleMin is this computer's idle time for its desktops: the relay owns idle stops (it alone sees agent
 * actions and viewers) and applies each host's own value.
 */
function heartbeatField({ host, docker, image, limit, running, idleMin, isolated = true }) {
  return { ready: host === true && docker === "ready" && image === "present" && isolated !== false, limit, running, idleMin: idleOf(idleMin) };
}

// `docker pull` (not a TTY) prints one "<layer>: <status>" line per change. A layer is done when pulled or present.
const LAYER_RE = /^([A-Za-z0-9]{2,64}): (Pulling fs layer|Waiting|Downloading.*|Verifying Checksum|Download complete|Extracting.*|Pull complete|Already exists)\s*$/;
const LAYER_DONE = new Set(["Pull complete", "Already exists"]);

/** Pull progress: feed it docker's lines, read a whole percentage of the layers done. */
function pullPct() {
  const layers = new Map(); // id -> done
  return {
    line(l) {
      const m = LAYER_RE.exec(String(l || "").trim());
      if (!m) return;
      layers.set(m[1], layers.get(m[1]) === true || LAYER_DONE.has(m[2]));
    },
    pct() {
      if (!layers.size) return 0;
      let done = 0;
      for (const v of layers.values()) if (v) done += 1;
      return Math.floor((done * 100) / layers.size);
    },
  };
}

/** Quit: the stop goes to a detached docker process, so it finishes after the Deck has exited. */
function detachDocker(argv) {
  const { spawn } = require("child_process");
  const p = spawn("docker", argv, { detached: true, stdio: "ignore", windowsHide: true });
  p.on("error", () => {});
  p.unref();
}

const short = (e) => String((e && e.message) || e || "error").slice(0, 300);

/**
 * @param {object} o
 * @param {object} o.ipc       appIpc(ipcMain)-like: handle(channel, fn)
 * @param {object} o.settings  Settings: data.desktops, updateDesktopsHost(on), publicView()
 * @param {object} o.presence  DevicePresence: setDesktops(fn), push()
 * @param {(ch: string, msg: any) => void} o.send  renderer push
 * @param {string} o.dataDir   where DesktopHost keeps the container tokens (userData/desktops)
 * @param {boolean} [o.shot]  screenshot run: read-only, never touches Docker
 * Tests pass host (a fake DesktopHost), now, setInterval/clearInterval and detach.
 */
function initDesktops({ ipc, settings, presence, send = () => {}, dataDir, host = null, runner = null, pin = require("./desktops-pin.json"),
  now = () => Date.now(), setInterval: setIv = setInterval, clearInterval: clearIv = clearInterval, detach = detachDocker, shot = false }) {
  const cfg = () => settings.data.desktops || {};
  const hosting = () => cfg().host === true;
  const dh = host || new DesktopHost({ run: runner || dockerRunner(), pin, dataDir, opts: { memory: cfg().memory, cpus: cfg().cpus }, now });

  // docker: unknown|missing|stopped|ready; image: absent|pulling|present; list: DesktopHost.list() as last seen;
  // running: what Settings shows; isolation: false after a failed check that could not be repaired
  const S = { docker: "unknown", image: "absent", pull: null, error: null, isolation: true, list: [], running: [] };
  const homes = new Map(); // profile -> {bytes, at}
  const inflight = new Map(); // profile -> starts in progress (a profile holds one slot until its last start settles)
  const mine = new Set(); // profiles started in this session (the first look stops any other running desktop)
  let swept = false; // the first look with Docker ready has stopped an earlier run's leftovers
  let gen = 0; // hosting generation: bumped on every on/off, so a start that outlives a switch is undone
  let timer = null;
  let polling = null;
  let pulling = null;
  let pullFailedAt = null;
  let lastIso = null;
  let lastProbe = null;
  let lastSent = "";
  let lastBeat = "";
  let quitDone = false;

  const runningCount = () => S.list.filter((d) => d && d.running).length;
  const field = () => heartbeatField({ host: hosting(), docker: S.docker, image: S.image, limit: cfg().limit, running: runningCount(), idleMin: cfg().idleMin, isolated: S.isolation });

  function state() {
    return {
      docker: S.docker,
      image: S.image,
      pull: S.pull ? { ...S.pull } : null,
      host: hosting(),
      limit: cfg().limit,
      running: S.running.map((r) => ({ ...r })),
      error: S.error,
      isolation: S.isolation,
      sizeBytes: Number(pin && pin.sizeBytes) || 0,
    };
  }

  /** Push the state to the renderer and the heartbeat to the relay, each only when it changed. */
  function changed() {
    const st = state();
    const j = JSON.stringify(st);
    if (j !== lastSent) {
      lastSent = j;
      try {
        send("desktops", st);
      } catch {}
    }
    const b = JSON.stringify(hosting() ? field() : null);
    if (b !== lastBeat) {
      lastBeat = b;
      try {
        presence.push();
      } catch {}
    }
  }

  presence.setDesktops(() => (hosting() ? field() : null));

  async function listNow() {
    try {
      const l = await dh.list();
      return Array.isArray(l) ? l.filter((d) => d && containerName(d.profile)) : [];
    } catch {
      return [];
    }
  }

  async function refreshRunning() {
    const run = S.list.filter((d) => d.running);
    let stats = [];
    try {
      stats = run.length ? await dh.stats() : [];
    } catch {}
    const out = [];
    for (const d of run) {
      const s = (Array.isArray(stats) ? stats : []).find((x) => x && x.profile === d.profile) || {};
      let h = homes.get(d.profile);
      if (!h || now() - h.at >= HOME_MS) {
        let bytes = null;
        try {
          bytes = await dh.homeSize(d.profile);
        } catch {}
        h = { bytes: Number.isFinite(bytes) ? bytes : null, at: now() };
        homes.set(d.profile, h);
      }
      out.push({ profile: d.profile, memMB: Number(s.memMB) || 0, cpuPct: Number(s.cpuPct) || 0, homeBytes: h.bytes });
    }
    S.running = out;
  }

  /** Ruling 3: every 60 s while hosting and a desktop runs (and while failed, to recover): check, repair, else stop all. */
  async function isoGuard() {
    if (!hosting() || S.docker !== "ready") return;
    if (S.isolation && !runningCount()) return;
    const t = now();
    if (lastIso !== null && t - lastIso < ISO_MS) return;
    lastIso = t;
    const check = async () => {
      try {
        return (await dh.netCheck()) === true;
      } catch {
        return false;
      }
    };
    let ok = await check();
    if (!ok) {
      try {
        await dh.netRepair();
      } catch {}
      ok = await check();
    }
    if (ok) {
      S.isolation = true;
      return;
    }
    S.isolation = false;
    if (runningCount()) await stopAll();
  }

  function startPull() {
    // the desktop image weighs 95% of the bar, the small helper image (isolation rules) 5%
    const img = pullPct();
    const helper = pullPct();
    S.image = "pulling";
    S.pull = { pct: 0 };
    S.error = null;
    changed();
    pulling = (async () => {
      try {
        await dh.pull((l, which) => {
          (which === "helper" ? helper : img).line(l);
          const pct = Math.floor(0.95 * img.pct() + 0.05 * helper.pct());
          if (S.pull && S.pull.pct !== pct) {
            S.pull = { pct };
            changed();
          }
        });
        S.image = "present";
        pullFailedAt = null;
        S.error = null;
      } catch (e) {
        S.image = "absent";
        pullFailedAt = now();
        S.error = short(e);
      } finally {
        S.pull = null;
        pulling = null;
        changed();
      }
    })();
    return pulling;
  }

  function maybePull() {
    if (!hosting() || S.docker !== "ready" || S.image !== "absent" || pulling) return;
    if (pullFailedAt !== null && now() - pullFailedAt < PULL_RETRY_MS) return;
    startPull();
  }

  /** One look at Docker; with hosting on also the desktops, their numbers, isolation and the pull. */
  function poll() {
    if (polling) return polling;
    polling = (async () => {
      try {
        try {
          S.docker = await dh.docker();
        } catch {
          S.docker = "stopped";
        }
        lastProbe = now();
        if (S.docker === "ready" && !pulling) {
          try {
            S.image = (await dh.imagePresent()) ? "present" : "absent";
          } catch {}
        }
        if (S.docker === "ready") {
          S.list = await listNow();
          await sweepLeftovers();
        } else S.list = [];
        if (S.docker === "ready" && hosting()) {
          await refreshRunning();
          await isoGuard();
          maybePull();
        } else S.running = [];
      } finally {
        polling = null;
        changed();
      }
    })();
    return polling;
  }

  /**
   * Spec section 5: a Deck host stops its desktops when it closes, so none should run when it starts. A crash (or a
   * kill) leaves them running, unseen and holding slots: the first look with Docker ready stops every desktop this
   * session did not start.
   */
  async function sweepLeftovers() {
    if (swept) return;
    swept = true;
    const left = S.list.filter((d) => d.running && !mine.has(d.profile) && !inflight.has(d.profile));
    if (!left.length) return;
    await Promise.all(left.map((d) => Promise.resolve().then(() => dh.stop(d.profile)).catch(() => {})));
    S.list = await listNow();
  }

  function startTimer() {
    if (timer) return;
    timer = setIv(() => poll().catch(() => {}), POLL_MS);
    if (timer && timer.unref) timer.unref();
  }

  function stopTimer() {
    if (timer) clearIv(timer);
    timer = null;
  }

  /** Stop every running desktop on this computer (hosting off, isolation lost). Docker gone: nothing to stop. */
  async function stopAll() {
    let list;
    try {
      list = await dh.list();
    } catch {
      return;
    }
    const run = (Array.isArray(list) ? list : []).filter((d) => d && d.running && containerName(d.profile));
    await Promise.all(run.map((d) => Promise.resolve().then(() => dh.stop(d.profile)).catch(() => {})));
    S.list = await listNow();
    S.running = S.running.filter((r) => S.list.some((d) => d.running && d.profile === r.profile));
    changed();
  }

  /** App quit: one detached `docker stop` for what runs (or is starting); safe to call more than once. */
  function quit() {
    if (quitDone || shot) return;
    quitDone = true;
    stopTimer();
    // whatever the switch says: a desktop the off switch could not stop, or one still starting, stops too
    const profiles = [...new Set([...S.list.filter((d) => d.running).map((d) => d.profile), ...inflight.keys()])];
    const names = profiles.map(containerName).filter(Boolean);
    if (!names.length) return;
    try {
      detach(["stop", "-t", "10", ...names]);
    } catch {}
  }

  function noteRunning(profile, running, port = null) {
    const d = S.list.find((x) => x.profile === profile);
    if (d) {
      d.running = running;
      if (port) d.port = port;
    } else if (running) S.list.push({ profile, running: true, port });
    if (!running) S.running = S.running.filter((r) => r.profile !== profile);
  }

  // What the relay may do here (SpaceTunnelServer's host). The tunnel itself refuses everything while allowed() is
  // false; ensure is also gated on this computer's limit (ruling 2: a compromised relay cannot start more).
  const gated = {
    ...Object.fromEntries(["snapshot", "snapshots", "restore", "dropSnapshot"].map((op) => [op, async (p, ...args) => {
      if (!hosting() || !containerName(p)) throw new Error(NOT_HOSTING);
      const g = gen;
      const result = await dh[op](p, ...args);
      if (g !== gen || !hosting()) throw new Error(NOT_HOSTING);
      if (op === "restore") { noteRunning(p, false); changed(); }
      return result;
    }])),
    list: () => dh.list(),
    tokenOf: (p) => dh.tokenOf(p),
    async stop(p, { keep } = {}) {
      if (Number.isInteger(keep) && keep >= 1 && keep <= 100) dh.opts = { ...dh.opts, snapshotKeep: keep };
      await dh.stop(p);
      noteRunning(p, false);
      changed();
    },
    async ensure(p) {
      if (!hosting()) throw new Error(NOT_HOSTING);
      if (!S.isolation) throw new Error(ISO_ERROR);
      if (S.docker !== "ready") throw new Error(DOCKER_ERROR);
      if (S.image !== "present") throw new Error(IMAGE_ERROR);
      const g = gen;
      if (dh.snapshotBusy?.(p)) throw new Error("desktop operation in progress");
      const list = await dh.list();
      if (g !== gen || !hosting()) throw new Error(NOT_HOSTING); // switched while we looked
      if (dh.snapshotBusy?.(p)) throw new Error("desktop operation in progress");
      const others = new Set((Array.isArray(list) ? list : []).filter((d) => d && d.running && d.profile !== p).map((d) => d.profile));
      for (const q of inflight.keys()) if (q !== p) others.add(q);
      if (others.size >= cfg().limit) throw new Error(LIMIT_ERROR); // checked and reserved with no await between
      inflight.set(p, (inflight.get(p) || 0) + 1);
      mine.add(p);
      try {
        dh.opts = { ...dh.opts, memory: cfg().memory, cpus: cfg().cpus }; // used when the container is created
        const r = await dh.ensure(p);
        if (g !== gen || !hosting() || !S.isolation) {
          // hosting was switched (or isolation lost) while it started: stopAll did not see it, so stop it here
          try {
            await dh.stop(p);
          } catch {}
          noteRunning(p, false);
          throw new Error(NOT_HOSTING);
        }
        noteRunning(p, true, r && r.port);
        return r;
      } finally {
        const n = (inflight.get(p) || 1) - 1;
        if (n > 0) inflight.set(p, n);
        else inflight.delete(p);
        changed();
      }
    },
  };

  // ---- the relay connection ----
  let relay = null;
  let tunnel = null;
  let onFrame = null;
  let onStatus = null;

  /** Serve the [0xD6] space tunnel on this relay connection (null detaches). Other binary frames are not ours. */
  function attachRelay(r) {
    if (relay) {
      relay.off("frame", onFrame);
      relay.off("status", onStatus);
    }
    if (tunnel) tunnel.closeAll("relay connection replaced");
    relay = r || null;
    tunnel = null;
    if (!r) return;
    const t = new SpaceTunnelServer({ host: gated, send: (b) => (relay === r ? r.send(b) : false), allowed: () => hosting() });
    tunnel = t;
    onFrame = (raw) => {
      let b;
      try {
        b = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
      } catch {
        return;
      }
      if (b.length && b[0] === MAGIC) t.onFrame(b); // [0xCD] CDP and [0xD5] driver frames belong to their own consumers
    };
    onStatus = (s) => {
      if (s && s.status !== "open") t.closeAll("relay connection lost");
    };
    r.on("frame", onFrame);
    r.on("status", onStatus);
  }

  // ---- renderer IPC (the main window only: ipc is appIpc) ----
  const needProfile = (p) => {
    if (shot) throw new Error("not in a screenshot run");
    if (!containerName(p)) throw new Error("bad profile");
    return p;
  };

  ipc.handle("desktops:state", async () => {
    if (shot) return state();
    // hosting off: a light look (is Docker there?) so Settings can say what turning it on needs
    if (!timer && (lastProbe === null || now() - lastProbe >= POLL_MS)) await poll();
    return state();
  });
  ipc.handle("desktops:host", async (_e, on) => {
    if (shot) throw new Error("not in a screenshot run");
    const want = on === true;
    settings.updateDesktopsHost(want);
    gen += 1; // a start in flight from before this switch is undone when it lands
    if (want) {
      quitDone = false;
      startTimer();
      await poll();
    } else {
      stopTimer();
      if (tunnel) tunnel.closeAll("agent desktops were switched off on this device", true);
      lastIso = null;
      S.isolation = true;
      stopAll().catch(() => {}); // pushes the state when the desktops are down
    }
    changed();
    return { settings: settings.publicView(), state: state() };
  });
  ipc.handle("desktops:stop", async (_e, profile) => {
    const p = needProfile(profile);
    await dh.stop(p);
    noteRunning(p, false);
    changed();
    return state();
  });
  ipc.handle("desktops:reset", async (_e, profile) => {
    const p = needProfile(profile);
    await dh.reset(p);
    S.list = S.list.filter((d) => d.profile !== p);
    S.running = S.running.filter((r) => r.profile !== p);
    homes.delete(p);
    changed();
    return state();
  });

  if (hosting() && !shot) {
    startTimer();
    poll().catch(() => {});
  }

  return {
    attachRelay,
    safetyPolicy: (s) => {
      if (Number.isInteger(s?.snapshotKeep) && s.snapshotKeep >= 1 && s.snapshotKeep <= 100)
        dh.opts = { ...dh.opts, snapshotKeep: s.snapshotKeep };
    },
    /** This Deck's own loopback viewer (Task 9): the port of a running desktop here, or null. */
    async port(profile) {
      if (!hosting() || !containerName(profile)) return null;
      const d = (await listNow()).find((x) => x.profile === profile && x.running);
      return d && Number.isInteger(d.port) && d.port > 0 ? d.port : null;
    },
    /** The container token, for this Deck's own loopback fetches only (never sent anywhere). */
    token(profile) {
      if (!hosting() || !containerName(profile)) return null;
      try {
        return dh.tokenOf(profile) || null;
      } catch {
        return null;
      }
    },
    stopAll,
    quit,
    /** The generic settings save changed desktops.* (limit, memory ...): push the new state and heartbeat. */
    settingsChanged: () => changed(),
    _test: { poll, state },
  };
}

module.exports = { heartbeatField, pullPct, initDesktops, LIMIT_ERROR, ISO_ERROR, IMAGE_ERROR, POLL_MS, ISO_MS };
