"""hermes-deck, events part: the `plan` event (the Deck's Plan tab) from todo_list / todo / omh_todo results.

Run with any Python 3.10+ (no Hermes, no network):  python test_plan.py

parse_plan must accept Hermes' native todo_list result and the OMH plugin's omh_todo result, bound and redact what it
keeps, and never raise on anything else. on_post_tool_call must write exactly one `plan` line for a todo result, next
to the unchanged `tool_end`, and nothing for other tools, failed calls or malformed results.
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from testsupport import unittest_main

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("hermes_deck_events_plan_under_test", HERE / "events.py")
events = importlib.util.module_from_spec(spec)
spec.loader.exec_module(events)

SECRET = "sk-" + "a" * 32  # an OpenAI-style key shape the redaction must catch


def todo_result(todos, revision=1):
    """Hermes' todo_list result exactly as tools/todo_tool.py writes it (summary included)."""
    summary = {"total": len(todos)}
    for status in ("pending", "in_progress", "completed", "cancelled"):
        summary[status] = sum(1 for t in todos if t.get("status") == status)
    return json.dumps({"todos": todos, "revision": revision, "summary": summary}, ensure_ascii=False)


def omh_result(items, updated_at="2026-01-02T03:04:05Z"):
    """omh_todo's reply: status plus the public `todo` projection (runtime_reader._todo_summary)."""
    return json.dumps({"status": "written", "todo": {
        "status": "established", "title": "Example plan", "source": "omh_todo", "updated_at": updated_at,
        "counts": {"total": len(items)}, "items": items, "display_items": [], "more_count": 0}}, sort_keys=True)


class ParseTodoList(unittest.TestCase):
    def test_native_result_maps_states_ids_and_nesting(self):
        plan = events.parse_plan("todo_list", todo_result([
            {"id": "1", "content": "Read the brief", "status": "completed"},
            {"id": "2", "content": "Write the parser", "status": "in_progress"},
            {"id": "2a", "content": "Cover malformed input", "status": "pending", "parent": "2"},
            {"id": "2a1", "content": "Oversized lists", "status": "pending", "parent": "2a"},
            {"id": "3", "content": "Dropped idea", "status": "cancelled"},
        ], revision=7))
        self.assertEqual(plan, {"source": "todo", "rev": 7, "items": [
            {"id": "1", "text": "Read the brief", "state": "done", "depth": 0},
            {"id": "2", "text": "Write the parser", "state": "active", "depth": 0},
            {"id": "2a", "text": "Cover malformed input", "state": "pending", "depth": 1},
            {"id": "2a1", "text": "Oversized lists", "state": "pending", "depth": 2},
            {"id": "3", "text": "Dropped idea", "state": "cancelled", "depth": 0},
        ]})

    def test_legacy_alias_and_a_dict_result(self):
        result = {"todos": [{"id": "x", "content": "One", "status": "pending"}], "revision": 2}
        self.assertEqual(events.parse_plan("todo", result)["items"], [{"id": "x", "text": "One", "state": "pending", "depth": 0}])

    def test_an_explicit_clear_is_an_empty_plan_but_an_unused_store_is_none(self):
        self.assertEqual(events.parse_plan("todo_list", todo_result([], revision=3)), {"source": "todo", "rev": 3, "items": []})
        self.assertIsNone(events.parse_plan("todo_list", todo_result([], revision=0)))

    def test_an_error_result_is_not_a_plan(self):
        self.assertIsNone(events.parse_plan("todo_list", json.dumps({"error": "todos must be a list, got str"})))
        self.assertIsNone(events.parse_plan("todo_list", json.dumps({"error": "x", "todos": []})))

    def test_oversized_list_and_text_are_bounded_and_redacted(self):
        todos = [{"id": str(i), "content": f"step {i} " + "y" * 2000, "status": "pending"} for i in range(500)]
        todos[0]["content"] = f"deploy with token={SECRET} and Bearer {SECRET}"
        plan = events.parse_plan("todo_list", todo_result(todos, revision=9))
        self.assertEqual(len(plan["items"]), events.PLAN_ITEMS)
        self.assertEqual(plan["total"], 500)
        self.assertNotIn(SECRET, json.dumps(plan))
        self.assertIn("‹redacted›", plan["items"][0]["text"])
        for item in plan["items"]:
            self.assertLessEqual(len(item["text"]), events.PREVIEW)
        self.assertTrue(plan["items"][1]["text"].endswith("…"))

    def test_parent_cycles_and_deep_chains_stay_bounded(self):
        todos = [{"id": "a", "content": "A", "status": "pending", "parent": "b"},
                 {"id": "b", "content": "B", "status": "pending", "parent": "a"}]
        todos += [{"id": f"d{i}", "content": "deep", "status": "pending", "parent": f"d{i - 1}" if i else ""} for i in range(10)]
        plan = events.parse_plan("todo_list", todo_result(todos))
        for item in plan["items"]:
            self.assertLessEqual(item["depth"], events.PLAN_DEPTH_MAX)
        self.assertEqual(plan["items"][-1]["depth"], events.PLAN_DEPTH_MAX)

    def test_junk_fields_never_raise_and_never_leak_through(self):
        todos = [None, 3, "text", {"id": True, "content": ["list"], "status": {"x": 1}},
                 {"id": 5, "content": "ok\x00\x1b[31m", "status": "IN_PROGRESS", "extra": "dropped"}]
        plan = events.parse_plan("todo_list", json.dumps({"todos": todos, "revision": "seven"}))
        self.assertEqual(plan["rev"], 0)
        self.assertEqual(plan["items"][0], {"id": "1", "text": "", "state": "pending", "depth": 0})
        self.assertEqual(plan["items"][1]["id"], "5")
        self.assertEqual(plan["items"][1]["state"], "active")
        self.assertNotIn("\x00", plan["items"][1]["text"])
        self.assertNotIn("\x1b", plan["items"][1]["text"])
        self.assertEqual(set(plan["items"][1]), {"id", "text", "state", "depth"})

    def test_malformed_input_returns_none(self):
        for bad in (None, "", "not json", "[1, 2]", "{\"todos\": \"nope\"}", b"\xff\xfe", 42, ["a"], {"todos": None},
                    "{" * 100000, json.dumps({"todos": [{}] * 3, "revision": float("inf")}).replace("Infinity", "1e999")):
            with self.subTest(bad=str(bad)[:40]):
                result = events.parse_plan("todo_list", bad)
                self.assertTrue(result is None or isinstance(result, dict))

    def test_input_over_the_parse_limit_is_skipped(self):
        huge = todo_result([{"id": "1", "content": "x" * (events.PLAN_INPUT_MAX + 10), "status": "pending"}])
        self.assertIsNone(events.parse_plan("todo_list", huge))


class ParseOmhTodo(unittest.TestCase):
    def test_omh_items_keep_phase_blocked_and_depth(self):
        plan = events.parse_plan("omh_todo", omh_result([
            {"text": "Bootstrap", "state": "done", "phase": "I. Bootstrap", "depth": 0},
            {"text": "Wire the relay", "state": "active", "phase": "II. Build", "depth": 0},
            {"text": "Ask for review", "state": "pending", "phase": "II. Build", "depth": 1,
             "blocked_reason": "waiting on a reviewer"},
            {"text": "Skipped step", "state": "skipped", "depth": 9},
        ]))
        self.assertEqual(plan["source"], "omh")
        self.assertEqual(plan["rev"], 1767323045000)
        self.assertEqual(plan["items"], [
            {"id": "1", "text": "Bootstrap", "state": "done", "depth": 0, "phase": "I. Bootstrap"},
            {"id": "2", "text": "Wire the relay", "state": "active", "depth": 0, "phase": "II. Build"},
            {"id": "3", "text": "Ask for review", "state": "pending", "depth": 1, "phase": "II. Build",
             "blocked": "waiting on a reviewer"},
            {"id": "4", "text": "Skipped step", "state": "cancelled", "depth": events.PLAN_DEPTH_MAX},
        ])

    def test_an_absent_omh_todo_is_an_empty_plan(self):
        self.assertEqual(events.parse_plan("omh_todo", omh_result([], updated_at="")), {"source": "omh", "rev": 0, "items": []})

    def test_omh_shapes_that_are_not_a_plan(self):
        for bad in (json.dumps({"status": "invalid_action"}), json.dumps({"todo": "x"}), json.dumps({"todo": {"items": 3}}),
                    "garbage", None):
            with self.subTest(bad=str(bad)[:30]):
                self.assertIsNone(events.parse_plan("omh_todo", bad))

    def test_oversized_omh_input_is_bounded_and_redacted(self):
        items = [{"text": f"item {i} " + "z" * 900, "state": "pending", "phase": "P" * 500,
                  "blocked_reason": f"needs api_key={SECRET}"} for i in range(200)]
        plan = events.parse_plan("omh_todo", omh_result(items))
        self.assertEqual(len(plan["items"]), events.PLAN_ITEMS)
        self.assertEqual(plan["total"], 200)
        self.assertNotIn(SECRET, json.dumps(plan))
        self.assertLessEqual(len(plan["items"][0]["phase"]), 80)
        self.assertLessEqual(len(plan["items"][0]["text"]), events.PREVIEW)

    def test_unknown_tool_name_tries_both_shapes(self):
        self.assertEqual(events.parse_plan("tool_call", omh_result([{"text": "A"}]))["source"], "omh")
        self.assertEqual(events.parse_plan("tool_call", todo_result([{"id": "1", "content": "A", "status": "pending"}]))["source"], "todo")


class PostToolCallHook(unittest.TestCase):
    """The hook writes one `plan` line per todo result; it never raises, never blocks and leaves `tool_end` alone."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hermes-deck-plan-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.env = {k: os.environ.get(k) for k in ("DECK_EVENTS_DIR",)}
        os.environ["DECK_EVENTS_DIR"] = self.tmp
        events._profile = "planprof"
        events._fh, events._path = None, None
        self.addCleanup(self.restore)

    def restore(self):
        if events._fh is not None:
            events._fh.close()
        events._fh, events._path = None, None
        for k, v in self.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def lines(self):
        path = Path(self.tmp) / "planprof.ndjson"
        return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    def test_todo_list_writes_tool_end_then_plan(self):
        result = todo_result([{"id": "1", "content": "Only step", "status": "in_progress"}], revision=4)
        self.assertIsNone(events.on_post_tool_call(tool_name="todo_list", args={"todos": []}, session_id="s1",
                                                   tool_call_id="c1", result=result, duration_ms=3, status="ok"))
        ev = self.lines()
        self.assertEqual([e["ev"] for e in ev], ["tool_end", "plan"])
        self.assertEqual(ev[0]["call"], "c1")
        self.assertLessEqual(len(ev[0]["result"]), events.PREVIEW + 1)
        plan = ev[1]
        self.assertEqual((plan["sid"], plan["source"], plan["rev"]), ("s1", "todo", 4))
        self.assertEqual(plan["items"], [{"id": "1", "text": "Only step", "state": "active", "depth": 0}])
        self.assertEqual(plan["profile"], "planprof")

    def test_omh_todo_writes_a_plan(self):
        events.on_post_tool_call(tool_name="omh_todo", session_id="s2", tool_call_id="c2",
                                 result=omh_result([{"text": "A", "state": "active"}]), status="ok")
        self.assertEqual([e["ev"] for e in self.lines()], ["tool_end", "plan"])

    def test_no_plan_for_other_tools_failures_or_junk(self):
        events.on_post_tool_call(tool_name="terminal", session_id="s", tool_call_id="c", result=todo_result([{"id": "1"}]))
        events.on_post_tool_call(tool_name="todo_list", session_id="s", tool_call_id="c", result="garbage", status="ok")
        events.on_post_tool_call(tool_name="todo_list", session_id="s", tool_call_id="c", status="error",
                                 error_type="tool_error", error_message="boom",
                                 result=todo_result([{"id": "1", "content": "x", "status": "pending"}]))
        self.assertEqual([e["ev"] for e in self.lines()], ["tool_end", "tool_end", "tool_end"])
        self.assertEqual(self.lines()[2]["err"], "tool_error: boom")

    def test_a_failed_call_without_an_error_type_still_carries_its_message(self):
        events.on_post_tool_call(tool_name="terminal", session_id="s", tool_call_id="c", status="blocked",
                                 error_message="Blocked by policy")
        self.assertEqual(self.lines()[0]["err"], "Blocked by policy")

    def test_a_failing_parser_never_breaks_the_hook(self):
        original = events._parse_plan
        events._parse_plan = lambda *_: (_ for _ in ()).throw(RuntimeError("parser exploded"))
        events._plan_memo[:] = [None, None, None]
        try:
            self.assertIsNone(events.on_post_tool_call(tool_name="todo_list", session_id="s", tool_call_id="c",
                                                       result=todo_result([{"id": "1"}]), status="ok"))
        finally:
            events._parse_plan = original
        self.assertEqual([e["ev"] for e in self.lines()], ["tool_end"])

    def test_the_second_parse_of_the_same_result_is_a_copy_from_the_memo(self):
        result = todo_result([{"id": "1", "content": "Memo", "status": "pending"}])
        first = events.parse_plan("todo_list", result)
        first["items"].clear()                       # a caller mutating its copy never changes the memo
        self.assertEqual(len(events.parse_plan("todo_list", result)["items"]), 1)


if __name__ == "__main__":
    unittest_main()
