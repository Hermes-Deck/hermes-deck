"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { validate, Acts, mulberry32 } = require("../renderer/pets/rig-logic");

// Complete the brief's abbreviated scenes without depending on art files or Electron.
function example() {
  const idle = {
    pose: "sit", face: "open", still: "open",
    layers: [
      { id: "tail", img: "idle-tail", pivot: [330, 470] },
      { id: "body", img: "idle-body", pivot: [256, 482] },
      { id: "head", img: "idle-head", pivot: [256, 330], parent: "body",
        faces: { open: "idle-eyes-open", half: "idle-eyes-half", closed: "idle-eyes-closed", look: "idle-eyes-look", down: "working-eyes-down" } },
    ],
    loops: [{ part: "body", motion: "breathe", amp: 1.2, dur: 3800 }],
    acts: [
      { name: "blink", every: [2.5, 6], face: [["half", 50], ["closed", 110], ["half", 50]] },
      { name: "tilt", every: [9, 18], part: "head", motion: "tilt", amp: -6, dur: 1800 },
      { name: "glance", every: [12, 24], face: [["look", 1400]] },
      { name: "flick", every: [6, 14], part: "tail", motion: "flick", amp: 9, dur: 700 },
    ],
  };
  const scenes = Object.fromEntries(["idle", "working", "reply", "waiting", "offline"].map((state) => [state, structuredClone(idle)]));
  scenes.working.face = "down";
  scenes.working.layers.push({ id: "pawL", img: "working-pawL", parent: "body" }, { id: "pawR", img: "working-pawR", parent: "body" });
  scenes.working.loops.push({ part: "pawL", motion: "tap", amp: 3, dur: 420 }, { part: "pawR", motion: "tap", amp: 3, dur: 420, delay: 210 }, { part: "tail", motion: "sway", amp: 4, dur: 2600 });
  Object.assign(scenes.offline, { pose: "lie", face: "closed", still: "closed" });
  return { canvas: 512, scales: [1, 2, 3], look: { part: "head", x: 3, y: 2 }, scenes };
}

test("rig validate: accepts the complete example, defaults and forward parent references", () => {
  const spec = example();
  assert.deepEqual(validate(spec), []);
  spec.scenes.idle.layers.reverse();
  delete spec.scales;
  delete spec.scenes.idle.layers[0].pivot;
  assert.deepEqual(validate(spec), []);
});

test("rig validate: rejects broken motions, images, faces, parents and states", () => {
  const cases = [
    [(s) => { s.scenes.idle.loops[0].motion = "spin"; }, /unknown motion/],
    [(s) => { s.scenes.idle.acts[1].motion = "breathe"; }, /unknown motion/],
    [(s) => { delete s.scenes.idle.layers[0].img; }, /missing image/],
    [(s) => { s.scenes.idle.layers[2].faces.open = ""; }, /missing face image/],
    [(s) => { delete s.scenes.idle.layers[2].faces.half; }, /missing act face/],
    [(s) => { s.scenes.idle.face = "absent"; }, /missing default face/],
    [(s) => { s.scenes.idle.still = "absent"; }, /missing still face/],
    [(s) => { s.scenes.idle.layers[0].parent = "absent"; }, /unknown parent/],
    [(s) => { s.scenes.idle.layers[1].parent = "head"; }, /cyclic parent/],
    [(s) => { delete s.scenes.reply; }, /reply: missing state/],
    [(s) => { s.scenes.idle.acts[0].every = [6, 2]; }, /invalid every/],
    [(s) => { s.scenes.idle.loops[0].part = "absent"; }, /unknown part/],
    [(s) => { s.look.part = "absent"; }, /unknown look part/],
    [(s) => { s.scenes.idle.layers.push(s.scenes.idle.layers[0]); }, /duplicate layer/],
    [(s) => { s.scenes.idle.acts.push({ name: "empty", every: [1, 2] }); }, /face or motion/],
  ];
  for (const [breakSpec, message] of cases) {
    const spec = example();
    breakSpec(spec);
    assert.match(validate(spec).join("\n"), message);
  }
  for (const spec of [null, [], {}, { scenes: { idle: { layers: [null] } } }]) assert.ok(validate(spec).length);
});

test("rig Acts: first and subsequent random intervals stay within bounds without collisions", () => {
  const act = example().scenes.idle.acts[0];
  const scheduler = new Acts([act], mulberry32(42));
  let previous = scheduler.next(10000);
  assert.ok(previous.at >= 10750 && previous.at <= 16000);
  for (let i = 0; i < 1000; i++) {
    const next = scheduler.next(previous.at);
    const delta = next.at - previous.at;
    assert.ok(delta >= 2500 && delta <= 6000, String(delta));
    previous = next;
  }
  const firstAt = (rng) => new Acts([act], rng).next(0).at;
  assert.equal(firstAt(() => 0), 750);
  assert.equal(firstAt(() => 1), 6000);
});

test("rig Acts: reservations never overlap, including ties, long acts and overdue calls", () => {
  const acts = [
    { name: "both", every: [1, 1], motion: "tilt", dur: 800, face: [["closed", 1200]] },
    { name: "other", every: [1, 1], motion: "nod", dur: 1600 },
  ];
  const scheduler = new Acts(acts, () => 1);
  assert.equal(scheduler.durationOf(acts[0]), 1200);
  let previous = scheduler.next(0);
  assert.equal(previous.act.name, "both");
  const second = scheduler.next(previous.at);
  assert.equal(second.at, previous.at + 1500);
  assert.equal(second.act.name, "other");
  previous = second;
  for (let i = 0; i < 100; i++) {
    const now = previous.at + (i % 5 === 0 ? 10000 : 0);
    const next = scheduler.next(now);
    assert.ok(next.at >= now);
    assert.ok(next.at >= previous.at + scheduler.durationOf(previous.act) + 300);
    previous = next;
  }
  assert.equal(new Acts([]).next(0), null);
});

test("rig Acts: seeded generators are deterministic and do not mutate the spec", () => {
  const acts = example().scenes.idle.acts;
  const before = structuredClone(acts);
  const trace = (rng) => {
    const scheduler = new Acts(acts, rng);
    let now = 0;
    return Array.from({ length: 500 }, () => {
      const next = scheduler.next(now);
      now = next.at;
      return [now, next.act.name];
    });
  };
  const lcg = (seed) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  assert.deepEqual(trace(lcg(9)), trace(lcg(9)));
  assert.deepEqual(trace(mulberry32(9)), trace(mulberry32(9)));
  assert.notDeepEqual(trace(mulberry32(9)), trace(mulberry32(10)));
  assert.deepEqual(acts, before);
});

// Minimal DOM and clock for the actual skin's lifecycle; no browser or npm dependencies.
function harness(spec) {
  class Element {
    constructor() {
      this.children = []; this.dataset = {}; this.events = {};
      this.style = { setProperty(name, value) { this[name] = String(value); } };
      this.className = "";
      this.classList = {
        contains: (name) => this.className.split(" ").includes(name),
        add: (...names) => { this.className = [...new Set([...this.className.split(" ").filter(Boolean), ...names])].join(" "); },
        remove: (...names) => { this.className = this.className.split(" ").filter((name) => !names.includes(name)).join(" "); },
        toggle: (name, on) => { if (on) this.classList.add(name); else this.classList.remove(name); },
      };
    }
    append(...els) { for (const el of els) { el.parentElement = this; this.children.push(el); } }
    remove() { this.parentElement.children = this.parentElement.children.filter((el) => el !== this); }
    addEventListener(name, fn) { this.events[name] = fn; }
  }
  const body = new Element();
  const root = new Element();
  const timers = new Map();
  const poses = [];
  let now = 0, timerId = 0, observer;
  const window = { PetRigLogic: { validate, Acts, mulberry32 } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/pets/skins/rig.js"), "utf8"), {
    window, document: { body, createElement: () => new Element() }, performance: { now: () => now },
    MutationObserver: class {
      constructor(fn) { this.fn = fn; observer = this; }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, at: now + ms }); assert.ok(timers.size <= 1); return timerId; },
    clearTimeout: (id) => timers.delete(id),
  });
  const skin = window.PetRig("test", "pets/test/", spec);
  skin.mount(root, { pose: (pose) => poses.push(pose) });
  const tick = () => {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id); now = timer.at; timer.fn();
  };
  const setClass = (name, on) => { body.classList.toggle(name, on); observer.fn(); };
  return { skin, root, body, timers, poses, tick, setClass, observer };
}

test("rig skin: nested layers, crisp face sequences, fades, pause, stills and cleanup", () => {
  const spec = example();
  spec.scenes.idle.acts = [{ name: "both", every: [1, 1], face: [["closed", 100], ["half", 50]], part: "head", motion: "tilt", amp: 5, dur: 400 }];
  const h = harness(spec);
  const box = h.root.children[0];
  const idle = box.children.find((el) => el.dataset.state === "idle");
  const body = idle.children[1];
  const head = body.children[0].children[0].children[1];
  const act = head.children[0], content = act.children[0];
  assert.equal(head.dataset.id, "head");
  assert.equal(head.style["--px"], "50%");
  assert.match(content.children[0].srcset, /@3x.png 3x/);
  assert.equal(content.children[0].decoding, "sync");
  const visibleFace = () => content.children.find((el) => el.classList.contains("show")).dataset.face;
  h.skin.setState("idle");
  assert.equal(h.timers.size, 1);
  h.skin.look(1, -1);
  assert.equal(content.style.transform, "translate(3px, -2px)");
  h.skin.look(null);
  assert.equal(content.style.transform, "");
  h.tick();
  assert.equal(visibleFace(), "closed");
  assert.ok(act.classList.contains("rig-act-tilt"));
  h.tick(); assert.equal(visibleFace(), "half");
  h.tick(); assert.equal(visibleFace(), "open");
  box.events.animationend({ target: act, animationName: "rig-tilt" });
  assert.ok(!act.classList.contains("rig-act-tilt"));
  h.tick();
  h.skin.setState("working");
  assert.ok(idle.classList.contains("out"));
  assert.equal(idle.style["--rig-fade"], "220ms");
  h.skin.setState("offline");
  const working = box.children.find((el) => el.dataset.state === "working");
  assert.equal(working.style["--rig-fade"], "350ms");
  assert.deepEqual(h.poses, ["sit", "sit", "lie"]);
  h.setClass("paused", true); assert.equal(h.timers.size, 0);
  h.setClass("paused", false); assert.equal(h.timers.size, 1);
  h.skin.setState("idle", null, { instant: true });
  h.tick();
  h.skin.setMotion(false);
  assert.equal(h.timers.size, 0);
  assert.equal(visibleFace(), "open");
  assert.ok(box.classList.contains("still"));
  assert.ok(!act.classList.contains("rig-act-tilt"));
  h.skin.setState("offline");
  assert.ok(box.children.every((el) => !el.classList.contains("out")));
  h.skin.setMotion(true); assert.equal(h.timers.size, 1);
  h.setClass("shot-still", true); assert.equal(h.timers.size, 0);
  h.setClass("shot-still", false); assert.equal(h.timers.size, 1);
  assert.equal(h.skin.play(), false);
  h.skin.unmount();
  assert.equal(h.timers.size, 0);
  assert.equal(h.root.children.length, 0);
  assert.ok(h.observer.disconnected);
});

test("rig skin: pause at timer fire is checked even before the observer runs", () => {
  const h = harness(example());
  h.skin.setState("idle");
  h.body.classList.add("paused");
  h.tick();
  assert.equal(h.timers.size, 0);
  h.setClass("paused", false);
  assert.equal(h.timers.size, 1);
  h.skin.unmount();
});
