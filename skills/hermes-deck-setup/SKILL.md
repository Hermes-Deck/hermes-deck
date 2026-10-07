---
name: hermes-deck-setup
description: "Use when installing, updating or diagnosing Hermes Deck on a Hermes host."
version: 0.1.0
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [hermes-deck, setup, installation, diagnosis, relay]
---

# Hermes Deck host setup

Install the Deck plugin on the machine **where Hermes runs**, not necessarily the machine displaying Deck. Diagnose before changing anything; ask which profiles to change and whether the optional relay is wanted. Commands below run through the `terminal` tool; inspect and edit files with `read_file`, `search_files`, `write_file` and `patch`.

## When to Use

- Install or diagnose Deck for CLI, gateway, WebUI, custom-home, multi-profile or WSL Hermes installations.
- Update the plugin after reviewing [updating.md](../../docs/updating.md).
- Remove a previously installed plugin or optional relay.

## Prerequisites

Use a complete checkout: the hub-installed skill does **not** include the plugin, doctor or relay. With approval to download source, run:

```sh
git clone https://github.com/Hermes-Deck/hermes-deck.git
cd hermes-deck
```

If a checkout already exists, discover its absolute path and use it as `terminal`'s working directory. Do not overwrite it or blindly pull local changes. Repository-relative links below refer to that checkout, not the hub's skill directory.

The optional reusable skill installation is:

```sh
hermes skills install Hermes-Deck/hermes-deck/skills/hermes-deck-setup
```

Review the third-party skill and approve installation first. GitHub subfolders use `owner/repo/path/to/skill`: verified in Hermes `tools/skills_hub_github.py:175-178`; the CLI delegates resolution through `hermes_cli/skills_hub.py:744-794`. On older Hermes versions that do not resolve this identifier, read the checkout's `skills/hermes-deck-setup/SKILL.md` directly instead; no skill installation is required.

## Procedure

### 1. Detect the host and interpreter (read-only first)

Run this through `terminal` to discover the home, platform and launcher without loading Hermes:

```sh
python3 -B -c 'import os, pathlib, platform, shutil; print("OS:", platform.system()); print("Hermes home:", os.environ.get("HERMES_HOME") or pathlib.Path.home()/".hermes"); print("Launcher:", shutil.which("hermes"))'
```

On native Windows use `py -3` instead of `python3` and PowerShell syntax for the later environment variables. If terminal tools operate in a sandbox or a different machine, verify that the discovered home belongs to the intended Hermes host; ask for host access rather than installing into the sandbox.

Read the launcher with `read_file` (resolve symlinks first). A Python shebang identifies the interpreter; `#!/usr/bin/env python...` must be resolved against PATH. A shell launcher is **not** a Python interpreter: inspect its `exec` target and installation directory. Check `<install-dir>/venv/bin/python`, `<install-dir>/.venv/bin/python` or the Windows `Scripts/python.exe` equivalent rather than assuming a home-relative install. Managed launchers can use store Python with dependencies selected by bootstrap; their raw `exec` interpreter may lack PyYAML. Inspect the installation's dependency environment metadata read-only, or use an existing Hermes venv that passes this check:

```sh
"<hermes-python>" -B -c 'import sys, yaml; print(sys.executable); print(sys.version.split()[0])'
```

Require Python 3.10+ and a successful PyYAML import. Record the absolute interpreter and install directory; do not install packages into a live managed environment merely to pass diagnosis.

For ordinary setup, observe `hermes --version`. **This Hermes command may write update caches**, depending on the installed release. If the task is strictly read-only, do not invoke it: doctor reads the installation's `install-stamp.json` (`baseVersion`) or literal `hermes_cli.__version__` without importing Hermes. If auto-detection fails, pass `--hermes-dir "<install-dir>"` or `--hermes-version "<observed-version>"`; do not invent a version.

### 2. Run doctor and show the findings

From the checkout root:

```sh
"<hermes-python>" -B scripts/doctor.py --json
```

If needed, add `--home "<hermes-home>" --hermes-dir "<install-dir>"`. A profile-local `HERMES_HOME` such as `<root>/profiles/<name>` is normalized to the root. Doctor reports the default home and named profiles, config enablement, plugin folders, installed version/protocol and shared `<root>/hermes-deck/stream.py`. It does not read `.env` contents or start/restart services.

Exit codes: **0** no detected problems (warnings may leave checks unknown), **1** problems found, **2** diagnosis cannot run completely or arguments are invalid. Missing `installed.json` is `unknown, pre-0.3.6`; missing `compat.json` means comparisons are unavailable. Show these limits, not a false compatibility pass.

### 3. Ask for scope

List the discovered profiles. Ask **which profiles should get the plugin**, and **whether the user wants a relay**. Wait for the answer. `default` names the root home. The installer without `--profile` targets every configured profile, so always pass the selected names explicitly, repeating the flag when needed.

### 4. Preview, approve, install

Use the same home and selected profiles for both commands:

```sh
"<hermes-python>" -B hermes-plugin/hermes-deck/install.py --home "<hermes-home>" --profile default --profile research --dry-run
# Show the plan and wait for approval before the real command.
"<hermes-python>" -B hermes-plugin/hermes-deck/install.py --home "<hermes-home>" --profile default --profile research
```

Replace the example profiles with the user's selection. The installer backs up configs and replaced plugin copies, enables `hermes-deck`, and disables an enabled legacy `deck-events` plugin while preserving its data. It installs a shared bridge at `<hermes-root>/hermes-deck/stream.py`, not inside each named profile. Re-run doctor and read back each selected profile's `plugins.enabled`; leave other profiles untouched. A doctor exit 1 caused only by unselected profiles is not an installation failure.

### 5. Defer busy gateway/WebUI restarts

Never restart a gateway or WebUI hosting the current conversation, active turns, or delegated workers. Gateway activity counters can miss workers; ask the operator to confirm idle status. Plugin files being present/enabled does not prove a running process loaded them.

Give the user the applicable command to run **after this conversation and all work finish**:

```sh
hermes gateway restart                         # root/default profile
hermes --profile research gateway restart      # selected named profile
```

For custom homes, run with the same `HERMES_HOME`. For manually supervised/WebUI processes, identify the actual launch/service command and provide its verified restart instructions instead of guessing a unit name. Shared or multiplexed gateways need a coordinated quiet window, not one restart per apparent profile. Verify a fresh turn in Deck after the operator restarts; do not claim it was observed beforehand.

### 6. Optional relay

Skip if declined. Read [docs/relay.md](../../docs/relay.md) and follow its current OS-specific procedure. Require `node --version` to be **22.13+** (`node:sqlite` history). Configure `HERMES_ROOT` to the detected root for custom homes.

Default to `127.0.0.1:9330` or a user-approved private address. Do not bind `0.0.0.0`, `::`, or a public address without explicit confirmation and a warning that the relay exposes authenticated host/device functionality; prefer a private network or SSH tunnel.

On Linux/manual startup, from `relay/`, copy `.env.example` to `.env` only if absent and `agents.example.json` to `agents.json` only if absent; run `npm ci --omit=dev`. Generate a token **directly into the protected file**, never into tool output/chat. For a newly copied `.env` only:

```sh
node -e 'const fs=require("node:fs"),c=require("node:crypto"); const p=".env"; fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace(/^DECK_RELAY_TOKEN=.*$/m,"DECK_RELAY_TOKEN="+c.randomBytes(32).toString("hex")),{mode:0o600}); fs.chmodSync(p,0o600)'
```

Do not regenerate an existing token. Set `DECK_RELAY_HOST` and `DECK_RELAY_PORT` with the approved values and edit the synthetic agent mapping for the selected profiles; do not dump credentials while editing. The alternative generator in relay docs is `openssl rand -hex 32`; redirect its output into protected local storage rather than a chat transcript.

For a Linux user service, prepare the unit only after approval:

```sh
mkdir -p "$HOME/.config/systemd/user"
cp relay/install/hermes-deck-relay.service "$HOME/.config/systemd/user/hermes-deck-relay.service"
```

Edit its `WorkingDirectory` and Node executable environment to the actual installation using `patch`. After separate permission to start a service, run `systemctl --user daemon-reload` and `systemctl --user enable --now hermes-deck-relay`. Ask before optional `loginctl enable-linger "$USER"`. Do not replace an existing unit blindly.

On macOS, from `relay/`, use `bash install/macos.sh`. The first run creates a protected `.env` and exits; edit its private bind address, then obtain permission before the second run, which starts/restarts launchd. Existing `.env` makes even the first invocation a service-changing action. The default label is `com.hermes-deck.relay` (honor `DECK_RELAY_LABEL` if customized).

Verify with `curl --fail http://<relay-host>:9330/health`, then from the checkout root:

```sh
"<hermes-python>" -B scripts/doctor.py --relay-dir relay --relay http://<relay-host>:9330 --json
```

`/health` is liveness, **not** proof of token authentication. Confirm the real Deck connection separately. For updates, follow [docs/updating.md](../../docs/updating.md); do not duplicate its updater procedure.

### 7. Give the user a paste-into-Deck block

Fill only observed paths and the mode appropriate to **the Deck client**:

```text
Connection mode: ssh | wsl | local
SSH target: <user@host-or-SSH-alias> (ssh only)
WSL distribution: <distribution> (wsl only, Windows Deck client)
Hermes Python: <absolute-host-python>
stream.py: <hermes-root>/hermes-deck/stream.py
Relay URL: ws://<relay-host>:9330 (if installed)
Token location: <checkout>/relay/.env, DECK_RELAY_TOKEN
```

Use POSIX paths from inside WSL, not Windows drive paths. `local` bridge mode applies to Linux/macOS clients on the Hermes host; native Windows clients use WSL or SSH for the bridge. Provide a **local-only** token-reading command, never execute it through the chat tool unless the user explicitly requests token disclosure:

```sh
node -e 'const s=require("node:fs").readFileSync("<checkout>/relay/.env","utf8"); const m=s.match(/^DECK_RELAY_TOKEN=(.*)$/m); if(!m)process.exit(1); console.log(m[1])'
```

### 8. Uninstall when requested

Preview `install.py --uninstall --dry-run` with the same `--home` and chosen `--profile` flags; show the plan and get approval, then repeat without `--dry-run`. Gateway restarts still wait for idle time. The installer moves plugin copies to backup folders, restores migrated enablement and **leaves the shared stream in place**.

For the optional Linux relay, after approval run `systemctl --user disable --now hermes-deck-relay`; on macOS use `launchctl bootout "gui/$(id -u)/com.hermes-deck.relay"` (substitute the recorded label). Inventory the unit/plist, `.env`, mappings, relay data, checkout and installer backups. Ask which to retain, then remove only explicitly approved files with the available file tools. Do not remove the shared stream while any profile still uses Deck, and do not delete Hermes state or broadly wipe directories.

## Pitfalls

- `HERMES_HOME` can be custom or profile-local; root installation and per-profile config are distinct.
- The launcher shebang may be `/bin/sh`, not Hermes Python. Check PyYAML in the selected interpreter.
- Multiplexed gateways and hidden workers make automatic restarts unsafe; a quiet restart is an operator action.
- Native Windows plugin events work, but the direct bridge uses a POSIX host (Linux, macOS or WSL).
- Node below 22.13 lacks required relay history support; a successful Node launch alone is insufficient.
- `/health` and on-disk plugin enablement are not authenticated-client or running-hook verification.

## Verification

- Frontmatter parses; the skill references a complete checkout and real command flags.
- Doctor ran before and after; every selected profile has the plugin and config enablement, and the shared stream exists.
- Known version/protocol/minHermes comparisons match `compat.json`; unknown checks are explicitly labeled.
- Optional relay health, Node and `.env` permissions pass; no token appears in chat or saved evidence.
- Record pending operator restart/fresh Deck turn and authenticated connection separately from completed file installation.
