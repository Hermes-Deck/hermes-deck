"""Install, update or remove the hermes-deck Hermes plugin on the machine where Hermes runs.

    python install.py                     install or update it in every profile of the Hermes home
    python install.py --profile research  only these profiles (repeatable; "default" is the home itself)
    python install.py --dry-run           print what would change and change nothing
    python install.py --uninstall         turn hermes-deck off and turn back on what it replaced

Run it with Hermes' own Python, which has PyYAML: ~/.hermes/hermes-agent/venv/bin/python install.py

For each profile it
  - backs up config.yaml as config.yaml.bak-hermes-deck-<timestamp> before changing it;
  - adds hermes-deck to plugins.enabled and disables deck-events; its folder and data remain untouched;
  - copies the plugin into <profile home>/plugins/hermes-deck/. An existing copy is moved to
    plugins.bak-hermes-deck-<timestamp>/ first; a symlinked folder (a developer checkout) is left alone;
  - records migration state in <profile home>/hermes-deck/hermes-deck-install.json, for --uninstall;
  - writes <profile home>/hermes-deck/installed.json ({version, protocol, installedAt}; --uninstall removes it).
Once per Hermes home it writes <home>/hermes-deck/stream.py; existing copies are backed up before replacement.
Older bridge installations require manual migration; no other runtime directory is read or written.
Every profile's plan is checked before anything is written; on a problem nothing is changed.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from pathlib import Path

PLUGIN = "hermes-deck"
RUNTIME_DIR = PLUGIN
OLD_PLUGINS = ("deck-events",)
SOURCE_FILES = ("__init__.py", "events.py", "observer.py", "stream.py", "plugin.yaml")
STATE_FILE = "hermes-deck-install.json"  # in the profile runtime directory
# <profile home>/hermes-deck/installed.json: {version, protocol, installedAt}. The relay reads it to report each
# profile's plugin version (relay/src/compat.js); scripts/doctor.py reads it too. Keep the names.
INSTALLED_FILE = "installed.json"
PROTOCOL = 1  # the wire protocol; equal to compat.json "protocol" (relay/test/compat.test.js)

SUFFIX = ".bak-hermes-deck-"
PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
HERE = Path(__file__).resolve().parent


class InstallError(Exception):
    """A problem found while planning: nothing has been changed."""


def stamp_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")


# ---------------------------------------------------------------------------- where

def hermes_root(value=None, environ=None) -> Path:
    """The Hermes home: --home, else HERMES_HOME, else ~/.hermes. A profile home maps to its root."""
    environ = os.environ if environ is None else environ
    home = Path(value or environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser()
    if home.parent.name == "profiles":
        home = home.parent.parent
    return home.resolve()


def find_profiles(root: Path, only=()) -> list:
    """[(name, home)]: "default" is the root itself, others are profiles/<name> with a config.yaml."""
    found = {}
    if (root / "config.yaml").is_file():
        found["default"] = root
    profiles = root / "profiles"
    if profiles.is_dir():
        for p in sorted(profiles.iterdir()):
            try:
                if (PROFILE_RE.match(p.name) and p.is_dir() and (p / "config.yaml").is_file()
                        and p.resolve().is_relative_to(root)):
                    found[p.name] = p.resolve()
            except (OSError, ValueError):
                continue
    if only:
        missing = [n for n in only if n not in found]
        if missing:
            raise InstallError(f"No such profile with a config.yaml under {root}: {', '.join(missing)}")
        return [(n, found[n]) for n in dict.fromkeys(only)]
    if not found:
        raise InstallError(f"No Hermes config.yaml under {root}. Set Hermes up first, or pass --home.")
    return list(found.items())


def plugin_folders(home: Path) -> set:
    try:
        return {p.name for p in (home / "plugins").iterdir() if p.is_dir()}
    except OSError:
        return set()


def plugin_version(stage: Path = HERE) -> str:
    """The `version:` of the plugin.yaml next to the installer ("" when it has none)."""
    try:
        text = (stage / "plugin.yaml").read_text(encoding="utf-8")
    except OSError:
        return ""
    m = re.search(r"""^version:\s*["']?([0-9]+\.[0-9]+\.[0-9]+)["']?\s*$""", text, re.M)
    return m.group(1) if m else ""


def read_state(home: Path) -> dict:
    try:
        state = json.loads((home / RUNTIME_DIR / STATE_FILE).read_text(encoding="utf-8"))
        return state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        return {}


# ---------------------------------------------------------------------------- config.yaml

def plugins_section(loaded) -> tuple:
    """(plugins mapping, enabled list, disabled list) of a parsed config, validated."""
    if not isinstance(loaded, dict):
        raise InstallError("config.yaml must contain a mapping")
    plugins = loaded.get("plugins")
    plugins = {} if plugins is None else plugins
    if not isinstance(plugins, dict):
        raise InstallError("`plugins` in config.yaml must be a mapping")
    enabled, disabled = plugins.get("enabled") or [], plugins.get("disabled") or []
    if not isinstance(enabled, list) or not isinstance(disabled, list):
        raise InstallError("plugins.enabled and plugins.disabled must be lists")
    return plugins, list(enabled), list(disabled)


def _with_lists(plugins: dict, enabled: list, disabled: list) -> dict:
    out = dict(plugins)
    out["enabled"] = enabled
    if disabled or "disabled" in plugins:
        out["disabled"] = disabled
    return out


def install_plugins(plugins: dict, enabled: list, disabled: list, state: dict, present: set):
    """New plugins mapping, install state and notes for one profile."""
    enabled, disabled = list(enabled), list(disabled)
    if PLUGIN in disabled:
        raise InstallError(f"{PLUGIN} is listed in plugins.disabled. Remove it there first if you want it.")
    migrated = {k: v for k, v in (state.get("migrated") or {}).items() if k in OLD_PLUGINS and isinstance(v, dict)}
    notes = []
    for old in OLD_PLUGINS:
        if old in enabled:
            migrated.setdefault(old, {"was_enabled": True, "was_disabled": old in disabled})
            enabled = [n for n in enabled if n != old]
            if old not in disabled:
                disabled.append(old)
            notes.append(f"turn off {old} (hermes-deck does its job; its folder and data stay)")
        elif old in present and old not in disabled:
            notes.append(f"{old} is in plugins/ but not enabled: left as it is")
    if PLUGIN not in enabled:
        enabled.append(PLUGIN)
        notes.append(f"enable {PLUGIN}")
    new = _with_lists(plugins, enabled, disabled)

    return new, {"version": 1, "migrated": migrated}, notes


def uninstall_plugins(plugins: dict, enabled: list, disabled: list, state: dict, present: set):
    """New plugins mapping and notes: hermes-deck off, the plugins it turned off back as they were."""
    enabled, disabled = list(enabled), list(disabled)
    notes = []
    if PLUGIN in enabled:
        enabled = [n for n in enabled if n != PLUGIN]
        notes.append(f"turn off {PLUGIN}")
    for old, info in (state.get("migrated") or {}).items():
        if old not in OLD_PLUGINS or not isinstance(info, dict):
            continue
        if old not in present:
            notes.append(f"{old} is no longer in plugins/: left off")
            continue
        if not info.get("was_disabled") and old in disabled:
            disabled = [n for n in disabled if n != old]
        if info.get("was_enabled") and old not in enabled:
            enabled.append(old)
            notes.append(f"turn {old} back on")
    return _with_lists(plugins, enabled, disabled), notes


def rewrite_plugins(text: str, yaml, plugins: dict) -> str:
    """config.yaml text with only the top-level `plugins` value replaced, in flow style on the key's line;
    every other line is kept as written (comments inside the old `plugins` block go; the backup keeps them).
    Raises InstallError when the result would not parse back to exactly the intended configuration.
    After Hermes Desk's install.py."""
    loaded = yaml.safe_load(text) or {}
    if not isinstance(loaded, dict):
        raise InstallError("config.yaml must contain a mapping")
    if loaded.get("plugins") == plugins:
        return text
    value = yaml.safe_dump(plugins, default_flow_style=True, sort_keys=False, width=1000000).rstrip()
    nl = "\r\n" if "\r\n" in text else "\n"
    root = yaml.compose(text)
    pair = next(((k, v) for k, v in root.value if getattr(k, "value", None) == "plugins"), None) if root else None
    if pair is None:
        updated = (text.rstrip("\r\n") + nl if text.strip() else "") + "plugins: " + value + nl
    else:
        key, node = pair
        try:
            colon = text.index(":", key.end_mark.index)
        except ValueError:
            raise InstallError("Cannot find the `plugins:` key in config.yaml. Edit it by hand.") from None
        end = node.end_mark
        if end.index >= len(text):              # the value runs to the end of the file
            rest = nl
        elif end.line > key.end_mark.line:      # a block value ends at the next key, after its indentation
            rest = nl + " " * end.column
        else:                                   # a flow or empty value ends on the key's own line
            rest = ""
        updated = text[:colon + 1] + " " + value + rest + text[end.index:]
    if yaml.safe_load(updated) != {**loaded, "plugins": plugins}:
        raise InstallError("Cannot update the plugins section of this config.yaml layout safely. Edit it by hand.")
    return updated


# ---------------------------------------------------------------------------- plan

def same_copy(stage: Path, target: Path) -> bool:
    """An installed folder holding exactly this version's files."""
    try:
        if sorted(p.name for p in target.iterdir()) != sorted(SOURCE_FILES):
            return False
        return all((target / f).read_bytes() == (stage / f).read_bytes() for f in SOURCE_FILES)
    except OSError:
        return False


def make_plan(root: Path, profiles: list, uninstall: bool, yaml, stage: Path = HERE) -> dict:
    """Everything that would change, checked; raises InstallError before any write."""
    if not uninstall:
        missing = [f for f in SOURCE_FILES if not (stage / f).is_file()]
        if missing:
            raise InstallError(f"Plugin files missing next to the installer: {', '.join(missing)}")
    plan = {"root": root, "uninstall": uninstall, "profiles": [], "stream": None,
            "version": "" if uninstall else plugin_version(stage)}
    if not uninstall and not plan["version"]:
        raise InstallError(f"{stage / 'plugin.yaml'} has no version: line")
    for name, home in profiles:
        config = home / "config.yaml"
        try:
            original = config.read_text(encoding="utf-8")
            loaded = yaml.safe_load(original) or {}
        except yaml.YAMLError as e:
            raise InstallError(f"{config}: cannot parse it ({type(e).__name__}); fix its YAML first.")
        except (OSError, UnicodeDecodeError) as e:
            raise InstallError(f"{config}: cannot read it ({e}).")
        try:
            plugins, enabled, disabled = plugins_section(loaded)
            state, present = read_state(home), plugin_folders(home)
            if uninstall:
                new, notes = uninstall_plugins(plugins, enabled, disabled, state, present)
                new_state = None
            else:
                new, new_state, notes = install_plugins(plugins, enabled, disabled, state, present)
            updated = rewrite_plugins(original, yaml, new)
        except InstallError as e:
            raise InstallError(f"{config}: {e}")
        target = home / "plugins" / PLUGIN
        if target.is_symlink() or (target.exists() and target.resolve() == stage.resolve()):
            folder = "linked"
            notes.append(f"{target} is a symlink or this checkout: left as it is")
        elif uninstall:
            folder = "move" if target.exists() else "none"
            if folder == "move":
                notes.append(f"move {target} to {home / ('plugins' + SUFFIX + '<timestamp>')}/")
        elif not target.exists():
            folder = "copy"
            notes.append(f"copy the plugin to {target}")
        elif same_copy(stage, target):
            folder = "same"
            notes.append(f"{target} is already up to date")
        else:
            folder = "replace"
            notes.append(f"update {target} (the old copy goes to plugins{SUFFIX}<timestamp>/)")
        if uninstall and not state and PLUGIN not in enabled and folder == "none":
            notes = ["hermes-deck is not installed here: nothing to do"]
        plan["profiles"].append({"name": name, "home": home, "config": config, "original": original,
                                 "updated": updated, "folder": folder, "state": new_state, "notes": notes,
                                 "before": plugins, "after": new})
    if not uninstall:
        stream = root / RUNTIME_DIR / "stream.py"
        source = (stage / "stream.py").read_bytes()
        try:
            current = stream.read_bytes() if stream.is_file() else None
        except OSError:
            current = None
        plan["stream"] = {"path": stream, "data": source, "action": "same" if current == source else
                          ("replace" if current is not None else "create")}

    return plan


def describe(plan: dict) -> str:
    lines = [("Uninstall" if plan["uninstall"] else "Install") + f" hermes-deck in {plan['root']}"]
    for p in plan["profiles"]:
        lines.append(f"  profile {p['name']} ({p['home']})")
        for n in p["notes"]:
            lines.append(f"    - {n}")
        if p["updated"] != p["original"]:
            lines.append(f"    - config.yaml plugins: {json.dumps(p['before'])} -> {json.dumps(p['after'])}")
            lines.append(f"      (backup: config.yaml{SUFFIX}<timestamp>)")
        installed = p["home"] / RUNTIME_DIR / INSTALLED_FILE
        if not plan["uninstall"]:
            lines.append(f"    - record version {plan['version']} (protocol {PROTOCOL}) in {installed}")
        elif installed.is_file():
            lines.append(f"    - remove {installed}")
    s = plan["stream"]
    if s:
        lines.append(f"  bridge stream {s['path']}: " + {"same": "already up to date",
                     "create": "create it",
                     "replace": f"update it (the old one is kept as stream.py{SUFFIX}<timestamp>)"}[s["action"]])
    elif plan["uninstall"]:
        lines.append("  bridge stream: left in place; inactive without the bridge plugin")
    return "\n".join(lines)


# ---------------------------------------------------------------------------- apply

def atomic_write(path: Path, data: bytes, mode: int = 0o600) -> None:
    fd, tmp = tempfile.mkstemp(prefix=".hermes-deck-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _copy_plugin(stage: Path, dest: Path) -> None:
    dest.mkdir(mode=0o700)
    for name in SOURCE_FILES:
        atomic_write(dest / name, (stage / name).read_bytes())


def apply(plan: dict, stamp: str, stage: Path = HERE, log=print) -> None:
    for p in plan["profiles"]:
        home, config = p["home"], p["config"]
        if p["updated"] != p["original"]:
            backup = config.with_name(config.name + SUFFIX + stamp)
            shutil.copy2(config, backup)
            log(f"backup: {backup}")
            atomic_write(config, p["updated"].encode("utf-8"), stat.S_IMODE(config.stat().st_mode))
            log(f"updated: {config}")
        target = home / "plugins" / PLUGIN
        if p["folder"] in ("copy", "replace"):
            staging = home / f".hermes-deck-staging-{stamp}"
            _copy_plugin(stage, staging)
            target.parent.mkdir(parents=True, exist_ok=True)
            if p["folder"] == "replace":
                old = home / ("plugins" + SUFFIX + stamp)
                old.mkdir(parents=True, exist_ok=True)
                os.replace(target, old / PLUGIN)
                log(f"previous plugin copy: {old / PLUGIN}")
            os.replace(staging, target)
            log(f"plugin: {target}")
        elif p["folder"] == "move":
            old = home / ("plugins" + SUFFIX + stamp)
            old.mkdir(parents=True, exist_ok=True)
            os.replace(target, old / PLUGIN)
            log(f"plugin moved to: {old / PLUGIN}")
        state_path = home / RUNTIME_DIR / STATE_FILE
        if p["state"] is not None:
            state_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            state = dict(p["state"], installed_at=stamp)
            atomic_write(state_path, (json.dumps(state, indent=2, sort_keys=True) + "\n").encode("utf-8"))
        elif plan["uninstall"] and state_path.is_file():
            os.replace(state_path, state_path.with_name(state_path.name + SUFFIX + stamp))
        installed = home / RUNTIME_DIR / INSTALLED_FILE
        if plan["uninstall"]:
            if installed.is_file():
                os.unlink(installed)
                log(f"removed: {installed}")
        else:
            installed.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            when = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            record = {"version": plan["version"], "protocol": PROTOCOL, "installedAt": when}
            atomic_write(installed, (json.dumps(record, indent=2, sort_keys=True) + "\n").encode("utf-8"), 0o644)
    s = plan["stream"]
    if s and s["action"] != "same":
        path = s["path"]
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if s["action"] == "replace":
            backup = path.with_name(path.name + SUFFIX + stamp)
            shutil.copy2(path, backup)
            log(f"previous stream: {backup}")
        atomic_write(path, s["data"])
        log(f"stream: {path}")


NEXT_STEPS = """\
Next:
  1. Restart each changed profile's gateway at a quiet moment. A restart kills background delegate_task
     sub-agents, and gateway_state.json's active_agents does not count them: if a
     <profile home>/cache/delegation/live/*/task-*.log changed in the last minutes and does not end with
     "end status=", wait.
  2. For Hermes Deck's direct connection (Settings, the Hermes connection section), use
     Python    {python}
     stream.py {stream}
  3. Check after the next turn: tail -3 ~/.hermes-deck/events/<profile>.ndjson"""


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):       # a path in an odd encoding must not stop a finished install
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(description="Install, update or remove the hermes-deck Hermes plugin.")
    parser.add_argument("--home", type=Path, help="Hermes home (default: HERMES_HOME's root, else ~/.hermes)")
    parser.add_argument("--profile", action="append", default=[], metavar="NAME",
                        help="only this profile (repeatable; 'default' is the Hermes home itself)")
    parser.add_argument("--dry-run", action="store_true", help="print what would change, change nothing")
    parser.add_argument("--uninstall", action="store_true",
                        help="turn hermes-deck off and turn back on the plugins it replaced")
    args = parser.parse_args(argv)
    if sys.version_info < (3, 10):
        parser.error("Python 3.10 or newer is required; use Hermes' own Python.")
    try:
        import yaml
    except ImportError:
        parser.error("PyYAML is required. Run this with Hermes' own Python, e.g. "
                     "~/.hermes/hermes-agent/venv/bin/python install.py")
    if os.name == "nt":
        print("note: the bridge part needs a POSIX Hermes host (Linux, macOS or WSL); on native Windows only the "
              "events part runs.", file=sys.stderr)
    root = hermes_root(args.home)
    try:
        plan = make_plan(root, find_profiles(root, args.profile), args.uninstall, yaml)
    except InstallError as e:
        print(f"error: {e}\nNothing was changed.", file=sys.stderr)
        return 1
    print(describe(plan))
    if args.dry_run:
        print("Dry run: nothing was changed.")
        return 0
    stamp = stamp_now()
    try:
        apply(plan, stamp)
    except OSError as e:
        print(f"error: stopped part-way: {e}\nBackups made so far end in {SUFFIX}{stamp}.", file=sys.stderr)
        return 1
    if args.uninstall:
        print("hermes-deck is off. Restart the changed gateways at a quiet moment.")
    else:
        print(NEXT_STEPS.format(python=sys.executable, stream=plan["stream"]["path"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
