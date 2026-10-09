"""hermes-deck bridge stream: native Hermes snapshots and controls over stdio; no network listener.

Hermes Deck's direct connection (app/main/bridge.js) runs `python -I stream.py --follow` on the Hermes host
over SSH, WSL or a local process and speaks newline-delimited JSON-RPC 2.0 with it:
  stream -> app   hermes-deck.v1 snapshots (at least every 5 s), replies, native events, server requests;
  app -> stream   requests, relayed to the plugin's control socket (observer.py): native.* to the socket of
                  the process that owns the turn, everything else to the main gateway's socket, in order.
A request that cannot be delivered fails with JSON-RPC error -32001; nothing is ever replayed.

The home is inferred from the installed entry point.
Only the Hermes Deck schema and runtime layout are supported.
"""
import argparse
import json
import os
import time
import sys
import socket
import threading
import queue
import re
import sqlite3
from contextlib import closing
from pathlib import Path

CONTROL_TIMEOUT = 3
# deck.attach_submit carries up to ~67 MB of base64 in one line (kept equal to observer.ATTACH_*): its deadline is longer.
ATTACH_METHOD = "deck.attach_submit"
ATTACH_LINE_MAX = 50 * 1024 * 1024 * 4 // 3 + 256 * 1024
ATTACH_TIMEOUT = 60
# deck.transcribe (dictation) carries one audio clip; deck.file_read (downloads of files the agent offered) is a
# small request whose reply is a 1 MiB base64 chunk. Both are served by observer.py; the numbers below are kept equal to
# observer.TRANSCRIBE_* (test_voice_files.py checks that).
TRANSCRIBE_METHOD = "deck.transcribe"
TRANSCRIBE_LINE_MAX = 25 * 1024 * 1024 * 4 // 3 + 64 * 1024
TRANSCRIBE_TIMEOUT = 110
FILE_METHOD = "deck.file_read"
FILE_TIMEOUT = 20
LINE_MAX = {ATTACH_METHOD: ATTACH_LINE_MAX, TRANSCRIBE_METHOD: TRANSCRIBE_LINE_MAX}
DEADLINES = {ATTACH_METHOD: ATTACH_TIMEOUT, TRANSCRIBE_METHOD: TRANSCRIBE_TIMEOUT, FILE_METHOD: FILE_TIMEOUT}
# A dictation can take a minute on a CPU-only host: like native.* it gets its own short-lived control connection and
# its own thread, so it never holds up the ordered queue (prompts, approvals) or the persistent gateway socket.
# deck.file_read stays on the persistent connection: its per-connection read budget (observer.ReadBudget) only means
# something there, and one chunk is a quick read. A reply frame holds a 1 MiB chunk as base64 (1.4 MiB) plus its
# envelope: under the 2 MiB frame limit.
ONE_SHOT = {TRANSCRIBE_METHOD}
SCHEMA = "hermes-deck.v1"
RUNTIME_DIR = "hermes-deck"
# The product version (root compat.json; relay/test/compat.test.js keeps these equal) and the wire protocol, which
# changes only on a breaking change. deck.version answers with them here, without asking Hermes: this file is also
# installed alone as <home>/hermes-deck/stream.py, so it carries its own copy. Apps before 0.3.6 never ask.
VERSION = "1.2.3"
PROTOCOL = 1
VERSION_METHOD = "deck.version"
CONNECTION_ID = "hermes"


def _session_key(profile, sid):
    """Session IDs are local to each profile; empty/invalid profiles use the default scope."""
    return (profile if isinstance(profile, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", profile)
            else "default", sid)


def alive(pid):
    try:
        pid = int(pid)
    except (ValueError, TypeError):
        return False
    if pid <= 0:                       # 0 and negative ids name process groups, never one process
        return False
    if os.name == "nt":
        # os.kill(pid, 0) sends CTRL_C_EVENT on Windows. The stream itself refuses to run there; this keeps a
        # stray call (tests, tooling) from ever signalling another process.
        return pid == os.getpid()
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _alive(pid):
    """alive() looked up at call time, so a test can replace the module's alive()."""
    return alive(pid)


def safe_title(value):
    if not isinstance(value, str) or not value.strip():
        return ""
    title = value.splitlines()[0][:4096]
    title = re.sub(r"(?i)\bBearer\s+[^\s,;]+", "Bearer [redacted]", title)
    title = re.sub(r"(?i)\b(api[ _-]?key|access[ _-]?token|client[ _-]?secret|token|password|secret|authorization)\b[\"']?\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)", r"\1=[redacted]", title)
    title = re.sub(r"\b(?:sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)", "[redacted]", title)
    title = re.sub(r"(https?://)[^/\s:@]+:[^/\s@]+@", r"\1[redacted]@", title)
    return re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", " ", title)).strip()[:80]


def default_home(script=None, environ=None):
    """The home served by the runtime or plugin-directory entry point.
    Otherwise HERMES_HOME, else ~/.hermes. A profile home maps to its root."""
    environ = os.environ if environ is None else environ
    here = Path(os.path.abspath(script or __file__)).parent      # not resolved: an installed symlink counts
    if here.parent.name == "plugins":
        home = here.parent.parent
    elif here.name == RUNTIME_DIR and here.parent.name != "hermes-plugin":
        home = here.parent
    else:
        home = Path(environ.get("HERMES_HOME") or Path.home()/".hermes").expanduser()
    if home.parent.name == "profiles":
        home = home.parent.parent
    return home


def profile_homes(home):
    home = Path(home).resolve()
    homes, seen = [("default",home)], {home}
    profiles = home/"profiles"
    try:
        if not profiles.resolve().is_relative_to(home): return homes
        for path in sorted(profiles.glob("*")):
            if len(homes) >= 33: break
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}",path.name): continue
            resolved = path.resolve()
            if resolved in seen or not resolved.is_relative_to(home) or not resolved.is_dir(): continue
            homes.append((path.name,resolved))
            seen.add(resolved)
    except (OSError,ValueError,RuntimeError):
        pass
    return homes


def observer_bases(home):
    home, seen = Path(home).resolve(), set()
    for profile, profile_home in profile_homes(home):
        try:
            base = (profile_home/RUNTIME_DIR).resolve()
            if base in seen or not base.is_relative_to(home) or (base/"processes").resolve().parent != base:
                continue
            seen.add(base)
            yield profile, base
        except (OSError,ValueError,RuntimeError):
            continue


def enrich_child_titles(home, nodes):
    """Prefer an existing native title over the hook's bounded task-line fallback."""
    home = Path(home).resolve()
    homes = dict(profile_homes(home))
    groups = {}
    for node in nodes:
        if not node.get("parent_session_id"):
            continue
        profile = node.get("profile_name") or "default"
        if not isinstance(profile,str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}",profile):
            continue
        groups.setdefault(profile, []).append(node)
    for profile, children in groups.items():
        if profile not in homes: continue
        path = homes[profile]/"state.db"
        if not path.is_file():
            continue
        try:
            with closing(sqlite3.connect(path.as_uri()+"?mode=ro",uri=True,timeout=.2)) as db:
                ids = [n["session_id"] for n in children][:512]
                query = "SELECT id,title FROM sessions WHERE id IN ("+",".join("?" for _ in ids)+")"
                titles = {sid:safe_title(title) for sid,title in db.execute(query,ids) if title}
                for node in children:
                    if title := titles.get(node["session_id"]):
                        node["title"] = title
                        node["name"] = f"{'OMH' if node.get('origin') == 'omh' else 'Hermes'} · {title}"
        except (OSError,ValueError,TypeError,sqlite3.Error):
            continue


def collect_nodes(directory, now=None, alive=None):
    alive = alive or _alive
    now = time.time() if now is None else now
    directory = Path(directory).resolve()
    merged = {}
    for file in directory.glob("*.json"):
        try:
            if file.resolve().parent != directory or file.stat().st_size > 2 * 1024 * 1024:
                continue
            data = json.loads(file.read_text(encoding="utf-8"))
            if (data.get("schema") != SCHEMA or str(data.get("pid")) != file.stem
                    or not alive(data["pid"]) or now - float(data["updated_at"]) > 45):
                continue
            for sid, node in data.get("nodes", {}).items():
                if not isinstance(node, dict) or node.get("session_id") != sid:
                    continue
                ended = node.get("terminal_at")
                if ended is not None and now - float(ended) >= 120:
                    continue
                key = _session_key(node.get("profile_name"), sid)
                if key not in merged or float(node["updated_at"]) > float(merged[key]["updated_at"]):
                    merged[key] = dict(node, owner_pid=data["pid"])
                    for field in ("title", "name"):
                        if field in merged[key]:
                            merged[key][field] = safe_title(merged[key][field])
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return list(merged.values())


def collect_observer_nodes(home, now=None, alive=None):
    merged = {}
    for profile, base in observer_bases(home):
        for node in collect_nodes(base/"processes",now=now,alive=alive):
            if not node.get("profile_name") or (profile != "default" and node["profile_name"] == "default"):
                node["profile_name"] = profile
            key = _session_key(node.get("profile_name"), node["session_id"])
            if key not in merged or float(node["updated_at"]) > float(merged[key]["updated_at"]):
                merged[key] = node
    return list(merged.values())


def collect_registered_nodes(home, now=None, alive=None):
    """Read canonical current conversations and live leases, never unended historical rows.

    Preloaded CLI/dashboard processes may lack the observer plugin. Their native
    lease records remain observable, but provide no live agent control authority.
    """
    alive = alive or _alive
    home = Path(home).resolve()
    now = time.time() if now is None else now
    candidates, metadata = {}, {}
    # Ghost filter state: ids whose existence in a profile's `sessions` table was actually checked, and whether any
    # profile database could not be checked (then nothing is dropped: absence of proof is not proof of absence).
    queried, unverified = set(), False
    for profile, profile_home in profile_homes(home):
        try:
            registry = json.loads((profile_home/"runtime"/"active_sessions.json").read_text())
            entries = registry.get("entries", []) if isinstance(registry, dict) else registry
            for entry in entries[:256]:
                if not isinstance(entry, dict) or not entry.get("session_id") or not alive(entry.get("pid")):
                    continue
                candidates.setdefault(_session_key(profile, str(entry["session_id"])), {}).update(
                    profile_name=profile, owner_pid=entry["pid"], source=str(entry.get("surface") or ""),
                    observation_source="active_registry", updated_at=now, active=False, live_proof=True)
        except (OSError, ValueError, TypeError):
            pass
        db_path = profile_home/"state.db"
        if not db_path.is_file():
            continue
        try:
            with closing(sqlite3.connect(db_path.resolve().as_uri()+"?mode=ro", uri=True, timeout=.2)) as db:
                db.row_factory = sqlite3.Row
                tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                # The main gateway's routing index spans runtime profiles;
                # the receiving transport can belong to a different profile.
                if profile_home == home and "gateway_routing" in tables:
                    for row in db.execute("SELECT entry_json,updated_at FROM gateway_routing ORDER BY updated_at DESC LIMIT 256"):
                        entry = json.loads(row["entry_json"])
                        sid = str(entry.get("session_id") or "")
                        if not sid or entry.get("suspended") or entry.get("expiry_finalized"):
                            continue
                        origin = entry.get("origin")
                        key = _session_key(origin.get("profile") if isinstance(origin, dict) else profile, sid)
                        candidates.setdefault(key, {}).update(
                            profile_name=key[0],
                            source=str(entry.get("platform") or ""), observation_source="gateway_routing",
                            updated_at=row["updated_at"], active=False, routing=True,
                            last_prompt_tokens=entry.get("last_prompt_tokens"))
                if "session_turn_leases" in tables:
                    for row in db.execute("SELECT conversation_id,holder,expires_at FROM session_turn_leases WHERE expires_at>? LIMIT 256", (now,)):
                        match = re.match(r"pid=(\d+)(?::|$)", str(row["holder"]))
                        if not match or not alive(int(match[1])):
                            continue
                        sid = str(row["conversation_id"])
                        turn = re.search(r":turn=(.+):platform=", str(row["holder"]))
                        if turn:
                            # The lease key is a conversation root after compression;
                            # the native holder stamps the actual executing session ID.
                            known = [s for p, s in candidates if p == profile and turn[1].startswith(s+":")]
                            if known:
                                sid = max(known, key=len)
                            elif turn[1].count(":") >= 2 and "sessions" in tables:
                                actual = turn[1].rsplit(":", 2)[0]
                                if db.execute("SELECT 1 FROM sessions WHERE id=?", (actual,)).fetchone():
                                    sid = actual
                        candidates.setdefault(_session_key(profile, sid), {}).update(
                            profile_name=profile, owner_pid=int(match[1]), observation_source="turn_lease",
                            updated_at=now, active=True, live_proof=True, turn_id=turn[1] if turn else "")
                # Project only safe metadata columns; the database also contains private prompts/config.
                columns = {r[1] for r in db.execute("PRAGMA table_info(sessions)")}
                wanted = [k for k in ("id","source","model","billing_provider","parent_session_id","model_config","profile_name","title") if k in columns]
                if "id" not in wanted:
                    unverified = True
                ids = [s for p, s in candidates if p == profile][:512]
                if "id" in wanted and ids:
                    queried.update(_session_key(profile, sid) for sid in ids)
                    query = "SELECT "+",".join(wanted)+" FROM sessions WHERE id IN ("+",".join("?" for _ in ids)+")"
                    for row in db.execute(query, ids):
                        data = dict(row)
                        try:
                            config = json.loads(data.pop("model_config", "{}") or "{}")
                            if not isinstance(config, dict): config = {}
                        except ValueError:
                            config = {}
                        data["provider"] = data.pop("billing_provider", "") or config.get("provider") or ""
                        lineage = str(data.get("parent_session_id") or "")
                        delegated = data.get("source") == "subagent" or bool(config.get("_delegate_from"))
                        data["parent_session_id"] = str(config.get("_delegate_from") or lineage) if delegated else ""
                        data["lineage_parent_session_id"] = lineage
                        data["role"] = "leaf" if delegated else "main"
                        data["profile_name"] = profile if profile != "default" else data.get("profile_name") or profile
                        metadata[_session_key(profile, str(row["id"]))] = data
        except (OSError, ValueError, TypeError, sqlite3.Error):
            unverified = True
            continue
    # Ghost sessions: Hermes' session.delete removes the `sessions` row but leaves its gateway_routing entry behind,
    # so a routing-only candidate whose id has no row in any profile database is a deleted session, not a current
    # conversation. Candidates a live process vouches for (registry pid, turn lease) are kept even without a row:
    # a just-minted session may not be flushed yet. Hermes' own tables are only read, never pruned.
    if not unverified:
        for sid in [s for s, c in candidates.items() if c.get("routing") and not c.get("live_proof")
                    and s in queried and s not in metadata]:
            del candidates[sid]
    nodes = []
    for key, record in candidates.items():
        sid, details = key[1], metadata.get(key, {})
        profile, source = key[0], details.get("source") or record.get("source") or ""
        active = bool(record.get("active"))
        title = safe_title(details.get("title"))
        node = dict(session_id=sid[:512], parent_session_id=details.get("parent_session_id", ""),
                    lineage_parent_session_id=details.get("lineage_parent_session_id", ""), subagent_id="",
                    role=details.get("role", "main"), model=str(details.get("model") or "")[:160],
                    provider=str(details.get("provider") or "")[:160], profile_name=str(profile)[:64],
                    source=str(source)[:32], platform=str(source)[:32], title=title,
                    name=f"Hermes · {title if details.get('parent_session_id') and title else (profile if profile != 'default' else (source or 'CLI').capitalize())}",
                    origin="native", state="working" if active else "idle", active=active,
                    turn_id=record.get("turn_id", ""), control_available=False, observation_source=record["observation_source"],
                    terminal_at=None, updated_at=record["updated_at"],
                    steps=["Native turn lease active" if active else "Current Hermes conversation"])
        if "owner_pid" in record: node["owner_pid"] = record["owner_pid"]
        tokens = record.get("last_prompt_tokens")
        if isinstance(tokens, (int,float)) and tokens >= 0: node["last_prompt_tokens"] = tokens
        nodes.append(node)
    return nodes


def endpoint(home, pid=None):
    home = Path(home).resolve()
    preferred = pid
    if preferred is None:
        try: preferred = json.loads((home/"gateway_state.json").read_text())["pid"]
        except (OSError, ValueError, KeyError): pass
    candidates = []
    for _, base in observer_bases(home):
        for file in (base/"processes").glob("*.json"):
            try:
                if file.resolve().parent != base/"processes" or file.stat().st_size > 2*1024*1024: continue
                data = json.loads(file.read_text())
                path = Path(data.get("control_socket", "")).resolve()
                if (data.get("schema") != SCHEMA or str(data.get("pid")) != file.stem
                        or not alive(data.get("pid")) or time.time()-data["updated_at"]>45
                        or path.parent!=base or not path.name.startswith(f"control-{data['pid']}-") or not path.exists()):
                    continue
                if preferred == data["pid"]: return path
                candidates.append(path)
            except (OSError, ValueError, KeyError, TypeError, RuntimeError):
                continue
    return candidates[0] if candidates and pid is None else None


def relay_requests(home, incoming, emit):
    """Keep native controls independent while preserving ordinary request order."""
    timeout, frame_limit = CONTROL_TIMEOUT, 2*1024*1024
    socket_lock, ordinary = threading.Lock(), queue.Queue()
    gateways, routes, stored_routes = {}, {}, {}  # persistent caller sockets per owning runtime process

    def remaining(deadline):
        seconds = deadline-time.monotonic()
        if seconds <= 0: raise TimeoutError("Control deadline expired")
        return seconds

    def failure(request_id, uncertain):
        message = ("Hermes control reply unavailable; operation outcome is uncertain. Refresh state before deciding whether to retry"
                   if uncertain else "Hermes control connection unavailable; request was not sent")
        emit({"jsonrpc":"2.0","id":request_id,"error":{"code":-32001,"message":message}})

    def disconnect(conn):
        with socket_lock:
            gateway = next((g for g in gateways.values() if g["socket"] is conn), None)
            pending = gateway["pending"] if gateway else {}
            if gateway:
                gateway["socket"], gateway["pending"] = None, {}
        try: conn.shutdown(socket.SHUT_RDWR)
        except OSError: pass
        conn.close()
        for request_id in pending:
            failure(request_id, True)

    def frames(conn, deadline=None):
        buffered = b""
        while True:
            if deadline is not None: conn.settimeout(remaining(deadline))
            try: chunk = conn.recv(65536)
            except socket.timeout:
                if deadline is not None: raise
                continue
            if not chunk: return
            buffered += chunk
            while b"\n" in buffered:
                frame, buffered = buffered.split(b"\n",1)
                if len(frame) >= frame_limit: raise OSError("Oversized control frame")
                if deadline is not None: remaining(deadline)
                yield frame
            if len(buffered) >= frame_limit: raise OSError("Oversized control frame")

    def receive(conn, gateway):
        try:
            for frame in frames(conn):
                try:
                    value = json.loads(frame)
                    if isinstance(value,dict) and "id" in value and "method" not in value and ("result" in value or "error" in value):
                        with socket_lock:
                            pending = gateway["pending"].pop(value["id"], None) if gateway["socket"] is conn else None
                            result = value.get("result")
                            if (pending and pending[0] in {"deck.takeover", "session.resume"} and isinstance(result, dict)
                                    and isinstance(result.get("session_id"), str) and len(result["session_id"]) <= 512):
                                routes[result["session_id"]] = pending[1]
                                if pending[0] == "deck.takeover" and result.get("ok") is True:
                                    stored_routes[(pending[2].get("profile", "default"), pending[2].get("session_id"))] = pending[1]
                                while len(routes) > 1024: routes.pop(next(iter(routes)))
                                while len(stored_routes) > 1024: stored_routes.pop(next(iter(stored_routes)))
                    emit(value)
                except (ValueError,TypeError): pass
        except OSError:
            pass
        finally:
            disconnect(conn)

    def request_control(request):
        conn, registered, attempted = None, False, False
        try:
            deadline = time.monotonic()+DEADLINES.get(request.get("method"), timeout)
            params, method = request.get("params", {}), request.get("method")
            native = str(method or "").startswith("native.")
            with socket_lock:
                routed = (stored_routes.get((params.get("profile", "default"), params.get("session_id")))
                          if method == "session.resume" else routes.get(params.get("session_id")))
            pid = params.get("owner_pid") if native or method == "deck.takeover" else routed
            if pid is not None and (type(pid) is not int or pid <= 0): raise ValueError("Invalid owner pid")
            path = endpoint(home, pid)
            if path is None: raise OSError("Control endpoint unavailable")
            if method == "deck.takeover":
                request = dict(request, params={k: v for k, v in params.items() if k != "owner_pid"})
            encoded = json.dumps(request).encode()+b"\n"
            if native or request.get("method") in ONE_SHOT:
                with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as control:
                    control.settimeout(remaining(deadline))
                    control.connect(str(path))
                    control.settimeout(remaining(deadline))
                    attempted = True
                    control.sendall(encoded)
                    for reply in frames(control,deadline):
                        frame = json.loads(reply)
                        if isinstance(frame,dict) and frame.get("id")==request.get("id") and "method" not in frame and ("result" in frame or "error" in frame):
                            emit(frame)
                            return
                    raise OSError("Control reply unavailable")
            else:
                with socket_lock:
                    gateway = gateways.setdefault(pid, {"socket": None, "pending": {}})
                    conn = gateway["socket"]
                if conn is None:
                    conn = socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
                    conn.settimeout(remaining(deadline))
                    conn.connect(str(path))
                    with socket_lock: gateway["socket"] = conn
                    threading.Thread(target=receive,args=(conn,gateway),daemon=True).start()
                with socket_lock:
                    if gateway["socket"] is not conn: raise OSError("Gateway disconnected")
                    if "id" in request:
                        gateway["pending"][request["id"]] = (method, pid, params)
                        registered = True
                conn.settimeout(remaining(deadline))
                attempted = True
                conn.sendall(encoded)
                conn.settimeout(timeout)
        except (OSError,ValueError,TypeError):
            if conn is not None: disconnect(conn)
            # A registered gateway request is failed once by disconnect, including
            # races where the reader already observed EOF and emitted its failure.
            if not registered: failure(request.get("id"), attempted)

    def ordinary_requests():
        while (request := ordinary.get()) is not None:
            request_control(request)

    threading.Thread(target=ordinary_requests,daemon=True).start()
    for line in incoming:
        request = None
        try:
            # Only deck.attach_submit (attachments) and deck.transcribe (one clip) may exceed 2 MiB, each up to its
            # own ceiling (observer.LINE_MAX). The method name sits first on the line, so an oversize line of any
            # other kind is dropped before it is parsed.
            # sys.stdin yields str, a test or binary pipe bytes: compare the head in the line's own type (a bytes name
            # in a str head raised TypeError, so every >2 MiB attachment was refused with a null id and never answered)
            head = line[:300]
            names = [m if isinstance(head, str) else m.encode() for m in LINE_MAX]
            if len(line)>max(LINE_MAX.values()) or (len(line)>2*1024*1024 and not any(m in head for m in names)): continue
            request = json.loads(line)
            if not isinstance(request,dict): raise ValueError("Invalid request")
            if not isinstance(request.get("params",{}),dict): raise ValueError("Invalid params")
            limit = LINE_MAX.get(request.get("method"), 2*1024*1024 if request.get("method") == "deck.appshot" else 65536)
            if len(line)>limit: raise ValueError("Request too large")
            if request.get("method") == VERSION_METHOD:
                if "id" in request:
                    emit({"jsonrpc":"2.0","id":request["id"],"result":{"version":VERSION,"protocol":PROTOCOL}})
                continue
            if str(request.get("method","")).startswith("native.") or request.get("method") in ONE_SHOT:
                threading.Thread(target=request_control,args=(request,),daemon=True).start()
            else:
                ordinary.put(request)
        except (ValueError,TypeError):
            failure(request.get("id") if isinstance(request,dict) else None, False)
    ordinary.put(None)


ACTIVITY_SUFFIX = ".activity"      # observer.ACTIVITY_SUFFIX: each live process's recent tool calls and plans
ACTIVITY_MAX_BYTES = 4 * 1024 * 1024
ACTIVITY_EVENTS = ("deck.plan", "deck.tools")


def collect_activity(home, alive=None, cache=None):
    """{(profile, session id): {"plan": ..., "tools": [...]}} from the observers' <pid>.activity files (live pids only).
    `cache` maps a file to (stat stamp, parsed sessions), so an unchanged file is not read again."""
    alive = alive or _alive
    cache = {} if cache is None else cache
    out, seen = {}, set()
    for profile, base in observer_bases(home):
        directory = base/"processes"
        for file in directory.glob("*"+ACTIVITY_SUFFIX):
            try:
                if file.resolve().parent != directory.resolve() or not alive(file.name[:-len(ACTIVITY_SUFFIX)]):
                    continue
                st = file.stat()
                if st.st_size > ACTIVITY_MAX_BYTES:
                    continue
                stamp = (st.st_ino, st.st_size, st.st_mtime_ns)
                seen.add(file)
                hit = cache.get(file)
                if hit is None or hit[0] != stamp:
                    data = json.loads(file.read_text(encoding="utf-8"))
                    if (data.get("schema") != SCHEMA or str(data.get("pid")) != file.name[:-len(ACTIVITY_SUFFIX)]
                            or not isinstance(data.get("sessions"), dict)):
                        continue
                    hit = cache[file] = (stamp, data["sessions"])
                for sid, entry in hit[1].items():
                    if not isinstance(entry, dict) or not isinstance(sid, str) or len(sid) > 512:
                        continue
                    node_profile = entry.get("profile_name")
                    if not node_profile or (profile != "default" and node_profile == "default"):
                        node_profile = profile
                    out[_session_key(node_profile, sid)] = {"plan": entry.get("plan"), "tools": entry.get("tools")}
            except (OSError, ValueError, TypeError, AttributeError):
                continue
    for file in [f for f in cache if f not in seen]:
        del cache[file]
    return out


def activity_events(activity, sent):
    """The deck.plan / deck.tools event frames for what changed since `sent` ({(key, type): digest}), updating it."""
    frames = []
    for (profile, sid), entry in activity.items():
        for kind, value in (("deck.plan", entry.get("plan")), ("deck.tools", entry.get("tools"))):
            if value is None or (kind == "deck.tools" and not isinstance(value, list)):
                continue
            payload = {"plan": value} if kind == "deck.plan" else {"tools": value}
            digest = json.dumps(payload, sort_keys=True, ensure_ascii=True)
            if sent.get(((profile, sid), kind)) == digest:
                continue
            sent[((profile, sid), kind)] = digest
            frames.append({"jsonrpc": "2.0", "method": "event", "params": {
                "type": kind, "session_id": sid, "profile_name": profile, "payload": payload}})
    for key in [k for k in sent if k[0] not in activity]:
        del sent[key]
    return frames


def snapshot(home, nodes):
    """The Hermes Deck snapshot frame."""
    gateway_status = {}
    try:
        raw = json.loads((Path(home)/"gateway_state.json").read_text())
        gateway_status = {"running":raw.get("gateway_state")=="running" and alive(raw.get("pid")),
                          "active_agents":raw.get("active_agents",0)}
    except (OSError, ValueError, AttributeError):
        pass
    return dict(schema=SCHEMA, hook_event_name="HermesSnapshot",
                connection_id=CONNECTION_ID, online=True, gateway=gateway_status, nodes=nodes)


def serve(home, follow=False, stdin=None, stdout=None):
    """Print snapshots (once, or every change and at least every 5 s with follow) and, with follow, relay the
    requests read from stdin. Returns only without follow."""
    home = Path(home).expanduser().resolve()
    stdin = sys.stdin if stdin is None else stdin
    out = sys.stdout if stdout is None else stdout
    previous, sent, registered_at, registered, child_titles = "", 0, float("-inf"), [], {}
    activity_cache, activity_sent = {}, {}
    output_lock = threading.Lock()
    def emit(obj):
        with output_lock: print(json.dumps(obj,sort_keys=True,ensure_ascii=True),file=out,flush=True)

    if follow: threading.Thread(target=relay_requests,args=(home,stdin,emit),daemon=True).start()
    while True:
        nodes = collect_observer_nodes(home)
        if time.monotonic()-registered_at >= 5:
            registered = collect_registered_nodes(home)
            enrich_child_titles(home, nodes)
            child_titles = {_session_key(n.get("profile_name"), n["session_id"]):(n.get("title"),n.get("name"))
                            for n in nodes if n.get("parent_session_id")}
            registered_at = time.monotonic()
        for node in nodes:
            key = _session_key(node.get("profile_name"), node["session_id"])
            if key in child_titles:
                title, name = child_titles[key]
                if title: node["title"], node["name"] = title, name
        observed = {_session_key(n.get("profile_name"), n["session_id"]):n for n in nodes}
        for node in registered:
            native = observed.get(_session_key(node.get("profile_name"), node["session_id"]))
            if native is None:
                nodes.append(node)
            else:
                for key in ("provider","profile_name","source","title","last_prompt_tokens","lineage_parent_session_id"):
                    if not native.get(key) and key in node: native[key] = node[key]
        payload = snapshot(home, nodes)
        line = json.dumps(payload, sort_keys=True, ensure_ascii=True)
        if line != previous or time.monotonic()-sent >= 5:
            emit(payload)
            previous, sent = line, time.monotonic()
        if not follow:
            return
        # the Run / Plan tabs: each live session's recent tool calls and latest plan, as events when they change
        for frame in activity_events(collect_activity(home, cache=activity_cache), activity_sent):
            emit(frame)
        time.sleep(.2)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Hermes Deck bridge stream (stdio JSON-RPC).")
    parser.add_argument("--follow", action="store_true", help="keep streaming and relay requests from stdin")
    parser.add_argument("--home", type=Path, default=None, help="Hermes home (default: inferred from this file)")
    args = parser.parse_args(argv)
    if os.name == "nt":
        parser.error("Native Windows is unsupported. Run this stream and Hermes inside WSL, or on a Linux/macOS SSH host.")
    serve(args.home or default_home(), follow=args.follow)


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
