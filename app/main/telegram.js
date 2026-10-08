"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
// teleproto is the maintained successor of GramJS (same API, MTProto layer 229). It holds the account's
// auth key, so package.json pins one exact, audited version: update it deliberately, never by a caret.
const { TelegramClient, Api, helpers, utils } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
const { NewMessage, EditedMessage } = require("teleproto/events");
const { Logger, LogLevel } = require("teleproto/extensions/Logger");
const { CustomFile } = require("teleproto/client/uploads"); // file attachments (A7): path- or buffer-backed uploads
const { UpdateConnectionState } = require("teleproto/network");
const { MAX_FULL, safeName, extFor, writeAtomic, cachedSize, mb } = require("./media");
const { Reactions, carryMine } = require("./reactions"); // C9: message reactions (serializer, picker, sending, live updates)
const { ReadQueue } = require("./readsync");

const KEY_RE = /^(u|t)(\d+)$/;
const RAW_KEEP = 1500; // raw teleproto messages kept for media downloads and button presses
// Inline previews use the smallest photo size at least this wide/tall (usually Telegram's 800 px "x"):
// the bubble shows photos up to 340x380 CSS px, which the 320 px "m" size only covers blurred on HiDPI.
const THUMB_MIN = 640;
// A rich message's media are addressed by position: "p<i>" in its photos, "d<i>" in its documents.
const REF_RE = /^([pd])(\d{1,3})$/;
// Answers that mean the saved session itself is gone (signed out elsewhere, revoked, deleted account, or a
// key Telegram dropped after seeing it used twice at once). Anything else is a network or server hiccup.
const DEAD_SESSION = /AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|AUTH_KEY_DUPLICATED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/;
const errText = (e) => String((e && (e.errorMessage || e.message)) || e || "");

function displayName(e) {
  if (!e) return null;
  return [e.firstName, e.lastName].filter(Boolean).join(" ") || e.title || e.username || null;
}

// --- media + inline keyboard as plain data (the renderer never sees teleproto objects) ----------
const num = (v) => (v === undefined || v === null ? null : Number(v.toString()));
const attrOf = (doc, cls) => (doc.attributes || []).find((a) => a instanceof cls) || null;
const realSize = (s) => s instanceof Api.PhotoSize || s instanceof Api.PhotoSizeProgressive || s instanceof Api.PhotoCachedSize;
const sizeBytes = (s) => (s instanceof Api.PhotoSizeProgressive ? Math.max(...s.sizes) : s instanceof Api.PhotoCachedSize ? s.bytes.length : s.size || 0);
const largest = (sizes) => sizes.reduce((a, s) => (!a || s.w * s.h > a.w * a.h ? s : a), null);
/** Drop empty fields so every message record stays small. */
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== false && v !== ""));

/** A photo as plain data: its largest size, bytes, and whether a preview exists. */
function photoInfo(photo, extra = {}) {
  if (!(photo instanceof Api.Photo)) return { kind: "photo", gone: true };
  const sizes = (photo.sizes || []).filter(realSize);
  const big = largest(sizes);
  return compact({ kind: "photo", w: big && big.w, h: big && big.h, size: big && sizeBytes(big), thumb: sizes.length > 0, ...extra });
}

/** A document as plain data: kind (from its attributes), mime, name, size, duration, dimensions, preview. */
function docInfo(d, extra = {}) {
  if (!(d instanceof Api.Document)) return { kind: "file", gone: true };
  const fn = attrOf(d, Api.DocumentAttributeFilename);
  const vid = attrOf(d, Api.DocumentAttributeVideo);
  const aud = attrOf(d, Api.DocumentAttributeAudio);
  const img = attrOf(d, Api.DocumentAttributeImageSize);
  const stk = attrOf(d, Api.DocumentAttributeSticker);
  let kind = "file";
  if (stk) kind = "sticker";
  else if (attrOf(d, Api.DocumentAttributeAnimated)) kind = "gif";
  else if (vid) kind = vid.roundMessage ? "round" : "video";
  else if (aud) kind = aud.voice ? "voice" : "audio";
  const dims = vid || img;
  return compact({
    kind,
    mime: d.mimeType,
    name: fn && fn.fileName,
    size: num(d.size),
    dur: vid ? Math.round(vid.duration || 0) : aud ? aud.duration : null,
    w: dims && dims.w,
    h: dims && dims.h,
    thumb: (d.thumbs || []).some(realSize),
    alt: stk && stk.alt,
    wave: aud && aud.voice && aud.waveform && aud.waveform.length && aud.waveform.length <= 256 ? Buffer.from(aud.waveform).toString("base64") : null, // 5-bit samples, the bubble draws it before the clip is fetched
    title: aud && aud.title,
    performer: aud && aud.performer,
    ...extra,
  });
}

/**
 * What a message carries besides text: kind, mime, name, size, duration, dimensions and whether a
 * preview exists. "unsupported" is what Telegram sends for content even layer 229 cannot represent;
 * Bot API rich messages are not media but message.richMessage (see richOf).
 */
function mediaInfo(m) {
  const md = m.media;
  if (!md || md instanceof Api.MessageMediaWebPage || md instanceof Api.MessageMediaEmpty) return null;
  if (md instanceof Api.MessageMediaUnsupported) return m.richMessage instanceof Api.RichMessage ? null : { kind: "unsupported" };
  if (md instanceof Api.MessageMediaPhoto) {
    return md.photo instanceof Api.Photo ? photoInfo(md.photo, { spoiler: !!md.spoiler, ttl: !!md.ttlSeconds }) : { kind: "photo", gone: true };
  }
  if (md instanceof Api.MessageMediaDocument) {
    return md.document instanceof Api.Document ? docInfo(md.document, { spoiler: !!md.spoiler }) : { kind: "file", gone: true };
  }
  if (md instanceof Api.MessageMediaVenue) return compact({ kind: "geo", title: md.title });
  if (md instanceof Api.MessageMediaGeo || md instanceof Api.MessageMediaGeoLive) return { kind: "geo" };
  if (md instanceof Api.MessageMediaContact) return compact({ kind: "contact", title: [md.firstName, md.lastName].filter(Boolean).join(" ") });
  if (md instanceof Api.MessageMediaPoll) {
    const q = md.poll && md.poll.question;
    return compact({ kind: "poll", title: typeof q === "string" ? q : q && q.text });
  }
  if (md instanceof Api.MessageMediaDice) return { kind: "dice", title: `${md.emoticon} ${md.value}` };
  return { kind: "other" };
}

/** Colour hint of a styled button (layer 229 lets bots mark inline and rich buttons). */
function toneOf(s) {
  if (!s) return null;
  return s.bgDanger ? "danger" : s.bgSuccess ? "success" : s.bgPrimary ? "primary" : s.link ? "link" : null;
}

/**
 * One button as plain data. Since layer 229 a button's kind lives in its InlineButtonType (url, callback,
 * copy, web app, ...). Callback data stays in the main process; the renderer only knows where it sits.
 */
function buttonOf(text, type, style) {
  const label = String(text || "").slice(0, 80);
  let b;
  if (type instanceof Api.InlineButtonTypeUrl || type instanceof Api.InlineButtonTypeUrlAuth) b = { t: "url", text: label, url: type.url };
  else if (type instanceof Api.InlineButtonTypeCallback) b = { t: type.requiresPassword ? "other" : "cb", text: label };
  else if (type instanceof Api.InlineButtonTypeCopy) b = { t: "copy", text: label, copy: String(type.copyText || "").slice(0, 4096) };
  else if (type instanceof Api.InlineButtonTypeWebView) b = { t: "app", text: label };
  else b = { t: "other", text: label };
  const tone = toneOf(style);
  return tone ? { ...b, tone } : b;
}

/** Inline keyboard rows (layer 229: rows of KeyboardInlineButton {text, type, style}). */
function buttonRows(m) {
  const mk = m.replyMarkup;
  if (!(mk instanceof Api.ReplyInlineMarkup)) return null;
  const rows = (mk.rows || []).map((r) => (r.buttons || []).map((b) => buttonOf(b.text, b.type, b.style))).filter((r) => r.length);
  return rows.length ? rows : null;
}

// --- rich messages (Bot API 10.1 sendRichMessage; MTProto layer 228+) ----------------------------
// A rich message arrives as message.richMessage: a tree of PageBlocks (Instant View's model) whose text
// is RichText, plus the photos and documents its media blocks point at. richOf() reduces it to plain
// data for the renderer:
//   - text runs {text, ents} in the shape of an ordinary message's text and entities (UTF-16 offsets),
//     so the renderer draws them with the same entity code; a few rich-only styles use "Rich*" names;
//   - blocks {t: "h" | "p" | "kicker" | "footer" | "byline" | "pre" | "hr" | "ul" | "ol" | "quote" |
//     "table" | "details" | "think" | "media" | "gallery" | "embed" | "links" | "map" | "buttons" | "gap"};
//   - media blocks carry a ref ("p<i>"/"d<i>") that tg:media resolves against the stored message;
//   - button rows are numbered in document order; tg:callback finds the same row by walking again.
// Whatever cannot be drawn becomes a "gap" block, which the renderer turns into a "Open in Telegram" note.
const RICH_MAX_BLOCKS = 600; // Telegram allows 500, nested blocks and list items included
const RICH_MAX_DEPTH = 16; // Telegram allows 16 levels of nesting
const RICH_MAX_TEXT = 40000; // characters across the whole message (Telegram: 32768 bytes of UTF-8)
const PLAIN_MAX = 8000;
const MEDIA_WORD = { get photo() { return i18nText("U0274"); }, video: "video", gif: "GIF", get round() { return i18nText("U0306"); }, get voice() { return i18nText("A0155"); }, get audio() { return i18nText("common.audio"); }, get sticker() { return i18nText("U0275"); }, get file() { return i18nText("common.file"); } };
const webUrl = (u) => (/^https?:\/\/[^\s]+$/i.test(String(u || "")) ? String(u) : null);
/** Like compact(), but keeps false and 0: in rich data an unchecked box is false, not missing. */
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

// RichText wrappers that become one entity over their content
const RICH_STYLE = [
  [Api.TextBold, "MessageEntityBold"],
  [Api.TextItalic, "MessageEntityItalic"],
  [Api.TextUnderline, "MessageEntityUnderline"],
  [Api.TextStrike, "MessageEntityStrike"],
  [Api.TextFixed, "MessageEntityCode"],
  [Api.TextSpoiler, "MessageEntitySpoiler"],
  [Api.TextAutoUrl, "MessageEntityUrl"],
  [Api.TextMarked, "RichMarked"],
  [Api.TextSubscript, "RichSub"],
  [Api.TextSuperscript, "RichSup"],
];

/** Append rt to out ({text, ents}); entity offsets are in UTF-16 units, like Telegram's own. */
function flatten(rt, out, ctx, depth) {
  if (!rt || depth > 32 || out.text.length > RICH_MAX_TEXT) return;
  const span = (t, fill, extra) => {
    const o = out.text.length;
    fill();
    const l = out.text.length - o;
    if (t && l > 0) out.ents.push({ t, o, l, ...extra });
  };
  const inner = () => flatten(rt.text, out, ctx, depth + 1);
  if (rt instanceof Api.TextPlain) out.text += rt.text || "";
  else if (rt instanceof Api.TextConcat) for (const t of rt.texts || []) flatten(t, out, ctx, depth + 1);
  else if (rt instanceof Api.TextEmpty) return;
  else if (rt instanceof Api.TextCustomEmoji) out.text += rt.alt || "";
  else if (rt instanceof Api.TextMath) span("MessageEntityCode", () => (out.text += rt.source || ""));
  else if (rt instanceof Api.TextUrl) {
    const url = webUrl(rt.url);
    span(url ? "MessageEntityTextUrl" : null, inner, url ? { url } : undefined);
  } else if (rt instanceof Api.TextButton) {
    // a button inside running text: a link when it opens a web page, otherwise a label that only works in Telegram
    const url = webUrl(buttonOf("", rt.type).url);
    span(url ? "MessageEntityTextUrl" : "RichButton", inner, url ? { url } : undefined);
  } else if (rt instanceof Api.TextImage) {
    ctx.gaps++; // an inline picture (icon-sized); the view says some parts only show in Telegram
    span("RichGap", () => (out.text += i18nText("U0307")));
  } else {
    const style = RICH_STYLE.find(([cls]) => rt instanceof cls);
    if (style) span(style[1], inner);
    // mentions, hashtags, e-mail, phone, anchors, dates, diffs and anything newer: their text as written
    else if (rt.text && typeof rt.text === "object") inner();
  }
}

/** A RichText as one run {text, ents?}, or null when it is empty. */
function richRun(rt, ctx) {
  const out = { text: "", ents: [] };
  flatten(rt, out, ctx, 0);
  if (!out.text) return null;
  ctx.text += out.text.length;
  return out.ents.length ? out : { text: out.text };
}

/** Text without styles (code blocks, button labels). */
function richPlain(rt, ctx) {
  const r = richRun(rt, ctx);
  return r ? r.text : "";
}

/** A media caption: its text, then " — " and the credit when there is one. */
function captionRun(c, ctx) {
  if (!(c instanceof Api.PageCaption)) return null;
  const a = richRun(c.text, ctx);
  const b = richRun(c.credit, ctx);
  if (!a || !b) return a || b;
  const shift = a.text.length + 3;
  const ents = [...(a.ents || []), ...(b.ents || []).map((e) => ({ ...e, o: e.o + shift }))];
  return clean({ text: `${a.text} — ${b.text}`, ents: ents.length ? ents : null });
}

/** A media block's photo or document, by id, as a ref into the message plus its plain description. */
function richMedia(kind, id, ctx, extra) {
  const list = kind === "p" ? ctx.photos : ctx.docs;
  const i = id === undefined || id === null ? -1 : list.findIndex((x) => x && x.id !== undefined && x.id.toString() === id.toString());
  if (i < 0 || i > 999) return { media: { kind: kind === "p" ? "photo" : "file", gone: true } };
  return { ref: `${kind}${i}`, media: kind === "p" ? photoInfo(list[i], extra) : docInfo(list[i], extra) };
}

const HEADS = [
  [Api.PageBlockTitle, 1],
  [Api.PageBlockSubtitle, 2],
  [Api.PageBlockHeader, 3],
  [Api.PageBlockSubheader, 4],
  [Api.PageBlockHeading1, 1],
  [Api.PageBlockHeading2, 2],
  [Api.PageBlockHeading3, 3],
  [Api.PageBlockHeading4, 4],
  [Api.PageBlockHeading5, 5],
  [Api.PageBlockHeading6, 6],
];

function richBlocks(list, ctx, depth) {
  const out = [];
  for (const b of list || []) {
    if (ctx.n >= RICH_MAX_BLOCKS || ctx.text >= RICH_MAX_TEXT) {
      ctx.cut = true;
      break;
    }
    const x = richBlock(b, ctx, depth);
    if (x) out.push(x);
  }
  return out;
}

function listItem(it, ctx, depth) {
  ctx.n++;
  const base = { num: it.num || undefined, check: it.checkbox ? !!it.checked : undefined };
  if (Array.isArray(it.blocks)) return clean({ ...base, blocks: richBlocks(it.blocks, ctx, depth + 1) });
  return clean({ ...base, text: richRun(it.text, ctx) });
}

/** One PageBlock as plain data, or null for blocks with nothing to show (anchors, empty text). */
function richBlock(b, ctx, depth) {
  ctx.n++;
  if (depth > RICH_MAX_DEPTH) {
    ctx.cut = true;
    return null;
  }
  const run = (rt) => richRun(rt, ctx);
  const kids = (list) => richBlocks(list, ctx, depth + 1);
  const textBlock = (t) => {
    const text = run(b.text);
    return text ? { t, text } : null;
  };
  const head = HEADS.find(([cls]) => b instanceof cls);
  if (head) {
    const text = run(b.text);
    return text ? { t: "h", n: head[1], text } : null;
  }
  if (b instanceof Api.PageBlockParagraph) return textBlock("p");
  if (b instanceof Api.PageBlockKicker) return textBlock("kicker");
  if (b instanceof Api.PageBlockFooter) return textBlock("footer");
  if (b instanceof Api.PageBlockThinking) return textBlock("think");
  if (b instanceof Api.PageBlockAuthorDate) return clean({ t: "byline", text: run(b.author), date: b.publishedDate || null });
  if (b instanceof Api.PageBlockPreformatted) return clean({ t: "pre", code: richPlain(b.text, ctx), lang: b.language || null });
  if (b instanceof Api.PageBlockMath) {
    ctx.text += String(b.source || "").length;
    return { t: "pre", code: String(b.source || ""), lang: "latex", math: true };
  }
  if (b instanceof Api.PageBlockDivider) return { t: "hr" };
  if (b instanceof Api.PageBlockAnchor) return null;
  if (b instanceof Api.PageBlockList) return { t: "ul", items: (b.items || []).map((it) => listItem(it, ctx, depth)) };
  if (b instanceof Api.PageBlockOrderedList) {
    return clean({ t: "ol", start: b.start || null, reversed: b.reversed || null, items: (b.items || []).map((it) => listItem(it, ctx, depth)) });
  }
  if (b instanceof Api.PageBlockBlockquote || b instanceof Api.PageBlockPullquote) {
    return clean({ t: "quote", pull: b instanceof Api.PageBlockPullquote || null, text: run(b.text), caption: run(b.caption) });
  }
  if (b instanceof Api.PageBlockBlockquoteBlocks) return clean({ t: "quote", blocks: kids(b.blocks), caption: run(b.caption) });
  if (b instanceof Api.PageBlockDetails) return clean({ t: "details", title: run(b.title), open: b.open || null, blocks: kids(b.blocks) });
  if (b instanceof Api.PageBlockTable) {
    const rows = (b.rows || []).map((r) => {
      ctx.n++;
      return (r.cells || []).map((c) =>
        clean({
          text: c.text ? run(c.text) : null,
          head: c.header || null,
          cs: c.colspan > 1 ? Math.min(c.colspan, 20) : null,
          rs: c.rowspan > 1 ? Math.min(c.rowspan, 100) : null,
          align: c.alignCenter ? "center" : c.alignRight ? "right" : null,
        })
      );
    });
    return clean({ t: "table", title: run(b.title), rows, bordered: b.bordered || null, striped: b.striped || null });
  }
  if (b instanceof Api.PageBlockPhoto) {
    return clean({ t: "media", ...richMedia("p", b.photoId, ctx, { spoiler: !!b.spoiler }), caption: captionRun(b.caption, ctx), url: webUrl(b.url) });
  }
  if (b instanceof Api.PageBlockVideo) return clean({ t: "media", ...richMedia("d", b.videoId, ctx, { spoiler: !!b.spoiler }), caption: captionRun(b.caption, ctx) });
  if (b instanceof Api.PageBlockAudio) return clean({ t: "media", ...richMedia("d", b.audioId, ctx), caption: captionRun(b.caption, ctx) });
  if (b instanceof Api.PageBlockDocument) return clean({ t: "media", ...richMedia("d", b.documentId, ctx), caption: captionRun(b.caption, ctx) });
  if (b instanceof Api.PageBlockCover) return richBlock(b.cover, ctx, depth + 1);
  if (b instanceof Api.PageBlockCollage || b instanceof Api.PageBlockSlideshow) return clean({ t: "gallery", items: kids(b.items), caption: captionRun(b.caption, ctx) });
  if (b instanceof Api.PageBlockEmbed) {
    const url = webUrl(b.url);
    if (!url) {
      ctx.gaps++;
      return { t: "gap" };
    }
    return clean({ t: "embed", url, caption: captionRun(b.caption, ctx) });
  }
  if (b instanceof Api.PageBlockEmbedPost) {
    const by = clean({ t: "byline", text: b.author ? { text: String(b.author) } : null, date: b.date || null });
    return clean({ t: "quote", blocks: [by, ...kids(b.blocks)], caption: captionRun(b.caption, ctx) });
  }
  if (b instanceof Api.PageBlockChannel) {
    const title = b.channel && b.channel.title;
    return title ? { t: "p", text: { text: i18nText("telegram.channel", { title: title }) } } : null;
  }
  if (b instanceof Api.PageBlockRelatedArticles) {
    const items = (b.articles || []).map((a) => clean({ title: a.title || a.url || null, url: webUrl(a.url), desc: a.description || null }));
    return clean({ t: "links", title: run(b.title), items });
  }
  if (b instanceof Api.PageBlockMap && b.geo instanceof Api.GeoPoint) {
    return clean({ t: "map", lat: b.geo.lat, long: b.geo.long, zoom: b.zoom || null, caption: captionRun(b.caption, ctx) });
  }
  if (b instanceof Api.PageBlockButtonRow) {
    const raw = (b.buttons || []).filter((x) => x instanceof Api.PageButton);
    if (!raw.length) return null;
    ctx.rows.push(raw);
    const align = b.alignCenter ? "center" : b.alignRight ? "right" : b.alignLeft ? "left" : null;
    return clean({ t: "buttons", row: ctx.rows.length - 1, align, buttons: raw.map((x) => buttonOf(richPlain(x.text, ctx), x.type, x.style)) });
  }
  // PageBlockUnsupported, maps without a point, and block kinds newer than this code
  ctx.gaps++;
  return { t: "gap" };
}

/** Plain text of converted blocks: what previews, quotes, copying and notifications use. */
function plainOf(blocks, out = [], indent = "") {
  const t = (r) => (r ? r.text : "");
  for (const b of blocks || []) {
    if (out.length > 400) break;
    switch (b.t) {
      case "h":
      case "p":
      case "kicker":
      case "footer":
      case "byline":
        if (b.text) out.push(indent + b.text.text);
        break;
      case "pre":
        out.push(b.code);
        break;
      case "quote":
        if (b.text) out.push(b.text.text);
        plainOf(b.blocks, out, indent);
        if (b.caption) out.push(`— ${b.caption.text}`);
        break;
      case "ul":
      case "ol":
        b.items.forEach((it, i) => {
          const lead = `${indent}${b.t === "ol" ? `${it.num || (b.start || 1) + i}.` : "•"} ${it.check === undefined ? "" : it.check ? "☑ " : "☐ "}`;
          if (it.text) out.push(lead + it.text.text);
          else {
            out.push(lead.trimEnd());
            plainOf(it.blocks, out, `${indent}  `);
          }
        });
        break;
      case "table":
        if (b.title) out.push(b.title.text);
        for (const r of b.rows) out.push(r.map((c) => t(c.text)).join(" | "));
        break;
      case "details":
        if (b.title) out.push(b.title.text);
        plainOf(b.blocks, out, indent);
        break;
      case "media":
        out.push(`[${MEDIA_WORD[b.media.kind] || i18nText("common.attachment")}]${b.caption ? ` ${b.caption.text}` : ""}`);
        break;
      case "gallery":
        plainOf(b.items, out, indent);
        if (b.caption) out.push(b.caption.text);
        break;
      case "embed":
        out.push(b.url);
        break;
      case "links":
        if (b.title) out.push(b.title.text);
        for (const a of b.items) out.push(`• ${a.title || a.url || ""}`);
        break;
      case "map":
        out.push(i18nText("A0172"));
        break;
      case "buttons":
        out.push(b.buttons.map((x) => `[${x.text}]`).join(" "));
        break;
      default: // "think" (the bot's reasoning stays out of previews), "hr", "gap"
        break;
    }
  }
  return out;
}

/**
 * A RichMessage as {view, plain}. view: {blocks, rtl?, part?, cut?, gaps?} for the renderer; plain: the
 * same content as text. rows (optional array) receives each button row's raw PageButtons in the order
 * the view numbers them, so a press can be matched to its callback data.
 */
function richOf(rm, rows = null) {
  const ctx = { n: 0, text: 0, gaps: 0, cut: false, photos: rm.photos || [], docs: rm.documents || [], rows: rows || [] };
  const blocks = richBlocks(rm.blocks, ctx, 0);
  const view = clean({ blocks, rtl: rm.rtl || null, part: rm.part || null, cut: ctx.cut || null, gaps: ctx.gaps || null });
  const plain = plainOf(blocks).filter((x) => x !== "").join("\n").slice(0, PLAIN_MAX);
  return { view, plain };
}

/** The photo or document a download is about: the message's own media, or a rich message's one by ref. */
function mediaOf(m, ref) {
  if (ref) {
    const r = REF_RE.exec(String(ref));
    const rm = m.richMessage;
    if (!r || !(rm instanceof Api.RichMessage)) return null;
    const item = (r[1] === "p" ? rm.photos || [] : rm.documents || [])[Number(r[2])];
    if (item instanceof Api.Photo) return { photo: item };
    if (item instanceof Api.Document) return { document: item };
    return null;
  }
  const md = m.media;
  if (md instanceof Api.MessageMediaPhoto && md.photo instanceof Api.Photo) return { photo: md.photo, spoiler: !!md.spoiler };
  if (md instanceof Api.MessageMediaDocument && md.document instanceof Api.Document) return { document: md.document };
  return null;
}

/** One line for a service message (topic created/edited, pins, joins); who: the actor's name, if known. */
function serviceText(m, who) {
  const a = m.action;
  const by = who || i18nText("A0144");
  if (a instanceof Api.MessageActionTopicCreate) return i18nText("U0308", { by: by, title: a.title });
  if (a instanceof Api.MessageActionTopicEdit) {
    if (a.closed === true) return i18nText("U0309", { by: by });
    if (a.closed === false) return i18nText("U0310", { by: by });
    if (a.title) return i18nText("U0311", { by: by, title: a.title });
    if (a.hidden !== undefined) return a.hidden ? i18nText("A0173", { by: by }) : i18nText("U0312", { by: by });
    return i18nText("U0313", { by: by });
  }
  if (a instanceof Api.MessageActionPinMessage) return i18nText("U0314", { by: by });
  if (a instanceof Api.MessageActionChatEditTitle) return i18nText("U0315", { by: by, title: a.title });
  if (a instanceof Api.MessageActionChatAddUser || a instanceof Api.MessageActionChatJoinedByLink || a instanceof Api.MessageActionChatJoinedByRequest) return i18nText("U0316", { by: by });
  if (a instanceof Api.MessageActionChatDeleteUser) return i18nText("U0317", { by: by });
  return i18nText("U0318");
}

/** What this account may do with the group's topics: creator, or admin with manage_topics (deleting also needs delete_messages). */
function topicRights(ch) {
  const ar = ch && ch.adminRights;
  const manage = !!(ch && (ch.creator || (ar && ar.manageTopics)));
  return { canManage: manage, canDelete: manage && !!(ch.creator || (ar && ar.deleteMessages)) };
}

const TOPIC_ERRORS = () => [
  [/TOPIC_NOT_MODIFIED/, null],
  [/CHAT_ADMIN_REQUIRED|RIGHT_FORBIDDEN|ADMIN_RIGHTS_EMPTY/, i18nText("U0319")],
  [/TOPIC_ID_INVALID|TOPIC_DELETED|MESSAGE_ID_INVALID/, i18nText("U0230")],
  [/PINNED_TOO_MUCH|PINNED_TOPICS_TOO_MUCH/, i18nText("U0320")],
  [/TOPIC_TITLE_EMPTY/, i18nText("U0321")],
  [/TOPIC_CLOSED/, i18nText("U0322")],
];

/** Id of the message this one replies to, inside the same chat (a plain post in a topic points at the topic root: no reply). */
function replyOf(m) {
  const r = m.replyTo;
  if (!(r instanceof Api.MessageReplyHeader) || !r.replyToMsgId || r.replyToPeerId) return { id: null, quote: null };
  if (r.forumTopic && !r.replyToTopId) return { id: null, quote: null };
  return { id: r.replyToMsgId, quote: r.quote && r.quoteText ? String(r.quoteText).slice(0, 200) : null };
}

/**
 * The user's own Telegram account (MTProto via teleproto), limited to what the deck shows:
 * bot DMs (minus hidden bots) and, optionally, one forum group's topics. Read + send, plus read receipts
 * (C5): a chat the user has looked at in the Deck is marked read on Telegram (markRead, only while
 * readReceipts is on and readGate() says the window is in front); no other chat is touched. Chat keys:
 * "u<botUserId>" for a bot DM, "t<topicId>" for a topic of the configured group (General is t1).
 *
 * Events: "dialogs" ({me, bots, topics}), "msg" (new message), "edit", "typing" ({key, action}),
 * "avatar" ({key, url}), "people" ({<userId>: {avatar?, role?, rank?, name?}}: group senders' and reactors' photos and admin badges),
 * "reactions" ({key, id, reactions}: a message's reactions changed, see main/reactions.js),
 * "read" ({key, unread, maxId}: read elsewhere, unread = what Telegram still counts) and "counts"
 * ({counts: {<key>: unread}}: every chat's unread count again, after a reconnect).
 * A rich message Telegram delivered in part is fetched whole once and sent again as an "edit".
 */
class TelegramService extends EventEmitter {
  constructor({ apiId, apiHash, session = "", groupChatId = "", hiddenBots = [], avatarDir = null, mediaDir = null, readReceipts = true, readGate = null }) {
    super();
    this.opts = { apiId: Number(apiId), apiHash, session };
    this.groupId = groupChatId ? String(groupChatId) : "";
    this.hidden = new Set(hiddenBots.map((b) => b.toLowerCase()));
    this.bots = new Map(); // userId -> {key, entity}
    this.group = null;
    this.state = null;
    this.avatarDir = avatarDir;
    this.avatars = {}; // chat key -> data: URL of the small profile photo
    this.client = null;
    // media, buttons, group senders
    this.mediaDir = mediaDir;
    this.raw = new Map(); // "<key>:<msgId>" -> Api.Message (insertion order = age)
    this.people = {}; // group member id -> {avatar?, role?, rank?}, renderer-safe
    this._seen = new Map(); // member id -> {user, photoId, msgId} for avatar downloads
    this._avq = new Set();
    this._peopleOut = {};
    this._dl = { active: 0, queue: [], inflight: new Map() };
    // rich messages delivered in part: fetched whole one at a time, each version once
    this._richQ = Promise.resolve();
    this._richSeen = new Set();
    this.reactions = new Reactions(this); // C9
    // C5 read receipts: outgoing marks are batched by the queue; readGate() is main's "window in front"
    this.readReceipts = readReceipts !== false;
    this._reads = new ReadQueue({ send: (key, maxId) => this._sendRead(key, maxId), gate: () => !!(this.client && readGate && readGate()) });
    this._topicReadIds = new Set(); // topics read elsewhere whose counts are fetched again
  }

  _makeClient(session) {
    const { apiId, apiHash } = this.opts;
    this.client = new TelegramClient(new StringSession(session), apiId, apiHash, {
      connectionRetries: 10,
      autoReconnect: true,
      deviceModel: "Hermes Deck",
      appVersion: "0.1.0",
      baseLogger: new Logger(LogLevel.ERROR),
    });
    return this.client;
  }

  /**
   * Connect with a saved session. Throws "not-authorized" only when Telegram says the session is gone
   * (main then forgets it and asks for a new login); a network failure is thrown as itself.
   */
  async start() {
    try {
      await this._makeClient(this.opts.session).connect();
      if (!(await this._authorized())) throw new Error("not-authorized");
    } catch (e) {
      if (DEAD_SESSION.test(errText(e))) throw new Error("not-authorized");
      throw e;
    }
    await this._ready();
  }

  /**
   * Whether the session is still signed in. teleproto's checkAuthorization() answers false for any error,
   * timeouts included, which would make a bad connection at startup look like a revoked session.
   */
  async _authorized() {
    try {
      await this.client.invoke(new Api.updates.GetState());
      return true;
    } catch (e) {
      if (DEAD_SESSION.test(errText(e))) return false;
      throw e;
    }
  }

  /**
   * Interactive login. askCode/askPassword return promises the UI resolves; onError decides whether a
   * failed step is retried (return false: wrong code/password) or aborts the login (return true).
   * Resolves with the new session string (the caller stores it encrypted).
   */
  async login({ phone, askCode, askPassword, onError }) {
    await this._makeClient("").connect();
    await this.client.start({
      phoneNumber: async () => phone,
      phoneCode: async (viaApp) => askCode(viaApp),
      password: async (hint) => askPassword(hint),
      // teleproto would otherwise sign up a new account (and accept the ToS) for a number with no account.
      firstAndLastNames: async () => {
        throw new Error("NO_ACCOUNT");
      },
      onError: async (err) => onError(err),
    });
    const session = this.client.session.save();
    await this._ready();
    return session;
  }

  async _ready() {
    this.me = await this.client.getMe();
    await this.loadDialogs();
    this.client.addEventHandler((ev) => this._onNew(ev).catch(() => {}), new NewMessage({}));
    this.client.addEventHandler((ev) => this._onEdit(ev), new EditedMessage({}));
    this.client.addEventHandler((u) => this._onRaw(u));
    this.loadAvatars().catch(() => {});
    this.loadRoles().catch(() => {});
  }

  /**
   * Small profile photos for the bots (and the group), cached on disk by photo id so a restart does not
   * download them again. Emitted one by one as "avatar" events; failures just leave the monogram.
   */
  async loadAvatars() {
    const targets = [...this.bots.values()].map((b) => ({ key: b.key, entity: b.entity }));
    if (this.group) targets.push({ key: "group", entity: this.group });
    for (const { key, entity } of targets) {
      const photo = entity.photo;
      const photoId = photo && photo.photoId ? photo.photoId.toString() : null;
      if (!photoId) continue;
      const file = this.avatarDir ? path.join(this.avatarDir, `${key}-${photoId}.jpg`) : null;
      let buf = null;
      try {
        if (file) buf = fs.readFileSync(file);
      } catch {
        buf = null;
      }
      if (!buf || !buf.length) {
        try {
          buf = await this.client.downloadProfilePhoto(entity, { isBig: false });
        } catch {
          buf = null;
        }
        if (Buffer.isBuffer(buf) && buf.length && file) {
          fs.mkdirSync(this.avatarDir, { recursive: true });
          fs.writeFileSync(file, buf);
        }
      }
      if (Buffer.isBuffer(buf) && buf.length) {
        this.avatars[key] = `data:image/jpeg;base64,${buf.toString("base64")}`;
        this.emit("avatar", { key, url: this.avatars[key] });
      }
    }
  }

  /** Sign this session out on Telegram's side too, then drop the connection. */
  async logout() {
    if (!this.client) return;
    try {
      await this.client.invoke(new Api.auth.LogOut());
    } finally {
      await this.stop();
    }
  }

  async stop() {
    clearTimeout(this._peopleT);
    clearTimeout(this._topicsT);
    clearTimeout(this._countsT);
    clearTimeout(this._topicReadT);
    this._reads.clear();
    this._avq.clear();
    if (!this.client) return;
    const c = this.client;
    this.client = null;
    try {
      await c.destroy();
    } catch {
      /* already closed */
    }
  }

  meInfo() {
    return this.me ? { id: this.me.id.toString(), name: displayName(this.me) } : null;
  }

  async loadDialogs() {
    const dialogs = await this.client.getDialogs({ limit: 300 });
    const bots = [];
    const forumGroups = []; // forum supergroups the user is in (for the group picker in Settings)
    this.bots.clear();
    for (const d of dialogs) {
      const e = d.entity;
      if (e instanceof Api.User && e.bot && !(e.username && this.hidden.has(e.username.toLowerCase()))) {
        const id = e.id.toString();
        const key = `u${id}`;
        this.bots.set(id, { key, entity: e });
        this._reads.seen(key, d.dialog && d.dialog.readInboxMaxId);
        bots.push({ key, id, username: e.username, title: displayName(e), unread: d.unreadCount, last: d.message ? this.ser(d.message, key) : null });
      } else if (e instanceof Api.Channel && e.forum) {
        forumGroups.push({ id: d.id.toString(), title: e.title });
        if (this.groupId && d.id.toString() === this.groupId) this.group = e;
      }
    }
    const topics = await this._topics();
    const group = this.group ? { id: this.groupId, title: this.group.title, ...topicRights(this.group) } : null;
    this.state = { me: this.meInfo(), group, bots, topics, forumGroups };
    this.emit("dialogs", this.state);
    return this.state;
  }

  /** The configured group as an input peer: layer 229 has the forum topic methods under messages.* (198: channels.*). */
  _groupPeer() {
    return utils.getInputPeer(this.group);
  }

  /** The group's topics, pinned ones first (in Telegram's pin order), then the rest in Telegram's order. */
  async _topics() {
    if (!this.group || !this.group.forum) return [];
    const res = await this.client.invoke(
      new Api.messages.GetForumTopics({ peer: this._groupPeer(), limit: 100, offsetDate: 0, offsetId: 0, offsetTopic: 0 })
    );
    const names = new Map((res.users || []).map((u) => [u.id.toString(), displayName(u)]));
    const msgs = new Map((res.messages || []).map((m) => [m.id, m]));
    const topics = res.topics
      .filter((t) => t instanceof Api.ForumTopic)
      .map((t) => {
        const key = `t${t.id}`;
        const m = msgs.get(t.topMessage);
        this._reads.seen(key, t.readInboxMaxId);
        return { key, id: t.id, title: t.title, color: t.iconColor, unread: t.unreadCount, pinned: !!t.pinned, closed: !!t.closed, last: m ? this.ser(m, key, names) : null };
      });
    return [...topics.filter((t) => t.pinned), ...topics.filter((t) => !t.pinned)];
  }

  /** Re-read the topic list and send the updated dialogs (after a topic change here or elsewhere). */
  async refreshTopics() {
    if (!this.state) return;
    this.state.topics = await this._topics();
    this.emit("dialogs", this.state);
  }

  _refreshTopicsSoon() {
    clearTimeout(this._topicsT);
    this._topicsT = setTimeout(() => this.refreshTopics().catch(() => {}), 800);
  }

  // --- topic management (only with the rights from topicRights; the IPC layer validates input) ---
  _canManage(del = false) {
    const g = this.state && this.state.group;
    if (!this.group || !g) throw new Error(i18nText("U0323"));
    if (!g.canManage || (del && !g.canDelete)) throw new Error(i18nText("U0229"));
  }

  async _topicCall(req) {
    try {
      return await this.client.invoke(req);
    } catch (e) {
      const s = errText(e);
      const hit = TOPIC_ERRORS().find(([re]) => re.test(s));
      if (hit && hit[1] === null) return null; // nothing changed: fine
      throw new Error(hit ? hit[1] : s.slice(0, 140));
    }
  }

  /** Create a topic; resolves with its chat key once the topic list is fresh. */
  async createTopic(title, color) {
    this._canManage();
    const res = await this._topicCall(new Api.messages.CreateForumTopic({ peer: this._groupPeer(), title, iconColor: color, randomId: helpers.generateRandomBigInt() }));
    const up = ((res && res.updates) || []).find((u) => u.message && u.message.action instanceof Api.MessageActionTopicCreate);
    await this.refreshTopics();
    return up ? { key: `t${up.message.id}`, id: up.message.id } : null;
  }

  /** patch: {title} or {closed} (General cannot be closed; the IPC layer checks that). */
  async editTopic(id, patch) {
    this._canManage();
    await this._topicCall(new Api.messages.EditForumTopic({ peer: this._groupPeer(), topicId: id, ...patch }));
    await this.refreshTopics();
  }

  async pinTopic(id, pinned) {
    this._canManage();
    await this._topicCall(new Api.messages.UpdatePinnedForumTopic({ peer: this._groupPeer(), topicId: id, pinned }));
    await this.refreshTopics();
  }

  /** Delete a topic with all its messages. Telegram deletes in batches; repeat until nothing is left. */
  async deleteTopic(id) {
    this._canManage(true);
    for (let i = 0; i < 200; i++) {
      const r = await this._topicCall(new Api.messages.DeleteTopicHistory({ peer: this._groupPeer(), topMsgId: id }));
      if (!r || !r.offset) break;
    }
    await this.refreshTopics();
  }

  /**
   * Plain, renderer-safe message record (text + entity ranges; the renderer builds DOM, never HTML).
   * media: see mediaInfo(); replyToId: replied message in the same chat; buttons: inline keyboard rows;
   * rich: a rich message's blocks (see richOf), whose plain text then fills text when the message has none.
   */
  ser(m, key, names) {
    const fromId = m.fromId && m.fromId.userId ? m.fromId.userId.toString() : null;
    let from = displayName(m.sender);
    if (!from && names && fromId) from = names.get(fromId) || null;
    if (!from && key.startsWith("u") && !m.out) {
      const b = this.bots.get(key.slice(1));
      from = b ? displayName(b.entity) : null;
    }
    if (m instanceof Api.MessageService) {
      // topic created/closed, pins, joins: one line in the chat, not a bubble
      return { key, id: m.id, out: !!m.out, date: m.date, fromId, from, text: "", ents: [], media: null, service: serviceText(m, from) };
    }
    if (key.startsWith("t") && !m.out && m.sender) this._notePerson(m.sender, m.id);
    const reply = replyOf(m);
    const rich = m.richMessage instanceof Api.RichMessage ? richOf(m.richMessage) : null;
    const own = m.message || "";
    const rec = {
      key,
      id: m.id,
      out: !!m.out,
      date: m.date,
      edit: m.editDate || null,
      fromId,
      from,
      fromBot: key.startsWith("u") ? !m.out : !!(m.sender && m.sender.bot),
      text: own || (rich ? rich.plain : ""),
      ents: own ? (m.entities || []).map((e) => ({ t: e.className, o: e.offset, l: e.length, url: e.url || undefined })) : [],
      media: mediaInfo(m),
      replyToId: reply.id,
      replyQuote: reply.quote,
      buttons: buttonRows(m),
    };
    if (rich) rec.rich = rich.view;
    const reactions = this.reactions.ser(m); // C9: chips under the bubble
    if (reactions) rec.reactions = reactions;
    return rec;
  }

  keyFor(m) {
    const p = m.peerId;
    if (p instanceof Api.PeerUser) {
      const id = p.userId.toString();
      return this.bots.has(id) ? `u${id}` : null;
    }
    if (p instanceof Api.PeerChannel && this.group && `-100${p.channelId}` === this.groupId) {
      const r = m.replyTo;
      const tid = r && r.forumTopic ? r.replyToTopId || r.replyToMsgId : 1;
      return `t${tid}`;
    }
    return null;
  }

  _target(key) {
    const k = KEY_RE.exec(key);
    if (!k) throw new Error("bad chat key");
    if (k[1] === "u") {
      const b = this.bots.get(k[2]);
      if (!b) throw new Error("unknown bot");
      return { entity: b.entity, topic: null };
    }
    if (!this.group) throw new Error("group not found");
    return { entity: this.group, topic: Number(k[2]) };
  }

  async history(key, limit = 40) {
    const { entity, topic } = this._target(key);
    let msgs;
    if (topic === null) msgs = await this.client.getMessages(entity, { limit });
    else if (topic === 1) {
      // General has no thread root: take recent group messages that are not inside another topic
      msgs = (await this.client.getMessages(entity, { limit: limit * 2 })).filter((m) => !(m.replyTo && m.replyTo.forumTopic)).slice(0, limit);
    } else msgs = await this.client.getMessages(entity, { limit, replyTo: topic });
    const list = msgs.reverse();
    for (const m of list) this._remember(key, m);
    if (topic !== null) this._rolesSoon();
    const out = list.map((m) => this.ser(m, key));
    for (const m of list) this._completeRich(key, m);
    return out;
  }

  /**
   * Send text, optionally as a reply. Inside a forum topic the reply carries the topic as top_msg_id so
   * it stays in that topic; General (t1) has no thread root, so a plain reply is enough there.
   */
  async send(key, text, replyTo = null) {
    const body = String(text || "").trim();
    if (!body) throw new Error("empty message");
    const { entity, topic } = this._target(key);
    const params = { message: body.slice(0, 4096) };
    if (replyTo) {
      params.replyTo = replyTo;
      if (topic && topic !== 1) params.topMsgId = topic;
    } else if (topic && topic !== 1) params.replyTo = topic;
    const m = await this.client.sendMessage(entity, params);
    this._remember(key, m);
    return this.ser(m, key);
  }

  /**
   * File attachments (A7): upload one staged file (main/attach.js) and send it, with an optional caption,
   * to the chat or forum topic, as a reply when replyTo is set (same topic rules as send()).
   * kind "photo" goes as a compressed photo unless asDocument; everything else as a document.
   * progress: teleproto's progress callback; setting its isCanceled stops the upload after the current part.
   */
  async sendFile(key, file, { caption = "", replyTo = null, asDocument = false, progress = null } = {}) {
    const { entity, topic } = this._target(key);
    if (!file || typeof file.name !== "string" || !(file.size > 0) || (!file.path && !Buffer.isBuffer(file.buffer))) throw new Error("bad file");
    const params = {
      file: new CustomFile(file.name, file.size, file.path || "", file.path ? undefined : file.buffer),
      caption: String(caption || "").slice(0, 1024),
      forceDocument: !(file.kind === "photo" && !asDocument),
      workers: 4,
    };
    if (replyTo) {
      params.replyTo = replyTo;
      if (topic && topic !== 1) params.topMsgId = topic;
    } else if (topic && topic !== 1) params.replyTo = topic;
    if (progress) params.progressCallback = progress;
    const m = await this.client.sendFile(entity, params);
    this._remember(key, m);
    return this.ser(m, key);
  }

  // --- raw message cache (media downloads and button presses need the teleproto object) ----------
  _remember(key, m) {
    if (!m || !m.id) return;
    const k = `${key}:${m.id}`;
    const old = this.raw.get(k);
    if (old && m !== old) carryMine(m.reactions, old.reactions); // C9: a "min" copy keeps the user's own reactions
    this.raw.delete(k);
    this.raw.set(k, m);
    if (this.raw.size > RAW_KEEP) this.raw.delete(this.raw.keys().next().value);
  }

  /** The teleproto message for a chat key + id: from the cache, else fetched (and checked to belong to that chat). */
  async _raw(key, id, fresh = false) {
    const k = `${key}:${id}`;
    if (!fresh && this.raw.has(k)) return this.raw.get(k);
    const { entity } = this._target(key);
    const [m] = await this.client.getMessages(entity, { ids: [id] });
    if (!(m instanceof Api.Message) || this.keyFor(m) !== key) throw new Error(i18nText("U0228"));
    const full = await this._wholeRich(entity, m, key);
    this._remember(key, full);
    return full;
  }

  /** m itself, or for a rich message delivered in part the whole one (messages.getRichMessage). */
  async _wholeRich(entity, m, key) {
    const rm = m.richMessage;
    if (!(rm instanceof Api.RichMessage) || !rm.part) return m;
    const full = await this.client.getRichMessage(entity, m.id);
    const ok = full instanceof Api.Message && full.id === m.id && full.richMessage instanceof Api.RichMessage && this.keyFor(full) === key;
    return ok ? full : m;
  }

  /** Queue a whole-message fetch for a rich message delivered in part; the result goes out as an "edit". */
  _completeRich(key, m) {
    const rm = m && m.richMessage;
    if (!(rm instanceof Api.RichMessage) || !rm.part || !this.client) return;
    const k = `${key}:${m.id}:${m.editDate || 0}`;
    if (this._richSeen.has(k)) return;
    this._richSeen.add(k);
    if (this._richSeen.size > 2000) this._richSeen.delete(this._richSeen.values().next().value);
    this._richQ = this._richQ.then(async () => {
      if (!this.client) return;
      try {
        const full = await this._wholeRich(this._target(key).entity, m, key);
        if (full === m) return;
        this._remember(key, full);
        this.emit("edit", this.ser(full, key));
      } catch {
        /* stays partial: the view says the rest is in Telegram */
      }
    });
  }

  /** At most three downloads at a time; the same file is never fetched twice at once. */
  _download(file, job) {
    const d = this._dl;
    if (d.inflight.has(file)) return d.inflight.get(file);
    const p = new Promise((resolve, reject) => {
      d.queue.push({ job, resolve, reject });
      this._pump();
    }).finally(() => d.inflight.delete(file));
    d.inflight.set(file, p);
    return p;
  }

  _pump() {
    const d = this._dl;
    while (d.active < 3 && d.queue.length) {
      const { job, resolve, reject } = d.queue.shift();
      d.active++;
      job()
        .then(resolve, reject)
        .finally(() => {
          d.active--;
          this._pump();
        });
    }
  }

  /** downloadMedia with one retry on an expired file reference (the message is fetched again). */
  async _fetchBytes(key, id, thumb, ref) {
    const get = async (m) => {
      const it = ref ? mediaOf(m, ref) : null;
      const src = ref ? it && (it.photo || it.document) : m;
      if (!src) throw new Error(i18nText("U0324"));
      const buf = await this.client.downloadMedia(src, thumb === undefined ? {} : { thumb });
      if (!Buffer.isBuffer(buf) || !buf.length) throw new Error(i18nText("U0324"));
      return buf;
    };
    try {
      return await get(await this._raw(key, id));
    } catch (e) {
      if (!/FILE_REFERENCE_/.test(errText(e))) throw e;
      return get(await this._raw(key, id, true));
    }
  }

  /**
   * Download a message's media into userData/media and return {path, mime, name, size, kind}.
   * variant "thumb": the inline preview (smallest photo size >= THUMB_MIN, or the document thumbnail);
   * variant "full": the original, refused above 25 MB. Cached files are reused across restarts.
   * ref: a rich message's photo or document ("p<i>" / "d<i>"); without it, the message's own media.
   */
  async fetchMedia(key, id, variant, ref = null) {
    if (!this.mediaDir) throw new Error(i18nText("U0325"));
    const m = await this._raw(key, id);
    const it = mediaOf(m, ref);
    if (!it) throw new Error(i18nText("A0180"));
    const info = it.photo ? photoInfo(it.photo) : docInfo(it.document);
    let file;
    let thumb;
    let mime;
    let name;
    if (it.photo) {
      const sizes = (it.photo.sizes || []).filter(realSize).sort((a, b) => a.w * a.h - b.w * b.h);
      if (!sizes.length) throw new Error(i18nText("U0326"));
      const pick = variant === "thumb" ? sizes.find((s) => Math.max(s.w, s.h) >= THUMB_MIN) || sizes[sizes.length - 1] : sizes[sizes.length - 1];
      if (variant === "full" && sizeBytes(pick) > MAX_FULL) throw new Error(i18nText("U0327", { v: mb(sizeBytes(pick)) }));
      thumb = pick.type;
      mime = "image/jpeg";
      name = `foto-${id}${ref ? `-${ref}` : ""}.jpg`;
      file = path.join(this.mediaDir, `p${it.photo.id}-${pick.type}.jpg`);
    } else {
      const doc = it.document;
      if (variant === "thumb") {
        const thumbs = (doc.thumbs || []).filter(realSize).sort((a, b) => a.w * a.h - b.w * b.h);
        if (!thumbs.length) throw new Error(i18nText("U0224"));
        const pick = thumbs[thumbs.length - 1];
        thumb = pick.type;
        mime = "image/jpeg"; // sniffed again when served: sticker thumbnails are WEBP
        name = `onizleme-${id}.jpg`;
        file = path.join(this.mediaDir, `d${doc.id}-t${pick.type}.img`);
      } else {
        const size = num(doc.size) || 0;
        if (size > MAX_FULL) throw new Error(i18nText("U0328", { size: mb(size) }));
        mime = doc.mimeType || "application/octet-stream";
        name = safeName(info.name || `${info.kind || i18nText("common.file")}-${id}${extFor(mime)}`);
        file = path.join(this.mediaDir, "files", String(doc.id), name);
      }
    }
    if (!cachedSize(file)) {
      await this._download(file, async () => {
        if (cachedSize(file)) return;
        const buf = await this._fetchBytes(key, id, thumb, ref);
        if (variant === "full" && buf.length > MAX_FULL) throw new Error(i18nText("U0329", { length: mb(buf.length) }));
        writeAtomic(file, buf);
      });
    }
    return { path: file, mime, name, size: cachedSize(file), kind: info.kind || null };
  }

  /**
   * Press a callback button (only when the user clicks it) and return the bot's answer.
   * where "kb": the inline keyboard, row/col as sent; "rich": a rich message's button row (numbered in
   * document order by richOf) and the button's place in it.
   */
  async callback(key, id, row, col, where = "kb") {
    const m = await this._raw(key, id);
    let b = null;
    if (where === "rich") {
      const rows = [];
      if (m.richMessage instanceof Api.RichMessage) richOf(m.richMessage, rows);
      b = rows[row] ? rows[row][col] : null;
    } else {
      const mk = m.replyMarkup;
      b = mk instanceof Api.ReplyInlineMarkup && mk.rows[row] ? mk.rows[row].buttons[col] : null;
    }
    const type = b && b.type;
    if (!(type instanceof Api.InlineButtonTypeCallback) || type.requiresPassword) throw new Error(i18nText("U0330"));
    const { entity } = this._target(key);
    try {
      const res = await this.client.invoke(new Api.messages.GetBotCallbackAnswer({ peer: entity, msgId: id, data: type.data }));
      return { message: res.message || null, alert: !!res.alert, url: res.url || null };
    } catch (e) {
      const s = errText(e);
      if (/BOT_RESPONSE_TIMEOUT/.test(s)) return { message: null, timeout: true };
      if (/MESSAGE_ID_INVALID|DATA_INVALID/.test(s)) throw new Error(i18nText("U0331"));
      throw new Error(s.slice(0, 140));
    }
  }

  // --- reactions (C9; the work is in main/reactions.js) -------------------------------------------
  /** The reactions the picker offers in this chat: {list: [{t, e|id}], max}. */
  reactionChoices(key) {
    return this.reactions.choices(key);
  }

  /** Set the user's own reactions on a message to exactly keys ("e:👍", "c:<id>"); resolves with the new reactions. */
  react(key, id, keys) {
    return this.reactions.send(key, id, keys);
  }

  /** A custom emoji's picture file (cached), or null when it has none that can be drawn. */
  customEmoji(docId) {
    return this.reactions.emoji(docId);
  }

  // --- read receipts (C5) -----------------------------------------------------------------------
  /**
   * The user has seen chat `key` up to message maxId in the Deck. Queued and sent in a batch (see
   * main/readsync.js); false when receipts are off or nothing new. The caller (main) checks the input.
   */
  markRead(key, maxId) {
    if (!this.readReceipts || !KEY_RE.test(String(key))) return false;
    return this._reads.mark(String(key), maxId);
  }

  /** Receipts switched on/off in Settings: off drops what is queued; the Deck then counts locally. */
  setReadReceipts(on) {
    this.readReceipts = !!on;
    if (!this.readReceipts) this._reads.clear();
  }

  /** The window came to the front: marks held while it was in the background may go out now. */
  wakeReads() {
    this._reads.wake();
  }

  /**
   * One mark to Telegram. Bot DM: messages.readHistory. Forum topic: messages.readDiscussion with the
   * topic id as msg_id (layer 229 has no top_msg_id on readHistory; General is topic 1, as in Telegram's
   * own clients). channels.readHistory is never used: on a forum it would mark every topic read.
   */
  async _sendRead(key, maxId) {
    if (!this.client || !this.readReceipts) return;
    const { entity, topic } = this._target(key);
    if (topic === null) await this.client.invoke(new Api.messages.ReadHistory({ peer: utils.getInputPeer(entity), maxId }));
    else await this.client.invoke(new Api.messages.ReadDiscussion({ peer: this._groupPeer(), msgId: topic, readMaxId: maxId }));
  }

  /** Read updates from Telegram (another device, or this session's own marks echoed back). */
  _onRead(u, inGroup) {
    if (u instanceof Api.UpdateReadHistoryInbox) {
      const p = u.peer;
      if (p instanceof Api.PeerUser && this.bots.has(p.userId.toString()) && !u.topMsgId) {
        const key = `u${p.userId}`;
        this._reads.seen(key, u.maxId);
        this._setUnread(key, u.stillUnreadCount);
        this.emit("read", { key, unread: u.stillUnreadCount, maxId: u.maxId });
      }
    } else if (u instanceof Api.UpdateReadChannelDiscussionInbox && inGroup(u.channelId)) {
      // a topic: the update has no count, so the topic is fetched again (in a batch)
      this._reads.seen(`t${u.topMsgId}`, u.readMaxId);
      this._topicReadIds.add(u.topMsgId);
      clearTimeout(this._topicReadT);
      this._topicReadT = setTimeout(() => this._topicReads().catch(() => {}), 600);
    } else if (u instanceof Api.UpdateReadChannelInbox && inGroup(u.channelId)) {
      this._countsSoon(800); // the whole group (older clients, or "mark all read"): every topic again
    }
  }

  /** Unread counts of the topics read elsewhere, as "read" events. */
  async _topicReads() {
    const ids = [...this._topicReadIds].slice(0, 100);
    for (const id of ids) this._topicReadIds.delete(id);
    if (!ids.length || !this.client || !this.group) return;
    const res = await this.client.invoke(new Api.messages.GetForumTopicsByID({ peer: this._groupPeer(), topics: ids }));
    for (const t of res.topics || []) {
      if (!(t instanceof Api.ForumTopic)) continue;
      const key = `t${t.id}`;
      this._reads.seen(key, t.readInboxMaxId);
      this._setUnread(key, t.unreadCount);
      this.emit("read", { key, unread: t.unreadCount, maxId: t.readInboxMaxId });
    }
    if (this._topicReadIds.size) this._topicReadT = setTimeout(() => this._topicReads().catch(() => {}), 600);
  }

  /** Keep the dialogs snapshot (sent to a reloaded renderer) in step with read updates. */
  _setUnread(key, n) {
    const list = this.state ? (key[0] === "u" ? this.state.bots : this.state.topics) || [] : [];
    const x = list.find((c) => c.key === key);
    if (x && Number.isFinite(n)) x.unread = n;
  }

  /**
   * Every chat's unread count fresh from Telegram, as one "counts" event: bot DMs through
   * messages.getPeerDialogs, topics through the topic list. Used after a reconnect, when read updates
   * from other devices may have been missed.
   */
  async refreshCounts() {
    if (!this.client || !this.state) return;
    const counts = {};
    const bots = [...this.bots.values()];
    for (let i = 0; i < bots.length; i += 100) {
      const peers = bots.slice(i, i + 100).map((b) => new Api.InputDialogPeer({ peer: utils.getInputPeer(b.entity) }));
      const res = await this.client.invoke(new Api.messages.GetPeerDialogs({ peers }));
      for (const d of res.dialogs || []) {
        if (!(d instanceof Api.Dialog) || !(d.peer instanceof Api.PeerUser)) continue;
        const key = `u${d.peer.userId}`;
        if (!this.bots.has(d.peer.userId.toString())) continue;
        this._reads.seen(key, d.readInboxMaxId);
        this._setUnread(key, d.unreadCount);
        counts[key] = d.unreadCount;
      }
    }
    if (this.group) {
      this.state.topics = await this._topics();
      for (const t of this.state.topics) counts[t.key] = t.unread;
    }
    this.emit("counts", { counts });
  }

  _countsSoon(ms = 2000) {
    clearTimeout(this._countsT);
    this._countsT = setTimeout(() => this.refreshCounts().catch(() => {}), ms);
  }

  /** Connection state from teleproto: after a drop, held marks go out and counts are read again. */
  _onConnection(u) {
    if (u.state !== UpdateConnectionState.connected) {
      this._down = true;
      return;
    }
    if (!this._down) return;
    this._down = false;
    this._reads.wake();
    this._countsSoon();
  }

  // --- group senders: small photos (cached like bot avatars) and admin badges -------------------
  /** msgId: a message u sent in the group (its photo may only be reachable through it); null for reactors. */
  _notePerson(u, msgId) {
    if (!(u instanceof Api.User)) return;
    const uid = u.id.toString();
    const photoId = u.photo && u.photo.photoId ? u.photo.photoId.toString() : null;
    const seen = this._seen.get(uid);
    if (seen && seen.photoId === photoId) return;
    this._seen.set(uid, { user: u, photoId, msgId });
    if (!photoId || this.bots.has(uid)) return; // bots already have their chat avatar
    this._avq.add(uid);
    this._drainPeople();
  }

  async _drainPeople() {
    if (this._avBusy) return;
    this._avBusy = true;
    try {
      while (this._avq.size && this.client) {
        const uid = this._avq.values().next().value;
        this._avq.delete(uid);
        const s = this._seen.get(uid);
        if (!s || !s.photoId) continue;
        const file = this.avatarDir ? path.join(this.avatarDir, `p${uid}-${s.photoId}.jpg`) : null;
        let buf = null;
        try {
          if (file) buf = fs.readFileSync(file);
        } catch {
          buf = null;
        }
        if (!buf || !buf.length) {
          buf = await this._personPhoto(s).catch(() => null);
          if (buf && file) {
            try {
              writeAtomic(file, buf);
            } catch {
              /* cache is best effort */
            }
          }
        }
        if (buf && buf.length) this._person(uid, { avatar: `data:image/jpeg;base64,${buf.toString("base64")}` });
      }
    } finally {
      this._avBusy = false;
    }
  }

  /** Group members are often "min" users; their photo is then reachable through the message they sent. */
  async _personPhoto({ user, msgId }) {
    try {
      const b = await this.client.downloadProfilePhoto(user, { isBig: false });
      if (Buffer.isBuffer(b) && b.length) return b;
    } catch {
      /* try the message-based peer below */
    }
    if (!this.group || !msgId) return null;
    const loc = new Api.InputPeerPhotoFileLocation({
      peer: new Api.InputPeerUserFromMessage({ peer: utils.getInputPeer(this.group), msgId, userId: user.id }),
      photoId: user.photo.photoId,
      big: false,
    });
    const b = await this.client.downloadFile(loc, { dcId: user.photo.dcId });
    return Buffer.isBuffer(b) && b.length ? b : null;
  }

  /** Merge into people and emit the changes in one batch. */
  _person(uid, patch) {
    this.people[uid] = { ...(this.people[uid] || {}), ...patch };
    this._peopleOut[uid] = this.people[uid];
    clearTimeout(this._peopleT);
    this._peopleT = setTimeout(() => {
      const users = this._peopleOut;
      this._peopleOut = {};
      this.emit("people", users);
    }, 150);
  }

  /** Owner/admin badges for the configured group (custom admin titles included). */
  async loadRoles() {
    if (!this.group || !this.client) return;
    this._rolesAt = Date.now();
    const res = await this.client.invoke(
      new Api.channels.GetParticipants({ channel: this.group, filter: new Api.ChannelParticipantsAdmins(), offset: 0, limit: 200, hash: helpers.returnBigInt(0) })
    );
    for (const p of res.participants || []) {
      const uid = p.userId ? p.userId.toString() : null;
      if (!uid) continue;
      if (p instanceof Api.ChannelParticipantCreator) this._person(uid, { role: "owner", rank: p.rank || undefined });
      else if (p instanceof Api.ChannelParticipantAdmin) this._person(uid, { role: "admin", rank: p.rank || undefined });
    }
  }

  _rolesSoon() {
    if (!this._rolesAt || Date.now() - this._rolesAt > 30 * 60 * 1000) this.loadRoles().catch(() => {});
  }

  async _onNew(ev) {
    const m = ev.message;
    const key = this.keyFor(m);
    if (!key) return;
    if (!m.sender && key.startsWith("t") && !m.out) {
      try {
        await m.getSender();
      } catch {
        /* name stays unknown */
      }
    }
    this._remember(key, m);
    this.emit("msg", this.ser(m, key));
    this._completeRich(key, m);
  }

  _onEdit(ev) {
    const m = ev.message;
    const key = this.keyFor(m);
    if (!key) return;
    this._remember(key, m);
    this.emit("edit", this.ser(m, key));
    this._completeRich(key, m);
  }

  _onRaw(u) {
    if (u instanceof UpdateConnectionState) return this._onConnection(u);
    // a topic was created, renamed, closed or (un)pinned in the group, here or in another client
    const inGroup = (cid) => this.group && cid !== undefined && `-100${cid}` === this.groupId;
    this._onRead(u, inGroup); // C5: chats read on another device
    const action = u instanceof Api.UpdateNewChannelMessage && u.message instanceof Api.MessageService ? u.message.action : null;
    const pinned = (u instanceof Api.UpdatePinnedForumTopic || u instanceof Api.UpdatePinnedForumTopics) && u.peer instanceof Api.PeerChannel && inGroup(u.peer.channelId);
    if (((action instanceof Api.MessageActionTopicCreate || action instanceof Api.MessageActionTopicEdit) && u.message.peerId && inGroup(u.message.peerId.channelId)) || pinned) {
      this._refreshTopicsSoon();
    }
    if (u instanceof Api.UpdateMessageReactions) this.reactions.onUpdate(u); // C9: live reaction chips
    if (u instanceof Api.UpdateUserTyping) {
      const id = u.userId.toString();
      if (this.bots.has(id)) this.emit("typing", { key: `u${id}`, action: u.action.className });
    } else if (u instanceof Api.UpdateChannelUserTyping && this.group && `-100${u.channelId}` === this.groupId) {
      this.emit("typing", { key: `t${u.topMsgId || 1}`, action: u.action.className });
    }
  }
}

module.exports = { TelegramService, KEY_RE, REF_RE, mediaInfo, buttonRows, replyOf, richOf, mediaOf };
