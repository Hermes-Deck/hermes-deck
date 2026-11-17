"use strict";
// Phone pairing page (src/pair-page.js): ticket + pending code, the page, its status route, the life cycle
// (waiting -> paired | gone), restart behaviour. Temp dirs and port 0 only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { MobileRelay, createPair } = require("../src/mobile");
const { createServer } = require("../src/server");
const tokens = require("../src/devtokens");
const pp = require("../src/pair-page");

const TOKEN = "x".repeat(32);
const model = { snapshot: () => ({}), sessions: new Map(), tokens: () => ({}) };

function tmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `deck-pairpage-${name}-`));
  return path.join(dir, "devices.json");
}

/** A relay on 127.0.0.1:0 with the mobile API and the pairing page; `clock` drives the page's notion of now. */
async function relay(t, { publicUrl = null, clock = null } = {}) {
  const file = tmp("relay");
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: "off" } });
  const pairPages = new pp.PairPages({ file, publicUrl, ...(clock ? { now: clock } : {}) });
  const srv = createServer({ token: TOKEN, model, fleet: { data: {} }, version: "test", mobile, pairPages });
  await new Promise((resolve) => srv.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await mobile.stop();
    await new Promise((resolve) => srv.server.close(resolve));
  });
  return { file, mobile, pairPages, port: srv.server.address().port };
}

/** One raw HTTP request (any method and headers, Host included); resolves {status, headers, body}. */
function request(port, { method = "GET", path: p = "/", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers, setHost: !("host" in headers) }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const json = (r) => JSON.parse(r.body);
const ticketOf = (made) => (made.url || made.path).split("/pair/")[1];
/** The code as the page shows it: groups of four in one selectable field. */
const shown = (code) => `<dd class="code">${[code.slice(0, 16), code.slice(16)].map((h) => `<span class="half">${h.match(/.{4}/g).map((g) => `<span>${g}</span>`).join("")}</span>`).join("")}</dd>`;

test("pair page: a ticket is 192 random bits as base64url, is not the code, and the pairing file stores hashes only", () => {
  const file = tmp("store");
  const made = pp.createPage(file, { now: 1000 });
  assert.match(made.ticket, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(Buffer.from(made.ticket, "base64url").length, 24);
  assert.equal(made.path, `/pair/${made.ticket}`);
  assert.equal(made.url, undefined);
  assert.equal(made.expiresAt, new Date(1000 + 5 * 60 * 1000).toISOString());
  const code = pp.codeOf(made.ticket);
  assert.match(code, /^[a-f0-9]{32}$/);
  assert.notEqual(code, made.ticket);
  const raw = fs.readFileSync(`${file}.pairs`, "utf8");
  assert.ok(!raw.includes(made.ticket) && !raw.includes(code), "neither ticket nor code in clear on disk");
  const data = JSON.parse(raw);
  assert.deepEqual(data.pairs[tokens.hash(code)], { expires: made.expires, page: true });
  assert.deepEqual(data.pages[tokens.hash(made.ticket)], { code: tokens.hash(code), created: 1000, expires: made.expires });
  assert.equal((fs.statSync(`${file}.pairs`).mode & 0o777).toString(8), "600");
  assert.notEqual(pp.createPage(file, { now: 1000 }).ticket, made.ticket);
});

test("pair page: waiting page shows QR code, deep link, address and code; status says waiting with no secret", async (t) => {
  const r = await relay(t, { publicUrl: "https://relay.example" });
  const made = r.pairPages.create();
  assert.match(made.url, /^https:\/\/relay\.example\/pair\/[A-Za-z0-9_-]{32}$/);
  assert.equal(made.path, undefined);
  const ticket = ticketOf(made), code = pp.codeOf(ticket);
  const page = await request(r.port, { path: `/pair/${ticket}` });
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /^text\/html; charset=utf-8/);
  const u = Buffer.from("https://relay.example").toString("base64url");
  const link = `hermesdeck://pair?u=${u}&amp;c=${code}`;
  assert.ok(page.body.includes(`href="${link}"`), "Open in Hermes Deck link");
  assert.ok(page.body.includes(shown(code)), "code as selectable text");
  assert.ok(page.body.includes("<dd>https://relay.example</dd>"), "address as selectable text");
  assert.match(page.body, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*role="img"/);
  assert.match(page.body, /<span id="left">[45]:\d\d<\/span>/);
  assert.ok(!page.body.includes(ticket), "the page does not repeat its own ticket");
  const st = await request(r.port, { path: `/pair/${ticket}/status` });
  assert.equal(st.status, 200);
  const body = json(st);
  assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "remainingS", "state"]);
  assert.equal(body.state, "waiting");
  assert.ok(body.remainingS > 290 && body.remainingS <= 300);
  assert.ok(!st.body.includes(code) && !st.body.includes(ticket));
});

test("pair page: the first pairing kills the ticket; page and status then show the device name, never the code", async (t) => {
  const r = await relay(t, { publicUrl: "https://relay.example" });
  const ticket = ticketOf(r.pairPages.create()), code = pp.codeOf(ticket);
  const pair = await request(r.port, { method: "POST", path: "/mobile/pair", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Ada's <phone>" }) });
  assert.equal(pair.status, 200);
  assert.ok(json(pair).token);
  const st = await request(r.port, { path: `/pair/${ticket}/status` });
  assert.deepEqual(json(st), { state: "paired", name: "Ada's <phone>" });
  const page = await request(r.port, { path: `/pair/${ticket}` });
  assert.equal(page.status, 200);
  assert.ok(page.body.includes("Ada&#39;s &lt;phone&gt;"), "name escaped");
  assert.ok(!page.body.includes("<svg") && !page.body.includes(code) && !page.body.includes(`<span>${code.slice(0, 4)}</span>`) && !page.body.includes("hermesdeck://"));
  // the code is spent: a second pairing fails
  const again = await request(r.port, { method: "POST", path: "/mobile/pair", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "other" }) });
  assert.equal(again.status, 401);
});

test("pair page: expiry, and a paired ticket after its keep time, answer the same generic page and status as an unknown one", async (t) => {
  let now = Date.now();
  const r = await relay(t, { clock: () => now });
  const waiting = ticketOf(r.pairPages.create());
  const paired = ticketOf(r.pairPages.create());
  r.mobile.pair({ code: pp.codeOf(paired), name: "phone" });
  const unknown = "A".repeat(32);
  const lang = { "accept-language": "en" };
  const baseline = await request(r.port, { path: `/pair/${unknown}`, headers: lang });
  const baseStatus = await request(r.port, { path: `/pair/${unknown}/status` });
  assert.equal(baseline.status, 404);
  assert.deepEqual(json(baseStatus), { state: "gone" });
  assert.equal(baseStatus.status, 404);
  now += 5 * 60 * 1000 + 1;
  const strip = (s) => s.replace(/nonce-[^']+'/g, "").replace(/nonce="[^"]+"/g, "");
  for (const ticket of [waiting, paired, unknown, "short", "B".repeat(31) + "!"]) {
    const page = await request(r.port, { path: `/pair/${encodeURIComponent(ticket)}`, headers: lang });
    assert.equal(page.status, 404, ticket);
    assert.equal(strip(page.body), strip(baseline.body), `same page for ${ticket}`);
    const st = await request(r.port, { path: `/pair/${encodeURIComponent(ticket)}/status` });
    assert.equal(st.status, 404);
    assert.equal(st.body, baseStatus.body);
  }
  for (const p of ["/pair", "/pair/", `/pair/${waiting}/other`, `/pair/${waiting}/status/x`]) {
    const res = await request(r.port, { path: p });
    assert.equal(res.status, 404, p);
  }
});

test("pair page: a pairing of the code typed by hand (POST /mobile/pair) also ends the page", async (t) => {
  const r = await relay(t);
  const ticket = ticketOf(r.pairPages.create());
  r.mobile.pair({ code: pp.codeOf(ticket), name: "  Atlas\nphone  " }, "hand");
  assert.deepEqual(pp.lookup(r.file, ticket), { state: "paired", name: "Atlas phone" });
});

test("pair page: plain pairing codes and page tickets share the pending-code file; tickets survive a restart like codes", async (t) => {
  const file = tmp("restart");
  const code = createPair(file);
  const made = pp.createPage(file);
  const first = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: "off" } });
  await first.stop();
  // a new process (relay restart): the file is all there is
  assert.equal(pp.lookup(file, made.ticket).state, "waiting");
  const second = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: "off" } });
  t.after(() => second.stop());
  assert.ok(second.pair({ code, name: "phone" }).token, "the plain code still pairs");
  assert.equal(pp.lookup(file, made.ticket).state, "waiting", "a plain pairing leaves the page alone");
  second.pair({ code: pp.codeOf(made.ticket), name: "tablet" });
  assert.deepEqual(pp.lookup(file, made.ticket), { state: "paired", name: "tablet" });
});
