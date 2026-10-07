"use strict";
// Agent spaces in the Deck (docs/agent-spaces.md): the spaces' status from the relay (the shared desktop "host" and, in
// "agent" mode, each agent's own desktop), the user's control level per space, "Work on this device" / "Send back
// to its space", the mode, home hosts, Start / Stop, and where the viewer view sits and which space it shows. Every
// call goes to the relay with its token (relayFetch, the Bot screen's). The viewer of an agent desktop that runs on
// this computer (main/desktops.js) is reached on loopback instead (space-proxy.js), and the Deck's /spaces poll then
// tells the relay it is being watched (?watching=<id>), so its idle stop and full control's view-loss rule see it.
const { createSpaceView } = require("./space-view");
const { levelOk, takenBy, isSpace, isProfile, fallbackFor, pills } = require("./space-view-logic");
const { t: i18nText } = require("../renderer/i18n");

const WATCH_MS = 5000; // how often the Deck asks the relay who holds the shared desktop (for the notifications)
const LOCAL_TTL_MS = 3000; // a "runs on this computer" answer is reused this long (desktops.port lists Docker)

const PROFILE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HOST_RE = /^[a-f0-9]{8,64}$/; // a Deck device id (the relay's home host ids: "auto", "agent-host" or a device)

function initSpaces({ ipc, win, relayCfg, relayFetch, deviceId, settings, notify = null, send = null, desktops = null, createView = createSpaceView, watchMs = WATCH_MS, now = () => Date.now() }) {
  let sv = null;
  const accepted = new Map(); // space -> the level the relay accepted last for it (the loopback proxy's input rule)
  const local = new Map(); // agent profile -> {at, p, tg}: its loopback port and token, as last asked (p: the asking)
  const rows = new Map(); // agent profile -> {host, state}: where the relay places its desktop, from the last /spaces

  /** The last /spaces answer's agent rows (a failed poll keeps the previous ones). */
  function noteRows(list) {
    if (!list || !Array.isArray(list.spaces)) return;
    rows.clear();
    for (const s of list.spaces) if (s && s.kind === "agent" && isProfile(s.id)) rows.set(s.id, { host: s.host, state: s.state });
    // the relay's level per desktop is what holds (it ends Full by its view-loss rule; another Deck may lower it):
    // the loopback proxy follows it, so input stops here as soon as the relay says so
    for (const s of list.spaces) if (s && isSpace(s.id) && levelOk(s.level)) accepted.set(s.id, s.level);
  }
  /**
   * The relay places this agent's desktop on this Deck's computer, and it is ready there. A container for the profile
   * may run here while the relay uses another one (a relay restart, a desktop started on the agent host meanwhile):
   * only the relay's placement makes it a loopback target.
   */
  const placedHere = (id) => {
    const r = rows.get(id);
    return !!r && r.state === "ready" && typeof r.host === "string" && r.host === deviceId();
  };
  async function ask(id) {
    try {
      const port = await desktops.port(id);
      const token = port ? desktops.token(id) : null;
      if (Number.isInteger(port) && port > 0 && token) return { kind: "local", port, token };
    } catch {}
    return { kind: "relay" };
  }

  /** Where a space's viewer is: on this computer's loopback (its port and container token), else the relay's proxy. */
  async function target(id) {
    if (id === "host" || !desktops || !isProfile(id) || !placedHere(id)) return { kind: "relay" };
    let c = local.get(id);
    if (!c || now() - c.at >= LOCAL_TTL_MS) {
      // one Docker listing per miss: concurrent viewer requests share it
      c = { at: now(), tg: null, p: null };
      const entry = c;
      c.p = ask(id).then((tg) => (entry.tg = tg));
      local.set(id, c);
    }
    return c.p;
  }

  /**
   * The level the loopback proxy applies to a space (the relay's rule, as it would at the relay): Watch unless that
   * space is the one shown and both the relay accepted a level above Watch and the view is above Watch.
   */
  function levelFor(id) {
    const cur = sv ? sv.current() : null;
    if (!cur || !cur.visible || cur.space !== id) return "watch";
    const a = accepted.get(id) || "watch";
    return a === "watch" || !levelOk(cur.level) || cur.level === "watch" ? "watch" : a;
  }

  const view = () =>
    (sv ||= createView({
      win,
      relayBase: () => (relayCfg() || {}).http || "http://127.0.0.1:9",
      relayToken: () => (relayCfg() || {}).token || "",
      target,
      level: levelFor,
    }));
  const body = async (r) => {
    const b = await r.json().catch(() => ({}));
    if (!r.ok && !b.error) b.error = `Relay: HTTP ${r.status}`;
    return b;
  };
  const needProfile = (p) => { if (!isProfile(p) || p === "host" || p.includes("..")) throw new Error("bad profile"); return encodeURIComponent(p); };
  const needId = (id) => { if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("bad ID"); return id; };
  const jsonCall = async (method, route, data, timeoutMs = 8000) => body(await relayFetch(method, route, data, { timeoutMs }));
  let safetyRequest = 0, safetyApplied = 0;
  async function safetyCall(patch) {
    const request = ++safetyRequest;
    const result = await jsonCall(patch === undefined ? "GET" : "POST", "/spaces/settings", patch);
    if (!result.error && result.settings && request > safetyApplied) {
      desktops?.safetyPolicy?.(result.settings);
      safetyApplied = request;
    }
    return result;
  }
  ipc.handle("spaces:safety", (_e, patch) => safetyCall(patch));
  ipc.handle("spaces:audit", async (_e, p, before = "", limit = 50) => {
    if (typeof before !== "string") throw new Error("bad cursor");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("bad limit");
    return jsonCall("GET", `/spaces/${needProfile(p)}/audit?before=${encodeURIComponent(before)}&limit=${limit}`);
  });
  ipc.handle("spaces:approvals", () => jsonCall("GET", "/spaces/approvals"));
  ipc.handle("spaces:answer", async (_e, id, choice, withoutSnapshot = false) => {
    needId(id);
    if (!["once", "deny"].includes(choice) || typeof withoutSnapshot !== "boolean") throw new Error("bad choice");
    return jsonCall("POST", `/spaces/approvals/${id}`, { choice, withoutSnapshot }, 330_000);
  });
  ipc.handle("spaces:snapshots", async (_e, p) => jsonCall("GET", `/spaces/${needProfile(p)}/snapshots`, undefined, 330_000));
  ipc.handle("spaces:restore", async (_e, p, id) => {
    const profile = needProfile(p); needId(id);
    if (sv) sv.hide();
    local.delete(p); accepted.delete(p);
    return jsonCall("POST", `/spaces/${profile}/restore`, { id }, 930_000);
  });
  ipc.handle("spaces:deleteSnapshots", async (_e, p) => jsonCall("POST", `/spaces/${needProfile(p)}/snapshots/delete`, {}, 330_000));
  ipc.handle("spaces:frame", async (_e, p, id) => {
    const r = await relayFetch("GET", `/spaces/${needProfile(p)}/audit/frame/${needId(id)}`);
    if (!r.ok) return null;
    const mime = r.headers.get("content-type");
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)) return null;
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > 200_000_000) return null;
    return `data:${mime};base64,${bytes.toString("base64")}`;
  });
  const defaultLevel = () => {
    const l = settings.data.spaces && settings.data.spaces.defaultLevel;
    return levelOk(l) ? l : "watch";
  };
  const spaceArg = (space) => {
    const s = space == null ? "host" : String(space);
    if (!isSpace(s)) throw new Error("bad space");
    return s;
  };
  /** GET /spaces, saying which agent desktop this Deck shows from its own loopback right now (the relay sees no socket). */
  const listPath = () => {
    const cur = sv ? sv.current() : null;
    const id = cur && cur.visible ? cur.space : null;
    const c = id && placedHere(id) ? local.get(id) : null; // the same decision as target()
    return c && c.tg && c.tg.kind === "local" ? `/spaces?watching=${encodeURIComponent(id)}` : "/spaces";
  };

  ipc.handle("spaces:list", async () => {
    if (!relayCfg()) return { mode: null, spaces: [], defaultLevel: defaultLevel() };
    const r = await relayFetch("GET", listPath());
    if (r.status === 404) {
      rows.clear();
      return { mode: null, spaces: [], defaultLevel: defaultLevel() }; // relay without spaces
    }
    const b = await body(r);
    if (r.ok) noteRows(b);
    return { ...b, pills: pills(b), defaultLevel: defaultLevel(), deviceId: deviceId() }; // pills: the panel's, computed here
  });
  ipc.handle("spaces:control", async (_e, level, space) => {
    const l = level === "release" ? "release" : levelOk(level) ? level : null;
    if (!l) throw new Error("bad level");
    const s = spaceArg(space);
    const out = await body(await relayFetch("POST", "/spaces/control", { space: s, level: l }));
    const lv = l === "release" ? "watch" : l;
    if (out && out.ok !== false) accepted.set(s, lv);
    const cur = sv ? sv.current() : null;
    if (sv && (!cur || cur.space === s)) await sv.setLevel(lv);
    return out;
  });
  ipc.handle("spaces:route", async (_e, profile, target) => {
    if (!PROFILE_RE.test(String(profile || ""))) throw new Error("bad profile");
    const t = target === "device" ? `device:${deviceId()}` : "space";
    return body(await relayFetch("POST", "/spaces/route", { profile, target: t }));
  });
  ipc.handle("spaces:mode", async (_e, mode) => {
    if (!["shared", "agent", "overflow"].includes(mode)) throw new Error("bad mode");
    return body(await relayFetch("POST", "/spaces/mode", { mode }));
  });
  // Settings > Agent spaces: an agent's home host ("auto", "agent-host" or a Deck device id)
  ipc.handle("spaces:home", async (_e, profile, host) => {
    if (!isProfile(profile)) throw new Error("bad profile");
    const h = String(host || "");
    if (h !== "auto" && h !== "agent-host" && !HOST_RE.test(h)) throw new Error("bad host");
    return body(await relayFetch("POST", "/spaces/home", { profile, host: h }));
  });
  // the panel's Start / Stop for one agent's desktop
  ipc.handle("spaces:desktop", async (_e, profile, action) => {
    if (!isProfile(profile)) throw new Error("bad profile");
    if (action !== "start" && action !== "stop") throw new Error("bad action");
    local.delete(profile); // it may start or stop here: ask Docker again on the next view request
    return body(await relayFetch("POST", "/spaces/desktop", { profile, action }, { timeoutMs: action === "stop" ? 330_000 : 8000 }));
  });
  ipc.handle("spaces:view", async (_e, rect, level, space) => {
    const s = spaceArg(space);
    const ok = rect && [rect.x, rect.y, rect.width, rect.height].every((n) => Number.isFinite(n)) && rect.width >= 40 && rect.height >= 40;
    if (!ok) return void (sv && sv.hide());
    await view().show(rect, s, levelOk(level) ? level : defaultLevel());
  });

  // desktop notifications (shown while the Deck is in the background); clicking one opens the Bot screen tab:
  // an agent took the shared desktop (0.3.2), and an agent fell back from its own desktop to the shared one
  const open = () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized && win.isMinimized()) win.restore();
    if (win.show) win.show();
    if (win.focus) win.focus();
    if (send) send("botscreen", { t: "open-screen" });
  };
  let holder = null;
  let prev = null; // the last /spaces answer (fallen-back notices are for transitions only)
  const notifiedApprovals = new Set();
  let polling = false;
  async function tick() {
    if (polling || !relayCfg()) return;
    polling = true;
    try {
      const r = await relayFetch("GET", listPath());
      if (!r.ok) return;
      const list = await r.json();
      noteRows(list);
      // Keep the guard until both requests settle, even if one fails early.
      const [approvals, safety] = await Promise.allSettled([
        jsonCall("GET", "/spaces/approvals"), safetyCall(),
      ]);
      if (approvals.status === "rejected" || safety.status === "rejected") return;
      const pending = approvals.value;
      const live = new Set((pending.approvals || []).map((r) => r.id));
      for (const id of notifiedApprovals) if (!live.has(id)) notifiedApprovals.delete(id);
      for (const card of pending.approvals || []) {
        if (notifiedApprovals.has(card.id)) continue;
        notifiedApprovals.add(card.id);
        notify?.("space", { title: i18nText("safety.approvalTitle"), body: i18nText("safety.approvalNotice", { agent: card.profile }), onClick: () => {
          open();
          if (send) send("botscreen", { t: "open-screen", profile: card.profile, approval: card.id });
        } });
      }
      const who = takenBy(holder, list);
      const st = list && Array.isArray(list.spaces) ? list.spaces.find((x) => x && x.id === "host") || list.spaces[0] : null;
      holder = st && st.holder && st.holder !== "user" ? st.holder : null;
      if (who) notify?.("space", { title: i18nText("space.takenTitle"), body: i18nText("space.taken", { who }), onClick: open });
      for (const f of fallbackFor(prev, list))
        notify?.("space", { title: i18nText("space.takenTitle"), body: i18nText(f.to === "none" ? "space.noDesktop" : "space.fellBack", { who: f.who, reason: i18nText(`space.reason.${f.reason}`) }), onClick: open });
      prev = list;
    } catch {} finally {
      polling = false;
    }
  }
  const watch = watchMs > 0 ? setInterval(tick, watchMs) : null;
  if (watch) watch.unref?.();
  win.on("closed", () => {
    if (watch) clearInterval(watch);
    if (sv) sv.destroy();
  });
  return { hide: () => sv && sv.hide(), _test: { tick, target, levelFor } };
}

module.exports = { initSpaces };
