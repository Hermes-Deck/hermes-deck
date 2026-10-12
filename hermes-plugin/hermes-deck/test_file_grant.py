"""deck.file_grant: large downloads through the relay. The grant runs deck.file_read's own authorization
(FileReader.authorize) and writes a short-lived ticket <spool>/downloads/<id>.json the relay streams from. No Hermes,
no relay, no network: the transcript store and the Hermes homes are fakes, the spool is a temp folder.

Run with any Python 3.10+:  python test_file_grant.py
"""
import json
import os
import re
import shutil
import stat
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import observer
import stream
from testsupport import unittest_main

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


class GrantBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="deck-grant-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.home = self.tmp / "hermes-home"
        (self.home / "profiles" / "bot-a").mkdir(parents=True)
        self.work = self.tmp / "work"
        self.work.mkdir()
        self.spool = self.tmp / "spool"
        self.report = self.work / "report.bin"
        self.report.write_bytes(os.urandom(4096))
        self.transcript = [{"id": 1, "role": "user", "content": "build it"},
                           {"id": 2, "role": "assistant", "content": f"Done. MEDIA:{self.report}"}]
        self.pages = []
        self.now = [1_700_000_000_000]
        self.reader = self.make()

    def make(self, **kw):
        kw.setdefault("stream_max", None)
        return observer.FileReader(load_messages=self.load, roots=[self.home], spool=self.spool,
                                   wall_ms=lambda: self.now[0], **kw)

    def load(self, profile, sid, limit, offset):
        self.pages.append((profile, sid, limit, offset))
        if sid == "gone":
            return None
        return self.transcript[::-1][offset:offset + limit]

    def offer(self, path, role="assistant", text=None):
        self.transcript = [{"id": 2, "role": role, "content": text if text is not None else f"MEDIA:{path}"}]

    def grant(self, path=None, reader=None, **extra):
        return (reader or self.reader).grant({"session_id": "s-1", "path": str(path or self.report), **extra})

    def refused(self, code, path=None, reader=None, **extra):
        with self.assertRaises(observer.FileError) as caught:
            self.grant(path, reader, **extra)
        self.assertEqual(caught.exception.code, code, caught.exception.message)
        return caught.exception

    def tickets(self):
        folder = self.spool / "downloads"
        return sorted(p.name for p in folder.iterdir()) if folder.is_dir() else []

    def ticket(self, ticket_id):
        return json.loads((self.spool / "downloads" / f"{ticket_id}.json").read_text())


class GrantTicketTests(GrantBase):
    def test_an_agent_offered_file_gets_a_private_ticket_with_its_pin(self):
        reply = self.grant()
        self.assertEqual(set(reply), {"id", "name", "size", "mtime"})
        self.assertRegex(reply["id"], r"^[a-f0-9]{48}$")
        self.assertEqual((reply["name"], reply["size"]), ("report.bin", 4096))
        self.assertNotIn(str(self.tmp), json.dumps(reply), "the reply never carries a host path")
        st = os.stat(self.report)
        ticket = self.ticket(reply["id"])
        self.assertEqual(ticket, {"v": 1, "id": reply["id"], "path": str(self.report), "name": "report.bin", "size": 4096,
                                  "mtime_ns": str(st.st_mtime_ns), "dev": str(st.st_dev), "ino": str(st.st_ino),
                                  "created": self.now[0], "expires": self.now[0] + observer.DOWNLOAD_TTL * 1000})
        self.assertEqual(observer.DOWNLOAD_TTL, 15 * 60)
        path = self.spool / "downloads" / f"{reply['id']}.json"
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.spool / "downloads").stat().st_mode), 0o700)
        self.assertEqual(self.tickets(), [f"{reply['id']}.json"], "no temp file is left behind")

    def test_the_ticket_names_the_real_path_and_never_a_link(self):
        (self.work / "sub").mkdir()
        inner = self.work / "sub" / "deep.txt"
        inner.write_text("deep")
        dotted = f"{self.work}/sub/../sub/deep.txt"
        self.offer(dotted)
        reply = self.grant(dotted)
        self.assertEqual(self.ticket(reply["id"])["path"], str(inner))

    def test_a_file_over_the_old_200_mb_cap_is_granted_up_to_the_stream_cap(self):
        big = self.work / "big.iso"
        with open(big, "wb") as handle:
            handle.truncate(observer.FILE_SIZE_MAX + 1)
        self.offer(big)
        self.assertEqual(self.grant(big)["size"], observer.FILE_SIZE_MAX + 1)
        with self.assertRaises(observer.FileError) as caught:   # deck.file_read keeps its 200 MB for old apps
            self.reader.read({"session_id": "s-1", "path": str(big), "offset": 0, "length": 1})
        self.assertEqual((caught.exception.code, caught.exception.message),
                         (4083, "The file is too large to download (200 MB at most)"))

    def test_over_the_stream_cap_is_refused_and_names_the_cap(self):
        small_cap = self.make(stream_max=1024)
        error = self.refused(4083, reader=small_cap)
        self.assertEqual(error.message, "The file is too large to download (1 MB at most)")
        self.assertEqual(self.tickets(), [])
        self.assertEqual(observer._size_text(8 * 1024 ** 3), "8 GB")
        self.assertEqual(observer._size_text(3 * 1024 ** 3 // 2), "1.5 GB")
        self.assertEqual(observer._size_text(200 * 1024 ** 2), "200 MB")

    def test_the_cap_follows_the_environment(self):
        self.assertEqual(observer.download_max({}), 8 * 1024 ** 3)
        self.assertEqual(observer.download_max({"HERMES_DECK_DOWNLOAD_MAX": "1048576"}), 1048576)
        for bad in ("0", "-5", "1e9", "lots", "", " "):
            self.assertEqual(observer.download_max({"HERMES_DECK_DOWNLOAD_MAX": bad}), observer.FILE_STREAM_MAX, bad)
        with mock.patch.dict(os.environ, {"HERMES_DECK_DOWNLOAD_MAX": "2048"}):
            self.refused(4083)                                   # 4096 bytes > 2048: read at call time
        self.assertEqual(stream.download_max({"HERMES_DECK_DOWNLOAD_MAX": "77"}), 77)
        self.assertEqual(stream.DOWNLOAD_MAX_DEFAULT, observer.FILE_STREAM_MAX)
        self.assertEqual(stream.DOWNLOAD_MAX_ENV, observer.DOWNLOAD_MAX_ENV)

    def test_expired_tickets_are_pruned_on_the_next_grant(self):
        old = self.grant()["id"]
        self.now[0] += observer.DOWNLOAD_TTL * 1000 + 1
        new = self.grant()["id"]
        self.assertEqual(self.tickets(), [f"{new}.json"])
        self.assertNotEqual(old, new)

    def test_at_most_the_live_ticket_limit_and_the_oldest_go_first(self):
        ids = []
        for _ in range(observer.DOWNLOAD_TICKETS_MAX + 6):
            self.now[0] += 1
            ids.append(self.grant()["id"])
        self.assertEqual(len(self.tickets()), observer.DOWNLOAD_TICKETS_MAX)
        self.assertEqual(set(self.tickets()), {f"{i}.json" for i in ids[-observer.DOWNLOAD_TICKETS_MAX:]})

    def test_junk_and_stale_temp_files_are_cleaned_but_foreign_names_kept(self):
        folder = observer.download_folder(self.spool)
        junk = folder / ("a" * 48 + ".json")
        junk.write_text("not json")
        stale = folder / ("b" * 48 + ".json.tmp")
        stale.write_text("{}")
        os.utime(stale, (time.time() - 600, time.time() - 600))
        fresh = folder / ("c" * 48 + ".json.tmp")
        fresh.write_text("{}")
        other = folder / "README"
        other.write_text("x")
        reply = self.grant()
        self.assertEqual(self.tickets(), sorted(["README", fresh.name, f"{reply['id']}.json"]))

    def test_an_unusable_download_folder_is_an_error_and_never_followed(self):
        self.spool.mkdir(mode=0o700)
        elsewhere = self.tmp / "elsewhere"
        elsewhere.mkdir()
        (self.spool / "downloads").symlink_to(elsewhere)
        self.refused(5001)
        self.assertEqual(list(elsewhere.iterdir()), [])


class GrantAuthorizationTests(GrantBase):
    """Exactly deck.file_read's rules: the grant and the chunk read share FileReader.authorize."""

    def test_both_methods_run_the_one_shared_authorization(self):
        calls = []
        real = observer.FileReader.authorize

        def spy(reader, *args, **kw):
            calls.append(args[3])
            return real(reader, *args, **kw)
        with mock.patch.object(observer.FileReader, "authorize", spy):
            self.grant()
            self.reader.read({"session_id": "s-1", "path": str(self.report), "offset": 0, "length": 1})
        self.assertEqual(calls, [observer.download_max(), observer.FILE_SIZE_MAX])
        source = Path(observer.__file__).read_text(encoding="utf-8")
        body = source[source.index("class FileReader"):source.index("def stat_is_link")]
        self.assertEqual(body.count("file_refusal("), 2, "the denylist is applied in authorize() only")
        self.assertEqual(body.count("self.offered("), 1)
        self.assertEqual(body.count("user_ref_refusal("), 1)

    def test_a_path_the_agent_never_offered_is_refused_and_nothing_is_written(self):
        harmless = self.work / "harmless.txt"
        harmless.write_text("hi")
        self.refused(4081, harmless)
        self.offer(harmless, role="tool", text=f"wrote {harmless}")
        self.refused(4081, harmless)
        self.offer(harmless, role="user", text=f"please send {harmless}")
        self.refused(4081, harmless)
        self.assertEqual(self.tickets(), [])

    def test_an_unknown_session_and_a_missing_file(self):
        with self.assertRaises(observer.FileError) as caught:
            self.reader.grant({"session_id": "gone", "path": str(self.report)})
        self.assertEqual(caught.exception.code, 4081)
        self.refused(4082, self.work / "nothing.txt")

    def test_credential_and_state_locations_are_refused_even_when_offered(self):
        names = [self.tmp / "u" / ".ssh" / "id_ed25519", self.work / "server.pem", self.work / ".env",
                 self.home / "auth.json", self.home / "state.db", self.home / "sessions" / "x.json",
                 self.home / "profiles" / "bot-a" / ".env", self.work / "client_secret.json", Path("/etc/passwd")]
        for path in names:
            with self.subTest(path=str(path).replace(str(self.tmp), "")):
                if path.is_relative_to(self.tmp):
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("TOP SECRET")
                self.offer(path)
                self.refused(4080, path)
        self.assertEqual(self.tickets(), [])

    def test_a_symlink_is_refused_whatever_it_points_to(self):
        harmless = self.work / "target.txt"
        harmless.write_text("x")
        link = self.work / "link.txt"
        os.symlink(harmless, link)
        self.offer(link)
        self.refused(4080, link)
        (self.home / "sessions").mkdir()
        (self.home / "sessions" / "s.json").write_text("{}")
        os.symlink(self.home / "sessions", self.work / "linked-dir")
        smuggled = self.work / "linked-dir" / "s.json"
        self.offer(smuggled)
        self.refused(4080, smuggled)

    def test_directories_and_fifos_are_not_regular_files(self):
        self.offer(self.work)
        self.refused(4082, self.work)
        fifo = self.work / "pipe.bin"
        os.mkfifo(fifo)
        self.offer(fifo)
        self.refused(4082, fifo)

    def test_the_narrow_user_directive_grant_is_unchanged(self):
        (self.home / "attachments").mkdir()
        (self.home / "images").mkdir()
        doc = self.home / "attachments" / "notes.txt"
        doc.write_text("hello")
        self.offer(doc, role="user", text=f'@file:"{doc}"')
        self.assertEqual(self.grant(doc)["size"], 5)
        stray = self.work / "stray.txt"                           # outside the Hermes attachment folders
        stray.write_text("x")
        self.offer(stray, role="user", text=f"@file:{stray}")
        self.refused(4080, stray)
        fake = self.home / "images" / "fake.png"                  # an @image: line needs real image bytes
        fake.write_text("not a picture")
        self.offer(fake, role="user", text=f"@image:{fake}")
        self.refused(4080, fake)
        png = self.home / "images" / "real.png"
        png.write_bytes(PNG)
        self.offer(png, role="user", text=f"@image:{png}")
        self.assertEqual(self.grant(png)["size"], len(PNG))

    def test_parameters_are_checked_strictly(self):
        good = {"session_id": "s-1", "path": str(self.report)}
        bad = [{**good, "path": "relative/x"}, {**good, "path": ""}, {**good, "path": "/x\x00y"},
               {**good, "path": "/" + "a" * 5000}, {**good, "session_id": "a b"}, {**good, "profile": "../x"},
               {**good, "offset": 0}, {**good, "length": 1}, {"session_id": "s-1"}, ["not", "a", "dict"]]
        for params in bad:
            with self.subTest(params=str(params)[:60]):
                with self.assertRaises(observer.FileError) as caught:
                    self.reader.grant(params)
                self.assertEqual(caught.exception.code, 4000)
        self.reader.grant({**good, "profile": "bot-a"})
        self.assertEqual(self.pages[-1][0], "bot-a")


class GrantReplyTests(GrantBase):
    def test_grants_count_as_calls_against_the_connection_budget(self):
        clock = [0.0]
        budget = observer.ReadBudget(clock=lambda: clock[0], window=60, calls=2, size=10)
        request = {"id": "g", "params": {"session_id": "s-1", "path": str(self.report)}}
        replies = [observer.file_grant_reply(request, self.reader, budget) for _ in range(3)]
        self.assertEqual([("result" in r) for r in replies], [True, True, False])
        self.assertEqual(replies[2]["error"]["code"], 4085)
        self.assertEqual(sum(e[1] for e in budget.log), 0, "a grant spends no bytes of the chunk budget")
        clock[0] += 61
        self.assertIn("result", observer.file_grant_reply(request, self.reader, budget))

    def test_errors_are_coded_and_carry_no_path(self):
        budget = observer.ReadBudget()
        denied = observer.file_grant_reply({"id": "g-1", "params": {"session_id": "s-1", "path": str(self.home / "auth.json")}}, self.reader, budget)
        self.assertEqual(denied["error"]["code"], 4080)
        self.assertNotIn(str(self.tmp), json.dumps(denied))
        crash = observer.FileReader(load_messages=lambda *a: 1 / 0, roots=[self.home], spool=self.spool)
        reply = observer.file_grant_reply({"id": "g-2", "params": {"session_id": "s-1", "path": str(self.report)}}, crash, budget)
        self.assertEqual(reply["error"], {"code": 5000, "message": "Hermes file grant unavailable"})


class GrantWiringTests(unittest.TestCase):
    def test_the_method_is_served_natively_before_the_gateway_allowlist(self):
        self.assertNotIn(observer.FILE_GRANT_METHOD, observer.ALLOWED_METHODS)
        self.assertEqual(observer.request_limit(observer.FILE_GRANT_METHOD), observer.SMALL_LINE_MAX)
        text = Path(observer.__file__).read_text(encoding="utf-8")
        serve = text[text.index("def serve(conn)"):text.index("def start(directory")]
        self.assertLess(serve.index("FILE_GRANT_METHOD"), serve.index("allowed_request(method"))
        self.assertIn("file_grant_reply(request, files, budget)", serve)
        self.assertEqual(stream.FILE_GRANT_METHOD, observer.FILE_GRANT_METHOD)
        self.assertEqual(stream.DEADLINES[stream.FILE_GRANT_METHOD], stream.FILE_TIMEOUT)
        self.assertEqual(stream.GRANT_FEATURE, observer.FILE_GRANT_FEATURE)
        self.assertIn(observer.FILE_GRANT_FEATURE, observer.FEATURES)
        bridge = Path(__file__).resolve().parents[2] / "app" / "main" / "bridge.js"
        if bridge.is_file():
            source = bridge.read_text(encoding="utf-8")
            self.assertTrue('"deck.file_grant"' in source, "bridge.js allowlists deck.file_grant")

    def test_deck_version_reports_downloads_only_when_the_live_gateway_grants_them(self):
        tmp = Path(tempfile.mkdtemp(prefix="deck-version-dl-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        home, spool = tmp / "home", tmp / "spool"
        base = home / "hermes-deck"
        (base / "processes").mkdir(parents=True)
        sock = base / f"control-{os.getpid()}-abcd1234.sock"
        sock.write_text("")
        record = {"schema": stream.SCHEMA, "pid": os.getpid(), "updated_at": time.time(), "control_socket": str(sock), "nodes": {}}
        process = base / "processes" / f"{os.getpid()}.json"
        with mock.patch.dict(os.environ, {"HERMES_DECK_UPLOAD_DIR": str(spool)}):
            os.environ.pop("HERMES_DECK_DOWNLOAD_MAX", None)
            process.write_text(json.dumps(record))                       # gateway not restarted yet
            self.assertNotIn("downloads", stream.version_reply(home))
            process.write_text(json.dumps(dict(record, features=["attach_staged"])))   # 1.3.2 observer
            reply = stream.version_reply(home)
            self.assertIn("uploads", reply)
            self.assertNotIn("downloads", reply)
            process.write_text(json.dumps(dict(record, features=["attach_staged", "file_grant"], download_max=5 * 1024 ** 3)))
            reply = stream.version_reply(home)
            self.assertEqual(reply["downloads"], {"v": 1, "host": stream.upload_host(spool), "maxBytes": 5 * 1024 ** 3})
            self.assertEqual(reply["uploads"]["host"], reply["downloads"]["host"])
            process.write_text(json.dumps(dict(record, features=["file_grant"], download_max="lots")))
            reply = stream.version_reply(home)
            self.assertEqual(reply["downloads"]["maxBytes"], stream.DOWNLOAD_MAX_DEFAULT)
            self.assertNotIn("uploads", reply)
        snapshot = observer.Observer(tmp / "obs").snapshot()
        self.assertIn("file_grant", snapshot["features"])
        self.assertEqual(snapshot["download_max"], observer.download_max())
        self.assertTrue(re.fullmatch(r"[a-f0-9]{16}", reply["downloads"]["host"]))


if __name__ == "__main__":
    unittest_main()
