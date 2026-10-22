"use strict";
// Update check (Settings > General > Updates): how far the selected branch has moved since the commit this
// app was built from, and whether a newer release exists; then one button to get there.
//
//   check()    Compare the built commit to a pinned main (Stable) or test/desktop-fixes (Test) head; optional releases.
//   install(target)  the explicitly confirmed release for this OS: download, verify its SHA256SUMS.txt, run it
//              silently and quit (Windows: NSIS /S --force-run starts the new version). SHA256SUMS.txt is required.
//              With the opt-in developer setting (updates.fromSource), a verified fast-forward and git/npm:
//              build the confirmed commit in a fresh <userData>/update-src-* clone (never the user's
//              checkout), then install that build the same way.
//   macOS      both paths end in a .app (the verified release zip unpacked, or the fresh build for this arch). It is
//              staged beside the running bundle, then a detached /bin/sh helper waits for this process to exit, swaps
//              the bundles and reopens the app; the old bundle comes back unless the new app is still running 10 s later. A dev
//              run, a translocated or read-only bundle never gets replaced: the file is shown in Finder instead.
//
// The built commit comes from main/build-info.json (scripts/build-info.js, packaged builds) or from git in a dev
// checkout. GitHub access uses a token from GH_TOKEN / GITHUB_TOKEN, the saved one (Settings, encrypted), or the
// GitHub CLI's login (`gh auth token`); the token never reaches the renderer. Network and process access are
// injected (deps) so the logic is unit-tested in app/test/update-check.test.js.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { newer } = require("./updates");

const API = "https://api.github.com";
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const CANONICAL_REPO = "Hermes-Deck/hermes-deck";
const TEST_BRANCH = "test/desktop-fixes";
const isSha = s => typeof s === "string" && s.length === 40 && SHA_RE.test(s);
const VERSION = "(0|[1-9]\\d{0,4})\\.(0|[1-9]\\d{0,4})\\.(0|[1-9]\\d{0,4})";
const STABLE_TAG = new RegExp(`^v${VERSION}$`);
const TEST_TAG = new RegExp(`^v${VERSION}-test\\.[1-9]\\d{0,8}$`);
const channelOf = (s) => s && s.channel === "test" ? "test" : "stable";
const validRelease = (r, channel) => !!r && r.draft === false && r.prerelease === (channel === "test") &&
  (channel === "test" ? TEST_TAG : STABLE_TAG).test(r.tag_name) && Number.isSafeInteger(r.id) && r.id > 0;
const safeAsset = (a) => !!a && /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(a.name) && Number.isSafeInteger(a.id) && a.id > 0;
const assetKey = (a) => a ? [a.id, a.name, a.size, a.updated_at, a.digest] : null;
const MAX_COMMITS = 20;
const APP_NAME = "Hermes Deck.app";
const BUNDLE_ID = "io.github.hermes-deck"; // electron-builder.yml appId
// argv: <pid> <bundle> <staged>. Waits up to 60 s for the app to exit (else changes nothing), moves the old bundle to a
// per-run backup (never touching an older leftover), moves the new one in and opens it. The backup is deleted only
// when the new app is still running DECK_SETTLE (10) s after it started; otherwise the new bundle is set aside as
// .failed-<pid> and the old one goes back and is opened. A backup that cannot be moved back is kept, never deleted.
const SWAP_SH = `#!/bin/sh
pid="$1"; target="$2"; staged="$3"; old="$target.old-$$"; failed="$target.failed-$$"; i=0
alive() { if [ -n "$DECK_ALIVE" ]; then "$DECK_ALIVE" "$target"; else pgrep -f "$target/Contents/MacOS/" >/dev/null 2>&1; fi; }
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1)); if [ "$i" -gt 600 ]; then rm -rf "$staged"; exit 1; fi
  sleep 0.1
done
if [ -e "$target" ] && ! mv "$target" "$old"; then rm -rf "$staged"; "\${DECK_OPEN:-open}" "$target"; exit 1; fi
if ! mv "$staged" "$target"; then [ -e "$old" ] && mv "$old" "$target"; rm -rf "$staged"; "\${DECK_OPEN:-open}" "$target"; exit 1; fi
"\${DECK_OPEN:-open}" "$target"
i=0; while ! alive; do i=$((i + 1)); [ "$i" -gt "\${DECK_START_WAIT:-300}" ] && break; sleep 0.1; done
sleep "\${DECK_SETTLE:-10}"
if alive; then rm -rf "$old"; exit 0; fi
[ -e "$old" ] || exit 1
mv "$target" "$failed" && mv "$old" "$target" && "\${DECK_OPEN:-open}" "$target"
exit 1
`;

/** The commit/branch/repo this app was built from: build-info.json, else git in the source tree. */
function buildInfo({ dir, readFile = fs.readFileSync, git = () => "" }) {
  let info = {};
  try {
    info = JSON.parse(readFile(path.join(dir, "build-info.json"), "utf8")) || {};
  } catch {
    const remote = git(["remote", "get-url", "origin"]);
    const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote || "");
    info = { commit: git(["rev-parse", "HEAD"]), branch: git(["rev-parse", "--abbrev-ref", "HEAD"]), repo: m ? `${m[1]}/${m[2]}` : "", dev: true };
  }
  return {
    commit: isSha(info.commit) ? info.commit : "",
    branch: typeof info.branch === "string" ? info.branch : "",
    repo: REPO_RE.test(info.repo || "") ? info.repo : "",
    dirty: !!info.dirty,
    dev: !!info.dev,
    channel: channelOf(info),
    releaseTag: (TEST_TAG.test(info.releaseTag) || STABLE_TAG.test(info.releaseTag)) ? info.releaseTag : "",
  };
}

/** The installer asset for this platform in a release's asset list, or null. */
function installerAsset(assets, platform, arch = "x64") {
  const list = (Array.isArray(assets) ? assets : []).filter(a => /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(a.name));
  if (platform === "win32" && arch === "x64") return list.find((a) => /-Setup\.exe$/i.test(a.name)) || null;
  if (platform === "darwin" && ["arm64", "x64"].includes(arch)) return list.find((a) => new RegExp(`-mac-${arch === "arm64" ? "arm64" : "x64"}\\.zip$`, "i").test(a.name)) || null;
  return null;
}

/** The sha256 next to `name` in a SHA256SUMS.txt body, or "". */
function sumFor(text, name) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m && m[2] === name) return m[1];
  }
  return "";
}

class UpdateChecker {
  /**
   * @param {object} o
   * @param {string} o.version       app.getVersion()
   * @param {object} o.info          buildInfo() result
   * @param {() => object} o.settings  {channel?, fromSource?} from Settings (updates)
   * @param {() => Promise<string>} o.token  a GitHub token or "" (see the header)
   * @param {(url: string, opts: object) => Promise<Response>} o.fetch
   * @param {string} o.platform      process.platform
   * @param {string} o.workDir       where downloads and per-attempt source clones live (<userData>)
   * @param {(cmd: string, args: string[], opts: object) => Promise<{code: number, out: string}>} o.run
   * @param {(cmd: string) => Promise<boolean>} o.has  whether a command (git, npm) is available
   * @param {(ev: object) => void} [o.progress]  install progress for the page
   */
  constructor(o) {
    Object.assign(this, { progress: () => {} }, o);
    this.status = null; // the last check()
    this.busy = null; // "check" | "install" while one runs
  }

  _repo() {
    // Legacy repo overrides remain stored, but never select executable code.
    return CANONICAL_REPO;
  }

  _fromSource() {
    const s = this.settings() || {};
    return s.fromSource === true;
  }

  _branch() {
    return this._channel() === "stable" ? "main" : TEST_BRANCH;
  }

  _channel() { return channelOf(this.settings()); }

  async _compare(branch) {
    if (!isSha(this.info.commit)) throw new Error("updates.sourceUnsafe");
    const url = `${API}/repos/${this._repo()}`;
    const ref = await (await this._get(`${url}/git/ref/heads/${branch}`)).json();
    if (!ref || ref.ref !== `refs/heads/${branch}` || ref.object?.type !== "commit" || !isSha(ref.object.sha)) throw new Error("updates.sourceUnsafe");
    const head = ref.object.sha;
    const cmp = await (await this._get(`${url}/compare/${this.info.commit}...${head}`)).json();
    // ponytail: GitHub's unpaginated compare caps at 250 commits; refuse incomplete history rather than guess a head.
    const ahead = cmp?.ahead_by, behind = cmp?.behind_by, commits = cmp?.commits;
    const status = ahead > 0 ? (behind > 0 ? "diverged" : "ahead") : behind > 0 ? "behind" : "identical";
    if (!Number.isSafeInteger(ahead) || ahead < 0 || !Number.isSafeInteger(behind) || behind < 0 ||
        cmp.status !== status || cmp.base_commit?.sha !== this.info.commit || !isSha(cmp.merge_base_commit?.sha) ||
        cmp.total_commits !== ahead || !Array.isArray(commits) || commits.length !== ahead ||
        commits.some(c => !isSha(c?.sha)) || new Set(commits.map(c => c.sha)).size !== commits.length ||
        (ahead > 0 && commits.at(-1).sha !== head) || (status === "identical" && head !== this.info.commit) ||
        (!behind && cmp.merge_base_commit.sha !== this.info.commit)) throw new Error("updates.sourceUnsafe");
    return { ...cmp, head };
  }

  _assertTarget(st) {
    if (this.status !== st || st.channel !== this._channel() || this.installSupported === false ||
        (st.action === "build" && (!this._fromSource() || !isSha(st.head) || st.branch !== this._branch()))) throw new Error("updates.changed");
  }

  async _validateBuild(st) {
    this._assertTarget(st);
    const cmp = await this._compare(st.branch);
    this._assertTarget(st);
    if (cmp.head !== st.head || cmp.status !== "ahead" || cmp.behind_by !== 0) throw new Error("updates.changed");
  }

  async _release(channel) {
    if (channel === "stable") {
      const r = await (await this._get(`${API}/repos/${this._repo()}/releases/latest`)).json();
      return validRelease(r, channel) ? r : null;
    }
    // ponytail: bounded to 100 recent releases; publish a fresh Test release if it ages out.
    const list = await (await this._get(`${API}/repos/${this._repo()}/releases?per_page=100`)).json();
    if (!Array.isArray(list)) throw new Error("updates.failed");
    return list.filter(r => validRelease(r, channel)).sort((a, b) => (Date.parse(b.published_at) || 0) - (Date.parse(a.published_at) || 0) || b.id - a.id)[0] || null;
  }

  _releaseView(rel, channel) {
    const asset = installerAsset(rel.assets, this.platform, this.arch);
    const sums = (Array.isArray(rel.assets) ? rel.assets : []).find(a => a.name === "SHA256SUMS.txt");
    return { id: rel.id, tag: rel.tag_name, url: `https://github.com/${this._repo()}/releases/tag/${rel.tag_name}`,
      newer: channel === "test" ? rel.tag_name !== this.info.releaseTag : newer(rel.tag_name, this.version),
      asset: safeAsset(asset) ? asset.name : "", sums: safeAsset(sums),
      fingerprint: JSON.stringify([rel.id, rel.tag_name, assetKey(asset), assetKey(sums)]) };
  }

  async _get(url, accept = "application/vnd.github+json") {
    const token = await this.token();
    const res = await this.fetch(url, { signal: AbortSignal.timeout(30_000), headers: { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "hermes-deck", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (res.status === 404 && !token) throw new Error("updates.noAccess");
    if (res.status === 401 || res.status === 403 || res.status === 404) throw new Error(token ? "updates.noAccess" : "updates.needToken");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }

  /** What this build is, before any check: version, commit, the branch it was built from, the repo and branch compared. */
  base() {
    return { channel: this._channel(), installedChannel: channelOf(this.info), releaseTag: this.info.releaseTag || "", version: this.version, commit: this.info.commit, built: this.info.branch, dirty: this.info.dirty, dev: this.info.dev, repo: this._repo(), branch: this._branch() };
  }

  /** Check the selected channel; network errors land in status, concurrent calls are refused. */
  async check() {
    if (this.busy) throw new Error("updates.busy");
    const branch = this._branch();
    const base = { ...this.base(), checkedAt: Date.now() };
    this.busy = "check";
    try {
      const out = { ...base, behind: 0, commits: [], head: "", release: null };
      // The compare is optional: a build whose commit the repository no longer has (history rewritten, a fork, a
      // local build) gets a 404/422 here, and that must never hide a newer release, so its failure only drops the
      // commit list. The release lookup below decides whether the check as a whole failed.
      let cmp = null, cmpError = this.info.commit ? null : new Error("updates.sourceUnsafe");
      if (this.info.commit) {
        try {
          cmp = await this._compare(branch);
        } catch (e) {
          cmpError = e;
        }
      }
      if (cmp) {
        out.behind = Number(cmp.ahead_by) || 0; // the branch is ahead of us by this many commits
        out.ahead = Number(cmp.behind_by) || 0; // this build has commits the branch does not (a feature branch)
        const commits = Array.isArray(cmp.commits) ? cmp.commits : [];
        out.commits = commits.slice(-MAX_COMMITS).reverse().map((c) => ({
          sha: String(c.sha || "").slice(0, 7),
          title: String((c.commit && c.commit.message) || "").split("\n")[0].slice(0, 120),
          date: (c.commit && c.commit.committer && c.commit.committer.date) || "",
        }));
        out.head = cmp.head;
      }
      try {
        // ponytail: source Test has no ordered package tag; omit fallback until release-commit ordering exists.
        const rel = base.channel === "test" && channelOf(this.info) === "test" && !this.info.releaseTag
          ? null : await this._release(base.channel);
        out.release = rel ? this._releaseView(rel, base.channel) : null;
      } catch (e) {
        // no release yet, or no access to releases: the commit count still stands; with neither, the check failed
        out.release = null;
        if (!cmp) throw e;
      }
      if (cmpError) out.compare = "unavailable"; // this build's commit is unknown to the repository
      // Building unreleased source runs npm install scripts and an unreviewed branch on this computer: only on the
      // opt-in developer setting (visible in Test; Advanced in Stable). Never "update" to a branch that lacks this build's
      // own commits (a feature branch build): that would undo them.
      out.replaceBuild = base.channel === "stable" && channelOf(this.info) === "test";
      const testAhead = base.channel === "test" && out.behind > 0;
      const candidate = !testAhead && out.release && (out.release.newer || out.replaceBuild);
      const sourceCandidate = !out.replaceBuild && !candidate && isSha(out.head) && out.behind > 0 && !out.ahead;
      const supported = (this.platform === "win32" && this.arch === "x64") ||
        (this.platform === "darwin" && ["arm64", "x64"].includes(this.arch) && !!this.appBundle);
      if (sourceCandidate) {
        out.unavailable = this.installSupported === false ? "updates.isolatedInstall" : !supported ? "updates.noAsset" :
          !this._fromSource() ? "updates.sourceDisabled" : !(await this.has("git")) || !(await this.has("npm")) ? "updates.sourceTools" : "";
      }
      out.canBuild = !!sourceCandidate && !out.unavailable;
      out.action = "none";
      if (candidate) {
        if (!out.release.asset) out.unavailable = "updates.noAsset";
        else if (!out.release.sums) out.unavailable = "updates.noSum";
        else if (this.installSupported === false) out.unavailable = "updates.isolatedInstall";
        else out.action = "release";
      } else if (out.canBuild) out.action = "build";
      else if (!out.unavailable && cmpError) out.unavailable = "updates.sourceUnsafe";
      else if (!out.unavailable && !out.release && (base.channel === "stable" || !cmp)) out.unavailable = base.channel === "test" ? "updates.noTestRelease" : "updates.noStableRelease";
      out.target = out.action === "release" ? JSON.stringify([base.channel, out.release.fingerprint]) :
        out.action === "build" ? JSON.stringify([base.channel, "build", out.head]) : "";
      if (base.channel !== this._channel()) throw new Error("updates.changed");
      return (this.status = out);
    } catch (e) {
      return (this.status = { ...base, error: /^updates\./.test(e.message) ? e.message : "updates.failed", detail: /^updates\./.test(e.message) ? "" : e.message });
    } finally {
      this.busy = null;
    }
  }

  /** Get the newer version and start its installer (see the header). Resolves with the installer path it ran. */
  async install(confirmedTarget) {
    if (this.busy) throw new Error("updates.busy");
    if (!confirmedTarget) throw new Error("updates.confirmRequired");
    const st = this.status;
    if (!st || st.error || st.target !== confirmedTarget || st.channel !== this._channel()) throw new Error("updates.changed");
    this._assertTarget(st);
    this.busy = "install";
    try {
      if (st.action === "release") return await this._installRelease(st);
      if (st.action === "build") return await this._installBuild(st);
      throw new Error("updates.nothing");
    } finally {
      this.busy = null;
    }
  }

  async _installRelease(st) {
    const repo = this._repo();
    this.progress({ phase: "download", text: st.release.asset });
    const rel = await (await this._get(`${API}/repos/${repo}/releases/${st.release.id}`)).json();
    if (!validRelease(rel, st.channel) || this._releaseView(rel, st.channel).fingerprint !== st.release.fingerprint) throw new Error("updates.changed");
    const asset = installerAsset(rel.assets, this.platform, this.arch);
    const sums = (rel.assets || []).find((a) => a.name === "SHA256SUMS.txt");
    if (!asset) throw new Error("updates.nothing");
    const dir = path.join(this.workDir, "update-download");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, asset.name);
    const buf = Buffer.from(await (await this._get(`${API}/repos/${repo}/releases/assets/${asset.id}`, "application/octet-stream")).arrayBuffer());
    // a release without SHA256SUMS.txt (or without a line for this installer) is never installed
    if (!sums) throw new Error("updates.noSum");
    const text = await (await this._get(`${API}/repos/${repo}/releases/assets/${sums.id}`, "application/octet-stream")).text();
    const want = sumFor(text, asset.name);
    const got = crypto.createHash("sha256").update(buf).digest("hex");
    if (!want || want !== got) throw new Error("updates.badSum");
    this._assertTarget(st);
    fs.writeFileSync(file, buf);
    return this._launch(file, st);
  }

  async _installBuild(st) {
    const repo = this._repo();
    await this._validateBuild(st);
    if (!(await this.has("git")) || !(await this.has("npm"))) throw new Error("updates.sourceTools");
    const src = fs.mkdtempSync(path.join(this.workDir, "update-src-"));
    const env = { ...process.env, DECK_UPDATE_CHANNEL: st.channel, DECK_RELEASE_TAG: "", DECK_SOURCE_COMMIT: st.head };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    const step = async (phase, cmd, args, cwd) => {
      this._assertTarget(st);
      this.progress({ phase, text: `${cmd} ${args.join(" ")}` });
      const r = await this.run(cmd, args, { cwd, env });
      if (r.code !== 0) throw Object.assign(new Error("updates.buildFailed"), { detail: String(r.out || "").slice(-600) });
      this._assertTarget(st);
    };
    // Never reuse or clean an old checkout: it may be linked elsewhere or contain executable residue.
    await step("clone", "git", ["clone", "--filter=blob:none", `https://github.com/${repo}.git`, src], this.workDir);
    const origin = await this.run("git", ["remote", "get-url", "origin"], { cwd: src });
    if (origin.code !== 0 || String(origin.out).trim() !== `https://github.com/${repo}.git`) throw new Error("updates.badOrigin");
    // Fetch the confirmed commit, not a moving branch.
    await step("fetch", "git", ["fetch", "origin", st.head], src);
    await step("checkout", "git", ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", st.head], src);
    const checked = await this.run("git", ["rev-parse", "HEAD"], { cwd: src, env });
    if (checked.code !== 0 || String(checked.out).trim() !== st.head) throw new Error("updates.changed");
    const app = path.join(src, "app");
    await step("deps", "npm", ["ci", "--no-audit", "--no-fund"], app);
    const dist = path.join(app, "dist");
    fs.rmSync(dist, { recursive: true, force: true }); // never pick up an installer from an earlier build
    await step("build", "npm", ["run", this.platform === "win32" ? "dist:win" : "dist"], app);
    await this._validateBuild(st);
    if (this.platform === "darwin") {
      // electron-builder: dist/mac (x64, the default arch) and dist/mac-arm64
      const built = path.join(dist, this.arch === "arm64" ? "mac-arm64" : "mac", APP_NAME);
      if (!fs.existsSync(path.join(built, "Contents", "Info.plist"))) throw Object.assign(new Error("updates.buildFailed"), { detail: `no ${APP_NAME} in dist/` });
      return this._launch(built, st);
    }
    const setup = fs.readdirSync(dist).filter((n) => /-Setup\.exe$/i.test(n)).map((n) => path.join(dist, n))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (!setup) throw Object.assign(new Error("updates.buildFailed"), { detail: "no installer in dist/" });
    return this._launch(setup, st);
  }

  /** Starts the installer detached; the caller quits the app so the installer can replace it. */
  async _launch(file, st) {
    if (st) this._assertTarget(st);
    if (this.platform === "darwin") return this._macSwap(file, st);
    if (this.platform !== "win32") throw Object.assign(new Error("updates.manual"), { file });
    this.progress({ phase: "install", text: path.basename(file) });
    const result = await this.run(file, ["/S", "--force-run"], { detached: true });
    if (result.code !== 0) throw new Error("updates.failed");
    return file;
  }
}

Object.assign(UpdateChecker.prototype, {
  /** macOS: stage the new .app beside the running one and start the swap helper (see the header). */
  async _macSwap(file, st) {
    const manual = Object.assign(new Error(/\.zip$/i.test(file) ? "updates.manualDownloaded" : "updates.manualBuilt"), { file });
    const target = this.appBundle;
    if (!target || !/\.app$/.test(target) || target.includes("/AppTranslocation/")) throw manual;
    const dir = path.dirname(target);
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      throw manual; // never ask for an admin password
    }
    let app = file;
    if (/\.zip$/i.test(file)) {
      const out = path.join(this.workDir, "update-unzip");
      fs.rmSync(out, { recursive: true, force: true });
      const r = await this.run("ditto", ["-x", "-k", file, out], {});
      const name = r.code === 0 && fs.existsSync(out) ? fs.readdirSync(out).find((n) => n.endsWith(".app")) : "";
      if (!name) throw manual;
      app = path.join(out, name);
    }
    const staged = path.join(dir, `.${path.basename(target)}.update`);
    fs.rmSync(staged, { recursive: true, force: true });
    this.progress({ phase: "install", text: path.basename(target) });
    const copied = await this.run("ditto", [app, staged], {});
    const id = copied.code === 0 ? await this.run("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(staged, "Contents", "Info.plist")], {}) : { code: 1, out: "" };
    // an ad-hoc signature still has to be intact, else Apple Silicon refuses to start the swapped-in app
    const signed = id.code === 0 ? await this.run("codesign", ["--verify", "--deep", staged], {}) : id;
    if (id.code !== 0 || String(id.out).trim() !== BUNDLE_ID || signed.code !== 0) {
      fs.rmSync(staged, { recursive: true, force: true });
      throw Object.assign(new Error("updates.badBundle"), { detail: String(id.out || copied.out || "").slice(-200) });
    }
    try {
      if (st?.action === "build") await this._validateBuild(st);
      else if (st) this._assertTarget(st);
    } catch (e) {
      fs.rmSync(staged, { recursive: true, force: true });
      throw e;
    }
    const script = path.join(this.workDir, "update-swap.sh");
    fs.writeFileSync(script, SWAP_SH, { mode: 0o700 });
    const r = await this.run("/bin/sh", [script, String(this.pid || process.pid), target, staged], { detached: true });
    if (r.code !== 0) {
      fs.rmSync(staged, { recursive: true, force: true });
      throw Object.assign(new Error("updates.failed"), { detail: r.out });
    }
    return target;
  },
});

module.exports = { UpdateChecker, SWAP_SH, BUNDLE_ID, buildInfo, installerAsset, sumFor, REPO_RE, CANONICAL_REPO, TEST_BRANCH, TEST_TAG, STABLE_TAG, channelOf };
