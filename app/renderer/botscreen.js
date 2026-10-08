"use strict";
var i18nNode = (key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).node(key, vars, typeof document === "object" ? document : null);
var i18nBind = (el, attr, key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).bind(el, attr, key, vars);
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
var i18nLocale = typeof module === "object" && module.exports ? require("./i18n").getLocale : window.DeckI18n.getLocale;
// Bot ekranı tab (renderer): what an agent did on a desktop (its own screenshots with click markers, and an
// action log), "Agent'a ver" (the consent sheet), "Kontrolü al / geri ver" and Durdur; plus the rows for
// Settings → Bu cihaz. Loaded before app.js, which calls window.DeckBotScreen(ctx) once and mounts the
// returned root; the root updates itself in place. Strings from the relay or from other apps' windows go
// in through textContent only. Main side: main/cua/index.js (deck.botscreen).
window.DeckBotScreen = function DeckBotScreen(ctx) {
  const { h, deck } = ctx;
  const api = deck.botscreen;
  const SVGNS = "http://www.w3.org/2000/svg";
  const MAX_EVENTS = 300;
  const MAX_FRAMES = 40;
  const ACT = { get click() { return i18nText("U0721"); }, get double_click() { return i18nText("U0722"); }, get type() { return i18nText("U0723"); }, get key() { return i18nText("U0724"); }, get scroll() { return i18nText("U0725"); }, get drag() { return i18nText("U0726"); }, get capture() { return i18nText("U0727"); }, get other() { return i18nText("U0728"); } };
  const PROFILE_RE = /^[A-Za-z0-9._-]{1,64}$/;

  const B = {
    st: null, // main's publicState()
    events: [], // cu events, oldest first
    seen: new Set(),
    frames: new Map(), // frame path -> {url?, error?, loading?}
    sel: null, // the selected event's key (null: the newest)
    busy: null, // "lease" | "stop"
    msg: null, // {ok, text}
    sheet: null, // the consent sheet while open
    installArmed: false,
    uiDone: false, // the fixture's sheet scene was opened
  };

  const err = (e) => (ctx.cleanErr ? ctx.cleanErr(e) : String((e && e.message) || e));
  const hm = (ms) => new Date(ms).toLocaleTimeString(i18nLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const ago = (ms) => {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 45) return i18nText("U0729", { s: Math.round(s) });
    if (s < 3600) return i18nText("U0403", { v: Math.round(s / 60) });
    return i18nText("U0404", { v: Math.round(s / 3600) });
  };
  const left = (ms) => {
    const m = Math.max(0, Math.round(ms / 60000));
    return m >= 60 ? i18nText("U0693", { v: Math.floor(m / 60), v2: m % 60 }) : i18nText("U0694", { m: m });
  };
  const mb = (n) => `${(n / (1024 * 1024)).toLocaleString(i18nLocale(), { maximumFractionDigits: 1 })} MB`;
  const agents = () => (ctx.agents ? ctx.agents() : []).filter((a) => a && a.profile);
  const nameOf = (profile) => {
    const a = agents().find((x) => x.profile === profile);
    return a ? a.name : profile;
  };
  /** Turkish dative with vowel harmony: Atlas'a, Kâtip'e, Nova'ya, Hermes'e. */
  const dative = (name) => {
    const s = String(name || "").trim();
    if (i18nLocale() !== "tr-TR") return s;
    const low = s.toLocaleLowerCase("tr-TR");
    const vs = low.match(/[aâeıiîoöuüû]/g);
    const back = vs ? "aâıouû".includes(vs[vs.length - 1]) : false;
    return `${s}'${/[aâeıiîoöuüû]$/.test(low) ? "y" : ""}${back ? "a" : "e"}`;
  };

  // ---------------------------------------------------------------- cu events (relay feed)
  function normEvent(e) {
    if (!e || typeof e !== "object" || (e.type !== "cu" && e.ev !== "cu")) return null;
    const t = Number(e.ts);
    const ts = t > 1e12 ? t : t * 1000; // the contract says ms; plugin events elsewhere use seconds
    if (!Number.isFinite(ts) || ts <= 0) return null;
    const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
    const frame = typeof e.frame === "string" && e.frame.length < 300 ? e.frame : null;
    const action = ACT[e.action] ? e.action : "other";
    return {
      key: `${e.sid}|${ts}|${frame}|${action}`,
      sid: String(e.sid || "").slice(0, 128),
      agent: String(e.agent || e.profile || "?").slice(0, 64),
      profile: PROFILE_RE.test(String(e.profile || "")) ? String(e.profile) : "",
      ts,
      action,
      x: num(e.x),
      y: num(e.y),
      app: e.window && e.window.app ? String(e.window.app).slice(0, 80) : null,
      frame,
      device: String(e.device || "").slice(0, 64),
      ok: e.ok !== false,
      error: e.error ? String(e.error).slice(0, 300) : null,
    };
  }

  function addEvents(list) {
    let added = false;
    for (const raw of list) {
      const e = normEvent(raw);
      if (!e || B.seen.has(e.key)) continue;
      B.seen.add(e.key);
      B.events.push(e);
      added = true;
    }
    if (!added) return;
    B.events.sort((a, b) => a.ts - b.ts);
    while (B.events.length > MAX_EVENTS) B.seen.delete(B.events.shift().key);
    if (root.isConnected) update();
  }

  deck.onRelay((m) => {
    if (!m || typeof m !== "object") return;
    if (m.t === "evs" && Array.isArray(m.evs)) addEvents(m.evs);
    else if (m.t === "cu") addEvents(Array.isArray(m.events) ? m.events : [m.ev || m]);
  });

  // ---------------------------------------------------------------- frames (fetched through main with the relay token)
  function loadFrame(path) {
    if (!path || B.frames.has(path)) return;
    B.frames.set(path, { loading: true });
    api
      .frame(path)
      .then((url) => B.frames.set(path, { url }))
      .catch((e) => B.frames.set(path, { error: err(e) }))
      .finally(() => {
        while (B.frames.size > MAX_FRAMES) B.frames.delete(B.frames.keys().next().value);
        if (root.isConnected) update();
      });
  }

  // ---------------------------------------------------------------- DOM (built once, filled by update())
  const statusEl = h("div", { class: "bs-status" });
  const explainEl = h("div", { class: "bs-explain" });
  const grantEl = h("div", { class: "bs-grant" });
  const actionsEl = h("div", { class: "bs-actions" });
  const msgEl = h("p", { class: "bs-msg", role: "status" });
  const img = h("img", { class: "bs-img", alt: "", draggable: "false" });
  const marks = document.createElementNS(SVGNS, "svg");
  marks.setAttribute("class", "bs-marks");
  marks.setAttribute("aria-hidden", "true");
  const stageNote = h("div", { class: "bs-stage-note" });
  const stage = h("div", { class: "bs-stage" }, img, marks, stageNote);
  const caption = h("figcaption", { class: "bs-caption" });
  const viewer = h("figure", { class: "bs-viewer" }, stage, caption);
  const strip = h("div", { class: "bs-strip", role: "list", "aria-label": i18nText("A0323") , "data-i18n-aria-label": "A0323"});
  const logHead = h("h2", { class: "section-h" }, i18nNode("U0731"));
  const logEl = h("div", { class: "bs-log", role: "list" });
  // agent spaces (space-panel.js): the agents' own desktop, live, above this device's own bot screen
  const SP = deck.spaces && window.DeckSpacePanel
    ? window.DeckSpacePanel({ h, deck, agents: ctx.agents, cleanErr: ctx.cleanErr, onAvailable: () => ctx.refreshSettings && ctx.refreshSettings() })
    : null;
  const root = h("div", { class: "bs" }, SP ? SP.root : null, statusEl, explainEl, grantEl, actionsEl, msgEl, viewer, strip, logHead, logEl);
  img.addEventListener("load", () => drawMarks());

  function chip(text, cls, title) {
    return h("span", { class: `bs-chip ${cls || ""}`.trim(), title: title || null }, text);
  }

  function renderStatus() {
    const st = B.st;
    if (!st) return statusEl.replaceChildren(chip(i18nText("U0732"), "dim"));
    const kids = [];
    if (!st.supported) kids.push(chip(i18nText("U0733"), "dim"));
    else if (st.on) kids.push(chip(i18nText("U0734"), "on"));
    else if (st.paused) kids.push(chip(i18nText("U0735"), "warn", i18nText("A0324", { at: hm(st.paused.at) })));
    else kids.push(chip(i18nText("U0736"), "dim"));
    const d = st.driver;
    if (d.status === "installed") kids.push(chip(i18nText("U0737", { v: d.version || i18nText("common.installed") }), "ok"));
    else if (d.status === "missing") kids.push(chip(i18nText("U0738"), "warn"));
    else if (d.status === "error") kids.push(chip(i18nText("U0739"), "bad", d.error || ""));
    else kids.push(chip(i18nText("U0740"), "dim"));
    if (st.on) {
      const l = st.link || {};
      if (l.status === "ready") kids.push(chip(i18nText("U0741"), "ok"));
      else if (l.status === "hello") kids.push(chip(i18nText("U0742"), "dim"));
      else if (l.status === "refused") kids.push(chip(i18nText("U0743"), "bad", l.error || ""));
      else kids.push(chip(l.error ? i18nText("U0744", { error: l.error }) : i18nText("U0745"), "warn"));
      if (st.hotkey.registered === false) kids.push(chip(i18nText("U0746", { label: st.hotkey.label }), "warn", i18nText("U0747")));
      else if (st.hotkey.registered) kids.push(chip(i18nText("common.stopShortcut", { hotkey: st.hotkey.label }), "dim"));
    }
    if (st.frontmost && st.frontmost.supported && st.frontmost.registered === false && !st.fixture) kids.push(chip(i18nText("frontmost.hotkeyUnavailable", { hotkey: st.frontmost.hotkey || "Ctrl+Alt+P" }), "warn", i18nText("frontmost.buttonHelp")));
    statusEl.replaceChildren(...kids);
  }

  function renderExplain() {
    const st = B.st;
    if (!st || st.on) return explainEl.replaceChildren();
    if (st.paused) return explainEl.replaceChildren(h("p", { class: "bs-paused" }, i18nNode("botscreen.pauseHelp", { at: hm(st.paused.at) })));
    const steps = [
      i18nText("U0748"),
      i18nText("U0749"),
      i18nText("U0750"),
      i18nText("U0751"),
    ];
    explainEl.replaceChildren(
      h(
        "div",
        { class: "bs-empty" },
        h("h3", null, i18nNode("U0478")),
        !st.supported ? h("p", { class: "form-error" }, i18nNode("U0753")) :
          h("details", null, h("summary", null, i18nNode("copy.setupSteps")), h("ol", null, steps.map((s) => h("li", null, s)))),
        st.paused ? h("p", { class: "bs-paused" }, i18nNode("U0754", { at: hm(st.paused.at) })) : null,
        st.supported ? h("div", { class: "form-actions" }, h("button", { class: "btn primary", type: "button", onclick: () => ctx.openSettings && ctx.openSettings() }, i18nNode("A0325"))) : null
      )
    );
  }

  function renderGrant() {
    const g = B.st && B.st.grant;
    if (!g) return grantEl.replaceChildren();
    const idle = g.lastActivity ? i18nText("U0755", { lastActivity: ago(g.lastActivity) }) : i18nText("U0756");
    grantEl.replaceChildren(
      h(
        "div",
        { class: "bs-grant-card" },
        h("span", { class: "bs-live", "aria-hidden": "true" }),
        h(
          "div",
          { class: "bs-grant-body" },
          h("div", { class: "bs-grant-title" }, h("b", null, g.agent), i18nNode("A0326"), h("span", null, g.app)),
          h("div", { class: "bs-grant-sub", title: g.title }, g.title),
          g.foreground ? h("div", { class: "bs-grant-sub" }, i18nNode("botscreen.foregroundActive")) : null,
          h("div", { class: "bs-grant-meta" }, i18nNode("U0757", { v: left(g.expires - Date.now()), idleMin: g.idleMin, idle: idle }))
        ),
        h("button", { class: "btn danger", type: "button", disabled: B.busy === "stop" ? true : null, onclick: doStop }, i18nNode("A0182"))
      )
    );
  }

  /** The agent "Kontrolü al" applies to: the grant's, else the selected (or newest) event's. */
  function leaseProfile() {
    const st = B.st;
    if (st && st.grant) return st.grant.profile;
    const e = selected();
    return e && e.profile ? e.profile : null;
  }

  function renderActions() {
    const st = B.st;
    if (!st) return actionsEl.replaceChildren();
    const kids = [];
    const ready = st.on && st.driver.status === "installed";
    if (st.supported && !st.on && (st.paused || (st.hasToken && st.driver.status === "installed"))) kids.push(h("button", { class: "btn primary", type: "button", disabled: B.busy === "resume" ? true : null, onclick: doResume }, i18nNode("botscreen.resume")));
    const why = !st.on ? i18nText("U0161") : st.driver.status !== "installed" ? i18nText("U0170") : !st.agents.length ? i18nText("U0758") : null;
    kids.push(h("button", { class: "btn primary", type: "button", disabled: ready && st.agents.length ? null : true, title: why, onclick: openSheet }, st.grant ? i18nNode("U0759") : i18nNode("A0327")));
    kids.push(h("button", { class: "btn", type: "button", disabled: ready && st.agents.length && st.frontmost && st.frontmost.supported ? null : true, title: st.frontmost && st.frontmost.supported ? i18nText("frontmost.shortcutHelp", { hotkey: st.frontmost.hotkey || "Ctrl+Alt+P" }) : i18nText("frontmost.windowsOnly"), onclick: () => openSheet({ frontmost: true }) }, i18nNode("frontmost.window")));
    const p = leaseProfile();
    const held = p && st.lease && st.lease[p] === "human";
    kids.push(
      h(
        "button",
        {
          class: `btn${held ? " held" : ""}`,
          type: "button",
          disabled: !p || B.busy === "lease" ? true : null,
          title: p ? (held ? i18nText("U0760", { p: nameOf(p) }) : i18nText("U0761", { p: nameOf(p) })) : i18nText("U0762"),
          onclick: () => doLease(p, !held),
        },
        held ? i18nNode("U0763") : i18nNode("U0764")
      )
    );
    if (st.on || st.grant) kids.push(h("button", { class: "btn danger-outline", type: "button", disabled: B.busy === "stop" ? true : null, title: i18nText("A0328", { label: st.hotkey.label }), onclick: doStop , "data-i18n-title": "A0328", "data-i18n-title-vars": JSON.stringify({ label: st.hotkey.label })}, i18nNode("A0182")));
    actionsEl.replaceChildren(...kids);
  }

  function selected() {
    if (!B.events.length) return null;
    return (B.sel && B.events.find((e) => e.key === B.sel)) || B.events[B.events.length - 1];
  }

  const deviceLabel = (e) => {
    const me = B.st && B.st.device ? B.st.device.id : null;
    if (e.device && me && e.device === me) return i18nText("A0329");
    if (e.device === "host") return i18nText("A0330");
    return e.device ? i18nText("common.deviceShort", { id: e.device.slice(0, 8) }) : "";
  };

  function renderViewer() {
    const e = selected();
    if (!e) {
      viewer.classList.add("empty");
      img.removeAttribute("src");
      img.hidden = true;
      marks.replaceChildren();
      i18nBind(stageNote, "textContent", "U0765");
      caption.replaceChildren();
      return;
    }
    viewer.classList.remove("empty");
    const f = e.frame ? B.frames.get(e.frame) : null;
    if (e.frame && !f) loadFrame(e.frame);
    if (f && f.url) {
      if (img.getAttribute("src") !== f.url) img.src = f.url;
      img.hidden = false;
      stageNote.textContent = "";
    } else {
      img.hidden = true;
      img.removeAttribute("src");
      stageNote.textContent = !e.frame ? i18nText("A0331") : f && f.error ? i18nText("U0766", { error: f.error }) : i18nText("U0767");
    }
    drawMarks();
    const where = [e.app, deviceLabel(e)].filter(Boolean).join(" · ");
    caption.replaceChildren(
      ...[
        h("span", { class: "bs-cap-time" }, hm(e.ts)),
        h("b", null, e.agent),
        ` ${ACT[e.action]}`,
        e.x !== null && e.y !== null ? h("span", { class: "bs-cap-xy" }, ` (${Math.round(e.x)}, ${Math.round(e.y)})`) : null,
        where ? h("span", { class: "bs-cap-where" }, ` · ${where}`) : null,
        !e.ok ? h("span", { class: "bs-cap-err" }, i18nNode("A0332", { v: e.error ? `: ${e.error}` : "" })) : null,
      ].filter(Boolean) // replaceChildren would print a null
    );
  }

  /** The click point of the shown event, in frame pixels (the SVG's viewBox is the image's own size). */
  function drawMarks() {
    const e = selected();
    marks.replaceChildren();
    if (!e || img.hidden || !img.naturalWidth || e.x === null || e.y === null) return;
    const w = img.naturalWidth;
    const hgt = img.naturalHeight;
    marks.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
    const r = Math.max(w, hgt) * 0.016;
    const mk = (tag, attrs) => {
      const el = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      marks.appendChild(el);
      return el;
    };
    const cls = e.ok ? "ok" : "bad";
    mk("circle", { class: `halo ${cls}`, cx: e.x, cy: e.y, r: r * 2.2 });
    mk("circle", { class: `ring ${cls}`, cx: e.x, cy: e.y, r });
    mk("circle", { class: `dot ${cls}`, cx: e.x, cy: e.y, r: r * 0.28 });
    if (e.action === "double_click") mk("circle", { class: `ring ${cls}`, cx: e.x, cy: e.y, r: r * 1.5 });
  }

  function renderStrip() {
    const seen = new Set();
    const items = [];
    for (let i = B.events.length - 1; i >= 0 && items.length < 10; i--) {
      const e = B.events[i];
      if (!e.frame || seen.has(e.frame)) continue;
      seen.add(e.frame);
      items.push(e);
    }
    const cur = selected();
    strip.replaceChildren(
      ...items.map((e) => {
        const f = B.frames.get(e.frame);
        if (!f) loadFrame(e.frame);
        return h(
          "button",
          { class: `bs-thumb${cur && cur.frame === e.frame ? " on" : ""}${e.ok ? "" : " bad"}`, type: "button", role: "listitem", title: `${hm(e.ts)} · ${e.agent} ${ACT[e.action]}`, onclick: () => select(e.key) },
          f && f.url ? h("img", { src: f.url, alt: "", draggable: "false" }) : h("span", { class: "bs-thumb-ph" }, hm(e.ts).slice(0, 5)),
          h("span", { class: "bs-thumb-who" }, e.agent)
        );
      })
    );
    strip.hidden = !items.length;
  }

  function renderLog() {
    const cur = selected();
    const rows = B.events.slice(-80).reverse();
    logHead.hidden = !rows.length;
    logEl.replaceChildren(
      ...rows.map((e) =>
        h(
          "button",
          { class: `bs-row${cur && cur.key === e.key ? " on" : ""}${e.ok ? "" : " bad"}`, type: "button", role: "listitem", onclick: () => select(e.key) },
          h("span", { class: "bs-row-time" }, hm(e.ts)),
          h("span", { class: "bs-row-what" }, h("b", null, e.agent), ` ${ACT[e.action]}`, e.app ? h("span", { class: "muted" }, ` · ${e.app}`) : null),
          h("span", { class: "bs-row-where" }, deviceLabel(e)),
          h("span", { class: `bs-row-ok ${e.ok ? "ok" : "bad"}`, title: e.error || null }, e.ok ? "✓" : "✗")
        )
      )
    );
  }

  function renderMsg() {
    msgEl.textContent = B.msg ? B.msg.text : "";
    msgEl.className = `bs-msg${B.msg ? (B.msg.ok ? " ok" : " bad") : ""}`;
  }

  function select(key) {
    B.sel = key;
    update();
  }

  function update() {
    if (SP) SP.kick(); // the space panel's view follows the stage while this tab is shown
    renderStatus();
    renderExplain();
    renderGrant();
    renderActions();
    renderMsg();
    renderViewer();
    viewer.hidden = !B.events.length && !(B.st && B.st.on); // off and nothing to show: the explanation is enough
    renderStrip();
    renderLog();
    if (B.st && B.st.ui && !B.uiDone) {
      B.uiDone = true; // fixture: open the consent sheet the scene asks for
      if (B.st.ui.sheet) openSheet(B.st.ui);
    }
  }

  // ---------------------------------------------------------------- actions
  async function doStop() {
    B.busy = "stop";
    update();
    try {
      B.st = await api.stop();
      B.msg = { ok: true, text: i18nText("U0768") };
    } catch (e) {
      B.msg = { ok: false, text: i18nText("U0769", { e: err(e) }) };
    } finally {
      B.busy = null;
      update();
    }
  }

  async function doResume() {
    B.busy = "resume";
    update();
    try {
      await deck.device.setHosting("desktop", true);
      B.st = await api.state();
      B.msg = { ok: true, text: i18nText("botscreen.resumed") };
    } catch (e) { B.msg = { ok: false, text: err(e) }; }
    finally { B.busy = null; update(); }
  }

  async function doLease(profile, hold) {
    if (!profile) return;
    B.busy = "lease";
    update();
    try {
      const r = await api.lease(profile, hold);
      B.msg = { ok: true, text: r.holder === "human" ? i18nText("U0770", { profile: nameOf(profile) }) : i18nText("A0333", { v: dative(nameOf(profile)) }) };
    } catch (e) {
      B.msg = { ok: false, text: i18nText("U0771", { e: err(e) }) };
    } finally {
      B.busy = null;
      update();
    }
  }

  // ---------------------------------------------------------------- consent sheet ("Agent'a ver")
  const sheetBack = h("div", { class: "bs-sheet-back", hidden: true });
  document.body.appendChild(sheetBack);
  sheetBack.addEventListener("mousedown", (e) => {
    if (e.target === sheetBack) closeSheet();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && B.sheet && !B.sheet.busy) closeSheet();
  });

  function openSheet(ui) {
    const st = B.st;
    const fromUi = ui && ui.sheet;
    const firstAllowed = st && st.agents[0];
    B.sheet = { step: "pick", loading: true, windows: [], note: null, error: null, pick: null, profile: (st && st.grant && st.grant.profile) || firstAllowed || null, foreground: false, busy: false };
    if (fromUi && ui.profile) B.sheet.profile = ui.profile;
    const sheet = B.sheet;
    renderSheet();
    const request = ui && ui.windows ? Promise.resolve(ui) : ui && ui.frontmost ? api.frontmost() : api.windows();
    request
      .then((r) => {
        if (B.sheet !== sheet) return;
        B.sheet.loading = false;
        B.sheet.windows = r.windows || [];
        B.sheet.note = r.note || null;
        if (ui && (ui.frontmost || ui.windows) && B.sheet.windows.length === 1 && !B.sheet.windows[0].blocked) {
          B.sheet.pick = B.sheet.windows[0].sourceId;
          B.sheet.step = "confirm";
        }
        if (fromUi && ui.pick && B.sheet.windows.some((w) => w.sourceId === ui.pick)) {
          B.sheet.pick = ui.pick;
          if (ui.sheet === "confirm") B.sheet.step = "confirm";
        }
        renderSheet();
      })
      .catch((e) => {
        if (B.sheet !== sheet) return;
        B.sheet.loading = false;
        B.sheet.error = err(e);
        renderSheet();
      });
  }

  function closeSheet() {
    if (!B.sheet) return;
    B.sheet = null;
    sheetBack.hidden = true;
    sheetBack.replaceChildren();
    api.pickerClosed().catch(() => {});
  }

  function pickedWindow() {
    return B.sheet && B.sheet.windows.find((w) => w.sourceId === B.sheet.pick);
  }

  async function confirm() {
    const s = B.sheet;
    const w = pickedWindow();
    if (!s || !w || !s.profile) return;
    s.busy = true;
    s.error = null;
    renderSheet();
    try {
      B.st = await api.grant({ profile: s.profile, agent: nameOf(s.profile), sourceId: w.sourceId, foreground: s.foreground });
      B.msg = { ok: true, text: i18nText("U0772", { profile: nameOf(s.profile), app: w.app, label: B.st.hotkey.label }) };
      closeSheet();
      update();
    } catch (e) {
      s.busy = false;
      s.error = err(e);
      renderSheet();
    }
  }

  function renderSheet() {
    const s = B.sheet;
    if (!s) return;
    const st = B.st || { agents: [], hotkey: { label: "" } };
    const close = h("button", { class: "bs-x", type: "button", "aria-label": i18nText("A0197"), onclick: closeSheet, disabled: s.busy ? true : null , "data-i18n-aria-label": "A0197"}, "×");
    const kids = [h("header", { class: "bs-sheet-head" }, h("h3", { id: "bs-sheet-title" }, i18nNode("A0327")), close)];
    if (s.step === "pick") {
      // The window picker and grant terms already explain this step.
      if (s.note) kids.push(h("p", { class: "bs-note" }, s.note));
      if (s.loading) kids.push(h("p", { class: "muted" }, i18nNode("U0774")));
      else if (s.error) kids.push(h("p", { class: "form-error" }, s.error));
      else if (!s.windows.length) kids.push(h("p", { class: "muted" }, i18nNode("U0775")));
      else
        kids.push(
          h(
            "div",
            { class: "bs-wins", role: "listbox", "aria-label": i18nText("A0334") , "data-i18n-aria-label": "A0334"},
            s.windows.map((w) =>
              h(
                "button",
                {
                  class: `bs-win${s.pick === w.sourceId ? " on" : ""}${w.blocked ? " blocked" : ""}`,
                  type: "button",
                  role: "option",
                  "aria-selected": s.pick === w.sourceId ? "true" : "false",
                  disabled: w.blocked ? true : null,
                  title: w.blocked || w.title,
                  onclick: () => {
                    s.pick = w.sourceId;
                    renderSheet();
                  },
                  ondblclick: () => {
                    if (w.blocked) return;
                    s.pick = w.sourceId;
                    s.step = "confirm";
                    renderSheet();
                  },
                },
                w.thumb ? h("img", { class: "bs-win-thumb", src: w.thumb, alt: "", draggable: "false" }) : h("span", { class: "bs-win-thumb ph" }, w.app),
                h("span", { class: "bs-win-app" }, w.app),
                h("span", { class: "bs-win-title" }, w.title),
                w.blocked ? h("span", { class: "bs-win-why" }, w.blocked) : null
              )
            )
          )
        );
      kids.push(
        h(
          "footer",
          { class: "bs-sheet-foot" },
          h("button", { class: "btn", type: "button", onclick: closeSheet }, i18nNode("U0451")),
          h(
            "button",
            {
              class: "btn primary",
              type: "button",
              disabled: pickedWindow() ? null : true,
              onclick: () => {
                s.step = "confirm";
                renderSheet();
              },
            },
            i18nNode("U0776")
          )
        )
      );
    } else {
      const w = pickedWindow();
      if (w && w.livePreview && !w.previewStarted) {
        w.previewStarted = true;
        api.preview(w.sourceId).then(thumb => {
          if (B.sheet !== s) return;
          w.thumb = thumb;
          renderSheet();
        }).catch(() => {
          if (B.sheet !== s) return;
          w.previewError = true;
          s.error = i18nText("frontmost.captureFailed");
          renderSheet();
        });
      }
      const allowed = st.agents || [];
      const who = s.profile ? nameOf(s.profile) : i18nText("A0185");
      kids.push(
        h(
          "div",
          { class: "bs-pick-sum" },
          w && w.thumb ? h("img", { src: w.thumb, alt: "", draggable: "false" }) : null,
          h("div", null, h("div", { class: "bs-kv" }, h("span", null, i18nNode("A0089")), h("b", null, w ? w.app : "?")), h("div", { class: "bs-kv" }, h("span", null, i18nNode("A0335")), h("span", { class: "bs-kv-title" }, w ? w.title : "?")))
        )
      );
      kids.push(h("p", { class: "flabel bs-sheet-label" }, i18nNode("A0337")));
      if (!allowed.length) kids.push(h("p", { class: "form-error" }, i18nNode("A0338")));
      else
        kids.push(
          h(
            "div",
            { class: "bs-agents", role: "radiogroup", "aria-label": i18nText("A0185") , "data-i18n-aria-label": "A0185"},
            allowed.map((p) =>
              h(
                "label",
                { class: `bs-agent${s.profile === p ? " on" : ""}` },
                h("input", {
                  type: "radio",
                  name: "bs-agent",
                  value: p,
                  checked: s.profile === p ? true : null,
                  onchange: () => {
                    s.profile = p;
                    renderSheet();
                  },
                }),
                h("span", { class: "bs-agent-name" }, nameOf(p)),
                h("span", { class: "bs-agent-prof" }, p)
              )
            )
          )
        );
      kids.push(
        h(
          "div",
          { class: "bs-terms" },
          h("p", null, h("b", null, who), i18nNode("U0777", { v: w ? w.app : i18nText("common.this") })),
          h(
            "ul",
            null,
            h("li", null, i18nNode("U0778")),
            h("li", null, h("b", null, i18nNode("A0339")), "; ", h("b", null, i18nNode("U0779")), "."),
            h("li", null, i18nNode("U0780")),
            h("li", null, i18nNode("U0781", { label: st.hotkey.label }))
          )
        )
      );
      kids.push(h("label", { class: "bs-agent" },
        h("input", { type: "checkbox", checked: s.foreground ? true : null, disabled: s.busy ? true : null,
          "aria-describedby": "bs-foreground-help", onchange: (e) => { s.foreground = e.target.checked; } }),
        h("span", null, i18nNode("botscreen.foreground"))));
      kids.push(h("p", { id: "bs-foreground-help", class: "bs-note" }, i18nNode("botscreen.foregroundHelp")));
      if (/^(excel|winword|powerpnt|outlook)\.exe$/i.test(String(w?.executable || "").split(/[\\/]/).pop())) {
        kids.push(h("p", { class: "bs-note" }, i18nNode("botscreen.officeForegroundNote")));
      }
      if (s.error) kids.push(h("p", { class: "form-error", role: "alert" }, s.error));
      kids.push(
        h(
          "footer",
          { class: "bs-sheet-foot" },
          h(
            "button",
            {
              class: "btn",
              type: "button",
              disabled: s.busy ? true : null,
              onclick: () => {
                s.step = "pick";
                s.error = null;
                renderSheet();
              },
            },
            i18nNode("A0340")
          ),
          h("button", { class: "btn", type: "button", disabled: s.busy ? true : null, onclick: closeSheet }, i18nNode("U0451")),
          h("button", { class: "btn primary", type: "button", disabled: s.busy || !w || (w.livePreview && !w.thumb) || !s.profile || !allowed.includes(s.profile) ? true : null, onclick: confirm }, s.busy ? i18nNode("A0341") : i18nNode("common.handTo", { who: dative(who) }))
        )
      );
    }
    sheetBack.replaceChildren(h("div", { class: "bs-sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "bs-sheet-title" }, ...kids));
    sheetBack.hidden = false;
  }

  // ---------------------------------------------------------------- Settings → Bu cihaz
  /** Rows for the Settings tab's "Bu cihaz" section: the "desktop" switch, allowed agents, driver, device key. */
  function settingsRows() {
    const st = B.st;
    if (!st) return [h("p", { class: "muted small" }, i18nNode("U0782"))];
    const rows = [];
    const say = (ok, text) => ctx.settingsMessage && ctx.settingsMessage(ok, text);

    const box = h("input", { type: "checkbox", role: "switch", id: "s-host-desktop", checked: st.on ? true : null, disabled: st.supported ? null : true, dataset: { fk: "bs:desktop" } });
    box.addEventListener("change", async () => {
      const on = box.checked;
      box.disabled = true;
      try {
        await deck.device.setHosting("desktop", on);
        B.st = await api.state();
        say(true, on ? i18nText("U0783") : i18nText("U0784"));
      } catch (e) {
        box.checked = !on;
        say(false, i18nText("common.saveFailed", { e: err(e) }));
      } finally {
        box.disabled = false;
      }
    });
    rows.push(
      h(
        "label",
        { class: "toggle bs-toggle", for: "s-host-desktop", id: "s-device-desktop", title: i18nText("U0786") },
        box,
        h("span", { class: "sw", "aria-hidden": "true" }),
        h("span", { class: "tbody" }, h("span", { class: "tlabel" }, i18nNode("U0785"), h("span", { class: "sv-note", "aria-live": "polite" })))
      )
    );
    if (!st.supported) rows.push(h("p", { class: "form-error" }, i18nNode("U0753")));
    if (st.paused) rows.push(h("p", { class: "bs-paused small" }, i18nNode("U0787", { at: hm(st.paused.at) })));

    // allowed agents
    const known = agents();
    const profiles = [...new Set([...known.map((a) => a.profile), ...st.agents])];
    rows.push(h("p", { class: "flabel bs-set-label" }, i18nNode("U0788")));
    if (!profiles.length) rows.push(h("p", { class: "muted small" }, i18nNode("U0789")));
    else
      rows.push(
        h(
          "div",
          { class: "bs-allow" },
          profiles.map((p) => {
            const c = h("input", { type: "checkbox", id: `s-bs-agent-${p}`, checked: st.agents.includes(p) ? true : null, dataset: { fk: `bs:agent:${p}` } });
            c.addEventListener("change", async () => {
              const next = c.checked ? [...st.agents, p] : st.agents.filter((x) => x !== p);
              try {
                B.st = await api.setAgents(next);
                say(true, c.checked ? i18nText("U0790", { p: nameOf(p) }) : i18nText("U0791", { p: nameOf(p) }));
              } catch (e) {
                say(false, i18nText("common.saveFailed", { e: err(e) }));
              }
            });
            return h("label", { class: "bs-allow-row", for: `s-bs-agent-${p}` }, c, h("span", null, nameOf(p)), h("span", { class: "bs-agent-prof" }, p));
          })
        )
      );

    // driver
    rows.push(h("p", { class: "flabel bs-set-label" }, i18nNode("U0792")));
    const d = st.driver;
    const inst = st.install;
    if (inst && !["done", "error"].includes(inst.phase)) {
      const pct = inst.total ? Math.round((100 * (inst.got || 0)) / inst.total) : 0;
      const label = inst.phase === "download" ? i18nText("U0793", { pct: pct }) : inst.phase === "verify" ? i18nText("U0794") : i18nText("U0795");
      rows.push(h("div", { class: "bs-progress" }, h("span", { class: "bar" }, h("i", { style: { width: `${inst.phase === "download" ? pct : 100}%` } })), h("span", { class: "small" }, label)));
    } else if (d.status === "installed") {
      rows.push(h("p", { class: "small bs-ok" }, i18nNode("U0796", { v: d.version || "", v2: d.source === "system" ? i18nText("A0344") : "" })));
      if (st.platform === "darwin")
        rows.push(
          h(
            "div",
            { class: "form-actions" },
            h(
              "button",
              {
                class: "btn",
                type: "button",
                onclick: async () => {
                  try {
                    await api.macPermissions();
                    say(true, i18nText("U0797"));
                  } catch (e) {
                    say(false, err(e));
                  }
                },
              },
              i18nNode("U0798")
            )
          )
        );
    } else {
      if (d.status === "error") rows.push(h("p", { class: "form-error" }, i18nNode("U0799", { v: d.error || i18nText("A0020") })));
      else if (d.status === "missing") rows.push(h("p", { class: "muted small" }, i18nNode("U0800")));
      if (inst && inst.phase === "error") rows.push(h("p", { class: "form-error" }, i18nNode("U0801", { error: inst.error })));
      const pin = st.pin;
      if (!pin || !pin.available) rows.push(h("p", { class: "muted small" }, (pin && pin.reason) || i18nNode("U0176")));
      else if (!B.installArmed)
        rows.push(
          h(
            "div",
            { class: "form-actions" },
            h(
              "button",
              {
                class: "btn",
                type: "button",
                onclick: () => {
                  B.installArmed = true;
                  if (ctx.rebuildSettings) ctx.rebuildSettings();
                },
              },
              i18nNode("U0802")
            )
          )
        );
      else {
        rows.push(
          h(
            "div",
            { class: "bs-confirm" },
            h("p", null, h("b", null, `cua-driver ${pin.version}`), i18nNode("A0345", { size: mb(pin.size), host: pin.host })),
            h("p", { class: "small muted" }, i18nNode("U0803")),
            h(
              "div",
              { class: "form-actions" },
              h(
                "button",
                {
                  class: "btn primary",
                  type: "button",
                  onclick: async () => {
                    B.installArmed = false;
                    try {
                      B.st = await api.install();
                      say(true, i18nText("U0804"));
                    } catch (e) {
                      say(false, i18nText("U0805", { e: err(e) }));
                    }
                  },
                },
                i18nNode("A0346")
              ),
              h(
                "button",
                {
                  class: "btn",
                  type: "button",
                  onclick: () => {
                    B.installArmed = false;
                    if (ctx.rebuildSettings) ctx.rebuildSettings();
                  },
                },
                i18nNode("U0451")
              )
            )
          )
        );
      }
    }

    // device key for the relay's driver channel
    const key = h("input", { id: "s-bs-token", type: "password", autocomplete: "off", placeholder: st.hasToken ? i18nText("U0485") : i18nText("U0806") });
    rows.push(
      h(
        "label",
        { class: "field", for: "s-bs-token", title: i18nText("set.deviceKeyTip") },
        h("span", { class: "flabel" }, i18nNode("U0807")),
        key
      )
    );
    key.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        key.closest(".sv-legacy, .pane, body").querySelector('[data-fk="bs:token-save"]').click();
      }
    });
    rows.push(
      h(
        "div",
        { class: "form-actions" },
        h(
          "button",
          {
            class: "btn",
            type: "button",
            dataset: { fk: "bs:token-save" },
            onclick: async () => {
              try {
                B.st = await api.saveToken(key.value);
                key.value = "";
                say(true, i18nText("U0809"));
              } catch (e) {
                say(false, i18nText("common.saveFailed", { e: err(e) }));
              }
            },
          },
          i18nNode("U0810")
        )
      )
    );

    // what is live right now
    const l = st.link || {};
    const linkText = !st.on
      ? i18nText("U0811")
      : l.status === "ready"
        ? i18nText("U0812")
        : l.status === "hello"
          ? i18nText("U0813")
          : l.status === "refused"
            ? i18nText("U0814", { v: l.error ? `: ${l.error}` : "" })
            : i18nText("U0815", { v: l.error ? ` (${l.error})` : "" });
    const hk = st.hotkey.registered === true ? i18nText("U0816") : st.hotkey.registered === false ? i18nText("U0817") : i18nText("U0818");
    rows.push(
      h(
        "div",
        { class: "bs-live-lines small" },
        h("div", null, h("span", { class: "muted" }, i18nNode("U0819")), h("span", { class: l.status === "ready" ? "bs-ok" : st.on ? "bs-warn" : "muted" }, linkText)),
        h("div", null, h("span", { class: "muted" }, i18nNode("U0820", { label: st.hotkey.label })), h("span", { class: st.hotkey.registered === false ? "bs-warn" : st.hotkey.registered ? "bs-ok" : "muted" }, hk))
      )
    );
    return rows;
  }

  // ---------------------------------------------------------------- state from main
  function applyState(s) {
    if (!s || typeof s !== "object") return;
    if (!B.st && s.ui && s.ui.installArmed) B.installArmed = true; // fixture scene: the install confirmation
    B.st = s;
    if (root.isConnected) update();
    if (B.sheet) renderSheet();
  }
  api.onEvent((m) => {
    if (m && m.t === "open-screen" && ctx.openScreen) {
      ctx.openScreen(); // desktop or approval notification
      if (m.profile && m.approval && SP) SP.focusApproval(m.profile, m.approval);
    }
    if (m && m.t === "frontmost") openSheet(m);
    else if (m && m.t === "frontmost-error") {
      B.msg = { ok: false, text: m.error };
      if (ctx.openScreen) ctx.openScreen();
      if (root.isConnected) update();
    }
    if (m && m.t === "state") {
      const before = B.st ? JSON.stringify([B.st.on, B.st.driver, B.st.install, B.st.link, B.st.hotkey, B.st.agents, B.st.hasToken, B.st.paused]) : "";
      applyState(m.state);
      const after = JSON.stringify([m.state.on, m.state.driver, m.state.install, m.state.link, m.state.hotkey, m.state.agents, m.state.hasToken, m.state.paused]);
      if (before !== after && ctx.refreshSettings) ctx.refreshSettings();
    }
  });
  api
    .state()
    .then((s) => {
      applyState(s);
      if (ctx.refreshSettings) ctx.refreshSettings();
    })
    .catch(() => {});
  // "time left" and "last action" age without a state push
  setInterval(() => {
    if (root.isConnected && B.st && B.st.grant) renderGrant();
  }, 15000);

  document.addEventListener("deck-language", () => { if (root.isConnected) update(); if (B.sheet) renderSheet(); });
  // state: the last device state from main (null until it arrives); app.js shows the Bot screen tab only while on
  // the Bot screen tab also shows while the relay has an agent space to watch
  return { root, update, settingsRows,
    state: () => (B.st && SP && SP.available() ? { ...B.st, spaces: true } : B.st),
    live: profile => !!((SP && SP.live(profile)) || window.DeckWsView.screenLive(B.st, profile)),
    selectProfile: profile => { if (SP) SP.setAgent(profile); },
  };
};
