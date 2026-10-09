"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const J = require("../src/update-job");

const base = { uid: 501, node: "/usr/bin/node", updater: "/r/current/relay/bin/deck-relay-update", args: ["apply", "--version", "1.3.0"], dataDir: "/r/shared/data", logDir: "/r/shared/logs", now: () => 1700000000000 };

test("linux: systemd-run --user, outside the relay unit, collected when done", () => {
  const s = J.jobSpec({ ...base, platform: "linux" });
  assert.equal(s.kind, "systemd");
  assert.equal(s.cmd, "systemd-run");
  assert.deepEqual(s.args, ["--user", `--unit=${s.label}`, "--collect", "--quiet", "--", "/usr/bin/node", base.updater, ...base.args]);
  assert.match(s.label, /^hermes-deck-update-1700000000000$/);
});

test("macOS: a generated plist bootstrapped into the GUI domain, never launchctl submit", () => {
  const s = J.jobSpec({ ...base, platform: "darwin" });
  assert.equal(s.kind, "launchd");
  assert.equal(s.label, "com.hermes-deck.update.1700000000000");
  assert.equal(s.plistFile, path.join(base.dataDir, "update-job.plist"));
  assert.deepEqual([s.cmd, ...s.args], ["launchctl", "bootstrap", "gui/501", s.plistFile]);
  assert.match(s.plist, /<key>Label<\/key>\s*<string>com\.hermes-deck\.update\.1700000000000<\/string>/);
  assert.match(s.plist, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.ok(s.plist.includes("<string>/usr/bin/node</string>") && s.plist.includes("<string>1.3.0</string>"));
  assert.ok(!JSON.stringify(s).includes("submit"));
});

test("plist values are XML-escaped", () => {
  const s = J.jobSpec({ ...base, platform: "darwin", updater: "/a&b/<x>" });
  assert.ok(s.plist.includes("/a&amp;b/&lt;x&gt;"));
});

test("other platforms are refused", () => {
  assert.throws(() => J.jobSpec({ ...base, platform: "win32" }), /not supported/);
});

for (const platform of ["linux", "darwin"]) {
  test(`${platform}: forwards only the job environment allowlist and escapes plist values`, () => {
    const env = { PATH: "/opt/bin:/a&b/<c>", DECK_RELAY_ENV: "/private/relay.env", HOME: "/home/fixture", LANG: "",
      GH_TOKEN: "github-secret", GITHUB_TOKEN: "other-secret", DECK_RELAY_TOKEN: "relay-secret", UNRELATED: "ignored" };
    const s = J.jobSpec({ ...base, platform, env });
    if (platform === "linux") {
      assert.deepEqual(s.args.slice(4, s.args.indexOf("--")), [
        `--setenv=PATH=${env.PATH}`, `--setenv=HOME=${env.HOME}`, "--setenv=LANG=", `--setenv=DECK_RELAY_ENV=${env.DECK_RELAY_ENV}`,
      ]);
    } else {
      assert.match(s.plist, /<key>EnvironmentVariables<\/key>\s*<dict>/);
      assert.match(s.plist, /<key>PATH<\/key>\s*<string>\/opt\/bin:\/a&amp;b\/&lt;c&gt;<\/string>/);
      assert.match(s.plist, /<key>DECK_RELAY_ENV<\/key>\s*<string>\/private\/relay.env<\/string>/);
    }
    assert.doesNotMatch(JSON.stringify(s), /GH_TOKEN|GITHUB_TOKEN|DECK_RELAY_TOKEN|secret|UNRELATED|ignored/);
  });
}

for (const scenario of [
  { name: "success", result: { code: 0 }, ok: true },
  { name: "nonzero exit", result: { code: 5, out: "Bootstrap failed: 5" }, error: "launchctl failed (exit 5): Bootstrap failed: 5" },
  { name: "synchronous run throw", runError: "Runner threw" },
  { name: "run rejection", rejection: "Runner rejected" },
  { name: "plist write failure", writeError: "Write failed" },
  { name: "removal failure", result: { code: 5, out: "Bootstrap failed: 5" }, removeError: true, error: "launchctl failed (exit 5): Bootstrap failed: 5" },
  { name: "missing result", error: "launchctl failed (exit ?): " },
  { name: "long output", result: { code: 5, out: "x".repeat(500) } },
  { name: "long exception", runError: "x".repeat(500) },
]) {
  test(`startJob: ${scenario.name}`, async () => {
    const s = J.jobSpec({ ...base, platform: "darwin" });
    const events = [];
    const fs = {
      writeFileSync: (p, d, o) => {
        events.push(["write", p, d, o]);
        if (scenario.writeError) throw new Error(scenario.writeError);
      },
      rmSync: (p, o) => {
        events.push(["rm", p, o]);
        if (scenario.removeError) throw new Error("Removal failed");
      },
    };
    const run = (cmd, args) => {
      events.push(["run", cmd, args]);
      if (scenario.runError) throw new Error(scenario.runError);
      if (scenario.rejection) return Promise.reject(new Error(scenario.rejection));
      return Promise.resolve(scenario.result);
    };
    const result = await J.startJob(s, { fs, run });
    const expected = [["write", s.plistFile, s.plist, { mode: 0o600 }]];
    if (!scenario.writeError) expected.push(["run", "launchctl", ["bootstrap", "gui/501", s.plistFile]]);
    if (!scenario.ok) expected.push(["rm", s.plistFile, { force: true }]);
    assert.deepEqual(events, expected);
    if (scenario.ok) assert.deepEqual(result, { ok: true });
    else {
      assert.equal(result.ok, false);
      assert.equal(typeof result.error, "string");
      assert.ok(result.error.length <= 300);
      const error = scenario.error || scenario.runError || scenario.rejection || scenario.writeError;
      if (error) assert.equal(result.error, error.slice(0, 300));
    }
  });
}

for (const scenario of [
  { name: "success", result: { code: 0 }, ok: true },
  { name: "nonzero bootout", result: { code: 3, out: "Job already gone" }, error: "launchctl failed (exit 3): Job already gone" },
  { name: "synchronous run throw", runError: "Bootout threw" },
  { name: "run rejection", rejection: "Bootout rejected" },
  { name: "removal failure", result: { code: 0 }, removeError: true, ok: true },
  { name: "bootout and removal failure", result: { code: 3, out: "Job already gone" }, removeError: true, error: "launchctl failed (exit 3): Job already gone" },
  { name: "missing result", error: "launchctl failed (exit ?): " },
]) {
  test(`cleanupJob: ${scenario.name}`, async () => {
    const events = [];
    const fs = { rmSync: (p, o) => {
      events.push(["rm", p, o]);
      if (scenario.removeError) throw new Error("Removal failed");
    } };
    const run = (cmd, args) => {
      events.push(["run", cmd, args]);
      if (scenario.runError) throw new Error(scenario.runError);
      if (scenario.rejection) return Promise.reject(new Error(scenario.rejection));
      return Promise.resolve(scenario.result);
    };
    const result = await J.cleanupJob({ kind: "launchd", label: "com.hermes-deck.update.1", plistFile: "/d/update-job.plist" }, { fs, uid: 501, run });
    assert.deepEqual(events, [
      ["run", "launchctl", ["bootout", "gui/501/com.hermes-deck.update.1"]],
      ["rm", "/d/update-job.plist", { force: true }],
    ]);
    assert.deepEqual(result, scenario.ok ? { ok: true } : { ok: false, error: scenario.error || scenario.runError || scenario.rejection });
  });
}

test("cleanupJob: systemd and absent jobs return success without calls", async () => {
  const unexpected = () => assert.fail("No calls expected");
  for (const job of [{ kind: "systemd" }, null]) {
    assert.deepEqual(await J.cleanupJob(job, { run: unexpected, fs: { rmSync: unexpected }, uid: 501 }), { ok: true });
  }
});
