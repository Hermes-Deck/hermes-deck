"use strict";
// Update check (main/update-check.js) against a fake GitHub: commits behind main, a newer release, the install
// paths (release download with checksum, build from main) and the errors a user sees.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { UpdateChecker, buildInfo, installerAsset, sumFor } = require("../main/update-check");

const BUILT = "a".repeat(40);
const HEAD = "b".repeat(40);
const SETUP = Buffer.from("fake installer bytes");
const SUM = crypto.createHash("sha256").update(SETUP).digest("hex");

function github({ ahead = 3, own = 0, tag = "v0.4.0", status = 200, sum = SUM, compareStatus = 200, sums = true } = {}) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization || "" });
    const json = (body) => ({ ok: status === 200, status, json: async () => body, text: async () => String(body), arrayBuffer: async () => body });
    if (status !== 200) return json({});
    if (url.includes("/compare/") && compareStatus !== 200) return { ok: false, status: compareStatus, json: async () => ({}) };
    if (url.includes("/compare/")) {
      const commits = Array.from({ length: ahead }, (_, i) => ({ sha: i === ahead - 1 ? HEAD : `${i}`.repeat(40).slice(0, 40), commit: { message: `Commit ${i + 1}\n\nbody`, committer: { date: "2026-10-06T10:00:00Z" } } }));
      return json({ ahead_by: ahead, behind_by: own, commits });
    }
    if (url.endsWith("/releases/latest")) {
      return json({ tag_name: tag, html_url: "https://github.com/o/r/releases/tag/" + tag, assets: [
        { id: 1, name: `Hermes-Deck-${tag.slice(1)}-Setup.exe` }, ...(sums ? [{ id: 2, name: "SHA256SUMS.txt" }] : []), { id: 3, name: `Hermes-Deck-${tag.slice(1)}-mac-arm64.zip` }] });
    }
    if (url.endsWith("/assets/1")) return { ok: true, status: 200, arrayBuffer: async () => SETUP };
    if (url.endsWith("/assets/2")) return { ok: true, status: 200, text: async () => `${sum}  Hermes-Deck-${tag.slice(1)}-Setup.exe\n` };
    return json({});
  };
  return { fetch, calls };
}

function checker(over = {}) {
  const ran = [];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "deck-upd-"));
  const c = new UpdateChecker({
    version: "0.3.0", info: { commit: BUILT, branch: "main", repo: "o/r", dirty: false, dev: false },
    settings: () => ({ fromSource: true }), token: async () => "tok", platform: "win32", arch: "x64", workDir: work,
    run: async (cmd, args, opts) => { ran.push({ cmd, args, opts }); return { code: 0, out: "" }; },
    has: async () => true, ...over,
  });
  return { c, ran, work };
}

test("check: commits behind main (newest first), the newer release and what the button does", async () => {
  const gh = github();
  const { c } = checker({ fetch: gh.fetch });
  const st = await c.check();
  assert.equal(st.behind, 3);
  assert.equal(st.ahead, 0);
  assert.equal(st.head, HEAD);
  assert.deepEqual(st.commits.map((x) => x.title), ["Commit 3", "Commit 2", "Commit 1"]);
  assert.equal(st.release.tag, "v0.4.0");
  assert.equal(st.release.newer, true);
  assert.equal(st.action, "release", "a newer release beats building main");
  assert.match(gh.calls[0].url, /\/repos\/o\/r\/compare\/a{40}\.\.\.main$/);
  assert.equal(gh.calls[0].auth, "Bearer tok");
});

test("check: no newer release -> build from main when git and npm exist; none when they do not; up to date", async () => {
  assert.equal((await checker({ fetch: github({ tag: "v0.3.0" }).fetch }).c.check()).action, "build");
  const branchBuild = await checker({ fetch: github({ tag: "v0.3.0", own: 4 }).fetch }).c.check();
  assert.equal(branchBuild.action, "none", "a feature-branch build is never replaced by main");
  assert.equal(branchBuild.ahead, 4);
  assert.equal((await checker({ fetch: github({ tag: "v0.3.0" }).fetch, has: async () => false }).c.check()).action, "none");
  const up = await checker({ fetch: github({ ahead: 0, tag: "v0.3.0" }).fetch }).c.check();
  assert.equal(up.behind, 0);
  assert.equal(up.action, "none");
  const mac = await checker({ fetch: github({ tag: "v0.3.0" }).fetch, platform: "darwin" }).c.check();
  assert.equal(mac.action, "none", "macOS never builds; it opens the release page when there is one");
});

test("macOS: a newer release is downloaded and verified, then handed over as a file (no silent install)", async () => {
  const ZIP = Buffer.from("fake mac zip");
  const zipSum = crypto.createHash("sha256").update(ZIP).digest("hex");
  const fetch = async (url) => {
    const ok = (o) => ({ ok: true, status: 200, ...o });
    if (url.includes("/compare/")) return ok({ json: async () => ({ ahead_by: 0, behind_by: 0, commits: [] }) });
    if (url.endsWith("/releases/latest")) return ok({ json: async () => ({ tag_name: "v0.4.0", html_url: "https://github.com/o/r/releases/tag/v0.4.0", assets: [{ id: 3, name: "Hermes-Deck-0.4.0-mac-arm64.zip" }, { id: 2, name: "SHA256SUMS.txt" }] }) });
    if (url.endsWith("/assets/3")) return ok({ arrayBuffer: async () => ZIP });
    if (url.endsWith("/assets/2")) return ok({ text: async () => `${zipSum}  Hermes-Deck-0.4.0-mac-arm64.zip\n` });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const { c, ran } = checker({ fetch, platform: "darwin", arch: "arm64" });
  assert.equal((await c.check()).action, "release");
  const err = await c.install().then(() => null, (e) => e);
  assert.equal(err.message, "updates.manualDownloaded");
  assert.equal(fs.readFileSync(err.file).toString(), "fake mac zip", "the verified file is kept for the user");
  assert.deepEqual(ran, [], "nothing is run on macOS");
});

test("check: errors are explained, never thrown", async () => {
  assert.equal((await checker({ fetch: github({ status: 404 }).fetch, token: async () => "" }).c.check()).error, "updates.noAccess");
  assert.equal((await checker({ fetch: github({ status: 401 }).fetch, token: async () => "" }).c.check()).error, "updates.needToken");
  assert.equal((await checker({ fetch: github({ status: 403 }).fetch }).c.check()).error, "updates.noAccess");
  assert.equal((await checker({ info: { commit: BUILT, branch: "main", repo: "" } }).c.check()).error, "updates.noRepo");
  const settingsRepo = checker({ fetch: github().fetch, info: { commit: BUILT, branch: "x", repo: "" }, settings: () => ({ repo: "me/fork", branch: "dev" }) });
  assert.equal((await settingsRepo.c.check()).repo, "me/fork");
});

test("install: a release is downloaded, its checksum verified, then started silently", async () => {
  const { c, ran, work } = checker({ fetch: github().fetch });
  const file = await c.install();
  assert.equal(path.basename(file), "Hermes-Deck-0.4.0-Setup.exe");
  assert.deepEqual(fs.readFileSync(file), SETUP);
  assert.deepEqual(ran.at(-1).args, ["/S", "--force-run"]);
  assert.equal(ran.at(-1).opts.detached, true);
  fs.rmSync(work, { recursive: true, force: true });
  const bad = checker({ fetch: github({ sum: "0".repeat(64) }).fetch });
  await assert.rejects(bad.c.install(), /updates\.badSum/);
  assert.equal(bad.ran.length, 0, "nothing ran");
});

test("install: building main clones once, checks out the branch, builds and runs the new installer", async () => {
  const ran = [];
  const { c, work } = checker({ fetch: github({ tag: "v0.3.0" }).fetch,
    run: async (cmd, args, opts) => {
      ran.push({ cmd, args, opts });
      if (args[0] === "clone") fs.mkdirSync(path.join(args[3], ".git"), { recursive: true });
      if (args[1] === "dist:win") {
        fs.mkdirSync(path.join(opts.cwd, "dist"), { recursive: true });
        fs.writeFileSync(path.join(opts.cwd, "dist", "Hermes-Deck-0.3.1-Setup.exe"), "x");
      }
      return { code: 0, out: "" };
    } });
  await c.check();
  const file = await c.install();
  assert.deepEqual(ran.map((r) => `${r.cmd} ${r.args[0]}`), ["git clone", "git fetch", "git checkout", "npm ci", "npm run", `${file} /S`]);
  assert.match(ran[0].args[2], /^https:\/\/github\.com\/o\/r\.git$/);
  assert.deepEqual(ran[2].args, ["checkout", "--detach", "--force", "origin/main"]);
  fs.rmSync(work, { recursive: true, force: true });
});

test("helpers: build info, installer asset per platform, SHA256SUMS lookup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-bi-"));
  fs.writeFileSync(path.join(dir, "build-info.json"), JSON.stringify({ commit: BUILT, branch: "main", repo: "o/r", dirty: true }));
  assert.deepEqual(buildInfo({ dir }), { commit: BUILT, branch: "main", repo: "o/r", dirty: true, dev: false });
  const dev = buildInfo({ dir: path.join(dir, "none"), git: (a) => (a[0] === "rev-parse" && a[1] === "HEAD" ? HEAD : a[0] === "remote" ? "git@github.com:me/deck.git" : "wip") });
  assert.deepEqual(dev, { commit: HEAD, branch: "wip", repo: "me/deck", dirty: false, dev: true });
  fs.rmSync(dir, { recursive: true, force: true });
  const assets = [{ name: "Hermes-Deck-1.0.0-Setup.exe" }, { name: "Hermes-Deck-1.0.0-mac-arm64.zip" }, { name: "Hermes-Deck-1.0.0-mac-x64.zip" }];
  assert.equal(installerAsset(assets, "win32").name, "Hermes-Deck-1.0.0-Setup.exe");
  assert.equal(installerAsset(assets, "darwin", "arm64").name, "Hermes-Deck-1.0.0-mac-arm64.zip");
  assert.equal(installerAsset(assets, "linux"), null);
  assert.equal(sumFor(`${SUM}  a.exe\n${"1".repeat(64)} *b.zip`, "b.zip"), "1".repeat(64));
  assert.equal(sumFor("garbage", "a.exe"), "");
});

test("check: a build commit the repository no longer has (rewritten history) still finds the newer release", async () => {
  for (const compareStatus of [404, 422]) {
    const st = await checker({ fetch: github({ compareStatus }).fetch }).c.check();
    assert.equal(st.error, undefined, `compare ${compareStatus} is not a failed check`);
    assert.equal(st.compare, "unavailable");
    assert.equal(st.release.tag, "v0.4.0");
    assert.equal(st.action, "release");
    assert.equal(st.behind, 0);
  }
  const noToken = await checker({ fetch: github({ compareStatus: 404 }).fetch, token: async () => "" }).c.check();
  assert.equal(noToken.action, "release", "a public repository needs no token");
  const current = await checker({ fetch: github({ compareStatus: 404, tag: "v0.3.0" }).fetch }).c.check();
  assert.equal(current.action, "none");
  assert.equal(current.error, undefined);
  const both = await checker({ fetch: github({ status: 403 }).fetch }).c.check();
  assert.equal(both.error, "updates.noAccess", "neither compare nor release: the check failed");
});

test("install: a release without SHA256SUMS.txt is never installed", async () => {
  const { c, ran } = checker({ fetch: github({ sums: false }).fetch });
  await assert.rejects(c.install(), /updates\.noSum/);
  assert.equal(ran.length, 0, "nothing ran");
});

test("check: building unreleased source is opt-in (updates.fromSource)", async () => {
  const off = await checker({ fetch: github({ tag: "v0.3.0" }).fetch, settings: () => ({}) }).c.check();
  assert.equal(off.canBuild, false);
  assert.equal(off.action, "none");
  const on = await checker({ fetch: github({ tag: "v0.3.0" }).fetch, settings: () => ({ fromSource: true }) }).c.check();
  assert.equal(on.action, "build");
});
