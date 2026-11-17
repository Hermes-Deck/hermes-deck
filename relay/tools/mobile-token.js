#!/usr/bin/env node
'use strict';
const path = require('node:path');
const os = require('node:os');
const { loadEnvFile } = require('../src/util');
loadEnvFile(process.env.DECK_RELAY_ENV || path.join(__dirname, '..', '.env'));
const tokens = require('../src/devtokens');
const { createPair } = require('../src/mobile');
const { createPage, publicBase } = require('../src/pair-page');
const file = process.env.DECK_MOBILE_DEVICES_FILE || path.join(os.homedir(), '.hermes-deck', 'mobile-devices.json');
const [command, id, ...rest] = process.argv.slice(2);

/**
 * `page`: one pairing page (pair-page.js). Prints the page URL (or only its path when DECK_RELAY_PUBLIC_URL is unset,
 * with a note saying so) and the expiry; `--json` prints {url | path, expiresAt} instead. Never prints the code.
 */
function page(asJson) {
  let base = null, problem = null;
  try { base = publicBase(process.env.DECK_RELAY_PUBLIC_URL); } catch (error) { problem = error.message; }
  const made = createPage(file, { publicUrl: base });
  const out = made.url ? { url: made.url, expiresAt: made.expiresAt } : { path: made.path, expiresAt: made.expiresAt };
  if (asJson) return console.log(JSON.stringify(out));
  const local = new Date(made.expires).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  console.log(made.url || made.path);
  console.log(`Expires: ${made.expiresAt} (${local}); single use, gone after the first pairing.`);
  if (!made.url) console.log(problem
    ? `${problem}: only the path is printed; put the relay's public https address in front of it.`
    : 'DECK_RELAY_PUBLIC_URL is not set: only the path is printed; put the relay\'s public https address in front of it.');
}

try {
  if (!process.env.DECK_RELAY_TOKEN || process.env.DECK_RELAY_TOKEN.length < 24) throw new Error('Server administrator DECK_RELAY_TOKEN required');
  if (command === 'pair' && !id) console.log(createPair(file));
  else if (command === 'page' && (!id || (id === '--json' && !rest.length))) page(id === '--json');
  else if (command === 'list' && !id) console.log(JSON.stringify(tokens.list(file), null, 2));
  else if (command === 'revoke' && id) {
    if (!tokens.revoke(file, id)) throw new Error('Unknown mobile device');
    console.log('Revoked; live sockets close within one second');
  } else throw new Error('usage: node tools/mobile-token.js pair | page [--json] | list | revoke <deviceId>');
} catch (error) { console.error(error.message); process.exitCode = 1; }
