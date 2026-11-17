# Changelog

All notable user-visible changes to Hermes Deck are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).
The desktop app, relay and Hermes plugin share one version number.

## [Unreleased]

## [1.3.0] - 2026-11-17

- Model picker: **Speed** for the current chat. On a model Hermes offers a fast tier for (Anthropic fast mode on the Opus models that take it, OpenAI priority processing) the popover shows **Normal**, **Fast** and, where the provider publishes it, **Ultrafast**; the model token shows the tier while it is on. It is Hermes' own `/fast` for this session only (the profile-wide setting is never written), absent on models without a fast tier and in Telegram chats. The provider bills a fast tier at a higher rate. Needs this version's Hermes plugin on the host (reinstall, then restart the gateway).
- Relay: phone pairing page. `node tools/mobile-token.js page` (or, for the desktop app, `POST /mobile/pair/page` with the relay token) prints a link such as `https://relay.example/pair/<ticket>` that shows a QR code for the phone app's scanner, an "Open in Hermes Deck" button and the address and code to type by hand, in English or Turkish, light or dark. The page works for five minutes or until the first phone pairs, then only says the link no longer works; the page polls `GET /pair/<ticket>/status`. The link is as sensitive as the pairing code for those five minutes: it needs no token, is never cached, logged or indexed, and at most three wait at once. New optional setting `DECK_RELAY_PUBLIC_URL`, the https address phones use, for complete links; without it the tool prints the path only. `pair` is unchanged. Needs a relay restart.
- Hermes plugin: ships the agent skill `hermes-deck:pair-phone`. Ask your agent "I want to use Hermes Deck on my phone" (or "telefonumu Deck'e bağla") and it answers with a fresh pairing page link and its expiry, never the code itself. Needs the updated Hermes plugin on a Hermes version with plugin skills.
- Relay, phone API: a failed request now carries a typed error code (`busy` with `retryAfterMs`, `offline`, `timeout`, `host` with the Hermes `rpcCode`, `stale`, `bad_request`, `limit`, ...) and an exact `uncertain` flag instead of `bridge_error` plus the desktop's English sentence, so the phone app can tell "busy, retry" from "failed" and never shows "Hermes queue full". `capabilities.errors` is `{v: 2}`. The desktop's messages are unchanged.
- Relay, phone API: each paired phone gets at most 8 requests running on the host at once; up to 32 more wait their turn for 10 seconds, then answer `busy` with `retryAfterMs` (nothing was sent, and a waiting action's request ID stays usable). Identical reads running at the same time (the same chat's history twice) share one host call, and the relay's own background reads (notification text, agent names, its keep-alive) have a separate budget of 2, so they can no longer push the phone's requests into the host's 64-request limit.
- Relay, phone API: reading a chat's sub-agents, a sub-agent's output or the model list no longer resumes that session on the host (`capabilities.readsNeverResume`): a chat the phone has not sent to answers "not available" / the agent's model list instead. Sending to a chat resumes it once even when several requests arrive together (also on the desktop, which used to send one resume per waiting request). When one agent's chat list cannot be read, the phone keeps that agent's previous rows, marked stale, instead of losing them.
- Desktop and relay: every request to Hermes that concerns one agent now names it, also the default agent (`profile: "default"`), and a session list never shows a row the host attributes to another agent. This keeps the default agent's chats from being mixed with another agent's when Hermes cannot tell them apart.
- Relay: the journal now records every refused or failed phone request (operation, error code, how many were running and waiting, the host's pending count, duration), each phone bridge's connection changes, and a one-line summary per minute while the phone is used (requests, failures, 95th-percentile duration, peak pending). No message text, titles, tokens or full session ids are logged.
- Relay, phone API: an action repeated with the same request ID within 10 minutes (the last 256 per phone) answers the first outcome, marked `replayed`, instead of only "already used": a phone whose reply got lost learns the new chat's id or that the message went through. While the first attempt still runs the repeat answers `pending`; an outcome that was itself unknown (a timeout) still answers `duplicate`. `capabilities.replay` is `true`.
- Relay, phone API: `POST /mobile/op` runs one phone action over plain HTTPS without opening the live connection, for answering an approval or a question, or replying, straight from a notification. It takes the same request as the WebSocket (plus an optional `waitMs`, up to 20 s, to wait for the host connection) and gives the same answer, with the same request IDs, limits and replay; failures come back as `200` with `ok: false`. Only the actions listed in `capabilities.httpOps` are accepted.
- Relay, phone API: a new chat with its first message is one request (`start`, `capabilities.start`): the relay creates the chat and sends the message on the same host connection, so the message can no longer fail because the new chat was dropped in between. If the message provably never left, the empty chat is removed again; if its fate is unknown the error names the chat so the phone can look there. A message to a chat created this way that never got its first turn (for example after a reconnect) now goes to a freshly created chat instead of failing with "session not found".
- Relay: the history routes (`/session/<sid>/messages`, `/tools`, `/call/<id>`) take an optional `?profile=<name>` and then read only that agent's store, so two agents with the same session id can no longer be mixed up (`capabilities.historyProfile`). Without the parameter nothing changes.
- Docs: `docs/relay.md` describes the phone error codes, request limits, replay, `start`, `POST /mobile/op` and the journal lines.
- Phone notifications are calm: one banner per finished turn instead of one per assistant message (replies only update it); by default only chats you sent to, steered or opened on that phone in the last 12 hours (or agents you follow) notify, sub-agent sessions never do, and approvals and questions still come from every agent. After 5 banners you have not looked at, the phone gets nothing for 10 minutes, then one summary ("9 updates in 3 chats, 1 needs you"), with the quiet time doubling up to an hour while the phone stays unopened. Opening the app, a notification or any action from the phone resets it. Needs a relay update; phones on the current app get these defaults without changes.
- Relay for the new iOS app: the push registration takes a notification policy (burst, quiet minutes, scope, followed and muted agents, approvals that bypass the quiet time), `POST /mobile/seen`, a test push, and notification records with a per-chat thread id, the badge count (open approvals and questions) and the request to answer from the banner. A banner replaces the previous one of the same chat once the push gateway offers it.
- One Hermes gateway that serves several agent profiles no longer files every agent's activity under one name. The Hermes plugin used to remember the first profile it saw and stamp every later event, token count and gateway state with it, so one agent's card showed another agent's running chat, last message and token use (a gateway restart only changed which agent collected everything). Every event, computer-use frame and state file now carries the profile of the agent that produced it, and every served profile gets its own gateway/cron state file; quota polling still runs once per gateway. Needs the updated Hermes plugin and a gateway restart; events already written under the wrong name stay as they are. Install and restart steps: [updating.md](docs/updating.md#one-gateway-serving-several-agents-wrong-agent-on-a-card).
- Relay: when the Hermes bridge reports which agent owns a session, that answer wins over the profile stamped on the session's events: the session, its sub-agents and its later token use move to the right agent (this also repairs sessions recorded by an older plugin while a phone is connected). `/snapshot` agents carry `scoped`: `false` means the agent's numbers may still include another agent's work and should be shown as host-wide. Needs a relay restart.
- The Deck's connection to Hermes no longer lands on some other Hermes process (a CLI started for another profile) while the gateway restarts: requests then fail as not sent instead of being answered by the wrong process. Needs the updated Hermes plugin.
- A slow chat history read no longer holds up the rest of a Deck or phone connection: history reads and other gateway requests run beside it (in order per chat), so the session list and other chats answer at once. A request that cannot start within 10 seconds now gets a "busy, retry" answer instead of no answer. Needs the updated Hermes plugin and a gateway restart.
- Exited Hermes processes no longer leave records behind that every Deck stream re-reads several times a second: a Hermes process removes its own record, activity file and control socket when it exits, and on start removes those of exited processes in its own profile folder. The stream skips exited processes without opening their files, reads an unchanged record once, and checks once a second (instead of five times) while nothing is working. Needs the updated Hermes plugin; the first gateway start after it cleans up.
- Phone notifications: a phone app that does not send a notification policy follows the default agent, so a turn of the main assistant that was started at the desktop still reaches the phone, while other agents' unattended chats stay quiet. An app that sends a policy decides for itself which agents it follows.
- Phone notifications: a chat the phone has just created (a new chat, a new bot chat, a branch, or a chat re-created by a send) counts as one of its own at once, so the answer to its first message is announced.
- Hermes plugin: provider quotas are always published in the default agent's state file when the gateway serves it, whichever agent profile registered first.
- Phone API: the agent picture (`avatar`) can be read over `POST /mobile/op`, so a notification can show which agent it is from.
- Phone notifications: the test notification now arrives also when "Finished" notifications are turned off (it uses a kind the phone has on, or the push gateway's own `test` kind), and its answer says it is exempt from the burst breaker.
- Phone notifications: with an updated push gateway the app icon badge (open approvals and questions) rides on every notification, and an approval or question answered at the desktop lowers it again with a silent badge-only push.
- Phone API: a phone can watch a chat that runs elsewhere (started at the desktop, by another app or by a schedule) and see its turn stream live, read-only (`watch` / `unwatch`, `capabilities.watch`); one watched chat per phone, released when the app disconnects.
- Phone API: when a password or secret prompt is open on the computer, the phone learns that a chat needs input there (`maskedPrompt: true` on the session, event `maskedPrompts`, `capabilities.maskedPrompt`), without any of the prompt's content.
- Phone API: search the text of past messages across every agent (`searchMessages`, `capabilities.searchMessages`), newest first with highlighted snippets; secrets in messages are masked in the snippets.
- Agents: a profile can name its colour (`ui_meta['hermes-deck'].hue`, one of seven), and the phone draws that agent in the same colour on every device (`hue` on the profile rows, `capabilities.profileHue`).
- Phone notifications: with an updated push gateway, a Live Activity on the Lock Screen follows a long turn (needs you, back to working, finished, failed) and takes the place of that chat's banners while it runs (`PUT /mobile/activity`, `capabilities.liveActivity`); no conversation content is pushed.
- Phone API: `capabilities.screen` tells the phone it may show the bot screen's frames and offer Stop, through the two routes it could already reach; leasing and granting stay on the computer (`desktop` is unchanged).

## [1.2.7] - 2026-11-16

- Find in the open chat: **Ctrl+F** (**Cmd+F** on macOS) opens a small bar at the top right of the chat. Every match in the transcript is marked and counted ("3 / 17"), starting at the newest; **Enter** goes to the match before, **Shift+Enter** to the one after, **Esc** closes. Letter case is ignored. A session opens on its latest messages only, so when earlier ones are not loaded the bar offers **Search earlier messages**, which loads older pages until a match shows up or the session's start is reached. Folded content (a collapsed Thinking block, a tool call that is not unfolded) is not searched.

## [1.2.6] - 2026-11-16

- Copy buttons work: the code block **Copy**, the copy action of a message or a Thinking block, the command box and the other Copy buttons did nothing, because the app refused its own pages the permission to write to the clipboard. Writing text is now allowed for the app's own pages; reading the clipboard stays refused.

## [1.2.5] - 2026-11-16

- A click on a tool call in the transcript (the `terminal ...` line under a thought) unfolds that one call right there, with its whole arguments and output, also while the turn is still running. The turn's "Working ... tools" receipt and the Work pane no longer open on that click; **Open in Run** inside the unfolded call takes you there.
- A downloaded file always has an **Open** button, also an installer or a script; for a file type that runs code the app asks first, with Cancel as the default. Media from Telegram chats is still never opened this way.
- While a turn runs, the composer shows the command it is running (or ran last) in a box of its own that comes out from behind the composer card: clipped to three lines by default, or unfolded with **Show all** to the whole command down to its last line, with the call's other arguments and a **Copy** button. The choice is remembered.
- Unfolding a tool call in a turn's receipt ("Worked ... tools") only unfolds it in the chat; the Run pane opens when you choose **Inspect**.
- A reply is drawn as Markdown while it streams: bold, lists, tables and code blocks appear formatted as they arrive instead of as raw `**text**` until the turn ends.
- Scrolling up while a reply streams keeps the view where it is: the reply goes on arriving below without pulling the transcript down, and a text selection in an earlier message stays selected. At the newest message the view follows the reply as before.
- Markdown tables fit the chat column at every width, including a narrow split-view pane: a long file path or other code in a cell wraps after its `/` separators instead of pushing the table (and its last columns) out of view, and words stay whole. A table too wide for the reading column widens into the empty space beside it (centred, up to the pane's width) instead of scrolling inside the column; in a pane with no room beside the column words may break too, so the table still fits.
- Code blocks in chats have a **Copy** button (shown on hover or keyboard focus) that copies the block's code.
- Downloading a file whose name already exists in the download folder now replaces that file once the download is complete, instead of saving `name (1).ext`; a failed or cancelled download leaves the existing file untouched. **Settings → General → Downloads → Keep both when a file of the same name exists** brings the numbered copies back. A file that is open or running and cannot be replaced is kept, and the download is saved beside it under a numbered name.
- A file the agent rebuilt and offered again at the same path gets a fresh **Download** chip in the new message (current size, not shown as already saved).
- A file the agent names by its plain absolute path (for example `/home/user/out/build.zip` on a line of its reply, no `MEDIA:` prefix or backticks needed) gets a download chip too. Such a chip appears only once the host confirmed the file exists and may be downloaded, so paths that are merely mentioned stay plain text.

## [1.2.0] - 2026-11-10

- Every saved host is live at once: each keeps its relay and direct connection open while the Deck runs, so replies, finished turns, approvals and questions from any host raise their notification and open that host's chat when clicked. Every host you open keeps its page warm in the background: switching back is instant with scroll, open chat and draft intact, nothing reloads.
- Split view: two hosts side by side, each a full Deck with its own top bar. Picking the host the other pane shows swaps the panes; the divider drags (360 px minimum per pane); split on/off, the right host and the divider position survive a restart. This device's hosting switches follow the left pane's host and change only from there.
- The top bar's host dropdown and its "Relay: … · Sessions: …" line are replaced by numbered monitor-style buttons (1, 2, …) centred on the bar. The shown host is filled, each number has a connection dot (green all connected, amber connecting or one part down, red disconnected, grey unobserved) and a tooltip with the host name and its Relay and Sessions state. Arrow keys move between the numbers and Ctrl/Cmd+1…9 selects a host. The switcher is hidden with a single host. A host switch no longer waits for a page reload.
- A **Split view** button next to the host numbers shows two hosts side by side (when the app supports it); each pane has its own numbers, and the Windows caption-button space is reserved only in the right or full pane.
- A finished turn notifies once (one sound): the relay and the direct connection both report it, and the second report of the same session moments later no longer raises a second notification.
- Markdown tables in chats fit the message column and wrap their cell text instead of growing past it; a table only scrolls sideways when something in it cannot break (a long URL or code token).
- The top bar's host numbers sit in the bar's own flow between the breadcrumb and the right-hand controls (fleet capsule, search, Work, settings): centred while there is room, shifted left instead of overlapping when the right-hand group needs more space.
- The chat title is no longer repeated in the top bar's breadcrumb; the chat header below shows it.
- The collapsible agent status card above the composer (added in 1.1.0) is removed. What the agent is doing stays in one place, the live row at the end of the transcript, with the session's status line (state, sub-agents, context) above the composer as before 1.1.0.
- Hermes chats show one tool receipt per message you sent, after the work it started. A session watched from here (a sub-agent, a TUI or Telegram run) no longer piles a row of "1 tools" receipts under its work.
- Tool counts read "1 tool" / "2 tools" in receipts, the sub-agent views and the session statistics.
- The live row no longer says "Running terminal · done" for a step that already finished; it says Thinking…. When this Deck receives no live reasoning for a session (it runs elsewhere), Show thinking says so instead of promising reasoning that will not come, and a turn whose model streamed no reasoning says so after its first step.
- Opening a session that is working elsewhere on the host's gateway (a sub-agent, or a run started from another Deck, the phone or Hermes Desktop) now streams its tool calls and, with Show thinking open, its reasoning live, also after a reconnect or gateway restart; the Deck only watches (it never sends, stops or takes the session over) and lets go when you open another chat or the turn ends. Show thinking is one switch per Hermes session, so a TUI or Hermes Desktop on the same session also shows reasoning while you watch with it open. Telegram turns and a TUI in its own process still show the snapshot only. A turn's call count in Work › Run reads "1 call".
- Approvals and questions reach every Deck connected to a host as they are asked, including those of a session started from another Deck or before you switched hosts, so an inactive host notifies you and the card can be answered there. A card answered or expired anywhere leaves every Deck. Needs the updated Hermes plugin and a gateway restart.
- When the agent asks for a sudo password, a secret value, a password manager's master password, a login to save for a site (username plus password) or a one-time code, a masked card now appears in the chat's request tray, like an approval: Enter sends, Esc or Cancel declines, Show reveals the field. What you type goes to Hermes once and is cleared from the card at once; notifications only say that a password or code is needed and for which site. Before, the Deck ignored these prompts, so the agent waited out its deadline and reported the login as declined. On every Deck connected to the host (not only the one that started the session) these cards need the updated Hermes plugin (reinstall it) and a gateway restart. The phone does not show them.
- Relay: `DECK_RELAY_HOST` accepts several comma-separated addresses, for example loopback plus a home LAN address. Only the first must bind; the others are skipped while the machine does not have them and retried every 30 seconds.
- Usage shows spend allowances next to the quota windows: Claude extra usage (used / limit in dollars, monthly) and Codex workspace credits and balance. An account that reports only a spend allowance is no longer shown as having no quota windows. Quota providers are found again on Hermes builds that ship only `ruamel.yaml`. Needs the updated Hermes plugin.
- Group Chat in the Bots view: rooms of 2 to 6 bots hosted by the Hermes gateway (the same rooms Hermes Desktop
  shows, running while Deck is closed). **Group chats** rows with the latest message, unread and needs-you badges;
  **New group chat** (name and bots); one transcript with each speaker's face and name; `@` suggestions for the
  members and `@all`; one "… is thinking" line and Stop; command approvals as cards in the room; rename and disband.
  Needs the updated Hermes plugin (it now passes the gateway's `groups.*` calls) and a gateway restart after
  installing it; older gateways simply show no Group Chat.
- With every host live at once, a file download or an image/audio preview stays on the connection it started with: if that host's connection restarts or the saved host is edited meanwhile, the download stops with a message (download it again) and a late preview is dropped. Switching the pane to another host, or another host reconnecting, no longer cancels it.

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
