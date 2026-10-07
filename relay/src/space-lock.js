"use strict";
// Shared agent space: who may act on the agent host's desktop right now (spec 2026-10-06-agent-spaces, section 5).
// One holder (a Hermes profile, or "user" in full control), a FIFO queue of profiles waiting. Pure: the caller
// passes time in, nothing here does I/O. A holder keeps the lock while it keeps asking (each computer_use call
// asks), and loses it holdMs after its last request; a queued profile that stops asking for QUEUE_STALE_MS has
// given up and leaves the queue.
const QUEUE_STALE_MS = 15_000;

class SpaceLock {
  constructor({ holdMs = 90_000, waitMs = 120_000, now = () => Date.now() } = {}) {
    Object.assign(this, { holdMs, waitMs, now });
    this.holder = null; // {profile, last}
    this.user = false;
    this.previous = null; // the agent that held the lock when the user took it
    this.queue = []; // [{profile, since, last}]
  }

  _free(t) {
    if (this.holder && t - this.holder.last >= this.holdMs) this.holder = null;
  }

  _prune(t) {
    this.queue = this.queue.filter((q) => t - q.last < QUEUE_STALE_MS);
  }

  request(profile, t = this.now()) {
    this._free(t);
    if (this.user) return { ok: false, busy: true, holder: "user", position: 0, waitedMs: 0 };
    if (this.holder && this.holder.profile === profile) {
      this.holder.last = t;
      return { ok: true };
    }
    let i = this.queue.findIndex((q) => q.profile === profile);
    if (!this.holder && (this.queue.length === 0 || i === 0)) {
      if (i === 0) this.queue.shift();
      this.holder = { profile, last: t };
      return { ok: true };
    }
    if (i < 0) {
      this.queue.push({ profile, since: t, last: t });
      i = this.queue.length - 1;
    }
    const q = this.queue[i];
    q.last = t;
    const waited = t - q.since;
    const holder = this.holder ? this.holder.profile : this.queue[0].profile;
    if (waited >= this.waitMs) {
      this.queue.splice(i, 1);
      return { ok: false, busy: false, timeout: true, holder };
    }
    return { ok: false, busy: true, holder, position: i + 1, waitedMs: waited };
  }

  release(profile) {
    if (this.holder && this.holder.profile === profile) {
      this.holder = null;
      return true;
    }
    if (this.previous === profile) this.previous = null;
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.profile !== profile);
    return this.queue.length !== before;
  }

  takeUser() {
    const previous = this.holder ? this.holder.profile : null;
    this.previous = previous;
    this.holder = null;
    this.user = true;
    return { ok: true, previous };
  }

  releaseUser(t = this.now()) {
    this.user = false;
    let next = this.previous;
    this.previous = null;
    if (next) this.holder = { profile: next, last: t };
    else if (this.queue.length) next = this.queue[0].profile;
    return { ok: true, next };
  }

  sweep(t = this.now()) {
    this._free(t);
    this._prune(t);
  }

  state() {
    return { holder: this.user ? "user" : this.holder ? this.holder.profile : null, user: this.user, queue: this.queue.map((q) => q.profile) };
  }
}

module.exports = { SpaceLock, QUEUE_STALE_MS };
