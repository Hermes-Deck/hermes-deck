"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const F = require("../renderer/composer-filament.js");

const nums = d => d.match(/-?\d+(\.\d+)?/g).map(Number);

test("arc starts and ends at the corner radius height and never runs down the sides", () => {
  const w = 640, h = 120, r = 16, bw = 1;
  const g = F.geometry(w, h, r, bw);
  const inset = bw + F.LINE / 2;
  assert.equal(g.ok, true);
  assert.deepEqual(g.start, [inset, r]);
  assert.deepEqual(g.end, [w - inset, r]);
  // M left y0 A R R 0 0 1 x top H x A R R 0 0 1 right y0: only arcs and one horizontal line, no V/L commands.
  assert.match(g.d, /^M[\d.]+ [\d.]+A[\d. ]+H[\d.]+A[\d. ]+$/);
  assert.doesNotMatch(g.d, /[VLvl]/);
  const n = nums(g.d);
  const ys = [n[1], n[7], n[n.length - 1]];
  assert.ok(ys.every(y => y <= r + 1e-9), "no point lower than the end of the corners");
  assert.ok(Math.abs(g.length - ((w - 2 * inset - 2 * g.radius) + Math.PI * g.radius)) < 1e-9);
});

test("the radius follows the card and is clamped for tiny cards; degenerate sizes do not throw", () => {
  assert.equal(F.geometry(200, 100, 16, 1).radius, 16 - 1.75);
  const small = F.geometry(20, 20, 16, 1);
  assert.ok(small.radius <= 10 - 1.75 + 1e-9);
  for (const args of [[0, 0, 0], [NaN, NaN, NaN], [-5, 10, 16], [3, 3, 16], [Infinity, 40, 16], [100, 40, 0], [undefined, undefined, undefined]]) {
    const g = F.geometry(...args);
    if (!g.ok) assert.equal(g.d, "");
    assert.doesNotThrow(() => F.xAt(g, 0.5));
  }
  const square = F.geometry(100, 40, 0, 1);
  assert.equal(square.d, `M${square.inset} ${square.inset}H${100 - square.inset}`);
});

test("xAt maps arc fractions to x symmetrically from end to end", () => {
  const g = F.geometry(500, 90, 16, 1);
  assert.ok(Math.abs(F.xAt(g, 0) - g.inset) < 1e-9);
  assert.ok(Math.abs(F.xAt(g, 1) - (500 - g.inset)) < 1e-9);
  assert.ok(Math.abs(F.xAt(g, 0.5) - 250) < 1e-6);
  assert.ok(Math.abs(F.xAt(g, 0.2) + F.xAt(g, 0.8) - 500) < 1e-6);
  let prev = -1;
  for (let f = 0; f <= 1.0001; f += 0.05) { const x = F.xAt(g, f); assert.ok(x >= prev - 1e-9); prev = x; }
});

test("state mapping: working moves, waiting or reduced motion is static, idle is hidden", () => {
  assert.equal(F.state({ working: true }), "moving");
  assert.equal(F.state({ working: true, reduced: true }), "static");
  assert.equal(F.state({ waiting: true }), "static");
  assert.equal(F.state({ working: true, waiting: true }), "static");
  assert.equal(F.state({ waiting: true, reduced: true }), "static");
  assert.equal(F.state({}), "hidden");
  assert.equal(F.state(), "hidden");
  assert.equal(F.state({ reduced: true }), "hidden");
});

test("moving segment: slices cover 40 % of the arc, soft at both ends, and sweep the whole arc", () => {
  const s = F.slices();
  assert.equal(s.length, F.SLICES);
  assert.ok(Math.abs(s.reduce((a, x) => a + x.len, 0) - 0.4) < 1e-9);
  assert.ok(s[0].opacity < 0.2 && s[s.length - 1].opacity < 0.2);
  assert.ok(s[Math.floor(s.length / 2)].opacity > 0.95);
  for (const x of s) assert.ok(Math.abs(x.o0 - x.o1 - 1.4) < 1e-9, "head travels 0 -> 1 + segment");
  // Dash k starts at -offset: the segment tail is behind the head by 0.4 at the first frame and the head leaves at 1.
  assert.ok(Math.abs(-s[0].o0 + 0.4) < 1e-9);
  assert.ok(Math.abs(-s[s.length - 1].o0 + (0.4 - 0.4 * (s.length - 1) / s.length)) < 1e-9);
});

// Minimal SVG stand-in: enough for create() to build and update the tree.
function fakeDoc() {
  const el = tag => {
    const e = { tag, attrs: {}, children: [], style: { props: {}, setProperty(k, v) { this.props[k] = v; } }, dataset: {} };
    e.setAttribute = (k, v) => { e.attrs[k] = String(v); };
    e.append = (...c) => { e.children.push(...c); };
    e.replaceChildren = (...c) => { e.children = c; };
    return e;
  };
  return { createElementNS: (ns, tag) => { assert.equal(ns, "http://www.w3.org/2000/svg"); return el(tag); } };
}
const find = (e, tag, out = []) => { if (e.tag === tag) out.push(e); e.children.forEach(c => find(c, tag, out)); return out; };

test("create builds a fade mask and paths from the card size, with no HTML strings", () => {
  const f = F.create(fakeDoc());
  const g = f.update(600, 100, 16, 1);
  assert.equal(g.ok, true);
  const paths = find(f.el, "path");
  assert.equal(paths.length, 1 + F.SLICES);
  assert.ok(paths.every(p => p.attrs.d === g.d && p.attrs.pathLength === "1"));
  assert.ok(paths.slice(1).every(p => p.style.props["--o0"] !== undefined && p.style.props["--o1"] !== undefined));
  const stops = find(f.el, "stop");
  assert.equal(stops.length, 4);
  assert.deepEqual(stops.map(s => s.attrs["stop-opacity"]), ["0", "1", "1", "0"]);
  const offs = stops.map(s => Number(s.attrs.offset));
  assert.ok(offs.every((o, i) => i === 0 || o >= offs[i - 1]) && offs[0] < 0.05 && offs[3] > 0.95);
  f.setState("moving");
  assert.equal(f.el.dataset.state, "moving");
  f.update(0, 0, 16, 1);
  assert.equal(find(f.el, "stop").length, 0);
  assert.equal(f.el.style.props.display, "none");
});

test("styles: brass, top-outline only, no flat teal line, reduced motion stops the sweep", () => {
  const css = fs.readFileSync(path.join(__dirname, "../renderer/composer.css"), "utf8");
  assert.doesNotMatch(css, /patina/);
  assert.match(css, /\.conv-fil-svg path \{ stroke: var\(--brass\); \}/);
  assert.match(css, /animation: conv-filament 2\.4s linear infinite/);
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[^\n]*\}/)[0];
  assert.match(reduced, /\.conv-fil-slice \{ animation: none; \}|\.conv-filament \.conv-fil-slice \{ animation: none; \}|\.conv-filament \.conv-fil-slice \{ animation: none/);
  assert.match(reduced, /conv-fil-whole \{ display: inline; \}/);
  const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
  assert.ok(html.indexOf("composer-filament.js") > 0 && html.indexOf("composer-filament.js") < html.indexOf('src="composer.js"'));
  const js = fs.readFileSync(path.join(__dirname, "../renderer/composer-filament.js"), "utf8");
  assert.doesNotMatch(js, /innerHTML|setInterval|requestAnimationFrame/);
});
