"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
// A9: source-aware notifications. Only the conversation actually visible is suppressed.
//   - new incoming chat messages, settled per chat for a moment so a bot that streams its reply by editing
//     the message is shown with its newest text, and a burst becomes one toast with a count;
//   - a top-level agent session that finishes (skipped when its reply already produced a toast);
//   - notify(kind, payload) for other features: the bridge uses kind "approval" / "question" for things that
//     wait for the user's answer (their own sound, toast stays until dismissed);
//   - subagent(): a sub-agent finished. Sound only, no toast, at most one per SUB_GAP_MS (a fan-out of
//     sub-agents finishing together is one sound).
// One event chooses one surface. Pet events use the configured renderer chime; native banners
// use OS sound so Focus also controls their audio. Sound-only subagent events stay silent in banner mode.
const { Notification } = require("electron");
const { isAgentMessage, avatarUrl } = require("./pet-model");

const ASK = new Set(["approval", "question", "ask"]); // kinds that wait for the user's answer
// toast kind -> sound event (main/sounds.js EVENTS); kinds not listed play the reply sound
const SOUND_OF = { reply: "reply", test: "reply", done: "done", approval: "approval", question: "question", ask: "question" };
const SUB_GAP_MS = 4000;
const MEDIA_TR = { get photo() { return i18nText("U0274"); }, get voice() { return i18nText("A0155"); }, video: "video", get audio() { return i18nText("common.audio"); }, get sticker() { return i18nText("U0275"); }, get file() { return i18nText("common.file"); }, get other() { return i18nText("common.attachment"); } };
const SETTLE_MS = 1500; // after a chat's first new message: streamed edits and bursts settle into one toast
const DONE_DELAY_MS = 3500; // a turn's final reply lands just before or just after the turn ends...
const DONE_QUIET_MS = 20000; // ...so "finished" is skipped when that chat got a message this recently
const KEEP = 24; // toasts kept referenced: Electron drops the click handler of a collected Notification
// Telegram's chat key is shared by message and completion feeds; session metadata is not.
const sourceKey = (key, source) => !source ? key : JSON.stringify(source.channel === "telegram"
  ? [source.hostId, source.channel, key] : [source.hostId, source.channel, source.profile, source.sid, key]);

function clip(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

function textOf(m) {
  const media = m.media ? (String(m.media).startsWith("file:") ? i18nText("common.fileName", { v: String(m.media).slice(5) }) : MEDIA_TR[m.media] || i18nText("common.attachment")) : "";
  const body = m.text || (media ? `[${media}]` : "");
  // group topics have several speakers; a bot DM has one
  return m.key[0] === "t" && m.from ? `${m.from}: ${body}` : body;
}

/** Native approval preview. The legacy host redacts commands and supplies no context attestation. */
function approvalNotice(request, captured, unlocked, host) {
  const p = captured?.preview;
  const safe = s => typeof s === "string" && s.length > 0 && /^[\x20-\x7e]+$/.test(s) && !/\.\.\.|redacted|truncated/i.test(s);
  // Include the saved identity, never the selected host or the remote's generic "local" target.
  const origin = safe(host?.id) && safe(host?.name) ? `${i18nText("hosts.select")}: ${host.name} [${host.id}]` : "";
  const context = p ? [p.command || request.command || request.description, p.target && i18nText("notify.target", { target: p.target }), p.cwd && i18nText("notify.cwd", { cwd: p.cwd })].filter(Boolean).join("\n") : request.command || request.description || "";
  const body = [origin, context].filter(Boolean).join("\n");
  const complete = !!origin && p?.complete === true && safe(p.command) && safe(p.target) && safe(p.cwd)
    && /^(?:\/|[A-Za-z]:[\\/])/.test(p.cwd) && body.length <= 120 && captured.current() && unlocked();
  return {
    title: complete ? i18nText("U0216") : i18nText("notify.review"),
    body: body || i18nText("notify.reviewOnly"),
    exactBody: complete,
    actions: complete ? [["once", "notify.approveOnce"], ["deny", "notify.reject"]]
      .filter(([choice]) => captured.choices.includes(choice))
      .map(([choice, label]) => ({ text: i18nText(label), run: () => {
        if (!unlocked() || !captured.current()) return;
        return captured.answer(choice);
      } })) : [],
  };
}

class Notifier {
  /**
   * @param {object} o
   * @param {() => boolean} o.enabled     the "Bildirimler" setting
   * @param {() => boolean} o.sound       the "Ses" setting
   * @param {(source: object|null) => boolean} o.active  true when this source is actually visible
   * @param {(key: string) => {title?: string, icon?: Electron.NativeImage}} o.describe  chat name and avatar
   * @param {(key: string|null) => void} o.onClick   bring the deck forward and open that chat
   * @param {(event: "reply"|"done"|"approval"|"question"|"subagent") => void} o.chime  play that event's sound in the renderer
   * @param {Electron.NativeImage|string} [o.icon]   fallback toast icon (the app coin)
   */
  constructor({ enabled, sound, active, describe, onClick, chime, icon, route = () => "banner", onPet = () => {}, describePet = () => ({}), unlocked = () => true }) {
    Object.assign(this, { enabled, sound, active, describe, onClick, chime, icon, route, onPet, describePet, unlocked });
    this.pending = new Map(); // chat key -> {timer, ids, count, last}: messages waiting to settle
    this.byKey = new Map(); // chat key -> {n, count}: the chat's toast on screen, with its running count
    this.lastIn = new Map(); // chat key -> ms of the latest incoming message
    this.seen = new Set(); // bounded replay dedupe, shared across pet/banner routing
    this.live = new Set(); // shown toasts, oldest first
    this.lastSub = 0; // ms of the last sub-agent sound
    this.doneTimers = new Set();
    this.generation = 0;
  }

  /** A sub-agent finished: its sound while the deck is in the background (no toast). True when it played. */
  subagent(source = null) {
    if (!this.enabled() || !this.sound() || !this.unlocked() || this.active(source)) return false;
    const now = Date.now();
    if (now - this.lastSub < SUB_GAP_MS) return false;
    this.lastSub = now;
    const generation = this.generation;
    const play = channel => {
      if (generation !== this.generation || channel !== "pet" || !this.enabled() || !this.sound() || !this.unlocked() || this.active(source)) return false;
      this.chime("subagent");
      return true;
    };
    const channel = this.route("subagent");
    return channel && typeof channel.then === "function" ? channel.then(play).catch(() => false) : play(channel);
  }

  /** Telegram "msg": a message in one of the chats the deck shows. */
  message(m, source = null) {
    if (!m || m.out || typeof m.key !== "string" || !m.key) return;
    const bucket = sourceKey(m.key, source);
    const id = JSON.stringify([bucket, m.id]);
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > 600) this.seen.delete(this.seen.values().next().value);
    this.lastIn.set(bucket, Date.now());
    if (this.lastIn.size > 600) this.lastIn.delete(this.lastIn.keys().next().value);
    if (!this.enabled() || !this.unlocked() || this.active(source)) return;
    let p = this.pending.get(bucket);
    if (!p) {
      p = { source, key: m.key, ids: new Set(), count: 0, last: null, timer: setTimeout(() => this._flush(bucket), SETTLE_MS) };
      this.pending.set(bucket, p);
    }
    if (p.ids.has(m.id)) return;
    p.ids.add(m.id);
    p.count += 1;
    p.last = m;
  }

  /** Telegram "edit": a bot streaming its reply. The toast about to show takes the newest text. */
  edit(m, source = null) {
    const p = m && this.pending.get(sourceKey(m.key, source));
    if (p && p.last && p.last.id === m.id) p.last = m;
  }

  _flush(bucket) {
    const p = this.pending.get(bucket);
    this.pending.delete(bucket);
    if (!p || !p.last || !this.enabled() || !this.unlocked() || this.active(p.source)) return;
    const { key, source } = p;
    const prev = this.byKey.get(bucket);
    const count = p.count + (prev ? prev.count : 0);
    if (prev) {
      // one toast per chat: the new one replaces it and carries the count
      this.byKey.delete(bucket);
      prev.n.close();
    }
    const d = this.describe(key) || {};
    const name = d.title || "Hermes Deck";
    const n = this.notify("reply", { source, title: count > 1 ? i18nText("A0156", { name: name, count: count }) : name, body: textOf(p.last), key, icon: d.icon,
      petEligible: isAgentMessage(p.last), pet: { ...this.describePet(key, p.last), snippet: textOf({ ...p.last, from: null }) } });
    if (n && !n.closed) this.byKey.set(bucket, { n, count });
  }

  /** A top-level agent session finished. Waits a little: the session's own reply is the better toast. */
  finished({ key = null, title, body, icon, pet, petEligible, source = null, onClick, current }) {
    if (!this.enabled() || !this.unlocked()) return;
    const timer = setTimeout(() => {
      this.doneTimers.delete(timer);
      const bucket = sourceKey(key, source);
      if (key && (!source || source.channel === "telegram") && (this.pending.has(bucket) || Date.now() - (this.lastIn.get(bucket) || 0) < DONE_QUIET_MS)) return;
      this.notify("done", { title, body, key, icon, pet, petEligible, source, onClick, current });
    }, DONE_DELAY_MS);
    this.doneTimers.add(timer);
  }

  /**
   * Shows one toast. kind: "reply" | "done" | "approval" | "question" | "test".
   * payload: {title, body, key?: chat to open on click, icon?, force?: show even while the deck is in front}.
   * Returns a cancellable handle (routing may be asynchronous), or null when suppressed.
   */
  notify(kind, payload = {}) {
    if (!this.unlocked() || (!payload.force && (!this.enabled() || (this.active(payload.source) && kind !== "update")))) return null;
    let native = null;
    let closed = false;
    let delivered = false;
    const handle = { source: payload.source, get closed() { return closed; }, close: () => { closed = true; native?.close(); forget(); } };
    const forget = () => {
      closed = true;
      this.live.delete(handle);
      for (const [k, v] of this.byKey) if (v.n === handle) this.byKey.delete(k);
    };
    const current = () => !closed && (!payload.current || payload.current());
    const deliver = channel => {
      if (!current() || !this.unlocked() || (!payload.force && (!this.enabled() || (this.active(payload.source) && kind !== "update")))) return handle.close();
      if (!channel) return handle.close();
      if (channel === "pet") {
        if (payload.petEligible === false) return handle.close();
        delivered = true;
        this.onPet({ kind: ASK.has(kind) ? "ask" : kind, agent: payload.pet?.agent || payload.title || "Hermes", snippet: clip(payload.pet?.snippet ?? payload.body, 120), key: payload.key || null, avatar: avatarUrl(payload.pet?.avatar) }, () => {
          if ((!payload.current || payload.current()) && this.unlocked()) {
            if (payload.onClick) payload.onClick(); else this.onClick(payload.key, payload.source);
          }
        });
        if (this.sound() && !payload.quiet) this.chime(SOUND_OF[kind] || "reply");
        return forget();
      }
      if (!Notification.isSupported()) return handle.close();
      native = this._banner(kind, payload, current, forget, handle.close);
      delivered = true;
    };
    this.live.add(handle);
    if (this.live.size > KEEP) this.live.values().next().value.close();
    try {
      const channel = payload.force ? "banner" : this.route(kind, payload);
      if (channel && typeof channel.then === "function") channel.then(deliver).catch(() => handle.close());
      else deliver(channel);
    } catch { handle.close(); }
    return closed && !delivered ? null : handle;
  }

  _banner(kind, payload, current, forget, close) {
    const ask = ASK.has(kind);
    const key = typeof payload.key === "string" && payload.key ? payload.key : null;
    // macOS controls actual layout and can elide text. A caller must explicitly attest
    // that a quick-action preview is complete; ordinary/legacy requests are review-only.
    const actions = this.unlocked() && payload.actions ? payload.actions : [];
    const n = new Notification({
      title: clip(payload.title, 64) || "Hermes Deck",
      body: payload.exactBody ? payload.body : clip(payload.body, 120),
      icon: payload.icon || this.icon,
      silent: !this.sound() || !!payload.quiet, // native sound follows the OS notification/Focus policy
      timeoutType: ask ? "never" : "default",
      actions: actions.map(a => ({ type: "button", text: a.text })),
    });
    let acted = false;
    n.on("action", (_event, index) => {
      if (acted || !current() || !this.unlocked() || !Number.isInteger(index) || !actions[index]) return;
      acted = true;
      close();
      Promise.resolve().then(() => actions[index].run()).catch(() => {
        // No replay. The existing request card remains the recovery path.
        if (this.unlocked() && typeof payload.onClick === "function") payload.onClick();
      });
    });
    n.on("click", () => {
      if (!current() || !this.unlocked()) return;
      close();
      if (typeof payload.onClick === "function") payload.onClick(); // a feature's own target (updates: Settings)
      else this.onClick(key, payload.source);
    });
    // A toast that timed out still sits in the Action Center and can be clicked: keep it referenced.
    n.on("close", (e) => {
      if (!e || e.reason !== "timedOut") forget();
    });
    n.on("failed", (_e, err) => {
      console.warn(`notification failed: ${err}`);
      forget();
    });
    n.show();
    return n;
  }

  /** Lock/suspend/quit: retract actions rather than leave actionable notification history. */
  closeAll() {
    this.generation++;
    for (const timer of this.doneTimers) clearTimeout(timer);
    this.doneTimers.clear();
    for (const n of [...this.live]) n.close();
    this.clear(true);
  }

  /** The deck came to the front: what the chat toasts said is on screen now. */
  clear(all = false) {
    for (const [key, p] of this.pending) if (all || this.active(p.source)) {
      clearTimeout(p.timer);
      this.pending.delete(key);
    }
    for (const n of [...this.live]) if (all || this.active(n.source)) n.close();
  }
}

module.exports = { approvalNotice, Notifier, clip, textOf, SOUND_OF, SUB_GAP_MS };
