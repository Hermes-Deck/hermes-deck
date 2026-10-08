"use strict";
var i18nNode = (key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).node(key, vars, typeof document === "object" ? document : null);
var i18nBind = (el, attr, key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).bind(el, attr, key, vars);
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
var i18nLocale = typeof module === "object" && module.exports ? require("./i18n").getLocale : window.DeckI18n.getLocale;
// Status pet page (A10): the shell around the skins. It turns the fleet summary main forwards
// (window.pet.onState) into a state (PetLogic.stateOf), hands it to the chosen skin (window.PetSkins:
// character, orb, agent), plays events (window.pet.onEvent: a hop, a shake, a speech bubble) and draws the
// bar and the badges. Strings go in through textContent only. main owns the window: this page reports hover
// (main makes the window click-through elsewhere), press and release (main follows the drag and tells a
// click from a move), the bar's two buttons and bubble clicks.
//
// Skin contract (pets/skins/<name>.js, registered on window.PetSkins):
//   mount(root, env)                   build into root; env.pose(name, badge = name) sizes the hit area
//                                      (name) and places the badges (badge)
//   setState(state, summary, ctx)      state: offline|idle|working|reply|waiting;
//                                      ctx: {motion, instant (no transition), agent: {name, avatar?}|null}
//   play(event, route)                 an event's skin-specific part; the shell does the bubble, and the move
//                                      (route.fx) too unless play returns true (then the skin calls env.fx)
//   setMotion(on)                      animations on, or stills only
//   look(x, y) | look(null)            optional: the pointer over the pet, -1..1 from its centre
//   unmount()
(() => {
  const pet = window.pet;
  const L = window.PetLogic;
  const SKINS = window.PetSkins || {};
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const slot = $("slot");
  const stage = $("stage");
  const hit = $("hit");
  const bar = $("bar");
  const text = $("text");
  const count = $("count");
  const runs = $("runs");
  const bubble = $("bubble");
  const over = new Set(); // pet / open bar / bubble under the pointer
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  let st = { running: 0, subs: 0, unread: 0, pending: 0, offline: true, parts: [], side: "right", skin: "character", motion: true, bubbles: true, agent: null, shot: null };
  let skinName = null;
  let skin = null;
  let motionOn = null;
  let hold = null; // an event's temporary state and agent: {state, agent}
  let holdTimer = 0;
  let open = false;
  let dragging = false;
  let timer = 0;
  let first = true;
  let shown = true; // main: the window is on screen

  const cap = (n) => (n > 99 ? "99+" : String(n));
  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    e.className = cls;
    e.textContent = txt;
    return e;
  }

  // ---- skins
  const env = {
    pose: (name, badge = name) => {
      if (slot.dataset.pose !== name) slot.dataset.pose = name;
      if (slot.dataset.badge !== badge) slot.dataset.badge = badge;
    },
    fx: (name) => fx(name), // a skin that plays an event's move later (after a transition) calls this
  };

  function useSkin(name) {
    const want = SKINS[name] ? name : "character";
    if (want === skinName) return false;
    if (skin && skin.unmount) skin.unmount();
    stage.replaceChildren();
    stage.classList.remove("fx-hop", "fx-happy", "fx-shake");
    skinName = want;
    skin = SKINS[want];
    slot.dataset.skin = want;
    skin.mount(stage, env);
    motionOn = null;
    return true;
  }

  const motion = () => st.motion !== false && !reduce.matches && st.shot !== "still";

  /** The state on screen: the summary's, raised by an event's hold while it lasts. */
  function apply(instant = false) {
    const state = L.effective(L.stateOf(st), hold && hold.state);
    body.dataset.mode = state;
    const m = motion();
    if (m !== motionOn) {
      motionOn = m;
      body.classList.toggle("still", !m);
      if (skin.setMotion) skin.setMotion(m);
    }
    skin.setState(state, st, { motion: m, instant: instant || !m, agent: (hold && hold.agent) || st.agent || null });
  }

  // ---- bar and badges
  function render() {
    const s = st;
    const busy = !s.offline && !!(s.running || s.subs);
    body.classList.toggle("side-left", s.side === "left");

    const need = s.pending || s.unread; // answers first, then new replies
    count.hidden = !need;
    count.textContent = need ? cap(need) : "";

    runs.hidden = !busy; // running agents, then "+N" sub-agents like the deck's coins
    runs.replaceChildren();
    if (busy && s.running) runs.append(String(s.running));
    if (busy && s.subs) runs.append(el("span", "plus", `+${s.subs}`));

    const parts = Array.isArray(s.parts) ? s.parts : [];
    const kids = [el("span", "name", "Hermes")];
    for (const p of parts) kids.push(el("span", "sep", "·"), el("span", p.tone || "", p.text || ""));
    text.replaceChildren(...kids);
    i18nBind(hit, "aria-label", "U0876", { v: parts.map((p) => p.text).join(", ") });
  }

  // ---- events: a move on the stage, a temporary state, a bubble
  function fx(name) {
    if (!name || !motion()) return;
    stage.classList.remove("fx-hop", "fx-happy", "fx-shake");
    void stage.offsetWidth; // restart even when the same move is still running
    stage.classList.add(`fx-${name}`);
  }
  stage.addEventListener("animationend", (e) => {
    if (e.target === stage) stage.classList.remove("fx-hop", "fx-happy", "fx-shake");
  });

  function onEvent(ev) {
    const r = L.routeEvent(ev, { bubbles: st.bubbles });
    if (!r) return;
    const agent = ev.agent ? { name: L.clean(ev.agent, 40), avatar: ev.avatar } : null;
    if (r.hold || !hold) {
      hold = { state: r.hold, agent };
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        hold = null;
        apply();
      }, L.HOLD_MS);
    } else if (agent) hold.agent = agent; // "done" keeps a reply's or a question's hold running
    apply();
    // the skin may take the move over (Character: after standing up, so the hop or shake is seen on the new pose)
    if (!(skin.play && skin.play(ev, r))) fx(r.fx);
    if (r.bubble) say(ev, r.tone);
  }

  // the bubble stays ~6 s, longer while the pointer is on it; a click opens the deck on that chat
  let bubbleTimer = 0;
  let bubbleKey = null;
  function say(ev, tone) {
    $("bubble-who").textContent = L.clean(ev.agent, 40) || "Hermes";
    $("bubble-say").textContent = L.clean(ev.snippet, 64);
    bubble.dataset.tone = tone;
    bubbleKey = typeof ev.key === "string" ? ev.key : null;
    bubble.hidden = false;
    void bubble.offsetWidth; // from display:none: let the fade-in start from its first frame
    bubble.classList.add("show");
    bubbleLater(L.HOLD_MS);
  }
  function bubbleLater(ms) {
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(unsay, ms);
  }
  function unsay() {
    clearTimeout(bubbleTimer);
    if (over.has(bubble)) return bubbleLater(1500);
    bubble.classList.remove("show");
    bubbleTimer = setTimeout(() => {
      bubble.hidden = true; // after the fade-out
      over.delete(bubble);
      report();
    }, 220);
  }
  bubble.addEventListener("mouseenter", () => {
    if (!bubble.classList.contains("show")) return;
    over.add(bubble);
    report();
  });
  bubble.addEventListener("mouseleave", () => {
    over.delete(bubble);
    report();
    if (bubble.classList.contains("show")) bubbleLater(2500);
  });
  bubble.addEventListener("click", () => {
    const key = bubbleKey;
    over.delete(bubble);
    unsay();
    pet.open(key);
  });

  // ---- hover bar: opens on hover (after a beat) or right-click, closes after the pointer leaves
  const report = () => pet.interactive(dragging || over.size > 0);
  function setOpen(on) {
    clearTimeout(timer);
    timer = 0;
    if (open === on) return;
    open = on;
    body.classList.toggle("open", on);
    if (!on) over.delete(bar);
    report();
  }
  function later(on, ms) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      if (!on && (over.has(hit) || over.has(bar) || dragging)) return;
      setOpen(on);
    }, ms);
  }
  hit.addEventListener("mouseenter", () => {
    over.add(hit);
    report();
    if (!dragging) later(true, 180);
  });
  hit.addEventListener("mouseleave", () => {
    over.delete(hit);
    report();
    later(false, 450);
    if (skin && skin.look) skin.look(null);
  });
  hit.addEventListener("mousemove", (e) => {
    if (!skin || !skin.look || dragging) return;
    const r = stage.getBoundingClientRect(); // eyes follow the pointer: -1..1 around the stage's centre
    skin.look(Math.max(-1, Math.min(1, (e.clientX - r.left - r.width / 2) / (r.width / 2))), Math.max(-1, Math.min(1, (e.clientY - r.top - r.height * 0.6) / (r.height / 2))));
  });
  bar.addEventListener("mouseenter", () => {
    if (!open) return;
    over.add(bar);
    report();
    clearTimeout(timer);
  });
  bar.addEventListener("mouseleave", () => {
    over.delete(bar);
    report();
    later(false, 450);
  });
  hit.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    setOpen(true);
  });

  // ---- press on the pet: main follows the cursor until release; no movement = a click (open the deck)
  hit.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    hit.setPointerCapture(e.pointerId);
    dragging = true;
    body.classList.add("dragging");
    setOpen(false);
    report();
    pet.drag("start");
  });
  function release() {
    if (!dragging) return;
    dragging = false;
    body.classList.remove("dragging");
    pet.drag("end");
    report();
  }
  hit.addEventListener("pointerup", release);
  hit.addEventListener("pointercancel", release);
  hit.addEventListener("lostpointercapture", release);
  window.addEventListener("blur", release);

  $("open").addEventListener("click", () => {
    setOpen(false);
    pet.open(null);
  });
  $("hide").addEventListener("click", () => pet.hide());

  // ---- nothing moves while the window is hidden or covered (Chromium also stops drawing then)
  const pause = () => body.classList.toggle("paused", document.hidden || !shown);
  document.addEventListener("visibilitychange", pause);
  pet.onVisible((on) => {
    shown = on !== false;
    pause();
  });
  reduce.addEventListener("change", () => skin && apply());

  // ---- main's state
  pet.onState((s) => {
    if (!s || typeof s !== "object") return;
    st = s;
    body.classList.toggle("shot-still", s.shot === "still");
    if (typeof s.bg === "string" && /^#[0-9a-f]{3,8}$/i.test(s.bg)) body.style.background = s.bg; // captures on a backdrop
    // pet size: the page is laid out at 1x and zoomed; main has already sized the window to match. CSS zoom,
    // not webContents.setZoomFactor: Chromium zoom is per origin and deck://app is the main window's too.
    const k = [0.75, 1, 1.25, 1.5].includes(s.size) ? s.size : 1;
    if (document.documentElement.style.zoom !== String(k)) document.documentElement.style.zoom = String(k);
    const fresh = useSkin(s.skin);
    render();
    apply(fresh || first); // the first state and a new skin show at once, without a transition
    if (s.shot && s.open) setOpen(true);
    if (first) {
      first = false;
      // the first capture waits for the fonts and every sprite, so nothing is missing in the shot
      const imgs = [...stage.querySelectorAll("img")].map((i) => (i.decode ? i.decode().catch(() => {}) : null));
      Promise.all([document.fonts.ready, ...imgs]).then(() => pet.rendered());
    }
  });
  pet.onEvent((ev) => {
    if (ev && typeof ev === "object" && skin) onEvent(ev);
  });
  useSkin("character");
  render();
  apply(true);
  document.addEventListener("deck-language", () => render());
  pet.ready();
})();
