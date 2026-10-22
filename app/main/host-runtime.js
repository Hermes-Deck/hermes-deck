"use strict";
const { t: i18nText } = require("../renderer/i18n");
// One live runtime per saved Hermes host (multi-host, split view): its relay client, its direct connection
// (BridgeClient), their statuses, the session list and the open requests. Every saved host with a configured
// connection has one for the app's lifetime, shown or not, so a reply, a completion or an approval from any host
// raises its notification and a page that comes back on screen is already current.
//
// Frames leave as `frame(ch, m)` events ({t: ...} objects, exactly what the page's `relay` / `bridge` channels
// carry); main.js routes them to that host's page and to desktop.observe. A direct connection publishes nothing
// until deck.version confirmed the wire protocol (an older plugin without the method passes); what arrived
// meanwhile is queued, bounded, and never includes a mutation. A mismatch stops that connection alone.
// Pure Node: the client classes come in through `deps`, so tests run it without Electron.
const { EventEmitter } = require("events");
const { PROTOCOL } = require("./host-versions");

const QUEUE_MAX = 64; // frames kept while the protocol check is pending; overflow drops history, never mutations
const clone = (x) => JSON.parse(JSON.stringify(x));
const configured = (relay) => !!(relay && relay.url && relay.token);

class HostRuntime extends EventEmitter {
  /**
   * @param {{id: string, name: string, relay?: {url, token}, bridge?: object}} host  a saved host (settings.js)
   * @param {object} deps
   * @param {Function} deps.RelayClient
   * @param {Function} deps.BridgeClient
   * @param {() => object} [deps.bridgeOptions]  extra BridgeClient options (screenshot fakes)
   * @param {number} [deps.protocol]
   */
  constructor(host, deps) {
    super();
    this.id = String(host.id ?? "");
    this.name = String(host.name ?? "");
    this.cfg = { relay: host.relay ? clone(host.relay) : { url: "", token: "" }, bridge: host.bridge ? clone(host.bridge) : { mode: "off" } };
    this.deps = deps;
    this.protocol = Number.isInteger(deps.protocol) ? deps.protocol : PROTOCOL;
    this.relay = null;
    this.relayStatus = { status: "starting" };
    this.hello = null; // the current relay connection's hello (main.js: the primary's host versions)
    this.bridge = null;
    this.bridgeStatus = { status: "off" };
    this.phase = "off"; // the direct connection as the pages see it: off | connecting | checking | open | offline | protocol | closed
    this.sessions = [];
    this.requests = [];
    this.reasoning = false; // the page's "Show thinking" (sent on start and on toggle)
    this.version = null; // the plugin's deck.version answer of the current connection
    this.queue = [];
    this.check = 0;
    this.stopped = false;
  }

  /**
   * The two states the host switcher colours (CONTRACT `deck.hosts.status()`): the same status strings the page's
   * own `relay` / `bridge` status frames carry ("open" | "connecting" | "closed" | "off" | "offline" | "unconfigured" ...).
   */
  status() {
    return { id: this.id, name: this.name, relay: String(this.relayStatus.status || ""), sessions: String(this.bridgeStatus.status || "") };
  }

  /** True when this host's saved configuration differs from the one the runtime runs (the pool restarts it). */
  differs(host) {
    return JSON.stringify(this.cfg.relay) !== JSON.stringify(host.relay || { url: "", token: "" })
      || JSON.stringify(this.cfg.bridge) !== JSON.stringify(host.bridge || { mode: "off" })
      || this.name !== String(host.name ?? "");
  }

  start() {
    this.stopped = false;
    this.startRelay();
    this.startBridge();
  }

  /** Ends both connections for good (the host was removed or the app quits). */
  stop() {
    this.stopped = true;
    this.stopRelay();
    this.stopBridge();
  }

  // --- relay --------------------------------------------------------------------------------------
  _setRelay(s) {
    this.relayStatus = s;
    this.emit("frame", "relay", { t: "status", ...s });
    this.emit("change");
  }

  stopRelay() {
    const old = this.relay;
    this.relay = null;
    this.hello = null;
    if (old) { old.removeAllListeners(); old.stop(); }
    this.emit("relay-client", null);
  }

  startRelay() {
    this.stopRelay();
    if (this.stopped) return;
    if (!configured(this.cfg.relay)) return this._setRelay({ status: "unconfigured" });
    this.adoptRelay(new this.deps.RelayClient({ url: this.cfg.relay.url, token: this.cfg.relay.token }));
  }

  /** Runs an already made relay client (the fixture relay of screenshot runs, or a test double). */
  adoptRelay(r) {
    if (this.relay) this.stopRelay();
    this.relay = r;
    r.on("status", (s) => this.relay === r && this._setRelay(s));
    r.on("msg", (m) => this.relay === r && this._relayMsg(r, m));
    this.emit("relay-client", r);
    r.start();
  }

  _relayMsg(r, m) {
    if (m && m.t === "hello" && Number.isInteger(m.protocol) && m.protocol > 0 && m.protocol !== this.protocol) {
      // a relay speaking another wire protocol: stop this connection only; the hello still goes out (the banner says why,
      // and its `v` may announce a newer app that speaks the relay's protocol)
      this.emit("frame", "relay", m);
      r.stop();
      if (this.relay === r) this._setRelay({ status: "closed", error: i18nText("hostupd.protocolRelayShort"), code: "protocol" });
      return;
    }
    this.emit("frame", "relay", m);
  }

  // --- direct connection ----------------------------------------------------------------------------
  _setBridge(s) {
    this.bridgeStatus = s;
    this.emit("frame", "bridge", { t: "status", ...s });
    this.emit("change");
  }

  stopBridge() {
    const old = this.bridge;
    this.bridge = null;
    this.sessions = [];
    this.requests = [];
    this.queue = [];
    this.check++;
    if (old) { old.removeAllListeners(); old.stop(); }
    this.emit("bridge-client", null);
  }

  startBridge() {
    this.stopBridge();
    if (this.stopped) return;
    const cfg = this.cfg.bridge;
    if (!cfg || cfg.mode === "off") { this.phase = "off"; return this._setBridge({ status: "off" }); }
    const b = new this.deps.BridgeClient(cfg, { ...(this.deps.bridgeOptions ? this.deps.bridgeOptions() : {}), showReasoning: this.reasoning });
    this.bridge = b;
    const mine = (fn) => (...a) => this.bridge === b && fn(...a);
    b.on("status", mine((st) => this._bridgeStatus(b, st)));
    b.on("snapshot", mine((snapshot) => this._feed({ t: "snapshot", snapshot })));
    b.on("event", mine((e) => this._feed({ t: "event", ...e })));
    b.on("requests", mine((list) => { this.requests = list; this._feed({ t: "requests", list }); this.emit("change"); }));
    b.on("sessions", mine((list) => { this.sessions = list; this._feed({ t: "sessions", list }); }));
    this.emit("bridge-client", b);
    b.start();
  }

  _bridgeStatus(b, st) {
    const check = ++this.check;
    if (st.status !== "open") {
      this.phase = st.status;
      this.requests = [];
      this.queue = [];
      return this._setBridge(st);
    }
    // open: the plugin's wire protocol first (host-versions.js); frames wait, bounded, until it is known
    this.phase = "checking";
    this._setBridge({ status: "connecting", checking: true });
    // version() never rejects (null when it cannot be told: an older plugin, treated like a legacy answer)
    Promise.resolve(b.version()).then((v) => v, () => null).then((v) => {
      if (check !== this.check || this.bridge !== b) return; // a late answer cannot resurrect a dropped connection
      this.version = v && typeof v === "object" ? v : null;
      this.emit("version", this.version);
      if (v && Number.isInteger(v.protocol) && v.protocol !== this.protocol) {
        this.phase = "protocol";
        this.queue = [];
        this.requests = [];
        b.removeAllListeners();
        b.stop();
        this.bridge = null;
        this.emit("bridge-client", null);
        return this._setBridge({ status: "offline", code: "protocol", error: i18nText("hostupd.protocolBridgeShort"), retryInMs: null });
      }
      this.phase = "open";
      this._setBridge(st);
      const queued = this.queue;
      this.queue = [];
      for (const m of queued) this.emit("frame", "bridge", m);
    });
  }

  _feed(m) {
    if (this.phase === "open") return this.emit("frame", "bridge", m);
    if (this.phase !== "checking") return;
    this.queue.push(m);
    if (this.queue.length > QUEUE_MAX) this.queue.shift();
  }

  /** The page's "Show thinking" toggle; kept for the next connection too. */
  setReasoning(show) {
    this.reasoning = show === true;
    return this.bridge ? this.bridge.setReasoning(this.reasoning) : { show: this.reasoning };
  }

  /** What a page asks on start (bridge:status). */
  bridgeState() {
    return { status: this.bridgeStatus, snapshot: this.bridge && this.phase === "open" ? this.bridge.currentSnapshot() : null,
      requests: this.bridge && this.phase === "open" ? this.bridge.listRequests() : [], sessions: this.sessions };
  }

  /** The shared inbox's row for this host (hosts:requests). */
  inboxRow() {
    return { id: this.id, name: this.name, status: this.phase, requests: this.requests };
  }
}

/** Every host's runtime; `sync` makes the set match the saved hosts (new ones start, removed ones stop, edited ones restart). */
class HostPool extends EventEmitter {
  constructor(deps) {
    super();
    this.deps = deps;
    this.runtimes = new Map();
  }

  get(id) { return this.runtimes.get(String(id ?? "")) || null; }
  has(id) { return this.runtimes.has(String(id ?? "")); }
  list() { return [...this.runtimes.values()]; }
  ids() { return [...this.runtimes.keys()]; }

  /** Makes (and starts) the runtime of `host` if there is none, else returns the existing one. */
  ensure(host) {
    let rt = this.runtimes.get(String(host.id ?? ""));
    if (rt) return rt;
    rt = new HostRuntime(host, this.deps);
    this.runtimes.set(rt.id, rt);
    this.emit("added", rt);
    rt.start();
    return rt;
  }

  /** Stops and forgets one host's runtime. */
  drop(id) {
    const rt = this.runtimes.get(String(id ?? ""));
    if (!rt) return false;
    this.runtimes.delete(rt.id);
    rt.stop();
    this.emit("removed", rt);
    return true;
  }

  /**
   * hosts: [{id, name, relay, bridge}] (settings.data.hosts, or the one legacy entry of a profile without hosts).
   * Returns the ids added, removed and restarted.
   */
  sync(hosts) {
    const keep = new Map((Array.isArray(hosts) ? hosts : []).map((h) => [String(h.id ?? ""), h]));
    const removed = [], added = [], changed = [];
    for (const id of [...this.runtimes.keys()]) if (!keep.has(id)) { this.drop(id); removed.push(id); }
    for (const [id, h] of keep) {
      const rt = this.runtimes.get(id);
      if (!rt) { this.ensure(h); added.push(id); continue; }
      if (!rt.differs(h)) continue;
      // an edited host: only the changed connection restarts (the other keeps its session)
      const relayChanged = JSON.stringify(rt.cfg.relay) !== JSON.stringify(h.relay || { url: "", token: "" });
      const bridgeChanged = JSON.stringify(rt.cfg.bridge) !== JSON.stringify(h.bridge || { mode: "off" });
      rt.name = String(h.name ?? "");
      rt.cfg = { relay: h.relay ? clone(h.relay) : { url: "", token: "" }, bridge: h.bridge ? clone(h.bridge) : { mode: "off" } };
      if (relayChanged) rt.startRelay();
      if (bridgeChanged) rt.startBridge();
      changed.push(id);
      rt.emit("change");
    }
    return { added, removed, changed };
  }

  stopAll() {
    for (const id of [...this.runtimes.keys()]) this.drop(id);
  }

  /** CONTRACT `deck.hosts.status()`: every host's two states. */
  statuses() {
    return this.list().map((rt) => rt.status());
  }
}

module.exports = { HostRuntime, HostPool, QUEUE_MAX };
