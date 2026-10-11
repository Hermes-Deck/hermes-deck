"use strict";
// Hermes' Python for the relay's helpers (Settings › Hermes config, the Bot Desktop lease, the plugin installer).
// A configured absolute path that no longer exists (Hermes reinstalled, its venv moved) is skipped with a warning
// instead of failing every call with ENOENT; a bare command name ("python3") is looked up on PATH when it runs.
const path = require("path");

/**
 * @param {Array<[string, string|undefined]>} configured  [variable name, value] pairs, first match wins
 * @param {string} venv  Hermes' own venv Python, used when nothing configured exists
 * @param {(p: string) => boolean} exists
 * @param {string} [fallback]  when the venv is missing too ("" means: not found)
 * @param {(msg: string) => void} [warn]
 */
function hermesPython({ configured, venv, exists, fallback = "", warn = () => {} }) {
  for (const [name, value] of configured) {
    if (!value) continue;
    if (!path.isAbsolute(value) || exists(value)) return value;
    warn(`${name}=${value} does not exist; ignoring it (fix ${name} in the relay's settings)`);
  }
  return exists(venv) ? venv : fallback;
}

module.exports = { hermesPython };
