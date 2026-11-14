"""Profile-scoped snapshot regression. Run: python test_stream_profile.py"""
import importlib.util
import io
import json
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from testsupport import unittest_main

spec = importlib.util.spec_from_file_location("hermes_deck_stream_profile_test", Path(__file__).with_name("stream.py"))
stream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stream)


class ProfileSnapshotTests(unittest.TestCase):
    def test_cloned_session_ids_keep_profile_metadata_and_cached_live_titles_separate(self):
        with tempfile.TemporaryDirectory() as tmp:
            home, now, sid = Path(tmp), time.time(), "cloned-session"
            for profile, pid in (("default", 11), ("alpha", 22), ("beta", 33)):
                base = home if profile == "default" else home / "profiles" / profile
                (base / "runtime").mkdir(parents=True)
                (base / "runtime" / "active_sessions.json").write_text(json.dumps({"entries": [
                    {"session_id": sid, "pid": pid, "surface": "cli"}]}))
                with sqlite3.connect(base / "state.db") as db:
                    db.execute("CREATE TABLE sessions (id TEXT, source TEXT, billing_provider TEXT, parent_session_id TEXT, model_config TEXT, profile_name TEXT, title TEXT)")
                    # Cloned databases can retain either the default or another named profile marker.
                    db.execute("INSERT INTO sessions VALUES (?,?,?,?,?,?,?)", (
                        sid, "subagent", "history-" + profile, "root", "{}",
                        {"default": "", "alpha": "default", "beta": "alpha"}[profile], "Title " + profile))
                    db.execute("CREATE TABLE session_turn_leases (conversation_id TEXT, holder TEXT, expires_at REAL)")
                    db.execute("INSERT INTO session_turn_leases VALUES (?,?,?)", (
                        "compressed-root", f"pid={pid}:turn={sid}:task:12345678:platform=cli", now + 120))
                    if profile == "default":
                        db.execute("CREATE TABLE gateway_routing (entry_json TEXT, updated_at REAL)")
                        db.execute("INSERT INTO gateway_routing VALUES (?,?)", (
                            json.dumps({"session_id": sid, "platform": "cli", "last_prompt_tokens": 312}), now))
                processes = base / "hermes-deck" / "processes"
                processes.mkdir(parents=True)
                (processes / f"{pid}.json").write_text(json.dumps({
                    "schema": stream.SCHEMA, "pid": pid, "updated_at": now,
                    "nodes": {sid: {"session_id": sid, "parent_session_id": "root", "updated_at": now,
                        "terminal_at": None, "profile_name": "", "title": "Fallback", "name": "Leaf",
                        "provider": "live-beta" if profile == "beta" else ""}}}))

            registered = stream.collect_registered_nodes(home, now=now, alive=lambda _: True)
            by_profile = {node["profile_name"]: node for node in registered}
            self.assertEqual(set(by_profile), {"default", "alpha", "beta"})
            for profile, pid in (("default", 11), ("alpha", 22), ("beta", 33)):
                self.assertEqual(by_profile[profile]["session_id"], sid)
                self.assertEqual(by_profile[profile]["provider"], "history-" + profile)
                self.assertEqual(by_profile[profile]["owner_pid"], pid)
                self.assertEqual(by_profile[profile]["state"], "working")

            # Multiple process manifests can carry the same SID in separate logical profiles.
            mixed = home / "mixed-processes"
            mixed.mkdir()
            for profile, pid in (("alpha", 44), ("beta", 55)):
                (mixed / f"{pid}.json").write_text(json.dumps({
                    "schema": stream.SCHEMA, "pid": pid, "updated_at": now,
                    "nodes": {sid: {"session_id": sid, "profile_name": profile, "updated_at": now}}}))
            self.assertEqual({n["profile_name"] for n in stream.collect_nodes(mixed, now=now, alive=lambda _: True)},
                             {"alpha", "beta"})

            collect = stream.collect_observer_nodes
            clock, iteration = [1005.0], [0]

            def observed(*args, **kwargs):
                nodes = collect(*args, **kwargs)
                iteration[0] += 1
                for node in nodes:
                    node["updated_at"] += iteration[0] / 10
                    if node["profile_name"] == "default":
                        node["profile_name"] = ""  # Legacy empty profile overlays the default record.
                return nodes

            class Finished(Exception):
                pass

            def next_snapshot(_):
                if iteration[0] == 2:
                    raise Finished
                clock[0] += .2

            out = io.StringIO()
            with patch.object(stream, "alive", return_value=True), \
                    patch.object(stream, "collect_observer_nodes", side_effect=observed), \
                    patch.object(stream.time, "monotonic", side_effect=lambda: clock[0]), \
                    patch.object(stream.time, "sleep", side_effect=next_snapshot):
                with self.assertRaises(Finished):
                    stream.serve(home, follow=True, stdin=[], stdout=out)
            frames = [json.loads(line) for line in out.getvalue().splitlines()]
            self.assertEqual(len(frames), 2)
            for frame in frames:
                self.assertEqual(frame["schema"], "hermes-deck.v1")
                self.assertEqual(len(frame["nodes"]), 3)
                by_profile = {node["profile_name"]: node for node in frame["nodes"]}
                self.assertEqual(set(by_profile), {"default", "alpha", "beta"})
                for profile in by_profile:
                    self.assertEqual(by_profile[profile]["session_id"], sid)
                    self.assertEqual(by_profile[profile]["title"], "Title " + profile)
                self.assertEqual(by_profile["alpha"]["provider"], "history-alpha")
                self.assertEqual(by_profile["beta"]["provider"], "live-beta")
                self.assertEqual(by_profile["default"]["provider"], "history-default")
                self.assertEqual(by_profile["default"]["last_prompt_tokens"], 312)
                self.assertNotIn("last_prompt_tokens", by_profile["alpha"])
                self.assertNotIn("last_prompt_tokens", by_profile["beta"])

    def test_gateway_transport_keeps_cloned_runtime_owners_separate(self):
        with tempfile.TemporaryDirectory() as tmp:
            home, now, sid = Path(tmp), time.time(), "cloned-session"
            expected = {"default": (11, 101), "alpha": (22, 202), "beta": (33, 303)}
            for profile, (pid, tokens) in expected.items():
                base = home if profile == "default" else home / "profiles" / profile
                (base / "runtime").mkdir(parents=True)
                (base / "runtime/active_sessions.json").write_text(json.dumps({"entries": [
                    {"session_id": sid, "pid": pid, "surface": "cli"}]}))
                with sqlite3.connect(base / "state.db") as db:
                    db.execute("CREATE TABLE sessions (id TEXT, source TEXT, billing_provider TEXT, profile_name TEXT, title TEXT)")
                    db.execute("INSERT INTO sessions VALUES (?,?,?,?,?)", (
                        sid, "cli", "history-" + profile,
                        {"default": "default", "alpha": "default", "beta": "alpha"}[profile], "Title " + profile))
                    db.execute("CREATE TABLE session_turn_leases (conversation_id TEXT, holder TEXT, expires_at REAL)")
                    db.execute("INSERT INTO session_turn_leases VALUES (?,?,?)", (
                        "compressed-root", f"pid={pid}:turn={sid}:task:12345678:platform=cli", now + 120))
                processes = base / "hermes-deck/processes"
                processes.mkdir(parents=True)
                (processes / f"{pid}.json").write_text(json.dumps({
                    "schema": stream.SCHEMA, "pid": pid, "updated_at": now,
                    "nodes": {sid: {"session_id": sid, "profile_name": "", "updated_at": now,
                        "terminal_at": None, "provider": "live-beta" if profile == "beta" else ""}}}))

            with sqlite3.connect(home / "state.db") as db:
                db.execute("CREATE TABLE gateway_routing (entry_json TEXT, updated_at REAL)")
                for profile, (_, tokens) in expected.items():
                    db.execute("INSERT INTO gateway_routing VALUES (?,?)", (json.dumps({
                        "session_id": sid, "platform": "telegram", "origin": {"profile": profile},
                        "transport_profile": "default" if profile == "alpha" else "alpha",
                        "last_prompt_tokens": tokens}), now + tokens / 1000))

            registered = stream.collect_registered_nodes(home, now=now, alive=lambda _: True)
            self.assertEqual(len(registered), 3)
            by_profile = {node["profile_name"]: node for node in registered}
            self.assertEqual(set(by_profile), {"default", "alpha", "beta"})
            for profile, (pid, tokens) in expected.items():
                self.assertEqual(by_profile[profile]["session_id"], sid)
                self.assertEqual(by_profile[profile]["owner_pid"], pid)
                self.assertEqual(by_profile[profile]["provider"], "history-" + profile)
                self.assertEqual(by_profile[profile]["title"], "Title " + profile)
                self.assertEqual(by_profile[profile].get("last_prompt_tokens"), tokens)
                self.assertEqual(by_profile[profile]["state"], "working")
                self.assertFalse(by_profile[profile]["control_available"])

            # A cloned root DB marker cannot relabel its physical default owner as alpha.
            with sqlite3.connect(home / "state.db") as db:
                db.execute("UPDATE sessions SET profile_name='alpha'")
            out = io.StringIO()
            with patch.object(stream, "alive", return_value=True):
                stream.serve(home, stdout=out)
            nodes = json.loads(out.getvalue())["nodes"]
            self.assertEqual(len(nodes), 3)
            by_profile = {node["profile_name"]: node for node in nodes}
            self.assertEqual(set(by_profile), {"default", "alpha", "beta"})
            for profile, (pid, tokens) in expected.items():
                self.assertEqual(by_profile[profile]["owner_pid"], pid)
                self.assertEqual(by_profile[profile]["provider"], "live-beta" if profile == "beta" else "history-" + profile)
                self.assertEqual(by_profile[profile]["title"], "Title " + profile)
                self.assertEqual(by_profile[profile]["last_prompt_tokens"], tokens)


class ControlEndpointTests(unittest.TestCase):
    """The control connection goes only to the gateway's own process, never to some other live Hermes process."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)

    def record(self, profile, pid, updated):
        base = (self.home if profile == "default" else self.home / "profiles" / profile) / "hermes-deck"
        (base / "processes").mkdir(parents=True, exist_ok=True)
        sock = base / f"control-{pid}-x.sock"
        sock.touch()
        (base / "processes" / f"{pid}.json").write_text(json.dumps(dict(
            schema=stream.SCHEMA, pid=pid, updated_at=updated, control_socket=str(sock), nodes={})))
        return sock.resolve()

    def test_a_stale_gateway_record_never_falls_back_to_another_process(self):
        now = time.time()
        self.record("default", 11, now - 100)              # the gateway's record, stale (restart window)
        self.record("ada", 22, now)                         # a live CLI process started for another profile
        (self.home / "gateway_state.json").write_text(json.dumps({"pid": 11}))
        with patch.object(stream, "alive", return_value=True):
            self.assertIsNone(stream.endpoint(self.home))
            self.assertEqual(stream.control_record(self.home), (None, None))
            self.assertEqual(stream.endpoint(self.home, 22), (self.home / "profiles/ada/hermes-deck/control-22-x.sock").resolve())
        with patch.object(stream, "alive", side_effect=lambda pid: pid != 11):   # the gateway is gone
            self.assertIsNone(stream.endpoint(self.home))

    def test_the_gateway_pid_prefers_its_default_base_over_profile_bases(self):
        now = time.time()
        named = self.record("atlas", 11, now)
        own = self.record("default", 11, now - 5)           # one multiplexed process, one socket per profile
        self.record("ada", 22, now)
        (self.home / "gateway_state.json").write_text(json.dumps({"pid": 11}))
        with patch.object(stream, "alive", return_value=True):
            self.assertEqual(stream.endpoint(self.home), own)
            (self.home / "hermes-deck/processes/11.json").unlink()
            self.assertEqual(stream.endpoint(self.home), named)

    def test_without_a_gateway_the_default_base_wins_deterministically(self):
        now = time.time()
        self.record("ada", 22, now)
        own = self.record("default", 33, now - 10)
        with patch.object(stream, "alive", return_value=True):
            self.assertEqual(stream.endpoint(self.home), own)
            (self.home / "gateway_state.json").write_text("not json")
            self.assertEqual(stream.endpoint(self.home), own)


if __name__ == "__main__":
    unittest_main()
