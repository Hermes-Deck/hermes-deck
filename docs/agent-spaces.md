# Agent spaces

Agents that use `computer_use` can work on their own desktop, a **space**, instead of yours. Shared mode uses
the agent host's logged-in macOS desktop, where agents take turns. Agent mode gives each agent its own Linux
desktop in a container; overflow mode uses one when the shared desktop is busy. Deck shows it live in the **Bot
screen** tab, where you can watch, join in or take full control. One click moves an agent to the device where Deck
is open (**Work on this device**), and another sends it back (**Send back to its space**).

Status: experimental. Per-agent desktops support activity logs, risky-command approval and home-folder undo
points. These controls apply to agents on their own desktops, including overflow, not shared or user-device routes.

## How it fits together

- **cua-spacesd** (from the [Cua](https://github.com/trycua/cua) project, used unmodified as a separate download)
  runs on the agent host.
  - It listens on `127.0.0.1:3211` and serves the live view, presence cursors and a desktop driver.
  - Its token stays on the agent host.
- **The relay** decides when an agent may act on the shared desktop: one at a time, the others wait up to 120 s.
  - It serves Deck `GET /spaces`, `POST /spaces/route`, `POST /spaces/control` and `POST /spaces/mode`, plus the
    viewer under `/spaces/host/view/`.
  - The viewer is proxied, and the relay adds the cua-spacesd token itself.
  - Only the calls the viewer needs get through; input calls are refused at the **Watch** level.
- **Agent actions** use the existing host route of desktop control (`deck-cua` → the agent host's cua-driver).
  Every action asks the relay first, so a busy desktop makes the agent wait its turn.
- **Deck** loads the viewer from a local proxy into an isolated view (own in-memory partition, no preload, no
  permissions except full screen, no clipboard sync).

```
Hermes profile ──computer_use──> deck-cua ──socket──> relay ──(host route)──> cua-driver ──> agent host desktop
                                                        │  ├─ lock + queue (shared mode)
                                                        │  └─ viewer proxy (token added) <── cua-spacesd (loopback)
Deck (Bot screen tab) <── local proxy <── authenticated HTTP/WS ──┘
Deck "Work on this device" <── device channel ── bounded cua-driver on your computer + its agent cursor
```

## Install on the agent host

1. Run the repository's `relay/tools/install-spacesd.sh` on the agent host as the logged-in user:

   ```bash
   sh relay/tools/install-spacesd.sh --dry-run   # shows what it would do, writes nothing
   sh relay/tools/install-spacesd.sh
   ```

   The script:
   - downloads the pinned release (cua-spacesd 0.5.3, macOS universal app);
   - checks its SHA-256, then checks that the app is signed by the Cua developer team;
   - installs it to `~/.cua-spacesd/`, with a random token at `~/.cua-spacesd/token` (mode 0600);
   - loads the LaunchAgent `ai.hermes-deck.spacesd` in the GUI session.

2. In System Settings → Privacy & Security, turn on **Screen Recording** and **Accessibility** for "Cua Spacesd".
   macOS asks once; nothing grants these automatically.
3. Check it:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3211/health   # 204
   ```

The agent host also needs desktop control's host route: `HERMES_CUA_DRIVER_CMD` pointing at `relay/bin/deck-cua` in
the profile and a working `cua-driver` on the host (see [relay.md](relay.md#desktop-control)). Keep a single,
current CuaDriver installation: a newer command-line driver refuses to talk to an older running CuaDriver daemon, and
agent actions in the space then fail until the old daemon is stopped or updated.

## Turn it on in the relay

In the relay's `.env` on the agent host:

```bash
DECK_SPACES=shared                              # agents take turns on this machine's desktop
DECK_SPACESD_URL=http://127.0.0.1:3211          # default
DECK_SPACESD_TOKEN_FILE=~/.cua-spacesd/token    # default
```

Restart the relay. With `DECK_SPACES` set:
- an agent's desktop route defaults to the agent host, its space;
- a per-agent pin (**Work on this device**) moves it to a Deck device.

In Deck, **Settings → This device → Agent spaces** shows the mode and the **Default control** level.

The three enabled modes are `shared` (take turns on one desktop), `agent` (each agent's own desktop, shared as
fallback), and `overflow` (shared first, own desktop when another agent holds it). Pick `DECK_SPACES=overflow`
to use the shared desktop for light work and separate desktops when agents overlap; configure desktop hosts just
as for `agent` (see [Phase 2](#phase-2-one-desktop-per-agent)). If an own desktop is unavailable, the agent queues on shared with the reason.
An overflow session keeps its desktop until it has made no call, captures included, for `DECK_SPACES_STICKY_SEC`
seconds (default 120, clamped to 30–900). A sticky shared session still obeys the shared lock and waits if another
agent holds it. Device pins win. The default enabled mode remains `shared`; unset `DECK_SPACES` stays off.

In overflow mode, an agent's pill reads "On the shared desktop" while it holds the shared desktop or has a sticky
session there. Once neither applies, it returns to its own desktop's status. Start and Stop still control its own desktop.

## Undo operation routing

The internal space tunnel supports `snapshot`, `snapshots`, `restore` and `dropSnapshot` control operations.
The Deck checks local hosting consent and the profile before calling its desktop host. Snapshot replies contain
only projected metadata; container tokens, paths and ports stay on the host. Retention defaults to 10 points and
accepts integers from 1 to 100. Restore has a 900-second control timeout; the other snapshot operations, start and
stop have 300 seconds. A disconnected mutation fails without replay; a later listing can reconcile host state.

The relay persists actual desktop placement separately from the preferred home host, so undo operations can
reach the recorded host after a relay restart without starting a desktop. During restore, new resolves fall back.
A successful restore leaves the desktop off; a failed restore keeps the start barrier until a listing reports
neither an operation in progress nor recovery pending. The activity drawer exposes undo points through authenticated relay calls.

## Behaviour worth knowing

- **Turn-taking.** The first action takes the shared desktop. The agent keeps it while its turn runs, and for 90 s
  after its last action; the end of its turn releases it at once. Others queue in order, wait up to 120 s, then get a
  readable tool error naming the holder and their place in line.
- **Control levels.**
  - **Watch:** the video only.
  - **Together:** you get a separate cursor and can click and type; the agent continues.
  - **Full control:** the agents wait.
  - If Deck's view is gone for 30 s during **Full control**, control returns to the agents.
- **Stop.** Stop (in Deck or with the hotkey) frees the shared desktop at once.
- **Work on this device** needs desktop control on that device: a device key, **Desktop control** on and a window
  handed over ([features.md](features.md#desktop-control-bot-screen-tab)).
- **Cost.** Measured on an Apple M4: cua-spacesd uses about 65–70 MB idle and about 90 MB with roughly 8 % CPU while
  one Deck watches at 2560x1440. It streams only while someone watches.
- **Clipboard.** Deck opens the viewer without clipboard sync, so watching never reads the agent host's clipboard.

## Upgrade, rollback

- **Upgrade:** update the pin in `install-spacesd.sh` (or set `CUA_SPACESD_VERSION`, `CUA_SPACESD_URL` and
  `CUA_SPACESD_SHA256` together), then run it again. It replaces the app and keeps the token. A new signature may
  make macOS ask for the two permissions again.
- **Rollback:**

  ```bash
  sh relay/tools/install-spacesd.sh --uninstall
  ```

  Then remove `DECK_SPACES` from the relay `.env` and restart the relay. The Bot screen goes back to its
  device-first behaviour.

## Phase 2: one desktop per agent

Each agent gets its own Linux desktop in a Docker container, so agents no longer take turns. The shared desktop above stays as the fallback. The container image and its digest pin are in `app/main/desktops-pin.json`; the network isolation is described under "Limits and isolation" below.

### Requirements

- **A desktop host.** This is a machine that runs the containers. Either of these works, and both can host at the same time:
  - **A Deck computer** with Docker Desktop running.
  - **The agent host** with Docker or colima, hosting through the relay.
- **Docker must be running.** The relay checks it when it starts, so start Docker before the relay, and restart the relay if you start Docker later. If Docker is not running, the host offers no desktops and says why.
- **The pinned images.** The desktop image and a small helper image for the firewall rules are both pinned by digest in `app/main/desktops-pin.json`. The Deck pulls them after its consent sheet. The relay never pulls them: pull them yourself on the agent host (below).
- **RAM.** A desktop is limited to 1.5 GB (it idles at about 200 to 275 MiB). The agent host defaults to a limit of 1 desktop, and to 0 on a machine with less than 16 GB of RAM unless you set the limit yourself. Docker needs room for its own VM on top of that.
- **Disk.** The image is about 464 MiB. Each agent's home folder is a Docker volume that grows with use. The Deck warns past a size (default 10 GB); nothing caps it.

The probe measured the image on Docker Desktop (amd64) and colima (arm64, `vz` VM). A desktop starts in about 2.5 s cold and about 1.5 s warm.

### colima on the agent host

On a Mac or Linux agent host without Docker Desktop, use colima. A small VM is enough for one or two desktops:

```bash
colima start --cpu 2 --memory 4 --disk 30
docker version   # prints a Server section when it works
```

To keep colima's disk on another volume (for example an external drive), point `COLIMA_HOME` at it and use the `vz` VM type (`--vm-type vz` is macOS only). Set `COLIMA_HOME` for every later `colima` command, and in the relay's environment, so they all find the same VM:

```bash
export COLIMA_HOME=/path/to/other-volume/colima
colima start --vm-type vz --cpu 2 --memory 4 --disk 30
```

The relay talks to Docker through the `docker` command, so the Docker context that colima sets up must be the active one (`docker context ls`). If the relay runs as a service, give the service that environment.

### Turn it on

1. **Mode.** In the relay's `.env`, set `DECK_SPACES=agent` and restart the relay. The Deck can also switch between "Shared desktop" and "Own desktop per agent" in Settings > This device > Agent spaces, but that switch lives in the relay's memory only: at the next relay restart the mode is `DECK_SPACES` again. While no machine hosts desktops, the Deck says so and agents use the shared desktop.
2. **Hosting on the agent host.** Add to the relay's `.env`:

   ```bash
   DECK_DESKTOPS_HOST=1            # this machine also hosts agent desktops
   DECK_DESKTOPS_LIMIT=            # empty = 1, or 0 (with a warning) below 16 GB of RAM
   DECK_DESKTOPS_IDLE_MIN=20       # minutes without activity before a desktop stops (5 to 240)
   DECK_SPACES_SHARED_FALLBACK=1   # 1: an agent without a desktop uses the shared one; 0: it gets a tool error
   DECK_DESKTOPS_AGENTS=           # agents that may have a desktop, e.g. researcher,writer; empty = every configured agent
   ```

   `DECK_DESKTOPS_AGENTS` applies to every desktop host, the Deck computers included. An agent not on it never gets a container anywhere: it works on the shared desktop (or gets a tool error with the fallback off), and the Deck's Start button refuses it. The list lives in the relay's `.env` only; Settings has no switch for it.

   Pull the two pinned images, then restart the relay. Take the digests from `app/main/desktops-pin.json` (the doctor prints the full commands when an image is missing):

   ```bash
   docker pull ghcr.io/trycua/linux@sha256:<desktop digest>
   docker pull alpine@sha256:<helper digest>
   ```

3. **Hosting on a Deck computer.** Open Settings > This device > Agent desktops and turn on "Host agent desktops on this device". It is off by default, and a one-time consent sheet explains that agents get their own desktops there and that the image is downloaded once. The panel shows:
   - the Docker state with the next step (not installed, not running, pulling, ready);
   - the limit of desktops at once (default 3), memory (1.5 GB) and CPUs (2) per desktop, idle minutes (20) and the home folder warning;
   - the running desktops, each with Stop and Reset. Reset deletes that agent's home folder and asks first.

An agent's desktop starts on its first desktop call and stops when idle. If the first call lands while the desktop is still starting, the tool answers that it is starting and the agent retries. A locked screen does not stop a Deck computer from hosting: its desktops keep running and agents keep working while the user is away. Only sleep, quitting the Deck or a lost connection takes it off.

On an agent's own desktop only the MCP transport works. Keep `computer_use.permission_mode` at standard: `deck-cua serve`, `stop` and other verbs are refused (exit 126) without starting a desktop.

Every `docker` call has a time bound: 15 s for queries (version, inspect, ps, port, stats), 60 s for run, start, stop, rm, network changes and the isolation helper. `docker pull` has none (a big layer can be silent for minutes, and nothing waits on it). A call that runs over is killed and counts as failed, so a wedged Docker Desktop or colima makes a start fall back instead of hanging the relay or the Deck. The helper is named `hermes-deck-nethelper-<pid>-<n>` and removed when it times out; `docker rm -f $(docker ps -aq --filter name=hermes-deck-nethelper-)` removes any left behind. A container that keeps failing is retried twice, then the agent falls back and the Deck notifies; Settings shows no log for it, so look with `docker logs hermes-deck-space-<profile>` on its host.

### Home hosts

Each agent has a home host, set in Settings > This device > Agent spaces:

- **Automatic** (the default): the first available desktop host, preferring the agent host, then the Deck computer with the most room.
- **The agent host**, or **a named Deck computer.** A computer that is offline is shown dimmed.

A route resolves in this order: the agent's pin ("Work on this device"), its own desktop on its home host, the shared desktop, then a tool error. When the home host is offline or full, or the desktop fails to start, the agent works on the shared desktop and the Deck shows why ("Name is on the shared desktop: ..."). With `DECK_SPACES_SHARED_FALLBACK=0` it gets a tool error instead.

### Limits and isolation

- The limit counts running desktops per host. At the limit, an idle desktop is stopped to make room. If none is idle, the new agent falls back.
- The agent desktops run without `--privileged` and without added capabilities, with one mounted volume (their home) and no other host paths. Inside the container the image's supervisor (and one cua-spacesd process) runs as root; the desktop session and every app the agent launches run as the image's non-root user `cua`. The short-lived isolation helper (below) runs privileged.
- Their network reaches the internet but not the host, the LAN or the tailnet. The host applies firewall rules for this inside the Docker VM and checks them before every container start; if they are missing it starts nothing. The rules do not survive a Docker or VM restart, so the host applies them again the next time.
- **What the isolation helper does.** It is a throwaway container from the pinned `alpine` image, started with `--privileged --net=host` so it can edit the firewall of the Docker VM. Before each start it runs once to check the rules; only when that check fails does it run again to apply them and once more to check. Each run installs `iptables` with `apk add`. That needs internet access inside the Docker VM. The `iptables` package version is not pinned; `apk` verifies the package signatures with the keys that ship in the pinned image. Offline, the install fails, the check fails, and the host fails closed: no desktop starts until the helper can run again.

### The doctor

On the agent host, run:

```bash
node relay/tools/desktops-doctor.js
```

It reads the relay's `.env` and prints:

- the Docker (or colima) state, with the next step if it is missing or stopped;
- whether both pinned images are present, with the `docker pull` commands if not;
- the isolation state: rules in place, rules missing, or not set up yet (the network is created before the first desktop starts, so that one is only a note);
- total and free RAM against the limit, with the warning for machines under 16 GB;
- each agent desktop and whether it runs.

It exits 0 when the agent host can host desktops now and 1 otherwise. If `DECK_DESKTOPS_HOST` is not 1 it still exits 0 when the machine could host, and only prints a note that the relay will not. Every Docker call has a timeout (the relay's and the Deck's own: 15 s, 60 s for the isolation helper); a Docker that does not answer is reported as "not responding". The doctor is read-only: it pulls nothing, starts or stops no desktop and changes no rule. Its isolation check starts the same short-lived privileged helper described above, which installs `iptables` (so it needs internet in the Docker VM too) and then only checks the rules with `iptables -C`. If that install fails, the doctor reports the rules as missing, "or the helper could not install iptables (no internet?)".

### Roll back

1. **Back to the shared desktop only:** set `DECK_SPACES=shared` in the relay's `.env` and restart the relay. Agents use the shared desktop again.
2. **Stop hosting on a Deck computer:** turn off "Host agent desktops on this device".
3. **Stop hosting on the agent host:** set `DECK_DESKTOPS_HOST=0` and restart the relay. This leaves agent desktop containers that still run on the agent host untouched. Remove them yourself (next step).
4. **Remove every agent desktop container on a machine.** They all carry the label `hermes-deck.space=1`:

   ```bash
   docker ps -aq --filter label=hermes-deck.space=1 | xargs -r docker rm -f
   ```

   On Windows PowerShell:

   ```powershell
   docker ps -aq --filter label=hermes-deck.space=1 | ForEach-Object { docker rm -f $_ }
   ```

5. **Home folders stay** when the containers are removed, so an agent's files come back if you turn desktops on again. List them with `docker volume ls --filter name=hermes-deck-home-` and delete one with `docker volume rm hermes-deck-home-<agent>`. Without an existing undo point, that cannot be undone.
6. **The isolation network** `hermes-deck-desktops` can be removed with `docker network rm hermes-deck-desktops` once no desktop uses it. Its firewall rules disappear when the Docker VM restarts.

### End-to-end results (2026-10-07, side test)

The test setup, as in phase 1:

- **Relay:** the branch ran on the agent host as a second relay (own port, data and token) with `DECK_SPACES=agent`, `DECK_DESKTOPS_HOST=0` and the shared fallback on. Two agent profiles, both with the Deck computer as their home host.
- **Deck:** a development build with a separate profile, started through Explorer and connected through an SSH tunnel. It hosted the desktops on Docker Desktop (29.5, amd64): "Host agent desktops on this device" switched on through the consent sheet, limit 4, idle 5 min.
- **Agents:** simulated with the plugin's exact route query and `deck-cua mcp`, asking the relay before every action. Hermes itself was not changed or restarted.

The image has no gnome-calculator or galculator; `xcalc` is its calculator. It has no accessibility tree, so the result was read from the window screenshot. Typing into it needs `delivery_mode: "foreground"`; the driver's error says so, and an agent retries with it.

Results:

- **Two agents at once:** both opened `xcalc` and typed 6×7 at the same time. Both displays showed 42, and the relay listed two `ready` desktops on the Deck computer. From two stopped desktops the pair took 11.3 s, against 7.7 s for one agent alone, because the two starts share the isolation set-up (below). With both desktops running, the pair took 3.7 s and one agent alone 3.9 s.
- **Watch and control:** each pill showed its own desktop, over loopback on the hosting computer. Full control on one agent made its next call fail at once with "The user is controlling your desktop." The other agent's call ran and reached 42.
- **Fallback:** quitting the Deck stopped both containers, and the relay dropped the host. Both agents' next calls went to the shared desktop: the first took it, the second queued ("in use by …; you are 1st in line"). `/spaces` then showed both desktops off with the reason `offline`. With hosting switched off, the Deck showed "<agent> is on the shared desktop: the desktop host is offline".
- **Persistence and idle:** an agent wrote a file from a terminal in its desktop. The file survived the idle stop (5 min 9 s after the last action, with idle set to 5 min), the start at the next call, and a recreated container.
- **Isolation:** from inside a running desktop the internet answered (HTTPS 200). These were all refused:
  - the Deck computer's loopback services through `host.docker.internal` (the relay tunnel, the Deck's own ports);
  - the LAN gateway and the computer's LAN address;
  - a tailnet address of each machine;
  - the Docker VM's gateways.

  A throwaway container on Docker's default network reached every one of them.
- **Browser:** Chromium in the image starts and loads a page. The image's launcher adds `--no-sandbox` and `--disable-dev-shm-usage`; nothing was needed on our side.
- **Viewer through the relay:** a second viewer opened an agent desktop through the relay's `/spaces/<agent>/view/` path (relay, tunnel, Deck) and showed it live.
- **Shared desktop through the new Deck proxy:** it loaded and streamed. At Together the viewer's presence stream stayed open and its cursor updates went through.

Measurements (Docker Desktop on Windows; CPU in percent of one core):

| What | Value |
|---|---|
| Desktop RAM, idle | 200 to 315 MiB |
| Desktop CPU, idle, no viewer | about 1 to 2 % |
| Desktop CPU with on-screen motion (a terminal running `top`), no viewer | about 3 % |
| The same with one Deck watching (1280x800) | about 7.7 % (9 % peak) |
| Cold start, `docker run` to `/health` | 2.6 to 2.8 s |
| Warm start, `docker start` to `/health` | 1.5 to 1.7 s |
| Start through the relay and the Deck, stopped container | 4.5 to 4.9 s |
| Start through the relay and the Deck, new container | 5.9 to 6.2 s |
| An agent's first call until its route is ready (the plugin retries every 2 s) | 4.5 to 8 s |
| Image | 464 MiB download, 1.75 GB on disk; the pull was not timed (the image was already present) |

About 3.4 s of a start through the Deck was the isolation check: two helper runs, each installing `iptables` from the internet. Since then the check runs first and the rules are applied only when it fails, so a start with the rules in place costs one run (about 1.7 s).

Fixed during the test:

- **Viewer clipboard.** The viewer opened with `clipboard=0`, which only hides its clipboard button. At Together and Full it still polled the desktop's clipboard once a second, the shared desktop's included. It now opens with `clipboard=off`.
- **Desktop stats.** `docker stats` takes no `--filter` (Docker 29 refuses it), so Settings showed every running desktop at 0 MB and 0 % CPU. The host now names its desktops.
- **The agent-mode manifest.** The relay's `manifest` answer in agent mode did not meet Hermes' cua-driver contract: a semantic version of at least 0.20.0, and the `mcp`, `serve` and `stop` flags. Hermes' computer_use refuses to start with such a driver. The answer now reports the image's cua-driver version and those flags, and Hermes' own manifest reader accepts it.

Fixed after the test (unit-tested; not yet run against a live Deck):

- **Presence through the space tunnel.** The tunnel carried each viewer request as one buffered HTTP answer, so `PresenceService/Join` (a stream) ended with 504 after 30 s through the relay to a desktop on a Deck computer, and the Together cursor did not work there. Viewer requests now stream: the Deck sends the answer's head as soon as it has it, then its bytes in frames of at most 256 KB. A viewer that leaves aborts the request on the Deck, and nothing for 60 s ends it. MCP and `/health` stay buffered.
- **State after a Deck host quits.** `/spaces` kept listing its desktops as `ready` until an agent's next call. A Deck host missing from presence (gone, asleep, or its heartbeat stale; a locked one still hosts) for longer than the heartbeat staleness (30 s) now has its desktops shown as off, on the shared desktop because the host is offline. No stop is sent; when the host is back, the desktops still running are taken over again.
- **Idle time after a view.** The idle time counted from the agent's last action only, so a desktop watched for longer than the idle time stopped at the first sweep after the view closed. It now counts from the moment the last view or the user's control ended.

Open:

- **Not run:** a second Deck computer (the fallback notice was checked on the same Deck with hosting switched off), the agent host as a desktop host, and real Hermes agents.

## Activity and safety

For agents using their own desktops, the Activity and safety group under Agent spaces controls the relay's shared settings. Activity logging is on, typed-text recording is off, screenshots are on, retention is 7 days, risky-command approval is on, and 10 undo points are kept by default. A change here applies to Decks using the same relay. Audit retention accepts 1–90 days; undo count accepts 1–100 and remains subject to the 5 GB cap.

The activity drawer shows each tool call's time, tool, argument summary, outcome and duration. A typed-text entry normally records only its length. Opting in records the first 200 characters. Commands that trigger approval are recorded in full while logging is enabled. Screenshots come only from existing tool answers; opening the drawer never takes another screenshot. Frames can contain private information. Disable their recording when needed. Each agent keeps at most 300 frames or 200 MB, removing the oldest first; a timeline entry may outlive its frame.

Snapshot and desktop-stop notices (including idle stops) are recorded when the relay receives them, without an open activity drawer. Host reconciliation replays retained notices after reconnect, and retained audit records deduplicate them across relay restarts. Hidden Deck windows continue polling approval cards and badges every six seconds; the main process independently checks for desktop notifications, whose click opens the exact card. Drawer timestamps use the current Deck language, and denied retries display Denied or Reddedildi.

Audit data stays in the relay data directory and is served only to an authenticated Deck. Archives stay on the computer hosting that desktop. Log writes are buffered away from the tool path: storage failure pauses logging with one warning while the agent continues. After fixing storage, restart the relay to resume logging. An abrupt relay exit can lose records still in memory.

The terminal-command check is a warning gate, not a security boundary. The container's isolation is the boundary. GUI typing is checked in any application, so examples or prose containing risky commands can also request approval. Patterns cover sudo, login as another user, recursive removal, formatting, output-device copies, recursive world-writable permissions, downloads piped to shells/interpreters, package installation, shutdown/reboot and fork bombs. The last 500 successfully typed characters in a session are combined with the next typing action. Enter ends an ordinary command; shell continuations retain the tail for the next check. Custom patterns are administrator-supplied regular expressions, one per line in DECK_RISKY_PATTERNS_FILE; blank lines and lines beginning with # are ignored. Invalid or unsafe patterns are skipped with a line-number warning; valid patterns still load. Patterns longer than 200 characters and conservatively detected nested repetition or repeated alternatives are rejected. Custom matching uses overlapping windows of at most 1,000 characters per logical line, so long or unusually complex expressions may need rewriting. An unreadable configured file prevents startup. Patterns do not recognize every possible shell spelling or GUI action.

A risky action gets an immediate tool error and a card in Deck. The text has not been sent to the desktop. Review the full command and action text, then click Approve once or Deny. Enter does not approve. Requests belong to the agent profile and exact action text, including whitespace, and remain pending for 10 minutes even without Deck or after a driver disconnect. The same profile and text reuse one card across connections. Approval first takes an undo point, then grants one use within 10 minutes from any connection for that profile; the full command context must still match. It does not resend the action. Deny rejects the next identical attempt once. Relay restarts clear requests and grants. Pending cards are capped at 20 per profile and all entries at 200.

If the undo point fails or the home is above 2 GB, the card explains the failure and offers Approve anyway or Deny. Ordinary Approve once retries cannot silently bypass this. Approve anyway is explicit consent to continue without an undo point. There is no permanent approval option. For approval requests, commands and action text above 2,000 characters, or arguments above 8 KiB, are refused. Approval storage is bounded at 200 entries overall and 20 pending requests per profile; excess requests fail without sending the text.

Undo points appear in the timeline with their reason and size; unfinished or deleting archives are omitted from rows and displayed totals while still counting toward the internal quota. Listing points during a desktop start or stop does not block that lifecycle operation. An agent that has never hosted a desktop has an empty list. They are taken at stop (including idle and hosting off), before an approved risky action and before undo. An ordinary clean start is not delayed. After an unclean stop, a point is attempted before the next start; quitting through the detached stop path is recovered this way. Idle timing and viewer/user-control rules remain unchanged.

Archives use the pinned helper with no network, a read-only home mount and a pause around the archive when the desktop is running. If the host explicitly reports that pause is unsupported, the point is labeled as potentially inconsistent. Other pause errors fail the point; an archive failure still attempts unpause. A failed unpause triggers a stop attempt and is reported as failure. A home above 2 GB is skipped with a visible notice. Archives are pruned oldest first to the configured count and a 5 GB ceiling per agent. MB and GB here use decimal bytes. Protected recovery points can temporarily exceed the count; failure to enforce the byte ceiling fails the operation. The source and before-undo point are temporarily protected during restore; the before-undo recovery point stays protected after failure.

Return to this point opens a confirmation sheet. Restore stops the desktop, prepares the chosen archive in a separate volume, takes a before-undo point, replaces the home contents and leaves the desktop off. Failure before replacement leaves the home intact; failure during replacement attempts rollback and retains the before-undo archive. An uncertain restore blocks automatic starts until a successful restore resolves it. If its Deck host disconnects, the operation is reported failed; reconnect and refresh the list before retrying. A failed operation is never reported as a successful restore.

Reset deletes the current home but keeps undo points. Delete undo points is a separate confirmed action in Settings. Settings shows their disk use per agent, including stopped desktops. Points belong to the last actual desktop host; changing the preferred home host does not copy archives to another computer. After a Deck host restarts, a crash point taken before its first relay poll may use that Deck's cached retention count. Later polling and undo operations synchronize the relay setting; ensure-time policy synchronization remains deferred.

### Settings and environment

Settings > This device > Agent spaces > Activity and safety edits the shared relay settings. The API fields are
`audit` (Activity log), `typedText` (Record typed text), `screenshots` (Record screenshots), `days` (Keep for),
`approvals` (Ask before risky terminal commands) and `snapshotKeep` (Undo points to keep). The four switches
accept booleans; `days` accepts integers 1–90 and `snapshotKeep` integers 1–100. Unknown fields are rejected.
Settings persist in `space-settings.json` in the relay data directory. Turning logging off does not erase retained
records or undo points; turning approvals off lets risky typing proceed without this gate or its pre-command point.

`DECK_AUDIT=0` forces logging off even if Deck requests it; `1` allows the saved setting to apply.
`DECK_AUDIT_DAYS` seeds retention (default 7; finite numeric values are truncated and clamped to 1–90).
`DECK_SNAPSHOT_KEEP` seeds the undo count (default 10; invalid values fall back to 10).
Persisted settings override these two initial defaults. `DECK_RISKY_PATTERNS_FILE` names the optional administrator
pattern file described above; empty uses only the built-in patterns. Environment changes require a relay restart.
The settings response also exposes read-only `auditLocked` and `loggingPaused` flags.

### Relay safety API

These endpoints require `Authorization: Bearer <relay-token>`, including reads. The legacy query-token option
does not authenticate safety requests. Deck keeps the token in its main process. Safety services must be enabled
through an agent-spaces mode; unavailable services return 503. `<profile>` is a configured agent profile.

| Method and endpoint | Request and response |
|---|---|
| `GET /spaces/<profile>/audit?before=&limit=` | Newest-first `{records, next}`. Omit `before` for the first page; pass `next` unchanged for the next. `limit` defaults to 50 and accepts integers 1–100. |
| `GET /spaces/<profile>/audit/frame/<id>` | Image bytes with their MIME type and `Cache-Control: no-store`; unavailable or expired frames return 404. |
| `GET /spaces/approvals` | `{approvals}` across agents, including pending, snapshotting and snapshot-failed cards. |
| `POST /spaces/approvals/<id>` | JSON `{"choice":"once"}` or `{"choice":"deny"}`. After a snapshot failure only, `{"choice":"once","withoutSnapshot":true}` means Approve anyway. Inspect the returned `state`: HTTP 200 can mean `snapshot-failed`, not permission to retry yet. Unavailable answers return 409. |
| `GET /spaces/<profile>/snapshots` | Undo metadata: `points` with `id`, `time`, `reason`, `size`, `consistent`; plus `totalBytes`, `host`, `busy`, `recovery` and notices. No archive paths, container ports or tokens. |
| `POST /spaces/<profile>/restore` | JSON `{"id":"<point-id>"}` after user confirmation. Ends existing space sessions and restores on the recorded host; success leaves the desktop off. |
| `POST /spaces/<profile>/snapshots/delete` | JSON `{}` after confirmation; deletes that agent's undo points, keeping the current home. A protected recovery point cannot be deleted while recovery is pending. |
| `GET /spaces/settings` | `{settings}` with effective values and the two read-only flags. |
| `POST /spaces/settings` | JSON containing only changed writable fields; returns `{ok, settings}`. |

Invalid bodies, settings and cursors return 400; unknown agents return 404; unsupported methods return 405.
Snapshot operations can report failure in their JSON result, so check `ok` as well as HTTP status. A disconnected
mutation is not replayed. Reconnect, refresh state and explicitly retry if appropriate. Frames and approval text
can contain private content; authentication does not redact that content.

## Hermes foreground approvals on an isolated desktop

No exact Hermes approval setting was verified from the material in this repository; Hermes source was unavailable for this task. This guide therefore gives no setting name or command to disable foreground approvals, and cannot confirm a per-route switch. Hermes may ask separately for foreground action approval. For an agent restricted to its own isolated desktop, relaxing repetitive foreground prompts can reduce interruptions, but removes Hermes' separate action-level consent. A user can evaluate the installed Hermes version's documented approval controls and choose whether to relax those prompts for the intended scope. Do not apply a broad relaxation to shared or user-device routes. Keep the currently supported routing configuration until the scope and compatibility of any change have been verified. Deck's narrow risky-typing gate remains separate from Hermes' approvals.

## Phase 3a verification

Automated coverage uses fake Docker, fake MCP answers and fake DOM. It covers split typing, one-shot approval/expiry/denial, audit masking/retention/caps, archive pause cleanup, restore failure/rollback, tunnel disconnect, authenticated endpoints and panel/settings behavior.

Automated verification is incomplete: the Windows full-suite run on 2026-10-07 reported updater and Chrome failures,
and new panel review regressions were still failing. Passing fake-host checks do not establish a successful physical
restore. Panel and settings review fixes remain pending at this checkpoint.

Real-agent side test: not run by this implementation plan's automated steps. It requires a separately authorized test desktop and visible review. The future observation is: an agent requests a harmless command beginning with sudo; Deck shows its exact card; approve once; the identical retry passes once; an undo point is listed; create a disposable file change; confirm restore; the earlier home content returns and the desktop stays off until the next agent call. Record actual observations separately and do not infer a successful physical restore from fake-runner tests. Docker Desktop and colima pause support also remain runtime checks.

Türkçe: Etkinlik ve güvenlik ayarları relay üzerinde ortaktır. Yazılan metin varsayılan olarak yalnızca uzunluğuyla kaydedilir; onay isteyen komutlar, kayıt açıkken tam saklanır. Ekran görüntülerini kapatabilirsiniz. Riskli komut kontrolü bir uyarı kapısıdır; güvenlik sınırı konteyner izolasyonudur. Onay yalnızca aynı eylemin bir tekrarına ve 10 dakikaya izin verir. Geri dönüş noktası alınamazsa Yine de onayla veya Reddet seçenekleri sunulur. Geri yükleme masaüstünü kapalı bırakır ve geri alma öncesi noktayı korur. Başarısız veya belirsiz geri yüklemeden sonra otomatik başlatma engellenir; başarılı bir geri yükleme ile çözülür. Bu depoda Hermes onaylarını gevşeten kesin bir ayar doğrulanmadı; bu nedenle ayar adı önerilmiyor. Gerçek agent testi ve fiziksel Docker doğrulaması henüz yapılmadı.
