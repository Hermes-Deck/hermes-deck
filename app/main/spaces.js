"use strict";
// Agent spaces in the Deck (docs/agent-spaces.md): the space's status from
// the relay, the user's control level, "Work on this device" / "Send back to its space", the mode, and where the
// viewer view sits. Every call goes to the relay with its token (relayFetch, the Bot screen's).
const { createSpaceView } = require("./space-view");
const { levelOk, takenBy } = require("./space-view-logic");
const { t: i18nText } = require("../renderer/i18n");

const WATCH_MS = 5000; // how often the Deck asks the relay who holds the shared desktop (for the notification)

const PROFILE_RE = /^[A-Za-z0-9._-]{1,64}$/;

function initSpaces({ ipc, win, relayCfg, relayFetch, deviceId, settings, notify = null, send = null }) {
  let sv = null;
  const view = () =>
    (sv ||= createSpaceView({
      win,
      relayBase: () => (relayCfg() || {}).http || "http://127.0.0.1:9",
      relayToken: () => (relayCfg() || {}).token || "",
    }));
  const body = async (r) => {
    const b = await r.json().catch(() => ({}));
    if (!r.ok && !b.error) b.error = `Relay: HTTP ${r.status}`;
    return b;
  };
  const defaultLevel = () => {
    const l = settings.data.spaces && settings.data.spaces.defaultLevel;
    return levelOk(l) ? l : "watch";
  };

  ipc.handle("spaces:list", async () => {
    if (!relayCfg()) return { mode: null, spaces: [], defaultLevel: defaultLevel() };
    const r = await relayFetch("GET", "/spaces");
    if (r.status === 404) return { mode: null, spaces: [], defaultLevel: defaultLevel() }; // relay without spaces
    return { ...(await body(r)), defaultLevel: defaultLevel(), deviceId: deviceId() };
  });
  ipc.handle("spaces:control", async (_e, level) => {
    const l = level === "release" ? "release" : levelOk(level) ? level : null;
    if (!l) throw new Error("bad level");
    const out = await body(await relayFetch("POST", "/spaces/control", { level: l }));
    if (sv) await sv.setLevel(l === "release" ? "watch" : l);
    return out;
  });
  ipc.handle("spaces:route", async (_e, profile, target) => {
    if (!PROFILE_RE.test(String(profile || ""))) throw new Error("bad profile");
    const t = target === "device" ? `device:${deviceId()}` : "space";
    return body(await relayFetch("POST", "/spaces/route", { profile, target: t }));
  });
  ipc.handle("spaces:mode", async (_e, mode) => {
    if (mode !== "shared" && mode !== "agent") throw new Error("bad mode");
    return body(await relayFetch("POST", "/spaces/mode", { mode }));
  });
  ipc.handle("spaces:view", async (_e, rect, level) => {
    const ok = rect && [rect.x, rect.y, rect.width, rect.height].every((n) => Number.isFinite(n)) && rect.width >= 40 && rect.height >= 40;
    if (!ok) return void (sv && sv.hide());
    const v = view();
    await v.setLevel(levelOk(level) ? level : defaultLevel());
    await v.show(rect);
  });
  // a desktop notification when an agent takes the shared desktop (shown while the Deck is in the background);
  // clicking it opens the Bot screen tab
  let holder = null;
  const watch = setInterval(async () => {
    if (!relayCfg() || !notify) return;
    try {
      const r = await relayFetch("GET", "/spaces");
      if (!r.ok) return;
      const list = await r.json();
      const who = takenBy(holder, list);
      const st = list && Array.isArray(list.spaces) ? list.spaces[0] : null;
      holder = st && st.holder && st.holder !== "user" ? st.holder : null;
      if (who)
        notify("space", {
          title: i18nText("space.takenTitle"),
          body: i18nText("space.taken", { who }),
          onClick: () => {
            if (win.isDestroyed()) return;
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
            if (send) send("botscreen", { t: "open-screen" });
          },
        });
    } catch {}
  }, WATCH_MS);
  watch.unref?.();
  win.on("closed", () => {
    clearInterval(watch);
    if (sv) sv.destroy();
  });
  return { hide: () => sv && sv.hide() };
}

module.exports = { initSpaces };
