#!/usr/bin/env node
"use strict";
// Terminal view of the relay stream: agent table from the snapshot, then one line per live event.
//
//   node tools/watch.js            live feed (Ctrl+C to quit)
//   node tools/watch.js --once     print the snapshot summary and exit
//
// Reads DECK_RELAY_HOST / DECK_RELAY_PORT / DECK_RELAY_TOKEN from ~/.hermes-deck/relay.env
// (a copy of the relay host's relay/.env), or from the environment.
const os = require("os");
const path = require("path");
const WebSocket = require("ws");
const { loadEnvFile } = require("../src/util");

loadEnvFile(process.env.DECK_RELAY_ENV || path.join(os.homedir(), ".hermes-deck", "relay.env"));
const host = process.env.DECK_RELAY_HOST || "127.0.0.1";
const port = process.env.DECK_RELAY_PORT || "9330";
const token = process.env.DECK_RELAY_TOKEN;
if (!token) {
  console.error("DECK_RELAY_TOKEN missing (expected in ~/.hermes-deck/relay.env)");
  process.exit(1);
}
const once = process.argv.includes("--once");

const hhmm = (ts) => new Date(ts * 1000).toLocaleTimeString("en-GB", { hour12: false });
const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n || 0));
const short = (s, n = 70) => (s ? String(s).replace(/\s+/g, " ").slice(0, n) : "");

function printSnapshot(m) {
  console.log("\nAGENT        RUNNING SUBAGENTS TODAY: calls   new-input     cache output      $   NOW");
  for (const a of Object.values(m.agents)) {
    const t = a.today;
    const now = a.curTool ? `${a.curTool.tool} (${Math.round(Date.now() / 1000 - a.curTool.since)}s)` : "";
    console.log(
      `${(a.emoji + " " + a.name).padEnd(13)}${String(a.running).padStart(7)}${String(a.subsRunning).padStart(10)}` +
        `${String(t.n).padStart(13)}${k(t.in + t.cw).padStart(12)}${k(t.cr).padStart(10)}${k(t.out).padStart(7)}` +
        `${t.usd.toFixed(2).padStart(7)}   ${now}`
    );
  }
  const f = m.fleet || {};
  const q = Object.values(f.quotas || {})
    .map((x) => `${x.provider}: ${x.ok ? x.windows.map((w) => `${Math.round(w.used)}%/${w.minutes >= 10080 ? "week" : w.minutes / 60 + "h"}`).join(" ") : x.err}`)
    .join("  |  ");
  const prof = Object.entries(f.profiles || {})
    .map(([p, s]) => {
      if (s.stale) return `${p}:STALE`;
      const bad = Object.entries(s.platforms || {}).filter(([, x]) => x.state !== "connected").map(([n, x]) => `${n} ${x.state}`);
      const cronBad = (s.cron || []).filter((j) => j.enabled && (j.failure_streak || 0) > 0).length;
      return `${p}:${bad.length ? bad.join(",") : "ok"}${cronBad ? ` (cron errors: ${cronBad})` : ""}`;
    })
    .join("  ");
  console.log(`\nQuota  ${q || "-"}\nGateway  ${prof || "(no snapshot)"}   launchd jobs: ${(f.launchd || []).length}`);
  console.log(`Sessions: ${m.sessions.length} (last 24 hours)\n`);
}

function line(e) {
  const who = `${e.agent}${e.sid && e.sid.includes("/") ? "·sub" : ""}`.padEnd(14);
  const t = hhmm(e.ts);
  switch (e.ev) {
    case "turn_start": return `${t} ${who} ▶ ${short(e.msg)}`;
    case "turn_end": return `${t} ${who} ■ turn ended`;
    case "tool_start": return `${t} ${who} 🔧 ${e.tool} ${short(e.args, 50)}`;
    case "tool_end": return `${t} ${who} ${e.status === "ok" ? "✓" : "✗"} ${e.tool || ""} ${e.ms != null ? e.ms + "ms" : ""} ${short(e.result, 40)}`;
    case "llm": {
      const u = e.usage || {};
      return `${t} ${who} 🧠 ${e.model || ""} new=${k((u.in || 0) + (u.cw || 0))} cache=${k(u.cr)} out=${k(u.out)}${e.cont ? " (cont.)" : ""}`;
    }
    case "sub_start": return `${t} ${who} 🤖 subagent started: ${short(e.goal, 60)}`;
    case "sub_stop": return `${t} ${who} 🤖 subagent ${e.status}${e.ms ? " " + Math.round(e.ms / 1000) + "s" : ""} ${short(e.summary, 40)}`;
    case "cost": return null;
    default: return `${t} ${who} · ${e.ev}`;
  }
}

const ws = new WebSocket(`ws://${host}:${port}/events`, { headers: { authorization: `Bearer ${token}` } });
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.t === "snapshot") {
    printSnapshot(m);
    if (once) ws.close();
  } else if (m.t === "evs") {
    for (const e of m.evs) {
      const l = line(e);
      if (l) console.log(l);
    }
  }
});
ws.on("unexpected-response", (_req, res) => {
  console.error(`relay refused the connection: HTTP ${res.statusCode}`);
  process.exit(1);
});
ws.on("error", (e) => {
  console.error("relay connection error:", e.message);
  process.exit(1);
});
ws.on("close", () => process.exit(0));
