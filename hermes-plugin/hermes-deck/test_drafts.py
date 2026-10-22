"""Synthetic producer tests; no profile, network, credentials, or email.

Testdata is unmodified MIT Draft Cards source at 6e6ca659ece59b0ce1c28b3b188393491ee5a415.
--rpc exposes only the Deck adapter over stdio for the Node consumer integration test.
DECK_TEST_DRAFT_API=1 also drives the pinned FastAPI router (requires Hermes' test environment).
"""
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


observer = load("draft_test_observer", HERE / "observer.py")
producer = load("draft_test_producer", HERE / "testdata/draft-cards/store.py")


class Producer:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.path = self.home / "plugin-data/draft-cards/drafts.db"
        self.path.parent.mkdir(parents=True)
        self.store = producer.DraftStore(connect=lambda: sqlite3.connect(self.path))
        self.record = self.store.create(kind="email", platform="Mail", session_id="fixture-session",
                                       fields={"from": "sender@example.com", "to": ["reader@example.com"],
                                               "cc": ["copy@example.com"], "bcc": ["private@example.com"],
                                               "subject": "Synthetic draft", "body": "Hello <script>not HTML</script>\nİyi günler 🌍"})
        self.api = None
        if os.environ.get("DECK_TEST_DRAFT_API") == "1":
            from fastapi import FastAPI
            from fastapi.testclient import TestClient
            api = load("draft_test_api", HERE / "testdata/draft-cards/dashboard/plugin_api.py")
            api._store._default_connect = lambda: sqlite3.connect(self.path)
            api._notify = lambda _id: None  # no real event bus
            app = FastAPI()
            app.include_router(api.router)
            self.api = TestClient(app)
        self.calls = []

    def close(self):
        if self.api:
            self.api.close()
        self.temp.cleanup()

    @contextmanager
    def target(self, profile):
        if profile != "default":
            raise ValueError("Synthetic profile unavailable")

        def call(method, path, payload=None):
            self.calls.append((method, path, payload))
            if self.api:
                response = self.api.request(method, path, json=payload)
                if response.status_code != 200:
                    raise ValueError("Producer rejected stale or missing draft")
                return response.json()
            draft_id = path.split("/")[2]
            if method == "GET":
                return self.store.get(draft_id)
            if path.endswith("/edit"):
                return self.store.revise(draft_id, fields=payload["fields"], author="user",
                                         card=payload["card"], base_version=payload["base_version"], note="Edited by you")
            raise AssertionError("No approval or send API may be called")
        yield self.home, call

    def request(self, method, p):
        return observer.draft_operation(method, p, self.target)


class DraftTests(unittest.TestCase):
    def setUp(self):
        self.p = Producer()
        self.addCleanup(self.p.close)
        self.id = self.p.record["id"]
        self.params = {"profile": "default", "id": self.id}

    def test_real_producer_edit_version_conflict_and_no_send(self):
        record = self.p.request("deck.draft_get", self.params)
        fields = {k: "\n".join(v) if isinstance(v, list) else v for k, v in record["versions"][-1]["fields"].items()}
        fields.update({"from": "other@example.com", "to": "changed@example.com", "body": "Exact Unicode: ğ 🌍\nSecond line"})
        p = self.params | {"base_version": 1, "card": 1, "fields": fields}
        edited = self.p.request("deck.draft_edit", p)
        self.assertEqual(edited["latest_version"], 2)
        self.assertEqual(edited["latest_card"], 1)  # directive/card number is NOT the approval version
        self.assertEqual(edited["versions"][-1]["fields"]["body"], fields["body"])
        self.assertEqual(edited["versions"][-1]["fields"]["from"], "other@example.com")
        self.assertIsNone(edited["approved_version"])
        with self.assertRaises(ValueError):
            self.p.request("deck.draft_edit", p)
        for method in ("deck.draft_approve", "deck.draft_send", "deck.draft_state"):
            with self.assertRaises(ValueError):
                self.p.request(method, self.params)

    def test_paging_missing_disabled_profile_and_strict_shapes(self):
        for n in range(24):
            self.p.store.create(kind="email", fields={"body": str(n)})
        first = self.p.request("deck.drafts_list", {"profile": "default", "offset": 0})
        second = self.p.request("deck.drafts_list", {"profile": "default", "offset": 20})
        self.assertTrue(first["has_more"])
        self.assertFalse(second["has_more"])
        self.assertEqual(len(set(first["drafts"] + second["drafts"])), 25)
        self.assertFalse(first["send_available"])
        for params in (self.params | {"profile": "other"}, self.params | {"profile": "../default"},
                       self.params | {"id": "d_12345678/approve"}, self.params | {"command": "send"}):
            with self.assertRaises(ValueError):
                self.p.request("deck.draft_get", params)
        self.p.store.set_status(self.id, "sent")
        record = self.p.request("deck.draft_get", self.params)
        self.assertEqual(record["status"], "sent")  # agent report, never delivery attestation

    def test_previous_is_actual_version_and_fields_are_not_sanitized(self):
        self.p.store.revise(self.id, fields={"subject": "second"})
        self.p.store.revise(self.id, fields={"subject": "third"})
        record = self.p.request("deck.draft_get", self.params)
        self.assertEqual([v["v"] for v in record["versions"]], [2, 3])
        self.assertIn("<script>", record["versions"][-1]["fields"]["body"])
        self.assertIn("bcc", record["versions"][-1]["fields"])


def rpc():
    fixture = Producer()
    print(json.dumps({"schema": "hermes-deck.v1", "connection_id": "hermes", "online": True, "nodes": []}), flush=True)
    try:
        for line in sys.stdin:
            request = json.loads(line)
            try:
                result = fixture.request(request["method"], request["params"])
                response = {"jsonrpc": "2.0", "id": request["id"], "result": result}
            except Exception as exc:
                response = {"jsonrpc": "2.0", "id": request["id"], "error": {"code": 409, "message": str(exc)}}
            print(json.dumps(response, ensure_ascii=False), flush=True)
    finally:
        fixture.close()


if __name__ == "__main__":
    if "--rpc" in sys.argv:
        rpc()
    else:
        unittest.main()
