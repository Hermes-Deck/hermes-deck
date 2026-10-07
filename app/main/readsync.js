"use strict";
// C5: read receipts from the Deck to Telegram, batched and debounced.
// The renderer reports the newest message the user has actually seen in a chat (selected, window in
// front, scrolled into view); this queue keeps the highest id per chat and sends them together once
// the user pauses. It never sends while gate() says the window is hidden or unfocused: those marks are
// held and go out when wake() is called on the next focus. Reads made on another device are fed in
// through seen(), so the Deck never re-marks what Telegram already knows is read.

const DELAY = 1500; // quiet time after the last mark before a batch goes out
const MAX_WAIT = 5000; // a batch waits at most this long, even while the user keeps scrolling
const RETRIES = 2; // a failed mark is tried again this many times (on the next batch), then dropped
const TIMERS = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };

class ReadQueue {
  /**
   * send(key, maxId): resolves once Telegram took the mark; gate(): true while marks may go out.
   * timers/now are injectable for tests.
   */
  constructor({ send, gate = () => false, delay = DELAY, maxWait = MAX_WAIT, timers = TIMERS, now = Date.now }) {
    this.send = send;
    this.gate = gate;
    this.delay = delay;
    this.maxWait = maxWait;
    this.timers = timers;
    this.now = now;
    this.pending = new Map(); // key -> {maxId, tries}
    this.sent = new Map(); // key -> highest id Telegram knows as read (sent from here or read elsewhere)
    this.timer = null;
    this.firstAt = 0;
    this.busy = null; // the running flush, so batches never overlap
  }

  /** Queue "read up to maxId" for a chat; false when nothing new (already read or already queued). */
  mark(key, maxId) {
    const id = Number(maxId);
    if (!key || !Number.isSafeInteger(id) || id <= 0) return false;
    const p = this.pending.get(key);
    if (id <= (this.sent.get(key) || 0) || (p && id <= p.maxId)) return false;
    this.pending.set(key, { maxId: id, tries: 0 });
    this._schedule();
    return true;
  }

  /** Telegram says the chat is read up to maxId (here or on another device). */
  seen(key, maxId) {
    const id = Number(maxId) || 0;
    if (id > (this.sent.get(key) || 0)) this.sent.set(key, id);
    const p = this.pending.get(key);
    if (p && p.maxId <= id) this.pending.delete(key);
  }

  /** The window came to the front again: send what was held. */
  wake() {
    if (this.pending.size && !this.timer) this._schedule();
  }

  /** Drop everything queued (receipts switched off, signed out). */
  clear() {
    this.pending.clear();
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  _schedule() {
    const now = this.now();
    if (!this.timer) this.firstAt = now;
    else this.timers.clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.delay, this.firstAt + this.maxWait - now));
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  /** Send every queued mark now (if the gate allows); resolves when the batch is done. */
  async flush() {
    if (this.busy) await this.busy;
    if (!this.pending.size || !this.gate()) return; // held until wake()
    const batch = [...this.pending.entries()];
    this.pending.clear();
    this.busy = (async () => {
      for (const [key, p] of batch) {
        try {
          await this.send(key, p.maxId);
          this.seen(key, p.maxId);
        } catch {
          // back in the queue for the next batch, unless a newer mark took its place
          if (p.tries < RETRIES && !this.pending.has(key)) this.pending.set(key, { maxId: p.maxId, tries: p.tries + 1 });
        }
      }
    })();
    try {
      await this.busy;
    } finally {
      this.busy = null;
    }
    if (this.pending.size) this._schedule();
  }
}

module.exports = { ReadQueue, DELAY, MAX_WAIT };
