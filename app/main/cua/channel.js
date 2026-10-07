"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../../renderer/i18n");
// The Deck's end of the relay's driver channel (docs/bot-screen-protocol.md v2). It rides the Deck's own relay
// connection (RelayClient, /events, relay token) as [0xD5] binary frames next to the CDP tunnel, so this
// computer opens no port and keeps one outbound connection. After every (re)connect the Deck says HELLO with
// its presence id and device token; nothing is opened until the relay answers READY {ok:true}.
// The relay numbers channels; each one is one driver process here. Every OPEN passes the gate first (verb
// allowlist, the switch, the grant, the agent). When the connection drops, every channel's process is killed:
// Hermes fails closed and never replays an action. Pure Node (no electron import); app/test/cua-channel.test.js
// runs it against the real relay.
const { EventEmitter } = require("events");
const { OP, encodeFrame, decodeFrame, frameJson } = require("./wire");
const { exitCode, chunks } = require("./protocol");
const { foregroundInput } = require("./foreground");

const MAX_CHANNELS = 16;
const HIGH_WATER = 8 * 1024 * 1024; // pause a process's stdout while the socket has this much queued
const LOW_WATER = 1024 * 1024;
const PENDING_MAX = 4 * 1024 * 1024; // stdin that arrives while a channel is still being opened
const CLOSE_GRACE_MS = 300; // relay CLOSE: stdin EOF first, then the kill

class DriverChannel extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => object} o.hello  the HELLO payload (presence id, device token, driver state, switch), built fresh each time
   * @param {(open: {ch, argv, agent, profile, sid}) => Promise<{ok: boolean, code?: number, error?: string}>} o.gate
   * @param {(argv: string[], open: object) => import("child_process").ChildProcess} o.runner
   * @param {(proc: object) => void} [o.kill]  kills one process now (process groups included)
   * @param {() => object|null} [o.grant]  current local grant, read immediately before each input
   * @param {(hwnd: number, options: object) => Promise<object>} [o.raise]  best-effort native raise (Windows only)
   */
  constructor({ hello, gate, runner, kill = (p) => p.kill(), grant = () => null, raise = null }) {
    super();
    Object.assign(this, { helloFn: hello, gate, runner, kill, grant, raise });
    this.relay = null;
    this.handlers = null;
    this.on_ = false; // started: the switch is on and a device key is set
    this.state = { status: "off" };
    this.channels = new Map(); // ch -> {proc, pending, pendingBytes, relayClosed, done}
  }

  get ready() {
    return this.state.status === "ready";
  }

  _status(s) {
    const was = this.state.status;
    this.state = s;
    this.emit("status", s, was);
  }

  _connected() {
    const ws = this.relay && this.relay.ws;
    return !!(ws && ws.readyState === 1);
  }

  /** Use this relay connection (null detaches). Channels of the old one die with it. */
  attach(relay) {
    if (this.relay && this.handlers) for (const [ev, fn] of Object.entries(this.handlers)) this.relay.off(ev, fn);
    this.closeChannels();
    this.relay = relay || null;
    this.handlers = null;
    if (!this.relay) return this._status(this.on_ ? { status: "offline", error: i18nText("U0112") } : { status: "off" });
    const r = this.relay;
    this.handlers = {
      frame: (buf) => this._frame(buf),
      status: (s) => {
        if (s.status === "open") this.sayHello();
        else {
          this.closeChannels(); // the relay can no longer hear them: their wrappers end on the agent host
          if (this.on_) this._status({ status: "offline", error: s.error || null });
        }
      },
    };
    for (const [ev, fn] of Object.entries(this.handlers)) r.on(ev, fn);
    this.sayHello();
  }

  /** The switch went on (or the key changed): say hello now if connected, else at the next connect. */
  start() {
    this.on_ = true;
    this.sayHello();
  }

  /** The switch went off: every channel's process is killed and nothing new is accepted. */
  stop() {
    this.on_ = false;
    this.closeChannels();
    this._status({ status: "off" });
  }

  sayHello() {
    if (!this.on_) return;
    if (!this.relay || !this._connected()) return this._status({ status: "offline", error: this.relay ? null : i18nText("U0112") });
    this._status({ status: "hello" });
    this.send(OP.HELLO, 0, this.helloFn());
  }

  /** One frame to the relay; false when not connected. */
  send(op, ch, payload) {
    if (!this.relay || !this._connected()) return false;
    try {
      return this.relay.send(encodeFrame(op, ch, payload)) !== false;
    } catch {
      return false;
    }
  }

  /** STOPPED, GRANT and REVOKE go on channel 0. */
  control(op, payload) {
    return this.send(op, 0, payload);
  }

  /** Kills every channel's process now. With notify, tells the relay each one closed. */
  closeChannels({ notify = false, code = 137, error = "stopped on the device" } = {}) {
    if (!this.channels.size) return;
    for (const [ch, c] of this.channels) {
      c.done = true;
      if (c.input) c.input.destroy();
      if (c.proc) this.kill(c.proc);
      if (notify) this.send(OP.CLOSE, ch, { code, error });
    }
    this.channels.clear();
    this.emit("channels", 0);
  }

  _touch() {
    this.emit("activity", Date.now());
  }

  _frame(buf) {
    const f = decodeFrame(buf);
    if (!f) return; // a CDP tunnel frame: the Workspace tab's
    const { op, ch, payload } = f;
    if (op === OP.READY) {
      const m = frameJson(payload) || {};
      if (m.ok === true) return this._status({ status: "ready" });
      this.closeChannels();
      return this._status({ status: "refused", error: typeof m.error === "string" ? m.error.slice(0, 300) : i18nText("U0113") });
    }
    if (op === OP.STOP) {
      this.closeChannels();
      const m = frameJson(payload) || {};
      return this.emit("stop", typeof m.reason === "string" ? m.reason.slice(0, 200) : "");
    }
    if (!ch) return;
    if (op === OP.OPEN) return this._open(ch, frameJson(payload));
    const c = this.channels.get(ch);
    if (!c || c.done) return;
    if (op === OP.DATA) {
      this._touch();
      if (c.proc) {
        if (c.input && c.input.writableLength + payload.length > PENDING_MAX) return this._fail(ch, 1, "driver input too large");
        return writeIn({ stdin: c.input || c.proc.stdin }, payload);
      }
      c.pendingBytes += payload.length;
      if (c.pendingBytes > PENDING_MAX) return this._fail(ch, 1, "stdin too large before the driver started");
      c.pending.push(Buffer.from(payload));
      return;
    }
    if (op === OP.CLOSE) {
      c.relayClosed = true;
      if (!c.proc) return this._fail(ch, 137, "closed by the relay");
      try {
        (c.input || c.proc.stdin).end();
      } catch {
        /* already closed */
      }
      const killLater = () => setTimeout(() => this.kill(c.proc), CLOSE_GRACE_MS);
      if (c.input) c.input.once("end", killLater);
      else killLater();
    }
  }

  async _open(ch, m) {
    if (!m || !Array.isArray(m.argv)) return this.send(OP.CLOSE, ch, { code: 1, error: "bad open" });
    if (!this.on_ || !this.ready) return this.send(OP.CLOSE, ch, { code: 1, error: "desktop control is switched off on this device" });
    if (this.channels.has(ch)) return this.send(OP.CLOSE, ch, { code: 1, error: "channel already open" });
    if (this.channels.size >= MAX_CHANNELS) return this.send(OP.CLOSE, ch, { code: 1, error: "too many channels" });
    const open = { ch, argv: m.argv, agent: typeof m.agent === "string" ? m.agent.slice(0, 64) : "", profile: typeof m.profile === "string" ? m.profile.slice(0, 64) : "", sid: typeof m.sid === "string" ? m.sid.slice(0, 200) : "" };
    const c = { proc: null, pending: [], pendingBytes: 0, relayClosed: false, done: false };
    this.channels.set(ch, c);
    this._touch();
    let verdict;
    try {
      verdict = await this.gate(open);
    } catch (e) {
      verdict = { ok: false, code: 1, error: e.message };
    }
    if (c.done || this.channels.get(ch) !== c) return; // closed (or the switch went off) meanwhile
    if (!verdict || !verdict.ok) return this._fail(ch, (verdict && verdict.code) || 1, (verdict && verdict.error) || "refused");
    let proc;
    try {
      proc = this.runner(open.argv, open);
    } catch (e) {
      return this._fail(ch, 127, e.message);
    }
    c.proc = proc;
    if (open.argv[0] === "mcp" && this.raise) {
      c.input = foregroundInput({ grant: this.grant, profile: open.profile, raise: this.raise, active: () => !c.done });
      c.input.on("error", e => this._fail(ch, 1, e.message));
      c.input.pipe(proc.stdin);
    }
    this.emit("channels", this.channels.size);
    const ws = this.relay && this.relay.ws;
    const pump = (op) => (b) => {
      if (c.done) return;
      this._touch();
      for (const part of chunks(Buffer.from(b))) this.send(op, ch, part);
      if (op === OP.DATA && ws && ws.bufferedAmount > HIGH_WATER && proc.stdout && !proc.stdout.isPaused()) {
        proc.stdout.pause();
        const resume = setInterval(() => {
          if (c.done || ws.readyState !== 1) return clearInterval(resume);
          if (ws.bufferedAmount < LOW_WATER) {
            clearInterval(resume);
            proc.stdout.resume();
          }
        }, 50);
      }
    };
    if (proc.stdout) proc.stdout.on("data", pump(OP.DATA));
    if (proc.stderr) proc.stderr.on("data", pump(OP.ERR));
    if (proc.stdin) proc.stdin.on("error", () => {}); // a write after the process died
    let ended = false;
    const end = (code, error) => {
      if (ended) return;
      ended = true;
      const ours = this.channels.get(ch) === c;
      c.done = true;
      if (c.input) c.input.destroy();
      if (ours) this.channels.delete(ch);
      this.emit("channels", this.channels.size);
      // v2: the Deck reports every exit, also after the relay's own CLOSE (the relay waits for it)
      if (ours) this.send(OP.CLOSE, ch, error ? { code, error } : { code });
    };
    proc.on("error", (e) => end(127, e.code === "ENOENT" ? "cua-driver not found on the device" : e.message));
    proc.on("close", (code, signal) => end(exitCode(code, signal)));
    for (const b of c.pending) writeIn({ stdin: c.input || proc.stdin }, b);
    c.pending = [];
  }

  _fail(ch, code, error) {
    const c = this.channels.get(ch);
    if (c) {
      c.done = true;
      if (c.input) c.input.destroy();
      if (c.proc) this.kill(c.proc);
      this.channels.delete(ch);
    }
    this.emit("channels", this.channels.size);
    this.send(OP.CLOSE, ch, { code, error });
  }
}

function writeIn(proc, buf) {
  try {
    if (proc.stdin && !proc.stdin.destroyed) proc.stdin.write(buf);
  } catch {
    /* the process is gone; its CLOSE follows */
  }
}

module.exports = { DriverChannel, MAX_CHANNELS };
