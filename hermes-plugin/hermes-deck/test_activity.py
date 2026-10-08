"""hermes-deck, bridge part: what the Deck's Run tab, Plan tab and sub-agent detail read over the direct connection.

Run with any Python 3.10+ (no Hermes, no network):  python test_activity.py

- Observer: per live session, the last tool calls (call id, tool, args preview, duration, status, error, result
  preview) and the latest plan, kept in memory and written to <pid>.activity only when they change.
- stream.py: collect_activity / activity_events turn those files into deck.tools / deck.plan events, once per change.
- subagent.list / subagent.tail replies completed with what a detail view needs; strict subagent.* shapes.
- deck.plan: a stored session's plan rebuilt from its newest todo tool result (read-only).
"""
import importlib.util
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from testsupport import unittest_main

HERE = Path(__file__).resolve().parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


observer = load("hermes_deck_observer_activity_under_test", "observer.py")
stream = load("hermes_deck_stream_activity_under_test", "stream.py")
SECRET = "sk-" + "b" * 32


def todo_result(items, revision=2):
    return json.dumps({"todos": items, "revision": revision, "summary": {"total": len(items)}})


class ActivityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = [1000.0]
        self.o = observer.Observer(Path(self.tmp.name), clock=lambda: self.now[0])
        self.o.pre_llm_call(session_id="main", turn_id="t1", model="model-a", platform="cli")

    def file(self):
        path = Path(self.tmp.name) / f"{self.o.pid}.activity"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None

    def test_a_tool_call_is_recorded_with_previews_duration_and_status(self):
        self.o.pre_tool_call(tool_name="terminal", session_id="main", turn_id="t1", tool_call_id="c1",
                             args={"command": f"deploy --token={SECRET}"})
        running = self.file()["sessions"]["main"]["tools"][-1]
        self.assertEqual((running["call"], running["tool"], running["status"]), ("c1", "terminal", "running"))
        self.now[0] = 1002.5
        self.o.post_tool_call(tool_name="terminal", session_id="main", turn_id="t1", tool_call_id="c1",
                              result="x" * 5000, duration_ms=2500, status="ok")
        tool = self.file()["sessions"]["main"]["tools"][-1]
        self.assertEqual((tool["status"], tool["ms"], tool["err"]), ("ok", 2500, None))
        self.assertLessEqual(len(tool["result"]), 301)
        self.assertNotIn(SECRET, json.dumps(tool))
        self.assertIn("‹redacted›", tool["args"])

    def test_errors_keep_their_message_and_the_ring_is_bounded(self):
        self.o.pre_tool_call(tool_name="read_file", session_id="main", turn_id="t1", tool_call_id="bad")
        self.o.post_tool_call(tool_name="read_file", session_id="main", turn_id="t1", tool_call_id="bad", status="error",
                              error_type="tool_error", error_message="No such file", duration_ms=4)
        bad = self.file()["sessions"]["main"]["tools"][-1]
        self.assertEqual((bad["status"], bad["err"]), ("error", "tool_error: No such file"))
        for i in range(observer.ACTIVITY_TOOLS + 10):
            self.o.pre_tool_call(tool_name="noop", session_id="main", turn_id="t1", tool_call_id=f"n{i}")
            self.o.post_tool_call(tool_name="noop", session_id="main", turn_id="t1", tool_call_id=f"n{i}", status="ok")
        tools = self.file()["sessions"]["main"]["tools"]
        self.assertEqual(len(tools), observer.ACTIVITY_TOOLS)
        self.assertEqual(tools[-1]["call"], f"n{observer.ACTIVITY_TOOLS + 9}")

    def test_a_todo_result_becomes_the_sessions_plan(self):
        result = todo_result([{"id": "1", "content": "Write tests", "status": "in_progress"}], revision=5)
        self.o.pre_tool_call(tool_name="todo_list", session_id="main", turn_id="t1", tool_call_id="p1")
        self.o.post_tool_call(tool_name="todo_list", session_id="main", turn_id="t1", tool_call_id="p1",
                              result=result, status="ok")
        plan = self.file()["sessions"]["main"]["plan"]
        self.assertEqual((plan["source"], plan["rev"]), ("todo", 5))
        self.assertEqual(plan["items"], [{"id": "1", "text": "Write tests", "state": "active", "depth": 0}])

    def test_unchanged_activity_is_not_rewritten(self):
        self.o.pre_tool_call(tool_name="terminal", session_id="main", turn_id="t1", tool_call_id="c1")
        path = Path(self.tmp.name) / f"{self.o.pid}.activity"
        first = path.stat().st_mtime_ns
        os.utime(path, ns=(first - 10**9, first - 10**9))
        with self.o.lock:
            self.o._persist()                      # a heartbeat with nothing new
        self.assertEqual(path.stat().st_mtime_ns, first - 10**9)

    def test_a_pruned_session_leaves_the_activity_file(self):
        self.o.pre_tool_call(tool_name="terminal", session_id="main", turn_id="t1", tool_call_id="c1")
        self.o.on_session_end(session_id="main", turn_id="t1", completed=True)
        self.now[0] += 500                         # past the 120 s node retention
        with self.o.lock:
            self.o._persist()
        self.assertEqual(self.file()["sessions"], {})

    def test_a_failing_preview_never_breaks_the_hook(self):
        with patch.object(observer, "_preview", side_effect=RuntimeError("boom")), \
                self.assertLogs(observer.logger, "WARNING") as logged:
            self.assertIsNone(self.o.pre_tool_call(tool_name="terminal", session_id="main", turn_id="t1", tool_call_id="c"))
            self.o.post_tool_call(tool_name="terminal", session_id="main", turn_id="t1", tool_call_id="c", status="ok")
        self.assertEqual(len(logged.records), 2)
        self.assertEqual(self.o.nodes["main"]["state"], "working")


class StreamActivityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.processes = self.home / "hermes-deck" / "processes"
        self.processes.mkdir(parents=True)

    def write(self, pid, sessions, name=None):
        (self.processes / (name or f"{pid}.activity")).write_text(json.dumps(
            {"schema": "hermes-deck.v1", "pid": pid, "updated_at": 1, "sessions": sessions}), encoding="utf-8")

    def test_events_for_each_change_only(self):
        plan = {"source": "todo", "rev": 1, "items": [{"id": "1", "text": "A", "state": "pending", "depth": 0}]}
        tools = [{"call": "c1", "tool": "terminal", "status": "ok", "ms": 3}]
        self.write(4242, {"s1": {"profile_name": "default", "plan": plan, "tools": tools}})
        cache, sent = {}, {}
        alive = lambda pid: str(pid) == "4242"
        frames = stream.activity_events(stream.collect_activity(self.home, alive=alive, cache=cache), sent)
        self.assertEqual(sorted(f["params"]["type"] for f in frames), ["deck.plan", "deck.tools"])
        plan_frame = next(f for f in frames if f["params"]["type"] == "deck.plan")
        self.assertEqual(plan_frame["params"], {"type": "deck.plan", "session_id": "s1", "profile_name": "default",
                                                "payload": {"plan": plan}})
        self.assertEqual(stream.activity_events(stream.collect_activity(self.home, alive=alive, cache=cache), sent), [])
        tools.append({"call": "c2", "tool": "read_file", "status": "running"})
        self.write(4242, {"s1": {"profile_name": "default", "plan": plan, "tools": tools}})
        frames = stream.activity_events(stream.collect_activity(self.home, alive=alive, cache={}), sent)
        self.assertEqual([f["params"]["type"] for f in frames], ["deck.tools"])

    def test_dead_pids_foreign_names_and_junk_are_ignored(self):
        self.write(1, {"s1": {"plan": {"source": "todo", "rev": 1, "items": []}, "tools": []}})
        self.write(7, {"s2": {"tools": []}}, name="8.activity")                 # pid does not match its file
        (self.processes / "9.activity").write_text("{not json", encoding="utf-8")
        alive = lambda pid: str(pid) in {"7", "8", "9"}
        self.assertEqual(stream.collect_activity(self.home, alive=alive), {})

    def test_a_profile_observer_names_its_own_profile(self):
        profile = self.home / "profiles" / "research" / "hermes-deck" / "processes"
        profile.mkdir(parents=True)
        (profile / "77.activity").write_text(json.dumps({"schema": "hermes-deck.v1", "pid": 77, "sessions": {
            "s9": {"profile_name": "default", "tools": [{"call": "c", "tool": "t"}], "plan": None}}}), encoding="utf-8")
        got = stream.collect_activity(self.home, alive=lambda pid: str(pid) == "77")
        self.assertIn(("research", "s9"), got)


class Agent:
    session_id = "child-sid"
    model = "model-b"
    provider = "provider-x"
    reasoning_config = {"enabled": True, "effort": "high"}
    session_input_tokens, session_output_tokens, session_cache_read_tokens = 1200, 340, 800
    session_api_calls = 3
    session_estimated_cost_usd = 0.0123
    session_cost_status = "estimated"


class SubagentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.o = observer.Observer(Path(self.tmp.name), clock=lambda: 1000.0)
        self.o.pre_llm_call(session_id="child-sid", turn_id="c1", model="model-b")
        self.o.pre_tool_call(tool_name="web_search", session_id="child-sid", turn_id="c1", tool_call_id="w1",
                             args={"query": "example"})
        self.o.post_tool_call(tool_name="web_search", session_id="child-sid", turn_id="c1", tool_call_id="w1",
                              result="3 results", duration_ms=800, status="ok")
        registry = types.ModuleType("tools.delegate_tool_registry")
        registry._active_subagents_lock = threading.Lock()
        registry._active_subagents = {"sa-0-abc": {"subagent_id": "sa-0-abc", "agent": Agent(), "started_at": 940.0,
                                                   "goal": "Find three examples"}}
        tools = types.ModuleType("tools")
        tools.delegate_tool_registry = registry
        modules = patch.dict(sys.modules, {"tools": tools, "tools.delegate_tool_registry": registry})
        modules.start()
        self.addCleanup(modules.stop)

    def test_list_rows_get_the_detail_fields(self):
        reply = {"jsonrpc": "2.0", "id": "r1", "result": {"subagents": [
            {"subagent_id": "sa-0-abc", "goal": f"Find three examples with api_key={SECRET}", "model": "model-b",
             "started_at": 940.0, "status": "running", "tool_count": 1, "last_tool": "web_search", "accepting_steer": True}],
            "delegations": [{"delegation_id": "d1", "status": "failed", "goal": "x" * 9000, "error": "boom"}]}}
        out = observer.enrich_subagent_reply("subagent.list", reply, self.o, now=1000.0)
        row = out["result"]["subagents"][0]
        self.assertEqual(row["status"], "running")                     # Hermes' own fields stay
        self.assertEqual((row["child_session_id"], row["reasoning_effort"], row["elapsed_s"]), ("child-sid", "high", 60.0))
        self.assertEqual(row["tokens"], {"input": 1200, "output": 340, "cache_read": 800, "api_calls": 3})
        self.assertEqual((row["cost_usd"], row["cost_status"], row["state"]), (0.0123, "estimated", "working"))
        self.assertEqual(row["tools"][0]["tool"], "web_search")
        self.assertEqual((row["tools"][0]["ms"], row["tools"][0]["status"]), (800, "ok"))
        self.assertNotIn(SECRET, json.dumps(out))
        self.assertLessEqual(len(out["result"]["delegations"][0]["goal"]), observer.SUBAGENT_GOAL_MAX + 1)

    def test_tail_is_redacted_and_completed_only_when_available(self):
        reply = {"jsonrpc": "2.0", "id": "r2", "result": {"subagent_id": "sa-0-abc", "available": True,
                                                         "text": f"line\nBearer {SECRET}\n", "truncated": False}}
        out = observer.enrich_subagent_reply("subagent.tail", reply, self.o, now=1000.0)["result"]
        self.assertNotIn(SECRET, out["text"])
        self.assertEqual((out["available"], out["child_session_id"], out["model"]), (True, "child-sid", "model-b"))
        missing = {"jsonrpc": "2.0", "id": "r3", "result": {"subagent_id": "sa-0-abc", "available": False, "text": "",
                                                           "truncated": False}}
        self.assertEqual(observer.enrich_subagent_reply("subagent.tail", missing, self.o)["result"], missing["result"])

    def test_errors_and_unknown_children_pass_through(self):
        err = {"jsonrpc": "2.0", "id": "r4", "error": {"code": 4001, "message": "session not found"}}
        self.assertIs(observer.enrich_subagent_reply("subagent.list", err, self.o), err)
        self.assertIsNone(observer.enrich_subagent_reply("subagent.list", None, self.o))
        row = observer.enrich_subagent_reply("subagent.list", {"result": {"subagents": [{"subagent_id": "sa-gone"}]}},
                                             self.o)["result"]["subagents"][0]
        self.assertEqual(row, {"subagent_id": "sa-gone"})

    def test_subagent_request_shapes(self):
        ok = observer.allowed_request
        self.assertTrue(ok("subagent.list", {"session_id": "rpc-1"}))
        self.assertTrue(ok("subagent.tail", {"session_id": "rpc-1", "subagent_id": "sa-0-abc"}))
        self.assertTrue(ok("subagent.interrupt", {"session_id": "rpc-1", "subagent_id": "sa-0-abc", "profile": "research"}))
        self.assertTrue(ok("subagent.steer", {"session_id": "rpc-1", "subagent_id": "sa-0-abc", "text": "Focus on A"}))
        for method, params in (("subagent.list", {}), ("subagent.list", {"session_id": "rpc-1", "extra": 1}),
                               ("subagent.tail", {"session_id": "rpc-1"}),
                               ("subagent.tail", {"session_id": "rpc-1", "subagent_id": "bad id"}),
                               ("subagent.steer", {"session_id": "rpc-1", "subagent_id": "sa", "text": "  "}),
                               ("subagent.steer", {"session_id": "rpc-1", "subagent_id": "sa", "text": "x" * 32001}),
                               ("subagent.interrupt", {"session_id": "rpc-1", "subagent_id": "sa", "profile": "../x"})):
            with self.subTest(method=method, params=str(params)[:60]):
                self.assertFalse(ok(method, params))


class FakeDb:
    def __init__(self, sessions, messages):
        self.sessions, self.messages, self.sql = sessions, messages, []

    def get_session(self, sid):
        return self.sessions.get(sid)

    def _read_all(self, sql, params=()):
        self.sql.append(sql)
        assert sql.lstrip().upper().startswith("SELECT")
        rows = [m for m in self.messages if m["session_id"] == params[0] and m["role"] == "tool"
                and m["tool_name"] in ("todo_list", "todo", "omh_todo")]
        return [(m["tool_name"], m["content"]) for m in reversed(rows)][:5]


def with_db(db, seen=None):
    def run(profile, fn, read_only):
        if seen is not None:
            seen.append((profile, read_only))
        return fn(db)
    return run


class StoredPlanTests(unittest.TestCase):
    def test_newest_todo_result_wins_and_the_read_is_read_only(self):
        db = FakeDb({"s1": {"id": "s1"}}, [
            {"session_id": "s1", "role": "tool", "tool_name": "todo_list",
             "content": todo_result([{"id": "1", "content": "Old", "status": "pending"}], 1)},
            {"session_id": "s1", "role": "tool", "tool_name": "todo_list",
             "content": todo_result([{"id": "1", "content": "New", "status": "completed"}], 2)}])
        seen = []
        out = observer.stored_plan({"session_id": "s1", "profile": "research"}, with_db(db, seen))
        self.assertEqual(out["plan"]["items"][0], {"id": "1", "text": "New", "state": "done", "depth": 0})
        self.assertEqual(seen, [("research", True)])

    def test_a_continuation_looks_back_and_a_session_without_a_plan_is_none(self):
        db = FakeDb({"tip": {"id": "tip", "parent_session_id": "root"}, "root": {"id": "root"}}, [
            {"session_id": "root", "role": "tool", "tool_name": "omh_todo",
             "content": json.dumps({"todo": {"items": [{"text": "Phase one", "state": "active"}]}})}])
        self.assertEqual(observer.stored_plan({"session_id": "tip"}, with_db(db))["plan"]["source"], "omh")
        empty = FakeDb({"s2": {"id": "s2"}}, [])
        self.assertEqual(observer.stored_plan({"session_id": "s2"}, with_db(empty)), {"session_id": "s2", "plan": None})

    def test_bad_params_and_unknown_sessions_are_refused(self):
        db = FakeDb({}, [])
        for params in ({}, {"session_id": "s 1"}, {"session_id": "s1", "limit": 3}, {"session_id": "s1", "profile": "../x"}):
            with self.subTest(params=params):
                with self.assertRaises(ValueError):
                    observer.stored_plan(params, with_db(db))
        with self.assertRaises(ValueError):
            observer.stored_plan({"session_id": "missing"}, with_db(db))
        reply = observer.session_reply({"id": 9, "params": {"session_id": "missing"}}, observer.stored_plan, with_db(db))
        self.assertEqual(reply["error"]["code"], 4000)


if __name__ == "__main__":
    unittest_main()
