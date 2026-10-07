"use strict";
// Media preview: @image:/@file: directive parsing, the opaque-ref registry for user-sent files, the bounded
// image fetch, and the renderer's thumbnail cache / strip / lightbox. No Electron, no network, no host.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { splitMediaRefs, projectMedia } = require("../main/media-refs");
const { fetchImage, PREVIEW_MAX } = require("../main/media-fetch");
const { FileOffers } = require("../main/hermes-files");
const preview = require("../renderer/media-preview");
const I18N = require("../renderer/i18n");
beforeEach(() => I18N.setLanguage("en"));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const H = "/home/<user>/.hermes/images";

// ================================================================ A. parsing
test("A: all four quoting forms, in order, with the caption kept", () => {
  const r = splitMediaRefs(`what is this?\n\n@image:${H}/a.png\n@image:\`${H}/b b.png\`\n@image:"${H}/c.png"\n@file:'${H}/../d.pdf'`);
  assert.equal(r.text, "what is this?");
  assert.deepEqual(r.attachments.map((a) => [a.kind, a.name, a.path]), [
    ["image", "a.png", `${H}/a.png`],
    ["image", "b b.png", `${H}/b b.png`],
    ["image", "c.png", `${H}/c.png`],
    ["file", "d.pdf", null], // a ".." path is shown but never fetched
  ]);
});

test("A: images only (no caption) and a [screenshot] stand-in after the block", () => {
  const r = splitMediaRefs(`@image:${H}/a.png\n@image:${H}/b.png\n[screenshot]\n`);
  assert.equal(r.text, "");
  assert.equal(r.attachments.length, 2);
});

test("A: native-vision hints and a trailing OMH notice (what the TUI stores for a pasted image)", () => {
  const r = splitMediaRefs(`why is that?\n\n[Image attached at: ${H}/a.png]\n[Image attached at: ${H}/b.png]\n[screenshot]\n[screenshot]\n[OMH Degraded] components=x`);
  assert.equal(r.text, "why is that?\n[OMH Degraded] components=x");
  assert.deepEqual(r.attachments.map((a) => [a.kind, a.path]), [["image", `${H}/a.png`], ["image", `${H}/b.png`]]);
});

test("A: a trailing <omh-context> block is hidden and does not stop the image hints from parsing", () => {
  const r = splitMediaRefs(`order is wrong\n\n[Image attached at: ${H}/a.png]\n[screenshot]\n<omh-context>\n[System note: x]\n\n[OMH Awareness]\nline\n</omh-context>`);
  assert.equal(r.text, "order is wrong");
  assert.deepEqual(r.attachments.map((a) => a.path), [`${H}/a.png`]);
  const plain = projectMedia("s", { role: "user", text: "hi\n<omh-context>\nx\n</omh-context>" }, { offer: () => "r" });
  assert.equal(plain.text, "hi");
});

test("A: memory-context and omh-context blocks after the image hints are both hidden", () => {
  const r = splitMediaRefs(`see this\n\n[Image attached at: ${H}/a.png]\n[screenshot]\n<memory-context>\n[System note: recalled]\n- fact\n</memory-context>\n\n<omh-context>\n[OMH Awareness]\n</omh-context>`);
  assert.equal(r.text, "see this");
  assert.deepEqual(r.attachments.map((a) => a.path), [`${H}/a.png`]);
  assert.equal(splitMediaRefs("plain\n<memory-context>\nx\n</memory-context>").text, "plain");
});

test("A: Hermes' --- Attached Context --- footer is hidden and the @file: line above it becomes a file chip", () => {
  const A = "/root/.hermes/attachments";
  const stored = `prod icin server lazim mi?\n\n@file:${A}/AuthKey_X.p8\n\n--- Attached Context ---\n\n` +
    `📎 @file:${A}/AuthKey_X.p8 (application/pkcs8, 257 B) — binary file, not inlined as text. It is available on disk at \`${A}/AuthKey_X.p8\`. Use your tools.`;
  const r = splitMediaRefs(stored);
  assert.equal(r.text, "prod icin server lazim mi?");
  assert.deepEqual(r.attachments.map((a) => [a.kind, a.name, a.path]), [["file", "AuthKey_X.p8", `${A}/AuthKey_X.p8`]]);
  // an inlined text file and a warnings list are model context too
  const txt = splitMediaRefs(`read it\n@file:${A}/n.txt\n\n--- Context Warnings ---\n- big\n\n--- Attached Context ---\n\n📄 @file:${A}/n.txt (3 tokens)\n\`\`\`\nhi\n\`\`\``);
  assert.equal(txt.text, "read it");
  assert.equal(txt.attachments.length, 1);
  // with injected memory after it, and a footer-only message
  assert.equal(splitMediaRefs(`x\n@file:${A}/a.pdf\n\n--- Attached Context ---\n\n📎 y\n<memory-context>\nm\n</memory-context>`).text, "x");
  assert.equal(splitMediaRefs("plain text, no footer --- Attached Context --- inline").text, "plain text, no footer --- Attached Context --- inline");
});

test("A: a leading block (Desktop style) is parsed too", () => {
  const r = splitMediaRefs(`@image:${H}/a.png\n\nhello there`);
  assert.equal(r.text, "hello there");
  assert.equal(r.attachments.length, 1);
});

test("A: a directive inside a sentence or in the middle of the text stays text", () => {
  for (const t of [`look at @image:${H}/a.png please`, `one\n@image:${H}/a.png\ntwo`, "no directives here", `@url:https://x.test/a.png`, "email me @home"]) {
    const r = splitMediaRefs(t);
    assert.equal(r.text, t);
    assert.deepEqual(r.attachments, []);
  }
});

test("A: relative, Windows and protocol-relative refs yield an unavailable attachment, not a path", () => {
  const r = splitMediaRefs("hi\n\n@image:rel/a.png\n@image:C:\\pics\\b.png\n@image://host/share/c.png");
  assert.deepEqual(r.attachments.map((a) => [a.name, a.path]), [["a.png", null], ["b.png", null], ["c.png", null]]);
});

test("A: bounded: at most 12 attachments, control characters refuse a line", () => {
  const many = Array.from({ length: 20 }, (_, i) => `@image:${H}/${i}.png`).join("\n");
  assert.equal(splitMediaRefs(`x\n\n${many}`).attachments.length, 12);
  assert.deepEqual(splitMediaRefs(`x\n\n@image:${H}/a\u0001.png`).attachments, []);
});

test("A: projectMedia hides the lines, issues opaque refs and ignores assistant messages", () => {
  const offers = new FileOffers();
  const m = { role: "user", text: `look\n\n@image:${H}/a.png\n@file:${H}/n.txt\n@image:rel.png` };
  projectMedia("s1", m, offers);
  assert.equal(m.text, "look");
  assert.equal(m.media.length, 3);
  assert.ok(m.media.slice(0, 2).every((a) => /^[0-9a-f]{16}$/.test(a.ref)));
  assert.equal(m.media[2].ref, null);
  assert.ok(!JSON.stringify(m).includes(".hermes"), "no host path reaches the page");
  assert.equal(offers.pathOf("s1", m.media[0].ref), `${H}/a.png`);
  assert.equal(offers.pathOf("s2", m.media[0].ref), null, "a ref is bound to its session");
  const a = { role: "assistant", text: `@image:${H}/a.png` };
  projectMedia("s1", a, offers);
  assert.equal(a.media, undefined);
  assert.equal(a.text, `@image:${H}/a.png`);
});

test("A: the same message always gets the same refs (stable across reloads)", () => {
  const offers = new FileOffers();
  const mk = () => projectMedia("s1", { role: "user", text: `x\n\n@image:${H}/a.png` }, offers).media[0].ref;
  assert.equal(mk(), mk());
});

// ================================================================ B. bounded fetch
const reader = (buf, log = []) => async (offset, length) => {
  log.push([offset, length]);
  const bytes = buf.subarray(offset, offset + length);
  return { size: buf.length, offset, length: bytes.length, eof: offset + bytes.length >= buf.length, bytes };
};

test("B: a small image arrives whole, with its real mime", async () => {
  const r = await fetchImage(reader(PNG));
  assert.equal(r.ok, true);
  assert.equal(r.mime, "image/png");
  assert.deepEqual(r.bytes, PNG);
});

test("B: reads in chunks and stops early on a non-image", async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(2500, 2)]);
  const log = [];
  const r = await fetchImage(reader(big, log), { chunk: 1000 });
  assert.deepEqual(r.bytes.length, big.length);
  const text = Buffer.alloc(5000, 65);
  const log2 = [];
  const t = await fetchImage(reader(text, log2), { chunk: 1000 });
  assert.deepEqual([t.ok, t.reason], [false, "not-image"]);
  assert.ok(log2.length <= 2, "decided on the first bytes");
});

test("B: too big, refused and changing files are neutral failures, never exceptions", async () => {
  const huge = { size: PREVIEW_MAX + 1 };
  assert.deepEqual(await fetchImage(async () => huge), { ok: false, reason: "too-big" });
  assert.deepEqual(await fetchImage(async () => { throw new Error("refused"); }), { ok: false, reason: "unavailable" });
  let n = 0;
  const changing = async (offset, length) => ({ size: n++ ? 999 : PREVIEW_MAX - 1 > 100 ? PREVIEW_MAX - 1 : 100, offset, length: 0, eof: false, bytes: Buffer.alloc(0) });
  assert.equal((await fetchImage(changing, { max: 10 * 1024 * 1024 * 1024 })).ok, false);
  assert.deepEqual(await fetchImage(async () => ({ size: 3 })), { ok: false, reason: "not-image" });
});

// ================================================================ C. renderer cache, strip, lightbox
test("C: the cache evicts oldest-first past its byte and entry caps", () => {
  const c = preview.createCache({ maxBytes: 100, maxEntries: 3 });
  c.set("a", { bytes: 40 });
  c.set("b", { bytes: 40 });
  c.get("a"); // a is now the newest
  c.set("c", { bytes: 40 });
  assert.equal(c.get("b"), undefined, "b was the least recently used");
  assert.ok(c.get("a") && c.get("c"));
  assert.ok(c.bytes <= 100);
  for (const k of ["d", "e", "f"]) c.set(k, { bytes: 0 });
  assert.ok(c.size <= 3);
  c.set("big", { bytes: 1000 });
  assert.equal(c.size, 1, "a single oversize entry is still kept alone");
  c.delete("big");
  assert.equal(c.bytes, 0);
});

function el(tag, attrs, ...kids) {
  const node = { tag, attrs: attrs || {}, kids: [], listeners: {}, isConnected: true, dataset: (attrs && attrs.dataset) || {} };
  node.addEventListener = (t, f) => (node.listeners[t] = f);
  node.remove = () => (node.isConnected = false);
  node.focus = () => (world.active = node);
  node.append = (k) => node.kids.push(k);
  for (const k of kids.flat()) if (k != null) node.kids.push(k);
  return node;
}
const world = { active: null, body: null };
const walk = (n, f) => { f(n); for (const k of n.kids || []) if (k && typeof k === "object") walk(k, f); };
const find = (n, pred) => { const out = []; walk(n, (x) => pred(x) && out.push(x)); return out; };
const cls = (n, c) => String((n.attrs && n.attrs.class) || "").split(" ").includes(c);

function setup({ image }) {
  world.body = el("body");
  world.body.appendChild = (k) => world.body.kids.push(k);
  const marks = [];
  const deck = { bridge: { file: { image, download: async () => ({ status: "done", name: "a.png" }) } } };
  const HFchips = [];
  const HF = { chip: (f) => { HFchips.push(f); return el("div", { class: "file hfile" }); } };
  const mp = preview.create({ h: el, deck, mark: (...a) => marks.push(a), cleanErr: (e) => String(e.message || e), HF, document: { body: world.body, get activeElement() { return world.active; } } });
  return { mp, marks, HFchips };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const WHERE = { sid: "s1", profile: "default" };

test("C: strip draws a placeholder, loads once (no IntersectionObserver here), then a thumbnail button", async () => {
  let calls = 0;
  const url = `data:image/png;base64,${PNG.toString("base64")}`;
  const { mp, marks } = setup({ image: async () => (calls++, { ok: true, mime: "image/png", size: PNG.length, url }) });
  const m = { role: "user", text: "", media: [{ kind: "image", name: "a.png", ref: "0123456789abcdef" }] };
  let s = mp.strip(m, WHERE);
  assert.ok(find(s, (n) => cls(n, "mthumb-ph")).length === 1);
  await tick();
  mp.strip(m, WHERE);
  await tick();
  assert.equal(calls, 1, "one read per ref, however often the list redraws");
  assert.ok(marks.length >= 1, "the view is redrawn when the picture arrives");
  s = mp.strip(m, WHERE);
  const [btn] = find(s, (n) => cls(n, "mthumb"));
  assert.ok(btn, "thumbnail button");
  assert.equal(btn.attrs["aria-label"], "Open picture: a.png");
  assert.equal(find(btn, (n) => n.tag === "img")[0].attrs.src, url);
});

test("C: a refused or missing file becomes a neutral chip with the name and a retry", async () => {
  const { mp } = setup({ image: async () => ({ ok: false, reason: "unavailable" }) });
  const m = { role: "user", text: "", media: [{ kind: "image", name: "gone.png", ref: "0123456789abcdef" }] };
  mp.strip(m, WHERE);
  await tick();
  const chip = find(mp.strip(m, WHERE), (n) => cls(n, "mchip"))[0];
  assert.ok(chip);
  assert.match(chip.attrs["aria-label"], /^Image unavailable: gone\.png$/);
  assert.equal(find(chip, (n) => n.tag === "button").length, 1);
  const none = mp.strip({ role: "user", text: "", media: [{ kind: "image", name: "rel.png", ref: null }] }, WHERE);
  assert.equal(find(none, (n) => cls(n, "mchip")).length, 1, "a ref the host cannot serve is unavailable at once");
});

test("C: a too-big image falls back to the download chip, a file uses the file chip, a thrown read is a chip", async () => {
  const { mp, HFchips } = setup({ image: async (sid, ref) => { if (ref === "0000000000000001") return { ok: false, reason: "too-big" }; throw new Error("ipc"); } });
  const m = { role: "user", text: "", media: [{ kind: "image", name: "big.png", ref: "0000000000000001" }, { kind: "image", name: "x.png", ref: "0000000000000002" }, { kind: "file", name: "n.txt", ref: "0000000000000003" }] };
  mp.strip(m, WHERE);
  await tick();
  const s = mp.strip(m, WHERE);
  assert.deepEqual([...new Set(HFchips.map((f) => f.name))].sort(), ["big.png", "n.txt"]);
  assert.equal(find(s, (n) => cls(n, "mchip")).length, 1);
});

test("C: only stored user messages with media get a strip", () => {
  const { mp } = setup({ image: async () => ({ ok: false }) });
  assert.equal(mp.strip({ role: "assistant", media: [{ kind: "image", name: "a", ref: "x" }] }, WHERE), null);
  assert.equal(mp.strip({ role: "user", text: "hi" }, WHERE), null);
});

test("C: the lightbox is a modal dialog: Esc closes and returns focus, Tab stays inside, Save uses the download flow", async () => {
  const { mp } = setup({ image: async () => ({ ok: false }) });
  const opener = el("button");
  world.active = opener;
  const root = mp.openLightbox({ name: "a.png", url: "data:image/png;base64,AAAA", save: async () => ({ name: "a (1).png" }) });
  assert.equal(root.attrs.role, "dialog");
  assert.equal(root.attrs["aria-modal"], "true");
  assert.equal(root.attrs["aria-label"], "Picture: a.png");
  const [saveBtn, closeBtn] = find(root, (n) => n.tag === "button");
  assert.equal(world.active, closeBtn, "focus moves into the dialog");
  let prevented = 0;
  root.listeners.keydown({ key: "Tab", shiftKey: false, preventDefault: () => prevented++ });
  assert.equal(world.active, saveBtn);
  root.listeners.keydown({ key: "Tab", shiftKey: false, preventDefault: () => prevented++ });
  assert.equal(world.active, closeBtn);
  await saveBtn.attrs.onclick();
  const status = find(root, (n) => cls(n, "lb-status"))[0];
  assert.equal(status.textContent, "saved as a (1).png");
  root.listeners.keydown({ key: "Escape", preventDefault: () => prevented++, stopPropagation() {} });
  assert.equal(root.isConnected, false);
  assert.equal(world.active, opener, "focus goes back to what opened it");
});

test("C: the echo of a just-sent message shows the tray previews", () => {
  const { mp } = setup({ image: async () => ({ ok: false }) });
  const e = mp.echo(["data:image/png;base64,AAAA", null, "javascript:alert(1)"], ["a.png", "b.txt", "c.png"]);
  assert.equal(find(e, (n) => cls(n, "mthumb")).length, 1, "only data:image previews are drawn");
  assert.equal(mp.echo([null], ["b.txt"]), null);
});

test("C: strings exist in English and Turkish", () => {
  for (const lang of ["en", "tr"]) for (const k of ["open", "lightbox", "close", "save", "saving", "loading", "unavailable", "fileUnavailable", "notImage", "retry"]) assert.ok(I18N.tables[lang][`media.${k}`], `${lang} media.${k}`);
});

test("C: a file the host cannot serve says so as a file, not as an image", () => {
  const { mp } = setup({ image: async () => ({ ok: false }) });
  const s = mp.strip({ role: "user", text: "", media: [{ kind: "file", name: "n.txt", ref: null }] }, WHERE);
  assert.match(find(s, (n) => cls(n, "mchip"))[0].attrs["aria-label"], /^File unavailable: n\.txt$/);
});
