"use strict";
// Voice and file attachments: (A) dictation state machine with a fake MediaRecorder; (B) file chips parsed from assistant
// messages, the offer registry, chunked downloads (name collision, cancel, size check), the "Download folder"
// setting (default, custom, invalid), and the bridge's dictation / file_read calls against fake-stream.js.
// No Electron, no network, no SSH, no real microphone.
const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { BridgeClient } = require("../main/bridge");
const bridge = require("../main/bridge");
const files = require("../main/hermes-files");
const voice = require("../renderer/voice");
const I18N = require("../renderer/i18n");
beforeEach(() => I18N.setLanguage("en"));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "deck-voice-files-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0]);

// ================================================================ A. dictation
class FakeRecorder {
  static isTypeSupported(m) { return m === "audio/webm;codecs=opus"; }
  constructor(stream, opts) { this.stream = stream; this.opts = opts; this.mimeType = opts.mimeType || ""; this.state = "inactive"; FakeRecorder.last = this; }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    // `done` settles once the stop event has been handled, transcription included (onstop returns that promise)
    this.done = new Promise((resolve) => setImmediate(() => {
      if (!FakeRecorder.silent && this.ondataavailable) this.ondataavailable({ data: new Blob([WEBM], { type: this.mimeType }) });
      resolve(this.onstop && this.onstop());
    }));
  }
}

function world({ transcribe, now = { t: 0 }, getUserMedia } = {}) {
  const events = { states: [], errors: [], inserted: [], stopped: 0, intervals: [] };
  const track = { stop() { events.stopped++; } };
  FakeRecorder.silent = false;
  FakeRecorder.last = null;
  const d = new voice.Dictation({
    getUserMedia: getUserMedia || (async () => ({ getTracks: () => [track] })),
    Recorder: FakeRecorder,
    transcribe: transcribe || (async () => ({ text: "hello world" })),
    insert: (t) => events.inserted.push(t),
    onState: (s, info) => events.states.push(s),
    onError: (m) => events.errors.push(m),
    setInterval: (fn) => { events.intervals.push(fn); return events.intervals.length; },
    clearInterval: () => {},
    now: () => now.t,
  });
  return { d, events, now };
}
// Waits for the last recorder's stop to be handled, not for a clock: a fixed 15 ms sleep lost the race on a loaded
// machine (the clip's Blob read outlasted it and the state machine was still "transcribing").
const settle = () => (FakeRecorder.last && FakeRecorder.last.done) || Promise.resolve();

test("dictation: record, stop, transcribe, insert; the mic is released and nothing is ever sent", async () => {
  const w = world();
  assert.equal(await w.d.toggle(), true);
  assert.equal(w.d.state, "recording");
  assert.equal(FakeRecorder.last.opts.mimeType, "audio/webm;codecs=opus", "prefers webm/opus");
  w.now.t = 3000;
  await w.d.toggle();
  await settle();
  assert.equal(w.d.state, "idle");
  assert.deepEqual(w.events.inserted, ["hello world"]);
  assert.deepEqual(w.events.errors, []);
  assert.deepEqual(w.events.states, ["starting", "recording", "transcribing", "idle"]);
  assert.equal(w.events.stopped, 1, "microphone tracks stopped");
  // the state machine has no send hook at all: text only goes to insert()
  assert.equal(typeof new voice.Dictation({}).send, "undefined");
});

test("dictation: the clip handed to transcribe is the recorded bytes with their mime", async () => {
  let got;
  const w = world({ transcribe: async (bytes, mime) => { got = { bytes, mime }; return { text: "x" }; } });
  await w.d.start();
  w.now.t = 2000;
  await w.d.stop();
  await settle();
  assert.ok(got.bytes instanceof Uint8Array);
  assert.deepEqual([...got.bytes], [...WEBM]);
  assert.equal(got.mime, "audio/webm;codecs=opus");
});

test("dictation: Esc discards the audio; nothing is transcribed or inserted", async () => {
  let called = 0;
  const w = world({ transcribe: async () => { called++; return { text: "no" }; } });
  await w.d.start();
  w.now.t = 5000;
  assert.equal(w.d.cancel(), true);
  await settle();
  assert.equal(called, 0);
  assert.deepEqual(w.events.inserted, []);
  assert.equal(w.d.state, "idle");
  assert.equal(w.events.stopped, 1);
});

test("dictation: a recording stops by itself at 120 s", async () => {
  const w = world();
  await w.d.start();
  const tick = w.events.intervals[0];
  w.now.t = 60_000;
  tick();
  assert.equal(w.d.state, "recording");
  w.now.t = voice.MAX_SECONDS * 1000;
  tick();
  await settle();
  assert.deepEqual(w.events.inserted, ["hello world"]);
});

test("dictation: a too-short or empty recording is an error, not a transcription", async () => {
  let called = 0;
  const w = world({ transcribe: async () => { called++; return { text: "x" }; } });
  await w.d.start();
  w.now.t = 100;
  await w.d.stop();
  await settle();
  assert.equal(called, 0);
  assert.match(w.events.errors[0], /too short/);
  const silent = world();
  await silent.d.start();
  FakeRecorder.silent = true; // the recorder produced no data
  silent.now.t = 3000;
  await silent.d.stop();
  await settle();
  assert.match(silent.events.errors[0], /too short/);
});

test("dictation: permission denied, no microphone, busy microphone, and a failing transcription are shown as errors", async () => {
  for (const [name, re] of [["NotAllowedError", /blocked/], ["NotFoundError", /No microphone/], ["NotReadableError", /in use/]]) {
    const w = world({ getUserMedia: async () => { throw Object.assign(new Error("x"), { name }); } });
    assert.equal(await w.d.start(), false);
    assert.equal(w.d.state, "idle");
    assert.match(w.events.errors[0], re, name);
  }
  const w = world({ transcribe: async () => { throw new Error("STT is disabled in config.yaml"); } });
  await w.d.start();
  w.now.t = 2000;
  await w.d.stop();
  await settle();
  assert.equal(w.d.state, "idle");
  assert.deepEqual(w.events.inserted, []);
  assert.match(w.events.errors[0], /Dictation failed: STT is disabled/);
  const empty = world({ transcribe: async () => ({ text: "  " }) });
  await empty.d.start();
  empty.now.t = 2000;
  await empty.d.stop();
  await settle();
  assert.match(empty.events.errors[0], /No speech/);
});

test("dictation: cancelling while the permission prompt is open releases the stream when it arrives", async () => {
  let release;
  const track = { stopped: 0, stop() { this.stopped++; } };
  const w = world({ getUserMedia: () => new Promise((r) => { release = () => r({ getTracks: () => [track] }); }) });
  const started = w.d.start();
  assert.equal(w.d.state, "starting");
  assert.equal(w.d.cancel(), true);
  release();
  assert.equal(await started, false);
  assert.equal(track.stopped, 1);
  assert.equal(w.d.state, "idle");
});

test("dictation: only one at a time; abort() (connection lost) drops everything quietly", async () => {
  const w = world();
  await w.d.start();
  assert.equal(await w.d.start(), false, "a second start while recording does nothing");
  w.d.abort();
  await settle();
  assert.equal(w.d.state, "idle");
  assert.deepEqual(w.events.inserted, []);
  assert.deepEqual(w.events.errors, []);
  assert.equal(w.events.stopped, 1);
});

test("dictation: text is inserted at the cursor with natural spacing, never replacing unselected text", () => {
  assert.deepEqual(voice.insertAtCursor("", 0, 0, "hello"), { value: "hello", caret: 5 });
  assert.deepEqual(voice.insertAtCursor("Hi there", 8, 8, "friend"), { value: "Hi there friend", caret: 15 });
  assert.deepEqual(voice.insertAtCursor("Hi  you", 3, 3, "all"), { value: "Hi all you", caret: 6 }, "existing whitespace on both sides is reused, not doubled");
  assert.equal(voice.insertAtCursor("ab", 1, 1, "X").value, "a X b");
  assert.equal(voice.insertAtCursor("one two", 4, 7, "three").value, "one three", "a selection is replaced");
  assert.equal(voice.insertAtCursor("keep", 99, 99, "  ").value, "keep", "blank text changes nothing");
  assert.equal(voice.insertAtCursor("end", null, null, "x").value, "end x", "no selection info appends");
});

test("dictation: the mic strings exist in English and Turkish with matching slots", () => {
  const keys = Object.keys(I18N.tables.en).filter((k) => /^(voice|download)\./.test(k));
  assert.ok(keys.length >= 40);
  for (const k of keys) {
    assert.ok(I18N.tables.tr[k], `tr ${k}`);
    assert.deepEqual((I18N.tables.en[k].match(/\{\w+\}/g) || []).sort(), (I18N.tables.tr[k].match(/\{\w+\}/g) || []).sort(), k);
  }
});

// ================================================================ B. file references
test("refs: MEDIA: tags in all their usual wrappers", () => {
  const cases = [
    ["MEDIA:/srv/out/report.pdf", "/srv/out/report.pdf"],
    ["Here you go: MEDIA:/srv/out/report.pdf.", "/srv/out/report.pdf"],
    ["MEDIA:`/srv/out/a b.png`", "/srv/out/a b.png"],
    ['MEDIA:"/srv/out/a b.png"', "/srv/out/a b.png"],
    ["(MEDIA:/srv/out/data.csv)", "/srv/out/data.csv"],
    ["MEDIA:/srv/out/a.pngMEDIA:/srv/out/b.png", "/srv/out/a.png"],
    ["_MEDIA:/srv/out/archive.tar.gz_", "/srv/out/archive.tar.gz"],
  ];
  for (const [text, want] of cases) {
    const got = files.extractFileRefs(text).map((r) => r.path);
    assert.equal(got[0], want, text);
  }
  assert.equal(files.extractFileRefs("**MEDIA:/srv/out/emph.png**")[0].path, "/srv/out/emph.png");
  assert.deepEqual(files.extractFileRefs("MEDIA:/srv/out/a.pngMEDIA:/srv/out/b.png").map((r) => r.path), ["/srv/out/a.png", "/srv/out/b.png"]);
});

test("refs: backticked absolute paths need a directory and an extension; code blocks and junk are not offers", () => {
  const ok = files.extractFileRefs("Saved `/srv/out/notes.md` and `/srv/out/x/report.pdf`.");
  assert.deepEqual(ok.map((r) => [r.path, r.name, r.media]), [["/srv/out/notes.md", "notes.md", false], ["/srv/out/x/report.pdf", "report.pdf", false]]);
  for (const text of [
    "`/usr/bin`", "`/tmp`", "`/etc/hosts`".replace("/etc/hosts", "/hosts"), "`relative/path.txt`", "`~/notes.txt`", "`/srv/../etc/passwd.txt`",
    "`/srv/out/*.png`", "`/srv/out/$HOME/a.txt`", "`https://example.com/a/b.txt`", "plain /srv/out/notes.md in prose",
    "```\nMEDIA:/srv/out/example.pdf\n```", "```sh\ncat `/srv/out/notes.md`\n```", "`//host/share/a.txt`",
  ]) assert.deepEqual(files.extractFileRefs(text), [], text);
  assert.deepEqual(files.extractFileRefs(`MEDIA:/${"a/".repeat(600)}x.txt`), [], "over-long paths are not files");
});

test("refs: duplicates collapse (a MEDIA: use wins) and a message offers at most 8 files", () => {
  const r = files.extractFileRefs("`/srv/out/a.txt` then MEDIA:/srv/out/a.txt");
  assert.deepEqual(r.map((x) => [x.path, x.media]), [["/srv/out/a.txt", true]]);
  const many = files.extractFileRefs(Array.from({ length: 20 }, (_, i) => `MEDIA:/srv/out/f${i}.txt`).join("\n"));
  assert.equal(many.length, files.MAX_REFS);
});

test("offers: only ASSISTANT messages offer files, the page gets a ref and a name but never a path", () => {
  const offers = new files.FileOffers();
  const text = "Done: MEDIA:/srv/out/report.pdf";
  assert.deepEqual(offers.collect("s1", { role: "user", text }), []);
  assert.deepEqual(offers.collect("s1", { role: "tool", text }), []);
  assert.deepEqual(offers.collect("s1", { role: "assistant", text: 5 }), []);
  const chips = offers.collect("s1", { role: "assistant", text });
  assert.equal(chips.length, 1);
  assert.match(chips[0].ref, /^[0-9a-f]{16}$/);
  assert.equal(chips[0].name, "report.pdf");
  assert.ok(!JSON.stringify(chips).includes("/srv/out"), "no path in what the page sees");
  assert.equal(offers.pathOf("s1", chips[0].ref), "/srv/out/report.pdf");
  assert.equal(offers.pathOf("s2", chips[0].ref), null, "a ref only works in the session it was issued for");
  assert.equal(offers.pathOf("s1", "0123456789abcdef"), null, "an invented ref resolves to nothing");
  assert.equal(offers.collect("s1", { role: "assistant", text })[0].ref, chips[0].ref, "reloading history yields the same ref");
});

test("offers: bounded per session and in sessions", () => {
  const offers = new files.FileOffers();
  const first = offers.collect("s0", { role: "assistant", text: "MEDIA:/srv/out/first.txt" })[0].ref;
  for (let i = 0; i < 80; i++) offers.collect(`s${i + 1}`, { role: "assistant", text: `MEDIA:/srv/out/f${i}.txt` });
  assert.equal(offers.pathOf("s0", first), null, "the oldest session was forgotten");
  assert.ok(offers.sessions.size <= 64);
  const one = new files.FileOffers();
  for (let i = 0; i < 600; i++) one.collect("s", { role: "assistant", text: `MEDIA:/srv/out/f${i}.txt` });
  assert.ok(one.sessions.get("s").size <= 512);
});

// ================================================================ B. downloads
const chunker = (body, { size = body.length, flip } = {}) => async (offset, length) => {
  const part = body.subarray(offset, offset + length);
  return { size: flip && offset > 0 ? size + 1 : size, length: part.length, eof: offset + part.length >= body.length, bytes: part };
};
const dir = (name) => fs.mkdtempSync(path.join(TMP, `${name}-`));

test("download: chunks are assembled, the size is verified and the file lands under its name", async () => {
  const folder = dir("dl");
  const dl = new files.Downloads({ dir: folder, chunk: 1000 });
  const body = Buffer.from("abcdefghij".repeat(250)); // 2,500 bytes: three chunks
  const progress = [];
  const r = await dl.run("t-aaaaaa", { name: "report.txt", size: body.length, read: chunker(body), onProgress: (p) => progress.push(p.received) });
  assert.equal(r.status, "done");
  assert.equal(r.name, "report.txt");
  assert.deepEqual(fs.readFileSync(path.join(folder, "report.txt")), body);
  assert.equal(progress.at(-1), body.length);
  assert.deepEqual(fs.readdirSync(folder), ["report.txt"], "no .part file left");
  assert.equal(dl.pathOf(r.id), path.join(folder, "report.txt"));
  assert.ok(!JSON.stringify(r).includes(folder), "the page is told an id and a name, not a path");
});

test("download: an existing name is never overwritten: report (1).txt, report (2).txt", async () => {
  const folder = dir("dup");
  fs.writeFileSync(path.join(folder, "report.txt"), "mine");
  const dl = new files.Downloads({ dir: folder });
  const body = Buffer.from("new");
  const a = await dl.run("t-dup001", { name: "report.txt", size: 3, read: chunker(body) });
  const b = await dl.run("t-dup002", { name: "report.txt", size: 3, read: chunker(body) });
  assert.deepEqual([a.name, b.name], ["report (1).txt", "report (2).txt"]);
  assert.equal(fs.readFileSync(path.join(folder, "report.txt"), "utf8"), "mine");
});

test("download: hostile and reserved names are made safe and stay inside the folder", async () => {
  const folder = dir("names");
  const dl = new files.Downloads({ dir: folder });
  for (const name of ["../../evil.txt", "..\\..\\evil.txt", "a/b/c.txt", "CON.txt", "  .hidden. ", "", "x".repeat(400) + ".pdf"]) {
    const r = await dl.run("t-name01", { name, size: 1, read: chunker(Buffer.from("x")) });
    assert.equal(path.dirname(dl.pathOf(r.id)), folder, name);
  }
  assert.equal(files.safeFileName("CON.txt"), "_CON.txt");
  assert.ok(files.safeFileName("x".repeat(400) + ".pdf").length <= 120);
  assert.ok(files.safeFileName("x".repeat(400) + ".pdf").endsWith(".pdf"));
  assert.deepEqual(fs.readdirSync(path.dirname(folder)).filter((f) => f === "evil.txt"), []);
});

test("download: cancel stops the transfer and leaves no file behind", async () => {
  const folder = dir("cancel");
  const dl = new files.Downloads({ dir: folder, chunk: 100 });
  const body = Buffer.alloc(1000, 1);
  let calls = 0;
  const read = async (offset, length) => {
    calls++;
    if (calls === 3) dl.cancel("t-cancel");
    await sleep(2);
    return chunker(body)(offset, length);
  };
  const r = await dl.run("t-cancel", { name: "big.bin", size: body.length, read });
  assert.deepEqual(r, { status: "cancelled" });
  assert.deepEqual(fs.readdirSync(folder), []);
  assert.ok(calls < 10, "stopped early");
  assert.equal(dl.cancel("t-cancel"), false, "nothing left to cancel");
});

test("download: a changed or short file is an error and leaves nothing, a failing read too", async () => {
  const folder = dir("bad");
  const dl = new files.Downloads({ dir: folder, chunk: 100 });
  const body = Buffer.alloc(300, 2);
  await assert.rejects(dl.run("t-bad001", { name: "a.bin", size: 300, read: chunker(body, { flip: true }) }), (e) => e.code === "changed");
  await assert.rejects(dl.run("t-bad002", { name: "b.bin", size: 400, read: chunker(body, { size: 400 }) }), (e) => e.code === "incomplete" || /chunk|empty/.test(e.message));
  await assert.rejects(dl.run("t-bad003", { name: "c.bin", size: 300, read: async () => { throw new Error("connection lost"); } }), /connection lost/);
  await assert.rejects(dl.run("t-bad004", { name: "d.bin", size: 300, read: async () => ({ size: 300, length: 5, eof: false, bytes: Buffer.alloc(3) }) }), /bad chunk/);
  assert.deepEqual(fs.readdirSync(folder), []);
});

test("download: size cap, concurrency cap and an empty file", async () => {
  const folder = dir("caps");
  const dl = new files.Downloads({ dir: folder, maxActive: 1 });
  await assert.rejects(dl.run("t-cap001", { name: "x", size: files.FILE_MAX + 1, read: async () => null }), (e) => e.code === "too-big");
  let release;
  const slow = dl.run("t-cap002", { name: "slow.bin", size: 4, read: () => new Promise((r) => { release = () => r({ size: 4, length: 4, eof: true, bytes: Buffer.alloc(4) }); }) });
  await assert.rejects(dl.run("t-cap003", { name: "y", size: 1, read: chunker(Buffer.from("y")) }), (e) => e.code === "busy");
  await assert.rejects(dl.run("t-cap002", { name: "slow.bin", size: 4, read: async () => null }), /already running/);
  release();
  await slow;
  const empty = await dl.run("t-cap004", { name: "empty.txt", size: 0, read: async () => ({ size: 0, length: 0, eof: true, bytes: Buffer.alloc(0) }) });
  assert.equal(fs.statSync(path.join(folder, empty.name)).size, 0);
});

test("download: risky extensions are flagged so the page offers no Open", async () => {
  const dl = new files.Downloads({ dir: dir("risky") });
  const r = await dl.run("t-risk01", { name: "run.sh", size: 1, read: chunker(Buffer.from("x")) });
  assert.equal(r.risky, true);
  assert.equal((await dl.run("t-risk02", { name: "pic.png", size: 1, read: chunker(Buffer.from("x")) })).risky, false);
});

// ================================================================ B. the Download folder setting
test("folder: with no custom folder the default (OS Downloads + Hermes Deck) is created and used", async () => {
  const fallback = path.join(dir("os-downloads"), "Hermes Deck");
  const dl = new files.Downloads({ dir: () => files.resolveFolder({ custom: "", fallback }) });
  const r = await dl.run("t-fold01", { name: "a.txt", size: 1, read: chunker(Buffer.from("x")) });
  assert.equal(dl.pathOf(r.id), path.join(fallback, "a.txt"));
});

test("folder: a custom folder is used exactly, and never the default", async () => {
  const custom = dir("custom");
  const fallback = path.join(dir("os-downloads2"), "Hermes Deck");
  const dl = new files.Downloads({ dir: () => files.resolveFolder({ custom, fallback }) });
  const r = await dl.run("t-fold02", { name: "a.txt", size: 1, read: chunker(Buffer.from("x")) });
  assert.equal(dl.pathOf(r.id), path.join(custom, "a.txt"));
  assert.equal(fs.existsSync(fallback), false, "the default folder was not even created");
});

test("folder: a missing, non-folder, relative or unwritable custom folder is an error and nothing is written elsewhere", async () => {
  const fallback = path.join(dir("os-downloads3"), "Hermes Deck");
  const file = path.join(dir("notdir"), "plain.txt");
  fs.writeFileSync(file, "x");
  const readonly = dir("ro");
  const cases = [
    [path.join(TMP, "does-not-exist"), "missing"],
    [file, "not a folder"],
    ["relative/folder", "not an absolute path"],
  ];
  if (process.getuid && process.getuid() !== 0) { fs.chmodSync(readonly, 0o500); cases.push([readonly, "not writable"]); }
  for (const [custom, why] of cases) {
    const dl = new files.Downloads({ dir: () => files.resolveFolder({ custom, fallback }) });
    await assert.rejects(dl.run("t-fold03", { name: "a.txt", size: 1, read: chunker(Buffer.from("x")) }), (e) => e.code === "folder" && e.why === why && e.dir === custom, why);
    assert.equal(dl.active.size, 0);
  }
  assert.equal(fs.existsSync(fallback), false, "no silent fallback to the default folder");
  fs.chmodSync(readonly, 0o700);
});

test("folder: a Save As target is written exactly there (the dialog confirmed any overwrite) and cancel keeps an existing file", async () => {
  const folder = dir("saveas");
  const target = path.join(folder, "chosen.txt");
  fs.writeFileSync(target, "old");
  const dl = new files.Downloads({ dir: dir("unused") });
  const r = await dl.run("t-sav001", { name: "ignored.txt", target, size: 3, read: chunker(Buffer.from("new")) });
  assert.equal(fs.readFileSync(target, "utf8"), "new");
  assert.equal(r.name, "chosen.txt");
  fs.writeFileSync(target, "keep me");
  const body = Buffer.alloc(300, 1);
  let calls = 0;
  const read = async (o, l) => { if (++calls === 2) dl.cancel("t-sav002"); return chunker(body)(o, l); };
  const cancel = new files.Downloads({ dir: dir("unused2"), chunk: 100 });
  const c = await cancel.run("t-sav002", { name: "x", target, size: 300, read: async (o, l) => { if (++calls === 2) cancel.cancel("t-sav002"); return chunker(body)(o, l); } });
  assert.deepEqual(c, { status: "cancelled" });
  assert.equal(fs.readFileSync(target, "utf8"), "keep me", "a cancelled Save As leaves the existing file alone");
  void read;
});

// settings.js run in a vm with a stub Electron (like chat-modes.test.js)
function settingsWorld(raw) {
  let saved;
  const context = {
    module: { exports: {} }, Buffer, process: { env: {}, platform: "linux" }, URL,
    require: (id) => {
      if (id === "fs") return { readFileSync: () => { if (!raw) throw new Error("missing"); return JSON.stringify(raw); }, mkdirSync() {}, writeFileSync: (_p, v) => { saved = JSON.parse(v); }, renameSync() {} };
      if (id === "os") return { homedir: () => "/fixture-home" };
      if (id === "path") return path;
      if (id === "electron") return { app: { getPath: () => "/fixture-profile" }, safeStorage: { isEncryptionAvailable: () => false } };
      if (id === "./envfile") return { loadEnvFile() {} };
      if (id === "./bridge") return { normalizeConfig: (v) => v };
      return require(path.join(__dirname, "../main", id));
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../main/settings.js"), "utf8"), context);
  const s = new context.module.exports.Settings().load();
  return { s, saved: () => saved };
}
const plain = (x) => JSON.parse(JSON.stringify(x));

test("setting: the default is no custom folder and no asking; the page sees both", () => {
  const { s } = settingsWorld(null);
  assert.deepEqual(plain(s.publicView().downloads), { dir: "", ask: false });
});

test("setting: a custom folder and 'ask each time' persist and come back after a restart", () => {
  const { s, saved } = settingsWorld(null);
  const custom = path.join(TMP, "my-downloads");
  s.update({ downloads: { dir: custom } });
  s.update({ downloads: { ask: true } });
  assert.deepEqual(plain(s.publicView().downloads), { dir: custom, ask: true }, "setting ask keeps the folder");
  assert.deepEqual(plain(saved().downloads), { dir: custom, ask: true });
  assert.deepEqual(plain(settingsWorld(saved()).s.publicView().downloads), { dir: custom, ask: true });
});

test("setting: Reset to default clears the folder and keeps the other options", () => {
  const { s } = settingsWorld({ downloads: { dir: path.join(TMP, "x"), ask: true } });
  s.update({ downloads: { dir: "" } });
  assert.deepEqual(plain(s.publicView().downloads), { dir: "", ask: true });
  s.update({ downloads: { dir: null } });
  assert.equal(s.publicView().downloads.dir, "");
});

test("setting: an invalid folder value or flag is refused and changes nothing", () => {
  const { s } = settingsWorld({ downloads: { dir: path.join(TMP, "keep"), ask: false } });
  for (const bad of [{ dir: "relative/path" }, { dir: "~/Downloads" }, { dir: 5 }, { dir: "/ok\u0000bad" }, { dir: "/" + "a".repeat(1100) }, { dir: ["/a"] }, { ask: "yes" }, { ask: 1 }]) {
    assert.throws(() => s.update({ downloads: bad }), /not a valid download folder/, JSON.stringify(bad));
  }
  assert.deepEqual(plain(s.publicView().downloads), { dir: path.join(TMP, "keep"), ask: false });
  assert.equal(files.validFolderSetting("C:\\Users\\example\\Downloads"), true, "a Windows drive path is accepted as a setting");
  assert.equal(files.validFolderSetting("/srv/ok"), true);
});

test("setting: the Turkish strings and the Settings entry exist; the folder is never hardcoded in main", () => {
  assert.equal(I18N.tables.en["download.folder"], "Download folder");
  assert.equal(I18N.tables.tr["download.folder"], "İndirme klasörü");
  const main = fs.readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  assert.match(main, /resolveFolder\(\{ custom: settings/, "the folder comes from the setting");
  assert.match(main, /properties: \["openDirectory", "createDirectory"\]/, "a folder picker");
  assert.match(main, /downloads:reset-folder/);
  // Settings > General > Downloads (renderer/settings-view.js): folder picker, reset, ask each time
  const view = fs.readFileSync(path.join(__dirname, "../renderer/settings-view.js"), "utf8");
  assert.match(view, /bridge\.file\.pickFolder\(\)/);
  assert.match(view, /bridge\.file\.resetFolder\(\)/);
  assert.match(view, /downloads: \{ ask: on \}/);
});

// ================================================================ bridge: dictation and file_read against the fake host
const FAKE = path.join(__dirname, "fake-stream.js");
const CFG = { mode: "ssh", target: "hermes-test", python: "/usr/bin/python3", stream: "/srv/hermes/hermes-deck/stream.py" };
const FAST = { request: 2000, write: 1000, handshake: 2000, heartbeat: 1500, kill: 500, backoffMin: 40, backoffMax: 160, keepalive: 60000, transcribe: 3000 };
async function openClient(t) {
  const c = new BridgeClient(CFG, { launch: { file: process.execPath, args: [FAKE, "--serve"] }, timing: FAST });
  t.after(() => c.stop());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("never opened")), 6000);
    c.on("status", (s) => { if (s.status === "open") { clearTimeout(timer); resolve(); } });
    c.start();
  });
  return c;
}

test("bridge: dictation request shapes are validated before anything is written", () => {
  const b64 = Buffer.concat([WEBM, Buffer.alloc(20)]).toString("base64");
  bridge.checkRequest("deck.transcribe", { audio_base64: b64, mime: "audio/webm;codecs=opus" });
  for (const p of [{}, { audio_base64: b64 }, { audio_base64: "", mime: "audio/webm" }, { audio_base64: "!!!!", mime: "audio/webm" }, { audio_base64: b64, mime: "text/plain" },
    { audio_base64: b64, mime: "audio/webm", extra: 1 }, { audio_base64: 5, mime: "audio/webm" }]) {
    assert.throws(() => bridge.checkRequest("deck.transcribe", p), /cannot be transcribed/, JSON.stringify(p).slice(0, 60));
  }
  assert.throws(() => bridge.checkRequest("deck.transcribe", { audio_base64: "A".repeat(40 * 1024 * 1024), mime: "audio/webm" }), /too large/);
});

test("bridge: file_read request shapes", () => {
  const ok = { session_id: "rpc-1", path: "/srv/out/report.txt", offset: 0, length: 1024 };
  bridge.checkRequest("deck.file_read", ok);
  bridge.checkRequest("deck.file_read", { ...ok, profile: "bot-a", length: 1024 * 1024 });
  for (const p of [{}, { ...ok, path: "relative.txt" }, { ...ok, path: "~/x" }, { ...ok, path: "/x\u0000" }, { ...ok, offset: -1 }, { ...ok, offset: 1.5 }, { ...ok, length: 0 }, { ...ok, length: 1024 * 1024 + 1 },
    { ...ok, extra: 1 }, { ...ok, session_id: "a b" }, { ...ok, profile: "../x" }, { ...ok, path: "/" + "a".repeat(4100) }, { ...ok, offset: 201 * 1024 * 1024 }]) {
    assert.throws(() => bridge.checkRequest("deck.file_read", p), /not valid/, JSON.stringify(p).slice(0, 70));
  }
});

test("bridge: transcribe returns the host's text; the clip goes to the host untouched", async (t) => {
  const c = await openClient(t);
  const r = await c.transcribe(WEBM, "audio/webm;codecs=opus");
  assert.deepEqual(r, { text: "merhaba dünya", provider: "local" });
  await assert.rejects(c.transcribe(Buffer.from("not audio"), "audio/webm"), /Unsupported audio format/);
  await assert.rejects(c.transcribe(Buffer.alloc(0), "audio/webm"), /cannot be transcribed/);
  await assert.rejects(c.transcribe("a string", "audio/webm"), /cannot be transcribed/);
});

test("bridge: history marks nothing itself; fileChunk reads the offered file in chunks and refuses the rest", async (t) => {
  const c = await openClient(t);
  const h = await c.history("s-files");
  assert.equal(h.messages.length, 2);
  const a = await c.fileChunk("s-files", "/srv/example/out/report.txt", { offset: 0, length: 1000 });
  assert.deepEqual([a.size, a.length, a.eof, a.bytes.length], [3000, 1000, false, 1000]);
  const last = await c.fileChunk("s-files", "/srv/example/out/report.txt", { offset: 2000, length: 1000 });
  assert.equal(last.eof, true);
  const probe = await c.fileChunk("s-files", "/srv/example/out/report.txt", { offset: 0, length: 1 });
  assert.equal(probe.size, 3000);
  await assert.rejects(c.fileChunk("s-files", "/home/user/.ssh/id_ed25519", { offset: 0, length: 1 }), /cannot download this file/);
  await assert.rejects(c.fileChunk("s-files", "/srv/other/file.txt", { offset: 0, length: 1 }), /not offered/);
});

test("bridge + downloads end to end: a whole file through the fake host, size verified", async (t) => {
  const c = await openClient(t);
  const folder = dir("e2e");
  const dl = new files.Downloads({ dir: folder, chunk: 700 });
  const first = await c.fileChunk("s-files", "/srv/example/out/report.txt", { offset: 0, length: 1 });
  const r = await dl.run("t-e2e001", { name: "report.txt", size: first.size, read: (o, l) => c.fileChunk("s-files", "/srv/example/out/report.txt", { offset: o, length: l }) });
  assert.equal(r.status, "done");
  assert.equal(fs.readFileSync(path.join(folder, "report.txt"), "utf8"), "line of report\n".repeat(200));
});

// ================================================================ main wiring (static checks of the security-relevant lines)
test("main: the page can only reach files by an opaque ref main issued; the mic permission is for our own page and audio only", () => {
  const main = fs.readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  assert.match(main, /fileOffers\.collect\(s, m\)/, "history chips come from main's own parse");
  assert.match(main, /const offeredPath = \(sid, ref\)/);
  assert.match(main, /\/\^\[0-9a-f\]\{16\}\$\/\.test\(s\)/, "refs are checked");
  assert.doesNotMatch(main, /ipc\.handle\("bridge:file-(info|download)", async \(_e, sid, p\b/, "no raw path argument");
  assert.match(main, /const MIC_PERMISSIONS = new Set\(\["media", "microphone"\]\)/);
  assert.match(main, /startsWith\("deck:\/\/app\/"\)/);
  assert.match(main, /t === "audio"/, "never video");
  const pre = fs.readFileSync(path.join(__dirname, "../main/preload.js"), "utf8");
  assert.doesNotMatch(pre, /file: \{[^}]*\bpath\b/, "the preload exposes no path-taking file call");
});

test("main: the microphone permission handler grants only audio to the Deck's own page", () => {
  const src = fs.readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  const start = src.indexOf("const MIC_PERMISSIONS");
  const body = src.slice(start, src.indexOf("function installPermissions"));
  const micAllowed = new Function(`${body}; return micAllowed;`)();
  const page = { getURL: () => "deck://app/index.html" };
  assert.equal(micAllowed(page, "media", { requestingUrl: "deck://app/index.html", mediaTypes: ["audio"] }), true);
  assert.equal(micAllowed(page, "microphone", { requestingUrl: "deck://app/index.html" }), true);
  assert.equal(micAllowed(page, "media", { requestingUrl: "deck://app/index.html", mediaTypes: ["audio", "video"] }), false, "camera never");
  assert.equal(micAllowed(page, "media", { requestingUrl: "https://example.com/", mediaTypes: ["audio"] }), false, "another origin");
  assert.equal(micAllowed(page, "geolocation", { requestingUrl: "deck://app/index.html" }), false);
  assert.equal(micAllowed(page, "notifications", { requestingUrl: "deck://app/index.html" }), false);
  assert.equal(micAllowed(page, "media", { requestingUrl: "deck://evil/x", mediaTypes: ["audio"] }), false);
});
