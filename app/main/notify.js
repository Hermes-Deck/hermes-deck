"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
// A9: OS notifications while the deck window is in the background. Three sources feed one entry point:
//   - new incoming chat messages, settled per chat for a moment so a bot that streams its reply by editing
//     the message is shown with its newest text, and a burst becomes one toast with a count;
//   - a top-level agent session that finishes (skipped when its reply already produced a toast);
//   - notify(kind, payload) for other features: the bridge uses kind "approval" / "question" for things that
//     wait for the user's answer (their own sound, toast stays until dismissed);
//   - subagent(): a sub-agent finished. Sound only, no toast, at most one per SUB_GAP_MS (a fan-out of
//     sub-agents finishing together is one sound).
// Toasts are always silent; the renderer plays each event's sound (renderer/chime.js: built-in or the user's
// own file, Settings > Desktop > Notifications) when sound is on.
const { Notification } = require("electron");

const ASK = new Set(["approval", "question", "ask"]); // kinds that wait for the user's answer
// toast kind -> sound event (main/sounds.js EVENTS); kinds not listed play the reply sound
const SOUND_OF = { reply: "reply", test: "reply", done: "done", approval: "approval", question: "question", ask: "question" };
const SUB_GAP_MS = 4000;
const MEDIA_TR = { get photo() { return i18nText("U0274"); }, get voice() { return i18nText("A0155"); }, video: "video", get audio() { return i18nText("common.audio"); }, get sticker() { return i18nText("U0275"); }, get file() { return i18nText("common.file"); }, get other() { return i18nText("common.attachment"); } };
const SETTLE_MS = 1500; // after a chat's first new message: streamed edits and bursts settle into one toast
const DONE_DELAY_MS = 3500; // a turn's final reply lands just before or just after the turn ends...
const DONE_QUIET_MS = 20000; // ...so "finished" is skipped when that chat got a message this recently
const KEEP = 24; // toasts kept referenced: Electron drops the click handler of a collected Notification

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

class Notifier {
  /**
   * @param {object} o
   * @param {() => boolean} o.enabled     the "Bildirimler" setting
   * @param {() => boolean} o.sound       the "Ses" setting
   * @param {() => boolean} o.active      true while the deck window is in front (then nothing is shown)
   * @param {(key: string) => {title?: string, icon?: Electron.NativeImage}} o.describe  chat name and avatar
   * @param {(key: string|null) => void} o.onClick   bring the deck forward and open that chat
   * @param {(event: "reply"|"done"|"approval"|"question"|"subagent") => void} o.chime  play that event's sound in the renderer
   * @param {Electron.NativeImage|string} [o.icon]   fallback toast icon (the app coin)
   */
  constructor({ enabled, sound, active, describe, onClick, chime, icon }) {
    Object.assign(this, { enabled, sound, active, describe, onClick, chime, icon });
    this.pending = new Map(); // chat key -> {timer, ids, count, last}: messages waiting to settle
    this.byKey = new Map(); // chat key -> {n, count}: the chat's toast on screen, with its running count
    this.lastIn = new Map(); // chat key -> ms of the latest incoming message
    this.live = new Set(); // shown toasts, oldest first
    this.lastSub = 0; // ms of the last sub-agent sound
  }

  /** A sub-agent finished: its sound while the deck is in the background (no toast). True when it played. */
  subagent() {
    if (!this.enabled() || !this.sound() || this.active()) return false;
    const now = Date.now();
    if (now - this.lastSub < SUB_GAP_MS) return false;
    this.lastSub = now;
    this.chime("subagent");
    return true;
  }

  /** Telegram "msg": a message in one of the chats the deck shows. */
  message(m) {
    if (!m || m.out || typeof m.key !== "string" || !m.key) return;
    this.lastIn.set(m.key, Date.now());
    if (!this.enabled() || this.active()) return;
    let p = this.pending.get(m.key);
    if (!p) {
      p = { ids: new Set(), count: 0, last: null, timer: setTimeout(() => this._flush(m.key), SETTLE_MS) };
      this.pending.set(m.key, p);
    }
    if (p.ids.has(m.id)) return;
    p.ids.add(m.id);
    p.count += 1;
    p.last = m;
  }

  /** Telegram "edit": a bot streaming its reply. The toast about to show takes the newest text. */
  edit(m) {
    const p = m && this.pending.get(m.key);
    if (p && p.last && p.last.id === m.id) p.last = m;
  }

  _flush(key) {
    const p = this.pending.get(key);
    this.pending.delete(key);
    if (!p || !p.last || !this.enabled() || this.active()) return;
    const prev = this.byKey.get(key);
    const count = p.count + (prev ? prev.count : 0);
    if (prev) {
      // one toast per chat: the new one replaces it and carries the count
      this.byKey.delete(key);
      prev.n.close();
    }
    const d = this.describe(key) || {};
    const name = d.title || "Hermes Deck";
    const n = this.notify("reply", { title: count > 1 ? i18nText("A0156", { name: name, count: count }) : name, body: textOf(p.last), key, icon: d.icon });
    if (n) this.byKey.set(key, { n, count });
  }

  /** A top-level agent session finished. Waits a little: the session's own reply is the better toast. */
  finished({ key = null, title, body, icon }) {
    if (!this.enabled()) return;
    setTimeout(() => {
      if (key && (this.pending.has(key) || Date.now() - (this.lastIn.get(key) || 0) < DONE_QUIET_MS)) return;
      this.notify("done", { title, body, key, icon });
    }, DONE_DELAY_MS);
  }

  /**
   * Shows one toast. kind: "reply" | "done" | "approval" | "question" | "test".
   * payload: {title, body, key?: chat to open on click, icon?, force?: show even while the deck is in front}.
   * Returns the Notification, or null when nothing was shown.
   */
  notify(kind, payload = {}) {
    if (!payload.force && (!this.enabled() || (this.active() && kind !== "update"))) return null;
    if (!Notification.isSupported()) return null;
    const ask = ASK.has(kind);
    const key = typeof payload.key === "string" && payload.key ? payload.key : null;
    const n = new Notification({
      title: clip(payload.title, 64) || "Hermes Deck",
      body: clip(payload.body, 120),
      icon: payload.icon || this.icon,
      silent: true, // the deck's own chime, or nothing
      timeoutType: ask ? "never" : "default",
    });
    const forget = () => {
      this.live.delete(n);
      for (const [k, v] of this.byKey) if (v.n === n) this.byKey.delete(k);
    };
    n.on("click", () => {
      forget();
      if (typeof payload.onClick === "function") payload.onClick(); // a feature's own target (updates: Settings)
      else this.onClick(key);
    });
    // A toast that timed out still sits in the Action Center and can be clicked: keep it referenced.
    n.on("close", (e) => {
      if (!e || e.reason !== "timedOut") forget();
    });
    n.on("failed", (_e, err) => {
      console.warn(`notification failed: ${err}`);
      forget();
    });
    this.live.add(n);
    if (this.live.size > KEEP) this.live.delete(this.live.values().next().value);
    n.show();
    if (this.sound() && !payload.quiet) this.chime(SOUND_OF[kind] || "reply");
    return n;
  }

  /** The deck came to the front: what the chat toasts said is on screen now. */
  clear() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    for (const { n } of this.byKey.values()) n.close();
    this.byKey.clear();
  }
}

module.exports = { Notifier, clip, textOf, SOUND_OF, SUB_GAP_MS };
