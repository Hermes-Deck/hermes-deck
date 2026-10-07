"use strict";
// [0xD6] space tunnel frames (agent spaces phase 2): the relay reaches the agent desktops a Deck computer hosts
// over that Deck's own relay connection — no inbound port on the Deck's machine. Same layout as [0xCD] (CDP) and
// [0xD5] (driver): magic, op, uint32 channel, payload.
const MAGIC = 0xd6;
const OP = Object.freeze({ CTRL: 1, CTRL_RES: 2, HTTP: 3, HTTP_RES: 4, OPEN: 5, OPENED: 6, DATA: 7, CLOSE: 8 });
const HEADER = 6;
function encode(op, ch, payload) {
  const body = payload === undefined || payload === null ? Buffer.alloc(0) : Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload), "utf8");
  const head = Buffer.allocUnsafe(HEADER);
  head[0] = MAGIC;
  head[1] = op;
  head.writeUInt32BE(ch >>> 0, 2);
  return Buffer.concat([head, body]);
}
function decode(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < HEADER || buf[0] !== MAGIC || buf[1] < OP.CTRL || buf[1] > OP.CLOSE) return null;
  return { op: buf[1], ch: buf.readUInt32BE(2), payload: buf.subarray(HEADER) };
}
function json(payload) {
  try {
    const v = JSON.parse(payload.toString("utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}
module.exports = { MAGIC, OP, HEADER, encode, decode, json };
