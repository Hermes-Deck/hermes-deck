# Security policy

## Supported versions

Security fixes go into the latest minor release line only. Update to the newest release before reporting, and
check that the issue still reproduces there.

| Version | Supported |
|---|---|
| Latest minor release (`x.Y.*`) | Yes |
| Anything older | No |

The desktop app, relay and Hermes plugin share one product version. Run the same version of each part; see
[docs/compatibility.md](docs/compatibility.md).

## Reporting a vulnerability

Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**
(GitHub private vulnerability reporting / Security Advisories). Do not open a public issue, pull request or
discussion for a vulnerability.

Include the affected component (app, relay, plugin), the version, your OS, the connection
mode (SSH, WSL or local; relay or not) and the steps to reproduce. Remove real tokens, chat content, host names and
account identifiers from logs and screenshots; synthetic values are enough.

Maintainers acknowledge reports through the advisory, agree on a fix and a disclosure date with the reporter, and
credit the reporter in the advisory unless asked not to.

## Threat model in short

Hermes Deck connects your desktop to Hermes agents that you run on your own host. The design assumes:

- **The relay is private.** It speaks plain `ws://` and `http://` and must listen only on loopback or a private
  network (for example Tailscale or WireGuard). Its single shared token is a full-access password: whoever holds it
  can read every agent's sessions, previews, history and tool calls. Never expose the relay to the internet.
- **Agents and the pages they load are untrusted** where they reach your devices. Agent-browser hosting and desktop
  control are off on every new device, can only be switched on locally, and are fenced: browser CDP commands are
  filtered on the device, and desktop control is limited to one window you hand over (see
  [docs/bot-screen-protocol.md](docs/bot-screen-protocol.md)).
- **Secrets stay in the main process.** Tokens and the Telegram session are stored with Electron `safeStorage`; the
  renderer only learns whether a secret is set. The renderer is sandboxed, has no Node access and a strict CSP, and
  main-process IPC accepts calls only from Deck's own page.
- **Your own OS account is trusted.** None of this protects against a compromised OS account, or against an agent you
  already gave shell access to the machine it runs on.
- **Release builds are unsigned.** Verify downloads against the release's `SHA256SUMS.txt`. A checksum proves the file
  matches the release, not who built it.

More detail: [docs/security.md](docs/security.md) and the trust-boundary section of
[docs/architecture.md](docs/architecture.md#trust-boundaries).

## Hardening history

Fixed in the internal security review of October 2026 (before the public release):

- **CDP guard bypass (high):** wrapped legacy sub-target commands could slip past the agent-browser guard; the guard now
  refuses `Target.sendMessageToTarget` and requires flat sessions.
- **Silent browser permission grants (medium):** `Browser.grantPermissions` / `Browser.setPermission` are now refused on
  devices.
- **Relay token in URLs:** the `?token=` query form is off unless `DECK_RELAY_QUERY_TOKEN=1`.
- **IPC sender checks:** every main-window IPC channel now accepts only Deck's own top-level page.
- **Redaction:** preview/history redaction also covers PEM keys, AWS key ids, Google API keys, JWTs and URL passwords
  (still best effort).
- **Telegram library:** moved from the archived GramJS package to the maintained `teleproto`; this also removed a
  transitive install script.
- **Packaging:** ASAR integrity validation and cookie encryption fuses are enabled.
- **Risky file types:** the renderer and main process use one list of extensions that are never opened directly.
- **Weak secret storage:** Settings now warns when secrets are stored without OS encryption, including Linux's
  `basic_text` backend.

Accepted by design: large authenticated WebSocket frames (needed for tunnelled CDP and screenshots, behind the private
relay token), and the relay-host fallback browser having no CDP guard (it runs in the agent's own trust domain).
