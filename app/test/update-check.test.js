"use strict";
// Update check (main/update-check.js) against a fake GitHub: commits behind main, a newer release, the install
// paths (release download with checksum, build from main) and the errors a user sees.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { UpdateChecker, buildInfo, installerAsset, sumFor, SWAP_SH, BUNDLE_ID } = require("../main/update-check");
const { execFileSync } = require("child_process");

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
    if (url.endsWith("/releases/latest") || url.endsWith("/releases/10")) {
      return json({ id: 10, draft: false, prerelease: false, tag_name: tag, html_url: "https://github.com/o/r/releases/tag/" + tag, assets: [
        { id: 1, name: `Hermes-Deck-${tag.slice(1)}-Setup.exe` }, ...(sums ? [{ id: 2, name: "SHA256SUMS.txt" }] : []), { id: 3, name: `Hermes-Deck-${tag.slice(1)}-mac-arm64.zip` }] });
    }
    if (url.endsWith("/assets/1")) return { ok: true, status: 200, arrayBuffer: async () => SETUP };
    if (url.endsWith("/assets/2")) return { ok: true, status: 200, text: async () => `${sum}  Hermes-Deck-${tag.slice(1)}-Setup.exe\n` };
    return json({});
  };
  return { fetch, calls };
}

async function confirmedInstall(c) { const st = await c.check(); return c.install(st.target); }

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
  assert.match(gh.calls[0].url, /\/repos\/Hermes-Deck\/hermes-deck\/compare\/a{40}\.\.\.main$/);
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
  assert.equal(mac.action, "none", "a macOS dev run (no app bundle) never builds");
  const macApp = await checker({ fetch: github({ tag: "v0.3.0" }).fetch, platform: "darwin", appBundle: "/Applications/Hermes Deck.app" }).c.check();
  assert.equal(macApp.action, "build", "a packaged macOS app builds main like Windows");
  const linux = await checker({ fetch: github({ tag: "v0.3.0" }).fetch, platform: "linux", appBundle: "/x/Hermes Deck.app" }).c.check();
  assert.equal(linux.action, "none");
});

test("macOS: a newer release is downloaded and verified, then handed over as a file (no silent install)", async () => {
  const ZIP = Buffer.from("fake mac zip");
  const zipSum = crypto.createHash("sha256").update(ZIP).digest("hex");
  const fetch = async (url) => {
    const ok = (o) => ({ ok: true, status: 200, ...o });
    if (url.includes("/compare/")) return ok({ json: async () => ({ ahead_by: 0, behind_by: 0, commits: [] }) });
    if (url.endsWith("/releases/latest") || url.endsWith("/releases/10")) return ok({ json: async () => ({ id: 10, draft: false, prerelease: false, tag_name: "v0.4.0", html_url: "https://github.com/o/r/releases/tag/v0.4.0", assets: [{ id: 3, name: "Hermes-Deck-0.4.0-mac-arm64.zip" }, { id: 2, name: "SHA256SUMS.txt" }] }) });
    if (url.endsWith("/assets/3")) return ok({ arrayBuffer: async () => ZIP });
    if (url.endsWith("/assets/2")) return ok({ text: async () => `${zipSum}  Hermes-Deck-0.4.0-mac-arm64.zip\n` });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const { c, ran } = checker({ fetch, platform: "darwin", arch: "arm64" });
  assert.equal((await c.check()).action, "release");
  const err = await confirmedInstall(c).then(() => null, (e) => e);
  assert.equal(err.message, "updates.manualDownloaded");
  assert.equal(fs.readFileSync(err.file).toString(), "fake mac zip", "the verified file is kept for the user");
  assert.deepEqual(ran, [], "nothing is run on macOS");
});

test("check: errors are explained, never thrown", async () => {
  assert.equal((await checker({ fetch: github({ status: 404 }).fetch, token: async () => "" }).c.check()).error, "updates.noAccess");
  assert.equal((await checker({ fetch: github({ status: 401 }).fetch, token: async () => "" }).c.check()).error, "updates.needToken");
  assert.equal((await checker({ fetch: github({ status: 403 }).fetch }).c.check()).error, "updates.noAccess");
  assert.equal((await checker({ fetch: github().fetch, info: { commit: BUILT, branch: "main", repo: "" } }).c.check()).repo, "Hermes-Deck/hermes-deck");
  const settingsRepo = checker({ fetch: github().fetch, info: { commit: BUILT, branch: "x", repo: "" }, settings: () => ({ repo: "me/fork", branch: "dev" }) });
  assert.equal((await settingsRepo.c.check()).repo, "Hermes-Deck/hermes-deck");
});

test("install: a release is downloaded, its checksum verified, then started silently", async () => {
  const { c, ran, work } = checker({ fetch: github().fetch });
  const file = await confirmedInstall(c);
  assert.equal(path.basename(file), "Hermes-Deck-0.4.0-Setup.exe");
  assert.deepEqual(fs.readFileSync(file), SETUP);
  assert.deepEqual(ran.at(-1).args, ["/S", "--force-run"]);
  assert.equal(ran.at(-1).opts.detached, true);
  fs.rmSync(work, { recursive: true, force: true });
  const bad = checker({ fetch: github({ sum: "0".repeat(64) }).fetch });
  await assert.rejects(confirmedInstall(bad.c), /updates\.badSum/);
  assert.equal(bad.ran.length, 0, "nothing ran");
});

test("install: building main clones once, checks out the branch, builds and runs the new installer", async () => {
  const ran = [];
  const { c, work } = checker({ fetch: github({ tag: "v0.3.0" }).fetch,
    run: async (cmd, args, opts) => {
      ran.push({ cmd, args, opts });
      if (args[0] === "remote") return { code: 0, out: "https://github.com/Hermes-Deck/hermes-deck.git" };
      if (args[0] === "clone") fs.mkdirSync(path.join(args[3], ".git"), { recursive: true });
      if (args[1] === "dist:win") {
        fs.mkdirSync(path.join(opts.cwd, "dist"), { recursive: true });
        fs.writeFileSync(path.join(opts.cwd, "dist", "Hermes-Deck-0.3.1-Setup.exe"), "x");
      }
      return { code: 0, out: "" };
    } });
  await c.check();
  const file = await confirmedInstall(c);
  assert.deepEqual(ran.map((r) => `${r.cmd} ${r.args[0]}`), ["git clone", "git remote", "git fetch", "git -c", "npm ci", "npm run", `${file} /S`]);
  assert.equal(ran[0].args[2], "https://github.com/Hermes-Deck/hermes-deck.git");
  assert.deepEqual(ran[2].args, ["fetch", "origin", HEAD]);
  assert.deepEqual(ran[3].args, ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", "--force", HEAD]);
  fs.rmSync(work, { recursive: true, force: true });
});

test("helpers: build info, installer asset per platform, SHA256SUMS lookup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-bi-"));
  fs.writeFileSync(path.join(dir, "build-info.json"), JSON.stringify({ commit: BUILT, branch: "main", repo: "o/r", dirty: true }));
  assert.deepEqual(buildInfo({ dir }), { commit: BUILT, branch: "main", repo: "o/r", dirty: true, dev: false, channel: "stable", releaseTag: "" });
  const dev = buildInfo({ dir: path.join(dir, "none"), git: (a) => (a[0] === "rev-parse" && a[1] === "HEAD" ? HEAD : a[0] === "remote" ? "git@github.com:me/deck.git" : "wip") });
  assert.deepEqual(dev, { commit: HEAD, branch: "wip", repo: "me/deck", dirty: false, dev: true, channel: "stable", releaseTag: "" });
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
  const st = await c.check();
  assert.equal(st.unavailable, "updates.noSum");
  assert.equal(st.action, "none");
  await assert.rejects(c.install(st.target), /updates\.confirmRequired/);
  assert.equal(ran.length, 0, "nothing ran");
});

test("check: building unreleased source is opt-in (updates.fromSource)", async () => {
  const off = await checker({ fetch: github({ tag: "v0.3.0" }).fetch, settings: () => ({}) }).c.check();
  assert.equal(off.canBuild, false);
  assert.equal(off.action, "none");
  const on = await checker({ fetch: github({ tag: "v0.3.0" }).fetch, settings: () => ({ fromSource: true }) }).c.check();
  assert.equal(on.action, "build");
});

function fakeApp(dir, id = BUNDLE_ID, mark = "new") {
  fs.mkdirSync(path.join(dir, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Contents", "Info.plist"), id);
  fs.writeFileSync(path.join(dir, "mark"), mark);
}

test("macOS: building main picks this arch's .app, stages it beside the running bundle and starts the swap", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-mac-"));
  const target = path.join(root, "Hermes Deck.app");
  fakeApp(target, BUNDLE_ID, "old");
  fs.mkdirSync(path.join(root, "work"));
  const ran = [];
  const { c } = checker({ fetch: github({ tag: "v0.3.0" }).fetch, platform: "darwin", arch: "arm64", appBundle: target, pid: 4242, workDir: path.join(root, "work"),
    run: async (cmd, args, opts) => {
      ran.push({ cmd, args, opts });
      if (args[0] === "remote") return { code: 0, out: "https://github.com/Hermes-Deck/hermes-deck.git" };
      if (args[0] === "clone") fs.mkdirSync(path.join(args[3], ".git"), { recursive: true });
      if (args[1] === "dist") { fakeApp(path.join(opts.cwd, "dist", "mac", "Hermes Deck.app"), BUNDLE_ID, "x64"); fakeApp(path.join(opts.cwd, "dist", "mac-arm64", "Hermes Deck.app"), BUNDLE_ID, "arm64"); }
      if (cmd === "ditto") fs.cpSync(args[0], args[1], { recursive: true });
      if (cmd === "plutil") return { code: 0, out: fs.readFileSync(args.at(-1), "utf8") };
      return { code: 0, out: "" };
    } });
  await c.check();
  assert.equal(await confirmedInstall(c), target);
  const staged = path.join(root, ".Hermes Deck.app.update");
  assert.equal(fs.readFileSync(path.join(staged, "mark"), "utf8"), "arm64", "the arm64 build, not x64");
  assert.equal(fs.readFileSync(path.join(target, "mark"), "utf8"), "old", "the running app is untouched until it quits");
  const swap = ran.at(-1);
  assert.equal(swap.cmd, "/bin/sh");
  assert.deepEqual(swap.args.slice(1), ["4242", target, staged]);
  assert.equal(swap.opts.detached, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("macOS: a foreign bundle, a dev run or a read-only folder never gets swapped", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-mac-"));
  const target = path.join(root, "Hermes Deck.app");
  fakeApp(target);
  const newApp = path.join(root, "New.app");
  fakeApp(newApp, "com.example.other");
  const ran = [];
  const run = async (cmd, args) => { ran.push(cmd); if (cmd === "ditto") fs.cpSync(args[0], args[1], { recursive: true }); return cmd === "plutil" ? { code: 0, out: fs.readFileSync(args.at(-1), "utf8") } : { code: 0, out: "" }; };
  const c = checker({ platform: "darwin", appBundle: target, run }).c;
  await assert.rejects(c._launch(newApp), /updates\.badBundle/);
  assert.equal(fs.existsSync(path.join(root, ".Hermes Deck.app.update")), false, "the staged copy is removed");
  assert.equal(ran.includes("/bin/sh"), false);
  await assert.rejects(checker({ platform: "darwin", appBundle: "", run }).c._launch(newApp), /updates\.manualBuilt/);
  await assert.rejects(checker({ platform: "darwin", appBundle: "/private/var/folders/x/AppTranslocation/y/Hermes Deck.app", run }).c._launch(newApp), /updates\.manualBuilt/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("macOS swap script: keeps the old app until the new one runs, restores it when the new one does not start", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck swap "));
  const script = path.join(root, "swap.sh");
  fs.writeFileSync(script, SWAP_SH);
  const target = path.join(root, "Hermes Deck.app"), staged = path.join(root, ".Hermes Deck.app.update");
  const env = (alive) => ({ ...process.env, DECK_OPEN: "true", DECK_ALIVE: alive, DECK_SETTLE: "0", DECK_START_WAIT: "2" });
  const gone = "999999"; // no such process: the wait ends at once
  const left = () => fs.readdirSync(root).filter((n) => /\.(old|failed)-\d+$/.test(n));
  fakeApp(path.join(root, "Hermes Deck.app.old"), BUNDLE_ID, "leftover"); // an older leftover is never touched
  fakeApp(target, BUNDLE_ID, "old");
  fakeApp(staged, BUNDLE_ID, "new");
  execFileSync("/bin/sh", [script, gone, target, staged], { env: env("true") });
  assert.equal(fs.readFileSync(path.join(target, "mark"), "utf8"), "new");
  assert.deepEqual(left(), [], "the backup goes once the new app runs");
  assert.equal(fs.existsSync(staged), false);
  assert.equal(fs.readFileSync(path.join(root, "Hermes Deck.app.old", "mark"), "utf8"), "leftover");
  fakeApp(staged, BUNDLE_ID, "broken");
  assert.throws(() => execFileSync("/bin/sh", [script, gone, target, staged], { env: env("false"), stdio: "ignore" }));
  assert.equal(fs.readFileSync(path.join(target, "mark"), "utf8"), "new", "the working app is back");
  const kept = left();
  assert.equal(kept.length, 1);
  assert.match(kept[0], /\.failed-\d+$/, "the bundle that did not start is set aside for a look");
  assert.throws(() => execFileSync("/bin/sh", [script, gone, target, staged], { env: env("true"), stdio: "ignore" }), "a missing staged bundle fails");
  assert.equal(fs.readFileSync(path.join(target, "mark"), "utf8"), "new", "and changes nothing");
  fs.rmSync(root, { recursive: true, force: true });
});
