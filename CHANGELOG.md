# Changelog

All notable user-visible changes to Hermes Deck are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).
The desktop app, relay and Hermes plugin share one version number.

## [Unreleased]

## [1.0.0] - 2026-10-15

First release. Every feature is described in [docs/features.md](docs/features.md).

### Added

- Desktop app for Windows and macOS: chat with Hermes agents in one window (sidebar with session sources, top bar,
  transcript, composer, Work pane), OLED dark by default, English and Turkish UI.
- Connections to Hermes directly (SSH, WSL or a local process running the plugin's `stream.py`) or through the relay.
- Sessions browser with pinned sources, Bot Chat, and Telegram mode with your own account.
- Live activity: streamed reasoning, each thought with the tool calls it made, turn receipts with readable durations,
  Stop, queued messages with Send now (steer) and Cancel, approvals and questions in the Inbox.
- Work pane: Session, Run (tool calls inline with arguments, output and per-file diffs), Plan, Files and Sub-agents
  (running first, then newest first; tail, steer and interrupt).
- Composer with `@` name and `/` command suggestions, attachments, voice notes, dictation and drafts.
- Model and reasoning pickers; Usage with provider quotas, model-family limits and per-profile accounts; Fleet panel.
- Agent spaces: a desktop per agent with an activity log, risky-command approval and undo points; agent browsers and
  desktop control.
- Notifications with a sound per event (built-in or your own file), status pets, themes, wallpapers and reading
  preferences.
- Settings: edit the Hermes config, restart the gateway or relay, and update the host from the app.
- Relay: mobile API for the phone app, large attachments (disk spool, streaming uploads up to 2 GB per file) and
  resumable downloads, host updater with idle gateway restarts and no-downgrade checks.
- Desktop updates from GitHub releases with checksum verification.
