"use strict";
// Bot screen: the agents' space (docs/agent-spaces.md). Shared mode (phase 1): who is working on the shared desktop
// and who waits. Own desktop per agent (phase 2): one pill per agent with its desktop's state (running, starting,
// off, failed, on the shared desktop after a fallback), plus the shared desktop's pill when there is one; the
// selected pill drives the badge, the viewer, the control level and Start / Stop. Either way: the user's control
// level (Watch / Together / Full control) on the selected desktop, "Work on this device" / "Send back to its space"
// per agent, and a stage the main process covers with the live viewer (a native view, main/space-view.js). The view
// is placed over the stage only while the stage is really visible: on screen, mounted, and not covered by a sheet or
// menu; otherwise it is hidden, which also stops the stream. Loaded before botscreen.js, which mounts it when
// deck.spaces exists. The pills come computed with the list (main/space-view-logic.js pills()).
window.DeckSpacePanel = function DeckSpacePanel(ctx) {
  const { h, deck } = ctx;
  const T = (k, v) => i18nText(k, v);
  const LEVELS = ["watch", "together", "full"];
  // shown: the key last sent to the main process ("" = hidden; null = send again, whatever it is now);
  // levels: the user's level per space id; space: the selected space ("host" or an agent profile; null until the
  // first list: then the first agent's desktop in agent mode, else the shared one)
  const P = { list: null, levels: {}, space: null, profile: null, busy: false, err: null, shown: "", expanded: false };

  const A = { cards: new Map(), approvals: [], profile: null, generation: 0, records: [], points: [], rows: new Map(), frameQueue: [], framesActive: 0, snapshotsFailed: false, snapshotEvent: null, next: null, loading: false, loaded: false, modal: null };

  const pillsRow = h("div", { class: "sp-pills", role: "group", hidden: true });
  const hint = h("div", { class: "sp-hint", hidden: true });
  const status = h("div", { class: "sp-status", role: "status" });
  const levels = h("span", { class: "chan sp-levels", role: "group" });
  const note = h("div", { class: "sp-note" });
  const fell = h("div", { class: "sp-note sp-fell", hidden: true });
  const stage = h("div", { class: "sp-stage" });
  const agentSel = h("select", { class: "sp-agent", onchange: (e) => ((P.profile = e.target.value), render()) });
  const routeBtn = h("button", { class: "btn mini", type: "button", onclick: () => moveAgent() });
  const startBtn = h("button", { class: "btn mini", type: "button", onclick: () => desktopAct("start") });
  const stopBtn = h("button", { class: "btn mini", type: "button", onclick: () => desktopAct("stop") });
  const route = h("div", { class: "sp-route" }, startBtn, stopBtn, agentSel, routeBtn);
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
  // who is on the selected desktop right now, at a glance next to the title (spec 3.5; phase 2: the agent and where
  // its desktop runs, "Aurora · on pc")
  const badge = h("span", { class: "sp-badge", hidden: true });
  const head = h("div", { class: "sp-head" }, h("span", { class: "sp-title" }, h("h2", { class: "section-h" }, T("space.title")), badge), h("span", { class: "sp-tools" }, levels, expandBtn));
  const cards = h("div", { class: "sp-approvals", "aria-live": "polite" });
  const timeline = h("div", { class: "sp-timeline", role: "list", onscroll: (e) => {
    const el = e.target;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40 && A.next) loadTimeline(false);
  } });
  const activityNote = h("div", { class: "sp-note", role: "status" });
  const snapshotMessage = h("span");
  const retrySnapshots = h("button", { type: "button", class: "btn mini", "data-action": "retry-snapshots", onclick: () => loadTimeline(true) }, T("safety.retry"));
  const snapshotNote = h("div", { class: "sp-note", role: "status", hidden: true }, snapshotMessage, retrySnapshots);
  const more = h("button", { type: "button", class: "btn mini", "data-action": "more", onclick: () => loadTimeline(false) }, T("safety.more"));
  const drawer = h("details", { class: "sp-activity", ontoggle: () => { if (drawer.open && !A.loaded) loadTimeline(true); } },
    h("summary", null, T("safety.activity")), activityNote, snapshotNote, timeline, more);
  const work = h("div", { class: "sp-work" }, stage, drawer);
  const root = h("section", { class: "sp", hidden: true }, head, pillsRow, hint, status, cards, work, note, fell, route);

  const spaces = () => (P.list && Array.isArray(P.list.spaces) ? P.list.spaces : []);
  const pills = () => (P.list && Array.isArray(P.list.pills) ? P.list.pills : []);
  const agentPills = () => pills().filter((p) => p.id !== "host");
  /** The selected space's /spaces entry, or null. */
  const space = () => spaces().find((s) => s && s.id === P.space) || null;
  const pillOf = (id) => pills().find((p) => p.id === id) || null;
  const agents = () => (ctx.agents ? ctx.agents() : []).filter((a) => a && a.profile);
  const isHere = (profile) => !!(P.list && (P.list.here || []).some((x) => x.profile === profile && x.device === P.list.deviceId));
  const defLevel = () => (P.list && P.list.defaultLevel) || "watch";
  /** The selected space's level: the user's; before that, the relay's for an agent desktop, the default for the shared one. */
  const level = () => {
    const id = P.space || "host";
    if (P.levels[id]) return P.levels[id];
    const st = space();
    return st && st.kind === "agent" ? (LEVELS.includes(st.level) ? st.level : "watch") : defLevel();
  };
  const nameOf = (profile) => {
    const a = agents().find((x) => x.profile === profile);
    return (a && (a.name || a.agent)) || profile;
  };
  const labelOf = (p) => (p.id === "host" ? T("space.sharedDesktop") : p.label || nameOf(p.id));
  /** A relay error as people read it: a fallback reason when it is one, else as given. */
  const reasonText = (e) => {
    const k = `space.reason.${e}`;
    const t = T(k);
    return t !== k ? t : String(e || "refused");
  };

  /** Keep the selection valid: the chosen pill while it exists, else the first agent's, else the shared desktop. */
  function pickSpace() {
    const ps = pills();
    if (P.space && ps.some((p) => p.id === P.space)) return;
    if (P.space === "host" && !ps.length) return; // shared mode: the shared desktop, as in phase 1
    const first = agentPills()[0];
    P.space = first ? first.id : "host";
    P.shown = null;
  }

  function select(id) {
    if (id === P.space) return;
    P.space = id;
    P.err = null;
    P.shown = null; // another space: the viewer loads it afresh
    if (id !== "host") P.profile = id;
    syncLevel();
    render();
    kick();
    refreshSafety();
  }

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

  function renderPills() {
    const ap = agentPills();
    pillsRow.hidden = !ap.length; // shared mode: unchanged from phase 1, no pills
    if (!ap.length) return pillsRow.replaceChildren();
    pillsRow.setAttribute("aria-label", T("space.pills"));
    pillsRow.replaceChildren(
      ...pills().map((p) => {
        const label = labelOf(p);
        const where = p.where ? T("space.on", { host: p.where }) : "";
        return h(
          "button",
          { class: "sp-pill", type: "button", "aria-pressed": p.id === P.space ? "true" : "false", title: [label, T(`space.pill.${p.state}`), where].filter(Boolean).join(" · "), onclick: () => select(p.id) },
          h("span", { class: `sp-pdot ${p.state}`, "aria-hidden": "true" }),
          label,
          A.approvals.some((a) => a.profile === p.id) ? h("span", { class: "sp-approval-count" }, T(A.approvals.filter((a) => a.profile === p.id).length === 1 ? "safety.approvalOne" : "safety.approvalCount", { n: A.approvals.filter((a) => a.profile === p.id).length })) : null
        );
      })
    );
  }

  function render() {
    const any = spaces().length > 0;
    if (!any && P.expanded) setExpanded(false);
    root.hidden = !any; // a relay without agent spaces: nothing to show
    if (!any) return;
    pickSpace();
    resetSafetyProfile();
    drawer.hidden = P.space === "host";
    renderPills();
    const agentMode = !!(P.list && ["agent", "overflow"].includes(P.list.mode));
    hint.hidden = !(agentMode && Array.isArray(P.list.hosts) && !P.list.hosts.length);
    hint.textContent = hint.hidden ? "" : T("space.noHost");
    const st = space();
    const pill = pillOf(P.space);
    const isAgent = !!st && st.kind === "agent";
    fell.hidden = true;
    if (!st) {
      status.textContent = T("space.offline");
      badge.hidden = true;
    } else if (isAgent) {
      // an agent's own desktop: its state and where it runs
      const label = pill ? labelOf(pill) : nameOf(st.id);
      const state = pill ? pill.state : "off";
      const where = !st.usingShared && st.hostName ? T("space.on", { host: st.hostName }) : "";
      status.textContent = st.user ? T("space.user") : [label, T(`space.pill.${state}`), where].filter(Boolean).join(" · ");
      badge.hidden = false;
      badge.classList.toggle("user", !!st.user);
      badge.replaceChildren(h("span", { class: "sp-dot", "aria-hidden": "true" }), [st.user ? T("space.badgeUser") : label, where].filter(Boolean).join(" · "));
      badge.title = status.textContent;
      if (st.fallback && (state === "shared" || state === "none")) {
        fell.hidden = false;
        fell.textContent = T(state === "none" ? "space.noDesktop" : "space.fellBack", { who: label, reason: reasonText(st.fallback || "none") });
      }
    } else {
      // the shared desktop (phase 1)
      status.textContent = !st.online ? T("space.offline") : st.user ? T("space.user") : st.holder ? T("space.holder", { who: nameOf(st.holder) }) : T("space.free");
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
    }
    const online = !!(st && st.online);
    levels.setAttribute("aria-label", T("space.level"));
    levels.replaceChildren(
      ...LEVELS.map((l) =>
        h("button", { type: "button", "aria-pressed": level() === l ? "true" : "false", title: T(`space.levelHelp.${l}`), disabled: P.busy || !online ? true : null, onclick: () => setLevel(l) }, T(`space.level.${l}`))
      )
    );
    note.textContent = P.err || T(`space.levelHelp.${level()}`);
    note.classList.toggle("bad", !!P.err);
    // Start / Stop: the selected agent's own desktop
    const ps = st && st.usingShared ? (st.state === "pulling" ? "starting" : st.state) : pill ? pill.state : null;
    startBtn.textContent = T("space.start");
    stopBtn.textContent = T("space.stop");
    startBtn.hidden = !isAgent || ps === "ready" || ps === "starting";
    stopBtn.hidden = !isAgent || !(ps === "ready" || ps === "starting");
    startBtn.disabled = stopBtn.disabled = P.busy ? true : null;
    // "Work on this device": the selected agent in agent mode, else the agent chosen in the list (phase 1)
    const list = agents();
    if (isAgent) P.profile = st.id;
    else if (!P.profile || !list.some((a) => a.profile === P.profile)) P.profile = list.length ? list[0].profile : null;
    agentSel.hidden = isAgent;
    agentSel.replaceChildren(...list.map((a) => h("option", { value: a.profile, selected: a.profile === P.profile ? true : null }, nameOf(a.profile))));
    route.hidden = !isAgent && !list.length;
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
    const id = P.space;
    P.levels[id] = l;
    P.shown = null; // the viewer reloads for the new level
    act(async () => {
      const r = await deck.spaces.control(l === "watch" ? "release" : l, id);
      if (r && r.ok === false) throw new Error(r.error || "control refused");
    });
  }

  function desktopAct(action) {
    const id = P.space;
    if (!id || id === "host") return;
    act(async () => {
      const r = await deck.spaces.desktop(id, action);
      if (r && r.ok === false) throw new Error(reasonText(r.error));
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

  // The Settings default level is sent to the relay once per space; afterwards the relay's level for the selected
  // space wins (a restarted relay is back at Watch). The shared desktop gets it when first selected (phase 1). An
  // agent's own desktop gets it only once its stage is really shown (place()), and at most Together: Full control
  // pauses that agent, so it takes the user's own click.
  const applied = new Set();
  const AGENT_DEFAULT_MAX = "together";
  function applyAgentDefault(st) {
    if (!st || st.kind !== "agent" || applied.has(st.id) || st.id in P.levels) return;
    applied.add(st.id);
    const d = defLevel() === "full" ? AGENT_DEFAULT_MAX : defLevel();
    if (d === "watch") return;
    P.levels[st.id] = d;
    if (st.level !== d) deck.spaces.control(d, st.id).catch(() => {});
  }
  function syncLevel() {
    const st = space();
    if (!st) return;
    if (st.kind === "agent" && !applied.has(st.id) && !(st.id in P.levels)) return; // the relay's level until it is shown
    if (!applied.has(st.id) && !(st.id in P.levels)) {
      applied.add(st.id);
      const d = defLevel();
      P.levels[st.id] = d;
      if (d !== "watch" && st.level !== d) deck.spaces.control(d, st.id).catch(() => {}); // Settings > Default control
    } else if (st.level && !P.busy && st.level !== P.levels[st.id]) {
      P.levels[st.id] = st.level;
      if (st.id === P.space) P.shown = null; // the viewer reloads for it
    }
  }

  function resetSafetyProfile() {
    if (A.profile === P.space) return;
    for (const entry of A.rows.values()) releaseRow(entry);
    A.rows.clear(); A.frameQueue = []; A.snapshotsFailed = false; A.snapshotEvent = null;
    paintSnapshotNote();
    A.profile = P.space; A.generation++; A.records = []; A.points = []; A.next = null; A.loaded = false; A.loading = false;
    timeline.replaceChildren(); activityNote.textContent = ""; more.hidden = true;
  }

  function sheet(content, ok = null, run = null) {
    if (A.modal) A.modal.close();
    const dialog = h("dialog", { class: "sp-sheet", "aria-label": T("safety.activity") });
    const cancel = h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, T("safety.close"));
    const confirm = ok ? h("button", { class: "btn primary", type: "button", "data-action": "confirm", onclick: async () => {
      if (!dialog.open || A.modal !== dialog || confirm.disabled) return;
      confirm.disabled = true;
      try { await run(); dialog.close(); }
      catch { activityNote.textContent = T("safety.operationFailed"); dialog.close(); }
    } }, ok) : null;
    dialog.append(content, h("div", { class: "bs-sheet-foot" }, cancel, confirm));
    dialog.addEventListener("close", () => { if (A.modal === dialog) A.modal = null; dialog.remove(); P.shown = null; kick(); });
    root.append(dialog); A.modal = dialog;
    deck.spaces.view(null, "watch", P.space).catch(() => {});
    dialog.showModal(); cancel.focus();
  }
  async function answerCard(card, choice) {
    const entry = A.cards.get(card.id);
    if (!entry || entry.busy || card.state === "snapshotting" || card.expires <= Date.now()) return;
    entry.busy = true; entry.approve.disabled = entry.deny.disabled = true;
    try {
      const r = await deck.spaces.answer(card.id, choice, choice === "once" && card.state === "snapshot-failed");
      if (r?.ok === false) throw new Error();
      entry.failed = false;
    } catch { entry.failed = true; }
    finally { entry.busy = false; paintCards(); await refreshSafety(false); paintCards(); }
  }
  function paintCards() {
    const live = new Set(A.approvals.map((c) => c.id));
    for (const [id, e] of A.cards) if (!live.has(id)) { e.root.remove?.(); A.cards.delete(id); }
    for (const card of A.approvals) {
      let entry = A.cards.get(card.id);
      if (!entry) {
        const command = h("pre", { class: "sp-command" });
        const tail = h("pre", { class: "sp-command" });
        const left = h("span", { class: "sp-time-left" });
        const problem = h("p", { class: "sp-note" });
        const error = h("p", { class: "sp-note bad", role: "alert", hidden: true });
        const approve = h("button", { class: "btn", type: "button", "data-action": "approve", onclick: () => answerCard(entry.card, "once") });
        const deny = h("button", { class: "btn", type: "button", "data-action": "deny", onclick: () => answerCard(entry.card, "deny") }, T("safety.deny"));
        const root = h("section", { class: "sp-approval", tabindex: "-1", "data-id": card.id, onkeydown: (e) => {
          if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); }
        } }, h("strong", null, nameOf(card.profile)), command, tail, left, problem, error, h("div", { class: "bs-sheet-foot" }, approve, deny));
        entry = { root, command, tail, left, problem, error, approve, deny, busy:false, focused:false, failed:false };
        A.cards.set(card.id, entry);
      }
      entry.card = card;
      entry.command.textContent = card.command;
      entry.tail.hidden = card.text === card.command;
      entry.tail.textContent = T("safety.actionText", { text: card.text });
      entry.left.textContent = T("safety.timeLeft", { seconds: Math.max(0, Math.ceil((card.expires - Date.now()) / 1000)) });
      entry.problem.textContent = card.state === "snapshot-failed" ? T(card.reason === "too-large" ? "safety.tooLarge" : "safety.snapshotFailed") : "";
      entry.error.hidden = !entry.failed;
      entry.error.textContent = entry.failed ? T("safety.approvalFailed") : "";
      entry.deny.textContent = T("safety.deny");
      entry.approve.textContent = T(card.state === "snapshot-failed" ? "safety.anyway" : "safety.once");
      entry.approve.disabled = entry.deny.disabled = entry.busy || card.state === "snapshotting" || card.expires <= Date.now();
    }
    // Keep existing elements: polling updates text without replacing the focused card/buttons.
    for (const card of A.approvals) {
      const entry = A.cards.get(card.id);
      if (!cards.contains(entry.root)) cards.append(entry.root);
      if (!entry.focused && root.isConnected && !document.hidden && !A.modal) { entry.focused = true; entry.root.focus(); }
    }
  }
  async function refreshSafety(clearErrors = true) {
    resetSafetyProfile();
    if (!deck.spaces.approvals) return;
    try {
      const r = await deck.spaces.approvals();
      if (r?.ok === false || !Array.isArray(r?.approvals)) return;
      if (clearErrors) for (const entry of A.cards.values()) entry.failed = false;
      A.approvals = r.approvals; paintCards(); renderPills();
    } catch { activityNote.textContent = T("safety.operationFailed"); }
    if (!document.hidden && drawer.open && P.space !== "host" && (!A.loaded || timeline.scrollTop <= 20)) await loadTimeline(true);
  }
  async function loadTimeline(reset) {
    if (!deck.spaces.audit || A.loading || !P.space || P.space === "host" || (!reset && !A.next)) return;
    const profile = P.space, generation = A.generation;
    A.loading = true; more.disabled = true;
    activityNote.textContent = T("safety.loading");
    try {
      const [log, snaps] = await Promise.allSettled([
        deck.spaces.audit(profile, reset ? "" : A.next, 50),
        reset ? deck.spaces.snapshots(profile) : Promise.resolve({ points: A.points }),
      ]);
      if (generation !== A.generation || profile !== P.space) return;
      if (reset) {
        A.snapshotsFailed = snaps.status !== "fulfilled" || snaps.value?.ok === false || !Array.isArray(snaps.value?.points);
        A.points = A.snapshotsFailed ? [] : snaps.value.points;
        A.snapshotEvent = A.snapshotsFailed ? null : snaps.value.notice?.event;
        paintSnapshotNote();
      }
      if (log.status !== "fulfilled" || log.value?.ok === false || !Array.isArray(log.value?.records)) throw new Error();
      A.records = reset ? log.value.records : [...A.records, ...log.value.records];
      A.next = log.value.next; A.loaded = true;
      activityNote.textContent = "";
      paintTimeline(profile, true);
    } catch { if (generation === A.generation) activityNote.textContent = T("safety.operationFailed"); }
    finally { if (generation === A.generation) { A.loading = false; more.disabled = false; more.hidden = !A.next; } }
  }
  function paintSnapshotNote() {
    snapshotNote.hidden = !A.snapshotsFailed && !A.snapshotEvent;
    snapshotMessage.textContent = A.snapshotsFailed ? T("safety.snapshotsUnavailable") : A.snapshotEvent ? T(`safety.event.${A.snapshotEvent}`) : "";
    retrySnapshots.hidden = !A.snapshotsFailed;
    retrySnapshots.textContent = T("safety.retry");
  }
  function releaseRow(entry) {
    entry.img?.removeAttribute("src"); // Frames are data URLs, so dropping the attribute releases their data.
    entry.row.remove();
  }
  function drainFrames() {
    while (A.framesActive < 4 && A.frameQueue.length) {
      const job = A.frameQueue.shift();
      if (A.rows.get(job.key) !== job.entry) continue;
      A.framesActive++;
      job.entry.frameAttempts++;
      Promise.resolve().then(() => deck.spaces.frame(job.profile, job.frame)).then((src) => {
        if (A.rows.get(job.key) === job.entry && job.profile === P.space && typeof src === "string" && /^data:image\/(png|jpeg|webp|gif);base64,/.test(src)) job.entry.img.setAttribute("src", src);
      }).catch(() => {}).finally(() => { job.entry.framePending = false; A.framesActive--; drainFrames(); });
    }
  }
  function paintTimeline(profile, retryFrames = false) {
    const rows = [...A.records.map((r) => ({ ...r, kind: "call" })), ...A.points.map((r) => ({ ...r, kind: "point" }))]
      .sort((a, b) => b.time - a.time || b.id.localeCompare(a.id));
    const retained = new Map();
    for (const r of rows) {
      const key = `${r.kind}:${r.id}`;
      if (!retained.has(key) && retained.size < 500) retained.set(key, r);
    }
    A.records = [...retained.values()].filter((r) => r.kind === "call");
    A.points = [...retained.values()].filter((r) => r.kind === "point");
    for (const [key, entry] of A.rows) if (!retained.has(key)) { releaseRow(entry); A.rows.delete(key); }
    for (const [key, r] of retained) {
      if (A.rows.has(key)) { A.rows.get(key).translate(); continue; }
      const stamp = h("time");
      const row = h("div", { class: "sp-activity-row", role: "listitem" }, stamp);
      const entry = { row, img: null, frameAttempts: 0, framePending: false, translate: () => {} };
      A.rows.set(key, entry);
      if (r.kind === "point") {
        const label = h("span");
        const restore = h("button", { class: "btn mini", type: "button", "data-action": "restore", onclick: () => sheet(
            h("p", null, T("safety.restoreConfirm")), T("safety.restore"), async () => {
              const result = await deck.spaces.restore(profile, r.id);
              if (result?.ok === false) throw new Error();
              A.loaded = false; await refresh();
            }) }, T("safety.restore"));
        entry.translate = () => {
          label.textContent = `${T(`safety.reason.${r.reason}`)} · ${(r.size / 1e6).toFixed(1)} MB${r.consistent ? "" : ` · ${T("safety.unpaused")}`}`;
          restore.textContent = T("safety.restore");
        };
        row.append(label, restore);
      } else {
        const icon = r.tool === "type_text" || r.tool === "press_key" ? "⌨" : r.tool === "screenshot" ? "▣" : "↗";
        const outcome = h("span", { class: "sp-outcome" });
        const event = r.event ? h("span") : null;
        row.append(h("span", { "aria-hidden": "true" }, icon), h("span", null, r.tool),
          outcome,
          h("pre", { class: "sp-command" }, r.command || JSON.stringify(r.summary)),
          h("span", { class: "sp-note" }, `${r.duration || 0} ms`));
        if (event) row.append(event);
        let button;
        if (r.frame) {
          const img = h("img", { class: "sp-frame", alt: T("safety.frame"), loading: "lazy" });
          entry.img = img;
          button = h("button", { type: "button", class: "sp-frame-button", "aria-label": T("safety.frame"), onclick: () => {
            const src = img.getAttribute("src");
            if (src) sheet(h("img", { class: "sp-frame-large", src, alt: T("safety.frame") }));
          } }, img);
          row.append(button);
        }
        entry.translate = () => {
          outcome.textContent = T(`safety.outcome.${r.outcome}`);
          if (event) event.textContent = T(`safety.event.${r.event}`);
          if (button) { button.setAttribute("aria-label", T("safety.frame")); entry.img.setAttribute("alt", T("safety.frame")); }
        };
      }
      const translate = entry.translate;
      entry.translate = () => { stamp.textContent = new Date(r.time).toLocaleString(i18nLocale()); translate(); };
      entry.translate();
    }
    let anchor = null;
    for (const key of [...retained.keys()].reverse()) {
      const row = A.rows.get(key).row;
      if (row.parentNode !== timeline || row.nextSibling !== anchor) timeline.insertBefore(row, anchor);
      anchor = row;
    }
    for (const [key, r] of retained) {
      const entry = A.rows.get(key);
      // Retry only on a later timeline load, never while queued or after success.
      if (entry.img && !entry.img.getAttribute("src") && !entry.framePending && entry.frameAttempts < 3 && (retryFrames || entry.frameAttempts === 0)) {
        entry.framePending = true;
        A.frameQueue.push({ key, entry, profile, frame: r.frame });
      }
    }
    A.frameQueue = A.frameQueue.filter((job) => A.rows.get(job.key) === job.entry);
    drainFrames();
  }

  async function refresh() {
    const was = spaces().length > 0;
    try {
      P.list = await deck.spaces.list();
    } catch {
      P.list = null;
    }
    const now = spaces().length > 0;
    if (now !== was && ctx.onAvailable) ctx.onAvailable(now); // the Bot screen tab may appear/disappear
    if (now) pickSpace();
    syncLevel();
    render();
    await refreshSafety();
  }

  // ---- the native view follows the stage --------------------------------------------------------------
  /** The stage's rect when the viewer may cover it, else null. */
  function visibleRect() {
    if (A.modal) return null;
    const st = space();
    if (!root.isConnected || root.hidden || document.hidden || !st || st.viewer === false || !st.online) return null;
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
    if (r) applyAgentDefault(space()); // an agent desktop the user can see now: its default level (capped)
    const key = r ? `${P.space},${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)},${level()}` : "";
    if (key !== P.shown) {
      P.shown = key;
      deck.spaces.view(r, level(), P.space || "host").catch(() => {});
    }
    if (root.isConnected) requestAnimationFrame(place);
    else looping = false; // unmounted: the view is hidden (r was null); the next kick() restarts it
  }

  refresh();
  // every 3 s while shown; every 15 s otherwise, so a space that appears on the relay brings the tab back
  let ticks = 0;
  setInterval(() => {
    ticks += 1;
    if (document.hidden) { if (ticks % 2 === 0) refreshSafety(); return; }
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
    paintCards(); paintSnapshotNote();
    if (A.loaded) paintTimeline(P.space);
    drawer.querySelector("summary").textContent = T("safety.activity");
    more.textContent = T("safety.more");
    render();
  });

  return {
    root,
    refresh,
    kick,
    focusApproval: async (profile, id) => {
      if (A.modal) { const modal = A.modal; A.modal = null; modal.close(); }
      select(profile); await refreshSafety();
      const card = A.cards.get(id);
      if (card) { card.root.scrollIntoView({ block: "nearest" }); card.root.focus(); }
    },
    available: () => spaces().length > 0,
    live: profile => window.DeckWsView.spaceLive(P.list, profile),
    // botscreen.js: show this agent (its own desktop's pill in agent mode, the "Work on this device" choice otherwise)
    setAgent: (profile) => {
      if (!profile) return;
      if (agentPills().some((p) => p.id === profile)) return select(profile);
      P.profile = profile;
      render();
    },
  };
};
