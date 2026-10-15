"""hermes-deck bridge stream (stream.py). Run with any Python 3.10+:  python test_stream.py

StreamTests are Hermes Desk's windows/hermes/tests/test_stream.py pointed at stream.py,
driving serve() instead of main(). The other classes cover what hermes-deck changed (where the Hermes home
comes from, process checks) and what Hermes Deck's app/main/bridge.js expects on the wire. EndToEndTests run
the real observer control socket and the real stream together (testhost.py); they need Unix sockets, so
they run on Linux/macOS (CI) and are skipped on Windows.
"""
import importlib.util
import io
import json
import os
import queue
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import sqlite3
from contextlib import contextmanager, ExitStack
from pathlib import Path
from unittest.mock import patch

from testsupport import unittest_main

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("hermes_deck_stream_under_test", HERE / "stream.py")
stream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stream)


class RemovedAdapterTests(unittest.TestCase):
    def test_private_gateway_session_mutation_is_rejected(self):
        import observer
        self.assertFalse(observer.allowed_request("deck.gateway_session_set", {"session_id": "s", "model": "m", "provider": "p"}))
        self.assertNotIn("deck.gateway_session_set", stream.ONE_SHOT)


class SocketPeer:
    """Real framed socket I/O; only local Unix connect is adapted on Windows."""
    def __init__(self, mode="reply", count=1):
        self.client, self.server = socket.socketpair()
        self.mode, self.count = mode, count
        self.connected, self.sent, self.received, self.release = (threading.Event() for _ in range(4))
        self.requests = []
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        try:
            with self.server.makefile("rb") as incoming:
                for _ in range(self.count):
                    line = incoming.readline()
                    if not line: return
                    request = json.loads(line)
                    self.requests.append(request)
                    self.received.set()
                if self.mode == "stall_reply":
                    self.release.wait(5)
                elif self.mode == "trickle_reply":
                    deadline = time.monotonic()+.45
                    while time.monotonic() < deadline and not self.release.is_set():
                        self.server.sendall(b" ")
                        self.release.wait(.03)
                elif self.mode == "delayed_reply":
                    time.sleep(.3)
                    self.server.sendall(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"status":"accepted"}}).encode()+b"\n")
                elif self.mode == "reply":
                    self.server.sendall(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"status":"accepted"}}).encode()+b"\n")
                # Other modes close without a matching reply.
        except OSError:
            pass
        finally:
            self.server.close()

    def close(self):
        self.release.set()
        for conn in (self.client, self.server):
            try: conn.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            conn.close()
        self.thread.join(1)


class RelaySocket:
    def __init__(self, peers):
        self.peers, self.peer, self.timeout = peers, None, None

    def settimeout(self, value):
        self.timeout = value
        if self.peer: self.peer.client.settimeout(value)

    def connect(self, path):
        self.peer = self.peers[path].get_nowait()
        self.peer.client.settimeout(self.timeout)
        self.peer.connected.set()
        if self.peer.mode == "stall_connect":
            self.peer.release.wait(self.timeout)
            raise socket.timeout("Synthetic stalled connect")

    def sendall(self, frame):
        self.peer.sent.set()
        if self.peer.mode == "stall_write":
            self.peer.release.wait(self.timeout)
            raise socket.timeout("Synthetic stalled write")
        return self.peer.client.sendall(frame)

    def __getattr__(self, key):
        return getattr(self.peer.client, key)

    def close(self):
        if self.peer: self.peer.client.close()

    def __enter__(self): return self
    def __exit__(self, *_): self.close()


class JsonCapture:
    def __init__(self):
        self.frames, self.replies, self.buffer = queue.Queue(), {}, ""
        self.lock = threading.Lock()

    def write(self, value):
        with self.lock:
            self.buffer += value
            while "\n" in self.buffer:
                line, self.buffer = self.buffer.split("\n", 1)
                self.frames.put(json.loads(line))
        return len(value)

    def flush(self): pass

    def reply(self, request_id, timeout=.8):
        deadline = time.monotonic()+timeout
        while request_id not in self.replies:
            try:
                frame = self.frames.get(timeout=max(0,deadline-time.monotonic()))
            except queue.Empty:
                raise AssertionError(f"No terminal reply for {request_id} within {timeout}s") from None
            if "id" in frame and ("result" in frame or "error" in frame):
                self.replies[frame["id"]] = frame
        return self.replies.pop(request_id)


@contextmanager
def running_control_stream(peers):
    stop, inputs, capture = threading.Event(), queue.Queue(), JsonCapture()
    peer_queues = {}
    for path, entries in peers.items():
        peer_queues[path] = queue.Queue()
        for peer in entries: peer_queues[path].put(peer)
    class Stopped(Exception): pass
    def collect(_, **_kwargs):
        if stop.is_set(): raise Stopped()
        return []
    def stdin():
        while (line := inputs.get()) is not None:
            yield line
    with tempfile.TemporaryDirectory() as tmp, ExitStack() as patches:
        def run():
            try: stream.serve(tmp, follow=True, stdin=stdin(), stdout=capture)
            except Stopped: pass
        patches.enter_context(patch.object(stream,"collect_nodes",side_effect=collect))
        patches.enter_context(patch.object(stream,"collect_registered_nodes",return_value=[]))
        patches.enter_context(patch.object(stream,"enrich_child_titles"))
        patches.enter_context(patch.object(stream,"endpoint",side_effect=lambda _home,pid=None:"native" if pid is not None else "ordinary"))
        patches.enter_context(patch.object(stream,"CONTROL_TIMEOUT",.15,create=True))
        patches.enter_context(patch.object(stream.socket,"AF_UNIX",object(),create=True))
        patches.enter_context(patch.object(stream.socket,"socket",side_effect=lambda *_:RelaySocket(peer_queues)))
        runner = threading.Thread(target=run, daemon=True)
        runner.start()
        try:
            yield lambda request:inputs.put(json.dumps(request)+"\n"), capture
        finally:
            inputs.put(None)
            stop.set()
            for entries in peers.values():
                for peer in entries: peer.close()
            runner.join(1)


def serve_once(home, **patches):
    out = io.StringIO()
    with ExitStack() as stack:
        for name, value in patches.items():
            stack.enter_context(patch.object(stream, name, value))
        stream.serve(home, stdout=out)
    return json.loads(out.getvalue())


class StreamTests(unittest.TestCase):
    def test_only_the_new_runtime_and_schema_are_observed(self):
        with tempfile.TemporaryDirectory() as tmp:
            home, now = Path(tmp), time.time()
            for folder, schema, pid in (("hermes-deck", "hermes-deck.v1", 11),
                                        ("retired-runtime", "hermes-deck.v1", 22),
                                        ("hermes-deck", "retired-bridge.v1", 33)):
                base = home / folder
                (base / "processes").mkdir(parents=True, exist_ok=True)
                control = base / f"control-{pid}-test.sock"
                control.touch()
                sid = str(pid)
                (base / "processes" / f"{pid}.json").write_text(json.dumps(dict(
                    schema=schema, pid=pid, updated_at=now, control_socket=str(control),
                    nodes={sid: dict(session_id=sid, updated_at=now, terminal_at=None)})))
            snap = serve_once(home, alive=lambda pid: True)
            self.assertEqual({n["session_id"] for n in snap["nodes"]}, {"11"})
            self.assertEqual(snap["schema"], "hermes-deck.v1")
            self.assertEqual(list(stream.observer_bases(home)), [("default", home / "hermes-deck")])
            with patch.object(stream, "alive", return_value=True):
                self.assertEqual(stream.endpoint(home, 11), (home / "hermes-deck" / "control-11-test.sock").resolve())
                self.assertIsNone(stream.endpoint(home, 22))
                self.assertIsNone(stream.endpoint(home, 33))
            self.assertEqual(stream.default_home(home / "hermes-deck" / "stream.py", {}), home)

    def test_named_profile_observer_root_and_child_metadata_reach_the_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            home, now = Path(tmp), time.time()
            default = home/"hermes-deck"/"processes"
            named = home/"profiles"/"research"/"hermes-deck"/"processes"
            default.mkdir(parents=True)
            named.mkdir(parents=True)
            (default/"11.json").write_text(json.dumps(dict(schema="hermes-deck.v1",pid=11,updated_at=now,
                nodes={"main":dict(session_id="main",updated_at=now,terminal_at=None,profile_name="default")})))
            (named/"22.json").write_text(json.dumps(dict(schema="hermes-deck.v1",pid=22,updated_at=now,
                nodes={
                    "research-root":dict(session_id="research-root",parent_session_id="",updated_at=now,
                        terminal_at=None,profile_name="research",provider="example-provider",model="example-model",
                        control_available=True,context_used=50,context_max=100,title="Review sources"),
                    "research-child":dict(session_id="research-child",parent_session_id="research-root",updated_at=now,
                        terminal_at=None,profile_name="default",origin="omh",control_available=True,
                        title="Inspect sources",name="OMH · Inspect sources")})))
            by_id = {node["session_id"]:node for node in serve_once(tmp, alive=lambda pid: True)["nodes"]}
            self.assertEqual(set(by_id), {"main","research-root","research-child"})
            self.assertEqual(by_id["research-root"]["profile_name"], "research")
            self.assertEqual(by_id["research-child"]["profile_name"], "research")
            self.assertEqual(by_id["research-child"]["parent_session_id"], "research-root")
            self.assertEqual(by_id["research-root"]["context_used"], 50)
            self.assertEqual(by_id["research-root"]["provider"], "example-provider")
            self.assertTrue(all(by_id[sid]["owner_pid"] == 22 and by_id[sid]["control_available"]
                                for sid in ("research-root","research-child")))

    def test_named_profile_owner_endpoint_uses_only_fresh_valid_manifests_and_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            home, now = Path(tmp), time.time()
            paths = {}
            for profile, pid in (("default",11),("research",22),("bad profile",33)):
                base = (home if profile == "default" else home/"profiles"/profile)/"hermes-deck"
                (base/"processes").mkdir(parents=True)
                path = base/f"control-{pid}-example.sock"
                path.touch()
                paths[pid] = path
                (base/"processes"/f"{pid}.json").write_text(json.dumps(dict(
                    schema="hermes-deck.v1",pid=pid,updated_at=now,control_socket=str(path),nodes={})))
            (home/"gateway_state.json").write_text(json.dumps({"pid":11}))
            base = home/"profiles"/"research"/"hermes-deck"
            for stem, pid, updated, outside in ((44,44,now-100,False),(55,55,now,True),(66,77,now,False),(88,88,now,False)):
                path = (home if outside else base)/f"control-{pid}-example.sock"
                path.touch()
                (base/"processes"/f"{stem}.json").write_text(json.dumps(dict(
                    schema="hermes-deck.v1",pid=pid,updated_at=updated,control_socket=str(path),nodes={})))
            with patch.object(stream,"alive",side_effect=lambda pid:pid != 88):
                self.assertEqual(stream.endpoint(home,22), paths[22].resolve())
                self.assertEqual(stream.endpoint(home), paths[11].resolve())
                for pid in (33,44,55,77,88,999):
                    with self.subTest(owner_pid=pid):
                        self.assertIsNone(stream.endpoint(home,pid))

    def test_profile_aliases_do_not_duplicate_nodes_or_escape_the_profile_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            home, now = Path(tmp)/"home", time.time()
            named = home/"profiles"/"research"
            processes = named/"hermes-deck"/"processes"
            processes.mkdir(parents=True)
            outside = Path(tmp)/"outside"
            outside_processes = outside/"hermes-deck"/"processes"
            outside_processes.mkdir(parents=True)
            (outside_processes/"33.json").write_text(json.dumps(dict(schema="hermes-deck.v1",pid=33,updated_at=now,
                nodes={"outside-root":dict(session_id="outside-root",updated_at=now,terminal_at=None)})))
            try:
                (home/"profiles"/"research-alias").symlink_to(named,target_is_directory=True)
                (home/"profiles"/"escape").symlink_to(outside,target_is_directory=True)
            except OSError:
                self.skipTest("Directory symlink creation unavailable on this Windows host")
            (processes/"22.json").write_text(json.dumps(dict(schema="hermes-deck.v1",pid=22,updated_at=now,
                nodes={"research-root":dict(session_id="research-root",updated_at=now,terminal_at=None)})))
            nodes = serve_once(home, alive=lambda pid: True)["nodes"]
            self.assertEqual([node["session_id"] for node in nodes], ["research-root"])
            self.assertEqual(nodes[0]["profile_name"], "research")

    def test_registered_merge_keeps_compression_lineage_separate_from_delegate_parent(self):
        nodes = [{"session_id":"compressed","parent_session_id":"","role":"main"},
                 {"session_id":"observed","parent_session_id":"","lineage_parent_session_id":"fresh-ancestor","role":"main"}]
        registered = [{"session_id":"compressed","lineage_parent_session_id":"old-root","parent_session_id":""},
                      {"session_id":"observed","lineage_parent_session_id":"old-ancestor","parent_session_id":""}]
        with tempfile.TemporaryDirectory() as tmp, patch.object(stream,"enrich_child_titles"):
            snap = serve_once(tmp, collect_observer_nodes=lambda *a, **k: nodes,
                              collect_registered_nodes=lambda *a, **k: registered)
        by_id = {node["session_id"]:node for node in snap["nodes"]}
        self.assertEqual(by_id["compressed"].get("lineage_parent_session_id"), "old-root")
        self.assertEqual(by_id["observed"]["lineage_parent_session_id"], "fresh-ancestor")
        self.assertTrue(all(node["parent_session_id"] == "" and node["role"] == "main" for node in by_id.values()))

    def test_takeover_routes_to_the_live_owner_not_the_default_gateway(self):
        peer = SocketPeer()
        with running_control_stream({"native": [peer]}) as (send, capture):
            send({"jsonrpc":"2.0","id":"take","method":"deck.takeover",
                  "params":{"session_id":"stored","profile":"alpha","owner_pid":22}})
            self.assertEqual(capture.reply("take")["result"], {"status":"accepted"})
            self.assertNotIn("owner_pid", peer.requests[0]["params"])

    def test_takeover_retains_owner_socket_for_submit_and_reaped_resume(self):
        class OwnerPeer(SocketPeer):
            def serve(self):
                try:
                    with self.server.makefile("rb") as incoming:
                        for line in incoming:
                            request = json.loads(line)
                            self.requests.append(request)
                            if request["method"] == "deck.takeover": result = {"ok": True, "mode": "transferred", "session_id": "rpc-owned"}
                            elif request["method"] == "session.resume": result = {"session_id": "rpc-new"}
                            else: result = {"status": "accepted"}
                            self.server.sendall(json.dumps({"jsonrpc":"2.0", "id":request["id"], "result":result}).encode()+b"\n")
                except OSError: pass
                finally: self.server.close()
        peer = OwnerPeer()
        with running_control_stream({"native": [peer]}) as (send, capture):
            for rid, method, params in [
                ("take", "deck.takeover", {"session_id":"stored", "profile":"alpha", "owner_pid":22}),
                ("submit", "prompt.submit", {"session_id":"rpc-owned", "text":"hello"}),
                ("resume", "session.resume", {"session_id":"stored", "profile":"alpha"}),
                ("retry", "prompt.submit", {"session_id":"rpc-new", "text":"again"})]:
                send({"jsonrpc":"2.0","id":rid,"method":method,"params":params})
                self.assertIn("result", capture.reply(rid))
            self.assertEqual(len(peer.requests), 4)

    def test_native_interrupt_does_not_wait_for_an_earlier_native_reply(self):
        stalled, interrupt = SocketPeer("stall_reply"), SocketPeer()
        with running_control_stream({"native":[stalled,interrupt]}) as (send, capture):
            send({"jsonrpc":"2.0","id":"steer","method":"native.steer","params":{"owner_pid":22}})
            self.assertTrue(stalled.received.wait(.5))
            send({"jsonrpc":"2.0","id":"interrupt","method":"native.interrupt","params":{"owner_pid":22}})
            self.assertEqual(capture.reply("interrupt",.5)["result"], {"status":"accepted"})
            self.assertIn("uncertain", capture.reply("steer")["error"]["message"])

    def test_native_interrupt_does_not_wait_for_stalled_ordinary_connect_or_write(self):
        for mode in ("stall_connect","stall_write"):
            with self.subTest(mode=mode):
                stalled, interrupt = SocketPeer(mode), SocketPeer()
                with running_control_stream({"ordinary":[stalled],"native":[interrupt]}) as (send, capture):
                    send({"jsonrpc":"2.0","id":"ordinary","method":"session.messages","params":{}})
                    self.assertTrue((stalled.connected if mode == "stall_connect" else stalled.sent).wait(.5))
                    send({"jsonrpc":"2.0","id":"interrupt","method":"native.interrupt","params":{"owner_pid":22}})
                    self.assertEqual(capture.reply("interrupt",.5)["result"], {"status":"accepted"})
                    self.assertEqual(capture.reply("ordinary")["error"]["code"], -32001)

    def test_native_eof_without_matching_reply_reports_uncertain_outcome(self):
        peer = SocketPeer("eof")
        with running_control_stream({"native":[peer]}) as (send, capture):
            send({"jsonrpc":"2.0","id":"native-eof","method":"native.steer","params":{"owner_pid":22}})
            error = capture.reply("native-eof")["error"]
            self.assertEqual(error["code"], -32001)
            self.assertIn("uncertain", error["message"])

    def test_native_reply_deadline_is_not_extended_by_trickled_partial_frames(self):
        peer = SocketPeer("trickle_reply")
        with running_control_stream({"native":[peer]}) as (send, capture):
            send({"jsonrpc":"2.0","id":"trickle","method":"native.steer","params":{"owner_pid":22}})
            self.assertIn("uncertain", capture.reply("trickle",.3)["error"]["message"])

    def test_gateway_eof_reports_every_pending_request_without_replay(self):
        peer = SocketPeer("eof",count=2)
        with running_control_stream({"ordinary":[peer]}) as (send, capture):
            for request_id in ("first","second"):
                send({"jsonrpc":"2.0","id":request_id,"method":"session.messages","params":{}})
            for request_id in ("first","second"):
                error = capture.reply(request_id)["error"]
                self.assertEqual(error["code"], -32001)
                self.assertIn("uncertain", error["message"])
            self.assertEqual([request["id"] for request in peer.requests], ["first","second"])

    def test_gateway_reader_survives_idle_timeouts_until_a_reply_arrives(self):
        peer = SocketPeer("delayed_reply")
        with running_control_stream({"ordinary":[peer]}) as (send, capture):
            send({"jsonrpc":"2.0","id":"delayed","method":"session.messages","params":{}})
            self.assertEqual(capture.reply("delayed")["result"], {"status":"accepted"})

    def test_registered_root_and_child_titles_redact_credentials_before_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home/"runtime").mkdir()
            (home/"runtime"/"active_sessions.json").write_text(json.dumps({"entries":[
                {"session_id":sid,"pid":22,"surface":"cli"} for sid in ("root","child")]}))
            with sqlite3.connect(home/"state.db") as db:
                db.execute("CREATE TABLE sessions (id TEXT, source TEXT, parent_session_id TEXT, title TEXT)")
                db.executemany("INSERT INTO sessions VALUES (?,?,?,?)", [
                    ("root","cli",None,"Review\tconfig\x00 token=example\nPrivate remainder"),
                    ("child","subagent","root","Review\tconfig\x00 token=example\nPrivate remainder")])
            db.close()
            nodes = stream.collect_registered_nodes(home, now=1005, alive=lambda pid:pid==22)
            by_id = {node["session_id"]:node for node in nodes}
            for sid in ("root","child"):
                with self.subTest(session_id=sid):
                    self.assertEqual(by_id[sid]["title"], "Review config token=[redacted]")
            self.assertEqual(by_id["root"]["name"], "Hermes · Cli")
            self.assertEqual(by_id["child"]["name"], "Hermes · Review config token=[redacted]")
            self.assertNotIn("example", json.dumps(nodes))
            self.assertNotIn("Private remainder", json.dumps(nodes))

    def test_registered_root_and_child_titles_are_bounded_without_losing_readable_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home/"runtime").mkdir()
            (home/"runtime"/"active_sessions.json").write_text(json.dumps({"entries":[
                {"session_id":sid,"pid":22,"surface":"cli"} for sid in ("root","child")]}))
            with sqlite3.connect(home/"state.db") as db:
                db.execute("CREATE TABLE sessions (id TEXT, source TEXT, parent_session_id TEXT, title TEXT)")
                db.executemany("INSERT INTO sessions VALUES (?,?,?,?)", [
                    ("root","cli",None,"Review "+"x"*200),
                    ("child","subagent","root","Review "+"x"*200)])
            db.close()
            nodes = stream.collect_registered_nodes(home, now=1005, alive=lambda pid:pid==22)
            by_id = {node["session_id"]:node for node in nodes}
            for sid in ("root","child"):
                with self.subTest(session_id=sid):
                    self.assertEqual(by_id[sid]["title"], "Review "+"x"*73)
            self.assertEqual(by_id["root"]["name"], "Hermes · Cli")
            self.assertEqual(by_id["child"]["name"], "Hermes · Review "+"x"*73)

    def test_snapshot_root_and_child_labels_redact_credentials_at_the_stream_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder/"11.json").write_text(json.dumps(dict(schema="hermes-deck.v1",pid=11,updated_at=1000,
                nodes={
                    "root":dict(session_id="root",parent_session_id="",updated_at=1000,terminal_at=None,
                                title="Review API migration password=example\nPrivate remainder",
                                name="Hermes · Review API migration password=example"),
                    "child":dict(session_id="child",parent_session_id="root",updated_at=1000,terminal_at=None,
                                 title="Inspect logs Bearer example\nPrivate remainder",
                                 name="OMH · Inspect logs Bearer example")})))
            nodes = stream.collect_nodes(folder, now=1005, alive=lambda _:True)
            by_id = {node["session_id"]:node for node in nodes}
            self.assertEqual(by_id["root"]["title"], "Review API migration password=[redacted]")
            self.assertEqual(by_id["root"]["name"], "Hermes · Review API migration password=[redacted]")
            self.assertEqual(by_id["child"]["title"], "Inspect logs Bearer [redacted]")
            self.assertEqual(by_id["child"]["name"], "OMH · Inspect logs Bearer [redacted]")
            self.assertNotIn("example", json.dumps(nodes))
            self.assertNotIn("Private remainder", json.dumps(nodes))

    def test_safe_title_preserves_readable_text_and_removes_supported_credential_values(self):
        provider_key = "sk-"+"example_fixture_"*2
        cases = [
            ("Plan API migration", "Plan API migration"),
            ("Review api_key=example", "Review api_key=[redacted]"),
            ("Review access-token='example'", "Review access-token=[redacted]"),
            ("Review Bearer example", "Review Bearer [redacted]"),
            ("Review authorization=example", "Review authorization=[redacted]"),
            ("Review "+provider_key, "Review [redacted]"),
            ("Review https://example:example@example.test/path", "Review https://[redacted]@example.test/path"),
            (None, ""),
            (123, ""),
        ]
        for raw, expected in cases:
            with self.subTest(title=raw):
                self.assertEqual(stream.safe_title(raw), expected)

    def test_registered_gateway_conversations_use_real_ids_and_never_claim_live_controls(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home/"runtime").mkdir()
            (home/"runtime"/"active_sessions.json").write_text(json.dumps({"entries":[
                {"session_id":"child","pid":22,"surface":"cli","metadata":{}},
                {"session_id":"dead","pid":33,"surface":"cli","metadata":{}}]}))
            with sqlite3.connect(home/"state.db") as db:
                db.execute("CREATE TABLE sessions (id TEXT, source TEXT, model TEXT, billing_provider TEXT, parent_session_id TEXT, model_config TEXT, profile_name TEXT)")
                db.execute("CREATE TABLE gateway_routing (entry_json TEXT, updated_at REAL)")
                db.execute("CREATE TABLE session_turn_leases (conversation_id TEXT, holder TEXT, acquired_at REAL, expires_at REAL)")
                db.executemany("INSERT INTO sessions VALUES (?,?,?,?,?,?,?)", [
                    ("current","telegram","real-model","real-provider","old-compression-parent",'{"api_key":"example"}',"default"),
                    ("child","subagent","child-model","child-provider","current",'{"_delegate_from":"current"}',"default"),
                    ("historical","cli","old-model","old-provider",None,'{}',"default")])
                db.execute("INSERT INTO gateway_routing VALUES (?,?)",(json.dumps({"session_id":"current","platform":"telegram","last_prompt_tokens":12000}),1000))
                db.executemany("INSERT INTO session_turn_leases VALUES (?,?,?,?)", [
                    ("child","pid=22:turn=child-turn:platform=subagent",1000,1300),
                    ("historical","pid=22:turn=old:platform=cli",700,900)])
            db.close()
            nodes = stream.collect_registered_nodes(home, now=1005, alive=lambda pid:pid==22)
            by_id = {n["session_id"]:n for n in nodes}
            self.assertEqual(set(by_id), {"current","child"})
            self.assertEqual((by_id["current"]["model"],by_id["current"]["provider"],by_id["current"]["parent_session_id"]),
                             ("real-model","real-provider",""))
            self.assertEqual(by_id["current"]["state"], "idle")
            self.assertEqual((by_id["child"]["parent_session_id"],by_id["child"]["state"]), ("current","working"))
            self.assertTrue(all(n["control_available"] is False for n in nodes))
            self.assertNotIn("example",json.dumps(nodes))

    def _ghost_home(self, tmp, with_sessions_table=True):
        home = Path(tmp)
        (home/"runtime").mkdir()
        (home/"runtime"/"active_sessions.json").write_text(json.dumps({"entries":[
            {"session_id":"registered-no-row","pid":22,"surface":"cli"}]}))
        with sqlite3.connect(home/"state.db") as db:
            if with_sessions_table:
                db.execute("CREATE TABLE sessions (id TEXT, source TEXT, title TEXT)")
                db.execute("INSERT INTO sessions VALUES ('kept','discord','Real chat')")
            db.execute("CREATE TABLE gateway_routing (entry_json TEXT, updated_at REAL)")
            db.execute("CREATE TABLE session_turn_leases (conversation_id TEXT, holder TEXT, acquired_at REAL, expires_at REAL)")
            db.executemany("INSERT INTO gateway_routing VALUES (?,?)", [
                (json.dumps({"session_id":sid,"platform":"discord"}), 1000)
                for sid in ("kept","deleted-a","deleted-b","leased-no-row")])
            db.execute("INSERT INTO session_turn_leases VALUES (?,?,?,?)",
                       ("leased-no-row","pid=22:turn=x:platform=discord",1000,1300))
        db.close()
        return home

    def test_routing_entries_of_deleted_sessions_are_not_ghost_nodes(self):
        # Hermes' session.delete drops the sessions row but leaves gateway_routing behind.
        with tempfile.TemporaryDirectory() as tmp:
            home = self._ghost_home(tmp)
            nodes = stream.collect_registered_nodes(home, now=1005, alive=lambda pid:pid==22)
            ids = {n["session_id"] for n in nodes}
            self.assertEqual(ids, {"kept","leased-no-row","registered-no-row"})
            self.assertNotIn("deleted-a", ids)
            self.assertNotIn("deleted-b", ids)
            by_id = {n["session_id"]:n for n in nodes}
            self.assertEqual(by_id["kept"]["title"], "Real chat")
            self.assertTrue(by_id["leased-no-row"]["active"])   # a live lease proves a just-minted session

    def test_nothing_is_dropped_when_a_profile_database_cannot_prove_absence(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = self._ghost_home(tmp, with_sessions_table=False)
            nodes = stream.collect_registered_nodes(home, now=1005, alive=lambda pid:pid==22)
            self.assertIn("deleted-a", {n["session_id"] for n in nodes})

    def test_persisted_child_title_supersedes_goal_fallback_without_exporting_secret_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            db = sqlite3.connect(home/"state.db")
            with db:
                db.execute("CREATE TABLE sessions (id TEXT, title TEXT)")
                db.execute("INSERT INTO sessions VALUES (?,?)", ("child","Review config token=example\nPrivate remainder"))
            db.close()
            nodes = [{"session_id":"child","parent_session_id":"main","title":"Fallback task","origin":"omh","name":"OMH · leaf"}]
            stream.enrich_child_titles(home,nodes)
            self.assertEqual(nodes[0]["title"], "Review config token=[redacted]")
            self.assertEqual(nodes[0]["name"], "OMH · Review config token=[redacted]")
            self.assertNotIn("example",json.dumps(nodes))
            self.assertNotIn("Private remainder",json.dumps(nodes))

    def test_compressed_turn_lease_keeps_the_current_native_session_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            db = sqlite3.connect(home/"state.db")
            with db:
                db.execute("CREATE TABLE sessions (id TEXT, source TEXT, model TEXT)")
                db.execute("CREATE TABLE gateway_routing (entry_json TEXT, updated_at REAL)")
                db.execute("CREATE TABLE session_turn_leases (conversation_id TEXT, holder TEXT, acquired_at REAL, expires_at REAL)")
                db.execute("INSERT INTO sessions VALUES ('current','telegram','real-model')")
                db.execute("INSERT INTO gateway_routing VALUES (?,?)",(json.dumps({"session_id":"current","platform":"telegram"}),1000))
                db.execute("INSERT INTO session_turn_leases VALUES (?,?,?,?)",("old-root","pid=22:turn=current:task:12345678:platform=telegram",1000,1300))
            db.close()
            nodes = stream.collect_registered_nodes(home, now=1005, alive=lambda pid:pid==22)
            self.assertEqual([n["session_id"] for n in nodes], ["current"])
            self.assertEqual(nodes[0]["state"], "working")

    def test_live_native_sessions_merge_across_processes_and_dead_processes_are_dropped(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            for pid, sid in ((11,"main"),(12,"child"),(13,"dead")):
                (folder/f"{pid}.json").write_text(json.dumps(dict(schema="hermes-deck.v1",pid=pid,updated_at=1000,
                    nodes={sid:dict(session_id=sid,updated_at=1000,terminal_at=None)})))
            nodes = stream.collect_nodes(folder, now=1005, alive=lambda pid:pid!=13)
            self.assertEqual({n["session_id"] for n in nodes}, {"main","child"})

    def test_expired_finished_children_and_stale_emitters_are_not_resurrected(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder/"11.json").write_text(json.dumps(dict(schema="hermes-deck.v1",pid=11,updated_at=1000,
                nodes={"done":dict(session_id="done",updated_at=700,terminal_at=700),
                       "active":dict(session_id="active",updated_at=900,terminal_at=None)})))
            self.assertEqual([n["session_id"] for n in stream.collect_nodes(folder, now=1005,alive=lambda _:True)], ["active"])
            self.assertEqual(stream.collect_nodes(folder, now=1200,alive=lambda _:True), [])


# ---------------------------------------------------------------------------- what hermes-deck changed

class HomeAndProcessTests(unittest.TestCase):
    def test_the_installed_location_names_the_hermes_home(self):
        root = Path(tempfile.gettempdir()) / "h" / ".hermes"
        env = {"HERMES_HOME": str(Path(tempfile.gettempdir()) / "elsewhere")}
        self.assertEqual(stream.default_home(root/"hermes-deck"/"stream.py", env), root)
        self.assertEqual(stream.default_home(root/"profiles"/"research"/"hermes-deck"/"stream.py", env), root)
        self.assertEqual(stream.default_home(root/"plugins"/"hermes-deck"/"stream.py", env), root)
        self.assertEqual(stream.default_home(root/"profiles"/"research"/"plugins"/"hermes-deck"/"stream.py", env), root)
        checkout = Path(tempfile.gettempdir()) / "src" / "hermes-plugin" / "hermes-deck" / "stream.py"
        self.assertEqual(stream.default_home(checkout, env), Path(env["HERMES_HOME"]))
        self.assertEqual(stream.default_home(checkout, {"HERMES_HOME": str(root/"profiles"/"x")}), root)
        self.assertEqual(stream.default_home(checkout, {}), Path.home()/".hermes")

    def test_process_checks_never_signal_a_process_group_or_anything_on_windows(self):
        self.assertTrue(stream.alive(os.getpid()))
        for pid in (0, -1, "x", None):
            self.assertFalse(stream.alive(pid), pid)
        with patch.object(stream.os, "kill", side_effect=AssertionError("must not signal")) as kill:
            if os.name == "nt":
                self.assertFalse(stream.alive(os.getpid() + 1))
                kill.assert_not_called()
            self.assertFalse(stream.alive(0))

    @unittest.skipUnless(os.name == "nt", "the refusal is for native Windows")
    def test_native_windows_is_refused_with_a_pointer_to_wsl(self):
        err = io.StringIO()
        with patch.object(sys, "stderr", err), self.assertRaises(SystemExit) as raised:
            stream.main([])
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("WSL", err.getvalue())


class BridgeWireTests(unittest.TestCase):
    """The snapshot as app/main/bridge.js reads it (isSnapshot, normalizeSnapshot, normalizeNode)."""
    CONN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
    STATES = {"idle", "thinking", "working", "searching", "finished", "error", "question", "approval", "ratelimit"}

    def test_snapshot_frame_matches_what_the_deck_accepts(self):
        with tempfile.TemporaryDirectory() as tmp:
            home, now = Path(tmp), time.time()
            (home/"hermes-deck"/"processes").mkdir(parents=True)
            (home/"gateway_state.json").write_text(json.dumps({"pid": 4242, "gateway_state": "running", "active_agents": 2}))
            (home/"hermes-deck"/"processes"/"4242.json").write_text(json.dumps(dict(schema="hermes-deck.v1", pid=4242,
                updated_at=now, nodes={"s-main": dict(session_id="s-main", parent_session_id="", role="main",
                    model="model-a", provider="prov", profile_name="default", source="telegram", platform="telegram",
                    title="", name="Hermes · Telegram", origin="native", state="working", active=True, turn_id="t1",
                    control_available=True, observation_source="native_hook", steps=["Thinking", "terminal"],
                    updated_at=now, terminal_at=None, context_used=1200, context_max=10000, context_percent=12)})))
            snap = serve_once(home, alive=lambda pid: pid == 4242)
        self.assertEqual(snap["schema"], "hermes-deck.v1")
        self.assertTrue(self.CONN_ID.match(snap["connection_id"]))
        self.assertIs(snap["online"], True)
        self.assertEqual(snap["gateway"], {"running": True, "active_agents": 2})
        (node,) = snap["nodes"]
        self.assertEqual((node["session_id"], node["owner_pid"], node["turn_id"], node["control_available"]),
                         ("s-main", 4242, "t1", True))          # what the Deck needs for steer/redirect/interrupt
        self.assertIn(node["state"], self.STATES)
        for key, kind in (("parent_session_id", str), ("profile_name", str), ("steps", list), ("updated_at", float),
                          ("context_used", int), ("context_max", int), ("active", bool)):
            self.assertIsInstance(node[key], kind, key)

    def test_unreachable_plugin_answers_the_way_the_connection_test_recognises(self):
        captured = JsonCapture()
        stream.relay_requests(Path(tempfile.gettempdir()) / "no-hermes-here", iter([
            json.dumps({"jsonrpc": "2.0", "id": "deck-1", "method": "session.list", "params": {"limit": 50}}) + "\n",
            json.dumps({"jsonrpc": "2.0", "id": "deck-2", "method": "session.list", "params": [1]}) + "\n"]),
            lambda obj: captured.write(json.dumps(obj) + "\n"))
        for rid in ("deck-1", "deck-2"):
            error = captured.reply(rid, 2)["error"]
            self.assertEqual(error["code"], -32001)
            # bridge.js probe(): /control (connection|reply) unavailable|endpoint unavailable/ -> "plugin not answering"
            self.assertRegex(error["message"], r"control (connection|reply) unavailable")


# ---------------------------------------------------------------------------- the real thing, end to end

@unittest.skipUnless(hasattr(socket, "AF_UNIX"), "needs Unix sockets (Linux/macOS)")
class AnsweredRequestTests(unittest.TestCase):
    """A request answered from one Deck is withdrawn from the others (Hermes cancels only on timeout/interrupt)."""

    def server(self, emitted, open_ids=("R1",)):
        table = types.SimpleNamespace(_lock=threading.Lock(), _open={
            rid: types.SimpleNamespace(sid="rpc-1", method="clarify") for rid in open_ids})
        return types.SimpleNamespace(_server_requests=table, _emit=lambda *a: emitted.append(a))

    def test_only_a_settled_answer_is_withdrawn(self):
        import observer
        emitted = []
        server = self.server(emitted)
        opened = observer.open_request(server, "R1")
        self.assertEqual(opened, ("rpc-1", "clarify"))
        ok = {"jsonrpc": "2.0", "id": 7, "result": {"status": "ok"}}
        self.assertTrue(observer.withdraw_answered(server, "R1", opened, ok))
        self.assertEqual(emitted, [("request.cancel", "rpc-1", {"id": "R1", "method": "clarify", "reason": "answered"})])
        # expired (settled elsewhere already, Hermes sent its own cancel), an error, or a request never seen open
        for response in ({"id": 8, "result": {"status": "expired"}}, {"id": 9, "error": {"code": 4002}}, None):
            self.assertFalse(observer.withdraw_answered(server, "R1", opened, response))
        self.assertFalse(observer.withdraw_answered(server, "R2", observer.open_request(server, "R2"), ok))
        self.assertEqual(len(emitted), 1)

    def test_an_engine_without_the_table_or_a_failing_sink_changes_nothing(self):
        import observer
        self.assertIsNone(observer.open_request(types.SimpleNamespace(), "R1"))
        self.assertIsNone(observer.open_request(self.server([]), 5))
        def boom(*a):
            raise RuntimeError("sink down")
        server = types.SimpleNamespace(_server_requests=self.server([])._server_requests, _emit=boom)
        self.assertFalse(observer.withdraw_answered(server, "R1", ("rpc-1", "clarify"), {"result": {"status": "ok"}}))


class EndToEndTests(unittest.TestCase):
    """testhost.py: the real observer control socket and the real stream.py in one process, as Hermes runs
    them, spoken to over stdio with the requests app/main/bridge.js sends."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="hd-"))     # short: Unix socket paths are limited
        self.log = self.home.parent / (self.home.name + ".log")
        self.addCleanup(lambda: [shutil.rmtree(self.home, True), self.log.unlink(missing_ok=True)])
        self.proc = subprocess.Popen([sys.executable, str(HERE / "testhost.py"), str(self.home), "--log", str(self.log)],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.stop)
        self.frames, self.seen = queue.Queue(), []  # seen: every frame, also those a call() skipped on its way
        threading.Thread(target=self.read, daemon=True).start()
        self.counter = 0

    def stop(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        self.proc.terminate()
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        for f in (self.proc.stdout, self.proc.stderr):
            f.close()

    def read(self):
        for line in self.proc.stdout:
            try:
                frame = json.loads(line)
                self.seen.append(frame)
                self.frames.put(frame)
            except ValueError:
                pass

    def next(self, pred, timeout=8):
        deadline = time.monotonic() + timeout
        while True:
            try:
                frame = self.frames.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                err = self.proc.stderr.read1(65536).decode(errors="replace") if self.proc.poll() is not None else ""
                raise AssertionError(f"no matching frame within {timeout}s {err}") from None
            if pred(frame):
                return frame

    def call(self, method, params, timeout=8):
        self.counter += 1
        rid = f"deck-test-{self.counter}"
        self.proc.stdin.write((json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}) + "\n").encode())
        self.proc.stdin.flush()
        return self.next(lambda f: f.get("id") == rid and "method" not in f, timeout)

    def test_plan_tools_and_subagents_reach_the_deck(self):
        # the Run / Plan tabs: the observer's activity file becomes deck.tools and deck.plan events, once each
        plan = self.next(lambda f: f.get("method") == "event" and f["params"]["type"] == "deck.plan")["params"]
        self.assertEqual((plan["session_id"], plan["profile_name"]), ("s-main", "default"))
        self.assertEqual(plan["payload"]["plan"]["rev"], 3)
        self.assertEqual([i["state"] for i in plan["payload"]["plan"]["items"]], ["done", "active"])
        tools = self.next(lambda f: f.get("method") == "event" and f["params"]["type"] == "deck.tools")["params"]
        (call,) = tools["payload"]["tools"]
        self.assertEqual((call["call"], call["tool"], call["status"], call["ms"]), ("call-todo-1", "todo_list", "ok", 2))
        self.assertIn("Write the parser", call["args"])
        # the sub-agent detail: Hermes' roster row plus what the plugin adds; strict shapes before Hermes sees it
        rows = self.call("subagent.list", {"session_id": "rpc-s-main"})["result"]["subagents"]
        self.assertEqual((rows[0]["subagent_id"], rows[0]["goal"], rows[0]["status"]), ("sa-0-test", "Find three examples", "running"))
        self.assertGreaterEqual(rows[0]["elapsed_s"], 0)
        tail = self.call("subagent.tail", {"session_id": "rpc-s-main", "subagent_id": "sa-0-test"})["result"]
        self.assertEqual((tail["available"], tail["text"]), (True, "searching\nfound one\n"))
        self.assertEqual(self.call("subagent.steer", {"session_id": "rpc-s-main", "subagent_id": "sa-0-test", "text": "Focus"})["result"]["status"], "queued")
        self.assertEqual(self.call("subagent.interrupt", {"session_id": "rpc-s-main", "subagent_id": "sa-0-test"})["result"]["found"], True)
        self.assertEqual(self.call("subagent.steer", {"session_id": "rpc-s-main", "subagent_id": "sa-0-test", "text": " "})["error"]["code"], -32601)
        self.assertEqual(self.call("subagent.tail", {"session_id": "rpc-s-main"})["error"]["code"], -32601)
        # a stored session's plan (deck.plan) is answered by the plugin, never relayed to the gateway
        self.assertEqual(self.call("deck.plan", {"session_id": "s-idle"})["result"], {"session_id": "s-idle", "plan": None})
        self.assertEqual(self.call("deck.plan", {"session_id": "missing"})["error"]["code"], 4000)

    def test_the_deck_requests_reach_hermes_and_come_back(self):
        snap = self.next(lambda f: f.get("schema") == "hermes-deck.v1" and f.get("nodes"))
        (main,) = [n for n in snap["nodes"] if n["session_id"] == "s-main"]
        self.assertEqual((main["control_available"], main["turn_id"], main["state"]), (True, "t1", "thinking"))
        self.assertEqual((snap["connection_id"], snap["gateway"]["running"]), ("hermes", True))
        owner = main["owner_pid"]
        # reads (bridge.js sessions / history)
        rows = self.call("session.list", {"limit": 50})["result"]["sessions"]
        self.assertEqual([r["id"] for r in rows], ["s-main", "s-idle"])
        approval = self.next(lambda f: f.get("method") == "approval")
        self.assertEqual((approval["id"], approval["params"]["command"]), ("A1", "rm -rf build"))
        history = self.call("session.messages", {"session_id": "s-main", "profile": "default", "limit": 40,
                                                 "offset": 0, "order": "latest", "inline_images": False})["result"]
        self.assertEqual([m["id"] for m in history["messages"]], [11, 12, 13])
        self.assertEqual(self.call("session.messages", {"session_id": "s-main", "limit": 0})["error"]["code"], 4000)
        # a turn: resume, then prompt.submit with its streamed events
        rpc = self.call("session.resume", {"session_id": "s-main", "omit_messages": True, "inline_images": False})["result"]["session_id"]
        self.assertEqual(self.call("prompt.submit", {"session_id": rpc, "text": "Merhaba"})["result"], {"status": "streaming"})
        done = self.next(lambda f: f.get("method") == "event" and f["params"]["type"] == "message.complete")
        self.assertEqual((done["params"]["session_id"], done["params"]["payload"]["text"]), (rpc, "Merhaba"))
        # "Show thinking": only the session this connection resumed, never one another surface owns
        self.assertEqual(self.call("deck.reasoning_view", {"session_id": rpc, "show": True})["result"], {"session_id": rpc, "show": True})
        self.assertEqual(self.call("deck.reasoning_view", {"session_id": "rpc-tui", "show": True})["error"]["code"], 4000)
        self.assertEqual(self.call("deck.reasoning_view", {"session_id": rpc, "show": "yes"})["error"]["code"], 4000)
        # live controls go to the process that owns the turn, with its turn id
        steer = {"session_id": "s-main", "turn_id": "t1", "owner_pid": owner, "text": "kısa tut"}
        self.assertEqual(self.call("native.steer", steer)["result"], {"status": "queued"})
        self.assertEqual(self.call("native.steer", {**steer, "turn_id": "t0"})["result"], {"status": "stale"})
        self.assertEqual(self.call("native.interrupt", {"session_id": "s-main", "turn_id": "t1", "owner_pid": owner})["result"],
                         {"status": "interrupted"})
        self.assertEqual(self.call("request.answer", {"id": "A1", "result": {"choice": "once"}})["result"], {"status": "ok"})
        # answered here: every other attached Deck (the phone after the desktop answered) is told to drop the card
        cancels = [f["params"] for f in self.seen if f.get("method") == "event" and f["params"]["type"] == "request.cancel"]
        self.assertEqual([(c["session_id"], c["payload"]) for c in cancels],
                         [("rpc-s-main", {"id": "A1", "method": "approval", "reason": "answered"})])
        self.assertEqual(self.call("request.answer", {"id": "A1", "result": {"choice": "once"}})["result"], {"status": "expired"})
        self.assertEqual(self.call("config.set", {"session_id": rpc, "key": "model",
                                                  "value": "model-b --provider prov --session"})["result"], {"deferred": True})
        # refused on the host whatever the client sends
        self.assertEqual(self.call("config.set", {"session_id": rpc, "key": "model", "value": "m --global"})["error"]["code"], -32601)
        # reasoning effort: this session only; display words and scope=global never reach Hermes
        self.assertEqual(self.call("config.set", {"session_id": rpc, "key": "reasoning", "value": "high"})["result"], {"deferred": True})
        self.assertEqual(self.call("config.set", {"session_id": rpc, "key": "reasoning", "value": "show"})["error"]["code"], -32601)
        self.assertEqual(self.call("config.set", {"session_id": rpc, "key": "reasoning", "value": "high", "scope": "global"})["error"]["code"], -32601)
        self.assertEqual(self.call("terminal.execute", {"command": "id"})["error"]["code"], -32601)
        seen = [json.loads(l)["method"] for l in self.log.read_text(encoding="utf-8").splitlines()]
        self.assertNotIn("terminal.execute", seen)
        self.assertEqual(seen.count("prompt.submit"), 1)

    def test_the_bot_roster_methods_and_their_host_side_limits(self):
        self.next(lambda f: f.get("schema") == "hermes-deck.v1" and f.get("nodes"))
        assets = self.home / "assets"
        assets.mkdir()
        (assets / "avatar.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 2000)
        rows = self.call("profiles.list", {})["result"]["profiles"]
        self.assertEqual([r["name"] for r in rows], ["default"])
        self.assertEqual(self.call("profiles.list", {"include_sessions": False})["error"]["code"], -32601)
        asset = self.call("profiles.get_asset", {"name": "default", "asset": "avatar"})["result"]
        self.assertTrue(asset["found"] and asset["data"].startswith("data:image/png;base64,"))
        # an avatar that would not fit one 2 MiB reply line is refused before Hermes reads it
        (assets / "avatar.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 1_500_000)
        big = self.call("profiles.get_asset", {"name": "default", "asset": "avatar"})
        self.assertEqual(big["error"]["code"], 4071)
        self.assertEqual(self.call("profiles.get_asset", {"name": "../x", "asset": "avatar"})["error"]["code"], -32601)
        # session.title: only "Bot Chat", only on a session this connection created
        self.assertEqual(self.call("session.title", {"session_id": "rpc-new-1", "title": "Bot Chat"})["error"]["code"], -32601)
        made = self.call("session.create", {"profile": "default", "title": "Bot Chat", "hidden": True,
                                            "follow_profile_config": True, "idempotency_key": "k-12345678"})["result"]
        self.assertEqual(self.call("session.title", {"session_id": made["session_id"], "title": "Renamed"})["error"]["code"], -32601)
        self.assertEqual(self.call("session.title", {"session_id": made["session_id"], "title": "Bot Chat"})["result"],
                         {"pending": False, "title": "Bot Chat"})
        self.assertEqual(self.call("session.title", {"session_id": "s-main", "title": "Bot Chat"})["error"]["code"], -32601)
        # only a Bot Chat create (title "Bot Chat" and hidden) may be titled "Bot Chat" afterwards
        for create in ({"profile": "default"}, {"profile": "default", "title": "Bot Chat"},
                       {"profile": "default", "title": "Bot Chat", "hidden": False}):
            plain = self.call("session.create", create)["result"]
            self.assertEqual(self.call("session.title", {"session_id": plain["session_id"], "title": "Bot Chat"})["error"]["code"],
                             -32601, create)
        for method in ("profiles.configure", "profiles.set_asset", "cron.manage"):
            self.assertEqual(self.call(method, {"name": "default"})["error"]["code"], -32601, method)
        seen = [json.loads(l)["method"] for l in self.log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(seen.count("profiles.get_asset"), 1)   # the refused ones never reached Hermes
        self.assertEqual(seen.count("session.title"), 1)
        self.assertNotIn("profiles.configure", seen)

    def send(self, method, params):
        self.counter += 1
        rid = f"deck-test-{self.counter}"
        self.proc.stdin.write((json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}) + "\n").encode())
        self.proc.stdin.flush()
        return rid

    def test_one_avatar_in_flight_per_connection_and_no_oversized_reply_line(self):
        """Hermes answers profiles.get_asset from its pool into a 4 MiB per-client backlog: several ~1.3 MB
        replies at once overflow it and Hermes closes the connection. The host allows one at a time."""
        self.next(lambda f: f.get("schema") == "hermes-deck.v1" and f.get("nodes"))
        assets = self.home / "assets"
        assets.mkdir()
        (assets / "avatar.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 2000)
        ask = {"name": "default", "asset": "avatar"}
        first, second = self.send("profiles.get_asset", ask), self.send("profiles.get_asset", ask)
        replies = {}
        while len(replies) < 2:
            frame = self.next(lambda f: f.get("id") in (first, second) and "method" not in f)
            replies[frame["id"]] = frame
        self.assertTrue(replies[first]["result"]["found"])
        self.assertEqual(replies[second]["error"]["code"], 4072)
        # the slot is free again once the reply is written
        self.assertTrue(self.call("profiles.get_asset", ask)["result"]["found"])
        # a bigger file landing between the plugin's size check and Hermes' read (profiles.set_asset accepts
        # 2 MB) is refused in the reply: the connection never sees a line over 2 MiB
        (assets / "swap-in.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 1_700_000)
        late = self.call("profiles.get_asset", ask)
        self.assertEqual(late["error"]["code"], 4071)
        self.assertIn("reply of", late["error"]["message"])
        rows = self.call("session.list", {"limit": 50})["result"]["sessions"]   # the same connection still works
        self.assertEqual([r["id"] for r in rows], ["s-main", "s-idle"])
        seen = [json.loads(l)["method"] for l in self.log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(seen.count("profiles.get_asset"), 3)   # the refused second one never reached Hermes


if __name__ == "__main__":
    unittest_main()


class VersionRequestTests(unittest.TestCase):
    """deck.version: answered by the stream itself (no Hermes, no network); apps before 0.3.6 never ask."""
    def test_deck_version_answers_from_the_stream_without_a_running_hermes(self):
        out = []
        stream.relay_requests(Path("/nonexistent-hermes-home"), iter([
            json.dumps({"jsonrpc": "2.0", "id": "v-1", "method": "deck.version", "params": {}}) + "\n",
            json.dumps({"jsonrpc": "2.0", "method": "deck.version"}) + "\n",      # a notification: no answer
        ]), out.append)
        self.assertEqual(out, [{"jsonrpc": "2.0", "id": "v-1", "result": {"version": stream.VERSION, "protocol": stream.PROTOCOL}}])

    def test_the_version_matches_plugin_yaml(self):
        text = (HERE / "plugin.yaml").read_text(encoding="utf-8")
        self.assertRegex(text, r'(?m)^version: "%s"$' % re.escape(stream.VERSION))
        self.assertIsInstance(stream.PROTOCOL, int)


class AttachLineOverTwoMiB(unittest.TestCase):
    """A Deck send with ~3 MB of pasted screenshots: stdin is text, so the >2 MiB check must not raise TypeError."""
    def test_str_line_over_2mib_reaches_the_control_path(self):
        out = []
        line = json.dumps({"jsonrpc": "2.0", "id": "d-7", "method": "deck.attach_submit",
                           "params": {"session_id": "x", "text": "t",
                                      "files": [{"filename": "a.png", "content_base64": "A" * (3 * 1024 * 1024)}]}}) + "\n"
        stream.relay_requests(Path("/nonexistent-hermes-home"), io.StringIO(line), out.append)
        deadline = time.time() + 3
        while not out and time.time() < deadline:
            time.sleep(0.02)
        self.assertTrue(out)
        self.assertEqual(out[0]["id"], "d-7")  # answered under its own id, not refused as an unparsable line
