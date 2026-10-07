"use strict";
// Query the exact PID without Process.MainModule's VM_READ requirement (elevated apps can deny that).
const W = require("./windows");
const { runFile, POWERSHELL } = require("./installer");

const PROCESS_PATH_SCRIPT = String.raw`Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DeckProcessPath {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr process);
  public static string ImagePath(uint pid) {
    IntPtr process = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION only
    if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      StringBuilder name = new StringBuilder(32768);
      uint size = 32768;
      if (!QueryFullProcessImageName(process, 0, name, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return name.ToString();
    } finally { CloseHandle(process); }
  }
}
'@
`;

async function executablePath(pid, run = runFile) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) return null;
  const script = PROCESS_PATH_SCRIPT + "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [DeckProcessPath]::ImagePath([uint32]$env:HD_PID)";
  const r = await run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 15000, env: { ...process.env, HD_PID: String(pid) } });
  return r.code === 0 ? W.exeFromPowerShell(r.stdout) : null;
}

module.exports = { executablePath, PROCESS_PATH_SCRIPT };
