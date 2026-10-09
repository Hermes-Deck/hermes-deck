"use strict";
const fs = require("fs");
const crypto = require("crypto");

function load(file, io) {
  let text;
  try { text = io.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  try { const queue = JSON.parse(text); if (Array.isArray(queue)) return queue; }
  catch { /* The writer preserves malformed queues while holding the lock. */ }
  return null;
}

/** Lock-free display read; only a writer may move aside corrupt data. */
function readQueue(file, { fs: io = fs } = {}) {
  return load(file, io) || [];
}

/** Serialize a synchronous read-modify-write against the current queue. */
function withQueue(file, fn, { fs: io = fs, now = Date.now, pid = process.pid } = {}) {
  const lock = `${file}.lock`;
  const token = `${pid}:${crypto.randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + 5000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let fd;
  while (fd === undefined) {
    try { fd = io.openSync(lock, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const observed = io.readFileSync(lock, "utf8");
        const mtime = io.statSync(lock).mtimeMs;
        const owner = Number(observed.split(":")[0]);
        let dead = false;
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); } catch (e) { dead = e.code === "ESRCH"; }
        }
        // An empty lock may be between open and its token write; only its age can expire it.
        // shortcut: token checks and unlink are separate calls; use OS locking if atomic ownership is required.
        if ((dead || now() - mtime > 30_000) && io.readFileSync(lock, "utf8") === observed) { io.unlinkSync(lock); continue; }
      } catch (e) { if (e.code === "ENOENT") continue; throw e; }
      if (Date.now() >= deadline) throw new Error(`restart queue lock timed out: ${lock}`);
      Atomics.wait(sleeper, 0, 0, 50);
    }
  }
  let tmp;
  try {
    io.writeFileSync(fd, token);
    let queue = load(file, io);
    if (queue === null) { io.renameSync(file, `${file}.corrupt-${now()}`); queue = []; }
    const next = fn(queue);
    if (next !== undefined) {
      tmp = `${file}.${pid}.${now()}.tmp`;
      io.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      io.renameSync(tmp, file);
    }
  } finally {
    try { if (tmp) io.rmSync(tmp, { force: true }); }
    finally {
      io.closeSync(fd);
      try { if (io.readFileSync(lock, "utf8") === token) io.unlinkSync(lock); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
}

module.exports = { withQueue, readQueue };
