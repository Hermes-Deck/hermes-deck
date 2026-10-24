"use strict";
// Large attachments: the relay's disk spool (uploads.js), its desktop HTTP routes and the mobile staged/legacy split.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { WebSocket } = require("ws");
const { UploadSpool, hostIdFrom, machineId, uploadConfig, DEFAULTS, LEGACY } = require("../src/uploads");
const { createServer } = require("../src/server");
const { MobileRelay, createPair } = require("../src/mobile");

const TOKEN = "t".repeat(32);
const MOBILE = "Bearer mobile-device-token-0123456789";
const MIB = 1024 * 1024;
const model = { snapshot: () => ({ sessions: [] }), tokens: () => ({}), sessions: new Map() };
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `deck-uploads-${name}-`));
const mutationID = () => `m.${Date.now()}.${crypto.randomUUID()}`;
// Keep normal upload fixtures independent of runner capacity; disk-floor cases inject their own statfs.
beforeEach(t => t.mock.method(fs, "statfsSync", () => ({ bavail: 25 * 1024 * 1024, bsize: 4096 })));

async function relayWith(t, options = {}) {
  const dir = tmp("http");
  const spool = new UploadSpool({ dir: path.join(dir, "spool"), machine: "machine-for-tests", ...options });
  const mobile = { onHttp: () => false, authenticate: (req) => (req.headers.authorization === MOBILE ? { id: "d1" } : null) };
  const relay = createServer({ token: TOKEN, model, fleet: { data: {} }, version: "test", mobile, uploads: spool });
  await new Promise((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  t.after(async () => { spool.stop(); for (const ws of relay.clients) ws.terminate(); relay.server.closeAllConnections(); await new Promise((resolve) => relay.server.close(resolve)); });
  const call = async (method, route, body, auth = `Bearer ${TOKEN}`) => {
    const r = await fetch(base + route, { method, headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { base, spool, dir, relay, call };
}

/** PUT /uploads/<id> through node:http so the test controls the stream (chunks, pauses, abort). */
function putStream(base, id, { length, headers = {} } = {}) {
  const url = new URL(`${base}/uploads/${id}`);
  const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, ...(length !== undefined ? { "content-length": length } : {}), ...headers } });
  const done = new Promise((resolve, reject) => {
    req.on("response", (res) => { const parts = []; res.on("data", (d) => parts.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString() || "{}") })); });
    req.on("error", reject);
  });
  done.catch(() => {});
  return { req, done };
}
const writeAll = (req, buf) => new Promise((resolve) => (req.write(buf) ? resolve() : req.once("drain", resolve)));
const waitFor = async (check, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };

test("same-host id: one shared test vector with the plugin (test_attach_staged.py), machine id sources in order", () => {
  // observer.py / stream.py upload_host_id must give the same hex for the same machine id and real folder
  assert.equal(hostIdFrom("0123456789abcdef0123456789abcdef", "/srv/example/uploads"), "c2d55d62e4ea5400");
  assert.match(hostIdFrom("x", "/y"), /^[a-f0-9]{16}$/);
  assert.notEqual(hostIdFrom("m", "/srv/example/a"), hostIdFrom("m", "/srv/example/b"));
  const files = { "/etc/machine-id": "  \n", "/var/lib/dbus/machine-id": "dbus-id\n" };
  const read = (f) => { if (!(f in files)) throw new Error("ENOENT"); return files[f]; };
  assert.equal(machineId(read, () => "host"), "dbus-id");
  assert.equal(machineId(() => { throw new Error("ENOENT"); }, () => "host-name"), "host-name");
  files["/etc/machine-id"] = "etc-id\n";
  assert.equal(machineId(read, () => "host"), "etc-id");
  // the spool hashes its real path: a symlinked folder gives the id of its target
  const dir = tmp("host"), real = path.join(dir, "real"), link = path.join(dir, "link");
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);
  const viaLink = new UploadSpool({ dir: link, machine: "m" }).hostId();
  assert.equal(viaLink, hostIdFrom("m", fs.realpathSync(real)));
  assert.equal((fs.statSync(real).mode & 0o777).toString(8), "700");
});

test("config: defaults 2 GiB per file, 4 GiB per message, 10 GiB free floor; env overrides; junk falls back", () => {
  const c = uploadConfig({});
  assert.equal(c.fileBytes, 2147483648);
  assert.equal(c.totalBytes, 4294967296);
  assert.equal(c.minFree, 10 * 1024 ** 3);
  assert.ok(c.dir.endsWith(path.join(".hermes-deck", "uploads")));
  const o = uploadConfig({ DECK_UPLOAD_DIR: "/srv/example/spool", DECK_UPLOAD_MAX_FILE: "1000", DECK_UPLOAD_MAX_TOTAL: "2000", DECK_UPLOAD_MIN_FREE: "0x10" });
  assert.deepEqual([o.dir, o.fileBytes, o.totalBytes, o.minFree], ["/srv/example/spool", 1000, 2000, DEFAULTS.minFree]);
  assert.deepEqual(new UploadSpool({ dir: tmp("cfg") }).limits(), { files: 10, fileBytes: 2147483648, totalBytes: 4294967296, dictationBytes: 26214400 });
  assert.deepEqual({ ...LEGACY }, { files: 10, fileBytes: 26214400, totalBytes: 52428800, dictationBytes: 26214400 });
});

test("desktop routes: relay token in the header only; mobile tokens, query tokens and no token are refused", async (t) => {
  const { call, base } = await relayWith(t);
  assert.equal((await call("POST", "/uploads", { name: "a.bin", mime: "application/octet-stream", size: 1 }, null)).status, 401);
  assert.equal((await call("POST", "/uploads", { name: "a.bin", mime: "application/octet-stream", size: 1 }, MOBILE)).status, 403);
  const query = await fetch(`${base}/uploads?token=${TOKEN}`, { method: "POST", body: "{}" });
  assert.equal(query.status, 401);
  assert.equal((await call("POST", "/uploads", { name: "a.bin", mime: "application/octet-stream", size: 1 }, "Bearer " + "x".repeat(32))).status, 401);
  const ok = await call("POST", "/uploads", { name: "a.bin", mime: "application/octet-stream", size: 1 });
  assert.equal(ok.status, 200);
  assert.match(ok.body.id, /^[a-f0-9]{48}$/);
  assert.equal((await call("GET", "/uploads/" + ok.body.id)).status, 405);
  assert.equal((await call("PUT", "/uploads/not-an-id")).status, 404);
});

test("PUT streams to <id>.part on disk while the request is open (no buffering), then <id>.bin + <id>.json, both 0600", async (t) => {
  const { call, base, spool } = await relayWith(t);
  const size = 64 * MIB;
  const ticket = await call("POST", "/uploads", { name: "big archive.rar", mime: "application/vnd.rar", size });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.body));
  const { id } = ticket.body;
  const { req, done } = putStream(base, id, { length: size });
  const chunk = Buffer.alloc(MIB, 7);
  for (let i = 0; i < 48; i++) await writeAll(req, chunk);
  // 48 MiB sent and the request still open: the bytes are already on disk, not held in memory
  await waitFor(() => { try { return fs.statSync(spool.file(id, "part")).size >= 32 * MIB; } catch { return false; } });
  const item = spool.desktop.uploads.get(id);
  assert.equal(item.state, "writing");
  assert.equal(item.bytes, undefined, "no in-memory copy of the file");
  for (let i = 48; i < 64; i++) await writeAll(req, chunk);
  req.end();
  const r = await done;
  assert.deepEqual(r, { status: 200, body: { id, name: "big archive.rar", size } });
  assert.equal(fs.existsSync(spool.file(id, "part")), false);
  const st = fs.statSync(spool.file(id, "bin"));
  assert.equal(st.size, size);
  assert.equal((st.mode & 0o777).toString(8), "600");
  assert.equal((fs.statSync(spool.file(id, "json")).mode & 0o777).toString(8), "600");
  const meta = JSON.parse(fs.readFileSync(spool.file(id, "json"), "utf8"));
  assert.deepEqual(Object.keys(meta).sort(), ["created", "expires", "id", "mime", "name", "size", "v"]);
  assert.deepEqual([meta.v, meta.id, meta.name, meta.mime, meta.size], [1, id, "big archive.rar", "application/vnd.rar", size]);
  assert.ok(meta.expires - meta.created >= 59 * 60 * 1000);
  // a second PUT of a written upload is a conflict
  const again = putStream(base, id, { length: 1 });
  again.req.end(Buffer.from("x"));
  assert.equal((await again.done).status, 409);
});

test("size mismatch: a declared length that differs, a short body and an overlong chunked body each delete the upload", async (t) => {
  const { call, base, spool } = await relayWith(t);
  const ticket = async (size) => (await call("POST", "/uploads", { name: "a.bin", mime: "application/octet-stream", size })).body.id;
  let id = await ticket(5);
  let p = putStream(base, id, { length: 3 });
  p.req.end(Buffer.from("abc"));
  assert.deepEqual(await p.done, { status: 400, body: { error: { code: "bad_request", message: "Upload size mismatch" } } });
  assert.equal(spool.desktop.uploads.has(id), false);
  assert.deepEqual(fs.readdirSync(spool.dir), []);
  id = await ticket(5);
  p = putStream(base, id, { headers: { "transfer-encoding": "chunked" } });
  p.req.end(Buffer.from("abc"));
  assert.equal((await p.done).status, 400, "short chunked body");
  assert.deepEqual(fs.readdirSync(spool.dir), []);
  id = await ticket(5);
  p = putStream(base, id, { headers: { "transfer-encoding": "chunked" } });
  p.req.end(Buffer.from("abcdefgh"));
  const over = await p.done.catch((e) => ({ status: e.code }));
  assert.ok([400, "ECONNRESET", "EPIPE"].includes(over.status), String(over.status));
  await waitFor(() => !spool.desktop.uploads.has(id));
  assert.deepEqual(fs.readdirSync(spool.dir), []);
  assert.equal((await call("PUT", "/uploads/" + id)).status, 404, "a deleted upload is gone");
});

test("DELETE mid-write aborts the stream and deletes the .part; DELETE of a ready upload deletes its files", async (t) => {
  const { call, base, spool } = await relayWith(t);
  const size = 16 * MIB;
  const { body: { id } } = await call("POST", "/uploads", { name: "a.bin", mime: "application/octet-stream", size });
  const { req, done } = putStream(base, id, { length: size });
  for (let i = 0; i < 4; i++) await writeAll(req, Buffer.alloc(MIB));
  await waitFor(() => fs.existsSync(spool.file(id, "part")) && fs.statSync(spool.file(id, "part")).size > 0);
  assert.deepEqual((await call("DELETE", "/uploads/" + id)).body, { ok: true });
  await done.catch(() => {});
  await waitFor(() => !fs.existsSync(spool.file(id, "part")));
  assert.deepEqual(fs.readdirSync(spool.dir), []);
  assert.equal(spool.items.size, 0);
  const second = (await call("POST", "/uploads", { name: "b.bin", mime: "application/octet-stream", size: 3 })).body.id;
  const p = putStream(base, second, { length: 3 });
  p.req.end(Buffer.from("abc"));
  assert.equal((await p.done).status, 200);
  assert.equal((await call("DELETE", "/uploads/" + second)).status, 200);
  assert.deepEqual(fs.readdirSync(spool.dir), []);
});

test("limits: 10 pending per token, the per-message total, the per-file size, and the disk floor (507 disk_full)", async (t) => {
  let free = 100 * 1024 ** 3;
  const { call } = await relayWith(t, { fileBytes: 1000, totalBytes: 2500, minFree: 10 * 1024 ** 3, statfs: () => ({ bavail: free / 4096, bsize: 4096 }) });
  const make = (size, name = "a.bin") => call("POST", "/uploads", { name, mime: "application/octet-stream", size });
  assert.equal((await make(1001)).body.error.code, "bad_request", "over the per-file limit");
  assert.equal((await make(1000)).status, 200);
  assert.equal((await make(1000)).status, 200);
  const over = await make(501);
  assert.deepEqual([over.status, over.body.error.code], [413, "limit"], "over the per-message total");
  for (let i = 0; i < 8; i++) assert.equal((await make(50)).status, 200, `upload ${i + 3}`);
  assert.deepEqual([(await make(1)).status, (await make(1)).body.error.code], [413, "limit"], "the 11th pending upload");
  for (const bad of [{ name: "../x", mime: "a/b", size: 1 }, { name: "a", mime: "nope", size: 1 }, { name: "a", mime: "a/b", size: 0 }, { name: " . ", mime: "a/b", size: 1 }]) {
    assert.equal((await call("POST", "/uploads", bad)).status, 400, JSON.stringify(bad));
  }
  const spool2 = await relayWith(t, { minFree: 10 * 1024 ** 3, statfs: () => ({ bavail: free / 4096, bsize: 4096 }) });
  free = 10 * 1024 ** 3 + 5 * MIB; // 5 MiB above the floor
  assert.equal((await spool2.call("POST", "/uploads", { name: "a.bin", mime: "a/b", size: 4 * MIB })).status, 200);
  const full = await spool2.call("POST", "/uploads", { name: "b.bin", mime: "a/b", size: 2 * MIB });
  assert.deepEqual([full.status, full.body.error.code], [507, "disk_full"], "pending bytes count against the floor");
});

test("TTL sweep: expired uploads, orphan .part files and old meta-less files go; a send in flight and a live writer stay", async () => {
  let now = 1_000_000;
  const spool = new UploadSpool({ dir: tmp("sweep"), machine: "m", now: () => now, ttlMs: 60_000 });
  const owner = spool.desktop;
  const ready = async (name) => { const item = spool.create(owner, { name, mime: "a/b", size: 3 }); await spool.write(owner, item, Readable.from([Buffer.from("abc")])); return item; };
  const a = await ready("a.bin"), b = await ready("b.bin");
  fs.writeFileSync(path.join(spool.dir, `${"c".repeat(48)}.part`), "orphan");
  const writer = spool.create(owner, { name: "w.bin", mime: "a/b", size: 3 });
  writer.state = "writing"; // a live writer's .part is kept
  fs.writeFileSync(spool.file(writer.id, "part"), "ab");
  fs.writeFileSync(path.join(spool.dir, "unrelated.txt"), "kept");
  const send = spool.take(owner, [b.id]);
  spool.sweep();
  assert.equal(fs.existsSync(path.join(spool.dir, `${"c".repeat(48)}.part`)), false, "orphan .part");
  assert.equal(fs.existsSync(spool.file(writer.id, "part")), true, "live writer");
  assert.equal(fs.existsSync(spool.file(a.id, "bin")), true, "not expired yet");
  now += 61_000;
  spool.sweep();
  assert.equal(fs.existsSync(spool.file(a.id, "bin")), false, "expired");
  assert.equal(fs.existsSync(spool.file(a.id, "json")), false);
  assert.equal(owner.uploads.has(a.id), false);
  assert.equal(fs.existsSync(spool.file(b.id, "bin")), true, "in flight: never swept");
  send.release();
  assert.equal(fs.existsSync(spool.file(b.id, "bin")), false, "released: deleted");
  assert.equal(fs.existsSync(path.join(spool.dir, "unrelated.txt")), true);
  // after a relay restart nothing is in memory: expiry comes from the meta file, else the file's age
  const later = new UploadSpool({ dir: spool.dir, machine: "m", now: () => now, ttlMs: 60_000 });
  const c = await ready("c.bin");
  const orphanBin = path.join(spool.dir, `${"d".repeat(48)}.bin`);
  fs.writeFileSync(orphanBin, "x");
  later.sweep();
  assert.equal(fs.existsSync(spool.file(c.id, "bin")), true, "meta says not expired");
  assert.equal(fs.existsSync(orphanBin), true, "young file without meta");
  fs.utimesSync(orphanBin, new Date(0), new Date(0));
  later.now = () => now + 61_000;
  later.sweep();
  assert.equal(fs.existsSync(spool.file(c.id, "bin")), false);
  assert.equal(fs.existsSync(orphanBin), false);
  // a consumed upload (the plugin moved <id>.bin away) leaves its owner's quota at the next prune
  const d = await ready("d.bin");
  fs.unlinkSync(spool.file(d.id, "bin"));
  spool.prune(owner);
  assert.equal(owner.uploads.has(d.id), false);
  assert.equal(fs.existsSync(spool.file(d.id, "json")), false);
});

test("the WebSocket hello carries uploads {v, host, files, fileBytes, totalBytes}; /health does not", async (t) => {
  const { base, spool } = await relayWith(t);
  const ws = new WebSocket(base.replace("http", "ws") + "/events", { headers: { authorization: `Bearer ${TOKEN}` } });
  const hello = await new Promise((resolve, reject) => { ws.on("message", (d) => { const m = JSON.parse(d); if (m.t === "hello") resolve(m); }); ws.on("error", reject); });
  ws.close();
  assert.deepEqual(hello.uploads, { v: 1, host: spool.hostId(), files: 10, fileBytes: 2147483648, totalBytes: 4294967296 });
  assert.equal(hello.uploads.host, hostIdFrom("machine-for-tests", fs.realpathSync(spool.dir)));
  const health = await (await fetch(base + "/health")).json();
  assert.equal(health.uploads, undefined);
  assert.ok(!JSON.stringify(health).includes(spool.hostId()));
});

/** A mobile relay whose device bridge is a fake: version() decides whether staging is on. */
function mobileWith(t, { uploadHost } = {}) {
  const dir = tmp("mobile"), file = path.join(dir, "devices.json");
  const spool = new UploadSpool({ dir: path.join(dir, "spool"), machine: "m" });
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: "local" }, uploads: spool });
  t.after(() => mobile.stop());
  const paired = mobile.pair({ code: createPair(file), name: "phone" }), device = mobile.device(paired.deviceId);
  const sends = [];
  device.bridge = {
    status: { status: "open" },
    version: async () => ({ version: "1.3.2", protocol: 1, uploads: uploadHost === undefined ? null : { v: 1, host: uploadHost === "same" ? spool.hostId() : uploadHost } }),
    send: async (sid, text, options) => { sends.push({ sid, text, options }); return { status: "streaming" }; },
    stop: async () => {},
  };
  const stage = async (name, bytes) => { const { id } = mobile.createUpload(device, { name, mime: "application/octet-stream", size: bytes.length }); await spool.write(device, mobile.upload(device, id), Readable.from([bytes])); return id; };
  return { mobile, device, spool, sends, stage };
}

test("mobile capabilities: the spool's limits and uploads.staged only when the plugin's host id matches; old limits otherwise", async (t) => {
  const same = mobileWith(t, { uploadHost: "same" });
  assert.deepEqual(same.mobile.capabilities().uploads, { v: 1, staged: false }, "not probed yet");
  assert.equal(await same.mobile.probeStaging(same.device), true);
  const caps = same.mobile.capabilities();
  assert.deepEqual(caps.uploads, { v: 1, staged: true });
  assert.deepEqual(caps.limits, { files: 10, fileBytes: 2147483648, totalBytes: 4294967296, dictationBytes: 26214400, downloadBytes: 209715200 });
  for (const host of ["0123456789abcdef", undefined]) {
    const other = mobileWith(t, { uploadHost: host });
    assert.equal(await other.mobile.probeStaging(other.device), false, `host ${host}`);
    assert.deepEqual(other.mobile.capabilities().limits, { files: 10, fileBytes: 26214400, totalBytes: 52428800, dictationBytes: 26214400, downloadBytes: 209715200 });
    assert.deepEqual(other.mobile.capabilities().uploads, { v: 1, staged: false });
    assert.throws(() => other.mobile.createUpload(other.device, { name: "big.rar", mime: "a/b", size: 26214401 }), /Invalid/);
  }
  const off = new MobileRelay({ tokensFile: path.join(tmp("off"), "devices.json"), bridgeConfig: { mode: "off" } });
  t.after(() => off.stop());
  assert.equal(await off.probeStaging(null), false);
  assert.deepEqual(off.capabilities().uploads, { v: 1, staged: false });
});

test("mobile send: spool ids to the bridge when staged is available, base64 when not; the spool is emptied either way", async (t) => {
  const staged = mobileWith(t, { uploadHost: "same" });
  await staged.mobile.probeStaging(staged.device);
  const big = await staged.stage("big.rar", Buffer.alloc(26 * MIB, 1)); // over the old 25 MB limit
  const small = await staged.stage("note.txt", Buffer.from("hello"));
  await staged.mobile.call(staged.device, { id: mutationID(), op: "send", args: { sid: "s1", profile: "default", text: "look", uploads: [big, small] } });
  assert.deepEqual(staged.sends[0].options, { profile: "default", staged: [{ upload: big, filename: "big.rar" }, { upload: small, filename: "note.txt" }] });
  assert.ok(!JSON.stringify(staged.sends[0]).includes("content_base64"));
  assert.deepEqual(fs.readdirSync(staged.spool.dir), []);
  assert.equal(staged.device.inflightBytes, 0);

  const legacy = mobileWith(t, { uploadHost: undefined });
  await legacy.mobile.probeStaging(legacy.device);
  const id = await legacy.stage("note.txt", Buffer.from("hello"));
  await legacy.mobile.call(legacy.device, { id: mutationID(), op: "send", args: { sid: "s1", profile: "default", text: "look", uploads: [id] } });
  assert.deepEqual(legacy.sends[0].options, { profile: "default", files: [{ filename: "note.txt", content_base64: Buffer.from("hello").toString("base64") }] });
  assert.deepEqual(fs.readdirSync(legacy.spool.dir), []);

  // staged when the file was uploaded, but the plugin no longer takes staged files: refused within the old limits
  const flip = mobileWith(t, { uploadHost: "same" });
  await flip.mobile.probeStaging(flip.device);
  const huge = await flip.stage("big.rar", Buffer.alloc(26 * MIB));
  flip.mobile.staging.ok = false;
  await assert.rejects(flip.mobile.call(flip.device, { id: mutationID(), op: "send", args: { sid: "s1", profile: "default", text: "x", uploads: [huge] } }), (e) => e.code === "limit");
  assert.equal(flip.sends.length, 0);
});

test("mobile HTTP: /mobile/uploads PUT streams to the spool, DELETE cancels, capabilities probe the plugin", async (t) => {
  const dir = tmp("mobile-http"), file = path.join(dir, "devices.json");
  const spool = new UploadSpool({ dir: path.join(dir, "spool"), machine: "m" });
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: "local" }, uploads: spool });
  const relay = createServer({ token: TOKEN, model, fleet: { data: {} }, version: "test", mobile, uploads: spool });
  await new Promise((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  t.after(async () => { await mobile.stop(); await new Promise((resolve) => relay.server.close(resolve)); });
  const paired = mobile.pair({ code: createPair(file), name: "phone" });
  const device = mobile.device(paired.deviceId);
  device.bridge = { status: { status: "open" }, version: async () => ({ version: "1.3.2", protocol: 1, uploads: { v: 1, host: spool.hostId() } }), stop: async () => {} };
  const auth = { authorization: `Bearer ${paired.token}` };
  const caps = await (await fetch(base + "/mobile/capabilities", { headers: auth })).json();
  assert.deepEqual([caps.uploads, caps.limits.fileBytes], [{ v: 1, staged: true }, 2147483648]);
  const { id } = await (await fetch(base + "/mobile/uploads", { method: "POST", headers: auth, body: JSON.stringify({ name: "big.rar", mime: "application/vnd.rar", size: 30 * MIB }) })).json();
  assert.match(id, /^[a-f0-9]{48}$/);
  const put = await fetch(base + "/mobile/uploads/" + id, { method: "PUT", headers: auth, body: Buffer.alloc(30 * MIB, 2) });
  assert.deepEqual(await put.json(), { id, name: "big.rar", mime: "application/vnd.rar", size: 30 * MIB });
  assert.equal(fs.statSync(spool.file(id, "bin")).size, 30 * MIB);
  // the desktop route cannot see or touch a phone's upload
  assert.equal((await fetch(base + "/uploads/" + id, { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  assert.equal(fs.existsSync(spool.file(id, "bin")), true);
  assert.deepEqual(await (await fetch(base + "/mobile/uploads/" + id, { method: "DELETE", headers: auth })).json(), { ok: true });
  assert.deepEqual(fs.readdirSync(spool.dir), []);
  const mismatch = await (await fetch(base + "/mobile/uploads", { method: "POST", headers: auth, body: JSON.stringify({ name: "a.txt", mime: "text/plain", size: 5 }) })).json();
  const bad = await fetch(base + "/mobile/uploads/" + mismatch.id, { method: "PUT", headers: auth, body: "abc" });
  assert.equal(bad.status, 400);
  assert.deepEqual(fs.readdirSync(spool.dir), []);
});
