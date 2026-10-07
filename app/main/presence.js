"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
// This device's presence, shared by every hosting capability ("browser" now, "desktop" later; the
// relay side is relay/src/presence.js). It owns three things:
//   - a random device id, kept in <userData>/device.json (never sent anywhere but the user's relay);
//   - the user's per-device hosting switches, all OFF on a new install: Hermes Deck is shared with
//     friends, so running agent work on a computer is always that computer's owner's choice;
//   - the heartbeat the relay uses to find the device the user is on, sent every 10 s and at once on
//     suspend, lock, unlock and resume:
//       {t:"heartbeat", device:{id, name}, os, idleSec, locked, hosting:{browser, desktop}, driverOk}
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { app, ipcMain, powerMonitor } = require("electron");
const { appIpc } = require("./ipc-guard");

const BEAT_MS = 10_000;
const CAPABILITIES = ["browser", "desktop"];

class DevicePresence extends EventEmitter {
  /**
   * @param {{persist?: boolean}} o persist=false (screenshot runs): read-only. device.json is read (the shot
   *   shows this device's real switches) but never written, the switches cannot be changed, no heartbeat.
   */
  constructor({ persist = true } = {}) {
    super();
    this.file = path.join(app.getPath("userData"), "device.json");
    this.persist = persist;
    let d = {};
    try {
      d = JSON.parse(fs.readFileSync(this.file, "utf8")) || {};
    } catch {
      d = {};
    }
    this.id = /^[a-f0-9]{16,64}$/.test(String(d.id || "")) ? d.id : crypto.randomBytes(12).toString("hex");
    this.hosting = {};
    for (const c of CAPABILITIES) this.hosting[c] = !!(d.hosting && d.hosting[c] === true);
    this.capabilities = new Set(); // switches a module on this deck can honour (register())
    this.driverOk = {};
    this.relay = null;
    this.timer = null;
    this.lockedByEvent = false;
    this.asleep = false;
    if (persist && d.id !== this.id) this._save();

    const now = (fn) => () => {
      fn();
      this.push();
    };
    powerMonitor.on("suspend", now(() => { this.asleep = true; this.emit("suspend"); }));
    powerMonitor.on("resume", now(() => (this.asleep = false)));
    powerMonitor.on("lock-screen", now(() => (this.lockedByEvent = true)));
    powerMonitor.on("unlock-screen", now(() => (this.lockedByEvent = false)));
  }

  get name() {
    return os.hostname().replace(/\.local$/i, "").slice(0, 64);
  }

  /** A capability module announces itself and whether its driver works (e.g. a browser was found). */
  register(cap, driverOk) {
    if (!CAPABILITIES.includes(cap)) throw new Error(`unknown capability ${cap}`);
    this.capabilities.add(cap);
    this.driverOk[cap] = !!driverOk;
  }

  setHosting(cap, on) {
    if (!this.persist) throw new Error(i18nText("device.noShotChange")); // a read-only screenshot run
    if (!this.capabilities.has(cap)) throw new Error(i18nText("U0283"));
    this.hosting[cap] = !!on;
    this._save();
    this.emit("hosting", cap, !!on);
    this.push();
  }

  state() {
    return { id: this.id, name: this.name, os: process.platform, hosting: { ...this.hosting }, capabilities: [...this.capabilities], driverOk: { ...this.driverOk } };
  }

  beat() {
    let idleSec = 0;
    let idleState = "unknown";
    try {
      idleSec = powerMonitor.getSystemIdleTime();
      idleState = powerMonitor.getSystemIdleState(1);
    } catch {
      /* not available on this platform */
    }
    const hosting = {};
    for (const c of CAPABILITIES) hosting[c] = this.capabilities.has(c) && this.hosting[c]; // never claim what this deck can't do
    return {
      t: "heartbeat",
      device: { id: this.id, name: this.name },
      os: process.platform,
      idleSec,
      locked: this.asleep || this.lockedByEvent || idleState === "locked",
      asleep: this.asleep,
      hosting,
      driverOk: { ...this.driverOk },
    };
  }

  /** Start beating on a relay connection (null detaches). */
  attach(relay) {
    this.detach();
    if (!relay || !this.persist) return;
    this.relay = relay;
    this._onStatus = (s) => {
      if (s.status === "open") this.push();
    };
    relay.on("status", this._onStatus);
    this.timer = setInterval(() => this.push(), BEAT_MS);
  }

  detach() {
    if (this.relay && this._onStatus) this.relay.off("status", this._onStatus);
    clearInterval(this.timer);
    this.timer = null;
    this.relay = null;
  }

  push() {
    if (this.relay && this.persist) this.relay.send(this.beat());
  }

  /** Renderer calls (validated). */
  registerIpc() {
    const ipc = appIpc(ipcMain); // the Deck's own page only (security audit L4)
    ipc.handle("device:state", () => this.state());
    ipc.handle("device:set-hosting", (_e, cap, on) => {
      this.setHosting(String(cap), on === true);
      return this.state();
    });
  }

  _save() {
    if (!this.persist) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ id: this.id, hosting: this.hosting }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      /* the switch still applies for this run */
    }
  }
}

module.exports = { DevicePresence, CAPABILITIES };
