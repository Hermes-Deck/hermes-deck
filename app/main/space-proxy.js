"use strict";
// Local end of the agent space viewer. The viewer page (cua-spacesd's, served by the relay under
// /spaces/host/view/) is loaded from this loopback proxy rather than from the relay's own address, for two
// reasons: a loopback page is a secure context (the viewer decodes video with WebCodecs, which needs one; the
// relay is plain http on the tailnet), and the relay token is added here, so it is never in a URL or in the page.
// A random path secret keeps other local programs out. Pure Node (no electron import).
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const PREFIX = "/spaces/host/view/";

/**
 * @param {{relayBase: () => string, token: () => string}} o  relayBase: "http(s)://host:port" of the relay
 * @returns {Promise<{base: string, close: () => void}>}
 */
async function startSpaceProxy({ relayBase, token }) {
  const secret = crypto.randomBytes(18).toString("base64url");
  const head = `/${secret}/`;
  // its own pools and socket list, so close() ends every connection this proxy made (also the media sockets)
  const agents = { "http:": new http.Agent({ keepAlive: true }), "https:": new https.Agent({ keepAlive: true }) };
  const live = new Set();
  const track = (s) => (live.add(s), s.once("close", () => live.delete(s)), s);

  /** The relay path for a local URL, or null when it is not ours to forward. */
  const target = (url) => {
    if (!url.startsWith(head)) return null;
    const rest = url.slice(head.length);
    const pathPart = rest.split("?")[0];
    let decoded;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      return null;
    }
    if (!pathPart || decoded.includes("..") || decoded.startsWith("/") || decoded.includes("\\")) return null;
    return PREFIX + rest;
  };

  const upstream = (path, req) => {
    const u = new URL(relayBase());
    const mod = u.protocol === "https:" ? https : http;
    const headers = { ...req.headers, host: u.host, authorization: `Bearer ${token()}` };
    delete headers.cookie;
    delete headers.origin; // the relay is not this page's origin; it authenticates by the token
    const agent = req.headers.upgrade ? false : agents[u.protocol];
    return mod.request({ protocol: u.protocol, hostname: u.hostname, port: u.port, method: req.method, path, headers, agent });
  };

  const srv = http.createServer((req, res) => {
    const path = target(req.url);
    if (!path) return res.writeHead(404).end();
    const up = upstream(path, req);
    up.on("response", (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    req.pipe(up);
  });

  srv.on("upgrade", (req, sock, head0) => {
    const path = target(req.url);
    if (!path) return sock.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    const up = upstream(path, req);
    up.on("upgrade", (r, usock, uhead) => {
      const lines = [`HTTP/1.1 ${r.statusCode} ${r.statusMessage || "Switching Protocols"}`];
      for (let i = 0; i < r.rawHeaders.length; i += 2) lines.push(`${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}`);
      sock.write(lines.join("\r\n") + "\r\n\r\n");
      if (uhead && uhead.length) sock.write(uhead);
      if (head0 && head0.length) usock.write(head0);
      track(sock);
      track(usock);
      usock.pipe(sock).pipe(usock);
      usock.on("error", () => sock.destroy());
      sock.on("error", () => usock.destroy());
    });
    up.on("response", (r) => {
      sock.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage || ""}\r\nConnection: close\r\n\r\n`);
      r.resume();
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

module.exports = { startSpaceProxy, PREFIX };
