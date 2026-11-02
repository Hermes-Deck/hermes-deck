"""Pending decisions survive a new private control connection; no session resume or command replay."""
import json
import socket
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from test_bridge import observer


class Request:
    def __init__(self, rid, sid, method, params):
        self.id, self.sid, self.method, self.params = rid, sid, method, params
        self.created_at = 1780000000.125

    def frame(self):
        return {"jsonrpc": "2.0", "id": self.id, "method": self.method,
                "params": {"session_id": self.sid, **self.params}}


class Fanout:
    def __init__(self):
        self.peers = []

    def attach(self, peer):
        self.peers.append(peer)

    def detach(self, peer):
        self.peers.remove(peer)

    def write(self, obj):
        return all(peer.write(obj) for peer in list(self.peers))


@unittest.skipUnless(hasattr(socket, "AF_UNIX"), "requires private Unix sockets")
class RequestReconnectTests(unittest.TestCase):
    def test_new_connection_restores_only_open_decisions_without_resuming_sessions(self):
        # Use an isolated temporary home; the socket path must fit the platform's Unix-socket limit.
        with tempfile.TemporaryDirectory(prefix="dr-") as tmp:
            home = Path(tmp)
            instance = observer.Observer(home / "processes")
            ready, stop = threading.Event(), threading.Event()
            requests = types.SimpleNamespace(_lock=threading.Lock(), _open={})
            rows = [Request("approve", "s-a", "approval", {"command": "test only"}),
                    Request("question", "s-b", "clarify", {"questions": [{"qid": "q1", "question": "Test?"}]}),
                    Request("secret", "s-a", "vault.save_login", {"origin": "https://login.example.com",
                                                                  "site": "login.example.com"}),
                    Request("orphan", "missing", "approval", {}),
                    Request("forged", "s-a", "approval", {"profile_name": "beta"})]
            requests._open = {r.id: r for r in rows}
            calls = []
            server = types.ModuleType("tui_gateway.server")
            server._server_requests = requests
            server._sessions = {"s-a": {"profile_home": str(home)},
                                "s-b": {"profile_home": str(home / "profiles/alpha")}}
            server._launch_home = lambda: home
            server.register_live_transport = server.unregister_live_transport = lambda _: None

            def dispatch(request, transport=None):
                calls.append(request["method"])
                return {"jsonrpc": "2.0", "id": request["id"], "result": {"sessions": []}}

            server.dispatch = dispatch
            transport = types.ModuleType("tui_gateway.transport")
            transport.FanoutTransport = Fanout
            transport.bind_transport = lambda _: None
            transport.reset_transport = lambda _: None
            package = types.ModuleType("tui_gateway")
            package.server, package.transport = server, transport
            constants = types.ModuleType("hermes_constants")
            constants.profile_name_for_home = lambda p: "default" if Path(p) == home else Path(p).name
            modules = {"tui_gateway": package, "tui_gateway.server": server,
                       "tui_gateway.transport": transport, "hermes_constants": constants}
            with patch.dict("sys.modules", modules), patch.object(instance, "_persist", side_effect=ready.set):
                worker = threading.Thread(target=instance.start_control, args=(stop,), daemon=True)
                worker.start()
                try:
                    self.assertTrue(ready.wait(2))

                    def connect():
                        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                            client.settimeout(2)
                            client.connect(instance.control_socket)
                            client.sendall(b'{"jsonrpc":"2.0","id":"list","method":"session.list","params":{}}\n')
                            frames = []
                            with client.makefile("rb") as incoming:
                                while True:
                                    frame = json.loads(incoming.readline())
                                    if frame.get("id") == "list":
                                        return frames
                                    frames.append(frame)

                    initial = connect()
                    # a masked prompt is restored like an approval: its prompt params only, never a value
                    self.assertEqual([r["id"] for r in initial], ["approve", "question", "secret"])
                    self.assertEqual([r["params"]["profile_name"] for r in initial], ["default", "alpha", "default"])
                    self.assertEqual([r["request_created_at"] for r in initial], [r.created_at for r in rows[:3]])
                    self.assertEqual(initial[2]["params"], {"session_id": "s-a", "profile_name": "default",
                                                            "origin": "https://login.example.com",
                                                            "site": "login.example.com"})
                    self.assertEqual(connect(), initial, "reconnect preserves identity and creation time")
                    with requests._lock:
                        del requests._open["approve"]
                        del requests._open["secret"]
                    self.assertEqual([r["id"] for r in connect()], ["question"], "answered requests stay gone")
                    self.assertEqual(calls, ["session.list"] * 3, "no resume, answer or command is replayed")
                    # A native cancellation follows the session's old transport, not global broadcasts.
                    old_frames = []
                    old_owner = types.SimpleNamespace(write=lambda frame: old_frames.append(frame))
                    server._sessions["s-b"]["transport"] = old_owner
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                        client.settimeout(3)
                        client.connect(instance.control_socket)
                        client.sendall(b'{"jsonrpc":"2.0","id":"list","method":"session.list","params":{}}\n')
                        with client.makefile("rb") as incoming:
                            restored = json.loads(incoming.readline())
                            self.assertEqual(restored["id"], "question")
                            self.assertEqual(json.loads(incoming.readline())["id"], "list")
                            with requests._lock:
                                del requests._open["question"]
                            old_owner.write({"jsonrpc": "2.0", "method": "event", "params": {
                                "type": "request.cancel", "session_id": "s-b", "payload": {"id": "question"}}})
                            withdrawal = json.loads(incoming.readline())
                            self.assertEqual(withdrawal["params"]["type"], "request.cancel")
                            self.assertEqual(withdrawal["params"]["payload"]["id"], "question")
                            self.assertEqual(withdrawal["params"]["profile_name"], "alpha")
                            self.assertIs(server._sessions["s-b"]["transport"], old_owner)
                            self.assertEqual(len(old_frames), 1)
                finally:
                    stop.set()
                    worker.join(3)
                self.assertFalse(worker.is_alive())


class RequestCardsTests(unittest.TestCase):
    """observer.RequestCards: one connection sees each request arrive once and leave once, whichever of Hermes'
    session transport, the reconnect restore or the live hub delivers it first."""

    def setUp(self):
        self.home = Path("/home/u/.hermes")  # only handed to the fake profile_name_for_home
        self.requests = types.SimpleNamespace(_lock=threading.Lock(), _open={})
        self.server = types.SimpleNamespace(_server_requests=self.requests, _sessions={"s-a": {"profile_home": str(self.home)}},
                                            _launch_home=lambda: self.home)
        constants = types.ModuleType("hermes_constants")
        constants.profile_name_for_home = lambda p: "default"
        patcher = patch.dict("sys.modules", {"hermes_constants": constants})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.sent = []
        self.cards = observer.RequestCards(self.sent.append, threading.Lock(), self.server)
        self.req = Request("srq-1", "s-a", "clarify", {"questions": [{"qid": "q1", "question": "Test?"}]})
        self.requests._open["srq-1"] = self.req

    def sweep(self, settling=lambda rid: False):
        with self.requests._lock:
            fresh = [(r, r.frame()) for r in self.requests._open.values()]
        self.cards.sync(fresh, settling)

    def hermes(self, frame):
        frame = observer.request_arrival_reply(frame, self.server)
        with self.cards.lock:
            send, _ = self.cards.admit(frame)
        if send:
            self.sent.append(frame)

    def cancel(self, reason):
        return {"jsonrpc": "2.0", "method": "event", "params": {"type": "request.cancel", "session_id": "s-a",
                                                                "payload": {"id": "srq-1", "method": "clarify", "reason": reason}}}

    def kinds(self):
        return [f.get("method") if f.get("method") != "event" else f["params"]["payload"]["reason"] for f in self.sent]

    def test_a_connection_that_did_not_list_sessions_gets_nothing_from_the_hub(self):
        self.sweep()
        self.assertEqual(self.sent, [])

    def test_hub_first_then_hermes_frame_and_cancel_are_not_repeated(self):
        self.cards.subscribed = True
        self.sweep()
        self.sweep()
        self.hermes(self.req.frame())  # Hermes' own write to the session transport lands later
        del self.requests._open["srq-1"]
        self.sweep()                   # the hub notices first
        self.hermes(self.cancel("timeout"))
        self.assertEqual(self.kinds(), ["clarify", "expired"])
        self.assertEqual(self.sent[0]["params"]["profile_name"], "default")
        self.assertEqual(self.sent[1]["params"]["profile_name"], "default")

    def test_hermes_first_then_the_hub_stays_quiet_and_the_answer_withdraws_once(self):
        self.cards.subscribed = True
        self.hermes(self.req.frame())
        self.sweep()
        del self.requests._open["srq-1"]
        self.sweep(settling=lambda rid: rid == "srq-1")  # an answer is settling: not "expired"
        self.cards.withdraw("srq-1", "answered")
        self.hermes(self.cancel("answered"))              # Hermes-routed withdraw_answered arrives too
        self.sweep()
        self.assertEqual(self.kinds(), ["clarify", "answered"])

    def test_an_unstamped_request_is_never_offered(self):
        self.cards.subscribed = True
        self.requests._open = {"srq-2": Request("srq-2", "missing", "approval", {}),
                               "srq-3": Request("srq-3", "missing", "sudo", {"command": "apt-get update"})}
        with self.requests._lock:
            fresh = [(r, r.frame()) for r in self.requests._open.values() if r.method in observer.REQUEST_KINDS]
        self.cards.sync(fresh, lambda rid: False)
        self.assertEqual(self.sent, [])

    def test_every_masked_prompt_is_offered_once_and_withdrawn_once(self):
        # sudo, secret and the three vault prompts are cards like approvals: one arrival, one withdrawal
        self.cards.subscribed = True
        prompts = {"sudo": {"command": "apt-get update"}, "secret": {"env_var": "ATLAS_KEY", "prompt": "Key"},
                   "vault.unlock_prompt": {"backend": "bitwarden", "display_name": "Bitwarden"},
                   "vault.save_login": {"origin": "https://login.example.com", "site": "login.example.com"},
                   "vault.code": {"site": "login.example.com", "hint": None}}
        self.assertEqual(observer.SECRET_REQUEST_KINDS, frozenset(prompts))
        self.assertLessEqual(observer.SECRET_REQUEST_KINDS, observer.REQUEST_KINDS)
        self.requests._open = {f"srq-{m}": Request(f"srq-{m}", "s-a", m, p) for m, p in prompts.items()}
        self.sweep()
        self.sweep()
        self.assertEqual([(f["method"], f["params"]) for f in self.sent],
                         [(m, {"session_id": "s-a", "profile_name": "default", **p}) for m, p in prompts.items()])
        for rid in list(self.requests._open):
            self.cards.withdraw(rid, "answered")
        self.requests._open = {}
        self.sweep()
        self.assertEqual(self.kinds(), [*prompts, *["answered"] * len(prompts)])


if __name__ == "__main__":
    unittest.main()
