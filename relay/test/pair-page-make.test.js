"use strict";
// Making a pairing page: the host tool (`mobile-token.js page`), the desktop route POST /mobile/pair/page, the
// DECK_RELAY_PUBLIC_URL setting and the address the page builds when it is unset. Temp dirs and port 0 only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { MobileRelay } = require("../src/mobile");
const { createServer } = require("../src/server");
const pp = require("../src/pair-page");

const TOKEN = "x".repeat(32);
const TOOL = path.join(__dirname, "..", "tools", "mobile-token.js");
const model = { snapshot: () => ({}), sessions: new Map(), tokens: () => ({}) };
const tmpDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `deck-pairpage-${name}-`));
/** The code as the page shows it: groups of four in one selectable field. */
const shown = (code) => `<dd class="code">${[code.slice(0, 16), code.slice(16)].map((h) => `<span class="half">${h.match(/.{4}/g).map((g) => `<span>${g}</span>`).join("")}</span>`).join("")}</dd>`;

async function relay(t, { publicUrl = null } = {}) {
  const file = path.join(tmpDir("make"), "devices.json");
  const mobile = new MobileRelay({ tokensFile: file, bridgeConfig: { mode: "off" } });
  const pairPages = new pp.PairPages({ file, publicUrl });
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
function tool(dir, args, env = {}) {
  const run = { DECK_RELAY_ENV: path.join(dir, "absent.env"), DECK_RELAY_TOKEN: TOKEN, DECK_MOBILE_DEVICES_FILE: path.join(dir, "devices.json"), PATH: process.env.PATH, TZ: "UTC", ...env };
  try {
    return { code: 0, out: execFileSync(process.execPath, [TOOL, ...args], { env: run, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || ""), err: String(e.stderr || "") };
  }
}

test("publicBase: https only, no credentials/query/fragment, trailing slash dropped, a path prefix kept", () => {
  assert.equal(pp.publicBase(""), null);
  assert.equal(pp.publicBase(undefined), null);
  assert.equal(pp.publicBase("https://relay.example/"), "https://relay.example");
  assert.equal(pp.publicBase(" https://Relay.Example:8443/deck/ "), "https://relay.example:8443/deck");
  assert.throws(() => pp.publicBase("http://relay.example"), /https/);
  assert.throws(() => pp.publicBase("relay.example"), /not a URL|https/);
  assert.throws(() => pp.publicBase("https://u:p@relay.example"), /plain/);
  assert.throws(() => pp.publicBase("https://relay.example/?x=1"), /plain/);
  assert.throws(() => pp.publicBase("https://relay.example/#x"), /plain/);
});

test("tool: `page` prints the URL and expiry with DECK_RELAY_PUBLIC_URL set, never the code; --json prints {url, expiresAt}", () => {
  const dir = tmpDir("tool");
  const r = tool(dir, ["page"], { DECK_RELAY_PUBLIC_URL: "https://relay.example/" });
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^https:\/\/relay\.example\/pair\/[A-Za-z0-9_-]{32}$/);
  assert.match(lines[1], /^Expires: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \(.+\); single use, gone after the first pairing\.$/);
  const ticket = lines[0].split("/pair/")[1];
  assert.ok(!r.out.includes(pp.codeOf(ticket)), "the code itself is never printed");
  assert.equal(pp.lookup(path.join(dir, "devices.json"), ticket).state, "waiting");
  const j = tool(dir, ["page", "--json"], { DECK_RELAY_PUBLIC_URL: "https://relay.example" });
  const parsed = JSON.parse(j.out);
  assert.deepEqual(Object.keys(parsed).sort(), ["expiresAt", "url"]);
  assert.ok(Date.parse(parsed.expiresAt) - Date.now() > 290000);
});

test("tool: without DECK_RELAY_PUBLIC_URL it says so and prints the path only; a bad value is named; `pair` is unchanged", () => {
  const dir = tmpDir("tool-unset");
  const r = tool(dir, ["page"]);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split("\n");
  assert.match(lines[0], /^\/pair\/[A-Za-z0-9_-]{32}$/);
  assert.match(lines[2], /^DECK_RELAY_PUBLIC_URL is not set: only the path is printed/);
  assert.deepEqual(Object.keys(JSON.parse(tool(dir, ["page", "--json"]).out)).sort(), ["expiresAt", "path"]);
  const bad = tool(dir, ["page"], { DECK_RELAY_PUBLIC_URL: "http://relay.example" });
  assert.match(bad.out, /^\/pair\//);
  assert.match(bad.out, /DECK_RELAY_PUBLIC_URL must start with https:\/\/: only the path is printed/);
  assert.match(tool(dir, ["pair"]).out.trim(), /^[a-f0-9]{32}$/);
  const usage = tool(dir, ["page", "extra"]);
  assert.equal(usage.code, 1);
  assert.match(usage.err, /pair \| page \[--json\] \| list \| revoke/);
  assert.equal(tool(dir, ["page"], { DECK_RELAY_TOKEN: "short" }).code, 1);
});

test("desktop route: POST /mobile/pair/page needs the relay token; a phone token is refused; other methods 405", async (t) => {
  const r = await relay(t, { publicUrl: "https://relay.example" });
  const post = (headers) => request(r.port, { method: "POST", path: "/mobile/pair/page", headers });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ authorization: "Bearer wrong" })).status, 401);
  const ok = await post({ authorization: `Bearer ${TOKEN}` });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["cache-control"], "no-store");
  const made = JSON.parse(ok.body);
  assert.deepEqual(Object.keys(made).sort(), ["expiresAt", "url"]);
  assert.match(made.url, /^https:\/\/relay\.example\/pair\/[A-Za-z0-9_-]{32}$/);
  assert.equal(pp.lookup(r.file, made.url.split("/pair/")[1]).state, "waiting");
  // a paired phone's token
  const paired = r.mobile.pair({ code: pp.codeOf(made.url.split("/pair/")[1]), name: "phone" });
  const phone = await post({ authorization: `Bearer ${paired.token}` });
  assert.equal(phone.status, 403);
  assert.equal((await request(r.port, { method: "GET", path: "/mobile/pair/page", headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
  assert.equal((await request(r.port, { method: "GET", path: "/mobile/pair/page", headers: { authorization: `Bearer ${paired.token}` } })).status, 403);
});

test("desktop route: without a public address the answer carries the path only", async (t) => {
  const r = await relay(t);
  const ok = await request(r.port, { method: "POST", path: "/mobile/pair/page", headers: { authorization: `Bearer ${TOKEN}` } });
  const made = JSON.parse(ok.body);
  assert.deepEqual(Object.keys(made).sort(), ["expiresAt", "path"]);
  assert.match(made.path, /^\/pair\/[A-Za-z0-9_-]{32}$/);
});

test("address: unset setting -> https://<Host> when Host is a plain name; anything else -> code only; set -> Host ignored", async (t) => {
  const r = await relay(t);
  const ticket = r.pairPages.create().path.split("/pair/")[1];
  const code = pp.codeOf(ticket);
  const u = (a) => Buffer.from(a).toString("base64url");
  const page = (host) => request(r.port, { path: `/pair/${ticket}`, headers: { host } });
  const named = await page("Relay.Example:8443");
  assert.ok(named.body.includes(`hermesdeck://pair?u=${u("https://relay.example:8443")}&amp;c=${code}`));
  assert.ok(named.body.includes("<dd>https://relay.example:8443</dd>"));
  for (const host of ['relay.example"><script>x</script>', "relay.example/evil", "user@relay.example", "[::1]:9330", "-bad.example", "a".repeat(300)]) {
    const res = await page(host);
    assert.equal(res.status, 200, host);
    assert.ok(!res.body.includes("<svg") && !res.body.includes("hermesdeck://"), `no QR for ${host}`);
    assert.ok(res.body.includes(shown(code)), "the code is still shown");
    assert.ok(!res.body.includes("<script>x") && !res.body.includes("evil") && !res.body.includes("user@"), `nothing reflected for ${host}`);
  }
  const fixed = await relay(t, { publicUrl: "https://relay.example/deck" });
  const t2 = fixed.pairPages.create().url.split("/pair/")[1];
  const res = await request(fixed.port, { path: `/pair/${t2}`, headers: { host: "attacker.example" } });
  assert.ok(res.body.includes(`u=${u("https://relay.example/deck")}&amp;`));
  assert.ok(!res.body.includes("attacker"));
});
