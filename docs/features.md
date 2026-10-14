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

## Layout and shortcuts

The window has a **sidebar** (resizable; hide it with the button in its header or **Ctrl/Cmd+B**), a **top bar**,
and a main area that shows the chat or the [inbox](#inbox-and-fleet). The right slot holds the **Work pane**; the
**Usage** view opens over the chat like Settings.

- **Sidebar.** The mode switch (**Telegram | Sessions | Bots**, enabled modes only), then in Sessions mode the
  filters **Needs you** (opens the inbox), **All**, **Running**, **Waiting**, **Today** and **Pinned**, the **Agents**
  list (a click narrows the list to that profile), source chips, **All sessions** and the sessions by profile. The
  footer shows the connections, the fleet summary and the busiest quota window.
- **Top bar.** Breadcrumb (agent / title, with the parent for a sub-agent) and a channel chip (**Hermes**,
  **Telegram**, **<Source> · read-only**, **Bot Chat**, **Sub-agent**), the fleet capsule, search, and the Work pane
  and Settings buttons.
- **Work pane.** **Session** (the chat's facts and figures with **Steer**, **Stop** and **Model**, then what runs in
  other agents), **Run**, **Plan**, **Diff**, **Sub-agents**, **Browser** and **Screen** (see [Work pane](#work-pane)).
- **Usage.** Fleet panel › **Usage details** (see [Usage, quotas and Fleet](#usage-quotas-and-fleet)).

| Shortcut (Cmd on macOS) | Action |
|---|---|
| **Ctrl+K** | Search: the All sessions browser (Hermes modes) |
| **Ctrl+Shift+K** | Model picker |
| **Ctrl+E** | Cycle the reasoning effort |
| **Ctrl+\\** | Work pane |
| **Ctrl+Alt+I** | Work pane › Session |
| **Ctrl+J** | Fleet panel |
| **Ctrl+B** | Hide or show the sidebar |
| **Ctrl+Shift+H** | Next chat mode |
| **Ctrl+,** | Settings |
| **Ctrl+Shift+M** | Dictation |

## Overview

| Feature | Plugin | Relay | Telegram | Device permission |
|---|---|---|---|---|
| [Sessions](#sessions) | yes | no | no | no |
| [Bots and Bot Chat](#bots-and-bot-chat) | yes | routines only | no | no |
| [Telegram mode](#telegram-mode) | no | for live activity | yes | no |
| [Live activity and controls](#live-activity-and-controls) | yes | for the fleet-wide view | no | no |
| [Work pane](#work-pane) | yes | for stored plans and relay tool calls | no | no |
| [Inbox and fleet](#inbox-and-fleet) | yes (approvals, questions) | for the fleet, costs and finished sessions | no | no |
| [Attachments, voice and drafts](#attachments-voice-notes-dictation-and-drafts) | yes (Hermes chats) | no | for Telegram chats | microphone for dictation |
| [Model and reasoning pickers](#model-and-reasoning-pickers) | yes (Hermes chats) | no | for Telegram chats | no |
| [Usage, quotas and Fleet](#usage-quotas-and-fleet) | yes | yes | no | no |
| [Notifications and badge](#notifications-and-badge) | depends on the source | depends on the source | depends on the source | OS notifications |
| [Status pet, themes and languages](#status-pet-themes-wallpapers-and-languages) | no | no | no | no |
| [Agent browsers (Browser tab)](#agent-browsers-browser-tab) | no | yes | no | **Agent browser allowed on this device** (only when your computer hosts) |
| [Desktop control (Screen tab)](#desktop-control-screen-tab) | yes | yes | no | **Desktop control** + device key + window grant |
| [Agent spaces](#agent-spaces) | yes | yes | no | **Host agent desktops on this device** (only when your computer hosts), and desktop control for **Work on this device** |
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
away. A bot's card lists its **Routines** (the profile's cron jobs, read-only).

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

**Settings.** **Settings → Telegram**: **API keys**; **Chats** (**Group whose topics to show**); **Hidden bots**;
**Send read receipts to Telegram** (on by default; when off, unread counts are tracked locally); **Account** →
**Log out of Telegram** (deletes the session on this computer and on Telegram).

**Hiding a bot.** Every bot you have a DM with shows in the Agents list, including bots that are not Hermes agents.
Right-click such a bot (or press the menu key, or Shift+F10) and choose **Hide from list**. **Settings → Telegram →
Hidden bots** lists the hidden ones, each with **Show** to bring it back, and takes a username to hide by hand
(`@` optional, up to 50). Hermes agents cannot be hidden this way.

**Limits.** Bot DMs come from your first 300 dialogs. Media downloads are capped at 25 MB; bigger files open in
Telegram. Known executable and script types are saved but never opened directly.

## Live activity and controls

**What it is.**

- In a Hermes chat, one live row at the end of the transcript says what the agent is doing (**Thinking…**,
  **Running <tool>**, **Writing…**, **Waiting for approval**, **Waiting for your answer**) with the elapsed time and a
  **Show thinking** disclosure that streams the reasoning of the step under way when Hermes sends it (finished steps
  are already in the transcript above).
- While a turn runs, Enter either queues your message (sent when the turn ends; **Edit**, **Cancel** and **Send
  now** on the pending bubble) or steers it into the running turn. Pick the default in **Settings → General → When
  the agent is busy, Enter…** (**Queues** / **Steers**); Ctrl/Cmd+Enter does the other one once. **Interrupt and
  send** drops the current task and follows your message; **Stop** stops the running turn.
- Agent prose is set in a reading serif; reasoning folds say how long the agent thought. A turn's work reads in
  order: each thought is followed by the tool calls it made (tool name and main argument). After the work, a folded
  receipt sums the turn up (**Worked Ns · N tools**) and lists each call's output; clicking a call in the transcript
  opens it there and in Work › **Run**, expanded on its row. A scrubber on the chat's left edge jumps between
  turns.
- Approvals and questions from the agent appear in the composer tray and are answered there (or in the
  [inbox](#inbox-and-fleet)).
- Work › **Session** ends with what is running in other agents right now (status, title, model and
  reasoning level, elapsed time, cost so far). A session's own sub-agents are in Work › **Sub-agents**.

**How it works.** For chats on the direct connection, the plugin streams the turn's events and the app shows them.
For the fleet-wide view (every agent on the host, including turns started in Telegram, the TUI or cron), the plugin
appends one JSON line per turn, tool call, API call and sub-agent to `~/.hermes-deck/events/<profile>.ndjson`; the
relay tails those files, keeps a session model and pushes changes to the app over its WebSocket. Opening a session's
tool calls or messages reads them from the relay (`/session/...`), which reads Hermes' `state.db` read-only.
When an agent keeps a task list (`todo_list` or OMH's `omh_todo`), the plugin also records its latest plan. For a
stored session the plan is rebuilt read-only from that session's newest task-list result. On the direct connection
the app can also list a session's live sub-agents with their goal, model, reasoning level, elapsed time, tokens, cost
and recent tool calls, read one sub-agent's live output, and steer or stop that one sub-agent with a click.
Watching costs no model tokens: nothing asks an agent for its status.

**Needs.** The plugin. The live row and controls in a Hermes chat need the direct connection; the list of what runs
in other agents needs the relay. Steering needs a turn the plugin controls and a message without files; otherwise
the message is queued.

## Attachments, voice notes, dictation and drafts

- **Attachments.** **Attach file**, drag and drop, or paste. Files are staged in a tray above the composer; images
  get a preview. Hermes chats send the whole tray with the message; Telegram uploads files one by one (photos as
  compressed photos unless sent as files). The renderer never sees file paths; the main process holds them.
  *Limits (Hermes):* 10 files, 2 GB each and 4 GB per message when the relay and the Hermes plugin on that host share
  the upload spool (files are streamed to the relay with progress and Cancel; see
  [Large attachments](relay.md#large-attachments)); otherwise 25 MB each and 50 MB per message. App and plugin both
  enforce them.
- **Window capture.** **Attach window capture** adds an image and the text of your frontmost window to the tray
  (Windows and macOS; also **Ctrl+Alt+P** / **⌃⌥P**). Deck hides briefly while capturing; nothing is sent
  automatically. Deck's own window and password managers are refused. On macOS this uses the verified cua-driver
  (see [Desktop control](#desktop-control-screen-tab)).
- **Files from the agent.** When an agent offers a file in a Hermes chat, it appears as a chip with **Download**;
  after download, **Open** and **Show in folder**. Files go to **Settings → General → Downloads → Download folder**
  (default `Downloads/Hermes Deck`), or ask each time with **Ask where to save each time**. Limit 8 GB per file when
  the relay and the Hermes plugin on that host share the spool (the file streams from the relay and a dropped download
  resumes where it stopped; see [Large downloads](relay.md#large-downloads)); otherwise 200 MB per file.
  Images you or the agent sent show as thumbnails with a lightbox.
- **Voice notes.** Audio attachments (Hermes files and Telegram voice notes) play inline with a waveform scrubber and
  1x/1.5x/2x speed.
- **Dictation.** The microphone button (**Ctrl+Shift+M**) records from this computer's microphone; pressing it again
  sends the clip to the Hermes host, where Hermes' own speech-to-text (its `stt:` configuration) transcribes it into
  the message box. Nothing is sent until you press **Send**. Esc discards the recording; a recording stops after
  120 s. Needs the direct connection and microphone permission.
- **Drafts.** Each chat keeps its own draft (text and staged files) when you switch chats. Drafts stay on this
  computer.
- **`@` and `/` suggestions.** Type `@` to pick a name to tag, or `/` at the start of the box to pick a command.
  **↑/↓** move, **Tab** or **Enter** inserts, **Esc** closes; **Enter** on a command typed out in full sends it.
  In a Telegram chat, `@` lists the agents' and bots' usernames and, in a topic, the group members the Deck has
  seen who have a public username; `/` lists the commands the chat's bot registered with Telegram (in a topic,
  every bot's, as `/command@bot`). In a Hermes session, `@` lists the profile names and `/` lists Hermes' own
  commands, quick commands, plugin commands and skills for that profile (needs the host plugin from this version;
  an older one shows no commands).

## Model and reasoning pickers

One **model · effort** token left of **Send** (**Ctrl/Cmd+Shift+K**) opens a popover to change the **Model** (search,
provider groups, **Custom model id**) and the reasoning effort for the current session only; **Ctrl/Cmd+E** cycles
the effort. In Hermes chats they use session-scoped `config.set` over the direct
connection (never the global config); in Telegram chats they send the bot's native chat commands. A change applies
from your next message.

## Usage, quotas and Fleet

**What it is.** The **Usage** view, opened from the fleet panel's **Usage details** row (or **Ctrl/Cmd+J** when the
fleet panel is unavailable). It covers the chat column like Settings; **Back** or **Esc** returns to the chat:

- **Quotas** (Claude and Codex subscription windows: session and weekly limits with reset times, brass above 60%,
  and a **Refresh** button), today's usage across all agents, and **Gateways** (each profile's gateway and platform
  health, plus cron job summaries). A limit that caps only one model family gets its own row named after the model,
  for example **Fable** on a Claude Max plan that includes it; accounts without such a limit show no extra row.
- Tokens, cost, calls and cache hit over **24h**, **7d** (default), **14d**, **30d** or **All**, with a chart of fresh
  versus cached tokens, breakdowns by **Agents** and **Models**, and **Refresh**.

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
and update notices. When **Sound** is on, each event plays its own sound: **New reply**, **Task finished**, **Approval
needed**, **Agent asks a question** and **Sub-agent finished** (a sub-agent plays only its sound, no toast, and
sub-agents that finish together play it once). The taskbar (Windows) or dock icon shows how many chats wait for you.

**Settings.** **Settings → Desktop**: **Notifications** (with **Test notification**), **Sound**, **Badge on the
taskbar icon**. On Windows, notifications need the Start menu shortcut that the installer adds (source runs: `npm run
shortcuts` in `app/`).

**Notification sounds** (also under **Settings → Desktop**): a **Volume** slider and, for each event, **None**, one of
the built-in sounds (Bell, Rise, Chord, Pop, Marimba, Glass, Knock, Tick, Alert; synthesized by the app, no audio files)
or **Choose sound file…** for your own MP3, WAV, OGG, Opus, M4A, AAC, FLAC or WebM file of up to 5 MB. A new choice
plays once; the **▶** button plays it again. Your file is copied into the Deck's profile (`sounds/` in the app's data
folder), so the original can be moved or deleted; only its first 10 seconds play. A file no event uses any more is
removed.

**Needs.** Telegram messages need Telegram mode; finished sessions and sub-agents need the relay; approvals and
questions need the direct connection.

## Status pet, themes, wallpapers and languages

- **Status pet.** A small always-on-top companion window that shows whether agents are idle, working, waiting for you
  or offline, with a speech bubble for new replies and questions. **Settings → Desktop → Status pet**: **Pet look**
  (Character, Owl, Philosopher, Leo, Hasret, Hayat, Orb, Agent), **Pet size** (Small to Extra large) and **Pet
  animations** (stills when off or when the system asks for reduced motion).
- **Themes.** **Settings → Desktop → Appearance → Theme**: **OLED (black)** (default), **Marble (light)**, **Aegean
  (navy)** or **Match the system**.
- **Chat backgrounds.** One background picture per chat mode, built in or your own (**Choose image…**), with
  **Background dimming**. Your picture is copied into Deck's profile.
- **Window.** **Keep running in tray on close** and **Start at login** (macOS: installed app only).
- **Languages.** English (default) and Turkish: **Settings → General → Language**, or in the first-start wizard.

All of these are local to the app; nothing is sent anywhere.

## Work pane

**What it is.** The right slot's work view for the chat on screen (**Ctrl/Cmd+\\**):

- **Session** (first tab; **Ctrl/Cmd+Alt+I**): the chat's channel, agent, profile, model and session id, its figures
  when the relay has them (context with a meter, cache hit, tok/s, fresh / cached / output tokens, tools, turns), and
  **Steer**, **Stop** and **Model**; then what runs in other agents.
- **Run**: the session's tool calls with status and timing bars. Clicking a row opens it in place: its arguments
  (as a field list, **Raw** for the original text) and its output, both visible, with **Copy** for each; a second
  click closes it, and ↗ shows the call in the chat. `patch` and `write_file` calls show a red/green diff per file
  instead of raw arguments (real line numbers when the result carries a diff, a `write` is shown as added lines), and
  their output reads **Applied**, **Wrote 2.0 KB** or **Not applied**. Clicking a tool call in the chat (a receipt
  row, **Inspect**, or a tool chip in the transcript) opens Run on that row, expanded and scrolled into view.
- **Plan**: the agent's own task list, live as it changes, with done/active/pending states, phases and blocked
  reasons. "This agent did not publish a plan" when there is none.
- **Diff**: the files the agent wrote or patched, with +/- counts. Opening a file lists its edits from every `patch`
  and `write_file` call, oldest first (the latest 12), each with its time and **Open in Run**.
- **Sub-agents**: the session's live sub-agents (goal, model, effort, state, elapsed time, context) and recently failed
  delegations. A sub-agent opens with its figures (elapsed, tokens, context, cache hit, tok/s, fresh / cached / output
  tokens, tool calls, cost; only the ones that exist), its live output and recent tool calls, each opening into the
  same arguments and output detail as Run. Times read like **2m 05s** or **6h 38m**, token counts like **12.4k** or
  **2.9M** (hover for the exact number). **Steer** sends a message to one sub-agent and **Stop** ends it.
- **Browser** and **Screen**: the [agent browser](#agent-browsers-browser-tab) and
  [desktop control](#desktop-control-screen-tab) views.

**How it works.** Plans come from Hermes' `todo_list` tool (or OMH's `omh_todo`): the plugin emits a `plan` event
after each successful call, the relay keeps the latest plan per session, and the direct connection streams it as
`deck.plan`. A stored session's plan is rebuilt read-only from the newest task-list result in `state.db`. Tool calls
come from `deck.tools` (direct) or the relay's session detail. Live previews are clipped (300 characters; 1,200 in
the relay's history); opening a clipped call, or a Diff file, reads the full stored call once through the relay
(`GET /session/<sid>/call/<id>`, at most 256 KB per field). Without the relay the detail shows the preview with
"Preview only". Sub-agents are read with `subagent.list` / `subagent.tail`
while the tab is open; Steer and Stop follow a click and are never replayed.

**Needs.** Plugin. Agents, Steer and Stop need the direct connection; a stored plan without the direct connection
needs the relay.

## Inbox and fleet

**What it is.**

- **Inbox** (sidebar › **Needs you**): approvals and questions waiting on the direct connection, failed sessions, and
  top-level sessions that finished in the last 24 hours. **J/K** or the arrow keys move; the selected row opens inline.
  Approvals offer only the choices Hermes advertises (**Deny**, **Allow for this session**, **Approve**; **A** approves
  once); questions take their choices or a typed answer; **Enter** opens the chat. **X** dismisses a failed or finished
  row on this computer only, with **Undo**. "All clear" when nothing waits.
- **Fleet capsule** in the top bar: running agents (teal sweep), agents that wait for you (brass ring), "N running",
  "N need you" and today's cost. A click or **Ctrl/Cmd+J** opens the fleet panel: agents sorted waiting → running →
  idle → offline with task, elapsed time and model · effort, inline approvals and answers, sub-agent lines (open
  Work › Sub-agents), a **Usage details** row that opens the [Usage view](#usage-quotas-and-fleet), today's cost,
  tokens, calls and cache hit, and quota bars.

**How it works.** Approvals and questions come from the direct connection and are answered through the same
`request.answer` path as in the chat, once per click, never resent. Sessions, agents, costs and quotas come from the
relay snapshot. Nothing is inferred from tool arguments; a relay-only session has no inline approval.

**Needs.** Direct connection for approvals and questions; relay for the fleet, costs, quotas and finished sessions.

## Agent browsers (Browser tab)

**What it is.** The Work pane's **Browser** tab (formerly Workspace) shows the browser a Hermes agent is using, live, next to the chat. You can watch
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

## Desktop control (Screen tab)

**What it is.** A Hermes agent using `computer_use` can work in **one window you hand over** on your Windows or macOS
computer. The Work pane's **Screen** tab (formerly Bot screen) shows the frames the agent saw with its clicks marked, and an action log. **Hand to
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
provider as screenshots. The **Screen** tab is shown while desktop control is on or paused, or when the relay
has an agent space.

## Agent spaces

**What it is.** Instead of your desktop, agents use `computer_use` on a desktop of their own, a **space**. The relay
offers three modes:

- **Shared** (`DECK_SPACES=shared`): the agent host's logged-in macOS desktop, used by one agent at a time while the
  others wait in line.
- **Agent** (`DECK_SPACES=agent`): each agent gets its own Linux desktop in a container, so several agents can work
  at once without touching each other or your screen.
- **Overflow** (`DECK_SPACES=overflow`): the shared desktop first, and an agent's own desktop when the shared one is
  busy.

The **Screen** tab shows a space live, with control levels **Watch**, **Together** (you get your own cursor, the
agent continues) and **Full control** (agents wait). **Work on this device** moves an agent to your computer (with
desktop control); **Send back to its space** returns it. An agent's desktop stops on its own when it sits idle and
starts again on its next action.

**Activity and safety** (agents on their own desktops):

- **Activity log.** Every action, with optional screenshots, in a timeline per agent.
- **Risky-command approval.** A terminal command that matches the risky list (for example `sudo`, `rm -rf`) is held,
  and Deck shows a card. **Approve once** lets that exact command run one time; **Deny** refuses it. Enter never
  approves.
- **Undo points.** The agent's home folder is saved when its desktop stops, before an approved risky command and
  before an undo. **Return to this point** puts the folder back.

**How it works.** For the shared desktop, cua-spacesd (from the Cua project) runs on the agent host on loopback and
the relay gates each `computer_use` call with a lock and queue. For own desktops, a **desktop host** runs the
containers: a Deck computer with Docker Desktop, or the agent host with Docker or colima. The relay routes each agent
to its desktop and proxies the viewer to Deck with its own token; Deck shows it in an isolated view.

**Needs.** The relay with `DECK_SPACES` set. Agent mode works with a Linux or macOS agent host: it needs a desktop
host with Docker running and the pinned desktop image, and a desktop uses up to 1.5 GB of RAM. Only the shared
desktop is macOS-specific: it needs a macOS agent host with cua-spacesd (`relay/tools/install-spacesd.sh`), and
overflow mode needs both. Without a macOS agent host, use agent mode with `DECK_SPACES_SHARED_FALLBACK=0`, so an
agent without a desktop gets a tool error instead of falling back to a shared desktop that is not there.

**Settings.** **Settings → This device → Agent spaces** (mode, **Default control**), **Agent desktops** (**Host agent
desktops on this device**, limits, each agent's home host) and **Activity and safety** (activity log, screenshots,
retention, risky-command approval, number of undo points). Setup and behaviour: [agent-spaces.md](agent-spaces.md).
Status: experimental.

## Updates

**What it is.** The app checks for a newer release at start and every 6 hours (**Settings → General → Updates →
Check for updates automatically**, **Check now**). On Windows, **Install the new release** downloads the installer,
verifies it against the release's `SHA256SUMS.txt` (a release without it is refused) and runs it; Deck then restarts
on the new version. On macOS, install the new DMG from the release page (**Open the release page**). The relay's version is
also compared with the app's: a newer relay announces a newer app; an older relay or plugin shows the command to
update it on the host, and **Update the host** (Settings → Relay) updates both from the app. A relay that runs from a
plain checkout is first moved to an install root by that update (Linux systemd and macOS launchd services). **Automatically update the host to this app's version** (off by default) does that after the app
updates.

**Needs.** Network access to GitHub. The host side (relay and plugin) is updated on the host:
[updating.md](updating.md).

**Developer option.** **Advanced → Offer builds from unreleased source (developers)** (off by default) lets a computer
with git and npm build `main` and install that build (Windows, and a packaged macOS app: the new app replaces the running one after it quits, with the old one kept until the swap succeeds). **Repository**, **Branch** and **GitHub token** (only for a
private fork) are under **Advanced** too.
