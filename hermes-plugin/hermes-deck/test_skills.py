"""The agent skills the plugin ships (skills/<name>/SKILL.md, registered through Hermes' ctx.register_skill)."""
from __future__ import annotations

import importlib.util
import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_plugin():
    for key in [k for k in sys.modules if k.startswith("_hermes_deck_plugin_")]:
        del sys.modules[key]
    spec = importlib.util.spec_from_file_location("hermes_deck_plugin_skills_test", HERE / "__init__.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def frontmatter(text: str) -> dict:
    match = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    assert match, "SKILL.md starts with YAML frontmatter"
    out = {}
    for line in match.group(1).splitlines():
        m = re.match(r"^([a-z_]+):\s*(.*)$", line)
        if m:
            out[m.group(1)] = m.group(2).strip().strip('"')
    return out


class SkillTests(unittest.TestCase):
    def setUp(self):
        self.plugin = load_plugin()

    def test_every_skill_is_registered_by_name_path_and_description(self):
        seen = []

        class Ctx:
            def register_skill(self, name, path, description="", frontmatter=None):
                seen.append((name, Path(path), description))

        self.plugin._register_skills(Ctx())
        self.assertEqual([s[0] for s in seen], ["pair-phone"])
        name, path, description = seen[0]
        self.assertTrue(path.is_file(), path)
        self.assertEqual(path, HERE / "skills" / "pair-phone" / "SKILL.md")
        meta = frontmatter(path.read_text(encoding="utf-8"))
        self.assertEqual(meta["name"], name)
        self.assertEqual(meta["description"], description)
        self.assertTrue(description.startswith("Use when "))

    def test_an_older_hermes_without_plugin_skills_and_a_failing_registration_are_skipped(self):
        self.plugin._register_skills(object())  # no register_skill: nothing happens

        class Failing:
            def register_skill(self, *args, **kwargs):
                raise ValueError("refused")

        with self.assertLogs(self.plugin.logger, "WARNING"):
            self.plugin._register_skills(Failing())  # logged, never raised

    def test_the_installer_ships_every_skill_file(self):
        install = importlib.util.module_from_spec(spec := importlib.util.spec_from_file_location("hd_install_skills", HERE / "install.py"))
        spec.loader.exec_module(install)
        for name, _ in self.plugin.SKILLS:
            self.assertIn(f"skills/{name}/SKILL.md", install.SOURCE_FILES)

    def test_pair_phone_never_prints_the_code_and_uses_the_page_tool(self):
        text = (HERE / "skills" / "pair-phone" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("node tools/mobile-token.js page --json", text)
        self.assertIn("Never put the pairing code in the chat", text)
        self.assertIn("Do not open, fetch or screenshot the link yourself", text)
        self.assertIn("telefonumu Deck'e bağla", text)  # Turkish trigger phrases
        self.assertNotRegex(text, r"\b[0-9a-f]{32}\b")  # no example code


if __name__ == "__main__":
    unittest.main()
