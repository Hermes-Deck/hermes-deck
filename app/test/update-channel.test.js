"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { UpdateChecker } = require("../main/update-check");
const REPO = "Hermes-Deck/hermes-deck";
const bytes = Buffer.from("synthetic installer");
const digest = crypto.createHash("sha256").update(bytes).digest("hex");
function release(testChannel = false, overrides = {}) {
  return { id: testChannel ? 12 : 11, tag_name: testChannel ? "v1.0.0-test.2" : "v1.0.0", prerelease: testChannel, draft: false,
    published_at: "2026-01-02T00:00:00Z", assets: [{ id: 21, name: "Hermes-Deck-1.0.0-Setup.exe" }, { id: 22, name: "SHA256SUMS.txt" }], ...overrides };
}
function fixture(t, { channel, info = {}, platform = "win32", arch = "x64", installSupported = true } = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-channel-"));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const state = { settings: { channel, auto: false, host: false, repo: "example/fork", branch: "other", fromSource: true }, stable: release(), tests: [release(true)], calls: [], ran: [], sum: digest };
  const c = new UpdateChecker({ version: "1.0.0", info: { commit: "a".repeat(40), branch: "main", repo: REPO, ...info }, settings: () => state.settings,
    platform, arch, workDir, installSupported, token: async () => "", has: async () => true,
    run: async (...args) => { state.ran.push(args); return { code: 0, out: "" }; },
    fetch: async (url) => {
      state.calls.push(url);
      assert.ok(url.startsWith(`https://api.github.com/repos/${REPO}/`));
      let value;
      if (url.includes("/compare/")) value = { ahead_by: 3, behind_by: 0, commits: [{ sha: "b".repeat(40) }] };
      else if (url.endsWith("/releases/latest") || url.endsWith("/releases/11")) value = state.stable;
      else if (url.endsWith("/releases?per_page=100")) value = state.tests;
      else if (url.endsWith("/releases/12")) value = state.tests.find(r => r.id === 12);
      else if (url.endsWith("/assets/21")) value = bytes;
      else if (url.endsWith("/assets/22")) value = `${state.sum}  Hermes-Deck-1.0.0-Setup.exe\n`;
      else throw new Error(`unexpected URL ${url}`);
      return { ok: !!value, status: value ? 200 : 404, json: async () => value, text: async () => value, arrayBuffer: async () => value };
    } });
  return { c, state };
}
test("channel defaults stable, uses only canonical main and never installs on check", async t => {
  const { c, state } = fixture(t);
  const st = await c.check();
  assert.equal(st.channel, "stable");
  assert.equal(st.branch, "main");
  assert.equal(st.repo, REPO);
  assert.equal(state.ran.length, 0);
  assert.ok(state.calls.some(u => u.endsWith("/releases/latest")));
});
test("Test selects a published test prerelease, not arbitrary prereleases or drafts; install pins it", async t => {
  const { c, state } = fixture(t, { channel: "test" });
  state.tests.unshift(release(true, { id: 99, tag_name: "v9.0.0-beta.1" }), release(true, { id: 98, tag_name: "v9.0.0-test.1", draft: true }));
  const st = await c.check();
  assert.equal(st.release.tag, "v1.0.0-test.2");
  assert.equal(st.action, "release");
  assert.equal(st.canBuild, false);
  assert.equal(state.ran.length, 0);
  await assert.rejects(c.install(), /updates.confirmRequired/);
  await c.install(st.target);
  assert.ok(state.calls.some(u => u.endsWith("/releases/12")));
  assert.ok(!state.calls.some(u => u.endsWith("/releases/latest")));
  assert.equal(state.ran.length, 1);
});
test("Test absence, unsupported architecture and missing sums fail closed without building main", async t => {
  for (const mode of ["absent", "sum", "asset", "arch", "portable"]) {
    const { c, state } = fixture(t, { channel: "test", arch: mode === "arch" ? "arm64" : "x64", installSupported: mode !== "portable" });
    if (mode === "absent") state.tests = [];
    if (mode === "sum") state.tests[0].assets.pop();
    if (mode === "asset") state.tests[0].assets.shift();
    const st = await c.check();
    assert.equal(st.action, "none", mode);
    assert.ok(st.unavailable, mode);
    await assert.rejects(c.install(st.target));
    assert.equal(state.ran.length, 0);
  }
});
test("return from Test to same or older Stable is explicit, and installing never modifies settings", async t => {
  const { c, state } = fixture(t, { info: { channel: "test", releaseTag: "v1.0.0-test.2" } });
  const before = JSON.stringify(state.settings);
  const st = await c.check();
  assert.equal(st.action, "release");
  assert.equal(st.replaceBuild, true);
  assert.equal(st.release.tag, "v1.0.0");
  await assert.rejects(c.install(), /updates.confirmRequired/);
  await c.install(st.target);
  assert.equal(JSON.stringify(state.settings), before);
});
test("a stale confirmation after a channel change or replaced asset cannot install", async t => {
  const { c, state } = fixture(t, { channel: "test" });
  const st = await c.check();
  state.settings.channel = "stable";
  await assert.rejects(c.install(st.target), /updates.changed/);
  state.settings.channel = "test";
  state.tests[0].assets[0].id = 42;
  await assert.rejects(c.install(st.target), /updates.changed/);
  assert.equal(state.ran.length, 0);
});
test("Test preserves checksum verification and rejects traversal names", async t => {
  const { c, state } = fixture(t, { channel: "test" });
  const st = await c.check();
  state.sum = "0".repeat(64);
  await assert.rejects(c.install(st.target), /updates.badSum/);
  assert.equal(state.ran.length, 0);
  state.tests[0].assets[0].name = "../escape-Setup.exe";
  assert.equal((await c.check()).action, "none");
});
test("source opt-in cannot build Test, unsupported Windows architectures, or a foreign cached origin", async t => {
  const unsupported = fixture(t, { arch: "arm64" });
  assert.equal((await unsupported.c.check()).canBuild, false);
  const { c, state } = fixture(t);
  const st = await c.check();
  assert.equal(st.action, "build");
  fs.mkdirSync(path.join(c.workDir, "update-src", ".git"), { recursive: true });
  await assert.rejects(c.install(st.target), /updates.badOrigin/);
  assert.equal(state.ran.length, 1);
  assert.deepEqual(state.ran[0][1], ["remote", "get-url", "origin"]);
});
test("return to an older Stable package needs exact confirmation, not a newer-version comparison", async t => {
  const { c, state } = fixture(t, { info: { channel: "test", releaseTag: "v1.0.0-test.2" } });
  state.stable.tag_name = "v0.9.0";
  const st = await c.check();
  assert.equal(st.release.newer, false);
  assert.equal(st.replaceBuild, true);
  assert.equal(st.action, "release");
  await assert.rejects(c.install("different target"), /updates.changed/);
  assert.equal(state.ran.length, 0);
});
test("a channel change during download prevents launch", async t => {
  const { c, state } = fixture(t, { channel: "test" });
  const st = await c.check();
  const fetch = c.fetch;
  c.fetch = async url => { const r = await fetch(url); if (url.endsWith("/assets/22")) state.settings.channel = "stable"; return r; };
  await assert.rejects(c.install(st.target), /updates.changed/);
  assert.equal(state.ran.length, 0);
});
test("concurrent checks cannot replace the active check or clear its busy flag", async t => {
  const { c } = fixture(t);
  let releaseFetch;
  const fetch = c.fetch;
  c.fetch = async (...args) => { await new Promise(resolve => { releaseFetch = resolve; }); return fetch(...args); };
  const first = c.check();
  assert.equal(c.busy, "check");
  await assert.rejects(c.check(), /updates.busy/);
  assert.equal(c.busy, "check");
  c.fetch = fetch;
  releaseFetch();
  await first;
  assert.equal(c.busy, null);
});
