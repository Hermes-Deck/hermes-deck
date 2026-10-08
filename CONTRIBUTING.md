# Contributing to Hermes Deck

Thanks for helping. This guide covers the repository layout, development setup, tests, the pull-request flow and
releases. Security problems go through
[SECURITY.md](SECURITY.md), not public issues.

## Repository map

| Path | What it is | Language |
|---|---|---|
| `app/` | Electron desktop app. `main/` is the main process (connections, secrets, IPC), `renderer/` the UI (plain DOM, no framework), `test/` its tests, `scripts/` build and capture tools | JavaScript |
| `relay/` | Optional relay on the Hermes host: tails plugin events, reads usage/history, routes agent browsers and desktop control | JavaScript (Node) |
| `hermes-plugin/hermes-deck/` | The Hermes plugin: `events.py` (relay events, desktop-control fence), `observer.py` + `stream.py` (direct connection), `install.py` (installer); tests are `test_*.py` beside them | Python |
| `skills/hermes-deck-setup/` | Hermes skill that installs Hermes Deck on a host | Markdown |
| `scripts/` | Repository tools (`doctor.py`, `check-public.sh`) | Python, shell |
| `docs/` | User and developer documentation | Markdown |
| `compat.json` | Product version, protocol number and minimum Hermes version | JSON |

How the parts talk to each other: [docs/architecture.md](docs/architecture.md).

## Development setup

You need Git, Node.js 22.13+ (Node 24 is what release builds use) and Python 3.10+ with PyYAML.

### Desktop app

```bash
(cd relay && npm ci)            # some app tests load the relay
(cd app && npm ci && npm start)
```

`npm ci` in `app/` runs a postinstall step that copies the bundled fonts. `npm run electron:install` downloads the
Electron binary explicitly if it is missing. On Windows, `npm run shortcuts` adds Start menu and Desktop shortcuts
(Windows notifications need the Start menu one).

To develop against a real Hermes, install the plugin from your checkout on a test host or test profile and point
**Settings → Hermes** at it. To develop without one, use the fixtures below.

### Relay

```bash
cd relay
npm ci
cp .env.example .env            # set DECK_RELAY_TOKEN (openssl rand -hex 32) and a private DECK_RELAY_HOST
cp agents.example.json agents.json
npm start
```

`node tools/watch.js` prints the live event stream. Full guide: [docs/relay.md](docs/relay.md).

### Plugin

Edit the files in `hermes-plugin/hermes-deck/`. Try the installer only against a temporary Hermes home (it needs a
`config.yaml` there):

```bash
cd hermes-plugin/hermes-deck
fake="$(mktemp -d)" && printf 'plugins:\n  enabled: []\n' > "$fake/config.yaml"
python install.py --home "$fake" --dry-run
```

Never test the installer against a Hermes home you use.

## Running tests

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the JavaScript syntax check, the app, relay and plugin
tests, a secret scan (gitleaks, configured by `.gitleaks.toml`) and `scripts/check-public.sh`. Run the ones for the
parts you changed before opening a pull request.

```bash
# JavaScript syntax (app and relay)
find app relay -name '*.js' -not -path '*/node_modules/*' -not -path '*/dist/*' -print0 | xargs -0 -n1 node --check

# App and relay (install both dependency sets first)
(cd relay && npm ci)
(cd app && npm ci && npm test)
(cd relay && npm test)

# Plugin (Python 3.10+, PyYAML)
(cd hermes-plugin/hermes-deck && python -m unittest discover -p 'test_*.py')

# Repository tools (doctor and the public-content checker)
python3 -m unittest discover -s scripts -p 'test_*.py'

# Public-content check (personal paths, private IPs, emails, host names in tracked files)
bash scripts/check-public.sh
```

Run one file while iterating: `node --test test/<name>.test.js` in `app/` or `relay/`, or `python test_<name>.py` in
the plugin folder. CI tests app and relay on Node 22 and 24, and the plugin on Python 3.12.

Some tests skip themselves when a dependency is missing (no Chrome/Chromium/Edge, no `node:sqlite`, Windows for Unix
socket tests, running as root for the real-browser test). Read the skip lines rather than counting them as coverage.

Optional integration tools in `app/scripts/`: `workspace-e2e.js` (Node, real headless browser) and
`botscreen-e2e.js` (Electron, fake driver). They need the relay's dependencies.

## Fixtures and screenshots

The app can replay synthetic data instead of Telegram, the relay or a Hermes host. Run from `app/`, with a disposable
`--user-data-dir` whenever you are unsure a flag is isolated:

```bash
npx electron . --shot=chat.png --fixture=test/fixtures/telegram.json --select=t5
npx electron . --shot=activity.png --fixture=test/fixtures/agents.json --select=u7001 --tab=activity
npx electron . --shot=usage.png --fixture=test/fixtures/usage.json --tab=tokens
npx electron . --shot-pet=pet.png --pet-skin=orb --pet-state=waiting
```

All capture flags (`--fixture`, `--scene`, `--select`, `--tab`, `--theme`, `--botscreen`, `--bridge-fake`,
`--hermes-view`, `--workspace-demo`, …) are listed in [docs/development.md](docs/development.md#fixtures-and-capture-tools).
Fixture data lives in `app/test/fixtures/`; the fake Hermes host is `app/test/fake-stream.js`.

## Privacy rule

This is a public repository. Never put real data into it or into issues and pull requests:

- no real chats, Telegram ids, bot usernames, phone numbers, tokens, API keys or device keys;
- no real host names, IP addresses, home-directory paths or personal names and emails;
- screenshots only from fixtures or synthetic data;
- logs with tokens and personal identifiers removed.

Use synthetic values such as `example.com`, `<relay-host>` and `owner/name`. Run `bash scripts/check-public.sh` before
you push; CI runs it and a gitleaks secret scan on every pull request. If a match is a genuine false positive, add a
narrow allowlist entry with a reason in the script (or `.gitleaks.toml`), never a whole-tree exception.

Maintainers can also keep their own identifiers out of the history without publishing them: put one extended regex
per line in the repository secret `PRIVATE_DENYLIST`, and the secret scan job checks every new commit's author,
message and added lines against it, reporting only the commit and `file:line`. Commit as your GitHub login
with your GitHub noreply address (`git config user.name <login>`, `git config user.email
<id>+<login>@users.noreply.github.com`). Pull requests land by rebase, so that identity is kept.

## Branches and pull requests

1. Fork the repository (or create a branch if you have write access) and branch from `main`.
2. Keep one topic per pull request. Unrelated fixes go in separate pull requests.
3. Add or update tests for behaviour you change, and update the docs the change affects.
4. Add an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for every user-visible change, written for
   users (what changed for them), in the right group (`Added`, `Changed`, `Fixed`, `Removed`, `Security`).
5. Open the pull request against `main` and fill in the template. CI must be green before review.

Every change goes through a reviewed pull request, rebased onto `main` (no merge commits). A maintainer lands it
with a local fast-forward push (`git push origin <branch>:main`) once CI is green, never with GitHub's merge
buttons: those rewrite the committer, which the secret scan only sees after the commit is on `main`.

### Commit style

- Summary line in the imperative mood, at most about 72 characters: `Relay: retry the quota fetch after a timeout`.
  A component prefix (`App:`, `Relay:`, `Plugin:`, `Docs:`) helps.
- A body, after one blank line, that explains **why**: the problem, the decision, anything a reviewer or a future
  reader needs. The diff already shows what changed.

### UI text

UI strings live in `app/renderer/i18n.js`, in two tables: `en` (English, the default) and `tr` (Turkish). Add every
new key to both; `app/test/i18n.test.js` fails when the tables differ in keys or placeholders.

## Versioning and releases

App, relay and plugin share one version ([docs/compatibility.md](docs/compatibility.md)). The version changes only
in a release pull request, which updates together:

- `compat.json` (`version`, and `protocol` / `minimum` / `minHermes` when they change),
- `app/package.json` and `relay/package.json` (and the `version` fields of their `package-lock.json`),
- `hermes-plugin/hermes-deck/plugin.yaml`,
- `hermes-plugin/hermes-deck/stream.py` (`VERSION`; also `PROTOCOL` there, in `install.py` and in
  `relay/src/compat.js` when the protocol changes),
- `CHANGELOG.md`: rename `[Unreleased]` to `[x.y.z] - YYYY-MM-DD` and start a new empty `[Unreleased]`.

`relay/test/compat.test.js` checks that these version and protocol fields agree. Bump `protocol` only for a breaking change in what app, relay and
plugin send each other.

When the release commit reaches `main` (fast-forward push), the release is published automatically ([release.yml](.github/workflows/release.yml)):

1. On every push to `main` the workflow reads `app/package.json`. If release `v<version>` is already published, it
   stops. A push that does not change the version releases nothing.
2. It runs the full CI suite on that commit; a failure stops the release.
3. It builds the installers on Windows (`npm run dist:win`: NSIS Setup and ZIP, x64) and macOS (`npm run dist:mac`:
   DMG and ZIP, arm64 and x64), unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`).
4. It collects the installers, adds a source archive `hermes-deck-<version>-source.tar.gz` (`git archive`), writes
   `SHA256SUMS.txt` for all of them, attests build provenance (`actions/attest-build-provenance`), creates the GitHub
   release `v<version>` with the `## [<version>]` section of `CHANGELOG.md` as notes (falling back to the commit list
   when that section is missing), and publishes it as the latest release. Installed apps then offer the update.

Pushing a tag `vX.Y.Z` that matches `app/package.json` releases that commit; a manual run (**Actions → Release → Run
workflow**) can keep the result as a draft for review. Never move an existing tag: bump the version instead.

## Working with AI coding agents

AI-assisted contributions are welcome under the same rules as any other. Point your agent at
[AGENTS.md](AGENTS.md), which lists the invariants and test commands. Agent plans, scratch files, transcripts and
reports stay outside the repository (do not commit them under `docs/`), and you are responsible for reviewing what
your agent changed before you open the pull request.
