"use strict";
// Message history (history.js) against a made-up Hermes state.db and Claude Code transcripts, plus the
// OMH provenance labels (provenance.js) through the model. All ids, names and texts are invented.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { History, FIELD, FULL } = require("../src/history");
const { Model } = require("../src/model");
const { parseRoute } = require("../src/provenance");
const { start } = require("../src/index");

let sqlite = null;
try {
  sqlite = require("node:sqlite");
} catch {
  /* Node without node:sqlite: the Hermes part is skipped */
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "deck-history-"));
const AGENTS = { profiles: { scout: { name: "Scout", bot: "ExampleScoutBot" }, "claude-code": { name: "Claude Code", bot: null } } };
const T0 = 1791100000;

// ------------------------------------------------------------------------------------------- fixtures

/** A Hermes root: default profile (parent P, sub-agent C) and a "research" profile with one session. */
function hermesRoot() {
  const root = tmpDir();
  const schema = `
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, parent_session_id TEXT, started_at REAL NOT NULL,
      ended_at REAL, end_reason TEXT, message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL, actual_cost_usd REAL, cost_status TEXT, title TEXT, system_prompt TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
      tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, reasoning TEXT, active INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX idx_messages_session_id ON messages(session_id, id);
    CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);`;
  const mk = (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new sqlite.DatabaseSync(file);
    db.exec(schema);
    return db;
  };
  const db = mk(path.join(root, "state.db"));
  const ses = db.prepare(
    "INSERT INTO sessions (id, source, model, parent_session_id, started_at, ended_at, end_reason, message_count, tool_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd, cost_status, system_prompt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  ses.run("20261001_100000_aaaaaa", "telegram", "model-a", null, T0, null, null, 4, 1, 1000, 200, 5000, 0, 10, 0, 0, "unknown", "x".repeat(50000));
  ses.run("20261001_100100_bbbbbb", "subagent", "model-b", "20261001_100000_aaaaaa", T0 + 60, T0 + 300, "agent_close", 7, 3, 1200, 300, 9000, 40, 20, 0, 0.42, "actual", null);
  ses.run("20261001_100500_cccccc", "subagent", "model-c", "20261001_100000_aaaaaa", T0 + 400, null, null, 0, 0, 0, 0, 0, 0, 0, 0, 0, "unknown", null);
  const msg = db.prepare("INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, reasoning, active) VALUES (?,?,?,?,?,?,?,?,?)");
  const C = "20261001_100100_bbbbbb";
  const bigArgs = JSON.stringify({ path: "notes/plan.md", content: "y".repeat(9000) });
  const calls = JSON.stringify([
    { id: "read_file_0_aa11", call_id: "read_file_0_aa11", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "notes/a.md" }) } },
    { id: "write_file_1_bb22", type: "function", function: { name: "write_file", arguments: bigArgs } },
  ]);
  msg.run(C, "user", "Özet çıkar: notes klasöründeki planı oku ve kısalt.", null, null, null, T0 + 61, null, 1);
  msg.run(C, "assistant", "", null, calls, null, T0 + 70, "Önce dosyayı okuyayım.", 1);
  msg.run(C, "tool", `satır\n${"z".repeat(6000)}`, "read_file_0_aa11", null, "read_file", T0 + 71, null, 1);
  msg.run(C, "tool", '{"ok": true, "token": "abcdefghijklmnopqrstuvwx"}', "write_file_1_bb22", null, "write_file", T0 + 72, null, 1);
  msg.run(C, "assistant", "eski taslak (geri alındı)", null, null, null, T0 + 80, null, 0);
  msg.run(C, "assistant", "Plan kısaltıldı.", null, null, null, T0 + 90, null, 1);
  msg.run(C, "tool", "q".repeat(300000), "huge_2_cc33", null, "terminal", T0 + 95, null, 1);
  msg.run("20261001_100000_aaaaaa", "user", "[Replying to: \"önceki\"]\n[Deniz|1000]\nPlanı alt-ajana ver", null, null, null, T0 + 1, null, 1);
  db.close();

  const db2 = mk(path.join(root, "profiles", "research", "state.db"));
  db2.prepare("INSERT INTO sessions (id, source, model, started_at, cost_status) VALUES (?,?,?,?,?)").run("20261001_120000_dddddd", "cli", "model-d", T0, "unknown");
  db2.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)").run("20261001_120000_dddddd", "user", "başka profil", T0 + 1);
  db2.close();
  return root;
}

const MAIN = "0a1b2c3d-1111-4222-8333-444455556666";
const line = (o) => JSON.stringify(o) + "\n";
const iso = (s) => new Date((T0 + s) * 1000).toISOString();

/** A Claude Code project dir: one main transcript and one sub-agent sidechain. */
function claudeDir() {
  const dir = tmpDir();
  const usage = { input_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 10 };
  const lines = [
    { type: "user", sessionId: MAIN, timestamp: iso(0), uuid: "u1", message: { role: "user", content: "Depoyu tara ve özetle" } },
    { type: "user", sessionId: MAIN, timestamp: iso(0), uuid: "u2", isMeta: true, message: { role: "user", content: "<meta>" } },
    { type: "assistant", sessionId: MAIN, timestamp: iso(2), requestId: "r1", message: { id: "m1", model: "claude-model-x", usage, content: [{ type: "thinking", thinking: "plan yapayım" }] } },
    { type: "assistant", sessionId: MAIN, timestamp: iso(2), requestId: "r1", message: { id: "m1", model: "claude-model-x", usage: { ...usage, output_tokens: 30 }, content: [{ type: "text", text: "Bir alt-ajan başlatıyorum." }] } },
    { type: "assistant", sessionId: MAIN, timestamp: iso(3), requestId: "r1", message: { id: "m1", model: "claude-model-x", usage: { ...usage, output_tokens: 40 }, content: [{ type: "tool_use", id: "toolu_A", name: "Agent", input: { description: "dosyaları say", prompt: "Kaç dosya var?" } }] } },
    { type: "user", sessionId: MAIN, timestamp: iso(1), isSidechain: true, message: { role: "user", content: "eski biçim yan zincir" } },
    { type: "user", sessionId: MAIN, timestamp: iso(20), toolUseResult: { agentId: "abc123", status: "completed" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_A", content: [{ type: "text", text: "42 dosya" }] }] } },
    { type: "assistant", sessionId: MAIN, timestamp: iso(22), requestId: "r2", message: { id: "m2", model: "claude-model-x", usage, stop_reason: "end_turn", content: [{ type: "text", text: "Toplam 42 dosya." }] } },
  ];
  fs.writeFileSync(path.join(dir, `${MAIN}.jsonl`), lines.map(line).join(""));
  const sub = path.join(dir, MAIN, "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "agent-abc123.meta.json"), JSON.stringify({ agentType: "general-purpose" }));
  fs.writeFileSync(
    path.join(sub, "agent-abc123.jsonl"),
    [
      { type: "user", sessionId: MAIN, isSidechain: true, agentId: "abc123", timestamp: iso(4), message: { role: "user", content: "Kaç dosya var?" } },
      { type: "assistant", sessionId: MAIN, isSidechain: true, agentId: "abc123", timestamp: iso(6), requestId: "s1", message: { id: "sm1", model: "claude-model-y", usage, content: [{ type: "tool_use", id: "toolu_B", name: "Bash", input: { command: "ls | wc -l" } }] } },
      { type: "user", sessionId: MAIN, isSidechain: true, agentId: "abc123", timestamp: iso(8), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_B", content: "42", is_error: false }] } },
      { type: "assistant", sessionId: MAIN, isSidechain: true, agentId: "abc123", timestamp: iso(9), requestId: "s2", message: { id: "sm2", model: "claude-model-y", usage, stop_reason: "end_turn", content: [{ type: "text", text: "42" }] } },
    ]
      .map(line)
      .join("")
  );
  return dir;
}

const get = (h, p) => {
  const r = h.handle(new URL(p, "http://relay"));
  assert.ok(r, `no route for ${p}`);
  return r;
};

// ------------------------------------------------------------------------------------------- Hermes

test("history: Hermes pages, clipping, full message, call lookup, meta, profiles", { skip: !sqlite && "node:sqlite unavailable" }, () => {
  const root = hermesRoot();
  const model = new Model(AGENTS);
  const h = new History({ model, hermesRoot: root });
  try {
    const C = "20261001_100100_bbbbbb";
    // newest page first, chronological inside; the inactive (rewound) row never shows
    let r = get(h, `/session/${C}/messages?limit=3`);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.meta.kind, "hermes");
    assert.strictEqual(r.body.meta.parent, "20261001_100000_aaaaaa");
    assert.strictEqual(r.body.meta.cost, 0.42); // actual cost known
    assert.deepStrictEqual(r.body.meta.tokens, { in: 1200, cr: 9000, cw: 40, out: 300, rs: 20 });
    assert.deepStrictEqual(r.body.items.map((i) => i.role), ["tool", "assistant", "tool"]);
    assert.strictEqual(r.body.items[1].text, "Plan kısaltıldı.");
    assert.ok(r.body.next);
    const huge = r.body.items[2];
    assert.strictEqual(huge.text.length, FIELD);
    assert.strictEqual(huge.truncated, true);
    // the older page continues exactly where the first one stopped, and says when there is nothing older
    const r2 = get(h, `/session/${C}/messages?limit=3&before=${r.body.next}`);
    assert.deepStrictEqual(r2.body.items.map((i) => i.role), ["user", "assistant", "tool"]);
    assert.strictEqual(r2.body.next, null);
    const all = [...r2.body.items, ...r.body.items];
    assert.strictEqual(new Set(all.map((i) => i.id)).size, 6);
    assert.ok(!all.some((i) => /geri alındı/.test(i.text || "")));

    // tool calls: name + args, the big one clipped; reasoning comes along as "think"
    const asked = all.find((i) => i.calls);
    assert.deepStrictEqual(asked.calls.map((c) => [c.call, c.name]), [["read_file_0_aa11", "read_file"], ["write_file_1_bb22", "write_file"]]);
    assert.strictEqual(asked.calls[1].args.length, FIELD);
    assert.strictEqual(asked.calls[1].truncated, true);
    assert.strictEqual(asked.truncated, true);
    assert.strictEqual(asked.think, "Önce dosyayı okuyayım.");
    const res = all.find((i) => i.call === "write_file_1_bb22");
    assert.ok(!/abcdefghijklmnopqrstuvwx/.test(res.text), "secrets are redacted");

    // full message: every field, capped at 256 KB
    const full = get(h, `/message/${encodeURIComponent(asked.id)}/full`).body;
    assert.strictEqual(full.calls[1].args.length, JSON.stringify({ path: "notes/plan.md", content: "y".repeat(9000) }).length);
    assert.ok(!full.truncated);
    const fullHuge = get(h, `/message/${encodeURIComponent(huge.id)}/full`).body;
    assert.strictEqual(fullHuge.text.length, FULL);
    assert.strictEqual(fullHuge.truncated, true);

    // one call: args from the assistant row, result from the tool row
    const call = get(h, `/session/${C}/call/read_file_0_aa11`).body;
    assert.strictEqual(call.name, "read_file");
    assert.strictEqual(JSON.parse(call.args).path, "notes/a.md");
    assert.strictEqual(call.result.length, 6006);
    assert.strictEqual(get(h, `/session/${C}/call/nope_9`).code, 404);

    // the parent lists its sub-agents; an unknown price stays out
    const p = get(h, "/session/20261001_100000_aaaaaa/messages").body;
    assert.strictEqual(p.meta.cost, undefined);
    assert.deepStrictEqual(p.meta.kids.map((k) => k.sid), ["20261001_100100_bbbbbb", "20261001_100500_cccccc"]);
    // a session the live model never saw is found by probing every profile
    const other = get(h, "/session/20261001_120000_dddddd/messages").body;
    assert.strictEqual(other.meta.profile, "research");
    assert.strictEqual(other.items[0].text, "başka profil");

    // bad input never reaches SQL
    assert.strictEqual(get(h, "/session/nope_x/messages").code, 404);
    assert.strictEqual(get(h, `/session/${C}/messages?before=abc`).code, 400);
    assert.strictEqual(get(h, "/session/%2E%2E%2Fx/messages").code, 400);
    assert.strictEqual(get(h, "/message/h:..:1/full").code, 400);
    assert.strictEqual(get(h, "/message/%E0%A4%A/full").code, 400);
    assert.strictEqual(h.handle(new URL("/snapshot", "http://relay")), null); // not a history route
  } finally {
    h.stop();
  }
});

test("history: the state.db connection is read-only", { skip: !sqlite && "node:sqlite unavailable" }, () => {
  const root = hermesRoot();
  const h = new History({ hermesRoot: root });
  try {
    get(h, "/session/20261001_100000_aaaaaa/messages");
    const conn = h.hermes.dbs.get("default").db;
    assert.throws(() => conn.exec("CREATE TABLE x (y)"), /readonly|read-only|query_only|attempt to write/i);
  } finally {
    h.stop();
  }
});

// ------------------------------------------------------------------------------------------- Claude Code

test("history: Claude transcript grouping, sidechains, paging, growth", () => {
  const dir = claudeDir();
  const h = new History({ claudeDirs: [dir] });
  try {
    const r = get(h, `/session/${MAIN}/messages`).body;
    assert.strictEqual(r.meta.kind, "claude");
    assert.strictEqual(r.meta.model, "claude-model-x");
    // meta lines and inline sidechains are skipped; the three block lines of one response are one item
    assert.deepStrictEqual(r.items.map((i) => i.role), ["user", "assistant", "tool", "assistant"]);
    const a = r.items[1];
    assert.strictEqual(a.text, "Bir alt-ajan başlatıyorum.");
    assert.strictEqual(a.think, "plan yapayım");
    assert.strictEqual(a.calls[0].name, "Agent");
    assert.strictEqual(JSON.parse(a.calls[0].args).prompt, "Kaç dosya var?");
    const t = r.items[2];
    assert.deepStrictEqual([t.call, t.name, t.text, t.child], ["toolu_A", "Agent", "42 dosya", `${MAIN}/abc123`]);
    // usage counted once per response (largest repeat), not once per block line
    assert.strictEqual(r.meta.tokens.out, 40 + 10);

    // paging by byte cursor: limit 2 then the rest, no gaps or repeats
    const p1 = get(h, `/session/${MAIN}/messages?limit=2`).body;
    const p2 = get(h, `/session/${MAIN}/messages?limit=2&before=${p1.next}`).body;
    assert.deepStrictEqual([...p2.items, ...p1.items].map((i) => i.id), r.items.map((i) => i.id));
    assert.strictEqual(p2.next, null);

    // full + call lookup
    assert.strictEqual(get(h, `/message/${encodeURIComponent(t.id)}/full`).body.text, "42 dosya");
    const c = get(h, `/session/${MAIN}/call/toolu_A`).body;
    assert.deepStrictEqual([c.name, c.result, c.child], ["Agent", "42 dosya", `${MAIN}/abc123`]);

    // the sub-agent sidechain answers under "<session>/<agentId>"
    const sub = get(h, `/session/${encodeURIComponent(`${MAIN}/abc123`)}/messages`).body;
    assert.deepStrictEqual([sub.meta.role, sub.meta.parent, sub.meta.model], ["general-purpose", MAIN, "claude-model-y"]);
    assert.deepStrictEqual(sub.items.map((i) => i.role), ["user", "assistant", "tool", "assistant"]);
    assert.strictEqual(sub.items[2].name, "Bash");

    // the transcript grows: new lines show up, a half-written line waits for its newline
    const f = path.join(dir, `${MAIN}.jsonl`);
    fs.appendFileSync(f, line({ type: "user", sessionId: MAIN, timestamp: iso(30), message: { role: "user", content: "Teşekkürler" } }) + '{"type":"user","sessionId"');
    const grown = get(h, `/session/${MAIN}/messages`).body;
    assert.strictEqual(grown.items[grown.items.length - 1].text, "Teşekkürler");
    assert.strictEqual(grown.items.length, 5);

    assert.strictEqual(get(h, "/session/0a1b2c3d-0000-4000-8000-000000000000/messages").code, 404);
    assert.strictEqual(get(h, `/message/${encodeURIComponent(`c:${MAIN}:99999`)}/full`).code, 404);
  } finally {
    h.stop();
  }
});

// ------------------------------------------------------------------------------------------- relay

test("history: served by the relay behind the token", { skip: !sqlite && "node:sqlite unavailable" }, async (t) => {
  const dir = tmpDir();
  const eventsDir = path.join(dir, "events");
  fs.mkdirSync(eventsDir);
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify(AGENTS));
  const cfg = {
    host: "127.0.0.1", port: 0, token: "t".repeat(32), eventsDir, stateDir: path.join(dir, "state"), dataDir: path.join(dir, "data"),
    claudeDirs: [claudeDir()], claudeProfile: "claude-code", claudeChatMap: null, launchdPrefixes: [], codexbar: null, agentsFile,
    broadcastWindowS: 300, tickMs: 100, hermesRoot: hermesRoot(),
  };
  const relay = await start(cfg);
  t.after(() => relay.stop());
  const base = `http://127.0.0.1:${relay.port}`;
  const auth = { headers: { authorization: `Bearer ${cfg.token}` } };
  assert.strictEqual((await fetch(`${base}/session/20261001_100100_bbbbbb/messages`)).status, 401);
  const r = await (await fetch(`${base}/session/20261001_100100_bbbbbb/messages?limit=2`, auth)).json();
  assert.strictEqual(r.items.length, 2);
  const sub = await (await fetch(`${base}/session/${encodeURIComponent(`${MAIN}/abc123`)}/messages`, auth)).json();
  assert.strictEqual(sub.meta.role, "general-purpose");
  assert.strictEqual((await fetch(`${base}/session/%E0%A4%A`, auth)).status, 400); // bad escape: an answer, not a crash
});

// ------------------------------------------------------------------------------------------- provenance

test("provenance: OMH route labels the children of the next dispatch only", () => {
  assert.deepStrictEqual(
    parseRoute('{"action": "set", "category": "deep-work", "model": "model-k", "provider": "prov-k", "reasoning_effort": "high"}', '{"applied": {"alias": "k", "model": "model-k2", "provider": "prov-k"}, "category": "deep-work", "evidence_boundary": "Prepared route only…'),
    { action: "set", category: "deep-work", model: "model-k2", provider: "prov-k", effort: "high" }
  );
  const m = new Model(AGENTS);
  const base = { profile: "scout" };
  let ts = T0;
  const ev = (e) => m.apply({ ...base, ts: ts++, ...e }, true);
  ev({ ev: "turn_start", sid: "P", msg: "üç bölümü yazdır" });
  assert.strictEqual(m.sessions.get("P").turnTs, T0);
  ev({ ev: "tool_start", sid: "P", tool: "omh_delegate_route", call: "r1", args: '{"action": "set", "category": "writing", "model": "model-k", "provider": "prov-k", "reasoning_effort": "high"}' });
  ev({ ev: "tool_end", sid: "P", tool: "omh_delegate_route", call: "r1", status: "ok", result: '{"applied": {"model": "model-k", "provider": "prov-k", "reasoning_effort": "high"}, "category": "writing"}' });
  ev({ ev: "tool_start", sid: "P", tool: "delegate_task", call: "d1" });
  ev({ ev: "sub_start", sid: "P", child: "C1", sa: "sa-0", role: "leaf", goal: "[omh-role:writer] Bölüm 1" });
  ev({ ev: "sub_start", sid: "P", child: "C2", sa: "sa-1", role: "leaf", goal: "Bölüm 2" });
  ev({ ev: "tool_end", sid: "P", tool: "delegate_task", call: "d1", status: "ok" });
  // a second dispatch in the same turn has no route of its own
  ev({ ev: "tool_start", sid: "P", tool: "delegate_task", call: "d2" });
  ev({ ev: "sub_start", sid: "P", child: "C3", role: "leaf", goal: "Bölüm 3" });
  // the OMH child's own child is OMH too
  ev({ ev: "sub_start", sid: "C1", child: "G1", role: "leaf", goal: "kaynak bul" });
  const c1 = m.summary(m.sessions.get("C1"));
  assert.strictEqual(c1.origin, "omh");
  assert.deepStrictEqual(c1.route, { category: "writing", model: "model-k", provider: "prov-k", effort: "high" });
  assert.strictEqual(c1.omhRole, "writer");
  assert.strictEqual(m.sessions.get("C2").origin, "omh");
  assert.strictEqual(m.sessions.get("C3").origin, undefined);
  assert.strictEqual(m.sessions.get("G1").origin, "omh");
  assert.strictEqual(m.sessions.get("G1").route, undefined);
  // a route left over from an earlier turn never labels a later dispatch; a refused route labels nothing
  ev({ ev: "tool_start", sid: "P", tool: "omh_delegate_route", call: "r2", args: '{"action": "set", "category": "research"}' });
  ev({ ev: "tool_end", sid: "P", tool: "omh_delegate_route", call: "r2", status: "ok", result: '{"category": "research"}' });
  ev({ ev: "turn_end", sid: "P" });
  ev({ ev: "turn_start", sid: "P", msg: "devam" });
  ev({ ev: "tool_start", sid: "P", tool: "delegate_task", call: "d3" });
  ev({ ev: "sub_start", sid: "P", child: "C4", goal: "x" });
  assert.strictEqual(m.sessions.get("C4").origin, undefined);
  ev({ ev: "tool_start", sid: "P", tool: "omh_delegate_route", call: "r3", args: '{"action": "set", "category": "research"}' });
  ev({ ev: "tool_end", sid: "P", tool: "omh_delegate_route", call: "r3", status: "error", result: "boom" });
  ev({ ev: "tool_start", sid: "P", tool: "delegate_task", call: "d4" });
  ev({ ev: "sub_start", sid: "P", child: "C5", goal: "y" });
  assert.strictEqual(m.sessions.get("C5").origin, undefined);
  // internal route state never leaks into summaries
  assert.ok(!Object.keys(m.summary(m.sessions.get("P"))).some((k) => /pending|dispatch/i.test(k)));
});

test("history: /session/<sid>/tools groups calls by turn and pages back", { skip: !sqlite && "node:sqlite unavailable" }, () => {
  const root = tmpDir();
  const db = new sqlite.DatabaseSync(path.join(root, "state.db"));
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, parent_session_id TEXT, started_at REAL NOT NULL,
      ended_at REAL, end_reason TEXT, message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, cost_status TEXT, title TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
      tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, reasoning TEXT, active INTEGER NOT NULL DEFAULT 1);`);
  const S = "20261002_090000_eeeeee";
  db.prepare("INSERT INTO sessions (id, source, started_at, tool_call_count) VALUES (?,?,?,?)").run(S, "cli", T0, 4);
  const msg = db.prepare("INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, active) VALUES (?,?,?,?,?,?,?,?)");
  const calls = (...ids) => JSON.stringify(ids.map((id) => ({ id, type: "function", function: { name: "terminal", arguments: JSON.stringify({ command: `echo ${id}` }) } })));
  msg.run(S, "assistant", "", null, calls("pre_0"), null, T0 + 1, 1); // before any user message
  msg.run(S, "tool", "{}", "pre_0", null, "terminal", T0 + 2, 1);
  msg.run(S, "user", "First task\nsecond line", null, null, null, T0 + 10, 1);
  msg.run(S, "assistant", "", null, calls("a_1", "a_2"), null, T0 + 11, 1);
  msg.run(S, "tool", "ok", "a_1", null, "terminal", T0 + 12, 1);
  msg.run(S, "tool", '{"error": "boom"}', "a_2", null, "terminal", T0 + 13, 1);
  msg.run(S, "assistant", "", null, calls("a_3", "a_4"), null, T0 + 14, 1);
  msg.run(S, "tool", '{"output": "FAIL", "exit_code": 1, "error": null}', "a_3", null, "terminal", T0 + 15, 1); // a_4: no result (stopped)
  msg.run(S, "user", "Second task token=abcdefghijklmnopqrstuvwx", null, null, null, T0 + 20, 1);
  msg.run(S, "assistant", "", null, calls("b_1"), null, T0 + 21, 1);
  msg.run(S, "assistant", "", null, calls("gone_1"), null, T0 + 22, 0); // rewound
  db.close();
  const h = new History({ hermesRoot: root });
  try {
    let r = get(h, `/session/${S}/tools?limit=1`);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.turns.length, 1);
    const t2 = r.body.turns[0];
    assert.strictEqual(t2.ts, T0 + 20);
    assert.ok(!/abcdefghijklmnopqrstuvwx/.test(t2.text), "user text is redacted");
    assert.deepStrictEqual(t2.calls.map((c) => c.call), ["b_1"]);
    assert.strictEqual(t2.calls[0].status, "running", "last call without a result is still running");
    assert.ok(r.body.next);
    r = get(h, `/session/${S}/tools?limit=5&before=${r.body.next}`);
    assert.strictEqual(r.body.next, null);
    assert.deepStrictEqual(r.body.turns.map((t) => t.calls.map((c) => c.call)), [["pre_0"], ["a_1", "a_2", "a_3", "a_4"]]);
    assert.strictEqual(r.body.turns[1].text, "First task");
    assert.deepStrictEqual(r.body.turns[1].calls.map((c) => c.status), ["ok", "error", "error", "interrupted"], "non-zero exit_code is an error; a call that never got a result was interrupted");
    assert.strictEqual(r.body.turns[1].calls[0].ms, 1000);
    assert.strictEqual(get(h, `/session/${S}/tools?before=12x`).code, 400);
    assert.strictEqual(get(h, "/session/nope_nope/tools").code, 404);
  } finally {
    h.stop();
  }
});
