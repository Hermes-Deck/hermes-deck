# Security notes

How Hermes Deck handles credentials, data and device permissions. To report a vulnerability, see
[SECURITY.md](../SECURITY.md). The trust boundaries in detail: [architecture.md](architecture.md#trust-boundaries).

## Credentials and network

- A Telegram session grants access to your account. Deck keeps its session string in the main process and stores it
  as `tg.session.enc` using Electron `safeStorage`; saving a session fails when encryption is unavailable. Use
  **Settings → Telegram → Log out of Telegram** to revoke it remotely and clear the local session.
- Other secrets (relay token, Telegram API hash, device key, GitHub token) use `safeStorage` when available. Settings
  falls back to plain storage with a warning when it is not; Linux's `basic_text` backend is also flagged as weak.
  The renderer only learns whether each secret is set.
- The relay's shared token grants fleet, session and history access for every agent, not just one. Bind
  `DECK_RELAY_HOST` to loopback or a private network; never expose the relay publicly. `/health` is unauthenticated
  and returns only version, uptime and counts. Data routes and the Deck WebSocket require the token; URL-token
  support is opt-in (`DECK_RELAY_QUERY_TOKEN`) and should stay off.
- Device keys are separate from the shared relay token. The relay stores only their hashes (`relay/devices.json` by
  default); revoking one cuts the device's driver channel within 15 seconds. Protect both the key and the app's data
  directory.
- iOS devices use their own hashed mobile tokens, issued through single-use pairing codes and revocable with
  `node tools/mobile-token.js revoke <deviceId>`. Mobile tokens reach only a subset of relay routes.
- The direct Hermes connection uses private Unix sockets (mode 0600) on the host, with SSH as the remote boundary.
  Deck starts SSH non-interactively: prepare key login and verify the host key outside Deck before connecting. An
  `authorized_keys` line with `restrict,command="..."` can limit that key to `stream.py`.

## Telegram and files

Deck shows bot DMs and the topics of one selected forum group. It also supports explicit user actions such as
sending messages and files, topic management, reactions and inline buttons. Telegram connects directly from the app,
not through the relay.

Read receipts are on by default, and are sent only for messages you actually looked at with the window focused. Turn
off **Send read receipts to Telegram** in **Settings → Telegram** to keep Deck's reads local. Read updates from other
clients still clear Deck's unread badges.

Telegram media downloads are capped at 25 MB. The main process refuses to open known executable and script
extensions; those files can still be saved. This is an extension check, not malware scanning. Direct-Hermes
attachments are limited to 10 files, 25 MB each and 50 MB per message, enforced in both app and plugin. Sending an
attachment, a window capture or a dictation clip shares it with your Hermes host and potentially its model provider.

## Device permissions

Agent-browser hosting and desktop hosting are independent local switches, off on new devices. The relay cannot enable
them remotely.

- **Agent browser:** Deck-managed browsers use separate profiles, never your personal browser profile. A host
  configured with an external CDP browser is different: agents can use that browser's existing logged-in sites.
  **Transfer browser** requires consent on the source device and sends tabs, cookies and storage (encrypted for the
  target device) to the destination.
- **Take control (browser):** the CDP guard blocks input, navigation and tab commands, but not page scripts or an
  agent's shell access on the host. It is not a security sandbox against that agent.
- **Desktop control:** device routing requires a device key, an allowed agent and an explicit window grant. Background
  input is the default. **Foreground control for this session** separately lets the selected window use your
  physical mouse and keyboard for that grant.
- **Stop (desktop):** ends local driver work and pauses hosting even if the relay is offline. A granted window's
  visible contents and captures can reach the agent's model provider. See [the protocol](bot-screen-protocol.md) for
  the grant and fences.
- **Agent spaces:** the viewer of the agent host's desktop runs in an isolated view with no permissions and no
  clipboard sync; the space's token stays on the agent host and the relay adds it.

Relay and plugin previews redact common secret patterns and clip event previews to 300 characters. History endpoints
can return longer messages and tool calls. Redaction is best effort, not a guarantee that secrets are absent.

## App boundary

Every Deck window and view is sandboxed, has context isolation and no Node integration; the main window uses a
restrictive CSP. External links open only for HTTP(S). Main-process IPC accepts calls only from Deck's own page.
Release builds enable Electron fuses that disable `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`, require the
app to load from its ASAR archive with integrity validation, and encrypt cookies. These boundaries do not protect
against a compromised OS account or an agent already granted shell access to that account.

Windows release builds are unsigned; macOS builds use an ad-hoc signature without notarization. Verify downloads
against the release's `SHA256SUMS.txt`; a checksum only shows that the file matches the published list, so also check
the release's build provenance attestation (`gh attestation verify <file> --repo Hermes-Deck/hermes-deck`).
