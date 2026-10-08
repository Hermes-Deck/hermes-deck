"""Hermes config bridge for the relay's Settings > Hermes config (relay/src/hermes-config.js).

Runs with Hermes' own Python (DECK_HERMES_PYTHON) as a short child process per request, so the field list,
defaults, validation-free merge and the atomic save are Hermes' own code (the same functions its dashboard uses):

    python -I hermes-config.py schema
    python -I hermes-config.py get <profile>
    python -I hermes-config.py set <profile>      < {"rev": "<sha256>", "set": {"dot.key": value}, "unset": ["dot.key"]}

Profiles live under HERMES_ROOT: "default" is the root itself, others are profiles/<name>. Each call prints one JSON
object on stdout ({"ok": true, ...} or {"ok": false, "code": <http status>, "error": "..."}).

Boundaries:
  - Secret-like fields (api keys, passwords, secrets) are left out of the schema, never returned and never written.
  - Values are read from config.yaml as written (no ${ENV} expansion), so a referenced secret never leaves the host.
  - "unset" removes a written key so Hermes' default applies again.
  - Fields whose default is null carry "free": true (Hermes cannot infer their type); they take text, a number,
    true/false or null.
  - A write needs the revision (sha256 of config.yaml) the editor read; a file changed since then is refused (409).
  - Every write first copies config.yaml to config.yaml.bak-deck-<UTC timestamp>; the newest BACKUPS_KEEP are kept.
"""

import copy
import datetime
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SECRET_RE = re.compile(r"(^|[._])(api_key|password|password_hash|secret|token)$")
BACKUP_SUFFIX = ".bak-deck-"
BACKUPS_KEEP = 10
MAX_KEYS = 300
MAX_STRING = 8000
MAX_LIST = 200


class Refused(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str))
    sys.stdout.flush()


def agent_dir():
    """Hermes' install directory: HERMES_AGENT_DIR, else the checkout around this Python's venv (<dir>/venv)."""
    env = os.environ.get("HERMES_AGENT_DIR", "").strip()
    if env:
        return Path(env)
    prefix = Path(sys.prefix)  # the venv itself, not the interpreter its python symlink points at
    return prefix.parent if (prefix.parent / "hermes_cli").is_dir() else None


def root_dir():
    root = os.environ.get("HERMES_ROOT", "").strip()
    return Path(root) if root else Path.home() / ".hermes"


def profiles(root):
    names = []
    if (root / "config.yaml").is_file():
        names.append("default")
    try:
        for p in sorted((root / "profiles").iterdir()):
            if PROFILE_RE.match(p.name) and p.is_dir() and (p / "config.yaml").is_file():
                names.append(p.name)
    except OSError:
        pass
    return names[:64]


def home_of(root, profile):
    if not isinstance(profile, str) or not PROFILE_RE.match(profile):
        raise Refused(400, "bad profile")
    if profile not in profiles(root):
        raise Refused(404, "no such profile")
    return root if profile == "default" else root / "profiles" / profile


def load_hermes(home):
    """Import Hermes with HERMES_HOME pointed at one profile (set before import: some modules bind it early)."""
    os.environ["HERMES_HOME"] = str(home)
    d = agent_dir()
    if d and str(d) not in sys.path:
        sys.path.insert(0, str(d))
    try:
        from hermes_cli import config as hc
        from hermes_cli import web_server_config as wsc
    except Exception as e:  # noqa: BLE001 - reported to the Deck, never raised
        raise Refused(503, f"cannot load Hermes ({type(e).__name__}: {e}); set DECK_HERMES_PYTHON / HERMES_AGENT_DIR")
    return hc, wsc


def is_secret(key):
    return bool(SECRET_RE.search(key))


def schema_fields(hc, wsc):
    fields = {}
    for key, entry in wsc.CONFIG_SCHEMA.items():
        if is_secret(key):
            continue
        f = {"type": entry.get("type", "string"), "description": entry.get("description", key), "category": entry.get("category", "general")}
        has, default = lookup(hc.DEFAULT_CONFIG, key)
        if f["type"] == "string" and has and default is None:
            f["free"] = True  # a null default: the schema guessed "string", the real type is unknown
        if isinstance(entry.get("options"), list):
            f["options"] = [o for o in entry["options"] if isinstance(o, (str, int, float, bool))]
        fields[key] = f
    return fields


def lookup(d, key):
    cur = d
    for part in key.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return False, None
        cur = cur[part]
    return True, cur


def file_rev(path):
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except FileNotFoundError:
        return hashlib.sha256(b"").hexdigest()


def flat_values(hc, wsc, raw, fields):
    """{key: value} for every schema field (the written value, else Hermes' default) and the keys written in config.yaml."""
    defaults = copy.deepcopy(hc.DEFAULT_CONFIG)
    view = copy.deepcopy(raw)
    if isinstance(view.get("model"), dict):
        m = view["model"]
        view["model"] = m.get("default", m.get("name", ""))
        if isinstance(m.get("context_length"), int):
            view["model_context_length"] = m["context_length"]
    values, explicit = {}, []
    for key in fields:
        has, v = lookup(view, key)
        if has:
            explicit.append(key)
        else:
            has, v = lookup(defaults, key)
            if not has:
                v = 0 if key == "model_context_length" else None
        if isinstance(v, (dict,)):
            continue  # a mapping where the schema has a leaf (a hand-written variant): read-only here
        values[key] = v
    return values, explicit


def check_value(key, field, value):
    t = field["type"]
    if value is None:
        if field.get("free"):
            return None
        raise Refused(400, f"{key}: use unset to go back to the default")
    if field.get("free"):
        if isinstance(value, (bool, int, float)) or (isinstance(value, str) and len(value) <= MAX_STRING):
            return value
        raise Refused(400, f"{key}: expected text, a number or true/false")
    if t == "boolean":
        if not isinstance(value, bool):
            raise Refused(400, f"{key}: expected true/false")
    elif t == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise Refused(400, f"{key}: expected a number")
    elif t == "list":
        if not isinstance(value, list) or len(value) > MAX_LIST or not all(isinstance(x, (str, int, float, bool)) for x in value):
            raise Refused(400, f"{key}: expected a list of plain values")
        if any(isinstance(x, str) and len(x) > MAX_STRING for x in value):
            raise Refused(400, f"{key}: list item too long")
    elif t == "select":
        if value not in field.get("options", []):
            raise Refused(400, f"{key}: not one of the allowed values")
    else:
        if not isinstance(value, str) or len(value) > MAX_STRING:
            raise Refused(400, f"{key}: expected text up to {MAX_STRING} characters")
    return value


def nest(flat):
    tree = {}
    for key, value in flat.items():
        cur = tree
        parts = key.split(".")
        for part in parts[:-1]:
            cur = cur.setdefault(part, {})
        cur[parts[-1]] = value
    return tree


def drop(tree, key):
    """Remove one dotted key from a nested mapping, and parents it leaves empty."""
    parts = key.split(".")
    chain = [tree]
    for part in parts[:-1]:
        nxt = chain[-1].get(part) if isinstance(chain[-1], dict) else None
        if not isinstance(nxt, dict):
            return
        chain.append(nxt)
    chain[-1].pop(parts[-1], None)
    for i in range(len(parts) - 1, 0, -1):
        if chain[i] == {}:
            chain[i - 1].pop(parts[i - 1], None)


def prune_backups(path):
    olds = sorted(path.parent.glob(path.name + BACKUP_SUFFIX + "*"))
    for p in olds[:-BACKUPS_KEEP]:
        try:
            p.unlink()
        except OSError:
            pass


def cmd_schema(root):
    hc, wsc = load_hermes(root)
    fields = schema_fields(hc, wsc)
    order = list(getattr(sys.modules.get("hermes_cli.web_routers.config_env"), "_CATEGORY_ORDER", []) or [
        "general", "agent", "terminal", "display", "delegation", "memory", "compression", "security", "browser",
        "voice", "tts", "stt", "logging", "discord", "auxiliary"])
    return {"ok": True, "fields": fields, "categoryOrder": order, "profiles": profiles(root)}


def cmd_get(root, profile):
    home = home_of(root, profile)
    hc, wsc = load_hermes(home)
    path = home / "config.yaml"
    raw = hc.require_readable_config_before_write(path)
    fields = schema_fields(hc, wsc)
    values, explicit = flat_values(hc, wsc, raw, fields)
    return {"ok": True, "profile": profile, "rev": file_rev(path), "values": values, "explicit": explicit,
            "managed": bool(hc.is_managed())}


def cmd_set(root, profile, req):
    home = home_of(root, profile)
    if not isinstance(req, dict) or not isinstance(req.get("set"), dict) or not isinstance(req.get("rev"), str):
        raise Refused(400, "expected {rev, set}")
    patch = req["set"]
    unset = req.get("unset", [])
    if not isinstance(unset, list) or not all(isinstance(k, str) for k in unset):
        raise Refused(400, "unset must be a list of keys")
    if not patch and not unset:
        raise Refused(400, "nothing to save")
    if len(patch) + len(unset) > MAX_KEYS:
        raise Refused(400, "too many changes in one save")
    if set(patch) & set(unset):
        raise Refused(400, "a key is both set and unset")
    hc, wsc = load_hermes(home)
    if hc.is_managed():
        raise Refused(409, "this Hermes install is managed by a package manager; change its config there")
    fields = schema_fields(hc, wsc)
    for key in [*patch, *unset]:
        if not isinstance(key, str) or is_secret(key) or key not in fields or key == "model_context_length" and key in unset:
            raise Refused(400, f"{key}: not an editable field")
    for key, value in patch.items():
        check_value(key, fields[key], value)
    path = home / "config.yaml"
    if file_rev(path) != req["rev"]:
        raise Refused(409, "config.yaml changed since it was loaded; reload and try again")
    existing = hc.require_readable_config_before_write(path)
    # a written value that is a mapping where the schema has a leaf is not replaced by a flat value
    for key in patch:
        has, cur = lookup(existing, key)
        if has and isinstance(cur, dict) and key != "model":
            raise Refused(409, f"{key}: written as a mapping in config.yaml; edit it there")
    for key in unset:
        if key == "model":
            raise Refused(400, "model: pick a model instead of clearing it")
    incoming = wsc._denormalize_config_from_web(nest(patch)) if patch else {}  # model / context length, like the dashboard
    merged = hc._deep_merge(existing, incoming)
    for key in unset:
        drop(merged, key)
    backup = None
    if path.exists():
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup = path.with_name(path.name + BACKUP_SUFFIX + stamp)
        shutil.copy2(path, backup)
        os.chmod(backup, 0o600)
    hc.save_config(merged)
    prune_backups(path)
    raw = hc.require_readable_config_before_write(path)
    values, explicit = flat_values(hc, wsc, raw, fields)
    return {"ok": True, "profile": profile, "rev": file_rev(path), "values": values, "explicit": explicit,
            "saved": sorted([*patch, *unset]), "backup": backup.name if backup else None}


def main(argv):
    root = root_dir()
    try:
        if argv[:1] == ["schema"]:
            res = cmd_schema(root)
        elif argv[:1] == ["get"] and len(argv) == 2:
            res = cmd_get(root, argv[1])
        elif argv[:1] == ["set"] and len(argv) == 2:
            try:
                req = json.loads(sys.stdin.read(4 * 1024 * 1024) or "null")
            except ValueError:
                raise Refused(400, "bad JSON") from None
            res = cmd_set(root, argv[1], req)
        else:
            raise Refused(400, "usage: schema | get <profile> | set <profile>")
    except Refused as e:
        res = {"ok": False, "code": e.code, "error": e.message}
    except Exception as e:  # noqa: BLE001 - one JSON answer, whatever Hermes raised
        res = {"ok": False, "code": 500, "error": f"{type(e).__name__}: {str(e)[:400]}"}
    out(res)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
