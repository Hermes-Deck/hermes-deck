"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
// Workspace tab, main process: the "browser" hosting capability. Connects this device's agent browsers
// (agent-browser.js) to the relay's CDP tunnel (cdp-tunnel.js) and to the renderer (deck.workspace.*).
// Off unless the user switched "Ajan tarayıcısı bu cihazda çalışabilir" on (Settings > Bu cihaz, stored
// by presence.js): then no tunnel opens and no agent browser starts. A screenshot run never hosts for
// the relay; with --workspace-demo=<url> it shows a throwaway browser from a temp profile instead.
//
// Two places an agent's browser can run, both watched the same way (cdp-view.js LiveView):
//   local   on this deck: the LiveView runs here
//   remote  on the agent host (relay/src/workspace.js): the relay runs the LiveView and sends frames and tabs
//           over this deck's relay connection; the renderer's calls go back the same way
// Which one is the relay's route for the agent (or, with no route, whichever browser runs). The user picks
// the place in the Workspace tab ("Otomatik" / "Bu bilgisayar" / the agent host): a pin on the relay, sent
// over this deck's own relay connection, only ever on the user's click.
// Robot checks: when an agent's page looks like one, the renderer shows a banner and the user gets one
// desktop notification (kind "question") that opens the Workspace tab; the user takes control and solves it.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { app, ipcMain, safeStorage } = require("electron");
const { AgentBrowserHost, SLUG_RE } = require("./agent-browser");
const { LiveView, CdpClient } = require("./cdp-view");
const { CdpTunnel } = require("./cdp-tunnel");
const { appIpc } = require("./ipc-guard");
const { BrowserTransfer } = require("./browser-transfer");

const slugOf = (v) => {
  const s = String(v || "").toLowerCase();
  if (!SLUG_RE.test(s)) throw new Error(i18nText("U0005"));
  return s;
};
const WHERE = new Set(["auto", "here", "agent-host"]);
const REQ_MS = 10_000;
const DEVICES_ASK_MS = 1500; // an open relay that has sent no device list yet is asked after 1.5 s, 3 s, 4.5 s
const DEVICES_ASKS = 3;
const WALL_QUIET_MS = 10 * 60_000; // one notification per robot check (site), not one per page load
const blankView = () => ({ tabs: [], follow: true, lastSeen: null, wall: null, hidden: false });
const DEMO_SCENES = new Set(["follow", "closed", "wall", "host", "host-off"]);

/**
 * @param {object} o
 * @param {(channel: string, msg: object) => void} o.send   to the renderer
 * @param {import("./presence").DevicePresence} o.presence
 * @param {((kind: string, payload: object) => unknown)|null} [o.notify]  desktop.notify
 * @param {boolean} [o.shot]       screenshot run: temp profiles, never a host for the relay
 * @param {string|null} [o.demoUrl] shot only: open this page in a demo agent browser
 * @param {string|null} [o.demoAgent]
 * @param {string|null} [o.demoScene] shot only: "follow" | "closed" | "wall" | "host" (see the end of this file)
 */
function initWorkspace({ send, presence, settings = null, notify = null, shot = false, demoUrl = null, demoAgent = null, demoScene = null }) {
  const demo =
    shot && typeof demoUrl === "string"
      ? { slug: SLUG_RE.test(String(demoAgent || "").toLowerCase()) ? String(demoAgent).toLowerCase() : "demo", url: demoUrl, scene: DEMO_SCENES.has(demoScene) ? demoScene : null }
      : null;
  const root = shot ? fs.mkdtempSync(path.join(os.tmpdir(), "hermes-deck-shot-")) : path.join(app.getPath("userData"), "agent-browsers");
  // A plain screenshot run shows this device's real switch (presence read device.json), read-only: it never
  // launches an agent browser (readOnly), so the Workspace tab no longer claims hosting is off when it is on.
  const host = new AgentBrowserHost({ root, enabled: demo ? true : presence.hosting.browser, readOnly: shot && !demo });
  presence.register("browser", !!host.exe);
  if (demo) presence.hosting.browser = true; // this run only: a shot never writes device.json

  let relay = null;
  let tunnel = null;
  const relayHandlers = {};
  let devices = null; // relay {t:"devices"}: routes, pins, the agent host's name (the last snapshot of THIS connection)
  let relayLink = { status: "starting", error: null, since: Date.now() }; // this deck's relay socket, same events as the title bar
  let devicesAsk = null; // timer: ask a relay that is open but silent for its device list again
  let remote = { host: null, browsers: new Map() }; // relay {t:"ws-browsers"}: the agent host's browsers
  let view = null; // {kind: "local", slug, lv} | {kind: "remote", slug}
  let viewSlug = null;
  let viewOpts = {};
  let viewStarting = false;
  let lastView = blankView(); // tabs, follow, lastSeen, wall of the view on screen
  const pending = new Map(); // relay request id -> {resolve, reject, timer}
  let reqId = 0;

  const ipc = appIpc(ipcMain); // the Deck's own page only (security audit L4)
  const emit = (m) => send("workspace", m);
  const viewInfo = () => (viewSlug ? { slug: viewSlug, kind: view ? view.kind : null, live: !!view, ...lastView } : null);
  const state = () => ({
    device: presence.state(),
    hosting: host.enabled(),
    allowed: host.allowed,
    browser: host.exe ? host.exe.kind : null,
    browsers: host.list(),
    remote: { host: remote.host, browsers: [...remote.browsers.values()] },
    // pull side of the relay feed: a window that loaded after the relay's one-shot messages (or reloaded) still
    // learns the link and the last devices snapshot here; live messages keep coming over the "relay" channel
    relayLink: shot ? null : { ...relayLink },
    devices,
    view: viewInfo(),
    // screenshot runs: the agent to show (--workspace-agent alone shows that agent's empty tab: like the demo,
    // the run gets a temp profile and default settings, so it never reaches the user's relay; main.js WS_SHOT)
    demo: demo ? demo.slug : shot && SLUG_RE.test(String(demoAgent || "")) ? String(demoAgent) : null,
    scene: demo ? demo.scene : null,
    transfer: transfer.state(),
  });

  // ---- the relay: requests over this deck's connection (relay/src/workspace.js) ----------------------------
  function relayReq(op, slug, extra = {}) {
    return new Promise((resolve, reject) => {
      // a screenshot run may watch the agent host's browser, never change anything there
      if (!relay || (shot && op !== "watch" && op !== "unwatch")) return reject(new Error(i18nText(relayLink.status === "unconfigured" ? "ws.relayUnconfigured" : "U0336")));
      const id = ++reqId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(i18nText("U0337")));
      }, REQ_MS);
      pending.set(id, { resolve, reject, timer });
      if (!relay.send({ t: "ws-req", id, op, slug, ...extra })) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(i18nText("U0336")));
      }
    });
  }

  function failPending(why) {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
    }
    pending.clear();
  }

  // ---- where to watch an agent's browser ------------------------------------------------------------------
  const routeOf = (slug) => ((devices && devices.routes) || []).find((r) => r && r.capability === "browser" && r.sessionKey === slug) || null;
  const pinOf = (slug) => ((devices && devices.pins) || []).find((p) => p && p.capability === "browser" && p.sessionKey === slug) || null;

  /** "local" (this deck), "remote" (the agent host) or null (nowhere, or another deck). */
  function sourceFor(slug) {
    const loc = host.peek(slug);
    const localUp = !!loc && loc.status === "running";
    const rb = remote.browsers.get(slug);
    const r = routeOf(slug);
    if (r && r.host) {
      if (r.host.kind === "fallback") return relay ? "remote" : null;
      return r.host.id === presence.id && localUp ? "local" : null;
    }
    // no route yet: with the agent host first (relay default) its running browser is the one to watch, not a stray local one
    const hostFirst = !!devices && !(devices.defaults && devices.defaults.browser === "device");
    const fb = devices && devices.fallback && devices.fallback.browser;
    const hostServes = !!fb && (!Array.isArray(fb.agents) || fb.agents.includes(slug));
    if (relay && hostFirst && hostServes && rb && rb.status === "running") return "remote";
    if (localUp) return "local";
    if (relay && ((rb && rb.status === "running") || (pinOf(slug) && pinOf(slug).host.kind === "fallback"))) return "remote";
    return null;
  }

  function syncView() {
    const want = viewSlug ? sourceFor(viewSlug) : null;
    if (view && (view.kind !== want || view.slug !== viewSlug)) dropView();
    if (view || !want) return;
    if (want === "local") startLocal();
    else startRemote();
  }

  function dropView() {
    if (!view) return;
    const v = view;
    view = null;
    lastView = blankView();
    if (v.kind === "local") {
      v.lv.browser.viewers = Math.max(0, v.lv.browser.viewers - 1);
      v.lv.stop();
    } else relayReq("unwatch", v.slug).catch(() => {});
    emit({ t: "view", slug: v.slug, kind: null });
  }

  function onTabs(slug, tabs, st) {
    lastView = { tabs, follow: st.follow !== false, lastSeen: st.lastSeen || null, wall: st.wall || null, hidden: !!st.hidden };
    emit({ t: "tabs", slug, ...lastView });
    wallSeen(slug, lastView.wall);
  }

  function startLocal() {
    if (viewStarting) return;
    const b = host.peek(viewSlug);
    if (!b || b.status !== "running") return; // starts once the browser runs (host "change")
    const slug = viewSlug;
    const lv = new LiveView(b, viewOpts);
    viewStarting = true;
    lv.start()
      .then(() => {
        viewStarting = false;
        if (view || viewSlug !== slug || b.status !== "running" || sourceFor(slug) !== "local") {
          lv.stop();
          return syncView();
        }
        view = { kind: "local", slug, lv };
        b.viewers += 1;
        emit({ t: "view", slug, kind: "local" });
        lv.on("frame", (f) => emit({ t: "frame", slug, targetId: f.targetId, data: f.data, meta: f.meta }));
        lv.on("tabs", (tabs) => onTabs(slug, tabs, lv.status()));
        lv.on("lost", () => {
          if (!view || view.lv !== lv) return;
          dropView();
          setTimeout(syncView, 1000);
        });
        onTabs(slug, lv.tabs(), lv.status());
      })
      .catch((e) => {
        viewStarting = false;
        lv.stop();
        emit({ t: "view-error", slug, error: String(e.message || e).slice(0, 200) });
      });
  }

  function startRemote() {
    const slug = viewSlug;
    view = { kind: "remote", slug };
    lastView = blankView();
    emit({ t: "view", slug, kind: "remote" });
    watchRemote(slug);
  }

  function watchRemote(slug) {
    relayReq("watch", slug, { maxWidth: viewOpts.maxWidth, maxHeight: viewOpts.maxHeight, large: viewOpts.large === true }).catch((e) => {
      if (view && view.kind === "remote" && view.slug === slug) emit({ t: "view-error", slug, error: String(e.message || e).slice(0, 200) });
    });
  }

  /** Relay messages for the Workspace tab. True when consumed here (frames and answers never reach the renderer). */
  function onRelayMsg(m) {
    if (!m || typeof m !== "object") return false;
    if (transfer.onMessage(m)) return true;
    if (m.t === "devices") {
      devices = m;
      clearTimeout(devicesAsk);
      if (relayLink.status !== "open") relayLink = { status: "open", error: null, since: Date.now() }; // a message proves the socket is open
      setImmediate(syncView);
      return false; // the renderer shows routes and pins too
    }
    if (m.t === "ws-browsers") {
      const list = Array.isArray(m.browsers) ? m.browsers.filter((b) => b && typeof b === "object" && SLUG_RE.test(String(b.slug || ""))) : [];
      remote = { host: typeof m.host === "string" ? m.host.slice(0, 48) : null, browsers: new Map(list.map((b) => [b.slug, b])) };
      for (const b of list) wallSeen(b.slug, b.wall);
      setImmediate(syncView);
      return false;
    }
    if (m.t === "ws-res") {
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.value);
        else p.reject(new Error(String(m.error || i18nText("U0338")).slice(0, 200)));
      }
      return true;
    }
    if (m.t === "ws-view") {
      if (!view || view.kind !== "remote" || m.slug !== view.slug) return true;
      if (m.ev === "frame" && typeof m.data === "string" && m.data.length < 8 * 1024 * 1024) {
        emit({ t: "frame", slug: m.slug, targetId: typeof m.targetId === "string" ? m.targetId : null, data: Buffer.from(m.data, "base64"), meta: m.meta && typeof m.meta === "object" ? m.meta : {} });
      } else if (m.ev === "tabs") {
        const tabs = (Array.isArray(m.tabs) ? m.tabs : []).filter((t) => t && typeof t.id === "string").map((t) => ({ id: t.id, title: String(t.title || ""), url: String(t.url || ""), shown: !!t.shown }));
        onTabs(m.slug, tabs, { follow: m.follow, lastSeen: m.lastSeen, wall: m.wall, hidden: m.hidden });
      } else if (m.ev === "error") emit({ t: "view-error", slug: m.slug, error: String(m.error || "").slice(0, 200) });
      return true;
    }
    return false;
  }

  // ---- robot checks: one desktop notification, the click opens the Workspace tab -----------------------------
  const told = new Map(); // "<slug>|<site>" -> when the user was told
  function wallSeen(slug, wall) {
    if (!notify || !wall || typeof wall.url !== "string") return;
    let site = "";
    try {
      site = new URL(wall.url).host;
    } catch {
      site = "";
    }
    const key = `${slug}|${site}`;
    if (Date.now() - (told.get(key) || 0) < WALL_QUIET_MS) return;
    const shown = notify("question", {
      title: i18nText("U0339"),
      body: i18nText("U0340", { slug: slug, v: site || i18nText("A0187") }),
      key: `ws:${slug}`,
    });
    if (shown) told.set(key, Date.now()); // not shown (the deck was in front): the next update tries again
  }

  host.on("change", (info) => {
    emit({ t: "browser", info });
    wallSeen(info.slug, info.wall);
    if (info.slug === viewSlug) syncView();
  });

  // ---- the relay: presence heartbeat + CDP tunnel + requests ------------------------------------------------
  /** The relay sends its device list once, when a deck connects; if it did not arrive, ask (older relays ignore the ask). */
  function askDevices(r, n) {
    if (n >= DEVICES_ASKS) return;
    clearTimeout(devicesAsk);
    devicesAsk = setTimeout(() => {
      if (relay !== r || devices || relayLink.status !== "open") return;
      r.send({ t: "devices?" });
      askDevices(r, n + 1);
    }, DEVICES_ASK_MS * (n + 1));
    if (devicesAsk.unref) devicesAsk.unref();
  }

  function attachRelay(r) {
    if (relay) for (const [ev, fn] of Object.entries(relayHandlers)) relay.off(ev, fn);
    if (tunnel) tunnel.closeAll("relay connection replaced");
    failPending(i18nText("U0341"));
    if (view && view.kind === "remote") {
      view = null; // that relay forgot it; the new one gets a fresh watch
      lastView = blankView();
      emit({ t: "view", slug: viewSlug, kind: null });
    }
    relay = r;
    transfer.attach(shot ? null : r);
    tunnel = null;
    devices = null;
    clearTimeout(devicesAsk);
    relayLink = { status: r && !shot ? "connecting" : "unconfigured", error: null, since: Date.now() };
    remote = { host: null, browsers: new Map() };
    presence.attach(shot ? null : r);
    if (!r || shot) return;
    const t = new CdpTunnel({ host, send: (buf) => (relay === r ? r.send(buf) : false) });
    tunnel = t;
    relayHandlers.frame = (buf) => t.onFrame(buf);
    relayHandlers.status = (s) => {
      if (relayLink.status !== s.status) relayLink = { status: s.status, error: s.error || null, since: Date.now() };
      clearTimeout(devicesAsk);
      if (s.status !== "open") {
        devices = null; // it described a connection that is gone; the next one sends a fresh list
        t.closeAll("relay connection lost");
        failPending(i18nText("U0342"));
      } else {
        if (view && view.kind === "remote") watchRemote(view.slug); // a new connection: watch again
        askDevices(r, 0);
      }
    };
    for (const [ev, fn] of Object.entries(relayHandlers)) r.on(ev, fn);
  }

  presence.on("hosting", (cap, on) => {
    if (cap !== "browser") return;
    if (!on) {
      if (tunnel) tunnel.closeAll("agent browsers were switched off on this device", true);
      if (view && view.kind === "local") dropView();
    }
    host.setEnabled(on).then(() => emit({ t: "state", state: state() }));
    emit({ t: "state", state: state() });
  });

  // ---- renderer calls (every argument checked here) -------------------------------------------------------
  const needView = (slug) => {
    if (!view || view.slug !== slugOf(slug)) throw new Error(i18nText("U0343"));
    return view;
  };
  const controllerOf = (v) => (v.kind === "local" ? host.controller(v.slug) : (remote.browsers.get(v.slug) || {}).controller || "agent");
  const needControl = (slug) => {
    const v = needView(slug);
    if (controllerOf(v) !== "user") throw new Error(i18nText("U0344"));
    return v;
  };
  /** One call on whichever side the view runs. */
  const onView = (v, op, local, extra = {}) => (v.kind === "local" ? local(v.lv) : relayReq(op, v.slug, extra));
  const size = (n, d) => Math.round(Math.min(1920, Math.max(320, Number(n) || d)));
  /** The stream size the renderer asked for; `large` (the expanded view) lets the relay go past its panel-sized limit. */
  const viewSize = (opts) => ({ maxWidth: size(opts && opts.maxWidth, 1280), maxHeight: size(opts && opts.maxHeight, 1280), large: !!opts && opts.large === true });
  const tabId = (id) => String(id || "").slice(0, 128);

  const transfer = new BrowserTransfer({ host, presence, settings, dir: app.getPath("userData"), request: relayReq, emit, shot,
    protect: (plain) => {
      if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === "basic_text") throw new Error(i18nText("transfer.secureStorageMissing"));
      return safeStorage.encryptString(plain);
    },
    unprotect: (bytes) => safeStorage.decryptString(bytes),
  });

  ipc.handle("ws:transfer-targets", async () => {
    const list = await transfer.targets();
    return list.map((d) => ({ ...d, name: d.deviceId === "fallback" ? remote.host || devices?.agentHost?.name || i18nText("A0379") : (devices?.devices || []).find((x) => x.id === d.deviceId)?.name || d.deviceId.slice(0, 8) }));
  });
  ipc.handle("ws:transfer-consent", (_e, target, automatic) => transfer.approve(String(target || ""), automatic === true));
  ipc.handle("ws:transfer-auto-off", () => transfer.disableAutomatic());
  ipc.handle("ws:handoff", (_e, slug, target) => transfer.handoff(slugOf(slug), String(target || "")));

  ipc.handle("ws:state", () => state());
  ipc.handle("ws:watch", (_e, slug, opts) => {
    const s = slugOf(slug);
    if (s !== viewSlug) dropView();
    viewSlug = s;
    viewOpts = viewSize(opts);
    syncView();
    return state();
  });
  // the stage changed size (expand, panel drag, window resize): the running stream follows, in place (no blank frame)
  ipc.handle("ws:resize", (_e, slug, opts) => {
    const s = slugOf(slug);
    viewOpts = viewSize(opts);
    if (!view || view.slug !== s) return null; // not streaming yet: the start reads viewOpts
    if (view.kind === "local") return view.lv.resize(viewOpts);
    return relayReq("resize", s, viewOpts).catch(() => {}); // an older relay answers "bad request": the old size stays
  });
  ipc.handle("ws:unwatch", () => {
    dropView();
    viewSlug = null;
  });
  ipc.handle("ws:start", async (_e, slug, where) => {
    const s = slugOf(slug);
    if (where === "agent-host") await relayReq("start", s);
    else await host.ensure(s);
    return state();
  });
  // the user's host pick for one agent: "auto" | "here" | "agent-host" (a pin on the relay)
  ipc.handle("ws:host", async (_e, slug, where) => {
    if (!WHERE.has(where)) throw new Error(i18nText("U0345"));
    await relayReq("route", slugOf(slug), { where });
    return state();
  });
  ipc.handle("ws:control", async (_e, slug, who) => {
    const s = slugOf(slug);
    const to = who === "user" ? "user" : "agent";
    if (view && view.slug === s && view.kind === "remote") {
      await relayReq("control", s, { who: to });
      const rb = remote.browsers.get(s); // an older relay sends the new list only after its 250 ms debounce
      if (rb) rb.controller = to;
    } else {
      host.setController(s, to);
      if (to === "user" && view && view.slug === s) view.lv.focus();
    }
    return state();
  });
  ipc.handle("ws:follow", (_e, slug) => onView(needView(slug), "follow", (lv) => lv.resume()));
  ipc.handle("ws:navigate", (_e, slug, url) => onView(needControl(slug), "navigate", (lv) => lv.navigate(String(url || "")), { url: String(url || "").slice(0, 4096) }));
  ipc.handle("ws:history", (_e, slug, delta) => {
    const d = Number(delta) < 0 ? -1 : 1;
    return onView(needControl(slug), "history", (lv) => lv.history(d), { delta: d });
  });
  ipc.handle("ws:reload", (_e, slug) => onView(needControl(slug), "reload", (lv) => lv.reload()));
  ipc.handle("ws:new-tab", (_e, slug) => onView(needControl(slug), "new-tab", (lv) => lv.newTab("about:blank")));
  ipc.handle("ws:close-tab", (_e, slug, id) => onView(needControl(slug), "close-tab", (lv) => lv.closeTab(tabId(id)), { tab: tabId(id) }));
  ipc.handle("ws:select-tab", (_e, slug, id) => onView(needView(slug), "select-tab", (lv) => lv.selectTab(tabId(id)), { tab: tabId(id) }));
  ipc.on("ws:input", (_e, slug, ev) => {
    if (!view || typeof slug !== "string" || slug !== view.slug || !ev || typeof ev !== "object") return;
    if (view.kind === "local") return view.lv.input(ev);
    const body = JSON.stringify({ t: "ws-input", slug, ev });
    if (relay && body.length <= 48_000) relay.send(body); // the relay applies it only while the user holds control
  });

  // ---- quitting: agent browsers never outlive the deck ------------------------------------------------------
  const cleanup = () => {
    transfer.stop();
    host.killAll();
    if (shot) setTimeout(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }, () => {}), 500);
  };
  app.on("will-quit", cleanup);
  process.on("exit", () => host.killAll());

  if (demo) runDemo(demo, host, presence, (m) => onRelayMsg(m) || send("relay", m));

  return { attachRelay, onRelayMsg, state, host };
}

// ---- screenshot demo: a real headless browser on a temp profile ------------------------------------------------
// --workspace-demo=<url> [--workspace-agent=<slug>] [--workspace-scene=follow|closed|wall|host]
//   (none)  the first tab shows <url>
//   follow  an "agent" opens <url> in a new tab of a new browser context: the view follows it
//   closed  the same, then the agent closes that tab: the last frame stays as "Son görülen"
//   wall    the agent opens a local stand-in robot check (/sorry/): the verification banner shows
//   host    the host picker is open, with the agent host's browser on offer
//   host-off  the same, with the agent host's browser switched off in the relay's .env
// Relay state is synthetic (this computer hosts; "Home server" is the agent host). Nothing reaches a relay.
function runDemo(demo, host, presence, relayMsg) {
  const devices = () => ({
    t: "devices",
    epoch: 1,
    devices: [{ id: presence.id, name: presence.name, os: process.platform, locked: false, hosting: { browser: true, desktop: false }, driverOk: { browser: true }, fresh: true }],
    active: { browser: presence.id, desktop: null },
    fallback: { browser: demo.scene === "host-off" ? null : { name: "Home server" }, desktop: null },
    routes: [{ sessionKey: demo.slug, capability: "browser", host: { kind: "device", id: presence.id, name: presence.name, os: process.platform }, epoch: 1, since: Math.round(Date.now() / 1000) }],
    pins: [],
    agentHost: { name: "Home server" },
  });
  const tick = setInterval(() => relayMsg(devices()), 1500); // the renderer may subscribe late
  if (tick.unref) tick.unref();
  relayMsg(devices());

  const wallPage = `<!doctype html><title>Unusual traffic check</title><body style="font:16px sans-serif;margin:48px;max-width:560px">
<h2>Our systems have detected unusual traffic</h2><p>Please confirm you are not a robot to continue.</p>
<label style="display:inline-flex;gap:10px;align-items:center;border:1px solid #ccc;padding:14px 18px;border-radius:4px"><input type="checkbox"> I'm not a robot</label></body>`;
  const site = demo.scene === "wall" ? http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(wallPage)) : null;

  const note = (method, act, targetId) => host.noteAgent(demo.slug, method, { use: true, act, targetId });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  host
    .ensure(demo.slug)
    .then(async ({ port, wsPath }) => {
      const c = await new CdpClient(`ws://127.0.0.1:${port}${wsPath}`).connect(5000);
      let url = demo.url;
      if (site) {
        await new Promise((r) => site.listen(0, "127.0.0.1", r));
        url = `http://127.0.0.1:${site.address().port}/sorry/index?continue=demo`;
      }
      if (!demo.scene || demo.scene.startsWith("host")) {
        // Chrome reports its port a moment before its first tab exists
        let page = null;
        for (let i = 0; i < 40 && !page; i++) {
          const { targetInfos } = await c.send("Target.getTargets");
          page = targetInfos.find((t) => t.type === "page");
          if (!page) await sleep(100);
        }
        if (page) {
          const { sessionId } = await c.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
          await c.send("Page.navigate", { url }, sessionId);
        } else await c.send("Target.createTarget", { url });
        return c.close();
      }
      // like an agent: a background tab in a new browser context, then a navigation (browser-harness does this)
      await sleep(2500); // the Workspace tab is watching by now
      const { browserContextId } = await c.send("Target.createBrowserContext", {});
      const { targetId } = await c.send("Target.createTarget", { url: "about:blank", background: true, browserContextId });
      note("Target.createTarget", "create", targetId);
      const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
      await c.send("Page.navigate", { url }, sessionId);
      note("Page.navigate", "nav", targetId);
      if (demo.scene === "closed") {
        await sleep(3000);
        await c.send("Target.closeTarget", { targetId });
      }
      // keep the connection (and with it the new browser context) until the shot is taken
    })
    .catch((e) => console.error("workspace demo:", e.message));
}

module.exports = { initWorkspace };
