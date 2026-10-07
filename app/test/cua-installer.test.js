"use strict";
// Driver install: the pinned table, download size and SHA-256 checks, the zip reader's path guards, the
// Windows unpack and the macOS signature checks. No network and no real driver: fetch and process runs are
// fakes. Run: cd app && npm test
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { extractZip, safeRel, crc32 } = require("../main/cua/unzip");
const { Installer, pinFor, usablePin, parseCodesign, parseVersion, parseAuthenticode, signerName, cmpVersion, runFile, POWERSHELL } = require("../main/cua/installer");
const { PINS } = require("../main/cua/pins");
const { setLanguage } = require("../renderer/i18n");
setLanguage("tr");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "deck-cua-"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** A small zip writer for the tests: [{name, data, deflate?}] -> Buffer. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.from(f.data || "");
    const body = f.deflate ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(f.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(f.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, name, body);
    centrals.push(ch, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const response = (buf, { status = 200, length = buf.length } = {}) => ({
  ok: status === 200,
  status,
  headers: new Headers(length === null ? {} : { "content-length": String(length) }),
  body: (async function* () {
    for (let i = 0; i < buf.length; i += 1000) yield buf.subarray(i, i + 1000);
  })(),
});

test("Windows PowerShell 5.1 child uses its own security module despite inherited PowerShell 7 modules", { skip: process.platform !== "win32" }, async () => {
  const modules = tmp();
  const poison = path.join(modules, "Microsoft.PowerShell.Security");
  fs.mkdirSync(poison);
  fs.writeFileSync(path.join(poison, "Microsoft.PowerShell.Security.psd1"), "@{ModuleVersion='7.0.0';PowerShellVersion='7.0';RootModule='Security.psm1';FunctionsToExport=@('Get-AuthenticodeSignature')}");
  fs.writeFileSync(path.join(poison, "Security.psm1"), "function Get-AuthenticodeSignature { throw 'Wrong runtime module' }");
  const env = { ...process.env, PSMODULEPATH: modules, HD_CUA_DIR: "fixture-folder" };
  delete env.PSModulePath;
  const r = await runFile(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath (Join-Path $PSHOME 'powershell.exe'); [pscustomobject]@{ Major=$PSVersionTable.PSVersion.Major; Module=(Get-Command Get-AuthenticodeSignature).Module.Path; Status=[string]$s.Status; Marker=$env:HD_CUA_DIR } | ConvertTo-Json -Compress"], { env });
  assert.strictEqual(r.code, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.strictEqual(result.Major, 5);
  assert.strictEqual(result.Module.toLowerCase(), path.join(path.dirname(POWERSHELL), "Modules", "Microsoft.PowerShell.Security", "Microsoft.PowerShell.Security.psd1").toLowerCase());
  assert.strictEqual(result.Status, "Valid");
  assert.strictEqual(result.Marker, "fixture-folder");
  assert.strictEqual(env.PSMODULEPATH, modules, "the parent's environment is preserved");
});

test("unzip: stored and deflated entries, and every unsafe path refused", () => {
  const dir = tmp();
  const zip = makeZip([
    { name: "cua-driver/", data: "" },
    { name: "cua-driver/cua-driver.exe", data: "MZ fake binary".repeat(50), deflate: true },
    { name: "cua-driver/README.txt", data: "hello" },
  ]);
  const files = extractZip(zip, path.join(dir, "out"));
  assert.deepStrictEqual(files, ["cua-driver/cua-driver.exe", "cua-driver/README.txt"]);
  assert.strictEqual(fs.readFileSync(path.join(dir, "out", "cua-driver", "README.txt"), "utf8"), "hello");
  for (const bad of ["../evil.exe", "a/../../evil", "/abs/x", "C:\\Windows\\x.dll", "a/b:stream", "con.txt ", "dir\\..\\..\\x"]) {
    assert.throws(() => safeRel(bad), /ZIP/, bad);
    assert.throws(() => extractZip(makeZip([{ name: bad, data: "x" }]), path.join(dir, `bad-${Math.random()}`)), /ZIP/, bad);
  }
  const broken = makeZip([{ name: "a.txt", data: "abc" }]);
  broken[30 + 5] ^= 0xff; // flip a data byte: CRC check
  assert.throws(() => extractZip(broken, path.join(dir, "crc")), /CRC/);
  assert.throws(() => extractZip(Buffer.from("not a zip at all, just bytes"), path.join(dir, "nz")), /ZIP değil/);
});

test("pins: Windows and universal macOS release artifacts have verified usable pins", () => {
  const win = PINS.find((p) => p.platform === "win32-x64");
  assert.ok(usablePin(win, "win32"), "filled in: https, version, sha256, size, signer");
  assert.strictEqual(win.version, "0.33.3");
  assert.strictEqual(win.size, 31016817);
  assert.strictEqual(win.signer, "Cua AI, Inc.");
  assert.match(win.url, /^https:\/\/github\.com\/trycua\/cua\/releases\/download\/cua-driver-rs-v0\.33\.3\//);
  const mac = pinFor("darwin", "arm64", PINS);
  assert.ok(mac && usablePin(mac, "darwin"));
  assert.strictEqual(mac.version, "0.33.3");
  assert.strictEqual(mac.teamId, "YCK386LBJ7");
  assert.strictEqual(mac.sha256, "e4d5a6c2f8b1dff776bc7260717b723d753c3deeb020469a6eb85eacf862bfca");
  assert.strictEqual(mac.size, 75255030);
  assert.strictEqual(mac.url, "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.33.3/cua-driver-rs-0.33.3-darwin-universal.tar.gz");
  assert.strictEqual(pinFor("darwin", "x64", PINS), mac);
  const good = { version: "0.21.0", platform: "win32-x64", url: "https://example.org/d.zip", sha256: "a".repeat(64), size: 10, signer: "Example Inc." };
  assert.ok(usablePin(good, "win32"));
  assert.ok(!usablePin({ ...good, signer: "" }, "win32"), "Windows pins name the Authenticode signer");
  assert.ok(!usablePin({ ...good, url: "http://example.org/d.zip" }, "win32"), "plain http");
  assert.ok(!usablePin({ ...good, sha256: "abc" }, "win32"));
  assert.ok(!usablePin({ ...good, platform: "darwin-arm64" }, "darwin"), "macOS pins need the signing team");
  assert.ok(usablePin({ ...good, platform: "darwin-arm64", teamId: "ABCDE12345" }, "darwin"));
  assert.strictEqual(pinFor("darwin", "arm64", [{ ...good, platform: "darwin-universal" }]).platform, "darwin-universal");
  assert.strictEqual(pinFor("win32", "arm64", [good]), null);
  assert.strictEqual(parseVersion("cua-driver 0.33.3\n"), "0.33.3");
  assert.ok(cmpVersion("0.33.3", "0.21.10") > 0 && cmpVersion("0.21.10", "0.21.9") > 0);
  assert.deepStrictEqual(parseCodesign("Executable=/x\nIdentifier=com.trycua.driver\nAuthority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\n"), {
    identifier: "com.trycua.driver",
    teamId: "ABCDE12345",
    authorities: ["Developer ID Application: Example (ABCDE12345)"],
  });
  assert.strictEqual(signerName('CN="Cua AI, Inc.", O="Cua AI, Inc.", L=San Francisco, S=California, C=US'), "Cua AI, Inc.");
  assert.strictEqual(signerName("CN=Example Corp, O=Example"), "Example Corp");
  assert.deepStrictEqual(parseAuthenticode('{"File":"cua-driver.exe","Status":"Valid","Subject":"CN=\\"Cua AI, Inc.\\", O=x"}'), [{ file: "cua-driver.exe", status: "Valid", signer: "Cua AI, Inc." }]);
  assert.strictEqual(parseAuthenticode("not json"), null);
});

/** A fake process runner: Authenticode answers from `sig`, `--version` from `version`. */
function winRunner(calls, sig = () => ({ status: "Valid", signer: "Cua AI, Inc." }), version = "cua-driver 0.33.3\n") {
  return async (cmd, args, opts) => {
    const base = path.basename(cmd).toLowerCase();
    calls.push([base, ...(base === "powershell.exe" ? [] : args)]);
    if (base === "powershell.exe") {
      const dir = opts.env.HD_CUA_DIR;
      const files = fs.readdirSync(dir).filter((n) => /\.(exe|dll|node)$/i.test(n));
      const list = files.map((f) => {
        const s = sig(f);
        return { File: f, Status: s.status, Subject: s.signer ? `CN="${s.signer}", O="${s.signer}", C=US` : "" };
      });
      return { code: 0, stdout: JSON.stringify(list.length === 1 ? list[0] : list), stderr: "" };
    }
    if (args[0] === "--version") return { code: 0, stdout: version, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

test("installer (Windows): size, SHA-256 and publisher signature enforced; the release folder is flattened", async () => {
  const dir = tmp();
  const zip = makeZip([
    { name: "cua-driver-rs-0.33.3-windows-x86_64/cua-driver.exe", data: "MZ".repeat(400), deflate: true },
    { name: "cua-driver-rs-0.33.3-windows-x86_64/cua_driver_sdk.dll", data: "MZ dll" },
    { name: "cua-driver-rs-0.33.3-windows-x86_64/LICENSE", data: "MIT" },
  ]);
  const pin = { version: "0.33.3", platform: "win32-x64", url: "https://example.org/cua-driver-rs-0.33.3-windows-x86_64.zip", sha256: sha(zip), size: zip.length, signer: "Cua AI, Inc." };
  const calls = [];
  const run = winRunner(calls);

  const todo = new Installer({ dir, platform: "win32", arch: "x64", pins: [{ ...pin, todo: true }], fetch: async () => assert.fail("must not download"), run });
  assert.deepStrictEqual(todo.pinInfo(), { available: false, todo: true, reason: "Sabitlenmiş sürücü sürümü henüz eklenmedi (onay bekleniyor)." });
  await assert.rejects(todo.install(), /henüz eklenmedi/);
  assert.deepStrictEqual(await todo.detect(), { status: "missing" });

  const wrongSize = new Installer({ dir, platform: "win32", arch: "x64", pins: [pin], fetch: async () => response(zip, { length: zip.length + 1 }), run });
  await assert.rejects(wrongSize.install(), /Beklenmeyen dosya boyutu/);
  const tampered = Buffer.from(zip);
  tampered[40] ^= 1;
  const badSum = new Installer({ dir, platform: "win32", arch: "x64", pins: [pin], fetch: async () => response(tampered), run });
  await assert.rejects(badSum.install(), /SHA-256 tutmadı/);
  assert.ok(!fs.existsSync(path.join(dir, "0.33.3")), "nothing unpacked after a checksum failure");
  const http404 = new Installer({ dir, platform: "win32", arch: "x64", pins: [pin], fetch: async () => response(Buffer.alloc(0), { status: 404 }), run });
  await assert.rejects(http404.install(), /HTTP 404/);
  // a valid checksum but a foreign or broken signature: nothing lands in the version folder
  const foreign = new Installer({ dir, platform: "win32", arch: "x64", pins: [pin], fetch: async () => response(zip), run: winRunner([], () => ({ status: "Valid", signer: "Someone Else" })) });
  await assert.rejects(foreign.install(), /beklenmeyen bir yayıncı/);
  const unsigned = new Installer({ dir, platform: "win32", arch: "x64", pins: [pin], fetch: async () => response(zip), run: winRunner([], (f) => (f === "cua_driver_sdk.dll" ? { status: "NotSigned", signer: null } : { status: "Valid", signer: "Cua AI, Inc." })) });
  await assert.rejects(unsigned.install(), /imzası geçersiz: cua_driver_sdk\.dll \(NotSigned\)/);
  assert.ok(!fs.existsSync(path.join(dir, "0.33.3")), "nothing installed after a signature failure");
  assert.ok(!fs.readdirSync(dir).some((n) => n.startsWith(".unpack-")), "the unpack folder is cleaned up");

  const progress = [];
  const inst = new Installer({ dir, platform: "win32", arch: "x64", pins: [pin], fetch: async (url, opts) => (assert.strictEqual(url, pin.url), assert.strictEqual(opts.redirect, "follow"), response(zip)), run });
  assert.deepStrictEqual(inst.pinInfo(), { available: true, version: "0.33.3", size: zip.length, host: "example.org", url: pin.url, platform: "win32-x64" });
  const st = await inst.install((p) => progress.push(p.phase));
  const bin = path.join(dir, "0.33.3", "cua-driver.exe");
  assert.deepStrictEqual(st, { status: "installed", version: "0.33.3", bin, source: "deck" });
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, "0.33.3")).sort(), ["LICENSE", "cua-driver.exe", "cua_driver_sdk.dll"]);
  assert.ok(progress.includes("download") && progress.includes("verify") && progress.includes("unpack"));
  assert.deepStrictEqual(calls, [["powershell.exe"], ["cua-driver.exe", "--version"], ["cua-driver.exe", "telemetry", "disable"]]);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, "installed.json"), "utf8")).sha256, pin.sha256);
  // a second install of the same pin keeps the first folder aside instead of deleting it
  await inst.install();
  assert.ok(fs.readdirSync(dir).some((n) => /^0\.33\.3\.replaced-\d+$/.test(n)));
  fs.rmSync(bin);
  assert.strictEqual((await inst.detect()).status, "error");
});

test("installer (Windows): a version folder installed by hand is found, checked and never written to", async () => {
  const dir = tmp();
  for (const v of ["0.21.0", "0.33.3", "notes"]) fs.mkdirSync(path.join(dir, v), { recursive: true });
  fs.writeFileSync(path.join(dir, "0.21.0", "cua-driver.exe"), "MZ old");
  fs.writeFileSync(path.join(dir, "0.33.3", "cua-driver.exe"), "MZ new");
  fs.writeFileSync(path.join(dir, "0.33.3", "cua_driver_sdk.dll"), "MZ");
  const before = JSON.stringify(fs.readdirSync(dir).sort());
  const calls = [];
  const pin = { version: "0.33.3", platform: "win32-x64", url: "https://example.org/x.zip", sha256: "b".repeat(64), size: 1, signer: "Cua AI, Inc." };
  const inst = new Installer({ dir, platform: "win32", arch: "x64", pins: [pin], fetch: async () => assert.fail("no download"), run: winRunner(calls) });
  assert.deepStrictEqual(await inst.detect(), { status: "installed", version: "0.33.3", bin: path.join(dir, "0.33.3", "cua-driver.exe"), source: "system" });
  await inst.detect(); // unchanged files: the signature is not checked again
  assert.deepStrictEqual(calls, [["powershell.exe"]]);
  assert.strictEqual(JSON.stringify(fs.readdirSync(dir).sort()), before, "detection writes nothing");
  const bad = new Installer({ dir, platform: "win32", arch: "x64", pins: [pin], fetch: async () => assert.fail("no download"), run: winRunner([], () => ({ status: "HashMismatch", signer: "Cua AI, Inc." })) });
  const st = await bad.detect();
  assert.strictEqual(st.status, "error");
  assert.match(st.error, /HashMismatch/);
});

test("installer (macOS): CuaDriver.app identity, team and Gatekeeper checks; an existing app is reused", async () => {
  const home = tmp();
  const dir = path.join(home, "userData", "cua-driver");
  const makeApp = (root) => {
    const app = path.join(root, "CuaDriver.app");
    fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(app, "Contents", "Info.plist"), "<plist/>");
    fs.writeFileSync(path.join(app, "Contents", "MacOS", "cua-driver"), "#!/bin/sh\n");
    return app;
  };
  const tarball = Buffer.from("pretend this is a tar.gz with CuaDriver.app inside");
  const pin = { version: "0.21.0", platform: "darwin-arm64", url: "https://example.org/CuaDriver.tar.gz", sha256: sha(tarball), size: tarball.length, teamId: "ABCDE12345" };
  let team = "ABCDE12345";
  let bundle = "com.trycua.driver";
  let gatekeeper = 0;
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(path.basename(cmd));
    if (cmd === "/usr/bin/tar") {
      makeApp(args[args.indexOf("-C") + 1]);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "/usr/bin/plutil") return { code: 0, stdout: args[1] === "CFBundleIdentifier" ? `${bundle}\n` : "0.21.0\n", stderr: "" };
    if (cmd === "/usr/bin/codesign" && args[0] === "--verify") return { code: 0, stdout: "", stderr: "" };
    if (cmd === "/usr/bin/codesign") return { code: 0, stdout: "", stderr: `Identifier=com.trycua.driver\nTeamIdentifier=${team}\n` };
    if (cmd === "/usr/sbin/spctl") return { code: gatekeeper, stdout: "", stderr: gatekeeper ? "rejected" : "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const inst = new Installer({ dir, platform: "darwin", arch: "arm64", pins: [pin], fetch: async () => response(tarball), run, home, systemApps: path.join(home, "system-apps") });
  assert.deepStrictEqual(await inst.detect(), { status: "missing" });
  const st = await inst.install();
  const target = path.join(home, "Applications", "CuaDriver.app");
  assert.deepStrictEqual(st, { status: "installed", version: "0.21.0", bin: path.join(target, "Contents", "MacOS", "cua-driver"), app: target, source: "deck" });
  assert.ok(calls.includes("tar") && calls.includes("spctl"));
  assert.ok(!fs.readdirSync(dir).some((n) => n.startsWith("unpack-")), "the unpack folder is cleaned up");
  await assert.rejects(inst.install(), /zaten var/);

  // checks run on every detect: a foreign team, another bundle, or a Gatekeeper refusal is an error
  team = "ZZZZZ99999";
  assert.match((await inst.detect()).error, /beklenmeyen bir ekip/);
  team = "ABCDE12345";
  bundle = "com.example.other";
  assert.match((await inst.detect()).error, /paket kimliği/);
  bundle = "com.trycua.driver";
  gatekeeper = 3;
  assert.match((await inst.detect()).error, /Gatekeeper/);
  gatekeeper = 0;

  // a CuaDriver.app the user installed is used as is ("system")
  const home2 = tmp();
  makeApp(path.join(home2, "Applications"));
  const sys = new Installer({ dir: path.join(home2, "ud"), platform: "darwin", arch: "arm64", pins: [pin], fetch: async () => assert.fail("no download"), run, home: home2 });
  assert.strictEqual((await sys.detect()).source, "system");
});
