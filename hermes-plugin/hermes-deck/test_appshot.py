"""Headless appshot admission and native routing; no desktop, gateway, Telegram or network."""
import base64
import unittest
from observer import submit_appshot
from testsupport import unittest_main


class AppshotTests(unittest.TestCase):
    def request(self, **changes):
        params = dict(session_id="rpc-example", text="Describe this", filename="appshot.png",
                      content_base64=base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * 70000).decode())
        params.update(changes)
        return dict(jsonrpc="2.0", id="example-1", method="deck.appshot", params=params)

    def run_submit(self, request, fail=False):
        calls = []
        def dispatch(req, transport=None):
            calls.append(req)
            result = {"attached": True, "path": "/srv/example/queued-image.png"} if req["method"] == "image.attach_bytes" else {"status": "streaming"}
            return dict(jsonrpc="2.0", id=req["id"], **({"error": {"message": "Rejected"}} if fail and req["method"] == "prompt.submit" else {"result": result}))
        return submit_appshot(request, dispatch, None), calls

    def test_native_same_session_and_no_path_in_reply(self):
        reply, calls = self.run_submit(self.request())
        self.assertEqual([r["method"] for r in calls], ["image.attach_bytes", "prompt.submit"])
        self.assertTrue(all(r["params"]["session_id"] == "rpc-example" for r in calls))
        self.assertEqual(reply["result"], {"status": "streaming"})

    def test_rejected_submit_detaches_before_next_message(self):
        reply, calls = self.run_submit(self.request(), fail=True)
        self.assertIn("error", reply)
        self.assertEqual(calls[-1]["method"], "image.detach")
        self.assertEqual(calls[-1]["params"], {"session_id": "rpc-example", "path": "/srv/example/queued-image.png"})

    def test_trust_boundary_rejects_paths_bad_bytes_and_size(self):
        for changes in (dict(path="/etc/passwd"), dict(filename="../image.png"), dict(content_base64="invalid"),
                        dict(text=""), dict(session_id=""), dict(content_base64=base64.b64encode(b"\xff\xd8\xff" + b"x"*1000000).decode())):
            reply, calls = self.run_submit(self.request(**changes))
            self.assertIn("error", reply)
            self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest_main()
