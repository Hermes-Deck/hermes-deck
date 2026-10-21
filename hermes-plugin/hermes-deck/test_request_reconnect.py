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
                    Request("secret", "s-a", "secret", {"name": "never replay"}),
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
                    self.assertEqual([r["id"] for r in initial], ["approve", "question"])
                    self.assertEqual([r["params"]["profile_name"] for r in initial], ["default", "alpha"])
                    self.assertEqual([r["request_created_at"] for r in initial], [r.created_at for r in rows[:2]])
                    self.assertEqual(connect(), initial, "reconnect preserves identity and creation time")
                    with requests._lock:
                        del requests._open["approve"]
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


if __name__ == "__main__":
    unittest.main()
