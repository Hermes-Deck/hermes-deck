"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { McpHttpBridge } = require("../src/space-mcp");

function collect(b) { const out = []; b.on("data", (d) => out.push(...String(d).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)))); return out; }

test("pretty-printed HTTP replies are emitted as one compact JSON line", async () => {
  const reply = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "first\nsecond" }] } };
  const b = new McpHttpBridge({ fetch: async () => ({ status: 200, headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(reply, null, 2)) }) });
  const chunks = [];
  b.on("data", (chunk) => chunks.push(String(chunk)));
  b.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n"));
  await b.queue;
  assert.deepEqual(chunks, [JSON.stringify(reply) + "\n"]);
});

test("initialize → session id kept; tools/call answered from an SSE stream; notifications get no reply", async () => {
  const reqs = [];
  const fetch = async (req) => {
    reqs.push(req);
    const m = JSON.parse(req.body);
    if (m.method === "initialize") return { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "S1" }, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18" } })) };
    if (!m.id) return { status: 202, headers: {}, body: Buffer.alloc(0) };
    return { status: 200, headers: { "content-type": "text/event-stream" }, body: Buffer.from(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } })}\n\n`) };
  };
  const b = new McpHttpBridge({ fetch });
  const out = collect(b);
  b.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n"));
  b.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "click", arguments: {} } }) + "\n"));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(out.map((m) => m.id), [1, 2]);
  assert.equal(reqs[1].headers["mcp-session-id"], "S1");
  assert.equal(reqs[2].headers["mcp-session-id"], "S1");
  assert.equal(reqs[0].path, "/mcp");
});

test("requests keep their order even when an earlier one is slow", async () => {
  const fetch = async (req) => {
    const m = JSON.parse(req.body);
    if (m.id === 1) await new Promise((r) => setTimeout(r, 30));
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} })) };
  };
  const b = new McpHttpBridge({ fetch });
  const out = collect(b);
  b.write(Buffer.from([1, 2, 3].map((id) => JSON.stringify({ jsonrpc: "2.0", id, method: "ping" })).join("\n") + "\n"));
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(out.map((m) => m.id), [1, 2, 3]);
});

test("a transport failure answers the pending request with a JSON-RPC error and closes the bridge", async () => {
  const b = new McpHttpBridge({ fetch: async () => { throw new Error("the Deck's connection is gone"); } });
  const out = collect(b);
  let closed = false;
  b.on("close", () => (closed = true));
  b.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {} }) + "\n"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(out[0].id, 7);
  assert.match(out[0].error.message, /desktop is not reachable/);
  assert.equal(closed, true);
});

test("fix 1: JSON that parses to null/scalar is skipped, queue never rejects, later requests work", async () => {
  const fetch = async (req) => {
    const m = JSON.parse(req.body);
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} })) };
  };
  const b = new McpHttpBridge({ fetch });
  const out = collect(b);
  b.write(Buffer.from("null\n"));
  b.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
});

test("fix 2a: HTTP 404 with error body synthesizes reply with message's id and closes", async () => {
  const fetch = async () => {
    return { status: 404, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null })) };
  };
  const b = new McpHttpBridge({ fetch });
  const out = collect(b);
  let closed = false;
  b.on("close", () => (closed = true));
  b.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }) + "\n"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(out[0].id, 1);
  assert.equal(out[0].error.code, -32000);
  assert.equal(out[0].error.message, "Session not found");
  assert.equal(closed, true);
});

test("fix 2b: HTTP 500 with text/plain body synthesizes reply and closes", async () => {
  const fetch = async () => {
    return { status: 500, headers: { "content-type": "text/plain" }, body: Buffer.from("Internal Server Error") };
  };
  const b = new McpHttpBridge({ fetch });
  const out = collect(b);
  let closed = false;
  b.on("close", () => (closed = true));
  b.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "test" }) + "\n"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(out[0].id, 2);
  assert.match(out[0].error.message, /HTTP 500/);
  assert.equal(closed, true);
});

test("fix 3a: 200 empty body with id emits error (no answer)", async () => {
  const fetch = async () => {
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.alloc(0) };
  };
  const b = new McpHttpBridge({ fetch });
  const out = collect(b);
  let closed = false;
  b.on("close", () => (closed = true));
  b.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "test" }) + "\n"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(out[0].id, 3);
  assert.match(out[0].error.message, /no answer/);
  assert.equal(closed, true);
});

test("fix 3b: SSE with only notifications emits error for request (no matching response)", async () => {
  const fetch = async () => {
    return { status: 200, headers: { "content-type": "text/event-stream" }, body: Buffer.from("data: " + JSON.stringify({ jsonrpc: "2.0", method: "notification" }) + "\n\n") };
  };
  const b = new McpHttpBridge({ fetch });
  const out = collect(b);
  let closed = false;
  b.on("close", () => (closed = true));
  b.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "test" }) + "\n"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(out[0].id, 4);
  assert.match(out[0].error.message, /no answer/);
  assert.equal(closed, true);
});

test("fix 4: UTF-8 split across writes is preserved", async () => {
  let capturedBody = null;
  const fetch = async (req) => {
    capturedBody = req.body.toString("utf8");
    const m = JSON.parse(req.body);
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} })) };
  };
  const b = new McpHttpBridge({ fetch });
  const out = collect(b);
  const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { t: "ğü😀" } }) + "\n";
  const buf = Buffer.from(line, "utf8");
  const cut = buf.indexOf(Buffer.from("😀", "utf8")) + 2;
  b.write(buf.subarray(0, cut));
  b.write(buf.subarray(cut));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(capturedBody, line.trim());
  assert.equal(out[0].id, 1);
  assert.equal(out[0].result !== undefined, true);
  assert(!out[0].error);
});

test("fix 5: JSON-RPC batch (array) emits error for each element with id", async () => {
  const b = new McpHttpBridge({ fetch: async () => { throw new Error("unreachable"); } });
  const out = collect(b);
  b.write(Buffer.from(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "a" }, { jsonrpc: "2.0", id: 2, method: "b" }, { jsonrpc: "2.0", method: "notification" }]) + "\n"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 1);
  assert.match(out[0].error.message, /batch/);
  assert.equal(out[1].id, 2);
  assert.match(out[1].error.message, /batch/);
});

test("fix 6: notification with status >= 400 closes the bridge", async () => {
  const fetch = async () => {
    return { status: 404, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Not found" } })) };
  };
  const b = new McpHttpBridge({ fetch });
  let closed = false;
  b.on("close", () => (closed = true));
  b.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notification" }) + "\n"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(closed, true);
});

test("fix 7: timeout emits error and closes after timeoutMs", async () => {
  const fetch = async () => {
    await new Promise(() => {}); // never resolves
  };
  const b = new McpHttpBridge({ fetch, timeoutMs: 30 });
  const out = collect(b);
  let closed = false;
  b.on("close", () => (closed = true));
  b.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "test" }) + "\n"));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(out[0].id, 5);
  assert.match(out[0].error.message, /did not answer in time/);
  assert.equal(closed, true);
});

test("fix 2-round-1: a fetch that throws synchronously answers with an error and never crashes the process", async () => {
  const fetch = () => { throw new Error("sync boom"); };
  let unhandledRejection = null;
  const handler = (reason) => { unhandledRejection = reason; };
  process.on("unhandledRejection", handler);
  const b = new McpHttpBridge({ fetch, timeoutMs: 50 });
  const out = collect(b);
  let closed = false;
  b.on("close", () => (closed = true));
  b.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "test" }) + "\n"));
  await new Promise((r) => setTimeout(r, 100));
  process.removeListener("unhandledRejection", handler);
  assert.equal(out[0].id, 10);
  assert.match(out[0].error.message, /sync boom/);
  assert.equal(closed, true);
  assert.equal(unhandledRejection, null, "no unhandled rejection should occur");
});
