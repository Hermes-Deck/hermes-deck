"use strict";
// Full-canvas cut-outs: CSS owns motion; one timer owns act starts, face steps and completion.
(() => {
  const L = window.PetRigLogic;

  function makeRig(id, ART, spec) {
    const errors = L.validate(spec);
    if (errors.length) throw new Error(`PetRig ${id}: ${errors.join("; ")}`);
    let R = null;
    const div = (cls) => {
      const el = document.createElement("div");
      el.className = cls;
      return el;
    };
    const still = () => !R.motion || document.body.classList.contains("still") || document.body.classList.contains("shot-still");
    const blocked = () => still() || document.body.classList.contains("paused");

    function img(name) {
      const el = document.createElement("img");
      el.alt = "";
      el.draggable = false;
      el.decoding = "sync";
      el.src = `${ART}${name}.png`;
      el.srcset = (spec.scales || [1]).map((n) => `${ART}${name}${n === 1 ? "" : `@${n}x`}.png ${n}x`).join(", ");
      return el;
    }

    function vars(el, move) {
      el.style.setProperty("--amp", move.amp ?? 1.5);
      el.style.setProperty("--amp2", (move.amp ?? 1.5) * -0.35);
      el.style.setProperty("--dur", `${move.dur}ms`);
      el.style.setProperty("--delay", `${move.delay || 0}ms`);
    }

    function face(scene, name) {
      for (const el of scene.faces) el.classList.toggle("show", el.dataset.face === name);
    }

    function mount(root, env) {
      unmount();
      const box = div("rig");
      const scenes = new Map();
      for (const [state, data] of Object.entries(spec.scenes)) {
        const el = div("rig-scene");
        el.dataset.state = state;
        const scene = { el, data, parts: new Map(), faces: [] };
        for (const layer of data.layers) {
          const part = div("rig-layer");
          part.dataset.id = layer.id;
          const pivot = layer.pivot || [spec.canvas / 2, spec.canvas];
          part.style.setProperty("--px", `${pivot[0] / spec.canvas * 100}%`);
          part.style.setProperty("--py", `${pivot[1] / spec.canvas * 100}%`);
          if (layer.opacity !== undefined) part.style.opacity = layer.opacity;
          // Separate transforms compose: loop -> act -> pointer -> artwork and child layers.
          const act = div("rig-act");
          const content = div("rig-look");
          if (layer.img) content.append(img(layer.img)); // a face layer may be faces only
          for (const [name, file] of Object.entries(layer.faces || {})) {
            const image = img(file);
            image.className = "rig-face";
            image.dataset.face = name;
            content.append(image);
            scene.faces.push(image);
          }
          act.append(content);
          part.append(act);
          scene.parts.set(layer.id, { el: part, act, content });
        }
        for (const layer of data.layers) {
          const parent = layer.parent === undefined ? el : scene.parts.get(layer.parent).content;
          parent.append(scene.parts.get(layer.id).el);
        }
        for (const loop of data.loops || []) {
          const part = scene.parts.get(loop.part).el;
          vars(part, loop);
          part.classList.add(`rig-loop-${loop.motion}`);
        }
        face(scene, data.face || "open");
        scenes.set(state, scene);
        box.append(el);
      }
      root.append(box); // All images load now, including the hidden scenes and faces.
      R = { box, env, scenes, active: null, motion: true, timer: 0, act: null, scheduler: null,
        rng: L.mulberry32(Math.floor(Math.random() * 4294967296)), observer: null, suspended: false };
      R.observer = new MutationObserver(() => {
        if (!R) return;
        const paused = blocked();
        if (paused !== R.suspended || R.box.classList.contains("still") !== still()) reset();
      });
      R.observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
      box.addEventListener("animationend", (e) => {
        const move = R && R.act && R.act.find((m) => m.el === e.target && e.animationName === `rig-${m.motion}`);
        if (move) move.el.classList.remove(`rig-act-${move.motion}`);
      });
      box.addEventListener("transitionend", (e) => {
        if (e.propertyName === "opacity" && e.target.classList.contains("rig-scene")) e.target.classList.remove("out");
      });
      reset();
    }

    function clearAct() {
      if (!R.act) return;
      for (const move of R.act) move.el.classList.remove(`rig-act-${move.motion}`);
      R.act = null;
    }

    function cancel() {
      clearTimeout(R.timer);
      R.timer = 0;
      clearAct();
    }

    function later(fn, ms) {
      R.timer = setTimeout(() => {
        R.timer = 0;
        if (blocked()) { reset(); return; }
        fn();
      }, Math.max(0, ms));
    }

    function schedule(now = performance.now()) {
      if (blocked() || !R.active) return;
      const next = R.scheduler.next(now);
      if (next) later(() => run(next.act), next.at - performance.now());
    }

    function run(act) {
      const scene = R.active;
      const started = performance.now();
      if (act.motion) {
        // one act may move several parts together ("with"): a tail's base and, a beat later, its tip
        R.act = [act, ...(act.with || [])].map((move) => {
          const el = scene.parts.get(move.part).act;
          vars(el, move);
          el.classList.add(`rig-act-${move.motion}`);
          return { el, motion: move.motion };
        });
      }
      const steps = act.face || [];
      let index = 0;
      const step = () => {
        if (index < steps.length) {
          const [name, ms] = steps[index++];
          face(scene, name);
          later(step, ms);
        } else {
          face(scene, scene.data.face || "open");
          later(() => {
            clearAct(); // Also covers suppressed animations or a missed animationend.
            schedule(performance.now() + 300);
          }, R.scheduler.durationOf(act) - (performance.now() - started));
        }
      };
      step();
    }

    function reset() {
      cancel();
      R.suspended = blocked();
      R.box.classList.toggle("still", still());
      for (const scene of R.scenes.values()) {
        face(scene, (still() && scene.data.still) || scene.data.face || "open");
        for (const part of scene.parts.values()) part.content.style.transform = "";
        if (still()) scene.el.classList.remove("out");
      }
      if (!R.active || R.suspended) return;
      R.scheduler = new L.Acts(R.active.data.acts || [], R.rng);
      schedule();
    }

    function setState(state, _summary, ctx = {}) {
      if (!R) return;
      const scene = R.scenes.get(state);
      if (!scene) return;
      const old = R.active;
      if (old === scene && !ctx.instant) return;
      cancel();
      const fade = old && !ctx.instant && !still() ? (old.data.pose === scene.data.pose ? 220 : 350) : 0;
      for (const other of R.scenes.values()) {
        other.el.classList.remove("out");
        other.el.classList.toggle("show", other === scene);
      }
      if (fade && old !== scene) {
        old.el.style.setProperty("--rig-fade", `${fade}ms`);
        old.el.classList.add("out");
      }
      R.active = scene;
      R.env.pose(scene.data.pose);
      reset();
    }

    function setMotion(on) {
      if (!R || R.motion === on) return;
      R.motion = on;
      reset();
    }

    function look(x, y) {
      if (!R || !R.active || !spec.look || blocked()) return;
      const part = R.active.parts.get(spec.look.part);
      if (part) part.content.style.transform = x === null ? "" : `translate(${x * spec.look.x}px, ${y * spec.look.y}px)`;
    }

    function unmount() {
      if (!R) return;
      cancel();
      R.observer.disconnect();
      R.box.remove();
      R = null;
    }

    return ((window.PetSkins = window.PetSkins || {})[id] = { mount, setState, setMotion, look, unmount, play: () => false });
  }

  window.PetRig = makeRig;
})();
