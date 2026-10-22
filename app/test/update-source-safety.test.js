"use strict";
// Real Git and zero-dependency offline npm; no network, installer or live app/profile.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { UpdateChecker, buildInfo, BUNDLE_ID, TEST_BRANCH } = require("../main/update-check");
const ORIGIN = "https://github.com/Hermes-Deck/hermes-deck.git";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-source-safety-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed"), workDir = path.join(root, "work"), home = path.join(root, "home");
  for (const dir of [seed, workDir, home]) fs.mkdirSync(dir);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
    TMPDIR: os.tmpdir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
    GIT_TEMPLATE_DIR: path.join(home, "templates"), npm_config_cache: path.join(home, "npm-cache"),
    npm_config_userconfig: path.join(home, "npmrc"), npm_config_globalconfig: path.join(home, "global-npmrc") };
  fs.mkdirSync(env.GIT_TEMPLATE_DIR);
  function run(cmd, args, cwd = seed, extra = {}) {
    const r = spawnSync(cmd, args, { cwd, env: { ...env, ...extra }, encoding: "utf8" });
    return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}${r.error || ""}` };
  }
  function git(args, cwd = seed) {
    const r = run("git", args, cwd);
    assert.equal(r.code, 0, r.out);
    return r.out.trim();
  }
  fs.mkdirSync(path.join(seed, "app", "main"), { recursive: true });
  fs.mkdirSync(path.join(seed, "app", "scripts"));
  for (const file of ["scripts/build-info.js", "main/update-check.js", "main/updates.js"]) {
    fs.copyFileSync(path.join(__dirname, "..", file), path.join(seed, "app", file));
  }
  const pkg = { name: "source-safety-fixture", version: "1.0.0", scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'trusted-ran\',\'yes\')"' } };
  fs.writeFileSync(path.join(seed, "app", "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(seed, "app", "package-lock.json"), JSON.stringify({ name: pkg.name, version: pkg.version,
    lockfileVersion: 3, requires: true, packages: { "": { name: pkg.name, version: pkg.version, hasInstallScript: true } } }));
  fs.writeFileSync(path.join(seed, "tracked"), "original\n");
  git(["init"]); git(["add", "."]);
  const commit = () => git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-am", "fixture"]);
  commit();
  const base = git(["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(seed, "tracked"), "confirmed\n"); commit();
  const head = git(["rev-parse", "HEAD"]);
  git(["remote", "add", "origin", ORIGIN]);
  const state = { head, installed: base, clones: [], npmDirs: [], commands: [], channel: "test", compareFails: false };
  const c = new UpdateChecker({ version: "1.0.0", info: { commit: base, channel: "test", releaseTag: "" },
    settings: () => ({ channel: state.channel, fromSource: true }), platform: "win32", arch: "x64", workDir,
    token: async () => "", has: async () => true,
    fetch: async url => {
      let data;
      if (url.includes("/git/ref/heads/")) data = { ref: `refs/heads/${state.channel === "test" ? TEST_BRANCH : "main"}`, object: { type: "commit", sha: state.head } };
      else if (url.includes("/compare/")) {
        if (state.compareFails) throw new Error("fixture comparison unavailable");
        const ahead = state.head === state.installed ? 0 : 1;
        data = { status: ahead ? "ahead" : "identical", ahead_by: ahead, behind_by: 0, total_commits: ahead,
          base_commit: { sha: state.installed }, merge_base_commit: { sha: state.installed },
          commits: ahead ? [{ sha: state.head, commit: { message: "fixture" } }] : [] };
      } else if (url.includes("/releases?")) data = state.releases || [];
      else if (url.endsWith("/releases/latest")) data = state.stable;
      else throw new Error(`unexpected URL: ${url}`);
      return { ok: true, status: 200, json: async () => data };
    },
    run: async (cmd, args, opts) => {
      state.commands.push({ cmd, args, cwd: opts.cwd });
      if (cmd === "git") {
        const actual = args[0] === "clone" ? ["clone", "--no-hardlinks", seed, args.at(-1)]
          : args[0] === "fetch" ? ["fetch", seed, ...args.slice(2)] : args;
        const r = run(cmd, actual, opts.cwd);
        if (args[0] === "clone" && r.code === 0) {
          state.clones.push(args.at(-1));
          git(["remote", "set-url", "origin", ORIGIN], args.at(-1));
        }
        return r;
      }
      if (cmd === "npm" && args[0] === "ci") {
        state.npmDirs.push(opts.cwd);
        return run(process.platform === "win32" ? "npm.cmd" : "npm", [...args, "--offline"], opts.cwd);
      }
      assert.equal(cmd, "npm", "no installer may run");
      assert.equal(args[0], "run");
      return { code: 1, out: "fixture stops after real offline npm ci" };
    } });
  return { root, seed, workDir, env, git, run, base, head, state, c };
}

for (const link of ["directory", "gitfile", "gitdir"]) {
  test(`F1: fresh source attempt preserves a shared ${link} checkout`, { skip: process.platform === "win32" }, async t => {
    const { root, seed, workDir, git, c, state, head } = fixture(t);
    const other = path.join(root, "other"), old = path.join(workDir, "update-src");
    if (link === "gitfile") git(["worktree", "add", "--detach", old, head]);
    else {
      git(["clone", "--no-hardlinks", seed, other], root);
      git(["remote", "set-url", "origin", ORIGIN], other);
      if (link === "directory") fs.symlinkSync(other, old, "dir");
      else {
        fs.cpSync(other, old, { recursive: true });
        fs.rmSync(path.join(old, ".git"), { recursive: true });
        fs.symlinkSync(path.join(other, ".git"), path.join(old, ".git"), "dir");
      }
    }
    fs.writeFileSync(path.join(old, "tracked"), "uncommitted work: keep me\n");
    const config = fs.readFileSync(path.join(link === "gitfile" ? seed : other, ".git", "config"));
    const st = await c.check();
    await assert.rejects(c.install(st.target), /updates.buildFailed/);
    assert.equal(fs.readFileSync(path.join(old, "tracked"), "utf8"), "uncommitted work: keep me\n");
    assert.deepEqual(fs.readFileSync(path.join(link === "gitfile" ? seed : other, ".git", "config")), config);
    assert.equal(state.clones.length, 1);
    assert.notEqual(state.clones[0], old);
    assert.equal(git(["rev-parse", "HEAD"], state.clones[0]), head);
  });
}

test("F3: fresh attempts never execute leftover npm config, even with the exact cached HEAD", { skip: process.platform === "win32" }, async t => {
  const { root, seed, workDir, git, c, state, head } = fixture(t);
  const old = path.join(workDir, "update-src"), marker = path.join(root, "residue-ran"), shell = path.join(root, "residue-shell");
  git(["clone", "--no-hardlinks", seed, old], root); git(["remote", "set-url", "origin", ORIGIN], old);
  fs.writeFileSync(shell, `#!/bin/sh\nprintf residue >> '${marker}'\nexec /bin/sh "$@"\n`, { mode: 0o700 });
  const npmrc = `script-shell=${shell}\n`;
  fs.writeFileSync(path.join(old, "app", ".npmrc"), npmrc);
  assert.equal(git(["rev-parse", "HEAD"], old), head);
  for (let attempt = 0; attempt < 2; attempt++) {
    const st = await c.check();
    await assert.rejects(c.install(st.target), /updates.buildFailed/);
    assert.equal(fs.existsSync(marker), false, "untracked script-shell must not execute");
    assert.equal(fs.readFileSync(path.join(state.npmDirs.at(-1), "trusted-ran"), "utf8"), "yes", "confirmed zero-dependency lifecycle script did run");
    assert.equal(fs.readFileSync(path.join(old, "app", ".npmrc"), "utf8"), npmrc, "old cache is not cleaned");
  }
  assert.equal(new Set(state.clones).size, 2, "every attempt owns a new checkout");
});

test("F2: generated source Test metadata cannot offer an older/equal Test package; Stable return stays explicit", async t => {
  const { seed, head, base, git, run, env, c, state } = fixture(t);
  git(["checkout", "--detach", head]);
  const r = run(process.execPath, [path.join(seed, "app", "scripts", "build-info.js")], seed,
    { ...env, DECK_UPDATE_CHANNEL: "test", DECK_RELEASE_TAG: "", DECK_SOURCE_COMMIT: head });
  assert.equal(r.code, 0, r.out);
  c.info = buildInfo({ dir: path.join(seed, "app", "main") });
  assert.equal(c.info.channel, "test"); assert.equal(c.info.releaseTag, ""); assert.equal(c.info.commit, head);
  state.installed = head;
  const release = { id: 10, draft: false, prerelease: true, tag_name: "v1.0.0-test.1",
    assets: [{ id: 1, name: "Hermes-Deck-1.0.0-Setup.exe" }, { id: 2, name: "SHA256SUMS.txt" }] };
  for (const commit of [base, head]) {
    state.releases = [{ ...release, target_commitish: commit }];
    for (const unavailable of [false, true]) {
      state.compareFails = unavailable;
      const st = await c.check();
      assert.equal(st.action, "none");
      assert.equal(st.release, null, "no older/equal package is advertised to UI or notification consumers");
      assert.equal(st.target, "");
      await assert.rejects(c.install(st.target), /updates.confirmRequired/);
    }
  }
  state.compareFails = false;
  state.head = "c".repeat(40);
  assert.equal((await c.check()).action, "build", "source Test still discovers new commits");
  state.channel = "stable";
  state.stable = { ...release, prerelease: false, tag_name: "v0.9.0" };
  const stable = await c.check();
  assert.equal(stable.action, "release"); assert.equal(stable.replaceBuild, true); assert.equal(stable.release.newer, false);
  await assert.rejects(c.install(), /updates.confirmRequired/);
  assert.deepEqual(state.commands, [], "check and refused consent execute nothing");
});

for (const drift of ["ditto", "codesign"]) {
  test(`F4: branch drift during macOS ${drift} removes staging and never launches`, async t => {
    const { root, head, c, state } = fixture(t);
    const target = path.join(root, "Hermes Deck.app"), built = path.join(root, "Built.app");
    for (const dir of [target, built]) fs.mkdirSync(path.join(dir, "Contents"), { recursive: true });
    fs.writeFileSync(path.join(target, "mark"), "old");
    fs.writeFileSync(path.join(built, "Contents", "Info.plist"), BUNDLE_ID);
    Object.assign(c, { platform: "darwin", arch: "arm64", appBundle: target });
    const st = await c.check(), ran = [];
    c.run = async (cmd, args, opts) => {
      ran.push(cmd);
      if (cmd === "git" && args[0] === "remote") return { code: 0, out: ORIGIN };
      if (cmd === "git" && args[0] === "rev-parse") return { code: 0, out: head };
      if (cmd === "npm" && args[0] === "run") fs.cpSync(built, path.join(opts.cwd, "dist", "mac-arm64", "Hermes Deck.app"), { recursive: true });
      if (cmd === "ditto") fs.cpSync(args[0], args[1], { recursive: true });
      if (cmd === drift) state.head = "c".repeat(40);
      return { code: 0, out: cmd === "plutil" ? BUNDLE_ID : "" };
    };
    await assert.rejects(c.install(st.target), /updates.changed/);
    assert.equal(ran.includes("/bin/sh"), false);
    assert.equal(fs.existsSync(path.join(root, ".Hermes Deck.app.update")), false);
    assert.equal(fs.readFileSync(path.join(target, "mark"), "utf8"), "old");
  });
}
