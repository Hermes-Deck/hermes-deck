"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { fetchImage, fetchAudio } = require("../main/media-fetch");
const hermesDownloads = require("../main/hermes-downloads");

const source = fs.readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
const start = source.indexOf("const DOWNLOAD_TICKET =");
const end = source.indexOf('ipc.handle("bridge:file-cancel"', start);
assert.ok(start >= 0 && end > start, "load the real transfer handlers, not a copy");
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
// Multi-host: a page never changes host. What can change under a transfer is the client of the page's own host
// runtime (the connection restarted, or the saved host was edited), so "host replacement" below means exactly that.
// Another host's runtime never matters to this page.
const REF = "0123456789abcdef";
const OFFER = "/mock/offered.png";
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

function rig({ relayRoute = false, ask = true } = {}) {
  const handlers = new Map(), calls = [], jobs = [], progress = [];
  const dialogEntered = deferred(), dialogResult = deferred();
  const capabilities = { v: 1, host: "0123456789abcdef", maxBytes: 1024 };
  function client(host) {
    return {
      version: async () => ({ downloads: capabilities }),
      fileChunk: async (sid, p, o) => {
        calls.push({ host, method: "chunk", sid, path: p, ...o });
        const bytes = PNG.subarray(o.offset, o.offset + o.length);
        return { size: PNG.length, length: bytes.length, bytes, eof: o.offset + bytes.length === PNG.length };
      },
      fileGrant: async (sid, p, o) => {
        calls.push({ host, method: "grant", sid, path: p, ...o });
        return { id: "fixture-grant", size: PNG.length, mtime: 1 };
      },
    };
  }
  const a = client("A"), b = client("B");
  const relay = {
    connected: true, downloads: capabilities,
    download: async () => { calls.push({ host: "A", method: "stream" }); return { res: "mock-stream" }; },
  };
  // the asking page's host runtime, and a second saved host that is live at the same time
  const rt = { bridge: a, relay: relayRoute ? relay : null, phase: "open" };
  const other = { bridge: client("C"), relay: null, phase: "open" };
  const runtimes = new Map([["host-A", rt], ["host-C", other]]);
  const ctx = {
    require, path,
    ipc: { handle: (name, fn) => handlers.set(name, fn) },
    views: { hostOf: e => e.host, send: (hostId, ch, m) => progress.push([hostId, ch, m]) },
    runtimeOf: e => runtimes.get(e.host),
    relayOf: e => runtimes.get(e.host)?.relay || null,
    needBridge: e => { const b = runtimes.get(e.host)?.bridge; if (!b) throw new Error("offline"); return b; },
    bSid: s => s, bObj: o => o || {}, bProfile: o => o.profile,
    fileOffers: { pathOf: () => OFFER },
    i18nText: key => key, FILE_MAX: 1024,
    media: { safeName: s => s, isRisky: () => false, human: String },
    fetchImage, fetchAudio, hermesDownloads,
    settings: { data: { downloads: { ask, dir: "" } } },
    SHOT: false, defaultDownloadDir: () => "/mock/downloads", resolveFolder: () => "/mock/downloads",
    app: { getPath: () => "/mock/downloads" },
    win: { isDestroyed: () => false },
    dialog: { showSaveDialog: () => { dialogEntered.resolve(); return dialogResult.promise; } },
    downloads: {
      run: async (ticket, job) => {
        jobs.push({ ticket, job });
        if (job.read) await job.read(0, job.size);
        if (job.open) await job.open(0, new AbortController().signal);
        return { status: "done" };
      },
    },
  };
  vm.runInNewContext(source.slice(start, end), ctx);
  const invoke = channel => handlers.get(`bridge:${channel}`)({ host: "host-A" }, "session-A", REF, { ticket: "ticket-001", profile: "profile-A" });
  return { ctx, rt, other, relay, a, b, calls, jobs, progress, dialogEntered, dialogResult, invoke };
}

for (const relayRoute of [false, true]) {
  const route = relayRoute ? "relay" : "chunk";
  test(`${route}: deferred Save As cannot resume after host replacement`, async () => {
    const r = rig({ relayRoute });
    const pending = r.invoke("file-download");
    await r.dialogEntered.promise;
    assert.equal(r.calls.length, 1, "metadata was read from A before Save As");
    assert.equal(r.calls[0].host, "A");
    r.rt.bridge = r.b;
    r.dialogResult.resolve({ filePath: "/mock/downloads/saved.png" });
    await assert.rejects(pending, /download.hostChanged/);
    assert.equal(r.jobs.length, 0, "do not create a local download after the host changed");
    assert.equal(r.calls.length, 1, "no chunk, grant, or stream starts after the switch");
  });

  test(`${route}: unchanged host downloads through the captured bridge`, async () => {
    const r = rig({ relayRoute });
    const pending = r.invoke("file-download");
    await r.dialogEntered.promise;
    r.dialogResult.resolve({ filePath: "/mock/downloads/saved.png" });
    assert.equal((await pending).status, "done");
    assert.equal(r.jobs[0].job.target, "/mock/downloads/saved.png");
    assert.ok(r.calls.every(c => c.host === "A"));
    assert.ok(r.calls.filter(c => c.method !== "stream").every(c => c.sid === "session-A" && c.path === OFFER && c.profile === "profile-A"));
  });

  test(`${route}: a callback retained by Downloads cannot run on a replaced bridge`, async () => {
    const r = rig({ relayRoute, ask: false });
    r.ctx.downloads.run = async (_ticket, job) => {
      r.rt.bridge = r.b;
      if (job.read) await job.read(0, job.size);
      if (job.open) await job.open(0, new AbortController().signal);
    };
    await assert.rejects(r.invoke("file-download"), /download.hostChanged/);
    assert.equal(r.calls.length, 1, "only A's initial metadata request ran");
  });
}

test("Save As cancellation remains cancellation", async () => {
  const r = rig();
  const pending = r.invoke("file-download");
  await r.dialogEntered.promise;
  r.dialogResult.resolve({ canceled: true });
  assert.equal((await pending).status, "cancelled");
  assert.equal(r.jobs.length, 0);
});

test("switch away and back with a fresh client does not revive a pending download", async () => {
  const r = rig();
  const pending = r.invoke("file-download");
  await r.dialogEntered.promise;
  r.rt.bridge = r.b;
  r.rt.bridge = { ...r.a }; // startBridge creates a fresh client even when returning to A
  r.dialogResult.resolve({ filePath: "/mock/downloads/saved.png" });
  await assert.rejects(pending, /download.hostChanged/);
  assert.equal(r.jobs.length, 0);
});

test("late metadata is discarded before opening Save As", async () => {
  const r = rig(), entered = deferred(), reply = deferred();
  r.a.fileChunk = async () => { entered.resolve(); return reply.promise; };
  const pending = r.invoke("file-download");
  await entered.promise;
  r.rt.bridge = r.b;
  reply.resolve({ size: PNG.length });
  r.dialogResult.resolve({ filePath: "/mock/downloads/saved.png" });
  let shown = false;
  r.ctx.dialog.showSaveDialog = async () => { shown = true; return { filePath: "/mock/downloads/saved.png" }; };
  await assert.rejects(pending, /download.hostChanged/);
  assert.equal(shown, false);
  assert.equal(r.jobs.length, 0);
});

test("a final chunk resolving after a host switch cannot complete the download", async () => {
  const r = rig({ ask: false }), entered = deferred(), reply = deferred();
  const original = r.a.fileChunk;
  r.a.fileChunk = async (...args) => {
    if (args[2].length === 1) return original(...args);
    entered.resolve();
    return reply.promise;
  };
  const pending = r.invoke("file-download");
  await entered.promise;
  r.rt.bridge = r.b;
  reply.resolve({ size: PNG.length, length: PNG.length, bytes: PNG, eof: true });
  await assert.rejects(pending, /download.hostChanged/);
  assert.ok(r.calls.every(c => c.host === "A"));
});

test("a late route lookup cannot grant a file or open Save As after switching", async () => {
  const r = rig({ relayRoute: true }), entered = deferred(), reply = deferred();
  r.a.version = async () => { entered.resolve(); return reply.promise; };
  let shown = false;
  r.ctx.dialog.showSaveDialog = async () => { shown = true; return { canceled: true }; };
  const pending = r.invoke("file-download");
  await entered.promise;
  r.rt.bridge = r.b;
  reply.resolve({ downloads: r.relay.downloads });
  await assert.rejects(pending, /download.hostChanged/);
  assert.equal(shown, false);
  assert.equal(r.calls.length, 0);
});

test("a relay body arriving after switching is destroyed instead of consumed", async () => {
  const r = rig({ relayRoute: true, ask: false }), entered = deferred(), reply = deferred();
  r.relay.download = async () => { entered.resolve(); return reply.promise; };
  const pending = r.invoke("file-download");
  await entered.promise;
  r.rt.bridge = r.b;
  let destroyed = false;
  reply.resolve({ res: { destroy: () => { destroyed = true; } } });
  await assert.rejects(pending, /download.hostChanged/);
  assert.equal(destroyed, true);
});

test("stale download progress fails instead of reaching the new host page", async () => {
  const r = rig({ ask: false });
  r.ctx.downloads.run = async (_ticket, job) => {
    r.rt.bridge = r.b;
    job.onProgress({ received: 1, size: PNG.length });
  };
  await assert.rejects(r.invoke("file-download"), /download.hostChanged/);
  assert.equal(r.progress.length, 0);
});

test("switching to a host without a bridge invalidates pending Save As", async () => {
  const r = rig();
  const pending = r.invoke("file-download");
  await r.dialogEntered.promise;
  r.rt.bridge = null;
  r.dialogResult.resolve({ filePath: "/mock/downloads/saved.png" });
  await assert.rejects(pending, /download.hostChanged/);
  assert.equal(r.jobs.length, 0);
});

for (const kind of ["image", "audio"]) {
  test(`${kind}: no bridge remains an unavailable preview`, async () => {
    const r = rig();
    r.rt.bridge = null;
    const result = await r.invoke(`media-${kind}`);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unavailable");
    assert.equal(r.calls.length, 0);
  });

  test(`${kind}: unchanged host preserves preview results`, async () => {
    const r = rig();
    if (kind === "audio") {
      const original = r.a.fileChunk;
      r.a.fileChunk = async (...args) => {
        const c = await original(...args);
        if (c.length > 1) c.bytes = Buffer.from("OggS" + "x".repeat(PNG.length - 4));
        return c;
      };
    }
    const result = await r.invoke(`media-${kind}`);
    assert.equal(result.ok, true);
    assert.equal(result.mime, kind === "image" ? "image/png" : "audio/ogg");
    assert.ok(r.calls.every(c => c.host === "A"));
  });

  for (const delayed of ["metadata", "final chunk"]) {
    test(`${kind}: switch during ${delayed} invalidates the preview`, async () => {
      const r = rig(), entered = deferred(), reply = deferred();
      const original = r.a.fileChunk;
      r.a.fileChunk = async (...args) => {
        const c = await original(...args);
        if ((delayed === "metadata") === (args[2].length === 1)) {
          entered.resolve();
          await reply.promise;
        }
        if (kind === "audio" && c.length > 1) c.bytes = Buffer.from("OggS" + "x".repeat(PNG.length - 4));
        return c;
      };
      const pending = r.invoke(`media-${kind}`);
      await entered.promise;
      r.rt.bridge = r.b;
      reply.resolve();
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(result.reason, "unavailable");
      assert.ok(r.calls.every(c => c.host === "A"), "A's session/path never reaches B");
    });
  }
}

test("another live host replacing its client leaves this page's download alone, and progress returns to the asking page", async () => {
  const r = rig({ ask: false });
  r.ctx.downloads.run = async (_ticket, job) => {
    r.other.bridge = { ...r.other.bridge }; // host C reconnects while host A's page downloads
    job.onProgress({ received: 1, size: PNG.length });
    await job.read(0, job.size);
    return { status: "done" };
  };
  assert.equal((await r.invoke("file-download")).status, "done");
  assert.ok(r.calls.every(c => c.host === "A"));
  assert.deepEqual(r.progress.map(p => [p[0], p[1], p[2].t]), [["host-A", "files", "progress"]]);
});
