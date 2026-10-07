# AGENTS.md

Instructions for AI coding agents working in this repository. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Repository map and entry points

| Component | Entry points | Tests |
|---|---|---|
| Desktop app (Electron) | `app/main/main.js` (window, `deck://` protocol, IPC), `app/main/preload.js` (the only renderer API), `app/main/bridge.js` (direct Hermes connection), `app/main/relay.js` (relay client), `app/main/telegram.js`, `app/main/settings.js`; UI in `app/renderer/app.js` + one module per view | `app/test/*.test.js` |
| Relay (Node) | `relay/src/index.js` (config from `.env`, startup), `relay/src/server.js` (HTTP + WebSocket routes), `relay/src/model.js`, `relay/src/usage.js`, `relay/src/presence.js`, `relay/src/cdp.js`, `relay/src/driver.js`, `relay/src/mcpfence.js` | `relay/test/*.test.js` |
| Hermes plugin (Python) | `hermes-plugin/hermes-deck/__init__.py` (`register`), `events.py` (hooks → NDJSON, desktop fence), `observer.py` (live sessions, control socket), `stream.py` (stdio bridge), `install.py` | `hermes-plugin/hermes-deck/test_*.py` |
| Versions | `compat.json`, `app/package.json`, `relay/package.json`, `hermes-plugin/hermes-deck/plugin.yaml` | version-consistency test |

Architecture and data flow: [docs/architecture.md](docs/architecture.md). Desktop-control wire format:
[docs/bot-screen-protocol.md](docs/bot-screen-protocol.md).

## Invariants (do not break these)

- **The relay is never public.** It defaults to `127.0.0.1` and refuses to start with a token shorter than 24
  characters. Every route except `/health` needs the token (constant-time compare); the `?token=` query form stays
  opt-in (`DECK_RELAY_QUERY_TOKEN`). Do not add unauthenticated routes, `0.0.0.0` defaults or token-in-URL defaults.
- **The renderer has no Node access.** Every window and view uses `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`. Pages reach the system only through the named calls in their preload
  (`app/main/preload.js` for the main window; `pet-preload.js` and `cua/bar-preload.js` for the pet and the
  desktop-control bar).
  Keep the CSP in `app/renderer/index.html` strict (`default-src 'none'`, `connect-src 'none'`). Untrusted text
  (chats, relay data, agent output) goes into the DOM as text nodes, never as HTML.
- **IPC sender checks.** Main-window IPC handlers are registered through `app/main/ipc-guard.js`, which accepts only
  the top-level `deck://app/index.html` frame. Register new channels the same way; `app/test/ipc-guard.test.js`
  calls every channel as a foreign frame.
- **Tokens never reach the renderer.** Secrets (relay token, Telegram API hash and session, device key, GitHub
  token) live in the main process, encrypted with Electron `safeStorage`. `settings.publicView()` exposes only
  whether a secret is set (`hasToken`, `hasDeviceToken`). File paths stay in main too: the renderer gets opaque
  tokens/refs.
- **The plugin runs inside Hermes.** Hooks must never raise and never block: wrap every handler, keep writes to one
  short append, no network calls or waits in a hook (quota fetches run in background threads with deadlines). A
  failing part is logged and skipped. The only hook that may change a tool call is the opt-in desktop-control fence
  for `computer_use`, which fails closed.
- **Device permissions are local and off by default.** Agent-browser and desktop hosting switches start off and can
  only be changed on the device itself; the relay cannot turn them on. Keep the CDP guard (`app/main/cdp-tunnel.js`)
  and the three desktop-control fences (plugin, `relay/src/mcpfence.js`, `app/main/cua/`) at least as strict.
- **Direct-connection mutations are never replayed.** A mutation whose connection drops fails; the user retries.
- **Read-only on Hermes data.** The relay reads Hermes' `state.db` read-only (or through private copies); it never
  writes Hermes session data.

## Commands

```bash
# app and relay (install both dependency sets; some app tests load the relay)
(cd relay && npm ci) && (cd app && npm ci)
(cd app && npm test)                 # or: node --test test/<file>.test.js
(cd relay && npm test)

# plugin (Python 3.10+, PyYAML)
(cd hermes-plugin/hermes-deck && python -m unittest discover -p 'test_*.py')

# JS syntax, as CI runs it
find app relay -name '*.js' -not -path '*/node_modules/*' -not -path '*/dist/*' -print0 | xargs -0 -n1 node --check

# public-content check
scripts/check-public.sh
```

Run the installer only against a temporary Hermes home (`install.py --home <tmp> --dry-run`), never a real one. Do
not run the app against a live relay, Telegram session or Hermes profile for screenshots; use the fixtures in
`app/test/fixtures/` ([docs/development.md](docs/development.md#fixtures-and-capture-tools)).

## Conventions

- **UI strings** go in `app/renderer/i18n.js`, in both the `en` and the `tr` table, with the same placeholders.
  `app/test/i18n.test.js` enforces this. Code, comments and docs are in English.
- **Docs are verified against code.** Every env var, flag, path and UI label you write must exist (grep for it).
  Update the docs your change affects.
- **Changelog:** every user-visible change adds an entry under `## [Unreleased]` in `CHANGELOG.md`.
- **Versions** change only in a release pull request ([CONTRIBUTING.md](CONTRIBUTING.md#versioning-and-releases)).

## Never commit

Mirrors the secrets section of `.gitignore`:

- `.env` and `.env.*` (except `.env.example`), `*.session`, `*.session.*`
- `relay/agents.json`, `relay/devices.json`, `relay/data/`, `relay/logs/`
- screenshots (`*.png` outside the vetted folders) and anything with real chats, ids, tokens, host names, IP
  addresses, home-directory paths or personal names

## Your own files

Write plans, notes, reports, transcripts and scratch output **outside the repository**. Do not add agent reports or
handoff notes under `docs/` or anywhere else in the tree.
