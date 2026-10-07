"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
// Sub-agent views (B1–B4), main-process side:
// - IPC for the relay's read-only history routes: one session's messages, one message in full, one tool
//   call in full. Inputs are checked here; the relay checks them again.
// - Fixture mode (development screenshots): relative times in the fixture's relay section, the history
//   routes served from the file, and a few timed live pushes, so nothing reaches a relay.
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
const MSG_ID_RE = /^[hc]:[A-Za-z0-9_.:/-]{1,300}$/;
const CALL_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

/** RelayClient.get throws "relay <path>: HTTP <code>"; say what that means for the history view. */
function explain(e) {
  const m = /HTTP (\d{3})/.exec(String((e && e.message) || ""));
  const code = m ? Number(m[1]) : 0;
  if (code === 404) return new Error(i18nText("U0232"));
  if (code === 501) return new Error(i18nText("U0233"));
  if (code === 400) return new Error(i18nText("U0234"));
  return e;
}

function register(ipcMain, getRelay) {
  const relay = () => {
    const r = getRelay();
    if (!r) throw new Error(i18nText("U0235"));
    return r;
  };
  const check = (re, v, what) => {
    const s = String(v ?? "");
    if (!re.test(s)) throw new Error(i18nText("U0236", { what: what }));
    return s;
  };
  const get = (p) => relay().get(p).catch((e) => Promise.reject(explain(e)));
  ipcMain.handle("relay:messages", (_e, sid, before) => {
    const s = check(SID_RE, sid, i18nText("U0237"));
    const b = before === undefined || before === null || before === "" ? null : check(/^\d{1,15}$/, before, i18nText("A0145"));
    return get(`/session/${encodeURIComponent(s)}/messages?limit=50${b ? `&before=${b}` : ""}`);
  });
  ipcMain.handle("relay:message-full", (_e, id) => get(`/message/${encodeURIComponent(check(MSG_ID_RE, id, i18nText("U0238")))}/full`));
  ipcMain.handle("relay:call", (_e, sid, call) =>
    get(`/session/${encodeURIComponent(check(SID_RE, sid, i18nText("U0237")))}/call/${encodeURIComponent(check(CALL_RE, call, i18nText("U0239")))}`)
  );
}

// ------------------------------------------------------------------------------------------- fixture mode

const AGO_KEYS = { ago: "ts", firstAgo: "firstTs", lastAgo: "lastTs", turnAgo: "turnTs", sinceAgo: "since", startedAgo: "startedAt", endedAgo: "endedAt" };

/** Deep copy with "<x>Ago" (seconds before now) turned into absolute times, so tickers read sensibly on every run. */
function rebase(v, now) {
  if (Array.isArray(v)) return v.map((x) => rebase(x, now));
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [key, val] of Object.entries(v)) {
    if (AGO_KEYS[key] && typeof val === "number") out[AGO_KEYS[key]] = Math.round((now - val) * 1000) / 1000;
    else out[key] = rebase(val, now);
  }
  return out;
}

/** The agents table the relay would send: running counts and the newest tool in flight, from the sessions. */
function agentsOf(data) {
  const agents = JSON.parse(JSON.stringify(data.agents || {}));
  for (const a of Object.values(agents)) Object.assign(a, { running: 0, subsRunning: 0, curTool: null });
  for (const s of data.sessions || []) {
    const a = agents[s.agent];
    if (!a || s.state !== "running" || s.stale) continue;
    if (s.parent) a.subsRunning += 1;
    else a.running += 1;
    if (s.curTool && (!a.curTool || s.curTool.since > a.curTool.since)) a.curTool = { ...s.curTool, sid: s.sid };
  }
  return agents;
}

/** Fixture relay data: times made absolute, agent counts derived from the sessions. */
function fixtureData(relay) {
  if (!relay || !Array.isArray(relay.sessions)) return relay;
  const data = rebase(relay, Date.now() / 1000);
  data.agents = agentsOf(data);
  return data;
}

/** A history route answered from the fixture (undefined: not a history route, the caller answers). */
function fixtureGet(data, p) {
  if (!data || !data.history) return undefined;
  const u = new URL(String(p), "http://fixture");
  const dec = decodeURIComponent;
  const hist = data.history;
  const fail = (code) => Promise.reject(new Error(`relay ${u.pathname}: HTTP ${code}`)).catch((e) => Promise.reject(explain(e)));
  let m = /^\/session\/([^/]+)\/messages$/.exec(u.pathname);
  if (m) {
    const sid = dec(m[1]);
    return hist[sid] ? { sid, meta: hist[sid].meta || null, items: hist[sid].items || [], next: null } : fail(404);
  }
  const find = (id) => {
    for (const h of Object.values(hist)) for (const it of h.items || []) if (it.id === id) return it;
    return null;
  };
  m = /^\/message\/([^/]+)\/full$/.exec(u.pathname);
  if (m) {
    const id = dec(m[1]);
    return (data.full && data.full[id]) || find(id) || fail(404);
  }
  m = /^\/session\/([^/]+)\/call\/([^/]+)$/.exec(u.pathname);
  if (m) {
    const [sid, call] = [dec(m[1]), dec(m[2])];
    const items = (hist[sid] && hist[sid].items) || [];
    const asked = items.find((i) => (i.calls || []).some((c) => c.call === call));
    const res = items.find((i) => i.role === "tool" && i.call === call);
    const full = (it) => (it && data.full && data.full[it.id]) || it;
    const c = asked ? (full(asked).calls || []).find((x) => x.call === call) : null;
    if (c || res) return { call, name: c ? c.name : res.name, args: c ? c.args : undefined, result: res ? full(res).text : undefined };
    const t = ((data.details || {})[sid] || { recent: [] }).recent.find((x) => x.call === call);
    return t ? { call, name: t.tool, args: t.args, result: t.result } : fail(404);
  }
  m = /^\/session\/([^/]+)$/.exec(u.pathname);
  if (m) {
    const d = (data.details || {})[dec(m[1])];
    return d ? { recent: d.recent || [] } : undefined;
  }
  return undefined;
}

/** Timed pushes from the fixture ({after: ms, evs, sessions}); returns a cancel function. */
function fixtureLive(data, emit) {
  const timers = (data && data.live ? data.live : []).map((step) =>
    setTimeout(() => {
      const now = Date.now() / 1000;
      const sessions = rebase(step.sessions || [], now);
      for (const s of sessions) {
        const i = data.sessions.findIndex((x) => x.sid === s.sid);
        if (i === -1) data.sessions.push(s);
        else data.sessions[i] = s;
      }
      data.agents = agentsOf(data);
      emit({ t: "evs", evs: rebase(step.evs || [], now), sessions, agents: data.agents });
    }, Number(step.after) || 0)
  );
  return () => timers.forEach(clearTimeout);
}

module.exports = { register, fixtureData, fixtureGet, fixtureLive, rebase };
