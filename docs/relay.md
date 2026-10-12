# Relay and device tools

The relay runs on the Hermes host. It combines plugin events, gateway health and usage counters into one live model,
serves it to the Deck app over an authenticated WebSocket, and routes optional agent-browser and desktop-control work
to Deck devices. Direct Hermes chat does not require it. What each relay feature does:
[features.md](features.md).

## Setup

Use Node.js 22.13+ (message history and usage use `node:sqlite`). Keep the relay on loopback or a private network
such as Tailscale or WireGuard; never expose it to the internet. The default listener is `127.0.0.1:9330`.

### Linux or manual startup

From the repository root:

```bash
cd relay
cp .env.example .env
openssl rand -hex 32
cp agents.example.json agents.json
npm ci --omit=dev
```

Put the generated token in `DECK_RELAY_TOKEN` and the private bind address in `DECK_RELAY_HOST` (the relay refuses to
start with a token shorter than 24 characters). Edit `agents.json` to map your profile names to display names, emoji
and, for Telegram mode, bot usernames (without `@`); use `null` for a profile without a Telegram bot:

```json
{ "profiles": { "default": { "name": "Hermes", "bot": "example_bot", "emoji": "⚖️" } } }
```

Run `npm start` for a foreground relay. For a Linux user service, copy
[the systemd unit](../relay/install/hermes-deck-relay.service) to `~/.config/systemd/user/`, adapt
`WorkingDirectory` (and the Node executable if `node` is not on the service's PATH), then follow the commands in the
unit's header (`systemctl --user enable --now hermes-deck-relay`; `loginctl enable-linger` keeps it running after
you log out).

### macOS

```bash
cd relay
bash install/macos.sh
# Edit .env: set DECK_RELAY_HOST to the private address.
bash install/macos.sh
```

The first run creates `.env` with a fresh token and exits. The second installs dependencies, creates `agents.json`
from the example if missing and starts a per-user launchd agent. Edit that mapping for your profiles. Re-running keeps
`.env`, `agents.json` and `data/`; logs go to `relay/logs/relay.log`.

### Connect Deck

In **Settings → Relay**, enter `ws://<relay-host>:9330` and the token, then **Save and connect**. `/health` is an
unauthenticated liveness check, not proof that the token works:

```bash
curl http://<relay-host>:9330/health
```

`node tools/watch.js` in `relay/` prints the live event stream in a terminal.

### Updating

Keep the relay at the same version as the app and plugin. How to check and apply updates on the host:
[updating.md](updating.md).

## Environment options

The full template with comments is [relay/.env.example](../relay/.env.example). The relay reads `relay/.env` (or the
file named by `DECK_RELAY_ENV`); restart it to apply changes.

| Variable | Purpose |
|---|---|
| `DECK_RELAY_HOST`, `DECK_RELAY_PORT`, `DECK_RELAY_TOKEN` | Private bind address (default `127.0.0.1`), port (default 9330), shared client token |
| `DECK_RELAY_QUERY_TOKEN` | `1` also accepts the token as `?token=` on the WebSocket; default off, leave it off |
| `HERMES_ROOT` | Hermes root containing `state.db` and `profiles/<name>/`; default `~/.hermes` |
| `DECK_HISTORY` | `0` disables message-history routes, not usage accounting |
| `CLAUDE_PROJECT_DIRS`, `CLAUDE_PROFILE`, `CLAUDE_CHAT_MAP` | Optional Claude Code transcript directories (comma-separated), the profile name they get, and a chat/session mapping file |
| `DECK_LAUNCHD_PREFIXES` | macOS only: launchd label prefixes shown in Fleet (default `ai.hermes.`) |
| `CODEXBAR` | CodexBar CLI path; default `/opt/homebrew/bin/codexbar` (macOS Homebrew). Empty disables it; quotas then come from plugin snapshots |
| `DECK_CDP_PORT`, `DECK_CDP_DEFAULT_AGENT` | Loopback agent-browser endpoint (default 9333, `0` disables it) and the agent the bare root URL belongs to |
| `DECK_BROWSER_DEFAULT` | `host` (default) prefers a browser on the agent host; `device` prefers an eligible active Deck device |
| `DECK_FALLBACK_BROWSER`, `DECK_FALLBACK_BROWSER_PATH` | `1` enables headless browsers on the relay host, one profile per agent (default off); optional browser executable |
| `DECK_FALLBACK_BROWSER_CDP`, `DECK_FALLBACK_BROWSER_CDP_AGENT` | Attach one already running loopback CDP browser to one agent (owner defaults to `DECK_CDP_DEFAULT_AGENT`) |
| `DECK_HOST_NAME` | Agent-host label in the Workspace host picker |
| `DECK_DESKTOP_HOST` | `1` lets desktop control fall back to the agent host's own screen; default off |
| `DECK_HERMES_PYTHON` | Hermes' Python for the Bot Desktop lease and Settings › Hermes config; auto-detects `~/.hermes/hermes-agent/venv/bin/python` (Hermes config also falls back to `DECK_MOBILE_BRIDGE_PYTHON`); a set path that no longer exists is skipped with a warning |
| `DECK_HERMES_CONFIG`, `HERMES_AGENT_DIR`, `DECK_HERMES_BIN` | Settings › Hermes config: `0` turns it off; Hermes' install directory when it is not the folder around that Python's venv; the `hermes` command for Restart gateway (default `hermes` on PATH); also the gateway restarts after a host update (fallback `~/.local/bin/hermes`) |
| `DECK_CUA_DRIVER` | The real cua-driver `deck-cua` runs for the agent-host route; default `cua-driver` on PATH |
| `DECK_SPACES`, `DECK_SPACESD_URL`, `DECK_SPACESD_TOKEN_FILE` | Agent spaces ([agent-spaces.md](agent-spaces.md)) |
| `DECK_SPACES_*`, `DECK_DESKTOPS_*`, `DECK_AUDIT*`, `DECK_SNAPSHOT_KEEP`, `DECK_RISKY_PATTERNS_FILE` | Agent desktops, activity log and safety ([agent-spaces.md](agent-spaces.md)) |
| `DECK_UPDATE_REPO`, `DECK_RELAY_AUTO_UPDATE`, `DECK_RELAY_SERVICE` | Relay updates ([updating.md](updating.md)) |
| `DECK_REMOTE_UPDATE` | Host update from the app (default on; [updating.md](updating.md#updating-from-the-app)) |
| `DECK_MOBILE_DEVICES_FILE`, `DECK_MOBILE_BRIDGE_PYTHON`, `DECK_MOBILE_BRIDGE_STREAM` | iOS app: mobile token store, and Hermes' Python plus `stream.py` path for the mobile bridge (empty stream disables it) |
| `HERMES_PUSH_URL`, `HERMES_PUSH_SENDER_TOKEN` | iOS push: your push gateway's HTTPS origin and this relay's sender credential ([push gateway](https://github.com/Hermes-Deck/ios-app/tree/main/push) in the iOS app repository) |
| `DECK_HOME`, `DECK_DRIVER_SOCK` | Plugin home (default `~/.hermes-deck`) and driver socket (default `<DECK_HOME>/driver.sock`). Must equal the plugin's |
| `DECK_EVENTS_DIR`, `DECK_STATE_DIR` | Plugin event and state folders, default `~/.hermes-deck/events` and `~/.hermes-deck/state`. They do not follow `DECK_HOME`: if the plugin uses `DECK_HOME=X`, set `X/events` and `X/state`; if it uses `DECK_EVENTS_DIR=Y`, set `Y` and `Y/state` |
| `DECK_DATA_DIR`, `DECK_AGENTS`, `DECK_DEVICE_TOKENS` | Relay state (default `relay/data/`), the agents mapping (default `relay/agents.json`) and the device-key hashes (default `devices.json` next to `.env`) |
| `DECK_UPLOAD_DIR` | Upload spool for large attachments, default `~/.hermes-deck/uploads`; must equal the plugin's `HERMES_DECK_UPLOAD_DIR` ([Large attachments](#large-attachments)) |
| `DECK_UPLOAD_MAX_FILE`, `DECK_UPLOAD_MAX_TOTAL`, `DECK_UPLOAD_MIN_FREE` | Bytes per file (default 2 GiB), per message (default 4 GiB), and free space kept on the spool's disk (default 10 GiB) |
| `DECK_DOWNLOAD_MAX` | Bytes per file this relay streams for [large downloads](#large-downloads) (default 8 GiB); the smaller of this and the plugin's `HERMES_DECK_DOWNLOAD_MAX` applies |

History is read on demand. Host-wide usage refreshes at startup and every minute, independently of history and of
which Hermes interfaces loaded the plugin ([host-usage.md](host-usage.md)). Database reads use read-only connections or
bounded private copies; the relay never writes Hermes session data. Costs may be estimates or unknown; Claude
subscription costs are API list-price equivalents, not invoices.

## Large attachments

Files for direct Hermes chats (desktop) and for the iOS app go through the relay when the relay and the Hermes plugin
share one upload spool on this host. The client streams each file over HTTP into the spool (`DECK_UPLOAD_DIR`, mode
0700; `<id>.part` while writing, then `<id>.bin` and `<id>.json`, 0600); the message then names only the upload ids,
and the plugin (`deck.attach_staged`) moves the files into the session's attachments folder and adds `@file:` refs to
the prompt. Small images still reach the model as pixels. No path and no file content travels over the bridge.

- Limits: 10 files, 2 GiB per file and 4 GiB per message by default (`DECK_UPLOAD_MAX_FILE`, `DECK_UPLOAD_MAX_TOTAL`).
  A new upload is refused with `507 disk_full` while it would leave less than `DECK_UPLOAD_MIN_FREE` (10 GiB) free.
  At most 10 pending uploads per token.
- Same host: the relay's WebSocket hello carries `uploads: {v, host, files, fileBytes, totalBytes}`, the plugin's
  `deck.version` carries `uploads: {v, host}`; `host` is a hash of the machine id and the spool's real path. The app and
  the relay's iOS bridge use the spool only when both match; otherwise the single-line path stays, with its limits of
  25 MB per file and 50 MB per message (an older plugin or relay, or two different spool folders).
- Cleanup: a finished upload that is not sent expires after 60 minutes; an unfinished `.part` without a writer is
  deleted. The relay sweeps at start and every few minutes and never deletes an upload a send is using.
- Dictation clips keep their 25 MB limit.

| Route | Purpose |
|---|---|
| `POST /uploads` | Desktop relay token only. `{name, mime, size}` → `{id}` |
| `PUT /uploads/<id>` | Raw body, streamed to disk; a length that differs from `size` deletes the upload (400) → `{id, name, size}` |
| `DELETE /uploads/<id>` | Cancels (also mid-write) or deletes an upload |
| `POST /mobile/uploads`, `PUT`/`DELETE /mobile/uploads/<id>` | The iOS app's uploads, same spool and limits |

`GET /mobile/capabilities` reports `limits: {files, fileBytes, totalBytes, dictationBytes, downloadBytes}` (the spool's
limits when the plugin takes staged files, else 25 MB / 50 MB; `downloadBytes` see below), `uploads: {v: 1, staged}` and
`downloads: {v: 1, direct}`.

## Large downloads

Files the agent offered in a session (a `MEDIA:` path or a backticked path in an assistant message) download through
the relay when the relay and the Hermes plugin share the same spool on this host (the same `host` id as for
[large attachments](#large-attachments)). The plugin decides whether the file may be downloaded at all:
`deck.file_grant` runs exactly the checks of `deck.file_read` (the path must stand in an assistant message of that
session; credential and Hermes state locations, symlinks and non-regular files are refused; a path only a user's
`@file:` / `@image:` line names stays limited to Hermes' attachment folders). It then writes a ticket
`<spool>/downloads/<id>.json` (0600, folder 0700) with the real path and the file's device, inode, size and mtime, and
answers `{id, name, size, mtime}`. The relay streams the file from disk for that id.

- The relay re-opens the path without following a final symlink and serves it only while device, inode, size and
  mtime still equal the ticket (`409` otherwise). A file that changes during the stream is cut short.
- `Range: bytes=a-` (and `a-b`, `-n`) answers `206` with `Content-Range`, so a dropped download resumes from its last
  byte; the desktop app retries automatically. A ticket can be reused until it expires (15 minutes); an app resuming
  later asks the plugin for a new one, which must name the same file.
- Limits: 8 GiB per file by default; the smaller of the relay's `DECK_DOWNLOAD_MAX` and the plugin's
  `HERMES_DECK_DOWNLOAD_MAX` applies. At most 64 live tickets; expired tickets are deleted by the plugin on the next
  grant and by the relay's upload sweep.
- Same host: the hello carries `downloads: {v, host, maxBytes}`, the plugin's `deck.version` carries
  `downloads: {v, host, maxBytes}` (only after the gateway restarted with a plugin that serves `deck.file_grant`). When
  they do not match, downloads use the chunk path through the bridge (`deck.file_read`, 1 MiB per call, 200 MB per
  file).
- iOS: `/mobile/files/info` asks the plugin for a ticket when it grants relay downloads and `GET /mobile/files/<id>`
  streams from disk with `Range`; the response shape is unchanged. `limits.downloadBytes` is the active limit
  (8 GiB, or 200 MB on the chunk path).

| Route | Purpose |
|---|---|
| `GET /downloads/<id>`, `HEAD /downloads/<id>` | Desktop relay token only. The granted file, `200` or `206` with `Range`; `Content-Disposition: attachment`, `Cache-Control: no-store`. `404` missing or expired ticket, `409` file changed, `413` over `DECK_DOWNLOAD_MAX`, `416` range past the end |
| `POST /mobile/files/info`, `GET /mobile/files/<id>` | The iOS app's downloads: direct from disk when the plugin grants them, else 1 MiB chunks through the bridge |

## Hermes config and restarts

Settings › Hermes config in the desktop app edits every setting of each Hermes profile's `config.yaml` through the
relay, and has buttons to restart the Hermes gateway and the relay. The relay runs `relay/tools/hermes-config.py` with
Hermes' Python (`DECK_HERMES_PYTHON`) for each request, so the field list, defaults and the save are Hermes' own code;
new Hermes settings appear without a Deck update.

- Desktop relay token only: `/hermes/*` refuses mobile tokens. `DECK_HERMES_CONFIG=0` turns the routes off.
- API keys, passwords, secrets and tokens are never listed, returned or written. Values are read as written in
  `config.yaml` (no `${VAR}` expansion).
- A save needs the revision the Deck loaded; a `config.yaml` changed since then is refused. Each save first copies
  the file to `config.yaml.bak-deck-<UTC timestamp>` next to it (the newest 10 are kept). Reset removes a key so
  Hermes' default applies again.
- Restart gateway runs Hermes' own gateway restart command (`DECK_HERMES_BIN`, default `hermes`): Hermes lets running
  turns finish, then its service manager starts the gateway again. Restart relay makes the relay exit cleanly; it is
  offered only when the relay runs under systemd or launchd (`INVOCATION_ID` / `XPC_SERVICE_NAME`), which starts it
  again.

| Route | Purpose |
|---|---|
| `GET /hermes/config/schema` | Fields `{type, description, category, options?, free?}`, category order, profiles |
| `GET /hermes/config?profile=<p>` | `{rev, values, explicit, managed, restartNeeded}` |
| `POST /hermes/config` | `{profile, rev, set: {key: value}, unset: [key]}`; answers the new values and the backup name |
| `GET`/`POST /hermes/restart` | Restart state; `{target: "gateway" \| "relay"}` |

## Agent browsers

Point each Hermes profile's browser configuration at the relay's loopback endpoint (adjust the port if changed):

```yaml
browser:
  cdp_url: http://127.0.0.1:9333/agent/<profile>
```

On the host, either set `DECK_FALLBACK_BROWSER=1` or configure `DECK_FALLBACK_BROWSER_CDP` for an already running
browser. The latter attaches to one profile's browser; the relay never launches, restarts or closes that external
browser.

To host on your desktop instead, install Chrome or Edge and turn on **Settings → This device → Agent browser allowed
on this device**. In **Workspace**, the host picker offers **Automatic**, **This computer** and the named agent host.
An explicit pick overrides automatic routing and persists across relay restarts; an unavailable pinned host is
reported rather than silently replaced. Cookies and pages move between devices only through **Transfer browser**,
after consent.

**Take control** blocks the agent's CDP input, navigation and tab-control commands; **Hand to agent** releases
control. Page scripts remain possible, so this is not isolation from an agent with shell access. See
[security notes](security.md#device-permissions).

## Desktop control

Device control is off until it is enabled on the device and a window is explicitly handed over. On the relay host:

1. Set `DECK_HERMES_PYTHON` if auto-detection cannot find Hermes' Python. Set `DECK_CUA_DRIVER` only for a host
   fallback or a custom driver. Keep `DECK_DESKTOP_HOST=0` unless the host's own screen is intended as a fallback.
2. In `relay/`, issue a device key with `node tools/device-token.js add <device-name>`. `list` shows issued names;
   `revoke <device-name>` disconnects that device's driver channel within 15 seconds.
3. In the Hermes profile's `.env`, set `HERMES_CUA_DRIVER_CMD=<checkout>/relay/bin/deck-cua`. Use this profile
   configuration and keep the Deck plugin enabled:

```yaml
computer_use:
  no_overlay: false
  permission_mode: standard
```

Restart the affected gateway only after its work is finished. On the desktop, **Settings → This device** holds the
**Device key**, the **Driver (cua-driver)** install, **Agents allowed to use this computer** and the **Desktop
control** switch. Then use **Hand to agent** in the **Bot screen** tab to choose and confirm a window. Background
control is the default; foreground input needs the separate **Foreground control for this session** opt-in.
**Take control** pauses agent desktop calls; **Stop** ends the local grant and pauses hosting even if the relay is
offline. The tab stays visible while desktop control is enabled or paused.

The wrapper uses the owner-only socket `~/.hermes-deck/driver.sock` by default. Device-route permissions are
enforced by Deck, the relay and the plugin. Captures go to the agent's model provider; do not hand over a window
containing data you do not want shared. See [the device protocol](bot-screen-protocol.md) for fences and
[security](security.md) for token and data handling.

## iOS app

The iOS app pairs with the relay: on the relay host run `node tools/mobile-token.js pair` (prints a single-use code,
valid for 5 minutes); `list` and `revoke <deviceId>` manage paired phones. The phone requires an HTTPS address, so
publish the relay to it through a private HTTPS reverse proxy (for example on your tailnet), never on the public
internet. Set `DECK_MOBILE_BRIDGE_STREAM` (and `DECK_MOBILE_BRIDGE_PYTHON`) for live Hermes sessions on the phone, and
the `HERMES_PUSH_*` variables for push. Building the app: [iOS app repository](https://github.com/Hermes-Deck/ios-app).
