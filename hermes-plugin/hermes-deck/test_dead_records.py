"""hermes-deck: dead process records (R7). An exiting observer removes its own record, activity file and control
socket; a starting one removes what dead processes left in its base; stream.py skips dead pids without opening
their files and parses an unchanged record once.

Run with any Python 3.10+ (no Hermes, no network):  python -m unittest test_dead_records
"""
import importlib.util
import json
import os
import socket
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from testsupport import unittest_main

HERE = Path(__file__).resolve().parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


observer = load("hermes_deck_observer_dead_records", "observer.py")
stream = load("hermes_deck_stream_dead_records", "stream.py")


class DeadRecords(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="dr-", dir="/tmp")   # short: AF_UNIX paths are length-limited
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.base = self.home / "hermes-deck"
        (self.base / "processes").mkdir(parents=True)
        stream._record_cache.clear()

    def write_record(self, pid, updated=None, base=None):
        base = base or self.base
        sock = base / f"control-{pid}-{pid % 0xffffffff:08x}.sock"
        sock.touch()
        (base / "processes" / f"{pid}.json").write_text(json.dumps(dict(
            schema=stream.SCHEMA, pid=pid, updated_at=time.time() if updated is None else updated,
            control_socket=str(sock), nodes={f"s{pid}": {"session_id": f"s{pid}", "state": "idle"}})))
        (base / "processes" / f"{pid}{observer.ACTIVITY_SUFFIX}").write_text("{}")
        return sock

    def test_stream_skips_500_dead_records_without_opening_them_and_parses_a_live_one_once(self):
        live = 4_000_000
        for pid in range(1_000_000, 1_000_500):
            self.write_record(pid)
        self.write_record(live)
        alive = lambda pid: int(pid) == live
        opened = []
        real = Path.read_text

        def counting(path, *a, **k):
            opened.append(path.name)
            return real(path, *a, **k)

        with patch.object(Path, "read_text", counting):
            first = stream.collect_nodes(self.base / "processes", alive=alive)
            second = stream.collect_nodes(self.base / "processes", alive=alive)
        self.assertEqual([n["session_id"] for n in first], [f"s{live}"])
        self.assertEqual([n["session_id"] for n in second], [f"s{live}"])
        self.assertEqual(opened, [f"{live}.json"])          # dead ones never opened, the live one parsed once
        rec = self.base / "processes" / f"{live}.json"
        data = json.loads(rec.read_text())
        data["nodes"] = {"s-new": {"session_id": "s-new", "state": "working"}}
        rec.write_text(json.dumps(data) + " ")                # a change (size differs) is read again
        self.assertEqual([n["session_id"] for n in stream.collect_nodes(self.base / "processes", alive=alive)], ["s-new"])

    def test_a_starting_observer_sweeps_dead_records_and_sockets_of_its_own_base_only(self):
        dead = [self.write_record(pid) for pid in range(1_000_000, 1_000_500)]
        live_sock = self.write_record(4_000_000)
        old_live = self.write_record(4_000_001, updated=0)
        for name in ("4000001.json", "4000001" + observer.ACTIVITY_SUFFIX):  # a reused pid: untouched for hours
            os.utime(self.base / "processes" / name, (0, 0))
        other = self.home / "profiles/ada/hermes-deck"
        (other / "processes").mkdir(parents=True)
        foreign = self.write_record(1_000_000, base=other)          # another base: not ours to clean
        (self.base / "processes" / "notes.txt").write_text("keep")
        (self.base / "control-12-zz.sock").touch()                   # not a name this plugin writes
        alive = lambda pid: pid in (4_000_000, 4_000_001)
        removed = observer.sweep_dead(self.base, alive=alive)
        self.assertEqual(removed, 500 * 3 + 2)                      # record + activity + socket each, and 4000001's two files
        self.assertFalse(any(s.exists() for s in dead))
        self.assertEqual(sorted(p.name for p in (self.base / "processes").iterdir()),
                         ["4000000.activity", "4000000.json", "notes.txt"])
        self.assertTrue(live_sock.exists() and old_live.exists())     # a live pid's socket is never touched
        self.assertTrue(foreign.exists() and (other / "processes/1000000.json").exists())
        self.assertTrue((self.base / "control-12-zz.sock").exists())
        self.assertEqual(observer.sweep_dead(self.home / "missing"), 0)

    def test_sweep_leaves_symlinks_and_directories_alone(self):
        target = self.home / "elsewhere.json"
        target.write_text("{}")
        (self.base / "processes" / "1000001.json").symlink_to(target)
        (self.base / "processes" / "1000002.json").mkdir()
        self.assertEqual(observer.sweep_dead(self.base, alive=lambda pid: False), 0)
        self.assertTrue(target.exists())

    @unittest.skipUnless(hasattr(socket, "AF_UNIX"), "private control socket requires AF_UNIX")
    def test_an_exiting_observer_removes_its_record_activity_and_socket_and_never_rewrites_them(self):
        instance = observer.Observer(self.base / "processes")
        instance.control_socket = str(self.base / f"control-{instance.pid}-0000abcd.sock")
        Path(instance.control_socket).touch()
        instance._persist()
        (self.base / "processes" / f"{instance.pid}{observer.ACTIVITY_SUFFIX}").write_text("{}")
        record = self.base / "processes" / f"{instance.pid}.json"
        self.assertTrue(record.exists())
        instance.retire()
        instance.retire()                                           # twice is harmless
        self.assertEqual(list((self.base / "processes").iterdir()), [])
        self.assertFalse(Path(instance.control_socket).exists())
        instance._persist()                                          # a late snapshot tick
        self.assertFalse(record.exists())

    def test_start_sweeps_and_unload_retires(self):
        self.write_record(1_000_000)
        hooks = []
        with patch.object(observer, "_pid_alive", side_effect=lambda pid: pid == os.getpid()), \
                patch.object(observer.Observer, "start_control", lambda self, stop: None), \
                patch("atexit.register"):
            instance = observer.start(self.base, on_unload=hooks.append)
        self.assertFalse((self.base / "processes" / "1000000.json").exists())
        own = self.base / "processes" / f"{instance.pid}.json"
        self.assertTrue(own.exists())
        hooks[0]()
        self.assertTrue(instance.stop.is_set())
        self.assertFalse(own.exists())


if __name__ == "__main__":
    unittest_main()
