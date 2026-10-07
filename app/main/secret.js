"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
// Telegram session storage. The session string is full account access, so it never leaves the main
// process and is only stored encrypted (Electron safeStorage: DPAPI on Windows, Keychain on macOS) in
// userData/tg.session.enc. A session written by an older build (DPAPI via PowerShell in
// ~/.hermes-deck/tg.session) is imported once and re-saved in the new format.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { app, safeStorage } = require("electron");

const file = () => path.join(app.getPath("userData"), "tg.session.enc");
const LEGACY_WIN = path.join(os.homedir(), ".hermes-deck", "tg.session");

function legacyDpapiRead() {
  const script =
    "Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());" +
    "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";
  const data = fs.readFileSync(LEGACY_WIN, "utf8").trim();
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input: data, windowsHide: true })
    .toString()
    .trim();
}

function loadSession() {
  if (fs.existsSync(file())) return safeStorage.decryptString(fs.readFileSync(file()));
  if (process.platform === "win32" && fs.existsSync(LEGACY_WIN)) {
    const s = legacyDpapiRead();
    if (s) {
      saveSession(s);
      fs.renameSync(LEGACY_WIN, `${LEGACY_WIN}.migrated`); // never re-imported after a logout
    }
    return s;
  }
  return "";
}

function saveSession(session) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error(i18nText("U0288"));
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), safeStorage.encryptString(session), { mode: 0o600 });
}

function clearSession() {
  for (const f of [file()]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
}

module.exports = { loadSession, saveSession, clearSession };
