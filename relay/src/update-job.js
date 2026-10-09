"use strict";
// The host update runs outside the relay's own service: launchd and systemd stop a service's children when they
// restart it, and the updater must outlive the relay restart to health-check and roll back (docs/updating.md).
// Linux: a transient `systemd-run --user` unit, collected when it ends. macOS: a generated plist bootstrapped into
// the user's GUI domain (no KeepAlive); the relay boots it out once the status file is final.
const path = require("path");

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const ENV_KEYS = ["PATH", "HOME", "USER", "LANG", "DECK_RELAY_ENV", "DECK_RELAY_ROOT", "DECK_RELAY_SERVICE", "DECK_DATA_DIR",
  "DECK_AGENTS", "DECK_DEVICE_TOKENS", "DECK_MOBILE_DEVICES_FILE", "DECK_UPDATE_REPO", "DECK_HERMES_PYTHON", "DECK_HERMES_BIN", "HERMES_ROOT", "HERMES_HOME"];

function jobSpec({ platform, uid, node, updater, args, dataDir, logDir, env = {}, now = Date.now }) {
  const stamp = now();
  const environment = ENV_KEYS.filter((key) => Object.hasOwn(env, key)).map((key) => [key, env[key]]);
  if (platform === "linux") {
    const label = `hermes-deck-update-${stamp}`;
    return { kind: "systemd", label, cmd: "systemd-run", args: ["--user", `--unit=${label}`, "--collect", "--quiet", ...environment.map(([key, value]) => `--setenv=${key}=${value}`), "--", node, updater, ...args] };
  }
  if (platform === "darwin") {
    const label = `com.hermes-deck.update.${stamp}`;
    const plistFile = path.join(dataDir, "update-job.plist");
    const program = [node, updater, ...args].map((a) => `    <string>${xml(a)}</string>`).join("\n");
    const log = xml(path.join(logDir || dataDir, "update-job.log"));
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${program}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environment.map(([key, value]) => `    <key>${key}</key>\n    <string>${xml(value)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
    return { kind: "launchd", label, cmd: "launchctl", args: ["bootstrap", `gui/${uid}`, plistFile], plist, plistFile };
  }
  throw new Error(`host updates are not supported on ${platform}`);
}

async function startJob(spec, { run, fs }) {
  try {
    if (spec.plist) fs.writeFileSync(spec.plistFile, spec.plist, { mode: 0o600 });
    const r = await Promise.resolve().then(() => run(spec.cmd, spec.args));
    if (!r || r.code !== 0) {
      throw new Error(`${spec.cmd} failed (exit ${r ? r.code : "?"}): ${String((r && r.out) || "").trim().slice(-300)}`);
    }
    return { ok: true };
  } catch (error) {
    try { if (spec.plistFile) fs.rmSync(spec.plistFile, { force: true }); } catch {}
    return { ok: false, error: String(error?.message || error).slice(0, 300) };
  }
}

async function cleanupJob(job, { run, fs, uid }) {
  if (!job || job.kind !== "launchd") return { ok: true };
  try {
    const r = await Promise.resolve().then(() => run("launchctl", ["bootout", `gui/${uid}/${job.label}`]));
    if (!r || r.code !== 0) {
      throw new Error(`launchctl failed (exit ${r ? r.code : "?"}): ${String((r && r.out) || "").trim().slice(-300)}`);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 300) };
  } finally {
    try { if (job.plistFile) fs.rmSync(job.plistFile, { force: true }); } catch {}
  }
}

module.exports = { jobSpec, startJob, cleanupJob };
