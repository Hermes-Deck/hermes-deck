"""hermes-deck: the one Hermes plugin for Hermes Deck.

It combines two parts in one plugin:

  events  (events.py, formerly the `deck-events` plugin)
          an append-only NDJSON tap for the relay: ~/.hermes-deck/events/<profile>.ndjson, gateway/cron
          snapshots in ~/.hermes-deck/state/, and, only when a profile opts into Bot screen, the
          computer_use fence and its frames in ~/.hermes-deck/cu/.
  bridge  (observer.py + stream.py)
           live session snapshots in <HERMES_HOME>/hermes-deck/processes/ and a private Unix control socket,
          which stream.py relays to the Deck's direct connection (app/main/bridge.js) over SSH/WSL/stdio.

The events paths remain unchanged. The bridge uses the hermes-deck runtime directory only;
existing installs must update their Deck stream paths and restricted SSH keys manually.
Both parts share the hook contract of deck-events: a hook never raises. When both
parts handle the same hook, each runs (events first) and the first non-None result is returned.

Options (all optional):
  HERMES_DECK_BRIDGE=0 / plugin setting `bridge: false`   turn the bridge part off (events only)
  DECK_BOT_SCREEN, DECK_HOME, DECK_EVENTS_DIR, ...        as documented for the events part
"""
from __future__ import annotations

import importlib.util
import logging
import os
import sys
from pathlib import Path

logger = logging.getLogger(__name__)
NAME = "hermes-deck"
HERE = Path(__file__).resolve().parent
POSIX = os.name != "nt"          # the bridge needs Unix sockets and POSIX process checks (WSL on Windows)


def _sibling(name: str):
    """events.py / observer.py from this folder, loaded once per process by file path, so the plugin works
    however Hermes imports this package (and when a test loads __init__.py directly)."""
    key = f"_hermes_deck_plugin_{name}"
    mod = sys.modules.get(key)
    if mod is None:
        spec = importlib.util.spec_from_file_location(key, HERE / f"{name}.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[key] = mod
        try:
            spec.loader.exec_module(mod)
        except BaseException:
            sys.modules.pop(key, None)
            raise
    return mod


def _setting(ctx, key: str, default: bool) -> bool:
    """A yes/no plugin setting (plugins.entries.hermes-deck.settings.<key>); "false"/"off"/"0" count as no."""
    try:
        get = getattr(ctx, "get_config", None)
        value = get(key, default) if callable(get) else default
    except Exception:
        return default
    if isinstance(value, str):
        return value.strip().lower() not in ("", "0", "false", "no", "off")
    return bool(value)


def _bridge_on(ctx) -> bool:
    flag = os.environ.get("HERMES_DECK_BRIDGE", "").strip()
    if flag in ("0", "1"):
        return flag == "1"
    return _setting(ctx, "bridge", True)


def _start_bridge(ctx):
    """The observer, or None when the bridge is off or cannot start here (events keep working either way)."""
    if not _bridge_on(ctx):
        return None
    if not POSIX:
        logger.warning("Hermes Deck bridge needs a POSIX Hermes host (Linux, macOS or WSL); only the events "
                       "part runs here.")
        return None
    try:
        from hermes_constants import get_hermes_home
        observer = _sibling("observer")
        unload = getattr(ctx, "on_unload", None)
        return observer.start(Path(get_hermes_home()) / "hermes-deck",
                              on_unload=unload if callable(unload) else None)
    except Exception:
        logger.warning("Hermes Deck bridge could not start; only the events part runs.", exc_info=True)
        return None


def _compose(hook: str, parts):
    """One handler for a hook both parts use: each part runs, a failing part is logged and skipped, and the
    first non-None result (a pre_tool_call directive, pre_llm_call context) is returned."""
    def handler(**kwargs):
        result = None
        for part, fn in parts:
            try:
                value = fn(**kwargs)
            except Exception:
                logger.warning("hermes-deck: the %s part of %s failed", part, hook, exc_info=True)
                continue
            if result is None and value is not None:
                result = value
        return result
    handler.__name__ = handler.__qualname__ = f"hermes_deck_{hook}"
    return handler


def hooks(events, observer=None) -> dict:
    """hook name -> handler: the events hooks as they are, composed with the observer's where both exist."""
    parts = {name: [("events", fn)] for name, fn in events.HOOKS.items()}
    if observer is not None:
        for name in _sibling("observer").HOOKS:
            parts.setdefault(name, []).append(("bridge", getattr(observer, name)))
    return {name: fns[0][1] if len(fns) == 1 else _compose(name, fns) for name, fns in parts.items()}


def register(ctx):
    events = _sibling("events")
    observer = _start_bridge(ctx)
    for name, fn in hooks(events, observer).items():
        ctx.register_hook(name, fn)
    events._start_snapshots()
