"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DesktopHost, containerName, volumeName, NET_SCRIPTS, SNAP_SCRIPTS } = require("../main/desktop-host");
// token files are named from a hex encoding of the profile: unique on case-insensitive filesystems, never a device name
const tokenFileName = (p) => Buffer.from(p, "utf8").toString("hex") + ".token";

const HELPER_DIGEST = "sha256:" + "c".repeat(64);
const PIN = {
  repository: "ghcr.io/trycua/linux",
  digest: "sha256:" + "a".repeat(64),
  tag: "24.04-slim",
  helper: { repository: "alpine", digest: HELPER_DIGEST, tag: "3.20" },
};
const HELPER_IMAGE = `alpine@${HELPER_DIGEST}`;
const SUBNET = "172.30.0.0/16";
// docker may list an IPv6 subnet first; the host must use only the IPv4 one
const SUBNET_OUT = `fd12:3456:789a::/64\n\n${SUBNET}\n`;

/** Fake docker runner. Defaults: the isolation network exists and every helper script succeeds. */
function fake(answers = {}) {
  const calls = [];
  const run = async (argv) => {
    calls.push(argv);
    const key = argv.slice(0, 2).join(" ");
    const a = typeof answers[key] === "function" ? answers[key](argv) : answers[key];
    if (a instanceof Error) throw a;
    if (a) return { code: 0, stdout: "", stderr: "", ...a };
    if (argv.includes(SNAP_SCRIPTS.measure)) return { code: 0, stdout: "0\t/home", stderr: "" };
    if (argv.includes(SNAP_SCRIPTS.pack)) return { code: 0, stdout: "20", stderr: "" };
    if (key === "container inspect") return { code: 1, stdout: "", stderr: "No such container" };
    if (key === "network inspect") return { code: 0, stdout: SUBNET_OUT, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "deck-dh-"));

// What a recorded call was, so tests can assert order without caring about every flag.
const isHelper = (a) => a[0] === "run" && a.includes("--privileged");
function kindOf(a) {
  if (isHelper(a)) {
    const s = a[a.length - 3];
    if (s === NET_SCRIPTS.setup) return "netSetup";
    if (s === NET_SCRIPTS.check) return "netCheck";
    if (s === NET_SCRIPTS.teardown) return "netTeardown";
    return "helper?";
  }
  if (a[0] === "run" && a.includes("-d")) return "create";
  if (a[0] === "start") return "start";
  if (a[0] === "rm") return "rm";
  if (a[0] === "network" && a[1] === "create") return "netCreate";
  if (a[0] === "network" && a[1] === "rm") return "netRm";
  return null;
}
const kinds = (calls) => calls.map(kindOf).filter(Boolean);
const createArgv = (calls) => calls.find((a) => kindOf(a) === "create");
/** A "run --rm" answer for fake(): the isolation rules are missing until setup has run (check exits 1 before). */
function rulesMissing() {
  let applied = false;
  return (argv) => {
    if (kindOf(argv) === "netSetup") applied = true;
    if (kindOf(argv) === "netCheck") return { code: applied ? 0 : 1 };
    return undefined;
  };
}

test("names: Docker-safe and unique; a name Docker would reject is refused", () => {
  assert.equal(containerName("aurora"), "hermes-deck-space-aurora");
  assert.equal(volumeName("team-two"), "hermes-deck-home-team-two");
  for (const bad of [".hidden", "-x", "", "a/b", "a b", "x".repeat(65), "../etc"]) assert.equal(containerName(bad), null, bad);
  assert.notEqual(containerName("Aurora"), containerName("aurora"), "case is kept, so two profiles never share a container");
});

test("ensure creates a desktop the first time: pinned digest, loopback port, token in env, limits, home volume", async () => {
  const f = fake({ "container inspect": { code: 1, stdout: "", stderr: "No such container" }, "port hermes-deck-space-aurora": { code: 0, stdout: "127.0.0.1:49731\n" } });
  const h = new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: { memory: "1.5g", cpus: 2, shm: "1g", network: null } });
  const r = await h.ensure("aurora");
  assert.deepEqual(r, { port: 49731 });
  const runArgv = createArgv(f.calls);
  assert.ok(runArgv.includes(`${PIN.repository}@${PIN.digest}`));
  assert.ok(runArgv.includes("127.0.0.1::3211"));
  assert.ok(runArgv.includes("hermes-deck-home-aurora:/home/cua"));
  assert.ok(runArgv.includes("--memory") && runArgv.includes("1.5g") && runArgv.includes("--shm-size"));
  assert.ok(!runArgv.includes("--privileged"));
  assert.deepEqual(runArgv.slice(0, 3), ["run", "--pull", "never"], "a removed image fails clearly, never pulled implicitly");
  const envIdx = runArgv.indexOf("-e");
  assert.match(runArgv[envIdx + 1], /^CUA_ENV_TOKEN=[a-f0-9]{48}$/);
  assert.equal(h.tokenOf("aurora"), runArgv[envIdx + 1].slice("CUA_ENV_TOKEN=".length));
});

test("ensure starts a stopped desktop and keeps its token across host restarts", async () => {
  const dir = tmp();
  const created = fake({ "container inspect": { code: 1, stderr: "No such container" }, "port hermes-deck-space-aurora": { code: 0, stdout: "127.0.0.1:40001\n" } });
  const h1 = new DesktopHost({ run: created.run, pin: PIN, dataDir: dir, opts: {} });
  await h1.ensure("aurora");
  const tok = h1.tokenOf("aurora");
  const stopped = fake({ "container inspect": { code: 0, stdout: JSON.stringify([{ State: { Running: false }, Config: { Image: `${PIN.repository}@${PIN.digest}` } }]) }, "port hermes-deck-space-aurora": { code: 0, stdout: "127.0.0.1:40002\n" } });
  const h2 = new DesktopHost({ run: stopped.run, pin: PIN, dataDir: dir, opts: {} });
  assert.deepEqual(await h2.ensure("aurora"), { port: 40002 });
  assert.ok(stopped.calls.some((a) => a[0] === "start" && a[1] === "hermes-deck-space-aurora"));
  assert.ok(!stopped.calls.some((a) => kindOf(a) === "create"), "no new container is created");
  assert.equal(h2.tokenOf("aurora"), tok, "the token file outlives the process");
  const mode = fs.statSync(path.join(dir, tokenFileName("aurora"))).mode;
  // POSIX permission bits do not exist on win32 (fs reports 0o666 whatever mode was asked for), so this
  // one assertion is skipped there; everywhere else the token file must be private to the owner.
  if (process.platform !== "win32") assert.equal(mode & 0o077, 0, "token file is 0600");
});

test("a desktop made from another image is recreated, its home volume kept", async () => {
  const f = fake({ "container inspect": { code: 0, stdout: JSON.stringify([{ State: { Running: false }, Config: { Image: "ghcr.io/trycua/linux@sha256:" + "b".repeat(64) } }]) }, "port hermes-deck-space-aurora": { code: 0, stdout: "127.0.0.1:40003\n" } });
  const h = new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: {} });
  await h.ensure("aurora");
  assert.ok(f.calls.some((a) => a[0] === "rm" && a.includes("hermes-deck-space-aurora")));
  assert.ok(!f.calls.some((a) => a[0] === "volume" && a[1] === "rm"));
  assert.ok(f.calls.some((a) => kindOf(a) === "create"));
});

test("reset removes container and home volume; a bad profile never reaches docker", async () => {
  const f = fake();
  const h = new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: {} });
  await h.reset("aurora");
  assert.ok(f.calls.some((a) => a.join(" ") === "rm -f hermes-deck-space-aurora"));
  assert.ok(f.calls.some((a) => a.join(" ") === "volume rm -f hermes-deck-home-aurora"));
  await assert.rejects(h.ensure("../x"), /bad profile/);
  await assert.rejects(h.reset("-rf"), /bad profile/);
  assert.equal(f.calls.filter((a) => a[0] === "rm" || (a[0] === "volume" && a[1] === "rm")).length, 2);
});

test("list and stats read only this host's labelled desktops", async () => {
  const f = fake({
    "ps -a": { code: 0, stdout: "hermes-deck-space-aurora\tUp 3 minutes\t127.0.0.1:40010->3211/tcp\nhermes-deck-space-pioneer\tExited (0) 2 hours ago\t\n" },
    "ps --filter": { code: 0, stdout: "hermes-deck-space-aurora\n" },
    "stats --no-stream": { code: 0, stdout: "hermes-deck-space-aurora\t812.4MiB / 1.5GiB\t12.50%\n" },
  });
  const h = new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: {} });
  assert.deepEqual(await h.list(), [{ profile: "aurora", running: true, port: 40010 }, { profile: "pioneer", running: false, port: null }]);
  assert.deepEqual(await h.stats(), [{ profile: "aurora", memMB: 812, cpuPct: 12.5 }]);
  assert.ok(f.calls.find((a) => a[0] === "ps").includes("label=hermes-deck.space=1"));
});

test("stats names the running labelled desktops: docker stats has no --filter (Docker 29 refuses it)", async () => {
  const f = fake({
    "ps --filter": { code: 0, stdout: "hermes-deck-space-aurora\nhermes-deck-space-pioneer\nsomething-else\n" },
    "stats --no-stream": (argv) =>
      argv.includes("--filter")
        ? { code: 125, stdout: "", stderr: "unknown flag: --filter" }
        : { code: 0, stdout: "hermes-deck-space-aurora\t300MiB / 1.5GiB\t2.00%\nhermes-deck-space-pioneer\t1.2GiB / 1.5GiB\t40.00%\n" },
  });
  const h = new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: {} });
  assert.deepEqual(await h.stats(), [{ profile: "aurora", memMB: 300, cpuPct: 2 }, { profile: "pioneer", memMB: 1229, cpuPct: 40 }]);
  const ps = f.calls.find((a) => a[0] === "ps");
  assert.ok(ps.includes("label=hermes-deck.space=1") && ps.includes("status=running"));
  const st = f.calls.find((a) => a[0] === "stats");
  assert.ok(!st.includes("--filter"));
  assert.deepEqual(st.slice(-2), ["hermes-deck-space-aurora", "hermes-deck-space-pioneer"], "only this host's desktops, by name");
  // nothing running: no docker stats call at all (without names it would list every container on the machine)
  const idle = fake({ "ps --filter": { code: 0, stdout: "" } });
  assert.deepEqual(await new DesktopHost({ run: idle.run, pin: PIN, dataDir: tmp(), opts: {} }).stats(), []);
  assert.ok(!idle.calls.some((a) => a[0] === "stats"));
});

test("docker(): missing / stopped / ready", async () => {
  assert.equal(await new DesktopHost({ run: async () => { throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }); }, pin: PIN, dataDir: tmp() }).docker(), "missing");
  assert.equal(await new DesktopHost({ run: async () => ({ code: 1, stderr: "Cannot connect to the Docker daemon" }), pin: PIN, dataDir: tmp() }).docker(), "stopped");
  assert.equal(await new DesktopHost({ run: async () => ({ code: 0, stdout: "27.3.1" }), pin: PIN, dataDir: tmp() }).docker(), "ready");
});

// ---- network isolation (docs/agent-spaces.md, "Limits and isolation") ----

test("the isolation scripts are the probe's, verbatim", () => {
  assert.ok(NET_SCRIPTS.setup.startsWith('set -e; apk add -q iptables 2>/dev/null; S="$1"; C="-m comment --comment hermes-deck";'));
  assert.equal((NET_SCRIPTS.setup.match(/iptables -I /g) || []).length, 4);
  assert.ok(!/ -[ID] /.test(NET_SCRIPTS.check.replace(/-C /g, "")), "check changes nothing");
  assert.ok(NET_SCRIPTS.teardown.endsWith("; true"));
  for (const s of Object.values(NET_SCRIPTS)) assert.ok(s.includes("100.64.0.0/10") && s.includes("169.254.0.0/16"));
});

test("netEnsure: creates the network when missing, reads the IPv4 subnet, runs setup then check with the probe's argv", async () => {
  let inspected = 0;
  const f = fake({ "network inspect": () => (inspected++ === 0 ? { code: 1, stderr: "No such network" } : { code: 0, stdout: SUBNET_OUT }), "run --rm": rulesMissing() });
  const h = new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: {} });
  await h.netEnsure();
  assert.deepEqual(kinds(f.calls), ["netCreate", "netCheck", "netSetup", "netCheck"]);
  assert.deepEqual(f.calls.find((a) => kindOf(a) === "netCreate"), [
    "network", "create", "--driver", "bridge", "--opt", "com.docker.network.bridge.enable_icc=false",
    "--label", "hermes-deck.space=1", "hermes-deck-desktops",
  ]);
  // --pull never: a removed helper image fails clearly instead of being pulled implicitly (it is pulled with consent)
  assert.deepEqual(f.calls.find((a) => kindOf(a) === "netSetup"), ["run", "--rm", "--pull", "never", "--privileged", "--net=host", HELPER_IMAGE, "sh", "-c", NET_SCRIPTS.setup, "sh", SUBNET]);
  assert.deepEqual(f.calls.find((a) => kindOf(a) === "netCheck"), ["run", "--rm", "--pull", "never", "--privileged", "--net=host", HELPER_IMAGE, "sh", "-c", NET_SCRIPTS.check, "sh", SUBNET]);
});

test("netEnsure: an existing network is not created again", async () => {
  const f = fake();
  await new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: {} }).netEnsure();
  assert.deepEqual(kinds(f.calls), ["netCheck"]);
});

test("ensure creates desktops on the isolation network, with one --restart no", async () => {
  const f = fake({ "container inspect": { code: 1, stderr: "No such container" }, "port hermes-deck-space-aurora": { code: 0, stdout: "127.0.0.1:49731\n" } });
  const h = new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: {} });
  await h.ensure("aurora");
  const a = createArgv(f.calls);
  const n = a.indexOf("--network");
  assert.ok(n > 0 && a[n + 1] === "hermes-deck-desktops");
  assert.equal(a.filter((x) => x === "--restart").length, 1);
  assert.equal(a[a.indexOf("--restart") + 1], "no");
  assert.ok(!a.includes("--privileged"));
  // opts.network cannot opt a host out of isolation
  const f2 = fake({ "container inspect": { code: 1, stderr: "No such container" }, "port hermes-deck-space-aurora": { code: 0, stdout: "127.0.0.1:1\n" } });
  await new DesktopHost({ run: f2.run, pin: PIN, dataDir: tmp(), opts: { network: null } }).ensure("aurora");
  assert.ok(createArgv(f2.calls).includes("hermes-deck-desktops"));
});

test("fail closed: netEnsure runs (its check) before every create", async () => {
  const f = fake({ "container inspect": { code: 1, stderr: "No such container" }, "port hermes-deck-space-aurora": { code: 0, stdout: "127.0.0.1:40020\n" } });
  await new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: {} }).ensure("aurora");
  assert.deepEqual(kinds(f.calls), ["netCheck", "create"]);
});

test("fail closed: netEnsure runs before every start, and before the recreate's rm", async () => {
  const inspectOf = (image) => ({ code: 0, stdout: JSON.stringify([{ State: { Running: false }, Config: { Image: image } }]) });
  const f = fake({ "container inspect": inspectOf(`${PIN.repository}@${PIN.digest}`), "port hermes-deck-space-aurora": { code: 0, stdout: "127.0.0.1:40021\n" } });
  await new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: {} }).ensure("aurora");
  assert.deepEqual(kinds(f.calls), ["netCheck", "start"]);
  const g = fake({ "container inspect": inspectOf("ghcr.io/trycua/linux@sha256:" + "b".repeat(64)), "port hermes-deck-space-aurora": { code: 0, stdout: "127.0.0.1:40022\n" } });
  await new DesktopHost({ run: g.run, pin: PIN, dataDir: tmp(), opts: {} }).ensure("aurora");
  assert.deepEqual(kinds(g.calls), ["netCheck", "rm", "create"]);
});

test("fail closed: a failing netSetup makes ensure reject and nothing is created, started or removed", async () => {
  for (const inspect of [
    { code: 1, stderr: "No such container" }, // would create
    { code: 0, stdout: JSON.stringify([{ State: { Running: false }, Config: { Image: `${PIN.repository}@${PIN.digest}` } }]) }, // would start
    { code: 0, stdout: JSON.stringify([{ State: { Running: false }, Config: { Image: "x@sha256:" + "b".repeat(64) } }]) }, // would recreate
  ]) {
    const f = fake({
      "container inspect": inspect,
      "run --rm": (argv) => (kindOf(argv) === "netSetup" ? { code: 1, stderr: "apk: network is unreachable" } : kindOf(argv) === "netCheck" ? { code: 1 } : undefined), // rules missing; setup fails
    });
    const h = new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: {} });
    await assert.rejects(h.ensure("aurora"), /network isolation could not be set up/);
    assert.deepEqual(kinds(f.calls).filter((k) => ["create", "start", "rm"].includes(k)), []);
    assert.ok(!f.calls.some((a) => a[0] === "start" || (a[0] === "run" && a.includes("-d"))));
  }
});

test("fail closed: a runner that throws, or a failing netCheck, or an IPv6-only network, also rejects ensure", async () => {
  const cases = [
    { "run --rm": new Error("spawn docker EPERM") },
    { "run --rm": (argv) => (kindOf(argv) === "netCheck" ? { code: 1 } : undefined) },
    { "network inspect": { code: 0, stdout: "fd12:3456::/64\n" } },
    { "network create": { code: 1, stderr: "pool overlaps" }, "network inspect": { code: 1, stderr: "No such network" } },
  ];
  for (const answers of cases) {
    const f = fake({ "container inspect": { code: 1, stderr: "No such container" }, ...answers });
    const h = new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: {} });
    await assert.rejects(h.ensure("aurora"), /network isolation could not be set up/);
    assert.ok(!f.calls.some((a) => kindOf(a) === "create"));
  }
});

test("fail closed: no pinned helper image means no desktop", async () => {
  const f = fake({ "container inspect": { code: 1, stderr: "No such container" } });
  const { helper, ...noHelper } = PIN;
  const h = new DesktopHost({ run: f.run, pin: noHelper, dataDir: tmp(), opts: {} });
  await assert.rejects(h.ensure("aurora"), /network isolation could not be set up/);
  assert.ok(!f.calls.some((a) => kindOf(a) === "create"));
});

test("a desktop on some other network is recreated, never started on the default bridge", async () => {
  const f = fake({
    "container inspect": { code: 0, stdout: JSON.stringify([{ State: { Running: false }, Config: { Image: `${PIN.repository}@${PIN.digest}` }, HostConfig: { NetworkMode: "bridge" } }]) },
    "port hermes-deck-space-aurora": { code: 0, stdout: "127.0.0.1:40023\n" },
  });
  await new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: {} }).ensure("aurora");
  assert.deepEqual(kinds(f.calls), ["netCheck", "rm", "create"]);
  assert.ok(!f.calls.some((a) => a[0] === "volume"), "its home volume stays");
});

test("an already running desktop on the isolation network is left alone", async () => {
  const f = fake({
    "container inspect": { code: 0, stdout: JSON.stringify([{ State: { Running: true }, Config: { Image: `${PIN.repository}@${PIN.digest}` }, HostConfig: { NetworkMode: "hermes-deck-desktops" } }]) },
    "port hermes-deck-space-aurora": { code: 0, stdout: "127.0.0.1:40024\n" },
  });
  assert.deepEqual(await new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: {} }).ensure("aurora"), { port: 40024 });
  assert.deepEqual(kinds(f.calls), []);
});

test("netCheck: true only on exit 0, read-only", async () => {
  const mk = (code) => fake({ "run --rm": { code } });
  const ok = mk(0);
  assert.equal(await new DesktopHost({ run: ok.run, pin: PIN, dataDir: tmp() }).netCheck(), true);
  assert.deepEqual(kinds(ok.calls), ["netCheck"], "no create, no setup");
  const bad = mk(1);
  assert.equal(await new DesktopHost({ run: bad.run, pin: PIN, dataDir: tmp() }).netCheck(), false);
  assert.equal(await new DesktopHost({ run: mk(125).run, pin: PIN, dataDir: tmp() }).netCheck(), false);
  assert.equal(await new DesktopHost({ run: async () => { throw new Error("boom"); }, pin: PIN, dataDir: tmp() }).netCheck(), false);
  const noNet = fake({ "network inspect": { code: 1 } });
  assert.equal(await new DesktopHost({ run: noNet.run, pin: PIN, dataDir: tmp() }).netCheck(), false, "no network, no isolation");
  assert.deepEqual(kinds(noNet.calls), [], "and it does not create one");
});

test("netRepair: tears the rules down before setting them up again, so a stale reject never sits above the accept", async () => {
  const f = fake();
  await new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: {} }).netRepair();
  assert.deepEqual(kinds(f.calls), ["netTeardown", "netSetup", "netCheck"]);
  assert.ok(!f.calls.some((a) => kindOf(a) === "netRm"), "the network (and its subnet) stays: desktops are attached to it");
});

test("netRepair: a failing teardown stops the repair before any setup", async () => {
  const f = fake({ "run --rm": (argv) => (kindOf(argv) === "netTeardown" ? { code: 1, stderr: "iptables: boom" } : undefined) });
  await assert.rejects(new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: {} }).netRepair(), /network isolation/);
  assert.deepEqual(kinds(f.calls), ["netTeardown"]);
});

test("netTeardown: rules out, then the network removed; a missing network is fine", async () => {
  const f = fake();
  await new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: {} }).netTeardown();
  assert.deepEqual(kinds(f.calls), ["netTeardown", "netRm"]);
  assert.deepEqual(f.calls.find((a) => kindOf(a) === "netRm"), ["network", "rm", "hermes-deck-desktops"]);

  const gone = fake({ "network inspect": { code: 1, stderr: "No such network" }, "network rm": { code: 1, stderr: "Error: No such network: hermes-deck-desktops" } });
  await new DesktopHost({ run: gone.run, pin: PIN, dataDir: tmp(), opts: {} }).netTeardown();
  assert.ok(!gone.calls.some((a) => kindOf(a) === "netTeardown"), "nothing to tear down without a subnet");

  const busy = fake({ "network rm": { code: 1, stderr: "network has active endpoints" } });
  await assert.rejects(new DesktopHost({ run: busy.run, pin: PIN, dataDir: tmp(), opts: {} }).netTeardown(), /active endpoints/);
});

test("the container token never leaves tokenOf(): not in ensure, list, stats or error text", async () => {
  const f = fake({
    "container inspect": { code: 1, stderr: "No such container" },
    "port hermes-deck-space-aurora": { code: 0, stdout: "127.0.0.1:40030\n" },
    "ps -a": { code: 0, stdout: "hermes-deck-space-aurora\tUp 1 minute\t127.0.0.1:40030->3211/tcp\n" },
    "ps --filter": { code: 0, stdout: "hermes-deck-space-aurora\n" },
    "stats --no-stream": { code: 0, stdout: "hermes-deck-space-aurora\t200MiB / 1.5GiB\t1.00%\n" },
  });
  const h = new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: {} });
  const ensured = await h.ensure("aurora");
  const tok = h.tokenOf("aurora");
  assert.match(tok, /^[a-f0-9]{48}$/);
  for (const out of [ensured, await h.list(), await h.stats()]) assert.ok(!JSON.stringify(out).includes(tok));
  assert.equal(h.tokenOf("../x"), null);
});

test("every argv element reaches the runner as its own element (no shell joining)", async () => {
  const f = fake({ "container inspect": { code: 1, stderr: "No such container" }, "port hermes-deck-space-aurora": { code: 0, stdout: "127.0.0.1:40031\n" } });
  await new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: {} }).ensure("aurora");
  const helper = f.calls.find(isHelper);
  assert.equal(typeof helper[helper.length - 3], "string");
  assert.ok(helper[helper.length - 3].includes(" "), "the script is one element");
  assert.equal(helper[helper.length - 1], SUBNET, "the subnet is the last element");
});

test("token files: Aurora and aurora never share one (case-insensitive filesystems), reset of one keeps the other", async () => {
  const dir = tmp();
  const f = fake({
    "container inspect": { code: 1, stderr: "No such container" },
    "port hermes-deck-space-Aurora": { code: 0, stdout: "127.0.0.1:40040\n" },
    "port hermes-deck-space-aurora": { code: 0, stdout: "127.0.0.1:40041\n" },
  });
  const h = new DesktopHost({ run: f.run, pin: PIN, dataDir: dir, opts: {} });
  await h.ensure("Aurora");
  await h.ensure("aurora");
  assert.notEqual(h.tokenOf("Aurora"), h.tokenOf("aurora"));
  assert.notEqual(tokenFileName("Aurora").toLowerCase(), tokenFileName("aurora").toLowerCase(), "distinct even when case is folded");
  assert.ok(fs.existsSync(path.join(dir, tokenFileName("Aurora"))) && fs.existsSync(path.join(dir, tokenFileName("aurora"))));
  const keep = h.tokenOf("Aurora");
  await h.reset("aurora");
  assert.equal(h.tokenOf("aurora"), null);
  assert.equal(h.tokenOf("Aurora"), keep);
});

test("token files: a Windows device name (con, nul, aux, com1) gets an ordinary file", async () => {
  const dir = tmp();
  for (const p of ["con", "nul", "aux", "com1", "lpt1", "prn"]) {
    const f = fake({ "container inspect": { code: 1, stderr: "No such container" }, [`port hermes-deck-space-${p}`]: { code: 0, stdout: "127.0.0.1:40050\n" } });
    const h = new DesktopHost({ run: f.run, pin: PIN, dataDir: dir, opts: {} });
    await h.ensure(p);
    const file = path.join(dir, tokenFileName(p));
    assert.ok(fs.statSync(file).isFile(), p);
    assert.equal(fs.readFileSync(file, "utf8").trim(), h.tokenOf(p));
    assert.match(h.tokenOf(p), /^[a-f0-9]{48}$/);
  }
  assert.deepEqual(fs.readdirSync(dir).filter((n) => !/^[0-9a-f]+\.(token|snapshots\.json)$/.test(n)), []);
});

test("isolation is not optional: opts.network cannot change the network args", async () => {
  for (const network of [["--network=host"], ["--network", "host"], ["--net", "bridge"], null, []]) {
    const f = fake({ "container inspect": { code: 1, stderr: "No such container" }, "port hermes-deck-space-aurora": { code: 0, stdout: "127.0.0.1:40060\n" } });
    await new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: { network } }).ensure("aurora");
    const a = createArgv(f.calls);
    assert.equal(a[a.indexOf("--network") + 1], "hermes-deck-desktops");
    assert.equal(a.filter((x) => /^--net(work)?(=|$)/.test(x)).length, 1, "exactly one network arg");
    assert.ok(!a.some((x) => x === "host" || x === "--network=host" || x === "bridge"));
  }
});

test("a desktop found on host or bridge is recreated, not started (also when running)", async () => {
  for (const mode of ["host", "bridge", "default", "none"]) {
    for (const Running of [false, true]) {
      const f = fake({
        "container inspect": { code: 0, stdout: JSON.stringify([{ State: { Running }, Config: { Image: `${PIN.repository}@${PIN.digest}` }, HostConfig: { NetworkMode: mode } }]) },
        "port hermes-deck-space-aurora": { code: 0, stdout: "127.0.0.1:40061\n" },
      });
      await new DesktopHost({ run: f.run, pin: PIN, dataDir: tmp(), opts: { network: ["--network=host"] } }).ensure("aurora");
      assert.deepEqual(kinds(f.calls), ["netCheck", "rm", "create"], `${mode} running=${Running}`);
      assert.ok(!f.calls.some((a) => a[0] === "start"));
    }
  }
});

test("pull fetches the helper image too (tagged lines), and the image counts as present only with both", async () => {
  const f = fake({ "pull alpine@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc": undefined });
  const lines = [];
  const run = async (argv, o = {}) => {
    f.calls.push(argv);
    if (argv[0] === "pull" && o.onLine) o.onLine(`${argv[1].startsWith("alpine") ? "h1" : "a1"}: Pull complete`);
    return { code: 0, stdout: "", stderr: "" };
  };
  const h = new DesktopHost({ run, pin: PIN, dataDir: tmp(), opts: {} });
  await h.pull((l, which) => lines.push([l, which]));
  assert.deepEqual(f.calls.filter((a) => a[0] === "pull").map((a) => a[1]).sort(), [HELPER_IMAGE, `${PIN.repository}@${PIN.digest}`].sort());
  assert.deepEqual(lines.sort(), [["a1: Pull complete", "image"], ["h1: Pull complete", "helper"]]);

  const helperGone = fake({ "image inspect": (argv) => (argv[2] === HELPER_IMAGE ? { code: 1, stderr: "No such image" } : undefined) });
  assert.equal(await new DesktopHost({ run: helperGone.run, pin: PIN, dataDir: tmp(), opts: {} }).imagePresent(), false);
  const both = fake();
  assert.equal(await new DesktopHost({ run: both.run, pin: PIN, dataDir: tmp(), opts: {} }).imagePresent(), true);
  assert.deepEqual(both.calls.map((a) => a[2]).sort(), [HELPER_IMAGE, `${PIN.repository}@${PIN.digest}`].sort());

  const failing = fake({ "pull alpine@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc": { code: 1, stderr: "denied" } });
  await assert.rejects(new DesktopHost({ run: failing.run, pin: PIN, dataDir: tmp(), opts: {} }).pull(), /docker pull failed: denied/);
});

// ---- Task 11b: the isolation check runs first; setup only when the rules are missing ----------------------------

test("11b netEnsure: check first; rules present = one helper run; rules missing = setup then check; still missing = refuse", async () => {
  const present = fake();
  await new DesktopHost({ run: present.run, pin: PIN, dataDir: tmp(), opts: {} }).netEnsure();
  assert.deepEqual(kinds(present.calls), ["netCheck"], "rules in place: no setup, one helper run");

  const missing = fake({ "run --rm": rulesMissing() });
  await new DesktopHost({ run: missing.run, pin: PIN, dataDir: tmp(), opts: {} }).netEnsure();
  assert.deepEqual(kinds(missing.calls), ["netCheck", "netSetup", "netCheck"]);

  const never = fake({ "run --rm": (argv) => (kindOf(argv) === "netCheck" ? { code: 1, stderr: "iptables: Bad rule" } : undefined) });
  await assert.rejects(new DesktopHost({ run: never.run, pin: PIN, dataDir: tmp(), opts: {} }).netEnsure(), /network isolation could not be set up: rules not in place after setup/);
  assert.deepEqual(kinds(never.calls), ["netCheck", "netSetup", "netCheck"]);

  const startMissing = fake({ "container inspect": { code: 1, stderr: "No such container" }, "port hermes-deck-space-aurora": { code: 0, stdout: "127.0.0.1:40070\n" }, "run --rm": rulesMissing() });
  await new DesktopHost({ run: startMissing.run, pin: PIN, dataDir: tmp(), opts: {} }).ensure("aurora");
  assert.deepEqual(kinds(startMissing.calls), ["netCheck", "netSetup", "netCheck", "create"]);
  const startNever = fake({ "container inspect": { code: 1, stderr: "No such container" }, "run --rm": (argv) => (kindOf(argv) === "netCheck" ? { code: 1 } : undefined) });
  await assert.rejects(new DesktopHost({ run: startNever.run, pin: PIN, dataDir: tmp(), opts: {} }).ensure("aurora"), /network isolation could not be set up/);
  assert.ok(!startNever.calls.some((a) => kindOf(a) === "create"), "nothing created without the rules");
});

// ---- final fix wave: I1 every docker call has a timeout (one runner for the Deck, the relay and the doctor) ------

const { EventEmitter } = require("node:events");
const { dockerRunner } = require("../main/desktop-host");

/**
 * A fake `docker` spawn. answer(argv) -> {code, stdout} closes the process at once; null leaves it hanging: it ignores
 * kill() and never closes (a wedged Docker Desktop or colima, or a helper whose `sh` is PID 1 and ignores SIGTERM).
 */
function fakeSpawn(log, answer = () => null) {
  log.spawned = log.spawned || [];
  return (bin, argv) => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    log.spawned.push(argv);
    p.kill = (sig) => log.push([argv[0], sig]);
    const a = answer(argv);
    if (a) setImmediate(() => { if (a.stdout) p.stdout.emit("data", a.stdout); p.emit("close", a.code); });
    return p;
  };
}

test("I1 dockerRunner: a call that never closes answers 124 at once with SIGKILL, inside its own bound (short, long, helper)", async () => {
  const log = [];
  const run = dockerRunner({ spawnFn: fakeSpawn(log), shortMs: 20, longMs: 80, helperMs: 160 });
  const timed = async (argv) => { const t0 = Date.now(); const r = await run(argv); return [r, Date.now() - t0]; };
  const [v, tv] = await timed(["version", "--format", "x"]);
  assert.equal(v.code, 124);
  assert.match(v.stderr, /timed out/);
  assert.ok(tv < 75, `version is a short call (${tv} ms)`);
  const [s, ts] = await timed(["stop", "-t", "10", "hermes-deck-space-aurora"]);
  assert.equal(s.code, 124);
  assert.ok(ts >= 75 && ts < 155, `stop is a long call (${ts} ms)`);
  const [h, th] = await timed(["run", "--rm", "--pull", "never", "--privileged", "--net=host", "alpine@x", "sh", "-c", "true"]);
  assert.equal(h.code, 124);
  assert.ok(th >= 155, `the helper gets the helper bound (${th} ms)`);
  assert.deepEqual(log.filter(([a]) => a !== "rm").map(([, sig]) => sig), ["SIGKILL", "SIGKILL", "SIGKILL"]);
});

test("I1 dockerRunner: the isolation helper is named hermes-deck-nethelper-<pid>-<n> and removed with rm -f when it times out", async () => {
  const log = [];
  const run = dockerRunner({ spawnFn: fakeSpawn(log, (a) => (a[0] === "rm" ? { code: 0 } : null)), shortMs: 20, longMs: 20, helperMs: 20 });
  const r = await run(["run", "--rm", "--privileged", "alpine@x", "sh", "-c", "true"]);
  assert.equal(r.code, 124);
  const first = log.spawned[0];
  assert.equal(first[0], "run");
  assert.equal(first[1], "--name");
  assert.match(first[2], new RegExp(`^hermes-deck-nethelper-${process.pid}-\\d+$`));
  await new Promise((res) => setTimeout(res, 30));
  assert.deepEqual(log.spawned.find((a) => a[0] === "rm"), ["rm", "-f", first[2]]);
  await run(["run", "--rm", "alpine@x"]);
  assert.notEqual(log.spawned.filter((a) => a[0] === "run")[1][2], first[2], "every helper run has its own name");
  // a desktop's own `docker run -d --name hermes-deck-space-...` is not renamed
  await run(["run", "--pull", "never", "-d", "--name", "hermes-deck-space-aurora", "img"]);
  assert.deepEqual(log.spawned.filter((a) => a[0] === "run")[2].slice(0, 6), ["run", "--pull", "never", "-d", "--name", "hermes-deck-space-aurora"]);
});

test("I1 dockerRunner: pull is never killed by default; with pullIdleMs a pull that keeps printing finishes, a silent one is stopped", async () => {
  const chatty = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => {};
    let n = 0;
    const iv = setInterval(() => {
      p.stdout.emit("data", `a${n}: Downloading\n`);
      if (++n === 12) { clearInterval(iv); p.emit("close", 0); }
    }, 10);
    return p;
  };
  const lines = [];
  const r = await dockerRunner({ spawnFn: chatty, shortMs: 20, longMs: 20, helperMs: 20, pullIdleMs: 60 })(["pull", "img"], { onLine: (l) => lines.push(l) });
  assert.equal(r.code, 0, "about 120 ms in all, but never 60 ms without a line");
  assert.equal(lines.length, 12);
  const log = [];
  const t0 = Date.now();
  const silent = await dockerRunner({ spawnFn: fakeSpawn(log), shortMs: 20, longMs: 20, helperMs: 20, pullIdleMs: 60 })(["pull", "img"]);
  assert.equal(silent.code, 124);
  assert.ok(Date.now() - t0 >= 55);
  const { RUN_MS, runClass } = require("../main/desktop-host");
  assert.equal(RUN_MS.pullIdle, 0, "the default runner never kills a pull");
  assert.deepEqual([["pull", "x"], ["version"], ["stop", "-t", "10", "x"], ["run", "-d", "x"], ["run", "--rm", "x"], ["network", "inspect", "n"], ["network", "create", "n"], ["system", "df"]].map(runClass), ["pull", "short", "long", "long", "helper", "short", "long", "long"]);
});

test("I1 dockerRunner: a normal call returns its code and output; a missing binary rejects with ENOENT", async () => {
  const log = [];
  const r = await dockerRunner({ spawnFn: fakeSpawn(log, () => ({ code: 0, stdout: "27.1\n" })) })(["version"]);
  assert.deepEqual({ code: r.code, out: r.stdout }, { code: 0, out: "27.1\n" });
  const missing = () => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {}; setImmediate(() => p.emit("error", Object.assign(new Error("nope"), { code: "ENOENT" }))); return p; };
  await assert.rejects(dockerRunner({ spawnFn: missing })(["version"]), (e) => e.code === "ENOENT");
});

test("I1 DesktopHost on a wedged Docker: docker(), ensure() and list() each come back within the bound", { timeout: 3000 }, async () => {
  const log = [];
  const run = dockerRunner({ spawnFn: fakeSpawn(log), shortMs: 20, longMs: 20, helperMs: 20 });
  const h = new DesktopHost({ run, pin: PIN, dataDir: tmp(), opts: {} });
  assert.equal(await h.docker(), "stopped");
  await assert.rejects(h.ensure("aurora"), /snapshot failed/); // the snapshot inspection now fails before network setup
  assert.deepEqual(await h.list(), []);
});

// ---- final fix wave: M8 stop() checks the exit code ---------------------------------------------------------------

test("M8 stop: a failed docker stop throws (callers keep the slot); a container that does not exist counts as stopped", async () => {
  const failing = fake({ "stop -t": { code: 1, stderr: "Error response from daemon: cannot stop container: permission denied" } });
  await assert.rejects(new DesktopHost({ run: failing.run, pin: PIN, dataDir: tmp(), opts: {} }).stop("aurora"), /docker stop failed: .*permission denied/);
  const timedOut = fake({ "stop -t": { code: 124, stderr: "timed out" } });
  await assert.rejects(new DesktopHost({ run: timedOut.run, pin: PIN, dataDir: tmp(), opts: {} }).stop("aurora"), /docker stop failed/);
  const gone = fake({ "stop -t": { code: 1, stderr: "Error response from daemon: No such container: hermes-deck-space-aurora" } });
  await new DesktopHost({ run: gone.run, pin: PIN, dataDir: tmp(), opts: {} }).stop("aurora");
  const ok = fake();
  await new DesktopHost({ run: ok.run, pin: PIN, dataDir: tmp(), opts: {} }).stop("aurora");
  assert.deepEqual(ok.calls[0], ["stop", "-t", "10", "hermes-deck-space-aurora"]);
});

test("isolation failure before startup leaves a clean home clean on the next ensure", async (t) => {
  for (const exists of [true, false]) {
    let failIsolation = true;
    const f = fake({
      "container inspect": exists ? { stdout: JSON.stringify([{ State: { Running: false }, Config: { Image: `${PIN.repository}@${PIN.digest}` } }]) } : { code: 1, stderr: "No such container" },
      "run --rm": (argv) => isHelper(argv) && failIsolation ? { code: 1 } : undefined,
      "port hermes-deck-space-aurora": { stdout: "127.0.0.1:40001" },
    });
    const dir = tmp();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const h = new DesktopHost({ run: f.run, pin: PIN, dataDir: dir });
    await h.stop("aurora");
    await assert.rejects(h.ensure("aurora"), /network isolation/);
    assert.equal(h._snapMeta("aurora").dirty, false);
    failIsolation = false;
    f.calls.length = 0;
    await h.ensure("aurora");
    assert.equal(f.calls.some((a) => a.includes(SNAP_SCRIPTS.pack)), false);
    assert.equal(h._snapMeta("aurora").dirty, true);
  }
});

test("token write failure before desktop creation leaves a clean home clean", async (t) => {
  const f = fake();
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = new DesktopHost({ run: f.run, pin: PIN, dataDir: dir });
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (file, data, options) => {
    if (file.endsWith(".token")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return write(file, data, options);
  });
  await assert.rejects(h.ensure("aurora"), /disk full/);
  assert.equal(h._snapMeta("aurora").dirty, false);
  assert.equal(f.calls.some((a) => kindOf(a) === "create"), false);
});

test("uncertain create or start outcomes retain the dirty marker for the next recovery", async (t) => {
  for (const exists of [true, false]) {
    for (const throws of [true, false]) {
      let fail = true, h;
      const startup = () => {
        assert.equal(h._snapMeta("aurora").dirty, true, "marker persisted before Docker can write home");
        if (!fail) return undefined;
        return throws ? new Error("CLI disconnected") : { code: 124, stderr: "timed out" };
      };
      const f = fake({
        "container inspect": exists ? { stdout: JSON.stringify([{ State: { Running: false }, Config: { Image: `${PIN.repository}@${PIN.digest}` } }]) } : { code: 1, stderr: "No such container" },
        "run --pull": startup,
        "start hermes-deck-space-aurora": startup,
        "port hermes-deck-space-aurora": { stdout: "127.0.0.1:40001" },
      });
      const dir = tmp();
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      h = new DesktopHost({ run: f.run, pin: PIN, dataDir: dir });
      await assert.rejects(h.ensure("aurora"), /CLI disconnected|timed out/);
      assert.equal(h._snapMeta("aurora").dirty, true);
      fail = false;
      await new DesktopHost({ run: f.run, pin: PIN, dataDir: dir }).ensure("aurora");
      assert.equal((await h.snapshots("aurora")).points[0].reason, "start");
    }
  }
});
