"use strict";
// main/telegram.js on teleproto (MTProto layer 229), checked offline: media and button serializers, Bot API
// rich messages, forum topic calls, callbacks, media refs, partial rich messages, the session check and
// session-string compatibility with GramJS. Fake clients only; a guard fails the run if anything here
// opens a socket or resolves a host name, so no test can reach Telegram.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const tls = require("tls");
const dns = require("dns");

const blocked = (what) =>
  function () {
    throw new Error(`network use in a test: ${what}`);
  };
net.connect = net.createConnection = blocked("net.connect");
net.Socket.prototype.connect = blocked("net.Socket.connect");
tls.connect = blocked("tls.connect");
dns.lookup = blocked("dns.lookup");

const { Api, helpers } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
const { TelegramService, mediaInfo, buttonRows, replyOf, richOf, mediaOf, REF_RE } = require("../main/telegram");
const { FixtureService } = require("../main/fixture");
const sample = require("./rich-sample");
const { setLanguage } = require("../renderer/i18n");
setLanguage("tr");

const big = helpers.returnBigInt;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "deck-telegram-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const GROUP_ID = `-100${sample.GROUP_CHANNEL}`;
const channel = (extra = {}) => new Api.Channel({ id: big(sample.GROUP_CHANNEL), accessHash: big(77), title: "Atölye", photo: new Api.ChatPhotoEmpty(), date: 0, forum: true, megagroup: true, ...extra });
const bot = () => new Api.User({ id: big(sample.BOT), accessHash: big(5), bot: true, firstName: "Atlas", username: "atlas_ornek_bot" });

/** A service wired to a fake client: the bot DM and the group are known, nothing is connected. */
function service(client = {}, opts = {}) {
  const svc = new TelegramService({ apiId: 1, apiHash: "x", groupChatId: GROUP_ID, mediaDir: path.join(TMP, "media"), ...opts });
  svc.client = client;
  svc.bots.set(sample.BOT, { key: `u${sample.BOT}`, entity: bot() });
  svc.group = channel({ creator: true });
  svc.state = { group: { id: GROUP_ID, title: "Atölye", canManage: true, canDelete: true }, topics: [] };
  return svc;
}

const KEY = `u${sample.BOT}`;
const rpcError = (msg, code = 400) => Object.assign(new Error(msg), { errorMessage: msg, code });

// ------------------------------------------------------------------ media, buttons, replies
test("media: photos, documents and the kinds the renderer draws", () => {
  const photo = new Api.Photo({
    id: big(5),
    accessHash: big(1),
    fileReference: Buffer.alloc(0),
    date: 0,
    dcId: 2,
    sizes: [
      new Api.PhotoStrippedSize({ type: "i", bytes: Buffer.from([1, 2, 3]) }),
      new Api.PhotoSize({ type: "m", w: 320, h: 213, size: 12000 }),
      new Api.PhotoSizeProgressive({ type: "y", w: 1280, h: 853, sizes: [1000, 50000, 120000] }),
    ],
  });
  const m = new Api.Message({ id: 10, peerId: new Api.PeerUser({ userId: big(7) }), date: 0, message: "", media: new Api.MessageMediaPhoto({ photo, spoiler: true }) });
  assert.deepEqual(mediaInfo(m), { kind: "photo", w: 1280, h: 853, size: 120000, thumb: true, spoiler: true });

  const doc = (attrs, mime, extra = {}) => new Api.Document({ id: big(9), accessHash: big(1), fileReference: Buffer.alloc(0), date: 0, mimeType: mime, size: big(34567), dcId: 2, attributes: attrs, ...extra });
  m.media = new Api.MessageMediaDocument({ document: doc([new Api.DocumentAttributeAudio({ voice: true, duration: 12 })], "audio/ogg") });
  assert.deepEqual(mediaInfo(m), { kind: "voice", mime: "audio/ogg", size: 34567, dur: 12 });
  m.media = new Api.MessageMediaDocument({ document: doc([new Api.DocumentAttributeFilename({ fileName: "rapor.pdf" })], "application/pdf", { thumbs: [new Api.PhotoSize({ type: "m", w: 320, h: 320, size: 900 })] }) });
  assert.deepEqual(mediaInfo(m), { kind: "file", mime: "application/pdf", name: "rapor.pdf", size: 34567, thumb: true });
  m.media = new Api.MessageMediaDocument({ document: doc([new Api.DocumentAttributeVideo({ duration: 24.6, w: 1280, h: 720 })], "video/mp4") });
  assert.equal(mediaInfo(m).kind, "video");
  assert.equal(mediaInfo(m).dur, 25);
  m.media = new Api.MessageMediaDocument({ document: doc([new Api.DocumentAttributeVideo({ roundMessage: true, duration: 5, w: 240, h: 240 })], "video/mp4") });
  assert.equal(mediaInfo(m).kind, "round");
  m.media = new Api.MessageMediaDocument({ document: doc([new Api.DocumentAttributeImageSize({ w: 512, h: 512 }), new Api.DocumentAttributeSticker({ alt: "👍", stickerset: new Api.InputStickerSetEmpty() })], "image/webp") });
  assert.deepEqual(mediaInfo(m), { kind: "sticker", mime: "image/webp", size: 34567, w: 512, h: 512, alt: "👍" });
  m.media = new Api.MessageMediaUnsupported();
  assert.deepEqual(mediaInfo(m), { kind: "unsupported" });
  m.media = new Api.MessageMediaPoll({ poll: new Api.Poll({ id: big(1), question: new Api.TextWithEntities({ text: "Hangisi?", entities: [] }), answers: [] }), results: new Api.PollResults({}) });
  assert.deepEqual(mediaInfo(m), { kind: "poll", title: "Hangisi?" });
  m.media = new Api.MessageMediaWebPage({ webpage: new Api.WebPageEmpty({ id: big(1) }) });
  assert.equal(mediaInfo(m), null);
  m.media = new Api.MessageMediaPhoto({ ttlSeconds: 10 });
  assert.deepEqual(mediaInfo(m), { kind: "photo", gone: true });
});

test("inline keyboards: layer 229 buttons keep their kind in .type and their colour in .style", () => {
  const btn = (text, type, style) => new Api.KeyboardInlineButton({ text, type, style });
  const m = new Api.Message({
    id: 3,
    peerId: new Api.PeerUser({ userId: big(7) }),
    date: 0,
    message: "x",
    replyMarkup: new Api.ReplyInlineMarkup({
      rows: [
        new Api.KeyboardInlineButtonRow({
          buttons: [
            btn("Aç", new Api.InlineButtonTypeUrl({ url: "https://example.org" })),
            btn("Onayla", new Api.InlineButtonTypeCallback({ data: Buffer.from("ok") }), new Api.KeyboardButtonStyle({ bgSuccess: true })),
          ],
        }),
        new Api.KeyboardInlineButtonRow({
          buttons: [
            btn("Kodu kopyala", new Api.InlineButtonTypeCopy({ copyText: "XYZ" })),
            btn("Uygulama", new Api.InlineButtonTypeWebView({ url: "https://example.org/app" })),
            btn("Gizli", new Api.InlineButtonTypeCallback({ data: Buffer.from("x"), requiresPassword: true }), new Api.KeyboardButtonStyle({ bgDanger: true })),
          ],
        }),
        new Api.KeyboardInlineButtonRow({ buttons: [btn("Giriş", new Api.InlineButtonTypeUrlAuth({ url: "https://example.org/login", buttonId: 1 })), btn("Paylaş", new Api.InlineButtonTypeSwitchInline({ query: "" }))] }),
        new Api.KeyboardInlineButtonRow({ buttons: [] }),
      ],
    }),
  });
  assert.deepEqual(buttonRows(m), [
    [
      { t: "url", text: "Aç", url: "https://example.org" },
      { t: "cb", text: "Onayla", tone: "success" },
    ],
    [
      { t: "copy", text: "Kodu kopyala", copy: "XYZ" },
      { t: "app", text: "Uygulama" },
      { t: "other", text: "Gizli", tone: "danger" },
    ],
    [
      { t: "url", text: "Giriş", url: "https://example.org/login" },
      { t: "other", text: "Paylaş" },
    ],
  ]);
  m.replyMarkup = new Api.ReplyKeyboardMarkup({ rows: [] });
  assert.equal(buttonRows(m), null);
});

test("replies: same-chat replies only; a plain post in a topic is not a reply", () => {
  const m = new Api.Message({ id: 50, peerId: new Api.PeerChannel({ channelId: big(3) }), date: 0, message: "" });
  m.replyTo = new Api.MessageReplyHeader({ forumTopic: true, replyToMsgId: 5 });
  assert.deepEqual(replyOf(m), { id: null, quote: null });
  m.replyTo = new Api.MessageReplyHeader({ forumTopic: true, replyToMsgId: 42, replyToTopId: 5, quote: true, quoteText: "alıntı" });
  assert.deepEqual(replyOf(m), { id: 42, quote: "alıntı" });
  m.replyTo = new Api.MessageReplyHeader({ replyToMsgId: 41 });
  assert.deepEqual(replyOf(m), { id: 41, quote: null });
  m.replyTo = new Api.MessageReplyHeader({ replyToMsgId: 41, replyToPeerId: new Api.PeerChannel({ channelId: big(4) }) });
  assert.deepEqual(replyOf(m), { id: null, quote: null });
});

// ------------------------------------------------------------------ rich messages
test("rich text: styles become entity ranges in UTF-16 units, nested ones inside first", () => {
  const { T, C, B, I } = sample;
  const p = (text) => new Api.RichMessage({ blocks: [new Api.PageBlockParagraph({ text })], photos: [], documents: [] });
  const one = (rm) => richOf(rm).view.blocks[0].text;

  assert.deepEqual(one(p(C("🙂 ", B(I("merhaba")), "!"))), {
    text: "🙂 merhaba!",
    ents: [
      { t: "MessageEntityItalic", o: 3, l: 7 },
      { t: "MessageEntityBold", o: 3, l: 7 },
    ],
  });
  // links: only http(s) become links; anything else keeps its text
  assert.deepEqual(one(p(new Api.TextUrl({ text: T("site"), url: "https://example.org/a", webpageId: big(0) }))), { text: "site", ents: [{ t: "MessageEntityTextUrl", o: 0, l: 4, url: "https://example.org/a" }] });
  assert.deepEqual(one(p(new Api.TextUrl({ text: T("betik"), url: "javascript:alert(1)", webpageId: big(0) }))), { text: "betik" });
  assert.deepEqual(one(p(new Api.TextAutoUrl({ text: T("https://example.org") }))), { text: "https://example.org", ents: [{ t: "MessageEntityUrl", o: 0, l: 19 }] });
  // buttons inside text: a web link stays a link, anything else is a label that only works in Telegram
  assert.deepEqual(one(p(new Api.TextButton({ text: T("Aç"), type: new Api.InlineButtonTypeUrl({ url: "https://example.org" }) }))), { text: "Aç", ents: [{ t: "MessageEntityTextUrl", o: 0, l: 2, url: "https://example.org" }] });
  assert.deepEqual(one(p(new Api.TextButton({ text: T("Bas"), type: new Api.InlineButtonTypeCallback({ data: Buffer.from("x") }) }))), { text: "Bas", ents: [{ t: "RichButton", o: 0, l: 3 }] });
  // the rest: custom emoji as their alt, math as code, mentions and dates as their text
  assert.deepEqual(one(p(C(new Api.TextCustomEmoji({ documentId: big(1), alt: "⭐" }), " ", new Api.TextMath({ source: "x^2" }), " ", new Api.TextMentionName({ text: T("Mira"), userId: big(9001) }), " ", new Api.TextDate({ text: T("yarın"), date: 0 })))), {
    text: "⭐ x^2 Mira yarın",
    ents: [{ t: "MessageEntityCode", o: 2, l: 3 }],
  });
  const img = richOf(p(C("a ", new Api.TextImage({ documentId: big(1), w: 16, h: 16 }), " b")));
  assert.equal(img.view.gaps, 1);
  assert.deepEqual(img.view.blocks[0].text.ents, [{ t: "RichGap", o: 2, l: 8 }]);
  // an empty paragraph produces no block
  assert.deepEqual(richOf(p(new Api.TextEmpty())).view.blocks, []);
});

test("rich blocks: the week plan as headings, lists, a table, code, quote, details, reasoning and buttons", () => {
  const { view, plain } = richOf(sample.planMessage().richMessage);
  assert.deepEqual(
    view.blocks.map((b) => b.t),
    ["kicker", "h", "p", "ul", "h", "table", "ol", "pre", "quote", "details", "think", "hr", "buttons", "footer"]
  );
  const [, h2, para, checklist, , table, steps, code, quote, details, think, , buttons] = view.blocks;
  assert.deepEqual(h2, { t: "h", n: 2, text: { text: "Haftalık bakım planı" } });
  assert.deepEqual(
    para.text.ents.map((e) => [e.t, para.text.text.slice(e.o, e.o + e.l)]),
    [
      ["MessageEntityBold", "üç sensör"],
      ["MessageEntityItalic", "S-02"],
      ["MessageEntityCode", "PB-12"],
      ["MessageEntityTextUrl", "rapor sayfasında"],
      ["RichMarked", "Kesinti en fazla 2 saat."],
      ["MessageEntitySpoiler", "4417"],
    ]
  );
  assert.deepEqual(checklist.items.map((it) => it.check), [true, false, false]);
  assert.equal(table.bordered, true);
  assert.deepEqual(table.rows[0][1], { text: { text: "Sensör" }, head: true, align: "center" });
  assert.equal(table.rows.length, 4);
  assert.deepEqual(steps.items.map((it) => it.text.text), ["Sahaya 07:00'de çık.", "Ölçümü kaydet.", "Raporu bu sohbete yükle."]);
  assert.deepEqual(code, { t: "pre", code: "deck-export --hafta 41 --format csv", lang: "bash" });
  assert.equal(quote.caption.text, "Bakım kılavuzu");
  assert.equal(details.open, undefined);
  assert.equal(details.blocks[0].t, "p");
  assert.equal(think.t, "think");
  assert.deepEqual(buttons, {
    t: "buttons",
    row: 0,
    buttons: [
      { t: "cb", text: "Planı onayla", tone: "success" },
      { t: "url", text: "Raporu aç", url: "https://example.org/rapor" },
      { t: "copy", text: "Kodu kopyala", copy: "SAHA-41" },
    ],
  });
  assert.equal(view.gaps, undefined);
  assert.equal(view.part, undefined);
  // plain text for previews and copying: content in reading order, the bot's reasoning left out
  assert.match(plain, /^Saha raporu · 41\. hafta\nHaftalık bakım planı\nBu hafta üç sensör/);
  assert.match(plain, /• ☑ Kalibrasyon kontrolü\n• ☐ S-02 pil değişimi/);
  assert.match(plain, /Salı \| S-01 \| Kalibrasyon/);
  assert.match(plain, /1\. Sahaya 07:00'de çık\./);
  assert.doesNotMatch(plain, /Kullanıcı tablo istedi/);
});

test("rich media: refs into the message's photos and documents, galleries, maps and gaps", () => {
  const m = sample.photosMessage();
  const { view, plain } = richOf(m.richMessage);
  const [, ph, gallery, file, map, gap, para] = view.blocks;
  assert.deepEqual(ph, { t: "media", ref: "p0", media: { kind: "photo", w: 800, h: 524, size: 48000, thumb: true }, caption: { text: "Kuzey sırtı, 07:40 — Mira Kestane" } });
  assert.deepEqual(gallery.items.map((x) => x.ref), ["p1", "p2"]);
  assert.equal(gallery.caption.text, "Ölçüm noktaları");
  assert.deepEqual(file.media, { kind: "file", mime: "text/csv", name: "olcum-41.csv", size: 67 });
  assert.equal(file.ref, "d0");
  assert.deepEqual(map, { t: "map", lat: 40.01234, long: 32.98765, zoom: 15, caption: { text: "Ölçüm alanı" } });
  assert.deepEqual(gap, { t: "gap" });
  assert.equal(para.text.text, "Rota işareti [görsel] haritada.");
  assert.equal(view.gaps, 2); // the unsupported block and the inline picture
  assert.match(plain, /\[fotoğraf\] Kuzey sırtı/);
  assert.match(plain, /\[dosya\] Ham veriler/);

  // refs resolve against the stored message; anything else is refused
  assert.equal(mediaOf(m, "p1").photo.id.toString(), "5102");
  assert.equal(mediaOf(m, "d0").document.id.toString(), "5201");
  assert.equal(mediaOf(m, "p9"), null);
  assert.equal(mediaOf(m, "x1"), null);
  assert.equal(mediaOf(m, "p01x"), null);
  assert.equal(mediaOf(m, null), null); // a rich message has no media of its own
  assert.ok(REF_RE.test("d12") && !REF_RE.test("d1234") && !REF_RE.test("../p1"));

  // a block pointing at a photo the message did not carry
  const lost = new Api.RichMessage({ blocks: [new Api.PageBlockPhoto({ photoId: big(1), caption: new Api.PageCaption({ text: new Api.TextEmpty(), credit: new Api.TextEmpty() }) })], photos: [], documents: [] });
  assert.deepEqual(richOf(lost).view.blocks[0], { t: "media", media: { kind: "photo", gone: true } });
});

test("rich limits: deep nesting and huge messages are cut, never thrown", () => {
  let deep = new Api.PageBlockParagraph({ text: sample.T("en içte") });
  for (let i = 0; i < 60; i++) deep = new Api.PageBlockBlockquoteBlocks({ blocks: [deep], caption: new Api.TextEmpty() });
  const d = richOf(new Api.RichMessage({ blocks: [deep], photos: [], documents: [] }));
  assert.equal(d.view.cut, true);

  const many = Array.from({ length: 1500 }, (_, i) => new Api.PageBlockParagraph({ text: sample.T(`satır ${i}`) }));
  const w = richOf(new Api.RichMessage({ blocks: many, photos: [], documents: [] }));
  assert.equal(w.view.cut, true);
  assert.ok(w.view.blocks.length <= 600);
  assert.ok(w.plain.length <= 8000);

  const long = richOf(new Api.RichMessage({ blocks: [new Api.PageBlockParagraph({ text: sample.T("x".repeat(50000)) }), new Api.PageBlockParagraph({ text: sample.T("sonra") })], photos: [], documents: [] }));
  assert.equal(long.view.cut, true);
  assert.equal(long.view.blocks.length, 1);
});

test("ser: a rich message fills text with its plain form, carries the blocks and its inline keyboard", () => {
  const svc = service();
  const rec = svc.ser(sample.planMessage(), KEY);
  assert.equal(rec.from, "Atlas");
  assert.equal(rec.fromBot, true);
  assert.deepEqual(rec.ents, []);
  assert.equal(rec.media, null);
  assert.match(rec.text, /^Saha raporu · 41\. hafta\nHaftalık bakım planı/);
  assert.equal(rec.rich.blocks.length, 14);
  assert.deepEqual(rec.buttons, [[{ t: "cb", text: "Ertele", tone: "danger" }]]);

  // Telegram's own text wins when there is some; unsupported media never doubles a rich message
  const m = sample.planMessage();
  m.message = "kısa metin";
  m.entities = [new Api.MessageEntityBold({ offset: 0, length: 4 })];
  m.media = new Api.MessageMediaUnsupported();
  const own = svc.ser(m, KEY);
  assert.equal(own.text, "kısa metin");
  assert.deepEqual(own.ents, [{ t: "MessageEntityBold", o: 0, l: 4, url: undefined }]);
  assert.equal(own.media, null);
  assert.ok(own.rich);

  // a plain message has no rich field at all
  const plainMsg = new Api.Message({ id: 9, peerId: new Api.PeerUser({ userId: big(sample.BOT) }), date: 0, message: "merhaba" });
  assert.equal("rich" in svc.ser(plainMsg, KEY), false);
});

// ------------------------------------------------------------------ forum topics (messages.* since the layer change)
test("topics: create, rename, close, pin and delete go to messages.* with the group as input peer", async () => {
  const calls = [];
  const client = {
    invoke: async (req) => {
      calls.push(req);
      if (req instanceof Api.messages.GetForumTopics) return new Api.messages.ForumTopics({ count: 0, topics: [], messages: [], chats: [], users: [], pts: 0 });
      if (req instanceof Api.messages.CreateForumTopic) {
        const msg = new Api.MessageService({ id: 321, peerId: new Api.PeerChannel({ channelId: big(sample.GROUP_CHANNEL) }), date: 0, action: new Api.MessageActionTopicCreate({ title: req.title, iconColor: req.iconColor }) });
        return new Api.Updates({ updates: [new Api.UpdateMessageID({ id: 321, randomId: req.randomId }), new Api.UpdateNewChannelMessage({ message: msg, pts: 1, ptsCount: 1 })], users: [], chats: [], date: 0, seq: 0 });
      }
      if (req instanceof Api.messages.DeleteTopicHistory) return new Api.messages.AffectedHistory({ pts: 1, ptsCount: 1, offset: calls.filter((c) => c instanceof Api.messages.DeleteTopicHistory).length < 3 ? 7 : 0 });
      if (req instanceof Api.messages.EditForumTopic && req.closed === true) throw rpcError("TOPIC_NOT_MODIFIED");
      return new Api.Updates({ updates: [], users: [], chats: [], date: 0, seq: 0 });
    },
  };
  const svc = service(client);
  let emitted = 0;
  svc.on("dialogs", () => emitted++);

  assert.deepEqual(await svc.createTopic("Yeni konu", 0x6fb9f0), { key: "t321", id: 321 });
  const create = calls.find((x) => x instanceof Api.messages.CreateForumTopic);
  assert.ok(create.peer instanceof Api.InputPeerChannel);
  assert.equal(create.peer.channelId.toString(), sample.GROUP_CHANNEL);
  assert.equal(create.peer.accessHash.toString(), "77");
  assert.equal(create.title, "Yeni konu");
  assert.equal(create.iconColor, 0x6fb9f0);
  assert.ok(big(create.randomId).neq(0));

  await svc.editTopic(5, { title: "Saha" });
  const edit = calls.filter((x) => x instanceof Api.messages.EditForumTopic).pop();
  assert.equal(edit.topicId, 5);
  assert.equal(edit.title, "Saha");
  await svc.editTopic(5, { closed: true }); // TOPIC_NOT_MODIFIED: nothing to do, not an error
  await svc.pinTopic(5, true);
  const pin = calls.find((x) => x instanceof Api.messages.UpdatePinnedForumTopic);
  assert.equal(pin.topicId, 5);
  assert.equal(pin.pinned, true);
  await svc.deleteTopic(5);
  const del = calls.filter((x) => x instanceof Api.messages.DeleteTopicHistory);
  assert.equal(del.length, 3, "repeats until Telegram reports nothing left");
  assert.equal(del[0].topMsgId, 5);
  assert.ok(calls.filter((x) => x instanceof Api.messages.GetForumTopics).every((x) => x.peer instanceof Api.InputPeerChannel && x.limit === 100));
  assert.ok(emitted >= 5, "dialogs refreshed after each change");
  assert.ok(!calls.some((x) => /^channels\.(GetForumTopics|CreateForumTopic|EditForumTopic|UpdatePinnedForumTopic|DeleteTopicHistory)$/.test(x.className)));

  svc.state.group.canDelete = false;
  await assert.rejects(() => svc.deleteTopic(5), /yetkin yok/);
  svc.state.group.canManage = false;
  await assert.rejects(() => svc.createTopic("x", 0x6fb9f0), /yetkin yok/);
});

test("topics: pin updates from other clients refresh the list (UpdatePinnedForumTopic)", async () => {
  const svc = service();
  let refreshed = 0;
  svc._refreshTopicsSoon = () => refreshed++;
  svc._onRaw(new Api.UpdatePinnedForumTopic({ pinned: true, peer: new Api.PeerChannel({ channelId: big(sample.GROUP_CHANNEL) }), topicId: 5 }));
  svc._onRaw(new Api.UpdatePinnedForumTopics({ peer: new Api.PeerChannel({ channelId: big(sample.GROUP_CHANNEL) }), order: [5] }));
  svc._onRaw(new Api.UpdatePinnedForumTopic({ pinned: true, peer: new Api.PeerChannel({ channelId: big(42) }), topicId: 5 }));
  assert.equal(refreshed, 2, "only the configured group counts");
  const typing = [];
  svc.on("typing", (x) => typing.push(x));
  svc._onRaw(new Api.UpdateUserTyping({ userId: big(sample.BOT), action: new Api.SendMessageTypingAction() }));
  svc._onRaw(new Api.UpdateChannelUserTyping({ channelId: big(sample.GROUP_CHANNEL), topMsgId: 5, fromId: new Api.PeerUser({ userId: big(9) }), action: new Api.SendMessageTypingAction() }));
  assert.deepEqual(typing, [
    { key: KEY, action: "SendMessageTypingAction" },
    { key: "t5", action: "SendMessageTypingAction" },
  ]);
});

// ------------------------------------------------------------------ callbacks and media refs
test("callbacks: inline keyboard and rich buttons each send their own data; other buttons are refused", async () => {
  const sent = [];
  const svc = service({
    invoke: async (req) => {
      sent.push(req);
      if (req instanceof Api.messages.GetBotCallbackAnswer) return new Api.messages.BotCallbackAnswer({ message: "Tamam.", cacheTime: 0 });
      throw new Error(`unexpected ${req.className}`);
    },
  });
  const m = sample.planMessage();
  svc._remember(KEY, m);
  assert.deepEqual(await svc.callback(KEY, 207, 0, 0), { message: "Tamam.", alert: false, url: null });
  assert.equal(sent[0].data.toString(), sample.DATA.postpone);
  assert.equal(sent[0].msgId, 207);
  await svc.callback(KEY, 207, 0, 0, "rich");
  assert.equal(sent[1].data.toString(), sample.DATA.approve);
  await assert.rejects(() => svc.callback(KEY, 207, 0, 1, "rich"), /burada kullanılamıyor/); // a URL button
  await assert.rejects(() => svc.callback(KEY, 207, 0, 2, "rich"), /burada kullanılamıyor/); // a copy button
  await assert.rejects(() => svc.callback(KEY, 207, 3, 0, "rich"), /burada kullanılamıyor/); // no such row
  await assert.rejects(() => svc.callback(KEY, 207, 1, 0), /burada kullanılamıyor/);
  assert.equal(sent.length, 2);
});

test("media refs: a rich message's photo and document download through teleproto into the cache", async () => {
  const seen = [];
  const svc = service({
    downloadMedia: async (src, opts) => {
      seen.push({ src, opts });
      return Buffer.from(src instanceof Api.Photo ? "jpeg-bytes" : "sensor;c\nS-01;21\n");
    },
  });
  const m = sample.photosMessage();
  svc._remember(KEY, m);
  const thumb = await svc.fetchMedia(KEY, 208, "thumb", "p0");
  assert.ok(seen[0].src instanceof Api.Photo);
  assert.equal(seen[0].src.id.toString(), "5101");
  assert.deepEqual(seen[0].opts, { thumb: "x" }); // the 800 px size: the smallest one >= 640
  assert.equal(thumb.kind, "photo");
  assert.equal(fs.readFileSync(thumb.path, "utf8"), "jpeg-bytes");
  const file = await svc.fetchMedia(KEY, 208, "full", "d0");
  assert.ok(seen[1].src instanceof Api.Document);
  assert.equal(file.name, "olcum-41.csv");
  assert.equal(file.mime, "text/csv");
  assert.ok(file.path.endsWith(path.join("files", "5201", "olcum-41.csv")));
  await svc.fetchMedia(KEY, 208, "thumb", "p0"); // cached: no second download
  assert.equal(seen.length, 2);
  await assert.rejects(() => svc.fetchMedia(KEY, 208, "full"), /indirilebilir dosya yok/);
  await assert.rejects(() => svc.fetchMedia(KEY, 208, "full", "p7"), /indirilebilir dosya yok/);
});

test("partial rich messages: fetched whole once, then sent again as an edit", async () => {
  const asked = [];
  const whole = sample.planMessage();
  const svc = service({
    getRichMessage: async (entity, id) => {
      asked.push({ entity, id });
      return whole;
    },
  });
  const part = sample.planMessage();
  part.richMessage.part = true;
  part.richMessage.blocks = part.richMessage.blocks.slice(0, 3);
  const first = svc.ser(part, KEY);
  assert.equal(first.rich.part, true);
  const edits = [];
  svc.on("edit", (r) => edits.push(r));
  svc._completeRich(KEY, part);
  svc._completeRich(KEY, part); // the same version again: one fetch only
  await svc._richQ;
  assert.equal(asked.length, 1);
  assert.equal(asked[0].id, 207);
  assert.equal(asked[0].entity.id.toString(), sample.BOT);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].rich.part, undefined);
  assert.equal(edits[0].rich.blocks.length, 14);
  assert.equal(svc.raw.get(`${KEY}:207`), whole, "button presses and downloads use the whole message");

  // a failing fetch leaves the partial message as it is
  const bad = service({ getRichMessage: async () => Promise.reject(rpcError("MESSAGE_ID_INVALID")) });
  const lost = [];
  bad.on("edit", (r) => lost.push(r));
  bad._completeRich(KEY, part);
  await bad._richQ;
  assert.equal(lost.length, 0);
  // a complete message never asks
  svc._completeRich(KEY, sample.photosMessage());
  await svc._richQ;
  assert.equal(asked.length, 1);
});

// ------------------------------------------------------------------ session
test("session check: only Telegram's dead-session answers mean signed out; a timeout is just an error", async () => {
  const svc = service();
  svc.client = { invoke: async (req) => (req instanceof Api.updates.GetState ? new Api.updates.State({ pts: 1, qts: 0, date: 0, seq: 0, unreadCount: 0 }) : null) };
  assert.equal(await svc._authorized(), true);
  for (const msg of ["AUTH_KEY_UNREGISTERED", "SESSION_REVOKED", "USER_DEACTIVATED_BAN", "AUTH_KEY_DUPLICATED"]) {
    svc.client = { invoke: async () => Promise.reject(rpcError(msg, 401)) };
    assert.equal(await svc._authorized(), false, msg);
  }
  svc.client = { invoke: async () => Promise.reject(new Error("Request timed out")) };
  await assert.rejects(() => svc._authorized(), /timed out/);

  // start(): a dead session is "not-authorized" (main then asks for a login); a network failure stays itself
  const starting = (connect, authorized = true) => {
    const s = service();
    s._makeClient = () => ({ connect });
    s._authorized = async () => authorized;
    s._ready = async () => {};
    return s;
  };
  await assert.rejects(() => starting(async () => Promise.reject(rpcError("AUTH_KEY_UNREGISTERED", 401))).start(), /^Error: not-authorized$/);
  await assert.rejects(() => starting(async () => true, false).start(), /^Error: not-authorized$/);
  await assert.rejects(() => starting(async () => Promise.reject(new Error("connect ETIMEDOUT"))).start(), /ETIMEDOUT/);
  await starting(async () => true).start();
});

test("session string: one made by GramJS 2.26.22 loads in teleproto and saves back byte for byte", async () => {
  // GramJS StringSession.save() of dc 2 / 149.154.167.51:443 with a synthetic key (bytes (i*37+11) mod 256)
  const GRAMJS =
    "1AgAOMTQ5LjE1NC4xNjcuNTEBuwswVXqfxOkOM1h9osfsETZbgKXK7xQ5XoOozfIXPGGGq9D1Gj9kia7T+B1CZ4yx1vsgRWqPtNn+I0htkrfcASZLcJW63wQpTnOYveIHLFF2m8DlCi9UeZ7D6A0yV3yhxusQNVp/pMnuEzhdgqfM8RY7YIWqz/QZPmOIrdL3HEFmi7DV+h9EaY6z2P0iR2yRttsAJUpvlLneAyhNcpe84QYrUHWav+QJLlN4ncLnDDFWe6DF6g80WX6jyO0SN1yBpsvwFTpfhKnO8xg9Yoes0fYbQGWKr9T5HkNojbLX/CFGa5C12v8kSW6TuN0CJ0xxlrvgBSpPdJm+4wgtUnecweY=";
  const key = Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 37 + 11) & 255));
  const s = new StringSession(GRAMJS);
  await s.load();
  assert.equal(s.dcId, 2);
  assert.equal(s.serverAddress, "149.154.167.51");
  assert.equal(s.port, 443);
  assert.ok(s.authKey.getKey().equals(key));
  assert.equal(s.authKey.keyId.toString(), "1870051236913789343"); // GramJS computed the same id
  assert.equal(s.save(), GRAMJS);
  assert.throws(() => new StringSession("2" + GRAMJS.slice(1)), /Not a valid string/);
});

// ------------------------------------------------------------------ fixture
test("fixture: every rich media ref has its file and every rich button answer resolves", async () => {
  const fx = new FixtureService(path.join(__dirname, "fixtures", "telegram.json"), { mediaDir: path.join(TMP, "fx") });
  const refs = [];
  const walk = (key, id, blocks) => {
    for (const b of blocks || []) {
      if (b.t === "media" && b.ref) refs.push({ key, id, ref: b.ref, kind: b.media.kind });
      walk(key, id, b.t === "gallery" ? b.items : b.blocks);
    }
  };
  let rich = 0;
  for (const [key, list] of Object.entries(fx.data.messages)) {
    for (const m of list) {
      if (!m.rich) continue;
      rich++;
      walk(key, m.id, m.rich.blocks);
    }
  }
  assert.ok(rich >= 3, "the fixture shows rich messages");
  assert.ok(refs.length >= 4);
  for (const r of refs) {
    const variant = r.kind === "photo" ? "thumb" : "full";
    const f = await fx.fetchMedia(r.key, r.id, variant, r.ref);
    assert.ok(f.size > 0, `${r.key}:${r.id}:${r.ref}`);
  }
  const a = await fx.callback(KEY, 207, 0, 0, "rich");
  assert.notEqual(a.message, "Örnek yanıt: düğmeye basıldı.", "the plan's approve button has its own answer");
});

// ------------------------------------------------------------------ file attachments (A7)
const { CustomFile, uploadFile } = require("teleproto/client/uploads");
const { uploadError } = require("../main/attach");

/** A fake client whose sendFile records its parameters and answers with an outgoing message. */
function fileClient(peer, answer = {}) {
  const calls = [];
  return {
    calls,
    async sendFile(entity, params) {
      calls.push({ entity, params });
      if (params.progressCallback) {
        params.progressCallback(0);
        params.progressCallback(1);
      }
      return new Api.Message({ id: 900 + calls.length, out: true, peerId: peer, date: 0, message: params.caption, ...answer });
    },
  };
}

test("sendFile: photos go compressed unless asDocument; files always as documents; caption and progress pass through", async () => {
  const client = fileClient(new Api.PeerUser({ userId: big(sample.BOT) }));
  const svc = service(client);
  const ticks = [];
  const progress = (p) => ticks.push(p);
  const rec = await svc.sendFile(KEY, { name: "ekran.png", size: 1234, kind: "photo", path: "/tmp/ekran.png" }, { caption: "bak", progress });
  const p = client.calls[0].params;
  assert.ok(p.file instanceof CustomFile);
  assert.deepEqual([p.file.name, p.file.size, p.file.path, p.file.buffer], ["ekran.png", 1234, "/tmp/ekran.png", undefined]);
  assert.equal(p.forceDocument, false);
  assert.equal(p.caption, "bak");
  assert.equal(p.progressCallback, progress);
  assert.equal(p.replyTo, undefined);
  assert.equal(p.topMsgId, undefined);
  assert.deepEqual(ticks, [0, 1]);
  assert.equal(rec.key, KEY);
  assert.equal(rec.out, true);
  assert.equal(rec.text, "bak");
  assert.ok(svc.raw.has(`${KEY}:${rec.id}`), "remembered for later downloads");

  await svc.sendFile(KEY, { name: "ekran.png", size: 1234, kind: "photo", path: "/tmp/ekran.png" }, { asDocument: true });
  assert.equal(client.calls[1].params.forceDocument, true);
  await svc.sendFile(KEY, { name: "rapor.pdf", size: 10, kind: "file", path: "/tmp/rapor.pdf" });
  assert.equal(client.calls[2].params.forceDocument, true);
  const buf = Buffer.from("png bytes");
  await svc.sendFile(KEY, { name: "pasted.png", size: buf.length, kind: "photo", buffer: buf });
  assert.equal(client.calls[3].params.file.buffer, buf);
  assert.equal(client.calls[3].params.file.path, "");
  assert.equal(client.calls[3].params.caption.length, 0);
});

test("sendFile: topic and reply targets follow send() (top_msg_id inside a topic, none in General)", async () => {
  const peer = new Api.PeerChannel({ channelId: big(sample.GROUP_CHANNEL) });
  const client = fileClient(peer, { replyTo: new Api.MessageReplyHeader({ forumTopic: true, replyToMsgId: 5 }) });
  const svc = service(client);
  const f = { name: "a.txt", size: 1, kind: "file", path: "/tmp/a.txt" };
  const rec = await svc.sendFile("t5", f);
  assert.equal(client.calls[0].params.replyTo, 5);
  assert.equal(client.calls[0].params.topMsgId, undefined);
  assert.equal(client.calls[0].entity, svc.group);
  assert.equal(rec.key, "t5");
  await svc.sendFile("t5", f, { replyTo: 77 });
  assert.equal(client.calls[1].params.replyTo, 77);
  assert.equal(client.calls[1].params.topMsgId, 5);
  await svc.sendFile("t1", f);
  assert.equal(client.calls[2].params.replyTo, undefined);
  await svc.sendFile("t1", f, { replyTo: 9 });
  assert.deepEqual([client.calls[3].params.replyTo, client.calls[3].params.topMsgId], [9, undefined]);
  await assert.rejects(svc.sendFile("u424242", f), /unknown bot/);
  await assert.rejects(svc.sendFile(KEY, { name: "x", size: 0, kind: "file", path: "/tmp/x" }), /bad file/);
  await assert.rejects(svc.sendFile(KEY, { name: "x", size: 3, kind: "file" }), /bad file/);
  assert.equal(client.calls.length, 4);
});

test("upload cancel: teleproto 1.229.1 stops after the current part once isCanceled is set", async () => {
  let saved = 0;
  const client = {
    session: { dcId: 2 },
    _media: {
      opts: { upload: { maxSessions: 1, maxWindow: 1 } }, // one part in flight at a time
      async savePart() {
        saved++;
        await new Promise((r) => setImmediate(r));
      },
    },
  };
  const size = 3 * 1024 * 1024; // 3 MB in 128 KB parts (24 parts)
  const progress = (p) => {
    if (p > 0) progress.isCanceled = true;
  };
  progress.isCanceled = false;
  const err = await uploadFile(client, { file: new CustomFile("big.bin", size, "", Buffer.alloc(size)), onProgress: progress }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.equal(err.message, "USER_CANCELED");
  assert.equal(uploadError(err), "Gönderim iptal edildi.");
  assert.ok(saved >= 1 && saved < 24, `stopped early (${saved} parts sent)`);
});

test("fixture: a pretend upload reports progress, honours cancel and adds an in-memory message", async () => {
  const fx = new FixtureService(path.join(__dirname, "fixtures", "telegram.json"), { mediaDir: path.join(TMP, "fx-up") });
  fx.data.uploadMs = 40;
  await fx.start();
  const ticks = [];
  const progress = (p) => ticks.push(p);
  const m = await fx.sendFile(KEY, { name: "ekran.png", size: 2048, kind: "photo" }, { caption: "örnek", progress });
  assert.equal(ticks[0], 0);
  assert.equal(ticks[ticks.length - 1], 1);
  assert.deepEqual([m.key, m.out, m.text, m.media.kind], [KEY, true, "örnek", "photo"]);
  const stop = (p) => {
    if (p >= 0.25) stop.isCanceled = true;
  };
  await assert.rejects(fx.sendFile(KEY, { name: "a.pdf", size: 9, kind: "file" }, { progress: stop }), /USER_CANCELED/);
});

test("sendAlbum: 2-10 photos go as one teleproto album call, caption on the first, topic and reply like sendFile", async () => {
  const peer = new Api.PeerChannel({ channelId: big(sample.GROUP_CHANNEL) });
  const calls = [];
  const client = {
    async sendFile(entity, params) {
      calls.push({ entity, params });
      return params.file.map((f, i) => new Api.Message({ id: 950 + i, out: true, peerId: peer, date: 0, message: i ? "" : params.caption[0], groupedId: big("77"), replyTo: new Api.MessageReplyHeader({ forumTopic: true, replyToMsgId: 5 }) }));
    },
  };
  const svc = service(client);
  const a = { name: "a.jpg", size: 10, kind: "photo", path: "/tmp/a.jpg" };
  const b = { name: "b.png", size: 3, kind: "photo", buffer: Buffer.from("png") };
  const recs = await svc.sendAlbum("t5", [a, b], { caption: "ikisine bak" });
  assert.equal(calls.length, 1, "one album call, not two sends");
  const p = calls[0].params;
  assert.ok(Array.isArray(p.file) && p.file.every((f) => f instanceof CustomFile));
  assert.deepEqual(p.file.map((f) => f.name), ["a.jpg", "b.png"], "order kept");
  assert.deepEqual(p.caption, ["ikisine bak"]);
  assert.equal(p.forceDocument, false);
  assert.equal(p.replyTo, 5);
  assert.deepEqual(recs.map((r) => r.id), [950, 951]);
  assert.ok(svc.raw.has("t5:951"));
  await svc.sendAlbum("t5", [a, b], { replyTo: 77 });
  assert.equal(calls[1].params.replyTo, 77);
  assert.equal(calls[1].params.topMsgId, 5);
  await assert.rejects(svc.sendAlbum("t5", [a]), /bad album/);
  await assert.rejects(svc.sendAlbum("t5", [a, { name: "r.pdf", size: 1, kind: "file", path: "/tmp/r.pdf" }]), /bad file/);
  await assert.rejects(svc.sendAlbum("t5", Array(11).fill(a)), /bad album/);
  assert.equal(calls.length, 2, "rejected albums send nothing");
});
