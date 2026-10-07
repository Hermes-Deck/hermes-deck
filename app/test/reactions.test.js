"use strict";
// Message reactions (C9), offline: the MessageReactions serializer (emoji, custom emoji, stars, recent
// reactors), live UpdateMessageReactions, messages.SendReaction request shapes and Turkish errors, the
// picker's choices, custom emoji pictures, the renderer's toggle math and the fixture's in-memory
// reactions. Fake clients only; like telegram.test.js, a guard fails the run on any socket or DNS use.
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const net = require("net");
const tls = require("tls");
const dns = require("dns");
const I18N = require("../renderer/i18n");
beforeEach(() => I18N.setLanguage("en"));

const blocked = (what) =>
  function () {
    throw new Error(`network use in a test: ${what}`);
  };
net.connect = net.createConnection = blocked("net.connect");
net.Socket.prototype.connect = blocked("net.Socket.connect");
tls.connect = blocked("tls.connect");
dns.lookup = blocked("dns.lookup");

const { Api, helpers } = require("teleproto");
const { TelegramService } = require("../main/telegram");
const { reactionsOf, carryMine, choicesOf, inputOf, keyOf } = require("../main/reactions");
const { FixtureService } = require("../main/fixture");
const RX = require("../renderer/reactions");
const sample = require("./rich-sample");

const big = helpers.returnBigInt;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "deck-reactions-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const GROUP_ID = `-100${sample.GROUP_CHANNEL}`;
const KEY = `u${sample.BOT}`;
const ME = "1000001";
const channel = () => new Api.Channel({ id: big(sample.GROUP_CHANNEL), accessHash: big(77), title: "Atölye", photo: new Api.ChatPhotoEmpty(), date: 0, forum: true, megagroup: true });
const bot = () => new Api.User({ id: big(sample.BOT), accessHash: big(5), bot: true, firstName: "Atlas", username: "atlas_ornek_bot" });

function service(client = {}, opts = {}) {
  const svc = new TelegramService({ apiId: 1, apiHash: "x", groupChatId: GROUP_ID, mediaDir: path.join(TMP, "media"), ...opts });
  svc.client = client;
  svc.me = new Api.User({ id: big(ME), self: true, firstName: "Deniz" });
  svc.bots.set(sample.BOT, { key: KEY, entity: bot() });
  svc.group = channel();
  return svc;
}

const RE = (e) => new Api.ReactionEmoji({ emoticon: e });
const CE = (id) => new Api.ReactionCustomEmoji({ documentId: big(id) });
const peer = (uid) => new Api.PeerUser({ userId: big(uid) });
const mr = (results, recent = [], extra = {}) =>
  new Api.MessageReactions({
    results: results.map(([reaction, count, chosenOrder]) => new Api.ReactionCount({ reaction, count, chosenOrder })),
    recentReactions: recent.map(([uid, reaction]) => new Api.MessagePeerReaction({ peerId: peer(uid), date: 0, reaction })),
    ...extra,
  });
const rpcError = (msg) => Object.assign(new Error(msg), { errorMessage: msg, code: 400 });

// ------------------------------------------------------------------ serializer
test("serializer: emoji, custom emoji and stars, the user's own order, reactors only when they are all of them", () => {
  const rec = reactionsOf(
    mr(
      [
        [RE("👍"), 2, 1],
        [RE("❤"), 1, 0],
        [CE("5000000000000000001"), 4],
        [new Api.ReactionPaid(), 50, 2],
        [RE("🔥"), 3],
        [new Api.ReactionEmpty(), 9],
        [RE("😢"), 0],
      ],
      [
        [9002, RE("👍")],
        [ME, RE("👍")],
        [ME, RE("❤")],
        [9001, CE("5000000000000000001")],
        [9001, RE("🔥")],
        [9002, RE("🔥")],
        [9003, RE("🔥")],
        [9001, new Api.ReactionPaid()],
      ],
      { canSeeList: true }
    )
  );
  assert.deepEqual(rec, {
    canSee: true,
    list: [
      { t: "emoji", e: "👍", n: 2, mine: 2, who: ["9002", ME] },
      { t: "emoji", e: "❤", n: 1, mine: 1, who: [ME] },
      { t: "custom", id: "5000000000000000001", n: 4 }, // one recent reactor of four: the number
      { t: "paid", n: 50, mine: 3 }, // stars never show photos
      { t: "emoji", e: "🔥", n: 3, who: ["9001", "9002", "9003"] },
    ],
  });
  assert.equal(reactionsOf(mr([])), null);
  assert.equal(reactionsOf(undefined), null);
  // more than three reactors: always the number, even when Telegram lists them all
  const four = reactionsOf(mr([[RE("👍"), 4]], [[1, RE("👍")], [2, RE("👍")], [3, RE("👍")], [4, RE("👍")]]));
  assert.deepEqual(four, { list: [{ t: "emoji", e: "👍", n: 4 }] });
});

test("serializer: a min update keeps which reactions are the user's own from the message's earlier ones", () => {
  const before = mr([[RE("👍"), 1, 0]]);
  const minUp = mr([[RE("👍"), 2], [RE("🔥"), 1]], [], { min: true });
  assert.deepEqual(reactionsOf(minUp, before).list, [
    { t: "emoji", e: "👍", n: 2, mine: 1 },
    { t: "emoji", e: "🔥", n: 1 },
  ]);
});

test("ser: a message record carries its reactions; reactors' photos go through the people avatar cache", async () => {
  const lookups = [];
  const users = {
    9002: new Api.User({ id: big(9002), accessHash: big(1), firstName: "Tolga", lastName: "Arı", photo: new Api.UserProfilePhoto({ photoId: big(31), dcId: 2 }) }),
  };
  const client = {
    getInputEntity: async (p) => {
      const uid = p.userId.toString();
      if (!users[uid]) throw new Error("Could not find the input entity");
      lookups.push(uid);
      return new Api.InputPeerUser({ userId: big(uid), accessHash: big(1) });
    },
    getEntity: async (inputs) => inputs.map((x) => users[x.userId.toString()]),
    downloadProfilePhoto: async () => Buffer.from([0xff, 0xd8, 0xff, 1]),
  };
  const svc = service(client, { avatarDir: path.join(TMP, "avatars") });
  const people = new Promise((resolve) => svc.once("people", resolve));
  const m = new Api.Message({ id: 40, peerId: peer(sample.BOT), date: 0, message: "Tamam", reactions: mr([[RE("👍"), 2]], [[9002, RE("👍")], [9004, RE("👍")]]) });
  const rec = svc.ser(m, KEY);
  assert.deepEqual(rec.reactions, { list: [{ t: "emoji", e: "👍", n: 2, who: ["9002", "9004"] }] });
  const got = await people;
  clearTimeout(svc.reactions._whoT);
  assert.deepEqual(lookups, ["9002"]); // 9004 is unknown to the session: it keeps a monogram
  assert.equal(got["9002"].name, "Tolga Arı");
  assert.match(got["9002"].avatar, /^data:image\/jpeg;base64,/);
  // a message without reactions has no field at all
  assert.equal("reactions" in svc.ser(new Api.Message({ id: 41, peerId: peer(sample.BOT), date: 0, message: "x" }), KEY), false);
});

// ------------------------------------------------------------------ live updates
test("live updates: UpdateMessageReactions becomes a 'reactions' event for the chat it belongs to", () => {
  const svc = service({});
  const got = [];
  svc.on("reactions", (x) => got.push(x));
  const reactions = mr([[RE("🔥"), 1, 0]]);
  // bot DM
  svc._onRaw(new Api.UpdateMessageReactions({ peer: peer(sample.BOT), msgId: 7, reactions }));
  // group: the topic from the update, or General without one
  svc._onRaw(new Api.UpdateMessageReactions({ peer: new Api.PeerChannel({ channelId: big(sample.GROUP_CHANNEL) }), msgId: 70, topMsgId: 5, reactions }));
  svc._onRaw(new Api.UpdateMessageReactions({ peer: new Api.PeerChannel({ channelId: big(sample.GROUP_CHANNEL) }), msgId: 71, reactions }));
  // a message already stored under a topic stays there, and its cached copy gets the new reactions
  const stored = new Api.Message({ id: 72, peerId: new Api.PeerChannel({ channelId: big(sample.GROUP_CHANNEL) }), date: 0, message: "x" });
  svc._remember("t9", stored);
  svc._onRaw(new Api.UpdateMessageReactions({ peer: new Api.PeerChannel({ channelId: big(sample.GROUP_CHANNEL) }), msgId: 72, reactions }));
  // chats the deck does not show are ignored
  svc._onRaw(new Api.UpdateMessageReactions({ peer: peer(424242), msgId: 1, reactions }));
  svc._onRaw(new Api.UpdateMessageReactions({ peer: new Api.PeerChannel({ channelId: big(1) }), msgId: 1, reactions }));
  const mine = { list: [{ t: "emoji", e: "🔥", n: 1, mine: 1 }] };
  assert.deepEqual(got, [
    { key: KEY, id: 7, reactions: mine },
    { key: "t5", id: 70, reactions: mine },
    { key: "t1", id: 71, reactions: mine },
    { key: "t9", id: 72, reactions: mine },
  ]);
  assert.equal(stored.reactions, reactions);
  // all reactions gone: null, so the chips disappear
  svc._onRaw(new Api.UpdateMessageReactions({ peer: peer(sample.BOT), msgId: 7, reactions: mr([]) }));
  assert.equal(got[got.length - 1].reactions, null);
});

test("live updates: an edited message brings its reactions in the record ('edit' event)", () => {
  const svc = service({});
  const got = [];
  svc.on("edit", (x) => got.push(x));
  const m = new Api.Message({ id: 9, peerId: peer(sample.BOT), date: 0, editDate: 5, message: "düzeltildi", reactions: mr([[RE("👏"), 3]]) });
  svc._onEdit({ message: m });
  assert.deepEqual(got[0].reactions, { list: [{ t: "emoji", e: "👏", n: 3 }] });
});

// ------------------------------------------------------------------ sending
test("SendReaction: the user's whole set goes out as TL reactions; the answer's reactions come back", async () => {
  const calls = [];
  const client = {
    invoke: async (req) => {
      calls.push(req);
      return new Api.Updates({
        updates: [new Api.UpdateMessageReactions({ peer: peer(sample.BOT), msgId: 12, reactions: mr([[RE("👍"), 1, 0], [CE("77"), 1, 1]], [[ME, RE("👍")], [ME, CE("77")]]) })],
        users: [],
        chats: [],
        date: 0,
        seq: 0,
      });
    },
  };
  const svc = service(client);
  const res = await svc.react(KEY, 12, ["e:👍", "c:77"]);
  const req = calls[0];
  assert.ok(req instanceof Api.messages.SendReaction);
  assert.equal(req.peer, svc.bots.get(sample.BOT).entity);
  assert.equal(req.msgId, 12);
  assert.equal(req.addToRecent, true);
  assert.equal(req.reaction.length, 2);
  assert.ok(req.reaction[0] instanceof Api.ReactionEmoji && req.reaction[0].emoticon === "👍");
  assert.ok(req.reaction[1] instanceof Api.ReactionCustomEmoji && req.reaction[1].documentId.toString() === "77");
  assert.deepEqual(res, {
    list: [
      { t: "emoji", e: "👍", n: 1, mine: 1, who: [ME] },
      { t: "custom", id: "77", n: 1, mine: 2, who: [ME] },
    ],
  });
  // taking every reaction back: an empty list, not added to the recent ones
  await svc.react("t5", 12, []);
  assert.deepEqual(calls[1].reaction, []);
  assert.equal(calls[1].addToRecent, false);
  assert.equal(calls[1].peer, svc.group);
});

test("SendReaction: stars, junk and too many are refused before Telegram; errors come back in Turkish", async () => {
  I18N.setLanguage("tr");
  let n = 0;
  let fail = null;
  const svc = service({
    invoke: async () => {
      n++;
      if (fail) throw rpcError(fail);
      return new Api.Updates({ updates: [], users: [], chats: [], date: 0, seq: 0 });
    },
  });
  await assert.rejects(svc.react(KEY, 1, ["paid"]), /buradan gönderilemiyor/);
  await assert.rejects(svc.react(KEY, 1, ["e:a b"]), /buradan gönderilemiyor/);
  await assert.rejects(svc.react(KEY, 1, ["c:12x"]), /buradan gönderilemiyor/);
  await assert.rejects(svc.react(KEY, 1, ["e:1", "e:2", "e:3", "e:4"]), /daha fazla tepki/);
  await assert.rejects(svc.react("x9", 1, ["e:👍"]), /bad chat key/);
  assert.equal(n, 0);
  assert.equal(await svc.react(KEY, 1, ["e:👍"]), undefined); // the answer did not say: the renderer keeps its guess
  const cases = [
    ["REACTION_INVALID", /bu sohbette kullanılamıyor/],
    ["REACTIONS_TOO_MANY", /farklı tepki eklenemiyor/],
    ["PREMIUM_ACCOUNT_REQUIRED", /Premium/],
    ["MESSAGE_ID_INVALID", /Mesaj bulunamadı/],
    ["CHAT_WRITE_FORBIDDEN", /iznin yok/],
    ["FLOOD_WAIT_12", /biraz bekleyip/],
    ["SOMETHING_NEW", /SOMETHING_NEW/],
  ];
  for (const [code, re] of cases) {
    fail = code;
    await assert.rejects(svc.react(KEY, 1, ["e:👍"]), re, code);
  }
  fail = "MESSAGE_NOT_MODIFIED";
  assert.equal(await svc.react(KEY, 1, ["e:👍"]), undefined);
});

test("inputOf/keyOf: reaction keys and TL reactions map both ways", () => {
  for (const k of ["e:👍", "e:❤", "c:5368324170671202286"]) assert.equal(keyOf(inputOf(k)), k);
  assert.equal(inputOf("paid"), null);
  assert.equal(inputOf("e:"), null);
  assert.equal(inputOf(`e:${"x".repeat(40)}`), null);
  assert.equal(keyOf(new Api.ReactionPaid()), "paid");
  assert.equal(keyOf(new Api.ReactionEmpty()), null);
});

// ------------------------------------------------------------------ the picker's choices
const avail = (e, extra = {}) => new Api.AvailableReaction({ reaction: e, title: e, staticIcon: null, appearAnimation: null, selectAnimation: null, activateAnimation: null, effectAnimation: null, ...extra });
const AVAIL = [avail("👍"), avail("❤"), avail("🔥"), avail("🤡", { inactive: true }), avail("🐳", { premium: true })];

test("choices: Telegram's list for a DM, the group's own list in a topic, the default reaction first", async () => {
  const calls = [];
  let chatReactions = new Api.ChatReactionsSome({ reactions: [RE("🔥"), RE("👍"), RE("🐳"), CE("88"), RE("🆕")] });
  const client = {
    invoke: async (req) => {
      calls.push(req.className);
      if (req instanceof Api.messages.GetAvailableReactions) return new Api.messages.AvailableReactions({ hash: 1, reactions: AVAIL });
      if (req instanceof Api.help.GetConfig) return { reactionsDefault: RE("❤") };
      if (req instanceof Api.channels.GetFullChannel) {
        assert.equal(req.channel, svc.group);
        return { fullChat: { availableReactions: chatReactions } };
      }
      throw new Error(`unexpected ${req.className}`);
    },
  };
  const svc = service(client);
  const e = (x) => ({ t: "emoji", e: x });
  assert.deepEqual(await svc.reactionChoices(KEY), { list: [e("❤"), e("👍"), e("🔥")], max: 1 }); // inactive and premium-only left out
  assert.deepEqual(await svc.reactionChoices("t5"), { list: [e("🔥"), e("👍")], max: 1 }); // ❤ (default) not allowed there
  // cached: one round of calls for both chats
  await svc.reactionChoices("t5");
  assert.deepEqual(calls.sort(), ["channels.GetFullChannel", "help.GetConfig", "messages.GetAvailableReactions"]);
  await assert.rejects(svc.reactionChoices("q1"), /bad chat key/);
  // Premium: premium emoji and the group's custom emoji too, three per message
  svc.me.premium = true;
  svc.reactions._chat.clear();
  assert.deepEqual(await svc.reactionChoices("t5"), { list: [e("🔥"), e("👍"), e("🐳"), { t: "custom", id: "88" }], max: 3 });
  chatReactions = new Api.ChatReactionsNone();
  svc.reactions._chat.clear();
  assert.deepEqual((await svc.reactionChoices("t5")).list, []);
});

test("choicesOf: ChatReactionsAll is Telegram's whole list", () => {
  const c = choicesOf({ avail: AVAIL, chatReactions: new Api.ChatReactionsAll({ allowCustom: true }), def: RE("🔥") });
  assert.deepEqual(c.list.map((x) => x.e), ["🔥", "👍", "❤"]);
});

// ------------------------------------------------------------------ custom emoji pictures
test("custom emoji: a static sticker is downloaded once into the media cache; Lottie without a thumbnail has none", async () => {
  I18N.setLanguage("tr");
  const docs = {
    11: new Api.Document({ id: big(11), accessHash: big(1), fileReference: Buffer.alloc(0), date: 0, mimeType: "image/webp", size: big(900), dcId: 2, attributes: [] }),
    12: new Api.Document({ id: big(12), accessHash: big(1), fileReference: Buffer.alloc(0), date: 0, mimeType: "application/x-tgsticker", size: big(5000), dcId: 2, attributes: [], thumbs: [new Api.PhotoPathSize({ type: "j", bytes: Buffer.from([1]) })] }),
    13: new Api.Document({ id: big(13), accessHash: big(1), fileReference: Buffer.alloc(0), date: 0, mimeType: "video/webm", size: big(9000), dcId: 2, attributes: [], thumbs: [new Api.PhotoSize({ type: "m", w: 100, h: 100, size: 600 })] }),
  };
  const asked = [];
  const downloads = [];
  const svc = service({
    invoke: async (req) => {
      assert.ok(req instanceof Api.messages.GetCustomEmojiDocuments);
      asked.push(req.documentId.map(String).join());
      return [docs[req.documentId[0].toString()]];
    },
    downloadMedia: async (doc, opts) => {
      downloads.push([doc.id.toString(), opts.thumb || null]);
      return Buffer.from("RIFF0000WEBPVP8 ");
    },
  });
  // main fetches only ids it has itself handed to the renderer (here: through a message record)
  assert.equal(await svc.customEmoji("11"), null);
  assert.deepEqual(asked, []);
  svc.ser(new Api.Message({ id: 50, peerId: peer(sample.BOT), date: 0, message: "x", reactions: mr([[CE("11"), 1], [CE("12"), 1], [CE("13"), 1]]) }), KEY);
  const f = await svc.customEmoji("11");
  assert.equal(fs.readFileSync(f, "utf8"), "RIFF0000WEBPVP8 ");
  assert.equal(await svc.customEmoji("11"), f); // cached: no second request
  assert.equal(await svc.customEmoji("12"), null);
  assert.equal(await svc.customEmoji("12"), null);
  assert.ok(await svc.customEmoji("13")); // animated: its real thumbnail
  assert.deepEqual(asked, ["11", "12", "13"]);
  assert.deepEqual(downloads, [["11", null], ["13", "m"]]);
  await assert.rejects(svc.customEmoji("../x"), /Geçersiz/);
});

// ------------------------------------------------------------------ the renderer's toggle math
test("toggle: on/off, and the oldest choice drops once the per-user limit is reached", () => {
  assert.deepEqual(RX.toggle([], "e:👍", 1), ["e:👍"]);
  assert.deepEqual(RX.toggle(["e:👍"], "e:👍", 1), []);
  assert.deepEqual(RX.toggle(["e:👍"], "e:🔥", 1), ["e:🔥"]); // without Premium a click replaces
  assert.deepEqual(RX.toggle(["e:👍", "e:🔥"], "e:❤", 3), ["e:👍", "e:🔥", "e:❤"]);
  assert.deepEqual(RX.toggle(["e:👍", "e:🔥", "e:❤"], "e:🎉", 3), ["e:🔥", "e:❤", "e:🎉"]);
  assert.deepEqual(RX.toggle(["e:👍", "e:🔥"], "e:👍", 3), ["e:🔥"]);
  assert.deepEqual(RX.mineKeys({ list: [{ t: "emoji", e: "🔥", n: 1, mine: 2 }, { t: "paid", n: 5, mine: 3 }, { t: "custom", id: "9", n: 2, mine: 1 }] }), ["c:9", "e:🔥"]);
});

test("applyMine: counts move by one, chips come and go, the user's photo joins the drawn reactors", () => {
  const rec = {
    canSee: true,
    list: [
      { t: "emoji", e: "👍", n: 2, who: ["9002", "9003"] },
      { t: "emoji", e: "❤", n: 1, mine: 1, who: [ME] },
      { t: "paid", n: 50, mine: 2 },
      { t: "emoji", e: "🔥", n: 9 },
    ],
  };
  // a click on 👍 without Premium: ❤ goes (it was the only one), 👍 grows and shows three photos
  const mine = RX.toggle(RX.mineKeys(rec), "e:👍", 1);
  assert.deepEqual(RX.applyMine(rec, mine, ME), {
    canSee: true,
    list: [
      { t: "emoji", e: "👍", n: 3, mine: 1, who: ["9002", "9003", ME] },
      { t: "paid", n: 50, mine: 2 },
      { t: "emoji", e: "🔥", n: 9 },
    ],
  });
  // a fourth reactor: back to the number
  const four = RX.applyMine({ list: [{ t: "emoji", e: "👍", n: 3, who: ["1", "2", "3"] }] }, ["e:👍"], ME);
  assert.deepEqual(four, { list: [{ t: "emoji", e: "👍", n: 4, mine: 1 }] });
  // a new reaction joins at the end with the user's photo; taking the last one back leaves nothing
  assert.deepEqual(RX.applyMine({ list: [{ t: "emoji", e: "🔥", n: 9 }] }, ["c:77"], ME).list[1], { t: "custom", id: "77", n: 1, mine: 1, who: [ME] });
  assert.equal(RX.applyMine({ list: [{ t: "emoji", e: "👍", n: 1, mine: 1, who: [ME] }] }, [], ME), null);
  assert.equal(RX.applyMine(null, [], ME), null);
});

test("chip helpers: photos only while they cover every reactor; short counts in Turkish", () => {
  I18N.setLanguage("tr");
  assert.equal(RX.showWho({ n: 2, who: ["1", "2"] }), true);
  assert.equal(RX.showWho({ n: 3, who: ["1", "2"] }), false);
  assert.equal(RX.showWho({ n: 4, who: ["1", "2", "3", "4"] }), false);
  assert.equal(RX.showWho({ n: 1 }), false);
  assert.deepEqual([5, 999, 1000, 1234, 12345, 999999, 1500000].map(RX.countLabel), ["5", "999", "1B", "1,2B", "12B", "999B", "1,5M"]);
});

test("reaction counts default to English and follow en → tr → en without reloading", () => {
  const counts = [5, 999, 1000, 1234, 12345, 999999, 1500000];
  const english = ["5", "999", "1K", "1.2K", "12K", "999K", "1.5M"];
  assert.equal(I18N.getLanguage(), "en");
  assert.deepEqual(counts.map(RX.countLabel), english);
  I18N.setLanguage("tr");
  assert.deepEqual(counts.map(RX.countLabel), ["5", "999", "1B", "1,2B", "12B", "999B", "1,5M"]);
  I18N.setLanguage("en");
  assert.deepEqual(counts.map(RX.countLabel), english);
});

// ------------------------------------------------------------------ fixture
test("fixture: reactions toggle in memory with a live event, refused ones throw, custom emoji pictures resolve", async () => {
  I18N.setLanguage("tr");
  const file = path.join(__dirname, "fixtures", "telegram.json");
  const fx = new FixtureService(file, { mediaDir: path.join(TMP, "fx") });
  await fx.start();
  const events = [];
  fx.on("reactions", (x) => events.push(x));
  const before = (await fx.history("t5")).find((m) => m.id === 104).reactions;
  assert.deepEqual(RX.mineKeys(before), ["e:👍"]);
  const after = await fx.react("t5", 104, ["e:🔥"]);
  assert.deepEqual(after.list.slice(0, 2), [
    { t: "emoji", e: "👍", n: 4 },
    { t: "emoji", e: "🔥", n: 3, mine: 1 },
  ]);
  assert.deepEqual(events, [{ key: "t5", id: 104, reactions: after }]);
  assert.deepEqual((await fx.history("t5")).find((m) => m.id === 104).reactions, after);
  await assert.rejects(fx.react("t5", 109, ["e:👍"]), /kullanılamıyor/);
  // every custom emoji in the fixture either has its picture or is the deliberate placeholder case
  const ids = Object.values(fx.data.messages).flat().flatMap((m) => ((m.reactions && m.reactions.list) || []).filter((x) => x.t === "custom").map((x) => x.id));
  assert.ok(ids.length >= 2);
  const pics = await Promise.all(ids.map((id) => fx.customEmoji(id)));
  assert.equal(pics.filter(Boolean).length, 1);
  assert.ok(fs.statSync(pics.find(Boolean)).size > 100);
  assert.ok((await fx.reactionChoices("t5")).list.length > 5);
  assert.ok((await fx.reactionChoices("u7001")).list.length > 5);
  // the reaction scenes point at messages that exist
  for (const [name, sc] of Object.entries(fx.data.scenes).filter(([n]) => n.startsWith("react"))) {
    for (const id of [sc.scroll, sc.react && sc.react.id].filter(Boolean)) assert.ok(fx.data.messages.t5.some((m) => m.id === id), `${name}: ${id}`);
  }
});

// ------------------------------------------------------------------ regressions
/** A tiny stand-in for the renderer's h(): plain objects, enough to find buttons and their handlers. */
const fakeH = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter((k) => k !== null && k !== undefined) });
function rendererCtx({ choicesDelay = 0, msgs = {} } = {}) {
  const calls = { react: [], choices: 0, toasts: [], menus: [] };
  const S = { tg: { status: "open", me: { id: ME, name: "Deniz" } }, msgs: new Map(), avatars: {} };
  for (const [key, list] of Object.entries(msgs)) S.msgs.set(key, new Map(list.map((m) => [m.id, m])));
  const deck = {
    reactionChoices: (key) => {
      calls.choices++;
      return new Promise((resolve) => setTimeout(() => resolve({ list: [{ t: "emoji", e: "👍" }, { t: "emoji", e: "🔥" }], max: 1 }), choicesDelay));
    },
    react: async (key, id, keys) => {
      calls.react.push([key, id, keys]);
      return RX.applyMine(S.msgs.get(key).get(id).reactions, keys, ME);
    },
    emoji: async () => null,
  };
  const ctx = {
    h: fakeH,
    S,
    deck,
    toast: (t) => calls.toasts.push(t),
    person: () => ({}),
    hue: () => "hue-1",
    initial: (x) => x[0],
    mark: () => {},
    msgOf: (key, id) => (S.msgs.get(key) ? S.msgs.get(key).get(Number(id)) || null : null),
    openMenu: (items) => calls.menus.push(items),
    cleanErr: (e) => String(e && e.message),
  };
  return { rx: RX.create(ctx), calls, S };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chipButtons = (node) => (node ? node.kids.filter((k) => k.tag === "button") : []);

test("reaction labels default to English and follow language changes without changing message data", () => {
  const msg = { key: KEY, id: 90, text: "merhaba", reactions: { list: [{ t: "paid", n: 2 }, { t: "custom", id: "77", n: 1 }] } };
  const before = JSON.stringify(msg);
  const { rx } = rendererCtx({ msgs: { [KEY]: [msg] } });
  assert.equal(I18N.getLanguage(), "en");
  assert.deepEqual(chipButtons(rx.chips(msg)).map((el) => el.attrs.title), ["2 stars", "Custom emoji · 1"]);
  I18N.setLanguage("tr");
  assert.deepEqual(chipButtons(rx.chips(msg)).map((el) => el.attrs.title), ["2 yıldız", "Özel emoji · 1"]);
  I18N.setLanguage("en");
  assert.equal(rx.menuItem(msg, {}).label, "React");
  assert.equal(JSON.stringify(msg), before);
});

test("safety: a double click while the chat's choices load sends one SendReaction, not two", async () => {
  const msg = { key: "t5", id: 104, reactions: { list: [{ t: "emoji", e: "🔥", n: 2 }] } };
  const { rx, calls } = rendererCtx({ choicesDelay: 120, msgs: { t5: [msg] } });
  const first = rx.react("t5", 104, "e:🔥");
  await sleep(30);
  // the second click lands while the first still waits for reactionChoices
  const second = rx.react("t5", 104, "e:🔥");
  // and the chips are already disabled
  assert.ok(chipButtons(rx.chips(msg)).every((b) => b.attrs.disabled === true));
  await Promise.all([first, second]);
  assert.equal(calls.react.length, 1);
  assert.deepEqual(calls.react[0], ["t5", 104, ["e:🔥"]]);
  assert.equal(calls.choices, 1);
  // after it settles a new click works again (and takes the reaction back)
  await rx.react("t5", 104, "e:🔥");
  assert.deepEqual(calls.react[1], ["t5", 104, []]);
});

test("explicit click only: chips and picker items write only on a trusted click, never on a scripted one", async () => {
  const msg = { key: "u7001", id: 206, reactions: { list: [{ t: "emoji", e: "👌", n: 1 }] } };
  const { rx, calls } = rendererCtx({ msgs: { u7001: [msg] } });
  const [chip] = chipButtons(rx.chips(msg));
  const ev = (isTrusted) => ({ isTrusted, stopPropagation() {} });
  chip.attrs.onclick(ev(false)); // element.click() / dispatchEvent from a script
  await sleep(10);
  assert.equal(calls.react.length, 0);
  // a held Enter does not repeat the toggle
  let prevented = false;
  chip.attrs.onkeydown({ key: "Enter", repeat: true, preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  chip.attrs.onclick(ev(true)); // a real click (mouse, or Enter/Space on the focused chip)
  await sleep(10);
  assert.deepEqual(calls.react, [["u7001", 206, ["e:👌"]]]);
  // the picker: building and opening it writes nothing; only a trusted click on an item does
  await rx.openPicker(msg, { isConnected: true }, { x: 0, y: 0 });
  assert.equal(calls.react.length, 1);
  const items = calls.menus[0];
  assert.deepEqual(items.map((i) => i.title), ["👍", "🔥"]);
  items[1].run(); // keyboard handlers or scenes calling run() without an event
  items[1].run(ev(false));
  await sleep(10);
  assert.equal(calls.react.length, 1);
  items[1].run(ev(true));
  await sleep(10);
  assert.deepEqual(calls.react[1], ["u7001", 206, ["e:🔥"]]);
  // rendering chips for a message with reactions never writes
  rx.chips(msg);
  rx.update({ key: "u7001", id: 206, reactions: { list: [{ t: "emoji", e: "👌", n: 5 }] } });
  rx.chips(msg);
  assert.equal(calls.react.length, 2);
});

/**
 * Just enough DOM to run the real renderer/msgview.js (with the real renderer/reactions.js) in a vm:
 * elements with listeners, bubbling, focus and "button:not(:disabled)". press() models Chromium's
 * default action for Enter on a focused button: a trusted click, fired on keydown unless the keydown
 * was cancelled (held keys send more keydowns with repeat: true; Space would click on keyup instead).
 */
function fakeDom() {
  const doc = { activeElement: null, listeners: {} };
  class El {
    constructor(tag) {
      Object.assign(this, { tag, kids: [], listeners: {}, attrs: {}, dataset: {}, parentElement: null, className: "", scrollTop: 0, offsetWidth: 0, offsetHeight: 0, isConnected: true });
      this.style = { setProperty() {} };
      this.classList = { contains: (c) => this.className.split(" ").includes(c), add() {}, remove() {}, toggle() {} };
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
    setAttribute(k, v) {
      this.attrs[k] = v;
    }
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    }
    get disabled() {
      return "disabled" in this.attrs;
    }
    appendChild(c) {
      if (c instanceof El) c.parentElement = this;
      this.kids.push(c);
      return c;
    }
    insertBefore(c) {
      return this.appendChild(c);
    }
    replaceChildren(...c) {
      this.kids = [];
      c.forEach((x) => this.appendChild(x));
    }
    remove() {
      if (this.parentElement) this.parentElement.kids = this.parentElement.kids.filter((k) => k !== this);
      this.parentElement = null;
    }
    contains(x) {
      for (let p = x; p; p = p.parentElement) if (p === this) return true;
      return false;
    }
    closest() {
      return null;
    }
    all() {
      return this.kids.filter((k) => k instanceof El).flatMap((k) => [k, ...k.all()]);
    }
    querySelectorAll(sel) {
      if (sel === "button:not(:disabled)") return this.all().filter((k) => k.tag === "button" && !k.disabled);
      if (sel === ".ctx-react") return this.all().filter((k) => k.classList.contains("ctx-react"));
      return [];
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 300, height: 40, bottom: 40, right: 300 };
    }
    focus() {
      doc.activeElement = this;
    }
    get text() {
      return this.kids.map((k) => (k instanceof El ? k.text : k && typeof k === "object" && "textContent" in k ? k.textContent : String(k))).join("");
    }
  }
  const dispatch = (target, ev) => {
    ev.target = target;
    for (let p = target; p && !ev.stopped; p = p.parentElement) for (const fn of p.listeners[ev.type] || []) fn.call(p, ev);
    if (!ev.stopped) for (const fn of doc.listeners[ev.type] || []) fn(ev);
    return ev;
  };
  const event = (type, extra = {}) => ({
    type,
    isTrusted: true,
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    ...extra,
  });
  /** One keydown on whatever has focus, with the browser's default action for Enter on a button. */
  function press(key, extra = {}) {
    const t = doc.activeElement;
    const ev = dispatch(t, event("keydown", { key, repeat: false, shiftKey: false, ...extra }));
    if (!ev.defaultPrevented && key === "Enter" && t.tag === "button" && !t.disabled) dispatch(t, event("click", { clientX: 0, clientY: 0 }));
  }
  Object.assign(doc, {
    body: new El("body"),
    createElement: (tag) => new El(tag),
    createTextNode: (t) => ({ textContent: String(t) }),
    getElementById: () => new El("section"),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => (doc.listeners[type] = doc.listeners[type] || []).push(fn),
  });
  return { doc, El, press };
}

test("explicit click only: a held Enter on 'Tepki ver' opens the picker and never clicks its first item", async () => {
  I18N.setLanguage("tr");
  const { doc, El, press } = fakeDom();
  const box = {
    DeckI18n: I18N,
    document: doc,
    innerWidth: 1200,
    innerHeight: 800,
    CSS: { escape: (s) => s },
    navigator: {},
    getSelection: () => ({ isCollapsed: true }),
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
    },
    setTimeout,
    clearTimeout,
    console,
  };
  box.window = box;
  box.addEventListener = () => {};
  vm.createContext(box);
  for (const f of ["reactions.js", "msgview.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "renderer", f), "utf8"), box, { filename: f });
  // the real h() of renderer/app.js, minus SVG
  const h = (tag, attrs, ...kids) => {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "style") continue;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.appendChild(typeof c === "number" ? String(c) : c);
    return el;
  };
  const msg = { key: "u7001", id: 206, text: "merhaba", reactions: { list: [{ t: "emoji", e: "👌", n: 1 }] } };
  const S = { tg: { status: "open", me: { id: ME, name: "Deniz" }, bots: [] }, msgs: new Map([["u7001", new Map([[206, msg]])]]), people: {}, avatars: {} };
  const reacted = [];
  const deck = {
    reactionChoices: async () => ({ list: [{ t: "emoji", e: "👍" }, { t: "emoji", e: "🔥" }], max: 1 }),
    react: async (key, id, keys) => {
      reacted.push([key, id, JSON.parse(JSON.stringify(keys))]); // keys is an array of the vm's realm
      return box.DeckReactions.applyMine(msg.reactions, keys, ME);
    },
    emoji: async () => null,
  };
  const els = { msgs: new El("div"), msgsInner: new El("div"), input: new El("textarea") };
  els.msgs.appendChild(els.msgsInner);
  const composer = new El("div");
  new El("main").appendChild(composer);
  els.input.closest = () => composer;
  const MV = box.DeckMsgView.create({ h, S, deck, els, renderText: () => [], hm: () => "", mediaLabel: () => "", cleanErr: (e) => String(e && e.message), mark: () => {} });
  assert.ok(MV.openMenu);
  const bubble = new El("div");
  bubble.className = "msg";
  bubble.dataset.fk = "msg:u7001:206";
  els.msgsInner.appendChild(bubble);
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const picker = () => doc.body.querySelector(".ctx-react");

  // the message menu from the keyboard (Shift+F10), down to "Tepki ver", one Enter: the picker opens
  bubble.focus();
  press("F10", { shiftKey: true });
  assert.equal(doc.activeElement.text, "Yanıtla");
  press("ArrowDown");
  assert.equal(doc.activeElement.text, "Tepki ver");
  press("Enter");
  await settle();
  assert.ok(picker(), "the picker opens");
  assert.equal(doc.activeElement.attrs.title, "👍"); // focus sits on Telegram's default reaction
  // the same Enter is still held: its repeats land on 👍 and must not click it
  for (let i = 0; i < 5; i++) press("Enter", { repeat: true });
  press(" ", { repeat: true });
  await settle();
  assert.deepEqual(reacted, []);
  assert.ok(picker(), "the picker stays open");
  // a fresh press on the focused item is the user's choice and does write
  press("Enter");
  await settle();
  assert.deepEqual(reacted, [["u7001", 206, ["e:👍"]]]);
  assert.equal(picker(), null);
});

test("safety: tg:emoji downloads only custom emoji main has handed out (records or the picker)", async () => {
  const asked = [];
  const doc = (id) => new Api.Document({ id: big(id), accessHash: big(1), fileReference: Buffer.alloc(0), date: 0, mimeType: "image/webp", size: big(900), dcId: 2, attributes: [] });
  const svc = service({
    invoke: async (req) => {
      if (req instanceof Api.messages.GetCustomEmojiDocuments) {
        asked.push(req.documentId[0].toString());
        return [doc(req.documentId[0].toString())];
      }
      if (req instanceof Api.messages.GetAvailableReactions) return new Api.messages.AvailableReactions({ hash: 1, reactions: AVAIL });
      if (req instanceof Api.help.GetConfig) return {};
      if (req instanceof Api.channels.GetFullChannel) return { fullChat: { availableReactions: new Api.ChatReactionsSome({ reactions: [CE("31")] }) } };
      throw new Error(`unexpected ${req.className}`);
    },
    downloadMedia: async () => Buffer.from("RIFF0000WEBPVP8 "),
  });
  svc.mediaDir = path.join(TMP, "media-allow");
  for (const id of ["21", "31", "41"]) assert.equal(await svc.customEmoji(id), null);
  assert.deepEqual(asked, []);
  // a live update hands out 21; the Premium picker of t5 hands out 31
  svc._onRaw(new Api.UpdateMessageReactions({ peer: peer(sample.BOT), msgId: 3, reactions: mr([[CE("21"), 2]]) }));
  svc.me.premium = true;
  await svc.reactionChoices("t5");
  assert.ok(await svc.customEmoji("21"));
  assert.ok(await svc.customEmoji("31"));
  assert.equal(await svc.customEmoji("41"), null);
  assert.deepEqual(asked, ["21", "31"]);
});

test("safety: every Telegram IPC handler (send, callback, reactions, topics, history, read) checks the sender frame", () => {
  // main.js registers every main-window channel through ipc-guard's appIpc (security audit L4): a foreign frame
  // is refused before the handler runs. test/ipc-guard.test.js checks that at runtime for every channel; here
  // the source keeps no direct ipcMain registration a new tg:* channel could slip in through.
  const src = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  assert.deepEqual(src.match(/\bipcMain\.(handle|on)\(/g), null, "main.js registers channels only through ipc.handle / ipc.on");
  const seen = [...src.matchAll(/\bipc\.(?:handle|on)\("(tg:[^"]+)"/g)].map((m) => m[1]);
  for (const ch of ["tg:send", "tg:callback", "tg:reaction-choices", "tg:react", "tg:emoji", "tg:topic", "tg:history", "tg:read", "tg:media", "tg:media-open", "tg:media-save", "tg:login-start", "tg:login-answer", "tg:login-cancel", "tg:logout", "tg:retry"]) {
    assert.ok(seen.includes(ch), ch);
  }
});

test("safety: the sender check rejects foreign frames and lets only the Deck's own page through", () => {
  const { isApp } = require("../main/ipc-guard");
  assert.equal(isApp({ senderFrame: { url: "deck://app/index.html" } }), true);
  assert.equal(isApp({ senderFrame: { url: "deck://app/index.html#x" } }), true);
  for (const url of ["https://example.com/", "deck://pet/index.html", "deck://app/pet.html", "deck://app/botbar.html", "file:///x/deck://app/index.html", ""]) {
    assert.equal(isApp({ senderFrame: { url } }), false, url);
  }
  assert.equal(isApp({ senderFrame: { url: "deck://app/index.html", parent: {} } }), false, "a sub-frame");
  assert.equal(isApp({}), false);
  assert.equal(isApp(null), false);
});

test("live updates: the user's own reactions survive a run of 'min' updates (DM and forum topic)", () => {
  for (const [key, peerOf] of [
    [KEY, () => peer(sample.BOT)],
    ["t5", () => new Api.PeerChannel({ channelId: big(sample.GROUP_CHANNEL) })],
  ]) {
    const svc = service({});
    const got = [];
    svc.on("reactions", (x) => got.push(x));
    const replyTo = key === "t5" ? new Api.MessageReplyHeader({ forumTopic: true, replyToMsgId: 5, replyToTopId: 5 }) : undefined;
    svc._remember(key, new Api.Message({ id: 80, peerId: peerOf(), date: 0, message: "x", replyTo, reactions: mr([[RE("👍"), 1, 0]]) }));
    const up = (results) => svc._onRaw(new Api.UpdateMessageReactions({ peer: peerOf(), msgId: 80, topMsgId: key === "t5" ? 5 : undefined, reactions: mr(results, [], { min: true }) }));
    up([[RE("👍"), 2]]);
    up([[RE("👍"), 3], [RE("🔥"), 1]]);
    up([[RE("👍"), 4], [RE("🔥"), 1]]);
    assert.deepEqual(
      got.map((x) => x.key),
      [key, key, key]
    );
    assert.deepEqual(got[2].reactions, { list: [{ t: "emoji", e: "👍", n: 4, mine: 1 }, { t: "emoji", e: "🔥", n: 1 }] }, key);
    // an edit that arrives with min reactions keeps them too (the raw copy is replaced)
    const edits = [];
    svc.on("edit", (x) => edits.push(x));
    svc._onEdit({ message: new Api.Message({ id: 80, peerId: peerOf(), date: 0, editDate: 9, message: "y", replyTo, reactions: mr([[RE("👍"), 4]], [], { min: true }) }) });
    assert.deepEqual(edits[0].reactions, { list: [{ t: "emoji", e: "👍", n: 4, mine: 1 }] }, key);
    assert.equal(edits[0].key, key);
  }
});

test("live updates: a min update for a message main no longer holds is flagged; the renderer keeps its own marks", () => {
  const svc = service({});
  const got = [];
  svc.on("reactions", (x) => got.push(x));
  svc._onRaw(new Api.UpdateMessageReactions({ peer: peer(sample.BOT), msgId: 90, reactions: mr([[RE("👍"), 3], [RE("🔥"), 1]], [], { min: true }) }));
  assert.deepEqual(got[0].reactions, { list: [{ t: "emoji", e: "👍", n: 3 }, { t: "emoji", e: "🔥", n: 1 }], min: true });
  const msg = { key: KEY, id: 90, reactions: { list: [{ t: "emoji", e: "👍", n: 2, mine: 1 }] } };
  const { rx } = rendererCtx({ msgs: { [KEY]: [msg] } });
  assert.equal(rx.update(got[0]), true);
  assert.deepEqual(msg.reactions, { list: [{ t: "emoji", e: "👍", n: 3, mine: 1 }, { t: "emoji", e: "🔥", n: 1 }] });
  // a complete (non-min) update is taken as it is: the user took 👍 back elsewhere
  rx.update({ key: KEY, id: 90, reactions: { list: [{ t: "emoji", e: "👍", n: 2 }] } });
  assert.deepEqual(msg.reactions, { list: [{ t: "emoji", e: "👍", n: 2 }] });
  // keepMine/carryMine leave complete data alone
  assert.equal(RX.keepMine({ list: [] }, null), null);
  const full = mr([[RE("👍"), 1]]);
  assert.equal(carryMine(full, mr([[RE("👍"), 1, 0]])).results[0].chosenOrder, undefined);
});
