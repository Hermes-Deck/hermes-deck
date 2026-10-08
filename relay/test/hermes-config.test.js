"use strict";
// Settings > Hermes config (src/hermes-config.js): token rules on /hermes/*, the save queue and revision check, the
// restart jobs, and (when a Hermes install is present) a real round trip through tools/hermes-config.py on a
// temporary Hermes root.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { HermesConfig, hermesConfigOptions } = require("../src/hermes-config");
const { createServer } = require("../src/server");

const TOKEN = "t".repeat(32);
const model = { snapshot: () => ({}), tokens: () => [], sessions: new Map(), detail: () => null };

async function serve(t, hermesConfig, mobile = null) {
  const srv = createServer({ token: TOKEN, model, fleet: { data: {} }, version: "test", hermesConfig, mobile });
  await new Promise((r) => srv.server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => srv.server.close(() => r())));
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  return (p, { method = "GET", body, token = TOKEN } = {}) =>
    fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json() }));
}

/** An execFile stand-in answering like hermes-config.py. */
function fakeRun(answers, calls) {
  return (cmd, args, opts, cb) => {
    const child = new EventEmitter();
    child.stdin = { end: (s) => (calls[calls.length - 1].input = JSON.parse(s)) };
    calls.push({ cmd, args, env: opts.env });
    setImmediate(() => cb(null, JSON.stringify(answers(args, calls[calls.length - 1])), ""));
    return child;
  };
}

test("hermes config: desktop token only; mobile tokens and wrong tokens are refused", async (t) => {
  const calls = [];
  const hc = new HermesConfig({ python: "/py", root: "/r", run: fakeRun(() => ({ ok: true, fields: {}, profiles: ["default"] }), calls) });
  const mobile = { onHttp: () => false, authenticate: (req) => (req.headers.authorization === "Bearer mobile-token-xxxxxxxxxxxxxxxx" ? { id: "phone" } : null) };
  const req = await serve(t, hc, mobile);
  assert.strictEqual((await req("/hermes/config/schema")).status, 200);
  assert.strictEqual((await req("/hermes/config/schema", { token: "mobile-token-xxxxxxxxxxxxxxxx" })).status, 403);
  assert.strictEqual((await req("/hermes/restart", { method: "POST", body: { target: "gateway" }, token: "mobile-token-xxxxxxxxxxxxxxxx" })).status, 403);
  assert.strictEqual((await req("/hermes/config/schema", { token: "x".repeat(32) })).status, 401);
  assert.strictEqual(calls.length, 1, "refused requests never reach Hermes");
  assert.strictEqual(calls[0].env.HERMES_ROOT, "/r");
  assert.ok(!("DECK_RELAY_TOKEN" in calls[0].env), "the relay's own secrets are not passed on");
});

test("hermes config: profile names are checked before Python runs; errors keep their status", async (t) => {
  const calls = [];
  const hc = new HermesConfig({ python: "/py", root: "/r", run: fakeRun((args) => (args[2] === "set" ? { ok: false, code: 409, error: "changed" } : { ok: true, rev: "a", values: {} }), calls) });
  const req = await serve(t, hc);
  assert.strictEqual((await req("/hermes/config?profile=../etc")).status, 400);
  assert.strictEqual(calls.length, 0);
  const got = await req("/hermes/config?profile=ada");
  assert.deepStrictEqual([got.status, got.body.rev, got.body.restartNeeded], [200, "a", false]);
  assert.deepStrictEqual(calls[0].args.slice(2), ["get", "ada"]);
  const bad = await req("/hermes/config", { method: "POST", body: { profile: "ada", set: { a: 1 } } });
  assert.strictEqual(bad.status, 400, "a save needs the revision");
  const stale = await req("/hermes/config", { method: "POST", body: { profile: "ada", rev: "old", set: { "agent.max_turns": 3 } } });
  assert.deepStrictEqual([stale.status, stale.body.error], [409, "changed"]);
  assert.deepStrictEqual(calls[1].input, { rev: "old", set: { "agent.max_turns": 3 }, unset: [] });
  assert.strictEqual((await req("/hermes/config", { method: "DELETE" })).status, 405);
});

test("hermes config: saves run one at a time and mark a restart as needed", async () => {
  let open = 0, most = 0;
  const run = (cmd, args, opts, cb) => {
    open++;
    most = Math.max(most, open);
    setTimeout(() => { open--; cb(null, JSON.stringify({ ok: true, rev: "n", values: {} }), ""); }, 20);
    return { stdin: { end() {} } };
  };
  const hc = new HermesConfig({ python: "/py", root: "/r", run });
  const rs = await Promise.all([1, 2, 3].map((i) => hc.set({ profile: "default", rev: "x", set: { "agent.max_turns": i } })));
  assert.strictEqual(most, 1);
  assert.ok(rs.every((r) => r.ok && r.restartNeeded));
  assert.strictEqual(hc.restartState().restartNeeded, true);
});

test("hermes config: no Python configured answers 503 instead of failing", async () => {
  const hc = new HermesConfig({ python: "", root: "/r" });
  const r = await hc.schema();
  assert.deepStrictEqual([r.ok, r.code], [false, 503]);
});

test("restart: gateway runs `hermes gateway restart` once at a time; relay exits only under a service manager", async (t) => {
  const kids = [];
  const spawnFn = (cmd, args, opts) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = () => {};
    kids.push({ c, cmd, args, opts });
    return c;
  };
  let quits = 0;
  const hc = new HermesConfig({ python: "/py", root: "/r", hermesBin: "/bin/hermes", spawnFn, supervised: true, quit: () => quits++ });
  hc.restartNeeded = true;
  const req = await serve(t, hc);
  const first = await req("/hermes/restart", { method: "POST", body: { target: "gateway" } });
  assert.deepStrictEqual([first.status, first.body.job.state], [202, "running"]);
  assert.deepStrictEqual([kids[0].cmd, kids[0].args, kids[0].opts.env.HERMES_HOME], ["/bin/hermes", ["gateway", "restart"], "/r"]);
  assert.strictEqual((await req("/hermes/restart", { method: "POST", body: { target: "gateway" } })).status, 409);
  kids[0].c.stdout.emit("data", "✓ restarted\n");
  kids[0].c.emit("close", 0);
  const st = await req("/hermes/restart");
  assert.deepStrictEqual([st.body.gateway.state, st.body.gateway.exitCode, st.body.restartNeeded], ["done", 0, false]);
  assert.match(st.body.gateway.output, /restarted/);
  assert.strictEqual((await req("/hermes/restart", { method: "POST", body: { target: "nope" } })).status, 400);
  const relay = await req("/hermes/restart", { method: "POST", body: { target: "relay" } });
  assert.strictEqual(relay.status, 202);
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(quits, 1, "the relay quits after replying");

  const manual = new HermesConfig({ python: "/py", root: "/r", supervised: false, quit: () => quits++ });
  const req2 = await serve(t, manual);
  assert.strictEqual((await req2("/hermes/restart", { method: "POST", body: { target: "relay" } })).status, 409);
  assert.strictEqual(quits, 1);
});

test("options: off switch, Python fallbacks, supervisor detection", () => {
  assert.strictEqual(hermesConfigOptions({ DECK_HERMES_CONFIG: "0" }).enabled, false);
  assert.strictEqual(hermesConfigOptions({}).enabled, true);
  assert.strictEqual(hermesConfigOptions({ DECK_MOBILE_BRIDGE_PYTHON: "/m/py" }).python, "/m/py");
  assert.strictEqual(hermesConfigOptions({ DECK_HERMES_PYTHON: "/h/py", DECK_MOBILE_BRIDGE_PYTHON: "/m/py" }).python, "/h/py");
  assert.strictEqual(hermesConfigOptions({ INVOCATION_ID: "abc" }).supervised, true);
  assert.strictEqual(hermesConfigOptions({}).supervised, false);
});

// ---------------------------------------------------------------- the real script, against a temporary Hermes root
const PY = process.env.DECK_TEST_HERMES_PYTHON || ["/usr/local/lib/hermes-agent/venv/bin/python", path.join(os.homedir(), ".hermes", "hermes-agent", "venv", "bin", "python")].find((p) => fs.existsSync(p));

test("hermes-config.py: schema, read, save with backup, stale revision, unset, secrets refused", { skip: !PY && "no Hermes install on this machine" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-hcfg-"));
  fs.mkdirSync(path.join(root, "profiles", "ada"), { recursive: true });
  fs.writeFileSync(path.join(root, "config.yaml"), "model:\n  default: test-model\n  provider: custom\n");
  fs.writeFileSync(path.join(root, "profiles", "ada", "config.yaml"), "agent:\n  max_turns: 28\ndisplay:\n  compact: true\n");
  const hc = new HermesConfig({ python: PY, root });
  const schema = await hc.schema();
  assert.strictEqual(schema.ok, true, schema.error);
  assert.deepStrictEqual(schema.profiles, ["default", "ada"]);
  assert.ok(Object.keys(schema.fields).length > 100);
  assert.ok(!Object.keys(schema.fields).some((k) => /(^|[._])(api_key|password|secret|token)$/.test(k)), "secret-like fields are not listed");
  const got = await hc.get("ada");
  assert.strictEqual(got.ok, true, got.error);
  assert.strictEqual(got.values["agent.max_turns"], 28);
  assert.ok(got.explicit.includes("agent.max_turns"));
  const saved = await hc.set({ profile: "ada", rev: got.rev, set: { "agent.max_turns": 40 }, unset: ["display.compact"] });
  assert.strictEqual(saved.ok, true, saved.error);
  assert.strictEqual(saved.values["agent.max_turns"], 40);
  assert.ok(!saved.explicit.includes("display.compact"));
  const text = fs.readFileSync(path.join(root, "profiles", "ada", "config.yaml"), "utf8");
  assert.match(text, /max_turns: 40/);
  assert.doesNotMatch(text, /compact/);
  const backups = fs.readdirSync(path.join(root, "profiles", "ada")).filter((f) => f.startsWith("config.yaml.bak-deck-"));
  assert.strictEqual(backups.length, 1);
  assert.match(fs.readFileSync(path.join(root, "profiles", "ada", backups[0]), "utf8"), /max_turns: 28/);
  const stale = await hc.set({ profile: "ada", rev: got.rev, set: { "agent.max_turns": 1 } });
  assert.deepStrictEqual([stale.ok, stale.code], [false, 409]);
  const secret = await hc.set({ profile: "ada", rev: saved.rev, set: { "delegation.api_key": "x" } });
  assert.deepStrictEqual([secret.ok, secret.code], [false, 400]);
  const wrongType = await hc.set({ profile: "ada", rev: saved.rev, set: { "display.compact": "yes" } });
  assert.deepStrictEqual([wrongType.ok, wrongType.code], [false, 400]);
  const missing = await hc.get("nobody");
  assert.deepStrictEqual([missing.ok, missing.code], [false, 404]);
  fs.rmSync(root, { recursive: true, force: true });
});
