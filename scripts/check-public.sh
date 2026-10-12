#!/usr/bin/env bash
# Check versioned files only; dependencies, private config and generated output stay ignored.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
python3 - <<'PY'
import pathlib
import re
import subprocess
import sys

patterns = re.compile(r'/root/|/srv/|192\.168\.|@gmail\.com|\.local\b')
# Narrow, reviewed exceptions to synthetic fixtures and generic platform paths.
# Add exceptions only with a reason; never exempt a whole source tree.
allowlist = [
    # The per-user command directory ~/.local/bin (XDG), where Hermes installs the hermes command; not a hostname.
    ('relay/src/index.js', re.compile(r'(?<=")\.local(?=", "bin", "hermes")')),
    ('relay/test/host-version.test.js', re.compile(r'(?<=")\.local(?=", "bin", "hermes")')),
    ('docs/relay.md', re.compile(r'(?<=~/)\.local(?=/bin/hermes\b)')),
    ('relay/.env.example', re.compile(r'(?<=~/)\.local(?=/bin/hermes\b)')),
    # The default install root deck-relay-update adopt creates under the per-user data directory (XDG); not a hostname.
    ('relay/tools/update.js', re.compile(r'(?<=")\.local(?=", "share", "hermes-deck-relay")|(?<=~/)\.local(?=/share/hermes-deck-relay\b)')),
    ('relay/test/update.test.js', re.compile(r'(?<=")\.local(?=", "share", "hermes-deck-relay")|(?<=/home/u/)\.local(?=/share/hermes-deck-relay\b)')),
    ('docs/updating.md', re.compile(r'(?<=~/)\.local(?=/share/hermes-deck-relay\b)')),
    ('CHANGELOG.md', re.compile(r'(?<=~/)\.local(?=/share/hermes-deck-relay\b)')),
    # Detector definitions describe forbidden prefixes, not an infrastructure location.
    ('scripts/check-public.sh', re.compile(r'/root/(?=\|)|/srv/(?=\|)|(?<=command directory ~/)\.local(?=/bin \(XDG\), where Hermes installs the hermes command; not a hostname\.$)')),
    # Local properties and the legacy filename are not private hostnames.
    ('app/main/settings.js', re.compile(r'(?<=deck)\.local(?=\.json)')),
    ('app/test/browser-transfer-e2e.test.js', re.compile(r'\.local(?=\.push\()')),
    ('app/test/launch-context.test.js', re.compile(r'(?<=w)\.local(?=[, }])')),
    ('app/test/readsync.test.js', re.compile(r'(?<=\.\.)\.local\b')),
    # Generic mDNS suffix-stripping code must recognize the local hostname suffix.
    ('app/main/presence.js', re.compile(r'\.local(?=\$)')),
    ('relay/src/browser.js', re.compile(r'\.local(?=["$])')),
    # Synthetic host-validation fixture (not a maintainer's host).
    ('app/test/bridge.test.js', re.compile(r'(?<=me@box)\.local(?=")')),
    # Synthetic absolute paths used in attachment, transfer and launch regression tests.
    ('app/scripts/appshots-e2e.js', re.compile(r'/srv/example/')),
    ('app/test/bridge.test.js', re.compile(r'/srv/(?:hermes/|stream\.py)')),
    ('app/test/fake-stream.js', re.compile(r'/srv/example/')),
    ('app/test/hermes-uploads.test.js', re.compile(r'/srv/example/')),
    ('app/test/subagents.test.js', re.compile(r'/srv/example/')),
    ('app/test/work-pane.test.js', re.compile(r'/srv/example/')),
    ('app/test/voice-files.test.js', re.compile(r'/srv/(?:out(?:/|\b)|example/|hermes/|other/|ok\b|\.\./)')),
    ('hermes-plugin/hermes-deck/test_appshot.py', re.compile(r'/srv/example/')),
    ('hermes-plugin/hermes-deck/test_attach.py', re.compile(r'/srv/example(?:/|["\'])')),
    ('hermes-plugin/hermes-deck/test_attach_staged.py', re.compile(r'/srv/example/')),
    ('hermes-plugin/hermes-deck/test_voice_files.py', re.compile(r'/srv/example-home\b')),
    ('relay/test/mobile.test.js', re.compile(r'/srv/(?:stream\.py|photo\.png|(?=[\'\"]))')),
    ('relay/test/uploads.test.js', re.compile(r'/srv/example/')),
    # Root-home fixtures exercise redaction and refusal of SSH private keys; no account data.
    ('app/test/media-preview.test.js', re.compile(r'/root/\.hermes/attachments\b')),
    ('hermes-plugin/hermes-deck/test_voice_files.py', re.compile(r'/root/\.ssh/id_rsa\b')),
    # The agent host's own desktop host object (a property named local), not a hostname.
    ('relay/src/desktops.js', re.compile(r'(?<=this)\.local\b')),
    ('relay/src/spaces.js', re.compile(r'(?:(?<=this)|(?<=\bo))\.local\b')),
    ('relay/test/desktops.test.js', re.compile(r'(?<=\br)\.local\b')),
    # Agent desktop isolation rejects the whole private range; no address of a real network.
    ('app/main/desktop-host.js', re.compile(r'192\.168\.(?=0\.0/16 )')),
]
paths = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')
findings = []
checked = 0
for name in paths:
    if not name:
        continue
    path = pathlib.Path(name)
    if not path.is_file():
        continue  # staged deletions and submodules have no file content
    checked += 1
    data = path.read_bytes()
    if len(data) > 5 * 1024 * 1024:
        findings.append(f'{name}: file exceeds 5 MiB ({len(data)} bytes)')
    if b'\0' in data:
        continue
    for number, line in enumerate(data.decode('utf-8', errors='replace').splitlines(), 1):
        for match in patterns.finditer(line):
            # Only this checker's regex definitions may spell the forbidden prefixes.
            definition = name == 'scripts/check-public.sh' and 're.compile(' in line
            allowed = definition or any(
                expression.match(line, match.start()) for p, expression in allowlist if p == name
            )
            if not allowed:
                findings.append(f'{name}:{number}: {match.group()}')
for finding in findings:
    print(finding)
print(f'public-content: {checked} tracked files checked, {len(findings)} findings')
sys.exit(bool(findings))
PY
