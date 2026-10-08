"use strict";
// Lane E: shared read model and inbox. No mutation is scheduled or replayed.
(function (root) {
  const list = value => Array.isArray(value) ? value : [];
  const text = value => typeof value === "string" ? value : "";
  const stamp = s => Number(s.triageDoneAt || s.terminalAt || s.lastTs || s.updatedAt || 0);
  const sessionKey = s => JSON.stringify([s.profile || "default", s.sid]);
  const requestKey = r => JSON.stringify([r.profile || "default", r.id]);
  const LIMIT = 256; // per-session turn notes and local dismissals kept in memory
  /** Drop the oldest entries (Map/Set insertion order) until `bag` holds at most `n`. */
  function cap(bag, n = LIMIT) { for (const key of bag.keys()) { if (bag.size <= n) break; bag.delete(key); } }
  const EXIT_MS = 260;
  function sessions(data) {
    const by = new Map();
    for (const s of list(data.relay)) if (s && s.sid) by.set(sessionKey(s), { ...s, origin: "relay" });
    for (const s of list(data.direct)) if (s && s.sid) by.set(sessionKey(s), { ...by.get(sessionKey(s)), ...s, origin: "direct" });
    return [...by.values()];
  }
  function collect(data = {}, now = Date.now()) {
    const all = sessions(data);
    const out = list(data.requests).filter(r => r && r.id && ["approval", "question"].includes(r.kind)).map(r => {
      const s = all.find(s => s.sid === r.sid && (s.profile || "default") === (r.profile || "default")) || {};
      return { ...s, ...r, type: r.kind, key: `request:${requestKey(r)}`, request: r,
        title: text(s.title) || text(s.name) || text(r.command) || text(r.questions?.[0]?.question),
        detail: text(r.description), at: Number(r.at || 0), origin: "direct" };
    });
    for (const s of all) {
      if (s.parent || s.parentId) continue;
      const type = ["error", "failed"].includes(s.state) ? "failed" : ["finished", "done"].includes(s.state) || s.triageDoneAt ? "done" : null;
      if (!type || !stamp(s) || now / 1000 - stamp(s) > 86400) continue;
      out.push({ ...s, type, key: `session:${sessionKey(s)}:${type}:${stamp(s)}`,
        title: text(s.title) || text(s.name) || text(s.ask) || text(s.lastMsg), detail: text(s.error) || text(s.err) || text(s.lastTool?.err) || text(s.exit) || text(s.preview), at: stamp(s) * 1000 });
    }
    const rank = { approval: 0, question: 0, failed: 1, done: 2 };
    return out.sort((a, b) => rank[a.type] - rank[b.type] || (rank[a.type] ? b.at - a.at : a.at - b.at));
  }
  function createStore(deck = {}, now = () => Date.now(), t = key => root.DeckI18n ? root.DeckI18n.t(key) : key) {
    const data = { direct: [], relay: [], requests: [], agents: {}, fleet: null, tokens: [], bridgeStatus: "off", relayStatus: "unconfigured" };
    const listeners = new Set(), pending = new Set(), errors = new Map(), dismissed = new Set(), turns = new Map();
    let undoKey = null;
    const notify = () => { for (const fn of listeners) fn(data); };
    const items = () => collect(data, now()).filter(x => !dismissed.has(x.key));
    function feedBridge(m = {}) {
      if (!["snapshot", "requests", "status", "event"].includes(m.t)) return;
      if (m.t === "event") {
        if (!["message.start", "message.complete", "message.error", "error"].includes(m.type) || !m.sid) return;
        const key = sessionKey(m), prior = turns.get(key) || {};
        const change = m.type === "message.start" ? { turnTs: now() / 1000, triageDoneAt: null, error: null }
          : m.type === "message.complete" ? { ...prior, triageDoneAt: now() / 1000 }
          : { ...prior, error: text(m.payload?.message) || text(m.payload?.error), triageDoneAt: null };
        turns.delete(key); turns.set(key, change); cap(turns);
        data.direct = data.direct.map(s => sessionKey(s) === key ? { ...s, ...change,
          state: m.type === "message.start" ? "working" : m.type === "message.complete" ? "finished" : "error", terminalAt: m.type === "message.start" ? null : now() / 1000 } : s);
      }
      if (m.t === "snapshot" && m.snapshot) {
        const old = new Map(data.direct.map(s => [sessionKey(s), s]));
        data.direct = list(m.snapshot.nodes).map(s => {
          const prior = old.get(sessionKey(s)), turn = turns.get(sessionKey(s));
          const active = s.active || ["thinking", "working", "searching"].includes(s.state);
          const done = prior && ["thinking", "working", "searching"].includes(prior.state) && s.state === "idle" && s.terminalAt && !s.parent;
          return { ...s, ...turn, triageDoneAt: active ? null : turn?.triageDoneAt || prior?.triageDoneAt || (done ? s.terminalAt : null) };
        });
      }
      if (m.t === "requests") {
        data.requests = list(m.list);
        const keys = new Set(data.requests.map(r => `request:${requestKey(r)}`));
        for (const key of errors.keys()) if (!keys.has(key)) errors.delete(key);
      }
      if (m.t === "status") {
        data.bridgeStatus = m.status || "off";
        if (data.bridgeStatus !== "open") data.requests = [];
        if (data.bridgeStatus === "off") data.direct = [];
      }
      notify();
    }
    function feedRelay(m = {}) {
      if (!["snapshot", "evs", "agents", "fleet", "status"].includes(m.t)) return;
      if (m.t === "snapshot") { data.relay = list(m.sessions); data.agents = m.agents || {}; data.fleet = m.fleet || null; data.tokens = list(m.tokens); data.relayStatus = m.status || "open"; }
      if (m.t === "evs") {
        const by = new Map(data.relay.map(s => [sessionKey(s), s]));
        for (const s of list(m.sessions)) if (s && s.sid) {
          const key = sessionKey(s), prior = by.get(key);
          const wasLive = prior?.state === "running" && !prior.stale;
          const done = wasLive && s.state === "idle" && !s.parent && !s.cron && !s.splitInto && !s.stale;
          by.set(key, { ...s, triageDoneAt: s.state === "running" ? null : done ? s.lastTs : prior?.triageDoneAt || null });
        }
        data.relay = [...by.values()];
      }
      if (m.agents) data.agents = m.agents;
      if (m.t === "fleet") data.fleet = m.fleet || null;
      if (m.tokens) data.tokens = list(m.tokens);
      if (m.t === "status") data.relayStatus = m.status || "closed";
      notify();
    }
    async function answer(row, value) {
      const r = row.request;
      // Capture the exact live request; duplicate ids across profiles are ambiguous in the existing preload API.
      if (!r || data.bridgeStatus !== "open" || pending.has(row.key) || !data.requests.includes(r)
        || data.requests.filter(x => x.id === r.id).length !== 1) return false;
      if (r.kind === "approval" && !list(r.choices).includes(value)) return false;
      if (r.kind === "question" && (!value || typeof value !== "object" || !Object.values(value).some(v => typeof v === "string" && v.trim()))) return false;
      const method = r.kind === "approval" ? "answerApproval" : "answerQuestion";
      if (typeof deck.bridge?.[method] !== "function") return false;
      pending.add(row.key); errors.delete(row.key); notify();
      try {
        const result = await deck.bridge[method](r.id, value);
        if (result?.status !== "ok" && result?.status !== "expired") throw new Error(t("triage.notDelivered"));
        data.requests = data.requests.filter(x => x !== r);
        return true;
      } catch (e) { errors.set(row.key, String(e.message || e)); return false; }
      finally { pending.delete(row.key); notify(); }
    }
    return { data, items, feedBridge, feedRelay, answer,
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      busy: key => pending.has(key), error: key => errors.get(key),
      dismiss(row) {
        if (!["failed", "done"].includes(row.type)) return false;
        dismissed.add(row.key); undoKey = row.key;
        if (dismissed.size > LIMIT) { const live = new Set(collect(data, now()).map(x => x.key)); for (const key of dismissed) if (!live.has(key) && key !== undoKey) dismissed.delete(key); cap(dismissed); }
        notify(); return true;
      },
      sizes: () => ({ turns: turns.size, dismissed: dismissed.size }),
      undo() { if (undoKey) dismissed.delete(undoKey); undoKey = null; notify(); },
      seed(value = {}) {
        if (value.bridgeStatus) data.bridgeStatus = value.bridgeStatus;
        if (value.direct) data.direct = list(value.direct);
        if (value.requests) data.requests = list(value.requests);
        if (value.relay) feedRelay({ t: "snapshot", ...value.relay });
        notify();
      },
    };
  }
  function questionAnswers(r, form) {
    return Object.fromEntries(list(r.questions).map(q => [q.qid, (form.text[q.qid] || "").trim() || (form.pick[q.qid] || []).join(", ")]));
  }
  function requestBody(ctx, row) {
    const { h, store, t, forms, redraw } = ctx, r = row.request;
    let form = forms.get(row.key);
    if (!form) { form = { text: Object.create(null), pick: Object.create(null) }; forms.set(row.key, form); }
    const disabled = store.busy(row.key) || store.data.bridgeStatus !== "open";
    const button = (label, action, primary = false, extra = {}) => h("button", { type: "button", class: `te-btn${primary ? " primary" : ""}`, disabled,
      onclick: action, ...extra }, t(label));
    const kids = [];
    if (r.kind === "approval") {
      if (r.command) kids.push(h("pre", { class: "te-command" }, r.command));
      if (r.description) kids.push(h("p", null, r.description));
      kids.push(h("div", { class: "te-actions" }, ["deny", "session", "once"].filter(c => list(r.choices).includes(c)).map(c =>
        button({ deny: "triage.deny", session: "triage.allowSession", once: "triage.approve" }[c], () => store.answer(row, c), c === "once"))));
    } else {
      for (const q of list(r.questions)) {
        const picked = form.pick[q.qid] || [];
        kids.push(h("fieldset", { class: "te-question" }, h("legend", null, q.question),
          h("div", { class: "te-actions" }, list(q.choices).map(choice => h("button", { type: "button", class: "te-btn", disabled,
            "aria-pressed": picked.includes(choice) ? "true" : "false", dataset: { fk: `triage:${row.key}:${q.qid}:${choice}` },
            onclick: () => { form.pick[q.qid] = q.multi ? (picked.includes(choice) ? picked.filter(x => x !== choice) : [...picked, choice]) : picked.includes(choice) ? [] : [choice]; redraw(); } }, choice))),
          h("input", { type: "text", class: "te-answer", disabled, value: form.text[q.qid] || "", "aria-label": q.question,
            placeholder: t("triage.answerPlaceholder"), dataset: { hold: "1", fk: `triage:${row.key}:${q.qid}:text` },
            oninput: e => { form.text[q.qid] = e.target.value; },
            onkeydown: e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); store.answer(row, questionAnswers(r, form)); } } })));
      }
      kids.push(h("div", { class: "te-actions" }, button("triage.sendAnswer", () => store.answer(row, questionAnswers(r, form)), true)));
    }
    const error = store.error(row.key);
    if (error) kids.push(h("p", { class: "te-error", role: "alert" }, error));
    return h("div", { class: "te-request" }, kids);
  }
  const moveIndex = (index, delta, count) => count ? (index + delta + count) % count : 0;
  function keyIntent(e) {
    if (e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable) return null;
    const intent = { j: "next", ArrowDown: "next", k: "previous", ArrowUp: "previous", Enter: "open", a: "approve", A: "approve", x: "dismiss", X: "dismiss" }[e.key] || null;
    return e.target?.tagName === "BUTTON" && !["next", "previous"].includes(intent) ? null : intent;
  }
  function createInbox(ctx) {
    const { h, t, store, shell, doc } = ctx;
    const el = h("div", { class: "te-inbox", tabindex: "0", "aria-label": t("triage.inbox") });
    const forms = new Map(), rows = new Map(), leaving = new Map(); // leaving: key -> {row, index, node} while it animates out
    let selected = null, toast = null, toastTimer, notice = null, shown = [];
    const reduced = () => !!root.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const open = row => { if (ctx.openChat(row) === false) { notice = t("triage.navigationUnavailable"); redraw(); } };
    const button = (key, fn, primary = false) => h("button", { type: "button", class: `te-btn${primary ? " primary" : ""}`, onclick: fn }, t(key));
    function dismiss(row) {
      if (!["done", "failed"].includes(row.type) || leaving.has(row.key)) return;
      toast = row.title || t(`triage.${row.type}`);
      clearTimeout(toastTimer);
      store.dismiss(row); // the redraw below animates the row out like any other removal
      toastTimer = setTimeout(() => { toast = null; redraw(); }, 4000);
    }
    /** Rows that left since the last draw (answered, dismissed, aged out) stay one exit animation long, inert. */
    function exits(items) {
      const keys = new Set(items.map(x => x.key));
      for (const key of leaving.keys()) if (keys.has(key)) leaving.delete(key);
      if (!reduced()) shown.forEach((row, index) => {
        const node = rows.get(row.key);
        if (keys.has(row.key) || leaving.has(row.key) || !node) return;
        node.classList.add("out"); node.setAttribute("aria-hidden", "true"); node.inert = true;
        leaving.set(row.key, { row, index, node });
        setTimeout(() => { if (leaving.delete(row.key)) redraw(); }, EXIT_MS);
      });
      const all = [...items];
      for (const g of leaving.values()) all.splice(Math.min(g.index, all.length), 0, g.row);
      return all;
    }
    function redraw() {
      // Do not detach a question field while the user types. Action and blur redraws retain form values.
      if (el.contains(doc.activeElement) && doc.activeElement?.matches("input[data-hold]")) return;
      const focus = el.contains(doc.activeElement) ? doc.activeElement?.dataset.fk : null;
      const items = store.items(), all = exits(items);
      if (!items.some(x => x.key === selected)) selected = items[0]?.key || null;
      for (const key of forms.keys()) if (!items.some(x => x.key === key)) forms.delete(key);
      rows.clear(); shown = items;
      const kids = [h("header", { class: "te-inbox-head" }, h("h1", null, t("triage.inbox")), h("span", null, t("triage.openCount", { n: items.filter(x => x.request).length }))),
        h("p", { class: "te-inbox-sub" }, t("triage.inboxSub"))];
      if (!items.length) kids.push(h("div", { class: "te-all-clear", role: "status" }, h("b", null, t("triage.allClear")), h("p", null, t("triage.nothingWaiting"))));
      for (const [name, types] of [["needs", ["approval", "question"]], ["failed", ["failed"]], ["done", ["done"]]]) {
        const group = all.filter(x => types.includes(x.type));
        if (!group.length) continue;
        kids.push(h("h2", { class: "te-group" }, t(`triage.${name}`), h("b", null, String(group.filter(x => !leaving.has(x.key)).length))));
        for (const row of group) {
          const ghost = leaving.get(row.key);
          if (ghost) { kids.push(ghost.node); continue; }
          const active = row.key === selected;
          const body = row.request ? requestBody({ h, t, store, forms, redraw }, row) : h("div", null,
            row.detail ? h("pre", { class: row.type === "failed" ? "te-command" : "te-finished" }, row.detail) : null,
            h("div", { class: "te-actions" }, button("triage.dismiss", () => dismiss(row)), button("triage.openChat", () => open(row), true)));
          const article = h("article", { class: `te-row ${row.type}${active ? " sel" : ""}` },
            h("button", { type: "button", class: "te-row-head", dataset: { fk: `triage-row:${row.key}` }, "aria-expanded": active ? "true" : "false",
              onclick: () => { selected = row.key; redraw(); } },
            h("span", { class: "te-kind", "aria-hidden": "true" }, shell.icon(row.type === "approval" ? "lock" : row.type === "question" ? "waiting" : row.type === "failed" ? "x" : "agent")),
            h("span", { class: "te-row-title" }, h("b", null, row.title || t(`triage.${row.type}`)), h("small", null, row.detail || t(`triage.${row.type}`))),
            h("span", { class: "te-row-agent" }, row.agent || row.profile || ""),
            h("span", { class: "te-age" }, row.at ? root.DeckUsage.agoText(row.at / 1000) : "")),
            active ? h("div", { class: "te-row-body" }, body, row.request ? button("triage.openChat", () => open(row)) : null) : null);
          rows.set(row.key, article); kids.push(article);
        }
      }
      if (notice) kids.push(h("p", { role: "status", class: "te-error" }, notice));
      kids.push(h("footer", { class: "te-inbox-keys" }, t("triage.inboxKeys")));
      if (toast) kids.push(h("div", { class: "te-undo", role: "status" }, t("triage.dismissed", { title: toast }), button("triage.undo", () => { toast = null; clearTimeout(toastTimer); store.undo(); })));
      el.replaceChildren(...kids);
      const ghosts = [...leaving.values()].map(g => g.node);
      if (focus) [...el.querySelectorAll("[data-fk]")].find(x => x.dataset.fk === focus && !ghosts.some(g => g.contains(x)))?.focus({ preventScroll: true });
    }
    function keydown(e) {
      if (shell.main() !== "inbox" || doc.querySelector('.tf-panel.show') || doc.activeElement?.closest("#right, .sv, .sb")) return;
      const intent = keyIntent(e), items = store.items();
      if (!intent || !items.length) return;
      const index = Math.max(0, items.findIndex(x => x.key === selected)), row = items[index];
      if (intent === "next" || intent === "previous") {
        selected = items[moveIndex(index, intent === "next" ? 1 : -1, items.length)].key;
        redraw(); rows.get(selected)?.scrollIntoView({ block: "nearest" }); el.focus({ preventScroll: true });
      } else if (intent === "open") open(row);
      else if (intent === "approve" && row.type === "approval") store.answer(row, "once");
      else if (intent === "dismiss") dismiss(row);
      else return;
      e.preventDefault();
    }
    el.addEventListener("focusout", e => { if (e.target.matches("input[data-hold]")) setTimeout(redraw, 0); });
    store.subscribe(redraw);
    redraw();
    return { root: el, redraw, keydown };
  }
  function connect(store, deck) {
    const seen = new Set();
    const offBridge = deck.bridge?.onEvent(m => { seen.add(m.t); store.feedBridge(m); });
    const offRelay = deck.onRelay?.(store.feedRelay);
    const ready = deck.bridge?.status ? deck.bridge.status().then(st => {
      if (!seen.has("status")) store.feedBridge({ t: "status", ...(st.status || { status: "off" }) });
      if (!seen.has("snapshot") && st.snapshot) store.feedBridge({ t: "snapshot", snapshot: st.snapshot });
      if (!seen.has("requests") && !seen.has("status")) store.feedBridge({ t: "requests", list: st.requests });
    }).catch(() => {}) : Promise.resolve();
    return { ready, stop() { offBridge?.(); offRelay?.(); } };
  }
  function boot() {
    const shell = root.DeckShell, deck = root.deck, doc = root.document, h = shell?.service("h");
    if (!h || !deck || api.store) return;
    const store = api.store = createStore(deck);
    // Services seed late-mounted views without another relay connection; older shells use ordinary pushes.
    const seed = () => { const get = shell.service("triageData"); if (get) store.seed(get()); };
    seed(); shell.on("service", seed);
    connect(store, deck);
    const t = root.DeckI18n.t;
    api.openChat = row => {
      const open = shell.service("openChat");
      if (open && row.sid) return open({ sid: row.sid, profile: row.profile, origin: row.origin }) !== false;
      // Existing rail actions are safe navigation only; no synthetic IPC mutation or replay.
      const railRow = [...(doc.getElementById("rail")?.querySelectorAll("[data-fk]") || [])].find(el => el.dataset.fk === `hrow:${row.sid}`);
      if (railRow) { railRow.click(); shell.setMain("chat"); return true; }
      return false;
    };
    const view = createInbox({ h, t, store, shell, doc, openChat: api.openChat });
    shell.mount("inbox", view.root);
    shell.on("main", () => { view.redraw(); if (shell.main() === "inbox") view.root.focus({ preventScroll: true }); });
    doc.addEventListener("keydown", view.keydown);
    doc.addEventListener("deck-language", view.redraw);
  }
  const api = { LIMIT, cap, collect, sessions, sessionKey, requestKey, createStore, requestBody, questionAnswers, moveIndex, keyIntent, createInbox, connect, boot };
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.DeckInbox = api; boot(); }
})(typeof window === "object" ? window : globalThis);
