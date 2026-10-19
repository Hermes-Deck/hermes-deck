"use strict";
var i18nNode = (key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).node(key, vars, typeof document === "object" ? document : null);
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
var i18nLocale = typeof module === "object" && module.exports ? require("./i18n").getLocale : window.DeckI18n.getLocale;
// Group Chat: Bot Mode rooms the Hermes gateway hosts (tui_gateway/methods_groups.py), shown in the Bots view.
// A room is 2-6 bots and the owner in one transcript; the gateway drives the members' turns itself, so a room keeps
// running while the Deck is closed and is the same room Hermes Desktop shows.
//
// Wire (main/group-rpc.js, through deck.bridge.groups.*): groups.capabilities once per connection (no hosted driver:
// no group surface at all), groups.list for the rows, groups.log (a cursor over the room's durable log) and
// groups.state (driver status: working, approvals waiting) for the open room, groups.create / send / rename / stop /
// approve / retry / disband on a click or a send. Rooms have no live push: the open room polls its log and state,
// and the transcript, the one live row at its end and the Stop button all follow that same poll.
//
// Selection: the chat column shows a room when the Hermes selection is "room:<id>" ("room:new" is the create form).
// Those ids never reach Hermes as session ids: bots.js treats them as its own (owns / isDraft) and hands the column,
// header, strip and right panel to this module. The pure helpers at the top are exported for test/group-chat.test.js.
(() => {
  const ROOM = "room:";
  const NEW = "room:new";
  const MAIN = "main"; // the thread every Deck message goes to (main/group-rpc.js MAIN_THREAD)
  const MIN = 2;
  const MAX = 6;
  const PAGE = 200; // log events per read
  const KEEP = 2000; // log events kept per room in memory (older pages load again on demand)
  const ROUNDS = 3; // hosted_room_discussion.MAX_DISCUSSION_ROUNDS
  const MESSAGES = 10; // hosted_room_discussion.MAX_DISCUSSION_MESSAGES
  const STALE = 120; // s: a pending message the driver is not working on stops counting as "working"
  const CHOICES = ["once", "session", "always", "deny"];
  const TERMINAL = new Set(["turn.settled", "turn.failed", "turn.cancelled", "turn.deferred"]);

  // ---------------------------------------------------------------- pure helpers

  const isRoomSel = (sid) => typeof sid === "string" && sid.startsWith(ROOM);
  const roomIdOf = (sid) => (isRoomSel(sid) && sid !== NEW ? sid.slice(ROOM.length) : null);
  const selOf = (id) => ROOM + id;
  const oneLine = (v, max = 140) => {
    const s = String(v || "").replace(/\s+/g, " ").trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  };

  /** Two log pages -> one list in seq order, no repeats, at most KEEP (the newest). */
  function mergeEvents(have, more) {
    const by = new Map();
    for (const e of have || []) if (e && Number.isInteger(e.seq)) by.set(e.seq, e);
    for (const e of more || []) if (e && Number.isInteger(e.seq)) by.set(e.seq, e);
    const out = [...by.values()].sort((a, b) => a.seq - b.seq);
    return out.length > KEEP ? out.slice(out.length - KEEP) : out;
  }

  const MENTION_RE = /@([A-Za-z0-9][A-Za-z0-9._:-]*)/g;

  /** hosted_room_discussion.resolve_mentions: the members a text addresses (@all / @everyone, or nobody: all). */
  function addressed(text, members, defaultAll = true) {
    const by = new Map(members.map((m) => [String(m.handle).toLowerCase(), m]));
    const hit = new Set();
    let everyone = false;
    for (const m of String(text || "").matchAll(MENTION_RE)) {
      const handle = m[1].toLowerCase();
      if (handle === "all" || handle === "everyone") everyone = true;
      else if (by.has(handle)) hit.add(handle);
    }
    if (everyone || (defaultAll && !hit.size)) return members.slice();
    return members.filter((m) => hit.has(String(m.handle).toLowerCase()));
  }

  /** Whether a member's message hands something to the owner (@user, the gateway's human handoff). */
  const mentionsUser = (text) => /(^|[^A-Za-z0-9_.@-])@user(?![A-Za-z0-9_-])/i.test(String(text || ""));

  /** hosted_room_discussion._pending_discussion: the oldest thread's latest user message not settled and not stopped. */
  function pendingDiscussion(events) {
    const list = events || [];
    let stopped = 0;
    const done = new Set();
    const latest = new Map();
    for (const e of list) {
      if (e.kind === "room.stop_requested") stopped = Math.max(stopped, e.seq);
      else if (e.kind === "room.activity" && (e.status === "settled" || e.status === "bounded") && e.discussion) done.add(e.discussion);
      else if (e.kind === "message.user") latest.set(e.thread || MAIN, e);
    }
    return [...latest.values()].sort((a, b) => a.seq - b.seq).find((e) => e.seq > stopped && !done.has(e.id)) || null;
  }

  const rotate = (list, round) => {
    const shift = list.length ? round % list.length : 0;
    return [...list.slice(shift), ...list.slice(0, shift)];
  };

  /** hosted_room_discussion._unaddressed_member_mentions: peers a bot cited and that have not spoken since. */
  function cited(messages, members) {
    const citedAt = new Map();
    const lastPost = new Map();
    for (const e of messages) {
      if (e.kind !== "message.member") continue;
      lastPost.set(e.member, e.seq);
      for (const m of addressed(e.text, members, false)) if (m.id !== e.member) citedAt.set(m.id, e.seq);
    }
    return members.filter((m) => citedAt.has(m.id) && (lastPost.get(m.id) || 0) <= citedAt.get(m.id));
  }

  /**
   * The member whose turn the gateway runs next, replayed from the log the way hosted_room_discussion.plan_next_task
   * picks it: round 0 = the members the owner's message addresses (nobody named: everyone), later rounds = peers a
   * bot cited; members rotate by round; a member with a terminal event for (round, this message) is done. null when
   * nothing is pending or the discussion is over.
   */
  function nextSpeaker(room, events) {
    const members = (room && room.members) || [];
    const d = pendingDiscussion(events);
    if (!d || !members.length) return null;
    const thread = d.thread || MAIN;
    const since = (events || []).filter((e) => e.seq >= d.seq && (e.thread || MAIN) === thread && (e.kind === "message.user" || e.kind === "message.member"));
    const own = since.filter((e) => e.kind === "message.member" && e.discussion === d.id);
    if (own.length >= MESSAGES) return null;
    const ended = new Set((events || []).filter((e) => TERMINAL.has(e.kind) && e.discussion === d.id).map((e) => `${e.round}:${e.member}`));
    for (let round = 0; round < ROUNDS; round++) {
      const responders = round === 0 ? addressed(d.text, members) : cited(since, members);
      for (const m of rotate(responders, round)) if (!ended.has(`${round}:${m.id}`)) return m;
      if (!own.some((e) => e.round === round)) return null;
    }
    return null;
  }

  /**
   * What the room is doing now, from the same log page and state the transcript shows: {working, speaker, waiting}.
   * An approval waits on its member; a pending message whose driver has been idle for a while is not shown as work.
   */
  function liveState(room, events, state, now = Date.now() / 1000) {
    const members = (room && room.members) || [];
    const ask = state && state.approvals && state.approvals[0];
    if (ask) return { working: true, waiting: true, speaker: members.find((m) => m.id === ask.memberId) || null };
    const d = pendingDiscussion(events);
    const driver = !!(state && state.working);
    if (!d && !driver) return { working: false, waiting: false, speaker: null };
    if (d && state && !driver && !state.blocked && d.at && now - d.at > STALE) return { working: false, waiting: false, speaker: null };
    return { working: true, waiting: false, speaker: d ? nextSpeaker(room, events) : null };
  }

  /**
   * Log events -> transcript items in arrival order: the owner's messages, members' messages and a few notes
   * (a failed turn, a rename, a stop). Messages from another thread (a reply in thread made elsewhere) stay in place,
   * marked `thread`.
   */
  function transcript(events) {
    const out = [];
    for (const e of events || []) {
      const thread = !!e.thread && e.thread !== MAIN;
      if (e.kind === "message.user") out.push({ type: "user", seq: e.seq, at: e.at, text: e.text || "", thread });
      else if (e.kind === "message.member") {
        const a = e.actor || {};
        out.push({ type: "member", seq: e.seq, at: e.at, text: e.text || "", member: e.member || a.id || "", profile: a.profile || "", name: a.name || "", thread });
      } else if (e.kind === "turn.failed") out.push({ type: "note", note: "failed", seq: e.seq, at: e.at, member: e.member || "", error: e.error || "" });
      else if (e.kind === "room.renamed" && e.name) out.push({ type: "note", note: "renamed", seq: e.seq, at: e.at, name: e.name });
      else if (e.kind === "room.stop_requested") out.push({ type: "note", note: "stopped", seq: e.seq, at: e.at });
    }
    return out;
  }

  /** A room row's summary: the latest message, unread member messages after `seen`, and whether one asks for the owner. */
  function rowSummary(events, seen = 0) {
    let last = null;
    let unread = 0;
    let needsYou = false;
    for (const e of events || []) {
      if (e.kind !== "message.user" && e.kind !== "message.member") continue;
      last = e;
      if (e.kind === "message.member" && e.seq > seen) {
        unread++;
        if (mentionsUser(e.text)) needsYou = true;
      }
    }
    // the owner's own message after them answers what came before it
    if (last && last.kind === "message.user") {
      unread = 0;
      needsYou = false;
    }
    return { last, unread, needsYou, at: last ? last.at : null };
  }

  /** The composer's "@" list in a room: every member by handle, then @all. */
  function mentionItems(room, titleOf = (m) => m.name || m.handle) {
    const items = ((room && room.members) || []).map((m) => ({ insert: `@${m.handle}`, label: titleOf(m), detail: `@${m.handle}`, keys: [m.profile || "", m.name || ""] }));
    items.push({ insert: "@all", label: "@all", detail: i18nText("groups.allDetail"), keys: ["everyone"] });
    return items;
  }

  /** The create form's choice is complete: a name and 2-6 bots. */
  const canCreate = (name, picked) => !!String(name || "").trim() && picked >= MIN && picked <= MAX;

  /** Room rows: newest change first (the gateway's own order), by latest message time when known. */
  function sortRooms(rooms, atOf = () => null) {
    return [...(rooms || [])].sort((a, b) => (atOf(b) || b.updatedAt || 0) - (atOf(a) || a.updatedAt || 0) || String(a.name).localeCompare(String(b.name)));
  }

  /** The approval buttons a card shows, in a fixed order, from what the gateway offers. */
  const choicesOf = (approval) => CHOICES.filter((c) => ((approval && approval.choices) || []).includes(c));

  // ---------------------------------------------------------------- the view

  /**
   * d: h, deck, store, mark, hm, cleanErr, bridgeOpen, hermesMode, H (getter), hermesSelect, leave() (clear the selection), renderNote, note(text, bad),
   * bots() (bots.js instance: face, title, list), menu(items, anchor, pos, label), toast(text, bad).
   */
  function create(d) {
    const { h, deck, store, mark } = d;
    const api = () => deck.bridge.groups;
    const loadSeen = () => {
      try {
        const v = JSON.parse(store.get("deck.groups.seen") || "{}");
        return v && typeof v === "object" ? v : {};
      } catch {
        return {};
      }
    };
    const G = {
      supported: null, // groups.capabilities: true / false once asked on this connection
      asking: false,
      rooms: new Map(), // id -> projected room
      listed: false,
      listError: null,
      listing: false,
      logs: new Map(), // id -> {events, cursor, first, loaded, busy, error, latestSeq}
      states: new Map(), // id -> projected state
      seen: loadSeen(), // id -> last seq the owner saw
      form: null, // the create form: {name, picked: Set, busy, error}
      renaming: null, // room id whose title is an input
      sending: false,
      stopping: false,
      answering: new Set(), // approval request ids in flight
      timer: 0,
    };
    const H = () => d.H();
    const B = () => d.bots();
    const openId = () => roomIdOf(H().sel);
    const roomOf = (id) => G.rooms.get(id) || null;
    const logOf = (id) => {
      let L = G.logs.get(id);
      if (!L) G.logs.set(id, (L = { events: [], cursor: 0, first: 1, loaded: false, busy: false, error: null, latestSeq: 0 }));
      return L;
    };
    const titleOf = (m) => {
      const b = B();
      return (m && m.profile && b && b.known(m.profile) ? b.title(m.profile) : "") || (m && m.name) || (m && m.handle) || "";
    };
    const memberOf = (room, id) => ((room && room.members) || []).find((m) => m.id === id) || null;
    const nameOfEvent = (room, it) => titleOf(memberOf(room, it.member) || { profile: it.profile, name: it.name, handle: it.member });
    const face = (profile, size) => {
      const b = B();
      return b && profile ? b.face(profile, { size }) : h("span", { class: "botav", style: { "--s": `${size}px` }, "aria-hidden": "true" });
    };
    const visible = () => typeof document === "object" && !document.hidden;

    // ------------------------------------------------------------ capability gate and the room list
    function reset() {
      G.supported = null;
      G.rooms.clear();
      G.logs.clear();
      G.states.clear();
      G.listed = false;
      G.listError = null;
      clearTimeout(G.timer);
      G.timer = 0;
    }

    async function capabilities() {
      if (G.supported !== null || G.asking || !d.bridgeOpen()) return G.supported === true;
      G.asking = true;
      try {
        const r = await api().capabilities();
        G.supported = !!(r && r.supported);
      } catch {
        G.supported = false; // an older host plugin or gateway: no group surface, nothing else changes
      } finally {
        G.asking = false;
      }
      if (G.supported) mark("rail", true);
      return G.supported;
    }

    /** The rows: groups.list, then each changed room's newest log page (preview, unread, needs you). */
    async function refresh() {
      if (!d.hermesMode() || !d.bridgeOpen() || G.listing) return;
      if (!(await capabilities())) return;
      G.listing = true;
      try {
        const rooms = await api().list();
        const ids = new Set(rooms.map((r) => r.id));
        for (const id of [...G.rooms.keys()]) if (!ids.has(id)) forget(id, false);
        for (const r of rooms) G.rooms.set(r.id, r);
        G.listed = true;
        G.listError = null;
        for (const r of rooms.slice(0, 30)) {
          const L = logOf(r.id);
          if (r.id === openId() || (L.loaded && L.latestSeq >= r.latestSeq)) continue;
          await pull(r.id);
          if (pendingDiscussion(L.events)) await readState(r.id); // an approval waiting is "needs you" on the row
          else G.states.delete(r.id);
        }
      } catch (e) {
        G.listError = d.cleanErr(e);
      } finally {
        G.listing = false;
      }
      mark("rail", true);
    }

    /** Read a room's log forward from its cursor (the first read starts at the newest page). */
    async function pull(id) {
      const L = logOf(id);
      if (L.busy) return false;
      L.busy = true;
      let changed = false;
      try {
        if (!L.loaded) {
          const room = roomOf(id);
          const latest = room ? room.latestSeq : 0;
          L.cursor = Math.max(0, latest - PAGE);
          L.first = L.cursor + 1;
        }
        for (let i = 0; i < 5; i++) {
          const page = await api().log(id, L.cursor, PAGE);
          if (page.events.length) {
            L.events = mergeEvents(L.events, page.events);
            changed = true;
          }
          L.cursor = Math.max(L.cursor, page.cursor);
          L.latestSeq = page.latestSeq;
          if (!page.hasMore) break;
        }
        if (L.events.length && L.events[0].seq > L.first) L.first = L.events[0].seq;
        L.loaded = true;
        L.error = null;
      } catch (e) {
        const m = d.cleanErr(e);
        if (/not found/i.test(m)) forget(id, true);
        else if (/ahead of the hosted room log/i.test(m)) Object.assign(L, { events: [], cursor: 0, first: 1, loaded: false }); // read again from the start
        else L.error = m;
        changed = true;
      } finally {
        L.busy = false;
      }
      return changed;
    }

    /** One earlier page above the oldest message shown. */
    async function older(id) {
      const L = logOf(id);
      if (L.busy || L.first <= 1) return;
      L.busy = true;
      mark("msgs", true);
      try {
        const since = Math.max(0, L.first - 1 - PAGE);
        const page = await api().log(id, since, L.first - 1 - since);
        L.events = mergeEvents(page.events, L.events);
        L.first = since + 1;
      } catch (e) {
        L.error = d.cleanErr(e);
      } finally {
        L.busy = false;
      }
      mark("msgs", true);
    }

    async function readState(id) {
      try {
        const st = await api().state(id);
        G.states.set(id, st);
        if (st.room) G.rooms.set(id, { ...(roomOf(id) || {}), ...st.room });
      } catch (e) {
        if (/not found/i.test(d.cleanErr(e))) forget(id, true);
      }
    }

    /** A room that is gone (disbanded here or elsewhere) leaves every map; an open one leaves the chat column. */
    function forget(id, render = true) {
      G.rooms.delete(id);
      G.logs.delete(id);
      G.states.delete(id);
      if (G.seen[id] !== undefined) {
        delete G.seen[id];
        saveSeen();
      }
      if (openId() === id) {
        clearTimeout(G.timer);
        G.timer = 0;
        d.leave();
      }
      if (render) mark("rail", "head", "msgs", "strip", "panel", true);
    }

    function saveSeen() {
      const keep = {};
      for (const [k, v] of Object.entries(G.seen)) if (G.rooms.has(k) || !G.listed) keep[k] = v;
      G.seen = keep;
      store.set("deck.groups.seen", JSON.stringify(keep));
    }

    function markSeen(id) {
      const L = G.logs.get(id);
      if (!L || !L.events.length || !visible()) return;
      const top = L.events[L.events.length - 1].seq;
      if ((G.seen[id] || 0) >= top) return;
      G.seen[id] = top;
      saveSeen();
    }

    // ------------------------------------------------------------ the open room: one poll drives everything on screen
    function live(id) {
      return liveState(roomOf(id), (G.logs.get(id) || {}).events, G.states.get(id));
    }

    function schedule() {
      clearTimeout(G.timer);
      G.timer = 0;
      const id = openId();
      if (!id || !d.bridgeOpen() || !d.hermesMode() || !G.supported) return;
      const wait = !visible() ? 30000 : live(id).working || G.sending ? 1500 : 5000;
      G.timer = setTimeout(tick, wait);
    }

    async function tick() {
      G.timer = 0;
      const id = openId();
      if (!id || !d.bridgeOpen() || !d.hermesMode()) return;
      if (G.supported === null) await capabilities();
      if (!roomOf(id)) await readState(id); // after a reconnect: the room row (and its newest seq) before the first read
      if (!roomOf(id)) {
        if (openId() === id) mark("msgs", true);
        schedule();
        return;
      }
      await pull(id);
      if (openId() === id && G.rooms.has(id)) await readState(id);
      if (openId() === id) {
        markSeen(id);
        mark("msgs", "rail", "strip", true);
        d.renderNote(); // Stop follows the same read as the live row
      }
      schedule();
    }

    function openRoom(id) {
      G.renaming = null;
      d.hermesSelect(selOf(id));
      const L = logOf(id);
      if (!L.loaded) mark("msgs", true);
      tick();
    }

    function openNew() {
      G.form = { name: "", picked: new Set(), busy: false, error: null };
      d.hermesSelect(NEW);
    }

    /** bots.js / app.js call this when the selection changes or the connection comes back. */
    function onSelect() {
      if (openId()) schedule();
      else {
        clearTimeout(G.timer);
        G.timer = 0;
      }
    }

    // ------------------------------------------------------------ rail rows
    function when(ts) {
      if (!ts) return "";
      const day = (t) => new Date(t * 1000).toLocaleDateString("sv-SE");
      if (day(ts) === day(Date.now() / 1000)) return d.hm(ts);
      return new Date(ts * 1000).toLocaleDateString(i18nLocale(), { day: "numeric", month: "short" });
    }

    /** The room's glyph: its first two members' faces, overlapped. */
    function glyph(room, size = 36) {
      const ms = ((room && room.members) || []).slice(0, 2);
      const inner = Math.round(size * 0.68);
      return h("span", { class: "grp-glyph", style: { "--s": `${size}px` }, "aria-hidden": "true" }, ...ms.map((m) => face(m.profile, inner)));
    }

    function railRows(kids) {
      if (!G.supported || !d.bridgeOpen()) return;
      const sel = H().sel;
      kids.push(h("div", { class: "eyebrow bots-head groups-head" },
        h("span", null, i18nNode("groups.section")),
        h("button", { class: "groups-new", type: "button", title: i18nText("groups.new"), "aria-label": i18nText("groups.new"), "data-i18n-title": "groups.new", "data-i18n-aria-label": "groups.new", "aria-current": sel === NEW ? "true" : null, dataset: { fk: "groups-new" }, onclick: openNew }, "+")));
      if (G.listError) kids.push(h("p", { class: "rail-note bad" }, i18nNode("groups.listFailed", { error: G.listError })));
      const atOf = (r) => rowSummary((G.logs.get(r.id) || {}).events, 0).at;
      for (const room of sortRooms([...G.rooms.values()], atOf)) kids.push(roomRow(room));
    }

    function roomRow(room) {
      const L = G.logs.get(room.id) || { events: [] };
      const st = G.states.get(room.id);
      const sum = rowSummary(L.events, G.seen[room.id] || 0);
      const asks = st && st.approvals ? st.approvals.length : 0;
      const needs = asks > 0 || sum.needsYou;
      const current = H().sel === selOf(room.id);
      const lv = live(room.id);
      let sub;
      if (sum.last) {
        const text = oneLine(sum.last.text, 120);
        sub = sum.last.kind === "message.user" ? i18nText("groups.previewYou", { text }) : i18nText("groups.previewMember", { name: nameOfEvent(room, { member: sum.last.member, profile: sum.last.actor && sum.last.actor.profile, name: sum.last.actor && sum.last.actor.name }), text });
      } else sub = i18nText("groups.memberCount", { n: room.members.length });
      const unread = current ? 0 : sum.unread;
      const tip = [room.name, room.members.map(titleOf).join(", "), needs ? i18nText("groups.needsYou") : null].filter(Boolean).join("\n");
      return h(
        "button",
        { class: `row agent bot group${lv.working ? " busy" : ""}`, type: "button", title: tip, "aria-current": current ? "true" : null, dataset: { fk: `room:${room.id}` },
          onclick: () => openRoom(room.id),
          oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); roomMenu(room, e.currentTarget, e.clientX === 0 && e.clientY === 0 ? null : { x: e.clientX, y: e.clientY }); } },
        glyph(room, 36),
        h("span", { class: "who" }, h("span", { class: "name" }, room.name), h("span", { class: `sub${needs ? " warn" : ""}` }, sub)),
        h("span", { class: "meta" }, when(sum.at || room.updatedAt),
          needs ? h("span", { class: "badge ask", title: i18nText("groups.needsYou"), "aria-label": i18nText("groups.needsYou") }, asks ? String(asks) : "@")
            : unread ? h("span", { class: "badge", "aria-label": i18nText("groups.unread", { n: unread }) }, String(unread)) : null)
      );
    }

    // ------------------------------------------------------------ menu, rename, disband
    function roomMenu(room, anchor, pos) {
      if (!d.menu) return;
      d.menu([
        { label: i18nText("groups.rename"), run: () => startRename(room.id) },
        { label: i18nText("groups.disband"), danger: true, noReturn: true, run: () => confirmDisband(room) },
      ], anchor, pos, room.name);
    }

    function startRename(id) {
      if (H().sel !== selOf(id)) openRoom(id);
      G.renaming = id;
      mark("head", true);
      setTimeout(() => {
        const box = document.querySelector(".grp-rename input");
        if (box) {
          box.focus();
          box.select();
        }
      }, 0);
    }

    async function saveRename(id, value) {
      const name = String(value || "").trim();
      const room = roomOf(id);
      if (!room || !name || name === room.name) {
        G.renaming = null;
        mark("head", true);
        return;
      }
      try {
        const r = await api().rename(id, name);
        G.rooms.set(id, { ...room, ...(r || {}), name: (r && r.name) || name });
        G.renaming = null;
        await pull(id);
      } catch (e) {
        d.note(i18nText("groups.renameFailed", { error: d.cleanErr(e) }), true);
      }
      mark("head", "rail", "msgs", true);
    }

    function confirmDisband(room) {
      const back = document.activeElement;
      const err = h("p", { class: "form-error", role: "alert" });
      const ok = h("button", { class: "btn danger", type: "button", dataset: { fk: "groups-disband-ok" } }, i18nNode("groups.disbandOk"));
      const cancel = h("button", { class: "btn", type: "button" }, i18nNode("U0451"));
      const box = h("div", { class: "cd", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "gdb-title", "aria-describedby": "gdb-body" },
        h("h2", { id: "gdb-title" }, i18nNode("groups.disbandTitle")),
        h("p", { id: "gdb-body" }, h("strong", null, room.name), i18nNode("groups.disbandBody")),
        err,
        h("div", { class: "form-actions" }, cancel, ok));
      const root = h("div", { class: "cd-back" }, box);
      const close = () => {
        root.remove();
        if (back && back.isConnected) back.focus();
      };
      cancel.addEventListener("click", close);
      root.addEventListener("click", (e) => { if (e.target === root && !ok.disabled) close(); });
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
        ok.textContent = i18nText("groups.disbandBusy");
        err.textContent = "";
        try {
          await api().disband(room.id);
          root.remove();
          forget(room.id, true);
          if (d.toast) d.toast(i18nText("groups.disbanded"));
        } catch (e) {
          err.textContent = d.cleanErr(e);
          ok.disabled = cancel.disabled = false;
          ok.textContent = i18nText("groups.disbandOk");
        }
      });
      document.body.appendChild(root);
      cancel.focus(); // the safe answer holds the focus
    }

    // ------------------------------------------------------------ chat column
    function head(sid) {
      if (sid === NEW) return [h("div", { class: "head-main" }, h("div", { class: "title" }, i18nNode("groups.new")))];
      const id = roomIdOf(sid);
      const room = roomOf(id);
      if (!room) return [h("div", { class: "head-main" }, h("div", { class: "title" }, i18nNode("groups.loading")))];
      const menuBtn = h("button", { class: "ib grp-menu", type: "button", title: i18nText("groups.menu"), "aria-label": i18nText("groups.menu"), "aria-haspopup": "menu", dataset: { fk: "groups-menu" }, onclick: (e) => roomMenu(room, e.currentTarget, null) }, "⋯");
      let title;
      if (G.renaming === id) {
        const input = h("input", { class: "input", type: "text", value: room.name, maxlength: "200", "aria-label": i18nText("groups.nameLabel") });
        const save = () => saveRename(id, input.value);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            G.renaming = null;
            mark("head", true);
          }
        });
        title = h("div", { class: "grp-rename", "data-hold": "1" }, input, h("button", { class: "btn small", type: "button", onclick: save }, i18nNode("groups.renameSave")));
      } else title = h("div", { class: "title" }, room.name);
      return [glyph(room, 42), h("div", { class: "head-main" }, title, h("div", { class: "subline" }, room.members.map(titleOf).join(" · "))), menuBtn];
    }

    function textEl(text, markdown) {
      const md = typeof window === "object" ? window.DeckMarkdown : null;
      if (markdown && md && String(text).trim()) {
        const el = h("div", { class: "text md" });
        el.appendChild(md.render(text));
        return el;
      }
      return h("div", { class: "text" }, text);
    }

    const stamp = (at) => (at ? h("time", { class: "t", title: new Date(at * 1000).toLocaleString(i18nLocale()) }, when(at)) : null);

    function itemEl(room, it) {
      if (it.type === "user") return h("div", { class: "msg out", dataset: { seq: String(it.seq) } }, textEl(it.text, false), it.thread ? h("span", { class: "grp-thread" }, i18nNode("groups.thread")) : null, stamp(it.at));
      if (it.type === "member") {
        const m = memberOf(room, it.member);
        return h("div", { class: "msg-row grp-row", dataset: { seq: String(it.seq) } },
          face((m && m.profile) || it.profile, 30),
          h("div", { class: "msg" },
            h("div", { class: "who" }, h("span", { class: "who-name" }, nameOfEvent(room, it)), it.thread ? h("span", { class: "grp-thread" }, i18nNode("groups.thread")) : null),
            textEl(it.text, true),
            stamp(it.at)));
      }
      const text = it.note === "failed" ? i18nText("groups.failed", { name: nameOfEvent(room, it), error: it.error || "—" })
        : it.note === "renamed" ? i18nText("groups.renamed", { name: it.name }) : i18nText("groups.stopped");
      return h("div", { class: `msg sysmsg grp-note${it.note === "failed" ? " bad" : ""}` }, h("span", null, text), stamp(it.at));
    }

    function approvalCard(room, id, a) {
      const m = memberOf(room, a.memberId);
      const busy = G.answering.has(a.requestId);
      return h("div", { class: "card grp-ask", role: "group", "aria-label": i18nText("groups.approvalTitle", { name: titleOf(m) || a.memberId }) },
        h("div", { class: "grp-ask-head" }, face(m && m.profile, 22), h("strong", null, i18nText("groups.approvalTitle", { name: titleOf(m) || a.memberId }))),
        a.description ? h("p", { class: "grp-ask-desc" }, a.description) : null,
        a.command ? h("pre", { class: "grp-ask-cmd" }, a.command) : null,
        h("div", { class: "form-actions" }, ...choicesOf(a).map((c) =>
          h("button", { class: `btn small${c === "deny" ? " danger" : ""}`, type: "button", disabled: busy, dataset: { fk: `groups-approve:${c}` }, onclick: () => approve(id, a, c) }, i18nNode(`groups.choice.${c}`)))));
    }

    function retryCard(id, r) {
      return h("div", { class: "card grp-ask" }, h("p", { class: "grp-ask-desc" }, i18nNode("groups.retryTitle")),
        h("div", { class: "form-actions" }, h("button", { class: "btn small", type: "button", onclick: () => retry(id, r.taskId) }, i18nNode("groups.retry"))));
    }

    /** The chat column for a room (or the create form): one fragment, newest at the bottom. */
    function view(sid) {
      const frag = document.createDocumentFragment();
      if (sid === NEW) {
        frag.appendChild(createForm());
        return frag;
      }
      const id = roomIdOf(sid);
      const room = roomOf(id);
      const L = G.logs.get(id);
      if (!room || !L || !L.loaded) {
        frag.appendChild(h("div", { class: "empty" }, L && L.error ? i18nNode("groups.loadFailed", { error: L.error }) : i18nNode("groups.loading")));
        return frag;
      }
      if (L.first > 1) frag.appendChild(h("div", { class: "older" }, h("button", { class: "linkbtn", type: "button", disabled: L.busy, onclick: () => older(id) }, i18nNode("groups.loadEarlier"))));
      const items = transcript(L.events);
      if (!items.length) frag.appendChild(h("div", { class: "empty" }, i18nNode("groups.empty")));
      for (const it of items) frag.appendChild(itemEl(room, it));
      const st = G.states.get(id);
      for (const a of (st && st.approvals) || []) frag.appendChild(approvalCard(room, id, a));
      for (const r of (st && st.retries) || []) frag.appendChild(retryCard(id, r));
      // the one live indicator: who the gateway runs now, at the end of the transcript (static, no animation)
      const lv = live(id);
      if (lv.working && !lv.waiting) {
        frag.appendChild(h("div", { class: "grp-live", role: "status" },
          lv.speaker ? face(lv.speaker.profile, 20) : null,
          h("span", null, lv.speaker ? i18nText("groups.thinking", { name: titleOf(lv.speaker) }) : i18nText("groups.working"))));
      }
      if (L.error) frag.appendChild(h("p", { class: "hist-err" }, i18nNode("groups.loadFailed", { error: L.error })));
      return frag;
    }

    // ------------------------------------------------------------ the create form (chat column, where "+" was clicked)
    function createForm() {
      const f = G.form || (G.form = { name: "", picked: new Set(), busy: false, error: null });
      const b = B();
      const bots = b ? b.list() : [];
      const name = h("input", { class: "input", type: "text", value: f.name, maxlength: "200", placeholder: i18nText("groups.namePlaceholder"), "aria-label": i18nText("groups.nameLabel"), dataset: { fk: "groups-name" } });
      const count = h("span", { class: "grp-count" }, i18nText("groups.picked", { n: f.picked.size, max: MAX }));
      const err = h("p", { class: "form-error", role: "alert" }, f.error || "");
      const ok = h("button", { class: "btn primary", type: "button", dataset: { fk: "groups-create" } }, i18nNode(f.busy ? "groups.creating" : "groups.create"));
      const boxes = [];
      const sync = () => {
        count.textContent = i18nText("groups.picked", { n: f.picked.size, max: MAX });
        ok.disabled = f.busy || !canCreate(f.name, f.picked.size);
        for (const [box, profile] of boxes) box.disabled = f.busy || (!f.picked.has(profile) && f.picked.size >= MAX);
      };
      name.addEventListener("input", () => {
        f.name = name.value;
        sync();
      });
      name.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !ok.disabled) {
          e.preventDefault();
          submit();
        }
      });
      const rows = bots.map((bot) => {
        const box = h("input", { type: "checkbox", checked: f.picked.has(bot.name), dataset: { fk: `groups-pick:${bot.name}` } });
        boxes.push([box, bot.name]);
        box.addEventListener("change", () => {
          if (box.checked && f.picked.size < MAX) f.picked.add(bot.name);
          else f.picked.delete(bot.name);
          box.checked = f.picked.has(bot.name);
          sync();
        });
        return h("label", { class: "grp-pick" }, box, b.face(bot.name, { size: 28 }), h("span", { class: "who" }, h("span", { class: "name" }, bot.title), h("span", { class: "sub" }, `@${bot.handle}`)));
      });
      async function submit() {
        if (f.busy || !canCreate(f.name, f.picked.size)) return;
        f.busy = true;
        f.error = null;
        err.textContent = "";
        ok.textContent = i18nText("groups.creating");
        sync();
        try {
          const members = bots.filter((x) => f.picked.has(x.name)).map((x) => ({ profile: x.name, name: x.title }));
          const room = await api().create({ name: f.name.trim(), members });
          G.rooms.set(room.id, room);
          G.form = null;
          openRoom(room.id);
          mark("rail", true);
        } catch (e) {
          f.busy = false;
          f.error = i18nText("groups.createFailed", { error: d.cleanErr(e) });
          err.textContent = f.error;
          ok.textContent = i18nText("groups.create");
          sync();
        }
      }
      ok.addEventListener("click", submit);
      const cancel = h("button", { class: "btn", type: "button", onclick: () => { G.form = null; d.leave(); } }, i18nNode("U0451"));
      sync();
      if (!f.name && typeof setTimeout === "function") setTimeout(() => name.isConnected && document.activeElement === document.body && name.focus(), 0);
      return h("form", { class: "grp-form", "data-hold": "1", onsubmit: (e) => { e.preventDefault(); submit(); } },
        h("h2", null, i18nNode("groups.new")),
        h("label", { class: "grp-field" }, h("span", null, i18nNode("groups.nameLabel")), name),
        h("div", { class: "grp-field" }, h("span", null, i18nNode("groups.pickLabel"), " ", count),
          bots.length >= MIN ? h("div", { class: "grp-picks" }, ...rows) : h("p", { class: "muted small" }, i18nNode("groups.noBots"))),
        err,
        h("div", { class: "form-actions" }, cancel, ok));
    }

    // ------------------------------------------------------------ strip and right panel
    function strip(sid) {
      if (sid === NEW) return [];
      const id = roomIdOf(sid);
      const L = G.logs.get(id);
      return L && L.error ? [h("span", { class: "bad" }, i18nNode("groups.loadFailed", { error: L.error }))] : [];
    }

    function pane(kids, sid) {
      const room = roomOf(roomIdOf(sid));
      if (!room) return;
      kids.push(h("p", { class: "pane-title" }, h("b", null, room.name)));
      kids.push(h("h2", { class: "section-h" }, i18nNode("groups.members")));
      for (const m of room.members) {
        kids.push(h("div", { class: "grp-member" }, face(m.profile, 24), h("span", { class: "who" }, h("span", { class: "name" }, titleOf(m)), h("span", { class: "sub" }, `@${m.handle}`))));
      }
      kids.push(h("p", { class: "muted small" }, i18nNode("groups.membersFixed")));
    }

    // ------------------------------------------------------------ composer: send, Stop, approvals
    async function send(sid, text) {
      const id = roomIdOf(sid);
      if (!id || !text || G.sending) return false;
      G.sending = true;
      d.renderNote();
      try {
        const r = await api().send(id, text);
        const L = logOf(id);
        if (r && r.event) L.events = mergeEvents(L.events, [r.event]);
        mark("msgs", "rail", true);
        return true;
      } catch (e) {
        d.note(i18nText("groups.sendFailed", { error: d.cleanErr(e) }), true);
        return false;
      } finally {
        G.sending = false;
        d.renderNote();
        if (openId() === id) {
          clearTimeout(G.timer);
          G.timer = setTimeout(tick, 400); // the first member turn shows up soon
        }
      }
    }

    async function stop(sid) {
      const id = roomIdOf(sid);
      if (!id || G.stopping) return;
      G.stopping = true;
      d.renderNote();
      try {
        await api().stop(id);
      } catch (e) {
        d.note(i18nText("groups.stopFailed", { error: d.cleanErr(e) }), true);
      } finally {
        G.stopping = false;
      }
      await tick();
    }

    async function approve(id, a, choice) {
      if (G.answering.has(a.requestId)) return;
      G.answering.add(a.requestId);
      mark("msgs", true);
      try {
        await api().approve(id, { memberId: a.memberId, taskId: a.taskId, generation: a.generation, requestId: a.requestId, choice });
        const st = G.states.get(id);
        if (st) st.approvals = st.approvals.filter((x) => x.requestId !== a.requestId);
      } catch (e) {
        if (d.toast) d.toast(i18nText("groups.approveFailed", { error: d.cleanErr(e) }), true);
      } finally {
        G.answering.delete(a.requestId);
      }
      await tick();
    }

    async function retry(id, taskId) {
      try {
        await api().retry(id, taskId);
      } catch (e) {
        if (d.toast) d.toast(d.cleanErr(e), true);
      }
      await tick();
    }

    // ------------------------------------------------------------ lifecycle
    function onStatus(status, was) {
      if (status === "open" && was !== "open") {
        reset();
        refresh();
      } else if (status !== "open") {
        clearTimeout(G.timer);
        G.timer = 0;
      }
    }

    if (typeof document === "object") document.addEventListener("visibilitychange", () => {
      if (!openId()) return;
      if (visible()) tick();
      else schedule();
    });

    return {
      owns: isRoomSel,
      isNew: (sid) => sid === NEW,
      supported: () => G.supported === true,
      refresh,
      railRows,
      head,
      view,
      strip,
      pane,
      onSelect,
      onStatus,
      send,
      stop,
      busy: () => G.sending || G.stopping,
      working: (sid) => { const id = roomIdOf(sid); return !!id && live(id).working; },
      mentionItems: (sid) => mentionItems(roomOf(roomIdOf(sid)), titleOf),
      openRoom,
      openNew,
    };
  }

  const api = { create, ROOM, NEW, MAIN, MIN, MAX, isRoomSel, roomIdOf, selOf, mergeEvents, addressed, mentionsUser, pendingDiscussion, nextSpeaker, liveState, transcript, rowSummary, mentionItems, canCreate, sortRooms, choicesOf };
  if (typeof window !== "undefined") window.DeckGroups = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
