#!/usr/bin/env node
"use strict";
// Agent spaces phase 2: can this machine host agent desktops? Read-only. It never pulls an image, starts, stops or
// removes a container, or changes a firewall rule. The only things it runs are `docker version`, `docker image
// inspect`, `docker network inspect`, `docker ps -a` and DesktopHost.netCheck(). netCheck runs a throwaway helper
// container (pinned alpine, --rm, --pull never) that is `--privileged --net=host` in the Docker VM and, at check
// time, installs iptables with `apk add` (it needs internet inside the Docker VM; the package version is not pinned,
// apk verifies its signatures with the keys in the pinned image). It then only *checks* the rules with `iptables -C`.
// Offline the check fails, and the host fails closed: no desktop starts. Every docker call has a timeout, from the one
// runner the relay and the Deck use too (dockerRunner in app/main/desktop-host.js: 15 s for version, inspect and ps,
// 60 s for the helper): on a timeout it stops waiting at once (the `docker` CLI forwards SIGTERM to the container, and
// the helper's sh is PID 1 and ignores it, so waiting for the process to exit could hang), kills the CLI with SIGKILL
// and removes the helper by name (hermes-deck-nethelper-<pid>-<n>; if one is ever left behind,
// `docker rm -f $(docker ps -aq --filter name=hermes-deck-nethelper-)` stops it).
//
//   node relay/tools/desktops-doctor.js        exit 0: the agent host can host desktops; exit 1: it cannot
//
// Reads the same environment as the relay (relay/.env): DECK_DESKTOPS_HOST, DECK_DESKTOPS_LIMIT, DECK_DATA_DIR.
const os = require("node:os");
const path = require("node:path");

const GB = 1024 ** 3;
const gb1 = (n) => Math.floor(n * 10) / 10; // one decimal, never rounded up (15.96 is not "16")

/**
 * Pure: turn what was found into {ok, lines}. `ok` is true only when this machine can host desktops now.
 * docker: "ready" | "stopped" | "missing"; image: both pinned images are present; limit: the effective limit;
 * isolation: true (rules in place) | false (network exists but the rules are missing) | null/undefined (the network is
 * not created yet or could not be checked: the host applies the rules before the first desktop starts, so this is a note).
 * Optional: limitSet (DECK_DESKTOPS_LIMIT was given), freeMemGB, images (to pull), desktops [{profile, running, port}],
 * hostFlag (DECK_DESKTOPS_HOST), slow (a docker call timed out: later answers cannot be trusted, so the doctor fails and
 * does not claim missing images or rules).
 */
function diagnose({ docker, image, totalMemGB, limit, isolation, limitSet = false, freeMemGB = null, images = [], desktops = null, hostFlag = true, slow = false }) {
  const lines = [];
  let ok = true;
  const bad = (s) => { ok = false; lines.push(`FAIL  ${s}`); };
  const good = (s) => lines.push(`ok    ${s}`);
  const note = (s) => lines.push(`note  ${s}`);

  if (docker === "ready") good("Docker (or colima) is running");
  else if (docker === "unresponsive") bad("Docker did not answer in time: Docker not responding (restart Docker Desktop, or `colima restart`)");
  else if (docker === "missing") bad("Docker is not installed (install Docker Desktop, or on a Mac `brew install colima docker` and `colima start --cpu 2 --memory 4 --disk 30`)");
  else bad("Docker is installed but not running (start Docker Desktop, or `colima start`)");

  if (slow) bad("Docker is slow or not answering (a check timed out); the results below may be incomplete, try again when Docker has settled");

  if (docker === "ready") {
    if (image) good("the pinned desktop and helper images are present");
    else if (!slow) {
      bad("the pinned images are not here; the relay never pulls them");
      for (const img of images) lines.push(`      docker pull ${img}`);
    }
  }

  if (isolation === true) good("network isolation rules are in place");
  else if (isolation === false && !slow) bad("network isolation rules are missing, or the helper could not install iptables (no internet?); desktops would reach the host and the LAN, so none will start until the rules are applied (the host applies them before every start)");
  else if (docker === "ready" && image) note("network isolation is not set up yet; it is created and checked before the first desktop starts");

  const ram = `${gb1(totalMemGB)} GB RAM${freeMemGB === null ? "" : `, ${gb1(freeMemGB)} GB free`}`;
  if (limit > 0) good(`${ram}; up to ${limit} agent desktop${limit === 1 ? "" : "s"} at once (about 1.5 GB each)`);
  else bad(`${ram}; the limit is 0, so this machine hosts no agent desktops`);
  if (totalMemGB < 16 && limit === 0) lines.push(limitSet ? "      this machine has less than 16 GB of RAM and DECK_DESKTOPS_LIMIT is set to 0: raise it to host desktops" : "      this machine has less than 16 GB of RAM: it hosts no agent desktops (DECK_DESKTOPS_LIMIT=0) unless DECK_DESKTOPS_LIMIT is set");
  else if (totalMemGB < 16) note(`this machine has less than 16 GB of RAM; hosting ${limit} desktop${limit === 1 ? "" : "s"} is your choice${limitSet ? " (DECK_DESKTOPS_LIMIT)" : ""}, watch for swapping`);
  if (!hostFlag) note("DECK_DESKTOPS_HOST is not 1: the relay will not host desktops here even though the machine can");

  if (Array.isArray(desktops)) {
    if (!desktops.length) lines.push("      no agent desktops exist yet");
    for (const d of desktops) lines.push(`      desktop ${d.profile}: ${d.running ? `running${d.port ? ` on 127.0.0.1:${d.port}` : ""}` : "stopped"}`);
  }
  return { ok, lines };
}

/** The real checks (read-only, see the header). */
async function gather(env = process.env) {
  const { loadEnvFile } = require("../src/util");
  loadEnvFile(env.DECK_RELAY_ENV || path.join(__dirname, "..", ".env"));
  const { desktopsConfig, config } = require("../src/index");
  const { DesktopHost, NET_NAME, dockerRunner } = require("../../app/main/desktop-host");
  const pin = require("../../app/main/desktops-pin.json");
  const dcfg = desktopsConfig(process.env);
  const cfg = config(process.env);
  const timed = dockerRunner(); // names the helper and removes it with rm -f on a timeout
  let versionTimedOut = false;
  let slow = false;
  const run = async (argv, o) => {
    const r = await timed(argv, o);
    if (r.code === 124) {
      if (argv[0] === "version") versionTimedOut = true;
      else slow = true;
    }
    return r;
  };
  const host = new DesktopHost({ run, pin, dataDir: path.join(cfg.dataDir, "desktops") });
  const out = {
    docker: "stopped", image: false, isolation: null, desktops: null,
    totalMemGB: os.totalmem() / GB, freeMemGB: os.freemem() / GB, limit: dcfg.limit,
    limitSet: !!String(process.env.DECK_DESKTOPS_LIMIT || "").trim(), hostFlag: dcfg.host,
    images: [host.image, host.helperImage].filter(Boolean),
  };
  out.docker = await host.docker();
  if (versionTimedOut) out.docker = "unresponsive";
  if (out.docker !== "ready") return out;
  out.image = await host.imagePresent().catch(() => false);
  if (out.image) {
    // the network may not exist yet (created before the first desktop starts): then there is nothing to check
    const net = await host.run(["network", "inspect", NET_NAME]).catch(() => ({ code: 1 }));
    if (net.code === 0) out.isolation = await host.netCheck();
  }
  out.desktops = await host.list().catch(() => null);
  out.slow = slow;
  return out;
}

async function main() {
  const r = diagnose(await gather());
  console.log(r.lines.join("\n"));
  console.log(r.ok ? "\nThis machine can host agent desktops." : "\nThis machine cannot host agent desktops yet.");
  process.exitCode = r.ok ? 0 : 1;
}

module.exports = { diagnose, gather };
if (require.main === module) main().catch((e) => { console.error(`desktops-doctor: ${e && e.message ? e.message : e}`); process.exitCode = 1; });
