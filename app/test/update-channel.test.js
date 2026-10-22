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
      if (url.includes("/git/ref/heads/")) value = state.ref || { ref: `refs/heads/${channel === "test" ? "test/desktop-fixes" : "main"}`, object: { type: "commit", sha: channel === "test" ? "a".repeat(40) : "b".repeat(40) } };
      else if (url.includes("/compare/")) value = state.compare || comparison(channel === "test" ? 0 : 1);
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
const BUILT = "a".repeat(40), HEAD = "b".repeat(40);
function comparison(ahead = 1, overrides = {}) {
  return { status: ahead ? "ahead" : "identical", ahead_by: ahead, behind_by: 0, total_commits: ahead,
    base_commit: { sha: BUILT }, merge_base_commit: { sha: BUILT },
    commits: ahead ? [{ sha: HEAD, commit: { message: "Test change\nbody" } }] : [], ...overrides };
}
function sourceFixture(t, options) {
  const f = fixture(t, { channel: "test", ...options });
  f.state.tests = [];
  f.state.ref = { ref: "refs/heads/test/desktop-fixes", object: { type: "commit", sha: HEAD } };
  f.state.compare = comparison();
  return f;
}
function buildRunner(c, state, change = () => {}) {
  c.run = async (cmd, args, opts) => {
    state.ran.push({ cmd, args, opts });
    change(cmd, args);
    if (args[0] === "remote") return { code: 0, out: `https://github.com/${REPO}.git` };
    if (args[0] === "rev-parse") return { code: 0, out: HEAD };
    if (args[1] === "dist:win") {
      fs.mkdirSync(path.join(opts.cwd, "dist"), { recursive: true });
      fs.writeFileSync(path.join(opts.cwd, "dist", "Hermes-Deck-1.0.0-Setup.exe"), bytes);
    }
    return { code: 0, out: "" };
  };
}
test("Test branch commits need no release and checking never executes source", async t => {
  const { c, state } = sourceFixture(t);
  const st = await c.check();
  assert.equal(st.action, "build");
  assert.equal(st.branch, "test/desktop-fixes");
  assert.equal(st.head, HEAD);
  assert.equal(st.behind, 1);
  assert.deepEqual(st.commits.map(x => x.title), ["Test change"]);
  assert.equal(st.release, null);
  assert.deepEqual(state.ran, []);
  assert.ok(state.calls.some(u => u.endsWith(`/compare/${BUILT}...${HEAD}`)));
});
test("Test lists commits with source disabled or tools/platform unavailable; releases cannot hide them", async t => {
  for (const mode of ["off", "git", "npm", "linux", "arch", "isolated", "mac-dev", "release", "release-error"]) {
    const { c, state } = sourceFixture(t, { platform: mode === "linux" ? "linux" : mode === "mac-dev" ? "darwin" : "win32", arch: mode === "arch" ? "arm64" : "x64", installSupported: mode !== "isolated" });
    if (mode === "off") state.settings.fromSource = false;
    c.has = async tool => tool !== mode;
    if (mode === "release") state.tests = [release(true)];
    if (mode === "release-error") { const fetch = c.fetch; c.fetch = url => url.includes("/releases?") ? Promise.reject(new Error("unavailable")) : fetch(url); }
    const st = await c.check();
    assert.equal(st.behind, 1, mode);
    assert.equal(st.commits.length, 1, mode);
    assert.equal(st.action, ["release", "release-error"].includes(mode) ? "build" : "none", mode);
    if (st.action === "none") assert.ok(st.unavailable, mode);
    assert.deepEqual(state.ran, []);
  }
});
test("source targets reject malformed, truncated, paginated, divergent and unknown comparisons", async t => {
  const bad = [
    { ahead_by: "1" }, { ahead_by: -1 }, { behind_by: undefined }, { status: "behind" },
    { total_commits: 2 }, { commits: [] }, { commits: [{ sha: "--upload-pack=evil" }] },
    { commits: [{ sha: "c".repeat(40) }] }, { base_commit: { sha: HEAD } },
    { status: "diverged", behind_by: 1, merge_base_commit: { sha: "c".repeat(40) } },
    { merge_base_commit: { sha: "c".repeat(40) } }, { ahead_by: 251, total_commits: 251 },
  ];
  for (const invalid of bad) {
    const { c, state } = sourceFixture(t);
    Object.assign(state.compare, invalid);
    const st = await c.check();
    assert.notEqual(st.action, "build", JSON.stringify(invalid));
    await assert.rejects(c.install(st.target));
    assert.deepEqual(state.ran, []);
  }
  for (const sha of ["b".repeat(7), "--evil", "B".repeat(40), HEAD + "\n"]) {
    const { c, state } = sourceFixture(t); state.ref.object.sha = sha;
    assert.notEqual((await c.check()).action, "build");
    assert.deepEqual(state.ran, []);
  }
  const { c, state } = sourceFixture(t);
  const fetch = c.fetch; c.fetch = url => url.includes("/compare/") ? Promise.reject(new Error("unknown commit")) : fetch(url);
  assert.notEqual((await c.check()).action, "build");
  assert.deepEqual(state.ran, []);
});
test("Test source checks out the exact SHA and passes detached Test metadata without a release tag", async t => {
  const { c, state } = sourceFixture(t); buildRunner(c, state);
  const st = await c.check();
  await c.install(st.target);
  assert.ok(state.ran.some(r => r.cmd === "git" && r.args.join(" ") === `fetch origin ${HEAD}`));
  assert.ok(state.ran.some(r => r.args.includes("--detach") && r.args.at(-1) === HEAD));
  for (const r of state.ran.filter(r => r.cmd === "npm")) {
    assert.equal(r.opts.env.DECK_UPDATE_CHANNEL, "test");
    assert.equal(r.opts.env.DECK_SOURCE_COMMIT, HEAD);
    assert.equal(r.opts.env.DECK_RELEASE_TAG, "");
    assert.equal(r.opts.env.GH_TOKEN, undefined);
    assert.equal(r.opts.env.GITHUB_TOKEN, undefined);
  }
  assert.equal(state.ran.at(-1).opts.detached, true);
});
test("changed head, old confirmation, channel changes, disabled source and build failure never launch", async t => {
  for (const mode of ["head", "head-build", "confirmation", "channel-check", "channel-build", "off", "off-before", "fail", "foreign", "checkout"]) {
    const { c, state } = sourceFixture(t);
    buildRunner(c, state, (cmd, args) => {
      if (cmd === "npm" && mode === "channel-build") state.settings.channel = "stable";
      if (cmd === "npm" && mode === "off") state.settings.fromSource = false;
      if (cmd === "npm" && mode === "head-build") state.ref.object.sha = "c".repeat(40);
    });
    const fetch = c.fetch;
    if (mode === "channel-check") c.fetch = async url => { const r = await fetch(url); state.settings.channel = "stable"; return r; };
    const st = await c.check();
    if (mode === "channel-check") { assert.equal(st.error, "updates.changed"); continue; }
    assert.equal(st.action, "build");
    if (mode === "head") state.ref.object.sha = "c".repeat(40);
    if (mode === "off-before") state.settings.fromSource = false;
    if (["fail", "foreign", "checkout"].includes(mode)) {
      const run = c.run;
      c.run = (cmd, args, opts) => cmd === "npm" && mode === "fail" ? Promise.resolve({ code: 1, out: "failed" })
        : args[0] === "remote" && mode === "foreign" ? Promise.resolve({ code: 0, out: "https://example.com/foreign.git" })
        : args[0] === "rev-parse" && mode === "checkout" ? Promise.resolve({ code: 0, out: BUILT }) : run(cmd, args, opts);
    }
    await assert.rejects(c.install(mode === "confirmation" ? "old-target" : st.target), undefined, mode);
    assert.ok(!state.ran.some(r => r.opts.detached), mode);
    assert.equal(c.busy, null);
  }
});

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
    if (mode !== "absent") assert.ok(st.unavailable, mode);
    await assert.rejects(c.install(st.target));
    assert.equal(state.ran.length, 0);
  }
});
test("return from source Test to same Stable is explicit, and installing never modifies settings", async t => {
  const { c, state } = fixture(t, { info: { channel: "test", branch: "test/desktop-fixes", releaseTag: "" } });
  const before = JSON.stringify(state.settings);
  const st = await c.check();
  assert.equal(st.action, "release");
  assert.equal(st.replaceBuild, true);
  assert.equal(st.release.tag, "v1.0.0");
  await assert.rejects(c.install(), /updates.confirmRequired/);
  await c.install(st.target);
  assert.equal(JSON.stringify(state.settings), before);
});
test("source Test return with no Stable release is explicit and never builds main", async t => {
  const { c, state } = fixture(t, { info: { channel: "test", releaseTag: "" } });
  state.stable = null;
  const st = await c.check();
  assert.equal(st.replaceBuild, true);
  assert.equal(st.action, "none");
  assert.equal(st.unavailable, "updates.noStableRelease");
  assert.deepEqual(state.ran, []);
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
test("source opt-in cannot build unsupported Windows architectures or a foreign clone origin", async t => {
  const unsupported = fixture(t, { arch: "arm64" });
  assert.equal((await unsupported.c.check()).canBuild, false);
  const { c, state } = fixture(t);
  const st = await c.check();
  assert.equal(st.action, "build");
  await assert.rejects(c.install(st.target), /updates.badOrigin/);
  assert.equal(state.ran.length, 2);
  assert.equal(state.ran[0][1][0], "clone");
  assert.deepEqual(state.ran[1][1], ["remote", "get-url", "origin"]);
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
