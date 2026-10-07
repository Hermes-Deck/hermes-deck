# Development

Setup, tests and the pull-request flow are in [CONTRIBUTING.md](../CONTRIBUTING.md). This page covers the parts that
need more detail: running from source, fixtures and capture tools, builds, and local troubleshooting.

## Run from source

Use Node.js 22.12+ for the app (Electron's requirement) and 22.13+ for relay history and usage (`node:sqlite`). CI
tests Node 22 and 24; release builds use Node 24. Install both dependency sets before app tests, since some fixtures
load the relay:

```bash
(cd relay && npm ci)
(cd app && npm ci && npm start)
```

`npm run electron:install` in `app/` explicitly downloads the Electron binary. On Windows, `npm run shortcuts` adds
Start menu and Desktop shortcuts and ensures the binary exists; Windows notifications need the Start menu shortcut.
`npx electron . --quit` asks a running Deck to quit.

## Tests

From the repository root:

```bash
(cd app && npm test)
(cd relay && npm test)
(cd hermes-plugin/hermes-deck && python -m unittest discover -p 'test_*.py')
(cd push && npm test)
```

Use Python 3.10+ with PyYAML for the plugin installer tests. Plugin tests use temporary homes; never run `install.py`
against a live Hermes home for a test. Some relay and app tests need a browser or `node:sqlite` and skip when it is
unavailable; inspect skips rather than treating them as coverage. The real-browser fallback test skips as root on
Linux instead of adding `--no-sandbox`.

[CI](../.github/workflows/ci.yml) runs JavaScript syntax checks, the app and relay tests and the plugin tests on every
push and pull request. It installs app and relay dependencies before testing; it does not build installers.

## Fixtures and capture tools

These are developer tools, not the normal startup path. Run the examples from `app/`, with a disposable absolute
`--user-data-dir` when testing flags that are not fixture-isolated. Never use a live relay, Telegram session or
Hermes profile for captures; everything you commit must be synthetic.

```bash
npx electron . --shot=chat.png --fixture=test/fixtures/telegram.json --select=t5
npx electron . --shot=activity.png --fixture=test/fixtures/agents.json --select=u7001 --tab=activity
npx electron . --shot=usage.png --fixture=test/fixtures/usage.json --tab=tokens
npx electron . --shot-pet=pet.png --pet-skin=orb --pet-state=waiting
```

The first three replay fixtures instead of Telegram and the relay, and use default settings in a separate temporary
profile unless you supply one. Pet captures also get a separate temporary profile and skip saved settings. A bare
`--shot` without those isolation modes can load real settings; do not assume every screenshot flag is safe.

| Flag | Purpose |
|---|---|
| `--shot=<png>`, `--wait=<ms>` | Capture the hidden app window after rendering |
| `--fixture=<json>`, `--scene=<name>`, `--select=<key>` | Fixture file, fixture-defined scene and selected chat |
| `--tab=activity\|fleet\|tokens\|workspace\|screen` | Right-panel tab |
| `--tab=settings[:<section>]` | Opens the Settings view (not a tab), at `general`, `hermes`, `relay`, `telegram`, `desktop` or `device` |
| `--theme=basalt\|marble\|aegean\|system` | Screenshot runs (`--shot`, `--shot-pet`, `--shot-botbar`) in that colour theme; the saved choice is untouched |
| `--pet-size=0.75\|1\|1.25\|1.5` | `--shot-pet` at that pet size |
| `--wallpaper=<image>`, `--wallpaper-dim=<0..90>` | Screenshot runs with that chat background (copied into the run's own profile) |
| `--shot-scroll=<selector>` | Scroll a rendered element into view before capture |
| `--shot-pet=<png>`, `--pet-skin=<id>`, `--pet-state=idle\|working\|reply\|waiting\|offline` | Pet capture, look and state |
| `--botscreen=<scene>` | Synthetic Bot screen state, with a fixture |
| `--shot-botbar=<png>` | Standalone desktop-control bar capture |
| `--bridge-fake`, `--hermes-view=bots\|sessions` | Fake Hermes host for screenshot runs; not active in normal runs |
| `--workspace-demo=<url>`, `--workspace-agent=<profile>` | Workspace capture isolation mode; no saved relay configuration |

Fixture scenes live in [telegram.json](../app/test/fixtures/telegram.json) and
[agents.json](../app/test/fixtures/agents.json); usage data in [usage.json](../app/test/fixtures/usage.json). The fake
Hermes host is [fake-stream.js](../app/test/fake-stream.js). `--bridge-fake` alone is not a fixture-isolation
guarantee; use a disposable profile or combine it with fixture mode. To rebuild the character pet strips from the
source art, run `python scripts/make-pet-strips.py` from `app/` with Pillow installed.

Optional integration tools are [workspace-e2e.js](../app/scripts/workspace-e2e.js) (Node, real headless browser) and
[botscreen-e2e.js](../app/scripts/botscreen-e2e.js) (Electron, fake driver). Install the relay's dependencies first and
review their setup before running them; unit-test success is not a visual verdict.

## Builds

In `app/`, `npm run dist:win`, `npm run dist:mac` (on macOS) or `npm run dist` builds the targets in
[electron-builder.yml](../app/electron-builder.yml), then writes `app/dist/SHA256SUMS.txt`. Windows targets are NSIS
Setup and an x64 ZIP; macOS targets are DMG and ZIP for arm64 and x64. Builds are unsigned (macOS: ad-hoc signature,
no notarization). The plugin and relay are not part of the desktop installers.

Releases are built and published by CI when a release pull request is merged; see
[CONTRIBUTING.md](../CONTRIBUTING.md#versioning-and-releases). Do not publish installers built on your own machine.

## Local troubleshooting and provisioning

With Deck already running, a second invocation with `--diagnostics` (for example `Hermes Deck.exe --diagnostics`)
writes `diagnostics.json` in that instance's data directory. It includes paths and driver/channel status, not
credentials or chat content. Keep it private anyway.

With the app closed, `--configure=/absolute/setup.json` imports a settings object plus `botscreen` and boolean
`hosting.browser` / `hosting.desktop` choices. The app encrypts imported secrets and refuses to import when secure
storage is unavailable. The file is not deleted automatically: protect it and remove it after use. Normal users should
use the first-start wizard ([README](../README.md#install)).
