"use strict";
// Bot faces, drawn the way Hermes Desktop draws them (apps/desktop/src/plugins/hermes-bots/avatar.tsx, MIT,
// Nous Research): the same deterministic shape and colour from the bot's name, the same outlines in a
// 40x44 box, the same eyes, catchlights and three "working" dots. Desktop animates them with a 15 fps
// clock; here the face is static and CSS adds a blink and the dots (bots.css), nothing runs per frame.
// faceModel() is pure data so tests can check it; renderFace() builds SVG with the caller's svg() helper
// (createElementNS + setAttribute, never innerHTML).
(() => {
  const SHAPES = ["circle", "squircle", "pill", "triangle", "hexagon", "cloud", "drop"];
  const PRIMARY_COLOR = "#8b5cf6"; // the violet the primary profile ("default") wears until customized
  const CLOUD_PATH = "M11 32 a7.5 7.5 0 0 1 -1 -14.9 A9.5 9.5 0 0 1 29 12.5 A7 7 0 0 1 30 32 Z";

  /** avatar.tsx defaultShapeFor: (h*31 + code) >>> 0 over the name, one of seven shapes. */
  function defaultShapeFor(name) {
    let hash = 0;
    for (const ch of String(name || "")) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return SHAPES[hash % SHAPES.length];
  }

  /** lib/profile-color.ts profileColor: hsl(hash % 360 68% 58%), none for "default" or an empty name. */
  function profileColor(name) {
    const key = String(name || "").trim();
    if (!key || key === "default") return null;
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    return `hsl(${hash % 360} 68% 58%)`;
  }

  /**
   * avatar.tsx isDarkColor, ported as is: it parses hex only, so any other colour (the hsl() defaults)
   * reads as dark there too and gets cream eyes. Kept identical so a face looks the same in both apps.
   */
  function isDarkColor(color) {
    const n = parseInt(String(color).slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110;
  }

  /** Blob shapes come from the blobatar library, which the Deck does not ship. */
  const isBlobShape = (shape) => shape === "blobatar" || (typeof shape === "string" && shape.startsWith("blobatar:"));

  /**
   * avatar.tsx botAppearance: an uncustomized primary profile is a violet squircle; otherwise the stored
   * shape/colour, else the name's. A blobatar pick falls back to the name's shape, as Desktop does without
   * the library; a sigil keeps the round outline.
   */
  function appearance(name, meta) {
    const m = meta || {};
    if (String(name || "").trim().toLowerCase() === "default" && !m.custom) return { shape: "squircle", color: PRIMARY_COLOR };
    let shape = m.shape || defaultShapeFor(name);
    if (isBlobShape(shape)) shape = defaultShapeFor(name);
    return { shape, color: m.color || profileColor(name) || PRIMARY_COLOR };
  }

  // ---------------------------------------------------------------- outlines (avatar.tsx sampleFaceRing)
  function cubicAt(p0, p1, p2, p3, t) {
    const u = 1 - t;
    return [
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ];
  }

  function sampleDropRing(steps) {
    const pts = [];
    const n = Math.max(8, Math.floor(steps / 3));
    for (let i = 0; i < n; i++) pts.push(cubicAt([20, 3], [20, 3], [6, 20], [6, 27], i / n));
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI;
      pts.push([20 - 14 * Math.cos(t), 27 + 13.5 * Math.sin(t)]);
    }
    for (let i = 1; i <= n; i++) pts.push(cubicAt([34, 27], [34, 20], [20, 3], [20, 3], i / n));
    return pts;
  }

  /** Outline of a face in a 40x40 box (the cloud is drawn from its own path). */
  function sampleFaceRing(shape, steps = 52) {
    const kind = String(shape || "").startsWith("sigil-") ? "circle" : shape;
    if (kind === "drop" || kind === "teardrop") return sampleDropRing(steps);
    const pts = [];
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2 - Math.PI / 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      let rx = 16.2;
      let ry = 16.2;
      if (kind === "blob") {
        rx = ry = 16 + 1.7 * Math.sin(3 * a) + 0.7 * Math.cos(5 * a);
      } else if (kind === "squircle") {
        const d = Math.pow(Math.abs(c) ** 5 + Math.abs(s) ** 5, 1 / 5) || 1;
        rx = ry = 16.2 / d;
      } else if (kind === "pill") {
        const d = Math.pow(Math.abs(c) ** 8 + Math.abs(s / 0.72) ** 8, 1 / 8) || 1;
        rx = ry = 16 / d;
      } else if (kind === "triangle" || kind === "tetrahedron" || kind === "wedge") {
        const u = (a + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
        const sector = (u / ((Math.PI * 2) / 3)) % 1;
        rx = ry = 13.5 / Math.max(0.42, Math.cos((sector - 0.5) * 1.9));
      } else if (kind === "hexagon" || kind === "hex" || kind === "icosahedron" || kind === "dodecahedron") {
        const seg = Math.PI / 3;
        rx = ry = 16.2 * (Math.cos(seg / 2) / Math.cos(a - seg * Math.round(a / seg)));
      } else if (kind === "cube" || kind === "octahedron") {
        const d = Math.pow(Math.abs(c) ** 3.1 + Math.abs(s) ** 3.1, 1 / 3.1) || 1;
        rx = ry = 16 / d;
      } else if (kind === "pebble") {
        rx = 16.4 * (1.04 - 0.14 * Math.cos(2 * a));
        ry = 15.2 * (1.06 + 0.08 * Math.sin(2 * a));
      }
      pts.push([20 + rx * c, 20 + ry * s]);
    }
    return pts;
  }

  function ringToPath(pts) {
    if (!pts.length) return "";
    let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
    for (let i = 1; i < pts.length; i++) d += `L${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)}`;
    return `${d}Z`;
  }

  /**
   * The static face (BotFace's first paint): body, two eyes, their catchlights, the closed-eye line used by
   * the blink, and the three dots that show while the bot works.
   */
  function faceModel({ shape, color, working = false }) {
    const s = shape || "circle";
    const dark = isDarkColor(color);
    const eyeFill = dark ? "rgba(232,220,195,0.95)" : "rgba(0,0,0,0.85)";
    // the catchlight contrasts with the pupil, not the body
    const hlFill = dark ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.85)";
    const y = s === "cloud" ? 22 : 17.2;
    return {
      viewBox: "0 0 40 44",
      shape: s,
      body: { d: s === "cloud" ? CLOUD_PATH : ringToPath(sampleFaceRing(s)), fill: color },
      eyes: [15.4, 24.6].map((cx) => ({ cx, cy: y, rx: 2.2, ry: working ? 2.6 : 2.3, fill: eyeFill })),
      lights: [15.4, 24.6].map((cx) => ({ cx: +(cx - 0.6).toFixed(2), cy: +(y - 0.7).toFixed(2), r: 0.65, fill: hlFill })),
      shut: { d: `M12.8 ${y} L18 ${y} M22 ${y} L27.2 ${y}`, stroke: eyeFill },
      dots: [16.4, 20, 23.6].map((cx) => ({ cx, cy: 41.2, r: 1.15, fill: color })),
    };
  }

  /** <svg class="botface"> for a model; svg(tag, attrs) is app.js's createElementNS helper. */
  function renderFace(svg, model, { size = 36, working = false, label = "" } = {}) {
    const root = svg("svg", { class: `botface${working ? " working" : ""}`, width: size, height: size, viewBox: model.viewBox, "aria-hidden": "true", "data-shape": model.shape });
    if (label) root.dataset.bot = label;
    root.appendChild(svg("path", { class: "bf-body", d: model.body.d, fill: model.body.fill }));
    const open = svg("g", { class: "bf-open" });
    for (const e of model.eyes) open.appendChild(svg("ellipse", { cx: e.cx, cy: e.cy, rx: e.rx, ry: e.ry, fill: e.fill }));
    for (const l of model.lights) open.appendChild(svg("circle", { cx: l.cx, cy: l.cy, r: l.r, fill: l.fill }));
    root.appendChild(open);
    root.appendChild(svg("path", { class: "bf-shut", d: model.shut.d, fill: "none", stroke: model.shut.stroke, "stroke-linecap": "round", "stroke-width": 2 }));
    const dots = svg("g", { class: "bf-dots" });
    for (const d of model.dots) dots.appendChild(svg("circle", { cx: d.cx, cy: d.cy, r: d.r, fill: d.fill }));
    root.appendChild(dots);
    return root;
  }

  const api = { SHAPES, PRIMARY_COLOR, defaultShapeFor, profileColor, isDarkColor, isBlobShape, appearance, sampleFaceRing, ringToPath, faceModel, renderFace };
  if (typeof window !== "undefined") window.DeckBotFace = Object.freeze(api);
  if (typeof module === "object" && module.exports) module.exports = api; // Node unit tests
})();
