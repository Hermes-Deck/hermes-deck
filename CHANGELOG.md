# Changelog

All notable user-visible changes to Hermes Deck are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).
The desktop app, relay and Hermes plugin share one version number.

## [Unreleased]

- Every saved host is live at once: each keeps its relay and direct connection open while the Deck runs, so replies, finished turns, approvals and questions from any host raise their notification and open that host's chat when clicked. Every host you open keeps its page warm in the background: switching back is instant with scroll, open chat and draft intact, nothing reloads.
- Split view: two hosts side by side, each a full Deck with its own top bar. Picking the host the other pane shows swaps the panes; the divider drags (360 px minimum per pane); split on/off, the right host and the divider position survive a restart. This device's hosting switches follow the left pane's host and change only from there.
- The top bar's host dropdown and its "Relay: … · Sessions: …" line are replaced by numbered monitor-style buttons (1, 2, …) centred on the bar. The shown host is filled, each number has a connection dot (green all connected, amber connecting or one part down, red disconnected, grey unobserved) and a tooltip with the host name and its Relay and Sessions state. Arrow keys move between the numbers and Ctrl/Cmd+1…9 selects a host. The switcher is hidden with a single host. A host switch no longer waits for a page reload.

- A **Split view** button next to the host numbers shows two hosts side by side (when the app supports it); each pane has its own numbers, and the Windows caption-button space is reserved only in the right or full pane.

- A finished turn notifies once (one sound): the relay and the direct connection both report it, and the second report of the same session moments later no longer raises a second notification.

- Markdown tables in chats fit the message column and wrap their cell text instead of growing past it; a table only scrolls sideways when something in it cannot break (a long URL or code token).

- The top bar's host numbers sit in the bar's own flow between the breadcrumb and the right-hand controls (fleet capsule, search, Work, settings): centred while there is room, shifted left instead of overlapping when the right-hand group needs more space.

- The chat title is no longer repeated in the top bar's breadcrumb; the chat header below shows it.
- Hermes chats show one tool receipt per message you sent, after the work it started. A session watched from here (a sub-agent, a TUI or Telegram run) no longer piles a row of "1 tools" receipts under its work.
- Tool counts read "1 tool" / "2 tools" in receipts, the sub-agent views and the session statistics.
- The live row no longer says "Running terminal · done" for a step that already finished; it says Thinking…. When this Deck receives no live reasoning for a session (it runs elsewhere), Show thinking says so instead of promising reasoning that will not come, and a turn whose model streamed no reasoning says so after its first step.
- Opening a session that is working elsewhere on the host's gateway (a sub-agent, or a run started from another Deck, the phone or Hermes Desktop) now streams its tool calls and, with Show thinking open, its reasoning live, also after a reconnect or gateway restart; the Deck only watches (it never sends, stops or takes the session over) and lets go when you open another chat or the turn ends. Show thinking is one switch per Hermes session, so a TUI or Hermes Desktop on the same session also shows reasoning while you watch with it open. Telegram turns and a TUI in its own process still show the snapshot only. A turn's call count in Work › Run reads "1 call".
- Approvals and questions reach every Deck connected to a host as they are asked, including those of a session started from another Deck or before you switched hosts, so an inactive host notifies you and the card can be answered there. A card answered or expired anywhere leaves every Deck. Needs the updated Hermes plugin and a gateway restart.
- When the agent asks for a sudo password, a secret value, a password manager's master password, a login to save for a site (username plus password) or a one-time code, a masked card now appears in the chat's request tray, like an approval: Enter sends, Esc or Cancel declines, Show reveals the field. What you type goes to Hermes once and is cleared from the card at once; notifications only say that a password or code is needed and for which site. Before, the Deck ignored these prompts, so the agent waited out its deadline and reported the login as declined. On every Deck connected to the host (not only the one that started the session) these cards need the updated Hermes plugin (reinstall it) and a gateway restart. The phone does not show them.
## [1.1.0] - 2026-11-05

- Switching hosts cancels pending browser-transfer approvals and file downloads. Late image and audio responses from the previous host are discarded.

- Update compatible dependencies to include Electron certificate validation fixes and corrected HTTP-client, URI and IP-address handling.

- Agent activity now appears in a collapsed status card above the composer for direct and Telegram/relay chats. Expand for observed steps, model, reasoning, Work and guarded Stop. Hide the entire card and restore it from the message toolbar; the choice persists per host without hiding approvals or questions.

- The host selector and separate Relay/Sessions states form a compact centered header group. Narrow layouts keep all header actions reachable on a second row, while connection warnings retain explicit text.

- macOS app switching now uses the same main-window restore path as Dock and pet clicks, returning to the main window's fullscreen Space instead of leaving only the pet visible. Hidden and minimized main windows also reopen.

- Source updates use a fresh clone per attempt, leaving old caches and linked checkouts untouched. Source Test builds no longer offer potentially older Test packages. macOS rechecks the source target after staging and removes stale candidates before the swap.

- Test updates now list `test/desktop-fixes` commits without a published release. An explicit source-build opt-in and exact-SHA confirmation reuse the isolated build/install route; stale targets and incomplete or divergent comparisons cannot build. Source Test metadata preserves the return to Stable.

- Needs you can review/edit Draft Cards email drafts, compare actual versions and request revision. Matching Draft Cards + Gmail source extensions add verified primary-account review and a separate exact-version, single-use send confirmation with persistent receipts. Old or disabled plugins stay review-only; no plugin is installed or enabled automatically.

- The top bar now has a keyboard-friendly host selector with separate Relay and Sessions status. Host setup accepts Local, SSH or WSL direct connections, or an explicitly relay-only host; saved configuration is not labelled connected.
- Desktop notification display offers Auto, Pet and Native banner without changing pet visibility. Auto uses native banners over another fullscreen macOS app, or when fullscreen state is unknown.
- Notifications follow the conversation actually displayed, not a hidden selection in another mode or behind Settings, Usage or a workspace pane. Notification clicks return to their source conversation.
- Secret-free preference changes no longer query the macOS Keychain. Inactive-host secrets remain encrypted, and unreadable ciphertext survives unrelated saves.

- Relay: `DECK_RELAY_HOST` accepts several comma-separated addresses, for example loopback plus a home LAN address. Only the first must bind; the others are skipped while the machine does not have them and retried every 30 seconds.
- Usage shows spend allowances next to the quota windows: Claude extra usage (used / limit in dollars, monthly) and Codex workspace credits and balance. An account that reports only a spend allowance is no longer shown as having no quota windows. Quota providers are found again on Hermes builds that ship only `ruamel.yaml`. Needs the updated Hermes plugin.
- Group Chat in the Bots view: rooms of 2 to 6 bots hosted by the Hermes gateway (the same rooms Hermes Desktop
  shows, running while Deck is closed). **Group chats** rows with the latest message, unread and needs-you badges;
  **New group chat** (name and bots); one transcript with each speaker's face and name; `@` suggestions for the
  members and `@all`; one "… is thinking" line and Stop; command approvals as cards in the room; rename and disband.
  Needs the updated Hermes plugin (it now passes the gateway's `groups.*` calls) and a gateway restart after
  installing it; older gateways simply show no Group Chat.
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
