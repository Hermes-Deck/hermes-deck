"""Public-content guard regression tests; git is stubbed, no repository writes."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

CHECK = Path(__file__).with_name("check-public.sh")


class PublicContentTests(unittest.TestCase):
    def check(self, files, tracked=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, data in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data.encode() if isinstance(data, str) else data)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            git = bin_dir / "git"
            git.write_text("#!/usr/bin/env python3\nimport json, os, sys\n"
                           "if sys.argv[1] == 'rev-parse': print(os.getcwd())\n"
                           "elif sys.argv[1] == 'ls-files': sys.stdout.write('\\0'.join(json.loads(os.environ['TEST_TRACKED'])) + '\\0')\n"
                           "else: sys.exit(2)\n")
            git.chmod(0o755)
            env = {**os.environ, "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
                   "TEST_TRACKED": json.dumps(list(files) if tracked is None else tracked)}
            return subprocess.run(["bash", str(CHECK)], cwd=root, env=env, capture_output=True, text=True)

    def test_clean_and_untracked_private_data(self):
        result = self.check({"README.md": "Public example", "private.txt": "/" + "root/private"}, ["README.md"])
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("1 tracked files checked, 0 findings", result.stdout)

    def test_each_identifier_is_rejected(self):
        values = ["/" + "root/private", "/" + "srv/private", "192." + "168.1.2", "person@" + "gmail.com", "private" + "." + "local"]
        for value in values:
            with self.subTest(value=value):
                result = self.check({"README.md": value})
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn("README.md:1:", result.stdout)

    def test_synthetic_exception_does_not_hide_another_identifier_on_same_line(self):
        result = self.check({"app/test/fake-stream.js": "/" + "srv/example/out/report.txt " + "/" + "root/private"})
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("1 findings", result.stdout)

    def test_synthetic_fixture_and_code_property_are_allowed(self):
        result = self.check({"app/test/fake-stream.js": "/" + "srv/example/out/report.txt",
                             "app/test/browser-transfer-e2e.test.js": "source." + "local.push();"})
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_per_user_command_path_is_allowed_but_hostname_is_rejected(self):
        result = self.check({"relay/.env.example": "~/" + "." + "local/bin/hermes"})
        self.assertEqual(result.returncode, 0, result.stdout)
        result = self.check({"relay/.env.example": "~/" + "." + "local/bin/hermes box." + "local"})
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("relay/.env.example:1:", result.stdout)
        self.assertIn("1 findings", result.stdout)

    def test_checker_scans_its_own_definitions_without_false_positives(self):
        result = self.check({"scripts/check-public.sh": CHECK.read_text(),
                             "scripts/test_check_public.py": Path(__file__).read_text()})
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_large_binary_is_rejected(self):
        result = self.check({"large.bin": b"\0" * (5 * 1024 * 1024 + 1)})
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("file exceeds 5 MiB", result.stdout)

    def test_limit_sized_binary_is_allowed(self):
        result = self.check({"limit.bin": b"\0" * (5 * 1024 * 1024)})
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_missing_tracked_file_is_a_staged_deletion(self):
        result = self.check({}, ["removed.txt"])
        self.assertEqual(result.returncode, 0, result.stdout)


if __name__ == "__main__":
    unittest.main()
