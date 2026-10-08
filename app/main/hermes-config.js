"use strict";
const { t: i18nText } = require("../renderer/i18n");
// Settings > Hermes config, main side: the relay's /hermes/* routes (relay/src/hermes-config.js) for the renderer.
// The renderer never sees the relay token or URL; it gets the relay's JSON answers. Every argument is checked here.
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,159}$/;
const MAX_CHANGES = 300;

/** The renderer's {key: value} changes and [key] resets, checked; throws on anything else. */
function checkSave(o) {
  const x = o && typeof o === "object" ? o : {};
  if (!PROFILE_RE.test(String(x.profile || ""))) throw new Error(i18nText("hcfg.badRequest"));
  if (typeof x.rev !== "string" || !/^[a-f0-9]{64}$/.test(x.rev)) throw new Error(i18nText("hcfg.badRequest"));
  const set = x.set && typeof x.set === "object" && !Array.isArray(x.set) ? x.set : {};
  const unset = Array.isArray(x.unset) ? x.unset : [];
  const keys = [...Object.keys(set), ...unset];
  if (!keys.length || keys.length > MAX_CHANGES || !keys.every((k) => typeof k === "string" && KEY_RE.test(k))) throw new Error(i18nText("hcfg.badRequest"));
  const plain = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);
  for (const v of Object.values(set)) if (!(plain(v) || (Array.isArray(v) && v.length <= 200 && v.every(plain)))) throw new Error(i18nText("hcfg.badRequest"));
  return { profile: x.profile, rev: x.rev, set, unset };
}

/** {ok, ...} from a relay answer: the relay's own error text when it refused. */
function answer({ status, body }) {
  if (status >= 200 && status < 300 && body && body.ok !== false) return { ...body, ok: true };
  const notThere = status === 404 && !(body && body.error);
  return { ok: false, status, error: notThere ? i18nText("hcfg.relayTooOld") : String((body && body.error) || `Relay: HTTP ${status}`) };
}

function register(ipc, getRelay) {
  const relay = () => {
    const r = getRelay();
    if (!r || typeof r.call !== "function") throw new Error(i18nText("U0235"));
    return r;
  };
  ipc.handle("hcfg:schema", async () => answer(await relay().call("GET", "/hermes/config/schema", undefined, 70000)));
  ipc.handle("hcfg:get", async (_e, profile) => {
    if (!PROFILE_RE.test(String(profile || ""))) throw new Error(i18nText("hcfg.badRequest"));
    return answer(await relay().call("GET", `/hermes/config?profile=${encodeURIComponent(profile)}`, undefined, 70000));
  });
  ipc.handle("hcfg:save", async (_e, o) => answer(await relay().call("POST", "/hermes/config", checkSave(o), 70000)));
  ipc.handle("hcfg:restart-state", async () => answer(await relay().call("GET", "/hermes/restart")));
  ipc.handle("hcfg:restart", async (_e, target) => {
    if (target !== "gateway" && target !== "relay") throw new Error(i18nText("hcfg.badRequest"));
    return answer(await relay().call("POST", "/hermes/restart", { target }));
  });
}

module.exports = { register, checkSave, answer };
