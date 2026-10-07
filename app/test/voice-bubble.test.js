"use strict";
// Inline voice-note player. Pure logic (audio detection, default-text hiding, clock, scrub
// maths, waveform sampling, Telegram 5-bit waveform), the bounded audio read in main, the Hermes chip/Telegram
// hooks, and the player's one-at-a-time rule against fake DOM/Audio objects. No Electron, no host.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const VB = require("../renderer/voice-bubble");
const EM = require("../renderer/echo-match");
const I18N = require("../renderer/i18n");
const { fetchAudio, sniffAudio, audioMimeForName, AUDIO_MAX } = require("../main/media-fetch");
const { splitMediaRefs, projectMedia } = require("../main/media-refs");
const { FileOffers } = require("../main/hermes-files");
beforeEach(() => I18N.setLanguage("en"));

const DEFAULT = "Please look at the attached file(s).";

// ================================================================ A. detection
test("A: isAudio by kind, mime or file name", () => {
  for (const kind of ["voice", "voice_note", "audio"]) assert.equal(VB.isAudio({ kind }), true, kind);
  assert.equal(VB.isAudio({ kind: "file", mime: "audio/ogg" }), true);
  assert.equal(VB.isAudio({ kind: "file", mime: "AUDIO/MPEG" }), true);
  for (const n of ["a.m4a", "a.MP3", "voice.wav", "x.ogg", "x.oga", "x.opus", "x.webm", "x.aac", "x.flac", "note.caf"]) assert.equal(VB.isAudio({ name: n }), true, n);
  assert.equal(VB.isAudio("clip.m4a"), true); // a bare name works too
  for (const n of ["a.png", "a.pdf", "m4a", "notes.txt", "", "a.mp4"]) assert.equal(VB.isAudio({ kind: "file", name: n }), false, n);
  assert.equal(VB.isAudio(null), false);
  assert.equal(VB.isAudio({ kind: "image", name: "a.png" }), false);
});

test("A: a generated recording name is not shown, a real file name is", () => {
  for (const n of ["voice_note.ogg", "Voice message.m4a", "audio_2026-10-07.ogg", "recording-1.m4a", "voice.wav"]) assert.equal(VB.looksLikeVoiceNote(n), true, n);
  for (const n of ["interview.m4a", "voicemail-from-ali.mp3", "podcast.mp3"]) assert.equal(VB.looksLikeVoiceNote(n), false, n);
});

// ================================================================ B. the plugin's default text
test("B: the default text hides only with audio, only when it is the whole text", () => {
  const audio = [{ kind: "file", name: "voice.m4a" }];
  assert.equal(VB.hidesDefaultText(DEFAULT, audio), true);
  assert.equal(VB.hidesDefaultText(`  ${DEFAULT}\n`, audio), true);
  assert.equal(VB.hidesDefaultText("please  look at the attached FILE(S).", audio), true, "normalized like echo-match");
  assert.equal(VB.hidesDefaultText(`${DEFAULT} Thanks`, audio), false);
  assert.equal(VB.hidesDefaultText("transcribe this", audio), false);
  assert.equal(VB.hidesDefaultText("", audio), false);
});

test("B: images and other files keep the text", () => {
  assert.equal(VB.hidesDefaultText(DEFAULT, [{ kind: "image", name: "a.png" }]), false);
  assert.equal(VB.hidesDefaultText(DEFAULT, [{ kind: "file", name: "report.pdf" }]), false);
  assert.equal(VB.hidesDefaultText(DEFAULT, []), false);
  assert.equal(VB.hidesDefaultText(DEFAULT, undefined), false);
  assert.equal(VB.hidesDefaultText(DEFAULT, [{ kind: "image", name: "a.png" }, { kind: "file", name: "v.ogg" }]), true, "any audio among the attachments");
});

test("B: echo-match exposes the same rule (DEFAULT_CAPTIONS reused, not copied)", () => {
  assert.equal(EM.isAttachDefault(DEFAULT), true);
  assert.equal(EM.isAttachDefault(`${DEFAULT}\n@file:/home/u/.hermes/v.m4a`), true, "directive lines do not count as text");
  assert.equal(EM.isAttachDefault("what do you see in this image?"), false, "the image caption is not the file default");
  assert.ok(EM.DEFAULT_CAPTIONS.includes(DEFAULT.toLowerCase()));
});

test("B: end to end with a stored row: parse, project, hide", () => {
  const raw = `${DEFAULT}\n\n@file:/home/u/.hermes/cache/voice_1.m4a`;
  const offers = new FileOffers();
  const m = projectMedia("s1", { role: "user", text: raw }, offers);
  assert.equal(m.text, DEFAULT);
  assert.deepEqual(m.media.map((a) => [a.kind, a.name]), [["file", "voice_1.m4a"]]);
  assert.match(m.media[0].ref, /^[0-9a-f]{16}$/);
  assert.equal(VB.hidesDefaultText(m.text, m.media), true);
  const pdf = projectMedia("s1", { role: "user", text: `${DEFAULT}\n@file:/home/u/a.pdf` }, offers);
  assert.equal(VB.hidesDefaultText(pdf.text, pdf.media), false);
  assert.equal(splitMediaRefs(`my own words\n@file:/h/v.m4a`).text, "my own words");
});

// ================================================================ C. clock, scrub, speed
test("C: clock floors like the recorder and survives bad input", () => {
  assert.equal(VB.clock(0), "0:00");
  assert.equal(VB.clock(7.9), "0:07");
  assert.equal(VB.clock(60), "1:00");
  assert.equal(VB.clock(125.4), "2:05");
  assert.equal(VB.clock(3599), "59:59");
  for (const bad of [NaN, Infinity, -4, undefined, null]) assert.equal(VB.clock(bad), "0:00");
});

test("C: fraction, timeAt and stepped are clamped", () => {
  assert.equal(VB.fraction(5, 10), 0.5);
  assert.equal(VB.fraction(15, 10), 1);
  assert.equal(VB.fraction(-1, 10), 0);
  assert.equal(VB.fraction(3, 0), 0);
  assert.equal(VB.timeAt(50, 100, 20), 10);
  assert.equal(VB.timeAt(-30, 100, 20), 0);
  assert.equal(VB.timeAt(500, 100, 20), 20);
  assert.equal(VB.timeAt(5, 0, 20), 0);
  assert.equal(VB.stepped(3, -5, 30), 0);
  assert.equal(VB.stepped(28, 5, 30), 30);
  assert.equal(VB.stepped(10, 5, 30), 15);
  assert.equal(VB.stepped(NaN, 5, 30), 5);
});

test("C: speed cycles 1x -> 1.5x -> 2x -> 1x", () => {
  assert.deepEqual(VB.RATES, [1, 1.5, 2]);
  assert.equal(VB.nextRate(1), 1.5);
  assert.equal(VB.nextRate(1.5), 2);
  assert.equal(VB.nextRate(2), 1);
  assert.equal(VB.nextRate(0.75), 1, "an unknown rate restarts the cycle");
  assert.deepEqual(VB.RATES.map(VB.rateLabel), ["1x", "1.5x", "2x"]);
});

// ================================================================ D. waveform
test("D: Telegram 5-bit samples round-trip through pack/unpack and base64", () => {
  const samples = Array.from({ length: 100 }, (_, i) => (i * 7) % 32);
  const packed = VB.pack5(samples);
  assert.equal(packed.length, Math.ceil((100 * 5) / 8));
  assert.deepEqual(VB.unpack5(packed).slice(0, 100), samples);
  assert.deepEqual(VB.decodeWaveform(Buffer.from(packed).toString("base64")).slice(0, 100), samples);
  assert.equal(VB.decodeWaveform(""), null);
  assert.equal(VB.decodeWaveform(null), null);
  assert.equal(VB.decodeWaveform("x".repeat(5000)), null, "an oversized value is ignored");
});

test("D: bars downsample by the loudest sample of each slice", () => {
  const samples = [0, 31, 0, 0, 16, 0, 0, 0];
  const b = VB.bars(samples, 4); // slices of 2
  assert.deepEqual(b.map((x) => Math.round(x * 31)), [31, 2.48, 16, 2.48].map((x) => Math.round(x)));
  assert.equal(b[0], 1);
  assert.ok(b.every((x) => x >= 0.08 && x <= 1), "floor keeps silence visible, ceiling is 1");
});

test("D: few samples repeat, none give a flat line, count 0 gives nothing", () => {
  const b = VB.bars([31, 0], 8);
  assert.equal(b.length, 8);
  assert.deepEqual(b.slice(0, 4), [1, 1, 1, 1]);
  assert.ok(b.slice(4).every((x) => x === 0.08));
  assert.deepEqual(VB.bars([], 3), [0.12, 0.12, 0.12]);
  assert.deepEqual(VB.bars([1, 2, 3], 0), []);
  assert.equal(VB.bars(Array(1000).fill(10), VB.BARS).length, VB.BARS);
});

test("D: decoded PCM becomes 0..31 samples, peak normalised and compressed", () => {
  const n = 4800;
  const quiet = new Float32Array(n).fill(0.01);
  const loud = new Float32Array(n);
  for (let i = 0; i < n; i++) loud[i] = i < n / 2 ? 0.8 : 0.1; // loud first half, quiet second
  const s = VB.waveformOf([loud], 8);
  assert.equal(s.length, 8);
  assert.equal(Math.max(...s), 31);
  assert.ok(s.slice(0, 4).every((x) => x === 31));
  assert.ok(s.slice(4).every((x) => x > 0 && x < 31), "the quiet half stays visible");
  assert.deepEqual(VB.waveformOf([quiet], 4), [31, 31, 31, 31], "a flat clip is peak-normalised");
  assert.deepEqual(VB.waveformOf([new Float32Array(100)], 4), [0, 0, 0, 0], "silence");
  assert.deepEqual(VB.waveformOf([], 4), []);
  const stereo = VB.waveformOf([loud, new Float32Array(n)], 8); // channels are averaged
  assert.equal(Math.max(...stereo), 31);
});

// ================================================================ E. bounded audio read (main)
const chunked = (buf, calls) => async (offset, length) => {
  calls.push([offset, length]);
  const bytes = buf.subarray(offset, Math.min(buf.length, offset + length));
  return { size: buf.length, mtime: 1, length: bytes.length, bytes };
};
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60, 3)]);

test("E: sniffAudio recognises the containers Chromium plays", () => {
  const pad = (s) => Buffer.concat([Buffer.from(s, "latin1"), Buffer.alloc(16)]);
  assert.equal(sniffAudio(OGG), "audio/ogg");
  assert.equal(sniffAudio(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(8)])), "audio/wav");
  assert.equal(sniffAudio(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A "), Buffer.alloc(8)])), "audio/mp4");
  assert.equal(sniffAudio(pad("ID3\u0004")), "audio/mpeg");
  assert.equal(sniffAudio(Buffer.from([0xff, 0xfb, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), "audio/mpeg");
  assert.equal(sniffAudio(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])), "audio/webm");
  assert.equal(sniffAudio(pad("fLaC")), "audio/flac");
  assert.equal(sniffAudio(Buffer.from("%PDF-1.7 and some more text")), null);
  assert.equal(sniffAudio(Buffer.alloc(4)), null);
  assert.equal(audioMimeForName("a.M4A"), "audio/mp4");
  assert.equal(audioMimeForName("a.pdf"), null);
});

test("E: fetchAudio reads the whole clip in host-sized chunks", async () => {
  const calls = [];
  const big = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(2500, 9)]);
  const r = await fetchAudio(chunked(big, calls), { chunk: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.mime, "audio/ogg");
  assert.ok(r.bytes.equals(big));
  assert.deepEqual(calls, [[0, 1], [0, 1000], [1000, 1000], [2000, 504]]);
});

test("E: too big is refused before any body is read; the cap is 25 MB", async () => {
  assert.equal(AUDIO_MAX, 25 * 1024 * 1024);
  const calls = [];
  const r = await fetchAudio(async (o, l) => (calls.push([o, l]), { size: AUDIO_MAX + 1, length: 1, bytes: Buffer.from([1]) }));
  assert.deepEqual(r, { ok: false, reason: "too-big" });
  assert.equal(calls.length, 1);
});

test("E: unknown bytes are not audio unless the name says so; host failures are unavailable", async () => {
  const text = Buffer.from("just some text, definitely not a clip at all");
  assert.deepEqual(await fetchAudio(chunked(text, [])), { ok: false, reason: "not-audio" });
  const named = await fetchAudio(chunked(text, []), { name: "weird.m4a" });
  assert.equal(named.ok, true);
  assert.equal(named.mime, "audio/mp4");
  assert.deepEqual(await fetchAudio(async () => { throw new Error("refused"); }), { ok: false, reason: "unavailable" });
  assert.deepEqual(await fetchAudio(async () => ({ size: 0, length: 0, bytes: Buffer.alloc(0) })), { ok: false, reason: "not-audio" });
  const lying = async (o, l) => (o === 0 && l === 1 ? { size: 100, length: 1, bytes: Buffer.from([1]) } : { size: 100, length: 5, bytes: Buffer.alloc(3) });
  assert.deepEqual(await fetchAudio(lying), { ok: false, reason: "unavailable" });
  const moved = async (o, l) => (l === 1 ? { size: 100, length: 1, bytes: Buffer.from([1]) } : { size: 120, length: l, bytes: Buffer.alloc(l) });
  assert.deepEqual(await fetchAudio(moved), { ok: false, reason: "unavailable" });
});

test("E: the IPC is guarded, ref-only and exposed in the preload; the CSP allows blob: media", () => {
  const main = fs.readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  const at = main.indexOf('ipc.handle("bridge:media-audio"');
  assert.ok(at > 0, "handler exists on the guarded ipc (ipc-guard.test.js checks the wrapper)");
  const body = main.slice(at, main.indexOf("ipc.handle(", at + 10));
  assert.match(body, /offeredPath\(s, bRef\(ref\)\)/, "a ref this session was offered, never a path from the page");
  assert.match(body, /fetchAudio\(/);
  assert.match(fs.readFileSync(path.join(__dirname, "../main/preload.js"), "utf8"), /audio: \(sid, ref, opts\) => ipcRenderer\.invoke\("bridge:media-audio"/);
  assert.match(fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8"), /media-src 'self' data: blob:/);
});

// ================================================================ F. the player (fake DOM + Audio)
class El {
  constructor(tag, attrs) {
    this.tag = tag; this.attrs = {}; this.kids = []; this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
    this.dataset = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.textContent = ""; this.isConnected = true;
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "dataset") Object.assign(this.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") this.listeners[k.slice(2)] = [v];
      else if (k === "hidden") this.hidden = !!v;
      else if (k === "disabled") this.disabled = !!v;
      else this.attrs[k] = v === true ? "" : String(v);
    }
  }
  get className() { return this.attrs.class || ""; }
  get classList() { const s = this; return { toggle(c, on) { const l = new Set(s.className.split(" ").filter(Boolean)); on ? l.add(c) : l.delete(c); s.attrs.class = [...l].join(" "); } }; }
  appendChild(k) { this.kids.push(k); return k; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  fire(t, ev = {}) { for (const f of this.listeners[t] || []) f({ preventDefault() {}, stopPropagation() {}, ...ev }); }
  getBoundingClientRect() { return { left: 0, width: 200 }; }
  focus() {}
  setPointerCapture() {}
  contains() { return false; }
  remove() { this.removed = true; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  find(pred) { return pred(this) ? this : this.kids.map((k) => k && k.find && k.find(pred)).find(Boolean) || null; }
  all(pred, out = []) { if (pred(this)) out.push(this); for (const k of this.kids) k && k.all && k.all(pred, out); return out; }
}
const h = (tag, attrs, ...kids) => {
  const el = new El(tag, attrs);
  for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.kids.push(typeof k === "string" || typeof k === "number" ? { text: String(k) } : k);
  return el;
};
const cls = (name) => (e) => e.className.split(" ").includes(name);

class FakeAudio {
  constructor() { this.listeners = {}; this.paused = true; this.currentTime = 0; this.duration = NaN; this.readyState = 0; this.playbackRate = 1; FakeAudio.all.push(this); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  emit(t) { for (const f of this.listeners[t] || []) f(); }
  removeAttribute() {}
  set src(v) { this._src = v; this.readyState = 1; this.duration = this.metaDuration ?? 12; setImmediate(() => this.emit("loadedmetadata")); }
  get src() { return this._src; }
  async play() { this.paused = false; this.emit("play"); }
  pause() { if (!this.paused) { this.paused = true; this.emit("pause"); } }
}
FakeAudio.all = [];

function world() {
  FakeAudio.all.length = 0;
  global.URL.createObjectURL = (blob) => `blob:fake/${blob.size}`;
  global.URL.revokeObjectURL = () => {};
  const marks = [];
  const loads = [];
  const player = VB.create({
    h, mark: (...a) => marks.push(a), cleanErr: (e) => String((e && e.message) || e), document: { addEventListener() {} },
    makeAudio: () => new FakeAudio(), raf: () => 1, unraf() {}, // no animation loop under Node
    decode: async (bytes) => (loads.push(bytes.length), { duration: 12, channels: [new Float32Array(2400).fill(0.5)] }),
  });
  const opts = (id, extra = {}) => ({ id, name: null, load: async () => ({ bytes: new Uint8Array(40), mime: "audio/ogg" }), ...extra });
  return { player, marks, loads, opts };
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const textOf = (el) => (el.kids || []).map((k) => (k.text !== undefined ? k.text : textOf(k))).join("");

test("F: a bubble has a play button, a keyboard-accessible slider, tabular time, a speed button and a download menu", () => {
  const w = world();
  const el = w.player.bubble(w.opts("a", { menu: () => [{ label: "Download" }] }));
  assert.equal(el.attrs.role, "group");
  const wave = el.find(cls("vb-wave"));
  assert.equal(wave.attrs.role, "slider");
  assert.equal(wave.attrs.tabindex, "0");
  assert.equal(el.find(cls("vb-play")).attrs["aria-label"], "Play");
  assert.equal(el.find(cls("vb-rate")).textContent, "1x");
  assert.ok(el.find(cls("vb-more")), "the small menu");
  assert.equal(el.find(cls("vb-time")).textContent, "0:00 / 0:00");
  assert.equal(el.all(cls("vb-bar")).length, VB.BARS * 2, "base and played layers");
  I18N.setLanguage("tr");
  assert.equal(w.player.bubble(w.opts("b")).find(cls("vb-play")).attrs["aria-label"], "Oynat");
});

test("F: Telegram duration and waveform draw before the clip is fetched", () => {
  const w = world();
  const samples = Array.from({ length: 96 }, (_, i) => Math.floor(i / 3));
  const el = w.player.bubble(w.opts("tg", { duration: 83, waveform: samples }));
  assert.equal(el.find(cls("vb-time")).textContent, "0:00 / 1:23");
  const heights = el.all(cls("vb-bar")).slice(0, VB.BARS).map((b) => b.style.props["--h"]);
  assert.ok(heights.every(Boolean));
  assert.notEqual(new Set(heights).size, 1, "not flat");
  assert.equal(FakeAudio.all.length, 0, "nothing downloaded yet");
});

test("F: Play loads the bytes, decodes the waveform, plays; pause stops; the state survives a re-render", async () => {
  const w = world();
  const first = w.player.bubble(w.opts("a"));
  first.find(cls("vb-play")).fire("click");
  await settle();
  const audio = FakeAudio.all[0];
  assert.equal(audio.paused, false);
  assert.equal(w.loads.length, 1, "decoded once");
  assert.equal(first.find(cls("vb-play")).attrs["aria-label"], "Pause");
  assert.equal(first.find(cls("vb-time")).textContent, "0:00 / 0:12");
  audio.currentTime = 6;
  audio.emit("timeupdate");
  audio.pause();
  const again = w.player.bubble(w.opts("a")); // a chat re-render builds a new element
  assert.equal(again.find(cls("vb-time")).textContent, "0:06 / 0:12", "position kept");
  assert.equal(again.find(cls("vb-on")).style.props["--p"], "50.00%");
  assert.equal(FakeAudio.all.length, 1, "one Audio per clip, never recreated");
  again.find(cls("vb-play")).fire("click");
  await settle();
  assert.equal(FakeAudio.all[0].paused, false);
  assert.equal(w.loads.length, 1, "no second decode");
});

test("F: only one clip plays at a time", async () => {
  const w = world();
  const a = w.player.bubble(w.opts("a"));
  const b = w.player.bubble(w.opts("b"));
  a.find(cls("vb-play")).fire("click");
  await settle();
  b.find(cls("vb-play")).fire("click");
  await settle();
  assert.equal(FakeAudio.all.length, 2);
  assert.equal(FakeAudio.all[0].paused, true, "the first was paused");
  assert.equal(FakeAudio.all[1].paused, false);
  assert.equal(w.player.current().id, "b");
});

test("F: keyboard: Space toggles, arrows seek 5 s (Shift 15 s), Home/End jump, and the list does not see the keys", async () => {
  const w = world();
  const el = w.player.bubble(w.opts("a"));
  const wave = el.find(cls("vb-wave"));
  let stopped = 0;
  const key = (k, extra = {}) => wave.fire("keydown", { key: k, stopPropagation: () => stopped++, ...extra });
  key(" ");
  await settle();
  const audio = FakeAudio.all[0];
  assert.equal(audio.paused, false);
  key("ArrowRight");
  assert.equal(audio.currentTime, 5);
  key("ArrowRight", { shiftKey: true });
  assert.equal(audio.currentTime, 12, "clamped to the end");
  key("ArrowLeft");
  assert.equal(audio.currentTime, 7);
  key("Home");
  assert.equal(audio.currentTime, 0);
  key("ArrowLeft");
  assert.equal(audio.currentTime, 0, "never below 0");
  key(" ");
  assert.equal(audio.paused, true);
  key("x");
  assert.equal(stopped, 7, "handled keys stop propagation, others do not");
});

test("F: click/drag on the waveform scrubs; the position is applied once the clip is loaded", async () => {
  const w = world();
  const el = w.player.bubble(w.opts("a", { duration: 20, waveform: [5, 9, 20] }));
  const wave = el.find(cls("vb-wave"));
  wave.fire("pointerdown", { clientX: 50, pointerId: 1, button: 0 });
  assert.equal(el.find(cls("vb-on")).style.props["--p"], "25.00%", "the thumb follows the pointer while dragging");
  wave.fire("pointermove", { clientX: 100 });
  wave.fire("pointerup", { clientX: 100 });
  assert.equal(el.find(cls("vb-time")).textContent, "0:10 / 0:20");
  el.find(cls("vb-play")).fire("click");
  await settle();
  assert.equal(FakeAudio.all[0].currentTime, 10 > 12 ? 12 : 10, "applied to the loaded clip");
});

test("F: speed button cycles and sets playbackRate", async () => {
  const w = world();
  const el = w.player.bubble(w.opts("a"));
  const rate = () => el.find(cls("vb-rate"));
  el.find(cls("vb-play")).fire("click");
  await settle();
  rate().fire("click");
  assert.equal(rate().textContent, "1.5x");
  assert.equal(FakeAudio.all[0].playbackRate, 1.5);
  rate().fire("click");
  assert.equal(FakeAudio.all[0].playbackRate, 2);
  rate().fire("click");
  assert.equal(FakeAudio.all[0].playbackRate, 1);
});

test("F: a clip that ends rewinds and shows Play again", async () => {
  const w = world();
  const el = w.player.bubble(w.opts("a"));
  el.find(cls("vb-play")).fire("click");
  await settle();
  const audio = FakeAudio.all[0];
  audio.currentTime = 12;
  audio.emit("ended");
  assert.equal(audio.currentTime, 0);
  assert.equal(el.find(cls("vb-play")).attrs["aria-label"], "Play");
  assert.equal(el.find(cls("vb-time")).textContent, "0:00 / 0:12");
});

test("F: too big falls back to the file chip; an unavailable clip shows an error and can be retried", async () => {
  const w = world();
  const chip = h("div", { class: "file" });
  const big = w.player.bubble(w.opts("big", { load: async () => { throw Object.assign(new Error("too big"), { reason: "too-big" }); }, fallback: () => chip }));
  big.find(cls("vb-play")).fire("click");
  await settle();
  assert.equal(w.player.bubble(w.opts("big", { fallback: () => chip })), chip, "the next render shows the chip");
  let fail = true;
  const el = w.player.bubble(w.opts("flaky", { load: async () => { if (fail) throw new Error("host said no"); return { bytes: new Uint8Array(9), mime: "audio/ogg" }; } }));
  el.find(cls("vb-play")).fire("click");
  await settle();
  assert.equal(el.find(cls("vb-err")).hidden, false);
  assert.match(textOf(el.find(cls("vb-err"))) + el.find(cls("vb-err")).textContent, /host said no/);
  assert.equal(el.attrs["aria-label"].startsWith("Voice message"), true);
  fail = false;
  el.find(cls("vb-play")).fire("click");
  await settle();
  assert.equal(FakeAudio.all.at(-1).paused, false, "retry works");
});

test("F: a pending echo bubble cannot be played", () => {
  const w = world();
  const el = w.player.bubble(w.opts("p", { pending: true }));
  assert.equal(el.find(cls("vb-play")).disabled, true);
  assert.equal(el.find(cls("vb-wave")).attrs.tabindex, "-1");
});

test("F: the download menu is built on demand", () => {
  const w = world();
  let built = 0;
  const el = w.player.bubble(w.opts("m", { menu: () => (built++, [{ label: "Download", onclick() {} }, { label: "Open", disabled: true }]) }));
  assert.equal(built, 0);
  el.find(cls("vb-more")).fire("click");
  assert.equal(built, 1);
  const menu = el.find(cls("vb-menu"));
  assert.deepEqual(menu.all(cls("vb-item")).map((b) => textOf(b)), ["Download", "Open"]);
  assert.equal(menu.all(cls("vb-item"))[1].disabled, true);
});

// ================================================================ G. Hermes chips and Telegram messages use it
test("G: a Hermes audio file chip is a voice bubble, other files stay chips", () => {
  const HF = require("../renderer/hermes-files");
  const asked = [];
  const bridge = { file: { info: async () => ({ size: 10, name: "a" }), onEvent() {}, audio: async () => ({ ok: true, bytes: new Uint8Array(4), mime: "audio/ogg" }) } };
  const calls = [];
  const VBs = { ...VB, bubble: (o) => (calls.push(o), h("div", { class: "vb" })) };
  const hf = HF.create({ h, deck: { bridge }, mark() {}, cleanErr: String, VB: VBs });
  const where = { sid: "s1", profile: "default" };
  assert.equal(hf.chip({ ref: "r1", name: "voice_1.m4a" }, where).className, "vb");
  assert.equal(calls[0].id, "h:s1:r1");
  assert.equal(calls[0].name, null, "a generated recording name is not repeated");
  assert.equal(hf.chip({ ref: "r2", name: "interview.mp3" }, where).className, "vb");
  assert.equal(calls[1].name, "interview.mp3");
  assert.match(hf.chip({ ref: "r3", name: "report.pdf" }, where).className, /\bhfile\b/);
  assert.equal(asked.length, 0);
  assert.deepEqual(calls[0].menu().map((i) => i.label), ["Download"], "Download stays available from the menu");
});

test("G: without a player or without the audio bridge the chip is unchanged", () => {
  const HF = require("../renderer/hermes-files");
  const bridge = { file: { info: async () => ({ size: 10, name: "a" }), onEvent() {} } };
  const hf = HF.create({ h, deck: { bridge }, mark() {}, cleanErr: String, VB: VB });
  assert.match(hf.chip({ ref: "r1", name: "a.m4a" }, { sid: "s", profile: "default" }).className, /\bhfile\b/);
  const hf2 = HF.create({ h, deck: { bridge: { file: { ...bridge.file, audio() {} } } }, mark() {}, cleanErr: String });
  assert.match(hf2.chip({ ref: "r1", name: "a.m4a" }, { sid: "s", profile: "default" }).className, /\bhfile\b/);
});

test("G: the plugin text is hidden for voice notes in the Hermes message view, images keep it", () => {
  const src = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
  assert.match(src, /m\.role === "user" && window\.DeckVoiceBubble && window\.DeckVoiceBubble\.hidesDefaultText\(m\.text, m\.media\) \? null :/);
  assert.match(src, /VB = window\.DeckVoiceBubble\.create\(/);
  assert.match(src, /DeckHermesFiles\.create\(\{[^}]*\bVB\b/);
  assert.match(src, /DeckMsgView\.create\(\{[^}]*\bVB\b/);
});

test("G: Telegram voice notes carry a waveform; msgview draws audio/voice with the bubble and keeps the plain player for oversized clips", () => {
  const tg = fs.readFileSync(path.join(__dirname, "../main/telegram.js"), "utf8");
  assert.match(tg, /wave: aud && aud\.voice && aud\.waveform/);
  const mv = fs.readFileSync(path.join(__dirname, "../renderer/msgview.js"), "utf8");
  assert.match(mv, /function voiceBubble\(m\)/);
  assert.match(mv, /if \(VB && !plain && \(md\.size \|\| 0\) <= MAX_FULL\) return voiceBubble\(m\)/);
  assert.match(mv, /fallback: \(\) => audio\(m, true\)/);
  assert.match(mv, /VB\.decodeWaveform\(md\.wave\)/);
});

test("G: strings and assets exist in both languages", () => {
  for (const lang of ["en", "tr"]) for (const k of ["play", "pause", "seek", "position", "speed", "more", "cantPlay", "failed"]) assert.ok(I18N.tables[lang][`vb.${k}`], `${lang} voice.${k}`);
  const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
  assert.match(html, /voice-bubble\.css/);
  assert.ok(html.indexOf("echo-match.js") < html.indexOf("voice-bubble.js") && html.indexOf("voice-bubble.js") < html.indexOf("msgview.js"));
  assert.ok(fs.existsSync(path.join(__dirname, "../renderer/voice-bubble.css")));
});

test("H: bytes from IPC come in any typed-array shape; junk is rejected", () => {
  assert.equal(VB.toBytes(new Uint8Array([1, 2])).length, 2);
  assert.equal(VB.toBytes(Buffer.from([1, 2, 3])).length, 3, "a Buffer view keeps its offset");
  assert.equal(VB.toBytes(new Uint8Array([9, 8, 7, 6]).subarray(2)).join(), "7,6");
  assert.equal(VB.toBytes(new ArrayBuffer(5)).length, 5);
  for (const bad of [null, undefined, "abc", 12, {}, []]) assert.equal(VB.toBytes(bad), null);
});

test("H: Telegram audio hides the plugin default text too; the composer tray marks audio files", () => {
  const mv = fs.readFileSync(path.join(__dirname, "../renderer/msgview.js"), "utf8");
  assert.match(mv, /!\(VB && md && VB\.hidesDefaultText\(m\.text, \[md\]\)\) \? textEl\(m\)/);
  assert.equal(VB.hidesDefaultText(DEFAULT, [{ kind: "voice" }]), true);
  assert.match(fs.readFileSync(path.join(__dirname, "../renderer/attach.js"), "utf8"), /isAudio\(it\.name\) \? "♪"/);
});
