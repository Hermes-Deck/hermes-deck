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
  const SECTIONS = ["general", "hermes", "relay", "telegram", "desktop", "device"];
  const BUSY_SEND = ["queue", "steer"];

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
      relay: "M8 9.5v4M5.5 13.5h5M5.2 7.2a3.9 3.9 0 0 1 5.6 0M3.3 5.3a6.6 6.6 0 0 1 9.4 0M8 9.5a.6.6 0 1 0 0-.01",
      telegram: "M13.5 3L2.5 7.4l4 1.4M13.5 3l-2 10-5-4.2M13.5 3L6.5 8.8v3.7l2-2",
      desktop: "M2.5 3.5h11v7.5h-11zM6 13.5h4M8 11v2.5",
      device: "M4.5 4.5h7v7h-7zM6.5 2v2.5M9.5 2v2.5M6.5 11.5V14M9.5 11.5V14M2 6.5h2.5M2 9.5h2.5M11.5 6.5H14M11.5 9.5H14",
      gear: "M8 5.6a2.4 2.4 0 1 0 0 4.8a2.4 2.4 0 1 0 0-4.8zM8 1.8v1.6M8 12.6v1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M1.8 8h1.6M12.6 8h1.6M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1",
    };
    function icon(name, size = 16) {
      const s = document.createElementNS(NS, "svg");
      for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": "1.4", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) s.setAttribute(k, String(v));
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", ICONS[name] || "");
      s.appendChild(p);
      return s;
    }
    const LABEL = { general: "set.general", hermes: "set.hermes", relay: "set.relay", telegram: "set.telegram", desktop: "U0545", device: "A0241" };

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
    const input = (id, attrs = {}) => h("input", { id, autocomplete: "off", spellcheck: "false", ...attrs });
    const secretWarning = () => (st().plainSecrets ? h("p", { class: "form-error sv-warn" }, node("U0499")) : null);
    /** Host versions for this section (hostLines): one group, each line with the update command to copy. */
    function hostGroup(section) {
      const lines = hostLines(ctx.hostVersions ? ctx.hostVersions() : null, section);
      if (!lines.length) return null;
      return group(node("hostupd.group"), ...lines.map((l) => h("div", { class: "sv-row sv-block" },
        h("p", { class: `hostver ${l.level}`, role: l.level === "block" ? "alert" : "status" }, T(l.key, l.vars)),
        l.cmd ? h("p", { class: "hostver-cmd" }, T("hostupd.runOnHost"), " ", h("code", { class: "sv-path" }, l.cmd)) : null)));
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
      const u = st().updates || { auto: true, repo: "", branch: "main", hasToken: false, fromSource: false };
      const build = s ? `v${s.version}${s.commit ? ` · ${s.commit.slice(0, 7)}` : ""}${s.built ? ` (${s.built})` : ""}${s.dirty ? " *" : ""}` : "";
      const working = !!(UPD.busy || UPD.progress);
      const action = s && !s.error ? s.action : "none";
      const go = action === "release" || action === "build"
        ? h("button", { class: "btn mini primary", type: "button", disabled: working ? true : null, dataset: { fk: "upd:install" },
          onclick: () => { if (window.confirm(T(action === "release" ? "updates.confirmRelease" : "updates.confirmBuild", { tag: s.release ? s.release.tag : "", count: s.behind, branch: s.branch }))) updatesCall(() => ctx.deck.updates.install()); } },
          node(action === "release" ? "updates.installRelease" : "updates.buildMain"))
        : action === "download"
          ? h("button", { class: "btn mini", type: "button", dataset: { fk: "upd:open" }, onclick: () => ctx.deck.updates.open() }, node("updates.openRelease"))
          : null;
      const check = h("button", { class: "btn mini", type: "button", disabled: working ? true : null, dataset: { fk: "upd:check" }, onclick: () => { UPD.busy = "check"; refresh({ force: true }); updatesCall(() => ctx.deck.updates.check()); } }, node("updates.checkNow"));
      const commits = s && !s.error && s.behind > 0 && Array.isArray(s.commits) && s.commits.length
        ? h("div", { class: "sv-row sv-block" }, h("ul", { class: "upd-commits" }, ...s.commits.slice(0, 6).map((c) => h("li", null, h("code", null, c.sha), " ", c.title))),
          s.behind > 6 ? h("p", { class: "upd-more" }, T("updates.more", { count: s.behind - 6 })) : null)
        : null;
      const repo = input("s-upd-repo", { value: u.repo, placeholder: (s && s.repo) || "owner/name" });
      const branch = input("s-upd-branch", { value: u.branch || "main" });
      const token = input("s-upd-token", { type: "password", placeholder: u.hasToken ? T("U0485") : T("updates.tokenHint") });
      const saveAdv = () => ctx.save({ updates: { repo: repo.value.trim(), branch: branch.value.trim() || "main", ...(token.value ? { token: token.value } : {}) } }, T("set.saved"));
      const adv = h("details", { class: "sv-row sv-block upd-adv" }, h("summary", null, T("updates.advanced")),
        row(node("updates.repo"), repo, { id: "s-upd-repo" }), row(node("updates.branch"), branch, { id: "s-upd-branch" }),
        row(node("updates.token"), token, { id: "s-upd-token", title: T("updates.tokenHelp") }),
        switchRow("s-upd-src", node("updates.fromSource"), u.fromSource === true, (on) => ctx.save({ updates: { fromSource: on } }, T("set.saved")), { fk: "upd:src" }),
        h("div", { class: "form-actions sv-actions" }, h("button", { class: "btn mini", type: "button", dataset: { fk: "upd:save" }, onclick: saveAdv }, node("A0151"))));
      return group(node("updates.group"),
        build ? row(node("updates.thisBuild"), h("span", { class: "sv-path", title: s && s.repo ? s.repo : null }, build)) : null,
        row(node("updates.state"), h("span", { class: `upd-state${s && s.error ? " bad" : s && (s.behind > 0 || (s.release && s.release.newer)) ? " new" : ""}`, role: "status" }, updatesText(s))),
        commits,
        h("div", { class: "sv-row sv-end" }, h("span", { class: "sv-inline" }, check, go)),
        switchRow("s-upd-auto", node("updates.auto"), u.auto !== false, (on) => ctx.save({ updates: { auto: on } }, T("set.saved")), { fk: "upd:auto" }),
        adv);
    }

    BUILDERS.relay = (kids) => {
      const r = st().relay || {};
      const url = input("s-relay-url", { value: r.url || "", placeholder: "ws://<relay-host>:9330", title: T("U0484") });
      const token = input("s-relay-token", { type: "password", placeholder: r.hasToken ? T("U0485") : T("A0237") });
      const save = () => ctx.save({ relay: { url: url.value, token: token.value } }, T("U0486"));
      for (const el of [url, token]) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
      kids.push(group(null, row(node("A0236"), url, { id: "s-relay-url" }), row("Token", token, { id: "s-relay-token" })),
        h("div", { class: "form-actions sv-actions" }, h("button", { class: "btn primary", type: "button", dataset: { fk: "relay:save" }, onclick: save }, node("U0487"))),
        secretWarning(), hostGroup("relay"));
    };

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
      const hidden = input("s-hidden", { value: (s.hiddenBots || []).join(", "), placeholder: T("A0240"), title: T("U0491") });
      hidden.addEventListener("change", () => ctx.save({ hiddenBots: hidden.value }, T("U0492")));
      hidden.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); hidden.blur(); } });
      kids.push(group(node("set.tgChats"),
        row(node("U0489"), sel, { id: "s-group" }),
        row(node("A0239"), hidden, { id: "s-hidden" }),
        switchRow("s-read-receipts", node("U0494"), s.readReceipts !== false, async (on) => { await ctx.save({ readReceipts: on }, T("U0493")); ctx.readReceiptsChanged(); }, { title: T("U0495"), fk: "tg:read-receipts" })));
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
      kids.push(h("div", { class: "sv-legacy" }, box), hostGroup("hermes"));
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
      kids.push(group(node("set.appearance"), row(node("set.theme"), theme, { id: "s-theme" })));
      kids.push(group(node("wall.label"), ...["telegram", "sessions", "bots"].map(wallRow)));
      kids.push(group(node("A0186"),
        flag("notifications", node("A0186"), { title: winNote }),
        flag("sound", node("A0253"), { off: !d.notifications }),
        flag("taskbarBadge", node("set.badge"), { title: T("set.badgeHelp") }),
        h("div", { class: "sv-row sv-end" }, test)));
      kids.push(group(node("A0183"),
        flag("pet", node("A0183")),
        row(node("U0333"), skin, { id: "s-desk-petSkin", cls: d.pet ? "" : "off" }),
        row(node("set.petSize"), size, { id: "s-desk-petSize", cls: d.pet ? "" : "off" }),
        flag("petMotion", node("U0551"), { off: !d.pet, title: T("U0552") })));
      kids.push(group(node("set.window"),
        flag("closeToTray", node("U0553"), { title: T("U0554") }),
        flag("autostart", node("U0558"), { off: auto !== "ok", title: auto === "ok" ? null : auto === "mac-dev" ? T("U0556") : T("U0557") })));
    };

    // This device: what this computer hosts for agents (workspace.js, botscreen.js own their rows)
    BUILDERS.device = (kids) => {
      const ws = ctx.workspaceRows();
      const bs = ctx.botscreenRows();
      if (ws) kids.push(group(node("set.agentBrowser"), h("div", { class: "sv-legacy" }, ws)));
      // agent spaces: where agents work by default (the relay's mode) and the control level the Bot screen opens with
      if (ctx.deck.spaces) {
        const modeNote = h("span", { class: "sv-msg" });
        const mode = h("select", { id: "s-space-mode", disabled: true, dataset: { fk: "space:mode" }, onchange: (e) => ctx.saveCall(async () => {
          const r = await ctx.deck.spaces.mode(e.target.value);
          if (r && r.ok === false) throw new Error(r.error === "phase 2" ? T("space.mode.later") : r.error);
          return ctx.settings(); // the mode lives on the relay; the Deck's settings are unchanged
        }, T("set.saved")) },
          h("option", { value: "shared" }, T("space.mode.shared")),
          h("option", { value: "agent", disabled: true }, `${T("space.mode.agent")} (${T("space.mode.later")})`));
        ctx.deck.spaces.list().then((l) => {
          if (l && l.mode) {
            mode.value = l.mode;
            mode.disabled = false;
          } else modeNote.textContent = T("space.none");
        }).catch(() => (modeNote.textContent = T("space.none")));
        const lvl = segmented("s-space-level", (st().spaces && st().spaces.defaultLevel) || "watch",
          ["watch", "together", "full"].map((l) => [l, T(`space.level.${l}`), T(`space.levelHelp.${l}`)]),
          (v) => ctx.save({ spaces: { defaultLevel: v } }, T("set.saved")));
        kids.push(group(node("space.mode"),
          row(node("space.mode"), h("span", { class: "sv-inline" }, mode, modeNote), { id: "s-space-mode-row", title: T("space.modeHelp") }),
          row(node("space.defaultLevel"), lvl, { id: "s-space-level-row" })));
      }
      if (bs) kids.push(group(node("U0478"), h("div", { class: "sv-legacy", id: "s-device" }, bs),
        ctx.screenTab() ? h("div", { class: "sv-row sv-end" }, h("button", { class: "linkbtn sv-link", type: "button", dataset: { fk: "bs:open" }, onclick: () => { close(); ctx.openScreen(); } }, node("set.openScreen"))) : null));
    };

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
      if (!root) return;
      renderNav();
      if (ctx.hasSection && !ctx.hasSection(V.section) && V.open) show("general");
      for (const [id, box] of V.built) {
        if (!force && (!V.open || id !== V.section || typing(box))) V.stale.add(id);
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
      if (ok && k && V.open && V.built.has(k.section) && !typing(V.built.get(k.section))) rebuild(k.section, { keepTyped: false });
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

    return { open, close, toggle: (s) => (V.open ? close() : open(s)), isOpen: () => V.open, refresh, notify, section: () => V.section, icon, _builders: BUILDERS };
  }

  const api = { create, SECTIONS, BUSY_SEND, screenTabVisible, tabFor, busySendOf, sectionOf, hostLines, hostBanners };
  if (typeof window !== "undefined") window.DeckSettingsView = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
