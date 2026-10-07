"""Offline tests for the read-only Deck doctor. Run with unittest discovery."""
import contextlib
import io
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import doctor


class DoctorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.repo = self.root / "repo"
        self.repo.mkdir()
        (self.repo / "compat.json").write_text(json.dumps({
            "version": "1.0.0", "protocol": 1, "minHermes": "0.10.0"
        }))

    def run_doctor(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = doctor.main(["--home", str(self.home), "--repo", str(self.repo),
                                "--hermes-version", "0.20.0", "--json", *args])
        return code, json.loads(out.getvalue())

    def profile(self, name="default", enabled=True, version: str | None = "1.0.0", protocol=1):
        home = self.home if name == "default" else self.home / "profiles" / name
        home.mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text(
            "plugins:\n  enabled: [hermes-deck]\n" if enabled else "plugins: {enabled: []}\n")
        (home / "plugins" / "hermes-deck").mkdir(parents=True, exist_ok=True)
        (home / "hermes-deck").mkdir(exist_ok=True)
        if version is not None:
            (home / "hermes-deck" / "installed.json").write_text(
                json.dumps({"version": version, "protocol": protocol}))
        (self.home / "hermes-deck").mkdir(exist_ok=True)
        (self.home / "hermes-deck" / "stream.py").write_text("# fake bridge\n")
        return home

    def test_profile_without_plugin(self):
        self.home.mkdir()
        (self.home / "config.yaml").write_text("plugins: {enabled: []}\n")
        code, report = self.run_doctor()
        self.assertEqual(code, 1)
        self.assertFalse(report["profiles"][0]["plugin_present"])
        self.assertFalse(report["profiles"][0]["enabled"])

    def test_enabled_installed_profiles_and_profile_home_normalization(self):
        self.profile()
        other = self.profile("research")
        code, report = self.run_doctor("--home", str(other))
        self.assertEqual(code, 0)
        self.assertEqual([p["name"] for p in report["profiles"]], ["default", "research"])
        self.assertTrue(all(p["enabled"] for p in report["profiles"]))
        self.assertEqual(report["profiles"][1]["version"], "1.0.0")
        self.assertTrue(report["stream_present"])

    def test_older_installed_version_is_problem(self):
        self.profile(version="0.3.5")
        code, report = self.run_doctor()
        self.assertEqual(code, 1)
        self.assertTrue(any(c["check"].endswith("version") and c["status"] == "problem"
                            for c in report["checks"]))

    def test_missing_metadata_is_unknown_not_crash(self):
        self.profile(version=None)
        code, report = self.run_doctor()
        self.assertEqual(code, 0)
        self.assertEqual(report["profiles"][0]["version"], "unknown, pre-0.3.6")

    def test_unreadable_config_does_not_leak_exception_text(self):
        home = self.profile()
        original = Path.read_text
        def denied(path, *args, **kwargs):
            if path == home / "config.yaml":
                raise PermissionError("SECRET_FIXTURE")
            return original(path, *args, **kwargs)
        with patch.object(Path, "read_text", denied):
            code, report = self.run_doctor()
        self.assertEqual(code, 1)
        self.assertNotIn("SECRET_FIXTURE", json.dumps(report))
        self.assertIsNone(report["profiles"][0]["enabled"])

    def test_old_hermes_is_problem(self):
        self.profile()
        code, _ = self.run_doctor("--hermes-version", "0.9.0")
        self.assertEqual(code, 1)

    def test_protocol_mismatch_is_problem(self):
        self.profile(protocol=2)
        code, _ = self.run_doctor()
        self.assertEqual(code, 1)

    def test_malformed_config_does_not_echo_yaml(self):
        home = self.profile()
        (home / "config.yaml").write_text("plugins: [SECRET_FIXTURE\n")
        code, report = self.run_doctor()
        self.assertEqual(code, 1)
        self.assertNotIn("SECRET_FIXTURE", json.dumps(report))

    def test_no_pyyaml_cannot_run(self):
        self.profile()
        with patch.object(doctor, "yaml", None):
            code, _ = self.run_doctor()
        self.assertEqual(code, 2)

    def test_invalid_compat_cannot_run(self):
        self.profile()
        (self.repo / "compat.json").write_text('{"token": "SECRET_FIXTURE"}')
        code, report = self.run_doctor()
        self.assertEqual(code, 2)
        self.assertNotIn("SECRET_FIXTURE", json.dumps(report))

    def test_relay_health_filters_secrets_and_checks_versions(self):
        self.profile()
        def health(url, timeout):
            self.assertEqual(url, "http://127.0.0.1:9330/health")
            return {"v": "1.0.0", "protocol": 1,
                    "plugins": {"default": {"version": "1.0.0", "protocol": 1,
                                            "token": "SECRET_FIXTURE"}}, "token": "SECRET_FIXTURE"}
        with patch.object(doctor, "fetch_health", health):
            code, report = self.run_doctor("--relay", "http://127.0.0.1:9330")
        self.assertEqual(code, 0)
        self.assertEqual(report["relay"]["v"], "1.0.0")
        self.assertNotIn("SECRET_FIXTURE", json.dumps(report))

    def test_relay_failure_does_not_echo_exception(self):
        self.profile()
        with patch.object(doctor, "fetch_health", side_effect=OSError("SECRET_FIXTURE")):
            code, report = self.run_doctor("--relay", "http://127.0.0.1:9330")
        self.assertEqual(code, 1)
        self.assertNotIn("SECRET_FIXTURE", json.dumps(report))

    def test_relay_credentials_in_url_rejected_without_request(self):
        self.profile()
        with patch.object(doctor, "fetch_health") as fetch:
            code, report = self.run_doctor("--relay", "http://user:SECRET_FIXTURE@example.com?token=x")
        self.assertEqual(code, 2)
        fetch.assert_not_called()
        self.assertNotIn("SECRET_FIXTURE", json.dumps(report))

    def test_node_and_env_mode_without_env_read(self):
        self.profile()
        relay = self.root / "relay"
        relay.mkdir()
        env = relay / ".env"
        env.write_text("DECK_RELAY_TOKEN=SECRET_FIXTURE\n")
        env.chmod(0o600)
        original = Path.read_text
        def guard(path, *args, **kwargs):
            self.assertNotEqual(path, env)
            return original(path, *args, **kwargs)
        with patch.object(doctor, "node_version", return_value="22.12.0"), patch.object(Path, "read_text", guard):
            code, report = self.run_doctor("--relay-dir", str(relay))
        self.assertEqual(code, 1)
        self.assertTrue(report["relay_env"]["exists"])
        if os.name != "nt":
            self.assertEqual(report["relay_env"]["mode"], "0600")
        self.assertNotIn("SECRET_FIXTURE", json.dumps(report))

    def test_static_hermes_metadata_does_not_execute_launcher(self):
        self.profile()
        installation = self.root / "hermes-agent"
        installation.mkdir()
        (installation / "install-stamp.json").write_text(json.dumps({"baseVersion": "0.20.0"}))
        code, report = self.run_doctor("--hermes-version", "", "--hermes-dir", str(installation))
        self.assertEqual(code, 0)
        self.assertEqual(report["hermes_version"], "0.20.0")

    def test_doctor_does_not_change_home_contents_or_modes(self):
        self.profile()
        def snapshot():
            return {str(p.relative_to(self.home)): (p.read_bytes(), p.stat().st_mode, p.stat().st_mtime_ns)
                    for p in self.home.rglob("*") if p.is_file()}
        before = snapshot()
        self.run_doctor()
        self.assertEqual(before, snapshot())

    def test_relay_plugin_version_map_matches_shared_contract(self):
        self.profile()
        with patch.object(doctor, "fetch_health", return_value={
                "ok": True, "v": "1.0.0", "protocol": 1,
                "plugins": {"default": "1.0.0", "research": None}}):
            code, report = self.run_doctor("--relay", "http://127.0.0.1:9330")
        self.assertEqual(code, 0)
        self.assertEqual(report["relay"]["plugins"], {"default": "1.0.0", "research": None})

    def test_invalid_health_not_success(self):
        self.profile()
        with patch.object(doctor, "fetch_health", return_value={"ok": False, "token": "SECRET_FIXTURE"}):
            code, report = self.run_doctor("--relay", "http://127.0.0.1:9330")
        self.assertEqual(code, 1)
        self.assertNotIn("SECRET_FIXTURE", json.dumps(report))

    def test_incomplete_http_response_is_problem(self):
        from http.client import IncompleteRead
        self.profile()
        with patch.object(doctor, "fetch_health", side_effect=IncompleteRead(b"SECRET_FIXTURE", 20)):
            code, report = self.run_doctor("--relay", "http://127.0.0.1:9330")
        self.assertEqual(code, 1)
        self.assertNotIn("SECRET_FIXTURE", json.dumps(report))

    def test_untrusted_version_override_not_printed(self):
        self.profile()
        code, report = self.run_doctor("--hermes-version", "SECRET_FIXTURE")
        self.assertEqual(code, 2)
        self.assertNotIn("SECRET_FIXTURE", json.dumps(report))

    def test_no_hermes_subprocess_in_default_diagnosis(self):
        self.profile()
        with patch.object(doctor.subprocess, "run", side_effect=AssertionError("must not execute Hermes")):
            code, _ = self.run_doctor()
        self.assertEqual(code, 0)

    def test_explicit_disabled_plugin_is_problem(self):
        home = self.profile()
        (home / "config.yaml").write_text("plugins: {enabled: [hermes-deck], disabled: [hermes-deck]}\n")
        code, report = self.run_doctor()
        self.assertEqual(code, 1)
        self.assertFalse(report["profiles"][0]["enabled"])

    def test_corrupt_installed_metadata_is_problem_without_echo(self):
        home = self.profile()
        (home / "hermes-deck" / "installed.json").write_text('{"secret":"SECRET_FIXTURE"}')
        code, report = self.run_doctor()
        self.assertEqual(code, 1)
        self.assertNotIn("SECRET_FIXTURE", json.dumps(report))

    def test_human_table(self):
        self.profile()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = doctor.main(["--home", str(self.home), "--repo", str(self.repo),
                                "--hermes-version", "0.20.0"])
        self.assertEqual(code, 0)
        self.assertIn("CHECK", out.getvalue())
        self.assertIn("default/config", out.getvalue())

    def test_real_installer_fake_home_round_trip(self):
        self.home.mkdir()
        named = self.home / "profiles" / "research"
        named.mkdir(parents=True)
        for home in (self.home, named):
            (home / "config.yaml").write_text("model: {default: synthetic-model}\nplugins: {enabled: []}\n")
        repo = Path(__file__).resolve().parents[1]
        command = [sys.executable, "-B", str(repo / "hermes-plugin" / "hermes-deck" / "install.py"),
                   "--profile", "default", "--profile", "research"]
        env = dict(os.environ, HERMES_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1")
        def run(*args):
            completed = subprocess.run([*command, *args], capture_output=True, text=True,
                                       env=env, timeout=30, cwd=repo)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            return completed.stdout
        before = {str(p): p.read_bytes() for p in self.home.rglob("*") if p.is_file()}
        self.assertIn("Dry run: nothing was changed.", run("--dry-run"))
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.home.rglob("*") if p.is_file()})
        run()
        for home in (self.home, named):
            self.assertTrue((home / "plugins" / "hermes-deck" / "plugin.yaml").is_file())
            config = doctor.yaml.safe_load((home / "config.yaml").read_text())
            self.assertIn("hermes-deck", config["plugins"]["enabled"])
            self.assertEqual(config["model"]["default"], "synthetic-model")
        self.assertTrue((self.home / "hermes-deck" / "stream.py").is_file())
        run("--uninstall", "--dry-run")
        run("--uninstall")
        for home in (self.home, named):
            self.assertFalse((home / "plugins" / "hermes-deck").exists())
            self.assertNotIn("hermes-deck", doctor.yaml.safe_load((home / "config.yaml").read_text())["plugins"]["enabled"])
        self.assertTrue((self.home / "hermes-deck" / "stream.py").is_file())

    def test_loopback_http_transport_and_redirect_guard(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/health")
                    self.end_headers()
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True, "v": "1.0.0"}).encode())
            def log_message(self, format, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = "http://127.0.0.1:%d" % server.server_port
            self.assertEqual(doctor.fetch_health(url + "/health", 2)["v"], "1.0.0")
            with self.assertRaises(HTTPError):
                doctor.fetch_health(url + "/redirect", 2)
            self.assertEqual(requests, ["/health", "/redirect"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_setup_skill_frontmatter_and_required_sections(self):
        skill = Path(__file__).resolve().parents[1] / "skills" / "hermes-deck-setup" / "SKILL.md"
        text = skill.read_text()
        self.assertTrue(text.startswith("---\n"))
        metadata, body = text[4:].split("\n---\n", 1)
        parsed = doctor.yaml.safe_load(metadata)
        self.assertEqual(parsed["name"], "hermes-deck-setup")
        self.assertEqual(parsed["description"], "Use when installing, updating or diagnosing Hermes Deck on a Hermes host.")
        self.assertEqual(parsed["license"], "MIT")
        self.assertIn("version", parsed)
        self.assertIn("tags", parsed["metadata"]["hermes"])
        for section in ("When to Use", "Procedure", "Pitfalls", "Verification"):
            self.assertIn("## " + section, body)

    def test_missing_home_is_problem_without_creating_it(self):
        code, report = self.run_doctor()
        self.assertEqual(code, 1)
        self.assertFalse(self.home.exists())
        self.assertTrue(any(c["check"] == "home" and c["status"] == "problem"
                            for c in report["checks"]))


if __name__ == "__main__":
    unittest.main()
