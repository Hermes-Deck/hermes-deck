"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
// The status pet's pure parts (no Electron here, so the Node tests load it):
//   - window geometry: the pet's box at one end of a transparent window, its status bar opening toward the
//     middle of the screen, a band above it for the speech bubble;
//   - PetFeed: what desktop.js sees on its way (Telegram messages, bridge requests, finished sessions) turned
//     into pet events {kind, agent, snippet, key, avatar?, quiet?}.

// ---------------------------------------------------------------- geometry (DIP)
const SLOT_W = 112; // the pet's box: what it draws and where it takes the mouse
const SLOT_H = 144;
const BAND_H = 88; // above the box: the speech bubble and room for a hop
const W = 610; // the box plus room for its status bar on either side (transparent, click-through)
const H = BAND_H + SLOT_H;
const MARGIN = 16; // first run: distance from the work area's bottom-right corner
// Saved positions: v1 (the 88 px coin, before skins) stored the coin's top-left with no version; v2 stores the
// 112x144 box's top-left and tags it {v: 2}.
const POS_V = 2;
const COIN_V1 = 88;

// Pet size (Settings > Desktop): the whole page is drawn k times larger (CSS zoom on the pet page), so the box,
// the band and the window all scale by k. Saved positions are the box's top-left at the size in use.
const SIZES = [0.75, 1, 1.25, 1.5];
const size = (k) => (SIZES.includes(k) ? k : 1);
/** The geometry at size k, in DIP. */
function dims(k = 1) {
  k = size(k);
  const band = Math.round(BAND_H * k);
  const sh = Math.round(SLOT_H * k);
  return { k, sw: Math.round(SLOT_W * k), sh, band, w: Math.round(W * k), h: band + sh };
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Default spot: the bottom-right corner of a work area. */
function corner(wa, k = 1) {
  const d = dims(k);
  return { x: wa.x + wa.width - d.sw - MARGIN, y: wa.y + wa.height - d.sh - MARGIN };
}

/**
 * The box after a size change from kFrom to kTo: it keeps its bottom edge and its outer side edge (the one away
 * from the bar), so the pet grows or shrinks where it stands.
 */
function resize(box, side, kFrom, kTo) {
  const a = dims(kFrom);
  const b = dims(kTo);
  return { x: side === "right" ? box.x + a.sw - b.sw : box.x, y: box.y + a.sh - b.sh };
}

/** A saved position as stored in settings (tagged with the current version). */
function savedPos(box) {
  return { x: Math.round(box.x), y: Math.round(box.y), v: POS_V };
}

/**
 * A v1 saved position (the coin's top-left) as the v2 box's top-left: the box keeps the coin's bottom edge
 * and its outer side edge (right in the right half, left in the left half), so a pet left at the default
 * corner keeps its margin and the figure stands where the coin sat.
 */
function fromV1(pos, wa) {
  const right = pos.x + COIN_V1 / 2 > wa.x + wa.width / 2;
  return { x: right ? pos.x + COIN_V1 - SLOT_W : pos.x, y: pos.y + COIN_V1 - SLOT_H };
}

/**
 * The box pulled back inside the work area (with the bubble band above it on screen too), and the side the
 * box sits on in its window: "right" when it is in the right half, so the bar opens toward the middle.
 * `saved`: `pos` came from settings; an untagged (v1) one is migrated first (fromV1).
 */
function place(pos, wa, saved = false, k = 1) {
  if (saved && pos.v !== POS_V) pos = fromV1(pos, wa);
  const d = dims(k);
  const x = clamp(Math.round(pos.x), wa.x, wa.x + wa.width - d.sw);
  const y = clamp(Math.round(pos.y), wa.y + d.band, wa.y + wa.height - d.sh);
  return { box: { x, y }, side: x + d.sw / 2 > wa.x + wa.width / 2 ? "right" : "left" };
}

/** The window's bounds for a box at `box` sitting on `side`, at size k. */
function windowAt(box, side, k = 1) {
  const d = dims(k);
  return { x: Math.round(side === "right" ? box.x - (d.w - d.sw) : box.x), y: Math.round(box.y - d.band), width: d.w, height: d.h };
}

// ---------------------------------------------------------------- events
const SNIPPET = 60; // characters of a reply or question in the speech bubble
const SETTLE_MS = 900; // a bot that streams its reply by editing it: the bubble waits for the newer text
const SEEN_MAX = 600;

function clip(s, n) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/** Only a small inline image may ride along with an event (the Ajan skin's medallion). */
function avatarUrl(u) {
  return typeof u === "string" && /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(u) && u.length < 400000 ? u : undefined;
}

class PetFeed {
  /**
   * @param {object} o
   * @param {(ev: object) => void} o.emit  hands an event to the pet
   * @param {(key: string, m?: object) => {agent?: string, avatar?: string}} [o.describe]  who a chat (and a
   *        message in it) belongs to: the agent's name, its avatar as a data: URL
   * @param {(m: object) => string} [o.textOf]  a message as one line of text (media named in Turkish)
   * @param {() => boolean} [o.quiet]  true while the deck window is in front: no bubble then
   * @param {number} [o.settleMs]
   * @param {{setTimeout: Function, clearTimeout: Function}} [o.timers]  injectable for tests
   */
  constructor({ emit, describe = () => ({}), textOf = (m) => m.text || "", quiet = () => false, settleMs = SETTLE_MS, timers = { setTimeout, clearTimeout } }) {
    Object.assign(this, { emitter: emit, describe, textOf, quiet, settleMs, timers });
    this.pending = new Map(); // chat key -> {m, timer}: a reply waiting for its streamed text to settle
    this.seen = new Set(); // "key:id" of replies already shown
  }

  /** Telegram "msg": an agent's new message in a bot DM or a group topic becomes a "reply". */
  message(m) {
    if (!m || typeof m !== "object" || m.out || m.service || typeof m.key !== "string" || !/^[ut]\d+$/.test(m.key)) return;
    if (m.key[0] === "t" && !m.fromBot) return; // a topic: only bots' messages are agent replies
    const id = `${m.key}:${m.id}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value);
    const p = this.pending.get(m.key);
    if (p) {
      p.m = m; // a burst in one chat: one event, with the newest message
      return;
    }
    this.pending.set(m.key, { m, timer: this.timers.setTimeout(() => this._flush(m.key), this.settleMs) });
  }

  /** Telegram "edit": a streamed reply grew; the event about to go out takes the newer text. */
  edit(m) {
    const p = m && typeof m.key === "string" ? this.pending.get(m.key) : null;
    if (p && p.m.id === m.id) p.m = { ...p.m, ...m };
  }

  _flush(key) {
    const p = this.pending.get(key);
    this.pending.delete(key);
    if (!p) return;
    const d = this.describe(key, p.m) || {};
    // the bubble's header already names the speaker: the snippet is the message alone (notify's textOf puts
    // "<from>: " in front of a topic message, which would spend the 60 characters on the name again)
    const text = this.textOf({ ...p.m, from: null });
    this._emit({ kind: "reply", agent: d.agent || "Hermes", snippet: clip(text, SNIPPET), key, avatar: avatarUrl(d.avatar) });
  }

  /** Bridge: a new approval or question that waits for the user (desktop.js calls this once per request). */
  ask(r) {
    if (!r || typeof r !== "object") return;
    const q = Array.isArray(r.questions) && r.questions[0] ? r.questions[0].question : "";
    const text = r.kind === "approval" ? r.description || r.command : q;
    const key = typeof r.sid === "string" && r.sid ? `hs:${r.sid}` : null;
    this._emit({ kind: "ask", agent: "Hermes", snippet: clip(text || (r.kind === "approval" ? i18nText("U0276") : i18nText("A0157")), SNIPPET), key });
  }

  /** A top-level session finished well: a happy hop. Failed or stopped runs stay quiet on the pet. */
  done({ agent, key = null, state, avatar } = {}) {
    if (state === "failed" || state === "stopped") return;
    this._emit({ kind: "done", agent: clip(agent || "Hermes", 40), snippet: i18nText("U0217"), key, avatar: avatarUrl(avatar) });
  }

  _emit(ev) {
    if (!ev.avatar) delete ev.avatar;
    if (this.quiet()) ev.quiet = true;
    this.emitter(ev);
  }

  /** The deck is closing: nothing more goes out. */
  stop() {
    for (const p of this.pending.values()) this.timers.clearTimeout(p.timer);
    this.pending.clear();
  }
}

module.exports = { SLOT_W, SLOT_H, BAND_H, W, H, MARGIN, POS_V, COIN_V1, SIZES, dims, corner, resize, savedPos, fromV1, place, windowAt, PetFeed, avatarUrl, clip };
