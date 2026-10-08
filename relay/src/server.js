"use strict";
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { RANGES } = require("./model");

const MAX_BUFFERED = 4 * 1024 * 1024; // a client this far behind is cut; it reconnects and resyncs

/**
 * The relay token from the Authorization header. `?token=` is read only when queryToken is on
 * (DECK_RELAY_QUERY_TOKEN=1): a token in a URL can end up in a proxy's access log (security audit L2).
 */
function tokenOk(req, token, queryToken = false) {
  const h = req.headers.authorization || "";
  let got = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!got && queryToken) {
    try {
      got = new URL(req.url, "http://relay").searchParams.get("token") || "";
    } catch {
      got = "";
    }
  }
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * HTTP + WebSocket front of the relay.
 *   GET /health                (no auth)  liveness for launchd checks and the deck's host list:
 *                              {ok, v, protocol, updateAvailable?, latest?, uptime, ...}; profile names and
 *                              plugin versions only in the authenticated WS hello
 *   POST /fleet/quotas/refresh (Bearer token or mobile token) force a quota refresh through the plugins; >= 30 s apart
 *   GET /snapshot | /fleet | /tokens?range=24h|7d|14d|30d|all (or legacy ?days=N) | /session/<sid>   (Bearer token)
 *   GET /session/<sid>/plan    (Bearer token) {sid, plan, stored}: the latest plan, live or rebuilt from state.db (plan.js)
 *   GET /session/<sid>/messages | /session/<sid>/call/<id> | /message/<id>/full   (Bearer token; history.js)
 *   WS  /events                (Bearer token; ?token= only with queryToken)  hello -> snapshot -> {t:"evs"|"fleet"|"agents"} pushes
 *
 * `hooks` (optional; index.js deckHooks, Workspace tab): onConnect(ws), onMessage(ws, data, isBinary) ->
 * true when it consumed the message (device heartbeats, CDP tunnel frames), onClose(ws), maxPayload.
 * onHttp(req, res, url) -> true when it answered an authenticated request (bot screen: /desktop/*, /cu/*; spaces: /spaces*).
 * onUpgrade(req, socket, head, url) -> true when it took a relay-token WebSocket under /spaces/ (the space viewer).
 */
function createServer({ token, model, fleet, version, hooks = null, history = null, plans = null, queryToken = false, bundles = null, mobile = null, host = null }) {
  const started = Date.now();
  // Host versions (compat.js): protocol, each profile's plugin version, the updater's last check. `v` stays first
  // and unchanged: apps before 0.3.6 read only `v` (as "the newest app version" signal).
  const hostInfo = () => {
    if (!host) return {};
    const out = { protocol: host.protocol, plugins: host.plugins ? host.plugins() : {} };
    const upd = host.update ? host.update() : null;
    if (upd) {
      out.updateAvailable = upd.available;
      if (upd.latest) out.latest = upd.latest;
    }
    return out;
  };
  const clients = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: (hooks && hooks.maxPayload) || 64 * 1024 });
  const snapshot = () => ({ ...model.snapshot(), fleet: fleet.data, tokens: model.tokens(7) });

  const json = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  };

  /** {body: {sid, plan, stored}} or {code, error}: the model's plan, else one rebuilt by `plans` (plan.js PlanStore). */
  const planOf = (sid, detail) => {
    if (detail && detail.plan) return { body: { sid, plan: detail.plan, stored: false } };
    if (!plans) return detail ? { body: { sid, plan: null, stored: false } } : { code: 404, error: "not found" };
    try {
      const r = plans.get(sid, detail ? detail.profile : undefined);
      if (!r.found && !detail) return { code: 404, error: "not found" };
      return { body: { sid, plan: r.plan, stored: !!r.plan } };
    } catch (e) {
      console.error(`plan: ${e.kind || "unavailable"}`);
      return detail ? { body: { sid, plan: null, stored: false } } : { code: 503, error: "plan read failed" };
    }
  };

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://relay");
    } catch {
      return json(res, 400, { error: "bad url" });
    }
    if (url.pathname === "/health") {
      const { plugins: _private, ...publicHost } = hostInfo(); // profile names are not public
      return json(res, 200, { ok: true, v: version, ...publicHost, uptime: Math.round((Date.now() - started) / 1000), clients: clients.size, sessions: model.sessions.size });
    }
    if (mobile && mobile.onHttp(req, res, url)) return;
    const mobileAuth = mobile && mobile.authenticate(req);
    if (!mobileAuth && !tokenOk(req, token, queryToken)) return json(res, 401, { error: "unauthorized" });
    if (mobileAuth && !(req.method === "GET" && (["/snapshot", "/fleet", "/tokens"].includes(url.pathname) || /^\/(session|message|cu)\//.test(url.pathname)) || req.method === "POST" && ["/desktop/lease", "/desktop/stop", "/fleet/quotas/refresh"].includes(url.pathname))) return json(res, 403, { error: "mobile access denied" });
    if (bundles && (url.pathname === "/bundle" || url.pathname.startsWith("/bundle/")) && !req.headers.authorization?.startsWith("Bearer ")) return json(res, 401, { error: "relay bearer required" });
    if (bundles && bundles.onHttp(req, res, url)) return; // D3: opaque envelopes, device-bound access
    if (url.pathname.startsWith("/spaces/") && !tokenOk(req, token, false)) return json(res, 401, { error: "relay bearer required" });
    if (hooks && hooks.onHttp && hooks.onHttp(req, res, url)) return; // bot screen: lease, stop, frames
    if (req.method === "POST" && url.pathname === "/fleet/quotas/refresh") {
      // On-demand quota refresh (Usage refresh button, phone and desktop). Rate limit and wait live in Fleet.refreshQuotas.
      if (!fleet.refreshQuotas) return json(res, 501, { error: "quota refresh unavailable" });
      req.resume();
      fleet.refreshQuotas().then(
        (r) => json(res, 200, { ok: true, refreshed: r.refreshed, throttled: r.throttled, timedOut: r.timedOut, retryAfterS: r.retryAfterS, quotas: r.fleet.quotas || {}, profiles: r.fleet.profiles || {} }),
        () => json(res, 500, { error: "refresh failed" }));
      return;
    }
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    if (url.pathname === "/snapshot") return json(res, 200, snapshot());
    if (url.pathname === "/fleet") return json(res, 200, fleet.data);
    if (url.pathname === "/tokens") {
      // ?range=24h|7d|14d|30d|all -> {range, bucket, from, to, since, rows}; legacy ?days=N -> day rows (array)
      if (url.searchParams.has("range")) {
        const range = url.searchParams.get("range");
        if (!RANGES.includes(range)) return json(res, 400, { error: "bad range" });
        return json(res, 200, model.tokensRange(range));
      }
      const days = Math.min(400, Math.max(1, Number(url.searchParams.get("days")) || 7));
      return json(res, 200, model.tokens(days));
    }
    // sub-agent views (B1/B3): message history from state.db / transcripts, on demand
    const hr = history ? history.handle(url) : null;
    if (hr) return json(res, hr.code, hr.body);
    const m = /^\/session\/([^/]+)(\/plan)?$/.exec(url.pathname);
    if (m) {
      let sid;
      try {
        sid = decodeURIComponent(m[1]);
      } catch {
        return json(res, 400, { error: "bad path" }); // a malformed %-escape must not throw out of the handler
      }
      const d = model.detail(sid);
      if (m[2]) {
        // the Plan tab: the live plan, else the latest one the stored session published (state.db, read-only)
        const p = planOf(sid, d);
        return p.code ? json(res, p.code, { error: p.error }) : json(res, 200, p.body);
      }
      if (d && !d.plan && plans) {
        const p = planOf(sid, d);
        if (p.body && p.body.plan) d.plan = p.body.plan;
      }
      return d ? json(res, 200, d) : json(res, 404, { error: "not found" });
    }
    return json(res, 404, { error: "not found" });
  });

  server.on("upgrade", (req, socket, head) => {
    let path = "";
    try {
      path = new URL(req.url, "http://relay").pathname;
    } catch {
      /* fall through to 401 */
    }
    const mobileAuth = mobile && mobile.authenticate(req);
    if (path === "/mobile/bridge" && mobileAuth) {
      try { mobile.upgrade(req, socket, head, mobileAuth); } catch { socket.destroy(); }
      return;
    }
    // agent spaces: the space viewer's media socket, relay token only (never a mobile token)
    if (hooks && hooks.onUpgrade && path.startsWith("/spaces/")) {
      if (!tokenOk(req, token, queryToken)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      let url;
      try {
        url = new URL(req.url, "http://relay");
      } catch {
        return socket.destroy();
      }
      if (hooks.onUpgrade(req, socket, head, url)) return;
    }
    if (path !== "/events" || (!mobileAuth && !tokenOk(req, token, queryToken))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (mobileAuth) {
      try { if (mobile.device(mobileAuth.id).sockets.size >= 4) throw new Error("socket limit"); }
      catch { socket.destroy(); return; }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      if (mobileAuth) {
        ws.mobileDevice = mobileAuth;
        mobile.device(mobileAuth.id).sockets.add(ws);
      }
      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
      });
      const drop = () => {
        clients.delete(ws);
        if (mobileAuth) mobile.devices.get(mobileAuth.id)?.sockets.delete(ws);
        if (hooks) hooks.onClose(ws); // Workspace tab: device presence + CDP tunnel
      };
      ws.on("close", drop);
      ws.on("error", drop);
      ws.on("message", (data, isBinary) => {
        if (hooks && hooks.onMessage(ws, data, isBinary)) return; // Workspace tab: heartbeat or tunnel frame
        let msg;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (msg.t === "ping") ws.send(JSON.stringify({ t: "pong", now: Date.now() / 1000 }));
        if (msg.t === "resync") ws.send(JSON.stringify({ t: "snapshot", ...snapshot() }));
      });
      ws.send(JSON.stringify({ t: "hello", v: version, ...hostInfo(), now: Date.now() / 1000 }));
      ws.send(JSON.stringify({ t: "snapshot", ...snapshot() }));
      if (hooks) hooks.onConnect(ws); // Workspace tab: sends the current {t:"devices"} state
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* closed under us */
      }
    }
  }, 30_000);
  server.on("close", () => clearInterval(heartbeat));

  function broadcast(msg) {
    if (!clients.size) return;
    const s = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState !== 1) continue;
      if (ws.bufferedAmount > MAX_BUFFERED) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      ws.send(s);
    }
  }

  return { server, broadcast, clients };
}

module.exports = { createServer, tokenOk };
