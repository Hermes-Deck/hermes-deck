"""deck.file_read for files a USER message names as `@image:` / `@file:` directive lines (the stored form of an
attachment); no Hermes, no network. The transcript store and the Hermes homes are fakes.

Run with any Python 3.10+:  python test_media_read.py
"""
import base64
import os
import tempfile
import unittest
from pathlib import Path

import observer
from testsupport import unittest_main

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 32


class UserRefParsingTests(unittest.TestCase):
    def test_every_quoting_form_of_a_directive_line_is_read(self):
        text = "caption\n\n@image:/h/images/a.png\n@image:`/h/images/b b.png`\n@image:\"/h/images/c.png\"\n@file:'/h/attachments/d.pdf'"
        self.assertEqual(observer.user_refs(text), {"/h/images/a.png": "image", "/h/images/b b.png": "image",
                                                    "/h/images/c.png": "image", "/h/attachments/d.pdf": "file"})

    def test_only_whole_lines_count_and_relative_refs_name_nothing(self):
        text = "look at @image:/h/images/a.png in this sentence\n@image:relative.png\n@url:/h/images/b.png\n@image:/h/images/../x.png"
        found = observer.user_refs(text)
        self.assertNotIn("/h/images/a.png", found)
        self.assertNotIn("relative.png", found)
        self.assertNotIn("/h/images/b.png", found)

    def test_an_image_directive_wins_when_a_path_is_named_both_ways(self):
        self.assertEqual(observer.user_refs("@image:/h/images/a.png\n@file:/h/images/a.png"), {"/h/images/a.png": "image"})
        # the native-vision hint form the TUI stores for a pasted image
        self.assertEqual(observer.user_refs("look\n\n[Image attached at: /h/images/c.png]\n[screenshot]"), {"/h/images/c.png": "image"})
        self.assertEqual(observer.user_refs("[Image attached at: rel/c.png]"), {})
        self.assertEqual(observer.user_refs("@file:/h/images/a.png\n@image:/h/images/a.png"), {"/h/images/a.png": "image"})


class UserRefReadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.home = self.root / "hermes-home"
        (self.home / "images").mkdir(parents=True)
        self.outside = self.root / "elsewhere"
        self.outside.mkdir()
        self.png = self.home / "images" / "upload_1.png"
        self.png.write_bytes(PNG)
        self.transcript = []
        self.reader = observer.FileReader(load_messages=self.load, roots=[self.home])

    def load(self, profile, sid, limit, offset):
        if sid == "gone":
            return None
        return self.transcript[::-1][offset:offset + limit]

    def say(self, *lines, role="user"):
        self.transcript = [{"id": 1, "role": role, "content": "\n".join(lines)}]

    def read(self, path, sid="s-1", offset=0, length=1024):
        return self.reader.read({"session_id": sid, "path": str(path), "offset": offset, "length": length})

    def refused(self, code, path, **kw):
        with self.assertRaises(observer.FileError) as caught:
            self.read(path, **kw)
        self.assertEqual(caught.exception.code, code, caught.exception.message)

    def test_an_image_the_user_message_names_downloads(self):
        self.say("what is this?", "", f"@image:{self.png}")
        result = self.read(self.png)
        self.assertEqual(base64.b64decode(result["data"]), PNG)
        self.assertTrue(result["eof"])

    def test_jpeg_and_webp_pass_the_magic_check(self):
        for name, blob in (("a.jpg", JPG), ("b.webp", WEBP)):
            path = self.home / "images" / name
            path.write_bytes(blob)
            self.say(f"@image:`{path}`")
            self.assertEqual(base64.b64decode(self.read(path)["data"]), blob)

    def test_a_file_directive_downloads_from_an_attachment_folder(self):
        (self.home / "attachments").mkdir()
        doc = self.home / "attachments" / "notes.txt"
        doc.write_text("hello")
        self.say(f'@file:"{doc}"')
        self.assertEqual(base64.b64decode(self.read(doc)["data"]), b"hello")

    def test_a_path_outside_the_attachment_folders_is_refused(self):
        stray = self.outside / "photo.png"
        stray.write_bytes(PNG)
        self.say(f"@image:{stray}")
        self.refused(4080, stray)
        note = self.home / "notes.txt"                      # the Hermes home itself is no attachment folder
        note.write_text("x")
        self.say(f"@file:{note}")
        self.refused(4080, note)

    def test_hermes_state_stays_refused_even_below_an_attachment_folder_name(self):
        (self.home / "sessions").mkdir()
        state = self.home / "sessions" / "s.png"
        state.write_bytes(PNG)
        self.say(f"@image:{state}")
        self.refused(4080, state)

    def test_a_non_image_named_by_an_image_directive_is_refused(self):
        text = self.home / "images" / "fake.png"
        text.write_text("not a picture at all")
        self.say(f"@image:{text}")
        self.refused(4080, text)

    def test_a_symlink_in_the_images_folder_is_refused(self):
        secret = self.outside / "secret.png"
        secret.write_bytes(PNG)
        link = self.home / "images" / "link.png"
        os.symlink(secret, link)
        self.say(f"@image:{link}")
        self.refused(4080, link)

    def test_a_symlinked_images_folder_cannot_reach_outside(self):
        (self.outside / "pics").mkdir()
        (self.outside / "pics" / "a.png").write_bytes(PNG)
        os.symlink(self.outside / "pics", self.home / "images" / "dir")
        path = self.home / "images" / "dir" / "a.png"
        self.say(f"@image:{path}")
        self.refused(4080, path)

    def test_another_sessions_ref_does_not_authorize(self):
        self.say(f"@image:{self.png}")
        self.read(self.png)
        with self.assertRaises(observer.FileError) as caught:
            self.read(self.png, sid="gone")
        self.assertEqual(caught.exception.code, 4081)
        self.transcript = [{"id": 1, "role": "user", "content": "nothing attached"}]
        other = observer.FileReader(load_messages=self.load, roots=[self.home])
        with self.assertRaises(observer.FileError) as caught:
            other.read({"session_id": "s-2", "path": str(self.png), "offset": 0, "length": 8})
        self.assertEqual(caught.exception.code, 4081)

    def test_a_directive_in_a_tool_message_is_no_grant(self):
        # (an assistant message that names the path is the agent grant, which has its own tests)
        self.say(f"@image:{self.png}", role="tool")
        with self.assertRaises(observer.FileError) as caught:
            self.read(self.png)
        self.assertEqual(caught.exception.code, 4081)

    def test_the_narrow_grant_is_rechecked_on_every_chunk(self):
        self.say(f"@image:{self.png}")
        self.read(self.png, length=16)
        self.png.write_bytes(b"not a picture any more" * 4)  # same path, swapped bytes (also changes size)
        with self.assertRaises(observer.FileError) as caught:
            self.read(self.png, offset=16, length=16)
        self.assertIn(caught.exception.code, (4080, 4084))

    def test_the_agent_grant_keeps_its_wider_reach(self):
        report = self.outside / "report.txt"
        report.write_text("done")
        self.transcript = [{"id": 1, "role": "assistant", "content": f"MEDIA:{report}"}]
        self.assertEqual(base64.b64decode(self.read(report)["data"]), b"done")


if __name__ == "__main__":
    unittest_main()
