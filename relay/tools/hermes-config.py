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
  - Each field carries "help" (from the inline and preceding comments of Hermes' annotated cli-config.yaml.example,
    else a hand-written schema description) and "default" (Hermes' built-in value) when known.
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


KEY_LINE_RE = re.compile(r"^(\s*)(\"[^\"]+\"|[A-Za-z0-9_.-]+):(?:\s+(.*))?$")
COMMENTED_KEY_RE = re.compile(r"^(\s*)#\s?(\s*)([a-z][a-z0-9_]*):(?:\s+(.*))?$")
RULE_RE = re.compile(r"^[#\s=\-_*~]{3,}$")
HELP_MAX = 700
_help_cache = {}


def inline_comment(text):
    """The trailing '# ...' of a YAML value (outside quotes), or ''."""
    quote = None
    for i, ch in enumerate(text):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "#" and (i == 0 or text[i - 1].isspace()):
            return text[i + 1:].strip()
    return ""


def tidy_help(parts):
    text = re.sub(r"\s+", " ", " ".join(p for p in parts if p)).strip()
    return text if len(text) <= HELP_MAX else text[:HELP_MAX - 1].rstrip() + "…"


def parse_example_help(text, known):
    """{dotted key: help text} from an annotated YAML example. A key's help is the comment block right above it plus
    its trailing '# ...' (and indented continuation comments below it). Commented-out `key: value` lines are
    examples, except where they name a known field: then their trailing comment documents that field."""
    helps, stack, pending, last = {}, [], [], None  # stack: [(indent, key)]

    def put(path, parts, real):
        h = tidy_help(parts)
        if h and (path not in helps or (real and not helps[path][1])):
            helps[path] = (h, real)

    for raw in text.splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped:
            pending, last = [], None
            continue
        if stripped.startswith("#"):
            if RULE_RE.match(stripped):
                pending, last = [], None
                continue
            m = COMMENTED_KEY_RE.match(line)
            if m:
                indent = len(m.group(1))
                parents = [k for i, k in stack if i < indent]
                path = ".".join([*parents, m.group(3)])
                if path in known:
                    rest = m.group(4) or ""
                    note = inline_comment("x " + rest) if "#" in rest else ""
                    put(path, [*pending, note], False)
                    last = (path, indent)
                    pending = []
                    continue
                pending, last = [], None  # an example value for something else
                continue
            body = stripped.lstrip("#").strip()
            if re.match(r"^-\s", body) or body == "-":
                continue  # a commented-out list item
            col = len(line) - len(line.lstrip())
            if last and col > last[1] + 8 and not pending and last[0] in helps:
                helps[last[0]] = (tidy_help([helps[last[0]][0], body]), helps[last[0]][1])
                continue
            pending.append(body)
            continue
        if stripped.startswith("- ") or stripped == "-":
            continue
        m = KEY_LINE_RE.match(line)
        if not m:
            pending, last = [], None
            continue
        indent = len(m.group(1))
        key = m.group(2).strip('"')
        while stack and stack[-1][0] >= indent:
            stack.pop()
        path = ".".join([*[k for _, k in stack], key])
        stack.append((indent, key))
        note = inline_comment(m.group(3) or "") if m.group(3) else ""
        if path in known:
            put(path, [*pending, note], True)
            last = (path, indent)
        else:
            last = None
        pending = []
    return {k: v[0] for k, v in helps.items()}


def parse_defaults_help(source, known):
    """{dotted key: help text} from the comments in Hermes' DEFAULT_CONFIG dict literal (hermes_cli/config_defaults.py):
    the comment block right above a `"key": value` entry plus its trailing comment. Tokenized, never executed."""
    import io
    import tokenize
    helps, stack, pending, depth = {}, [], [], 0  # stack: [(brace depth, key)]
    last_str, started = None, False
    entry = None  # (path, line) of the key whose value is being read, for its trailing comment
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return {}
    for i, tok in enumerate(tokens):
        typ, text, (row, _), _, _ = tok
        if not started:
            if typ == tokenize.NAME and text == "DEFAULT_CONFIG":
                started = True
            continue
        if typ == tokenize.COMMENT:
            body = text.lstrip("#").strip()
            if entry and row == entry[1]:
                if entry[0] in known and body:
                    helps[entry[0]] = tidy_help([helps.get(entry[0], ""), body])
            elif body and not RULE_RE.match(text.strip()):
                pending.append(body)
            continue
        if typ in (tokenize.NL, tokenize.NEWLINE):
            continue
        if typ == tokenize.OP and text in "{[(":
            depth += 1
            if text == "{" and last_str is not None:
                stack.append((depth, last_str))
            last_str = None
            continue
        if typ == tokenize.OP and text in "}])":
            pending = []  # a comment before a closing brace documents nothing that follows
            if stack and stack[-1][0] == depth:
                stack.pop()
            depth -= 1
            if depth <= 0:
                break
            continue
        if typ == tokenize.STRING and i + 1 < len(tokens) and tokens[i + 1].string == ":":
            try:
                key = __import__("ast").literal_eval(text)
            except Exception:  # noqa: BLE001
                key = None
            if isinstance(key, str):
                path = ".".join([*[k for _, k in stack], key])
                if path in known and pending:
                    helps[path] = tidy_help(pending)
                entry = (path, row)
                last_str = key
            pending = []
            continue
        if typ == tokenize.OP and text == ":":
            continue
        last_str = None
    return helps


def example_help(known):
    """Help texts keyed by dotted key, cached per process ({} when nothing is found): Hermes' annotated
    cli-config.yaml.example first, then the comments in its DEFAULT_CONFIG source for the keys still missing."""
    if "h" in _help_cache:
        return _help_cache["h"]
    result = {}
    d = agent_dir()
    try:
        if d and (d / "cli-config.yaml.example").is_file():
            result = parse_example_help((d / "cli-config.yaml.example").read_text(encoding="utf-8", errors="replace"), known)
    except Exception:  # noqa: BLE001 - help is optional
        result = {}
    try:
        src = d / "hermes_cli" / "config_defaults.py" if d else None
        if src and src.is_file():
            for k, v in parse_defaults_help(src.read_text(encoding="utf-8", errors="replace"), known).items():
                result.setdefault(k, v)
    except Exception:  # noqa: BLE001 - help is optional
        pass
    _help_cache["h"] = result
    return result


def generated_description(key, description):
    """True when the schema description is only the key path title-cased ('Agent → Max Turns')."""
    norm = lambda s: re.sub(r"[\s_.→>-]+", " ", s).strip().lower()  # noqa: E731
    return norm(description) == norm(key)


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
    helps = example_help(set(fields))
    for key, f in fields.items():
        desc = f["description"]
        help_text = helps.get(key) or ("" if generated_description(key, desc) else desc)
        if not help_text and key.startswith("auxiliary."):
            # the per-task blocks (vision, compression, ...) share their option names: borrow a sibling's text
            leaf = key.rsplit(".", 1)[-1]
            help_text = next((helps[k] for k in sorted(helps) if k.startswith("auxiliary.") and k.endswith("." + leaf)), "")
        if help_text:
            f["help"] = help_text
        has, default = lookup(hc.DEFAULT_CONFIG, key)
        if has and default is not None and not isinstance(default, dict):
            f["default"] = default
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
