"""Offline subscription usage contract; no credentials or network required."""
import importlib.util
import json
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace, ModuleType
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("deck_usage_events", Path(__file__).with_name("events.py"))
events = importlib.util.module_from_spec(spec)
spec.loader.exec_module(events)


class UsageTests(unittest.TestCase):
    def test_subscription_snapshot_normalizes_only_safe_fields(self):
        stub = ModuleType("agent.account_usage")
        calls = []
        def fetch(provider):
            calls.append(provider)
            return SimpleNamespace(windows=(
                SimpleNamespace(label="Current session", used_percent=0, reset_at=datetime(2030, 1, 1, tzinfo=timezone.utc)),
                SimpleNamespace(label="Current week", used_percent=44, reset_at=None)),
                fetched_at=datetime(2030, 1, 1, tzinfo=timezone.utc), unavailable_reason=None,
                raw={"email": "private@example.invalid"})
        stub.fetch_account_usage = fetch
        with patch.dict("sys.modules", {"agent.account_usage": stub}):
            q = events._fetch_quota("codex")
        self.assertEqual(calls, ["openai-codex"])
        self.assertTrue(q["ok"])
        self.assertEqual([w["minutes"] for w in q["windows"]], [300, 10080])
        self.assertEqual([w["used"] for w in q["windows"]], [0, 44])
        self.assertEqual(q["windows"][0]["resetsAt"], "2030-01-01T00:00:00+00:00")
        self.assertNotIn("private", json.dumps(q))
        stub.fetch_account_usage = lambda _: (_ for _ in ()).throw(RuntimeError("Bearer private-secret"))
        with patch.dict("sys.modules", {"agent.account_usage": stub}):
            q = events._fetch_quota("claude")
        self.assertFalse(q["ok"])
        self.assertEqual(q["error"], "unavailable")
        self.assertNotIn("secret", json.dumps(q))

    def test_quota_fetch_binds_profile_secret_scope_on_bare_thread(self):
        # A multiplexing gateway fails closed on credential reads from an unscoped thread; the
        # quota worker must bind the profile scope for the fetch and release it afterwards.
        import contextvars
        scope_var = contextvars.ContextVar("scope", default=None)
        built = []
        scope = ModuleType("agent.secret_scope")
        scope.current_secret_scope = lambda: scope_var.get()
        scope.build_profile_secret_scope = lambda home: built.append(home) or {"K": "v"}
        scope.set_secret_scope = lambda m, profile_home=None: scope_var.set(m)
        scope.reset_secret_scope = lambda t: scope_var.reset(t)
        seen = []
        usage = ModuleType("agent.account_usage")
        def fetch(provider):
            seen.append(scope_var.get())
            return SimpleNamespace(windows=(SimpleNamespace(label="Current week", used_percent=5, reset_at=None),),
                                   fetched_at=datetime(2030, 1, 1, tzinfo=timezone.utc), unavailable_reason=None)
        usage.fetch_account_usage = fetch
        pkg = ModuleType("agent")
        pkg.secret_scope = scope
        with patch.dict("sys.modules", {"agent": pkg, "agent.secret_scope": scope, "agent.account_usage": usage}):
            q = contextvars.Context().run(events._fetch_quota, "claude", Path("/profile/home"))
        self.assertTrue(q["ok"])
        self.assertEqual(seen, [{"K": "v"}])
        self.assertEqual(built, [Path("/profile/home")])
        self.assertIsNone(scope_var.get())

    def test_snapshot_fetch_is_nonblocking_and_caches_for_five_minutes(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            home.joinpath("config.yaml").write_text("model:\n  provider: claude-subscription-directsdk-experimental\ndelegation:\n  provider: openai-codex\n")
            events._quota_cache.clear()
            events._quota_jobs.clear()
            events._quota_due.clear()
            with patch.object(events, "_fetch_quota", return_value={"ok": True, "windows": [], "fetched_at": 10}) as fetch:
                events._quota_snapshot(home)
                for _ in range(50):
                    quotas = events._quota_snapshot(home)
                    if all(q.get("ok") for q in quotas.values()):
                        break
                    time.sleep(.01)
                self.assertEqual(set(quotas), {"claude", "codex"})
                self.assertEqual(fetch.call_count, 2)
                events._quota_snapshot(home)
                self.assertEqual(fetch.call_count, 2)

    def test_persisted_cost_is_read_only_and_emitted_when_hooks_strip_raw_usage(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            db = sqlite3.connect(home / "state.db")
            db.execute("CREATE TABLE sessions (id TEXT, model TEXT, billing_provider TEXT, estimated_cost_usd REAL, actual_cost_usd REAL)")
            db.execute("INSERT INTO sessions VALUES ('fixture-session', 'claude-example', 'claude-subscription-directsdk-experimental', .5, NULL)")
            db.commit()
            before = (home / "state.db").read_bytes()
            events._db_cost_cache.clear()
            with patch.object(events, "_emit") as emit:
                events._db_costs_once(home)
                events._db_costs_once(home)
            self.assertEqual(len(emit.call_args_list), 1)
            self.assertEqual(emit.call_args.kwargs["usd"], .5)
            self.assertEqual(emit.call_args.kwargs["mode"], "absolute")
            self.assertTrue(emit.call_args.kwargs["estimated"])
            self.assertEqual(emit.call_args.kwargs["cost_label"], "API list-price equivalent")
            self.assertEqual(before, (home / "state.db").read_bytes())
            db.close()

    def test_quota_timeout_keeps_one_inflight_worker_and_backs_off(self):
        import threading
        release = threading.Event()
        events._quota_cache.clear()
        events._quota_jobs.clear()
        events._quota_due.clear()
        events._quota_failures.clear()
        def slow(*_):
            release.wait(2)
            return {"ok": True, "windows": [], "fetched_at": 10}
        try:
            with patch.object(events, "_configured_quota_providers", return_value=["claude"]), patch.object(events, "_fetch_quota", side_effect=slow) as fetch:
                with patch.object(events.time, "monotonic", return_value=0):
                    events._quota_snapshot(Path("fixture"))
                with patch.object(events.time, "monotonic", return_value=30):
                    result = events._quota_snapshot(Path("fixture"))
                self.assertEqual(result["claude"]["error"], "timeout")
                self.assertGreaterEqual(events._quota_due["claude"], 330)
                with patch.object(events.time, "monotonic", return_value=3000):
                    events._quota_snapshot(Path("fixture"))
                self.assertEqual(fetch.call_count, 1)
        finally:
            release.set()
            for job in events._quota_jobs.values():
                job["thread"].join(2)
            events._quota_jobs.clear()

    def test_persisted_cost_wal_read_never_mutates_source_files(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            db = sqlite3.connect(home / "state.db")
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE sessions (id TEXT, model TEXT, estimated_cost_usd REAL, actual_cost_usd REAL)")
            db.execute("INSERT INTO sessions VALUES ('wal-session', 'example', .5, NULL)")
            db.commit()
            db.close()
            before = {p.name: p.read_bytes() for p in home.iterdir()}
            events._db_cost_cache.clear()
            with patch.object(events, "_emit") as emit:
                events._db_costs_once(home)
            self.assertEqual(emit.call_args.kwargs["usd"], .5)
            self.assertEqual({p.name: p.read_bytes() for p in home.iterdir()}, before)
            db = sqlite3.connect(home / "state.db")
            try:
                db.execute("UPDATE sessions SET estimated_cost_usd=.75")
                db.commit()
                before = {p.name: p.read_bytes() for p in home.iterdir()}
                with patch.object(events, "_emit") as emit:
                    events._db_costs_once(home)
                self.assertEqual(emit.call_args.kwargs["usd"], .75)
                self.assertEqual({p.name: p.read_bytes() for p in home.iterdir()}, before)
            finally:
                db.close()

    def test_quota_result_after_deadline_is_not_accepted(self):
        events._quota_cache.clear()
        events._quota_jobs.clear()
        events._quota_due.clear()
        events._quota_failures.clear()
        events._quota_jobs["claude"] = {"started": 0, "finished": 30,
            "thread": SimpleNamespace(is_alive=lambda: False),
            "result": {"ok": True, "windows": [], "fetched_at": 10}}
        with patch.object(events, "_configured_quota_providers", return_value=["claude"]), patch.object(events.time, "monotonic", return_value=30):
            result = events._quota_snapshot(Path("fixture"))
        self.assertFalse(result["claude"]["ok"])
        self.assertEqual(result["claude"]["error"], "timeout")

    def test_persisted_cost_rejects_racing_and_oversized_copies(self):
        import sqlite3
        import shutil
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            file = home / "state.db"
            db = sqlite3.connect(file)
            db.execute("CREATE TABLE sessions (id TEXT, model TEXT, estimated_cost_usd REAL, actual_cost_usd REAL)")
            db.execute("INSERT INTO sessions VALUES ('racing', 'example', .5, NULL)")
            db.commit()
            original = shutil.copyfile
            copies = []
            def copy_and_change(source, target):
                copies.append(Path(target).parent)
                original(source, target)
                db.execute("UPDATE sessions SET estimated_cost_usd=.75")
                db.commit()
            with patch.object(shutil, "copyfile", side_effect=copy_and_change), patch.object(events, "_emit") as emit:
                events._db_costs_once(home)
            emit.assert_not_called()
            self.assertTrue(all(not p.exists() for p in copies))
            db.close()
            with file.open("r+b") as handle:
                handle.truncate(512 * 1024 * 1024 + 1)
            with patch.object(events, "_emit") as emit:
                events._db_costs_once(home)
            emit.assert_not_called()

    def test_cost_event_is_per_call_not_cumulative_and_labels_subscription(self):
        with patch.object(events, "_emit") as emit:
            events.on_post_api_request(session_id="fixture-session", model="claude-example", provider="claude-subscription-directsdk-experimental",
                usage={"input_tokens": 3, "raw_usage": {"native_cost": {"total_cost_usd": .25}}})
        cost = [c for c in emit.call_args_list if c.args == ("cost",)]
        self.assertEqual(len(cost), 1)
        self.assertEqual(cost[0].kwargs["usd"], .25)
        self.assertEqual(cost[0].kwargs["mode"], "delta")
        self.assertEqual(cost[0].kwargs["cost_label"], "API list-price equivalent")
        with patch.object(events, "_emit") as emit:
            events.on_post_api_request(usage={"raw_usage": {"native_cost": {"total_cost_usd": float("nan")}}})
        self.assertFalse(any(c.args == ("cost",) for c in emit.call_args_list))


class QuotaRefreshTests(unittest.TestCase):
    def setUp(self):
        for d in (events._quota_cache, events._quota_jobs, events._quota_due, events._quota_failures, events._quota_settled):
            d.clear()
        events._quota_force_since = 0.0
        events._quota_ack = None

    def _pump(self, home, until, limit=3.0):
        end = time.time() + limit
        while time.time() < end:
            events._quota_snapshot(home)
            if until():
                return True
            time.sleep(0.02)
        return False

    def test_refresh_refetches_before_the_five_minute_timer_and_settles(self):
        home = Path("fixture")
        calls = []
        def fetch(provider, h=None):
            calls.append(provider)
            return {"provider": provider, "ok": True, "windows": [], "fetched_at": time.time()}
        with patch.object(events, "_configured_quota_providers", return_value=["claude", "codex"]), \
                patch.object(events, "_fetch_quota", side_effect=fetch):
            self.assertTrue(self._pump(home, lambda: len(calls) == 2))
            self.assertTrue(self._pump(home, lambda: all(events._quota_jobs.get(p) is None for p in ("claude", "codex"))))
            for _ in range(5):
                events._quota_snapshot(home)
            self.assertEqual(len(calls), 2)                       # idle: the five-minute timer holds
            events._quota_request_refresh(1)
            self.assertFalse(events._quota_refresh_settled(home))  # nothing fetched since the request
            self.assertTrue(self._pump(home, lambda: events._quota_refresh_settled(home)))
            self.assertEqual(sorted(calls), ["claude", "claude", "codex", "codex"])

    def test_fetch_in_flight_when_the_request_arrives_is_redone(self):
        home = Path("fixture")
        calls, gate = [], __import__("threading").Event()
        def fetch(provider, h=None):
            calls.append(provider)
            if len(calls) == 1:
                gate.wait(2)
            return {"provider": provider, "ok": True, "windows": [], "fetched_at": time.time()}
        with patch.object(events, "_configured_quota_providers", return_value=["claude"]), \
                patch.object(events, "_fetch_quota", side_effect=fetch):
            events._quota_snapshot(home)                          # first (old) fetch is now blocked
            time.sleep(0.05)
            events._quota_request_refresh(2)
            gate.set()
            self.assertTrue(self._pump(home, lambda: events._quota_refresh_settled(home)))
            self.assertEqual(len(calls), 2)                       # the pre-request fetch did not count

    def test_trigger_file_is_read_and_ack_lands_in_the_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict("os.environ", {"DECK_EVENTS_DIR": tmp}):
                self.assertIsNone(events._read_quota_trigger())
                (Path(tmp) / "state").mkdir()
                (Path(tmp) / "state" / events.QUOTA_TRIGGER).write_text(json.dumps({"id": 1700000000123, "at": 1700000000.123}))
                self.assertEqual(events._read_quota_trigger(), (1700000000123, 1700000000.123))
                (Path(tmp) / "state" / events.QUOTA_TRIGGER).write_text("{broken")
                self.assertIsNone(events._read_quota_trigger())
                home = Path(tmp) / "home"
                home.mkdir()
                (home / "gateway_state.json").write_text(json.dumps({"pid": __import__("os").getpid()}))
                events._quota_ack = {"id": 5}
                with patch.object(events, "_quota_snapshot", return_value={}):
                    self.assertTrue(events._snapshot_once(home))
                snap = json.loads((Path(tmp) / "state" / (events._profile_name() + ".json")).read_text())
                self.assertEqual(snap["quota_refresh"], {"id": 5})


if __name__ == "__main__":
    unittest.main()
