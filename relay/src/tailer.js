"use strict";
const fs = require("fs");

const CHUNK = 1 << 20;
const EMPTY = Buffer.alloc(0);

/**
 * Tails one append-only NDJSON file by polling.
 *
 * - Partial lines wait in `pending` until their newline arrives.
 * - Rename rotation (<file> -> <file>.1, new <file>) is detected by inode change; the old inode is
 *   drained from <file>.1 before reading the new file from 0. In-place truncation restarts at 0.
 * - `checkpoint()` returns {ino, offset} at a line boundary. Constructed with that checkpoint, the
 *   tailer replays up to `warmBytes` before it with live=false (state rebuild, nothing counted)
 *   and resumes live exactly at the checkpoint, so token totals are never double counted.
 * - The file is opened per read and never held open (safe with Windows renames in tests).
 */
class Tailer {
  /**
   * @param {string} file
   * @param {(line: string, live: boolean) => void} onLine
   * @param {{checkpoint?: {ino: number, offset: number}|null, warmBytes?: number}} [opts]
   */
  constructor(file, onLine, opts = {}) {
    this.file = file;
    this.onLine = onLine;
    this.cp = opts.checkpoint || null;
    this.warmBytes = opts.warmBytes || 0;
    this.ino = null;
    this.offset = 0; // bytes consumed from the current inode, including `pending`
    this.pending = EMPTY;
    this.skipPartial = false;
    this.lastGrowth = Date.now();
  }

  checkpoint() {
    if (this.ino === null) return this.cp;
    return { ino: this.ino, offset: this.offset - this.pending.length };
  }

  /** Read whatever is new. Returns the number of lines delivered. */
  poll() {
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      return 0; // not created yet (or briefly missing mid-rotation)
    }
    let n = 0;
    if (this.ino === null) {
      n += this._first(st);
    } else if (st.ino !== this.ino) {
      n += this._drainRotated();
      this._reset(st.ino, 0);
    } else if (st.size < this.offset) {
      this._reset(st.ino, 0);
    }
    const got = this._readTo(this.file, st.size, true);
    if (got > 0) this.lastGrowth = Date.now();
    return n + got;
  }

  _reset(ino, offset) {
    this.ino = ino;
    this.offset = offset;
    this.pending = EMPTY;
    this.skipPartial = false;
  }

  _first(st) {
    const cp = this.cp;
    if (cp && cp.ino === st.ino && cp.offset <= st.size) {
      const from = Math.max(0, cp.offset - this.warmBytes);
      this._reset(st.ino, from);
      this.skipPartial = from > 0;
      const n = this._readTo(this.file, cp.offset, false);
      this.pending = EMPTY; // the checkpoint is a line boundary
      this.offset = cp.offset;
      return n;
    }
    let n = 0;
    if (cp) n += this._finishOld(cp); // rotated while we were down
    this._reset(st.ino, 0);
    return n;
  }

  _finishOld(cp) {
    const old = `${this.file}.1`;
    try {
      const ost = fs.statSync(old);
      if (ost.ino !== cp.ino || cp.offset > ost.size) return 0;
      this._reset(cp.ino, cp.offset);
      return this._readTo(old, ost.size, true);
    } catch {
      return 0;
    }
  }

  _drainRotated() {
    const old = `${this.file}.1`;
    try {
      const ost = fs.statSync(old);
      if (ost.ino !== this.ino) return 0;
      return this._readTo(old, ost.size, true);
    } catch {
      return 0;
    }
  }

  _readTo(file, end, live) {
    if (end <= this.offset) return 0;
    let fd;
    try {
      fd = fs.openSync(file, "r");
    } catch {
      return 0;
    }
    let n = 0;
    try {
      while (this.offset < end) {
        const len = Math.min(CHUNK, end - this.offset);
        const chunk = Buffer.allocUnsafe(len);
        const got = fs.readSync(fd, chunk, 0, len, this.offset);
        if (got <= 0) break;
        this.offset += got;
        const data = this.pending.length ? Buffer.concat([this.pending, chunk.subarray(0, got)]) : chunk.subarray(0, got);
        let start = 0;
        let nl;
        while ((nl = data.indexOf(0x0a, start)) !== -1) {
          if (this.skipPartial) {
            this.skipPartial = false; // warm-up began mid-line
          } else {
            const line = data.toString("utf8", start, nl).trim();
            if (line) {
              n++;
              try {
                this.onLine(line, live);
              } catch {
                /* one bad line never stops the tail */
              }
            }
          }
          start = nl + 1;
        }
        this.pending = start < data.length ? Buffer.from(data.subarray(start)) : EMPTY;
      }
    } finally {
      fs.closeSync(fd);
    }
    return n;
  }
}

module.exports = { Tailer };
