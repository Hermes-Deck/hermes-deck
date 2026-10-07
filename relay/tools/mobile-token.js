#!/usr/bin/env node
'use strict';
const path = require('node:path');
const os = require('node:os');
const { loadEnvFile } = require('../src/util');
loadEnvFile(process.env.DECK_RELAY_ENV || path.join(__dirname, '..', '.env'));
const tokens = require('../src/devtokens');
const { createPair } = require('../src/mobile');
const file = process.env.DECK_MOBILE_DEVICES_FILE || path.join(os.homedir(), '.hermes-deck', 'mobile-devices.json');
const [command, id] = process.argv.slice(2);
try {
  if (!process.env.DECK_RELAY_TOKEN || process.env.DECK_RELAY_TOKEN.length < 24) throw new Error('Server administrator DECK_RELAY_TOKEN required');
  if (command === 'pair' && !id) console.log(createPair(file));
  else if (command === 'list' && !id) console.log(JSON.stringify(tokens.list(file), null, 2));
  else if (command === 'revoke' && id) {
    if (!tokens.revoke(file, id)) throw new Error('Unknown mobile device');
    console.log('Revoked; live sockets close within one second');
  } else throw new Error('usage: node tools/mobile-token.js pair | list | revoke <deviceId>');
} catch (error) { console.error(error.message); process.exitCode = 1; }
