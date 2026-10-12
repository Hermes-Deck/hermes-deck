"""Headless deck.attach_staged: files the relay staged on this host's disk; no desktop, gateway, relay or network."""
import base64
import errno
import importlib.util
import json
import os
import re
import shutil
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock

import observer
import stream
from observer import attach_staged
from testsupport import unittest_main

PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 64
RAR = b"Rar!\x1a\x07\x01\x00" + b"r" * 200
VECTOR = ("0123456789abcdef0123456789abcdef", "/srv/example/uploads", "c2d55d62e4ea5400")  # relay/test/uploads.test.js


def quote(value):
    """Hermes' _format_ref_value (tui_gateway/prompt_attachments.py)."""
    if not value or not re.search(r"""[\s()\[\]{}<>"'`]""", value):
        return value
    for q in ("`", '"', "'"):
        if q not in value:
            return f"{q}{value}{q}"
    return value


def fake_server(sessions, built=None):
    """The four Hermes helpers and the session lookup, with Hermes' semantics, on a plain namespace."""
    def sess_building(params, rid):
        sid = params.get("session_id")
        if sid not in sessions:
            return None, {"jsonrpc": "2.0", "id": rid, "error": {"code": 4001, "message": "session not found"}}
        if built is not None:
            built.append(sid)
        return sessions[sid], None

    def ref_path(session, target):
        try:
            return str(Path(target).resolve().relative_to(Path(session["cwd"]).resolve())).replace(os.sep, "/")
        except ValueError:
            return str(Path(target).resolve())

    def sanitize(name):
        candidate = re.sub(r"[\x00-\x1f]+", "_", Path(str(name or "").strip()).name)
        return candidate.strip().strip(".") or "attachment"

    return types.SimpleNamespace(_sess_building=sess_building, _session_home_dir=lambda s, n: Path(s["profile_home"]) / n,
                                 _attachment_ref_path=ref_path, _format_ref_value=quote, _sanitize_attachment_name=sanitize)


class StagedBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="deck-staged-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.spool, self.home, self.ws = self.tmp / "spool", self.tmp / "home", self.tmp / "ws"
        for d in (self.spool, self.home, self.ws):
            d.mkdir(mode=0o700)
        self.session = {"profile_home": str(self.home), "cwd": str(self.ws)}
        self.built = []
        self.server = fake_server({"rpc-example": self.session}, self.built)

    def stage(self, data=b"hello", size=None, meta=None, sparse=None):
        upload = os.urandom(24).hex()
        binary = self.spool / f"{upload}.bin"
        if sparse is not None:
            with open(binary, "wb") as f:
                f.write(data)
                f.truncate(sparse)
            length = sparse
        else:
            binary.write_bytes(data)
            length = len(data)
        binary.chmod(0o600)
        record = {"v": 1, "id": upload, "name": "x", "mime": "application/octet-stream", "size": length if size is None else size,
                  "created": int(time.time() * 1000), "expires": int(time.time() * 1000) + 3600_000}
        record.update(meta or {})
        (self.spool / f"{upload}.json").write_text(json.dumps(record))
        return upload

    def request(self, files, text="Look at these", **changes):
        params = dict(session_id="rpc-example", text=text, files=files)
        params.update(changes)
        return dict(jsonrpc="2.0", id="example-1", method="deck.attach_staged", params=params)

    def run_staged(self, request, fail=None, server=None):
        calls, counter = [], [0]

        def dispatch(req, transport=None):
            calls.append(req)
            method = req["method"]
            if method == fail:
                return dict(jsonrpc="2.0", id=req["id"], error={"message": "Rejected"})
            counter[0] += 1
            if method == "image.attach_bytes":
                result = {"attached": True, "path": f"/srv/example/queued-{counter[0]}.png"}
            elif method == "file.attach":
                result = {"attached": True, "name": req["params"]["name"], "ref_text": f"@file:uploads/{req['params']['name']}"}
            elif method == "image.detach":
                result = {"detached": True}
            else:
                result = {"status": "streaming"}
            return dict(jsonrpc="2.0", id=req["id"], result=result)
        reply = attach_staged(request, dispatch, None, server=self.server if server is None else server, spool=self.spool)
        return reply, calls

    def attachments(self):
        root = self.home / "attachments"
        return sorted(p.name for p in root.iterdir()) if root.is_dir() else []


class AttachStagedTests(StagedBase):
    def test_exact_keys_bad_ids_and_names_are_refused_before_anything_is_touched(self):
        good = self.stage()
        ok = dict(upload=good, filename="a.txt")
        bad = [
            self.request([ok], path="/etc/passwd"), self.request([ok], session_id=""), self.request([ok], session_id="a b"),
            self.request([ok], text=5), self.request([ok], text="x" * 32001), self.request([]), self.request("x"),
            self.request([ok] * 11), self.request([ok, ok]),  # duplicate id
            self.request([dict(upload=good.upper(), filename="a.txt")]), self.request([dict(upload=good[:-1], filename="a.txt")]),
            self.request([dict(upload="../" + good[3:], filename="a.txt")]), self.request([dict(upload=5, filename="a.txt")]),
            self.request([dict(upload=good, filename="../a.txt")]), self.request([dict(upload=good, filename="dir/a.txt")]),
            self.request([dict(upload=good, filename="a\x00.txt")]), self.request([dict(upload=good, filename="...")]),
            self.request([dict(upload=good, filename="x" * 161)]), self.request([dict(upload=good)]),
            self.request([dict(upload=good, filename="a.txt", path="/etc/passwd")]),
            self.request([dict(upload=good, filename="a.txt", content_base64="eA==")]),
        ]
        for request in bad:
            reply, calls = self.run_staged(request)
            self.assertIn("error", reply, request["params"])
            self.assertEqual(calls, [])
        self.assertEqual(sorted(p.name for p in self.spool.iterdir()), sorted([f"{good}.bin", f"{good}.json"]))
        self.assertEqual(self.built, [])

    def test_symlinks_in_the_spool_are_refused(self):
        outside = self.tmp / "secret.txt"
        outside.write_text("private")
        upload = self.stage()
        (self.spool / f"{upload}.bin").unlink()
        (self.spool / f"{upload}.bin").symlink_to(outside)
        reply, calls = self.run_staged(self.request([dict(upload=upload, filename="a.txt")]))
        self.assertIn("not a regular file", reply["error"]["message"])
        self.assertEqual(calls, [])
        self.assertEqual(outside.read_text(), "private")
        meta_link = self.stage()
        real_meta = self.tmp / "meta.json"
        (self.spool / f"{meta_link}.json").rename(real_meta)
        (self.spool / f"{meta_link}.json").symlink_to(real_meta)
        reply, calls = self.run_staged(self.request([dict(upload=meta_link, filename="a.txt")]))
        self.assertIn("error", reply)
        self.assertEqual(calls, [])
        directory = self.stage()
        (self.spool / f"{directory}.bin").unlink()
        (self.spool / f"{directory}.bin").mkdir()
        reply, _ = self.run_staged(self.request([dict(upload=directory, filename="a.txt")]))
        self.assertIn("error", reply)

    def test_size_mismatch_missing_meta_and_expired_uploads_are_refused(self):
        cases = {
            "mismatch": (self.stage(b"hello", size=6), "size does not match"),
            "expired": (self.stage(meta={"expires": 1}), "expired"),
            "bad meta": (self.stage(meta={"v": 2}), "Invalid upload"),
            "other id": (self.stage(meta={"id": "f" * 48}), "Invalid upload"),
        }
        missing = self.stage()
        (self.spool / f"{missing}.json").unlink()
        cases["missing"] = (missing, "missing")
        for label, (upload, message) in cases.items():
            reply, calls = self.run_staged(self.request([dict(upload=upload, filename="a.txt")]))
            self.assertIn(message, reply["error"]["message"], label)
            self.assertEqual(calls, [], label)
        self.assertEqual(self.attachments(), [])

    def test_a_small_image_goes_to_image_attach_bytes_and_leaves_the_spool(self):
        upload = self.stage(PNG)
        reply, calls = self.run_staged(self.request([dict(upload=upload, filename="shot.txt")]))
        self.assertEqual([c["method"] for c in calls], ["image.attach_bytes", "prompt.submit"])
        self.assertEqual(calls[0]["params"], {"session_id": "rpc-example", "content_base64": base64.b64encode(PNG).decode(), "filename": "shot.png"})
        self.assertEqual(calls[1]["params"], {"session_id": "rpc-example", "text": "Look at these"})
        self.assertEqual(reply["result"], {"status": "streaming"})
        self.assertEqual(list(self.spool.iterdir()), [])
        self.assertEqual(self.attachments(), [])

    def test_a_big_image_is_moved_like_any_file(self):
        upload = self.stage(PNG)
        with mock.patch.object(observer, "STAGED_IMAGE_MAX", 16):
            reply, calls = self.run_staged(self.request([dict(upload=upload, filename="huge.png")]))
        self.assertEqual([c["method"] for c in calls], ["prompt.submit"])
        self.assertEqual(self.attachments(), ["huge.png"])
        self.assertIn("@file:" + str((self.home / "attachments" / "huge.png").resolve()), calls[0]["params"]["text"])
        self.assertEqual(reply["result"], {"status": "streaming"})

    def test_a_file_is_moved_not_copied_and_its_ref_enters_the_prompt(self):
        upload = self.stage(RAR)
        inode = (self.spool / f"{upload}.bin").stat().st_ino
        name = "Example Game 0.42.0 WEB.rar"
        reply, calls = self.run_staged(self.request([dict(upload=upload, filename=name)], text="  "))
        target = (self.home / "attachments" / name).resolve()
        self.assertEqual(target.read_bytes(), RAR)
        self.assertEqual(target.stat().st_ino, inode, "renamed, not copied")
        self.assertEqual([c["method"] for c in calls], ["prompt.submit"])
        self.assertEqual(calls[0]["params"]["text"], f"{observer.ATTACH_DEFAULT_TEXT}\n\n@file:`{target}`")
        self.assertEqual(list(self.spool.iterdir()), [], "consumed: .bin and .json are gone")
        self.assertEqual(self.built, ["rpc-example"], "the session is looked up like Hermes' attach methods do")
        self.assertNotIn(str(self.spool), json.dumps(reply))

    def test_a_ref_inside_the_workspace_is_workspace_relative(self):
        self.session["cwd"] = str(self.home)
        upload = self.stage(b"notes")
        _, calls = self.run_staged(self.request([dict(upload=upload, filename="notes.txt")]))
        self.assertEqual(calls[0]["params"]["text"], "Look at these\n\n@file:attachments/notes.txt")

    def test_cross_filesystem_moves_copy_in_chunks_then_drop_the_spool_copy(self):
        payload = os.urandom(3 * observer._COPY_CHUNK + 17)
        upload = self.stage(payload)
        real_rename = os.rename

        def exdev(src, dst, *a, **k):
            if str(src).startswith(str(self.spool)):
                raise OSError(errno.EXDEV, "Invalid cross-device link")
            return real_rename(src, dst, *a, **k)
        with mock.patch.object(observer.os, "rename", exdev), mock.patch.object(observer.os, "fsync", wraps=os.fsync) as fsync:
            reply, calls = self.run_staged(self.request([dict(upload=upload, filename="data.bin")]))
        self.assertEqual(reply["result"], {"status": "streaming"})
        self.assertEqual((self.home / "attachments" / "data.bin").read_bytes(), payload)
        self.assertTrue(fsync.called)
        self.assertEqual(list(self.spool.iterdir()), [])

    def test_names_never_overwrite_hermes_naming_name_2_name_3(self):
        (self.home / "attachments").mkdir()
        (self.home / "attachments" / "a.txt").write_text("earlier")
        first, second = self.stage(b"one"), self.stage(b"two")
        _, calls = self.run_staged(self.request([dict(upload=first, filename="a.txt"), dict(upload=second, filename="a.txt")]))
        self.assertEqual(self.attachments(), ["a-2.txt", "a-3.txt", "a.txt"])
        self.assertEqual((self.home / "attachments" / "a.txt").read_text(), "earlier")
        self.assertEqual((self.home / "attachments" / "a-3.txt").read_text(), "two")
        self.assertTrue(calls[-1]["params"]["text"].endswith("a-2.txt\n@file:" + str((self.home / "attachments" / "a-3.txt").resolve())))

    def test_a_rejected_submit_detaches_queued_images_and_moved_files_stay(self):
        image, archive = self.stage(PNG), self.stage(RAR)
        reply, calls = self.run_staged(self.request([dict(upload=image, filename="a.png"), dict(upload=archive, filename="b.rar")]), fail="prompt.submit")
        self.assertIn("error", reply)
        self.assertEqual([c["method"] for c in calls], ["image.attach_bytes", "prompt.submit", "image.detach"])
        self.assertEqual(calls[-1]["params"], {"session_id": "rpc-example", "path": "/srv/example/queued-1.png"})
        self.assertEqual(self.attachments(), ["b.rar"])
        self.assertEqual(list(self.spool.iterdir()), [])

    def test_a_failed_image_detaches_earlier_ones_and_leaves_later_uploads_in_the_spool(self):
        first, second, later = self.stage(PNG), self.stage(PNG), self.stage(RAR)
        seen = []

        def dispatch(req, transport=None):
            seen.append(req["method"])
            if req["method"] == "image.attach_bytes" and seen.count("image.attach_bytes") == 2:
                return dict(jsonrpc="2.0", id=req["id"], error={"message": "Rejected"})
            return dict(jsonrpc="2.0", id=req["id"], result={"attached": True, "path": "/srv/example/one.png"})
        files = [dict(upload=first, filename="a.png"), dict(upload=second, filename="b.png"), dict(upload=later, filename="c.rar")]
        reply = attach_staged(self.request(files), dispatch, None, server=self.server, spool=self.spool)
        self.assertIn("error", reply)
        self.assertEqual(seen, ["image.attach_bytes", "image.attach_bytes", "image.detach"])
        self.assertTrue((self.spool / f"{later}.bin").exists(), "not consumed: the Deck deletes it through the relay")
        self.assertTrue((self.spool / f"{second}.bin").exists())

    def test_an_unknown_session_touches_nothing(self):
        upload = self.stage(RAR)
        reply, calls = self.run_staged(self.request([dict(upload=upload, filename="b.rar")], session_id="rpc-gone"))
        self.assertEqual(reply["error"], {"code": 4001, "message": "session not found"})  # bridge.js resumes and retries
        self.assertEqual(calls, [])
        self.assertTrue((self.spool / f"{upload}.bin").exists())
        self.assertEqual(self.attachments(), [])

    def test_older_hermes_without_the_helpers_uses_native_methods_up_to_25_mb(self):
        old = types.SimpleNamespace()
        image, notes = self.stage(PNG), self.stage(b"hello")
        reply, calls = self.run_staged(self.request([dict(upload=image, filename="a.png"), dict(upload=notes, filename="n.txt")]), server=old)
        self.assertEqual([c["method"] for c in calls], ["image.attach_bytes", "file.attach", "prompt.submit"])
        self.assertEqual(calls[1]["params"], {"session_id": "rpc-example", "name": "n.txt", "data_url": "data:application/octet-stream;base64," + base64.b64encode(b"hello").decode()})
        self.assertEqual(calls[2]["params"]["text"], "Look at these\n\n@file:uploads/n.txt")
        self.assertEqual(list(self.spool.iterdir()), [])
        big = self.stage(b"x" * 40)
        with mock.patch.object(observer, "ATTACH_FILE_MAX", 32):
            reply, calls = self.run_staged(self.request([dict(upload=big, filename="big.bin")]), server=old)
        self.assertIn("25 MB", reply["error"]["message"])
        self.assertEqual(calls, [])
        self.assertTrue((self.spool / f"{big}.bin").exists())

    def test_a_sparse_large_file_is_moved_without_reading_it(self):
        upload = self.stage(b"Rar!", sparse=3 * 1024 ** 3)  # 3 GiB apparent size, no data blocks
        with mock.patch.object(observer, "_read_all", side_effect=AssertionError("must not read a big file")):
            reply, calls = self.run_staged(self.request([dict(upload=upload, filename="big.rar")]))
        self.assertEqual(reply["result"], {"status": "streaming"})
        self.assertEqual((self.home / "attachments" / "big.rar").stat().st_size, 3 * 1024 ** 3)


HERMES = importlib.util.find_spec("tui_gateway") is not None


@unittest.skipUnless(HERMES, "Hermes (tui_gateway) is not importable here")
class RealHermesHelpersTests(StagedBase):
    """The helpers Hermes itself uses, published onto a stand-in server the way server.py does (bind_module)."""

    def hermes_server(self, sessions):
        from tui_gateway import prompt_attachments
        server = types.ModuleType("deck_test_server")
        server.Path, server.os = Path, os
        server._hermes_home = self.home
        server._session_cwd = lambda session: session["cwd"]
        server._cwd_is_remote = lambda home: False
        prompt_attachments.register(server)  # bind_module(globals(), server, skip=("_",)): underscore helpers included
        server._sess_building = lambda params, rid: (sessions[params["session_id"]], None)
        return server

    def test_the_ref_is_built_exactly_like_file_attach(self):
        server = self.hermes_server({"rpc-example": self.session})
        self.assertIsNotNone(observer.staged_helpers(server))
        upload = self.stage(RAR)
        _, calls = self.run_staged(self.request([dict(upload=upload, filename="My Game.rar")]), server=server)
        target = self.home / "attachments" / "My Game.rar"
        expected = "@file:" + server._format_ref_value(server._attachment_ref_path(self.session, target))
        self.assertEqual(calls[0]["params"]["text"], "Look at these\n\n" + expected)
        self.assertEqual(target.read_bytes(), RAR)


class HostIdAndVersionTests(unittest.TestCase):
    def test_shared_test_vector_with_the_relay(self):
        machine, directory, expected = VECTOR
        self.assertEqual(observer.upload_host_id(machine, directory), expected)
        self.assertEqual(stream.upload_host_id(machine, directory), expected)

    def test_machine_id_sources_and_spool_folder(self):
        files = {"/etc/machine-id": " \n", "/var/lib/dbus/machine-id": "dbus\n"}

        def read(name):
            if name not in files:
                raise OSError(errno.ENOENT, name)
            return files[name]
        for module in (observer, stream):
            self.assertEqual(module.machine_id(read, lambda: "host"), "dbus")
            self.assertEqual(module.machine_id(lambda name: (_ for _ in ()).throw(OSError()), lambda: "host"), "host")
            self.assertEqual(module.upload_dir({"HERMES_DECK_UPLOAD_DIR": "/srv/example/spool"}), Path("/srv/example/spool"))
            self.assertEqual(module.upload_dir({}), Path.home() / ".hermes-deck" / "uploads")
        tmp = Path(tempfile.mkdtemp(prefix="deck-host-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        (tmp / "real").mkdir()
        (tmp / "link").symlink_to(tmp / "real")
        host = stream.upload_host(tmp / "link" / "spool", machine="m")
        self.assertEqual(host, observer.upload_host(tmp / "real" / "spool", machine="m"))
        self.assertEqual(host, observer.upload_host_id("m", os.path.realpath(tmp / "real" / "spool")))
        self.assertEqual(oct((tmp / "real" / "spool").stat().st_mode & 0o777), "0o700")

    def test_deck_version_names_the_spool_only_when_the_live_gateway_serves_staged_files(self):
        tmp = Path(tempfile.mkdtemp(prefix="deck-version-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        home, spool = tmp / "home", tmp / "spool"
        base = home / "hermes-deck"
        (base / "processes").mkdir(parents=True)
        sock = base / f"control-{os.getpid()}-abcd1234.sock"
        sock.write_text("")
        record = {"schema": stream.SCHEMA, "pid": os.getpid(), "updated_at": time.time(), "control_socket": str(sock), "nodes": {}}
        process = base / "processes" / f"{os.getpid()}.json"
        with mock.patch.dict(os.environ, {"HERMES_DECK_UPLOAD_DIR": str(spool)}):
            self.assertEqual(stream.version_reply(home), {"version": stream.VERSION, "protocol": stream.PROTOCOL})
            process.write_text(json.dumps(record))  # an observer from before this feature (gateway not restarted yet)
            self.assertNotIn("uploads", stream.version_reply(home))
            process.write_text(json.dumps(dict(record, features=list(observer.FEATURES))))
            reply = stream.version_reply(home)
            self.assertEqual(reply["uploads"], {"v": 1, "host": stream.upload_host(spool)})
            self.assertRegex(reply["uploads"]["host"], r"^[a-f0-9]{16}$")
        self.assertIn("attach_staged", observer.Observer(tmp / "obs").snapshot()["features"])

    def test_deadlines_and_names_agree_across_stream_observer_and_bridge(self):
        self.assertEqual(stream.STAGED_METHOD, observer.STAGED_METHOD)
        self.assertEqual(stream.DEADLINES[stream.STAGED_METHOD], observer.STAGED_TIMEOUT)
        self.assertEqual(stream.UPLOAD_DIR_ENV, observer.UPLOAD_DIR_ENV)
        self.assertEqual(stream.STAGED_FEATURE, observer.FEATURES[0])
        self.assertNotIn(observer.STAGED_METHOD, observer.ALLOWED_METHODS)  # served natively, never forwarded as-is
        self.assertEqual(observer.request_limit(observer.STAGED_METHOD), observer.SMALL_LINE_MAX)
        bridge = Path(__file__).resolve().parents[2] / "app" / "main" / "bridge.js"
        if bridge.is_file():
            text = bridge.read_text(encoding="utf-8")
            self.assertIn(f"staged: {observer.STAGED_TIMEOUT * 1000},", text)
            self.assertIn('"deck.attach_staged"', text)


if __name__ == "__main__":
    unittest_main()
