"use strict";
// Portable browser state transfer. Keep this file byte-identical in app/main and relay/src.
// Only sealed ciphertext leaves memory; the caller owns consent, authenticated transport and routing.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sodium = require("libsodium-wrappers");
const TTL_MS = 300000, MAX_BYTES = 2 * 1024 * 1024;
const ID = /^(?:[a-f0-9]{8,64}|fallback)$/, SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REASONS = new Set(["manual", "sleep", "checkpoint"]);
const META = ["version", "source", "target", "slug", "createdAt", "expiresAt", "publicKey", "reason"];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const object = v => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v, max = 65536) => typeof v === "string" && v.length <= max;
function check(ok, message = "Invalid browser state") { if (!ok) throw new Error(message); }
function url(v) {
  check(text(v, 4096), "Invalid browser state URL");
  let u; try { u = new URL(v); } catch { throw new Error("Invalid browser state URL"); }
  check(["http:", "https:"].includes(u.protocol) && !u.username && !u.password, "Invalid browser state URL");
  return u;
}
function base64(v, length) {
  check(text(v, MAX_BYTES * 2) && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v), "Invalid bundle key or ciphertext");
  const b = Buffer.from(v, "base64");
  check(b.toString("base64") === v && (!length || b.length === length), "Invalid bundle key or ciphertext");
  return b;
}
function storage(v) {
  check(object(v) && Object.keys(v).length <= 1000);
  for (const [k, value] of Object.entries(v)) check(text(k, 4096) && text(value));
}
function cookie(c) {
  check(object(c) && text(c.name, 4096) && text(c.value) && text(c.domain, 253) && /^\.?[a-zA-Z0-9_.:-]+$/.test(c.domain) && text(c.path, 4096) && c.path.startsWith("/"));
  check(Object.keys(c).every(k => ["name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite", "priority", "sourceScheme", "sourcePort", "partitionKey"].includes(k)));
  for (const k of ["httpOnly", "secure"]) if (c[k] !== undefined) check(typeof c[k] === "boolean");
  if (c.expires !== undefined) check(Number.isFinite(c.expires) && c.expires >= -1);
  if (c.sameSite !== undefined) check(["Strict", "Lax", "None"].includes(c.sameSite));
  if (c.priority !== undefined) check(["Low", "Medium", "High"].includes(c.priority));
  if (c.sourceScheme !== undefined) check(["Unset", "NonSecure", "Secure"].includes(c.sourceScheme));
  if (c.sourcePort !== undefined) check(Number.isInteger(c.sourcePort) && c.sourcePort >= -1 && c.sourcePort <= 65535);
  if (c.partitionKey !== undefined) {
    check(object(c.partitionKey) && typeof c.partitionKey.hasCrossSiteAncestor === "boolean");
    url(c.partitionKey.topLevelSite);
  }
}
function validateState(s) {
  check(object(s) && s.version === 1 && Array.isArray(s.contexts) && s.contexts.length > 0 && s.contexts.length <= 20);
  if (s.controller !== undefined) check(["agent", "user"].includes(s.controller));
  let tabs = 0;
  const ids = new Set();
  for (const c of s.contexts) {
    check(object(c) && text(c.id, 128) && !ids.has(c.id) && Array.isArray(c.cookies) && c.cookies.length <= 5000 && Array.isArray(c.tabs) && c.tabs.length > 0);
    ids.add(c.id); c.cookies.forEach(cookie);
    const origins = new Map();
    for (const t of c.tabs) {
      check(object(t)); const u = t.url === "about:blank" ? { origin: "null" } : url(t.url);
      if (t.url === "about:blank") check(Object.keys(t.localStorage || {}).length === 0 && Object.keys(t.sessionStorage || {}).length === 0 && Array.isArray(t.forms) && t.forms.length === 0);
      storage(t.localStorage); storage(t.sessionStorage);
      // localStorage belongs to an origin in a context; sessionStorage belongs to each tab.
      const local = JSON.stringify(Object.entries(t.localStorage).sort(([a], [b]) => a.localeCompare(b)));
      check(!origins.has(u.origin) || origins.get(u.origin) === local); origins.set(u.origin, local);
      check(Array.isArray(t.forms) && t.forms.length <= 500 && object(t.scroll) && Number.isFinite(t.scroll.x) && Number.isFinite(t.scroll.y) && Math.abs(t.scroll.x) <= 100000000 && Math.abs(t.scroll.y) <= 100000000);
      const indices = new Set();
      for (const f of t.forms) {
        check(object(f) && Number.isInteger(f.index) && f.index >= 0 && f.index < 10000 && !indices.has(f.index) && ["INPUT", "TEXTAREA", "SELECT"].includes(f.tag) && text(f.type, 32) && !["password", "file"].includes(f.type.toLowerCase()) && text(f.id, 4096) && text(f.name, 4096) && text(f.value) && typeof f.checked === "boolean");
        if (f.selected !== undefined) check(f.tag === "SELECT" && Array.isArray(f.selected) && f.selected.length <= 1000 && f.selected.every(i => Number.isInteger(i) && i >= 0 && i < 10000));
        indices.add(f.index);
      }
      check(++tabs <= 100);
    }
  }
  check(Buffer.byteLength(JSON.stringify(s)) <= MAX_BYTES);
  return s;
}

async function loadIdentity(file, { protect = s => Buffer.from(s), unprotect = b => b.toString("utf8") } = {}) {
  await sodium.ready;
  const read = async () => {
    try {
      const stat = fs.lstatSync(file); check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16384);
      if (process.platform !== "win32") fs.chmodSync(file, 0o600);
      const k = JSON.parse(await unprotect(fs.readFileSync(file)));
      check(k.version === 1); const publicKey = base64(k.publicKey, 32), privateKey = base64(k.privateKey, 32);
      check(sodium.memcmp(sodium.crypto_scalarmult_base(privateKey), publicKey));
      return { publicKey: k.publicKey, privateKey: new Uint8Array(privateKey) };
    } catch { throw new Error("Browser transfer identity could not be opened"); }
  };
  if (fs.existsSync(file)) return read();
  const k = sodium.crypto_box_keypair();
  const publicKey = Buffer.from(k.publicKey).toString("base64");
  const plain = JSON.stringify({ version: 1, publicKey, privateKey: Buffer.from(k.privateKey).toString("base64") });
  let protectedBytes;
  try { protectedBytes = await protect(plain); check(Buffer.isBuffer(protectedBytes) || protectedBytes instanceof Uint8Array); }
  catch { throw new Error("Browser transfer identity could not be protected"); }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, protectedBytes, { mode: 0o600, flag: "wx" }); }
  catch (e) { if (e.code === "EEXIST") return read(); throw new Error("Browser transfer identity could not be saved"); }
  return { publicKey, privateKey: k.privateKey };
}
function validateEnvelope(e, now) {
  check(object(e) && e.version === 1 && text(e.source, 64) && ID.test(e.source) && text(e.target, 64) && ID.test(e.target) && e.source !== e.target && text(e.slug, 64) && SLUG.test(e.slug) && REASONS.has(e.reason), "Invalid browser bundle metadata");
  check(Number.isSafeInteger(now) && Number.isSafeInteger(e.createdAt) && Number.isSafeInteger(e.expiresAt) && e.expiresAt - e.createdAt === TTL_MS && e.createdAt <= now + 30000 && now < e.expiresAt, "Browser bundle expired or invalid time");
  base64(e.publicKey, 32);
  check(typeof e.sha256 === "string" && /^[a-f0-9]{64}$/.test(e.sha256), "Invalid browser bundle checksum");
  const bytes = base64(e.ciphertext); check(bytes.length >= 48 && bytes.length <= MAX_BYTES + 2048, "Invalid browser bundle size");
  const hash = crypto.createHash("sha256").update(bytes).digest();
  check(crypto.timingSafeEqual(hash, Buffer.from(e.sha256, "hex")), "Browser bundle checksum mismatch");
  return bytes;
}
async function sealBundle(state, { source, target, slug, publicKey, reason = "manual", now = Date.now() }) {
  await sodium.ready; validateState(state);
  check(text(source, 64) && ID.test(source) && text(target, 64) && ID.test(target) && source !== target && text(slug, 64) && SLUG.test(slug) && REASONS.has(reason) && Number.isSafeInteger(now), "Invalid browser bundle metadata");
  const meta = { version: 1, source, target, slug, createdAt: now, expiresAt: now + TTL_MS, publicKey, reason };
  const plaintext = Buffer.from(JSON.stringify({ ...meta, state }));
  let bytes;
  try { bytes = Buffer.from(sodium.crypto_box_seal(plaintext, base64(publicKey, 32))); }
  finally { plaintext.fill(0); }
  return { ...meta, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), ciphertext: bytes.toString("base64") };
}
async function openBundle(envelope, identity, { deviceId, now = Date.now() }) {
  await sodium.ready;
  const bytes = validateEnvelope(envelope, now);
  check(envelope.target === deviceId && identity.publicKey === envelope.publicKey, "Browser bundle target key mismatch");
  let plaintext;
  try {
    plaintext = sodium.crypto_box_seal_open(bytes, base64(identity.publicKey, 32), identity.privateKey);
    const inner = JSON.parse(Buffer.from(plaintext).toString("utf8"));
    check(META.every(k => inner[k] === envelope[k]), "Browser bundle metadata mismatch");
    return validateState(inner.state);
  } catch { throw new Error("Browser bundle could not be opened or validated"); }
  finally { if (plaintext) sodium.memzero(plaintext); }
}

const SNAPSHOT = `(() => {
  const values = store => Object.fromEntries(Array.from({length:store.length},(_,i)=>store.key(i)).map(k=>[k,store.getItem(k)]));
  const forms = Array.from(document.querySelectorAll('input,textarea,select')).flatMap((e,index) => {
    if (e.type === 'file' || e.type === 'password') return [];
    const f = {index,tag:e.tagName,type:e.type || '',id:e.id || '',name:e.name || '',value:e.value,checked:!!e.checked};
    if(e.tagName==='SELECT') f.selected=Array.from(e.options).flatMap((o,i)=>o.selected?[i]:[]);
    return [f];
  });
  return {url:location.href,localStorage:values(localStorage),sessionStorage:values(sessionStorage),forms,scroll:{x:scrollX,y:scrollY}};
})()`;
function connection(browser, CdpClient) {
  check(browser && Number.isInteger(browser.port) && browser.port > 0 && browser.port < 65536 && /^\/devtools\/browser\/[\w-]+$/.test(browser.wsPath), "Browser transfer requires a running agent browser");
  return new CdpClient(`ws://127.0.0.1:${browser.port}${browser.wsPath}`);
}
async function evaluate(cdp, session, expression, timeoutMs = 5000) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session, timeoutMs);
  check(!r.exceptionDetails && r.result && Object.prototype.hasOwnProperty.call(r.result, "value"), "Browser state evaluation failed");
  return r.result.value;
}
async function exportState(browser, CdpClient = require("./cdp-view").CdpClient) {
  const cdp = connection(browser, CdpClient);
  let phase = "connection";
  try {
    await cdp.connect(5000);
    phase = "tab discovery";
    const { targetInfos } = await cdp.send("Target.getTargets"); check(Array.isArray(targetInfos));
    const contexts = new Map();
    for (const t of targetInfos) {
      if (t.type !== "page" || t.url === "about:blank" || /^(?:chrome|devtools|chrome-extension|chrome-untrusted|chrome-search):/i.test(t.url || "")) continue;
      url(t.url); const id = t.browserContextId || "default";
      if (!contexts.has(id)) {
        phase = "cookies";
        const { cookies } = await cdp.send("Storage.getCookies", t.browserContextId ? { browserContextId: t.browserContextId } : {});
        check(Array.isArray(cookies));
        const fields = ["name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite", "priority", "sourceScheme", "sourcePort", "partitionKey"];
        contexts.set(id, { id, cookies: cookies.map(c => Object.fromEntries(fields.filter(k => c[k] !== undefined).map(k => [k, c[k]]))), tabs: [] });
      }
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      check(typeof sessionId === "string");
      phase = "page state";
      try { contexts.get(id).tabs.push(await evaluate(cdp, sessionId, SNAPSHOT)); }
      finally { await cdp.send("Target.detachFromTarget", { sessionId }); }
    }
    // An empty/new browser still moves; opaque internal pages become a fresh blank tab, with no secrets.
    if (!contexts.size) contexts.set("default", { id: "default", cookies: [], tabs: [{ url: "about:blank", localStorage: {}, sessionStorage: {}, forms: [], scroll: { x: 0, y: 0 } }] });
    phase = "state validation";
    return validateState({ version: 1, controller: browser.controller || "agent", contexts: [...contexts.values()] });
  } catch { throw new Error(`Browser state export failed during ${phase}`); }
  finally { cdp.close(); }
}
function storageScript(tab, marker) {
  const origin = url(tab.url).origin;
  return `(() => {if(location.origin!==${JSON.stringify(origin)})return;const s=${JSON.stringify({ localStorage: tab.localStorage, sessionStorage: tab.sessionStorage })};for(const name of ['localStorage','sessionStorage']) {window[name].clear();for(const [k,v] of Object.entries(s[name]))window[name].setItem(k,v);}Object.defineProperty(window,${JSON.stringify(marker)},{value:true,configurable:true});})()`;
}
function formScript(tab) {
  return `(() => {if(location.href!==${JSON.stringify(tab.url)})throw Error('Restored page URL changed');const forms=${JSON.stringify(tab.forms)},all=document.querySelectorAll('input,textarea,select');
    const elements=forms.map(f=>{let e=all[f.index];if(!e||e.tagName!==f.tag||e.type!==f.type||e.id!==f.id||e.name!==f.name||e.type==='password'||e.type==='file'||(f.selected&&f.selected.some(i=>i>=e.options.length)))return null;return e;});
    if(elements.some(e=>!e))return false;
    forms.forEach((f,i)=>{const e=elements[i];if(f.selected){for(let j=0;j<e.options.length;j++)e.options[j].selected=f.selected.includes(j);}else{e.value=f.value;e.checked=f.checked;}});
    window.scrollTo(${tab.scroll.x},${tab.scroll.y});return Math.abs(scrollX-${tab.scroll.x})<=1&&Math.abs(scrollY-${tab.scroll.y})<=1;})()`;
}
async function poll(cdp, session, expression) {
  // ponytail: bounded DOM polling; add site-specific readiness only when an actual page needs it.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, session, expression, Math.min(1000, deadline - Date.now())) === true) return;
    await sleep(50);
  }
  throw new Error("Browser restore readiness timed out");
}
async function importState(browser, state, CdpClient = require("./cdp-view").CdpClient) {
  validateState(state);
  const cdp = connection(browser, CdpClient), contexts = [], tabs = [];
  try {
    await cdp.connect(5000);
    for (const context of state.contexts) {
      const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: false });
      check(typeof browserContextId === "string", "Browser restore context failed"); contexts.push(browserContextId);
      const cookies = context.cookies.map(c => { const p = { ...c }; if (p.expires <= 0) delete p.expires; return p; });
      await cdp.send("Storage.setCookies", { browserContextId, cookies });
      for (const tab of context.tabs) {
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId, background: true });
        check(typeof targetId === "string", "Browser restore tab failed"); tabs.push(targetId);
        if (tab.url === "about:blank") continue; // no origin storage or form state exists on a blank page
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
        check(typeof sessionId === "string", "Browser restore session failed");
        try {
          await cdp.send("Page.enable", {}, sessionId);
          const marker = "__deckTransfer" + crypto.randomBytes(8).toString("hex");
          const { identifier } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: storageScript(tab, marker) }, sessionId);
          check(typeof identifier === "string", "Browser restore storage failed");
          const navigation = await cdp.send("Page.navigate", { url: tab.url }, sessionId);
          check(!navigation.errorText, "Browser restore navigation failed");
          await poll(cdp, sessionId, `(location.href===${JSON.stringify(tab.url)} && window[${JSON.stringify(marker)}]===true && ['interactive','complete'].includes(document.readyState))`);
          // Remove it after this load: future same-origin navigations must retain the site's current state.
          await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }, sessionId);
          await evaluate(cdp, sessionId, `delete window[${JSON.stringify(marker)}]`);
          await poll(cdp, sessionId, formScript(tab));
        } finally { await cdp.send("Target.detachFromTarget", { sessionId }); }
      }
    }
    return { contexts, tabs };
  } catch {
    for (const browserContextId of contexts) { try { await cdp.send("Target.disposeBrowserContext", { browserContextId }); } catch { /* browser may already be gone */ } }
    throw new Error("Browser restore failed; imported contexts were discarded");
  } finally { cdp.close(); }
}
module.exports = { loadIdentity, sealBundle, openBundle, exportState, importState, validateState, validateEnvelope, TTL_MS, MAX_BYTES };
