"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const PREVIEW = 300;

// Same credential shapes as the deck-events plugin: previews can echo commands and tool inputs.
const SECRET_RES = [
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, // Telegram bot token
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, // OpenAI/Anthropic-style keys
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/g, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  // security audit L5: more shapes that show up in commands and tool output
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, // PEM private keys (cut ones too)
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key ids
  /\bAIza[A-Za-z0-9_-]{35}\b/g, // Google API keys
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
];
const LABELLED_RES = [
  /(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
  /(\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi, // the password in scheme://user:password@host (database URLs)
  /(\baws_secret_access_key["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{20,}/gi, // AWS secret keys (labelled)
];
const MASK = "‹redacted›";

function redact(s) {
  for (const rx of SECRET_RES) s = s.replace(rx, MASK);
  for (const rx of LABELLED_RES) s = s.replace(rx, (_m, label) => label + MASK);
  return s;
}

/** Short, redacted, single-string preview of any value; undefined stays undefined. */
function clip(v, n = PREVIEW) {
  if (v === undefined || v === null) return undefined;
  let s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return undefined;
  s = redact(s);
  return s.length <= n ? s : s.slice(0, n) + "…";
}

/** Flatten Claude tool_result / message content (string | blocks[]) to text. */
function textOf(content) {
  if (content === undefined || content === null) return undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === "string" ? b : b && b.type === "text" ? b.text : "")).join(" ").trim();
  }
  return JSON.stringify(content);
}

/**
 * Normalize provider usage to {in, cr, cw, out, rs}:
 * in = fresh (uncached) input, cr = cache read, cw = cache write, out = output, rs = reasoning (part of out).
 * Hermes reports input_tokens excluding cache reads; Claude Code reports cache_*_input_tokens separately.
 */
function normUsage(u) {
  if (!u || typeof u !== "object") return null;
  const n = (v) => (typeof v === "number" && isFinite(v) && v > 0 ? v : 0);
  const out = {
    in: n(u.input_tokens),
    cr: n(u.cache_read_tokens) || n(u.cache_read_input_tokens),
    cw: n(u.cache_write_tokens) || n(u.cache_creation_input_tokens),
    out: n(u.output_tokens),
    rs: n(u.reasoning_tokens) || n(u.output_tokens_details && u.output_tokens_details.thinking_tokens),
  };
  return out.in || out.cr || out.cw || out.out || out.rs ? out : null;
}

/** YYYY-MM-DD in the machine's local timezone. */
function localDay(tsSec) {
  return new Date(tsSec * 1000).toLocaleDateString("sv-SE");
}

function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Minimal KEY=VALUE .env loader (no quotes processing beyond stripping one pair). */
function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const home = (...p) => path.join(os.homedir(), ...p);

module.exports = { PREVIEW, redact, clip, textOf, normUsage, localDay, atomicWriteJson, readJson, loadEnvFile, home };
