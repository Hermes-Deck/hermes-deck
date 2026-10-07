"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");
const { Tailer } = require("../src/tailer");
const { ClaudeNormalizer } = require("../src/claude");
const { Model } = require("../src/model");
const { normUsage, redact } = require("../src/util");
const { start } = require("../src/index");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "deck-relay-"));
const line = (o) => JSON.stringify(o) + "\n";
const AGENTS = { profiles: { scout: { name: "Scout", bot: "ExampleScoutBot", emoji: "🔥" }, "claude-code": { name: "Claude Code", bot: "ExampleClaudeBot", emoji: "📋" } } };

test("tailer: partial lines, rotation, checkpoint resume without double counting", () => {
  const dir = tmpDir();
  const f = path.join(dir, "p.ndjson");
  const seen = [];
  const t = new Tailer(f, (l, live) => seen.push([JSON.parse(l).i, live]));
  assert.strictEqual(t.poll(), 0); // file missing is fine
  fs.writeFileSync(f, line({ i: 1 }) + '{"i":2');
  t.poll();
  assert.deepStrictEqual(seen, [[1, true]]);
  fs.appendFileSync(f, "}\n" + line({ i: 3 }));
  t.poll();
  assert.deepStrictEqual(seen.map((s) => s[0]), [1, 2, 3]);

  // rotation: rest of the old file lands in .1 and a new file starts
  fs.appendFileSync(f, line({ i: 4 }));
  fs.renameSync(f, f + ".1");
  fs.writeFileSync(f, line({ i: 5 }));
  t.poll();
  assert.deepStrictEqual(seen.map((s) => s[0]), [1, 2, 3, 4, 5]);

  // restart from checkpoint: warm-up replays with live=false, then only new lines are live
  const cp = t.checkpoint();
  fs.appendFileSync(f, line({ i: 6 }));
  const seen2 = [];
  const t2 = new Tailer(f, (l, live) => seen2.push([JSON.parse(l).i, live]), { checkpoint: cp, warmBytes: 1 << 20 });
  t2.poll();
  assert.deepStrictEqual(seen2, [[5, false], [6, true]]);
});

test("util: usage normalization and redaction", () => {
  assert.deepStrictEqual(normUsage({ input_tokens: 81997, output_tokens: 649, cache_read_tokens: 512, reasoning_tokens: 528, total_tokens: 9 }), { in: 81997, cr: 512, cw: 0, out: 649, rs: 528 });
  assert.deepStrictEqual(normUsage({ input_tokens: 2, cache_creation_input_tokens: 64134, cache_read_input_tokens: 0, output_tokens: 365, output_tokens_details: { thinking_tokens: 133 } }), { in: 2, cr: 0, cw: 64134, out: 365, rs: 133 });
  assert.strictEqual(normUsage({ total_tokens: 0 }), null);
  const r = redact("curl -H 'Authorization: Bearer abcdefghijklmnop123' token=supersecret99 sk-ant-abcdefghijklmnopqrstu");
  assert.ok(!/abcdefghijklmnop123|supersecret99|sk-ant-abc/.test(r), r);
  // security audit L5: AWS, PEM (also cut off by the preview), database URLs, Google keys, JWTs
  const fake = {
    aws: "AKIA" + "EXAMPLE0EXAMPLE0",
    awsSecret: "aws_secret_access_key = " + "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIEexamplekeybody\n-----END RSA PRIVATE KEY-----",
    db: "postgres://deck:hunter2pass@db.example:5432/app",
    google: "AIza" + "SyA-example-example-example-example",
    jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJlZXhhbXBsZQ",
    // a key the 300-character preview cut off has no END line: everything from BEGIN to the end goes
    pemCut: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEexample",
  };
  const out = redact(Object.values(fake).join(" | "));
  for (const secret of ["EXAMPLE0EXAMPLE0", "bPxRfiCYEXAMPLEKEY", "MIIEexamplekeybody", "b3BlbnNzaC1rZXktdjEexample", "hunter2pass", "SyA-example", "c2lnbmF0dXJlZXhhbXBsZQ"]) {
    assert.ok(!out.includes(secret), `${secret} in ${out}`);
  }
  assert.match(out, /postgres:\/\/deck:‹redacted›@db\.example/, "the URL keeps its user and host");
});

test("claude normalizer: split usage counted once, tools timed, sub-agent linked", () => {
  const n = new ClaudeNormalizer({ chatOf: () => ({ chat: "1000001" }) });
  const S = "sess-1";
  const t0 = "2026-10-04T20:00:00.000Z";
  const t1 = "2026-10-04T20:00:02.500Z";
  const evs = [];
  const feed = (r, meta) => evs.push(...n.handle({ sessionId: S, timestamp: t0, ...r }, meta));
  feed({ type: "user", message: { content: "do the thing" } });
  const usage = { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 10 };
  feed({ type: "assistant", requestId: "req_1", message: { id: "m1", model: "claude-opus-5-5", usage, content: [{ type: "thinking" }] } });
  feed({ type: "assistant", requestId: "req_1", message: { id: "m1", model: "claude-opus-5-5", usage: { ...usage, output_tokens: 40 }, content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } });
  feed({ type: "assistant", requestId: "req_1", message: { id: "m1", model: "claude-opus-5-5", usage: { ...usage, output_tokens: 60 }, content: [{ type: "tool_use", id: "tu2", name: "Skill", input: { skill: "x" } }] } });
  evs.push(...n.handle({ sessionId: S, timestamp: t1, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "a\nb" }] } }));
  // sub-agent file lines (same sessionId, agentId meta)
  feed({ type: "user", isSidechain: true, agentId: "abc", message: { content: "count files" } }, { agentId: "abc", role: "general-purpose" });
  feed({ type: "assistant", requestId: "req_2", isSidechain: true, message: { model: "claude-sonnet-5-5", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 5 }, content: [{ type: "text", text: "18" }] } }, { agentId: "abc" });
  // parent's tool_result for the forked skill carries the agentId: must not double-stop
  feed({ type: "user", toolUseResult: { agentId: "abc", status: "forked", success: true, result: "18" }, message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: "18" }] } });
  // cost-state lines have no timestamp: they inherit the session's last one, never "now"
  evs.push(...n.handle({ sessionId: S, type: "cost-state", totalCostUSD: 0.25 }));
  assert.strictEqual(evs[evs.length - 1].ts, Date.parse(t0) / 1000);

  const llm = evs.filter((e) => e.ev === "llm");
  const sum = (k) => llm.filter((e) => e.sid === S).reduce((a, e) => a + (e.usage[k] || 0), 0);
  assert.strictEqual(sum("cw"), 1000);
  assert.strictEqual(sum("cr"), 5000);
  assert.strictEqual(sum("out"), 60);
  assert.strictEqual(llm.filter((e) => e.sid === S && !e.cont).length, 1);
  const end1 = evs.find((e) => e.ev === "tool_end" && e.call === "tu1");
  assert.strictEqual(end1.tool, "Bash");
  assert.strictEqual(end1.ms, 2500);
  const subStart = evs.filter((e) => e.ev === "sub_start");
  assert.strictEqual(subStart.length, 1);
  assert.deepStrictEqual([subStart[0].sid, subStart[0].child, subStart[0].role, subStart[0].goal], [S, `${S}/abc`, "general-purpose", "count files"]);
  assert.strictEqual(evs.filter((e) => e.ev === "sub_stop").length, 1);
  assert.strictEqual(evs.find((e) => e.ev === "cost").usd, 0.25);
  assert.ok(evs.every((e) => e.chat === "1000001" && e.profile === "claude-code"));
});

test("model: session tree, states, rollups only from live events", () => {
  const m = new Model(AGENTS);
  const P = "parent";
  const C = "child";
  const ts = 1791146783;
  const evs = [
    { ev: "turn_start", sid: P, msg: "count desktop files", model: "grok-4.6" },
    { ev: "llm", sid: P, model: "grok-4.6", usage: { in: 81997, cr: 512, out: 649 }, ctx_len: 200000 },
    { ev: "tool_start", sid: P, tool: "delegate_task", call: "c1" },
    { ev: "sub_start", sid: P, child: C, sa: "sa-0", goal: "Count files" },
    { ev: "tool_end", sid: P, tool: "delegate_task", call: "c1", ms: 706, status: "ok" },
    { ev: "turn_end", sid: P },
    { ev: "turn_start", sid: C, msg: "Count files", model: "gpt-5.5" },
    { ev: "llm", sid: C, model: "gpt-5.5", usage: { in: 26851, out: 537 } },
    { ev: "tool_start", sid: C, tool: "terminal", call: "c2" },
  ].map((e, i) => ({ profile: "scout", ts: ts + i, ...e }));
  evs.forEach((e) => m.apply(e, true));
  assert.strictEqual(m.sessions.get(P).state, "idle");
  assert.strictEqual(m.sessions.get(C).state, "running");
  assert.strictEqual(m.sessions.get(C).curTool.tool, "terminal");
  assert.deepStrictEqual(m.sessions.get(P).children, [C]);
  assert.strictEqual(m.sessions.get(P).ctxUsed, 82509);
  let a = m.agents(ts).Scout;
  assert.strictEqual(a.subsRunning, 1);
  assert.strictEqual(m.agents(ts + 3600).Scout.subsRunning, 0); // silent for an hour = stale
  assert.strictEqual(m.summary(m.sessions.get(C), ts + 3600).stale, true);
  assert.strictEqual(a.today.in, 81997 + 26851);
  m.apply({ ev: "sub_stop", sid: P, child: C, status: "completed", ms: 29210, summary: "18", profile: "scout", ts: ts + 20 }, true);
  assert.strictEqual(m.sessions.get(C).state, "done");
  // replayed (warm-up) events change state but never the rollups
  m.apply({ ev: "llm", sid: P, model: "grok-4.6", usage: { in: 999999 }, profile: "scout", ts: ts + 21 }, false);
  a = m.agents(ts).Scout;
  assert.strictEqual(a.today.in, 81997 + 26851);
  assert.strictEqual(a.today.n, 2);
  // a finished child with a pruned parent disappears; a fresh one stays
  m.prune((ts + 3 * 86400) * 1000);
  assert.strictEqual(m.sessions.size, 0);
});

test("model: Hermes compression split hands the running turn to the new session", () => {
  const m = new Model(AGENTS);
  const skey = "agent:main:telegram:group:-100:14519";
  const base = { profile: "scout", skey, chat: "-100", thread: "14519" };
  const ts = 1791146783;
  m.apply({ ...base, ev: "turn_start", sid: "A", ts, msg: "write chapter 6" }, true);
  m.apply({ ...base, ev: "sub_start", sid: "A", child: "K", ts: ts + 1, goal: "ch6" }, true);
  m.apply({ ...base, ev: "turn_start", sid: "K", ts: ts + 2, msg: "ch6" }, true); // child inherits skey: must not split
  assert.strictEqual(m.sessions.get("A").state, "running");
  m.apply({ ...base, ev: "llm", sid: "B", ts: ts + 300, usage: { in: 5 } }, true); // compressed continuation
  assert.strictEqual(m.sessions.get("A").state, "idle");
  assert.strictEqual(m.sessions.get("A").splitInto, "B");
  assert.strictEqual(m.sessions.get("B").state, "running");
  assert.strictEqual(m.sessions.get("B").lastMsg, "write chapter 6");
  m.apply({ ...base, ev: "turn_end", sid: "B", ts: ts + 400 }, true);
  assert.strictEqual(m.sessions.get("B").state, "idle");
  assert.strictEqual(m.sessions.get("K").state, "running"); // the child is untouched
  // silent for 20 min without a tool in flight = stale; a tool in flight gets 45 min
  assert.strictEqual(m.summary(m.sessions.get("K"), ts + 2 + 20 * 60).stale, true);
  m.apply({ ...base, ev: "tool_start", sid: "K", tool: "terminal", call: "c", ts: ts + 10 }, true);
  assert.strictEqual(m.summary(m.sessions.get("K"), ts + 10 + 20 * 60).stale, undefined);
});

test("model: Claude Code cost segments survive a new claude -p process", () => {
  const m = new Model(AGENTS);
  const base = { profile: "claude-code", sid: "d1", ts: 1791146783 };
  m.apply({ ...base, ev: "llm", model: "claude-opus-5-5", usage: { in: 1 } }, true);
  for (const usd of [0.1, 0.3, 0.05, 0.2]) m.apply({ ...base, ev: "cost", usd }, true);
  assert.strictEqual(m.sessions.get("d1").cost, 0.5);
  assert.strictEqual(m.agents(base.ts)["Claude Code"].today.usd, 0.5);
});

test("relay end-to-end: auth, snapshot, live push, session detail, restart without double count", async (t) => {
  const dir = tmpDir();
  const eventsDir = path.join(dir, "events");
  fs.mkdirSync(eventsDir);
  const f = path.join(eventsDir, "scout.ndjson");
  const now = () => Date.now() / 1000;
  fs.writeFileSync(f, line({ ts: now(), ev: "turn_start", profile: "scout", sid: "s1", msg: "hi" }) + line({ ts: now(), ev: "llm", profile: "scout", sid: "s1", model: "grok-4.6", usage: { input_tokens: 100, output_tokens: 7 } }));
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify(AGENTS));
  const cfg = {
    host: "127.0.0.1", port: 0, token: "t".repeat(32), eventsDir, stateDir: path.join(dir, "state"), dataDir: path.join(dir, "data"),
    claudeDirs: [], claudeProfile: "claude-code", claudeChatMap: null, launchdPrefixes: ["ai.hermes."], codexbar: null, agentsFile, broadcastWindowS: 300, tickMs: 100,
  };
  let relay = await start(cfg);
  t.after(() => relay.stop());
  const base = `http://127.0.0.1:${relay.port}`;

  assert.strictEqual((await fetch(`${base}/health`)).status, 200);
  assert.strictEqual((await fetch(`${base}/snapshot`)).status, 401);
  assert.strictEqual((await fetch(`${base}/snapshot`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  // security audit L2: the token in the URL is refused unless DECK_RELAY_QUERY_TOKEN turns it on
  assert.strictEqual((await fetch(`${base}/snapshot?token=${cfg.token}`)).status, 401);
  const viaQuery = new WebSocket(`ws://127.0.0.1:${relay.port}/events?token=${cfg.token}`);
  const refused = await new Promise((resolve) => {
    viaQuery.on("unexpected-response", (_req, res) => resolve(res.statusCode));
    viaQuery.on("open", () => resolve("open"));
    viaQuery.on("error", () => {});
  });
  viaQuery.terminate();
  assert.strictEqual(refused, 401);

  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/events`, { headers: { authorization: `Bearer ${cfg.token}` } });
  const msgs = [];
  const waitFor = (pred, ms = 5000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const hit = msgs.find(pred);
        if (hit) {
          clearInterval(iv);
          resolve(hit);
        } else if (Date.now() - t0 > ms) {
          clearInterval(iv);
          reject(new Error("timeout waiting for message"));
        }
      }, 20);
    });
  ws.on("message", (d) => msgs.push(JSON.parse(d)));
  const snap = await waitFor((m) => m.t === "snapshot");
  assert.strictEqual(snap.agents.Scout.today.in, 100);
  assert.strictEqual(snap.sessions[0].sid, "s1");

  fs.appendFileSync(f, line({ ts: now(), ev: "tool_start", profile: "scout", sid: "s1", tool: "terminal", call: "c1", args: "{\"command\": \"ls\"}" }));
  const live = await waitFor((m) => m.t === "evs" && m.evs.some((e) => e.ev === "tool_start"));
  assert.strictEqual(live.evs.find((e) => e.ev === "tool_start").agent, "Scout");
  // the same push carries the changed session's fresh summary and the agent table
  assert.strictEqual(live.sessions.find((s) => s.sid === "s1").curTool.tool, "terminal");
  assert.ok(live.agents.Scout);

  const detail = await (await fetch(`${base}/session/s1`, { headers: { authorization: `Bearer ${cfg.token}` } })).json();
  assert.strictEqual(detail.curTool.tool, "terminal");
  ws.close();

  // restart: rollups must stay at 100 (checkpoint), new lines still count
  await relay.stop();
  fs.appendFileSync(f, line({ ts: now(), ev: "llm", profile: "scout", sid: "s1", model: "grok-4.6", usage: { input_tokens: 5 } }));
  relay = await start({ ...cfg, port: 0 });
  const toks = await (await fetch(`http://127.0.0.1:${relay.port}/tokens?days=1`, { headers: { authorization: `Bearer ${cfg.token}` } })).json();
  assert.strictEqual(toks.reduce((a, r) => a + r.in, 0), 105);
  assert.strictEqual(relay.model.sessions.get("s1").curTool.tool, "terminal"); // state rebuilt by warm-up
});

test("relay refuses to start without a strong token", async () => {
  await assert.rejects(() => start({ token: "short" }), /DECK_RELAY_TOKEN/);
});

test("model: generation speed inputs only come from calls with a real duration", () => {
  const m = new Model(AGENTS);
  const base = { profile: "scout", ts: 1791146783 };
  m.apply({ ...base, ev: "llm", sid: "T", model: "m", usage: { in: 10, out: 500 }, dur: 10, ttfb: 2 }, true);
  m.apply({ ...base, ev: "llm", sid: "T", model: "m", usage: { in: 10, out: 100 } }, true); // no timing: ignored
  m.apply({ ...base, ev: "llm", sid: "T", model: "m", usage: { in: 10, out: 30 }, dur: 0.05 }, true); // too short to be meaningful
  m.apply({ ...base, ev: "llm", sid: "T", model: "m", usage: { in: 10, out: 300 }, dur: 5 }, true); // no ttfb: whole duration
  const s = m.sessions.get("T");
  assert.strictEqual(s.genOut, 800);
  assert.strictEqual(s.genSecs, 13); // (10 - 2) + 5
  assert.strictEqual(s.tokens.out, 930, "token totals still count every call");
  m.apply({ ...base, ev: "llm", sid: "U", model: "m", usage: { in: 1, out: 40 } }, true);
  assert.strictEqual(m.sessions.get("U").genOut, undefined);
});
