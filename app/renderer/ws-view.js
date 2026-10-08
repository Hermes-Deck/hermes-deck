"use strict";
// Workspace tab: the size of the live view. Pure functions (no DOM, no Electron) so the tests load them too;
// renderer/workspace.js is the only caller.
//   streamSize    how many pixels to ask the browser's screencast for, from the stage size
//   createResizer debounced "the stage changed, ask again" that skips sizes it already asked for
//   contentBox    where the picture really sits inside the canvas box (object-fit: contain letterboxes it)
//   mapPoint      a pointer position -> 0..1 on the page (what the browser side multiplies by the page size)
//   isExpandKey   the shortcut that toggles the large view
(function (root) {
  const MIN_PX = 640; // never ask for less (a tiny panel still gets a readable page)
  const MAX_PX = 1920; // the cap main/workspace.js and the relay also apply
  const STEP_PX = 128; // sizes snap up to this step, so dragging the panel gutter does not restart the stream per pixel
  const OVERSAMPLE = 1.5; // a little more than the screen shows: text stays crisp when the page is scaled down
  const DEBOUNCE_MS = 300;
  const FALLBACK_W = 560; // the panel's default width, used while the stage has no size yet (hidden, not laid out)

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /**
   * The screencast bound for a stage `width` CSS px wide on a screen with `dpr` device pixels per CSS pixel.
   * `large` (the expanded view) tells the relay it may go past its panel-sized 1024 px limit for this deck.
   */
  function streamSize({ width, dpr = 1, large = false } = {}) {
    const w = Number(width) > 0 ? Number(width) : FALLBACK_W;
    const d = Number(dpr) > 0 ? Number(dpr) : 1;
    const px = clamp(Math.ceil((w * d * OVERSAMPLE) / STEP_PX) * STEP_PX, MIN_PX, MAX_PX);
    return { maxWidth: px, maxHeight: px, large: !!large };
  }

  /**
   * Re-ask for the stream size when the stage changes (expand, collapse, gutter drag, window resize).
   * @param {(size: {maxWidth: number, maxHeight: number}) => void} request does the asking (IPC)
   * @param {{delay?: number, setTimer?: Function, clearTimer?: Function}} [o] timers are injectable for tests
   */
  function createResizer(request, { delay = DEBOUNCE_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let asked = null; // what the browser side was last told
    let timer = null;
    const same = (a, b) => !!a && !!b && a.maxWidth === b.maxWidth && a.maxHeight === b.maxHeight && !!a.large === !!b.large;
    return {
      /** The size that was sent with the watch itself: later observations compare against it. */
      start(size) {
        clearTimer(timer);
        timer = null;
        asked = size || null;
      },
      /** The stage now measures `size` (from streamSize): ask after the burst is over, and only if it differs. */
      observe(size) {
        clearTimer(timer);
        timer = null;
        if (!size || same(size, asked)) return;
        timer = setTimer(() => {
          timer = null;
          if (same(size, asked)) return;
          asked = size;
          request(size);
        }, delay);
      },
      /** Watching stopped: forget everything. */
      stop() {
        clearTimer(timer);
        timer = null;
        asked = null;
      },
      get asked() {
        return asked;
      },
      get pending() {
        return timer !== null;
      },
    };
  }

  /**
   * The rectangle the picture covers inside the canvas's box. With `object-fit: contain` a wider or taller box than the
   * picture's aspect ratio leaves empty bands; a click in a band must not land on the page, and the page's own 0..1 range
   * starts at the picture's edge, not the box's.
   * @param {{left: number, top: number, width: number, height: number}} box canvas.getBoundingClientRect()
   * @param {number} bw picture (bitmap) width
   * @param {number} bh picture (bitmap) height
   */
  function contentBox(box, bw, bh) {
    const W = box.width || 0;
    const H = box.height || 0;
    if (!(bw > 0) || !(bh > 0) || !(W > 0) || !(H > 0)) return { left: box.left || 0, top: box.top || 0, width: W, height: H };
    const k = Math.min(W / bw, H / bh);
    const width = bw * k;
    const height = bh * k;
    return { left: box.left + (W - width) / 2, top: box.top + (H - height) / 2, width, height };
  }

  /** A pointer position -> {x, y} in 0..1 of the page; `inside` is false when it is in a letterbox band. */
  function mapPoint(clientX, clientY, box, bw, bh) {
    const c = contentBox(box, bw, bh);
    const x = (clientX - c.left) / (c.width || 1);
    const y = (clientY - c.top) / (c.height || 1);
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1), inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
  }

  /** Ctrl+Shift+F (Cmd+Shift+F on a Mac) toggles the large view. */
  function isExpandKey(e) {
    return !!e && !!(e.ctrlKey || e.metaKey) && !!e.shiftKey && !e.altKey && String(e.key || "").toLowerCase() === "f";
  }

  const browserLive = info => info?.status === "running";
  // Remote agent browsers come over the relay; a closed link leaves only a stale list, which is not live.
  function browserSurfaceLive({ local = [], remote = [], link = null, profile = null } = {}) {
    const match = b => b && browserLive(b) && (!profile || b.slug === profile);
    return local.some(match) || (link?.status === "open" && remote.some(match));
  }
  function screenLive(state, profile, now = Date.now()) {
    const grant = state?.grant;
    return !!(state?.on && !state.paused && state.link?.status === "ready" && grant && grant.expires > now && (!profile || grant.profile === profile));
  }
  function spaceLive(list, profile) {
    return !!list?.spaces?.some(s => s.online && (!profile || s.id === profile || s.holder === profile));
  }
  const api = { MIN_PX, MAX_PX, STEP_PX, DEBOUNCE_MS, streamSize, createResizer, contentBox, mapPoint, isExpandKey, browserLive, browserSurfaceLive, screenLive, spaceLive };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DeckWsView = api;
})(typeof window !== "undefined" ? window : globalThis);
