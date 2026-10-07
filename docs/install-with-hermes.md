# Install with your Hermes

Give your Hermes this prompt on the machine where Hermes runs:

> Install Hermes Deck on this host from https://github.com/Hermes-Deck/hermes-deck. Use its skills/hermes-deck-setup skill. Ask me before changing any profile or starting services.

The [setup skill](../skills/hermes-deck-setup/SKILL.md) discovers the Hermes home and profiles, selects an interpreter with PyYAML, runs a read-only doctor, previews the plugin installer, and asks for approval. It can also prepare the optional relay and return the connection settings for Deck. It does not automatically restart a busy gateway or WebUI, expose a relay publicly, or post your token in chat.

An agent with terminal and file tools can read the skill directly from a clone. If those tools run in a container or on another machine, confirm that it is the intended Hermes host first. Reading the skill is enough; installing it into Hermes is optional:

```sh
hermes skills install Hermes-Deck/hermes-deck/skills/hermes-deck-setup
```

Review and approve the third-party skill. Current Hermes supports `owner/repo/path/to/skill` identifiers (resolver: `tools/skills_hub_github.py:175-178`; CLI entry: `hermes_cli/skills_hub.py:744-794`). If an older version cannot resolve this, clone the repository and ask Hermes to read `skills/hermes-deck-setup/SKILL.md`. The installed skill is a procedure, not a copy of the whole Deck repository; a full checkout is still needed.

## Manual equivalent

First locate your actual Hermes Python and decide **which profiles** to change. Inspect the `hermes` launcher rather than assuming the interpreter lives in your Hermes home: a Python shebang or a shell wrapper's `exec` target identifies the installation. Existing `<install-dir>/venv/bin/python` or `.venv/bin/python` may provide PyYAML; Windows equivalents use `Scripts/python.exe`. Managed launcher store Python may need the installation's dependency environment instead. The import check below must succeed with Python 3.10+.

The eight POSIX shell lines below install the plugin for **default only**. Set `HPY` to the verified absolute interpreter (it is just a shell variable, not a Deck setting). Preserve a custom `HERMES_HOME`; if it points into `profiles/<name>`, the installer normalizes it to the root. Replace `--profile default` with the selected name, or repeat the flag to include more profiles. Without `--profile`, the installer targets **all** configured profiles.

```sh
git clone https://github.com/Hermes-Deck/hermes-deck.git
cd hermes-deck
HPY="<absolute-hermes-python>"; export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
"$HPY" -B -c 'import sys, yaml; print(sys.executable); print(sys.version.split()[0])'
"$HPY" -B scripts/doctor.py --json
"$HPY" -B hermes-plugin/hermes-deck/install.py --profile default --dry-run
"$HPY" -B hermes-plugin/hermes-deck/install.py --profile default
"$HPY" -B scripts/doctor.py --json
```

**Pause after the dry run and approve the displayed plan before running the next line.** Existing checkouts should be inspected and reused, not overwritten. Native Windows users can use PowerShell and `py -3` to locate Python; use `$env:HERMES_HOME` for the home and invoke the selected interpreter with PowerShell's `&` operator. The plugin's events work on native Windows; the direct chat bridge needs Linux, macOS or WSL.

The installer keeps backups, enables `hermes-deck`, disables an enabled legacy `deck-events` plugin, and copies the shared bridge to `<hermes-root>/hermes-deck/stream.py`. Named-profile plugin/config files live under `<hermes-root>/profiles/<name>`. Unselected profiles are not changed; their missing plugin may still make a whole-host doctor return 1.

## Read-only diagnosis

From the checkout root, using the verified interpreter:

```sh
"$HPY" -B scripts/doctor.py
"$HPY" -B scripts/doctor.py --json --home "<hermes-home>" --hermes-dir "<hermes-install-dir>"
# Optional relay checks; never reads .env values:
"$HPY" -B scripts/doctor.py --json --relay-dir relay --relay http://<relay-host>:9330
```

Doctor reads homes/configs, plugin presence, `<profile-home>/hermes-deck/installed.json`, the shared stream and root `compat.json`. It compares Deck version/protocol and the minimum Hermes version when known. It never loads Hermes plugins, modifies files, reads `.env` contents, or starts/restarts services. Optional relay checks run `node --version`, stat `.env` for existence/permissions, and make a bounded unauthenticated `/health` GET without following redirects.

Hermes version detection reads installation metadata without importing Hermes. `hermes --version` on some releases writes update caches, so doctor intentionally does not call it. Use `--hermes-dir` for an undiscovered installation or `--hermes-version <observed-version>` to supply a version previously obtained from that CLI. If the installer metadata is absent, the version check is explicitly unknown.

| Exit | Meaning |
| --- | --- |
| 0 | No detected problems; warnings can still mean some checks are unknown |
| 1 | Problems found, such as a missing/disabled plugin or incompatible known version |
| 2 | Cannot complete diagnosis, such as unavailable PyYAML, invalid compatibility metadata or arguments |

Missing installed metadata is reported as `unknown, pre-0.3.6`, not an invented version. Missing `compat.json` leaves compatibility comparisons unavailable. A successful file check is not proof that the running gateway loaded the plugin.

## Restart and connect

Wait until all work and delegated workers are idle. Do **not** restart the gateway/WebUI hosting the current installation conversation. After it finishes, the operator can run:

```sh
hermes gateway restart
# For a selected named profile instead:
hermes --profile research gateway restart
```

Use the same custom `HERMES_HOME` when applicable. For manually supervised gateways or WebUI, use their actual verified supervisor command rather than an assumed service name. Shared gateways need one coordinated quiet window. Confirm a fresh Deck turn after restart.

For a local Linux/macOS Deck client, use `local`; for another machine use `ssh` with its SSH alias or `user@host`; for a Windows Deck client with Hermes in WSL use `wsl` and the WSL distribution. Set the Python path from detection and the stream path to `<hermes-root>/hermes-deck/stream.py`. WSL/SSH paths are **host-side POSIX paths**, not Windows drive paths.

## Optional relay and removal

Direct Hermes chat does not require the relay. Follow [relay.md](relay.md) for Linux/manual or macOS service installation. Relay history requires Node.js **22.13+**. For a custom Hermes home, set `HERMES_ROOT` in the relay configuration. Use loopback or a private network; a public/wildcard bind needs an explicit security warning and confirmation. Generate tokens into protected storage, not chat output. Connect Deck to `ws://<relay-host>:9330`; the token is in `<checkout>/relay/.env` under `DECK_RELAY_TOKEN`. `/health` proves liveness, not token authentication. See [updating.md](updating.md) before updating an existing installation.

To remove the plugin, preview then approve:

```sh
"$HPY" -B hermes-plugin/hermes-deck/install.py --profile default --uninstall --dry-run
"$HPY" -B hermes-plugin/hermes-deck/install.py --profile default --uninstall
```

Use the same selected profiles/home as installation. The shared stream and backups remain. If removing the relay, stop/disable its user service (`systemctl --user disable --now hermes-deck-relay`) or unload the recorded macOS launchd label (`launchctl bootout "gui/$(id -u)/com.hermes-deck.relay"` for the default label). Retain tokens, mappings and history until you decide which files to delete; never wipe Hermes state. Remove the shared stream only after no remaining profile uses it.
