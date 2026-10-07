"use strict";
// Workspace tab, relay side: what a deck asks about agent browsers over its own token-authenticated relay
// connection (JSON text next to its heartbeats; index.js deckHooks). Nothing here is reachable over CDP, so
// an agent can never pick its own host or take or hand back control.
//   deck -> relay  {t:"ws-req", id, op, slug, ...}   answered with {t:"ws-res", id, ok, error?}
//     route       {where: "auto" | "here" | "agent-host"}   the user's host pick for this agent (presence pins)
//     watch       {maxWidth, maxHeight, large?}   stream this agent's browser on the agent host to this deck (1024 px at
//                 most; up to 1920 with large: the deck's expanded view)
//     resize      {maxWidth, maxHeight, large?}   change the running stream's size in place
//     unwatch | start (launch it here) | control {who: "user" | "agent"}
//     follow | select-tab {tab} | navigate {url} | history {delta} | reload | new-tab | close-tab {tab}
//   deck -> relay  {t:"ws-input", slug, ev}   the user's mouse and keys; used only while the user holds control
//   relay -> deck  {t:"ws-view", slug, ev: "frame", targetId, data (base64 JPEG), meta}
//                  {t:"ws-view", slug, ev: "tabs", tabs, follow, lastSeen, wall} | {ev: "error", error}
//                  {t:"ws-browsers", host, browsers: [info]}   to every deck, when one of them changes
// The view itself is cdp-view.js's LiveView, the same code a deck runs for its own agent browsers. Frames go
// only to the deck that watches and only while it watches: at most 4 a second, 1024 px, JPEG quality 50, and
// held back while that deck's connection is behind (so its relay socket never queues up).
const { LiveView } = require("./cdp-view");

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VIEW = { side: 1024, largeSide: 1920, fps: 4, quality: 50, behind: 512 * 1024 };
/** The stream size a deck asked for: panel-sized views stay within `side`; the expanded view (`large`) may reach `largeSide`. */
const sizeOf = (m) => {
  const cap = m && m.large === true ? VIEW.largeSide : VIEW.side;
  const side = (n) => Math.round(Math.min(cap, Math.max(320, Number(n) || cap)));
  return { maxWidth: side(m && m.maxWidth), maxHeight: side(m && m.maxHeight) };
};
const MAX_WATCHED = 2; // per deck: the one on screen, and one being switched to
const ERR = {
  bad: "Geçersiz istek.",
  device: "Bu cihaz şu an ajan tarayıcısına açık değil (Ayarlar > Bu cihaz).",
  fallback: "Ajan makinesinde bu ajan için tarayıcı yok: relay .env dosyasında DECK_FALLBACK_BROWSER=1 ya da DECK_FALLBACK_BROWSER_CDP olmalı.",
  unknown: "Bu cihaz relay'e henüz bildirilmedi; birkaç saniye sonra yeniden dene.",
  view: "Bu tarayıcı izlenmiyor.",
  control: "Önce kontrolü al.",
};
const fail = (msg) => Object.assign(new Error(msg), { user: true });

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

/** One deck watching one agent's browser on the agent host. */
class Viewer {
  constructor(hub, ws, slug, size) {
    Object.assign(this, { hub, ws, slug, size, lv: null, starting: false, closed: false });
  }

  push(body) {
    send(this.ws, { t: "ws-view", slug: this.slug, ...body });
  }

  /** Start or drop the view as the browser starts and stops. */
  sync() {
    if (this.closed) return;
    const b = this.hub.fallback.peek(this.slug);
    const up = !!b && b.status === "running";
    if (this.lv && (!up || this.lv.browser !== b || this.lv.port !== b.port)) this._drop();
    if (up && !this.lv && !this.starting) this._start(b);
  }

  _start(b) {
    this.starting = true;
    const lv = new LiveView(b, { ...this.size, fps: VIEW.fps, quality: VIEW.quality, ready: () => this.ws.readyState === 1 && this.ws.bufferedAmount < VIEW.behind });
    lv.port = b.port;
    lv.start()
      .then(() => {
        this.starting = false;
        if (this.closed || b.status !== "running" || b.port !== lv.port) {
          lv.stop();
          return this.sync(); // the browser restarted meanwhile: watch the new one (sync() returns when closed)
        }
        this.lv = lv;
        lv.resize(this.size); // the deck asked for another size while the view was starting (no-op when equal)
        b.viewers += 1;
        lv.on("frame", (f) => this.push({ ev: "frame", targetId: f.targetId, data: f.data.toString("base64"), meta: f.meta }));
        lv.on("tabs", (tabs) => this.push({ ev: "tabs", tabs, ...lv.status() }));
        lv.on("lost", () => {
          if (this.lv !== lv) return;
          this._drop();
          setTimeout(() => this.sync(), 1000);
        });
        this.push({ ev: "tabs", tabs: lv.tabs(), ...lv.status() });
      })
      .catch((e) => {
        this.starting = false;
        lv.stop();
        this.push({ ev: "error", error: String(e.message || e).slice(0, 200) });
      });
  }

  _drop() {
    const lv = this.lv;
    if (!lv) return;
    this.lv = null;
    lv.browser.viewers = Math.max(0, lv.browser.viewers - 1);
    lv.stop();
    this.push({ ev: "tabs", tabs: [], follow: true, lastSeen: null, wall: null, hidden: false });
  }

  stop() {
    this.closed = true;
    this._drop();
  }
}

class WorkspaceHub {
  /**
   * @param {object} o
   * @param {import("./presence").Presence} o.presence
   * @param {import("./browser").FallbackHost|null} [o.fallback] the agent host's browsers (DECK_FALLBACK_BROWSER=1)
   * @param {(msg: object) => void} [o.broadcast] to every deck (server.js)
   */
  constructor({ presence, fallback = null, transfers = null, broadcast = () => {} }) {
    this.presence = presence;
    this.fallback = fallback && fallback.available ? fallback : null;
    this.broadcast = broadcast;
    this.transfers = transfers;
    this.viewers = new Map(); // deck connection -> Map(slug -> Viewer)
    this.holders = new Map(); // slug -> the deck connection that took control of that agent's browser
    this._timer = null;
    if (this.fallback) this.fallback.on("change", (info) => this._changed(info));
  }

  setBroadcast(fn) {
    this.broadcast = fn;
  }

  browsers() {
    return { t: "ws-browsers", host: this.fallback ? this.fallback.name : null, browsers: this.fallback ? this.fallback.list() : [] };
  }

  // ---- deck connections (index.js deckHooks) ---------------------------------------------------------------
  onConnect(ws) {
    send(ws, this.browsers());
  }

  /** True when the message was a Workspace request or input (consumed). */
  onMessage(ws, m) {
    if (m.t === "ws-req") {
      this._req(ws, m);
      return true;
    }
    if (m.t === "ws-input") {
      const v = this._viewer(ws, String(m.slug || ""));
      if (v && v.lv) v.lv.input(m.ev); // LiveView.input checks that the user holds control
      return true;
    }
    return false;
  }

  onClose(ws) {
    // control belongs to the deck that took it: when that deck goes, the agent gets its browser back (a stopped
    // browser too: control survives a browser exit, so it must not stay with a deck that is gone)
    let released = false;
    for (const [slug, holder] of [...this.holders]) {
      if (holder !== ws) continue;
      this.holders.delete(slug);
      const b = this.fallback && this.fallback.peek(slug);
      if (b && b.controller === "user") {
        this.fallback.setController(slug, "agent");
        released = true;
      }
    }
    if (released) this.broadcast(this.browsers());
    const vs = this.viewers.get(ws);
    if (!vs) return;
    this.viewers.delete(ws);
    for (const v of vs.values()) v.stop();
  }

  stop() {
    clearTimeout(this._timer);
    for (const ws of [...this.viewers.keys()]) this.onClose(ws);
  }

  /** An agent-host browser changed: its viewers start or stop, and decks get the list (at most every 250 ms). */
  _changed(info) {
    for (const vs of this.viewers.values()) {
      const v = vs.get(info.slug);
      if (v) v.sync();
    }
    if (!this._timer) {
      this._timer = setTimeout(() => {
        this._timer = null;
        this.broadcast(this.browsers());
      }, 250);
    }
  }

  // ---- requests ------------------------------------------------------------------------------------------
  async _req(ws, m) {
    const id = Number.isSafeInteger(m.id) ? m.id : null;
    try {
      const slug = String(m.slug || "").toLowerCase();
      if (!SLUG_RE.test(slug)) throw fail(ERR.bad);
      const value = await this._op(ws, slug, m);
      if (id !== null) send(ws, { t: "ws-res", id, ok: true, ...(value && m.op.startsWith("transfer-") ? { value } : {}) });
    } catch (e) {
      if (id !== null) send(ws, { t: "ws-res", id, ok: false, error: String(e.message || e).slice(0, 200) });
    }
  }

  _host() {
    if (!this.fallback) throw fail(ERR.fallback);
    return this.fallback;
  }

  _viewer(ws, slug) {
    const vs = this.viewers.get(ws);
    return (vs && vs.get(slug)) || null;
  }

  /** The live view this deck watches; `control`: only while the user holds control. */
  _lv(ws, slug, control = false) {
    const v = this._viewer(ws, slug);
    if (!v || !v.lv) throw fail(ERR.view);
    if (control && v.lv.browser.controller !== "user") throw fail(ERR.control);
    return v.lv;
  }

  async _op(ws, slug, m) {
    if (this.transfers && typeof m.op === "string" && m.op.startsWith("transfer-")) return this.transfers.op(ws, slug, m);
    switch (m.op) {
      case "route":
        return this._route(ws, slug, m.where);
      case "watch":
        return this._watch(ws, slug, m);
      case "resize": {
        // the deck's view got bigger or smaller: the running stream changes size in place (no re-watch, no blank frame)
        const v = this._viewer(ws, slug);
        if (!v) throw fail(ERR.view);
        v.size = sizeOf(m);
        if (v.lv) v.lv.resize(v.size);
        return null;
      }
      case "unwatch": {
        const v = this._viewer(ws, slug);
        if (v) {
          v.stop();
          this.viewers.get(ws).delete(slug);
        }
        return null;
      }
      case "start":
        return this._host().ensure(slug);
      case "control": {
        const who = m.who === "user" ? "user" : "agent";
        this._host().setController(slug, who);
        if (who === "user") this.holders.set(slug, ws);
        else this.holders.delete(slug);
        const v = this._viewer(ws, slug);
        if (who === "user" && v && v.lv) v.lv.focus();
        send(ws, this.browsers()); // the new controller reaches this deck before its ws-res (not 250 ms later)
        return null;
      }
      case "follow":
        return this._lv(ws, slug).resume();
      case "select-tab":
        return this._lv(ws, slug).selectTab(String(m.tab || ""));
      case "navigate":
        return this._lv(ws, slug, true).navigate(String(m.url || ""));
      case "history":
        return this._lv(ws, slug, true).history(Number(m.delta) < 0 ? -1 : 1);
      case "reload":
        return this._lv(ws, slug, true).reload();
      case "new-tab":
        return this._lv(ws, slug, true).newTab("about:blank");
      case "close-tab":
        return this._lv(ws, slug, true).closeTab(String(m.tab || ""));
      default:
        throw fail(ERR.bad);
    }
  }

  /** The user's host pick: "here" is the deck that asks, by its own heartbeat. */
  _route(ws, slug, where) {
    let pin = null;
    if (where === "here") {
      const id = this.presence.deviceOf(ws);
      if (!id) throw fail(ERR.unknown);
      pin = { kind: "device", id };
    } else if (where === "agent-host") pin = { kind: "fallback" };
    else if (where !== "auto") throw fail(ERR.bad);
    const r = this.presence.setPin(slug, "browser", pin);
    if (!r.ok) throw fail(ERR[r.code] || ERR.bad);
    this.broadcast(this.presence.state()); // decks see the pin (and a moved route) at once
    return null;
  }

  _watch(ws, slug, m) {
    this._host();
    let vs = this.viewers.get(ws);
    if (!vs) this.viewers.set(ws, (vs = new Map()));
    const old = vs.get(slug);
    if (old) old.stop();
    vs.delete(slug);
    while (vs.size >= MAX_WATCHED) {
      const [k, v] = vs.entries().next().value;
      v.stop();
      vs.delete(k);
    }
    const v = new Viewer(this, ws, slug, sizeOf(m));
    vs.set(slug, v);
    v.sync();
    return null;
  }
}

module.exports = { WorkspaceHub, VIEW };
