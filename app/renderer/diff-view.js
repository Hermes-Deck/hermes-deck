"use strict";
// Readable per-file diffs for `patch` and `write_file` tool calls (Work › Run detail, Work › Diff).
// Pure parsers turn call arguments/results into a file model; `render` builds DOM through an injected `h`
// (text nodes only: tool data is untrusted and never becomes markup).
(function (root) {
  const MAX_LINES = 400; // rendered lines per file before "Show all"
  const CONTEXT = 3; // unchanged lines kept around a change when a diff is computed here
  const LCS_CELLS = 250000; // above this the line diff falls back to "all removed, then all added"

  const object = value => {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value !== "string") return {};
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
    catch { return {}; }
  };
  // A live preview ends with "…" when it was cut (plugin events.py `_clip`).
  const clipped = value => typeof value === "string" && value.endsWith("…");
  function splitLines(text) {
    const lines = String(text).split("\n").map(line => line.replace(/\r$/, ""));
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }
  function count(file) {
    file.added = 0; file.removed = 0;
    for (const hunk of file.hunks) for (const line of hunk.lines) {
      if (line.t === "add") file.added++;
      else if (line.t === "del") file.removed++;
    }
    return file;
  }
  const newFile = (path, op, extra = {}) => ({ path: path || "", from: null, op, hunks: [], added: 0, removed: 0, numbered: false, complete: true, ...extra });

  // --- unified diff (`patch` results: difflib output, `--- a/<path>` / `+++ b/<path>` / `@@ -l,n +l,n @@`)
  function diffPath(raw) {
    const path = String(raw || "").split("\t")[0].trim();
    if (!path || path === "/dev/null") return null;
    return path.replace(/^[ab]\//, "");
  }
  function parseUnified(text) {
    if (typeof text !== "string" || !text) return [];
    const files = [], src = splitLines(text);
    let file = null, hunk = null, oldLeft = 0, newLeft = 0, o = 0, n = 0;
    for (let i = 0; i < src.length; i++) {
      const line = src[i];
      if (hunk && (oldLeft > 0 || newLeft > 0)) {
        const c = line[0];
        if (c === "+" && newLeft > 0) { hunk.lines.push({ t: "add", text: line.slice(1), o: null, n: n++ }); newLeft--; continue; }
        if (c === "-" && oldLeft > 0) { hunk.lines.push({ t: "del", text: line.slice(1), o: o++, n: null }); oldLeft--; continue; }
        if ((c === " " || line === "") && oldLeft > 0 && newLeft > 0) { hunk.lines.push({ t: "ctx", text: line.slice(1), o: o++, n: n++ }); oldLeft--; newLeft--; continue; }
        if (c === "\\") { hunk.lines.push({ t: "note", text: line.slice(1).trim(), o: null, n: null }); continue; }
        file.complete = false; // the hunk ended before its counts: a clipped or malformed diff
        hunk = null;
      }
      if (line[0] === "\\" && hunk) { hunk.lines.push({ t: "note", text: line.slice(1).trim(), o: null, n: null }); continue; }
      if (line.startsWith("--- ") && (src[i + 1] || "").startsWith("+++ ")) {
        const from = diffPath(line.slice(4)), to = diffPath(src[i + 1].slice(4));
        const op = from === null ? "add" : to === null ? "delete" : from !== to ? "move" : "edit";
        file = newFile(to ?? from, op, { from: op === "move" ? from : null, numbered: true });
        files.push(file); hunk = null; i++;
        continue;
      }
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
      if (m) {
        if (!file) { file = newFile("", "edit", { numbered: true }); files.push(file); }
        o = Number(m[1]); n = Number(m[3]);
        oldLeft = m[2] === undefined ? 1 : Number(m[2]); newLeft = m[4] === undefined ? 1 : Number(m[4]);
        hunk = { oldStart: o, oldCount: oldLeft, newStart: n, newCount: newLeft, label: m[5] || "", lines: [] };
        file.hunks.push(hunk);
      }
      // `diff --git`, `index ...` and other headers carry nothing to show
    }
    if (file && hunk && (oldLeft > 0 || newLeft > 0)) file.complete = false;
    if (clipped(text) && file) file.complete = false;
    return files.map(count);
  }

  // --- line diff of two strings (patch `old_string` -> `new_string`; no file line numbers are known)
  function lineOps(a, b) {
    let start = 0, endA = a.length, endB = b.length;
    while (start < endA && start < endB && a[start] === b[start]) start++;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const head = a.slice(0, start).map(text => ({ t: "ctx", text }));
    const tail = a.slice(endA).map(text => ({ t: "ctx", text }));
    const x = a.slice(start, endA), y = b.slice(start, endB), mid = [];
    if (x.length * y.length > LCS_CELLS) {
      for (const text of x) mid.push({ t: "del", text });
      for (const text of y) mid.push({ t: "add", text });
      return [...head, ...mid, ...tail];
    }
    const w = y.length + 1, lcs = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) {
      lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
    let i = 0, j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) { mid.push({ t: "ctx", text: x[i] }); i++; j++; }
      else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) mid.push({ t: "del", text: x[i++] });
      else mid.push({ t: "add", text: y[j++] });
    }
    while (i < x.length) mid.push({ t: "del", text: x[i++] });
    while (j < y.length) mid.push({ t: "add", text: y[j++] });
    return [...head, ...mid, ...tail];
  }
  /** Split a run of line ops into hunks, keeping CONTEXT unchanged lines around each change. */
  function hunksOf(ops) {
    const keep = ops.map(() => false);
    ops.forEach((op, i) => { if (op.t !== "ctx") for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) keep[k] = true; });
    const hunks = [];
    let hunk = null, skipped = 0;
    ops.forEach((op, i) => {
      if (!keep[i]) { skipped++; hunk = null; return; }
      if (!hunk) { hunk = { oldStart: null, newStart: null, label: "", skipped, lines: [] }; hunks.push(hunk); skipped = 0; }
      hunk.lines.push({ t: op.t, text: op.text, o: null, n: null });
    });
    return hunks;
  }
  function fromStrings(path, oldText, newText, { replaceAll = false } = {}) {
    const file = newFile(path, "edit", { replaceAll: replaceAll === true });
    const a = oldText === "" ? [] : splitLines(oldText), b = newText === "" ? [] : splitLines(newText);
    file.hunks = hunksOf(lineOps(a, b));
    if (clipped(oldText) || clipped(newText)) file.complete = false;
    return count(file);
  }

  // --- V4A patches (`patch` with mode "patch": *** Begin Patch / *** Update|Add|Delete File: p / *** Move File: a -> b)
  const V4A_OPS = [
    ["edit", /^\*\*\*\s*Update\s+File:\s*(.+)$/], ["add", /^\*\*\*\s*Add\s+File:\s*(.+)$/],
    ["delete", /^\*\*\*\s*Delete\s+File:\s*(.+)$/], ["move", /^\*\*\*\s*Move\s+File:\s*(.+?)\s*->\s*(.+)$/],
  ];
  function parseV4A(text) {
    if (typeof text !== "string" || !text) return [];
    const lines = text.split("\n").map(line => line.replace(/\r$/, ""));
    let start = -1, end = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (/^\*\*\*\s*Begin\s+Patch\s*$/.test(lines[i])) start = i;
      else if (/^\*\*\*\s*End\s+Patch\s*$/.test(lines[i])) { end = i; break; }
    }
    const files = [];
    let file = null, hunk = null;
    const open = (label = "") => { hunk = { oldStart: null, newStart: null, label, lines: [] }; file.hunks.push(hunk); };
    for (const line of lines.slice(start + 1, end)) {
      const op = V4A_OPS.map(([kind, rx]) => [kind, rx.exec(line)]).find(([, m]) => m);
      if (op) {
        const [kind, m] = op;
        file = kind === "move" ? newFile(m[2].trim(), "move", { from: m[1].trim() }) : newFile(m[1].trim(), kind, { numbered: kind === "add" });
        files.push(file); hunk = null;
        if (kind === "delete" || kind === "move") file = null;
        continue;
      }
      const moveTo = /^\*\*\*\s*Move\s+to:\s*(.+)$/.exec(line);
      if (moveTo && file && file.op === "edit") { file.from = file.path; file.path = moveTo[1].trim(); file.op = "move"; continue; }
      if (!file) continue;
      if (line.startsWith("@@")) { open(/^@@\s*(.+?)\s*@@/.exec(line)?.[1] || line.slice(2).trim()); continue; }
      if (!line || line[0] === "\\") continue;
      if (!hunk) open();
      const c = line[0];
      if (file.op === "add") hunk.lines.push({ t: "add", text: c === "+" ? line.slice(1) : line, o: null, n: null });
      else if (c === "+") hunk.lines.push({ t: "add", text: line.slice(1), o: null, n: null });
      else if (c === "-") hunk.lines.push({ t: "del", text: line.slice(1), o: null, n: null });
      else hunk.lines.push({ t: "ctx", text: c === " " ? line.slice(1) : line, o: null, n: null });
    }
    for (const f of files) if (f.op === "add") { let n = 1; for (const hk of f.hunks) for (const l of hk.lines) l.n = n++; }
    if (end === lines.length && start >= 0 && files.length) files[files.length - 1].complete = false; // no End Patch: cut
    if (clipped(text) && files.length) files[files.length - 1].complete = false;
    return files.map(count);
  }

  // --- write_file: the whole content as added lines, numbered from 1 (new file or overwrite is not known)
  function fromWrite(path, content) {
    const file = newFile(path, "write", { numbered: true });
    const lines = content === "" ? [] : splitLines(content);
    file.hunks = lines.length ? [{ oldStart: null, newStart: 1, label: "", lines: lines.map((text, i) => ({ t: "add", text, o: null, n: i + 1 })) }] : [];
    if (clipped(content)) file.complete = false;
    return count(file);
  }

  // --- one tool call -> { kind, files, source, error, lint, summary }
  const toolKind = tool => /(^|[.:_])write_file$/.test(tool) ? "write" : /(^|[.:_])patch$/.test(tool) ? "patch" : null;
  const textOf = value => typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  /**
   * The diff model of a `patch`/`write_file` call, from its (ideally full) arguments and result. A complete unified
   * diff in the result wins (it carries real line numbers); otherwise the arguments are diffed here. Returns null for
   * other tools; `files` is empty when the arguments cannot be read (e.g. a clipped preview).
   */
  function fromCall(call) {
    const kind = toolKind(String(call?.tool || call?.name || ""));
    if (!kind) return null;
    const args = object(call.args), result = object(call.result);
    const lint = result.lint && typeof result.lint === "object" && result.lint.status === "error"
      ? (textOf(result.lint.output).trim() || textOf(result.lint.message).trim() || "error") : null;
    const error = result.success === false || result.error ? (textOf(result.error).trim() || "error") : null;
    const path = [args.path, args.file_path, result.resolved_path, Array.isArray(result.files_modified) ? result.files_modified[0] : null]
      .find(value => typeof value === "string" && value) || "";
    const model = { kind, files: [], source: null, error, lint, summary: null };
    if (kind === "write") {
      if (typeof args.content === "string") { model.files = [fromWrite(path, args.content)]; model.source = "write"; }
      if (typeof result.bytes_written === "number") model.summary = { bytes: result.bytes_written, verified: result.verified === true, dirs: Array.isArray(result.dirs_created) ? result.dirs_created.length : result.dirs_created ? 1 : 0 };
      return model;
    }
    const diff = typeof result.diff === "string" ? parseUnified(result.diff) : [];
    if (diff.length && diff.every(f => f.complete && f.hunks.length)) { model.files = diff; model.source = "diff"; }
    else if (typeof args.patch === "string" && (args.mode === "patch" || /\*\*\*\s*(Begin\s+Patch|Update\s+File:|Add\s+File:)/.test(args.patch))) {
      model.files = parseV4A(args.patch); model.source = "v4a";
    } else if (typeof args.old_string === "string" && typeof args.new_string === "string") {
      model.files = [fromStrings(path, args.old_string, args.new_string, { replaceAll: args.replace_all })]; model.source = "strings";
    } else if (diff.length) { model.files = diff; model.source = "diff"; }
    if (model.source === "diff" && path) for (const f of model.files) if (!f.path) f.path = path;
    if (!error && result.success === true) model.summary = { applied: true, files: Array.isArray(result.files_modified) ? result.files_modified.length : model.files.length };
    return model;
  }
  /** True when `a` and `b` name the same file, allowing one to be the relative tail of the other. */
  function samePath(a, b) {
    if (!a || !b) return false;
    const x = String(a).replace(/\\/g, "/"), y = String(b).replace(/\\/g, "/");
    return x === y || x.endsWith("/" + y.replace(/^\.\//, "")) || y.endsWith("/" + x.replace(/^\.\//, ""));
  }
  /** A short path for a header: the last three segments (the full path goes in a tooltip). */
  function shortPath(path) {
    const parts = String(path || "").split(/[\\/]/).filter(Boolean);
    return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : String(path || "");
  }
  function size(bytes) {
    if (!(bytes >= 0)) return "";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let v = bytes / 1024, u = 0;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
  }

  // --- renderer: per file a header (op, short path, +N −M) and its hunks; a gutter with old/new numbers when known
  const OPS = ["edit", "write", "add", "delete", "move"];
  /**
   * `opts`: `t` (i18n), `key` (state prefix), `isFull(key)` / `showAll(key)` for the per-file line cap, `max` (lines),
   * `only(path)` to keep some files of a multi-file call. Returns null when the model has no files.
   */
  function render(h, model, opts = {}) {
    const t = opts.t || (k => k), max = opts.max || MAX_LINES;
    const files = (model?.files || []).filter(f => !opts.only || opts.only(f.path));
    if (!files.length) return null;
    return h("div", { class: "dv" }, files.map((file, index) => renderFile(h, t, file, `${opts.key || "dv"}:${index}`, max, opts)),
      model.lint ? h("p", { class: "dv-lint" }, h("b", null, t("diff.lint")), " ", model.lint) : null);
  }
  function renderFile(h, t, file, key, max, opts) {
    const total = file.hunks.reduce((n, hk) => n + hk.lines.length, 0);
    const all = total <= max || !!opts.isFull?.(key);
    const numbered = file.numbered && file.hunks.some(hk => hk.lines.some(l => l.o !== null || l.n !== null));
    const rows = [];
    let shown = 0;
    for (const [i, hunk] of file.hunks.entries()) {
      if (!all && shown >= max) break;
      const sep = hunkLabel(hunk, t);
      if (i > 0 || hunk.label || hunk.skipped || hunk.oldStart != null) rows.push(h("div", { class: "dv-sep" }, numbered ? [h("span", { class: "dv-ln" }), h("span", { class: "dv-ln" })] : null, h("span", { class: "dv-sign" }), h("span", { class: "dv-text" }, sep)));
      for (const line of hunk.lines) {
        if (!all && shown >= max) break;
        shown++;
        const sign = line.t === "add" ? "+" : line.t === "del" ? "−" : line.t === "note" ? "\\" : " ";
        rows.push(h("div", { class: `dv-line ${line.t}` },
          numbered ? [h("span", { class: "dv-ln" }, line.o === null ? "" : String(line.o)), h("span", { class: "dv-ln" }, line.n === null ? "" : String(line.n))] : null,
          h("span", { class: "dv-sign", "aria-hidden": "true" }, sign), h("span", { class: "dv-text" }, line.text)));
      }
    }
    const op = OPS.includes(file.op) ? file.op : "edit";
    return h("section", { class: `dv-file ${op}`, "data-path": file.path },
      h("header", { class: "dv-head" }, h("span", { class: "dv-op" }, t(`diff.op.${op}`)),
        h("code", { class: "dv-path", title: file.from ? `${file.from} → ${file.path}` : file.path }, file.from ? `${shortPath(file.from)} → ${shortPath(file.path)}` : shortPath(file.path) || "—"),
        file.replaceAll ? h("small", { class: "dv-tag" }, t("diff.allMatches")) : null,
        h("span", { class: "dv-count" }, file.added ? h("span", { class: "dv-add" }, `+${file.added}`) : null, file.removed ? h("span", { class: "dv-del" }, `−${file.removed}`) : null)),
      rows.length ? h("div", { class: "dv-scroll", "data-keep": `${key}:scroll` }, h("div", { class: `dv-body${numbered ? " numbered" : ""}` }, rows))
        : h("p", { class: "dv-note" }, t(op === "delete" ? "diff.deleted" : op === "move" ? "diff.moved" : "diff.noLines")),
      !all ? h("button", { class: "dv-more", type: "button", onclick: () => opts.showAll?.(key) }, t("diff.showAll", { n: total })) : null,
      !file.complete ? h("p", { class: "dv-note" }, t("diff.clipped")) : null);
  }
  function hunkLabel(hunk, t) {
    if (hunk.oldStart !== null && hunk.oldStart !== undefined) {
      const range = (start, n) => n === 1 ? String(start) : `${start},${n}`;
      return `@@ -${range(hunk.oldStart, hunk.oldCount ?? 1)} +${range(hunk.newStart, hunk.newCount ?? 1)} @@${hunk.label ? ` ${hunk.label}` : ""}`;
    }
    if (hunk.skipped) return t("diff.unchanged", { n: hunk.skipped });
    return hunk.label ? `@@ ${hunk.label}` : "⋯";
  }

  const api = { MAX_LINES, parseUnified, fromStrings, parseV4A, fromWrite, fromCall, toolKind, samePath, shortPath, size, render, clipped };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DeckDiff = Object.freeze(api);
})(typeof window === "object" ? window : globalThis);
