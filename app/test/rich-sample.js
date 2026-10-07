"use strict";
// Synthetic Bot API rich messages built from teleproto's own TL classes (layer 229). Shared by
// test/telegram.test.js and scripts/make-fixture.js, so the fixture screenshots show exactly what the
// tests check. Everything is made up: names, ids, links, codes and the media.
const { Api, helpers } = require("teleproto");

const big = helpers.returnBigInt;
const T = (text) => new Api.TextPlain({ text });
/** Plain strings and RichText pieces joined into one RichText. */
const C = (...parts) => new Api.TextConcat({ texts: parts.map((p) => (typeof p === "string" ? T(p) : p)) });
const wrap = (cls) => (x) => new cls({ text: typeof x === "string" ? T(x) : x });
const B = wrap(Api.TextBold);
const I = wrap(Api.TextItalic);
const F = wrap(Api.TextFixed);
const M = wrap(Api.TextMarked);
const S = wrap(Api.TextSpoiler);
const U = (x, url) => new Api.TextUrl({ text: typeof x === "string" ? T(x) : x, url, webpageId: big(0) });
const cap = (text, credit) => new Api.PageCaption({ text: text ? T(text) : new Api.TextEmpty(), credit: credit ? T(credit) : new Api.TextEmpty() });

const BOT = "7001"; // the fixture's Atlas bot
const GROUP_CHANNEL = "9990001001"; // the fixture's group (-1009990001001)
const DATA = { approve: "plan:onay:41", postpone: "plan:ertele:41", summary: "ozet:tamam" };

function photo(id, w, h) {
  const s = 320 / Math.max(w, h);
  return new Api.Photo({
    id: big(id),
    accessHash: big(1),
    fileReference: Buffer.alloc(0),
    date: 0,
    dcId: 2,
    sizes: [
      new Api.PhotoStrippedSize({ type: "i", bytes: Buffer.from([1, 2, 3]) }),
      new Api.PhotoSize({ type: "m", w: Math.round(w * s), h: Math.round(h * s), size: 9000 }),
      new Api.PhotoSize({ type: "x", w, h, size: 48000 }),
    ],
  });
}

function doc(id, fileName, mimeType, size) {
  return new Api.Document({
    id: big(id),
    accessHash: big(1),
    fileReference: Buffer.alloc(0),
    date: 0,
    mimeType,
    size: big(size),
    dcId: 2,
    attributes: [new Api.DocumentAttributeFilename({ fileName })],
  });
}

const dm = () => new Api.PeerUser({ userId: big(BOT) });
const inTopic = (topic) => ({ peerId: new Api.PeerChannel({ channelId: big(GROUP_CHANNEL) }), fromId: new Api.PeerUser({ userId: big(BOT) }), replyTo: new Api.MessageReplyHeader({ forumTopic: true, replyToMsgId: topic }) });

const row = (...cells) => new Api.PageTableRow({ cells });
const cell = (text, o = {}) => new Api.PageTableCell({ text: T(text), ...o });
const task = (text, checked) => new Api.PageListItemText({ checkbox: true, checked, text: T(text) });

/** The week plan: kicker, heading, styled paragraph, checklist, table, steps, code, quote, details, the bot's reasoning, buttons. */
function planMessage(id = 207) {
  const rich = new Api.RichMessage({
    blocks: [
      new Api.PageBlockKicker({ text: T("Saha raporu · 41. hafta") }),
      new Api.PageBlockHeading2({ text: T("Haftalık bakım planı") }),
      new Api.PageBlockParagraph({
        text: C("Bu hafta ", B("üç sensör"), " bakıma giriyor. ", I("S-02"), " için yedek pil ", F("PB-12"), " hazır; ayrıntılar ", U("rapor sayfasında", "https://example.org/rapor"), ". ", M("Kesinti en fazla 2 saat."), " Kapı kodu: ", S("4417")),
      }),
      new Api.PageBlockList({ items: [task("Kalibrasyon kontrolü", true), task("S-02 pil değişimi", false), task("Anten bağlantısı", false)] }),
      new Api.PageBlockHeading3({ text: T("Takvim") }),
      new Api.PageBlockTable({
        bordered: true,
        title: new Api.TextEmpty(),
        rows: [
          row(cell("Gün", { header: true }), cell("Sensör", { header: true, alignCenter: true }), cell("İş", { header: true })),
          row(cell("Salı"), cell("S-01", { alignCenter: true }), cell("Kalibrasyon")),
          row(cell("Çarşamba"), cell("S-02", { alignCenter: true }), cell("Pil değişimi")),
          row(cell("Perşembe"), cell("S-03", { alignCenter: true }), cell("Anten bağlantısı")),
        ],
      }),
      new Api.PageBlockOrderedList({
        items: ["Sahaya 07:00'de çık.", "Ölçümü kaydet.", "Raporu bu sohbete yükle."].map((t) => new Api.PageListOrderedItemText({ text: T(t) })),
      }),
      new Api.PageBlockPreformatted({ text: T("deck-export --hafta 41 --format csv"), language: "bash" }),
      new Api.PageBlockBlockquote({ text: T("Ölçümden önce sensörü 10 dakika ısıt."), caption: T("Bakım kılavuzu") }),
      new Api.PageBlockDetails({
        title: T("Ayrıntılı ölçüm notları"),
        blocks: [new Api.PageBlockParagraph({ text: T("S-03'te sabah nemi %91'e çıktı; değerler öğleye doğru normale döndü.") })],
      }),
      new Api.PageBlockThinking({ text: T("Kullanıcı tablo istedi; önce takvimi, sonra kontrol listesini veriyorum.") }),
      new Api.PageBlockDivider(),
      new Api.PageBlockButtonRow({
        buttons: [
          new Api.PageButton({ text: T("Planı onayla"), type: new Api.InlineButtonTypeCallback({ data: Buffer.from(DATA.approve) }), style: new Api.RichButtonStyle({ bgSuccess: true }) }),
          new Api.PageButton({ text: T("Raporu aç"), type: new Api.InlineButtonTypeUrl({ url: "https://example.org/rapor" }) }),
          new Api.PageButton({ text: T("Kodu kopyala"), type: new Api.InlineButtonTypeCopy({ copyText: "SAHA-41" }) }),
        ],
      }),
      new Api.PageBlockFooter({ text: T("Atlas · otomatik rapor") }),
    ],
    photos: [],
    documents: [],
  });
  // an ordinary inline keyboard under the rich content (layer 229 buttons: kind in .type, colour in .style)
  const replyMarkup = new Api.ReplyInlineMarkup({
    rows: [
      new Api.KeyboardInlineButtonRow({
        buttons: [new Api.KeyboardInlineButton({ text: "Ertele", type: new Api.InlineButtonTypeCallback({ data: Buffer.from(DATA.postpone) }), style: new Api.KeyboardButtonStyle({ bgDanger: true }) })],
      }),
    ],
  });
  return new Api.Message({ id, peerId: dm(), date: 0, message: "", richMessage: rich, replyMarkup });
}

/** Field photos: a captioned photo, a two-photo collage, a document, a map, and two parts this view cannot draw. */
function photosMessage(id = 208) {
  const photos = [photo(5101, 800, 524), photo(5102, 480, 640), photo(5103, 640, 360)];
  const documents = [doc(5201, "olcum-41.csv", "text/csv", 67)];
  const rich = new Api.RichMessage({
    blocks: [
      new Api.PageBlockHeading3({ text: T("Saha fotoğrafları") }),
      new Api.PageBlockPhoto({ photoId: big(5101), caption: cap("Kuzey sırtı, 07:40", "Mira Kestane") }),
      new Api.PageBlockCollage({
        items: [new Api.PageBlockPhoto({ photoId: big(5102), caption: cap() }), new Api.PageBlockPhoto({ photoId: big(5103), caption: cap() })],
        caption: cap("Ölçüm noktaları"),
      }),
      new Api.PageBlockDocument({ documentId: big(5201), caption: cap("Ham veriler") }),
      new Api.PageBlockMap({ geo: new Api.GeoPoint({ lat: 40.01234, long: 32.98765, accessHash: big(0) }), zoom: 15, w: 600, h: 300, caption: cap("Ölçüm alanı") }),
      new Api.PageBlockUnsupported(),
      new Api.PageBlockParagraph({ text: C("Rota işareti ", new Api.TextImage({ documentId: big(5299), w: 16, h: 16 }), " haritada.") }),
    ],
    photos,
    documents,
  });
  return new Api.Message({ id, peerId: dm(), date: 0, message: "", richMessage: rich });
}

/** A short daily summary in the group topic, from the same bot. */
function summaryMessage(id = 110, topic = 5) {
  const rich = new Api.RichMessage({
    blocks: [
      new Api.PageBlockHeading3({ text: T("Günlük özet") }),
      new Api.PageBlockList({
        items: [
          new Api.PageListItemText({ text: C(B("3"), " ölçüm noktası tamam") }),
          new Api.PageListItemText({ text: C(B("1"), " uyarı: S-02 pili %18") }),
        ],
      }),
      new Api.PageBlockButtonRow({
        alignLeft: true,
        buttons: [new Api.PageButton({ text: T("Tamam"), type: new Api.InlineButtonTypeCallback({ data: Buffer.from(DATA.summary) }), style: new Api.RichButtonStyle({ bgPrimary: true }) })],
      }),
    ],
    photos: [],
    documents: [],
  });
  return new Api.Message({ id, ...inTopic(topic), date: 0, message: "", richMessage: rich });
}

module.exports = { BOT, GROUP_CHANNEL, DATA, T, C, B, I, F, U, planMessage, photosMessage, summaryMessage, photo, doc };
