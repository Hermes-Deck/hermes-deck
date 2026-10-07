#!/bin/sh
# Installs cua-spacesd on the agent host (macOS) for Hermes Deck agent spaces (docs/agent-spaces.md).
#   - pinned release, checked twice: SHA-256 of the download, then the app's Developer ID team
#   - loopback only, QUIC off, token file 0600, state in ~/.cua-spacesd
#   - a LaunchAgent in the logged-in GUI session (a LaunchDaemon or `launchctl asuser` over SSH cannot capture)
# Screen Recording and Accessibility for "Cua Spacesd" are granted by the user in System Settings afterwards.
#
# Usage: install-spacesd.sh [--dry-run | --uninstall]
# Override the pin only together: CUA_SPACESD_VERSION, CUA_SPACESD_URL, CUA_SPACESD_SHA256.
set -eu

VERSION="${CUA_SPACESD_VERSION:-0.5.3}"
URL="${CUA_SPACESD_URL:-https://github.com/trycua/cua/releases/download/cua-spacesd-v0.5.3/cua-spacesd-macos-universal.app.zip}"
SHA256="${CUA_SPACESD_SHA256:-a7072febe8333324c51344ec2c7aafa82c85325be8826d9460b8629b0f732476}"
TEAM="YCK386LBJ7" # Cua AI, Inc. (Developer ID Application)
PORT="${CUA_SPACESD_PORT:-3211}"

DIR="$HOME/.cua-spacesd"
APP="$DIR/Cua Spacesd.app"
LABEL="ai.hermes-deck.spacesd"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
MODE="${1:-}"

say() { printf '%s\n' "$*"; }
run() { if [ "$MODE" = "--dry-run" ]; then say "would: $*"; else "$@"; fi; }

[ "$(uname -s)" = "Darwin" ] || { say "install-spacesd: macOS only (phase 1 agent host)"; exit 1; }

if [ "$MODE" = "--uninstall" ]; then
  launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  say "cua-spacesd stopped and its LaunchAgent removed; $DIR is left in place (token, data). Remove DECK_SPACES from the relay .env."
  exit 0
fi

umask 077
run mkdir -p "$DIR/data"
if [ "$MODE" = "--dry-run" ]; then
  say "would: download $URL, check SHA-256 $SHA256, unpack to $APP, check team $TEAM, make $DIR/token (0600)"
else
  tmp="$DIR/download.zip"
  curl -fsSL -o "$tmp" "$URL"
  echo "$SHA256  $tmp" | shasum -a 256 -c - >/dev/null || { rm -f "$tmp"; say "install-spacesd: SHA-256 mismatch, nothing installed"; exit 1; }
  rm -rf "$DIR/unpack" && mkdir "$DIR/unpack"
  ditto -x -k "$tmp" "$DIR/unpack"
  new="$(find "$DIR/unpack" -maxdepth 1 -name '*.app' | head -1)"
  [ -n "$new" ] || { say "install-spacesd: no .app in the download"; exit 1; }
  codesign --verify --deep --strict "$new"
  codesign -dv "$new" 2>&1 | grep -q "^TeamIdentifier=$TEAM\$" || { say "install-spacesd: not signed by team $TEAM, nothing installed"; exit 1; }
  launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true # an upgrade replaces a running copy
  rm -rf "$APP" && mv "$new" "$APP"
  rm -rf "$DIR/unpack" "$tmp"
  [ -s "$DIR/token" ] || openssl rand -hex 32 > "$DIR/token"
  chmod 600 "$DIR/token"
fi

plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$APP/Contents/MacOS/cua-spacesd</string>
    <string>--listen</string><string>127.0.0.1:$PORT</string>
    <string>--quic-port</string><string>0</string>
    <string>--token-file</string><string>$DIR/token</string>
    <string>--data-dir</string><string>$DIR/data</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>$DIR/spacesd.log</string>
  <key>StandardErrorPath</key><string>$DIR/spacesd.log</string>
</dict></plist>
EOF
}

if [ "$MODE" = "--dry-run" ]; then
  say "would write $PLIST:"
  plist
else
  mkdir -p "$(dirname "$PLIST")"
  plist > "$PLIST"
fi
run launchctl bootstrap "$DOMAIN" "$PLIST"
if [ "$MODE" != "--dry-run" ]; then
  # /health answers without a token, so it cannot tell this copy from another one on the port: ask with the token
  sleep 3
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $(cat "$DIR/token")" -H 'content-type: application/json'     -H 'accept: application/json, text/event-stream'     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"install-spacesd","version":"1"}}}'     "http://127.0.0.1:$PORT/mcp" || true)"
  if [ "$code" != "200" ]; then
    say "install-spacesd: the daemon on 127.0.0.1:$PORT did not accept this install's token (HTTP $code)."
    say "Another program may hold the port: lsof -nP -iTCP:$PORT -sTCP:LISTEN"
    exit 1
  fi
fi
say "cua-spacesd $VERSION on 127.0.0.1:$PORT. Next: grant Screen Recording and Accessibility to \"Cua Spacesd\" in System Settings,"
say "then check: curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:$PORT/health   (expect 204)"
