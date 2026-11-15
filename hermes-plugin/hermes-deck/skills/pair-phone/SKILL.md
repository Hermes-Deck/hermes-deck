---
name: pair-phone
description: "Use when the user wants to connect a phone to Hermes Deck. Sends a five-minute pairing link."
version: 0.1.0
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [hermes-deck, phone, pairing, qr, relay]
---

# Connect a phone to Hermes Deck

The user wants to reach their Hermes Deck from a phone. Hand them a **pairing page link**: a page on their own Deck
relay that shows a QR code for the Hermes Deck phone app, an "Open in Hermes Deck" button and the code to type by hand.
The link works for five minutes or until one phone has paired, whichever comes first. You make it with the relay's own
tool on this host; you never see, print or fetch the pairing code.

## When to Use

- "I want to use Hermes Deck on my phone", "connect my iPhone / Android to the Deck", "pair my phone", "show me the
  QR code for the app", "the pairing link expired, send a new one".
- Turkish: "telefonumdan Hermes Deck'e erişmek istiyorum", "telefonumu Deck'e bağla", "telefonu eşleştir",
  "Deck'i telefonda açmak istiyorum", "QR kodu göster", "eşleştirme linki gönder", "link süresi doldu, yenisini at".
- Not for removing a phone (that is `node tools/mobile-token.js list` / `revoke <deviceId>` in the same folder, run
  only when the user asks) and not for desktop Deck setup (`hermes-deck-setup`).

## Rules

- **Never put the pairing code in the chat** and never run `mobile-token.js pair` for this: the page shows the code
  to the person holding the link. Do not open, fetch or screenshot the link yourself (that would copy the code into
  this conversation and its logs).
- Treat the link like a password for its five minutes: send it only in this private conversation, never to a group or
  another person's chat. Say once that whoever opens it first can pair a phone.
- Do not read or print the relay's `.env`; it holds the relay's secret token. Do not restart the relay or edit its
  configuration unless the user asks.

## Steps

1. **Find the relay's folder** (the folder that has `tools/mobile-token.js` and `src/index.js`) on this host, in this
   order, and stop at the first hit:
   - Linux user service: `systemctl --user show hermes-deck-relay -p WorkingDirectory --value` (if the unit has another
     name: `systemctl --user list-units --type=service --all | grep -i deck`). A release install points at
     `<root>/current/relay`.
   - macOS launch agent: `plutil -extract WorkingDirectory raw ~/Library/LaunchAgents/com.hermes-deck.relay.plist`.
   - A running relay: `pgrep -af 'node .*src/index.js'`, then its working directory: Linux
     `readlink /proc/<pid>/cwd`, macOS `lsof -a -p <pid> -d cwd -Fn`.
   - None found: tell the user the Deck relay does not seem to run on this host and stop (setup is `hermes-deck-setup`).
   Confirm with `test -f <dir>/tools/mobile-token.js`.
2. **Make the link** as the user the relay runs as, from that folder:
   `cd <dir> && node tools/mobile-token.js page --json`
   (if `node` is not on PATH, use the one in the service's start command: `systemctl --user show hermes-deck-relay -p
   ExecStart`). It prints one line: `{"url": "https://…/pair/…", "expiresAt": "<ISO 8601 UTC>"}`, or `{"path":
   "/pair/…", …}` when the relay's public address is not configured. An error such as `Too many pending pairs` means
   ten codes are waiting: wait five minutes or ask the user.
3. **Answer** with the link and when it stops working, in the user's language and local time, plus one line on what
   to do. For example:
   - English: "Open this on your computer and scan the QR code with the Hermes Deck app, or open it on the phone and tap
     Open in Hermes Deck: <url> (works until 14:35, one phone only). Whoever opens it first can pair, so keep it to
     yourself."
   - Turkish: "Bu bağlantıyı bilgisayarda aç ve QR kodu Hermes Deck uygulamasıyla tara, ya da telefonda açıp
     'Hermes Deck'te aç'a dokun: <url> (14:35'e kadar geçerli, tek telefon). Bağlantıyı ilk açan eşleşebilir, kimseyle
     paylaşma."
4. **Only a path came back** (`path` instead of `url`): the relay does not know its public https address. Ask the user
   for the address they open the Deck relay at (for example `https://relay.example`) and send `<address><path>`. Offer
   to set it permanently: one line `DECK_RELAY_PUBLIC_URL=https://relay.example` in the relay's `.env` (append it with
   the user's OK, without reading the rest of the file); the tool picks it up on the next run, and a relay restart makes
   the page use it too.
5. **It lapsed** ("the link doesn't work", "süresi dolmuş"): run step 2 again and send the new link. Making a new link
   retires the oldest of the waiting ones once three are open; an already paired phone is not affected.
6. **After pairing** the page shows the phone's name. If the user does not recognise a paired phone, list and revoke
   it from the same folder (`node tools/mobile-token.js list`, `revoke <deviceId>`) after asking.

## Verification

- The answer contains a link ending in `/pair/<32 characters>` and a time, and no 32-character hex code.
- If the user says the page says "This link no longer works" / "Bu bağlantı artık çalışmıyor", it expired or was used:
  make a new one.
