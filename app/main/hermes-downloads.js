"use strict";
// Large downloads for direct Hermes chats. When the relay and the Hermes plugin share this host's spool (the relay's
// hello `downloads.host` equals the plugin's deck.version `downloads.host`: same machine, same real folder), a file
// the agent offered is granted by the plugin (deck.file_grant: deck.file_read's own authorization, a short-lived
// ticket in the spool) and streamed over HTTP from the relay (GET /downloads/<id>, resumed with Range after a cut);
// the active limit is the smaller of both sides' maxBytes (8 GB by default). Otherwise the old path stays: 1 MiB
// chunks through the bridge (deck.file_read), 200 MB at most. No Electron imports here, so the tests drive it with
// plain Node.
const { FILE_MAX } = require("./hermes-files");

const HOST_RE = /^[a-f0-9]{16}$/;
const TOO_BIG = 4083; // observer.py: the file is over the cap of the method that was asked

/** The relay path's per-file limit when it can be used, else null (old path): both sides must name the same spool host. */
function downloadRoute(relayDownloads, pluginDownloads) {
  const r = relayDownloads, p = pluginDownloads;
  const n = (v) => Number.isSafeInteger(v) && v > 0;
  if (!r || r.v !== 1 || typeof r.host !== "string" || !HOST_RE.test(r.host) || !n(r.maxBytes)) return null;
  if (!p || p.v !== 1 || p.host !== r.host || !n(p.maxBytes)) return null;
  return { maxBytes: Math.min(r.maxBytes, p.maxBytes) };
}

/** The relay path for this download ({relay, maxBytes}) or null, asking the plugin now (deck.version answers locally). */
async function pickRoute(relay, bridge) {
  if (!relay || typeof relay.download !== "function" || !relay.connected || !relay.downloads) return null;
  let version = null;
  try {
    version = await bridge.version();
  } catch {
    version = null;
  }
  const route = downloadRoute(relay.downloads, version && version.downloads);
  return route ? { relay, maxBytes: route.maxBytes } : null;
}

/** The limit that applies to a download now: the relay path's, else the chunk path's 200 MB. */
const activeLimit = (route) => (route ? route.maxBytes : FILE_MAX);

/**
 * `open(start, signal)` for Downloads.run: the relay stream of a granted file from byte `start`. A ticket that expired
 * (the relay answers 404, e.g. after a long Save As dialog or a resume after 15 min) is granted once more, and only
 * when the plugin still sees the same file (size and mtime) the download goes on.
 */
function opener({ relay, bridge, sid, path, profile, grant }) {
  let current = grant;
  return async (start, signal) => {
    try {
      return (await relay.download(current.id, { start, signal })).res;
    } catch (error) {
      if (!(error && error.relayDownload && error.status === 404)) throw error;
      const again = await bridge.fileGrant(sid, path, { profile });
      if (again.size !== grant.size || again.mtime !== grant.mtime) throw Object.assign(new Error("file changed"), { code: "changed" });
      current = again;
      return (await relay.download(current.id, { start, signal })).res;
    }
  };
}

/** True when a host error says the file is over the asked method's cap (deck.file_read 200 MB, deck.file_grant 8 GB). */
const tooBig = (error) => !!error && error.rpcCode === TOO_BIG;

module.exports = { downloadRoute, pickRoute, activeLimit, opener, tooBig };
