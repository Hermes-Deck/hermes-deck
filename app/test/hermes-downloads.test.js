"use strict";
// Large downloads on the desktop: path selection (relay + plugin on one spool), the strict deck.file_grant validator,
// the relay download helper against a real relay (downloads.js), resume with Range after a cut stream, cancel, ticket
// re-grant, and the limit message.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { PassThrough } = require("node:stream");
const bridge = require("../main/bridge");
const { RelayClient, helloDownloads } = require("../main/relay");
const { downloadRoute, pickRoute, activeLimit, opener, tooBig } = require("../main/hermes-downloads");
const { Downloads, FILE_MAX, retriable } = require("../main/hermes-files");
const media = require("../main/media");
const i18n = require("../renderer/i18n");
const { UploadSpool } = require("../../relay/src/uploads");
const { DownloadTickets } = require("../../relay/src/downloads");
const { createServer } = require("../../relay/src/server");

const GIB = 1024 ** 3;
const MIB = 1024 * 1024;
const HOST = "0123456789abcdef";
const RELAY = { v: 1, host: HOST, maxBytes: 8 * GIB };
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `deck-hd-${name}-`));
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

test("deck.file_grant: a read with exactly {session_id, path, profile?}", () => {
  const ok = { session_id: "s-1", path: "/srv/example/out/build.iso" };
  bridge.checkRequest("deck.file_grant", ok);
  bridge.checkRequest("deck.file_grant", { ...ok, profile: "bot-a" });
  assert.ok(bridge.READS.includes("deck.file_grant") && !bridge.MUTATIONS.includes("deck.file_grant"));
  const bad = [{ ...ok, offset: 0 }, { ...ok, length: 1 }, { session_id: "s-1" }, { path: ok.path }, { ...ok, path: "relative" }, { ...ok, path: "/a\u0000b" },
    { ...ok, path: "/" + "a".repeat(5000) }, { ...ok, session_id: "a b" }, { ...ok, profile: "../x" }, { ...ok, extra: 1 }];
  for (const p of bad) assert.throws(() => bridge.checkRequest("deck.file_grant", p), /not valid|geçerli/i, JSON.stringify(p).slice(0, 80));
});

test("path selection: relay downloads only when both name the same spool host; the smaller cap applies", async () => {
  assert.deepEqual(downloadRoute(RELAY, { v: 1, host: HOST, maxBytes: 8 * GIB }), { maxBytes: 8 * GIB });
  assert.deepEqual(downloadRoute({ ...RELAY, maxBytes: 3 * GIB }, { v: 1, host: HOST, maxBytes: 8 * GIB }), { maxBytes: 3 * GIB });
  assert.deepEqual(downloadRoute(RELAY, { v: 1, host: HOST, maxBytes: GIB }), { maxBytes: GIB });
  assert.equal(downloadRoute(RELAY, { v: 1, host: "fedcba9876543210", maxBytes: GIB }), null, "another host or folder");
  assert.equal(downloadRoute(RELAY, null), null, "an older plugin");
  assert.equal(downloadRoute(null, { v: 1, host: HOST, maxBytes: GIB }), null, "an older relay");
  assert.equal(downloadRoute({ ...RELAY, v: 2 }, { v: 1, host: HOST, maxBytes: GIB }), null);
  assert.equal(downloadRoute(RELAY, { v: 1, host: HOST, maxBytes: 0 }), null);
  assert.deepEqual(helloDownloads({ ...RELAY, extra: 1 }), RELAY);
  assert.equal(helloDownloads({ ...RELAY, host: "../x" }), null);
  assert.equal(helloDownloads({ ...RELAY, maxBytes: "8" }), null);
  assert.equal(helloDownloads(undefined), null);
  const relay = { connected: true, downloads: RELAY, download() {} };
  const plugin = (downloads) => ({ version: async () => ({ version: "1.3.3", protocol: 1, uploads: null, downloads }) });
  assert.deepEqual((await pickRoute(relay, plugin({ v: 1, host: HOST, maxBytes: 8 * GIB }))).maxBytes, 8 * GIB);
  assert.equal(await pickRoute(relay, plugin(null)), null, "plugin without deck.file_grant");
  assert.equal(await pickRoute(relay, plugin({ v: 1, host: "fedcba9876543210", maxBytes: GIB })), null, "host mismatch");
  assert.equal(await pickRoute({ ...relay, connected: false }, plugin({ v: 1, host: HOST, maxBytes: GIB })), null, "relay offline");
  assert.equal(await pickRoute({ ...relay, downloads: null }, plugin({ v: 1, host: HOST, maxBytes: GIB })), null, "relay without downloads");
  assert.equal(await pickRoute(null, plugin({ v: 1, host: HOST, maxBytes: GIB })), null, "no relay configured");
  assert.equal(await pickRoute(relay, { version: async () => { throw new Error("down"); } }), null);
  assert.equal(activeLimit(null), FILE_MAX);
  assert.equal(activeLimit({ maxBytes: 8 * GIB }), 8 * GIB);
});

test("limit message names the active limit (EN + TR); too-big errors carry it", async (t) => {
  t.after(() => i18n.setLanguage("en"));
  i18n.setLanguage("en");
  assert.equal(i18n.t("download.tooBig", { n: media.human(8 * GIB) }), "The file is too large to download (8 GB at most).");
  assert.equal(i18n.t("download.tooBig", { n: media.human(FILE_MAX) }), "The file is too large to download (200 MB at most).");
  i18n.setLanguage("tr");
  assert.equal(i18n.t("download.tooBig", { n: media.human(8 * GIB) }), "Dosya indirilemeyecek kadar büyük (en fazla 8 GB).");
  const dl = new Downloads({ dir: tmp("cap") });
  const e = await dl.run("t-cap", { name: "a.iso", size: 9 * GIB, max: 8 * GIB, open: async () => { throw new Error("never opened"); } }).catch((x) => x);
  assert.deepEqual([e.code, e.max], ["too-big", 8 * GIB]);
  const old = await dl.run("t-old", { name: "a.iso", size: FILE_MAX + 1, read: async () => { throw new Error("never read"); } }).catch((x) => x);
  assert.deepEqual([old.code, old.max], ["too-big", FILE_MAX]);
  assert.equal(tooBig({ rpcCode: 4083 }), true);
  assert.equal(tooBig({ rpcCode: 4081 }), false);
  assert.equal(retriable({ relayDownload: true, status: 404 }), false);
  assert.equal(retriable({ relayDownload: true, status: 503 }), true);
  assert.equal(retriable({ relayDownload: true, code: "network" }), true);
  assert.equal(retriable({ code: "changed" }), false);
});

/** A real relay (createServer + spool + DownloadTickets) and a RelayClient for it; `cut(n)` breaks the next response after n bytes. */
async function relayFor(t) {
  const dir = tmp("relay");
  const token = "t".repeat(32);
  const spool = new UploadSpool({ dir: path.join(dir, "spool"), machine: "m" });
  const downloads = new DownloadTickets({ spool });
  const model = { snapshot: () => ({ sessions: [] }), tokens: () => ({}), sessions: new Map() };
  const srv = createServer({ token, model, fleet: { data: {} }, version: "test", uploads: spool, downloads });
  const seen = [];
  let cutAfter = null;
  srv.server.prependListener("request", (req, res) => {
    seen.push({ url: req.url, range: req.headers.range || null });
    if (cutAfter === null) return;
    const limit = cutAfter;
    cutAfter = null;
    let sent = 0;
    const write = res.write.bind(res);
    res.write = (chunk, ...rest) => {
      sent += chunk.length;
      if (sent > limit) {
        res.socket.destroy(); // the connection drops mid-file
        return false;
      }
      return write(chunk, ...rest);
    };
  });
  await new Promise((resolve) => srv.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { spool.stop(); srv.server.closeAllConnections?.(); await new Promise((resolve) => srv.server.close(resolve)); });
  const client = new RelayClient({ url: `ws://127.0.0.1:${srv.server.address().port}`, token });
  const work = path.join(dir, "work");
  fs.mkdirSync(work);
  /** What the plugin's deck.file_grant writes (observer.py write_download_ticket). */
  const grant = (file) => {
    const st = fs.statSync(file, { bigint: true });
    const id = crypto.randomBytes(24).toString("hex");
    const ticket = { v: 1, id, path: fs.realpathSync(file), name: path.basename(file), size: Number(st.size), mtime_ns: st.mtimeNs.toString(), dev: st.dev.toString(), ino: st.ino.toString(), created: Date.now(), expires: Date.now() + 900000 };
    fs.mkdirSync(downloads.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(downloads.dir, `${id}.json`), JSON.stringify(ticket), { mode: 0o600 });
    return { id, name: ticket.name, size: ticket.size, mtime: Number(st.mtimeMs) / 1000 };
  };
  return { client, spool, downloads, dir, work, grant, seen, cut: (n) => { cutAfter = n; } };
}

test("relay download: streams into the .part and renames; a cut stream resumes with Range from the last byte", async (t) => {
  const { client, work, grant, seen, cut, dir } = await relayFor(t);
  const file = path.join(work, "build.iso");
  const bytes = crypto.randomBytes(24 * MIB + 7);
  fs.writeFileSync(file, bytes);
  const g = grant(file);
  const out = path.join(dir, "out");
  fs.mkdirSync(out);
  const dl = new Downloads({ dir: out, retryMs: 10 });
  const progress = [];
  cut(5 * MIB);
  const r = await dl.run("t-resume", { name: g.name, size: g.size, max: 8 * GIB, open: opener({ relay: client, bridge: null, sid: "s-1", path: file, grant: g }), onProgress: (p) => progress.push(p.received) });
  assert.equal(r.status, "done");
  assert.equal(r.name, "build.iso");
  const saved = fs.readFileSync(path.join(out, "build.iso"));
  assert.equal(saved.length, bytes.length);
  assert.equal(sha(saved), sha(bytes), "byte-identical after the resume");
  assert.equal(seen.length, 2, "one cut, one resume");
  assert.equal(seen[0].range, null);
  const resumed = Number(/^bytes=(\d+)-$/.exec(seen[1].range)[1]);
  assert.ok(resumed > 0 && resumed <= 5 * MIB + 1024 * 1024, `resumed from ${resumed}`);
  assert.deepEqual([...progress].sort((a, b) => a - b), progress, "progress never goes back");
  assert.equal(progress.at(-1), bytes.length);
  assert.deepEqual(fs.readdirSync(out), ["build.iso"], "no .part left, nothing overwritten");
  // a second download of the same name never overwrites the first
  const again = await dl.run("t-again", { name: g.name, size: g.size, open: opener({ relay: client, bridge: null, sid: "s-1", path: file, grant: g }) });
  assert.equal(again.name, "build (1).iso");
});

test("relay download: cancel stops the stream at once and leaves nothing; a refused file fails without retries", async (t) => {
  const { client, work, grant, seen, dir } = await relayFor(t);
  const file = path.join(work, "big.bin");
  fs.writeFileSync(file, crypto.randomBytes(32 * MIB));
  const g = grant(file);
  const out = path.join(dir, "out");
  fs.mkdirSync(out);
  const dl = new Downloads({ dir: out, retryMs: 10 });
  let cancelled = false;
  const run = dl.run("t-cancel", { name: g.name, size: g.size, open: opener({ relay: client, bridge: null, sid: "s", path: file, grant: g }),
    onProgress: () => { if (!cancelled) { cancelled = true; dl.cancel("t-cancel"); } } });
  assert.deepEqual(await run, { status: "cancelled" });
  assert.deepEqual(fs.readdirSync(out), [], "no .part and no reserved name left");
  // the file changed after the grant: the relay answers 409; no retry, the "changed" message
  const before = seen.length;
  fs.appendFileSync(file, "x");
  const e = await dl.run("t-changed", { name: g.name, size: g.size, open: opener({ relay: client, bridge: null, sid: "s", path: file, grant: g }) }).catch((x) => x);
  assert.deepEqual([e.relayDownload, e.status], [true, 409]);
  assert.equal(seen.length - before, 1, "a refusal is not retried");
  assert.deepEqual(fs.readdirSync(out), []);
});

test("an expired ticket is granted once more for the same file; a different file is 'changed'", async () => {
  const notFound = Object.assign(new Error("Download missing or expired"), { relayDownload: true, status: 404, code: "not_found" });
  const asked = [];
  const relay = { download: async (id, { start }) => { asked.push([id, start]); if (id === "a".repeat(48)) throw notFound; const res = new PassThrough(); res.end(Buffer.alloc(4, 1)); return { res }; } };
  const grants = [];
  const plugin = (mtime) => ({ fileGrant: async (sid, p, o) => { grants.push([sid, p, o]); return { id: "b".repeat(48), name: "f", size: 4, mtime }; } });
  const first = { id: "a".repeat(48), name: "f", size: 4, mtime: 100 };
  const open = opener({ relay, bridge: plugin(100), sid: "s-1", path: "/srv/example/f", profile: "bot-a", grant: first });
  const body = await open(0, null);
  assert.equal(body.read().length, 4);
  assert.deepEqual(asked, [["a".repeat(48), 0], ["b".repeat(48), 0]]);
  assert.deepEqual(grants, [["s-1", "/srv/example/f", { profile: "bot-a" }]]);
  const moved = opener({ relay, bridge: plugin(200), sid: "s-1", path: "/srv/example/f", grant: first });
  await assert.rejects(moved(0, null), (e) => e.code === "changed");
});

test("retries: a stream cut again and again without progress gives up; one that makes progress keeps going", async (t) => {
  const out = tmp("retry");
  const dl = new Downloads({ dir: out, retries: 2, retryMs: 1 });
  let opens = 0;
  const dead = await dl.run("t-dead", { name: "a.bin", size: 10, open: async () => { opens++; throw Object.assign(new Error("ECONNRESET"), { relayDownload: true, code: "network" }); } }).catch((e) => e);
  assert.equal(dead.code, "network");
  assert.equal(opens, 3, "the first try plus two retries");
  assert.deepEqual(fs.readdirSync(out), []);
  // each attempt delivers one byte, then drops: progress resets the count, so all 10 bytes arrive
  const data = Buffer.from("0123456789");
  const starts = [];
  const r = await dl.run("t-trickle", { name: "b.bin", size: 10, open: async (start) => {
    starts.push(start);
    const s = new PassThrough();
    s.write(data.subarray(start, start + 1));
    setImmediate(() => s.destroy(Object.assign(new Error("aborted"), { code: "ECONNRESET" })));
    return s;
  } });
  assert.equal(r.status, "done");
  assert.deepEqual(starts, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(fs.readFileSync(path.join(out, "b.bin")).toString(), "0123456789");
  // more bytes than the grant said: the file changed, never written past its size
  const over = await dl.run("t-over", { name: "c.bin", size: 3, open: async () => { const s = new PassThrough(); s.end(Buffer.from("abcd")); return s; } }).catch((e) => e);
  assert.equal(over.code, "changed");
  assert.ok(!fs.readdirSync(out).includes("c.bin"));
});

test("the bridge asks deck.file_grant and checks the reply (fake stream)", async (t) => {
  const FAKE = path.join(__dirname, "fake-stream.js");
  const CFG = { mode: "ssh", target: "hermes-test", python: "/usr/bin/python3", stream: "/home/user/.hermes/hermes-deck/stream.py" };
  const FAST = { request: 1500, write: 1000, handshake: 1500, heartbeat: 1200, kill: 500, backoffMin: 40, backoffMax: 160, keepalive: 60000 };
  const c = new bridge.BridgeClient(CFG, { launch: { file: process.execPath, args: [FAKE, "--serve", "--plugin-version", "1.3.3", "--download-host", HOST] }, timing: FAST });
  t.after(() => c.stop());
  await new Promise((resolve) => { c.on("status", (s) => s.status === "open" && resolve()); c.start(); });
  const g = await c.fileGrant("s-files", "/srv/example/out/report.txt", { profile: "default" });
  assert.deepEqual(Object.keys(g).sort(), ["id", "mtime", "name", "size"]);
  assert.equal(g.id, "d".repeat(48));
  await assert.rejects(c.fileGrant("s-files", "/srv/example/out/other.txt", { profile: "default" }), (e) => e.rpcCode === 4081);
  assert.deepEqual((await c.version()).downloads, { v: 1, host: HOST, maxBytes: 8 * GIB });
});
