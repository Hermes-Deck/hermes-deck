"""Pin regression, including an opt-in real native owner (no model turns).

Run DECK_NATIVE_TESTS=1 with Hermes on sys.path and a short, disposable TMPDIR.
The native test boots only its own isolated gateway and reads back its SQLite store.
It requires the core's same-user, routeless legacy-cron sidebar pin/unpin capability,
without general history ownership. Older cores that deny this capability do not
satisfy this opt-in contract; their refusal is not an alternate passing outcome.
"""
import asyncio
from contextlib import asynccontextmanager
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import observer


@unittest.skipUnless(importlib.util.find_spec("hermes_cli"), "requires native Hermes client")
class OwnerRoutingTests(unittest.TestCase):
    def test_owned_profile_never_opens_a_second_writer(self):
        # The failing producer boundary: _profile_db(read_only=False) is refused
        # while a gateway owns the profile, even though browsing succeeds.
        row = {"id": "stored", "title": "History", "pinned": False, "runtime_revision": 7}
        calls = []

        def store(profile, fn, read_only):
            self.assertTrue(read_only, "owned profile must not acquire exclusive maintenance")
            calls.append((profile, read_only))
            return fn(SimpleNamespace(get_session=lambda sid: row))

        from hermes_cli.gateway_runtime import GatewayDiscovery, GatewayEndpoint
        ep = GatewayEndpoint("/isolated/cold", "owner", 1, 1, "http://127.0.0.1:1", "none", frozenset())

        @asynccontextmanager
        async def connect(endpoint=None, **kw):
            self.assertEqual(kw, {})  # native peer identity, never an invented subject
            assert endpoint is not None
            self.assertEqual(endpoint.control_home, "/isolated/cold")

            async def rpc(method, **params):
                calls.append((method, params))
                row.update(title=params["payload"].get("title", row["title"]), pinned=params["payload"]["pinned"])
                return {"session_id": "stored", "operation": "sidebar", "revision": 8, **params["payload"]}
            yield SimpleNamespace(rpc=rpc)

        with patch.object(observer, "_profile_db", side_effect=store), \
                patch("hermes_cli.web_server_sessions._session_db_path_for_profile", return_value=Path("/isolated/cold/state.db")), \
                patch("hermes_cli.gateway_runtime.discover_gateway_endpoint", return_value=GatewayDiscovery("ready", ep)), \
                patch("hermes_cli.gateway_client.connect_gateway", connect):
            result = observer.session_update({"session_id": "stored", "profile": "cold", "pinned": True})
        self.assertEqual(result, {"ok": True, "title": "History", "pinned": True})
        rpc = next(params for method, params in calls if method == "session.mutate")
        self.assertEqual(rpc["expected_revision"], 7)
        self.assertEqual(rpc["operation"], "sidebar")
        self.assertEqual(rpc["payload"], {"pinned": True, "hidden": False})
        self.assertTrue(rpc["request_id"])


    def test_owner_failures_are_classified_private_and_never_replayed(self):
        from hermes_cli.gateway_client import GatewayClientError, GatewayRPCError
        from hermes_cli.gateway_runtime import GatewayDiscovery, GatewayEndpoint
        ep = GatewayEndpoint("/isolated/cold", "owner", 1, 1, "http://127.0.0.1:1", "none",
                             frozenset(), control_home="/isolated/multiplexer")
        row = {"id": "stored", "title": "History", "runtime_revision": 0}
        errors = [(GatewayRPCError("permission_denied", data={"path": "/private"}), 4030),
                  (GatewayRPCError("profile_mismatch"), 4030), (GatewayRPCError("revision_conflict"), 4090),
                  (GatewayRPCError("not_found"), 4040), (GatewayRPCError("storage_unavailable"), 5030),
                  (GatewayRPCError("/private/session-id"), 4090),
                  (GatewayClientError("disconnected /private/session-id"), 5030), (TimeoutError("/private"), 5030)]
        for exc, code in errors:
            with self.subTest(error=type(exc).__name__, reason=str(exc)):
                calls = []

                def store(profile, fn, read_only):
                    self.assertTrue(read_only, "no writable fallback after owner failure")
                    return fn(SimpleNamespace(get_session=lambda sid: row))

                @asynccontextmanager
                async def connect(endpoint=None, **kw):
                    self.assertEqual(endpoint, ep)  # keep the discovered multiplexer socket
                    self.assertEqual(kw, {})

                    async def rpc(method, **params):
                        calls.append((method, params))
                        raise exc  # even a lost post-commit reply must never replay
                    yield SimpleNamespace(rpc=rpc)

                with patch.object(observer, "_profile_db", side_effect=store), \
                        patch("hermes_cli.web_server_sessions._session_db_path_for_profile", return_value=Path("/isolated/cold/state.db")), \
                        patch("hermes_cli.gateway_runtime.discover_gateway_endpoint", return_value=GatewayDiscovery("ready", ep)), \
                        patch("hermes_cli.gateway_client.connect_gateway", connect):
                    reply = observer.session_reply({"id": 1, "params": {"profile": "cold", "session_id": "stored", "pinned": False}},
                                                   observer.session_update)
                self.assertEqual(reply["error"]["code"], code)
                self.assertNotIn("/private", json.dumps(reply))
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0][1]["payload"], {"pinned": False})  # unpin does not unhide

    def test_old_engine_uses_its_native_store_policy(self):
        row = {"id": "stored", "title": "History", "pinned": False}
        db = SimpleNamespace(get_session=lambda sid: row,
                             set_session_title=lambda sid, value: row.update(title=value),
                             set_session_pinned=lambda sid, value: row.update(pinned=value))
        with patch.dict(sys.modules, {"hermes_cli.gateway_client": None}), \
                patch.object(observer, "_profile_db", side_effect=lambda profile, fn, read_only: fn(db)) as store:
            result = observer.session_update({"session_id": "stored", "title": "Renamed", "pinned": True})
        self.assertEqual(result, {"ok": True, "title": "Renamed", "pinned": True})
        self.assertFalse(store.call_args.args[2])
        # Missing client support never means that a modern engine's ownership guard may be skipped.
        from fastapi import HTTPException
        with patch.dict(sys.modules, {"hermes_cli.gateway_client": None}), \
                patch.object(observer, "_profile_db", side_effect=HTTPException(409, "owner holds store")):
            with self.assertRaises(HTTPException):
                observer.session_update({"session_id": "stored", "pinned": True})

    def test_real_websocket_send_failure_is_unknown_without_replay(self):
        from hermes_cli.gateway_client import GatewayClient
        from hermes_cli.gateway_runtime import GatewayDiscovery, GatewayEndpoint
        from websockets.exceptions import ConnectionClosedError
        endpoint = GatewayEndpoint("/isolated/cold", "owner", 1, 1, "http://127.0.0.1:1", "none", frozenset())
        sends = []

        class BrokenSocket:
            async def send(self, frame):
                sends.append(frame)
                raise ConnectionClosedError(None, None)

        @asynccontextmanager
        async def connect(**kwargs):
            yield GatewayClient(BrokenSocket())

        with patch("hermes_cli.web_server_sessions._session_db_path_for_profile", return_value=Path("/isolated/cold/state.db")), \
                patch("hermes_cli.gateway_runtime.discover_gateway_endpoint", return_value=GatewayDiscovery("ready", endpoint)), \
                patch("hermes_cli.gateway_client.connect_gateway", connect):
            with self.assertRaises(observer.SessionUpdateError) as failed:
                observer._session_update_owner("cold", "stored", {"runtime_revision": 0}, {"pinned": True})
        self.assertEqual(failed.exception.code, 5030)
        self.assertIn("outcome unknown", str(failed.exception))
        self.assertEqual(len(sends), 1)

    def test_uncertain_discovery_cannot_fall_back(self):
        from hermes_cli.gateway_runtime import GatewayDiscovery
        for state in ("starting", "draining", "inaccessible", "incompatible"):
            with self.subTest(state=state), \
                    patch("hermes_cli.web_server_sessions._session_db_path_for_profile", return_value=Path("/isolated/state.db")), \
                    patch("hermes_cli.gateway_runtime.discover_gateway_endpoint", return_value=GatewayDiscovery(state)):
                with self.assertRaises(observer.SessionUpdateError) as refused:
                    observer._session_update_owner("default", "stored", {"runtime_revision": 0}, {"pinned": True})
                self.assertEqual(refused.exception.code, 5030)


@unittest.skipUnless(os.environ.get("DECK_NATIVE_TESTS") == "1", "opt-in isolated native Hermes")
class NativeOwnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from hermes_cli.gateway_runtime import discover_gateway_endpoint
        from hermes_state import SessionDB
        import hermes_constants

        cls.tmp = tempfile.TemporaryDirectory(prefix="dp-")
        cls.addClassCleanup(cls.tmp.cleanup)
        cls.root = Path(cls.tmp.name).resolve()
        cls.home = cls.root / "h"
        cls.user = cls.root / "u"
        cls.home.mkdir(mode=0o700)
        cls.user.mkdir()
        cls.env_patch = patch.dict(os.environ, {"HOME": str(cls.user), "USERPROFILE": str(cls.user),
            "HERMES_HOME": str(cls.home)})
        cls.env_patch.start()
        cls.addClassCleanup(cls.env_patch.stop)
        token = hermes_constants.set_hermes_home_override(str(cls.home))
        cls.addClassCleanup(hermes_constants.reset_hermes_home_override, token)
        for profile in ("default", "cold"):
            home = cls.home if profile == "default" else cls.home / "profiles" / profile
            home.mkdir(parents=True, exist_ok=True, mode=0o700)
            (home / "config.yaml").write_text(json.dumps({
                "gateway": {"multiplex_profiles": True},
                "model": {"provider": "custom", "default": "no-model-calls", "base_url": "http://127.0.0.1:1/v1"},
                "auxiliary": {"title_generation": {"enabled": False}},
                "sessions": {"auto_archive": False},
            }))
            with SessionDB(db_path=home / "state.db") as db:
                for source in ("gui", "cli", "desktop", "cron"):
                    db.create_session(source, source=source)
                    db.set_session_title(source, profile + " " + source)
                db.set_session_hidden("gui", True)
                db.set_session_archived("cli", True)
                db.create_session("foreign", source="gui", user_id="another-user")
                db.create_session("foreign-cron", source="cron", user_id="another-user")
                db.create_session("bot", source="gui")
                db.set_session_title("bot", "Bot Chat")
                db.create_session("revision", source="gui")
                db.create_session("hidden", source="gui")
                db.set_session_hidden("hidden", True)
        # The no-owner route remains the native exclusive-maintenance path, not a new DB writer.
        assert observer.session_update({"session_id": "cli", "pinned": True})["pinned"] is True
        assert observer.session_update({"session_id": "cli", "pinned": False})["pinned"] is False
        runtime = Path(hermes_constants.__file__).resolve().parent
        env = {k: os.environ[k] for k in ("PATH", "LANG", "TZ", "TMPDIR") if k in os.environ}
        env.update(HOME=str(cls.user), USERPROFILE=str(cls.user), HERMES_HOME=str(cls.home),
                   PYTHONPATH=str(runtime), PYTHONUNBUFFERED="1")
        cls.log = (cls.root / "gateway.log").open("w+")
        cls.addClassCleanup(cls.log.close)
        cls.proc = subprocess.Popen([sys.executable, "-m", "gateway.run"], cwd=runtime, env=env,
            stdin=subprocess.DEVNULL, stdout=cls.log, stderr=subprocess.STDOUT)
        cls.addClassCleanup(cls.stop_owner)
        deadline = time.monotonic() + 90
        found = None
        while cls.proc.poll() is None and time.monotonic() < deadline:
            found = discover_gateway_endpoint(cls.home, timeout=.5)
            if found.state == "ready":
                break
            time.sleep(.1)
        if found is None or found.state != "ready":
            cls.log.seek(0)
            raise AssertionError((found, cls.proc.poll(), cls.log.read()[-6000:]))

    @classmethod
    def stop_owner(cls):
        if cls.proc.poll() is None:
            cls.proc.send_signal(signal.SIGINT)
            try:
                cls.proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                cls.proc.kill()
                cls.proc.wait(timeout=10)

    def row(self, profile, sid) -> dict:
        from hermes_state import SessionDB
        home = self.home if profile == "default" else self.home / "profiles" / profile
        row = None
        with SessionDB(db_path=home / "state.db", read_only=True) as db:
            row = db.get_session(sid)
        assert row is not None
        return row

    def test_native_refusals_revision_fence_and_unpin_hidden(self):
        for sid, changes, code in (("foreign", {"pinned": True}, 4030),
                                    ("foreign-cron", {"pinned": True}, 4030),
                                    ("bot", {"title": "Not Bot Chat", "pinned": True}, 4000)):
            with self.subTest(sid=sid):
                before = self.row("cold", sid)
                reply = observer.session_reply({"id": 1, "params": {"profile": "cold", "session_id": sid, **changes}},
                                               observer.session_update)
                self.assertEqual(reply["error"]["code"], code, reply)
                self.assertEqual(self.row("cold", sid), before)
        stale = self.row("cold", "revision")
        observer.session_update({"profile": "cold", "session_id": "revision", "pinned": True})
        with self.assertRaises(observer.SessionUpdateError) as conflict:
            observer._session_update_owner("cold", "revision", stale, {"pinned": False})
        self.assertEqual(conflict.exception.code, 4090)
        self.assertEqual(self.row("cold", "revision")["runtime_revision"], stale["runtime_revision"] + 1)
        self.assertEqual(self.row("cold", "revision")["pinned"], 1)
        observer.session_update({"profile": "cold", "session_id": "hidden", "pinned": False})
        self.assertEqual(self.row("cold", "hidden")["hidden"], 1)
        with self.assertRaisesRegex(ValueError, "Unknown Hermes profile"):
            observer.session_update({"profile": "missing", "session_id": "gui", "pinned": True})
        self.assertFalse((self.home / "profiles" / "missing").exists())

        # The native capability permits legacy cron pins, not general history control.
        from hermes_cli.gateway_client import GatewayRPCError, connect_gateway
        from hermes_cli.gateway_runtime import discover_gateway_endpoint
        from hermes_state import SessionDB
        from hermes_state_mutation_binding import BINDING_PREFIX
        endpoint = discover_gateway_endpoint(self.home / "profiles" / "cold").endpoint
        assert endpoint is not None
        original = self.row("cold", "cron")
        for pinned in (True, False):
            with self.subTest(legacy_cron_pinned=pinned):
                before = self.row("cold", "cron")
                result = observer.session_update({"profile": "cold", "session_id": "cron", "pinned": pinned})
                self.assertEqual(result, {"ok": True, "title": original["title"], "pinned": pinned})
                after = self.row("cold", "cron")
                self.assertEqual(after["pinned"], int(pinned))
                self.assertEqual(after["runtime_revision"], before["runtime_revision"] + 1)
                for key in ("source", "user_id", "session_key", "chat_id", "origin_json", "runtime_generation"):
                    self.assertEqual(after[key], original[key])
                with SessionDB(db_path=self.home / "profiles" / "cold" / "state.db", read_only=True) as db:
                    with db._read_ctx() as conn:
                        self.assertIsNone(conn.execute("SELECT 1 FROM state_meta WHERE key=?",
                                                       (BINDING_PREFIX + "cron",)).fetchone())
                with self.assertRaises(observer.SessionUpdateError) as conflict:
                    observer._session_update_owner("cold", "cron", before, {"pinned": not pinned})
                self.assertEqual(conflict.exception.code, 4090)
                reply = observer.session_reply({"id": "rename", "params": {
                    "profile": "cold", "session_id": "cron", "title": "Not permitted"}}, observer.session_update)
                self.assertEqual(reply["error"]["code"], 4040, reply)

                async def archive():
                    async with connect_gateway(endpoint=endpoint) as client:
                        return await client.rpc("session.mutate", session_id="cron", request_id=f"archive-{pinned}",
                                                expected_revision=after["runtime_revision"], operation="archive",
                                                payload={"archived": True})
                with self.assertRaises(GatewayRPCError) as denied:
                    asyncio.run(archive())
                self.assertEqual(str(denied.exception), "not_found")
                self.assertEqual(self.row("cold", "cron"), after)

    def test_native_created_gui_without_deck_attachment(self):
        from hermes_cli.gateway_client import connect_gateway
        from hermes_cli.gateway_runtime import discover_gateway_endpoint
        endpoint = discover_gateway_endpoint(self.home / "profiles" / "cold").endpoint
        assert endpoint is not None

        async def create():
            async with connect_gateway(endpoint=endpoint) as client:
                return await client.rpc("session.create", request_id="native-gui", source="gui", toolsets=[])
        created = asyncio.run(create())  # no prompt.submit: no model or tool call
        sid = created["session_id"]
        pinned = observer.session_update({"profile": "cold", "session_id": sid, "pinned": True})
        self.assertTrue(pinned["pinned"])
        self.assertEqual(self.row("cold", sid)["pinned"], 1)
        observer.session_update({"profile": "cold", "session_id": sid, "pinned": False})
        self.assertEqual(self.row("cold", sid)["pinned"], 0)

    def test_native_owner_pin_unpin_stored_rows_and_profile_isolation(self):
        from fastapi import HTTPException
        # Prove the old path fails on this actual owner, not just on a fake DB.
        with self.assertRaises(HTTPException) as held:
            observer._profile_db("cold", lambda db: None, False)
        self.assertEqual(held.exception.status_code, 409)
        for profile in ("default", "cold"):
            for source in ("gui", "cli", "desktop"):
                with self.subTest(profile=profile, source=source):
                    before = self.row(profile, source)
                    result = observer.session_reply({"id": "pin", "params": {
                        "profile": profile, "session_id": source, "pinned": True}}, observer.session_update)
                    self.assertIn("result", result, result)
                    self.assertTrue(result["result"]["pinned"])
                    after = self.row(profile, source)
                    self.assertEqual((after["pinned"], after["hidden"]), (1, 0))
                    self.assertEqual(after["archived"], before["archived"])
                    self.assertEqual(after["runtime_revision"], before["runtime_revision"] + 1)
                    self.assertEqual(self.row("cold" if profile == "default" else "default", source)["pinned"], 0)
                    unpin = observer.session_update({"profile": profile, "session_id": source, "pinned": False})
                    self.assertFalse(unpin["pinned"])
                    self.assertEqual(self.row(profile, source)["pinned"], 0)
                    self.assertEqual(self.row(profile, source)["runtime_revision"], before["runtime_revision"] + 2)
        renamed = observer.session_update({"profile": "cold", "session_id": "gui", "title": " New  name ", "pinned": True})
        self.assertEqual(renamed, {"ok": True, "title": "New name", "pinned": True})
        self.assertEqual(self.row("cold", "gui")["title_source"], "user")


if __name__ == "__main__":
    unittest.main()
