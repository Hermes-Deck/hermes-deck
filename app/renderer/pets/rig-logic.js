"use strict";
// Cut-out skin validation and scheduling, shared with the Node tests. No DOM or image I/O.
(() => {
  const STATES = ["offline", "idle", "working", "reply", "waiting"];
  const LOOPS = ["breathe", "sway", "bob", "tap", "press", "wave", "drift"];
  const MOTIONS = ["tilt", "twitch", "flick", "nod", "hop-small"];
  const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const text = (v) => typeof v === "string" && v.trim().length > 0;
  const positive = (v) => Number.isFinite(v) && v > 0;
  const pair = (v) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);

  function validate(spec) {
    const errors = [];
    const check = (ok, message) => { if (!ok) errors.push(message); };
    if (!object(spec)) return ["spec must be an object"];
    check(positive(spec.canvas), "canvas must be positive");
    if (spec.scales !== undefined) {
      check(Array.isArray(spec.scales) && spec.scales.includes(1) && spec.scales.every((n) => [1, 2, 3].includes(n)), "scales must contain 1 and only 1, 2, 3");
    }
    if (spec.look !== undefined) {
      check(object(spec.look) && text(spec.look.part) && Number.isFinite(spec.look.x) && Number.isFinite(spec.look.y), "look requires part, x and y");
    }
    for (const state of STATES) {
      const scene = spec.scenes && spec.scenes[state];
      if (!object(scene)) { errors.push(`${state}: missing state`); continue; }
      const fail = (ok, message) => check(ok, `${state}: ${message}`);
      fail(text(scene.pose), "missing pose");
      if (!Array.isArray(scene.layers) || !scene.layers.length) { errors.push(`${state}: missing layers`); continue; }
      const layers = new Map();
      for (const layer of scene.layers) {
        if (!object(layer)) { errors.push(`${state}: invalid layer`); continue; }
        fail(text(layer.id) && !layers.has(layer.id), "invalid or duplicate layer id");
        layers.set(layer.id, layer);
        fail(text(layer.img) || (layer.img === undefined && object(layer.faces)), `${layer.id}: missing image`);
        fail(layer.pivot === undefined || pair(layer.pivot), `${layer.id}: invalid pivot`);
        fail(layer.opacity === undefined || (Number.isFinite(layer.opacity) && layer.opacity >= 0 && layer.opacity <= 1), `${layer.id}: invalid opacity`);
        if (layer.faces !== undefined) {
          fail(object(layer.faces) && Object.keys(layer.faces).length > 0 && Object.values(layer.faces).every(text), `${layer.id}: missing face image`);
        }
      }
      for (const layer of layers.values()) {
        fail(layer.parent === undefined || layers.has(layer.parent), `${layer.id}: unknown parent`);
        const seen = new Set([layer.id]);
        for (let parent = layer.parent; layers.has(parent); parent = layers.get(parent).parent) {
          if (seen.has(parent)) { errors.push(`${state}: cyclic parent`); break; }
          seen.add(parent);
        }
      }
      // spec.look.part may be missing from a scene (a sleeping cat has no separate head): look() skips it there
      const faces = [...layers.values()].filter((l) => object(l.faces)).map((l) => l.faces);
      const hasFace = (name) => text(name) && faces.length > 0 && faces.every((f) => Object.hasOwn(f, name));
      if (faces.length || scene.face !== undefined || scene.still !== undefined) {
        fail(hasFace(scene.face || "open"), "missing default face");
        fail(hasFace(scene.still || scene.face || "open"), "missing still face");
      }
      for (const [kind, vocabulary] of [["loops", LOOPS], ["acts", MOTIONS]]) {
        if (scene[kind] === undefined) continue;
        if (!Array.isArray(scene[kind])) { errors.push(`${state}: invalid ${kind}`); continue; }
        for (const item of scene[kind]) {
          if (!object(item)) { errors.push(`${state}: invalid ${kind} entry`); continue; }
          if (kind === "loops" || item.motion !== undefined) {
            fail(vocabulary.includes(item.motion), `unknown motion: ${item.motion}`);
            fail(layers.has(item.part), `unknown part: ${item.part}`);
            fail(positive(item.dur), "duration must be positive");
            fail(item.amp === undefined || Number.isFinite(item.amp), "invalid amplitude");
            fail(item.delay === undefined || Number.isFinite(item.delay), "invalid delay");
          }
          if (kind === "acts" && item.with !== undefined) {
            // more parts moving in the same act (a tail's tip following its base a beat later)
            fail(Array.isArray(item.with) && item.motion !== undefined, "with needs a motion act and a list");
            for (const w of Array.isArray(item.with) ? item.with : []) {
              fail(object(w) && MOTIONS.includes(w.motion) && layers.has(w.part) && positive(w.dur) &&
                (w.amp === undefined || Number.isFinite(w.amp)) && (w.delay === undefined || Number.isFinite(w.delay)),
              `invalid with entry: ${object(w) ? w.part : w}`);
            }
          }
          if (kind === "acts") {
            fail(text(item.name), "missing act name");
            fail(pair(item.every) && item.every[0] > 0 && item.every[1] >= item.every[0], "invalid every interval");
            fail(item.face !== undefined || item.motion !== undefined, "act needs face or motion");
            if (item.face !== undefined) {
              fail(Array.isArray(item.face) && item.face.length > 0 && item.face.every((f) => Array.isArray(f) && f.length === 2 && hasFace(f[0]) && positive(f[1])), "invalid or missing act face");
            }
          }
        }
      }
    }
    if (object(spec.look) && object(spec.scenes)) {
      const somewhere = STATES.some((st) => object(spec.scenes[st]) && Array.isArray(spec.scenes[st].layers) &&
        spec.scenes[st].layers.some((l) => object(l) && l.id === spec.look.part));
      check(somewhere, `unknown look part: ${spec.look.part}`);
    }
    return errors;
  }

  function mulberry32(seed) {
    return () => {
      let n = seed = (seed + 0x6d2b79f5) | 0;
      n = Math.imul(n ^ (n >>> 15), n | 1);
      n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
      return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
    };
  }

  class Acts {
    constructor(acts, rng = Math.random) {
      this.entries = acts.map((act) => ({ act, at: null }));
      this.rng = rng;
      this.freeAt = -Infinity;
    }

    durationOf(act) {
      const moves = [act.motion ? act : null, ...(act.with || [])].filter(Boolean);
      return Math.max(0, ...moves.map((m) => m.dur + (m.delay || 0)), (act.face || []).reduce((ms, step) => ms + step[1], 0));
    }

    interval(act, first = false) {
      const [min, max] = act.every;
      const low = first ? min * 0.3 : min;
      return (low + this.rng() * (max - low)) * 1000;
    }

    // Consumes one reservation. Intervals are start-to-start; collision spacing takes precedence.
    next(nowMs) {
      for (const entry of this.entries) {
        if (entry.at === null) entry.at = nowMs + this.interval(entry.act, true);
      }
      const entry = this.entries.reduce((a, b) => !a || b.at < a.at ? b : a, null);
      if (!entry) return null;
      const at = Math.max(nowMs, entry.at, this.freeAt);
      this.freeAt = at + this.durationOf(entry.act) + 300;
      entry.at = at + this.interval(entry.act);
      return { at, act: entry.act };
    }
  }

  const api = Object.freeze({ validate, Acts, mulberry32 });
  if (typeof window !== "undefined") window.PetRigLogic = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();
