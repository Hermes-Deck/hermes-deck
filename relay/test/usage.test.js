"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Model } = require("../src/model");
const { Fleet } = require("../src/fleet");
const { localDay } = require("../src/util");
const { start } = require("../src/index");
const { HostUsage, errorKind } = require("../src/usage");

function dbFixture(file, now) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL, model TEXT, source TEXT,
    input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
    reasoning_tokens INTEGER, api_call_count INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL,
    billing_provider TEXT, cost_status TEXT, cost_source TEXT);
    CREATE TABLE session_model_usage (session_id TEXT, model TEXT, task TEXT, input_tokens INTEGER,
      output_tokens INTEGER, api_call_count INTEGER, estimated_cost_usd REAL);`);
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("fixture", now, "claude-example", "tui", 100, 20, 50, 10, 5, 2, 9, .5, "claude-subscription-directsdk-experimental", "estimated", "native");
  db.prepare("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?)").run("fixture", "claude-example", "", 100, 20, 2, 9);
  db.prepare("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?)").run("fixture", "vision-example", "vision", 7, 3, 1, .1);
  return db;
}

test("host usage: every profile/surface, actual zero wins, aux add-only, repeated refresh and events never double count", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-usage-"));
  const now = Date.now() / 1000;
  const root = path.join(dir, "hermes");
  const db = dbFixture(path.join(root, "state.db"), now);
  const named = dbFixture(path.join(root, "profiles", "other", "state.db"), now);
  named.prepare("UPDATE sessions SET source='webui', actual_cost_usd=0, estimated_cost_usd=12").run();
  fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify({ profiles: { default: { name: "Primary" } } }));
  const relay = await start({ host: "127.0.0.1", port: 0, token: "fixture-token-123456789012345", eventsDir: path.join(dir, "events"), stateDir: path.join(dir, "state"), dataDir: path.join(dir, "data"), agentsFile: path.join(dir, "agents.json"), hermesRoot: root, history: false, claudeDirs: [], tickMs: 100, broadcastWindowS: 300 });
  try {
    let rows = relay.model.tokens(7);
    assert.equal(rows.reduce((n, r) => n + r.in, 0), 214);
    assert.equal(rows.reduce((n, r) => n + r.usd, 0), .7);
    assert.equal(rows.find(r => r.agent === "other" && r.model === "claude-example").usd, 0);
    assert.equal(rows.find(r => r.model === "vision-example").estimated, true);
    assert.equal(rows.find(r => r.agent === "Primary" && r.model === "claude-example").cost_label, "API list-price equivalent");
    relay.model.apply({ ev: "llm", sid: "fixture", profile: "default", ts: now, usage: { in: 999 } }, true);
    relay.model.apply({ ev: "cost", sid: "fixture", profile: "default", ts: now, usd: 9, mode: "delta" }, true);
    assert.equal(relay.model.agents().Primary.today.in, 107);
    assert.equal(relay.model.agents().other.today.in, 107);
    relay.usage.refresh();
    assert.equal(relay.model.tokens(7).reduce((n, r) => n + r.in, 0), 214);
    db.prepare("UPDATE sessions SET input_tokens=150, actual_cost_usd=NULL, estimated_cost_usd=.8").run();
    relay.usage.refresh();
    rows = relay.model.tokens(7);
    assert.equal(rows.reduce((n, r) => n + r.in, 0), 264);
    assert.equal(rows.find(r => r.agent === "Primary" && r.model === "claude-example").usd, .8);
    assert.equal(rows.find(r => r.agent === "Primary" && r.model === "claude-example").estimated, true);
    const response = await fetch(`http://127.0.0.1:${relay.port}/snapshot`, { headers: { authorization: "Bearer fixture-token-123456789012345" } });
    const snap = await response.json();
    assert.equal(snap.agents.Primary.today.in, 157);
    assert.equal(snap.fleet.usage.source, "state.db");
    assert.equal(snap.tokens[0].day, localDay(now));
  } finally { await relay.stop(); db.close(); named.close(); fs.rmSync(dir, { recursive: true }); }
});

test("host usage: legacy schemas stay readable and failed profiles retain last good totals", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-usage-legacy-"));
  const file = path.join(dir, "state.db");
  const db = new DatabaseSync(file);
  const now = Date.now() / 1000;
  db.exec("CREATE TABLE sessions (id TEXT, model TEXT, started_at REAL, input_tokens INTEGER, output_tokens INTEGER)");
  db.prepare("INSERT INTO sessions VALUES ('legacy', 'legacy-model', ?, 10, 5)").run(now);
  db.close();
  const before = fs.readFileSync(file);
  try {
    const model = new Model({ profiles: {} });
    const usage = new HostUsage({ root: dir, model });
    usage.refresh(now);
    assert.equal(model.tokens(7, now)[0].in, 10);
    assert.equal(model.tokens(7, now)[0].unknownCost, 1);
    assert.deepEqual(fs.readFileSync(file), before);
    fs.writeFileSync(file, "not a database");
    usage.refresh(now);
    assert.equal(model.tokens(7, now)[0].in, 10);
    assert.equal(usage.status.profiles.default.stale, true);
    assert.equal(usage.status.profiles.default.error, "unavailable");
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("host usage: profiles sharing an agent label never overwrite each other's counters", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-usage-labels-"));
  const now = Date.now() / 1000;
  const db = dbFixture(path.join(dir, "state.db"), now);
  const named = dbFixture(path.join(dir, "profiles", "other", "state.db"), now);
  db.close(); named.close();
  try {
    const model = new Model({ profiles: { default: { name: "Primary" }, other: { name: "Primary" } } });
    const usage = new HostUsage({ root: dir, model });
    usage.refresh(now);
    assert.equal(model.tokens(7, now).reduce((n, r) => n + r.in, 0), 214);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("host usage: closed WAL stores never create source sidecars and active WAL counters remain visible", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-usage-wal-"));
  const file = path.join(dir, "state.db");
  const now = Date.now() / 1000;
  const writer = dbFixture(file, now);
  writer.exec("PRAGMA journal_mode=WAL");
  writer.close();
  const model = new Model({ profiles: {} });
  const usage = new HostUsage({ root: dir, model });
  try {
    assert.deepEqual(fs.readdirSync(dir), ["state.db"]);
    const before = fs.readFileSync(file);
    usage.refresh(now);
    assert.equal(model.tokens(7, now)[0].in, 100);
    assert.deepEqual(fs.readdirSync(dir), ["state.db"]);
    assert.deepEqual(fs.readFileSync(file), before);
    const live = new DatabaseSync(file);
    try {
      live.prepare("UPDATE sessions SET input_tokens=777").run();
      const originals = new Map(fs.readdirSync(dir).map(n => [n, fs.readFileSync(path.join(dir, n))]));
      usage.refresh(now);
      assert.equal(model.tokens(7, now)[0].in, 777);
      // -shm legitimately carries reader marks (every WAL reader updates it); db and -wal bytes must stay identical.
      for (const [n, content] of originals) {
        if (n.endsWith("-shm")) assert.equal(fs.statSync(path.join(dir, n)).size, content.length, n);
        else assert.deepEqual(fs.readFileSync(path.join(dir, n)), content, n);
      }
    } finally { live.close(); }
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("model: absolute cost snapshots never create sessions or change activity time", () => {
  const m = new Model({ profiles: { default: { name: "Primary" } } });
  const now = Date.now() / 1000;
  m.apply({ ev: "llm", sid: "active", profile: "default", ts: now - 10, usage: { in: 1 } }, true);
  m.apply({ ev: "llm", sid: "archived", profile: "default", ts: now - 30 * 86400, usage: { in: 1 } }, true);
  m.prune(now * 1000);
  for (const sid of ["active", "archived"]) m.apply({ ev: "cost", sid, profile: "default", ts: now, usd: .5, mode: "absolute", source: "state.db" }, true);
  assert.equal(m.sessions.has("archived"), false);
  assert.equal(m.sessions.get("active").lastTs, now - 10);
  assert.equal(m.agents(now).Primary.lastTs, now - 10);
  assert.equal(m.sessions.get("active").cost, .5);
});

test("host usage: midnight totals follow session start day including auxiliary tasks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-usage-day-"));
  const now = new Date(2030, 0, 2, 0, 5).getTime() / 1000;
  const previous = now - 600;
  const db = dbFixture(path.join(dir, "state.db"), previous);
  db.prepare("INSERT INTO sessions (id, started_at, model, input_tokens, actual_cost_usd) VALUES ('today', ?, 'example', 11, 0)").run(now);
  db.close();
  try {
    const model = new Model({ profiles: { default: { name: "Primary" } } });
    new HostUsage({ root: dir, model }).refresh(now);
    assert.equal(model.agents(now).Primary.today.in, 11);
    assert.equal(model.tokens(1, now).reduce((n, r) => n + r.in, 0), 11);
    assert.equal(model.tokens(7, now).filter(r => r.day === localDay(previous)).reduce((n, r) => n + r.in, 0), 107);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

const snapshotDir = dir => new Map(fs.readdirSync(dir).map(n => { const st = fs.statSync(path.join(dir, n)); return [n, `${st.size}:${st.mtimeMs}`]; }));

test("host usage: a store larger than the snapshot cap is read in place, never copied, sidecars untouched", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-usage-big-"));
  const file = path.join(dir, "state.db");
  const now = Date.now() / 1000;
  const writer = dbFixture(file, now);
  writer.exec("PRAGMA journal_mode=WAL");
  writer.prepare("UPDATE sessions SET input_tokens=100").run(); // first WAL write creates -wal and -shm
  const copy = fs.copyFileSync;
  let copies = 0;
  try {
    const model = new Model({ profiles: {} });
    // A 1-byte cap stands in for the 535 MB production store versus the 512 MiB default.
    const usage = new HostUsage({ root: dir, model, maxSnapshotBytes: 1 });
    const before = snapshotDir(dir);
    assert.ok(before.has("state.db-wal") && before.has("state.db-shm"), "live WAL store has both sidecars");
    fs.copyFileSync = (...args) => { copies++; return copy(...args); };
    usage.refresh(now);
    fs.copyFileSync = copy;
    assert.equal(copies, 0);
    assert.equal(usage.status.profiles.default.ok, true);
    assert.equal(usage.status.profiles.default.mode, "live-ro");
    assert.equal(model.tokens(7, now)[0].in, 100);
    assert.deepEqual(snapshotDir(dir), before, "no new files, unchanged size/mtime for db, -wal and -shm");
    // Counters written by the live writer (still only in the WAL) are visible without a checkpoint.
    writer.prepare("UPDATE sessions SET input_tokens=777").run();
    const afterWrite = snapshotDir(dir);
    usage.refresh(now);
    assert.equal(model.tokens(7, now)[0].in, 777);
    assert.deepEqual(snapshotDir(dir), afterWrite);
  } finally { fs.copyFileSync = copy; writer.close(); fs.rmSync(dir, { recursive: true }); }
});

test("host usage: a stopped store without WAL is read immutable and gains no files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-usage-immutable-"));
  const file = path.join(dir, "state.db");
  const now = Date.now() / 1000;
  const writer = dbFixture(file, now);
  writer.exec("PRAGMA journal_mode=WAL");
  writer.close(); // clean close checkpoints and removes -wal/-shm
  try {
    assert.deepEqual(fs.readdirSync(dir), ["state.db"]);
    const before = snapshotDir(dir);
    const model = new Model({ profiles: {} });
    const usage = new HostUsage({ root: dir, model, maxSnapshotBytes: 1 });
    usage.refresh(now);
    assert.equal(usage.status.profiles.default.mode, "immutable");
    assert.equal(model.tokens(7, now)[0].in, 100);
    assert.deepEqual(snapshotDir(dir), before);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("host usage: orphan -wal without -shm falls back to the bounded copy and reports too-large", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-usage-orphan-"));
  const file = path.join(dir, "state.db");
  const now = Date.now() / 1000;
  const writer = dbFixture(file, now);
  writer.exec("PRAGMA journal_mode=WAL");
  writer.close();
  fs.writeFileSync(`${file}-wal`, Buffer.alloc(0)); // sidecar left behind without -shm
  try {
    const model = new Model({ profiles: {} });
    const usage = new HostUsage({ root: dir, model });
    usage.refresh(now);
    assert.equal(usage.status.profiles.default.mode, "copy");
    assert.equal(model.tokens(7, now)[0].in, 100);
    const tooSmall = new HostUsage({ root: dir, model: new Model({ profiles: {} }), maxSnapshotBytes: 1 });
    tooSmall.refresh(now);
    assert.equal(tooSmall.status.profiles.default.ok, false);
    assert.equal(tooSmall.status.profiles.default.error, "too-large");
    assert.equal(tooSmall.status.profiles.default.stale, false);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

// Windows refuses to delete a -shm file the open writer still maps (EPERM), and deleting it is how this test forces
// the copy path; the hosts this covers run Linux/macOS and CI runs it there.
test("host usage: copy fallback keeps last good counters when the store changes mid-copy and removes private copies", { skip: process.platform === "win32" && "needs to delete a mapped -shm file" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-usage-race-"));
  const file = path.join(dir, "state.db");
  const now = Date.now() / 1000;
  const writer = dbFixture(file, now);
  writer.exec("PRAGMA journal_mode=WAL");
  writer.prepare("UPDATE sessions SET input_tokens=100").run();
  fs.rmSync(`${file}-shm`, { force: true }); // forces the copy path even while the writer is open
  const model = new Model({ profiles: {} });
  const usage = new HostUsage({ root: dir, model });
  const copy = fs.copyFileSync;
  try {
    const destinations = [];
    fs.copyFileSync = (source, target) => {
      destinations.push(path.dirname(target));
      copy(source, target);
      writer.prepare("UPDATE sessions SET input_tokens=777").run();
    };
    usage.refresh(now);
    fs.copyFileSync = copy;
    assert.ok(destinations.length > 0, "copy path was exercised");
    assert.equal(usage.status.profiles.default.ok, false);
    assert.equal(usage.status.profiles.default.error, "locked");
    assert.ok(destinations.every(p => !fs.existsSync(p)));
  } finally { fs.copyFileSync = copy; if (writer.isOpen) writer.close(); fs.rmSync(dir, { recursive: true }); }
});

test("host usage: failure kinds (missing, schema, unavailable) are distinguished and stale cache survives", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-usage-kinds-"));
  const file = path.join(dir, "state.db");
  const now = Date.now() / 1000;
  dbFixture(file, now).close();
  try {
    const model = new Model({ profiles: {} });
    const usage = new HostUsage({ root: dir, model });
    usage.refresh(now);
    assert.equal(usage.status.profiles.default.ok, true);
    assert.equal(usage.status.profiles.default.updatedAt, now);
    // Replace the store by one without a sessions table: schema.
    fs.rmSync(file);
    const bad = new DatabaseSync(file); bad.exec("CREATE TABLE other (a)"); bad.close();
    usage.refresh(now + 60);
    const state = usage.status.profiles.default;
    assert.deepEqual([state.ok, state.error, state.stale, state.updatedAt], [false, "schema", true, now]);
    assert.equal(model.tokens(7, now)[0].in, 100);
    // Direct read of a vanished profile reports missing.
    fs.rmSync(file);
    assert.throws(() => usage.read("default", now), e => errorKind(e) === "missing");
    assert.equal(errorKind(Object.assign(new Error("database is locked"), { errcode: 5 })), "locked");
    assert.equal(errorKind(new Error("boom")), "unavailable");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("fleet: state quotas survive without CodexBar, freshest snapshot wins, stale values marked", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-quota-"));
  try {
    const q = (used, fetched_at) => ({ provider: "claude", ok: true, fetched_at, windows: [{ minutes: 300, used, resetsAt: "2030-01-01T00:00:00Z" }] });
    fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify({ ts: Date.now() / 1000, quotas: { claude: q(25, Date.now() / 1000) } }));
    fs.writeFileSync(path.join(dir, "z.json"), JSON.stringify({ ts: 1, quotas: { claude: q(90, 1), codex: { provider: "codex", ok: false, error: "unavailable" } } }));
    const fleet = new Fleet({ stateDir: dir, codexbar: null });
    fleet.readSnapshots(); fleet.readQuotas();
    assert.equal(fleet.data.quotas.claude.windows[0].used, 25);
    assert.equal(fleet.data.profiles.z.quotas.claude.stale, true);
    assert.equal(fleet.data.quotas.codex.error, "unavailable");
    assert.equal(fleet.data.quotas.codex.source, "hermes-account-usage");
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("model: per-call costs accumulate independently of legacy cumulative counters", () => {
  const m = new Model({ profiles: { default: { name: "Primary" } } });
  for (const usd of [.25, .1, .25]) m.apply({ ev: "cost", sid: "s", profile: "default", ts: Date.now() / 1000, usd, mode: "delta", cost_label: "API list-price equivalent" }, true);
  assert.equal(m.sessions.get("s").cost, .6);
  assert.equal(m.sessions.get("s").cost_label, "API list-price equivalent");
  m.apply({ ev: "cost", sid: "s", profile: "default", ts: Date.now() / 1000, usd: .4, mode: "absolute", source: "state.db" }, true);
  assert.equal(m.sessions.get("s").cost, .4);
  assert.equal(m.tokens(7)[0].usd, .6); // persisted display snapshots are never another rollup source
});

test("fleet.refreshQuotas: writes the trigger, resolves on plugin acks, rate-limits to 30 s", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-quota-refresh-"));
  try {
    const nowS = () => Date.now() / 1000;
    const snap = (extra) => JSON.stringify({ ts: nowS(), quotas: { claude: { provider: "claude", ok: true, fetched_at: nowS(), windows: [{ minutes: 300, used: 10 }] } }, ...extra });
    fs.writeFileSync(path.join(dir, "a.json"), snap({ quota_refresh: null }));   // plugin 2.6, never refreshed
    fs.writeFileSync(path.join(dir, "old.json"), JSON.stringify({ ts: nowS(), quotas: { claude: { provider: "claude", ok: true, fetched_at: nowS(), windows: [] } } })); // plugin < 2.6: not awaited
    const fleet = new Fleet({ stateDir: dir, codexbar: null });
    let clock = 1_000_000_000_000;
    const now = () => clock;
    // the "plugin": acknowledges the trigger a moment after it appears
    const ack = setTimeout(() => {
      const trig = JSON.parse(fs.readFileSync(path.join(dir, "quota-refresh.json"), "utf8"));
      fs.writeFileSync(path.join(dir, "a.json"), snap({ quota_refresh: { id: trig.id } }));
    }, 60);
    const real = Date.now; // keep wall clock for snapshot staleness; the injected clock only drives throttling
    const first = await fleet.refreshQuotas({ now: () => real() + 0, timeoutMs: 3000, pollMs: 20 });
    clearTimeout(ack);
    assert.equal(first.refreshed, true); assert.equal(first.throttled, false); assert.equal(first.timedOut, false);
    assert.equal(fleet.data.profiles.a.quota_refresh.id > 0, true);
    assert.equal(Object.keys(fleet.data.profiles).includes("quota-refresh"), false, "the trigger file is not a profile snapshot");
    const second = await fleet.refreshQuotas({ now: () => real() + 0, timeoutMs: 3000, pollMs: 20 });
    assert.equal(second.throttled, true); assert.equal(second.refreshed, false);
    assert.ok(second.retryAfterS >= 1 && second.retryAfterS <= 30);
    const later = await fleet.refreshQuotas({ now: () => real() + 31_000, timeoutMs: 200, pollMs: 20 }); // nobody acks this one
    assert.equal(later.timedOut, true); assert.equal(later.throttled, false);
    void clock; void now;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("fleet.refreshQuotas: concurrent callers share one refresh; no live plugin resolves at once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-quota-refresh-"));
  try {
    const fleet = new Fleet({ stateDir: dir, codexbar: null });
    const [a, b] = await Promise.all([fleet.refreshQuotas({ timeoutMs: 500, pollMs: 10 }), fleet.refreshQuotas({ timeoutMs: 500, pollMs: 10 })]);
    assert.equal(a, b);
    assert.equal(a.refreshed, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
