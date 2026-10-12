"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
// Small file helpers shared by the Telegram media cache, the fixture service and the IPC handlers.
// Nothing here talks to Telegram; it only names, sniffs and writes files under userData/media.
const fs = require("fs");
const path = require("path");

const MAX_FULL = 25 * 1024 * 1024; // full downloads stop here; bigger files are opened in Telegram
const INLINE_IMAGE = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

// Never handed to shell.openPath: these run code (or point at code) when opened. "Download" still saves them.
const RISKY_EXT = new Set(
  (
    "exe msi msp bat cmd com scr pif cpl msc ps1 psm1 psd1 vbs vbe js jse wsf wsh hta lnk url reg inf " +
    "jar dll sys appx msix appxbundle msixbundle appinstaller application gadget scf " +
    "py pyw pyz pl rb sh bash command tool app pkg mpkg workflow terminal"
  ).split(" ")
);

const MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/flac": ".flac",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/x-tgsticker": ".tgs",
  "text/plain": ".txt",
  "text/csv": ".csv",
};

/** A file name that is safe on Windows and macOS: no folders, no reserved names, sane length. */
function safeName(name, fallback = i18nText("common.file")) {
  let n = String(name || "")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = `_${n}`;
  if (!n) n = fallback;
  if (n.length > 120) {
    const ext = path.extname(n).slice(0, 12);
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

const extFor = (mime) => MIME_EXT[String(mime || "").toLowerCase()] || "";

/** Real image type from the first bytes (Telegram thumbnails are JPEG or WEBP regardless of the document). */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

const isRisky = (name) => RISKY_EXT.has(path.extname(String(name || "")).slice(1).toLowerCase());

/** Write through a temp file so a crash never leaves a half file that looks cached. */
function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

/** Size of a cached file, or 0 when it is missing or empty. */
function cachedSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
/** A limit in words: "25 MB", "2 GB", "4 GB" (GB from 1 GiB up, one decimal only when needed). */
const human = (n) => (n >= 1024 ** 3 ? `${Number((n / 1024 ** 3).toFixed(1))} GB` : mb(n));

// What one direct-Hermes message may carry (deck.attach_submit). hermes-plugin/hermes-deck/observer.py
// ATTACH_* must stay equal: the plugin enforces the same numbers again. Larger files go through the relay's disk spool
// instead (deck.attach_staged, hermes-uploads.js) with the limits the relay announces (2 GB per file by default).
const HERMES_ATTACH = Object.freeze({ files: 10, file: 25 * 1024 * 1024, total: 50 * 1024 * 1024 });

module.exports = { MAX_FULL, INLINE_IMAGE, RISKY_EXT, HERMES_ATTACH, safeName, extFor, sniffImage, isRisky, writeAtomic, cachedSize, mb, human };
