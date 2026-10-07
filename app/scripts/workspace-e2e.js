#!/usr/bin/env node
"use strict";
// End-to-end check of the Workspace tab plumbing, all on this machine, all headless:
//   relay        temp data dir, random test token, CDP endpoint on a random 127.0.0.1 port
//   deck         RelayClient + heartbeat + CdpTunnel + AgentBrowserHost (headless Chrome/Edge, temp profile)
//   "Hermes"     a plain CDP client: /agent/e2e/json/version discovery, then drives a page through the tunnel
// It also checks the live view (screencast frame), the user's input while holding control, that the agent
// cannot click then, and that switching hosting off stops the device from serving.
// The live view starts before the agent connects, like an open Workspace tab, and must follow the agent:
// a background page in a new browser context that the agent navigates and closes within seconds stays on
// screen as "Son görülen" (never about:blank), with the steps in the trail; Hermes's supervisor-style
// attach to about:blank is bookkeeping, not use; a tab the user picks pauses following until the agent
// navigates; a robot-check page (/sorry/) is flagged for the user.
//   node scripts/workspace-e2e.js          (needs the relay's dependencies too: cd ../relay && npm install)
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");
const { start } = require("../../relay/src/index");
const { RelayClient } = require("../main/relay");
const { CdpTunnel } = require("../main/cdp-tunnel");
const { AgentBrowserHost, LiveView } = require("../main/agent-browser");

const SLUG = "e2e";
const DEVICE = crypto.randomBytes(8).toString("hex");
const PAGE = `<!doctype html><title>Hermes Deck E2E</title>
<body style="font:20px sans-serif;margin:40px">
<button id="b" style="width:220px;height:70px" onclick="this.textContent='clicked'">click me</button>
<input id="i" style="display:block;margin-top:30px;width:300px;height:40px">
</body>`;
// a stand-in robot check (generic text): the Deck must flag it for the user, never solve it
const WALL = `<!doctype html><title>Verification</title><body style="font:16px sans-serif;margin:40px">
<p>Our systems have detected unusual traffic from your computer network.</p></body>`;

const step = (s) => console.log(`ok  ${s}`);
const once = (em, ev) => new Promise((resolve) => em.once(ev, (...a) => resolve(a)));
async function until(fn, ms = 15_000, what = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
}

/** A tiny CDP client for the "Hermes" side. */
async function cdpClient(url) {
  const ws = new WebSocket(url);
  await once(ws, "open");
  let id = 0;
  const waiting = new Map();
  ws.on("message", (d) => {
    const m = JSON.parse(d);
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    }
  });
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      id += 1;
      waiting.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { ws, call };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-deck-e2e-"));
  const cleanup = [];
  try {
    // the page the agent will use
    const site = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(req.url.startsWith("/sorry/") ? WALL : PAGE);
    });
    await new Promise((r) => site.listen(0, "127.0.0.1", r));
    cleanup.push(() => site.close());
    const pageUrl = `http://127.0.0.1:${site.address().port}/`;

    // relay
    const token = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(path.join(tmp, "agents.json"), JSON.stringify({ profiles: { [SLUG]: { name: "E2E", bot: null } } }));
    const relay = await start({
      host: "127.0.0.1", port: 0, token, eventsDir: path.join(tmp, "events"), stateDir: path.join(tmp, "state"), dataDir: path.join(tmp, "data"),
      claudeDirs: [], claudeProfile: "claude-code", claudeChatMap: null, launchdPrefixes: [], codexbar: null, agentsFile: path.join(tmp, "agents.json"),
      broadcastWindowS: 300, tickMs: 500, cdp: { port: 0, defaultAgent: "default", fallback: false, browserPath: null },
    });
    cleanup.push(() => relay.stop());
    step(`relay on 127.0.0.1:${relay.port}, CDP endpoint on 127.0.0.1:${relay.cdpPort}`);

    // deck: agent browsers allowed in this test profile only (temp dir)
    const host = new AgentBrowserHost({ root: path.join(tmp, "agent-browsers"), enabled: true });
    assert(host.exe, "a Chrome or Edge to run headless");
    cleanup.push(() => host.stopAll());
    const client = new RelayClient({ url: `ws://127.0.0.1:${relay.port}`, token });
    const tunnel = new CdpTunnel({ host, send: (buf) => client.send(buf) });
    let hosting = true;
    const beat = () => client.send({ t: "heartbeat", device: { id: DEVICE, name: "e2e-deck" }, os: process.platform, idleSec: 0, locked: false, hosting: { browser: hosting, desktop: false }, driverOk: { browser: true } });
    client.on("frame", (buf) => tunnel.onFrame(buf));
    client.on("status", (s) => (s.status === "open" ? beat() : tunnel.closeAll("relay gone")));
    client.start();
    cleanup.push(() => client.stop());
    await until(() => relay.presence.activeDevice("browser"), 10_000, "the deck to be the active device");
    step(`deck heartbeat accepted; active device for "browser": ${relay.presence.activeDevice("browser").name} (${host.exe.kind})`);

    // Hermes: discovery through the relay, exactly as browser.cdp_url = http://127.0.0.1:<port>/agent/e2e
    const base = `http://127.0.0.1:${relay.cdpPort}/agent/${SLUG}`;
    const version = await (await fetch(`${base}/json/version`)).json();
    assert(/Chrome|Edg/.test(version.Browser), `real browser behind the tunnel (${version.Browser})`);
    assert(version.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${relay.cdpPort}/agent/${SLUG}/devtools/browser/`), "discovery rewritten to the relay");
    step(`/json/version through the tunnel: ${version.Browser} -> ${version.webSocketDebuggerUrl}`);

    // the Workspace tab is open before the agent does anything (its own CDP connection, not the tunnel)
    const b = host.peek(SLUG);
    const view = new LiveView(b, { fps: 5, maxWidth: 800, maxHeight: 800 });
    const frames = [];
    view.on("frame", (f) => frames.push(f));
    await view.start();
    cleanup.push(() => view.stop());
    step(`live view started before the agent connected (first tab shown: ${view.tabs().find((x) => x.shown).url})`);

    const hermes = await cdpClient(version.webSocketDebuggerUrl);
    cleanup.push(() => hermes.ws.terminate());
    // like Hermes's CDP supervisor: attach to the blank first tab and enable domains = connected, not using
    const { result: listed } = await hermes.call("Target.getTargets");
    const blankTab = listed.targetInfos.find((x) => x.type === "page" && x.url === "about:blank");
    const { result: sup } = await hermes.call("Target.attachToTarget", { targetId: blankTab.targetId, flatten: true });
    await hermes.call("Page.enable", {}, sup.sessionId);
    await hermes.call("Runtime.enable", {}, sup.sessionId);
    await hermes.call("Runtime.evaluate", { expression: "1", returnByValue: true }, sup.sessionId); // reading a blank tab
    await new Promise((r) => setTimeout(r, 300));
    assert(b.agentChannels === 1, "the agent's socket counts as connected");
    assert(view.targetId === blankTab.targetId && view.follow, "a read of about:blank does not move the view");
    const usedBefore = b.lastAgentAt;

    // a short-lived page: background tab in a new browser context, navigated, closed (browser-harness style)
    const { result: bctx } = await hermes.call("Target.createBrowserContext", {});
    const { result: bt } = await hermes.call("Target.createTarget", { url: "about:blank", background: true, browserContextId: bctx.browserContextId });
    const { result: batt } = await hermes.call("Target.attachToTarget", { targetId: bt.targetId, flatten: true });
    const shortUrl = `${pageUrl}?short=1`;
    await hermes.call("Page.navigate", { url: shortUrl }, batt.sessionId);
    await until(() => view.targetId === bt.targetId && frames.some((f) => f.targetId === bt.targetId), 10_000, "the view to follow the agent's new page and paint it");
    assert(b.lastAct && b.lastAct.targetId === bt.targetId, "the tunnel mapped the agent's session to its page");
    assert(b.lastAgentAt > usedBefore, "navigation counts as use");
    await until(() => view.tabs().some((x) => x.shown && x.title === "Hermes Deck E2E"), 5000, "the followed tab's title");
    await hermes.call("Target.closeTarget", { targetId: bt.targetId });
    await until(() => view.lastSeen, 5000, '"Son görülen" after the page closed');
    assert(view.lastSeen.url === shortUrl && view.lastSeen.title === "Hermes Deck E2E", `last seen page kept (${JSON.stringify(view.lastSeen)})`);
    assert(view.targetId === null, "the view did not fall back to about:blank");
    await until(() => b.info().trail.some((e) => e.kind === "close" && e.url === shortUrl), 5000, "the close in the trail");
    const trail = b.info().trail;
    assert(trail.some((e) => (e.kind === "nav" || e.kind === "open") && e.url === shortUrl), `the visit in the trail (${JSON.stringify(trail)})`);
    step(`followed a background page in a new browser context, kept it as "Son görülen" after close (${frames.filter((f) => f.targetId === bt.targetId).length} frames), trail: ${trail.map((e) => e.kind).join(" > ")}`);

    const { result: t } = await hermes.call("Target.createTarget", { url: pageUrl });
    const { result: att } = await hermes.call("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    const S = att.sessionId;
    const evalIn = async (expr) => (await hermes.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, S)).result.result.value;
    // a new tab starts on about:blank (already "complete"): wait for our page itself
    await until(async () => (await evalIn("location.href + ' ' + document.readyState")) === `${pageUrl} complete`, 10_000, "page load");
    assert((await evalIn("document.title")) === "Hermes Deck E2E", "page title through the tunnel");
    await hermes.call("Page.navigate", { url: `${pageUrl}?step=2` }, S);
    await until(async () => (await evalIn("location.search + document.readyState")) === "?step=2complete", 10_000, "navigation");
    step("agent created a tab, navigated it and read it back through relay + tunnel");

    // the browser runs on the user's computer: the agent gets the browser, not the computer
    const local = process.platform === "win32" ? "file:///C:/Windows/win.ini" : "file:///etc/hosts";
    const noFile = await hermes.call("Page.navigate", { url: local }, S);
    assert(noFile.error && /files, apps and ports/.test(noFile.error.message), "file:// navigation refused");
    const noUpload = await hermes.call("DOM.setFileInputFiles", { files: [local.replace("file:///", "")], nodeId: 1 }, S);
    assert(noUpload.error, "local file upload refused");
    const dl = await hermes.call("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: os.homedir(), eventsEnabled: true });
    assert(!dl.error, "download behaviour accepted (pinned to the agent's own folder)");
    assert((await fetch(`${base}/json/new?${encodeURIComponent(local)}`, { method: "PUT" })).status === 403, "/json/new with a file URL refused");
    step("device guard: file:// pages, local file uploads and /json/new?file:// refused; downloads pinned to the agent profile");

    // the live view moved to the agent's new tab: screencast frames of it
    await until(() => view.targetId === t.targetId && frames.some((f) => f.targetId === t.targetId), 10_000, "the view to follow the new tab");
    const frame = frames.filter((f) => f.targetId === t.targetId).pop();
    assert(frame.data[0] === 0xff && frame.data[1] === 0xd8, "screencast frame is a JPEG");
    assert(view.tabs().some((x) => x.shown && x.title === "Hermes Deck E2E"), "live view shows the agent's tab");
    assert(!view.lastSeen, '"Son görülen" cleared once a page is shown again');
    step(`live view: JPEG ${frame.data.length} B, viewport ${frame.meta.deviceWidth}x${frame.meta.deviceHeight}, tabs: ${view.tabs().length}`);

    // the user takes control: the agent may read but not click; the user's click and typing land
    host.setController(SLUG, "user");
    const refused = await hermes.call("Input.dispatchMouseEvent", { type: "mousePressed", x: 10, y: 10, button: "left", clickCount: 1 }, S);
    assert(refused.error && refused.error.code === -32000 && refused.sessionId === S, "agent click refused while the user holds control");
    assert((await evalIn("1 + 1")) === 2, "agent can still read the page");
    const rect = JSON.parse(await evalIn("JSON.stringify(document.getElementById('b').getBoundingClientRect())"));
    const W = view.meta.deviceWidth;
    const H = view.meta.deviceHeight;
    const at = { x: (rect.x + rect.width / 2) / W, y: (rect.y + rect.height / 2) / H };
    view.input({ type: "mouse", action: "down", ...at, button: "left", buttons: 1, clickCount: 1 });
    view.input({ type: "mouse", action: "up", ...at, button: "left", buttons: 0, clickCount: 1 });
    await until(async () => (await evalIn("document.getElementById('b').textContent")) === "clicked", 5000, "the user's click");
    const box = JSON.parse(await evalIn("JSON.stringify(document.getElementById('i').getBoundingClientRect())"));
    const inField = { x: (box.x + 20) / W, y: (box.y + box.height / 2) / H };
    view.input({ type: "mouse", action: "down", ...inField, button: "left", buttons: 1, clickCount: 1 });
    view.input({ type: "mouse", action: "up", ...inField, button: "left", buttons: 0, clickCount: 1 });
    view.input({ type: "text", text: "merhaba" });
    view.input({ type: "key", action: "down", key: "!", code: "Digit1", keyCode: 49, text: "!", modifiers: 8 });
    view.input({ type: "key", action: "up", key: "!", code: "Digit1", keyCode: 49, modifiers: 8 });
    await until(async () => (await evalIn("document.getElementById('i').value")) === "merhaba!", 5000, "the user's typing");
    step("user control: agent click refused (-32000), reads allowed; user's click and typing reached the page");

    host.setController(SLUG, "agent");
    const ok = await hermes.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }, S);
    assert(!ok.error, "agent input works again after Agent'a ver");
    step("control handed back: agent input accepted again");

    // the user picks another tab: following pauses; agent input elsewhere does not pull the view, a navigation does
    await view.selectTab(blankTab.targetId);
    assert(!view.follow && view.targetId === blankTab.targetId, "a picked tab pauses following");
    await hermes.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 7, y: 7 }, S);
    await new Promise((r) => setTimeout(r, 500));
    assert(view.targetId === blankTab.targetId, "agent input does not move a paused view");
    await hermes.call("Page.navigate", { url: `${pageUrl}?step=3` }, S);
    await until(() => view.targetId === t.targetId && view.follow, 5000, "a navigation to resume following");
    step("user picked a tab: following paused, agent input ignored, the agent's navigation resumed it");

    // a robot check on the agent's page: flagged for the user (banner + notification), never solved
    await hermes.call("Page.navigate", { url: `${pageUrl}sorry/index?continue=x` }, S);
    await until(() => view.status().wall && b.info().wall, 8000, "the robot check to be flagged");
    assert(view.status().wall.url.includes("/sorry/"), "the wall is the shown page");
    await hermes.call("Page.navigate", { url: `${pageUrl}?step=4` }, S);
    await until(() => !view.status().wall && !b.info().wall, 8000, "the flag to clear after leaving the page");
    step("robot-check page flagged by the live view and the trail, cleared after leaving it");

    // the owner switches hosting off: sockets close, the relay stops routing here ("çalışma alanı yok")
    const closed = once(hermes.ws, "close");
    hosting = false;
    tunnel.closeAll("agent browsers were switched off on this device", true);
    await host.setEnabled(false);
    beat();
    await closed;
    await until(() => !relay.presence.activeDevice("browser"), 5000, "the device to stop hosting");
    const r = await fetch(`${base}/json/version`);
    assert(r.status === 503, `no workspace after switching off (got ${r.status})`);
    step("hosting switched off: agent socket closed, relay answers 503 (çalışma alanı yok)");
    console.log("\nall workspace checks passed");
  } finally {
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch {
        /* best effort */
      }
    }
    setTimeout(() => fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 }, () => process.exit(process.exitCode || 0)), 500);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
