"use strict";
// Attachment directives in a stored Hermes user message.
//
// Hermes persists a user turn with attachments as the caption plus one `@image:<ref>` / `@file:<ref>` line per
// attachment (tui_gateway/session_history.py, agent/context_references.format_reference_value): the ref is bare,
// `backticked`, "double quoted" or 'single quoted'. Desktop clients also PREPEND such lines before the typed text.
// splitMediaRefs() takes those lines out of the text, so the chat shows the caption and the page draws thumbnails
// and file chips instead of raw lines. Core Node only; the tests drive it directly.
//
// Only a leading and a trailing block of whole directive lines is read: an `@image:` mentioned inside a sentence,
// or in the middle of a message, stays text. `@url:` and `@diff` are context references, not attachments.

const MAX_ATTACHMENTS = 12; // per message (the Deck itself sends at most 10)
const MAX_LINE = 4200;
const LINE = /^@(image|file):(.+)$/i;
// Native-vision turns are stored as "[Image attached at: <path>]" hints (tui_gateway/session_history.py _IMAGE_HINT_RE)
const HINT = /^\[Image attached at: ([^\n\]]+)\]$/;
const SCREENSHOT = "[screenshot]"; // the store's text-only stand-in for an image part (session_history.py)
// Hermes/plugin notices appended after the attachments (e.g. "[OMH Degraded] ..."): kept as text, after the caption
const NOTICE = /^\[OMH Degraded\]/;

/** One line as a directive, or null. The value is the rest of the line, unwrapped when quoted. */
function parseLine(line) {
  if (typeof line !== "string" || line.length > MAX_LINE) return null;
  const hint = HINT.exec(line.trim());
  if (hint) {
    const v = hint[1].trim();
    return v && !/[\u0000-\u001f\u007f]/.test(v) ? { kind: "image", value: v } : null;
  }
  const m = LINE.exec(line.trim());
  if (!m) return null;
  let value = m[2].trim();
  if (value.length >= 2 && "`\"'".includes(value[0]) && value[value.length - 1] === value[0]) value = value.slice(1, -1);
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return { kind: m[1].toLowerCase() === "image" ? "image" : "file", value };
}

/** The display name of a ref: its last path segment (POSIX or Windows separators). */
function refName(value) {
  const name = value.split(/[\\/]/).filter(Boolean).pop() || value;
  return name.slice(0, 160);
}

/** A host path the plugin can read: absolute POSIX, no `..`, no placeholder characters. */
function fetchablePath(value) {
  if (value.length < 3 || value.length > 4094 || value[0] !== "/" || value[1] === "/") return false;
  const parts = value.split("/").slice(1);
  return !parts.some((s) => s === "." || s === "..") && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * @returns {{text: string, attachments: Array<{kind: "image"|"file", path: string|null, name: string}>}}
 *   `path` is set only for what the host can serve (main keeps it; the page gets an opaque ref, see FileOffers);
 *   a relative or non-POSIX ref still yields an attachment (path null) so the page can name it as unavailable.
 *   With no directive block the text comes back untouched.
 */
/**
 * Blocks Hermes and its plugins inject into a stored user turn are not the person's words and are not shown:
 * `<memory-context>` (recalled memory, Hindsight), `<omh-context>` (OMH awareness) and any other `<name-context>`
 * pair. Hermes' own sanitize_context strips the memory block the same way (agent/memory_manager.py).
 */
const INJECTED = /\n*<([a-z][a-z0-9_-]{0,40}-context)>[\s\S]*?<\/\1>[ \t]*/gi;
/**
 * The footer Hermes' @-reference expansion appends to a stored user turn (agent/context_references.py): an optional
 * "--- Context Warnings ---" list, then "--- Attached Context ---" with one block per reference (the inlined text of
 * a file, or a "📎 @file:... binary file" note for the model). It is model context, not the person's words; the
 * `@file:` line above it stays and becomes the attachment chip. Hermes' title generator cuts it the same way.
 */
const CONTEXT_FOOTER = /\n+--- (?:Context Warnings|Attached Context) ---\n[\s\S]*$/;
function stripInjected(text) {
  return text.replace(INJECTED, "").replace(CONTEXT_FOOTER, "").replace(/\s+$/, "");
}

function splitMediaRefs(text) {
  const src = stripInjected(typeof text === "string" ? text : "");
  if (!src.includes("@") && !src.includes("[Image attached at: ")) return { text: src, attachments: [] };
  const lines = src.split("\n");
  let start = 0;
  let end = lines.length;
  const lead = [];
  const trail = [];
  // leading block (Desktop's context text): directive lines, blank lines between them
  while (start < end) {
    const p = parseLine(lines[start]);
    if (p) lead.push(p);
    else if (lines[start].trim() !== "" || !lead.length) break;
    start++;
  }
  // trailing notices ("[OMH Degraded] ...") are set aside and put back after the caption
  const notices = [];
  while (end > start && (lines[end - 1].trim() === "" || NOTICE.test(lines[end - 1].trim()))) {
    if (lines[end - 1].trim()) notices.unshift(lines[end - 1]);
    end--;
  }
  // trailing block: directive lines, then optional "[screenshot]" stand-ins and blank lines after them
  let cut = end;
  while (cut > start && (lines[cut - 1].trim() === "" || lines[cut - 1].trim() === SCREENSHOT)) cut--;
  while (cut > start) {
    const p = parseLine(lines[cut - 1]);
    if (!p) break;
    trail.unshift(p);
    cut--;
    while (cut > start && lines[cut - 1].trim() === "") cut--; // a blank line inside the block
  }
  if (!lead.length && !trail.length) return { text: src, attachments: [] };
  // no trailing block: trailing blanks and stand-ins belong to the text, unless nothing but they follow the leading block
  if (!trail.length) cut = cut <= start ? start : end;
  const kept = lines.slice(start, cut).join("\n").replace(/^\s*\n/, "").replace(/\s+$/, "");
  const body = notices.length ? [kept, ...notices].filter(Boolean).join("\n") : kept;
  const attachments = [];
  for (const p of [...lead, ...trail]) {
    if (attachments.length >= MAX_ATTACHMENTS) break;
    const ok = fetchablePath(p.value);
    attachments.push({ kind: p.kind, path: ok ? p.value : null, name: refName(p.value) });
  }
  return { text: body, attachments };
}

/**
 * One projected history message, in place: a USER message's directive lines leave the text and become
 * `m.media = [{kind, name, ref}]`, where `ref` is the opaque ref `offers.offer()` issued (null when the host cannot
 * serve that ref: relative or non-POSIX). The page never sees a host path. Other roles are left alone.
 */
function projectMedia(sid, message, offers) {
  if (!message || message.role !== "user" || typeof message.text !== "string") return message;
  const { text, attachments } = splitMediaRefs(message.text);
  if (!attachments.length) {
    message.text = text; // a trailing injected block is gone even without attachments
    return message;
  }
  message.text = text;
  message.media = attachments.map((a) => ({ kind: a.kind, name: a.name, ref: a.path ? offers.offer(sid, a.path) : null }));
  return message;
}

module.exports = { splitMediaRefs, stripInjected, CONTEXT_FOOTER, projectMedia, parseLine, refName, fetchablePath, MAX_ATTACHMENTS };
