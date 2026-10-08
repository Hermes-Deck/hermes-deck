"use strict";
// Deterministic DOM stand-in for mounted conversation tests. It is not browser or visual evidence: it models only
// the DOM features composer.js, receipts.js and timeline.js use (childList mutations with real observer delivery,
// bubbling events, focus moving to <body> when a focused node leaves the document, per-element rectangles).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function environment({ session: initial } = {}) {
  const frames = [], timers = [], observers = [], bridge = [], relay = [], shellListeners = new Map(), lastEvents = new Map();
  let clock = 1_000_000;
  let pendingMutations = 0;
  function notify(target, added, removed) {
    for (const o of observers) {
      if (!o.targets.some(t => t.el === target || (t.subtree && t.el.contains(target)))) continue;
      o.queue.push({ type: "childList", target, addedNodes: added, removedNodes: removed });
      pendingMutations++;
    }
  }
  class Element {
    constructor(tag, text = null) {
      this.tagName = tag.toUpperCase(); this.nodeType = text == null ? 1 : 3; this.nodeValue = text; this.childNodes = []; this.parentNode = null;
      this.attrs = {}; this.dataset = {}; this.listeners = new Map(); this.scrollTop = 0; this.scrollHeight = 1000; this.value = "";
      this.rect = { top: 0, bottom: 500, height: 500, left: 0, right: 600, width: 600 };
      const props = new Map();
      this.style = { setProperty: (k, v) => props.set(k, String(v)), getPropertyValue: k => props.get(k) || "" };
    }
    get ownerDocument() { return doc; }
    get children() { return this.childNodes.filter(n => n.nodeType === 1); }
    get firstChild() { return this.childNodes[0] || null; }
    get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(n => n.textContent).join(""); }
    set textContent(v) { if (this.nodeType === 3) this.nodeValue = String(v); else this.replaceChildren(String(v)); }
    get className() { return this.attrs.class || ""; } set className(v) { this.attrs.class = String(v); }
    get id() { return this.attrs.id || ""; }
    get classList() {
      const el = this, list = () => el.className.split(/\s+/).filter(Boolean);
      return { contains: c => list().includes(c), add: (...cs) => { el.className = [...new Set([...list(), ...cs])].join(" "); },
        remove: (...cs) => { el.className = list().filter(x => !cs.includes(x)).join(" "); },
        toggle: (c, on = !list().includes(c)) => { el.className = list().filter(x => x !== c).concat(on ? [c] : []).join(" "); return on; } };
    }
    get isConnected() { return this === doc || this === doc.body || !!this.parentNode?.isConnected; }
    get nextElementSibling() { const kids = this.parentNode?.children || []; return kids[kids.indexOf(this) + 1] || null; }
    get previousElementSibling() { const kids = this.parentNode?.children || []; return kids[kids.indexOf(this) - 1] || null; }
    node(n) { return typeof n === "object" ? n : new Element("#text", String(n)); }
    detach() {
      const p = this.parentNode;
      if (!p) return;
      if (this.nodeType === 1 && this.contains(doc.activeElement)) doc.activeElement = doc.body;
      p.childNodes.splice(p.childNodes.indexOf(this), 1); this.parentNode = null;
      notify(p, [], [this]);
    }
    insertBefore(n, before) {
      n = this.node(n); n.detach();
      const i = before ? this.childNodes.indexOf(before) : -1;
      this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n); n.parentNode = this;
      notify(this, [n], []);
      return n;
    }
    appendChild(n) { return this.insertBefore(n, null); }
    append(...nodes) { nodes.flat(Infinity).filter(x => x != null && x !== false).forEach(n => this.appendChild(n)); }
    prepend(...nodes) { const first = this.childNodes[0] || null; nodes.flat(Infinity).filter(x => x != null && x !== false).forEach(n => this.insertBefore(n, first)); }
    after(...nodes) { const next = this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null; nodes.forEach(n => this.parentNode.insertBefore(n, next)); }
    replaceChildren(...nodes) { for (const n of [...this.childNodes]) n.detach(); this.append(...nodes); }
    replaceWith(n) { this.parentNode.insertBefore(n, this); this.detach(); }
    remove() { this.detach(); }
    matches(selector) {
      if (this.nodeType !== 1) return false;
      return selector.split(/,\s*/).some(part => {
        part = part.trim();
        if (/\s/.test(part.replace(/:not\([^)]*\)|\[[^\]]*\]/g, ""))) {
          const pieces = part.split(/\s+(?![^[]*\])(?![^(]*\))/);
          if (!this.matches(pieces.pop())) return false;
          for (let p = this.parentNode; p && p !== doc; p = p.parentNode) if (p.matches(pieces.join(" "))) return true;
          return false;
        }
        const excludes = [...part.matchAll(/:not\(([^)]+)\)/g)].map(m => m[1]);
        if (excludes.some(x => this.matches(x))) return false;
        part = part.replace(/:not\([^)]+\)/g, "");
        for (const [, key, value] of part.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
          const own = key.startsWith("data-") ? this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : key in this.attrs ? this.attrs[key] : this[key] ? "" : undefined;
          if (value == null ? own === undefined || own === false : String(own) !== value) return false;
        }
        part = part.replace(/\[[^\]]+\]/g, "");
        const tag = part.match(/^[a-z][a-z0-9]*/i)?.[0];
        if (tag && tag.toUpperCase() !== this.tagName) return false;
        const id = part.match(/#([\w-]+)/)?.[1]; if (id && this.attrs.id !== id) return false;
        return [...part.matchAll(/\.([\w-]+)/g)].every(m => this.classList.contains(m[1]));
      });
    }
    closest(s) { for (let el = this; el && el !== doc; el = el.parentNode) if (el.matches(s)) return el; return null; }
    querySelectorAll(s) { return this.children.flatMap(n => [...(n.matches(s) ? [n] : []), ...n.querySelectorAll(s)]); }
    querySelector(s) { return this.querySelectorAll(s)[0] || null; }
    contains(n) { return !!n && (n === this || this.childNodes.some(c => c.contains(n))); }
    setAttribute(k, v) {
      if (k.startsWith("data-")) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
      this.attrs[k] = String(v);
      if (k === "hidden" || k === "disabled" || k === "open") this[k] = true;
    }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(k, fn) { if (!this.listeners.has(k)) this.listeners.set(k, []); this.listeners.get(k).push(fn); }
    removeEventListener(k, fn) { const l = this.listeners.get(k) || []; if (l.includes(fn)) l.splice(l.indexOf(fn), 1); }
    dispatchEvent(e) {
      if (!e.target) e.target = this;
      for (let el = this; el; el = el === doc ? null : el.parentNode || (el === doc.body ? doc : null)) {
        for (const fn of [...(el.listeners.get(e.type) || [])]) fn.call(el, e);
        if (e.bubbles === false) break;
      }
      return !e.defaultPrevented;
    }
    click() { if (!this.disabled) this.dispatchEvent(event("click", { target: this })); if (this.tagName === "SUMMARY" && this.parentNode?.tagName === "DETAILS") { this.parentNode.open = !this.parentNode.open; this.parentNode.dispatchEvent(event("toggle", { bubbles: false })); } }
    focus() { doc.activeElement = this; this.dispatchEvent(event("focusin", { target: this })); }
    blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
    getBoundingClientRect() { return { ...this.rect }; }
    setPointerCapture(id) { this.captured = id; } hasPointerCapture(id) { return this.captured === id; } releasePointerCapture() { this.captured = null; }
    scrollTo({ top }) { this.scrollTop = top; this.dispatchEvent(event("scroll", { bubbles: false })); }
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  }
  function event(type, props = {}) {
    return { type, bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...props };
  }
  const doc = new Element("#document");
  doc.hidden = false;
  const h = (tag, attrs, ...kids) => {
    const el = new Element(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "style") for (const [p, x] of Object.entries(v)) el.style.setProperty(p, x);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = String(v);
      else el.setAttribute(k, v);
    }
    el.append(...kids);
    return el;
  };
  doc.body = h("body"); doc.body.parentNode = doc; doc.childNodes.push(doc.body); doc.activeElement = doc.body;
  doc.getElementById = id => doc.body.querySelector(`#${id}`);
  doc.createElement = tag => new Element(tag);
  const chat = h("main", { id: "chat" }), inner = h("div", { id: "msgs-inner" }), msgs = h("div", { id: "msgs" }, inner);
  const input = h("textarea", { id: "input" }); input.value = "Retained draft";
  const sends = [];
  const send = h("button", { id: "send", dataset: { kind: "queue" }, onclick: () => sends.push(input.value) });
  const composer = h("div", { class: "composer" }, input, send);
  const status = h("div", { id: "composer-status", hidden: true }), timeline = h("div", { id: "timeline", hidden: true });
  chat.append(timeline, msgs, status, composer, h("p", { id: "note", class: "composer-note" }));
  doc.body.append(chat);
  let session = initial || { id: "s", sid: "s", kind: "hermes", channel: "hermes", profile: "default" };
  lastEvents.set("session", session);
  let main = "chat";
  const opens = [], mutations = [], toolCalls = new Map(), details = new Map();
  let interruptResult = { status: "interrupted" };
  const shell = {
    service: name => name === "h" ? h : name === "chat" ? () => ({ title: "ExampleBot", agent: "Worker" }) : null,
    last: name => lastEvents.get(name) || null, main: () => main,
    mount: (name, el) => { const slot = doc.getElementById(name); if (!slot) throw new Error(`Unknown slot ${name}`); slot.replaceChildren(el); slot.hidden = !el; return slot; },
    openRight: (...a) => opens.push(a),
    on: (name, fn) => { if (!shellListeners.has(name)) shellListeners.set(name, []); shellListeners.get(name).push(fn); return () => {}; },
  };
  const win = {
    document: doc, DeckShell: shell, console,
    CustomEvent: class { constructor(type, { detail } = {}) { Object.assign(this, event(type), { detail }); } },
    MutationObserver: class {
      constructor(fn) { this.fn = fn; this.targets = []; this.queue = []; observers.push(this); }
      observe(el, opts = {}) { this.targets.push({ el, subtree: !!opts.subtree }); }
      disconnect() { this.targets = []; pendingMutations -= this.queue.length; this.queue = []; }
    },
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} },
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval() {},
    setTimeout: (fn) => { frames.push(fn); return frames.length; }, clearTimeout() {},
    matchMedia: () => ({ matches: true }),
    Date: Object.assign(function (...a) { return a.length ? new Date(...a) : new Date(clock); }, { now: () => clock }),
    deck: {
      bridge: {
        onEvent: fn => bridge.push(fn),
        interrupt: async (...args) => { mutations.push(args); if (interruptResult instanceof Error) throw interruptResult; return interruptResult; },
        toolCalls: async sid => toolCalls.get(sid) || [],
      },
      onRelay: fn => relay.push(fn),
      session: async sid => details.get(sid) || { recent: [] },
    },
  };
  win.window = win;
  const I18N = require("../renderer/i18n");
  if (!Object.prototype.hasOwnProperty.call(I18N.tables.en, "conv.stop")) I18N.extend(require("../renderer/i18n-b"));
  I18N.setLanguage?.("en");
  win.DeckI18n = I18N;
  const context = vm.createContext(win);
  function load(name) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, `../renderer/${name}.js`), "utf8"), context, { filename: `${name}.js` });
  }
  function deliver() {
    for (const o of observers) {
      if (!o.queue.length) continue;
      const records = o.queue; o.queue = []; pendingMutations -= records.length;
      o.fn(records, o);
    }
  }
  /** Run queued mutation callbacks and animation frames until quiet; a long chain is a repaint feedback loop. */
  function flush(limit = 40) {
    let n = 0;
    while (pendingMutations > 0 || frames.length) {
      if (++n > limit) throw new Error("Repaint loop");
      deliver();
      const batch = frames.splice(0);
      for (const fn of batch) fn(clock);
    }
    return n;
  }
  /** Await pending promise callbacks (bridge mocks), then flush. */
  async function settle() { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); return flush(); }
  function emitShell(name, payload) { lastEvents.set(name, payload); for (const fn of shellListeners.get(name) || []) fn(payload); }
  return {
    doc, win, h, chat, inner, msgs, composer, input, send, sends, bridge, relay, opens, mutations, observers, timers, frames, event, flush, settle, load,
    toolCalls, details, Element,
    get clock() { return clock; }, set clock(v) { clock = v; },
    set interruptResult(v) { interruptResult = v; }, set main(v) { main = v; },
    fire(type, detail) { doc.dispatchEvent(new win.CustomEvent(type, { detail })); },
    key(target, key, props = {}) { const e = event("keydown", { key, target, repeat: false, isComposing: false, ...props }); target.dispatchEvent(e); return e; },
    select(s) { session = s; emitShell("session", s); },
    emitShell,
    bridgeEvent(e) { bridge.forEach(fn => fn(e)); },
    relayEvent(e) { relay.forEach(fn => fn(e)); },
    session: () => session,
  };
}
/** Mount the conversation modules over a one-turn transcript. */
function boot(opts) {
  const env = environment(opts);
  const { h, inner } = env;
  env.user = (text, extra = {}) => h("div", { class: "msg out", ...extra }, h("div", { class: "text" }, text));
  env.agent = (text, extra = {}) => h("div", { class: "msg", ...extra }, h("div", { class: "text" }, text));
  inner.append(env.user("hello"), env.agent("reply"));
  for (const m of ["live-activity", "composer", "receipts", "timeline"]) env.load(m);
  env.flush();
  return env;
}
module.exports = { environment, boot };
