"use strict";
// Minimal DOM stand-in for renderer behavior tests; not browser or visual evidence.
function dom() {
  const doc = { activeElement: null, listeners: new Map(), addEventListener(type, fn) { this.listeners.set(type, fn); }, removeEventListener(type) { this.listeners.delete(type); }, dispatchEvent() {} };
  const walk = node => [node, ...(node.children || []).filter(x => x && typeof x === "object").flatMap(walk)];
  const h = (tag, attrs, ...kids) => {
    const node = { tag, tagName: tag.toUpperCase(), attrs: attrs || {}, dataset: attrs?.dataset || {}, style: {}, children: kids.flat(Infinity).filter(x => x != null), listeners: new Map(),
      contains(other) { return walk(this).includes(other); },
      setAttribute(key, value) { this.attrs[key] = value; },
      getAttribute(key) { return this.attrs[key]; },
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); },
      addEventListener(type, fn) { this.listeners.set(type, fn); },
      removeEventListener(type) { this.listeners.delete(type); },
      querySelectorAll(selector) { return walk(this).slice(1).filter(x => x.matches(selector)); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      matches(selector) { return selector.startsWith('[data-') ? Object.hasOwn(this.dataset, selector.slice(6, -1)) : selector.startsWith('.') ? selector.slice(1).split('.').every(c => (this.attrs.class || '').split(' ').includes(c)) : false; },
      closest() { return null; },
      focus() { doc.activeElement = this; },
      getBoundingClientRect() { return { left: 400, bottom: 40, width: 200 }; },
      scrollIntoView() {},
      remove() {},
      click() { return this.attrs.onclick?.({ target: this }); },
    };
    node.classList = { add(c) { if (!(node.attrs.class || '').split(' ').includes(c)) node.attrs.class = `${node.attrs.class || ''} ${c}`.trim(); }, remove(c) { node.attrs.class = (node.attrs.class || '').split(' ').filter(x => x !== c).join(' '); }, toggle(c, on) { if (on) this.add(c); else this.remove(c); }, contains(c) { return (node.attrs.class || '').split(' ').includes(c); } };
    return node;
  };
  doc.body = h("body"); doc.querySelector = selector => doc.body.querySelector(selector);
  const win = { innerWidth: 1280, listeners: new Map(), addEventListener(type, fn) { this.listeners.set(type, fn); }, removeEventListener(type) { this.listeners.delete(type); } };
  return { doc, win, h, walk, text: node => typeof node === "object" ? node.children.map(x => typeof x === "object" ? (x.textContent || walk(x).filter(n => typeof n === "object").flatMap(n => n.children.filter(c => typeof c !== "object")).join(' ')) : x).join(' ') : String(node) };
}
module.exports = { dom };
