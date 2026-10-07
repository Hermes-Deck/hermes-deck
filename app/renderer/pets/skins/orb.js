"use strict";
// Küre skin: a glowing orb with two eyes, pure CSS (pets/skins/orb.css). It breathes and blinks; on hover
// its eyes follow the pointer. States: a patina swirl while working, amphora ripples and a bounce for a new
// reply, a gilt pulse while an answer waits, dim with closed eyes when the relay is away. The colour is a
// registered custom property, so one state flows into the next instead of switching.
(() => {
  let R = null;

  function div(cls) {
    const d = document.createElement("div");
    d.className = cls;
    return d;
  }

  function mount(root, env) {
    const orb = div("orb");
    const float = div("orb-float");
    const ball = div("orb-ball");
    const face = div("orb-face");
    face.append(div("orb-eye"), div("orb-eye"));
    ball.append(div("orb-swirl"), div("orb-shine"), face);
    float.append(div("orb-halo"), div("orb-ripple"), div("orb-ripple r2"), ball);
    orb.append(float);
    root.append(orb);
    R = { orb, face, env };
    env.pose("orb");
  }

  function setState(state) {
    if (!R) return;
    R.orb.dataset.s = state;
  }

  function setMotion(on) {
    if (R) R.orb.classList.toggle("still", !on);
  }

  /** Eyes toward the pointer (-1..1 from the centre), or back to the middle. */
  function look(x, y) {
    if (!R) return;
    const on = typeof x === "number" && typeof y === "number";
    R.face.style.setProperty("--lx", `${on ? (x * 4).toFixed(1) : 0}px`);
    R.face.style.setProperty("--ly", `${on ? (y * 3).toFixed(1) : 0}px`);
  }

  function unmount() {
    if (R) R.orb.remove();
    R = null;
  }

  (window.PetSkins = window.PetSkins || {}).orb = { mount, setState, setMotion, look, unmount, play: () => {} };
})();
