"use strict";
// Bot screen: the agents' space (docs/agent-spaces.md).
// Who is working on the shared desktop and who waits, the user's control level (Watch / Together / Full control),
// "Work on this device" / "Send back to its space" per agent, and a stage the main process covers with the live
// viewer (a native view, main/space-view.js). The view is placed over the stage only while the stage is really
// visible: on screen, mounted, and not covered by a sheet or menu; otherwise it is hidden, which also stops the
// stream. Loaded before botscreen.js, which mounts it when deck.spaces exists.
window.DeckSpacePanel = function DeckSpacePanel(ctx) {
  const { h, deck } = ctx;
  const T = (k, v) => i18nText(k, v);
  const LEVELS = ["watch", "together", "full"];
  const P = { list: null, level: null, profile: null, busy: false, err: null, shown: "", expanded: false };

  const status = h("div", { class: "sp-status", role: "status" });
  const levels = h("span", { class: "chan sp-levels", role: "group" });
  const note = h("div", { class: "sp-note" });
  const stage = h("div", { class: "sp-stage" });
  const agentSel = h("select", { class: "sp-agent", onchange: (e) => ((P.profile = e.target.value), render()) });
  const routeBtn = h("button", { class: "btn mini", type: "button", onclick: () => moveAgent() });
  const route = h("div", { class: "sp-route" }, agentSel, routeBtn);
  // the large view, like the Workspace tab's: the panel covers the chat and the side panel (this window only)
  const ICON_EXPAND = ["M10 2h4v4", "M14 2l-4.5 4.5", "M6 14H2v-4", "M2 14l4.5-4.5"];
  const ICON_COLLAPSE = ["M14 6h-4V2", "M10 6l4-4", "M2 10h4v4", "M6 10l-4 4"];
  const svgIcon = (paths) => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(k, v);
    for (const d of paths) {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  };
  const expandBtn = h("button", { class: "ws-expand sp-expand", type: "button", "aria-pressed": "false", onclick: () => setExpanded(!P.expanded) });
  // who is on the desktop right now, at a glance next to the title (spec 3.5: the lock holder and the queue)
  const badge = h("span", { class: "sp-badge", hidden: true });
  const head = h("div", { class: "sp-head" }, h("span", { class: "sp-title" }, h("h2", { class: "section-h" }, T("space.title")), badge), h("span", { class: "sp-tools" }, levels, expandBtn));
  const root = h("section", { class: "sp", hidden: true }, head, status, stage, note, route);

  const space = () => (P.list && P.list.spaces && P.list.spaces[0]) || null;
  const agents = () => (ctx.agents ? ctx.agents() : []).filter((a) => a && a.profile);
  const isHere = (profile) => !!(P.list && (P.list.here || []).some((x) => x.profile === profile && x.device === P.list.deviceId));
  const level = () => P.level || (P.list && P.list.defaultLevel) || "watch";
  const nameOf = (profile) => {
    const a = agents().find((x) => x.profile === profile);
    return (a && (a.name || a.agent)) || profile;
  };

  function setExpanded(on) {
    P.expanded = !!on;
    renderExpand();
  }

  function renderExpand() {
    root.classList.toggle("expanded", P.expanded);
    expandBtn.setAttribute("aria-pressed", P.expanded ? "true" : "false");
    expandBtn.replaceChildren(svgIcon(P.expanded ? ICON_COLLAPSE : ICON_EXPAND));
    expandBtn.title = P.expanded ? T("space.collapse") : T("space.expand");
    expandBtn.setAttribute("aria-label", expandBtn.title);
  }

  function render() {
    const st = space();
    if (!st && P.expanded) setExpanded(false);
    root.hidden = !st; // a relay without agent spaces: nothing to show
    if (!st) return;
    status.textContent = !st.online
      ? T("space.offline")
      : st.user
        ? T("space.user")
        : st.holder
          ? T("space.holder", { who: nameOf(st.holder) })
          : T("space.free");
    if (st.online && st.queue && st.queue.length) status.append(" · ", T("space.queue", { who: st.queue.map(nameOf).join(", ") }));
    const busy = st.online && !!st.holder;
    badge.hidden = !busy;
    badge.classList.toggle("user", !!st.user);
    if (busy) {
      const who = st.user ? T("space.badgeUser") : st.holderName || nameOf(st.holder);
      const waiting = st.queue && st.queue.length ? ` · ${T("space.badgeWaiting", { n: st.queue.length })}` : "";
      badge.replaceChildren(h("span", { class: "sp-dot", "aria-hidden": "true" }), `${who}${waiting}`);
      badge.title = status.textContent;
    }
    levels.setAttribute("aria-label", T("space.level"));
    levels.replaceChildren(
      ...LEVELS.map((l) =>
        h("button", { type: "button", "aria-pressed": level() === l ? "true" : "false", title: T(`space.levelHelp.${l}`), disabled: P.busy || !st.online ? true : null, onclick: () => setLevel(l) }, T(`space.level.${l}`))
      )
    );
    note.textContent = P.err || T(`space.levelHelp.${level()}`);
    note.classList.toggle("bad", !!P.err);
    const list = agents();
    if (!P.profile || !list.some((a) => a.profile === P.profile)) P.profile = list.length ? list[0].profile : null;
    agentSel.replaceChildren(...list.map((a) => h("option", { value: a.profile, selected: a.profile === P.profile ? true : null }, nameOf(a.profile))));
    route.hidden = !list.length;
    const here = P.profile && isHere(P.profile);
    routeBtn.textContent = here ? T("space.back") : T("space.here");
    routeBtn.disabled = P.busy || !P.profile ? true : null;
  }

  async function act(fn) {
    P.busy = true;
    P.err = null;
    render();
    try {
      await fn();
    } catch (e) {
      P.err = ctx.cleanErr ? ctx.cleanErr(e) : String((e && e.message) || e);
    }
    P.busy = false;
    await refresh();
  }

  function setLevel(l) {
    if (l === level()) return;
    P.level = l;
    P.shown = ""; // the viewer reloads for the new level
    act(async () => {
      const r = await deck.spaces.control(l === "watch" ? "release" : l);
      if (r && r.ok === false) throw new Error(r.error || "control refused");
    });
  }

  function moveAgent() {
    const p = P.profile;
    if (!p) return;
    const target = isHere(p) ? "space" : "device";
    act(async () => {
      const r = await deck.spaces.route(p, target);
      // why: hosting = Desktop control is off here; driver = on, but its driver is not ready; offline = not connected
      const WHY = { hosting: "U0161", driver: "space.noDriver", offline: "space.deviceOffline" };
      if (r && r.ok === false) throw new Error(r.code === "device" ? T(WHY[r.why] || "U0161") : r.error || r.code || "refused");
    });
  }

  let applied = false; // the Settings default level has been sent to the relay once
  async function refresh() {
    const was = !!space();
    try {
      P.list = await deck.spaces.list();
    } catch {
      P.list = null;
    }
    if (!!space() !== was && ctx.onAvailable) ctx.onAvailable(!!space()); // the Bot screen tab may appear/disappear
    const st = space();
    if (st && !applied && !P.level) {
      applied = true;
      const d = level();
      P.level = d;
      if (d !== "watch" && st.level !== d) deck.spaces.control(d).catch(() => {}); // Settings > Default control
    } else if (st && st.level && !P.busy && st.level !== P.level) {
      P.level = st.level; // the relay's level wins (a restarted relay is back at Watch)
      P.shown = ""; // the viewer reloads for it
    }
    render();
  }

  // ---- the native view follows the stage --------------------------------------------------------------
  /** The stage's rect when the viewer may cover it, else null. */
  function visibleRect() {
    const st = space();
    if (!root.isConnected || root.hidden || document.hidden || !st || !st.viewer || !st.online) return null;
    const r = stage.getBoundingClientRect();
    if (r.width < 40 || r.height < 40 || r.bottom <= 0 || r.top >= window.innerHeight) return null;
    // something drawn over the stage (a sheet, a menu, a dialog) wins: the native view would sit on top of it
    const probe = document.elementFromPoint(r.left + r.width / 2, Math.max(r.top, 0) + Math.min(r.height, window.innerHeight - Math.max(r.top, 0)) / 2);
    if (probe && probe !== stage && !stage.contains(probe)) return null;
    const top = Math.max(r.top, 0);
    return { x: r.left, y: top, width: r.width, height: Math.min(r.bottom, window.innerHeight) - top };
  }

  // the placement loop runs only while the panel is mounted (botscreen.js kicks it when the tab is shown)
  let looping = false;
  function kick() {
    if (looping || !root.isConnected) return;
    looping = true;
    requestAnimationFrame(place);
  }

  function place() {
    const r = visibleRect();
    const key = r ? `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)},${level()}` : "";
    if (key !== P.shown) {
      P.shown = key;
      deck.spaces.view(r, level()).catch(() => {});
    }
    if (root.isConnected) requestAnimationFrame(place);
    else looping = false; // unmounted: the view is hidden (r was null); the next kick() restarts it
  }

  refresh();
  // every 3 s while shown; every 15 s otherwise, so a space that appears on the relay brings the tab back
  let ticks = 0;
  setInterval(() => {
    ticks += 1;
    if (document.hidden) return;
    if (root.isConnected || ticks % 5 === 0) refresh();
    kick();
  }, 3000);
  // Esc leaves the large view while the Deck page has the keyboard (inside the viewer, the button does it)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && P.expanded && !e.defaultPrevented && !document.querySelector("dialog[open]")) setExpanded(false);
  });
  renderExpand();
  document.addEventListener("deck-language", () => {
    renderExpand();
    head.querySelector(".section-h").textContent = T("space.title");
    render();
  });

  return { root, refresh, kick, available: () => !!space(), setAgent: (profile) => profile && ((P.profile = profile), render()) };
};
