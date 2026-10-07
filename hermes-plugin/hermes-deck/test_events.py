"""hermes-deck, events part (formerly deck-events). Run with any Python 3.10+:  python test_events.py
(or `python -m unittest discover -p 'test_*.py'`, which runs this file in its own interpreter)

The deck-events test, run through the hermes-deck plugin: loads __init__.py from this directory with the
bridge part off, so register() must hand Hermes exactly the deck-events hooks, then drives every hook with
the payload shapes from hermes_cli/hooks.py (_DEFAULT_PAYLOADS) and checks the NDJSON output. The Bot ekranı
part replaces the relay's socket and Hermes' session release with fakes. test_bridge.py covers the bridge
part and the hooks both parts share.
"""
import base64
import importlib.util
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import zlib
from pathlib import Path

from testsupport import run_others

HERE = Path(__file__).resolve().parent


def checks():
    tmp = tempfile.mkdtemp(prefix="hermes-deck-events-test-")
    os.environ["DECK_EVENTS_DIR"] = tmp
    os.environ["DECK_EVENTS_PROFILE"] = "testprof"
    os.environ["HERMES_DECK_BRIDGE"] = "0"

    spec = importlib.util.spec_from_file_location("hermes_deck_plugin", HERE / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    de = plugin._sibling("events")
    de._profile = "testprof"           # bypass hermes_constants lookup outside a gateway


    class Ctx:
        def __init__(self):
            self.hooks = {}

        def register_hook(self, name, fn):
            self.hooks[name] = fn


    ctx = Ctx()
    plugin.register(ctx)
    assert set(ctx.hooks) == set(de.HOOKS), ctx.hooks.keys()
    assert all(ctx.hooks[n] is de.HOOKS[n] for n in de.HOOKS)   # bridge off: deck-events' own handlers, unwrapped

    h = ctx.hooks
    assert h["pre_llm_call"](session_id="s1", user_message="hi", conversation_history=[1, 2],
                             is_first_turn=True, model="gpt-x", platform="telegram") is None
    assert h["pre_tool_call"](tool_name="terminal", args={"command": "curl -H 'Authorization: Bearer abcdefghijklmnop123'"},
                              session_id="s1", task_id="t", tool_call_id="c1") is None
    h["post_tool_call"](tool_name="terminal", args={}, session_id="s1", tool_call_id="c1",
                        result="x" * 1000, duration_ms=42, status="ok")
    h["post_api_request"](session_id="s1", model="gpt-x", provider="openai", started_at=10.0,
                          first_chunk_at=10.5, api_duration=1.25, finish_reason="stop",
                          usage={"input_tokens": 2048, "output_tokens": 512, "cache_read_tokens": 0},
                          context_length=200000, message_count=4, response={"big": "x" * 5000},
                          assistant_message=object())
    h["post_auxiliary_call"](session_id="s1", aux_task="title_generation", model="m",
                             usage={"input_tokens": 10, "output_tokens": 2}, api_duration=0.1)
    h["subagent_start"](parent_session_id="s1", child_session_id="c-s", child_subagent_id="sa-0-abcd1234",
                        child_goal="look up the thing")
    h["subagent_stop"](parent_session_id="s1", child_session_id="c-s", child_status="completed",
                       child_summary="done", tool_call_history=[{}, {}], duration_ms=1234)
    h["on_session_start"](session_id="s1")
    h["on_session_end"](session_id="s1", completed=True, failed=False, turn_exit_reason="stop")
    h["post_llm_call"](session_id="s1", model="gpt-x")
    h["agent_loop_stopped"](session_key="agent:main:telegram:dm:1")

    # A hook must never raise, even on garbage input.
    h["post_api_request"](usage="not-a-dict", api_duration="nan", started_at=None)
    h["post_tool_call"](result=object())

    lines = (Path(tmp) / "testprof.ndjson").read_text(encoding="utf-8").splitlines()
    recs = [json.loads(l) for l in lines]
    evs = [r["ev"] for r in recs]
    assert evs[:11] == ["turn_start", "tool_start", "tool_end", "llm", "aux", "sub_start", "sub_stop",
                        "session_start", "session_end", "turn_end", "stopped"], evs
    by = {r["ev"]: r for r in recs[:11]}
    assert all(r["profile"] == "testprof" for r in recs)
    assert "‹redacted›" in by["tool_start"]["args"] and "abcdefghijklmnop123" not in by["tool_start"]["args"]
    assert len(by["tool_end"]["result"]) == de.PREVIEW + 1 and by["tool_end"]["ms"] == 42
    assert by["llm"]["usage"] == {"input_tokens": 2048, "output_tokens": 512} and by["llm"]["ttfb"] == 0.5
    assert "response" not in by["llm"] and "big" not in lines[3]
    assert by["sub_start"]["sa"] == "sa-0-abcd1234" and by["sub_stop"]["tools"] == 2
    assert "conversation_history" not in by["turn_start"]
    # security audit L5: the same extra shapes as relay/src/util.js (AWS, PEM, database URLs, Google keys, JWTs)
    red = de._redact(" | ".join(["AKIA" + "EXAMPLE0EXAMPLE0", "aws_secret_access_key=" + "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
                                 "-----BEGIN RSA PRIVATE KEY-----\nMIIEexamplekeybody\n-----END RSA PRIVATE KEY-----",
                                 "postgres://deck:hunter2pass@db.example:5432/app", "AIza" + "SyA-example-example-example-example",
                                 "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJlZXhhbXBsZQ"]))
    for secret in ("EXAMPLE0EXAMPLE0", "bPxRfiCYEXAMPLEKEY", "MIIEexamplekeybody", "hunter2pass", "SyA-example", "c2lnbmF0dXJl"):
        assert secret not in red, (secret, red)
    assert "postgres://deck:‹redacted›@db.example" in red, red
    assert all(len(l) < 2000 for l in lines)

    # Rotation.
    de.MAX_BYTES = 200
    h["on_session_start"](session_id="rot")
    assert (Path(tmp) / "testprof.ndjson.1").exists()
    de.MAX_BYTES = 50 * 1024 * 1024

    # Another process rotates the file under us: the next write must land in a fresh file, not the old inode.
    # (POSIX only: Windows cannot rename an open file, and the plugin only runs on the macOS gateway.)
    if os.name != "nt":
        live = Path(tmp) / "testprof.ndjson"
        os.replace(live, Path(tmp) / "testprof.ndjson.1")
        h["on_session_start"](session_id="after-external-rotate")
        assert "after-external-rotate" in live.read_text(encoding="utf-8")

    # State snapshots: only the profile's gateway process writes them, prompts/scripts never leak.
    home = Path(tmp) / "home"
    (home / "cron").mkdir(parents=True)
    gs = {"pid": os.getpid(), "gateway_state": "running", "active_agents": 1, "code_version": "0.21.5",
          "platforms": {"telegram": {"state": "connected", "error_message": None, "needs_attention": False}}}
    (home / "gateway_state.json").write_text(json.dumps(gs), encoding="utf-8")
    (home / "cron" / "jobs.json").write_text(json.dumps({"jobs": [
        {"id": "j1", "name": "Daily", "schedule_display": "45 9 * * *", "enabled": True, "state": "scheduled",
         "last_status": "error", "last_error": "boom token=abcdefghijkl123", "failure_streak": 2,
         "prompt": "SECRET PROMPT", "script": "rm -rf /"}]}), encoding="utf-8")
    assert de._snapshot_once(home) is True
    snap = json.loads((Path(tmp) / "state" / "testprof.json").read_text(encoding="utf-8"))
    assert snap["platforms"]["telegram"]["state"] == "connected" and snap["gateway"]["active_agents"] == 1
    job = snap["cron"][0]
    assert job["failure_streak"] == 2 and "prompt" not in job and "script" not in job
    assert "abcdefghijkl123" not in job["last_error"] and "SECRET" not in json.dumps(snap)
    gs["pid"] = os.getpid() + 1                       # some other process owns the gateway
    (home / "gateway_state.json").write_text(json.dumps(gs), encoding="utf-8")
    assert de._snapshot_once(home) is False

    # ---- Bot ekranı: the computer_use fence (fake relay socket, fake Hermes session release) ----------
    deck_home = Path(tmp) / "deck-home"
    os.environ["DECK_HOME"] = str(deck_home)
    os.environ["HERMES_CUA_DRIVER_CMD"] = "/opt/hermes-deck/relay/bin/deck-cua"   # the switch that turns it on
    os.environ["HERMES_SESSION_KEY"] = "agent:main:telegram:dm:1001"
    os.environ["HERMES_HOME"] = str(Path(tmp) / ".hermes" / "profiles" / "scout")
    os.environ.pop("HERMES_SESSION_ID", None)
    os.environ.pop("DECK_BOT_SCREEN", None)
    PC, LAPTOP = "a1b2c3d4e5f60708", "f0e1d2c3b4a59687"
    GRANT = {"agent": "Scout", "app": "Notepad", "window": {"id": 77, "pid": 4242, "title": "notes.txt"},
             "expires": int(time.time() * 1000) + 3_600_000, "idleMin": 30}
    route = {"t": "route", "ok": True, "device": PC, "name": "Test PC", "epoch": 3, "live": True,
             "grant": dict(GRANT), "deckPid": 999}
    relay = {"up": True}
    queries, released = [], []


    def fake_query(identity, timeout=2.0):
        queries.append(identity)
        return json.loads(json.dumps(route)) if relay["up"] else None


    de._relay_query = fake_query
    de._release_session = released.append


    def pre(args, sid="cu1"):
        return h["pre_tool_call"](tool_name="computer_use", args=args, session_id=sid)


    # input before any capture is refused (Hermes' input target could still be the user's own window), and the
    # routing identity is what Hermes hands deck-cua: profile from HERMES_HOME plus the gateway session key
    assert pre({"action": "click", "coordinate": [5, 5]})["message"].startswith("Bot ekranı: capture first")
    assert queries[-1] == {"sid": "", "skey": "agent:main:telegram:dm:1001", "profile": "scout"}, queries[-1]
    # an untargeted capture gets the handed window; the same app by name with zero-filled ids too
    assert pre({"action": "capture", "mode": "som"}) == {"action": "modify",
                                                          "args": {"pid": 4242, "window_id": 77, "app": "Notepad"}}
    assert pre({"action": "capture", "app": "notepad", "pid": 0, "window_id": 0})["action"] == "modify"
    for a in ({"app": "screen"}, {"app": "Desktop"}, {"app": "full screen"}, {"app": "Chrome"},
              {"pid": 4242, "window_id": 78}, {"pid": 7, "window_id": 77}):
        assert pre({"action": "capture", **a})["action"] == "block", a
    # Foreground delivery is off by default, and opt-in remains bound to this window and grant.
    assert pre({"action": "click", "element": 3}) is None
    assert "use the host" in pre({"action": "click", "element": 3, "delivery_mode": "foreground"})["message"]
    # the agent is steered to the background delivery first: most apps take input that way, and the user keeps
    # their own mouse and keyboard (agent spaces: two cursors)
    assert "without delivery_mode" in pre({"action": "key", "key": "enter", "delivery_mode": "foreground"})["message"]
    assert pre({"action": "type", "text": "x", "delivery_mode": "foreground", "bring_to_front": True})["action"] == "block"
    assert pre({"action": "type", "text": "x", "app": "Chrome"})["action"] == "block"
    for value in (None, False, "true", 1):
        route["grant"]["foreground"] = value
        assert pre({"action": "click", "element": 3, "delivery_mode": "foreground"})["action"] == "block"
    route["grant"]["foreground"] = True
    for args in ({"action": "click", "bring_to_front": True},
                 {"action": "focus_app", "raise_window": True}):
        refusal = pre(args)
        assert refusal["action"] == "block"
        assert 'use delivery_mode "foreground" on the input action itself' in refusal["message"], refusal
        assert "Hermes Deck brings the handed window forward" in refusal["message"], refusal
        route["grant"]["foreground"] = False
        assert "Retry the same action without delivery_mode" in pre(args)["message"]
        route["grant"]["foreground"] = True
    assert pre({"action": "click", "element": 3, "delivery_mode": "foreground"}) == {
        "action": "modify", "args": {"pid": 4242, "window_id": 77, "app": "Notepad"}}
    for args in ({"pid": 7}, {"window_id": 78}, {"app": "Chrome"}, {"bring_to_front": True}):
        assert pre({"action": "click", "element": 3, "delivery_mode": "foreground", **args})["action"] == "block"
    assert pre({"action": "capture", "delivery_mode": "foreground"})["action"] == "block"
    route["grant"].pop("foreground")
    assert pre({"action": "click", "element": 3, "delivery_mode": "foreground"})["action"] == "block"
    # Installed runtime safeguards: mismatched explicit process/window input never reaches another surface.
    assert pre({"action": "click", "element": 3, "pid": 7})["action"] == "block"
    assert pre({"action": "click", "element": 3, "window_id": 78})["action"] == "block"
    route["grant"]["foreground"] = True
    granted = pre({"action": "click", "element": 3, "delivery_mode": "foreground"})
    assert granted == {"action": "modify", "args": {"pid": 4242, "window_id": 77, "app": "Notepad"}}
    assert pre({"action": "click", "element": 3, "pid": 7, "delivery_mode": "foreground"})["action"] == "block"
    route["grant"].pop("foreground")
    # A failed capture revokes the input pin; a lost device connection releases the cached driver session.
    de._cu_record({"action": "capture"}, "cu1", {"ok": False, "error": "fixture capture failed"}, "error", None)
    assert "capture first" in pre({"action": "click", "element": 3})["message"]
    assert pre({"action": "capture"})["action"] == "modify"
    de._cu_record({"action": "click"}, "cu1", json.dumps({"ok": False, "error": "connection closed"}), "error", "connection closed")
    assert released == ["cu1"]
    assert de._cu["cu1"]["pinned"] is None and de._cu["cu1"]["frame"] is None and de._cu["cu1"]["elements"] == {}
    released.clear()
    assert pre({"action": "capture"})["action"] == "modify"
    # focus_app: another app is refused, the handed app becomes an exact capture, raising it is refused
    assert pre({"action": "focus_app", "app": "Chrome"})["action"] == "block"
    r = pre({"action": "focus_app", "app": "Notepad"})
    assert r["action"] == "modify" and r["args"]["action"] == "capture" and r["args"]["mode"] == "ax"
    assert (r["args"]["pid"], r["args"]["window_id"], r["args"]["raise_window"]) == (4242, 77, None)
    assert pre({"action": "focus_app", "app": "Notepad", "raise_window": True})["action"] == "block"
    # listings, kill_app and Hermes Deck's own process are refused; wait is harmless
    assert pre({"action": "list_windows"})["action"] == "block" and pre({"action": "list_apps"})["action"] == "block"
    assert pre({"action": "kill_app", "app": "Notepad"})["action"] == "block"
    assert "Hermes Deck itself" in pre({"action": "capture", "pid": 999, "window_id": 1})["message"]
    assert pre({"action": "wait", "seconds": 1}) is None
    # no grant, a grant on the Deck's own window, no route, relay down: refused, in words the agent can pass on
    route["grant"] = None
    assert "Agent'a ver" in pre({"action": "capture"})["message"]
    route["grant"] = dict(GRANT, window={"id": 5, "pid": 999, "title": "Hermes Deck"})
    assert "Agent'a ver" in pre({"action": "capture"})["message"]
    route.update(ok=False, error="Bot ekranı: no device is available for computer_use. Ask the user.")
    assert pre({"action": "capture"})["message"] == route["error"]
    route.update(ok=True, grant=dict(GRANT))
    relay["up"] = False
    assert "not reachable" in pre({"action": "capture"})["message"]
    relay["up"] = True
    # the route moves while the session's driver connection is live: dropped once, and input needs a new capture
    released.clear()
    assert pre({"action": "capture"})["action"] == "modify"
    route.update(device=LAPTOP, epoch=4)
    assert pre({"action": "click", "element": 3})["action"] == "block" and released == ["cu1"]
    assert pre({"action": "capture"})["action"] == "modify" and released == ["cu1"]
    route.update(device=PC, epoch=5, live=False)                  # its driver connection already died: nothing to drop
    assert pre({"action": "capture"})["action"] == "modify" and released == ["cu1"]
    # the agent host: only kill_app is fenced
    route.update(device="host", grant=None, deckPid=None)
    assert pre({"action": "capture", "app": "screen"}) is None
    assert pre({"action": "kill_app"})["action"] == "block"
    # agent spaces phase 2: an agent's own desktop is the whole desktop — no single-window fence; kill_app stays refused
    route.update(device="space:scout@agent-host", grant=None, deckPid=None)
    assert pre({"action": "capture", "app": "screen"}) is None
    assert pre({"action": "click", "x": 5, "y": 5}) is None
    assert pre({"action": "kill_app"})["action"] == "block"
    route.update(device="host", grant=None, deckPid=None)         # back to the agent host for the blocks below
    # agent spaces: a read-only action tells the relay so (it looks without taking the shared desktop); input does not
    seen = []
    de._relay_query = lambda identity, timeout=2.0: (seen.append(dict(identity)), json.loads(json.dumps(route)))[1]
    pre({"action": "capture", "app": "screen"})
    pre({"action": "list_windows"})
    pre({"action": "click", "element": 3})
    assert [q.get("read") for q in seen] == [True, True, None], seen
    de._relay_query = fake_query
    # agent spaces: a busy shared desktop is waited for (each query keeps the agent's place in the relay's queue);
    # past SPACE_WAIT_S the agent gets the relay's own words
    busy = {"t": "route", "ok": False, "busy": True, "error": "The desktop is in use by aurora; you are 1st in line."}
    answers, slept, real_sleep, real_monotonic = [dict(busy), dict(busy), dict(route)], [], de.time.sleep, de.time.monotonic
    clock = [1000.0]                                              # a fake clock: sleeping and slow queries move it
    de.time.monotonic = lambda: clock[0]
    de.time.sleep = lambda s: (slept.append(s), clock.__setitem__(0, clock[0] + s))
    try:
        de._relay_query = lambda identity, timeout=2.0: answers.pop(0)
        assert pre({"action": "capture", "app": "screen"}) is None and len(slept) == 2, slept
        de._relay_query = lambda identity, timeout=2.0: dict(busy)
        slept.clear()
        out = pre({"action": "capture", "app": "screen"})
        assert out["action"] == "block" and "in use by aurora" in out["message"], out
        assert sum(slept) >= de.SPACE_WAIT_S, sum(slept)
        # Hermes bounds a pre_tool_call hook at 30 s (plugins.hook_callback_timeout) and then blocks with a generic
        # message: the wait stays under that, and the agent is told to retry (the relay keeps its place 15 s)
        assert de.SPACE_WAIT_S < 30, de.SPACE_WAIT_S
        assert "retry" in out["message"].lower(), out
        # agent spaces phase 2: the relay answers "starting" only after its own 2 s race, so a query must wait
        # longer than that; and the whole hook, slow queries included, stays inside SPACE_WAIT_S
        starting = {"t": "route", "ok": False, "busy": True, "error": "Your desktop is starting; retry the same action now."}
        timeouts = []

        def slow_relay(identity, timeout=2.0):
            timeouts.append(timeout)
            if timeout <= 2.0:                                    # the socket would time out before the answer
                clock[0] += timeout
                return None
            clock[0] += 2.05                                      # the relay answers at >= 2000 ms
            return dict(starting)

        de._relay_query = slow_relay
        slept.clear()
        t0 = clock[0]
        out = pre({"action": "capture", "app": "screen"})
        assert out["action"] == "block" and "Your desktop is starting" in out["message"], out
        assert "retry" in out["message"].lower(), out
        assert clock[0] - t0 <= de.SPACE_WAIT_S, clock[0] - t0     # never past Hermes' hook bound
        assert de.QUERY_TIMEOUT > 2.0 and timeouts[0] == de.QUERY_TIMEOUT, timeouts
    finally:
        de.time.sleep = real_sleep
        de.time.monotonic = real_monotonic
        de._relay_query = fake_query
    # a crash inside the fence fails closed; other tools stay untouched; DECK_BOT_SCREEN=0 turns it all off
    de._relay_query = lambda identity, timeout=2.0: 1 / 0
    assert "fence failed" in pre({"action": "capture"})["message"]
    de._relay_query = fake_query
    assert h["pre_tool_call"](tool_name="terminal", args={"command": "ls"}, session_id="cu1") is None
    os.environ["DECK_BOT_SCREEN"] = "0"
    n = len(queries)
    assert pre({"action": "capture", "app": "screen"}) is None and len(queries) == n
    del os.environ["DECK_BOT_SCREEN"]


    # ---- Bot ekranı: frames and cu events --------------------------------------------------------------------
    def png(w, h_):
        """A valid grey PNG, no Pillow needed."""
        raw = b"".join(b"\x00" + b"\x80" * w for _ in range(h_))
        chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
        return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h_, 8, 0, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


    def post(args, result, status="ok", sid="cu2", **kw):
        h["post_tool_call"](tool_name="computer_use", args=args, session_id=sid, result=result, status=status, **kw)


    def cu_events():
        lines_ = (Path(tmp) / "testprof.ndjson").read_text(encoding="utf-8").splitlines()
        return [r for r in map(json.loads, lines_) if r.get("type") == "cu"]


    route.update(device=PC, grant=dict(GRANT), deckPid=999, live=True, epoch=6)
    assert pre({"action": "capture"}, sid="cu2")["action"] == "modify"      # routed and pinned
    summary = ("capture mode=som 2000x1000 app=Notepad window='notes.txt'\n1 interactable element(s):\n"
               "  #3 AXButton 'Save' @ (100, 200, 40, 20) [Notepad]")
    shot = base64.b64encode(png(2000, 1000)).decode()
    post({"action": "capture", "pid": 4242, "window_id": 77, "app": "Notepad"},
         {"_multimodal": True, "text_summary": summary, "meta": {"mode": "som", "width": 2000, "height": 1000},
          "content": [{"type": "text", "text": summary},
                      {"type": "image_url", "image_url": {"url": "data:image/png;base64," + shot}}]})
    post({"action": "click", "element": 3}, json.dumps({"ok": True, "action": "click"}))
    post({"action": "right_click", "coordinate": [1000, 500]}, json.dumps({"ok": True, "action": "right_click"}))
    post({"action": "type", "text": "x"}, json.dumps({"error": "Bot ekranı: capture first"}), status="blocked",
         error_message="Bot ekranı: capture first")
    cap, click, rclick, blocked = cu_events()[-4:]
    frame = deck_home / "cu" / cap["frame"]
    assert cap["action"] == "capture" and cap["device"] == PC and cap["ok"] is True and cap["ts"] > 1e12
    assert cap["window"] == {"id": 77, "app": "Notepad"} and cap["frame"].startswith("testprof/cu2/"), cap
    assert frame.is_file() and not list(frame.parent.glob("*.tmp"))
    try:
        from PIL import Image
    except ImportError:
        Image = None
    if Image is not None:                         # JPEG, 1280 px wide; points scale with it
        with Image.open(frame) as im:
            assert im.format == "JPEG" and im.size == (1280, 640), im.size
        scale = 1280 / 2000
    else:                                         # no Pillow: the original PNG, unscaled
        scale = 1.0
    assert (click["x"], click["y"]) == (round(120 * scale), round(210 * scale)), click   # centre of element #3
    assert click["frame"] == cap["frame"] and click["window"] == cap["window"] and click["ok"] is True
    assert rclick["action"] == "click" and rclick["raw"] == "right_click"
    assert (rclick["x"], rclick["y"]) == (round(1000 * scale), round(500 * scale))
    assert blocked["action"] == "type" and blocked["ok"] is False and "capture first" in blocked["error"]
    # a text capture (ax mode, or aux vision) brings its picture through Hermes' screenshot_path copy
    shot_file = Path(tmp) / "computer_use_0123abcd.png"
    shot_file.write_bytes(png(800, 600))
    post({"action": "capture", "mode": "vision"}, json.dumps({"mode": "vision", "width": 800, "height": 600,
                                                              "elements": [], "screenshot_path": str(shot_file)}))
    last = cu_events()[-1]
    assert last["frame"] and last["frame"] != cap["frame"] and (deck_home / "cu" / last["frame"]).is_file()
    # a path that is not one of Hermes' capture copies is never read
    post({"action": "capture"}, json.dumps({"mode": "som", "screenshot_path": str(Path(tmp) / "testprof.ndjson")}))
    assert cu_events()[-1]["frame"] is None
    # A closed device transport must retire Hermes' cached backend and require a fresh capture.
    released.clear()
    post({"action": "capture"}, json.dumps({"ok": False, "error": "capture failed: Connection closed"}))
    assert released == ["cu2"], released
    assert de._cu["cu2"]["pinned"] is None and de._cu["cu2"]["frame"] is None
    route["live"] = False
    assert pre({"action": "click", "coordinate": [5, 5]}, sid="cu2")["action"] == "block"
    assert pre({"action": "capture"}, sid="cu2")["action"] == "modify"
    post({"action": "capture"}, json.dumps({"ok": False, "error": "window capture unavailable"}))
    assert released == ["cu2"], "ordinary capture errors do not retire the backend"
    assert pre({"action": "click", "coordinate": [5, 5]}, sid="cu2")["action"] == "block", "failed capture never authorizes input"
    before_queries = len(queries)
    post({"action": "click", "coordinate": [5, 5]}, json.dumps({"error": "Connection closed"}))
    assert released == ["cu2", "cu2"] and len(queries) == before_queries, "an uncertain input is retired, never replayed"
    assert pre({"action": "click", "coordinate": [5, 5]}, sid="cu2")["action"] == "block"
    h["on_session_end"](session_id="cu2")
    assert "cu2" not in de._cu

    print(f"OK  {len(lines)} events + rotation + snapshot + bot screen fence/frames, sample:\n{lines[3]}")


class EventsScript(unittest.TestCase):
    """`python -m unittest discover` picks this file up too. The checks above set process-wide environment
    (DECK_HOME, HERMES_DECK_BRIDGE=0, ...) and load the plugin under a fixed module name, so the discover run
    gives them a fresh interpreter instead of leaking that state into the other test files."""

    def test_events_part(self):
        r = subprocess.run([sys.executable, str(Path(__file__).resolve())], capture_output=True, text=True,
                           timeout=120)
        self.assertEqual(r.returncode, 0, f"{r.stdout}\n{r.stderr}")
        self.assertIn("OK  ", r.stdout)


if __name__ == "__main__":
    checks()
    sys.exit(run_others(sys.argv))
