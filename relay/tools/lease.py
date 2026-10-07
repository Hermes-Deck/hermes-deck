#!/usr/bin/env python3
"""Kontrolü al / geri ver for Hermes Deck: take or hand back a profile's Bot Desktop lease.

While a human holds the lease, Hermes' computer_use refuses every call, captures included. The relay
(POST /desktop/lease) runs this with Hermes' own Python (DECK_HERMES_PYTHON), so the lease goes through
Hermes' module (tools/bot_desktop/lease.py) and its file lock, never through a copy of its file format.

    python lease.py --profile <name> --hold       # the user takes control
    python lease.py --profile <name> --release    # back to the agent (only if Hermes Deck holds it)

Prints one JSON line: {"ok": true, "holder": "human"|null} or {"ok": false, "error": "...", "code": "..."}.
HERMES_AGENT_DIR points at the Hermes checkout when its venv does not already import it.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

VIEWER = "hermes-deck"               # the lease holder id: releasing never yanks another viewer's control
REASON = "Hermes Deck: Kontrolü al"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def _out(obj: dict, code: int = 0) -> int:
    print(json.dumps(obj, ensure_ascii=False))
    return code


def _hermes():
    """(lease module, hermes_constants), imported from Hermes itself."""
    src = os.environ.get("HERMES_AGENT_DIR")
    if src:
        sys.path.insert(0, os.path.expanduser(src))
    try:
        from tools.bot_desktop import lease
        import hermes_constants
        return lease, hermes_constants
    except ImportError:
        if src:
            raise
    # not importable from this interpreter: try the standard checkout next to the default Hermes home
    sys.path.insert(0, str(Path.home() / ".hermes" / "hermes-agent"))
    for name in [m for m in sys.modules if m == "tools" or m.startswith("tools.") or m == "hermes_constants"]:
        del sys.modules[name]
    from tools.bot_desktop import lease
    import hermes_constants
    return lease, hermes_constants


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--profile", required=True)
    act = ap.add_mutually_exclusive_group(required=True)
    act.add_argument("--hold", action="store_true")
    act.add_argument("--release", action="store_true")
    a = ap.parse_args(argv)
    if not NAME_RE.match(a.profile):
        return _out({"ok": False, "error": "bad profile name", "code": "bad-profile"}, 2)
    try:
        lease, hc = _hermes()
    except Exception as e:  # noqa: BLE001 - report any import failure as one line
        return _out({"ok": False, "error": f"cannot import Hermes ({type(e).__name__}: {e}); set DECK_HERMES_PYTHON "
                                           "to Hermes' venv python or HERMES_AGENT_DIR to its checkout",
                     "code": "no-hermes"}, 1)
    root = Path(hc.get_default_hermes_root())
    home = root if a.profile == "default" else root / "profiles" / a.profile
    if not home.is_dir():
        return _out({"ok": False, "error": f"unknown profile {a.profile}", "code": "unknown-profile"}, 1)
    try:
        if a.hold:
            now = lease.acquire(VIEWER, profile_key=str(home), reason=REASON)
        else:
            now = lease.release(VIEWER, profile_key=str(home))
    except Exception as e:  # noqa: BLE001
        return _out({"ok": False, "error": f"lease change failed ({type(e).__name__}: {e})", "code": "lease-error"}, 1)
    return _out({"ok": True, "holder": "human" if now.holder == lease.HUMAN else None})


if __name__ == "__main__":
    sys.exit(main())
