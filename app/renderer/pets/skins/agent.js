"use strict";
// Agent skin: the relevant agent's medallion (its Telegram avatar, else its initials on the deck's coin) with
// a name tag. The agent is the one an event is about while the event lasts, otherwise the one main reports
// (the latest that worked or wrote), otherwise Hermes. The ring tells the state: a patina arc turning while
// working, amphora ripples for a new reply, a gilt pulse while an answer waits, grey and dashed when the
// relay is away. The shell adds the same hop, shake and bubble as the other skins.
(() => {
  const SWAP_MS = 160;
  const NS = "http://www.w3.org/2000/svg";
  let R = null;

  function div(cls) {
    const d = document.createElement("div");
    d.className = cls;
    return d;
  }

  function svgRing() {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "ag-ring");
    svg.setAttribute("viewBox", "0 0 80 80");
    for (const cls of ["track", "arc"]) {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("class", cls);
      c.setAttribute("cx", "40");
      c.setAttribute("cy", "40");
      c.setAttribute("r", "37");
      svg.append(c);
    }
    return svg;
  }

  /** Initials for a medallion without an avatar: "Hermes" -> "H", "Code Reviewer" -> "CR". */
  function initials(name) {
    const words = String(name || "").replace(/^#\s*/, "").split(/[\s_-]+/).filter(Boolean);
    const s = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "H").slice(0, 1);
    return s.toLocaleUpperCase("tr");
  }

  function mount(root, env) {
    const ag = div("ag");
    const medal = div("ag-medal");
    const face = div("ag-face");
    const img = document.createElement("img");
    img.className = "ag-img";
    img.alt = "";
    img.draggable = false;
    const init = document.createElement("span");
    init.className = "ag-init";
    face.append(img, init);
    medal.append(div("ag-halo"), div("ag-ripple"), div("ag-ripple r2"), svgRing(), face);
    const tag = div("ag-tag");
    const name = document.createElement("span");
    name.className = "ag-name";
    tag.append(name);
    ag.append(medal, tag);
    root.append(ag);
    R = { ag, face, img, init, name, env, who: null, swap: 0, motion: true };
    env.pose("medal");
    show({ name: "Hermes" }, true);
  }

  /** Puts an agent on the medallion; a different agent cross-fades in. */
  function show(agent, instant) {
    const a = agent && agent.name ? agent : { name: "Hermes" };
    const id = `${a.name}\n${a.avatar || ""}`;
    if (id === R.who) return;
    R.who = id;
    const put = () => {
      R.name.textContent = a.name;
      R.init.textContent = initials(a.name);
      if (a.avatar) R.img.src = a.avatar;
      else R.img.removeAttribute("src");
      R.face.classList.toggle("has-img", !!a.avatar);
      R.face.classList.remove("swap");
    };
    clearTimeout(R.swap);
    if (instant || !R.motion) return put();
    R.face.classList.add("swap");
    R.swap = setTimeout(put, SWAP_MS);
  }

  function setState(state, _summary, ctx = {}) {
    if (!R) return;
    R.ag.dataset.s = state;
    show(ctx.agent, !!ctx.instant);
  }

  function setMotion(on) {
    if (!R) return;
    R.motion = on;
    R.ag.classList.toggle("still", !on);
  }

  function unmount() {
    if (!R) return;
    clearTimeout(R.swap);
    R.ag.remove();
    R = null;
  }

  (window.PetSkins = window.PetSkins || {}).agent = { mount, setState, setMotion, unmount, play: () => {}, initials };
})();
