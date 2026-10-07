# Hermes plugin

Hermes Deck reads everything it shows about Hermes through one plugin on the machine where Hermes runs.

| Folder | Status |
|---|---|
| [`hermes-deck/`](hermes-deck/README.md) | **Use this.** Events for the relay, plus the bridge for the Deck's direct connection. One installer backs up each `config.yaml`, enables it in every profile and migrates legacy configuration. |


Quick start on the Hermes machine:

```bash
cd hermes-plugin/hermes-deck
~/.hermes/hermes-agent/venv/bin/python install.py --dry-run   # what would change
~/.hermes/hermes-agent/venv/bin/python install.py             # backs up, enables, migrates
```

For an existing bridge install, disable its previous plugin manually, update Deck's stream path and restricted SSH keys, and install a matching app build. Restart the gateways at a quiet moment (details, settings and `--uninstall` in [`hermes-deck/README.md`](hermes-deck/README.md)).
