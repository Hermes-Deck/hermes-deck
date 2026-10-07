"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../../renderer/i18n");
// Installs the pinned cua-driver build (pins.js) and finds the installed one. Nothing is downloaded unless the
// user confirms in Settings → Bu cihaz; the archive's size and SHA-256 must match the pin before it is
// unpacked, and the publisher's code signature is checked before anything from it runs.
//   Windows: %LOCALAPPDATA%\hermes-deck\cua-driver\<version>\ (no admin rights, no OS prompts; not the
//            roaming profile). The zip's single top folder is flattened, so cua-driver.exe sits right in
//            <version>\. Every .exe/.dll/.node must carry a valid Authenticode signature from the pin's
//            signer. A version folder found there without our record (installed by hand) is used as is,
//            after the same signature check; detection never writes anything.
//   macOS:   the tarball holds CuaDriver.app (bundle com.trycua.driver). Its code signature, signing team
//            and Gatekeeper assessment are checked before it moves to ~/Applications; an existing
//            CuaDriver.app (~/Applications or /Applications) passing the same checks is used as is.
// fetch and process runs are injected, so app/test/cua-installer.test.js drives all of it without a network.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { extractZip } = require("./unzip");

const BUNDLE_ID = "com.trycua.driver";
const WIN_SIGNER = "Cua AI, Inc.";
const MAC_CLI = ["Contents/MacOS/cua-driver", "Contents/Resources/cua-driver", "Contents/Resources/bin/cua-driver", "Contents/Helpers/cua-driver", "Contents/MacOS/CuaDriver"];
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const VERSION_DIR = /^\d+\.\d+\.\d+([.+-][0-9A-Za-z.-]+)?$/;
const POWERSHELL = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
// Lists the Authenticode status and signer of every binary under $env:HD_CUA_DIR as JSON (the folder comes in
// through the environment, so no path is ever pasted into PowerShell source).
const SIG_SCRIPT =
  "$ErrorActionPreference='Stop'; Get-ChildItem -LiteralPath $env:HD_CUA_DIR -Recurse -File | " +
  "Where-Object { @('.exe','.dll','.node') -contains $_.Extension.ToLower() } | ForEach-Object { " +
  "$s = Get-AuthenticodeSignature -LiteralPath $_.FullName; " +
  "[pscustomobject]@{ File = $_.Name; Status = [string]$s.Status; Subject = [string]$s.SignerCertificate.Subject } } | ConvertTo-Json -Compress";

/** Runs a program without a shell or a console window. Resolves {code, stdout, stderr}; never rejects. */
function runFile(cmd, args, { timeout = 20000, env } = {}) {
  if (process.platform === "win32" && path.resolve(cmd).toLowerCase() === path.resolve(POWERSHELL).toLowerCase()) {
    // WinPS 5.1 cannot load PowerShell 7 modules inherited from its parent (including Security).
    env = Object.fromEntries(Object.entries(env || process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
    env.PSModulePath = path.join(path.dirname(POWERSHELL), "Modules");
  }
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, env, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (Number.isInteger(err.code) ? err.code : -1) : 0;
      resolve({ code, stdout: stdout || "", stderr: stderr || (err && !Number.isInteger(err.code) ? String(err.message) : "") });
    });
  });
}

/** The pin for this machine: exact platform-arch first, then a universal macOS build. */
function pinFor(platform, arch, pins) {
  const want = `${platform}-${arch}`;
  return pins.find((p) => p.platform === want) || (platform === "darwin" ? pins.find((p) => p.platform === "darwin-universal") : null) || null;
}

/** A pin the installer may use: filled in (not a TODO entry), https, a real checksum, size and signer. */
function usablePin(p, platform = process.platform) {
  if (!p || p.todo) return false;
  let host = null;
  try {
    const u = new URL(p.url);
    host = u.protocol === "https:" ? u.host : null;
  } catch {
    host = null;
  }
  if (!host || !VERSION_DIR.test(String(p.version)) || !/^[0-9a-f]{64}$/.test(String(p.sha256)) || !(p.size > 0)) return false;
  if (platform === "darwin") return /^[A-Z0-9]{10}$/.test(String(p.teamId || ""));
  if (platform === "win32") return typeof p.signer === "string" && p.signer.trim().length > 0;
  return true;
}

/** `codesign -dv --verbose=4` (stderr) -> {identifier, teamId, authorities}. */
function parseCodesign(text) {
  const out = { identifier: null, teamId: null, authorities: [] };
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^(\w+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === "Identifier") out.identifier = m[2];
    else if (m[1] === "TeamIdentifier") out.teamId = m[2];
    else if (m[1] === "Authority") out.authorities.push(m[2]);
  }
  return out;
}

/** The CN of an X.500 subject: 'CN="Cua AI, Inc.", O=…' -> "Cua AI, Inc.". */
function signerName(subject) {
  const m = /(?:^|,\s*)CN=(?:"((?:[^"]|"")*)"|([^,]*))/.exec(String(subject || ""));
  return m ? (m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2].trim()) : null;
}

/** SIG_SCRIPT's JSON (one object or an array) -> [{file, status, signer}]. */
function parseAuthenticode(out) {
  let v;
  try {
    v = JSON.parse(String(out || "").trim() || "[]");
  } catch {
    return null;
  }
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list.map((x) => ({ file: String((x && x.File) || ""), status: String((x && x.Status) || ""), signer: signerName(x && x.Subject) }));
}

/** "cua-driver 0.21.0" (or any text holding a version) -> "0.21.0". */
function parseVersion(text) {
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(String(text || ""));
  return m ? m[1] : null;
}

/** Semantic-version order for folder names ("0.33.3" > "0.21.10" > "0.21.9"). */
function cmpVersion(a, b) {
  const pa = String(a).split(/[.+-]/);
  const pb = String(b).split(/[.+-]/);
  for (let i = 0; i < 3; i++) {
    const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
    if (d) return d;
  }
  return String(a).localeCompare(String(b));
}

/** First file named `name` under `dir`, at most `depth` levels down. */
function findFile(dir, name, depth = 3) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) if (e.name.toLowerCase() === name.toLowerCase()) return path.join(dir, e.name);
  if (depth <= 0) return null;
  for (const e of entries) {
    if (!e.isDirectory() || e.name.endsWith(".app")) continue;
    const hit = findFile(path.join(dir, e.name), name, depth - 1);
    if (hit) return hit;
  }
  return null;
}

class Installer {
  /**
   * @param {object} o
   * @param {string} o.dir        Windows: %LOCALAPPDATA%\hermes-deck\cua-driver; macOS: userData/cua-driver (records only)
   * @param {string} [o.platform] process.platform
   * @param {string} [o.arch]     process.arch
   * @param {object[]} o.pins     pins.PINS
   * @param {typeof fetch} [o.fetch]
   * @param {typeof runFile} [o.run]
   * @param {string} [o.home]     the user's home (macOS ~/Applications)
   * @param {string} [o.systemApps] macOS system-wide Applications folder (tests point it away from the real one)
   */
  constructor({ dir, platform = process.platform, arch = process.arch, pins, fetch: fetchFn = globalThis.fetch, run = runFile, home = os.homedir(), systemApps = "/Applications" }) {
    Object.assign(this, { dir, platform, arch, pins, fetchFn, run, home, systemApps });
    this.file = path.join(dir, "installed.json");
    this.verified = new Map(); // Windows: folder -> mtime signature that passed the check (one check per change)
  }

  pin() {
    return pinFor(this.platform, this.arch, this.pins);
  }

  /** What Settings shows before asking: version, size and source host, or why there is nothing to install. */
  pinInfo() {
    const p = this.pin();
    if (!p) return { available: false, reason: i18nText("U0176") };
    if (!usablePin(p, this.platform)) return { available: false, todo: !!p.todo, reason: i18nText("U0177") };
    return { available: true, version: p.version, size: p.size, host: new URL(p.url).host, url: p.url, platform: p.platform };
  }

  _record() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * The installed driver: {status: "installed", version, bin, app?, source: "deck"|"system"}, {status: "missing"}
   * or {status: "error", error}. The publisher's signature is checked (once per change on Windows).
   */
  async detect() {
    const rec = this._record();
    if (this.platform === "darwin") {
      const apps = [rec && rec.app, path.join(this.home, "Applications", "CuaDriver.app"), path.join(this.systemApps, "CuaDriver.app")].filter(Boolean);
      const app = apps.find((a) => fs.existsSync(a));
      if (!app) return { status: "missing" };
      try {
        const v = await this._checkMacApp(app, this.pin());
        return { status: "installed", version: v.version, bin: v.bin, app, source: rec && rec.app === app ? "deck" : "system" };
      } catch (e) {
        return { status: "error", error: e.message, app };
      }
    }
    if (this.platform !== "win32") return { status: "missing" };
    let found = null;
    if (rec && rec.bin && fs.existsSync(rec.bin)) found = { version: rec.version || null, bin: rec.bin, source: "deck" };
    else if (rec && rec.bin) return { status: "error", error: i18nText("U0178") };
    else found = this._scanWin();
    if (!found) return { status: "missing" };
    try {
      await this._checkWinSignatures(path.dirname(found.bin));
    } catch (e) {
      return { status: "error", error: e.message, bin: found.bin };
    }
    return { status: "installed", ...found };
  }

  /** A version folder under dir holding cua-driver.exe: the pinned version first, else the newest. */
  _scanWin() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir, { withFileTypes: true }).filter((e) => e.isDirectory() && VERSION_DIR.test(e.name)).map((e) => e.name);
    } catch {
      return null;
    }
    const pin = this.pin();
    names.sort((a, b) => (pin && a === pin.version ? -1 : pin && b === pin.version ? 1 : cmpVersion(b, a)));
    for (const n of names) {
      const bin = path.join(this.dir, n, "cua-driver.exe");
      if (fs.existsSync(bin)) return { version: n, bin, source: "system" };
    }
    return null;
  }

  /** Names, sizes and times of a folder's files: unchanged files are not checked twice in a run. */
  _stamp(folder) {
    return fs
      .readdirSync(folder)
      .map((n) => {
        try {
          const s = fs.statSync(path.join(folder, n));
          return `${n}:${s.size}:${s.mtimeMs}`;
        } catch {
          return n;
        }
      })
      .join("|");
  }

  /** Every binary in the folder carries a valid Authenticode signature from the expected publisher. */
  async _checkWinSignatures(folder) {
    const pin = this.pin();
    const want = (pin && pin.signer) || WIN_SIGNER;
    const stamp = this._stamp(folder);
    if (this.verified.get(folder) === stamp) return;
    const r = await this.run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", SIG_SCRIPT], { timeout: 60000, env: { ...process.env, HD_CUA_DIR: folder } });
    const list = r.code === 0 ? parseAuthenticode(r.stdout) : null;
    if (!list) throw new Error(i18nText("U0179"));
    if (!list.some((x) => x.file.toLowerCase() === "cua-driver.exe")) throw new Error(i18nText("U0180"));
    const bad = list.find((x) => x.status !== "Valid");
    if (bad) throw new Error(i18nText("U0181", { file: bad.file, v: bad.status || i18nText("U0182") }));
    const other = list.find((x) => x.signer !== want);
    if (other) throw new Error(i18nText("U0183", { file: other.file, v: other.signer || "?" }));
    this.verified.set(folder, stamp);
  }

  /**
   * Downloads, verifies and unpacks the pinned build. onProgress({phase, got?, total?}) with phase
   * "download" | "verify" | "unpack". Resolves the new detect() result; throws a user-facing error.
   */
  async install(onProgress = () => {}) {
    const pin = this.pin();
    if (!usablePin(pin, this.platform)) throw new Error(this.pinInfo().reason);
    if (typeof this.fetchFn !== "function") throw new Error(i18nText("U0184"));
    const buf = await this._download(pin, onProgress);
    onProgress({ phase: "verify" });
    const sum = crypto.createHash("sha256").update(buf).digest("hex");
    if (sum !== pin.sha256) throw new Error(i18nText("U0185"));
    onProgress({ phase: "unpack" });
    if (this.platform === "win32") await this._installWin(buf, pin);
    else if (this.platform === "darwin") await this._installMac(buf, pin);
    else throw new Error(i18nText("A0106"));
    return this.detect();
  }

  async _download(pin, onProgress) {
    let res;
    try {
      res = await this.fetchFn(pin.url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (e) {
      throw new Error(i18nText("U0186", { message: e.message }));
    }
    if (!res || !res.ok) throw new Error(i18nText("U0187", { v: res ? res.status : "?" }));
    const len = Number(res.headers && res.headers.get ? res.headers.get("content-length") : NaN);
    if (Number.isFinite(len) && len > 0 && len !== pin.size) throw new Error(i18nText("A0118", { len: len, size: pin.size }));
    const parts = [];
    let got = 0;
    let last = 0;
    for await (const chunk of res.body) {
      const b = Buffer.from(chunk);
      got += b.length;
      if (got > pin.size) throw new Error(i18nText("U0188"));
      parts.push(b);
      if (got - last > 256 * 1024 || got === pin.size) {
        last = got;
        onProgress({ phase: "download", got, total: pin.size });
      }
    }
    if (got !== pin.size) throw new Error(i18nText("U0189", { got: got, size: pin.size }));
    return Buffer.concat(parts, got);
  }

  async _installWin(buf, pin) {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = path.join(this.dir, pin.version);
    const staging = path.join(this.dir, `.unpack-${process.pid}`);
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      extractZip(buf, staging);
      // the release zip holds one folder (cua-driver-rs-<v>-windows-x86_64/): its contents become <version>\
      const top = fs.readdirSync(staging, { withFileTypes: true });
      const root = top.length === 1 && top[0].isDirectory() ? path.join(staging, top[0].name) : staging;
      if (!fs.existsSync(path.join(root, "cua-driver.exe"))) throw new Error(i18nText("U0190"));
      await this._checkWinSignatures(root);
      if (fs.existsSync(target)) fs.renameSync(target, `${target}.replaced-${Date.now()}`); // kept, never deleted
      fs.renameSync(root, target);
      this.verified.set(target, this._stamp(target)); // the files just checked, moved as they were
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    const bin = path.join(target, "cua-driver.exe");
    const probe = await this.run(bin, ["--version"], { timeout: 15000 });
    if (probe.code !== 0) throw new Error(i18nText("U0191", { v: (probe.stderr || probe.stdout).trim().slice(0, 160) || i18nText("U0120", { code: probe.code }) }));
    this._save({ version: pin.version, platform: pin.platform, bin, sha256: pin.sha256 });
    await this.run(bin, ["telemetry", "disable"], { timeout: 15000 }); // best effort: older builds lack it
  }

  async _installMac(buf, pin) {
    const target = path.join(this.home, "Applications", "CuaDriver.app");
    if (fs.existsSync(target)) throw new Error(i18nText("U0192"));
    const work = path.join(this.dir, `unpack-${process.pid}`);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    try {
      const archive = path.join(work, "driver.tar.gz");
      fs.writeFileSync(archive, buf);
      const tar = await this.run("/usr/bin/tar", ["-xzf", archive, "-C", work], { timeout: 120000 });
      if (tar.code !== 0) throw new Error(i18nText("U0193", { v: tar.stderr.trim().slice(0, 160) }));
      const app = findFile(work, "CuaDriver.app");
      if (!app) throw new Error(i18nText("U0194"));
      await this._checkMacApp(app, pin);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        fs.renameSync(app, target);
      } catch {
        const copy = await this.run("/usr/bin/ditto", [app, target], { timeout: 120000 });
        if (copy.code !== 0) throw new Error(i18nText("U0195", { v: copy.stderr.trim().slice(0, 160) }));
      }
      const v = await this._checkMacApp(target, pin); // once more where it will run from
      this._save({ version: v.version || pin.version, platform: pin.platform, app: target, bin: v.bin, sha256: pin.sha256 });
      const bin = v.bin;
      await this.run(bin, ["telemetry", "disable"], { timeout: 15000 }); // best effort
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  /** Bundle id, code signature (team from the pin when there is one) and Gatekeeper; returns {version, bin}. */
  async _checkMacApp(app, pin) {
    const plist = path.join(app, "Contents", "Info.plist");
    const id = await this.run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist]);
    if (id.code !== 0 || id.stdout.trim() !== BUNDLE_ID) throw new Error(i18nText("U0196"));
    const verify = await this.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { timeout: 60000 });
    if (verify.code !== 0) throw new Error(i18nText("U0197"));
    const info = parseCodesign((await this.run("/usr/bin/codesign", ["-dv", "--verbose=4", app])).stderr);
    if (usablePin(pin, "darwin") && info.teamId !== pin.teamId) throw new Error(i18nText("U0198", { v: info.teamId || i18nText("common.none") }));
    const gk = await this.run("/usr/sbin/spctl", ["--assess", "--type", "execute", app], { timeout: 60000 });
    if (gk.code !== 0) throw new Error(i18nText("U0199"));
    const ver = await this.run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist]);
    const bin = MAC_CLI.map((rel) => path.join(app, rel)).find((p) => fs.existsSync(p));
    if (!bin) throw new Error(i18nText("U0200"));
    return { version: parseVersion(ver.stdout), bin };
  }

  _save(rec) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...rec, installedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = {
  Installer,
  pinFor,
  usablePin,
  parseCodesign,
  parseAuthenticode,
  signerName,
  parseVersion,
  cmpVersion,
  findFile,
  runFile,
  BUNDLE_ID,
  WIN_SIGNER,
  POWERSHELL,
};
