"use strict";
// Safety of the unauthenticated pairing page (src/pair-page.js), one test per rule: response headers, a CSP that
// allows nothing external, no ticket or code in the relay's journal, constant-time lookups, rate-limited and bounded
// misses, a fixed number of open tickets, GET only, no reflected input. Temp dirs and port 0 only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { MobileRelay, createPair } = require("../src/mobile");
const { createServer } = require("../src/server");
const pp = require("../src/pair-page");

const TOKEN = "x".repeat(32);
const model = { snapshot: () => ({}), sessions: new Map(), tokens: () => ({}) };

async function relay(t, { publicUrl = "https://relay.example", limiter = null } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deck-pairpage-safety-")), "devices.json");
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: "off" } });
  const pairPages = new pp.PairPages({ file, publicUrl, ...(limiter ? { limiter } : {}) });
  const srv = createServer({ token: TOKEN, model, fleet: { data: {} }, version: "test", mobile, pairPages });
  await new Promise((resolve) => srv.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await mobile.stop();
    await new Promise((resolve) => srv.server.close(resolve));
  });
  return { file, mobile, pairPages, port: srv.server.address().port };
}
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
const ticketOf = (made) => (made.url || made.path).split("/pair/")[1];
const SAFETY = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

test("safety: every /pair answer (waiting, paired, gone, status, 405, 429) carries no-store, no-referrer, noindex, nosniff, DENY", async (t) => {
  const r = await relay(t, { limiter: new pp.MissLimiter({ limit: 2 }) });
  const waiting = ticketOf(r.pairPages.create());
  const paired = ticketOf(r.pairPages.create());
  r.mobile.pair({ code: pp.codeOf(paired), name: "phone" });
  const answers = [
    await request(r.port, { path: `/pair/${waiting}` }),
    await request(r.port, { path: `/pair/${waiting}/status` }),
    await request(r.port, { path: `/pair/${paired}` }),
    await request(r.port, { path: `/pair/${paired}/status` }),
    await request(r.port, { method: "HEAD", path: `/pair/${waiting}` }),
    await request(r.port, { path: `/pair/${"Z".repeat(32)}` }),
    await request(r.port, { path: `/pair/${"Z".repeat(32)}/status` }),
    await request(r.port, { path: `/pair/${waiting}` }), // now limited: 429
  ];
  assert.deepEqual(answers.map((a) => a.status), [200, 200, 200, 200, 405, 404, 404, 429]);
  for (const a of answers) {
    for (const [k, v] of Object.entries(SAFETY)) assert.equal(a.headers[k], v, `${a.status} ${k}`);
    assert.match(a.headers["content-security-policy"], /default-src 'none'/);
  }
});

test("safety: the page's CSP allows nothing external; inline style and script carry the response's own fresh nonce", async (t) => {
  const r = await relay(t);
  const ticket = ticketOf(r.pairPages.create());
  const a = await request(r.port, { path: `/pair/${ticket}` });
  const b = await request(r.port, { path: `/pair/${ticket}` });
  const policy = a.headers["content-security-policy"];
  const nonce = /script-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)[1];
  assert.equal(policy, `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  assert.ok(Buffer.from(nonce, "base64").length >= 16);
  assert.notEqual(/nonce-([^']+)/.exec(b.headers["content-security-policy"])[1], nonce, "a fresh nonce per response");
  assert.equal((a.body.match(/<script\b/g) || []).length, 1);
  assert.equal((a.body.match(/<style\b/g) || []).length, 1);
  assert.ok(a.body.includes(`<script nonce="${nonce}">`) && a.body.includes(`<style nonce="${nonce}">`));
  assert.ok(!/<script[^>]+src=|<link\b|<img\b|<iframe\b|<object\b|@import|url\(|\sstyle="|\son[a-z]+=/i.test(a.body), "no external or inline-attribute content");
  const urls = a.body.match(/https?:\/\/[^\s"<]+/g) || [];
  assert.deepEqual([...new Set(urls)].sort(), ["http://www.w3.org/2000/svg", "https://relay.example"], "only the SVG namespace and the relay's own address as text");
});

test("safety: neither ticket nor code reaches the relay's journal (console and stdout/stderr) across the whole life cycle", async (t) => {
  const lines = [];
  for (const m of ["log", "info", "warn", "error", "debug"]) t.mock.method(console, m, (...args) => lines.push(args.join(" ")));
  const out = process.stdout.write, err = process.stderr.write;
  process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return out.call(process.stdout, chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return err.call(process.stderr, chunk, ...rest); };
  t.after(() => { process.stdout.write = out; process.stderr.write = err; });
  const r = await relay(t);
  const made = JSON.parse((await request(r.port, { method: "POST", path: "/mobile/pair/page", headers: { authorization: `Bearer ${TOKEN}` } })).body);
  const ticket = ticketOf(made), code = pp.codeOf(ticket);
  await request(r.port, { path: `/pair/${ticket}` });
  await request(r.port, { path: `/pair/${ticket}/status` });
  await request(r.port, { method: "POST", path: `/pair/${ticket}` });
  await request(r.port, { path: `/pair/${ticket.slice(0, 31)}x` });
  await request(r.port, { method: "POST", path: "/mobile/pair", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.replace(/.$/, "0"), name: "phone" }) });
  await request(r.port, { method: "POST", path: "/mobile/pair", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "phone" }) });
  await request(r.port, { path: `/pair/${ticket}` });
  const journal = lines.join("\n");
  assert.ok(!journal.includes(ticket) && !journal.includes(code), "no ticket or code in the journal");
  assert.ok(!fs.readFileSync(`${r.file}.pairs`, "utf8").includes(ticket));
});

test("safety: a lookup compares every stored ticket hash in constant time, whichever entry matches or none", (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deck-pairpage-ct-")), "devices.json");
  const tickets = [pp.createPage(file), pp.createPage(file), pp.createPage(file)].map((m) => m.ticket);
  const calls = t.mock.method(crypto, "timingSafeEqual");
  for (const ticket of [...tickets, "Q".repeat(32)]) {
    const before = calls.mock.callCount();
    pp.lookup(file, ticket);
    assert.equal(calls.mock.callCount() - before, 3, `three comparisons for ${ticket === "Q".repeat(32) ? "a miss" : "a hit"}`);
  }
  for (const c of calls.mock.calls) assert.equal(c.arguments[0].length, 32);
});

test("safety: misses are rate-limited per client address; a limited address gets 429 even for a valid ticket", async (t) => {
  let now = 1_000_000;
  const limiter = new pp.MissLimiter({ now: () => now });
  const r = await relay(t, { limiter });
  const ticket = ticketOf(r.pairPages.create());
  for (let i = 0; i < pp.MISS_LIMIT; i++) assert.equal((await request(r.port, { path: `/pair/${crypto.randomBytes(24).toString("base64url")}` })).status, 404);
  const limited = await request(r.port, { path: `/pair/${ticket}` });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "60");
  assert.ok(!limited.body.includes(pp.codeOf(ticket)));
  assert.equal((await request(r.port, { path: `/pair/${ticket}/status` })).status, 429);
  assert.equal(limiter.limited("203.0.113.9"), false, "another address is not affected");
  now += 60_001;
  assert.equal((await request(r.port, { path: `/pair/${ticket}` })).status, 200, "the window passes");
});

test("safety: the miss table is bounded; once full, new addresses share one overflow bucket that is limited too", () => {
  let now = 0;
  const limiter = new pp.MissLimiter({ limit: 3, maxAddresses: 5, now: () => now });
  for (let i = 0; i < 1000; i++) {
    limiter.miss(`198.51.100.${i}`);
    assert.ok(limiter.map.size <= 5, `size ${limiter.map.size}`);
  }
  assert.equal(limiter.limited("198.51.100.0"), false, "a tracked address keeps its own count");
  assert.equal(limiter.limited("192.0.2.1"), true, "an untracked address falls under the full overflow bucket");
  now += 60_001;
  assert.equal(limiter.limited("192.0.2.1"), false, "everything expires with the window");
  limiter.miss("192.0.2.1");
  assert.equal(limiter.map.size, 1, "expired entries are swept when room is needed");
});

test(`safety: at most ${pp.OPEN_LIMIT} tickets wait at once; the oldest is dropped together with its code`, async (t) => {
  const r = await relay(t);
  const made = [];
  for (let i = 0; i < pp.OPEN_LIMIT + 1; i++) made.push(ticketOf(r.pairPages.create()));
  assert.equal(pp.OPEN_LIMIT, 3);
  assert.equal((await request(r.port, { path: `/pair/${made[0]}/status` })).status, 404, "the oldest is gone");
  for (const ticket of made.slice(1)) assert.equal(JSON.parse((await request(r.port, { path: `/pair/${ticket}/status` })).body).state, "waiting");
  assert.throws(() => r.mobile.pair({ code: pp.codeOf(made[0]), name: "phone" }), /Invalid or expired/);
  const data = JSON.parse(fs.readFileSync(`${r.file}.pairs`, "utf8"));
  assert.equal(Object.keys(data.pages).length, 3);
  assert.equal(Object.keys(data.pairs).length, 3);
  // plain codes count toward the shared limit of 10 pending codes; making a page drops its own oldest first
  for (let i = 0; i < 7; i++) createPair(r.file);
  assert.ok(r.pairPages.create().url, "10 pending, but dropping the oldest page frees a slot");
  const other = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deck-pairpage-full-")), "devices.json");
  for (let i = 0; i < 10; i++) createPair(other);
  assert.throws(() => pp.createPage(other), /Too many pending pairs/);
});

test("safety: HEAD, POST, PUT, DELETE and OPTIONS are refused (405, Allow: GET) and leave the ticket waiting", async (t) => {
  const r = await relay(t);
  const ticket = ticketOf(r.pairPages.create());
  for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
    for (const p of [`/pair/${ticket}`, `/pair/${ticket}/status`]) {
      const res = await request(r.port, { method, path: p });
      assert.equal(res.status, 405, `${method} ${p}`);
      assert.equal(res.headers.allow, "GET");
      assert.ok(!res.body.includes(pp.codeOf(ticket)));
    }
  }
  assert.equal(pp.lookup(r.file, ticket).state, "waiting");
});

test("safety: nothing from the request is reflected (query, headers, Host with a public address set, odd paths)", async (t) => {
  const r = await relay(t);
  const ticket = ticketOf(r.pairPages.create());
  const MARK = "zq9mark";
  const headers = { host: `${MARK}.example`, referer: `https://${MARK}.example/`, "user-agent": `${MARK}<script>`, "accept-language": `${MARK};q=1, tr;q=0.5`, cookie: `${MARK}=1`, "x-forwarded-host": `${MARK}.example` };
  for (const p of [`/pair/${ticket}?x=${MARK}`, `/pair/${ticket}/status?${MARK}=1`, `/pair/${MARK}`, `/pair/${ticket}/${MARK}`, `/pair/%3C${MARK}%3E`]) {
    const res = await request(r.port, { path: p, headers });
    assert.ok(!res.body.includes(MARK), `${p} reflects nothing`);
    assert.ok(!Object.values(res.headers).join(" ").includes(MARK), `${p} headers reflect nothing`);
  }
  assert.match((await request(r.port, { path: `/pair/${ticket}`, headers })).body, /<html lang="tr"/, "only the language choice follows the request");
});
