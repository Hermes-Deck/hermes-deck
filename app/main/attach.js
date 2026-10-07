"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
// File attachments for the composer (A7). The renderer never names a file on disk. A file reaches
// this module only from (1) the main-process open dialog, (2) a drop: the preload turns the dropped
// File objects into paths with webUtils (the page itself never sees them) and main checks each one
// again here, or (3) pasted/dropped bytes without a path (any file type; an image's type is sniffed from
// its bytes, never taken from the page).
// Each accepted file is staged under a random token; the renderer only ever sees
// {token, name, size, kind, risky, preview} and asks main to send or discard a token.
// No Electron imports here, so the tests can drive this module with plain Node.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const media = require("./media");
const { safeName, sniffImage, isRisky, extFor, mb } = media;

const MAX_UPLOAD = 2000 * 1024 * 1024; // Telegram's per-file limit for an ordinary account (4000 × 512 KB parts)
const MAX_PHOTO = 10 * 1024 * 1024; // larger photos are refused as photos by Telegram; they go as files
// Pasted data is copied into the draft directory before sending; teleproto can stream it from disk.
const MAX_PASTE = 25 * 1024 * 1024;
const DRAFT_TOTAL = 100 * 1024 * 1024;
const DRAFT_AGE = 14 * 24 * 3600 * 1000;
const TOKEN = /^[a-f0-9]{24}$/;
const MAX_STAGED = 10; // files waiting in the composer at once
const MAX_CAPTION = 1024; // Telegram's caption limit for an ordinary account
const PHOTO_EXT = new Set([".jpg", ".jpeg", ".png"]); // what teleproto uploads as a photo (sendFile isImage)
const PHOTO_MIME = new Set(["image/jpeg", "image/png"]);

const MSG = {
  get badPath() { return i18nText("U0008"); },
  get notFile() { return i18nText("U0009"); },
  get empty() { return i18nText("U0010"); },
  tooBig: (n) => i18nText("U0011", { n: mb(n) }),
  pasteBig: (n) => i18nText("U0012", { n: mb(n) }),
  get pasteType() { return i18nText("U0013"); },
  get tooMany() { return i18nText("U0014", { MAX_STAGED: MAX_STAGED }); },
  get gone() { return i18nText("U0015"); },
};

/**
 * A short readable name for pasted data: "pasted-20261005-142233.png". Always ASCII English, whatever the UI
 * language: the name is saved on disk and sent to the agent as the file name.
 */
function pasteName(mime, now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `pasted-${stamp}${extFor(mime) || ".bin"}`;
}

/** First bytes of a file (for sniffing), or an empty buffer when it cannot be read. */
async function head(file, n = 16) {
  let fh;
  try {
    fh = await fs.promises.open(file, "r");
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/**
 * "photo" when Telegram can take it as a (compressed) photo: a real JPEG/PNG by its bytes, with a
 * matching extension, up to 10 MB. Anything else is a "file" (sent as a document).
 */
function kindOf(name, size, sniffed) {
  const ext = path.extname(name).toLowerCase();
  return PHOTO_EXT.has(ext) && PHOTO_MIME.has(sniffed) && size <= MAX_PHOTO ? "photo" : "file";
}

class AttachStore {
  /** @param {{preview?: (item) => Promise<string|null>|string|null}} opts preview: a small data: URL for photos (main uses nativeImage) */
  constructor({ preview = null, draftDir = null, now = () => Date.now() } = {}) {
    this.items = new Map(); // token -> {token, name, size, kind, risky, mime, path?, buffer?}
    this.preview = preview;
    this.draftDir = draftDir;
    this.now = now;
    this.draftItems = new Map();
    if (draftDir) this._loadDrafts();
  }

  _loadDrafts() {
    fs.mkdirSync(this.draftDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.draftDir, 0o700);
    const manifest = path.join(this.draftDir, "index.json");
    let rows = [];
    try { rows = JSON.parse(fs.readFileSync(manifest, "utf8")); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    let total = 0;
    for (const row of Array.isArray(rows) ? rows.slice(0, MAX_STAGED) : []) {
      if (!row || typeof row.token !== "string" || !TOKEN.test(row.token) || typeof row.key !== "string" || !row.key || row.key.length > 1024 || !Number.isFinite(row.at) || this.now() - row.at > DRAFT_AGE || row.at > this.now() + 60000) continue;
      const file = path.join(this.draftDir, row.token);
      let stat;
      try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_PASTE || total + stat.size > DRAFT_TOTAL) continue;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const bytes = Buffer.alloc(16);
      try { fs.readSync(fd, bytes, 0, 16, 0); } finally { fs.closeSync(fd); }
      const name = safeName(row.name), mime = sniffImage(bytes) || "application/octet-stream";
      const item = { token: row.token, name, size: stat.size, kind: kindOf(name, stat.size, mime), risky: isRisky(name), mime, path: file, ...(typeof row.appshotText === "string" ? { appshotText: row.appshotText.slice(0, 800) } : {}) };
      this.items.set(item.token, item);
      this.draftItems.set(item.token, { key: row.key, at: row.at });
      total += stat.size;
    }
    this._writeDrafts(); // prunes expired/corrupt/orphan files at startup
  }

  _writeDrafts() {
    if (!this.draftDir) return;
    const rows = [...this.draftItems].map(([token, draft]) => ({ ...draft, token, name: this.items.get(token).name, appshotText: this.items.get(token).appshotText }));
    const temp = path.join(this.draftDir, `index-${crypto.randomBytes(8).toString("hex")}.tmp`);
    fs.writeFileSync(temp, JSON.stringify(rows), { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, path.join(this.draftDir, "index.json"));
    for (const name of fs.readdirSync(this.draftDir)) {
      if (TOKEN.test(name) && !this.draftItems.has(name) || /^index-[a-f0-9]{16}\.tmp$/.test(name)) fs.unlinkSync(path.join(this.draftDir, name));
    }
  }

  /** Associate opaque tokens with a chat (or its outbox); discard/send remove them explicitly. */
  saveDraft(key, tokens) {
    if (!this.draftDir) return false;
    if (typeof key !== "string" || !key || key === "hermes:" || key.length > 1024 || !Array.isArray(tokens) || tokens.length > MAX_STAGED || new Set(tokens).size !== tokens.length) throw new Error("Invalid attachment draft");
    const wanted = tokens.map(token => this.get(token));
    const retained = [...this.draftItems].filter(([token, draft]) => !tokens.includes(token));
    const total = retained.reduce((n, [token]) => n + this.get(token).size, 0) + wanted.reduce((n, item) => n + item.size, 0);
    if (wanted.some(item => item.size > MAX_PASTE)) throw new Error("Draft file exceeds 25 MB");
    if (total > DRAFT_TOTAL) throw new Error("Attachment drafts exceed 100 MB");
    // Validate/read every input before changing the durable snapshot.
    const copies = wanted.filter(item => !this.draftItems.has(item.token)).map(item => {
      const bytes = item.buffer || fs.readFileSync(item.path);
      if (bytes.length !== item.size || bytes.length > MAX_PASTE) throw new Error("Draft file changed while staging");
      return { item, bytes };
    });
    for (const { item, bytes } of copies) {
      const file = path.join(this.draftDir, item.token);
      fs.writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
      item.path = file; delete item.buffer; // teleproto streams larger pasted files from disk
    }
    this.draftItems = new Map(retained);
    for (const item of wanted) this.draftItems.set(item.token, { key, at: this.now() });
    this._writeDrafts();
    return true;
  }

  pruneDrafts() {
    for (const [token, draft] of [...this.draftItems]) if (this.now() - draft.at > DRAFT_AGE) this.discard(token);
  }

  async restoreDrafts() {
    this.pruneDrafts();
    const result = Object.create(null);
    for (const [token, draft] of this.draftItems) {
      const item = this.get(token);
      let preview = null;
      if (this.preview && item.mime.startsWith("image/")) preview = await this.preview(item);
      (result[draft.key] ||= []).push(this.view(item, preview));
    }
    return { ...result };
  }

  forgetDraft(key) {
    for (const [token, draft] of [...this.draftItems]) if (draft.key === key) this.discard(token);
  }

  _room() {
    this.pruneDrafts();
    if (this.items.size >= MAX_STAGED) throw new Error(MSG.tooMany);
  }

  async _add(item) {
    this._room();
    item.token = crypto.randomBytes(12).toString("hex");
    this.items.set(item.token, item);
    let preview = null;
    if (this.preview && item.mime && item.mime.startsWith("image/")) {
      try {
        preview = (await this.preview(item)) || null;
      } catch {
        preview = null; // no thumbnail is fine; the chip shows the name
      }
    }
    return this.view(item, preview);
  }

  /** What the renderer may know about a staged file: never its path. */
  view(item, preview = null) {
    return { token: item.token, name: item.name, size: item.size, kind: item.kind, risky: item.risky, preview: typeof preview === "string" && preview.startsWith("data:image/") ? preview : null, image: !!(item.mime && item.mime.startsWith("image/")), ...(item.appshotText ? { appshot: true, text: item.appshotText } : {}) };
  }

  /** Main-only capture: reuse the image staging checks and keep exactly the text shown in its chip. */
  async stageAppshot({ bytes, window, text }) {
    const view = await this.stageData({ bytes });
    const item = this.get(view.token);
    item.name = safeName(`appshot-${window.app}${extFor(item.mime)}`);
    item.appshotText = `${window.app}: ${window.title}\n${String(text || "").trim()}`.trim().slice(0, 800);
    return { ...view, name: item.name, appshot: true, text: item.appshotText };
  }

  /** Stage a file the user picked or dropped. Throws a Turkish message. */
  async stagePath(p) {
    if (typeof p !== "string" || !p || p.length > 4096 || p.includes("\u0000") || !path.isAbsolute(p)) throw new Error(MSG.badPath);
    let st;
    try {
      st = await fs.promises.stat(p); // follows a link: what counts is what would be uploaded
    } catch {
      throw new Error(MSG.badPath);
    }
    if (!st.isFile()) throw new Error(MSG.notFile);
    if (st.size <= 0) throw new Error(MSG.empty);
    if (st.size > MAX_UPLOAD) throw new Error(MSG.tooBig(st.size));
    try {
      await fs.promises.access(p, fs.constants.R_OK);
    } catch {
      throw new Error(MSG.badPath);
    }
    const name = safeName(path.basename(p));
    const sniffed = sniffImage(await head(p));
    return this._add({ name, size: st.size, kind: kindOf(name, st.size, sniffed), risky: isRisky(name), mime: sniffed, path: p });
  }

  /**
   * Stage pasted or dropped bytes without a path ({bytes, name?, type?}): any file, like a chat app's paste.
   * An image is recognised by its bytes, never by the page's claim; its name is generated unless the page gave
   * a real one (a screenshot arrives as "image.png"). Anything else keeps the page's name and type hint
   * (display only) or gets a generated name.
   */
  async stageData(input) {
    const raw = input && input.bytes;
    const buf = Buffer.isBuffer(raw) ? raw : raw instanceof Uint8Array ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : raw instanceof ArrayBuffer ? Buffer.from(raw) : null;
    if (!buf) throw new Error(MSG.pasteType);
    if (!buf.length) throw new Error(MSG.empty);
    if (buf.length > MAX_PASTE) throw new Error(MSG.pasteBig(buf.length));
    const hint = typeof input.type === "string" && /^[a-z0-9][a-z0-9.+-]{0,60}\/[a-z0-9][a-z0-9.+-]{0,100}$/i.test(input.type) ? input.type.toLowerCase() : "";
    const given = typeof input.name === "string" && input.name.trim() && !/^image\.\w{1,5}$/i.test(input.name.trim()) ? media.safeName(input.name) : "";
    const sniffed = sniffImage(buf);
    const mime = sniffed || hint || "application/octet-stream";
    let first = given && (!sniffed || path.extname(given)) ? given : pasteName(mime);
    if (!path.extname(first)) first += extFor(mime) || ".bin";
    const taken = new Set([...this.items.values()].map((x) => x.name));
    let name = first;
    const ext = path.extname(first);
    for (let i = 2; taken.has(name); i++) name = `${first.slice(0, first.length - ext.length)}-${i}${ext}`; // two pastes in one second
    return this._add({ name, size: buf.length, kind: kindOf(name, buf.length, sniffed), risky: isRisky(name), mime, buffer: Buffer.from(buf) });
  }

  /**
   * The staged items as direct-Hermes files ({files: [{filename, content_base64}], names}), checked against
   * the per-file and per-message caps before anything is read. Path-backed items are read here, in main.
   * Throws a readable message naming the file.
   */
  async hermesFiles(tokens) {
    const L = media.HERMES_ATTACH;
    if (!Array.isArray(tokens) || !tokens.length) throw new Error(MSG.gone);
    if (tokens.length > L.files) throw new Error(i18nText("attach.hermesTooMany", { n: L.files }));
    const items = [...new Set(tokens)].map((t) => this.get(t));
    let total = 0;
    for (const it of items) {
      if (it.size > L.file) throw new Error(i18nText("attach.hermesFileTooBig", { name: it.name, n: mb(L.file) }));
      total += it.size;
    }
    if (total > L.total) throw new Error(i18nText("attach.hermesTotalTooBig", { n: mb(L.total) }));
    const files = [];
    for (const it of items) {
      let buf = it.buffer;
      if (!buf) {
        try {
          buf = await fs.promises.readFile(it.path);
        } catch {
          throw new Error(`${it.name}: ${MSG.badPath}`);
        }
      }
      if (!buf.length) throw new Error(`${it.name}: ${MSG.empty}`);
      if (buf.length > L.file) throw new Error(i18nText("attach.hermesFileTooBig", { name: it.name, n: mb(L.file) })); // grew since it was staged
      files.push({ filename: it.name, content_base64: buf.toString("base64") });
    }
    return { items, files };
  }

  get(token) {
    const it = typeof token === "string" ? this.items.get(token) : null;
    if (!it) throw new Error(MSG.gone);
    return it;
  }

  discard(token) {
    if (typeof token !== "string" || !this.items.has(token)) return false;
    this.draftItems.delete(token);
    this.items.delete(token);
    this._writeDrafts();
    return true;
  }

  clear() {
    this.draftItems.clear();
    this.items.clear();
    this._writeDrafts();
  }
}

/** A caption as Telegram will take it: trimmed, at most 1024 characters. Throws a Turkish message. */
function checkCaption(text) {
  if (text === undefined || text === null) return "";
  if (typeof text !== "string") throw new Error(i18nText("U0016"));
  const t = text.trim();
  if (t.length > MAX_CAPTION) throw new Error(i18nText("U0017", { length: t.length, MAX_CAPTION: MAX_CAPTION }));
  return t;
}

/** Turkish text for an upload failure (teleproto / Telegram error names). */
function uploadError(err) {
  const m = String((err && (err.errorMessage || err.message)) || err || "");
  if (/USER_CANCELED|CANCELED|ABORT/i.test(m)) return i18nText("U0018");
  if (/CHAT_SEND_(MEDIA|PHOTOS|DOCS|VIDEOS|AUDIOS|PLAIN)_FORBIDDEN|CHAT_WRITE_FORBIDDEN|USER_IS_BLOCKED|YOU_BLOCKED_USER/.test(m)) return i18nText("U0019");
  if (/TOPIC_CLOSED/.test(m)) return i18nText("U0020");
  if (/TOPIC_DELETED/.test(m)) return i18nText("U0021");
  if (/MEDIA_CAPTION_TOO_LONG/.test(m)) return i18nText("U0022");
  if (/FILE_PARTS_INVALID|FILE_PART_\w*TOO_BIG|FILE_TOO_BIG|FILE_PART_SIZE/.test(m)) return i18nText("U0023");
  if (/PHOTO_\w*(INVALID|TOO_BIG)|IMAGE_PROCESS_FAILED|PHOTO_EXT_INVALID/.test(m)) return i18nText("U0024");
  if (/FILE_PART_\d+_MISSING|FILE_PART_INVALID|FILE_ID_INVALID|MD5_CHECKSUM_INVALID/.test(m)) return i18nText("U0025");
  if (/ENOENT|EACCES|EPERM|EBUSY/.test(m)) return i18nText("U0026");
  const flood = /FLOOD_WAIT_(\d+)|wait of (\d+) seconds/i.exec(m);
  if (flood) return i18nText("A0019", { v: flood[1] || flood[2] });
  if (/SLOWMODE_WAIT_(\d+)/.test(m)) return i18nText("U0027", { v: /SLOWMODE_WAIT_(\d+)/.exec(m)[1] });
  if (/TIMEOUT|ETIMEDOUT|Not connected|disconnected/i.test(m)) return i18nText("U0028");
  return i18nText("U0029", { v: m.slice(0, 140) || i18nText("A0020") });
}

/**
 * Progress reporting for one upload: calls emit(fraction) at most every `everyMs` (and always at 0
 * and 1), and carries teleproto's cancel flag. teleproto checks `isCanceled` after each part.
 */
function progressTracker(emit, { everyMs = 200, now = () => Date.now() } = {}) {
  let last = -Infinity;
  const cb = (p) => {
    const f = Math.max(0, Math.min(1, Number(p) || 0));
    const t = now();
    if (f === 0 || f >= 1 || t - last >= everyMs) {
      last = t;
      emit(f);
    }
  };
  cb.isCanceled = false;
  return cb;
}

module.exports = { AttachStore, checkCaption, uploadError, progressTracker, kindOf, pasteName, MAX_UPLOAD, MAX_PHOTO, MAX_PASTE, MAX_STAGED, MAX_CAPTION, MSG };
