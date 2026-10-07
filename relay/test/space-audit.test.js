"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { SpaceAudit } = require("../src/space-audit");
const tempRoot = path.join(__dirname, ".tmp-audit");
test.after(() => fs.rmdirSync(tempRoot));
function rig(t, opts = {}) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, "space-audit-"));
  const a = new SpaceAudit({ dataDir: dir, env: {}, ...opts });
  t.after(async () => { await a.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, a };
}
const typed = (text, extra = {}) => ({ profile: "agent1", host: "agent-host", tool: "type_text", args: { text }, outcome: "ok", duration: 3, ...extra });

test("audit never waits for storage; failure warns once", async (t) => {
  let rejectWrite;
  const warnings = [];
  const io = { ...fs.promises, appendFile: () => new Promise((_, reject) => { rejectWrite = reject; }) };
  const { a } = rig(t, { io, warn: (s) => warnings.push(s) });
  assert.equal(a.record(typed("private")), undefined);
  while (!rejectWrite) await new Promise(setImmediate);
  assert.equal(a.record(typed("still works")), undefined);
  rejectWrite(new Error("disk full with private path"));
  await a.flush();
  a.record(typed("third"));
  await a.flush();
  assert.equal(warnings.length, 1);
  assert.equal(a.settings().loggingPaused, true);
  assert.doesNotMatch(warnings[0], /private path/);
});

test("masking, opt-in text, approvals, outcome and same-time paging", async (t) => {
  const { a, dir } = rig(t, { now: () => 1_800_000_000_000 });
  a.record(typed("private", { args: { text: "private", token: "secret" } }));
  a.update({ typedText: true });
  a.record(typed("x".repeat(230)));
  a.update({ typedText: false });
  a.record(typed("sudo whoami", { outcome: "approval", command: "sudo whoami" }));
  await a.flush();
  const first = await a.page("agent1", { limit: 2 });
  const second = await a.page("agent1", { before: first.next, limit: 2 });
  assert.equal(first.records.length, 2);
  assert.equal(second.records.length, 1);
  assert.equal(first.records[0].command, "sudo whoami");
  assert.equal(first.records[1].summary.text.length, 200);
  assert.deepEqual(second.records[0].summary, { length: 7 });
  assert.doesNotMatch(JSON.stringify(second), /private|secret|token/);
  assert.equal(new SpaceAudit({ dataDir: dir, env: {} }).settings().typedText, false);
  assert.throws(() => a.update({ days: 0 }), /bad settings/);
  assert.throws(() => a.update({ screenshots: "yes" }), /bad settings/);
  assert.throws(() => a.update({ extra: true }), /bad settings/);
  assert.equal(new SpaceAudit({ dataDir: dir, env: { DECK_AUDIT: "0" } }).settings().audit, false);
});

test("frames keep original bytes; count, byte caps and retention remove oldest", async (t) => {
  let now = 1_800_000_000_000;
  const { a } = rig(t, { now: () => now, maxFrames: 2, maxFrameBytes: 5 });
  const image = (s) => ({ content: [{ type: "image", mimeType: "image/png", data: Buffer.from(s).toString("base64") }] });
  for (const s of ["aa", "bb", "cc"]) a.record(typed("", { result: image(s) }));
  await a.flush();
  const rows = (await a.page("agent1")).records;
  assert.deepEqual((await a.frame("agent1", rows[0].frame)).bytes, Buffer.from("cc"));
  assert.equal(await a.frame("agent1", rows[2].frame), null);
  a.update({ screenshots: false });
  a.record(typed("", { result: image("dd") }));
  await a.flush();
  assert.equal((await a.page("agent1")).records[0].frame, null);
  now += 8 * 86400_000;
  await a.cleanup();
  assert.equal((await a.page("agent1")).records.length, 0);
  assert.equal(await a.frame("agent1", rows[0].frame), null);
  await assert.rejects(a.page("../escape"), /bad profile/);
  assert.equal(await a.frame("agent1", "../file"), null);
});

test("queue overflow defers a slow warning and contains sink failures", async (t) => {
  let warnings = 0;
  const { a } = rig(t, { maxQueueBytes: 1, warn: () => {
    warnings++;
    const end = performance.now() + 50;
    while (performance.now() < end) {}
    throw new Error("warning sink failed");
  } });
  const start = performance.now();
  assert.equal(a.record(typed("overflow")), undefined);
  assert.ok(performance.now() - start < 40, "record must not wait for the 50 ms warning sink");
  assert.equal(warnings, 0, "warning delivery must be deferred");
  a.record(typed("ignored"));
  await new Promise(setImmediate);
  assert.equal(warnings, 1);
  assert.equal(a.settings().loggingPaused, true);
  const { a: rejecting } = rig(t, { maxQueueBytes: 1, warn: async () => { throw new Error("async sink failed"); } });
  rejecting.record(typed("overflow"));
  await new Promise(setImmediate);
});

test("unknown profiles cannot read existing audit data or touch storage", async (t) => {
  const { a, dir } = rig(t);
  a.record(typed("", { result: { content: [{ type: "image", mimeType: "image/png", data: "YQ==" }] } }));
  await a.flush();
  const id = (await a.page("agent1")).records[0].frame;
  let reads = 0;
  const denied = async () => { reads++; throw new Error("unexpected storage access"); };
  const restricted = new SpaceAudit({ dataDir: dir, env: {}, known: (p) => p === "agent2",
    io: { ...fs.promises, readdir: denied, readFile: denied } });
  assert.deepEqual(await restricted.page("agent1"), { records: [], next: null });
  assert.equal(await restricted.frame("agent1", id), null);
  assert.equal(reads, 0);
  const allowed = new SpaceAudit({ dataDir: dir, env: {}, known: (p) => p === "agent1" });
  assert.equal((await allowed.page("agent1")).records.length, 1);
  assert.deepEqual((await allowed.frame("agent1", id)).bytes, Buffer.from("a"));
  await assert.rejects(restricted.page("../escape"), /bad profile/);
});

test("approval text survives without command, capped at 200; supplied command wins", async (t) => {
  const { a } = rig(t, { now: () => 1_800_000_000_000 });
  a.record(typed("x".repeat(230), { outcome: "approval" }));
  a.record(typed("partial", { outcome: "approval", command: "complete command" }));
  await a.flush();
  const rows = (await a.page("agent1")).records;
  assert.deepEqual(rows[1].summary, { length: 230, text: "x".repeat(200) });
  assert.equal(rows[0].command, "complete command");
  assert.deepEqual(rows[0].summary, { length: 7 });
});

test("queue snapshots validated fields without retaining caller objects or image extras", async (t) => {
  const { a } = rig(t, { maxQueueBytes: 4096 });
  const img = { type: "image", mimeType: "image/png", data: "YQ==", extra: "x".repeat(9_000_000) };
  const call = typed("private", { host: { extra: "invalid host" }, outcome: { extra: "invalid outcome" },
    result: { content: [img] } });
  a.record(call);
  assert.equal(a.queue.length, 1);
  assert.ok(a.queue[0].img !== img, "the caller's image object must not be retained");
  assert.equal(a.queue[0].img.extra, undefined);
  assert.notStrictEqual(a.queue[0].row.host, call.host);
  assert.notStrictEqual(a.queue[0].row.outcome, call.outcome);
  img.data = "Yg==";
  await a.flush();
  const row = (await a.page("agent1")).records[0];
  assert.deepEqual((await a.frame("agent1", row.frame)).bytes, Buffer.from("a"));
  assert.equal(row.host, undefined);
  assert.equal(row.outcome, undefined);
});

test("queue budget includes image metadata, decoded bytes, text and identifiers", async (t) => {
  const { a } = rig(t);
  const call = typed("text", { command: "approved command", result: {
    content: [{ type: "image", mimeType: "image/png", data: "YQ==" }]
  } });
  a.record(call);
  const entry = a.queue[0];
  const payloadBytes = JSON.stringify(entry.row).length * 2 + ("image/png".length + "YQ==".length) * 2 + 1;
  assert.ok(a.queued >= payloadBytes, "all retained image fields and decoded bytes must count");
  for (const field of ["host", "command", "outcome"]) {
    const { a: bounded } = rig(t, { maxQueueBytes: 4096, warn: () => {} });
    bounded.record(typed("", { [field]: "x".repeat(4096) }));
    assert.equal(bounded.settings().loggingPaused, true, `${field} must count against the budget`);
    assert.equal(bounded.queue.length, 0);
  }
});

test("failed frame metadata writes remove the just-written frame", async (t) => {
  const io = { ...fs.promises, writeFile: async (file, ...args) => {
    if (file.endsWith(".json")) throw new Error("metadata write failed");
    return fs.promises.writeFile(file, ...args);
  } };
  const { a, dir } = rig(t, { io, warn: () => {} });
  a.record(typed("", { result: { content: [{ type: "image", mimeType: "image/png", data: "YQ==" }] } }));
  await a.flush();
  assert.equal(a.settings().loggingPaused, true);
  assert.deepEqual(fs.readdirSync(path.join(dir, "audit", "agent1", "frames")), []);
});

test("cleanup removes orphan frames alongside retention and frame caps", async (t) => {
  let now = 1_800_000_000_000;
  const { a, dir } = rig(t, { now: () => now, maxFrames: 1, maxFrameBytes: 2 });
  for (const data of ["YQ==", "Yg=="]) a.record(typed("", { result: { content: [{ type: "image", mimeType: "image/png", data }] } }));
  await a.flush();
  const frames = path.join(dir, "audit", "agent1", "frames");
  const old = crypto.randomUUID(), recent = crypto.randomUUID();
  fs.writeFileSync(path.join(frames, old), "old orphan");
  fs.utimesSync(path.join(frames, old), new Date(now - 8 * 86400_000), new Date(now - 8 * 86400_000));
  fs.writeFileSync(path.join(frames, recent), "recent orphan exceeding the byte cap");
  await a.cleanup();
  assert.equal(fs.existsSync(path.join(frames, old)), false);
  assert.equal(fs.existsSync(path.join(frames, recent)), false);
  assert.equal(fs.readdirSync(frames).length, 2, "one valid frame and its metadata remain");
  now += 8 * 86400_000;
  await a.cleanup();
  assert.deepEqual(fs.readdirSync(frames), []);
});

test("cleanup recovers a partial metadata write when immediate removal fails", async (t) => {
  let allowRemoval = false;
  const io = { ...fs.promises, writeFile: async (file, ...args) => {
    if (!file.endsWith(".json")) return fs.promises.writeFile(file, ...args);
    await fs.promises.writeFile(file, "{");
    throw new Error("partial metadata write");
  }, rm: async (...args) => {
    if (!allowRemoval) throw new Error("temporary removal failure");
    return fs.promises.rm(...args);
  } };
  const { a, dir } = rig(t, { io, warn: () => {} });
  a.record(typed("", { result: { content: [{ type: "image", mimeType: "image/png", data: "YQ==" }] } }));
  await a.flush();
  const frames = path.join(dir, "audit", "agent1", "frames");
  assert.equal(fs.readdirSync(frames).length, 2);
  allowRemoval = true;
  await a.cleanup();
  assert.deepEqual(fs.readdirSync(frames), []);
});

test("cleanup preserves a frame whose metadata write is still in flight", async (t) => {
  let release;
  const io = { ...fs.promises, writeFile: async (file, ...args) => {
    if (file.endsWith(".json")) await new Promise((resolve) => { release = resolve; });
    return fs.promises.writeFile(file, ...args);
  } };
  const { a, dir } = rig(t, { io });
  a.record(typed("", { result: { content: [{ type: "image", mimeType: "image/png", data: "YQ==" }] } }));
  try {
    while (!release) await new Promise(setImmediate);
    await a.cleanup();
    assert.equal(fs.readdirSync(path.join(dir, "audit", "agent1", "frames")).length, 1);
  } finally { release(); await a.flush(); }
  const row = (await a.page("agent1")).records[0];
  assert.deepEqual((await a.frame("agent1", row.frame)).bytes, Buffer.from("a"));
});

test("DECK_AUDIT_DAYS clamps numeric values and defaults absent or non-numeric values", async (t) => {
  for (const [value, want] of [["0", 1], ["-1", 1], ["91", 90], ["999", 90],
    [undefined, 7], ["", 7], ["invalid", 7], ["Infinity", 7], ["1", 1], ["90", 90], ["2.5", 2]]) {
    await t.test(String(value), (t) => {
      const { a } = rig(t, { env: value === undefined ? {} : { DECK_AUDIT_DAYS: value } });
      assert.equal(a.settings().days, want);
    });
  }
});
