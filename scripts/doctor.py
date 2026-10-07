#!/usr/bin/env python3
"""Read-only Hermes Deck diagnosis (Python 3.10+). Never imports Hermes."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import re
import ast
import platform
import shutil
import stat
import subprocess
from http.client import HTTPException
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, HTTPRedirectHandler, build_opener

sys.dont_write_bytecode = True
try:
    import yaml
except ImportError:
    yaml = None

VERSION = re.compile(r"v?(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.-]+)?")


def version_tuple(value):
    match = VERSION.fullmatch(str(value))
    return tuple(map(int, match.groups())) if match else None


def older_than(value, minimum):
    current, required = version_tuple(value), version_tuple(minimum)
    return current is not None and required is not None and current < required


def root_home(home):
    home = home.expanduser().resolve()
    return home.parent.parent if home.parent.name == "profiles" else home


def add(report, check, status, detail):
    report["checks"].append({"check": check, "status": status, "detail": detail})


def read_json(path):
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("expected mapping")
    return value


def inspect_profile(report, name, home, compat):
    present = (home / "plugins" / "hermes-deck").is_dir()
    profile = {"name": name, "home": str(home), "plugin_present": present,
               "enabled": None, "version": "unknown, pre-0.3.6", "protocol": None}
    report["profiles"].append(profile)
    add(report, f"{name}/plugin", "ok" if present else "problem", "present" if present else "missing")
    if yaml is None:
        add(report, f"{name}/config", "cannot_run", "PyYAML unavailable; use Hermes' Python")
    else:
        try:
            config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8-sig"))
            if not isinstance(config, dict):
                raise ValueError("mapping required")
            plugins = config.get("plugins") or {}
            if not isinstance(plugins, dict):
                raise ValueError("plugins mapping required")
            enabled = plugins.get("enabled") or []
            disabled = plugins.get("disabled") or []
            if not isinstance(enabled, list) or not isinstance(disabled, list):
                raise ValueError("lists required")
            profile["enabled"] = "hermes-deck" in enabled and "hermes-deck" not in disabled
            add(report, f"{name}/config", "ok" if profile["enabled"] else "problem",
                "enabled" if profile["enabled"] else "not enabled or explicitly disabled")
        except (OSError, UnicodeError, ValueError, yaml.YAMLError):
            add(report, f"{name}/config", "problem", "cannot read or parse config.yaml")
    metadata = home / "hermes-deck" / "installed.json"
    if not metadata.exists():
        add(report, f"{name}/version", "warning", profile["version"])
        return
    try:
        installed = read_json(metadata)
        version, protocol = installed.get("version"), installed.get("protocol")
        if version_tuple(version) is None or type(protocol) is not int:
            raise ValueError("invalid installed metadata")
        profile.update(version=version, protocol=protocol)
        old = bool(compat and older_than(version, compat["version"]))
        add(report, f"{name}/version", "problem" if old else "ok", version)
        mismatch = bool(compat and protocol != compat["protocol"])
        add(report, f"{name}/protocol", "problem" if mismatch else "ok", str(protocol))
    except (OSError, UnicodeError, ValueError):
        add(report, f"{name}/version", "problem", "cannot read or validate installed.json")


def hermes_version(installation, home):
    """Read version literals/stamps, never execute a possibly stateful Hermes CLI."""
    candidates = [installation] if installation else []
    launcher = shutil.which("hermes")
    if launcher:
        candidates.extend(Path(launcher).resolve().parents)
    candidates.extend([Path(sys.prefix).parent, home / "hermes-agent"])
    for candidate in candidates:
        try:
            stamp = read_json(candidate / "install-stamp.json")
            value = stamp.get("baseVersion")
            if version_tuple(value):
                return value
        except (OSError, UnicodeError, ValueError):
            pass
        try:
            tree = ast.parse((candidate / "hermes_cli" / "__init__.py").read_text(encoding="utf-8-sig"))
            for node in tree.body:
                if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__version__"
                                                        for t in node.targets):
                    value = ast.literal_eval(node.value)
                    if version_tuple(value):
                        return value
        except (OSError, UnicodeError, ValueError, SyntaxError):
            pass
    return None


def node_version():
    """Only subprocess: Node's inert version flag, bounded and without a shell."""
    try:
        result = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=5,
                                check=False)
        value = result.stdout.strip().removeprefix("v")
        return value if result.returncode == 0 and version_tuple(value) else None
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_health(url, timeout):
    """One bounded GET, no ambient proxy, authentication, redirects or file writes."""
    opener = build_opener(ProxyHandler({}), NoRedirect())
    with opener.open(url, timeout=timeout) as response:
        data = response.read(65537)
    if len(data) > 65536:
        raise ValueError("health response too large")
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError("health must be a mapping")
    return value


def safe_health(value):
    """Keep only version/protocol data, never arbitrary server strings or objects."""
    out = {}
    for key in ("v", "version"):
        if version_tuple(value.get(key)):
            out[key] = value[key]
    if type(value.get("protocol")) is int:
        out["protocol"] = value["protocol"]
    plugins = value.get("plugins")
    if isinstance(plugins, dict):
        out["plugins"] = {name: safe_health(info) if isinstance(info, dict) else info
                          for name, info in plugins.items()
                          if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", name)
                          and (info is None or version_tuple(info) or isinstance(info, dict))}
    elif isinstance(plugins, list):
        out["plugins"] = [safe_health(info) for info in plugins if isinstance(info, dict)]
    return out


def inspect_relay(report, args, compat):
    if args.relay_dir:
        present = args.relay_dir.is_dir()
        add(report, "relay/directory", "ok" if present else "problem", "present" if present else "missing")
        version = node_version()
        report["node_version"] = version
        good = version_tuple(version) is not None and not older_than(version, "22.13.0")
        add(report, "relay/node", "ok" if good else "problem", version or "Node unavailable")
        env = args.relay_dir / ".env"
        try:
            mode = stat.S_IMODE(env.stat().st_mode)
            report["relay_env"] = {"exists": True, "mode": f"{mode:04o}"}
            add(report, "relay/.env", "problem" if os.name != "nt" and mode & 0o077 else "ok",
                f"present, mode {mode:04o}" + (" (POSIX privacy bits not enforced on Windows)" if os.name == "nt" else ""))
        except FileNotFoundError:
            report["relay_env"] = {"exists": False, "mode": None}
            add(report, "relay/.env", "problem", "missing")
        except OSError:
            add(report, "relay/.env", "problem", "cannot stat .env")
    if not args.relay:
        return
    try:
        url = urlsplit(args.relay)
        if (url.scheme not in ("http", "https") or not url.hostname or url.username or url.password
                or url.query or url.fragment or url.path not in ("", "/")):
            raise ValueError("invalid URL")
        # Access .port to validate it without displaying the original URL.
        url.port
    except ValueError:
        add(report, "relay/health", "cannot_run", "use an http(s) origin without credentials, path or query")
        return
    try:
        health = fetch_health(args.relay.rstrip("/") + "/health", args.timeout)
        if health.get("ok") is False or (health.get("ok") is not True and not version_tuple(health.get("v"))):
            raise ValueError("not relay health")
        report["relay"] = safe_health(health)
        add(report, "relay/health", "ok", "reachable (liveness only, not authentication)")
        health = report["relay"]
        if "v" in health:
            old = bool(compat and older_than(health["v"], compat["version"]))
            add(report, "relay/version", "problem" if old else "ok", health["v"])
        if "protocol" in health:
            mismatch = bool(compat and health["protocol"] != compat["protocol"])
            add(report, "relay/protocol", "problem" if mismatch else "ok", str(health["protocol"]))
    except (OSError, ValueError, UnicodeError, HTTPException):
        add(report, "relay/health", "problem", "unreachable, invalid or oversized health response")


def diagnose(args):
    home = root_home(args.home or Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes"))
    observed = args.hermes_version or hermes_version(args.hermes_dir, home)
    invalid_version = bool(args.hermes_version and version_tuple(args.hermes_version) is None)
    report = {"home": str(home), "checks": [], "profiles": [], "compat": None,
              "hermes_version": observed if version_tuple(observed) else None,
              "os": platform.system(), "python": sys.executable, "stream_present": False}
    args.hermes_version = report["hermes_version"]
    if invalid_version:
        add(report, "hermes/version-argument", "cannot_run", "--hermes-version must be a version, not arbitrary text")
    add(report, "home", "ok" if home.is_dir() else "problem", "present" if home.is_dir() else "missing")
    path = args.repo / "compat.json"
    if not path.exists():
        add(report, "compat", "warning", "compat.json absent; comparison unavailable")
    else:
        try:
            compat = read_json(path)
            if (version_tuple(compat.get("version")) is None or type(compat.get("protocol")) is not int
                    or version_tuple(compat.get("minHermes")) is None):
                raise ValueError("invalid compatibility metadata")
            report["compat"] = {k: compat[k] for k in ("version", "protocol", "minHermes")}
            add(report, "compat", "ok", "loaded")
        except (OSError, UnicodeError, ValueError):
            add(report, "compat", "cannot_run", "cannot read or validate compat.json")
    compat = report["compat"]
    if version_tuple(args.hermes_version) is None:
        add(report, "hermes/version", "warning", "unknown; pass --hermes-version")
    else:
        old = bool(compat and older_than(args.hermes_version, compat["minHermes"]))
        add(report, "hermes/version", "problem" if old else "ok", args.hermes_version)
    profiles = []
    if (home / "config.yaml").exists():
        profiles.append(("default", home))
    try:
        if (home / "profiles").is_dir():
            profiles.extend((p.name, p) for p in sorted((home / "profiles").iterdir())
                            if p.is_dir() and not p.is_symlink())
    except OSError:
        add(report, "profiles", "problem", "cannot list profiles")
    if not profiles:
        add(report, "profiles", "problem", "no profiles found")
    for name, path in profiles:
        inspect_profile(report, name, path, compat)
    report["stream_present"] = (home / "hermes-deck" / "stream.py").is_file()
    add(report, "stream", "ok" if report["stream_present"] else "problem",
        "present" if report["stream_present"] else "missing")
    inspect_relay(report, args, compat)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--hermes-version", help="observed Hermes version; overrides read-only metadata detection")
    parser.add_argument("--hermes-dir", type=Path, help="Hermes installation directory for version metadata")
    parser.add_argument("--relay-dir", type=Path, help="relay checkout; check Node and .env metadata only")
    parser.add_argument("--relay", help="relay http(s) origin; GET /health only")
    parser.add_argument("--timeout", type=float, default=3, help="health request timeout in seconds (default: 3)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    if not 0 < args.timeout <= 30:
        parser.error("timeout must be between 0 and 30 seconds")
    result = diagnose(args)
    statuses = {c["status"] for c in result["checks"]}
    code = 2 if "cannot_run" in statuses else 1 if "problem" in statuses else 0
    result["exit_code"] = code
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print("Hermes Deck doctor (read-only)")
        print(f"Home: {result['home']}")
        print(f"{'CHECK':<30} {'STATUS':<12} DETAIL")
        for item in result["checks"]:
            print(f"{item['check']:<30} {item['status']:<12} {item['detail']}")
    return code


if __name__ == "__main__":
    sys.exit(main())
