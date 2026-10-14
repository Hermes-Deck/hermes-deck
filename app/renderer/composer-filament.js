"use strict";
// Composer thinking filament (iOS parity, ChatFilament.swift): a 1.5px brass line that follows only the card's upper
// outline - from the end of the straight left side, through the top-left corner, along the top edge, through the
// top-right corner - and never down the sides. Moving while a turn works, static with faded ends while a decision
// waits or under reduced motion, hidden when idle. Pure geometry here; composer.js owns the element's life cycle.
(function (root) {
  const SVG = "http://www.w3.org/2000/svg";
  const LINE = 1.5, SEGMENT = 0.4, END_FADE = 0.08, SLICES = 12, STATIC_OPACITY = 0.55;
  const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

  /** Arc of the card's upper outline for a w x h border box, corner radius r, border width bw. */
  function geometry(w, h, r, bw = 1, lw = LINE) {
    w = Math.max(0, num(w)); h = Math.max(0, num(h)); r = Math.max(0, num(r)); bw = Math.max(0, num(bw, 1));
    const inset = bw + lw / 2;
    const iw = w - 2 * inset, ih = h - 2 * inset;
    if (iw < 2 || ih < 2) return { ok: false, w, d: "", length: 0, inset, radius: 0, start: [inset, inset], end: [inset, inset] };
    const radius = Math.max(0, Math.min(r - inset, iw / 2, ih / 2));
    const y0 = inset + radius;
    const left = inset, right = w - inset, top = inset;
    const d = radius > 0.01
      ? `M${left} ${y0}A${radius} ${radius} 0 0 1 ${left + radius} ${top}H${right - radius}A${radius} ${radius} 0 0 1 ${right} ${y0}`
      : `M${left} ${top}H${right}`;
    const length = Math.max(0, iw - 2 * radius) + Math.PI * radius;
    return { ok: true, w, d, length, inset, radius, start: [left, radius > 0.01 ? y0 : top], end: [right, radius > 0.01 ? y0 : top] };
  }

  /** x coordinate of the arc point at fraction f (0..1 of arc length); the arc is monotone in x. */
  function xAt(g, f) {
    if (!g.ok) return g.inset;
    const s = Math.min(Math.max(f, 0), 1) * g.length, R = g.radius, quarter = Math.PI * R / 2;
    const fromLeft = s <= g.length / 2 ? s : g.length - s;
    const x = fromLeft < quarter ? g.inset + R * (1 - Math.cos(fromLeft / R)) : g.inset + R + (fromLeft - quarter);
    return s <= g.length / 2 ? x : g.w - x;
  }

  /** Which look the filament has: "moving" | "static" | "hidden". */
  function state({ working = false, waiting = false, reduced = false } = {}) {
    if (waiting) return "static";
    if (working) return reduced ? "static" : "moving";
    return "hidden";
  }

  /** Dash slices that build the soft-ended moving segment: [{len, o0, o1, opacity}] in path-length units (pathLength=1). */
  function slices(n = SLICES) {
    const len = SEGMENT / n, out = [];
    for (let k = 0; k < n; k++) {
      // The head runs 0 -> 1 + SEGMENT; slice k trails the head by SEGMENT - k * len.
      const back = SEGMENT - k * len;
      out.push({ len, o0: back, o1: back - (1 + SEGMENT), opacity: Math.sin(Math.PI * (k + 0.5) / n) });
    }
    return out;
  }

  /** Builds the SVG overlay. Returns { el, update(w, h, r, bw), setState(s) }. */
  function create(doc) {
    const mk = (tag, attrs = {}) => { const e = doc.createElementNS(SVG, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
    const svg = mk("svg", { class: "conv-fil-svg", "aria-hidden": "true", focusable: "false" });
    const defs = mk("defs"), grad = mk("linearGradient", { id: "conv-fil-fade", gradientUnits: "userSpaceOnUse", x1: "0", y1: "0", y2: "0" });
    const mask = mk("mask", { id: "conv-fil-mask", maskUnits: "userSpaceOnUse", x: "0", y: "0" });
    const maskRect = mk("rect", { x: "0", y: "0", fill: "url(#conv-fil-fade)" });
    mask.style.setProperty("mask-type", "alpha"); // only the stops' opacity counts: no colour needed
    mask.append(maskRect); defs.append(grad, mask); svg.append(defs);
    const group = mk("g", { class: "conv-fil-g", mask: "url(#conv-fil-mask)" });
    const whole = mk("path", { class: "conv-fil-whole", pathLength: "1", fill: "none", "stroke-width": String(LINE), "stroke-linecap": "butt" });
    group.append(whole);
    const parts = slices().map((s, k) => {
      const p = mk("path", { class: "conv-fil-slice", pathLength: "1", fill: "none", "stroke-width": String(LINE), "stroke-linecap": "butt", "stroke-dasharray": `${s.len.toFixed(5)} 3`, opacity: s.opacity.toFixed(3) });
      p.style.setProperty("--o0", s.o0.toFixed(5)); p.style.setProperty("--o1", s.o1.toFixed(5));
      group.append(p); return p;
    });
    svg.append(group);
    function update(w, h, r, bw) {
      const g = geometry(w, h, r, bw);
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`); svg.setAttribute("width", String(w)); svg.setAttribute("height", String(h));
      for (const p of [whole, ...parts]) p.setAttribute("d", g.d);
      svg.style.setProperty("display", g.ok ? "" : "none");
      maskRect.setAttribute("width", String(w)); maskRect.setAttribute("height", String(h));
      mask.setAttribute("width", String(w)); mask.setAttribute("height", String(h));
      grad.setAttribute("x2", String(w));
      grad.replaceChildren();
      if (g.ok && w > 0) {
        const at = f => (xAt(g, f) / w);
        const stops = [[0, 0], [at(END_FADE), 1], [at(1 - END_FADE), 1], [1, 0]];
        stops[0][0] = at(0); stops[3][0] = at(1);
        for (const [o, a] of stops) grad.append(mk("stop", { offset: o.toFixed(4), "stop-opacity": String(a) }));
      }
      return g;
    }
    function setState(s) { svg.dataset.state = s; }
    return { el: svg, update, setState, parts, whole };
  }

  const api = { LINE, SEGMENT, END_FADE, SLICES, STATIC_OPACITY, geometry, xAt, state, slices, create };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DeckFilament = Object.freeze(api);
})(typeof window === "object" ? window : globalThis);
