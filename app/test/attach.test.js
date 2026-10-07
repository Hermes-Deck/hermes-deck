"use strict";
// main/attach.js (A7 file attachments): staging from picked/dropped paths and pasted bytes, the checks
// on each (paths, folders, empty and oversized files, image sniffing), what the renderer may see,
// captions, Turkish upload errors and progress throttling. Core Node only; nothing touches the network.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const attach = require("../main/attach");
const { setLanguage } = require("../renderer/i18n");
setLanguage("tr");

const { AttachStore, checkCaption, uploadError, progressTracker, MAX_UPLOAD, MAX_PHOTO, MAX_PASTE, MAX_STAGED, MAX_CAPTION } = attach;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "deck-attach-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"); // PNG signature + IHDR start
const JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex");
const GIF = Buffer.from("47494638396101000100800000ffffff00000021", "hex");
const file = (name, bytes) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, bytes);
  return p;
};
/** A sparse file of `size` bytes starting with `head` (no real disk use on Linux/macOS). */
const sparse = (name, size, head = Buffer.alloc(0)) => {
  const p = file(name, head);
  fs.truncateSync(p, size);
  return p;
};
const SPARSE_OK = process.platform !== "win32";

test("stagePath: a real PNG/JPEG is a photo, the renderer gets a token and never the path", async () => {
  const seen = [];
  const store = new AttachStore({ preview: (it) => (seen.push(it.name), "data:image/png;base64,AAAA") });
  const v = await store.stagePath(file("ekran.png", Buffer.concat([PNG, Buffer.alloc(100)])));
  assert.match(v.token, /^[0-9a-f]{24}$/);
  assert.deepEqual({ ...v, token: "x" }, { token: "x", name: "ekran.png", size: 116, kind: "photo", risky: false, preview: "data:image/png;base64,AAAA", image: true });
  assert.ok(!JSON.stringify(v).includes(TMP), "no path in the renderer view");
  assert.deepEqual(seen, ["ekran.png"]);
  const it = store.get(v.token);
  assert.equal(it.path, path.join(TMP, "ekran.png"));
  assert.equal(it.mime, "image/png");
  assert.equal((await store.stagePath(file("foto.JPG", JPEG))).kind, "photo");
});

test("stagePath: a misnamed or non-photo image and anything else go as files", async () => {
  const store = new AttachStore();
  assert.equal((await store.stagePath(file("sahte.jpg", Buffer.from("not really a jpeg at all")))).kind, "file");
  assert.equal((await store.stagePath(file("png-icinde.jpg.txt", PNG))).kind, "file");
  assert.equal((await store.stagePath(file("hareketli.gif", GIF))).kind, "file"); // teleproto sends only png/jpg as photos
  assert.equal((await store.stagePath(file("rapor.pdf", Buffer.from("%PDF-1.7\n")))).kind, "file");
  const nopreview = await store.stagePath(file("rapor2.pdf", Buffer.from("%PDF-1.7\n")));
  assert.equal(nopreview.preview, null);
});

test("stagePath: photos over 10 MB go as files", { skip: !SPARSE_OK }, async () => {
  const store = new AttachStore();
  assert.equal((await store.stagePath(sparse("buyuk.png", MAX_PHOTO + 1, PNG))).kind, "file");
  assert.equal((await store.stagePath(sparse("sinirda.png", MAX_PHOTO, PNG))).kind, "photo");
});

test("stagePath: bad paths, folders, empty and oversized files are refused in Turkish", async () => {
  const store = new AttachStore();
  await assert.rejects(store.stagePath("goreli/yol.txt"), /Dosya okunamadı/);
  await assert.rejects(store.stagePath(path.join(TMP, "yok.txt")), /Dosya okunamadı/);
  await assert.rejects(store.stagePath(`${TMP}/a\u0000b`), /Dosya okunamadı/);
  await assert.rejects(store.stagePath(42), /Dosya okunamadı/);
  await assert.rejects(store.stagePath(""), /Dosya okunamadı/);
  await assert.rejects(store.stagePath(TMP), /Klasörler gönderilemez/);
  await assert.rejects(store.stagePath(file("bos.txt", Buffer.alloc(0))), /Dosya boş/);
  assert.equal(store.items.size, 0);
});

test("stagePath: the 2 GB limit", { skip: !SPARSE_OK }, async () => {
  const store = new AttachStore();
  await assert.rejects(store.stagePath(sparse("cok-buyuk.bin", MAX_UPLOAD + 1)), /en fazla 2 GB/);
  const ok = await store.stagePath(sparse("tam-sinir.bin", MAX_UPLOAD));
  assert.equal(ok.size, MAX_UPLOAD);
  assert.equal(ok.kind, "file");
});

test("stagePath: executables are flagged, names are made safe", async () => {
  const store = new AttachStore();
  const exe = await store.stagePath(file("kur.exe", Buffer.from("MZ")));
  assert.equal(exe.risky, true);
  assert.equal(exe.kind, "file");
  const sh = await store.stagePath(file("calistir.sh", Buffer.from("#!/bin/sh\n")));
  assert.equal(sh.risky, true);
  assert.equal((await store.stagePath(file("not.txt", Buffer.from("x")))).risky, false);
});

test("stageData: pasted bytes are sniffed; any other data is a plain file; empty and oversize data are refused", async () => {
  const store = new AttachStore();
  const v = await store.stageData({ bytes: new Uint8Array(Buffer.concat([PNG, Buffer.alloc(20)])) });
  assert.match(v.name, /^pasted-\d{8}-\d{6}\.png$/);
  assert.equal(v.kind, "photo");
  assert.equal(v.size, 36);
  const it = store.get(v.token);
  assert.ok(Buffer.isBuffer(it.buffer) && !it.path);
  assert.equal((await store.stageData({ bytes: JPEG })).name.endsWith(".jpg"), true);
  const again = await store.stageData({ bytes: PNG }); // same second, same type: a distinct name
  assert.notEqual(again.name, v.name);
  assert.match(again.name, /^pasted-\d{8}-\d{6}-\d+\.png$/);
  assert.equal((await store.stageData({ bytes: GIF })).kind, "file");
  // a view into a bigger buffer: only the viewed bytes count
  const outer = Buffer.concat([Buffer.from("junk"), PNG]);
  const view = await store.stageData({ bytes: new Uint8Array(outer.buffer, outer.byteOffset + 4, PNG.length) });
  assert.equal(view.size, PNG.length);
  // not an image: any other bytes are an ordinary file now (the type hint is display only)
  const html = await store.stageData({ bytes: Buffer.from("<script>alert(1)</script>"), name: "page.html", type: "text/html" });
  assert.deepEqual([html.name, html.kind, html.image, html.risky, html.preview], ["page.html", "file", false, false, null]);
  await assert.rejects(store.stageData({ bytes: "iVBORw0KGgo=" }), /okunamadı/);
  await assert.rejects(store.stageData(null), /okunamadı/);
  await assert.rejects(store.stageData({ bytes: new Uint8Array(0) }), /boş/);
  await assert.rejects(store.stageData({ bytes: Buffer.concat([PNG, Buffer.alloc(MAX_PASTE)]) }), /25 MB/);
});

test("staging: at most 10 files wait at once; unknown tokens are refused; discard frees room", async () => {
  const store = new AttachStore();
  const tokens = [];
  for (let i = 0; i < MAX_STAGED; i++) tokens.push((await store.stageData({ bytes: PNG })).token);
  await assert.rejects(store.stageData({ bytes: PNG }), /en fazla 10 dosya/);
  await assert.rejects(store.stagePath(file("fazla.txt", Buffer.from("x"))), /en fazla 10 dosya/);
  assert.throws(() => store.get("0".repeat(24)), /artık yok/);
  assert.throws(() => store.get(undefined), /artık yok/);
  assert.equal(store.discard(tokens[0]), true);
  assert.equal(store.discard(tokens[0]), false);
  await store.stageData({ bytes: PNG });
});

test("staging: a preview that fails or is not an image data: URL is dropped", async () => {
  const boom = new AttachStore({ preview: () => { throw new Error("decode"); } });
  assert.equal((await boom.stageData({ bytes: PNG })).preview, null);
  const remote = new AttachStore({ preview: () => "https://example.invalid/x.png" });
  assert.equal((await remote.stageData({ bytes: PNG })).preview, null);
  const html = new AttachStore({ preview: async () => "data:text/html,<b>x</b>" });
  assert.equal((await html.stageData({ bytes: PNG })).preview, null);
});

test("checkCaption: trimmed, limited to 1024 characters", () => {
  assert.equal(checkCaption(undefined), "");
  assert.equal(checkCaption(null), "");
  assert.equal(checkCaption("  merhaba \n"), "merhaba");
  assert.equal(checkCaption("x".repeat(MAX_CAPTION)).length, MAX_CAPTION);
  assert.throws(() => checkCaption("x".repeat(MAX_CAPTION + 1)), /en fazla 1024/);
  assert.throws(() => checkCaption({ text: "x" }), /geçersiz/);
});

test("uploadError: Telegram and teleproto failures in Turkish", () => {
  const rpc = (m) => Object.assign(new Error(m), { errorMessage: m });
  assert.equal(uploadError(new Error("USER_CANCELED")), "Gönderim iptal edildi.");
  assert.equal(uploadError(rpc("CHAT_SEND_MEDIA_FORBIDDEN")), "Bu sohbete dosya gönderme izni yok.");
  assert.equal(uploadError(rpc("CHAT_SEND_PHOTOS_FORBIDDEN")), "Bu sohbete dosya gönderme izni yok.");
  assert.equal(uploadError(rpc("TOPIC_CLOSED")), "Bu konu kapalı; dosya gönderilemez.");
  assert.match(uploadError(rpc("PHOTO_INVALID_DIMENSIONS")), /Dosya olarak gönder/);
  assert.match(uploadError(rpc("IMAGE_PROCESS_FAILED")), /Dosya olarak gönder/);
  assert.match(uploadError(rpc("FILE_PARTS_INVALID")), /2 GB/);
  assert.match(uploadError(rpc("FILE_PART_3_MISSING")), /yarıda kaldı/);
  assert.match(uploadError(rpc("FLOOD_WAIT_42")), /42 saniye/);
  assert.match(uploadError(rpc("SLOWMODE_WAIT_30")), /30 saniye/);
  assert.equal(uploadError(rpc("MEDIA_CAPTION_TOO_LONG")), "Açıklama çok uzun.");
  assert.match(uploadError(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })), /okunamıyor/);
  assert.match(uploadError(new Error("something odd")), /^Dosya gönderilemedi: something odd$/);
});

test("progressTracker: throttles, always reports start and end, carries teleproto's cancel flag", () => {
  let t = 0;
  const got = [];
  const p = progressTracker((f) => got.push(f), { everyMs: 200, now: () => t });
  assert.equal(p.isCanceled, false);
  p(0);
  t = 50;
  p(0.1); // too soon
  t = 250;
  p(0.2);
  t = 260;
  p(0.3); // too soon
  t = 270;
  p(1); // the end always goes out
  p(7); // clamped
  assert.deepEqual(got, [0, 0.2, 1, 1]);
  p.isCanceled = true;
  assert.equal(p.isCanceled, true);
});

test("hermesFiles: staged files of any kind become bounded deck.attach_submit entries; path-backed ones are read in main", async () => {
  const { HERMES_ATTACH } = require("../main/media");
  const store = new AttachStore();
  const img = await store.stageData({ bytes: Buffer.concat([PNG, Buffer.alloc(20)]), name: "image.png", type: "image/png" });
  const mp4 = await store.stageData({ bytes: Buffer.from("....ftypmp42....video"), name: "clip.mp4", type: "video/mp4" });
  const txt = await store.stageData({ bytes: Buffer.from("hello"), name: "notes.txt", type: "text/plain" });
  const disk = await store.stagePath(file("report.pdf", Buffer.from("%PDF-1.7 example")));
  assert.deepEqual([mp4.name, mp4.kind, mp4.image, txt.name, txt.kind, disk.name, disk.kind], ["clip.mp4", "file", false, "notes.txt", "file", "report.pdf", "file"]);
  assert.match(img.name, /^pasted-\d{8}-\d{6}\.png$/); // a bare "image.png" from a screenshot gets a readable generated name
  const { items, files } = await store.hermesFiles([img.token, mp4.token, txt.token, disk.token, txt.token]); // duplicates collapse
  assert.equal(items.length, 4);
  assert.deepEqual(files.map((f) => f.filename), [img.name, "clip.mp4", "notes.txt", "report.pdf"]);
  assert.equal(Buffer.from(files[2].content_base64, "base64").toString(), "hello");
  assert.equal(Buffer.from(files[3].content_base64, "base64").toString(), "%PDF-1.7 example");
  assert.ok(files.every((f) => Object.keys(f).sort().join() === "content_base64,filename"), "no path leaves main");
  await assert.rejects(store.hermesFiles([]), /artık yok/);
  await assert.rejects(store.hermesFiles(["0".repeat(24)]), /artık yok/);
  await assert.rejects(store.hermesFiles(Array(HERMES_ATTACH.files + 1).fill(txt.token)), /en fazla 10/);
  // a path-backed file that vanished after staging is a readable error naming the file
  const gone = await store.stagePath(file("gone.txt", Buffer.from("x")));
  fs.unlinkSync(path.join(TMP, "gone.txt"));
  await assert.rejects(store.hermesFiles([gone.token]), /gone\.txt: .*okunamadı/);
});

test("hermesFiles: per-file and per-message caps are checked before any bytes are read", { skip: !SPARSE_OK }, async () => {
  const { HERMES_ATTACH } = require("../main/media");
  const store = new AttachStore();
  const big = await store.stagePath(sparse("big.bin", HERMES_ATTACH.file + 1));
  await assert.rejects(store.hermesFiles([big.token]), /big\.bin.*25 MB/);
  const a = await store.stagePath(sparse("a.bin", HERMES_ATTACH.file));
  const b = await store.stagePath(sparse("b.bin", HERMES_ATTACH.file));
  const c = await store.stagePath(sparse("c.bin", HERMES_ATTACH.file));
  await assert.rejects(store.hermesFiles([a.token, b.token, c.token]), /50 MB/);
});

test("stageData: names and types from the page are hints; unsafe names are cleaned and executables flagged", async () => {
  const store = new AttachStore();
  const x = await store.stageData({ bytes: Buffer.from("MZ"), name: "..\\..\\evil.exe", type: "application/x-msdownload" });
  assert.ok(!/[\\/]/.test(x.name) && x.name.endsWith("evil.exe") && x.risky === true, x.name);
  const noExt = await store.stageData({ bytes: Buffer.from("data"), name: "README", type: "text/plain" });
  assert.equal(noExt.name, "README.txt");
  const none = await store.stageData({ bytes: Buffer.from("data") });
  assert.match(none.name, /^pasted-\d{8}-\d{6}\.bin$/);
  const weird = await store.stageData({ bytes: Buffer.from("data"), name: "a.txt", type: "not a mime" });
  assert.equal(weird.name, "a.txt");
  const dup = await store.stageData({ bytes: Buffer.from("data"), name: "a.txt", type: "text/plain" });
  assert.equal(dup.name, "a-2.txt");
});
