"use strict";
// Writes test/fixtures/telegram.json: a synthetic Telegram state for fixture-mode screenshots
//   node scripts/make-fixture.js
//   npx electron . --shot=<png> --fixture=test/fixtures/telegram.json --select=t5 [--scene=menu]
// Everything is made up (names, ids, links) and every picture is drawn here in pure Node, so the file
// holds no personal data. It covers photos, a sticker, a video, a document, a voice message, an
// oversized file, group senders with owner/admin badges, replies, inline buttons, Bot API rich
// messages (built from teleproto's TL classes in test/rich-sample.js and turned into records by the
// app's own serializer), an unsupported-media fallback, a markdown table and message reactions (C9:
// MessageReactions TL objects through main/reactions.js, with reactor photos, a custom emoji and stars).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { Api, helpers } = require("teleproto");
const { TelegramService } = require("../main/telegram");
const richSample = require("../test/rich-sample");
const { reactionsOf } = require("../main/reactions");

const OUT = path.join(__dirname, "..", "test", "fixtures", "telegram.json");

// ------------------------------------------------------------------ drawing (supersampled, no fonts)
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * Math.max(0, Math.min(1, t)));
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

/** Render a scene: fn(u, v, w, h) returns [r, g, b, a?] for a point in unit coordinates (u right, v down). */
function paint(w, h, fn, ss = 3) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < ss; j++) {
        for (let i = 0; i < ss; i++) {
          const c = fn((x + (i + 0.5) / ss) / w, (y + (j + 0.5) / ss) / h, w, h);
          const al = c[3] === undefined ? 1 : c[3];
          r += c[0] * al;
          g += c[1] * al;
          b += c[2] * al;
          a += al;
        }
      }
      const o = (y * w + x) * 4;
      px[o] = a ? Math.round(r / a) : 0;
      px[o + 1] = a ? Math.round(g / a) : 0;
      px[o + 2] = a ? Math.round(b / a) : 0;
      px[o + 3] = Math.round((255 * a) / (ss * ss));
    }
  }
  return px;
}

// ------------------------------------------------------------------ PNG (Sub/Up filters keep gradients small)
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba, alpha = false) {
  const bpp = alpha ? 4 : 3;
  const stride = w * bpp;
  const raw = Buffer.alloc((stride + 1) * h);
  let prev = Buffer.alloc(stride);
  const score = (b) => {
    let s = 0;
    for (const v of b) s += v < 128 ? v : 256 - v;
    return s;
  };
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < w; x++) for (let c = 0; c < bpp; c++) row[x * bpp + c] = rgba[(y * w + x) * 4 + c];
    const sub = Buffer.alloc(stride);
    const up = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      sub[i] = (row[i] - (i >= bpp ? row[i - bpp] : 0)) & 255;
      up[i] = (row[i] - prev[i]) & 255;
    }
    const useUp = y > 0 && score(up) < score(sub);
    raw[y * (stride + 1)] = useUp ? 2 : 1;
    (useUp ? up : sub).copy(raw, y * (stride + 1) + 1);
    prev = row;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const pngUrl = (w, h, fn, alpha = false) => `data:image/png;base64,${png(w, h, paint(w, h, fn), alpha).toString("base64")}`;

// ------------------------------------------------------------------ scenes
/** Ridge landscape at dawn: sky, sun, two mountain ranges, a lake with the sun's reflection. */
function valley(u, v, w, h) {
  const asp = w / h;
  const sky = mix(hex("#24314d"), hex("#e7a57c"), v / 0.6);
  const sd = Math.hypot((u - 0.7) * asp, v - 0.4);
  let c = sd < 0.075 ? hex("#ffe2b0") : mix(sky, hex("#ffd39a"), 0.5 - sd * 2.2);
  const far = 0.5 + 0.055 * Math.sin(u * 7.1) + 0.03 * Math.sin(u * 17.3 + 1);
  const near = 0.6 + 0.05 * Math.sin(u * 5.3 + 2) + 0.025 * Math.sin(u * 13.7);
  if (v > far) c = mix(hex("#6a7898"), hex("#56627f"), (v - far) * 6);
  if (v > near) c = mix(hex("#3b4860"), hex("#2c364a"), (v - near) * 5);
  if (v > 0.76) {
    c = mix(hex("#4c5b79"), hex("#252e40"), (v - 0.76) / 0.24);
    const glint = Math.abs(u - 0.7) < 0.05 * (1 - (v - 0.76) * 2) && Math.sin(v * 160) > 0.3;
    if (glint) c = mix(c, hex("#f6c995"), 0.75);
  }
  return c;
}

/** Deterministic hash in [0, 1) for scattering stars and lit windows. */
const cell = (a, b) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** Lighthouse at dusk (portrait): stars, striped tower, lamp, a fading beam, sea. */
function lighthouse(u, v, w, h) {
  let c = mix(hex("#1b2742"), hex("#b8675a"), (v - 0.1) / 0.62);
  const cx = Math.floor(u * 18);
  const cy = Math.floor(v * 24);
  if (v < 0.5 && cell(cx, cy) > 0.72) {
    const sx = (cx + 0.2 + 0.6 * cell(cy, cx)) / 18;
    const sy = (cy + 0.2 + 0.6 * cell(cx + 7, cy + 3)) / 24;
    if (Math.hypot((u - sx) * w, (v - sy) * h) < 1.2) c = mix(c, hex("#e8e4dc"), 0.85);
  }
  const dx = u - 0.5;
  if (dx > 0.03 && Math.abs(v - 0.25) < 0.012 + dx * 0.24) c = mix(c, hex("#ffe9a8"), 0.42 * Math.max(0, 1 - dx * 1.8));
  if (v > 0.72) c = mix(hex("#24364d"), hex("#141d2b"), (v - 0.72) / 0.28);
  const half = 0.045 + (v - 0.3) * 0.11;
  if (v > 0.3 && v < 0.74 && Math.abs(u - 0.5) < half) c = Math.floor((v - 0.3) / 0.073) % 2 ? hex("#c9584a") : hex("#ece6dc");
  if (v > 0.23 && v <= 0.3 && Math.abs(u - 0.5) < 0.04) c = v < 0.27 ? hex("#ffe08a") : hex("#2b2f36");
  if (v > 0.2 && v <= 0.23 && Math.abs(u - 0.5) < 0.055 - (v - 0.2)) c = hex("#2b2f36");
  if (v > 0.74 && v < 0.78 && Math.abs(u - 0.5) < 0.16) c = hex("#3a3330");
  return c;
}

/** Night skyline with lit windows (video thumbnail). */
function skyline(u, v) {
  let c = mix(hex("#0d1420"), hex("#2a3a55"), v);
  const blocks = [
    [0.02, 0.14, 0.42],
    [0.16, 0.3, 0.3],
    [0.32, 0.4, 0.52],
    [0.43, 0.58, 0.22],
    [0.6, 0.7, 0.4],
    [0.72, 0.86, 0.28],
    [0.88, 0.98, 0.46],
  ];
  for (const [a, b, top] of blocks) {
    if (u > a && u < b && v > top) {
      c = hex("#141a24");
      const col = (u - a) * 26;
      const row = (v - top) * 16;
      const lit = cell(Math.floor(col) + a * 100, Math.floor(row)) > 0.58;
      if (lit && col % 1 > 0.3 && col % 1 < 0.7 && row % 1 > 0.35 && row % 1 < 0.75) c = hex("#e8c77a");
    }
  }
  if (v > 0.9) c = hex("#0b0f16");
  return c;
}

/** Round sticker creature on a transparent background. */
function blob(u, v) {
  const d = Math.hypot(u - 0.5, v - 0.53);
  if (d > 0.42) return [0, 0, 0, 0];
  let c = mix(hex("#f4c95d"), hex("#e2903a"), (v - 0.1) / 0.8);
  if (d > 0.4) c = hex("#7a4b1c");
  for (const ex of [0.38, 0.62]) {
    const e = Math.hypot(u - ex, v - 0.45);
    if (e < 0.075) c = hex("#ffffff");
    if (Math.hypot(u - ex - 0.015, v - 0.46) < 0.035) c = hex("#2b2f36");
  }
  const sm = Math.hypot(u - 0.5, v - 0.56);
  if (v > 0.6 && sm > 0.13 && sm < 0.16) c = hex("#7a4b1c");
  return c;
}

/** Avatar: gradient disc background with a simple emblem. */
const avatar = (c1, c2, mark) => (u, v) => {
  let c = mix(hex(c1), hex(c2), (u + v) / 2);
  const x = u - 0.5;
  const y = v - 0.5;
  const r = Math.hypot(x, y);
  const ink = hex("#f3efe6");
  if (mark === "globe" && ((r > 0.24 && r < 0.29) || (r < 0.27 && (Math.abs(y) < 0.018 || Math.abs(Math.abs(x) - 0.12 * Math.sqrt(1 - (y / 0.27) ** 2)) < 0.02)))) c = ink;
  if (mark === "quill" && Math.abs(x + y) < 0.05 && r < 0.3) c = ink;
  if (mark === "quill" && Math.abs(x - y - 0.2) < 0.02 && x > 0.05 && x < 0.28) c = ink;
  if (mark === "hex" && Math.max(Math.abs(x) * 0.87 + Math.abs(y) * 0.5, Math.abs(y)) < 0.26 && Math.max(Math.abs(x) * 0.87 + Math.abs(y) * 0.5, Math.abs(y)) > 0.2) c = ink;
  if (mark === "leaf" && Math.hypot(x - 0.07, y + 0.07) < 0.24 && Math.hypot(x + 0.07, y - 0.07) < 0.24) c = ink;
  if (mark === "peak" && y > -0.18 && y < 0.2 && Math.abs(x) < (y + 0.18) * 0.75) c = ink;
  if (mark === "wave" && Math.abs(y - 0.07 * Math.sin(x * 22)) % 0.14 < 0.035 && r < 0.3) c = ink;
  return c;
};

/** Custom emoji stand-in: a faceted teal gem on a transparent background. */
function gem(u, v) {
  const x = u - 0.5;
  const y = v - 0.5;
  if (Math.abs(x) * 1.15 + Math.abs(y + 0.08) * (y < -0.08 ? 2.2 : 1) > 0.42) return [0, 0, 0, 0];
  let c = mix(hex("#9fe3d6"), hex("#2f7f74"), (u + v) / 2);
  if (y < -0.08 && x > -0.02) c = mix(c, hex("#ffffff"), 0.25);
  if (Math.abs(x) < 0.012 || Math.abs(y + 0.08) < 0.012) c = hex("#1f5a52");
  return c;
}

// ------------------------------------------------------------------ sound + a small CSV
function wav(seconds, rate = 8000) {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t * 10) * Math.min(1, (seconds - t) * 10) * (0.35 + 0.65 * Math.sin(Math.PI * 2.6 * t) ** 2);
    const s = env * (0.6 * Math.sin(2 * Math.PI * 196 * t) + 0.28 * Math.sin(2 * Math.PI * 294 * t + 0.5) + 0.12 * Math.sin(2 * Math.PI * 392 * t));
    data[i] = 128 + Math.round(s * 92);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + n, 4);
  head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate, 28);
  head.writeUInt16LE(1, 32);
  head.writeUInt16LE(8, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(n, 40);
  return Buffer.concat([head, data]);
}
const csv = "sensor;ortalama_c;kesinti_dk\nS-01;21.4;0\nS-02;19.8;120\nS-03;22.1;35\n";

// ------------------------------------------------------------------ the conversation
const GROUP = { id: "-1009990001001", title: "Atölye" };
const ME = { id: "1000001", name: "Deniz Örnek" };
const bold = (text, part) => ({ t: "MessageEntityBold", o: text.indexOf(part), l: part.length });

// Rich messages: teleproto objects from test/rich-sample.js through TelegramService.ser(), the same
// code the app runs on what Telegram sends (a service with no client: it only needs the bot's name).
const richSvc = new TelegramService({ apiId: 1, apiHash: "x", groupChatId: GROUP.id });
richSvc.bots.set(richSample.BOT, {
  key: `u${richSample.BOT}`,
  entity: new Api.User({ id: helpers.returnBigInt(richSample.BOT), bot: true, firstName: "Atlas", username: "atlas_ornek_bot" }),
});
function richRecord(m, key, ago, extra = {}) {
  const r = richSvc.ser(m, key, new Map([[richSample.BOT, "Atlas"]]));
  const keep = Object.entries(r).filter(([k, v]) => k !== "key" && k !== "date" && k !== "id" && v !== null && v !== undefined && v !== false);
  return { id: r.id, ago, ...Object.fromEntries(keep), ...extra };
}

const voice = wav(2.4);
const csv41 = "sensor;sicaklik_c;nem\nS-01;21.4;0.62\nS-02;19.8;0.71\nS-03;22.1;0.91\n";
const media = {
  // thumbs stand in for Telegram's 800 px "x" size (scaled down to keep the file small), fulls for "y"
  "t5:101": { thumb: pngUrl(520, 341, valley), full: pngUrl(800, 524, valley) },
  "t5:102": { thumb: pngUrl(390, 520, lighthouse), full: pngUrl(480, 640, lighthouse) },
  "t5:106": { full: pngUrl(160, 160, blob, true) },
  "t5:108": { thumb: pngUrl(320, 180, skyline) },
  "u7001:203": { full: { name: "olcum-ozet.csv", data: `data:text/csv;base64,${Buffer.from(csv).toString("base64")}` } },
  "u7001:204": { full: `data:audio/wav;base64,${voice.toString("base64")}` },
  // the rich message's own photos and document, by ref ("p<i>" / "d<i>")
  "u7001:208:p0": { thumb: pngUrl(480, 314, valley), full: pngUrl(800, 524, valley) },
  "u7001:208:p1": { thumb: pngUrl(300, 400, lighthouse) },
  "u7001:208:p2": { thumb: pngUrl(400, 225, skyline) },
  "u7001:208:d0": { full: { name: "olcum-41.csv", data: `data:text/csv;base64,${Buffer.from(csv41).toString("base64")}` } },
};

const MD = [
  "## Haftalık sensör özeti",
  "",
  "Ölçümler **7 gün** boyunca toplandı; iki sensörde kısa kesinti var.",
  "",
  "| Sensör | Ortalama | Kesinti |",
  "|:--|--:|:-:|",
  "| S-01 | 21,4 °C | yok |",
  "| S-02 | 19,8 °C | 2 sa |",
  "| S-03 | 22,1 °C | 35 dk |",
  "",
  "- [x] Kalibrasyon kontrolü",
  "- [ ] S-02 pil değişimi",
  "",
  "```bash",
  "deck-export --hafta 41 --format csv",
  "```",
  "Ayrıntılar: [rapor sayfası](https://example.org/rapor)",
].join("\n");

// Reactions (C9): TL objects as Telegram sends them, turned into records by the app's own serializer.
// results: [reaction, count, chosenOrder?]; recent: [userId, reaction] (Telegram's recent_reactions).
const RE = (e) => new Api.ReactionEmoji({ emoticon: e });
const CE = (id) => new Api.ReactionCustomEmoji({ documentId: helpers.returnBigInt(id) });
const GEM = "5000000000000000001"; // a custom emoji with a picture ("emoji" below)
const NO_PIC = "5000000000000000002"; // one without: the chip draws a neutral placeholder
function reacts(results, recent = []) {
  return reactionsOf(
    new Api.MessageReactions({
      canSeeList: true,
      results: results.map(([reaction, count, chosenOrder]) => new Api.ReactionCount({ reaction, count, chosenOrder })),
      recentReactions: recent.map(([uid, reaction]) => new Api.MessagePeerReaction({ peerId: new Api.PeerUser({ userId: helpers.returnBigInt(uid) }), date: 0, reaction })),
    })
  );
}

const t9 = "Yarın 07:00'de aynı noktada buluşalım.";
const messages = {
  t1: [
    { id: 11, ago: 9000, fromId: "9001", from: "Mira Kestane", text: "Bu hafta saha programı sabitlendi, konulara göre ilerliyoruz.", ents: [] },
    { id: 12, ago: 8800, out: true, fromId: ME.id, from: ME.name, text: "Tamam, Saha notları'nı takip ediyorum.", ents: [] },
  ],
  t5: [
    { id: 5, ago: 12000, fromId: "9001", from: "Mira Kestane", text: "", ents: [], media: null, service: "Mira Kestane konuyu oluşturdu: Saha notları" },
    { id: 101, ago: 10800, fromId: "9001", from: "Mira Kestane", text: "Kuzey sırtından bu sabahki görüntü. Sis 9'da kalktı.", ents: [], media: { kind: "photo", w: 800, h: 524, size: 84000, thumb: true }, reactions: reacts([[RE("👍"), 2], [RE("❤"), 1, 0]], [[9002, RE("👍")], [9003, RE("👍")], [ME.id, RE("❤")]]) },
    { id: 102, ago: 10740, fromId: "9001", from: "Mira Kestane", text: "", ents: [], media: { kind: "photo", w: 480, h: 640, size: 61000, thumb: true } },
    { id: 103, ago: 10200, fromId: "9002", from: "Tolga Arı", text: "Harika. Ölçüm noktası tam orası mı?", ents: [], replyToId: 101, reactions: reacts([[RE("🎉"), 1234], [RE("👀"), 18]]) },
    {
      id: 104,
      ago: 9900,
      fromId: "7001",
      from: "Atlas",
      fromBot: true,
      text: "Saha raporu hazır: 3 ölçüm noktası, 1 uyarı. Onaylıyor musun?",
      ents: [],
      buttons: [
        [{ t: "cb", text: "Onayla" }, { t: "cb", text: "Reddet" }],
        [{ t: "url", text: "Raporu aç", url: "https://example.org/rapor" }, { t: "copy", text: "Kodu kopyala", copy: "SAHA-2026-0412" }],
      ],
      reactions: reacts([[RE("👍"), 5, 0], [RE("🔥"), 2], [CE(GEM), 1], [CE(NO_PIC), 1], [new Api.ReactionPaid(), 50]], [[9001, RE("👍")], [9002, RE("🔥")]]),
    },
    { id: 105, ago: 9600, fromId: "7001", from: "Atlas", fromBot: true, text: "", ents: [], media: { kind: "unsupported" } },
    { id: 106, ago: 5400, fromId: "9003", from: "Selin Ova", text: "", ents: [], media: { kind: "sticker", mime: "image/png", size: 9000, w: 160, h: 160, alt: "👍" } },
    { id: 107, ago: 3000, out: true, fromId: ME.id, from: ME.name, text: "Onayladım, akşam tekrar bakarız.", ents: [], replyToId: 104 },
    { id: 108, ago: 1200, fromId: "9002", from: "Tolga Arı", text: "Drone geçişi, ikinci tur.", ents: [], media: { kind: "video", mime: "video/mp4", name: "drone-gecis.mp4", size: 18400000, dur: 24, w: 1280, h: 720, thumb: true } },
    { id: 109, ago: 300, fromId: "9003", from: "Selin Ova", text: t9, ents: [bold(t9, "07:00")], reactions: reacts([[RE("🙏"), 1]], [[9001, RE("🙏")]]) },
    richRecord(richSample.summaryMessage(110, 5), "t5", 120, { fromBot: true }),
  ],
  u7001: [
    { id: 201, ago: 7200, out: true, fromId: ME.id, from: ME.name, text: "Son haftanın sensör özetini tablo olarak çıkarır mısın?", ents: [] },
    { id: 202, ago: 7170, fromId: "7001", from: "Atlas", fromBot: true, text: MD, ents: [] },
    { id: 203, ago: 7160, fromId: "7001", from: "Atlas", fromBot: true, text: "Ham veri ekte.", ents: [], media: { kind: "file", mime: "text/csv", name: "olcum-ozet.csv", size: Buffer.byteLength(csv) } },
    { id: 204, ago: 3600, fromId: "7001", from: "Atlas", fromBot: true, text: "", ents: [], media: { kind: "voice", mime: "audio/wav", size: voice.length, dur: 2 } },
    { id: 205, ago: 1800, fromId: "7001", from: "Atlas", fromBot: true, text: "Tam veri seti burada.", ents: [], media: { kind: "file", mime: "application/zip", name: "veri-seti.zip", size: 43000000 } },
    { id: 206, ago: 600, out: true, fromId: ME.id, from: ME.name, text: "Teşekkürler, S-02'yi bu akşam değiştiriyorum.", ents: [], replyToId: 202, reactions: reacts([[RE("👌"), 1]], [[7001, RE("👌")]]) },
    richRecord(richSample.planMessage(207), "u7001", 300),
    richRecord(richSample.photosMessage(208), "u7001", 240),
  ],
  u7002: [{ id: 301, ago: 86400, fromId: "7002", from: "Kâtip", fromBot: true, text: "Günlük özet 08:00'de gönderilecek.", ents: [] }],
  t9: [
    { id: 9, ago: 400000, fromId: "9001", from: "Mira Kestane", text: "", ents: [], media: null, service: "Mira Kestane konuyu oluşturdu: Sürümler" },
    { id: 90, ago: 300000, fromId: "7001", from: "Atlas", fromBot: true, text: "Sürüm 1.4 yayında.", ents: [] },
    { id: 91, ago: 200000, fromId: "9001", from: "Mira Kestane", text: "", ents: [], media: null, service: "Mira Kestane konuyu kapattı" },
  ],
  t12: [{ id: 12, ago: 50000, fromId: "9003", from: "Selin Ova", text: "", ents: [], media: null, service: "Selin Ova konuyu oluşturdu: Sorular" }],
};
const last = (key) => messages[key][messages[key].length - 1];

const fixture = {
  _comment: "Synthetic data for fixture-mode screenshots (scripts/make-fixture.js). No real people, chats, ids or links.",
  me: ME,
  dialogs: {
    // canManage/canDelete: this account may manage topics here (creator or admin with manage_topics)
    group: { ...GROUP, canManage: true, canDelete: true },
    forumGroups: [GROUP],
    bots: [
      { key: "u7001", id: "7001", username: "atlas_ornek_bot", title: "Atlas", unread: 0, last: last("u7001") },
      { key: "u7002", id: "7002", username: "katip_ornek_bot", title: "Kâtip", unread: 1, last: last("u7002") },
    ],
    // pinned first, as main sends them; colours are Telegram's topic icon colours
    topics: [
      { key: "t5", id: 5, title: "Saha notları", color: 0x8eee98, unread: 2, pinned: true, closed: false, last: last("t5") },
      { key: "t1", id: 1, title: "Genel", color: 0x6fb9f0, unread: 0, pinned: false, closed: false, last: last("t1") },
      { key: "t12", id: 12, title: "Sorular", color: 0xff93b2, unread: 0, pinned: false, closed: false, last: last("t12") },
      { key: "t9", id: 9, title: "Sürümler", color: 0xcb86db, unread: 0, pinned: false, closed: true, last: last("t9") },
    ],
  },
  relay: {
    agents: {
      Atlas: { name: "Atlas", bot: "atlas_ornek_bot", profile: "atlas", running: false, subsRunning: 0 },
      Kâtip: { name: "Kâtip", bot: "katip_ornek_bot", profile: "katip", running: false, subsRunning: 0 },
    },
  },
  avatars: {
    u7001: pngUrl(96, 96, avatar("#2f6f8f", "#1d3b57", "globe")),
    u7002: pngUrl(96, 96, avatar("#7a5a3a", "#3d2d1f", "quill")),
    group: pngUrl(96, 96, avatar("#4a4f7a", "#262a45", "hex")),
  },
  people: {
    // names: reactors' tooltips (main sends them with reactor photos)
    9001: { role: "owner", name: "Mira Kestane", avatar: pngUrl(96, 96, avatar("#8a5aa8", "#43305a", "leaf")) },
    9002: { name: "Tolga Arı", avatar: pngUrl(96, 96, avatar("#c7793f", "#6a3a1e", "peak")) },
    9003: { role: "admin", name: "Selin Ova", avatar: pngUrl(96, 96, avatar("#4f8f6a", "#24452f", "wave")) },
    7001: { role: "admin", rank: "ajan" },
  },
  messages,
  media,
  // "<key>:<id>:<row>:<col>" for inline keyboards, "<key>:<id>:rich:<row>:<col>" for rich message buttons
  callbacks: {
    "t5:104:0:0": { message: "Onaylandı. Rapor arşive alındı." },
    "u7001:207:rich:0:0": { message: "Plan onaylandı. Ekip bilgilendirildi." },
    "u7001:207:0:0": { message: "Plan bir gün ertelendi." },
    "t5:110:rich:0:0": { message: "Not alındı." },
  },
  // reactions (C9): the quick picker per chat key ("*": any other chat; Telegram's default first), custom
  // emoji pictures by document id, and messages whose reaction changes are refused (rollback scenes)
  reactionChoices: {
    "*": { list: ["👍", "❤", "🔥", "🎉", "👏", "😁", "🤔", "😢", "🙏", "👌", "👀", "💯", "🤝", "⚡"].map((e) => ({ t: "emoji", e })), max: 1 },
    t5: { list: [...["👍", "❤", "🔥", "🎉", "👏", "😁", "🤔", "🙏", "👌", "👀", "💯", "🤝", "⚡"].map((e) => ({ t: "emoji", e })), { t: "custom", id: GEM }], max: 1 },
  },
  emoji: { [GEM]: pngUrl(64, 64, gem, true) },
  reactFail: ["t5:109"],
  // --scene=<name>: a UI state opened after the chat renders (fixture runs only)
  scenes: {
    photos: { scroll: 101 },
    menu: { scroll: 101, menu: 101 },
    reply: { reply: 103, toast: "Bot isteği aldı." },
    lightbox: { lightbox: 101 },
    jump: { jump: 104 },
    "topic-menu": { topicMenu: "t9" },
    "topic-new": { topicForm: "create", topicTitle: "Haftalık plan" },
    "topic-rename": { topicForm: "t12" },
    "topic-delete": { topicDelete: "t9" },
    // these two run the real IPC path against the fixture (nothing leaves the process)
    "topic-create": { topicForm: "create", topicTitle: "Haftalık plan", topicSubmit: true },
    "topic-delete-run": { topicDelete: "t12", topicConfirm: true },
    // rich messages in the Atlas DM (--select=u7001): the plan, its details opened, a button pressed
    // (the real "rich" callback path against the fixture), and the media message
    rich: { scroll: 207 },
    "rich-open": { scroll: 207, richOpen: 207 },
    "rich-press": { scroll: 207, richPress: 207 },
    "rich-media": { scroll: 208 },
    // file attachments (A7): images go through the real paste path into the composer tray; "attach-send"
    // then runs the pretend upload (progress bar, cancel button)
    attach: { attach: [{ w: 1280, h: 800 }, { w: 800, h: 800 }], attachCaption: "Ekran görüntüleri ekte." },
    "attach-file": { attach: [{ w: 1280, h: 800 }], attachAsFile: true },
    "attach-send": { attach: [{ w: 1280, h: 800 }, { w: 800, h: 800 }], attachCaption: "Ekran görüntüleri ekte.", attachSend: true },
    // any file type in the tray (run with --bridge-fake --hermes-view=sessions for the direct Hermes channel)
    "attach-any": { attach: [{ w: 1280, h: 800, name: "screenshot.png" }], attachFiles: [{ name: "demo-clip.mp4", type: "video/mp4", size: 3 * 1024 * 1024 }, { name: "notes.txt", type: "text/plain", text: "Example notes for the agent.\n" }], attachCaption: "Please review these." },
    // reactions (C9) in the group topic (--select=t5): chips with photos, counts, a custom emoji, stars;
    // the quick picker; a toggle and a refused change (both through the real IPC path against the fixture)
    reactions: { scroll: 101 },
    "react-picker": { scroll: 104, react: { id: 104, picker: true } },
    "react-toggle": { scroll: 104, react: { id: 104, pick: "e:🔥" } },
    "react-rollback": { scroll: 107, react: { id: 109, pick: "e:👍" } },
  },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`fixture: ${OUT} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
