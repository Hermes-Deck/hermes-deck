"use strict";
var i18nNode = (key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).node(key, vars, typeof document === "object" ? document : null);
var i18nBind = (el, attr, key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).bind(el, attr, key, vars);
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
var i18nLocale = typeof module === "object" && module.exports ? require("./i18n").getLocale : window.DeckI18n.getLocale;
// Hermes Deck renderer. Plain DOM, no framework: state in S, render functions per region, and a
// throttled scheduler. Every string from Telegram or the relay goes in via textContent, never HTML.
(() => {
  const deck = window.deck;
  const CM = window.DeckChatModes;
  const CHAT_TEXT = CM.TEXT;
  let activeChatMode = null;
  let displayedChat = null;
  let lastDesktopView = "";
  let hostSwitchPending = false;
  let pendingSourceOpen = null;
  let sourceOpenReady = false;
  let sourceRequestsReady = false;
  let remoteHosts = [];
  let firstRunChat = null;
  let firstRunStep = 0;
  let firstRunDevice = null;
  let firstRunDeviceLoading = false;
  let firstRunDeviceAttempted = false;
  let firstRunPrefs = null;
  let languageRestore = null;
  let languageSaves = 0;
  const FIRST_RUN_STEPS = ["chat", "bridge", "relay", "device", "preferences"];
  const chatModes = () => CM.enabled(S.settings && S.settings.chat);
  const chatMode = () => activeChatMode || CM.start(S.settings && S.settings.chat);

  // ---------------------------------------------------------------- helpers
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "dataset") Object.assign(el.dataset, v);
        else if (k === "style") for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
        else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const c of kids.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return el;
  }
  const SVGNS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    return el;
  }

  const nowS = () => Date.now() / 1000;
  // readable counts and durations come from human.js (one formatter for every view)
  const k = (n) => window.DeckHuman.count(n || 0);
  const hm = (ts) => new Date(ts * 1000).toLocaleTimeString(i18nLocale(), { hour: "2-digit", minute: "2-digit" });
  const ago = (ts) => {
    const d = nowS() - ts;
    if (d < 45) return i18nText("U0402");
    if (d < 3600) return i18nText("U0403", { v: Math.round(d / 60) });
    if (d < 86400) return i18nText("U0404", { v: Math.round(d / 3600) });
    return i18nText("U0405", { v: Math.round(d / 86400) });
  };
  const dur = (ms) => window.DeckHuman.duration(ms);
  const since = (ts) => dur(Math.max(0, (nowS() - ts) * 1000));
  const dayKey = (ts) => new Date(ts * 1000).toLocaleDateString("sv-SE");
  const dayLabel = (ts) => {
    const d = dayKey(ts);
    if (d === dayKey(nowS())) return i18nText("U0406");
    if (d === dayKey(nowS() - 86400)) return i18nText("U0407");
    return new Date(ts * 1000).toLocaleDateString(i18nLocale(), { day: "numeric", month: "long" });
  };
  const cleanErr = (e) => window.DeckI18n.errorText(String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
  const MEDIA_TR = {
    get photo() { return i18nText("U0274"); }, get voice() { return i18nText("A0155"); }, video: "video", get round() { return i18nText("U0306"); }, gif: "GIF", get audio() { return i18nText("common.audio"); }, get sticker() { return i18nText("U0275"); },
    get file() { return i18nText("common.file"); }, get geo() { return i18nText("common.location"); }, get contact() { return i18nText("U0408"); }, get poll() { return i18nText("common.poll"); }, get dice() { return i18nText("common.dice"); }, get unsupported() { return i18nText("A0213"); }, get other() { return i18nText("common.attachment"); },
  };
  // message media is a record ({kind, name, ...}); older records used a plain string ("photo", "file:<name>")
  const mediaLabel = (m) => {
    if (!m) return "";
    if (typeof m === "string") return m.startsWith("file:") ? i18nText("common.fileName", { v: m.slice(5) }) : MEDIA_TR[m] || m;
    if (m.kind === "file" && m.name) return i18nText("common.fileNamed", { name: m.name });
    if (m.kind === "sticker" && m.alt) return i18nText("U0409", { alt: m.alt });
    return MEDIA_TR[m.kind] || i18nText("common.attachment");
  };
  const STATE_TR = { get running() { return i18nText("U0410"); }, get idle() { return i18nText("U0281"); }, get done() { return i18nText("common.done"); }, get failed() { return i18nText("common.error"); }, get stopped() { return i18nText("common.stopped"); }, get stale() { return i18nText("common.stale"); } };

  // ---------------------------------------------------------------- state
  const S = {
    relay: { status: "starting", error: null, agents: {}, sessions: new Map(), fleet: null, tokens: [] },
    tg: { status: "starting", step: null, error: null, detail: null, hint: null, viaApp: false, me: null, group: null, bots: [], topics: [] },
    settings: null,
    formBusy: false,
    avatars: {}, // chat key -> data: URL (Telegram profile photo)
    msgs: new Map(), // chat key -> Map(id -> message)
    loaded: new Set(),
    loading: new Set(),
    unread: new Map(),
    typing: new Map(), // chat key -> ts
    sel: null,
    tab: "", // the open right-slot tab by its old id (activity, usage, workspace, screen, ...); "" when the slot is closed
    open: new Set(), // session ids with their tool list expanded
    details: new Map(), // sid -> /session detail (recent tools), kept live by events
    sending: false,
    note: null,
    noteBad: false,
  };
  let scrollToEnd = false;

  // multi-host: drafts, outbox and selections are per host (the first host keeps the old, unprefixed keys)
  const pageHost = new URLSearchParams(location.search).get("host") || "";
  const hostKey = (key) => (pageHost && pageHost !== "h1" ? `${pageHost}/${key}` : key);
  const store = {
    get(key) {
      try {
        return localStorage.getItem(hostKey(key));
      } catch {
        return null;
      }
    },
    set(key, v) {
      try {
        localStorage.setItem(hostKey(key), v);
      } catch {
        /* per-viewer convenience only */
      }
    },
  };

  // ---------------------------------------------------------------- derived views
  const agentList = () => Object.values(S.relay.agents || {});
  const agentForBot = (username) =>
    agentList().find((a) => a.bot && username && a.bot.toLowerCase() === username.toLowerCase()) || null;

  /** Rail order is stable (relay config order, then other bots) so positions never jump while agents work. */
  function railAgents() {
    const items = [];
    const used = new Set();
    const hidden = new Set(((S.settings && S.settings.hiddenBots) || []).map((v) => v.toLowerCase()));
    const bots = S.tg.bots.filter((b) => !b.username || !hidden.has(b.username.toLowerCase()));
    for (const a of agentList()) {
      const bot = bots.find((b) => b.username && a.bot && b.username.toLowerCase() === a.bot.toLowerCase());
      if (bot) {
        items.push({ key: bot.key, bot, agent: a });
        used.add(bot.key);
      }
    }
    for (const b of bots) if (!used.has(b.key)) items.push({ key: b.key, bot: b, agent: null });
    return items;
  }

  function scopeOf(key) {
    if (!key) return null;
    if (key[0] === "u") {
      const bot = S.tg.bots.find((b) => b.key === key) || null;
      return { kind: "dm", key, bot, agent: bot ? agentForBot(bot.username) : null };
    }
    const tid = key.slice(1);
    return { kind: "topic", key, tid, topic: S.tg.topics.find((t) => String(t.id) === tid) || null };
  }

  const threadIs = (thread, tid) => thread === tid || thread === `t${tid}`;
  const stateOf = (s) => (s.stale ? "stale" : s.state);
  const isLive = (s) => s.state === "running" && !s.stale;

  function inChat(s, sc) {
    if (!sc) return false;
    if (sc.kind === "dm") return s.chat === (S.tg.me && S.tg.me.id) && !s.thread;
    return S.tg.group && s.chat === S.tg.group.id && threadIs(s.thread, sc.tid);
  }

  function sessionsFor(key) {
    const sc = scopeOf(key);
    if (!sc) return [];
    const top = [...S.relay.sessions.values()].filter((s) => !s.parent);
    let list;
    if (sc.kind === "dm") list = sc.agent ? top.filter((s) => s.agent === sc.agent.name) : [];
    else list = top.filter((s) => inChat(s, sc));
    return list.sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.lastTs - a.lastTs).slice(0, 25);
  }

  /** The session the status card follows for this chat (this chat only): running first, then the latest. */
  function liveFor(key) {
    const sc = scopeOf(key);
    const list = sessionsFor(key).filter((s) => inChat(s, sc));
    return list.find(isLive) || list[0] || null;
  }

  function agentStatus(a) {
    if (!a) return i18nText("time.unmonitored");
    if (a.running) return i18nText("U0410");
    if (a.subsRunning) return i18nText("U0411", { subsRunning: a.subsRunning });
    let last = null;
    for (const s of S.relay.sessions.values()) if (!s.parent && s.agent === a.name && (!last || s.lastTs > last.lastTs)) last = s;
    return last ? i18nText("U0412", { lastTs: ago(last.lastTs) }) : i18nText("U0413");
  }

  function latestTop(agentName) {
    let best = null;
    for (const s of S.relay.sessions.values()) {
      if (s.parent || s.agent !== agentName || !s.ctxLen) continue;
      if (!best || s.lastTs > best.lastTs) best = s;
    }
    return best;
  }

  const kidsOf = (s) => (s.children || []).map((c) => S.relay.sessions.get(c)).filter(Boolean);
  const typingNow = (key) => nowS() - (S.typing.get(key) || 0) < 6;

  function lastMsg(key, fallback) {
    const m = S.msgs.get(key);
    if (m && m.size) {
      let best = null;
      for (const x of m.values()) if (!best || x.id > best.id) best = x;
      return best;
    }
    return fallback || null;
  }

  // ---------------------------------------------------------------- pieces
  function coin(name, { size = 36, fill = null, live = false, subs = 0, img = null } = {}) {
    const r = size / 2 - 2;
    const c = 2 * Math.PI * r;
    const rim = svg("svg", { class: "rim", width: size, height: size, viewBox: `0 0 ${size} ${size}`, "aria-hidden": "true" });
    rim.appendChild(svg("circle", { class: "track", cx: size / 2, cy: size / 2, r }));
    if (fill !== null && isFinite(fill)) {
      const f = Math.max(0.03, Math.min(1, fill));
      const lvl = f >= 0.9 ? "bad" : f >= 0.7 ? "warn" : "";
      rim.appendChild(svg("circle", { class: `arc ${lvl}`, cx: size / 2, cy: size / 2, r, "stroke-dasharray": `${(f * c).toFixed(1)} ${c.toFixed(1)}` }));
    }
    const title = fill !== null && isFinite(fill) ? i18nText("U0414", { v: Math.round(fill * 100) }) : null;
    return h(
      "span",
      { class: `coin${live ? " live" : ""}`, style: { "--s": `${size}px` }, title },
      rim,
      h("span", { class: `face${img ? " photo" : ""}`, "aria-hidden": "true" }, img ? h("img", { src: img, alt: "", draggable: "false" }) : (name || "?").slice(0, 1).toUpperCase()),
      subs ? h("span", { class: "subs", title: i18nText("U0280", { subs: subs }) , "data-i18n-title": "U0280", "data-i18n-title-vars": JSON.stringify({ subs: subs })}, `+${subs}`) : null
    );
  }

  const ticker = (ts, prefix = "") => h("span", { dataset: { since: String(ts), prefix } }, prefix + since(ts));

  function renderText(text, ents) {
    const frag = document.createDocumentFragment();
    if (!ents || !ents.length) {
      frag.appendChild(document.createTextNode(text));
      return frag;
    }
    const cuts = new Set([0, text.length]);
    for (const e of ents) {
      cuts.add(Math.max(0, e.o));
      cuts.add(Math.min(text.length, e.o + e.l));
    }
    const pts = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (a >= b) continue;
      let node = document.createTextNode(text.slice(a, b));
      for (const e of ents) if (e.o <= a && e.o + e.l >= b) node = wrapEntity(node, e);
      frag.appendChild(node);
    }
    return frag;
  }

  const ENTITY_TAG = {
    MessageEntityBold: "strong",
    MessageEntityItalic: "em",
    MessageEntityUnderline: "u",
    MessageEntityStrike: "s",
    MessageEntityCode: "code",
    MessageEntityPre: "pre",
    MessageEntityBlockquote: "blockquote",
    MessageEntitySpoiler: "span",
    MessageEntityTextUrl: "a",
    MessageEntityUrl: "a",
    // rich messages only (main/telegram.js richOf): highlight, sub/superscript, a button label inside
    // the text (it works only in Telegram), and a placeholder for an inline picture not shown here
    RichMarked: "mark",
    RichSub: "sub",
    RichSup: "sup",
    RichButton: "span",
    RichGap: "span",
  };
  const ENTITY_CLASS = { MessageEntitySpoiler: "spoiler", RichButton: "rich-ibtn", RichGap: "rich-gapword" };
  function wrapEntity(node, e) {
    const tag = ENTITY_TAG[e.t];
    if (!tag) return node;
    const el = document.createElement(tag);
    if (tag === "a") {
      const href = e.t === "MessageEntityTextUrl" ? e.url : node.textContent;
      if (!/^https?:\/\//i.test(href || "")) return node;
      el.className = "lnk";
      el.dataset.url = href;
      el.setAttribute("role", "link");
      el.setAttribute("tabindex", "0");
    }
    if (ENTITY_CLASS[e.t]) el.className = ENTITY_CLASS[e.t];
    if (e.t === "RichButton") i18nBind(el, "title", "U0415");
    el.appendChild(node);
    return el;
  }

  // ---------------------------------------------------------------- regions
  const els = {
    sum: document.getElementById("sum"),
    conn: document.getElementById("conn"),
    rail: document.getElementById("rail"),
    head: document.getElementById("head"),
    msgs: document.getElementById("msgs"),
    msgsInner: document.getElementById("msgs-inner"),
    input: document.getElementById("input"),
    send: document.getElementById("send"),
    note: document.getElementById("note"),
    crumb: document.getElementById("crumb"),
    modes: document.getElementById("modes"),
    find: document.getElementById("find-btn"),
  };
  if (/Mac/i.test(navigator.platform)) document.body.classList.add("mac");
  // the Blend shell (shell.js): sidebar | main | right slot, the top bar's toggles and the mount API for other modules
  const SH = window.DeckShell;

  // message view (msgview.js): media, senders, replies, inline buttons, context menu, reply bar
  // inline voice-note player (voice-bubble.js): Hermes audio files and Telegram voice notes
  const VB = window.DeckVoiceBubble.create({ h, mark, cleanErr });
  const MV = window.DeckMsgView.create({ h, S, deck, els, renderText, hm, mediaLabel, cleanErr, mark, VB });
  // forum topic management in the rail (topics.js): create, rename, close, pin, delete
  const TP = window.DeckTopics.create({ h, S, deck, els, MV, select, mark, cleanErr });
  // file attachments in the composer (attach.js, A7): picker, drop, paste, upload progress and cancel
  const AT = window.DeckAttach.create({
    h, S, deck, els, MV, mark, cleanErr, renderNote,
    hermesMode: () => hermesMode(),
    hermesKey: () => H.sel,
    hermesReady: () => bridgeOpen(),
    hermesBusy: () => H.sending,
    sendHermes: (tokens, names, previews) => hermesSend(tokens, names, { previews }),
    setChannel: (v) => setChatChannel(v),
    draftSent: (key, text) => DR.sent(key, text),
    onSent: (m) => {
      msgMap(m.key).set(m.id, m);
      scrollToEnd = true;
      mark("msgs", "rail");
    },
  });
  // messages written while the session is busy wait here (outbox.js); echo-match.js pairs sent turns with stored ones
  const OB = window.DeckOutbox.create({ store, h, i18nText, i18nNode });
  const EM = window.DeckEchoMatch;
  // the live "working" row at the end of the transcript (live-activity.js) and what Enter does while busy (busy-send.js)
  const LA = window.DeckLiveActivity.create({
    h, i18nText, ticker, store,
    onToggle: (open) => {
      deck.bridge.reasoning(open).catch(() => {});
      mark("msgs", true);
    },
  });
  // the collapsed "Thinking" block of a finished assistant message (think-block.js)
  const TB = window.DeckThinkBlock.create({ h, i18nText });
  const BS = window.DeckBusySend;
  const TK = window.DeckTakeover.create({
    takeover: (sid, opts) => deck.bridge.takeover(sid, opts),
    changed: () => renderNote(),
    error: e => { S.note = cleanErr(e); S.noteBad = true; },
    completed: () => { S.note = i18nText("takeover.restarted"); S.noteBad = false; },
  });
  let PK = null; // the model and reasoning chips left of Send (model-picker.js); created below with the Hermes state
  // per-chat drafts (drafts.js): the message box shows the draft of the chat on screen, keyed like the attachment tray
  const DR = window.DeckDrafts.create({ els, attachments: AT, storage: store, key: () => AT.key(), autosize: () => autosize(), after: () => renderNote() });
  // sub-agent views (agents.js): B1 detail in the chat column, B2 running list, B3 full tool calls,
  // B4 sub-agent tree, A13 role/OMH labels, F2 folded prompt context
  const AG = window.DeckAgents
    ? window.DeckAgents.create({
      h, S, deck, mark, k, dur, ago, hm, ticker, stateOf, isLive, STATE_TR, where, cleanErr, kidsOf, nums, toolToggle, toolList, toggleTools, store,
      cardControls: (sid) => hermesCardControls(sid),
      splitPrompt: (t) => splitPromptPrefix(t),
    })
    : null;
  // Activity panel (activity-view.js): one tree of sessions and sub-agents, one status vocabulary, an overflow menu per row
  const AV = window.DeckActivity && AG
    ? window.DeckActivity.create({
      h, k, dur, ago, ticker, kidsOf, mark, store, toolList, toggleTools,
      sessions: () => S.relay.sessions,
      nodeOf: (sid) => H.nodes.get(sid) || null,
      whereOf: (s) => where(s),
      titleOf: (s) => AG.titleOf(s) || i18nText(s.parent ? "common.subagent" : "common.session"),
      askEl: (s) => AG.ask(s),
      openDetail: (sid) => AG.open(sid),
      isOpenTools: (sid) => S.open.has(sid),
      retryIndex: () => window.DeckAgents.retryIndex(S.relay.sessions.values()),
      actions: (sid) => hermesControlItems(sid),
      controlBox: (sid) => hermesControlBox(sid),
    })
    : null;
  // C5 read receipts (readsync.js): the newest message really looked at goes to main, which batches it
  // and marks the chat read on Telegram (only with the setting on and the window in front)
  const RS = window.DeckReadSync;
  const readsOn = () => !S.settings || S.settings.readReceipts !== false;
  const reads = RS.create({
    viewing: () =>
      readsOn() && S.tg.status === "open" && !!S.sel && S.loaded.has(S.sel) && !hermesMode() && !(AG && AG.isOpen()) &&
      document.visibilityState === "visible" && document.hasFocus(),
    seen: () => ({ key: S.sel, maxId: seenMax() }),
    send: (key, maxId) => deck.markRead(key, maxId),
  });
  /** Newest message of the open chat with any part inside the message column's viewport. */
  function seenMax() {
    const box = els.msgs.getBoundingClientRect();
    const items = [...els.msgsInner.querySelectorAll(".msg[data-mid], .svcmsg[data-mid]")].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: Number(el.dataset.mid), top: r.top, bottom: r.bottom };
    });
    return RS.visibleMax({ top: box.top, bottom: box.bottom }, items);
  }

  // Keep the native select mounted: live status changes must not close its menu or steal keyboard focus.
  const hostSelect = h("select", { id: "host-select", "aria-describedby": "host-status", dataset: { fk: "host-select" }, onchange: (e) => selectHost(e.target.value) });
  const hostStatus = h("div", { class: "host-status", id: "host-status" });
  const hostControl = h("div", { class: "host-control", hidden: true },
    h("label", { class: "sr-only", for: "host-select" }, i18nNode("hosts.select")),
    h("div", { class: "host-choice" }, SH.icon("server", 14), hostSelect, SH.icon("down", 12)), hostStatus);
  document.getElementById("topbar-end").before(hostControl);
  let hostOptions = "";
  function renderHosts() {
    const s = S.settings, hosts = s?.hosts || [];
    hostControl.hidden = !s?.firstRunDone || !hosts.length;
    if (hostControl.hidden) return;
    const options = hosts.map(x => [x.id, x.name]);
    const sig = JSON.stringify(options);
    if (sig !== hostOptions) {
      hostOptions = sig;
      hostSelect.replaceChildren(...options.map(([id, name]) => h("option", { value: id }, name)));
    }
    hostSelect.value = s.activeHost;
    hostSelect.title = hosts.find(x => x.id === s.activeHost)?.name || "";
    hostSelect.disabled = hostSwitchPending;
    const states = [
      ["hosts.relay", SVM.connectionState(!!(s.relay?.url && s.relay?.hasToken), S.relay.status)],
      ["hosts.sessions", SVM.connectionState(s.bridge?.mode && s.bridge.mode !== "off", H.status.status)],
    ];
    hostStatus.replaceChildren(...states.map(([label, state]) => {
      const text = `${i18nText(label)}: ${i18nText(`hosts.state.${state}`)}`;
      return h("span", { title: text, "aria-label": text, class: state === "open" ? "ok" : "" },
        ...(state === "open" ? [SH.icon("check", 12), i18nText(label)] : [`${i18nText(label)}: ${i18nText(`hosts.short.${state}`)}`]));
    }));
  }
  async function selectHost(id) {
    if (hostSwitchPending || id === S.settings?.activeHost) return;
    if (window.DeckInbox?.mail?.hasUnsaved()) { MV.toast(i18nText("mail.leaveBlocked")); renderHosts(); return; }
    DR.flush(); // persist the old host's current draft before main reloads this page
    hostSwitchPending = true;
    renderStrip();
    renderHosts();
    publishDesktopView();
    try {
      await deck.hosts.select(id); // existing guarded path owns consent reset and navigation
    } catch (e) {
      hostSwitchPending = false;
      renderStrip();
      renderHosts();
      publishDesktopView();
      MV.toast(i18nText("common.saveFailed", { e: cleanErr(e) }));
    }
  }
  if (deck.hosts?.onEvent) deck.hosts.onEvent(e => {
    if (e?.t !== "requests") return;
    remoteHosts = Array.isArray(e.hosts) ? e.hosts : [];
    SV.refresh();
  });

  function renderTop() {
    const agents = agentList();
    const running = agents.reduce((n, a) => n + (a.running ? 1 : 0), 0);
    const subs = agents.reduce((n, a) => n + (a.subsRunning || 0), 0);
    // idle shows nothing: the sidebar line only speaks while agents run
    els.sum.replaceChildren(
      S.relay.status !== "open" || !(running || subs)
        ? ""
        : h("span", { class: "live" }, i18nNode("U0416", { running: running, v: subs ? i18nText("A0214", { subs: subs }) : "" }))
    );
    const r = S.relay;
    const t = S.tg;
    const relayCls = r.status === "open" ? "ok" : r.status === "connecting" || r.status === "starting" ? "warn" : "bad";
    const tgCls = t.status === "open" ? "ok" : t.status === "connecting" || t.status === "starting" ? "warn" : "bad";
    const relayTxt = r.status === "open" ? i18nText("U0418") : r.status === "closed" ? i18nText("A0215", { v: r.error ? ` (${r.error})` : "" }) : r.status === "unconfigured" ? i18nText("U0235") : i18nText("U0419");
    const tgTxt = t.status === "open" ? i18nText("U0420") : t.status === "error" ? i18nText("U0421") : t.status === "setup" || t.status === "login" ? i18nText("U0422") : i18nText("U0423");
    els.conn.replaceChildren(
      ...[
        h("span", { class: relayCls }, h("span", { class: "dot" }), relayTxt),
        h("span", { class: tgCls, hidden: !chatModes().includes("telegram") || (S.settings && !S.settings.firstRunDone) }, h("span", { class: "dot" }), tgTxt),
        hermesConn(),
      ].filter(Boolean)
    );
    renderModes();
    renderFind();
    SH.publish("mode", { mode: chatMode(), modes: chatModes() }); // sent only when it changed
    if (!hermesMode()) SH.setMain("chat"); // the inbox belongs to the Hermes modes
    SH.publish("needs", { count: pendingCount() });
  }

  /** The sidebar's mode switch (Telegram | Sessions | Bots): only enabled modes, hidden when there is just one. */
  function renderModes() {
    const modes = CM.switchItems(S.settings && S.settings.chat);
    const off = !modes.length || !S.settings || !S.settings.firstRunDone;
    els.modes.hidden = off;
    if (off) {
      els.modes.replaceChildren();
      return;
    }
    const cur = chatMode();
    els.modes.replaceChildren(...modes.map((v) => h("button", { type: "button", class: v === cur ? "on" : null, "aria-pressed": v === cur ? "true" : "false",
      title: `${CHAT_TEXT.labels[v]} · ${CHAT_TEXT.shortcut}`, dataset: { fk: `chan:${v}`, mode: v }, onclick: () => setChatChannel(v) },
    SH.icon(v === "telegram" ? "telegram" : v === "bots" ? "bots" : "sessions", 13), h("span", null, CHAT_TEXT.labels[v]))));
  }

  /** Top bar search: the All sessions browser (sessions-browser.js); it belongs to the Hermes modes. */
  function renderFind() {
    const sb = allSessionsView();
    els.find.hidden = !sb || !hermesMode();
    els.find.setAttribute("aria-pressed", sb && sb.isOpen() ? "true" : "false");
  }
  function toggleFind() {
    const sb = allSessionsView();
    if (!sb || !hermesMode()) return;
    SV.close();
    UD.close(false);
    SH.setMain("chat");
    if (sb.isOpen()) sb.close();
    else sb.show();
    renderFind();
  }

  function syncChatMode(v) {
    if (v !== activeChatMode) RG.leave(H.sel);
    activeChatMode = chatModes().includes(v) ? v : CM.start(S.settings && S.settings.chat);
    if (BT && activeChatMode === "sessions" && BT.isDraft(H.sel)) H.sel = null;
    if (BT && activeChatMode !== "telegram") BT.setView(activeChatMode);
    if (BT) BT.onModeChange();
    if (hermesMode()) hermesAutoSelect();
    hermesPoll();
    refreshSettingsPane();
    mark("panel", "top", "rail", "head", "msgs", "strip", true);
    renderNote();
  }

  function setChatChannel(v) {
    if (!S.settings || !S.settings.firstRunDone || !chatModes().includes(v) || chatMode() === v) return;
    syncChatMode(v);
  }

  // ---------------------------------------------------------------- layout: the Blend shell (shell.js)
  // Widths, the hidden sidebar (Ctrl/Cmd+B), the right slot (the Work pane: Ctrl/Cmd+\\, its Session tab: Ctrl/Cmd+Alt+I) and their
  // gutters live in shell.js. Here: the rail's collapsible sections and the shortcuts that reach app state.
  const layout = {
    compact: false, // the old coin-only rail is gone: a hidden sidebar replaces it
    closed: new Set((store.get("deck.closed") || "").split(",").filter(Boolean)), // collapsed rail sections
  };
  function toggleSection(id) {
    if (layout.closed.has(id)) layout.closed.delete(id);
    else layout.closed.add(id);
    store.set("deck.closed", [...layout.closed].join(","));
    mark("rail", true);
  }
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "h") {
      e.preventDefault();
      setChatChannel(CM.next(S.settings && S.settings.chat, chatMode()));
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === ",") {
      e.preventDefault();
      SV.toggle(); // Settings view (settings-view.js)
    }
    // Ctrl/Cmd+K: search (the All sessions browser); Ctrl/Cmd+Shift+K: the model picker (model-picker.js).
    // Ctrl+M is the window menu's Minimize, Ctrl+Shift+M is dictation.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k" && !e.isComposing) {
      e.preventDefault();
      if (!e.shiftKey) return toggleFind();
      if (!PK) return;
      if (PK.isOpen()) PK.close(true);
      else PK.openModel();
    }
  });
  els.find.addEventListener("click", () => toggleFind());
  // a rail click (a chat, All sessions) shows what was clicked: the Settings view steps aside, the chat takes the main area
  els.rail.addEventListener("click", (e) => {
    SV.close();
    UD.close(false);
    if (e.target && e.target.closest && e.target.closest(".row")) SH.setMain("chat");
  });
  SH.setHold((el) => holdRegion(el));

  function sectionHead(id, label, count) {
    const closed = layout.closed.has(id);
    return h(
      "button",
      { class: "eyebrow", type: "button", "aria-expanded": closed ? "false" : "true", dataset: { fk: `sec:${id}` }, onclick: () => toggleSection(id) },
      h("span", null, h("span", { class: "chev", "aria-hidden": "true" }, closed ? "▸" : "▾"), label),
      h("span", null, String(count || ""))
    );
  }

  function renderRail() {
    if (hermesModeCheck()) return renderHermesRail();
    allSessionsView()?.close(); // All sessions belongs to the Hermes modes
    const rail = els.rail;
    const items = railAgents();
    const kids = [];
    kids.push(sectionHead("agents", i18nText("shell.telegramChats"), items.length));
    if (!items.length) {
      kids.push(h("p", { class: "rail-note" }, S.tg.status === "open" ? i18nNode("U0430") : i18nNode("U0431")));
    }
    if (!layout.closed.has("agents") || layout.compact) for (const it of items) kids.push(agentRow(it));
    if (TP.showSection()) {
      // topics.js: "+" (create form) on the header when this account may manage topics
      kids.push(TP.head(sectionHead("topics", S.tg.group ? i18nText("U0432", { title: S.tg.group.title }) : i18nText("U0433"), S.tg.topics.length)));
      kids.push(TP.formAt("head"));
      if (!layout.closed.has("topics")) for (const t of S.tg.topics) kids.push(topicRow(t), TP.formAt(t.key));
    }
    rail.replaceChildren(...kids.filter(Boolean));
  }

  function agentRow({ key, bot, agent }) {
    const a = agent;
    const top = a ? latestTop(a.name) : null;
    const fill = top && top.ctxLen ? top.ctxUsed / top.ctxLen : null;
    const live = !!(a && (a.running || a.subsRunning));
    const name = a ? a.name : bot.title || bot.username;
    let sub;
    if (a && a.curTool) sub = h("span", { class: "sub live" }, ticker(a.curTool.since, `${a.curTool.tool} · `));
    else if (live) sub = h("span", { class: "sub live" }, a.subsRunning ? i18nNode("U0411", { subsRunning: a.subsRunning }) : i18nNode("U0410"));
    else if (typingNow(key)) sub = h("span", { class: "sub live" }, i18nNode("U0434"));
    else {
      const m = lastMsg(key, bot.last);
      sub = h("span", { class: "sub" }, m ? `${m.out ? "Sen: " : ""}${m.text ? m.text.replace(/\s+/g, " ") : mediaLabel(m.media) || ""}` : `@${bot.username}`);
    }
    const m = lastMsg(key, bot.last);
    const unread = S.unread.get(key) || 0;
    const canHide = chatMode() === "telegram" && !agent && !!bot.username;
    let menuKeyAt = 0;
    return h(
      "button",
      { class: "row agent", type: "button", title: name, "aria-current": S.sel === key ? "true" : null, dataset: { fk: `row:${key}` }, onclick: () => select(key),
        oncontextmenu: canHide ? (e) => {
          e.preventDefault();
          if (Date.now() - menuKeyAt < 500) return;
          openBotMenu(key, e.currentTarget, e.clientX === 0 && e.clientY === 0 ? null : { x: e.clientX, y: e.clientY });
        } : null,
        onkeydown: canHide ? (e) => {
          if (!(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) return;
          e.preventDefault();
          menuKeyAt = Date.now();
          openBotMenu(key, e.currentTarget, null);
        } : null },
      coin(name, { fill, live, subs: a ? a.subsRunning : 0, img: S.avatars[key] }),
      h("span", { class: "who" }, h("span", { class: "name" }, name), sub),
      h("span", { class: "meta" }, m ? hm(m.date) : "", unread ? h("span", { class: "badge", "aria-label": i18nText("U0435", { unread: unread }) , "data-i18n-aria-label": "U0435", "data-i18n-aria-label-vars": JSON.stringify({ unread: unread })}, String(unread)) : null)
    );
  }

  function openBotMenu(key, row, pos) {
    const item = railAgents().find((it) => it.key === key);
    if (chatMode() !== "telegram" || !item || item.agent || !item.bot.username) return;
    MV.openMenu([{ label: i18nText("hiddenBots.hide"), run: async () => {
      const current = railAgents().find((it) => it.key === key);
      if (chatMode() !== "telegram" || !current || current.agent || !current.bot.username) return;
      try {
        if (await SV.updateHiddenBots(current.bot.username)) MV.toast(i18nText("hiddenBots.hidden"));
      } catch (e) { MV.toast(cleanErr(e)); }
    } }], row, pos, i18nText("hiddenBots.menu", { username: item.bot.username }));
  }

  function topicRow(t) {
    const unread = S.unread.get(t.key) || 0;
    const sc = { kind: "topic", tid: String(t.id) };
    const live = [...S.relay.sessions.values()].some((s) => !s.parent && isLive(s) && inChat(s, sc));
    const row = h(
      "button",
      { class: `row topic${unread ? " unread" : ""}`, type: "button", "aria-current": S.sel === t.key ? "true" : null, dataset: { fk: `row:${t.key}` }, onclick: () => select(t.key) },
      h("span", { class: "hash", "aria-hidden": "true" }, "#"),
      h("span", { class: "name" }, t.title),
      h("span", { class: "meta" }, live ? h("span", { class: "livedot", title: i18nText("U0436") , "data-i18n-title": "U0436"}) : null, unread ? h("span", { class: "badge" }, String(unread)) : null)
    );
    return TP.decorate(t, row); // closed/pinned marks and colour (topics.js)
  }

  /**
   * What the chat on screen is, in one record: the top bar's breadcrumb and channel chip draw from it and the shell
   * sends it as the "session" event (shell.js). Facts only, from the real mode and session state.
   */
  function currentChat() {
    const mode = chatMode();
    if (!S.settings || !S.settings.firstRunDone) return { mode, kind: null, id: null };
    if (!hermesMode()) {
      const sc = scopeOf(S.sel);
      if (!sc) return { mode, kind: "telegram", id: null, channel: SH.channelOf({ mode }) };
      const sess = S.relay.status === "open" ? liveFor(S.sel) : null;
      const agent = sc.kind === "dm" ? (sc.agent ? sc.agent.name : sc.bot ? sc.bot.title || sc.bot.username : "") : S.tg.group ? S.tg.group.title : "";
      const title = sc.kind === "dm" ? (sc.bot && sc.bot.username ? `@${sc.bot.username}` : "") : `# ${sc.topic ? sc.topic.title : sc.tid}`;
      return { mode, kind: "telegram", id: S.sel, key: S.sel, sid: sess ? sess.sid : null, agent, title, profile: sc.agent ? sc.agent.profile || null : null,
        channel: SH.channelOf({ mode }) };
    }
    const sid = H.sel;
    if (!sid) return { mode, kind: "hermes", id: null, channel: SH.channelOf({ mode }) };
    const n = H.nodes.get(sid) || null;
    const st = H.hist.get(sid);
    const profile = (n && n.profile) || (st && st.profile) || "default";
    const agentName = (agentList().find((a) => a.profile === profile) || {}).name || (profile === "default" ? i18nText("shell.defaultAgent") : profile);
    const bot = BT && BT.headFor(sid);
    const sub = isSubagent(n);
    const parent = sub && n.parent ? H.nodes.get(n.parent) || null : null;
    const readOnly = !!allSessionsView()?.readOnly(sid);
    return { mode, kind: "hermes", id: sid, sid, profile, subagent: sub, readOnly, source: (n && n.source) || "",
      parent: parent ? { sid: parent.sid, title: hermesTitle(parent) } : null,
      agent: bot ? bot.title : agentName,
      title: bot ? "" : n ? hermesTitle(n) : H.titles.get(sid) || `Hermes · ${sid.slice(-8)}`,
      channel: SH.channelOf({ mode, subagent: sub, readOnly, source: n && n.source }) };
  }

  function publishDesktopView() {
    if (!S.settings || !deck.desktop?.view) return;
    const visible = S.settings.firstRunDone && !hostSwitchPending && !document.hidden &&
      SH.main() === "chat" && !SV.isOpen() && !UD.isOpen() && !allSessionsView()?.isOpen() &&
      !["browser", "screen"].includes(SH.right().tab) && document.getElementById("detail").hidden &&
      !["setup", "login", "error"].includes(hermesMode() ? "" : S.tg.status);
    const view = SH.notificationView({ current: currentChat(), displayed: displayedChat, visible });
    const sig = JSON.stringify(view);
    if (sig === lastDesktopView) return;
    lastDesktopView = sig;
    Promise.resolve(deck.desktop.view(view)).catch(() => {
      // A stale page may be refused during a host switch; allow the next publication to retry.
      if (lastDesktopView === sig) lastDesktopView = "";
    });
  }

  function renderCrumb() {
    const c = currentChat();
    const kids = [];
    if (c.agent) kids.push(h("span", { class: "sh-ca" }, c.agent));
    if (c.parent) kids.push(h("span", { class: "sh-cs", "aria-hidden": "true" }, "/"),
      h("button", { type: "button", class: "sh-lnk", title: c.parent.title, dataset: { fk: "crumb-parent" }, onclick: () => hermesSelect(c.parent.sid) }, c.parent.title));
    if (c.title) kids.push(c.agent || c.parent ? h("span", { class: "sh-cs", "aria-hidden": "true" }, "/") : null, h("span", { class: "sh-ct", title: c.title }, c.title));
    if (c.channel && c.id && c.channel.id !== "hermes") { // plain direct Hermes is the default: no chip
      const ICON = { hermes: "hermes", telegram: "telegram", readonly: "lock", bot: "bots", sub: "steer" };
      kids.push(h("span", { class: `sh-chip ${c.channel.id}`, dataset: { channel: c.channel.id } }, SH.icon(ICON[c.channel.id] || "hermes", 11), i18nNode(c.channel.key, c.channel.vars)));
    }
    if (c.id && hermesMode() && H.requests.some((r) => r.sid === c.id)) kids.push(h("span", { class: "sh-pill waiting" }, i18nNode("shell.state.needs")));
    els.crumb.replaceChildren(...kids.filter(Boolean));
    SH.publish("session", { id: c.id || null, kind: c.kind, mode: c.mode, sid: c.sid || null, key: c.key || null, profile: c.profile || null,
      channel: c.channel ? c.channel.id : null, subagent: !!c.subagent, parent: c.parent ? c.parent.sid : null, readOnly: !!c.readOnly, source: c.source || "" });
  }

  /** Work › Session: the facts of the chat on screen (its metric grid first when the relay has figures), then controls. */
  function paneSession(kids) {
    const c = currentChat();
    if (!c.id) {
      kids.push(h("p", { class: "pane-title" }, hermesMode() ? (bridgeOpen() ? i18nNode("U0626") : hermesStatusText()) : i18nNode("U0502")));
      return;
    }
    const n = c.sid ? H.nodes.get(c.sid) : null;
    const rel = c.sid ? S.relay.sessions.get(c.sid) : null;
    const items = rel && window.DeckActivity ? window.DeckActivity.metricItems(rel, n, k, { sparse: true }) : [];
    const rows = [
      [i18nText("shell.fact.channel"), i18nText(c.channel.key, c.channel.vars)],
      c.agent ? [i18nText("shell.fact.agent"), c.agent] : null,
      c.kind === "hermes" ? [i18nText("shell.fact.profile"), profileLabel(c.profile)] : null,
      n && n.source ? [i18nText("shell.fact.source"), n.source] : null,
      n && n.model ? [i18nText("shell.fact.model"), n.model] : null,
      n && n.ctxMax && n.ctxUsed && !items.some((m) => m.id === "context") ? [i18nText("shell.fact.context"), `${Math.round((100 * n.ctxUsed) / n.ctxMax)}%`] : null,
      c.sid ? [i18nText("shell.fact.id"), c.sid, "mono"] : null,
    ].filter(Boolean);
    kids.push(h("section", { class: "card sh-facts" },
      c.title ? h("h3", { class: "sh-facts-title" }, c.title) : null,
      items.length ? window.DeckActivity.metricGrid(h, items) : null,
      h("dl", { class: "sh-kv" }, ...rows.flatMap(([k, v, cls]) => [h("dt", null, k), h("dd", { class: cls || null, title: v }, v)])),
      n ? hermesControls(n, `card:${n.sid}`) : null)); // Steer · Stop · Model for the open session
    // the session's sub-agents and tool calls are in the other Work tabs
  }

  function renderHead() {
    renderNote(); // composer chips and Stop follow the chat on screen
    if (holdRegion(els.head)) return; // typing in an inline control
    if (hermesMode()) return renderHermesHead();
    const sc = scopeOf(S.sel);
    if (!sc) {
      els.head.replaceChildren(h("span", { class: "subline" }, i18nNode("U0437")));
      return;
    }
    const sess = liveFor(S.sel);
    const typing = typingNow(S.sel) ? h("span", { class: "typing" }, i18nNode("U0438")) : null;
    if (sc.kind === "dm") {
      const a = sc.agent;
      const name = a ? a.name : sc.bot ? sc.bot.title : "?";
      const top = a ? latestTop(a.name) : null;
      const fill = top && top.ctxLen ? top.ctxUsed / top.ctxLen : null;
      const model = (sess && sess.model) || (top && top.model);
      const bits = [sc.bot ? `@${sc.bot.username}` : null, model, agentStatus(a)].filter(Boolean);
      els.head.replaceChildren(
        coin(name, { size: 42, fill, live: !!(a && (a.running || a.subsRunning)), subs: a ? a.subsRunning : 0, img: S.avatars[S.sel] }),
        h("div", null, h("div", { class: "title" }, name), h("div", { class: "subline" }, bits.join(" · "), typing))
      );
    } else {
      const title = sc.topic ? sc.topic.title : i18nText("A0219", { tid: sc.tid });
      els.head.replaceChildren(
        h("div", null, h("div", { class: "title" }, `# ${title}`), h("div", { class: "subline" }, i18nNode("common.group", { v: S.tg.group ? S.tg.group.title : i18nText("A0220") }), sess ? ` · ${sess.agent} ${STATE_TR[stateOf(sess)]}` : "", typing))
      );
    }
  }

  function renderMsgs() {
    if (S.settings && !S.settings.firstRunDone) {
      const key = JSON.stringify(["first-run", firstRunStep, FIRST_RUN_STEPS[firstRunStep] === "device" && !!firstRunDevice, S.formBusy, S.formError]);
      if (els.msgsInner.dataset.form !== key) {
        els.msgsInner.dataset.form = key;
        els.msgsInner.replaceChildren(firstRunForm());
        els.msgs.scrollTop = 0;
      }
      return;
    }
    DR.sync(); // the message box shows this chat's draft
    AT.render(); // attachment tray for this chat, or the "not in this channel" bar (A7)
    if (hermesMode()) {
      if (renderHermesMsgs()) {
        displayedChat = H.hist.get(H.sel)?.loaded && !BT?.isDraft(H.sel) ? currentChat() : null;
        publishDesktopView();
      }
      return;
    }
    if (holdRegion(els.msgs)) return; // typing an answer in a Hermes request card
    const box = els.msgs;
    const kids = [];
    const t = S.tg;
    if (t.status === "setup" || t.status === "login") {
      // a form is on screen: rebuild it only when its step or error changes, never under the user's typing
      const formKey = JSON.stringify([t.status, t.step, t.error, t.hint, S.formBusy, S.formError]);
      if (els.msgsInner.dataset.form === formKey) return;
      els.msgsInner.dataset.form = formKey;
      els.msgsInner.replaceChildren(t.status === "setup" ? setupForm() : loginForm());
      const first = els.msgsInner.querySelector("input");
      if (first) first.focus();
      return;
    }
    delete els.msgsInner.dataset.form;
    if (t.status === "error") {
      kids.push(
        h("div", { class: "empty" },
          h("strong", null, i18nNode("U0439")),
          t.detail ? `${t.detail}. ` : "",
          t.code === "another-window" ? i18nNode("U0440") : i18nNode("U0441"),
          h("div", { class: "form-actions" }, h("button", { class: "btn", type: "button", onclick: () => deck.retryTelegram() }, i18nNode("A0221"))))
      );
    } else if (!S.sel) {
      kids.push(h("div", { class: "empty" }, t.status === "open" ? i18nNode("U0437") : i18nNode("U0442")));
    } else if (!S.loaded.has(S.sel)) {
      kids.push(h("div", { class: "empty" }, S.loading.has(S.sel) ? i18nNode("U0443") : i18nNode("U0444")));
    } else {
      const list = [...(S.msgs.get(S.sel) || new Map()).values()].sort((a, b) => a.id - b.id);
      if (!list.length) kids.push(h("div", { class: "empty" }, i18nNode("U0445")));
      let lastDay = null;
      for (const [i, m] of list.entries()) {
        const d = dayKey(m.date);
        if (d !== lastDay) {
          kids.push(h("div", { class: "day" }, dayLabel(m.date)));
          lastDay = d;
        }
        kids.push(msgEl(m, list[i - 1], list[i + 1]));
      }
    }
    kids.push(...hermesRequestCards());
    els.msgsInner.replaceChildren(...kids);
    if (scrollToEnd) box.scrollTop = 0; // column-reverse: 0 is the newest message
    scrollToEnd = false;
    MV.afterRender(); // reply bar for this chat
    displayedChat = S.loaded.has(S.sel) && t.status !== "error" ? currentChat() : null;
    publishDesktopView();
    reads.check(); // C5: what is on screen now may be newly seen
  }

  // ---------------------------------------------------------------- first-run setup + login
  // typed values survive a form rebuild (step change, error); passwords are never kept
  const formValues = {};
  function field(id, label, attrs = {}, help = null) {
    const keep = attrs.type !== "password";
    const code = /^api_/.test(label);
    const input = h("input", { id, ...attrs, value: keep ? formValues[id] : undefined });
    if (keep) input.addEventListener("input", () => (formValues[id] = input.value));
    return h("label", { class: "field", for: id }, h("span", { class: `flabel${code ? " code" : ""}` }, label), input, help ? h("span", { class: "fhelp" }, help) : null);
  }

  async function busy(fn) {
    S.formBusy = true;
    S.formError = null;
    mark("msgs", true);
    try {
      await fn();
    } catch (e) {
      S.formError = cleanErr(e);
    } finally {
      S.formBusy = false;
      mark("msgs", true);
    }
  }

  function formCard(title, intro, body, actions) {
    const err = S.formError || (S.settings && S.settings.firstRunDone && S.tg.error);
    return h(
      "form",
      { class: "setup", onsubmit: (e) => e.preventDefault() },
      h("h2", null, title),
      intro ? h("p", { class: "intro" }, intro) : null,
      body,
      err ? h("p", { class: "form-error", role: "alert" }, err) : null,
      h("div", { class: "form-actions" }, actions)
    );
  }

  function chatModePicker() {
    if (!firstRunChat) firstRunChat = { modes: [...chatModes()], defaultMode: CM.start(S.settings.chat) };
    return CM.editor(h, firstRunChat, { firstRun: true });
  }

  function firstRunForm() {
    const step = FIRST_RUN_STEPS[firstRunStep];
    const body = [];
    const titles = [CHAT_TEXT.picker, i18nText("setup.connect"), i18nText("setup.optionalRelay"), i18nText("setup.permissions"), i18nText("setup.preferences")];
    const intros = [null, null, null, i18nText("setup.permissionsHelp"), null];
    if (step === "chat") body.push(chatModePicker());
    else if (step === "bridge") paneHermesSettings(body, { firstRun: true });
    else if (step === "relay") {
      if (formValues["f-relay-url"] === undefined) formValues["f-relay-url"] = S.settings.relay.url || "";
      body.push(field("f-relay-url", i18nText("setup.relayAddress"), { placeholder: "ws://<relay-host>:9330", title: i18nText("setup.privateAddress"), "data-i18n-title": "setup.privateAddress" }),
        field("f-relay-token", i18nText("setup.relayToken"), { type: "password", autocomplete: "off", placeholder: S.settings.relay.hasToken ? i18nText("setup.keepSecret") : i18nText("setup.tokenSource") }));
    }
    else if (step === "device") {
      if (!firstRunDevice && !firstRunDeviceAttempted) {
        firstRunDeviceAttempted = true;
        firstRunDeviceLoading = true;
        deck.device.state().then((st) => { firstRunDevice = st; }).catch((e) => { S.formError = cleanErr(e); }).finally(() => {
          firstRunDeviceLoading = false;
          mark("msgs", true);
        });
      }
      for (const [cap, label, help] of [
        ["browser", i18nText("setup.allowBrowser"), i18nText("setup.browserHelp")],
        ["desktop", i18nText("setup.allowDesktop"), i18nText("setup.desktopHelp")],
      ]) {
        const supported = firstRunDevice && firstRunDevice.capabilities.includes(cap);
        body.push(h("label", { class: "toggle", for: `f-host-${cap}` },
          h("input", { id: `f-host-${cap}`, type: "checkbox", checked: !!(firstRunDevice && firstRunDevice.hosting[cap]), disabled: !supported,
            onchange: (e) => { firstRunDevice.hosting[cap] = e.target.checked; } }),
          h("span", { class: "sw", "aria-hidden": "true" }), h("span", { class: "tbody" }, h("span", { class: "tlabel" }, label), h("span", { class: "fhelp" }, help))));
      }
      if (!firstRunDevice) body.push(h("p", { class: "muted small" }, i18nNode("setup.loadingPermissions")));
      if (!firstRunDevice && !firstRunDeviceLoading) body.push(h("button", { class: "btn", type: "button", onclick: () => {
        firstRunDeviceAttempted = false;
        S.formError = null;
        delete els.msgsInner.dataset.form;
        mark("msgs", true);
      } }, i18nNode("setup.retry")));
    } else {
      if (!firstRunPrefs) firstRunPrefs = { pet: S.settings.desktop.pet, notifications: S.settings.desktop.notifications, language: S.settings.language || "en" };
      for (const [key, label] of [["pet", i18nText("setup.showPet")], ["notifications", i18nText("setup.notifications")]]) body.push(
        h("label", { class: "toggle", for: `f-${key}` }, h("input", { id: `f-${key}`, type: "checkbox", checked: firstRunPrefs[key], onchange: (e) => { firstRunPrefs[key] = e.target.checked; } }),
          h("span", { class: "sw", "aria-hidden": "true" }), h("span", { class: "tbody" }, h("span", { class: "tlabel" }, label))));
      body.push(languageField("f-language", firstRunPrefs.language, (value) => { firstRunPrefs.language = value; }));
    }
    const next = (skip = false) => busy(async () => {
      if (step === "chat") S.settings = await deck.settingsSave({ chat: firstRunChat });
      else if (step === "bridge" && !skip) S.settings = await deck.settingsSave({ bridge: draftConfig() });
      else if (step === "relay" && !skip) {
        const url = document.getElementById("f-relay-url").value.trim();
        const token = document.getElementById("f-relay-token").value.trim();
        if (url && !token && !S.settings.relay.hasToken) throw new Error(i18nText("setup.needRelayToken"));
        S.settings = await deck.settingsSave({ relay: { url, token } });
      } else if (step === "device") {
        if (!firstRunDevice) throw new Error(i18nText("setup.waitPermissions"));
        for (const cap of firstRunDevice.capabilities) await deck.device.setHosting(cap, firstRunDevice.hosting[cap] === true);
      } else if (step === "preferences") {
        S.settings = await deck.settingsSave({ desktop: { pet: firstRunPrefs.pet, notifications: firstRunPrefs.notifications }, language: firstRunPrefs.language, firstRunDone: true });
        syncChatMode(chatModes().includes("telegram") && S.tg.status !== "open" ? "telegram" : CM.start(S.settings.chat));
        mark("top", "rail", "head", "msgs", "strip", "panel", true);
        return;
      }
      firstRunStep++;
    });
    const actions = [h("button", { class: "btn primary", type: "button", disabled: S.formBusy || (step === "device" && !firstRunDevice), onclick: () => next() }, step === "preferences" ? i18nNode("setup.finish") : CHAT_TEXT.next)];
    if (step === "bridge" || step === "relay") actions.push(h("button", { class: "btn", type: "button", disabled: S.formBusy, onclick: () => next(true) }, i18nNode("setup.later")));
    if (firstRunStep) actions.push(h("button", { class: "btn", type: "button", disabled: S.formBusy, onclick: () => { firstRunStep--; S.formError = null; mark("msgs", true); } }, i18nNode("setup.back")));
    const card = formCard(titles[firstRunStep], intros[firstRunStep], body, actions);
    card.dataset.step = step;
    card.prepend(h("p", { class: "fhelp" }, i18nNode("setup.step", { v: firstRunStep + 1, length: FIRST_RUN_STEPS.length })));
    return card;
  }

  function languageField(id, value, change) {
    return h("label", { class: "field", for: id }, h("span", { class: "flabel" }, i18nNode("settings.language")),
      h("select", { id, onchange: (e) => change(e.target.value) },
        [["en", "English"], ["tr", "Türkçe"]].map(([key, label]) => h("option", { value: key, selected: key === value }, label))));
  }

  /** Settings > General > Chat modes: every change of the editor saves at once. */
  async function saveChatModes(draft) {
    try {
      S.settings = await deck.settingsSave({ chat: draft });
      syncChatMode(chatModes().includes(chatMode()) ? chatMode() : CM.start(S.settings && S.settings.chat));
      settingsMessage(true, CHAT_TEXT.saved); // after the mode switch's refresh, so the note stays
    } catch (e) {
      settingsMessage(false, i18nText("common.saveFailed", { e: cleanErr(e) }));
    }
  }

  function setupForm() {
    const save = () =>
      busy(async () => {
        const apiId = document.getElementById("f-apiid").value.trim();
        const apiHash = document.getElementById("f-apihash").value.trim();
        if (!apiId || !apiHash) throw new Error(i18nText("U0446"));
        S.settings = await deck.settingsSave({ telegram: { apiId, apiHash } });
      });
    return formCard(
      i18nText("U0447"),
      i18nText("U0448"),
      [
        field("f-apiid", "api_id", { inputmode: "numeric", autocomplete: "off", placeholder: "1234567" }),
        field("f-apihash", "api_hash", { type: "password", autocomplete: "off", placeholder: i18nText("A0222") }, i18nText("U0449")),
      ],
      [
        h("button", { class: "btn primary", type: "submit", disabled: S.formBusy, onclick: save }, S.formBusy ? i18nNode("A0223") : i18nNode("A0224")),
        h("button", { class: "btn", type: "button", onclick: () => deck.openExternal("https://my.telegram.org/apps") }, i18nNode("U0450")),
      ]
    );
  }

  function loginForm() {
    const t = S.tg;
    const cancel = h("button", { class: "btn", type: "button", onclick: () => deck.loginCancel() }, i18nNode("U0451"));
    if (t.step === "sending" || t.step === "checking") {
      return formCard(t.step === "sending" ? i18nText("U0452") : i18nText("A0225"), i18nText("U0453"), [], [cancel]);
    }
    if (t.step === "code") {
      const go = () => busy(() => deck.loginAnswer("code", document.getElementById("f-code").value));
      return formCard(
        i18nText("U0454"),
        t.viaApp ? i18nText("A0226") : i18nText("A0227"),
        [field("f-code", i18nText("A0228"), { inputmode: "numeric", autocomplete: "one-time-code", placeholder: "12345" }, i18nText("U0455"))],
        [h("button", { class: "btn primary", type: "submit", disabled: S.formBusy, onclick: go }, i18nNode("U0456")), cancel]
      );
    }
    if (t.step === "password") {
      const go = () => busy(() => deck.loginAnswer("password", document.getElementById("f-pass").value));
      return formCard(
        i18nText("U0457"),
        t.hint ? i18nText("U0458", { hint: t.hint }) : i18nText("U0459"),
        [field("f-pass", i18nText("U0460"), { type: "password", autocomplete: "current-password" })],
        [h("button", { class: "btn primary", type: "submit", disabled: S.formBusy, onclick: go }, i18nNode("A0229")), cancel]
      );
    }
    const go = () => busy(() => deck.loginStart(document.getElementById("f-phone").value));
    return formCard(
      i18nText("U0461"),
      i18nText("U0462"),
      [field("f-phone", i18nText("U0463"), { type: "tel", autocomplete: "tel", placeholder: "+90 5xx xxx xx xx" })],
      [
        h("button", { class: "btn primary", type: "submit", disabled: S.formBusy, onclick: go }, S.formBusy ? i18nNode("U0464") : i18nNode("U0465")),
        h("button", { class: "btn", type: "button", onclick: () => openSettings("telegram") }, i18nNode("A0231")),
      ]
    );
  }

  // one message (prev/next: neighbours, for grouping a sender's consecutive messages); see msgview.js
  function msgEl(m, prev, next) {
    return MV.msgEl(m, prev, next);
  }

  function renderStrip() {
    SH.publish("activity", composerActivity());
  }

  /** Selected-chat facts only: relay observation never grants direct controls. */
  function composerActivity() {
    const c = currentChat();
    if (!c.id || hostSwitchPending) return null;
    if (hermesMode()) {
      if (!bridgeOpen()) return { sid: c.sid, agent: c.agent, phase: "disconnected", label: { key: "status.disconnected" } };
      const n = H.nodes.get(c.sid);
      if (n && (n.profile || "default") !== c.profile) return null;
      const live = hermesLiveView();
      if (live) return { ...live, agent: c.agent, model: n?.model || "" };
      if (!n) return null;
      const labels = { error: "status.failed", approval: "live.approval", question: "live.question", ratelimit: "U0563", finished: "status.completed" };
      const phase = Object.hasOwn(labels, n.state) ? n.state : "idle";
      return { sid: c.sid, agent: c.agent, model: n.model, node: n, phase,
        label: { key: labels[phase] || "status.idle" }, steps: n.steps || [] };
    }
    if (S.relay.status !== "open") return { sid: c.sid, agent: c.agent, phase: "disconnected", label: { key: "status.disconnected" } };
    const s = liveFor(S.sel);
    if (!s) return null;
    const live = isLive(s), phase = live ? (s.curTool ? "tool" : "thinking") : stateOf(s);
    const recent = S.details.get(s.sid)?.recent || [];
    return { sid: s.sid, agent: s.agent || c.agent, model: s.model, source: "relay", phase,
      tool: live ? s.curTool?.tool || "" : "", since: live ? (s.curTool?.since || s.turnTs || 0) * 1000 : 0,
      steps: recent.map(x => x.tool).filter(x => typeof x === "string").slice(-6),
      label: live ? window.DeckLiveActivity.label(phase, s.curTool?.tool || "")
        : { key: phase === "failed" ? "status.failed" : phase === "stale" ? "status.stale" : phase === "done" ? "status.completed" : "status.idle" } };
  }

  // ---------------------------------------------------------------- Workspace tab (renderer/workspace.js)
  // The agent's own browser, live. The module owns its DOM and updates it in place (frames arrive
  // several times a second); app.js only mounts it and tells it which agent the open chat belongs to.
  const workspace = window.DeckWorkspace
    ? window.DeckWorkspace({
        h,
        deck,
        agents: () => agentList(),
        preferred: () => workspaceAgent(),
        cleanErr,
        openSettings: () => openSettings("device"),
        // a robot-check notification was clicked: show the Workspace tab (and the panel, if closed)
        openWorkspace: () => setTab("workspace"),
        refreshSettings: () => refreshSettingsPane(),
        settingsMessage: (ok, text) => settingsMessage(ok, text),
      })
    : null;
  /** Profile of the open chat's agent: the DM's bot, or whoever works in the open topic. */
  function workspaceAgent() {
    const sc = scopeOf(S.sel);
    if (sc && sc.kind === "dm") return sc.agent ? sc.agent.profile : null;
    const s = S.sel ? liveFor(S.sel) : null;
    return s && s.profile ? s.profile : null;
  }
  function paneWorkspace(kids) {
    if (workspace) kids.push(workspace.root);
    else kids.push(h("div", { class: "later-pane" }, h("h3", null, i18nNode("U0476")), i18nNode("U0477")));
  }

  // ---------------------------------------------------------------- Bot screen tab (renderer/botscreen.js)
  // An agent's own screenshots and clicks on a desktop, "Hand to agent", Stop. Mounted like the workspace.
  const botscreen = window.DeckBotScreen
    ? window.DeckBotScreen({
        h,
        deck,
        agents: () => agentList(),
        cleanErr,
        openSettings: () => openSettings("device"),
        openScreen: () => {
          if (!screenTabOn()) return openSettings("device"); // the tab exists only while desktop control is on
          setTab("screen");
        },
        // botscreen pushes a state change: the Bot screen tab appears/disappears with desktop control
        refreshSettings: () => {
          syncScreenTab();
          refreshSettingsPane();
        },
        rebuildSettings: () => SV && SV.refresh({ force: true }),
        settingsMessage: (ok, text) => {
          syncScreenTab();
          settingsMessage(ok, text);
        },
      })
    : null;

  // ---------------------------------------------------------------- Settings (renderer/settings-view.js)
  // A full view over the chat column, opened from the top bar's gear or Ctrl+, . The Hermes connection form and
  // the hosting rows stay where their state lives (here, workspace.js, botscreen.js); the view lays them out.
  const SVM = window.DeckSettingsView;
  const screenState = () => (botscreen && botscreen.state ? botscreen.state() : null);
  const screenTabOn = () => !!botscreen && SVM.screenTabVisible(screenState(), S.tab);
  /** The Bot screen tab follows desktop control: shown while it is on; when it goes, the work pane shows its first tab. */
  function syncScreenTab() {
    renderTabs();
  }
  let hostVer = null; // main/host-versions.js state (applyHostVersions below)
  const SV = SVM.create({
    h,
    store,
    CM,
    deck,
    settings: () => S.settings,
    tg: () => S.tg,
    deskInfo: () => S.deskInfo,
    windows: () => /Win/i.test(navigator.platform),
    canOpen: () => !!(S.settings && S.settings.firstRunDone),
    hasSection: (id) => (id === "device" ? !!(workspace || botscreen) : id === "desktop" ? !!desk : true),
    save: (patch, okText) => saveSettings(patch, okText),
    saveCall: (call, okText) => saveSettingsCall(call, okText),
    selectHost,
    hostStates: () => ({ relay: S.relay.status, sessions: H.status.status, remote: remoteHosts }),
    saveChat: (draft) => saveChatModes(draft),
    readReceiptsChanged: () => { reads.forget(); reads.check(); },
    logout: async () => {
      await deck.logout();
      settingsMessage(true, i18nText("U0497"));
    },
    testNotification: (btn) => testNotification(btn),
    confirm: (o) => confirmSheet(o), // consent / confirmation sheets (agent desktops)
    hermes: (kids) => paneHermesSettings(kids),
    hermesConfig: window.DeckHermesConfigView ? window.DeckHermesConfigView.create({
      h, deck, store,
      confirm: (o) => confirmSheet(o),
      relayOpen: () => S.relay.status === "open",
      refresh: () => SV.refresh({ force: true }),
    }) : null, // Settings > Hermes config (relay only)
    hostVersions: () => hostVer, // main/host-versions.js: relay / plugin versions on the host
    workspaceRows: () => (workspace ? workspace.settingsRows() : null),
    botscreenRows: () => (botscreen ? botscreen.settingsRows() : null),
    agents: () => agentList(), // Settings > Agent spaces: one home-host row per agent
    screenTab: () => screenTabOn(),
    openScreen: () => setTab("screen"),
    onToggle: (open) => {
      if (open) { SH.setMain("chat"); UD.close(false); } // Settings draws over the chat column (and replaces the Usage view)
      renderGear();
      publishDesktopView();
    },
  });
  /** A small modal consent / confirmation sheet for Settings: resolves true only on its OK button (Esc, Cancel: false). */
  function confirmSheet({ title = "", body = "", ok = "" } = {}) {
    return new Promise((resolve) => {
      const dialog = h("dialog", { class: "sv-confirm", "aria-labelledby": "sv-confirm-title" });
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        if (dialog.open) dialog.close();
        dialog.remove();
        resolve(v);
      };
      const cancel = h("button", { class: "btn", type: "button", onclick: () => finish(false) }, i18nNode("U0451"));
      dialog.append(
        h("h3", { id: "sv-confirm-title" }, title),
        h("p", null, body),
        h("div", { class: "form-actions" }, cancel, h("button", { class: "btn primary", type: "button", onclick: () => finish(true) }, ok || i18nText("set.saved")))
      );
      dialog.addEventListener("cancel", (e) => { e.preventDefault(); finish(false); });
      document.body.append(dialog);
      dialog.showModal();
      cancel.focus(); // the safe choice has the focus
    });
  }
  function openSettings(section) {
    SV.open(section); // drawn above an open All sessions browser; closing Settings shows it again
  }

  // ---------------------------------------------------------------- host versions (main/host-versions.js)
  // A relay or plugin older than this app shows in Settings › Relay / › Hermes; a protocol mismatch blocks that one
  // connection and gets a banner in the top bar (its button opens the section with the update command).
  const hostBanner = h("div", { class: "hostver-banner", role: "alert", hidden: true });
  document.getElementById("topbar").appendChild(hostBanner);
  function applyHostVersions(state) {
    hostVer = state && typeof state === "object" ? state : null;
    const keys = SVM.hostBanners(hostVer);
    hostBanner.hidden = !keys.length;
    hostBanner.replaceChildren(...keys.map((k) => h("p", null, i18nText(k, { ours: hostVer.protocol }), " ",
      h("button", { class: "linkbtn", type: "button", onclick: () => openSettings(k === "hostupd.bannerRelay" ? "relay" : "hermes") }, i18nText("hostupd.howTo")))));
    SV.refresh();
  }
  if (deck.onHostVersions) deck.onHostVersions(applyHostVersions);
  function settingsMessage(ok, text) {
    SV.notify(ok, text);
  }
  const gear = h("button", { class: "topbar-gear", type: "button", title: i18nText("set.open"), "aria-label": i18nText("A0231"), "data-i18n-title": "set.open", "data-i18n-aria-label": "A0231", dataset: { fk: "sv-gear" }, onclick: () => SV.toggle() }, SV.icon("gear", 15));
  document.getElementById("topbar-end").appendChild(gear);
  function renderGear() {
    gear.hidden = !(S.settings && S.settings.firstRunDone);
    gear.setAttribute("aria-pressed", SV.isOpen() ? "true" : "false");
  }

  // ---------------------------------------------------------------- right slot (shell.js): the Work pane
  // Work pane tabs: Session (facts of the chat on screen, its metrics and controls) first, then Run, Plan, Diff and
  // Agents (work-pane.js; shell.js empty states until it registers), Browser (workspace.js) and Screen (botscreen.js)
  // mounted unchanged. Usage is a main-area view (usage-detail.js), not a tab. The old tab ids still route: setTab
  // callers, --tab=<id> screenshot runs and a persisted deck.tab.
  /** The tab ids the rest of app.js reads in S.tab (old names, so existing checks keep working). */
  const OLD_ID = { "work:browser": "workspace", "work:screen": "screen" };
  const tabIdOf = (r) => (r && r.kind ? OLD_ID[`${r.kind}:${r.tab}`] || r.tab || "" : "");
  SH.on("right", (r) => {
    S.tab = tabIdOf(r);
    renderGear();
    publishDesktopView();
  });

  function renderTabs() {
    renderGear();
    SH.refresh();
  }

  function setTab(id) {
    if (id === "settings") return openSettings(); // Settings is its own view now (old callers, --tab=settings)
    id = SVM.tabFor(id, screenState());
    const to = SH.legacyTab(id) || SH.legacyTab("activity");
    if (to[0] === "main") return UD.open(); // Usage (old fleet / tokens / usage tabs) is a main-area view
    SH.openRight(to[0], to[1]);
  }

  /** The app's own tabs draw through this: same rules as the old panel (first run, held fields, live language). */
  function paneTab(fill) {
    return (el) => {
      const kids = [];
      fill(kids);
      el.replaceChildren(...kids);
      window.DeckI18n.apply(document); // also refresh controls that were detached during a language change
    };
  }
  /** A module's root mounted once and updated in place (workspace.js, botscreen.js). */
  function mountOnce(mod, fallback) {
    return (el) => {
      if (!mod) {
        if (!el.firstChild) el.append(fallback());
        return;
      }
      if (el.firstChild !== mod.root) el.replaceChildren(mod.root);
      mod.update();
    };
  }
  /**
   * The app's own right-slot tabs, registered "weak" (a module that registered the same id first keeps it). Called
   * once at boot, after every const of this file exists: registering an open tab renders it at once.
   */
  function registerShellTabs() {
    // Session holds the chat's facts, metrics and controls, then (Telegram mode) its relay sessions and what runs
    // elsewhere. It is the Work pane's first tab; sub-agents live in their own tab, so nothing is shown twice.
    SH.registerWorkTab("session", { weak: true, title: () => i18nText("shell.tab.session"), render: paneTab((kids) => paneSessionTab(kids)) });
    SH.registerWorkTab("browser", { weak: true, title: () => i18nText("shell.tab.browser"),
      render: mountOnce(workspace, () => h("div", { class: "later-pane" }, h("h3", null, i18nNode("U0476")), i18nNode("U0477"))) });
    // the Bot screen tab is conditional: only while desktop control is on (Settings > This device)
    const screenTab = () => (screenTabOn() ? ["screen", i18nText("shell.tab.screen")] : null);
    SH.registerWorkTab("screen", { weak: true, title: () => screenTab()?.[1] || i18nText("shell.tab.screen"), visible: () => !!screenTab(),
      render: mountOnce(botscreen, () => h("div", { class: "later-pane" }, h("h3", null, i18nNode("U0478")), i18nNode("U0481"))) });
  }

  function renderPane() {
    const firstRun = !!(S.settings && !S.settings.firstRunDone);
    SH.setLocked(firstRun); // first run: no right slot until setup is done
    if (firstRun) return;
    SH.refresh();
    UD.refresh(); // the Usage view, when open, follows the same render loop
  }

  function nums(s) {
    const t = s.tokens || {};
    const bits = [];
    if (!s.parent && s.turns) bits.push(i18nText("time.turns", { turns: s.turns }));
    bits.push(i18nText("U0482", { v: s.ntools || 0 }));
    bits.push(i18nText("time.fresh", { v: k((t.in || 0) + (t.cw || 0)) }));
    if (t.cr) bits.push(i18nText("U0350", { cr: k(t.cr) }));
    bits.push(i18nText("U0351", { out: k(t.out) }));
    if (s.cost) bits.push(`$${s.cost.toFixed(2)}`);
    if (s.ms) bits.push(dur(s.ms));
    return bits.join(" · ");
  }

  function where(s) {
    if (s.cron) return "cron";
    if (s.thread) {
      const tid = String(s.thread).replace(/^t/, "");
      const t = S.tg.topics.find((x) => String(x.id) === tid);
      return `# ${t ? t.title : tid}`;
    }
    if (S.tg.me && s.chat === S.tg.me.id) return "DM";
    return s.platform || "";
  }

  // ---------------------------------------------------------------- settings
  function sfield(id, label, attrs = {}, help = null) {
    // technical keys keep their spelling (a Turkish uppercase transform would turn api_id into APİ_İD)
    const code = /^api_/.test(label);
    return h("label", { class: "field", for: id }, h("span", { class: `flabel${code ? " code" : ""}` }, label), h("input", { id, autocomplete: "off", ...attrs }), help ? h("span", { class: "fhelp" }, help) : null);
  }

  /** Settings changed (account data, a tray toggle, a mode switch): the view rebuilds, never under the user's typing. */
  function refreshSettingsPane() {
    renderGear(); // the gear appears once first run is done
    applyWallpaper();
    SV.refresh();
  }

  /**
   * The chat wallpaper (Settings > Desktop > Appearance): the current chat mode's picture behind the message list,
   * under a veil of the theme's ground (--wall-dim) so the bubbles stay readable in every theme. Served from the
   * profile by main. Runs on every settings change and mode switch (refreshSettingsPane).
   */
  function applyWallpaper() {
    const all = (S.settings && S.settings.wallpaper) || {};
    const w = all[chatMode()] || {};
    const box = document.getElementById("msgs");
    if (!box) return;
    const preset = typeof w.file === "string" && /^preset:(marble|aegean|basalt|papyrus)$/.test(w.file) ? w.file.slice(7) : "";
    const stored = typeof w.file === "string" && /^[a-f0-9]{16}\.(png|jpe?g|webp|gif)$/.test(w.file) ? w.file : "";
    const on = !!(preset || stored);
    box.classList.toggle("wall", on);
    if (on) {
      box.style.setProperty("--wall-img", `url("deck://app/${preset ? `wallpapers/${preset}.jpg` : `user-wallpaper/${stored}`}")`);
      box.style.setProperty("--wall-dim", `${Number.isInteger(w.dim) ? w.dim : 55}%`);
    } else {
      box.style.removeProperty("--wall-img");
      box.style.removeProperty("--wall-dim");
    }
  }

  /** One settings save from the Settings view: the result shows as a short note next to the control. */
  async function saveSettings(patch, okText) {
    let saved = false;
    if (patch.language) { if (languageRestore) languageRestore(); languageSaves++; languageRestore = preserveLanguageFields(); }
    try {
      S.settings = await deck.settingsSave(patch);
      if (patch.hiddenBots !== undefined) {
        applyDialogs(S.tg);
        mark("rail", "head", "msgs", "strip", "panel", true);
      }
      applyWallpaper();
      settingsMessage(true, patch.language ? i18nText("settings.languageSaved") : okText);
      saved = true;
    } catch (e) {
      settingsMessage(false, i18nText("common.saveFailed", { e: cleanErr(e) }));
      if (patch.hiddenBots !== undefined) MV.toast(i18nText("common.saveFailed", { e: cleanErr(e) }));
    }
    mark("top", "panel", true);
    if (patch.language) requestAnimationFrame(() => {
      if (languageRestore) languageRestore();
      if (!--languageSaves) languageRestore = null;
    });
    return saved;
  }

  /** A save through another IPC call (download folder pick/reset): same note as saveSettings. */
  async function saveSettingsCall(call, okText) {
    try {
      S.settings = await call();
      applyWallpaper();
      settingsMessage(true, okText);
      mark("top", "panel", true);
      return true;
    } catch (e) {
      settingsMessage(false, i18nText("common.saveFailed", { e: cleanErr(e) }));
      return false;
    }
  }

  function paneSessionTab(kids) {
    paneSession(kids);
    if (!hermesMode() && S.sel) paneActivityMain(kids); // a Telegram chat's sessions are only listed here
    if (!AV) return;
    const shown = new Set();
    const roots = hermesMode() ? [S.relay.sessions.get(H.sel)] : S.sel && scopeOf(S.sel) ? sessionsFor(S.sel) : [];
    for (const s of roots) if (s) AV.descendants(s, shown);
    const elsewhere = AV.elsewhere(shown);
    if (elsewhere) kids.push(elsewhere);
  }

  function paneActivityMain(kids) {
    if (hermesMode()) return paneHermesActivity(kids);
    const sc = scopeOf(S.sel);
    if (S.relay.status !== "open" && !S.relay.sessions.size) {
      kids.push(h("p", { class: "pane-title" }, S.relay.status === "unconfigured" ? i18nNode("U0500") : i18nNode("U0501")));
      return;
    }
    if (!sc) {
      kids.push(h("p", { class: "pane-title" }, i18nNode("U0502")));
      return;
    }
    const list = sessionsFor(S.sel);
    const label = sc.kind === "dm" ? (sc.agent ? sc.agent.name : sc.bot && sc.bot.title) : sc.topic ? `# ${sc.topic.title}` : i18nText("A0245");
    kids.push(h("p", { class: "pane-title" }, h("b", null, label || ""), i18nNode("A0246", { length: list.length })));
    if (sc.kind === "dm" && !sc.agent) {
      kids.push(h("p", { class: "muted" }, i18nNode("U0503")));
      return;
    }
    if (!list.length) {
      kids.push(h("p", { class: "muted" }, i18nNode("U0504")));
      return;
    }
    for (const s of list) kids.push(sessionCard(s, sc));
  }

  function sessionCard(s, sc) {
    if (AV) return AV.card(s, { mine: inChat(s, sc) });
    const st = stateOf(s);
    const kidsList = kidsOf(s);
    return h(
      "article",
      { class: `card${inChat(s, sc) ? " mine" : ""}` },
      h(
        "header",
        { class: "card-head act" },
        h("span", { class: `state ${st}` }, STATE_TR[st] || st),
        h("span", { class: "ch-where" }, where(s)),
        h("span", { class: "model", title: s.model || null }, s.model || ""),
        h("span", { class: "when", title: new Date(s.lastTs * 1000).toLocaleString(i18nLocale()) }, ago(s.lastTs))
      ),
      // F2: the request first, its Telegram context folded into "context" (agents.js)
      s.lastMsg ? (AG ? AG.ask(s) : h("p", { class: "ask" }, s.lastMsg)) : null,
      isLive(s) && s.curTool ? h("p", { class: "now" }, ticker(s.curTool.since, `${s.curTool.tool} · `)) : null,
      statsRow(s),
      // B4: nested sub-agent tree with retries and per-branch tokens (agents.js)
      kidsList.length ? (AG ? AG.tree(s) : h("div", { class: "kids" }, kidsList.map(kidRow))) : null,
      hermesCardControls(s.sid),
      h("div", { class: "card-links" }, toolToggle(s), AG ? AG.detailLink(s) : null),
      S.open.has(s.sid) ? toolList(s.sid) : null
    );
  }

  function ctxWarn(s) {
    if (!s.ctxLen || !s.ctxUsed) return null;
    const p = s.ctxUsed / s.ctxLen;
    return p >= 0.7 ? h("span", { class: "warn" }, i18nNode("U0505", { v: Math.round(p * 100) })) : i18nText("U0505", { v: Math.round(p * 100) });
  }

  /** Activity card counters as one compact inline row; every figure explains itself on hover (same numbers as nums()). */
  function statsRow(s) {
    const t = s.tokens || {};
    const stat = (text, tip, cls = "") => h("span", { class: `stat${cls ? ` ${cls}` : ""}`, title: tip }, text);
    const plural = (base, n) => i18nText(`${base}.${new Intl.PluralRules(i18nLocale()).select(n) === "one" ? "one" : "other"}`, { n });
    const bits = [];
    if (!s.parent && s.turns) bits.push(stat(plural("activity.turns", s.turns), i18nText("activity.tipTurns")));
    bits.push(stat(plural("activity.tools", s.ntools || 0), i18nText("activity.tipTools")));
    bits.push(stat(i18nText("time.fresh", { v: k((t.in || 0) + (t.cw || 0)) }), i18nText("activity.tipFresh")));
    if (t.cr) bits.push(stat(i18nText("U0350", { cr: k(t.cr) }), i18nText("activity.tipCached")));
    bits.push(stat(i18nText("U0351", { out: k(t.out) }), i18nText("activity.tipOutput")));
    if (s.ctxLen && s.ctxUsed) {
      const p = Math.round((100 * s.ctxUsed) / s.ctxLen);
      bits.push(stat(i18nText("activity.context", { v: p }), i18nText("activity.tipContext"), p >= 70 ? "warn" : ""));
    }
    if (s.cost) bits.push(stat(`$${s.cost.toFixed(2)}`, i18nText("activity.tipCost")));
    if (s.ms) bits.push(stat(dur(s.ms), i18nText("activity.tipTime")));
    return h("p", { class: "nums stats" }, bits);
  }

  function kidRow(c) {
    const st = stateOf(c);
    return h(
      "div",
      { class: "kid" },
      h("div", { class: "line" }, h("span", { class: `state ${st}` }, STATE_TR[st] || st), h("span", { class: "goal", title: c.goal || "" }, c.goal || c.sa || i18nNode("common.subagent")), h("span", { class: "muted" }, c.model || "")),
      isLive(c) && c.curTool ? h("p", { class: "now" }, ticker(c.curTool.since, `${c.curTool.tool} · `)) : null,
      h("p", { class: "nums" }, nums(c)),
      hermesCardControls(c.sid),
      toolToggle(c),
      S.open.has(c.sid) ? toolList(c.sid) : null
    );
  }

  function toolToggle(s) {
    if (!s.ntools) return null;
    const open = S.open.has(s.sid);
    return h(
      "button",
      { class: "linkbtn", type: "button", "aria-expanded": open ? "true" : "false", dataset: { fk: `tog:${s.sid}` }, onclick: () => toggleTools(s.sid) },
      open ? i18nNode("U0506") : i18nNode("U0507", { ntools: s.ntools })
    );
  }

  async function toggleTools(sid) {
    if (S.open.has(sid)) S.open.delete(sid);
    else {
      S.open.add(sid);
      const cached = S.details.get(sid);
      if (!cached || (!cached.loading && (cached.observedOnly || cached.error))) {
        const pending = { loading: true, recent: cached?.recent || [] };
        S.details.set(sid, pending);
        try {
          const d = await deck.session(sid);
          const recent = new Map((d.recent || []).map(t => [t.call || t, t]));
          for (const t of pending.recent) recent.set(t.call || t, { ...recent.get(t.call || t), ...t });
          S.details.set(sid, { recent: [...recent.values()].slice(-30) });
        } catch (e) {
          S.details.set(sid, { error: cleanErr(e), observedOnly: true, recent: pending.recent });
        }
      }
    }
    mark("panel", true);
  }

  function toolList(sid) {
    const d = S.details.get(sid);
    if (!d || d.loading) return h("div", { class: "tools" }, h("span", { class: "muted" }, i18nNode("U0389")));
    if (d.error) return h("div", { class: "tools" }, h("span", { class: "muted" }, i18nNode("U0508", { error: d.error })));
    const rows = d.recent.slice(-20).reverse();
    return h(
      "div",
      { class: "tools" },
      rows.map((t) =>
        AG ? AG.toolRow(sid, t) : h( // B3: a row opens to the call's full args and result (agents.js)
          "div",
          { class: "tool", title: [t.args, t.result].filter(Boolean).join("\n\n") },
          h("span", null, hm(t.ts)),
          h("span", { class: "tname" }, t.tool || "?", t.args ? h("span", { class: "muted" }, `  ${t.args}`) : null),
          t.status === undefined ? h("span", { class: "run" }, i18nNode("U0360")) : h("span", { class: t.status === "ok" ? "ok" : "err" }, `${t.status === "ok" ? "✓" : "✗"} ${dur(t.ms)}`)
        )
      )
    );
  }

  /** Keep observed steps live even before the tool-history panel is opened. */
  function applyDetail(e) {
    if (e.ev === "tool_start" && !S.details.has(e.sid)) S.details.set(e.sid, { observedOnly: true, recent: [] });
    const d = S.details.get(e.sid);
    if (!d || !d.recent) return;
    if (e.ev === "tool_start") {
      d.recent.push({ call: e.call, tool: e.tool, args: e.args, ts: e.ts });
      if (d.recent.length > 30) d.recent.shift();
    } else if (e.ev === "tool_end") {
      const t = [...d.recent].reverse().find((x) => x.call === e.call);
      if (t) Object.assign(t, { ms: e.ms, status: e.status, result: e.result });
    }
  }

  function paneFleet(kids) {
    const f = S.relay.fleet;
    if (!f) {
      kids.push(h("p", { class: "pane-title" }, i18nNode("U0509")));
      return;
    }
    const refreshState = (paneFleet.refresh ||= { busy: false, note: null });
    kids.push(h("div", { class: "section-bar" }, h("h2", { class: "section-h" }, i18nNode("A0247")),
      window.DeckUsage.refreshButton(h, refreshState, () => deck.quotaRefresh(), () => mark("panel", true)),
      refreshState.note ? h("span", { class: "quota-note-inline", role: "status" }, refreshState.note) : null));
    kids.push(...window.DeckUsage.quotaRows(h, f));
    kids.push(h("h2", { class: "section-h" }, i18nNode("usage.todayAll")));
    kids.push(...window.DeckUsage.summary(h, agentList().map(a => a.today || {}), k, f.usage));

    kids.push(h("h2", { class: "section-h" }, i18nNode("A0250")));
    const profiles = Object.entries(f.profiles || {});
    if (!profiles.length) kids.push(h("p", { class: "muted" }, i18nNode("U0515")));
    for (const [profile, p] of profiles) {
      const name = (agentList().find((a) => a.profile === profile) || {}).name || profile;
      const plats = Object.entries(p.platforms || {});
      const failing = (p.cron || []).filter((j) => j.enabled && (j.failure_streak || 0) > 0);
      const g = p.gateway || {};
      kids.push(
        h(
          "article",
          { class: "card" },
          h("header", { class: "card-head" },
            h("span", { class: `state ${p.stale ? "stale" : g.gateway_state === "running" ? "running" : "failed"}` }, p.stale ? i18nNode("common.stale") : g.gateway_state === "running" ? i18nNode("U0410") : g.gateway_state || "?"),
            h("span", { class: "model" }, name),
            h("span", null, g.code_version ? `v${g.code_version}` : ""),
            h("span", { class: "when" }, p.ts ? ago(p.ts) : "")),
          h("div", { class: "chips" },
            plats.map(([n, x]) => h("span", { class: `chip ${x.state === "connected" ? "ok" : x.state === "retrying" || x.state === "connecting" ? "warn" : "bad"}`, title: x.error || null }, `${n} ${x.state === "connected" ? "" : x.state}`.trim()))),
          h("p", { class: "nums" }, i18nNode("U0516", { v: g.active_agents || 0, length: (p.cron || []).length })),
          failing.length
            ? h("div", { class: "cronbad" }, failing.map((j) => h("div", null, i18nNode("U0518", { name: j.name, failure_streak: j.failure_streak }), j.last_error ? h("span", { class: "err" }, j.last_error) : null)))
            : null
        )
      );
    }
    if (f.launchd && f.launchd.length) {
      kids.push(h("h2", { class: "section-h" }, i18nNode("A0251")));
      for (const s of f.launchd) {
        // a running service's last exit code is just its previous restart; only a stopped one with an error matters
        const down = s.pid === null && s.lastExit !== 0;
        kids.push(
          h("div", { class: "svc" },
            h("span", { class: down ? "bad" : "" }, s.label.replace(/^ai\./, "")),
            h("span", null, s.pid ? `pid ${s.pid}` : down ? i18nNode("U0519") : i18nNode("common.waiting")),
            h("span", { class: down ? "bad" : "" }, down ? i18nNode("U0520", { lastExit: s.lastExit }) : ""))
        );
      }
    }
  }

  function paneTokens(kids) {
    if (!agentList().length && !S.relay.tokens.length) {
      kids.push(h("p", { class: "pane-title" }, i18nNode("U0522")));
      return;
    }
    if (TV) return TV.pane(kids);
  }

  // Token pane (tokens-view.js): range control, figures, chart, agents and models; keeps one copy per range
  const TV = window.DeckTokens
    ? window.DeckTokens.create({
      h, k, deck, store, mark,
      isOpen: () => UD.isOpen(),
      snapshotRows: () => S.relay.tokens,
      usageStatus: () => S.relay.fleet && S.relay.fleet.usage,
      sessions: () => S.relay.sessions.values(),
      where: (s) => where(s),
    })
    : null;
  async function refreshTokens() {
    if (TV) await TV.refresh();
  }
  // The Usage view (usage-detail.js): quotas, today across all agents, profiles, services, then token history, over
  // the chat column like Settings. Opened from the fleet panel's "Usage details", Ctrl/Cmd+J without the fleet panel
  // and --tab=usage|fleet|tokens; Back or Escape returns to the chat. It draws the same paneFleet + paneTokens.
  const UD = window.DeckUsageDetail.create({
    h, t: i18nText,
    fill: (kids) => { paneFleet(kids); paneTokens(kids); window.DeckI18n.apply(document); },
    canOpen: () => !!(S.settings && S.settings.firstRunDone),
    onToggle: (open) => {
      publishDesktopView();
      if (!open) return;
      SV.close(); // one view over the chat at a time (an open All sessions browser stays under it, as with Settings)
      SH.setMain("chat");
      refreshTokens();
    },
  });

  // ---------------------------------------------------------------- scheduler (throttled, focus-safe)
  const dirty = new Set();
  const lastAt = { rail: 0, panel: 0 };
  const MIN_GAP = { rail: 400, panel: 900 };
  let raf = 0;
  let later = 0;

  function mark(...parts) {
    let force = false;
    if (typeof parts[parts.length - 1] === "boolean") force = parts.pop();
    for (const p of parts) dirty.add(p);
    if (force) for (const p of parts) lastAt[p] = 0;
    if (!raf) raf = requestAnimationFrame(flush);
    desktopSync(); // desktop shell: the pet and tray follow every state change (debounced, only on change)
    publishDesktopView(); // clear a changed selection now, before the throttled render
  }

  function flush() {
    raf = 0;
    const t = performance.now();
    const fk = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
    let deferred = false;
    for (const p of [...dirty]) {
      if (MIN_GAP[p] && t - lastAt[p] < MIN_GAP[p]) {
        deferred = true;
        continue;
      }
      dirty.delete(p);
      lastAt[p] = t;
      if (p === "top") { renderTop(); renderHosts(); }
      else if (p === "rail") renderRail();
      else if (p === "head") {
        renderHead();
        renderCrumb(); // top bar: breadcrumb + channel chip, and the shell's "session" event
      }
      else if (p === "msgs") renderMsgs();
      else if (p === "strip") renderStrip();
      else if (p === "panel") renderPane();
    }
    if (fk) {
      const el = document.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
      if (el && el !== document.activeElement) el.focus({ preventScroll: true });
    }
    if (deferred && !later) {
      later = setTimeout(() => {
        later = 0;
        if (!raf) raf = requestAnimationFrame(flush);
      }, 300);
    }
  }

  // live clocks without re-rendering
  setInterval(() => {
    for (const el of document.querySelectorAll("[data-since]")) el.textContent = (el.dataset.prefix || "") + since(Number(el.dataset.since));
  }, 1000);

  // ---------------------------------------------------------------- actions
  function msgMap(key) {
    let m = S.msgs.get(key);
    if (!m) {
      m = new Map();
      S.msgs.set(key, m);
    }
    return m;
  }

  async function select(key) {
    if (!key || !CM.telegramReady(S.settings)) return;
    S.sel = key;
    S.unread.set(key, 0);
    store.set("deck.sel", key);
    DR.sync(); // swap the draft now, not at the next render
    scrollToEnd = true;
    mark("rail", "head", "msgs", "strip", "panel", true);
    if (!S.loaded.has(key) && !S.loading.has(key) && S.tg.status === "open") {
      S.loading.add(key);
      try {
        const list = await deck.history(key);
        const m = msgMap(key);
        for (const x of list) m.set(x.id, x);
        S.loaded.add(key);
      } catch (e) {
        S.note = i18nText("U0539", { e: cleanErr(e) });
        S.noteBad = true;
        renderNote();
      } finally {
        S.loading.delete(key);
      }
      if (S.sel === key) {
        scrollToEnd = true;
        mark("msgs", "rail");
      }
    }
  }

  function renderNote() {
    const empty = !els.input.value.trim() && !AT.pending(); // nothing to send: text or staged files
    const busy = hermesMode() ? hermesComposerState(empty) : telegramComposerState(empty); // busy-send.js: what Enter / the button does now
    const hint = !S.note && busy && busy.hint ? i18nText(busy.hint.key, busy.hint.vars) : "";
    els.note.textContent = S.note || hint;
    els.note.className = `composer-note${S.noteBad ? " bad" : hint ? " hint" : ""}`;
    const takeoverTarget = hermesMode() && H.sel ? { sid: H.sel, profile: (H.nodes.get(H.sel) || H.hist.get(H.sel) || {}).profile || "default" } : null;
    const takeover = takeoverTarget && TK.pending(takeoverTarget);
    if (takeover) els.note.replaceChildren(
      h("span", null, i18nNode("takeover.running")), " · ",
      h("button", { type: "button", class: "takeover-button", disabled: takeover.busy || !bridgeOpen(), onclick: () => TK.run(takeoverTarget) }, i18nNode(takeover.busy ? "takeover.taking" : "takeover.action")),
      S.noteBad && S.note ? h("span", { role: "alert" }, ` · ${S.note}`) : null
    );
    const kind = busy ? busy.button : "send";
    if (els.send.dataset.kind !== kind) {
      els.send.dataset.kind = kind;
      els.send.classList.toggle("stop", kind === "stop");
      i18nBind(els.send, "textContent", kind === "stop" ? "live.stop" : kind === "queue" ? "live.btn.queue" : kind === "steer" ? "live.btn.steer" : "U0616");
      i18nBind(els.send, "title", kind === "stop" ? "live.stopTip" : kind === "queue" ? "live.btn.queueTip" : kind === "steer" ? "live.btn.steerTip" : "composer.sendHelp");
    }
    if (kind === "stop") els.send.disabled = !!H.stopping;
    else els.send.disabled = empty || (hermesMode() ? H.sending || H.steering || !H.sel || !bridgeOpen() : S.sending || !S.sel || S.tg.status !== "open");
    if (PK) PK.sync();
  }

  /**
   * The composer while the selected Hermes session works: the button is Stop when the box is empty (and the turn can be
   * stopped), else it names what Enter does (Queue / Steer); the hint names the Ctrl/Cmd+Enter choice. null when idle.
   */
  function hermesComposerState(empty) {
    const n = H.sel ? H.nodes.get(H.sel) : null;
    const live = nodeLive(n);
    if (!H.sel || !bridgeOpen() || (!live && !OB.pending(H.sel))) return null;
    const controllable = nodeControllable(n);
    const files = AT.pending();
    if (empty && live && (controllable || n.bound)) return { button: "stop", hint: null };
    const mode = BS.modeOf(S.settings);
    const d = BS.decide({ mode, busy: true, live, controllable, files });
    return { button: d.action, hint: empty ? null : BS.hint({ mode, live, controllable, files, mac: document.body.classList.contains("mac") }) };
  }

  /** Telegram text/files still send normally; an empty box can stop its mapped Hermes turn. */
  function telegramComposerState(empty) {
    if (!empty) return null;
    const s = composerSession();
    const n = s && s.node;
    return nodeLive(n) && (nodeControllable(n) || n.bound) ? { button: "stop", hint: null, node: n } : null;
  }

  async function send({ alt = false, command = null, key: commandKey = null } = {}) {
    const fromPicker = typeof command === "string";
    if (fromPicker && (hermesMode() || S.sel !== commandKey)) return false;
    if (!fromPicker && /^\/handoff(?:\s|$)/i.test(els.input.value.trim()) && workspace) {
      try {
        if (await workspace.command(els.input.value.trim())) { els.input.value = ""; autosize(); DR.touch(); renderNote(); }
      } catch (e) { S.note = cleanErr(e); S.noteBad = true; renderNote(); }
      return;
    }
    if (!fromPicker && AT.pending()) return AT.send(); // staged files go first, the text as their caption (A7)
    if (hermesMode()) return hermesSend([], [], { alt });
    const stop = !fromPicker && telegramComposerState(!els.input.value.trim());
    if (stop) return hermesStopNow(stop.node);
    const text = fromPicker ? command : els.input.value.trim();
    if (!text || !S.sel || S.sending || S.tg.status !== "open") return false;
    S.sending = true;
    S.note = i18nText("U0464");
    S.noteBad = false;
    renderNote();
    const key = S.sel;
    const replyTo = fromPicker ? null : MV.replyTarget(key); // native commands are standalone messages
    try {
      const m = await deck.send(key, text, replyTo || undefined);
      msgMap(m.key).set(m.id, m);
      if (replyTo) MV.clearReply(key);
      if (!fromPicker) DR.sent(key, text); // picker commands preserve text, reply and attachment drafts
      S.note = null;
      scrollToEnd = true;
      mark("msgs", "rail");
      return true;
    } catch (e) {
      if (fromPicker) throw e;
      S.note = i18nText("U0540", { e: cleanErr(e) });
      S.noteBad = true;
    } finally {
      S.sending = false;
      renderNote();
    }
  }

  function autosize() {
    const box = els.input;
    const chat = box.closest(".chat");
    // up to ~40% of the chat column (never above 220px, never below two lines)
    const cap = Math.max(88, Math.min(220, Math.round(((chat && chat.clientHeight) || 560) * 0.4)));
    box.style.setProperty("--composer-max", `${cap}px`);
    // One row (tools, text, picker, Send) while the text fits on it. Measured in the one-row layout every time, so a
    // line that fits only when the tools move below does not flip the two layouts back and forth.
    const card = box.closest(".composer");
    if (card) {
      box.style.height = "";
      card.classList.add("compact");
      // An empty box always fits: Chromium counts a long placeholder in scrollWidth, which kept narrow panes on two rows.
      const fits = !box.value.includes("\n") && (box.clientWidth === 0 || box.clientWidth >= 120 && (!box.value || box.scrollWidth <= box.clientWidth));
      card.classList.toggle("compact", fits);
      if (fits) { scrollCue(); return; }
    }
    box.style.height = "auto";
    box.style.height = `${Math.min(cap, box.scrollHeight)}px`;
    scrollCue();
  }
  /** The top fade of the composer card shows only while the text is scrolled. */
  function scrollCue() {
    const card = els.input.closest(".composer");
    if (card) card.classList.toggle("scrolled", els.input.scrollTop > 2);
  }
  els.input.addEventListener("scroll", scrollCue, { passive: true });

  els.input.addEventListener("input", autosize);
  window.addEventListener("resize", autosize); // a narrower chat column can push the text off the one row
  els.input.addEventListener("input", () => renderNote()); // the Send button follows the box
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send({ alt: e.ctrlKey || e.metaKey }); // while the session works: Ctrl/Cmd+Enter does the other of queue / steer
    }
  });
  els.send.addEventListener("click", (e) => {
    if (els.send.dataset.kind === "stop") {
      // Send turns into Stop under the pointer once the box empties: a double-click on Send must not stop the turn
      if (Date.now() - (H.sentAt || 0) < 900) return;
      return hermesStopNow();
    }
    H.sentAt = Date.now();
    send({ alt: e.ctrlKey || e.metaKey });
  });
  // C5: scrolling, coming back to the window or un-hiding it may bring unread messages into view
  els.msgs.addEventListener("scroll", () => reads.check(), { passive: true });
  window.addEventListener("focus", () => reads.check());
  document.addEventListener("visibilitychange", () => reads.check());
  els.msgs.addEventListener("click", (e) => {
    const a = e.target.closest(".lnk");
    if (a) {
      e.preventDefault();
      deck.openExternal(a.dataset.url);
    }
  });
  els.msgs.addEventListener("keydown", (e) => {
    const a = e.target.closest && e.target.closest(".lnk");
    if (a && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      deck.openExternal(a.dataset.url);
    }
  });

  // ---------------------------------------------------------------- feeds
  function applyTgStatus(st) {
    S.tg.status = st.status;
    S.tg.step = st.step || null;
    S.tg.error = st.error || null;
    S.tg.detail = st.detail || null;
    S.tg.code = st.code || null;
    S.tg.hint = st.hint || null;
    S.tg.viaApp = !!st.viaApp;
    if (st.me) S.tg.me = st.me;
    if (st.status === "open") {
      S.formError = null;
      for (const k of Object.keys(formValues)) delete formValues[k];
    }
  }

  function applyDialogs(d) {
    S.tg.me = d.me || S.tg.me;
    S.tg.group = d.group || null;
    // Keep the snapshot intact: a reconnect can deliver it before the settings save reply.
    S.tg.bots = d.bots || [];
    S.tg.topics = d.topics || [];
    S.tg.forumGroups = d.forumGroups || [];
    const items = railAgents();
    if (S.sel && ![...items, ...S.tg.topics].some((x) => x.key === S.sel)) S.sel = null;
    if (!items.length && !S.tg.topics.length) {
      // logged out (or nothing to show): forget everything from the previous account
      S.msgs.clear();
      S.loaded.clear();
      S.unread.clear();
      S.sel = null;
      reads.forget();
      return;
    }
    for (const x of [...S.tg.bots, ...S.tg.topics]) if (!S.unread.has(x.key)) S.unread.set(x.key, x.unread || 0);
    if (!S.sel) {
      // Agent names and the rail order come from the relay; wait for its snapshot unless it is down.
      const relayDown = S.relay.status === "closed" || S.relay.status === "unconfigured";
      if (!agentList().length && !relayDown) return;
      const want = pendingSelect || store.get("deck.sel");
      let key = null;
      if (want && [...items, ...S.tg.topics].some((x) => x.key === want)) key = want;
      else if (want) {
        const it = items.find((x) => x.agent && x.agent.name.toLowerCase() === want.toLowerCase());
        if (it) key = it.key;
      }
      if (!key && items[0]) key = items[0].key;
      if (key) select(key);
    }
  }
  let pendingSelect = null;

  deck.onRelay((m) => {
    switch (m.t) {
      case "status":
        S.relay.status = m.status;
        S.relay.error = m.error || null;
        if (!S.sel && S.tg.bots.length && (m.status === "closed" || m.status === "unconfigured")) applyDialogs(S.tg);
        mark("top", "head", "strip", "panel");
        break;
      case "snapshot":
        S.relay.agents = m.agents || {};
        S.relay.sessions = new Map((m.sessions || []).map((s) => [s.sid, s]));
        S.relay.fleet = m.fleet || null;
        S.relay.tokens = m.tokens || [];
        S.relay.status = "open";
        if (!S.sel && S.tg.bots.length) applyDialogs(S.tg);
        if (AG) AG.onRelay(m);
        mark("top", "rail", "head", "strip", "panel", true);
        resumeSourceOpen();
        break;
      case "evs":
        for (const s of m.sessions || []) S.relay.sessions.set(s.sid, s);
        if (m.agents) S.relay.agents = m.agents;
        for (const e of m.evs || []) applyDetail(e);
        if (AG) AG.onRelay(m); // B1: live steps of the open session
        mark("top", "rail", "head", "strip", "panel");
        resumeSourceOpen();
        break;
      case "fleet":
        S.relay.fleet = m.fleet;
        if (UD.isOpen()) mark("panel");
        mark("top"); // the sidebar footer's quota bar
        break;
      case "agents":
        S.relay.agents = m.agents || S.relay.agents;
        if (m.tokens) S.relay.tokens = m.tokens;
        mark("top", "rail", "panel");
        break;
      default:
        break;
    }
  });

  deck.onTelegram((m) => {
    switch (m.t) {
      case "status":
        applyTgStatus(m);
        refreshSettingsPane();
        if (m.status === "open" && S.sel && !S.loaded.has(S.sel)) select(S.sel);
        mark("top", "rail", "msgs", "head");
        renderNote();
        resumeSourceOpen();
        break;
      case "dialogs":
        applyDialogs(m);
        refreshSettingsPane();
        mark("rail", "head", "msgs", "panel", true);
        resumeSourceOpen();
        break;
      case "msg":
      case "edit": {
        const x = m.m;
        const had = msgMap(x.key).has(x.id);
        // C9: an edit whose reactions are "min" (no user's own) keeps the own marks the view already has
        if (x.reactions && x.reactions.min && window.DeckReactions) x.reactions = window.DeckReactions.keepMine(had ? msgMap(x.key).get(x.id).reactions : null, x.reactions);
        msgMap(x.key).set(x.id, x);
        if (m.t === "msg" && !had && !x.out && x.fromBot) PK?.telegramReply(x.key, x.text);
        if (m.t === "msg" && !had && !x.out && x.key !== S.sel) S.unread.set(x.key, (S.unread.get(x.key) || 0) + 1);
        if (x.key === S.sel) mark("msgs");
        mark("rail");
        break;
      }
      case "read": // C5: read on another device; a read only ever lowers the badge
        if (S.unread.has(m.key)) S.unread.set(m.key, RS.afterRead(S.unread.get(m.key), m.unread));
        mark("rail");
        break;
      case "counts": // C5: fresh counts after a reconnect; the open chat keeps no badge
        if (RS.applyCounts(S.unread, m.counts, { exact: readsOn(), hold: S.sel })) mark("rail");
        reads.check();
        break;
      case "avatar":
        S.avatars[m.key] = m.url;
        mark("rail", "head");
        break;
      case "people": // group senders' and reactors' photos and admin badges
        MV.people(m.users);
        if (S.sel) mark("msgs");
        break;
      case "reactions": // C9: a message's reaction chips changed
        if (MV.reactions(m) && m.key === S.sel) mark("msgs");
        break;
      case "typing":
        S.typing.set(m.key, nowS());
        mark("rail", "head", "strip");
        setTimeout(() => mark("rail", "head", "strip"), 6500);
        break;
      default:
        break;
    }
  });

  // ---------------------------------------------------------------- desktop shell (A9–A11)
  // The status pet and the tray tooltip get a small fleet summary whenever it changes; main sends back
  // notification clicks (open that chat), chimes (renderer/chime.js) and settings changed from the tray.
  const desk = deck.desktop || null;
  const unseen = new Set(); // "key:id" of replies that reached the open chat while the window was in the background
  let deskSent = "";
  let deskTimer = 0;

  /** All hosts' open approvals and questions; use the active bridge until the inbox has booted. */
  function pendingCount() {
    try {
      const inbox = window.DeckInbox?.store;
      return inbox ? inbox.items().filter(x => x.request).length : H.requests.length;
    } catch {
      return 0; // before the bridge section has run
    }
  }

  function desktopSummary() {
    const agents = agentList();
    let unread = unseen.size;
    for (const n of S.unread.values()) unread += n || 0;
    return {
      running: agents.reduce((n, a) => n + (a.running ? 1 : 0), 0),
      subs: agents.reduce((n, a) => n + (a.subsRunning || 0), 0),
      unread,
      pending: pendingCount(),
      offline: S.relay.status !== "open",
    };
  }

  function desktopSync() {
    if (!desk || deskTimer) return;
    deskTimer = setTimeout(() => {
      deskTimer = 0;
      const s = desktopSummary();
      const key = JSON.stringify(s);
      if (key === deskSent) return;
      deskSent = key;
      desk.petState(s);
    }, 250);
  }

  /** Settings > Desktop > "Test notification": the result shows next to the button. */
  async function testNotification(btn) {
    let r = "error";
    try {
      r = await desk.testNotification();
    } catch {
      /* reported below */
    }
    SV.notify(r === "ok", r === "ok" ? i18nText("U0541") : r === "unsupported" ? i18nText("U0542") : i18nText("U0543"), { anchor: btn });
  }

  function validSourceOpen(e) {
    const text = (s, max) => typeof s === "string" && s.length > 0 && s.length <= max && !/[\x00-\x1f\x7f]/.test(s);
    return !!e && text(e.hostId, 200) && [null, "telegram", "sessions", "bots"].includes(e.channel) &&
      (e.key == null || text(e.key, 200)) && (e.sid == null || text(e.sid, 512)) &&
      (e.profile == null || text(e.profile, 64)) && (e.id == null || text(e.id, 512)) &&
      (e.channel === "telegram" ? /^(u|t)\d+$/.test(e.key) : text(e.sid, 512) && text(e.profile, 64)) &&
      (e.id == null || (text(e.sid, 512) && text(e.profile, 64)));
  }
  function clearSourceOpen() {
    pendingSourceOpen = null;
    try { sessionStorage.removeItem("deck.source-open"); } catch { /* no reload intent available */ }
  }
  function restoreSourceOpen() {
    if (!pendingSourceOpen) {
      try { pendingSourceOpen = JSON.parse(sessionStorage.getItem("deck.source-open")); } catch { /* invalid/blocked storage */ }
      // Only the requested destination may resume a reload; never bounce a stale page to another host.
      if (pendingSourceOpen?.hostId !== pageHost) clearSourceOpen();
    }
    resumeSourceOpen();
  }
  function openSource(e) {
    if (hostSwitchPending || !validSourceOpen(e)) return;
    pendingSourceOpen = { hostId: e.hostId, channel: e.channel, key: e.key, sid: e.sid, profile: e.profile, id: e.id,
      expiresAt: Date.now() + 60000 }; // a delayed feed may resolve intent, not replay an old click indefinitely
    resumeSourceOpen();
  }
  async function resumeSourceOpen() {
    const e = pendingSourceOpen;
    if (!e || !sourceOpenReady || hostSwitchPending) return;
    if (!validSourceOpen(e) || !Number.isFinite(e.expiresAt) || e.expiresAt <= Date.now() ||
      pageHost !== S.settings?.activeHost || !S.settings?.hosts?.some(h => h.id === e.hostId)) return clearSourceOpen();
    if (e.hostId !== pageHost) {
      // Session storage is window-scoped and survives the existing guarded host reload.
      try { sessionStorage.setItem("deck.source-open", JSON.stringify(e)); } catch { return clearSourceOpen(); }
      await selectHost(e.hostId);
      if (pendingSourceOpen === e && !hostSwitchPending) clearSourceOpen(); // refused selection
      return;
    }
    const mode = e.channel || "sessions"; // unknown source may only use an exact known session
    if (!S.settings.firstRunDone || !chatModes().includes(mode)) return clearSourceOpen();
    if (e.id && !sourceRequestsReady) return;
    const request = e.id && H.requests.find(r => r.id === e.id && r.sid === e.sid && r.profile === e.profile);
    if (e.id && !request) return clearSourceOpen();
    const node = H.nodes.get(e.sid) || H.stored.get(e.sid) || (H.hist.get(e.sid)?.loaded ? H.hist.get(e.sid) : null);
    if (node && e.profile && node.profile !== e.profile) return clearSourceOpen();
    const relayOnly = mode !== "telegram" && H.status.status === "off" && !e.id;
    if (relayOnly) {
      const session = S.relay.sessions.get(e.sid);
      if (session && session.profile !== e.profile) return clearSourceOpen();
      if (!AG || !session) return;
    }
    if (mode === "telegram") {
      if (S.tg.status !== "open" || ![...S.tg.bots, ...S.tg.topics].some(x => x.key === e.key)) return;
    } else if (!relayOnly && (!bridgeOpen() || !node)) return;
    if (request && (!bridgeOpen() || !node)) return;
    clearSourceOpen(); // consume before navigation marks/render callbacks can retry
    DR.flush();
    AG?.close();
    setChatChannel(mode);
    SV.close();
    UD.close(false);
    allSessionsView()?.close();
    SH.setMain("chat");
    if (mode === "telegram") select(e.key);
    else if (relayOnly) AG.open(e.sid);
    else if (H.nodes.has(e.sid)) hermesSelect(e.sid);
    else hermesOpen(e.sid, e.profile);
    if (request) {
      // Telegram request cards live in the direct session review, not in Telegram's transcript.
      if (mode !== "telegram" || openChatFor(request)) focusRequest(request);
    }
  }
  function focusRequest(request) {
    const host = S.settings?.activeHost, mode = chatMode(), sid = H.sel;
    document.activeElement?.blur(); // release the inline editor's render hold; H.answers retains its draft
    requestAnimationFrame(() => {
      if (hostSwitchPending || !bridgeOpen() || host !== S.settings?.activeHost || (pageHost && host !== pageHost) ||
        mode !== chatMode() || sid !== H.sel || !H.requests.some(r => r.id === request.id && r.sid === request.sid && r.profile === request.profile)) return;
      renderMsgs();
      const card = [...document.querySelectorAll(".hreq")].find(el => el.dataset.requestId === request.id && el.dataset.requestProfile === request.profile);
      card?.scrollIntoView({ block: "center" });
      card?.focus({ preventScroll: true });
    });
  }

  if (desk) {
    // the open chat counts as read only while the window is in front
    deck.onTelegram((m) => {
      const x = m && m.t === "msg" ? m.m : null;
      if (x && !x.out && x.key === S.sel && !document.hasFocus()) {
        unseen.add(`${x.key}:${x.id}`);
        desktopSync();
      }
    });
    window.addEventListener("focus", () => {
      if (!unseen.size) return;
      unseen.clear();
      desktopSync();
    });
    // C5: replies read on another device no longer count as unseen
    deck.onTelegram((m) => {
      if (!m || m.t !== "read" || !unseen.size) return;
      for (const u of [...unseen]) {
        const [key, id] = u.split(":");
        if (key === m.key && Number(id) <= Number(m.maxId)) unseen.delete(u);
      }
      desktopSync();
    });
    desk.onEvent((e) => {
      if (!e) return;
      if (e.t === "source-open") openSource(e);
      else if (e.t === "select" && /^(u|t)\d+$/.test(String(e.key))) {
        if (!chatModes().includes("telegram")) return;
        setChatChannel("telegram");
        SV.close();
        UD.close(false);
        allSessionsView()?.close();
        SH.setMain("chat");
        select(e.key);
      }
      else if (e.t === "select" && String(e.key).startsWith("hs:")) openChatFor({ sid: String(e.key).slice(3), profile: e.profile });
      else if (e.t === "request-open") {
        const request = H.requests.find(r => r.id === e.id && r.profile === e.profile && r.sid === e.sid);
        if (request && openChatFor(request)) focusRequest(request);
        else if (request) setRailView("needs");
      }
      else if (e.t === "chime" && typeof window.deckChime === "function") window.deckChime(String(e.kind || "reply"), S.settings); // that event's sound (Settings > Desktop > Notifications)
      else if (e.t === "settings-open") openSettings(typeof e.section === "string" ? e.section : undefined); // an update toast
      else if (e.t === "settings" && e.settings) {
        S.settings = e.settings;
        refreshSettingsPane();
        resumeSourceOpen();
      }
    });
  }

  // ---------------------------------------------------------------- direct Hermes connection (bridge)
  // Sessions, history, approvals and controls straight from a Hermes host (main/bridge.js), with no
  // Telegram or relay needed. Reads poll the visible session's history; every mutation is a click.
  // State is kept per session id, so a late reply can only ever update the session it belongs to.
  const H = {
    status: { status: "off" },
    platform: "",
    profiles: [], // host catalog, independent of recent/live sessions
    profilesAt: 0,
    profileRead: null,
    nodes: new Map(), // sid -> snapshot node
    rank: new Map(), // sid -> stable rail position (rows never jump while agents work)
    rankSeq: 0,
    requests: [], // open approvals and questions
    titles: new Map(), // sid -> title from session.list
    snap: [], // the latest snapshot's nodes (live and recently seen sessions)
    stored: new Map(), // sid -> rail row for a recent stored session (session.list) the snapshot does not list
    sel: null,
    hist: new Map(), // sid -> {msgs, loaded, loading, error, hasMore, offset, older, sig, profile}
    echo: new Map(), // sid -> [{text, at, files?}] turns sent from here, until history has them
    gone: new Map(), // sid -> turn id whose live state the user's Stop found stale (until a newer turn shows up)
    deleted: new Set(), // sids deleted in this run: a lagging snapshot must not bring them back
    live: new Map(), // sid -> {text, done, doneAt} streamed reply to a turn sent from here
    noticeOpen: new Set(), // keys of expanded system-notice chips
    subOpen: new Set(), // parent sids whose folded finished sub-agents are shown
    ctl: new Map(), // sid -> inline control state
    answers: new Map(), // request id -> {busy, error, text: {qid}, pick: {qid: []}}
    sending: false,
    steering: false, // a composer steer is in flight (busy-send.js)
    stopping: null, // sid the composer's Stop is stopping
    pollTimer: 0,
    lastMode: null,
    draft: null, // unsaved values of the settings form
    formMsg: null,
    connTest: { test: null, testBusy: false }, // Settings: the connection test line
    els: {}, // settings elements updated in place
  };
  const H_STATE_TR = { get idle() { return i18nText("U0281"); }, get thinking() { return i18nText("U0376"); }, get working() { return i18nText("U0410"); }, get searching() { return i18nText("U0562"); }, get finished() { return i18nText("common.done"); }, get error() { return i18nText("common.error"); }, get question() { return i18nText("A0257"); }, get approval() { return i18nText("A0258"); }, get ratelimit() { return i18nText("U0563"); } };
  const CTL_TR = {
    get queued() { return i18nText("U0564"); },
    get redirected() { return i18nText("U0565"); },
    get interrupted() { return i18nText("session.stopped"); },
    get stale() { return i18nText("U0089"); },
    get not_running() { return i18nText("U0566"); },
    get not_interrupted() { return i18nText("U0566"); },
    get rejected() { return i18nText("A0259"); },
    get unsupported() { return i18nText("U0567"); },
    get invalid_text() { return i18nText("U0568"); },
    get duplicate_id_conflict() { return i18nText("U0569"); },
  };
  const CHOICE_TR = { get once() { return i18nText("A0260"); }, get session() { return i18nText("A0261"); }, get always() { return i18nText("A0262"); }, get deny() { return i18nText("A0263"); } };

  const bridgeOn = () => !!(S.settings && S.settings.bridge && S.settings.bridge.mode && S.settings.bridge.mode !== "off");
  const bridgeOpen = () => H.status.status === "open";
  // dictation (voice.js): mic button + Ctrl+Shift+M record, the Hermes host transcribes, the text lands in the box
  // (created here, after bridgeOpen: the button paints its first state at once)
  const VO = window.DeckVoice.create({
    h, S, deck, els, cleanErr, renderNote,
    hermesReady: () => bridgeOpen(),
    autosize: () => autosize(),
    chatKey: () => DR.key(), // dictation lands in the draft of the chat that started it
    drafts: DR,
  });
  // files the agent offered (hermes-files.js): chips with size, Download, progress, Open
  const HF = window.DeckHermesFiles.create({ h, deck, mark, cleanErr, VB });
  // images/files the user sent (media-preview.js): thumbnails + lightbox from the stored @image:/@file: lines
  const MP = window.DeckMediaPreview.create({ h, deck, mark, cleanErr, HF });
  /** The selected mode remains visible even before its connection is configured. */
  function hermesMode() {
    return !!S.settings && S.settings.firstRunDone && chatMode() !== "telegram";
  }
  const nodeLive = (n) => !!n && n.terminalAt === null && (n.active || n.state === "thinking" || n.state === "working" || n.state === "searching");
  const nodeControllable = (n) => nodeLive(n) && n.controlAvailable && !!n.turnId && !!n.ownerPid;
  const hStateClass = (n) => (nodeLive(n) ? "running" : n.state === "error" ? "failed" : n.state === "finished" ? "done" : "idle");
  const profileLabel = (p) => (p === "default" ? i18nText("U0570") : i18nText("common.profile", { p: p }));
  const fragment = () => document.createDocumentFragment();
  // Botlar (bots.js, botface.js): the Hermes rail's bot mode, as in Hermes Desktop; one row per profile and
  // its one "Bot Chat", independent of Telegram. Hooks below are marked "Botlar".
  const BT = window.DeckBots
    ? window.DeckBots.create({
        h, svg, deck, store, mark, ago, hm, cleanErr, nodeLive, bridgeOpen, hermesMode, renderNote, hermesSelect, hermesOpen, hermesRow, newSessionRow,
        H: () => H,
        statusText: () => hermesStatusText(),
        reselect: () => hermesAutoSelect(),
        fleet: () => S.relay.fleet,
        relayHas: (sid) => S.relay.sessions.has(sid),
        compact: () => layout.compact,
      })
    : null;

  // New session lifecycle: drafts/files/queued or submitted turns are real intent, not ghosts.
  const RG = window.DeckRailSessions.create({
    hasIntent: (sid) => {
      const key = `hermes:${sid}`;
      const draft = DR.key() === key ? els.input.value : (DR.read(key) || {}).text;
      const n = H.nodes.get(sid);
      return !!(draft && draft.trim()) || AT.pending(key) || OB.size(sid) > 0 ||
        H.echo.has(sid) || H.live.has(sid) || (H.hist.get(sid) || {}).msgs?.length > 0 ||
        nodeLive(n) || !!(n && (n.turnId || n.ctxUsed > 0));
    },
    forget: (sid) => {
      const maps = [H.nodes, H.stored, H.hist, H.titles, H.rank, H.ctl];
      const saved = maps.map((map) => [map, map.get(sid)]);
      const snap = H.snap.filter((n) => n.sid === sid);
      if (H.sel === sid) { H.sel = null; store.set("deck.hsel", ""); }
      hermesForget(sid);
      // Bridge can refuse if an external turn arrived before renderer received its event.
      return () => {
        H.deleted.delete(sid);
        for (const [map, value] of saved) if (value !== undefined && !map.has(sid)) map.set(sid, value);
        if (!H.snap.some((n) => n.sid === sid)) H.snap.push(...snap);
        mark("rail", "head", "msgs", "strip", "panel", true);
      };
    },
    create: (profile) => deck.bridge.create({ profile }),
    discard: (sid) => deck.bridge.discard(sid),
    resumeUnload: () => deck.bridge.finishUnload(),
  });
  RG.bindUnload(window);

  // All sessions (sessions-browser.js): every stored session of every platform and profile, with search and bulk actions.
  const sidebarSources = window.DeckSessions
    ? window.DeckSessions.createSidebarSources({ store, rows: () => [...H.nodes.values()], changed: () => {
      if (!sidebarSources.chips().includes(rail.source)) {
        rail.source = "all";
        store.set("deck.source", "all");
      }
      mark("rail", true);
    } })
    : null;
  const sidebarNeeds = (r) => {
    const sid = r.sid || r.id;
    const n = H.nodes.get(sid);
    return H.requests.some((ask) => ask.sid === sid) || !!(n && (n.state === "approval" || n.state === "question"));
  };
  const SB = window.DeckSessions
    ? window.DeckSessions.create({ h, deck, mark, ago, cleanErr, nodeLive, bridgeOpen, hermesMode, hermesOpen, hermesForget, MV, H: () => H, sidebarSources, sidebarNeeds, beforeOpen: () => RG.leave(H.sel) })
    : null;
  /** The All sessions browser for code above this point (the shell's search button, the crumb's read-only chip). */
  function allSessionsView() {
    return SB;
  }
  /** Resolve the Hermes session behind the chat on screen, never an unrelated Hermes selection. */
  function composerSession() {
    if (!hermesMode()) {
      if (!S.sel || S.tg.status !== "open") return null;
      const sess = S.relay.status === "open" ? liveFor(S.sel) : null;
      const n = bridgeOpen() && sess ? H.nodes.get(sess.sid) : null;
      const sc = scopeOf(S.sel);
      const owner = sc?.kind === "topic" && sess ? agentList().find((a) => a.name === sess.agent) : null;
      return { sid: n?.sid || `tg:${S.sel}`, key: S.sel, profile: n?.profile,
        node: n || null, telegram: true, inventory: !!n,
        bot: owner?.bot || "" };
    }
    if (!bridgeOpen()) return null;
    if (!H.sel || (BT && BT.isDraft(H.sel)) || SB?.readOnly(H.sel)) return null;
    const n = H.nodes.get(H.sel) || null;
    const st = H.hist.get(H.sel);
    return { sid: H.sel, profile: (n && n.profile) || (st && st.profile) || "default", node: n };
  }

  // The model and reasoning chips left of Send (model-picker.js): follow the chat on screen.
  let pickNoteTimer = 0;
  PK = window.DeckModelPicker.create({
    h, i18nText, cleanErr, bridge: deck.bridge, composer: document.querySelector(".composer"), send: els.send,
    thinking: { isOpen: () => LA.isOpen(), setOpen: (v) => LA.setOpen(v) },
    note: (text, bad) => {
      S.note = text;
      S.noteBad = !!bad;
      renderNote();
      clearTimeout(pickNoteTimer);
      pickNoteTimer = setTimeout(() => {
        if (S.note !== text) return;
        S.note = null;
        renderNote();
      }, bad ? 10000 : 5000);
    },
    session: composerSession,
    sendCommand: (command, key) => send({ command, key }),
  });

  // "@" and "/" suggestions in the composer (suggest.js). Lists are read when the popup opens and kept briefly.
  const suggestCache = new Map(); // "<what>:<scope>" -> {at, items}
  async function cachedList(id, ms, load) {
    const hit = suggestCache.get(id);
    if (hit && Date.now() - hit.at < ms) return hit.items;
    const items = await load();
    suggestCache.set(id, { at: Date.now(), items });
    return items;
  }
  /** The names to tag with "@": Telegram usernames (agents, bots, seen group members) or Hermes profile names. */
  async function mentionItems() {
    if (!hermesMode()) {
      if (!S.sel) return [];
      const items = [];
      const hidden = new Set(((S.settings && S.settings.hiddenBots) || []).map((v) => v.toLowerCase()));
      for (const a of agentList()) {
        if (a.bot && !hidden.has(a.bot.toLowerCase())) items.push({ insert: `@${a.bot}`, label: `${a.emoji ? `${a.emoji} ` : ""}${a.name}`, detail: `@${a.bot}`, keys: [a.profile || ""], tag: a.profile || "" });
      }
      for (const b of S.tg.bots) {
        if (b.username && !hidden.has(b.username.toLowerCase())) items.push({ insert: `@${b.username}`, label: b.title || b.username, detail: `@${b.username}` });
      }
      if (S.sel[0] === "t" && deck.members) {
        const people = await cachedList("members", 30000, () => deck.members()).catch(() => []);
        for (const p of people) items.push({ insert: `@${p.username}`, label: p.name || p.username, detail: `@${p.username}` });
      }
      return items;
    }
    const names = new Set();
    for (const a of agentList()) if (a.profile) names.add(a.profile);
    for (const n of H.nodes.values()) if (n && n.profile) names.add(n.profile);
    const rows = await cachedList("profiles", 300000, () => deck.bridge.profiles()).catch(() => []);
    const shown = new Map(rows.map((r) => [r.name, r.displayName || ""]));
    for (const r of rows) names.add(r.name);
    return [...names].sort().map((name) => {
      const agent = agentList().find((a) => a.profile === name);
      return { insert: `@${name}`, label: name, detail: shown.get(name) || (agent ? `${agent.emoji ? `${agent.emoji} ` : ""}${agent.name}` : "") };
    });
  }
  /** The slash commands of the chat on screen: the Telegram bot's registered commands, or Hermes' palette. */
  async function commandItems() {
    if (!hermesMode()) {
      if (!S.sel || S.tg.status !== "open" || !deck.botCommands) return [];
      const list = await cachedList(`tg:${S.sel}`, 60000, () => deck.botCommands(S.sel).catch(() => [])); // no commands to offer beats an error on every "/"
      return list.map((c) => ({ insert: c.insert, label: c.insert, detail: c.description, tag: S.sel[0] === "t" ? c.bot : "" }));
    }
    if (!bridgeOpen()) return [];
    const s = composerSession();
    const profile = (s && s.profile) || "default";
    const list = await cachedList(`hermes:${profile}`, 300000, () => deck.bridge.commands(profile).catch(() => [])); // an older host plugin refuses commands.catalog
    return list.map((c) => ({ insert: c.command, label: c.command, detail: c.description, tag: c.category === "Skills" ? i18nText("suggest.skill") : "" }));
  }
  if (window.DeckSuggest) {
    window.DeckSuggest.create({
      h, i18nText, input: els.input, composer: document.querySelector(".composer"),
      source: (kind) => (kind === "/" ? commandItems() : mentionItems()),
      changed: () => { autosize(); DR.touch(); renderNote(); },
    });
  }

  /** Native title when it says something; generic names ("Hermes · Telegram") fall back to source + id. */
  /**
   * Hermes prefixes prompts that come in from Telegram: "[Replying to: \"…\"]", "[Name|12345]", "[Group context …]",
   * and in groups a bare "[Name]" sender tag before an "[IMPORTANT: …]" note. A title shows what was asked, so
   * leading blocks like these are dropped.
   */
  function stripPromptPrefix(text) {
    return splitPromptPrefix(text).text;
  }

  /**
   * F2: the same leading blocks, kept: {text, blocks: [{kind: "reply"|"sender"|"context", body}], cut}.
   * body is the quoted text (reply), the name (sender) or the block's text (context). `cut` names a known
   * block that opens but never closes (a clipped preview): `text` then still starts with it, as before.
   */
  function splitPromptPrefix(text) {
    let t = String(text || "").trim();
    const blocks = [];
    let cut = null;
    for (let i = 0; i < 6 && t.startsWith("["); i++) {
      let kind = null;
      let end = -1;
      let body = "";
      if (/^\[Replying to: "/i.test(t)) {
        kind = "reply";
        end = t.indexOf('"]') + 1; // quoted reply: may hold "]" itself
        body = end > 0 ? t.slice(t.indexOf('"') + 1, end - 1) : "";
      } else {
        end = promptBlockEnd(t);
        const inner = end > 0 ? t.slice(1, end).trim() : "";
        if (/^[^\]|\n]{1,80}\|\d{3,20}$/.test(inner)) [kind, body] = ["sender", inner.replace(/\|\d+$/, "").trim()];
        else if (/^(grup bağlamı|group context|important:)/i.test(end > 0 ? inner : t.slice(1))) [kind, body] = ["context", inner];
        // a bare "[Name]" (letters, spaces, dots, dashes) only when the prompt goes on below it or another block
        // follows: "[x] done", "[TODO] …" and system headers like "[ASYNC DELEGATION …_1]" stay text
        else if (/^\p{L}[\p{L}\p{M} .'’-]{1,59}$/u.test(inner) && /\p{Ll}/u.test(inner) && /^[ \t]*(\n|\[)/.test(t.slice(end + 1))) [kind, body] = ["sender", inner];
      }
      if (!kind) break;
      if (end <= 0) {
        cut = kind;
        break;
      }
      blocks.push({ kind, body });
      t = t.slice(end + 1).trim();
    }
    return { text: t, blocks, cut };
  }

  /** Index of the "]" closing the "[" at text[0] (nested brackets counted), or -1. */
  function promptBlockEnd(text) {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "[") depth++;
      else if (text[i] === "]" && --depth === 0) return i;
    }
    return -1;
  }

  function hermesTitle(n) {
    const clean = (v) => String(v || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    const norm = (v) => clean(v).replace(/[·:–-]/g, " ").replace(/\s+/g, " ").toLowerCase();
    const generic = new Set(["hermes", "hermes telegram", "hermes tui", "hermes cli", "hermes web", "hermes host", ...[n.source, n.profile, n.role].filter(Boolean).map((v) => norm(`Hermes ${v}`))]);
    for (const v of [n.title, H.titles.get(n.sid), n.name]) {
      const label = stripPromptPrefix(clean(v));
      if (label && !generic.has(norm(label))) return label.slice(0, 110);
    }
    const src = clean(n.source);
    const lead = n.parent ? i18nText("common.subagentTitle") : src ? src.charAt(0).toLocaleUpperCase(i18nLocale()) + src.slice(1) : "Hermes";
    return `${lead} · ${n.sid.slice(-8)}`;
  }

  /** While focus is in an inline field of a region, that region is not rebuilt (focusout re-renders it). */
  function holdRegion(el) {
    const a = document.activeElement;
    return !!(a && a !== document.body && el.contains(a) && a.closest("[data-hold]") && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }
  document.addEventListener("focusout", (e) => {
    if (e.target && e.target.closest && e.target.closest("[data-hold]")) setTimeout(() => mark("head", "msgs", "panel"), 0);
  });

  function hermesStatusText() {
    const s = H.status;
    if (!bridgeOn()) return i18nText("U0045");
    if (s.status === "open") return i18nText("U0571", { size: H.nodes.size });
    if (s.status === "connecting" || s.status === "starting") return i18nText("U0572");
    if (s.status === "setup") return i18nText("A0266", { v: s.error || i18nText("U0573") });
    if (s.status === "offline") {
      const again = s.retryInMs ? i18nText("A0267", { v: Math.max(1, Math.round(s.retryInMs / 1000)) }) : "";
      return i18nText("U0574", { v: s.error || i18nText("A0020"), again: again });
    }
    return i18nText("U0045");
  }

  function hermesConn() {
    if (!bridgeOn() || !chatModes().some((v) => v !== "telegram")) return fragment();
    const s = H.status.status;
    const cls = s === "open" ? "ok" : s === "connecting" || s === "starting" ? "warn" : "bad";
    const txt = s === "open" ? i18nText("U0575") : s === "connecting" || s === "starting" ? i18nText("U0576") : s === "setup" ? i18nText("U0577") : i18nText("A0268");
    return h("span", { class: cls, title: hermesStatusText() }, h("span", { class: "dot" }), txt);
  }

  /** Called from renderRail: notices when the chat column switches between Telegram and Hermes. */
  function hermesModeCheck() {
    const m = hermesMode();
    if (m === H.lastMode) return m;
    H.lastMode = m;
    if (m) hermesAutoSelect();
    els.input.placeholder = m ? i18nText("U0578") : i18nText("U0579");
    mark("head", "msgs", "strip", "panel", true);
    renderNote();
    hermesPoll();
    return m;
  }

  // ------------------------------------------------------------ rail
  function hermesRank(list) {
    const fresh = list.filter((n) => !H.rank.has(n.sid)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!H.rank.size) fresh.forEach((n, i) => H.rank.set(n.sid, i)); // first snapshot: most recent on top
    else for (const n of fresh.reverse()) H.rank.set(n.sid, -++H.rankSeq); // later arrivals go on top
  }

  /** A delegated child: it names its parent, or the host marked its source as "subagent". */
  const isSubagent = (n) => !!n && (!!n.parent || n.source === "subagent");
  /** Finished sub-agents idle for this long fold into one collapsed row under their parent. */
  const SUB_FOLD_AFTER_S = 600;

  /**
   * Profiles (default first), each with its sessions; sub-agents under their parent. A sub-agent is NEVER a
   * top-level row: when its parent is not in the list (outside the recent window, another profile name, not
   * reported yet) it is shown indented right after the roots as an orphan (depth >= 1, "Sub-agent" label).
   * Finished sub-agents idle for SUB_FOLD_AFTER_S fold into one {fold} row under their parent; the selected
   * one and any running one stay visible. Rows are {node, depth} or {fold: {sid, count, open}, depth}.
   */
  function hermesGroups(now = Date.now() / 1000, keep = null) {
    const byProfile = new Map();
    // Keep an empty profile selectable for New session, even when its sessions are filtered out.
    for (const p of H.profiles) if (rail.agent ? rail.agent === p.name : rail.view === "all" && rail.source === "all") byProfile.set(p.name, []);
    for (const n of H.nodes.values()) {
      if (keep && !keep(n)) continue;
      if (!byProfile.has(n.profile)) byProfile.set(n.profile, []);
      byProfile.get(n.profile).push(n);
    }
    const names = [...byProfile.keys()].sort((a, b) => (a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b, "tr")));
    // running sessions (and those waiting for an answer) on top in a stable order, so they never jump while agents
    // work; everything else by its real last activity, newest first
    const busy = (n) => nodeLive(n) || H.requests.some((r) => r.sid === n.sid);
    const rank = (n) => (H.rank.has(n.sid) ? H.rank.get(n.sid) : 0);
    const order = (a, b) => (busy(a) !== busy(b) ? (busy(a) ? -1 : 1) : busy(a) ? rank(a) - rank(b) : (b.updatedAt || 0) - (a.updatedAt || 0) || rank(a) - rank(b));
    const stale = (n) => !nodeLive(n) && n.state !== "approval" && n.state !== "question" && n.sid !== H.sel && !H.requests.some((r) => r.sid === n.sid) && now - (n.updatedAt || n.terminalAt || 0) > SUB_FOLD_AFTER_S;
    return names.map((profile) => {
      const list = byProfile.get(profile).sort(order);
      const ids = new Set(list.map((n) => n.sid));
      const rows = [];
      const seen = new Set();
      const add = (n, depth) => {
        if (seen.has(n.sid)) return;
        seen.add(n.sid);
        rows.push({ node: n, depth });
        const kids = list.filter((x) => x.parent === n.sid && !seen.has(x.sid));
        const old = kids.filter(stale);
        const show = old.length > 1 && !H.subOpen.has(n.sid) ? kids.filter((x) => !stale(x)) : kids;
        for (const c of show) add(c, Math.min(depth + 1, 3));
        if (old.length > 1) {
          rows.push({ fold: { sid: n.sid, count: old.length, open: H.subOpen.has(n.sid) }, depth: Math.min(depth + 1, 3) });
          if (!H.subOpen.has(n.sid)) for (const c of old) seen.add(c.sid);
        }
      };
      // real roots first; a sub-agent never counts as one
      for (const n of list) if (!isSubagent(n)) add(n, 0);
      // children whose parent is present were placed above; the rest are orphans, shown as sub-agents
      for (const n of list) if (isSubagent(n) && !seen.has(n.sid) && (!n.parent || !ids.has(n.parent))) add(n, 1);
      for (const n of list) add(n, isSubagent(n) ? 1 : 0); // cycles and anything else left
      return { profile, rows };
    });
  }

  function hermesFoldRow(f, depth) {
    return h("button", { class: "row agent hrow child fold", type: "button",       "aria-expanded": f.open ? "true" : "false", dataset: { fk: `hfold:${f.sid}` }, style: { "--depth": String(depth) },
      onclick: () => {
        if (H.subOpen.has(f.sid)) H.subOpen.delete(f.sid);
        else H.subOpen.add(f.sid);
        mark("rail", true);
      } },
      h("span", { class: "who" }, h("span", { class: "name" }, `${f.open ? "▾" : "▸"} `, i18nNode(f.open ? "deck.subsHide" : "deck.subsFinished", { n: f.count }))));
  }

  // ------------------------------------------------------------ sidebar (Sessions mode): smart filters, agents, sources
  // View state of the Sessions list; filters only narrow what the rail shows, they never touch a session.
  const rail = {
    // "needs" opens the inbox: a restart comes back to the list ("all") rather than to an inbox stub
    view: SH.FILTERS.includes(store.get("deck.view")) && store.get("deck.view") !== "needs" ? store.get("deck.view") : "all",
    source: store.get("deck.source") || "all",
    agent: null, // a profile picked in the Agents list
    pins: new Set((store.get("deck.pins") || "").split(",").filter(Boolean)),
  };
  const SOURCE_NAMES = { tui: "TUI", cli: "CLI", api: "API", deck: "Deck", telegram: "Telegram", cron: "Cron", discord: "Discord", slack: "Slack", webui: "WebUI", ios: "iOS" };
  const sourceLabel = (v) => SOURCE_NAMES[v] || (["desktop", "other"].includes(v) ? i18nText(`sessions.src.${v}`) : v ? v.charAt(0).toUpperCase() + v.slice(1) : "");
  /** Per session: the plain facts the smart filters and the agents list read (shell.js matchFilter). */
  function sessionFacts() {
    const asks = new Map();
    for (const r of H.requests) asks.set(r.sid, (asks.get(r.sid) || 0) + 1);
    const facts = new Map();
    for (const n of H.nodes.values()) {
      facts.set(n.sid, {
        needs: asks.get(n.sid) || 0,
        live: nodeLive(n),
        waiting: n.state === "ratelimit" || OB.pending(n.sid) > 0,
        pinned: rail.pins.has(n.sid),
        updatedAt: n.updatedAt || n.terminalAt || 0,
        source: String(n.source || "").toLowerCase(),
        profile: n.profile || "default",
      });
    }
    return facts;
  }
  /**
   * The rail's keep(n) for the current filters, or null when nothing is filtered. A session stays when it passes, or
   * when one of its descendants does (tree context). Parent links can form a cycle: each sid is decided once.
   */
  function railScope(facts) {
    const visible = sidebarSources ? window.DeckSessions.sidebarVisibility([...H.nodes.values()], sidebarSources, (n) => !!facts.get(n.sid)?.needs) : () => true;
    return (x) => {
      const f = facts.get(x.sid);
      if (!f || !visible(x)) return false;
      // Source and smart filters never suppress a session waiting for an answer.
      if (f.needs || x.state === "approval" || x.state === "question") return true;
      if (rail.agent && f.profile !== rail.agent) return false;
      const source = window.DeckSessions ? window.DeckSessions.sidebarSourceKey(f.source) : f.source;
      if (rail.source !== "all" && !isSubagent(x) && source !== rail.source) return false;
      return true;
    };
  }
  function railFilter(facts) {
    if (rail.view === "all" && rail.source === "all" && !rail.agent && (!sidebarSources || !sidebarSources.chosen())) return null;
    const scope = railScope(facts);
    const pass = (x) => scope(x) && (facts.get(x.sid).needs || x.state === "approval" || x.state === "question" || SH.matchFilter(rail.view, facts.get(x.sid)));
    const kids = new Map();
    for (const c of H.nodes.values()) if (c.parent) (kids.get(c.parent) || kids.set(c.parent, []).get(c.parent)).push(c);
    const memo = new Map();
    const keep = (n) => {
      if (memo.has(n.sid)) return memo.get(n.sid);
      memo.set(n.sid, false); // a cycle back to this sid counts as "no"
      const v = pass(n) || (kids.get(n.sid) || []).some(keep);
      memo.set(n.sid, v);
      return v;
    };
    return keep;
  }
  function setRailView(view) {
    rail.view = view;
    store.set("deck.view", view);
    SH.setMain(view === "needs" ? "inbox" : "chat");
    mark("rail", true);
  }
  function smartFilters(facts) {
    // Count the same source/profile scope as the list, not sessions hidden by saved source choices.
    const all = [...H.nodes.values()].filter(railScope(facts)).map((n) => facts.get(n.sid));
    const count = { needs: pendingCount(), all: all.length };
    for (const v of ["running", "waiting", "today", "pinned"]) count[v] = all.filter((f) => SH.matchFilter(v, f)).length;
    const ICON = { needs: "inbox", all: "all", running: "running", waiting: "waiting", today: "today", pinned: "pin" };
    return h("div", { class: "sh-nav", role: "group", "aria-label": i18nText("shell.filters") },
      ...SH.FILTERS.map((v) => {
        const n = count[v] || 0;
        const cls = v === "needs" && n ? "sh-count brass" : v === "running" && n ? "sh-count lv" : "sh-count";
        return h("button", { type: "button", class: `sh-nrow${rail.view === v ? " on" : ""}`, "aria-pressed": rail.view === v ? "true" : "false", dataset: { fk: `view:${v}` }, onclick: () => setRailView(v) },
          SH.icon(ICON[v], 15), h("span", { class: "sh-nlabel" }, i18nNode(`shell.view.${v}`)), n || v === "all" ? h("span", { class: cls }, String(n)) : null);
      }));
  }
  /** Agents: one row per Hermes profile with its live state; a click narrows the list to that profile. */
  function agentsBlock() {
    const by = new Map(H.profiles.map((p) => [p.name, { profile: p.name, live: 0, needs: 0 }]));
    for (const n of H.nodes.values()) {
      const p = n.profile || "default";
      if (!by.has(p)) by.set(p, { profile: p, live: 0, needs: 0 });
      const a = by.get(p);
      if (bridgeOpen() && nodeLive(n)) a.live++;
    }
    for (const r of H.requests) {
      const n = H.nodes.get(r.sid);
      if (bridgeOpen() && n && by.has(n.profile || "default")) by.get(n.profile || "default").needs++;
    }
    if (!by.size) return [];
    const list = [...by.values()].sort((a, b) => (a.profile === "default" ? -1 : b.profile === "default" ? 1 : a.profile.localeCompare(b.profile)));
    const nameOf = (p) => (agentList().find((a) => a.profile === p) || {}).name || (p === "default" ? i18nText("shell.defaultAgent") : p);
    const closed = layout.closed.has("h:agents");
    const live = list.reduce((n, a) => n + a.live, 0);
    return [
      sectionHead("h:agents", i18nText("A0217"), live ? i18nText("shell.agentsLive", { n: live }) : list.length),
      closed ? null : h("div", { class: "sh-agents" }, ...list.map((a) => {
        const st = a.needs ? "waiting" : a.live ? "running" : "idle";
        const label = !bridgeOpen() ? i18nText("shell.state.offline") : a.needs ? i18nText("shell.state.needs") : a.live ? (a.live > 1 ? i18nText("shell.state.runningN", { n: a.live }) : i18nText("shell.state.running")) : i18nText("shell.state.inactive");
        return h("button", { type: "button", class: `sh-arow${rail.agent === a.profile ? " on" : ""}`, "aria-pressed": rail.agent === a.profile ? "true" : "false", dataset: { fk: `agent:${a.profile}` },
          onclick: () => { rail.agent = rail.agent === a.profile ? null : a.profile; mark("rail", true); } },
          h("span", { class: `sh-av st-${st}`, "aria-hidden": "true" }, nameOf(a.profile).slice(0, 1).toUpperCase(), h("span", { class: `dot ${st}` })),
          h("span", { class: "sh-nm" }, nameOf(a.profile)),
          h("span", { class: `sh-ast ${st}` }, label));
      })),
    ];
  }
  /** Source chips follow local choices; untouched viewers retain the top-five behavior. */
  function sourceChips() {
    const list = sidebarSources ? sidebarSources.chips() : [];
    if (rail.source !== "all" && !list.includes(rail.source)) {
      rail.source = "all";
      store.set("deck.source", "all");
    }
    if ((!sidebarSources || !sidebarSources.chosen()) && list.length < 2 && rail.source === "all") return null;
    const pick = (v) => { rail.source = v; store.set("deck.source", v); mark("rail", true); };
    return h("div", { class: "sh-chips", role: "group", "aria-label": i18nText("shell.sourcesLabel") },
      h("button", { type: "button", class: `sh-srcchip${rail.source === "all" ? " on" : ""}`, "aria-pressed": rail.source === "all" ? "true" : "false", dataset: { fk: "src:all" }, onclick: () => pick("all") }, i18nNode("shell.source.all")),
      ...list.map((v) => h("button", { type: "button", class: `sh-srcchip${rail.source === v ? " on" : ""}`, "aria-pressed": rail.source === v ? "true" : "false", dataset: { fk: `src:${v}` }, onclick: () => pick(v) }, sourceLabel(v))));
  }
  function togglePin(sid) {
    if (rail.pins.has(sid)) rail.pins.delete(sid);
    else rail.pins.add(sid);
    store.set("deck.pins", [...rail.pins].join(","));
    mark("rail", true);
  }

  function renderHermesRail() {
    // The sidebar's mode switch (#modes) owns Sessions/Bots; no second switch can reveal a disabled mode.
    const kids = [];
    const allSessions = SB ? SB.entry() : null; // All sessions: opens the browser over the chat column
    if (BT && BT.view() === "bots") {
      if (allSessions) kids.push(allSessions);
      BT.renderRail(kids); // Botlar: one row per bot instead of the sessions grouped by profile
      els.rail.replaceChildren(...kids);
      return;
    }
    // Sessions: smart filters, the agents (profiles) with their live state, source chips, then the session list
    const facts = sessionFacts();
    const sources = sourceChips(); // normalise an unavailable source before counting or filtering
    kids.push(smartFilters(facts));
    kids.push(...agentsBlock());
    kids.push(sources);
    if (allSessions) kids.push(allSessions);
    const groups = hermesGroups(undefined, railFilter(facts));
    if (!groups.length) {
      kids.push(sectionHead("h:none", i18nText("U0580"), 0));
      const filtered = rail.view !== "all" || rail.source !== "all" || rail.agent || (sidebarSources && sidebarSources.chosen());
      kids.push(h("p", { class: "rail-note" }, filtered && H.nodes.size ? i18nNode("shell.filterEmpty") : bridgeOpen() ? i18nNode("U0581") : hermesStatusText()));
    }
    if (!groups.length && bridgeOpen() && !layout.compact) kids.push(newSessionRow("default"));
    for (const g of groups) {
      const id = `h:${g.profile}`;
      kids.push(sectionHead(id, g.profile === "default" ? i18nText("U0582") : `Hermes · ${g.profile}`, g.rows.filter((r) => r.node).length));
      if (!layout.closed.has(id) && !layout.compact && bridgeOpen()) kids.push(newSessionRow(g.profile));
      if (!layout.closed.has(id) || layout.compact) for (const r of g.rows) kids.push(r.fold ? hermesFoldRow(r.fold, r.depth) : hermesRow(r.node, r.depth));
    }
    els.rail.replaceChildren(...kids.filter(Boolean));
  }

  function hermesRow(n, depth) {
    const title = hermesTitle(n);
    const live = nodeLive(n);
    const asks = H.requests.filter((r) => r.sid === n.sid).length;
    const fill = n.ctxMax && n.ctxUsed ? n.ctxUsed / n.ctxMax : null;
    let sub;
    if (asks) sub = h("span", { class: "sub warn" }, i18nNode("U0583"));
    else if (live) sub = h("span", { class: "sub live" }, n.steps.length ? n.steps[n.steps.length - 1] : H_STATE_TR[n.state] || i18nNode("U0410"));
    else sub = h("span", { class: "sub" }, [n.updatedAt ? ago(n.updatedAt) : null, isSubagent(n) ? i18nText("common.subagentTitle") : n.source || null].filter(Boolean).join(" · "));
    const percent = fill !== null && fill >= 0.7 ? Math.round(fill * 100) : null;
    const dot = () => live ? h("span", { class: "rail-live-dot", "aria-hidden": "true" }) : null;
    return h(
      "button",
      { class: `row agent hrow rail-session${depth ? " child" : ""}${isSubagent(n) ? " sub" : ""}`, type: "button", title: `${title}\n${n.sid}`, "aria-label": [title, live ? i18nText("rail.live") : null, percent !== null ? i18nText("rail.context", { percent }) : null, asks ? i18nText("U0584", { asks }) : null].filter(Boolean).join(" · "), "aria-current": H.sel === n.sid ? "true" : null, dataset: { fk: `hrow:${n.sid}` }, style: depth ? { "--depth": String(depth) } : null, onclick: () => hermesSelect(n.sid) },
      h("span", { class: "rail-monogram", "aria-hidden": "true" }, Array.from(title).slice(0, 2).join("").toUpperCase(), dot()),
      h("span", { class: "who" }, h("span", { class: "name" }, dot(), h("span", { class: "rail-title" }, title)), sub),
      percent !== null || asks ? h("span", { class: "meta" },
        percent !== null ? h("span", { class: `rail-context ${fill >= 0.9 ? "bad" : "warn"}`, title: i18nText("rail.context", { percent }), "aria-label": i18nText("rail.context", { percent }), "data-i18n-title": "rail.context", "data-i18n-title-vars": JSON.stringify({ percent }), "data-i18n-aria-label": "rail.context", "data-i18n-aria-label-vars": JSON.stringify({ percent }) }, `${n.ctxEstimated ? "~" : ""}${percent}%`) : null,
        asks ? h("span", { class: "badge ask", "aria-label": i18nText("U0584", { asks: asks }), "data-i18n-aria-label": "U0584", "data-i18n-aria-label-vars": JSON.stringify({ asks: asks }) }, String(asks)) : null) : null
    );
  }

  // ------------------------------------------------------------ session menu (right-click > Delete)
  const sessionRowOf = (e) => (e.target && e.target.closest ? e.target.closest(".row.hrow") : null);
  const sessionSidOf = (row) => (row && row.dataset.fk ? row.dataset.fk.slice("hrow:".length) : "");
  let sessionMenuKeyAt = 0; // a keyboard-opened menu swallows the contextmenu event that may follow

  function openSessionMenu(row, pos) {
    const sid = sessionSidOf(row);
    const n = H.nodes.get(sid);
    if (!sid || !n || !hermesMode() || !bridgeOpen() || (BT && BT.owns(sid))) return; // a Bot Chat belongs to its bot
    MV.openMenu(
      [{ label: i18nText(rail.pins.has(sid) ? "shell.unpin" : "shell.pin"), run: () => togglePin(sid) },
        { label: i18nText("session.delete"), danger: true, noReturn: true, run: () => confirmDeleteSession(n) }],
      row, pos, i18nText("session.menuLabel", { title: hermesTitle(n) })
    );
  }

  els.rail.addEventListener("contextmenu", (e) => {
    const row = hermesMode() ? sessionRowOf(e) : null;
    if (!row) return;
    e.preventDefault();
    if (Date.now() - sessionMenuKeyAt < 500) return;
    openSessionMenu(row, e.clientX === 0 && e.clientY === 0 ? null : { x: e.clientX, y: e.clientY });
  });
  els.rail.addEventListener("keydown", (e) => {
    const row = hermesMode() ? sessionRowOf(e) : null;
    if (!row || !(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) return;
    e.preventDefault();
    sessionMenuKeyAt = Date.now();
    openSessionMenu(row, null);
  });

  /** Hermes refuses a running session ("cannot delete an active session", code 4023): say what to do. */
  const deleteErr = (e) => (/active session/i.test(String((e && e.message) || e)) ? i18nText("session.deleteActive") : cleanErr(e));

  function confirmDeleteSession(n) {
    const back = document.activeElement;
    const title = hermesTitle(n);
    const err = h("p", { class: "form-error", role: "alert" });
    const ok = h("button", { class: "btn danger", type: "button", dataset: { fk: "hsession-delete-ok" } }, i18nNode("session.delete"));
    const cancel = h("button", { class: "btn", type: "button" }, i18nNode("U0451"));
    const box = h(
      "div",
      { class: "cd", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "hsd-title", "aria-describedby": "hsd-body" },
      h("h2", { id: "hsd-title" }, i18nNode("session.deleteTitle")),
      h("p", { id: "hsd-body" }, h("strong", null, title), i18nNode("session.deleteBody")),
      err,
      h("div", { class: "form-actions" }, cancel, ok)
    );
    const root = h("div", { class: "cd-back" }, box);
    const close = () => {
      root.remove();
      if (back && back.isConnected) back.focus();
    };
    cancel.addEventListener("click", close);
    root.addEventListener("click", (e) => {
      if (e.target === root && !ok.disabled) close();
    });
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !ok.disabled) {
        e.preventDefault();
        close();
      } else if (e.key === "Tab") {
        e.preventDefault();
        (document.activeElement === ok ? cancel : ok).focus();
      }
    });
    ok.addEventListener("click", async () => {
      ok.disabled = cancel.disabled = true;
      i18nBind(ok, "textContent", "session.deleteBusy");
      err.textContent = "";
      try {
        await deck.bridge.deleteSession(n.sid, { profile: n.profile });
        root.remove();
        hermesForget(n.sid);
        MV.toast(i18nText("session.deleted"));
      } catch (e) {
        err.textContent = deleteErr(e);
        ok.disabled = cancel.disabled = false;
        i18nBind(ok, "textContent", "session.delete");
      }
    });
    document.body.appendChild(root);
    cancel.focus(); // the safe answer holds the focus
  }

  /** A deleted session leaves every local map; if it was open, the next session (or the empty view) takes its place. */
  function hermesForget(sid) {
    const was = H.sel === sid;
    DR.forget(`hermes:${sid}`);
    H.nodes.delete(sid);
    H.stored.delete(sid);
    H.snap = H.snap.filter((n) => n.sid !== sid);
    H.hist.delete(sid);
    H.live.delete(sid);
    H.echo.delete(sid);
    H.deleted.add(sid);
    OB.drop(sid);
    H.ctl.delete(sid);
    H.titles.delete(sid);
    H.rank.delete(sid);
    H.requests = H.requests.filter((r) => r.sid !== sid);
    if (was) {
      H.sel = null;
      store.set("deck.hsel", "");
      const next = hermesGroups().flatMap((g) => g.rows).find((r) => r.node); // fold rows are not sessions
      if (next) hermesSelect(next.node.sid);
    }
    mark("rail", "head", "msgs", "strip", "panel", true);
  }

  /** "+ New session" under a profile heading: an empty session in that profile, opened and focused. */
  function newSessionRow(profile) {
    return h("button", { class: "row new-session", type: "button", title: i18nText("U0585"), dataset: { fk: `hnew:${profile}` }, onclick: () => newHermesSession(profile) , "data-i18n-title": "U0585"}, h("span", { class: "plus", "aria-hidden": "true" }, "+"), h("span", null, i18nNode("A0272")));
  }

  let creating = false;
  async function newHermesSession(profile) {
    if (creating || !bridgeOpen()) return;
    if (RG.reusable(H.sel, profile || "default")) {
      els.input.focus();
      return;
    }
    creating = true;
    RG.leave(H.sel);
    const origin = H.sel;
    const mode = chatMode();
    try {
      const r = await RG.mint(profile || "default");
      // Do not steal selection if the user navigated away while the create RPC was in flight.
      if ((H.sel !== origin && H.sel !== r.sid) || chatMode() !== mode || SB?.isOpen()) {
        RG.leave(r.sid);
        return;
      }
      hermesSelect(r.sid);
      els.input.focus();
    } catch (e) {
      setFormMsg({ ok: false, text: i18nText("U0586", { e: cleanErr(e) }) });
      console.warn(`new session failed: ${e.message}`);
    } finally {
      creating = false;
    }
  }

  function hermesSelect(sid) {
    if (!sid) return;
    if (sid !== H.sel) RG.leave(H.sel);
    if (SB && SB.isOpen()) SB.close(); // a rail click while the browser is open shows that chat
    const sn = H.nodes.get(sid);
    if (SB && sn && sn.stored && SB.adopt) SB.adopt(sid, sn.source); // a stored messaging-platform chat: the first send continues in a copy
    H.sel = sid;
    store.set("deck.hsel", sid);
    DR.sync();
    scrollToEnd = true;
    mark("rail", "head", "msgs", "strip", "panel", true);
    renderNote();
    hermesLoadHistory(sid);
    hermesPoll();
  }

  /** Open a session the snapshot may not list (a bot's Bot Chat): its history is read from `profile`. */
  function hermesOpen(sid, profile, { fresh = false } = {}) {
    const st = hHist(sid);
    if (!H.nodes.has(sid)) st.profile = profile;
    if (fresh) {
      st.fresh = true; // just created: nothing stored until its first turn
      st.loaded = true;
    }
    hermesSelect(sid);
  }

  function hermesAutoSelect() {
    if (creating) return; // the new row's snapshot can arrive before its create reply
    if (H.sel && (H.nodes.has(H.sel) || H.hist.has(H.sel) || (BT && BT.owns(H.sel)))) return; // keep a session that just left the snapshot
    if (BT && BT.autoSelect()) return; // Botlar: the remembered bot (or the first) opens instead
    const want = store.get("deck.hsel");
    if (want && H.nodes.has(want)) return hermesSelect(want);
    const first = hermesGroups().flatMap((g) => g.rows).find((r) => r.node);
    if (first) hermesSelect(first.node.sid);
  }

  // ------------------------------------------------------------ history (read-only)
  function hHist(sid) {
    let st = H.hist.get(sid);
    if (!st) {
      const n = H.nodes.get(sid);
      st = { msgs: [], loaded: false, loading: false, error: null, hasMore: false, offset: 40, older: false, sig: "", profile: n ? n.profile : "default" };
      H.hist.set(sid, st);
    }
    return st;
  }
  const histSig = (msgs) => msgs.map((m) => `${m.id || ""}:${m.role}:${m.text.length}:${m.think ? m.think.length : 0}:${m.calls ? m.calls.length : 0}`).join("|");

  // history window (history-window.js): a session opens on its latest ~200 rows, older pages load by themselves
  // while the reader scrolls toward the top, and the poll merges the newest page under what is loaded
  const HW = window.DeckHistory;

  async function hermesLoadHistory(sid, { older = false } = {}) {
    if (!hermesMode()) return; // background bridge events must not read disabled chat history
    if (BT && BT.isDraft(sid)) return; // Botlar: a bot without its Bot Chat yet has nothing stored
    const st = hHist(sid);
    if (!bridgeOpen()) return;
    if (st.loading) {
      // a read is already on its way and may predate what changed (a step stored just now): read once more after it
      if (!older) st.again = true;
      return;
    }
    const n = H.nodes.get(sid);
    if ((n && n.fresh) || (!n && st.fresh)) {
      // just created: Hermes has no stored history for it yet
      st.loaded = true;
      return;
    }
    if (n) st.profile = n.profile;
    st.loading = true;
    if (older) {
      st.olderFailed = false;
      mark("msgs", true);
    }
    let changed = older;
    try {
      const page = (offset, limit) => deck.bridge.history(sid, { profile: st.profile, limit, offset });
      if (older) {
        const r = await page(st.offset, HW.PAGE);
        st.msgs = HW.prependOlder(st.msgs, r.messages);
        st.offset = r.offset;
        st.hasMore = r.hasMore;
        st.older = true;
      } else if (!st.loaded) {
        const w = await HW.openingWindow(page); // the latest ~200 rows, not just one small page
        st.msgs = w.messages;
        st.offset = w.offset;
        st.hasMore = w.hasMore;
        st.older = w.offset > HW.PAGE;
      } else {
        // poll: only the newest rows; older pages already loaded stay (a small page once more than one is open)
        const r = await page(0, st.older ? 40 : HW.PAGE);
        const merged = st.older ? HW.mergeLatest(st.msgs, r.messages) : null;
        if (merged) st.msgs = merged;
        else {
          st.msgs = r.messages;
          st.older = false;
          st.offset = r.offset;
          st.hasMore = r.hasMore;
        }
      }
      const sig = histSig(st.msgs);
      changed = changed || sig !== st.sig || !st.loaded || !!st.error;
      st.sig = sig;
      st.loaded = true;
      st.error = null;
      if (settleEcho(sid, st.msgs)) changed = true;
    } catch (e) {
      const msg = cleanErr(e);
      changed = changed || st.error !== msg || !st.loaded;
      st.error = msg;
      if (older) st.olderFailed = true; // no automatic retry loop; the button tries again
    } finally {
      st.loading = false;
    }
    if (changed && H.sel === sid) mark("msgs", true);
    if (st.again) {
      st.again = false;
      if (!st.error) hermesLoadHistory(sid);
    }
  }

  // Infinite scroll up: near the top of the list the next older page loads by itself. The scroller is a
  // column-reverse box, so rows added above keep the view where it is; `autoChain` bounds the pages fetched
  // one after another without the reader scrolling (a short page does not push the top out of range).
  let autoChain = 0;
  function maybeLoadOlder() {
    if (!hermesMode() || !H.sel || autoChain >= 3) return;
    if (!HW.wantsOlder(H.hist.get(H.sel), HW.distanceFromTop(els.msgs))) return;
    autoChain++;
    hermesLoadHistory(H.sel, { older: true });
  }
  els.msgs.addEventListener("scroll", () => {
    autoChain = 0;
    maybeLoadOlder();
  }, { passive: true });

  /** Drop local echoes and streamed text once the persisted history shows them. */
  function settleEcho(sid, msgs) {
    let changed = false;
    const list = H.echo.get(sid);
    if (list) {
      const keep = EM.settle(list, msgs, Date.now());
      if (keep.length !== list.length) {
        changed = true;
        if (keep.length) H.echo.set(sid, keep);
        else H.echo.delete(sid);
      }
    }
    const live = H.live.get(sid);
    if (live && live.done) {
      const seg = hermesLiveSegments(live, msgs);
      if ((!seg.text.trim() && !seg.sealed.length) || Date.now() - live.doneAt > 20000) {
        H.live.delete(sid);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * What the in-flight turn still shows beside the stored history: finished segments the history does not
   * have yet (`sealed`) and the text of the segment still streaming. Anything the history already holds
   * is dropped, so a segment is never shown both as its own message and again in the live bubble.
   */
  function hermesLiveSegments(live, msgs) {
    const stored = new Set(msgs.filter((m) => m.role === "assistant").slice(-60).map((m) => m.text.trim()));
    const sealed = live.sealed.filter((s) => !stored.has(s.text.trim()));
    const text = stored.has(live.text.trim()) ? "" : live.text;
    return { sealed, text };
  }

  /** Poll the visible session: fast while it works, slow when idle or the window is hidden. */
  function hermesPoll() {
    clearTimeout(H.pollTimer);
    H.pollTimer = 0;
    if (!hermesMode() || !H.sel || !bridgeOpen()) return;
    const n = H.nodes.get(H.sel);
    const hot = nodeLive(n) || H.echo.has(H.sel) || H.live.has(H.sel) || OB.size(H.sel) > 0 || !!(n && n.updatedAt && nowS() - n.updatedAt < 120);
    const wait = document.hidden ? 10000 : hot ? 1500 : 6000;
    H.pollTimer = setTimeout(async () => {
      H.pollTimer = 0;
      if (hermesMode() && H.sel && bridgeOpen()) await hermesLoadHistory(H.sel);
      outboxDrain();
      hermesPoll();
    }, wait);
  }

  // ------------------------------------------------------------ chat column
  function renderHermesHead() {
    const n = H.nodes.get(H.sel);
    if (!H.sel) {
      els.head.replaceChildren(h("span", { class: "subline" }, H.nodes.size ? i18nNode("U0587") : hermesStatusText()));
      return;
    }
    const bot = BT && BT.headFor(H.sel); // Botlar: a bot's Bot Chat (or its draft) shows the bot, not the session
    if (bot) {
      els.head.replaceChildren(
        bot.face,
        h("div", { class: "head-main" }, h("div", { class: "title" }, bot.title), h("div", { class: "subline" }, bot.bits.join(" · ")))
      );
      return;
    }
    const st = H.hist.get(H.sel);
    const title = n ? hermesTitle(n) : H.titles.get(H.sel) || `Hermes · ${H.sel.slice(-8)}`; // a session opened from All sessions has no node
    // one quiet status line: where it runs and on what; what it is doing shows in the live row and the strip
    const bits = [profileLabel(n ? n.profile : st ? st.profile : "default"), n && n.source, n && n.model].filter(Boolean);
    els.head.replaceChildren(
      h("div", { class: "head-main" }, h("div", { class: "title" }, title), h("div", { class: "subline" }, bits.join(" · ")))
    );
  }

  /** Hermes replies are markdown (tables, lists, code): render them like the Telegram view does. */
  function hermesTextEl(m, u) {
    const text = u && u.text ? u.text : m.text;
    const md = window.DeckMarkdown;
    if (m.role !== "user" && md && typeof text === "string" && text.trim()) {
      const d = h("div", { class: "text md" });
      d.appendChild(md.render(text));
      return d;
    }
    return h("div", { class: "text" }, text);
  }

  /**
   * Notices Hermes injects as user-role messages. The model already answers them, so the chat shows each as
   * one collapsed chip. Conservative on purpose: the bracket header must open the message (or, for the OMH
   * line, close it), and the owner's own words are never part of a notice: "[OUT-OF-BAND USER MESSAGE …]"
   * is theirs and stays visible. Returns [{text}] / [{notice: {kind, key, vars, body}}] segments in order.
   */
  function splitSystemNotices(text) {
    const src = String(text || "");
    const head = /^\s*\[(ASYNC DELEGATION (BATCH COMPLETE|TASK FAILED|COMPLETE)|IMPORTANT: (Background process\b|\d+ background (processes|subagent delegations))|Context from the interrupted assistant response\]|OMH Degraded\])/.exec(src);
    const omh = /(?:^|\n)[ \t]*(\[OMH Degraded\][^\n]*(?:\n[ \t]*\[OMH Degraded\][^\n]*)*)\s*$/;
    const out = [];
    let rest = src;
    let tail = null;
    if (!head || head[1] !== "OMH Degraded]") {
      const m = omh.exec(rest);
      if (m && m.index > 0) {
        tail = m[1].trim();
        rest = rest.slice(0, m.index);
      }
    }
    if (head) {
      const tag = head[1];
      const id = (/\bdeleg_[A-Za-z0-9]+/.exec(src.slice(0, 200)) || [""])[0];
      const n = (/^\[IMPORTANT: (\d+) /.exec(src.trim()) || [])[1] || "";
      let kind = "bg";
      let key = "deck.notice.bg";
      if (tag.startsWith("ASYNC DELEGATION")) [kind, key] = tag.endsWith("BATCH COMPLETE") ? ["deleg", "deck.notice.delegBatch"] : tag.endsWith("TASK FAILED") ? ["deleg", "deck.notice.delegFailed"] : ["deleg", "deck.notice.delegDone"];
      else if (tag.startsWith("Context")) [kind, key] = ["interrupt", "deck.notice.interrupt"];
      else if (tag === "OMH Degraded]") [kind, key] = ["omh", "deck.notice.omh"];
      else if (n) key = /subagent/.test(src.slice(0, 80)) ? "deck.notice.bgDelegs" : "deck.notice.bgBatch";
      else if (/matched watch pattern/.test(src.slice(0, 200))) key = "deck.notice.bgMatch";
      let body = rest.trim();
      let after = "";
      if (kind === "interrupt") {
        // the correction is followed by the owner's own text (its last paragraph): that stays visible
        const cut = body.lastIndexOf("\n\n");
        if (cut > 0 && /interrupted by a user correction|Visible response before the interruption/.test(body.slice(0, cut))) {
          after = body.slice(cut + 2).trim();
          body = body.slice(0, cut).trim();
        } else if (cut > 0) {
          return [{ text: src }];
        }
      }
      out.push({ notice: { kind, key, vars: { id: id || "", n }, body } });
      if (after) out.push({ text: after });
    } else if (rest.trim()) out.push({ text: rest.trim() });
    if (tail) out.push({ notice: { kind: "omh", key: "deck.notice.omh", vars: { id: "", n: "" }, body: tail } });
    return out.length && out.some((x) => x.notice) ? out : [{ text: src }];
  }

  /** The label of a notice chip: "Delegation batch complete · deleg_ab12" (the id only when there is one). */
  function noticeTitle(nt) {
    const base = i18nText(nt.key, { n: nt.vars.n || "" });
    return nt.vars.id ? `${base} · ${nt.vars.id}` : base;
  }

  /** One collapsed chip: a real button (keyboard and screen reader), the full text on demand. */
  function hermesNoticeEl(nt, key) {
    const open = H.noticeOpen.has(key);
    const title = noticeTitle(nt);
    return h("div", { class: `sysnotice${open ? " open" : ""}`, dataset: { kind: nt.kind } },
      h("button", { class: "sysnotice-head", type: "button", "aria-expanded": open ? "true" : "false", title: open ? i18nText("deck.notice.hide") : i18nText("deck.notice.show"), dataset: { fk: `notice:${key}` },
        onclick: () => {
          if (H.noticeOpen.has(key)) H.noticeOpen.delete(key);
          else H.noticeOpen.add(key);
          mark("msgs", true);
        } },
        h("span", { class: "sysnotice-chev", "aria-hidden": "true" }, open ? "▾" : "▸"),
        h("span", { class: "sysnotice-title" }, title)),
      open ? h("pre", { class: "sysnotice-body" }, nt.body) : null);
  }

  /**
   * A work step of a turn: an assistant message with no words for the reader, only a thought and/or the tool calls it
   * made. Steps in a row read as one stretch of work (Thought, its calls, the next Thought...), stamped once at its end.
   */
  function hermesIsStep(m) {
    return !!m && m.role === "assistant" && !String(m.text || "").trim() && !(Array.isArray(m.media) && m.media.length) &&
      (!!m.think || (Array.isArray(m.calls) && m.calls.length > 0));
  }

  /** The tool calls an assistant step made, in order: the tool's name and the argument it is known by. A call with an
   *  id opens its row in the turn's receipt (receipts.js: output, duration, Inspect). */
  function hermesCallsEl(calls, ts) {
    if (!Array.isArray(calls) || !calls.length) return null;
    const reveal = (c) => () => document.dispatchEvent(new CustomEvent("deck-tool-reveal", { detail: { sid: H.sel, call: c.id, ts: ts || null } }));
    return h("ul", { class: "tool-calls" }, calls.map((c) => h("li", null,
      h(c.id ? "button" : "span", { class: "tc", ...(c.id ? { type: "button", title: c.arg || c.name, onclick: reveal(c) } : {}) },
        h("span", { class: "tc-name" }, c.name),
        c.arg ? h("code", { class: "tc-arg" }, c.arg) : null))));
  }

  function hermesMsgEl(m, { stamp = true } = {}) {
    const parts = m.role === "user" ? splitSystemNotices(m.text) : null;
    if (parts && parts.some((x) => x.notice)) {
      const key = String(m.id || m.ts || m.text.length);
      const kids = [];
      parts.forEach((x, i) => {
        if (x.notice) kids.push(hermesNoticeEl(x.notice, `${key}:${i}`));
        else kids.push(hermesMsgEl({ ...m, text: x.text, ts: 0 }));
      });
      const only = parts.length === 1;
      const stamp = m.ts ? h("time", { class: "t", title: new Date(m.ts * 1000).toLocaleString(i18nLocale()) }, hm(m.ts)) : null;
      if (only) return h("div", { class: "msg sysmsg" }, ...kids, stamp);
      return h("div", { class: "sysgroup" }, ...kids, stamp ? h("div", { class: "msg sysmsg" }, stamp) : null);
    }
    // F2: a prompt from Telegram shows its reply as a quote, drops the "[Name|id]" tag and folds other context
    const u = m.role === "user" && AG ? AG.userMessage(m.text, `h:${m.id || m.ts}`) : null;
    const st = H.hist.get(H.sel);
    const nodeOf = H.nodes.get(H.sel);
    const step = hermesIsStep(m);
    const work = step || (m.role === "assistant" && Array.isArray(m.calls) && m.calls.length > 0); // receipts.js sums a turn's work up after it
    return h(
      "div",
      { class: `msg${m.role === "user" ? " out" : ""}${step ? ` step${stamp ? " step-end" : ""}` : ""}${work ? " work" : ""}`, ...(m.role === "user" && m.ts ? { dataset: { ts: String(m.ts) } } : {}) },
      u ? u.quote : null,
      m.role === "assistant" && m.think ? TB.el(m.think, `${H.sel}:${m.id || m.ts}`) : null, // stored reasoning: collapsed "Thinking"
      u && !u.text && u.chip ? null : Array.isArray(m.media) && m.media.length && !String(m.text || "").trim() ? null : m.role === "user" && window.DeckVoiceBubble && window.DeckVoiceBubble.hidesDefaultText(m.text, m.media) ? null : // the plugin's default text is not shown beside a voice note
         step ? null : hermesTextEl(m, u),
      m.role === "assistant" ? hermesCallsEl(m.calls, m.ts) : null, // the tools this step called, after its words
      HF.chips(m, { sid: H.sel, profile: nodeOf ? nodeOf.profile : st ? st.profile : "default" }), // files the agent offered
      MP.strip(m, { sid: H.sel, profile: nodeOf ? nodeOf.profile : st ? st.profile : "default" }), // images/files the user sent
      u ? u.chip : null,
      m.ts && stamp ? h("time", { class: "t", title: new Date(m.ts * 1000).toLocaleString(i18nLocale()) }, hm(m.ts)) : null
    );
  }

  function renderHermesMsgs() {
    if (holdRegion(els.msgs)) return;
    delete els.msgsInner.dataset.form;
    const kids = [];
    if (!H.sel) {
      kids.push(
        h("div", { class: "empty" },
          bridgeOpen() ? (H.nodes.size ? i18nNode("U0587") : i18nNode("U0589")) : h("span", null, h("strong", null, i18nNode("U0590")), hermesStatusText()),
          bridgeOpen() ? null : h("div", { class: "form-actions" }, h("button", { class: "btn", type: "button", onclick: () => openSettings("hermes") }, i18nNode("A0231"))))
      );
    } else if (BT && BT.isDraft(H.sel)) {
      kids.push(BT.draftView(H.sel)); // Botlar: no Bot Chat yet; the first message opens it
    } else {
      const st = H.hist.get(H.sel);
      if (!st || !st.loaded) {
        kids.push(h("div", { class: "empty" }, st && st.error ? i18nNode("U0591", { error: st.error }) : bridgeOpen() ? i18nNode("U0390") : hermesStatusText()));
      } else {
        if (st.hasMore) {
          // a quiet fallback: older pages load by themselves near the top; this is the keyboard / retry path
          kids.push(h("div", { class: "older" }, h("button", { class: "linkbtn", type: "button", disabled: st.loading, dataset: { fk: "h-older" }, onclick: () => { autoChain = 0; hermesLoadHistory(H.sel, { older: true }); } }, st.loading ? i18nNode("U0389") : i18nNode("composer.loadEarlier"))));
        }
        if (!st.msgs.length && !H.echo.has(H.sel) && !H.live.has(H.sel) && !OB.size(H.sel)) kids.push(h("div", { class: "empty" }, i18nNode("U0393")));
        let lastDay = null;
        st.msgs.forEach((m, i) => {
          if (m.ts) {
            const d = dayKey(m.ts);
            if (d !== lastDay) {
              kids.push(h("div", { class: "day" }, dayLabel(m.ts)));
              lastDay = d;
            }
          }
          // a stretch of work steps is stamped once, at its last step
          kids.push(hermesMsgEl(m, { stamp: !(hermesIsStep(m) && hermesIsStep(st.msgs[i + 1])) }));
        });
        for (const e of H.echo.get(H.sel) || []) {
          kids.push(h("div", { class: "msg out pending", title: i18nText("U0592") , "data-i18n-title": "U0592"}, h("div", { class: "text" }, e.text), MP.echo(e.previews, e.names), h("time", { class: "t" }, i18nNode("U0593"))));
        }
        const live = H.live.get(H.sel);
        if (live) {
          const seg = hermesLiveSegments(live, st.msgs);
          for (const s of seg.sealed) kids.push(h("div", { class: "msg" }, h("div", { class: "text" }, s.text), h("time", { class: "t" }, i18nNode("U0594"))));
          if (seg.text) kids.push(h("div", { class: `msg${live.done ? "" : " live"}` }, live.done ? TB.el(live.think, `${H.sel}:live`) : null, h("div", { class: "text" }, seg.text), h("time", { class: "t" }, live.done ? i18nNode("U0594") : i18nNode("U0434"))));
        }
        const row = LA.row(hermesLiveView()); // what the model is doing now, where its next message will appear
        if (row) kids.push(row);
        const nSel = H.nodes.get(H.sel);
        kids.push(...OB.bubbles(H.sel, { edit: outboxEdit, cancel: outboxCancel, sendNow: outboxSendNow, redirect: nodeControllable(nSel) ? outboxRedirect : null, redraw: () => mark("msgs", true) }));
        if (st.error) kids.push(h("p", { class: "hist-err" }, i18nNode("U0394", { error: st.error })));
      }
    }
    kids.push(...hermesRequestCards());
    els.msgsInner.replaceChildren(...kids);
    if (scrollToEnd) els.msgs.scrollTop = 0; // column-reverse: 0 is the newest message
    scrollToEnd = false;
    requestAnimationFrame(maybeLoadOlder); // a short list may still be near its top
    return true; // the caller can now publish this painted conversation
  }

  /**
   * Send the composer (or, with opts.box, a queued outbox message) to the selected (opts.sid) session. While the
   * session works the message is queued in the Deck's outbox instead (Hermes cannot cancel a queued prompt, and its
   * default busy mode would redirect the running turn); files cannot be queued. Resolves true when it was submitted.
   */
  async function hermesSend(files = [], names = [], opts = {}) {
    const box = opts.box || null;
    const previews = Array.isArray(opts.previews) ? opts.previews : []; // the tray's own thumbnails (media-preview.js)
    const text = box ? box.text : typeof opts.text === "string" ? opts.text : els.input.value.trim();
    if ((!text && !files.length) || !(opts.sid || H.sel) || H.sending || (!box && H.steering) || !bridgeOpen()) return false;
    RG.submit(opts.sid || H.sel);
    if (!box && !opts.now) {
      const n0 = H.nodes.get(H.sel);
      if (nodeLive(n0) || OB.pending(H.sel)) {
        // busy-send.js: Enter queues or steers (Settings), Ctrl/Cmd+Enter does the other once
        const d = BS.decide({ mode: BS.modeOf(S.settings), alt: opts.alt === true, busy: true, live: nodeLive(n0), controllable: nodeControllable(n0), files: files.length > 0 });
        let fallback = d.fallback;
        if (d.action === "steer") {
          const steered = await hermesSteerNow(n0, text);
          if (steered === true) return true;
          if (steered === "takeover") return false;
          fallback = steered; // could not steer: queued below, the note says why
        }
        // files wait in the outbox as the tokens main staged; Cancel discards them, Edit puts them back in the tray
        const key = AT.key();
        const views = files.length ? AT.views(key, files) : [];
        if (views.length) views.forEach((v, i) => { if (!v.preview && previews[i]) v.preview = previews[i]; });
        if (OB.add(H.sel, text, views)) {
          if (files.length) AT.queued(key, files); // durable queued tokens, not in the tray
          DR.sent(key, text); // queued: the box and this chat's draft are now empty
          const queuedNote = (S.note = fallback ? i18nText(`live.fallback.${fallback}`) : i18nText("queue.added"));
          S.noteBad = false;
          setTimeout(() => { // transient: the bubble shows the queue; the composer hint comes back
            if (S.note === queuedNote) {
              S.note = null;
              renderNote();
            }
          }, 4000);
          scrollToEnd = true;
          mark("msgs", true);
          hermesPoll();
        } else {
          S.note = i18nText("queue.full", { n: OB.MAX });
          S.noteBad = true;
        }
        renderNote();
        return false;
      }
    }
    const attachmentKey = box ? null : opts.attachmentKey || AT.key();
    let sid = opts.sid || H.sel;
    let ok = false;
    H.sending = true;
    AT.render();
    S.note = i18nText("U0464");
    S.noteBad = false;
    renderNote();
    try {
      // Botlar: the first message to a bot without a Bot Chat creates it (looked up again first, fail closed)
      if (BT && BT.isDraft(sid)) sid = (await BT.materialize(sid)).sid;
      // All sessions: a chat a messaging platform owns was opened read-only; the first message continues it in a copy
      if (SB) sid = await SB.beforeSend(sid, opts.profile || (H.nodes.get(sid) || H.hist.get(sid) || {}).profile);
      const st = H.hist.get(sid);
      const n = H.nodes.get(sid);
      const r = await deck.bridge.send(sid, text, { profile: opts.profile || (n ? n.profile : st ? st.profile : "default"), files });
      ok = true;
      if (!box) {
        AT.sent(attachmentKey, files);
        DR.sent(attachmentKey, text); // the draft of the chat it was typed in, even after the reader moved on
      }
      const list = H.echo.get(sid) || [];
      const filesOnly = !text && names.length > 0;
      list.push({ text: text || (names.length ? i18nText("attach.echoFiles", { names: names.join(", ") }) : ""), at: Date.now(), files: filesOnly || (files.length > 0 && !text), previews, names }); // previews: the tray's own thumbnails (media-preview.js)
      H.echo.set(sid, list);
      LA.event(sid, "local.sent"); // the working row shows at once, before Hermes' first event
      S.note = r.status === "queued" ? i18nText("U0602") : null;
      if (H.sel === sid) {
        scrollToEnd = true;
        mark("msgs", true);
      }
      hermesPoll();
    } catch (e) {
      const profile = opts.profile || (H.nodes.get(sid) || H.hist.get(sid) || {}).profile || "default";
      const offered = TK.offer(e, { sid, profile }, async () => {
        const sent = await hermesSend(files, names, { ...opts, sid, profile, now: true, text, attachmentKey });
        if (sent && box) OB.remove(sid, box.id);
        return sent;
      });
      S.note = offered ? null : i18nText("U0540", { e: cleanErr(e) });
      S.noteBad = !offered;
      if (box) OB.setError(sid, box.id, cleanErr(e));
    } finally {
      H.sending = false;
      AT.render();
      renderNote();
    }
    return ok;
  }

  /**
   * Steer the running turn with the composer text (busySend "steer", or Ctrl/Cmd+Enter). The box clears at once and
   * the message shows as a sent echo (Hermes stores a steer as the user's own words). True when Hermes took it, else
   * the fallback reason ("control") and the caller queues the text instead.
   */
  async function hermesSteerNow(n, text, draftKey = AT.key()) {
    if (!n || !text || H.steering) return "control";
    const sid = n.sid;
    const key = draftKey;
    H.steering = true;
    const echo = { text, at: Date.now(), files: false, previews: [], names: [] };
    H.echo.set(sid, [...(H.echo.get(sid) || []), echo]);
    scrollToEnd = true;
    mark("msgs", true);
    renderNote();
    let ok = false;
    try {
      const r = await deck.bridge.steer(sid, text, { turnId: n.turnId, profile: n.profile });
      ok = r.status === "queued";
      if (!ok) ctlTurnGone(n, r.status);
    } catch (e) {
      const offered = TK.offer(e, { sid, profile: n.profile || "default" }, result => result.mode === "restarted"
        ? hermesSend([], [], { sid, profile: n.profile || "default", now: true, text, attachmentKey: key })
        : hermesSteerNow(n, text, key));
      if (offered) {
        H.echo.set(sid, (H.echo.get(sid) || []).filter(x => x !== echo));
        return "takeover";
      }
      ok = false;
    } finally {
      H.steering = false;
    }
    if (ok) {
      DR.sent(key, text);
      S.note = null;
      S.noteBad = false;
      renderNote();
      hermesPoll();
      return true;
    }
    const list = (H.echo.get(sid) || []).filter((x) => x !== echo); // not delivered: the queue below shows it instead
    if (list.length) H.echo.set(sid, list);
    else H.echo.delete(sid);
    return "steerFailed";
  }

  /** Composer Stop (replaces Send while the session works and the box is empty): one click, the row goes at once. */
  async function hermesStopNow(n = H.nodes.get(H.sel)) {
    if (!n || H.stopping) return;
    H.stopping = n.sid;
    renderNote();
    try {
      const r = await deck.bridge.interrupt(n.sid, { turnId: n.turnId || undefined });
      const gone = ctlTurnGone(n, r.status);
      if (r.status === "interrupted") LA.end(n.sid);
      S.note = r.status === "interrupted" || gone ? null : CTL_TR[r.status] || `Hermes: ${r.status}`;
      S.noteBad = !!S.note;
    } catch (e) {
      // the bridge itself found no live turn to stop (U0087): same as Hermes saying not_running
      const gone = cleanErr(e) === i18nText("U0087") && ctlTurnGone(n, "not_running");
      S.note = gone ? null : cleanErr(e);
      S.noteBad = !gone;
    } finally {
      H.stopping = null;
      mark("msgs", "strip", true);
      renderNote();
    }
  }

  // ------------------------------------------------------------ outbox (messages waiting for a busy session)
  let outboxBusy = false;
  /** Submit the head of one idle session's outbox (FIFO, one at a time, normal send path). */
  function outboxDrain() {
    if (outboxBusy || H.sending || !hermesMode() || !bridgeOpen()) return;
    for (const [sid, n] of H.nodes) {
      const item = OB.next(sid, { live: nodeLive(n) });
      if (!item) continue;
      outboxBusy = true;
      OB.submitted(sid);
      hermesSend(...outboxFiles(item), { box: item, sid, previews: (item.files || []).map((f) => f.preview || null) })
        .then((ok) => {
          if (ok) OB.remove(sid, item.id);
        })
        .finally(() => {
          outboxBusy = false;
          if (H.sel === sid) mark("msgs", true);
        });
      return;
    }
  }
  /** [tokens, names] of a queued message's files, for the normal send path. */
  function outboxFiles(item) {
    return [(item.files || []).map((f) => f.token), (item.files || []).map((f) => f.name)];
  }
  function outboxCancel(id) {
    const item = OB.remove(H.sel, id);
    if (!item) return;
    if (item.files && item.files.length) AT.forget(item.files.map((f) => f.token)); // main drops the staged bytes
    mark("msgs", true);
  }
  /** Back into the composer (before whatever is typed there), out of the outbox. */
  function outboxEdit(id) {
    const item = OB.remove(H.sel, id);
    if (!item) return;
    if (item.files && item.files.length) AT.restore(AT.key(), item.files); // back into this chat's tray
    const cur = els.input.value.trim();
    els.input.value = cur && item.text ? `${item.text}\n${cur}` : cur || item.text;
    autosize();
    els.input.focus();
    mark("msgs", true);
  }
  /** Steer the running turn with it when the plugin controls that turn, else the plain send path. */
  async function outboxSendNow(id) {
    const sid = H.sel;
    const item = OB.get(sid, id);
    const n = H.nodes.get(sid);
    if (!item || H.sending) return;
    // steer carries text only: a queued message with files goes through the normal path (Hermes queues an attachment
    // turn after the running one without interrupting it)
    if (nodeControllable(n) && !(item.files && item.files.length)) {
      try {
        const r = await deck.bridge.steer(sid, item.text, { turnId: n.turnId });
        if (r.status === "queued") OB.remove(sid, id);
        else OB.setError(sid, id, CTL_TR[r.status] || `Hermes: ${r.status}`);
      } catch (e) {
        OB.setError(sid, id, cleanErr(e));
      }
      mark("msgs", true);
      return;
    }
    if (await hermesSend(...outboxFiles(item), { box: item, sid, now: true, previews: (item.files || []).map((f) => f.preview || null) })) OB.remove(sid, id);
    mark("msgs", true);
  }

  /** "Interrupt and send": the running turn leaves its task and follows this queued message (native redirect). */
  async function outboxRedirect(id) {
    const sid = H.sel;
    const item = OB.get(sid, id);
    const n = H.nodes.get(sid);
    if (!item || !item.text || H.sending || !nodeControllable(n)) return;
    try {
      const r = await deck.bridge.redirect(sid, item.text, { turnId: n.turnId });
      if (r.status === "redirected") {
        OB.remove(sid, id);
        H.echo.set(sid, [...(H.echo.get(sid) || []), { text: item.text, at: Date.now(), files: false, previews: [], names: [] }]);
      } else OB.setError(sid, id, CTL_TR[r.status] || `Hermes: ${r.status}`);
    } catch (e) {
      OB.setError(sid, id, cleanErr(e));
    }
    mark("msgs", true);
  }
  document.addEventListener("click", (e) => {
    if (!(e.target.closest && e.target.closest(".outbox-more")) && OB.closeMenu()) mark("msgs", true);
  });

  // ------------------------------------------------------------ approvals and questions
  function hermesRequestCards() {
    if (!H.requests.length) return [];
    const mine = (r) => (hermesMode() && r.sid && r.sid === H.sel ? 0 : 1);
    return H.requests.slice().sort((a, b) => mine(a) - mine(b) || a.at - b.at).map(requestCard);
  }

  function answerState(id) {
    let a = H.answers.get(id);
    if (!a) {
      a = { busy: false, error: null, text: {}, pick: {} };
      H.answers.set(id, a);
    }
    return a;
  }

  function requestCard(r) {
    const n = r.sid ? H.nodes.get(r.sid) : null;
    const who = n ? hermesTitle(n) : r.sid ? i18nText("common.sessionId", { v: r.sid.slice(-8) }) : r.rpcId ? i18nText("A0275", { v: r.rpcId.slice(-8) }) : "Hermes";
    const a = answerState(r.id);
    const disabled = a.busy || !bridgeOpen();
    const head = h("div", { class: "hreq-head" }, h("span", { class: "hreq-kind" }, r.kind === "approval" ? i18nNode("A0276") : i18nNode("A0277")), h("span", { class: "hreq-who" }, who));
    const err = a.error ? h("p", { class: "form-error", role: "alert" }, a.error) : null;
    if (r.kind === "approval") {
      return h("section", { class: "hreq", tabindex: "-1", dataset: { hold: "1", requestId: r.id, requestProfile: r.profile }, "aria-label": i18nText("U0603") , "data-i18n-aria-label": "U0603"},
        head,
        r.description ? h("p", { class: "hreq-desc" }, r.description) : null,
        r.command ? h("pre", { class: "hreq-cmd" }, r.command) : null,
        h("div", { class: "form-actions" },
          r.choices.map((c) => h("button", { class: `btn${c === "once" ? " primary" : ""}`, type: "button", disabled, dataset: { fk: `hreq:${r.id}:${c}` }, onclick: () => answerApproval(r, c) }, CHOICE_TR[c] || c))),
        err);
    }
    const blocks = r.questions.map((q) => {
      const picked = a.pick[q.qid] || (a.pick[q.qid] = []);
      return h("div", { class: "hreq-q" },
        h("p", { class: "hreq-desc" }, q.question),
        q.choices.length
          ? h("div", { class: "choices" },
              q.choices.map((c) => h("button", { class: "btn mini", type: "button", "aria-pressed": picked.includes(c) ? "true" : "false", disabled, dataset: { fk: `hreqc:${r.id}:${q.qid}:${c}` }, onclick: () => pickChoice(r, q, c) }, c)))
          : null,
        h("input", {
          class: "hreq-text", type: "text", value: a.text[q.qid] || "", placeholder: q.choices.length ? i18nText("U0604") : i18nText("U0605"), "aria-label": q.question, disabled,
          dataset: { fk: `hreqt:${r.id}:${q.qid}` },
          oninput: (e) => (a.text[q.qid] = e.target.value),
          onkeydown: (e) => {
            if (e.key === "Enter" && !e.isComposing) {
              e.preventDefault();
              answerQuestion(r);
            }
          },
        }));
    });
    return h("section", { class: "hreq", tabindex: "-1", dataset: { hold: "1", requestId: r.id, requestProfile: r.profile }, "aria-label": i18nText("U0606") , "data-i18n-aria-label": "U0606"},
      head,
      blocks,
      h("div", { class: "form-actions" }, h("button", { class: "btn primary", type: "button", disabled, dataset: { fk: `hreqsend:${r.id}` }, onclick: () => answerQuestion(r) }, a.busy ? i18nNode("U0464") : i18nNode("U0607"))),
      err);
  }

  function pickChoice(r, q, c) {
    const a = answerState(r.id);
    const list = a.pick[q.qid] || [];
    a.pick[q.qid] = q.multi ? (list.includes(c) ? list.filter((x) => x !== c) : [...list, c]) : list.includes(c) ? [] : [c];
    mark("msgs", true);
  }

  async function answerApproval(r, choice) {
    const a = answerState(r.id);
    if (a.busy) return;
    a.busy = true;
    a.error = null;
    mark("msgs", true);
    try {
      const res = await deck.bridge.answerApproval(r.id, choice);
      if (res.status === "ok") H.answers.delete(r.id);
      else a.error = i18nText("U0036");
    } catch (e) {
      a.error = cleanErr(e);
    } finally {
      a.busy = false;
      mark("msgs", "rail", "strip", true);
    }
  }

  async function answerQuestion(r) {
    const a = answerState(r.id);
    if (a.busy) return;
    const answers = {};
    for (const q of r.questions) answers[q.qid] = (a.text[q.qid] || "").trim() || (a.pick[q.qid] || []).join(", ");
    if (Object.values(answers).every((v) => !v)) {
      a.error = i18nText("U0608");
      mark("msgs", true);
      return;
    }
    a.busy = true;
    a.error = null;
    mark("msgs", true);
    try {
      const res = await deck.bridge.answerQuestion(r.id, answers);
      if (res.status === "ok") H.answers.delete(r.id);
      else a.error = i18nText("U0036");
    } catch (e) {
      a.error = cleanErr(e);
    } finally {
      a.busy = false;
      mark("msgs", "rail", "strip", true);
    }
  }

  // ------------------------------------------------------------ session controls (Steer · Stop · Model)
  function ctlState(sid) {
    let c = H.ctl.get(sid);
    if (!c) {
      c = { mode: null, where: null, text: "", busy: false, note: null, bad: false, armed: false, armTimer: 0, noteTimer: 0, models: null, pick: "", confirm: null, focus: false };
      H.ctl.set(sid, c);
    }
    return c;
  }
  const ctlRefresh = () => mark("head", "panel", true);
  function ctlNote(c, text, bad) {
    c.note = text;
    c.bad = !!bad;
    clearTimeout(c.noteTimer);
    c.noteTimer = setTimeout(() => {
      c.note = null;
      ctlRefresh();
    }, bad ? 12000 : 6000);
  }

  /** Controls for one bridge session; where = "head" or "card:<sid>" (an inline box opens only where it was asked). */
  function hermesControls(n, where) {
    if (!n || !bridgeOpen()) return null;
    const c = ctlState(n.sid);
    const live = nodeLive(n);
    const canSteer = nodeControllable(n);
    const canStop = canSteer || (live && n.bound);
    const why = !live ? i18nText("U0566") : !canSteer ? i18nText("U0609") : null;
    const fk = (x) => `h${x}:${where}:${n.sid}`;
    const open = (m) => c.mode === m && c.where === where;
    const row = h("div", { class: "hctl" },
      h("button", { class: `btn mini${open("steer") ? " on" : ""}`, type: "button", disabled: !canSteer || c.busy, title: canSteer ? i18nText("U0610") : why, dataset: { fk: fk("steer") }, onclick: () => ctlToggle(n, where, "steer") }, i18nNode("A0278")),
      h("button", { class: `btn mini${c.armed ? " danger" : ""}`, type: "button", disabled: !canStop || c.busy, title: canStop ? (c.armed ? i18nText("U0611") : i18nText("U0612")) : why, dataset: { fk: fk("stop") }, onclick: () => ctlStop(n) }, c.armed ? i18nNode("A0279") : i18nNode("A0182")),
      h("button", { class: `btn mini${open("model") ? " on" : ""}`, type: "button", disabled: c.busy, title: i18nText("U0613"), dataset: { fk: fk("model") }, onclick: () => ctlToggle(n, where, "model") , "data-i18n-title": "U0613"}, i18nNode("A0280")));
    // Control feedback gets its own status line under the button group, never a loose word beside the buttons.
    const note = c.busy ? h("p", { class: "hctl-note busy", role: "status" }, i18nNode("activity.sending")) : c.note ? h("p", { class: `hctl-note${c.bad ? " bad" : ""}`, role: "status" }, c.note) : null;
    const box = open("steer") ? steerBox(n, c, fk) : open("model") ? modelBox(n, c, fk) : null;
    return h("div", { class: `hctl-wrap at-${where === "head" ? "head" : "card"}` }, row, box, note);
  }

  /** Overflow-menu entries for one card/row: only what applies to the agent's current state (no dead buttons). */
  function hermesControlItems(sid) {
    const n = H.nodes.get(sid);
    if (!n || !bridgeOpen()) return [];
    const c = ctlState(sid);
    const where = `card:${sid}`;
    const live = nodeLive(n);
    const canSteer = nodeControllable(n);
    const canStop = canSteer || (live && n.bound);
    const why = !live ? i18nText("U0566") : !canSteer ? i18nText("U0609") : null;
    const open = (m) => c.mode === m && c.where === where;
    const items = [];
    if (live) {
      items.push({ id: "steer", label: i18nText("A0278"), disabled: !canSteer || c.busy, title: canSteer ? i18nText("U0610") : why, on: open("steer"), run: () => ctlToggle(n, where, "steer") });
      items.push({ id: "stop", label: c.armed ? i18nText("A0279") : i18nText("A0182"), disabled: !canStop || c.busy, title: canStop ? (c.armed ? i18nText("U0611") : i18nText("U0612")) : why, danger: c.armed, keepOpen: !c.armed, run: () => ctlStop(n) });
    }
    items.push({ id: "model", label: i18nText("A0280"), disabled: c.busy, title: i18nText("U0613"), on: open("model"), run: () => ctlToggle(n, where, "model") });
    return items;
  }

  /** The inline steer/model box and the control feedback line of a card (what the overflow menu opened). */
  function hermesControlBox(sid) {
    const n = H.nodes.get(sid);
    if (!n || !bridgeOpen()) return null;
    const c = ctlState(sid);
    const where = `card:${sid}`;
    const fk = (x) => `h${x}:${where}:${sid}`;
    const open = (m) => c.mode === m && c.where === where;
    const box = open("steer") ? steerBox(n, c, fk) : open("model") ? modelBox(n, c, fk) : null;
    const note = c.busy ? h("p", { class: "hctl-note busy", role: "status" }, i18nNode("activity.sending")) : c.note ? h("p", { class: `hctl-note${c.bad ? " bad" : ""}`, role: "status" }, c.note) : null;
    return box || note ? h("div", { class: "hctl-wrap at-card" }, box, note) : null;
  }

  function hermesCardControls(sid) {
    const n = H.nodes.get(sid);
    return n ? hermesControls(n, `card:${sid}`) : null;
  }

  function ctlToggle(n, where, mode) {
    const c = ctlState(n.sid);
    if (c.mode === mode && c.where === where) {
      c.mode = null;
      c.where = null;
    } else {
      c.mode = mode;
      c.where = where;
      c.confirm = null;
      c.focus = mode === "steer";
      if (mode === "model") loadModels(n, c);
    }
    ctlRefresh();
  }

  function steerBox(n, c, fk) {
    const close = () => {
      c.mode = null;
      ctlRefresh();
    };
    const input = h("input", {
      class: "hctl-input", type: "text", value: c.text, maxlength: "32000", placeholder: i18nText("U0614"), "aria-label": i18nText("U0615"),
      dataset: { fk: fk("steertext") },
      oninput: (e) => (c.text = e.target.value),
      onkeydown: (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          ctlSteer(n, false);
        } else if (e.key === "Escape") close();
      },
     "data-i18n-placeholder": "U0614", "data-i18n-aria-label": "U0615"});
    if (c.focus) {
      c.focus = false;
      requestAnimationFrame(() => input.focus());
    }
    return h("div", { class: "hctl-edit", dataset: { hold: "1" } },
      input,
      h("button", { class: "btn mini primary", type: "button", disabled: c.busy, dataset: { fk: fk("steersend") }, onclick: () => ctlSteer(n, false) }, i18nNode("U0616")),
      h("button", { class: "btn mini", type: "button", disabled: c.busy, title: i18nText("U0617"), dataset: { fk: fk("redirect") }, onclick: () => ctlSteer(n, true) , "data-i18n-title": "U0617"}, i18nNode("U0618")),
      h("button", { class: "btn mini", type: "button", dataset: { fk: fk("steerclose") }, onclick: close }, i18nNode("U0451")));
  }

  async function ctlSteer(n, redirect) {
    const c = ctlState(n.sid);
    const text = c.text.trim();
    if (!text || c.busy) return;
    c.busy = true;
    ctlRefresh();
    try {
      // The turn id shown on screen goes along: if the agent moved on, the bridge refuses instead of retargeting.
      const r = await (redirect ? deck.bridge.redirect : deck.bridge.steer)(n.sid, text, { turnId: n.turnId });
      const ok = r.status === (redirect ? "redirected" : "queued");
      ctlNote(c, CTL_TR[r.status] || `Hermes: ${r.status}`, !ok && !ctlTurnGone(n, r.status));
      if (ok) {
        c.text = "";
        c.mode = null;
      }
    } catch (e) {
      ctlNote(c, cleanErr(e), true);
    } finally {
      c.busy = false;
      ctlRefresh();
    }
  }

  /**
   * Hermes says no turn is running (the Deck's "thinking" was stale): drop the live state of that turn now instead of
   * waiting for the next snapshot, and keep it dropped if a lagging snapshot still claims it. True when it did.
   */
  function ctlTurnGone(n, status) {
    if (status !== "not_running" && status !== "not_interrupted") return false;
    H.gone.set(n.sid, n.turnId || "");
    H.nodes.set(n.sid, goneNode(n));
    H.live.delete(n.sid);
    LA.end(n.sid);
    mark("rail", "head", "strip", "panel", "msgs", "top", true);
    return true;
  }
  const goneNode = (n) => ({ ...n, active: false, state: n.state === "error" ? "error" : "idle", terminalAt: n.terminalAt === null ? nowS() : n.terminalAt, controlAvailable: false });

  /** Two steps: the first click arms the button for five seconds, the second one stops the turn. */
  async function ctlStop(n) {
    const c = ctlState(n.sid);
    if (c.busy) return;
    if (!c.armed) {
      c.armed = true;
      clearTimeout(c.armTimer);
      c.armTimer = setTimeout(() => {
        c.armed = false;
        ctlRefresh();
      }, 5000);
      ctlRefresh();
      return;
    }
    clearTimeout(c.armTimer);
    c.armed = false;
    c.busy = true;
    ctlRefresh();
    try {
      const r = await deck.bridge.interrupt(n.sid, { turnId: n.turnId || undefined });
      const gone = ctlTurnGone(n, r.status);
      ctlNote(c, CTL_TR[r.status] || `Hermes: ${r.status}`, r.status !== "interrupted" && !gone);
    } catch (e) {
      // the bridge itself found no live turn to stop (U0087): same as Hermes saying not_running
      const gone = cleanErr(e) === i18nText("U0087") && ctlTurnGone(n, "not_running");
      ctlNote(c, cleanErr(e), !gone);
    } finally {
      c.busy = false;
      ctlRefresh();
    }
  }

  async function loadModels(n, c) {
    c.busy = true;
    c.models = null;
    ctlRefresh();
    try {
      const r = await deck.bridge.modelOptions(n.sid, { profile: n.profile });
      c.models = r;
      const cur = r.options.find((o) => o.current) || r.options[0];
      c.pick = cur ? JSON.stringify([cur.provider, cur.id]) : "";
      if (!r.options.length) ctlNote(c, i18nText("U0619"), true);
    } catch (e) {
      ctlNote(c, i18nText("U0620", { e: cleanErr(e) }), true);
      c.mode = null;
    } finally {
      c.busy = false;
      ctlRefresh();
    }
  }

  function modelBox(n, c, fk) {
    if (!c.models) return h("div", { class: "hctl-edit" }, h("span", { class: "hctl-note" }, i18nNode("U0621")));
    const close = () => {
      c.mode = null;
      c.confirm = null;
      ctlRefresh();
    };
    const sel = h("select", { class: "hctl-input", "aria-label": i18nText("A0280"), dataset: { fk: fk("modelsel") }, onchange: (e) => {
      c.pick = e.target.value;
      c.confirm = null;
    } , "data-i18n-aria-label": "A0280"},
      c.models.options.map((o) => {
        const v = JSON.stringify([o.provider, o.id]);
        return h("option", { value: v, selected: v === c.pick ? true : null }, `${o.id.split("/").pop()} · ${o.providerName}${o.current ? i18nText("U0622") : ""}`);
      }));
    const box = h("div", { class: "hctl-edit", dataset: { hold: "1" } },
      sel,
      h("button", { class: "btn mini primary", type: "button", disabled: c.busy || !c.pick, dataset: { fk: fk("modelapply") }, onclick: () => applyModel(n, c, false) }, i18nNode("A0282")),
      h("button", { class: "btn mini", type: "button", dataset: { fk: fk("modelclose") }, onclick: close }, i18nNode("U0451")));
    if (!c.confirm) return box;
    return h("div", { class: "hctl-col" },
      box,
      h("div", { class: "hctl-confirm", role: "alert" },
        h("span", null, c.confirm),
        h("button", { class: "btn mini danger", type: "button", disabled: c.busy, dataset: { fk: fk("modelconfirm") }, onclick: () => applyModel(n, c, true) }, i18nNode("A0283")),
        h("button", { class: "btn mini", type: "button", onclick: () => {
          c.confirm = null;
          ctlRefresh();
        } }, i18nNode("U0451"))));
  }

  async function applyModel(n, c, confirm) {
    if (!c.pick || c.busy) return;
    let provider;
    let model;
    try {
      [provider, model] = JSON.parse(c.pick);
    } catch {
      return;
    }
    c.busy = true;
    ctlRefresh();
    try {
      // Session-scoped only; Hermes keeps its own confirmation for expensive models.
      const r = await deck.bridge.setModel(n.sid, { model, provider, confirm, profile: n.profile });
      if (r.confirmRequired) c.confirm = r.message || i18nText("U0623");
      else {
        c.confirm = null;
        c.mode = null;
        ctlNote(c, i18nText("U0624", { v: model.split("/").pop(), v2: r.deferred ? i18nText("U0625") : "", v3: r.warning ? ` ${r.warning}` : "" }), false);
      }
    } catch (e) {
      ctlNote(c, cleanErr(e), true);
    } finally {
      c.busy = false;
      ctlRefresh();
    }
  }

  // ------------------------------------------------------------ Activity tab while the chat shows Hermes
  function hermesNodeCard(n) {
    const ctx = n.ctxMax && n.ctxUsed ? i18nText("U0505", { v: Math.round((100 * n.ctxUsed) / n.ctxMax) }) : "";
    return h("article", { class: "card mine" },
      h("header", { class: "card-head act" },
        h("span", { class: `state ${hStateClass(n)}` }, H_STATE_TR[n.state] || n.state),
        h("span", null, n.parent ? i18nNode("common.subagent") : n.source || ""),
        h("span", { class: "model" }, n.model || ""),
        h("span", { class: "when" }, n.updatedAt ? ago(n.updatedAt) : "")),
      n.parent ? h("p", { class: "ask" }, hermesTitle(n)) : null,
      n.steps.length ? h("p", { class: nodeLive(n) ? "now" : "nums" }, n.steps.slice(-4).join(" → ")) : null,
      h("p", { class: "nums" }, `${n.observation === "native_hook" ? i18nText("A0285") : n.observation ? `kaynak: ${n.observation}` : ""}${ctx}`),
      hermesControls(n, `card:${n.sid}`));
  }

  function paneHermesActivity(kids) {
    if (!H.sel) {
      kids.push(h("p", { class: "pane-title" }, bridgeOpen() ? i18nNode("U0626") : hermesStatusText()));
      return;
    }
    if (BT && BT.pane(kids, H.sel)) return; // Botlar: a bot's card while its Bot Chat is idle or not created yet
    hermesSessionPane(kids);
    if (BT) BT.routines(kids, H.sel); // Botlar: Rutinler of the bot whose Bot Chat this is (read-only, relay)
  }

  function hermesSessionPane(kids) {
    const n = H.nodes.get(H.sel);
    const s = S.relay.sessions.get(H.sel); // the relay keys sessions by the same Hermes session id
    kids.push(h("p", { class: "pane-title" }, h("b", null, n ? hermesTitle(n) : `Hermes · ${H.sel.slice(-8)}`), n ? ` · ${profileLabel(n.profile)}` : ""));
    if (s) {
      kids.push(sessionCard(s, null));
      return;
    }
    if (!n) {
      kids.push(h("p", { class: "muted" }, i18nNode("U0627")));
      return;
    }
    kids.push(hermesNodeCard(n));
    for (const c of H.nodes.values()) if (c.parent === n.sid) kids.push(hermesNodeCard(c));
  }

  // ------------------------------------------------------------ Settings → Direct Hermes connection
  function paneHermesSettings(kids, { firstRun = false } = {}) {
    const saved = (S.settings && S.settings.bridge) || {};
    if (!H.draft) H.draft = { mode: saved.mode || "off", target: saved.target || "", python: saved.python || "", stream: saved.stream || "", distribution: saved.distribution || "" };
    const d = H.draft;
    if (H.formMsg) kids.push(h("p", { class: H.formMsg.ok ? "form-ok" : "form-error", role: "status" }, H.formMsg.text));
    const windows = H.platform ? H.platform === "win32" : /Win/i.test(navigator.platform);
    const local = windows ? ["wsl", i18nText("A0286")] : ["local", i18nText("A0287")];
    const modes = [["off", i18nText("U0630")], ["ssh", i18nText("U0631")], local];
    if (!modes.some(([v]) => v === d.mode)) modes.push([d.mode, d.mode]);
    kids.push(h("label", { class: "field", for: "s-br-mode" },
      h("span", { class: "flabel" }, i18nNode("U0632")),
      h("select", { id: "s-br-mode", onchange: (e) => {
        d.mode = e.target.value;
        syncBridgeFields();
      } }, modes.map(([v, label]) => h("option", { value: v, selected: v === d.mode ? true : null }, label)))));
    const fld = (id, key, label, attrs) => {
      const el = sfield(id, label, { value: d[key] || "", spellcheck: "false", ...attrs });
      el.querySelector("input").addEventListener("input", (e) => {
        d[key] = e.target.value;
      });
      return el;
    };
    const e = (H.els = {});
    e.target = fld("s-br-target", "target", i18nText("A0288"), { placeholder: i18nText("U0633"), title: i18nText("U0634") });
    e.python = fld("s-br-python", "python", i18nText("A0289"), { placeholder: "~/.hermes/hermes-agent/venv/bin/python", title: i18nText("U0635") });
    e.stream = fld("s-br-stream", "stream", i18nText("A0291"), { placeholder: "~/.hermes/hermes-deck/stream.py", title: i18nText("U0636") });
    e.dist = fld("s-br-dist", "distribution", i18nText("U0637"), { placeholder: i18nText("U0638") });
    // the host paths are needed but rarely changed: behind "Advanced", open while one is still empty
    e.adv = h("details", { class: "sv-adv", open: !d.python || !d.stream ? true : null }, h("summary", null, i18nNode("set.advanced")), e.python, e.stream, e.dist);
    kids.push(e.target, e.adv);
    kids.push(h("div", { class: "form-actions" },
      firstRun ? null : h("button", { class: "btn primary", type: "button", onclick: saveBridgeSettings }, i18nNode("U0487")),
      h("button", { class: "btn", type: "button", onclick: testBridge }, i18nNode("U0639"))));
    e.status = h("p", { class: "hb-status", role: "status" });
    e.test = h("p", { class: "hb-test", role: "status" });
    kids.push(e.status, e.test);
    syncBridgeFields();
    updateBridgeStatusLine();
    renderTestLine();
  }

  function syncBridgeFields() {
    const d = H.draft;
    const e = H.els;
    if (!d || !e.target) return;
    e.target.hidden = d.mode !== "ssh";
    if (e.adv) e.adv.hidden = d.mode === "off";
    e.python.hidden = d.mode === "off";
    e.stream.hidden = d.mode === "off";
    e.dist.hidden = d.mode !== "wsl";
  }

  function updateBridgeStatusLine() {
    const el = H.els.status;
    if (!el) return;
    const s = H.status.status;
    el.textContent = bridgeOn() ? hermesStatusText() : i18nText("U0642");
    el.className = `hb-status${!bridgeOn() ? "" : s === "open" ? " ok" : s === "connecting" ? " warn" : " bad"}`;
  }

  function renderTestLine() {
    const el = H.els.test;
    if (!el) return;
    const t = H.connTest.test;
    el.textContent = t ? t.text : "";
    el.className = `hb-test${t && t.ok === true ? " ok" : t && t.ok === false ? " bad" : ""}`;
  }

  const draftConfig = () => {
    const d = H.draft || {};
    return { mode: d.mode, target: d.target, python: d.python, stream: d.stream, distribution: d.distribution };
  };
  let formMsgTimer = 0;
  function setFormMsg(msg) {
    H.formMsg = msg;
    clearTimeout(formMsgTimer);
    formMsgTimer = setTimeout(() => (H.formMsg = null), 10000); // shown until the next rebuild after this
  }

  async function saveBridgeSettings() {
    const d = H.draft || {};
    try {
      S.settings = await deck.settingsSave({ bridge: draftConfig() });
      H.draft = null;
      settingsMessage(true, d.mode === "off" ? i18nText("U0643") : i18nText("U0644"));
    } catch (e) {
      settingsMessage(false, i18nText("common.saveFailed", { e: cleanErr(e) }));
    }
    mark("panel", "top", "rail", "head", "msgs", "strip", true);
    renderNote();
  }

  /** Read-only probe of the values in the form (saved or not): first snapshot, then a session list. */
  async function testBridge() {
    const w = H.connTest;
    if (w.testBusy) return;
    w.testBusy = true;
    w.test = { ok: null, text: i18nText("U0647") };
    renderTestLine();
    try {
      w.test = await deck.bridge.test(draftConfig());
    } catch (e) {
      w.test = { ok: false, text: cleanErr(e) };
    } finally {
      w.testBusy = false;
      renderTestLine();
    }
  }

  // ------------------------------------------------------------ bridge feed
  async function refreshHermesProfiles() {
    if (!bridgeOpen() || H.profileRead || Date.now() - H.profilesAt < 30000) return;
    const read = {};
    H.profileRead = read;
    H.profilesAt = Date.now();
    try {
      const profiles = await deck.bridge.profiles();
      if (H.profileRead !== read || !bridgeOpen()) return;
      H.profiles = profiles;
      mark("rail", true);
    } catch (_) {
      // Older hosts may not expose the catalog; snapshot-derived profiles remain usable.
    } finally {
      if (H.profileRead === read) H.profileRead = null;
    }
  }

  function applyBridgeStatus(s) {
    const was = H.status.status;
    H.status = { status: s.status, error: s.error || null, code: s.code || null, retryInMs: s.retryInMs || null };
    if (s.status !== "open") {
      H.profileRead = null; // reject a late reply from the previous connection
      H.profilesAt = 0;
      H.live.clear();
      LA.clear();
    }
    if (s.status === "off") {
      H.profiles = [];
      H.nodes.clear();
      H.requests = [];
    }
    updateBridgeStatusLine();
    mark("top", "rail", "head", "msgs", "strip", "panel", true);
    renderNote();
    VO.sync(); // the mic button follows the connection (and an open recording is dropped when it goes away)
    if (s.status === "open" && was !== "open" && hermesMode()) {
      if (H.sel) hermesLoadHistory(H.sel);
      hermesPoll();
    }
    if (s.status === "open") refreshHermesProfiles();
    if (BT) BT.onStatus(s.status, was); // Botlar: roster poll on (re)connect
    if (SB && s.status === "open") SB.onStatus(); // All sessions: reload an open browser on (re)connect
  }

  function applyBridgeSnapshot(snap) {
    if (!snap || !Array.isArray(snap.nodes)) return;
    refreshHermesProfiles(); // refresh the catalog even on an empty host, with no selected session
    const nodes = snap.nodes
      .filter((n) => !H.deleted.has(n.sid))
      .map((n) => {
        if (!H.gone.has(n.sid)) return n;
        if (H.gone.get(n.sid) !== (n.turnId || "")) H.gone.delete(n.sid); // a newer turn: live again
        else if (nodeLive(n)) return goneNode(n);
        return n;
      });
    hermesRank(nodes);
    H.snap = nodes;
    hermesMergeNodes();
    for (const [sid, c] of H.ctl) if (!H.nodes.has(sid) && !c.busy) H.ctl.delete(sid);
    outboxDrain();
    if (hermesMode()) hermesAutoSelect();
    updateBridgeStatusLine();
    mark("top", "rail", "head", "strip", "panel");
    liveRowRefresh(); // a turn driven elsewhere (TUI, Telegram): the row follows the snapshot's state and steps
    renderNote(); // Send / Stop / Queue / Steer follows the session's state in every mode
  }

  function applyBridgeSessions(list) {
    if (!Array.isArray(list)) return;
    for (const r of list) if (r && r.title) H.titles.set(r.id, r.title);
    // Recent stored sessions (every surface) also get rail rows, so a fresh start does not show only what a live
    // process happens to hold. Order is Hermes' own (most recently active first).
    H.stored = new Map();
    list.forEach((r, i) => {
      if (!r || typeof r.id !== "string" || !r.id || H.deleted.has(r.id)) return;
      H.stored.set(r.id, { sid: r.id, profile: r.profile || "default", source: r.source || "", platform: r.source || "", title: r.title || "",
        name: "", parent: "", role: "", state: "idle", active: false, turnId: "", controlAvailable: false, ownerPid: null, steps: [],
        updatedAt: r.lastActive || r.startedAt || 0, terminalAt: null, stored: true, storedRank: i });
    });
    hermesMergeNodes();
    if (hermesMode()) hermesAutoSelect();
    mark("rail", "head", "strip");
  }

  /** H.nodes = the snapshot's nodes plus a row for each recent stored session the snapshot does not list. */
  function hermesMergeNodes() {
    const map = new Map();
    for (const n of H.snap) {
      // an idle snapshot row shows the stored last activity (a registry lease stamps "now" on every snapshot)
      const s = H.stored.get(n.sid);
      map.set(n.sid, s && !nodeLive(n) && s.updatedAt ? { ...n, updatedAt: s.updatedAt } : n);
    }
    for (const [sid, n] of H.stored) if (!map.has(sid) && !H.deleted.has(sid)) map.set(sid, n);
    H.nodes = map;
  }

  /**
   * Streamed text of a turn sent from here (events carry the live id; the bridge maps it back).
   * A turn is several text segments (one-liners between tool calls). Hermes stores each as its own
   * assistant message, which the history shows, so the in-flight state holds only what is not stored
   * yet: `text` is the segment still streaming, `sealed` the finished segments the history has not
   * returned yet (rendered as their own messages until it does). Never one bubble of the whole turn.
   */
  function sealLive(live) {
    if (live.text.trim()) live.sealed.push({ text: live.text, at: Date.now() });
    if (live.sealed.length > 50) live.sealed.splice(0, live.sealed.length - 50);
    live.text = "";
  }

  function applyBridgeEvent(e) {
    const sid = e.sid;
    const p = e.payload || {};
    if (!sid) return;
    // the reasoning streamed in this turn, read before message.complete drops the row's buffer: Hermes often sends
    // it as one burst right before the end, so it lives on in the finished message's Thinking block
    const turnThink = e.type === "message.complete" ? LA.think(sid) : "";
    const rowChanged = LA.event(sid, e.type, p); // the live "working" row (live-activity.js); never message text
    // an event that leaves the transcript alone may still change the row: patch it in place, not the whole column
    const rowOnly = () => { if (rowChanged && sid === H.sel) liveRowRefresh(); };
    let live = H.live.get(sid);
    const ensure = () => {
      if (!live) {
        live = { text: "", done: false, doneAt: 0, sealed: [] };
        H.live.set(sid, live);
      }
      return live;
    };
    if (e.type === "message.start") H.live.set(sid, { text: "", done: false, doneAt: 0, sealed: [] });
    else if (e.type === "message.delta") {
      if (typeof p.text !== "string") return;
      ensure().text = (live.text + p.text).slice(-200000);
    } else if (e.type === "message.interim") {
      // commentary beside tool calls: text not streamed as deltas arrives here whole
      if (typeof p.text !== "string") return;
      if (p.already_streamed !== true) ensure().text = (live.text + p.text).slice(-200000);
      if (!live) return rowOnly();
      sealLive(live);
      hermesLoadHistory(sid); // pick the stored segment up now instead of on the next poll
    } else if (e.type === "tool.generating" || e.type === "tool.start") {
      // Hermes stores the tool-call step (its thought and calls) before the tool runs: read it now, so the transcript
      // shows that step while the live row moves on to the next one (live-activity.js drops the step's reasoning)
      if (e.type === "tool.start") hermesLoadHistory(sid);
      // the text before a tool call is final: seal it so the bubble never carries the whole turn
      if (!live || !live.text.trim()) return rowOnly();
      sealLive(live);
      if (e.type !== "tool.start") hermesLoadHistory(sid);
    } else if (e.type === "message.complete") {
      ensure();
      if (typeof p.text === "string") live.text = p.text.slice(0, 200000);
      // a final answer already shown as a sealed segment (runtimes that deliver it as an interim) is not shown again
      if (live.sealed.some((s) => s.text.trim() === live.text.trim())) live.text = "";
      live.think = typeof p.reasoning === "string" && p.reasoning.trim() ? p.reasoning.slice(-20000) : turnThink;
      live.done = true;
      live.doneAt = Date.now();
      if (!live.text.trim() && !live.sealed.length) H.live.delete(sid);
      const st = H.hist.get(sid);
      if (st) st.fresh = false; // a finished turn is stored: a just-created session has history now
      hermesLoadHistory(sid);
    } else if (e.type.includes("error")) {
      H.live.delete(sid);
      if (sid === H.sel && hermesMode()) {
        S.note = i18nText("A0302");
        S.noteBad = true;
        renderNote();
      }
      hermesLoadHistory(sid);
    } else return rowOnly(); // reasoning / status / tool.complete: the row only
    if (sid === H.sel) mark("msgs");
  }

  /** What the live row shows for the selected session (or null). */
  function hermesLiveView() {
    const sid = H.sel;
    if (!sid || !hermesMode() || !bridgeOpen() || (BT && BT.isDraft(sid))) return null;
    const n = H.nodes.get(sid);
    const req = H.requests.find((r) => r.sid === sid);
    return LA.view(sid, { node: n || null, live: nodeLive(n), request: req ? req.kind : null });
  }

  /** Reasoning tokens arrive fast: one in-place update of the live row per frame (a full render when it cannot). */
  let liveRaf = 0;
  function liveRowRefresh() {
    if (liveRaf) return;
    liveRaf = requestAnimationFrame(() => {
      liveRaf = 0;
      if (hermesMode() && !LA.patch(hermesLiveView())) mark("msgs");
    });
  }

  deck.bridge.onEvent((m) => {
    switch (m.t) {
      case "status":
        if (m.status !== "open") sourceRequestsReady = false;
        applyBridgeStatus(m);
        break;
      case "snapshot":
        applyBridgeSnapshot(m.snapshot);
        break;
      case "event":
        applyBridgeEvent(m);
        break;
      case "requests":
        H.requests = Array.isArray(m.list) ? m.list : [];
        sourceRequestsReady = true;
        for (const id of H.answers.keys()) if (!H.requests.some((r) => r.id === id)) H.answers.delete(id);
        mark("rail", "msgs", "strip", true);
        break;
      case "sessions":
        applyBridgeSessions(m.list);
        break;
      default:
        break;
    }
    resumeSourceOpen();
  });
  document.addEventListener("visibilitychange", () => hermesPoll());
  deck.bridge
    .status()
    .then((st) => {
      H.platform = st.platform || "";
      applyBridgeSessions(st.sessions);
      if (st.snapshot) applyBridgeSnapshot(st.snapshot);
      H.requests = Array.isArray(st.requests) ? st.requests : [];
      sourceRequestsReady = st.status?.status === "open";
      applyBridgeStatus(st.status || { status: "off" });
      resumeSourceOpen();
    })
    .catch(() => {});

  function preserveLanguageFields() {
    // ponytail: small form scans; index descriptors if forms become large.
    const fields = [...document.querySelectorAll("input, textarea, select")];
    const signature = el => `${el.tagName}|${el.type}|${el.name}`;
    const saved = fields.filter(el => el.type !== "file" && !["s-language", "f-language"].includes(el.id)).map(el => ({
      id: el.id, signature: signature(el), index: fields.filter(other => signature(other) === signature(el)).indexOf(el),
      value: el.value, checked: el.checked,
    }));
    return () => {
      const current = [...document.querySelectorAll("input, textarea, select")];
      for (const value of saved) {
        const el = value.id ? document.getElementById(value.id) : current.filter(other => signature(other) === value.signature)[value.index];
        if (el) { el.value = value.value; if (typeof value.checked === "boolean") el.checked = value.checked; }
      }
    };
  }

  document.addEventListener("deck-language", () => {
    if (S.settings) S.settings.language = window.DeckI18n.getLanguage();
    if (languageRestore) languageRestore();
    languageRestore = preserveLanguageFields();
    const active = document.activeElement && document.activeElement.id;
    delete els.msgsInner.dataset.form;
    renderTabs();
    renderPane();
    const focused = active && document.getElementById(active);
    if (focused) focused.focus();
    mark("top", "rail", "head", "msgs", "strip", "panel", true);
    requestAnimationFrame(() => {
      if (languageRestore) languageRestore();
      if (!languageSaves) languageRestore = null;
    });
  });

  // ------------------------------------------------------------ triage services (inbox.js, fleet-capsule.js)
  /**
   * Open a session's chat for the inbox and the fleet panel, on a user action only (never a mutation). With the direct
   * connection the session opens in a Hermes mode (Sessions first); without it, a relay session opens read-only in
   * the detail view. Returns false when neither path can show it, so the caller can say so.
   */
  function openChatFor(req) {
    const sid = req && typeof req.sid === "string" ? req.sid : "";
    if (!sid || !S.settings || !S.settings.firstRunDone) return false;
    const hermesModes = chatModes().filter((m) => m !== "telegram");
    if (bridgeOpen() && hermesModes.length) {
      if (!hermesMode() || (chatMode() !== "sessions" && hermesModes.includes("sessions"))) setChatChannel(hermesModes.includes("sessions") ? "sessions" : hermesModes[0]);
      if (!hermesMode()) return false;
      SV.close();
      UD.close(false);
      SH.setMain("chat");
      if (H.nodes.has(sid)) hermesSelect(sid);
      else hermesOpen(sid, (req.profile && String(req.profile)) || "default");
      return true;
    }
    if (AG && S.relay.sessions.has(sid)) {
      SV.close();
      UD.close(false);
      SH.setMain("chat");
      AG.open(sid);
      return true;
    }
    return false;
  }
  /**
   * The composer's Stop (contracts.md, Lane B request): the same path as hermesStopNow, but it shows no note of its own
   * (composer.js shows the result) and resolves with Hermes' status. Click/Escape only; never replayed.
   */
  async function stopTurnFor(req) {
    const sid = req && typeof req.sid === "string" ? req.sid : "";
    if (!sid) throw new Error(i18nText("U0087"));
    const n = H.nodes.get(sid) || { sid, turnId: (req.turnId && String(req.turnId)) || "" };
    const turnId = (req.turnId && String(req.turnId)) || n.turnId || undefined;
    try {
      const r = await deck.bridge.interrupt(sid, { profile: req.profile || n.profile || undefined, turnId });
      if (r.status === "interrupted") LA.end(sid);
      ctlTurnGone(n, r.status);
      return { status: r.status };
    } catch (e) {
      // the bridge found no live turn to stop (U0087): the same as Hermes saying not_running
      if (cleanErr(e) === i18nText("U0087") && ctlTurnGone(n, "not_running")) return { status: "not_running" };
      throw new Error(cleanErr(e));
    } finally {
      mark("msgs", "strip", true);
    }
  }
  /** A read-only copy of what the triage views need when they start after the first pushes (no replay, no requests). */
  function triageData() {
    return {
      bridgeStatus: H.status.status,
      direct: [...H.nodes.values()],
      requests: [...H.requests],
      relay: { status: S.relay.status, sessions: [...S.relay.sessions.values()], agents: S.relay.agents, fleet: S.relay.fleet, tokens: S.relay.tokens },
    };
  }
  // ------------------------------------------------------------ end triage services

  // ---------------------------------------------------------------- boot
  registerShellTabs();
  SH.on("main", publishDesktopView);
  document.addEventListener("visibilitychange", publishDesktopView);
  new MutationObserver(publishDesktopView).observe(document.getElementById("detail"), { attributes: true, attributeFilter: ["hidden"] });
  // what later modules may use without editing this file (contracts.md, Lane A)
  SH.provide("h", h);
  SH.provide("store", store);
  SH.provide("composerActivity", composerActivity);
  SH.provide("liveThinking", { isOpen: LA.isOpen, setOpen: LA.setOpen });
  SH.provide("workspace", workspace);
  SH.provide("botscreen", botscreen);
  SH.provide("openSettings", (section) => openSettings(section));
  SH.provide("chat", () => currentChat());
  SH.provide("openChat", (req) => openChatFor(req));
  SH.provide("triageData", () => triageData());
  SH.provide("triageChanged", () => mark("top", "rail"));
  SH.provide("stopTurn", (req) => stopTurnFor(req));
  SH.provide("relaySession", (sid) => (typeof sid === "string" && S.relay.sessions.get(sid)) || null); // work-pane.js: a child's live metrics
  SH.provide("usageView", { open: () => UD.open(), close: () => UD.close(), toggle: () => UD.toggle(), isOpen: () => UD.isOpen() });
  (async () => {
    const st = await deck.ready();
    const ui = st.ui || {};
    if (deck.hosts?.requests) deck.hosts.requests().then(hosts => {
      remoteHosts = Array.isArray(hosts) ? hosts : [];
      SV.refresh();
    }).catch(() => { /* no observed watcher state: keep the saved/not-checked label */ });
    // --tab=<id> (screenshot runs) opens that tab in the right slot; the slot itself remembers its last state. Main-area
    // views (Settings, Usage) open at the end, once settings say first run is done.
    const wantTab = ui.tab && ui.tab.split(":")[0];
    const wantView = !!wantTab && (wantTab === "settings" || (SH.legacyTab(wantTab) || [])[0] === "main");
    if (wantTab && !wantView) setTab(wantTab);
    S.tab = tabIdOf(SH.right());
    pendingSelect = ui.select || null;
    applyTgStatus(st.tg || {});
    S.settings = st.settings || null;
    if (S.settings && S.settings.language !== window.DeckI18n.getLanguage()) {
      window.DeckI18n.setLanguage(S.settings.language);
      window.DeckI18n.apply(document);
      document.dispatchEvent(new Event("deck-language"));
    }
    activeChatMode = CM.start(S.settings && S.settings.chat);
    S.deskInfo = st.desktop || null; // desktop shell: build type, start-at-login support
    if (st.hostVersions) applyHostVersions(st.hostVersions); // relay / plugin versions on the host
    S.riskyExt = new Set(Array.isArray(st.riskyExt) ? st.riskyExt : []); // msgview.js: no "Open" for these
    S.avatars = st.avatars || {};
    MV.people(st.people);
    MV.setScene(ui.scene); // fixture screenshots only
    TP.setScene(ui.scene);
    AT.setScene(ui.scene);
    if (AG) AG.setScene(ui.scene);
    if (BT) BT.applyUi(ui); // Botlar: --hermes-view / --select=bot:<name> (screenshot runs)
    if (ui.hview && chatModes().includes(ui.hview)) activeChatMode = ui.hview;
    if (BT && activeChatMode !== "telegram") BT.setView(activeChatMode);
    if (BT) BT.onModeChange();
    applyWallpaper(); // the starting chat mode is known now
    S.relay.status = (st.relay && st.relay.status) || S.relay.status;
    if (LA.isOpen()) deck.bridge.reasoning(true).catch(() => {}); // "Show thinking" was on: ask for reasoning again
    if (st.dialogs) applyDialogs(st.dialogs);
    renderTabs();
    renderNote();
    mark("top", "rail", "head", "msgs", "strip", "panel", true);
    // an old stored Inspector › Usage state comes back as the Usage view, once; --tab=usage|fleet|tokens opens it too
    const oldView = SH.takeView();
    if (wantView && wantTab !== "settings") setTab(wantTab);
    else if (oldView === "usage" && !wantTab) UD.open();
    // --tab=settings[:<section>] (screenshot runs) opens the Settings view, at a section if one is named
    if (typeof ui.tab === "string" && ui.tab.split(":")[0] === "settings") openSettings(ui.tab.split(":")[1] || undefined);
    sourceOpenReady = true;
    restoreSourceOpen();
    deck.rendered();
  })();
})();
