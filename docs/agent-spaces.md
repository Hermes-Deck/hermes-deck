# Agent spaces

Agents that use `computer_use` can work on their own desktop, a **space**, instead of yours. The current version has
one shared space: the agent host's logged-in macOS desktop. Agents take turns on it. Deck shows it live in the **Bot
screen** tab, where you can watch, join in or take full control. One click moves an agent to the device where Deck
is open (**Work on this device**), and another sends it back (**Send back to its space**).

Status: experimental. One desktop per agent (`DECK_SPACES=agent`) is not implemented yet; Deck shows it as **Coming
in phase 2**.

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
