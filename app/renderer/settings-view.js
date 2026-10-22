"use strict";
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
// Settings: a full view over the chat column (like the All sessions browser), opened from the top bar's gear or
// Ctrl+, . A section list on the left, one section on the right. Sections are built the first time they are shown
// and kept in the DOM (each scrolls on its own, so its scroll position survives switching). A section is never
// rebuilt under the user's typing: refresh() marks it stale and it is rebuilt when it is next shown or refreshed.
// Switches and selects save at once and show a short inline "Saved" next to their label; text fields with secrets
// keep one explicit Save per group. Pure helpers at the top are exported for test/settings-view.test.js.
(() => {
  // ---------------------------------------------------------------- pure helpers
  const SECTIONS = ["general", "hermes", "hermescfg", "relay", "telegram", "desktop", "device"];
  const BUSY_SEND = ["queue", "steer"];
  // notification sounds: main/sounds.js PRESETS / DEFAULTS and renderer/chime.js TUNES (test/sounds.test.js keeps them equal)
  const SOUND_PRESETS = ["bell", "rise", "chord", "pop", "marimba", "glass", "knock", "tick", "alert"];
  const SOUND_DEFAULTS = { volume: 80, events: { reply: "preset:bell", done: "preset:chord", approval: "preset:rise", question: "preset:rise", subagent: "preset:tick" } };
  const SOUND_OWN_RE = /^[a-f0-9]{16}\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|webm)$/;
  /** The sounds setting from a settings snapshot: {volume: 0..100, events: {<event>: "preset:<id>" | "" | stored name}}. */
  function soundsOf(settings) {
    const s = settings && settings.sounds && typeof settings.sounds === "object" ? settings.sounds : {};
    const ev = s.events && typeof s.events === "object" ? s.events : {};
    const ok = (v) => v === "" || SOUND_OWN_RE.test(v) || (typeof v === "string" && v.startsWith("preset:") && SOUND_PRESETS.includes(v.slice(7)));
    return {
      volume: Number.isInteger(s.volume) && s.volume >= 0 && s.volume <= 100 ? s.volume : SOUND_DEFAULTS.volume,
      events: Object.fromEntries(Object.entries(SOUND_DEFAULTS.events).map(([k, d]) => [k, typeof ev[k] === "string" && ok(ev[k]) ? ev[k] : d])),
    };
  }

  /** Keep the stored spelling, matching Telegram usernames without case or a leading @. */
  function hiddenBotsWith(list, username) {
    const seen = new Set();
    const merged = [...(list || []), username].map((v) => String(v || "").trim().replace(/^@/, "")).filter((v) => {
      const key = v.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (merged.length > 50) throw new Error(i18nText("hiddenBots.limit"));
    return merged;
  }

  /** The right-panel Bot screen tab exists while desktop control is on (or paused by Stop, so Resume stays near). */
  // the Bot screen tab: desktop control on (or paused), or an agent space on the relay to watch
  const screenTabVisible = (st, current) => (st ? !!(st.on || st.paused || st.spaces) : current === "screen");

  /** The tab to show: "settings" is no longer a tab, and a hidden Bot screen tab falls back to Activity. */
  function tabFor(tab, st) {
    if (tab === "settings" || !tab) return "activity";
    if (tab === "screen" && !screenTabVisible(st, tab)) return "activity";
    return tab;
  }

  const busySendOf = (settings) => (settings && settings.composer && BUSY_SEND.includes(settings.composer.busySend) ? settings.composer.busySend : "queue");
  const sectionOf = (id) => (SECTIONS.includes(id) ? id : "general");
  /** A byte count for people: "1.2 GB", "487 MB"; "?" when unknown. */
  const sizeText = (b) => (!Number.isFinite(b) || b < 0 ? "?" : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
  const DOCKER_URL = "https://www.docker.com/products/docker-desktop/";

  /**
   * Host version lines for one Settings section ("relay" | "hermes") from main/host-versions.js state():
   * [{key, vars, level: "block"|"warn"|"ok"|"info", cmd?}]. Drift (a relay or plugin older than this app) is a
   * warning with the update command; a protocol mismatch blocks that connection; version-only drift never blocks.
   */
  function hostLines(state, section) {
    const s = state && typeof state === "object" ? state : null;
    if (!s) return [];
    const out = [];
    const cmd = s.commands || {};
    if (section === "relay" && s.relay) {
      const r = s.relay;
      if (r.mismatch) out.push({ key: "hostupd.protocolRelay", vars: { theirs: r.protocol, ours: s.protocol }, level: "block", cmd: cmd.relay });
      else if (r.older) out.push({ key: "hostupd.relayOlder", vars: { relay: r.version, app: s.app }, level: "warn", cmd: cmd.relay });
      else out.push({ key: "hostupd.relayVersion", vars: { relay: r.version }, level: "ok" });
    }
    // plugin rows (per profile from the relay, and the direct connection's own) live under Settings › Hermes
    for (const p of section === "hermes" && Array.isArray(s.plugins) ? s.plugins : []) {
      if (p.source === "bridge" && p.mismatch) out.push({ key: "hostupd.protocolBridge", vars: { theirs: p.protocol, ours: s.protocol }, level: "block", cmd: cmd.plugin });
      else if (p.source === "bridge" && p.legacy) out.push({ key: "hostupd.bridgeLegacy", vars: { app: s.app }, level: "warn", cmd: cmd.plugin });
      else if (p.older) out.push({ key: p.source === "bridge" ? "hostupd.bridgeOlder" : "hostupd.pluginOlder", vars: { profile: p.profile, plugin: p.version, app: s.app }, level: "warn", cmd: cmd.plugin });
      else if (p.version) out.push({ key: p.source === "bridge" ? "hostupd.bridgeVersion" : "hostupd.pluginVersion", vars: { profile: p.profile, plugin: p.version }, level: "ok" });
      else if (p.source === "relay") out.push({ key: "hostupd.pluginUnknown", vars: { profile: p.profile }, level: "info" });
    }
    return out;
  }

  /** The blocking banner text keys for the connections whose protocol differs (empty: nothing blocks). */
  function hostBanners(state) {
    const s = state && typeof state === "object" ? state : null;
    const b = (s && s.blocked) || {};
    return [b.relay ? "hostupd.bannerRelay" : null, b.bridge ? "hostupd.bannerBridge" : null].filter(Boolean);
  }

  /** Saved config is not evidence of a live connection. Inactive relay clients are not watched. */
  function connectionState(configured, status) {
    if (!configured) return "unconfigured";
    if (status === "open") return "open";
    if (["starting", "connecting"].includes(status)) return "connecting";
    if (["offline", "setup", "closed", "error", "protocol"].includes(status)) return "offline";
    return "saved";
  }

  // ---------------------------------------------------------------- the view
  function create(ctx) {
    const { h } = ctx;
    const node = (key, vars) => window.DeckI18n.node(key, vars, document);
    const V = { open: false, section: sectionOf(ctx.store && ctx.store.get("deck.settingsSection")), built: new Map(), stale: new Set() };
    let root = null;
    let nav = null;
    let main = null;
    let last = null; // {id, fk, idx, section}: the control the user changed last (its row gets the "Saved" note)
    let noteTimer = 0;

    const NS = "http://www.w3.org/2000/svg";
    const ICONS = {
      general: "M3 4.5h10M3 8h10M3 11.5h10M6 3v3M10 6.5v3M5.5 10v3",
      hermes: "M6.5 9.5l3-3M5 7.5L3.8 8.7a2.3 2.3 0 0 0 3.3 3.3L8.3 10.8M11 8.5l1.2-1.2a2.3 2.3 0 0 0-3.3-3.3L7.7 5.2",
      hermescfg: "M3 4h6M12 4h1M3 8h1M7 8h6M3 12h6M12 12h1M10.5 2.8v2.4M5.5 6.8v2.4M10.5 10.8v2.4",
      relay: "M8 9.5v4M5.5 13.5h5M5.2 7.2a3.9 3.9 0 0 1 5.6 0M3.3 5.3a6.6 6.6 0 0 1 9.4 0M8 9.5a.6.6 0 1 0 0-.01",
      telegram: "M13.5 3L2.5 7.4l4 1.4M13.5 3l-2 10-5-4.2M13.5 3L6.5 8.8v3.7l2-2",
      desktop: "M2.5 3.5h11v7.5h-11zM6 13.5h4M8 11v2.5",
      device: "M4.5 4.5h7v7h-7zM6.5 2v2.5M9.5 2v2.5M6.5 11.5V14M9.5 11.5V14M2 6.5h2.5M2 9.5h2.5M11.5 6.5H14M11.5 9.5H14",
      gear: "M6.88 3.33L7.13 1.56L8.87 1.56L9.12 3.33L10.51 3.91L11.94 2.83L13.17 4.06L12.09 5.49L12.67 6.88L14.44 7.13L14.44 8.87L12.67 9.12L12.09 10.51L13.17 11.94L11.94 13.17L10.51 12.09L9.12 12.67L8.87 14.44L7.13 14.44L6.88 12.67L5.49 12.09L4.06 13.17L2.83 11.94L3.91 10.51L3.33 9.12L1.56 8.87L1.56 7.13L3.33 6.88L3.91 5.49L2.83 4.06L4.06 2.83L5.49 3.91ZM8 6a2 2 0 1 0 0 4a2 2 0 1 0 0-4z",
    };
    function icon(name, size = 16) {
      const s = document.createElementNS(NS, "svg");
      for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": "1.4", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) s.setAttribute(k, String(v));
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", ICONS[name] || "");
      s.appendChild(p);
      return s;
    }
    const LABEL = { general: "set.general", hermes: "set.hermes", hermescfg: "set.hermesConfig", relay: "set.relay", telegram: "set.telegram", desktop: "U0545", device: "A0241" };

    // ------------------------------------------------------------ row helpers (used by the section builders)
    const note = () => h("span", { class: "sv-note", "aria-live": "polite" });
    /** A group of rows with an optional short name above it. */
    const group = (title, ...rows) => h("div", { class: "sv-group-wrap" }, title ? h("h3", { class: "sv-group-title" }, title, note()) : null, h("div", { class: "sv-group" }, ...rows));
    /** Label left, control(s) right. */
    const row = (label, control, { id = null, title = null, cls = "" } = {}) =>
      h("div", { class: `sv-row${cls ? ` ${cls}` : ""}`, title }, h(id ? "label" : "span", { class: "sv-label", for: id }, label, note()), h("div", { class: "sv-ctl" }, control));
    /** A switch row in the shared .toggle markup; it saves at once through `change`. */
    const switchRow = (id, label, checked, change, { disabled = false, title = null, fk = null } = {}) =>
      h("label", { class: "toggle sv-row sv-switch", for: id, title },
        h("input", { id, type: "checkbox", role: "switch", checked: checked ? true : null, disabled: disabled ? true : null, dataset: { fk: fk || id }, onchange: (e) => change(e.target.checked, e) }),
        h("span", { class: "sw", "aria-hidden": "true" }),
        h("span", { class: "tbody" }, h("span", { class: "tlabel" }, label, note())));
    /** A segmented control: [[value, label, title]]. */
    const segmented = (id, value, items, change) =>
      h("span", { class: "chan sv-seg", role: "group", id },
        ...items.map(([v, label, title]) => h("button", { type: "button", "aria-pressed": v === value ? "true" : "false", title, dataset: { fk: `${id}:${v}` }, onclick: (e) => {
          if (v === value) return;
          for (const b of e.currentTarget.parentNode.children) b.setAttribute("aria-pressed", b === e.currentTarget ? "true" : "false");
          value = v;
          change(v);
        } }, label)));
    const helpers = { h, node, group, row, switchRow, segmented, icon, note };

    // ------------------------------------------------------------ shell
    function build() {
      const back = h("button", { class: "linkbtn sb-back", type: "button", dataset: { fk: "sv-back" }, onclick: () => close() }, "‹ ", node("set.back"));
      const head = h("header", { class: "sb-head sv-head" }, back, h("h2", { class: "sb-title", id: "sv-title" }, node("A0231")), h("span", { class: "sb-grow" }), note());
      nav = h("nav", { class: "sv-nav", "aria-label": i18nText("set.nav") });
      main = h("div", { class: "sv-main" });
      const next = h("section", { class: "sv", role: "region", "aria-labelledby": "sv-title", hidden: !V.open, dataset: { fk: "sv" } }, head, h("div", { class: "sv-body" }, nav, main));
      next.addEventListener("keydown", onKey);
      // remember the control a change came from: its row shows the "Saved" note after the save returns
      for (const type of ["change", "click"]) next.addEventListener(type, (e) => {
        const el = e.target.closest && e.target.closest("input, select, button, textarea");
        if (el && main.contains(el)) last = keyOf(el);
      }, true);
      if (root && root.parentNode) root.replaceWith(next);
      root = next;
      V.built.clear();
      V.stale.clear();
      navSig = null;
      renderNav();
    }

    let navSig = null;
    function renderNav() {
      const sig = SECTIONS.filter((id) => !ctx.hasSection || ctx.hasSection(id)).join();
      if (sig === navSig) return; // unchanged: keep the buttons (and keyboard focus on them)
      navSig = sig;
      nav.replaceChildren(...SECTIONS.filter((id) => !ctx.hasSection || ctx.hasSection(id)).map((id) =>
        h("button", { class: "sv-nav-item", type: "button", "aria-current": id === V.section ? "page" : null, dataset: { fk: `sv-nav:${id}` }, onclick: () => show(id) },
          icon(id), h("span", null, node(LABEL[id])))));
    }

    function onKey(e) {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".ctx")) {
        e.preventDefault();
        close();
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.target.classList && e.target.classList.contains("sv-nav-item")) {
        e.preventDefault();
        const items = [...nav.querySelectorAll(".sv-nav-item")];
        const i = items.indexOf(e.target) + (e.key === "ArrowDown" ? 1 : -1);
        const to = items[(i + items.length) % items.length];
        to.focus();
        show(to.dataset.fk.slice(7));
      }
    }

    // ------------------------------------------------------------ sections
    const BUILDERS = {}; // one per section; each pushes its groups into `kids`
    const st = () => ctx.settings() || {};
    const T = (key, vars) => i18nText(key, vars);
    let hiddenBotsSave = Promise.resolve();
    // Reconnects can delay save replies; merge each action only after the previous one settles.
    function updateHiddenBots(username, hide = true) {
      const next = hiddenBotsSave.then(() => ctx.save({ hiddenBots: hide
        ? hiddenBotsWith(st().hiddenBots, username)
        : (st().hiddenBots || []).filter((v) => v.toLowerCase() !== username.toLowerCase()) }, T("U0492")));
      hiddenBotsSave = next.catch(() => {});
      return next;
    }
    const input = (id, attrs = {}) => h("input", { id, autocomplete: "off", spellcheck: "false", ...attrs });
    const secretWarning = () => (st().plainSecrets ? h("p", { class: "form-error sv-warn" }, node("U0499")) : null);
    /**
     * Host versions for this section (hostLines), each line with the update command to copy; with a relay that offers
     * host updates (state.update), the Update button and its progress (Settings › Relay) and one row per gateway that
     * waits for a restart, with Restart now (Settings › Hermes). docs/updating.md, Updating from the app.
     */
    function hostGroup(section) {
      const state = ctx.hostVersions ? ctx.hostVersions() : null;
      const lines = hostLines(state, section);
      const u = state && state.update;
      const restarts = section === "hermes" && u && Array.isArray(u.restarts) ? u.restarts : [];
      const queueError = section === "hermes" && u && u.queueError ? u.queueError : null;
      // the button only for what the relay updates: the relay itself, a relay-reported plugin, or a plugin step to finish
      const st = u && u.status;
      const running = !!st && !UPDATE_FINAL.includes(st.state);
      const relayBehind = !!(state && state.relay && state.relay.older);
      const pluginBehind = !!(state && Array.isArray(state.plugins) && state.plugins.some((p) => p.source === "relay" && p.older));
      // a plugin install that stopped half way leaves pending queue entries: the relay finishes it on the next update
      const pendingRecovery = !running && !!u && Array.isArray(u.restarts) && u.restarts.some((r) => r && r.state === "pending");
      const recover = (!!st && st.state === "plugin-failed") || pendingRecovery;
      const eligible = relayBehind || pluginBehind || running || recover;
      const canUpdate = !!(u && ctx.deck && ctx.deck.hostUpdate);
      const showUpdate = canUpdate && (section === "relay" ? eligible || !!st : pluginBehind || recover);
      if (!lines.length && !restarts.length && !showUpdate && !queueError) return null;
      const rows = lines.map((l) => h("div", { class: "sv-row sv-block" },
        h("p", { class: `hostver ${l.level}`, role: l.level === "block" ? "alert" : "status" }, T(l.key, l.vars)),
        l.cmd ? h("p", { class: "hostver-cmd" }, T("hostupd.runOnHost"), " ", h("code", { class: "sv-path" }, l.cmd)) : null));
      if (showUpdate) rows.push(updateRow(state, eligible));
      if (queueError) rows.push(h("div", { class: "sv-row sv-block" }, h("p", { class: "hostver warn", role: "status" }, T("hostupd.queueError", { error: queueError }))));
      for (const r of restarts) rows.push(restartRow(r));
      return group(node("hostupd.group"), ...rows);
    }

    const UPDATE_STEPS = ["adopt", "download", "verify", "install", "switch", "health", "plugin"];
    const UPDATE_FINAL = ["done", "failed", "rolled-back", "plugin-failed"];
    function statusText(st) {
      const v = { version: st.version || "", from: st.from || "", step: st.step || "", error: st.error || "" };
      if (st.state === "done") return T("hostupd.done", v);
      if (st.state === "rolled-back") return T("hostupd.rolledBack", v);
      if (st.state === "plugin-failed") return T("hostupd.pluginFailed", v);
      if (st.state === "failed") return T("hostupd.failed", v);
      return T(`hostupd.step.${UPDATE_STEPS.includes(st.step) ? st.step : "starting"}`, v);
    }

    function updateRow(state, eligible) {
      const u = state.update;
      const st = u.status;
      const running = !!st && !UPDATE_FINAL.includes(st.state);
      // adopt: a relay running from a checkout moves itself to an install root; an older relay cannot (needInit)
      const blocked = !u.remote || !u.remote.enabled || !(u.remote.managed || u.remote.adopt);
      const label = st && UPDATE_FINAL.includes(st.state) && st.state !== "done" && !(state.relay && state.relay.older) ? "hostupd.tryAgain" : "hostupd.update";
      const btn = h("button", { class: "btn mini", type: "button", title: T("hostupd.updateHelp"), disabled: running || blocked ? true : null, dataset: { fk: "hostupd:update" },
        onclick: async () => {
          const r = await ctx.deck.hostUpdate.update();
          refresh({ force: true }); // rebuild first: a note written before the rebuild would be swept away with it
          if (r && r.ok === false) notify(false, String(r.error || "").startsWith("hostupd.") ? T(r.error) : T("hostupd.startFailed", { error: r.error || "" }));
        } }, node(label, { app: state.app }));
      return h("div", { class: "sv-row sv-block" },
        st ? h("p", { class: `hostver hostver-step ${st.state === "done" ? "ok" : running ? "info" : "warn"}`, role: "status" }, statusText(st)) : null,
        u.remote && !u.remote.enabled ? h("p", { class: "hostver warn" }, T("hostupd.remoteOff")) : null,
        u.remote && u.remote.enabled && !u.remote.managed && u.remote.adopt && state.relay && state.relay.older && !running ? h("p", { class: "hostver-cmd" }, T("hostupd.willAdopt")) : null,
        u.remote && u.remote.enabled && !u.remote.managed && !u.remote.adopt ? h("p", { class: "hostver-cmd" }, T("hostupd.needInit"), " ", h("code", { class: "sv-path" }, "git pull && cd relay && npm ci --omit=dev")) : null,
        eligible ? h("div", { class: "sv-end" }, btn) : null); // a finished update on a current host shows only its result
    }

    const RESTART_STATES = ["waiting", "busy", "unknown", "pending", "restarting", "restarted", "failed"];
    function restartRow(r) {
      const state = RESTART_STATES.includes(r.state) ? r.state : "waiting";
      const canNow = ["waiting", "busy", "unknown", "failed"].includes(state);
      return h("div", { class: "sv-row sv-block" },
        h("p", { class: `hostver ${state === "restarted" ? "ok" : state === "failed" ? "warn" : "info"}`, role: "status" }, T(`hostupd.row.${state}`, { profile: r.profile, error: r.error || "" })),
        r.longWait ? h("p", { class: "hostver warn" }, T("hostupd.row.longWait", { profile: r.profile })) : null,
        canNow ? h("div", { class: "sv-end" }, h("button", { class: "btn mini", type: "button", dataset: { fk: `hostupd:restart:${r.profile}` },
          onclick: async () => {
            const sure = ctx.confirm
              ? await ctx.confirm({ title: T("hostupd.restartNow"), body: T("hostupd.restartConfirm", { profile: r.profile }), ok: T("hostupd.restartNow") })
              : window.confirm(T("hostupd.restartConfirm", { profile: r.profile }));
            if (!sure) return;
            const res = await ctx.deck.hostUpdate.restart(r.profile);
            refresh({ force: true });
            if (res && res.ok === false) notify(false, T("hostupd.row.failed", { profile: r.profile, error: res.error || "" }));
          } }, node("hostupd.restartNow"))) : null);
    }

    BUILDERS.general = (kids) => {
      const s = st();
      const lang = h("select", { id: "s-language", onchange: (e) => ctx.save({ language: e.target.value }, T("settings.languageSaved")) },
        [["en", "English"], ["tr", "Türkçe"]].map(([v, label]) => h("option", { value: v, selected: v === (s.language || "en") ? true : null }, label)));
      const busy = segmented("s-busy-send", busySendOf(s), [
        ["queue", T("set.busyQueue"), T("set.busyQueueTip")],
        ["steer", T("set.busySteer"), T("set.busySteerTip")],
      ], (v) => ctx.save({ composer: { busySend: v } }, T("set.saved")));
      busy.setAttribute("aria-label", T("set.busySend"));
      kids.push(group(null, row(node("settings.language"), lang, { id: "s-language" }), row(node("set.busySend"), busy)));
      // chat modes: the shared editor (first run uses it too); every change saves at once
      const CM = ctx.CM;
      const draft = { modes: [...CM.enabled(s.chat)], defaultMode: CM.start(s.chat) };
      const editor = CM.editor(h, draft);
      editor.addEventListener("change", () => setTimeout(() => {
        const now = ctx.settings() && ctx.settings().chat;
        if (JSON.stringify([...draft.modes].sort()) === JSON.stringify([...CM.enabled(now)].sort()) && draft.defaultMode === CM.start(now)) return;
        ctx.saveChat({ modes: [...draft.modes], defaultMode: draft.defaultMode });
      }, 0));
      kids.push(group(node("chat.modes"), h("div", { class: "sv-row sv-block" }, editor)));
      // downloads
      const dl = s.downloads || { dir: "", ask: false };
      const folder = h("span", { class: "sv-path", id: "s-download-dir", title: dl.dir || T("download.folderDefault") }, dl.dir || T("set.downloadsDefault"));
      const pick = h("button", { class: "btn mini", type: "button", dataset: { fk: "dl:pick" }, onclick: () => ctx.saveCall(() => ctx.deck.bridge.file.pickFolder(), T("download.folderSaved")) }, node("download.chooseFolder"));
      const reset = dl.dir ? h("button", { class: "linkbtn sv-link", type: "button", dataset: { fk: "dl:reset" }, onclick: () => ctx.saveCall(() => ctx.deck.bridge.file.resetFolder(), T("download.folderReset")) }, node("download.resetFolder")) : null;
      kids.push(group(node("set.downloads"),
        row(node("download.folder"), h("span", { class: "sv-inline" }, folder, reset, pick)),
        switchRow("s-download-ask", node("download.ask"), dl.ask, (on) => ctx.saveCall(() => ctx.deck.settingsSave({ downloads: { ask: on } }), T("download.askSaved")), { fk: "dl:ask" })));
      if (ctx.deck && ctx.deck.updates) kids.push(updatesGroup());
    };

    // ------------------------------------------------------------ Updates (main/update-check.js)
    // How far the repository's main branch moved since this build, the newest release, and one button to get
    // there. State comes from main ("updates" events); the first look at General asks for it.
    const UPD = { status: null, busy: null, progress: null, asked: false };
    const PHASES = ["download", "clone", "fetch", "checkout", "deps", "build", "install", "quit"];
    if (ctx.deck && ctx.deck.updates) {
      ctx.deck.updates.on((ev) => {
        if (!ev || typeof ev !== "object") return;
        if (ev.t === "status") Object.assign(UPD, { status: ev.status || null, busy: ev.busy || null, progress: ev.busy ? UPD.progress : null });
        else if (ev.t === "progress" && PHASES.includes(ev.phase)) UPD.progress = { phase: ev.phase, text: String(ev.text || "") };
        refresh();
      });
    }
    async function updatesCall(fn) {
      try {
        const r = await fn();
        if (r && r.status !== undefined) Object.assign(UPD, { status: r.status, busy: r.busy || null });
        if (r && r.ok === false) {
          UPD.progress = null;
          notify(false, T(r.error || "updates.failed") + (r.detail ? ` (${String(r.detail).slice(-160)})` : ""));
        }
      } catch (e) {
        notify(false, T("updates.failed"));
      }
      refresh({ force: true });
    }
    function updatesText(s) {
      if (UPD.progress) return T(`updates.phase.${UPD.progress.phase}`);
      if (UPD.busy === "check") return T("updates.checking");
      if (!s || s.unchecked) return T("updates.unknown");
      if (s.error) return T(s.error) + (s.detail ? ` (${s.detail})` : "");
      if (s.unavailable) return T(s.unavailable);
      if (s.replaceBuild && s.release) return T("updates.returnAvailable", { tag: s.release.tag });
      if (s.channel === "test" && s.release && !s.release.newer) return T("updates.releaseCurrent");
      if (s.release && s.release.newer) return T("updates.newRelease", { tag: s.release.tag });
      if (s.behind > 0 && s.ahead > 0) return T("updates.diverged", { count: s.behind, branch: s.branch, own: s.ahead });
      if (s.behind > 0) return T("updates.behind", { count: s.behind, branch: s.branch });
      if (s.ahead > 0) return T("updates.ahead", { own: s.ahead, branch: s.branch });
      if (s.compare === "unavailable") return T("updates.releaseCurrent");
      return T("updates.upToDate", { branch: s.branch });
    }
    function updatesGroup() {
      const s = UPD.status;
      if (!UPD.asked) {
        UPD.asked = true;
        updatesCall(() => ctx.deck.updates.status());
      }
      const u = st().updates || { auto: true, host: false, repo: "", branch: "main", hasToken: false, fromSource: false };
      const build = s ? `v${s.version}${s.commit ? ` · ${s.commit.slice(0, 7)}` : ""}${s.built ? ` (${s.built})` : ""}${s.dirty ? " *" : ""}` : "";
      const working = !!(UPD.busy || UPD.progress);
      const action = s && !s.error ? s.action : "none";
      const go = action === "release" || action === "build"
        ? h("button", { class: "btn mini primary", type: "button", disabled: working ? true : null, dataset: { fk: "upd:install" },
          onclick: () => updatesCall(() => ctx.deck.updates.install(s.target)) },
          node(action === "release" ? "updates.installRelease" : "updates.buildMain"))
        : action === "download"
          ? h("button", { class: "btn mini", type: "button", dataset: { fk: "upd:open" }, onclick: () => ctx.deck.updates.open() }, node("updates.openRelease"))
          : null;
      const check = h("button", { class: "btn mini", type: "button", disabled: working ? true : null, dataset: { fk: "upd:check" }, onclick: () => { UPD.busy = "check"; refresh({ force: true }); updatesCall(() => ctx.deck.updates.check()); } }, node("updates.checkNow"));
      const commits = s && !s.error && s.behind > 0 && Array.isArray(s.commits) && s.commits.length
        ? h("div", { class: "sv-row sv-block" }, h("ul", { class: "upd-commits" }, ...s.commits.slice(0, 6).map((c) => h("li", null, h("code", null, c.sha), " ", c.title))),
          s.behind > 6 ? h("p", { class: "upd-more" }, T("updates.more", { count: s.behind - 6 })) : null)
        : null;
      const selectedChannel = (s && s.channel) || u.channel || "stable";
      const channel = h("select", { id: "s-upd-channel", disabled: working ? true : null, dataset: { fk: "upd:channel" },
        onchange: (event) => updatesCall(() => ctx.deck.updates.channel(event.target.value)) },
        ...["stable", "test"].map(value => h("option", { value, selected: value === selectedChannel ? true : null }, T(`updates.channel.${value}`))));
      const token = input("s-upd-token", { type: "password", placeholder: u.hasToken ? T("U0485") : T("updates.tokenHint") });
      const saveAdv = () => ctx.save({ updates: { ...(token.value ? { token: token.value } : {}) } }, T("set.saved"));
      const adv = h("details", { class: "sv-row sv-block upd-adv" }, h("summary", null, T("updates.advanced")),
        row(node("updates.repo"), h("span", { class: "sv-path" }, s && s.repo || "Hermes-Deck/hermes-deck")),
        row(node("updates.token"), token, { id: "s-upd-token", title: T("updates.tokenHelp") }),
        switchRow("s-upd-src", node("updates.fromSource"), u.fromSource === true, (on) => ctx.save({ updates: { fromSource: on } }, T("set.saved")), { fk: "upd:src" }),
        h("div", { class: "form-actions sv-actions" }, h("button", { class: "btn mini", type: "button", dataset: { fk: "upd:save" }, onclick: saveAdv }, node("A0151"))));
      return group(node("updates.group"),
        row(node("updates.channel"), channel, { id: "s-upd-channel" }),
        h("p", { class: "sv-row sv-block" }, T("updates.channelHelp")),
        s && s.release ? row(node("updates.target"), h("span", { class: "sv-path" }, s.release.tag)) : null,
        build ? row(node("updates.thisBuild"), h("span", { class: "sv-path", title: s && s.repo ? s.repo : null }, build)) : null,
        row(node("updates.state"), h("span", { class: `upd-state${s && s.error ? " bad" : s && (s.behind > 0 || (s.release && s.release.newer)) ? " new" : ""}`, role: "status" }, updatesText(s))),
        commits,
        h("div", { class: "sv-row sv-end" }, h("span", { class: "sv-inline" }, check, go)),
        switchRow("s-upd-auto", node("updates.auto"), u.auto !== false, (on) => ctx.save({ updates: { auto: on } }, T("set.saved")), { fk: "upd:auto" }),
        switchRow("s-upd-host", node("updates.host"), u.host === true, (on) => ctx.save({ updates: { host: on } }, T("set.saved")), { fk: "upd:host" }),
        adv);
    }

    BUILDERS.relay = (kids) => {
      const r = st().relay || {};
      const url = input("s-relay-url", { value: r.url || "", placeholder: "ws://<relay-host>:9330", title: T("U0484") });
      const token = input("s-relay-token", { type: "password", placeholder: r.hasToken ? T("U0485") : T("A0237") });
      const save = () => ctx.save({ relay: { url: url.value, token: token.value } }, T("U0486"));
      for (const el of [url, token]) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
      kids.push(group(node("hosts.relay"), row(node("A0236"), url, { id: "s-relay-url" }), row("Token", token, { id: "s-relay-token" })),
        h("div", { class: "form-actions sv-actions" }, h("button", { class: "btn primary", type: "button", dataset: { fk: "relay:save" }, onclick: save }, node("U0487"))),
        secretWarning(), hostGroup("relay"), hostsGroup());
    };

    /** Hosts have independent Relay and Sessions connections. Tokens only enter through password inputs. */
    function hostsGroup() {
      const s = st(), hosts = Array.isArray(s.hosts) ? s.hosts : [], api = ctx.deck && ctx.deck.hosts;
      if (!api) return null;
      const observed = ctx.hostStates?.() || {};
      const states = x => {
        const active = x.id === s.activeHost;
        const remote = (observed.remote || []).find(v => v.id === x.id);
        return [
          ["hosts.relay", connectionState(!!(x.relay?.url && x.relay?.hasToken), active ? observed.relay : null)],
          ["hosts.sessions", connectionState(x.bridge?.mode && x.bridge.mode !== "off", active ? observed.sessions : remote?.status)],
        ].map(([label, status]) => `${T(label)}: ${T(`hosts.state.${status}`)}`).join(" · ");
      };
      const rows = hosts.map(x => h("div", { class: "sv-row" },
        h("div", { class: "sv-host-label" }, h("span", { class: "sv-label" }, x.name, x.id === s.activeHost ? h("small", null, T("hosts.active")) : null),
          h("span", { class: "sv-host-state" }, states(x))),
        h("div", { class: "sv-ctl" },
          x.id === s.activeHost && (!x.bridge?.mode || x.bridge.mode === "off") ? h("button", { class: "btn mini", type: "button", onclick: () => show("hermes") }, node("hosts.configureSessions")) : null,
          x.id === s.activeHost ? null : h("button", { class: "btn mini", type: "button", dataset: { fk: `hosts:use:${x.id}` }, onclick: () => ctx.selectHost(x.id) }, node("hosts.use")),
          x.id === s.activeHost ? null : h("button", { class: "linkbtn sv-link", type: "button", dataset: { fk: `hosts:rm:${x.id}` }, onclick: () => ctx.saveCall(() => api.remove(x.id), T("set.saved")) }, node("hosts.remove")))));
      const name = input("s-host-name", { placeholder: T("hosts.namePlaceholder"), maxlength: "40" });
      const url = input("s-host-url", { placeholder: "ws://<relay-host>:9330" });
      const token = input("s-host-token", { type: "password", placeholder: T("A0237") });
      const mode = h("select", { id: "s-host-mode" },
        [["off", T("hosts.state.unconfigured")], ["ssh", T("U0631")], ctx.windows() ? ["wsl", T("A0286")] : ["local", T("A0287")]]
          .map(([value, label]) => h("option", { value }, label)));
      const target = input("s-host-target", { placeholder: T("U0633") });
      const python = input("s-host-python", { placeholder: "~/.hermes/hermes-agent/venv/bin/python" });
      const stream = input("s-host-stream", { value: "~/.hermes/hermes-deck/stream.py" });
      const distribution = input("s-host-dist", { placeholder: T("U0638") });
      const targetRow = row(node("A0288"), target, { id: "s-host-target", title: T("U0634") });
      const distRow = row(node("U0637"), distribution, { id: "s-host-dist" });
      const paths = h("div", null, row(node("A0289"), python, { id: "s-host-python", title: T("U0635") }),
        row(node("A0291"), stream, { id: "s-host-stream", title: T("U0636") }), distRow);
      const sync = () => { targetRow.hidden = mode.value !== "ssh"; paths.hidden = mode.value === "off"; distRow.hidden = mode.value !== "wsl"; };
      mode.value = "off";
      mode.addEventListener("change", sync);
      sync();
      const addButton = h("button", { class: "btn mini", type: "button", dataset: { fk: "hosts:add" }, onclick: async () => {
        if (addButton.disabled) return;
        addButton.disabled = true;
        try {
          const ok = await ctx.saveCall(() => api.add({ name: name.value, relay: { url: url.value, token: token.value },
            bridge: { mode: mode.value, target: mode.value === "ssh" ? target.value : "", python: python.value, stream: stream.value, distribution: mode.value === "wsl" ? distribution.value : "" } }), T("hosts.added"));
          if (ok) { token.value = ""; rebuild("relay"); }
        } finally { addButton.disabled = false; }
      } }, node("hosts.add"));
      return h("div", { class: "sv-hosts" }, group(node("hosts.title"), ...rows),
        h("details", { class: "sv-host-add", open: !hosts.length ? true : null }, h("summary", null, node("hosts.add")),
          row(node("hosts.name"), name, { id: "s-host-name" }),
          h("h3", { class: "sv-group-title" }, node("hosts.relay")), h("p", { class: "sv-hint" }, node("hosts.relayHelp")),
          row(node("A0236"), url, { id: "s-host-url" }), row("Token", token, { id: "s-host-token" }),
          h("h3", { class: "sv-group-title" }, node("hosts.sessions")), h("p", { class: "sv-hint" }, node("hosts.sessionsHelp")),
          row(node("U0632"), mode, { id: "s-host-mode" }), targetRow, paths,
          h("div", { class: "form-actions sv-actions" }, addButton)));
    }

    BUILDERS.telegram = (kids) => {
      const s = st();
      const tg = ctx.tg() || {};
      const apiId = input("s-apiid", { value: (s.telegram && s.telegram.apiId) || "", inputmode: "numeric", placeholder: "1234567" });
      const apiHash = input("s-apihash", { type: "password", placeholder: s.telegram && s.telegram.hasApiHash ? T("U0485") : T("A0222"), title: "my.telegram.org → API development tools" });
      const saveKeys = () => ctx.save({ telegram: { apiId: apiId.value, apiHash: apiHash.value } }, T("U0492"));
      for (const el of [apiId, apiHash]) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveKeys(); } });
      kids.push(group(node("set.tgApi"),
        h("div", { class: "sv-row" }, h("label", { class: "sv-label code", for: "s-apiid" }, "api_id", note()), h("div", { class: "sv-ctl" }, apiId)),
        h("div", { class: "sv-row" }, h("label", { class: "sv-label code", for: "s-apihash" }, "api_hash", note()), h("div", { class: "sv-ctl" }, apiHash))),
        h("div", { class: "form-actions sv-actions" },
          h("button", { class: "btn primary", type: "button", dataset: { fk: "tg:save" }, onclick: saveKeys }, node("A0151")),
          h("button", { class: "linkbtn sv-link", type: "button", onclick: () => ctx.deck.openExternal("https://my.telegram.org/apps") }, node("U0450"))),
        secretWarning());
      const groups = tg.forumGroups || [];
      const sel = h("select", { id: "s-group", title: T("U0490"), onchange: (e) => ctx.save({ groupChatId: e.target.value }, T("U0492")) },
        h("option", { value: "" }, node("U0488")), groups.map((g) => h("option", { value: g.id, selected: g.id === s.groupChatId ? true : null }, g.title)));
      if (s.groupChatId && !groups.some((g) => g.id === s.groupChatId)) sel.appendChild(h("option", { value: s.groupChatId, selected: true }, s.groupChatId));
      const hidden = input("s-hidden", { placeholder: T("A0240"), title: T("U0491") });
      const addHidden = async () => {
        const submitted = hidden.value;
        const username = submitted.trim().replace(/^@/, "").trim();
        if (!username) return;
        try {
          await updateHiddenBots(username);
          if ((st().hiddenBots || []).some((v) => v.toLowerCase() === username.toLowerCase())) {
            if (hidden.value === submitted) hidden.value = "";
            rebuild("telegram");
          }
        } catch (e) { notify(false, e.message); }
      };
      hidden.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addHidden(); } });
      kids.push(group(node("set.tgChats"),
        row(node("U0489"), sel, { id: "s-group" }),
        switchRow("s-read-receipts", node("U0494"), s.readReceipts !== false, async (on) => { await ctx.save({ readReceipts: on }, T("U0493")); ctx.readReceiptsChanged(); }, { title: T("U0495"), fk: "tg:read-receipts" })));
      kids.push(group(node("A0239"),
        ...(s.hiddenBots || []).map((username) => row(`@${username}`, h("button", {
          class: "btn mini", type: "button", dataset: { fk: `hidden-show:${username.toLowerCase()}` },
          "aria-label": T("hiddenBots.showNamed", { username }),
          onclick: () => updateHiddenBots(username, false),
        }, node("hiddenBots.show")))),
        !(s.hiddenBots || []).length ? h("p", { class: "sv-row muted" }, node("hiddenBots.empty")) : null,
        row(node("hiddenBots.username"), h("span", { class: "sv-inline" }, hidden,
          h("button", { class: "btn mini", type: "button", dataset: { fk: "hidden-add" }, onclick: addHidden }, node("hiddenBots.add"))), { id: "s-hidden" })));
      const me = tg.me;
      kids.push(group(node("A0242"), me
        ? row(h("span", { class: "sv-value" }, me.name || String(me.id)), h("button", { class: `btn mini${V.logoutArmed ? " danger" : ""}`, type: "button", title: T("set.logoutTip"), dataset: { fk: "tg:logout" }, onclick: async () => {
          if (!V.logoutArmed) { V.logoutArmed = true; return rebuild("telegram"); }
          V.logoutArmed = false;
          await ctx.logout();
        } }, V.logoutArmed ? node("A0243") : node("A0244")))
        : h("div", { class: "sv-row" }, h("span", { class: "sv-label muted" }, node("U0498")))));
    };

    // Hermes: the direct connection form stays in app.js (it shares state with the bridge feed)
    BUILDERS.hermes = (kids) => {
      const box = [];
      ctx.hermes(box);
      kids.push(h("h3", { class: "sv-group-title" }, node("hosts.sessions")), h("p", { class: "sv-hint" }, node("hosts.sessionsHelp")),
        h("div", { class: "sv-legacy" }, box), hostGroup("hermes"));
    };

    // Reading saves share ctx.save with all other settings. Serialize rapid choices so an older
    // reply cannot undo the newest preview; always reconcile to S.settings after the final save.
    let readingPending = 0, readingSave = Promise.resolve(), readingDraft = null;
    const syncReading = () => { if (!readingPending) window.DeckReading?.apply(st().reading); };
    function paintReading() {
      const box = V.built.get("desktop");
      const values = window.DeckReading?.normalize?.(st().reading) || { agentMessages: st().reading?.agentMessages === "bubble" ? "bubble" : "plain" };
      for (const [key, value] of Object.entries(values)) {
        const choice = box?.querySelector(`[data-fk="reading:${key}"]`);
        if (!choice) continue;
        choice.value = String(value);
        for (const option of choice.children) {
          option.selected = option.getAttribute("value") === String(value);
          if (option.selected) option.setAttribute("selected", "");
          else option.removeAttribute("selected");
        }
      }
    }
    function changeReading(key, value) {
      readingPending++;
      const before = readingDraft || st().reading || {};
      readingDraft = { ...before, [key]: value };
      window.DeckReading?.apply(readingDraft);
      readingSave = readingSave.catch(() => {}).then(() => ctx.save({ reading: { [key]: value } }, T("set.saved"))).finally(() => {
        readingPending--;
        if (!readingPending) {
          readingDraft = null;
          syncReading();
          paintReading();
        }
      });
      return readingSave;
    }

    // Settings > Hermes config (renderer/hermes-config-view.js): every config.yaml setting per profile, via the relay
    BUILDERS.hermescfg = (kids) => {
      if (ctx.hermesConfig) ctx.hermesConfig.build(kids);
      else kids.push(h("p", { class: "sv-hint" }, T("hcfg.unavailable")));
    };

    BUILDERS.desktop = (kids) => {
      const d = st().desktop || {};
      const info = ctx.deskInfo() || {};
      const auto = info.autostart || "unsupported";
      const flag = (name, label, { off = false, title = null } = {}) =>
        switchRow(`s-desk-${name}`, label, d[name], (on) => ctx.save({ desktop: { [name]: on } }, T("U0544")), { disabled: off, title, fk: `desk:${name}` });
      const skin = h("select", { id: "s-desk-petSkin", disabled: d.pet ? null : true, dataset: { fk: "desk:petSkin" }, onchange: (e) => ctx.save({ desktop: { petSkin: e.target.value } }, T("U0549")) },
        window.PetCatalog.SKINS.map(({ id, label }) => h("option", { value: id, selected: id === (d.petSkin || "character") ? true : null }, T(label))));
      const size = h("select", { id: "s-desk-petSize", disabled: d.pet ? null : true, dataset: { fk: "desk:petSize" }, onchange: (e) => ctx.save({ desktop: { petSize: Number(e.target.value) } }, T("set.petSizeSaved")) },
        [[0.75, T("set.petSizeS")], [1, T("set.petSizeM")], [1.25, T("set.petSizeL")], [1.5, T("set.petSizeXL")]].map(([v, l]) => h("option", { value: String(v), selected: v === (d.petSize || 1) ? true : null }, l)));
      const notificationMode = h("select", { id: "s-desk-notificationMode", disabled: d.notifications ? null : true, dataset: { fk: "desk:notificationMode" }, onchange: (e) => ctx.save({ desktop: { notificationMode: e.target.value } }, T("U0544")) },
        ["auto", "pet", "banner"].map(value => h("option", { value, selected: value === (d.notificationMode || "auto") ? true : null }, T(`notify.${value}`))));
      const test = h("button", { class: "btn mini", type: "button", dataset: { fk: "desk:test" }, onclick: (e) => ctx.testNotification(e.currentTarget) }, node("A0254"));
      const winNote = ctx.windows() ? (info.packaged ? T("U0559") : `${T("U0560")}npm run shortcuts${T("U0561")}`) : null;
      const theme = h("select", { id: "s-theme", dataset: { fk: "set:theme" }, onchange: (e) => ctx.save({ theme: e.target.value }, T("set.themeSaved")) },
        [["basalt", T("set.themeBasalt")], ["marble", T("set.themeMarble")], ["aegean", T("set.themeAegean")], ["system", T("set.themeSystem")]]
          .map(([v, l]) => h("option", { value: v, selected: v === (st().theme || "basalt") ? true : null }, l)));
      // one background per chat mode: its dimming, remove, and choose on one row
      const walls = st().wallpaper || {};
      const wallRow = (mode) => {
        const w = walls[mode] || { file: "", dim: 55 };
        const label = ctx.CM.TEXT.labels[mode];
        // none, a built-in background, or the user's own picture ("Choose image…" adds or replaces it)
        const own = w.file && !w.file.startsWith("preset:");
        const choice = h("select", { class: "s-wall-choice", id: `s-wall-choice-${mode}`, "aria-label": `${label}: ${T("wall.label")}`, dataset: { fk: `wall:choice:${mode}` },
          onchange: (e) => {
            const v = e.target.value;
            if (v === "") ctx.saveCall(() => ctx.deck.wallpaper.clear(mode), T("wall.cleared"));
            else if (v === "own") ctx.saveCall(() => ctx.deck.wallpaper.pick(mode), T("wall.saved"));
            else ctx.saveCall(() => ctx.deck.wallpaper.preset(mode, v), T("wall.saved"));
          } },
          [["", T("wall.none")], ...["marble", "aegean", "basalt", "papyrus"].map((id) => [id, T(`wall.preset.${id}`)]), ["own", own ? T("wall.own") : T("wall.pick")]]
            .map(([v, l]) => h("option", { value: v, selected: (v === "own" ? own : w.file === (v ? `preset:${v}` : "")) ? true : null }, l)));
        const pick = own ? h("button", { class: "btn mini", type: "button", dataset: { fk: `wall:pick:${mode}` }, onclick: () => ctx.saveCall(() => ctx.deck.wallpaper.pick(mode), T("wall.saved")) }, node("wall.change")) : null;
        const dim = w.file ? h("input", { class: "s-wall-dim", id: `s-wall-dim-${mode}`, type: "range", min: "0", max: "90", step: "5", value: String(w.dim), title: T("wall.dim"), "aria-label": `${label}: ${T("wall.dim")}`, dataset: { fk: `wall:dim:${mode}` },
          onchange: (e) => ctx.save({ wallpaper: { [mode]: { dim: Number(e.target.value) } } }, T("wall.dimSaved")) }) : null;
        return row(h("span", null, label), h("span", { class: "sv-inline" }, dim, choice, pick), { id: `s-wall-${mode}`, title: T("wall.help") });
      };
      const prefs = window.DeckReading?.normalize?.(readingDraft || st().reading) || { agentMessages: st().reading?.agentMessages === "bubble" ? "bubble" : "plain", font: "newsreader", size: 17 };
      const agentMessages = prefs.agentMessages;
      const agentChoice = h("select", { id: "s-agent-messages", dataset: { fk: "reading:agentMessages" },
        onchange: (e) => changeReading("agentMessages", e.target.value) },
        [["plain", T("conv.agentPlain")], ["bubble", T("conv.agentBubble")]]
          .map(([value, label]) => h("option", { value, selected: value === agentMessages ? true : null }, label)));
      const fontChoice = h("select", { id: "s-message-font", dataset: { fk: "reading:font" },
        onchange: (e) => changeReading("font", e.target.value) },
        [["newsreader", T("conv.fontNewsreader")], ["geist", T("conv.fontGeist")], ["atkinson", T("conv.fontAtkinson")]]
          .map(([value, label]) => h("option", { value, selected: value === prefs.font ? true : null }, label)));
      const sizeChoice = h("select", { id: "s-message-size", class: "sv-reading-size", dataset: { fk: "reading:size" },
        onchange: (e) => changeReading("size", Number(e.target.value)) },
        [14, 15, 16, 17, 18, 19, 20].map(value => h("option", { value: String(value), selected: value === prefs.size ? true : null }, T("conv.textPixels", { size: value }))));
      kids.push(group(node("set.appearance"), row(node("set.theme"), theme, { id: "s-theme" }),
        row(node("conv.agentMessages"), agentChoice, { id: "s-agent-messages" }),
        row(node("conv.messageFont"), fontChoice, { id: "s-message-font" }),
        row(node("conv.textSize"), sizeChoice, { id: "s-message-size" })));
      kids.push(group(node("wall.label"), ...["telegram", "sessions", "bots"].map(wallRow)));
      kids.push(group(node("A0186"),
        flag("notifications", node("A0186"), { title: winNote }),
        row(node("notify.mode"), notificationMode, { id: "s-desk-notificationMode", title: T("notify.modeHelp") }),
        h("div", { class: "sv-row sv-block" },
          h("p", { class: "sv-hint" }, T("notify.modeHelp")),
          h("p", { class: "sv-hint" }, T("notify.autoLimit"))),
        flag("sound", node("A0253"), { off: !d.notifications }),
        flag("taskbarBadge", node("set.badge"), { title: T("set.badgeHelp") }),
        h("div", { class: "sv-row sv-end" }, test)));
      kids.push(soundsGroup(d));
      kids.push(group(node("A0183"),
        flag("pet", node("A0183")),
        flag("petAlwaysOnTop", node("set.petAlwaysOnTop"), { off: !d.pet, title: T("set.petAlwaysOnTopHelp") }),
        row(node("U0333"), skin, { id: "s-desk-petSkin", cls: d.pet ? "" : "off" }),
        row(node("set.petSize"), size, { id: "s-desk-petSize", cls: d.pet ? "" : "off" }),
        flag("petMotion", node("U0551"), { off: !d.pet, title: T("U0552") })));
      kids.push(group(node("set.window"),
        flag("closeToTray", node("U0553"), { title: T("U0554") }),
        flag("autostart", node("U0558"), { off: auto !== "ok", title: auto === "ok" ? null : auto === "mac-dev" ? T("U0556") : T("U0557") })));
    };

    // Notification sounds (main/sounds.js, renderer/chime.js): the volume, and per event a built-in sound, none, or
    // the user's own file (picked natively, copied into the profile). Each choice plays once when it is made; the
    // play button previews it again. Heard only while Sound is on.
    const SOUND_EVENTS = [["reply", "sound.ev.reply"], ["done", "sound.ev.done"], ["approval", "sound.ev.approval"], ["question", "sound.ev.question"], ["subagent", "sound.ev.subagent"]];
    function soundsGroup(d) {
      const DS = window.DeckSounds;
      const s = soundsOf(st());
      const off = !d.notifications || !d.sound;
      const preview = (value) => DS && DS.play(value, soundsOf(st()).volume);
      const volume = h("input", { id: "s-sound-volume", class: "s-sound-volume", type: "range", min: "0", max: "100", step: "5", value: String(s.volume), disabled: off ? true : null,
        "aria-label": T("sound.volume"), dataset: { fk: "sound:volume" },
        onchange: (e) => {
          const v = Number(e.target.value);
          Promise.resolve(ctx.save({ sounds: { volume: v } }, T("sound.volumeSaved"))).then(() => DS && DS.play(soundsOf(st()).events.reply, v));
        } });
      const eventRow = ([ev, label]) => {
        const value = s.events[ev];
        const own = !!value && !value.startsWith("preset:");
        const choice = h("select", { class: "s-sound-choice", id: `s-sound-${ev}`, disabled: off ? true : null, "aria-label": T(label), dataset: { fk: `sound:choice:${ev}` },
          onchange: (e) => {
            const v = e.target.value;
            const call = v === "own" ? () => ctx.deck.sounds.pick(ev) : () => ctx.deck.sounds.set(ev, v);
            Promise.resolve(ctx.saveCall(call, T("sound.saved"))).then(() => {
              const now = soundsOf(st()).events[ev];
              if (v !== "own" || now !== value) preview(now); // hear the new choice once (not after a cancelled pick)
            });
          } },
          [["", T("sound.none")], ...SOUND_PRESETS.map((id) => [`preset:${id}`, T(`sound.preset.${id}`)]), ["own", own ? T("sound.own") : T("sound.pick")]]
            .map(([v, l]) => h("option", { value: v, selected: (v === "own" ? own : v === value) ? true : null }, l)));
        const change = own ? h("button", { class: "btn mini", type: "button", disabled: off ? true : null, dataset: { fk: `sound:pick:${ev}` },
          onclick: () => ctx.saveCall(() => ctx.deck.sounds.pick(ev), T("sound.saved")) }, node("sound.change")) : null;
        const play = h("button", { class: "btn mini s-sound-play", type: "button", disabled: value ? null : true, title: T("sound.preview"), "aria-label": `${T(label)}: ${T("sound.preview")}`, dataset: { fk: `sound:play:${ev}` },
          onclick: () => preview(soundsOf(st()).events[ev]) }, "▶");
        return row(h("span", null, T(label)), h("span", { class: "sv-inline" }, choice, change, play), { id: `s-sound-${ev}`, cls: off ? "off" : "" });
      };
      return group(node("sound.title"),
        row(node("sound.volume"), volume, { id: "s-sound-volume", cls: off ? "off" : "" }),
        ...SOUND_EVENTS.map(eventRow),
        h("p", { class: "sv-row sv-block s-sound-help" }, T("sound.help")));
    }

    // This device: what this computer hosts for agents (workspace.js, botscreen.js own their rows)
    function safetyGroup() {
      if (!ctx.deck.spaces?.safety) return null;
      const box = h("div", { class: "sv-safety" });
      const state = h("p", { class: "sv-block muted", role: "status" }); // lasting: audit locked by the relay, logging paused
      const note = h("p", { class: "sv-block", role: "status" }, T("safety.loading")); // this edit's outcome
      const disk = h("div", { class: "sv-snapshot-disk" });
      let held = null, saving = false;
      const controls = new Map();
      const fields = [
        ["audit", "safety.audit"], ["typedText", "safety.typedText"], ["screenshots", "safety.screenshots"],
        ["days", "safety.days", 1, 90], ["approvals", "safety.approvals"], ["snapshotKeep", "safety.keep", 1, 100],
      ];
      const paint = () => {
        state.textContent = !held ? "" : held.auditLocked ? T("safety.locked") : held.loggingPaused ? T("safety.loggingPaused") : "";
        for (const [key, el] of controls) {
          el.disabled = !held || saving || (key === "audit" && held.auditLocked === true);
          if (!held) continue;
          if (el.type === "checkbox") el.checked = held[key] === true;
          else el.value = String(held[key]);
        }
      };
      const save = async (key, el, min, max) => {
        if (!held || saving || (key === "audit" && held.auditLocked)) return;
        const value = el.type === "checkbox" ? el.checked : Number(el.value);
        if (min && (!Number.isInteger(value) || value < min || value > max)) {
          note.textContent = T("safety.settingsFailed"); paint(); return;
        }
        saving = true;
        for (const control of controls.values()) control.disabled = true;
        try {
          const result = await ctx.deck.spaces.safety({ [key]: value });
          if (result?.ok === false || !result?.settings) throw new Error();
          held = result.settings; note.textContent = T("set.saved");
        } catch { note.textContent = T("safety.settingsFailed"); }
        finally { saving = false; paint(); }
      };
      const rows = fields.map(([key, label, min, max]) => {
        const id = `s-safety-${key}`;
        const el = h("input", { id, type: min ? "number" : "checkbox", min, max, step: min ? 1 : null, disabled: true,
          onchange: (e) => save(key, e.target, min, max) });
        controls.set(key, el);
        return row(T(label), el, { id });
      });
      async function loadDisk() {
        if (!ctx.deck.spaces.snapshots) return;
        // Undo points outlive the routing mode: list every known agent (as the home-host table does) plus any agent
        // desktop the relay reports, so shared mode still shows and deletes retained archives.
        const list = await ctx.deck.spaces.list();
        if (list?.ok === false) throw new Error();
        const agents = new Map();
        for (const a of ctx.agents ? ctx.agents() : []) if (a && a.profile && a.profile !== "host") agents.set(a.profile, { id: a.profile, holderName: a.name });
        for (const r of list.spaces || []) if (r.kind === "agent" && r.id !== "host") agents.set(r.id, { ...agents.get(r.id), ...r, holderName: r.holderName || agents.get(r.id)?.holderName });
        const rows = await Promise.all([...agents.values()].map(async (agent) => {
          let bytes = null;
          try {
            const r = await ctx.deck.spaces.snapshots(agent.id);
            if (r?.ok !== false && Number.isFinite(r?.totalBytes) && r.totalBytes >= 0) bytes = r.totalBytes;
          } catch {}
          const remove = h("button", { class: "btn mini", type: "button", dataset: { snapshotDelete: agent.id }, disabled: bytes === null ? true : null, onclick: async () => {
            if (remove.disabled) return;
            remove.disabled = true;
            try {
              if (!(await ask(T("safety.deleteConfirm"), T("safety.delete")))) return;
              const r = await ctx.deck.spaces.deleteSnapshots(agent.id);
              if (r?.ok !== true) throw new Error();
              await loadDisk(); note.textContent = T("set.saved");
            } catch { note.textContent = T("safety.settingsFailed"); }
            finally { remove.disabled = false; }
          } }, T("safety.delete"));
          return row(h("span", null, agent.holderName || agent.id, h("span", { class: "muted" },
            T("safety.disk", { size: bytes === null ? T("safety.unavailable") : sizeText(bytes) }))), remove);
        }));
        disk.replaceChildren(...rows);
      }
      box.appendChild(h("h3", { class: "sv-group-title" }, T("safety.settings")));
      for (const el of rows) box.appendChild(el);
      box.appendChild(h("p", { class: "muted sv-block" }, T("safety.privacy")));
      box.appendChild(state); box.appendChild(note); box.appendChild(disk);
      ctx.deck.spaces.safety().then((r) => {
        if (r?.ok === false || !r?.settings) throw new Error();
        held = r.settings;
        note.textContent = "";
        paint();
      }).catch(() => { note.textContent = T("safety.settingsFailed"); });
      loadDisk().catch(() => { note.textContent = T("safety.settingsFailed"); });
      return box;
    }

    BUILDERS.device = (kids) => {
      const ws = ctx.workspaceRows();
      const bs = ctx.botscreenRows();
      if (ws) kids.push(group(node("set.agentBrowser"), h("div", { class: "sv-legacy" }, ws)));
      // agent spaces: where agents work by default (the relay's mode) and the control level the Bot screen opens with
      if (ctx.deck.spaces) {
        const modeNote = h("span", { class: "sv-msg" });
        const mode = h("select", { id: "s-space-mode", disabled: true, dataset: { fk: "space:mode" }, onchange: (e) => ctx.saveCall(async () => {
          const want = e.target.value;
          let r;
          try {
            r = await ctx.deck.spaces.mode(want);
          } catch (err) {
            mode.value = mode.dataset.saved || "shared"; // a refused mode must not stay selected
            throw err;
          }
          if (r && r.ok === false) {
            mode.value = mode.dataset.saved || "shared";
            throw new Error(r.error === "phase 2" ? T("space.mode.later") : r.error === "no desktop host" ? T("space.noHost") : r.error);
          }
          mode.dataset.saved = want;
          return ctx.settings(); // the mode lives on the relay; the Deck's settings are unchanged
        }, T("set.saved")) },
          h("option", { value: "shared" }, T("space.mode.shared")),
          h("option", { value: "agent" }, T("space.mode.agent")),
          h("option", { value: "overflow" }, T("space.mode.overflow")));
        // phase 2: no desktop host yet (agent mode needs one), and each agent's home host
        const noHost = h("p", { class: "muted sv-block", id: "s-space-nohost", hidden: true });
        const homes = h("div", { id: "s-space-homes" });
        ctx.deck.spaces.list().then((l) => {
          if (l && l.mode) {
            mode.value = l.mode;
            mode.dataset.saved = l.mode;
            mode.disabled = false;
          } else modeNote.textContent = T("space.none");
          const hosts = l && Array.isArray(l.hosts) ? l.hosts : null;
          if (l && ["agent", "overflow"].includes(l.mode) && hosts && !hosts.length) {
            noHost.hidden = false;
            noHost.textContent = T("space.noHost");
          }
          if (hosts) homes.replaceChildren(...homeRows(hosts, (l && l.homes) || {}));
        }).catch(() => (modeNote.textContent = T("space.none")));
        const lvl = segmented("s-space-level", (st().spaces && st().spaces.defaultLevel) || "watch",
          ["watch", "together", "full"].map((l) => [l, T(`space.level.${l}`), T(`space.levelHelp.${l}`)]),
          (v) => ctx.save({ spaces: { defaultLevel: v } }, T("set.saved")));
        kids.push(group(node("space.mode"),
          row(node("space.mode"), h("span", { class: "sv-inline" }, mode, modeNote), { id: "s-space-mode-row", title: T("space.modeHelp") }),
          noHost,
          row(node("space.defaultLevel"), lvl, { id: "s-space-level-row" }),
          homes, safetyGroup()));
      }
      desktopsGroup(kids);
      if (bs) kids.push(group(node("U0478"), h("div", { class: "sv-legacy", id: "s-device" }, bs),
        ctx.screenTab() ? h("div", { class: "sv-row sv-end" }, h("button", { class: "linkbtn sv-link", type: "button", dataset: { fk: "bs:open" }, onclick: () => { close(); ctx.openScreen(); } }, node("set.openScreen"))) : null));
    };

    /**
     * Settings > Agent spaces, home host per agent (spec 2026-10-07 section 7): one row per agent, Automatic, the agent
     * host, or a Deck device; a device that is offline (or gone) is dimmed. The relay validates and stores it.
     * A listed host is connected; ready:false only means it cannot run desktops yet (hosting starting, Docker
     * missing or stopped, image not pulled), so it reads "not ready". "Offline" is for a home the relay no longer lists.
     */
    function homeRows(hosts, homes) {
      const list = (ctx.agents ? ctx.agents() : []).filter((a) => a && a.profile && a.profile !== "host"); // "host" is the shared space
      if (!list.length) return [];
      const label = (x) => (x.id === "agent-host" ? T("space.homeAgentHost") : x.name || x.id);
      return list.map((a) => {
        const cur = homes[a.profile] || "auto";
        const opts = [h("option", { value: "auto", selected: cur === "auto" ? true : null }, T("space.homeAuto"))];
        // the agent host first (only when it hosts desktops), then the Deck devices
        const ordered = [...hosts.filter((x) => x.id === "agent-host"), ...hosts.filter((x) => x.id !== "agent-host")];
        for (const x of ordered)
          opts.push(h("option", { value: x.id, class: x.ready ? null : "off", selected: cur === x.id ? true : null }, x.ready ? label(x) : T("space.homeNotReady", { name: label(x) })));
        if (cur !== "auto" && !hosts.some((x) => x.id === cur)) // its home is gone from the relay's list: offline
          opts.push(h("option", { value: cur, class: "off", selected: true }, T("space.homeOffline", { name: cur === "agent-host" ? T("space.homeAgentHost") : cur })));
        const id = `s-space-home-${a.profile}`;
        const sel = h("select", { id, dataset: { fk: `space:home:${a.profile}` }, onchange: (e) => ctx.saveCall(async () => {
          const r = await ctx.deck.spaces.home(a.profile, e.target.value);
          if (r && r.ok === false) throw new Error(r.error);
          return ctx.settings(); // the home host lives on the relay; the Deck's settings are unchanged
        }, T("set.saved")) }, ...opts);
        sel.value = cur;
        return row(h("span", null, `${T("space.homeHost")}: ${a.name || a.profile}`), sel, { id, title: T("space.homeHelp") });
      });
    }

    // ------------------------------------------------------------ agent desktops (main/desktops.js)
    // "Host agent desktops on this device": the switch goes through the consent sheet (ctx.confirm) before the main
    // process saves it and starts the image download. The status line and the running list follow the main process's
    // pushes in place (no section rebuild every 10 s); the number fields save through the generic settings save.
    const DK = { st: null, sub: false, status: null, list: null, sw: null };
    function dkApply(s) {
      if (!s || typeof s !== "object") return;
      DK.st = s;
      dkPaint();
    }
    function dkWatch() {
      if (DK.sub) return;
      DK.sub = true;
      if (ctx.deck.desktops.onEvent) ctx.deck.desktops.onEvent(dkApply);
      Promise.resolve().then(() => ctx.deck.desktops.state()).then(dkApply).catch(() => {});
    }
    const ask = (text, ok) => (ctx.confirm ? ctx.confirm({ title: T("desktops.title"), body: text, ok }) : Promise.resolve(window.confirm(text)));
    /** The Docker state line, with the next step. */
    function dkStatus() {
      const s = DK.st;
      if (!s || s.docker === "unknown") return [T("desktops.checking")];
      if (s.docker === "missing") return [T("desktops.dockerMissing"), " ", h("button", { class: "linkbtn sv-link", type: "button", dataset: { fk: "dk:docker-link" }, onclick: () => ctx.deck.openExternal(DOCKER_URL) }, node("desktops.dockerLink"))];
      if (s.docker !== "ready") return [T("desktops.dockerStopped")];
      if (s.host && s.isolation === false) return [T("desktops.isolation")];
      if (s.image === "pulling") return [T("desktops.pulling", { pct: (s.pull && s.pull.pct) || 0 })];
      if (!s.host) return [];
      if (s.image !== "present") return [s.error ? T("desktops.pullFailed", { e: s.error }) : T("desktops.imageAbsent")];
      return [T("desktops.ready")];
    }
    function dkRows() {
      const s = DK.st;
      if (!s || !s.host) return [];
      const warnGB = (st().desktops && st().desktops.homeWarnGB) || 10;
      const running = Array.isArray(s.running) ? s.running : [];
      if (!running.length) return [h("p", { class: "muted sv-block" }, node("desktops.none"))];
      return running.map((d) => {
        const over = Number.isFinite(d.homeBytes) && d.homeBytes > warnGB * 1e9;
        const stop = h("button", { class: "btn mini", type: "button", dataset: { fk: `dk:stop:${d.profile}` }, onclick: () =>
          ctx.saveCall(async () => { dkApply(await ctx.deck.desktops.stop(d.profile)); return ctx.settings(); }, T("set.saved")) }, node("desktops.stop"));
        const reset = h("button", { class: "btn mini", type: "button", dataset: { fk: `dk:reset:${d.profile}` }, onclick: async () => {
          if (!(await ask(T("desktops.resetConfirm", { agent: d.profile }), T("desktops.reset")))) return;
          ctx.saveCall(async () => { dkApply(await ctx.deck.desktops.reset(d.profile)); return ctx.settings(); }, T("set.saved"));
        } }, node("desktops.reset"));
        const facts = `${d.memMB} MB · ${d.cpuPct}% CPU · ${sizeText(d.homeBytes)}`;
        return h("div", { class: "sv-row", dataset: { dk: d.profile } },
          h("span", { class: "sv-label" }, d.profile, h("span", { class: "muted" }, facts), over ? h("span", { class: "form-error" }, T("desktops.homeWarn", { gb: warnGB })) : null),
          h("div", { class: "sv-ctl" }, stop, reset));
      });
    }
    function dkPaint() {
      if (DK.status) DK.status.replaceChildren(...dkStatus().map((x) => (typeof x === "string" ? h("span", null, x) : x)));
      if (DK.list) DK.list.replaceChildren(...dkRows());
      if (DK.sw && DK.st && document.activeElement !== DK.sw) DK.sw.checked = DK.st.host === true;
    }
    function desktopsGroup(kids) {
      if (!ctx.deck.desktops) return;
      dkWatch();
      const cur = st().desktops || {};
      const on = DK.st ? DK.st.host === true : cur.host === true;
      const sw = switchRow("s-dk-host", node("desktops.host"), on, async (want, e) => {
        const el = e && e.target;
        if (want && !(await ask(T("desktops.consent", { size: sizeText(DK.st && DK.st.sizeBytes) }), T("desktops.consentOk")))) {
          if (el) el.checked = false; // declined: nothing is saved, nothing is downloaded
          return;
        }
        await ctx.saveCall(async () => {
          const r = await ctx.deck.desktops.host(want);
          dkApply(r && r.state);
          return r && r.settings ? r.settings : ctx.settings();
        }, T("set.saved"));
        // settled (saved or failed): the switch shows what the main process holds, focused or not
        const held = () => (DK.st ? DK.st.host === true : !!(st().desktops && st().desktops.host));
        if (DK.sw) DK.sw.checked = held();
        Promise.resolve().then(() => ctx.deck.desktops.state()).then((s) => { dkApply(s); if (DK.sw) DK.sw.checked = held(); }).catch(() => {});
      }, { fk: "dk:host" });
      DK.sw = sw.querySelector("input");
      DK.status = h("p", { class: "sv-block sv-dk-status", role: "status" });
      DK.list = h("div", { class: "sv-dk-list" });
      const num = (field, label, { min, max, step = 1, value, out = Number }) => {
        const id = `s-dk-${field}`;
        const el = input(id, { type: "number", min, max, step, value, dataset: { fk: `dk:${field}` },
          onchange: (e) => { if (e.target.value !== "") ctx.save({ desktops: { [field]: out(e.target.value) } }, T("set.saved")); } });
        return row(node(label), el, { id });
      };
      const memGB = String(cur.memory || "1.5g").replace(/g$/, "");
      kids.push(group(node("desktops.title"),
        sw,
        DK.status,
        num("limit", "desktops.limit", { min: 0, max: 16, value: cur.limit ?? 3 }),
        num("memory", "desktops.memory", { min: 0.5, max: 8, step: 0.5, value: memGB, out: (v) => `${Number(v)}g` }),
        num("cpus", "desktops.cpus", { min: 1, max: 8, value: cur.cpus ?? 2 }),
        num("idleMin", "desktops.idle", { min: 5, max: 240, value: cur.idleMin ?? 20 }),
        num("homeWarnGB", "desktops.homeWarnGB", { min: 1, max: 1000, value: cur.homeWarnGB ?? 10 }),
        DK.list));
      dkPaint();
    }

    function keyOf(el) {
      const box = el.closest(".sv-section");
      const all = box ? [...box.querySelectorAll("input, select, button, textarea")] : [];
      return { id: el.id || null, fk: (el.dataset && el.dataset.fk) || null, idx: all.indexOf(el), section: box ? box.dataset.section : V.section };
    }
    function find(k) {
      if (!k) return null;
      const box = V.built.get(k.section);
      if (!box) return null;
      if (k.id) return box.querySelector(`#${CSS.escape(k.id)}`);
      if (k.fk) return box.querySelector(`[data-fk="${CSS.escape(k.fk)}"]`);
      return box.querySelectorAll("input, select, button, textarea")[k.idx] || null;
    }
    /** The user is typing (or has a select open) inside this section: never rebuild it now. */
    const typing = (box) => {
      const a = document.activeElement;
      return !!(a && box.contains(a) && (a.tagName === "TEXTAREA" || a.tagName === "SELECT" || (a.tagName === "INPUT" && !["checkbox", "radio", "button"].includes(a.type))));
    };

    function fill(id, box) {
      const kids = [h("h2", { class: "sv-title" }, node(LABEL[id]))];
      try {
        BUILDERS[id](kids, helpers);
      } catch (e) {
        kids.push(h("p", { class: "form-error" }, String((e && e.message) || e)));
      }
      box.replaceChildren(...kids.filter(Boolean));
    }

    function rebuild(id, { keepTyped = true } = {}) {
      const box = V.built.get(id);
      if (!box) return;
      const focus = document.activeElement && box.contains(document.activeElement) ? keyOf(document.activeElement) : null;
      // typed (non-secret) values survive a rebuild, except right after this section saved them (the saved, normalized
      // value shows instead); passwords are never kept. Open "Advanced" disclosures stay open.
      const typed = keepTyped ? [...box.querySelectorAll("input[id]:not([type=password]):not([type=checkbox]):not([type=radio]), textarea[id]")].filter((el) => el.value !== el.defaultValue).map((el) => [el.id, el.value]) : [];
      const opened = [...box.querySelectorAll("details")].map((el) => el.open);
      const top = box.scrollTop;
      fill(id, box);
      for (const [elId, value] of typed) { const el = box.querySelector(`#${CSS.escape(elId)}`); if (el) el.value = value; }
      [...box.querySelectorAll("details")].forEach((el, i) => { if (opened[i]) el.open = true; });
      box.scrollTop = top;
      V.stale.delete(id);
      const back = find(focus);
      if (back) back.focus({ preventScroll: true });
    }

    function show(id) {
      id = sectionOf(id);
      if (ctx.hasSection && !ctx.hasSection(id)) id = "general";
      V.section = id;
      if (ctx.store) ctx.store.set("deck.settingsSection", id);
      if (!V.built.has(id)) {
        const box = h("div", { class: "sv-section", role: "region", "aria-label": i18nText(LABEL[id]), dataset: { section: id } });
        V.built.set(id, box);
        main.appendChild(box);
        fill(id, box);
      } else if (V.stale.has(id)) rebuild(id);
      for (const [sid, box] of V.built) box.hidden = sid !== id;
      for (const b of nav.querySelectorAll(".sv-nav-item")) b.setAttribute("aria-current", b.dataset.fk === `sv-nav:${id}` ? "page" : "false");
    }

    /** Settings changed elsewhere (a save, the tray, account data): rebuild what is built, never under typing. */
    function refresh({ force = false } = {}) {
      syncReading();
      if (!root) return;
      renderNav();
      if (ctx.hasSection && !ctx.hasSection(V.section) && V.open) show("general");
      for (const [id, box] of V.built) {
        if ((id === "desktop" && readingPending) || (!force && (!V.open || id !== V.section || typing(box)))) V.stale.add(id);
        else rebuild(id);
      }
    }

    // ------------------------------------------------------------ the inline "Saved" note
    function notify(ok, text, { anchor = null } = {}) {
      if (!root) return;
      const k = anchor ? keyOf(anchor) : last;
      // a successful save shows the stored values (never under typing). A failed one reverts a switch/select/segment
      // to the stored value, but leaves a text form as typed so the user can fix it (a password is not retyped).
      const changed = find(k);
      const isForm = !!(changed && (changed.closest(".form-actions") || (changed.tagName === "INPUT" && !["checkbox", "radio"].includes(changed.type))));
      if (ok && !(k?.section === "desktop" && readingPending) && k && V.open && V.built.has(k.section) && !typing(V.built.get(k.section))) rebuild(k.section, { keepTyped: false });
      if (ok || !isForm) refresh();
      const el = find(k);
      const host = (el && el.closest(".sv-row, .toggle, .field, .form-actions")) || null;
      let slot = host ? (host.matches(".form-actions") ? host : host.querySelector(".sv-label .sv-note, .tlabel .sv-note")) : null;
      if (!slot && el) {
        const wrap = el.closest(".sv-group-wrap");
        slot = wrap && wrap.querySelector(".sv-group-title .sv-note");
      }
      if (!slot && host) slot = host.querySelector(".flabel, .tlabel");
      if (!slot) slot = root.querySelector(".sv-head .sv-note");
      for (const old of root.querySelectorAll(".sv-msg")) old.remove();
      clearTimeout(noteTimer);
      if (!slot) return;
      const msg = h("span", { class: `sv-msg ${ok ? "ok" : "bad"}`, role: ok ? "status" : "alert" }, text || i18nText("set.saved"));
      slot.appendChild(msg);
      if (ok) noteTimer = setTimeout(() => { msg.classList.add("out"); setTimeout(() => msg.remove(), 200); }, 1600);
    }

    // ------------------------------------------------------------ open / close
    function ensure() {
      if (root) return;
      build();
      const chat = document.getElementById("chat");
      if (chat) chat.appendChild(root);
    }
    function open(section) {
      if (ctx.canOpen && !ctx.canOpen()) return;
      ensure();
      const was = V.open;
      V.open = true;
      root.hidden = false;
      document.body.classList.add("sv-open");
      show(section || V.section);
      if (!was) {
        const cur = nav.querySelector('.sv-nav-item[aria-current="page"]');
        if (cur) cur.focus({ preventScroll: true });
      }
      if (ctx.onToggle) ctx.onToggle(true);
    }
    function close() {
      if (!V.open) return;
      V.open = false;
      if (root) root.hidden = true;
      document.body.classList.remove("sv-open");
      if (ctx.onToggle) ctx.onToggle(false);
    }

    document.addEventListener("deck-language", () => {
      if (!root) return;
      const section = V.section;
      const was = V.open;
      const ids = [...V.built.keys()];
      build();
      const chat = document.getElementById("chat");
      if (chat && !root.parentNode) chat.appendChild(root);
      root.hidden = !was;
      if (was || ids.includes(section)) show(section);
    });

    return { open, close, toggle: (s) => (V.open ? close() : open(s)), isOpen: () => V.open, refresh, notify, section: () => V.section, icon, updateHiddenBots, _builders: BUILDERS };
  }

  const api = { create, SECTIONS, BUSY_SEND, SOUND_PRESETS, SOUND_DEFAULTS, soundsOf, screenTabVisible, tabFor, busySendOf, sectionOf, hostLines, hostBanners, connectionState, sizeText, DOCKER_URL };
  if (typeof window !== "undefined") window.DeckSettingsView = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
