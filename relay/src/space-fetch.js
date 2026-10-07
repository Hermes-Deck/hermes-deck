"use strict";
// Agent spaces phase 2: the relay's HTTP to an agent desktop's cua-spacesd, used by the driver's MCP bridge
// (makeSpaceFetch), the desktop registry's start wait (makeReady) and the viewer proxy in spaces.js (pickHeaders,
// localTarget). The agent host's own desktops are reached on 127.0.0.1 with their container token; a Deck's through
// the space tunnel, where the Deck adds the token. Request headers come from allowlists, never wholesale.
const http = require("http");

// Hermes profiles that are also Docker-name safe (desktops.js, app/main/desktop-host.js)
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// "host" is the shared space's id: never an agent desktop (desktops.js refuses it too)
const goodProfile = (p) => typeof p === "string" && PROFILE_RE.test(p) && !p.includes("..") && p !== "host";
const NOT_RUNNING = "that agent's desktop is not running"; // the Deck's answer too (app/main/space-tunnel.js)
const MAX_BODY = 32 * 1024 * 1024; // as the space tunnel caps a body

// Request headers an agent desktop may get from the relay: built from these lists, never from incoming headers
// wholesale (no cookie, no authorization, no custom auth header such as the viewer's x-cua-env-authorization ticket).
const HEADERS = {
  mcp: ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"],
  view: [
    "accept", "accept-encoding", "accept-language", "cache-control", "pragma", "content-type", "content-encoding", "if-none-match", "if-modified-since", "range",
    "x-grpc-web", "x-user-agent", "grpc-timeout", "grpc-encoding", "grpc-accept-encoding",
    "connect-protocol-version", "connect-timeout-ms", "connect-content-encoding", "connect-accept-encoding",
  ],
  ws: ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"],
};

/** Only the allowlisted headers of `kind` ("mcp", "view", "ws"), lower-cased, with no CR, LF or NUL in a value. */
function pickHeaders(h, kind) {
  const out = {};
  if (!h || typeof h !== "object") return out;
  const allow = new Set(HEADERS[kind] || []);
  for (const [k, v] of Object.entries(h)) {
    const key = String(k).toLowerCase();
    if (!allow.has(key)) continue;
    const val = Array.isArray(v) ? v.join(", ") : v;
    if ((typeof val === "string" || typeof val === "number") && !/[\r\n\0]/.test(String(val)) && String(val).length <= 8192) out[key] = String(val);
  }
  return out;
}

const notRunning = () => Object.assign(new Error(NOT_RUNNING), { status: 502, code: "NOT_RUNNING" });
const isNotRunning = (e) => !!e && (e.code === "NOT_RUNNING" || /not running/i.test(String(e.message || "")));

/** The agent host's own desktop of `profile`: {port, token}, or null when it is not running (or has no token). */
async function localTarget(desktops, local, profile) {
  if (!local || !goodProfile(profile)) return null;
  let port = desktops && typeof desktops.portOf === "function" ? desktops.portOf(profile) : null;
  if (!port) {
    try {
      const d = (await local.list()).find((x) => x && x.profile === profile && x.running);
      port = d && Number.isInteger(d.port) ? d.port : null;
    } catch {
      port = null;
    }
  }
  let token = null;
  try {
    token = port ? local.tokenOf(profile) : null;
  } catch {}
  return port && token ? { port, token } : null;
}

/** One buffered HTTP request to 127.0.0.1:port -> {status, headers, body}. A refused connection is "not running". */
function loopback({ port, token = null, method, path, headers = {}, body = Buffer.alloc(0), timeoutMs = 25_000 }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers, host: `127.0.0.1:${port}` };
    if (token) h.authorization = `Bearer ${token}`;
    if (body.length || (method !== "GET" && method !== "HEAD")) h["content-length"] = String(body.length);
    // agent: false: a fresh connection each time, never a pooled one left over from a container that has since gone
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: h, timeout: timeoutMs, agent: false }, (res) => {
      const parts = [];
      let n = 0;
      res.on("data", (d) => {
        if ((n += d.length) > MAX_BODY) return req.destroy(new Error("response body too large"));
        parts.push(d);
      });
      res.on("end", () => resolve({ status: res.statusCode || 502, headers: res.headers, body: Buffer.concat(parts) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("the desktop did not answer in time"), { status: 504 })));
    req.on("error", (e) => reject(e && e.code === "ECONNREFUSED" ? notRunning() : e)); // a reset is an error, not "not running"
    req.end(body);
  });
}

/**
 * The driver's way to an agent desktop's MCP (driver.js spaceFetch): spaceFetch(host, profile) -> (req) =>
 * {status, headers, body}. POST /mcp only: the space tunnel buffers whole answers, so an MCP GET (an SSE stream) never
 * goes through it. Headers from the MCP allowlist; the container token is added on the desktop's own host (here for
 * the agent host, on the Deck for a Deck's). An answer that the desktop is not running marks it off and resolves it
 * once more; when that gives the agent a desktop again, the request is retried once there (never a loop).
 */
function makeSpaceFetch({ desktops, local = null, tunnel = null, timeoutMs = 25_000 }) {
  const call = async (host, profile, r) => {
    if (host === "agent-host") {
      const tg = await localTarget(desktops, local, profile);
      if (!tg) throw notRunning();
      return loopback({ ...tg, ...r, timeoutMs });
    }
    if (!tunnel) throw Object.assign(new Error("no way to that desktop host"), { status: 502 });
    return tunnel.http(host, { profile, ...r });
  };
  return (host, profile) => {
    let where = host;
    return async (req) => {
      const method = String((req && req.method) || "").toUpperCase();
      if (method !== "POST" || !req || req.path !== "/mcp") throw new Error("only POST /mcp reaches an agent's desktop");
      const b = req.body == null ? Buffer.alloc(0) : Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
      const r = { method: "POST", path: "/mcp", headers: pickHeaders(req.headers, "mcp"), body: b };
      try {
        return await call(where, profile, r);
      } catch (e) {
        if (!isNotRunning(e)) throw e;
        if (typeof desktops.markOff === "function") desktops.markOff(profile);
        if (r.headers["mcp-session-id"]) {
          // the session belongs to the dead container: start it again for the agent's retry, do not wait here
          Promise.resolve()
            .then(() => desktops.resolve(profile))
            .catch(() => {});
          throw e;
        }
        let d = null;
        try {
          d = await desktops.resolve(profile);
        } catch {}
        if (!d || d.kind !== "space" || typeof d.host !== "string") throw e;
        where = d.host;
        return call(where, profile, r);
      }
    };
  };
}

/**
 * Desktops' `ready` (desktops.js): wait for a started desktop's cua-spacesd to answer /health, polling every
 * intervalMs up to timeoutMs. The agent host's: 127.0.0.1:<port>/health; a Deck's: through the tunnel (the Deck adds
 * the token).
 */
function makeReady({ tunnel = null, intervalMs = 500, timeoutMs = 30_000 } = {}) {
  const ok = (s) => s >= 200 && s < 300;
  const once = async (host, profile, port, left) => {
    if (host === "agent-host") {
      if (!Number.isInteger(port)) return false;
      return ok((await loopback({ port, method: "GET", path: "/health", timeoutMs: Math.max(100, Math.min(3000, left)) })).status);
    }
    if (!tunnel) return false;
    let timer = null;
    const late = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error("health check timed out")), Math.max(1, left));
      if (timer.unref) timer.unref();
    });
    try {
      return ok((await Promise.race([tunnel.http(host, { profile, method: "GET", path: "/health" }), late])).status);
    } finally {
      clearTimeout(timer);
    }
  };
  return async (host, profile, port) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (Date.now() >= end) throw new Error("the desktop did not answer /health in time");
        if (await once(host, profile, port, end - Date.now())) return true;
      } catch (e) {
        if (/did not answer \/health/.test(String(e && e.message))) throw e;
      }
      if (Date.now() + intervalMs > end) throw new Error("the desktop did not answer /health in time");
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
}

module.exports = { makeSpaceFetch, makeReady, pickHeaders, localTarget, loopback, notRunning, isNotRunning, goodProfile, NOT_RUNNING };
