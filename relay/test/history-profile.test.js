"use strict";
// relay-wire W9 (G8): `?profile=` on the relay history routes reads only that profile.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { History } = require("../src/history");

let sqlite = null;
try { sqlite = require("node:sqlite"); } catch { /* skipped below */ }

const T0 = 1791100000;
const SID = "20261001_100000_aaaaaa";
const SCHEMA = `
  CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, parent_session_id TEXT, started_at REAL NOT NULL,
    ended_at REAL, end_reason TEXT, message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0,
    estimated_cost_usd REAL, actual_cost_usd REAL, cost_status TEXT, title TEXT, system_prompt TEXT);
  CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
    tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, reasoning TEXT, active INTEGER NOT NULL DEFAULT 1);
  CREATE INDEX idx_messages_session_id ON messages(session_id, id);
  CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);`;

/** The same session id in two profiles (default and research), different text; one id only in research. */
function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-history-profile-"));
  const store = (file, text, extra) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new sqlite.DatabaseSync(file);
    db.exec(SCHEMA);
    for (const sid of [SID, ...(extra ? [extra] : [])]) {
      db.prepare("INSERT INTO sessions (id, source, model, started_at, cost_status) VALUES (?,?,?,?,?)").run(sid, "cli", "model-a", T0, "unknown");
      db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)").run(sid, "user", text, T0 + 1);
    }
    db.close();
  };
  store(path.join(dir, "state.db"), "default text");
  store(path.join(dir, "profiles", "research", "state.db"), "research text", "20261001_120000_dddddd");
  return dir;
}
const get = (h, p) => h.handle(new URL(p, "http://relay"));

test("history ?profile= reads only that profile; without it the old lookup stays", { skip: !sqlite && "node:sqlite unavailable" }, () => {
  const h = new History({ hermesRoot: root() });
  try {
    const text = (r) => r.body.items.map((i) => i.text);
    assert.deepEqual(text(get(h, `/session/${SID}/messages?profile=research`)), ["research text"]);
    assert.deepEqual(text(get(h, `/session/${SID}/messages?profile=default`)), ["default text"]);
    assert.deepEqual(text(get(h, `/session/${SID}/messages`)), ["default text"], "unchanged without the parameter");
    const other = get(h, "/session/20261001_120000_dddddd/messages?profile=default");
    assert.deepEqual([other.code, other.body.error], [404, "session not found"]);
    assert.equal(get(h, "/session/20261001_120000_dddddd/messages").code, 200, "unchanged: found in any profile");
    assert.equal(get(h, `/session/${SID}/tools?profile=nobody`).code, 404);
    assert.equal(get(h, `/session/${SID}/tools?profile=research`).code, 200);
    assert.equal(get(h, `/session/${SID}/call/read_file_0_aa11?profile=nobody`).code, 404);
    assert.equal(get(h, `/session/${SID}/messages?profile=..%2Fx`).code, 400);
  } finally {
    h.stop();
  }
});
