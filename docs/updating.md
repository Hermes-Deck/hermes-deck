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
- **Update the host:** with a relay that offers host updates, Settings › Relay also shows **Update the host to vY**
  and its progress, and Settings › Hermes lists each gateway that waits for a restart, with **Restart now**. See
  [Updating from the app](#updating-from-the-app).

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

Each release links its `relay/.env`, `relay/agents.json`, `relay/devices.json`, `relay/data` and `relay/logs` to `<root>/shared/`.

A plain checkout (`relay/` inside a git clone) still works without this layout. You update it with
`git pull` and `npm ci --omit=dev` in `relay/`, then restart. `apply` refuses to run on a plain checkout unless you
pass `--adopt`, which converts it first (see below). **Update the host** in the app does that for you.

### Converting a checkout with its service (adopt)

`adopt` converts the checkout and moves the relay's service in one step. Run it from the checkout the service runs,
dry run first:

```sh
node relay/bin/deck-relay-update adopt --dry-run
node relay/bin/deck-relay-update adopt
```

The install root is the directory you pass (`adopt DIR`), else `DECK_RELAY_ROOT` (from the environment or the
relay's `.env`), else `~/.local/share/hermes-deck-relay`. `adopt` does the following:

1. Finds the service that runs this checkout's `relay/`. On Linux that is the systemd `--user` unit named by
   `DECK_RELAY_SERVICE` (default `hermes-deck-relay`) whose `WorkingDirectory` or `ExecStart` names the checkout. On
   macOS it is the launchd agent `~/Library/LaunchAgents/<label>.plist` (label `DECK_RELAY_SERVICE`, default
   `com.hermes-deck.relay`) that names it. Paths are compared by their real path, so a service that names the checkout
   through a symlink matches too. An update started from the app passes the relay's own service name (its launchd
   label, or its systemd unit), so a service with another name needs no setting. When there is no such service,
   `adopt` stops before changing anything.
2. Runs `init` (below) into the install root.
3. Stops the service and copies `.env`, `agents.json`, `devices.json`, `data/` and `logs/` to `<root>/shared/` again, so
   nothing the relay wrote during the copy is lost.
4. Points the service at `<root>/current/relay`. On Linux it writes the drop-in
   `~/.config/systemd/user/<unit>.service.d/hermes-deck-install-root.conf` (`WorkingDirectory`, and `ExecStart` when that
   names the checkout); the unit file itself is not changed. On macOS it replaces the checkout's path in the plist and
   keeps the old file as `<root>/.adopt/service.plist`.
5. Starts the service and polls `/health` for the same version, for up to 30 s. If the relay does not come up, it
   puts the service back (removes the drop-in or restores the plist), restarts it, and removes the install root.

The checkout is never changed. After `adopt` the service no longer uses it, so you can keep it or delete it.

State that the service keeps outside the checkout through `DECK_RELAY_ENV`, `DECK_DATA_DIR`, `DECK_AGENTS` or
`DECK_DEVICE_TOKENS` (in the service's environment or the relay's `.env`) is not moved: the service keeps those
settings, so the relay goes on using that state, and `adopt` lists those paths before it starts.

### Converting a checkout without its service (init)

`init` makes the install root but leaves the service alone. Run this from the checkout you are converting. Do a dry
run first:

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
`<HERMES_ROOT>/hermes-agent/venv/bin/python` if it exists, otherwise `python3`. A `DECK_HERMES_PYTHON` path that no
longer exists (Hermes reinstalled elsewhere) is skipped with a warning in the log.

### Updating from the app

Settings › Relay and › Hermes show **Update** when the relay or a profile's plugin is older than the app. It sends
`POST /host/update {version}` (the app's version) to the relay. The relay starts `deck-relay-update apply --with-plugin`
(or `deck-relay-update plugin` when only the plugin is behind) as a separate job, outside its own service: a
transient `systemd-run --user` unit on Linux, a generated launchd job on macOS. Progress is written to
`<data>/update-status.json` and shown in the app.

- A relay that runs from a plain checkout gets `apply --adopt`: the job first moves it to an install root
  ([adopt](#converting-a-checkout-with-its-service-adopt), shown as "Moving the relay to an install root"), then
  updates it. The status file and restart queue move with `data/` to `<root>/shared/data/`. On macOS that job's
  own log stays in the checkout's `relay/logs/update-job.log` until it ends, since launchd opened it before the move.
- `deck-relay-update plugin` on a plain checkout installs the checkout's own `hermes-plugin/`, without an install root.
- A relay older than this feature cannot adopt its checkout: the app then shows the command to update it once by
  hand, in its folder (`git pull && cd relay && npm ci --omit=dev`, then restart the relay).

- Only a desktop Deck with the relay token and its device key, connected at that moment, can start it. The iOS app cannot.
- The host never moves to an older version, and only one update runs at a time.
- `DECK_REMOTE_UPDATE=0` in the relay's `.env` refuses update and restart requests from the app. Restarts already
  queued by an earlier update still complete when the gateway is idle.
- Settings › General › Updates › **Automatically update the host to this app's version** (off by default) sends the
  same request when the app has updated and the host is behind. A version whose update failed is not tried again
  automatically.

Gateways: profiles whose plugin changed are listed in `<data>/restart-queue.json`. The relay restarts each one with
`hermes [-p <profile>] gateway restart` once it has been idle on two checks at least 14 s apart: no active agents in
its `gateway_state.json`, and no delegation log written in the last 15 minutes that has not ended. A busy profile
waits; the app offers **Restart now**. If the relay cannot read a profile's gateway state, it never restarts it on
its own. Set `DECK_HERMES_BIN` if `hermes` is not on the relay's PATH.

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
| `DECK_RELAY_ROOT` | the install root, if the updater cannot work it out from its own path; also where `adopt` puts a new one (default `~/.local/share/hermes-deck-relay`) |
| `DECK_RELAY_SERVICE` | systemd `--user` unit (default `hermes-deck-relay`), or the launchd label on macOS (default `com.hermes-deck.relay`); `adopt` switches this service. Updates started from the app use the relay's own service name when this is not set |
| `DECK_RELAY_AUTO_UPDATE` | `1`: the daily `--check --auto` also applies the update |
| `DECK_HERMES_PYTHON` | Python for `--with-plugin` |
| `GH_TOKEN` / `GITHUB_TOKEN` | needed only while the update repository is private (a token with read access to it); otherwise optional, it raises GitHub's rate limit. Read from the environment, else from the relay's `.env` (updates started from the app read it there) |

## Updating the plugin on its own

Run this on the Hermes host from a checkout or an extracted release, using Hermes' own Python:

```sh
python hermes-plugin/hermes-deck/install.py --dry-run
python hermes-plugin/hermes-deck/install.py
```

Then restart each changed profile's gateway at a quiet moment.

## Updating the desktop app

Use Settings › General › Updates. **Desktop app channel** has two choices:

- **Stable (main)** (default): the latest published stable release from `Hermes-Deck/hermes-deck`.
- **Test**: compares this build with the exact head of `test/desktop-fixes` in the same repository.
  New commits appear even with source builds disabled and with no published Test package.
  Published `vX.Y.Z-test.N` prereleases remain a fallback when no newer branch commits are known;
  they never hide newer branch commits. Source Test builds (no release tag) do not use this package fallback:
  a tag alone cannot prove that a package is newer than their source commit. Other prereleases and drafts
  are ignored (100 recent releases checked).

Changing the channel saves only that choice. Press **Check now** to see the **Target version**; press the
install button to open a native confirmation. Cancel is the default. Downloads use the checked release ID,
not a moving latest-release URL. A changed asset requires another check and confirmation. Missing installers,
unsupported architectures, or missing/mismatched checksums prevent installation. Existing repository/branch
overrides remain stored but no longer select update code: only the canonical repository is used.

A Test build can return to the same or an older Stable version, after a warning and explicit confirmation.
Back up app data first: older versions may not understand Test settings (including multiple saved hosts), and
may remove this selector. The updater does not reset settings, but cannot make older software understand them.
The selector does not change relay/plugin channels, restart gateways, or enable automatic host updates.
The separate **Automatically update the host** preference keeps its existing behavior.

Source builds use the existing developer opt-in, **Offer builds from unreleased source (developers)**.
It is visible directly under Updates in Test; Stable keeps it under Advanced. Enable it and press **Check now**
again. The source button names the branch; native confirmation names Test/Stable and the full exact commit SHA.
Cancel is the default. Checks and channel selection never run npm or build/install anything.

The source route supports **Test/test/desktop-fixes** and **Stable/main** (Stable still prefers a newer release).
Each attempt creates a fresh `<userData>/update-src-*` directory, clones the canonical repository,
checks its origin, fetches the confirmed SHA, checks it out detached, verifies HEAD, and runs `npm ci`
and the existing platform build command. Old checkouts (including `update-src`, linked directories and
their targets) are never reused or cleaned. Per-attempt directories remain for build diagnostics/manual
handoff; remove only known updater-created directories when no build or installer is using them.
The branch must contain this build's commits; divergent, unknown, malformed or incomplete comparisons cannot
start a source build. Unpaginated comparisons beyond GitHub's 250-commit limit fail closed; use a published
package or a separately reviewed manual build rather than treating a partial list as the branch head.
The target is checked again before building and before installation. A moved head, changed channel, disabled
source setting or build error prevents installation. On macOS, source freshness is checked again after
copying and signature verification; failure removes the staged candidate without starting the swap.
This narrows the staging window, but a remote ref check and local launch cannot be atomic.
The current app stays untouched on build failure.

The build environment sets `DECK_UPDATE_CHANNEL`, clears `DECK_RELEASE_TAG`, and passes `DECK_SOURCE_COMMIT`.
`scripts/build-info.js` verifies that SHA against git HEAD and records the channel's canonical branch even
in a detached checkout. Source Test builds have channel `test`, branch `test/desktop-fixes`, the exact SHA,
and no release tag. Returning to Stable therefore remains available without inventing a release version.

This runs dependency scripts locally and requires git/npm plus a supported installed app. Linux cannot build
or install through this updater. The first app containing this updater still needs a separately approved
bootstrap installation; branch commits cannot add this feature to an older installed updater.

- **Windows x64:** the normal installed app downloads the selected release's NSIS installer, checks it against
  `SHA256SUMS.txt` and runs it. Portable or isolated copies (including a separate TEST installation/profile)
  refuse automatic installation because NSIS targets the normal installation. Update those copies manually.
- **macOS arm64/x64:** the app verifies the release ZIP, validates the staged bundle, and uses the existing
  swap/rollback helper for a writable installed bundle. A development, translocated or read-only bundle uses
  the manual Finder handoff instead. Packages remain unsigned/not notarized as documented in the README.

### Preparing a Test package (maintainers)

Source Test updates do not require a published release. A bootstrap or optional Test package can still be
prepared separately. No Test publishing workflow runs on branch pushes. After review and publication approval:

1. Choose an unused immutable `vX.Y.Z-test.N` tag whose base version matches `app/package.json`.
   Do not move an existing tag or replace published assets.
2. Build the approved commit with `DECK_RELEASE_TAG` set to that tag. On Windows PowerShell:
   `$env:DECK_RELEASE_TAG = 'vX.Y.Z-test.N'; npm run dist:win` from `app/`.
   On macOS: `DECK_RELEASE_TAG=vX.Y.Z-test.N npm run dist:mac` from `app/`.
   `scripts/build-info.js` embeds the channel and exact tag without changing the shared product version.
   Use actual version numbers, not the placeholders. A local unpublished Test build can instead set
   `DECK_UPDATE_CHANNEL=test`; do not claim that build is a published release.
3. Keep the existing asset names (`Hermes-Deck-<version>-Setup.exe`, `-mac-arm64.zip`, `-mac-x64.zip`).
   Combine the installers in one directory and run `node app/scripts/checksums.js <directory>` to create
   one `SHA256SUMS.txt` covering every offered installer. Keep the existing release provenance review.
4. Publish the approved tag as a GitHub **prerelease**, not latest, with the installers and checksum file.
   This is a separate public write requiring maintainer approval; the existing stable release workflow
   does not create Test releases. A Windows ZIP alone is not an automatic-update installer.
5. On a normal test installation, check Test, verify the target tag, cancel once, then approve installation
   and verify the reopened build. Also test an explicitly confirmed return to Stable. Until those packages
   exist, local fixture tests do not prove a published install end to end.
