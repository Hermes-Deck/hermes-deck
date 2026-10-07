"use strict";
// Sprite skins: frame-animated illustrated characters (Karakter, Baykuş, Filozof, the cats...). One factory,
// window.PetSprite(id, art, {x3}), registers PetSkins[id] with its art folder (pets/<id>/);
// pets/skins/<id>.js calls it and pets/skins/<id>.css places that figure's hit area and badges.
// Every animation is one 4-frame strip; CSS steps() moves it inside a 144 px box, so the browser runs the
// animation on its own (no JS loop, no per-frame timers). Loops: idle (holds frame 1, blinks, now and then
// tilts its head), working, reply, waiting, offline. Between poses (sitting, standing, lying) PetLogic.Choreo
// plans transition strips (stand, wake, forward or reversed); each strip's animationend starts the next step.
// Layers cross-fade, so a change never jumps. Motion off: the five stills, cross-faded.
(() => {
  const L = window.PetLogic;
  const LOOPS = ["idle", "working", "reply", "waiting", "offline"];
  const STRIP_NAMES = ["stand", "wake"];
  const TALL = { lie: 0, sit: 1, stand: 2 };

  /**
   * opts.x3: the art has @3x strips too (432 px frames, for the largest pet size on a 2x screen).
   * opts.poses: state -> pose where this figure differs from PetLogic.POSE (a cat waits sitting, not standing).
   */
  function makeSprite(id, ART, opts = {}) {
    let R = null; // the mounted skin

    function img(cls, name) {
      const i = document.createElement("img");
      i.className = cls;
      i.alt = "";
      i.draggable = false;
      i.decoding = "sync"; // preloaded at mount: a layer that appears must never paint a frame without its image
      i.src = `${ART}${name}.png`;
      i.srcset = `${ART}${name}.png 1x, ${ART}${name}@2x.png 2x${opts.x3 ? `, ${ART}${name}@3x.png 3x` : ""}`;
      return i;
    }

    function div(cls) {
      const d = document.createElement("div");
      d.className = cls;
      return d;
    }

    function mount(root, env) {
      const box = div("ch");
      const breath = div("ch-breath");
      const layers = {};
      for (const name of [...LOOPS, ...STRIP_NAMES]) {
        const layer = div("ch-layer");
        layer.dataset.a = name;
        layer.append(img("ch-strip", name));
        breath.append(layer);
        layers[name] = layer;
      }
      const stills = div("ch-stills");
      const still = {};
      for (const name of LOOPS) {
        still[name] = img("ch-still", `still-${name}`);
        still[name].dataset.s = name;
        stills.append(still[name]);
      }
      box.append(breath, stills);
      root.append(box);
      R = { root, box, env, layers, still, ctl: new L.Choreo(opts.poses), active: null, target: null, motion: true, fxAfter: null };
      box.addEventListener("animationend", onEnd);
      box.addEventListener("transitionend", onFaded);
    }

    /** Show one step from Choreo: a loop, or a strip played once (forward or reversed). */
    function run(step) {
      const el = R.layers[step.name];
      R.box.style.setProperty("--ch-fade", `${step.fade}ms`);
      el.classList.remove("run", "rev", "out");
      void el.offsetWidth; // the animation restarts from its first frame even if this layer just played
      if (step.type === "strip" && step.dir === "reverse") el.classList.add("rev");
      el.classList.add("run", "show");
      for (const other of Object.values(R.layers)) {
        if (other === el || !other.classList.contains("show")) continue;
        other.classList.remove("show");
        if (step.fade) other.classList.add("out"); // on top, fading out, still animating; transitionend stops it
        else other.classList.remove("run", "rev", "out");
      }
      R.active = el;
      if (step.type === "loop" && R.fxAfter) {
        R.env.fx(R.fxAfter); // an event's move waited for the transition to end
        R.fxAfter = null;
      }
      // hit area: during a strip the taller of its two poses (the figure grows or shrinks inside it). Badges:
      // toward the pose the strip ends in, gliding for as long as the strip plays, so they keep to the figure
      if (step.type === "strip") {
        const ms = Math.round(parseFloat(getComputedStyle(el.firstChild).animationDuration) * 1000) || 0;
        R.root.parentElement.style.setProperty("--badge-ms", `${ms}ms`);
        R.env.pose(TALL[step.to] > TALL[step.pose] ? step.to : step.pose, step.to);
      } else {
        // a jump (first show, new skin, motion back on) puts the badges in place at once; a loop after a fade
        // moves them as usual
        if (step.fade) R.root.parentElement.style.removeProperty("--badge-ms");
        else R.root.parentElement.style.setProperty("--badge-ms", "0ms");
        R.env.pose(step.pose);
      }
    }

    function onEnd(e) {
      const layer = e.target.parentElement;
      if (!R || !layer || layer !== R.active || !R.ctl.busy || !e.target.classList.contains("ch-strip")) return;
      const next = R.ctl.done();
      if (next) run(next);
    }

    function onFaded(e) {
      const el = e.target;
      if (e.propertyName !== "opacity" || el.classList.contains("show")) return;
      if (el.classList.contains("ch-layer")) el.classList.remove("run", "rev", "out");
      else if (el.classList.contains("ch-still")) el.classList.remove("out");
    }

    function showStill(state) {
      R.root.parentElement.style.removeProperty("--badge-ms"); // motion went off mid-strip: badges move as usual
      for (const [name, i] of Object.entries(R.still)) {
        if (name === state) {
          i.classList.remove("out");
          i.classList.add("show");
        } else if (i.classList.contains("show")) {
          i.classList.remove("show");
          i.classList.add("out"); // the same cross-fade as the layers: old on top, fading
        }
      }
      R.env.pose(R.ctl.poses[state]);
    }

    function setState(state, _summary, ctx = {}) {
      if (!R) return;
      R.target = state;
      if (!R.motion) return showStill(state);
      const step = ctx.instant || R.ctl.pose === null ? R.ctl.jump(state) : R.ctl.set(state);
      if (step) run(step);
    }

    function setMotion(on) {
      if (!R || R.motion === on) return;
      R.motion = on;
      R.box.classList.toggle("still", !on);
      if (!R.target) return;
      if (on) {
        run(R.ctl.jump(R.target)); // back to animating: straight into the current state's loop
        for (const i of Object.values(R.still)) i.classList.remove("show", "out");
      } else {
        for (const l of Object.values(R.layers)) l.classList.remove("run", "rev", "show", "out");
        showStill(R.target);
      }
    }

    /** An event's hop or shake: right away, or on the new pose when the event started a transition. */
    function play(_ev, route) {
      if (!R || !route || !route.fx || !R.motion || !R.ctl.busy) return false;
      R.fxAfter = route.fx;
      return true;
    }

    function unmount() {
      if (R) {
        R.box.remove();
        R.root.parentElement.style.removeProperty("--badge-ms");
      }
      R = null;
    }

    return ((window.PetSkins = window.PetSkins || {})[id] = { mount, setState, setMotion, unmount, play });
  }

  window.PetSprite = makeSprite;
})();
