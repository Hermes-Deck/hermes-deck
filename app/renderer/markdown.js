"use strict";
var i18nNode = (key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).node(key, vars, typeof document === "object" ? document : null);
var i18nBind = (el, attr, key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).bind(el, attr, key, vars);
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
var i18nLocale = typeof module === "object" && module.exports ? require("./i18n").getLocale : window.DeckI18n.getLocale;
// Markdown -> DOM for agent messages: window.DeckMarkdown.render(text[, {openUrl}]) returns a
// DocumentFragment, and DeckMarkdown.looksLike(text) says whether plain text clearly is markdown
// (fenced code, headings or a table). It only creates elements and text nodes and never parses
// HTML, so message text cannot inject markup: raw HTML stays visible as text (except <br>, which
// becomes a line break, as agents put it in table cells).
//
// Supported: headings, paragraphs with line breaks, bold/italic/bold-italic/strike, inline code,
// fenced code, ordered/unordered/task lists (nested), tables with alignment, blockquotes, rules,
// and http(s) links ([text](url), <url>, bare URLs), opened through deck.openExternal.
//
// The link and table rules follow Hermes Desk's src/core/rich-text.ts (MIT License, Copyright (c)
// 2026 Louis Raillé): links only for http(s) without credentials, images degrade to plain links,
// wide tables scroll inside their own focusable region, task boxes render as ☐/☑.
(() => {
  const MAX_DEPTH = 8;
  const MAX_LEN = 60000;

  const el = (tag, cls) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  };
  const txt = (s) => document.createTextNode(s);

  /** http(s) only, no credentials, no whitespace or control characters. */
  function webUrl(value) {
    const v = String(value || "").trim();
    if (!v || /[\u0000- \u007f]/.test(v)) return null;
    try {
      const u = new URL(v);
      return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password ? u.href : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ blocks
  const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
  const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/;
  const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
  const UL = /^( *)([-*+])[ \t]+(.*)$/;
  const OL = /^( *)(\d{1,9})([.)])[ \t]+(.*)$/;
  const BLANK = /^[ \t]*$/;
  const SEP_CELL = /^:?-+:?$/;
  const indentOf = (l) => /^ */.exec(l)[0].length;

  function fenceAt(line) {
    const m = FENCE.exec(line);
    if (!m || (m[2][0] === "`" && m[3].includes("`"))) return null;
    return { indent: m[1].length, ch: m[2][0], n: m[2].length, lang: m[3].trim().split(/\s+/)[0] || "" };
  }

  function cells(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    const out = [];
    let cur = "";
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "\\" && s[i + 1] === "|") {
        cur += "|";
        i++;
      } else if (s[i] === "|") {
        out.push(cur.trim());
        cur = "";
      } else cur += s[i];
    }
    out.push(cur.trim());
    return out;
  }

  /** A GFM table starting at line i: header row, delimiter row with the same cell count, body rows. */
  function tableAt(lines, i) {
    const head = lines[i];
    const sep = lines[i + 1];
    if (sep === undefined || !head.includes("|") || !/^[ \t|:-]+$/.test(sep) || !sep.includes("-")) return null;
    const hc = cells(head);
    const sc = cells(sep);
    if (hc.length !== sc.length || !sc.every((c) => SEP_CELL.test(c)) || (hc.length === 1 && !sep.includes("|"))) return null;
    const align = sc.map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
    const rows = [];
    let j = i + 2;
    while (j < lines.length && !BLANK.test(lines[j]) && lines[j].includes("|")) rows.push(cells(lines[j++]));
    return { head: hc, align, rows, next: j };
  }

  function itemAt(line) {
    let m = UL.exec(line);
    if (m && !HR.test(line)) return { indent: m[1].length, ordered: false, mark: m[2], start: 1, text: m[3], col: line.length - m[3].length };
    m = OL.exec(line);
    if (m) return { indent: m[1].length, ordered: true, mark: m[3], start: Number(m[2]), text: m[4], col: line.length - m[4].length };
    return null;
  }

  /** Lines that end a paragraph (a list interrupts only when it has content; an ordered one only from 1). */
  function startsBlock(lines, i) {
    const l = lines[i];
    if (fenceAt(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || tableAt(lines, i)) return true;
    const it = itemAt(l);
    return !!(it && it.text.trim() && (!it.ordered || it.start === 1));
  }

  function blocks(lines, parent, depth) {
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (BLANK.test(line)) {
        i++;
        continue;
      }
      if (depth > MAX_DEPTH) {
        const p = el("p");
        p.appendChild(txt(lines.slice(i).join("\n")));
        parent.appendChild(p);
        return;
      }
      const f = fenceAt(line);
      if (f) {
        i = fence(lines, i, f, parent);
        continue;
      }
      let m = HEADING.exec(line);
      if (m) {
        const hd = el(`h${m[1].length}`);
        inline(m[2].replace(/[ \t]+#+$/, ""), hd, depth, false);
        parent.appendChild(hd);
        i++;
        continue;
      }
      if (HR.test(line)) {
        parent.appendChild(el("hr"));
        i++;
        continue;
      }
      if (QUOTE.test(line)) {
        const inner = [];
        while (i < lines.length && (m = QUOTE.exec(lines[i]))) {
          inner.push(m[1]);
          i++;
        }
        const bq = el("blockquote");
        blocks(inner, bq, depth + 1);
        parent.appendChild(bq);
        continue;
      }
      const t = tableAt(lines, i);
      if (t) {
        parent.appendChild(table(t, depth));
        i = t.next;
        continue;
      }
      if (itemAt(line)) {
        i = list(lines, i, parent, depth);
        continue;
      }
      const para = [line.trim()];
      i++;
      while (i < lines.length && !BLANK.test(lines[i]) && !startsBlock(lines, i)) para.push(lines[i++].trim());
      const p = el("p");
      inline(para.join("\n"), p, depth, false);
      parent.appendChild(p);
    }
  }

  function fence(lines, i, f, parent) {
    const close = new RegExp(`^ {0,3}${f.ch === "`" ? "`" : "~"}{${f.n},}[ \\t]*$`);
    const body = [];
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) {
      const l = lines[j++];
      body.push(l.slice(Math.min(f.indent, indentOf(l))));
    }
    const pre = el("pre");
    pre.tabIndex = 0; // wide code scrolls; keyboard users can reach it
    const code = el("code");
    if (f.lang) code.dataset.lang = f.lang.slice(0, 24);
    code.textContent = body.join("\n");
    pre.appendChild(code);
    parent.appendChild(pre);
    return j < lines.length ? j + 1 : j;
  }

  function list(lines, i, parent, depth) {
    const first = itemAt(lines[i]);
    const node = el(first.ordered ? "ol" : "ul");
    if (first.ordered && first.start !== 1) node.setAttribute("start", String(first.start));
    const sibling = (it) => it && it.ordered === first.ordered && it.mark === first.mark && it.indent < first.col;
    let loose = false;
    let j = i;
    while (j < lines.length) {
      const it = itemAt(lines[j]);
      if (!sibling(it)) break;
      const body = [it.text];
      j++;
      while (j < lines.length) {
        const l = lines[j];
        if (BLANK.test(l)) {
          let k = j + 1;
          while (k < lines.length && BLANK.test(lines[k])) k++;
          if (k < lines.length && indentOf(lines[k]) >= it.col) {
            body.push("");
            loose = true;
            j++;
            continue;
          }
          break;
        }
        if (indentOf(l) >= it.col) {
          body.push(l.slice(it.col));
          j++;
          continue;
        }
        if (itemAt(l) || startsBlock(lines, j)) break;
        body.push(l.trim()); // lazy continuation of the item's paragraph
        j++;
      }
      node.appendChild(listItem(body, depth));
      let k = j;
      while (k < lines.length && BLANK.test(lines[k])) k++;
      if (k > j && k < lines.length && sibling(itemAt(lines[k]))) {
        loose = true;
        j = k;
      }
    }
    if (!loose) {
      node.classList.add("tight");
      for (const li of node.children) for (const p of [...li.children]) if (p.tagName === "P") p.replaceWith(...p.childNodes);
    }
    parent.appendChild(node);
    return j;
  }

  function listItem(body, depth) {
    const li = el("li");
    const task = /^\[([ xX])\](?:[ \t]+|$)/.exec(body[0]);
    if (task) body[0] = body[0].slice(task[0].length);
    blocks(body, li, depth + 1);
    if (task) {
      li.classList.add("task");
      const tick = el("span", "tick");
      tick.textContent = task[1] === " " ? "☐" : "☑";
      tick.setAttribute("aria-label", task[1] === " " ? i18nText("U0821") : i18nText("U0822"));
      const firstP = li.firstElementChild && li.firstElementChild.tagName === "P" ? li.firstElementChild : null;
      (firstP || li).prepend(tick);
    }
    return li;
  }

  function table(t, depth) {
    const wrap = el("div", "md-table");
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    i18nBind(wrap, "aria-label", "A0356");
    const tb = el("table");
    const thead = el("thead");
    const hr = el("tr");
    t.head.forEach((c, k) => {
      const th = el("th");
      if (t.align[k]) th.dataset.align = t.align[k];
      inline(c, th, depth + 1, false);
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    tb.appendChild(thead);
    if (t.rows.length) {
      const tbody = el("tbody");
      for (const r of t.rows) {
        const tr = el("tr");
        for (let k = 0; k < t.head.length; k++) {
          const td = el("td");
          if (t.align[k]) td.dataset.align = t.align[k];
          inline(r[k] || "", td, depth + 1, false);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      tb.appendChild(tbody);
    }
    wrap.appendChild(tb);
    return wrap;
  }

  // ------------------------------------------------------------------ inline
  const PUNCT = /[!-/:-@[-`{-~]/;
  const WORD = /[\p{L}\p{N}]/u;
  const runOf = (s, i, ch) => {
    let j = i;
    while (s[j] === ch) j++;
    return j - i;
  };
  /** Start index of the next run of exactly n characters ch at or after `from`, or -1. */
  function findRun(s, from, ch, n) {
    let j = s.indexOf(ch, from);
    while (j >= 0) {
      const r = runOf(s, j, ch);
      if (r === n) return j;
      j = s.indexOf(ch, j + r);
    }
    return -1;
  }

  /** Emphasis pair starting at i with delimiter d (*, **, ***, _, __, ~~): {from, to, end} or null. */
  function pair(s, i, d) {
    const L = d.length;
    const from = i + L;
    if (from >= s.length || /\s/.test(s[from])) return null;
    if (d[0] === "_" && i > 0 && WORD.test(s[i - 1])) return null; // snake_case stays text
    let j = from;
    while (j < s.length) {
      const ch = s[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "`") {
        const run = runOf(s, j, "`");
        const end = findRun(s, j + run, "`", run);
        j = end >= 0 ? end + run : j + run;
        continue;
      }
      if (ch === d[0]) {
        // a longer closing run also closes nested emphasis inside ("**a *b***"): this pair takes its last L
        const run = runOf(s, j, ch);
        const fits = L === 1 ? run === 1 || run === 3 : run >= L;
        const intra = d[0] === "_" && j + run < s.length && WORD.test(s[j + run]);
        if (fits && j > from && !/\s/.test(s[j - 1]) && !intra) return { from, to: j + run - L, end: j + run };
        j += run;
        continue;
      }
      j++;
    }
    return null;
  }

  function emphasis(s, i) {
    const c = s[i];
    const run = runOf(s, i, c);
    if (c === "~") {
      const r = run === 2 ? pair(s, i, "~~") : null;
      return r && { ...r, tags: ["del"] };
    }
    if (run >= 3) {
      const r = pair(s, i, c.repeat(3));
      if (r) return { ...r, tags: ["strong", "em"] };
    }
    if (run >= 2) {
      const r = pair(s, i, c + c);
      if (r) return { ...r, tags: ["strong"] };
    }
    if (run === 1) {
      const r = pair(s, i, c);
      if (r) return { ...r, tags: ["em"] };
    }
    return null;
  }

  function linkAt(s, i) {
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (ch === "\\") {
        j++;
        continue;
      }
      if (ch === "`") {
        const run = runOf(s, j, "`");
        const end = findRun(s, j + run, "`", run);
        if (end >= 0) {
          j = end + run - 1;
          continue;
        }
      }
      if (ch === "[") depth++;
      else if (ch === "]" && --depth === 0) break;
    }
    if (j >= s.length || s[j + 1] !== "(") return null;
    const label = s.slice(i + 1, j);
    let k = j + 2;
    while (s[k] === " ") k++;
    let url;
    if (s[k] === "<") {
      const e = s.indexOf(">", k);
      if (e < 0) return null;
      url = s.slice(k + 1, e);
      k = e + 1;
    } else {
      const st = k;
      let par = 0;
      for (; k < s.length; k++) {
        const ch = s[k];
        if (ch === "\\") {
          k++;
          continue;
        }
        if (/\s/.test(ch)) break;
        if (ch === "(") par++;
        else if (ch === ")") {
          if (!par) break;
          par--;
        }
      }
      url = s.slice(st, k);
    }
    while (s[k] === " ") k++;
    if (s[k] === '"' || s[k] === "'") {
      const e = s.indexOf(s[k], k + 1);
      if (e < 0) return null;
      k = e + 1;
      while (s[k] === " ") k++;
    }
    if (s[k] !== ")") return null;
    return { label, url: url.replace(/\\([!-/:-@[-`{-~])/g, "$1"), end: k + 1 };
  }

  function trimTail(u) {
    let s = u;
    for (;;) {
      const last = s[s.length - 1];
      if (/[.,:;!?'"*_~]/.test(last)) s = s.slice(0, -1);
      else if (last === ")" && (s.match(/\(/g) || []).length < (s.match(/\)/g) || []).length) s = s.slice(0, -1);
      else return s;
    }
  }

  let opener = null; // the openUrl of the render() call in progress, captured by each link it creates

  function link(parent, url, label, depth, plain) {
    const href = webUrl(url);
    if (!href) {
      if (plain) parent.appendChild(txt(label));
      else inline(label, parent, depth + 1, true);
      return;
    }
    const a = el("a", "md-a");
    a.href = href;
    a.dataset.url = href;
    a.title = href;
    a.rel = "noreferrer";
    if (plain) a.textContent = label;
    else inline(label, a, depth + 1, true);
    if (!a.textContent.trim()) a.textContent = href;
    const open = opener || ((u) => window.deck && window.deck.openExternal(u));
    a.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation(); // the chat's own link handler must not open it a second time
      open(href);
    });
    parent.appendChild(a);
  }

  function inline(src, parent, depth, noLinks) {
    let buf = "";
    const flush = () => {
      if (buf) parent.appendChild(txt(buf));
      buf = "";
    };
    const n = src.length;
    let i = 0;
    while (i < n) {
      const c = src[i];
      if (c === "\\" && i + 1 < n && PUNCT.test(src[i + 1])) {
        buf += src[i + 1];
        i += 2;
        continue;
      }
      if (c === "\n") {
        flush();
        parent.appendChild(el("br"));
        i++;
        continue;
      }
      if (c === "`") {
        const run = runOf(src, i, "`");
        const end = findRun(src, i + run, "`", run);
        if (end >= 0) {
          flush();
          let s = src.slice(i + run, end).replace(/\n/g, " ");
          if (s.length > 2 && s[0] === " " && s[s.length - 1] === " " && s.trim()) s = s.slice(1, -1);
          const code = el("code");
          code.textContent = s;
          parent.appendChild(code);
          i = end + run;
          continue;
        }
        buf += src.slice(i, i + run);
        i += run;
        continue;
      }
      if (c === "<") {
        const br = /^<br\s*\/?>/i.exec(src.slice(i, i + 7));
        if (br) {
          flush();
          parent.appendChild(el("br"));
          i += br[0].length;
          continue;
        }
        const auto = noLinks ? null : /^<(https?:\/\/[^\s<>]+)>/i.exec(src.slice(i, i + 2100));
        if (auto) {
          flush();
          link(parent, auto[1], auto[1], depth, true);
          i += auto[0].length;
          continue;
        }
      }
      if (!noLinks && (c === "[" || (c === "!" && src[i + 1] === "["))) {
        const img = c === "!";
        const r = linkAt(src, img ? i + 1 : i);
        if (r) {
          flush();
          // images never load: they become a link with their alt text
          link(parent, r.url, img ? r.label || r.url : r.label, depth, img);
          i = r.end;
          continue;
        }
      }
      if (!noLinks && (c === "h" || c === "H") && (i === 0 || !/[\w@/.:-]/.test(src[i - 1])) && /^https?:\/\/[^\s<]/i.test(src.slice(i, i + 9))) {
        const u = trimTail(/^https?:\/\/[^\s<]+/i.exec(src.slice(i, i + 2100))[0]);
        flush();
        link(parent, u, u, depth, true);
        i += u.length;
        continue;
      }
      if (c === "*" || c === "_" || c === "~") {
        const r = depth <= MAX_DEPTH ? emphasis(src, i) : null;
        if (r) {
          flush();
          let inner = parent;
          for (const tag of r.tags) inner = inner.appendChild(el(tag));
          inline(src.slice(r.from, r.to), inner, depth + 1, noLinks);
          i = r.end;
          continue;
        }
        const run = runOf(src, i, c); // delimiters that open nothing stay text
        buf += src.slice(i, i + run);
        i += run;
        continue;
      }
      buf += c;
      i++;
    }
    flush();
  }

  // ------------------------------------------------------------------ api
  function render(text, opts = {}) {
    const frag = document.createDocumentFragment();
    const src = String(text === null || text === undefined ? "" : text).replace(/\r\n?/g, "\n");
    if (src.length > MAX_LEN) {
      frag.appendChild(txt(src));
      return frag;
    }
    const prev = opener;
    opener = typeof opts.openUrl === "function" ? opts.openUrl : null;
    try {
      blocks(src.split("\n"), frag, 0);
    } finally {
      opener = prev;
    }
    return frag;
  }

  /** Plain text that clearly is markdown: a fenced code block, an ATX heading or a table. */
  function looksLike(text) {
    const s = String(text || "").replace(/\r\n?/g, "\n");
    if (s.length < 4 || s.length > MAX_LEN) return false;
    if (/^ {0,3}(```|~~~)/m.test(s) || /^ {0,3}#{1,6}[ \t]+\S/m.test(s)) return true;
    const lines = s.split("\n");
    for (let i = 0; i + 1 < lines.length; i++) if (lines[i].includes("|") && tableAt(lines, i)) return true;
    return false;
  }

  window.DeckMarkdown = Object.freeze({ render, looksLike });
})();
