"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { executablePath } = require("../main/cua/process-path");

test("Windows executable identity queries only the exact PID with limited rights and fails closed", async () => {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code: 0, stdout: "C:\\Program Files\\Example\\Example.exe\r\n", stderr: "" };
  };
  assert.equal(await executablePath(4242, run), "C:\\Program Files\\Example\\Example.exe");
  assert.equal(calls[0].opts.env.HD_PID, "4242");
  const source = Buffer.from(calls[0].args[calls[0].args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
  assert.match(source, /OpenProcess\(0x1000, false, pid\)/);
  assert.match(source, /QueryFullProcessImageName\(process, 0, name, ref size\)/);
  assert.ok(!/MainModule|Get-Process|DebugPrivilege|0x0410|0x1[fF][fF][fF]/.test(source));
  for (const pid of [0, -1, 1.5, "4242;anything", 0x100000000]) assert.equal(await executablePath(pid, run), null);
  assert.equal(calls.length, 1, "invalid PIDs never spawn a helper");
  assert.equal(await executablePath(4242, async () => ({ code: 1, stdout: "", stderr: "Access denied" })), null);
  assert.equal(await executablePath(4242, async () => ({ code: 0, stdout: "Example.exe", stderr: "" })), null, "a name is never an identity fallback");
  if (process.platform === "win32") {
    const actual = await executablePath(process.pid);
    assert.equal(actual && actual.toLowerCase(), process.execPath.toLowerCase());
  }
});
