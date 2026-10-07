"""install.py on a made-up Hermes home (temporary folders only). Run with any Python 3.10+ that has PyYAML,
like Hermes' own:  python test_install.py

The home has three profiles: "default" with deck-events and an older stream.py, "research" with
deck-events and explicit Hermes Deck settings, "plain" with no plugins at all.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import shutil
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path

from testsupport import unittest_main

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("hermes_deck_install_under_test", HERE / "install.py")
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)
try:
    import yaml
except ImportError:                     # the installer needs it too; Hermes' Python always has it
    yaml = None

DEFAULT_CONFIG = """\
# Hermes config (test)
model:
  default: model-a   # keep this comment
plugins:
  enabled:
    - deck-events
    - other-plugin
agent:
  max_turns: 30
"""
RESEARCH_CONFIG = """\
model: {default: model-b}
plugins:
  enabled: [deck-events]
  entries:
    hermes-deck:
      settings:
        bridge: false
"""
PLAIN_CONFIG = "model:\n  default: model-c\n"
OLD_STREAM = b"# Hermes Desk stream.py (old)\n"


def tree(root: Path) -> dict:
    """path -> sha256 of every file under root (symlinks as their target text)."""
    out = {}
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root).as_posix()
        if p.is_symlink():
            out[rel] = "link:" + os.readlink(p)
        elif p.is_file():
            out[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


@unittest.skipIf(yaml is None, "PyYAML is not installed (run with Hermes' Python)")
class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="hermes-deck-install-test-")).resolve() / ".hermes"
        self.addCleanup(shutil.rmtree, self.root.parent, True)
        r = self.root
        (r / "plugins" / "deck-events").mkdir(parents=True)
        (r / "plugins" / "deck-events" / "plugin.yaml").write_text("name: deck-events\n")
        (r / "hermes-deck").mkdir()
        (r / "hermes-deck" / "stream.py").write_bytes(OLD_STREAM)
        (r / "config.yaml").write_text(DEFAULT_CONFIG, encoding="utf-8")
        research = r / "profiles" / "research"
        (research / "plugins" / "deck-events").mkdir(parents=True)
        (research / "plugins" / "deck-events" / "plugin.yaml").write_text("name: deck-events\n")
        (research / "config.yaml").write_text(RESEARCH_CONFIG, encoding="utf-8")
        (r / "profiles" / "plain").mkdir()
        (r / "profiles" / "plain" / "config.yaml").write_text(PLAIN_CONFIG, encoding="utf-8")
        (r / "profiles" / "no config").mkdir()            # not a profile: no config.yaml, bad name

    def run_installer(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = install.main(["--home", str(self.root), *args])
        self.output = out.getvalue() + err.getvalue()
        return rc

    def config(self, profile="default"):
        home = self.root if profile == "default" else self.root / "profiles" / profile
        return yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))

    def backups(self, folder: Path, name: str):
        return sorted(folder.glob(name + install.SUFFIX + "*"))

    # ------------------------------------------------------------------------------------------------

    def test_installer_plans_only_the_new_stream(self):
        plan = install.make_plan(self.root, install.find_profiles(self.root), False, yaml)
        self.assertEqual(plan["stream"]["path"], self.root / "hermes-deck" / "stream.py")
        self.assertNotIn("legacy_stream", plan)
        self.assertEqual(install.OLD_PLUGINS, ("deck-events",))

    def test_install_state_is_read_only_from_the_current_runtime(self):
        state = {"version": 1, "migrated": {"deck-events": {"was_enabled": True}}}
        retired = self.root / "retired-runtime"
        retired.mkdir()
        (retired / install.STATE_FILE).write_text(json.dumps(state))
        self.assertEqual(install.read_state(self.root), {})
        (self.root / "hermes-deck" / install.STATE_FILE).write_text(json.dumps(state))
        self.assertEqual(install.read_state(self.root), state)
        before = tree(retired)
        self.assertEqual(self.run_installer(), 0, self.output)
        self.assertEqual(tree(retired), before)
        self.assertFalse((retired / "stream.py").exists())

    def test_installed_stream_runs_in_isolated_python_and_preserves_arguments(self):
        self.assertEqual(self.run_installer(), 0, self.output)
        (self.root / "gateway_state.json").write_text(json.dumps({"pid": os.getpid(), "gateway_state": "running", "active_agents": 7}))
        for folder in ("hermes-deck",):
            for args in ([], ["--home", str(self.root)]):
                result = subprocess.run([sys.executable, "-I", str(self.root / folder / "stream.py"), *args],
                                        capture_output=True, text=True, timeout=10,
                                        env={**os.environ, "HERMES_HOME": str(self.root.parent / "wrong-home")})
                self.assertEqual(result.returncode, 0, result.stderr)
                snap = json.loads(result.stdout)
                self.assertEqual(snap["schema"], "hermes-deck.v1")
                self.assertEqual(snap["gateway"], {"running": True, "active_agents": 7})
        self.assertEqual((self.root / "hermes-deck" / "stream.py").read_bytes(), (HERE / "stream.py").read_bytes())

    def test_uninstall_retires_the_current_install_state(self):
        old = {"version": 1, "migrated": {"deck-events": {"was_enabled": True, "was_disabled": False}}}
        (self.root / "hermes-deck" / install.STATE_FILE).write_text(json.dumps(old))
        self.assertEqual(self.run_installer(), 0, self.output)
        self.assertEqual(install.read_state(self.root)["migrated"], old["migrated"])
        self.assertEqual(self.run_installer("--uninstall"), 0, self.output)
        self.assertEqual(install.read_state(self.root), {})
        self.assertEqual(len(self.backups(self.root / "hermes-deck", install.STATE_FILE)), 1)

    def test_install_records_the_version_per_profile_and_uninstall_removes_it(self):
        self.assertEqual(install.plugin_version(), json.loads((HERE.parent.parent / "compat.json").read_text())["version"])
        homes = (self.root, self.root / "profiles" / "research", self.root / "profiles" / "plain")
        self.assertEqual(self.run_installer("--dry-run"), 0, self.output)
        self.assertIn("record version " + install.plugin_version(), self.output)
        for home in homes:
            self.assertFalse((home / "hermes-deck" / install.INSTALLED_FILE).exists(), home)
        self.assertEqual(self.run_installer(), 0, self.output)
        for home in homes:
            record = json.loads((home / "hermes-deck" / install.INSTALLED_FILE).read_text(encoding="utf-8"))
            self.assertEqual(set(record), {"version", "protocol", "installedAt"})
            self.assertEqual(record["version"], install.plugin_version())
            self.assertEqual(record["protocol"], install.PROTOCOL)
            self.assertRegex(record["installedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(self.run_installer("--uninstall", "--dry-run"), 0, self.output)
        self.assertTrue((self.root / "hermes-deck" / install.INSTALLED_FILE).is_file())
        self.assertEqual(self.run_installer("--uninstall"), 0, self.output)
        for home in homes:
            self.assertFalse((home / "hermes-deck" / install.INSTALLED_FILE).exists(), home)

    def test_a_plugin_yaml_without_a_version_changes_nothing(self):
        stage = Path(tempfile.mkdtemp(prefix="hermes-deck-stage-"))
        self.addCleanup(shutil.rmtree, stage, True)
        for name in install.SOURCE_FILES:
            shutil.copy2(HERE / name, stage / name)
        (stage / "plugin.yaml").write_text("name: hermes-deck\n", encoding="utf-8")
        with self.assertRaises(install.InstallError):
            install.make_plan(self.root, install.find_profiles(self.root), False, yaml, stage)

    def test_dry_run_changes_nothing_and_says_what_it_would_do(self):
        before = tree(self.root)
        self.assertEqual(self.run_installer("--dry-run"), 0)
        self.assertEqual(tree(self.root), before)
        for text in ("profile default", "profile research", "profile plain", "turn off deck-events",
                     "hermes-deck/stream.py", "Dry run"):
            self.assertIn(text, self.output)

    def test_install_enables_hermes_deck_migrates_the_old_plugins_and_backs_up_first(self):
        self.assertEqual(self.run_installer(), 0, self.output)
        # default: deck-events off the way `hermes plugins disable` does it, everything else as it was
        cfg = self.config()
        self.assertEqual(cfg["plugins"], {"enabled": ["other-plugin", "hermes-deck"], "disabled": ["deck-events"]})
        self.assertEqual((cfg["model"], cfg["agent"]), ({"default": "model-a"}, {"max_turns": 30}))
        text = (self.root / "config.yaml").read_text(encoding="utf-8")
        self.assertIn("default: model-a   # keep this comment", text)
        (backup,) = self.backups(self.root, "config.yaml")
        self.assertEqual(backup.read_text(encoding="utf-8"), DEFAULT_CONFIG)
        # research: event plugin disabled, explicit bridge settings preserved
        cfg = self.config("research")
        self.assertEqual((cfg["plugins"]["enabled"], cfg["plugins"]["disabled"]), (["hermes-deck"], ["deck-events"]))
        self.assertEqual(cfg["plugins"]["entries"]["hermes-deck"], {"settings": {"bridge": False}})
        self.assertEqual(cfg["model"], {"default": "model-b"})
        # plain: just enabled
        self.assertEqual(self.config("plain")["plugins"], {"enabled": ["hermes-deck"]})
        # the plugin folder in every profile, exactly the allowlisted files
        for home in (self.root, self.root / "profiles" / "research", self.root / "profiles" / "plain"):
            target = home / "plugins" / "hermes-deck"
            self.assertEqual(sorted(p.name for p in target.iterdir()), sorted(install.SOURCE_FILES))
            for name in install.SOURCE_FILES:
                self.assertEqual((target / name).read_bytes(), (HERE / name).read_bytes(), name)
            self.assertFalse(list(home.glob(".hermes-deck-staging-*")))
        # old plugin folders and data paths stay
        self.assertTrue((self.root / "plugins" / "deck-events" / "plugin.yaml").is_file())
        self.assertTrue((self.root / "profiles" / "research" / "plugins" / "deck-events").is_dir())
        # update only the current stream path; keep its previous copy
        self.assertEqual((self.root / "hermes-deck" / "stream.py").read_bytes(), (HERE / "stream.py").read_bytes())
        (old,) = self.backups(self.root / "hermes-deck", "stream.py")
        self.assertEqual(old.read_bytes(), OLD_STREAM)
        # what --uninstall will need
        state = json.loads((self.root / "hermes-deck" / install.STATE_FILE).read_text(encoding="utf-8"))
        self.assertEqual(state["migrated"], {"deck-events": {"was_enabled": True, "was_disabled": False}})
        self.assertIn("stream.py", self.output)

    def test_the_installed_copy_loads_and_registers(self):
        self.assertEqual(self.run_installer("--profile", "plain"), 0, self.output)
        target = self.root / "profiles" / "plain" / "plugins" / "hermes-deck"
        hooks = {}
        env = {"HERMES_DECK_BRIDGE": "0", "DECK_EVENTS_DIR": str(self.root / "events")}
        saved = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        try:
            spec_ = importlib.util.spec_from_file_location("installed_hermes_deck", target / "__init__.py")
            plugin = importlib.util.module_from_spec(spec_)
            spec_.loader.exec_module(plugin)
            self.assertEqual(plugin.HERE, target.resolve())
            plugin.register(type("Ctx", (), {"register_hook": lambda self, n, fn: hooks.__setitem__(n, fn)})())
        finally:
            for k, v in saved.items():
                os.environ.pop(k) if v is None else os.environ.__setitem__(k, v)
            for key in [k for k in sys.modules if k.startswith("_hermes_deck_plugin_")]:
                del sys.modules[key]
        self.assertIn("pre_tool_call", hooks)
        self.assertIn("agent_loop_stopped", hooks)

    def test_running_it_again_updates_without_losing_what_it_migrated(self):
        self.assertEqual(self.run_installer(), 0)
        configs = {p: (self.root / p).read_bytes() for p in ("config.yaml", "profiles/research/config.yaml")}
        self.assertEqual(self.run_installer(), 0, self.output)
        self.assertEqual({p: (self.root / p).read_bytes() for p in configs}, configs)    # nothing to change
        self.assertEqual(len(self.backups(self.root, "config.yaml")), 1)
        self.assertEqual(len(self.backups(self.root / "hermes-deck", "stream.py")), 1)  # same stream: no new backup
        self.assertEqual(self.backups(self.root, "plugins"), [])                        # same plugin copy: left
        self.assertIn("already up to date", self.output)
        # an older (here: edited) copy is moved aside and replaced
        installed = self.root / "plugins" / "hermes-deck" / "events.py"
        installed.write_text("# an older version\n")
        self.assertEqual(self.run_installer("--profile", "default"), 0, self.output)
        (previous,) = self.backups(self.root, "plugins")
        self.assertEqual((previous / "hermes-deck" / "events.py").read_text(), "# an older version\n")
        self.assertEqual(installed.read_bytes(), (HERE / "events.py").read_bytes())
        state = json.loads((self.root / "hermes-deck" / install.STATE_FILE).read_text(encoding="utf-8"))
        self.assertIn("deck-events", state["migrated"])                                 # still known for --uninstall

    def test_uninstall_turns_back_on_what_it_replaced(self):
        self.assertEqual(self.run_installer(), 0)
        before = tree(self.root)
        self.assertEqual(self.run_installer("--uninstall", "--dry-run"), 0)
        self.assertEqual(tree(self.root), before)
        self.assertEqual(self.run_installer("--uninstall"), 0, self.output)
        cfg = self.config()["plugins"]
        self.assertEqual((sorted(cfg["enabled"]), cfg.get("disabled")), (["deck-events", "other-plugin"], []))
        cfg = self.config("research")["plugins"]
        self.assertEqual((cfg["enabled"], cfg.get("disabled")), (["deck-events"], []))
        self.assertEqual(self.config("plain")["plugins"]["enabled"], [])
        for home in (self.root, self.root / "profiles" / "research", self.root / "profiles" / "plain"):
            self.assertFalse((home / "plugins" / "hermes-deck").exists())
            (moved,) = self.backups(home, "plugins")
            self.assertTrue((moved / "hermes-deck" / "__init__.py").is_file())          # moved aside, not deleted
            self.assertFalse((home / "hermes-deck" / install.STATE_FILE).exists())
            self.assertEqual(len(self.backups(home, "config.yaml")), 2)
        self.assertEqual((self.root / "hermes-deck" / "stream.py").read_bytes(), (HERE / "stream.py").read_bytes())
        self.assertIn("turn deck-events back on", self.output)
        # and once more: nothing left to do
        before = tree(self.root)
        self.assertEqual(self.run_installer("--uninstall"), 0, self.output)
        self.assertEqual(tree(self.root), before)
        self.assertIn("not installed here", self.output)

    def test_a_problem_in_any_profile_changes_nothing_anywhere(self):
        research = self.root / "profiles" / "research" / "config.yaml"
        for bad in ("plugins:\n  enabled: [deck-events]\n  disabled: [hermes-deck]\n",   # explicitly off
                    "plugins:\n  enabled: deck-events\n",                                  # not a list
                    "- just\n- a list\n",                                                  # not a mapping
                    "plugins: {enabled: [a]}\nplugins: {enabled: [b]}\n",                  # duplicate key
                    "plugins: [unclosed\n"):                                               # not YAML
            with self.subTest(config=bad):
                research.write_text(bad, encoding="utf-8")
                before = tree(self.root)
                self.assertEqual(self.run_installer(), 1)
                self.assertEqual(tree(self.root), before)
                self.assertIn("Nothing was changed", self.output)
                self.assertIn(str(research), self.output)

    def test_profile_selection(self):
        self.assertEqual(self.run_installer("--profile", "nope"), 1)
        self.assertIn("nope", self.output)
        self.assertEqual(self.run_installer("--profile", "research"), 0, self.output)
        self.assertEqual(self.config()["plugins"]["enabled"], ["deck-events", "other-plugin"])   # default untouched
        self.assertEqual(self.config("research")["plugins"]["enabled"], ["hermes-deck"])
        self.assertFalse((self.root / "plugins" / "hermes-deck").exists())
        self.assertTrue((self.root / "hermes-deck" / "stream.py").read_bytes().startswith(b'"""hermes-deck'))

    def test_a_symlinked_plugin_folder_is_a_developer_checkout_and_is_left_alone(self):
        checkout = self.root.parent / "checkout"
        checkout.mkdir()
        (checkout / "marker").write_text("mine")
        link = self.root / "plugins" / "hermes-deck"
        try:
            link.symlink_to(checkout, target_is_directory=True)
        except OSError:
            self.skipTest("symlinks unavailable here")
        self.assertEqual(self.run_installer("--profile", "default"), 0, self.output)
        self.assertEqual(sorted(p.name for p in checkout.iterdir()), ["marker"])
        self.assertTrue(link.is_symlink())
        self.assertIn("hermes-deck", self.config()["plugins"]["enabled"])
        self.assertEqual(self.run_installer("--profile", "default", "--uninstall"), 0, self.output)
        self.assertTrue(link.is_symlink())
        self.assertNotIn("hermes-deck", self.config()["plugins"]["enabled"])

    def test_an_old_plugin_folder_that_is_not_enabled_is_left_as_it_is(self):
        (self.root / "profiles" / "plain" / "plugins" / "deck-events").mkdir(parents=True)
        self.assertEqual(self.run_installer("--profile", "plain"), 0, self.output)
        self.assertEqual(self.config("plain")["plugins"], {"enabled": ["hermes-deck"]})
        self.assertIn("deck-events is in plugins/ but not enabled", self.output)

    @unittest.skipIf(os.name == "nt", "POSIX file modes")
    def test_file_modes(self):
        (self.root / "config.yaml").chmod(0o644)
        self.assertEqual(self.run_installer("--profile", "default"), 0, self.output)
        self.assertEqual((self.root / "config.yaml").stat().st_mode & 0o777, 0o644)
        self.assertEqual((self.root / "plugins" / "hermes-deck").stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.root / "plugins" / "hermes-deck" / "events.py").stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.root / "hermes-deck" / "stream.py").stat().st_mode & 0o777, 0o600)


@unittest.skipIf(yaml is None, "PyYAML is not installed (run with Hermes' Python)")
class RewriteTests(unittest.TestCase):
    NEW = {"enabled": ["hermes-deck"], "disabled": ["deck-events"]}

    def rewrite(self, text):
        out = install.rewrite_plugins(text, yaml, self.NEW)
        self.assertEqual(yaml.safe_load(out)["plugins"], self.NEW)
        return out

    def test_only_the_plugins_value_changes(self):
        self.assertEqual(self.rewrite("a: 1  # one\nplugins:\n  enabled:\n    - deck-events\nb: 2  # two\n"),
                         "a: 1  # one\nplugins: {enabled: [hermes-deck], disabled: [deck-events]}\nb: 2  # two\n")
        self.assertEqual(self.rewrite("plugins: {enabled: [deck-events]}\nb: 2\n"),
                         "plugins: {enabled: [hermes-deck], disabled: [deck-events]}\nb: 2\n")
        self.assertEqual(self.rewrite("plugins:\nb: 2\n"), "plugins: {enabled: [hermes-deck], disabled: [deck-events]}\nb: 2\n")
        self.assertEqual(self.rewrite("b: 2"), "b: 2\nplugins: {enabled: [hermes-deck], disabled: [deck-events]}\n")
        self.assertEqual(self.rewrite(""), "plugins: {enabled: [hermes-deck], disabled: [deck-events]}\n")
        self.assertEqual(self.rewrite("b: 2\nplugins:\n  enabled:\n  - x"),
                         "b: 2\nplugins: {enabled: [hermes-deck], disabled: [deck-events]}\n")
        self.assertEqual(self.rewrite("a: 1\r\nplugins:\r\n  enabled: [x]\r\nb: 2\r\n"),
                         "a: 1\r\nplugins: {enabled: [hermes-deck], disabled: [deck-events]}\r\nb: 2\r\n")

    def test_unchanged_plugins_leave_the_text_alone(self):
        text = "plugins:\n  enabled:\n    - hermes-deck   # mine\n  disabled:\n    - deck-events\n"
        self.assertEqual(install.rewrite_plugins(text, yaml, self.NEW), text)

    def test_the_home_from_hermes_home(self):
        root = Path(tempfile.gettempdir()) / "hh" / ".hermes"
        self.assertEqual(install.hermes_root(None, {"HERMES_HOME": str(root / "profiles" / "x")}), root.resolve())
        self.assertEqual(install.hermes_root(None, {"HERMES_HOME": str(root)}), root.resolve())
        self.assertEqual(install.hermes_root(str(root), {"HERMES_HOME": "/elsewhere"}), root.resolve())
        self.assertEqual(install.hermes_root(None, {}), (Path.home() / ".hermes").resolve())


if __name__ == "__main__":
    if yaml is None:
        print("SKIP: PyYAML is not installed; run this with Hermes' own Python (or pip install pyyaml).")
    unittest_main()
