"use strict";
// Token pane ranges: rolling 24 h (5-minute rollups), 7/14/30 local days, and "all" (day rollups + month archive).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Model, weekOf, FINE_KEEP_S } = require("../src/model");
const { HostUsage } = require("../src/usage");
const { localDay } = require("../src/util");
const { start } = require("../src/index");

const AGENTS = { profiles: { default: { name: "Primary" } } };
const sum = (rows, k = "in") => rows.reduce((n, r) => n + (r[k] || 0), 0);
const llm = (m, ts, n, sid = "s") => m.apply({ ev: "llm", sid, profile: "default", ts, model: "model-a", usage: { in: n, out: 1 } }, true);

function store(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER, api_call_count INTEGER, actual_cost_usd REAL);
    CREATE INDEX idx_sessions_started ON sessions(started_at);`);
  const ins = db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)");
  rows.forEach(([id, ts, n], i) => ins.run(id || `s${i}`, ts, "model-a", n, 0, 0, 0, 1, 0));
  db.close();
}

test("tokens range: 24 h is a rolling window, not today", () => {
  const m = new Model(AGENTS);
  const now = new Date(2030, 0, 2, 9, 0).getTime() / 1000; // 09:00 local
  llm(m, now - 25 * 3600, 1000, "old"); // yesterday 08:00: outside the rolling window
  llm(m, now - 23 * 3600, 100, "y"); // yesterday 10:00: inside 24 h, not "today"
  llm(m, now - 600, 10, "t");
  const r = m.tokensRange("24h", now);
  assert.equal(r.bucket, "hour");
  assert.equal(r.from, now - 86400);
  assert.equal(sum(r.rows), 110);
  assert.ok(r.rows.every(x => typeof x.t === "number" && x.t % 60 === 0), "hour buckets are epoch hour starts");
  assert.equal(new Date(r.rows.at(-1).t * 1000).getHours(), 10);
  // today only would be 10; 7d includes yesterday's whole day
  assert.equal(sum(m.tokensRange("7d", now).rows), 1110);
  assert.equal(m.agents(now).Primary.today.in, 10);
});

test("tokens range: day ranges are N local days including today; edges are exact", () => {
  const m = new Model(AGENTS);
  const now = new Date(2030, 0, 31, 0, 5).getTime() / 1000; // just after midnight
  for (let d = 0; d < 40; d++) llm(m, new Date(2030, 0, 31 - d, 12, 0).getTime() / 1000, 1, `d${d}`);
  llm(m, now - 60, 5, "late"); // 00:04, today
  for (const [range, days] of [["7d", 7], ["14d", 14], ["30d", 30]]) {
    const r = m.tokensRange(range, now);
    assert.equal(r.bucket, "day");
    assert.equal(new Set(r.rows.map(x => x.t)).size, days, range);
    assert.equal(r.from, new Date(2030, 0, 31 - days + 1).getTime() / 1000, range);
    assert.equal(sum(r.rows), days + 5, range);
  }
  assert.equal(m.tokensRange("7d", now).rows[0].t, localDay(now), "newest first");
});

test("tokens range: all uses weeks for short histories, months for long ones, and reports the data start", () => {
  const m = new Model(AGENTS);
  const now = new Date(2030, 5, 15, 12).getTime() / 1000;
  llm(m, new Date(2030, 4, 1, 12).getTime() / 1000, 7, "a");
  llm(m, now, 3, "b");
  let r = m.tokensRange("all", now);
  assert.equal(r.bucket, "week");
  assert.equal(r.since, new Date(2030, 4, 1).getTime() / 1000);
  assert.equal(sum(r.rows), 10);
  assert.ok(r.rows.some(x => x.t === weekOf("2030-05-01")));
  assert.equal(weekOf("2030-05-01"), "2030-04-29", "weeks start on Monday");
  llm(m, new Date(2029, 0, 10, 12).getTime() / 1000, 100, "c");
  r = m.tokensRange("all", now);
  assert.equal(r.bucket, "month");
  assert.deepEqual([...new Set(r.rows.map(x => x.t))].sort(), ["2029-01", "2030-05", "2030-06"]);
  assert.equal(sum(r.rows), 110);
  assert.throws(() => m.tokensRange("90d", now), /bad range/);
});

test("tokens range: prune folds day rollups older than 400 days into months (All keeps them) and trims 5-minute slots", () => {
  const m = new Model(AGENTS);
  const now = Date.now();
  const old = now / 1000 - 500 * 86400;
  llm(m, old, 40, "old");
  llm(m, now / 1000 - 3 * 86400, 2, "mid");
  llm(m, now / 1000 - 60, 1, "new");
  m.prune(now);
  assert.equal(sum(m.tokens(400)), 3, "old day rollup left the day table");
  assert.equal(Object.keys(m.months).length, 1);
  assert.equal(sum(m.tokensRange("all").rows), 43, "...but All still counts it");
  assert.ok(Object.keys(m.fine).every(k => Number(k.split("\t")[0]) >= now / 1000 - FINE_KEEP_S));
  assert.equal(sum(m.tokensRange("24h").rows), 1);
  m.prune(now); // idempotent: folding twice never double counts
  assert.equal(sum(m.tokensRange("all").rows), 43);
});

test("host usage: state.db feeds the rolling 24 h by session start and All beyond the 400-day scan bound", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-range-"));
  const now = new Date(2030, 0, 2, 9, 0).getTime() / 1000;
  store(path.join(dir, "state.db"), [["recent", now - 3600, 10], ["edge", now - 23 * 3600, 100], ["outside", now - 30 * 3600, 1000], ["ancient", now - 600 * 86400, 5000]]);
  try {
    const model = new Model(AGENTS);
    const usage = new HostUsage({ root: dir, model });
    usage.refresh(now);
    assert.equal(sum(model.tokensRange("24h", now).rows), 110);
    assert.equal(sum(model.tokens(400, now)), 1110, "the per-minute day scan stays bounded");
    const all = model.tokensRange("all", now);
    assert.equal(sum(all.rows), 6110);
    assert.equal(all.since, now - 600 * 86400);
    assert.equal(all.bucket, "month");
    // a minute later the archive is not rescanned but still counted
    const spy = usage.query.bind(usage);
    const seen = [];
    usage.query = (loc, p, t, archive, dayFrom) => { seen.push(archive); return spy(loc, p, t, archive, dayFrom); };
    usage.refresh(now + 60);
    assert.deepEqual(seen, [false]);
    assert.equal(sum(model.tokensRange("all", now + 60).rows), 6110);
    usage.refresh(now + 6 * 3600 + 60);
    assert.deepEqual(seen, [false, true], "the archive is rebuilt every few hours");
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("host usage: a session crossing the 400-day line between archive rebuilds is counted exactly once in All", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-range-cross-"));
  const now = new Date(2030, 5, 1, 12).getTime() / 1000;
  store(path.join(dir, "state.db"), [["crossing", now - 399.9 * 86400, 7], ["recent", now - 60, 1], ["ancient", now - 700 * 86400, 100]]);
  try {
    const model = new Model(AGENTS);
    const usage = new HostUsage({ root: dir, model });
    usage.refresh(now); // archive built: "crossing" is in the day scan
    assert.equal(sum(model.tokensRange("all", now).rows), 108);
    for (const later of [now + 0.2 * 86400, now + 0.24 * 86400]) { // no rebuild yet; "crossing" is now > 400 days old
      usage.refresh(later);
      assert.equal(sum(model.tokensRange("all", later).rows), 108, "neither lost nor doubled");
    }
    usage.refresh(now + 0.3 * 86400); // rebuilt: "crossing" moved into the month archive
    assert.equal(sum(model.tokensRange("all", now + 0.3 * 86400).rows), 108);
    assert.equal(sum(Object.values(model.usageMonths)), 107);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("relay HTTP: /tokens?range validates and old ?days callers keep the array shape", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-range-http-"));
  const token = "fixture-token-123456789012345";
  const relay = await start({ host: "127.0.0.1", port: 0, token, eventsDir: path.join(dir, "events"), stateDir: path.join(dir, "state"), dataDir: path.join(dir, "data"), agentsFile: path.join(dir, "agents.json"), history: false, claudeDirs: [], tickMs: 1000, broadcastWindowS: 300 });
  const get = async q => { const r = await fetch(`http://127.0.0.1:${relay.port}/tokens${q}`, { headers: { authorization: `Bearer ${token}` } }); return [r.status, await r.json()]; };
  try {
    llm(relay.model, Date.now() / 1000 - 60, 9);
    for (const range of ["24h", "7d", "14d", "30d", "all"]) {
      const [code, body] = await get(`?range=${range}`);
      assert.equal(code, 200, range);
      assert.equal(body.range, range);
      assert.equal(sum(body.rows), 9, range);
    }
    for (const bad of ["", "1d", "all;", "24H", "365d"]) assert.equal((await get(`?range=${encodeURIComponent(bad)}`))[0], 400, bad);
    const [code, legacy] = await get("?days=7");
    assert.equal(code, 200);
    assert.ok(Array.isArray(legacy) && legacy[0].day === localDay(Date.now() / 1000));
  } finally { await relay.stop(); fs.rmSync(dir, { recursive: true }); }
});

test("relay checkpoint: 5-minute and month rollups survive a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-range-cp-"));
  const cfg = { host: "127.0.0.1", port: 0, token: "fixture-token-123456789012345", eventsDir: path.join(dir, "events"), stateDir: path.join(dir, "state"), dataDir: path.join(dir, "data"), agentsFile: path.join(dir, "agents.json"), history: false, claudeDirs: [], tickMs: 1000, broadcastWindowS: 300 };
  let relay = await start(cfg);
  try {
    llm(relay.model, Date.now() / 1000 - 60, 4);
    relay.model.months["2020-01\tPrimary\tmodel-a"] = { n: 1, in: 50, cr: 0, cw: 0, out: 0, rs: 0, usd: 0 };
    await relay.stop();
    relay = await start(cfg);
    assert.equal(sum(relay.model.tokensRange("24h").rows), 4);
    assert.equal(sum(relay.model.tokensRange("all").rows), 54);
  } finally { await relay.stop(); fs.rmSync(dir, { recursive: true }); }
});
