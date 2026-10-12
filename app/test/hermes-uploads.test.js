"use strict";
// Large attachments on the desktop: path selection (relay + plugin on one spool), limits and messages, the strict
// deck.attach_staged validator, and the relay upload helper streaming from disk into a real relay spool.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const bridge = require("../main/bridge");
const { RelayClient, helloUploads } = require("../main/relay");
const { stagedRoute, pickRoute, sendStaged, uploadMessage } = require("../main/hermes-uploads");
const { AttachStore } = require("../main/attach");
const media = require("../main/media");
const i18n = require("../renderer/i18n");
const { UploadSpool } = require("../../relay/src/uploads");
const { createServer } = require("../../relay/src/server");

const GIB = 1024 ** 3;
const HOST = "0123456789abcdef";
const RELAY = { v: 1, host: HOST, files: 10, fileBytes: 2 * GIB, totalBytes: 4 * GIB };
const ID = (c) => c.repeat(48);
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `deck-hu-${name}-`));

test("deck.attach_staged: exact keys, 48-hex spool ids, no duplicates, the attach name rules, at most 10 files", () => {
  const ok = { session_id: "rpc-1", text: "", files: [{ upload: ID("a"), filename: "Example Game 0.42.0 WEB.rar" }] };
  bridge.checkRequest("deck.attach_staged", ok);
  assert.equal(bridge.validStaged(ok), true);
  assert.ok(bridge.MUTATIONS.includes("deck.attach_staged") && !bridge.READS.includes("deck.attach_staged"));
  const file = ok.files[0];
  const bad = [
    { ...ok, extra: 1 }, { session_id: "rpc-1", files: ok.files }, { ...ok, session_id: "a b" }, { ...ok, text: 5 }, { ...ok, text: "x".repeat(32001) },
    { ...ok, files: [] }, { ...ok, files: "x" }, { ...ok, files: Array.from({ length: 11 }, (_, i) => ({ upload: ID(i.toString(16)), filename: "a" })) },
    { ...ok, files: [file, file] }, { ...ok, files: [{ ...file, path: "/etc/passwd" }] }, { ...ok, files: [{ filename: "a" }] },
    { ...ok, files: [{ ...file, upload: ID("A") }] }, { ...ok, files: [{ ...file, upload: "a".repeat(47) }] }, { ...ok, files: [{ ...file, upload: "../../etc/passwd" }] },
    { ...ok, files: [{ ...file, filename: "../a" }] }, { ...ok, files: [{ ...file, filename: "a\nb" }] }, { ...ok, files: [{ ...file, filename: " . " }] },
    { ...ok, files: [{ ...file, filename: "x".repeat(161) }] }, { ...ok, files: [{ ...file, content_base64: "eA==" }] },
  ];
  for (const p of bad) assert.throws(() => bridge.checkRequest("deck.attach_staged", p), /Geçersiz|Invalid/, JSON.stringify(p).slice(0, 100));
  // a small request: the params cap of ordinary methods applies (no base64 ever rides here)
  assert.throws(() => bridge.checkRequest("deck.attach_staged", { ...ok, text: "x".repeat(60001) }), /60\.000|60,000|büyük|large/);
});

test("path selection: relay path only when the relay's and the plugin's spool host match; else the old 25 MB path", async () => {
  assert.deepEqual(stagedRoute(RELAY, { v: 1, host: HOST }), { files: 10, file: 2 * GIB, total: 4 * GIB });
  assert.equal(stagedRoute(RELAY, { v: 1, host: "fedcba9876543210" }), null, "another host or another folder");
  assert.equal(stagedRoute(RELAY, null), null, "an older plugin");
  assert.equal(stagedRoute(null, { v: 1, host: HOST }), null, "an older relay");
  assert.equal(stagedRoute({ ...RELAY, v: 2 }, { v: 1, host: HOST }), null);
  assert.equal(stagedRoute({ ...RELAY, fileBytes: -1 }, { v: 1, host: HOST }), null);
  assert.equal(stagedRoute({ ...RELAY, files: 50 }, { v: 1, host: HOST }).files, 10, "never more files than the plugin takes");
  assert.deepEqual(helloUploads({ ...RELAY, extra: 1 }), RELAY);
  assert.equal(helloUploads({ ...RELAY, host: "../x" }), null);
  assert.equal(helloUploads(undefined), null);

  const relay = { connected: true, uploads: RELAY, upload() {} };
  const plugin = (uploads) => ({ version: async () => ({ version: "1.3.2", protocol: 1, uploads }) });
  assert.deepEqual((await pickRoute(relay, plugin({ v: 1, host: HOST }))).limits, { files: 10, file: 2 * GIB, total: 4 * GIB });
  assert.equal(await pickRoute(relay, plugin(null)), null, "plugin without staged uploads");
  assert.equal(await pickRoute(relay, plugin({ v: 1, host: "fedcba9876543210" })), null, "host mismatch");
  assert.equal(await pickRoute({ ...relay, connected: false }, plugin({ v: 1, host: HOST })), null, "relay offline");
  assert.equal(await pickRoute(null, plugin({ v: 1, host: HOST })), null, "no relay configured");
  assert.equal(await pickRoute({ connected: true, uploads: RELAY }, plugin({ v: 1, host: HOST })), null, "a fixture relay without uploads");
  assert.equal(await pickRoute(relay, { version: async () => { throw new Error("offline"); } }), null);
  assert.equal(await pickRoute(relay, { version: async () => ({ legacy: true }) }), null);
});

test("limits and messages: 2 GB per file on the relay path, the old 25 MB message otherwise; big files are never read", async (t) => {
  i18n.setLanguage("en");
  t.after(() => i18n.setLanguage("en"));
  assert.equal(media.human(2 * GIB), "2 GB");
  assert.equal(media.human(4 * GIB), "4 GB");
  assert.equal(media.human(1.5 * GIB), "1.5 GB");
  assert.equal(media.human(25 * 1024 * 1024), "25 MB");
  const dir = tmp("limits");
  const sparse = (name, size) => { const p = path.join(dir, name); const fd = fs.openSync(p, "w"); fs.ftruncateSync(fd, Math.floor(size)); fs.closeSync(fd); return p; };
  const store = new AttachStore();
  store.maxUpload = 2 * GIB;
  const big = await store.stagePath(sparse("game.rar", 1.9 * GIB)); // over Telegram's 2000 MB, under the relay's 2 GiB
  const huge = await store.stagePath(sparse("huge.rar", 2 * GIB + 1)).catch((e) => e);
  assert.match(huge.message, /2 GB per file/);
  const limits = { files: 10, file: 2 * GIB, total: 4 * GIB };
  const realRead = fs.readFileSync, realPromise = fs.promises.readFile;
  fs.readFileSync = (p, ...a) => { if (String(p).startsWith(dir)) throw new Error("read whole"); return realRead(p, ...a); };
  fs.promises.readFile = (p, ...a) => (String(p).startsWith(dir) ? Promise.reject(new Error("read whole")) : realPromise(p, ...a));
  try {
    const items = store.hermesItems([big.token], limits);
    assert.equal(items.length, 1);
    assert.equal(items[0].size, Math.floor(1.9 * GIB));
    assert.equal(items[0].path, path.join(dir, "game.rar"));
    fs.truncateSync(path.join(dir, "game.rar"), 2 * GIB + 10); // grew after it was staged
    assert.throws(() => store.hermesItems([big.token], limits), /game\.rar is too large for Hermes \(limit 2 GB per file\)/);
    const small = await store.stagePath(sparse("a.bin", 1.5 * GIB));
    const other = await store.stagePath(sparse("b.bin", 1.5 * GIB));
    const third = await store.stagePath(sparse("c.bin", 1.5 * GIB));
    assert.throws(() => store.hermesItems([small.token, other.token, third.token], limits), /limit 4 GB in total/);
    // the old path keeps its numbers and its message
    await assert.rejects(store.hermesFiles([small.token]), /a\.bin is too large for Hermes \(limit 25 MB per file\)/);
  } finally {
    fs.readFileSync = realRead;
    fs.promises.readFile = realPromise;
  }
});

async function relayFor(t) {
  const dir = tmp("relay");
  const token = "t".repeat(32);
  const spool = new UploadSpool({ dir: path.join(dir, "spool"), machine: "m" });
  const model = { snapshot: () => ({ sessions: [] }), tokens: () => ({}), sessions: new Map() };
  const srv = createServer({ token, model, fleet: { data: {} }, version: "test", uploads: spool });
  await new Promise((resolve) => srv.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { spool.stop(); await new Promise((resolve) => srv.server.close(resolve)); });
  const client = new RelayClient({ url: `ws://127.0.0.1:${srv.server.address().port}`, token });
  return { client, spool, dir };
}

test("upload helper: streams a file into the relay spool with progress (fs.createReadStream, no whole read)", async (t) => {
  const { client, spool, dir } = await relayFor(t);
  const file = path.join(dir, "big archive.rar");
  const size = 48 * 1024 * 1024;
  const fd = fs.openSync(file, "w");
  fs.writeSync(fd, Buffer.from("Rar!"), 0, 4, 0);
  fs.ftruncateSync(fd, size);
  fs.closeSync(fd);
  const realRead = fs.readFileSync, realPromise = fs.promises.readFile, realStream = fs.createReadStream;
  const streamed = [];
  fs.readFileSync = (p, ...a) => { if (p === file) throw new Error("read whole"); return realRead(p, ...a); };
  fs.promises.readFile = (p, ...a) => (p === file ? Promise.reject(new Error("read whole")) : realPromise(p, ...a));
  fs.createReadStream = (p, ...a) => { streamed.push(p); return realStream(p, ...a); };
  const seen = [];
  let result;
  try {
    result = await client.upload({ path: file, name: "big archive.rar", mime: "application/vnd.rar", size }, { onProgress: (p) => seen.push(p) });
  } finally {
    fs.readFileSync = realRead;
    fs.promises.readFile = realPromise;
    fs.createReadStream = realStream;
  }
  assert.match(result.id, /^[a-f0-9]{48}$/);
  assert.deepEqual(streamed, [file]);
  assert.ok(seen.length > 4, "progress follows the stream");
  assert.deepEqual([...seen].sort((a, b) => a - b), seen, "monotonic");
  assert.equal(seen.at(-1), 1);
  assert.equal(fs.statSync(spool.file(result.id, "bin")).size, size);
  assert.equal(fs.readFileSync(spool.file(result.id, "bin")).subarray(0, 4).toString(), "Rar!");
  // pasted bytes go from the buffer
  const pasted = await client.upload({ buffer: Buffer.from("hello"), name: "pasted.txt", mime: "text/plain", size: 5 });
  assert.equal(fs.readFileSync(spool.file(pasted.id, "bin"), "utf8"), "hello");
  assert.equal(await client.deleteUpload(pasted.id), true);
  assert.equal(fs.existsSync(spool.file(pasted.id, "bin")), false);
});

test("upload helper: cancel mid-upload and relay refusals are upload errors; the relay keeps nothing", async (t) => {
  const { client, spool, dir } = await relayFor(t);
  const file = path.join(dir, "big.bin");
  fs.writeFileSync(file, Buffer.alloc(32 * 1024 * 1024, 1));
  const controller = new AbortController();
  const upload = client.upload({ path: file, name: "big.bin", mime: "application/octet-stream", size: 32 * 1024 * 1024 }, {
    signal: controller.signal, onProgress: (p) => { if (p > 0.1) controller.abort(); },
  });
  await assert.rejects(upload, (e) => e.relayUpload === true && e.code === "canceled");
  const deadline = Date.now() + 5000;
  while (fs.readdirSync(spool.dir).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fs.readdirSync(spool.dir), []);
  assert.equal(spool.desktop.uploads.size, 0);
  // over the relay's per-file limit: refused before any byte moves
  spool.fileBytes = 10;
  await assert.rejects(client.upload({ path: file, name: "big.bin", mime: "application/octet-stream", size: 11 }), (e) => e.relayUpload && e.status === 400);
  spool.fileBytes = 2 * GIB;
  spool.minFree = Number.MAX_SAFE_INTEGER;
  const full = await client.upload({ path: file, name: "big.bin", mime: "application/octet-stream", size: 5 }).catch((e) => e);
  assert.deepEqual([full.relayUpload, full.status, full.code], [true, 507, "disk_full"]);
  i18n.setLanguage("en");
  assert.equal(uploadMessage(full, "big.bin"), "Not enough free disk space on the Hermes host for big.bin.");
  assert.equal(uploadMessage({ relayUpload: true, code: "canceled" }, "x"), i18n.tables.en.U0018);
  assert.equal(uploadMessage(new Error("Hermes said no"), "x"), null, "Hermes errors are not rewritten");
});

test("sendStaged: uploads in order, names only the ids to the bridge, cleans the relay; unknown outcomes are kept", async () => {
  const calls = [];
  const relay = {
    n: 0,
    async upload(source, { onProgress }) { calls.push(["upload", source.name, source.path, !!source.buffer]); if (onProgress) onProgress(0.5); return { id: ID(String(++this.n)) }; },
    async deleteUpload(id) { calls.push(["delete", id]); return true; },
  };
  const items = [{ token: "t1", name: "game.rar", size: 10, path: "/srv/example/game.rar" }, { token: "t2", name: "pasted.txt", size: 5, buffer: Buffer.from("hello"), mime: "text/plain" }];
  const progress = [];
  let sent;
  const ok = { send: async (sid, text, options) => { sent = { sid, text, options }; return { status: "streaming" }; } };
  const result = await sendStaged({ relay, bridge: ok, items, sid: "s1", text: "look", profile: "default", progress: (token, p) => progress.push([token, p]) });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(result, { status: "streaming" });
  assert.deepEqual(sent, { sid: "s1", text: "look", options: { profile: "default", staged: [{ upload: ID("1"), filename: "game.rar" }, { upload: ID("2"), filename: "pasted.txt" }] } });
  assert.deepEqual(calls.slice(0, 2), [["upload", "game.rar", "/srv/example/game.rar", false], ["upload", "pasted.txt", null, true]]);
  assert.deepEqual(calls.slice(2).map((c) => c[0]), ["delete", "delete"]);
  assert.deepEqual(progress, [["t1", 0.5], ["t1", 1], ["t2", 0.5], ["t2", 1]]);

  calls.length = 0;
  const refused = { send: async () => { throw Object.assign(new Error("session not found"), { rpcCode: 4001 }); } };
  await assert.rejects(sendStaged({ relay, bridge: refused, items, sid: "s1", text: "", profile: "default" }), /session not found/);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.filter((c) => c[0] === "delete").length, 2, "a definite refusal deletes the uploads");

  calls.length = 0;
  const lost = { send: async () => { throw new Error("timeout"); } };
  await assert.rejects(sendStaged({ relay, bridge: lost, items, sid: "s1", text: "", profile: "default" }), /timeout/);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.filter((c) => c[0] === "delete").length, 0, "the plugin may still be moving them: left to the relay's TTL");

  calls.length = 0;
  const failing = { ...relay, n: 0, async upload(source) { if (source.name === "pasted.txt") throw Object.assign(new Error("no space"), { relayUpload: true, status: 507, code: "disk_full" }); return relay.upload.call(this, source, { onProgress() {} }); } };
  i18n.setLanguage("en");
  await assert.rejects(sendStaged({ relay: failing, bridge: ok, items, sid: "s1", text: "", profile: "default" }), /Not enough free disk space on the Hermes host for pasted\.txt/);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.filter((c) => c[0] === "delete").length, 1, "the finished upload is deleted when a later one fails");
});
