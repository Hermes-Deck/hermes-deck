"use strict";
// Agent browsers (agent-browser.js): a cold start, a quit while a browser starts, and a read-only screenshot
// run. A stand-in (fixtures/fake-browser.js) plays Chrome: it reports its port after a delay. No browser runs.
//   node --test "app/test/*.test.js"
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AgentBrowserHost } = require("../main/agent-browser");
const { setLanguage } = require("../renderer/i18n");
setLanguage("tr");

const FAKE = path.join(__dirname, "fixtures", "fake-browser.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function setup({ delay = 0, launchMs = 10_000, waitMs = 10_000, readOnly = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-ab-"));
  const log = path.join(root, "starts.log");
  const exe = { path: process.execPath, kind: "Chrome", prefix: [FAKE, `--fake-delay=${delay}`, `--fake-log=${log}`] };
  const host = new AgentBrowserHost({ root, enabled: true, exe, launchMs, waitMs, readOnly });
  const starts = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);
  const done = () => {
    host.killAll();
    for (const pid of starts()) if (alive(pid)) process.kill(pid, "SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { host, starts, done };
}

test("agent browser: a quit while Chrome is still starting kills it (no orphan keeps the Deck's quit waiting)", { timeout: 20_000 }, async () => {
  const { host, starts, done } = setup({ delay: 5000 });
  try {
    const p = host.ensure("scout");
    p.catch(() => {});
    for (let i = 0; i < 100 && !starts().length; i++) await sleep(20);
    const [pid] = starts();
    assert.ok(pid && alive(pid), "the browser was started");
    assert.ok(host.peek("scout").launching, "the starting process is known before it reports its port");
    host.killAll(); // workspace.js will-quit
    await assert.rejects(p);
    for (let i = 0; i < 100 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "the starting browser is gone");
    // nothing starts once the deck is quitting
    await assert.rejects(host.get("scout").start(), /Deck kapanıyor/);
    assert.equal(starts().length, 1);
  } finally {
    done();
  }
});

test("agent browser: a cold start longer than the relay's wait answers in time and keeps starting for the retry", { timeout: 20_000 }, async () => {
  const { host, starts, done } = setup({ delay: 2500, waitMs: 300, launchMs: 10_000 });
  try {
    const t0 = Date.now();
    await assert.rejects(host.ensure("scout"), /0 sn içinde açılmadı; açılmayı sürdürüyor/);
    assert.ok(Date.now() - t0 < 2000, "the caller is answered at waitMs, not when Chrome is up");
    assert.equal(host.peek("scout").status, "starting");
    for (let i = 0; i < 400 && host.peek("scout").status !== "running"; i++) await sleep(25);
    const r = await host.ensure("scout"); // the retry finds the same browser running
    assert.deepEqual(r, { port: 45678, wsPath: "/devtools/browser/fake-0000" });
    assert.equal(starts().length, 1, "one launch, not one per attempt");
  } finally {
    done();
  }
});

test("agent browser: a browser that never reports its port fails with a clear message and is killed", { timeout: 20_000 }, async () => {
  const { host, starts, done } = setup({ delay: 60_000, launchMs: 1000 });
  try {
    await assert.rejects(host.ensure("scout"), /tarayıcı 1 sn içinde açılmadı/);
    const b = host.peek("scout");
    assert.equal(b.status, "error");
    assert.match(b.error, /1 sn içinde açılmadı/);
    const [pid] = starts();
    for (let i = 0; i < 100 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false);
  } finally {
    done();
  }
});

test("agent browser: a read-only screenshot run shows the user's switch and never starts a browser", async () => {
  const { host, starts, done } = setup({ readOnly: true });
  try {
    assert.equal(host.allowed, true, "the switch as device.json has it");
    assert.equal(host.enabled(), false, "but nothing hosts");
    await assert.rejects(host.ensure("scout"), /Ekran görüntüsü modunda/);
    assert.equal(starts().length, 0);
  } finally {
    done();
  }
});
