"use strict";
// Agent spaces phase 2: deck-cua speaks MCP over stdio (newline-delimited JSON-RPC); an agent desktop's cua-spacesd
// speaks MCP over Streamable HTTP at /mcp. This turns one into the other, one request at a time and in order (Hermes
// sends one tool call at a time; order keeps replies matched). `fetch` reaches the desktop: straight to 127.0.0.1 on
// the agent host, or through the [0xD6] tunnel for a Deck-hosted desktop (both add the container token themselves).
const { EventEmitter } = require("events");
const { StringDecoder } = require("string_decoder");
const { foregroundReply } = require("./mcpfence");

const ACCEPT = "application/json, text/event-stream";

function parseReply(res) {
  const type = String((res.headers && (res.headers["content-type"] || res.headers["Content-Type"])) || "");
  const text = Buffer.from(res.body || []).toString("utf8");
  if (type.includes("text/event-stream")) {
    return text.split(/\n\n/).flatMap((ev) => ev.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim())).filter(Boolean);
  }
  return text.trim() ? [text.trim()] : [];
}

class McpHttpBridge extends EventEmitter {
  constructor({ fetch, timeoutMs = 20_000 }) {
    super();
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
    this.session = null;
    this.decoder = new StringDecoder("utf8");
    this.buf = "";
    this.queue = Promise.resolve();
    this.closed = false;
  }

  write(chunk) {
    if (this.closed) return;
    this.buf += this.decoder.write(chunk);
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.queue = this.queue.then(() => this._one(line)).catch(() => {});
    }
  }

  async _one(line) {
    if (this.closed) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // fix 1: skip non-object types
    if (!msg || typeof msg !== "object") return;

    // fix 5: batch arrays should emit error for each element with id
    if (Array.isArray(msg)) {
      for (const elem of msg) {
        if (elem && typeof elem === "object" && elem.id !== undefined) {
          if (this.closed) return;
          this.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: elem.id, error: { code: -32000, message: "batches are not supported" } }) + "\n"));
        }
      }
      return;
    }

    const headers = { "content-type": "application/json", accept: ACCEPT };
    if (this.session) headers["mcp-session-id"] = this.session;
    let timer;
    try {
      // fix 7 & fix 2-round-1: race fetch against timeout, handle sync throws
      let res;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Your desktop did not answer in time")), this.timeoutMs);
        timer.unref();
      });
      res = await Promise.race([Promise.resolve().then(() => this.fetch({ method: "POST", path: "/mcp", headers, body: Buffer.from(line) })), timeoutPromise]);

      const sid = res.headers && (res.headers["mcp-session-id"] || res.headers["Mcp-Session-Id"]);
      if (sid) this.session = String(sid);

      // fix 6: notification with 4xx/5xx closes the bridge
      if (msg.id === undefined) {
        if (res.status >= 400) this.close();
        return;
      }

      // fix 2 & 3: handle HTTP errors and missing responses
      const replies = parseReply(res);

      if (res.status >= 400) {
        // synthesize error reply from body or status
        if (this.closed) return;
        let errorMessage = `HTTP ${res.status}`;
        if (replies.length > 0) {
          try {
            const errorReply = JSON.parse(replies[0]);
            if (errorReply && errorReply.error && errorReply.error.message) {
              errorMessage = errorReply.error.message;
            }
          } catch {}
        }
        this.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: errorMessage } }) + "\n"));
        if (res.status === 404 || res.status >= 500) this.close();
        return;
      }

      // fix 3: check if we got a matching response
      let foundMatch = false;
      for (const r of replies) {
        if (this.closed) return;
        try {
          const parsed = JSON.parse(r);
          if (parsed && parsed.id === msg.id && (parsed.result !== undefined || parsed.error !== undefined)) {
            foundMatch = true;
            this.emit("data", Buffer.from(JSON.stringify(r.includes("separate approval") ? foregroundReply(parsed) : parsed) + "\n"));
          }
          // else: ignore notifications and other replies without matching id
        } catch {}
      }

      if (!foundMatch && msg.id !== undefined) {
        if (this.closed) return;
        this.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Your desktop gave no answer" } }) + "\n"));
        this.close();
      }
    } catch (e) {
      if (msg.id !== undefined && !this.closed) {
        const err = { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `Your desktop is not reachable right now (${String(e.message || e).slice(0, 120)}). Retry; the Deck falls back to the shared desktop if it stays away.` } };
        this.emit("data", Buffer.from(JSON.stringify(err) + "\n"));
      }
      this.close();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

module.exports = { McpHttpBridge, parseReply };
