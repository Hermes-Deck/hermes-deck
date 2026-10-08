"use strict";
// Relay-side fence for bot-screen sessions on a user's device. Three layers keep an agent inside the window the
// user handed over: the deck runs cua-driver in bounded mode with a manifest, the deck-events plugin fences the
// computer_use tool inside Hermes, and this module checks every MCP message between Hermes and the device's
// driver. It sees what the plugin cannot: the driver tools Hermes calls under the hood (launch_app,
// get_desktop_state, list_windows ...). Tool names follow cua-driver 0.33.
//
// Rules for tools/call on a device (anything not listed is refused):
//   session and cursor plumbing             allowed, except hiding the agent cursor: on a device the user sees two
//                                           cursors, theirs and the agent's (agent spaces spec section 8)
//   capture and input tools                 only on the handed window: pid must match, window_id must match when
//                                           given, and a capture must name the window (a missing pid or window
//                                           means "the frontmost window", which is the user's)
//   list_windows                            pinned to the handed process: a missing pid is filled in, another pid is
//                                           refused (the device's manifest has desktop.display: false, and
//                                           cua-driver 0.33.3 refuses a listing without a pid there as desktop
//                                           display observation); the answer is cut to the handed window, and an
//                                           empty one becomes an error that says the window is gone
//   list_apps                               never reaches the device as such (the driver has no pid filter for it):
//                                           asked as list_windows on the handed process, answered with that app
//   launch_app                              only the handed app
//   foreground input                        local opt-in, exact pid and window_id required
//   kill_app, get_desktop_state, clipboard_*, bring_to_front, browser_*: refused
//   no grant                                everything but the plumbing is refused

// move_cursor is left out on purpose: Hermes never calls it, and on a device the pointer is the user's.
const PLUMBING = new Set(["start_session", "end_session", "set_agent_cursor_enabled", "get_agent_cursor_state", "get_config", "get_cursor_position", "get_screen_size", "get_displays"]);
const CAPTURES = new Set(["get_window_state", "screenshot", "get_accessibility_tree"]);
const INPUT = new Set(["click", "double_click", "right_click", "middle_click", "type_text", "press_key", "hotkey", "scroll", "drag", "set_value"]);
const LISTINGS = new Set(["list_windows", "list_apps"]);
const NEVER = new Set(["kill_app", "get_desktop_state", "bring_to_front"]);
const METHODS = new Set(["initialize", "ping", "tools/list", "tools/call"]); // plus notifications/*
const LIST_KEYS = ["windows", "_legacy_windows", "apps", "processes"];
const ERROR_TEXT_MAX = 500; // a refusal's reason is one short line; nothing longer goes back in an error

/** Positive integer or null (models zero-fill optional ids; Hermes treats those as unset too). */
function int(v) {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Whether a requested app name is the handed app (case-insensitive, either contains the other). */
function appMatches(asked, granted) {
  const a = String(asked || "").trim().toLowerCase();
  const g = String(granted || "").trim().toLowerCase();
  return !!a && !!g && (a.includes(g) || g.includes(a));
}

/**
 * The grant as the fence uses it ({app, pid, windowId, title}), or null when it is missing, expired, incomplete
 * or points at the deck itself.
 */
function fenceGrant(grant, deckPid, now = Date.now()) {
  if (!grant || typeof grant !== "object" || !grant.window || typeof grant.window !== "object") return null;
  const pid = int(grant.window.pid);
  const windowId = int(grant.window.id);
  if (!pid || !windowId || (deckPid && pid === deckPid)) return null;
  if (Number.isFinite(grant.expires) && grant.expires <= now) return null;
  return { app: String(grant.app || ""), pid, windowId, title: String(grant.window.title || ""), foreground: grant.foreground === true };
}

const where = (device) => (device ? ` on ${device}` : " on this device");
const describe = (grant) => `${grant.app || "the handed app"} (${grant.title || `window ${grant.windowId}`})`;
// The upstream driver's hint is not a Deck risky-command approval. Keep its protocol fields and error intact.
const foregroundHint = (text) => text.replace(/(delivery_mode\s*=\s*\\*["']foreground\\*["']\s*\()separate approval(\))/g,
  "$1the user must allow foreground input in Hermes Deck$2");
function foregroundReply(msg) {
  const hints = (value) => {
    if (!value || typeof value !== "object") return false;
    let changed = false;
    for (const [key, v] of Object.entries(value)) {
      if (["escalation_hint", "hint"].includes(key) && typeof v === "string") {
        value[key] = foregroundHint(v); changed = value[key] !== v || changed;
      } else changed = hints(v) || changed;
    }
    return changed;
  };
  hints(msg?.result?.structuredContent);
  for (const part of Array.isArray(msg?.result?.content) ? msg.result.content : []) {
    if (part?.type !== "text" || typeof part.text !== "string") continue;
    try {
      const value = JSON.parse(part.text);
      if (hints(value)) part.text = JSON.stringify(value);
    } catch { part.text = foregroundHint(part.text); }
  }
  if (typeof msg?.error?.message === "string") msg.error.message = foregroundHint(msg.error.message);
  return msg;
}

/**
 * {ok: true, filter?, tool?, args?} or {ok: false, message} for one tools/call. `filter` ("list_windows" or
 * "list_apps") names a listing whose answer must be cut to the grant. `args`, and `tool` when it differs, is
 * what goes to the device instead of what Hermes sent.
 */
function checkCall(name, args, { grant, deckPid, device } = {}) {
  const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const on = where(device);
  const no = (why) => ({ ok: false, message: `Bot screen: ${why}` });
  if (typeof name !== "string" || !name) return no("a tool call without a name was refused");
  if (name === "set_agent_cursor_enabled" && a.enabled === false) return no(`the agent cursor stays visible${on}: the user sees where you act`);
  if (PLUMBING.has(name)) return { ok: true };
  if (name === "set_config") return String(a.key) === "capture_scope" ? no(`the capture scope cannot be changed${on}`) : { ok: true };
  if (NEVER.has(name) || name.startsWith("clipboard") || name.startsWith("browser_")) return no(`${name} is not available${on} while the user works there`);
  if (!grant) return no(`no window${on} has been handed to this agent; ask the user to pick one with Hand to agent in Hermes Deck`);
  if (INPUT.has(name) && a.scope === "desktop") return no(`desktop-coordinate input is not available${on}; use the handed window`);
  const pid = int(a.pid);
  const wid = int(a.window_id);
  if (a.delivery_mode === "foreground" && !(grant.foreground === true && INPUT.has(name) && pid === grant.pid && wid === grant.windowId)) {
    return no(`foreground input requires local consent for this exact window${on}; ask the user to enable Foreground control when handing it over in Deck`);
  }
  if (deckPid && pid === deckPid) return no("that process is Hermes Deck itself");
  const target = describe(grant);
  if (name === "launch_app") return appMatches(a.name || a.bundle_id || a.app, grant.app) ? { ok: true } : no(`only ${grant.app || "the handed app"} may be launched${on}`);
  if (name === "list_windows") {
    // Hermes never sends a pid here, and the device's driver refuses a listing without one (desktop.display is
    // false in the grant's manifest): pin it to the handed process, so an untargeted capture, focus_app or
    // listing resolves to the handed window. The pid also comes out as an integer, as the driver's schema wants.
    // The arguments always go out re-serialized, never as Hermes' bytes: a duplicate "pid" key, which parses here
    // as the last one, cannot reach a device parser that keeps the first.
    if (pid && pid !== grant.pid) return no(`list_windows${on} may only list ${target}`);
    return { ok: true, filter: name, args: { ...a, pid: grant.pid } };
  }
  if (name === "list_apps") {
    // The driver has no pid filter for list_apps, so it could never pass the grant's manifest (and Hermes reads a
    // refusal as "nothing runs"): ask list_windows on the handed process instead and answer with that one app.
    const asked = { pid: grant.pid, on_screen_only: false }; // a minimized window still means the app runs
    if (typeof a.session === "string") asked.session = a.session;
    return { ok: true, filter: name, tool: "list_windows", args: asked };
  }
  if (CAPTURES.has(name) || INPUT.has(name)) {
    const pidOk = name === "screenshot" && a.pid === undefined ? true : pid === grant.pid;
    const windowGiven = a.window_id !== undefined && a.window_id !== null;
    const windowNeeded = name === "get_window_state" || name === "screenshot";
    if (!pidOk || (windowGiven && wid !== grant.windowId) || (windowNeeded && wid !== grant.windowId)) return no(`${name}${on} may only target ${target}`);
    return { ok: true };
  }
  return no(`${name} is not on the list of driver tools allowed${on}`);
}

/**
 * The relay's fence on an agent's own desktop (agent spaces phase 2, spec 4.3): the whole desktop is the agent's, so
 * no single-window grant applies; only what would harm the desktop itself or hide the agent from the user is refused.
 * {ok: true} or {ok: false, message}.
 */
function checkSpaceCall(name, args) {
  const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const no = (why) => ({ ok: false, message: `Bot screen: ${why}` });
  if (name === "kill_app") return no("kill_app is not available on your desktop: it could end the desktop's own processes");
  if (name === "set_agent_cursor_enabled" && a.enabled === false) return no("the agent cursor stays visible on your desktop: the user sees where you act");
  if (name === "set_config" && String(a.key) === "capture_scope") return no("the capture scope cannot be changed on your desktop");
  return { ok: true };
}

/** Keep only the handed window (list_windows) or its process (list_apps) in a listing object, in place. */
function filterListing(obj, kind, grant) {
  const keep = (e) =>
    !!grant && !!e && typeof e === "object" && int(e.pid) === grant.pid && (kind !== "list_windows" || int(e.window_id) === grant.windowId);
  const prune = (o) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return;
    for (const k of LIST_KEYS) if (Array.isArray(o[k])) o[k] = o[k].filter(keep);
  };
  prune(obj);
  if (obj && typeof obj === "object") prune(obj.structuredContent);
  return obj;
}

/**
 * The relay's own list_apps answer, from a list_windows answer on the handed process: the handed app as one row
 * ({name, pid, running}, plus display_name when the Deck shows the app under another name) while that process
 * has a window, else no rows. Only rows with the grant's pid are read, and only their app name is kept.
 */
function appsAnswer(listing, grant) {
  if (!grant || !listing || typeof listing !== "object") return { apps: [] };
  const sc = listing.structuredContent && typeof listing.structuredContent === "object" ? listing.structuredContent : {};
  const mine = [listing.windows, sc.windows, listing._legacy_windows, sc._legacy_windows]
    .flatMap((l) => (Array.isArray(l) ? l : []))
    .filter((w) => w && typeof w === "object" && int(w.pid) === grant.pid);
  if (!mine.length) return { apps: [] };
  const named = mine.map((w) => w.app_name).find((n) => typeof n === "string" && n.trim());
  const name = named ? named.trim().slice(0, 128) : grant.app;
  const row = { name, pid: grant.pid, running: true };
  if (grant.app && grant.app !== name) row.display_name = grant.app;
  return { apps: [row] };
}

/** A listing that came back empty after the cut: why, in words the agent can act on. */
function goneMessage(grant, device) {
  if (!grant) return `Bot screen: no window${where(device)} is handed to this agent any more; ask the user to pick one with Hand to agent in Hermes Deck`;
  return `Bot screen: the handed window, ${describe(grant)}, is not on screen${where(device)} (minimized or closed); ask the user to bring it back, or to hand it over again with Hand to agent`;
}

/** A JSON-RPC tools/call result carrying an error the agent can read. */
const toolError = (id, message) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: message }], isError: true } });
const rpcError = (id, message, code = -32601) => ({ jsonrpc: "2.0", id, error: { code, message } });
const idKey = (id) => `${typeof id}:${id}`;

/** Byte-stream line splitter: push(chunk) returns the complete lines (without "\n"); rest() empties the tail. */
function lines() {
  let tail = [];
  return {
    push(chunk) {
      const out = [];
      let start = 0;
      for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10, start)) {
        tail.push(chunk.subarray(start, nl));
        out.push(tail.length === 1 ? tail[0] : Buffer.concat(tail));
        tail = [];
        start = nl + 1;
      }
      if (start < chunk.length) tail.push(chunk.subarray(start));
      return out;
    },
    rest() {
      const b = Buffer.concat(tail);
      tail = [];
      return b;
    },
  };
}

/**
 * The fence on one `mcp` channel. Hermes -> device bytes go through fromHermes, device -> Hermes bytes through
 * fromDevice; both deliver whole lines (MCP stdio is newline-delimited JSON-RPC). `ctx()` returns the live
 * {grant, deckPid, device}, so a new grant or a revoke applies to the very next call.
 */
class McpFence {
  constructor({ ctx, toDevice, toHermes }) {
    this.ctx = ctx;
    this.toDevice = toDevice;
    this.toHermes = toHermes;
    this.pending = new Map(); // request id -> listing kind whose answer must be filtered
    this.inflight = new Set(); // ids of every request sent to the device and not answered yet
    this.inLines = lines();
    this.outLines = lines();
    this.refused = 0;
  }

  _reply(obj) {
    this.toHermes(Buffer.from(JSON.stringify(foregroundReply(obj)) + "\n"));
  }

  fromHermes(chunk) {
    for (const line of this.inLines.push(chunk)) this._request(line);
  }

  _request(line) {
    if (!line.length) return;
    let msg;
    try {
      msg = JSON.parse(line.toString("utf8"));
    } catch {
      this.refused += 1; // never forward what cannot be checked
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      this.refused += 1;
      return;
    }
    const m = msg.method;
    if (m === undefined) {
      this.toDevice(Buffer.concat([line, Buffer.from("\n")])); // a response to the driver's own request: its id space
      return;
    }
    const hasId = msg.id !== undefined && msg.id !== null;
    const key = hasId ? idKey(msg.id) : null;
    // A request under an id that is still waiting for its answer is refused, whatever its method: the device's two
    // answers would carry the same id, so a listing's answer could pass as the other one's and reach Hermes
    // unfiltered. The refusal goes back under that id, as one more answer to a call Hermes itself duplicated.
    if (hasId && this.inflight.has(key)) {
      this.refused += 1;
      const why = `Bot screen: request id ${String(msg.id).slice(0, 40)} is already waiting for an answer`;
      this._reply(m === "tools/call" ? toolError(msg.id, why) : rpcError(msg.id, why, -32600));
      return;
    }
    if (typeof m === "string" && (m.startsWith("notifications/") || (METHODS.has(m) && m !== "tools/call"))) {
      if (hasId) this.inflight.add(key);
      this.toDevice(Buffer.concat([line, Buffer.from("\n")])); // notifications, handshake
      return;
    }
    if (m !== "tools/call") {
      this.refused += 1;
      if (hasId) this._reply(rpcError(msg.id, `Bot screen: ${String(m).slice(0, 60)} is not allowed on this device`));
      return;
    }
    const p = msg.params && typeof msg.params === "object" ? msg.params : {};
    const v = checkCall(p.name, p.arguments, this.ctx());
    if (!v.ok) {
      this.refused += 1;
      if (hasId) this._reply(toolError(msg.id, v.message));
      return;
    }
    if (v.filter && !hasId) {
      // a listing without an id has no answer the fence could recognise and cut; a driver that answers it anyway
      // (id null) would hand Hermes the whole listing. MCP never sends tools/call as a notification.
      this.refused += 1;
      return;
    }
    if (hasId) this.inflight.add(key);
    if (v.filter) this.pending.set(key, v.filter);
    // the fence's rewrite (list_windows pinned to the handed pid, list_apps asked as list_windows) replaces what
    // Hermes sent, under the same id; anything else goes on byte for byte
    const out = v.args ? Buffer.from(JSON.stringify({ ...msg, params: { ...p, name: v.tool || p.name, arguments: v.args } })) : line;
    this.toDevice(Buffer.concat([out, Buffer.from("\n")]));
  }

  fromDevice(chunk) {
    for (const line of this.outLines.push(chunk)) this._response(line);
  }

  _response(line) {
    if (this.inflight.size) {
      let msg = null;
      try {
        msg = JSON.parse(line.toString("utf8"));
      } catch {
        msg = null;
      }
      // only an answer (no method) ends a request; the device's own requests and notifications use its id space
      const answer = msg && typeof msg === "object" && !Array.isArray(msg) && msg.method === undefined && msg.id !== undefined && msg.id !== null;
      const key = answer ? idKey(msg.id) : null;
      if (answer) this.inflight.delete(key);
      const kind = answer ? this.pending.get(key) : undefined;
      if (kind) {
        this.pending.delete(key);
        if (msg.result && typeof msg.result === "object" && !Array.isArray(msg.result)) msg.result = this._listing(msg.result, kind);
        this._reply(msg);
        return;
      }
    }
    // Only result hints/text may change; JSON-RPC IDs and unrelated payloads retain their values.
    // Parse only lines that carry the hint; screenshot replies pass through byte for byte.
    if (line.includes("separate approval")) {
      try { this._reply(JSON.parse(line.toString("utf8"))); return; } catch {}
    }
    this.toHermes(Buffer.concat([line, Buffer.from("\n")]));
  }

  /** A listing answer, cut to the grant as it is now (a revoke in between leaves nothing). */
  _listing(r, kind) {
    const { grant, device } = this.ctx();
    filterListing(r, kind, grant);
    if (r.isError) {
      // a refusal or another driver error lists nothing: keep its reason as short text, which is all Hermes reads
      const text = (Array.isArray(r.content) ? r.content : []).filter((c) => c && c.type === "text" && typeof c.text === "string").map((c) => c.text).join(" ");
      r.content = [{ type: "text", text: (text || `${kind} failed`).slice(0, ERROR_TEXT_MAX) }];
      return r;
    }
    if (kind === "list_apps") {
      const apps = appsAnswer(r, grant); // r is the device's list_windows answer; nothing else of it goes back
      return { content: [{ type: "text", text: JSON.stringify(apps) }], structuredContent: apps };
    }
    const sc = r.structuredContent && typeof r.structuredContent === "object" ? r.structuredContent : {};
    // nothing left: say why, instead of an empty list Hermes would fetch again and then blame on its own setup
    if (Array.isArray(sc.windows) && !sc.windows.length) return { content: [{ type: "text", text: goneMessage(grant, device) }], isError: true };
    r.content = [{ type: "text", text: JSON.stringify(sc) }]; // text parts may list everything; show only what is left
    return r;
  }

  /** The device side closed: whatever partial line is left goes through as it is (nothing can follow it). */
  flush() {
    const rest = this.outLines.rest();
    if (rest.length && !this.pending.size) this.toHermes(rest);
  }
}

module.exports = { McpFence, checkCall, checkSpaceCall, lines, filterListing, appsAnswer, goneMessage, fenceGrant, appMatches, toolError, foregroundReply, int, PLUMBING, CAPTURES, INPUT, LISTINGS };
