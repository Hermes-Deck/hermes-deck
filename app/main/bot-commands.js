"use strict";
// The slash commands a Telegram bot registered (BotFather / setMyCommands), for the composer's "/" suggestions
// (renderer/suggest.js). Read with users.getFullUser (bot_info.commands) and kept for a while per bot, so typing
// "/" does not call Telegram on every key. A bot DM lists its own commands; a forum topic lists every visible
// bot's, as "/command@bot" so the group delivers it to that bot only (what Telegram's own clients insert).
const COMMAND_RE = /^[a-z0-9_]{1,32}$/; // Telegram's own rule for bot command names
const TTL_MS = 10 * 60 * 1000;
const MAX_PER_BOT = 100; // Telegram allows at most 100 commands per scope

/** [{command, description}] from a BotInfo's commands: valid names only, one line each, bounded. */
function cleanCommands(raw) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(raw) ? raw : []) {
    const name = c && typeof c.command === "string" ? c.command.toLowerCase() : "";
    if (!COMMAND_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    const desc = c && typeof c.description === "string" ? c.description.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    out.push({ command: name, description: desc });
    if (out.length >= MAX_PER_BOT) break;
  }
  return out;
}

/**
 * fetch(entity) resolves with a bot's raw command list (BotCommand objects). bots() gives [{key, entity}],
 * now() is injectable for tests.
 */
class BotCommands {
  constructor({ fetch, now = () => Date.now() }) {
    this._fetch = fetch;
    this._now = now;
    this._cache = new Map(); // bot user id -> {at, list}
    this._inflight = new Map();
  }

  async _of(entity) {
    const id = String(entity && entity.id != null ? entity.id : "");
    if (!id) return [];
    const hit = this._cache.get(id);
    if (hit && this._now() - hit.at < TTL_MS) return hit.list;
    if (this._inflight.has(id)) return this._inflight.get(id);
    const p = (async () => {
      try {
        const list = cleanCommands(await this._fetch(entity));
        this._cache.set(id, { at: this._now(), list });
        return list;
      } catch {
        return hit ? hit.list : []; // a failed refresh keeps what was known; nothing known is an empty list
      } finally {
        this._inflight.delete(id);
      }
    })();
    this._inflight.set(id, p);
    return p;
  }

  /**
   * The commands to offer in one chat: [{insert, command, description, bot}]. `targets` are the bots of that
   * chat ([{entity, username}]); mention adds "@username" (a group with several bots).
   */
  async list(targets, { mention = false } = {}) {
    const out = [];
    for (const t of targets) {
      const user = t && typeof t.username === "string" ? t.username : "";
      for (const c of await this._of(t.entity)) {
        out.push({ insert: `/${c.command}${mention && user ? `@${user}` : ""}`, command: c.command, description: c.description, bot: user });
      }
    }
    return out;
  }

  clear() {
    this._cache.clear();
  }
}

module.exports = { BotCommands, cleanCommands, COMMAND_RE };
