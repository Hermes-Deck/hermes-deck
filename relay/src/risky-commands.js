"use strict";
const BUILTIN = [
  /(?:^|[\s;&|()])sudo\b/i,
  /(?:^|[\s;&|()])su\s+-(?:\s|$)/i,
  // Repeated option tokens have disjoint flag/whitespace alphabets; no ambiguous nested repetition.
  /(?:^|[\s;&|()])rm\s+(?:--[\w-]+\s+|-[a-z]+\s+)*-(?:[a-z]*r[a-z]*|-recursive)\b/i,
  /(?:^|[\s;&|()])mkfs(?:\.[\w]+)?\b/i,
  /(?:^|[\s;&|()])dd\s+[^\n;]*\bof\s*=/i,
  /(?:^|[\s;&|()])chmod\s+(?:-R\s+777|777\s+-R)\b/,
  /(?:^|[\s;&|()])(?:curl|wget)\b[^;]*\|\s*(?:sh|bash|python[\d.]*)\b/i,
  // As above, each repeated option requires a separate whitespace delimiter.
  /(?:^|[\s;&|()])(?:apt(?:-get)?|dnf|pip[\d.]*)\s+(?:-[\w=-]+\s+)*install\b/i,
  /(?:^|[\s;&|()])brew\s+install\b/i,
  /(?:^|[\s;&|()])npm\s+(?:(?:install|i)\b[^\r\n;|&]*\s(?:-g|--global)\b|(?:-g|--global)\s+(?:install|i)\b)/i,
  /(?:^|[;|]|&&|\$\()[ \t]*(?:shutdown|reboot)\b/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
];
function safePattern(source) {
  if (source.length > 200) return false;
  // Treat escapes/classes as atoms; conservatively reject repeated alternatives too.
  const syntax = source.replace(/\\.|\[(?:\\.|[^\]\\])*\]/g, "x").replace(/\(\?:/g, "(");
  const groups = [false];
  for (let i = 0; i < syntax.length; i++) {
    const c = syntax[i];
    if (c === "(") groups.push(false);
    else if (c === ")" && groups.length > 1) {
      const repeated = groups.pop();
      if (repeated && /[+*?{]/.test(syntax[i + 1] || "")) return false;
      groups[groups.length - 1] ||= repeated;
    } else if (/[+*?{|]/.test(c)) groups[groups.length - 1] = true;
  }
  return true;
}
function compilePatterns(text = "", warn = console.warn) {
  return String(text).split(/\r?\n/).flatMap((s, i) => {
    s = s.trim();
    if (!s || s.startsWith("#")) return [];
    if (!safePattern(s)) {
      warn(`unsafe risky pattern at line ${i + 1}`);
      return [];
    }
    try { return [new RegExp(s, "i")]; }
    catch { warn(`invalid risky pattern at line ${i + 1}`); return []; }
  });
}
function risky(text, extra = []) {
  const logical = String(text).replace(/\\\r?\n/g, " ")
    .replace(/(\|\|?|&&)[ \t]*(?:\r?\n[ \t]*)+/g, "$1 ");
  for (const line of logical.split(/\r\n|[\r\n]/)) {
    if (BUILTIN.some((r) => r.test(line))) return true;
    for (let offset = 0; offset < line.length || offset === 0; offset += 800) {
      if (extra.some((r) => r.test(line.slice(offset, offset + 1000)))) return true;
      if (offset + 1000 >= line.length) break;
    }
  }
  return false;
}
function commandTail(command) {
  let start = 0;
  for (const newline of command.matchAll(/\r\n|[\r\n]/g)) {
    if (!/(?:\||&&|\\)\s*$/.test(command.slice(start, newline.index)))
      start = newline.index + newline[0].length;
  }
  return command.slice(start).slice(-500);
}
function preview(buffer, name, args = {}) {
  if (name !== "type_text" || typeof args.text !== "string") return null;
  const command = buffer + args.text;
  return { command, text: args.text, next: commandTail(command) };
}
function advance(buffer, name, args = {}) {
  const p = preview(buffer, name, args);
  if (p) return p.next;
  const keys = name === "press_key" ? [args.key] : name === "hotkey" ? [].concat(args.keys || args.key || []) : [];
  return keys.some((k) => /^(?:enter|return)$/i.test(String(k))) ? commandTail(buffer + "\n") : buffer;
}
module.exports = { compilePatterns, risky, preview, advance };
