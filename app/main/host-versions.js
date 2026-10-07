"use strict";
// Host versions: is the relay or the Hermes plugin behind this app, and do they speak its wire protocol?
// App, relay and plugin share one version (root compat.json). Sources: the relay's WebSocket hello
// ({v, protocol, plugins: {<profile>: version|null}}, relay 0.3.6+; older relays send only v) and the direct
// connection's deck.version ({version, protocol}, plugin 0.3.6+; older plugins answer "method not found").
//
// Version drift (relay or plugin older than the app) never blocks: Settings › Relay / › Hermes show it with the
// update command from docs/updating.md, and one notification per drift is shown (persisted, not per reconnect).
// A protocol mismatch blocks that one connection (main.js stops it) and the renderer shows a banner for it.
// Pure logic and a small JSON file; unit-tested in app/test/host-versions.test.js.
const fs = require("fs");
const path = require("path");
const { newer } = require("./updates");

const PROTOCOL = 1; // equal to compat.json "protocol" (app/test/host-versions.test.js checks it)
// the exact commands docs/updating.md gives for each part (run on the relay / Hermes host)
const RELAY_CMD = "relay/bin/deck-relay-update apply";
const PLUGIN_CMD = "python hermes-plugin/hermes-deck/install.py";
const SEMVER = /^v?(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PROFILES = 64;
const MAX_KEYS = 200;

const cleanVersion = (v) => (typeof v === "string" && SEMVER.test(v) ? v.replace(/^v/, "") : null);
const cleanProtocol = (p) => (Number.isInteger(p) && p > 0 && p < 1e6 ? p : null);

/** The relay part of a hello: {version, protocol, older, mismatch}, or null when it carries no version. */
function relayInfo(hello, app, protocol = PROTOCOL) {
  const version = cleanVersion(hello && hello.v);
  if (!version) return null;
  const p = cleanProtocol(hello.protocol); // null: a relay before 0.3.6 (protocol 1 wire, no host report)
  return { version, protocol: p, older: newer(app, version), mismatch: p !== null && p !== protocol };
}

/**
 * Plugin rows: [{profile, version, older, legacy, source}] sorted by profile. From the relay, `null` means the
 * profile has no installed.json (no plugin there, or one before 0.3.6): shown as unknown, never as drift. From the
 * direct connection, `legacy` (method not found) means a plugin before 0.3.6: that is drift.
 */
function pluginRows(relayPlugins, bridge, app, protocol = PROTOCOL) {
  const rows = [];
  const src = relayPlugins && typeof relayPlugins === "object" && !Array.isArray(relayPlugins) ? relayPlugins : {};
  for (const [profile, v] of Object.entries(src).slice(0, MAX_PROFILES)) {
    if (!PROFILE_RE.test(profile)) continue;
    const version = cleanVersion(v);
    rows.push({ profile, version, older: !!version && newer(app, version), legacy: false, source: "relay" });
  }
  rows.sort((a, b) => (a.profile === "default" ? -1 : b.profile === "default" ? 1 : a.profile.localeCompare(b.profile)));
  if (bridge) {
    const version = cleanVersion(bridge.version);
    const p = cleanProtocol(bridge.protocol);
    rows.push({ profile: null, version, older: bridge.legacy === true || (!!version && newer(app, version)), legacy: bridge.legacy === true,
      protocol: p, mismatch: p !== null && p !== protocol, source: "bridge" });
  }
  return rows;
}

class HostVersions {
  /**
   * @param {object} o
   * @param {string} o.app             this app's version
   * @param {string} [o.file]          where the drifts already announced are kept (userData/host-versions.json)
   * @param {(key: string, vars: object, section: string) => boolean} [o.notify]  shows one notification
   * @param {(state: object) => void} [o.onChange]  the renderer's copy (Settings, the banner)
   * @param {number} [o.protocol]
   */
  constructor({ app, file = null, notify = () => false, onChange = () => {}, protocol = PROTOCOL }) {
    Object.assign(this, { app: cleanVersion(app) || "0.0.0", file, notify, onChange, protocol });
    this.relay = null; // {version, protocol, older, mismatch}
    this.relayPlugins = {};
    this.bridge = null; // {version, protocol, legacy}
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(file, "utf8")) || {};
    } catch {
      /* first run */
    }
    this.notified = new Set(Array.isArray(saved.notified) ? saved.notified.filter((k) => typeof k === "string").slice(-MAX_KEYS) : []);
  }

  _save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + ".tmp", JSON.stringify({ notified: [...this.notified].slice(-MAX_KEYS) }), { mode: 0o600 });
      fs.renameSync(this.file + ".tmp", this.file);
    } catch {
      /* unavailable storage: it may tell again next start */
    }
  }

  /** One notification per drift key, ever (the key names the versions, so a newer drift tells again). */
  _once(key, msg, vars, section) {
    if (this.notified.has(key)) return false;
    if (!this.notify(msg, vars, section)) return false;
    this.notified.add(key);
    this._save();
    return true;
  }

  /** What the renderer shows. */
  state() {
    const plugins = pluginRows(this.relayPlugins, this.bridge, this.app, this.protocol);
    const bridgeRow = plugins.find((r) => r.source === "bridge");
    return {
      app: this.app,
      protocol: this.protocol,
      relay: this.relay,
      plugins,
      blocked: { relay: !!(this.relay && this.relay.mismatch), bridge: !!(bridgeRow && bridgeRow.mismatch) },
      commands: { relay: RELAY_CMD, plugin: PLUGIN_CMD },
    };
  }

  /** A relay hello. Returns false when its protocol differs (main.js then stops that connection). */
  relayHello(hello) {
    this.relay = relayInfo(hello, this.app, this.protocol);
    this.relayPlugins = hello && hello.plugins && typeof hello.plugins === "object" ? hello.plugins : {};
    const r = this.relay;
    if (r && r.mismatch) {
      this._once(`relay-protocol:${r.protocol}:${this.protocol}`, "hostupd.protocolRelay", { theirs: r.protocol, ours: this.protocol }, "relay");
    } else if (r && r.older) {
      this._once(`relay:${r.version}<${this.app}`, "hostupd.relayOlderToast", { relay: r.version, app: this.app }, "relay");
    }
    for (const row of pluginRows(this.relayPlugins, null, this.app, this.protocol)) {
      if (row.older) this._once(`plugin:${row.profile}:${row.version}<${this.app}`, "hostupd.pluginOlderToast", { profile: row.profile, plugin: row.version, app: this.app }, "hermes");
    }
    this.onChange(this.state());
    return !(r && r.mismatch);
  }

  /** The relay connection went away or was turned off: forget what it reported. */
  relayGone() {
    if (!this.relay && !Object.keys(this.relayPlugins).length) return;
    this.relay = null;
    this.relayPlugins = {};
    this.onChange(this.state());
  }

  /**
   * The direct connection's deck.version answer ({version, protocol} | {legacy: true}), or null when it is off.
   * Returns false when its protocol differs (main.js then stops that connection).
   */
  bridgeVersion(v) {
    this.bridge = v && typeof v === "object" ? { version: cleanVersion(v.version), protocol: cleanProtocol(v.protocol), legacy: v.legacy === true } : null;
    const row = pluginRows(null, this.bridge, this.app, this.protocol)[0];
    if (row && row.mismatch) {
      this._once(`bridge-protocol:${row.protocol}:${this.protocol}`, "hostupd.protocolBridge", { theirs: row.protocol, ours: this.protocol }, "hermes");
    } else if (row && row.older) {
      this._once(`bridge:${row.version || "legacy"}<${this.app}`, "hostupd.bridgeOlderToast", { plugin: row.version || "< 0.3.6", app: this.app }, "hermes");
    }
    this.onChange(this.state());
    return !(row && row.mismatch);
  }
}

module.exports = { HostVersions, relayInfo, pluginRows, PROTOCOL, RELAY_CMD, PLUGIN_CMD };
