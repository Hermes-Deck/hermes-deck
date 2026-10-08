"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadEnvFile, home, readJson, atomicWriteJson, normUsage } = require("./util");
const { Tailer } = require("./tailer");
const { ClaudeSource } = require("./claude");
const { Model } = require("./model");
const { Fleet } = require("./fleet");
const { HostUsage } = require("./usage");
const { createServer } = require("./server");
const { History } = require("./history"); // sub-agent views (B1/B3): message history on demand
const { PlanStore } = require("./plan"); // the Plan tab: stored plans from state.db, on demand
const { Presence } = require("./presence");
const { CdpGateway, createCdpServer } = require("./cdp");
const { FallbackHost, hostName, parseExternalCdp } = require("./browser");
const { WorkspaceHub } = require("./workspace"); // Workspace tab: host picks, the agent host's browser view
const { Driver, driverConfig } = require("./driver");
const wire = require("./driver-wire");
const { Spaces } = require("./spaces"); // agent spaces: locks, viewers, per-agent desktops
const { makeSpaceFetch, makeReady } = require("./space-fetch"); // phase 2: HTTP to an agent desktop (MCP, /health)
const { SpaceLock } = require("./space-lock");
const { SpaceAudit } = require("./space-audit");
const { SpaceApprovals } = require("./space-approvals");
const { compilePatterns } = require("./risky-commands");
const { Desktops } = require("./desktops"); // agent spaces phase 2: which agent desktop runs where
const { SpaceTunnel } = require("./space-tunnel"); // phase 2: desktops a Deck computer hosts, over its relay connection
const { BundleStore } = require("./bundles");
const { BrowserTransfers } = require("./browser-transfer");
const { loadIdentity } = require("./browser-bundle");

const { MobileRelay } = require("./mobile");
const { MobilePushClient } = require("./mobile-push");

const compat = require("./compat"); // product version, wire protocol, each profile's plugin version
const { HermesStore } = require("./history");
const { HermesConfig, hermesConfigOptions } = require("./hermes-config"); // Settings > Hermes config, restarts

const VERSION = compat.VERSION;

const list = (v) => String(v || "").split(",").map((x) => x.trim()).filter(Boolean);
const on = (v) => /^(1|true|yes|on)$/i.test(String(v || "").trim());
const GIB = 1024 ** 3;
const intIn = (v, lo, hi) => {
  const t = String(v ?? "").trim();
  const n = Number(t);
  return t !== "" && Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : null;
};

/**
 * Agent spaces phase 2 settings: whether the agent host itself hosts agent desktops (DECK_DESKTOPS_HOST=1), how many
 * at once (DECK_DESKTOPS_LIMIT; default 1, or 0 below 16 GB of RAM), their idle minutes, and whether an agent without
 * a desktop of its own falls back to the shared one (DECK_SPACES_SHARED_FALLBACK, default 1).
 */
function desktopsConfig(env = process.env, mem = os.totalmem()) {
  const set = intIn(env.DECK_DESKTOPS_LIMIT, 0, 16);
  const lowMem = set === null && mem < 16 * GIB;
  return {
    host: on(env.DECK_DESKTOPS_HOST),
    limit: set !== null ? set : lowMem ? 0 : 1,
    lowMem,
    idleMin: intIn(env.DECK_DESKTOPS_IDLE_MIN, 5, 240) ?? 20,
    sharedFallback: !/^(0|false|no|off)$/i.test(String(env.DECK_SPACES_SHARED_FALLBACK || "").trim()),
    // the agents that may have a desktop of their own (spec section 10); unset or empty: every configured agent
    agents: list(env.DECK_DESKTOPS_AGENTS).length ? list(env.DECK_DESKTOPS_AGENTS) : null,
  };
}

/** All settings come from the environment (see .env.example); nothing here is specific to one install. */
function config(env = process.env, mem = os.totalmem()) {
  return {
    host: env.DECK_RELAY_HOST || "127.0.0.1",
    port: Number(env.DECK_RELAY_PORT || 9330),
    token: env.DECK_RELAY_TOKEN || "",
    mobileDevicesFile: env.DECK_MOBILE_DEVICES_FILE || home(".hermes-deck", "mobile-devices.json"),
    mobileBridge: { mode: env.DECK_MOBILE_BRIDGE_STREAM ? "local" : "off", python: env.DECK_MOBILE_BRIDGE_PYTHON || "python3", stream: env.DECK_MOBILE_BRIDGE_STREAM || "" },
    queryToken: on(env.DECK_RELAY_QUERY_TOKEN), // also accept ?token= on the WebSocket (off: header only)
    eventsDir: env.DECK_EVENTS_DIR || home(".hermes-deck", "events"),
    stateDir: env.DECK_STATE_DIR || home(".hermes-deck", "state"),
    dataDir: env.DECK_DATA_DIR || path.join(__dirname, "..", "data"),
    remoteUpdate: env.DECK_REMOTE_UPDATE !== "0",
    hermesBin: env.DECK_HERMES_BIN || (fs.existsSync(home(".local", "bin", "hermes")) ? home(".local", "bin", "hermes") : "hermes"),
    agentsFile: env.DECK_AGENTS || path.join(__dirname, "..", "agents.json"),
    claudeDirs: list(env.CLAUDE_PROJECT_DIRS),
    claudeProfile: env.CLAUDE_PROFILE || "claude-code",
    claudeChatMap: env.CLAUDE_CHAT_MAP || null,
    launchdPrefixes: list(env.DECK_LAUNCHD_PREFIXES || "ai.hermes."),
    codexbar: env.CODEXBAR === "" ? null : env.CODEXBAR || "/opt/homebrew/bin/codexbar",
    broadcastWindowS: 300, // live events older than this (history replays) are not pushed
    tickMs: Number(env.DECK_TICK_MS || 1000),
    // message history (read-only): Hermes' root with state.db and profiles/<p>/state.db; DECK_HISTORY=0 turns it off
    hermesRoot: env.HERMES_ROOT || home(".hermes"),
    history: env.DECK_HISTORY !== "0",
    // Workspace tab: Hermes reaches its agent's browser at http://127.0.0.1:<port>/agent/<profile>
    cdp: {
      port: /^(0|off|false|no)$/i.test(String(env.DECK_CDP_PORT || "").trim()) ? null : Number(env.DECK_CDP_PORT || 9333),
      defaultAgent: String(env.DECK_CDP_DEFAULT_AGENT || "default").trim().toLowerCase(),
      // agent host browser, two kinds (browser.js): a headless Chrome per agent (DECK_FALLBACK_BROWSER=1) and/or ONE
      // already running browser attached over its loopback debugging port (DECK_FALLBACK_BROWSER_CDP=http://127.0.0.1:9222)
      fallback: on(env.DECK_FALLBACK_BROWSER), // off by default
      browserPath: env.DECK_FALLBACK_BROWSER_PATH || null,
      externalCdp: env.DECK_FALLBACK_BROWSER_CDP || null,
      externalAgent: String(env.DECK_FALLBACK_BROWSER_CDP_AGENT || env.DECK_CDP_DEFAULT_AGENT || "default").trim().toLowerCase(),
      // "Otomatik" for the browser: "host" = the agent host's browser first (default), "device" = the user's active deck first
      browserDefault: /^device$/i.test(String(env.DECK_BROWSER_DEFAULT || "").trim()) ? "device" : "host",
    },
    // this machine's name in the Deck's host picker (default: macOS computer name, else the host name)
    hostName: env.DECK_HOST_NAME || null,
    // Bot screen: computer_use on the user's own devices (driver.js, relay/bin/deck-cua)
    driver: driverConfig(env),
    // Agent spaces: shared = take turns, agent = one each, overflow = shared first, own desktop when busy.
    // agent and overflow use the same desktop registry; DECK_SPACES_STICKY_SEC is parsed by driverConfig.
    spaces: /^(shared|agent|overflow)$/i.test(String(env.DECK_SPACES || "").trim())
      ? { mode: String(env.DECK_SPACES).trim().toLowerCase(), url: env.DECK_SPACESD_URL || "http://127.0.0.1:3211", tokenFile: wire.expandHome(env.DECK_SPACESD_TOKEN_FILE || "~/.cua-spacesd/token") }
      : null,
    safety: { auditEnv: { DECK_AUDIT: env.DECK_AUDIT, DECK_AUDIT_DAYS: env.DECK_AUDIT_DAYS, DECK_SNAPSHOT_KEEP: env.DECK_SNAPSHOT_KEEP }, riskyPatternsFile: env.DECK_RISKY_PATTERNS_FILE || null },
    desktops: desktopsConfig(env, mem),
    hermesConfig: hermesConfigOptions(env),
  };
}

/**
 * Deck connections carry device heartbeats (presence.js), CDP tunnel frames (cdp.js), driver frames (driver.js)
 * and Workspace requests (workspace.js: host picks, the agent host's browser view).
 */
function deckHooks(presence, gateway, driver = null, workspace = null, bundles = null, spaces = null, spaceTunnel = null) {
  return {
    // tunnelled CDP answers, driver output (screenshots) and space tunnel answers ([0xD6], viewer files, MCP) are large
    maxPayload: gateway || driver || spaces || spaceTunnel ? 64 * 1024 * 1024 : undefined,
    onConnect(ws) {
      presence.connect(ws);
      if (gateway) gateway.addDeck(ws);
      if (driver) driver.addDeck(ws);
      ws.send(JSON.stringify(presence.state()));
      if (workspace) workspace.onConnect(ws);
    },
    onMessage(ws, data, isBinary) {
      if (ws.mobileDevice) {
        if (isBinary || data.length > 64 * 1024) return true;
        let m; try { m = JSON.parse(data); } catch { return true; }
        if (!m || typeof m !== "object") return true;
        if (m.t === "heartbeat") {
          presence.heartbeat(ws, { ...m, device: { id: ws.mobileDevice.id, name: m.device?.name || "iPhone" }, hosting: { browser: false, desktop: false }, driverOk: false });
          return true;
        }
        if (m.t === "ws-input" && workspace?.holders.get(String(m.slug || "")) !== ws) return true;
        if (m.t === "ws-req" && ["navigate", "history", "reload", "new-tab", "close-tab"].includes(m.op) && workspace?.holders.get(String(m.slug || "")) !== ws) {
          ws.send(JSON.stringify({ t: "ws-res", id: m.id, ok: false, error: "Take control first" }));
          return true;
        }
        if (m.t === "ws-req" && m.op === "control" && m.who !== "user" && workspace?.holders.get(String(m.slug || "")) !== ws) return true;
        if (m.t === "ws-req" || m.t === "ws-input") return !!workspace?.onMessage(ws, m);
        return !["ping", "resync"].includes(m.t);
      }
      if (isBinary) {
        if (spaceTunnel && spaceTunnel.onFrame(ws, data)) return true; // agent spaces phase 2: [0xD6] space tunnel frames
        if (driver && driver.onFrame(ws, data)) return true; // bot screen: [0xD5] driver frames
        if (gateway) gateway.onFrame(ws, data);
        return true;
      }
      if (data.length > 64 * 1024) return false; // heartbeats are tiny; Workspace requests and input (a paste) small
      let m;
      try {
        m = JSON.parse(data);
      } catch {
        return false;
      }
      if (!m || typeof m !== "object") return false;
      if (m.t === "devices?") {
        // The Deck lost the one-shot state sent on connect (its window reloaded, or loaded after it): send it again.
        ws.send(JSON.stringify(presence.state()));
        if (workspace) workspace.onConnect(ws);
        return true;
      }
      if (bundles && bundles.onMessage(ws, m)) {
        if (workspace?.transfers) workspace.transfers.connected(ws);
        return true;
      }
      if (m.t === "heartbeat") {
        presence.heartbeat(ws, m);
        return true;
      }
      return !!(workspace && workspace.onMessage(ws, m));
    },
    onClose(ws) {
      if (bundles) bundles.onClose(ws);
      presence.disconnect(ws);
      if (gateway) gateway.removeDeck(ws);
      if (driver) driver.removeDeck(ws);
      if (spaceTunnel) spaceTunnel.removeDeck(ws); // its pending requests fail now, its view sockets close
      if (workspace) workspace.onClose(ws);
    },
    // agent spaces (/spaces*), then the bot screen (POST /desktop/*, GET /cu/*)
    onUpgrade: spaces ? (req, socket, head, url) => spaces.onUpgrade(req, socket, head, url) : null, // the space viewer's media socket
    onHttp: spaces || driver ? (req, res, url) => (spaces && spaces.onHttp(req, res, url)) || (driver ? driver.onHttp(req, res, url) : false) : null,
  };
}

/**
 * The agent host as a desktop host (DECK_DESKTOPS_HOST=1): app/main/desktop-host.js driving Docker or colima, or null
 * (with the reason logged) when the source layout lacks it, Docker is not running, or the pinned images are absent
 * (images are never pulled at an agent's first call: `docker pull` them, then restart the relay).
 */
async function agentHostDesktops(cfg, dcfg) {
  let mod, pin;
  try {
    mod = require("../../app/main/desktop-host");
    pin = require("../../app/main/desktops-pin.json");
  } catch {
    console.warn("deck-relay: DECK_DESKTOPS_HOST=1 needs the full Hermes Deck source layout including app/main/desktop-host.js; this machine hosts no agent desktops");
    return null;
  }
  const host = new mod.DesktopHost({ run: dcfg.runner || mod.dockerRunner(), pin, dataDir: path.join(cfg.dataDir, "desktops") });
  const docker = await host.docker().catch(() => "stopped");
  if (docker !== "ready") {
    console.warn(`deck-relay: DECK_DESKTOPS_HOST=1 but Docker (or colima) is ${docker}; this machine hosts no agent desktops until the relay restarts with it running`);
    return null;
  }
  if (!(await host.imagePresent().catch(() => false))) {
    const imgs = [host.image, host.helperImage].filter(Boolean).join(" and ");
    console.warn(`deck-relay: DECK_DESKTOPS_HOST=1 but the pinned images are not here; pull ${imgs} with docker pull, then restart the relay`);
    return null;
  }
  if (dcfg.lowMem) console.warn("deck-relay: this machine has less than 16 GB of RAM: it hosts no agent desktops (DECK_DESKTOPS_LIMIT=0) unless DECK_DESKTOPS_LIMIT is set");
  return host;
}

/** Start the relay. Returns {server, port, cdpPort, model, fleet, presence, gateway, stop()} (stop saves the checkpoint). */
async function start(cfg) {
  if (!cfg.token || cfg.token.length < 24) throw new Error("DECK_RELAY_TOKEN missing or shorter than 24 chars");
  if (cfg.mobileDevicesFile && cfg.driver?.tokensFile && path.resolve(cfg.mobileDevicesFile) === path.resolve(cfg.driver.tokensFile)) throw new Error("Mobile and desktop token stores must be separate");
  const agents = readJson(cfg.agentsFile, { profiles: {} });
  if (cfg.spaces && agents && agents.profiles && Object.prototype.hasOwnProperty.call(agents.profiles, "host")) {
    console.warn('deck-relay: a Hermes profile named "host" gets no desktop of its own: "host" is the shared desktop\'s id in agent spaces');
  }
  const cpFile = path.join(cfg.dataDir, "checkpoint.json");
  const cp = readJson(cpFile, null) || { files: {}, roll: {} };
  cp.files = cp.files || {};
  const model = new Model(agents, cp.roll || {}, { fine: cp.fine || {}, months: cp.months || {} });
  const queue = [];

  let spaces = null; // agent spaces (set below, once the model exists)
  const ingest = (ev, live) => {
    ev.agent = model.agentName(ev.profile);
    model.apply(ev, live);
    if (spaces && ev.type === "turn_end" && ev.profile) spaces.release(ev.profile); // turn over: the shared desktop is free
    const ts = ev.type === "cu" && typeof ev.ts === "number" ? ev.ts / 1000 : ev.ts; // bot-screen `cu` events carry ms
    if (live && typeof ts === "number" && Date.now() / 1000 - ts < cfg.broadcastWindowS) queue.push(ev);
  };

  // --- sources ---------------------------------------------------------------------------------
  const hermes = new Map(); // file -> Tailer
  const scanHermes = () => {
    let names = [];
    try {
      names = fs.readdirSync(cfg.eventsDir);
    } catch {
      /* plugin has not written yet */
    }
    for (const n of names) {
      if (!n.endsWith(".ndjson")) continue;
      const file = path.join(cfg.eventsDir, n);
      if (hermes.has(file)) continue;
      const t = new Tailer(
        file,
        (line, live) => {
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            return;
          }
          if (ev.usage) ev.usage = normUsage(ev.usage);
          ingest(ev, live);
        },
        { checkpoint: cp.files[file] || null, warmBytes: 2 * 1024 * 1024 }
      );
      hermes.set(file, t);
    }
  };
  const claude = new ClaudeSource({ dirs: cfg.claudeDirs || [], profile: cfg.claudeProfile, chatMapFile: cfg.claudeChatMap, checkpoints: cp.files, onEvent: ingest });

  let broadcast = () => {};
  const fleet = new Fleet({
    stateDir: cfg.stateDir,
    codexbar: cfg.codexbar,
    launchdPrefixes: cfg.launchdPrefixes,
    onChange: (data) => broadcast({ t: "fleet", fleet: data }),
  });

  model.externalProfile = cfg.claudeProfile;
  model.externalAgent = cfg.claudeProfile ? model.agentName(cfg.claudeProfile) : null;
  const usage = cfg.hermesRoot ? new HostUsage({ root: cfg.hermesRoot, model,
    onChange: status => {
      fleet.data.usage = status;
      broadcast({ t: "agents", agents: model.agents(), tokens: model.tokens(7) });
      fleet._changed();
    } }) : null;
  if (usage) usage.refresh();

  // --- first pass before serving, so the first snapshot is complete -------------------------------
  claude.refreshChats();
  scanHermes();
  for (const t of hermes.values()) t.poll();
  claude.scan();
  claude.poll();
  queue.length = 0;
  model.dirty.clear();

  const saveCheckpoint = () => {
    const files = { ...cp.files, ...claude.checkpointAll() };
    for (const [file, t] of hermes) {
      const c = t.checkpoint();
      if (c) files[file] = c;
    }
    cp.files = files;
    atomicWriteJson(cpFile, { v: 1, savedAt: Date.now() / 1000, files, roll: model.roll, fine: model.fine, months: model.months });
  };
  saveCheckpoint();

  // sub-agent views (B1/B3): history reads go straight to state.db / transcripts, never through the model
  const history = cfg.history === false ? null : new History({ model, hermesRoot: cfg.hermesRoot || null, claudeDirs: cfg.claudeDirs || [], claudeProfile: cfg.claudeProfile });
  // the Plan tab: a stored session's plan rebuilt from its newest todo tool result (state.db, read-only; off with history)
  const plans = cfg.history === false || !cfg.hermesRoot ? null : new PlanStore({ root: cfg.hermesRoot });
  // --- Workspace tab: device presence, and the CDP gateway when cfg.cdp.port is set ---------------------
  const cdpCfg = cfg.cdp && Number.isInteger(cfg.cdp.port) && cfg.cdp.port >= 0 ? cfg.cdp : null;
  const hostLabel = cfg.hostName || hostName(); // the Deck's host picker labels this machine with it
  const externalCdp = cdpCfg && cdpCfg.externalCdp ? parseExternalCdp(cdpCfg.externalCdp) : null;
  if (cdpCfg && cdpCfg.externalCdp && !externalCdp) console.warn("deck-relay: DECK_FALLBACK_BROWSER_CDP ignored: it must be a loopback http URL such as http://127.0.0.1:9222");
  const fallback =
    cdpCfg && (cdpCfg.fallback || externalCdp)
      ? new FallbackHost({
          dir: path.join(cfg.dataDir, "agent-browsers"),
          browserPath: cdpCfg.browserPath,
          name: hostLabel,
          launchTimeoutMs: cdpCfg.launchTimeoutMs,
          headless: !!cdpCfg.fallback,
          external: externalCdp ? { port: externalCdp.port, agent: cdpCfg.externalAgent } : null,
          probeMs: cdpCfg.probeMs,
        })
      : null;
  // Bot screen: the agent host itself is the "desktop" fallback when DECK_DESKTOP_HOST=1, or as the agents' space
  const desktopFallback = (cfg.driver && cfg.driver.desktopHost) || cfg.spaces ? { id: "host", name: "agent host" } : null;
  const presence = new Presence({
    fallback: { browser: fallback && fallback.available ? { id: "fallback", name: fallback.name, agents: fallback.agentList() } : null, desktop: desktopFallback },
    hostName: hostLabel,
    browserDefault: cdpCfg ? cdpCfg.browserDefault : "host",
    desktopDefault: cfg.spaces ? "host" : "device", // with spaces an unpinned agent works in its space
  });
  // Workspace tab: the user's host picks ("Bu bilgisayar" / this machine) survive a relay restart
  const pinsFile = path.join(cfg.dataDir, "workspace-pins.json");
  presence.loadPins((readJson(pinsFile, null) || {}).pins);
  presence.on("pins", () => {
    try {
      atomicWriteJson(pinsFile, { v: 1, pins: presence.pinList() });
    } catch (e) {
      console.warn(`deck-relay: host picks not saved (${e.message})`);
    }
  });
  const gateway = cdpCfg ? new CdpGateway({ presence, fallback }) : null;
  const bundles = new BundleStore({ dir: path.join(cfg.dataDir, "bundles"), tokensFile: (cfg.driver || driverConfig()).tokensFile, presence });
  if (fallback && fallback.external) fallback.attachExternal().catch(() => {}); // attach it now if it is up (never launches it)
  const identity = fallback && fallback.available ? await loadIdentity(path.join(cfg.dataDir, "browser-transfer.key")) : null;
  if (identity) bundles.registerServer({ publicKey: identity.publicKey });
  const transfers = new BrowserTransfers({ presence, bundles, fallback, identity, policyFile: path.join(cfg.dataDir, "browser-transfer-policy.json"), broadcast: (m) => broadcast(m) });
  bundles.onBeforeStore = (meta) => transfers.check(meta);
  bundles.onStored = (meta) => { if (meta.reason !== "checkpoint") transfers.stored(meta).catch(() => {}); };
  const workspace = gateway ? new WorkspaceHub({ presence, fallback, transfers }) : null;
  if (cdpCfg && cdpCfg.fallback && fallback && !fallback.headlessAvailable) console.warn("deck-relay: DECK_FALLBACK_BROWSER is on but no Chrome, Chromium or Edge was found; set DECK_FALLBACK_BROWSER_PATH");
  if (cdpCfg && !fallback) console.warn(`deck-relay: no agent host browser (DECK_FALLBACK_BROWSER=0, no DECK_FALLBACK_BROWSER_CDP); agents get a browser only on a Deck PC${cdpCfg.browserDefault === "host" ? " (DECK_BROWSER_DEFAULT=host has nothing to prefer)" : ""}`);
  // Agent spaces phase 2 (spec 2026-10-07): each agent's own desktop on a desktop host. Deck computers may host
  // whenever spaces are on (they opt in themselves); the agent host only with DECK_DESKTOPS_HOST=1.
  const dcfg = { ...desktopsConfig({}, Infinity), ...(cfg.desktops || {}) };
  const spaceAudit = cfg.spaces ? new SpaceAudit({ dataDir: cfg.dataDir, env: cfg.safety?.auditEnv || {}, known: (profile) => !!spaces?._known(profile) }) : null;
  const riskyPatterns = cfg.safety?.riskyPatternsFile ? compilePatterns(fs.readFileSync(cfg.safety.riskyPatternsFile, "utf8")) : [];
  let spaceApprovals = null;
  let desktops = null;
  let spaceTunnel = null;
  let localDesktops = null;
  if (cfg.spaces) {
    spaceTunnel = new SpaceTunnel({ presence });
    localDesktops = dcfg.host ? await agentHostDesktops(cfg, dcfg) : null;
    const storeFile = path.join(cfg.dataDir, "desktops.json"); // home hosts per agent
    desktops = new Desktops({
      local: localDesktops,
      localLimit: localDesktops ? dcfg.limit : 0,
      idleMs: dcfg.idleMin * 60_000,
      presence,
      remote: spaceTunnel.remote,
      store: { load: () => readJson(storeFile, null), save: (o) => atomicWriteJson(storeFile, { v: 1, ...o }) },
      hostName: hostLabel,
      ready: makeReady({ tunnel: spaceTunnel }), // cua-spacesd's /health, every 500 ms up to 30 s
      allowed: Array.isArray(dcfg.agents) ? dcfg.agents : null, // DECK_DESKTOPS_AGENTS: others get no desktop (fallback "none")
      hostGoneMs: presence.o.staleMs, // a Deck host absent this long (heartbeat stale, asleep) has left; a locked one still hosts
    });
    desktops.snapshotSettings = () => spaceAudit.settings();
    spaceApprovals = new SpaceApprovals({ snapshot: (p, reason, host) => desktops.snapshot(p, reason, host) });
    await desktops.adopt(); // the agent host's desktops still running from before a restart
  }
  spaces = cfg.spaces
    ? new Spaces({
        mode: cfg.spaces.mode,
        lock: new SpaceLock(),
        presence,
        spacesd: { url: cfg.spaces.url, tokenFile: cfg.spaces.tokenFile },
        desktops,
        audit: spaceAudit, approvals: spaceApprovals,
        local: localDesktops,
        tunnel: spaceTunnel,
        profiles: () => Object.keys((model.cfg && model.cfg.profiles) || {}),
        sharedProfiles: () => driver ? driver.sharedProfiles() : [],
        agentName: (p) => model.agentName(p),
      })
    : null;
  const spaceFetch = desktops ? makeSpaceFetch({ desktops, local: localDesktops, tunnel: spaceTunnel }) : null;
  const driver = cfg.driver ? new Driver({ desktops, spaceFetch, sharedFallback: dcfg.sharedFallback, spaceAudit, spaceApprovals, riskyPatterns, ...cfg.driver, presence, spaces, agentName: (p) => model.agentName(p) }) : null;

  if (spaces) spaces.endSpace = (profile) => driver?.endSpace(profile);

  const mobile = new MobileRelay({ tokensFile: cfg.mobileDevicesFile || path.join(cfg.dataDir, "mobile-devices.json"), bridgeConfig: cfg.mobileBridge, push: new MobilePushClient(), capabilities: { history: !!history, workspace: !!workspace && !!fallback?.available, desktop: false } });
  const host = { protocol: compat.PROTOCOL, plugins: compat.pluginCache(cfg.hermesRoot || null), update: () => compat.updateStatus(cfg.dataDir) };
  const { HostUpdate } = require("./host-update");
  const { Restarts } = require("./restarts");
  const spawnRun = (cmd, args) => new Promise((resolve) => {
    const { spawn } = require("child_process");
    let out = "";
    let child;
    try { child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return resolve({ code: 1, out: e.message }); }
    child.stdout.on("data", (d) => { out = (out + d).slice(-4000); });
    child.stderr.on("data", (d) => { out = (out + d).slice(-4000); });
    child.on("error", (e) => resolve({ code: 1, out: e.message }));
    child.on("close", (code) => resolve({ code, out }));
  });
  const restarts = new Restarts({ file: path.join(cfg.dataDir, "restart-queue.json"), hermesRoot: cfg.hermesRoot, hermesBin: cfg.hermesBin || "hermes", run: spawnRun, onChange: () => hostUpdate.poll() });
  const hostUpdate = new HostUpdate({
    dataDir: cfg.dataDir, relayDir: path.join(__dirname, ".."), version: VERSION, remoteUpdate: cfg.remoteUpdate !== false,
    tokensFile: (cfg.driver || driverConfig()).tokensFile, presence, plugins: () => compat.pluginVersions(cfg.hermesRoot || null), restarts,
    uid: typeof process.getuid === "function" ? process.getuid() : 0, run: spawnRun, broadcast: (m) => broadcast(m),
  });
  let quitRelay = null; // set by the entry point below: stop, then exit so the service manager starts the relay again
  const hermesConfig = new HermesConfig({ ...(cfg.hermesConfig || hermesConfigOptions({})), root: cfg.hermesRoot || (cfg.hermesConfig || {}).root, quit: () => (quitRelay ? quitRelay() : null) });
  const srv = createServer({ hermesConfig, hostUpdate, mobile, host, token: cfg.token, queryToken: !!cfg.queryToken, model, fleet, version: VERSION, hooks: deckHooks(presence, gateway, driver, workspace, bundles, spaces, spaceTunnel), history, plans, bundles });
  broadcast = srv.broadcast;
  if (workspace) workspace.setBroadcast(srv.broadcast);

  // --- loops ----------------------------------------------------------------------------------------
  let tick = 0;
  const timers = [
    setInterval(() => {
      tick += 1;
      if (tick % 5 === 0) scanHermes();
      if (tick % 3 === 0) claude.scan();
      if (tick % 10 === 0) claude.refreshChats();
      for (const t of hermes.values()) t.poll();
      claude.poll();
    }, cfg.tickMs),
    setInterval(() => {
      if (!queue.length && !model.dirty.size) return;
      // raw events for feeds + fresh summaries of every changed session, so clients never re-derive state
      broadcast({ t: "evs", evs: queue.splice(0), sessions: model.takeDirty(), agents: model.agents() });
    }, 250),
    setInterval(() => {
      if (usage) usage.refresh();
      else broadcast({ t: "agents", agents: model.agents() });
    }, 60_000),
    setInterval(saveCheckpoint, 30_000),
    setInterval(() => model.prune(), 600_000),
  ];
  restarts.start();
  const hostPoll = setInterval(() => hostUpdate.poll(), 1000);
  hostPoll.unref?.();
  timers.push(hostPoll);
  hostUpdate.poll();
  if (spaceAudit) {
    spaceAudit.cleanup().catch(() => {});
    const maintenance = setInterval(() => { spaceAudit.cleanup().catch(() => {}); spaceApprovals?.sweep(); }, 60_000);
    maintenance.unref?.();
    timers.push(maintenance);
  }
  // Workspace tab: end stale routes and tell decks where agent work runs, when that changes
  let lastDevices = "";
  let spaceTick = 9; // first health check on the first tick
  timers.push(
    setInterval(() => {
      presence.sweep();
      bundles.prune();
      if (spaces) {
        spaces.sweep();
        if (++spaceTick % 10 === 0) spaces.health();
      }
      if (desktops) desktops.syncHosts().catch(() => {}); // a Deck host appeared, came back, or runs other desktops than we know
      const s = JSON.stringify(presence.state());
      if (s === lastDevices) return;
      lastDevices = s;
      broadcast(JSON.parse(s));
    }, 1000)
  );
  if (desktops) {
    let sweeping = false; // a sweep can wait on `docker stop`: never two at once
    timers.push(
      setInterval(() => {
        if (sweeping) return;
        sweeping = true;
        desktops
          .sweep()
          .catch((e) => console.warn(`deck-relay: agent desktops sweep failed (${e.message})`))
          .finally(() => (sweeping = false));
      }, 30_000)
    );
  }
  fleet.start();

  let cdpSrv = null;
  let driverUp = false;
  const stop = () =>
    new Promise((resolve) => {
      for (const t of timers) clearInterval(t);
      restarts.stop();
      fleet.stop();
      if (history) history.stop();
      try {
        saveCheckpoint();
      } catch {
        /* best effort */
      }
      if (workspace) workspace.stop();
      transfers.stop();
      if (gateway) gateway.stop();
      const closing = [mobile.stop(), driver ? driver.stop() : Promise.resolve()]; // ends driver sessions before their decks go
      if (fallback) closing.push(fallback.stopAll()); // resolves once its browsers have exited
      for (const ws of srv.clients) ws.terminate();
      closing.push(new Promise((r) => srv.server.close(() => r())));
      if (cdpSrv) closing.push(cdpSrv.close());
      Promise.all(closing).then(() => resolve());
    });

  await new Promise((resolve, reject) => {
    srv.server.once("error", reject);
    srv.server.listen(cfg.port, cfg.host, resolve);
  });
  // The CDP endpoint is loopback only, and optional: a busy port must not take the relay down.
  let cdpPort = null;
  if (gateway) {
    const c = createCdpServer({ gateway, defaultSlug: cdpCfg.defaultAgent });
    cdpPort = await new Promise((resolve) => {
      c.server.once("error", (e) => {
        console.warn(`deck-relay: CDP endpoint 127.0.0.1:${cdpCfg.port} not started (${e.code || e.message}); agent browsers unavailable`);
        resolve(null);
      });
      c.server.listen(cdpCfg.port, "127.0.0.1", () => resolve(c.server.address().port));
    });
    if (cdpPort) cdpSrv = c;
  }
  // The local driver socket is optional too: without it deck-cua reports "relay not running" to the agent.
  if (driver) {
    try {
      await driver.start();
      driverUp = true;
    } catch (e) {
      console.warn(`deck-relay: bot screen driver socket ${cfg.driver.sockPath} not started (${e.code || e.message}); computer_use routing unavailable`);
    }
  }
  mobile.available.desktop = driverUp;
  return { setQuit: (fn) => { quitRelay = fn; }, hermesConfig, server: srv.server, port: srv.server.address().port, cdpPort, model, fleet, usage, presence, gateway, workspace, fallback, bundles, transfers, driver: driverUp ? driver : null, desktops, spaceTunnel, stop };
}

/**
 * `node src/index.js --self-check`: the relay updater runs this in a new release before it switches to it. Loads the
 * configuration the service would use, reads agents.json, opens each profile's history read-only, and returns
 * without listening on any port or writing anything. {ok, version, protocol, problems[], notes[]}.
 */
function selfCheck(cfg) {
  const problems = [];
  const notes = [];
  if (!cfg.token || cfg.token.length < 24) problems.push("DECK_RELAY_TOKEN missing or shorter than 24 chars");
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) problems.push(`DECK_RELAY_PORT is not a port: ${cfg.port}`);
  if (fs.existsSync(cfg.agentsFile)) {
    try {
      JSON.parse(fs.readFileSync(cfg.agentsFile, "utf8"));
    } catch (e) {
      problems.push(`${cfg.agentsFile}: ${e.message}`);
    }
  } else notes.push(`no agents file at ${cfg.agentsFile} (agents get default names)`);
  if (cfg.history !== false && cfg.hermesRoot) {
    const store = new HermesStore(cfg.hermesRoot);
    try {
      for (const p of store.profiles()) {
        try {
          store.open(p);
          notes.push(`history ${p}: opened read-only`);
        } catch (e) {
          (e.code === 501 ? notes : problems).push(`history ${p}: ${e.message}`);
        }
      }
    } finally {
      store.close();
    }
  }
  return { ok: !problems.length, version: VERSION, protocol: compat.PROTOCOL, problems, notes };
}

if (require.main === module && process.argv.includes("--self-check")) {
  loadEnvFile(process.env.DECK_RELAY_ENV || path.join(__dirname, "..", ".env"));
  const r = selfCheck(config());
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
} else if (require.main === module) {
  loadEnvFile(process.env.DECK_RELAY_ENV || path.join(__dirname, "..", ".env"));
  const cfg = config();
  start(cfg)
    .then(({ port, cdpPort, driver, stop, model, setQuit }) => {
      console.log(`deck-relay ${VERSION} listening on ${cfg.host}:${port} (${model.sessions.size} sessions loaded)`);
      if (cdpPort) console.log(`deck-relay: agent browsers at http://127.0.0.1:${cdpPort}/agent/<profile> (headless fallback browser ${cfg.cdp.fallback ? "on" : "off"}; external browser ${cfg.cdp.externalCdp ? `attached for ${cfg.cdp.externalAgent}` : "off"}; default ${cfg.cdp.browserDefault})`);
      if (driver) console.log(`deck-relay: bot screen driver socket ${cfg.driver.sockPath} (agent host as fallback: ${cfg.driver.desktopHost ? "on" : "off"})`);
      if (cfg.spaces) console.log(`deck-relay: agent spaces ${cfg.spaces.mode}; agent desktops on this machine ${cfg.desktops.host ? `on (limit ${cfg.desktops.limit}, idle ${cfg.desktops.idleMin} min)` : "off"}; shared fallback ${cfg.desktops.sharedFallback ? "on" : "off"}`);
      const quit = () => stop().then(() => process.exit(0));
      setQuit(quit); // Settings > Hermes config > Restart relay
      process.on("SIGTERM", quit);
      process.on("SIGINT", quit);
    })
    .catch((e) => {
      console.error("deck-relay failed to start:", e.message);
      process.exit(1);
    });
}

module.exports = { config, desktopsConfig, start, deckHooks, selfCheck, VERSION };
