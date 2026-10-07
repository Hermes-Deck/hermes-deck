"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { Driver } = require("../src/driver");
const { McpHttpBridge } = require("../src/space-mcp");
const { SpaceApprovals } = require("../src/space-approvals");
const { lines } = require("../src/mcpfence");

const rpc = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
function rig({ auditRecord, failed = false, fetch } = {}) {
  const rows = [], replies = [], sent = [], exits = [], errors = [];
  const d = Object.create(Driver.prototype);
  d.spaceAudit = { settings: () => ({ approvals: true }), record: auditRecord || ((r) => rows.push(r)) };
  d.spaceApprovals = new SpaceApprovals({ snapshot: async () => ({ ok: true }) });
  d.riskyPatterns = [];
  d.desktops = { busy: () => false, touch: () => {} };
  d._toWrapper = (_c, kind, b) => {
    if (kind === "data") replies.push(...String(b).trim().split("\n").filter(Boolean).map(JSON.parse));
    if (kind === "err") errors.push(String(b));
  };
  const c = { profile: "agent1", spaceHost: "agent-host", kind: "space", done: false, lines: lines(),
    s: { writable: true, write: (b) => exits.push(JSON.parse(b)), end: () => {} },
    bridge: new McpHttpBridge({ fetch: async (req) => {
      const msg = JSON.parse(req.body); sent.push(msg);
      if (fetch) return fetch(msg);
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id,
        result: { isError: failed, content: [{ type: "image", mimeType: "image/png", data: "YQ==" }] } })) };
    } }) };
  d.conns = new Set([c]);
  d._initSpaceSafety(c);
  const call = (id, name, args) => d._spaceLine(c, Buffer.from(JSON.stringify(rpc(id, name, args))));
  const chunk = (...messages) => d._spaceMsg(c, { t: "data", b64: Buffer.from(messages.map(JSON.stringify).join("\n") + "\n").toString("base64") });
  return { d, c, call, chunk, rows, replies, sent, exits, errors };
}

test("F7: a denied retry has denied outcome and is consumed once", async () => {
  const r = rig();
  r.call(1, "type_text", { text: "sudo whoami" }); await r.c.flow;
  await r.d.spaceApprovals.answer(r.d.spaceApprovals.list()[0].id, { choice: "deny" });
  r.call(2, "type_text", { text: "sudo whoami" }); await r.c.flow;
  assert.equal(r.rows.at(-1).outcome, "denied");
  assert.match(r.replies.at(-1).result.content[0].text, /user denied/);
  r.call(3, "type_text", { text: "sudo whoami" }); await r.c.flow;
  assert.equal(r.rows.at(-1).outcome, "approval");
  assert.equal(r.sent.length, 0);
});

test("F10: driver foreground escalation hint cannot be confused with the Deck gate", async () => {
  const hint = "Retry with delivery_mode='foreground' (separate approval).";
  const r = rig({ fetch: async (msg) => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({
    jsonrpc: "2.0", id: msg.id, result: { isError: true, structuredContent: { escalation_hint: hint },
      content: [{ type: "text", text: JSON.stringify({ escalation_hint: hint }) }] },
  })) }) });
  r.call(1, "hotkey", { keys: ["CTRL", "L"] }); await r.c.flow;
  const result = r.replies[0].result;
  assert.doesNotMatch(JSON.stringify(result), /approval/i);
  assert.match(result.structuredContent.escalation_hint, /user must allow foreground input in Hermes Deck/);
  assert.equal(JSON.parse(result.content[0].text).escalation_hint, result.structuredContent.escalation_hint);
  assert.equal(result.isError, true);
  assert.equal(r.d.spaceApprovals.list().length, 0);
});
test("F10: rewording preserves string RPC IDs and unrelated structured fields", async () => {
  const hint = "delivery_mode='foreground' (separate approval)";
  const r = rig({ fetch: async (msg) => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({
    jsonrpc: "2.0", id: msg.id, result: { isError: true,
      structuredContent: { escalation_hint: hint, label: hint }, content: [{ type: "text", text: hint }] },
  })) }) });
  r.call(hint, "hotkey", { keys: ["CTRL", "L"] }); await r.c.flow;
  assert.equal(r.replies[0].id, hint);
  assert.equal(r.replies[0].result.structuredContent.label, hint);
  assert.match(r.replies[0].result.structuredContent.escalation_hint, /user must allow/);
  assert.equal(r.c.done, false);
  const { McpFence } = require("../src/mcpfence");
  const replies = [];
  const fence = new McpFence({ ctx: () => ({}), toDevice() {}, toHermes: (b) => replies.push(JSON.parse(b)) });
  fence.fromDevice(Buffer.from(JSON.stringify({ id: hint, result: { content: [{ type: "text", text: hint }] } }) + "\n"));
  assert.equal(replies[0].id, hint);
  assert.match(replies[0].result.content[0].text, /user must allow/);
});

test("pretty-printed HTTP successes commit typing before split-command approval", async () => {
  const r = rig({ fetch: async (msg) => ({ status: 200, headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [] } }, null, 2)) }) });
  r.chunk(rpc(1, "type_text", { text: "su" }), rpc(2, "type_text", { text: "do whoami" }));
  await r.c.flow;
  assert.deepEqual(r.sent.map((msg) => msg.id), [1]);
  assert.equal(r.c.typing, "su");
  assert.deepEqual(r.rows.map((row) => row.outcome), ["ok", "approval"]);
  assert.equal(r.replies[1].result.isError, true);
  const card = r.d.spaceApprovals.list()[0];
  assert.equal(card.command, "sudo whoami");
  await r.d.spaceApprovals.answer(card.id, { choice: "once" });
  r.call(3, "type_text", { text: "do whoami" }); await r.c.flow;
  assert.deepEqual(r.sent.map((msg) => msg.id), [1, 3]);
  assert.deepEqual(r.rows.map((row) => row.outcome), ["ok", "approval", "ok"]);
});

test("uncorrelated completions end the session before queued calls can use stale typing", async () => {
  const r = rig();
  // Fault at the bridge output boundary: numeric request ID becomes a string.
  r.c.bridge.removeAllListeners("data");
  r.c.bridge.on("data", (b) => {
    const msg = JSON.parse(b); msg.id = String(msg.id);
    r.d._spaceReply(r.c, Buffer.from(JSON.stringify(msg) + "\n"));
  });
  r.chunk(rpc(1, "type_text", { text: "su" }), rpc(2, "type_text", { text: "do whoami" }));
  await r.c.flow;
  assert.equal(r.c.done, true);
  assert.equal(r.c.bridge.closed, true);
  assert.deepEqual(r.sent.map((msg) => msg.id), [1]);
  assert.equal(r.c.typing, "");
  assert.deepEqual(r.rows.map((row) => row.outcome), ["error", "error"]);
  assert.deepEqual(r.exits, [{ t: "exit", code: 75 }]);
  assert.match(r.errors.join(""), /reply.*match|match.*reply/i);
});

test("split calls in one chunk are gated after fence, approved exact retry passes once, records correlate", async () => {
  const r = rig();
  r.chunk(rpc(1, "type_text", { text: "su" }), rpc(2, "type_text", { text: "do whoami" }), rpc(3, "kill_app", { pid: 1 }));
  await r.c.flow;
  assert.equal(r.sent.length, 1);
  assert.deepEqual(r.rows.map((x) => x.outcome), ["ok", "approval", "fenced"]);
  assert.equal(r.rows[0].result.content[0].data, "YQ==");
  assert.equal(r.c.typing, "su");
  const card = r.d.spaceApprovals.list()[0];
  assert.equal(card.command, "sudo whoami");
  assert.equal(r.rows[1].command, card.command);
  assert.ok(r.rows.every((row) => row.profile === "agent1" && row.host === "agent-host" && row.duration >= 0));
  await r.d.spaceApprovals.answer(card.id, { choice: "once" });
  r.call(4, "type_text", { text: "do whoami" }); await r.c.flow;
  assert.equal(r.sent.length, 2);
  r.call(5, "press_key", { key: "Enter" }); await r.c.flow;
  assert.equal(r.c.typing, "");
  r.call(6, "type_text", { text: "sudo whoami" }); await r.c.flow;
  assert.equal(r.sent.length, 3, "Enter passed, a fresh dangerous command did not");
  assert.equal(r.rows.length, 6, "one row for every tools/call");
  assert.deepEqual(r.replies.map((m) => m.id), [1, 2, 3, 4, 5, 6]);
});

test("bridge proceeds with blocked or throwing audit sink; failed tools do not commit typing", async () => {
  const r = rig({ auditRecord: () => new Promise(() => {}), failed: true });
  r.call("one", "type_text", { text: "plain" }); await r.c.flow;
  assert.equal(r.replies.length, 1);
  assert.equal(r.c.typing, "");
  const broken = rig({ auditRecord: () => { throw new Error("disk"); } });
  broken.call(1, "click", { x: 2, y: 3 }); await broken.c.flow;
  assert.equal(broken.sent.length, 1);
  assert.equal(broken.replies[0].result.isError, false);
  const failed = rig({ failed: true });
  failed.c.typing = "su";
  failed.chunk(rpc(1, "press_key", { key: "Enter" }), rpc(2, "type_text", { text: "do whoami" }));
  await failed.c.flow;
  assert.equal(failed.c.typing, "su");
  assert.deepEqual(failed.rows.map((x) => x.outcome), ["error", "approval"]);
});

for (const [name, sink] of [
  ["unresolved", "() => new Promise(() => {})"],
  ["rejecting", "() => Promise.reject(new Error('audit disk failure'))"],
]) test(`${name} audit Promises neither delay calls nor crash the process`, () => {
  // Strict rejection handling in a child makes a missing catch observable as a process failure.
  const child = spawnSync(process.execPath, ["--unhandled-rejections=strict", "-e", `
    const assert = require("node:assert/strict");
    const { Driver } = require(${JSON.stringify(require.resolve("../src/driver"))});
    const { McpHttpBridge } = require(${JSON.stringify(require.resolve("../src/space-mcp"))});
    const { SpaceApprovals } = require(${JSON.stringify(require.resolve("../src/space-approvals"))});
    const { lines } = require(${JSON.stringify(require.resolve("../src/mcpfence"))});
    const rpc = ${rpc.toString()};
    ${rig.toString()}
    (async () => {
      const r = rig({ auditRecord: ${sink} });
      r.chunk(rpc(1, "type_text", { text: "plain" }), rpc(2, "click", {}));
      await r.c.flow;
      await new Promise(setImmediate);
      assert.deepEqual(r.sent.map((msg) => msg.id), [1, 2]);
      assert.deepEqual(r.replies.map((msg) => msg.result.isError), [false, false]);
      assert.equal(r.c.typing, "plain");
      assert.equal(r.c.done, false);
      console.log("calls completed; process alive");
    })();
  `], { encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /calls completed; process alive/);
});

test("F2: newline stays gated and disconnect preserves pending cards and approved permits", async () => {
  const r = rig();
  r.call(1, "type_text", { text: "sudo whoami\n" }); await r.c.flow;
  assert.equal(r.sent.length, 0);
  assert.equal(r.d.spaceApprovals.list().length, 1);
  r.c.bridge.close();
  assert.equal(r.d.spaceApprovals.list().length, 1);
  const reconnect = rig();
  reconnect.d.spaceApprovals = r.d.spaceApprovals;
  reconnect.call(2, "type_text", { text: "sudo whoami\n" }); await reconnect.c.flow;
  assert.equal(r.d.spaceApprovals.list().length, 1);
  await r.d.spaceApprovals.answer(r.d.spaceApprovals.list()[0].id, { choice: "once" });
  reconnect.call(3, "type_text", { text: "sudo whoami\n" }); await reconnect.c.flow;
  assert.equal(reconnect.sent.length, 1);
  const approved = rig();
  approved.call(1, "type_text", { text: "sudo whoami" }); await approved.c.flow;
  await approved.d.spaceApprovals.answer(approved.d.spaceApprovals.list()[0].id, { choice: "once" });
  approved.d._gone(approved.c);
  assert.equal(approved.d.spaceApprovals.entries.size, 1);
});

test("fence wins over busy and approvals; invalid text and calls without IDs never reach HTTP", async () => {
  const r = rig();
  r.d.desktops.busy = () => true;
  r.chunk(rpc(1, "kill_app", {}), rpc(2, "type_text", { text: "sudo whoami" })); await r.c.flow;
  assert.deepEqual(r.rows.map((x) => x.outcome), ["fenced", "error"]);
  assert.match(r.replies[1].result.content[0].text, /operation is in progress/);
  assert.equal(r.d.spaceApprovals.list().length, 0);
  r.d.desktops.busy = () => false;
  r.chunk(rpc(3, "type_text", { text: 1 }), rpc(4, "type_text", { text: "x".repeat(65_537) }), rpc(undefined, "click", {}), rpc(null, "click", {}));
  await r.c.flow;
  assert.equal(r.sent.length, 0);
  assert.equal(r.rows.length, 6);
  assert.equal(r.replies.length, 4);
  r.call(0, "type_text", { text: "x".repeat(65_536) }); await r.c.flow;
  assert.equal(r.sent.length, 1);
  assert.equal(r.c.typing.length, 500);
});

test("approval settings and extra patterns are consumed without disabling the fence", async () => {
  const r = rig();
  r.d.riskyPatterns = [/danger/];
  r.call(1, "type_text", { text: "danger" }); await r.c.flow;
  assert.equal(r.sent.length, 0);
  r.d.spaceAudit.settings = () => ({ approvals: false });
  r.chunk(rpc(2, "type_text", { text: "sudo whoami" }), rpc(3, "kill_app", {})); await r.c.flow;
  assert.deepEqual(r.rows.map((x) => x.outcome), ["approval", "ok", "fenced"]);
  assert.equal(r.sent.length, 1);
});

test("transport failure audits current and queued calls once without committing typing", async () => {
  const r = rig({ fetch: async () => { throw new Error("offline"); } });
  r.chunk(rpc(1, "type_text", { text: "plain" }), rpc(2, "click", {})); await r.c.flow;
  assert.deepEqual(r.rows.map((x) => x.outcome), ["error", "error"]);
  assert.equal(r.sent.length, 1);
  assert.equal(r.c.typing, "");
  assert.equal(r.c.done, true);
  assert.equal(r.replies[0].error.code, -32000);
});

test("graceful wrapper close drains the safety FIFO before closing the bridge", async () => {
  const r = rig();
  r.chunk(rpc(1, "type_text", { text: "su" }), rpc(2, "type_text", { text: "do whoami" }));
  r.d._spaceMsg(r.c, { t: "close" });
  await r.c.flow;
  await Promise.resolve();
  assert.deepEqual(r.rows.map((x) => x.outcome), ["ok", "approval"]);
  assert.equal(r.replies.length, 2);
  assert.equal(r.c.bridge.closed, true);
  assert.equal(r.d.spaceApprovals.list().length, 1);
  assert.deepEqual(r.exits, [{ t: "exit", code: 0 }]);
});

test("restore ends only that profile's space sessions and audits in-flight and queued work once", async () => {
  let release;
  const r = rig({ fetch: () => new Promise((resolve) => { release = resolve; }) });
  const other = rig(), shared = { profile: "agent1", kind: "host", done: false };
  other.c.profile = "agent2";
  r.d.conns.add(other.c); r.d.conns.add(shared);
  r.chunk(rpc(1, "type_text", { text: "plain" }), rpc(2, "click", {}));
  while (!release) await Promise.resolve();
  r.d.endSpace("agent1");
  assert.equal(r.c.bridge.closed, true);
  assert.equal(other.c.done, false);
  assert.equal(shared.done, false);
  release({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })) });
  await r.c.flow;
  assert.deepEqual(r.rows.map((x) => x.outcome), ["error", "error"]);
  assert.equal(r.c.typing, "");
  assert.deepEqual(r.exits, [{ t: "exit", code: 75 }]);
});

test("non-tool plumbing passes without audit, malformed input is ignored, string IDs correlate", async () => {
  const r = rig();
  for (const input of ["null", "[]", "false", "{bad"]) r.d._spaceLine(r.c, Buffer.from(input));
  r.chunk({ jsonrpc: "2.0", id: 1, method: "initialize" }, { jsonrpc: "2.0", method: "notifications/initialized" }, rpc("1", "type_text", { text: "plain" }));
  await r.c.flow;
  assert.equal(r.sent.length, 3);
  assert.equal(r.rows.length, 1);
  assert.equal(r.c.typing, "plain");
  assert.deepEqual(r.replies.map((m) => m.id), [1, "1"]);
});

test("batches reject every request ID and audit enclosed tool attempts without delivery", async () => {
  const r = rig();
  r.chunk([
    rpc(0, "type_text", { text: "su" }), rpc("two", "type_text", { text: "do whoami" }),
    rpc(undefined, "click", {}), rpc(null, "kill_app", { pid: 1 }),
    { jsonrpc: "2.0", id: "init", method: "initialize" },
    { jsonrpc: "2.0", method: "notifications/initialized" }, null, false, 17,
  ]);
  await r.c.flow;
  assert.deepEqual(r.replies.map((msg) => msg.id), [0, "two", null, "init"]);
  assert.ok(r.replies.every((msg) => msg.error.code === -32000 && /batches are not supported/.test(msg.error.message)));
  assert.deepEqual(r.rows.map((row) => row.tool), ["type_text", "type_text", "click", "kill_app"]);
  assert.deepEqual(r.rows.map((row) => row.outcome), ["refused", "refused", "refused", "refused"]);
  assert.equal(r.sent.length, 0);
  assert.equal(r.c.typing, "");
  assert.equal(r.d.spaceApprovals.list().length, 0);
  r.call(3, "click", {}); await r.c.flow;
  assert.deepEqual(r.sent.map((msg) => msg.id), [3]);
  assert.equal(r.rows[4].outcome, "ok");
});
