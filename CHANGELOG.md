# Changelog

All notable user-visible changes to Hermes Deck are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).
The desktop app, relay and Hermes plugin share one version number.

## [Unreleased]

- macOS app switching now uses the same main-window restore path as Dock and pet clicks, returning to the main window's fullscreen Space instead of leaving only the pet visible. Hidden and minimized main windows also reopen.

- Source updates use a fresh clone per attempt, leaving old caches and linked checkouts untouched. Source Test builds no longer offer potentially older Test packages. macOS rechecks the source target after staging and removes stale candidates before the swap.

- Test updates now list `test/desktop-fixes` commits without a published release. An explicit source-build opt-in and exact-SHA confirmation reuse the isolated build/install route; stale targets and incomplete or divergent comparisons cannot build. Source Test metadata preserves the return to Stable.

- Needs you can review/edit Draft Cards email drafts, compare actual versions and request revision. Matching Draft Cards + Gmail source extensions add verified primary-account review and a separate exact-version, single-use send confirmation with persistent receipts. Old or disabled plugins stay review-only; no plugin is installed or enabled automatically.

- The top bar now has a keyboard-friendly host selector with separate Relay and Sessions status. Host setup accepts Local, SSH or WSL direct connections, or an explicitly relay-only host; saved configuration is not labelled connected.
- Desktop notification display offers Auto, Pet and Native banner without changing pet visibility. Auto uses native banners over another fullscreen macOS app, or when fullscreen state is unknown.
- Notifications follow the conversation actually displayed, not a hidden selection in another mode or behind Settings, Usage or a workspace pane. Notification clicks return to their source conversation.
- Secret-free preference changes no longer query the macOS Keychain. Inactive-host secrets remain encrypted, and unreadable ciphertext survives unrelated saves.

- Status pet has a persistent **Always on top** checkbox. It changes only the pet window, immediately and without taking focus.
- Session filter counts use the same saved source choices, source chip and profile as the session list. Running and Waiting no longer advertise sessions hidden by those filters.

- Updates offers Stable (main) and Test channels for the desktop app. Published test packages use the same checksum verification as stable releases. Channel selection never installs anything; installation confirms the exact target, including returning to an older stable build. Isolated Windows copies cannot overwrite the normal installation.

- Agents and New session use the connected host's profile catalog, including profiles with no recent sessions. Inactive profiles no longer imply a live agent.

- Pin and rename requests use the native session owner when available, retain the native store policy on older engines, and report interrupted updates without automatic retries. Native restrictions on legacy cron sessions still apply.

- Direct connections restore still-open native approval and question cards after reconnecting, without resuming sessions or replaying answers. Restored cards also disappear when their requests end on another transport.
- Needs you counts in the sidebar and fleet header include inactive hosts' approvals and questions and refresh when requests change. Empty session sidebars and collapsed agent groups no longer show literal `null` text.
- Settings keep a list of Hermes hosts. The existing connection becomes the first host; a copy of the old settings file is kept as `settings.json.pre-hosts`.
- Switching hosts reloads the window for the new host. A late reply for the old host is refused, desktop-control pairing stays with its host, and device hosting (agent browsers, desktop control, agent desktops) turns off.
- The inbox shows approvals and questions from every saved host with a direct connection. Each card names its host, answers only to that host, and goes inert while that host is not connected.
- The Hermes plugin adds the owning profile to approval and question requests, so the Deck can answer a request whose chat it has not opened. Update the plugin on every host.
- A downgrade to a Deck without multi-host keeps only the active host; the other saved hosts must be added again.

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
