# Updating Hermes Deck

Hermes Deck has three parts that are released together and share one version number:

| Part | Runs on | Updated by |
|---|---|---|
| Desktop app (`app/`) | your computer | Settings › General › Updates |
| Relay (`relay/`) | the Hermes host | `deck-relay-update` (this page) |
| Hermes plugin (`hermes-plugin/hermes-deck/`) | the Hermes host, in each profile | `install.py`, or `deck-relay-update apply --with-plugin` |

## Versions and compatibility

`compat.json` in the repository root records the shared version, the wire protocol and the oldest supported
Hermes Agent:

```json
{ "version": "1.1.0", "protocol": 1, "minHermes": "0.21.5",
  "minimum": { "app": "0.3.6", "relay": "0.3.6", "plugin": "0.3.6" } }
```

- `version` is the same in `app/package.json`, `relay/package.json` and `hermes-plugin/hermes-deck/plugin.yaml`
  (a test enforces it).
- `protocol` changes only when the wire format breaks. Parts with different versions but the same protocol
  work together.
- `minHermes` is the oldest Hermes Agent that provides every hook the plugin uses.

### Where each part reports its version

- **Relay:** `GET /health` (no auth needed) and the WebSocket `hello` message include `v` (the relay
  version), `protocol`, and `plugins`. `plugins` maps each Hermes profile to the plugin version installed
  there, or `null` if the profile has no record (no plugin, or a plugin older than 0.3.6). If the update check
  has run, `/health` also includes `updateAvailable` and `latest`. The mobile `capabilities` include
  `relayVersion` and `protocol`.
- **Plugin:** `install.py` writes `<profile home>/hermes-deck/installed.json` (`{version, protocol,
  installedAt}`) for every profile it installs into. `--dry-run` does not write it, and `--uninstall` removes it.
  Over the direct connection, `stream.py` answers the `deck.version` request with `{version, protocol}`.

### What the app shows

- **Relay newer than the app:** a notification that a newer app version is available.
- **Relay older than the app:** Settings › Relay shows "Relay vX is older than this app (vY)" and the
  command to run on the host.
- **Plugin older than the app:** Settings › Hermes shows it for each profile (from the relay) and for the
  direct connection (from `deck.version`; a plugin older than 0.3.6 does not recognise this request).
- **Protocol mismatch:** that one connection stops, and a banner in the top bar says which connection it is.
  A version difference alone never stops anything.

Each difference triggers one notification. The app remembers which notifications it has shown, so
reconnecting or restarting does not repeat them.

## Updating the relay

### Install layout

`deck-relay-update apply` needs an **install root**:

```
<root>/releases/<version>/   one extracted release per version; the newest 3 are kept
<root>/current               symlink to releases/<version>; the service runs <root>/current/relay
<root>/shared/               .env, agents.json, data/ (and logs/ on macOS), never changed by an update
```

Each release links its `relay/.env`, `relay/agents.json`, `relay/data` and `relay/logs` to `<root>/shared/`.

A plain checkout (`relay/` inside a git clone) still works without this layout. You update it with
`git pull` and `npm ci --omit=dev` in `relay/`, then restart. `apply` refuses to run on a plain checkout.

### Converting a checkout (once)

Run this from the checkout you are converting. Do a dry run first:

```sh
node relay/bin/deck-relay-update init ~/hermes-deck --dry-run
node relay/bin/deck-relay-update init ~/hermes-deck
```

`init` does the following:

1. Copies `relay/.env`, `agents.json`, `data/` and `logs/` to `<root>/shared/`. The checkout keeps its own
   copies.
2. Copies the checkout, without `.git` and `node_modules`, to `<root>/releases/<version>/`.
3. Links the shared files into that copy and runs `npm ci --omit=dev` and the self-check.
4. Points `current` at the new copy.

`init` never changes your service. When it finishes, switch the service over yourself:

- **Linux (systemd user unit):** in `~/.config/systemd/user/hermes-deck-relay.service`, set
  `WorkingDirectory=<root>/current/relay`. Then run
  `systemctl --user daemon-reload && systemctl --user restart hermes-deck-relay`.
- **macOS (launchd):** run `bash <root>/current/relay/install/macos.sh`.

### Checking and applying

```sh
<root>/current/relay/bin/deck-relay-update --check      # exit 0: up to date, 10: a newer release exists
<root>/current/relay/bin/deck-relay-update apply --dry-run
<root>/current/relay/bin/deck-relay-update apply        # latest release
<root>/current/relay/bin/deck-relay-update apply --version 1.0.1
<root>/current/relay/bin/deck-relay-update apply --with-plugin
```

You can also run the updater as `node <path>/relay/bin/deck-relay-update …`.

`apply` takes these steps:

1. Downloads `hermes-deck-<version>-source.tar.gz` and `SHA256SUMS.txt` from the GitHub release. The
   archive must be listed in `SHA256SUMS.txt` with a matching sha256. Otherwise `apply` stops and nothing
   changes.
2. Extracts the archive to `<root>/releases/<version>/` and checks that its `relay/package.json` has that
   version.
3. Links the shared files and runs `npm ci --omit=dev` in the new `relay/`, then
   `node src/index.js --self-check`. The self-check loads the configuration, reads `agents.json` and opens
   each profile's history read-only. It exits without listening on a port.
4. Switches `current` to the new release in one rename and restarts the service. On Linux that is
   `systemctl --user restart hermes-deck-relay`. On macOS it is
   `launchctl kickstart -k gui/<uid>/com.hermes-deck.relay`.
5. Polls `/health` (on `DECK_RELAY_HOST`/`DECK_RELAY_PORT` from the relay's `.env`) until it reports the new
   version, for up to 30 s. If that fails, `apply` switches `current` back, restarts the service and exits
   with code 1.
6. Keeps the newest 3 releases. The current and previous ones are always kept.

Only one update can run at a time per install root (`<root>/.update.lock`).

`--dry-run` prints every step and changes nothing. `--force` reinstalls the same version, or lets the latest
release replace a newer relay.

### Updating the plugin with the relay

`apply --with-plugin` runs `hermes-plugin/hermes-deck/install.py` from the new release. It only runs for
profiles that already have the plugin (a `plugins/hermes-deck` folder that their `config.yaml` names). It runs
the installer with `--dry-run` first, then for real. It never restarts a Hermes gateway: restarting stops
running work, so it prints the commands for you to run at a quiet moment (`hermes gateway restart`,
`hermes -p <profile> gateway restart`).

The Hermes root is `HERMES_ROOT`, otherwise `~/.hermes`. The Python used is `DECK_HERMES_PYTHON`, otherwise
`<HERMES_ROOT>/hermes-agent/venv/bin/python` if it exists, otherwise `python3`.

### Daily check (optional)

```sh
cp <root>/current/relay/install/hermes-deck-relay-update.{service,timer} ~/.config/systemd/user/
# edit ExecStart in the .service file if your install root is not ~/hermes-deck
systemctl --user daemon-reload && systemctl --user enable --now hermes-deck-relay-update.timer
```

The timer runs `deck-relay-update --check --auto` once a day. The result goes to
`<data dir>/update-check.json`, and `/health` reports it as `updateAvailable` and `latest`. The timer installs
an update only if the relay's `.env` contains `DECK_RELAY_AUTO_UPDATE=1` (default: off) and the relay runs
from an install root.

### Environment

| Variable | Meaning |
|---|---|
| `DECK_UPDATE_REPO` | GitHub `owner/name` to update from (default: `repository` in `relay/package.json`) |
| `DECK_RELAY_ROOT` | the install root, if the updater cannot work it out from its own path |
| `DECK_RELAY_SERVICE` | systemd `--user` unit (default `hermes-deck-relay`), or the launchd label on macOS (default `com.hermes-deck.relay`) |
| `DECK_RELAY_AUTO_UPDATE` | `1`: the daily `--check --auto` also applies the update |
| `DECK_HERMES_PYTHON` | Python for `--with-plugin` |
| `GH_TOKEN` / `GITHUB_TOKEN` | optional; only raises GitHub's rate limit |

## Updating the plugin on its own

Run this on the Hermes host from a checkout or an extracted release, using Hermes' own Python:

```sh
python hermes-plugin/hermes-deck/install.py --dry-run
python hermes-plugin/hermes-deck/install.py
```

Then restart each changed profile's gateway at a quiet moment.

## Updating the desktop app

Use Settings › General › Updates.

- **Windows:** the app downloads the newer release's installer, checks it against `SHA256SUMS.txt` and runs it.
- **macOS:** the app downloads the `.zip`, checks it the same way and shows it in Finder. Unzip it and move
  Hermes Deck to Applications. Builds are not notarized, so the app does not install them silently.
