"""deck.transcribe (dictation) and deck.file_read (downloads of files the agent offered); no Hermes, no network.

Run with any Python 3.10+:  python test_voice_files.py
The transcriber, the transcript store and the Hermes homes are fakes; the audio is a few bytes with a real
container signature.
"""
import base64
import os
import stat
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path

import observer
import stream
from testsupport import unittest_main

WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 60
OGG = b"OggS" + b"\x00" * 60
WAV = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 40
b64 = lambda raw: base64.b64encode(raw).decode()


def transcribe_request(blob=WEBM, mime="audio/webm;codecs=opus", **changes):
    params = {"audio_base64": b64(blob), "mime": mime}
    params.update(changes)
    return {"jsonrpc": "2.0", "id": "d-1", "method": "deck.transcribe", "params": params}


class Collector:
    """A write() that records replies and lets a test wait for one."""

    def __init__(self):
        self.replies, self.event = [], threading.Event()

    def __call__(self, reply):
        self.replies.append(reply)
        self.event.set()

    def wait(self, seconds=5):
        assert self.event.wait(seconds), "no reply"
        return self.replies[0]


class FakeScope:
    """agent.secret_scope: records the scope the transcriber saw and what was reset."""

    def __init__(self, bound=False):
        self.bound, self.seen, self.history = bound, [], []
        self.module = types.ModuleType("agent.secret_scope")
        self.module.current_secret_scope = lambda: {"already": "bound"} if self.bound else self.current
        self.module.build_profile_secret_scope = lambda home: {"home": str(home), "OPENAI_API_KEY": "fake"}
        self.module.set_secret_scope = self.set
        self.module.reset_secret_scope = self.reset
        self.current = None

    def set(self, mapping, profile_home=None):
        self.current = mapping
        self.history.append(("set", str(profile_home)))
        return object()

    def reset(self, token):
        self.current = None
        self.history.append(("reset", None))


def install_scope(test, scope):
    package = types.ModuleType("agent")
    package.secret_scope = scope.module
    saved = {k: sys.modules.get(k) for k in ("agent", "agent.secret_scope")}
    sys.modules["agent"], sys.modules["agent.secret_scope"] = package, scope.module

    def restore():
        for key, value in saved.items():
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value
    test.addCleanup(restore)


class TranscribeValidationTests(unittest.TestCase):
    def test_a_webm_ogg_or_wav_clip_is_accepted_and_the_extension_follows_the_bytes(self):
        for blob, ext in ((WEBM, ".webm"), (OGG, ".ogg"), (WAV, ".wav")):
            parsed, got, refused = observer.parse_transcribe(transcribe_request(blob))
            self.assertIsNone(refused)
            self.assertEqual((parsed, got), (blob, ext))

    def test_bad_requests_are_refused_before_anything_is_written(self):
        cases = [
            transcribe_request(mime="text/plain"),
            transcribe_request(mime="audio/../../etc"),
            transcribe_request(extra="x"),
            transcribe_request(audio_base64=""),
            transcribe_request(audio_base64="!!!not base64!!!"),
            transcribe_request(audio_base64=7),
            transcribe_request(b"just some text that is not audio at all"),
            transcribe_request(b"\x89PNG\r\n\x1a\n" + b"x" * 40),
            {"jsonrpc": "2.0", "id": "d", "method": "deck.transcribe", "params": ["x"]},
            {"jsonrpc": "2.0", "id": "d", "method": "deck.transcribe", "params": {"mime": "audio/webm"}},
        ]
        for request in cases:
            with self.subTest(request=str(request)[:90]):
                blob, ext, refused = observer.parse_transcribe(request)
                self.assertIsNone(blob)
                self.assertEqual(refused["error"]["code"], 4000)

    def test_the_decoded_size_cap(self):
        over = transcribe_request(WEBM + b"\x00" * observer.TRANSCRIBE_MAX_BYTES)
        _, _, refused = observer.parse_transcribe(over)
        self.assertEqual(refused["error"]["code"], 4000)
        edge = transcribe_request(WEBM + b"\x00" * (observer.TRANSCRIBE_MAX_BYTES - len(WEBM)))
        self.assertIsNone(observer.parse_transcribe(edge)[2])

    def test_line_limits_agree_between_observer_and_stream_and_only_two_methods_exceed_2_mib(self):
        self.assertEqual(stream.TRANSCRIBE_METHOD, observer.TRANSCRIBE_METHOD)
        self.assertEqual(stream.TRANSCRIBE_LINE_MAX, observer.TRANSCRIBE_LINE_MAX)
        self.assertEqual(stream.LINE_MAX, observer.LINE_MAX)
        self.assertEqual(stream.FILE_METHOD, observer.FILE_METHOD)
        self.assertEqual(set(observer.LINE_MAX), {"deck.attach_submit", "deck.transcribe"})
        # a transcribe line over 2 MiB passes the head check, any other method does not
        big = 3 * 1024 * 1024
        self.assertFalse(observer.line_refused(big, b'{"jsonrpc":"2.0","id":"x","method":"deck.transcribe"'))
        self.assertTrue(observer.line_refused(big, b'{"jsonrpc":"2.0","id":"x","method":"deck.file_read"'))
        self.assertTrue(observer.line_refused(big, b'{"jsonrpc":"2.0","id":"x","method":"prompt.submit"'))
        self.assertTrue(observer.line_refused(observer.TRANSCRIBE_LINE_MAX + observer.ATTACH_LINE_MAX, b"deck.transcribe"))
        self.assertEqual(observer.request_limit("deck.file_read"), 65536)
        self.assertEqual(observer.request_limit("deck.appshot"), 2 * 1024 * 1024)
        self.assertEqual(observer.request_limit("deck.transcribe"), observer.TRANSCRIBE_LINE_MAX)
        # the relay gives dictation its own connection and thread, and a longer deadline than the default
        self.assertIn("deck.transcribe", stream.ONE_SHOT)
        self.assertGreater(stream.DEADLINES["deck.transcribe"], observer.TRANSCRIBE_TIMEOUT)


class TranscribeRunTests(unittest.TestCase):
    def test_the_temp_file_is_private_and_always_removed(self):
        seen = {}

        def transcribe(path):
            info, parent = os.stat(path), os.stat(os.path.dirname(path))
            seen.update(path=path, mode=stat.S_IMODE(info.st_mode), dir_mode=stat.S_IMODE(parent.st_mode),
                        data=Path(path).read_bytes(), suffix=Path(path).suffix)
            return {"success": True, "transcript": " hello there ", "provider": "local"}

        out = Collector()
        observer.start_transcription(transcribe_request(), out, transcribe=transcribe)
        reply = out.wait()
        self.assertEqual(reply["result"], {"text": "hello there", "provider": "local"})
        self.assertEqual((seen["mode"], seen["dir_mode"], seen["suffix"], seen["data"]), (0o600, 0o700, ".webm", WEBM))
        self.assertFalse(os.path.exists(seen["path"]))
        self.assertFalse(os.path.exists(os.path.dirname(seen["path"])))

    def test_the_temp_file_is_removed_when_the_transcriber_fails_or_raises(self):
        paths = []

        def failing(path):
            paths.append(path)
            return {"success": False, "error": "STT is disabled in config.yaml (stt.enabled: false).\n"}

        def raising(path):
            paths.append(path)
            raise RuntimeError("secret detail that must not travel")

        for fn, expect in ((failing, "STT is disabled in config.yaml (stt.enabled: false)."), (raising, "Transcription failed")):
            out = Collector()
            observer.start_transcription(transcribe_request(), out, transcribe=fn)
            reply = out.wait()
            self.assertEqual(reply["error"]["message"], expect)
            self.assertEqual(reply["error"]["code"], 4074)
            self.assertNotIn("secret detail", str(reply))
        self.assertEqual(len(paths), 2)
        for path in paths:
            self.assertFalse(os.path.exists(os.path.dirname(path)))

    def test_the_profile_secret_scope_is_bound_during_the_call_and_reset_after(self):
        scope = FakeScope()
        install_scope(self, scope)
        during = []

        def transcribe(path):
            during.append(dict(scope.current or {}))
            return {"success": True, "transcript": "ok"}

        out = Collector()
        observer.start_transcription(transcribe_request(), out, transcribe=transcribe, home="/srv/example-home")
        out.wait()
        self.assertEqual(during[0]["home"], "/srv/example-home")
        self.assertEqual(scope.history, [("set", "/srv/example-home"), ("reset", None)])
        self.assertIsNone(scope.current)

    def test_the_scope_is_reset_when_the_transcriber_raises_and_not_rebound_when_one_exists(self):
        scope = FakeScope()
        install_scope(self, scope)
        out = Collector()
        observer.start_transcription(transcribe_request(), out, home="/srv/example-home",
                                     transcribe=lambda path: (_ for _ in ()).throw(RuntimeError("x")))
        out.wait()
        self.assertEqual([h[0] for h in scope.history], ["set", "reset"])
        bound = FakeScope(bound=True)
        install_scope(self, bound)
        out = Collector()
        observer.start_transcription(transcribe_request(), out, home="/srv/example-home",
                                     transcribe=lambda path: {"success": True, "transcript": "fine"})
        self.assertEqual(out.wait()["result"]["text"], "fine")
        self.assertEqual(bound.history, [])

    def test_a_hermes_without_secret_scoping_still_transcribes(self):
        saved = {k: sys.modules.get(k) for k in ("agent", "agent.secret_scope")}
        sys.modules["agent"] = types.ModuleType("agent")          # no secret_scope inside
        sys.modules.pop("agent.secret_scope", None)
        self.addCleanup(lambda: [sys.modules.__setitem__(k, v) if v is not None else sys.modules.pop(k, None) for k, v in saved.items()])
        out = Collector()
        observer.start_transcription(transcribe_request(), out, transcribe=lambda path: {"success": True, "transcript": "plain"})
        self.assertEqual(out.wait()["result"]["text"], "plain")

    def test_one_dictation_at_a_time_and_a_timeout_answers_but_keeps_the_slot_until_the_worker_ends(self):
        gate = threading.Event()
        first = Collector()
        observer.start_transcription(transcribe_request(), first, timeout=0.2,
                                     transcribe=lambda path: (gate.wait(5), {"success": True, "transcript": "late"})[1])
        second = Collector()
        observer.start_transcription(transcribe_request(), second, transcribe=lambda path: {"success": True, "transcript": "x"})
        self.assertEqual(second.wait()["error"]["code"], 4073)       # busy: refused at once
        self.assertEqual(first.wait()["error"]["message"], "Transcription timed out")
        third = Collector()                                          # the stuck worker still holds the slot
        observer.start_transcription(transcribe_request(), third, transcribe=lambda path: {"success": True, "transcript": "x"})
        self.assertEqual(third.wait()["error"]["code"], 4073)
        gate.set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            fourth = Collector()
            observer.start_transcription(transcribe_request(), fourth, transcribe=lambda path: {"success": True, "transcript": "again"})
            reply = fourth.wait()
            if "result" in reply:
                break
            time.sleep(0.05)
        self.assertEqual(reply["result"]["text"], "again")
        self.assertEqual(len(first.replies), 1, "a late result is never a second answer")

    def test_an_invalid_request_never_takes_the_slot_or_starts_a_thread(self):
        out = Collector()
        called = []
        observer.start_transcription(transcribe_request(b"not audio"), out, transcribe=lambda path: called.append(path))
        self.assertEqual(out.wait()["error"]["code"], 4000)
        self.assertEqual(called, [])
        self.assertTrue(observer._TRANSCRIBE_SLOT.acquire(blocking=False))
        observer._TRANSCRIBE_SLOT.release()

    def test_a_long_transcript_is_bounded(self):
        reply = observer.transcription_reply("x", {"success": True, "transcript": "a" * 40000, "provider": "p" * 90})
        self.assertEqual((len(reply["result"]["text"]), len(reply["result"]["provider"])), (32000, 40))


class FileReadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.home = self.root / "hermes-home"
        (self.home / "profiles" / "bot-a").mkdir(parents=True)
        self.work = self.root / "work"
        self.work.mkdir()
        self.report = self.work / "report.txt"
        self.report.write_bytes(bytes(range(256)) * 10)       # 2560 bytes
        self.transcript = [
            {"id": 1, "role": "user", "content": "please write the report"},
            {"id": 2, "role": "assistant", "content": f"Done. MEDIA:{self.report}"},
        ]
        self.pages = []
        self.reader = observer.FileReader(load_messages=self.load, roots=[self.home])

    def load(self, profile, sid, limit, offset):
        self.pages.append((profile, sid, limit, offset))
        if sid == "gone":
            return None
        rows = self.transcript[::-1]                          # newest first, like latest=True
        return rows[offset:offset + limit]

    def params(self, path=None, offset=0, length=1024, **extra):
        return {"session_id": "s-1", "path": str(path or self.report), "offset": offset, "length": length, **extra}

    def read(self, **kw):
        return self.reader.read(self.params(**kw))

    def refused(self, code, **kw):
        with self.assertRaises(observer.FileError) as caught:
            self.read(**kw)
        self.assertEqual(caught.exception.code, code, caught.exception.message)

    # --- offered in the session ---------------------------------------------------------------------------

    def test_a_media_path_of_an_assistant_message_downloads_in_chunks_and_verifies(self):
        first = self.read(offset=0, length=1000)
        self.assertEqual((first["name"], first["size"], first["offset"], first["length"], first["eof"]),
                         ("report.txt", 2560, 0, 1000, False))
        data = base64.b64decode(first["data"])
        data += base64.b64decode(self.read(offset=1000, length=1000)["data"])
        last = self.read(offset=2000, length=1000)
        data += base64.b64decode(last["data"])
        self.assertTrue(last["eof"])
        self.assertEqual(last["length"], 560)
        self.assertEqual(data, self.report.read_bytes())
        self.assertGreater(first["mtime"], 0)
        self.assertEqual(len(self.pages), 1, "only the first chunk searches the transcript")

    def test_a_backticked_and_a_bare_path_are_offered_but_a_path_prefix_or_extension_is_not(self):
        other = self.work / "other.csv"
        other.write_text("a,b\n")
        for text in (f"The file is `{other}`.", f"see {other}", f"({other})", f"**MEDIA:{other}**", f'"{other}"'):
            self.assertTrue(observer.path_offered(text, str(other)), text)
        for text in (f"{other}x", f"{other}.bak", f"x{other}", f"see {str(other)[:-4]}", f"{other}/inner"):
            self.assertFalse(observer.path_offered(text, str(other)), text)
        self.assertTrue(observer.path_offered(f"Saved to {other}.", str(other)))

    def test_a_path_only_a_user_or_tool_mentioned_is_refused(self):
        secret_like = self.work / "notes.md"
        secret_like.write_text("x")
        self.transcript = [{"id": 1, "role": "user", "content": f"please send {secret_like}"},
                           {"id": 2, "role": "tool", "content": f"wrote {secret_like}"},
                           {"id": 3, "role": "assistant", "content": "I will not name it."}]
        self.refused(4081, path=secret_like)

    def test_a_path_the_agent_never_offered_is_refused_even_when_it_is_harmless(self):
        harmless = self.work / "harmless.txt"
        harmless.write_text("hi")
        self.refused(4081, path=harmless)

    def test_text_blocks_of_a_structured_message_count(self):
        self.transcript = [{"id": 2, "role": "assistant", "content": [{"type": "text", "text": f"here: `{self.report}`"}, {"type": "image_url"}]}]
        self.assertEqual(self.read()["size"], 2560)

    def test_an_unknown_session_and_a_missing_file(self):
        with self.assertRaises(observer.FileError) as caught:
            self.reader.read({**self.params(), "session_id": "gone"})
        self.assertEqual(caught.exception.code, 4081)
        self.refused(4082, path=self.work / "nothing.txt")

    def test_the_grant_lets_a_download_continue_but_a_changed_file_is_refused(self):
        self.read(offset=0, length=100)
        self.report.write_bytes(b"replaced with something else entirely")
        self.refused(4084, offset=100)
        self.assertEqual(self.read(offset=0, length=10)["size"], 37, "the next download starts a new grant")

    def test_a_grant_expires(self):
        clock = [1000.0]
        reader = observer.FileReader(load_messages=self.load, roots=[self.home], clock=lambda: clock[0])
        reader.read(self.params())
        self.pages.clear()
        clock[0] += observer.FILE_GRANT_TTL - 1
        reader.read(self.params(offset=100))
        self.assertEqual(self.pages, [])
        clock[0] += observer.FILE_GRANT_TTL - 1        # each chunk renews the grant: a long download keeps it
        reader.read(self.params(offset=200))
        self.assertEqual(self.pages, [])
        clock[0] += observer.FILE_GRANT_TTL + 5        # idle for longer than the TTL: asked again
        reader.read(self.params(offset=300))
        self.assertEqual(len(self.pages), 1, "an expired grant searches the transcript again")

    def test_only_this_sessions_transcript_authorizes(self):
        self.read()
        with self.assertRaises(observer.FileError) as caught:
            self.reader.read({**self.params(), "session_id": "gone"})
        self.assertEqual(caught.exception.code, 4081, "a grant for s-1 is not a grant for another session")

    # --- what may never be read ---------------------------------------------------------------------------

    def offer(self, path):
        self.transcript = [{"id": 2, "role": "assistant", "content": f"MEDIA:{path}"}]

    def test_credential_and_state_locations_are_refused_even_when_offered(self):
        names = [self.root / "home" / ".ssh" / "id_ed25519", self.root / "home" / ".ssh" / "notes.txt",
                 self.root / "home" / ".aws" / "credentials", self.work / "server.pem", self.work / "tls.key",
                 self.work / ".env", self.work / ".env.production", self.work / ".netrc", self.work / "id_rsa.bak",
                 self.work / "keys.kdbx", self.home / ".env", self.home / "auth.json", self.home / "config.yaml",
                 self.home / "state.db", self.home / "state.db-wal", self.home / "auth" / "token.json",
                 self.home / "sessions" / "x.json", self.home / "browser-profile" / "Cookies",
                 self.home / "pairing" / "p.json", self.home / "vault" / "vault.key",
                 self.home / "profiles" / "bot-a" / ".env", self.home / "profiles" / "bot-a" / "state.db",
                 self.home / "hermes-deck" / "processes" / "1.json", self.work / "client_secret.json",
                 Path("/etc/shadow"), Path("/etc/passwd"), Path("/proc/self/environ"), Path("/root/.ssh/id_rsa")]
        for path in names:
            with self.subTest(path=str(path).replace(str(self.root), "")):
                if path.is_relative_to(self.root):
                    path.parent.mkdir(parents=True, exist_ok=True)
                    if not path.exists():
                        path.write_text("TOP SECRET")
                self.offer(path)
                self.refused(4080, path=path)

    def test_env_example_files_stay_downloadable(self):
        sample = self.work / ".env.example"
        sample.write_text("KEY=\n")
        self.offer(sample)
        self.assertEqual(self.read(path=sample)["size"], 5)

    def test_a_symlink_is_refused_whatever_it_points_to(self):
        secret = self.home / "auth.json"
        secret.write_text("{}")
        link = self.work / "innocent.txt"
        os.symlink(secret, link)
        self.offer(link)
        self.refused(4080, path=link)
        harmless = self.work / "target.txt"
        harmless.write_text("x")
        ok_link = self.work / "ok-link.txt"
        os.symlink(harmless, ok_link)
        self.offer(ok_link)
        self.refused(4080, path=ok_link)

    def test_a_symlinked_directory_cannot_smuggle_a_protected_file_out(self):
        (self.home / "sessions").mkdir()
        (self.home / "sessions" / "s.json").write_text("{}")
        os.symlink(self.home / "sessions", self.work / "linked-dir")
        path = self.work / "linked-dir" / "s.json"
        self.offer(path)
        self.refused(4080, path=path)

    def test_dotdot_paths_are_normalised_before_the_checks(self):
        (self.home / "auth.json").write_text("{}")
        sneaky = f"{self.work}/../hermes-home/auth.json"
        self.offer(sneaky)
        self.refused(4080, path=sneaky)

    def test_directories_fifos_and_devices_are_not_regular_files(self):
        self.offer(self.work)
        self.refused(4082, path=self.work)
        fifo = self.work / "pipe.txt"
        os.mkfifo(fifo)
        self.offer(fifo)
        self.refused(4082, path=fifo)          # opened non-blocking: it must neither hang nor be served

    def test_the_size_cap(self):
        big = self.work / "big.bin"
        with open(big, "wb") as handle:
            handle.truncate(observer.FILE_SIZE_MAX + 1)
        self.offer(big)
        self.refused(4083, path=big)
        atcap = self.work / "atcap.bin"
        with open(atcap, "wb") as handle:
            handle.truncate(observer.FILE_SIZE_MAX)
        self.offer(atcap)
        result = self.read(path=atcap, offset=observer.FILE_SIZE_MAX - 10, length=100)
        self.assertEqual((result["length"], result["eof"]), (10, True))

    def test_hermes_read_guard_is_consulted_when_this_hermes_has_one(self):
        module = types.ModuleType("agent.file_safety")
        module.get_read_block_error = lambda path: "blocked" if path.endswith("guarded.txt") else None
        package = types.ModuleType("agent")
        package.file_safety = module
        saved = {k: sys.modules.get(k) for k in ("agent", "agent.file_safety")}
        sys.modules["agent"], sys.modules["agent.file_safety"] = package, module
        self.addCleanup(lambda: [sys.modules.__setitem__(k, v) if v is not None else sys.modules.pop(k, None) for k, v in saved.items()])
        self.assertEqual(observer.file_refusal(str(self.work / "guarded.txt")), "Hermes read guard")
        self.assertIsNone(observer.file_refusal(str(self.work / "fine.txt")))

    # --- parameters ---------------------------------------------------------------------------------------

    def test_parameters_are_checked_strictly(self):
        good = self.params()
        bad = [{**good, "path": "relative/report.txt"}, {**good, "path": "~/report.txt"}, {**good, "path": ""},
               {**good, "path": "/x\x00y"}, {**good, "path": "/" + "a" * 5000}, {**good, "offset": -1},
               {**good, "offset": 1.5}, {**good, "offset": True}, {**good, "length": 0},
               {**good, "length": observer.FILE_CHUNK_MAX + 1}, {**good, "session_id": ""},
               {**good, "session_id": "a b"}, {**good, "profile": "../x"}, {**good, "extra": 1},
               {"session_id": "s-1", "path": good["path"]}, ["not", "a", "dict"]]
        for params in bad:
            with self.subTest(params=str(params)[:80]):
                with self.assertRaises(observer.FileError) as caught:
                    self.reader.read(params)
                self.assertEqual(caught.exception.code, 4000)
        self.assertEqual(self.reader.read({**good, "length": observer.FILE_CHUNK_MAX})["length"], 2560)

    def test_a_named_profile_is_forwarded_to_the_transcript_read(self):
        self.read(profile="bot-a")
        self.assertEqual(self.pages[0][0], "bot-a")

    def test_an_offset_past_the_end_is_an_empty_final_chunk(self):
        result = self.read(offset=9000)
        self.assertEqual((result["length"], result["eof"], result["data"]), (0, True, ""))

    # --- the reply and the budget -------------------------------------------------------------------------

    def test_the_reply_carries_no_host_path_and_errors_are_coded(self):
        budget = observer.ReadBudget()
        reply = observer.file_reply({"id": "f-1", "params": self.params()}, self.reader, budget)
        self.assertNotIn(str(self.root), str(reply))
        self.assertEqual(reply["id"], "f-1")
        denied = observer.file_reply({"id": "f-2", "params": self.params(path=self.home / "auth.json")}, self.reader, budget)
        self.assertEqual(denied["error"]["code"], 4080)
        self.assertNotIn(str(self.root), str(denied))
        crash = observer.FileReader(load_messages=lambda *a: 1 / 0, roots=[self.home])
        self.assertEqual(observer.file_reply({"id": "f-3", "params": self.params()}, crash, budget)["error"]["code"], 5000)

    def test_the_per_connection_budget_limits_calls_and_bytes_and_recovers(self):
        clock = [0.0]
        budget = observer.ReadBudget(clock=lambda: clock[0], window=60, calls=3, size=2000)
        request = {"id": "f", "params": self.params(length=1000)}
        replies = [observer.file_reply(request, self.reader, budget) for _ in range(4)]
        self.assertEqual([("result" in r) for r in replies], [True, True, False, False])
        self.assertEqual(replies[2]["error"]["code"], 4085)      # 2,000 bytes spent
        clock[0] += 61
        self.assertIn("result", observer.file_reply(request, self.reader, budget))
        calls = observer.ReadBudget(clock=lambda: clock[0], window=60, calls=2, size=10 ** 9)
        for _ in range(2):
            calls.spend(1)
        self.assertFalse(calls.allow())

    def test_granting_is_bounded(self):
        reader = observer.FileReader(load_messages=self.load, roots=[self.home])
        for n in range(observer.FILE_GRANTS_MAX + 20):
            path = self.work / f"f{n}.txt"
            path.write_text("x")
            self.transcript = [{"id": 2, "role": "assistant", "content": f"MEDIA:{path}"}]
            reader.read(self.params(path=path))
        self.assertEqual(len(reader.grants), observer.FILE_GRANTS_MAX)


class WiringTests(unittest.TestCase):
    """The control socket serves both methods natively; neither is forwarded to the gateway as-is."""

    def test_neither_method_is_a_gateway_method(self):
        for method in ("deck.transcribe", "deck.file_read"):
            self.assertNotIn(method, observer.ALLOWED_METHODS)
            self.assertFalse(observer.allowed_request(method, {}))

    def test_serve_dispatches_both_methods_before_the_gateway_allowlist(self):
        text = (Path(observer.__file__).read_text(encoding="utf-8"))
        serve = text[text.index("def serve(conn)"):text.index("def start(directory")]
        self.assertLess(serve.index("TRANSCRIBE_METHOD"), serve.index("allowed_request(method"))
        self.assertLess(serve.index("FILE_METHOD"), serve.index("allowed_request(method"))
        self.assertIn("line_refused(", serve)


class TranscribeLanguageTests(unittest.TestCase):
    """The optional `language` hint: validated, passed through, scoped to the clip, and absent means auto-detect."""

    def test_a_short_lowercase_code_is_accepted_and_anything_else_is_refused(self):
        for good in ("tr", "en", "yue"):
            self.assertIsNone(observer.parse_transcribe(transcribe_request(language=good))[2], good)
        for bad in ("", "TR", "tr-TR", "t", "turkish", "../x", 7, ["tr"]):
            with self.subTest(language=bad):
                self.assertEqual(observer.parse_transcribe(transcribe_request(language=bad))[2]["error"]["code"], 4000)
        self.assertIsNone(observer.transcribe_language(transcribe_request()))   # no default language anywhere
        self.assertEqual(observer.transcribe_language(transcribe_request(language="tr")), "tr")

    def test_the_hint_reaches_the_transcriber_only_when_given(self):
        seen = []
        out = Collector()
        observer.start_transcription(transcribe_request(), out, transcribe=lambda path, **kw: seen.append(kw) or {"success": True, "transcript": "a"})
        out.wait()
        out = Collector()
        observer.start_transcription(transcribe_request(language="tr"), out, transcribe=lambda path, **kw: seen.append(kw) or {"success": True, "transcript": "b"})
        out.wait()
        self.assertEqual(seen, [{}, {"language": "tr"}])

    def test_hermes_gets_the_hint_through_its_pre_transcription_hook_for_this_clip_only(self):
        calls = []
        package = types.ModuleType("tools")
        module = types.ModuleType("tools.transcription_tools")

        def transcribe_audio(path, model=None, source=None):
            calls.append((observer.pre_transcription_hint(file_path=path), observer.pre_transcription_hint(file_path="/other.webm")))
            return {"success": True, "transcript": "x"}
        module.transcribe_audio = transcribe_audio
        package.transcription_tools = module
        saved = {k: sys.modules.get(k) for k in ("tools", "tools.transcription_tools")}
        sys.modules["tools"], sys.modules["tools.transcription_tools"] = package, module
        self.addCleanup(lambda: [sys.modules.pop(k, None) if v is None else sys.modules.__setitem__(k, v) for k, v in saved.items()])
        self.assertEqual(observer._hermes_transcribe("/clip.webm", language="tr")["transcript"], "x")
        self.assertEqual(observer._hermes_transcribe("/clip.webm")["transcript"], "x")
        self.assertEqual(calls, [({"language": "tr"}, None), (None, None)])
        self.assertEqual(observer._LANGUAGE_HINTS, {})            # nothing lingers after the call
        self.assertIn("pre_transcription", observer.HOOKS)
        self.assertIsNone(observer.Observer.pre_transcription(object(), file_path="/nope", provider="local"))


if __name__ == "__main__":
    unittest_main()
