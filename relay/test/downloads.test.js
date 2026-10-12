"use strict";
// Large downloads: deck.file_grant tickets in the shared spool, GET /downloads/<id> streamed from disk with Range,
// the mobile /mobile/files direct path and its chunk-path fallback (downloads.js, server.js, mobile.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { WebSocket } = require("ws");
const { UploadSpool } = require("../src/uploads");
const { DownloadTickets, downloadConfig, parseRange, disposition, DEFAULT_MAX, LEGACY_MAX } = require("../src/downloads");
const { createServer } = require("../src/server");
const { MobileRelay, createPair } = require("../src/mobile");

const TOKEN = "t".repeat(32);
const MOBILE = "Bearer mobile-device-token-0123456789";
const MIB = 1024 * 1024;
const model = { snapshot: () => ({ sessions: [] }), tokens: () => ({}), sessions: new Map() };
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `deck-downloads-${name}-`));
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const auth = { authorization: `Bearer ${TOKEN}` };

/** A ticket exactly as observer.py write_download_ticket writes it (dev, ino, mtime_ns as decimal strings). */
function grant(spoolDir, file, over = {}) {
  const st = fs.statSync(file, { bigint: true });
  const id = over.id || crypto.randomBytes(24).toString("hex");
  const ticket = { v: 1, id, path: fs.realpathSync(file), name: path.basename(file), size: Number(st.size), mtime_ns: st.mtimeNs.toString(),
    dev: st.dev.toString(), ino: st.ino.toString(), created: Date.now(), expires: Date.now() + 15 * 60 * 1000, ...over };
  const folder = path.join(spoolDir, "downloads");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(folder, `${id}.json`), JSON.stringify(ticket), { mode: 0o600 });
  return ticket;
}

async function relayWith(t, { maxBytes } = {}) {
  const dir = tmp("http");
  const spool = new UploadSpool({ dir: path.join(dir, "spool"), machine: "machine-for-tests" });
  const downloads = new DownloadTickets({ spool, ...(maxBytes ? { maxBytes } : {}) });
  const mobile = { onHttp: () => false, authenticate: (req) => (req.headers.authorization === MOBILE ? { id: "d1" } : null) };
  const relay = createServer({ token: TOKEN, model, fleet: { data: {} }, version: "test", mobile, uploads: spool, downloads });
  await new Promise((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  t.after(async () => { spool.stop(); for (const ws of relay.clients) ws.terminate(); relay.server.closeAllConnections?.(); await new Promise((resolve) => relay.server.close(resolve)); });
  const work = path.join(dir, "work");
  fs.mkdirSync(work);
  return { base, spool, downloads, dir, work, relay };
}

/** GET through node:http so the test controls reading (pause, resume, cut). */
function get(base, route, headers = auth) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + route, { headers }, resolve);
    req.on("error", reject);
  });
}
const body = (res) => new Promise((resolve, reject) => { const parts = []; res.on("data", (d) => parts.push(d)); res.on("end", () => resolve(Buffer.concat(parts))); res.on("error", reject); res.on("aborted", () => reject(new Error("aborted"))); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("config, Range parsing and Content-Disposition", () => {
  assert.equal(downloadConfig({}).maxBytes, 8 * 1024 ** 3);
  assert.equal(DEFAULT_MAX, 8589934592);
  assert.equal(LEGACY_MAX, 200 * MIB);
  assert.equal(downloadConfig({ DECK_DOWNLOAD_MAX: "1000" }).maxBytes, 1000);
  for (const junk of ["0", "-1", "1e9", "lots"]) assert.equal(downloadConfig({ DECK_DOWNLOAD_MAX: junk }).maxBytes, DEFAULT_MAX, junk);
  assert.equal(parseRange(undefined, 10), null);
  assert.deepEqual(parseRange("bytes=3-", 10), { start: 3, end: 9 });
  assert.deepEqual(parseRange("bytes=0-4", 10), { start: 0, end: 4 });
  assert.deepEqual(parseRange("bytes=5-100", 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange("bytes=-4", 10), { start: 6, end: 9 });
  assert.deepEqual(parseRange("bytes=-40", 10), { start: 0, end: 9 });
  assert.equal(parseRange("bytes=10-", 10), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 10), "unsatisfiable");
  assert.equal(parseRange("bytes=0-", 0), "unsatisfiable");
  for (const ignored of ["bytes=5-3", "bytes=0-1,4-5", "items=0-1", "bytes=-", "bytes=a-b"]) assert.equal(parseRange(ignored, 10), null, ignored);
  assert.equal(disposition("report.pdf"), `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
  assert.equal(disposition('rapor "son" ğ.txt'), `attachment; filename="rapor _son_ _.txt"; filename*=UTF-8''rapor%20%22son%22%20%C4%9F.txt`);
  assert.equal(disposition("../a\u0000b"), `attachment; filename=".._a_b"; filename*=UTF-8''.._a_b`);
});

test("auth: relay token in the header only; no token 401, a mobile token 403, the query token form refused", async (t) => {
  const { base, spool, work } = await relayWith(t);
  const file = path.join(work, "a.bin");
  fs.writeFileSync(file, "abc");
  const { id } = grant(spool.dir, file);
  assert.equal((await fetch(`${base}/downloads/${id}`)).status, 401);
  assert.equal((await fetch(`${base}/downloads/${id}`, { headers: { authorization: MOBILE } })).status, 403);
  assert.equal((await fetch(`${base}/downloads/${id}?token=${TOKEN}`)).status, 401);
  assert.equal((await fetch(`${base}/downloads/${id}`, { headers: { authorization: `Bearer ${"x".repeat(32)}` } })).status, 401);
  assert.equal((await fetch(`${base}/downloads/${id}`, { method: "POST", headers: auth })).status, 405);
  assert.equal((await fetch(`${base}/downloads/${"0".repeat(48)}`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/downloads/nothex`, { headers: auth })).status, 404);
  const ok = await fetch(`${base}/downloads/${id}`, { headers: auth });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "abc");
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal(ok.headers.get("accept-ranges"), "bytes");
  assert.equal(ok.headers.get("content-disposition"), `attachment; filename="a.bin"; filename*=UTF-8''a.bin`);
  assert.equal(ok.headers.get("content-type"), "application/octet-stream");
});

test("a 64 MB file streams from disk with backpressure (a paused client holds a few MB, not the file) and arrives intact", async (t) => {
  const { base, spool, work, relay } = await relayWith(t);
  const file = path.join(work, "big.bin");
  const bytes = crypto.randomBytes(64 * MIB);
  fs.writeFileSync(file, bytes);
  const { id } = grant(spool.dir, file);
  let served = null;
  relay.server.on("request", (_req, res) => { served = res; });
  const before = process.memoryUsage().rss;
  const res = await get(base, `/downloads/${id}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-length"], String(64 * MIB));
  res.pause();
  await sleep(300);
  const sent = served.socket.bytesWritten + served.socket.writableLength + served.writableLength;
  assert.ok(sent < 24 * MIB, `a paused client got ${sent} bytes handed to its socket`);
  res.resume();
  const got = await body(res);
  assert.equal(sha(got), sha(bytes));
  const grown = process.memoryUsage().rss - before;
  assert.ok(grown < 256 * MIB, `rss grew ${grown}`); // the test itself holds two 64 MB copies; the relay adds no third
});

test("Range: 206 with Content-Range from the last byte, a closed range, a suffix, 416 past the end; HEAD has no body", async (t) => {
  const { base, spool, work } = await relayWith(t);
  const file = path.join(work, "r.bin");
  const bytes = crypto.randomBytes(10000);
  fs.writeFileSync(file, bytes);
  const { id } = grant(spool.dir, file);
  const tail = await fetch(`${base}/downloads/${id}`, { headers: { ...auth, range: "bytes=4000-" } });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get("content-range"), "bytes 4000-9999/10000");
  assert.equal(tail.headers.get("content-length"), "6000");
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(4000));
  const mid = await fetch(`${base}/downloads/${id}`, { headers: { ...auth, range: "bytes=10-19" } });
  assert.deepEqual([mid.status, mid.headers.get("content-range")], [206, "bytes 10-19/10000"]);
  assert.deepEqual(Buffer.from(await mid.arrayBuffer()), bytes.subarray(10, 20));
  const suffix = await fetch(`${base}/downloads/${id}`, { headers: { ...auth, range: "bytes=-5" } });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(9995));
  const past = await fetch(`${base}/downloads/${id}`, { headers: { ...auth, range: "bytes=10000-" } });
  assert.deepEqual([past.status, past.headers.get("content-range")], [416, "bytes */10000"]);
  const multi = await fetch(`${base}/downloads/${id}`, { headers: { ...auth, range: "bytes=0-1,5-6" } });
  assert.equal(multi.status, 200, "a range we do not serve is ignored: the whole file");
  assert.equal((await multi.arrayBuffer()).byteLength, 10000);
  const head = await fetch(`${base}/downloads/${id}`, { method: "HEAD", headers: auth });
  assert.deepEqual([head.status, head.headers.get("content-length")], [200, "10000"]);
  // the ticket is reused until it expires: a second full download works
  assert.equal((await (await fetch(`${base}/downloads/${id}`, { headers: auth })).arrayBuffer()).byteLength, 10000);
  const empty = path.join(work, "empty.txt");
  fs.writeFileSync(empty, "");
  const e = grant(spool.dir, empty);
  const zero = await fetch(`${base}/downloads/${e.id}`, { headers: auth });
  assert.deepEqual([zero.status, zero.headers.get("content-length"), (await zero.arrayBuffer()).byteLength], [200, "0", 0]);
});

test("a file changed since the grant is refused: mtime, size, inode swap and a symlink at the path", async (t) => {
  const { base, spool, work } = await relayWith(t);
  const status = async (id) => (await fetch(`${base}/downloads/${id}`, { headers: auth })).status;
  const make = (name, data = "original") => { const f = path.join(work, name); fs.writeFileSync(f, data); return f; };
  const touched = make("m.txt");
  const a = grant(spool.dir, touched);
  fs.utimesSync(touched, new Date(), new Date(Date.now() + 5000));
  assert.equal(await status(a.id), 409);
  const grown = make("s.txt");
  const b = grant(spool.dir, grown);
  const keep = fs.statSync(grown);
  fs.appendFileSync(grown, "more");
  fs.utimesSync(grown, keep.atime, keep.mtime); // same mtime, other size
  assert.equal(await status(b.id), 409);
  const swapped = make("i.txt");
  const c = grant(spool.dir, swapped);
  const other = make("i.new", "original");
  const st = fs.statSync(swapped);
  fs.utimesSync(other, st.atime, st.mtime);
  fs.renameSync(other, swapped); // same size and mtime, another inode
  assert.equal(await status(c.id), 409);
  const linked = make("l.txt");
  const d = grant(spool.dir, linked);
  const copy = make("l.copy");
  fs.unlinkSync(linked);
  fs.symlinkSync(copy, linked);
  assert.equal(await status(d.id), 409);
  const gone = make("g.txt");
  const e = grant(spool.dir, gone);
  fs.unlinkSync(gone);
  const r = await fetch(`${base}/downloads/${e.id}`, { headers: auth });
  assert.equal(r.status, 409);
  assert.ok(!JSON.stringify(await r.json()).includes(work), "no host path in an error");
});

test("a file rewritten during the stream is cut short instead of delivered half old, half new", async (t) => {
  const { base, spool, work } = await relayWith(t);
  const file = path.join(work, "live.bin");
  fs.writeFileSync(file, crypto.randomBytes(16 * MIB));
  const { id } = grant(spool.dir, file);
  const res = await get(base, `/downloads/${id}`);
  res.pause();
  await sleep(100);
  fs.utimesSync(file, new Date(), new Date(Date.now() + 9000));
  res.resume();
  await assert.rejects(body(res));
});

test("tickets: expired 404, unreadable or foreign 404, over the relay's cap 413; the upload sweep deletes expired ones", async (t) => {
  const { base, spool, work, downloads } = await relayWith(t, { maxBytes: 100 });
  const file = path.join(work, "x.txt");
  fs.writeFileSync(file, "x".repeat(50));
  const status = async (id) => (await fetch(`${base}/downloads/${id}`, { headers: auth })).status;
  const expired = grant(spool.dir, file, { expires: Date.now() - 1 });
  assert.equal(await status(expired.id), 404);
  const wrongId = grant(spool.dir, file, { id: "a".repeat(48) });
  fs.renameSync(path.join(spool.dir, "downloads", `${wrongId.id}.json`), path.join(spool.dir, "downloads", `${"b".repeat(48)}.json`));
  assert.equal(await status("b".repeat(48)), 404, "the id inside must match the file name");
  for (const bad of [{ v: 2 }, { path: "relative" }, { dev: 5 }, { mtime_ns: "1.5" }, { size: -1 }]) {
    const ticket = grant(spool.dir, file, bad);
    assert.equal(await status(ticket.id), 404, JSON.stringify(bad));
  }
  const live = grant(spool.dir, file);
  const linkId = "c".repeat(48);
  fs.symlinkSync(path.join(spool.dir, "downloads", `${live.id}.json`), path.join(spool.dir, "downloads", `${linkId}.json`));
  assert.equal(await status(linkId), 404, "a ticket that is a symlink is never followed");
  const big = path.join(work, "big.txt");
  fs.writeFileSync(big, "y".repeat(101));
  assert.equal(await status(grant(spool.dir, big).id), 413);
  assert.equal(await status(live.id), 200);
  const stale = path.join(spool.dir, "downloads", `${"d".repeat(48)}.json.tmp`);
  fs.writeFileSync(stale, "{}");
  fs.utimesSync(stale, new Date(Date.now() - 600000), new Date(Date.now() - 600000));
  fs.writeFileSync(path.join(spool.dir, "downloads", "README"), "kept");
  spool.sweep(); // the upload sweep runs the download sweep too
  const left = fs.readdirSync(path.join(spool.dir, "downloads")).sort();
  assert.ok(left.includes(`${live.id}.json`));
  assert.ok(left.includes("README"));
  assert.ok(!left.includes(`${expired.id}.json`));
  assert.ok(!left.some((n) => n.endsWith(".tmp")));
  assert.equal(downloads.dir, path.join(spool.dir, "downloads"));
  // a downloads folder that is a symlink is never read
  const other = await relayWith(t);
  fs.mkdirSync(other.spool.dir, { recursive: true });
  const elsewhere = path.join(other.dir, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(other.spool.dir, "downloads"));
  const f2 = path.join(other.work, "f.txt");
  fs.writeFileSync(f2, "z");
  const t2 = grant(other.spool.dir, f2); // written through the link into `elsewhere`
  assert.ok(fs.existsSync(path.join(elsewhere, `${t2.id}.json`)));
  assert.equal((await fetch(`${other.base}/downloads/${t2.id}`, { headers: auth })).status, 404);
});

test("the WebSocket hello carries downloads {v, host, maxBytes} with the uploads host; /health does not", async (t) => {
  const { base, spool } = await relayWith(t, { maxBytes: 5 * 1024 ** 3 });
  const ws = new WebSocket(base.replace("http:", "ws:") + "/events", { headers: auth });
  const hello = await new Promise((resolve, reject) => { ws.once("message", (m) => resolve(JSON.parse(m))); ws.once("error", reject); });
  ws.close();
  assert.deepEqual(hello.downloads, { v: 1, host: spool.hostId(), maxBytes: 5 * 1024 ** 3 });
  assert.equal(hello.downloads.host, hello.uploads.host);
  const health = await (await fetch(base + "/health")).json();
  assert.equal(health.downloads, undefined);
});

/** A mobile relay whose device bridge is a fake: version() decides whether the direct path is on. */
function mobileWith(t, { downloadHost, maxBytes = 8 * 1024 ** 3, grantError = null } = {}) {
  const dir = tmp("mobile"), file = path.join(dir, "devices.json");
  const spool = new UploadSpool({ dir: path.join(dir, "spool"), machine: "m" });
  const downloads = new DownloadTickets({ spool });
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: "local" }, uploads: spool, downloads });
  t.after(() => mobile.stop());
  const paired = mobile.pair({ code: createPair(file), name: "phone" }), device = mobile.device(paired.deviceId);
  const work = path.join(dir, "work");
  fs.mkdirSync(work);
  const calls = { grant: 0, chunk: 0 };
  device.bridge = {
    status: { status: "open" },
    version: async () => ({ version: "1.3.3", protocol: 1, uploads: null, downloads: downloadHost === undefined ? null : { v: 1, host: downloadHost === "same" ? spool.hostId() : downloadHost, maxBytes } }),
    fileGrant: async (sid, p) => {
      calls.grant++;
      if (grantError) throw grantError;
      const ticket = grant(spool.dir, p);
      return { id: ticket.id, name: ticket.name, size: ticket.size, mtime: Number(BigInt(ticket.mtime_ns) / 1000000n) / 1000 };
    },
    fileChunk: async (sid, p, { offset, length }) => {
      calls.chunk++;
      const data = fs.readFileSync(p);
      const part = data.subarray(offset, offset + length);
      return { size: data.length, mtime: 1, offset, length: part.length, eof: offset + part.length >= data.length, bytes: part };
    },
    stop: async () => {},
  };
  const offer = (p) => mobile.offers(device).offer(JSON.stringify(["default", "s1"]), p);
  return { mobile, device, spool, downloads, work, calls, offer, paired, file };
}

async function mobileServer(t, m) {
  const relay = createServer({ token: TOKEN, model, fleet: { data: {} }, version: "test", mobile: m.mobile, uploads: m.spool, downloads: m.downloads });
  await new Promise((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { relay.server.closeAllConnections?.(); await new Promise((resolve) => relay.server.close(resolve)); });
  return `http://127.0.0.1:${relay.server.address().port}`;
}

test("mobile capabilities: downloads.direct and limits.downloadBytes only when the plugin grants into this spool", async (t) => {
  const same = mobileWith(t, { downloadHost: "same", maxBytes: 3 * 1024 ** 3 });
  assert.deepEqual(same.mobile.capabilities().downloads, { v: 1, direct: false }, "not probed yet");
  assert.equal(same.mobile.capabilities().limits.downloadBytes, 200 * MIB);
  await same.mobile.probeStaging(same.device);
  const caps = same.mobile.capabilities();
  assert.deepEqual(caps.downloads, { v: 1, direct: true });
  assert.equal(caps.limits.downloadBytes, 3 * 1024 ** 3, "the smaller of the plugin's and the relay's caps");
  assert.deepEqual(caps.uploads, { v: 1, staged: false }, "uploads are decided on their own");
  for (const host of ["0123456789abcdef", undefined]) {
    const other = mobileWith(t, { downloadHost: host });
    await other.mobile.probeStaging(other.device);
    assert.deepEqual(other.mobile.capabilities().downloads, { v: 1, direct: false }, `host ${host}`);
    assert.equal(other.mobile.capabilities().limits.downloadBytes, 200 * MIB);
  }
});

test("mobile files: the direct path grants and streams from disk (Range too); the wire shape is unchanged", async (t) => {
  const m = mobileWith(t, { downloadHost: "same" });
  const base = await mobileServer(t, m);
  const file = path.join(m.work, "report.bin");
  const bytes = crypto.randomBytes(3 * MIB + 5);
  fs.writeFileSync(file, bytes);
  const ref = m.offer(file);
  const headers = { authorization: `Bearer ${m.paired.token}` };
  const info = await (await fetch(base + "/mobile/files/info", { method: "POST", headers, body: JSON.stringify({ sid: "s1", profile: "default", ref }) })).json();
  assert.deepEqual(Object.keys(info).sort(), ["id", "mime", "name", "size"]);
  assert.deepEqual([info.name, info.mime, info.size], ["report.bin", "application/octet-stream", bytes.length]);
  assert.deepEqual(m.calls, { grant: 1, chunk: 0 });
  const whole = await fetch(base + "/mobile/files/" + info.id, { headers });
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-length"), String(bytes.length));
  assert.equal(sha(Buffer.from(await whole.arrayBuffer())), sha(bytes));
  const part = await fetch(base + "/mobile/files/" + info.id, { headers: { ...headers, range: `bytes=${MIB}-` } });
  assert.deepEqual([part.status, part.headers.get("content-range")], [206, `bytes ${MIB}-${bytes.length - 1}/${bytes.length}`]);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(MIB));
  assert.equal(m.calls.chunk, 0, "no byte went through the bridge");
  // the plugin's ticket expired (15 min) while the device's file ticket lives on: granted again once, same file
  for (const name of fs.readdirSync(m.downloads.dir)) fs.unlinkSync(path.join(m.downloads.dir, name));
  const again = await fetch(base + "/mobile/files/" + info.id, { headers });
  assert.equal(again.status, 200);
  assert.equal((await again.arrayBuffer()).byteLength, bytes.length);
  assert.equal(m.calls.grant, 2);
  // another device cannot use this file ticket, and the desktop route refuses a phone token
  const other = m.mobile.pair({ code: createPair(m.file), name: "tablet" });
  assert.equal((await fetch(base + "/mobile/files/" + info.id, { headers: { authorization: `Bearer ${other.token}` } })).status, 404);
  const ticketId = fs.readdirSync(m.downloads.dir)[0].slice(0, 48);
  assert.equal((await fetch(base + "/downloads/" + ticketId, { headers })).status, 403);
});

test("mobile files: the chunk path stays when the plugin does not grant relay downloads (or answers -32601)", async (t) => {
  for (const options of [{ downloadHost: undefined }, { downloadHost: "0123456789abcdef" }, { downloadHost: "same", grantError: Object.assign(new Error("Unsupported Hermes Deck control"), { rpcCode: -32601 }) }]) {
    const m = mobileWith(t, options);
    const base = await mobileServer(t, m);
    const file = path.join(m.work, "small.txt");
    fs.writeFileSync(file, "hello over chunks");
    const ref = m.offer(file);
    const headers = { authorization: `Bearer ${m.paired.token}` };
    const info = await (await fetch(base + "/mobile/files/info", { method: "POST", headers, body: JSON.stringify({ sid: "s1", profile: "default", ref }) })).json();
    assert.equal(info.size, 17, JSON.stringify(options));
    const got = await fetch(base + "/mobile/files/" + info.id, { headers });
    assert.equal(await got.text(), "hello over chunks");
    assert.ok(m.calls.chunk >= 2, "size probe plus at least one chunk");
    assert.equal(m.mobile.capabilities().downloads.direct, false);
  }
});

test("interop: a ticket the real plugin code writes is served byte-identical (Python and Node agree on the pin)", async (t) => {
  const python = ["python3", "python"].find((cmd) => spawnSync(cmd, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"]).status === 0);
  if (!python) return t.skip("no Python 3.10+ here");
  const { base, spool, work } = await relayWith(t);
  const file = path.join(work, "made by agent.bin");
  const bytes = crypto.randomBytes(MIB + 3);
  fs.writeFileSync(file, bytes);
  const plugin = path.resolve(__dirname, "../../hermes-plugin/hermes-deck");
  const script = [
    "import json, sys, observer",
    "path, spool = sys.argv[1], sys.argv[2]",
    "rows = [{'role': 'assistant', 'content': 'Here: MEDIA:' + path}]",
    "reader = observer.FileReader(load_messages=lambda p, s, l, o: rows[o:o + l], roots=[], spool=spool)",
    "print(json.dumps(reader.grant({'session_id': 's-1', 'path': path})))",
  ].join("\n");
  const run = spawnSync(python, ["-c", script, file, spool.dir], { cwd: plugin, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  if (run.status !== 0 && /ModuleNotFoundError/.test(run.stderr)) return t.skip(`plugin imports unavailable: ${run.stderr.trim().split("\n").pop()}`);
  assert.equal(run.status, 0, run.stderr);
  const reply = JSON.parse(run.stdout);
  assert.deepEqual([reply.name, reply.size], ["made by agent.bin", bytes.length]);
  const res = await fetch(`${base}/downloads/${reply.id}`, { headers: auth });
  assert.equal(res.status, 200);
  assert.equal(sha(Buffer.from(await res.arrayBuffer())), sha(bytes));
  assert.equal(res.headers.get("content-disposition"), `attachment; filename="made by agent.bin"; filename*=UTF-8''made%20by%20agent.bin`);
  assert.equal((fs.statSync(path.join(spool.dir, "downloads")).mode & 0o777).toString(8), "700");
});
