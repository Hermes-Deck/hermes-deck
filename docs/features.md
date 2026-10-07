# Features

Every user-visible feature of Hermes Deck: what it is, how it works, what it needs and where its settings are.
Labels in **bold** are the English UI labels; the app is also available in Turkish (**Settings → General →
Language**).

Terms used below:

- **Plugin**: the `hermes-deck` Hermes plugin on the Hermes host ([plugin README](../hermes-plugin/hermes-deck/README.md)).
- **Direct connection**: the app runs the plugin's `stream.py` on the Hermes host over SSH, WSL or a local process
  and talks JSON-RPC over its stdin/stdout. Set up in **Settings → Hermes**.
- **Relay**: the optional Node service on the Hermes host ([relay guide](relay.md)). Set up in **Settings → Relay**.
- **Telegram**: your own Telegram account inside the app (optional).

Settings opens from the gear in the top bar or with **Ctrl+,** (**Cmd+,** on macOS). Its sections are **General**,
**Hermes**, **Relay**, **Telegram**, **Desktop** and **This device**.

## Overview

| Feature | Plugin | Relay | Telegram | Device permission |
|---|---|---|---|---|
| [Sessions](#sessions) | yes | no | no | no |
| [Bots and Bot Chat](#bots-and-bot-chat) | yes | routines only | no | no |
| [Telegram mode](#telegram-mode) | no | for live activity | yes | no |
| [Live activity and controls](#live-activity-and-controls) | yes | for the fleet-wide view | no | no |
| [Attachments, voice and drafts](#attachments-voice-notes-dictation-and-drafts) | yes (Hermes chats) | no | for Telegram chats | microphone for dictation |
| [Model and reasoning pickers](#model-and-reasoning-pickers) | yes (Hermes chats) | no | for Telegram chats | no |
| [Usage, quotas and Fleet](#usage-quotas-and-fleet) | yes | yes | no | no |
| [Notifications and badge](#notifications-and-badge) | depends on the source | depends on the source | depends on the source | OS notifications |
| [Status pet, themes and languages](#status-pet-themes-wallpapers-and-languages) | no | no | no | no |
| [Agent browsers (Workspace)](#agent-browsers-workspace-tab) | no | yes | no | **Agent browser allowed on this device** (only when your computer hosts) |
| [Desktop control (Bot screen)](#desktop-control-bot-screen-tab) | yes | yes | no | **Desktop control** + device key + window grant |
| [Agent spaces](#agent-spaces) | yes | yes | no | for **Work on this device** |
| [Updates](#updates) | no | no | no | no |

## Chat modes

Hermes Deck has three chat modes. Choose any combination and the one shown at startup in the first-start wizard, or
later in **Settings → General → Chat modes**. **Ctrl+Shift+H** switches between enabled modes.

| Mode | Description in the app |
|---|---|
| **Telegram** | Bot chats in your Telegram account. |
| **Sessions** | Sessions over a direct Hermes connection. |
| **Bots** | One bot chat for each Hermes profile. |

Sessions and Bots alone never start a Telegram client.

### Sessions

**What it is.** Your Hermes sessions from every profile in the left rail, with live state, and a full chat view to
read and continue them. **All sessions** opens a searchable list of every stored session of every platform and
profile (Telegram, Discord, WebUI, TUI, CLI, Deck, iOS…), with filters for platform, profile and active/archived, and
actions to open, rename, pin, archive, delete or copy the id, one session or several at once.

**How it works.** The app keeps one direct connection to the Hermes host: `stream.py --follow` runs there over SSH,
WSL or a local process (`app/main/bridge.js`) and relays requests to a private Unix socket opened by the plugin inside
each Hermes process. The host sends snapshots of live sessions, streamed events, approvals and questions; the app
sends only an allow-listed set of methods (for example `session.list`, `session.messages`, `prompt.submit`,
`native.steer`, `session.archive`). Mutations only follow a click and are never replayed after a dropped connection.

A session that a messaging platform owns (for example a Telegram gateway chat) opens read-only; sending from Deck
continues it in a copy (`session.branch_stored`), so Deck never writes into a chat a gateway is serving.

**Take over.** When a session is running in another Hermes interface, the composer shows **Running on another
device · Take over**. Take over moves the live session to Deck explicitly (or resumes it in a new runtime, shown as
**Conversation resumed in a new runtime**). Deck never takes a session over on its own.

**Needs.** The plugin on the Hermes host and **Settings → Hermes**: **Connection type** (**Off**, **SSH (another
machine)**, **WSL (this computer)** on Windows or **Local (this computer)** on macOS/Linux), **SSH target**,
**Python path**, **stream.py path**, optionally **WSL distribution**; then **Save and connect** and **Test
connection**. No relay, no Telegram.

**Limits.** SSH runs non-interactively (`BatchMode=yes`): set up key login and accept the host key outside Deck first.
Keep ports and other options in `~/.ssh/config`. A host with an older plugin lists only the newest 200 sessions per
profile.

### Bots and Bot Chat

**What it is.** One row per Hermes profile with its face, name, state and a badge when it waits for you. A click opens
the profile's single **Bot Chat**, a hidden session with that exact title; the bot's other sessions stay one fold
away. A bot's card in the right panel lists its **Routines** (the profile's cron jobs, read-only).

**How it works.** Everything comes over the direct connection: `profiles.list` (names, faces, the Bot Chat
reference), `profiles.get_asset` (avatar), `session.list` (exact-title lookup) and `session.create` + `session.title`
when you send the first message to a bot that has no Bot Chat yet. Routines come from the relay's fleet snapshot.

**Needs.** Plugin and direct connection. Routines need the relay.

### Telegram mode

**What it is.** Your Telegram bot DMs and, optionally, the topics of one forum group, inside Deck: read, send (with
replies), files, reactions, inline buttons, forum topic management (create, rename, close, pin, delete, when your
account may), read receipts and **Open in Telegram** for content Deck cannot draw.

**How it works.** The app signs in with your own account over MTProto (`teleproto`) in the main process. The login
asks for your phone number, the code and, if set, the two-step password. Traffic goes from Deck straight to Telegram;
the relay never sees it. Sessions are linked to chats with `relay/agents.json`: a bot DM belongs to the profile whose
`bot` matches the bot's username, a topic to sessions running in that group and thread.

**Needs.** Your own API keys from [my.telegram.org](https://my.telegram.org/apps). Live activity next to the chats
needs the relay. No bot token is needed by the app.

**Settings.** **Settings → Telegram**: **API keys**; **Chats** (**Group whose topics to show**, **Bots to hide**);
**Send read receipts to Telegram** (on by default; when off, unread counts are tracked locally); **Account** →
**Log out of Telegram** (deletes the session on this computer and on Telegram).

**Limits.** Bot DMs come from your first 300 dialogs. Media downloads are capped at 25 MB; bigger files open in
Telegram. Known executable and script types are saved but never opened directly.

## Live activity and controls

**What it is.**

- In a Hermes chat, one live row at the end of the transcript says what the agent is doing (**Thinking…**,
  **Running <tool>**, **Writing…**, **Waiting for approval**, **Waiting for your answer**) with the elapsed time and a
  **Show thinking** disclosure that streams the model's reasoning when Hermes sends it.
- While a turn runs, Enter either queues your message (sent when the turn ends; **Edit**, **Cancel** and **Send
  now** on the pending bubble) or steers it into the running turn. Pick the default in **Settings → General → When
  the agent is busy, Enter…** (**Queues** / **Steers**); Ctrl/Cmd+Enter does the other one once. **Interrupt and
  send** drops the current task and follows your message; **Stop** stops the running turn.
- Approvals and questions from the agent appear in the chat and are answered there.
- The right panel's **Activity** tab shows one tree of sessions and their sub-agents (status, title, model and
  reasoning level, elapsed time, cost so far), with per-row controls and drill-down into a session, its tool calls
  and its sub-agent tree.

**How it works.** For chats on the direct connection, the plugin streams the turn's events and the app shows them.
For the fleet-wide view (every agent on the host, including turns started in Telegram, the TUI or cron), the plugin
appends one JSON line per turn, tool call, API call and sub-agent to `~/.hermes-deck/events/<profile>.ndjson`; the
relay tails those files, keeps a session model and pushes changes to the app over its WebSocket. Opening a session's
tool calls or messages reads them from the relay (`/session/...`), which reads Hermes' `state.db` read-only.
Watching costs no model tokens: nothing asks an agent for its status.

**Needs.** The plugin. The live row and controls in a Hermes chat need the direct connection; the **Activity** tree
across all agents needs the relay. Steering needs a turn the plugin controls and a message without files; otherwise
the message is queued.

## Attachments, voice notes, dictation and drafts

- **Attachments.** **Attach file**, drag and drop, or paste. Files are staged in a tray above the composer; images
  get a preview. Hermes chats send the whole tray with the message; Telegram uploads files one by one (photos as
  compressed photos unless sent as files). The renderer never sees file paths; the main process holds them.
  *Limits (Hermes):* 10 files, 25 MB each, 50 MB per message, enforced by both app and plugin.
- **Window capture.** **Attach window capture** adds an image and the text of your frontmost window to the tray
  (Windows and macOS; also **Ctrl+Alt+P** / **⌃⌥P**). Deck hides briefly while capturing; nothing is sent
  automatically. Deck's own window and password managers are refused. On macOS this uses the verified cua-driver
  (see [Desktop control](#desktop-control-bot-screen-tab)).
- **Files from the agent.** When an agent offers a file in a Hermes chat, it appears as a chip with **Download**;
  after download, **Open** and **Show in folder**. Files go to **Settings → General → Downloads → Download folder**
  (default `Downloads/Hermes Deck`), or ask each time with **Ask where to save each time**. Limit 200 MB per file.
  Images you or the agent sent show as thumbnails with a lightbox.
- **Voice notes.** Audio attachments (Hermes files and Telegram voice notes) play inline with a waveform scrubber and
  1x/1.5x/2x speed.
- **Dictation.** The microphone button (**Ctrl+Shift+M**) records from this computer's microphone; pressing it again
  sends the clip to the Hermes host, where Hermes' own speech-to-text (its `stt:` configuration) transcribes it into
  the message box. Nothing is sent until you press **Send**. Esc discards the recording; a recording stops after
  120 s. Needs the direct connection and microphone permission.
- **Drafts.** Each chat keeps its own draft (text and staged files) when you switch chats. Drafts stay on this
  computer.

## Model and reasoning pickers

Two chips left of **Send** change the **Model** (search, provider groups, **Custom model id**) and the reasoning
effort for the current session only. In Hermes chats they use session-scoped `config.set` over the direct
connection (never the global config); in Telegram chats they send the bot's native chat commands. A change applies
from your next message.

## Usage, quotas and Fleet

**What it is.**

- The **Token** tab: tokens, cost, calls and cache hit over **24h**, **7d**, **14d**, **30d** or **All**, with a chart
  of fresh versus cached tokens and breakdowns by **Agents** and **Models**.
- The **Fleet** tab: **Quotas** (Claude and Codex subscription windows: session and weekly limits with reset times,
  and a **Refresh** button), today's usage across all agents, and **Gateways** (each profile's gateway and platform
  health, plus cron job summaries).

**How it works.** The relay reads Hermes' own `state.db` of every profile through short-lived private read-only
copies, every 60 seconds, so totals count every session no matter which Hermes interface ran it. Gateway health and
quota windows come from snapshots the plugin's gateway process writes to `~/.hermes-deck/state/<profile>.json` every
30 seconds; the plugin fetches quotas in a background worker (about every 5 minutes) so hooks never wait for the
network. On macOS, the relay can also read quota windows from the CodexBar CLI. Details and the accounting rules:
[host-usage.md](host-usage.md).

**Needs.** Relay (Node.js 22.13+) and the plugin. Quotas appear only for providers configured in a profile whose
gateway runs the plugin.

**Limits.** Costs are Hermes' recorded or estimated values; missing costs show as unknown, never as free. Costs of a
Claude subscription are shown as **API list-price equivalent**, not as an invoice.

## Notifications and badge

**What it is.** OS notifications while the Deck window is in the background: new chat messages (one toast per chat,
grouped), finished top-level agent sessions, approvals and questions that wait for you (these stay until dismissed),
and update notices. A synthesized chime plays when **Sound** is on. The taskbar (Windows) or dock icon shows how many
chats wait for you.

**Settings.** **Settings → Desktop**: **Notifications** (with **Test notification**), **Sound**, **Badge on the
taskbar icon**. On Windows, notifications need the Start menu shortcut that the installer adds (source runs: `npm run
shortcuts` in `app/`).

**Needs.** Telegram messages need Telegram mode; finished sessions need the relay; approvals and questions need the
direct connection.

## Status pet, themes, wallpapers and languages

- **Status pet.** A small always-on-top companion window that shows whether agents are idle, working, waiting for you
  or offline, with a speech bubble for new replies and questions. **Settings → Desktop → Status pet**: **Pet look**
  (Character, Owl, Philosopher, Leo, Hasret, Hayat, Orb, Agent), **Pet size** (Small to Extra large) and **Pet
  animations** (stills when off or when the system asks for reduced motion).
- **Themes.** **Settings → Desktop → Appearance → Theme**: **Basalt (dark)**, **Marble (light)**, **Aegean (navy)** or
  **Match the system**.
- **Chat backgrounds.** One background picture per chat mode, built in or your own (**Choose image…**), with
  **Background dimming**. Your picture is copied into Deck's profile.
- **Window.** **Keep running in tray on close** and **Start at login** (macOS: installed app only).
- **Languages.** English (default) and Turkish: **Settings → General → Language**, or in the first-start wizard.

All of these are local to the app; nothing is sent anywhere.

## Agent browsers (Workspace tab)

**What it is.** The **Workspace** tab shows the browser a Hermes agent is using, live, next to the chat. You can watch
the agent's latest steps, **Take control** to click and type yourself (the agent can still read the page but not
click, type or navigate), then **Hand to agent** to give it back. A host picker chooses where the browser runs:
**Automatic**, **This computer**, or the agent host by name.

**How it works.** Each Hermes profile points its browser tool at the relay's loopback CDP endpoint
(`browser.cdp_url: http://127.0.0.1:9333/agent/<profile>`). The relay routes it to one of:

- **The agent host** (default for **Automatic**): a headless browser per agent on the relay host
  (`DECK_FALLBACK_BROWSER=1`), or one already running browser attached over its loopback debugging port
  (`DECK_FALLBACK_BROWSER_CDP`).
- **Your computer**: the relay tunnels CDP over Deck's own outbound relay connection to a separate Chrome, Chromium
  or Edge that Deck starts with its own profile per agent. Your computer opens no inbound port. Deck filters every CDP
  message on the device: no `file://` or other non-web URLs, no file choosers, extensions or permission grants,
  downloads only into the agent's own folder, and no input or navigation while you hold control.

The live view is a CDP screencast. **Transfer browser** (or `/handoff <device>` in the composer) moves an agent's
open tabs, cookies and storage to another device after you approve it on the source device; the relay only sees
encrypted data. Automatic transfer on sleep or after 30 seconds without a heartbeat is a separate opt-in.

**Needs.** Relay, the profile's `browser.cdp_url`, and either a browser on the agent host or, for your computer,
**Settings → This device → Agent browser allowed on this device** (off by default) plus Chrome, Chromium or Edge.
Transfers need a device key in **This device** on both devices. Setup: [relay guide](relay.md#agent-browsers).

**Limits.** **Take control** blocks the agent's input and navigation but not page scripts, and is not isolation from
an agent that has shell access on the host. A browser nobody used or watched for 15 minutes is closed. Pages and
screenshots reach the agent's model provider like any browser use.

## Desktop control (Bot screen tab)

**What it is.** A Hermes agent using `computer_use` can work in **one window you hand over** on your Windows or macOS
computer. The **Bot screen** tab shows the frames the agent saw with its clicks marked, and an action log. **Hand to
agent** opens a consent sheet where you choose the window; **Take control** pauses the agent; **Return control**
hands it back; **Stop** (in the tab, the always-on-top bar, the tray, or **Ctrl+Alt+Shift+S** / **⌃⌥⌘S**) ends the
grant at once, even when the relay or Hermes is offline.

**How it works.** The profile runs the relay's `deck-cua` wrapper instead of `cua-driver`. The wrapper asks the relay
for a route; the relay carries the session over Deck's relay connection to a pinned, verified cua-driver that Deck
runs in bounded mode, limited to the granted app. Three fences check every call: the plugin (only the granted
window), the relay (an allow-list of driver tools pinned to the granted pid and window) and Deck itself. Background
input is the default; **Foreground control for this session** is a separate opt-in in the consent sheet. Protocol
and fences: [bot-screen-protocol.md](bot-screen-protocol.md).

**Needs.** Relay, plugin, a device key issued on the relay host (`node tools/device-token.js add <name>`),
the profile setting `HERMES_CUA_DRIVER_CMD`, and on your computer **Settings → This device**: **Device key**,
**Driver (cua-driver)** (**Download and install**, verified by size, SHA-256 and publisher signature), **Desktop
control** and **Agents allowed to use this computer**. On macOS, grant CuaDriver Accessibility and Screen Recording
(**Open macOS permissions**). Setup: [relay guide](relay.md#desktop-control).

**Limits.** A grant lasts at most 2 hours and ends after 30 minutes idle, on lock, sleep or quit. Deck's own window and
password managers cannot be handed over. Everything visible in the granted window can reach the agent's model
provider as screenshots. The **Bot screen** tab is shown while desktop control is on or paused, or when the relay
has an agent space.

## Agent spaces

**What it is.** Instead of your desktop, agents use `computer_use` on their own desktop, a **space**. The current
version has one shared space: the agent host's logged-in macOS desktop, used by one agent at a time while others wait
in line. The **Bot screen** tab shows it live, with control levels **Watch**, **Together** (you get your own cursor,
the agent continues) and **Full control** (agents wait). **Work on this device** moves an agent to your computer
(with desktop control); **Send back to its space** returns it.

**How it works.** cua-spacesd (from the Cua project) runs on the agent host on loopback and streams the desktop. The
relay gates each `computer_use` call with a lock and queue, and proxies the viewer to Deck with its own token; Deck
shows the viewer in an isolated view.

**Needs.** A macOS agent host, relay with `DECK_SPACES=shared`, and cua-spacesd installed with
`relay/tools/install-spacesd.sh`. **Settings → This device → Agent spaces** shows the mode and **Default control**.
Setup and behaviour: [agent-spaces.md](agent-spaces.md). Experimental: one desktop per agent
(`DECK_SPACES=agent`) is not implemented yet and shows as **Coming in phase 2**.

## Updates

**What it is.** The app checks for a newer release at start and every 6 hours (**Settings → General → Updates →
Check for updates automatically**, **Check now**). On Windows, **Install the new release** downloads the installer,
verifies it against the release's `SHA256SUMS.txt` (a release without it is refused) and runs it; Deck then restarts
on the new version. On macOS, install the new DMG from the release page (**Open the release page**). The relay's version is
also compared with the app's: a newer relay announces a newer app; an older relay or plugin shows the command to
update it on the host.

**Needs.** Network access to GitHub. The host side (relay and plugin) is updated on the host:
[updating.md](updating.md).

**Developer option.** **Advanced → Offer builds from unreleased source (developers)** (off by default) lets a computer
with git and npm build `main` and install that build. **Repository**, **Branch** and **GitHub token** (only for a
private fork) are under **Advanced** too.
