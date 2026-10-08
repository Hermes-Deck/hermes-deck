"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { once } = require("events");
const { createServer } = require("../src/server");
const devtokens = require("../src/devtokens");
const { HostUpdate } = require("../src/host-update");

const RELAY_TOKEN = "fixture-relay-token".repeat(3);
const DEVICE = "a1b2c3d4e5f60708";

async function setup(t, over = {}, serverOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-hostupd-"));
  const root = path.join(dir, "deck");
  fs.mkdirSync(path.join(root, "releases", "1.2.0", "relay"), { recursive: true });
  fs.mkdirSync(path.join(root, "shared", "data"), { recursive: true });
  fs.symlinkSync(process.platform === "win32" ? path.join(root, "releases", "1.2.0") : path.join("releases", "1.2.0"), path.join(root, "current"), process.platform === "win32" ? "junction" : "dir");
  const tokensFile = path.join(dir, "devices.json");
  const deviceToken = devtokens.add(tokensFile, "fixture-pc");
  const clock = { ms: 2_000_000_000 };
  const conns = new Map([[{ mobileDevice: null }, { id: DEVICE, at: clock.ms }]]);
  const presence = { o: { staleMs: 30_000 }, conns, devices: () => new Map([...conns].map(([conn, hb]) => [hb.id, { hb, conn }])) };
  const runs = [];
  const pushed = [];
  const hu = new HostUpdate({
    dataDir: path.join(root, "shared", "data"), relayDir: path.join(root, "current", "relay"), version: "1.2.0", remoteUpdate: true,
    tokensFile, presence, plugins: () => ({ default: "1.2.0" }), restarts: { rows: () => [], restartNow: async (p) => ({ ok: true, state: "restarted", profile: p }) },
    platform: "linux", uid: 1000, node: "/usr/bin/node", now: () => clock.ms, fs,
    run: async (cmd, args) => { runs.push([cmd, ...args].join(" ")); return { code: 0, out: "" }; },
    broadcast: (m) => pushed.push(m), ...over,
  });
  const relay = createServer({ token: RELAY_TOKEN, model: { sessions: new Map(), snapshot: () => ({}), tokens: () => ({}) }, fleet: { data: {} }, hostUpdate: hu, ...serverOptions });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  t.after(async () => { await new Promise((r) => relay.server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: "POST", headers: { authorization: `Bearer ${RELAY_TOKEN}`, "x-deck-device-id": DEVICE, "x-deck-device-token": deviceToken, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { dir, root, hu, base, post, runs, pushed, clock, presence, conns, deviceToken };
}

test("needs the bearer header, a desktop device token and a live desktop connection", async (t) => {
  const x = await setup(t);
  assert.equal((await fetch(`${x.base}/host/update?token=${RELAY_TOKEN}`, { method: "POST" })).status, 401);
  assert.equal((await x.post("/host/update", { version: "1.3.0" }, { "x-deck-device-token": "f".repeat(64) })).status, 403);
  x.clock.ms += 31_000;
  assert.equal((await x.post("/host/update", { version: "1.3.0" })).status, 403, "stale presence");
  x.clock.ms -= 31_000;
  for (const conn of x.conns.keys()) conn.mobileDevice = { id: DEVICE };
  assert.equal((await x.post("/host/update", { version: "1.3.0" })).status, 403, "a mobile connection is never a desktop");
});

test("starts the updater job with the version, status file and restart queue", async (t) => {
  const x = await setup(t);
  const r = await x.post("/host/update", { version: "1.3.0" });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { state: "started", version: "1.3.0" });
  assert.equal(x.runs.length, 1);
  assert.equal(x.runs[0], ["systemd-run", "--user", `--unit=hermes-deck-update-${x.clock.ms}`, "--collect", "--quiet", "--", "/usr/bin/node",
    path.join(x.root, "current", "relay", "bin", "deck-relay-update"), "apply", "--version", "1.3.0", "--with-plugin", "--status-file",
    path.join(x.root, "shared", "data", "update-status.json"), "--restart-queue", path.join(x.root, "shared", "data", "restart-queue.json")].join(" "));
  const st = JSON.parse(fs.readFileSync(path.join(x.root, "shared", "data", "update-status.json"), "utf8"));
  assert.equal(st.state, "running");
  assert.equal(st.job.kind, "systemd");
});

test("current host: nothing runs; plugin behind with relay current runs the plugin subcommand", async (t) => {
  const x = await setup(t);
  assert.deepEqual(await (await x.post("/host/update", { version: "1.2.0" })).json(), { state: "current", version: "1.2.0" });
  assert.deepEqual(await (await x.post("/host/update", { version: "1.1.0" })).json(), { state: "current", version: "1.1.0" }, "never a downgrade");
  assert.equal(x.runs.length, 0);
  const y = await setup(t, { plugins: () => ({ default: "1.1.1", research: null }) });
  assert.equal((await y.post("/host/update", { version: "1.2.0" })).status, 202);
  assert.match(y.runs[0], /deck-relay-update plugin --status-file /);
});

test("second request follows the running update instead of starting another", async (t) => {
  const x = await setup(t);
  await x.post("/host/update", { version: "1.3.0" });
  const r = await x.post("/host/update", { version: "1.3.0" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).state, "running");
  assert.equal(x.runs.length, 1);
  assert.equal((await x.post("/host/update", { version: "1.4.0" })).status, 409, "a newer target waits for the running one");
});

test("stale running status (no update for 15 min) no longer blocks", async (t) => {
  const x = await setup(t);
  await x.post("/host/update", { version: "1.3.0" });
  x.clock.ms += 16 * 60 * 1000;
  for (const hb of x.conns.values()) hb.at = x.clock.ms;
  assert.equal((await x.post("/host/update", { version: "1.3.0" })).status, 202);
  assert.equal(x.runs.length, 2);
});

test("refused: kill switch, plain checkout, bad version, unsupported platform, job start failure", async (t) => {
  assert.equal((await (await setup(t, { remoteUpdate: false })).post("/host/update", { version: "1.3.0" })).status, 403);
  const plain = await setup(t);
  plain.hu.relayDir = path.join(plain.dir, "checkout", "relay");
  const r = await plain.post("/host/update", { version: "1.3.0" });
  assert.equal(r.status, 409);
  assert.match((await r.json()).command, /deck-relay-update init/);
  assert.equal((await (await setup(t)).post("/host/update", { version: "v1.3" })).status, 400);
  assert.equal((await (await setup(t, { platform: "win32" })).post("/host/update", { version: "1.3.0" })).status, 501);
  const failing = await setup(t, { run: async () => ({ code: 1, out: "Failed to connect to bus" }) });
  const f = await failing.post("/host/update", { version: "1.3.0" });
  assert.equal(f.status, 500);
  assert.match((await f.json()).error, /bus/);
});

test("status survives a relay restart and is pushed when the file changes", async (t) => {
  const x = await setup(t);
  await x.post("/host/update", { version: "1.3.0" });
  const file = path.join(x.root, "shared", "data", "update-status.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), step: "health", state: "running" }));
  const fresh = new HostUpdate({ ...x.hu.o, broadcast: (m) => x.pushed.push(m) }); // the new relay process
  assert.equal(fresh.info().status.step, "health");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), step: "done", state: "done" }));
  fresh.poll();
  assert.equal(x.pushed.at(-1).t, "hostUpdate");
  assert.equal(x.pushed.at(-1).status.state, "done");
});

test("/host/restart passes a profile to the queue runner", async (t) => {
  const x = await setup(t);
  const r = await x.post("/host/restart", { profile: "research" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, state: "restarted", profile: "research" });
});

test("both mutations refuse query-only, empty and wrong bearers even when query tokens are enabled", async (t) => {
  const x = await setup(t, {}, { queryToken: true });
  for (const endpoint of ["/host/update", "/host/restart"]) {
    for (const authorization of ["", "Basic fixture", "Bearer ", "Bearer wrong"]) {
      const r = await x.post(`${endpoint}?token=${RELAY_TOKEN}`, { version: "1.3.0", profile: "research" }, { authorization });
      assert.equal(r.status, 401, `${endpoint}: ${authorization}`);
    }
  }
  assert.equal(x.runs.length, 0);
});

test("both mutations reject mobile bearers, absent credentials and disconnected or invalid presence", async (t) => {
  const x = await setup(t, {}, { mobile: { onHttp: () => false, authenticate: (req) => req.headers.authorization === "Bearer mobile-fixture" ? { id: DEVICE } : null } });
  for (const endpoint of ["/host/update", "/host/restart"]) {
    const body = { version: "1.3.0", profile: "research" };
    assert.equal((await x.post(endpoint, body, { authorization: "Bearer mobile-fixture" })).status, 403);
    assert.equal((await x.post(endpoint, body, { "x-deck-device-id": "" })).status, 401);
    assert.equal((await x.post(endpoint, body, { "x-deck-device-token": "" })).status, 403);
    assert.equal((await x.post(endpoint, body, { "x-deck-device-id": "ffffffff" })).status, 403);
    const [conn, hb] = [...x.conns][0];
    conn.mobileDevice = { id: DEVICE };
    assert.equal((await x.post(endpoint, body)).status, 403);
    conn.mobileDevice = null;
    hb.at = undefined;
    assert.equal((await x.post(endpoint, body)).status, 403);
    hb.at = x.clock.ms - 30_000;
    assert.equal((await x.post(endpoint, body)).status, 403);
    x.conns.clear();
    assert.equal((await x.post(endpoint, body)).status, 403);
    x.conns.set(conn, { ...hb, at: x.clock.ms });
  }
  assert.equal(x.runs.length, 0);
});

test("restart kill switch and queue failures are returned without claiming success", async (t) => {
  const disabled = await setup(t, { remoteUpdate: false, restarts: { rows: () => [], restartNow: () => assert.fail("disabled restart ran") } });
  assert.equal((await disabled.post("/host/restart", { profile: "research" })).status, 403);
  const { Restarts } = require("../src/restarts");
  const x = await setup(t);
  x.hu.restarts = new Restarts({ file: x.hu.queueFile, hermesRoot: x.dir, run: () => assert.fail("unready profile restarted") });
  for (const profile of ["../escape", "missing"]) assert.equal((await x.post("/host/restart", { profile })).status, 409);
  fs.writeFileSync(x.hu.queueFile, JSON.stringify([{ profile: "research", pending: true, since: new Date(x.clock.ms).toISOString() }]));
  const r = await x.post("/host/restart", { profile: "research" });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).state, "waiting");
});

test("malformed and oversized bodies get JSON errors on both mutations", async (t) => {
  const x = await setup(t);
  for (const endpoint of ["/host/update", "/host/restart"]) {
    for (const [body, status] of [["{", 400], ["[]", 400], ["null", 400], [JSON.stringify({ padding: "x".repeat(4096) }), 413]]) {
      const r = await fetch(`${x.base}${endpoint}`, { method: "POST", headers: { authorization: `Bearer ${RELAY_TOKEN}`, "x-deck-device-id": DEVICE, "x-deck-device-token": x.deviceToken }, body });
      assert.equal(r.status, status);
      assert.equal(typeof (await r.json()).error, "string");
    }
  }
  assert.equal(x.runs.length, 0);
});

test("version must be a strict X.Y.Z string", async (t) => {
  const x = await setup(t);
  for (const version of ["01.2.0", "1.2", "1.3.0;echo bad", ["1.3.0"], 123]) {
    assert.equal((await x.post("/host/update", { version })).status, 400);
  }
  assert.equal(x.runs.length, 0);
});

test("both mutations recheck desktop presence and token revocation after reading the body", async (t) => {
  for (const endpoint of ["/host/update", "/host/restart"]) {
    for (const revoke of [false, true]) {
      const x = await setup(t);
      let checked;
      const inspected = new Promise((r) => { checked = r; });
      const devices = x.presence.devices;
      x.presence.devices = () => { checked(); return devices(); };
      const req = http.request(`${x.base}${endpoint}`, { method: "POST", headers: { authorization: `Bearer ${RELAY_TOKEN}`, "x-deck-device-id": DEVICE, "x-deck-device-token": x.deviceToken } });
      const response = once(req, "response");
      req.write('{"version":"1.3.0",');
      await inspected;
      if (revoke) devtokens.revoke(x.hu.tokensFile, "fixture-pc"); else x.conns.clear();
      req.end('"profile":"research"}');
      const [res] = await response;
      res.resume();
      await once(res, "end");
      assert.equal(res.statusCode, 403, `${endpoint}: ${revoke ? "revoked token" : "disconnected"}`);
      assert.equal(x.runs.length, 0);
    }
  }
});

test("overlapping requests share the starting job and a newer target waits", async (t) => {
  let launched, release;
  const entered = new Promise((r) => { launched = r; });
  const pending = new Promise((r) => { release = r; });
  let runs = 0;
  const x = await setup(t, { run: async () => { runs++; launched(); return pending; } });
  const first = x.post("/host/update", { version: "1.3.0" });
  try {
    await entered;
    assert.equal((await x.post("/host/update", { version: "1.3.0" })).status, 200);
    assert.equal((await x.post("/host/update", { version: "1.4.0" })).status, 409);
    assert.equal(runs, 1);
  } finally { release({ code: 0, out: "" }); }
  assert.equal((await first).status, 202);
});

test("queue-only changes push hostUpdate and unchanged polls stay quiet", async (t) => {
  let rows = [];
  const x = await setup(t, { restarts: { rows: () => rows } });
  x.hu.poll();
  const before = x.pushed.length;
  rows = [{ profile: "research", state: "busy" }];
  x.hu.poll();
  assert.equal(x.pushed.length, before + 1);
  assert.deepEqual(x.pushed.at(-1), { t: "hostUpdate", remote: { enabled: true, managed: true }, status: null, restarts: rows });
  x.hu.poll();
  assert.equal(x.pushed.length, before + 1);
});

test("first poll after a relay restart cleans up a finished launchd job only once", async (t) => {
  const x = await setup(t, { platform: "darwin" });
  const plistFile = path.join(x.hu.dataDir, "update-job.plist");
  fs.writeFileSync(plistFile, "fixture plist");
  fs.writeFileSync(x.hu.statusFile, JSON.stringify({ state: "done", version: "1.3.0", job: { kind: "launchd", label: "com.hermes-deck.update.123", plistFile } }));
  const fresh = new HostUpdate(x.hu.o);
  fresh.poll();
  await new Promise(setImmediate);
  assert.deepEqual(x.runs, ["launchctl bootout gui/1000/com.hermes-deck.update.123"]);
  assert.equal(fs.existsSync(plistFile), false);
  fresh.poll();
  assert.equal(x.runs.length, 1);
});

test("an update refuses to overwrite a plugin newer than the release it would install", async (t) => {
  const x = await setup(t, { plugins: () => ({ default: "1.1.0", research: "1.4.0" }) });
  assert.equal((await x.post("/host/update", { version: "1.2.0" })).status, 409);
  assert.equal((await x.post("/host/update", { version: "1.3.0" })).status, 409);
  assert.equal(x.runs.length, 0);
});

test("a new launchd job waits until cleanup stops using the shared plist", async (t) => {
  let entered, release;
  const cleaning = new Promise((r) => { entered = r; });
  const pending = new Promise((r) => { release = r; });
  const x = await setup(t, { platform: "darwin", run: async (_cmd, args) => {
    if (args[0] === "bootout") { entered(); return pending; }
    return { code: 0, out: "" };
  } });
  const plistFile = path.join(x.hu.dataDir, "update-job.plist");
  fs.writeFileSync(plistFile, "old plist");
  fs.writeFileSync(x.hu.statusFile, JSON.stringify({ state: "done", version: "1.2.0", job: { kind: "launchd", label: "com.hermes-deck.update.123", plistFile } }));
  x.hu.poll();
  await cleaning;
  try {
    assert.equal((await x.post("/host/update", { version: "1.3.0" })).status, 409);
    assert.equal(fs.readFileSync(plistFile, "utf8"), "old plist");
  } finally { release({ code: 0, out: "" }); await new Promise(setImmediate); }
  assert.equal((await x.post("/host/update", { version: "1.3.0" })).status, 202);
  assert.match(fs.readFileSync(plistFile, "utf8"), /<key>ProgramArguments<\/key>/);
});
