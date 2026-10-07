#!/usr/bin/env bash
# Installs (or reinstalls) the Hermes Deck relay as a per-user launchd agent on macOS.
#   bash install/macos.sh            # from the relay/ directory
# Re-running is safe: it keeps your .env, agents.json and data/.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$(pwd)"
LABEL="${DECK_RELAY_LABEL:-com.hermes-deck.relay}"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found (install Node.js 20+)"; exit 1; }

if [ ! -f .env ]; then
  umask 077
  sed "s/^DECK_RELAY_TOKEN=.*/DECK_RELAY_TOKEN=$(openssl rand -hex 32)/" .env.example > .env
  echo "Created .env with a fresh token. Set DECK_RELAY_HOST to this machine's private (e.g. Tailscale) IP, then re-run."
  exit 0
fi
[ -f agents.json ] || { cp agents.example.json agents.json; echo "Created agents.json from the example; edit it to name your agents."; }

npm install --omit=dev --no-audit --no-fund
mkdir -p logs data

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s#__LABEL__#$LABEL#g" -e "s#__NODE__#$NODE#g" -e "s#__DIR__#$DIR#g" -e "s#__PATH__#$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin#g" \
  install/launchd.plist.template > "$PLIST"
plutil -lint "$PLIST" >/dev/null

UID_="$(id -u)"
launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null || true
# a bootstrap right after bootout can fail with "Input/output error"; retry briefly
for i in 1 2 3 4 5; do
  if launchctl bootstrap "gui/$UID_" "$PLIST" 2>/dev/null; then break; fi
  sleep 3
done
sleep 3
if launchctl print "gui/$UID_/$LABEL" | grep -q "state = running"; then
  echo "Relay running as $LABEL. Logs: $DIR/logs/relay.log"
  tail -1 "$DIR/logs/relay.log" || true
else
  echo "Relay did not start; see $DIR/logs/relay.log"
  exit 1
fi
