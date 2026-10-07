"use strict";
// Driver frames on the Deck's relay connection (docs/bot-screen-protocol.md v2, "Device channel"):
//   [0xD5][op u8][channel u32 BE][payload]
// next to the Workspace tab's CDP tunnel frames (0xCD). Control payloads are UTF-8 JSON; DATA and ERR carry
// raw bytes. Must stay byte-identical to relay/src/driver.js (app/test/cua-channel.test.js checks it against
// the relay's own encoder). Pure Node.

const MAGIC = 0xd5;
// HELLO, GRANT, REVOKE, STOPPED, ERR: Deck -> relay. READY, OPEN, STOP: relay -> Deck. DATA, CLOSE: both ways.
const OP = Object.freeze({ HELLO: 1, READY: 2, OPEN: 3, DATA: 4, ERR: 5, CLOSE: 6, STOP: 7, STOPPED: 8, GRANT: 9, REVOKE: 10 });
const HEADER = 6;

function encodeFrame(op, ch, payload) {
  const body =
    payload === undefined || payload === null
      ? Buffer.alloc(0)
      : Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  const head = Buffer.allocUnsafe(HEADER);
  head[0] = MAGIC;
  head[1] = op;
  head.writeUInt32BE(ch >>> 0, 2);
  return Buffer.concat([head, body], HEADER + body.length);
}

/** {op, ch, payload: Buffer}, or null for anything that is not a driver frame (CDP tunnel frames start with 0xCD). */
function decodeFrame(data) {
  const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
  if (buf.length < HEADER || buf[0] !== MAGIC || buf[1] < OP.HELLO || buf[1] > OP.REVOKE) return null;
  return { op: buf[1], ch: buf.readUInt32BE(2), payload: buf.subarray(HEADER) };
}

/** A control payload as an object, or null. */
function frameJson(payload) {
  try {
    const v = JSON.parse(payload.toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

module.exports = { MAGIC, OP, HEADER, encodeFrame, decodeFrame, frameJson };
