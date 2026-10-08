"""hermes-deck, events part: append-only NDJSON event tap for Hermes Deck.

The hermes-deck plugin (__init__.py) registers these hooks next to the bridge's (observer.py).
Hooks write live display events; the relay's read-only state.db rollup owns host-wide accounting.

Every turn, tool call, LLM/auxiliary API call and delegate_task sub-agent becomes one JSON line in
``~/.hermes-deck/events/<profile>.ndjson`` (a plain directory in the user's home, so the relay never
needs access to the Hermes home itself). The relay tails these files and streams them to the deck app;
hooks never fetch from the network, inject context or modify an unrelated tool call. Quota polling
runs separately in gateway background workers.

Contract: hooks must never raise or block. Every handler is wrapped, writes are one short locked
append, and argument/result payloads are clipped to PREVIEW chars with common secrets redacted.
Full content stays in state.db and is fetched lazily by the deck.

The gateway process also writes ``~/.hermes-deck/state/<profile>.json`` every SNAP_EVERY seconds
(gateway/platform health + a cron job summary, no prompts or scripts), again so the relay never
has to read the profile directory.

One exception, off by default: Bot ekranı (bot screen). When a profile routes computer_use through the
relay's deck-cua wrapper, the plugin fences that one tool (it may block or rewrite a computer_use call,
asking the relay over its local Unix socket where the call goes) and stores the frames the agent saw.
See the "Bot ekranı" section below and docs/bot-screen-protocol.md.
"""
from __future__ import annotations

import base64
import io
import json
import math
import os
import re
import socket
import threading
import time
from pathlib import Path

PREVIEW = 300
MAX_BYTES = 50 * 1024 * 1024          # rotate to <profile>.ndjson.1 past this
SNAP_EVERY = 30                       # seconds between gateway/cron state snapshots
_lock = threading.Lock()
_fh = None
_path: Path | None = None
_profile: str | None = None
_snap_started = False

# Common credential shapes; previews may echo terminal commands or tool args.
_SECRET_RES = [
    re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b"),                    # Telegram bot token
    re.compile(r"\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}"),                   # OpenAI/Anthropic-style keys
    re.compile(r"\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}"),      # GitHub tokens
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),                      # Slack tokens
    # security audit L5 (same list as relay/src/util.js): more shapes seen in commands and tool output
    re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)"),  # PEM keys
    re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),                       # AWS access key ids
    re.compile(r"\bAIza[A-Za-z0-9_-]{35}\b"),                           # Google API keys
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),  # JWTs
]
# These keep their label (group 1) and redact only the value.
_LABELLED_RES = [
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{12,}"),
    re.compile(r"(?i)((?:api[_-]?key|token|secret|password)[\"']?\s*[:=]\s*[\"']?)[^\s\"',}]{6,}"),
    re.compile(r"(?i)(\b[a-z][a-z0-9+.-]{1,20}://[^\s:/@]+:)[^\s@/]+(?=@)"),  # password in scheme://user:pw@host
    re.compile(r"(?i)(\baws_secret_access_key[\"']?\s*[:=]\s*[\"']?)[A-Za-z0-9/+=]{20,}"),  # AWS secret keys
]
_MASK = "‹redacted›"


def _redact(s: str) -> str:
    for rx in _SECRET_RES:
        s = rx.sub(_MASK, s)
    for rx in _LABELLED_RES:
        s = rx.sub(lambda m: m.group(1) + _MASK, s)
    return s


def _clip(v) -> str | None:
    if v is None:
        return None
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str)
    s = _redact(s)
    return s if len(s) <= PREVIEW else s[:PREVIEW] + "…"


def _profile_name() -> str:
    global _profile
    if _profile is None:
        try:
            from hermes_constants import get_hermes_home
            home = Path(get_hermes_home())
            _profile = home.name if home.parent.name == "profiles" else "default"
        except Exception:
            _profile = os.environ.get("DECK_EVENTS_PROFILE", "default")
    return _profile


def _deck_home() -> Path:
    env = os.environ.get("DECK_HOME")
    return Path(os.path.expanduser(env)) if env else Path.home() / ".hermes-deck"


def _deck_dir(kind: str) -> Path:
    env = os.environ.get("DECK_EVENTS_DIR")
    if env:                                       # tests: events and state side by side
        return Path(env) if kind == "events" else Path(env) / kind
    return _deck_home() / kind


def _out_path() -> Path:
    return _deck_dir("events") / f"{_profile_name()}.ndjson"


def _ctx() -> dict:
    """Gateway routing context of the current turn (empty for CLI/cron-less contexts)."""
    try:
        from gateway.session_context import get_session_env as g
        out = {
            "platform": g("HERMES_SESSION_PLATFORM", "") or None,
            "chat": g("HERMES_SESSION_CHAT_ID", "") or None,
            "thread": g("HERMES_SESSION_THREAD_ID", "") or None,
            "skey": g("HERMES_SESSION_KEY", "") or None,
        }
        if g("HERMES_CRON_SESSION", ""):
            out["cron"] = True
        return {k: v for k, v in out.items() if v}
    except Exception:
        return {}


def _emit(ev: str, **fields) -> None:
    """Append one event line. Swallows every error: observability must never break a turn."""
    try:
        rec = {"ts": round(time.time(), 3), "ev": ev, "profile": _profile_name(), **_ctx()}
        rec.update({k: v for k, v in fields.items() if v is not None})
        _append(rec)
    except Exception:
        pass


def _append(rec: dict) -> None:
    """Append one record as a line (rotation-safe). Swallows every error, like _emit."""
    global _fh, _path
    try:
        line = json.dumps(rec, ensure_ascii=False, default=str) + "\n"
        with _lock:
            if _fh is not None:
                # Another process (cron worker, CLI turn) may have rotated the file under us.
                try:
                    if os.stat(_path).st_ino != os.fstat(_fh.fileno()).st_ino:
                        _fh.close()
                        _fh = None
                except FileNotFoundError:
                    _fh.close()
                    _fh = None
            if _fh is None:
                _path = _out_path()
                _path.parent.mkdir(parents=True, exist_ok=True)
                _fh = open(_path, "a", encoding="utf-8")
            _fh.write(line)
            _fh.flush()
            if _fh.tell() > MAX_BYTES:
                _fh.close()
                os.replace(_path, _path.with_suffix(".ndjson.1"))
                _fh = open(_path, "a", encoding="utf-8")
    except Exception:
        pass


# ---------------------------------------------------------------------------- hook handlers

def on_pre_llm_call(session_id: str = "", user_message=None, model=None, platform=None,
                    is_first_turn=None, **_):
    _emit("turn_start", sid=session_id, model=model, first=is_first_turn,
          msg=_clip(user_message))
    return None                                   # never inject context


def on_post_llm_call(session_id: str = "", model=None, **_):
    _emit("turn_end", sid=session_id, model=model)


def on_pre_tool_call(tool_name: str = "", args=None, session_id: str = "", task_id=None,
                     tool_call_id=None, **_):
    _emit("tool_start", sid=session_id, tool=tool_name, call=tool_call_id, task=task_id,
          args=_clip(args))
    if tool_name == CU_TOOL:
        return _cu_pre(args, session_id)          # None unless Bot ekranı is on for this profile
    return None                                   # never block or modify any other tool call


_FAILED = ("error", "failed", "blocked")


def _tool_error(status, error_type, error_message):
    """The error preview of a tool call: "<type>: <message>", or the bare message of a failed call."""
    if error_type:
        return _clip(f"{error_type}: {error_message or ''}")
    if status in _FAILED and error_message:
        return _clip(error_message)
    return None


def on_post_tool_call(tool_name: str = "", args=None, session_id: str = "", tool_call_id=None,
                      result=None, duration_ms=None, status=None, error_type=None,
                      error_message=None, **_):
    _emit("tool_end", sid=session_id, tool=tool_name, call=tool_call_id, ms=duration_ms,
          status=status, err=_tool_error(status, error_type, error_message), result=_clip(result))
    if tool_name in PLAN_TOOLS and status not in _FAILED:
        plan = parse_plan(tool_name, result)   # never raises; None for anything that is not a plan
        if plan is not None:
            _emit("plan", sid=session_id, **plan)
    if tool_name == CU_TOOL:
        _cu_post(args, session_id, result, status, error_message)


# ---------------------------------------------------------------------------- plan (the Deck's Plan tab)
#
# An agent's task list, from the full (unclipped) result of its todo tool:
#   todo_list / todo  Hermes' native tool: {"todos": [{id, content, status, parent?}], "revision": n}
#   omh_todo          the OMH plugin's tool: {"todo": {"items": [{text, state, phase, blocked_reason, depth}], ...}}
# becomes one `plan` event {sid, source: "todo"|"omh", rev, items: [{id, text, state, depth, phase?, blocked?}]}
# (state: pending|active|done|cancelled; at most PLAN_ITEMS items, each text at most PREVIEW chars, redacted).
# OMH is never imported: its result is parsed as plain JSON, and anything unexpected yields no event.

PLAN_TOOLS = {"todo_list": "todo", "todo": "todo", "omh_todo": "omh"}
PLAN_ITEMS = 64
PLAN_INPUT_MAX = 4 * 1024 * 1024          # a result longer than this is not parsed at all
PLAN_DEPTH_MAX = 3
_PLAN_TODO_STATES = {"pending": "pending", "in_progress": "active", "completed": "done", "cancelled": "cancelled"}
_PLAN_OMH_STATES = {"pending": "pending", "active": "active", "done": "done", "skipped": "cancelled",
                    "cancelled": "cancelled"}
_PLAN_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def _plan_text(value, limit: int = PREVIEW) -> str:
    if not isinstance(value, str):
        return ""
    s = _redact(_PLAN_CTRL.sub(" ", value)).strip()
    return s if len(s) <= limit else s[:limit - 1] + "…"


def _plan_rev(value) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)) and math.isfinite(value):
        return max(0, min(int(value), 2 ** 53 - 1))
    return 0


def _iso_ms(value) -> int:
    """An ISO-8601 time (OMH's updated_at, "...Z" included) as epoch milliseconds, else 0."""
    if not isinstance(value, str) or not value:
        return 0
    try:
        from datetime import datetime
        return _plan_rev(datetime.fromisoformat(value[:40].replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, OverflowError, OSError):
        return 0


def _plan_todo(data: dict):
    todos = data.get("todos")
    if not isinstance(todos, list) or "error" in data:
        return None
    rev = _plan_rev(data.get("revision"))
    if not todos and rev == 0:                  # an unused store reads back empty: not a plan (Hermes does the same)
        return None
    rows = [t for t in todos if isinstance(t, dict)]
    parents = {}
    for t in rows[:1024]:
        tid = t.get("id")
        if isinstance(tid, (str, int)) and not isinstance(tid, bool):
            parent = t.get("parent")
            parents[str(tid)] = str(parent) if isinstance(parent, (str, int)) and not isinstance(parent, bool) else ""

    def depth(tid: str) -> int:
        d, seen = 0, {tid}
        while d < PLAN_DEPTH_MAX:
            tid = parents.get(tid, "")
            if not tid or tid in seen or tid not in parents:
                break
            seen.add(tid)
            d += 1
        return d

    items = []
    for i, t in enumerate(rows[:PLAN_ITEMS]):
        tid = t.get("id")
        tid = str(tid)[:64] if isinstance(tid, (str, int)) and not isinstance(tid, bool) else str(i + 1)
        state = _PLAN_TODO_STATES.get(str(t.get("status") or "").strip().lower(), "pending")
        items.append({"id": tid, "text": _plan_text(t.get("content")), "state": state, "depth": depth(tid)})
    return {"source": "todo", "rev": rev, "items": items, "total": len(rows)}


def _plan_omh(data: dict):
    todo = data.get("todo")
    if not isinstance(todo, dict) or not isinstance(todo.get("items"), list):
        return None
    rows = [t for t in todo["items"] if isinstance(t, dict)]
    items = []
    for i, t in enumerate(rows[:PLAN_ITEMS]):
        raw_depth = t.get("depth")
        d = raw_depth if isinstance(raw_depth, int) and not isinstance(raw_depth, bool) else 0
        item = {"id": str(i + 1), "text": _plan_text(t.get("text")),
                "state": _PLAN_OMH_STATES.get(str(t.get("state") or "").strip().lower(), "pending"),
                "depth": max(0, min(d, PLAN_DEPTH_MAX))}
        phase = _plan_text(t.get("phase"), 80)
        if phase:
            item["phase"] = phase
        blocked = _plan_text(t.get("blocked_reason"))
        if blocked:
            item["blocked"] = blocked
        items.append(item)
    return {"source": "omh", "rev": _iso_ms(todo.get("updated_at")), "items": items, "total": len(rows)}


_plan_memo: list = [None, None, None]     # (tool name, result object, plan): the bridge part parses the same result


def parse_plan(tool_name, result):
    """{source, rev, items[, total]} from a todo tool's full result, or None. Never raises.

    `tool_name` picks the shape (PLAN_TOOLS); any other name tries both shapes (a call made through the
    tool-search bridge is stored under its bridge name). `total` is the list's real length when it was cut.
    The events and bridge parts both see one post_tool_call: the second parse of the same object is a lookup."""
    try:
        name, obj, plan = _plan_memo
        if obj is not None and obj is result and name == tool_name:
            return json.loads(json.dumps(plan)) if plan is not None else None
        plan = _parse_plan(tool_name, result)
        _plan_memo[:] = [tool_name, result, plan]
        return json.loads(json.dumps(plan)) if plan is not None else None
    except Exception:
        return None


def _parse_plan(tool_name, result):
    try:
        if isinstance(result, (bytes, bytearray)):
            result = bytes(result[:PLAN_INPUT_MAX + 1]).decode("utf-8", "replace")
        if isinstance(result, str):
            if len(result) > PLAN_INPUT_MAX:
                return None
            data = json.loads(result)
        else:
            data = result
        if not isinstance(data, dict):
            return None
        source = PLAN_TOOLS.get(tool_name)
        plan = (_plan_todo(data) if source == "todo" else _plan_omh(data) if source == "omh"
                else _plan_todo(data) or _plan_omh(data))
        if plan is not None and plan["total"] <= len(plan["items"]):
            del plan["total"]
        return plan
    except Exception:
        return None


def _usage(u) -> dict | None:
    if not isinstance(u, dict):
        return None
    return {k: v for k, v in u.items() if isinstance(v, (int, float)) and v}


def on_post_api_request(session_id: str = "", model=None, provider=None, usage=None,
                        api_duration=None, started_at=None, first_chunk_at=None,
                        finish_reason=None, context_length=None, message_count=None,
                        api_call_count=None, assistant_tool_call_count=None, **_):
    ttfb = None
    if isinstance(first_chunk_at, (int, float)) and isinstance(started_at, (int, float)):
        ttfb = round(first_chunk_at - started_at, 3)
    _emit("llm", sid=session_id, model=model, provider=provider, usage=_usage(usage),
          dur=round(api_duration, 3) if isinstance(api_duration, (int, float)) else None,
          ttfb=ttfb, finish=finish_reason, ctx_len=context_length, msgs=message_count,
          n=api_call_count, tool_calls=assistant_tool_call_count)
    _emit_usage_cost(session_id, model, provider, usage)


def _emit_usage_cost(session_id, model, provider, usage):
    """Native per-request cost, never interpreted as a subscription bill."""
    try:
        raw = usage.get("raw_usage") or {}
        cost = (raw.get("native_cost") or {}).get("total_cost_usd")
        if isinstance(cost, (int, float)) and not isinstance(cost, bool) and math.isfinite(cost) and cost >= 0:
            _emit("cost", sid=session_id, model=model, provider=provider, usd=cost, mode="delta",
                  estimated=True, cost_label="API list-price equivalent" if provider ==
                  "claude-subscription-directsdk-experimental" else "estimated")
    except Exception:
        pass


def on_post_auxiliary_call(session_id: str = "", aux_task=None, model=None, provider=None,
                           usage=None, api_duration=None, error_type=None, **_):
    _emit("aux", sid=session_id, task=aux_task, model=model, provider=provider,
          usage=_usage(usage), err=error_type,
          dur=round(api_duration, 3) if isinstance(api_duration, (int, float)) else None)
    _emit_usage_cost(session_id, model, provider, usage)


def on_subagent_start(parent_session_id: str = "", child_session_id: str = "",
                      child_subagent_id=None, parent_subagent_id=None, child_role=None,
                      child_goal=None, **_):
    _emit("sub_start", sid=parent_session_id, child=child_session_id, sa=child_subagent_id,
          parent_sa=parent_subagent_id, role=child_role, goal=_clip(child_goal))


def on_subagent_stop(parent_session_id: str = "", child_session_id: str = "", child_status=None,
                     child_summary=None, tool_call_history=None, duration_ms=None, **_):
    n_tools = len(tool_call_history) if isinstance(tool_call_history, list) else None
    _emit("sub_stop", sid=parent_session_id, child=child_session_id, status=child_status,
          ms=duration_ms, tools=n_tools, summary=_clip(child_summary))


def on_session_start(session_id: str = "", **_):
    _emit("session_start", sid=session_id)


def on_session_end(session_id: str = "", completed=None, failed=None, interrupted=None,
                   turn_exit_reason=None, **_):
    _emit("session_end", sid=session_id, completed=completed, failed=failed,
          interrupted=interrupted, reason=turn_exit_reason)
    with _cu_lock:
        _cu.pop(str(session_id or ""), None)


def on_agent_loop_stopped(session_key: str = "", **_):
    _emit("stopped", skey=session_key or None)


# ---------------------------------------------------------------------------- Bot ekranı (computer_use)
#
# Off unless this profile routes computer_use through the relay's deck-cua wrapper
# (HERMES_CUA_DRIVER_CMD -> .../relay/bin/deck-cua) or DECK_BOT_SCREEN=1 (0 forces it off). Then, for the
# computer_use tool only (docs/bot-screen-protocol.md):
#   pre_tool_call   asks the relay over its local socket where this session's computer_use goes and, on a
#                   user's device, holds the call to the window the user handed over (block or rewrite);
#   post_tool_call  stores the frame the agent saw (JPEG at most 1280 px wide) under ~/.hermes-deck/cu/ and
#                   appends a `cu` event with the action and its point in frame pixels;
#   route change    drops the session's cached driver connection when it still points at the old host.
# The relay checks every driver message to a device again (relay/src/mcpfence.js), and the deck's driver runs
# in bounded mode: this fence is one of three.

CU_TOOL = "computer_use"
FRAME_MAX_W = 1280
FRAME_QUALITY = 70
QUERY_TIMEOUT = 3.5   # above the relay's 2 s race for an agent desktop that is starting (driver.js)
# agent spaces: a queued computer_use waits here this long for the shared desktop. Hermes bounds a pre_tool_call
# hook at 30 s (plugins.hook_callback_timeout) and then blocks with a generic message, so the wait stays under it;
# the agent is told to retry, and the relay keeps its place in line (15 s) and its 120 s total from the first ask.
SPACE_WAIT_S = 24.0
SPACE_POLL_S = 2.0
_PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_FULL_SCREEN_APPS = {"screen", "fullscreen", "full screen", "all", "desktop"}
_INPUT = {"click", "double_click", "right_click", "middle_click", "drag", "scroll", "type", "key", "set_value"}
_LISTINGS = {"list_apps", "list_windows"}
_READS = {"capture"} | _LISTINGS            # agent spaces: these only look, so they never take the shared desktop
# computer_use actions, and the cua-driver tool names behind them, mapped to the `cu` event's action
_CU_ACTIONS = {"click": "click", "right_click": "click", "middle_click": "click",
               "double_click": "double_click", "type": "type", "type_text": "type", "key": "key",
               "press_key": "key", "hotkey": "key", "scroll": "scroll", "drag": "drag",
               "capture": "capture", "get_window_state": "capture", "screenshot": "capture"}
_DATA_URL = re.compile(r"^data:(image/[\w.+-]+);base64,(.+)$", re.S)
_EL_LINE = re.compile(r"#(\d+) .*? @ [\[(](-?[\d.]+), (-?[\d.]+), ([\d.]+), ([\d.]+)[\])]")
_cu_lock = threading.Lock()
_cu: dict = {}                       # hook session_id -> route, pinned target, last frame of that session


def _driver_sock() -> str:
    return os.environ.get("DECK_DRIVER_SOCK") or str(_deck_home() / "driver.sock")


def _bot_screen_on() -> bool:
    flag = os.environ.get("DECK_BOT_SCREEN", "").strip()
    if flag in ("0", "1"):
        return flag == "1"
    cmd = os.environ.get("HERMES_CUA_DRIVER_CMD", "").strip()
    if not cmd:
        return False
    names = {os.path.basename(cmd)}
    try:
        names.add(os.path.basename(os.path.realpath(os.path.expanduser(cmd))))
    except Exception:
        pass
    return any(n.startswith("deck-cua") for n in names)


def _session_env(name: str) -> str:
    """A HERMES_SESSION_* value exactly as Hermes copies it into a cua-driver child's env
    (tools/environments/local.py, _inject_session_context_env), so this fence and deck-cua send the relay
    the same routing key."""
    try:
        from gateway.session_context import _UNSET, _VAR_MAP, session_context_engaged
        var = _VAR_MAP.get(name)
        if var is not None:
            value = var.get()
            if value is not _UNSET:
                return "" if value is None else str(value)
            if session_context_engaged():
                return ""
    except Exception:
        pass
    return os.environ.get(name, "")


def _home_profile(home: str) -> str:
    """Profile of a HERMES_HOME path; deck-cua applies the same rule (relay/src/driver-wire.js)."""
    if not home:
        return "default"
    p = Path(os.path.expanduser(home))
    return p.name if p.parent.name == "profiles" and _PROFILE_RE.match(p.name) else "default"


def _route_identity() -> dict:
    """What deck-cua will tell the relay about this session: the HERMES_HOME Hermes gives the driver
    (a multiplexed turn's own home first), the gateway session key and the session id."""
    home = ""
    try:
        from hermes_constants import get_hermes_home_override
        home = get_hermes_home_override() or ""
    except Exception:
        pass
    home = home or os.environ.get("HERMES_HOME", "")
    return {"sid": _session_env("HERMES_SESSION_ID"), "skey": _session_env("HERMES_SESSION_KEY"),
            "profile": _home_profile(home)}


def _relay_query(identity: dict, timeout: float = QUERY_TIMEOUT):
    """One `query` on the relay's local driver socket: this session's route (and the grant on a device), or
    None when the relay cannot be reached."""
    if not hasattr(socket, "AF_UNIX"):
        return None
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            s.connect(_driver_sock())
            s.sendall((json.dumps({"t": "query", "v": 1, **identity}) + "\n").encode("utf-8"))
            buf = b""
            while b"\n" not in buf and len(buf) < (1 << 20):
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
        msg = json.loads(buf.split(b"\n", 1)[0] or b"null")
    except (OSError, ValueError):
        return None
    return msg if isinstance(msg, dict) and msg.get("t") == "route" else None


def _release_session(session_id: str) -> None:
    """Drop Hermes' cached cua-driver backend of this session; its next call starts deck-cua again."""
    from tools.computer_use.tool import release_computer_use_session
    release_computer_use_session(session_id)


def _cu_state(sid: str) -> dict:
    with _cu_lock:
        st = _cu.get(sid)
        if st is None:
            st = _cu[sid] = {"device": None, "epoch": None, "routed": False, "pinned": None, "grant": None,
                             "frame": None, "scale": 1.0, "elements": {}, "bscale": None, "window": None,
                             "n": 0}
        return st


def _block(message: str) -> dict:
    return {"action": "block", "message": message}


def _pos_int(v):
    """Positive int or None (models zero-fill optional ids; Hermes treats those as unset too)."""
    if isinstance(v, bool):
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _app_matches(asked: str, granted: str) -> bool:
    a, g = (asked or "").strip().lower(), (granted or "").strip().lower()
    return bool(a) and bool(g) and (a in g or g in a)


def _cu_pre(args, session_id):
    if not _bot_screen_on():
        return None
    try:
        return _cu_fence(args if isinstance(args, dict) else {}, str(session_id or ""))
    except Exception as e:  # fail closed: an unchecked call could land on the user's own window
        return _block(f"Bot ekranı: the Hermes Deck fence failed ({type(e).__name__}); computer_use was "
                      "refused to be safe. Tell the user.")


def _cu_fence(args: dict, session_id: str):
    """pre_tool_call for computer_use: None to proceed, else a block or modify directive."""
    action = str(args.get("action") or "").strip().lower()
    if action == "kill_app":
        return _block("Bot ekranı: kill_app is never allowed through Hermes Deck.")
    st = _cu_state(session_id)
    st["routed"] = False                      # until the relay names a host for this call
    ident = _route_identity()
    if action in _READS:
        ident = {**ident, "read": True}
    # the whole wait, slow queries included, ends by one monotonic deadline: Hermes bounds this hook at 30 s
    deadline = time.monotonic() + SPACE_WAIT_S
    r = _relay_query(ident, timeout=QUERY_TIMEOUT)
    while r is not None and not r.get("ok") and r.get("busy"):
        left = deadline - time.monotonic()
        if left <= 0:
            break
        time.sleep(min(SPACE_POLL_S, left))   # each query keeps this agent's place in the relay's queue
        left = deadline - time.monotonic()
        if left <= 0:
            break
        nxt = _relay_query(ident, timeout=min(QUERY_TIMEOUT, left))
        if nxt is None:
            break                             # out of time mid-answer: the last busy answer stands
        r = nxt
    if r is None:
        return _block("Bot ekranı: the Hermes Deck relay is not reachable on the agent host, so computer_use "
                      "has no route. Tell the user.")
    if not r.get("ok"):
        if r.get("busy"):
            return _block(f"{r.get('error') or 'The desktop is in use.'} Retry the same action now to keep your place in line.")
        return _block(str(r.get("error") or "Bot ekranı: no device is available for computer_use."))
    st["routed"] = True
    device = r.get("device")
    if st["device"] is not None and device != st["device"]:
        if r.get("live"):
            try:
                _release_session(session_id)   # its driver connection still points at the old host
            except Exception:
                pass                           # Hermes reconnects by itself once that connection dies
        st["pinned"] = None
    st["device"], st["epoch"] = device, r.get("epoch")
    deck_pid = _pos_int(r.get("deckPid"))
    if deck_pid and _pos_int(args.get("pid")) == deck_pid:
        return _block("Bot ekranı: that process is Hermes Deck itself; computer_use may not drive it.")
    if device == "host":
        st["grant"] = None
        return None
    if isinstance(device, str) and device.startswith("space:"):
        st["grant"] = None                     # the agent's own desktop: the whole desktop is its to use
        return None
    return _device_fence(action, args, st, str(r.get("name") or device), r.get("grant"), deck_pid)


def _device_fence(action: str, args: dict, st: dict, where: str, grant, deck_pid):
    """The fence on a user's device: only the window the user handed over (contract table "Fence")."""
    g = grant if isinstance(grant, dict) else {}
    win = g.get("window") if isinstance(g.get("window"), dict) else {}
    gpid, gwid, gapp = _pos_int(win.get("pid")), _pos_int(win.get("id")), str(g.get("app") or "")
    if not (gpid and gwid) or (deck_pid and gpid == deck_pid):
        st["grant"] = None
        return _block(f"Bot ekranı: the user has not handed you a window on {where}. Ask them to pick one "
                      "with Agent'a ver in Hermes Deck, or to let this run on the agent host.")
    st["grant"] = {"pid": gpid, "window_id": gwid, "app": gapp}
    title = str(win.get("title") or "") or f"window {gwid}"
    label = f"{gapp or 'the handed app'} ({title})"
    foreground = args.get("delivery_mode") == "foreground"
    if g.get("foreground") is True and (args.get("bring_to_front") or (action == "focus_app" and args.get("raise_window"))):
        return _block('Bot ekranı: use delivery_mode "foreground" on the input action itself; '
                      'Hermes Deck brings the handed window forward for it.')
    if ((foreground and not (g.get("foreground") is True and action in _INPUT)) or args.get("bring_to_front")
            or (action == "focus_app" and args.get("raise_window"))):
        return _block(f"Bot ekranı: foreground input would take over the user's mouse and keyboard on {where}. "
                      "Retry the same action without delivery_mode (background input reaches most apps and leaves "
                      "the user's own pointer alone). Only if the app ignores it: ask the user to allow foreground "
                      "control for this session in the Deck, or use the host.")
    asked = args.get("app").strip() if isinstance(args.get("app"), str) else ""
    pinned = {"pid": gpid, "window_id": gwid, "app": gapp or None}
    if action == "capture":
        if asked.lower() in _FULL_SCREEN_APPS:
            return _block(f"Bot ekranı: full-screen and desktop captures are off on {where}; you can only see "
                          f"{label}.")
        pid, wid = _pos_int(args.get("pid")), _pos_int(args.get("window_id"))
        if (pid and pid != gpid) or (wid and wid != gwid) or (asked and gapp and not _app_matches(asked, gapp)):
            return _block(f"Bot ekranı: on {where} you can only capture {label}.")
        st["pinned"] = (gpid, gwid)
        return {"action": "modify", "args": pinned}
    if action == "focus_app":
        if not (asked and gapp and _app_matches(asked, gapp)):
            return _block(f"Bot ekranı: on {where} you can only use {label}.")
        st["pinned"] = (gpid, gwid)
        # focusing only picks the input target; an exact capture of the handed window does that without
        # landing on another window of the same app
        return {"action": "modify", "args": {"action": "capture", "mode": "ax", "raise_window": None, **pinned}}
    if action in _LISTINGS:
        return _block(f"Bot ekranı: listing apps and windows is off on {where}; you can only see {label}, and "
                      "capture() targets it.")
    if action in _INPUT:
        pid, wid = _pos_int(args.get("pid")), _pos_int(args.get("window_id"))
        if (pid and pid != gpid) or (wid and wid != gwid):
            return _block(f"Bot ekranı: on {where} input only goes to {label}.")
        if asked and gapp and not _app_matches(asked, gapp):
            return _block(f"Bot ekranı: on {where} input only goes to {label}.")
        if st["pinned"] != (gpid, gwid):
            return _block(f"Bot ekranı: capture first. On {where} capture() targets {label}, and input goes "
                          "to the last capture.")
        if foreground:
            return {"action": "modify", "args": pinned}
    return None


def _cu_parts(result):
    """(payload, summary text, image bytes or None, mime) of a computer_use result."""
    payload, text, image, mime = {}, "", None, None
    if isinstance(result, dict) and result.get("_multimodal"):
        if isinstance(result.get("meta"), dict):
            payload.update(result["meta"])
        if isinstance(result.get("action_result"), dict):
            payload.update(result["action_result"])
        text = str(result.get("text_summary") or "")
        for part in result.get("content") or []:
            if not (isinstance(part, dict) and part.get("type") == "image_url"):
                continue
            iu = part.get("image_url")
            m = _DATA_URL.match(str(iu.get("url") if isinstance(iu, dict) else iu or ""))
            if m:
                try:
                    image, mime = base64.b64decode(m.group(2)), m.group(1)
                except ValueError:
                    image = None
                break
    elif isinstance(result, str):
        try:
            v = json.loads(result)
        except ValueError:
            v = None
        if isinstance(v, dict):
            payload, text = v, str(v.get("summary") or "")
    if image is None:
        path = payload.get("screenshot_path")
        # only Hermes' own capture copies (cache/images/computer_use_*), never any path a result names
        if isinstance(path, str) and os.path.basename(path).startswith("computer_use_") and os.path.isfile(path):
            try:
                image = Path(path).read_bytes()
                mime = "image/jpeg" if path.lower().endswith((".jpg", ".jpeg")) else "image/png"
            except OSError:
                image = None
    return payload, text, image, mime


def _cu_elements(payload: dict, text: str) -> dict:
    """element index -> (x, y, w, h) from a capture: the JSON element list, else the summary lines."""
    out = {}
    for e in payload.get("elements") or []:
        b = e.get("bounds") if isinstance(e, dict) else None
        if isinstance(e, dict) and isinstance(e.get("index"), int) and isinstance(b, list) and len(b) == 4:
            try:
                out[e["index"]] = tuple(float(v) for v in b)
            except (TypeError, ValueError):
                pass
    if not out and text:
        for m in _EL_LINE.finditer(text):
            out[int(m.group(1))] = tuple(float(m.group(i)) for i in range(2, 6))
    return out


def _xy(v):
    ok = isinstance(v, (list, tuple)) and len(v) == 2 and all(
        isinstance(c, (int, float)) and not isinstance(c, bool) for c in v)
    return (float(v[0]), float(v[1])) if ok else None


def _cu_point(action: str, args: dict, st: dict):
    """Where an action lands, in pixels of the session's last frame, or (None, None)."""
    def element(i):
        b = st["elements"].get(i) if isinstance(i, int) and not isinstance(i, bool) else None
        if not b:
            return None
        bs = st["bscale"] or 1.0
        return (b[0] + b[2] / 2) / bs, (b[1] + b[3] / 2) / bs
    p = None
    if action in ("click", "double_click", "right_click", "middle_click", "scroll", "set_value"):
        p = _xy(args.get("coordinate")) or element(args.get("element"))
    elif action == "drag":
        p = _xy(args.get("from_coordinate")) or element(args.get("from_element"))
    if p is None:
        return None, None
    sc = st["scale"] or 1.0
    return round(p[0] * sc), round(p[1] * sc)


def _safe_name(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", s or "")[:120].strip(".") or "nosession"


def _png_width(data: bytes) -> int:
    if data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
        return int.from_bytes(data[16:20], "big")
    return 0


def _encode_frame(data: bytes):
    """(bytes, ext, frame width, source width): a JPEG at most FRAME_MAX_W wide when Pillow can read the
    image, else the original bytes (the relay serves either)."""
    try:
        from PIL import Image
        with Image.open(io.BytesIO(data)) as src:
            src.load()
            sw, sh = src.size
            img = src if src.mode in ("RGB", "L") else src.convert("RGB")
            if sw > FRAME_MAX_W:
                resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
                img = img.resize((FRAME_MAX_W, max(1, round(sh * FRAME_MAX_W / sw))), resample)
            out = io.BytesIO()
            img.save(out, "JPEG", quality=FRAME_QUALITY, optimize=True)
            return out.getvalue(), ".jpg", img.size[0], sw
    except Exception:
        w = _png_width(data)
        return data, (".jpg" if data[:3] == b"\xff\xd8\xff" else ".png"), w, w


def _write_private(path: Path, data: bytes) -> None:
    """0600 temp file, then rename: the relay never serves half a frame."""
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0), 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def _save_frame(data: bytes, session_id: str, st: dict):
    """One frame under $DECK_HOME/cu/<profile>/<sid>/<n>.jpg -> (name relative to cu/, frame w, source w)."""
    blob, ext, fw, sw = _encode_frame(data)
    root = _deck_home() / "cu"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    rel = f"{_safe_name(_profile_name())}/{_safe_name(session_id)}"
    (root / rel).mkdir(parents=True, exist_ok=True, mode=0o700)
    with _cu_lock:
        st["n"] = n = max(int(time.time() * 1000), st["n"] + 1)
    _write_private(root / rel / f"{n}{ext}", blob)
    return f"{rel}/{n}{ext}", fw, sw


def _cu_post(args, session_id, result, status, error_message):
    if not _bot_screen_on():
        return
    try:
        _cu_record(args if isinstance(args, dict) else {}, str(session_id or ""), result, status,
                   error_message)
    except Exception:
        pass                                   # a lost frame must never break a turn


def _cu_record(args: dict, session_id: str, result, status, error_message) -> None:
    """post_tool_call for computer_use: the frame the agent saw and a `cu` event."""
    action = str(args.get("action") or "").strip().lower()
    st = _cu_state(session_id)
    x, y = _cu_point(action, args, st)        # in the frame the agent acted on, before this result's frame
    payload, text, image, mime = _cu_parts(result)
    frame = None
    if image:
        frame, fw, sw = _save_frame(image, session_id, st)
        st["frame"], st["scale"] = frame, (fw / sw if fw and sw else 1.0)
    elif payload.get("screen_unchanged") or action not in ("capture", "focus_app"):
        frame = st["frame"]                    # same picture as before, or an action on the last frame
    elements = _cu_elements(payload, text)
    if elements or image:
        st["elements"] = elements
        bs = payload.get("bounds_scale")
        st["bscale"] = float(bs) if isinstance(bs, (int, float)) and not isinstance(bs, bool) and bs > 0 else None
    g = st.get("grant")
    if st["device"] not in (None, "host") and g:
        window = {"id": g["window_id"], "app": g["app"] or None}
    elif action == "capture":
        app = args.get("app") if isinstance(args.get("app"), str) and args.get("app") else payload.get("app")
        wid = _pos_int(args.get("window_id"))
        st["window"] = window = {"id": wid, "app": app or None} if (wid or app) else None
    else:
        window = st["window"]
    ok, err = status in (None, "ok"), None
    if status == "blocked":
        ok, err = False, error_message
    else:
        if payload.get("ok") is False or payload.get("error"):
            ok, err = False, payload.get("error") or payload.get("message")
        if status == "error":
            ok, err = False, err or error_message
    if not ok and not err:
        err = error_message or status or "failed"
    if not ok and action in ("capture", "focus_app"):
        st["pinned"] = None                  # input needs a successful frame, not just a capture attempt
    if not ok and st.get("routed") and st["device"] not in (None, "host") and "connection closed" in str(err).lower():
        # A dead MCP backend is cached by Hermes; retire it, never replay an input with an unknown outcome.
        try:
            _release_session(session_id)
        except Exception:
            pass
        st["pinned"], st["frame"], st["elements"], st["bscale"] = None, None, {}, None
    rec = {"type": "cu", "sid": session_id, "profile": _profile_name(), "ts": int(time.time() * 1000),
           "action": _CU_ACTIONS.get(action, "other"), "x": x, "y": y, "window": window, "frame": frame,
           "device": st["device"] if st.get("routed") else None, "ok": ok,
           "error": _clip(err) if err else None}
    if rec["action"] != action:
        rec["raw"] = action
    rec.update({k: v for k, v in _ctx().items() if k not in rec})
    _append(rec)


HOOKS = {
    "pre_llm_call": on_pre_llm_call,
    "post_llm_call": on_post_llm_call,
    "pre_tool_call": on_pre_tool_call,
    "post_tool_call": on_post_tool_call,
    "post_api_request": on_post_api_request,
    "post_auxiliary_call": on_post_auxiliary_call,
    "subagent_start": on_subagent_start,
    "subagent_stop": on_subagent_stop,
    "on_session_start": on_session_start,
    "on_session_end": on_session_end,
    "agent_loop_stopped": on_agent_loop_stopped,
}


# ---------------------------------------------------------------------------- state snapshots

QUOTA_EVERY = 300
QUOTA_TIMEOUT = 25
_quota_cache = {}
_quota_jobs = {}
_quota_due = {}
_quota_failures = {}
_quota_lock = threading.Lock()
_quota_settled = {}          # provider -> wall-clock start of the last fetch that finished (reported) for it
_quota_force_since = 0.0     # wall clock of the newest on-demand refresh request; fetches started before it are redone
_quota_ack = None            # {"id": ...} of the last on-demand refresh whose fetches all settled (published in the snapshot)
QUOTA_TRIGGER = "quota-refresh.json"   # written by the relay (POST /fleet/quotas/refresh) into the state dir
QUOTA_POLL = 1.0             # seconds between trigger-file checks
_QUOTA_PROVIDERS = {"claude": "anthropic", "codex": "openai-codex"}


def _configured_quota_providers(home: Path):
    """Read provider names only; never publish config or account identities."""
    try:
        import yaml
        config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8")) or {}
        found = set()
        def visit(value):
            if isinstance(value, dict):
                provider = value.get("provider")
                if provider in ("anthropic", "claude-subscription-directsdk-experimental"):
                    found.add("claude")
                elif provider == "openai-codex":
                    found.add("codex")
                for child in value.values():
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)
        visit(config)
        return sorted(found)
    except Exception:
        return []


def _profile_secret_scope(home: Path):
    """Bind this profile's secret scope on the current (bare) thread.

    A multiplexing gateway (gateway.multiplex_profiles) fails closed on credential reads from a
    thread without a profile scope (UnscopedSecretError), and fetch_account_usage swallows that into
    None. Our quota worker is a plain threading.Thread, so it must install the scope itself.
    Returns a reset token, or None when this Hermes has no secret scoping."""
    try:
        from agent import secret_scope
    except Exception:
        return None
    if secret_scope.current_secret_scope() is not None:
        return None
    return secret_scope.set_secret_scope(secret_scope.build_profile_secret_scope(Path(home)),
                                         profile_home=str(home))


def _fetch_quota(provider: str, home: "Path | None" = None) -> dict:
    """One read-only Hermes account-usage fetch; return the CodexBar-compatible safe shape."""
    checked = round(time.time(), 3)
    q = {"provider": provider, "ok": False, "checkedAt": checked, "fetched_at": None,
         "error": None, "windows": [], "source": "hermes-account-usage"}
    token = None
    try:
        if home is not None:
            token = _profile_secret_scope(home)
        from agent.account_usage import fetch_account_usage
        snapshot = fetch_account_usage(_QUOTA_PROVIDERS[provider])
        if snapshot is None or snapshot.unavailable_reason:
            raise ValueError("unavailable")
        for window in snapshot.windows:
            label = window.label.lower()
            minutes = 10080 if "week" in label else 300 if "session" in label else None
            used = window.used_percent
            if minutes and isinstance(used, (int, float)) and math.isfinite(used):
                q["windows"].append({"minutes": minutes, "used": max(0, min(100, used)),
                                     "resetsAt": window.reset_at.isoformat() if window.reset_at else None})
        if not q["windows"]:
            raise ValueError("no windows")
        q.update(ok=True, fetched_at=snapshot.fetched_at.timestamp(), updatedAt=snapshot.fetched_at.isoformat())
    except Exception:
        # Errors can contain credentials/identities; only expose a coarse reason.
        q.update(error="unavailable", err="unavailable")
    finally:
        if token is not None:
            from agent import secret_scope
            secret_scope.reset_secret_scope(token)
    return q


def _quota_snapshot(home: Path) -> dict:
    """Nonblocking cache pump, called only by the gateway snapshot loop.

    A timed-out daemon remains tracked until it exits: never pile up threads for a stuck provider.
    Successes refresh every five minutes; failures back off to at most thirty minutes.
    """
    providers = _configured_quota_providers(home)
    now = time.monotonic()
    with _quota_lock:
        for provider in providers:
            job = _quota_jobs.get(provider)
            if job and (not job["thread"].is_alive() or now - job["started"] >= QUOTA_TIMEOUT):
                if not job.get("reported"):
                    within_deadline = job.get("finished", now) - job["started"] <= QUOTA_TIMEOUT
                    result = job.get("result") if not job["thread"].is_alive() and within_deadline else None
                    result = result or {"provider": provider, "ok": False, "checkedAt": time.time(),
                                        "fetched_at": None, "windows": [], "error": "timeout", "err": "unavailable"}
                    if result.get("ok"):
                        _quota_failures[provider] = 0
                        _quota_cache[provider] = result
                    else:
                        _quota_failures[provider] = min(3, _quota_failures.get(provider, 0) + 1)
                        cached = _quota_cache.get(provider)
                        _quota_cache[provider] = {**cached, "error": result["error"], "stale": True} if cached and cached.get("ok") else result
                    _quota_due[provider] = now + min(1800, QUOTA_EVERY * 2 ** _quota_failures[provider])
                    if job.get("wall", 0) < _quota_force_since:
                        _quota_due[provider] = 0          # started before an on-demand refresh: fetch again now
                    else:
                        _quota_settled[provider] = job.get("wall", 0)
                    job["reported"] = True
                if not job["thread"].is_alive():
                    _quota_jobs.pop(provider, None)
            if provider not in _quota_jobs and now >= _quota_due.get(provider, 0):
                job = {"started": now, "wall": time.time()}
                def run(p=provider, j=job, h=home):
                    try:
                        j["result"] = _fetch_quota(p, h)
                    except Exception:
                        j["result"] = {"provider": p, "ok": False, "error": "unavailable", "err": "unavailable", "windows": []}
                    j["finished"] = time.monotonic()
                job["thread"] = threading.Thread(target=run, name=f"deck-quota-{provider}", daemon=True)
                _quota_jobs[provider] = job
                job["thread"].start()
            _quota_cache.setdefault(provider, {"provider": provider, "ok": False, "windows": [],
                                               "error": "pending", "fetched_at": None})
        return {p: dict(_quota_cache[p]) for p in providers}



def _quota_request_refresh(ident) -> None:
    """On-demand refresh: every provider is fetched again now (a fetch already in flight is redone once it ends)."""
    global _quota_force_since
    with _quota_lock:
        _quota_force_since = time.time()
        for provider in list(_quota_cache) + list(_QUOTA_PROVIDERS):
            _quota_due[provider] = 0
            _quota_failures[provider] = 0


def _quota_refresh_settled(home: Path) -> bool:
    providers = _configured_quota_providers(home)
    with _quota_lock:
        return all(_quota_settled.get(p, 0) >= _quota_force_since for p in providers)


def _read_quota_trigger():
    """(id, requested_at_epoch_s) from the relay's trigger file, or None."""
    try:
        data = _read_json(_deck_dir("state") / QUOTA_TRIGGER)
        ident = data.get("id")
        if isinstance(ident, (int, float)) and not isinstance(ident, bool):
            return ident, float(data.get("at") or 0)
    except Exception:
        pass
    return None


_db_cost_cache = {}


def _db_read_copy(file: Path, directory: Path) -> Path:
    import shutil
    def stamp(p):
        try:
            s = p.stat()
            return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns
        except FileNotFoundError:
            return None
    files = [file, Path(str(file) + "-wal")]
    before = [stamp(p) for p in files]
    # ponytail: 512 MiB per snapshot; larger stores need a counter export instead of full copies.
    if sum(s[2] for s in before if s) > 512 * 1024 * 1024:
        raise ValueError("snapshot too large")
    for p, s in zip(files, before):
        if s:
            shutil.copyfile(p, directory / p.name)
    if [stamp(p) for p in files] != before:
        raise ValueError("store changed during snapshot")
    return directory / file.name


def _db_costs_once(home: Path) -> None:
    """Gateway-thread fallback: modern Hermes strips native cost from hook summaries.

    Publish persisted cumulative costs as absolute display snapshots; no hook blocks on SQLite.
    This is not another accounting source: relay totals still come only from state.db.
    """
    try:
        import sqlite3
        import tempfile
        from contextlib import closing
        file = home / "state.db"
        # mode=ro may still create/write source sidecars. Only the private copy is opened by SQLite.
        with tempfile.TemporaryDirectory(prefix="deck-usage-read-") as tmp, closing(sqlite3.connect(
                _db_read_copy(file, Path(tmp)).resolve().as_uri() + "?mode=ro", uri=True, timeout=1)) as db:
            db.execute("PRAGMA query_only=ON")
            cols = {row[1] for row in db.execute("PRAGMA table_info(sessions)")}
            if not {"id", "model", "estimated_cost_usd", "actual_cost_usd"}.issubset(cols):
                return
            provider = "billing_provider" if "billing_provider" in cols else "NULL"
            seen = set()
            for sid, model, provider, estimate, actual in db.execute(
                    f"SELECT id, model, {provider}, estimated_cost_usd, actual_cost_usd FROM sessions"):
                seen.add(sid)
                cost = actual if actual is not None else estimate
                if not isinstance(cost, (int, float)) or not math.isfinite(cost) or cost < 0:
                    continue
                value = (cost, actual is None, provider, model)
                if _db_cost_cache.get(sid) == value:
                    continue
                _db_cost_cache[sid] = value
                _emit("cost", sid=sid, model=model, provider=provider, usd=cost, mode="absolute",
                      estimated=actual is None, source="state.db", cost_label="API list-price equivalent"
                      if provider == "claude-subscription-directsdk-experimental" else None)
            for sid in list(_db_cost_cache):
                if sid not in seen:
                    _db_cost_cache.pop(sid, None)
    except Exception:
        pass


_CRON_FIELDS = ("id", "name", "schedule_display", "enabled", "state", "next_run_at", "last_run_at",
                "last_status", "failure_streak", "paused_at", "model", "provider")


def _read_json(p: Path):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def _snapshot_once(home: Path) -> bool:
    """Write one state snapshot. Returns False when this process is not the profile's gateway."""
    gs = _read_json(home / "gateway_state.json")
    if gs.get("pid") != os.getpid():
        return False
    snap = {
        "ts": round(time.time(), 3), "profile": _profile_name(), "pid": gs.get("pid"),
        "quotas": _quota_snapshot(home), "quota_refresh": _quota_ack,
        "gateway": {k: gs.get(k) for k in ("gateway_state", "active_agents", "active_work", "updated_at",
                                           "code_version", "exit_reason", "restart_requested")},
        "platforms": {name: {"state": p.get("state"), "error": _clip(p.get("error_message")),
                             "needs_attention": p.get("needs_attention")}
                      for name, p in (gs.get("platforms") or {}).items() if isinstance(p, dict)},
    }
    try:
        jobs = _read_json(home / "cron" / "jobs.json").get("jobs") or []
        snap["cron"] = [{**{k: j.get(k) for k in _CRON_FIELDS},
                         "last_error": _clip(j.get("last_error")),
                         "last_delivery_error": _clip(j.get("last_delivery_error"))} for j in jobs]
    except FileNotFoundError:
        snap["cron"] = []
    out = _deck_dir("state") / f"{_profile_name()}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(snap, ensure_ascii=False, default=str), encoding="utf-8")
    os.replace(tmp, out)
    return True


def _snapshot_loop() -> None:
    try:
        from hermes_constants import get_hermes_home
        home = Path(get_hermes_home())
    except Exception:
        return
    misses = 0
    handled = None                 # id of the newest trigger seen; one at startup counts only when it is fresh
    pending = None                 # trigger id being served: pump the quota workers until they settle
    pending_since = 0.0
    next_snap = 0.0
    first = True
    global _quota_ack
    while True:
        try:
            now = time.monotonic()
            trig = _read_quota_trigger()
            if trig and trig[0] != handled:
                handled = trig[0]
                if not first or time.time() - trig[1] < 120:
                    _quota_request_refresh(trig[0])
                    pending, pending_since = trig[0], now
            first = False
            if pending is not None:
                _quota_snapshot(home)                  # nonblocking pump: starts/reaps the fetch workers
                if _quota_refresh_settled(home):
                    _quota_ack = {"id": pending, "at": round(time.time(), 3)}
                    pending = None
                    next_snap = 0.0                    # publish the new numbers (and the ack) immediately
                elif now - pending_since > QUOTA_TIMEOUT + 15:
                    pending = None                     # a provider call is stuck: stop pumping, the relay already timed out
            if now >= next_snap:
                if _snapshot_once(home):
                    _db_costs_once(home)
                    misses = 0
                else:
                    misses += 1
                    if misses >= 3:                    # not the gateway (CLI, cron worker): stop quietly
                        return
                next_snap = time.monotonic() + SNAP_EVERY
        except Exception:
            pass
        time.sleep(QUOTA_POLL)


def _start_snapshots() -> None:
    global _snap_started
    if not _snap_started:
        _snap_started = True
        threading.Thread(target=_snapshot_loop, name="deck-events-snap", daemon=True).start()


def register(ctx):
    for name, fn in HOOKS.items():
        ctx.register_hook(name, fn)
    _start_snapshots()
