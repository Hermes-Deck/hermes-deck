"use strict";
// Update check (Settings > General > Updates): how far the repository's main branch has moved since the commit this
// app was built from, and whether a newer release exists; then one button to get there.
//
//   check()    GitHub compare <built commit>...main (commits ahead) + the latest release; no download.
//   install()  a newer release with an installer for this OS: download, verify against its SHA256SUMS.txt, run it
//              silently and quit (Windows: NSIS /S --force-run starts the new version). SHA256SUMS.txt is required.
//              Otherwise, only with the opt-in developer setting (updates.fromSource) and when main is ahead and
//              this machine has git and npm: build main in <userData>/update-src (its own clone, never the user's
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
const BRANCH_RE = /^[\w./-]{1,100}$/;
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
    commit: SHA_RE.test(info.commit) ? info.commit : "",
    branch: typeof info.branch === "string" ? info.branch : "",
    repo: REPO_RE.test(info.repo || "") ? info.repo : "",
    dirty: !!info.dirty,
    dev: !!info.dev,
  };
}

/** The installer asset for this platform in a release's asset list, or null. */
function installerAsset(assets, platform, arch = "x64") {
  const list = Array.isArray(assets) ? assets : [];
  if (platform === "win32") return list.find((a) => /-Setup\.exe$/i.test(a.name)) || null;
  if (platform === "darwin") return list.find((a) => new RegExp(`-mac-${arch === "arm64" ? "arm64" : "x64"}\\.zip$`, "i").test(a.name)) || null;
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
   * @param {() => object} o.settings  {repo?, branch?} overrides from Settings (updates)
   * @param {() => Promise<string>} o.token  a GitHub token or "" (see the header)
   * @param {(url: string, opts: object) => Promise<Response>} o.fetch
   * @param {string} o.platform      process.platform
   * @param {string} o.workDir       where downloads and the main clone live (<userData>)
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
    const s = this.settings() || {};
    return REPO_RE.test(s.repo || "") ? s.repo : this.info.repo;
  }

  _fromSource() {
    const s = this.settings() || {};
    return s.fromSource === true;
  }

  _branch() {
    const s = this.settings() || {};
    return BRANCH_RE.test(s.branch || "") ? s.branch : "main";
  }

  async _get(url, accept = "application/vnd.github+json") {
    const token = await this.token();
    const res = await this.fetch(url, { headers: { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "hermes-deck", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (res.status === 404 && !token) throw new Error("updates.noAccess");
    if (res.status === 401 || res.status === 403 || res.status === 404) throw new Error(token ? "updates.noAccess" : "updates.needToken");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }

  /** What this build is, before any check: version, commit, the branch it was built from, the repo and branch compared. */
  base() {
    return { version: this.version, commit: this.info.commit, built: this.info.branch, dirty: this.info.dirty, dev: this.info.dev, repo: this._repo(), branch: this._branch() };
  }

  /** Compare the built commit with the branch and look at the latest release. Never throws; errors land in status. */
  async check() {
    const repo = this._repo();
    const branch = this._branch();
    const base = { ...this.base(), checkedAt: Date.now() };
    if (!repo) return (this.status = { ...base, error: "updates.noRepo" });
    this.busy = "check";
    try {
      const out = { ...base, behind: 0, commits: [], head: "", release: null };
      // The compare is optional: a build whose commit the repository no longer has (history rewritten, a fork, a
      // local build) gets a 404/422 here, and that must never hide a newer release, so its failure only drops the
      // commit list. The release lookup below decides whether the check as a whole failed.
      let cmp = null, cmpError = null;
      if (this.info.commit) {
        try {
          cmp = await (await this._get(`${API}/repos/${repo}/compare/${this.info.commit}...${encodeURIComponent(branch)}`)).json();
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
        out.head = commits.length ? String(commits[commits.length - 1].sha || "") : this.info.commit;
      }
      try {
        const rel = await (await this._get(`${API}/repos/${repo}/releases/latest`)).json();
        const asset = installerAsset(rel.assets, this.platform, this.arch);
        out.release = { tag: String(rel.tag_name || ""), url: String(rel.html_url || ""), newer: newer(String(rel.tag_name || ""), this.version), asset: asset ? asset.name : "" };
      } catch (e) {
        // no release yet, or no access to releases: the commit count still stands; with neither, the check failed
        out.release = null;
        if (cmpError) throw cmpError;
      }
      if (cmpError) out.compare = "unavailable"; // this build's commit is unknown to the repository
      // Building unreleased source runs npm install scripts and an unreviewed branch on this computer: only on the
      // opt-in developer setting (Settings > Updates > Advanced). Never "update" to a branch that lacks this build's
      // own commits (a feature branch build): that would undo them.
      out.canBuild = (this.platform === "win32" || (this.platform === "darwin" && !!this.appBundle)) && this._fromSource() && out.behind > 0 && !out.ahead && (await this.has("git")) && (await this.has("npm"));
      out.action = out.release && out.release.newer && out.release.asset ? "release" : out.canBuild ? "build" : out.release && out.release.newer ? "download" : "none";
      return (this.status = out);
    } catch (e) {
      return (this.status = { ...base, error: /^updates\./.test(e.message) ? e.message : "updates.failed", detail: /^updates\./.test(e.message) ? "" : e.message });
    } finally {
      this.busy = null;
    }
  }

  /** Get the newer version and start its installer (see the header). Resolves with the installer path it ran. */
  async install() {
    if (this.busy) throw new Error("updates.busy");
    const st = this.status && !this.status.error ? this.status : await this.check();
    if (st.error) throw new Error(st.error);
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
    const rel = await (await this._get(`${API}/repos/${repo}/releases/latest`)).json();
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
    fs.writeFileSync(file, buf);
    return this._launch(file);
  }

  async _installBuild(st) {
    const repo = this._repo();
    const branch = this._branch();
    const src = path.join(this.workDir, "update-src");
    const step = async (phase, cmd, args, cwd) => {
      this.progress({ phase, text: `${cmd} ${args.join(" ")}` });
      const r = await this.run(cmd, args, { cwd });
      if (r.code !== 0) throw Object.assign(new Error("updates.buildFailed"), { detail: String(r.out || "").slice(-600) });
    };
    if (!fs.existsSync(path.join(src, ".git"))) await step("clone", "git", ["clone", "--filter=blob:none", `https://github.com/${repo}.git`, src], this.workDir);
    await step("fetch", "git", ["fetch", "origin", branch], src);
    await step("checkout", "git", ["checkout", "--detach", "--force", `origin/${branch}`], src);
    const app = path.join(src, "app");
    await step("deps", "npm", ["ci", "--no-audit", "--no-fund"], app);
    const dist = path.join(app, "dist");
    fs.rmSync(dist, { recursive: true, force: true }); // never pick up an installer from an earlier build
    await step("build", "npm", ["run", this.platform === "win32" ? "dist:win" : "dist"], app);
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
  async _launch(file) {
    if (this.platform === "darwin") return this._macSwap(file);
    if (this.platform !== "win32") throw Object.assign(new Error("updates.manual"), { file });
    this.progress({ phase: "install", text: path.basename(file) });
    await this.run(file, ["/S", "--force-run"], { detached: true });
    return file;
  }
}

Object.assign(UpdateChecker.prototype, {
  /** macOS: stage the new .app beside the running one and start the swap helper (see the header). */
  async _macSwap(file) {
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

module.exports = { UpdateChecker, SWAP_SH, BUNDLE_ID, buildInfo, installerAsset, sumFor, REPO_RE };
