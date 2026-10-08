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
| `DECK_HERMES_PYTHON` | Hermes' Python for the Bot Desktop lease; auto-detects `~/.hermes/hermes-agent/venv/bin/python` |
| `DECK_CUA_DRIVER` | The real cua-driver `deck-cua` runs for the agent-host route; default `cua-driver` on PATH |
| `DECK_SPACES`, `DECK_SPACESD_URL`, `DECK_SPACESD_TOKEN_FILE` | Agent spaces ([agent-spaces.md](agent-spaces.md)) |
| `DECK_SPACES_*`, `DECK_DESKTOPS_*`, `DECK_AUDIT*`, `DECK_SNAPSHOT_KEEP`, `DECK_RISKY_PATTERNS_FILE` | Agent desktops, activity log and safety ([agent-spaces.md](agent-spaces.md)) |
| `DECK_UPDATE_REPO`, `DECK_RELAY_AUTO_UPDATE`, `DECK_RELAY_SERVICE` | Relay updates ([updating.md](updating.md)) |
| `DECK_MOBILE_DEVICES_FILE`, `DECK_MOBILE_BRIDGE_PYTHON`, `DECK_MOBILE_BRIDGE_STREAM` | iOS app: mobile token store, and Hermes' Python plus `stream.py` path for the mobile bridge (empty stream disables it) |
| `HERMES_PUSH_URL`, `HERMES_PUSH_SENDER_TOKEN` | iOS push: your push gateway's HTTPS origin and this relay's sender credential ([push gateway](https://github.com/Hermes-Deck/ios-app/tree/main/push) in the iOS app repository) |
| `DECK_HOME`, `DECK_DRIVER_SOCK` | Plugin home (default `~/.hermes-deck`) and driver socket (default `<DECK_HOME>/driver.sock`). Must equal the plugin's |
| `DECK_EVENTS_DIR`, `DECK_STATE_DIR` | Plugin event and state folders, default `~/.hermes-deck/events` and `~/.hermes-deck/state`. They do not follow `DECK_HOME`: if the plugin uses `DECK_HOME=X`, set `X/events` and `X/state`; if it uses `DECK_EVENTS_DIR=Y`, set `Y` and `Y/state` |
| `DECK_DATA_DIR`, `DECK_AGENTS`, `DECK_DEVICE_TOKENS` | Relay state (default `relay/data/`), the agents mapping (default `relay/agents.json`) and the device-key hashes (default `devices.json` next to `.env`) |

History is read on demand. Host-wide usage refreshes at startup and every minute, independently of history and of
which Hermes interfaces loaded the plugin ([host-usage.md](host-usage.md)). Database reads use read-only connections or
bounded private copies; the relay never writes Hermes session data. Costs may be estimates or unknown; Claude
subscription costs are API list-price equivalents, not invoices.

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
