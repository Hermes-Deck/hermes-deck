"use strict";
var i18nNode = (key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).node(key, vars, typeof document === "object" ? document : null);
var i18nBind = (el, attr, key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).bind(el, attr, key, vars);
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
var i18nLocale = typeof module === "object" && module.exports ? require("./i18n").getLocale : window.DeckI18n.getLocale;
// Botlar: the bot mode of the Hermes rail, modelled on Hermes Desktop's Bots mode (apps/desktop/src/plugins/
// hermes-bots). One row per Hermes profile: its face, its name, one line of state and a badge when it waits
// for an answer. A click opens the bot's one canonical chat, the hidden session titled "Bot Chat", in the
// chat column; the bot's other sessions stay one fold (or the Oturumlar view) away.
//
// Independent of Telegram: everything comes over the direct Hermes connection (main/bridge.js):
//   profiles.list      roster, names, Bot Mode metadata (ui_meta['hermes-bots']), the Bot Chat reference
//   profiles.get_asset the avatar picture, when the profile has one
//   session.list       {title: "Bot Chat", include_hidden}: the exact-title lookup on a click (read-only)
//   session.create     + session.title: the Bot Chat, created only when a first message is sent to a bot
//                      that has none (bridge.createBotChat; never on a click, never with a kickoff prompt)
// A host without profiles.list still gets a roster: the profiles seen in the snapshot, with generated faces.
// The pure helpers at the top (roster, names, state, avatar choice) are exported for test/bots.test.js.
(() => {
  const BOT_CHAT = "Bot Chat";
  const DRAFT = "bot:"; // H.sel of a bot whose Bot Chat does not exist yet; never sent to the host
  const VIEWS = ["sessions", "bots"];
  // bot-to-bot delivery prefix (desktop row-helpers.ts A2A_PREFIX_RE): a DM preview reads like a DM
  const A2A_PREFIX_RE = /^Message from (?:agent '[^']+'|🤖[^:]+):\s*/iu;
  const STATE_TR = { get idle() { return i18nText("U0281"); }, get thinking() { return i18nText("U0376"); }, get working() { return i18nText("U0410"); }, get searching() { return i18nText("U0562"); }, get finished() { return i18nText("common.done"); }, get error() { return i18nText("common.error"); }, get question() { return i18nText("A0257"); }, get approval() { return i18nText("A0258"); }, get ratelimit() { return i18nText("U0563"); } };

  // ---------------------------------------------------------------- pure helpers

  const titleCase = (name) => String(name || "").replace(/[-_]+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());

  /** desktop labels.ts displayName: Bot Mode title > profile display_name > "Hermes" for default > Title Cased name. */
  function displayName(bot) {
    const meta = bot.meta || {};
    if (meta.title) return meta.title;
    if (bot.displayName) return bot.displayName;
    if (String(bot.name).toLowerCase() === "default") return "Hermes";
    return titleCase(bot.name);
  }

  /** desktop data.ts botHandle: the primary profile answers to @hermes. */
  const handleOf = (name) => (String(name).toLowerCase() === "default" ? "hermes" : String(name));

  const stripA2A = (text) => String(text || "").replace(A2A_PREFIX_RE, "").trim();

  /** desktop roster-pane-derivation.ts activityOf: newest of creation (ms) and the latest of its two sessions. */
  function activityOf(bot) {
    const created = (bot.meta && bot.meta.created) || 0;
    const a = bot.canonical && bot.canonical.lastActive ? bot.canonical.lastActive : 0;
    const b = bot.last && bot.last.lastActive ? bot.last.lastActive : 0;
    return Math.max(created, Math.max(a, b) * 1000);
  }

  /**
   * profiles.list rows -> roster rows: hidden bots left out, pinned first, then by activity (a stable sort,
   * so equal rows keep Hermes's order). Order changes only with the roster poll, never with live state.
   */
  function buildRoster(profiles) {
    return (profiles || [])
      .filter((p) => p && p.name && !(p.meta && p.meta.hidden))
      .map((p) => ({ meta: {}, canonical: null, last: null, displayName: "", description: "", hasAvatar: false, ...p, title: displayName({ meta: {}, ...p }), handle: handleOf(p.name) }))
      .sort((a, b) => Number(!!b.meta.pinned) - Number(!!a.meta.pinned) || activityOf(b) - activityOf(a));
  }

  /** A host without profiles.list: the profiles seen in the snapshot, the primary one always. */
  function fallbackProfiles(nodes) {
    const names = new Set(["default"]);
    for (const n of nodes || []) if (n && n.profile) names.add(n.profile);
    return [...names].sort((a, b) => (a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b, "tr"))).map((name) => ({ name, isDefault: name === "default", meta: {}, hasAvatar: false, canonical: null, last: null }));
  }

  /**
   * One line of state from the snapshot and the open requests: waiting for an answer (an approval or question
   * routed to one of its sessions, or a session in that state), working (its newest live session's last
   * step), or idle since its last activity.
   */
  function botState(bot, { nodes = [], requests = [], chatSid = null, nodeLive = () => false } = {}) {
    const mine = nodes.filter((n) => n.profile === bot.name);
    const sids = new Set(mine.map((n) => n.sid));
    if (chatSid) sids.add(chatSid);
    const asked = requests.filter((r) => r && r.sid && sids.has(r.sid));
    const askedSids = new Set(asked.map((r) => r.sid));
    const waiting = mine.filter((n) => (n.state === "approval" || n.state === "question") && !askedSids.has(n.sid));
    const asks = asked.length + waiting.length;
    const live = mine.filter(nodeLive).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const times = [bot.canonical && bot.canonical.lastActive, bot.last && bot.last.lastActive, ...mine.map((n) => n.updatedAt)].filter((t) => typeof t === "number" && t > 0);
    const lastActive = times.length ? Math.max(...times) : null;
    const top = live[0];
    const step = top ? (top.steps && top.steps.length ? top.steps[top.steps.length - 1] : STATE_TR[top.state] || "") : "";
    if (asks) return { kind: "ask", asks, live: live.length > 0, step, lastActive };
    if (top) return { kind: "live", asks: 0, live: true, step, lastActive };
    return { kind: "idle", asks: 0, live: false, step: "", lastActive };
  }

  function stateText(st, ago) {
    if (st.kind === "ask") return st.asks === 1 ? i18nText("U0583") : i18nText("U0584", { asks: st.asks });
    if (st.kind === "live") return st.step && st.step !== i18nText("U0410") ? i18nText("U0698", { step: st.step }) : i18nText("U0410");
    return st.lastActive ? i18nText("U0699", { lastActive: ago(st.lastActive) }) : i18nText("U0281");
  }

  /**
   * Which picture a bot wears. A real picture first (Desktop shows an image before any shape), then the
   * shape and colour the user picked (ui_meta, custom), then the 160x160 raster Desktop made of its face
   * (the only copy of a look kept in Desktop's local storage), then the face generated from the name.
   */
  function avatarSpec(bot, asset, F) {
    const meta = bot.meta || {};
    const got = asset && asset.found && asset.url ? asset : null;
    if (got && !got.raster) return { kind: "photo", url: got.url };
    const picked = meta.custom && meta.imageKind !== "photo" && !F.isBlobShape(meta.shape);
    if (picked) return { kind: "face", ...F.appearance(bot.name, meta) };
    if (got) return { kind: "raster", url: got.url };
    return { kind: "face", ...F.appearance(bot.name, meta) };
  }

  /** Whether a bot's avatar picture is worth fetching (a picked vector face needs none). */
  function wantsAsset(bot, F) {
    if (!bot.hasAvatar) return false;
    const meta = bot.meta || {};
    return !(meta.custom && meta.imageKind !== "photo" && !F.isBlobShape(meta.shape));
  }

  /**
   * The avatar fetcher: run() asks for every missing avatar one at a time, never two at once. Each reply can be
   * ~1.3 MB, and Hermes queues pooled replies in a 4 MiB per-client backlog that, on overflow, closes the
   * Deck's gateway connection (failing whatever else is in flight). The host plugin also refuses a second
   * profiles.get_asset while one is in flight on a connection. A run() during a run is folded into it (one more
   * pass at the end). `cache` (name -> entry) may be cleared at any time; a reply that arrives for an entry
   * that is no longer the one it was asked for is dropped.
   * deps: roster() -> bots, wants(bot), cache (Map), fetch(name) -> Promise, open() -> bool, changed().
   */
  function avatarFetcher({ roster, wants, cache, fetch, open, changed }) {
    let running = false;
    let again = false;
    async function run() {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          for (const bot of roster()) {
            if (!open()) return;
            if (!wants(bot) || cache.has(bot.name)) continue;
            const slot = { loading: true };
            cache.set(bot.name, slot);
            let got;
            try {
              const a = await fetch(bot.name);
              got = a && a.found ? a : { found: false };
            } catch {
              got = { found: false };
            }
            if (cache.get(bot.name) === slot) cache.set(bot.name, got);
            changed();
          }
        } while (again);
      } finally {
        running = false;
      }
    }
    return run;
  }

  /** Seconds since the epoch from a cron time (ISO string, seconds or milliseconds), or null. */
  function tsOf(v) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v > 1e12 ? v / 1000 : v;
    if (typeof v === "string" && v) {
      const t = Date.parse(v);
      return Number.isFinite(t) ? t / 1000 : null;
    }
    return null;
  }

  // ---------------------------------------------------------------- the rail mode

  /**
   * d: h, svg, deck, store, mark, H (getter), bridgeOpen, hermesMode, statusText, nodeLive, ago, hm, cleanErr,
   * hermesSelect, hermesOpen, hermesRow, newSessionRow (app's "+ New session" row for a profile), reselect
   * (app's hermesAutoSelect), renderNote, fleet (relay fleet), compact (rail folded to coins).
   */
  function create(d) {
    const { h, deck, store, mark } = d;
    const F = window.DeckBotFace;
    const B = {
      view: VIEWS.includes(store.get("deck.hview")) ? store.get("deck.hview") : "sessions",
      roster: null, // projected profiles.list rows, or null before the first answer
      supported: null, // false: the host has no profiles.list, the roster comes from the snapshot
      error: null,
      loading: false,
      pollTimer: 0,
      avatars: new Map(), // name -> {found, url, raster} ({loading: true} while asked)
      chats: new Map(), // name -> {sid, loading, error, checked}
      want: store.get("deck.hbot") || null, // the bot to open in this view
      pendingOpen: false, // open `want` once the roster is known
      fold: false, // "Other sessions" under the open bot
    };
    const H = () => d.H();

    const roster = () => (B.roster ? buildRoster(B.roster) : B.supported === false ? buildRoster(fallbackProfiles([...H().nodes.values()])) : []);
    const byName = (name) => roster().find((b) => b.name === name) || null;
    const stub = (name) => buildRoster([{ name }])[0];
    const isDraft = (sid) => typeof sid === "string" && sid.startsWith(DRAFT);
    const chatSidOf = (bot) => {
      const e = B.chats.get(bot.name);
      if (e && e.checked) return e.sid || null;
      return (bot.canonical && bot.canonical.resolvedId) || null;
    };

    /** The bot whose draft or Bot Chat this session is, by name. */
    function botNameForSid(sid) {
      if (!sid) return null;
      if (isDraft(sid)) return sid.slice(DRAFT.length);
      for (const [name, e] of B.chats) if (e.sid === sid) return name;
      const hit = roster().find((b) => b.canonical && (b.canonical.resolvedId === sid || b.canonical.id === sid));
      return hit ? hit.name : null;
    }
    const owns = (sid) => !!botNameForSid(sid);
    const stateOf = (bot) => botState(bot, { nodes: [...H().nodes.values()], requests: H().requests, chatSid: chatSidOf(bot), nodeLive: d.nodeLive });

    // ------------------------------------------------------------ roster and avatars
    async function refresh() {
      if (!d.hermesMode() || B.view !== "bots" || !d.bridgeOpen() || B.loading) return;
      B.loading = true;
      try {
        B.roster = await deck.bridge.profiles();
        B.supported = true;
        B.error = null;
        fetchAvatars();
      } catch (e) {
        const m = d.cleanErr(e);
        // a host without the extension answers -32601 ("Unsupported Hermes Deck control")
        if (/Unsupported Hermes|unknown method|method not found/i.test(m)) {
          B.supported = false;
          B.error = null;
        } else B.error = m;
      } finally {
        B.loading = false;
      }
      mark("rail", "head", "strip", true);
      if (d.hermesMode() && B.view === "bots") {
        if (B.pendingOpen && (B.roster || B.supported === false)) openWanted();
        else d.reselect();
      }
    }

    function schedule() {
      clearTimeout(B.pollTimer);
      B.pollTimer = 0;
      if (!d.bridgeOpen() || B.view !== "bots" || !d.hermesMode()) return;
      // Desktop re-asks every 5 s; the Deck only needs names, faces and the Bot Chat reference from it
      const wait = B.supported === false ? 300000 : document.hidden ? 60000 : 15000;
      B.pollTimer = setTimeout(async () => {
        B.pollTimer = 0;
        await refresh();
        schedule();
      }, wait);
    }

    // one avatar at a time (see avatarFetcher): parallel ~1.3 MB replies can overflow Hermes' per-client queue
    const fetchAvatars = avatarFetcher({
      roster,
      wants: (bot) => wantsAsset(bot, F),
      cache: B.avatars,
      fetch: (name) => deck.bridge.avatar(name),
      open: () => d.bridgeOpen() && d.hermesMode() && B.view === "bots",
      changed: () => mark("rail", "head", true),
    });

    // ------------------------------------------------------------ faces
    function faceEl(bot, { size = 36, working = false } = {}) {
      const spec = avatarSpec(bot, B.avatars.get(bot.name), F);
      let inner;
      if (spec.kind === "photo") inner = h("img", { class: "bf-photo", src: spec.url, alt: "", draggable: "false" });
      else if (spec.kind === "raster") inner = h("img", { class: "bf-raster", src: spec.url, alt: "", draggable: "false" });
      else inner = F.renderFace(d.svg, F.faceModel({ shape: spec.shape, color: spec.color, working }), { size, working, label: bot.name });
      return h("span", { class: `botav ${spec.kind}${working ? " working" : ""}`, style: { "--s": `${size}px` }, "aria-hidden": "true" }, inner);
    }

    /** A short time: the clock today, the date otherwise. */
    function when(ts) {
      const day = (t) => new Date(t * 1000).toLocaleDateString("sv-SE");
      if (day(ts) === day(Date.now() / 1000)) return d.hm(ts);
      return new Date(ts * 1000).toLocaleDateString(i18nLocale(), { day: "numeric", month: "short" });
    }

    // ------------------------------------------------------------ rail
    function switcher() {
      return h(
        "span",
        { class: "seg", role: "group", "aria-label": i18nText("U0700") , "data-i18n-aria-label": "U0700"},
        ...[["sessions", i18nText("A0312")], ["bots", i18nText("A0313")]].map(([v, label]) =>
          h("button", { type: "button", "aria-pressed": B.view === v ? "true" : "false", dataset: { fk: `hview:${v}` }, onclick: () => setView(v) }, label)
        )
      );
    }

    function setView(v) {
      if (!VIEWS.includes(v) || B.view === v) return;
      B.view = v;
      store.set("deck.hview", v);
      if (v === "bots") {
        // the chat column follows the switch: the remembered bot opens unless a bot's chat already shows
        if (!owns(H().sel)) B.pendingOpen = true;
        if (B.pendingOpen && (B.roster || B.supported === false)) openWanted();
        refresh().then(schedule);
      } else {
        clearTimeout(B.pollTimer);
        B.pollTimer = 0;
      }
      mark("rail", true);
    }

    function renderRail(kids) {
      const list = roster();
      kids.push(h("div", { class: "eyebrow bots-head" }, h("span", null, i18nNode("A0313")), h("span", null, list.length ? String(list.length) : "")));
      if (!d.bridgeOpen()) kids.push(h("p", { class: "rail-note" }, d.statusText()));
      else if (B.supported === false) kids.push(h("p", { class: "rail-note" }, i18nNode("U0701")));
      else if (B.error) kids.push(h("p", { class: "rail-note bad" }, i18nNode("A0315", { error: B.error })));
      else if (!B.roster) kids.push(h("p", { class: "rail-note" }, i18nNode("U0702")));
      else if (!list.length) kids.push(h("p", { class: "rail-note" }, i18nNode("U0703")));
      for (const bot of list) {
        kids.push(botRow(bot));
        if (!d.compact() && isOpenBot(bot)) {
          // the open bot: "+ New session" (an ordinary session in its profile, beside its one Bot Chat), then
          // its other sessions behind one fold
          if (d.bridgeOpen()) kids.push(d.newSessionRow(bot.name));
          kids.push(...foldRows(bot));
        }
      }
      if (B.view === "bots" && d.bridgeOpen() && !B.pollTimer && !B.loading) schedule();
    }

    /** The bot whose chat, draft or one of whose other sessions is open. */
    function isOpenBot(bot) {
      const sel = H().sel;
      if (!sel) return false;
      if (botNameForSid(sel) === bot.name) return true;
      const n = H().nodes.get(sel);
      return !!(n && n.profile === bot.name && B.want === bot.name);
    }

    function botRow(bot) {
      const st = stateOf(bot);
      const sel = H().sel;
      const current = !!sel && botNameForSid(sel) === bot.name;
      const preview = stripA2A((bot.canonical && bot.canonical.preview) || (bot.last && bot.last.preview) || "");
      const tip = [bot.title, `@${bot.handle}`, bot.meta.description || bot.description || null, preview ? i18nText("bots.last", { preview: preview }) : null, bot.meta.pinned ? i18nText("U0704") : null].filter(Boolean).join("\n");
      const subCls = st.kind === "live" ? " live" : st.kind === "ask" ? " warn" : "";
      return h(
        "button",
        { class: `row agent bot${st.live ? " busy" : ""}`, type: "button", title: tip, "aria-current": current ? "true" : null, dataset: { fk: `bot:${bot.name}` }, onclick: () => openBot(bot.name) },
        faceEl(bot, { size: 36, working: st.live }),
        h("span", { class: "who" }, h("span", { class: "name" }, bot.title), h("span", { class: `sub${subCls}` }, stateText(st, d.ago))),
        h("span", { class: "meta" }, st.lastActive ? when(st.lastActive) : "", st.asks ? h("span", { class: "badge ask", "aria-label": i18nText("U0584", { asks: st.asks }) , "data-i18n-aria-label": "U0584", "data-i18n-aria-label-vars": JSON.stringify({ asks: st.asks })}, String(st.asks)) : null)
      );
    }

    /** The open bot's other sessions (snapshot), behind one fold. */
    function foldRows(bot) {
      const chat = chatSidOf(bot);
      const others = [...H().nodes.values()].filter((n) => n.profile === bot.name && n.sid !== chat).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (!others.length) return [];
      const open = B.fold || others.some((n) => n.sid === H().sel);
      const head = h(
        "button",
        { class: "bot-fold", type: "button", "aria-expanded": open ? "true" : "false", dataset: { fk: `botfold:${bot.name}` }, onclick: () => ((B.fold = !open), mark("rail", true)) },
        h("span", { class: "chev", "aria-hidden": "true" }, open ? "▾" : "▸"),
        i18nNode("U0705", { length: others.length })
      );
      return open ? [head, ...others.map((n) => d.hermesRow(n, 1))] : [head];
    }

    // ------------------------------------------------------------ opening a bot
    function openWanted() {
      B.pendingOpen = false;
      const list = roster();
      if (!list.length) return;
      const name = B.want && list.some((b) => b.name === B.want) ? B.want : list[0].name;
      openBot(name);
    }

    /** Called by app.js's hermesAutoSelect: in this view an empty chat column opens the remembered bot. */
    function autoSelect() {
      if (B.view !== "bots") return false;
      if (owns(H().sel)) return true;
      if (!B.roster && B.supported !== false) {
        B.pendingOpen = true; // opened when the roster arrives (refresh)
        return true;
      }
      openWanted();
      return true;
    }

    /**
     * A click on a bot: show its Bot Chat at once when the roster knows it, then confirm with the exact-title
     * lookup. A bot without one gets the "first message opens it" draft. A failed lookup is shown with a retry
     * and blocks creating one (fail closed).
     */
    function openBot(name) {
      B.want = name;
      store.set("deck.hbot", name);
      const bot = byName(name) || stub(name);
      const sid = chatSidOf(bot);
      if (sid) d.hermesOpen(sid, name);
      else d.hermesSelect(DRAFT + name);
      lookup(name);
    }

    async function lookup(name) {
      const bot = byName(name);
      const e = B.chats.get(name) || {};
      e.loading = true;
      e.error = null;
      B.chats.set(name, e);
      const from = H().sel;
      mark("msgs", "strip", true);
      try {
        const chat = await deck.bridge.botChat(name, { expect: !!(bot && bot.canonical) });
        e.sid = chat ? chat.sid : null;
        e.checked = true;
        // identity is settled either way; the chat column only follows when the user is still on this bot
        if (d.hermesMode() && B.view === "bots" && H().sel === from && B.want === name) {
          if (chat && chat.sid !== from) d.hermesOpen(chat.sid, name);
          else if (!chat && !isDraft(from)) d.hermesSelect(DRAFT + name);
        }
      } catch (err) {
        e.error = d.cleanErr(err);
      } finally {
        e.loading = false;
        mark("rail", "head", "msgs", "strip", "panel", true);
        d.renderNote();
      }
    }

    /**
     * The first message to a bot without a Bot Chat: create it now (the bridge looks it up once more and
     * fails closed), then hand its id to the normal send path.
     */
    async function materialize(sid) {
      const name = sid.slice(DRAFT.length);
      const bot = byName(name);
      const chat = await deck.bridge.botChatCreate(name, { expect: !!(bot && bot.canonical) });
      B.chats.set(name, { sid: chat.sid, checked: true, loading: false, error: null });
      if (d.hermesMode() && B.view === "bots" && H().sel === sid) d.hermesOpen(chat.sid, name, { fresh: chat.created === true });
      return { sid: chat.sid, profile: name };
    }

    // ------------------------------------------------------------ chat column, strip, right panel
    function headFor(sid) {
      const name = botNameForSid(sid);
      if (!name) return null;
      const bot = byName(name) || stub(name);
      const st = stateOf(bot);
      const n = H().nodes.get(sid);
      return { face: faceEl(bot, { size: 42, working: st.live }), title: bot.title, bits: [`@${bot.handle}`, BOT_CHAT, n && n.model, stateText(st, d.ago)].filter(Boolean) };
    }

    /** The chat column for a bot that has no Bot Chat yet (or whose lookup failed). */
    function draftView(sid) {
      const name = sid.slice(DRAFT.length);
      const bot = byName(name) || stub(name);
      const e = B.chats.get(name) || {};
      if (e.error) {
        return h("div", { class: "empty" },
          h("strong", null, i18nNode("U0706", { title: bot.title })),
          e.error,
          h("div", { class: "form-actions" }, h("button", { class: "btn", type: "button", dataset: { fk: `botretry:${name}` }, onclick: () => lookup(name) }, i18nNode("A0221"))));
      }
      if (e.loading && !e.checked) return h("div", { class: "empty" }, i18nNode("U0707"));
      return h("div", { class: "empty bot-empty" },
        faceEl(bot, { size: 64 }),
        h("strong", null, bot.title),
        i18nNode("U0708", { title: bot.title }));
    }

    /** Strip parts for a draft, or a Bot Chat outside the snapshot; null leaves the normal strip. */
    function strip(sid) {
      const name = botNameForSid(sid);
      if (!name) return null;
      const bot = byName(name) || stub(name);
      const e = B.chats.get(name) || {};
      const parts = [];
      if (e.error) {
        parts.push(h("span", { class: "bad" }, i18nNode("U0709", { error: e.error })));
        parts.push(h("button", { class: "btn small", type: "button", dataset: { fk: `botretry-strip:${name}` }, onclick: () => lookup(name) }, i18nNode("A0221")));
      }
      else if (isDraft(sid)) parts.push(h("span", { class: "quiet" }, e.loading ? i18nNode("U0707") : i18nNode("U0710")));
      else {
        const st = stateOf(bot);
        parts.push(h("span", { class: st.kind === "live" ? "now" : st.kind === "ask" ? "warn" : "quiet" }, `${BOT_CHAT} · ${stateText(st, d.ago)}`));
      }
      return parts;
    }

    /**
     * Right panel for a bot's draft, or its Bot Chat while nothing live knows it (true = handled). A Bot Chat
     * the snapshot or the relay shows keeps the normal session card, then Rutinler (app.js).
     */
    function pane(kids, sid) {
      const name = botNameForSid(sid);
      if (!name) return false;
      if (!isDraft(sid) && (H().nodes.has(sid) || d.relayHas(sid))) return false;
      const bot = byName(name) || stub(name);
      const st = stateOf(bot);
      kids.push(h("p", { class: "pane-title" }, h("b", null, bot.title), ` · @${bot.handle}`));
      const ref = bot.canonical && (bot.canonical.resolvedId === sid || bot.canonical.id === sid) ? bot.canonical : null;
      const facts = isDraft(sid)
        ? i18nText("U0711")
        : [ref && ref.messageCount ? i18nText("bots.messages", { messageCount: ref.messageCount }) : null, st.lastActive ? i18nText("A0317", { lastActive: d.ago(st.lastActive) }) : null].filter(Boolean).join(" · ") || i18nText("U0712");
      const desc = bot.meta.description || bot.description;
      kids.push(h("article", { class: "card bot-card" },
        h("header", { class: "card-head" },
          h("span", { class: `state ${st.kind === "live" ? "running" : st.kind === "ask" ? "stale" : "idle"}` }, stateText(st, d.ago)),
          h("span", { class: "model" }, BOT_CHAT)),
        desc ? h("p", { class: "ask" }, desc) : null,
        h("p", { class: "nums" }, facts)));
      routines(kids, sid);
      return true;
    }

    /** Rutinler: the bot's cron jobs, read-only, from the relay's fleet snapshot (no Telegram needed). */
    function routines(kids, sid) {
      const name = botNameForSid(sid);
      if (!name) return;
      kids.push(h("h2", { class: "section-h" }, i18nNode("A0319")));
      const fleet = d.fleet();
      const p = fleet && fleet.profiles ? fleet.profiles[name] : null;
      if (!p) {
        kids.push(h("p", { class: "muted small" }, fleet ? i18nNode("U0713") : i18nNode("U0714")));
        return;
      }
      const jobs = Array.isArray(p.cron) ? p.cron : [];
      if (!jobs.length) kids.push(h("p", { class: "muted small" }, i18nNode("A0320")));
      for (const j of jobs.slice(0, 50)) kids.push(routineCard(j));
      if (jobs.length) kids.push(h("p", { class: "muted small" }, i18nNode("U0715")));
    }

    function routineCard(j) {
      const paused = j.enabled === false || !!j.paused_at || j.state === "paused";
      const failing = !paused && (j.failure_streak || 0) > 0;
      const next = tsOf(j.next_run_at);
      const last = tsOf(j.last_run_at);
      const bits = [last ? i18nText("U0716", { last: d.ago(last) }) : i18nText("U0717"), j.last_status ? String(j.last_status) : null, failing ? i18nText("U0718", { failure_streak: j.failure_streak }) : null].filter(Boolean);
      return h("article", { class: "card routine" },
        h("header", { class: "card-head" },
          h("span", { class: `state ${paused ? "idle" : failing ? "failed" : "done"}` }, paused ? i18nNode("U0719") : failing ? i18nNode("common.error") : i18nNode("common.active")),
          h("span", { class: "model" }, String(j.schedule_display || "")),
          h("span", { class: "when" }, next && !paused ? i18nNode("U0720", { next: when(next) }) : "")),
        h("p", { class: "ask" }, String(j.name || j.id || "rutin")),
        h("p", { class: "nums" }, bits.join(" · ")),
        j.last_error ? h("p", { class: "nums err" }, String(j.last_error)) : null);
    }

    // ------------------------------------------------------------ lifecycle
    function onStatus(status, was) {
      if (status === "open" && was !== "open") {
        B.avatars.clear(); // pictures may have changed while away
        if (B.view === "bots") refresh().then(schedule);
      } else if (status !== "open") {
        clearTimeout(B.pollTimer);
        B.pollTimer = 0;
      }
    }

    /** Screenshot runs: --hermes-view=bots|sessions and --select=bot:<name>. */
    function applyUi(ui) {
      const u = ui || {};
      if (typeof u.select === "string" && u.select.startsWith(DRAFT)) {
        B.want = u.select.slice(DRAFT.length);
        store.set("deck.hbot", B.want);
      }
      if (VIEWS.includes(u.hview)) setView(u.hview);
    }

    document.addEventListener("visibilitychange", () => B.view === "bots" && schedule());

    return {
      view: () => B.view,
      setView,
      onModeChange: () => {
        if (d.hermesMode() && B.view === "bots") { autoSelect(); refresh().then(schedule); }
        else schedule();
      },
      switcher,
      renderRail,
      autoSelect,
      owns,
      isDraft,
      materialize,
      headFor,
      draftView,
      strip,
      pane,
      routines,
      onStatus,
      applyUi,
    };
  }

  const api = { create, BOT_CHAT, DRAFT, displayName, handleOf, stripA2A, activityOf, buildRoster, fallbackProfiles, botState, stateText, avatarSpec, wantsAsset, avatarFetcher, tsOf };
  if (typeof window !== "undefined") window.DeckBots = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
