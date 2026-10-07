"use strict";
// Status pet logic shared by the pet page (window.PetLogic) and the Node tests (module.exports):
//   - which state the fleet summary means, and how an event's temporary state ("hold") combines with it;
//   - the Karakter skin's pose graph: which transition strips lead from one pose to another;
//   - Choreo, the small state machine that turns state changes into "show this loop" / "play this strip"
//     steps and queues changes that arrive while a strip is still playing;
//   - what an event (reply / ask / done) does: one-shot effect, temporary state, speech bubble.
// No DOM here: the skins apply the steps.
(() => {
  // ---------------------------------------------------------------- states
  /** Every state, lowest priority first: a higher one wins when the summary and an event disagree. */
  const STATES = ["offline", "idle", "working", "reply", "waiting"];
  const RANK = Object.freeze(Object.fromEntries(STATES.map((s, i) => [s, i])));
  const ALIAS = { replies: "reply" }; // the old --pet-state name

  /** A known state name (aliases folded), or null. */
  function normState(s) {
    const n = ALIAS[s] || s;
    return typeof n === "string" && Object.prototype.hasOwnProperty.call(RANK, n) ? n : null;
  }

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  /**
   * The fleet summary {running, subs, unread, pending, offline} as one state, by priority
   * offline < idle < working < reply < waiting. Running counts come from the relay, so they only count
   * while it is connected; unread replies and pending answers count either way.
   */
  function stateOf(summary) {
    const s = summary && typeof summary === "object" ? summary : { offline: true };
    if (num(s.pending) > 0) return "waiting";
    if (num(s.unread) > 0) return "reply";
    if (!s.offline && (num(s.running) > 0 || num(s.subs) > 0)) return "working";
    return s.offline ? "offline" : "idle";
  }

  /** The summary's state, raised to an event's hold while it lasts (never lowered by it). */
  function effective(base, hold) {
    const b = normState(base) || "idle";
    const h = normState(hold);
    return h && RANK[h] > RANK[b] ? h : b;
  }

  // ---------------------------------------------------------------- poses (Karakter)
  /** sitting = idle, working; standing = reply, waiting; lying = offline */
  const POSE = Object.freeze({ idle: "sit", working: "sit", reply: "stand", waiting: "stand", offline: "lie" });
  /** Transition strips: played forward they go from -> to, reversed they go back. */
  const STRIPS = Object.freeze({
    stand: { from: "sit", to: "stand" }, // sitting with the laptop -> kneeling -> rising -> standing with the letter
    wake: { from: "lie", to: "sit" }, // asleep -> rubbing an eye -> yawning -> sitting with the laptop
  });
  const EDGES = [];
  for (const [strip, s] of Object.entries(STRIPS)) {
    EDGES.push({ strip, dir: "normal", from: s.from, to: s.to });
    EDGES.push({ strip, dir: "reverse", from: s.to, to: s.from });
  }

  /** The shortest chain of strips from one pose to another (breadth-first over the pose graph), or null. */
  function route(from, to) {
    if (from === to) return [];
    const via = new Map([[from, null]]);
    const queue = [from];
    while (queue.length) {
      const pose = queue.shift();
      for (const e of EDGES) {
        if (e.from !== pose || via.has(e.to)) continue;
        via.set(e.to, e);
        if (e.to === to) {
          const out = [];
          for (let x = e; x; x = via.get(x.from)) out.unshift({ ...x });
          return out;
        }
        queue.push(e.to);
      }
    }
    return null;
  }

  /** Cross-fade lengths (ms): between two loops of one pose, and around a transition strip. */
  const FADE = Object.freeze({ loop: 200, strip: 120 });

  /**
   * Turns state changes into steps for the Karakter skin:
   *   {type: "loop", name, pose, fade}            show that state's loop
   *   {type: "strip", name, dir, pose, to, fade}  play a transition strip once (pose = where it starts)
   * A change that arrives while a strip plays is only remembered; when the strip ends (done()), the next
   * step is planned from the pose it ended in, toward the newest target. So nothing ever jumps: the pet
   * finishes the move it is in and carries on from there.
   */
  class Choreo {
    /** poses: state -> pose for this figure (default POSE; the cats wait sitting, poses.waiting = "sit"). */
    constructor(poses = POSE) {
      this.poses = { ...POSE, ...poses };
      this.pose = null; // where the character is (or, during a strip, where the strip started)
      this.loop = null; // the loop on screen, null during a strip
      this.strip = null; // the strip playing, or null
      this.target = null; // the newest state asked for
    }

    get busy() {
      return !!this.strip;
    }

    /** A new target. Returns the step to show now, or null (already there, or a strip must end first). */
    set(state) {
      const s = normState(state);
      if (!s) return null;
      this.target = s;
      if (this.pose === null) return this.jump(s);
      if (this.strip) return null;
      return this._next();
    }

    /** Show `state` at once, no transition: first appearance, motion switched back on, captures. */
    jump(state) {
      const s = normState(state) || "idle";
      Object.assign(this, { target: s, pose: this.poses[s], loop: s, strip: null });
      return { type: "loop", name: s, pose: this.poses[s], fade: 0 };
    }

    /** The playing strip reached its last frame: plan the next step from the pose it ended in. */
    done() {
      if (!this.strip) return null;
      this.pose = this.strip.to;
      this.strip = null;
      return this._next();
    }

    _next() {
      const t = this.target;
      if (this.poses[t] === this.pose) {
        if (this.loop === t) return null;
        const after = this.loop ? "loop" : "strip"; // loop -> loop, or the end of a strip -> loop
        this.loop = t;
        return { type: "loop", name: t, pose: this.pose, fade: FADE[after] };
      }
      const path = route(this.pose, this.poses[t]);
      if (!path || !path.length) return this.jump(t); // cannot happen with the graph above; never get stuck
      const step = path[0];
      this.strip = step;
      this.loop = null;
      return { type: "strip", name: step.strip, dir: step.dir, pose: step.from, to: step.to, fade: FADE.strip };
    }
  }

  // ---------------------------------------------------------------- events
  /** How long an event's temporary state and its speech bubble last. */
  const HOLD_MS = 6000;
  const EVENT_KINDS = ["reply", "ask", "done"];

  /**
   * What an event does on the pet page. ev: {kind, agent, snippet, key, avatar?, quiet?}; opts.bubbles: the
   * "Bildirimler" setting. Returns {fx, hold, bubble, tone} or null for an unknown event.
   *   reply: a small hop, the reply loop for a while, a bubble with the agent's name and the snippet
   *   ask:   a gentle shake, the waiting loop for a while, a bubble
   *   done:  a short happy hop, nothing else
   * quiet (the deck window is in front, where the message is already on screen) drops the bubble only.
   */
  function routeEvent(ev, opts = {}) {
    if (!ev || typeof ev !== "object" || !EVENT_KINDS.includes(ev.kind)) return null;
    const says = !!(opts && opts.bubbles) && !ev.quiet && !!(clean(ev.snippet) || clean(ev.agent));
    if (ev.kind === "reply") return { fx: "hop", hold: "reply", bubble: says, tone: "amphora" };
    if (ev.kind === "ask") return { fx: "shake", hold: "waiting", bubble: says, tone: "gilt" };
    return { fx: "happy", hold: null, bubble: false, tone: "patina" };
  }

  /** One line of plain text, at most n characters (an ellipsis marks a cut). */
  function clean(s, n = 200) {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
  }

  const api = Object.freeze({ STATES, RANK, POSE, STRIPS, FADE, HOLD_MS, normState, stateOf, effective, route, Choreo, routeEvent, clean });
  if (typeof window !== "undefined") window.PetLogic = api;
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
