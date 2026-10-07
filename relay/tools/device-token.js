#!/usr/bin/env node
"use strict";
// Device tokens for the bot screen: a deck hosts computer_use only with one of these (see
// docs/bot-screen-protocol.md). Run on the agent host, in relay/:
//
//   node tools/device-token.js add <name>      issue a token (shown once; enter it in Hermes Deck on that device)
//   node tools/device-token.js list            names and dates, never tokens
//   node tools/device-token.js revoke <name>   the device's driver channel stops within 15 s
//
// Hashes live in devices.json next to the relay's .env (DECK_DEVICE_TOKENS overrides the path).
const path = require("path");
const devtokens = require("../src/devtokens");

const file = process.env.DECK_DEVICE_TOKENS || path.join(path.dirname(process.env.DECK_RELAY_ENV || path.join(__dirname, "..", ".env")), "devices.json");
const [cmd, name] = process.argv.slice(2);

function usage() {
  console.error("usage: node tools/device-token.js add <name> | list | revoke <name>");
  process.exit(2);
}

try {
  if (cmd === "add" && name) {
    const token = devtokens.add(file, name);
    console.log(`Device token for "${name}" (shown once; enter it in Hermes Deck on that device):\n${token}`);
  } else if (cmd === "list" && !name) {
    const rows = devtokens.list(file);
    if (!rows.length) console.log("no device tokens");
    for (const r of rows) console.log(`${r.name.padEnd(34)}${r.created ? new Date(r.created * 1000).toISOString().slice(0, 10) : ""}`);
  } else if (cmd === "revoke" && name) {
    if (!devtokens.revoke(file, name)) {
      console.error(`no token named "${name}"`);
      process.exit(1);
    }
    console.log(`revoked "${name}"`);
  } else usage();
} catch (e) {
  console.error(`device-token: ${e.message}`);
  process.exit(1);
}
