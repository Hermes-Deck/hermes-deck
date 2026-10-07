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
      out.canBuild = this.platform === "win32" && this._fromSource() && out.behind > 0 && !out.ahead && (await this.has("git")) && (await this.has("npm"));
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
    await step("build", "npm", ["run", this.platform === "win32" ? "dist:win" : "dist"], app);
    const dist = path.join(app, "dist");
    const setup = fs.readdirSync(dist).filter((n) => /-Setup\.exe$/i.test(n)).map((n) => path.join(dist, n))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (!setup) throw Object.assign(new Error("updates.buildFailed"), { detail: "no installer in dist/" });
    return this._launch(setup, st);
  }

  /** Starts the installer detached; the caller quits the app so the installer can replace it. */
  async _launch(file) {
    // macOS (no notarization): no silent install. The verified download is kept; the caller shows it in Finder.
    if (this.platform !== "win32") throw Object.assign(new Error(this.platform === "darwin" ? "updates.manualDownloaded" : "updates.manual"), { file });
    this.progress({ phase: "install", text: path.basename(file) });
    await this.run(file, ["/S", "--force-run"], { detached: true });
    return file;
  }
}

module.exports = { UpdateChecker, buildInfo, installerAsset, sumFor, REPO_RE };
