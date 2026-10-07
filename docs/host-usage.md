# Host-wide usage and subscription limits

The relay reads `<HERMES_ROOT>/state.db` and every `<HERMES_ROOT>/profiles/<profile>/state.db` without ever creating files next to them. `HERMES_ROOT` defaults to the relay user's `~/.hermes`. This works independently of which CLI, TUI, dashboard, desktop, WebUI, gateway or worker loaded the Deck plugin. Profile entries in `agents.json` are optional for accounting; otherwise the profile name becomes the agent label.

## Accounting contract

- Refresh at startup and every 60 seconds. Database queries select only numeric counters and model/provider metadata, in one read transaction with `query_only` on.
- How a store is opened (`relay/src/usage.js`, `plan()`): a live WAL store (both `-wal` and `-shm` present, Hermes running) is opened read-only in place; a store with no `-wal` and no `-journal` (Hermes stopped) is opened `immutable`; anything else (a stale `-wal` without `-shm`, a hot journal), or a busy store, is read from a bounded private copy. The copy takes `state.db` and its WAL into a private temporary directory, rejects changed source identities, sizes or timestamps, and is removed after reading. A combined size above 512 MiB, or a writer racing the copy, leaves that profile unavailable/stale instead of copying without bounds.
- `sessions` is authoritative. Day and model attribution follow the session's `started_at` (relay-local day) and stored model, as in Hermes analytics. A session spanning midnight stays on its start day. Historical switches within one session cannot be reconstructed from cumulative session counters.
- Auxiliary rows (`session_model_usage.task != ''`) are added separately because Hermes does not add them to session counters. Ordinary per-model rows are **not** added again.
- Token volume is input + cache read + cache write + output; reasoning is a subset of output, not extra volume.
- Cost chooses a finite nonnegative `actual_cost_usd`, including zero, else `estimated_cost_usd`. Estimates carry `estimated: true`; missing costs carry `unknownCost` and are shown as unknown, never silently interpreted as free.
- Claude subscription DirectSDK costs are labeled **API list-price equivalent**, not a subscription invoice or extra-usage bill. The UI uses `≈` for estimated amounts. API/list-price cost is distinct from subscription quota percentages.
- Hermes NDJSON events drive in-flight sessions only; they never add to canonical totals or the checkpoint's canonical accounting. External Claude Code transcript usage remains its separate legacy source.
- Full bounded (400-day) counter scans are deliberate: `last_activity_at` is not a reliable token-update watermark, and repair can change or decrease counters. The reader does not scan transcript/message tables. Failed profiles retain their last successful rollup and expose coarse stale/error status in `fleet.usage.profiles`.
- Token pane ranges (`GET /tokens?range=24h|7d|14d|30d|all`): `24h` is a rolling window over 5-minute slots of session start (sessions started in the last 48 h); `7d`/`14d`/`30d` are local days including today; `all` adds a month aggregate of sessions older than the 400-day bound, rebuilt at most every 6 hours, and reports the oldest session start as `since`. The minute scan stays bounded; the oldest start is one indexed `MIN(started_at)`. Legacy `?days=N` keeps its array answer.

## Subscription limits

The gateway's Deck plugin discovers providers in that profile's config (including delegation/fallback/auxiliary config): `claude-subscription-directsdk-experimental` / `anthropic` maps to Hermes `fetch_account_usage('anthropic')`; `openai-codex` maps to Hermes `fetch_account_usage('openai-codex')`.

A nonblocking background cache fetches roughly every 300 seconds, with a 25-second wall-clock deadline and exponential failure backoff capped at 30 minutes. One stuck worker per provider stays tracked, preventing thread pileups. Hooks never wait on quota/network work. Only session/week percentages, reset times and coarse freshness/error metadata enter `state/<profile>.json`; no account identities, raw response, auth tokens or config are published. The gateway's own Hermes environment supplies `httpx` and YAML dependencies.

If CodexBar is absent, the relay uses state-file quotas. Per-profile windows remain available separately and are never summed across accounts. Old snapshots/windows show a stale marker. CodexBar remains supported on macOS.

Cost hooks emit delta events when native per-call cost is present. Current Hermes sanitizes away `raw_usage` from public API-hook summaries, so the gateway background loop also emits read-only persisted session costs as `mode: 'absolute'`; the relay treats these as display-only snapshots, not another incremental billing source.

## Setup

1. Run the relay as a user that can read every intended profile's `state.db`, and set `HERMES_ROOT` to their shared
   root if it is not `~/.hermes`. Do not copy databases or grant Deck write access.
2. Install the plugin (dry run first) in the profiles whose gateway should publish quotas. Restart a gateway only after
   its foreground and background work has finished. CLI-only processes never poll quotas.
3. Check `/tokens` and `/fleet` on the relay (with the token), then the **Fleet** and **Token** tabs in Deck. The
   first quota values arrive with the next snapshot cycle; token totals do not depend on quotas or the plugin.

For UI work without a relay, use the fixture `app/test/fixtures/usage.json`
([development.md](development.md#fixtures-and-capture-tools)). Never point screenshot mode at a live relay.
