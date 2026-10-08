"""hermes-deck, bridge part: observer.py, and register() composing it with the events part.

Run with any Python 3.10+ (no Hermes, no network):  python test_bridge.py

ObserverTests are Hermes Desk's windows/hermes/tests/test_observer.py pointed at
observer.py. PluginTests drive hermes-deck's register() with a fake Hermes context: both parts on the hooks
they share, results and failures kept apart, the bridge's data paths, and the switches that turn it off.
ProtocolTests read app/main/bridge.js and check that every method it sends is one the plugin serves.
"""
import importlib.util
import json
import logging
import os
import re
import shutil
import socket
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch
from pathlib import Path

from testsupport import unittest_main

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
spec = importlib.util.spec_from_file_location("hermes_deck_observer_under_test", HERE / "observer.py")
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class ObserverTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.o = observer.Observer(Path(self.tmp.name), clock=lambda: 1000)
        self.o.pre_llm_call(session_id="main", turn_id="t1", model="model-a", platform="telegram")

    def route(self, **overrides):
        payload = dict(tool_name="omh_delegate_route", session_id="main", turn_id="t1",
                       args={"action": "set"}, status="success",
                       result=json.dumps({"status": "routed", "category": "quick"}))
        payload.update(overrides)
        self.o.post_tool_call(**payload)

    def test_native_delegation_never_requires_a_route(self):
        args = dict(tool_name="delegate_task", session_id="main", turn_id="t1", args={"goal": "check"})
        self.assertIsNone(self.o.pre_tool_call(**args))
        self.route()
        self.assertIsNone(self.o.pre_tool_call(**args))
        self.o.post_tool_call(**args, result="{}", status="success")
        self.assertIsNone(self.o.pre_tool_call(**args))

    def test_failed_or_readonly_route_is_not_recorded(self):
        self.route(result='{"status":"error"}')
        self.assertNotIn(("main", "t1"), self.o.routes)
        self.route(args={"action": "status"})
        self.assertNotIn(("main", "t1"), self.o.routes)
        self.assertIsNone(self.o.pre_tool_call(tool_name="delegate_task", session_id="main", turn_id="t1"))

    def test_route_does_not_label_another_turn_or_session(self):
        self.route()
        self.assertIsNone(self.o.pre_tool_call(tool_name="delegate_task", session_id="main", turn_id="t2"))
        self.assertIsNone(self.o.pre_tool_call(tool_name="delegate_task", session_id="other", turn_id="t1"))
        self.assertEqual(self.o.dispatch_routes, {})

    def test_native_child_keeps_identity_parent_and_omh_provenance(self):
        self.route()
        self.o.subagent_start(parent_session_id="main", parent_turn_id="t1", child_session_id="child",
                              child_subagent_id="native-id", child_role="leaf", child_goal="inspect dependencies")
        self.o.pre_llm_call(session_id="child", parent_session_id="main", turn_id="ct1", model="child-model", platform="delegate")
        self.o.subagent_stop(parent_session_id="main", child_session_id="child", child_status="completed")
        child = self.o.snapshot()["nodes"]["child"]
        self.assertEqual((child["parent_session_id"], child["subagent_id"], child["origin"], child["state"]),
                         ("main", "native-id", "omh", "finished"))
        self.assertEqual(child["model"], "child-model")

    def test_tool_arguments_and_responses_are_not_exported(self):
        self.o.pre_tool_call(tool_name="terminal", session_id="main", turn_id="t1",
                             args={"command": "secret-credential"})
        self.o.post_tool_call(tool_name="terminal", session_id="main", turn_id="t1", status="success",
                              result="private-result", args={"command": "secret-credential"})
        content = json.dumps(self.o.snapshot())
        self.assertNotIn("secret-credential", content)
        self.assertNotIn("private-result", content)
        self.assertIn("terminal", content)

    def test_atomic_snapshot_can_be_read_by_a_separate_process(self):
        files = list(Path(self.tmp.name).glob("*.json"))
        self.assertEqual(len(files), 1)
        snapshot = json.loads(files[0].read_text())
        self.assertEqual(snapshot["schema"], "hermes-deck.v1")
        self.assertIn("main", snapshot["nodes"])

    def test_steer_targets_the_running_native_agent_and_rejects_stale_turns(self):
        class Agent:
            def __init__(self): self.received = []
            def steer(self, text): self.received.append(text); return True
        agent = Agent()
        self.o.agents["main"] = lambda: agent
        self.assertEqual(self.o.control("native.steer", {"session_id":"main","turn_id":"old","text":"wrong"})["status"], "stale")
        self.assertEqual(agent.received, [])
        self.assertEqual(self.o.control("native.steer", {"session_id":"main","turn_id":"t1","text":"correct"})["status"], "queued")
        self.assertEqual(agent.received, ["correct"])

    def test_incomplete_turn_is_never_reported_as_success(self):
        self.o.on_session_end(session_id="main", completed=False, interrupted=False)
        self.assertEqual(self.o.snapshot()["nodes"]["main"]["state"], "error")

    # --- a turn that ends without on_session_end (provider failure returns before finalize_turn) -------------------
    class FakeAgent:
        def __init__(self, session_id="main", holder="pid=1:turn=t1:platform=tui"):
            self.session_id, self._active_session_turn_lease_holder = session_id, holder

    def tick(self, seconds):
        self.now[0] += seconds
        with self.o.lock:
            self.o._persist()

    def clocked_observer(self, agent):
        """An observer whose clock the test moves, with `agent` as the live agent of session main."""
        self.now = [1000.0]
        self.o = observer.Observer(Path(self.tmp.name), clock=lambda: self.now[0])
        with patch.object(observer.Observer, "_active_agent", staticmethod(lambda: agent)):
            self.o.pre_llm_call(session_id="main", turn_id="t1", model="m", platform="tui")
        return self.o.snapshot()["nodes"]["main"]

    def test_failed_turn_without_a_terminal_hook_goes_error_once_the_turn_lease_is_gone(self):
        agent = self.FakeAgent()
        self.assertEqual(self.clocked_observer(agent)["state"], "thinking")
        self.o.api_request_error(session_id="main", turn_id="t1", error={"type": "X"})
        self.tick(60)                                  # lease still held: a long call is never demoted
        self.assertEqual(self.o.snapshot()["nodes"]["main"]["state"], "thinking")
        agent._active_session_turn_lease_holder = None  # run_conversation's finally released it; no hook fired
        self.tick(5)
        self.assertEqual(self.o.snapshot()["nodes"]["main"]["state"], "thinking")  # inside the grace period
        self.tick(observer.TURN_GRACE)
        node = self.o.snapshot()["nodes"]["main"]
        self.assertEqual(node["state"], "error")
        self.assertIsNotNone(node["terminal_at"])
        self.assertFalse(node["active"])
        self.assertFalse(node["control_available"])

    def test_turn_that_ends_without_any_error_signal_goes_idle(self):
        agent = self.FakeAgent()
        self.clocked_observer(agent)
        agent._active_session_turn_lease_holder = None
        self.tick(1)
        self.tick(observer.TURN_GRACE)
        self.assertEqual(self.o.snapshot()["nodes"]["main"]["state"], "idle")

    def test_gateway_running_flag_is_the_turn_signal_and_a_new_turn_resets_the_grace_clock(self):
        agent = self.FakeAgent(holder=None)
        self.clocked_observer(agent)
        flag = {"running": True}
        with patch.object(observer.Observer, "_gateway_running", staticmethod(lambda a: flag["running"])):
            self.tick(300)                              # running for minutes: never demoted by time alone
            self.assertEqual(self.o.snapshot()["nodes"]["main"]["state"], "thinking")
            flag["running"] = False
            self.tick(observer.TURN_GRACE - 1)
            flag["running"] = True                      # the next queued prompt started within the grace period
            self.tick(observer.TURN_GRACE)
            self.assertEqual(self.o.snapshot()["nodes"]["main"]["state"], "thinking")
            flag["running"] = False
            self.tick(1)
            self.tick(observer.TURN_GRACE)
            self.assertEqual(self.o.snapshot()["nodes"]["main"]["state"], "idle")

    def test_a_node_with_no_turn_signal_at_all_is_left_alone(self):
        agent = self.FakeAgent(holder=None)             # no gateway session, no lease: nothing can prove the turn over
        self.clocked_observer(agent)
        self.tick(600)
        self.assertEqual(self.o.snapshot()["nodes"]["main"]["state"], "thinking")

    def test_a_collected_agent_demotes_its_thinking_node_after_the_grace_period(self):
        agent = self.FakeAgent()
        self.clocked_observer(agent)
        del agent
        import gc; gc.collect()
        self.tick(1)
        self.tick(observer.TURN_GRACE)
        self.assertEqual(self.o.snapshot()["nodes"]["main"]["state"], "idle")

    def test_api_request_error_is_a_registered_hook_that_never_ends_the_turn_itself(self):
        self.assertIn("api_request_error", observer.HOOKS)
        self.o.api_request_error(session_id="main", turn_id="t1", error={"type": "X"})
        self.assertEqual(self.o.snapshot()["nodes"]["main"]["state"], "thinking")
        self.o.api_request_error(session_id="unknown", turn_id="t9")   # an unknown session creates nothing
        self.assertNotIn("unknown", self.o.snapshot()["nodes"])

    def test_management_actions_do_not_need_or_consume_a_spawn_route(self):
        for action in ("list", "steer", "stop"):
            self.assertIsNone(self.o.pre_tool_call(tool_name="delegate_task", session_id="main",
                                                  turn_id="t1", args={"action": action}))
        self.route()
        self.o.post_tool_call(tool_name="delegate_task", session_id="main", turn_id="t1",
                              args={"action": "list"}, status="success")
        self.assertIsNone(self.o.pre_tool_call(tool_name="delegate_task", session_id="main",
                                              turn_id="t1", args={"goal": "launch"}))

    def test_one_route_is_reserved_once_without_blocking_other_dispatches(self):
        self.route()
        args = dict(tool_name="delegate_task", session_id="main", turn_id="t1", args={"goal": "launch"})
        self.assertIsNone(self.o.pre_tool_call(**args))
        self.assertNotIn(("main", "t1"), self.o.routes)
        self.assertEqual(self.o.dispatch_routes[("main", "t1")], "quick")
        self.assertIsNone(self.o.pre_tool_call(**args))

    def test_missing_start_session_id_recovers_the_attached_native_child(self):
        child = types.SimpleNamespace(session_id="actual-child", _subagent_id="native-child", model="child-model")
        parent = types.SimpleNamespace(session_id="main", _active_children=[child],
                                       _active_children_lock=observer.threading.Lock())
        lifecycle = types.ModuleType("agent.subagent_lifecycle")
        lifecycle.get_active_subagent_parent = lambda: parent
        with patch.dict(sys.modules, {"agent": types.ModuleType("agent"), "agent.subagent_lifecycle": lifecycle}):
            self.route()
            self.o.subagent_start(parent_session_id="main", parent_turn_id="t1", child_session_id=None,
                                  child_subagent_id="native-child", child_role="leaf")
        node = self.o.snapshot()["nodes"]["actual-child"]
        self.assertEqual((node["subagent_id"], node["parent_session_id"], node["origin"]),
                         ("native-child", "main", "omh"))
        self.assertNotIn("native-child", self.o.snapshot()["nodes"])

    def test_missing_start_session_id_retains_provenance_until_child_turn_resolves_it(self):
        self.route()
        self.o.subagent_start(parent_session_id="main", parent_turn_id="t1", child_session_id=None,
                              child_subagent_id="native-child", child_role="leaf")
        self.o.post_tool_call(tool_name="delegate_task", session_id="main", turn_id="t1", status="success")
        class Child:
            session_id, _subagent_id, _parent_session_id, _delegate_role = "actual-child", "native-child", "main", "leaf"
        child = Child()
        lifecycle = types.ModuleType("agent.subagent_lifecycle")
        lifecycle.get_active_subagent_parent = lambda: child
        with patch.dict(sys.modules, {"agent": types.ModuleType("agent"), "agent.subagent_lifecycle": lifecycle}):
            self.assertIsNone(self.o.pre_llm_call(session_id="actual-child", parent_session_id="main",
                                                turn_id="child-turn", model="child-model", platform="subagent"))
        node = self.o.snapshot()["nodes"]["actual-child"]
        self.assertEqual((node["subagent_id"], node["origin"], node["role"]), ("native-child", "omh", "leaf"))

    def delegate_and_prune(self, status="failed"):
        """A child that ran, ended, and whose node was pruned 120 s later (the observer's retention)."""
        clock = [1000]
        self.o.clock = lambda: clock[0]
        self.o.pre_llm_call(session_id="child", parent_session_id="main", turn_id="c1", model="m", platform="tui")
        self.o.subagent_stop(parent_session_id="main", child_session_id="child", child_status=status)
        clock[0] += 300
        self.o._persist()
        self.assertNotIn("child", self.o.snapshot()["nodes"])

    def test_a_trailing_hook_never_resurrects_a_pruned_subagent_as_a_top_level_session(self):
        # Regression: on_session_end / post_tool_call arriving after the 120 s prune rebuilt the child as a
        # parentless role=main node, which the rail showed as an ordinary chat.
        self.delegate_and_prune()
        self.o.post_tool_call(tool_name="terminal", session_id="child", turn_id="c1", status="error")
        self.o.on_session_end(session_id="child", turn_id="c1", failed=True)
        self.assertNotIn("child", self.o.snapshot()["nodes"])
        self.assertEqual(sorted(self.o.snapshot()["nodes"]), ["main"])

    def test_a_retry_turn_of_a_pruned_subagent_keeps_its_parent(self):
        self.delegate_and_prune()
        self.o.pre_llm_call(session_id="child", turn_id="c2", model="m", platform="tui")  # hook without parent
        child = self.o.snapshot()["nodes"]["child"]
        self.assertEqual((child["parent_session_id"], child["role"]), ("main", "leaf"))
        self.o.pre_tool_call(tool_name="read_file", session_id="child", turn_id="c2")
        self.assertEqual(self.o.snapshot()["nodes"]["child"]["parent_session_id"], "main")

    def test_subagent_identity_memory_is_bounded(self):
        for i in range(observer.LINEAGE_MAX + 20):
            self.o.pre_llm_call(session_id=f"c{i}", parent_session_id="main", turn_id="t", platform="tui")
        self.assertEqual(len(self.o.lineage), observer.LINEAGE_MAX)
        self.assertNotIn("c0", self.o.lineage)

    def test_old_turn_end_cannot_finish_a_new_turn(self):
        self.o.pre_llm_call(session_id="main", turn_id="t2")
        self.o.on_session_end(session_id="main", turn_id="t1", completed=True)
        self.assertEqual(self.o.snapshot()["nodes"]["main"]["state"], "thinking")

    def test_control_rejects_a_native_agent_that_has_advanced_beyond_the_observed_turn(self):
        class Agent:
            _current_turn_id = "t2"
            def steer(self, text): raise AssertionError("Must not target the new turn")
        agent = Agent()
        self.o.agents["main"] = lambda: agent
        self.assertEqual(self.o.control("native.steer", {"session_id":"main", "turn_id":"t1", "text":"old"})["status"], "stale")

    def test_finished_nodes_do_not_advertise_controls(self):
        self.o.nodes["main"]["control_available"] = True
        self.o.on_session_end(session_id="main", turn_id="t1", completed=True)
        self.assertFalse(self.o.snapshot()["nodes"]["main"]["control_available"])

    def test_repeated_native_request_id_does_not_queue_the_steer_twice(self):
        class Agent:
            def __init__(self): self.received = []
            def steer(self, text): self.received.append(text); return True
        agent = Agent()
        self.o.agents["main"] = lambda: agent
        params = {"session_id": "main", "turn_id": "t1", "text": "once"}
        first = self.o.control("native.steer", params, request_id="same")
        self.assertEqual(self.o.control("native.steer", params, request_id="same"), first)
        self.assertEqual(agent.received, ["once"])
        conflict = self.o.control("native.steer", {**params, "text": "different"}, request_id="same")
        self.assertEqual(conflict["status"], "duplicate_id_conflict")
        self.assertEqual(agent.received, ["once"])

    def test_model_picker_cannot_write_unrelated_or_global_configuration(self):
        self.assertTrue(observer.allowed_request("model.options", {}))
        self.assertTrue(observer.allowed_request("session.usage", {"session_id":"live"}))
        self.assertTrue(observer.allowed_request("config.set", {"session_id":"live","key":"model","value":"model-a --provider codex --session"}))
        for params in ({"session_id":"live","key":"approvals.mode","value":"off"},
                       {"key":"model","value":"model-a"},
                       {"session_id":"live","key":"model","value":"model-a --global"}):
            self.assertFalse(observer.allowed_request("config.set", params))

    def test_reasoning_effort_is_allowed_for_one_session_only(self):
        for level in ("none", "minimal", "low", "medium", "high", "xhigh", "max"):
            self.assertTrue(observer.allowed_request("config.set", {"session_id": "rpc-1", "key": "reasoning", "value": level}), level)
        for params in ({"key": "reasoning", "value": "high"},                                   # no session: Hermes writes config.yaml
                       {"session_id": "", "key": "reasoning", "value": "high"},
                       {"session_id": "rpc-1", "key": "reasoning", "value": "high", "scope": "global"},
                       {"session_id": "rpc-1", "key": "reasoning", "value": "show"},           # display words write config.yaml
                       {"session_id": "rpc-1", "key": "reasoning", "value": "hide"},
                       {"session_id": "rpc-1", "key": "reasoning", "value": "full"},
                       {"session_id": "rpc-1", "key": "reasoning", "value": "High"},
                       {"session_id": "rpc-1", "key": "reasoning", "value": "high --global"},
                       {"session_id": "rpc-1", "key": "reasoning", "value": ["high"]},
                       {"session_id": "rpc 1", "key": "reasoning", "value": "high"},
                       {"session_id": "rpc-1", "key": "fast", "value": "fast"}):
            self.assertFalse(observer.allowed_request("config.set", params), params)

    def test_native_snapshot_reports_actual_provider_profile_and_context_without_prompt_content(self):
        class Agent:
            session_id, _current_turn_id, provider, model = "main", "t1", "real-provider", "real-model"
            context_compressor = types.SimpleNamespace(context_length=128000,last_prompt_tokens=12000,last_real_prompt_tokens=12000)
        agent = Agent()
        self.o.agents["main"] = lambda: agent
        self.o._persist()
        node = self.o.snapshot()["nodes"]["main"]
        self.assertEqual((node["provider"],node["model"],node["context_used"],node["context_max"]),
                         ("real-provider","real-model",12000,128000))
        self.assertFalse(node["context_estimated"])

    def test_native_snapshot_reports_reasoning_level_only_when_the_agent_has_one(self):
        def agent(cfg, **extra):
            return types.SimpleNamespace(session_id="main", provider="p", model="m", reasoning_config=cfg, **extra)
        cases = ((dict(enabled=True, effort="High "), "high"), (dict(enabled=False), "off"),
                 (dict(enabled=True, effort="x" * 80), ""), (dict(enabled=True, effort="a b\nc"), ""),
                 (dict(enabled=True), ""), (None, ""), ("high", ""))
        for cfg, expected in cases:
            live = agent(cfg)
            self.o.agents["main"] = lambda live=live: live
            self.o._persist()
            node = self.o.snapshot()["nodes"]["main"]
            self.assertEqual(node.get("reasoning_effort", ""), expected, cfg)
        # the label disappears again when the level is cleared (no stale value)
        self.assertNotIn("reasoning_effort", node)

    def test_persisted_history_uses_native_read_only_projection_without_creating_a_session(self):
        native = types.ModuleType("hermes_cli.web_routers.sessions")
        def read_db(profile, callback, *, read_only):
            self.assertTrue(read_only)
            return callback(types.SimpleNamespace(get_session=lambda sid: {"id":sid} if sid=="stored" else None))
        native._with_db = read_db
        async def messages(session_id, profile, limit, offset, order, include_compacted, inline_images):
            self.assertEqual((session_id,profile,limit,offset,order,include_compacted,inline_images),
                             ("stored","default",40,0,"latest",False,False))
            return {"session_id":"canonical-tip","profile":"default",
                    "messages":[{"role":"assistant","content":"native text","display_kind":"hidden","display_content":"visible"}],
                    "pagination":{"limit":40,"offset":0,"order":"latest","returned":1}}
        native.get_session_messages = messages
        modules = {"hermes_cli":types.ModuleType("hermes_cli"),
                   "hermes_cli.web_routers":types.ModuleType("hermes_cli.web_routers"),
                   "hermes_cli.web_routers.sessions":native}
        with patch.dict(sys.modules, modules):
            result = self.o.messages({"session_id":"stored"})
        self.assertEqual(result["session_id"], "canonical-tip")
        self.assertEqual(result["messages"][0]["display_content"], "visible")
        self.assertEqual(result["messages"][0]["display_kind"], "hidden")
        self.assertEqual(set(self.o.snapshot()["nodes"]), {"main"})

    def test_persisted_history_rejects_invalid_paging_and_profile_paths(self):
        bad = [{"limit":0}, {"limit":101}, {"limit":True}, {"offset":-1}, {"offset":1.5},
               {"order":"oldest"}, {"inline_images":True}, {"profile":"../other"}, {"profile":"/tmp"}]
        for params in bad:
            with self.subTest(params=params), self.assertRaises(ValueError):
                self.o.messages({"session_id":"stored", **params})

    def test_child_task_title_keeps_only_safe_bounded_first_line(self):
        self.o.subagent_start(parent_session_id="main", child_session_id="child", child_subagent_id="native-child",
                              child_goal="Inspect deployment api_key=example\nPrivate full prompt remainder")
        self.o.pre_llm_call(session_id="child", parent_session_id="main", turn_id="child-turn", model="child-model")
        child = self.o.snapshot()["nodes"]["child"]
        self.assertEqual(child["title"], "Inspect deployment api_key=[redacted]")
        self.assertEqual(child["name"], "Hermes · Inspect deployment api_key=[redacted]")
        self.assertNotIn("example", json.dumps(child))
        self.assertNotIn("Private full prompt remainder", json.dumps(child))
        self.assertEqual(len(observer.safe_title("x"*200)), 80)
        self.assertNotIn("z"*30, observer.safe_title("Review "+"sk-"+"z"*30))


# ---------------------------------------------------------------------------- the plugin: register()

class Ctx:
    """The parts of Hermes' plugin context hermes-deck uses."""
    def __init__(self, settings=None):
        self.hooks, self.settings, self.unload = {}, dict(settings or {}), []

    def register_hook(self, name, fn):
        assert name not in self.hooks, f"{name} registered twice"
        self.hooks[name] = fn

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def on_unload(self, fn):
        self.unload.append(fn)


class PluginTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hermes-deck-bridge-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = self.tmp / "hermes"
        self.home.mkdir()
        env = {"DECK_EVENTS_DIR": str(self.tmp / "events"), "DECK_EVENTS_PROFILE": "testprof",
               "DECK_HOME": str(self.tmp / "deck")}
        for key in ("HERMES_DECK_BRIDGE", "DECK_BOT_SCREEN", "HERMES_CUA_DRIVER_CMD"):
            env[key] = ""
        patcher = patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        constants = types.ModuleType("hermes_constants")
        constants.get_hermes_home = lambda: str(self.home)
        constants.profile_name_for_home = lambda home: "default"
        modules = patch.dict(sys.modules, {"hermes_constants": constants})
        modules.start()
        self.addCleanup(modules.stop)
        for key in [k for k in sys.modules if k.startswith("_hermes_deck_plugin_")]:
            del sys.modules[key]               # a fresh events/observer module per test
        spec = importlib.util.spec_from_file_location("hermes_deck_plugin_under_test", HERE / "__init__.py")
        self.plugin = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.plugin)
        self.plugin.POSIX = True               # the bridge part runs here too (Windows included)
        self.events = self.plugin._sibling("events")
        self.events._profile = "testprof"
        self.obs = self.plugin._sibling("observer")
        # the control socket needs Hermes' tui_gateway; test_stream.py covers it end to end
        no_socket = patch.object(self.obs.Observer, "start_control", lambda self, stop: stop.wait(0))
        no_socket.start()
        self.addCleanup(no_socket.stop)
        self.addCleanup(lambda: [fn() for ctx in getattr(self, "ctxs", []) for fn in ctx.unload])

    def register(self, **settings):
        ctx = Ctx(settings)
        self.ctxs = getattr(self, "ctxs", []) + [ctx]
        self.plugin.register(ctx)
        return ctx.hooks

    def lines(self):
        try:
            text = (self.tmp / "events" / "testprof.ndjson").read_text(encoding="utf-8")
        except FileNotFoundError:
            return []
        return [json.loads(line) for line in text.splitlines()]

    def snapshot(self):
        return json.loads((self.home / "hermes-deck" / "processes" / f"{os.getpid()}.json").read_text(encoding="utf-8"))

    def test_shared_hooks_run_both_parts_and_the_others_stay_deck_events_own(self):
        hooks = self.register()
        self.assertEqual(set(hooks), set(self.events.HOOKS) | set(self.obs.HOOKS))
        for name, fn in hooks.items():
            if name not in self.events.HOOKS:   # observer-only hook (api_request_error): the bridge's handler as is
                self.assertIn(name, self.obs.HOOKS)
            elif name in self.obs.HOOKS:
                self.assertIsNot(fn, self.events.HOOKS[name], name)
            else:
                self.assertIs(fn, self.events.HOOKS[name], name)
        self.assertIsNone(hooks["pre_llm_call"](session_id="s1", turn_id="t1", user_message="hi", model="m",
                                                platform="telegram"))
        hooks["pre_tool_call"](tool_name="terminal", args={"command": "ls"}, session_id="s1", turn_id="t1",
                               tool_call_id="c1")
        hooks["post_tool_call"](tool_name="terminal", args={}, session_id="s1", turn_id="t1", tool_call_id="c1",
                                result="ok", status="ok", duration_ms=5)
        self.assertEqual([r["ev"] for r in self.lines()], ["turn_start", "tool_start", "tool_end"])
        node = self.snapshot()["nodes"]["s1"]                 # the bridge's data path is Hermes Desk's
        self.assertEqual((node["state"], node["turn_id"], node["steps"][-1]), ("working", "t1", "terminal · done"))
        self.assertEqual(self.snapshot()["schema"], "hermes-deck.v1")

    def test_native_delegation_is_observed_without_injected_context_or_route_requirement(self):
        hooks = self.register()
        self.assertIsNone(hooks["pre_llm_call"](session_id="s1", turn_id="t1", model="m"))
        spawn = dict(tool_name="delegate_task", args={"goal": "look"}, session_id="s1", turn_id="t1", tool_call_id="d1")
        self.assertIsNone(hooks["pre_tool_call"](**spawn))
        hooks["post_tool_call"](tool_name="omh_delegate_route", args={"action": "set"}, session_id="s1", turn_id="t1",
                                result=json.dumps({"status": "routed", "category": "quick"}), status="ok")
        self.assertIsNone(hooks["pre_tool_call"](**spawn))
        self.assertEqual([r["ev"] for r in self.lines()], ["turn_start", "tool_start", "tool_end", "tool_start"])

    def test_the_computer_use_fence_still_decides_computer_use(self):
        hooks = self.register()
        os.environ["DECK_BOT_SCREEN"] = "1"
        r = hooks["pre_tool_call"](tool_name="computer_use", args={"action": "kill_app"}, session_id="s1", turn_id="t1")
        self.assertEqual(r["action"], "block")
        self.assertIn("kill_app", r["message"])
        self.assertEqual(self.snapshot()["nodes"]["s1"]["steps"][-1], "computer_use")   # and the bridge saw it

    def test_a_failing_part_never_breaks_the_other_or_the_turn(self):
        def boom(*a, **k):
            raise RuntimeError("synthetic")
        logging.disable(logging.WARNING)
        self.addCleanup(logging.disable, logging.NOTSET)
        with patch.object(self.obs.Observer, "pre_tool_call", boom):
            hooks = self.register()
            self.assertIsNone(hooks["pre_tool_call"](tool_name="terminal", args={}, session_id="s1", turn_id="t1"))
        self.assertEqual([r["ev"] for r in self.lines()], ["tool_start"])
        with patch.dict(self.events.HOOKS, {"pre_tool_call": boom}):
            hooks = self.register()
            self.assertIsNone(hooks["pre_tool_call"](tool_name="read_file", args={}, session_id="s2", turn_id="t1"))
        self.assertEqual(self.snapshot()["nodes"]["s2"]["steps"][-1], "read_file")

    def test_bridge_switches_and_hosts_without_it_leave_the_events_part_alone(self):
        def events_only(hooks):
            self.assertEqual(set(hooks), set(self.events.HOOKS))
            self.assertTrue(all(hooks[n] is self.events.HOOKS[n] for n in hooks))
        os.environ["HERMES_DECK_BRIDGE"] = "0"
        events_only(self.register())
        os.environ["HERMES_DECK_BRIDGE"] = ""
        events_only(self.register(bridge=False))
        events_only(self.register(bridge="off"))
        self.assertFalse((self.home / "hermes-deck").exists())
        logging.disable(logging.WARNING)
        self.addCleanup(logging.disable, logging.NOTSET)
        self.plugin.POSIX = False                                  # native Windows
        events_only(self.register())
        self.plugin.POSIX = True
        with patch.dict(sys.modules, {"hermes_constants": None}):  # no Hermes to ask for its home
            events_only(self.register())
        self.assertFalse((self.home / "hermes-deck").exists())
        os.environ["HERMES_DECK_BRIDGE"] = "1"
        hooks = self.register(bridge=False)                        # the variable wins over the setting
        self.assertIsNot(hooks["pre_llm_call"], self.events.HOOKS["pre_llm_call"])
        self.assertTrue((self.home / "hermes-deck" / "processes").is_dir())

    def test_unload_stops_the_bridge_threads(self):
        self.register()
        (ctx,) = self.ctxs
        self.assertEqual(len(ctx.unload), 1)
        ctx.unload[0]()
        for t in threading.enumerate():
            if t.name.startswith("hermes-deck-bridge"):
                t.join(2)
                self.assertFalse(t.is_alive(), t.name)


# ---------------------------------------------------------------------------- what Hermes Deck sends

class ProtocolTests(unittest.TestCase):
    """Every method app/main/bridge.js may send must be served: natively (session.messages, native.*) or by the
    gateway allowlist with the parameter shapes the app uses."""
    BRIDGE_JS = REPO / "app" / "main" / "bridge.js"

    @unittest.skipUnless(hasattr(socket, "AF_UNIX"), "private control socket requires AF_UNIX")
    def test_registered_request_arrival_survives_frame_replay_and_same_id_replacement_with_scope(self):
        source = Path.home() / ".hermes/hermes-agent/tui_gateway/server_requests.py"
        if not source.is_file():
            self.skipTest("real Hermes request producer is not installed")
        spec = importlib.util.spec_from_file_location("deck_real_server_requests", source)
        producer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(producer)  # Stdlib-only producer, without importing/starting the engine.
        with tempfile.TemporaryDirectory(prefix="da-", dir="/tmp") as tmp:
            home = Path(tmp)
            instance = observer.Observer(home / "hermes-deck/processes")
            ready, stop = threading.Event(), threading.Event()
            sent, current = [], [None]
            enclosing = [{"session_id": "rpc-alpha", "info": {"profile_name": "alpha"}}]

            class Fanout:
                def __init__(self): self.peers = []
                def attach(self, peer): self.peers.append(peer)
                def detach(self, peer): self.peers.remove(peer)
                def write(self, obj):
                    sent.append(obj)
                    return all(peer.write(obj) for peer in list(self.peers))

            def dispatch(request, transport=None):
                frame = current[0].frame()
                transport.write(frame)
                response = {"jsonrpc": "2.0", "id": request["id"], "result": {
                    **enclosing[0], "open_requests": [current[0].snapshot()]}}
                # Real session.resume/events replay can arrive from the RPC pool.
                threading.Thread(target=transport.write, args=(response,), daemon=True).start()
                return None

            server = types.ModuleType("tui_gateway.server")
            server.dispatch = dispatch
            server.register_live_transport = server.unregister_live_transport = lambda _: None
            server._server_requests = producer
            server._sessions = {"rpc-alpha": {"profile_home": str(home / "profiles/alpha")},
                                "rpc-beta": {"profile_home": str(home / "profiles/beta")},
                                "rpc-default": {"profile_home": None}}
            server._launch_home = lambda: home
            transport = types.ModuleType("tui_gateway.transport")
            transport.FanoutTransport = Fanout
            transport.bind_transport = lambda _: None
            transport.reset_transport = lambda _: None
            package = types.ModuleType("tui_gateway")
            package.server, package.transport = server, transport
            constants = types.ModuleType("hermes_constants")
            constants.profile_name_for_home = lambda path: "default" if Path(path) == home else Path(path).name
            modules = {"tui_gateway": package, "tui_gateway.server": server,
                       "tui_gateway.transport": transport, "hermes_constants": constants}
            with patch.dict(sys.modules, modules), patch.object(instance, "_persist", side_effect=ready.set):
                worker = threading.Thread(target=instance.start_control, args=(stop,), daemon=True)
                worker.start()
                try:
                    self.assertTrue(ready.wait(2))
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                        client.settimeout(2)
                        client.connect(instance.control_socket)
                        with client.makefile("rb") as incoming:
                            def receive():
                                client.sendall(b'{"jsonrpc":"2.0","id":"d-test","method":"session.resume","params":{"session_id":"fixture"}}\n')
                                return json.loads(incoming.readline()), json.loads(incoming.readline())

                            def register(sid, created, profile):
                                req = producer.ServerRequest(sid, "approval", {"request_id": "ap", "profile_name": profile})
                                req.id, req.created_at = "srq-same", created
                                with producer._lock: producer._open[req.id] = req
                                current[0] = req
                                enclosing[0] = {"session_id": sid, "info": {"profile_name": profile}}
                                return req

                            first = register("rpc-alpha", 1780000000.000101, "alpha")
                            for _ in range(2):
                                live, replay = receive()
                                self.assertEqual(live["request_created_at"], first.created_at)
                                self.assertEqual(replay["result"]["open_requests"][0]["request_created_at"], first.created_at)
                            replacement = register("rpc-alpha", 1780000000.000202, "alpha")
                            self.assertEqual(int(first.created_at * 1000), int(replacement.created_at * 1000))
                            live, replay = receive()
                            self.assertEqual(live["request_created_at"], replacement.created_at)
                            self.assertNotEqual(live["request_created_at"], first.created_at)
                            self.assertEqual(replay["result"]["open_requests"][0]["request_created_at"], replacement.created_at)
                            beta = register("rpc-beta", 1780000000.000303, "beta")
                            self.assertNotIn("request_created_at", observer.request_arrival_reply(first.frame(), server))
                            live, replay = receive()
                            self.assertEqual(live["request_created_at"], beta.created_at)
                            enclosing[0]["info"]["profile_name"] = "alpha"
                            live, replay = receive()
                            self.assertNotIn("request_created_at", replay["result"]["open_requests"][0])
                            current[0].params["profile_name"] = "alpha"
                            live, replay = receive()
                            self.assertNotIn("request_created_at", live)
                            self.assertNotIn("request_created_at", replay["result"]["open_requests"][0])
                            default = register("rpc-default", 1780000000.000404, "default")
                            live, replay = receive()
                            self.assertEqual(live["request_created_at"], default.created_at)
                            default.created_at = float("nan")
                            live, replay = receive()
                            self.assertNotIn("request_created_at", live)
                            default.created_at = 1780000000.000404
                            server._server_requests = None  # Missing legacy authority keeps the ordinary request.
                            live, replay = receive()
                            self.assertNotIn("request_created_at", live)
                            self.assertNotIn("request_created_at", replay["result"]["open_requests"][0])
                            forged = dict(default.frame(), id="unregistered", request_created_at=123)
                            self.assertNotIn("request_created_at", observer.request_arrival_reply(forged, server))
                            self.assertTrue(all("request_created_at" not in frame for frame in sent))
                            self.assertTrue(all("request_created_at" not in row for frame in sent
                                                for row in frame.get("result", {}).get("open_requests", [])))
                finally:
                    stop.set()
                    worker.join(2)
                self.assertFalse(worker.is_alive())

    @unittest.skipUnless(hasattr(socket, "AF_UNIX"), "private control socket requires AF_UNIX")
    def test_pooled_session_lists_keep_root_and_named_launch_provenance_without_mutating_fanout(self):
        with tempfile.TemporaryDirectory(prefix="dp-", dir="/tmp") as tmp:
            home = Path(tmp)
            instance = observer.Observer(home / "hermes-deck/processes")
            ready, stop = threading.Event(), threading.Event()
            responses = []

            class Fanout:
                def __init__(self): self.peers = []
                def attach(self, peer): self.peers.append(peer)
                def detach(self, peer): self.peers.remove(peer)
                def write(self, obj): return all(peer.write(obj) for peer in list(self.peers))

            def dispatch(request, transport=None):
                response = {"jsonrpc": "2.0", "id": request["id"], "result": {"sessions": [{"id": "cloned"}]}}
                responses.append(response)
                threading.Thread(target=transport.write, args=(response,), daemon=True).start()
                return None  # Production session.list answers from the engine's RPC pool.

            server = types.ModuleType("tui_gateway.server")
            server.dispatch = dispatch
            server.register_live_transport = server.unregister_live_transport = lambda _: None
            server._launch_home = lambda: home
            transport = types.ModuleType("tui_gateway.transport")
            transport.FanoutTransport = Fanout
            transport.bind_transport = lambda _: None
            transport.reset_transport = lambda _: None
            package = types.ModuleType("tui_gateway")
            package.server, package.transport = server, transport
            constants = types.ModuleType("hermes_constants")
            constants.get_hermes_home = lambda: home / "profiles/beta"  # Unrelated per-turn scope.
            constants.profile_name_for_home = lambda path: "default" if Path(path) == home else Path(path).name
            modules = {"tui_gateway": package, "tui_gateway.server": server,
                       "tui_gateway.transport": transport, "hermes_constants": constants}
            with patch.dict(sys.modules, modules), patch.object(instance, "_persist", side_effect=ready.set):
                worker = threading.Thread(target=instance.start_control, args=(stop,), daemon=True)
                worker.start()
                try:
                    self.assertTrue(ready.wait(2))
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                        client.settimeout(2)
                        client.connect(instance.control_socket)
                        with client.makefile("rb") as incoming:
                            for profile in ("default", "alpha"):
                                server._launch_home = lambda profile=profile: home if profile == "default" else home / "profiles" / profile
                                client.sendall((json.dumps({"jsonrpc": "2.0", "id": profile,
                                    "method": "session.list", "params": {"limit": 50}}) + "\n").encode())
                                reply = json.loads(incoming.readline())
                                self.assertEqual(reply["result"].get("launch_profile"), profile)
                                self.assertEqual(reply["result"]["sessions"], [{"id": "cloned"}])
                                self.assertNotIn("launch_profile", responses[-1]["result"])
                            server._launch_home = None  # An older engine has no authoritative getter.
                            client.sendall((json.dumps({"jsonrpc": "2.0", "id": "legacy",
                                "method": "session.list", "params": {"limit": 50}}) + "\n").encode())
                            self.assertNotIn("launch_profile", json.loads(incoming.readline())["result"])
                finally:
                    stop.set()
                    worker.join(2)
                self.assertFalse(worker.is_alive())

    def methods(self):
        if not self.BRIDGE_JS.is_file():
            self.skipTest("app/main/bridge.js is not next to this plugin (installed copy)")
        text = self.BRIDGE_JS.read_text(encoding="utf-8")
        found = []
        for name in ("READS", "MUTATIONS"):
            m = re.search(rf"const {name} = \[([^\]]*)\]", text)
            self.assertIsNotNone(m, name)
            found += re.findall(r'"([a-z.]+)"', m.group(1))
        return found

    def test_every_bridge_method_is_served(self):
        native = {"session.messages", "native.steer", "native.redirect", "native.interrupt", "deck.appshot", "deck.attach_submit",
                  "deck.transcribe", "deck.file_read", "deck.session_index", "deck.session_update", "deck.reasoning_view", "deck.takeover",
                  "deck.plan", "deck.version"}  # deck.version: answered by stream.py itself (stream.VERSION_METHOD), never relayed
        self.assertIn('VERSION_METHOD = "deck.version"', (Path(__file__).resolve().parent / "stream.py").read_text(encoding="utf-8"))
        shapes = {"config.set": {"session_id": "rpc-1", "key": "model", "value": "m --provider p --session"},
                  "profiles.get_asset": {"name": "default", "asset": "avatar"},
                  "session.title": {"session_id": "rpc-1", "title": "Bot Chat"},
                  "session.delete": {"session_id": "stored-1", "profile": "default"},
                  "session.archive": {"session_id": "stored-1", "archived": True, "profile": "default"},
                  "session.branch_stored": {"parent_session_id": "stored-1", "profile": "default"},
                  "subagent.list": {"session_id": "rpc-1"},
                  "subagent.tail": {"session_id": "rpc-1", "subagent_id": "sa-0-abc"},
                  "subagent.interrupt": {"session_id": "rpc-1", "subagent_id": "sa-0-abc"},
                  "subagent.steer": {"session_id": "rpc-1", "subagent_id": "sa-0-abc", "text": "Focus"}}
        methods = self.methods()
        self.assertGreaterEqual(len(methods), 10)
        for method in methods:
            with self.subTest(method=method):
                self.assertTrue(method in native or observer.allowed_request(method, shapes.get(method, {}), {"rpc-1"}), method)
                if method not in native and method != "config.set":
                    self.assertIn(method, observer.DECK_METHODS)
        self.assertFalse(observer.allowed_request("config.set", {**shapes["config.set"], "value": "m --global"}))
        self.assertFalse(observer.allowed_request("terminal.execute", {}))

    def test_the_gateway_allowlist_is_hermes_desks_plus_the_bot_roster(self):
        """Legacy bridge method set (an older install still works against this plugin), plus the Botlar
        reads profiles.list / profiles.get_asset and the narrow session.title write; no other profiles.* write."""
        self.assertEqual(observer.ALLOWED_METHODS, {
            "session.create", "session.resume", "session.list", "session.active_list", "session.close",
            "session.interrupt", "session.steer", "session.redirect", "prompt.submit", "session.events.since",
            "subagent.list", "subagent.interrupt", "subagent.steer", "subagent.tail", "approval.respond",
            "request.answer", "model.options", "session.usage",
            "profiles.list", "profiles.get_asset", "session.title", "session.delete",
            "session.archive", "session.branch_stored"})
        for method in ("profiles.configure", "profiles.create", "profiles.set_asset", "profiles.delete",
                       "cron.manage", "bot_relay.deliver", "session.set_hidden", "session.archive", "session.branch_stored"):
            self.assertFalse(observer.allowed_request(method, {"name": "default"}, {"rpc-1"}), method)


class ReasoningViewTests(unittest.TestCase):
    """deck.reasoning_view ("Show thinking"): flips show_reasoning of ONE runtime session this control socket owns,
    in memory only; strict params; never another surface's session; never config.yaml."""

    def server(self, sessions):
        return types.SimpleNamespace(_sessions_lock=threading.Lock(), _sessions=sessions)

    def test_sets_the_flag_of_a_session_this_connection_owns(self):
        owner = object()
        sessions = {"rpc-1": {"transport": owner, "show_reasoning": False}}
        reply = observer.reasoning_reply({"id": 7, "params": {"session_id": "rpc-1", "show": True}}, owner, self.server(sessions))
        self.assertEqual(reply, {"jsonrpc": "2.0", "id": 7, "result": {"session_id": "rpc-1", "show": True}})
        self.assertIs(sessions["rpc-1"]["show_reasoning"], True)
        observer.reasoning_view({"session_id": "rpc-1", "show": False}, owner, self.server(sessions))
        self.assertIs(sessions["rpc-1"]["show_reasoning"], False)

    def test_refuses_other_transports_unknown_sessions_and_any_other_shape(self):
        owner, tui = object(), object()
        sessions = {"tui-1": {"transport": tui, "show_reasoning": False}, "rpc-1": {"transport": owner}}
        srv = self.server(sessions)
        for params in ({"session_id": "tui-1", "show": True},        # a TUI / desktop / platform session
                       {"session_id": "nope", "show": True}):
            reply = observer.reasoning_reply({"id": 1, "params": params}, owner, srv)
            self.assertEqual(reply["error"]["code"], 4000, params)
        self.assertIs(sessions["tui-1"]["show_reasoning"], False)
        for params in ({"session_id": "rpc-1"}, {"session_id": "rpc-1", "show": 1}, {"session_id": "rpc-1", "show": "true"},
                       {"session_id": "rpc-1", "show": True, "scope": "global"}, {"session_id": "a b", "show": True},
                       {"session_id": "", "show": True}, {"show": True}):
            reply = observer.reasoning_reply({"id": 2, "params": params}, owner, srv)
            self.assertEqual(reply["error"]["code"], 4000, params)
        self.assertNotIn("show_reasoning", sessions["rpc-1"])
        self.assertEqual(observer.reasoning_reply({"id": 3, "params": {"session_id": "rpc-1", "show": True}}, None, srv)["error"]["code"], 4000)

    def test_a_session_shared_with_another_live_client_is_still_this_connections(self):
        """A session also open in the TUI/desktop gets the Deck's peers flattened into ITS fanout (Hermes
        _attach_session_transport): still ours, so Show thinking reaches it. A fanout without our peers is not."""
        # Ownership uses only this public membership contract; CI has no Hermes checkout.
        # Identity comparisons match FanoutTransport.transports()/contains(), including detach.
        class FanoutTransport:
            def __init__(self, *peers): self.peers = list(peers)
            def attach(self, peer):
                if not self.contains(peer): self.peers.append(peer)
            def detach(self, peer): self.peers = [p for p in self.peers if p is not peer]
            def transports(self): return list(self.peers)
            def contains(self, peer): return any(p is peer for p in self.peers)

        class Peer:
            def write(self, obj): return True
            def close(self): pass
        deck_peer, tui_peer, other_deck = Peer(), Peer(), Peer()
        owner = FanoutTransport(deck_peer)
        shared = FanoutTransport(tui_peer)
        shared.attach(deck_peer)
        sessions = {"rpc-shared": {"transport": shared, "show_reasoning": False},
                    "tui-only": {"transport": FanoutTransport(tui_peer, other_deck), "show_reasoning": False}}
        srv = self.server(sessions)
        reply = observer.reasoning_reply({"id": 4, "params": {"session_id": "rpc-shared", "show": True}}, owner, srv)
        self.assertEqual(reply.get("result"), {"session_id": "rpc-shared", "show": True}, reply)
        self.assertIs(sessions["rpc-shared"]["show_reasoning"], True)
        reply = observer.reasoning_reply({"id": 5, "params": {"session_id": "tui-only", "show": True}}, owner, srv)
        self.assertEqual(reply["error"]["code"], 4000)
        self.assertIs(sessions["tui-only"]["show_reasoning"], False)
        shared.detach(deck_peer)  # the Deck left: no longer ours
        reply = observer.reasoning_reply({"id": 6, "params": {"session_id": "rpc-shared", "show": False}}, owner, srv)
        self.assertEqual(reply["error"]["code"], 4000)

    def test_is_not_a_gateway_method(self):
        """Served natively by the control socket, never dispatched to Hermes (whose config.set reasoning writes config.yaml)."""
        self.assertNotIn(observer.REASONING_METHOD, observer.ALLOWED_METHODS)
        self.assertFalse(observer.allowed_request("config.set", {"session_id": "rpc-1", "key": "reasoning", "value": "show"}))


class FakeSessionDb:
    """The slice of Hermes' SessionDB the session browser touches."""

    def __init__(self, rows):
        self.rows = {r["id"]: dict(r) for r in rows}
        self.listed, self.titled, self.pinned = [], [], []

    def list_sessions_rich(self, **kw):
        self.listed.append(kw)
        rows = [r for r in self.rows.values() if bool(r.get("archived")) == kw["archived_only"]
                and r.get("source") not in (kw["exclude_sources"] or [])]
        return rows[kw["offset"]:kw["offset"] + kw["limit"]]

    def get_session(self, sid):
        return self.rows.get(sid)

    def set_session_title(self, sid, title):
        self.titled.append((sid, title))
        self.rows[sid]["title"] = title
        return True

    def set_session_pinned(self, sid, pinned):
        self.pinned.append((sid, pinned))
        self.rows[sid]["pinned"] = int(pinned)
        return True


def fake_with_db(db, seen=None):
    def with_db(profile, fn, read_only):
        if seen is not None:
            seen.append((profile, read_only))
        return fn(db)
    return with_db


ROWS = [
    {"id": "s-tg", "title": "Telegram chat", "preview": "hi", "source": "telegram", "started_at": 10, "last_active": 50, "message_count": 4, "archived": 0, "pinned": 1},
    {"id": "s-web", "title": None, "preview": "p" * 400, "source": "webui", "started_at": 20, "last_active": None, "message_count": 2, "archived": 0, "pinned": 0},
    {"id": "s-old", "title": "Old", "preview": "", "source": "tui", "started_at": 1, "last_active": 2, "message_count": 1, "archived": 1, "pinned": 0},
    {"id": "s-bot", "title": "Bot Chat", "preview": "", "source": "desktop", "started_at": 1, "last_active": 2, "message_count": 1, "archived": 0, "pinned": 0},
    {"id": "bad id", "title": "x", "source": "cli", "archived": 0},
]


class SessionBrowserTests(unittest.TestCase):
    """deck.session_index / deck.session_update and the archive / branch allowlist entries."""

    def test_session_archive_takes_one_stored_id_and_a_real_boolean(self):
        ok = observer.allowed_request
        self.assertTrue(ok("session.archive", {"session_id": "s-1", "archived": True}))
        self.assertTrue(ok("session.archive", {"session_id": "s-1", "archived": False, "profile": "bot-a"}))
        for params in ({}, {"session_id": "s-1"}, {"archived": True}, {"session_id": "s-1", "archived": "true"},
                       {"session_id": "s-1", "archived": 1}, {"session_id": "a b", "archived": True},
                       {"session_id": "", "archived": True}, {"session_id": "x" * 513, "archived": True},
                       {"session_id": "s-1", "archived": True, "session_key": "k"},
                       {"session_id": "s-1", "archived": True, "profile": "../x"},
                       {"session_id": "s-1", "archived": True, "profile": 3}):
            with self.subTest(params=params):
                self.assertFalse(ok("session.archive", params))

    def test_session_branch_stored_takes_a_parent_profile_and_an_idempotency_key_only(self):
        ok = observer.allowed_request
        self.assertTrue(ok("session.branch_stored", {"parent_session_id": "s-1"}))
        self.assertTrue(ok("session.branch_stored", {"parent_session_id": "s-1", "profile": "bot-a", "idempotency_key": "abcd-1234-efgh"}))
        for params in ({}, {"profile": "bot-a"}, {"parent_session_id": ""}, {"parent_session_id": "a b"},
                       {"parent_session_id": "s-1", "cwd": "/"}, {"parent_session_id": "s-1", "messages": []},
                       {"parent_session_id": "s-1", "title": "Bot Chat"}, {"parent_session_id": "s-1", "source": "telegram"},
                       {"parent_session_id": "s-1", "idempotency_key": "short"},
                       {"parent_session_id": "s-1", "profile": "a/b"}):
            with self.subTest(params=params):
                self.assertFalse(ok("session.branch_stored", params))

    def test_index_lists_a_profile_read_only_without_hidden_internal_or_malformed_rows(self):
        db, seen = FakeSessionDb(ROWS), []
        out = observer.session_index({"profile": "bot-a", "limit": 50}, fake_with_db(db, seen))
        self.assertEqual(seen, [("bot-a", True)])  # a read-only store handle
        self.assertEqual([r["id"] for r in out["sessions"]], ["s-tg", "s-web", "s-bot"])
        tg, web = out["sessions"][0], out["sessions"][1]
        self.assertEqual((tg["profile"], tg["source"], tg["lastActive" if False else "last_active"], tg["pinned"], tg["archived"]), ("bot-a", "telegram", 50.0, True, False))
        self.assertEqual((web["title"], len(web["preview"]), web["last_active"]), ("", 200, 20.0))  # falls back to started_at
        kw = db.listed[0]
        self.assertEqual((kw["limit"], kw["offset"], kw["archived_only"], kw["order_by_last_active"], kw["compact_rows"]), (50, 0, False, True, True))
        self.assertEqual(sorted(kw["exclude_sources"]), ["kanban", "oneshot", "tool"])
        self.assertFalse(out["has_more"])

    def test_index_adds_the_newest_message_as_last_preview_and_keeps_preview(self):
        import sqlite3
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE sessions (id TEXT)")
        conn.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, display_kind TEXT)")
        for sid in ("s-tg", "s-web", "s-bot"):
            conn.execute("INSERT INTO sessions VALUES (?)", (sid,))
        msgs = [("s-tg", "user", "first question", 1, None), ("s-tg", "assistant", "**Done**\n\n`ok` <memory-context>secret\nrecall</memory-context> now", 2, None),
                ("s-tg", "tool", "tool output must be skipped", 3, None), ("s-tg", "assistant", "   ", 4, None),
                ("s-web", "user", "x" * 500, 5, None), ("s-web", "assistant", "hidden scaffold", 6, "hidden"),
                ("s-bot", "user", "only tool after", 7, None), ("s-bot", "tool", "t", 8, None)]
        for i, (sid, role, content, ts, kind) in enumerate(msgs):
            conn.execute("INSERT INTO messages VALUES (?,?,?,?,?,?)", (i, sid, role, content, ts, kind))

        class Db(FakeSessionDb):
            reads = []
            def _read_all(self, sql, params=()):
                Db.reads.append((sql, params))
                return conn.execute(sql, params).fetchall()

        db = Db(ROWS)
        out = observer.session_index({"profile": "bot-a", "limit": 50}, fake_with_db(db))
        by = {r["id"]: r for r in out["sessions"]}
        self.assertEqual(len(Db.reads), 1)  # ONE bounded query for the whole page
        self.assertEqual(by["s-tg"]["last_role"], "assistant")
        self.assertEqual(by["s-tg"]["last_preview"], "Done ok now")
        self.assertEqual(by["s-web"]["last_role"], "user")
        self.assertEqual(len(by["s-web"]["last_preview"]), 200)
        self.assertTrue(by["s-web"]["last_preview"].endswith("…"))
        self.assertEqual(by["s-bot"]["last_role"], "user")
        for r in out["sessions"]:
            self.assertIn("preview", r)  # the first-message preview stays for older clients
        self.assertEqual(len(by["s-web"]["preview"]), 200)

    def test_index_without_raw_reads_or_with_a_failing_query_still_lists(self):
        out = observer.session_index({"limit": 50}, fake_with_db(FakeSessionDb(ROWS)))
        self.assertEqual(len(out["sessions"]), 3)
        self.assertTrue(all("last_preview" not in r for r in out["sessions"]))

        class Broken(FakeSessionDb):
            def _read_all(self, sql, params=()):
                raise RuntimeError("no such column")
        out = observer.session_index({"limit": 50}, fake_with_db(Broken(ROWS)))
        self.assertEqual(len(out["sessions"]), 3)
        self.assertTrue(all("last_preview" not in r for r in out["sessions"]))

    def test_shape_last_preview(self):
        self.assertEqual(observer.shape_last_preview("# Title\n\n[link](http://x) and **bold**"), "Title link and bold")
        self.assertEqual(observer.shape_last_preview("<omh-context>a</omh-context>hello"), "hello")
        self.assertEqual(observer.shape_last_preview(None), "")

    def test_index_archived_view_pages_and_reports_more(self):
        db = FakeSessionDb([{"id": f"a-{i}", "source": "cli", "archived": 1, "started_at": i} for i in range(5)])
        out = observer.session_index({"archived": "only", "limit": 2, "offset": 2}, fake_with_db(db))
        self.assertEqual([r["id"] for r in out["sessions"]], ["a-2", "a-3"])
        self.assertTrue(out["has_more"])
        self.assertTrue(all(r["archived"] and r["profile"] == "default" for r in out["sessions"]))
        self.assertFalse(db.listed[0]["include_pinned"])
        self.assertEqual(observer.session_index({"archived": "only", "limit": 2, "offset": 4}, fake_with_db(db))["has_more"], False)

    def test_index_refuses_anything_outside_its_shape(self):
        db = FakeSessionDb(ROWS)
        for params in ({"source": "telegram"}, {"include_hidden": True}, {"archived": "include"}, {"archived": True},
                       {"limit": 0}, {"limit": 101}, {"limit": "5"}, {"limit": True}, {"offset": -1}, {"offset": 100_001},
                       {"offset": 1.5}, {"profile": "../x"}, {"profile": ""}, {"profile": 3}, {"query": "x"}):
            with self.subTest(params=params):
                with self.assertRaises(ValueError):
                    observer.session_index(params, fake_with_db(db))
        self.assertEqual(db.listed, [])

    def test_update_renames_with_user_provenance_and_pins(self):
        db, seen = FakeSessionDb(ROWS), []
        out = observer.session_update({"session_id": "s-web", "profile": "bot-a", "title": "  New \n name  ", "pinned": True}, fake_with_db(db, seen))
        self.assertEqual(out, {"ok": True, "title": "New name", "pinned": True})
        self.assertEqual((db.titled, db.pinned, seen), ([("s-web", "New name")], [("s-web", True)], [("bot-a", False)]))
        self.assertEqual(observer.session_update({"session_id": "s-web", "pinned": False}, fake_with_db(db))["pinned"], False)

    def test_update_refuses_bad_titles_ids_flags_and_extra_keys(self):
        db = FakeSessionDb(ROWS)
        base = {"session_id": "s-web"}
        for params in ({}, {"session_id": "s-web"}, {"title": "x"}, {**base, "title": ""}, {**base, "title": "   "},
                       {**base, "title": "x" * 101}, {**base, "title": "a\x00b"}, {**base, "title": "a\u202eb"},
                       {**base, "title": 5}, {**base, "title": "Bot Chat"}, {**base, "title": " Bot   Chat "},
                       {**base, "pinned": "yes"}, {**base, "pinned": 1}, {**base, "title": "ok", "hidden": True},
                       {**base, "title": "ok", "archived": True}, {"session_id": "a b", "title": "ok"},
                       {**base, "title": "ok", "profile": "x/y"}):
            with self.subTest(params=params):
                with self.assertRaises(ValueError):
                    observer.session_update(params, fake_with_db(db))
        self.assertEqual((db.titled, db.pinned), ([], []))
        with self.assertRaises(ValueError):
            observer.session_update({"session_id": "nope", "title": "ok"}, fake_with_db(db))
        with self.assertRaises(ValueError):  # the canonical Bot Chat keeps its identity
            observer.session_update({"session_id": "s-bot", "title": "Renamed"}, fake_with_db(db))
        self.assertEqual(db.titled, [])
        self.assertEqual(len(observer._clean_title("x" * 100)), 100)

    def test_replies_name_the_problem_and_hide_store_errors(self):
        bad = observer.session_reply({"id": "r1", "params": {"limit": 0}}, observer.session_index)
        self.assertEqual((bad["id"], bad["error"]["code"]), ("r1", 4000))
        db = FakeSessionDb(ROWS)
        good = observer.session_reply({"id": "r2", "params": {}}, observer.session_index, fake_with_db(db))
        self.assertEqual(len(good["result"]["sessions"]), 3)

        def broken(profile, fn, read_only):
            raise RuntimeError("secret path /x/state.db")
        failed = observer.session_reply({"id": "r3", "params": {}}, observer.session_index, broken)
        self.assertEqual(failed["error"], {"code": 5000, "message": "Hermes session store unavailable"})

    def test_a_missing_profile_is_refused_before_a_store_is_opened(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, True)
        mod = types.ModuleType("hermes_constants")
        mod.get_default_hermes_root = lambda: str(root)
        (root / "profiles" / "real").mkdir(parents=True)
        with patch.dict(sys.modules, {"hermes_constants": mod}):
            with self.assertRaisesRegex(ValueError, "Unknown Hermes profile"):
                observer._profile_db("ghost", lambda db: None, True)


class SessionDeleteTests(unittest.TestCase):
    """The rail's right-click > Delete: session.delete may name one stored session (and its profile), nothing else."""

    def test_accepts_a_stored_id_with_or_without_a_profile(self):
        self.assertTrue(observer.allowed_request("session.delete", {"session_id": "20261005_101500_ab12cd"}))
        self.assertTrue(observer.allowed_request("session.delete", {"session_id": "s-1", "profile": "bot-a"}))
        self.assertTrue(observer.allowed_request("session.delete", {"session_id": "s-1", "profile": "default"}))

    def test_rejects_extra_params_a_bad_profile_and_a_bad_id(self):
        for params in ({}, {"profile": "bot-a"}, {"session_id": ""}, {"session_id": 7}, {"session_id": "a b"},
                       {"session_id": "x" * 513}, {"session_id": "s-1", "hard": True},
                       {"session_id": "s-1", "sessions_dir": "/tmp/x"}, {"session_id": "s-1", "profile": "../x"},
                       {"session_id": "s-1", "profile": ""}, {"session_id": "s-1", "profile": "a/b"},
                       {"session_id": "s-1", "profile": 3}, {"session_id": "s-1", "profile": "x" * 65}):
            with self.subTest(params=params):
                self.assertFalse(observer.allowed_request("session.delete", params))

    def test_is_a_deck_method_the_bridge_sends(self):
        self.assertIn("session.delete", observer.DECK_METHODS)
        self.assertIn('"session.delete"', (REPO / "app" / "main" / "bridge.js").read_text(encoding="utf-8"))


class BotRosterTests(unittest.TestCase):
    """The Botlar methods: what the host lets through, whatever the Deck sends."""

    def test_profiles_list_takes_no_parameters(self):
        self.assertTrue(observer.allowed_request("profiles.list", {}))
        self.assertFalse(observer.allowed_request("profiles.list", {"include_sessions": False}))

    def test_get_asset_reads_one_profiles_avatar_only(self):
        self.assertTrue(observer.allowed_request("profiles.get_asset", {"name": "bot-a", "asset": "avatar"}))
        for params in ({"name": "bot-a"}, {"name": "bot-a", "asset": "soul"}, {"name": "../x", "asset": "avatar"},
                       {"name": "", "asset": "avatar"}, {"name": 3, "asset": "avatar"},
                       {"name": "bot-a", "asset": "avatar", "data": "x"}):
            with self.subTest(params=params):
                self.assertFalse(observer.allowed_request("profiles.get_asset", params))

    def test_session_title_only_names_a_session_this_connection_created_bot_chat(self):
        made = {"rpc-new"}
        self.assertTrue(observer.allowed_request("session.title", {"session_id": "rpc-new", "title": "Bot Chat"}, made))
        for params, created in (({"session_id": "rpc-new", "title": "Bot Chat"}, set()),
                                ({"session_id": "rpc-other", "title": "Bot Chat"}, made),
                                ({"session_id": "rpc-new", "title": "Anything else"}, made),
                                ({"session_id": "rpc-new"}, made),  # a read of the title is not needed either
                                ({"session_id": "rpc-new", "title": "Bot Chat", "profile": "x"}, made)):
            with self.subTest(params=params, created=created):
                self.assertFalse(observer.allowed_request("session.title", params, created))

    def test_an_avatar_too_big_for_one_reply_line_is_refused_before_dispatch(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, True)
        profiles = types.ModuleType("hermes_cli.profiles")
        profiles.get_profile_dir = lambda name: root if name == "default" else root / "profiles" / name
        for name, size in (("default", 3000), ("big", observer.AVATAR_MAX_BYTES + 1), ("edge", observer.AVATAR_MAX_BYTES)):
            assets = (root if name == "default" else root / "profiles" / name) / "assets"
            assets.mkdir(parents=True)
            (assets / "avatar.png").write_bytes(b"\x89PNG" + b"\0" * (size - 4))
        (root / "profiles" / "none").mkdir(parents=True)
        with patch.dict(sys.modules, {"hermes_cli": types.ModuleType("hermes_cli"), "hermes_cli.profiles": profiles}):
            self.assertIsNone(observer.avatar_refusal({"name": "default", "asset": "avatar"}))
            self.assertIsNone(observer.avatar_refusal({"name": "edge", "asset": "avatar"}))
            self.assertIsNone(observer.avatar_refusal({"name": "none", "asset": "avatar"}))  # Hermes: found false
            self.assertIn("too large", observer.avatar_refusal({"name": "big", "asset": "avatar"}))
        # the cap keeps the base64 reply well under the 2 MiB frame limit of stream.py and the Deck
        self.assertLess(observer.AVATAR_MAX_BYTES * 4 / 3 + 1024, 2 * 1024 * 1024)
        self.assertLess(observer.AVATAR_REPLY_MAX, 2 * 1024 * 1024)

    def test_only_a_bot_chat_create_may_later_be_titled_bot_chat(self):
        self.assertTrue(observer.creates_bot_chat("session.create", {"title": "Bot Chat", "hidden": True, "profile": "x"}))
        for method, params in (("session.create", {}), ("session.create", {"title": "Bot Chat"}),
                               ("session.create", {"title": "Bot Chat", "hidden": False}),
                               ("session.create", {"title": "Bot Chat", "hidden": "true"}),
                               ("session.create", {"title": "Other", "hidden": True}),
                               ("session.resume", {"title": "Bot Chat", "hidden": True})):
            with self.subTest(method=method, params=params):
                self.assertFalse(observer.creates_bot_chat(method, params))

    def test_an_avatar_reply_read_after_a_late_swap_is_refused_not_written_oversized(self):
        small = {"jsonrpc": "2.0", "id": "d-1", "result": {"found": True, "data": "data:image/png;base64," + "A" * 1000}}
        self.assertIs(observer.guard_avatar_reply(small), small)
        cap = {"jsonrpc": "2.0", "id": "d-2", "result": {"found": True, "mime": "image/png", "size": observer.AVATAR_MAX_BYTES,
                                                          "data": "data:image/png;base64," + "A" * (observer.AVATAR_MAX_BYTES * 4 // 3 + 4)}}
        self.assertIs(observer.guard_avatar_reply(cap), cap, "a file at the cap still fits")
        big = {"jsonrpc": "2.0", "id": "d-3", "result": {"found": True, "data": "data:image/png;base64," + "A" * 2_700_000}}
        refused = observer.guard_avatar_reply(big)
        self.assertEqual((refused["id"], refused["error"]["code"]), ("d-3", 4071))
        self.assertLess(len(json.dumps(refused)), 1024)

    def test_one_avatar_request_in_flight_and_a_lost_reply_does_not_block_forever(self):
        now = [100.0]
        slot = observer.OneInFlight(stale=60, clock=lambda: now[0])
        first = slot.acquire()
        self.assertIsNotNone(first)
        self.assertIsNone(slot.acquire())
        slot.release(first)
        second = slot.acquire()
        self.assertIsNotNone(second)
        now[0] += 61                              # its reply never came: the slot is taken over
        third = slot.acquire()
        self.assertIsNotNone(third)
        slot.release(second)                      # the late reply of the stale one frees nothing
        self.assertIsNone(slot.acquire())
        slot.release(third)
        self.assertIsNotNone(slot.acquire())

    def test_the_avatar_reply_goes_to_the_asking_connection_only_and_frees_the_slot(self):
        class Sink:
            def __init__(self): self.frames, self.written = [], threading.Event()
            def write(self, obj): self.frames.append(obj); self.written.set(); return True
        peer, fanout, freed = Sink(), Sink(), threading.Event()
        reply = observer.AvatarReply(peer, fanout, "d-7", freed.set)
        event = {"jsonrpc": "2.0", "method": "event", "params": {"type": "x"}}
        self.assertTrue(reply.write(event))
        self.assertEqual(fanout.frames, [event], "anything but the reply keeps the normal fan-out")
        self.assertFalse(freed.is_set())
        self.assertTrue(reply.write({"jsonrpc": "2.0", "id": "d-7", "result": {"found": False}}))
        self.assertTrue(freed.wait(5) and peer.written.wait(5))
        self.assertEqual(peer.frames, [{"jsonrpc": "2.0", "id": "d-7", "result": {"found": False}}])
        self.assertEqual(fanout.frames, [event], "the avatar reply is not queued for every peer")
        self.assertFalse(reply.write({"jsonrpc": "2.0", "id": "d-7", "result": {"found": False}}), "one reply only")


if __name__ == "__main__":
    unittest_main()
