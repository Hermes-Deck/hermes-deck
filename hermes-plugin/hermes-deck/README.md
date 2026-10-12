# hermes-deck plugin

Provides Deck's direct Hermes connection and optional relay events.

| Part | Purpose | Runtime |
|---|---|---|
| `events.py` | Turn/tool/token/sub-agent events, gateway/cron snapshots, opt-in desktop fence | `~/.hermes-deck/events/`, `state/`, `cu/` |
| `observer.py`, `stream.py` | Live sessions, history, prompts, model/turn controls, approvals and questions | `<HERMES_HOME>/hermes-deck/processes/` and private control sockets |

## Install

Requires Hermes plugin hooks and TUI-gateway support, Python 3.10+ and PyYAML. The direct bridge needs Linux, macOS or WSL; native Windows runs only the events part. Use the Python executable from your Hermes installation:

```bash
cd hermes-plugin/hermes-deck
<hermes-python> install.py --dry-run
<hermes-python> install.py
```

The installer validates all selected profiles before writing. It backs up changed `config.yaml` files, edits only `plugins:`, enables `hermes-deck` and disables a legacy `deck-events` entry if enabled. Existing plugin settings remain. An explicitly disabled `hermes-deck` stops the plan.

Copies go into each profile's `plugins/hermes-deck/`; previous copies are backed up, while linked developer checkouts remain untouched. The root entry point is `<Hermes root>/hermes-deck/stream.py`, normally `~/.hermes/hermes-deck/stream.py`. It uses the `hermes-deck.v1` schema; install the matching app and plugin.

| Option | Effect |
|---|---|
| `--dry-run` | Show the plan without changes |
| `--profile NAME` | Select profiles; repeatable; `default` selects the root profile |
| `--home PATH` | Override the Hermes root; otherwise use `HERMES_HOME` or `~/.hermes` |
| `--uninstall` | Disable Deck and restore the `deck-events` plugin it disabled, if still present; leave the stream entry point in place |

Restart affected gateways only after foreground/background work has finished: a restart kills background sub-agents too. Reload any other running Hermes interface that needs the plugin. In Deck's **Settings → Hermes**, use the installer's Python and stream paths, choose SSH/WSL/local and test the connection. Relay events appear after the next turn. See [the main installation guide](../../README.md#install).

Backups can contain private configuration; do not share them.

## Settings and boundaries

The bridge has no network listener. It uses owner-only Unix control sockets (0600); SSH supplies remote access. Snapshot metadata and event previews use redaction, but history/control replies can contain conversation content. Treat access to the Hermes account and relay as privileged.

| Setting | Default | Effect |
|---|---|---|
| `plugins.entries.hermes-deck.settings.bridge` | `true` | `false` leaves events only; `HERMES_DECK_BRIDGE=0` / `1` overrides it |
| `DECK_HOME` | `~/.hermes-deck` | Events/desktop runtime root, separate from `HERMES_HOME` |
| `DECK_EVENTS_DIR` | `<DECK_HOME>/events` | Events folder; when set, state goes to `<DECK_EVENTS_DIR>/state`. The relay's `DECK_EVENTS_DIR`/`DECK_STATE_DIR` must point at the same folders |
| `DECK_BOT_SCREEN` | opt-in | `1` enables the desktop fence, `0` disables it; a `HERMES_CUA_DRIVER_CMD` pointing at `deck-cua` also opts in |
| `DECK_DRIVER_SOCK` | `<DECK_HOME>/driver.sock` | Relay's local desktop-driver socket |
| `HERMES_DECK_UPLOAD_DIR` | `~/.hermes-deck/uploads` | Upload spool the relay writes large attachments to (`deck.attach_staged`); must be the relay's `DECK_UPLOAD_DIR`. Download tickets (`deck.file_grant`) go to its `downloads/` subfolder |
| `HERMES_DECK_DOWNLOAD_MAX` | `8589934592` (8 GiB) | Bytes per file `deck.file_grant` grants for a relay download; `deck.file_read` keeps its 200 MB |

The stream accepts a constrained set of gateway and Deck-native methods, not arbitrary RPC. Model changes are session-local; profile/asset/cron writes are not exposed. The desktop fence is an opt-in that can block or rewrite `computer_use` calls.

Files the agent offered are read by two Deck-native methods that share one authorization (`observer.py`
`FileReader.authorize`: the path must stand in an assistant message of that session's stored transcript, never a
credential or Hermes state location, never a final symlink, a regular file; a path only a user's `@file:` / `@image:`
line names stays within Hermes' attachment folders):

| Method | Params | Reply |
|---|---|---|
| `deck.file_read` | `{session_id, path, offset, length, profile?}` | One chunk of at most 1 MiB as base64; files up to 200 MB |
| `deck.file_grant` | `{session_id, path, profile?}` | `{id, name, size, mtime}`; writes a ticket `<HERMES_DECK_UPLOAD_DIR>/downloads/<id>.json` (0600, 15 minutes, at most 64 live) that the relay on this host streams from disk ([Large downloads](../../docs/relay.md#large-downloads)) |

`deck.version` reports `downloads: {v, host, maxBytes}` only once the running gateway serves `deck.file_grant` (after a
restart with this plugin).

Desktop-control setup is in [the relay guide](../../docs/relay.md#desktop-control); grant/fence details are in [the protocol](../../docs/bot-screen-protocol.md).

## Tests

```bash
cd hermes-plugin/hermes-deck
python -m unittest discover -p 'test_*.py'
```

Tests use temporary homes and synthetic data, including installer dry runs/updates/uninstall. PyYAML is needed. Unix-socket integration tests skip on Windows.
