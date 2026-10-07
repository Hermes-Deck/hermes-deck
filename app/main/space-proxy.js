"use strict";
// Local end of the agent space viewer. The viewer page (cua-spacesd's) is loaded from this loopback proxy rather
// than from the relay's own address, for two reasons: a loopback page is a secure context (the viewer decodes video
// with WebCodecs, which needs one; the relay is plain http on the tailnet), and the credentials are added here, so
// they are never in a URL or in the page. A random path secret keeps other local programs out.
//
// URL layout: /<secret>/<spaceId>/<rest>, spaceId "host" (the shared desktop) or an agent profile. target(spaceId)
// says where that space is:
//   - {kind: "relay"}: the relay's view proxy /spaces/<spaceId>/view/<rest>, with the relay token (the relay applies
//     its allow list and level rules, and adds the container token on the desktop's own host);
//   - {kind: "local", port, token}: an agent desktop on this computer (main/desktops.js), straight on 127.0.0.1:<port>
//     with its container token. The relay is not on this path, so its rules are applied here instead
//     (space-view-logic.js viewRest: the same allow list; input paths only above Watch, by level(spaceId)).
// Either way: a decoded path with anything outside printable ASCII (CR, LF, space, tab ...) or a way out ("..", "//",
// "\") is refused before any upstream is called, and upstream request headers are built from an allowlist (never the
// client's authorization, cookie, origin or the viewer's own ticket header). Pure Node (no electron import).
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { safeRest, viewRest, isSpace, levelOk } = require("./space-view-logic");

const PREFIX = "/spaces/"; // the relay's per-space view path: /spaces/<spaceId>/view/<rest>
const PRINTABLE = /^[\x21-\x7e]+$/;

// Request headers the viewer's calls may carry upstream: the relay's own lists (relay/src/space-fetch.js HEADERS).
const VIEW_HEADERS = new Set([
  "accept", "accept-encoding", "accept-language", "cache-control", "pragma", "content-type", "content-encoding", "if-none-match", "if-modified-since", "range",
  "x-grpc-web", "x-user-agent", "grpc-timeout", "grpc-encoding", "grpc-accept-encoding",
  "connect-protocol-version", "connect-timeout-ms", "connect-content-encoding", "connect-accept-encoding",
]);
const WS_HEADERS = new Set(["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]);
const RESPONSE_DROP = /^(?:authorization|proxy-authorization|set-cookie|connection|keep-alive|transfer-encoding|te|trailer|upgrade|proxy-connection)$/;

/** Allowlisted request headers, lower-cased, no CR/LF/NUL in a value; a body's length when it has a plain one. */
function pickHeaders(h, ws) {
  const allow = ws ? WS_HEADERS : VIEW_HEADERS;
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    const key = String(k).toLowerCase();
    const val = Array.isArray(v) ? v.join(", ") : String(v);
    if (/[\r\n\0]/.test(val) || val.length > 8192) continue;
    if (allow.has(key) || (!ws && key === "content-length" && /^\d{1,12}$/.test(val))) out[key] = val;
  }
  return out;
}

/** Response headers for the viewer: no credentials, cookies or hop-by-hop, nothing holding a token. */
function responseHeaders(h, secrets) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    const key = String(k).toLowerCase();
    if (RESPONSE_DROP.test(key)) continue;
    if ([].concat(v).some((x) => secrets.some((s) => s && String(x).includes(s)))) continue;
    out[key] = v;
  }
  return out;
}

/**
 * @param {{relayBase: () => string, token: () => string,
 *   target?: (spaceId: string) => ({kind: "relay"}|{kind: "local", port: number, token: string}|Promise<…>),
 *   level?: (spaceId: string) => string}} o  relayBase: "http(s)://host:port" of the relay
 * @returns {Promise<{base: string, close: () => void}>}
 */
async function startSpaceProxy({ relayBase, token, target = () => ({ kind: "relay" }), level = () => "watch" }) {
  const secret = crypto.randomBytes(18).toString("base64url");
  const head = `/${secret}/`;
  // its own pools and socket list, so close() ends every connection this proxy made (also the media sockets)
  const agents = { "http:": new http.Agent({ keepAlive: true }), "https:": new https.Agent({ keepAlive: true }) };
  const live = new Set();
  const track = (s) => (live.add(s), s.once("close", () => live.delete(s)), s);

  /** {id, raw, path, search} for a local URL, or null when it is not ours to forward. */
  const parse = (url) => {
    if (typeof url !== "string" || !url.startsWith(head)) return null;
    const after = url.slice(head.length);
    const slash = after.indexOf("/");
    if (slash < 1) return null;
    const id = after.slice(0, slash);
    if (!isSpace(id)) return null; // raw: an encoded id ("%2e%2e") is never a space
    const raw = after.slice(slash + 1);
    const q = raw.indexOf("?");
    const pathPart = q < 0 ? raw : raw.slice(0, q);
    const search = q < 0 ? "" : raw.slice(q);
    if (!PRINTABLE.test(raw)) return null;
    let decoded;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      return null;
    }
    if (!safeRest(decoded)) return null;
    return { id, raw, decoded, search };
  };

  /** Where a parsed request goes: {status} when refused, else {opts, secrets}. */
  const route = async (p, req, ws) => {
    let tg;
    try {
      tg = (await target(p.id)) || { kind: "relay" };
    } catch {
      return { status: 502 };
    }
    const headers = pickHeaders(req.headers, ws);
    if (ws) Object.assign(headers, { connection: "Upgrade", upgrade: "websocket" });
    if (tg.kind === "local") {
      if (!Number.isInteger(tg.port) || tg.port <= 0 || !tg.token) return { status: 502 };
      const l = level(p.id);
      const rest = viewRest(p.decoded, !ws && levelOk(l) && l !== "watch"); // the relay's rule: input only above Watch
      if (!rest) return { status: 403 };
      // the decoded rest is forwarded, as the relay does (parity); it passed the anchored allow-list regexes above
      const path = `/${rest}${p.search}`;
      if (!PRINTABLE.test(path)) return { status: 404 };
      headers.host = `127.0.0.1:${tg.port}`;
      headers.authorization = `Bearer ${tg.token}`;
      return { secrets: [tg.token], opts: { mod: http, protocol: "http:", hostname: "127.0.0.1", port: tg.port, path, headers, agent: ws ? false : agents["http:"] } };
    }
    const u = new URL(relayBase());
    const t = token();
    headers.host = u.host;
    headers.authorization = `Bearer ${t}`;
    const mod = u.protocol === "https:" ? https : http;
    return { secrets: [t], opts: { mod, protocol: u.protocol, hostname: u.hostname, port: u.port, path: `${PREFIX}${p.id}/view/${p.raw}`, headers, agent: ws ? false : agents[u.protocol] } };
  };

  const request = ({ mod, ...o }, method) => mod.request({ ...o, method });

  const srv = http.createServer(async (req, res) => {
    const p = parse(req.url);
    if (!p) return res.writeHead(404).end();
    const r = await route(p, req, false);
    if (r.status) return res.writeHead(r.status).end();
    let up;
    try {
      up = request(r.opts, req.method);
    } catch {
      return res.writeHead(502).end();
    }
    up.on("response", (ur) => {
      res.writeHead(ur.statusCode || 502, responseHeaders(ur.headers, r.secrets));
      ur.pipe(res);
    });
    up.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    res.on("close", () => {
      if (!res.writableFinished) up.destroy(); // the viewer left first (a held stream): end the upstream request
    });
    req.pipe(up);
  });

  srv.on("upgrade", async (req, sock, head0) => {
    sock.on("error", () => sock.destroy());
    const refuse = (status) => sock.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    const p = parse(req.url);
    if (!p) return refuse("404 Not Found");
    const r = await route(p, req, true);
    if (r.status) return refuse(r.status === 403 ? "403 Forbidden" : r.status === 404 ? "404 Not Found" : "502 Bad Gateway");
    if (sock.destroyed) return;
    let up;
    try {
      up = request(r.opts, "GET");
    } catch {
      return refuse("502 Bad Gateway");
    }
    up.on("upgrade", (ur, usock, uhead) => {
      const lines = [`HTTP/1.1 ${ur.statusCode} ${ur.statusMessage || "Switching Protocols"}`];
      for (let i = 0; i < ur.rawHeaders.length; i += 2) {
        const [k, v] = [ur.rawHeaders[i], ur.rawHeaders[i + 1]];
        if (/^(?:authorization|proxy-authorization|set-cookie)$/i.test(k) || r.secrets.some((s) => s && String(v).includes(s))) continue;
        lines.push(`${k}: ${v}`);
      }
      sock.write(lines.join("\r\n") + "\r\n\r\n");
      if (uhead && uhead.length) sock.write(uhead);
      if (head0 && head0.length) usock.write(head0);
      track(sock);
      track(usock);
      usock.pipe(sock).pipe(usock);
      usock.on("error", () => sock.destroy());
      sock.on("error", () => usock.destroy());
    });
    up.on("response", (ur) => {
      sock.end(`HTTP/1.1 ${ur.statusCode} ${ur.statusMessage || ""}\r\nConnection: close\r\n\r\n`);
      ur.resume();
    });
    up.on("error", () => sock.destroy());
    up.end();
  });

  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", resolve);
  });
  srv.unref();
  return {
    base: `http://127.0.0.1:${srv.address().port}${head}`,
    close: () => {
      srv.close();
      srv.closeAllConnections?.();
      for (const s of live) s.destroy();
      for (const a of Object.values(agents)) a.destroy();
    },
  };
}

module.exports = { startSpaceProxy, PREFIX, pickHeaders, responseHeaders };
