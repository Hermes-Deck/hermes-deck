"use strict";
// Workspace tab: why the browser-location menu can or cannot offer the relay's choices. Pure functions (no DOM,
// no Electron) so main and the tests load them too; renderer/workspace.js is the only caller.
//
// Two facts decide it, and both come from the same feed the title bar uses (the "relay" IPC channel plus the
// state main hands over on request):
//   link     the Deck's relay socket: {status: open | connecting | closed | unconfigured | starting, error?, since?}
//   devices  the relay's last {t:"devices"} snapshot (routes, pins, the agent host), null until one arrives
// A relay that is open but has not sent its device list yet is "waiting", never "not connected".
(function (root) {
  const WAIT_MS = 8000; // an open relay that stays silent this long is probably too old to send its device list

  /** A normalised link record from a relay status message or the state main returns; unknown input = connecting. */
  function normLink(raw, now = Date.now()) {
    const status = raw && typeof raw.status === "string" ? raw.status : "starting";
    return { status, error: raw && raw.error ? String(raw.error).slice(0, 120) : null, since: raw && Number.isFinite(raw.since) ? raw.since : now };
  }

  /**
   * The reason the relay-dependent menu choices are unavailable, or null when they are fine.
   * @returns {{code: string, key: string}|null} code for tests/logic, key = i18n key for the text
   */
  function reason({ link, devices, now = Date.now() }) {
    if (devices) return Array.isArray(devices.pins) ? null : { code: "old-relay", key: "U0925" };
    const l = link || { status: "starting", since: now };
    if (l.status === "unconfigured") return { code: "unconfigured", key: "ws.relayUnconfigured" };
    if (l.status === "closed") return { code: "closed", key: "U0336" };
    if (l.status === "open") return now - (l.since || now) > WAIT_MS ? { code: "no-list", key: "ws.relayNoList" } : { code: "waiting", key: "ws.relayWaiting" };
    return { code: "connecting", key: "ws.relayConnecting" };
  }

  /**
   * Apply one relay IPC message to the tab's model W ({link, devices}); true when something changed.
   * A closed or unset relay drops the devices snapshot: it described a connection that is gone.
   */
  function track(W, m, now = Date.now()) {
    if (!m || typeof m !== "object") return false;
    if (m.t === "status") {
      const was = W.link && W.link.status;
      W.link = normLink(m, was === m.status && W.link ? W.link.since : now);
      if (m.status !== "open") W.devices = null;
      return true;
    }
    if (m.t === "devices") {
      W.devices = m;
      if (!W.link || W.link.status !== "open") W.link = normLink({ status: "open" }, now); // a message proves the socket is open
      return true;
    }
    return false;
  }

  /** Apply the state main returns from ws:state: its relay link and its cached devices snapshot. */
  function fromState(W, st, now = Date.now()) {
    if (!st) return;
    if (st.relayLink) {
      const same = W.link && W.link.status === st.relayLink.status;
      W.link = normLink(st.relayLink, same ? W.link.since : now);
    }
    if (st.devices) W.devices = st.devices; // never clears: a closed link does that (track), and a live message may be newer
  }

  const api = { WAIT_MS, normLink, reason, track, fromState };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DeckWsRelay = api;
})(typeof window !== "undefined" ? window : globalThis);
