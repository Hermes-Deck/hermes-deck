"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
// Direct connection to a Hermes Agent runtime (the "bridge"), ported from Hermes Desk's transport
// (src-tauri/src/hermes.rs + connection.rs). One child process (ssh.exe, wsl.exe or a local python)
// runs the host's installed `stream.py --follow` and speaks newline-delimited JSON-RPC 2.0 on stdio:
//   host -> app: compatible snapshots, native events, server requests (approvals, questions),
//                and replies to our requests;
//   app -> host: our requests.
// Mutations are never replayed: a request whose connection drops fails, and the caller has to
// refresh native state before retrying, because the host may already have executed it.
// No Electron imports here, so the tests can drive this module with plain Node.
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const os = require("os");
const path = require("path");
const { HERMES_ATTACH, sniffImage } = require("./media");

const SCHEMA = "hermes-deck.v1";

const FRAME_LIMIT = 2 * 1024 * 1024; // one inbound line (Desk FRAME_LIMIT)
const PARAMS_LIMIT = 60000; // request params, JSON bytes (stream.py drops lines over 65,536 chars)
// deck.attach_submit: the one request that may be big (files as base64). The host plugin (observer.py ATTACH_*,
// stream.py ATTACH_LINE_MAX) accepts a line of this size for that method only.
const ATTACH_METHOD = "deck.attach_submit";
const ATTACH_PARAMS_LIMIT = Math.ceil((HERMES_ATTACH.total * 4) / 3) + 256 * 1024;
// deck.transcribe: one dictation clip as base64 (the Deck records at most 120 s of Opus, well under 1 MB; the host
// accepts up to 25 MB, observer.py TRANSCRIBE_*). The other bounded-large method besides deck.attach_submit.
const TRANSCRIBE_METHOD = "deck.transcribe";
const FILE_METHOD = "deck.file_read";
// deck.attach_staged: large attachments. The file bytes went to the relay's disk spool over HTTP (relay /uploads); this
// small request only names their 48-hex ids and the plugin on the same host moves the files into the session
// (observer.py attach_staged). Its reply can wait for a cross-filesystem copy of up to 4 GB: TIMING.staged.
const STAGED_METHOD = "deck.attach_staged";
// deck.file_grant: large downloads. Exactly deck.file_read's authorization on the host (observer.py
// FileReader.authorize); instead of bytes it answers {id, name, size, mtime} and writes a short-lived ticket into the
// relay's spool, and the file then streams over HTTP from the relay on that host (relay GET /downloads/<id>).
const GRANT_METHOD = "deck.file_grant";
const DOWNLOAD_ID_RE = /^[a-f0-9]{48}$/;
const DOWNLOAD_BYTES_MAX = Number.MAX_SAFE_INTEGER;
const UPLOAD_ID_RE = /^[a-f0-9]{48}$/;
const UPLOAD_HOST_RE = /^[a-f0-9]{16}$/;
const TRANSCRIBE_AUDIO_MAX = 25 * 1024 * 1024;
const TRANSCRIBE_PARAMS_LIMIT = Math.ceil((TRANSCRIBE_AUDIO_MAX * 4) / 3) + 64 * 1024;
const FILE_CHUNK_MAX = 1024 * 1024; // deck.file_read: one chunk (observer.py FILE_CHUNK_MAX)
const FILE_SIZE_MAX = 200 * 1024 * 1024;
const MAX_PENDING = 64;
// Session browser: rows per deck.session_index page (the host's maximum), pages and profiles one refresh reads, and how
// long a merged list is reused (a refresh is a read of every profile's state.db, so it only runs while the browser is open).
const INDEX_PAGE = 100;
const INDEX_PAGES = 10; // 1000 rows per profile; a page read is ~10 ms on a 500 MB store
const INDEX_PROFILES = 12;
const INDEX_TTL = 30000;
const MAX_WRITE_BUFFER = 1024 * 1024; // bytes waiting for the pipe; beyond this new requests are refused
const MAX_TEXT = 32000; // native steer/redirect limit in the host plugin
const MAX_OPEN_REQUESTS = 32;
const LIVE_ACTIVITY_MAX = 256; // sessions whose latest plan / tool calls this connection keeps

/** Desk's deadlines; tests shorten them. */
const TIMING = {
  request: 15000, // per request; the error says it may have completed
  attach: 180000, // a request carrying files: tens of MB through the pipe (ssh), then the host stages them
  // staged files (deck.attach_staged): the plugin renames each file into the session (instant on one filesystem) or, across
  // filesystems, copies up to 4 GB at ~20+ MB/s; the plugin's own deadline (stream.py DEADLINES) is the same 300 s
  staged: 300000,
  transcribe: 120000, // dictation: a clip through the pipe, then Hermes' STT (local Whisper may load its model first)
  write: 3000, // a stalled pipe tears the connection down
  attachWrite: 120000, // the same, while such a request is being written
  handshake: 15000, // first snapshot after spawn
  heartbeat: 16000, // snapshots arrive at least every 5 s while healthy
  kill: 2000, // bound for reaping our own child
  backoffMin: 1000,
  backoffMax: 30000,
  keepalive: 60000, // re-list sessions: keeps stream.py's gateway socket (events, approvals) open
};

// Only what Hermes Deck uses. Desk also allows session.create/close, subagent.* and approval.respond.
// Botlar (renderer/bots.js) adds the Hermes Desktop roster reads profiles.list / profiles.get_asset and one
// write, session.title, which may only ever set the title "Bot Chat" (checkRequest). The host plugin must
// allow all three (hermes-plugin/hermes-deck/observer.py DECK_METHODS); older hosts answer -32601 and the
// Deck falls back to a roster built from the snapshot (no metadata, generated avatars).
// deck.transcribe (dictation: one audio clip in, text out; nothing is stored or sent anywhere but Hermes' own STT)
// and deck.file_read (one chunk of a file the agent offered in a session) change nothing on the host: reads.
// deck.file_grant runs the same check as deck.file_read and only writes a short-lived download ticket into the Deck's
// own spool (never Hermes data): a read as well.
// The session browser (renderer/sessions-browser.js) adds one read, deck.session_index (a page of a profile's stored
// sessions, which session.list cannot page or date), and four narrow writes: deck.session_update (rename / pin one stored
// row; session.title needs a live runtime), session.archive and session.branch_stored ("Continue here").
// deck.version ({version, protocol}) is answered by stream.py itself (plugin 0.3.6+); older hosts answer -32601.
// The work pane (Lane C of the Blend redesign) adds three reads: subagent.list (a live session's children, completed by
// the plugin with model, effort, state, elapsed, tokens, cost and their recent tool calls), subagent.tail (one child's
// live transcript tail) and deck.plan (a stored session's latest plan, rebuilt read-only from state.db by the plugin);
// and two click-driven writes on one child: subagent.steer and subagent.interrupt. Hermes checks that the child belongs
// to the session this connection addresses; the plugin checks the shapes again (observer.py subagent_params_ok).
const READS = ["deck.drafts_list", "deck.draft_get", "deck.version", "session.list", "deck.session_index", "session.messages", "session.usage", "model.options", "profiles.list", "profiles.get_asset", "deck.transcribe", "deck.file_read", "deck.file_grant", "subagent.list", "subagent.tail", "deck.plan", "commands.catalog"];
// commands.catalog (Hermes' own slash-command palette: registry, quick commands, plugin commands, skills) feeds the
// composer's "/" suggestions; the Deck asks it for one profile only, never with a session (no resume as a side effect).
// deck.reasoning_view ("Show thinking") flips the in-memory show_reasoning flag of one runtime session this Deck created
// or resumed (the plugin checks the session's transport is its own socket); it writes no file and no other session.
const MUTATIONS = ["deck.draft_edit", "deck.draft_sender", "deck.draft_prepare", "deck.draft_commit", "session.create", "session.resume", "deck.takeover", "prompt.submit", "deck.attach_submit", "deck.attach_staged", "native.steer", "native.redirect", "native.interrupt", "session.interrupt", "config.set", "request.answer", "session.title", "session.delete", "session.close", "deck.session_update", "session.archive", "session.branch_stored", "deck.reasoning_view", "subagent.steer", "subagent.interrupt"];
const METHODS = new Set([...READS, ...MUTATIONS]);
// Hermes Desktop's canonical per-bot chat: its identity is this exact title in the profile's state.db
// (desktop plugin hermes-bots/canonical-chat.ts), never a stored id pointer.
const BOT_CHAT_TITLE = "Bot Chat";
// An avatar travels as a data: URL inside one reply line; frames over 2 MiB tear the connection down, so the
// host plugin refuses bigger avatar replies and the Deck refuses anything over this many characters.
const AVATAR_LIMIT = 1500000;
// Files (any type) and window captures travel in the one bounded host method deck.attach_submit (validAttach).
// The protocol still has no upload call of its own: no other allowlisted method carries bytes.
const ATTACHMENTS = false;
const MODES = ["off", "ssh", "wsl", "local"];
const STATES = new Set(["idle", "thinking", "working", "searching", "finished", "error", "question", "approval", "ratelimit"]);
const APPROVAL_CHOICES = ["once", "session", "always", "deny"];

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CONN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SID_RE = /^[\x21-\x7e]{1,512}$/; // printable ASCII, no spaces
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,199}$/;
// provider slugs: built-in ("openai-codex") and user-defined ("custom:<name>", hermes_cli.providers.custom_provider_slug);
// never whitespace, so a slug cannot add a flag to the "<model> --provider <slug> --session" value
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// reasoning levels Hermes accepts for one session (hermes_constants.parse_reasoning_effort); the display words
// (show/hide/full/clamp) are refused: Hermes writes those to config.yaml for every surface
const REASONING_EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

const MSG = {
  get offline() { return i18nText("U0030"); },
  get timeout() { return i18nText("U0031"); },
  get lost() { return i18nText("U0032"); },
  get closed() { return i18nText("U0033"); },
  get queueFull() { return i18nText("U0034"); },
  get changed() { return i18nText("U0035"); },
  get notOpen() { return i18nText("U0036"); },
};

// ---------------------------------------------------------------- validation

function validName(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max && NAME_RE.test(value);
}

/** An ssh config alias or user@host. Ports and options belong in the ssh config. */
function validTarget(value) {
  if (typeof value !== "string" || !value) return false;
  const parts = value.split("@");
  return parts.length <= 2 && parts.every((p) => validName(p, 255));
}

/** An absolute POSIX path or a ~/ path; Python may also be a bare command name (python3). */
function validPath(value, executable) {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  return value.startsWith("/") || value.startsWith("~/") || (!!executable && validName(value, 255));
}

/** Returns a Turkish error message, or null when the configuration can be used. */
function configError(cfg, platform = process.platform) {
  const c = cfg || {};
  if (!MODES.includes(c.mode)) return i18nText("U0037");
  if (c.target && !validTarget(c.target)) {
    return i18nText("U0038");
  }
  if (c.distribution && !validName(c.distribution, 128)) return i18nText("U0039");
  if (c.python && !validPath(c.python, true)) return i18nText("U0040");
  if (c.stream && !validPath(c.stream, false)) return i18nText("U0041");
  if (c.mode === "off") return null;
  if (c.mode === "ssh" && !c.target) return i18nText("U0042");
  if (c.mode === "local" && platform === "win32") {
    return i18nText("U0043");
  }
  if (c.mode === "wsl" && platform !== "win32") return i18nText("U0044");
  if (!c.python) return i18nText("A0024");
  if (!c.stream) return i18nText("A0025");
  return null;
}

/** Trim and validate a renderer- or file-supplied bridge config. Throws a Turkish message. */
function normalizeConfig(input, platform = process.platform) {
  const src = input && typeof input === "object" ? input : {};
  const s = (v) => (typeof v === "string" ? v.trim() : "");
  const cfg = { mode: s(src.mode) || "off", target: s(src.target), python: s(src.python), stream: s(src.stream), distribution: s(src.distribution) };
  const err = configError(cfg, platform);
  if (err) throw new Error(err);
  return cfg;
}

// ---------------------------------------------------------------- launch command

// POSIX shells receive quoted literals; only our explicit ~/ prefix expands (connection.rs:54-62).
const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
const shellPath = (value) => (value.startsWith("~/") ? `"$HOME"/${shellQuote(value.slice(2))}` : shellQuote(value));

/** `exec <python> <args...>`, with the argument at pathIndex expanded like the python path. */
function remoteCommand(python, args, pathIndex) {
  let out = `exec ${shellPath(python)}`;
  args.forEach((arg, i) => {
    out += ` ${i === pathIndex ? shellPath(arg) : shellQuote(arg)}`;
  });
  return out;
}

/** The process to spawn for a valid config (connection.rs:95-147). */
function launchSpec(cfg, { platform = process.platform, systemRoot = process.env.SystemRoot || "C:\\Windows", home = os.homedir() } = {}) {
  const err = configError(cfg, platform);
  if (err) throw new Error(err);
  if (cfg.mode === "off") throw new Error(i18nText("U0045"));
  if (cfg.mode === "local") {
    // Local mode only exists on POSIX desktops, so the paths are POSIX paths.
    const expand = (v) => (v.startsWith("~/") ? path.posix.join(home, v.slice(2)) : v);
    return { file: expand(cfg.python), args: ["-I", expand(cfg.stream), "--follow"] };
  }
  const remote = remoteCommand(cfg.python, ["-I", cfg.stream, "--follow"], 1);
  if (cfg.mode === "wsl") {
    const dist = cfg.distribution ? ["--distribution", cfg.distribution] : [];
    return { file: path.win32.join(systemRoot, "System32", "wsl.exe"), args: [...dist, "--exec", "/bin/sh", "-c", remote] };
  }
  const file = platform === "win32" ? path.win32.join(systemRoot, "System32", "OpenSSH", "ssh.exe") : "/usr/bin/ssh";
  const args = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2", "--", cfg.target, remote];
  return { file, args };
}

// ---------------------------------------------------------------- request shapes

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** session.messages is the read-only history projection; anything else could resume or search (hermes.rs:29-39). */
function validHistoryRead(params) {
  const keys = ["session_id", "profile", "limit", "offset", "order", "inline_images"];
  if (!isPlainObject(params) || !Object.keys(params).every((k) => keys.includes(k))) return false;
  const sid = params.session_id;
  if (typeof sid !== "string" || !sid.trim() || sid.length > 512) return false;
  if ("profile" in params) {
    const p = params.profile;
    if (typeof p !== "string" || !p.trim() || p.length > 64 || /[/\\]/.test(p) || p === "." || p === "..") return false;
  }
  if ("limit" in params && !(Number.isInteger(params.limit) && params.limit >= 1 && params.limit <= 100)) return false;
  if ("offset" in params && !(Number.isInteger(params.offset) && params.offset >= 0)) return false;
  if ("order" in params && params.order !== "latest") return false;
  if ("inline_images" in params && params.inline_images !== false) return false;
  return true;
}

/** config.set may only switch this session's model: never another key, never --global. */
function validModelSet(params) {
  if (!isPlainObject(params) || params.key !== "model") return false;
  if (typeof params.session_id !== "string" || !params.session_id) return false;
  if (typeof params.value !== "string" || !params.value.trim()) return false;
  const tokens = params.value.trim().split(/\s+/);
  return tokens.includes("--session") && !tokens.includes("--global") && !tokens.includes("-g");
}

/**
 * config.set may also set this session's reasoning level: exactly {session_id, key: "reasoning", value: <level>}.
 * No `scope` (scope=global writes config.yaml) and no display word (those write config.yaml too).
 */
function validReasoningSet(params) {
  if (!isPlainObject(params) || params.key !== "reasoning") return false;
  const keys = Object.keys(params);
  if (keys.length !== 3 || !["session_id", "key", "value"].every((k) => keys.includes(k))) return false;
  return typeof params.session_id === "string" && SID_RE.test(params.session_id) && REASONING_EFFORTS.includes(params.value);
}

const onlyKeys = (params, keys) => Object.keys(params).every((k) => keys.includes(k));
const validProfileParam = (p) => typeof p === "string" && PROFILE_RE.test(p);

/** session.list: the recent list, or Hermes Desktop's exact-title lookup of one profile's hidden Bot Chat. */
function validSessionList(params) {
  if (!onlyKeys(params, ["limit", "profile", "title", "include_hidden"])) return false;
  if ("limit" in params && !(Number.isInteger(params.limit) && params.limit >= 1 && params.limit <= 200)) return false;
  if ("profile" in params && !validProfileParam(params.profile)) return false;
  if ("title" in params && params.title !== BOT_CHAT_TITLE) return false;
  // hidden sessions are only ever asked for by that lookup
  if ("include_hidden" in params && !(params.include_hidden === true && params.title === BOT_CHAT_TITLE)) return false;
  return true;
}

/** session.create: an empty session ("+ New session"), or a hidden "Bot Chat" that follows the profile's config. */
function validCreate(params) {
  if (!onlyKeys(params, ["idempotency_key", "profile", "title", "hidden", "follow_profile_config"])) return false;
  if ("idempotency_key" in params && !(typeof params.idempotency_key === "string" && /^[A-Za-z0-9-]{8,128}$/.test(params.idempotency_key))) return false;
  if ("profile" in params && !validProfileParam(params.profile)) return false;
  if ("title" in params && params.title !== BOT_CHAT_TITLE) return false;
  if ("hidden" in params && !(params.hidden === true && params.title === BOT_CHAT_TITLE)) return false;
  if ("follow_profile_config" in params && params.follow_profile_config !== true) return false;
  return true;
}

/** session.title may only name a session "Bot Chat" (persisting a just-created canonical chat). */
function validBotTitle(params) {
  return onlyKeys(params, ["session_id", "title"]) && typeof params.session_id === "string" && SID_RE.test(params.session_id) && params.title === BOT_CHAT_TITLE;
}

/** session.delete: one stored session (its DB key), optionally in a named profile; nothing else. */
function validSessionDelete(params) {
  return onlyKeys(params, ["session_id", "profile"]) && typeof params.session_id === "string" && SID_RE.test(params.session_id) && (!("profile" in params) || validProfileParam(params.profile));
}

/** session.close: release one runtime session this Deck resumed (so an idle one can then be deleted). */
const validSessionClose = (params) => onlyKeys(params, ["session_id"]) && typeof params.session_id === "string" && SID_RE.test(params.session_id);

const TITLE_MAX = 100; // Hermes' SessionDB.MAX_TITLE_LENGTH
const TITLE_BAD_RE = /[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/;
/** A title as Hermes stores it (whitespace collapsed), or null: empty, too long, control characters, or the reserved Bot Chat. */
function cleanTitle(v) {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t && t.length <= TITLE_MAX && !TITLE_BAD_RE.test(t) && t !== BOT_CHAT_TITLE ? t : null;
}

/** deck.session_index: one page of a profile's stored sessions (archived or not); no other filter. */
function validSessionIndex(params) {
  if (!onlyKeys(params, ["profile", "archived", "limit", "offset"])) return false;
  if ("profile" in params && !validProfileParam(params.profile)) return false;
  if ("archived" in params && params.archived !== "exclude" && params.archived !== "only") return false;
  if ("limit" in params && !(Number.isInteger(params.limit) && params.limit >= 1 && params.limit <= 100)) return false;
  return !("offset" in params) || (Number.isInteger(params.offset) && params.offset >= 0 && params.offset <= 100000);
}

/** deck.session_update: rename and/or pin one stored session. */
function validSessionUpdate(params) {
  if (!onlyKeys(params, ["session_id", "profile", "title", "pinned"])) return false;
  if (typeof params.session_id !== "string" || !SID_RE.test(params.session_id)) return false;
  if ("profile" in params && !validProfileParam(params.profile)) return false;
  if (!("title" in params) && !("pinned" in params)) return false;
  if ("title" in params && cleanTitle(params.title) === null) return false;
  return !("pinned" in params) || typeof params.pinned === "boolean";
}

/** session.archive: one stored session and a real boolean. */
function validSessionArchive(params) {
  return onlyKeys(params, ["session_id", "archived", "profile"]) && typeof params.session_id === "string" && SID_RE.test(params.session_id) &&
    typeof params.archived === "boolean" && (!("profile" in params) || validProfileParam(params.profile));
}

/** session.branch_stored ("Continue here"): a copy of one stored session; nothing else may be set. */
function validSessionBranch(params) {
  if (!onlyKeys(params, ["parent_session_id", "profile", "idempotency_key"])) return false;
  if (typeof params.parent_session_id !== "string" || !SID_RE.test(params.parent_session_id)) return false;
  if ("profile" in params && !validProfileParam(params.profile)) return false;
  return !("idempotency_key" in params) || (typeof params.idempotency_key === "string" && /^[A-Za-z0-9-]{8,128}$/.test(params.idempotency_key));
}

/** deck.reasoning_view: one runtime session id and a real boolean, nothing else. */
const validReasoningView = (params) => onlyKeys(params, ["session_id", "show"]) && Object.keys(params).length === 2 &&
  typeof params.session_id === "string" && SID_RE.test(params.session_id) && typeof params.show === "boolean";

/** profiles.get_asset: a profile's avatar, nothing else. */
function validAssetRead(params) {
  return onlyKeys(params, ["name", "asset"]) && validProfileParam(params.name) && params.asset === "avatar";
}

/** deck.attach_submit: {session_id, text, files: [{filename, content_base64}]}; the host checks again. */
function validAttach(p) {
  if (!onlyKeys(p, ["session_id", "text", "files"]) || typeof p.session_id !== "string" || !SID_RE.test(p.session_id)) return false;
  if (typeof p.text !== "string" || p.text.length > MAX_TEXT) return false; // may be empty: a message of files only
  if (!Array.isArray(p.files) || !p.files.length || p.files.length > HERMES_ATTACH.files) return false;
  let total = 0;
  for (const f of p.files) {
    if (!isPlainObject(f) || !onlyKeys(f, ["filename", "content_base64"])) return false;
    if (typeof f.filename !== "string" || !/^[^/\\\x00-\x1f]{1,160}$/.test(f.filename) || !f.filename.replace(/^[. ]+|[. ]+$/g, "")) return false;
    const b = f.content_base64;
    if (typeof b !== "string" || !b.length || b.length % 4 || b.length > Math.ceil((HERMES_ATTACH.file * 4) / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b)) return false;
    const bytes = Math.floor((b.length * 3) / 4) - (b.endsWith("==") ? 2 : b.endsWith("=") ? 1 : 0);
    if (bytes > HERMES_ATTACH.file) return false; // the decoded size, not just the base64 length
    total += bytes;
    if (total > HERMES_ATTACH.total) return false;
  }
  return true;
}

/**
 * deck.attach_staged: {session_id, text, files: [{upload, filename}]}. `upload` is a relay spool id (48 hex), never a
 * path; the plugin opens only <its spool>/<id>.bin and checks owner, type and size again (observer.py attach_staged).
 */
function validStaged(p) {
  if (!onlyKeys(p, ["session_id", "text", "files"]) || Object.keys(p).length !== 3 || typeof p.session_id !== "string" || !SID_RE.test(p.session_id)) return false;
  if (typeof p.text !== "string" || p.text.length > MAX_TEXT) return false; // may be empty: a message of files only
  if (!Array.isArray(p.files) || !p.files.length || p.files.length > HERMES_ATTACH.files) return false;
  const seen = new Set();
  for (const f of p.files) {
    if (!isPlainObject(f) || !onlyKeys(f, ["upload", "filename"]) || Object.keys(f).length !== 2) return false;
    if (typeof f.upload !== "string" || !UPLOAD_ID_RE.test(f.upload) || seen.has(f.upload)) return false;
    seen.add(f.upload);
    if (typeof f.filename !== "string" || !/^[^/\\\x00-\x1f]{1,160}$/.test(f.filename) || !f.filename.replace(/^[. ]+|[. ]+$/g, "")) return false;
  }
  return true;
}

const LANGUAGE_RE = /^[a-z]{2,3}$/; // optional dictation language hint (ISO 639-1/2); absent means the host auto-detects
const AUDIO_MIME_RE = /^(audio|video)\/[A-Za-z0-9.+-]{1,40}(;[ -~]{0,80})?$/;

/** deck.transcribe: {audio_base64, mime}; the host decides the format from the bytes and checks again. */
function validTranscribe(p) {
  if (!onlyKeys(p, ["audio_base64", "mime", "language"]) || typeof p.mime !== "string" || !AUDIO_MIME_RE.test(p.mime)) return false;
  if ("language" in p && (typeof p.language !== "string" || !LANGUAGE_RE.test(p.language))) return false;
  const b = p.audio_base64;
  if (typeof b !== "string" || !b.length || b.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b)) return false;
  const bytes = Math.floor((b.length * 3) / 4) - (b.endsWith("==") ? 2 : b.endsWith("=") ? 1 : 0);
  return bytes > 0 && bytes <= TRANSCRIBE_AUDIO_MAX;
}

/** deck.file_read: one chunk of a file the agent offered (the host re-checks that it did, and refuses secrets). */
function validFileRead(p) {
  if (!onlyKeys(p, ["session_id", "path", "offset", "length", "profile"]) || typeof p.session_id !== "string" || !SID_RE.test(p.session_id)) return false;
  if (typeof p.path !== "string" || p.path.length < 2 || p.path.length > 4095 || p.path[0] !== "/" || /[\u0000-\u001f\u007f]/.test(p.path)) return false;
  if (!Number.isInteger(p.offset) || p.offset < 0 || p.offset > FILE_SIZE_MAX) return false;
  if (!Number.isInteger(p.length) || p.length < 1 || p.length > FILE_CHUNK_MAX) return false;
  return !("profile" in p) || validProfileParam(p.profile);
}

/** deck.file_grant: exactly {session_id, path, profile?}; the host runs deck.file_read's checks again. */
function validFileGrant(p) {
  if (!onlyKeys(p, ["session_id", "path", "profile"]) || typeof p.session_id !== "string" || !SID_RE.test(p.session_id)) return false;
  if (typeof p.path !== "string" || p.path.length < 2 || p.path.length > 4095 || p.path[0] !== "/" || /[\u0000-\u001f\u007f]/.test(p.path)) return false;
  return !("profile" in p) || validProfileParam(p.profile);
}

const SUBAGENT_ID_RE = /^[\x21-\x7e]{1,128}$/; // Hermes' ids look like "sa-0-1a2b3c4d"; never spaces or controls
/**
 * subagent.*: exactly {session_id} (list) or {session_id, subagent_id} (tail, interrupt) or {session_id, subagent_id,
 * text} (steer, 1..MAX_TEXT characters, not blank); `session_id` is the runtime id this connection bound.
 */
function validSubagent(method, p) {
  const keys = method === "subagent.list" ? ["session_id"] : method === "subagent.steer" ? ["session_id", "subagent_id", "text"] : ["session_id", "subagent_id"];
  if (Object.keys(p).length !== keys.length || !onlyKeys(p, keys)) return false;
  if (typeof p.session_id !== "string" || !SID_RE.test(p.session_id)) return false;
  if (method !== "subagent.list" && (typeof p.subagent_id !== "string" || !SUBAGENT_ID_RE.test(p.subagent_id))) return false;
  return method !== "subagent.steer" || (typeof p.text === "string" && !!p.text.trim() && p.text.length <= MAX_TEXT);
}

/** deck.plan: one stored session, optionally in a named profile. */
const validPlanRead = (p) => onlyKeys(p, ["session_id", "profile"]) && typeof p.session_id === "string" && SID_RE.test(p.session_id) &&
  (!("profile" in p) || validProfileParam(p.profile));

function checkRequest(method, params) {
  if (!METHODS.has(method)) throw new Error(i18nText("U0046"));
  if (!isPlainObject(params)) throw new Error(i18nText("U0047"));
  const big = method === ATTACH_METHOD ? ATTACH_PARAMS_LIMIT : method === TRANSCRIBE_METHOD ? TRANSCRIBE_PARAMS_LIMIT : PARAMS_LIMIT;
  if (Buffer.byteLength(JSON.stringify(params)) > big) throw new Error(i18nText(method === ATTACH_METHOD ? "attach.hermesRequestTooLarge" : method === TRANSCRIBE_METHOD ? "voice.tooLarge" : "appshot.requestTooLarge"));
  if (["deck.drafts_list", "deck.draft_get", "deck.draft_edit", "deck.draft_sender", "deck.draft_prepare", "deck.draft_commit"].includes(method) && !require("./mail-drafts").validRequest(method, params)) throw new Error(i18nText("mail.invalid"));
  if (method === ATTACH_METHOD && !validAttach(params)) throw new Error(i18nText("attach.hermesInvalid"));
  if (method === STAGED_METHOD && !validStaged(params)) throw new Error(i18nText("attach.hermesInvalid"));
  if (method === TRANSCRIBE_METHOD && !validTranscribe(params)) throw new Error(i18nText("voice.invalid"));
  if (method === FILE_METHOD && !validFileRead(params)) throw new Error(i18nText("download.invalid"));
  if (method === GRANT_METHOD && !validFileGrant(params)) throw new Error(i18nText("download.invalid"));
  if (method === "session.messages" && !validHistoryRead(params)) throw new Error(i18nText("U0049"));
  if (method === "config.set" && !validModelSet(params) && !validReasoningSet(params)) throw new Error(i18nText("U0050"));
  if (method === "session.list" && !validSessionList(params)) throw new Error(i18nText("U0051"));
  if (method === "session.create" && !validCreate(params)) throw new Error(i18nText("U0052"));
  if (method === "session.title" && !validBotTitle(params)) throw new Error(i18nText("U0053"));
  if (method === "session.delete" && !validSessionDelete(params)) throw new Error(i18nText("session.deleteInvalid"));
  if (method === "session.close" && !validSessionClose(params)) throw new Error(i18nText("session.deleteInvalid"));
  if (method === "deck.session_index" && !validSessionIndex(params)) throw new Error(i18nText("sessions.invalid"));
  if (method === "deck.session_update" && !validSessionUpdate(params)) throw new Error(i18nText("sessions.invalid"));
  if (method === "deck.reasoning_view" && !validReasoningView(params)) throw new Error(i18nText("sessions.invalid"));
  if (method === "session.archive" && !validSessionArchive(params)) throw new Error(i18nText("sessions.invalid"));
  if (method === "session.branch_stored" && !validSessionBranch(params)) throw new Error(i18nText("sessions.invalid"));
  if ((method === "profiles.list" || method === "deck.version") && Object.keys(params).length) throw new Error(i18nText("U0054"));
  if (method === "profiles.get_asset" && !validAssetRead(params)) throw new Error(i18nText("U0055"));
  if (method.startsWith("subagent.") && !validSubagent(method, params)) throw new Error(i18nText("U0047"));
  if (method === "deck.plan" && !validPlanRead(params)) throw new Error(i18nText("U0047"));
  if (method === "commands.catalog" && !validCatalogRead(params)) throw new Error(i18nText("U0047"));
}

/** A reply: string id, no method, exactly one of result / error{message} (hermes.rs:192-204). */
function rpcReply(frame) {
  if (!isPlainObject(frame) || frame.jsonrpc !== "2.0" || "method" in frame || typeof frame.id !== "string") return null;
  const hasResult = Object.prototype.hasOwnProperty.call(frame, "result");
  const hasError = Object.prototype.hasOwnProperty.call(frame, "error");
  if (hasResult && !hasError) return { id: frame.id, result: frame.result };
  if (hasError && !hasResult && isPlainObject(frame.error)) {
    const text = typeof frame.error.message === "string" ? frame.error.message.slice(0, 1024) : i18nText("U0056");
    return { id: frame.id, error: text, ...(Number.isInteger(frame.error.code) ? { rpcCode: frame.error.code } : {}) };
  }
  return null;
}

// Desk requires connection_id "hermes"; the stream.py installed by older bridge builds reports its own
// label (e.g. a host name), so any bounded identifier is accepted.
function isSnapshot(frame) {
  return (
    isPlainObject(frame) &&
    frame.schema === SCHEMA &&
    typeof frame.connection_id === "string" &&
    CONN_ID_RE.test(frame.connection_id) &&
    frame.online === true &&
    Array.isArray(frame.nodes)
  );
}

// ---------------------------------------------------------------- projections (host data -> renderer data)

const str = (v, max = 512) => (typeof v === "string" ? v.replace(CONTROL_RE, " ").slice(0, max) : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const REASONING_RE = /^[a-z][a-z0-9_.-]{0,23}$/;
const keepLines = (v, max) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").slice(0, max) : "");
const sessionKey = (profile, sid) => JSON.stringify([profile, sid]);
const eventIdentity = v => typeof v === "string" && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v) ? v : "";

function normalizeNode(n) {
  if (!isPlainObject(n)) return null;
  const sid = str(n.session_id, 512);
  if (!sid.trim()) return null;
  const turn = typeof n.turn_id === "string" && n.turn_id.length <= 512 ? n.turn_id : "";
  return {
    sid,
    parent: str(n.parent_session_id, 512),
    lineageParent: str(n.lineage_parent_session_id, 512),
    subagentId: str(n.subagent_id, 512),
    role: str(n.role, 32),
    model: str(n.model, 160),
    provider: str(n.provider, 160),
    profile: typeof n.profile_name === "string" && PROFILE_RE.test(n.profile_name) ? n.profile_name : "default",
    source: str(n.source, 48),
    platform: str(n.platform, 32),
    title: str(n.title, 160).trim(),
    name: str(n.name, 120).trim(),
    origin: str(n.origin, 32),
    state: STATES.has(n.state) ? n.state : "idle",
    active: n.active === true,
    turnId: turn,
    controlAvailable: n.control_available === true,
    ownerPid: Number.isSafeInteger(n.owner_pid) && n.owner_pid > 0 ? n.owner_pid : null,
    observation: str(n.observation_source, 48),
    steps: Array.isArray(n.steps) ? n.steps.map((s) => str(s, 96)).filter(Boolean).slice(-20) : [],
    updatedAt: num(n.updated_at),
    terminalAt: num(n.terminal_at),
    ctxUsed: num(n.context_used),
    ctxMax: num(n.context_max),
    ctxPercent: num(n.context_percent),
    ctxEstimated: n.context_estimated === true,
    effort: typeof n.reasoning_effort === "string" && REASONING_RE.test(n.reasoning_effort) ? n.reasoning_effort : "",
    lastPromptTokens: num(n.last_prompt_tokens),
  };
}

function normalizeSnapshot(frame) {
  const seen = new Set();
  const nodes = [];
  for (const raw of frame.nodes.slice(0, 500)) {
    const n = normalizeNode(raw);
    if (!n || seen.has(sessionKey(n.profile, n.sid))) continue;
    seen.add(sessionKey(n.profile, n.sid));
    nodes.push(n);
  }
  const g = isPlainObject(frame.gateway) ? frame.gateway : {};
  return {
    connectionId: frame.connection_id,
    gateway: { running: typeof g.running === "boolean" ? g.running : null, activeAgents: num(g.active_agents) },
    nodes,
  };
}

const THINK_MAX = 20000; // characters of stored reasoning kept per message (the tail)

/**
 * The reasoning Hermes stored with an assistant message, as plain text ("" when none). Same order as Hermes'
 * own display projection (agent/history_commentary.py): display_reasoning (commentary already removed), then
 * reasoning, then reasoning_content. reasoning_details is provider replay data, never shown.
 */
function storedReasoning(m) {
  for (const k of ["display_reasoning", "reasoning", "reasoning_content"]) {
    if (typeof m[k] === "string" && m[k].trim()) {
      const t = m[k].replace(/\r\n?/g, "\n").trim();
      return t.length > THINK_MAX ? t.slice(-THINK_MAX) : t;
    }
  }
  return "";
}

const CALLS_MAX = 24; // tool calls kept per assistant step
const CALL_ARG_MAX = 160; // characters of one call's argument preview
// the argument a reader recognises a call by, in this order; else the first string argument
const CALL_ARG_KEYS = ["command", "cmd", "path", "file_path", "url", "query", "pattern", "goal", "prompt", "name", "code"];
// Tool arguments stay on screen in the transcript: the common secret shapes are masked (the relay's patterns, trimmed)
const CALL_SECRET_RES = [
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
const CALL_LABELLED_RES = [
  /(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
  /(\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi,
];
function redactCallArg(s) {
  let out = s;
  for (const re of CALL_SECRET_RES) out = out.replace(re, "•••");
  for (const re of CALL_LABELLED_RES) out = out.replace(re, "$1•••");
  return out;
}

/** One line a reader recognises a tool call by: its main argument, masked and clipped. */
function callArg(raw) {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { /* not JSON: the text itself is the argument */ }
  }
  let s = "";
  if (isPlainObject(v)) {
    const k = CALL_ARG_KEYS.find((x) => typeof v[x] === "string" && v[x].trim()) || Object.keys(v).find((x) => typeof v[x] === "string" && v[x].trim());
    s = k ? v[k] : Object.keys(v).length ? JSON.stringify(v) : "";
  } else if (typeof v === "string") s = v;
  else if (v != null) s = JSON.stringify(v) || "";
  s = redactCallArg(s.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim());
  return s.length > CALL_ARG_MAX ? `${s.slice(0, CALL_ARG_MAX - 1)}…` : s;
}

/**
 * The tool calls an assistant step made, as [{id, name, arg}]. Calls made through Hermes' bridge tools (tool_call)
 * show the tool they reached, from the labels Hermes stores beside them (tool_call_labels).
 */
function storedCalls(m) {
  if (!Array.isArray(m.tool_calls)) return [];
  const labels = isPlainObject(m.tool_call_labels) ? m.tool_call_labels : {};
  const out = [];
  for (const c of m.tool_calls) {
    if (out.length >= CALLS_MAX) break;
    if (!isPlainObject(c)) continue;
    const fn = isPlainObject(c.function) ? c.function : c;
    const name = str(fn.name, 96).trim();
    if (!name) continue;
    const id = str(c.id, 128);
    const inner = Array.isArray(labels[id]) ? labels[id].filter((l) => isPlainObject(l) && typeof l.name === "string" && l.name.trim()) : [];
    if (inner.length) for (const l of inner.slice(0, CALLS_MAX - out.length)) out.push({ id, name: str(l.name, 96).trim(), arg: callArg(typeof l.preview === "string" ? l.preview : "") });
    else out.push({ id, name, arg: callArg(fn.arguments ?? fn.args) });
  }
  return out;
}

/**
 * Port of Desk's hermesHistoryMessages: visible user/assistant text, plus an assistant's stored reasoning and the
 * tool calls it made (so a step that only thought and called a tool reads as one: Thought, then its calls).
 */
function projectHistory(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages.slice(-200)) {
    if (!isPlainObject(m) || m.display_kind === "hidden" || (m.role !== "user" && m.role !== "assistant")) continue;
    const content = m.display_content ?? m.content;
    let text = "";
    let media = false;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .map((b) => {
          if (typeof b === "string") return b;
          if (b && (!b.type || ["text", "input_text", "output_text"].includes(b.type)) && typeof b.text === "string") return b.text;
          if (b && typeof b.type === "string") media = true;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    text = keepLines(text, 100000);
    if (!text.trim() && media) text = i18nText("A0032");
    const think = m.role === "assistant" ? storedReasoning(m) : "";
    const calls = m.role === "assistant" ? storedCalls(m) : [];
    if (!text.trim() && !think && !calls.length) continue; // a tool-call step shows its Thinking and its calls
    const id = typeof m.id === "string" && m.id ? m.id.slice(0, 128) : Number.isSafeInteger(m.id) ? String(m.id) : null;
    let ts = num(m.timestamp) ?? num(m.created_at) ?? num(m.ts);
    if (ts !== null && ts > 1e12) ts /= 1000; // milliseconds
    const item = { id, role: m.role, text, ts };
    if (think) item.think = think;
    if (calls.length) item.calls = calls;
    out.push(item);
  }
  return out;
}

function projectSessions(result, profile) {
  const rows = isPlainObject(result) && Array.isArray(result.sessions) ? result.sessions : [];
  const out = [];
  const launchProfile = isPlainObject(result) && typeof result.launch_profile === "string" && PROFILE_RE.test(result.launch_profile) ? result.launch_profile : undefined;
  for (const s of rows.slice(0, 200)) {
    if (!isPlainObject(s)) continue;
    const id = str(typeof s.id === "string" ? s.id : s.session_id, 512);
    if (!id.trim()) continue;
    const p = typeof s.profile_name === "string" ? s.profile_name : typeof s.profile === "string" ? s.profile : (profile ?? launchProfile);
    out.push({
      id,
      title: str(s.title || s.name, 160).replace(/\s+/g, " ").trim(),
      source: str(s.source, 48),
      profile: typeof p === "string" && PROFILE_RE.test(p) ? p : "default",
      startedAt: num(s.started_at),
      messageCount: num(s.message_count),
      preview: str(s.preview, 200).replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

/** deck.session_index (or, on an older host, session.list) rows -> the browser's rows. Only ids Hermes returned. */
function projectIndexRows(result, profile) {
  const rows = isPlainObject(result) && Array.isArray(result.sessions) ? result.sessions : [];
  const out = [];
  for (const s of rows.slice(0, 200)) {
    if (!isPlainObject(s)) continue;
    const id = typeof s.id === "string" ? s.id : "";
    if (!SID_RE.test(id)) continue;
    const started = num(s.started_at);
    out.push({
      id,
      profile,
      source: str(s.source, 48).trim().toLowerCase(),
      title: str(s.title, 160).replace(/\s+/g, " ").trim(),
      preview: str(s.preview, 200).replace(/\s+/g, " ").trim(),
      // newest user/assistant message (plugin 2.7.0+); `preview` stays the first message for older hosts
      lastPreview: str(s.last_preview, 200).replace(/\s+/g, " ").trim(),
      lastRole: s.last_role === "user" || s.last_role === "assistant" ? s.last_role : "",
      startedAt: started,
      lastActive: num(s.last_active) || started,
      messages: num(s.message_count),
      archived: s.archived === true,
      pinned: s.pinned === true,
    });
  }
  return out;
}

const MODEL_OPTIONS_MAX = 3000; // every provider's models; the picker filters and caps what it draws

/**
 * model.options -> {current, options}. One option per (provider, model) the session may switch to: signed-in
 * providers only, built-in and user-defined (custom:<name>) alike. `current` also matches a user-defined row by
 * its aliases (Hermes reports "custom:<key>" while a providers: row carries the bare key, inventory._apply_custom_aliases).
 * `reasoning` / `canDisable` come from the row's capabilities (absent: reasoning true, disable unknown).
 */
function projectModelOptions(result) {
  const r = isPlainObject(result) ? result : {};
  const curModel = typeof r.model === "string" ? r.model : "";
  const curProvider = typeof r.provider === "string" ? r.provider : "";
  const options = [];
  for (const p of Array.isArray(r.providers) ? r.providers : []) {
    if (!isPlainObject(p) || p.authenticated === false || typeof p.slug !== "string" || !SLUG_RE.test(p.slug)) continue;
    const unavailable = new Set(Array.isArray(p.unavailable_models) ? p.unavailable_models : []);
    const aliases = Array.isArray(p.aliases) ? p.aliases.filter((a) => typeof a === "string") : [];
    const isCurProvider = !!curProvider && (p.slug === curProvider || aliases.includes(curProvider));
    const caps = isPlainObject(p.capabilities) ? p.capabilities : {};
    const providerName = oneLine(p.name ?? p.slug, 80) || p.slug;
    const seen = new Set();
    for (const id of Array.isArray(p.models) ? p.models : []) {
      if (typeof id !== "string" || !MODEL_ID_RE.test(id) || unavailable.has(id) || seen.has(id)) continue;
      seen.add(id);
      const cap = isPlainObject(caps[id]) ? caps[id] : {};
      options.push({
        id,
        provider: p.slug,
        providerName,
        userDefined: p.is_user_defined === true,
        providerCurrent: isCurProvider || p.is_current === true,
        current: id === curModel && (isCurProvider || (!curProvider && p.is_current === true)),
        reasoning: cap.reasoning !== false,
        canDisable: typeof cap.can_disable_reasoning === "boolean" ? cap.can_disable_reasoning : null,
      });
      if (options.length >= MODEL_OPTIONS_MAX) break;
    }
    if (options.length >= MODEL_OPTIONS_MAX) break;
  }
  return { current: { model: str(curModel, 200), provider: str(curProvider, 128) }, options };
}

// ---------------------------------------------------------------- work pane: plans, tool calls, sub-agents

const PLAN_STATES = new Set(["pending", "active", "done", "cancelled"]);
const PLAN_ITEMS = 64;
const TOOL_ROWS = 20;
const preview = (v, max = 301) => (typeof v === "string" ? keepLines(v, max) : null); // the plugin's 300-char previews (+ "…")

/** A plan (plugin `plan` / deck.plan shape) for the renderer, or null. Text stays text; the renderer adds it as text nodes. */
function projectPlan(p) {
  if (!isPlainObject(p) || (p.source !== "todo" && p.source !== "omh") || !Array.isArray(p.items)) return null;
  const items = [];
  for (const [i, raw] of p.items.slice(0, PLAN_ITEMS).entries()) {
    if (!isPlainObject(raw)) continue;
    const item = {
      id: typeof raw.id === "string" && raw.id ? str(raw.id, 64) : String(i + 1),
      text: oneLine(raw.text, 300),
      state: PLAN_STATES.has(raw.state) ? raw.state : "pending",
      depth: Number.isInteger(raw.depth) ? Math.max(0, Math.min(raw.depth, 3)) : 0,
    };
    const phase = oneLine(raw.phase, 80);
    if (phase) item.phase = phase;
    const blocked = oneLine(raw.blocked, 300);
    if (blocked) item.blocked = blocked;
    items.push(item);
  }
  const out = { source: p.source, rev: num(p.rev) ?? 0, items };
  if (Number.isInteger(p.total) && p.total > items.length) out.total = p.total;
  const ts = num(p.ts);
  if (ts !== null) out.ts = ts;
  return out;
}

/** One tool call (Run tab, sub-agent detail): {call, tool, args, ts, status, ms, err, result}. */
function projectToolCall(t) {
  if (!isPlainObject(t)) return null;
  const tool = str(t.tool, 96);
  if (!tool) return null;
  return {
    call: str(t.call, 128),
    tool,
    args: preview(t.args),
    ts: num(t.ts),
    status: typeof t.status === "string" ? str(t.status, 32) : null,
    ms: num(t.ms),
    err: preview(t.err),
    result: preview(t.result),
  };
}

const projectToolCalls = (list) => (Array.isArray(list) ? list.slice(-4 * TOOL_ROWS).map(projectToolCall).filter(Boolean).slice(-TOOL_ROWS) : []);

const SUB_STATUS = new Set(["queued", "running", "completed", "failed", "error", "timeout", "interrupted"]);
const TOKEN_KEYS = ["input", "output", "cache_read", "cache_write", "reasoning", "api_calls"];

/** One live child from subagent.list / subagent.tail, plugin-completed fields included when the host sent them. */
function projectSubagent(r) {
  if (!isPlainObject(r) || typeof r.subagent_id !== "string" || !/^[\x21-\x7e]{1,128}$/.test(r.subagent_id)) return null;
  const tokens = {};
  if (isPlainObject(r.tokens)) for (const k of TOKEN_KEYS) if (num(r.tokens[k]) !== null) tokens[k] = r.tokens[k];
  return {
    id: r.subagent_id,
    parentId: typeof r.parent_id === "string" ? str(r.parent_id, 128) : null,
    depth: Number.isInteger(r.depth) ? r.depth : null,
    goal: keepLines(r.goal, 4001),
    model: str(r.model, 160),
    provider: str(r.provider, 160),
    effort: typeof r.reasoning_effort === "string" && REASONING_RE.test(r.reasoning_effort) ? r.reasoning_effort : "",
    status: SUB_STATUS.has(r.status) ? r.status : "",
    state: STATES.has(r.state) ? r.state : "",
    startedAt: num(r.started_at),
    elapsedS: num(r.elapsed_s),
    toolCount: num(r.tool_count),
    lastTool: str(r.last_tool, 200),
    acceptingSteer: r.accepting_steer === true,
    childSid: sidOrNull(r.child_session_id),
    tokens: Object.keys(tokens).length ? tokens : null,
    costUsd: num(r.cost_usd),
    costStatus: str(r.cost_status, 32),
    ctxUsed: num(r.context_used),
    ctxMax: num(r.context_max),
    ctxPercent: num(r.context_percent),
    tools: projectToolCalls(r.tools),
  };
}

/** subagent.list -> {subagents, failed}: live children and recently failed async delegations. */
function projectSubagents(result) {
  const r = isPlainObject(result) ? result : {};
  const subagents = (Array.isArray(r.subagents) ? r.subagents.slice(0, 64) : []).map(projectSubagent).filter(Boolean);
  const failed = [];
  for (const d of Array.isArray(r.delegations) ? r.delegations.slice(0, 64) : []) {
    if (!isPlainObject(d)) continue;
    failed.push({ delegationId: str(d.delegation_id, 128), taskIndex: Number.isInteger(d.task_index) ? d.task_index : 0, status: str(d.status, 32),
      goal: keepLines(d.goal, 4001), error: keepLines(d.error, 601), dispatchedAt: num(d.dispatched_at), completedAt: num(d.completed_at) });
  }
  return { subagents, failed };
}

/** subagent.tail -> {id, available, text, truncated, detail}: the child's live transcript tail (redacted by the plugin). */
function projectSubagentTail(result, subagentId) {
  const r = isPlainObject(result) ? result : {};
  const detail = r.available === true ? projectSubagent({ ...r, subagent_id: subagentId }) : null;
  return { id: subagentId, available: r.available === true, text: keepLines(r.text, 16384 + 1), truncated: r.truncated === true, detail };
}

// ---------------------------------------------------------------- bots (Hermes Desktop's Bot Mode roster)

const oneLine = (v, max) => str(v, max * 2).replace(/\s+/g, " ").trim().slice(0, max);
const sidOrNull = (v) => (typeof v === "string" && SID_RE.test(v) ? v : null);
// colours the desktop writes: #rgb..#rrggbbaa, or the hsl()/rgb() of its swatches; nothing else reaches an SVG fill
const COLOR_RE = /^(?:#[0-9a-f]{3,8}|(?:hsl|rgb)a?\(\s*-?[0-9.]+(?:deg)?%?(?:\s*[,/ ]\s*[0-9.]+%?){2,3}\s*\))$/i;
// circle, squircle, ..., sigil-3, blobatar:seed:kind
const SHAPE_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/i;

/** ui_meta['hermes-bots'], reduced to what the roster draws (desktop types.ts BotMeta). */
function projectBotMeta(raw) {
  const m = isPlainObject(raw) ? raw : {};
  const out = {};
  const title = oneLine(m.title, 80);
  if (title) out.title = title;
  const description = oneLine(m.description, 400);
  if (description) out.description = description;
  if (typeof m.shape === "string" && SHAPE_RE.test(m.shape)) out.shape = m.shape;
  if (typeof m.color === "string" && COLOR_RE.test(m.color.trim())) out.color = m.color.trim();
  for (const key of ["custom", "hidden", "pinned"]) if (m[key] === true) out[key] = true;
  if (m.imageKind === "photo" || m.imageKind === "shape") out.imageKind = m.imageKind;
  const created = num(m.created);
  if (created !== null && created > 0) out.created = created;
  return out;
}

/** canonical_session / last_session of a profiles.list row. */
function projectSessionRef(s) {
  if (!isPlainObject(s)) return null;
  const id = sidOrNull(s.id);
  if (!id) return null;
  return {
    id,
    resolvedId: sidOrNull(s.resolved_id) || id,
    title: oneLine(s.title, 160),
    rootTitle: oneLine(s.root_title, 160),
    preview: oneLine(s.preview, 200),
    startedAt: num(s.started_at),
    lastActive: num(s.last_active),
    messageCount: num(s.message_count),
  };
}

/** commands.catalog: one profile's palette, nothing else (no session_id: that would bind a runtime session). */
function validCatalogRead(params) {
  return isPlainObject(params) && Object.keys(params).length === 1 && validProfileParam(params.profile);
}

const CATALOG_KEY_RE = /^\/[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CATALOG_MAX = 800;
/**
 * commands.catalog -> [{command: "/name", description, category}] for the composer's "/" suggestions. Only the
 * categorized registry/quick/plugin entries and the skill pairs; host paths, usage counts and the subcommand table
 * are dropped. Keys must look like slash commands; descriptions are one bounded line.
 */
function projectCommandCatalog(result) {
  const r = isPlainObject(result) ? result : {};
  const out = [];
  const seen = new Set();
  const add = (pair, category) => {
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || !CATALOG_KEY_RE.test(pair[0])) return;
    const key = pair[0];
    if (seen.has(key.toLowerCase()) || out.length >= CATALOG_MAX) return;
    seen.add(key.toLowerCase());
    const desc = typeof pair[1] === "string" ? pair[1].replace(/\s+/g, " ").trim().slice(0, 200) : "";
    out.push({ command: key, description: desc, category: typeof category === "string" ? category.slice(0, 64) : "" });
  };
  for (const c of Array.isArray(r.categories) ? r.categories : []) {
    if (isPlainObject(c) && Array.isArray(c.pairs)) for (const p of c.pairs) add(p, c.name);
  }
  const skills = isPlainObject(r.skills) ? r.skills : {};
  for (const p of Array.isArray(r.pairs) ? r.pairs : []) add(p, Array.isArray(p) && Object.prototype.hasOwnProperty.call(skills, p[0]) ? "Skills" : "");
  return out;
}

/**
 * profiles.list -> the bot roster. Host paths, models, providers, skill counts, roles and worker sessions are
 * dropped here; the renderer sees names, presentation metadata and the two session references.
 */
function projectProfiles(result) {
  const rows = isPlainObject(result) && Array.isArray(result.profiles) ? result.profiles : [];
  const out = [];
  const seen = new Set();
  for (const p of rows.slice(0, 100)) {
    if (!isPlainObject(p) || typeof p.name !== "string" || !PROFILE_RE.test(p.name) || seen.has(p.name)) continue;
    seen.add(p.name);
    const ui = isPlainObject(p.ui_meta) ? p.ui_meta["hermes-bots"] : null;
    out.push({
      name: p.name,
      isDefault: p.is_default === true || p.name === "default",
      displayName: oneLine(p.display_name, 80),
      description: oneLine(p.description, 400),
      meta: projectBotMeta(ui),
      hasAvatar: p.has_avatar === true,
      canonical: projectSessionRef(p.canonical_session),
      last: projectSessionRef(p.last_session),
    });
  }
  return out;
}

/** Width and height from a PNG's IHDR chunk, or null. */
function pngSize(buf) {
  if (!buf || buf.length < 24 || sniffImage(buf) !== "image/png" || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/**
 * profiles.get_asset -> {found, url, mime, raster}. Only PNG/JPEG/WebP data: URLs whose bytes match their
 * type, under AVATAR_LIMIT. `raster`: the 160x160 PNG Hermes Desktop draws from a bot's vector face
 * (avatar-image.ts isBackfilledFacePng), as opposed to a real picture.
 */
function projectAvatar(result) {
  if (!isPlainObject(result) || result.found !== true) return { found: false };
  const data = typeof result.data === "string" ? result.data : "";
  if (data.length > AVATAR_LIMIT) return { found: false, error: "size" };
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!m) return { found: false, error: "format" };
  const head = Buffer.from(m[2].slice(0, 44), "base64");
  if (sniffImage(head) !== m[1]) return { found: false, error: "format" };
  const size = m[1] === "image/png" ? pngSize(head) : null;
  return { found: true, url: data, mime: m[1], raster: !!size && size.w === 160 && size.h === 160 };
}

/** A title-lookup row is the canonical chat when its lineage root (or, without one, itself) is "Bot Chat". */
function isBotChatRow(row) {
  const root = typeof row.root_title === "string" ? row.root_title.trim() : "";
  const title = typeof row.title === "string" ? row.title.trim() : "";
  return root === BOT_CHAT_TITLE || (!root && title === BOT_CHAT_TITLE);
}

function projectBotChat(row, profile) {
  const id = sidOrNull(row.id);
  const resolved = sidOrNull(row.resolved_id) || id;
  return { sid: resolved, id, profile, title: BOT_CHAT_TITLE, preview: oneLine(row.preview, 200), lastActive: num(row.last_active), messageCount: num(row.message_count) };
}

function normalizeServerRequest(frame, refFor) {
  const p = isPlainObject(frame.params) ? frame.params : null;
  if (typeof frame.id !== "string" || !frame.id || frame.id.length > 256 || !p) return null;
  const rpcId = str(p.session_id, 512);
  const ref = refFor(rpcId, p);
  const reported = p.profile_name ?? p.profile ?? p.payload?.profile_name ?? p.payload?.profile;
  if (reported !== undefined && ref.profile === null) return null; // explicit rejected claim must never be re-resolved without its source
  const base = { id: frame.id, rpcId, sid: ref.sid, profile: ref.profile, at: Date.now() };
  if (typeof frame.request_created_at === "number" && Number.isFinite(frame.request_created_at) && frame.request_created_at > 0) base.createdAt = frame.request_created_at;
  if (frame.method === "approval") {
    let choices = Array.isArray(p.choices) ? APPROVAL_CHOICES.filter((c) => p.choices.includes(c)) : ["once", "deny"];
    if (!choices.length) choices = ["once", "deny"];
    const req = { ...base, kind: "approval", command: keepLines(p.command, 4000), description: keepLines(p.description, 2000), choices };
    // Main-process-only evidence. Never infer execution context from a prose description,
    // the Deck's own cwd, or an SSH connection (a tool may target a container/remote host).
    // Non-enumerable: listRequests() spreads requests before sending them to the renderer.
    Object.defineProperty(req, "notification", { value: {
      command: typeof p.command === "string" && p.command.length <= 4000 ? p.command : "",
      cwd: typeof p.cwd === "string" && p.cwd.length <= 1000 ? p.cwd : "",
      target: typeof p.execution_target === "string" && p.execution_target.length <= 200 ? p.execution_target : "",
      complete: p.command_complete === true && p.command_truncated !== true && p.context_complete === true,
    } });
    return req;
  }
  if (frame.method === "clarify") {
    const questions = [];
    for (const q of Array.isArray(p.questions) ? p.questions.slice(0, 10) : []) {
      if (!isPlainObject(q) || typeof q.qid !== "string" || !q.qid || q.qid.length > 128) continue;
      questions.push({
        qid: q.qid,
        question: keepLines(q.question, 2000) || i18nText("U0057"),
        choices: Array.isArray(q.choices) ? q.choices.slice(0, 50).map((c) => str(String(c), 300)).filter(Boolean) : [],
        multi: q.multi_select === true,
      });
    }
    return questions.length ? { ...base, kind: "question", questions } : null;
  }
  return null;
}

// ---------------------------------------------------------------- failure wording

/** Turn ssh / shell / python stderr into a specific, actionable message. */
function classifyFailure(reason, stderr, exit) {
  const e = String(stderr || "");
  const code = exit && typeof exit.code === "number" ? exit.code : null;
  const last = e
    .split(/\r?\n/)
    .map((l) => l.replace(CONTROL_RE, " ").trim())
    .filter(Boolean)
    .pop();
  const tail = last ? ` (${last.slice(0, 200)})` : "";
  if (/Permission denied \(|Too many authentication failures/i.test(e)) {
    return { code: "key", text: i18nText("U0058") };
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(e)) {
    return { code: "hostkey-changed", text: i18nText("U0059") };
  }
  if (/Host key verification failed|host key is known|No .* host key is known/i.test(e)) {
    return { code: "host-unknown", text: i18nText("U0060") };
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(e)) return { code: "dns", text: i18nText("U0061", { tail: tail }) };
  if (/Connection refused/i.test(e)) return { code: "refused", text: i18nText("U0062") };
  if (/timed out|No route to host|Network is unreachable|Connection reset/i.test(e)) return { code: "network", text: i18nText("U0063", { tail: tail }) };
  if (/can't open file|No such file or directory: '.*stream/i.test(e)) return { code: "stream", text: i18nText("U0064") };
  if (/unrecognized arguments/i.test(e)) return { code: "stream-version", text: i18nText("U0065") };
  if (code === 127 || /command not found|exec: .*not found|no such file or directory/i.test(e)) {
    return { code: "python", text: i18nText("U0066") };
  }
  if (code === 126) return { code: "python", text: i18nText("U0067") };
  if (reason && reason.code) return { code: reason.code, text: reason.text + (reason.code === "spawn" ? "" : tail) };
  return { code: "other", text: i18nText("U0068", { tail: tail }) };
}

const failure = (code, text) => ({ code, text });

function launchFailure(err, file) {
  if (err && err.code === "ENOENT") {
    const name = path.basename(String(file || ""));
    if (/ssh/i.test(name)) return failure("spawn", i18nText("U0069"));
    if (/wsl/i.test(name)) return failure("spawn", i18nText("U0070"));
    return failure("spawn", i18nText("U0071", { v: name || i18nText("U0072") }));
  }
  return failure("spawn", i18nText("U0073", { v: String((err && (err.code || err.message)) || err).slice(0, 160) }));
}

// ---------------------------------------------------------------- client

/**
 * One persistent transport to a Hermes host. Events:
 *   "status"   {status: "off"|"setup"|"connecting"|"open"|"offline", error?, code?, retryInMs?}
 *   "snapshot" normalized snapshot ({connectionId, gateway, nodes[]}); only emitted when it changed
 *   "event"    native event {type, rpcId, sid, payload} (sid = stored session id when bound)
 *   "requests" open approvals/questions [{id, kind, sid, rpcId, ...}]
 *   "sessions" recent sessions from the automatic session.list
 */
class BridgeClient extends EventEmitter {
  /**
   * @param {{mode, target, python, stream, distribution}} config
   * @param {{timing?, launch?: {file, args}, spawn?, platform?, keepalive?: boolean}} opts launch/spawn are test hooks
   */
  constructor(config, opts = {}) {
    super();
    const c = config || {};
    this.config = { mode: c.mode, target: c.target || "", python: c.python || "", stream: c.stream || "", distribution: c.distribution || "" };
    this.timing = { ...TIMING, ...(opts.timing || {}) };
    this.launch = opts.launch || null;
    this.spawnImpl = opts.spawn || spawn;
    this.platform = opts.platform || process.platform;
    this.keepaliveOn = opts.keepalive !== false;
    this.showReasoning = opts.showReasoning === true; // "Show thinking": asked for each session this Deck binds
    this.autoList = opts.autoList !== false;
    this.retry = opts.retry !== false; // false: one attempt (connection test)
    this.ns = `deck-${process.pid}-${process.hrtime.bigint().toString(16)}`;
    this.counter = 0;
    this.pending = new Map(); // request id -> {resolve, reject, timer, method}
    this.conn = null;
    this.epoch = 0;
    this.stopped = true;
    this.backoff = this.timing.backoffMin;
    this.retryTimer = null;
    this.status = { status: "off" };
    this.snapshot = null;
    this.snapshotKey = "";
    this.nodes = new Map();
    this.openRequests = new Map();
    this.answering = new Set(); // epoch + request ID: duplicate frames cannot unlock an in-flight answer
    this.bindings = new Map(); // [profile, stored session id] -> {rpcId, epoch}
    this.rpcToStored = new Map(); // runtime id -> {sid, profile}
    // sessions this Deck created that the stream has not reported yet (Hermes stores a new session lazily,
    // on its first turn): [profile, stored id] -> node, shown until a snapshot lists it
    this.created = new Map();
    this.newSessions = new Map(); // only New session clicks; survives the first idle snapshot
    this.recent = [];
    this.deleted = new Set(); // sessions deleted in this run: a lagging snapshot must not list them again
    this.indexCache = new Map(); // "live" | "archived" -> {epoch, at, value}: the session browser's merged list
    this.indexFlight = new Map(); // the same keys -> the Promise being fetched
    this.lastChild = null;
    // Botlar: profiles whose Bot Chat a lookup has confirmed (an empty lookup after that fails closed), the
    // Bot Chats this connection created that Hermes has not stored yet, and creates still in flight
    this.botSeen = new Set();
    this.botPending = new Map(); // profile -> learned canonical {chat, epoch, pending}; pending runtime chats are epoch-local
    this.minting = new Map(); // profile -> Promise
    // work pane: the latest deck.plan / deck.tools per [profile, stored id] on this connection (cleared on reconnect)
    this.livePlans = new Map();
    this.liveTools = new Map();
  }

  /** pid of the current child, if any (diagnostics and tests). */
  get pid() {
    return this.conn && this.conn.child ? this.conn.child.pid : null;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._connect();
  }

  /** Stop for good: fail what is pending (never replayed) and reap only our own child. */
  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const conn = this.conn;
    this.conn = null;
    this._failPending(MSG.closed);
    this._clearSession();
    if (conn) {
      conn.closed = true;
      this._clearTimers(conn);
      this._kill(conn);
    }
    this._setStatus({ status: "off" });
    if (!conn) return Promise.resolve();
    return Promise.race([conn.exited, new Promise((r) => setTimeout(r, this.timing.kill + 500))]);
  }

  // ------------------------------------------------------------ transport

  _setStatus(s) {
    this.status = s;
    this.emit("status", s);
  }

  _connect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.stopped) return;
    let spec;
    try {
      spec = this.launch || launchSpec(this.config, { platform: this.platform });
    } catch (e) {
      // Invalid settings: wait for new ones instead of retrying (Desk's setup_required).
      this._setStatus({ status: "setup", code: "config", error: e.message });
      return;
    }
    const epoch = ++this.epoch;
    this._setStatus({ status: "connecting" });
    let child;
    try {
      child = this.spawnImpl(spec.file, spec.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      this._afterFailure({ ready: false, sawSnapshot: false }, launchFailure(e, spec.file));
      return;
    }
    const conn = {
      child,
      epoch,
      file: spec.file,
      ready: false,
      sawSnapshot: false,
      closed: false,
      partial: [],
      partialLen: 0,
      stderr: "",
      exit: null,
      timers: {},
    };
    conn.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        conn.exit = { code, signal };
        resolve();
      });
      child.once("error", () => resolve());
    });
    this.conn = conn;
    this.lastChild = child;
    child.on("error", (e) => this._fail(conn, launchFailure(e, spec.file)));
    child.on("exit", (code, signal) => {
      // stdout may still hold the last frames; give it a moment to drain before failing.
      conn.exit = { code, signal };
      conn.timers.exit = setTimeout(() => this._fail(conn, failure("exit", i18nText("U0074", { v: code === null ? signal : code }))), 500);
    });
    child.stdout.on("data", (chunk) => this._onData(conn, chunk));
    child.stdout.on("end", () => this._fail(conn, failure("eof", i18nText("U0075"))));
    child.stdout.on("error", () => {});
    child.stderr.on("data", (chunk) => {
      conn.stderr = (conn.stderr + chunk.toString("utf8")).slice(-8192);
    });
    child.stderr.on("error", () => {});
    child.stdin.on("error", () => {}); // EPIPE from a dead child; exit/end report it
    conn.timers.handshake = setTimeout(
      () => this._fail(conn, failure("handshake", i18nText("U0076", { v: Math.round(this.timing.handshake / 1000) }))),
      this.timing.handshake
    );
  }

  _onData(conn, chunk) {
    if (conn.closed) return;
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(10, start);
      const end = nl === -1 ? chunk.length : nl;
      // Check every chunk, so a peer that never sends a newline cannot grow memory without bound.
      if (conn.partialLen + (end - start) > FRAME_LIMIT) {
        this._fail(conn, failure("frame", i18nText("U0077")));
        return;
      }
      if (end > start) {
        conn.partial.push(chunk.subarray(start, end));
        conn.partialLen += end - start;
      }
      if (nl === -1) return;
      const line = conn.partial.length === 1 ? conn.partial[0] : Buffer.concat(conn.partial, conn.partialLen);
      conn.partial = [];
      conn.partialLen = 0;
      start = nl + 1;
      this._onLine(conn, line);
      if (conn.closed) return;
    }
  }

  _onLine(conn, buf) {
    let text = buf.toString("utf8");
    if (text.endsWith("\r")) text = text.slice(0, -1);
    if (!text.trim()) return;
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (!isPlainObject(frame)) return;
    if (isSnapshot(frame)) {
      this._onSnapshot(conn, frame);
      return;
    }
    if (!conn.ready || "schema" in frame) return;
    if (frame.jsonrpc === "2.0" && typeof frame.method === "string") {
      this._onServerFrame(frame);
      return;
    }
    const reply = rpcReply(frame);
    if (reply) this._settle(reply);
  }

  _onSnapshot(conn, frame) {
    clearTimeout(conn.timers.heartbeat);
    conn.timers.heartbeat = setTimeout(() => this._fail(conn, failure("heartbeat", i18nText("U0078"))), this.timing.heartbeat);
    conn.sawSnapshot = true;
    if (!conn.ready) {
      conn.ready = true;
      clearTimeout(conn.timers.handshake);
      this.backoff = this.timing.backoffMin;
      this._setStatus({ status: "open" });
      this._afterReady(conn);
    }
    const snap = normalizeSnapshot(frame);
    if (this.deleted.size) snap.nodes = snap.nodes.filter((n) => !this.deleted.has(sessionKey(n.profile, n.sid)));
    this.nodes = new Map(snap.nodes.map((n) => [sessionKey(n.profile, n.sid), n]));
    for (const [key, c] of this.created) {
      if (this.nodes.has(key) || this.nodes.has(sessionKey(c.profile, c.rpcId))) this.created.delete(key); // the stream knows it now
      else this.nodes.set(key, c);
    }
    this._emitSnapshot(snap);
  }

  _emitSnapshot(snap = this.snapshot) {
    if (!snap) return;
    const extra = [...this.created.values()].filter((c) => !snap.nodes.some((n) => n.sid === c.sid && n.profile === c.profile));
    const out = { ...snap, nodes: [...snap.nodes, ...extra].map((n) => ({ ...n, bound: this.bindings.has(sessionKey(n.profile, n.sid)) })) };
    const key = JSON.stringify(out);
    this.snapshot = snap;
    if (key === this.snapshotKey) return;
    this.snapshotKey = key;
    this.emit("snapshot", out);
  }

  /** Current snapshot for a late subscriber (renderer reload). */
  currentSnapshot() {
    if (!this.snapshot) return null;
    const extra = [...this.created.values()].filter((c) => !this.snapshot.nodes.some((n) => n.sid === c.sid && n.profile === c.profile));
    return { ...this.snapshot, nodes: [...this.snapshot.nodes, ...extra].map((n) => ({ ...n, bound: this.bindings.has(sessionKey(n.profile, n.sid)) })) };
  }

  /**
   * stream.py opens its gateway socket lazily, on the first ordinary request; events and approvals
   * only flow after that. session.list is read-only, so it is sent at once and then every minute.
   */
  _afterReady(conn) {
    if (!this.autoList) return;
    const list = () => {
      if (this.conn !== conn || conn.closed) return;
      // session.list first: it is an ordinary gateway request, so it also opens stream.py's event socket. Then
      // deck.session_index (answered by the plugin itself) adds the real last activity; an older plugin lacks it.
      this.sessions({ limit: 50 })
        .then(async (rows) => {
          try {
            const page = await this.sessionPage({ profile: "default" });
            if (!page.legacy) {
              const last = new Map(page.rows.map((r) => [r.id, r.lastActive]));
              for (const r of rows) if (last.get(r.id)) r.lastActive = last.get(r.id);
              rows.sort((a, b) => (b.lastActive || b.startedAt || 0) - (a.lastActive || a.startedAt || 0));
            }
          } catch {
            /* the start time still orders them */
          }
          return rows;
        })
        .then((rows) => {
          if (this.conn !== conn) return;
          this.recent = rows;
          this.emit("sessions", rows);
        })
        .catch(() => {});
    };
    list();
    if (this.keepaliveOn) conn.timers.keepalive = setInterval(list, this.timing.keepalive);
  }

  _onServerFrame(frame) {
    if (frame.method === "event") {
      const p = isPlainObject(frame.params) ? frame.params : null;
      if (!p || typeof p.type !== "string") return;
      const payload = isPlainObject(p.payload) ? p.payload : {};
      if ([p, payload].some(v => v.replay === true || v.historical === true || v.initial === true)) return;
      const type = p.type.slice(0, 64);
      const rpcId = str(p.session_id, 512);
      if (type === "deck.plan" || type === "deck.tools") {
        this._onActivity(type, rpcId, p.profile_name, payload);
        return;
      }
      const ref = this._sessionRef(rpcId, p);
      const newKey = ref.profile && ref.sid ? sessionKey(ref.profile, ref.sid) : null;
      const newSession = this.newSessions.get(newKey);
      if (newSession && ["message.start", "message.delta", "message.complete"].includes(type)) {
        newSession.submitted = true;
        if (type === "message.complete") this.newSessions.delete(newKey);
      }
      if (type === "request.cancel" && payload.id !== undefined) {
        const reported = p.profile_name ?? p.profile ?? payload.profile_name ?? payload.profile;
        let matches = [...this.openRequests].filter(([, r]) => r.id === String(payload.id)
          && (!rpcId || r.rpcId === rpcId)
          && (!ref.profile || this._sessionRef(r.rpcId, r.profile ? { profile: r.profile } : {}).profile === ref.profile));
        if (matches.length !== 1 || (!ref.profile && reported !== undefined)) matches = [];
        for (const [key] of matches) this.openRequests.delete(key);
        if (matches.length) this._emitRequests();
      }
      if (type === "message.complete") {
        // a session created here is stored once its first turn ends: its history can be read from now on
        const made = ref.profile && ref.sid ? this.created.get(sessionKey(ref.profile, ref.sid)) : null;
        if (made && made.fresh) {
          made.fresh = false;
          this._emitSnapshot();
        }
      }
      this.emit("event", { type, rpcId, ...ref, payload,
        turnId: eventIdentity(p.turn_id ?? payload.turn_id), eventId: eventIdentity(p.event_id ?? payload.event_id),
        source: str(p.source ?? payload.source, 48), platform: str(p.platform ?? payload.platform, 32) });
      return;
    }
    const req = normalizeServerRequest(frame, (rpcId, params) => this._sessionRef(rpcId, params));
    if (!req) return;
    for (const [key, prior] of this.openRequests) {
      if (prior.id === req.id && prior.rpcId === req.rpcId && this._sessionRef(prior.rpcId, prior.profile ? { profile: prior.profile } : {}).profile === req.profile) this.openRequests.delete(key);
    }
    const key = JSON.stringify([req.profile, req.id, req.rpcId]);
    this.openRequests.set(key, req);
    while (this.openRequests.size > MAX_OPEN_REQUESTS) this.openRequests.delete(this.openRequests.keys().next().value);
    this._emitRequests();
  }

  /**
   * deck.plan / deck.tools from stream.py (plugin 2.x activity): the observer's latest plan and recent tool calls of a
   * session it watches, keyed by the STORED session id (observer nodes are stored ids, never runtime ids). Projected,
   * cached for late readers (plan(), toolCalls()) and re-emitted as an "event" {type, sid, profile, payload}.
   */
  _onActivity(type, sid, profile, payload) {
    if (!SID_RE.test(sid)) return;
    const p = typeof profile === "string" && PROFILE_RE.test(profile) ? profile : "default";
    const key = sessionKey(p, sid);
    let out;
    if (type === "deck.plan") {
      const plan = projectPlan(payload.plan);
      if (!plan) return;
      this.livePlans.delete(key);
      this.livePlans.set(key, plan);
      out = { plan };
    } else {
      const tools = projectToolCalls(payload.tools);
      this.liveTools.delete(key);
      this.liveTools.set(key, tools);
      out = { tools };
    }
    for (const map of [this.livePlans, this.liveTools]) while (map.size > LIVE_ACTIVITY_MAX) map.delete(map.keys().next().value);
    this.emit("event", { type, rpcId: sid, sid, profile: p, payload: out });
  }

  _emitRequests() {
    this.emit("requests", this.listRequests());
  }

  listRequests() {
    return [...this.openRequests.values()].map((r) => ({ ...r, ...this._sessionRef(r.rpcId, r.profile ? { profile: r.profile } : {}) }));
  }

  _settle({ id, result, error, rpcCode }) {
    const p = this.pending.get(id);
    if (!p) return; // unknown or already timed out: a late reply never completes a newer call
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (error !== undefined) p.reject(Object.assign(new Error(error), { rpcCode }));
    else p.resolve(result);
  }

  _failPending(message) {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
  }

  _clearSession() {
    this.recovering?.clear();
    this.livePlans?.clear(); // a new stream sends every session's activity again
    this.liveTools?.clear();
    this.bindings.clear();
    this.rpcToStored.clear();
    this.created.clear();
    this.newSessions.clear();
    this.nodes.clear(); // offline snapshots may stay visible, but their old control authority cannot survive reconnect
    for (const [profile, chat] of this.botPending) if (chat.pending) this.botPending.delete(profile); // only unpersisted chats are epoch-local
    if (this.openRequests.size) {
      this.openRequests.clear();
      this._emitRequests();
    }
  }

  _clearTimers(conn) {
    for (const t of Object.values(conn.timers)) {
      clearTimeout(t);
      clearInterval(t);
    }
    conn.timers = {};
  }

  _kill(conn) {
    const child = conn.child;
    try {
      child.stdin.destroy();
    } catch {
      /* already closed */
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, this.timing.kill);
    if (force.unref) force.unref();
  }

  _fail(conn, reason) {
    if (conn.closed) return;
    conn.closed = true;
    this._clearTimers(conn);
    if (this.conn === conn) this.conn = null;
    this._failPending(conn.ready ? MSG.lost : MSG.offline);
    this._clearSession();
    this._kill(conn);
    const why = classifyFailure(reason, conn.stderr, conn.exit);
    this._afterFailure(conn, why);
  }

  _afterFailure(conn, why) {
    if (this.stopped) return;
    if (!this.retry) {
      this._setStatus({ status: "offline", code: why.code, error: why.text, retryInMs: null });
      return;
    }
    if (conn.sawSnapshot) this.backoff = this.timing.backoffMin;
    const wait = this.backoff;
    this._setStatus({ status: "offline", code: why.code, error: why.text, retryInMs: wait });
    this.retryTimer = setTimeout(() => this._connect(), wait);
    this.backoff = Math.min(this.backoff * 2, this.timing.backoffMax);
  }

  // ------------------------------------------------------------ requests

  /** Send one JSON-RPC request. Rejects immediately when offline; nothing is ever queued for later. */
  request(method, params = {}) {
    try {
      checkRequest(method, params);
    } catch (e) {
      return Promise.reject(e);
    }
    const conn = this.conn;
    if (this.stopped || !conn || !conn.ready || conn.closed) return Promise.reject(new Error(MSG.offline));
    if (this.pending.size >= MAX_PENDING || conn.child.stdin.writableLength > MAX_WRITE_BUFFER) return Promise.reject(new Error(MSG.queueFull));
    const id = `${this.ns}-${this.counter++}`;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    const big = method === ATTACH_METHOD || method === TRANSCRIBE_METHOD;
    const deadline = method === ATTACH_METHOD ? this.timing.attach : method === STAGED_METHOD ? this.timing.staged : method === TRANSCRIBE_METHOD ? this.timing.transcribe : this.timing.request;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (p && p.timer === timer) {
          this.pending.delete(id);
          reject(new Error(MSG.timeout));
        }
      }, deadline);
      this.pending.set(id, { resolve, reject, timer, method });
      this._write(conn, line, big);
    });
  }

  _write(conn, line, big = false) {
    let ok = false;
    try {
      ok = conn.child.stdin.write(line);
    } catch {
      this._fail(conn, failure("write", i18nText("U0079")));
      return;
    }
    // A stalled pipe cannot hold replies, the heartbeat or shutdown hostage (hermes.rs:282-289).
    if (!ok && !conn.timers.drain) {
      conn.timers.drain = setTimeout(() => this._fail(conn, failure("write", i18nText("U0080"))), big ? this.timing.attachWrite : this.timing.write);
      conn.child.stdin.once("drain", () => {
        clearTimeout(conn.timers.drain);
        delete conn.timers.drain;
      });
    }
  }

  // ------------------------------------------------------------ reads

  /**
   * The host plugin's version (host-versions.js): {version, protocol, uploads, downloads} from deck.version (plugin
   * 0.3.6+; `uploads` {v: 1, host} from the plugin that takes staged uploads, `downloads` {v: 1, host, maxBytes} from
   * the plugin that grants relay downloads, else null), {legacy: true} when the host does not know the
   * method (an older plugin), null when it cannot be told now.
   */
  async version() {
    try {
      const r = await this.request("deck.version", {});
      if (!r || typeof r !== "object") return null;
      const up = isPlainObject(r.uploads) && r.uploads.v === 1 && typeof r.uploads.host === "string" && UPLOAD_HOST_RE.test(r.uploads.host) ? { v: 1, host: r.uploads.host } : null;
      const d = r.downloads;
      const down = isPlainObject(d) && d.v === 1 && typeof d.host === "string" && UPLOAD_HOST_RE.test(d.host) && Number.isSafeInteger(d.maxBytes) && d.maxBytes > 0
        ? { v: 1, host: d.host, maxBytes: d.maxBytes } : null;
      return { version: typeof r.version === "string" ? r.version.slice(0, 32) : null, protocol: Number.isInteger(r.protocol) ? r.protocol : null, uploads: up, downloads: down };
    } catch (e) {
      return e && e.rpcCode === -32601 ? { legacy: true } : null;
    }
  }

  async sessions({ limit = 50, profile } = {}) {
    const params = { limit: Math.min(200, Math.max(1, Number(limit) || 50)) };
    if (profile !== undefined) {
      if (typeof profile !== "string" || !PROFILE_RE.test(profile)) throw new Error(i18nText("U0081"));
      params.profile = profile;
    }
    return projectSessions(await this.request("session.list", params), params.profile);
  }

  // ------------------------------------------------------------ session browser (every profile, every platform)

  /**
   * One page of a profile's stored sessions: {rows, hasMore, legacy}. A host with the Deck plugin's deck.session_index
   * answers pages, last-activity, archived and pinned; an older host falls back to session.list (at most 200 rows,
   * no paging, no archived view: `legacy` is true and archived pages are empty).
   */
  async sessionPage({ profile = "default", archived = false, offset = 0 } = {}) {
    if (!validProfileParam(profile)) throw new Error(i18nText("U0081"));
    const params = { limit: INDEX_PAGE, archived: archived ? "only" : "exclude" };
    if (profile !== "default") params.profile = profile;
    if (offset) params.offset = offset;
    let r;
    try {
      r = await this.request("deck.session_index", params);
    } catch (e) {
      // an older plugin (or Hermes Desk's) answers -32601 "Unsupported ... control": fall back to session.list
      if (!/Unsupported/i.test(String((e && e.message) || e))) throw e;
      if (archived || offset) return { rows: [], hasMore: false, legacy: true };
      const legacy = { limit: 200 };
      if (profile !== "default") legacy.profile = profile;
      return { rows: projectIndexRows(await this.request("session.list", legacy), profile), hasMore: false, legacy: true };
    }
    return { rows: projectIndexRows(r, profile), hasMore: isPlainObject(r) && r.has_more === true, legacy: false };
  }

  /**
   * Every profile's stored sessions, merged: {rows, profiles: [{name, ok, hasMore, error}], legacy, at}. Bounded
   * (INDEX_PROFILES profiles x INDEX_PAGES pages), cached for INDEX_TTL ms and shared by concurrent callers; a profile
   * whose store cannot be read is reported and the others still list. Mutations drop the cache.
   */
  async sessionIndex({ archived = false, force = false } = {}) {
    const key = archived ? "archived" : "live";
    const hit = this.indexCache.get(key);
    if (hit && hit.epoch === this.epoch && !force && Date.now() - hit.at < INDEX_TTL) return hit.value;
    if (this.indexFlight.has(key)) return this.indexFlight.get(key);
    const epoch = this.epoch;
    const run = (async () => {
      let names;
      try {
        names = (await this.profiles()).map((p) => p.name);
      } catch {
        names = [];
      }
      for (const n of this.nodes.values()) if (n.profile && !names.includes(n.profile)) names.push(n.profile);
      if (!names.includes("default")) names.unshift("default");
      const profiles = [];
      const rows = [];
      let legacy = false;
      for (const name of names.slice(0, INDEX_PROFILES)) {
        const info = { name, ok: true, hasMore: false, error: "" };
        try {
          for (let page = 0, offset = 0; page < INDEX_PAGES; page++) {
            const r = await this.sessionPage({ profile: name, archived, offset });
            rows.push(...r.rows);
            legacy = legacy || r.legacy;
            info.hasMore = r.hasMore;
            if (!r.hasMore) break;
            offset += INDEX_PAGE;
          }
        } catch (e) {
          info.ok = false;
          info.error = String((e && e.message) || e).slice(0, 200);
        }
        profiles.push(info);
      }
      const seen = new Set();
      const unique = rows.filter((r) => !seen.has(`${r.profile}\u0000${r.id}`) && seen.add(`${r.profile}\u0000${r.id}`));
      return { rows: unique, profiles, legacy, at: Date.now() };
    })();
    this.indexFlight.set(key, run);
    try {
      const value = await run;
      if (this.epoch === epoch) this.indexCache.set(key, { epoch, at: Date.now(), value });
      return value;
    } finally {
      this.indexFlight.delete(key);
    }
  }

  /** Rename one stored session (user title, as Hermes' own rename). Hermes refuses a taken title; its words are passed on. */
  async renameSession(sessionId, { profile, title } = {}) {
    checkSid(sessionId);
    const clean = cleanTitle(title);
    if (clean === null) throw new Error(i18nText("sessions.invalid"));
    const params = { session_id: sessionId, title: clean };
    const p = this._profileOf(sessionId, profile);
    if (p && p !== "default") params.profile = p;
    const r = await this.request("deck.session_update", params);
    this.indexCache.clear();
    const stored = isPlainObject(r) && typeof r.title === "string" ? str(r.title, 160).trim() : clean;
    const node = this.nodeFor(sessionId, profile);
    if (node) node.title = stored;
    return { title: stored };
  }

  /** Pin or unpin one stored session (Hermes keeps pinned ones out of its auto-archive sweep). */
  async pinSession(sessionId, { profile, pinned } = {}) {
    checkSid(sessionId);
    if (typeof pinned !== "boolean") throw new Error(i18nText("sessions.invalid"));
    const params = { session_id: sessionId, pinned };
    const p = this._profileOf(sessionId, profile);
    if (p && p !== "default") params.profile = p;
    const r = await this.request("deck.session_update", params);
    this.indexCache.clear();
    return { pinned: isPlainObject(r) ? r.pinned === true : pinned };
  }

  /** Archive or unarchive one stored session (messages are kept). A session running right now is refused. */
  async archiveSession(sessionId, { profile, archived } = {}) {
    checkSid(sessionId);
    if (typeof archived !== "boolean") throw new Error(i18nText("sessions.invalid"));
    const node = this.nodeFor(sessionId, profile);
    if (archived && node && node.terminalAt === null && (node.active || node.state === "thinking" || node.state === "working" || node.state === "searching")) {
      throw new Error(i18nText("sessions.busy"));
    }
    const params = { session_id: sessionId, archived };
    const p = this._profileOf(sessionId, profile);
    if (p && p !== "default") params.profile = p;
    await this.request("session.archive", params);
    this.indexCache.clear();
    return { archived };
  }

  /**
   * "Continue here": a stored session (usually one a messaging platform owns) copied into a NEW Deck session, so a
   * message never lands in the original chat's transcript. Returns {sid, profile}; the new session is bound and shown.
   */
  async branchSession(sessionId, { profile } = {}) {
    checkSid(sessionId);
    const p = this._profileOf(sessionId, profile) || "default";
    if (p !== "default" && !PROFILE_RE.test(p)) throw new Error(i18nText("U0081"));
    const epoch = this.epoch;
    const params = { parent_session_id: sessionId, idempotency_key: require("crypto").randomUUID() };
    if (p !== "default") params.profile = p;
    const r = await this.request("session.branch_stored", params);
    const { stored } = this._created(r, p, epoch, "");
    const made = this.created.get(sessionKey(p, stored));
    if (made) made.fresh = false; // it carries the copied history: read it, do not treat it as empty
    this.indexCache.clear();
    return { sid: stored, profile: p };
  }

  /** Read-only persisted history (latest window, then older pages by offset). Never resumes a session. */
  async history(sessionId, { profile = "default", limit = 40, offset = 0 } = {}) {
    checkSid(sessionId);
    if (typeof profile !== "string" || !PROFILE_RE.test(profile)) throw new Error(i18nText("U0081"));
    const lim = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 40;
    const off = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const r = await this.request("session.messages", { session_id: sessionId, profile, limit: lim, offset: off, order: "latest", inline_images: false });
    const raw = isPlainObject(r) && Array.isArray(r.messages) ? r.messages : [];
    const pg = isPlainObject(r) && isPlainObject(r.pagination) ? r.pagination : {};
    const returned = typeof pg.returned === "number" ? pg.returned : raw.length;
    const usedLimit = typeof pg.limit === "number" ? pg.limit : lim;
    const hasMore = typeof pg.hasMore === "boolean" ? pg.hasMore : typeof pg.has_more === "boolean" ? pg.has_more : returned >= usedLimit;
    return { sid: sessionId, messages: projectHistory(raw), offset: off + usedLimit, hasMore, returned };
  }

  // ------------------------------------------------------------ dictation and downloads (reads on the host)

  /**
   * Dictation: one recorded clip -> text, transcribed by Hermes' own STT on the host. The text goes into the
   * composer for the owner to edit; nothing is sent to the agent. `audio` is a Buffer (webm/ogg/wav...).
   */
  async transcribe(audio, mime, { language } = {}) {
    if (!Buffer.isBuffer(audio) || !audio.length || audio.length > TRANSCRIBE_AUDIO_MAX) throw new Error(i18nText("voice.invalid"));
    const params = { audio_base64: audio.toString("base64"), mime: typeof mime === "string" ? mime : "audio/webm" };
    // Only an explicit hint is sent: without one Hermes' own stt config (auto-detect by default) decides.
    if (typeof language === "string" && LANGUAGE_RE.test(language.toLowerCase())) params.language = language.toLowerCase();
    const r = await this.request(TRANSCRIBE_METHOD, params);
    const text = isPlainObject(r) && typeof r.text === "string" ? r.text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim() : "";
    return { text: text.slice(0, 32000), provider: isPlainObject(r) ? str(r.provider, 40) : "" };
  }

  /**
   * One chunk of a file the agent offered in `sessionId` (the host checks that, and refuses secrets). Returns
   * {size, mtime, offset, length, eof, bytes: Buffer}; the host path never comes back.
   */
  async fileChunk(sessionId, filePath, { offset = 0, length = FILE_CHUNK_MAX, profile } = {}) {
    checkSid(sessionId);
    const params = { session_id: sessionId, path: filePath, offset, length };
    const p = this._profileOf(sessionId, profile);
    if (p && p !== "default") params.profile = p;
    const r = await this.request(FILE_METHOD, params);
    if (!isPlainObject(r) || typeof r.data !== "string" || !Number.isSafeInteger(r.size) || r.size < 0 || r.size > FILE_SIZE_MAX || !Number.isSafeInteger(r.length) || r.length < 0 || r.length > length) {
      throw new Error(i18nText("download.badReply"));
    }
    const bytes = Buffer.from(r.data, "base64");
    if (bytes.length !== r.length) throw new Error(i18nText("download.badReply"));
    return { size: r.size, mtime: num(r.mtime), offset: r.offset, length: r.length, eof: r.eof === true, bytes };
  }

  /**
   * A download ticket for a file the agent offered in `sessionId` (deck.file_grant: the host runs deck.file_read's own
   * checks): {id, name, size, mtime}. The relay on the same host streams the file for that id (GET /downloads/<id>);
   * the host path never comes back.
   */
  async fileGrant(sessionId, filePath, { profile } = {}) {
    checkSid(sessionId);
    const params = { session_id: sessionId, path: filePath };
    const p = this._profileOf(sessionId, profile);
    if (p && p !== "default") params.profile = p;
    const r = await this.request(GRANT_METHOD, params);
    if (!isPlainObject(r) || typeof r.id !== "string" || !DOWNLOAD_ID_RE.test(r.id) || !Number.isSafeInteger(r.size) || r.size < 0 || r.size > DOWNLOAD_BYTES_MAX) {
      throw new Error(i18nText("download.badReply"));
    }
    return { id: r.id, name: typeof r.name === "string" ? r.name.slice(0, 255) : "", size: r.size, mtime: num(r.mtime) };
  }

  // ------------------------------------------------------------ mutations (only ever on a user's click)

  /**
   * Delete a stored session and its transcripts (native session.delete, one click + confirm in the UI).
   * `sessionId` is the stored key the rail holds, which is what Hermes takes. Hermes refuses a session that is
   * live in its gateway (code 4023); that error text is passed on and nothing is forgotten locally.
   */
  async deleteSession(sessionId, { profile } = {}) {
    checkSid(sessionId);
    const params = { session_id: sessionId };
    const p = this._profileOf(sessionId, profile);
    const key = sessionKey(p, sessionId);
    if (p && p !== "default") params.profile = p;
    // A session this Deck resumed is live in Hermes's gateway and would be refused: release an idle one first.
    // A running one is left alone, so Hermes answers "cannot delete an active session" and nothing is torn down.
    const bound = this.bindings.get(key);
    const node = this.nodes.get(key);
    const made = this.created.get(key);
    const canonical = this.botPending.get(p);
    const canonicalMatch = canonical && (canonical.chat.id === sessionId || canonical.chat.sid === sessionId);
    const freshUnstored = made && made.fresh && !(canonicalMatch && !canonical.pending);
    if (bound && bound.epoch === this.epoch && !(node && (node.active || node.state === "thinking" || node.state === "working" || node.state === "searching") && node.terminalAt === null)) {
      try { await this.request("session.close", { session_id: bound.rpcId }); }
      catch (error) { if (freshUnstored) throw error; } // no DB acknowledgement can establish deletion of an unpersisted runtime
    }
    // Successful session.title persists a canonical row even before its first turn.
    if (!freshUnstored) await this.request("session.delete", params);
    const confirmedCanonical = this.botPending.get(p);
    if (confirmedCanonical && (confirmedCanonical.chat.id === sessionId || confirmedCanonical.chat.sid === sessionId)) { this.botSeen.delete(p); this.botPending.delete(p); }
    const b = this.bindings.get(key);
    if (b) this.rpcToStored.delete(b.rpcId);
    for (const [alias, binding] of this.bindings) {
      if (binding.rpcId === b?.rpcId && JSON.parse(alias)[0] === p) this.bindings.delete(alias);
    }
    if (made && made.rpcId) this.rpcToStored.delete(made.rpcId);
    this.newSessions.delete(key);
    this.deleted.add(key);
    this.indexCache.clear();
    this.created.delete(key);
    this.nodes.delete(key);
    this.recent = this.recent.filter((r) => r && !(r.id === sessionId && r.profile === p));
    if (this.snapshot) this._emitSnapshot({ ...this.snapshot, nodes: this.snapshot.nodes.filter((n) => !(n.sid === sessionId && n.profile === p)) });
    return { deleted: sessionId };
  }

  /** Release only an untouched New session; never delete a stored transcript or a Bot Chat. */
  async discard(sessionId, { profile } = {}) {
    checkSid(sessionId);
    const p = this._profileOf(sessionId, profile);
    const key = sessionKey(p, sessionId);
    const made = this.newSessions.get(key);
    const observed = this.nodes.get(key);
    if (!made || !made.fresh || made.submitted || (observed && (observed.active || observed.turnId || observed.ctxUsed > 0))) return { discarded: null };
    // Forget synchronously, before waiting for Hermes: stale snapshots cannot repaint a ghost.
    this.deleted.add(key);
    this.deleted.add(sessionKey(p, made.rpcId));
    this._forgetCreated(sessionId, made.rpcId, p, false);
    this.recent = this.recent.filter((r) => r && !(r.id === sessionId && r.profile === p));
    this.indexCache.clear();
    if (this.snapshot) this._emitSnapshot({ ...this.snapshot, nodes: this.snapshot.nodes.filter((n) => !this.deleted.has(sessionKey(n.profile, n.sid))) });
    await this.request("session.close", { session_id: made.rpcId }).catch(() => {});
    return { discarded: sessionId };
  }

  /** Persisted id -> live gateway id, resuming the session in Hermes's TUI gateway when needed. */
  async _bind(storedId, profile) {
    checkSid(storedId);
    profile = this._profileOf(storedId, profile);
    const key = sessionKey(profile, storedId);
    const epoch = this.epoch;
    const b = this.bindings.get(key);
    if (b && b.epoch === epoch) return b.rpcId;
    const params = { session_id: storedId, omit_messages: true, inline_images: false };
    if (profile && profile !== "default") {
      if (!PROFILE_RE.test(profile)) throw new Error(i18nText("U0081"));
      params.profile = profile;
    }
    const r = await this.request("session.resume", params);
    if (this.epoch !== epoch || !this.conn) throw new Error(MSG.changed);
    const rpcId = isPlainObject(r) && typeof r.session_id === "string" ? r.session_id : "";
    if (!rpcId || rpcId.length > 512) throw new Error(i18nText("U0082"));
    const info = isPlainObject(r.info) ? r.info : {};
    const canonical = [r.stored_session_id, r.session_key, r.resumed, info.stored_session_id].find((v) => typeof v === "string" && v && v.length <= 512);
    const existing = this.rpcToStored.get(rpcId);
    if (existing && existing.profile !== profile) throw new Error(MSG.changed);
    for (const id of new Set([storedId, canonical].filter(Boolean))) this.bindings.set(sessionKey(profile, id), { rpcId, epoch });
    this.rpcToStored.set(rpcId, { sid: storedId, profile });
    this._emitSnapshot();
    if (this.showReasoning) this._reasoningView(rpcId, true);
    return rpcId;
  }

  /** Retry only an explicit missing-runtime reply, never an uncertain/timeout send. */
  async _runtimeRequest(method, storedId, profile, params) {
    const epoch = this.epoch, key = sessionKey(profile, storedId);
    const failedBinding = this.bindings.get(key);
    try { return await this.request(method, params); }
    catch (error) {
      if (error.rpcCode !== 4001 || error.message !== "session not found" || epoch !== this.epoch) throw error;
      this.recovering ||= new Map();
      let recovery = this.recovering.get(key);
      if (!recovery) {
        const current = this.bindings.get(key);
        if (current && failedBinding && current.rpcId !== failedBinding.rpcId && current.epoch === epoch) {
          recovery = Promise.resolve(current.rpcId); // a late reply for the old runtime
        } else {
          if (current) {
            for (const [alias, binding] of this.bindings) if (binding.rpcId === current.rpcId && JSON.parse(alias)[0] === profile) this.bindings.delete(alias);
            this.rpcToStored.delete(current.rpcId);
          }
          recovery = this._bind(storedId, profile);
        }
        this.recovering.set(key, recovery);
      }
      let rpcId;
      try { rpcId = await recovery; }
      finally { if (this.recovering.get(key) === recovery) this.recovering.delete(key); }
      if (epoch !== this.epoch) throw new Error(MSG.changed);
      // Native observer controls address stored IDs + turn/pid, not gateway runtime IDs.
      return this.request(method, { ...params, session_id: method.startsWith("native.") ? storedId : rpcId });
    }
  }

  /**
   * "Show thinking" on/off for the sessions this Deck drives: applied to every session bound on this connection and
   * to each one bound later. Best effort: an older plugin answers -32601 and the Deck shows the step log instead.
   */
  setReasoning(show) {
    this.showReasoning = show === true;
    const rpcIds = new Set([...this.bindings.values()].filter((b) => b.epoch === this.epoch).map((b) => b.rpcId));
    for (const id of rpcIds) this._reasoningView(id, this.showReasoning);
    return { show: this.showReasoning };
  }

  _reasoningView(rpcId, show) {
    if (!this.conn || typeof rpcId !== "string" || !SID_RE.test(rpcId)) return;
    this.request("deck.reasoning_view", { session_id: rpcId, show }).catch(() => {});
  }

  /**
   * A new, empty session in a profile (session.create, as Hermes Desktop's "new chat"). Hermes keeps it in
   * memory until its first turn, so the Deck shows it from here until the stream lists it. The
   * idempotency key makes a retried create return the same session instead of a second one.
   */
  async create({ profile = "default" } = {}) {
    if (profile !== "default" && !PROFILE_RE.test(profile)) throw new Error(i18nText("U0081"));
    const epoch = this.epoch;
    const params = { idempotency_key: require("crypto").randomUUID() };
    if (profile !== "default") params.profile = profile;
    const r = await this.request("session.create", params);
    const { stored } = this._created(r, profile, epoch, "", true);
    return { sid: stored, profile };
  }

  /** Bind a session.create reply and show the new session until a snapshot lists it. */
  _created(r, profile, epoch, title, railNew = false) {
    if (this.epoch !== epoch || !this.conn) throw new Error(MSG.changed);
    const rpcId = isPlainObject(r) && typeof r.session_id === "string" ? r.session_id : "";
    if (!rpcId || rpcId.length > 512) throw new Error(i18nText("U0082"));
    const stored = typeof r.stored_session_id === "string" && r.stored_session_id && r.stored_session_id.length <= 512 ? r.stored_session_id : rpcId;
    const key = sessionKey(profile, stored);
    const existing = this.rpcToStored.get(rpcId);
    if (existing && existing.profile !== profile) throw new Error(MSG.changed);
    this.bindings.set(key, { rpcId, epoch });
    this.rpcToStored.set(rpcId, { sid: stored, profile });
    const node = { ...normalizeNode({ session_id: stored, profile_name: profile, state: "idle", updated_at: Date.now() / 1000, source: "deck", title }), rpcId, fresh: true };
    this.created.set(key, node);
    this.nodes.set(key, node);
    if (railNew) this.newSessions.set(key, node);
    this._emitSnapshot();
    if (this.showReasoning) this._reasoningView(rpcId, true);
    return { stored, rpcId };
  }

  _forgetCreated(stored, rpcId, profile, emit = true) {
    const key = sessionKey(profile, stored);
    this.newSessions.delete(key);
    this.created.delete(key);
    this.nodes.delete(key);
    this.bindings.delete(key);
    this.rpcToStored.delete(rpcId);
    if (emit) this._emitSnapshot();
  }

  // ------------------------------------------------------------ bots (Hermes Desktop's Bot Mode)

  mailDrafts() { return this._mailDrafts ||= new (require("./mail-drafts").MailDrafts)(this); }

  /** The bot roster: one row per Hermes profile (profiles.list, as Hermes Desktop polls it). */
  async profiles() {
    return projectProfiles(await this.request("profiles.list", {}));
  }

  /** One profile's slash commands (commands.catalog, projected). Older hosts answer -32601: the caller shows none. */
  async commandCatalog(profile) {
    if (!validProfileParam(profile)) throw new Error(i18nText("U0081"));
    return projectCommandCatalog(await this.request("commands.catalog", { profile }));
  }

  /** A profile's avatar picture (profiles.get_asset), checked and size-capped; {found:false} when there is none. */
  async avatar(name) {
    if (typeof name !== "string" || !PROFILE_RE.test(name)) throw new Error(i18nText("U0081"));
    return projectAvatar(await this.request("profiles.get_asset", { name, asset: "avatar" }));
  }

  /**
   * Find a profile's canonical "Bot Chat" (read-only): {sid, id, profile, ...} or null when it has none yet.
   * Fails closed like Hermes Desktop (canonical-chat.ts findExistingCanonicalChat): a failed lookup, an empty
   * reply for a profile known to have one (`expect`, or seen earlier), or a host that ignores the exact-title
   * lookup all throw, so nothing ever mints a second chat beside the real one.
   */
  async botChat(profile, { expect = false } = {}) {
    if (typeof profile !== "string" || !PROFILE_RE.test(profile)) throw new Error(i18nText("U0081"));
    const params = { title: BOT_CHAT_TITLE, include_hidden: true, limit: 200 };
    if (profile !== "default") params.profile = profile;
    let r;
    try {
      r = await this.request("session.list", params);
    } catch (e) {
      throw new Error(i18nText("U0083", { BOT_CHAT_TITLE: BOT_CHAT_TITLE, message: e.message }));
    }
    const rows = isPlainObject(r) && Array.isArray(r.sessions) ? r.sessions.filter(isPlainObject) : [];
    // an exact-title lookup answers at most one row, with the lineage tip as resolved_id; anything else is
    // a host that ignored `title` and listed recent sessions instead
    if (rows.length > 1 || (rows.length === 1 && !(typeof rows[0].resolved_id === "string" && isBotChatRow(rows[0])))) {
      throw new Error(i18nText("U0084", { BOT_CHAT_TITLE: BOT_CHAT_TITLE }));
    }
    if (rows.length === 1 && sidOrNull(rows[0].id)) {
      const chat = projectBotChat(rows[0], profile);
      this.botSeen.add(profile);
      this.botPending.set(profile, { chat, epoch: this.epoch, pending: false });
      return chat;
    }
    const mine = this.botPending.get(profile);
    if (mine && mine.pending && mine.epoch === this.epoch) return { ...mine.chat, pending: true }; // created here; stored on its first turn
    if (expect || this.botSeen.has(profile)) {
      throw new Error(i18nText("U0085", { BOT_CHAT_TITLE: BOT_CHAT_TITLE }));
    }
    return null;
  }

  /**
   * Open the profile's Bot Chat for a first message: look it up again (fail closed), and only when there is
   * none create it the way Hermes Desktop does: session.create {title: "Bot Chat", hidden, follow_profile_config},
   * then session.title right away so a second click cannot mint a duplicate before the first turn ends.
   * A title already taken means someone else just created it: that one is adopted. Never sends a prompt.
   */
  async createBotChat(profile, { expect = false } = {}) {
    if (typeof profile !== "string" || !PROFILE_RE.test(profile)) throw new Error(i18nText("U0081"));
    const inflight = this.minting.get(profile);
    if (inflight) return inflight;
    const p = (async () => {
      const existing = await this.botChat(profile, { expect });
      if (existing) return { ...existing, created: false };
      return this._mintBotChat(profile);
    })().finally(() => this.minting.delete(profile));
    this.minting.set(profile, p);
    return p;
  }

  async _mintBotChat(profile) {
    const epoch = this.epoch;
    const params = { idempotency_key: require("crypto").randomUUID(), title: BOT_CHAT_TITLE, hidden: true, follow_profile_config: true };
    if (profile !== "default") params.profile = profile;
    const { stored, rpcId } = this._created(await this.request("session.create", params), profile, epoch, BOT_CHAT_TITLE);
    let pending = false;
    try {
      const titled = await this.request("session.title", { session_id: rpcId, title: BOT_CHAT_TITLE });
      pending = isPlainObject(titled) && titled.pending === true;
    } catch (e) {
      if (/already in use/i.test(e.message)) {
        // adopt before mint: another writer holds the title, so theirs is adopted. Ours is not free: Hermes'
        // session.title writes the session's state.db row (hidden, through pending_hidden) before the title
        // conflict is raised, so each adopt leaves one hidden, untitled, empty row in that profile. Lists never
        // show it; Hermes Desktop's adopt path leaves the same row. Its runtime session is only forgotten here.
        this._forgetCreated(stored, rpcId, profile);
        const winner = await this.botChat(profile);
        if (winner) return { ...winner, created: false, adopted: true };
        throw new Error(i18nText("U0086", { BOT_CHAT_TITLE: BOT_CHAT_TITLE }));
      }
      if ([MSG.timeout, MSG.lost, MSG.offline, MSG.closed, MSG.queueFull].includes(e.message)) throw e;
      // an older host without session.title: Hermes applies the title after the first turn (pending_title)
      pending = true;
    }
    if (this.epoch !== epoch) throw new Error(MSG.changed);
    const chat = { sid: stored, id: stored, profile, title: BOT_CHAT_TITLE, preview: "", lastActive: Date.now() / 1000, messageCount: 0 };
    this.botPending.set(profile, { chat, epoch, pending });
    if (!pending) this.botSeen.add(profile);
    return { ...chat, created: true, pending };
  }

  /**
   * Send a new turn: resume (once per connection), then prompt.submit. A busy session queues it. `files` (base64) go
   * through deck.attach_submit; `staged` ([{upload, filename}], relay spool ids) through deck.attach_staged.
   */
  async send(sessionId, text, { profile, files, staged } = {}) {
    const withStaged = Array.isArray(staged) && staged.length > 0;
    const withFiles = withStaged || (Array.isArray(files) && files.length > 0);
    if (withFiles && typeof text !== "string") throw new Error(i18nText("U0103"));
    const t = withFiles ? text.trim() : checkText(text, null); // files only: the text may be empty, the host adds a default one
    // A submit is intent even if its reply is lost; never tear down a turn while _bind awaits.
    const key = sessionKey(this._profileOf(sessionId, profile), sessionId);
    const made = this.newSessions.get(key) || this.created.get(key);
    if (made) made.submitted = true;
    const rpcId = await this._bind(sessionId, this._profileOf(sessionId, profile));
    const method = withStaged ? STAGED_METHOD : withFiles ? ATTACH_METHOD : "prompt.submit";
    const params = withStaged ? { session_id: rpcId, text: t, files: staged } : withFiles ? { session_id: rpcId, text: t, files } : { session_id: rpcId, text: t };
    const r = await this._runtimeRequest(method, sessionId, this._profileOf(sessionId, profile), params);
    return { status: isPlainObject(r) && typeof r.status === "string" ? r.status.slice(0, 64) : "ok" };
  }

  /** Explicit user action: transfer this live runtime to this caller without submitting text. */
  async takeover(sessionId, { profile } = {}) {
    checkSid(sessionId);
    profile = this._profileOf(sessionId, profile);
    const epoch = this.epoch;
    const node = this.nodeFor(sessionId, profile);
    const r = await this.request("deck.takeover", { session_id: sessionId, profile, ...(node?.ownerPid ? { owner_pid: node.ownerPid } : {}) });
    if (epoch !== this.epoch || !this.conn) throw new Error(MSG.changed);
    if (!isPlainObject(r) || r.ok !== true || !["transferred", "restarted"].includes(r.mode) || !sidOrNull(r.session_id)) throw new Error("Invalid takeover reply");
    const key = sessionKey(profile, sessionId);
    const old = this.bindings.get(key);
    if (old) {
      this.rpcToStored.delete(old.rpcId);
      for (const [alias, binding] of this.bindings) if (binding.rpcId === old.rpcId && JSON.parse(alias)[0] === profile) this.bindings.set(alias, { rpcId: r.session_id, epoch });
    }
    this.bindings.set(key, { rpcId: r.session_id, epoch });
    this.rpcToStored.set(r.session_id, { sid: sessionId, profile });
    if (this.showReasoning) this._reasoningView(r.session_id, true);
    this._emitSnapshot();
    return { ok: true, mode: r.mode };
  }

  /** Add guidance to the running turn (the agent reads it before its next step). */
  async steer(sessionId, text, opts = {}) {
    return this._native("native.steer", sessionId, checkText(text, MAX_TEXT), opts.turnId, opts.profile);
  }

  /** Replace what the running turn is doing with this instruction. */
  async redirect(sessionId, text, opts = {}) {
    return this._native("native.redirect", sessionId, checkText(text, MAX_TEXT), opts.turnId, opts.profile);
  }

  /** Stop the running turn: native interrupt when the plugin controls it, else the bound gateway session. */
  async interrupt(sessionId, opts = {}) {
    checkSid(sessionId);
    const profile = this._profileOf(sessionId, opts.profile);
    const node = this.nodeFor(sessionId, profile);
    if (opts.turnId !== undefined && opts.turnId !== null && (!node || opts.turnId !== node.turnId)) throw new Error(i18nText("U0089"));
    if (node && controllable(node)) return this._native("native.interrupt", sessionId, undefined, opts.turnId, profile);
    const b = this.bindings.get(sessionKey(profile, sessionId));
    if (b && b.epoch === this.epoch && this.rpcToStored.get(b.rpcId)?.profile === profile) {
      const r = await this._runtimeRequest("session.interrupt", sessionId, profile, { session_id: b.rpcId });
      return { status: isPlainObject(r) && typeof r.status === "string" ? r.status.slice(0, 64) : "interrupted" };
    }
    throw new Error(i18nText("U0087"));
  }

  async _native(method, sessionId, text, turnId, profile) {
    checkSid(sessionId);
    const node = this.nodeFor(sessionId, profile);
    if (!node || !controllable(node)) throw new Error(i18nText("U0088"));
    if (turnId !== undefined && turnId !== null && turnId !== node.turnId) throw new Error(i18nText("U0089"));
    // Session id, owner pid and turn id must all match the executing agent on the host.
    const params = { session_id: sessionId, turn_id: node.turnId, owner_pid: node.ownerPid };
    if (text !== undefined) params.text = text;
    const r = await this._runtimeRequest(method, sessionId, this._profileOf(sessionId, profile), params);
    return { status: isPlainObject(r) && typeof r.status === "string" ? r.status.slice(0, 64) : "unknown" };
  }

  // ------------------------------------------------------------ work pane: sub-agents, plan, tool calls

  /**
   * The live children of a session (subagent.list), completed by the plugin with model, effort, state, elapsed seconds,
   * tokens, cost and their recent tool calls: {subagents: [...], failed: [...]}. A read, but it addresses the runtime
   * session, so the session is resumed (bound) on this connection first, like model options. Never replayed.
   */
  async subagents(sessionId, { profile } = {}) {
    const p = this._profileOf(sessionId, profile);
    const rpcId = await this._bind(sessionId, p);
    return projectSubagents(await this._runtimeRequest("subagent.list", sessionId, p, { session_id: rpcId }));
  }

  /** The last 16 KB of one live child's transcript (subagent.tail) plus its detail: {id, available, text, truncated, detail}. */
  async subagentTail(sessionId, subagentId, { profile } = {}) {
    checkSubagentId(subagentId);
    const p = this._profileOf(sessionId, profile);
    const rpcId = await this._bind(sessionId, p);
    return projectSubagentTail(await this._runtimeRequest("subagent.tail", sessionId, p, { session_id: rpcId, subagent_id: subagentId }), subagentId);
  }

  /** Queue guidance into one live child (a click; never replayed). "queued" is not "delivered". */
  async steerSubagent(sessionId, subagentId, text, { profile } = {}) {
    checkSubagentId(subagentId);
    const t = checkText(text, MAX_TEXT);
    const p = this._profileOf(sessionId, profile);
    const rpcId = await this._bind(sessionId, p);
    const r = await this._runtimeRequest("subagent.steer", sessionId, p, { session_id: rpcId, subagent_id: subagentId, text: t });
    return { status: isPlainObject(r) && typeof r.status === "string" ? r.status.slice(0, 64) : "unknown" };
  }

  /** Hard-interrupt one live child (a click; never replayed). found:false means it had already finished. */
  async interruptSubagent(sessionId, subagentId, { profile } = {}) {
    checkSubagentId(subagentId);
    const p = this._profileOf(sessionId, profile);
    const rpcId = await this._bind(sessionId, p);
    const r = await this._runtimeRequest("subagent.interrupt", sessionId, p, { session_id: rpcId, subagent_id: subagentId });
    return { found: isPlainObject(r) && r.found === true };
  }

  /**
   * The Plan tab: {sid, plan, live}. The latest plan this connection saw live (deck.plan event), else the stored one the
   * plugin rebuilds from state.db (deck.plan read). plan null: the agent did not publish one. A host without deck.plan
   * (-32601) answers plan null.
   */
  async plan(sessionId, { profile } = {}) {
    checkSid(sessionId);
    const p = this._profileOf(sessionId, profile);
    const live = this.livePlans.get(sessionKey(p, sessionId));
    if (live) return { sid: sessionId, plan: live, live: true };
    const params = { session_id: sessionId };
    if (p !== "default") params.profile = p;
    try {
      const r = await this.request("deck.plan", params);
      return { sid: sessionId, plan: projectPlan(isPlainObject(r) ? r.plan : null), live: false };
    } catch (e) {
      if (e && e.rpcCode === -32601) return { sid: sessionId, plan: null, live: false };
      throw e;
    }
  }

  /** The Run tab's latest tool calls of a session as last pushed (deck.tools); [] when none arrived on this connection. */
  toolCalls(sessionId, { profile } = {}) {
    checkSid(sessionId);
    return this.liveTools.get(sessionKey(this._profileOf(sessionId, profile), sessionId)) || [];
  }

  async modelOptions(sessionId, { profile, profileOnly = false } = {}) {
    if (profileOnly === true) {
      checkSid(sessionId);
      return projectModelOptions(await this.request("model.options", { profile: this._profileOf(sessionId, profile), include_unconfigured: false, refresh: false }));
    }
    const rpcId = await this._bind(sessionId, this._profileOf(sessionId, profile));
    return projectModelOptions(await this.request("model.options", { session_id: rpcId, include_unconfigured: false, refresh: false }));
  }

  /** Session-scoped model switch (`<id> --provider <slug> --session`); never global. */
  async setModel(sessionId, { model, provider, confirm = false, profile } = {}) {
    if (typeof model !== "string" || !MODEL_ID_RE.test(model)) throw new Error(i18nText("U0090"));
    if (typeof provider !== "string" || !SLUG_RE.test(provider)) throw new Error(i18nText("U0091"));
    const rpcId = await this._bind(sessionId, this._profileOf(sessionId, profile));
    const params = { session_id: rpcId, key: "model", value: `${model} --provider ${provider} --session` };
    if (confirm === true) params.confirm_expensive_model = true;
    const r = await this.request("config.set", params);
    const o = isPlainObject(r) ? r : {};
    // Hermes keeps its own confirmation step for expensive models and may defer to the next turn.
    return {
      confirmRequired: o.confirm_required === true,
      message: keepLines(typeof o.confirm_message === "string" ? o.confirm_message : o.warning, 600),
      warning: keepLines(o.warning, 600),
      deferred: o.deferred === true,
    };
  }

  /** Session-scoped reasoning level (Hermes keeps it on the session; config.yaml is never written). */
  async setEffort(sessionId, { effort, profile } = {}) {
    if (!REASONING_EFFORTS.includes(effort)) throw new Error(i18nText("pick.badEffort"));
    const rpcId = await this._bind(sessionId, this._profileOf(sessionId, profile));
    const r = await this.request("config.set", { session_id: rpcId, key: "reasoning", value: effort });
    const v = isPlainObject(r) && typeof r.value === "string" ? r.value : effort;
    return { effort: REASONING_EFFORTS.includes(v) ? v : effort };
  }

  /** A main-process notification capability bound to this arrival and connection, never an ID alone. */
  captureApproval(id) {
    const matches = [...this.openRequests.values()].filter(r => r.id === id);
    const req = matches.length === 1 ? matches[0] : null;
    if (!req || req.kind !== "approval" || !validProfileParam(req.profile)) return null;
    const conn = this.conn;
    const epoch = this.epoch;
    const fingerprint = JSON.stringify([req, req.notification]);
    let used = false;
    const current = () => !used && !this.stopped && !!conn && conn.ready && !conn.closed
      && this.conn === conn && this.epoch === epoch && [...this.openRequests.values()].includes(req)
      && JSON.stringify([req, req.notification]) === fingerprint
      && !this.answering.has(JSON.stringify([epoch, id])) && this.listRequests().filter(r => r.id === id).length === 1;
    return {
      preview: req.notification,
      choices: [...req.choices],
      current,
      answer: choice => {
        if (!current() || !["once", "deny"].includes(choice)) return Promise.reject(new Error(MSG.notOpen));
        used = true; // consume before writing; failure is never retried from a stale banner
        return this.answerApproval(id, choice, { profile: req.profile });
      },
    };
  }

  answerApproval(id, choice, { profile } = {}) {
    const matches = this.listRequests().filter((r) => r.id === id);
    const req = matches.length === 1 ? matches[0] : null;
    if (!req || !validProfileParam(req.profile) || req.kind !== "approval") return Promise.reject(new Error(MSG.notOpen));
    if (profile !== undefined && (!validProfileParam(profile) || req.profile !== profile)) return Promise.reject(new Error(MSG.notOpen));
    if (!req.choices.includes(choice)) return Promise.reject(new Error(i18nText("U0092")));
    return this._answer(req, { choice });
  }

  answerQuestion(id, answers, { profile } = {}) {
    const matches = this.listRequests().filter((r) => r.id === id);
    const req = matches.length === 1 ? matches[0] : null;
    if (!req || !validProfileParam(req.profile) || req.kind !== "question") return Promise.reject(new Error(MSG.notOpen));
    if (profile !== undefined && (!validProfileParam(profile) || req.profile !== profile)) return Promise.reject(new Error(MSG.notOpen));
    if (!isPlainObject(answers)) return Promise.reject(new Error(i18nText("U0093")));
    const qids = new Set(req.questions.map((q) => q.qid));
    const out = {};
    for (const [qid, value] of Object.entries(answers)) {
      if (!qids.has(qid)) return Promise.reject(new Error(i18nText("U0094")));
      const v = Array.isArray(value) ? value.map(String).join(", ") : value;
      if (typeof v !== "string" || v.length > 4000) return Promise.reject(new Error(i18nText("U0095")));
      out[qid] = v;
    }
    return this._answer(req, { answers: out });
  }

  async _answer(req, result) {
    const captured = [...this.openRequests].find(([, prior]) => prior.id === req.id && prior.rpcId === req.rpcId
      && this._sessionRef(prior.rpcId, prior.profile ? { profile: prior.profile } : {}).profile === req.profile);
    if (!captured) throw new Error(MSG.notOpen);
    const [key, arrival] = captured;
    const conn = this.conn;
    const epoch = this.epoch;
    const answerKey = JSON.stringify([epoch, req.id]);
    if (!conn || !conn.ready || conn.closed || this.stopped || this.answering.has(answerKey)
      || req.at !== arrival.at || req.kind !== arrival.kind || req.command !== arrival.command
      || req.description !== arrival.description || JSON.stringify(req.choices) !== JSON.stringify(arrival.choices)
      || JSON.stringify(req.questions) !== JSON.stringify(arrival.questions)) throw new Error(MSG.notOpen);
    this.answering.add(answerKey); // synchronous: native action and open card cannot both write
    try {
      const r = await this.request("request.answer", { id: req.id, result });
      const status = isPlainObject(r) && typeof r.status === "string" ? r.status.slice(0, 64) : "unknown";
      if (this.conn === conn && this.epoch === epoch && this.openRequests.get(key) === arrival) {
        this.openRequests.delete(key);
        this._emitRequests();
      }
      return { status };
    } finally {
      this.answering.delete(answerKey);
    }
  }

  _profileOf(sessionId, profile) {
    if (profile !== undefined) {
      if (!validProfileParam(profile)) throw new Error(i18nText("U0081"));
      return profile;
    }
    const profiles = new Set();
    for (const n of this.nodes.values()) if (n.sid === sessionId) profiles.add(n.profile);
    for (const key of this.bindings.keys()) {
      const [p, sid] = JSON.parse(key);
      if (sid === sessionId) profiles.add(p);
    }
    for (const r of this.recent) if (r.id === sessionId) profiles.add(r.profile);
    if (profiles.size > 1) throw new Error("Session profile is ambiguous; select a profile.");
    return profiles.values().next().value || "default";
  }

  /** Profile-scoped live authority; omitted profile remains compatible for an unambiguous legacy SID. */
  nodeFor(sessionId, profile) {
    return this.nodes.get(sessionKey(this._profileOf(sessionId, profile), sessionId)) || null;
  }

  /** Runtime binding, explicit host metadata, then a unique native node; ambiguous identity stays unknown. */
  _sessionRef(rpcId, params = {}) {
    const reported = params.profile_name ?? params.profile ?? params.payload?.profile_name ?? params.payload?.profile;
    if (reported !== undefined && !validProfileParam(reported)) return { sid: null, profile: null };
    const bound = this.rpcToStored.get(rpcId);
    if (bound) return reported && reported !== bound.profile ? { sid: null, profile: null } : { ...bound };
    const nodes = [...this.nodes.values()].filter((n) => (n.sid === rpcId || n.rpcId === rpcId) && (!reported || n.profile === reported));
    if (nodes.length === 1) return { sid: nodes[0].sid, profile: nodes[0].profile };
    return { sid: null, profile: reported || null };
  }
}

/**
 * Read-only connection test for Settings: connect once, wait for the first snapshot, then list
 * sessions, which also proves the host plugin answers. Never sends a mutation; never retries.
 * Resolves {ok, code, text, sessions?, nodes?}.
 */
function probe(config, { timeoutMs = 30000, ...opts } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let nodes = 0;
    let gatewayRunning = null;
    const client = new BridgeClient(config, { ...opts, retry: false, keepalive: false, autoList: false });
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.removeAllListeners();
      client.stop().then(() => resolve(result));
    };
    const timer = setTimeout(() => finish({ ok: false, code: "timeout", text: i18nText("U0096") }), timeoutMs);
    client.on("snapshot", (snap) => {
      nodes = snap.nodes.length;
      gatewayRunning = snap.gateway.running;
    });
    client.on("status", (s) => {
      if (s.status === "setup" || s.status === "offline") {
        finish({ ok: false, code: s.code || "other", text: s.error || i18nText("U0097") });
        return;
      }
      if (s.status !== "open") return;
      client.sessions({ limit: 50 }).then(
        (rows) => {
          const gw = gatewayRunning === false ? i18nText("U0098") : "";
          finish({ ok: true, code: "ok", sessions: rows.length, nodes, text: i18nText("U0099", { length: rows.length, nodes: nodes, gw: gw }) });
        },
        (e) => {
          const m = String(e.message || e);
          if (/control (connection|reply) unavailable|endpoint unavailable|Unsupported .*control/i.test(m)) {
            finish({ ok: false, code: "plugin", text: i18nText("U0100") });
          } else finish({ ok: false, code: "list", text: i18nText("U0101", { v: m.slice(0, 200) }) });
        }
      );
    });
    client.start();
  });
}

function controllable(node) {
  return node.controlAvailable && !!node.turnId && Number.isSafeInteger(node.ownerPid) && node.ownerPid > 0;
}

function checkSid(sid) {
  if (typeof sid !== "string" || !SID_RE.test(sid)) throw new Error(i18nText("U0102"));
}

function checkSubagentId(id) {
  if (typeof id !== "string" || !SUBAGENT_ID_RE.test(id)) throw new Error(i18nText("U0047"));
}

function checkText(text, max) {
  if (typeof text !== "string" || !text.trim()) throw new Error(i18nText("U0103"));
  if (max && text.length > max) throw new Error(i18nText("A0034", { v: max.toLocaleString(i18nLocale()) }));
  return text;
}

module.exports = {
  BridgeClient,
  probe,
  TIMING,
  FRAME_LIMIT,
  PARAMS_LIMIT,
  METHODS,
  ATTACHMENTS,
  MODES,
  PROFILE_RE,
  SID_RE,
  validTarget,
  validPath,
  validName,
  configError,
  normalizeConfig,
  remoteCommand,
  shellPath,
  shellQuote,
  launchSpec,
  validHistoryRead,
  validModelSet,
  validReasoningSet,
  REASONING_EFFORTS,
  checkRequest,
  validStaged,
  STAGED_METHOD,
  rpcReply,
  isSnapshot,
  normalizeSnapshot,
  projectHistory,
  projectSessions,
  projectIndexRows,
  cleanTitle,
  validSessionIndex,
  validSessionUpdate,
  validSessionArchive,
  validSessionBranch,
  projectModelOptions,
  projectCommandCatalog,
  validCatalogRead,
  classifyFailure,
  BOT_CHAT_TITLE,
  AVATAR_LIMIT,
  projectProfiles,
  projectAvatar,
  projectPlan,
  projectToolCall,
  projectSubagents,
  projectSubagentTail,
  READS,
  MUTATIONS,
  MAX_TEXT,
};
