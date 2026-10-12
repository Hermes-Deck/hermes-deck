"use strict";
// Large attachments for direct Hermes chats. When the relay and the Hermes plugin share this host's upload spool (the
// relay's hello `uploads.host` equals the plugin's deck.version `uploads.host`: same machine, same real folder), each
// tray file is streamed over HTTP into the relay's disk spool (relay.js upload: fs.createReadStream, never read whole
// here) and the bridge names only the spool ids (deck.attach_staged); the plugin moves the files into the session.
// Otherwise the old path stays: base64 in one deck.attach_submit line, 25 MB per file / 50 MB per message.
// No Electron imports here, so the tests drive it with plain Node.
const { t: i18nText } = require("../renderer/i18n");
const { HERMES_ATTACH } = require("./media");

const HOST_RE = /^[a-f0-9]{16}$/;

/**
 * The limits of the relay path ({files, file, total}) when it can be used, else null (old path): both sides must name
 * the same spool host. The relay's own numbers apply, but never more than ten files (the plugin's ATTACH_MAX_FILES).
 */
function stagedRoute(relayUploads, pluginUploads) {
  const r = relayUploads, p = pluginUploads;
  const n = (v) => Number.isSafeInteger(v) && v > 0;
  if (!r || r.v !== 1 || typeof r.host !== "string" || !HOST_RE.test(r.host) || !n(r.files) || !n(r.fileBytes) || !n(r.totalBytes)) return null;
  if (!p || p.v !== 1 || p.host !== r.host) return null;
  return { files: Math.min(r.files, HERMES_ATTACH.files), file: r.fileBytes, total: r.totalBytes };
}

/** The relay path for this send ({relay, limits}) or null, asking the plugin now (deck.version answers locally, fast). */
async function pickRoute(relay, bridge) {
  if (!relay || typeof relay.upload !== "function" || !relay.connected || !relay.uploads) return null;
  let version = null;
  try {
    version = await bridge.version();
  } catch {
    version = null;
  }
  const limits = stagedRoute(relay.uploads, version && version.uploads);
  return limits ? { relay, limits } : null;
}

/** A readable message for a relay upload failure; other errors (Hermes, the bridge) pass through unchanged. */
function uploadMessage(error, name) {
  if (!error || !error.relayUpload) return null;
  if (error.code === "canceled") return i18nText("U0018");
  if (error.code === "disk_full" || error.status === 507) return i18nText("attach.relayDiskFull", { name });
  return i18nText("attach.relayUploadFailed", { name, e: String(error.message || error.code || "").slice(0, 200) });
}

/**
 * Uploads the tray items one after another to the relay, then sends the message with their spool ids through the
 * bridge (deck.attach_staged). `items`: AttachStore.hermesItems() rows ({token, name, size, mime, path|buffer}).
 * progress(token, fraction) per file; `signal` cancels the uploads (never the Hermes request once it is sent).
 * Uploads are deleted on the relay afterwards: consumed ones are gone already, the rest is cleaned now; only when the
 * bridge's answer is unknown (a timeout: the plugin may still be moving them) they are left to the relay's TTL sweep.
 */
async function sendStaged({ relay, bridge, items, sid, text, profile, progress = null, signal = null }) {
  const ids = [];
  let keep = false;
  try {
    for (const it of items) {
      let id;
      try {
        ({ id } = await relay.upload(
          { path: it.buffer ? null : it.path, buffer: it.buffer || null, name: it.name, mime: it.mime || "application/octet-stream", size: it.size },
          { signal, onProgress: progress ? (p) => progress(it.token, p) : null }
        ));
      } catch (error) {
        const message = uploadMessage(error, it.name);
        throw message ? Object.assign(new Error(message), { relayUpload: true, code: error.code }) : error;
      }
      ids.push(id);
      if (progress) progress(it.token, 1);
    }
    try {
      return await bridge.send(sid, text, { profile, staged: items.map((it, i) => ({ upload: ids[i], filename: it.name })) });
    } catch (error) {
      keep = !Number.isInteger(error && error.rpcCode) || error.rpcCode === -32001; // no definite answer: the outcome is unknown
      throw error;
    }
  } finally {
    if (!keep) for (const id of ids) Promise.resolve().then(() => relay.deleteUpload(id)).catch(() => {});
  }
}

module.exports = { stagedRoute, pickRoute, sendStaged, uploadMessage };
