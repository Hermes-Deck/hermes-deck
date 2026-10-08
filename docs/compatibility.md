# Compatibility

What Hermes Deck needs on each machine, and how its parts stay compatible with each other.

## Versions and protocol

Hermes Deck ships three parts that work together: the desktop app (`app/`), the optional relay (`relay/`) and the
Hermes plugin (`hermes-plugin/hermes-deck/`). They share **one product version**. Install the same version of each
part; updating one means updating the others.

[`compat.json`](../compat.json) at the repository root is the single source of truth:

| Field | Meaning |
|---|---|
| `version` | The product version. `app/package.json`, `relay/package.json` and `hermes-plugin/hermes-deck/plugin.yaml` carry the same value. |
| `protocol` | An integer for wire compatibility between app, relay and plugin. It changes only on a breaking change to what they send each other. Different versions with the same protocol interoperate. |
| `minHermes` | The oldest Hermes Agent version the plugin supports. |
| `minimum` | The oldest app, relay and plugin versions this release still works with. |

The plugin records its installed version per Hermes home, and the relay reports the relay and plugin versions to the
app. The app compares them with its own version:

- **Version drift** (a relay or plugin older than the app): Settings shows a notice with the command that updates
  that part. Drift never blocks a connection.
- **Protocol mismatch**: the affected connection is blocked with a clear message until the parts are updated.

How to update each part: [updating.md](updating.md).

## Hermes Agent

Use a Hermes Agent version at or above `minHermes` in `compat.json`. Run the plugin installer with Hermes' own
Python (the interpreter of your Hermes installation), which already has the modules the plugin imports.

The plugin registers these hooks (`provides_hooks` in
[`plugin.yaml`](../hermes-plugin/hermes-deck/plugin.yaml)); Hermes must provide all of them:

`pre_llm_call`, `post_llm_call`, `pre_tool_call`, `post_tool_call`, `post_api_request`, `api_request_error`,
`pre_transcription`, `post_auxiliary_call`, `subagent_start`, `subagent_stop`, `on_session_start`,
`on_session_end`, `agent_loop_stopped`.

The direct connection (the plugin's bridge part and `stream.py`) also uses Hermes internals: the TUI gateway
(`tui_gateway`), Hermes' session store and home helpers (`hermes_cli`, `hermes_constants`), Hermes' speech-to-text
tool for dictation (`tools.transcription_tools`, configured by Hermes' `stt:` settings) and, for desktop control,
Hermes' Bot Desktop lease (`tools.bot_desktop`). Features that depend on a missing internal fail with an error
instead of affecting the agent.

## Operating systems

| Part | Supported |
|---|---|
| Desktop app installers | Windows x64 (`Setup.exe` or ZIP), macOS Apple Silicon and Intel (DMG or ZIP) |
| Desktop app from source | Anything Electron runs on; Windows and macOS are the tested targets |
| Hermes host, direct connection | Linux, macOS, or WSL on Windows. Native Windows Hermes runs only the plugin's events part (the bridge needs Unix sockets). |
| Relay | Linux (systemd user unit) or macOS (launchd agent); any OS with Node.js for a foreground run |
| Agent spaces, own desktop per agent | Linux or macOS agent host; the desktops run in Docker on the agent host (Docker or colima) or on a Deck computer (Docker Desktop) |
| Agent spaces, shared agent desktop (shared and overflow modes) | macOS agent host (cua-spacesd is a macOS app) |
| Desktop control on your device | Windows and macOS |
| Agent browsers on your device | Windows or macOS (also Linux source runs) with Chrome, Chromium or Edge installed |

Connection modes in the app: **SSH** (another machine) from Windows or macOS, **WSL** on Windows, **Local** on macOS
and Linux.

## Runtimes

| Component | Requirement |
|---|---|
| Plugin installer and plugin | Python 3.10 or newer with PyYAML (Hermes' own Python has both). CI tests Python 3.12. |
| Relay | Node.js 22.13 or newer: message history and host-wide usage use `node:sqlite`. CI tests Node 22 and 24. |
| App from source | Node.js 22.12 or newer (Electron's requirement). Release builds use Node 24. |

The published desktop installers include their own runtime; you do not need Node.js to run them.
