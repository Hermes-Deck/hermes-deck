"""A stand-in Hermes host for end-to-end tests (not part of the installed plugin). POSIX only.

One process plays the Hermes side of Hermes Deck's direct connection with the real code: hermes-deck's
observer (snapshots and its control socket, observer.start) in front of a fake Hermes TUI gateway, and the
real stream.py relay on stdin/stdout. So app/test/bridge.test.js can run BridgeClient against it, and
test_stream.py can drive it as a subprocess:

    python testhost.py HOME [--log FILE]

HOME is an empty directory used as HERMES_HOME. Sessions: s-main (live, controllable, turn t1, owner = this
process) and s-idle (persisted only). --log appends every request the gateway saw as a JSON line. The first
session.list asks one approval (A1); prompt.submit streams message.start/delta/complete events.
"""
import json
import os
import sys
import threading
import time
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

HISTORY = [
    {"id": 11, "role": "user", "content": "Merhaba", "timestamp": 1700000000.5},
    {"id": 12, "role": "assistant", "content": [{"type": "text", "text": "Selam"}], "timestamp": 1700000001.25},
    {"id": 13, "role": "tool", "content": "tool output"},
]


class Agent:
    """What the observer needs from a running Hermes agent."""
    session_id, _current_turn_id, model, provider = "s-main", "t1", "model-a", "prov"

    def __init__(self):
        self.steered, self.redirected, self.interrupted = [], [], []

    def steer(self, text):
        self.steered.append(text)
        return True

    def redirect(self, text):
        self.redirected.append(text)
        return True


def install_fake_hermes(home: Path, log=None):
    """Fake hermes_constants, hermes_cli.web_routers.sessions, agent.interrupt_compat and tui_gateway modules."""
    def record(entry):
        if log:
            with open(log, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\n")

    def module(name, **attrs):
        m = types.ModuleType(name)
        m.__dict__.update(attrs)
        sys.modules[name] = m
        return m

    module("hermes_constants", get_hermes_home=lambda: str(home), profile_name_for_home=lambda h: "default",
           get_default_hermes_root=lambda: str(home))

    async def get_session_messages(session_id, profile, limit, offset, order, include_compacted, inline_images):
        page = HISTORY if offset == 0 else [{"id": 9, "role": "user", "content": "Eski soru", "timestamp": 1699999000}]
        return {"session_id": session_id, "profile": profile, "messages": page,
                "pagination": {"limit": limit, "offset": offset, "order": order, "returned": len(page)}}

    db = types.SimpleNamespace(get_session=lambda sid: {"id": sid} if sid in ("s-main", "s-idle") else None)
    module("hermes_cli")
    # Botlar: profile dirs under HOME (default = HOME itself), as hermes_cli.profiles resolves them
    module("hermes_cli.profiles", get_profile_dir=lambda name: home if name == "default" else home / "profiles" / name)
    module("hermes_cli.web_routers")
    module("hermes_cli.web_routers.sessions", _with_db=lambda profile, fn, read_only: fn(db),
           get_session_messages=get_session_messages)
    module("agent")
    module("agent.interrupt_compat",
           request_hard_interrupt=lambda agent, reason, tool_reason=None: agent.interrupted.append(reason) or True)

    class FanoutTransport:
        def __init__(self):
            self.peers, self.lock = [], threading.Lock()

        def attach(self, peer):
            with self.lock:
                self.peers.append(peer)

        def detach(self, peer):
            with self.lock:
                if peer in self.peers:
                    self.peers.remove(peer)

        def write(self, obj):
            with self.lock:
                peers = list(self.peers)
            return all([p.write(obj) for p in peers])

    state = {"asked": False}
    # Hermes' runtime session table: like _init_session, a resumed session keeps the transport that resumed it
    # (the control socket's fanout), which deck.reasoning_view checks before it flips show_reasoning.
    sessions, sessions_lock = {}, threading.Lock()

    def dispatch(request, transport=None):
        method, p, rid = request.get("method"), request.get("params") or {}, request.get("id")
        record({"id": rid, "method": method, "params": p})
        ok = lambda result: {"jsonrpc": "2.0", "id": rid, "result": result}
        event = lambda sid, type_, payload: transport.write(
            {"jsonrpc": "2.0", "method": "event", "params": {"type": type_, "session_id": sid, "payload": payload}})
        if method == "session.list":
            reply = ok({"sessions": [{"id": "s-main", "title": "Ana oturum", "message_count": 3, "source": "cli"},
                                     {"id": "s-idle", "title": "", "message_count": 1, "source": "cli"}]})
            if not state["asked"]:
                state["asked"] = True
                threading.Timer(0.05, transport.write, args=({"jsonrpc": "2.0", "id": "A1", "method": "approval",
                    "params": {"session_id": "rpc-s-main", "command": "rm -rf build", "description": "Komut onayı",
                               "choices": ["once", "deny"]}},)).start()
            return reply
        if method == "session.resume":
            with sessions_lock:
                sessions["rpc-" + str(p.get("session_id"))] = {"transport": transport, "show_reasoning": False}
            return ok({"session_id": "rpc-" + str(p.get("session_id")), "stored_session_id": p.get("session_id")})
        if method == "prompt.submit":
            sid = str(p.get("session_id"))
            def stream_reply():
                event(sid, "message.start", {})
                event(sid, "message.delta", {"text": "Mer"})
                event(sid, "message.complete", {"text": "Merhaba", "status": "complete"})
            threading.Timer(0.05, stream_reply).start()
            return ok({"status": "streaming"})
        if method == "request.answer":
            return ok({"status": "ok"})
        if method == "session.interrupt":
            return ok({"status": "interrupted"})
        if method == "model.options":
            return ok({"model": "model-a", "provider": "prov",
                       "providers": [{"slug": "prov", "name": "Provider", "models": ["model-a", "model-b"]}]})
        if method == "config.set":
            return ok({"deferred": True})
        if method == "session.usage":
            return ok({"context_used": 10, "context_max": 100})
        # Botlar: the roster, an avatar (Hermes reads the file itself), a lazy create and its title write
        if method == "profiles.list":
            return ok({"profiles": [{"name": "default", "path": str(home), "is_default": True, "model": "model-a",
                                     "provider": "prov", "has_avatar": True, "canonical_session": None}],
                       "bot_mode_protocol": True})
        if method == "profiles.get_asset":
            # A long handler in Hermes (_LONG_HANDLERS): dispatch returns None and a pool worker writes the
            # reply later through the transport bound to the request. assets/swap-in.png, when present, replaces
            # the avatar first: a profiles.set_asset landing between the plugin's size check and Hermes' read.
            def answer():
                import base64
                target, swap = home / "assets" / "avatar.png", home / "assets" / "swap-in.png"
                if swap.is_file():
                    os.replace(swap, target)
                blob = target.read_bytes() if p.get("name") == "default" and target.is_file() else None
                transport.write(ok({"found": True, "mime": "image/png", "size": len(blob),
                                    "data": "data:image/png;base64," + base64.b64encode(blob).decode()} if blob else {"found": False}))
            threading.Timer(0.2, answer).start()
            return None
        if method == "session.create":
            state["created"] = state.get("created", 0) + 1
            return ok({"session_id": f"rpc-new-{state['created']}", "stored_session_id": f"s-new-{state['created']}",
                       "message_count": 0})
        if method == "session.title":
            return ok({"pending": False, "title": p.get("title")})
        # Sub-agents of s-main (Hermes' methods_subagents shapes); the plugin completes the list and tail replies
        if method == "subagent.list":
            return ok({"subagents": [{"subagent_id": "sa-0-test", "parent_id": None, "depth": 1, "goal": "Find three examples",
                                      "model": "model-b", "started_at": time.time() - 5, "status": "running",
                                      "tool_count": 1, "last_tool": "web_search", "accepting_steer": True}],
                       "delegations": []})
        if method == "subagent.tail":
            return ok({"subagent_id": p.get("subagent_id"), "available": True, "text": "searching\nfound one\n",
                       "truncated": False})
        if method == "subagent.steer":
            return ok({"status": "queued", "subagent_id": p.get("subagent_id"), "text": p.get("text")})
        if method == "subagent.interrupt":
            return ok({"found": True, "subagent_id": p.get("subagent_id")})
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"fake gateway: {method}"}}

    module("tui_gateway")
    sessions["rpc-tui"] = {"transport": object(), "show_reasoning": False}  # a session another surface owns
    module("tui_gateway.server", dispatch=dispatch, register_live_transport=lambda t: None,
           unregister_live_transport=lambda t: None, _sessions=sessions, _sessions_lock=sessions_lock)
    module("tui_gateway.transport", FanoutTransport=FanoutTransport, bind_transport=lambda t: object(),
           reset_transport=lambda token: None)


def start(home, log=None):
    """The observer with a live controllable s-main; returns (observer instance, agent)."""
    home = Path(home)
    install_fake_hermes(home, log)
    import observer
    (home / "gateway_state.json").write_text(json.dumps({"pid": os.getpid(), "gateway_state": "running",
                                                         "active_agents": 1}), encoding="utf-8")
    instance = observer.start(home / "hermes-deck")
    agent = Agent()
    # a todo_list call from an earlier turn: the stream turns it into deck.tools and deck.plan events
    todos = [{"id": "1", "content": "Read the brief", "status": "completed"},
             {"id": "2", "content": "Write the parser", "status": "in_progress"}]
    instance.pre_tool_call(tool_name="todo_list", session_id="s-main", turn_id="t1", tool_call_id="call-todo-1",
                           args={"todos": todos})
    instance.post_tool_call(tool_name="todo_list", session_id="s-main", turn_id="t1", tool_call_id="call-todo-1",
                            result=json.dumps({"todos": todos, "revision": 3}), duration_ms=2, status="ok")
    instance.pre_llm_call(session_id="s-main", turn_id="t1", model="model-a", platform="cli")
    import weakref
    with instance.lock:
        instance.agents["s-main"] = weakref.ref(agent)
        instance._persist()
    deadline = time.monotonic() + 5
    while not instance.control_socket and time.monotonic() < deadline:
        time.sleep(0.01)
    if not instance.control_socket:
        raise SystemExit("testhost: the observer's control socket did not start")
    with instance.lock:
        instance._persist()
    return instance, agent


def main(argv):
    home = Path(argv[1])
    log = argv[argv.index("--log") + 1] if "--log" in argv else None
    instance, agent = start(home, log)
    import stream
    try:
        stream.serve(home, follow=True)
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    return agent


if __name__ == "__main__":
    main(sys.argv)
