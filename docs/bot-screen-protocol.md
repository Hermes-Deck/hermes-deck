# Bot screen: device driver protocol (v2)

This protocol lets a Hermes agent use `computer_use` on the desktop of the device you are active on, through a cua-driver that runs inside the Deck on that device. The agent itself stays on the **agent host**, the machine running Hermes and the relay.

Nothing listens on the device: the Deck dials out to the relay. The feature is off unless you turn it on, on each device, in the Deck.

## Changes from v1

- **Device channel.** There is no separate `/driver` WebSocket. Driver frames ride the Deck's existing relay connection as binary frames, next to the Workspace tab's CDP tunnel, so each Deck keeps one outbound connection. The device token moved into the driver `HELLO`, and DATA/ERR carry raw bytes instead of base64.
- **Device ids** are the presence ids from `relay/src/presence.js` (hex). The Deck reports `driverOk.desktop: true` in its heartbeat only while the relay accepts its driver hello.
- **Routing key.** The profile-scoped gateway session key comes first (see Routing). The wrapper's hello gained `skey`.
- **Plugin query.** The hermes-deck plugin (its events part) asks the relay for the route and the grant over the local driver socket.
- **A second fence** in the relay checks every MCP message that goes to a device. The plugin's fence table gained rows.

## Pieces

| Piece | Where | Job |
|---|---|---|
| `deck-cua` wrapper | agent host; set as `HERMES_CUA_DRIVER_CMD` | Hermes runs it instead of `cua-driver`. See the routes below. |
| hermes-deck plugin (events part, `events.py`) | agent host | Fences `computer_use` (layer 1), stores frames and `cu` events, resets a session's driver connection after a move. |
| relay | agent host | Routing (presence.js, capability `desktop`), the local driver socket, device channels, the MCP fence (layer 2), lease, stop and frames. |
| Deck in device mode | your devices | Runs cua-driver in bounded mode in your session (layer 3) and carries driver channels over its relay connection. Owns consent, the activity bar and Stop. |

`deck-cua` routes:
- **host:** run the local driver (`DECK_CUA_DRIVER`, else `cua-driver` on PATH) with stdio inherited.
- **device:** carry the session through the relay's local driver socket.
- **none:** print one line the agent can read and exit 69.

Whatever the route, `manifest` output gets `mcp_invocation.command` pointed back at the wrapper. Hermes launches the command a manifest reports whenever it is a path, which would bypass routing.

## Routing

Routes come from `relay/src/presence.js`: `routeFor(key, "desktop")` returns a route with `host: {kind: "device"|"fallback", id, name}` and `epoch`, or null. The relay turns that into `device` = the device id, `"host"` for the fallback, or no route.

How the device is chosen (presence.js):
- the least idle device whose heartbeat is under 30 s old, that is unlocked, idle under 120 s, has `hosting.desktop` on and a working driver;
- with none, the agent host, but only when `DECK_DESKTOP_HOST=1` is set in the relay `.env` (off by default);
- the route sticks to the agent session until a handoff, the loss of that device, or the end of the session (5 min without use and no open MCP session). Every change bumps `epoch`.

The routing key is:
1. `p:<profile>/k:<gateway session key>` when Hermes has one (gateway turns);
2. else `p:<profile>/s:<session id>` (CLI runs);
3. else `p:<profile>`.

Why: Hermes copies its session ContextVars (`HERMES_SESSION_*`) into every cua-driver child's environment (`tools/environments/local.py`, `_inject_session_context_env`). `HERMES_SESSION_KEY` is bound on every gateway turn. `HERMES_SESSION_ID` is bound only when an agent is built or compressed, so later turns of a cached gateway agent see it empty. The wrapper takes both from its env and the profile from `HERMES_HOME`; the plugin reads the same values the same way, so both land on one route. The profile is part of the key because two bots talking to one person share a Telegram chat id.

## Local driver socket (agent host only)

- **Path:** `$DECK_HOME/driver.sock`, default `~/.hermes-deck/driver.sock`. Mode 0600, owner only.
- **Framing:** NDJSON in both directions, one JSON object per line.

Wrapper handshake:

1. The wrapper sends `{"t":"hello","v":1,"argv":[...],"sid":"<session id or empty>","skey":"<gateway session key or empty>","profile":"<name>"}`.
2. The relay answers `{"t":"route","ok":true,"device":"<id>|host","epoch":<n>}`, or `{"t":"route","ok":false,"error":"<one line for the agent>","code":<exit code, optional>}`.

After the handshake:

| Message | Direction | Meaning |
|---|---|---|
| `{"t":"data","b64":"..."}` | wrapper → relay | stdin for the driver |
| `{"t":"data","b64":"..."}` | relay → wrapper | stdout from the driver |
| `{"t":"err","b64":"..."}` | relay → wrapper | stderr from the driver, or a line from the relay |
| `{"t":"exit","code":<int>}` | relay → wrapper | last message from the relay; the wrapper exits with this code |
| `{"t":"close"}` | wrapper → relay | Hermes closed the driver's stdin. Sent for `mcp` only; the relay then stops the device process, and its exit ends the wrapper. |

Plugin query (one per `computer_use` call; it makes the route if there is none yet):

1. `{"t":"query","v":1,"sid":"...","skey":"...","profile":"..."}`, the same identity as the wrapper's hello.
2. `{"t":"route","ok":true,"device":"<id>|host","epoch":<n>,"live":<bool>,"name":"<device name>","grant":{...}|null,"deckPid":<int>|null}`, then the relay closes the socket. `grant` is only the grant for this profile's agent. `live` says whether an MCP session with this key is still connected. On failure: `{"t":"route","ok":false,"error":"..."}`.

`deck-cua` exit codes: the driver's own, or

| Code | Meaning |
|---|---|
| 69 | no route (the reason is the last stderr line, at most 200 chars, which Hermes shows the agent) |
| 75 | relay not running, or the relay ended the session (stop, device gone, route moved) |
| 126 | verb not allowed on a device |
| 127 | no local driver for the host route |

## Device channel (relay ⇄ Deck)

- **Connection:** the Deck's own relay WebSocket (`/events`, relay token), the one that already carries presence heartbeats and the CDP tunnel.
- **Framing:** binary messages `[0xD5][op u8][channel u32 BE][payload]`. CDP tunnel frames start with `0xCD`. The relay allocates channel ids; channel 0 is the device itself. Control payloads are UTF-8 JSON, DATA and ERR payloads are raw bytes.

| Op | Frame | Direction | Payload and meaning |
|---|---|---|---|
| 1 | HELLO | Deck → relay | `{"v":1,"device":"<presence id>","os":"win32\|darwin","deck":"<version>","driver":{"ok":true,"version":"x.y.z"},"desktop":true\|false,"pid":<deck pid>,"token":"<device token>"}` on channel 0, after connecting and whenever the token changes. |
| 2 | READY | relay → Deck | `{"ok":true}`, or `{"ok":false,"error":"..."}` for an unknown or revoked token. |
| 3 | OPEN | relay → Deck | `{"argv":[...],"agent":"<name>","profile":"<name>","sid":"<session>"}`: start one driver process. `argv[0]` is one of `mcp`, `manifest`, `--help`, `call`, `status`, `doctor`; answer anything else with CLOSE `{"code":126,"error":"verb not allowed"}`. Flags that pick another runtime or widen it (`--socket`, `--direct`, `--embedded`, `--grant`, `--permission-mode`, `--capability-manifest`, `--screenshot-out-file`, ...) get CLOSE `{"code":126,"error":"flag not allowed"}`. |
| 4 | DATA | both | relay → Deck: stdin bytes. Deck → relay: stdout bytes. |
| 5 | ERR | Deck → relay | stderr bytes |
| 6 | CLOSE | both | `{"code":<int>,"error":"..."}` (`error` optional). relay → Deck: kill the process. Deck → relay: it exited; send this after a kill too. |
| 7 | STOP | relay → Deck | `{"reason":"..."}` on channel 0: kill every channel. |
| 8 | STOPPED | Deck → relay | `{"by":"button\|hotkey\|toggle\|lock\|quit\|expiry\|idle"}` on channel 0, after any local stop. |
| 9 | GRANT | Deck → relay | `{"grant":{...}}` on channel 0, after the consent sheet. |
| 10 | REVOKE | Deck → relay | channel 0: withdraw the grant. |

The grant object is:

```json
{"agent":"<name>","app":"<name>","window":{"id":<int>,"pid":<int>,"title":"..."},"expires":<epoch ms>,"idleMin":30,"foreground":false}
```

`agent` is the agent's display name (or its profile name). `window.id` is cua-driver's window id from `list_windows`.

`foreground` is true only when the user checks Foreground control in the local hand-over sheet. Missing or non-boolean values mean false. This allows physical mouse/keyboard input for that window in that grant only; every foreground input names its exact pid and window id. Take control pauses the agent through the existing human lease; Stop, expiry, lock, sleep and quitting end the grant. Administrator applications still require the owner to start Deck as administrator through Windows confirmation.

On Windows, the Deck attempts to raise the granted HWND before forwarding an MCP foreground input call for that exact pid/window. Raising is best effort: failure leaves the call unchanged so the driver can report `foreground_unavailable`. Background input never triggers this helper, and `bring_to_front` remains refused by all three fences. Office windows show a foreground-control note in the confirmation sheet; the checkbox stays off by default.

- **Device tokens:** one per device, issued and revoked on the agent host (`node tools/device-token.js add|list|revoke <name>` in `relay/`). Only hashes are stored, in `relay/devices.json` (gitignored). The relay rechecks live channels every 15 s; a revoked token gets READY `{"ok":false}` and its sessions end.
- **Binding:** the relay opens a session only over the connection presence.js associates with the routed device id, and only when that connection's HELLO named the same id with a valid token.
- **One MCP session per Hermes driver session.** Element tokens from `get_window_state` live only inside one driver session, so the relay never splits or reopens a channel. When a channel dies the wrapper exits, and Hermes starts a new session on its next call.

## Fence, layer 3: the Deck (`app/main/cua/`)

- **Before a process starts** (every OPEN): the verb and flag rules above, the **Desktop control** switch (Settings → This device), the agent's profile on the device's allow list, and for `mcp` and `call` a live grant for that same agent. A refusal is a CLOSE with the reason; nothing runs.
- **The driver** is the Deck's own daemon in bounded mode (`serve --permission-mode bounded --capability-manifest … --approve-capability-manifest`) on a socket only this Deck knows; channel processes are pointed at it with `--socket` and get the bounded-mode variables too. On macOS the daemon runs as CuaDriver.app (`open -n -g -a`), so the TCC grants stay with the app. A new grant restarts it.
- **The manifest** names the granted app only (`executable` on Windows, `bundle_id` on macOS; `launch` for that app alone, `terminate: deny`, `desktop.display: false`) and only the tools layer 2 passes and Hermes uses; it never lists `kill_app`, `bring_to_front`, `set_window_frame`, `move_cursor`, `get_desktop_state`, `get_accessibility_tree` or the clipboard tools. It expires with the grant (2 h) and after 30 min idle. Under `display: false`, cua-driver 0.33.3 refuses a `list_windows` without a `pid` and every `list_apps` as "desktop display observation"; `list_windows` with the granted `pid` passes, so layer 2 pins it (below). `list_apps` is not in the manifest.
- **The consent sheet** lists windows through a second daemon of the Deck's own: no app, `start_session`, `end_session` and `list_windows` only, and `desktop.display: true`, because the sheet needs every window and its pid. With no capture or input tool allowed, `display: true` there buys the window list and nothing else. Nothing from the relay reaches this daemon; it stops when a window is handed over, and 5 min after the sheet last listed windows.
- **Info verbs** (`manifest`, `--help`, `status`, `doctor`) run to completion in the Deck; their output leaves with the user's home folder replaced by `~`.
- **Stop** (the bar, the tray, the tab, the hotkey), local first: close channels, kill driver processes, switch to paused, STOPPED, then `POST /desktop/stop`. Locking or sleeping the device, the grant's expiry or idle time, quitting the Deck and a STOP from the relay end the grant too.

## Fence, layer 2: the relay (every MCP message to a device)

`relay/src/mcpfence.js` reads each JSON-RPC line between Hermes and the device's driver. Tool names follow cua-driver 0.33.

| Request | Relay response |
|---|---|
| `initialize`, `ping`, `tools/list`, notifications | Passed through. |
| Any other method (`resources/*`, ...) | Refused with a JSON-RPC error. |
| `start_session`, `end_session`, `set_agent_cursor_enabled`, `get_config`, `get_cursor_position`, `get_screen_size`, `get_displays` | Allowed. |
| `set_config` | Allowed, except `capture_scope`. |
| `get_window_state`, `screenshot` | Only with the granted window's `window_id` (and its `pid` when given). |
| `click`, `double_click`, `type_text`, `press_key`, `hotkey`, `scroll`, `drag`, `set_value`, `get_accessibility_tree` | Only with the granted `pid`, and the granted `window_id` when one is given. A missing pid means the frontmost window, which is the user's. |
| `list_windows` | Pinned to the granted `pid`: a missing one is filled in, another one is refused. The answer is cut to the granted window, text parts included; when nothing is left it becomes an error saying the window is minimized or closed. |
| `list_apps` | Never reaches the device (the driver has no pid filter for it): the relay asks `list_windows` on the granted pid and answers with one row for the granted app (`name`, `pid`, `running`, and `display_name` when the Deck names the app differently), or none when its process has no window. |
| `launch_app` | Only the granted app. |
| Foreground delivery on input tools | Only with `foreground: true` and the exact granted `pid` and `window_id`. |
| `kill_app`, `get_desktop_state`, `clipboard_*`, `bring_to_front`, `browser_*`, `move_cursor` | Refused. |
| Any tool not listed | Refused. |
| Anything but the plumbing, with no valid grant | Refused. |

A refused `tools/call` gets an `isError` result whose text the agent reads; it never reaches the device. A driver error on a listing keeps its text (capped at 500 characters), since that is all Hermes reads. A `call` (Hermes' CLI fallback) is checked the same way before it starts, with the same rewrite in its arguments, and a `call list_windows|list_apps` answer is filtered before the wrapper sees it.

## Fence, layer 1: the plugin (`computer_use`, on device routes)

| Agent request | Plugin response |
|---|---|
| Capture of the granted window, or of its app by name | Allowed; pinned to the granted pid and window id. |
| Untargeted capture | The granted window is injected as the target. |
| `app` = `screen`, `fullscreen`, `full screen`, `all` or `desktop` | Blocked. |
| Capture of another app, pid or window | Blocked. |
| `focus_app` to the granted app | Rewritten to an exact `ax` capture of the granted window (another window of the same app is never picked). |
| `focus_app` to any other app | Blocked. |
| Input before a capture pinned to the current grant | Blocked: "capture first". |
| `list_apps`, `list_windows` | Blocked. |
| `delivery_mode: foreground` on input | Requires local `foreground: true`, a capture pinned to the current grant, and the same app/window; injects exact pid/window id for the relay fence. |
| `bring_to_front`, `focus_app` with `raise_window` | Blocked. |
| Any target whose pid is the Deck's, or a grant on the Deck's own window | Blocked. |
| No grant for this agent | Blocked: ask the user to hand over a window (**Hand to agent**). |
| `kill_app` | Always blocked, on every route. |
| No route, or the relay unreachable | Blocked with the relay's reason. |

The plugin is active only for profiles whose `HERMES_CUA_DRIVER_CMD` points at `deck-cua` (or with `DECK_BOT_SCREEN=1`; `0` turns it off). If the fence itself fails, the call is blocked.

## Session reset

- When presence moves a route (handoff) or loses it (device gone, hosting switched off), the relay ends that route's driver sessions; Hermes reconnects on its next call and lands on the new route. It never replays an action whose outcome it does not know.
- When a session's device changed while one of its MCP sessions is still connected (`live`), the plugin calls `release_computer_use_session(sid)` so the next call starts a fresh driver connection. Either way the agent's next input needs a new capture.

## `cu` events (plugin → NDJSON → relay → Deck)

```json
{"type":"cu","sid":"...","agent":"...","profile":"...","ts":1730000000000,
 "action":"click|double_click|type|key|scroll|drag|capture|other","raw":"right_click",
 "x":412,"y":230,"window":{"id":123,"app":"Excel"},
 "frame":"<profile>/<sid>/<n>.jpg","device":"<id>|host","ok":true,"error":null}
```

- `ts` is in milliseconds. `raw` is the original action when it differs from `action` (`right_click`, `focus_app`, ...). The relay fills in `agent`.
- `x` and `y` are in frame pixels, or `null`. `window`, `frame` and `error` can be `null`. `device` is `null` when the call never got a route.
- Element clicks use the centre of the element's bounds from the last capture. An action without its own picture points at the session's last frame.
- **Frames:** JPEG, at most 1280 px wide, stored 0600 under `$DECK_HOME/cu/`. Without Pillow in Hermes' Python the original PNG or JPEG is kept.
- **Serving:** `GET /cu/<frame>` with the relay token.
- **Pruning:** frames older than 24 h go first, then the oldest until the folder is under 500 MB.

## Lease and stop

**Lease** (**Take control** / **Return control**):

1. The Deck sends `POST /desktop/lease {"profile":"<name>","hold":true|false}`.
2. The relay runs `relay/tools/lease.py` with Hermes' Python (`DECK_HERMES_PYTHON`). The script uses Hermes' own lease module (`tools/bot_desktop/lease.py`) with the holder id `hermes-deck`.
3. The relay replies `{"ok":true,"holder":"human"|null}`. Handing back releases only the Deck's own hold: if another viewer holds the lease, `holder` stays `"human"`. Unknown profile: 404.

While a human holds the lease, Hermes refuses every `computer_use` call.

**Stop:** `POST /desktop/stop {"device":"<id>"|"host"|null}`. The relay:
- sends STOP to that device, or to every device when `device` is null, and drops their grants;
- ends the wrappers attached to it (`"host"`: the agent host's own sessions; null: all);
- ends the matching routes.

It replies `{"ok":true,"devices":[...],"wrappers":<n>}`. A STOPPED frame from a device does the same for that device.

## Hermes settings

- `HERMES_CUA_DRIVER_CMD=<checkout>/relay/bin/deck-cua` in the profile's `.env`.
- `computer_use.no_overlay: false`, or a macOS agent host turns the agent cursor off.
- `computer_use.permission_mode: standard`. Bounded mode and `/yolo` run a private `serve` daemon on the agent host, which cannot move to a device.

## Consent defaults

- A grant lasts at most 2 h and stops after 30 min idle.
- The **Desktop control** switch can only be changed on the device itself. The relay can never turn it on.
- Stop works locally even when the relay or Hermes is offline. Windows: Ctrl+Alt+Shift+S. macOS: ⌃⌥⌘S.
