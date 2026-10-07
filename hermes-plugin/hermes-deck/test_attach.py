"""Headless deck.attach_submit admission and native routing; no desktop, gateway, Telegram or network."""
import base64
import unittest
import observer
import stream
from observer import submit_attachments
from testsupport import unittest_main

PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 64
JPEG = b"\xff\xd8\xff\xe0" + b"x" * 64
MP4 = b"\x00\x00\x00\x18ftypmp42" + b"x" * 64
b64 = lambda raw: base64.b64encode(raw).decode()


class AttachSubmitTests(unittest.TestCase):
    def request(self, files=None, **changes):
        params = dict(session_id="rpc-example", text="Look at these",
                      files=files if files is not None else [dict(filename="shot.png", content_base64=b64(PNG))])
        params.update(changes)
        return dict(jsonrpc="2.0", id="example-1", method="deck.attach_submit", params=params)

    def run_submit(self, request, fail=None, shape=None):
        """fail: the native method that answers with an error; shape: {method: custom result}."""
        calls, counter = [], [0]

        def dispatch(req, transport=None):
            calls.append(req)
            method = req["method"]
            if method == fail:
                return dict(jsonrpc="2.0", id=req["id"], error={"message": "Rejected"})
            if shape and method in shape:
                return dict(jsonrpc="2.0", id=req["id"], result=shape[method])
            counter[0] += 1
            if method == "image.attach_bytes":
                result = {"attached": True, "path": f"/srv/example/queued-{counter[0]}.png"}
            elif method == "file.attach":
                name = req["params"]["name"]
                result = {"attached": True, "name": name, "ref_text": f"@file:uploads/{name}"}
            elif method == "image.detach":
                result = {"detached": True}
            else:
                result = {"status": "streaming"}
            return dict(jsonrpc="2.0", id=req["id"], result=result)
        return submit_attachments(request, dispatch, None), calls

    def test_image_goes_native_and_text_is_unchanged(self):
        reply, calls = self.run_submit(self.request())
        self.assertEqual([c["method"] for c in calls], ["image.attach_bytes", "prompt.submit"])
        self.assertEqual(calls[0]["params"]["filename"], "shot.png")
        self.assertEqual(calls[1]["params"], {"session_id": "rpc-example", "text": "Look at these"})
        self.assertEqual(reply["result"], {"status": "streaming"})

    def test_image_extension_follows_the_bytes_not_the_name(self):
        _, calls = self.run_submit(self.request([dict(filename="photo.txt", content_base64=b64(JPEG))]))
        self.assertEqual(calls[0]["method"], "image.attach_bytes")
        self.assertEqual(calls[0]["params"]["filename"], "photo.jpg")

    def test_other_files_use_file_attach_and_refs_enter_the_prompt(self):
        files = [dict(filename="clip.mp4", content_base64=b64(MP4)),
                 dict(filename="notes.txt", content_base64=b64(b"hello")),
                 dict(filename="paper.pdf", content_base64=b64(b"%PDF-1.7\nx")),
                 dict(filename="pic.png", content_base64=b64(PNG))]
        reply, calls = self.run_submit(self.request(files))
        self.assertEqual([c["method"] for c in calls],
                         ["file.attach", "file.attach", "file.attach", "image.attach_bytes", "prompt.submit"])
        self.assertTrue(all(not c["method"].startswith("pdf.") for c in calls))
        first = calls[0]["params"]
        self.assertEqual((first["session_id"], first["name"]), ("rpc-example", "clip.mp4"))
        self.assertTrue(first["data_url"].startswith("data:application/octet-stream;base64,"))
        text = calls[-1]["params"]["text"]
        self.assertEqual(text, "Look at these\n\n@file:uploads/clip.mp4\n@file:uploads/notes.txt\n@file:uploads/paper.pdf")
        self.assertNotIn("/srv/example", str(reply))

    def test_empty_text_gets_a_short_default(self):
        _, calls = self.run_submit(self.request([dict(filename="a.txt", content_base64=b64(b"x"))], text="  "))
        self.assertTrue(calls[-1]["params"]["text"].startswith(observer.ATTACH_DEFAULT_TEXT))
        self.assertIn("@file:uploads/a.txt", calls[-1]["params"]["text"])

    def test_rejected_submit_detaches_every_queued_image(self):
        files = [dict(filename="a.png", content_base64=b64(PNG)), dict(filename="b.jpg", content_base64=b64(JPEG)),
                 dict(filename="c.txt", content_base64=b64(b"x"))]
        reply, calls = self.run_submit(self.request(files), fail="prompt.submit")
        self.assertIn("error", reply)
        detached = [c["params"]["path"] for c in calls if c["method"] == "image.detach"]
        self.assertEqual(detached, ["/srv/example/queued-1.png", "/srv/example/queued-2.png"])
        self.assertEqual(calls[-1]["method"], "image.detach")

    def test_failed_file_attach_detaches_images_and_never_submits(self):
        files = [dict(filename="a.png", content_base64=b64(PNG)), dict(filename="c.txt", content_base64=b64(b"x"))]
        reply, calls = self.run_submit(self.request(files), fail="file.attach")
        self.assertEqual(reply["error"]["message"], "Rejected")
        self.assertEqual([c["method"] for c in calls], ["image.attach_bytes", "file.attach", "image.detach"])

    def test_failed_image_attach_detaches_earlier_images(self):
        files = [dict(filename="a.png", content_base64=b64(PNG)), dict(filename="b.png", content_base64=b64(PNG))]
        calls_seen = []

        def dispatch(req, transport=None):
            calls_seen.append(req["method"])
            if req["method"] == "image.attach_bytes" and calls_seen.count("image.attach_bytes") == 2:
                return dict(jsonrpc="2.0", id=req["id"], error={"message": "Rejected"})
            return dict(jsonrpc="2.0", id=req["id"], result={"attached": True, "path": "/srv/example/one.png"})
        reply = submit_attachments(self.request(files), dispatch, None)
        self.assertIn("error", reply)
        self.assertEqual(calls_seen, ["image.attach_bytes", "image.attach_bytes", "image.detach"])

    def test_a_native_reply_without_the_expected_shape_is_an_error(self):
        reply, calls = self.run_submit(self.request([dict(filename="a.txt", content_base64=b64(b"x"))]),
                                       shape={"file.attach": {"attached": True}})
        self.assertIn("error", reply)
        self.assertNotIn("prompt.submit", [c["method"] for c in calls])

    def test_a_raising_dispatch_detaches_queued_images(self):
        seen = []

        def dispatch(req, transport=None):
            seen.append(req["method"])
            if req["method"] == "file.attach":
                raise RuntimeError("gateway gone")
            return dict(jsonrpc="2.0", id=req["id"], result={"attached": True, "path": "/srv/example/one.png"})
        files = [dict(filename="a.png", content_base64=b64(PNG)), dict(filename="c.txt", content_base64=b64(b"x"))]
        with self.assertRaises(RuntimeError):
            submit_attachments(self.request(files), dispatch, None)
        self.assertEqual(seen, ["image.attach_bytes", "file.attach", "image.detach"])

    def test_trust_boundary_rejects_before_any_native_call(self):
        ok = dict(filename="a.txt", content_base64=b64(b"x"))
        bad_requests = [
            self.request(path="/etc/passwd"),
            self.request(session_id=""), self.request(session_id="a b"), self.request(session_id=5),
            self.request(text=5), self.request(text="x" * 32001),
            self.request(files=[]), self.request(files="x"), self.request(files=[ok] * 11),
            self.request(files=[dict(filename="../a.txt", content_base64=b64(b"x"))]),
            self.request(files=[dict(filename="dir/a.txt", content_base64=b64(b"x"))]),
            self.request(files=[dict(filename="dir\\a.txt", content_base64=b64(b"x"))]),
            self.request(files=[dict(filename="a\x00.txt", content_base64=b64(b"x"))]),
            self.request(files=[dict(filename="a\n.txt", content_base64=b64(b"x"))]),
            self.request(files=[dict(filename="", content_base64=b64(b"x"))]),
            self.request(files=[dict(filename="...", content_base64=b64(b"x"))]),
            self.request(files=[dict(filename="x" * 161, content_base64=b64(b"x"))]),
            self.request(files=[dict(filename="a.txt", content_base64="not base64!")]),
            self.request(files=[dict(filename="a.txt", content_base64="abc")]),
            self.request(files=[dict(filename="a.txt", content_base64="")]),
            self.request(files=[dict(filename="a.txt", content_base64=b64(b"x"), path="/etc/passwd")]),
            self.request(files=[dict(filename="a.txt")]),
            self.request(files=[ok, "x"]),
        ]
        for request in bad_requests:
            reply, calls = self.run_submit(request)
            self.assertIn("error", reply, request["params"])
            self.assertEqual(calls, [])

    def test_size_caps_per_file_and_in_total(self):
        big = b64(b"x" * (observer.ATTACH_FILE_MAX + 1))
        reply, calls = self.run_submit(self.request([dict(filename="big.bin", content_base64=big)]))
        self.assertIn("25 MB", reply["error"]["message"])
        self.assertEqual(calls, [])
        exact = b64(b"x" * observer.ATTACH_FILE_MAX)
        files = [dict(filename=f"f{i}.bin", content_base64=exact) for i in range(3)]
        reply, calls = self.run_submit(self.request(files))
        self.assertIn("50 MB", reply["error"]["message"])
        self.assertEqual(calls, [])
        reply, calls = self.run_submit(self.request(files[:2]))
        self.assertEqual(reply["result"], {"status": "streaming"})
        self.assertEqual(len(calls), 3)

    def test_line_limits_agree_between_stream_and_observer(self):
        self.assertEqual(stream.ATTACH_METHOD, observer.ATTACH_METHOD)
        self.assertEqual(stream.ATTACH_LINE_MAX, observer.ATTACH_LINE_MAX)
        # the whole message (total cap as base64) must fit the line, and the line stays bounded
        self.assertGreater(observer.ATTACH_LINE_MAX, observer.ATTACH_TOTAL_MAX * 4 // 3 + observer.ATTACH_MAX_FILES * 400)
        self.assertLess(observer.ATTACH_LINE_MAX, 80 * 1024 * 1024)
        self.assertNotIn(observer.ATTACH_METHOD, observer.ALLOWED_METHODS)  # served natively, never forwarded as-is


if __name__ == "__main__":
    unittest_main()
