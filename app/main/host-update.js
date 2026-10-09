"use strict";
// Host update from the app (docs/updating.md, Updating from the app): POST /host/update {version: this app's
// version} and POST /host/restart {profile} to the relay, with the relay token and this device's key. maybeAuto()
// is the opt-in automatic mode: only when Settings › Updates › host is on, the host is behind, remote updates are
// allowed and the relay runs from an install root; once per version, and never again for a version that failed.
const fs = require("fs");
const path = require("path");
const { newer } = require("./updates");

const FAILED = new Set(["failed", "rolled-back", "plugin-failed"]);

function createHostUpdater({ relay, settings, deviceId, app, file, fetch: fetchImpl = (u, o) => fetch(u, o) }) {
  let tried = {};
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved && saved.tried && typeof saved.tried === "object") tried = saved.tried;
  } catch {
    /* first run */
  }
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ tried }), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch {
      /* storage unavailable: it may try once more after a restart */
    }
  };

  // a restart answers after the relay verified the gateway (up to 60 s there), an update as soon as the job started
  async function call(endpoint, body, timeoutMs = 15_000) {
    const r = relay();
    if (!r) return { ok: false, error: "hostupd.noRelay" };
    const key = settings.data.botscreen && settings.data.botscreen.deviceToken;
    if (!key) return { ok: false, error: "hostupd.needDeviceKey" };
    try {
      const res = await fetchImpl(`${r.httpBase}${endpoint}`, {
        method: "POST",
        headers: { authorization: `Bearer ${r.token}`, "content-type": "application/json", "x-deck-device-id": deviceId(), "x-deck-device-token": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: String(data.error || `HTTP ${res.status}`), ...(data.command ? { command: String(data.command) } : {}) };
      return { ...data, ok: data.ok !== false };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  const behind = (state) => !!state && ((state.relay && state.relay.older) || (Array.isArray(state.plugins) && state.plugins.some((p) => p.source === "relay" && p.older)));

  return {
    update: () => call("/host/update", { version: app }),
    restart: (profile) => call("/host/restart", { profile: String(profile || "") }, 90_000),
    /** The automatic mode, called on every host-version change (main.js). Sends at most once per app version. */
    async maybeAuto(state) {
      if (!(settings.data.updates && settings.data.updates.host === true)) return;
      if (!behind(state)) return; // host current: a second Deck sends nothing
      const u = state.update;
      if (!u || !u.remote || !u.remote.enabled || !u.remote.managed) return;
      if (u.status && u.status.version === app && FAILED.has(u.status.state)) {
        if (tried[app] !== "failed") { tried[app] = "failed"; save(); }
        return;
      }
      if (u.status && u.status.state === "running") return;
      if (tried[app]) return;
      if (!newer(app, state.relay ? state.relay.version : "0.0.0") && !(state.plugins || []).some((p) => p.older)) return;
      tried[app] = "sent";
      save();
      const r = await call("/host/update", { version: app });
      if (!r.ok) { tried[app] = "failed"; save(); }
    },
  };
}

module.exports = { createHostUpdater };
