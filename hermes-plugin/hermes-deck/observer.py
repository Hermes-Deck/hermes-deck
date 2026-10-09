"""hermes-deck, bridge part: native Hermes observation and the local control socket.

The plugin entry point calls start();
a control socket that cannot start is logged and removed on unload.

In the Hermes process this module:
  - keeps metadata snapshots of the live sessions it observes (state, model, tool names, bounded titles,
    context use; never prompts, tool arguments or results) in <HERMES_HOME>/hermes-deck/processes/<pid>.json;
  - opens a private Unix socket <HERMES_HOME>/hermes-deck/control-<pid>-<id>.sock (mode 0600) that stream.py
    relays Hermes Deck's JSON-RPC requests to: native steer/redirect/interrupt of the running agent,
    read-only history, and an allowlist of Hermes' own TUI-gateway methods.
The stream discovers this runtime layout only.
"""
from __future__ import annotations

import importlib.util
import json
import logging
import os
import sys
import threading
import time
import weakref
import socket
import uuid
import contextvars
import hashlib
import shlex
import asyncio
import re
import base64
import binascii
import shutil
import stat as statmod
import tempfile
import math
from collections import OrderedDict
from contextlib import contextmanager, nullcontext
from pathlib import Path

logger = logging.getLogger(__name__)
SCHEMA = "hermes-deck.v1"
HOOKS = ("pre_llm_call", "pre_tool_call", "post_tool_call", "subagent_start", "subagent_stop", "on_session_end",
         "api_request_error", "pre_transcription")
# A turn that ends through an early return (provider retries exhausted, non-retryable client error, content policy
# block) never reaches finalize_turn, so Hermes fires no on_session_end for it. A node that still claims
# thinking/working is demoted once a real "no turn is running" signal (see Observer._turn_running) has held this long.
TURN_GRACE = 15.0
# TUI-gateway methods Hermes Deck's bridge (app/main/bridge.js) sends through the gateway socket.
# session.messages and native.* have their own handlers below; config.set is checked by allowed_request.
DECK_METHODS = {"session.create", "session.list", "session.resume", "session.interrupt", "prompt.submit", "request.answer",
                "model.options", "session.usage",
                # Botlar (the Deck's Hermes Desktop-style bot roster): two reads and one narrow write, each
                # constrained further by allowed_request / avatar_refusal below.
                "profiles.list", "profiles.get_asset", "session.title",
                # Delete one stored session from the rail's context menu (Hermes refuses a live one with 4023);
                # session.close first releases an idle runtime session this Deck resumed (also in DESK_METHODS).
                "session.delete", "session.close",
                # Session browser (all sessions of every profile): archive/unarchive one stored session and branch a
                # stored session into a new one (\"Continue here\" for a messaging-platform session). Both are
                # constrained further by allowed_request. deck.session_index / deck.session_rename have native
                # handlers below (like session.messages) and are not gateway methods.
                "session.archive", "session.branch_stored",
                # Sub-agent detail (the Deck's Agents tab): the roster and a live child's transcript tail (reads,
                # replies completed by enrich_subagent_reply), steer and interrupt (a click each). Hermes checks that
                # the child belongs to the caller's session; allowed_request checks the shapes.
                "subagent.list", "subagent.tail", "subagent.steer", "subagent.interrupt",
                # The composer's "/" suggestions: Hermes' own slash-command palette for one profile (a read; the
                # Deck never passes a session, so no runtime session is resumed for it). allowed_request checks it.
                "commands.catalog"}
# Also allowed so an existing Hermes Desk install keeps working against this plugin until Desk is retired.
DESK_METHODS = {"session.active_list", "session.close", "session.steer", "session.redirect",
                "session.events.since", "subagent.list", "subagent.interrupt", "subagent.steer", "subagent.tail",
                "approval.respond"}
ALLOWED_METHODS = DECK_METHODS | DESK_METHODS
LINEAGE_MAX = 512  # remembered subagent identities (a few KB each at most)
REASONING_LEVEL_RE = re.compile(r"^[a-z][a-z0-9_.-]{0,23}$")
# config.set reasoning values the Deck may send for one session (hermes_constants.parse_reasoning_effort words)
SESSION_REASONING_EFFORTS = frozenset({"none", "minimal", "low", "medium", "high", "xhigh", "max"})


def reasoning_effort_of(agent):
    """The reasoning level the live agent will request, as a short bounded label (or "").

    Hermes keeps it in ``agent.reasoning_config``: ``{"enabled": False}`` (thinking off) or
    ``{"enabled": True, "effort": "<level>"}``. A missing/empty config means "provider default", which is not a
    level we can name, so nothing is reported rather than a guess."""
    cfg = getattr(agent, "reasoning_config", None)
    if not isinstance(cfg, dict):
        return ""
    if cfg.get("enabled", True) is False:
        return "off"
    level = str(cfg.get("effort") or "").strip().lower()
    return level if REASONING_LEVEL_RE.match(level) else ""


def submit_appshot(request, dispatch, transport):
    """One user send: native image staging + submit on the same runtime id, no host paths exposed."""
    rid, p = request.get("id"), request.get("params", {})
    error = lambda message: {"jsonrpc": "2.0", "id": rid, "error": {"code": 4000, "message": message}}
    if (not isinstance(p, dict) or set(p) != {"session_id", "text", "content_base64", "filename"}
            or not isinstance(p["session_id"], str) or not re.fullmatch(r"[\x21-\x7e]{1,512}", p["session_id"])
            or not isinstance(p["text"], str) or not p["text"].strip() or len(p["text"]) > 32000
            or not isinstance(p["filename"], str) or not re.fullmatch(r"[^/\\\x00-\x1f]{1,160}\.(png|jpg|jpeg)", p["filename"], re.I)
            or not isinstance(p["content_base64"], str) or len(p["content_base64"]) > 1333336):
        return error("Invalid window attachment")
    try:
        blob = base64.b64decode(p["content_base64"], validate=True)
    except (ValueError, binascii.Error):
        return error("Invalid image bytes")
    if not 0 < len(blob) <= 1000000 or not (blob.startswith(b"\x89PNG\r\n\x1a\n") or blob.startswith(b"\xff\xd8\xff")):
        return error("Window attachment must be PNG/JPEG up to 1 MB")
    native = lambda method, params: dispatch({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}, transport=transport)
    attached = native("image.attach_bytes", {"session_id": p["session_id"], "content_base64": p["content_base64"], "filename": p["filename"]})
    if not isinstance(attached, dict) or "error" in attached:
        return attached if isinstance(attached, dict) else error("Hermes image attachment is unavailable")
    result = attached.get("result")
    if not isinstance(result, dict) or result.get("attached") is not True or not isinstance(result.get("path"), str):
        return error("Hermes did not accept the image")
    accepted = False
    try:
        response = native("prompt.submit", {"session_id": p["session_id"], "text": p["text"]})
        accepted = isinstance(response, dict) and "result" in response and "error" not in response
        return response if isinstance(response, dict) else error("Hermes submit is unavailable")
    finally:
        if not accepted:
            # A rejected submit must not leave pixels queued for the next unrelated text message.
            native("image.detach", {"session_id": p["session_id"], "path": result["path"]})


# --- deck.attach_submit: one user message with any number of files -------------------------------------------
# The Deck's composer attaches anything (images, video, text, PDF, archives...). Limits are enforced again by
# the Deck (app/main/media.js HERMES_*) and by stream.py's line limit; all three must agree.
ATTACH_MAX_FILES = 10
ATTACH_FILE_MAX = 25 * 1024 * 1024        # per file, decoded (Hermes' own image.attach_bytes cap)
ATTACH_TOTAL_MAX = 50 * 1024 * 1024       # all files of one message, decoded
ATTACH_TEXT_MAX = 32000
# One request line: base64 of the total plus names, text and the JSON envelope. Only this method may exceed 64 KiB.
ATTACH_LINE_MAX = ATTACH_TOTAL_MAX * 4 // 3 + 256 * 1024
ATTACH_METHOD = "deck.attach_submit"
ATTACH_DEFAULT_TEXT = "Please look at the attached file(s)."
_ATTACH_NAME = re.compile(r"[^/\\\x00-\x1f]{1,160}")
_IMAGE_MAGIC = ((b"\x89PNG\r\n\x1a\n", ".png"), (b"\xff\xd8\xff", ".jpg"), (b"GIF87a", ".gif"), (b"GIF89a", ".gif"))


def _image_ext(blob):
    """The extension of a real raster image by its first bytes, else None (anything else is an ordinary file)."""
    for magic, ext in _IMAGE_MAGIC:
        if blob.startswith(magic):
            return ext
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return ".webp"
    return None


def submit_attachments(request, dispatch, transport):
    """One user send with files, on one runtime id and with no host path exposed.

    Images are queued with Hermes' image.attach_bytes (the model sees the pixels). Every other file, PDFs
    included, is staged with file.attach and referenced in the prompt by the returned `@file:` ref_text, so the
    agent can open it with its tools (pdf.attach would turn a PDF into at most 25 low-fidelity page images and
    needs pdftoppm). A failure anywhere detaches the images already queued: they must never ride along with the
    next unrelated message. Files already staged on disk by file.attach stay there; nothing is queued for them."""
    rid, p = request.get("id"), request.get("params", {})
    error = lambda message: {"jsonrpc": "2.0", "id": rid, "error": {"code": 4000, "message": message}}
    if (not isinstance(p, dict) or set(p) != {"session_id", "text", "files"}
            or not isinstance(p["session_id"], str) or not re.fullmatch(r"[\x21-\x7e]{1,512}", p["session_id"])
            or not isinstance(p["text"], str) or len(p["text"]) > ATTACH_TEXT_MAX
            or not isinstance(p["files"], list) or not 0 < len(p["files"]) <= ATTACH_MAX_FILES):
        return error("Invalid attachment request")
    files, total = [], 0
    for entry in p["files"]:
        if (not isinstance(entry, dict) or set(entry) != {"filename", "content_base64"}
                or not isinstance(entry["filename"], str) or not _ATTACH_NAME.fullmatch(entry["filename"])
                or not entry["filename"].strip(". ")
                or not isinstance(entry["content_base64"], str)
                or len(entry["content_base64"]) > ATTACH_FILE_MAX * 4 // 3 + 4):
            return error("Invalid attachment")
        try:
            blob = base64.b64decode(entry["content_base64"], validate=True)
        except (ValueError, binascii.Error):
            return error("Attachment is not valid base64")
        total += len(blob)
        if not blob:
            return error("Attachment is empty: " + entry["filename"])
        if len(blob) > ATTACH_FILE_MAX:
            return error("Attachment too large (25 MB per file): " + entry["filename"])
        if total > ATTACH_TOTAL_MAX:
            return error("Attachments too large (50 MB per message)")
        files.append((entry["filename"], entry["content_base64"], blob))
    native = lambda method, params: dispatch({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}, transport=transport)
    sid, queued, refs = p["session_id"], [], []

    def undo():
        for path in queued:
            try:
                native("image.detach", {"session_id": sid, "path": path})
            except Exception:
                logger.warning("Hermes Deck bridge: could not detach a queued image", exc_info=True)

    try:
        for filename, b64, blob in files:
            ext = _image_ext(blob)
            if ext:
                stem = Path(filename).stem or "image"
                reply = native("image.attach_bytes", {"session_id": sid, "content_base64": b64, "filename": stem + ext})
                result = reply.get("result") if isinstance(reply, dict) else None
                if not isinstance(reply, dict) or "error" in reply:
                    undo()
                    return reply if isinstance(reply, dict) else error("Hermes image attachment is unavailable")
                if not isinstance(result, dict) or result.get("attached") is not True or not isinstance(result.get("path"), str):
                    undo()
                    return error("Hermes did not accept the image")
                queued.append(result["path"])
            else:
                reply = native("file.attach", {"session_id": sid, "name": filename,
                                               "data_url": "data:application/octet-stream;base64," + b64})
                result = reply.get("result") if isinstance(reply, dict) else None
                if not isinstance(reply, dict) or "error" in reply:
                    undo()
                    return reply if isinstance(reply, dict) else error("Hermes file attachment is unavailable")
                if (not isinstance(result, dict) or result.get("attached") is not True
                        or not isinstance(result.get("ref_text"), str) or not result["ref_text"].strip()):
                    undo()
                    return error("Hermes did not accept the file")
                refs.append(result["ref_text"].strip())
    except BaseException:
        undo()
        raise
    text = p["text"].strip() or ATTACH_DEFAULT_TEXT
    prompt = "\n\n".join([text] + ["\n".join(refs)] if refs else [text])
    accepted = False
    try:
        response = native("prompt.submit", {"session_id": sid, "text": prompt})
        accepted = isinstance(response, dict) and "result" in response and "error" not in response
        return response if isinstance(response, dict) else error("Hermes submit is unavailable")
    finally:
        if not accepted:
            undo()


# --- request size limits per method -------------------------------------------------------------------------
# One request is one line. Only the methods below may exceed 64 KiB: deck.appshot (a PNG/JPEG, up to 2 MiB),
# deck.attach_submit (files) and deck.transcribe (one dictation clip). stream.py keeps an equal copy of these
# numbers (it is installed on its own); test_voice_files.py checks that both agree.
TRANSCRIBE_METHOD = "deck.transcribe"
TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024      # one clip, decoded (the Deck caps a recording at 120 s: well under 1 MB)
TRANSCRIBE_LINE_MAX = TRANSCRIBE_MAX_BYTES * 4 // 3 + 64 * 1024
FRAME_MAX = 2 * 1024 * 1024
SMALL_LINE_MAX = 65536
APPSHOT_METHOD = "deck.appshot"
FILE_METHOD = "deck.file_read"
LINE_MAX = {ATTACH_METHOD: ATTACH_LINE_MAX, TRANSCRIBE_METHOD: TRANSCRIBE_LINE_MAX}


def request_limit(method):
    """The longest request line (bytes) a method may send."""
    if method in LINE_MAX:
        return LINE_MAX[method]
    return FRAME_MAX if method == APPSHOT_METHOD else SMALL_LINE_MAX


def line_refused(length, head):
    """True when a line must be dropped before it is parsed. `head`: its first bytes, where the method name sits
    (the Deck writes {"jsonrpc","id","method",...} in that order), so an oversize line of any other kind is
    never even decoded."""
    if length > max(LINE_MAX.values()):
        return True
    return length > FRAME_MAX and not any(name.encode() in head for name in LINE_MAX)


# --- deck.transcribe: dictation, transcribed by Hermes' own STT ----------------------------------------------
# {audio_base64, mime} -> {text, provider}. The clip is written to a private temp file that is always removed and
# handed to tools.transcription_tools.transcribe_audio (config `stt:` decides the provider: local faster-whisper,
# a cloud one...). One clip at a time per Hermes process (local Whisper is heavy), off the connection's reader
# thread so a long transcription never holds up an interrupt or an approval on the same connection.
TRANSCRIBE_TIMEOUT = 100.0     # seconds before the Deck gets an error; the Deck itself waits 120 s
_TRANSCRIBE_SLOT = threading.Semaphore(1)


def _audio_ext(blob):
    """The extension of an audio container by its first bytes, else None. The name the Deck gives and the mime
    it sends are never trusted: Hermes picks its decoder from the extension."""
    if blob[:4] == b"\x1a\x45\xdf\xa3":
        return ".webm"
    if blob[:4] == b"OggS":
        return ".ogg"
    if blob[:4] == b"RIFF" and blob[8:12] == b"WAVE":
        return ".wav"
    if blob[4:8] == b"ftyp":
        return ".m4a"
    if blob[:4] == b"fLaC":
        return ".flac"
    if blob[:3] == b"ID3" or blob[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return ".mp3"
    return None


TRANSCRIBE_LANGUAGE = re.compile(r"[a-z]{2,3}")


def _language_ok(value):
    """No hint (absent) is fine and means auto-detect; a hint is a short lowercase ISO 639 code, nothing else."""
    return value is None or (isinstance(value, str) and TRANSCRIBE_LANGUAGE.fullmatch(value) is not None)


def transcribe_language(request):
    """The validated language hint of a deck.transcribe request, or None (auto-detect). There is no default."""
    p = request.get("params", {})
    value = p.get("language") if isinstance(p, dict) else None
    return value if isinstance(value, str) and TRANSCRIBE_LANGUAGE.fullmatch(value) else None


# Language hints by clip path. Hermes' transcribe_audio() has no language argument (its `pre_transcription` plugin hook
# is the supported way to set one), so the clip's private temp path is registered here for the duration of the call and
# Observer.pre_transcription hands it back to Hermes. Only this plugin's own clips are in the map.
_LANGUAGE_HINTS = {}
_LANGUAGE_LOCK = threading.Lock()


@contextmanager
def _language_hint(path, language):
    with _LANGUAGE_LOCK:
        _LANGUAGE_HINTS[path] = language
    try:
        yield
    finally:
        with _LANGUAGE_LOCK:
            _LANGUAGE_HINTS.pop(path, None)


def pre_transcription_hint(file_path="", **_):
    """Hermes `pre_transcription` hook: {"language": hint} for a Deck clip that carries one, else None (untouched)."""
    with _LANGUAGE_LOCK:
        language = _LANGUAGE_HINTS.get(str(file_path))
    return {"language": language} if language else None


def parse_transcribe(request):
    """(blob, ext, None) for a valid deck.transcribe request, else (None, None, error reply)."""
    rid, p = request.get("id"), request.get("params", {})
    error = lambda message: (None, None, {"jsonrpc": "2.0", "id": rid, "error": {"code": 4000, "message": message}})
    if (not isinstance(p, dict) or not {"audio_base64", "mime"} <= set(p) <= {"audio_base64", "mime", "language"}
            or not isinstance(p["mime"], str) or not _language_ok(p.get("language"))
            or not re.fullmatch(r"(audio|video)/[A-Za-z0-9.+-]{1,40}(;[ -~]{0,80})?", p["mime"])
            or not isinstance(p["audio_base64"], str) or not p["audio_base64"]
            or len(p["audio_base64"]) > TRANSCRIBE_MAX_BYTES * 4 // 3 + 4):
        return error("Invalid dictation request")
    try:
        blob = base64.b64decode(p["audio_base64"], validate=True)
    except (ValueError, binascii.Error):
        return error("Dictation audio is not valid base64")
    if not blob:
        return error("The recording is empty")
    if len(blob) > TRANSCRIBE_MAX_BYTES:
        return error("The recording is too large (25 MB at most)")
    ext = _audio_ext(blob)
    if ext is None:
        return error("Unsupported audio format")
    return blob, ext, None


@contextmanager
def profile_secret_scope(home):
    """Bind this profile's secret scope on the current (bare) thread. A multiplexing gateway
    (gateway.multiplex_profiles) fails closed on a credential read from a thread without a scope
    (UnscopedSecretError), and a cloud STT provider reads its API key. Same binding as events.py's quota
    worker; a no-op on a Hermes without secret scoping, or when a scope is already bound."""
    token = None
    try:
        from agent import secret_scope
        if secret_scope.current_secret_scope() is None:
            token = secret_scope.set_secret_scope(secret_scope.build_profile_secret_scope(Path(home)),
                                                  profile_home=str(home))
    except Exception:
        token = None
    try:
        yield
    finally:
        if token is not None:
            try:
                from agent import secret_scope
                secret_scope.reset_secret_scope(token)
            except Exception:
                logger.warning("Hermes Deck bridge: could not reset the secret scope", exc_info=True)


def _hermes_transcribe(path, language=None):
    """Hermes' STT for one clip. `language` (an explicit hint from the Deck) rides Hermes' public
    `pre_transcription` plugin hook: the hook may set `language` and the dispatcher passes it to the backend, so no
    private API is touched. The hint is scoped to this clip's temp file (the hook receives file_path), so concurrent
    Hermes transcriptions elsewhere never see it. Without a hint nothing is set and `stt.language` (auto-detect when
    empty) decides, exactly as before."""
    from tools.transcription_tools import transcribe_audio
    if not language:
        return transcribe_audio(path, source="deck")
    with _language_hint(path, language):
        return transcribe_audio(path, source="deck")


def _hermes_home():
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def run_transcription(blob, ext, transcribe=None, home=None, language=None):
    """Transcribe one clip; the temp file (0600, in a 0700 directory) is removed whatever happens. Returns
    Hermes' result dict ({success, transcript, error?, provider?})."""
    directory = tempfile.mkdtemp(prefix="hermes-deck-stt-")
    try:
        path = os.path.join(directory, "dictation" + ext)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(blob)
        with profile_secret_scope(home if home is not None else _hermes_home()):
            if language:
                return (transcribe or _hermes_transcribe)(path, language=language)
            return (transcribe or _hermes_transcribe)(path)
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def transcription_reply(rid, result):
    """The JSON-RPC reply for Hermes' transcribe_audio result. Provider errors are short and bounded; they can
    name a missing key or a disabled STT, which is what the owner needs to fix it."""
    if isinstance(result, dict) and result.get("success") and isinstance(result.get("transcript"), str):
        return {"jsonrpc": "2.0", "id": rid, "result": {
            "text": result["transcript"].strip()[:32000], "provider": str(result.get("provider") or "")[:40]}}
    detail = result.get("error") if isinstance(result, dict) else None
    detail = re.sub(r"[\x00-\x1f\x7f]+", " ", detail).strip()[:300] if isinstance(detail, str) else ""
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": 4074, "message": detail or "Transcription failed"}}


def start_transcription(request, write, transcribe=None, home=None, timeout=None):
    """Handle a deck.transcribe request: validate here, transcribe on a worker thread, answer once through
    `write` (a result, an error, or a timeout, whichever comes first). The slot is held until the worker really
    ends, so a stuck transcription never lets another one pile up behind it."""
    blob, ext, refused = parse_transcribe(request)
    if refused:
        return write(refused)
    rid, language = request.get("id"), transcribe_language(request)
    if not _TRANSCRIBE_SLOT.acquire(blocking=False):
        return write({"jsonrpc": "2.0", "id": rid, "error": {"code": 4073, "message": "Another dictation is being transcribed"}})
    answered, lock = [False], threading.Lock()

    def answer(reply):
        with lock:
            if answered[0]:
                return
            answered[0] = True
        timer.cancel()
        write(reply)

    def work():
        try:
            answer(transcription_reply(rid, run_transcription(blob, ext, transcribe=transcribe, home=home, language=language)))
        except BaseException:
            logger.warning("Hermes Deck bridge: dictation failed", exc_info=True)
            answer({"jsonrpc": "2.0", "id": rid, "error": {"code": 4074, "message": "Transcription failed"}})
        finally:
            _TRANSCRIBE_SLOT.release()

    timer = threading.Timer(TRANSCRIBE_TIMEOUT if timeout is None else timeout, lambda: answer(
        {"jsonrpc": "2.0", "id": rid, "error": {"code": 4074, "message": "Transcription timed out"}}))
    timer.daemon = True
    timer.start()
    threading.Thread(target=work, name="hermes-deck-stt", daemon=True).start()


# --- deck.file_read: files the agent offered in a session, to the Deck's download -----------------------------
# {session_id, path, offset, length, profile?} -> {name, size, mtime, offset, length, eof, data (base64)}.
# This is a file-read capability of the agent host, so it is narrow:
#   * the path must stand verbatim in an assistant message of that session's stored transcript (read-only):
#     the Deck can only fetch what the agent named;
#   * the real path must not be a credential or state location (denylist below, plus Hermes' own read guard when
#     this Hermes has one), the final component must not be a symlink, and it must be a regular file;
#   * a path the session's USER message names as an `@image:` / `@file:` directive line (what Hermes stores for
#     an attachment, whatever platform it came from) is readable too, but only below a Hermes attachment
#     directory (images/, attachments/, cache/images, cache/documents, ... of a Hermes home) and, for `@image:`,
#     only when the bytes are a real raster image. Anyone who can message the agent can type such a line, so this
#     second grant is narrower than the first (see user_ref_refusal);
#   * at most FILE_SIZE_MAX per file, FILE_CHUNK_MAX per call, and a per-connection rate budget;
#   * the file is opened with O_NOFOLLOW and pinned (device, inode, size, mtime) when first granted: a file
#     replaced or changed during a download is refused instead of delivered half old, half new.
FILE_CHUNK_MAX = 1024 * 1024
FILE_SIZE_MAX = 200 * 1024 * 1024
FILE_SCAN_PAGE, FILE_SCAN_PAGES = 100, 50          # newest 5,000 messages of the session are searched
FILE_GRANT_TTL, FILE_GRANTS_MAX = 600.0, 128
FILE_RATE_WINDOW, FILE_RATE_CALLS, FILE_RATE_BYTES = 60.0, 600, 512 * 1024 * 1024
_FILE_PATH = re.compile(r"/[^\x00-\x1f\x7f]{0,4094}")
_PATH_BEFORE = set(" \t\r\n`'\"([<{*_:>|,;=")
_PATH_AFTER = set(" \t\r\n`'\")]>}*_,;:!?|")
# names a download never serves, wherever they are
_DENY_COMPONENTS = {".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".gcloud", ".config", ".mozilla",
                    ".password-store", ".gnome-keyring", "keyrings", "keychains", ".hermes-deck", ".netrc"}
_DENY_PREFIXES = ("/etc", "/proc", "/sys", "/dev", "/boot", "/run/secrets", "/var/lib", "/var/log", "/var/run")
_DENY_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".kdbx", ".jks", ".keystore", ".ppk", ".pgp", ".asc")
_DENY_NAMES = {".netrc", ".pgpass", ".npmrc", ".pypirc", ".git-credentials", ".htpasswd", ".envrc", "shadow",
               "gshadow", "authorized_keys", "credentials", "credentials.json", "client_secret.json",
               "secrets.json", "secrets.yaml", "secrets.yml", "service-account.json"}
_DENY_NAME_PREFIXES = ("id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "client_secret")
_ENV_OK = {".env.example", ".env.sample", ".env.template", ".env.dist"}
# under every Hermes home (the active home, the root and each profile)
_HERMES_DENY = {".env", "auth.json", "auth.lock", ".anthropic_oauth.json", "config.yaml", "webhook_subscriptions.json",
                "google_token.json", "google_oauth_pending.json", "state.db", "state.db-wal", "state.db-shm",
                "state.db-journal", "kanban.db", "kanban.db-wal", "kanban.db-shm", "kanban.db-journal",
                "auth", "credentials", "pairing", "mcp-tokens", "vault", "sessions", "browser-profile", "hermes-deck"}


class FileError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


def path_offered(text, path):
    """True when `path` stands in `text` as a whole path: after the start, whitespace, a quote/backtick, a bracket
    or `MEDIA:`, and before the end, whitespace, a quote/backtick, a closing bracket or sentence punctuation.
    /a/b.txt does not offer /a/b."""
    start = 0
    while True:
        at = text.find(path, start)
        if at < 0:
            return False
        before = text[at - 1] if at else " "
        end = at + len(path)
        after = text[end] if end < len(text) else " "
        if after == "." and (end + 1 >= len(text) or text[end + 1] in _PATH_AFTER):
            after = " "
        if before in _PATH_BEFORE and after in _PATH_AFTER:
            return True
        start = at + 1


# One directive line as Hermes persists it (agent/context_references.format_reference_value): bare, `x`, "x" or 'x'.
_USER_REF_LINE = re.compile(r"@(image|file):(`[^`\n]+`|\"[^\"\n]+\"|'[^'\n]+'|\S+)", re.IGNORECASE)
# The native-vision form of the same attachment (tui_gateway/session_history.py _IMAGE_HINT_RE).
_USER_HINT_LINE = re.compile(r"\[Image attached at: ([^\n\]]+)\]")
# Directories of a Hermes home that hold files Hermes itself stored for attachments (tui_gateway/prompt_attachments.py,
# gateway/platforms/base.py caches, including the legacy names get_hermes_dir still honours).
_ATTACHMENT_DIRS = ("images", "attachments", "cache/images", "cache/documents", "image_cache", "document_cache",
                    "cache/screenshots", "browser_screenshots")


def user_refs(text):
    """{absolute path: "image" | "file"} for every line of a user message that is exactly one `@image:` or `@file:`
    directive. An image directive wins when a path is named both ways. Relative refs name nothing the host could read."""
    found = {}
    for line in str(text).splitlines():
        hint = _USER_HINT_LINE.fullmatch(line.strip())
        if hint:
            path = hint.group(1).strip()
            if path.startswith("/") and _FILE_PATH.fullmatch(path):
                found[path] = "image"
            continue
        match = _USER_REF_LINE.fullmatch(line.strip())
        if not match:
            continue
        value = match.group(2)
        path = value[1:-1] if value[0] in "`\"'" else value
        if path.startswith("/") and _FILE_PATH.fullmatch(path):
            kind = match.group(1).lower()
            found[path] = "image" if found.get(path) == "image" else kind
    return found


def attachment_dirs(roots=None):
    """The resolved attachment directories of every Hermes home (read at call time)."""
    out = []
    for root in (_hermes_roots() if roots is None else roots):
        for sub in _ATTACHMENT_DIRS:
            try:
                resolved = os.path.realpath(os.path.join(str(root), sub))
            except (OSError, ValueError):
                continue
            if resolved not in out:
                out.append(resolved)
    return out


def user_ref_refusal(real, kind, fd, roots=None):
    """Why a file named only by a user's `@image:` / `@file:` line may not be read, or None."""
    if not any(real.startswith(d + "/") for d in attachment_dirs(roots)):
        return "outside the Hermes attachment folders"
    if kind == "image" and _image_ext(os.pread(fd, 16, 0)) is None:
        return "not a raster image"
    return None


def _message_text(message):
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b if isinstance(b, str) else b["text"] for b in content
                         if isinstance(b, str) or (isinstance(b, dict) and isinstance(b.get("text"), str)
                                                   and b.get("type", "text") in ("text", "output_text")))
    return ""


def _hermes_roots():
    """Every Hermes home: the active one, the shared root and each profile (read at call time)."""
    roots = []
    try:
        from hermes_constants import get_default_hermes_root, get_hermes_home
        for getter in (get_hermes_home, get_default_hermes_root):
            roots.append(Path(getter()))
        for entry in sorted((roots[-1] / "profiles").iterdir()):
            roots.append(entry)
    except Exception:
        pass
    out = []
    for root in roots:
        try:
            resolved = root.resolve()
        except (OSError, RuntimeError):
            continue
        if resolved not in out:
            out.append(resolved)
    return out


def file_refusal(real, roots=None):
    """Why a resolved absolute path may never be downloaded, or None. A denylist is defense in depth (the agent can
    already read what its user can): it stops a prompt-injected agent from using the Deck to carry credentials."""
    path = str(real)
    parts = Path(path).parts[1:]
    name = parts[-1].lower() if parts else ""
    if any(path == p or path.startswith(p + "/") for p in _DENY_PREFIXES):
        return "system location"
    if any(part.lower() in _DENY_COMPONENTS for part in parts):
        return "credential location"
    if name in _DENY_NAMES or name.endswith(_DENY_SUFFIXES) or name.startswith(_DENY_NAME_PREFIXES):
        return "credential file"
    if (name == ".env" or name.startswith(".env.")) and name not in _ENV_OK:
        return "credential file"
    for root in (_hermes_roots() if roots is None else roots):
        root = str(root)
        if path == root or not path.startswith(root + "/"):
            continue
        rel = path[len(root) + 1:]
        segments = rel.split("/")
        if segments[0] == "profiles" and len(segments) > 2:      # <root>/profiles/<name>/...: the profile's own home
            rel = "/".join(segments[2:])
        first = rel.split("/", 1)[0]
        if first in _HERMES_DENY or rel in ("cache/bws_cache.json", "cache/bws_cache.enc.json"):
            return "Hermes state"
        if rel.startswith("skills/.hub"):
            return "Hermes state"
    if roots is None:
        try:
            from agent.file_safety import get_read_block_error
            if get_read_block_error(path):
                return "Hermes read guard"
        except ImportError:
            pass
        except Exception:
            return "Hermes read guard"
    return None


def _db_messages(profile, sid, limit, offset):
    """One page of a stored session's messages, newest first (read-only); None when the session does not exist."""
    if profile != "default":
        from hermes_constants import get_default_hermes_root
        if not (Path(get_default_hermes_root()) / "profiles" / profile).is_dir():
            return None
    from hermes_cli.web_routers import sessions

    def read(db):
        if db.get_session(sid) is None:
            return None
        # the same tip Hermes' own history read shows (a compressed session continues in a child)
        resolve = getattr(db, "resolve_resume_session_id", None)
        tip = resolve(sid) if callable(resolve) else sid
        return db.get_messages(tip or sid, limit=limit, offset=offset, latest=True, include_ancestors=True)
    return sessions._with_db(profile, read, read_only=True)


class ReadBudget:
    """Calls and bytes one control connection may spend on deck.file_read in a rolling window."""

    def __init__(self, clock=time.monotonic, window=FILE_RATE_WINDOW, calls=FILE_RATE_CALLS, size=FILE_RATE_BYTES):
        self.clock, self.window, self.calls, self.size = clock, window, calls, size
        self.log = []                                   # (time, bytes)

    def allow(self):
        now = self.clock()
        self.log = [e for e in self.log if now - e[0] < self.window]
        return len(self.log) < self.calls and sum(e[1] for e in self.log) < self.size

    def spend(self, nbytes):
        self.log.append((self.clock(), nbytes))


class FileReader:
    """deck.file_read: authorization against the session transcript, the path checks and one chunk read."""

    def __init__(self, load_messages=None, roots=None, clock=time.monotonic):
        self.load, self.roots, self.clock = load_messages or _db_messages, roots, clock
        self.grants, self.lock = OrderedDict(), threading.Lock()

    @staticmethod
    def check(params):
        keys = {"session_id", "path", "offset", "length"}
        if (not isinstance(params, dict) or not keys <= set(params) or set(params) - keys - {"profile"}
                or not isinstance(params["session_id"], str) or not re.fullmatch(r"[\x21-\x7e]{1,512}", params["session_id"])
                or not isinstance(params["path"], str) or not _FILE_PATH.fullmatch(params["path"])
                or type(params["offset"]) is not int or params["offset"] < 0 or params["offset"] > FILE_SIZE_MAX
                or type(params["length"]) is not int or not 1 <= params["length"] <= FILE_CHUNK_MAX
                or ("profile" in params and (not isinstance(params["profile"], str)
                                             or not PROFILE_NAME.fullmatch(params["profile"])))):
            raise FileError(4000, "Invalid file request")
        return params["session_id"], params["path"], params.get("profile", "default")

    def offered(self, profile, sid, path):
        """How this session's transcript authorizes `path`: "agent" (an assistant message named it), "image" / "file"
        (only a user message did, as an `@image:` / `@file:` directive line: the narrower grant), or None."""
        user = None
        for page in range(FILE_SCAN_PAGES):
            rows = self.load(profile, sid, FILE_SCAN_PAGE, page * FILE_SCAN_PAGE)
            if rows is None:
                raise FileError(4081, "Persisted session not found")
            for message in rows:
                if not isinstance(message, dict):
                    continue
                if message.get("role") == "assistant" and path_offered(_message_text(message), path):
                    return "agent"
                if message.get("role") == "user" and user != "image":
                    user = user_refs(_message_text(message)).get(path) or user
            if len(rows) < FILE_SCAN_PAGE:
                break
        return user

    def read(self, params):
        sid, path, profile = self.check(params)
        key = (profile, sid, path)
        denied = FileError(4080, "Hermes Deck cannot download this file")
        if not path.startswith("/"):
            raise denied
        try:
            if stat_is_link(path):
                raise denied
            real = os.path.realpath(path)
            if file_refusal(path if path == os.path.normpath(path) else os.path.normpath(path), self.roots) or file_refusal(real, self.roots):
                raise denied
            fd = os.open(real, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0))
        except FileError:
            raise
        except OSError:
            raise FileError(4082, "The file is not there (any more)")
        try:
            info = os.fstat(fd)
            if not statmod.S_ISREG(info.st_mode):
                raise FileError(4082, "Not a regular file")
            if info.st_size > FILE_SIZE_MAX:
                raise FileError(4083, "The file is too large to download (200 MB at most)")
            pin = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
            now = self.clock()
            with self.lock:
                grant = self.grants.get(key)
                if grant is not None and now > grant[1]:
                    self.grants.pop(key, None)
                    grant = None
            if grant is not None:
                via = grant[2]
                # A continuation chunk of a changed file is refused; a new download (offset 0, also the Deck's
                # one-byte size probe) simply pins the file as it is now: the offer in the transcript still stands.
                if grant[0] != pin and params["offset"] > 0:
                    with self.lock:
                        self.grants.pop(key, None)
                    raise FileError(4084, "The file changed while it was being downloaded")
            else:
                via = self.offered(profile, sid, path)
                if via is None:
                    raise FileError(4081, "This file was not offered in this session")
            if via != "agent" and user_ref_refusal(real, via, fd, self.roots):
                # named only by a user's directive line: the narrow grant (attachment folders, real images) applies
                # to the bytes of every read, so a file swapped after the first chunk is refused too
                raise denied
            with self.lock:
                self.grants[key] = (pin, now + FILE_GRANT_TTL, via)
                self.grants.move_to_end(key)
                while len(self.grants) > FILE_GRANTS_MAX:
                    self.grants.popitem(last=False)
            offset = min(params["offset"], info.st_size)
            data = os.pread(fd, min(params["length"], info.st_size - offset), offset)
        finally:
            os.close(fd)
        return {"name": os.path.basename(real)[:255], "size": info.st_size, "mtime": info.st_mtime, "offset": offset,
                "length": len(data), "eof": offset + len(data) >= info.st_size, "data": base64.b64encode(data).decode("ascii")}


def stat_is_link(path):
    try:
        return statmod.S_ISLNK(os.lstat(path).st_mode)
    except OSError:
        return False


def file_reply(request, reader, budget):
    rid = request.get("id")
    try:
        if not budget.allow():
            raise FileError(4085, "Too many file requests; try again in a minute")
        result = reader.read(request.get("params", {}))
        budget.spend(result["length"])
        return {"jsonrpc": "2.0", "id": rid, "result": result}
    except FileError as exc:
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": exc.code, "message": exc.message}}
    except Exception:
        logger.warning("Hermes Deck bridge: file read unavailable", exc_info=True)
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": 5000, "message": "Hermes file read unavailable"}}


# The canonical per-bot chat of Hermes Desktop's Bot Mode: the session titled exactly this in a profile's
# state.db. session.title may set nothing else.
BOT_CHAT_TITLE = "Bot Chat"
# profiles.get_asset answers one data: URL in one reply line; stream.py and the Deck drop the whole connection
# on a line over 2 MiB. Hermes accepts avatars up to 2 MB (about 2.67 MB as base64), so bigger files are
# refused here before dispatch: 1 MB of image is about 1.33 MB of base64, which always fits.
AVATAR_MAX_BYTES = 1_000_000
# The longest profiles.get_asset reply line written to the Deck: a cap-sized avatar as base64 plus the JSON
# envelope. Still well under the 2 MiB line limit.
AVATAR_REPLY_MAX = AVATAR_MAX_BYTES * 4 // 3 + 4096
# An avatar request whose reply never came frees its connection's slot after this long.
AVATAR_STALE_SECONDS = 60.0
AVATAR_EXTS = ("png", "jpg", "webp")  # Hermes' own lookup order (tui_gateway/methods_profiles.py _ASSET_EXTS)
PROFILE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")


# --- session browser: deck.session_index (read) and deck.session_update (rename / pin) ------------------------
# session.list has no paging, no last-activity field, no archived view and no pin flag, and session.title needs a
# live runtime session. So the browser reads one page of a profile's stored sessions through Hermes' own
# list_sessions_rich (read-only handle, the REST listing's query) and writes a title or a pin on one stored row
# through the same SessionDB setters the REST PATCH uses. Neither takes anything but the parameters checked here.
INDEX_METHOD = "deck.session_index"
UPDATE_METHOD = "deck.session_update"
INDEX_LIMIT_MAX = 100
INDEX_OFFSET_MAX = 100_000
INDEX_DENIED_SOURCES = ("kanban", "tool", "oneshot")  # Hermes' INTERNAL_LISTING_SOURCES: never human-facing
TITLE_MAX = 100                                        # SessionDB.MAX_TITLE_LENGTH
_TITLE_FORBIDDEN = re.compile("[\\x00-\\x1f\\x7f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\ufeff]")
_SID_VALUE = re.compile(r"[\x21-\x7e]{1,512}")


def _sid_ok(value):
    return isinstance(value, str) and bool(_SID_VALUE.fullmatch(value))


def _profile_ok(params):
    return "profile" not in params or (isinstance(params["profile"], str) and bool(PROFILE_NAME.fullmatch(params["profile"])))


def _clean_title(value):
    """The title as Hermes would store it (whitespace collapsed), or None when it is not an acceptable one."""
    if not isinstance(value, str):
        return None
    cleaned = re.sub(r"\s+", " ", value).strip()  # line breaks and tabs become one space, as Hermes stores them
    if _TITLE_FORBIDDEN.search(cleaned):
        return None
    return cleaned if cleaned and len(cleaned) <= TITLE_MAX and cleaned != BOT_CHAT_TITLE else None


def _profile_db(profile, fn, read_only):
    if profile != "default":
        from hermes_constants import get_default_hermes_root
        if not (Path(get_default_hermes_root())/"profiles"/profile).is_dir():
            raise ValueError("Unknown Hermes profile")
    from hermes_cli.web_routers import sessions
    return sessions._with_db(profile, fn, read_only=read_only)


_LAST_PREVIEW_MAX = 200
_LAST_PREVIEW_SQL = (
    "SELECT s.id AS sid, (SELECT m.role || char(31) || SUBSTR(m.content, 1, 1600) FROM messages m"
    " WHERE m.session_id = s.id AND m.role IN ('user', 'assistant') AND m.content IS NOT NULL"
    " AND TRIM(m.content) <> ''{hidden} ORDER BY m.timestamp DESC, m.id DESC LIMIT 1) AS last"
    " FROM sessions s WHERE s.id IN ({marks})")
_CONTEXT_BLOCK = re.compile(r"<([a-z][a-z0-9_-]{0,40}-context)>[\s\S]*?</\1>", re.IGNORECASE)
_MD_NOISE = re.compile(r"[`*_#>~|]+")


def shape_last_preview(text):
    """One short line for the newest message: injected context blocks and markdown marks dropped, whitespace
    collapsed, cut to 200 characters."""
    text = _CONTEXT_BLOCK.sub(" ", str(text or ""))
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\s+", " ", _MD_NOISE.sub("", text)).strip()
    return text[:_LAST_PREVIEW_MAX - 1] + "…" if len(text) > _LAST_PREVIEW_MAX else text


def last_previews(db, ids):
    """{session id: (role, preview)} of each session's newest user/assistant message: ONE bounded query over the
    page's ids on the same read-only handle. Tool and system rows are skipped. Any failure (an older Hermes
    schema, a handle without raw reads) yields {} so the list still works with the first-message `preview`."""
    ids = [i for i in ids if _sid_ok(i)][:2 * INDEX_LIMIT_MAX]
    reader = getattr(db, "_read_all", None)
    if not ids or reader is None:
        return {}
    marks = ",".join("?" for _ in ids)
    for hidden in (" AND COALESCE(m.display_kind, '') <> 'hidden'", ""):
        try:
            rows = reader(_LAST_PREVIEW_SQL.format(hidden=hidden, marks=marks), tuple(ids))
        except Exception:
            continue
        out = {}
        for row in rows:
            sid, last = row[0], row[1]
            if not isinstance(last, str) or "\x1f" not in last:
                continue
            role, _, body = last.partition("\x1f")
            shaped = shape_last_preview(body)
            if shaped:
                out[sid] = (role, shaped)
        return out
    return {}


def session_index(params, with_db=None):
    """One page of a profile's human-facing stored sessions, most recently active first: {sessions, has_more}.
    params: profile, archived ("exclude" | "only"), limit (1-100), offset. Hidden rows, Bot Chats, subagent runs and
    Hermes' internal sources are never listed."""
    with_db = with_db or _profile_db
    if not isinstance(params, dict) or set(params) - {"profile", "archived", "limit", "offset"} or not _profile_ok(params):
        raise ValueError("Unsupported session index parameter")
    profile, archived = params.get("profile", "default"), params.get("archived", "exclude")
    limit, offset = params.get("limit", INDEX_LIMIT_MAX), params.get("offset", 0)
    if archived not in ("exclude", "only"):
        raise ValueError("archived must be exclude or only")
    if type(limit) is not int or not 1 <= limit <= INDEX_LIMIT_MAX or type(offset) is not int or not 0 <= offset <= INDEX_OFFSET_MAX:
        raise ValueError("Invalid session index paging")
    only = archived == "only"

    def read(db):
        return db.list_sessions_rich(
            limit=limit, offset=offset, order_by_last_active=True, compact_rows=True,
            include_pinned=offset == 0 and not only, exclude_sources=list(INDEX_DENIED_SOURCES), archived_only=only)

    def read_with_last(db):
        page = read(db) or []
        return page, last_previews(db, [r.get("id") for r in page if isinstance(r, dict)])

    page = with_db(profile, read_with_last, True)
    rows, last = page if isinstance(page, tuple) else (page or [], {})
    out = []
    for row in rows[:2 * INDEX_LIMIT_MAX]:  # a page, plus the pins Hermes back-fills onto the first one
        if not isinstance(row, dict) or not _sid_ok(row.get("id")):
            continue
        source = str(row.get("source") or "")[:48]
        if source.strip().lower() in INDEX_DENIED_SOURCES:
            continue
        stamp = lambda key: float(row.get(key) or 0) if isinstance(row.get(key), (int, float)) else 0.0
        out.append({
            "id": row["id"], "title": str(row.get("title") or "")[:160], "preview": str(row.get("preview") or "")[:200],
            "source": source, "started_at": stamp("started_at"), "last_active": stamp("last_active") or stamp("started_at"),
            "message_count": int(row.get("message_count") or 0) if isinstance(row.get("message_count"), (int, float)) else 0,
            "archived": bool(row.get("archived")), "pinned": bool(row.get("pinned")), "profile": profile})
        if row["id"] in last:  # newest message; `preview` stays the first one for older clients
            out[-1]["last_role"], out[-1]["last_preview"] = last[row["id"]]
    return {"sessions": out, "has_more": len(rows) >= limit}


def session_update(params, with_db=None):
    """Rename (user provenance) and/or pin one stored session: {ok, title, pinned}. params: session_id, profile,
    title (1-100 characters, no control characters, never the canonical "Bot Chat"), pinned (boolean)."""
    with_db = with_db or _profile_db
    if not isinstance(params, dict) or set(params) - {"session_id", "profile", "title", "pinned"} or not _profile_ok(params):
        raise ValueError("Unsupported session update parameter")
    sid, profile = params.get("session_id"), params.get("profile", "default")
    if not _sid_ok(sid):
        raise ValueError("A persisted session ID is required")
    if "title" not in params and "pinned" not in params:
        raise ValueError("Nothing to update")
    title = None
    if "title" in params:
        title = _clean_title(params["title"])
        if title is None:
            raise ValueError("Invalid title")
    if "pinned" in params and type(params["pinned"]) is not bool:
        raise ValueError("pinned must be a boolean")

    def write(db):
        row = db.get_session(sid)
        if not row:
            raise ValueError("Persisted session not found")
        if title is not None and (row.get("title") or "") == BOT_CHAT_TITLE:
            raise ValueError("A bot's Bot Chat cannot be renamed")
        if title is not None:
            db.set_session_title(sid, title)
        if "pinned" in params:
            db.set_session_pinned(sid, params["pinned"])
        after = db.get_session(sid) or row
        return {"ok": True, "title": str(after.get("title") or ""), "pinned": bool(after.get("pinned"))}

    return with_db(profile, write, False)


def session_reply(request, fn, with_db=None):
    """A JSON-RPC reply for deck.session_index / deck.session_update: a result, or an error that names the problem."""
    rid = request.get("id")
    try:
        return {"jsonrpc": "2.0", "id": rid, "result": fn(request.get("params", {}), with_db)}
    except ValueError as exc:
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": 4000, "message": str(exc)[:300]}}
    except Exception:
        logger.warning("Hermes Deck bridge: session browser request unavailable", exc_info=True)
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": 5000, "message": "Hermes session store unavailable"}}


# --- deck.reasoning_view: "Show thinking" for the sessions Hermes Deck drives ---------------------------------------
# Hermes streams reasoning.delta / reasoning.available only for a gateway session whose show_reasoning flag is on
# (tui_gateway server._session_show_reasoning). Its own switch, config.set {key: "reasoning", value: "show"}, also
# rewrites display.show_reasoning in config.yaml for every surface, so the Deck does not use it. This method flips the
# in-memory flag of ONE runtime session, and only of a session this plugin's control socket created or resumed
# (its event transport is this socket's fanout): never a TUI, desktop or messaging-platform session, never a file.
REASONING_METHOD = "deck.reasoning_view"


def _owned_by(transport, owner):
    """Whether a session's event transport is this control socket's: the fanout itself (the Deck created or resumed it
    alone), or a shared fanout that carries one of its peers. When the session is also open in another live client,
    Hermes attaches the Deck by flattening our fanout into its peers next to that client
    (tui_gateway/session_transports.py _attach_session_transport), so identity alone misses those sessions."""
    if owner is None or transport is None:
        return False
    if transport is owner:
        return True
    peers = getattr(owner, "transports", None)
    contains = getattr(transport, "contains", None)
    if not callable(peers) or not callable(contains):
        return False
    try:
        mine = peers()
        return isinstance(mine, (list, tuple)) and any(contains(peer) for peer in mine)
    except Exception:
        return False


TAKEOVER_METHOD = "deck.takeover"


def takeover_reply(request, owner, emit, server=None):
    """Explicit, profile-exact live transport transfer; a cold resume reports restarted.

    Never edits an active-session lease or kills a process. Unsupported foreign runtime
    owners remain fenced by Hermes' own resume checks rather than admitting two writers.
    """
    rid, params = request.get("id"), request.get("params", {})
    def error(code, message):
        emit({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}})
    if (not isinstance(params, dict) or set(params) != {"session_id", "profile"}
            or not _sid_ok(params.get("session_id")) or not _profile_ok(params)):
        return error(4000, "Invalid takeover request")
    if server is None:
        from tui_gateway import server
    try:
        home = server._profile_home(params["profile"])
        home = str(home) if home is not None else None
        legacy = None
        with getattr(server, "_session_resume_lock", threading.RLock()):
            with server._sessions_lock:
                matches = [(sid, record) for sid, record in server._sessions.items()
                           if isinstance(record, dict) and (record.get("profile_home") or None) == home
                           and (record.get("session_key") == params["session_id"] or sid == params["session_id"])]
                if len(matches) > 1:
                    return error(4000, "Ambiguous takeover target")
                if matches:
                    sid, record = matches[0]
                    if "transport" in record and not record.get("_client_gone_interrupt_requested"):
                        # Events dereference this slot while the worker runs. No agent/turn mutation.
                        record["transport"] = owner
                        record["viewers"] = {}
                        record["last_active"] = time.time()
                        cancel = getattr(server, "_cancel_ws_orphan_reap", None)
                        if callable(cancel): cancel(sid)
                        emit({"jsonrpc": "2.0", "id": rid, "result": {"ok": True, "mode": "transferred", "session_id": sid}})
                        return
                    legacy = (sid, record)
        if legacy:
            # No event-transport slot (older engines), or a disconnect interrupt has already
            # started: stop and await the writer before closing/releasing its runtime. Never
            # release a running writer's lease or resume a second writer beside it.
            deadline = time.monotonic() + 10
            def native(method):
                done, answer = threading.Event(), []
                subid = "deck-takeover-" + uuid.uuid4().hex
                class Reply:
                    def write(self, obj):
                        if isinstance(obj, dict) and obj.get("id") == subid and "method" not in obj:
                            answer.append(obj); done.set(); return True
                        return owner.write(obj)
                    def close(self): pass
                response = server.dispatch({"jsonrpc": "2.0", "id": subid, "method": method,
                                            "params": {"session_id": legacy[0]}}, transport=Reply())
                if response is not None: answer.append(response); done.set()
                if not done.wait(max(0, deadline - time.monotonic())):
                    raise TimeoutError("Takeover interrupt did not settle; refresh before retrying")
                return answer[0]
            for method in ("session.interrupt", "session.close"):
                if method == "session.close":
                    while True:
                        with server._sessions_lock:
                            current = server._sessions.get(legacy[0])
                            busy = isinstance(current, dict) and current is legacy[1] and (current.get("running") or current.get("_client_gone_interrupt_requested"))
                        if not busy: break
                        if time.monotonic() >= deadline:
                            raise TimeoutError("Takeover interrupt did not settle; refresh before retrying")
                        time.sleep(.025)
                    if current is not legacy[1]: break  # engine already retired it
                reply = native(method)
                if "error" in reply:
                    emit(dict(reply, id=rid)); return
        # Reaped runtime, or an older host: native resume either safely adopts it or
        # refuses a foreign live lease. Both inline and pooled responses are supported.
        class ResumeReply:
            def write(self, obj):
                if isinstance(obj, dict) and obj.get("id") == rid and "method" not in obj:
                    result = obj.get("result")
                    if isinstance(result, dict) and isinstance(result.get("session_id"), str):
                        obj = dict(obj, result={"ok": True, "mode": "restarted", "session_id": result["session_id"]})
                    emit(obj)
                    return True
                return owner.write(obj)
            def contains(self, peer):
                return owner is peer or callable(getattr(owner, "contains", None)) and owner.contains(peer)
            def close(self): pass
        reply = ResumeReply()
        resume = {"jsonrpc": "2.0", "id": rid, "method": "session.resume",
                  "params": dict(params, omit_messages=True, inline_images=False)}
        response = server.dispatch(resume, transport=reply)
        if response is not None: reply.write(response)
    except ValueError as exc:
        error(4000, str(exc)[:300])
    except TimeoutError as exc:
        error(4009, str(exc)[:300])
    except Exception:
        logger.warning("Hermes Deck takeover unavailable", exc_info=True)
        error(5000, "Hermes takeover unavailable")


def reasoning_view(params, owner, server=None):
    """Set show_reasoning on one runtime session owned by `owner` (the control socket's FanoutTransport)."""
    if set(params) != {"session_id", "show"} or not _sid_ok(params.get("session_id")) or type(params.get("show")) is not bool:
        raise ValueError("Invalid reasoning view request")
    if server is None:
        from tui_gateway import server
    with server._sessions_lock:
        session = server._sessions.get(params["session_id"])
        if not isinstance(session, dict) or not _owned_by(session.get("transport"), owner):
            raise ValueError("Not a session of this Hermes Deck connection")
        session["show_reasoning"] = params["show"]
    return {"session_id": params["session_id"], "show": params["show"]}


def reasoning_reply(request, owner, server=None):
    """A JSON-RPC reply for deck.reasoning_view."""
    rid = request.get("id")
    try:
        return {"jsonrpc": "2.0", "id": rid, "result": reasoning_view(request.get("params", {}), owner, server)}
    except ValueError as exc:
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": 4000, "message": str(exc)[:300]}}
    except Exception:
        logger.warning("Hermes Deck bridge: reasoning view unavailable", exc_info=True)
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": 5000, "message": "Hermes reasoning view unavailable"}}


def allowed_request(method, params, created=()):
    """Whether a gateway request may be dispatched. `created`: the runtime session ids session.create returned
    on this control connection; session.title may only name one of those "Bot Chat"."""
    if method == "session.archive":             # one stored session, a real boolean; never a live runtime lookup by key
        return (set(params) >= {"session_id", "archived"} and set(params) <= {"session_id", "archived", "profile"}
                and _sid_ok(params["session_id"]) and type(params["archived"]) is bool and _profile_ok(params))
    if method == "session.branch_stored":       # "Continue here": a copy of one stored session, nothing else settable
        key = params.get("idempotency_key")
        return (set(params) >= {"parent_session_id"} and set(params) <= {"parent_session_id", "profile", "idempotency_key"}
                and _sid_ok(params["parent_session_id"]) and _profile_ok(params)
                and (key is None or (isinstance(key, str) and bool(re.fullmatch(r"[A-Za-z0-9-]{8,128}", key)))))
    if method == "profiles.list":
        return not params                       # the roster, nothing else (no include_sessions switch)
    if method == "profiles.get_asset":
        return (set(params) == {"name", "asset"} and params["asset"] == "avatar"
                and isinstance(params["name"], str) and bool(PROFILE_NAME.fullmatch(params["name"])))
    if method == "session.title":
        sid = params.get("session_id")
        return (set(params) == {"session_id", "title"} and params["title"] == BOT_CHAT_TITLE
                and isinstance(sid, str) and sid in created)
    if method == "session.delete":
        sid = params.get("session_id")
        return (set(params) <= {"session_id", "profile"} and isinstance(sid, str)
                and bool(re.fullmatch(r"[\x21-\x7e]{1,512}", sid))
                and ("profile" not in params or (isinstance(params["profile"], str)
                                                 and bool(PROFILE_NAME.fullmatch(params["profile"])))))
    if method == "commands.catalog":            # one profile's palette, nothing else
        return (set(params) == {"profile"} and isinstance(params["profile"], str)
                and bool(PROFILE_NAME.fullmatch(params["profile"])))
    if method in SUBAGENT_METHODS:              # one session's children: strict shape, Hermes checks the owner
        return subagent_params_ok(method, params)
    if method != "config.set":
        return method in ALLOWED_METHODS
    if params.get("key") == "reasoning":         # one session's effort level: no scope (global writes config.yaml),
        sid = params.get("session_id")          # no display word (show/hide/full/clamp write config.yaml too)
        return (set(params) == {"session_id", "key", "value"} and _sid_ok(sid)
                and isinstance(params.get("value"), str) and params["value"] in SESSION_REASONING_EFFORTS)
    if params.get("key") != "model" or not params.get("session_id") or not isinstance(params.get("value"), str):
        return False
    try:
        return not {"--global", "-g"}.intersection(shlex.split(params["value"]))
    except ValueError:
        return False


def avatar_refusal(params):
    """An error message when the avatar profiles.get_asset would read is too big for one reply line, else None.
    Same file Hermes picks (first existing avatar.<ext> in its order); anything unresolvable is left to Hermes,
    which answers it with its own error."""
    try:
        from hermes_cli.profiles import get_profile_dir
        assets = Path(get_profile_dir(params["name"])) / "assets"
        for ext in AVATAR_EXTS:
            target = assets / f"avatar.{ext}"
            if target.is_file():
                size = target.stat().st_size
                return (f"Avatar too large for Hermes Deck ({size} bytes; max {AVATAR_MAX_BYTES})"
                        if size > AVATAR_MAX_BYTES else None)
    except Exception:
        return None
    return None


def creates_bot_chat(method, params):
    """Whether this request creates a Bot Chat the way the Deck does (title "Bot Chat", hidden). Only the
    runtime id such a session.create returns may later be titled "Bot Chat"; a plain session may not."""
    return method == "session.create" and params.get("title") == BOT_CHAT_TITLE and params.get("hidden") is True


def guard_avatar_reply(obj):
    """The profiles.get_asset reply as it may be written: unchanged, or error 4071 when its line would be longer
    than AVATAR_REPLY_MAX. avatar_refusal checks the file before dispatch, but Hermes reads it again later; a
    bigger file written in between (profiles.set_asset accepts 2 MB) must not become an oversized line."""
    try:
        size = len(json.dumps(obj, ensure_ascii=True))
    except (TypeError, ValueError):
        size = None
    if size is not None and size <= AVATAR_REPLY_MAX:
        return obj
    rid = obj.get("id") if isinstance(obj, dict) else None
    detail = f"reply of {size} bytes" if size is not None else "unserializable reply"
    return {"jsonrpc": "2.0", "id": rid,
            "error": {"code": 4071, "message": f"Avatar too large for Hermes Deck ({detail}; max {AVATAR_MAX_BYTES} bytes of image)"}}


def launch_profile_reply(obj, launch_home):
    """Preserve the engine's omitted-profile list scope on inline and pooled replies."""
    result = obj.get("result") if isinstance(obj, dict) else None
    if not isinstance(result, dict) or not isinstance(result.get("sessions"), list) or not callable(launch_home):
        return obj
    try:
        from hermes_constants import profile_name_for_home
        profile = profile_name_for_home(launch_home())
    except (ImportError, OSError, RuntimeError, TypeError, ValueError):
        return obj
    if not isinstance(profile, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", profile):
        return obj
    return dict(obj, result=dict(result, launch_profile=profile))


def request_arrival_reply(obj, server):
    """Copy trusted, still-registered request arrival seconds onto live frames and reconnect rows."""
    if not isinstance(obj, dict):
        return obj
    result = obj.get("result")
    replay = isinstance(result, dict) and isinstance(result.get("open_requests"), list)
    rows = result["open_requests"] if replay else [obj]
    if not replay and ("method" not in obj or "id" not in obj):
        return obj
    requests = getattr(server, "_server_requests", None)
    sessions = getattr(server, "_sessions", None)

    def decorate(row):
        if not isinstance(row, dict):
            return row
        # This reserved field is supplied only by this boundary, never by a tool/client payload.
        clean = {k: v for k, v in row.items() if k != "request_created_at"}
        try:
            from hermes_constants import profile_name_for_home
            with requests._lock:
                req = requests._open.get(row.get("id"))
                if req is None or row.get("id") != req.id or row.get("method") != req.method:
                    return clean
                expected = req.snapshot() if replay else req.frame()
                if row.get("params") != expected["params"]:
                    return clean
                session = sessions.get(req.sid)
                if not isinstance(session, dict):
                    return clean
                home = session.get("profile_home") or server._launch_home()
                profile = profile_name_for_home(home)
                if not isinstance(profile, str) or not PROFILE_NAME.fullmatch(profile):
                    return clean
                scopes = [row, row["params"]]
                if replay:
                    if "session_id" in result and result["session_id"] != req.sid:
                        return clean
                    scopes += [result, result.get("info", {})]
                for scope in scopes:
                    if isinstance(scope, dict) and any(scope[key] != profile for key in ("profile", "profile_name") if key in scope):
                        return clean
                created = req.created_at
                if type(created) not in (int, float) or not math.isfinite(created) or created <= 0:
                    return clean
                return dict(clean, request_created_at=created)
        except Exception:
            return clean  # Legacy engines and compute-host mirrors keep the existing unstamped path.

    decorated = [decorate(row) for row in rows]
    return dict(obj, result=dict(result, open_requests=decorated)) if replay else decorated[0]


class OneInFlight:
    """At most one request of a kind in flight per control connection. acquire() returns a ticket, or None
    while another one runs; a ticket older than `stale` seconds no longer blocks (its reply never came)."""

    def __init__(self, stale=AVATAR_STALE_SECONDS, clock=time.monotonic):
        self.stale, self.clock, self.lock = stale, clock, threading.Lock()
        self.ticket, self.since = None, 0.0

    def acquire(self):
        with self.lock:
            if self.ticket is not None and self.clock() - self.since < self.stale:
                return None
            self.ticket, self.since = object(), self.clock()
            return self.ticket

    def release(self, ticket):
        with self.lock:
            if self.ticket is ticket:           # a stale ticket's late reply never frees a newer request
                self.ticket = None


class AvatarReply:
    """The transport one profiles.get_asset is dispatched with, instead of the connection's FanoutTransport.

    Hermes answers profiles.get_asset from its RPC pool and writes the reply through the transport bound to the
    request. Through FanoutTransport the reply would be queued for every attached peer, and a few ~1.3 MB avatars
    at once overflow its 4 MiB per-peer backlog: Hermes then closes the Deck's control connection. Here the reply
    goes to the asking connection only, written on its own thread (a slow peer never holds a pool worker), after
    guard_avatar_reply. `done` runs once that reply is written; any other frame goes to `fallback`.
    """

    def __init__(self, peer, fallback, request_id, done):
        self.peer, self.fallback, self.request_id, self.done = peer, fallback, request_id, done
        self.lock, self.sent = threading.Lock(), False

    def write(self, obj):
        is_reply = (isinstance(obj, dict) and "method" not in obj and obj.get("id") == self.request_id
                    and ("result" in obj or "error" in obj))
        if not is_reply:
            return self.fallback.write(obj)
        with self.lock:
            if self.sent:
                return False
            self.sent = True
        threading.Thread(target=self._send, args=(guard_avatar_reply(obj),), name="hermes-deck-avatar", daemon=True).start()
        return True

    def _send(self, obj):
        try:
            self.peer.write(obj)
        finally:
            self.done()

    def close(self):
        pass


# --- activity: the Run and Plan tabs and the sub-agent detail on the direct connection -------------------------
# Per live session the observer keeps, in memory, its last ACTIVITY_TOOLS tool calls (call id, tool, args preview,
# duration, status, error, result preview: the 300-character redacted previews the events part writes) and its latest
# plan (events.parse_plan). Both are written, only when they changed, to <pid>.activity next to the snapshot file
# (never into the snapshot itself, which must stay small); stream.py forwards them as `deck.tools` / `deck.plan` events.
# subagent.list / subagent.tail replies are completed from the same memory (enrich_subagent_reply).
ACTIVITY_TOOLS = 20
ACTIVITY_SESSIONS = 64
ACTIVITY_MAX_BYTES = 4 * 1024 * 1024
ACTIVITY_SUFFIX = ".activity"
SUBAGENT_GOAL_MAX = 4000
SUBAGENT_TAIL_MAX = 16384
SUBAGENT_READS = ("subagent.list", "subagent.tail")
SUBAGENT_METHODS = {"subagent.list": {"session_id"}, "subagent.tail": {"session_id", "subagent_id"},
                    "subagent.interrupt": {"session_id", "subagent_id"},
                    "subagent.steer": {"session_id", "subagent_id", "text"}}
PLAN_METHOD = "deck.plan"
_EVENTS_KEY = "_hermes_deck_plugin_events"      # the name __init__._sibling loads events.py under


def events_part():
    """This plugin's events.py (its redaction and plan parser), the one copy per process; None when it cannot load."""
    mod = sys.modules.get(_EVENTS_KEY)
    if mod is not None:
        return mod
    try:
        spec = importlib.util.spec_from_file_location(_EVENTS_KEY, Path(__file__).resolve().parent / "events.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[_EVENTS_KEY] = mod
        spec.loader.exec_module(mod)
        return mod
    except Exception:
        sys.modules.pop(_EVENTS_KEY, None)
        logger.warning("Hermes Deck bridge: events part unavailable for activity previews", exc_info=True)
        return None


def _preview(value, limit=None):
    """A redacted preview (events._clip: 300 characters), or None."""
    ev = events_part()
    if ev is None or value is None:
        return None
    try:
        if limit is None:
            return ev._clip(value)
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
        text = ev._redact(text)
        return text if len(text) <= limit else text[:limit] + "…"
    except Exception:
        return None


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def subagent_params_ok(method, params):
    """Shape check for the subagent.* gateway methods (Hermes checks authority itself)."""
    keys = SUBAGENT_METHODS.get(method)
    if keys is None:
        return True
    if not keys <= set(params) or set(params) - keys - {"profile"} or not _sid_ok(params.get("session_id")):
        return False
    if "subagent_id" in keys and not (isinstance(params["subagent_id"], str) and re.fullmatch(r"[\x21-\x7e]{1,128}", params["subagent_id"])):
        return False
    if "text" in keys and not (isinstance(params["text"], str) and params["text"].strip() and len(params["text"]) <= 32000):
        return False
    return _profile_ok(params)


def _subagent_record(subagent_id):
    try:
        from tools.delegate_tool_registry import _active_subagents, _active_subagents_lock
        with _active_subagents_lock:
            record = _active_subagents.get(subagent_id)
            return dict(record) if isinstance(record, dict) else None
    except Exception:
        return None


def subagent_detail(observer, subagent_id, row=None, now=None):
    """What the Deck's sub-agent detail view needs about one live child, beyond Hermes' own roster row: its session id,
    reasoning effort, state, elapsed seconds, token counts and cost when Hermes has them, and its recent tool calls.
    Bounded and redacted; {} when the child is not in this process."""
    now = time.time() if now is None else now
    record = _subagent_record(subagent_id) or {}
    agent = record.get("agent")
    out = {}
    row = row if isinstance(row, dict) else {}
    goal = row.get("goal") if row.get("goal") is not None else record.get("goal")
    if isinstance(goal, str):
        out["goal"] = _preview(goal, SUBAGENT_GOAL_MAX)
    if isinstance(row.get("last_tool"), str):
        out["last_tool"] = _preview(row["last_tool"], 200)
    started = _number(row.get("started_at")) or _number(record.get("started_at"))
    if started:
        out["elapsed_s"] = round(max(0.0, now - started), 1)
    if agent is None:
        return out
    sid = str(getattr(agent, "session_id", "") or "")[:512]
    if sid:
        out["child_session_id"] = sid
    out["model"] = str(row.get("model") or getattr(agent, "model", "") or "")[:160]
    provider = str(getattr(agent, "provider", "") or "")[:160]
    if provider:
        out["provider"] = provider
    effort = reasoning_effort_of(agent)
    if effort:
        out["reasoning_effort"] = effort
    tokens = {}
    for key, attr in (("input", "session_input_tokens"), ("output", "session_output_tokens"),
                      ("cache_read", "session_cache_read_tokens"), ("cache_write", "session_cache_write_tokens"),
                      ("reasoning", "session_reasoning_tokens"), ("api_calls", "session_api_calls")):
        value = _number(getattr(agent, attr, None))
        if value:
            tokens[key] = int(value)
    if tokens:
        out["tokens"] = tokens
    cost = _number(getattr(agent, "session_estimated_cost_usd", None))
    if cost is not None and cost > 0:
        out["cost_usd"] = round(cost, 6)
        status = str(getattr(agent, "session_cost_status", "") or "")[:32]
        if status:
            out["cost_status"] = status
    if sid and observer is not None:
        with observer.lock:
            node = observer.nodes.get(sid)
            if node is not None:
                out["state"] = node["state"]
                for key in ("context_used", "context_max", "context_percent"):
                    if key in node:
                        out[key] = node[key]
            activity = observer.activity.get(sid)
            out["tools"] = [dict(t) for t in activity["tools"]] if activity else []
    return out


def enrich_subagent_reply(method, response, observer, now=None):
    """subagent.list / subagent.tail replies completed with subagent_detail. Only rows Hermes itself returned (its own
    owner check) are completed, and a tail only when Hermes found the child's transcript (available). The tail text is
    redacted. Never raises: on any failure the reply goes out as Hermes wrote it."""
    try:
        result = response.get("result") if isinstance(response, dict) else None
        if not isinstance(result, dict):
            return response
        result = dict(result)
        if method == "subagent.list" and isinstance(result.get("subagents"), list):
            rows = []
            for row in result["subagents"][:64]:
                if isinstance(row, dict) and isinstance(row.get("subagent_id"), str):
                    row = {**row, **subagent_detail(observer, row["subagent_id"], row, now)}
                rows.append(row)
            result["subagents"] = rows
            delegations = []
            for row in result.get("delegations") or []:
                if isinstance(row, dict):
                    row = dict(row)
                    for key, limit in (("goal", SUBAGENT_GOAL_MAX), ("error", 600)):
                        if isinstance(row.get(key), str):
                            row[key] = _preview(row[key], limit)
                delegations.append(row)
            if isinstance(result.get("delegations"), list):
                result["delegations"] = delegations[:64]
        elif method == "subagent.tail":
            if isinstance(result.get("text"), str):
                text = result["text"][-SUBAGENT_TAIL_MAX:]
                result["text"] = _preview(text, SUBAGENT_TAIL_MAX + 1) or ""
            if result.get("available") is True and isinstance(result.get("subagent_id"), str):
                result.update({k: v for k, v in subagent_detail(observer, result["subagent_id"], None, now).items()
                               if k not in result})
        else:
            return response
        return {**response, "result": result}
    except Exception:
        logger.warning("Hermes Deck bridge: sub-agent reply left as is", exc_info=True)
        return response


_STORED_PLAN_SQL = ("SELECT tool_name, content FROM messages WHERE session_id = ? AND role = 'tool'"
                    " AND tool_name IN ('todo_list', 'todo', 'omh_todo'){active} ORDER BY id DESC LIMIT 5")


def stored_plan(params, with_db=None):
    """deck.plan: the latest plan a stored session published, rebuilt from its newest todo_list / todo / omh_todo tool
    result in state.db (read-only handle; a compression continuation also looks at the sessions it continues).
    params: session_id, profile. -> {session_id, plan} (plan None when the session never published one)."""
    with_db = with_db or _profile_db
    if not isinstance(params, dict) or set(params) - {"session_id", "profile"} or not _profile_ok(params):
        raise ValueError("Unsupported plan parameter")
    sid, profile = params.get("session_id"), params.get("profile", "default")
    if not _sid_ok(sid):
        raise ValueError("A persisted session ID is required")
    ev = events_part()

    def read(db):
        row = db.get_session(sid)
        if row is None:
            raise ValueError("Persisted session not found")
        reader = getattr(db, "_read_all", None)
        if reader is None or ev is None:
            return None
        current, seen = row, set()
        for _ in range(6):                          # this session, then up to five sessions it continues
            cid = str(current.get("id") or sid) if isinstance(current, dict) else sid
            if cid in seen:
                break
            seen.add(cid)
            for active in (" AND COALESCE(active, 1) = 1", ""):
                try:
                    rows = reader(_STORED_PLAN_SQL.format(active=active), (cid,))
                except Exception:
                    continue
                for name, content in ((r[0], r[1]) for r in rows):
                    plan = ev.parse_plan(name, content)
                    if plan is not None:
                        return plan
                break
            parent = current.get("parent_session_id") if isinstance(current, dict) else None
            if not parent or (isinstance(current, dict) and current.get("source") == "subagent"):
                break
            current = db.get_session(parent)
            if current is None:
                break
        return None

    plan = with_db(profile, read, True)
    return {"session_id": sid, "plan": plan}


def safe_title(value):
    if not isinstance(value, str) or not value.strip():
        return ""
    title = value.splitlines()[0][:4096]
    title = re.sub(r"(?i)\bBearer\s+[^\s,;]+", "Bearer [redacted]", title)
    title = re.sub(r"(?i)\b(api[ _-]?key|access[ _-]?token|client[ _-]?secret|token|password|secret|authorization)\b[\"']?\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)", r"\1=[redacted]", title)
    title = re.sub(r"\b(?:sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)", "[redacted]", title)
    title = re.sub(r"(https?://)[^/\s:@]+:[^/\s@]+@", r"\1[redacted]@", title)
    return re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", " ", title)).strip()[:80]


class Observer:
    def __init__(self, directory, clock=time.time):
        self.directory = Path(directory)
        self.clock = clock
        self.nodes, self.routes, self.agents = {}, {}, {}
        self.dispatch_routes, self.pending_children = {}, {}
        self.lineage = {}  # subagent session id -> parent/identity, outlives the node (see _node)
        self.lease_seen = set()  # session ids whose agent held a durable turn lease when its turn started
        self.api_errors = {}     # session id -> turn id of the last api_request_error (turn-end verdict hint)
        self.quiet = {}          # session id -> (turn id, first time "no turn is running" was observed)
        self.lost = set()        # session ids whose agent object was garbage-collected while the node was live
        self.control_replies = OrderedDict()
        self.control_socket = ""
        self.lock = threading.RLock()
        self.sequence = 0
        self.pid = os.getpid()
        # session id -> {"tools": [recent tool calls], "plan": latest plan or None}; see ACTIVITY_* above
        self.activity = OrderedDict()
        self.activity_dirty = False
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory.chmod(0o700)
        self._persist()

    def _activity(self, node):
        """The activity record of a live node (created on first use; the least recently used one goes past the cap)."""
        sid = node["session_id"]
        entry = self.activity.get(sid)
        if entry is None:
            entry = self.activity[sid] = {"tools": [], "plan": None}
        self.activity.move_to_end(sid)
        while len(self.activity) > ACTIVITY_SESSIONS:
            self.activity.popitem(last=False)
        self.activity_dirty = True
        return entry

    def _tool_started(self, node, tool_name, call_id, args):
        if node is None:
            return
        try:
            tools = self._activity(node)["tools"]
            tools.append({"call": str(call_id or "")[:128], "tool": str(tool_name or "")[:96], "args": _preview(args),
                          "ts": round(self.clock(), 3), "status": "running"})
            del tools[:-ACTIVITY_TOOLS]
        except Exception:   # a display record must never break the hook
            logger.warning("Hermes Deck bridge: tool activity not recorded", exc_info=True)

    def _tool_finished(self, node, *args):
        if node is None:
            return
        try:
            self._tool_record_end(node, *args)
        except Exception:
            logger.warning("Hermes Deck bridge: tool activity not recorded", exc_info=True)

    def _tool_record_end(self, node, tool_name, call_id, result, duration_ms, status, error_type, error_message):
        entry = self._activity(node)
        call = str(call_id or "")[:128]
        tool = next((t for t in reversed(entry["tools"]) if call and t["call"] == call), None)
        if tool is None:
            tool = {"call": call, "tool": str(tool_name or "")[:96], "args": None, "ts": round(self.clock(), 3)}
            entry["tools"].append(tool)
            del entry["tools"][:-ACTIVITY_TOOLS]
        failed = status in {"error", "failed", "blocked"} or bool(error_type)
        tool["status"] = str(status or ("error" if failed else "ok"))[:32]
        tool["ms"] = _number(duration_ms)
        tool["result"] = _preview(result)
        tool["err"] = (_preview(f"{error_type}: {error_message or ''}") if error_type
                       else _preview(error_message) if failed and error_message else None)
        ev = events_part()
        plan = ev.parse_plan(tool_name, result) if ev is not None and tool_name in getattr(ev, "PLAN_TOOLS", ()) and not failed else None
        if plan is not None:
            entry["plan"] = dict(plan, ts=round(self.clock(), 3))

    def activity_snapshot(self):
        """The activity of the live nodes, as written to <pid>.activity."""
        with self.lock:
            sessions = {}
            for sid, entry in self.activity.items():
                node = self.nodes.get(sid)
                if node is None:
                    continue
                sessions[sid] = {"profile_name": node.get("profile_name") or "default",
                                 "tools": [dict(t) for t in entry["tools"]], "plan": entry["plan"]}
            return json.loads(json.dumps({"schema": SCHEMA, "pid": self.pid, "updated_at": self.clock(),
                                          "sessions": sessions}, default=str))

    def _persist_activity(self):
        for sid in [s for s in self.activity if s not in self.nodes]:
            self.activity.pop(sid, None)
            self.activity_dirty = True
        if not self.activity_dirty:
            return
        self.activity_dirty = False
        try:
            data = json.dumps(self.activity_snapshot(), ensure_ascii=True)
            if len(data) > ACTIVITY_MAX_BYTES:
                return
            target = self.directory / f"{self.pid}{ACTIVITY_SUFFIX}"
            tmp = self.directory / f"{self.pid}{ACTIVITY_SUFFIX}.tmp"
            fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(data)
            os.replace(tmp, target)
        except OSError:
            logger.warning("Hermes Deck bridge: activity snapshot unavailable", exc_info=True)

    def _node(self, session_id):
        sid = str(session_id or "")[:512]
        if not sid:
            return None
        node = self.nodes.get(sid)
        if node is None:
            node = self.nodes[sid] = dict(
                session_id=sid, parent_session_id="", subagent_id="", role="main",
                model="", provider="", profile_name="default", source="", title="", observation_source="native_hook",
                active=False, platform="", name="Hermes", origin="native", state="idle", turn_id="",
                steps=[], updated_at=self.clock(), terminal_at=None, control_available=False,
            )
            # A subagent whose node was pruned (120 s after it ended) and is then seen again (a retry turn)
            # keeps its identity: it must never come back as a standalone top-level session.
            node.update(self.lineage.get(sid, {}))
        return node

    def _late(self, session_id):
        """The node a late hook (post_tool_call, on_session_end) reports on, never a resurrected one: a
        subagent already pruned after it ended is not rebuilt from a stray trailing hook."""
        sid = str(session_id or "")[:512]
        if sid not in self.nodes and sid in self.lineage:
            return None
        return self._node(sid)

    def _remember(self, node):
        """Remember which session a subagent belongs to (bounded), see _node."""
        if node["parent_session_id"]:
            self.lineage[node["session_id"]] = {k: node[k] for k in ("parent_session_id", "subagent_id", "role", "origin", "title", "name")}
            while len(self.lineage) > LINEAGE_MAX:
                self.lineage.pop(next(iter(self.lineage)))

    @staticmethod
    def _active_agent():
        try:
            from agent.subagent_lifecycle import get_active_subagent_parent
            return get_active_subagent_parent()
        except ImportError:
            return None

    @staticmethod
    def _is_spawn(tool_name, args):
        return tool_name == "delegate_task" and str((args or {}).get("action") or "spawn").strip().lower() == "spawn"

    def _step(self, node, text):
        if node is not None:
            node["steps"] = (node["steps"] + [str(text)[:96]])[-20:]
            node["updated_at"] = self.clock()

    def snapshot(self):
        with self.lock:
            return json.loads(json.dumps(dict(schema=SCHEMA, pid=self.pid,
                sequence=self.sequence, updated_at=self.clock(), control_socket=self.control_socket,
                nodes=self.nodes)))

    @staticmethod
    def _gateway_running(agent):
        """The TUI gateway's own `running` flag of the session that owns `agent` (cleared in its turn thread's
        finally, whatever way the turn ended); None when this agent is not a gateway session or no gateway is here."""
        try:
            from tui_gateway import server
            with server._sessions_lock:
                sessions = list(server._sessions.values())
        except Exception:
            return None
        for session in sessions:
            if isinstance(session, dict) and session.get("agent") is agent:
                return bool(session.get("running"))
        return None

    def _turn_running(self, sid, agent):
        """True/False when a real signal says whether a turn is executing on `agent`, None when nothing can tell.
        Never based on elapsed time: a long tool call keeps the gateway flag and the turn lease set."""
        running = self._gateway_running(agent)
        if running is not None:
            return running
        if sid in self.lease_seen:  # the durable turn lease is released in run_conversation's finally
            return getattr(agent, "_active_session_turn_lease_holder", None) is not None
        return None

    def _demote_stalled(self, now):
        """Backstop for a turn that ended without any terminal hook: after TURN_GRACE seconds of a continuous
        "no turn is running" signal (or of the agent object being gone) the node becomes error (an API error was
        seen during that turn) or idle, with terminal_at, so the Deck stops showing it as thinking."""
        for sid, node in self.nodes.items():
            if node["terminal_at"] is not None or node["state"] not in {"thinking", "working"}:
                self.quiet.pop(sid, None)
                continue
            ref = self.agents.get(sid)
            agent = ref() if ref else None
            over = sid in self.lost if agent is None else self._turn_running(sid, agent) is False
            if not over:
                self.quiet.pop(sid, None)
                continue
            turn, since = self.quiet.setdefault(sid, (node["turn_id"], now))
            if turn != node["turn_id"]:  # a new turn started since: measure again
                turn, since = self.quiet[sid] = (node["turn_id"], now)
            if now - since >= TURN_GRACE:
                node["state"] = "error" if self.api_errors.get(sid) == node["turn_id"] else "idle"
                node["terminal_at"] = now
                self._step(node, "Turn ended")
                self.quiet.pop(sid, None)

    def _persist(self):
        now = self.clock()
        self.nodes = {sid:n for sid,n in self.nodes.items()
                      if n["terminal_at"] is None or now - n["terminal_at"] < 120}
        self.lost.update(sid for sid, ref in self.agents.items() if ref() is None)
        self._demote_stalled(now)
        self.agents = {sid:ref for sid,ref in self.agents.items()
                       if sid in self.nodes and self.nodes[sid]["terminal_at"] is None and ref() is not None}
        for table in (self.lease_seen, self.api_errors, self.quiet, self.lost):
            for sid in [s for s in table if s not in self.nodes]:
                table.discard(sid) if isinstance(table, set) else table.pop(sid, None)
        for sid, node in self.nodes.items():
            node["control_available"] = sid in self.agents
            node["active"] = node["terminal_at"] is None and node["state"] in {"thinking","working"}
            agent = self.agents[sid]() if sid in self.agents else None
            if agent is not None:
                node["model"] = str(getattr(agent, "model", "") or node["model"])[:160]
                node["provider"] = str(getattr(agent, "provider", "") or node["provider"])[:160]
                effort = reasoning_effort_of(agent)
                if effort:
                    node["reasoning_effort"] = effort
                else:
                    node.pop("reasoning_effort", None)
                compressor = getattr(agent, "context_compressor", None)
                used, maximum = getattr(compressor, "last_prompt_tokens", 0) or 0, getattr(compressor, "context_length", 0) or 0
                if isinstance(used, (int,float)) and isinstance(maximum, (int,float)) and used > 0 and maximum > 0:
                    used = min(used, maximum)
                    real = getattr(compressor, "last_real_prompt_tokens", None)
                    estimated = isinstance(real, (int,float)) and used != real
                    node.update(context_used=used, context_max=maximum, context_percent=round(used/maximum*100),
                                context_estimated=estimated, context_source="local_estimate" if estimated else "provider_usage")
        self.pending_children = {sid:entry for sid,entry in self.pending_children.items()
                                 if now-entry["observed_at"] < 120}
        self.sequence += 1
        try:
            target = self.directory / f"{self.pid}.json"
            tmp = self.directory / f"{self.pid}.tmp"
            tmp.write_text(json.dumps(self.snapshot(), ensure_ascii=True), encoding="utf-8")
            tmp.chmod(0o600)
            os.replace(tmp, target)
        except OSError:
            # Display failures must never prevent a tool or agent from executing.
            logger.warning("Hermes Deck bridge: observer snapshot unavailable", exc_info=True)
        self._persist_activity()

    def pre_llm_call(self, session_id="", turn_id="", parent_session_id="", model="", platform="", **_):
        with self.lock:
            node = self._node(session_id)
            if node is None:
                return None
            node.update(model=str(model)[:160], platform=str(platform)[:32], state="thinking", terminal_at=None, turn_id=str(turn_id))
            node["source"] = str(platform or "")[:32]
            try:
                from hermes_constants import get_hermes_home, profile_name_for_home
                node["profile_name"] = profile_name_for_home(get_hermes_home()) or "default"
            except ImportError:
                pass
            agent = self._active_agent()
            if agent is not None and str(getattr(agent, "session_id", "") or "") == str(session_id):
                subagent_id = str(getattr(agent, "_subagent_id", "") or "")
                pending = self.pending_children.pop(subagent_id, None)
                if pending is not None:
                    self.subagent_start(child_session_id=session_id, child_subagent_id=subagent_id,
                                        **{k:v for k,v in pending.items() if k != "observed_at"})
                if subagent_id:
                    node["subagent_id"] = subagent_id[:512]
                    node["role"] = str(getattr(agent, "_delegate_role", "leaf") or "leaf")[:32]
                    parent_session_id = parent_session_id or getattr(agent, "_parent_session_id", "") or ""
                try:
                    self.agents[str(session_id)] = weakref.ref(agent)
                except TypeError:
                    pass
                if getattr(agent, "_active_session_turn_lease_holder", None) is not None:
                    self.lease_seen.add(str(session_id))
                else:
                    self.lease_seen.discard(str(session_id))
            self.quiet.pop(str(session_id), None)
            self.lost.discard(str(session_id))
            parent_session_id = parent_session_id or node["parent_session_id"]  # a retry turn keeps its parent
            if parent_session_id:
                node["parent_session_id"] = str(parent_session_id)[:512]
                if node["role"] == "main":
                    node["role"] = "leaf"
                label = node["title"] or f"{node['role']} {str(node['subagent_id'] or session_id)[-4:]}"
                node["name"] = f"{'OMH' if node['origin'] == 'omh' else 'Hermes'} · {label}"
            else:
                node["name"] = "Hermes · " + (str(platform or "CLI").capitalize())
            self.routes = {k:v for k,v in self.routes.items() if k[0] != str(session_id)}
            self.dispatch_routes = {k:v for k,v in self.dispatch_routes.items() if k[0] != str(session_id)}
            self._step(node, "Thinking")
            self._remember(node)
            self._persist()
            return None

    def pre_tool_call(self, tool_name="", session_id="", turn_id="", args=None, tool_call_id=None, **_):
        with self.lock:
            node = self._node(session_id)
            key = (str(session_id), str(turn_id))
            # Observe one route per dispatch for labels only; never gate native delegation.
            if self._is_spawn(tool_name, args) and key in self.routes:
                self.dispatch_routes[key] = self.routes.pop(key)
            if tool_name == "omh_delegate_route" and (args or {}).get("action", "set") in {"set", "fallback", "clear"}:
                self.routes.pop(key, None)
            if node is not None:
                node["state"] = "working"
                self._step(node, tool_name)
                self._tool_started(node, tool_name, tool_call_id, args)
            self._persist()
        return None

    def post_tool_call(self, tool_name="", session_id="", turn_id="", args=None, result=None, status="",
                       tool_call_id=None, duration_ms=None, error_type=None, error_message=None, **_):
        with self.lock:
            self._tool_finished(self._late(session_id), tool_name, tool_call_id, result, duration_ms, status,
                                error_type, error_message)
            key = (str(session_id), str(turn_id))
            if tool_name == "omh_delegate_route" and (args or {}).get("action", "set") in {"set", "fallback"}:
                try:
                    output = json.loads(result) if isinstance(result, str) else result
                    if status not in {"error", "blocked", "failed"} and isinstance(output, dict) and output.get("status") == "routed":
                        self.routes[key] = str(output.get("category", ""))[:64]
                except (ValueError, TypeError):
                    pass
            if self._is_spawn(tool_name, args):
                self.routes.pop(key, None)
            self._step(self._late(session_id), tool_name + (" · failed" if status in {"error", "failed"} else " · done"))
            self._persist()

    def subagent_start(self, parent_session_id="", parent_turn_id="", child_session_id="", child_subagent_id="", child_role="leaf", child_goal="", title="", origin="", **_):
        with self.lock:
            # Native identity comes from the host, never a name synthesized from a goal.
            parent = self._node(parent_session_id)
            key = (str(parent_session_id), str(parent_turn_id))
            routed = key in self.routes or key in self.dispatch_routes
            origin = origin or ("omh" if routed or (parent and parent["origin"] == "omh") else "native")
            title = safe_title(title or child_goal)
            if not child_session_id and child_subagent_id:
                agent = self._active_agent()
                if agent is not None and str(getattr(agent, "session_id", "") or "") == str(parent_session_id):
                    with getattr(agent, "_active_children_lock", None) or nullcontext():
                        child = next((c for c in getattr(agent, "_active_children", ())
                                      if getattr(c, "_subagent_id", None) == child_subagent_id), None)
                    child_session_id = getattr(child, "session_id", "") or ""
                if not child_session_id:
                    # A later pre_llm_call resolves the real persisted ID from this exact native child.
                    self.pending_children[str(child_subagent_id)] = dict(
                        parent_session_id=parent_session_id, parent_turn_id=parent_turn_id,
                        child_role=child_role, title=title, origin=origin, observed_at=self.clock())
                    return
            node = self._node(child_session_id)
            if node is None:
                return
            node.update(parent_session_id=str(parent_session_id), subagent_id=str(child_subagent_id),
                        role=str(child_role or "leaf"), origin=origin, state="thinking", terminal_at=None,
                        title=title,
                        name=f"{'OMH' if origin == 'omh' else 'Hermes'} · {title or str(child_role or 'leaf')+' '+str(child_subagent_id or child_session_id)[-4:]}")
            self._step(node, "Native subagent started")
            self._remember(node)
            self._persist()

    def subagent_stop(self, child_session_id="", child_status="", **_):
        with self.lock:
            node = self._late(child_session_id)
            if node is not None:
                node["state"] = "finished" if child_status == "completed" else ("idle" if child_status in {"interrupted", "cancelled"} else "error")
                node["terminal_at"] = self.clock()
                self._step(node, "Native subagent " + str(child_status))
            self._persist()

    def on_session_end(self, session_id="", turn_id="", completed=None, failed=False, interrupted=False, **_):
        with self.lock:
            node = self._late(session_id)
            if node is not None:
                if turn_id and node["turn_id"] and str(turn_id) != node["turn_id"]:
                    return
                if completed is None and not failed and not interrupted and node["terminal_at"] is not None:
                    return
                node["state"] = "error" if failed or (completed is False and not interrupted) else ("finished" if completed else "idle")
                node["terminal_at"] = self.clock()
                self._step(node, "Turn ended")
            self.routes = {k:v for k,v in self.routes.items() if k[0] != str(session_id)}
            self.dispatch_routes = {k:v for k,v in self.dispatch_routes.items() if k[0] != str(session_id)}
            self._persist()

    def pre_transcription(self, **kwargs):
        return pre_transcription_hint(**kwargs)

    def api_request_error(self, session_id="", turn_id="", **_):
        """One failed provider attempt (retried or not). Not a turn end by itself: it only remembers that this turn
        saw an API error, so a turn that then ends without any terminal hook is reported as error, not idle."""
        with self.lock:
            sid = str(session_id or "")[:512]
            if sid in self.nodes and turn_id:
                self.api_errors[sid] = str(turn_id)
                self._step(self.nodes[sid], "API error")
                self._persist()

    def control(self, method, params, request_id=None):
        # Exact JSON-RPC retries are bounded and idempotent; command text is never retained.
        with self.lock:
            key = (type(request_id).__name__, str(request_id)) if request_id is not None else None
            digest = hashlib.sha256(json.dumps([method, params], sort_keys=True).encode()).digest()
            previous = self.control_replies.get(key) if key is not None else None
            if previous is not None:
                return dict(previous[1]) if previous[0] == digest else {"status": "duplicate_id_conflict"}
            result = self._control(method, params)
            if key is not None:
                self.control_replies[key] = (digest, dict(result))
                if len(self.control_replies) > 256:
                    self.control_replies.popitem(last=False)
            return result

    def _control(self, method, params):
        sid = str(params.get("session_id", ""))
        with self.lock:
            node = self.nodes.get(sid)
            ref = self.agents.get(sid)
            agent = ref() if ref else None
            if node is None or agent is None or node["terminal_at"] is not None:
                return {"status":"not_running"}
            if not params.get("turn_id") or params["turn_id"] != node["turn_id"]:
                return {"status":"stale"}
            if getattr(agent, "_current_turn_id", node["turn_id"]) != node["turn_id"]:
                return {"status":"stale"}
            if method == "native.interrupt":
                from agent.interrupt_compat import request_hard_interrupt
                accepted = request_hard_interrupt(agent, "Stopped from Hermes Deck", tool_reason="user_interrupt")
                return {"status":"interrupted" if accepted else "unsupported"}
            if method not in {"native.steer", "native.redirect"}:
                return {"status":"unsupported"}
            text = params.get("text")
            if not isinstance(text, str) or not text.strip() or len(text)>32000:
                return {"status":"invalid_text"}
            verb = "steer" if method=="native.steer" else "redirect"
            callback = getattr(agent, verb, None)
            if not callable(callback):
                return {"status":"unsupported"}
            accepted = callback(text)
            return {"status":("queued" if verb=="steer" else "redirected") if accepted else "rejected"}

    def messages(self, params):
        """Bounded persisted history through Hermes' existing read-only display path."""
        if set(params) - {"session_id","profile","limit","offset","order","inline_images"}:
            raise ValueError("Unsupported history parameter")
        sid, profile = params.get("session_id"), params.get("profile", "default")
        limit, offset = params.get("limit", 40), params.get("offset", 0)
        if not isinstance(sid, str) or not sid.strip() or len(sid)>512:
            raise ValueError("A persisted session ID is required")
        if not isinstance(profile, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", profile):
            raise ValueError("A logical Hermes profile name is required")
        if type(limit) is not int or not 1 <= limit <= 100 or type(offset) is not int or offset < 0:
            raise ValueError("Invalid history pagination")
        if params.get("order", "latest") != "latest" or params.get("inline_images", False) is not False:
            raise ValueError("History requires latest order and inline_images=false")
        if profile != "default":
            from hermes_constants import get_default_hermes_root
            if not (Path(get_default_hermes_root())/"profiles"/profile).is_dir():
                raise ValueError("Unknown Hermes profile")
        from hermes_cli.web_routers import sessions
        # The native endpoint also accepts title/prefix searches. This private
        # client selects exact IDs; prove existence before invoking that resolver.
        found = sessions._with_db(profile, lambda db: db.get_session(sid) is not None, read_only=True)
        if not found:
            raise ValueError("Persisted session not found")
        return asyncio.run(sessions.get_session_messages(
            session_id=sid, profile=profile, limit=limit, offset=offset, order="latest",
            include_compacted=False, inline_images=False))

    def start_control(self, stop):
        # This is a private local socket inside the existing Hermes process. SSH is
        # the remote authentication boundary; no TCP listener or token is added.
        from tui_gateway import server
        from tui_gateway.transport import FanoutTransport, bind_transport, reset_transport
        fanout = FanoutTransport()
        file_reader = FileReader()  # deck.file_read grants, shared by every connection of this process
        server.register_live_transport(fanout)
        path = self.directory.parent / f"control-{self.pid}-{uuid.uuid4().hex[:8]}.sock"
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(path))
        path.chmod(0o600)
        listener.listen(8)
        listener.settimeout(.5)
        self.control_socket = str(path)
        with self.lock: self._persist()

        class Peer:
            def __init__(self, conn): self.conn,self.lock = conn,threading.Lock()
            def write(self, obj):
                try:
                    obj = launch_profile_reply(obj, getattr(server, "_launch_home", None))
                    obj = request_arrival_reply(obj, server)
                    with self.lock: self.conn.sendall(json.dumps(obj,ensure_ascii=True).encode()+b"\n")
                    return True
                except OSError: return False
            def close(self):
                # FanoutTransport calls this when it drops the peer (backlog overflow). close() alone does not
                # release the socket while serve() still reads through conn.makefile(): the client would never
                # see EOF and keep a connection that no pooled reply or event reaches any more. shutdown() ends
                # it for real, so stream.py fails what was pending and reconnects on the next request.
                try: self.conn.shutdown(socket.SHUT_RDWR)
                except OSError: pass
                try: self.conn.close()
                except OSError: pass

        def serve(conn):
            conn.settimeout(None)
            peer = Peer(conn)
            # One event owner per caller, not the process-wide observation bus.
            connection_fanout = FanoutTransport()
            connection_fanout.attach(peer)
            fanout.attach(peer)
            created = OrderedDict()  # runtime ids a Bot Chat session.create returned on this connection (session.title)
            avatars = OneInFlight()  # one profiles.get_asset at a time on this connection
            files, budget = file_reader, ReadBudget()  # deck.file_read: the shared reader and this connection's budget
            try:
                with conn.makefile("rb") as incoming:
                    for line in incoming:
                        # Only deck.attach_submit / deck.transcribe may exceed 2 MiB (the method name is the first
                        # thing on the line), and each has its own ceiling (request_limit).
                        if line_refused(len(line), line[:300]): break
                        request = json.loads(line)
                        method,params = request.get("method"),request.get("params",{})
                        if not isinstance(params,dict): raise ValueError("Invalid params")
                        if len(line) > request_limit(method): raise ValueError("Request too large")
                        if method == TRANSCRIBE_METHOD:
                            start_transcription(request, peer.write)
                        elif method == FILE_METHOD:
                            peer.write(file_reply(request, files, budget))
                        elif method in {"deck.appshot", ATTACH_METHOD}:
                            token = bind_transport(connection_fanout)
                            try: peer.write((submit_appshot if method == "deck.appshot" else submit_attachments)(request, server.dispatch, connection_fanout))
                            finally: reset_transport(token)
                        elif method in {INDEX_METHOD, UPDATE_METHOD, PLAN_METHOD}:
                            # a store read can take seconds on a big state.db: off the connection's reader thread
                            handler = (session_index if method == INDEX_METHOD else session_update if method == UPDATE_METHOD
                                       else stored_plan)
                            threading.Thread(target=lambda r=request, f=handler: peer.write(session_reply(r, f)),
                                             daemon=True).start()
                        elif method == TAKEOVER_METHOD:
                            context = contextvars.copy_context()
                            threading.Thread(target=context.run,
                                             args=(takeover_reply, request, connection_fanout, peer.write, server),
                                             daemon=True).start()
                        elif method == REASONING_METHOD:
                            peer.write(reasoning_reply(request, connection_fanout))
                        elif method in {"native.steer","native.redirect","native.interrupt"}:
                            peer.write({"jsonrpc":"2.0","id":request.get("id"),"result":self.control(method,params,request_id=request.get("id"))})
                        elif method == "session.messages":
                            try:
                                response = {"jsonrpc":"2.0","id":request.get("id"),"result":self.messages(params)}
                            except ValueError as exc:
                                response = {"jsonrpc":"2.0","id":request.get("id"),"error":{"code":4000,"message":str(exc)}}
                            except Exception:
                                logger.warning("Hermes Deck bridge: native history read unavailable", exc_info=True)
                                response = {"jsonrpc":"2.0","id":request.get("id"),"error":{"code":5000,"message":"Native Hermes history unavailable"}}
                            peer.write(response)
                        elif allowed_request(method, params, created):
                            refusal = avatar_refusal(params) if method == "profiles.get_asset" else None
                            if refusal:
                                peer.write({"jsonrpc":"2.0","id":request.get("id"),"error":{"code":4071,"message":refusal}})
                                continue
                            transport = connection_fanout
                            if method == "profiles.get_asset":
                                # Each avatar reply is up to ~1.3 MB; several queued at once overflow Hermes'
                                # 4 MiB per-peer FanoutTransport backlog, which then closes this connection.
                                # So one at a time, answered to this connection only (AvatarReply).
                                ticket = avatars.acquire()
                                if ticket is None:
                                    peer.write({"jsonrpc":"2.0","id":request.get("id"),"error":{"code":4072,
                                                "message":"Another avatar request is in flight on this Hermes Deck connection"}})
                                    continue
                                transport = AvatarReply(peer, connection_fanout, request.get("id"),
                                                        lambda ticket=ticket: avatars.release(ticket))
                            token = bind_transport(transport)
                            try:
                                response = server.dispatch(request, transport=transport)
                                if method in SUBAGENT_READS:
                                    # the sub-agent detail view: Hermes' own reply, completed (and redacted) here
                                    response = enrich_subagent_reply(method, response, self)
                                if response is not None: transport.write(response)
                            except BaseException:
                                if isinstance(transport, AvatarReply): transport.done()  # nothing was queued
                                raise
                            finally: reset_transport(token)
                            # session.create answers inline (not a long handler); a pooled reply is not seen
                            # here, which only means session.title stays refused (Hermes then titles the
                            # chat after its first turn). Only a Bot Chat create (title "Bot Chat", hidden)
                            # is recorded: a plain session may never be titled "Bot Chat".
                            result = response.get("result") if creates_bot_chat(method, params) and isinstance(response, dict) else None
                            if isinstance(result, dict) and isinstance(result.get("session_id"), str):
                                created[result["session_id"]] = True
                                while len(created) > 256: created.popitem(last=False)
                        else:
                            peer.write({"jsonrpc":"2.0","id":request.get("id"),"error":{"code":-32601,"message":"Unsupported Hermes Deck control"}})
            except (OSError,ValueError,TypeError):
                pass
            finally:
                connection_fanout.detach(peer)
                fanout.detach(peer)
                peer.close()

        try:
            while not stop.is_set():
                try:
                    conn,_ = listener.accept()
                    context = contextvars.copy_context()
                    threading.Thread(target=context.run,args=(serve,conn),daemon=True).start()
                except socket.timeout: continue
                except OSError: break
        finally:
            listener.close()
            server.unregister_live_transport(fanout)
            try:
                path.unlink()
            except OSError:
                pass


def start(directory, on_unload=None):
    """Start observing (snapshots every 10 s) and serving the control socket. Returns the Observer whose
    hook methods (HOOKS) the plugin registers. `directory` is <HERMES_HOME>/hermes-deck."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    instance = Observer(directory / "processes")
    stop = threading.Event()

    def heartbeat():
        while not stop.wait(10):
            with instance.lock:
                instance._persist()

    def control():
        try:
            instance.start_control(stop)
        except Exception:
            # Snapshots still work without it: the Deck shows sessions, only live controls are unavailable.
            logger.warning("Hermes Deck bridge: control socket unavailable", exc_info=True)

    threading.Thread(target=heartbeat, name="hermes-deck-bridge-snap", daemon=True).start()
    context = contextvars.copy_context()
    threading.Thread(target=context.run, args=(control,), name="hermes-deck-bridge-control", daemon=True).start()
    if callable(on_unload):
        on_unload(stop.set)
    instance.stop = stop
    return instance
