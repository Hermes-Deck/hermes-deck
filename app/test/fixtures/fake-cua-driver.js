#!/usr/bin/env node
"use strict";
// A stand-in for cua-driver in tests. It speaks just enough of the CLI (--version, --help, manifest, doctor,
// status, stop, call, serve) and of MCP over stdio to exercise the Deck's device mode. It never touches the
// desktop. Every run appends its argv and the bounded-mode environment to $FAKE_CUA_LOG when that is set.
const fs = require("fs");
const net = require("net");

const argv = process.argv.slice(2);
if (process.env.FAKE_CUA_LOG) {
  fs.appendFileSync(
    process.env.FAKE_CUA_LOG,
    JSON.stringify({
      argv,
      pid: process.pid,
      mode: process.env.CUA_DRIVER_PERMISSION_MODE || null,
      manifest: process.env.CUA_DRIVER_CAPABILITY_MANIFEST_FILE || null,
      approved: process.env.CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED || null,
      http: process.env.CUA_DRIVER_RS_MCP_HTTP_PORT || null,
    }) + "\n"
  );
}

const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const positional = () => {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (["--socket", "--permission-mode", "--capability-manifest"].includes(argv[i])) i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
};
const WINDOWS = [
  { window_id: 1001, pid: 4242, app_name: "Excel", title: "Book1 - Excel", is_on_screen: true },
  { window_id: 77, pid: 4242, app_name: "Excel", title: "Book2 - Excel", is_on_screen: true },
  { window_id: 1002, pid: 4343, app_name: "Notepad", title: "notes.txt - Notepad", is_on_screen: true },
];
const TOOLS = ["start_session", "end_session", "list_windows", "list_apps", "get_window_state", "click", "type_text", "press_key", "scroll", "kill_app"];

// Bounded mode the way cua-driver 0.33.3 answers it (measured on the real driver): under a manifest with
// desktop.display: false, a list_windows without a pid, and any list_apps (it has no pid filter), is desktop
// display observation and refused; a tool the manifest's allow.tools does not list is refused whatever display
// says. The CLI prints the refusal on stdout and exits 1; MCP answers isError with it. A manifest with neither a
// tool list nor a display line (the tests' bare "version: 3") allows everything. The display refusal's text is
// the real driver's; the text for an unlisted tool is this fake's own.
const refusalOf = (message) => ({ refusal: { code: "bounded_resource_outside_manifest", message }, status: "refused" });
const REFUSAL = refusalOf("protected resource is outside the capability manifest: desktop display observation is outside the capability manifest");
function manifestText() {
  try {
    return process.env.CUA_DRIVER_CAPABILITY_MANIFEST_FILE ? fs.readFileSync(process.env.CUA_DRIVER_CAPABILITY_MANIFEST_FILE, "utf8") : "";
  } catch {
    return "";
  }
}
/** The refusal for one tool call under the daemon's manifest, or null when it runs. */
function refused(tool, args) {
  const text = manifestText();
  const block = /^allow:\n {2}tools:\n((?: {4}- [a-z0-9_]+\n)*)/m.exec(text);
  if (block && !block[1].split("\n").some((l) => l.trim() === `- ${tool}`)) return refusalOf(`tool ${tool} is outside the capability manifest`);
  const pid = args && Number.isInteger(args.pid) && args.pid > 0;
  return /^ {4}display: false$/m.test(text) && (tool === "list_apps" || (tool === "list_windows" && !pid)) ? REFUSAL : null;
}
/** The answer of an allowed listing: windows of one process when a pid is given, else all of them. */
function listing(tool, args) {
  const wins = args && Number.isInteger(args.pid) ? WINDOWS.filter((w) => w.pid === args.pid) : WINDOWS;
  if (tool === "list_windows") return { windows: wins };
  return { apps: [...new Set(wins.map((w) => w.pid))].map((pid) => ({ name: wins.find((w) => w.pid === pid).app_name, pid, running: true })) };
}

/** Resolves true when a daemon answers on the socket. */
function reach(sock) {
  return new Promise((resolve) => {
    if (!sock) return resolve(false);
    const c = net.connect(sock);
    const t = setTimeout(() => {
      c.destroy();
      resolve(false);
    }, 1500);
    c.on("connect", () => {
      clearTimeout(t);
      c.end();
      resolve(true);
    });
    c.on("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

async function main() {
  const verb = argv[0];
  switch (verb) {
    case "--version":
      console.log("cua-driver 0.21.0-fake");
      return 0;
    case "--help":
      console.log("usage: cua-driver <command> [options]");
      return 0;
    case "manifest":
      console.log(JSON.stringify({ name: "cua-driver", version: "0.21.0-fake", mcp_invocation: { command: "/usr/local/bin/cua-driver", args: ["mcp"] }, tools: TOOLS.map((name) => ({ name })) }));
      return 0;
    case "doctor":
      console.log(JSON.stringify({ ok: true, checks: [] }));
      return 0;
    case "telemetry":
      return 0;
    case "status": {
      const up = await reach(flag("--socket"));
      console.log(up ? "running" : "not running");
      return up ? 0 : 1;
    }
    case "stop": {
      const sock = flag("--socket");
      if (!(await reach(sock))) return 1;
      await new Promise((resolve) => {
        const c = net.connect(sock, () => c.end("stop\n"));
        c.on("close", resolve);
        c.on("error", resolve);
      });
      return 0;
    }
    case "call": {
      const sock = flag("--socket");
      if (sock && !(await reach(sock))) {
        console.error("daemon not running");
        return 1;
      }
      const [tool, json] = positional();
      let args = {};
      try {
        args = JSON.parse(json || "{}");
      } catch {
        args = {};
      }
      const no = refused(tool, args);
      if (no) {
        console.log(JSON.stringify(no, null, 2));
        return 1;
      }
      if (tool === "list_windows" || tool === "list_apps") console.log(JSON.stringify(listing(tool, args)));
      else console.log(JSON.stringify({ ok: true, tool }));
      return 0;
    }
    case "serve":
      return serve();
    case "mcp":
      return mcp();
    default:
      console.error(`unknown command: ${verb}`);
      return 64;
  }
}

function serve() {
  if (process.env.FAKE_CUA_SERVE_FAIL) {
    console.error("fake failure on start");
    return 1;
  }
  const sock = flag("--socket");
  const manifest = flag("--capability-manifest");
  if (flag("--permission-mode") !== "bounded" || !argv.includes("--approve-capability-manifest") || !manifest || !fs.existsSync(manifest)) {
    console.error("bounded mode needs an approved capability manifest");
    return 64;
  }
  if (!/^version: 3$/m.test(fs.readFileSync(manifest, "utf8"))) {
    console.error("bad manifest");
    return 64;
  }
  return new Promise(() => {
    const server = net.createServer((c) => {
      c.on("data", (d) => {
        if (String(d).includes("stop")) process.exit(0);
      });
      c.on("error", () => {});
    });
    server.listen(sock);
    server.on("error", (e) => {
      console.error(e.message);
      process.exit(1);
    });
  });
}

/** One MCP tools/call: listings as the bounded driver answers them, anything else "ok <tool>". */
function toolCall({ name, arguments: args }) {
  const no = refused(name, args);
  if (no) return { content: [{ type: "text", text: no.refusal.message }], isError: true, structuredContent: no };
  if (name === "list_windows" || name === "list_apps") {
    const out = listing(name, args);
    return { content: [{ type: "text", text: `${(out.windows || out.apps).length} ${name === "list_windows" ? "windows" : "apps"}` }], structuredContent: out };
  }
  return { content: [{ type: "text", text: `ok ${name}` }] };
}

async function mcp() {
  const sock = flag("--socket");
  if (sock && !(await reach(sock))) {
    console.error("daemon not running");
    return 1;
  }
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        if (req.id === undefined) continue; // a notification
        let result;
        if (req.method === "initialize") result = { protocolVersion: "2025-06-18", serverInfo: { name: "fake-cua-driver", version: "0.21.0-fake" }, capabilities: { tools: {} } };
        else if (req.method === "tools/list") result = { tools: TOOLS.map((name) => ({ name, inputSchema: { type: "object" } })) };
        else if (req.method === "tools/call") result = toolCall(req.params || {});
        else result = {};
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");
      }
    });
    process.stdin.on("end", () => resolve(0));
  });
}

main().then(
  (code) => {
    if (typeof code === "number") process.exitCode = code;
  },
  (e) => {
    console.error(e.message);
    process.exitCode = 1;
  }
);
