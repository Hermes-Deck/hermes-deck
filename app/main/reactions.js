"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
// Telegram message reactions (C9) for main/telegram.js: MessageReactions as plain data, the reactions a
// chat allows, messages.SendReaction, custom emoji pictures and live UpdateMessageReactions. Kept out of
// telegram.js so the service only carries a few small hooks.
//
// A message record's `reactions` (renderer-safe, see reactionsOf):
//   {list: [{t: "emoji", e: "👍" | t: "custom", id: "<documentId>" | t: "paid", n, mine?, who?}], canSee?}
//   n: how many reacted (stars for "paid"); mine: 1-based order of the user's own choice (Telegram's
//   chosen_order); who: user ids of the recent reactors with this reaction, sent only when they are all
//   of them and at most WHO_MAX (Telegram Desktop then shows their photos instead of the number).
//   min: true when Telegram sent a "min" MessageReactions (the same for everyone, without the user's
//   own choices) and main had no earlier copy of the message to take them from; the renderer then keeps
//   the user's own from the record it already shows (renderer/reactions.js keepMine).
const path = require("path");
const { Api, helpers } = require("teleproto");
const { writeAtomic, cachedSize } = require("./media");

const WHO_MAX = 3;
const KEY_MAX = 32; // reaction keys travel through IPC: "e:<emoji>" | "c:<documentId>" | "paid"
const EMOJI_MAX_BYTES = 512 * 1024; // a custom emoji picture is a small sticker; anything larger is refused
const CHOICES_TTL = 10 * 60 * 1000;
const USER_MAX = { basic: 1, premium: 3 }; // reactions one user may put on one message (app config defaults)
const EMOJI_IDS_MAX = 5000; // custom emoji ids main has handed to the renderer (the only ones tg:emoji fetches)

const errText = (e) => String((e && (e.errorMessage || e.message)) || e || "");

/** "e:👍" | "c:5368324170671202286" | "paid", or null for ReactionEmpty and kinds newer than this code. */
function keyOf(r) {
  if (r instanceof Api.ReactionEmoji) return r.emoticon ? `e:${r.emoticon}` : null;
  if (r instanceof Api.ReactionCustomEmoji) return `c:${r.documentId.toString()}`;
  if (r instanceof Api.ReactionPaid) return "paid";
  return null;
}

/** The plain form of a reaction key: {t: "emoji", e} | {t: "custom", id} | {t: "paid"}. */
function plainOf(k) {
  if (k === "paid") return { t: "paid" };
  if (k.startsWith("c:")) return { t: "custom", id: k.slice(2) };
  return { t: "emoji", e: k.slice(2) };
}

/** A key from the renderer as a TL reaction; null when it is not one the user may send from here. */
function inputOf(k) {
  const s = String(k || "");
  if (s.length > KEY_MAX) return null;
  if (/^c:\d{1,20}$/.test(s)) return new Api.ReactionCustomEmoji({ documentId: helpers.returnBigInt(s.slice(2)) });
  // paid (star) reactions cost money and are never sent from the deck
  if (/^e:[^\s:]{1,16}$/u.test(s)) return new Api.ReactionEmoji({ emoticon: s.slice(2) });
  return null;
}

const peerUid = (p) => (p instanceof Api.PeerUser ? p.userId.toString() : null);

/**
 * MessageReactions as plain data (see the top of this file), or null when the message has none.
 * prev: the message's earlier MessageReactions; a "min" one leaves out which reactions are the user's
 * own, so those are taken from prev when prev knows them (else the record says min: true).
 */
function reactionsOf(mr, prev = null) {
  if (!(mr instanceof Api.MessageReactions)) return null;
  const known = !mr.min || (prev instanceof Api.MessageReactions && !prev.min);
  const mineOf = new Map(); // reaction key -> chosen_order
  const src = mr.min ? (known ? prev.results : []) : mr.results;
  for (const rc of src || []) {
    if (rc instanceof Api.ReactionCount && rc.chosenOrder !== undefined && rc.chosenOrder !== null) mineOf.set(keyOf(rc.reaction), rc.chosenOrder);
  }
  const recent = new Map(); // reaction key -> user ids, in Telegram's order
  for (const pr of mr.recentReactions || []) {
    const k = keyOf(pr.reaction);
    const uid = peerUid(pr.peerId);
    if (!k || !uid) continue;
    if (!recent.has(k)) recent.set(k, []);
    if (!recent.get(k).includes(uid)) recent.get(k).push(uid);
  }
  const list = [];
  for (const rc of mr.results || []) {
    const k = rc instanceof Api.ReactionCount ? keyOf(rc.reaction) : null;
    const n = rc && Number(rc.count);
    if (!k || !(n > 0)) continue;
    const order = mineOf.get(k);
    const who = recent.get(k);
    const item = { ...plainOf(k), n };
    if (order !== undefined && order !== null) item.mine = Number(order) + 1;
    if (k !== "paid" && who && who.length === n && n <= WHO_MAX) item.who = who;
    list.push(item);
  }
  if (!list.length) return null;
  const out = { list };
  if (mr.canSeeList) out.canSee = true;
  if (!known) out.min = true;
  return out;
}

/**
 * Make a "min" MessageReactions complete before it replaces prev (the same message's earlier one) in
 * the raw cache: the user's own choices are copied over from prev and min is cleared. Without this the
 * next min update would find no earlier choices and the user's highlight would vanish. Leaves mr as it
 * is when prev does not know them either. Mutates mr; returns it.
 */
function carryMine(mr, prev) {
  if (!(mr instanceof Api.MessageReactions) || !mr.min) return mr;
  if (!(prev instanceof Api.MessageReactions) || prev.min) return mr;
  const mine = new Map();
  for (const rc of prev.results || []) {
    if (rc instanceof Api.ReactionCount && rc.chosenOrder !== undefined && rc.chosenOrder !== null) mine.set(keyOf(rc.reaction), rc.chosenOrder);
  }
  for (const rc of mr.results || []) {
    if (!(rc instanceof Api.ReactionCount)) continue;
    const o = mine.get(keyOf(rc.reaction));
    if (o !== undefined) rc.chosenOrder = o;
  }
  mr.min = false;
  return mr;
}

/** User ids worth a photo: the reactors the renderer will draw. */
function reactorIds(rec) {
  const out = new Set();
  for (const it of (rec && rec.list) || []) for (const uid of it.who || []) out.add(uid);
  return [...out];
}

/** The reactions this account may send: Telegram's list minus inactive ones (and premium ones without Premium). */
function allowedEmoji(avail, premium) {
  return (avail || []).filter((a) => a instanceof Api.AvailableReaction && !a.inactive && (premium || !a.premium)).map((a) => `e:${a.reaction}`);
}

/**
 * The picker for one chat: {list: [{t, e|id}], max}. chatReactions: the group's available_reactions
 * (ChatReactionsAll | Some | None; bot DMs: null, which allows every reaction); def: Telegram's default
 * reaction (help.getConfig reactions_default), put first when allowed.
 */
function choicesOf({ avail, chatReactions = null, def = null, premium = false }) {
  const all = allowedEmoji(avail, premium);
  let keys;
  if (chatReactions instanceof Api.ChatReactionsNone) keys = [];
  else if (chatReactions instanceof Api.ChatReactionsSome) {
    const ok = new Set(all);
    // a group may list custom emoji; only Premium accounts can send them
    keys = (chatReactions.reactions || []).map(keyOf).filter((k) => k && (ok.has(k) || (premium && k.startsWith("c:"))));
  } else keys = all;
  const d = def ? keyOf(def) : null;
  if (d && keys.includes(d)) keys = [d, ...keys.filter((k) => k !== d)];
  return { list: keys.map(plainOf), max: premium ? USER_MAX.premium : USER_MAX.basic };
}

const SEND_ERRORS = () => [
  [/MESSAGE_NOT_MODIFIED/, null],
  [/REACTION_INVALID|REACTION_EMPTY|CUSTOM_REACTIONS_TOO_MANY/, i18nText("U0227")],
  [/REACTIONS_TOO_MANY/, i18nText("U0284")],
  [/REACTIONS_COUNT_TOO_MANY|REACTIONS_USER_TOO_MANY/, i18nText("A0160")],
  [/PREMIUM_ACCOUNT_REQUIRED/, i18nText("U0285")],
  [/MESSAGE_ID_INVALID|MSG_ID_INVALID/, i18nText("U0228")],
  [/CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED|USER_BANNED_IN_CHANNEL|CHANNEL_PRIVATE|USER_IS_BLOCKED/, i18nText("A0161")],
  [/FLOOD_WAIT|SLOWMODE_WAIT/, i18nText("U0286")],
];

/** The MessageReactions an Updates answer carries for this message, if any. */
function reactionsIn(res, id) {
  const ups = res instanceof Api.UpdateShort ? [res.update] : (res && res.updates) || [];
  const u = ups.find((x) => x instanceof Api.UpdateMessageReactions && x.msgId === id);
  return u ? u.reactions : null;
}

/** Owns the service's reaction state: choices per chat, the custom emoji cache and reactor photos. */
class Reactions {
  constructor(svc) {
    this.svc = svc;
    this._avail = null; // {at, list: AvailableReaction[]}
    this._def = undefined; // Telegram's default reaction (help.getConfig), null when it has none
    this._chat = new Map(); // group id -> {at, value: ChatReactions | null}
    this._who = new Set(); // reactor ids waiting for a photo lookup
    this._whoT = null;
    this._whoDone = new Set();
    this._emojiIds = new Set(); // custom emoji document ids main has serialized (results and pickers)
  }

  get client() {
    return this.svc.client;
  }

  /** Plain reactions of m, noting reactors whose photo is not known yet and custom emoji the renderer may ask for. */
  ser(m, prev = null) {
    const rec = reactionsOf(m.reactions, prev);
    if (rec) {
      this.noteReactors(rec);
      this.noteEmoji(rec.list);
    }
    return rec;
  }

  /** Custom emoji ids handed to the renderer: emoji() downloads only these (bounded, oldest dropped first). */
  noteEmoji(list) {
    for (const it of list || []) {
      if (!it || it.t !== "custom") continue;
      const id = String(it.id);
      this._emojiIds.delete(id);
      this._emojiIds.add(id);
    }
    while (this._emojiIds.size > EMOJI_IDS_MAX) this._emojiIds.delete(this._emojiIds.values().next().value);
  }

  noteReactors(rec) {
    const svc = this.svc;
    for (const uid of reactorIds(rec)) {
      if (this._whoDone.has(uid) || svc._seen.has(uid) || svc.bots.has(uid)) continue;
      this._who.add(uid);
    }
    if (this._who.size && this.client && !this._whoT) this._whoT = setTimeout(() => this._loadReactors().catch(() => {}), 300);
  }

  /** Reactors' User objects (one users.getUsers for those teleproto knows) into the service's people photos. */
  async _loadReactors() {
    this._whoT = null;
    const ids = [...this._who].slice(0, 50);
    for (const uid of ids) {
      this._who.delete(uid);
      this._whoDone.add(uid);
    }
    if (this._who.size) this._whoT = setTimeout(() => this._loadReactors().catch(() => {}), 300);
    const c = this.client;
    if (!c || !ids.length) return;
    const inputs = [];
    for (const uid of ids) {
      try {
        inputs.push(await c.getInputEntity(new Api.PeerUser({ userId: helpers.returnBigInt(uid) })));
      } catch {
        /* never seen by this session: the chip keeps a monogram */
      }
    }
    if (!inputs.length) return;
    const users = await c.getEntity(inputs);
    for (const u of [].concat(users || [])) {
      if (!(u instanceof Api.User)) continue;
      const uid = u.id.toString();
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || null;
      if (name) this.svc._person(uid, { name });
      this.svc._notePerson(u, null);
    }
  }

  async _available() {
    if (this._avail && Date.now() - this._avail.at < CHOICES_TTL) return this._avail.list;
    const res = await this.client.invoke(new Api.messages.GetAvailableReactions({ hash: 0 }));
    const list = res instanceof Api.messages.AvailableReactions ? res.reactions || [] : (this._avail && this._avail.list) || [];
    this._avail = { at: Date.now(), list };
    return list;
  }

  async _default() {
    if (this._def !== undefined) return this._def;
    try {
      const cfg = await this.client.invoke(new Api.help.GetConfig());
      this._def = (cfg && cfg.reactionsDefault) || null;
    } catch {
      this._def = null;
    }
    return this._def;
  }

  /** The group's available_reactions from its full info (cached); null for a bot DM, which allows all. */
  async _chatReactions(key) {
    if (key[0] !== "t" || !this.svc.group) return null;
    const gid = this.svc.groupId;
    const hit = this._chat.get(gid);
    if (hit && Date.now() - hit.at < CHOICES_TTL) return hit.value;
    const res = await this.client.invoke(new Api.channels.GetFullChannel({ channel: this.svc.group }));
    const value = (res && res.fullChat && res.fullChat.availableReactions) || null;
    this._chat.set(gid, { at: Date.now(), value });
    return value;
  }

  /** What the picker offers in this chat: {list, max}. */
  async choices(key) {
    this.svc._target(key); // a known chat, or throws
    const [avail, chatReactions, def] = await Promise.all([this._available(), this._chatReactions(key), this._default()]);
    const c = choicesOf({ avail, chatReactions, def, premium: !!(this.svc.me && this.svc.me.premium) });
    this.noteEmoji(c.list);
    return c;
  }

  /**
   * Set the user's own reactions on a message to exactly `keys` (an empty list takes them all back) and
   * return the message's reactions as Telegram now has them (undefined when the answer did not say).
   */
  async send(key, id, keys) {
    const list = Array.isArray(keys) ? keys : [];
    if (list.length > USER_MAX.premium) throw new Error(i18nText("A0160"));
    const reaction = list.map(inputOf);
    if (reaction.some((r) => !r)) throw new Error(i18nText("U0287"));
    const svc = this.svc;
    const { entity } = svc._target(key);
    let res;
    try {
      res = await this.client.invoke(new Api.messages.SendReaction({ peer: entity, msgId: id, reaction, addToRecent: reaction.length > 0 }));
    } catch (e) {
      const s = errText(e);
      const hit = SEND_ERRORS().find(([re]) => re.test(s));
      if (hit && hit[1] === null) return undefined;
      throw new Error(hit ? hit[1] : s.slice(0, 140));
    }
    const mr = reactionsIn(res, id);
    if (!mr) return undefined;
    return this.apply(key, id, mr);
  }

  /**
   * Store new MessageReactions on the cached message and return their plain form. A "min" update takes
   * the user's own choices from the cached copy first, so they survive any number of min updates.
   */
  apply(key, id, mr) {
    const raw = this.svc.raw.get(`${key}:${id}`);
    carryMine(mr, raw ? raw.reactions : null);
    const rec = this.ser({ reactions: mr });
    if (raw) raw.reactions = mr;
    return rec;
  }

  /** UpdateMessageReactions: emit "reactions" {key, id, reactions} for a chat the deck shows. */
  onUpdate(u) {
    const svc = this.svc;
    let key = null;
    const p = u.peer;
    if (p instanceof Api.PeerUser) key = svc.bots.has(p.userId.toString()) ? `u${p.userId}` : null;
    else if (p instanceof Api.PeerChannel && svc.group && `-100${p.channelId}` === svc.groupId) {
      // the topic the message was stored under wins; else the update's own thread (General has none)
      const known = [...svc.raw.keys()].find((k) => k.startsWith("t") && k.endsWith(`:${u.msgId}`));
      key = known ? known.split(":")[0] : `t${u.topMsgId || 1}`;
    }
    if (!key) return;
    svc.emit("reactions", { key, id: u.msgId, reactions: this.apply(key, u.msgId, u.reactions) });
  }

  /**
   * A custom emoji's picture as a data: URL (static WEBP/PNG, or the largest real thumbnail of an
   * animated one), cached in the media folder; null when there is nothing drawable (the chip then shows
   * a neutral placeholder).
   */
  async emoji(docId) {
    const svc = this.svc;
    if (!/^\d{1,20}$/.test(String(docId))) throw new Error(i18nText("U0258"));
    if (!svc.mediaDir) return null;
    const file = path.join(svc.mediaDir, "emoji", `${docId}.img`);
    const none = `${file}.none`;
    if (cachedSize(none)) return null;
    // only ids main itself put in a record or a picker: a renderer cannot make main fetch arbitrary documents
    if (!cachedSize(file) && !this._emojiIds.has(String(docId))) return null;
    if (!cachedSize(file)) {
      await svc._download(file, async () => {
        if (cachedSize(file)) return;
        const [doc] = await this.client.invoke(new Api.messages.GetCustomEmojiDocuments({ documentId: [helpers.returnBigInt(docId)] }));
        if (!(doc instanceof Api.Document)) return writeAtomic(none, Buffer.from("1"));
        const still = /^image\/(webp|png)$/.test(doc.mimeType || "") && Number(doc.size) <= EMOJI_MAX_BYTES;
        const thumbs = (doc.thumbs || []).filter((s) => s instanceof Api.PhotoSize || s instanceof Api.PhotoSizeProgressive || s instanceof Api.PhotoCachedSize);
        if (!still && !thumbs.length) return writeAtomic(none, Buffer.from("1")); // Lottie / video only
        const opts = still ? {} : { thumb: thumbs[thumbs.length - 1].type };
        const buf = await this.client.downloadMedia(doc, opts);
        if (!Buffer.isBuffer(buf) || !buf.length || buf.length > EMOJI_MAX_BYTES) return writeAtomic(none, Buffer.from("1"));
        writeAtomic(file, buf);
      });
    }
    return cachedSize(file) ? file : null;
  }
}

module.exports = { Reactions, reactionsOf, carryMine, choicesOf, keyOf, inputOf, reactionsIn, WHO_MAX, USER_MAX, EMOJI_IDS_MAX };
